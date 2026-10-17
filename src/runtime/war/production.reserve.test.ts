jest.mock("@/runtime/defenseMode", () => ({ isDefenseMode: jest.fn(() => false) }));
import { enqueueConfig, prepareCombatSquad } from "@/runtime/war/production";
import { isDefenseMode } from "@/runtime/defenseMode";
import * as boosts from "@/runtime/powerBankBoost";
import type { WarTask } from "@/runtime/war/store";

beforeEach(() => {
  jest.restoreAllMocks(); jest.mocked(isDefenseMode).mockReturnValue(false);
  delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
  Game.time++; Game.creeps = {}; Memory.creeps = {}; Memory.cfg = {}; Memory.runtime = {};
  Game.flags = { RESERVE: { name: "RESERVE", pos: { roomName: "W1N1" } } as Flag };
  Memory.data = { creepConfigs: {}, war: {} };
});
function setup() {
  const red = "W1N1:war:W2N2:g1:meleeAttacker:0", green = "W1N1:war:W2N2:g1:healer:0";
  const task = { targetRoom: "W2N2", sourceRoom: "W1N1", status: "staging", squad: "t3Duo", boostTier: "t3",
    activeGeneration: { id: 1, phase: "preparing", createdAt: Game.time, boostTaskId: "boost",
      configNames: { meleeAttacker: red, healer: green } } } as WarTask;
  Memory.data!.war!.W2N2 = task;
  Memory.data!.creepConfigs![green] = { role: "healer", roomName: "W1N1", args: ["W2N2"], spawnOnce: {} };
  const spawn = { room: { name: "W1N1" }, memory: { spawnList: [] } } as unknown as StructureSpawn;
  Game.spawns = { S: spawn };
  return { task, red, green, spawn };
}
it("RESERVE 下在途搭档可由 war 生产者排队，陌生和新任务不排队", () => {
  const { task, red, green, spawn } = setup();
  enqueueConfig(spawn, green, true);
  expect(spawn.memory.spawnList).toEqual([]);
  expect(Memory.data!.creepConfigs![green].spawnOnce!.queuedAt).toBeUndefined();
  task.members = { [red]: { configName: red, creepNames: ["red"], spawnedAt: Game.time - 1 } };
  Game.time++;
  Game.creeps.red = { name: "red", room: { name: "W1N1" }, memory: { configName: red } } as Creep;
  enqueueConfig(spawn, green, true);
  expect(spawn.memory.spawnList).toEqual([green]);
  expect(Memory.data!.creepConfigs![green].spawnOnce!.queuedAt).toBe(Game.time);
  spawn.memory.spawnList = [];
  jest.mocked(isDefenseMode).mockReturnValue(true);
  enqueueConfig(spawn, green, true);
  expect(spawn.memory.spawnList).toEqual([]);
});
it("已投入战争的强化准备可继续，新任务与防御模式仍保留门控", () => {
  const { task, red } = setup();
  const prepare = jest.spyOn(boosts, "prepareBoosts").mockReturnValue({ status: "ready", labs: [] });
  expect(prepareCombatSquad(task)).toBe(false);
  expect(prepare).not.toHaveBeenCalled();
  task.members = { [red]: { configName: red, creepNames: ["red"], spawnedAt: Game.time - 1 } };
  Game.time++;
  Game.creeps.red = { name: "red", room: { name: "W1N1" }, memory: { configName: red } } as Creep;
  expect(prepareCombatSquad(task)).toBe(true);
  expect(prepare).toHaveBeenCalledTimes(1);
  task.activeGeneration!.phase = "preparing";
  jest.mocked(isDefenseMode).mockReturnValue(true);
  expect(prepareCombatSquad(task)).toBe(false);
  expect(prepare).toHaveBeenCalledTimes(1);
});
