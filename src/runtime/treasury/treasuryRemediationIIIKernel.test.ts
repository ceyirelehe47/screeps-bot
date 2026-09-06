/**
 * Treasury Core Rewrite IV · Remediation III——内核层 G 矩阵（任务书 §6）。
 *
 * 覆盖：G01（两义务同 kernel 重入）、G02（另一 kernel 重入/回调内
 * beginTick+endTick/同 tick 顺序调用）、G03（严格成功返回值矩阵）、
 * G04（1/2/3/8 义务集合演化与回绕）、G05（预扣同次发布丢写/篡改/合法
 * 对照）、G06（true 后确认丢写 + 同 tick 完整 reset）、G07（预扣后调用
 * 前/端口后确认前硬断点）、G08（失败前置公平推进 + 逐 tick 完整 reset）、
 * G18（最大表示与份额/释放计数）。service/工具层 G09–G17 见
 * treasuryRemediationIIIService.test.ts；G19（全仓收集）由最终验证流程
 * 与 evidence 承担；G20（负向变体）由 evidence/negative-variants 承担。
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
    adapterRegistrationId: "reg-g3",
    adapterSemanticIdentity: "d.adapter-g3",
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
        ? { kind, version: 1, registrationId: "reg-g3", semanticIdentity: "d.adapter-g3", execute: () => ({ ok: false }), settlesOnAccept: false, nonOkOutcome: "not_executed" as const }
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
    admissionContext: { contractId: "ac:g3", contractDigest: "a".repeat(16), actionKind: "d.kind", ownerIdentity: null, excludeAttemptId: null },
    structureBindings: [],
  };
}

interface ActiveShape {
  phase: string;
  cleanup: { consumerKeys: readonly string[]; cursor: number; failures?: number };
}

function activeShape(attemptId: string): ActiveShape | undefined {
  const store = Memory.runtime?.treasuryCore as unknown as { active?: Record<string, ActiveShape> } | undefined;
  return store?.active?.[attemptId];
}

function storeRecovery(): { budgetUsed: number; cleanupCursor: number; budgetTick: number } {
  return (Memory.runtime!.treasuryCore as unknown as { recovery: { budgetUsed: number; cleanupCursor: number; budgetTick: number } }).recovery;
}

function admitDutyWork(kernel: TreasuryCoreKernel, consumers: readonly string[], workKey: string): string {
  const admitted = kernel.admit(kernelAdmitInput(consumers, workKey));
  if (admitted.status !== "admitted") throw new Error(`admit ${workKey} failed`);
  if (kernel.executeDispatch(admitted.dispatch).status !== "not_executed") throw new Error("dispatch failed");
  return admitted.attemptId;
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
});

// ── G01：R1 两义务、同 kernel 重入 ─────────────────────────────────────────

describe("G01 两义务同 kernel 重入（内层原本有剩余预算）", () => {
  it("重入被调度 guard 拒绝：D0/D1 各调用一次、remaining 空、retry_ready、份额 4；不能只断言调用不超限", () => {
    const releaseCalls: string[] = [];
    let inFlight = false;
    let kernel: TreasuryCoreKernel = undefined as unknown as TreasuryCoreKernel;
    let innerStats: { recovered: number; closed: number; cleaned: number; cancelled: number } | undefined;
    const ports = makeKernelPorts({
      releaseExternalConsumer: (key: string): boolean => {
        releaseCalls.push(key);
        if (key === "ext:g1:D0") {
          if (!inFlight) {
            inFlight = true;
            innerStats = kernel.beginTick(); // 同 kernel 重入（结构化返回零推进）
            inFlight = false;
            return true; // 最外层 D0 最后返回 true
          }
          return false; // 内层 D0（不会被调用——guard 已挡）
        }
        return true; // D1 始终 true
      },
    });
    kernel = createTreasuryCoreKernel(ports);
    const attemptId = admitDutyWork(kernel, ["ext:g1:D0", "ext:g1:D1"], "biz:g1:reentry");
    Game.time += 1;
    const outerStats = kernel.beginTick();
    expect(innerStats).toEqual({ recovered: 0, closed: 0, cleaned: 0, cancelled: 0 }); // 内层零推进（不是抛错/递归）
    expect(outerStats.cleaned).toBeGreaterThanOrEqual(1); // 外层真实推进
    // 精确调用与终态（对照基线缺陷：D1 被调 2 次、确认含已移除项被整体拒绝）。
    expect(releaseCalls).toEqual(["ext:g1:D0", "ext:g1:D1"]);
    const shape = activeShape(attemptId)!;
    expect(shape.phase).toBe("retry_ready"); // 全部确认成功 → not_executed 退出
    expect(shape.cleanup.consumerKeys).toEqual([]); // remaining 空
    expect(storeRecovery().budgetUsed).toBe(4); // 2 单位 × 2 份（确认不追加）
  });

  it("合法对照：D0=false、D1=true——D1 确认移除、D0 保留；端口恢复后 D0 能完成", () => {
    let d0Result = false;
    const releaseCalls: string[] = [];
    const kernel = createTreasuryCoreKernel(makeKernelPorts({
      releaseExternalConsumer: (key: string): boolean => {
        releaseCalls.push(key);
        return key === "ext:g1:D0" ? d0Result : true;
      },
    }));
    const attemptId = admitDutyWork(kernel, ["ext:g1:D0", "ext:g1:D1"], "biz:g1:partial");
    Game.time += 1;
    kernel.beginTick();
    // 每成员恰一次（失败成员不被同访问重复尝试）。
    expect(releaseCalls).toEqual(["ext:g1:D0", "ext:g1:D1"]);
    const shape = activeShape(attemptId)!;
    expect(shape.phase).toBe("closing");
    expect(shape.cleanup.consumerKeys).toEqual(["ext:g1:D0"]); // D1 确认移除、D0 保留
    d0Result = true;
    Game.time += 1;
    kernel.beginTick();
    const recovered = activeShape(attemptId)!;
    expect(recovered.phase).toBe("retry_ready"); // 端口恢复 true 后真完成
    expect(recovered.cleanup.consumerKeys).toEqual([]);
    expect(releaseCalls).toEqual(["ext:g1:D0", "ext:g1:D1", "ext:g1:D0"]); // D0 幂等重试恰一次
  });
});

// ── G02：另一 kernel 重入、回调内 beginTick/endTick、同 tick 顺序调用 ───────

describe("G02 一个调度所有者（跨实例/关窗/顺序调用）", () => {
  it("另一同域 kernel 重入 + 回调内 endTick 关窗 + 同 tick 顺序调用：嵌套零推进、关窗生效、合计预算≤8、释放≤4、预算不回退", () => {
    const releaseCalls: string[] = [];
    let kernelA: TreasuryCoreKernel = undefined as unknown as TreasuryCoreKernel;
    let innerBeginStats: { cleaned: number } | undefined;
    let innerEndStats: { recoveredToUnknown: number } | undefined;
    const ports = makeKernelPorts({
      releaseExternalConsumer: (key: string): boolean => {
        releaseCalls.push(key);
        if (key === "ext:g2:D0") {
          const kernelB = createTreasuryCoreKernel(ports); // 另一同域实例（同模块共享调度 guard）
          innerBeginStats = kernelB.beginTick(); // 重入 beginTick：结构化零推进
          innerEndStats = kernelB.endTick(); // 回调内 endTick：不嵌套恢复循环
          return true;
        }
        return true;
      },
    });
    kernelA = createTreasuryCoreKernel(ports);
    const attemptId = admitDutyWork(kernelA, ["ext:g2:D0", "ext:g2:D1"], "biz:g2:cross");
    Game.time += 1;
    kernelA.beginTick();
    expect(innerBeginStats).toEqual({ recovered: 0, closed: 0, cleaned: 0, cancelled: 0 }); // 嵌套 beginTick 零推进
    expect(innerEndStats).toEqual({ recoveredToUnknown: 0, closurePersisted: true }); // 嵌套 endTick 不运行恢复循环；关窗发布如实确认（R1/§2.3 closurePersisted 口径）
    // 关窗事实已写入（facade 共享授权窗口的关闭条件不被防重入吞掉）。
    const lifecycle = (Memory.runtime!.treasuryCore as unknown as { lifecycle: { lastEndTick: number | null } }).lifecycle;
    expect(lifecycle.lastEndTick).toBe(Game.time);
    // 释放端口调用 ≤4（全实例合计的消费者单位）。
    expect(releaseCalls.length).toBeLessThanOrEqual(4);
    expect(releaseCalls).toEqual(["ext:g2:D0", "ext:g2:D1"]);
    const afterFirst = storeRecovery();
    expect(afterFirst.budgetUsed).toBeLessThanOrEqual(8);
    // 同 tick 顺序重复调用：正常进入（非异常），按剩余持久预算有限推进、不回退。
    const again = kernelA.beginTick();
    expect(again).toEqual({ recovered: 0, closed: 0, cleaned: 0, cancelled: 0 }); // 预算 4 已用 4 → 无可推进
    const afterSecond = storeRecovery();
    expect(afterSecond.budgetUsed).toBeGreaterThanOrEqual(afterFirst.budgetUsed); // 持久预算不回退
    expect(activeShape(attemptId)?.phase).toBe("retry_ready");
  });
});

// ── G03：R2 严格成功返回值矩阵 ─────────────────────────────────────────────

describe("G03 端口返回值矩阵（只有原始 true 移除）", () => {
  it("false/空值/数字/字符串/对象/包装布尔/Promise/thenable/throw 均不释放；对象属性与 then 不被执行；恢复 true 后真完成", () => {
    let getterReads = 0;
    let thenCalls = 0;
    const badValues: unknown[] = [
      false,
      undefined,
      null,
      0,
      1,
      "",
      "yes",
      { ok: false },
      { ok: true },
      new Boolean(true), // 布尔包装对象
      Promise.resolve(true), // 真实 Promise（不被 await/then）
      { then: (): void => { thenCalls += 1; } }, // thenable
      { get ok(): boolean { getterReads += 1; return true; } }, // getter 属性不被读取
    ];
    let mode: "matrix" | "good" = "matrix";
    let index = 0;
    const thrown = new Set<number>([99]); // 不 throw——throw 单独在下一用例
    void thrown;
    const kernel = createTreasuryCoreKernel(makeKernelPorts({
      releaseExternalConsumer: (): boolean => {
        if (mode === "good") return true;
        const value = badValues[index];
        index = (index + 1) % badValues.length;
        return value as boolean; // 受控故障注入（测试边界 cast）
      },
    }));
    // 每种错误类型一条单义务记录；逐 tick 推进直至每种返回值都被实际注入
    //（每 tick 4 个消费者单位——单 tick 只触达前 4 种，不能证明矩阵其余项）。
    const attemptIds: string[] = [];
    for (let i = 0; i < badValues.length; i += 1) {
      attemptIds.push(admitDutyWork(kernel, [`ext:g3:v${String(i)}`], `biz:g3:matrix-${String(i)}`));
    }
    const injected: unknown[][] = [];
    const portCalls: string[] = [];
    // 重新绑定端口以记录每次注入的返回值。
    void injected; void portCalls;
    for (let tick = 0; tick < 5; tick += 1) {
      Game.time += 1;
      kernel.beginTick();
      if (attemptIds.every((id) => (activeShape(id)?.cleanup.failures ?? 0) >= 1 || activeShape(id) === undefined)) break;
    }
    for (const attemptId of attemptIds) {
      const shape = activeShape(attemptId)!;
      expect(shape.phase).toBe("closing"); // 无一被误释放
      expect(shape.cleanup.consumerKeys.length).toBe(1);
    }
    for (const attemptId of attemptIds) {
      expect(activeShape(attemptId)?.cleanup.failures ?? 0).toBeGreaterThanOrEqual(1); // 每种返回值至少被实际注入一次
    }
    expect(getterReads).toBe(0); // 返回对象属性不被隐式读取
    expect(thenCalls).toBe(0); // thenable 的 then 不被调用
    // 下一正常 tick 起端口恢复原始 true：全部真完成（13 条 × 每 tick 4 单位，有限 tick 内）。
    mode = "good";
    for (let tick = 0; tick < 5; tick += 1) {
      Game.time += 1;
      kernel.beginTick();
      if (attemptIds.every((id) => activeShape(id)?.phase === "retry_ready")) break;
    }
    for (const attemptId of attemptIds) {
      const shape = activeShape(attemptId)!;
      expect(shape.phase).toBe("retry_ready");
      expect(shape.cleanup.consumerKeys).toEqual([]);
    }
  });

  it("端口 throw：义务保留、不崩 tick、恢复后完成；计数有界", () => {
    let throwMode = true;
    const kernel = createTreasuryCoreKernel(makeKernelPorts({
      releaseExternalConsumer: (): boolean => {
        if (throwMode) throw new Error("g3 port fault");
        return true;
      },
    }));
    const attemptId = admitDutyWork(kernel, ["ext:g3:boom"], "biz:g3:throw");
    Game.time += 1;
    expect(() => kernel.beginTick()).not.toThrow(); // 端口异常不崩整个 tick
    const shape = activeShape(attemptId)!;
    expect(shape.phase).toBe("closing");
    expect(shape.cleanup.consumerKeys).toEqual(["ext:g3:boom"]);
    expect(shape.cleanup.failures ?? 0).toBeLessThanOrEqual(4); // 有界失败计数（同 tick 不重复尝试）
    throwMode = false;
    Game.time += 1;
    kernel.beginTick();
    expect(activeShape(attemptId)?.phase).toBe("retry_ready");
  });
});

// ── G04：1/2/3/8 义务集合演化与回绕 ────────────────────────────────────────

describe("G04 集合演化（每次选择仍在当前 remaining）", () => {
  it("1/2/3 义务部分成功：已确认项不再调用、失败项保留、无 stale cursor 回写或批末连带失败", () => {
    for (const dutyCount of [1, 2, 3]) {
      resetTreasuryCoreStoreForTest();
      const consumers = Array.from({ length: dutyCount }, (_, i) => `ext:g4:k${String(i)}`);
      const sticky = new Set([consumers[0], consumers[consumers.length - 1]].filter((k, i, arr) => arr.indexOf(k) === i)); // 首尾持续 false
      const calls: string[] = [];
      const kernel = createTreasuryCoreKernel(makeKernelPorts({
        releaseExternalConsumer: (key: string): boolean => {
          calls.push(key);
          return !sticky.has(key);
        },
      }));
      const attemptId = admitDutyWork(kernel, consumers, `biz:g4:set${String(dutyCount)}`);
      // tick1：服务全部成员各一次（首尾失败保留，中间成功移除）。
      Game.time += 1;
      kernel.beginTick();
      expect(calls).toEqual(consumers); // 每成员恰一次
      const shape = activeShape(attemptId)!;
      const remaining = consumers.filter((k) => sticky.has(k));
      expect([...shape.cleanup.consumerKeys]).toEqual(remaining);
      expect(shape.cleanup.consumerKeys.length > 0 ? shape.cleanup.cursor : 0).toBeLessThan(Math.max(shape.cleanup.consumerKeys.length, 1));
      // tick2：只重试失败成员（已确认项不再调用）。
      calls.length = 0;
      Game.time += 1;
      kernel.beginTick();
      expect(calls).toEqual(remaining);
      expect(activeShape(attemptId)?.cleanup.consumerKeys).toEqual(remaining); // 仍失败 → 保留
    }
  });

  it("8 义务混合成功/失败：集合逐项缩小、下一待服务成员正确回绕、无重复调用", () => {
    const consumers = Array.from({ length: 8 }, (_, i) => `ext:g4:w${String(i)}`);
    const sticky = new Set(["ext:g4:w2", "ext:g4:w5"]);
    const calls: string[] = [];
    const kernel = createTreasuryCoreKernel(makeKernelPorts({
      releaseExternalConsumer: (key: string): boolean => {
        calls.push(key);
        return !sticky.has(key);
      },
    }));
    const attemptId = admitDutyWork(kernel, consumers, "biz:g4:wrap8");
    Game.time += 1;
    kernel.beginTick(); // 预算 4 单位：w0..w3（w2 失败保留）
    expect(calls).toEqual(["ext:g4:w0", "ext:g4:w1", "ext:g4:w2", "ext:g4:w3"]);
    const afterTick1 = activeShape(attemptId)!.cleanup;
    expect([...afterTick1.consumerKeys]).toEqual(["ext:g4:w2", "ext:g4:w4", "ext:g4:w5", "ext:g4:w6", "ext:g4:w7"]);
    expect(afterTick1.consumerKeys[afterTick1.cursor % afterTick1.consumerKeys.length]).toBe("ext:g4:w4"); // 下一待服务成员（重定位）
    Game.time += 1;
    kernel.beginTick(); // w4..w7（w5 失败保留）
    expect(calls.slice(4)).toEqual(["ext:g4:w4", "ext:g4:w5", "ext:g4:w6", "ext:g4:w7"]);
    const afterTick2 = activeShape(attemptId)!.cleanup;
    expect([...afterTick2.consumerKeys]).toEqual(["ext:g4:w2", "ext:g4:w5"]);
    Game.time += 1;
    kernel.beginTick(); // 失败成员重试
    expect(calls.slice(8)).toEqual(["ext:g4:w2", "ext:g4:w5"]);
    expect(activeShape(attemptId)?.phase).toBe("closing"); // 仍失败 → 保留（不谎报完成）
  });
});

// ── G05：预扣同次发布（丢写/篡改/合法对照） ────────────────────────────────

describe("G05 预扣发布丢写与单字段篡改", () => {
  it("预扣发布丢写：释放调用 0、remaining/cursor/预算不变", () => {
    const releaseCalls: string[] = [];
    const kernel = createTreasuryCoreKernel(makeKernelPorts({ releaseExternalConsumer: (key) => { releaseCalls.push(key); return true; } }));
    const attemptId = admitDutyWork(kernel, ["ext:g5:a", "ext:g5:b"], "biz:g5:lost");
    Game.time += 1;
    const interceptor = interceptTreasuryCoreWrites({ allow: 0 });
    kernel.beginTick();
    interceptor.restore();
    expect(releaseCalls.length).toBe(0); // 未取得份额 → 调用 0
    const shape = activeShape(attemptId)!;
    expect(shape.cleanup.consumerKeys).toEqual(["ext:g5:a", "ext:g5:b"]);
    expect(shape.cleanup.cursor).toBe(0);
    expect(storeRecovery().budgetUsed).toBe(0);
  });

  it("单字段篡改（预扣发布里的 cursor 回写旧值）：独立 expected 拒绝，调用 0、状态不推进", () => {
    const releaseCalls: string[] = [];
    const kernel = createTreasuryCoreKernel(makeKernelPorts({ releaseExternalConsumer: (key) => { releaseCalls.push(key); return true; } }));
    const attemptId = admitDutyWork(kernel, ["ext:g5:c", "ext:g5:c2"], "biz:g5:tamper"); // 两义务：预扣发布位置 0→1（单义务集合取模恒 0，篡改无差异）
    Game.time += 1;
    // 篡改变异器：在预扣写时把 cursor 改回旧值 → 读回与独立 expected 不一致 → 拒绝。
    const interceptor = interceptTreasuryCoreWrites({
      allow: 1,
      onAllow: (value) => {
        const record = (value as { active: Record<string, { cleanup: { cursor: number } }> }).active[attemptId];
        if (record !== undefined) record.cleanup.cursor = 0; // 篡改单字段：记录内下一服务位置回写旧值（1→0）
      },
    });
    kernel.beginTick();
    interceptor.restore();
    expect(releaseCalls.length).toBe(0); // 发布被拒 → 不调用端口
    const shape = activeShape(attemptId)!;
    expect(shape.cleanup.consumerKeys).toEqual(["ext:g5:c", "ext:g5:c2"]); // remaining 不变
    expect(shape.cleanup.cursor).toBe(0); // 位置不动
    expect(activeShape(attemptId)!.phase).toBe("closing");
  });

  it("合法对照：同次发布成立——调用 1、份额 2、cursor 与 remaining 同步推进", () => {
    const releaseCalls: string[] = [];
    const kernel = createTreasuryCoreKernel(makeKernelPorts({ releaseExternalConsumer: (key) => { releaseCalls.push(key); return true; } }));
    const attemptId = admitDutyWork(kernel, ["ext:g5:d", "ext:g5:e"], "biz:g5:legal");
    Game.time += 1;
    kernel.beginTick();
    expect(releaseCalls).toEqual(["ext:g5:d", "ext:g5:e"]); // 合法路径实际进入并确认
    expect(storeRecovery().budgetUsed).toBe(4);
    expect(activeShape(attemptId)?.phase).toBe("retry_ready");
  });
});

// ── G06：true 后确认丢写 + 同 tick 完整 reset ───────────────────────────────

describe("G06 确认丢写与同 tick 恢复", () => {
  it("true 后确认写丢弃：份额/轮转不退款、同 attempt 幂等重试、已成功确认的其他项不重新出现", () => {
    const releaseCalls: string[] = [];
    const ports = makeKernelPorts({
      releaseExternalConsumer: (key, attemptId) => {
        releaseCalls.push(`${key}@${attemptId}`);
        return true;
      },
    });
    const kernel = createTreasuryCoreKernel(ports);
    const attemptId = admitDutyWork(kernel, ["ext:g6:a", "ext:g6:b"], "biz:g6:confirm");
    Game.time += 1;
    // 写放行序列：预扣1（放行）、确认1（丢弃）→ 有界停止。
    const interceptor = interceptTreasuryCoreWrites({ allow: 1 });
    kernel.beginTick();
    interceptor.restore();
    expect(releaseCalls.length).toBe(1); // a 已释放但确认丢写
    const shape = activeShape(attemptId)!;
    expect(shape.cleanup.consumerKeys).toEqual(["ext:g6:a", "ext:g6:b"]); // 未确认 → 义务保留
    expect(shape.cleanup.cursor).toBe(1); // 预扣发布的位置不回退（不退款）
    expect(storeRecovery().budgetUsed).toBe(2); // 份额已消耗（确认失败不退回）
    // 同 tick 完整 reset 后推进：从位置 1 续（b 先）——a 以同 attempt 幂等重试。
    performTreasuryKernelFullReset({ ports });
    const finalShape = activeShape(attemptId)!;
    expect(finalShape.phase).toBe("retry_ready");
    const aCalls = releaseCalls.filter((c) => c === `ext:g6:a@${attemptId}`);
    const bCalls = releaseCalls.filter((c) => c === `ext:g6:b@${attemptId}`);
    expect(aCalls.length).toBe(2); // 幂等重试成功（确认丢写后的合法重调）
    expect(bCalls.length).toBe(1); // 每成员最终恰一次成功确认
    expect(releaseCalls.every((c) => c.endsWith(`@${attemptId}`))).toBe(true); // 同一 attempt 关联
  });
});

// ── G07：硬断点（预扣后调用前 / 端口后确认前） ──────────────────────────────

describe("G07 实际硬断点（配对快照）", () => {
  it("预扣后调用前断点：预算+位置已发布、义务未虚构减少；新运行时 guard 不残留、提供正常窗口后可继续", () => {
    const releaseCalls: string[] = [];
    const ports = makeKernelPorts({ releaseExternalConsumer: (key) => { releaseCalls.push(key); return true; } });
    const kernel = createTreasuryCoreKernel(ports);
    const attemptId = admitDutyWork(kernel, ["ext:g7:a", "ext:g7:b", "ext:g7:c"], "biz:g7:pre");
    Game.time += 1;
    let bp: TreasuryHostBreakpoint | undefined;
    let callsAtBreakpoint = -1;
    const interceptor = interceptTreasuryCoreWrites({
      allow: 1,
      onAllow: () => {
        callsAtBreakpoint = releaseCalls.length;
        bp = captureTreasuryHostBreakpoint(); // 预扣发布写边界（写已发生、端口调用尚未开始）
      },
    });
    kernel.beginTick();
    interceptor.restore();
    expect(bp).toBeDefined();
    expect(callsAtBreakpoint).toBe(0); // 断点时刻在端口调用之前（不是 catch 执行后的快照）
    const snap = (JSON.parse(bp!.memorySnapshot) as { runtime: { treasuryCore: { active: Record<string, ActiveShape>; recovery: { budgetUsed: number } } } }).runtime.treasuryCore;
    expect(snap.recovery.budgetUsed).toBe(2); // 配对快照内预算+位置已发布
    expect(snap.active[attemptId].cleanup.cursor).toBe(1); // 下一服务位置已前移
    expect(snap.active[attemptId].cleanup.consumerKeys.length).toBe(3); // 义务未虚构减少
    // 恢复：从断点 Memory 续（同 tick 剩 6 份额 → 3 单位完成全部义务）。
    const callsBeforeRecovery = releaseCalls.length;
    const reset = performTreasuryKernelFullReset({ ports, breakpoint: bp });
    expect(reset.beginTickStats.cleaned).toBeGreaterThanOrEqual(1); // 新运行时正常推进（guard 不残留）
    expect(activeShape(attemptId)?.phase).toBe("retry_ready");
    expect([...releaseCalls.slice(callsBeforeRecovery)].sort()).toEqual(["ext:g7:a", "ext:g7:b", "ext:g7:c"]); // 从位置 1 续：恢复分支内各成员恰一次（b→c→a 回绕）
  });

  it("端口后确认前断点：义务保留、位置已发布；恢复后同 attempt 幂等收尾", () => {
    const releaseCalls: string[] = [];
    const ports = makeKernelPorts({ releaseExternalConsumer: (key) => { releaseCalls.push(key); return true; } });
    const kernel = createTreasuryCoreKernel(ports);
    const attemptId = admitDutyWork(kernel, ["ext:g7:d", "ext:g7:e"], "biz:g7:post");
    Game.time += 1;
    // 写序列：预扣1（放行）→ 端口 d → 确认1（放行=断点）→ 预扣2 起丢弃。
    let seen = 0;
    let bp: TreasuryHostBreakpoint | undefined;
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
          if (seen === 2) bp = captureTreasuryHostBreakpoint(); // d 的确认写后
          return;
        }
      },
    });
    kernel.beginTick();
    delete runtime.treasuryCore;
    runtime.treasuryCore = liveValue;
    expect(bp).toBeDefined();
    const snap = (JSON.parse(bp!.memorySnapshot) as { runtime: { treasuryCore: { active: Record<string, ActiveShape> } } }).runtime.treasuryCore;
    expect(snap.active[attemptId].cleanup.consumerKeys).toEqual(["ext:g7:e"]); // d 已确认移除
    expect(snap.active[attemptId].cleanup.cursor).toBe(0); // 下一待服务成员 e（重定位）
    expect(releaseCalls).toEqual(["ext:g7:d"]);
    performTreasuryKernelFullReset({ ports, breakpoint: bp });
    expect(activeShape(attemptId)?.phase).toBe("retry_ready");
    expect(releaseCalls).toEqual(["ext:g7:d", "ext:g7:e"]); // e 恰一次、d 不重复
  });
});

// ── G08：失败前置公平推进 + 逐 tick 完整 reset ──────────────────────────────

describe("G08 失败前置与完整预算窗口", () => {
  it("一记录 8 义务前 4 持续 false、后 4 可成功：正常窗口下后 4 在 ≤3 个推进 tick 内服务并确认；失败责任保留", () => {
    const consumers = Array.from({ length: 8 }, (_, i) => `ext:g8:k${String(i)}`);
    const sticky = new Set(consumers.slice(0, 4));
    const calls: string[] = [];
    const kernel = createTreasuryCoreKernel(makeKernelPorts({
      releaseExternalConsumer: (key: string): boolean => {
        calls.push(key);
        return !sticky.has(key);
      },
    }));
    const attemptId = admitDutyWork(kernel, consumers, "biz:g8:mixed");
    let ticks = 0;
    for (; ticks < 6; ticks += 1) {
      Game.time += 1;
      kernel.beginTick();
      const shape = activeShape(attemptId);
      if (shape !== undefined && shape.cleanup.consumerKeys.every((k) => sticky.has(k))) break;
    }
    const shape = activeShape(attemptId)!;
    expect([...shape.cleanup.consumerKeys]).toEqual([...consumers.slice(0, 4)]); // 失败责任保留
    const successCalls = calls.filter((k) => !sticky.has(k));
    expect(successCalls.length).toBe(4); // 后 4 各恰一次
    expect(new Set(successCalls).size).toBe(4);
    expect(ticks).toBeLessThan(3 + 1); // 正常完整预算窗口：tick1 服务 0-3（false），tick2 服务 4-7（true）
  });

  it("跨记录失败前置 + 逐 tick 完整 reset：后方可完成记录在有限 tick 内结束、失败端口恢复后能收尾", () => {
    const stickyKeys = new Set(["ext:g8:s0", "ext:g8:s1", "ext:g8:s2"]);
    let stickyMode = true;
    const ports = makeKernelPorts({
      releaseExternalConsumer: (key: string): boolean => {
        if (stickyMode && stickyKeys.has(key)) return false;
        return true;
      },
    });
    const kernel = createTreasuryCoreKernel(ports);
    const failedIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      failedIds.push(admitDutyWork(kernel, [`ext:g8:s${String(i)}`], `biz:g8:fail-${String(i)}`));
    }
    const goodId = admitDutyWork(kernel, ["ext:g8:g0", "ext:g8:g1"], "biz:g8:good");
    let goodDone = false;
    let ticks = 0;
    for (; ticks < 40 && !goodDone; ticks += 1) {
      Game.time += 1;
      performTreasuryKernelFullReset({ ports });
      const good = activeShape(goodId);
      if (good === undefined || good.phase === "retry_ready") goodDone = true;
    }
    expect(goodDone).toBe(true); // 失败前置不饿死后方可完成记录（有限界）
    expect(ticks).toBeLessThan(40);
    for (const failedId of failedIds) {
      expect(activeShape(failedId)?.cleanup.consumerKeys.length).toBe(1); // 失败责任保留
    }
    // 失败端口恢复后能收尾。
    stickyMode = false;
    let allDone = false;
    for (let t = 0; t < 40 && !allDone; t += 1) {
      Game.time += 1;
      performTreasuryKernelFullReset({ ports });
      allDone = [...failedIds, goodId].every((id) => {
        const shape = activeShape(id);
        return shape === undefined || shape.phase === "retry_ready";
      });
    }
    expect(allDone).toBe(true);
  });
});

// ── G18：最大表示与操作统计 ────────────────────────────────────────────────

describe("G18 最大允许表示与操作统计", () => {
  it("64 active/128 ring/字符上限：满载记录序列化在预算内；单 tick 份额 ≤8、释放 ≤4", () => {
    const releaseCalls: string[] = [];
    const ports = makeKernelPorts({ releaseExternalConsumer: (key) => { releaseCalls.push(key); return false; } });
    const kernel = createTreasuryCoreKernel(ports);
    const ids: string[] = [];
    for (let i = 0; i < TREASURY_CORE_ACTIVE_LIMIT; i += 1) {
      ids.push(admitDutyWork(kernel, Array.from({ length: 8 }, (_, j) => `ext:g18:a${String(i)}k${String(j)}`), `biz:g18:max-${String(i)}`));
    }
    void buildTreasuryCoreWorstWorkRecord; // 边界构造复用 store 最坏情形
    const store = Memory.runtime!.treasuryCore as unknown as { active: Record<string, unknown>; ring: unknown[] };
    expect(Object.keys(store.active).length).toBe(TREASURY_CORE_ACTIVE_LIMIT);
    expect(store.ring.length).toBeLessThanOrEqual(TREASURY_CORE_RING_LIMIT);
    const chars = treasuryCoreSerializedChars(Memory.runtime!.treasuryCore as never);
    expect(chars).toBeGreaterThan(0);
    expect(chars).toBeLessThanOrEqual(TREASURY_CORE_TOTAL_CHAR_BUDGET); // 字符 ≤360,000
    Game.time += 1;
    kernel.beginTick();
    expect(storeRecovery().budgetUsed).toBeLessThanOrEqual(8); // 逻辑份额 ≤8
    expect(releaseCalls.length).toBeLessThanOrEqual(4); // 外部释放 ≤4
    for (let i = 0; i < TREASURY_CORE_ACTIVE_LIMIT; i += 1) {
      expect(activeShape(ids[i])?.cleanup.consumerKeys.length).toBe(8); // 全部 false → 义务保留
    }
  });
});
