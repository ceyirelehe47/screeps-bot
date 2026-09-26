import { carrierRole } from "@/roles/carrier";
import {
  clearCarrierTaskBoardForTest,
  replaceCarrierTasksForProducerRoom,
  type CarrierTaskDraft,
} from "@/runtime/carrierTaskBoard";
import { clearCreepAssignmentStateForTest, ensureCreepAssignmentState, getCreepAssignmentState } from "@/runtime/creepAssignmentState";
import { getCreepConfigService } from "@/runtime/runtimeServices";
import {
  clearMarketActionArbiterForTest,
} from "@/runtime/marketActionArbiter";
import { clearMarketSaleExposureReservationsForTest } from "@/runtime/marketSaleExposure";
import { clearLocalCarrierDestinationCapacityForTest } from "@/runtime/localCarrierDestinationCapacity";
import { TREASURY_T1_RUN_ID } from "@/runtime/treasuryTaskCommitmentBridge";

jest.mock("@/roles/energyTargets", () => ({
  getEnergyStoreTarget: jest.fn(),
  isDroppedResourceTarget: jest.fn(() => false),
}));

jest.mock("@/runtime/energyPickupReservation", () => ({
  getPickupReservationClaimAmount: jest.fn(() => 800),
  getPickupTargetEnergyAmount: jest.fn(() => 0),
  getReservedPickupTarget: jest.fn(() => null),
  releasePickupReservation: jest.fn(),
  reservePickupTarget: jest.fn(() => false),
}));

jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(),
}));

jest.mock("@/runtime/roomPlannerConstruction", () => ({
  getPlannedStoragePos: jest.fn(() => null),
  getPlannedControllerLinkPos: jest.fn(() => null),
  getProtoStorageContainer: jest.fn(() => null),
  getProtoControllerLinkContainer: jest.fn(() => null),
}));

const { getEnergyStoreTarget } = jest.requireMock("@/roles/energyTargets") as {
  getEnergyStoreTarget: jest.Mock;
};

const { isDroppedResourceTarget } = jest.requireMock("@/roles/energyTargets") as {
  isDroppedResourceTarget: jest.Mock;
};

const {
  getPickupReservationClaimAmount,
  getPickupTargetEnergyAmount,
  getReservedPickupTarget,
  releasePickupReservation,
  reservePickupTarget,
} = jest.requireMock("@/runtime/energyPickupReservation") as {
  getPickupReservationClaimAmount: jest.Mock;
  getPickupTargetEnergyAmount: jest.Mock;
  getReservedPickupTarget: jest.Mock;
  releasePickupReservation: jest.Mock;
  reservePickupTarget: jest.Mock;
};

const actualEnergyPickupReservation = jest.requireActual(
  "@/runtime/energyPickupReservation",
) as typeof import("@/runtime/energyPickupReservation");

function useActualEnergyPickupReservationsForTest(): void {
  actualEnergyPickupReservation.clearPickupReservationStoreForTest();
  getPickupTargetEnergyAmount.mockImplementation(
    actualEnergyPickupReservation.getPickupTargetEnergyAmount,
  );
  getReservedPickupTarget.mockImplementation(
    actualEnergyPickupReservation.getReservedPickupTarget,
  );
  reservePickupTarget.mockImplementation(
    actualEnergyPickupReservation.reservePickupTarget,
  );
  releasePickupReservation.mockImplementation(
    actualEnergyPickupReservation.releasePickupReservation,
  );
  getPickupReservationClaimAmount.mockImplementation(
    actualEnergyPickupReservation.getPickupReservationClaimAmount,
  );
}

const {
  moveToTarget,
} = jest.requireMock("@/roles/shared") as {
  moveToTarget: jest.Mock;
};

const {
  getPlannedStoragePos,
  getProtoStorageContainer,
  getProtoControllerLinkContainer,
} = jest.requireMock("@/runtime/roomPlannerConstruction") as {
  getPlannedStoragePos: jest.Mock;
  getProtoStorageContainer: jest.Mock;
  getProtoControllerLinkContainer: jest.Mock;
};

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createCreep(room: Room): Creep {
  return {
    name: "carrier-1",
    room,
    memory: {},
    pos: {
      getRangeTo: () => 1,
    } as unknown as RoomPosition,
    store: {
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource === undefined) {
          return 0;
        }
        return 0;
      },
      getFreeCapacity: () => 800,
    },
    withdraw: jest.fn(() => OK),
    transfer: jest.fn(() => OK),
    suicide: jest.fn(),
  } as unknown as Creep;
}

function createRoom(name = "W1N1", options: { level?: number; storage?: StructureStorage | null; terminal?: StructureTerminal | null } = {}): Room {
  const room = {
    name,
    controller: { my: true, level: options.level ?? 6 } as StructureController,
    find: () => [],
    terminal: options.terminal === undefined ? {
      id: `${name}-terminal`,
      structureType: STRUCTURE_TERMINAL,
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureTerminal : options.terminal,
    storage: options.storage === undefined ? {
      id: `${name}-storage`,
      structureType: STRUCTURE_STORAGE,
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 10000,
      },
    } as unknown as StructureStorage : options.storage,
  } as unknown as Room;

  Game.rooms[name] = room;
  return room;
}

function createCarrierTaskTestContainer(
  room: Room,
  id: string,
  x: number,
  contents: Partial<Record<ResourceConstant, number>> = {},
  freeCapacity = 10_000,
): StructureContainer {
  return {
    id,
    structureType: STRUCTURE_CONTAINER,
    room,
    pos: { x, y: 10, roomName: room.name },
    store: {
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource !== undefined) {
          return contents[resource] ?? 0;
        }
        return Object.values(contents).reduce(
          (total, amount) => total + (amount ?? 0),
          0,
        );
      },
      getFreeCapacity: () => freeCapacity,
    },
  } as unknown as StructureContainer;
}

function createMineralHaulTaskDraft(
  id: string,
  priority: number,
  resource: ResourceConstant,
  from: StructureContainer,
  to: StructureContainer,
  amount = 800,
): CarrierTaskDraft {
  return {
    id,
    type: "mineral_haul",
    priority,
    steps: [{
      id: `${id}:step`,
      resource,
      fromKind: "container",
      toKind: "container",
      fromId: from.id,
      toId: to.id,
      amount,
    }],
  };
}

function installCarrierTaskTestObjects(
  objects: AnyStoreStructure[],
): void {
  const byId = new Map<string, AnyStoreStructure>(
    objects.map((object) => [object.id as string, object]),
  );
  (
    Game as Game & { getObjectById: Game["getObjectById"] }
  ).getObjectById = jest.fn((id: string) => byId.get(id) ?? null) as unknown as Game["getObjectById"];
}

function installTerminalBootstrapEnergyScenario(
  roomName: string,
  options: {
    flag?: boolean;
    terminalEnergy?: number;
    terminalReserve?: number;
  } = {},
): {
  room: Room;
  terminal: StructureTerminal;
  spawn: StructureSpawn;
  creep: Creep;
} {
  clearMarketActionArbiterForTest();
  clearMarketSaleExposureReservationsForTest();
  const room = createRoom(roomName);
  Object.assign(room, {
    energyAvailable: 300,
    energyCapacityAvailable: 5_600,
  });
  const terminalEnergy = options.terminalEnergy ?? 42_209;
  const terminal = room.terminal as StructureTerminal;
  Object.assign(terminal, {
    room,
    pos: { x: 15, y: 28, roomName },
    send: jest.fn(() => OK),
    store: {
      getUsedCapacity: (resource?: ResourceConstant) =>
        resource === undefined || resource === RESOURCE_ENERGY
          ? terminalEnergy
          : 0,
      getFreeCapacity: () => 300_000 - terminalEnergy,
    },
  });
  const spawn = {
    id: `${roomName}-bootstrap-spawn`,
    structureType: STRUCTURE_SPAWN,
    room,
    pos: { x: 16, y: 28, roomName },
    store: {
      getUsedCapacity: () => 0,
      getFreeCapacity: () => 300,
    },
  } as unknown as StructureSpawn;
  const creep = createCreep(room);
  Game.creeps[creep.name] = creep;
  Memory.cfg = {
    energyPickup: {
      terminalBootstrapRecoveryRooms: options.flag === false
        ? {}
        : { [roomName]: true },
    },
    resourceControl: {
      rooms: {
        [roomName]: {
          terminalEnergyReserve: options.terminalReserve ?? 20_000,
        },
      },
    },
  };
  Memory.runtime = {};
  getEnergyStoreTarget.mockReturnValue(spawn);
  getPickupTargetEnergyAmount.mockImplementation(
    (target: AnyStoreStructure, availability?: { terminalEnergyReserve?: number }) => {
      if (target !== terminal) return 0;
      return Math.max(
        0,
        terminalEnergy - (availability?.terminalEnergyReserve ?? 50_000),
      );
    },
  );
  getReservedPickupTarget.mockReturnValue(null);
  reservePickupTarget.mockReturnValue(true);
  (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn(
    (id: string) => {
      if (id === terminal.id) return terminal;
      if (id === spawn.id) return spawn;
      return null;
    },
  ) as Game["getObjectById"];

  return { room, terminal, spawn, creep };
}

function installNukerEnergyClaimScenario(
  roomName: string,
  taskAmount = 1_000,
): {
  room: Room;
  storage: StructureStorage;
  nuker: StructureNuker;
  taskId: string;
} {
  const room = createRoom(roomName);
  const storage = room.storage as StructureStorage;
  Object.assign(storage, {
    room,
    pos: { x: 10, y: 10, roomName },
    store: {
      getUsedCapacity: (resource?: ResourceConstant) =>
        resource === RESOURCE_ENERGY ? 5_000 : 0,
      getFreeCapacity: () => 100_000,
    },
  });
  const nuker = {
    id: `${roomName}-claim-nuker`,
    structureType: STRUCTURE_NUKER,
    pos: { x: 11, y: 10, roomName },
    store: {
      getUsedCapacity: () => 0,
      getFreeCapacity: (resource?: ResourceConstant) =>
        resource === RESOURCE_ENERGY ? 300_000 : 0,
    },
  } as unknown as StructureNuker;
  const taskId = `${roomName}-nuker-energy-claim`;
  (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
    if (id === storage.id) return storage;
    if (id === nuker.id) return nuker;
    return null;
  }) as unknown as Game["getObjectById"];
  replaceCarrierTasksForProducerRoom("nukerControl", room.name, [{
    id: taskId,
    type: "nuker_supply",
    priority: 0,
    steps: [{
      id: `${roomName}-energy:storage->nuker`,
      resource: RESOURCE_ENERGY,
      fromKind: "storage",
      toKind: "nuker",
      fromId: storage.id,
      toId: nuker.id,
      amount: taskAmount,
    }],
  }]);
  getEnergyStoreTarget.mockReturnValue(null);
  return { room, storage, nuker, taskId };
}

function installTerminalKeaniumPickupScenario(
  roomName: string,
  storedAmount: number,
  taskAmount = 800,
): {
  room: Room;
  terminal: StructureTerminal;
  target: StructureLab;
} {
  const room = createRoom(roomName);
  const terminal = room.terminal as StructureTerminal;
  Object.assign(terminal, {
    room,
    pos: { x: 10, y: 10, roomName },
    store: {
      getUsedCapacity: (resource?: ResourceConstant) =>
        resource === RESOURCE_KEANIUM
          ? storedAmount
          : resource === RESOURCE_ENERGY
            ? 10_000
            : 0,
      getFreeCapacity: () => 10_000,
    },
  });
  const target = {
    id: `${roomName}-market-exposure-target`,
    structureType: STRUCTURE_LAB,
    pos: { x: 11, y: 10, roomName },
    store: {
      getUsedCapacity: () => 0,
      getFreeCapacity: () => 3_000,
    },
  } as unknown as StructureLab;
  (
    Game as Game & { getObjectById: Game["getObjectById"] }
  ).getObjectById = jest.fn((id: string) => {
    if (id === terminal.id) return terminal;
    if (id === target.id) return target;
    return null;
  }) as Game["getObjectById"];
  replaceCarrierTasksForProducerRoom("synthesisControl", room.name, [{
    id: `${roomName}-market-exposure-haul`,
    type: "lab_supply",
    priority: 100,
    steps: [{
      id: `${roomName}-K:term->lab`,
      resource: RESOURCE_KEANIUM,
      fromKind: "terminal",
      toKind: "lab",
      fromId: terminal.id,
      toId: target.id,
      amount: taskAmount,
    }],
  }]);
  return { room, terminal, target };
}


describe("carrierRole mineral hauling", () => {
  function resetCarrierFixture(): void {
    clearCarrierTaskBoardForTest();
    clearCreepAssignmentStateForTest();
    clearLocalCarrierDestinationCapacityForTest();
    resetRuntimeServices();
    clearMarketActionArbiterForTest();
    clearMarketSaleExposureReservationsForTest();
    actualEnergyPickupReservation.clearPickupReservationStoreForTest();
    Game.time += 1;
    Game.rooms = {};
    Game.creeps = {};
    Game.spawns = {};
    (Game.getObjectById as jest.Mock) = jest.fn(() => null);
    Memory.rooms = {};
    Memory.cfg = undefined;
    Memory.runtime = undefined;
    Memory.data = undefined;
    getEnergyStoreTarget.mockReset();
    isDroppedResourceTarget.mockReset();
    isDroppedResourceTarget.mockReturnValue(false);
    getPickupTargetEnergyAmount.mockReset();
    getPickupTargetEnergyAmount.mockReturnValue(0);
    getPickupReservationClaimAmount.mockReset();
    getPickupReservationClaimAmount.mockReturnValue(800);
    getReservedPickupTarget.mockReset();
    getReservedPickupTarget.mockReturnValue(null);
    releasePickupReservation.mockReset();
    reservePickupTarget.mockReset();
    reservePickupTarget.mockReturnValue(false);
    moveToTarget.mockReset();
    getPlannedStoragePos.mockReset();
    getPlannedStoragePos.mockReturnValue(null);
    getProtoStorageContainer.mockReset();
    getProtoStorageContainer.mockReturnValue(null);
    getProtoControllerLinkContainer.mockReset();
    getProtoControllerLinkContainer.mockReturnValue(null);
  }

  beforeEach(resetCarrierFixture);


  it("caps two same-tick recovery withdraw intents to their actual 800/200 claims without market exposure", () => {
    const {
      room,
      creep: first,
    } = installTerminalBootstrapEnergyScenario("W1N1", {
      terminalEnergy: 21_000,
      terminalReserve: 20_000,
    });
    first.name = "carrier-1";
    first.memory.configName = "W1N1:manual:maxcarrier:1";
    const second = createCreep(room);
    second.name = "carrier-2";
    second.memory.configName = "W1N1:manual:maxcarrier:2";
    Game.creeps = {
      [first.name]: first,
      [second.name]: second,
    };
    useActualEnergyPickupReservationsForTest();

    carrierRole().source?.(first);
    carrierRole().source?.(second);

    const firstAmount = (first.withdraw as jest.Mock).mock.calls[0]?.[2];
    const secondAmount = (second.withdraw as jest.Mock).mock.calls[0]?.[2];
    expect([firstAmount, secondAmount]).toEqual([800, 200]);
    expect(firstAmount + secondAmount).toBeLessThanOrEqual(1_000);
    expect(Memory.data?.marketSaleAutomation).toBeUndefined();
  });

  it("releases a failed Nuker Energy pickup claim for the next Carrier", () => {
    const { room, storage } = installNukerEnergyClaimScenario(
      "W124N2",
    );
    const fullCapacityStore = {
      getUsedCapacity: () => 0,
      getFreeCapacity: () => 1_000,
    };
    const failed = {
      ...createCreep(room),
      name: "nuker-pickup-failed",
      store: fullCapacityStore,
      withdraw: jest.fn(() => ERR_NOT_IN_RANGE),
    } as unknown as Creep;
    const retry = {
      ...createCreep(room),
      name: "nuker-pickup-retry",
      store: fullCapacityStore,
    } as unknown as Creep;
    Game.creeps = {
      [failed.name]: failed,
      [retry.name]: retry,
    };

    carrierRole().source?.(failed);
    carrierRole().source?.(retry);

    expect(retry.withdraw).toHaveBeenCalledWith(
      storage,
      RESOURCE_ENERGY,
      1_000,
    );
  });

  it("preserves hard-lane ordering and falls back after capacity-relief withdraw failure", () => {
    {
      const room = createRoom("W1N2");
      const storage = room.storage as StructureStorage;
      const terminal = room.terminal as StructureTerminal;
      Object.assign(storage, {
        pos: { x: 10, y: 10, roomName: room.name },
        store: {
          getUsedCapacity: (resource?: ResourceConstant) => {
            if (resource === RESOURCE_POWER) return 80;
            if (resource === RESOURCE_LEMERGIUM) return 3_000;
            return 0;
          },
          getFreeCapacity: () => 100_000,
        },
      });
      const powerSpawn = {
        id: "power-spawn-supply-target",
        structureType: STRUCTURE_POWER_SPAWN,
        pos: { x: 11, y: 10, roomName: room.name },
        store: {
          getUsedCapacity: () => 0,
          getFreeCapacity: (resource?: ResourceConstant) => resource === RESOURCE_POWER ? 100 : 0,
        },
      } as unknown as StructurePowerSpawn;
      const creep = createCreep(room);
      getEnergyStoreTarget.mockReturnValue({
        id: "non-critical-lab-energy-demand",
        structureType: STRUCTURE_LAB,
      } as unknown as StructureLab);
      (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
        if (id === storage.id) return storage;
        if (id === terminal.id) return terminal;
        if (id === powerSpawn.id) return powerSpawn;
        return null;
      }) as unknown as Game["getObjectById"];
      replaceCarrierTasksForProducerRoom("powerSpawnControl", room.name, [{
        id: "power-spawn-supply-task",
        type: "power_spawn_supply",
        priority: 150,
        steps: [{
          id: "power:storage->power-spawn",
          resource: RESOURCE_POWER,
          fromKind: "storage",
          toKind: "power_spawn",
          fromId: storage.id,
          toId: powerSpawn.id,
          amount: 80,
        }],
      }]);
      replaceCarrierTasksForProducerRoom("resourceControl:preload", room.name, [{
        id: "resourceControl:terminal_feed:W1N2:L",
        type: "terminal_feed",
        dispatchClass: "capacity_relief",
        priority: 80,
        steps: [{
          id: "L:storage->terminal-behind-power-spawn",
          resource: RESOURCE_LEMERGIUM,
          fromKind: "storage",
          toKind: "terminal",
          fromId: storage.id,
          toId: terminal.id,
          amount: 3_000,
        }],
      }]);

      const switched = carrierRole().source?.(creep);

      expect(creep.withdraw).toHaveBeenCalledWith(storage, RESOURCE_POWER, 80);
      expect(creep.withdraw).not.toHaveBeenCalledWith(
        storage,
        RESOURCE_LEMERGIUM,
        expect.any(Number),
      );
      expect(switched).toBe(true);
      expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId).toBe("power-spawn-supply-task");
    }

    resetCarrierFixture();

    {
      const room = createRoom("W118N2");
      const storage = room.storage as StructureStorage;
      const terminal = room.terminal as StructureTerminal;
      Object.assign(storage, {
        pos: { x: 10, y: 10, roomName: room.name },
        store: {
          getUsedCapacity: (resource?: ResourceConstant) =>
            resource === RESOURCE_LEMERGIUM ? 5_000 : 0,
          getFreeCapacity: () => 0,
        },
      });
      const energySource = {
        id: "ordinary-energy-source-after-failed-preload",
        structureType: STRUCTURE_CONTAINER,
        room,
        pos: { x: 12, y: 10, roomName: room.name },
        store: {
          getUsedCapacity: (resource?: ResourceConstant) =>
            resource === undefined || resource === RESOURCE_ENERGY ? 500 : 0,
          getFreeCapacity: () => 1_500,
        },
      } as unknown as StructureContainer;
      const lab = {
        id: "ordinary-lab-after-failed-preload",
        structureType: STRUCTURE_LAB,
        pos: { x: 13, y: 10, roomName: room.name },
        store: {
          getUsedCapacity: () => 0,
          getFreeCapacity: () => 1_000,
        },
      } as unknown as StructureLab;
      const creep = {
        ...createCreep(room),
        withdraw: jest.fn((target: AnyStoreStructure) =>
          target === storage ? ERR_NOT_ENOUGH_RESOURCES : OK,
        ),
      } as unknown as Creep;
      getEnergyStoreTarget.mockReturnValue(lab);
      getReservedPickupTarget.mockReturnValue(energySource);
      getPickupTargetEnergyAmount.mockImplementation((target: unknown) =>
        target === energySource ? 500 : 0,
      );
      reservePickupTarget.mockReturnValue(true);
      (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
        if (id === storage.id) return storage;
        if (id === terminal.id) return terminal;
        if (id === energySource.id) return energySource;
        if (id === lab.id) return lab;
        return null;
      }) as unknown as Game["getObjectById"];
      replaceCarrierTasksForProducerRoom("resourceControl:preload", room.name, [{
        id: "resourceControl:terminal_feed:W118N2:L",
        type: "terminal_feed",
        dispatchClass: "capacity_relief",
        priority: 80,
        steps: [{
          id: "L:storage->terminal-failed-preload",
          resource: RESOURCE_LEMERGIUM,
          fromKind: "storage",
          toKind: "terminal",
          fromId: storage.id,
          toId: terminal.id,
          amount: 3_000,
        }],
      }]);

      carrierRole().source?.(creep);

      expect(creep.withdraw).toHaveBeenCalledWith(
        storage,
        RESOURCE_LEMERGIUM,
        800,
      );
      expect(creep.withdraw).toHaveBeenCalledWith(
        energySource,
        RESOURCE_ENERGY,
      );
      expect(getCreepAssignmentState(creep.name)?.synthesisCarrierTaskId)
        .toBeUndefined();
    }
  });

  it("task-bound Synthesis carrier 只搬 Direct 待售资源 reservation 外余量", () => {
    clearMarketActionArbiterForTest();
    clearMarketSaleExposureReservationsForTest();
    const { room, terminal } = installTerminalKeaniumPickupScenario(
      "W78N1",
      1_800,
    );
    Memory.data = {
      marketSaleAutomation: {
        managedOrders: {},
        pendingDirectDeals: {
          direct: {
            requestId: "direct-synthesis",
            status: "reconcile_gap",
            canaryRoomName: room.name,
            resource: RESOURCE_KEANIUM,
            dealAmount: 1_000,
            transactionEnergy: 500,
          },
        },
      },
    } as unknown as Memory["data"];
    const carrier = {
      ...createCreep(room),
      withdraw: jest.fn(() => OK),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(null);

    carrierRole().source?.(carrier);

    expect(carrier.withdraw).toHaveBeenCalledWith(
      terminal,
      RESOURCE_KEANIUM,
      800,
    );
  });

  it("holds a real carrier terminal withdraw during T1 and resumes after drain", () => {
    const { room, terminal } = installTerminalKeaniumPickupScenario("E3N59", 1_800);
    const carrier = createCreep(room);
    getEnergyStoreTarget.mockReturnValue(null);
    Memory.runtime = {
      treasuryProductionT1Quota: { runId: TREASURY_T1_RUN_ID, status: "dispatching" },
    } as unknown as Memory["runtime"];

    carrierRole().source?.(carrier);
    expect(carrier.withdraw).not.toHaveBeenCalled();

    (Memory.runtime as unknown as { treasuryProductionT1Quota: { status: string } })
      .treasuryProductionT1Quota.status = "drained";
    Game.time += 1;
    carrierRole().source?.(carrier);
    expect(carrier.withdraw).toHaveBeenCalledWith(terminal, RESOURCE_KEANIUM, 800);
  });

  it("holds cargo already carried toward the T1 destination terminal", () => {
    const room = createRoom("E4N58");
    const storage = room.storage as StructureStorage;
    const terminal = room.terminal as StructureTerminal;
    Object.assign(storage, {
      room,
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? 500 : 0,
        getFreeCapacity: () => 100_000,
      },
    });
    Object.assign(terminal, {
      room,
      pos: { x: 11, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 100_000,
      },
    });
    installCarrierTaskTestObjects([storage, terminal]);
    replaceCarrierTasksForProducerRoom("resourceControl:preload", room.name, [{
      id: "T1-destination-energy-preload",
      type: "terminal_feed",
      dispatchClass: "capacity_relief",
      priority: 80,
      steps: [{
        id: "energy:storage->terminal",
        resource: RESOURCE_ENERGY,
        fromKind: "storage",
        toKind: "terminal",
        fromId: storage.id,
        toId: terminal.id,
        amount: 100,
      }],
    }]);
    let carried = 0;
    const carrier = {
      ...createCreep(room),
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY ? carried : 0,
        getFreeCapacity: () => 800 - carried,
      },
      withdraw: jest.fn(() => { carried = 100; return OK; }),
      transfer: jest.fn(() => { carried = 0; return OK; }),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(null);
    carrierRole().source?.(carrier);
    expect(carrier.withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY, 100);

    Memory.runtime = {
      treasuryProductionT1Quota: { runId: TREASURY_T1_RUN_ID, status: "dispatching" },
    } as unknown as Memory["runtime"];
    carrierRole().target(carrier);
    expect(carrier.transfer).not.toHaveBeenCalled();

    (Memory.runtime as unknown as { treasuryProductionT1Quota: { status: string } })
      .treasuryProductionT1Quota.status = "drained";
    Game.time += 1;
    carrierRole().target(carrier);
    expect(carrier.transfer).toHaveBeenCalledWith(terminal, RESOURCE_ENERGY);
  });

  it("keeps exact producer stickiness and reselects by priority after owner removal", () => {
    {
      const room = createRoom("W207N1");
      const firstSource = createCarrierTaskTestContainer(
        room,
        "carrier-owner-a-source",
        2,
        { [RESOURCE_UTRIUM]: 2_000 },
      );
      const secondSource = createCarrierTaskTestContainer(
        room,
        "carrier-owner-b-source",
        3,
        { [RESOURCE_KEANIUM]: 2_000 },
      );
      const destination = createCarrierTaskTestContainer(
        room,
        "carrier-owner-sticky-target",
        4,
      );
      installCarrierTaskTestObjects([firstSource, secondSource, destination]);
      const taskId = "shared-carrier-local-id";
      replaceCarrierTasksForProducerRoom("carrier-owner-a", room.name, [
        createMineralHaulTaskDraft(
          taskId,
          10,
          RESOURCE_UTRIUM,
          firstSource,
          destination,
        ),
      ]);
      const creep = createCreep(room);
      creep.withdraw = jest.fn(() => ERR_NOT_IN_RANGE);

      carrierRole().source?.(creep);
      replaceCarrierTasksForProducerRoom("carrier-owner-b", room.name, [
        createMineralHaulTaskDraft(
          taskId,
          1_000,
          RESOURCE_KEANIUM,
          secondSource,
          destination,
        ),
      ]);
      carrierRole().source?.(creep);

      expect(creep.withdraw).toHaveBeenCalledTimes(2);
      expect(creep.withdraw).toHaveBeenNthCalledWith(
        2,
        firstSource,
        RESOURCE_UTRIUM,
        800,
      );
      expect(creep.withdraw).not.toHaveBeenCalledWith(
        secondSource,
        RESOURCE_KEANIUM,
        expect.any(Number),
      );
      expect(getCreepAssignmentState(creep.name)).toMatchObject({
        synthesisCarrierTaskId: taskId,
        dispatchBindings: {
          carrier: {
            system: "carrier-logistics",
            namespace: "carrier-owner-a",
            scope: { kind: "room", roomName: room.name },
            localId: taskId,
          },
        },
      });
    }

    resetCarrierFixture();

    {
      const room = createRoom("W208N2");
      const oldSource = createCarrierTaskTestContainer(
        room,
        "carrier-removed-owner-source",
        2,
        { [RESOURCE_UTRIUM]: 2_000 },
      );
      const sameNameSource = createCarrierTaskTestContainer(
        room,
        "carrier-same-name-owner-source",
        3,
        { [RESOURCE_KEANIUM]: 2_000 },
      );
      const preferredSource = createCarrierTaskTestContainer(
        room,
        "carrier-priority-reselection-source",
        4,
        { [RESOURCE_ZYNTHIUM]: 2_000 },
      );
      const destination = createCarrierTaskTestContainer(
        room,
        "carrier-owner-reselection-target",
        5,
      );
      installCarrierTaskTestObjects([
        oldSource,
        sameNameSource,
        preferredSource,
        destination,
      ]);
      const sharedTaskId = "carrier-owner-reselection-shared";
      replaceCarrierTasksForProducerRoom("removed-owner", room.name, [
        createMineralHaulTaskDraft(
          sharedTaskId,
          10,
          RESOURCE_UTRIUM,
          oldSource,
          destination,
        ),
      ]);
      const creep = createCreep(room);
      creep.withdraw = jest.fn(() => ERR_NOT_IN_RANGE);
      carrierRole().source?.(creep);

      replaceCarrierTasksForProducerRoom("same-name-owner", room.name, [
        createMineralHaulTaskDraft(
          sharedTaskId,
          50,
          RESOURCE_KEANIUM,
          sameNameSource,
          destination,
        ),
      ]);
      replaceCarrierTasksForProducerRoom("preferred-owner", room.name, [
        createMineralHaulTaskDraft(
          "carrier-owner-reselection-preferred",
          100,
          RESOURCE_ZYNTHIUM,
          preferredSource,
          destination,
        ),
      ]);
      replaceCarrierTasksForProducerRoom("removed-owner", room.name, []);
      (creep.withdraw as jest.Mock).mockClear();

      carrierRole().source?.(creep);

      expect(creep.withdraw).toHaveBeenCalledWith(
        preferredSource,
        RESOURCE_ZYNTHIUM,
        800,
      );
      expect(creep.withdraw).not.toHaveBeenCalledWith(
        sameNameSource,
        RESOURCE_KEANIUM,
        expect.any(Number),
      );
      expect(getCreepAssignmentState(creep.name)?.dispatchBindings?.carrier)
        .toMatchObject({
          namespace: "preferred-owner",
          scope: { roomName: room.name },
          localId: "carrier-owner-reselection-preferred",
        });
    }
  });

  it("releases room-scope drift and resolves parallel step endpoints independently", () => {
    {
      const oldRoom = createRoom("W209N3");
      const newRoom = createRoom("W210N3");
      const oldSource = createCarrierTaskTestContainer(
        oldRoom,
        "carrier-old-room-source",
        2,
        { [RESOURCE_UTRIUM]: 2_000 },
      );
      const oldTarget = createCarrierTaskTestContainer(
        oldRoom,
        "carrier-old-room-target",
        3,
      );
      const newSource = createCarrierTaskTestContainer(
        newRoom,
        "carrier-new-room-source",
        2,
        { [RESOURCE_KEANIUM]: 2_000 },
      );
      const newTarget = createCarrierTaskTestContainer(
        newRoom,
        "carrier-new-room-target",
        3,
      );
      installCarrierTaskTestObjects([
        oldSource,
        oldTarget,
        newSource,
        newTarget,
      ]);
      replaceCarrierTasksForProducerRoom("old-room-owner", oldRoom.name, [
        createMineralHaulTaskDraft(
          "carrier-old-room-task",
          100,
          RESOURCE_UTRIUM,
          oldSource,
          oldTarget,
        ),
      ]);
      replaceCarrierTasksForProducerRoom("new-room-owner", newRoom.name, [
        createMineralHaulTaskDraft(
          "carrier-new-room-task",
          100,
          RESOURCE_KEANIUM,
          newSource,
          newTarget,
        ),
      ]);
      const creep = createCreep(oldRoom);
      creep.memory.configName = "carrier-room-drift-config";
      creep.withdraw = jest.fn(() => ERR_NOT_IN_RANGE);
      getCreepConfigService().upsert(
        creep.memory.configName,
        "carrier",
        [],
        oldRoom.name,
      );
      carrierRole().source?.(creep);
      getCreepConfigService().upsert(
        creep.memory.configName,
        "carrier",
        [],
        newRoom.name,
      );
      (creep.withdraw as jest.Mock).mockClear();

      carrierRole().source?.(creep);

      expect(creep.withdraw).toHaveBeenCalledWith(
        newSource,
        RESOURCE_KEANIUM,
        800,
      );
      expect(getCreepAssignmentState(creep.name)?.dispatchBindings?.carrier)
        .toMatchObject({
          namespace: "new-room-owner",
          scope: { roomName: newRoom.name },
          localId: "carrier-new-room-task",
        });
    }

    resetCarrierFixture();

    {
      const room = createRoom("W204N4");
      const farSource = createCarrierTaskTestContainer(
        room,
        "carrier-parallel-far-source",
        8,
        { [RESOURCE_UTRIUM]: 2_000 },
      );
      const nearDestination = createCarrierTaskTestContainer(
        room,
        "carrier-parallel-near-destination",
        1,
      );
      const nearSource = createCarrierTaskTestContainer(
        room,
        "carrier-parallel-near-source",
        2,
        { [RESOURCE_KEANIUM]: 2_000 },
      );
      const farDestination = createCarrierTaskTestContainer(
        room,
        "carrier-parallel-far-destination",
        9,
      );
      installCarrierTaskTestObjects([
        farSource,
        nearDestination,
        nearSource,
        farDestination,
      ]);
      const taskId = "carrier-parallel-step-task";
      replaceCarrierTasksForProducerRoom("carrier-parallel-test", room.name, [{
        id: taskId,
        type: "mineral_haul",
        priority: 100,
        steps: [
          {
            id: "carrier-parallel-far-source-step",
            resource: RESOURCE_UTRIUM,
            fromKind: "container",
            toKind: "container",
            fromId: farSource.id,
            toId: nearDestination.id,
            amount: 400,
          },
          {
            id: "carrier-parallel-near-source-step",
            resource: RESOURCE_KEANIUM,
            fromKind: "container",
            toKind: "container",
            fromId: nearSource.id,
            toId: farDestination.id,
            amount: 400,
          },
        ],
      }]);
      const pickupCarrier = createCreep(room);
      pickupCarrier.name = "carrier-parallel-pickup";
      Object.assign(pickupCarrier, {
        pos: {
          getRangeTo: (pos: RoomPosition) => pos.x,
        } as unknown as RoomPosition,
      });
      const deliveryCarrier = {
        ...createCreep(room),
        name: "carrier-parallel-delivery",
        pos: {
          getRangeTo: (pos: RoomPosition) => pos.x,
        } as unknown as RoomPosition,
        store: {
          getUsedCapacity: (resource?: ResourceConstant) => {
            if (resource === undefined) return 800;
            if (resource === RESOURCE_UTRIUM) return 400;
            if (resource === RESOURCE_KEANIUM) return 400;
            return 0;
          },
          getFreeCapacity: () => 0,
        },
        transfer: jest.fn(() => OK),
      } as unknown as Creep;
      Game.creeps = {
        [pickupCarrier.name]: pickupCarrier,
        [deliveryCarrier.name]: deliveryCarrier,
      };
      ensureCreepAssignmentState(deliveryCarrier.name).synthesisCarrierTaskId =
        taskId;

      carrierRole().source?.(pickupCarrier);
      carrierRole().target(deliveryCarrier);

      expect(pickupCarrier.withdraw).toHaveBeenCalledWith(
        nearSource,
        RESOURCE_KEANIUM,
        400,
      );
      expect(deliveryCarrier.transfer).toHaveBeenCalledWith(
        nearDestination,
        RESOURCE_UTRIUM,
      );
    }
  });

  it("allows multiple carriers to bind and withdraw from an ordinary task in the same tick", () => {
    const room = createRoom("W205N5");
    const source = createCarrierTaskTestContainer(
      room,
      "carrier-shared-ordinary-source",
      2,
      { [RESOURCE_UTRIUM]: 5_000 },
    );
    const destination = createCarrierTaskTestContainer(
      room,
      "carrier-shared-ordinary-target",
      3,
    );
    installCarrierTaskTestObjects([source, destination]);
    const taskId = "carrier-shared-ordinary-task";
    replaceCarrierTasksForProducerRoom("carrier-shared-task-test", room.name, [
      createMineralHaulTaskDraft(
        taskId,
        100,
        RESOURCE_UTRIUM,
        source,
        destination,
      ),
    ]);
    const first = createCreep(room);
    first.name = "carrier-shared-ordinary-first";
    const second = createCreep(room);
    second.name = "carrier-shared-ordinary-second";
    Game.creeps = {
      [first.name]: first,
      [second.name]: second,
    };

    carrierRole().source?.(first);
    carrierRole().source?.(second);

    expect(first.withdraw).toHaveBeenCalledWith(
      source,
      RESOURCE_UTRIUM,
      800,
    );
    expect(second.withdraw).toHaveBeenCalledWith(
      source,
      RESOURCE_UTRIUM,
      800,
    );
    expect(getCreepAssignmentState(first.name)?.synthesisCarrierTaskId)
      .toBe(taskId);
    expect(getCreepAssignmentState(second.name)?.synthesisCarrierTaskId)
      .toBe(taskId);
  });

  it("delivers accepted Nuker Energy from its pickup snapshot after task prune", () => {
    const room = createRoom("W128N2");
    const storage = room.storage as StructureStorage;
    Object.assign(storage, {
      pos: { x: 10, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? 5_000 : 0,
        getFreeCapacity: () => 100_000,
      },
    });
    const nuker = {
      id: "snapshot-nuker-energy-target",
      structureType: STRUCTURE_NUKER,
      pos: { x: 11, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? 300_000 : 0,
      },
    } as unknown as StructureNuker;
    const decoyNuker = {
      id: "snapshot-nuker-same-name-other-owner-target",
      structureType: STRUCTURE_NUKER,
      pos: { x: 12, y: 10, roomName: room.name },
      store: {
        getUsedCapacity: () => 0,
        getFreeCapacity: (resource?: ResourceConstant) =>
          resource === RESOURCE_ENERGY ? 300_000 : 0,
      },
    } as unknown as StructureNuker;
    let carriedEnergy = 0;
    const creep = {
      ...createCreep(room),
      store: {
        getUsedCapacity: (resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY
            ? carriedEnergy
            : 0,
        getFreeCapacity: () => 800 - carriedEnergy,
      },
      withdraw: jest.fn(() => {
        carriedEnergy = 800;
        return OK;
      }),
      transfer: jest.fn(() => {
        carriedEnergy = 0;
        return OK;
      }),
    } as unknown as Creep;
    getEnergyStoreTarget.mockReturnValue(null);
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn((id: string) => {
      if (id === storage.id) return storage;
      if (id === nuker.id) return nuker;
      if (id === decoyNuker.id) return decoyNuker;
      return null;
    }) as unknown as Game["getObjectById"];
    const taskId = "snapshot-nuker-energy-task";
    const originalProducer = "nukerControl:original";
    replaceCarrierTasksForProducerRoom(originalProducer, room.name, [{
      id: taskId,
      type: "nuker_supply",
      priority: 0,
      steps: [{
        id: "energy:storage->snapshot-nuker",
        resource: RESOURCE_ENERGY,
        fromKind: "storage",
        toKind: "nuker",
        fromId: storage.id,
        toId: nuker.id,
        amount: 1_000,
      }],
    }]);

    carrierRole().source?.(creep);
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierPendingTaskRef)
      .toEqual({
        system: "carrier-logistics",
        namespace: originalProducer,
        scope: { kind: "room", roomName: room.name },
        localId: taskId,
      });
    replaceCarrierTasksForProducerRoom("nukerControl:other", room.name, [{
      id: taskId,
      type: "nuker_supply",
      priority: 1_000,
      steps: [{
        id: "energy:storage->same-name-other-owner-nuker",
        resource: RESOURCE_ENERGY,
        fromKind: "storage",
        toKind: "nuker",
        fromId: storage.id,
        toId: decoyNuker.id,
        amount: 1_000,
      }],
    }]);
    replaceCarrierTasksForProducerRoom(originalProducer, room.name, []);
    Game.time += 1;
    carrierRole().target(creep);

    expect(creep.transfer).toHaveBeenCalledWith(
      nuker,
      RESOURCE_ENERGY,
    );
    expect(creep.transfer).toHaveBeenCalledTimes(1);
    expect(getCreepAssignmentState(creep.name)).not.toEqual(
      expect.objectContaining({
        synthesisCarrierPendingTaskType: expect.any(String),
      }),
    );
    expect(getCreepAssignmentState(creep.name)?.synthesisCarrierPendingTaskRef)
      .toBeUndefined();
  });
});
