import { createTickCpuProfiler } from "@/runtime/cpuPhaseProfiler";
import { resetCpuTickHealthForTests } from "@/runtime/cpuTickHealth";
import { resetCpuMonitorStore } from "@/runtime/cpuMonitor";

describe("CPU 中断与重建诊断", () => {
  beforeEach(() => {
    resetCpuMonitorStore();
    resetCpuTickHealthForTests();
    Game.time = 100;
    Memory.analytics = undefined; Memory.runtime = {};
    Memory.cfg = { cpuProfiler: { enabled: true, sampleInterval: 7, historyLimit: 120 } };
    Game.cpu = { ...Game.cpu, limit: 120, tickLimit: 500, bucket: 10000, getUsed: jest.fn(() => 0) };
    Game.shard = { name: "shard1" } as Game["shard"];
  });
  function seedMonitor(): void {
    Game.time = 98;
    createTickCpuProfiler().flush();
    Game.time = 100;
  }
  it("非采样 tick 保存完成信息，不调用 getUsed", () => {
    seedMonitor();
    jest.mocked(Game.cpu.getUsed).mockClear();
    const profiler = createTickCpuProfiler();
    profiler.measure("remoteMining", () => undefined);
    profiler.flush();
    expect(Game.cpu.getUsed).not.toHaveBeenCalled();
    expect(Memory.analytics!.cpuMonitor!.health).toMatchObject({ globalStarts: 1, lastCompletedAt: 100 });
  });
  it("heap 保留时下一 tick 可记录未 flush 的阶段和 creep", () => {
    seedMonitor();
    const profiler = createTickCpuProfiler();
    expect(() => profiler.measure("creepWork", () => profiler.measureCreep({ name: "actor" } as Creep, () => {
      throw new Error("模拟中断");
    }))).toThrow("模拟中断");
    Game.time += 1;
    createTickCpuProfiler().flush();
    expect(Memory.analytics!.cpuMonitor!.health!.lastIncomplete).toEqual({ tick: 100, phase: "creepWork", creep: "actor" });
  });
  it("global 丢失时只记录重建和完成 tick 缺口，不伪造阶段", () => {
    seedMonitor();
    createTickCpuProfiler().flush();
    resetCpuTickHealthForTests();
    Game.time = 103;
    createTickCpuProfiler().flush();
    expect(Memory.analytics!.cpuMonitor!.health).toMatchObject({
      globalStarts: 2, lastGlobalStartAt: 103,
      lastGap: { afterTick: 100, resumedAt: 103, skippedTicks: 2 },
    });
    expect(Memory.analytics!.cpuMonitor!.health!.lastIncomplete).toBeUndefined();
  });
  it("profiler 关闭且 heap 重建后，从已保存的未完成帧恢复阶段和实体", () => {
    Memory.cfg = { cpuProfiler: { enabled: false } };
    const profiler = createTickCpuProfiler();
    expect(() => profiler.measure("creepWork", () => profiler.measureCreep({ name: "actor" } as Creep, () => {
      throw new Error("模拟可保存的未完成帧");
    }))).toThrow();
    expect(Memory.runtime!.cpuTickHealth!.checkpoint).toMatchObject({ tick: 100, phase: "creepWork", creep: "actor", completed: false });
    resetCpuTickHealthForTests(); Game.time++;
    createTickCpuProfiler().flush();
    expect(Memory.runtime!.cpuTickHealth!.summary.lastIncomplete).toEqual({ tick: 100, phase: "creepWork", creep: "actor" });
    expect(Game.cpu.getUsed).not.toHaveBeenCalled();
  });
  it("引擎丢弃硬终止帧且 heap 丢失时，只报告完成 tick 缺口，不伪造阶段", () => {
    Memory.cfg = { cpuProfiler: { enabled: false } };
    Game.time = 99; createTickCpuProfiler().flush();
    const saved = JSON.stringify(Memory.runtime);
    Game.time = 100;
    expect(() => createTickCpuProfiler().measure("creepWork", () => { throw new Error("模拟终止"); })).toThrow();
    // 引擎未返回 runResult 时不会序列化当帧 Memory；恢复最后已保存帧。
    Memory.runtime = JSON.parse(saved); resetCpuTickHealthForTests(); Game.time = 101;
    createTickCpuProfiler().flush();
    expect(Memory.runtime!.cpuTickHealth!.summary.lastGap).toEqual({ afterTick: 99, resumedAt: 101, skippedTicks: 1 });
    expect(Memory.runtime!.cpuTickHealth!.summary.lastIncomplete).toBeUndefined();
  });
});
