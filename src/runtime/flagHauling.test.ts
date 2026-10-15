import { runFlagHaulingByFlag, ensureClearedNpcLootHandoff } from "@/runtime/flagHauling";
import { getCreepConfigService } from "@/runtime/runtimeServices";
import { requestCombatObservation } from "@/runtime/powerBankObserver";

jest.mock("@/runtime/powerBankObserver", () => ({ requestCombatObservation: jest.fn(() => true) }));

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createRoom(name: string): Room {
  const room = {
    name,
    controller: { my: true, level: 6 } as StructureController,
    energyCapacityAvailable: 1600,
    find: () => [],
  } as unknown as Room;
  Game.rooms[name] = room;
  return room;
}

function createSpawn(room: Room): StructureSpawn {
  const spawn = {
    name: `${room.name}-spawn`,
    room,
    memory: {},
    isActive: () => true,
  } as unknown as StructureSpawn;
  Game.spawns[spawn.name] = spawn;
  return spawn;
}

function createFlag(name: string, roomName: string): Flag {
  return {
    name,
    pos: { x: 25, y: 25, roomName } as RoomPosition,
    remove: jest.fn(() => OK),
  } as unknown as Flag;
}

function createStoredStructure(
  id: string,
  structureType: StructureConstant,
  resources: Partial<Record<ResourceConstant, number>>,
): AnyStoreStructure {
  return {
    id,
    structureType,
    store: {
      ...resources,
      getUsedCapacity: (resource?: ResourceConstant) => {
        if (resource === undefined) {
          return Object.values(resources).reduce((sum, amount) => sum + (amount || 0), 0);
        }

        return resources[resource] || 0;
      },
    },
  } as unknown as AnyStoreStructure;
}

function createRemoteCarrierCreep(configName: string, carriedAmount: number): Creep {
  return {
    name: `remote-carrier-${carriedAmount}`,
    memory: {
      role: "remoteCarrier",
      roleArgs: ["W5N5", "25", "25"],
      configName,
    },
    room: { name: carriedAmount > 0 ? "W5N5" : "W1N1" } as Room,
    store: {
      getUsedCapacity: () => carriedAmount,
    },
  } as unknown as Creep;
}

describe("runFlagHaulingByFlag", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetRuntimeServices();
    Game.time += 1;
    Game.flags = {};
    Game.rooms = {};
    Game.spawns = {};
    Game.creeps = {};
    Memory.data = {};
    Memory.creeps = {};
    Memory.runtime = undefined;
    (Game as Game & { map: GameMap }).map = {
      getRoomLinearDistance: (left: string, right: string) => (left === right ? 0 : 10),
    } as GameMap;
  });

  function salvageFixture() {
    const home = createRoom("W1N1");
    const spawn = createSpawn(home);
    const objects = { structures: [] as Structure[], ruins: [] as Ruin[], tombstones: [] as Tombstone[],
      drops: [] as Resource[], hostiles: [] as Creep[], escorts: [] as Creep[] };
    objects.ruins.push({ structure: { structureType: STRUCTURE_INVADER_CORE }, pos: position(44, 17),
      store: createStoredStructure("empty-core-proof", STRUCTURE_CONTAINER, {}).store } as Ruin);
    const target = {
      name: "W5N5", controller: undefined,
      find: jest.fn((type: FindConstant) => type === FIND_STRUCTURES ? objects.structures
        : type === FIND_RUINS ? objects.ruins : type === FIND_TOMBSTONES ? objects.tombstones
          : type === FIND_DROPPED_RESOURCES ? objects.drops : type === FIND_HOSTILE_CREEPS ? objects.hostiles
            : type === FIND_MY_CREEPS ? objects.escorts : []),
    } as unknown as Room;
    Game.rooms[target.name] = target;
    const flag = createFlag("HAUL_W1N1_INVADER_W5N5", target.name);
    Object.assign(flag.pos, { x: 44, y: 17 });
    Game.flags[flag.name] = flag;
    const configName = `W1N1:haul:W5N5:carrier:${flag.name}`;
    return { home, spawn, target, flag, configName, objects };
  }

  const position = (x: number, y: number): RoomPosition => ({ x, y, roomName: "W5N5",
    getRangeTo: (other: RoomPosition) => Math.max(Math.abs(x - other.x), Math.abs(y - other.y)),
  } as RoomPosition);

  it.each(["player", "ordinary_drops"] as const)("INVADER旗名不能授权%s的回收任务或生产", kind => {
    const world = salvageFixture();
    world.objects.drops.push({ amount: 1800, resourceType: RESOURCE_ENERGY, pos: position(44, 17) } as Resource);
    if (kind === "player") world.target.controller = { owner: { username: "TooAngel" } } as StructureController;
    else world.objects.ruins.length = 0;
    runFlagHaulingByFlag();
    expect(Memory.data?.flagHauling?.[world.flag.name]).toBeUndefined();
    expect(getCreepConfigService().list()).toEqual({});
    expect(world.flag.remove).toHaveBeenCalled();
  });

  it("既有非法玩家回收撤flag与孵化，空车回收，载货归仓后才删除配置和任务", () => {
    const world = salvageFixture();
    world.objects.drops.push({ amount: 1800, resourceType: RESOURCE_ENERGY, pos: position(44, 17) } as Resource);
    runFlagHaulingByFlag();
    const names = [world.configName, world.configName + ":2", world.configName + ":3"];
    const empty = createRemoteCarrierCreep(names[0], 0);
    const loaded = createRemoteCarrierCreep(names[1], 100);
    let cargo = 100;
    Object.assign(loaded, { store: { getUsedCapacity: () => cargo }, suicide: jest.fn() });
    Game.creeps = { [empty.name]: empty, [loaded.name]: loaded };
    const cancel = jest.fn(() => OK);
    Object.assign(world.spawn, { spawning: { name: "queued-invalid-salvage", cancel } });
    Memory.creeps!["queued-invalid-salvage"] = { configName: names[2] } as CreepMemory;
    world.spawn.memory.spawnList = [...names];
    world.target.controller = { owner: { username: "TooAngel" } } as StructureController;
    Game.time += 1; runFlagHaulingByFlag();
    expect(world.flag.remove).toHaveBeenCalled();
    expect(world.spawn.memory.spawnList).toEqual([]);
    expect(cancel).toHaveBeenCalled();
    expect(empty.memory._recycleToRoom).toBe(world.home.name);
    expect(empty.memory.configName).toBeUndefined();
    expect(loaded.memory.configName).toBe(names[1]);
    expect(loaded.memory.working).toBe(true);
    expect(getCreepConfigService().get(names[1])?.roomName).toBeUndefined();
    expect(loaded.suicide).not.toHaveBeenCalled();
    expect(Memory.data?.flagHauling?.[world.flag.name]).toBeDefined();
    delete Game.flags[world.flag.name];
    Object.assign(world.spawn, { spawning: null });
    cargo = 0;
    Game.time += 1; runFlagHaulingByFlag();
    expect(getCreepConfigService().list()).toEqual({});
    expect(Memory.data?.flagHauling?.[world.flag.name]).toBeUndefined();
    expect(loaded.memory._recycleToRoom).toBe(world.home.name);
  });

  it("小额 NPC 资源只派一只按货量配体型的 carrier，已有成员不预补出生", () => {
    const world = salvageFixture();
    world.objects.drops.push({ amount: 239, resourceType: RESOURCE_ENERGY, pos: position(44, 17) } as Resource);
    runFlagHaulingByFlag();
    const cfg = getCreepConfigService().get(world.configName)!;
    expect(cfg.body?.filter(p => p === CARRY)).toHaveLength(5);
    expect(cfg.body?.filter(p => p === MOVE)).toHaveLength(5);
    expect(cfg.spawnOnce).toEqual({});
    const actor = createRemoteCarrierCreep(world.configName, 0);
    Object.assign(actor, { name: "existing-hauler", ticksToLive: 900, pos: position(30, 30) });
    Game.creeps[actor.name] = actor;
    Game.time++; runFlagHaulingByFlag();
    expect(Object.keys(getCreepConfigService().list())).toEqual([world.configName]);
    expect(getCreepConfigService().get(world.configName)?.spawnOnce?.queuedAt).toBe(Game.time);
    Game.time++; runFlagHaulingByFlag();
    expect(getCreepConfigService().get(world.configName)?.spawnOnce?.queuedAt).toBe(Game.time - 1);
  });

  it("资源从三车份缩至一车时保留现役最近成员，空车退役，载货成员继续归仓", () => {
    const world = salvageFixture();
    const drop = { amount: 1800, resourceType: RESOURCE_ENERGY, pos: position(44, 17) } as Resource;
    world.objects.drops.push(drop);
    runFlagHaulingByFlag();
    expect(Object.keys(getCreepConfigService().list())).toHaveLength(3);
    const names = [world.configName, world.configName + ":2", world.configName + ":3"];
    const actors = names.map((name, i) => {
      const actor = createRemoteCarrierCreep(name, i === 2 ? 100 : 0);
      Object.assign(actor, { name: `member-${i}`, ticksToLive: 1000, pos: i === 1 ? position(30, 30) : { x: 10, y: 10, roomName: "W1N1" } });
      return actor;
    });
    Game.creeps = Object.fromEntries(actors.map(c => [c.name, c]));
    world.spawn.memory.spawnList = [...names];
    Object.assign(drop, { amount: 239 });
    Game.time++; runFlagHaulingByFlag();
    expect(getCreepConfigService().get(names[1])?.roomName).toBe("W1N1");
    expect(actors[1].memory.configName).toBe(names[1]);
    expect(actors[0].memory._recycleToRoom).toBe("W1N1");
    expect(actors[0].memory.configName).toBeUndefined();
    expect(actors[2].memory.working).toBe(true);
    expect(actors[2].memory.configName).toBe(names[2]);
    expect(getCreepConfigService().get(names[2])?.roomName).toBeUndefined();
    expect(world.spawn.memory.spawnList).toEqual([names[1]]);
  });

  it("已清空的 NPC 战争房间同帧衔接一车搬运，重复执行不创建第二个任务", () => {
    const world = salvageFixture();
    delete Game.flags[world.flag.name];
    world.objects.drops.push({ amount: 239, resourceType: RESOURCE_ENERGY, pos: position(44, 17) } as Resource);
    world.target.createFlag = jest.fn(() => world.flag.name) as Room["createFlag"];
    expect(ensureClearedNpcLootHandoff(world.home.name, world.target.name)).toBe(true);
    expect(Object.keys(getCreepConfigService().list())).toEqual([world.configName]);
    expect(Memory.data?.flagHauling?.[world.flag.name]?.createdAt).toBe(Game.time);
    expect(ensureClearedNpcLootHandoff(world.home.name, world.target.name)).toBe(true);
    expect(world.target.createFlag).toHaveBeenCalledTimes(1);
  });

  it("活跃 PowerBank 搬运和无生产能力的源房不额外发布 NPC 搬运者", () => {
    const world = salvageFixture();
    delete Game.flags[world.flag.name];
    world.objects.drops.push({ amount: 100, resourceType: RESOURCE_POWER, pos: position(44, 17) } as Resource);
    world.target.createFlag = jest.fn(() => world.flag.name) as Room["createFlag"];
    Memory.data!.powerBankHarvest = { bank: { targetRoom: world.target.name, status: "hauling" } as PowerBankHarvestTask };
    expect(ensureClearedNpcLootHandoff(world.home.name, world.target.name)).toBe(false);
    Memory.data!.powerBankHarvest = {};
    Object.assign(world.spawn, { isActive: () => false });
    Game.time++;
    expect(ensureClearedNpcLootHandoff(world.home.name, world.target.name)).toBe(false);
    expect(world.target.createFlag).not.toHaveBeenCalled();
  });

  it("危险位置的货量不放大派遣数量，但也不误判房间搬空", () => {
    const world = salvageFixture();
    world.objects.structures.push({ structureType: STRUCTURE_KEEPER_LAIR, pos: position(20, 20) } as StructureKeeperLair);
    world.objects.drops.push({ amount: 5000, resourceType: RESOURCE_ENERGY, pos: position(20, 20) } as Resource,
      { amount: 239, resourceType: RESOURCE_ENERGY, pos: position(44, 17) } as Resource);
    runFlagHaulingByFlag();
    expect(Object.keys(getCreepConfigService().list())).toHaveLength(1);
    Object.assign(world.objects.drops[1], { amount: 0 });
    Game.time++; runFlagHaulingByFlag();
    expect(world.flag.remove).not.toHaveBeenCalled();
    expect(Memory.data?.flagHauling?.[world.flag.name]?.emptyObservedAt).toBeUndefined();
  });

  it.each(["vision", "core", "tower", "combat"] as const)("INVADER %s 阻止新派遣，撤队列但保留返程货物", (threat) => {
    const world = salvageFixture();
    world.objects.drops.push({ amount: 1, resourceType: RESOURCE_ENERGY, pos: position(44, 17) } as Resource);
    runFlagHaulingByFlag();
    const carrier = createRemoteCarrierCreep(world.configName, 100);
    Object.assign(carrier, { suicide: jest.fn() });
    Game.creeps[carrier.name] = carrier;
    world.spawn.memory.spawnList = [world.configName];
    Game.time += 1;
    if (threat === "vision") delete Game.rooms[world.target.name];
    if (threat === "core") world.objects.structures.push({ structureType: STRUCTURE_INVADER_CORE } as Structure);
    if (threat === "tower") world.objects.structures.push({ structureType: STRUCTURE_TOWER, my: false } as unknown as Structure);
    if (threat === "combat") world.objects.hostiles.push({ owner: { username: "Invader" }, getActiveBodyparts: () => 1 } as unknown as Creep);
    runFlagHaulingByFlag();
    expect(requestCombatObservation).toHaveBeenCalledWith(world.target.name);
    expect(Object.values(getCreepConfigService().list()).every((config) => config.roomName === undefined)).toBe(true);
    expect(world.spawn.memory.spawnList).toEqual([]);
    expect(carrier.memory.working).toBe(true);
    expect(carrier.memory.configName).toBe(world.configName);
    expect(carrier.suicide).not.toHaveBeenCalled();
    expect(world.flag.remove).not.toHaveBeenCalled();
  });

  it("INVADER 掉落与墓碑的小额资源都保留 flag，并只生成专用第三参数", () => {
    const world = salvageFixture();
    world.objects.drops.push({ amount: 1, resourceType: RESOURCE_ENERGY, pos: position(44, 17) } as Resource);
    runFlagHaulingByFlag();
    expect(world.flag.remove).not.toHaveBeenCalled();
    expect(Object.keys(getCreepConfigService().list())).toHaveLength(1);
    expect(getCreepConfigService().get(world.configName)?.args).toEqual(["W5N5", "44,17", "invaderSalvage"]);
    Object.assign(world.objects.drops[0], { amount: 0 });
    const tombstone = createStoredStructure("tomb", STRUCTURE_CONTAINER, { [RESOURCE_UTRIUM]: 1 });
    Object.assign(tombstone, { pos: position(44, 17) });
    world.objects.tombstones.push(tombstone as unknown as Tombstone);
    Game.time += 1;
    runFlagHaulingByFlag();
    expect(world.flag.remove).not.toHaveBeenCalled();
    expect(getCreepConfigService().get(world.configName)?.roomName).toBe("W1N1");
  });

  it("INVADER 显式来源失去生产能力时不改派其它来源，避免旧货物配置失去管理", () => {
    const world = salvageFixture();
    world.objects.drops.push({ amount: 50, resourceType: RESOURCE_ENERGY, pos: position(44, 17) } as Resource);
    runFlagHaulingByFlag();
    createSpawn(createRoom("W2N1"));
    Object.assign(world.spawn, { isActive: () => false });
    Game.time += 1;
    runFlagHaulingByFlag();
    expect(Memory.data?.flagHauling?.[world.flag.name]?.sourceRoom).toBe("W1N1");
    expect(Object.keys(getCreepConfigService().list()).every((name) => name.startsWith("W1N1:"))).toBe(true);
  });

  it("INVADER 无 escort 的安全位仍派遣，四 Keeper 各自距离 5 都阻止取货", () => {
    const world = salvageFixture();
    world.objects.hostiles.push(...[10, 20, 30, 40].map((x) => ({ owner: { username: "Source Keeper" },
      pos: position(x, 10) } as Creep)));
    const drop = { amount: 50, resourceType: RESOURCE_ENERGY, pos: position(44, 16) } as Resource;
    world.objects.drops.push(drop);
    runFlagHaulingByFlag();
    expect(world.objects.escorts).toEqual([]);
    expect(Object.keys(getCreepConfigService().list())).toHaveLength(1);
    expect(getCreepConfigService().get(world.configName)?.roomName).toBe("W1N1");
    Game.time += 1;
    runFlagHaulingByFlag();
    expect(getCreepConfigService().get(world.configName)?.roomName).toBe("W1N1");
    for (const keeper of world.objects.hostiles) {
      Object.assign(drop, { pos: position(keeper.pos.x, keeper.pos.y + 5) });
      Game.time += 1;
      runFlagHaulingByFlag();
      expect(getCreepConfigService().get(world.configName)?.roomName).toBeUndefined();
      expect(world.flag.remove).not.toHaveBeenCalled();
    }
    Object.assign(drop, { pos: position(44, 16) });
    Game.time += 1;
    runFlagHaulingByFlag();
    expect(world.objects.escorts).toEqual([]);
    expect(getCreepConfigService().get(world.configName)?.roomName).toBe("W1N1");
    expect(world.flag.remove).not.toHaveBeenCalled();
  });

  it("INVADER 无当前 Keeper 仍逐只避开 KeeperLair，距离 5 拒绝而距离 6 无 escort 可派遣", () => {
    const world = salvageFixture();
    const lairs = [10, 20, 30, 40].map((x) => ({ structureType: STRUCTURE_KEEPER_LAIR,
      pos: position(x, 10) } as StructureKeeperLair));
    world.objects.structures.push(...lairs);
    const drop = { amount: 50, resourceType: RESOURCE_ENERGY, pos: position(40, 15) } as Resource;
    world.objects.drops.push(drop);
    runFlagHaulingByFlag();
    expect(world.objects.hostiles).toEqual([]);
    expect(world.objects.escorts).toEqual([]);
    expect(getCreepConfigService().list()).toEqual({});
    expect(world.flag.remove).not.toHaveBeenCalled();
    Object.assign(drop, { pos: position(44, 16) });
    Game.time += 1;
    runFlagHaulingByFlag();
    expect(Object.keys(getCreepConfigService().list())).toHaveLength(1);
    expect(getCreepConfigService().get(world.configName)?.roomName).toBe("W1N1");
    for (const lair of lairs) {
      Object.assign(drop, { pos: position(lair.pos.x, lair.pos.y + 5) });
      Game.time += 1;
      runFlagHaulingByFlag();
      expect(getCreepConfigService().get(world.configName)?.roomName).toBeUndefined();
      expect(world.flag.remove).not.toHaveBeenCalled();
    }
    Object.assign(drop, { pos: position(44, 16) });
    Game.time += 1;
    runFlagHaulingByFlag();
    expect(getCreepConfigService().get(world.configName)?.roomName).toBe("W1N1");
    expect(world.flag.remove).not.toHaveBeenCalled();
  });

  it("INVADER 必须跨 tick 再见空场且实际货物已归仓，才删除 flag/config", () => {
    const world = salvageFixture();
    const drop = { amount: 50, resourceType: RESOURCE_ENERGY, pos: position(44, 17) } as Resource;
    world.objects.drops.push(drop);
    runFlagHaulingByFlag();
    let carried = 50;
    const carrier = createRemoteCarrierCreep(world.configName, carried);
    Object.assign(carrier, { store: { getUsedCapacity: () => carried }, suicide: jest.fn() });
    Game.creeps[carrier.name] = carrier;
    Object.assign(drop, { amount: 0 });
    Game.time += 1;
    runFlagHaulingByFlag();
    runFlagHaulingByFlag();
    expect(world.flag.remove).not.toHaveBeenCalled();
    expect(getCreepConfigService().get(world.configName)).toBeDefined();
    expect(carrier.memory.working).toBe(true);
    Game.time += 1;
    runFlagHaulingByFlag();
    expect(world.flag.remove).not.toHaveBeenCalled();
    expect(carrier.suicide).not.toHaveBeenCalled();
    carried = 0;
    Game.time += 1;
    runFlagHaulingByFlag();
    expect(world.flag.remove).toHaveBeenCalledTimes(1);
    expect(getCreepConfigService().get(world.configName)).toBeUndefined();
  });

  it("removes the flag when only less-than-carrier-capacity energy remains", () => {
    const home = createRoom("W1N1");
    createSpawn(home);
    const target = {
      name: "W5N5",
      controller: undefined,
      find: jest.fn((type: FindConstant) => {
        if (type === FIND_STRUCTURES) {
          return [createStoredStructure("remote-container", STRUCTURE_CONTAINER, { [RESOURCE_ENERGY]: 799 })];
        }

        return [];
      }),
    } as unknown as Room;
    Game.rooms[target.name] = target;
    const flag = createFlag("HAUL", target.name);
    Game.flags.HAUL = flag;

    runFlagHaulingByFlag();

    expect(flag.remove).toHaveBeenCalledTimes(1);
    expect(getCreepConfigService().list()).toEqual({});
  });

  it("keeps cancelled configs while loaded carriers still need to return home", () => {
    const home = createRoom("W1N1");
    createSpawn(home);
    Game.flags.HAUL = createFlag("HAUL", "W5N5");
    runFlagHaulingByFlag();
    const configName = "W1N1:haul:W5N5:carrier:HAUL";
    const carrier = createRemoteCarrierCreep(configName, 800);
    Game.creeps = { [carrier.name]: carrier };
    Game.flags = {};
    Game.time += 1;

    runFlagHaulingByFlag();

    expect(getCreepConfigService().get(configName)).toMatchObject({
      role: "remoteCarrier",
      args: ["W5N5", "25", "25"],
    });
    expect(getCreepConfigService().get(configName)?.roomName).toBeUndefined();
    expect(carrier.memory.configName).toBe(configName);
    expect(Memory.data?.flagHauling?.HAUL).toBeDefined();
  });
});
