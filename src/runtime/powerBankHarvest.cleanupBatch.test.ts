jest.mock("@/runtime/powerBankObserver", () => ({
  hasPowerBankObserverCoverage: () => true,
  requestPowerBankObservation: jest.fn(),
  getPowerBankRoomThreat: () => false,
}));

import { runPowerBankHarvest } from "@/runtime/powerBankHarvest";
import { getPowerBankConfigName, POWER_BANK_STATUS } from "@/runtime/powerBankConstants";
import { getTickContextService } from "@/runtime/runtimeServices";
import type { CreepConfig } from "@/types/system";

function setupRoom(name: string): StructureSpawn {
  const room = { name, controller: { my: true, level: 8 }, find: () => [] } as unknown as Room;
  Game.rooms[name] = room;
  const spawn = {
    id: `${name}-spawn`, name: `${name}-spawn`, room,
    memory: { spawnList: [] }, spawning: null,
  } as unknown as StructureSpawn;
  Game.spawns[spawn.name] = spawn;
  return spawn;
}

function addConfig(name: string, taskId = "orphan"): void {
  Memory.data!.creepConfigs![name] = { role: "powerBankAttacker", args: [], taskId } as CreepConfig;
}

function task(id: string, sourceRoom = "E5N55"): PowerBankHarvestTask {
  return {
    id, sourceRoom, targetRoom: "E0N60", status: POWER_BANK_STATUS.PREPARING_BOOSTS,
    bankId: id, bankPos: { x: 25, y: 25 }, hits: 2_000_000, power: 5000,
    ticksToDecay: 5000, freeTiles: 8, discoveredTick: Game.time, lastSeenTick: Game.time,
    stageEnteredAt: Game.time, lastProgressAt: Game.time, bankExpiresAt: Game.time + 5000,
    nextAttemptAt: Game.time + 10, haulerIds: [], boostLabs: [], compoundTransferTaskIds: [],
  };
}

describe("PowerBank 批量配置清理", () => {
  beforeEach(() => {
    delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
    Game.time += 1;
    Game.rooms = {}; Game.spawns = {}; Game.creeps = {};
    Memory.creeps = {};
    Memory.data = { creepConfigs: {}, powerBankHarvest: {}, powerBankHarvestHistory: [] };
    Memory.runtime = {};
  });

  it("一批孤儿只过滤每个队列一次，保留其他队列项及其顺序", () => {
    const names = Array.from({ length: 64 }, (_, index) => `E5N55:powerbank:E0N60:attacker:${index}`);
    names.forEach(name => addConfig(name));
    const spawns = Array.from({ length: 8 }, (_, index) => setupRoom(`E${index + 1}N55`));
    const filters = spawns.map(spawn => {
      const queue = ["worker-a", ...names, "worker-b", names[0], "worker-c"];
      const filter = jest.spyOn(queue, "filter");
      spawn.memory.spawnList = queue;
      return filter;
    });
    const byRoom = jest.spyOn(getTickContextService(), "getSpawnsByRoom");
    runPowerBankHarvest();
    spawns.forEach(spawn => expect(spawn.memory.spawnList).toEqual(["worker-a", "worker-b", "worker-c"]));
    filters.forEach(filter => expect(filter).toHaveBeenCalledTimes(1));
    expect(byRoom).toHaveBeenCalledTimes(8);
    expect(Memory.data!.creepConfigs).toEqual({});
  });

  it("清除旧排队项，但保留活 creep 与正在出生者的配置", () => {
    const spawn = setupRoom("E5N55");
    const names = ["live", "spawning", "idle"].map(role => `E5N55:powerbank:E0N60:attacker:${role}`);
    names.forEach(name => addConfig(name));
    spawn.memory.spawnList = names.slice();
    Game.creeps.actor = { name: "actor", room: spawn.room, memory: { configName: names[0], role: "powerBankAttacker" } } as Creep;
    Memory.creeps.baby = { configName: names[1] } as CreepMemory;
    spawn.spawning = { name: "baby" } as Spawning;
    runPowerBankHarvest();
    expect(spawn.memory.spawnList).toEqual([]);
    expect(Object.keys(Memory.data!.creepConfigs!)).toEqual(names.slice(0, 2));
  });

  it("保留当前任务的旧来源配置和 legacy scope，不误删不同任务", () => {
    const spawn = setupRoom("E5N55");
    const current = task("active");
    Memory.data!.powerBankHarvest![current.id] = current;
    const legacy = getPowerBankConfigName(current.sourceRoom, current.targetRoom, "attacker", 0);
    const previous = getPowerBankConfigName("E6N55", current.targetRoom, "attacker", 0, current.id, 0);
    const orphan = getPowerBankConfigName(current.sourceRoom, current.targetRoom, "healer", 0, "orphan", 0);
    addConfig(legacy); delete Memory.data!.creepConfigs![legacy].taskId;
    addConfig(previous, current.id); addConfig(orphan);
    spawn.memory.spawnList = [legacy, orphan, previous];
    runPowerBankHarvest();
    expect(spawn.memory.spawnList).toEqual([legacy, previous]);
    expect(Memory.data!.creepConfigs![legacy]).toBeDefined();
    expect(Memory.data!.creepConfigs![previous]).toBeDefined();
    expect(Memory.data!.creepConfigs![orphan]).toBeUndefined();
  });

  it("同 tick 再次执行会重读新配置和队列，不复用清理计划", () => {
    const spawn = setupRoom("E5N55");
    const first = "E5N55:powerbank:E0N60:attacker:first";
    const second = "E5N55:powerbank:E0N60:attacker:second";
    addConfig(first); spawn.memory.spawnList = [first, "worker"];
    runPowerBankHarvest();
    addConfig(second); spawn.memory.spawnList!.push(second);
    runPowerBankHarvest();
    expect(spawn.memory.spawnList).toEqual(["worker"]);
    expect(Memory.data!.creepConfigs).toEqual({});
  });
});
