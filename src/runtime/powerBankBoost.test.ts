import { ensureCreepAssignmentState } from "@/runtime/creepAssignmentState";
import {
  prepareBoosts,
  releaseBoostLabs,
  findBestDonorRoom,
} from "@/runtime/powerBankBoost";
import {
  getActivePowerBankBoostLabIds,
  ensurePowerBankBoostPrepStore,
} from "@/runtime/powerBankBoostMemory";
import { isSynthesisPaused } from "@/runtime/synthesisControl";
import {
  createAutomaticResourceTransferTask,
  ensureResourceTransferTaskStore,
} from "@/runtime/logistics/resourceTransferTasks";
import { createMockStore, MockPos } from "@mock/powerBank";
import { clearCarrierTaskBoardForTest, listCarrierTasksByRoom, replaceCarrierTasksForProducerRoom } from "@/runtime/carrierTaskBoard";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createLabWithCompound(
  id: string,
  roomName: string,
  compound: ResourceConstant | null,
  amount: number,
  energy = 0,
): StructureLab {
  const storeResources: Record<string, number> = { [RESOURCE_ENERGY]: energy };
  if (compound && amount > 0) {
    storeResources[compound] = amount;
  }
  return {
    id: id as Id<StructureLab>,
    pos: new MockPos(20, 20, roomName) as unknown as RoomPosition,
    room: { name: roomName } as Room,
    structureType: STRUCTURE_LAB as StructureConstant,
    mineralType: compound as MineralConstant | null,
    mineralAmount: amount,
    cooldown: 0,
    store: createMockStore(storeResources),
    boostCreep: jest.fn(() => OK),
    runReaction: jest.fn(() => OK),
  } as unknown as StructureLab;
}

function createRoomWithInfrastructure(options: {
  name: string;
  storageResources?: Record<string, number>;
  terminalResources?: Record<string, number>;
  labs?: StructureLab[];
  terminalCooldown?: number;
}): Room {
  const roomName = options.name;
  const storageResources = options.storageResources ?? {};
  const terminalResources = options.terminalResources ?? {};

  const storage = {
    id: `${roomName}-storage` as Id<StructureStorage>,
    structureType: STRUCTURE_STORAGE,
    store: createMockStore(storageResources, 1_000_000),
    pos: new MockPos(25, 25, roomName) as unknown as RoomPosition,
  } as unknown as StructureStorage;

  const terminal = {
    id: `${roomName}-terminal` as Id<StructureTerminal>,
    structureType: STRUCTURE_TERMINAL,
    store: createMockStore(terminalResources, 300_000),
    pos: new MockPos(26, 26, roomName) as unknown as RoomPosition,
    cooldown: options.terminalCooldown ?? 0,
  } as unknown as StructureTerminal;

  const labs = options.labs ?? [
    createLabWithCompound(`${roomName}-lab-1`, roomName, null, 0),
    createLabWithCompound(`${roomName}-lab-2`, roomName, null, 0),
    createLabWithCompound(`${roomName}-lab-3`, roomName, null, 0),
  ];

  const room = {
    name: roomName,
    controller: { my: true, level: 8 } as StructureController,
    storage,
    terminal,
    find: jest.fn((type: FindConstant, opts?: { filter?: (s: Structure) => boolean }) => {
      if (type === FIND_MY_STRUCTURES) {
        const all = [...labs];
        return opts?.filter ? all.filter((s) => opts.filter?.(s as Structure)) : all;
      }
      return [];
    }),
  } as unknown as Room;

  return room;
}

const SOURCE_ROOM = "W1N1";
const DONOR_ROOM = "W3N3";

function setActiveSynthesisPlan(roomName: string): void {
  Memory.runtime = {
    synthesisControl: {
      updatedAt: Game.time,
      generatedTaskCount: 0,
      failedTaskCount: 0,
      successfulRunCount: 0,
      lastActions: [],
      bindings: {},
      rooms: {
        [roomName]: {
          stage: "synthesizing",
          activeProduct: RESOURCE_UTRIUM_HYDRIDE,
          reagentA: RESOURCE_UTRIUM,
          reagentB: RESOURCE_HYDROGEN,
          targetAmount: 5_000,
          batchSize: 500,
          reagentLabIds: [],
          productLabIds: [],
          successfulRuns: 10,
          pendingTasks: 0,
          lastTransitionAt: Game.time - 10,
        },
      },
    },
  } as NonNullable<Memory["runtime"]>;
}

describe("powerBankBoost", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCarrierTaskBoardForTest();
    Game.time = 100;
    Memory.cfg = {
      synthesisControl: {
        enabled: true,
        sampleInterval: 10,
        rooms: {},
      },
    };
    Memory.runtime = undefined;
    Memory.data = undefined;
    Memory.rooms = {};
    Game.rooms = {};
    Game.spawns = {};
    Game.creeps = {};
    (Game as any).getObjectById = jest.fn();
    (Game as any).market = {
      calcTransactionCost: () => 0,
    };
  });

  describe("prepareBoosts", () => {

    it("HUB低于20k不制造虚假供货，改选具有真实可动库存的房间", () => {
      const resource = RESOURCE_CATALYZED_GHODIUM_ALKALIDE;
      const hub = createRoomWithInfrastructure({ name: "W5N5", terminalResources: { [resource]: 12_000 } });
      const donor = createRoomWithInfrastructure({ name: DONOR_ROOM, storageResources: { [resource]: 6_000 } });
      Game.rooms = { [hub.name]: hub, [donor.name]: donor };
      Memory.cfg!.hub = { enabled: true, hubRoomName: hub.name };
      expect(findBestDonorRoom(resource, 900, [SOURCE_ROOM])).toBe(donor.name);
      createAutomaticResourceTransferTask(donor.name, SOURCE_ROOM, resource, 1_000, "powerBankBoost:reserved");
      expect(findBestDonorRoom(resource, 900, [SOURCE_ROOM])).toBeNull();
    });

    it("库存刚好够时，已取货在途不会导致准备失败", () => {
      const compound = RESOURCE_CATALYZED_UTRIUM_ACID;
      const lab = createLabWithCompound("in-flight-lab", SOURCE_ROOM, null, 0, 2000);
      const room = createRoomWithInfrastructure({ name: SOURCE_ROOM, labs: [lab], storageResources: { [compound]: 900 } });
      Game.rooms[SOURCE_ROOM] = room;
      expect(prepareBoosts("in-flight", SOURCE_ROOM, 0, new Map([[compound, 900]])).status).toBe("preparing");
      Game.time++;
      room.storage!.store = createMockStore({ [compound]: 400 });
      const creep = { name: "boost-carrier", store: createMockStore({ [compound]: 500 }) } as Creep;
      Game.creeps = { [creep.name]: creep };
      Object.assign(ensureCreepAssignmentState(creep.name), { synthesisCarrierPendingToId: lab.id, synthesisCarrierPendingResource: compound });
      expect(prepareBoosts("in-flight", SOURCE_ROOM, 0, new Map([[compound, 900]])).status).toBe("preparing");
      const supply = listCarrierTasksByRoom(SOURCE_ROOM).flatMap(task => task.steps).filter(step => step.resource === compound);
      expect(supply.reduce((sum, step) => sum + step.amount, 0)).toBe(400);
    });
    it("Storage 和 Terminal 的合计库存足够时无需外房供体", () => {
      const compound = RESOURCE_CATALYZED_UTRIUM_ACID;
      Game.rooms[SOURCE_ROOM] = createRoomWithInfrastructure({ name: SOURCE_ROOM,
        labs: [createLabWithCompound("split-lab", SOURCE_ROOM, null, 0, 2000)],
        storageResources: { [compound]: 500 }, terminalResources: { [compound]: 400 } });
      expect(prepareBoosts("split-stock", SOURCE_ROOM, 0, new Map([[compound, 900]])).status).toBe("preparing");
      expect(Object.values(ensureResourceTransferTaskStore())).toHaveLength(0);
    });
    it("重复失败不清空合成任务也不重置合成阶段", () => {
      const compound = RESOURCE_CATALYZED_UTRIUM_ACID;
      const lab = createLabWithCompound("empty-boost-lab", SOURCE_ROOM, null, 0, 2000);
      Game.rooms[SOURCE_ROOM] = createRoomWithInfrastructure({ name: SOURCE_ROOM, labs: [lab] });
      setActiveSynthesisPlan(SOURCE_ROOM);
      replaceCarrierTasksForProducerRoom("synthesisControl", SOURCE_ROOM, [{
        id: "synthesis-still-running", type: "lab_cleanup", priority: 200,
        steps: [{ id: "keep", resource: RESOURCE_UTRIUM, fromId: lab.id, fromKind: "lab",
          toId: `${SOURCE_ROOM}-storage`, toKind: "storage", amount: 60 }],
      }]);
      for (let i = 0; i < 3; i++) {
        expect(prepareBoosts("failed-owner", SOURCE_ROOM, 0, new Map([[compound, 60]])).status).toBe("failed");
        expect(isSynthesisPaused(SOURCE_ROOM)).toBe(false);
        expect(Memory.runtime?.synthesisControl?.rooms[SOURCE_ROOM].activeProduct).toBe(RESOURCE_UTRIUM_HYDRIDE);
        expect(listCarrierTasksByRoom(SOURCE_ROOM).map(task => task.id)).toContain("synthesis-still-running");
        Game.time++;
      }
    });

    it("防御专用 lab 不可被出征 Boost 占用", () => {
      const compound = RESOURCE_CATALYZED_UTRIUM_ACID;
      const lab = createLabWithCompound("defense-only", SOURCE_ROOM, compound, 60, 2000);
      Game.rooms[SOURCE_ROOM] = createRoomWithInfrastructure({ name: SOURCE_ROOM, labs: [lab] });
      Memory.cfg!.homeDefense = { rooms: { [SOURCE_ROOM]: { boostLabId: lab.id } } };
      expect(prepareBoosts("war-owner", SOURCE_ROOM, 0, new Map([[compound, 60]]))).toMatchObject({ status: "failed", reason: "insufficient_labs" });
      expect(listCarrierTasksByRoom(SOURCE_ROOM)).toHaveLength(0);
    });

    it("withdraws old synthesis work as soon as boost preparation pauses production", () => {
      const compound = RESOURCE_CATALYZED_UTRIUM_ACID;
      const lab = createLabWithCompound("boost-lab", SOURCE_ROOM, compound, 60, 2000);
      Game.rooms[SOURCE_ROOM] = createRoomWithInfrastructure({ name: SOURCE_ROOM, labs: [lab] });
      (Game.getObjectById as jest.Mock).mockImplementation((id) => id === lab.id ? lab : null);
      setActiveSynthesisPlan(SOURCE_ROOM);
      replaceCarrierTasksForProducerRoom("synthesisControl", SOURCE_ROOM, [{
        id: "old-synthesis-cleanup", type: "lab_cleanup", priority: 200,
        steps: [{ id: "old-step", resource: compound, fromId: lab.id, fromKind: "lab",
          toId: `${SOURCE_ROOM}-storage`, toKind: "storage", amount: 60 }],
      }]);

      expect(prepareBoosts("pb-owner", SOURCE_ROOM, 0, new Map([[compound, 60]])).status).toBe("ready");
      expect(listCarrierTasksByRoom(SOURCE_ROOM).filter((task) => task.producer === "synthesisControl")).toEqual([]);
      expect(isSynthesisPaused(SOURCE_ROOM)).toBe(true);
    });

    it("removes newly conflicting synthesis steps while retaining cleanup of unreserved labs", () => {
      const compound = RESOURCE_CATALYZED_UTRIUM_ACID;
      const lab = createLabWithCompound("boost-lab", SOURCE_ROOM, compound, 60, 2000);
      Game.rooms[SOURCE_ROOM] = createRoomWithInfrastructure({ name: SOURCE_ROOM, labs: [lab] });
      (Game.getObjectById as jest.Mock).mockImplementation((id) => id === lab.id ? lab : null);
      setActiveSynthesisPlan(SOURCE_ROOM);
      const required = new Map<ResourceConstant, number>([[compound, 60]]);
      prepareBoosts("pb-owner", SOURCE_ROOM, 0, required);
      const ordinaryStep = { id: "ordinary-step", resource: RESOURCE_HYDROXIDE,
        fromId: "ordinary-lab", fromKind: "lab" as const,
        toId: `${SOURCE_ROOM}-storage`, toKind: "storage" as const, amount: 50 };
      replaceCarrierTasksForProducerRoom("synthesisControl", SOURCE_ROOM, [{
        id: "paused-cleanup", type: "lab_cleanup", priority: 190,
        steps: [{ id: "conflicting-step", resource: compound, fromId: lab.id, fromKind: "lab",
          toId: `${SOURCE_ROOM}-storage`, toKind: "storage", amount: 60 }, ordinaryStep],
      }]);

      expect(prepareBoosts("pb-owner", SOURCE_ROOM, 0, required).status).toBe("ready");
      expect(listCarrierTasksByRoom(SOURCE_ROOM).find((task) => task.id === "paused-cleanup")?.steps).toEqual([ordinaryStep]);
    });

    describe("with local stock sufficient", () => {

      it("does not count another boost owner's incoming transfer toward this task", () => {
        const compound = RESOURCE_CATALYZED_UTRIUM_ACID;
        const taskIdA = "pb-owner-a";
        const taskIdB = "pb-owner-b";
        const required = new Map<ResourceConstant, number>([[compound, 60]]);
        Game.rooms[SOURCE_ROOM] = createRoomWithInfrastructure({
          name: SOURCE_ROOM,
          labs: [createLabWithCompound(`${SOURCE_ROOM}-lab-1`, SOURCE_ROOM, null, 0)],
        });

        const incomingForTaskA = createAutomaticResourceTransferTask(
          DONOR_ROOM,
          SOURCE_ROOM,
          compound,
          60,
          `powerBankBoost:${taskIdA}`,
        );
        expect(typeof incomingForTaskA).not.toBe("string");

        const result = prepareBoosts(taskIdB, SOURCE_ROOM, 6, required);

        expect(result).toMatchObject({ status: "failed", reason: "insufficient_boost_compound" });
        expect(ensurePowerBankBoostPrepStore()[taskIdB]).toBeUndefined();
        expect(
          Object.values(ensureResourceTransferTaskStore()).find(
            (task) => task.reason === `powerBankBoost:${taskIdA}`,
          )?.status,
        ).toBe("pending");
      });

      it("rolls back only the failed owner while another boost owner remains active", () => {
        const compounds: ResourceConstant[] = [
          RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
          RESOURCE_CATALYZED_UTRIUM_ACID,
          RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
        ];
        const storageResources = Object.fromEntries(compounds.map((compound) => [compound, 5_000]));
        const labsA = compounds.map((_compound, index) =>
          createLabWithCompound(`${SOURCE_ROOM}-lab-a-${index}`, SOURCE_ROOM, null, 0)
        );
        const labsB = compounds.map((_compound, index) =>
          createLabWithCompound(`${SOURCE_ROOM}-lab-b-${index}`, SOURCE_ROOM, null, 0)
        );
        const taskIdA = "pb-owner-a";
        const taskIdB = "pb-owner-b";
        Game.rooms[SOURCE_ROOM] = createRoomWithInfrastructure({
          name: SOURCE_ROOM,
          storageResources,
          labs: [...labsA, ...labsB],
        });
        setActiveSynthesisPlan(SOURCE_ROOM);

        expect(prepareBoosts(taskIdA, SOURCE_ROOM, 6).status).toBe("preparing");
        expect(prepareBoosts(taskIdB, SOURCE_ROOM, 6).status).toBe("preparing");
        expect(listCarrierTasksByRoom(SOURCE_ROOM).some((task) => task.producer === `powerBankBoost:${taskIdA}`)).toBe(true);
        expect(listCarrierTasksByRoom(SOURCE_ROOM).some((task) => task.producer === `powerBankBoost:${taskIdB}`)).toBe(true);

        Game.rooms[SOURCE_ROOM] = createRoomWithInfrastructure({
          name: SOURCE_ROOM,
          storageResources,
          labs: labsA,
        });
        const failed = prepareBoosts(taskIdB, SOURCE_ROOM, 6);

        expect(failed).toMatchObject({ status: "failed", reason: "insufficient_labs" });
        expect(ensurePowerBankBoostPrepStore()[taskIdA]).toBeDefined();
        expect(ensurePowerBankBoostPrepStore()[taskIdB]).toBeUndefined();
        expect(getActivePowerBankBoostLabIds(SOURCE_ROOM)).toEqual(new Set(labsA.map((lab) => lab.id)));
        expect(listCarrierTasksByRoom(SOURCE_ROOM).some((task) => task.producer === `powerBankBoost:${taskIdA}`)).toBe(true);
        expect(listCarrierTasksByRoom(SOURCE_ROOM).some((task) => task.producer === `powerBankBoost:${taskIdB}`)).toBe(false);
        expect(isSynthesisPaused(SOURCE_ROOM)).toBe(true);
        expect(Memory.runtime?.synthesisControl?.rooms[SOURCE_ROOM].boostPause?.taskIds).toEqual([taskIdA]);
        expect(Memory.runtime?.synthesisControl?.rooms[SOURCE_ROOM].activeProduct).toBeUndefined();

        releaseBoostLabs(taskIdA, SOURCE_ROOM);
        expect(isSynthesisPaused(SOURCE_ROOM)).toBe(false);
        expect(Memory.runtime?.synthesisControl?.rooms[SOURCE_ROOM].activeProduct).toBe(RESOURCE_UTRIUM_HYDRIDE);
      });
    });
  });
});
