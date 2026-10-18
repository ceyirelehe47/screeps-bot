import { createProcessScheduler, resetProcessSchedulerForTest } from "@/runtime/processScheduler";
import { PROCESS_SPECS, RUNTIME_PROCESSES, type RuntimeProcessId } from "@/runtime/processTable";
import { resetRuntimeServices } from "@mock/movement";

beforeEach(() => {
  resetRuntimeServices(); resetProcessSchedulerForTest(); Game.time = 100;
  Memory.runtime = {}; Game.cpu = { ...Game.cpu, bucket: 10000, limit: 120, tickLimit: 500, getUsed: jest.fn(() => 0) };
});

it("生产表无遗漏或重复、依赖可满足，防御先于市场/规划，出生先于 creep 执行", () => {
  const ids: readonly string[] = RUNTIME_PROCESSES.map(spec => spec.id);
  expect(ids).toHaveLength(42); expect(new Set(ids).size).toBe(ids.length);
  expect(ids.slice(0, 5)).toEqual(["announceDeploy", "coreDefense", "defenseMode", "homeDefense", "towerControl"]);
  for (const spec of PROCESS_SPECS.values()) {
    for (const dependency of [...spec.after ?? [], ...spec.requires ?? []]) expect(ids.indexOf(dependency)).toBeLessThan(ids.indexOf(spec.id));
  }
  expect(PROCESS_SPECS.get("marketSalePreflight")?.tier).toBe("T2");
  expect(ids.indexOf("spawnWork")).toBeLessThan(ids.indexOf("creepWork"));
});

it("低 bucket 真正延后可选工作，所有 T0/T1 仍执行且摘要独立于 profiler", () => {
  Game.cpu.bucket = 1;
  const visited: string[] = [];
  const work = Object.fromEntries(RUNTIME_PROCESSES.map(spec => [spec.id, () => { visited.push(spec.id); }])) as Record<RuntimeProcessId, () => void>;
  const runner = createProcessScheduler((_id, execute) => execute(), jest.fn());
  runner.runAll(work); runner.finish();
  expect(visited).toEqual(RUNTIME_PROCESSES.filter(spec => spec.tier === "T0" || spec.tier === "T1").map(spec => spec.id));
  expect(Memory.runtime!.processScheduler!.lastDeferred).toContainEqual({ phase: "marketSalePreflight", reason: "bucket" });
});

it("为后续关键阶段预留 EMA，而不是只看当前 used；T1 即使超预算仍执行", () => {
  Memory.runtime!.processScheduler = { updatedAt: 99, estimates: { creepWork: 90, spawnWork: 10 }, circuits: {}, deferred: {}, failures: {}, lastDeferred: [] };
  Game.cpu.limit = 100; Game.cpu.getUsed = jest.fn(() => 60);
  const measure = jest.fn((_id: string, work: () => void) => work());
  const runner = createProcessScheduler(measure, jest.fn());
  runner.runPhase("marketSalePreflight", () => undefined);
  runner.runPhase("creepWork", () => undefined); runner.finish();
  expect(measure.mock.calls.map(call => call[0])).toEqual(["creepWork"]);
  expect(Memory.runtime!.processScheduler!.lastDeferred).toContainEqual({ phase: "marketSalePreflight", reason: "cpu" });
});

it("可选阶段连续失败进入有界熔断并到期重试，防御持续失败也每 tick 尝试", () => {
  const failed = jest.fn(() => { throw new Error("failed"); }), report = jest.fn();
  for (let tick = 100; tick < 104; tick++) {
    Game.time = tick;
    const runner = createProcessScheduler((_id, work) => work(), report);
    runner.runPhase("hubUpgradeControl", failed); runner.runPhase("towerControl", failed); runner.finish();
  }
  expect(failed).toHaveBeenCalledTimes(7);
  expect(Memory.runtime!.processScheduler!.circuits.hubUpgradeControl.until).toBe(110);
  expect(Memory.runtime!.processScheduler!.circuits.towerControl).toBeUndefined();
  Game.time = 110;
  const runner = createProcessScheduler((_id, work) => work(), report);
  const recovered = jest.fn(); runner.runPhase("hubUpgradeControl", recovered); runner.finish();
  expect(recovered).toHaveBeenCalledTimes(1);
  expect(Memory.runtime!.processScheduler!.circuits.hubUpgradeControl).toBeUndefined();
});

it("预检失败使依赖阶段延后，错误报告失败仍不阻断防御；未知进程被拒绝", () => {
  const runner = createProcessScheduler((_id, work) => work(), () => { throw new Error("logger"); });
  runner.runPhase("marketSalePreflight", () => { throw new Error("preflight"); });
  const unsafe = jest.fn(), defend = jest.fn();
  runner.runPhase("resourceControl", unsafe); runner.runPhase("marketSaleAutomation", unsafe);
  runner.runPhase("towerControl", defend);
  expect(unsafe).not.toHaveBeenCalled(); expect(defend).toHaveBeenCalledTimes(1);
  expect(() => runner.runPhase("unknown", () => undefined)).toThrow("unregistered process");
});

it("重建时延后规划两 tick，恢复后执行；累计摘要跨 heap 保留", () => {
  const planner = jest.fn();
  const first = createProcessScheduler((_id, work) => work(), jest.fn());
  first.runPhase("hubPlanner", planner); first.finish();
  expect(planner).not.toHaveBeenCalled();
  Game.time += 2;
  const next = createProcessScheduler((_id, work) => work(), jest.fn());
  next.runPhase("hubPlanner", planner); next.finish(); expect(planner).toHaveBeenCalledTimes(1);
  resetProcessSchedulerForTest(); Game.time++;
  const reset = createProcessScheduler((_id, work) => work(), jest.fn());
  reset.runPhase("hubPlanner", planner); reset.finish();
  expect(Memory.runtime!.processScheduler!.deferred.hubPlanner).toBe(2);
});

it("引擎每 tick 更换 Game 对象时保持 heap 起点，T3/T4 只在真正重置后延迟两 tick", () => {
  const originalGame = Game;
  const planner = jest.fn(), observer = jest.fn();
  try {
    for (let tick = 100; tick < 105; tick++) {
      Object.assign(global, { Game: { ...originalGame, time: tick } });
      const runner = createProcessScheduler((_id, work) => work(), jest.fn());
      runner.runPhase("hubPlanner", planner); runner.runPhase("externalTelemetryExport", observer); runner.finish();
    }
    expect(planner).toHaveBeenCalledTimes(3);
    expect(observer).toHaveBeenCalledTimes(3);
    expect(Memory.runtime!.processScheduler!.deferred.hubPlanner).toBe(2);
    expect(Memory.runtime!.processScheduler!.lastDeferred).toEqual([]);
  } finally { Object.assign(global, { Game: originalGame }); }
});


it("市场重预检被 CPU 延后时，廉价安全闸仍每 tick 执行", () => {
  const { enforceLegacyMarketSafetyLatch } = require("./marketSaleConfig") as typeof import("./marketSaleConfig");
  Game.cpu.bucket = 1;
  Memory.cfg = { pixelGenerator: { enabled: true }, factoryControl: { market: { enabled: true } }, resourceControl: { market: { enabled: true } } } as Memory["cfg"];
  const work = Object.fromEntries(RUNTIME_PROCESSES.map(spec => [spec.id, spec.id === "marketSafetyLatch" ? enforceLegacyMarketSafetyLatch : () => undefined])) as Record<RuntimeProcessId, () => void>;
  const runner = createProcessScheduler((_id, execute) => execute(), jest.fn()); runner.runAll(work);
  expect(Memory.cfg!.pixelGenerator!.enabled).toBe(false);
  expect(Memory.cfg!.factoryControl!.market!.enabled).toBe(false);
  expect(Memory.cfg!.resourceControl!.market!.enabled).toBe(false);
});
