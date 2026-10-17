import { registerOutboundMissionOwners } from "@/runtime/registerOutboundMissionOwners";
registerOutboundMissionOwners();
jest.mock("@/runtime/defenseMode", () => ({
  isDefenseMode: jest.fn(() => false),
}));

jest.mock("@/runtime/safeZone", () => ({
  getSafeZone: jest.fn(() => new Set()),
}));


import { scheduleSpawnTasks } from "@/runtime/spawnPlanner";
import { isDefenseMode } from "@/runtime/defenseMode";
import { getSafeZone } from "@/runtime/safeZone";
import { getPowerBankConfigName, POWER_BANK_STATUS } from "@/runtime/powerBankConstants";
import { resetPowerCreepControlCacheForTest } from "@/runtime/powerCreepControl";
import { clearSpawnActiveCacheForTest } from "@/runtime/tickContext";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createRoom(name: string, level = 6): Room {
  return {
    name,
    controller: { my: true, level } as StructureController,
    storage: {
      id: `${name}-storage`,
      pos: { x: 10, y: 10, roomName: name, findPathTo: jest.fn(() => []) },
    } as unknown as StructureStorage,
    energyAvailable: 300,
    energyCapacityAvailable: 300,
  } as Room;
}

function createSpawn(room: Room, name: string, active = true): StructureSpawn {
  return {
    name,
    id: `${name}-id` as Id<StructureSpawn>,
    room,
    memory: { spawnList: [] },
    spawning: null,
    isActive: jest.fn(() => active),
    pos: {
      x: 13,
      y: 10,
      roomName: room.name,
      findPathTo: jest.fn(() => []),
    } as unknown as RoomPosition,
    addTask(configName: string) {
      this.memory.spawnList = [...(this.memory.spawnList || []), configName];
      return this.memory.spawnList.length;
    },
  } as unknown as StructureSpawn;
}

function addLiveCarrier(room: Room): void {
  Game.creeps[`carrier-${room.name}`] = {
    name: `carrier-${room.name}`,
    room,
    memory: { role: "carrier" },
  } as Creep;
}

beforeEach(() => {
  (isDefenseMode as jest.Mock).mockReturnValue(false);
  (getSafeZone as jest.Mock).mockReturnValue(new Set());
  resetRuntimeServices();
  resetPowerCreepControlCacheForTest();
  clearSpawnActiveCacheForTest();
  Game.time += 1;
});

const resetScenarioWorld = () => {
  // Jest 预算归并后多个场景在同一 it 内顺序执行；这里复刻全局
  // beforeEach 的隔离，并额外清空房/spawn/creep 注册，避免跨场景残留。
  (isDefenseMode as jest.Mock).mockReturnValue(false);
  (getSafeZone as jest.Mock).mockReturnValue(new Set());
  resetRuntimeServices();
  resetPowerCreepControlCacheForTest();
  clearSpawnActiveCacheForTest();
  Game.time += 1;
  Game.rooms = {};
  Game.spawns = {};
  Game.creeps = {};
  Memory.spawns = {};
};

describe("采矿持续补员回归", () => {
  function stalledRoom(energy: number) {
    resetScenarioWorld();
    const room = createRoom("E3N54", 3);
    delete room.storage;
    room.energyCapacityAvailable = 800; room.energyAvailable = energy;
    const spawn = createSpawn(room, "Spawn25");
    Game.rooms[room.name] = room; Game.spawns[spawn.name] = spawn; addLiveCarrier(room);
    Memory.cfg = { colonizationSupport: { [room.name]: { enabled: true, sourceRoom: "E1N57" } } };
    const miner = `${room.name}:harvester:local-source`, carrier = `${room.name}:carrier:0`;
    Memory.data = { creepConfigs: { [miner]: { role: "harvester", args: ["local-source"], roomName: room.name },
      [carrier]: { role: "carrier", args: [], roomName: room.name } } };
    Game.getObjectById = jest.fn(() => ({ id: "local-source", energy: 3000 })) as unknown as typeof Game.getObjectById;
    spawn.memory.spawnList = [carrier, miner];
    return { room, spawn, miner, carrier };
  }

  it("213能量、空容器和carrier队首时优先孵化可支付采矿体，重复tick不重复排队", () => {
    const { room, spawn, miner, carrier } = stalledRoom(213);
    scheduleSpawnTasks();
    const rescue = spawn.memory.spawnList![0];
    expect(rescue).toContain(`${room.name}:manual:bootstrapHarvester:`);
    expect(Memory.data!.creepConfigs![rescue].body).toEqual([WORK, MOVE]);
    expect(Memory.data!.creepConfigs![miner].body).toBeUndefined();
    Game.time += 1; resetRuntimeServices();
    scheduleSpawnTasks();
    expect(spawn.memory.spawnList![0]).toBe(rescue);
    expect(spawn.memory.spawnList!.filter(n => n.includes(":bootstrapHarvester:"))).toHaveLength(1);
    expect(spawn.memory.spawnList).toContain(carrier);
  });

  it("650能量足以支付正常矿工时直接把矿工排在800能量carrier前", () => {
    const { spawn, miner } = stalledRoom(650);
    scheduleSpawnTasks();
    expect(spawn.memory.spawnList![0]).toBe(miner);
    expect(spawn.memory.spawnList!.some(n => n.includes(":bootstrapHarvester:"))).toBe(false);
  });
  it("普通自有房团灭后也恢复应急采矿，保留常规配置体型", () => {
    const { spawn, carrier } = stalledRoom(213);
    Memory.cfg = {};
    scheduleSpawnTasks();
    expect(spawn.memory.spawnList![0]).toContain(":bootstrapHarvester:");
    expect(Memory.data!.creepConfigs![spawn.memory.spawnList![0]].body).toEqual([WORK, MOVE]);
    expect(spawn.memory.spawnList).toContain(carrier);
  });

  it("无Storage房间在矿工仍有100TTL时预留下一代补能与运输时间", () => {
    const { room, spawn, miner } = stalledRoom(300);
    spawn.memory.spawnList = [];
    const source = { id: "local-source", pos: { x: 12, y: 42, roomName: room.name, findInRange: () => [] }, room } as unknown as Source;
    Game.getObjectById = jest.fn(() => source) as unknown as typeof Game.getObjectById;
    Game.creeps.miner = { name: "miner", room, memory: { role: "harvester", configName: miner }, ticksToLive: 100 } as Creep;
    scheduleSpawnTasks();
    expect(spawn.memory.spawnList).toContain(miner);
    expect(spawn.memory.spawnList!.some(n => n.includes(":bootstrapHarvester:"))).toBe(false);
  });

  it("已出生本地矿工和仍在孵化的矿工均不会触发额外紧急采矿单位", () => {
    let scenario = stalledRoom(213);
    Game.creeps.miner = { name: "miner", room: scenario.room, memory: { role: "harvester", configName: scenario.miner }, ticksToLive: 1400 } as Creep;
    scheduleSpawnTasks();
    expect(scenario.spawn.memory.spawnList!.some(n => n.includes(":bootstrapHarvester:"))).toBe(false);
    scenario = stalledRoom(213);
    Memory.creeps.inSpawn = { role: "harvester", configName: scenario.miner } as CreepMemory;
    scenario.spawn.spawning = { name: "inSpawn", remainingTime: 10 } as Spawning;
    scheduleSpawnTasks();
    expect(scenario.spawn.memory.spawnList!.some(n => n.includes(":bootstrapHarvester:"))).toBe(false);
  });

  it("紧急矿工寿命结束后重新恢复收入", () => {
    const { room, spawn } = stalledRoom(213);
    scheduleSpawnTasks();
    const first = spawn.memory.spawnList!.shift()!;
    delete Memory.data!.creepConfigs![first];
    Game.creeps.recovery = { name: "recovery", room, memory: { role: "harvester", configName: first }, ticksToLive: 1000 } as Creep;
    Game.time += 1; resetRuntimeServices(); scheduleSpawnTasks();
    expect(spawn.memory.spawnList!.some(n => n.includes(":bootstrapHarvester:"))).toBe(false);
    delete Game.creeps.recovery;
    Game.time += 1001; resetRuntimeServices(); scheduleSpawnTasks();
    expect(spawn.memory.spawnList![0]).toContain(":bootstrapHarvester:");
  });
});

describe("spawnPlanner queue ownership 重合同", () => {
  it("清剿后的有限搬运优先于常规 worker，仍遵守 spawnOnce 去重", () => {
    resetScenarioWorld();
    const room = createRoom("W6N1");
    const spawn = createSpawn(room, "loot-source");
    Game.rooms[room.name] = room; Game.spawns[spawn.name] = spawn; addLiveCarrier(room);
    const worker = `${room.name}:worker:0`, haul = `${room.name}:haul:W6N2:carrier:HAUL_W6N1_INVADER_W6N2`;
    Memory.data = { creepConfigs: {
      [worker]: { role: "worker", args: [], roomName: room.name },
      [haul]: { role: "remoteCarrier", args: ["W6N2", "25,25", "invaderSalvage"], roomName: room.name, body: [CARRY, MOVE], spawnOnce: {} },
    } };
    scheduleSpawnTasks();
    expect(spawn.memory.spawnList).toEqual([haul, worker]);
    scheduleSpawnTasks();
    expect(spawn.memory.spawnList!.filter(name => name === haul)).toHaveLength(1);
  });

  // Jest 预算归并：原 4 个所有权参数化变体合并为单一代表性用例。
  const scenarioDistribute = () => {
    const room = createRoom("W6N1");
    const spawnA = createSpawn(room, "W6N1-spawn-a");
    const spawnB = createSpawn(room, "W6N1-spawn-b");
    Game.rooms[room.name] = room;
    Game.spawns[spawnA.name] = spawnA;
    Game.spawns[spawnB.name] = spawnB;
    addLiveCarrier(room);

    const configNames = Array.from({ length: 4 }, (_, slot) => `${room.name}:worker:${slot}`);
    Memory.data = { creepConfigs: Object.fromEntries(configNames.map((configName) => [
      configName,
      { role: "worker", args: [], roomName: room.name },
    ])) } as Memory["data"];

    scheduleSpawnTasks();

    const allQueued = [...spawnA.memory.spawnList!, ...spawnB.memory.spawnList!];
    for (const configName of configNames) {
      expect(allQueued.filter((queued) => queued === configName)).toHaveLength(1);
    }
    expect(spawnA.memory.spawnList).toEqual([configNames[0], configNames[2]]);
    expect(spawnB.memory.spawnList).toEqual([configNames[1], configNames[3]]);
  };

  const scenarioStaleOwner = () => {
    const room = createRoom("E4N63");
    const inactive = createSpawn(room, "E4N63-spawn-a", false);
    const active = createSpawn(room, "E4N63-spawn-b", true);
    Game.rooms[room.name] = room;
    Game.spawns[inactive.name] = inactive;
    Game.spawns[active.name] = active;
    addLiveCarrier(room);

    const worker = `${room.name}:worker:0`;
    const spawnOnce = `${room.name}:war:once`;
    const queuedAt = Game.time - 25;
    Memory.data = { creepConfigs: {
      [worker]: { role: "worker", args: [], roomName: room.name },
      [spawnOnce]: {
        role: "claimer",
        args: [],
        roomName: room.name,
        spawnOnce: { queuedAt },
      },
    } } as Memory["data"];
    inactive.memory.spawnList = [worker, spawnOnce];

    scheduleSpawnTasks();

    expect(inactive.memory.spawnList).toEqual([]);
    expect(active.memory.spawnList).toEqual(expect.arrayContaining([worker, spawnOnce]));
    expect(active.memory.spawnList!.filter((name) => name === worker)).toHaveLength(1);
    expect(active.memory.spawnList!.filter((name) => name === spawnOnce)).toHaveLength(1);
    expect(Memory.data.creepConfigs![spawnOnce].spawnOnce?.queuedAt).toBe(queuedAt);
  };

  const scenarioSpawningDedupe = () => {
    const room = createRoom("E4N64");
    const spawnA = createSpawn(room, "E4N64-spawn-a");
    const spawnB = createSpawn(room, "E4N64-spawn-b");
    Game.rooms[room.name] = room;
    Game.spawns[spawnA.name] = spawnA;
    Game.spawns[spawnB.name] = spawnB;
    addLiveCarrier(room);

    const configName = `${room.name}:worker:0`;
    Memory.data = { creepConfigs: {
      [configName]: { role: "worker", args: [], roomName: room.name },
    } } as Memory["data"];
    Memory.creeps["worker-spawning"] = { configName } as CreepMemory;
    spawnA.spawning = {
      name: "worker-spawning",
      remainingTime: 3,
      needTime: 9,
    } as Spawning;
    spawnA.memory.spawnList = [configName];
    spawnB.memory.spawnList = [configName];

    scheduleSpawnTasks();

    expect(spawnA.memory.spawnList).not.toContain(configName);
    expect(spawnB.memory.spawnList).not.toContain(configName);
    expect(spawnA.spawning?.name).toBe("worker-spawning");
  };

  const scenarioOwnerTokens = () => {
    const sourceRoom = "W4N4";
    const sharedTarget = "E3N60";
    const uniqueTarget = "E4N60";
    const room = createRoom(sourceRoom, 8);
    const spawn = createSpawn(room, `${sourceRoom}-spawn`);
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    addLiveCarrier(room);

    const taskA = "bank-task-a";
    const taskB = "bank-task-b";
    const taskC = "bank-task-c";
    const configA = getPowerBankConfigName(sourceRoom, sharedTarget, "hauler", 0, taskA, 0);
    const configB = getPowerBankConfigName(sourceRoom, sharedTarget, "hauler", 0, taskB, 0);
    const ambiguousLegacy = getPowerBankConfigName(sourceRoom, sharedTarget, "hauler", 1);
    const exhaustedLegacy = getPowerBankConfigName(sourceRoom, uniqueTarget, "hauler", 0);
    const task = (id: string, targetRoom: string, exhausted: boolean): PowerBankHarvestTask => ({
      id,
      sourceRoom,
      targetRoom,
      status: "hauling",
      haulingEmptySince: exhausted ? Game.time - 1 : undefined,
    } as PowerBankHarvestTask);
    Memory.data = {
      powerBankHarvest: {
        [taskA]: task(taskA, sharedTarget, true),
        [taskB]: task(taskB, sharedTarget, false),
        [taskC]: task(taskC, uniqueTarget, true),
      },
      creepConfigs: {
        [configA]: { role: "powerBankHauler", args: [sharedTarget, ""], roomName: sourceRoom },
        [configB]: { role: "powerBankHauler", args: [sharedTarget, ""], roomName: sourceRoom },
        [ambiguousLegacy]: {
          role: "powerBankHauler",
          args: [sharedTarget, ""],
          roomName: sourceRoom,
        },
        [exhaustedLegacy]: {
          role: "powerBankHauler",
          args: [uniqueTarget, ""],
          roomName: sourceRoom,
        },
      },
    } as unknown as Memory["data"];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(configA);
    expect(spawn.memory.spawnList).toContain(configB);
    expect(spawn.memory.spawnList).toContain(ambiguousLegacy);
    expect(spawn.memory.spawnList).not.toContain(exhaustedLegacy);
  };

  it("分布/陈旧回收/去重/PowerBank token 覆盖同一合同面", () => {
    scenarioDistribute();
    resetScenarioWorld();
    scenarioStaleOwner();
    resetScenarioWorld();
    scenarioSpawningDedupe();
    resetScenarioWorld();
    scenarioOwnerTokens();
  });
});

describe("spawnPlanner powerbank combat guard 重合同", () => {
  function setupCombatRoom(roomName = "E3N59"): { room: Room; spawn: StructureSpawn } {
    const room = createRoom(roomName, 7);
    const spawn = createSpawn(room, `${roomName}-spawn`);
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    addLiveCarrier(room);
    return { room, spawn };
  }

  function makeCombatConfig(
    sourceRoom: string,
    taskId: string | undefined,
  ): { name: string; config: Record<string, unknown> } {
    const name = getPowerBankConfigName(sourceRoom, "E0N60", "attacker", 0, taskId ?? "orphan-task", 0);
    return {
      name,
      config: {
        role: "powerBankAttacker",
        args: ["E0N60", `${sourceRoom}|E0N60`],
        roomName: sourceRoom,
        taskId,
      },
    };
  }

  const scenarioPruneHauling = () => {
    const { spawn } = setupCombatRoom();
    const config = makeCombatConfig("E3N59", "task-hauling");
    Memory.data = {
      powerBankHarvest: {
        "task-hauling": {
          id: "task-hauling",
          sourceRoom: "W1N57",
          targetRoom: "E0N60",
          status: "hauling",
        } as PowerBankHarvestTask,
      },
      creepConfigs: { [config.name]: config.config },
    } as unknown as Memory["data"];
    spawn.memory.spawnList = [config.name];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(config.name);
    expect(Memory.data.creepConfigs?.[config.name]).toBeUndefined();
  };

  const scenarioPruneSource = () => {
    const { spawn } = setupCombatRoom();
    const config = makeCombatConfig("E3N59", "task-rediscovered");
    Memory.data = {
      powerBankHarvest: {
        "task-rediscovered": {
          id: "task-rediscovered",
          sourceRoom: "W1N57",
          targetRoom: "E0N60",
          status: POWER_BANK_STATUS.SPAWNING,
        } as PowerBankHarvestTask,
      },
      creepConfigs: { [config.name]: config.config },
    } as unknown as Memory["data"];
    spawn.memory.spawnList = [config.name];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(config.name);
    expect(Memory.data.creepConfigs?.[config.name]).toBeUndefined();
  };

  const scenarioPruneOrphan = () => {
    const { spawn } = setupCombatRoom();
    const config = makeCombatConfig("E3N59", "task-gone");
    Memory.data = {
      creepConfigs: { [config.name]: config.config },
    } as unknown as Memory["data"];
    spawn.memory.spawnList = [config.name];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(config.name);
    expect(Memory.data.creepConfigs?.[config.name]).toBeUndefined();
  };

  const scenarioQueueActive = () => {
    const { spawn } = setupCombatRoom();
    const config = makeCombatConfig("E3N59", "task-active");
    Memory.data = {
      powerBankHarvest: {
        "task-active": {
          id: "task-active",
          sourceRoom: "E3N59",
          targetRoom: "E0N60",
          status: POWER_BANK_STATUS.SPAWNING,
        } as PowerBankHarvestTask,
      },
      creepConfigs: { [config.name]: config.config },
    } as unknown as Memory["data"];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).toContain(config.name);
    expect(Memory.data.creepConfigs?.[config.name]).toBeDefined();
  };

  const scenarioRetiredAlive = () => {
    const { room, spawn } = setupCombatRoom();
    const config = makeCombatConfig("E3N59", "task-hauling-live");
    Game.creeps["powerBankAttacker-live"] = {
      name: "powerBankAttacker-live",
      room,
      memory: { role: "powerBankAttacker", configName: config.name },
    } as Creep;
    Memory.data = {
      powerBankHarvest: {
        "task-hauling-live": {
          id: "task-hauling-live",
          sourceRoom: "E3N59",
          targetRoom: "E0N60",
          status: "hauling",
        } as PowerBankHarvestTask,
      },
      creepConfigs: { [config.name]: config.config },
    } as unknown as Memory["data"];
    spawn.memory.spawnList = [config.name];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(config.name);
    expect(Memory.data.creepConfigs?.[config.name]).toBeDefined();
  };

  it("修剪（hauling/前源房/孤儿任务）与保活排队（活跃任务/退役保活）覆盖同一合同面", () => {
    scenarioPruneHauling();
    resetScenarioWorld();
    scenarioPruneSource();
    resetScenarioWorld();
    scenarioPruneOrphan();
    resetScenarioWorld();
    scenarioQueueActive();
    resetScenarioWorld();
    scenarioRetiredAlive();
  });
});

describe("spawnPlanner powerbank combat guard edge cases 重合同", () => {
  function setupCombatRoom(roomName = "E3N59"): { room: Room; spawn: StructureSpawn } {
    const room = createRoom(roomName, 7);
    const spawn = createSpawn(room, `${roomName}-spawn`);
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;
    addLiveCarrier(room);
    return { room, spawn };
  }

  function makeCombatConfigEntry(options: {
    sourceRoom: string;
    taskId?: string;
    role?: "powerBankAttacker" | "powerBankHealer";
    index?: number;
    generation?: number;
  }): { name: string; config: Record<string, unknown> } {
    const taskId = options.taskId ?? "task-edge";
    const name = getPowerBankConfigName(
      options.sourceRoom,
      "E0N60",
      options.role === "powerBankHealer" ? "healer" : "attacker",
      options.index ?? 0,
      taskId,
      options.generation ?? 0,
    );
    return {
      name,
      config: {
        role: options.role ?? "powerBankAttacker",
        args: ["E0N60", `${options.sourceRoom}|E0N60`],
        roomName: options.sourceRoom,
        taskId,
        powerBankGeneration: options.generation ?? 0,
      },
    };
  }

  const scenarioReinforce = () => {
    const { spawn } = setupCombatRoom();
    const reinforcement = makeCombatConfigEntry({
      sourceRoom: "E3N59",
      taskId: "task-reinforcement",
      index: 1,
      generation: 1,
    });
    Memory.data = {
      powerBankHarvest: {
        "task-reinforcement": {
          id: "task-reinforcement",
          sourceRoom: "E3N59",
          targetRoom: "E0N60",
          status: POWER_BANK_STATUS.ATTACKING,
          reinforcement: { index: 1, generation: 1, stage: "spawning" },
        } as PowerBankHarvestTask,
      },
      creepConfigs: { [reinforcement.name]: reinforcement.config },
    } as unknown as Memory["data"];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).toContain(reinforcement.name);
    expect(Memory.data.creepConfigs?.[reinforcement.name]).toBeDefined();
  };

  const scenarioSpawningRetired = () => {
    const { room, spawn } = setupCombatRoom();
    const config = makeCombatConfigEntry({ sourceRoom: "E3N59", taskId: "task-spawning" });
    Memory.creeps["powerBankHealer-spawning"] = {
      configName: config.name,
      role: "powerBankHealer",
    } as CreepMemory;
    spawn.spawning = {
      name: "powerBankHealer-spawning",
      remainingTime: 10,
      needTime: 40,
    } as Spawning;
    Memory.data = {
      powerBankHarvest: {
        "task-spawning": {
          id: "task-spawning",
          sourceRoom: "E3N59",
          targetRoom: "E0N60",
          status: "hauling",
        } as PowerBankHarvestTask,
      },
      creepConfigs: { [config.name]: config.config },
    } as unknown as Memory["data"];
    spawn.memory.spawnList = [config.name];

    scheduleSpawnTasks();

    expect(spawn.memory.spawnList).not.toContain(config.name);
    expect(Memory.data.creepConfigs?.[config.name]).toBeDefined();
    expect(spawn.spawning?.name).toBe("powerBankHealer-spawning");
    expect(room).toBeDefined();
  };

  const scenarioDefense = () => {
    (isDefenseMode as jest.Mock).mockReturnValue(true);
    try {
      const { spawn } = setupCombatRoom();
      const config = makeCombatConfigEntry({ sourceRoom: "E3N59", taskId: "task-defense" });
      Memory.data = {
        powerBankHarvest: {
          "task-defense": {
            id: "task-defense",
            sourceRoom: "E3N59",
            targetRoom: "E0N60",
            status: POWER_BANK_STATUS.SPAWNING,
          } as PowerBankHarvestTask,
        },
        creepConfigs: { [config.name]: config.config },
      } as unknown as Memory["data"];

      scheduleSpawnTasks();

      expect(spawn.memory.spawnList).not.toContain(config.name);
      expect(Memory.data.creepConfigs?.[config.name]).toBeDefined();
    } finally {
      (isDefenseMode as jest.Mock).mockReturnValue(false);
    }
  };

  it("增援与孵化中退役覆盖同一合同面", () => {
    scenarioReinforce();
    resetScenarioWorld();
    scenarioSpawningRetired();
  });

  it("defense 模式下跳过战斗配置排队", () => {
    scenarioDefense();
  });
});


it("RESERVE 下调度已投入战争搭档，不启动同源新战争", () => {
  resetScenarioWorld();
  const room = createRoom("W1N1");
  const spawn = createSpawn(room, "S");
  Game.rooms = { W1N1: room }; Game.spawns = { S: spawn }; addLiveCarrier(room);
  Game.flags = { RESERVE: { name: "RESERVE", pos: { roomName: room.name } } as Flag };
  const red = "W1N1:war:W2N2:meleeAttacker:0", green = "W1N1:war:W2N2:healer:0", fresh = "W1N1:war:W3N3:healer:0";
  Memory.data = { creepConfigs: {
    [red]: { role: "meleeAttacker", roomName: room.name, args: ["W2N2"], body: [ATTACK, MOVE] },
    [green]: { role: "healer", roomName: room.name, args: ["W2N2"], body: [HEAL, MOVE] },
    [fresh]: { role: "healer", roomName: room.name, args: ["W3N3"], body: [HEAL, MOVE] },
  }, war: {
    W2N2: { targetRoom: "W2N2", sourceRoom: room.name, status: "clearing", reason: "manual", attempts: 1,
      createdAt: Game.time - 1, updatedAt: Game.time, members: { [red]: { configName: red, creepNames: [], spawnedAt: Game.time - 1 } } },
    W3N3: { targetRoom: "W3N3", sourceRoom: room.name, status: "clearing", reason: "manual", attempts: 1,
      createdAt: Game.time, updatedAt: Game.time },
  } };
  Game.creeps.red = { name: "red", room, memory: { role: "meleeAttacker", configName: red }, ticksToLive: 1000 } as Creep;
  scheduleSpawnTasks();
  expect(spawn.memory.spawnList).toContain(green);
  expect(spawn.memory.spawnList).not.toContain(fresh);
});
