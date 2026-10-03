import { runFlagHaulingByFlag } from "@/runtime/flagHauling";
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
    expect(Object.keys(getCreepConfigService().list())).toHaveLength(3);
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

  it("INVADER 四 Keeper 逐只覆盖取货位，必须有近距本方战斗 escort", () => {
    const world = salvageFixture();
    world.objects.hostiles.push(...[10, 20, 30, 40].map((x) => ({ owner: { username: "Source Keeper" },
      pos: position(x, 10) } as Creep)));
    const drop = { amount: 50, resourceType: RESOURCE_ENERGY, pos: position(44, 16) } as Resource;
    world.objects.drops.push(drop);
    runFlagHaulingByFlag();
    expect(getCreepConfigService().list()).toEqual({});
    const escort = { pos: drop.pos, getActiveBodyparts: (part: BodyPartConstant) => part === ATTACK ? 25 : 0 } as Creep;
    world.objects.escorts.push(escort);
    Game.time += 1;
    runFlagHaulingByFlag();
    expect(getCreepConfigService().get(world.configName)?.roomName).toBe("W1N1");
    for (const keeper of world.objects.hostiles) {
      Object.assign(drop, { pos: position(keeper.pos.x + 5, keeper.pos.y + 5) });
      Object.assign(escort, { pos: drop.pos });
      Game.time += 1;
      runFlagHaulingByFlag();
      expect(getCreepConfigService().get(world.configName)?.roomName).toBeUndefined();
      expect(world.flag.remove).not.toHaveBeenCalled();
    }
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
