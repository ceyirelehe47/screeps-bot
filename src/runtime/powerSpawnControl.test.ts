import {
  clearCarrierTaskBoardForTest,
  listCarrierTasksByRoom,
} from "@/runtime/carrierTaskBoard";
import {
  POWER_SPAWN_HIGH_WATER_RATIO,
  runPowerSpawnControl,
} from "@/runtime/powerSpawnControl";

type MutableStore = StoreDefinition & {
  set(resource: ResourceConstant, amount: number): void;
};

function createMutableStore(
  initial: Partial<Record<ResourceConstant, number>>,
  capacities: Partial<Record<ResourceConstant, number>>,
  totalCapacity: number,
): MutableStore {
  const amounts = { ...initial };
  return {
    set(resource: ResourceConstant, amount: number) {
      amounts[resource] = amount;
    },
    getUsedCapacity(resource?: ResourceConstant) {
      if (resource !== undefined) return amounts[resource] || 0;
      return Object.values(amounts).reduce((sum, amount) => sum + (amount || 0), 0);
    },
    getCapacity(resource?: ResourceConstant) {
      if (resource !== undefined && capacities[resource] !== undefined) {
        return capacities[resource] || 0;
      }
      return totalCapacity;
    },
    getFreeCapacity(resource?: ResourceConstant) {
      const capacity = resource !== undefined && capacities[resource] !== undefined
        ? capacities[resource] || 0
        : totalCapacity;
      const used = resource !== undefined
        ? amounts[resource] || 0
        : Object.values(amounts).reduce((sum, amount) => sum + (amount || 0), 0);
      return Math.max(0, capacity - used);
    },
  } as MutableStore;
}

function createScenario(options: {
  roomName?: string;
  power?: number;
  energy?: number;
  controllerMy?: boolean;
  includePowerSpawn?: boolean;
} = {}): {
  room: Room;
  powerSpawn: StructurePowerSpawn;
  powerSpawnStore: MutableStore;
  storage: StructureStorage;
  myStructures: Structure<StructureConstant>[];
} {
  const roomName = options.roomName || "E4N58";
  const powerSpawnStore = createMutableStore({
    [RESOURCE_POWER]: options.power || 0,
    [RESOURCE_ENERGY]: options.energy || 0,
  }, {
    [RESOURCE_POWER]: 100,
    [RESOURCE_ENERGY]: 5_000,
  }, 5_100);
  const powerSpawn = {
    id: `${roomName}-power-spawn`,
    structureType: STRUCTURE_POWER_SPAWN,
    store: powerSpawnStore,
    processPower: jest.fn(() => OK),
  } as unknown as StructurePowerSpawn;
  const storage = {
    id: `${roomName}-storage`,
    structureType: STRUCTURE_STORAGE,
    store: createMutableStore({
      [RESOURCE_POWER]: 1_000,
      [RESOURCE_ENERGY]: 500_000,
    }, {}, 1_000_000),
  } as unknown as StructureStorage;
  const myStructures = options.includePowerSpawn === false
    ? []
    : [powerSpawn as unknown as Structure<StructureConstant>];
  const room = {
    name: roomName,
    controller: { my: options.controllerMy ?? true, level: 8 },
    storage,
    terminal: null,
    find(type: FindConstant) {
      if (type === FIND_MY_STRUCTURES) {
        return myStructures;
      }
      return [];
    },
  } as unknown as Room;
  Game.rooms[roomName] = room;
  return { room, powerSpawn, powerSpawnStore, storage, myStructures };
}

describe("powerSpawnControl", () => {
  function resetScenarioState(): void {
    clearCarrierTaskBoardForTest();
    Game.rooms = {};
    Game.flags = {};
    Game.time = 100;
    Memory.cfg = {};
    (Game as Game & { powerCreeps: Record<string, PowerCreep> }).powerCreeps = {};
  }

  beforeEach(() => {
    resetScenarioState();
  });

  it("补能不得穿透 storage 的 energyFloor", () => {
    const { room, storage } = createScenario();
    (storage.store as MutableStore).set(RESOURCE_ENERGY, 120_123);
    runPowerSpawnControl();
    expect(listCarrierTasksByRoom(room.name)[0].steps.find(step => step.resource === RESOURCE_ENERGY)?.amount).toBe(123);
    (storage.store as MutableStore).set(RESOURCE_ENERGY, 120_000);
    Game.time += 1;
    runPowerSpawnControl();
    expect(listCarrierTasksByRoom(room.name)[0].steps.some(step => step.resource === RESOURCE_ENERGY)).toBe(false);
  });

  it("覆盖所有合格房间的专用补给、自动加工和多房并行", () => {
    const { room, powerSpawn, storage } = createScenario({ roomName: "E6N59" });

    runPowerSpawnControl();

    const tasks = listCarrierTasksByRoom(room.name);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].type).toBe("power_spawn_supply");
    expect(tasks[0].steps).toEqual([
      expect.objectContaining({
        resource: RESOURCE_POWER,
        fromKind: "storage",
        toKind: "power_spawn",
        fromId: storage.id,
        toId: powerSpawn.id,
      }),
      expect.objectContaining({
        resource: RESOURCE_ENERGY,
        fromKind: "storage",
        toKind: "power_spawn",
        fromId: storage.id,
        toId: powerSpawn.id,
      }),
    ]);
    expect(powerSpawn.processPower).not.toHaveBeenCalled();

    resetScenarioState();
    const hub = createScenario({ roomName: "E4N58", power: 1, energy: 50 });
    const nonHub = createScenario({ roomName: "E6N59", power: 1, energy: 50 });

    runPowerSpawnControl();

    expect(hub.powerSpawn.processPower).toHaveBeenCalledTimes(1);
    expect(nonHub.powerSpawn.processPower).toHaveBeenCalledTimes(1);
    expect(listCarrierTasksByRoom(hub.room.name)).toHaveLength(1);
    expect(listCarrierTasksByRoom(nonHub.room.name)).toHaveLength(1);

    resetScenarioState();
    const legacyDisabled = createScenario({ roomName: "E5N59", power: 1, energy: 50 });
    (Memory as unknown as { cfg: Record<string, unknown> }).cfg = {
      powerSpawnControl: { rooms: { [legacyDisabled.room.name]: { enabled: false } } },
    };

    runPowerSpawnControl();

    expect(legacyDisabled.powerSpawn.processPower).toHaveBeenCalledTimes(1);
    expect(listCarrierTasksByRoom(legacyDisabled.room.name)).toHaveLength(1);

    resetScenarioState();
    const foreign = createScenario({
      roomName: "W2N2",
      power: 100,
      energy: 5_000,
      controllerMy: false,
    });

    runPowerSpawnControl();

    expect(foreign.powerSpawn.processPower).not.toHaveBeenCalled();
    expect(listCarrierTasksByRoom(foreign.room.name)).toHaveLength(0);
  });

  it("跨滞回、储备切换和结构消失收敛加工补给生命周期", () => {
    const hysteresis = createScenario({ roomName: "E5N59" });

    runPowerSpawnControl();
    expect(listCarrierTasksByRoom(hysteresis.room.name)[0].steps).toHaveLength(2);

    Game.time += 1;
    hysteresis.powerSpawnStore.set(RESOURCE_POWER, 50);
    hysteresis.powerSpawnStore.set(RESOURCE_ENERGY, 2_500);
    runPowerSpawnControl();
    expect(listCarrierTasksByRoom(hysteresis.room.name)[0].steps).toHaveLength(2);

    Game.time += 1;
    hysteresis.powerSpawnStore.set(RESOURCE_POWER, Math.ceil(100 * POWER_SPAWN_HIGH_WATER_RATIO));
    hysteresis.powerSpawnStore.set(RESOURCE_ENERGY, Math.ceil(5_000 * POWER_SPAWN_HIGH_WATER_RATIO));
    runPowerSpawnControl();
    expect(listCarrierTasksByRoom(hysteresis.room.name)).toHaveLength(0);

    resetScenarioState();
    const reserved = createScenario({ roomName: "E6N59", power: 1, energy: 50 });

    runPowerSpawnControl();
    expect(reserved.powerSpawn.processPower).toHaveBeenCalledTimes(1);
    expect(listCarrierTasksByRoom(reserved.room.name)).toHaveLength(1);

    Game.flags[`RESERVE_${reserved.room.name}`] = {
      name: `RESERVE_${reserved.room.name}`,
      pos: { roomName: reserved.room.name },
    } as unknown as Flag;
    Game.time += 1;

    runPowerSpawnControl();

    expect(reserved.powerSpawn.processPower).toHaveBeenCalledTimes(1);
    expect(listCarrierTasksByRoom(reserved.room.name)).toHaveLength(0);

    resetScenarioState();
    const removed = createScenario({ roomName: "E6N59" });
    runPowerSpawnControl();
    expect(listCarrierTasksByRoom(removed.room.name)).toHaveLength(1);

    removed.myStructures.length = 0;
    Game.time += 1;
    runPowerSpawnControl();

    expect(listCarrierTasksByRoom(removed.room.name)).toHaveLength(0);
  });
});
