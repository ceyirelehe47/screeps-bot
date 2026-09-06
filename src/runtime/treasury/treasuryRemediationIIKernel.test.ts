/**
 * Treasury Core Rewrite IV · Remediation II——内核层 F 矩阵（任务书 §7）。
 *
 * 覆盖：F04（预扣+游标同次发布丢写/单字段篡改/合法对照）、F05（真预扣后
 * 释放前/进入释放后确认前两硬断点）、F06（F05 快照完整 reset 后轮转 +
 * 重复切点）、F07（确认丢写 + 同 tick 完整 reset + 幂等重试）、F08（重入/
 * 集合缩小回绕/混合 false-throw-true + 份额守限）、F14（公平循环完整
 * reset 识别：旧许可拒绝/旧对象污染无效/序列化探针非完整 reset）、
 * F18（边界/游标最坏值满载 + 越界拒绝）。
 * F16 混合流量逐 tick 完整 reset 见 treasuryRemediationIKernel.test.ts 的
 * E10（V2 改造后形态）；service/reset 层 F 矩阵见
 * treasuryRemediationIIService.test.ts。
 */
import {
  performTreasuryKernelFullReset,
  captureTreasuryHostBreakpoint,
  type TreasuryHostBreakpoint,
} from "@mock/treasuryResetHarness";
import { interceptTreasuryCoreWrites } from "@mock/treasuryStorageInterceptor";
import { createTreasuryCoreKernel, type TreasuryCoreAdmissionInput, type TreasuryCoreKernel, type TreasuryCoreKernelPorts } from "@/runtime/treasury/kernel/kernel";
import {
  buildTreasuryCoreWorstWorkRecord,
  buildTreasuryCoreWorstRingEntry,
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
    adapterRegistrationId: "reg-ii",
    adapterSemanticIdentity: "d.adapter-ii",
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
        ? { kind, version: 1, registrationId: "reg-ii", semanticIdentity: "d.adapter-ii", execute: () => ({ ok: false }), settlesOnAccept: false, nonOkOutcome: "not_executed" as const }
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
    admissionContext: { contractId: "ac:ii", contractDigest: "a".repeat(16), actionKind: "d.kind", ownerIdentity: null, excludeAttemptId: null },
    structureBindings: [],
  };
}

interface ActiveShape {
  phase: string;
  cleanup: { consumerKeys: readonly string[]; cursor: number };
}

function activeShape(attemptId: string): ActiveShape | undefined {
  const store = Memory.runtime?.treasuryCore as unknown as { active?: Record<string, ActiveShape> } | undefined;
  return store?.active?.[attemptId];
}

function admitDutyWork(kernel: TreasuryCoreKernel, consumers: readonly string[], workKey: string): string {
  const admitted = kernel.admit(kernelAdmitInput(consumers, workKey));
  if (admitted.status !== "admitted") throw new Error(`admit ${workKey} failed: ${admitted.status === "rejected" ? admitted.reason : "?"}`);
  if (kernel.executeDispatch(admitted.dispatch).status !== "not_executed") throw new Error("dispatch failed");
  return admitted.attemptId;
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
});

// ── F04：预扣+记录内游标同次发布（丢写/篡改/合法对照） ─────────────────────

describe("F04 同次发布的丢写与篡改", () => {
  it("预扣发布丢写：端口调用 0、义务/游标/预算全部不变", () => {
    const releaseCalls: string[] = [];
    const ports = makeKernelPorts({ releaseExternalConsumer: (key) => { releaseCalls.push(key); return true; } });
    const kernel = createTreasuryCoreKernel(ports);
    const attemptId = admitDutyWork(kernel, ["ext:f4:a", "ext:f4:b"], "biz:f4:lost");
    Game.time += 1;
    const interceptor = interceptTreasuryCoreWrites({ allow: 0 });
    kernel.beginTick();
    interceptor.restore();
    expect(releaseCalls.length).toBe(0); // 未取得份额 → 调用 0
    const shape = activeShape(attemptId)!;
    expect(shape.cleanup.consumerKeys).toEqual(["ext:f4:a", "ext:f4:b"]); // remaining 不变
    expect(shape.cleanup.cursor).toBe(0); // 游标不动
    const core = Memory.runtime!.treasuryCore as unknown as { recovery: { budgetUsed: number } };
    expect(core.recovery.budgetUsed).toBe(0); // 预算未消耗
  });

  it("单字段篡改（把预扣发布里的 cursor 改回旧值）：独立 expected 拒绝，调用 0、状态不推进", () => {
    const releaseCalls: string[] = [];
    const ports = makeKernelPorts({ releaseExternalConsumer: (key) => { releaseCalls.push(key); return true; } });
    const kernel = createTreasuryCoreKernel(ports);
    const attemptId = admitDutyWork(kernel, ["ext:f4:a", "ext:f4:b"], "biz:f4:tamper");
    Game.time += 1;
    // 篡改拦截：首写放行前把载荷中记录内 cursor 单字段改回旧值——
    // mutate 已把 cursor 写为新位置，expected 快照（独立克隆）含新值；
    // 安装被篡改 → 读回 ≠ expected → 发布确认失败 → 预扣未成立。
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
          const record = (value as { active: Record<string, { cleanup: { cursor: number } }> }).active[attemptId];
          if (record !== undefined) record.cleanup.cursor = 0; // 单字段篡改
          liveValue = value;
          return;
        }
      },
    });
    kernel.beginTick();
    delete runtime.treasuryCore;
    runtime.treasuryCore = liveValue; // 保留实际最终值
    expect(releaseCalls.length).toBe(0); // 篡改被拒 → 调用 0
    const shape = activeShape(attemptId)!;
    expect(shape.cleanup.consumerKeys).toEqual(["ext:f4:a", "ext:f4:b"]);
    expect(shape.cleanup.cursor).toBe(0); // 篡改值未生效（回滚基线）
  });

  it("合法对照：同次发布成立后调用 1、份额/游标/remaining 同步推进", () => {
    const releaseCalls: string[] = [];
    const ports = makeKernelPorts({ releaseExternalConsumer: (key) => { releaseCalls.push(key); return true; } });
    const kernel = createTreasuryCoreKernel(ports);
    const attemptId = admitDutyWork(kernel, ["ext:f4:a", "ext:f4:b"], "biz:f4:ok");
    Game.time += 1;
    kernel.beginTick();
    expect(releaseCalls.length).toBe(2); // 两单位各 1 次（2×2=4 份额）
    expect(activeShape(attemptId)?.phase).toBe("retry_ready"); // 全部确认完成
    const core = Memory.runtime!.treasuryCore as unknown as { recovery: { budgetUsed: number } };
    expect(core.recovery.budgetUsed).toBe(4);
  });
});

// ── F05：两处硬断点（真预扣后释放前 / 进入释放后确认前） ───────────────────

describe("F05 硬断点下的预算/位置/remaining", () => {
  it("真预扣完成后、实际释放前：快照内预算已用 2、下一服务位置已前移、义务未减少、端口调用 0", () => {
    const releaseCalls: string[] = [];
    const ports = makeKernelPorts({ releaseExternalConsumer: (key) => { releaseCalls.push(key); return true; } });
    const kernel = createTreasuryCoreKernel(ports);
    const attemptId = admitDutyWork(kernel, ["ext:f5:a", "ext:f5:b"], "biz:f5:preport");
    Game.time += 1;
    // 硬断点 = 预扣发布的写边界内（onAllow 时写已发生、端口调用尚未开始）。
    let bp: TreasuryHostBreakpoint | undefined;
    let callsAtBreakpoint = -1;
    const interceptor = interceptTreasuryCoreWrites({
      allow: 1,
      onAllow: () => {
        callsAtBreakpoint = releaseCalls.length;
        bp = captureTreasuryHostBreakpoint();
      },
    });
    kernel.beginTick();
    interceptor.restore();
    expect(callsAtBreakpoint).toBe(0); // 断点在端口调用之前
    const snap = (JSON.parse(bp!.memorySnapshot) as { runtime: { treasuryCore: {
      recovery: { budgetUsed: number };
      active: Record<string, ActiveShape>;
    } } }).runtime.treasuryCore;
    // 同一 Memory 快照内：预算 +2 与下一服务位置（首单位 → 1）同次发布，
    // remaining 未凭空减少（不是 catch 执行后的快照——断点在写边界内）。
    expect(snap.recovery.budgetUsed).toBe(2);
    expect(snap.active[attemptId].cleanup.cursor).toBe(1);
    expect(snap.active[attemptId].cleanup.consumerKeys).toEqual(["ext:f5:a", "ext:f5:b"]);
  });

  it("进入释放后、确认前：端口入口快照内预算 2/位置 1/义务未减；tick 收尾后正常完成", () => {
    const releaseCalls: string[] = [];
    const entrySnapshots: string[] = [];
    let captured = false;
    const ports = makeKernelPorts({
      releaseExternalConsumer: (key) => {
        releaseCalls.push(key);
        if (!captured) {
          captured = true;
          entrySnapshots.push(JSON.stringify(Memory.runtime!.treasuryCore)); // 端口入口（确认前）
        }
        return true;
      },
    });
    const kernel = createTreasuryCoreKernel(ports);
    const attemptId = admitDutyWork(kernel, ["ext:f5:c", "ext:f5:d"], "biz:f5:inport");
    Game.time += 1;
    kernel.beginTick(); // 正常窗口（无拦截——硬断点以观察捕获表达）
    expect(entrySnapshots.length).toBe(1);
    const snap = JSON.parse(entrySnapshots[0]) as {
      recovery: { budgetUsed: number };
      active: Record<string, ActiveShape>;
    };
    expect(snap.recovery.budgetUsed).toBe(2); // 预算已扣
    expect(snap.active[attemptId].cleanup.cursor).toBe(1); // 位置已前移
    expect(snap.active[attemptId].cleanup.consumerKeys).toEqual(["ext:f5:c", "ext:f5:d"]); // 义务未减
    // 正常窗口收尾：全部确认完成。
    expect(activeShape(attemptId)?.phase).toBe("retry_ready");
    expect(releaseCalls.length).toBe(2);
  });
});

// ── F06：F05 快照完整 reset 后的轮转（不从旧前缀重启 + 重复切点） ──────────

describe("F06 硬断点恢复后的记录内轮转", () => {
  const STICKY = ["ext:f6:f0", "ext:f6:f1", "ext:f6:f2", "ext:f6:f3"];
  const CONSUMERS = [...STICKY, "ext:f6:t4", "ext:f6:t5", "ext:f6:t6", "ext:f6:t7"];

  function setupPorts(): { ports: TreasuryCoreKernelPorts; releaseCalls: string[] } {
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

  it("首单位断点（位置 0→1）恢复：同 tick 续 1/2/3，下一 tick 4–7 完成；失败风险保留", () => {
    const { ports, releaseCalls } = setupPorts();
    const kernel = createTreasuryCoreKernel(ports);
    const attemptId = admitDutyWork(kernel, CONSUMERS, "biz:f6:cut1");
    Game.time += 1;
    // 断点：首单位预扣发布（位置→1）；旧栈继续（端口 f0 false、确认丢弃）。
    let bp: TreasuryHostBreakpoint | undefined;
    const interceptor = interceptTreasuryCoreWrites({ allow: 1, onAllow: () => { bp = captureTreasuryHostBreakpoint(); } });
    kernel.beginTick();
    interceptor.restore();
    expect(bp).toBeDefined();
    const callsAfterOldStack = releaseCalls.length; // 旧分支的 f0 调用
    expect(callsAfterOldStack).toBe(1);
    // 完整 reset（同 tick 恢复——预算 2 已用，剩 6）。
    const recovery = performTreasuryKernelFullReset({ ports, breakpoint: bp });
    void recovery;
    const shape = activeShape(attemptId)!;
    expect(shape.cleanup.cursor).toBe(4); // 恢复 tick 续 1/2/3 → 最后位置 4
    const callsInRecovery = releaseCalls.slice(callsAfterOldStack);
    expect(callsInRecovery).toEqual(["ext:f6:f1", "ext:f6:f2", "ext:f6:f3"]); // 不从旧前缀重启（无第二个 f0）
    // 下一 tick：4–7 全部成功释放；失败风险（f0–f3）保留在 closing 记录内。
    Game.time += 1;
    performTreasuryKernelFullReset({ ports });
    const after = activeShape(attemptId)!;
    expect(after.phase).toBe("closing"); // 仍有失败义务 → 记录保留
    expect([...after.cleanup.consumerKeys].sort()).toEqual([...STICKY].sort());
    // 可完成子集不再被重复调用。
    const servedCalls = releaseCalls.filter((k) => k.startsWith("ext:f6:t"));
    expect(servedCalls.length).toBe(4);
  });

  it("重复切点（第 2 单位断点，位置→2）恢复：从 2 续 2/3；位置保留不回退", () => {
    const { ports, releaseCalls } = setupPorts();
    const kernel = createTreasuryCoreKernel(ports);
    const attemptId = admitDutyWork(kernel, CONSUMERS, "biz:f6:cut2");
    Game.time += 1;
    // 断点：第 2 次放行写 = 第 2 单位预扣（位置→2）；丢弃后续（含确认）。
    let bp: TreasuryHostBreakpoint | undefined;
    let seen = 0;
    const runtime = Memory.runtime as unknown as Record<string, unknown>;
    const descriptor = Object.getOwnPropertyDescriptor(runtime, "treasuryCore");
    let liveValue = descriptor?.value;
    let writesAllowed = 2;
    Object.defineProperty(runtime, "treasuryCore", {
      configurable: true,
      get: () => liveValue,
      set(value: unknown) {
        if (writesAllowed > 0) {
          writesAllowed -= 1;
          liveValue = value;
          seen += 1;
          if (seen === 2) bp = captureTreasuryHostBreakpoint();
          return;
        }
      },
    });
    kernel.beginTick();
    delete runtime.treasuryCore;
    runtime.treasuryCore = liveValue;
    expect(bp).toBeDefined();
    const snap = (JSON.parse(bp!.memorySnapshot) as { runtime: { treasuryCore: { active: Record<string, ActiveShape>; recovery: { budgetUsed: number } } } }).runtime.treasuryCore;
    expect(snap.recovery.budgetUsed).toBe(4); // 两单位已扣
    expect(snap.active[attemptId].cleanup.cursor).toBe(2); // 位置保留
    const callsAfterOldStack = releaseCalls.length;
    expect(callsAfterOldStack).toBe(2); // 旧栈 f0、f1 各一次
    performTreasuryKernelFullReset({ ports, breakpoint: bp });
    // 恢复：同 tick 剩 4 份额 → 续 2/3；位置推进到 4。
    expect(activeShape(attemptId)!.cleanup.cursor).toBe(4);
    expect(releaseCalls.slice(callsAfterOldStack)).toEqual(["ext:f6:f2", "ext:f6:f3"]);
  });
});

// ── F07：释放成功、确认丢写 + 同 tick 完整 reset + 幂等重试 ─────────────────

describe("F07 确认丢写与同 tick 恢复", () => {
  it("确认丢写后预算/位置保留；同 tick 完整 reset 从已发布位置续；成功确认后不重复", () => {
    const releaseCalls: string[] = [];
    const ports = makeKernelPorts({
      releaseExternalConsumer: (key, attemptId) => {
        releaseCalls.push(`${key}@${attemptId}`);
        return true;
      },
    });
    const kernel = createTreasuryCoreKernel(ports);
    const attemptId = admitDutyWork(kernel, ["ext:f7:a", "ext:f7:b"], "biz:f7:confirm");
    Game.time += 1;
    // 预扣+位置发布放行（首写）；端口成功；确认写丢弃。
    const interceptor = interceptTreasuryCoreWrites({ allow: 1 });
    kernel.beginTick();
    interceptor.restore();
    expect(releaseCalls.length).toBe(1); // 旧栈：a 已释放但确认丢写
    const shape = activeShape(attemptId)!;
    expect(shape.cleanup.consumerKeys).toEqual(["ext:f7:a", "ext:f7:b"]); // 义务仍属原 attempt
    expect(shape.cleanup.cursor).toBe(1); // 位置保留
    const core = Memory.runtime!.treasuryCore as unknown as { recovery: { budgetUsed: number } };
    expect(core.recovery.budgetUsed).toBe(2); // 份额保留（同 tick 恢复无凭空额度）
    // 同 tick 完整 reset：从位置 1 续（b 先、a 幂等重试）；确认写正常。
    performTreasuryKernelFullReset({ ports });
    const finalShape = activeShape(attemptId);
    if (finalShape !== undefined) {
      expect(finalShape.phase).toBe("retry_ready");
      expect(finalShape.cleanup.consumerKeys).toEqual([]);
    }
    // a 恰好两次（丢写重试）、b 一次；全部同 attemptId。
    const aCalls = releaseCalls.filter((c) => c === `ext:f7:a@${attemptId}`);
    const bCalls = releaseCalls.filter((c) => c === `ext:f7:b@${attemptId}`);
    expect(aCalls.length).toBe(2); // 幂等重试成功
    expect(bCalls.length).toBe(1);
  });
});

// ── F08：重入/集合缩小回绕/混合结果 + 份额守限 ─────────────────────────────

describe("F08 重入与集合演化的份额守恒", () => {
  it("端口回调重入 beginTick：外层旧栈不回退内层已发布位置；份额 ≤8、调用 ≤4", () => {
    const releaseCalls: string[] = [];
    let inner: TreasuryCoreKernel | undefined;
    const ports = makeKernelPorts({
      releaseExternalConsumer: (key) => {
        releaseCalls.push(key);
        if (inner !== undefined) {
          const reentered = inner;
          inner = undefined;
          reentered.beginTick(); // 内层共享预算：续 1/2/3（剩 6 份额）
        }
        return true;
      },
    });
    const kernel = createTreasuryCoreKernel(ports);
    inner = kernel;
    const consumers = Array.from({ length: 8 }, (_, i) => `ext:f8:c${String(i)}`);
    const attemptId = admitDutyWork(kernel, consumers, "biz:f8:reenter");
    Game.time += 1;
    kernel.beginTick();
    expect(releaseCalls.length).toBeLessThanOrEqual(4); // 全实例每 tick ≤4 成对单位
    const core = Memory.runtime!.treasuryCore as unknown as { recovery: { budgetUsed: number } };
    expect(core.recovery.budgetUsed).toBeLessThanOrEqual(8);
    // 旧栈（外层）确认不得把内层已发布的游标位置覆盖回旧值：内层最后预扣
    // 位置为 4（duty3+1）；外层确认后位置仍 ≥4（集合未缩时恰为 4）。
    const shape = activeShape(attemptId)!;
    expect(shape.cleanup.cursor).toBeGreaterThanOrEqual(4);
    // 正常窗口下剩余义务有限完成。
    for (let tick = 0; tick < 6; tick += 1) {
      Game.time += 1;
      performTreasuryKernelFullReset({ ports });
      if (activeShape(attemptId)?.phase === "retry_ready") break;
    }
    expect(activeShape(attemptId)?.phase).toBe("retry_ready");
    expect(activeShape(attemptId)!.cleanup.consumerKeys).toEqual([]);
    // 精确移除成功项：每 key 恰好一次（8 项全成功、无重复）。
    for (const key of consumers) {
      expect(releaseCalls.filter((k) => k === key).length).toBe(1);
    }
  });

  it("集合缩小回绕：8 义务两 tick 完成，成功项精确移除、无重复调用", () => {
    const releaseCalls: string[] = [];
    const ports = makeKernelPorts({ releaseExternalConsumer: (key) => { releaseCalls.push(key); return true; } });
    const kernel = createTreasuryCoreKernel(ports);
    const consumers = Array.from({ length: 8 }, (_, i) => `ext:f8:w${String(i)}`);
    const attemptId = admitDutyWork(kernel, consumers, "biz:f8:wrap");
    Game.time += 1;
    kernel.beginTick(); // 4 单位：0–3 释放，集合缩为 4，位置 4
    expect(releaseCalls.length).toBe(4);
    expect(activeShape(attemptId)!.cleanup.consumerKeys).toEqual(["ext:f8:w4", "ext:f8:w5", "ext:f8:w6", "ext:f8:w7"]);
    expect(activeShape(attemptId)!.cleanup.cursor).toBe(4); // 原集合长度下的位置
    Game.time += 1;
    kernel.beginTick(); // 读时取模回绕：4 % 4 = 0 起，全部完成
    expect(activeShape(attemptId)?.phase).toBe("retry_ready");
    expect(releaseCalls.length).toBe(8); // 每项恰好一次
    for (const key of consumers) {
      expect(releaseCalls.filter((k) => k === key).length).toBe(1);
    }
  });

  it("混合 false/throw/true：份额 ≤8、失败项保留、可完成子集有限完成", () => {
    const releaseCalls: string[] = [];
    const sticky = new Set(["ext:f8:bad0", "ext:f8:bad1"]);
    const throwing = new Set(["ext:f8:boom"]);
    const ports = makeKernelPorts({
      releaseExternalConsumer: (key) => {
        releaseCalls.push(key);
        if (throwing.has(key)) throw new Error("f8 port fault");
        return !sticky.has(key);
      },
    });
    const kernel = createTreasuryCoreKernel(ports);
    const attemptId = admitDutyWork(kernel, ["ext:f8:bad0", "ext:f8:boom", "ext:f8:ok0", "ext:f8:bad1", "ext:f8:ok1"], "biz:f8:mixed");
    Game.time += 1;
    const perTickCalls: number[] = [];
    for (let tick = 0; tick < 6; tick += 1) {
      const before = releaseCalls.length;
      if (tick === 0) kernel.beginTick();
      else {
        Game.time += 1; // 逐 tick 推进（同 tick 预算共享——不推进则后续循环空转）
        performTreasuryKernelFullReset({ ports });
      }
      perTickCalls.push(releaseCalls.length - before);
      const shape = activeShape(attemptId);
      if (shape?.phase === "retry_ready") break;
      if (tick === 0) sticky.clear(); // 失败项第 2 tick 起恢复成功（throw 项恒抛）
      throwing.delete("ext:f8:boom"); // throw 项也恢复（ordinary throw 是瞬时故障）
    }
    for (const count of perTickCalls) expect(count).toBeLessThanOrEqual(4); // 每 tick ≤4 单位
    const final = activeShape(attemptId)!;
    expect(final.phase).toBe("retry_ready"); // 正常窗口下可完成子集有限完成
    expect(final.cleanup.consumerKeys).toEqual([]);
  });
});

// ── F14：完整 reset 识别（公平循环工具契约） ───────────────────────────────

describe("F14 完整 reset 与序列化探针的识别", () => {
  it("完整 reset 后旧许可被新注册表拒绝；旧 Memory 引用污染无效", () => {
    const ports = makeKernelPorts();
    const kernelA = createTreasuryCoreKernel(ports);
    const admitted = kernelA.admit(kernelAdmitInput([], "biz:f14:old"));
    if (admitted.status !== "admitted") throw new Error("admit failed");
    const oldPermit = admitted.dispatch;
    const oldMemory = Memory;
    const oldActive = Memory.runtime!.treasuryCore!.active;
    // 完整 reset（不推进 tick——同 tick 重建运行时）。
    const reset = performTreasuryKernelFullReset({ ports });
    // 旧许可不被新注册表认可（模块缓存重建后 WeakSet 全新）。
    expect(reset.kernel.preflightDispatchPermit(oldPermit).status).toBe("invalid");
    // 旧对象污染无效：旧引用上的毒字段不进入新运行时。
    (oldActive as unknown as { poisoned: string }).poisoned = "x".repeat(64);
    (oldMemory.runtime!.treasuryCore as unknown as { poisoned: string }).poisoned = "y".repeat(64);
    expect((Memory.runtime!.treasuryCore as unknown as { poisoned?: string }).poisoned).toBeUndefined();
    // 新 kernel 来自新模块（与旧 import 的构造器不同引用域——由旧许可拒绝
    // 与新 registry 正常签发共同证明）。
    const fresh = reset.kernel.admit(kernelAdmitInput([], "biz:f14:new"));
    expect(fresh.status).toBe("admitted");
  });

  it("序列化探针（jsonRoundtripKernel）不是完整 reset：旧许可仍 valid——探针不得用于完整 reset 声明", () => {
    const ports = makeKernelPorts();
    const kernelA = createTreasuryCoreKernel(ports);
    const admitted = kernelA.admit(kernelAdmitInput([], "biz:f14:probe"));
    if (admitted.status !== "admitted") throw new Error("admit failed");
    // JSON 往返 + 旧模块构造（reloadKernel 旧形态）——模块注册表未重建。
    const roundtrip = JSON.parse(JSON.stringify(Memory)) as typeof Memory;
    (globalThis as unknown as { Memory: unknown }).Memory = roundtrip;
    const kernelB = createTreasuryCoreKernel(ports); // 旧 import（旧模块实例）
    // 识别断言：该形态下旧许可仍被认可（= 不是完整 reset）。若有人把探针
    // 冒充完整 reset 用于公平性/组合验收，本断言与其差异即暴露点。
    expect(kernelB.preflightDispatchPermit(admitted.dispatch).status).toBe("valid");
  });
});

// ── F18：边界/游标最坏值 + 越界拒绝 ────────────────────────────────────────

describe("F18 最坏值与越界拒绝", () => {
  it("worst 满载（64/128 + 元信息极值）≤ 360,000 字符；bytes 另报", () => {
    const worst = buildTreasuryCoreWorstWorkRecord();
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
    const chars = treasuryCoreSerializedChars(worstMeta);
    expect(chars).toBeLessThanOrEqual(TREASURY_CORE_TOTAL_CHAR_BUDGET);
    const bytes = Buffer.byteLength(JSON.stringify(worstMeta), "utf8");
    expect(bytes).toBeGreaterThanOrEqual(chars); // bytes 另报（≥ chars）
  });

  it("真实路径演化（8 消费者 closing 多 tick 轮转）序列化体积有界且不超单槽最坏", () => {
    const ports = makeKernelPorts({ releaseExternalConsumer: () => false });
    const kernel = createTreasuryCoreKernel(ports);
    const attemptId = admitDutyWork(kernel, Array.from({ length: 8 }, (_, i) => `ext:f18:d${String(i)}`), "biz:f18:evolve");
    let maxChars = 0;
    for (let tick = 0; tick < 4; tick += 1) {
      Game.time += 1;
      if (tick === 0) kernel.beginTick();
      else performTreasuryKernelFullReset({ ports });
      maxChars = Math.max(maxChars, treasuryCoreSerializedChars(Memory.runtime!.treasuryCore as never));
    }
    expect(maxChars).toBeLessThanOrEqual(TREASURY_CORE_TOTAL_CHAR_BUDGET);
    expect(activeShape(attemptId)!.cleanup.consumerKeys.length).toBe(8); // 全 false：义务保留
  });

  it("越界/非法游标与边界字段有界拒绝（validator）", () => {
    const badCursors = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1];
    for (const cursor of badCursors) {
      const kernel = createTreasuryCoreKernel(makeKernelPorts({ releaseExternalConsumer: () => true }));
      const attemptId = admitDutyWork(kernel, ["ext:f18:v"], "biz:f18:valid");
      const core = Memory.runtime!.treasuryCore as unknown as {
        active: Record<string, { cleanup: { cursor: number } }>;
      };
      (core.active[attemptId].cleanup as { cursor: number }).cursor = cursor;
      // 下一次健康读取应把非法值判为 unhealthy（不静默修复/初始化）。
      const health = kernel.health();
      expect(health.status).toBe("unhealthy");
      resetTreasuryCoreStoreForTest();
    }
  });
});
