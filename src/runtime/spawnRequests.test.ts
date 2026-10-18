import { consumeSpawnRequest, getAcceptedSpawnReceipts, getSpawnRequestRevision, hasAcceptedSpawn, readSpawnQueue, recordAcceptedSpawn, replaceSpawnQueue, requestSpawn } from "@/runtime/spawnRequests";
import { isConfigSpawning } from "@/runtime/spawnHelpers";

const spawn = (name: string): StructureSpawn => ({ name, memory: {}, spawning: null } as StructureSpawn);
beforeEach(() => { Game.time++; });

it("队列入口去重、前插保序，外部数组和旧读视图不能绕过 revision", () => {
  const source = spawn("A"), input = ["a", "b"];
  replaceSpawnQueue(source, input); const before = getSpawnRequestRevision();
  const view = readSpawnQueue(source); input.push("外部改写");
  expect(view).toEqual(["a", "b"]);
  expect(() => (view as string[]).push("非法改写")).toThrow();
  requestSpawn(source, "a"); expect(getSpawnRequestRevision()).toBe(before);
  requestSpawn(source, "b", true); expect(readSpawnQueue(source)).toEqual(["b", "a"]);
  expect(view).toEqual(["a", "b"]);
  expect(consumeSpawnRequest(source, "a")).toBe(false);
  expect(consumeSpawnRequest(source, "b")).toBe(true);
  expect(readSpawnQueue(source)).toEqual(["a"]);
});

it("成功出生收据在同 tick 可见且严格遵守查询来源范围，下一 tick 交给原生状态", () => {
  const a = spawn("A"), b = spawn("B"); Memory.creeps = {};
  recordAcceptedSpawn(a, "config", "baby");
  expect(hasAcceptedSpawn("config")).toBe(true);
  expect(isConfigSpawning("config", [b])).toBe(false);
  expect(isConfigSpawning("config", [a])).toBe(true);
  expect(getAcceptedSpawnReceipts()[0].creepName).toBe("baby");
  Game.time++;
  expect(hasAcceptedSpawn("config")).toBe(false);
  Object.assign(a, { spawning: { name: "baby" } }); Memory.creeps.baby = { configName: "config" } as CreepMemory;
  expect(isConfigSpawning("config", [a])).toBe(true);
});
