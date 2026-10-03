jest.mock("@/runtime/powerBankObserver", () => ({ ...jest.requireActual("@/runtime/powerBankObserver"), requestCombatObservation: jest.fn(() => true) }));

import { runWarControl, startWarRoom, stopWarRoom } from "@/runtime/warControl";
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
