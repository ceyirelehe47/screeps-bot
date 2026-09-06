/**
 * Core Rewrite IV · Remediation II——基线重现器（任务书 §8.2，持续回归形态）。
 *
 * 2026-09-05 在 0f5965e 上首次运行时：断言修复后应有的行为，当时全部红灯
 * （红灯日志与当时源码/工具快照见
 * openspec/…/core-rewrite-iv-remediation-ii/baseline/）。修复落地后转为
 * 正向回归：
 * - R1（覆盖语义统一）：真实执行后结果未写→完整 reset→exact executed 对账
 *   →A 仍 closing（invocation 空、boundary 在）且记录仍在时，当前观察已含
 *   效果 → 同一效果不再重复扣减（流出 200/201、流入 20/21 数值锚点）。
 * - R2（预扣与下一服务位置同次发布）：成对预扣成功的同一持久发布里，预算
 *   已用 2 且记录内下一服务位置已前移（确认命令前硬断点快照即持证）。
 * - R3（preflight 健康门禁）：合法 dispatch/rearm 许可遇 absent/incompatible/
 *   unhealthy 核心时两个只读预检明确拒绝（不再落入 valid）。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import {
  buildTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  replaceTreasuryActionAdapterForTest,
  resetTreasuryTestAdapterSideEffectsForTest,
} from "@/runtime/treasury/actionContracts";
import {
  clearTreasuryPolicyResolversForTest,
  makeNoReserveTreasuryPolicy,
  registerTreasuryPolicyResolver,
} from "@/runtime/treasury/policyAuthority";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { snapshotWholeMemory, performTreasuryFullReset } from "@mock/treasuryResetHarness";
import { createTreasuryCoreKernel, type TreasuryCoreAdmissionInput, type TreasuryCoreKernel, type TreasuryCoreKernelPorts } from "@/runtime/treasury/kernel/kernel";
import type {
  TreasuryCoreIdentityFacts,
  TreasuryCoreWorstCaseLeg,
} from "@/runtime/treasury/kernel/types";
import { installRooms, type RoomSpec } from "@mock/treasury";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 1000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 0 }, freeCapacity: 200_000 },
  },
  {
    name: "W2N57",
    storage: { id: "stor-2", resources: { energy: 0 }, freeCapacity: 10_000 },
    terminal: { id: "term-2", resources: { energy: 0 }, freeCapacity: 900_000 },
  },
];

/** 流入对照：目标 terminal 空位 100（§3.3 数值案例）。 */
const ROOMS_INFLOW: RoomSpec[] = [
  ROOMS[0],
  {
    name: "W2N57",
    storage: { id: "stor-2", resources: { energy: 0 }, freeCapacity: 10_000 },
    terminal: { id: "term-2", resources: { energy: 0 }, freeCapacity: 100 },
  },
];

function transferArgs(overrides: Partial<import("@/runtime/treasury/actionContracts").TreasuryTestTransferArgs> = {}) {
  return {
    fromRoom: "W1N57",
    fromLocation: "storage",
    toRoom: "W2N57",
    toLocation: "terminal",
    resource: RESOURCE_ENERGY,
    amount: 200,
    outcome: "ok",
    ...overrides,
  };
}

function makeService(): TreasuryService {
  const installed = installRooms(ROOMS);
  const service = createTreasuryService({ getRooms: () => Object.values(installed) });
  service.beginTick();
  return service;
}

function admit(service: TreasuryService, workKey: string, args: ReturnType<typeof transferArgs>) {
  const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: workKey, args });
  if (built.status !== "built") throw new Error(`build failed: ${built.status === "rejected" ? built.reason : "?"}`);
  const admission = service.authorizeTreasuryActionContract(built.contract, { workKey });
  if (admission.status !== "admitted") throw new Error(`admit failed: ${admission.status === "rejected" ? admission.reason : "?"}`);
  return admission;
}

/** reset 后必须用新模块句柄构建合同（旧模块合同被新运行时拒绝）。 */
function authorizeOn(reset: ReturnType<typeof performTreasuryFullReset>, workKey: string, args: ReturnType<typeof transferArgs>) {
  const built = reset.handles.actionContractsModule.buildTreasuryActionContract(reset.service, {
    actionKind: "test.transfer",
    transactionId: workKey,
    args,
  });
  if (built.status !== "built") throw new Error(`build failed: ${built.status === "rejected" ? built.reason : "?"}`);
  return reset.service.authorizeTreasuryActionContract(built.contract, { workKey });
}

/**
 * 结果写回前断点（R1 固定路径）：放行首写（dispatch_start 边界发布）、丢弃
 * 之后全部写（dispatch_result/保守兜底）——真实执行已发生（世界 800 流出）、
 * 持久层停在 dispatching+boundary。卸载时安装拦截期间实际保留的 liveValue
 *（不回滚已放行的边界发布）。
 */
function interruptAfterBoundary(): { memoryAtBreakpoint: () => string } {
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
    },
  });
  return {
    memoryAtBreakpoint: () => {
      delete runtime.treasuryCore;
      runtime.treasuryCore = liveValue; // 保留实际最终值（V3 契约）
      return snapshotWholeMemory();
    },
  };
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
  resetTreasuryTestAdapterSideEffectsForTest();
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
  clearTreasuryPolicyResolversForTest();
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
});

// ── R1：覆盖语义统一（流出 §3.3 固定数值案例） ───────────────────────────────

describe("基线 R1 覆盖已含效果不重复扣账（流出）", () => {
  it("1000→实际流出 800→结果前断点→完整reset→exact executed：A 仍 closing 时 200 可纳、201 拒，A 未被删除", () => {
    const service = makeService();
    const a = admit(service, "biz:ii:r1", transferArgs({ amount: 800, outcome: "ok" }));
    const guard = interruptAfterBoundary();
    const outcome = service.executeAuthorizedDispatch(a.dispatch);
    if (outcome.status !== "persist_failed") throw new Error(`期望 persist_failed，实际 ${outcome.status}`);
    const snapshot = guard.memoryAtBreakpoint();
    // 断点形态：dispatching + boundary，无 invocation/结果写回。
    const atBreak = JSON.parse(snapshot) as { runtime: { treasuryCore: { active: Record<string, { phase: string; invocation: unknown; invocationBoundary: unknown }> } } };
    const shape = atBreak.runtime.treasuryCore.active[a.attemptId];
    if (shape?.phase !== "dispatching" || shape.invocation !== null || shape.invocationBoundary === null) {
      throw new Error(`断点形态不符：${JSON.stringify(shape)}`);
    }
    // 完整 reset（断点 Memory 与当时世界一致——世界已含 800 流出效果）。
    const reset = performTreasuryFullReset({
      roomSpecs: ROOMS,
      adapter: makeTreasuryTestTransferAdapter("observed_committed"),
      advanceTicks: 1,
      memorySnapshot: snapshot,
    });
    const before = reset.service.kernelJournal().active.find((r) => r.attemptId === a.attemptId);
    if (before?.phase !== "outcome_unknown") throw new Error(`恢复后应 unknown，实际 ${before?.phase}`);
    // exact executed 对账 → committed/closing（invocation 仍空、boundary 在）。
    const settled = reset.service.settleUnknownOutcome({ attemptId: a.attemptId });
    if (settled.status !== "ok") throw new Error(`settle failed: ${settled.status === "rejected" ? settled.reason : settled.status}`);
    const closing = reset.service.kernelJournal().active.find((r) => r.attemptId === a.attemptId);
    if (closing?.phase !== "closing" || closing.outcome !== "committed") throw new Error(`应 closing committed，实际 ${closing?.phase}/${closing.outcome}`);
    if (closing.invocation !== null || closing.invocationBoundary === null) throw new Error("closing 形态不符（invocation 应空、boundary 应在）");
    // 新可信观察 200（世界已含流出）；A 记录仍在 active。
    const storage = (reset.rooms.W1N57 as unknown as { storage: { store: Record<string, number> } }).storage.store;
    if ((storage.energy ?? 0) !== 200) throw new Error(`世界应为 200，实际 ${String(storage.energy)}`);
    // 另一工作 200 应获准（覆盖成立不双扣）；201 应拒绝。
    const fits = authorizeOn(reset, "biz:ii:r1-fits", transferArgs({ amount: 200, outcome: "ok" }));
    expect(fits.status).toBe("admitted");
    const tooBig = authorizeOn(reset, "biz:ii:r1-toobig", transferArgs({ amount: 201, outcome: "ok" }));
    expect(tooBig.status).toBe("rejected");
    // A 断言时仍在 active（未清义务未被删除；本用例无消费者义务，以
    // closing 未退出表达“记录仍在”）。
    const stillActive = reset.service.kernelJournal().active.find((r) => r.attemptId === a.attemptId);
    expect(stillActive?.phase).toBe("closing");
  });
});

// ── R1 流入对照（§3.3 固定数值案例） ────────────────────────────────────────

describe("基线 R1 覆盖已含效果不重复扣账（流入）", () => {
  it("空位 100→实际流入 80→同断点恢复：20 可纳、21 拒，不再扣一次 80", () => {
    const installed = installRooms(ROOMS_INFLOW);
    const service = createTreasuryService({ getRooms: () => Object.values(installed) });
    service.beginTick();
    const a = admit(service, "biz:ii:r1in", transferArgs({ amount: 80, outcome: "ok" }));
    const guard = interruptAfterBoundary();
    const outcome = service.executeAuthorizedDispatch(a.dispatch);
    if (outcome.status !== "persist_failed") throw new Error(`期望 persist_failed，实际 ${outcome.status}`);
    const snapshot = guard.memoryAtBreakpoint();
    const reset = performTreasuryFullReset({
      roomSpecs: ROOMS_INFLOW,
      adapter: makeTreasuryTestTransferAdapter("observed_committed"),
      advanceTicks: 1,
      memorySnapshot: snapshot,
    });
    if (reset.service.settleUnknownOutcome({ attemptId: a.attemptId }).status !== "ok") throw new Error("settle failed");
    const closing = reset.service.kernelJournal().active.find((r) => r.attemptId === a.attemptId);
    if (closing?.phase !== "closing") throw new Error("应 closing");
    // 新可信观察空位 20。
    const terminal = (reset.rooms.W2N57 as unknown as { terminal: { store: { getFreeCapacity(): number } } }).terminal.store;
    if (terminal.getFreeCapacity() !== 20) throw new Error(`空位应为 20，实际 ${String(terminal.getFreeCapacity())}`);
    const fits = authorizeOn(reset, "biz:ii:r1in-fits", transferArgs({ amount: 20, outcome: "ok" }));
    expect(fits.status).toBe("admitted");
    const tooBig = authorizeOn(reset, "biz:ii:r1in-toobig", transferArgs({ amount: 21, outcome: "ok" }));
    expect(tooBig.status).toBe("rejected");
    expect(reset.service.kernelJournal().active.find((r) => r.attemptId === a.attemptId)?.phase).toBe("closing");
  });
});

// ── R2：预扣与下一服务位置同次发布 ──────────────────────────────────────────

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

describe("基线 R2 成对预扣同次发布下一服务位置", () => {
  it("真预扣成功、端口调用后确认前硬断点：快照内预算已用 2 且记录内 cursor 已前移、义务未减少", () => {
    const releaseCalls: string[] = [];
    const ports: TreasuryCoreKernelPorts = {
      nowTick: () => Game.time,
      runtimeGeneration: () => 1,
      findAdapter: (kind) =>
        kind === "d.kind"
          ? { kind, version: 1, registrationId: "reg-ii", semanticIdentity: "d.adapter-ii", execute: () => ({ ok: false }), settlesOnAccept: false, nonOkOutcome: "not_executed" as const }
          : undefined,
      checkAdmissionCapacity: () => null,
      observeForCleanup: () => ({ worldSequence: 9_000_000, atTick: Game.time + 1, locationExists: () => true }),
      releaseExternalConsumer: (key) => {
        releaseCalls.push(key);
        return true;
      },
    };
    const kernel = createTreasuryCoreKernel(ports);
    const admitted = kernel.admit(kernelAdmitInput(["ext:ii:a", "ext:ii:b"], "biz:ii:r2"));
    if (admitted.status !== "admitted") throw new Error("admit failed");
    if (kernel.executeDispatch(admitted.dispatch).status !== "not_executed") throw new Error("dispatch failed");
    Game.time += 1;
    // 存储边界捕获：放行首写（成对预扣发布）并记录其载荷；丢弃之后全部写
    //（确认命令）——持久层停在“预扣成功、确认前”的硬断点。
    const runtime = Memory.runtime as unknown as Record<string, unknown>;
    const descriptor = Object.getOwnPropertyDescriptor(runtime, "treasuryCore");
    let liveValue = descriptor?.value;
    let capturedPrepay: string | null = null;
    let writesAllowed = 1;
    Object.defineProperty(runtime, "treasuryCore", {
      configurable: true,
      get: () => liveValue,
      set(value: unknown) {
        if (writesAllowed > 0) {
          writesAllowed -= 1;
          liveValue = value;
          capturedPrepay = JSON.stringify(value);
        }
      },
    });
    kernel.beginTick();
    delete runtime.treasuryCore;
    runtime.treasuryCore = liveValue; // 保留实际最终值
    expect(releaseCalls.length).toBe(1); // 预扣成功 → 端口确被调用 1 次
    const snap = JSON.parse(capturedPrepay as string) as {
      recovery: { budgetUsed: number };
      active: Record<string, { cleanup: { consumerKeys: string[]; cursor: number } }>;
    };
    // 同次发布断言：同一持久发布内 budgetUsed 已 +2 且记录内下一服务位置
    // 已前移（首个单位服务 index 0 → 下一位置 1）——R2 修复前 cursor 仍 0。
    expect(snap.recovery.budgetUsed).toBe(2);
    const cleanup = snap.active[admitted.attemptId].cleanup;
    expect(cleanup.consumerKeys).toEqual(["ext:ii:a", "ext:ii:b"]); // remaining 不变
    expect(cleanup.cursor).toBe(1);
  });
});

// ── R3：preflight 健康门禁 ──────────────────────────────────────────────────

describe("基线 R3 preflight 非健康核心明确拒绝", () => {
  function makeKernelWithPermits(): { kernel: TreasuryCoreKernel; dispatchPermit: unknown; rearmPermit: unknown } {
    const ports: TreasuryCoreKernelPorts = {
      nowTick: () => Game.time,
      runtimeGeneration: () => 1,
      findAdapter: (kind) =>
        kind === "d.kind"
          ? { kind, version: 1, registrationId: "reg-ii", semanticIdentity: "d.adapter-ii", execute: () => ({ ok: false }), settlesOnAccept: false, nonOkOutcome: "not_executed" as const }
          : undefined,
      checkAdmissionCapacity: () => null,
      observeForCleanup: () => ({ worldSequence: 9_000_000, atTick: Game.time + 1, locationExists: () => true }),
    };
    const kernel = createTreasuryCoreKernel(ports);
    const a = kernel.admit(kernelAdmitInput([], "biz:ii:r3a"));
    if (a.status !== "admitted") throw new Error("admit a failed");
    const b = kernel.admit(kernelAdmitInput([], "biz:ii:r3b"));
    if (b.status !== "admitted") throw new Error("admit b failed");
    if (kernel.executeDispatch(b.dispatch).status !== "not_executed") throw new Error("dispatch b failed");
    Game.time += 1;
    kernel.beginTick(); // b → retry_ready
    const rearm = kernel.issueRearmPermit({ parentAttemptId: b.attemptId });
    if (rearm.status !== "ok") throw new Error("rearm permit failed");
    return { kernel, dispatchPermit: a.dispatch, rearmPermit: rearm.rearm };
  }

  type Corruption = "absent" | "incompatible" | "unhealthy";
  function corrupt(kind: Corruption): void {
    const runtime = Memory.runtime as unknown as { treasuryCore?: Record<string, unknown> & { active?: Record<string, Record<string, unknown>> } };
    if (kind === "absent") {
      delete runtime.treasuryCore;
      return;
    }
    const core = runtime.treasuryCore;
    if (core === undefined) throw new Error("core missing");
    if (kind === "incompatible") {
      core.version = 99;
      return;
    }
    const first = Object.values(core.active ?? {})[0];
    if (first === undefined) throw new Error("no active record");
    first.phase = "bogus"; // 违反阶段枚举 → validateSafetyCore 拒绝 → unhealthy
  }

  it.each([["absent"], ["incompatible"], ["unhealthy"]] as [Corruption][])(
    "%s 核心：两个 preflight 均不返回 valid（可解释拒绝，纯读）",
    (kind) => {
      const { kernel, dispatchPermit, rearmPermit } = makeKernelWithPermits();
      corrupt(kind);
      const dispatchCheck = kernel.preflightDispatchPermit(dispatchPermit);
      expect(dispatchCheck.status).toBe("invalid");
      if (dispatchCheck.status === "invalid") expect(dispatchCheck.reason.length).toBeGreaterThan(0);
      const rearmCheck = kernel.preflightRearmPermit(rearmPermit);
      expect(rearmCheck.status).toBe("invalid");
      if (rearmCheck.status === "invalid") expect(rearmCheck.reason.length).toBeGreaterThan(0);
    },
  );
});
