import { mountCreep } from "@/mount/mountCreep";
import { clearCarrierTaskBoardForTest, replaceCarrierTasksForProducerRoom } from "@/runtime/carrierTaskBoard";
import { clearCreepAssignmentStateForTest, ensureCreepAssignmentState } from "@/runtime/creepAssignmentState";
import { getCreepConfigService } from "@/runtime/runtimeServices";
import { createMockPowerBankCreep, MockPos } from "@mock/powerBank";

jest.mock("@/roles/shared", () => ({
  clearMovementState: jest.fn(),
  moveToTarget: jest.fn(),
  moveToTargetRoom: jest.fn(),
}));

jest.mock("@/roles/energyTargets", () => ({
  getEnergyStoreTarget: jest.fn(() => null),
  isDroppedResourceTarget: jest.fn(() => false),
}));

jest.mock("@/runtime/energyPickupReservation", () => ({
  getPickupTargetEnergyAmount: jest.fn(() => 0),
  getReservedPickupTarget: jest.fn(() => null),
  releasePickupReservation: jest.fn(),
  reservePickupTarget: jest.fn(() => false),
}));

jest.mock("@/runtime/roomPlannerConstruction", () => ({
  getPlannedStoragePos: jest.fn(() => null),
  getPlannedControllerLinkPos: jest.fn(() => null),
  getProtoStorageContainer: jest.fn(() => null),
  getProtoControllerLinkContainer: jest.fn(() => null),
}));

jest.mock("@/runtime/crossShardNaming", () => ({
  decodeCrossShardTravelerName: jest.fn(() => null),
}));

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
  Creep: typeof Creep;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function installCreepPrototype(): void {
  class CreepMock {}
  (global as RuntimeGlobal).Creep = CreepMock as unknown as typeof Creep;
}

function createRoom(name = "W1N1", options: { storage?: StructureStorage | null; terminal?: StructureTerminal | null } = {}): Room {
  const room = {
    name,
    controller: { my: true, level: 6 } as StructureController,
    storage: options.storage === undefined ? {
      id: `${name}-storage`,
      structureType: STRUCTURE_STORAGE,
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureStorage : options.storage,
    terminal: options.terminal === undefined ? {
      id: `${name}-terminal`,
      structureType: STRUCTURE_TERMINAL,
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureTerminal : options.terminal,
    find: () => [],
  } as unknown as Room;

  Game.rooms[name] = room;
  return room;
}

function makeInvaderAtBoundary(targetRoom: string): Creep {
  const body = [
    { type: ATTACK as BodyPartConstant, hits: 100 },
    { type: MOVE as BodyPartConstant, hits: 100 },
  ];
  return {
    id: "invader-edge" as Id<Creep>,
    name: "invader_E4N59_929",
    pos: new MockPos(13, 48, targetRoom) as unknown as RoomPosition,
    room: { name: targetRoom } as Room,
    body,
    hits: 200,
    hitsMax: 200,
    owner: { username: "Invader" },
    my: false,
    getActiveBodyparts: jest.fn((part: BodyPartConstant) => body.filter((p) => p.type === part && p.hits > 0).length),
  } as unknown as Creep;
}

describe("共享清剿多余成员撤回回收", () => {
  beforeEach(() => {
    resetRuntimeServices(); installCreepPrototype(); mountCreep(); Game.time++;
    Game.rooms = {}; Game.creeps = {}; Game.spawns = {};
    jest.clearAllMocks();
  });
  it.each(["war", "powerBank"] as const)("%s退役成员走统一跨房寻路，进入源房后由spawn回收", (kind) => {
    const source = createRoom("E1N57");
    const creep = createMockPowerBankCreep("healer", { name: "returning-green", roomName: "E3N57", memory: kind === "war" ? { _warDetached: true, _warRetireToRoom: source.name } : { _recycleToRoom: source.name } });
    Object.setPrototypeOf(creep, Creep.prototype); Game.creeps[creep.name] = creep;
    const { moveToTargetRoom } = jest.requireMock("@/roles/shared") as { moveToTargetRoom: jest.Mock };
    creep.work();
    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, source.name, undefined, { routePurpose: kind === "war" ? "combat" : "normal" });
    creep.room = source;
    const spawn = { room: source, pos: new MockPos(25, 25, source.name), isActive: () => true, recycleCreep: jest.fn(() => OK) } as unknown as StructureSpawn;
    Game.spawns.Spawn1 = spawn; creep.pos = new MockPos(24, 25, source.name) as unknown as RoomPosition;
    creep.work(); expect(spawn.recycleCreep).toHaveBeenCalledWith(creep);
  });
});

describe("mountCreep carrier switching", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    clearCreepAssignmentStateForTest();
    resetRuntimeServices();
    installCreepPrototype();
    mountCreep();
    Game.time += 1;
    Memory.rooms = {};
    Game.rooms = {};
    Game.creeps = {};
  });

  it("does not ping-pong source and target when a carrier holds minerals with no valid synthesis delivery target", () => {
    const room = createRoom("W1N9", { storage: null, terminal: null });
    const lab = {
      id: "lab-1",
      structureType: STRUCTURE_LAB,
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_KEANIUM ? 200 : 0),
        getFreeCapacity: () => 0,
      },
    } as unknown as StructureLab;
    replaceCarrierTasksForProducerRoom("test", room.name, [
      {
        id: "lab-cleanup-task",
        type: "lab_cleanup",
        priority: 100,
        steps: [
          {
            id: "step-1",
            resource: RESOURCE_KEANIUM,
            fromKind: "lab",
            toKind: "storage",
            fromId: lab.id,
            toId: lab.id,
            amount: 200,
          },
        ],
      },
    ]);

    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) =>
      id === lab.id ? lab : null,
    ) as Game["getObjectById"];

    let keanium = 100;
    const creep = {
      name: "carrier-1",
      room,
      memory: {
        ready: true,
        working: true,
        role: "carrier",
        roleArgs: [],
      },
      pos: {
        getRangeTo: () => 1,
      } as unknown as RoomPosition,
      store: {
        [RESOURCE_KEANIUM]: 100,
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (resource === undefined) {
            return keanium;
          }
          return resource === RESOURCE_KEANIUM ? keanium : 0;
        },
        getFreeCapacity: () => 900,
      },
      say: jest.fn(),
      transfer: jest.fn(() => ERR_FULL),
      withdraw: jest.fn(() => ERR_NOT_ENOUGH_RESOURCES),
    } as unknown as Creep;
    ensureCreepAssignmentState(creep.name).synthesisCarrierTaskId = "lab-cleanup-task";
    Object.setPrototypeOf(creep, Creep.prototype);
    Game.creeps[creep.name] = creep;

    creep.work();
    expect(creep.memory.working).toBe(true);

    creep.work();
    expect(creep.memory.working).toBe(true);
  });
});

describe("mountCreep remoteDefender lifecycle", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    clearCreepAssignmentStateForTest();
    resetRuntimeServices();
    installCreepPrototype();
    mountCreep();
    Game.time += 1;
    Memory.rooms = {};
    Memory.data = { creepConfigs: {} } as NonNullable<Memory["data"]>;
    Game.rooms = {};
    Game.creeps = {};
    (global as typeof global & { RoomPosition: typeof MockPos }).RoomPosition = MockPos;
  });

  it("new defender on a remote room exit moves inward during ready initialization when an Invader blocks the boundary", () => {
    const sourceRoom = "E4N58";
    const targetRoom = "E4N59";
    const configName = `${sourceRoom}:remoteMine:${targetRoom}:defender:0`;
    const invader = makeInvaderAtBoundary(targetRoom);
    const room = createRoom(targetRoom);
    (room as Room & { find: jest.Mock }).find = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) {
        return [invader];
      }
      return [];
    });
    Memory.data!.remoteMining = {
      [targetRoom]: {
        sourceRoom,
        targetRoom,
        status: "defending",
        sourceIds: ["source-0", "source-1"],
        assignedAt: 100,
        updatedAt: 100,
        defenseReason: "npc_invader",
      },
    };
    getCreepConfigService().upsert(configName, "remoteDefender", [targetRoom], sourceRoom);

    const creep = createMockPowerBankCreep("remoteDefender", {
      name: "remoteDefender-new",
      x: 12,
      y: 49,
      roomName: targetRoom,
      body: [
        ...Array.from({ length: 2 }, () => ({ type: RANGED_ATTACK as BodyPartConstant, hits: 100 })),
        { type: HEAL as BodyPartConstant, hits: 100 },
        ...Array.from({ length: 3 }, () => ({ type: MOVE as BodyPartConstant, hits: 100 })),
      ],
      memory: {
        role: "remoteDefender",
        configName,
        ready: false,
        working: false,
      },
    });
    Object.assign(creep, { room });
    Object.setPrototypeOf(creep, Creep.prototype);
    Game.creeps[creep.name] = creep;

    creep.work();

    expect(creep.memory.ready).toBe(true);
    expect(creep.memory.working).toBe(false);
    expect(creep.rangedAttack).not.toHaveBeenCalled();
    expect(creep.move).toHaveBeenCalledWith(TOP_LEFT);
    expect(creep.move).not.toHaveBeenCalledWith(BOTTOM_LEFT);

    Game.time += 1;
    creep.work();

    expect(creep.memory.working).toBe(true);
    expect(creep.rangedAttack).toHaveBeenCalledWith(invader);
    expect(creep.move).toHaveBeenCalledWith(TOP_LEFT);
    expect(creep.move).not.toHaveBeenCalledWith(BOTTOM_LEFT);
  });
});
