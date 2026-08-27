/**
 * Profiler 低开销模式回归测试（任务书阶段 E）：
 * - disabled / 非 sample tick 零 Game.cpu.getUsed 调用；
 * - roomRoleAggregation=false 时不逐 creep 成对计时；
 * - rolling summary 与批量实现等价；history 上限正确；phase 动态增删正确。
 */
import {
  createTickCpuProfiler,
  measureCreepDecision,
  measureCreepIntent,
  measureCreepPathing,
  resetPerCreepPhaseTimingCacheForTest,
  setActiveTickCpuProfiler,
} from "@/runtime/cpuPhaseProfiler";
import {
  computeCpuMonitorSummary,
  getCpuMonitorHistory,
  persistCpuMonitorSample,
  resetCpuMonitorStore,
  type CpuMonitorConfig,
  type CpuMonitorSnapshotV2,
} from "@/runtime/cpuMonitor";

function setupCpuMock(): { getUsed: jest.Mock } {
  const getUsed = jest.fn(() => 0);
  (Game as unknown as { cpu: unknown }).cpu = {
    getUsed,
    bucket: 10_000,
    limit: 500,
    tickLimit: 500,
    getHeapStatistics: undefined,
  };
  (Game as unknown as { shard?: unknown }).shard = { name: "shard0" };
  return { getUsed };
}

function profilerConfig(overrides: Partial<CpuMonitorConfig> = {}): void {
  Memory.cfg = Memory.cfg ?? {};
  (Memory.cfg as { cpuProfiler?: unknown }).cpuProfiler = {
    enabled: true,
    sampleInterval: 10,
    historyLimit: 5,
    emaAlpha: 0.1,
    roomRoleAggregation: true,
    heapStats: false,
    fixedActionCpuCost: 0.2,
    ...overrides,
  };
}

function makeCreep(name: string): Creep {
  return {
    name,
    memory: { role: "worker" },
    room: { name: "W1N1" },
    pos: { x: 1, y: 1, roomName: "W1N1" },
  } as unknown as Creep;
}

function makeSnapshot(tick: number, phases: Record<string, number>): CpuMonitorSnapshotV2 {
  return {
    tick,
    shard: "shard0",
    totalUsed: Object.values(phases).reduce((sum, value) => sum + value, 0),
    bucket: 9_000 + tick,
    limit: 500,
    tickLimit: 500,
    phases,
    fixedActionCounts: {},
    untracked: 0,
    emaTotalUsed: 0,
    rooms: {},
    heap: null,
  };
}

describe("cpu profiler low-overhead guarantees", () => {
  beforeEach(() => {
    resetCpuMonitorStore();
    resetPerCreepPhaseTimingCacheForTest();
    Memory.cfg = undefined;
    Memory.analytics = undefined;
    Game.time = 100;
    setupCpuMock();
  });

  it("profiler disabled 时不调用 Game.cpu.getUsed", () => {
    profilerConfig({ enabled: false });
    const { getUsed } = setupCpuMock();
    const profiler = createTickCpuProfiler();
    setActiveTickCpuProfiler(profiler);

    profiler.measure("phase", () => 1);
    profiler.measureCreep(makeCreep("c1"), () => undefined);
    profiler.measureRoomPhase("spawnWork", "W1N1", () => 1);
    profiler.recordFixedAction("creepWork");
    profiler.flush();

    expect(getUsed).not.toHaveBeenCalled();
  });

  it("非 sample tick 不调用 Game.cpu.getUsed", () => {
    profilerConfig({ sampleInterval: 10 });
    Game.time = 101; // 101 % 10 !== 0
    const profiler = createTickCpuProfiler();
    setActiveTickCpuProfiler(profiler);

    profiler.measure("phase", () => 1);
    profiler.measureCreep(makeCreep("c1"), () => undefined);
    profiler.flush();

    const gameCpu = (Game as unknown as { cpu: { getUsed: jest.Mock } }).cpu;
    expect(gameCpu.getUsed).not.toHaveBeenCalled();
  });

  it("roomRoleAggregation=false 时不逐 creep 成对计时且 fn 正常执行", () => {
    profilerConfig({ roomRoleAggregation: false, sampleInterval: 1 });
    Game.time = 100; // 100 % 1 === 0 → sample tick
    const { getUsed } = setupCpuMock();
    const profiler = createTickCpuProfiler();
    setActiveTickCpuProfiler(profiler);

    // 顶层 measure 仍成对计时（这里 1 对）+ flush 一对 + loopStart 一对。
    profiler.measure("creepWork", () => {
      const executed: string[] = [];
      for (const name of ["c1", "c2", "c3"]) {
        profiler.measureCreep(makeCreep(name), () => executed.push(name));
      }
      expect(executed).toEqual(["c1", "c2", "c3"]);
    });
    profiler.flush();

    // 每对 getUsed 对应一次 measure 或 flush 边界：3 个 creep 未引入额外计时对。
    // loopStart(1) + creepWork 成对(2) + flush total(1) = 4。
    expect(getUsed.mock.calls.length).toBeLessThanOrEqual(4);

    const analytics = Memory.analytics;
    expect(analytics?.cpuMonitor?.latest.rooms).toEqual({});
  });

  it("roomRoleAggregation=true 时仍逐 creep 计时（对照）", () => {
    profilerConfig({ roomRoleAggregation: true, sampleInterval: 1 });
    const { getUsed } = setupCpuMock();
    const profiler = createTickCpuProfiler();
    setActiveTickCpuProfiler(profiler);

    profiler.measure("creepWork", () => {
      for (const name of ["c1", "c2", "c3"]) {
        profiler.measureCreep(makeCreep(name), () => undefined);
      }
    });
    profiler.flush();

    // 3 个 creep × 每对 2 次 + 顶层与 flush 的计时。
    expect(getUsed.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(Memory.analytics?.cpuMonitor?.latest.rooms ?? {})).toContain("W1N1");
  });

  it("roomRoleAggregation=false 时三个 creep 细分 helper 不调用 Game.cpu.getUsed，fn 与 fixed-action 照常", () => {
    profilerConfig({ roomRoleAggregation: false, sampleInterval: 1 });
    Game.time = 100; // sample tick：顶层 measure 仍会计时
    const { getUsed } = setupCpuMock();
    const profiler = createTickCpuProfiler();
    setActiveTickCpuProfiler(profiler);

    const executed: string[] = [];
    profiler.measure("creepWork", () => {
      executed.push(measureCreepDecision(() => "decision"));
      executed.push(measureCreepPathing(() => "pathing"));
      executed.push(String(measureCreepIntent(() => OK)));
    });
    profiler.flush();

    expect(executed).toEqual(["decision", "pathing", String(OK)]);
    // loopStart(1) + creepWork 成对(2) + flush(1) = 4；三个细分 helper 未新增计时对。
    expect(getUsed.mock.calls.length).toBe(4);
    // intent fixed-action count 仍保留。
    expect(Memory.analytics?.cpuMonitor?.latest.fixedActionCounts?.creepWork).toBe(1);
  });

  it("roomRoleAggregation=true 时三个 creep 细分 helper 正常计时（对照）", () => {
    profilerConfig({ roomRoleAggregation: true, sampleInterval: 1 });
    Game.time = 100;
    const { getUsed } = setupCpuMock();
    const profiler = createTickCpuProfiler();
    setActiveTickCpuProfiler(profiler);

    profiler.measure("creepWork", () => {
      measureCreepDecision(() => 1);
      measureCreepPathing(() => 1);
      measureCreepIntent(() => OK);
    });
    profiler.flush();

    // 3 个细分 helper 各贡献一对 getUsed。
    expect(getUsed.mock.calls.length).toBeGreaterThanOrEqual(8);
  });
});

describe("cpu monitor rolling summary", () => {
  const config: CpuMonitorConfig = {
    enabled: true,
    sampleInterval: 10,
    historyLimit: 3,
    emaAlpha: 0.1,
    roomRoleAggregation: true,
    heapStats: false,
    fixedActionCpuCost: 0.2,
  };

  beforeEach(() => {
    resetCpuMonitorStore();
    Memory.analytics = undefined;
  });

  it("滚动 summary 与批量实现等价且 history 上限正确", () => {
    const snapshots: CpuMonitorSnapshotV2[] = [
      makeSnapshot(1, { creepWork: 10, towerControl: 4 }),
      makeSnapshot(2, { creepWork: 20 }),
      makeSnapshot(3, { creepWork: 30, spawnWork: 2 }),
      makeSnapshot(4, { creepWork: 40 }),
      makeSnapshot(5, { creepWork: 50, linkControl: 1 }),
    ];
    for (const snapshot of snapshots) {
      persistCpuMonitorSample(snapshot, config);
    }

    expect(getCpuMonitorHistory()).toHaveLength(3);

    const rolling = Memory.analytics?.cpuMonitor?.summary;
    const baseline = computeCpuMonitorSummary(getCpuMonitorHistory(), 0);
    expect(rolling).not.toBeNull();
    expect(baseline).not.toBeNull();
    expect(rolling?.ticks).toBe(baseline?.ticks);
    expect(rolling?.maxTotalUsed).toBe(baseline?.maxTotalUsed);
    expect(rolling?.minBucket).toBe(baseline?.minBucket);
    expect(rolling?.maxBucket).toBe(baseline?.maxBucket);
    expect(rolling?.avgTotalUsed).toBeCloseTo(baseline?.avgTotalUsed ?? NaN, 8);
    expect(rolling?.avgBucket).toBeCloseTo(baseline?.avgBucket ?? NaN, 8);
    // phase 键集与均值等价：被完全淘汰的 phase（towerControl）不出现。
    expect(Object.keys(rolling?.avgPhases ?? {})).toEqual(Object.keys(baseline?.avgPhases ?? {}));
    for (const [phase, avg] of Object.entries(rolling?.avgPhases ?? {})) {
      expect(avg).toBeCloseTo(baseline?.avgPhases[phase] ?? NaN, 8);
    }
  });

  it("phase 动态增加与淘汰后 rolling 与批量一致", () => {
    persistCpuMonitorSample(makeSnapshot(1, { a: 5 }), config);
    persistCpuMonitorSample(makeSnapshot(2, { a: 5, b: 7 }), config);
    persistCpuMonitorSample(makeSnapshot(3, { b: 7 }), config);
    // historyLimit=3：以上三条都在窗口内，a 仍有贡献。
    persistCpuMonitorSample(makeSnapshot(4, { b: 7 }), config);
    let rolling = Memory.analytics?.cpuMonitor?.summary;
    let baseline = computeCpuMonitorSummary(getCpuMonitorHistory(), 0);
    expect(Object.keys(rolling?.avgPhases ?? {}).sort()).toEqual(["a", "b"]);
    expect(rolling?.avgPhases.a).toBeCloseTo(baseline?.avgPhases.a ?? NaN, 8);

    // 第五条推送淘汰 tick 2：phase a 的贡献完全清零，从键集中消失。
    persistCpuMonitorSample(makeSnapshot(5, { b: 7 }), config);
    rolling = Memory.analytics?.cpuMonitor?.summary;
    baseline = computeCpuMonitorSummary(getCpuMonitorHistory(), 0);
    expect(Object.keys(rolling?.avgPhases ?? {})).toEqual(["b"]);
    expect(rolling?.avgPhases.b).toBeCloseTo(baseline?.avgPhases.b ?? NaN, 8);
    expect(getCpuMonitorHistory().map((entry) => entry.tick)).toEqual([3, 4, 5]);
  });
});
