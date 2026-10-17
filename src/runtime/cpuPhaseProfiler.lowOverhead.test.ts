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
  measureSampledCpuPhase,
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

function makeSnapshot(
  tick: number,
  phases: Record<string, number>,
  fixedActionCounts: Record<string, number> = {},
): CpuMonitorSnapshotV2 {
  return {
    tick,
    shard: "shard0",
    totalUsed: Object.values(phases).reduce((sum, value) => sum + value, 0),
    bucket: 9_000 + tick,
    limit: 500,
    tickLimit: 500,
    phases,
    fixedActionCounts,
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

  it("调度已移出 profiler：直接测量保留执行、异常与原 CPU API 调用数", () => {
    profilerConfig({ roomRoleAggregation: false, sampleInterval: 1 });
    const { getUsed } = setupCpuMock();
    Game.cpu.bucket = 500;
    getUsed.mockReturnValue(490);
    const profiler = createTickCpuProfiler();
    const executed: string[] = [];
    expect(profiler.measure("towerControl", () => { executed.push("tower"); return 17; })).toBe(17);
    expect(profiler.measure("hubPlanner", () => { executed.push("planner"); return 19; })).toBe(19);
    expect(() => profiler.measure("productionMonitor", () => { executed.push("monitor"); throw new Error("expected"); })).toThrow("expected");
    profiler.flush();
    expect(executed).toEqual(["tower", "planner", "monitor"]);
    expect(getUsed).toHaveBeenCalledTimes(8); // start + 三个阶段的计时对 + flush。
    expect(Memory.analytics?.cpuMonitor?.latest.schedulerShadow).toBeUndefined();
  });

  it("profiler disabled 时不调用 Game.cpu.getUsed", () => {
    profilerConfig({ enabled: false });
    const { getUsed } = setupCpuMock();
    const profiler = createTickCpuProfiler();
    setActiveTickCpuProfiler(profiler);
    const measure = jest.spyOn(profiler, "measure");

    profiler.measure("phase", () => 1);
    const result = { value: "disabled" };
    expect(measureSampledCpuPhase("outer", () => measureSampledCpuPhase("inner", () => result))).toBe(result);
    const failure = new Error("disabled fixture");
    expect(() => measureSampledCpuPhase("throw", () => { throw failure; })).toThrow(failure);
    profiler.measureCreep(makeCreep("c1"), () => undefined);
    profiler.measureRoomPhase("spawnWork", "W1N1", () => 1);
    profiler.recordFixedAction("creepWork");
    profiler.flush();

    expect(getUsed).not.toHaveBeenCalled();
    // 非采样 helper 不代理 measure，避免改写 health 阶段。
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it("启动边界单独报告，inclusive 子阶段不掩盖业务阶段外的 CPU", () => {
    profilerConfig({ sampleInterval: 1, roomRoleAggregation: false });
    let used = 7;
    Game.cpu.getUsed = jest.fn(() => used);
    const profiler = createTickCpuProfiler();
    setActiveTickCpuProfiler(profiler);
    const result = { value: "sampled" };
    profiler.measure("parent", () => {
      used += 2;
      expect(measureSampledCpuPhase("pb.manager", () => {
        measureSampledCpuPhase("routes", () => measureSampledCpuPhase("owned", () => { used += 3; }));
        return measureSampledCpuPhase("measureRequest", () => measureSampledCpuPhase("owned", () => {
          used += 1;
          return result;
        }));
      })).toBe(result);
    });
    used += 4;
    profiler.flush();
    expect(Memory.analytics!.cpuMonitor!.latest).toMatchObject({
      totalUsed: 10, startupUsed: 7, tickUsedAtFlush: 17, topLevelUsed: 6,
      untracked: 4, phases: {
        parent: 6,
        "pb.manager": 4,
        "pb.manager/routes": 3,
        "pb.manager/routes/owned": 3,
        "pb.manager/measureRequest": 1,
        "pb.manager/measureRequest/owned": 1,
      },
    });
    // 6 个 span 各一对时钟，另加 loopStart / flush；没有额外 total 计时。
    expect(Game.cpu.getUsed).toHaveBeenCalledTimes(14);
  });

  it("子阶段异常被父阶段处理后，后续顶层统计仍各记一次", () => {
    profilerConfig({ sampleInterval: 1 });
    let used = 0;
    Game.cpu.getUsed = () => used;
    const profiler = createTickCpuProfiler();
    setActiveTickCpuProfiler(profiler);
    const failure = new Error("fixture");
    measureSampledCpuPhase("parent", () => {
      try {
        measureSampledCpuPhase("child", () => { used += 3; throw failure; });
      } catch (error) {
        expect(error).toBe(failure);
        used += 1;
      }
      expect(measureSampledCpuPhase("recovered", () => "ok")).toBe("ok");
    });
    expect(() => measureSampledCpuPhase("escape", () => { throw failure; })).toThrow(failure);
    measureSampledCpuPhase("next", () => { used += 2; });
    used += 1;
    profiler.flush();
    expect(Memory.analytics!.cpuMonitor!.latest).toMatchObject({
      topLevelUsed: 6, untracked: 1,
      phases: { parent: 4, "parent/child": 3, "parent/recovered": 0, escape: 0, next: 2 },
    });
    expect(Object.keys(Memory.analytics!.cpuMonitor!.latest.phases)).toHaveLength(5);
  });

  it("非 sample tick 不调用 Game.cpu.getUsed，同 tick 替换 Game 后重算采样开关", () => {
    profilerConfig({ sampleInterval: 10 });
    Game.time = 101; // 101 % 10 !== 0
    const profiler = createTickCpuProfiler();
    setActiveTickCpuProfiler(profiler);
    const measure = jest.spyOn(profiler, "measure");

    profiler.measure("phase", () => 1);
    expect(measureSampledCpuPhase("outer", () => measureSampledCpuPhase("inner", () => "ok"))).toBe("ok");
    const failure = new Error("non-sample fixture");
    expect(() => measureSampledCpuPhase("throw", () => { throw failure; })).toThrow(failure);
    profiler.measureCreep(makeCreep("c1"), () => undefined);
    profiler.flush();

    const gameCpu = (Game as unknown as { cpu: { getUsed: jest.Mock } }).cpu;
    expect(gameCpu.getUsed).not.toHaveBeenCalled();
    expect(measure).toHaveBeenCalledTimes(1);

    const previousGame = Game;
    try {
      Object.assign(global, { Game: { ...previousGame } });
      profilerConfig({ sampleInterval: 1, roomRoleAggregation: false });
      const freshProfiler = createTickCpuProfiler();
      setActiveTickCpuProfiler(freshProfiler);
      expect(measureSampledCpuPhase("fresh", () => "fresh game")).toBe("fresh game");
      freshProfiler.flush();
      expect(gameCpu.getUsed).toHaveBeenCalledTimes(4);
      expect(Memory.analytics?.cpuMonitor?.latest.phases).toEqual({ fresh: 0 });
    } finally {
      Object.assign(global, { Game: previousGame });
    }
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
      makeSnapshot(3, { creepWork: 30, spawnWork: 2, zeroPhase: 0 }, { idleAction: 0 }),
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
    // 窗口内显式记录的 0 仍是有效键，不能与已经完全淘汰的键混淆。
    expect(rolling?.avgPhases.zeroPhase).toBe(0);
    expect(rolling?.avgFixedActionCounts).toEqual(baseline?.avgFixedActionCounts);
    expect(rolling?.avgFixedActionCounts.idleAction).toBe(0);
  });

  it("phase 动态增加与淘汰后 rolling 与批量一致", () => {
    persistCpuMonitorSample(makeSnapshot(1, { a: 0.1 }, { oldAction: 1 }), config);
    persistCpuMonitorSample(makeSnapshot(2, { a: 0.2, b: 7 }, { oldAction: 2 }), config);
    persistCpuMonitorSample(makeSnapshot(3, { b: 7 }, { currentAction: 3 }), config);
    // historyLimit=3：以上三条都在窗口内，a 仍有贡献。
    persistCpuMonitorSample(makeSnapshot(4, { b: 7 }, { currentAction: 4 }), config);
    let rolling = Memory.analytics?.cpuMonitor?.summary;
    let baseline = computeCpuMonitorSummary(getCpuMonitorHistory(), 0);
    expect(Object.keys(rolling?.avgPhases ?? {}).sort()).toEqual(["a", "b"]);
    expect(rolling?.avgPhases.a).toBeCloseTo(baseline?.avgPhases.a ?? NaN, 8);

    // 0.1 + 0.2 - 0.1 - 0.2 存在浮点残差，最后一份样本淘汰后仍须删除键。
    persistCpuMonitorSample(makeSnapshot(5, { b: 7 }, { currentAction: 5 }), config);
    rolling = Memory.analytics?.cpuMonitor?.summary;
    baseline = computeCpuMonitorSummary(getCpuMonitorHistory(), 0);
    expect(Object.keys(rolling?.avgPhases ?? {})).toEqual(["b"]);
    expect(rolling?.avgPhases.b).toBeCloseTo(baseline?.avgPhases.b ?? NaN, 8);
    expect(rolling?.avgFixedActionCounts).toEqual(baseline?.avgFixedActionCounts);
    expect(rolling?.avgFixedActionCounts).not.toHaveProperty("oldAction");
    expect(getCpuMonitorHistory().map((entry) => entry.tick)).toEqual([3, 4, 5]);

    // 完全淘汰后以零值重新出现，不能携带上一个生命周期的残差。
    persistCpuMonitorSample(makeSnapshot(6, { a: 0 }, { oldAction: 0 }), config);
    expect(Memory.analytics?.cpuMonitor?.summary?.avgPhases.a).toBe(0);
    expect(Memory.analytics?.cpuMonitor?.summary?.avgFixedActionCounts.oldAction).toBe(0);

    // 缩小窗口会一次淘汰多条记录，零值键与计数也要同步更新。
    persistCpuMonitorSample(makeSnapshot(7, { b: 0 }, { currentAction: 0 }), { ...config, historyLimit: 1 });
    expect(getCpuMonitorHistory().map((entry) => entry.tick)).toEqual([7]);
    expect(Memory.analytics?.cpuMonitor?.summary?.avgPhases).toEqual({ b: 0 });
    expect(Memory.analytics?.cpuMonitor?.summary?.avgFixedActionCounts).toEqual({ currentAction: 0 });

    // 旧 global store 可能完全没有 rolling，或仅含旧版 sums；均从 history 补齐。
    const legacyGlobals = global as typeof global & {
      __cpuMonitor?: {
        history: CpuMonitorSnapshotV2[];
        emaTotalUsed: number;
        seeded: boolean;
        rolling?: unknown;
      };
    };
    const previousHistory = getCpuMonitorHistory().slice();
    for (const oldRolling of [undefined, {
      ticks: 1, sumTotalUsed: 0, sumBucket: 9_007, sumUntracked: 0,
      phaseSums: { b: 0, obsoletePhase: 1e-16 }, fixedActionSums: { currentAction: 0 },
    }]) {
      legacyGlobals.__cpuMonitor = {
        history: previousHistory.slice(), emaTotalUsed: 12, seeded: true, rolling: oldRolling,
      };
      persistCpuMonitorSample(makeSnapshot(8, { newPhase: 2 }, { newAction: 1 }), config);
      rolling = Memory.analytics?.cpuMonitor?.summary;
      baseline = computeCpuMonitorSummary(getCpuMonitorHistory(), 0);
      expect(rolling?.ticks).toBe(2);
      expect(rolling?.avgPhases).toEqual(baseline?.avgPhases);
      expect(rolling?.avgFixedActionCounts).toEqual(baseline?.avgFixedActionCounts);
      expect(rolling?.avgTotalUsed).toBe(baseline?.avgTotalUsed);
      expect(rolling?.avgBucket).toBe(baseline?.avgBucket);
      expect(rolling?.emaTotalUsed).toBeCloseTo(11);
    }
  });
});
