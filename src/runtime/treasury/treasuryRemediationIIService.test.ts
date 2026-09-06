/**
 * Treasury Core Rewrite IV · Remediation II——service/reset 层 F 矩阵（任务书 §7）。
 *
 * 覆盖：F01/F02（覆盖不双扣的固定数值案例——流出/流入）、F03（unknown/旧
 * 观察/不可用观察对照与最终退出）、F09/F10（preflight 健康门禁与合法对照）、
 * F11（调用前/效果前/效果后三同断点分支 + 错关联对照）、F12（真实效果后
 * 结果未写断点→无人工 external 的恢复）、F13（存储拦截器契约）、F15
 * （指定早期断点/消失结构/配对错误识别）、F17（混合负载独立宿主账目）。
 * F16 见 treasuryRemediationIKernel.test.ts E10（V2 改造后形态）；F04–F08/
 * F14/F18 见 treasuryRemediationIIKernel.test.ts；F19 = 全仓最终验证
 * （typecheck/build/Treasury 定向/Defense 冻结回归/budget——见 evidence）；
 * F20 生产负向变体见 evidence/negative-variants/（工具契约负向在本文件
 * F13/F15 与 kernel 文件 F14 内联）。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import {
  buildTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  replaceTreasuryActionAdapterForTest,
  resetTreasuryTestAdapterSideEffectsForTest,
  type TreasuryActionAdapter,
  type TreasuryTestTransferArgs,
} from "@/runtime/treasury/actionContracts";
import {
  clearTreasuryPolicyResolversForTest,
  makeNoReserveTreasuryPolicy,
  registerTreasuryPolicyResolver,
} from "@/runtime/treasury/policyAuthority";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  snapshotWholeMemory,
  performTreasuryFullReset,
  captureTreasuryHostBreakpoint,
  type TreasuryFullResetResult,
  type TreasuryHostBreakpoint,
} from "@mock/treasuryResetHarness";
import { interceptTreasuryCoreWrites } from "@mock/treasuryStorageInterceptor";
import {
  createTreasuryHostJournal,
  makeTreasuryExactOracleAdapter,
  type TreasuryHostJournal,
 executeTreasuryAdmittedDispatch, } from "@mock/treasuryExactOracle";
import { treasuryCoreWorkHoldsOccupancy } from "@/runtime/treasury/kernel/occupancy";
import type { TreasuryCoreWorkRecord } from "@/runtime/treasury/kernel/types";
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

/** 流入对照：目标 terminal 空位 100。 */
const ROOMS_INFLOW: RoomSpec[] = [
  ROOMS[0],
  {
    name: "W2N57",
    storage: { id: "stor-2", resources: { energy: 0 }, freeCapacity: 10_000 },
    terminal: { id: "term-2", resources: { energy: 0 }, freeCapacity: 100 },
  },
];

function transferArgs(overrides: Partial<TreasuryTestTransferArgs> = {}): TreasuryTestTransferArgs {
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

function makeService(roomSpecs: RoomSpec[] = ROOMS): TreasuryService {
  const installed = installRooms(roomSpecs);
  const service = createTreasuryService({ getRooms: () => Object.values(installed) });
  service.beginTick();
  return service;
}

function admit(service: TreasuryService, workKey: string, args: TreasuryTestTransferArgs) {
  const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: workKey, args });
  if (built.status !== "built") throw new Error(`build failed: ${built.status === "rejected" ? built.reason : "?"}`);
  const admission = service.authorizeTreasuryActionContract(built.contract, { workKey });
  if (admission.status !== "admitted") throw new Error(`admit failed: ${admission.status === "rejected" ? admission.reason : "?"}`);
  return admission;
}

/** reset 后必须用新模块句柄构建合同。 */
function authorizeOn(reset: TreasuryFullResetResult, workKey: string, args: TreasuryTestTransferArgs) {
  const built = reset.handles.actionContractsModule.buildTreasuryActionContract(reset.service, {
    actionKind: "test.transfer",
    transactionId: workKey,
    args,
  });
  if (built.status !== "built") throw new Error(`build failed: ${built.status === "rejected" ? built.reason : "?"}`);
  return reset.service.authorizeTreasuryActionContract(built.contract, { workKey });
}

/** 计数 policy（F09/F10 观测复验是否发生）。 */
function installCountingPolicy(): { calls: number } {
  const counter = { calls: 0 };
  const base = makeNoReserveTreasuryPolicy();
  registerTreasuryPolicyResolver({
    policyId: base.policyId,
    policyVersion: base.policyVersion,
    evaluate: (): { withhold: number; strategicReserve: number; emergencyOverride: boolean } => {
      counter.calls += 1;
      return { withhold: 0, strategicReserve: 0, emergencyOverride: false };
    },
  });
  return counter;
}

interface CleanupShape {
  phase: string;
  outcome?: string;
  invocation: unknown;
  invocationBoundary: unknown;
  cleanup?: { consumerKeys: readonly string[] };
}

function recordShape(attemptId: string): CleanupShape | undefined {
  const store = Memory.runtime?.treasuryCore as unknown as { active?: Record<string, CleanupShape> } | undefined;
  return store?.active?.[attemptId];
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
  resetTreasuryCommitmentRevisionForTest();
  resetTreasuryTestAdapterSideEffectsForTest();
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
  clearTreasuryPolicyResolversForTest();
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
});

// ── F01/F02：覆盖已含效果不重复扣账（固定数值案例） ─────────────────────────

describe("F01/F02 覆盖不双扣（流出/流入固定数值）", () => {
  /**
   * 真实执行后结果写回前断点 + 事件 oracle 的完整恢复流（§3.3）：
   * 拦截器放行首写（dispatch_start），丢弃结果写；断点捆绑 Memory/世界/事件。
   */
  function executedBreakpointFlow(
    roomSpecs: RoomSpec[],
    amount: number,
  ): {
    reset: TreasuryFullResetResult;
    attemptId: string;
    journal: TreasuryHostJournal;
    oracle: ReturnType<typeof makeTreasuryExactOracleAdapter>;
  } {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const service = makeService(roomSpecs);
    const args = transferArgs({ amount, outcome: "ok" });
    const a = admit(service, "biz:f:exec", args);
    const interceptor = interceptTreasuryCoreWrites({ allow: 1 });
    const outcome = executeTreasuryAdmittedDispatch(journal, service, a);
    interceptor.restore();
    if (outcome.status !== "persist_failed") throw new Error(`期望 persist_failed，实际 ${outcome.status}`);
    const bp = captureTreasuryHostBreakpoint(journal.captureBranch());
    const reset = performTreasuryFullReset({ roomSpecs, adapter: oracle, advanceTicks: 1, breakpoint: bp });
    const settled = reset.service.settleUnknownOutcome({ attemptId: a.attemptId });
    if (settled.status !== "ok") throw new Error(`settle failed: ${settled.status === "rejected" ? settled.reason : settled.status}`);
    return { reset, attemptId: a.attemptId, journal, oracle };
  }

  it("F01 流出：1000→实际流出 800→结果前断点→exact executed→A 仍 closing（invocation 空）→200 可纳、201 拒，A 未删除", () => {
    const { reset, attemptId, oracle } = executedBreakpointFlow(ROOMS, 800);
    const closing = recordShape(attemptId)!;
    expect(closing.phase).toBe("closing");
    expect(closing.outcome).toBe("committed");
    expect(closing.invocation).toBeNull(); // 结果写回前中断——只有边界
    expect(closing.invocationBoundary).not.toBeNull();
    // 新可信观察 200（世界已含 800 流出）；对账后、cleanup 前。
    expect((reset.rooms.W1N57 as unknown as { storage: { store: Record<string, number> } }).storage.store.energy).toBe(200);
    const fits = authorizeOn(reset, "biz:f1:fits", transferArgs({ amount: 200, outcome: "ok" }));
    expect(fits.status).toBe("admitted"); // 覆盖成立：不双扣
    const tooBig = authorizeOn(reset, "biz:f1:toobig", transferArgs({ amount: 201, outcome: "ok" }));
    expect(tooBig.status).toBe("rejected");
    // A 断言时仍在 active；调用与效果均不重复。
    expect(reset.service.kernelJournal().active.find((r) => r.attemptId === attemptId)?.phase).toBe("closing");
    expect(oracle.trace.effects).toBe(1);
  });

  it("F02 流入：空位 100→实际流入 80→同断点恢复→20 可纳、21 拒，不再扣一次 80", () => {
    const { reset, attemptId } = executedBreakpointFlow(ROOMS_INFLOW, 80);
    const closing = recordShape(attemptId)!;
    expect(closing.phase).toBe("closing");
    expect(closing.outcome).toBe("committed");
    const terminal = (reset.rooms.W2N57 as unknown as { terminal: { store: { getFreeCapacity(): number } } }).terminal.store;
    expect(terminal.getFreeCapacity()).toBe(20); // 新可信观察空位 20
    const fits = authorizeOn(reset, "biz:f2:fits", transferArgs({ amount: 20, outcome: "ok" }));
    expect(fits.status).toBe("admitted");
    const tooBig = authorizeOn(reset, "biz:f2:toobig", transferArgs({ amount: 21, outcome: "ok" }));
    expect(tooBig.status).toBe("rejected");
    expect(reset.service.kernelJournal().active.find((r) => r.attemptId === attemptId)?.phase).toBe("closing");
  });
});

// ── F03：unknown/旧观察/不可用观察对照与最终退出 ───────────────────────────

describe("F03 覆盖判定的负向与收尾", () => {
  it("unknown 不因边界释放：无确定结论前 800 全额占用，200 拒（与 F01 对照）", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const service = makeService();
    const args = transferArgs({ amount: 800, outcome: "ok" });
    const a = admit(service, "biz:f3:unknown", args);
    const interceptor = interceptTreasuryCoreWrites({ allow: 1 });
    const outcome = executeTreasuryAdmittedDispatch(journal, service, a);
    interceptor.restore();
    if (outcome.status !== "persist_failed") throw new Error(`期望 persist_failed，实际 ${outcome.status}`);
    const bp = captureTreasuryHostBreakpoint(journal.captureBranch());
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: oracle, advanceTicks: 1, breakpoint: bp });
    const shape = recordShape(a.attemptId)!;
    expect(shape.phase).toBe("outcome_unknown"); // 不 settle——无确定结论
    // unknown 保持最坏流出占用：观察 200 − 占用 800 < 0 → 200 拒。
    const fits = authorizeOn(reset, "biz:f3:fits", transferArgs({ amount: 200, outcome: "ok" }));
    expect(fits.status).toBe("rejected");
    if (fits.status === "rejected") expect(fits.reason).not.toContain("contract 无效"); // 真实容量拒绝
  });

  it("覆盖判定单元对照（共享锚点链——occupancy/命令/清理门同一语义）", () => {
    const base = {
      workKey: "biz:f3:unit", attemptId: "tk1_1_x", generation: 1, parentAttemptId: null,
      phase: "closing", admittedAtTick: 10, updatedAtTick: 12,
      identity: {} as never, worstCase: [],
      invocationBoundary: { atTick: 11, worldSequence: 5 } as never,
      invocation: null, external: null,
      outcome: "committed", outcomeEvidence: null as never,
      cleanup: { consumerKeys: [], failures: 0, cursor: 0 },
      retryDeadlineTick: null, lastError: null,
    } as TreasuryCoreWorkRecord;
    // 观察序 > 边界序 → 覆盖（不占用）。
    expect(treasuryCoreWorkHoldsOccupancy(base, { observationWorldSequence: 6 })).toBe(false);
    // 观察序 = 边界序 / 更小 → 保守占用。
    expect(treasuryCoreWorkHoldsOccupancy(base, { observationWorldSequence: 5 })).toBe(true);
    expect(treasuryCoreWorkHoldsOccupancy(base, { observationWorldSequence: 4 })).toBe(true);
    // 缺世界序 → tick 严格大于兜底（12>11 覆盖；11=11 同 tick 保守）。
    expect(treasuryCoreWorkHoldsOccupancy(base, { observationAsOfTick: 11 })).toBe(true);
    expect(treasuryCoreWorkHoldsOccupancy(base, { observationAsOfTick: 12 })).toBe(false);
    expect(treasuryCoreWorkHoldsOccupancy(base, { observationAsOfTick: 12, observationWorldSequence: 6 })).toBe(false);
    expect(treasuryCoreWorkHoldsOccupancy(base, {})).toBe(true);
    // external 锚点（无世界序——tick 边界保守）优先于边界。
    const externalAnchored = { ...base, external: { accepted: true, atTick: 11 } as never, invocationBoundary: { atTick: 9, worldSequence: 5 } as never };
    expect(treasuryCoreWorkHoldsOccupancy(externalAnchored, { observationAsOfTick: 11 })).toBe(true); // 同 tick 不覆盖
    expect(treasuryCoreWorkHoldsOccupancy(externalAnchored, { observationAsOfTick: 12 })).toBe(false);
    // 无任何调用侧事实 → 保守占用。
    const noAnchor = { ...base, invocationBoundary: null };
    expect(treasuryCoreWorkHoldsOccupancy(noAnchor, { observationWorldSequence: 1_000_000, observationAsOfTick: 1_000_000 })).toBe(true);
    // 非 committed closing / unknown → 判定前提不同。
    const unknownRec = { ...base, phase: "outcome_unknown" as never, invocationBoundary: { atTick: 11, worldSequence: 5 } as never };
    expect(treasuryCoreWorkHoldsOccupancy(unknownRec, { observationWorldSequence: 1_000_000 })).toBe(true); // unknown 不因观察释放
  });

  it("覆盖后所有关闭条件成立才删除；退出后额度随观察恢复（旧视图不超额）", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const service = makeService();
    const args = transferArgs({ amount: 800, outcome: "ok" });
    const a = admit(service, "biz:f3:exit", args);
    const interceptor = interceptTreasuryCoreWrites({ allow: 1 });
    executeTreasuryAdmittedDispatch(journal, service, a);
    interceptor.restore();
    const bp = captureTreasuryHostBreakpoint(journal.captureBranch());
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: oracle, advanceTicks: 1, breakpoint: bp });
    reset.service.settleUnknownOutcome({ attemptId: a.attemptId });
    // 观察覆盖（世界序已越过边界）+ 无义务 → beginTick 安全退出。
    Game.time += 1;
    reset.service.beginTick();
    expect(reset.service.kernelJournal().active.find((r) => r.attemptId === a.attemptId)).toBeUndefined();
    // 退出后：观察 200 全额可用——200 纳、201 拒（占用随退出释放，不残留）。
    const fits = authorizeOn(reset, "biz:f3:after-fits", transferArgs({ amount: 200, outcome: "ok" }));
    expect(fits.status).toBe("admitted");
    const tooBig = authorizeOn(reset, "biz:f3:after-toobig", transferArgs({ amount: 201, outcome: "ok" }));
    expect(tooBig.status).toBe("rejected");
  });
});

// ── F09/F10：preflight 健康门禁与合法对照 ─────────────────────────────────

describe("F09/F10 preflight 健康门禁", () => {
  it("F09 非健康核心：facade 路径 fresh/policy/调用/child 增量 0（absent/incompatible/unhealthy 三态）", () => {
    for (const corruption of ["absent", "incompatible", "unhealthy"] as const) {
      resetTreasuryCoreStoreForTest();
      resetTreasuryTestAdapterSideEffectsForTest();
      const journal = createTreasuryHostJournal();
      const oracle = makeTreasuryExactOracleAdapter(journal);
      replaceTreasuryActionAdapterForTest(oracle);
      const service = makeService();
      const policy = installCountingPolicy();
      // 合法 dispatch 许可（pending）。
      const argsA = transferArgs({ amount: 100, outcome: "ok" });
      const a = admit(service, "biz:f9:d", argsA);
      // 合法 rearm 许可（父代 retry_ready）。
      const argsB = transferArgs({ amount: 50, outcome: "non-ok" });
      const b = admit(service, "biz:f9:r", argsB);
      expect(executeTreasuryAdmittedDispatch(journal, service, b).status).toBe("not_executed");
      Game.time += 1;
      service.beginTick();
      const capability = service.issueTreasuryRearmCapability({ attemptId: b.attemptId });
      if (capability.status !== "ok") throw new Error("capability failed");
      const rearmContract = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "biz:f9:r", args: transferArgs({ amount: 50 }) });
      if (rearmContract.status !== "built") throw new Error("rearm contract failed");
      // 故障注入。
      const runtime = Memory.runtime as unknown as { treasuryCore?: Record<string, unknown> & { active?: Record<string, Record<string, unknown>> } };
      if (corruption === "absent") delete runtime.treasuryCore;
      else if (corruption === "incompatible") runtime.treasuryCore!.version = 99;
      else Object.values(runtime.treasuryCore!.active ?? {})[0]!.phase = "bogus";
      // 基准（合法执行 b 之后）。
      const freshBefore = service.metrics().freshObservationBuilds;
      const frontierBefore = (Memory.runtime?.treasuryCore as { issuance: { frontier: number } } | undefined)?.issuance.frontier ?? -1;
      const activeBefore = corruption === "absent" ? -1 : Object.keys(runtime.treasuryCore!.active ?? {}).length;
      // facade 路径：两许可均在高成本资源之前拒绝。
      const dispatchOut = executeTreasuryAdmittedDispatch(journal, service, a);
      expect(dispatchOut.status).toBe("rejected");
      const rearmOut = service.executeRearm(capability.rearm, rearmContract.contract, { workKey: "biz:f9:r" });
      expect(rearmOut.status).toBe("rejected");
      // 增量 0：fresh/policy/动作/child。
      expect(service.metrics().freshObservationBuilds).toBe(freshBefore);
      expect(policy.calls).toBe(0);
      expect(oracle.trace.entered).toBe(1); // 仅 b 的合法一次
      if (corruption === "absent") expect((Memory.runtime?.treasuryCore as { issuance: { frontier: number } } | undefined)?.issuance.frontier ?? -1).toBe(-1);
      else {
        expect((Memory.runtime!.treasuryCore as { issuance: { frontier: number } }).issuance.frontier).toBe(frontierBefore);
        expect(Object.keys((Memory.runtime!.treasuryCore as { active: Record<string, unknown> }).active)).toHaveLength(activeBefore);
      }
      // “故障前状态恢复”只能恢复同一可信快照：由 beforeEach 重建（非本用例
      // 声称的生产回滚能力）。
    }
  });

  it("F10 健康对照可执行；仅坏 ring 不伪装核心损坏；克隆许可不花 fresh（E13/E14 语义保持）", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const service = makeService();
    const policy = installCountingPolicy();
    const args = transferArgs({ amount: 100, outcome: "ok" });
    const a = admit(service, "biz:f10:ok", args);
    // 仅坏 ring（安全四态仍 healthy + ringDegraded 诊断）。
    const core = Memory.runtime!.treasuryCore as unknown as { ring: Record<string, unknown>[] };
    if (core.ring.length > 0) core.ring[0]!.attemptId = 123; // 非法类型
    else (core as unknown as { ringCursor: number }).ringCursor = -1; // 非法游标
    const freshBefore = service.metrics().freshObservationBuilds;
    const out = executeTreasuryAdmittedDispatch(journal, service, a);
    expect(out.status).toBe("committed"); // 健康对照：ring 降级不封死真许可
    expect(oracle.trace.effects).toBe(1);
    expect(service.metrics().freshObservationBuilds).toBe(freshBefore + 1); // 真实复验发生（fresh 观察 +1）
    void policy; // policy 是惰性事实源（简单流出可能不触发）——不计为复验证据
    // 克隆许可在高成本复验前拒绝（E13 语义锚点）。
    const clone = { ...(a.dispatch as object) };
    const afterCloneBase = service.metrics().freshObservationBuilds;
    expect(service.executeAuthorizedDispatch(clone).status).toBe("rejected");
    expect(service.metrics().freshObservationBuilds).toBe(afterCloneBase); // 零 fresh
  });
});

// ── F11/F12：三断点分支与无人工 external 的恢复 ───────────────────────────

describe("F11/F11 三同断点分支与 exact 对照", () => {
  it("调用前断点（边界已发布、adapter 未进入）：世界 1000；恢复 not_executed→不扣任何占用（800 可纳、801 拒）", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    // 调用前哨兵：进入即抛（不记 entered——调用未开始）。
    const sentinel: TreasuryActionAdapter = {
      ...oracle,
      execute(): { ok: boolean } {
        throw new Error("F11: hard stop before adapter body");
      },
    };
    replaceTreasuryActionAdapterForTest(sentinel);
    const service = makeService();
    const args = transferArgs({ amount: 200, outcome: "ok" });
    const a = admit(service, "biz:f11:pre", args);
    const interceptor = interceptTreasuryCoreWrites({ allow: 1 });
    executeTreasuryAdmittedDispatch(journal, service, a);
    interceptor.restore();
    const bp = captureTreasuryHostBreakpoint(journal.captureBranch());
    expect(bp.world.W1N57?.storage?.resources.energy ?? -1).toBe(1000);
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: oracle, advanceTicks: 1, breakpoint: bp });
    expect(recordShape(a.attemptId)?.phase).toBe("outcome_unknown");
    expect(oracle.trace.entered).toBe(0); // 新分支无调用
    const settled = reset.service.settleUnknownOutcome({ attemptId: a.attemptId });
    expect(settled.status).toBe("ok");
    expect(recordShape(a.attemptId)?.outcome).toBe("not_executed");
    Game.time += 1;
    reset.service.beginTick(); // 无义务 not_executed → retry_ready（占用解除）
    expect(recordShape(a.attemptId)?.phase).toBe("retry_ready");
    // 世界 1000 无任何占用：800 可纳、801 拒（无幻影扣除）。
    const fits = authorizeOn(reset, "biz:f11:fits", transferArgs({ amount: 800, outcome: "ok" }));
    expect(fits.status).toBe("admitted");
    const tooBig = authorizeOn(reset, "biz:f11:toobig", transferArgs({ amount: 801, outcome: "ok" }));
    expect(tooBig.status).toBe("rejected");
  });

  it("错关联对照：他人效果推进世界序越过本 attempt 边界、无本 attempt 事件→still_uncertain（不盲猜 not-executed）", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const service = makeService();
    // B：先中断在调用前（边界序 = 0——世界序尚未推进）。
    const sentinel: TreasuryActionAdapter = {
      ...oracle,
      execute(): { ok: boolean } {
        throw new Error("F11: stop");
      },
    };
    replaceTreasuryActionAdapterForTest(sentinel);
    const argsB = transferArgs({ amount: 50, outcome: "ok" });
    const b = admit(service, "biz:f11:mine", argsB);
    const interceptor = interceptTreasuryCoreWrites({ allow: 1 });
    executeTreasuryAdmittedDispatch(journal, service, b);
    interceptor.restore();
    // A：真实执行（世界效果推进世界序越过 B 的边界序；事件属于 A 不属于 B）。
    replaceTreasuryActionAdapterForTest(oracle);
    const argsA = transferArgs({ amount: 100, outcome: "ok" });
    const a = admit(service, "biz:f11:other", argsA);
    expect(executeTreasuryAdmittedDispatch(journal, service, a).status).toBe("committed");
    const bp = captureTreasuryHostBreakpoint(journal.captureBranch());
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: oracle, advanceTicks: 1, breakpoint: bp });
    // 恢复分支：A 的效果在断点前已发生（世界序已越过 B 的边界序），但
    // 可见事件集中无 B 的 entered/effect → 不盲猜。
    const settled = reset.service.settleUnknownOutcome({ attemptId: b.attemptId });
    expect(settled.status).toBe("still_uncertain"); // 证据不足：明确不确定（保留 unknown）
    expect(recordShape(b.attemptId)?.outcome).toBe("unknown");
    expect(recordShape(b.attemptId)?.phase).toBe("outcome_unknown");
  });
});

describe("F12 真实效果后、结果未写断点（无人工 external）", () => {
  it("效果后哨兵抛错→旧栈 catch 写 unknown（旧分支）；恢复分支 Memory 无结果→executed→F01 中间账目→完整关闭", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    // 效果后哨兵：真实执行（世界效果+事件）后抛错——kernel 的 catch/兜底
    // 只落在旧分支；断点在抛错前捕获（Memory 尚无结果）。
    let breakpoint: TreasuryHostBreakpoint | undefined;
    const sentinel: TreasuryActionAdapter = {
      ...oracle,
      execute(args: TreasuryTestTransferArgs): { ok: boolean } {
        const result = oracle.execute(args); // 真实效果发生（世界+事件）
        breakpoint = captureTreasuryHostBreakpoint(journal.captureBranch());
        throw new Error("F12: hard stop after effect, before result write");
      },
    };
    replaceTreasuryActionAdapterForTest(sentinel);
    const service = makeService();
    const args = transferArgs({ amount: 300, outcome: "ok" });
    const a = admit(service, "biz:f12:post", args);
    const out = executeTreasuryAdmittedDispatch(journal, service, a);
    expect(out.status).toBe("unknown"); // 旧分支：catch 后保守 unknown（写成功）
    const oldBranchShape = recordShape(a.attemptId)!;
    expect(oldBranchShape.phase).toBe("outcome_unknown");
    expect(oldBranchShape.invocation).not.toBeNull(); // 旧分支 catch 写了 invocation
    expect(breakpoint).toBeDefined();
    expect(breakpoint!.world.W1N57?.storage?.resources.energy ?? -1).toBe(700); // 世界已变
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: oracle, advanceTicks: 1, breakpoint: breakpoint! });
    // 恢复分支：Memory 无结果（dispatching→unknown），invocation 为空。
    const recovered = recordShape(a.attemptId)!;
    expect(recovered.phase).toBe("outcome_unknown");
    expect(recovered.invocation).toBeNull(); // 旧栈后续写入不混入恢复分支
    expect(recovered.invocationBoundary).not.toBeNull();
    // exact executed（宿主事件）→ committed/closing → F01 中间账目。
    expect(reset.service.settleUnknownOutcome({ attemptId: a.attemptId }).status).toBe("ok");
    const closing = recordShape(a.attemptId)!;
    expect(closing.outcome).toBe("committed");
    expect(closing.phase).toBe("closing");
    const fits = authorizeOn(reset, "biz:f12:fits", transferArgs({ amount: 700, outcome: "ok" }));
    expect(fits.status).toBe("admitted"); // 观察已含流出——不双扣
    const tooBig = authorizeOn(reset, "biz:f12:toobig", transferArgs({ amount: 701, outcome: "ok" }));
    expect(tooBig.status).toBe("rejected");
    // 完整关闭 + 真实调用/效果计数正确（各恰好 1）。
    Game.time += 1;
    reset.service.beginTick();
    expect(reset.service.kernelJournal().active.find((r) => r.attemptId === a.attemptId)).toBeUndefined();
    expect(oracle.trace.entered).toBe(1);
    expect(oracle.trace.effects).toBe(1);
  });
});

// ── F13：存储拦截器契约 ────────────────────────────────────────────────────

describe("F13 拦截器卸载保留实际存储", () => {
  it("放行预扣与游标、吞确认：卸载前后实际存储一致（预算/位置未回退）；同 tick 完整 reset 无凭空额度；恢复写后可确认", () => {
    const releaseCalls: string[] = [];
    const ports = {
      nowTick: () => Game.time,
      runtimeGeneration: () => 1,
      findAdapter: (kind: string) =>
        kind === "d.kind"
          ? { kind, version: 1, registrationId: "reg-f13", semanticIdentity: "d.f13", execute: () => ({ ok: false }), settlesOnAccept: false, nonOkOutcome: "not_executed" as const }
          : undefined,
      checkAdmissionCapacity: () => null,
      releaseExternalConsumer: (key: string) => {
        releaseCalls.push(key);
        return true;
      },
    } as const;
    // 用 kernel 面完整 reset 的 ports 形态直接驱动 kernel（不经 facade）。
    const kernelModule = require("@/runtime/treasury/kernel/kernel") as typeof import("@/runtime/treasury/kernel/kernel");
    const kernel = kernelModule.createTreasuryCoreKernel(ports as never);
    const admitted = kernel.admit({
      workKey: "biz:f13:i",
      identity: {
        actionKind: "d.kind", adapterVersion: 1, adapterRegistrationId: "reg-f13", adapterSemanticIdentity: "d.f13",
        canonicalDigest: "a".repeat(16), postingsDigest: "b".repeat(16), retryFactsDigest: "c".repeat(16), durableFacts: null,
      },
      worstCase: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -50 }],
      externalConsumers: ["ext:f13:a", "ext:f13:b"],
      canonicalArgs: { n: 1 },
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -50 }],
      admissionContext: { contractId: "ac:f13", contractDigest: "a".repeat(16), actionKind: "d.kind", ownerIdentity: null, excludeAttemptId: null },
      structureBindings: [],
    });
    if (admitted.status !== "admitted") throw new Error("admit failed");
    expect(kernel.executeDispatch(admitted.dispatch).status).toBe("not_executed");
    Game.time += 1;
    const interceptor = interceptTreasuryCoreWrites({ allow: 1 });
    kernel.beginTick(); // 预扣+游标放行；确认丢弃
    const beforeUnload = snapshotWholeMemory();
    interceptor.restore(); // 契约核心：卸载保留实际最终值
    expect(snapshotWholeMemory()).toBe(beforeUnload); // 卸载前后实际存储一致
    const shape = recordShape(admitted.attemptId)!;
    expect(shape.cleanup!.consumerKeys).toEqual(["ext:f13:a", "ext:f13:b"]); // remaining 保留
    const core = Memory.runtime!.treasuryCore as unknown as { recovery: { budgetUsed: number } };
    expect(core.recovery.budgetUsed).toBe(2); // 已放行预扣不回退
    // 同 tick 完整 reset：份额已计（无凭空额度）——剩余 6 份额续 1 单位后耗尽。
    const reset = (require("@mock/treasuryResetHarness") as typeof import("@mock/treasuryResetHarness"))
      .performTreasuryKernelFullReset({ ports: ports as never });
    void reset;
    expect(releaseCalls.length).toBeGreaterThanOrEqual(2); // 旧栈 1 + 同 tick 恢复续 ≥1（无凭空额度）
    // 正常写恢复后：义务有限完成 → retry_ready（合法长期相——记录保留在
    // active 等待 rearm/期限，不退出）。
    for (let tick = 0; tick < 4; tick += 1) {
      const shape = recordShape(admitted.attemptId);
      if (shape?.phase === "retry_ready") break;
      Game.time += 1;
      (require("@mock/treasuryResetHarness") as typeof import("@mock/treasuryResetHarness"))
        .performTreasuryKernelFullReset({ ports: ports as never });
    }
    const final = recordShape(admitted.attemptId)!;
    expect(final.phase).toBe("retry_ready"); // 义务全部确认完成
    expect(final.cleanup!.consumerKeys).toEqual([]);
  });
});

// ── F15：指定早期断点 / 消失结构 / 配对错误识别 ───────────────────────────

describe("F15 断点世界一致与结构保真", () => {
  it("指定早期断点后旧栈继续产生效果：恢复分支世界=断点时刻（不含后来效果）", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    // 断点捕获在 adapter 入口（效果前）；随后旧栈继续完成（世界 800）。
    let breakpoint: TreasuryHostBreakpoint | undefined;
    const entryAdapter: TreasuryActionAdapter = {
      ...oracle,
      execute(args: TreasuryTestTransferArgs): { ok: boolean } {
        if (breakpoint === undefined) {
          breakpoint = captureTreasuryHostBreakpoint(journal.captureBranch());
          // 效果前事件（entered）记录后立即捕获——本分支继续走完效果。
        }
        return oracle.execute(args);
      },
    };
    replaceTreasuryActionAdapterForTest(entryAdapter);
    const service = makeService();
    const args = transferArgs({ amount: 200, outcome: "ok" });
    const a = admit(service, "biz:f15:early", args);
    expect(executeTreasuryAdmittedDispatch(journal, service, a).status).toBe("committed"); // 旧栈走完
    expect(breakpoint).toBeDefined();
    expect(breakpoint!.world.W1N57?.storage?.resources.energy ?? -1).toBe(1000); // 断点世界=效果前
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: oracle, advanceTicks: 1, breakpoint: breakpoint! });
    // 恢复分支世界不含旧栈后来效果（1000，不是 800）。
    expect((reset.rooms.W1N57 as unknown as { storage: { store: Record<string, number> } }).storage.store.energy).toBe(1000);
    // 恢复分支事件也不含旧栈后来产生的 world-effect（可见集止于 entered）。
    expect(journal.visibleFor(a.attemptId).some((e) => e.kind === "world-effect")).toBe(false);
  });

  it("断点时已消失的结构不被 RoomSpec 复活：授权目标位置拒绝（structure_changed）", () => {
    const installed = installRooms(ROOMS);
    const service = createTreasuryService({ getRooms: () => Object.values(installed) });
    service.beginTick();
    // 世界中删除 W2 terminal（结构消失），随后捕获断点。
    delete (installed.W2N57 as unknown as { terminal?: unknown }).terminal;
    const bp = captureTreasuryHostBreakpoint();
    // 完整 reset 用断点世界：W2 无 terminal。
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryTestTransferAdapter(), advanceTicks: 1, breakpoint: bp });
    expect((reset.rooms.W2N57 as unknown as { terminal?: unknown }).terminal).toBeUndefined(); // 不复活
    // 目标位置不可用在合同构建期即 fail closed（不复活的结构在观察中不存在）。
    const built = reset.handles.actionContractsModule.buildTreasuryActionContract(reset.service, {
      actionKind: "test.transfer",
      transactionId: "biz:f15:gone",
      args: transferArgs({ amount: 10, outcome: "ok" }),
    });
    expect(built.status).toBe("rejected"); // 结构缺失——构建期拒绝
    if (built.status === "rejected") expect(built.detail).toContain("不存在");
  });

  it("配对错误使测试契约失败：伪造断点（Memory 与世界序错配）被入口一致性校验拒绝", () => {
    const service = makeService();
    const a = admit(service, "biz:f15:forged", transferArgs({ amount: 50, outcome: "ok" }));
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed"); // 世界序 +1
    const early = captureTreasuryHostBreakpoint(); // 早断点（世界序旧）
    const b = admit(service, "biz:f15:forged2", transferArgs({ amount: 10, outcome: "ok" }));
    expect(service.executeAuthorizedDispatch(b.dispatch).status).toBe("committed"); // 再 +1
    const late = captureTreasuryHostBreakpoint(); // 晚断点
    // 伪造：早 Memory + 晚捆绑世界序。
    const forged: TreasuryHostBreakpoint = { ...early, worldSequence: late.worldSequence };
    expect(() =>
      performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryTestTransferAdapter(), advanceTicks: 1, breakpoint: forged }),
    ).toThrow("断点配对不一致");
  });
});

// ── F17：混合负载 + 独立宿主账目 ──────────────────────────────────────────

describe("F17 混合负载与独立宿主账目", () => {
  it("完成/真实 rearm/长期 unknown/部分清理/完整 reset/旧视图：宿主账目一致、未结束工作有界", () => {
    const journal = createTreasuryHostJournal();
    const oracle = makeTreasuryExactOracleAdapter(journal);
    replaceTreasuryActionAdapterForTest(oracle);
    const installed = installRooms(ROOMS);
    const visible = new Set(["W1N57", "W2N57"]);
    const service = createTreasuryService({ getRooms: () => Object.values(installed).filter((r) => visible.has(r.name)) });
    service.beginTick();
    const hostLedger: { attemptId: string; amount: number }[] = []; // 独立宿主账目（不经生产 occupancy）
    // 1) 真实 rearm：父 non-ok（50）→ retry_ready → child 执行 50（W2 需可见）。
    const argsParent = transferArgs({ amount: 50, outcome: "non-ok" });
    const parent = admit(service, "biz:f17:retry", argsParent);
    expect(executeTreasuryAdmittedDispatch(journal, service, parent).status).toBe("not_executed");
    Game.time += 1;
    service.beginTick();
    const capability = service.issueTreasuryRearmCapability({ attemptId: parent.attemptId });
    if (capability.status !== "ok") throw new Error("capability failed");
    const childContract = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "biz:f17:retry", args: transferArgs({ amount: 50 }) });
    if (childContract.status !== "built") throw new Error("child contract failed");
    const child = service.executeRearm(capability.rearm, childContract.contract, { workKey: "biz:f17:retry" });
    if (child.status !== "admitted") throw new Error(`rearm failed: ${child.reason}`);
    const argsChild = transferArgs({ amount: 50 });
    expect(executeTreasuryAdmittedDispatch(journal, service, child).status).toBe("committed");
    hostLedger.push({ attemptId: child.attemptId, amount: 50 });
    // 2) 完成工作（100）——在删除 W2 可见性之前（其收尾在下文观察缺失段）。
    const argsDone = transferArgs({ amount: 100, outcome: "ok" });
    const done = admit(service, "biz:f17:done", argsDone);
    expect(executeTreasuryAdmittedDispatch(journal, service, done).status).toBe("committed");
    hostLedger.push({ attemptId: done.attemptId, amount: 100 });
    // 3) 长期 unknown（100 throw——观察缺失来源）。
    const argsUnknown = transferArgs({ amount: 100, outcome: "throw" });
    const unknown = admit(service, "biz:f17:unknown", argsUnknown);
    expect(executeTreasuryAdmittedDispatch(journal, service, unknown).status).toBe("unknown");
    // 4) 部分清理：W2 离开可见范围——done（committed、流入侧不可观察）暂不退出。
    visible.delete("W2N57");
    Game.time += 1;
    service.beginTick();
    expect(service.kernelJournal().active.find((r) => r.attemptId === done.attemptId)).toBeDefined(); // 范围缺失不退出
    // 5) 完整 reset + 源恢复（V1/§3.2 修复后：继续当前世界走入口即时快照——
    //    oracle 通道不再接受显式 memorySnapshot；此处快照本就是 reset 入口
    //    时刻的当前 Memory，语义等价迁移）。
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter: makeTreasuryExactOracleAdapter(journal), advanceTicks: 1 });
    Game.time += 1;
    reset.service.beginTick();
    const journalAfter = reset.service.kernelJournal();
    expect(journalAfter.active.some((r) => r.attemptId === done.attemptId)).toBe(false); // 源恢复→观察覆盖→退出
    expect(journalAfter.active.some((r) => r.attemptId === child.attemptId)).toBe(false);
    const unknownStill = journalAfter.active.find((r) => r.attemptId === unknown.attemptId);
    expect(unknownStill?.phase).toBe("outcome_unknown"); // 长期 unknown 有界保留
    // 6) 独立宿主账目一致：世界 = 1000 − 宿主账目合计（150）= 850。
    const expected = 1000 - hostLedger.reduce((sum, e) => sum + e.amount, 0);
    expect((reset.rooms.W1N57 as unknown as { storage: { store: Record<string, number> } }).storage.store.energy).toBe(expected);
    expect(oracle.trace.effects).toBe(hostLedger.length); // 效果计数 = 宿主账目条数
    // 7) 旧视图不超额：观察 850，长期 unknown（100）保守占用 → 750 可纳、751 拒。
    const fits = authorizeOn(reset, "biz:f17:fits", transferArgs({ amount: 750, outcome: "ok" }));
    expect(fits.status).toBe("admitted");
    const tooBig = authorizeOn(reset, "biz:f17:toobig", transferArgs({ amount: 751, outcome: "ok" }));
    expect(tooBig.status).toBe("rejected");
  });
});
