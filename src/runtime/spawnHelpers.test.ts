import { enqueueConfig, getSpawnQueueLoad, isConfigSpawning, removeQueuedSpawnConfig, selectLeastLoadedSpawn } from "@/runtime/spawnHelpers";
import { jsonCommand } from "@/runtime/console/jsonCommand";

describe("共用 Spawn 与 console 包装", () => {
  const spawn = (name: string, queue: string[] = [], spawning: string | null = null): StructureSpawn => ({
    name, spawning: spawning && { name: spawning }, memory: { spawnList: queue }, addTask: jest.fn(),
  } as unknown as StructureSpawn);
  it("负载包含孵化中项，平局按名称；计划负载由调用方提供", () => {
    const a = spawn("A", ["queued"]), b = spawn("B", [], "born"), source = [b, a];
    expect(getSpawnQueueLoad(b)).toBe(1); expect(selectLeastLoadedSpawn(source)).toBe(a);
    expect(selectLeastLoadedSpawn(source, item => item === b ? 0 : 2)).toBe(b);
    expect(source).toEqual([b, a]); expect(selectLeastLoadedSpawn([])).toBeUndefined();
  });
  it("来源范围保持显式，前插去重保序，后插使用 addTask", () => {
    const a = spawn("A", ["x", "target", "y", "target"]), b = spawn("B", [], "born");
    Memory.creeps = { born: { configName: "target" } } as any;
    expect(isConfigSpawning("target", [a])).toBe(false); expect(isConfigSpawning("target", [b])).toBe(true);
    enqueueConfig(a, "target", true); expect(a.memory.spawnList).toEqual(["target", "x", "y"]);
    enqueueConfig(a, "target", false); expect(a.addTask).not.toHaveBeenCalled();
    enqueueConfig(a, "new", false); expect(a.addTask).toHaveBeenCalledWith("new");
    removeQueuedSpawnConfig([a], "target"); expect(a.memory.spawnList).toEqual(["x", "y"]);
  });
  it("JSON、字符串透传、缩进、参数和异常保持原语义", () => {
    const raw = jest.fn((...args: unknown[]) => ({ args }));
    const command = jsonCommand(raw, 2); expect(command("x", undefined)).toBe(JSON.stringify({ args: ["x", undefined] }, null, 2));
    expect(raw).toHaveBeenCalledWith("x", undefined);
    expect(jsonCommand(() => "error")()).toBe('"error"'); expect(jsonCommand(() => "error", undefined, true)()).toBe("error");
    expect(() => jsonCommand(() => { throw new Error("original"); })()).toThrow("original");
  });
});
