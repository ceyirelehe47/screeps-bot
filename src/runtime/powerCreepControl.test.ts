jest.mock("@/movement/pathing", () => ({
  moveToTarget: jest.fn((powerCreep: PowerCreep, target: RoomObject, range: number) =>
    powerCreep.moveTo(target, { reusePath: 5, range }),
  ),
}));

import {
  getPowerCreepRoomEnergyPolicy,
  enqueuePowerCreepTask,
  listPowerCreepTasks,
  resetPowerCreepControlCacheForTest,
  runPowerCreepControl,
} from "@/runtime/powerCreepControl";
import { clearCreepMovementStateForTest, ensureCreepMovementState } from "@/movement/creepState";

type ResourceAmounts = Partial<Record<ResourceConstant, number>>;

function createStore(
  amounts: ResourceAmounts = {},
  capacities: ResourceAmounts = {},
  totalCapacity = 100,
): StoreDefinition {
  return {
    getUsedCapacity(resource?: ResourceConstant) {
      if (resource !== undefined) return amounts[resource] || 0;
      return Object.values(amounts).reduce((sum, amount) => sum + (amount || 0), 0);
    },
    getCapacity(resource?: ResourceConstant) {
      if (resource !== undefined && capacities[resource] !== undefined) return capacities[resource] || 0;
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
  } as StoreDefinition;
}

function createPos(roomName: string, x: number, range = 1): RoomPosition {
  return { x, y: 25, roomName, getRangeTo: () => range } as unknown as RoomPosition;
}

function createRoom(options: {
  name?: string;
  controllerPowerEnabled?: boolean;
  storage?: StructureStorage | null;
  extensions?: StructureExtension[];
  sources?: Source[];
} = {}): { room: Room; controller: StructureController; powerSpawn: StructurePowerSpawn } {
  const name = options.name || "E4N58";
  const controller = {
    id: `${name}-controller`,
    my: true,
    level: 8,
    isPowerEnabled: options.controllerPowerEnabled ?? true,
    pos: createPos(name, 20),
  } as unknown as StructureController;
  const powerSpawn = {
    id: `${name}-power-spawn`,
    structureType: STRUCTURE_POWER_SPAWN,
    my: true,
    pos: createPos(name, 21),
    store: createStore({}, { [RESOURCE_ENERGY]: 5_000, [RESOURCE_POWER]: 100 }, 5_100),
  } as unknown as StructurePowerSpawn;
  const extensions = options.extensions || [];
  const sources = options.sources || [];
  const myStructures: Structure<StructureConstant>[] = [
    powerSpawn as unknown as Structure<StructureConstant>,
    ...extensions as unknown as Structure<StructureConstant>[],
  ];
  const structures: Structure<StructureConstant>[] = [
    ...myStructures,
    ...(options.storage ? [options.storage as unknown as Structure<StructureConstant>] : []),
  ];
  const room = {
    name,
    controller,
    storage: options.storage || null,
    terminal: null,
    find(type: FindConstant) {
      if (type === FIND_MY_STRUCTURES) return myStructures;
      if (type === FIND_STRUCTURES) return structures;
      if (type === FIND_SOURCES) return sources;
      return [];
    },
  } as unknown as Room;
  Game.rooms[name] = room;
  return { room, controller, powerSpawn };
}

function createStorage(roomName = "E4N58", options: {
  energy?: number;
  ops?: number;
  effects?: RoomObjectEffect[];
} = {}): StructureStorage {
  return {
    id: `${roomName}-storage`,
    structureType: STRUCTURE_STORAGE,
    pos: createPos(roomName, 22),
    effects: options.effects || [],
    store: createStore({
      [RESOURCE_ENERGY]: options.energy || 0,
      [RESOURCE_OPS]: options.ops || 0,
    }, {}, 1_000_000),
  } as unknown as StructureStorage;
}

function createSource(roomName: string, id: string, x: number): Source {
  return { id, pos: createPos(roomName, x), effects: [] } as unknown as Source;
}

function createPowerEffect(power: PowerConstant, level: number, ticksRemaining = 50): RoomObjectEffect {
  return { effect: power, power, level, ticksRemaining } as RoomObjectEffect;
}

function createPowerCreep(options: {
  name?: string;
  room?: Room;
  ticksToLive?: number | null;
  ops?: number;
  capacity?: number;
  powers?: Partial<Record<PowerConstant, { level: number; cooldown: number }>>;
  usePowerResult?: ScreepsReturnCode;
  enableRoomResult?: ScreepsReturnCode;
  renewResult?: ScreepsReturnCode;
  rangeToTarget?: number;
} = {}): PowerCreep {
  return {
    name: options.name || "E4N58",
    memory: {},
    room: options.room,
    pos: createPos(
      options.room?.name || options.name || "E4N58",
      10,
      options.rangeToTarget ?? 1,
    ),
    ticksToLive: options.ticksToLive,
    powers: options.powers || {},
    store: createStore({ [RESOURCE_OPS]: options.ops || 0 }, {}, options.capacity || 100),
    spawn: jest.fn(() => OK),
    enableRoom: jest.fn(() => options.enableRoomResult ?? OK),
    renew: jest.fn(() => options.renewResult ?? OK),
    transfer: jest.fn(() => OK),
    withdraw: jest.fn(() => OK),
    usePower: jest.fn(() => options.usePowerResult ?? OK),
    moveTo: jest.fn(() => OK),
  } as unknown as PowerCreep;
}

function installGameObjects(objects: Array<{ id: string }>): void {
  const byId = new Map(objects.map((object) => [object.id, object]));
  (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn(
    (id: string) => byId.get(id) || null,
  ) as unknown as Game["getObjectById"];
}

function installPowerCreeps(...powerCreeps: PowerCreep[]): void {
  (Game as Game & { powerCreeps: Record<string, PowerCreep> }).powerCreeps = Object.fromEntries(
    powerCreeps.map((powerCreep) => [powerCreep.name, powerCreep]),
  );
  (Game as Game & { shard: Shard }).shard = { name: "shard1", type: "normal", ptr: false };
}

describe("powerCreepControl", () => {
  beforeEach(() => {
    resetPowerCreepControlCacheForTest();
    clearCreepMovementStateForTest();
    Memory.powerCreeps = {};
  });

  it("ops 耗尽或冷却时恢复普通供能，并从库存补充 ops", () => {
    const storage = createStorage("E4N58", { energy: 100000, ops: 500 });
    const { room, powerSpawn } = createRoom({ storage });
    const pc = createPowerCreep({ room, ticksToLive: 1000, ops: 0, powers: {
      [PWR_OPERATE_EXTENSION]: { level: 1, cooldown: 0 }, [PWR_OPERATE_STORAGE]: { level: 1, cooldown: 0 },
    } });
    installGameObjects([storage, powerSpawn]); installPowerCreeps(pc);
    pc.memory.lastControlTick = Game.time;
    expect(getPowerCreepRoomEnergyPolicy(room.name).suppressExtensionSupply).toBe(false);
    expect(getPowerCreepRoomEnergyPolicy(room.name).suppressSpawnSupply).toBe(false);
    runPowerCreepControl();
    expect(pc.withdraw).toHaveBeenCalledWith(storage, RESOURCE_OPS, expect.any(Number));
    expect(pc.usePower).not.toHaveBeenCalled();
  });
  it("未完成的等级配方自动调度 OPERATE_FACTORY，已有足够时长的效果不重放", () => {
    const storage = createStorage("E4N58", { energy: 100000 });
    const { room, powerSpawn } = createRoom({ storage });
    const factory = { id: "factory", structureType: STRUCTURE_FACTORY, level: 1,
      store: createStore(), effects: [], pos: createPos(room.name, 24) } as unknown as StructureFactory;
    const previousFind = room.find;
    room.find = ((kind: FindConstant) => kind === FIND_MY_STRUCTURES ? [...previousFind.call(room, kind), factory] : previousFind.call(room, kind)) as Room["find"];
    Memory.cfg = { factoryControl: { enabled: true, targets: [{ resource: RESOURCE_COMPOSITE, targetAmount: 100 }] } };
    const pc = createPowerCreep({ room, ticksToLive: 1000, ops: 120, capacity: 300,
      powers: { [PWR_OPERATE_FACTORY]: { level: 1, cooldown: 0 } } });
    installGameObjects([storage, powerSpawn, factory]); installPowerCreeps(pc);
    runPowerCreepControl();
    expect(pc.usePower).toHaveBeenCalledWith(PWR_OPERATE_FACTORY, factory);
    jest.mocked(pc.usePower).mockClear(); Game.time++;
    factory.effects = [createPowerEffect(PWR_OPERATE_FACTORY, 1, 200)];
    runPowerCreepControl();
    expect(pc.usePower).not.toHaveBeenCalled();
  });
  it("从同名 PowerSpawn 出生，并跨 tick 去重 enable_room 直至房间启用", () => {
    const { room, controller, powerSpawn } = createRoom({
      name: "E6N59",
      controllerPowerEnabled: false,
    });
    const powerCreep = createPowerCreep({
      name: room.name,
      ticksToLive: null,
      enableRoomResult: ERR_NOT_IN_RANGE,
      rangeToTarget: 5,
    });
    installPowerCreeps(powerCreep);
    installGameObjects([controller, powerSpawn]);

    runPowerCreepControl();
    expect(powerCreep.memory.homeRoom).toBe(room.name);
    expect(powerCreep.spawn).toHaveBeenCalledWith(powerSpawn);

    Object.assign(powerCreep, { room, ticksToLive: 1_000 });
    Game.time += 1;
    runPowerCreepControl();
    expect(powerCreep.enableRoom).toHaveBeenCalledWith(controller);
    expect(powerCreep.moveTo).toHaveBeenCalledWith(controller, { reusePath: 5, range: 1 });
    expect(listPowerCreepTasks(powerCreep)).toEqual([
      expect.objectContaining({ type: "enable_room", targetId: controller.id }),
    ]);

    Game.time += 1;
    runPowerCreepControl();
    expect(listPowerCreepTasks(powerCreep)).toHaveLength(1);

    (controller as StructureController & { isPowerEnabled: boolean }).isPowerEnabled = true;
    Game.time += 1;
    runPowerCreepControl();
    expect(listPowerCreepTasks(powerCreep)).toHaveLength(0);
  });

  it("区分 NaN 未出生态、有限寿命无位置态，并拒绝回退到非同名房间", () => {
    const { room: fallbackRoom, powerSpawn: fallbackPowerSpawn } = createRoom({ name: "E4N58" });
    const { powerSpawn: finitePowerSpawn } = createRoom({ name: "E6N59" });
    const { powerSpawn: nanPowerSpawn } = createRoom({ name: "E7N59" });
    Game.rooms.W1N57 = {
      name: "W1N57",
      controller: { my: true, isPowerEnabled: false },
      find: jest.fn(() => []),
    } as unknown as Room;

    const wrongRoom = createPowerCreep({ name: "W1N57", room: fallbackRoom, ticksToLive: null });
    const finiteNoPosition = createPowerCreep({ name: "E6N59", ticksToLive: 1_000 });
    const nanUnspawned = createPowerCreep({ name: "E7N59", ticksToLive: Number.NaN });
    Object.assign(finiteNoPosition, { shard: null, spawnCooldownTime: null, room: null, pos: undefined });
    Object.assign(nanUnspawned, { shard: null, spawnCooldownTime: null, room: null, pos: undefined });
    installPowerCreeps(wrongRoom, finiteNoPosition, nanUnspawned);
    installGameObjects([fallbackPowerSpawn, finitePowerSpawn, nanPowerSpawn]);

    runPowerCreepControl();

    expect(wrongRoom.memory.homeRoom).toBeUndefined();
    expect(wrongRoom.spawn).not.toHaveBeenCalled();
    expect(wrongRoom.enableRoom).not.toHaveBeenCalled();
    expect(getPowerCreepRoomEnergyPolicy("W1N57")).toEqual({
      suppressSpawnSupply: false,
      suppressExtensionSupply: false,
      managePowerSpawnSupply: false,
    });
    expect(finiteNoPosition.spawn).not.toHaveBeenCalled();
    expect(finiteNoPosition.memory.lastControlTick).toBeUndefined();
    expect(nanUnspawned.spawn).toHaveBeenCalledWith(nanPowerSpawn);
    expect(nanUnspawned.memory.lastControlTick).toBeUndefined();
  });

  it("缺 OPS 时产 OPS，低寿命下一 tick 续命并使用空闲技能槽产 OPS", () => {
    const storage = createStorage();
    const { room, powerSpawn } = createRoom({ storage });
    const powerCreep = createPowerCreep({
      room,
      ticksToLive: 1_000,
      powers: {
        [PWR_OPERATE_STORAGE]: { level: 5, cooldown: 0 },
        [PWR_GENERATE_OPS]: { level: 5, cooldown: 0 },
      },
    });
    installPowerCreeps(powerCreep);
    installGameObjects([storage, powerSpawn]);

    runPowerCreepControl();
    expect(powerCreep.usePower).toHaveBeenCalledWith(PWR_GENERATE_OPS);
    expect(listPowerCreepTasks(powerCreep).map((task) => task.type)).toEqual(["operate_storage"]);

    (powerCreep as PowerCreep & { ticksToLive: number }).ticksToLive = 199;
    Game.time += 1;
    runPowerCreepControl();
    expect(powerCreep.renew).toHaveBeenCalledWith(powerSpawn);
    expect(powerCreep.usePower).toHaveBeenCalledTimes(2);
    expect(powerCreep.usePower).toHaveBeenLastCalledWith(PWR_GENERATE_OPS);
  });

  it("高优先级技能赶路时顺带产 OPS，保留路径与工作锚点，且不覆盖成功的技能", () => {
    const storage = createStorage("E4N58", { energy: 100000 });
    const { room, powerSpawn } = createRoom({ storage });
    const pc = createPowerCreep({ room, ticksToLive: 1000, ops: 150, capacity: 300, rangeToTarget: 5,
      powers: { [PWR_OPERATE_STORAGE]: { level: 5, cooldown: 0 }, [PWR_GENERATE_OPS]: { level: 5, cooldown: 0 } } });
    installGameObjects([storage, powerSpawn]); installPowerCreeps(pc);
    const path = { targetRoom: room.name } as NonNullable<ReturnType<typeof ensureCreepMovementState>["movePathState"]>;
    ensureCreepMovementState(pc).movePathState = path;
    jest.mocked(pc.usePower).mockImplementation(power => power === PWR_GENERATE_OPS ? OK : ERR_NOT_IN_RANGE);
    runPowerCreepControl();
    expect(pc.moveTo).toHaveBeenCalledWith(storage, { reusePath: 5, range: 3 });
    expect(pc.usePower).toHaveBeenLastCalledWith(PWR_GENERATE_OPS);
    expect(ensureCreepMovementState(pc).movePathState).toBe(path);
    expect(ensureCreepMovementState(pc).workAnchor).toMatchObject({ range: 3 });
    expect(pc.memory.tasks).toEqual([expect.objectContaining({ type: "operate_storage" })]);

    jest.mocked(pc.usePower).mockClear().mockReturnValue(OK);
    Game.time++;
    runPowerCreepControl();
    expect(pc.usePower).toHaveBeenCalledTimes(1);
    expect(pc.usePower).toHaveBeenCalledWith(PWR_OPERATE_STORAGE, storage);
  });

  it.each([{ cooldown: 1, ops: 0 }, { cooldown: 0, ops: 100 }])("产 OPS 冷却或背包已满时不提交技能 %j", ({ cooldown, ops }) => {
    const { room, powerSpawn } = createRoom();
    const pc = createPowerCreep({ room, ticksToLive: 1000, ops, powers: { [PWR_GENERATE_OPS]: { level: 5, cooldown } } });
    installGameObjects([powerSpawn]); installPowerCreeps(pc);
    runPowerCreepControl();
    expect(pc.usePower).not.toHaveBeenCalled();
  });

  it("Storage 与 Regen 同时就绪时按优先级跨 tick 执行并轮换 Source", () => {
    const roomName = "E4N58";
    const storage = createStorage(roomName, {
      effects: [createPowerEffect(PWR_OPERATE_STORAGE, 5)],
    });
    const sourceA = createSource(roomName, "source-a", 10);
    const sourceB = createSource(roomName, "source-b", 40);
    (sourceA as Source & { effects: RoomObjectEffect[] }).effects = [
      createPowerEffect(PWR_REGEN_SOURCE, 4),
    ];
    const { room, powerSpawn } = createRoom({ storage, sources: [sourceB, sourceA] });
    const storagePower = { level: 5, cooldown: 0 };
    const powerCreep = createPowerCreep({
      room,
      ticksToLive: 1_000,
      ops: 100,
      capacity: 200,
      powers: {
        [PWR_OPERATE_STORAGE]: storagePower,
        [PWR_REGEN_SOURCE]: { level: 4, cooldown: 0 },
      },
    });
    installPowerCreeps(powerCreep);
    installGameObjects([storage, sourceA, sourceB, powerSpawn]);

    runPowerCreepControl();
    expect(powerCreep.usePower).toHaveBeenNthCalledWith(1, PWR_OPERATE_STORAGE, storage);
    expect(listPowerCreepTasks(powerCreep)).toEqual([
      expect.objectContaining({ type: "regen_source", targetId: sourceA.id }),
    ]);

    storagePower.cooldown = 200;
    Game.time += 1;
    runPowerCreepControl();
    expect(powerCreep.usePower).toHaveBeenNthCalledWith(2, PWR_REGEN_SOURCE, sourceA);
    expect(powerCreep.memory.nextRegenSourceIndex).toBe(1);
  });
});


it.each([
  { enabled: true, level: 1, expected: true },
  { enabled: undefined, level: 1, expected: false },
  { enabled: true, level: 0, expected: false },
  { enabled: true, level: 2, expected: false },
])("工厂能力遵守 targetQueue 和永久定级边界 %j", ({ enabled, level, expected }) => {
  const storage = createStorage("E4N58", { energy: 100000 });
  const { room, powerSpawn } = createRoom({ storage });
  const factory = { id: "factory-normalized", structureType: STRUCTURE_FACTORY, level,
    store: createStore(), effects: [], pos: createPos(room.name, 24) } as unknown as StructureFactory;
  const previousFind = room.find;
  room.find = ((kind: FindConstant) => kind === FIND_MY_STRUCTURES ? [...previousFind.call(room, kind), factory] : previousFind.call(room, kind)) as Room["find"];
  Memory.cfg = { factoryControl: { enabled, targetQueue: [RESOURCE_COMPOSITE],
    targets: [{ resource: expected ? RESOURCE_CRYSTAL : RESOURCE_COMPOSITE, targetAmount: 100 }] } }; Memory.runtime = {};
  const pc = createPowerCreep({ room, ticksToLive: 1000, ops: 120, capacity: 300,
    powers: { [PWR_OPERATE_FACTORY]: { level: 1, cooldown: 0 } } });
  installGameObjects([storage, powerSpawn, factory]); installPowerCreeps(pc);
  runPowerCreepControl();
  if (expected) {
    expect(pc.usePower).toHaveBeenCalledWith(PWR_OPERATE_FACTORY, factory);
    jest.mocked(pc.usePower).mockClear(); Game.time++;
    Memory.cfg!.factoryControl!.enabled = false;
    enqueuePowerCreepTask(pc, "operate_factory", factory.id);
    runPowerCreepControl(); expect(pc.usePower).not.toHaveBeenCalled();
  } else expect(pc.usePower).not.toHaveBeenCalled();
});
