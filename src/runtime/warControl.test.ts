jest.mock("@/runtime/powerBankObserver", () => ({ ...jest.requireActual("@/runtime/powerBankObserver"), requestCombatObservation: jest.fn(() => true) }));

import { configureWarRebuildWatch, requestWarRoomClear, runWarControl, startWarRoom, stopWarRoom } from "@/runtime/warControl";
import * as combatBoosts from "@/runtime/powerBankBoost";
import * as combatObserver from "@/runtime/powerBankObserver";
import { createMockStore, MockPos } from "@mock/powerBank";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createSourceRoom(): Room {
  return {
    name: "E1N57",
    controller: { my: true, level: 8 } as StructureController,
    storage: {
      id: "storage" as Id<StructureStorage>,
      structureType: STRUCTURE_STORAGE,
      store: createMockStore({}),
    } as unknown as StructureStorage,
    terminal: {
      id: "terminal" as Id<StructureTerminal>,
      structureType: STRUCTURE_TERMINAL,
      cooldown: 0,
      store: createMockStore({}),
    } as unknown as StructureTerminal,
    find: jest.fn(() => []),
  } as unknown as Room;
}

function createTargetRoom(
  hostileCreeps: Creep[] = [],
  hostileStructures: Structure[] = [],
  walls: Structure[] = [],
  name = "E3N57",
): Room {
  return {
    name,
    controller: { my: false, level: 0 } as StructureController,
    find: jest.fn((type: FindConstant, opts?: { filter?: (value: Creep | Structure) => boolean }) => {
      const values: Array<Creep | Structure> = type === FIND_HOSTILE_CREEPS
        ? hostileCreeps
        : type === FIND_HOSTILE_STRUCTURES
          ? hostileStructures
          : type === FIND_STRUCTURES ? [...hostileStructures, ...walls] : [];
      return opts?.filter ? values.filter((value) => opts.filter?.(value)) : values;
    }),
  } as unknown as Room;
}

function createSpawn(room: Room): StructureSpawn {
  return {
    id: "spawn-1" as Id<StructureSpawn>,
    name: "Spawn1",
    room,
    owner: { username: "me" } as Owner,
    memory: { spawnList: [] },
    spawning: null,
    isActive: jest.fn(() => true),
    addTask(configName: string): number {
      this.memory.spawnList.push(configName);
      return this.memory.spawnList.length;
    },
  } as unknown as StructureSpawn;
}

function createWarCreep(
  name: string,
  role: "meleeAttacker" | "healer",
  configName: string,
  roomName = "E1N57",
): Creep {
  return {
    name,
    room: { name: roomName } as Room,
    pos: new MockPos(25, 25, roomName) as unknown as RoomPosition,
    memory: { role, configName },
    body: [],
    hits: 5_000,
    hitsMax: 5_000,
    spawning: false,
  } as unknown as Creep;
}

describe("三个NPC目标共享一支清剿小队", () => {
  const rooms = ["E3N57", "E2N54", "E3N53"];
  const enemyStructure = (name: string) => ({ id: name, structureType: STRUCTURE_EXTENSION, owner: { username: "TooAngel" }, pos: new MockPos(20, 20, name) }) as unknown as StructureExtension;
  const tick = () => { Game.time++; resetRuntimeServices(); };
  const shared = () => configureWarRebuildWatch("E1N57", rooms, "TooAngel", 100, true);
  beforeEach(() => {
    jest.restoreAllMocks(); jest.clearAllMocks(); resetRuntimeServices(); Game.time = 1000;
    Memory.cfg = {}; Memory.runtime = {}; Memory.data = {}; Memory.creeps = {};
    const source = createSourceRoom(); source.energyAvailable = 12900; source.energyCapacityAvailable = 12900;
    Game.rooms = { E1N57: source }; Game.spawns = { Spawn1: createSpawn(source) }; Game.creeps = {}; Game.flags = {};
    Game.map = { ...Game.map, findRoute: jest.fn((_from: string, target: string) => [{ exit: RIGHT, room: target }]) } as GameMap;
    for (const name of rooms) {
      const room = createTargetRoom([], [enemyStructure(name)], [], name);
      room.controller!.owner = { username: "TooAngel" }; room.controller!.level = 8;
      Game.rooms[name] = room;
      startWarRoom(name, "E1N57", { squad: "towerDrainDuo", oneShot: false });
    }
  });
  afterEach(() => { Memory.cfg = {}; });

  it("已确认 NPC 目标清剿后无需人工 flag，当帧按残留货量衔接搬运", () => {
    shared(); runWarControl();
    expect(Memory.data!.war!.E3N57.lootAfterClear).toBe(true);
    const room = Game.rooms.E3N57;
    const ruin = { id: "npc-loot", pos: new MockPos(44, 17, room.name), store: createMockStore({ energy: 239 }) } as unknown as Ruin;
    room.find = jest.fn((kind: FindConstant) => kind === FIND_RUINS ? [ruin] : []) as Room["find"];
    room.createFlag = jest.fn((_pos: RoomPosition, name: string) => name) as unknown as Room["createFlag"];
    Game.time++; runWarControl();
    expect(room.createFlag).not.toHaveBeenCalled();
    Game.time += 19; runWarControl();
    const flag = "HAUL_E1N57_INVADER_E3N57";
    expect(room.createFlag).toHaveBeenCalledWith(ruin.pos, flag);
    expect(Memory.data!.flagHauling![flag].sourceRoom).toBe("E1N57");
    const carriers = Object.entries(Memory.data!.creepConfigs!).filter(([name]) => name.includes(":haul:E3N57:"));
    expect(carriers).toHaveLength(1);
    expect(carriers[0][1].body?.filter(part => part === CARRY)).toHaveLength(5);
  });

  function installExistingPairs(): void {
    runWarControl();
    for (const name of rooms) {
      const task = Memory.data!.war![name]; const generation = task.activeGeneration!;
      generation.phase = "deployed";
      const red = createWarCreep(`${name}-red`, "meleeAttacker", generation.configNames.meleeAttacker, name);
      const green = createWarCreep(`${name}-green`, "healer", generation.configNames.healer, name);
      red.ticksToLive = green.ticksToLive = 1000;
      red.body = Array.from({ length: 25 }, () => ({ type: ATTACK, hits: 100 })) as BodyPartDefinition[];
      if (name === "E3N53") {
        task.squad = "t3Duo"; task.boostTier = "t3";
        red.body = Array.from({ length: 30 }, () => ({ type: ATTACK, hits: 100, boost: RESOURCE_CATALYZED_UTRIUM_ACID })) as BodyPartDefinition[];
      }
      Game.creeps[red.name] = red; Game.creeps[green.name] = green;
    }
    tick(); shared();
  }

  it("三个新目标只生产一对无强化成员，另外两房排队", () => {
    shared(); runWarControl();
    const tasks = Object.values(Memory.data!.war!);
    expect(tasks.filter((task) => task.activeGeneration)).toHaveLength(1);
    expect(Object.values(Memory.data!.creepConfigs!).filter((config) => config.role === "meleeAttacker" || config.role === "healer")).toHaveLength(2);
    expect(tasks.filter((task) => task.failReason === "shared_squad_queued")).toHaveLength(2);
  });

  it("无威胁时优先无强化现役，回收T3和多余成员并取消控制器攻击任务", () => {
    installExistingPairs();
    const controllerName = "E1N57:war:E2N54:controllerAttacker:0";
    Memory.data!.creepConfigs![controllerName] = { role: "claimer", roomName: "E1N57", args: ["E2N54", "", "attack"], body: [CLAIM, MOVE] };
    const controllerActor = createWarCreep("old-controller", "meleeAttacker", controllerName, "E2N54");
    controllerActor.memory.role = "claimer"; Game.creeps[controllerActor.name] = controllerActor;
    runWarControl();
    expect(Object.values(Memory.runtime!.warRebuildWatch!)[0].sharedSquadOwner).toBe("E2N54");
    expect(Game.creeps['E2N54-red'].memory.configName).toBeDefined();
    for (const name of ["E3N57", "E3N53"]) for (const role of ["red", "green"]) {
      expect(Game.creeps[`${name}-${role}`].memory).toMatchObject({ _warDetached: true, _warRetireToRoom: "E1N57" });
      expect(Game.creeps[`${name}-${role}`].memory.configName).toBeUndefined();
    }
    expect(Memory.data!.creepConfigs![controllerName]).toBeUndefined();
    expect(controllerActor.memory._recycleToRoom).toBe("E1N57");
    expect(Object.values(Memory.data!.creepConfigs!).filter((config) => config.role === "claimer")).toHaveLength(0);
  });

  it("当前唯一现役为T3且无威胁时回收它，重新只生产一份无强化队", () => {
    installExistingPairs();
    const id = Object.keys(Memory.cfg!.warRebuildWatch!)[0];
    Memory.runtime!.warRebuildWatch = { [id]: { clearedRooms: [], targets: {}, sharedSquadOwner: "E3N53" } };
    for (const name of ["E3N57", "E2N54"]) { delete Game.creeps[`${name}-red`]; delete Game.creeps[`${name}-green`]; }
    runWarControl();
    const owner = Memory.data!.war!.E3N53;
    expect(owner).toMatchObject({ squad: "towerDrainDuo", npcAuto: true });
    expect(owner.boostTier).toBeUndefined();
    expect(Game.creeps['E3N53-red'].memory._warRetireToRoom).toBe("E1N57");
    expect(Object.values(Memory.data!.war!).filter(t => t.activeGeneration)).toHaveLength(1);
  });

  it("新鲜敌方治疗超过无强化攻击时保留当前T3能力", () => {
    installExistingPairs();
    const hostile = { id: "strong-heal", pos: new MockPos(25, 25, "E3N53"), owner: { username: "TooAngel" },
      body: Array.from({ length: 20 }, () => ({ type: HEAL, hits: 100, boost: RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE })) } as unknown as Creep;
    const room = createTargetRoom([hostile], [enemyStructure("E3N53")], [], "E3N53");
    room.controller!.owner = { username: "TooAngel" }; Game.rooms.E3N53 = room;
    runWarControl();
    expect(Memory.data!.war!.E3N53).toMatchObject({ squad: "t3Duo", boostTier: "t3" });
    expect(Game.creeps['E3N53-red'].memory._warRetireToRoom).toBeUndefined();
  });

  it("清空一房后同一对成员原子换目标与搭档，不孵化另一队并等待自然降级", () => {
    installExistingPairs(); runWarControl();
    const previous = Object.values(Memory.runtime!.warRebuildWatch!)[0].sharedSquadOwner!;
    const room = createTargetRoom([], [], [], previous); room.controller!.owner = { username: "TooAngel" }; room.controller!.level = 8;
    Game.rooms[previous] = room;
    tick(); runWarControl(); Game.time += 25; resetRuntimeServices(); runWarControl();
    const watch = Object.values(Memory.runtime!.warRebuildWatch!)[0];
    const next = Memory.data!.war![watch.sharedSquadOwner!];
    const red = Game.creeps[`${previous}-red`]; const green = Game.creeps[`${previous}-green`];
    expect(next.targetRoom).not.toBe(previous);
    expect(red.memory.configName).toBe(next.activeGeneration!.configNames.meleeAttacker);
    expect(green.memory.configName).toBe(next.activeGeneration!.configNames.healer);
    expect(red.memory.roleArgs?.[0]).toBe(next.targetRoom);
    expect(red.memory.roleArgs?.[4]).toBe(green.memory.configName);
    expect(green.memory.roleArgs?.[4]).toBe(red.memory.configName);
    expect(Memory.data!.war![previous]).toMatchObject({ status: "downgrading", combatClearedAt: Game.time });
    expect(Memory.data!.war![previous].activeGeneration).toBeUndefined();
    expect(Object.values(Memory.data!.creepConfigs!).filter((config) => config.role === "meleeAttacker" || config.role === "healer").every((config) => config.spawnOnce?.queuedAt === 1000)).toBe(true);
  });

  it("无所属的旧墙不占用整个共享清剿世代，空房等待降级时不补生战斗队", () => {
    for (const name of rooms) {
      const room = createTargetRoom([], [], [{ id: `${name}-wall`, structureType: STRUCTURE_WALL } as StructureWall], name);
      room.controller!.owner = { username: "TooAngel" }; room.controller!.level = 8; Game.rooms[name] = room;
    }
    shared(); runWarControl(); Game.time += 25; resetRuntimeServices(); runWarControl();
    expect(Object.values(Memory.data!.war!).every((task) => task.combatClearedAt !== undefined && task.status === "downgrading")).toBe(true);
    expect(Object.values(Memory.data!.war!).every((task) => !task.activeGeneration)).toBe(true);
    expect(Object.values(Memory.runtime!.warRebuildWatch!)[0].armedAt).toBe(Game.time);
    Game.time++; resetRuntimeServices(); runWarControl();
    expect(Object.values(Memory.data!.creepConfigs!).filter((config) => config.role === "meleeAttacker" || config.role === "healer")).toHaveLength(0);
  });

  it("共享队伍损失成员后仅替换一代，并重新尝试无强化", () => {
    installExistingPairs(); runWarControl();
    const ownerName = Object.values(Memory.runtime!.warRebuildWatch!)[0].sharedSquadOwner!;
    delete Game.creeps[`${ownerName}-red`]; tick(); runWarControl();
    const owner = Memory.data!.war![ownerName];
    expect(owner.squad).toBe("towerDrainDuo");
    expect(owner.activeGeneration?.phase).toBe("assembling");
    expect(Game.creeps[`${ownerName}-green`].memory._warRetireToRoom).toBe("E1N57");
    expect(Object.values(Memory.data!.war!).filter((task) => task.activeGeneration)).toHaveLength(1);
    const id = owner.activeGeneration!.id; tick(); runWarControl();
    expect(owner.activeGeneration!.id).toBe(id);
  });

  it("源房失去所有权时停止整个共享组生产，不回落到旧并行规则", () => {
    shared(); Game.rooms.E1N57.controller!.my = false; runWarControl();
    expect(Object.values(Memory.data!.war!).every((task) => task.failReason === "shared_source_not_owned" && !task.activeGeneration)).toBe(true);
  });
});

describe("runWarControl", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    resetRuntimeServices();
    Game.time = 1000;
    Memory.runtime = {};
    Memory.data = {
      war: {
        E3N57: {
          targetRoom: "E3N57",
          sourceRoom: "E1N57",
          status: "staging",
          reason: "manual",
          squad: "t3Duo",
          boostTier: "t3",
          attempts: 1,
          createdAt: Game.time,
          updatedAt: Game.time,
        },
      },
    } as Memory["data"];
    Game.rooms = {};
    Game.spawns = {};
    Game.creeps = {};
  });

  it("does not expire an old task that is already clearing visible hostiles", () => {
    Memory.data = {
      war: {
        E3N57: {
          targetRoom: "E3N57",
          sourceRoom: "E1N57",
          status: "clearing",
          statusSince: Game.time - 3000,
          reason: "npc_reservation",
          attempts: 1,
          createdAt: Game.time - 3000,
          updatedAt: Game.time,
        },
      },
    } as Memory["data"];
    const hostile = { owner: { username: "enemy" } } as Creep;
    Game.rooms.E1N57 = createSourceRoom();
    Game.rooms.E3N57 = createTargetRoom([hostile]);

    runWarControl();

    expect(Memory.data?.war?.E3N57?.status).toBe("clearing");
    expect(Memory.data?.war?.E3N57?.lastHostileSeenAt).toBe(Game.time);
  });

  it("terminalizes and detaches live and spawning members while removing production immediately", () => {
    const attackerConfig = "E1N57:war:E3N57:meleeAttacker:0";
    const healerConfig = "E1N57:war:E3N57:healer:0";
    const attackerSuicide = jest.fn(() => OK);
    const attacker = createWarCreep("attacker", "meleeAttacker", attackerConfig);
    attacker.memory.roleArgs = ["E3N57", "", "", "", healerConfig];
    attacker.memory._warPartnerConfigName = healerConfig;
    attacker.suicide = attackerSuicide;
    const spawningMemory = {
      role: "healer" as const,
      roleArgs: ["E3N57", "", "", "", attackerConfig],
      configName: healerConfig,
      _warPartnerConfigName: attackerConfig,
    } as CreepMemory;
    const cancel = jest.fn(() => ERR_BUSY);
    const sourceRoom = createSourceRoom();
    const spawn = createSpawn(sourceRoom);
    spawn.memory.spawnList = [attackerConfig, healerConfig];
    (spawn as StructureSpawn & { spawning: Spawning }).spawning = {
      name: "forming-healer",
      cancel,
    } as unknown as Spawning;

    Memory.data = {
      war: {
        E3N57: {
          targetRoom: "E3N57",
          sourceRoom: "E1N57",
          status: "clearing",
          reason: "npc_reservation",
          squad: "standard",
          attempts: 1,
          createdAt: 900,
          updatedAt: 999,
          statusSince: 900,
          clearSince: 981,
        },
      },
      creepConfigs: {
        [attackerConfig]: { role: "meleeAttacker", args: [...attacker.memory.roleArgs!], roomName: "E1N57" },
        [healerConfig]: { role: "healer", args: [...spawningMemory.roleArgs!], roomName: "E1N57" },
      },
    } as Memory["data"];
    Memory.creeps = { "forming-healer": spawningMemory };
    Game.rooms = { E1N57: sourceRoom, E3N57: createTargetRoom() };
    Game.spawns = { Spawn1: spawn };
    Game.creeps = { attacker };
    resetRuntimeServices();

    runWarControl();

    expect(Memory.data?.war?.E3N57).toMatchObject({
      status: "done",
      completedAt: 1000,
      assetsReleasedAt: 1000,
    });
    expect(Memory.data?.creepConfigs?.[attackerConfig]).toBeUndefined();
    expect(Memory.data?.creepConfigs?.[healerConfig]).toBeUndefined();
    expect(spawn.memory.spawnList).toEqual([]);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(attacker.memory).toMatchObject({
      role: "meleeAttacker",
      roleArgs: ["E3N57", "", "", "", healerConfig],
      _warDetached: true,
    });
    expect(attacker.memory.configName).toBeUndefined();
    expect(attacker.memory._warPartnerConfigName).toBeUndefined();
    expect(attackerSuicide).not.toHaveBeenCalled();
    expect(spawningMemory._warDetached).toBe(true);
    expect(spawningMemory.configName).toBeUndefined();
    expect(spawningMemory._warPartnerConfigName).toBeUndefined();
  });

  it("fails an exhausted one-shot generation instead of leaving it deployed forever", () => {
    const attackerConfig = "E1N57:war:E3N57:g1:meleeAttacker:0";
    const healerConfig = "E1N57:war:E3N57:g1:healer:0";
    const attacker = createWarCreep("attacker", "meleeAttacker", attackerConfig, "E3N57");
    attacker.memory._warPartnerConfigName = healerConfig;
    attacker.memory.roleArgs = ["E3N57", "", "war:E1N57:E3N57:g1", "boosts", healerConfig];
    attacker.suicide = jest.fn(() => OK);
    Memory.data = {
      war: {
        E3N57: {
          targetRoom: "E3N57",
          sourceRoom: "E1N57",
          status: "clearing",
          reason: "manual",
          squad: "t3Duo",
          boostTier: "t3",
          oneShot: true,
          attempts: 1,
          createdAt: 900,
          updatedAt: 999,
          activeGeneration: {
            id: 1,
            phase: "deployed",
            createdAt: 900,
            deployedAt: 950,
            boostTaskId: "war:E1N57:E3N57:g1",
            configNames: { meleeAttacker: attackerConfig, healer: healerConfig },
          },
        },
      },
      creepConfigs: {
        [attackerConfig]: { role: "meleeAttacker", args: [...attacker.memory.roleArgs!], roomName: "E1N57" },
        [healerConfig]: { role: "healer", args: [], roomName: "E1N57" },
      },
    } as Memory["data"];
    Game.rooms = { E1N57: createSourceRoom() };
    Game.creeps = { attacker };
    resetRuntimeServices();

    runWarControl();

    expect(Memory.data?.war?.E3N57).toMatchObject({
      status: "failed",
      failReason: "generation_exhausted",
      completedAt: 1000,
      assetsReleasedAt: 1000,
    });
    expect(attacker.memory._warDetached).toBe(true);
    expect(attacker.memory.configName).toBeUndefined();
    expect(attacker.memory._warPartnerConfigName).toBeUndefined();
    expect(Memory.data?.war?.E3N57?.activeGeneration?.id).toBe(1);
  });

  it("replaces an exhausted reusable generation with a monotonically newer generation", () => {
    const attackerConfig = "E1N57:war:E3N57:g1:meleeAttacker:0";
    const healerConfig = "E1N57:war:E3N57:g1:healer:0";
    const attacker = createWarCreep("attacker", "meleeAttacker", attackerConfig, "E3N57");
    attacker.memory._warPartnerConfigName = healerConfig;
    attacker.suicide = jest.fn(() => OK);
    Memory.data = {
      war: {
        E3N57: {
          targetRoom: "E3N57",
          sourceRoom: "E1N57",
          status: "clearing",
          reason: "manual",
          squad: "t3Duo",
          boostTier: "t3",
          oneShot: false,
          attempts: 1,
          createdAt: 900,
          updatedAt: 999,
          generationCounter: 1,
          activeGeneration: {
            id: 1,
            phase: "deployed",
            createdAt: 900,
            deployedAt: 950,
            boostTaskId: "war:E1N57:E3N57:g1",
            configNames: { meleeAttacker: attackerConfig, healer: healerConfig },
          },
        },
      },
      creepConfigs: {
        [attackerConfig]: { role: "meleeAttacker", args: ["E3N57"], roomName: "E1N57" },
        [healerConfig]: { role: "healer", args: ["E3N57"], roomName: "E1N57" },
      },
    } as Memory["data"];
    Game.rooms = { E1N57: createSourceRoom() };
    Game.creeps = { attacker };
    resetRuntimeServices();

    runWarControl();

    expect(Memory.data?.war?.E3N57).toMatchObject({
      status: "clearing",
      generationCounter: 2,
      activeGeneration: { id: 2, phase: "preparing" },
    });
    expect(attacker.memory._warDetached).toBe(true);
    expect(attacker.memory.configName).toBeUndefined();
    expect(attacker.memory._warPartnerConfigName).toBeUndefined();
    expect(Memory.data?.war?.E3N57?.completedAt).toBeUndefined();
  });
});

describe("towerDrainDuo 战争控制", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    resetRuntimeServices();
    Game.time = 1000;
    Memory.runtime = {};
    Memory.data = {};
    Memory.creeps = {};
    const source = createSourceRoom();
    source.energyAvailable = 7500;
    source.energyCapacityAvailable = 7500;
    Game.rooms = { E1N57: source };
    Game.spawns = { Spawn1: createSpawn(source) };
    Game.creeps = {};
  });

  function startDrain(targetRoom = "E3N57", oneShot = false): void {
    startWarRoom(targetRoom, "E1N57", { squad: "towerDrainDuo", oneShot });
  }

  function nextTick(): void {
    Game.time += 1;
    resetRuntimeServices();
  }

  it("未指定路线时按当前地图生成，显式路线更新不重建世代或搭档", () => {
    Game.map = { ...Game.map, findRoute: jest.fn(() => [{ exit: RIGHT, room: "E2N57" }, { exit: RIGHT, room: "E3N57" }]) } as GameMap;
    startDrain(); runWarControl();
    const original = Memory.data!.war!.E3N57.activeGeneration!;
    expect(Memory.data!.war!.E3N57.routeRooms).toEqual(["E1N57", "E2N57", "E3N57"]);
    const red = createWarCreep("red", "meleeAttacker", original.configNames.meleeAttacker, "E3N57");
    const green = createWarCreep("green", "healer", original.configNames.healer, "E3N57");
    red.memory.roleArgs = [...Memory.data!.creepConfigs![original.configNames.meleeAttacker].args];
    green.memory.roleArgs = [...Memory.data!.creepConfigs![original.configNames.healer].args];
    Game.creeps = { red, green };
    Game.rooms.E3N57 = createTargetRoom([], [{ structureType: STRUCTURE_SPAWN, pos: new MockPos(25, 25, "E3N57") } as unknown as StructureSpawn]);
    original.phase = "deployed";
    const next = ["E1N57", "E1N56", "E2N56", "E2N57", "E3N57"];
    startWarRoom("E3N57", "E1N57", { squad: "towerDrainDuo", routeRooms: next, oneShot: false });
    nextTick(); runWarControl();
    const generation = Memory.data!.war!.E3N57.activeGeneration!;
    expect(generation.id).toBe(original.id);
    expect(generation.configNames).toEqual(original.configNames);
    expect(red.memory.roleArgs?.[1]).toBe(next.join("|"));
    expect(green.memory.roleArgs?.[1]).toBe(next.join("|"));
    expect(red.memory.roleArgs?.[4]).toBe(original.configNames.healer);
    expect(green.memory.roleArgs?.[4]).toBe(original.configNames.meleeAttacker);
  });

  it("生成精确 25 主部件双人队，空 boost 参数，并保留尾部移动与治疗", () => {
    const prepare = jest.spyOn(combatBoosts, "prepareBoosts");
    const release = jest.spyOn(combatBoosts, "releaseBoostLabs");
    startDrain();

    runWarControl();

    const task = Memory.data!.war!.E3N57;
    const generation = task.activeGeneration!;
    const configs = Memory.data!.creepConfigs!;
    const attacker = configs[generation.configNames.meleeAttacker];
    const healer = configs[generation.configNames.healer];
    expect(Object.keys(configs)).toHaveLength(2);
    expect(attacker.body).toEqual([...Array(25).fill(ATTACK), ...Array(25).fill(MOVE)]);
    expect(healer.body).toEqual([...Array(20).fill(HEAL), ...Array(25).fill(MOVE), ...Array(5).fill(HEAL)]);
    expect(attacker.args).toEqual(["E3N57", "", "", "", generation.configNames.healer, "towerDrainDuo"]);
    expect(healer.args).toEqual(["E3N57", "", "", "", generation.configNames.meleeAttacker, "towerDrainDuo"]);
    expect(attacker.spawnOnce).toEqual({ queuedAt: Game.time });
    expect(healer.spawnOnce).toEqual({ queuedAt: Game.time });
    expect(generation.phase).toBe("assembling");
    expect(generation.boostGateOpenedAt).toBeUndefined();
    expect(task.boostTier).toBeUndefined();
    expect(task.boostLabs).toBeUndefined();
    expect(Game.spawns.Spawn1.memory.spawnList).toEqual(expect.arrayContaining(Object.values(generation.configNames)));
    expect(prepare).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("NPC默认无强化，真实入口塔伤不低于治疗时才升级，显式配置仍优先", () => {
    const target = createTargetRoom();
    target.controller!.owner = { username: "TooAngel" };
    const towers = [0, 1].map(i => ({ id: `tower-${i}`, structureType: STRUCTURE_TOWER,
      pos: new MockPos(25, 25, target.name), owner: { username: "TooAngel" }, store: createMockStore({ [RESOURCE_ENERGY]: 0 }) } as unknown as StructureTower));
    target.find = jest.fn((kind: FindConstant) => kind === FIND_STRUCTURES || kind === FIND_HOSTILE_STRUCTURES ? towers : []) as Room["find"];
    Game.rooms[target.name] = target;
    Game.map = { ...Game.map, describeExits: jest.fn(() => ({ [LEFT]: "E2N57" })),
      getRoomTerrain: jest.fn(() => ({ get: () => 0 })),
      findRoute: jest.fn(() => [{ exit: RIGHT, room: "E2N57" }, { exit: RIGHT, room: target.name }]) } as unknown as GameMap;
    startWarRoom(target.name, "E1N57", { oneShot: false });
    runWarControl();
    const old = Memory.data!.war![target.name];
    expect(old).toMatchObject({ npcAuto: true, squad: "towerDrainDuo", squadDecision: "no_current_tower_threat", attempts: 1 });
    const generation = old.activeGeneration!.id;
    towers.forEach(tower => { tower.store[RESOURCE_ENERGY] = 1000; });
    Game.time += 100; resetRuntimeServices(); runWarControl();
    expect(Memory.data!.war![target.name]).toMatchObject({ npcAuto: true, squad: "t3Duo", boostTier: "t3", squadDecision: "entry_damage_exceeds_heal", attempts: 2 });
    expect(Memory.data!.war![target.name].generationCounter).toBeGreaterThanOrEqual(generation);
    towers.forEach(tower => { tower.store[RESOURCE_ENERGY] = 0; });
    Game.time += 100; resetRuntimeServices(); runWarControl();
    expect(Memory.data!.war![target.name].squad).toBe("t3Duo");
    startWarRoom(target.name, "E1N57", { squad: "towerDrainDuo", oneShot: false });
    expect(Memory.data!.war![target.name].npcAuto).toBeUndefined();
    towers.forEach(tower => { tower.store[RESOURCE_ENERGY] = 1000; });
    Game.time += 100; resetRuntimeServices(); runWarControl();
    expect(Memory.data!.war![target.name].squad).toBe("towerDrainDuo");
  });

  it("玩家目标和显式T3保留原默认，未知NPC先观察而不盲孵化", () => {
    const target = createTargetRoom(); target.controller!.owner = { username: "a-player" };
    Game.rooms[target.name] = target;
    startWarRoom(target.name, "E1N57");
    expect(Memory.data!.war![target.name]).toMatchObject({ squad: "t3Duo", boostTier: "t3" });
    target.controller!.owner = { username: "Invader" };
    startWarRoom(target.name, "E1N57", { boostTier: "t3" });
    expect(Memory.data!.war![target.name].npcAuto).toBeUndefined();
    delete Game.rooms[target.name];
    // 正常NPC保留请求来自已识别的reservation事件。
    requestWarRoomClear("E4N57", "E1N57", { reason: "npc_reservation" });
    runWarControl();
    expect(Memory.data!.war!.E4N57).toMatchObject({ squad: "towerDrainDuo", failReason: "npc_policy_awaiting_vision" });
    expect(Memory.data!.war!.E4N57.activeGeneration).toBeUndefined();
  });

  it("源房装不下无强化身体时使用可孵化T3；两种都不足时等待而不预约实验室", () => {
    const room = createTargetRoom(); room.controller!.owner = { username: "Invader" };
    Game.rooms[room.name] = room;
    Game.rooms.E1N57.energyCapacityAvailable = 6000;
    startWarRoom(room.name, "E1N57", { oneShot: false });
    expect(Memory.data!.war![room.name]).toMatchObject({ squad: "t3Duo", squadDecision: "source_cannot_spawn_unboosted_body" });
    Game.rooms.E1N57.energyCapacityAvailable = 2300;
    const boosts = jest.spyOn(combatBoosts, "prepareBoosts");
    runWarControl();
    expect(Memory.data!.war![room.name].failReason).toBe("npc_source_capacity_insufficient");
    expect(Memory.data!.war![room.name].activeGeneration).toBeUndefined();
    expect(boosts).not.toHaveBeenCalled();
  });

  it("无强化队伍动态升级T3后重新进入源房队列，不绕过已有T3的生产所有权", () => {
    const room = createTargetRoom(); room.controller!.owner = { username: "TooAngel" };
    Game.rooms[room.name] = room;
    startWarRoom(room.name, "E1N57", { oneShot: false });
    runWarControl();
    startWarRoom("E4N57", "E1N57", { squad: "t3Duo", oneShot: false });
    Game.rooms.E1N57.energyCapacityAvailable = 6000;
    Game.time += 100; resetRuntimeServices(); runWarControl();
    expect(Memory.data!.war![room.name].squad).toBe("t3Duo");
    expect(Memory.data!.war![room.name].activeGeneration).toBeUndefined();
    Game.time++; resetRuntimeServices(); runWarControl();
    expect(Memory.data!.war![room.name].status).toBe("queued");
    expect(Memory.data!.war![room.name].activeGeneration).toBeUndefined();
  });

  it("地图路线记录跳数和当前敌情，经济危险名单不造成长绕行，显式路线不被刷新", () => {
    const threatened = createTargetRoom([], [{ structureType: STRUCTURE_TOWER, pos: new MockPos(25, 25, "E2N57"), store: createMockStore({ [RESOURCE_ENERGY]: 1000 }) } as unknown as StructureTower], [], "E2N57");
    Game.rooms.E2N57 = threatened;
    const route = jest.fn((_from: string, _to: string, options: RouteOptions) => {
      expect(options.routeCallback!("E2N57", "E1N57")).toBe(Infinity);
      expect(options.routeCallback!("E1N56", "E1N57")).toBe(1);
      return [{ exit: TOP, room: "E1N56" }, { exit: RIGHT, room: "E2N56" }, { exit: RIGHT, room: "E3N56" }, { exit: BOTTOM, room: "E3N57" }];
    });
    Game.map = { ...Game.map, findRoute: route } as GameMap;
    Memory.runtime!.powerBankPermanentDangerRooms = { E1N56: true };
    startDrain();
    expect(Memory.data!.war!.E3N57.routeTrace).toEqual({ hops: 4, policy: "map_combat", avoided: { E2N57: "current_tower_threat" } });
    const manual = ["E1N57", "E2N57", "E3N57"];
    startWarRoom("E3N57", "E1N57", { squad: "towerDrainDuo", routeRooms: manual, oneShot: false });
    route.mockClear(); Game.time += 200; runWarControl();
    expect(route).not.toHaveBeenCalled();
    expect(Memory.data!.war!.E3N57.routeTrace).toEqual({ hops: 2, policy: "manual", avoided: {} });
    expect(Memory.data!.war!.E3N57.routeRooms).toEqual(manual);
  });

  it("同母房的三个耗塔目标并行进入生产，保持独立 generation 与配对", () => {
    const observe = jest.spyOn(combatObserver, "requestCombatObservation").mockReturnValue(false);
    const targets = ["E3N57", "E2N54", "E3N53"];
    for (const target of targets) startDrain(target);

    runWarControl();

    const names = targets.flatMap((target) => {
      const task = Memory.data!.war![target];
      expect(task.status).toBe("staging");
      expect(task.failReason).toBeUndefined();
      expect(task.activeGeneration?.phase).toBe("assembling");
      return Object.values(task.activeGeneration!.configNames);
    });
    expect(new Set(names).size).toBe(6);
    expect(Object.keys(Memory.data!.creepConfigs!)).toHaveLength(6);
    expect(Game.spawns.Spawn1.memory.spawnList).toHaveLength(6);
    expect(observe.mock.calls).toEqual(targets.map((target) => [target]));
    for (const name of names) {
      expect(Memory.data!.creepConfigs![name].args[4]).toMatch(name.split(":").slice(0, 4).join(":"));
    }
  });

  it("耗塔并行不改变旧 standard 与 T3 的单前线排队规则", () => {
    startWarRoom("E4N57", "E1N57", { squad: "standard", oneShot: false });
    startWarRoom("E5N57", "E1N57", { squad: "t3Duo", oneShot: false });
    for (const target of ["E3N57", "E2N54", "E3N53"]) startDrain(target);

    runWarControl();

    expect(Memory.data!.war!.E4N57.status).toBe("staging");
    expect(Memory.data!.war!.E5N57).toMatchObject({ status: "queued", failReason: "frontline_queued" });
    const standardConfigs = Object.entries(Memory.data!.creepConfigs!).filter(([name]) => name.includes(":war:E4N57:"));
    expect(standardConfigs.filter(([, config]) => config.role === "meleeAttacker")).toHaveLength(2);
    expect(standardConfigs.filter(([, config]) => config.role === "healer")).toHaveLength(1);
    expect(standardConfigs.every(([, config]) => config.args.length === 5 && config.body === undefined)).toBe(true);
    expect(Object.keys(Memory.data!.creepConfigs!).some((name) => name.includes(":war:E5N57:"))).toBe(false);
    for (const target of ["E3N57", "E2N54", "E3N53"]) {
      expect(Memory.data!.war![target].status).toBe("staging");
      expect(Memory.data!.war![target].activeGeneration?.phase).toBe("assembling");
    }
  });

  it("旧默认 T3 双人队仍使用原身体、五参数契约和实验室准备", () => {
    const prepare = jest.spyOn(combatBoosts, "prepareBoosts").mockReturnValue({ status: "ready", labs: [] });
    startWarRoom("E3N57", "E1N57");

    runWarControl();

    const task = Memory.data!.war!.E3N57;
    const configs = Memory.data!.creepConfigs!;
    const attacker = configs[task.activeGeneration!.configNames.meleeAttacker];
    const healer = configs[task.activeGeneration!.configNames.healer];
    expect(task).toMatchObject({ squad: "t3Duo", boostTier: "t3", oneShot: true });
    expect(attacker.body?.filter((part) => part === ATTACK)).toHaveLength(30);
    expect(attacker.body?.filter((part) => part === TOUGH)).toHaveLength(10);
    expect(healer.body?.filter((part) => part === HEAL)).toHaveLength(20);
    expect(healer.body?.filter((part) => part === MOVE)).toHaveLength(8);
    expect(attacker.args).toHaveLength(5);
    expect(healer.args).toHaveLength(5);
    expect(attacker.args[3]).toContain(RESOURCE_CATALYZED_UTRIUM_ACID);
    expect(healer.args[3]).toContain(RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(task.activeGeneration!.boostGateOpenedAt).toBe(Game.time);
  });

  it.each([false, true])("无塔但有中性墙时，controller.owner=%s 不能触发 done 或 CLAIM 捷径", (owned) => {
    const wall = { id: "neutral-wall", structureType: STRUCTURE_WALL, hits: 10_000 } as unknown as StructureWall;
    const target = createTargetRoom([], [], [wall]);
    if (owned) {
      target.controller = { my: false, level: 8, owner: { username: "enemy" } } as StructureController;
    }
    Game.rooms.E3N57 = target;
    startDrain();
    Memory.data!.war!.E3N57.clearSince = 900;

    runWarControl();

    expect(Memory.data!.war!.E3N57.status).toBe("clearing");
    expect(Memory.data!.war!.E3N57.clearSince).toBeUndefined();
    expect(Object.values(Memory.data!.creepConfigs!).map((config) => config.role).sort()).toEqual(["healer", "meleeAttacker"]);
    expect(Memory.analytics?.war?.tasks.E3N57.hostileStructures).toBe(1);
  });

  it("只在敌人和结构清除持续 20 ticks 后结束，不等待敌方 reservation", () => {
    const target = createTargetRoom();
    target.controller = { my: false, level: 0, reservation: { username: "enemy", ticksToEnd: 5000 } } as StructureController;
    Game.rooms.E3N57 = target;
    startDrain();
    runWarControl();
    expect(Memory.data!.war!.E3N57.status).toBe("clearing");
    expect(Memory.data!.war!.E3N57.clearSince).toBe(1000);
    Game.time = 1018;
    resetRuntimeServices();
    runWarControl();
    expect(Memory.data!.war!.E3N57.status).toBe("clearing");
    nextTick();
    runWarControl();
    expect(Memory.data!.war!.E3N57.status).toBe("done");
    expect(Object.keys(Memory.data!.creepConfigs!)).toHaveLength(0);
    expect(Game.spawns.Spawn1.memory.spawnList).toHaveLength(0);
  });

  it("敌方 creep 尚在时不能仅因结构为空就结束", () => {
    const enemy = { owner: { username: "enemy" } } as Creep;
    Game.rooms.E3N57 = createTargetRoom([enemy]);
    startDrain();
    Memory.data!.war!.E3N57.clearSince = 900;
    runWarControl();
    expect(Memory.data!.war!.E3N57.status).toBe("clearing");
    expect(Memory.data!.war!.E3N57.clearSince).toBeUndefined();
  });

  it("部署无需实验室，失去队友后用新的 generation 补充而不混配旧存活者", () => {
    const prepare = jest.spyOn(combatBoosts, "prepareBoosts");
    const release = jest.spyOn(combatBoosts, "releaseBoostLabs");
    startDrain();
    runWarControl();
    const initial = Memory.data!.war!.E3N57.activeGeneration!;
    const attacker = createWarCreep("red", "meleeAttacker", initial.configNames.meleeAttacker, "E3N57");
    const healer = createWarCreep("green", "healer", initial.configNames.healer, "E3N57");
    Game.creeps = { red: attacker, green: healer };
    nextTick();
    runWarControl();
    expect(initial.phase).toBe("deployed");
    expect(Object.keys(Memory.data!.creepConfigs!)).toHaveLength(0);
    expect(attacker.memory.roleArgs?.[5]).toBe("towerDrainDuo");
    delete Game.creeps.green;
    nextTick();
    runWarControl();
    const replacement = Memory.data!.war!.E3N57.activeGeneration!;
    expect(replacement).toMatchObject({ id: 2, phase: "assembling" });
    expect(attacker.memory._warDetached).toBe(true);
    expect(attacker.memory.configName).toBeUndefined();
    expect(Object.values(replacement.configNames).every((name) => !Object.values(initial.configNames).includes(name))).toBe(true);
    nextTick();
    runWarControl();
    expect(Object.keys(Memory.data!.creepConfigs!).sort()).toEqual(Object.values(replacement.configNames).sort());
    expect(Object.values(Memory.data!.creepConfigs!).every((config) => config.spawnOnce?.queuedAt === Game.time)).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it.each([false, true])("母房组队时失去成员也整代结束，oneShot=%s 不会按旧名混配", (oneShot) => {
    startDrain("E3N57", oneShot);
    runWarControl();
    const initial = Memory.data!.war!.E3N57.activeGeneration!;
    // 尚在队列中时没有 live 不是死亡，不能提前耗尽。
    nextTick();
    runWarControl();
    expect(Memory.data!.war!.E3N57.activeGeneration!.id).toBe(initial.id);
    const attacker = createWarCreep("red", "meleeAttacker", initial.configNames.meleeAttacker);
    const healer = createWarCreep("green", "healer", initial.configNames.healer);
    Game.creeps = { red: attacker, green: healer };
    Game.spawns.Spawn1.memory.spawnList = [];
    nextTick();
    runWarControl();
    expect(initial.phase).toBe("assembling");
    delete Game.creeps.green;
    nextTick();
    runWarControl();

    const task = Memory.data!.war!.E3N57;
    expect(attacker.memory._warDetached).toBe(true);
    expect(attacker.memory.configName).toBeUndefined();
    expect(Memory.data!.creepConfigs![initial.configNames.meleeAttacker]).toBeUndefined();
    expect(Memory.data!.creepConfigs![initial.configNames.healer]).toBeUndefined();
    expect(Game.spawns.Spawn1.memory.spawnList).not.toContain(initial.configNames.healer);
    if (oneShot) {
      expect(task).toMatchObject({ status: "failed", failReason: "generation_exhausted" });
      expect(task.activeGeneration!.id).toBe(initial.id);
    } else {
      expect(task.activeGeneration).toMatchObject({ id: initial.id + 1, phase: "assembling" });
      expect(task.completedAt).toBeUndefined();
    }
  });

  it("出发前成员丢失会取消旧代正在生成的队友，保留退避角色参数", () => {
    startDrain();
    runWarControl();
    const initial = Memory.data!.war!.E3N57.activeGeneration!;
    const cancel = jest.fn(() => OK);
    (Game.spawns.Spawn1 as StructureSpawn & { spawning: Spawning }).spawning = {
      name: "forming-green", cancel,
    } as unknown as Spawning;
    Memory.creeps["forming-green"] = {
      role: "healer", configName: initial.configNames.healer,
      roleArgs: ["E3N57", "", "", "", initial.configNames.meleeAttacker, "towerDrainDuo"],
    };
    Game.spawns.Spawn1.memory.spawnList = [];
    nextTick();

    runWarControl();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(Memory.creeps["forming-green"]).toMatchObject({
      _warDetached: true,
      roleArgs: ["E3N57", "", "", "", initial.configNames.meleeAttacker, "towerDrainDuo"],
    });
    expect(Memory.creeps["forming-green"].configName).toBeUndefined();
    expect(Memory.data!.war!.E3N57.activeGeneration).toMatchObject({ id: 2, phase: "assembling" });
  });

  it("红球已出生而绿球仍在生成时维持原代，不把空队列误判为成员丢失", () => {
    startDrain();
    runWarControl();
    const initial = Memory.data!.war!.E3N57.activeGeneration!;
    const attacker = createWarCreep("red", "meleeAttacker", initial.configNames.meleeAttacker);
    Game.creeps = { red: attacker };
    const cancel = jest.fn(() => OK);
    (Game.spawns.Spawn1 as StructureSpawn & { spawning: Spawning }).spawning = {
      name: "forming-green", cancel,
    } as unknown as Spawning;
    Memory.creeps["forming-green"] = { role: "healer", configName: initial.configNames.healer };
    Game.spawns.Spawn1.memory.spawnList = [];
    nextTick();

    runWarControl();

    expect(Memory.data!.war!.E3N57.activeGeneration).toBe(initial);
    expect(initial.phase).toBe("assembling");
    expect(attacker.memory.configName).toBe(initial.configNames.meleeAttacker);
    expect(attacker.memory._warDetached).toBeUndefined();
    expect(Game.spawns.Spawn1.memory.spawnList).toHaveLength(0);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("切换现役 T3 squad 时释放旧所有权且不继承 T3 boostTier", () => {
    const release = jest.spyOn(combatBoosts, "releaseBoostLabs").mockImplementation(() => undefined);
    startWarRoom("E3N57", "E1N57", { squad: "t3Duo", oneShot: false });
    const oldConfig = "E1N57:war:E3N57:g7:meleeAttacker:0";
    const oldPartner = "E1N57:war:E3N57:g7:healer:0";
    const old = Memory.data!.war!.E3N57;
    old.activeGeneration = {
      id: 7, phase: "deployed", createdAt: 900, boostTaskId: "war:E1N57:E3N57:g7",
      configNames: { meleeAttacker: oldConfig, healer: oldPartner },
    };
    Memory.data!.creepConfigs = {
      [oldConfig]: { role: "meleeAttacker", args: ["E3N57"], roomName: "E1N57" },
      [oldPartner]: { role: "healer", args: ["E3N57"], roomName: "E1N57" },
    };
    const attacker = createWarCreep("old-red", "meleeAttacker", oldConfig, "E3N57");
    Game.creeps = { "old-red": attacker };
    Game.spawns.Spawn1.memory.spawnList = [oldPartner];
    resetRuntimeServices();

    startWarRoom("E3N57", "E1N57", { squad: "towerDrainDuo", boostTier: "t3", oneShot: false });
    runWarControl();

    const current = Memory.data!.war!.E3N57;
    expect(current.boostTier).toBeUndefined();
    expect(current.activeGeneration).toMatchObject({ id: 8, phase: "assembling" });
    expect(attacker.memory._warDetached).toBe(true);
    expect(attacker.memory.configName).toBeUndefined();
    expect(Memory.data!.creepConfigs![oldConfig]).toBeUndefined();
    expect(Memory.data!.creepConfigs![oldPartner]).toBeUndefined();
    expect(Game.spawns.Spawn1.memory.spawnList).not.toContain(oldPartner);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("war:E1N57:E3N57:g7", "E1N57");
  });

  it("stop 清理自己的队列且不释放或影响并行队伍的实验室", () => {
    const release = jest.spyOn(combatBoosts, "releaseBoostLabs");
    startDrain("E3N57");
    startDrain("E2N54");
    runWarControl();
    const survivingNames = Object.values(Memory.data!.war!.E2N54.activeGeneration!.configNames);

    expect(stopWarRoom("E3N57")).toMatchObject({ ok: true, releasedBoosts: false, removedConfigs: 2 });

    expect(Memory.data!.war!.E3N57).toBeUndefined();
    expect(Game.spawns.Spawn1.memory.spawnList.sort()).toEqual(survivingNames.sort());
    expect(Object.keys(Memory.data!.creepConfigs!).sort()).toEqual(survivingNames.sort());
    expect(release).not.toHaveBeenCalled();
  });
});


describe("清剿后Observer重建监视", () => {
  const rooms = ["E3N57", "E3N53", "E2N54"];
  let id: string;
  const watchState = () => Memory.runtime!.warRebuildWatch![id];
  const terminal = (name: string) => ({ targetRoom: name, sourceRoom: "E1N57", status: "done" as const, reason: "manual" as const,
    squad: "towerDrainDuo" as const, attempts: 1, createdAt: 1, updatedAt: Game.time, assetsReleasedAt: Game.time });
  beforeEach(() => {
    jest.clearAllMocks(); resetRuntimeServices(); Game.time = 1000;
    Memory.cfg = {}; Memory.runtime = {}; Memory.data = { war: Object.fromEntries(rooms.map((name) => [name, terminal(name)])) };
    Game.rooms = { E1N57: createSourceRoom() }; Game.creeps = {}; Game.spawns = {};
    (combatObserver.requestCombatObservation as jest.Mock).mockReturnValue(true);
    const result = configureWarRebuildWatch("E1N57", rooms, "TooAngel", 100);
    if (typeof result === "string") throw Error(result);
    id = result.id;
  });
  const observe = (name: string, room: Room) => { Game.time++; Game.rooms[name] = room; runWarControl(); };

  it("三个房间全部完成才启动；先完成的记录在终态任务删除后仍保留", () => {
    Memory.data!.war!.E2N54.status = "clearing";
    runWarControl();
    expect(watchState().armedAt).toBeUndefined();
    expect(watchState().targets).toEqual({ E3N57: { lastTriggeredEvidenceIds: [] }, E3N53: { lastTriggeredEvidenceIds: [] } });
    (combatObserver.requestCombatObservation as jest.Mock).mockClear();
    delete Memory.data!.war!.E3N57;
    delete Memory.data!.war!.E3N53;
    Memory.data!.war!.E2N54 = terminal("E2N54");
    Game.time++; runWarControl();
    expect(watchState().armedAt).toBe(Game.time);
    expect(combatObserver.requestCombatObservation).toHaveBeenCalledTimes(3);
  });

  it("空房与对方控制器不派兵，只在100tick间隔请求观察", () => {
    runWarControl();
    const room = createTargetRoom();
    room.controller!.owner = { username: "TooAngel" };
    observe("E3N57", room);
    expect(Memory.data!.war!.E3N57.status).toBe("done");
    Game.time = 1099; runWarControl();
    expect((combatObserver.requestCombatObservation as jest.Mock).mock.calls.filter(([name]) => name === "E3N57")).toHaveLength(1);
    Game.time = 1100; runWarControl();
    expect((combatObserver.requestCombatObservation as jest.Mock).mock.calls.filter(([name]) => name === "E3N57")).toHaveLength(2);
  });

  it("新鲜观察见对手creep只重启一次，重复观察和已有小队不增加世代或任务", () => {
    runWarControl();
    const enemy = { owner: { username: "TooAngel" } } as Creep;
    observe("E3N57", createTargetRoom([enemy]));
    const task = Memory.data!.war!.E3N57;
    expect(task.status).toBe("staging"); expect(task.attempts).toBe(2);
    expect(task.squad).toBe("towerDrainDuo"); expect(watchState().targets.E3N57.triggerCount).toBe(1);
    Game.time++; runWarControl();
    expect(Memory.data!.war!.E3N57.attempts).toBe(2);
    expect(watchState().targets.E3N57.triggerCount).toBe(1);
  });

  it("其它玩家creep不触发指定对手的补剿", () => {
    runWarControl(); observe("E3N57", createTargetRoom([{ owner: { username: "someone-else" } } as Creep]));
    expect(Memory.data!.war!.E3N57.status).toBe("done");
  });

  it("房间已被第三方接管时，即便有对手creep经过也不派队拆第三方房间", () => {
    runWarControl();
    const room = createTargetRoom([{ owner: { username: "TooAngel" } } as Creep]); room.controller!.owner = { username: "new-owner" };
    observe("E3N57", room);
    expect(watchState().targets.E3N57.blocker).toBe("target_owner_changed");
    expect(Memory.data!.war!.E3N57.attempts).toBe(1);
  });

  it("对手工地即使尚未完成spawn也触发补剿", () => {
    runWarControl();
    const room = createTargetRoom();
    room.find = jest.fn((kind: FindConstant) => kind === FIND_HOSTILE_CONSTRUCTION_SITES ? [{ owner: { username: "TooAngel" } }] : []) as Room["find"];
    observe("E3N57", room);
    expect(Memory.data!.war!.E3N57.attempts).toBe(2);
  });

  it("已补剿后的同一残留工地不反复派兵，有新creep到来才触发下一次", () => {
    runWarControl();
    let actors: Creep[] = [{ id: "first-builder", owner: { username: "TooAngel" } } as Creep];
    const room = createTargetRoom();
    room.find = jest.fn((kind: FindConstant) => kind === FIND_HOSTILE_CONSTRUCTION_SITES ? [{ id: "remaining-site", owner: { username: "TooAngel" } }]
      : kind === FIND_HOSTILE_CREEPS ? actors : []) as Room["find"];
    observe("E3N57", room);
    expect(watchState().targets.E3N57.triggerCount).toBe(1);
    Memory.data!.war!.E3N57 = terminal("E3N57");
    actors = [];
    Game.time = 1100; runWarControl(); Game.time++; runWarControl();
    expect(watchState().targets.E3N57.triggerCount).toBe(1);
    actors = [{ id: "new-builder", owner: { username: "TooAngel" } } as Creep];
    Game.time = 1200; runWarControl(); Game.time++; runWarControl();
    expect(watchState().targets.E3N57.triggerCount).toBe(2);
  });

  it("对手完成的新结构也触发；仅控制器归属仍保持监视", () => {
    runWarControl();
    const spawn = { id: "rebuilt", owner: { username: "TooAngel" }, structureType: STRUCTURE_SPAWN } as StructureSpawn;
    observe("E3N57", createTargetRoom([], [spawn]));
    expect(Memory.data!.war!.E3N57.attempts).toBe(2);
  });

  it("手动结束任务后首次扫描登记旧建筑，后续新实体才触发补剿", () => {
    Memory.data!.war = {};
    Memory.runtime!.warRebuildWatch = { [id]: { armedAt: Game.time, clearedRooms: [...rooms], targets: {} } };
    const old = { id: "old-extractor", owner: { username: "TooAngel" }, structureType: STRUCTURE_EXTRACTOR } as StructureExtractor;
    const structures: Structure[] = [old];
    const room = createTargetRoom([], structures);
    runWarControl(); observe("E3N57", room);
    expect(Memory.data!.war!.E3N57).toBeUndefined();
    Game.time = 1100; runWarControl(); Game.time++; runWarControl();
    expect(Memory.data!.war!.E3N57).toBeUndefined();
    structures.push({ id: "new-spawn", owner: { username: "TooAngel" }, structureType: STRUCTURE_SPAWN } as StructureSpawn);
    Game.time = 1200; runWarControl(); Game.time++; runWarControl();
    expect(watchState().targets.E3N57.triggerCount).toBe(1);
    expect(Memory.data!.war!.E3N57.status).toBe("staging");
  });

  it("缺少初始基线也不能吞掉首次观察到的对手 creep", () => {
    Memory.data!.war = {};
    Memory.runtime!.warRebuildWatch = { [id]: { armedAt: Game.time, clearedRooms: [...rooms], targets: {} } };
    runWarControl();
    observe("E3N57", createTargetRoom([{ id: "first-builder", owner: { username: "TooAngel" } } as Creep]));
    expect(watchState().targets.E3N57.triggerCount).toBe(1);
    expect(Memory.data!.war!.E3N57.status).toBe("staging");
  });

  it("清场完成时留下的旧工地不触发，新工地才触发", () => {
    let sites = [{ id: "old-site", owner: { username: "TooAngel" } }];
    const room = createTargetRoom();
    room.find = jest.fn((kind: FindConstant) => kind === FIND_HOSTILE_CONSTRUCTION_SITES ? sites : []) as Room["find"];
    Game.rooms.E3N57 = room;
    runWarControl(); Game.time++; runWarControl();
    expect(watchState().targets.E3N57.triggerCount).toBeUndefined();
    sites = [...sites, { id: "new-site", owner: { username: "TooAngel" } }];
    Game.time = 1100; runWarControl(); Game.time++; runWarControl();
    expect(watchState().targets.E3N57.triggerCount).toBe(1);
  });

  it("没有视野或Observer不可用不孵化队伍；请求超时保留下一轮重试", () => {
    (combatObserver.requestCombatObservation as jest.Mock).mockReturnValue(false);
    runWarControl(); expect(watchState().targets.E3N57.blocker).toBe("observer_unavailable");
    Game.time = 1100; (combatObserver.requestCombatObservation as jest.Mock).mockReturnValue(true); runWarControl();
    Game.time = 1126; runWarControl();
    expect(watchState().targets.E3N57.blocker).toBe("observer_timeout");
    expect(Memory.data!.war!.E3N57.attempts).toBe(1);
  });

  it("我方房间不出兵，源房失去所有权时停止请求", () => {
    runWarControl();
    const room = createTargetRoom([{ owner: { username: "TooAngel" } } as Creep]); room.controller!.my = true;
    observe("E3N57", room);
    expect(Memory.data!.war!.E3N57.attempts).toBe(1);
    Game.rooms.E1N57.controller!.my = false; Game.time = 1100; runWarControl();
    expect(watchState().targets.E3N53.blocker).toBe("source_not_owned");
  });

  it("失败的补剿在终态清理后仍停住，避免不断重复烧兵", () => {
    runWarControl(); Memory.data!.war!.E3N57.status = "failed";
    Game.time++; runWarControl(); delete Memory.data!.war!.E3N57;
    Game.time = 1300; Game.rooms.E3N57 = createTargetRoom([{ owner: { username: "TooAngel" } } as Creep]); runWarControl();
    expect(watchState().targets.E3N57.blocker).toBe("clear_failed");
    expect(Memory.data!.war!.E3N57).toBeUndefined();
  });

  it("重复注册只更新扫描间隔，不改变现役清剿任务", () => {
    const before = JSON.stringify(Memory.data!.war);
    expect(configureWarRebuildWatch("E1N57", [...rooms].reverse(), "TooAngel", 200)).toEqual({ ok: true, id });
    expect(JSON.stringify(Memory.data!.war)).toBe(before);
    expect(Object.keys(Memory.cfg!.warRebuildWatch!)).toHaveLength(1);
    expect(Memory.cfg!.warRebuildWatch![id].intervalTicks).toBe(200);
  });
});
