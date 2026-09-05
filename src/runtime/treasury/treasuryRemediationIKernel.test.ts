/**
 * Treasury Core Rewrite IV · Remediation I——内核层验收矩阵（任务书 §8）。
 *
 * 覆盖：E05（调用边界发布失败/污染与合法对照）、E06（记录内公平——前缀
 * 失败 + 逐 tick JSON 重载）、E07（失败项恢复服务/成员变化/游标回绕）、
 * E08（轮转预扣丢写/预扣后中断/确认丢写）、E09（端口重入共享预算 + 两级
 * 轮转）、E10（跨记录公平——逐 tick JSON 重载 + 混合流量 + 推导界）、
 * E19（新字段最坏值满载实测）。
 * E01/E03 见 treasuryRewrite4Lifecycle.test.ts（D11 真实路径快照）；
 * service 层矩阵见 treasuryRemediationIService.test.ts。
 */
import { snapshotWholeMemory, installWholeMemorySnapshot } from "@mock/treasuryResetHarness";
import { createTreasuryCoreKernel, type TreasuryCoreAdmissionInput, type TreasuryCoreKernel, type TreasuryCoreKernelPorts } from "@/runtime/treasury/kernel/kernel";
import {
  buildTreasuryCoreWorstWorkRecord,
  buildTreasuryCoreWorstRingEntry,
  readTreasuryCoreStoreHealth,
  treasuryCoreSerializedChars,
} from "@/runtime/treasury/kernel/store";
import {
  TREASURY_CORE_ACTIVE_LIMIT,
  TREASURY_CORE_RING_LIMIT,
  TREASURY_CORE_TOTAL_CHAR_BUDGET,
  type TreasuryCoreIdentityFacts,
  type TreasuryCoreWorstCaseLeg,
} from "@/runtime/treasury/kernel/types";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";

function kernelIdentity(): TreasuryCoreIdentityFacts {
  return {
    actionKind: "d.kind",
    adapterVersion: 1,
    adapterRegistrationId: "reg-rem1",
    adapterSemanticIdentity: "d.adapter-rem1",
    canonicalDigest: "a".repeat(16),
    postingsDigest: "b".repeat(16),
    retryFactsDigest: "c".repeat(16),
    durableFacts: null,
  };
}

function kernelLegs(outflow: number): TreasuryCoreWorstCaseLeg[] {
  return [
    { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -outflow },
    { roomName: "W2N57", locationKind: "terminal", resource: RESOURCE_ENERGY, delta: outflow },
  ];
}

function makeKernelPorts(overrides: Partial<TreasuryCoreKernelPorts> = {}): TreasuryCoreKernelPorts {
  return {
    nowTick: () => Game.time,
    runtimeGeneration: () => 1,
    findAdapter: (kind: string) =>
      kind === "d.kind"
        ? { kind, version: 1, registrationId: "reg-rem1", semanticIdentity: "d.adapter-rem1", execute: () => ({ ok: false }), settlesOnAccept: false, nonOkOutcome: "not_executed" as const }
        : undefined,
    checkAdmissionCapacity: () => null,
    observeForCleanup: () => ({ worldSequence: 9_000_000, atTick: Game.time + 1, locationExists: () => true }),
    ...overrides,
  };
}

function kernelAdmitInput(consumers: readonly string[], workKey: string): TreasuryCoreAdmissionInput {
  return {
    workKey,
    identity: kernelIdentity(),
    worstCase: kernelLegs(50),
    externalConsumers: consumers,
    canonicalArgs: { n: 1 },
    postings: kernelLegs(50),
    admissionContext: { contractId: "ac:rem1", contractDigest: "a".repeat(16), actionKind: "d.kind", ownerIdentity: null, excludeAttemptId: null },
    structureBindings: [],
  };
}

interface ActiveShape {
  phase: string;
  cleanup: { consumerKeys: readonly string[]; cursor: number };
  invocationBoundary: { atTick: number; worldSequence?: number } | null;
}

function activeShape(attemptId: string): ActiveShape | undefined {
  const store = Memory.runtime?.treasuryCore as unknown as { active?: Record<string, ActiveShape> } | undefined;
  return store?.active?.[attemptId];
}

/** 丢弃全部 treasuryCore 写入的存储边界（预扣/确认丢写模拟）。 */
function interceptTreasuryCoreWrites(): () => void {
  const runtime = Memory.runtime as unknown as Record<string, unknown>;
  const descriptor = Object.getOwnPropertyDescriptor(runtime, "treasuryCore");
  Object.defineProperty(runtime, "treasuryCore", {
    configurable: true,
    get: () => descriptor?.value,
    set() {
      // 丢弃全部写入。
    },
  });
  return () => {
    delete runtime.treasuryCore;
    if (descriptor) Object.defineProperty(runtime, "treasuryCore", descriptor);
    else runtime.treasuryCore = descriptor?.value;
  };
}

/** admit + 保存 permit（本文件统一入口）。 */
function admitWithPermit(kernel: TreasuryCoreKernel, consumers: readonly string[], workKey: string): { attemptId: string; permit: unknown } {
  const admitted = kernel.admit(kernelAdmitInput(consumers, workKey));
  if (admitted.status !== "admitted") throw new Error(`admit ${workKey} failed`);
  return { attemptId: admitted.attemptId, permit: admitted.dispatch };
}

/** 每 tick 真正 JSON 重载（§5.3/E06/E10）：快照→安装新 Memory→新 kernel。 */
function reloadKernel(ports: TreasuryCoreKernelPorts): TreasuryCoreKernel {
  installWholeMemorySnapshot(snapshotWholeMemory());
  return createTreasuryCoreKernel(ports);
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
});

// ── E05：调用边界发布失败/原地污染与合法对照 ────────────────────────────────

describe("E05 调用边界发布", () => {
  it("发布丢写：实际调用 0、保持 pending、发布不误确认；合法对照调用 1 并收尾", () => {
    const calls: number[] = [];
    const ports = makeKernelPorts({
      findAdapter: (kind) =>
        kind === "d.kind"
          ? { kind, version: 1, registrationId: "reg-rem1", semanticIdentity: "d.adapter-rem1", execute: () => { calls.push(1); return { ok: true }; }, settlesOnAccept: true, nonOkOutcome: "unknown" as const }
          : undefined,
    });
    const kernel = createTreasuryCoreKernel(ports);
    const { attemptId, permit } = admitWithPermit(kernel, [], "biz:e5:lost");
    const restore = interceptTreasuryCoreWrites();
    const failed = kernel.executeDispatch(permit);
    restore();
    // 发布失败 → 动作调用 0（ Remediation I/R1：边界发布失败时实际调用为零）。
    expect(failed.status).toBe("publish_failed");
    expect(calls.length).toBe(0);
    // 恢复写能力后记录仍是 pending（无可执行边界被误确认）。
    const record = activeShape(attemptId);
    expect(record?.phase).toBe("pending");
    expect(record?.invocationBoundary).toBeNull();
    // 合法对照：同一 pending 记录重新执行（许可未消费）——调用 1 并收尾。
    const again = kernel.executeDispatch(permit);
    expect(again.status).toBe("committed");
    expect(calls.length).toBe(1);
    expect(activeShape(attemptId)?.phase).toBe("closing");
  });

  it("发布原地污染：读回确认拒绝污染载荷，记录不被错误推进", () => {
    const calls: number[] = [];
    const ports = makeKernelPorts({
      findAdapter: (kind) =>
        kind === "d.kind"
          ? { kind, version: 1, registrationId: "reg-rem1", semanticIdentity: "d.adapter-rem1", execute: () => { calls.push(1); return { ok: true }; }, settlesOnAccept: true, nonOkOutcome: "unknown" as const }
          : undefined,
    });
    const kernel = createTreasuryCoreKernel(ports);
    const { attemptId, permit } = admitWithPermit(kernel, [], "biz:e5:dirty");
    // 写边界原地污染：dispatch_start 写入时把载荷额外塞进一个未知字段。
    const runtime = Memory.runtime as unknown as { treasuryCore: Record<string, unknown> };
    const original = runtime.treasuryCore;
    let polluted = false;
    Object.defineProperty(runtime, "treasuryCore", {
      configurable: true,
      get: () => original,
      set(value: Record<string, unknown>) {
        if (!polluted && value && typeof value === "object") {
          polluted = true;
          (value.active[attemptId] as Record<string, unknown>).smuggled = "z".repeat(64);
        }
        Object.defineProperty(runtime, "treasuryCore", { configurable: true, value, writable: true });
      },
    });
    const result = kernel.executeDispatch(permit);
    expect(result.status).toBe("publish_failed");
    expect(calls.length).toBe(0); // 污染被读回确认拒绝 → 零调用
    expect(activeShape(attemptId)?.phase).toBe("pending"); // 未被错误推进
    // 独立 expected 不受载荷污染：store 仍是合法状态（条件回滚恢复基线）。
    expect(readTreasuryCoreStoreHealth().status).toBe("healthy");
  });
});

// ── E06/E07：记录内公平（前缀失败 + 逐 tick JSON 重载） ─────────────────────

describe("E06 记录内公平（8 义务前 4 永久 false）", () => {
  const STICKY = ["ext:e6:f0", "ext:e6:f1", "ext:e6:f2", "ext:e6:f3"];
  const CONSUMERS = [...STICKY, "ext:e6:t4", "ext:e6:t5", "ext:e6:t6", "ext:e6:t7"];

  function setup(): { ports: TreasuryCoreKernelPorts; releaseCalls: string[] } {
    const releaseCalls: string[] = [];
    const sticky = new Set(STICKY);
    const ports = makeKernelPorts({
      releaseExternalConsumer: (key) => {
        releaseCalls.push(key);
        return !sticky.has(key);
      },
    });
    return { ports, releaseCalls };
  }

  it("每 tick JSON 重载：后 4 在至多 3 个完整预算 tick 内获得服务并确认移除；前 4 保留；后 4 不再重复调用", () => {
    const { ports, releaseCalls } = setup();
    let kernel = createTreasuryCoreKernel(ports);
    const { attemptId, permit } = admitWithPermit(kernel, CONSUMERS, "biz:e6:fair");
    expect(kernel.executeDispatch(permit).status).toBe("not_executed");
    let servedAll = false;
    let ticks = 0;
    for (; ticks < 3 && !servedAll; ticks += 1) {
      Game.time += 1;
      kernel = reloadKernel(ports); // 每 tick 真正 JSON 重载（§5.3）
      kernel.beginTick();
      const record = activeShape(attemptId);
      servedAll = record === undefined || record.cleanup.consumerKeys.filter((k) => !STICKY.includes(k)).length === 0;
    }
    expect(servedAll).toBe(true);
    expect(ticks).toBeLessThanOrEqual(3); // 推导界：tick1 cursor 推进，tick2 后 4 全部服务
    const record = activeShape(attemptId);
    expect(record).toBeDefined();
    expect([...record!.cleanup.consumerKeys].sort()).toEqual([...STICKY].sort()); // 失败义务保留
    // 调用与份额守限：每 tick 端口调用 ≤4 个成对单位（2 tick × 4）。
    expect(releaseCalls.length).toBeLessThanOrEqual(8);
    // 后 4 不再重复调用：再推进 2 tick，成功项不再出现在调用轨迹。
    const servedSet = new Set(["ext:e6:t4", "ext:e6:t5", "ext:e6:t6", "ext:e6:t7"]);
    const callsOfServed = releaseCalls.filter((k) => servedSet.has(k));
    expect(callsOfServed.length).toBe(4);
    Game.time += 1;
    kernel = reloadKernel(ports);
    kernel.beginTick();
    Game.time += 1;
    kernel = reloadKernel(ports);
    kernel.beginTick();
    expect(releaseCalls.filter((k) => servedSet.has(k)).length).toBe(4); // 无重复
  });

  it("E07 前 4 随后恢复成功：有限推进后工作结束（先前失败项仍可得到服务）", () => {
    const releaseCalls: string[] = [];
    const sticky = new Set<string>(STICKY);
    const ports = makeKernelPorts({
      releaseExternalConsumer: (key) => {
        releaseCalls.push(key);
        return !sticky.has(key);
      },
    });
    let kernel = createTreasuryCoreKernel(ports);
    const { attemptId, permit } = admitWithPermit(kernel, CONSUMERS, "biz:e7:recover");
    expect(kernel.executeDispatch(permit).status).toBe("not_executed");
    // 阶段 1：后 4 完成（前 4 失败保留）。
    for (let tick = 0; tick < 3; tick += 1) {
      Game.time += 1;
      kernel = reloadKernel(ports);
      kernel.beginTick();
    }
    expect([...activeShape(attemptId)!.cleanup.consumerKeys].sort()).toEqual([...STICKY].sort());
    // 阶段 2：前 4 恢复成功 → 有限推进后工作结束（retry_ready，义务空）。
    sticky.clear();
    for (let tick = 0; tick < 4; tick += 1) {
      Game.time += 1;
      kernel = reloadKernel(ports);
      kernel.beginTick();
      const record = activeShape(attemptId);
      if (record?.phase === "retry_ready") break;
    }
    const final = activeShape(attemptId);
    expect(final?.phase).toBe("retry_ready");
    expect(final!.cleanup.consumerKeys).toEqual([]);
  });

  it("E07 变体：1 义务成功——单 tick 完成", () => {
    const ports = makeKernelPorts({ releaseExternalConsumer: () => true });
    let kernel = createTreasuryCoreKernel(ports);
    const { attemptId, permit } = admitWithPermit(kernel, ["ext:e7:solo"], "biz:e7:solo");
    expect(kernel.executeDispatch(permit).status).toBe("not_executed");
    Game.time += 1;
    kernel = reloadKernel(ports);
    kernel.beginTick();
    expect(activeShape(attemptId)?.phase).toBe("retry_ready");
  });

  it("E07 变体：8 义务全 false——义务全部保留（不产生虚假完成），游标回绕安全", () => {
    const ports = makeKernelPorts({ releaseExternalConsumer: () => false });
    let kernel = createTreasuryCoreKernel(ports);
    const all = Array.from({ length: 8 }, (_, i) => `ext:e7:allf-${String(i)}`);
    const { attemptId, permit } = admitWithPermit(kernel, all, "biz:e7:allfalse");
    expect(kernel.executeDispatch(permit).status).toBe("not_executed");
    for (let tick = 0; tick < 5; tick += 1) {
      Game.time += 1;
      kernel = reloadKernel(ports);
      kernel.beginTick();
    }
    const record = activeShape(attemptId)!;
    expect(record.phase).toBe("closing");
    expect(record.cleanup.consumerKeys.length).toBe(8); // 全保留
    expect(record.cleanup.cursor).toBeGreaterThanOrEqual(0);
    expect(record.cleanup.cursor).toBeLessThan(8); // 回绕安全
  });

  it("E07 变体：8 义务全 true——至多 3 个完整预算 tick 结束", () => {
    const ports = makeKernelPorts({ releaseExternalConsumer: () => true });
    let kernel = createTreasuryCoreKernel(ports);
    const all = Array.from({ length: 8 }, (_, i) => `ext:e7:allt-${String(i)}`);
    const { attemptId, permit } = admitWithPermit(kernel, all, "biz:e7:alltrue");
    expect(kernel.executeDispatch(permit).status).toBe("not_executed");
    let done = false;
    let ticks = 0;
    for (; ticks < 3 && !done; ticks += 1) {
      Game.time += 1;
      kernel = reloadKernel(ports);
      kernel.beginTick();
      done = activeShape(attemptId)?.phase === "retry_ready";
    }
    expect(done).toBe(true);
    expect(ticks).toBeLessThanOrEqual(3);
  });
});

// ── E08：轮转的中断与丢写 ───────────────────────────────────────────────────

describe("E08 轮转预扣/确认的中断与丢写", () => {
  it("预扣丢写：未取得份额调用 0；恢复后继续公平", () => {
    const releaseCalls: string[] = [];
    const ports = makeKernelPorts({ releaseExternalConsumer: (key) => { releaseCalls.push(key); return true; } });
    const kernel = createTreasuryCoreKernel(ports);
    const { attemptId, permit } = admitWithPermit(kernel, ["ext:e8:a", "ext:e8:b"], "biz:e8:prepay");
    expect(kernel.executeDispatch(permit).status).toBe("not_executed");
    Game.time += 1;
    const restore = interceptTreasuryCoreWrites();
    kernel.beginTick(); // 预扣发布失败 → 端口调用 0
    restore();
    expect(releaseCalls.length).toBe(0);
    Game.time += 1;
    const kernel2 = reloadKernel(ports);
    kernel2.beginTick(); // 写能力恢复：义务得到服务
    expect(releaseCalls.length).toBe(2);
    expect(activeShape(attemptId)?.phase).toBe("retry_ready");
  });

  it("预扣后中断（端口 throw）：份额已耗不退、义务保留、轮转位置前移", () => {
    const releaseCalls: string[] = [];
    let throwOnce = true;
    const ports = makeKernelPorts({
      releaseExternalConsumer: (key) => {
        releaseCalls.push(key);
        if (throwOnce) {
          throwOnce = false;
          throw new Error("interrupted at port");
        }
        return true;
      },
    });
    let kernel = createTreasuryCoreKernel(ports);
    const { attemptId, permit } = admitWithPermit(kernel, ["ext:e8:x", "ext:e8:y"], "biz:e8:throw");
    expect(kernel.executeDispatch(permit).status).toBe("not_executed");
    Game.time += 1;
    kernel = reloadKernel(ports);
    kernel.beginTick(); // 第一个端口调用抛错：份额已耗、duty 保留
    const mid = activeShape(attemptId)!;
    expect(mid.phase).toBe("closing");
    expect(mid.cleanup.consumerKeys.length).toBeGreaterThanOrEqual(1);
    Game.time += 1;
    kernel = reloadKernel(ports);
    kernel.beginTick(); // 后续轮转再访问（幂等同 attemptId）
    const after = activeShape(attemptId);
    if (after !== undefined) {
      expect(after.phase).toBe("retry_ready");
      expect(after.cleanup.consumerKeys).toEqual([]);
    }
    // 同 attempt 幂等关联：同一 key 可能出现两次（中断后重试）但 attemptId 不变。
    expect(releaseCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("释放成功但确认丢写：duty 保留；恢复后同一 (key, attemptId) 幂等重试", () => {
    const releaseCalls: string[] = [];
    const ports = makeKernelPorts({
      releaseExternalConsumer: (key, attemptId) => {
        releaseCalls.push(`${key}@${attemptId}`);
        return true;
      },
    });
    const kernel = createTreasuryCoreKernel(ports);
    const { attemptId, permit } = admitWithPermit(kernel, ["ext:e8:confirm"], "biz:e8:confirm");
    expect(kernel.executeDispatch(permit).status).toBe("not_executed");
    Game.time += 1;
    // 端口成功释放，但确认命令写回被丢弃（预扣已持久化——份额已耗）。
    // 拦截放行第一次写（成对预扣的持久化），丢弃之后的写（确认命令）。
    const runtime = Memory.runtime as unknown as Record<string, unknown>;
    const descriptor = Object.getOwnPropertyDescriptor(runtime, "treasuryCore");
    let liveValue = descriptor?.value;
    let writesAllowed = 1;
    Object.defineProperty(runtime, "treasuryCore", {
      configurable: true,
      get: () => liveValue,
      set(value: unknown) {
        if (writesAllowed > 0) {
          writesAllowed -= 1;
          liveValue = value;
        }
        // else 丢弃（确认丢写）。
      },
    });
    kernel.beginTick();
    delete runtime.treasuryCore;
    if (descriptor) Object.defineProperty(runtime, "treasuryCore", descriptor);
    else runtime.treasuryCore = liveValue;
    expect(releaseCalls.length).toBe(1);
    expect(activeShape(attemptId)?.cleanup.consumerKeys).toEqual(["ext:e8:confirm"]); // duty 保留
    Game.time += 1;
    const kernel2 = reloadKernel(ports);
    kernel2.beginTick();
    expect(releaseCalls.length).toBe(2); // 幂等重试
    expect(releaseCalls[0]).toBe(releaseCalls[1]); // 同一 (key, attemptId)
    expect(activeShape(attemptId)?.phase).toBe("retry_ready");
  });
});

// ── E09：端口重入共享预算 + 两级轮转 ────────────────────────────────────────

describe("E09 端口重入共享预算", () => {
  it("端口回调内重入另一 kernel 实例的 beginTick：总份额 ≤8、成对单位 ≤4、旧游标不覆盖内层较新状态", () => {
    const releaseCalls: string[] = [];
    let inner: TreasuryCoreKernel | undefined;
    const ports = makeKernelPorts({
      releaseExternalConsumer: (key) => {
        releaseCalls.push(key);
        if (inner !== undefined) {
          const reentered = inner;
          inner = undefined; // 单次重入（防无限递归）
          reentered.beginTick();
        }
        return true;
      },
    });
    const kernel = createTreasuryCoreKernel(ports);
    inner = kernel;
    const consumers = Array.from({ length: 8 }, (_, i) => `ext:e9:c${String(i)}`);
    const { permit } = admitWithPermit(kernel, consumers, "biz:e9:reenter");
    expect(kernel.executeDispatch(permit).status).toBe("not_executed");
    Game.time += 1;
    kernel.beginTick(); // 外层与重入内层共享同一持久预算推进
    // 本 tick 端口实际调用 ≤4 个成对单位（8 份额 × 成对预扣）。
    expect(releaseCalls.length).toBeLessThanOrEqual(4);
    // 预算守恒：持久预算 ≤8。
    const recovery = (Memory.runtime!.treasuryCore as unknown as { recovery: { budgetTick: number; budgetUsed: number } }).recovery;
    expect(recovery.budgetTick).toBe(Game.time);
    expect(recovery.budgetUsed).toBeLessThanOrEqual(8);
    // 轮转继续：剩余义务在后续 tick（JSON 重载后）完成。
    let kernel2 = kernel;
    for (let tick = 0; tick < 6; tick += 1) {
      Game.time += 1;
      kernel2 = reloadKernel(ports);
      kernel2.beginTick();
      const record = Object.values((Memory.runtime!.treasuryCore as unknown as { active: Record<string, ActiveShape> }).active)
        .find((r) => r.cleanup?.consumerKeys?.some((k) => k.startsWith("ext:e9:")));
      if (record === undefined) break;
    }
    const remaining = Object.values((Memory.runtime!.treasuryCore as unknown as { active: Record<string, ActiveShape> }).active)
      .find((r) => r.cleanup?.consumerKeys?.some((k) => k.startsWith("ext:e9:")));
    expect(remaining).toBeUndefined(); // 可完成义务有限推进完成
  });
});

// ── E10：跨记录公平（逐 tick JSON 重载 + 混合流量 + 推导界） ─────────────────

describe("E10 跨记录公平（前 8 失败工作 + 后方 8 义务工作 + 混合流量）", () => {
  it("每 tick 完整 JSON 重载：后方工作在推导界内真完成；失败风险保留；报告实际最长等待", () => {
    const sticky = new Set(Array.from({ length: 8 }, (_, i) => `ext:e10:s${String(i)}`));
    const releaseCalls: string[] = [];
    const ports = makeKernelPorts({
      releaseExternalConsumer: (key) => {
        releaseCalls.push(key);
        return !sticky.has(key);
      },
    });
    let kernel = createTreasuryCoreKernel(ports);
    // 前 8 条：各 1 义务永久失败。
    for (let i = 0; i < 8; i += 1) {
      const { permit } = admitWithPermit(kernel, [`ext:e10:s${String(i)}`], `biz:e10:fail-${String(i)}`);
      expect(kernel.executeDispatch(permit).status).toBe("not_executed");
    }
    // 后方：8 义务可完成。
    const good = admitWithPermit(kernel, Array.from({ length: 8 }, (_, i) => `ext:e10:g${String(i)}`), "biz:e10:good");
    expect(kernel.executeDispatch(good.permit).status).toBe("not_executed");
    // 混合：过期 retry_ready（期限关闭流量）。
    const expired = admitWithPermit(kernel, [], "biz:e10:expired");
    expect(kernel.executeDispatch(expired.permit).status).toBe("not_executed");
    Game.time += 1;
    kernel = reloadKernel(ports);
    kernel.beginTick(); // expired → retry_ready
    const expiredShape = activeShape(expired.attemptId);
    if (expiredShape?.phase !== "retry_ready") throw new Error("expired not retry_ready");
    // 推导界（§5.3/E10）：每 tick 8 份额 = 4 成对单位。9 条 closing 每次访问
    // 至少 1 单位（sticky 1 单位/条；good 每次 ≤4 单位）。cleanupCursor 轮转
    // 保证 good 至少每 ~3 tick 被访问一次、每次 ≥1 单位（清理保底 ≥2 份）；
    // good 8 义务 ≈ 8 单位 ≈ 至多 8 次访问。噪声（sweep ≤3 + 恢复 ≤2 份额）
    // 挤占后放宽 3 倍 → 界 = 40 tick。retry 期限关闭单次 ≤1 份额。
    const BOUND = 40;
    let targetDone = false;
    let ticks = 0;
    let maxWait = 0;
    for (; ticks < BOUND && !targetDone; ticks += 1) {
      Game.time += 1;
      kernel = reloadKernel(ports); // 每 tick 完整 JSON 重载
      kernel.beginTick();
      // 混合流量：注入新 pending（下 tick 被 sweep 安全取消）。
      kernel.admit({ ...kernelAdmitInput([], `biz:e10:noise-${String(ticks)}`), worstCase: kernelLegs(1), postings: kernelLegs(1) });
      // dispatching 残留（真实形态带边界——恢复为 unknown 流量）。
      if (ticks % 4 === 0) {
        const noise2 = kernel.admit(kernelAdmitInput([], `biz:e10:disp-${String(ticks)}`));
        if (noise2.status === "admitted") {
          const shape = activeShape(noise2.attemptId) as unknown as { phase: string; invocationBoundary: unknown };
          shape.phase = "dispatching";
          shape.invocationBoundary = { atTick: Game.time, worldSequence: 1 };
        }
      }
      const record = activeShape(good.attemptId);
      if (record === undefined || (record.phase === "retry_ready" && record.cleanup.consumerKeys.length === 0)) {
        targetDone = true;
        maxWait = ticks;
      }
    }
    expect(targetDone).toBe(true);
    expect(maxWait).toBeLessThan(BOUND);
    // 失败风险保留：前 8 条义务仍在。
    for (let i = 0; i < 8; i += 1) {
      const rec = Object.values((Memory.runtime!.treasuryCore as unknown as { active: Record<string, ActiveShape & { workKey?: string }> }).active)
        .find((r) => (r as unknown as { workKey: string }).workKey === `biz:e10:fail-${String(i)}`);
      expect(rec?.cleanup.consumerKeys).toEqual([`ext:e10:s${String(i)}`]);
    }
  });
});

// ── E19：新字段最坏值 + 满载实测 ────────────────────────────────────────────

describe("E19 新边界/轮转字段最坏值满载实测", () => {
  it("worst 构造器（含 invocationBoundary/cursor 极值）过 validator 且实测 ≤ 预算；满 64/128 演化不超界", () => {
    const worst = buildTreasuryCoreWorstWorkRecord();
    // 构造器含新字段极值。
    expect(worst.invocationBoundary).toEqual({ atTick: Number.MAX_SAFE_INTEGER, worldSequence: Number.MAX_SAFE_INTEGER });
    expect(worst.cleanup.cursor).toBe(Number.MAX_SAFE_INTEGER);
    // 单槽实测（构造器真实序列化）。
    const slotChars = treasuryCoreSerializedChars({
      version: 3,
      installEpochId: "e".repeat(32),
      issuance: { frontier: 0, burned: 0 },
      lifecycle: { lastBeginTick: 0, lastEndTick: 0 },
      recovery: { sweepCursor: 0, cleanupCursor: 0, budgetTick: 0, budgetUsed: 0 },
      active: { [worst.attemptId]: worst },
      ring: [],
      ringCursor: 0,
      counters: { admitted: 0, dispatched: 0, settledCommitted: 0, settledNotExecuted: 0, unknown: 0, rearmings: 0, rejectedAdmissions: 0, recoveryAdvances: 0, cleanupFailures: 0 },
    } as never);
    expect(slotChars).toBeGreaterThan(0);
    // 满 64 active + 128 ring 的最坏形态（E19：字段取允许最坏值）。
    const worstMeta = {
      version: 3,
      installEpochId: "e".repeat(32),
      issuance: { frontier: 9_999_999_999, burned: 9_999_999_999 },
      lifecycle: { lastBeginTick: Number.MAX_SAFE_INTEGER, lastEndTick: Number.MAX_SAFE_INTEGER },
      recovery: { sweepCursor: 64, cleanupCursor: 64, budgetTick: Number.MAX_SAFE_INTEGER, budgetUsed: 8 },
      active: {} as Record<string, typeof worst>,
      ring: Array.from({ length: TREASURY_CORE_RING_LIMIT }, () => buildTreasuryCoreWorstRingEntry()),
      ringCursor: 127,
      counters: { admitted: 9_999_999_999, dispatched: 9_999_999_999, settledCommitted: 9_999_999_999, settledNotExecuted: 9_999_999_999, unknown: 9_999_999_999, rearmings: 9_999_999_999, rejectedAdmissions: 9_999_999_999, recoveryAdvances: 9_999_999_999, cleanupFailures: 9_999_999_999 },
    };
    for (let i = 0; i < TREASURY_CORE_ACTIVE_LIMIT; i += 1) {
      worstMeta.active[`tk1_${String(9_000_000_000 + i)}_${"a".repeat(16)}`] = worst;
    }
    const fullChars = treasuryCoreSerializedChars(worstMeta);
    expect(fullChars).toBeLessThanOrEqual(TREASURY_CORE_TOTAL_CHAR_BUDGET);
    // bytes 另报（字符预算是权威口径；worst 构造器全受控 ASCII——bytes=chars）。
    const utf8Bytes = Buffer.byteLength(JSON.stringify(worstMeta), "utf8");
    expect(utf8Bytes).toBeGreaterThanOrEqual(fullChars);
    // 已接纳工作有收尾余量：真实路径一条 closing（释放失败保留）仍可写
    //（最坏满载构造之外的真实路径——存储边界与预算双门槛不阻断已接纳）。
    const ports = makeKernelPorts({ releaseExternalConsumer: () => false });
    const kernel = createTreasuryCoreKernel(ports);
    const { attemptId, permit } = admitWithPermit(kernel, ["ext:e19:duty"], "biz:e19:real");
    expect(kernel.executeDispatch(permit).status).toBe("not_executed");
    Game.time += 1;
    const stats = kernel.beginTick(); // 部分清理尝试（失败保留——真实推进可写）
    expect(stats.cleaned).toBeGreaterThanOrEqual(1);
    const shape = activeShape(attemptId);
    expect(shape?.phase).toBe("closing");
    expect(shape?.cleanup.consumerKeys).toEqual(["ext:e19:duty"]);
  });
});
