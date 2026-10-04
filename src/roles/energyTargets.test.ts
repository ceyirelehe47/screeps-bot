jest.mock("@/runtime/defenseMode", () => ({
  isDefenseMode: jest.fn(() => false),
  isOffensiveWarCreep: jest.fn(() => false),
}));

jest.mock("@/runtime/safeZone", () => ({
  getSafeZone: jest.fn(() => new Set()),
}));

import { getEnergyStoreTarget } from "@/roles/energyTargets";
import { clearCreepAssignmentStateForTest } from "@/runtime/creepAssignmentState";
import { clearPickupReservationStoreForTest } from "@/runtime/energyPickupReservation";
import { isDefenseMode } from "@/runtime/defenseMode";
import { getSafeZone } from "@/runtime/safeZone";
import { resetPowerCreepControlCacheForTest } from "@/runtime/powerCreepControl";
import { clearSpawnActiveCacheForTest } from "@/runtime/tickContext";

jest.mock("@/runtime/roomPlannerConstruction", () => ({
  getProtoStorageContainer: jest.fn(() => null),
  getProtoControllerLinkContainer: jest.fn(() => null),
}));

const { getProtoStorageContainer, getProtoControllerLinkContainer } = jest.requireMock("@/runtime/roomPlannerConstruction") as {
  getProtoStorageContainer: jest.Mock;
  getProtoControllerLinkContainer: jest.Mock;
};

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createStore(used: number, capacity: number) {
  return {
    getUsedCapacity: (resource?: ResourceConstant) => (resource === undefined || resource === RESOURCE_ENERGY ? used : 0),
    getFreeCapacity: (resource?: ResourceConstant) => (resource === undefined || resource === RESOURCE_ENERGY ? capacity - used : 0),
    getCapacity: (resource?: ResourceConstant) => (resource === undefined || resource === RESOURCE_ENERGY ? capacity : 0),
  };
}

function createPos(x: number, roomName = "W1N1"): RoomPosition {
  return {
    x,
    y: 25,
    roomName,
    getRangeTo: (target: RoomPosition) => Math.abs(x - target.x),
  } as unknown as RoomPosition;
}

function createRoom(options: {
  name?: string;
  myStructures?: Structure<StructureConstant>[];
  structures?: Structure<StructureConstant>[];
  dropped?: Resource[];
  tombstones?: Tombstone[];
  ruins?: Ruin[];
  storage?: StructureStorage | null;
  terminal?: StructureTerminal | null;
  controller?: StructureController | null;
} = {}): Room {
  const name = options.name ?? "W1N1";
  const memory = {} as RoomMemory;
  Memory.rooms[name] = memory;

  return {
    name,
    memory,
    controller: options.controller ?? null,
    storage: options.storage ?? null,
    terminal: options.terminal ?? null,
    find(type: FindConstant) {
      if (type === FIND_MY_STRUCTURES) {
        return options.myStructures ?? [];
      }

      if (type === FIND_STRUCTURES) {
        return options.structures ?? [];
      }

      if (type === FIND_DROPPED_RESOURCES) {
        return options.dropped ?? [];
      }

      if (type === FIND_TOMBSTONES) {
        return options.tombstones ?? [];
      }

      if (type === FIND_RUINS) {
        return options.ruins ?? [];
      }

      return [];
    },
  } as Room;
}

function createCreep(room: Room): Creep {
  return {
    name: "Worker1",
    room,
    memory: {},
    pos: createPos(25, room.name),
    store: {
      getCapacity: () => 50,
      getFreeCapacity: () => 50,
      getUsedCapacity: () => 0,
    } as StoreDefinition,
    pickup: jest.fn(() => OK),
    withdraw: jest.fn(() => OK),
  } as unknown as Creep;
}

describe("energyTargets", () => {
  beforeEach(() => {
    clearCreepAssignmentStateForTest();
    clearPickupReservationStoreForTest();
    resetRuntimeServices();
    Game.time += 1;
    (isDefenseMode as jest.Mock).mockReturnValue(false);
    (getSafeZone as jest.Mock).mockReturnValue(new Set());
    Game.flags = {};
    getProtoStorageContainer.mockReset();
    getProtoStorageContainer.mockReturnValue(null);
    getProtoControllerLinkContainer.mockReset();
    getProtoControllerLinkContainer.mockReturnValue(null);
    (Game as Game & { powerCreeps: Record<string, PowerCreep> }).powerCreeps = {};
    resetPowerCreepControlCacheForTest();
    clearSpawnActiveCacheForTest();
  });

  it("按技能动态跳过 Spawn，但 PC 未接管时保留 Extension 回退", () => {
    const roomName = "W2N2";
    const spawn = {
      id: "dynamic-spawn",
      structureType: STRUCTURE_SPAWN,
      pos: createPos(3, roomName),
      store: createStore(0, 300),
    } as unknown as StructureSpawn;
    const extension = {
      id: "dynamic-extension",
      structureType: STRUCTURE_EXTENSION,
      pos: createPos(4, roomName),
      store: createStore(0, 50),
    } as unknown as StructureExtension;
    const powerSpawn = {
      id: "dynamic-power-spawn",
      structureType: STRUCTURE_POWER_SPAWN,
      pos: createPos(2, roomName),
      store: createStore(0, 5_000),
    } as unknown as StructurePowerSpawn;
    const controller = {
      my: true,
      level: 8,
      isPowerEnabled: false,
    } as StructureController;
    const room = createRoom({
      name: roomName,
      controller,
      myStructures: [
        spawn as unknown as Structure<StructureConstant>,
        extension as unknown as Structure<StructureConstant>,
        powerSpawn as unknown as Structure<StructureConstant>,
      ],
    });
    Game.rooms[room.name] = room;
    const powerCreep = {
      name: "not-hardcoded",
      memory: { homeRoom: room.name },
      powers: {
        [PWR_OPERATE_EXTENSION]: { level: 1, cooldown: 0 },
      },
    } as unknown as PowerCreep;
    (Game as Game & { powerCreeps: Record<string, PowerCreep> }).powerCreeps = {
      [powerCreep.name]: powerCreep,
    };

    expect(getEnergyStoreTarget(createCreep(room))?.id).toBe(extension.id);
  });

  it("PC 已接管后同时跳过 Spawn、Extension 和普通 PowerSpawn 供能", () => {
    const roomName = "W3N3";
    const spawn = {
      id: "controlled-spawn",
      structureType: STRUCTURE_SPAWN,
      pos: createPos(3, roomName),
      store: createStore(0, 300),
    } as unknown as StructureSpawn;
    const extension = {
      id: "controlled-extension",
      structureType: STRUCTURE_EXTENSION,
      pos: createPos(4, roomName),
      store: createStore(0, 50),
    } as unknown as StructureExtension;
    const powerSpawn = {
      id: "controlled-power-spawn",
      structureType: STRUCTURE_POWER_SPAWN,
      pos: createPos(2, roomName),
      store: createStore(0, 5_000),
    } as unknown as StructurePowerSpawn;
    const storage = {
      id: "controlled-storage",
      structureType: STRUCTURE_STORAGE,
      pos: createPos(10, roomName),
      store: createStore(100_000, 1_000_000),
    } as unknown as StructureStorage;
    const controller = {
      my: true,
      level: 8,
      isPowerEnabled: true,
    } as StructureController;
    const room = createRoom({
      name: roomName,
      controller,
      storage,
      myStructures: [
        spawn as unknown as Structure<StructureConstant>,
        extension as unknown as Structure<StructureConstant>,
        powerSpawn as unknown as Structure<StructureConstant>,
      ],
    });
    Game.rooms[room.name] = room;
    const powerCreep = {
      name: "healthy-controller",
      memory: { homeRoom: room.name, lastControlTick: Game.time },
      room,
      ticksToLive: 1_000,
      powers: {
        [PWR_OPERATE_EXTENSION]: { level: 1, cooldown: 0 },
      },
    } as unknown as PowerCreep;
    (Game as Game & { powerCreeps: Record<string, PowerCreep> }).powerCreeps = {
      [powerCreep.name]: powerCreep,
    };

    expect(getEnergyStoreTarget(createCreep(room))?.id).toBe(storage.id);
  });
});
