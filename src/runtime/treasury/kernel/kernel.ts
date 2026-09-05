/**
 * Treasury Core Kernel——装配与单一写入口（Core Rewrite I 的运行核心）。
 *
 * 契约（design §7.1 / §5 / §6）：
 * - 一切持久状态变更经 applyTreasuryCoreCommand（commands.ts 纯转移 +
 *   writeTreasuryCoreMemory 写后读回）。恢复、GC、容量回收没有旁路。
 * - 正向执行许可（dispatch permit）只在 admit / rearm 成功时签发，heap-only，
 *   跨 tick / runtime generation 失效；executeDispatch 校验许可对象身份、
 *   活跃记录、当前阶段与完整身份后才调用动作——外部字符串 ID 永远不是许可。
 * - dispatch 顺序固定：许可校验 → dispatching 发布（持久+读回，失败则零
 *   调用、保持 pending）→ permit 置 consumed → 动作恰好一次 → 三种事实
 *   （invocation / external accept / settlement）分别持久。
 * - beginTick/endTick 恢复只做保守推进（dispatching → outcome_unknown）、
 *   公平清理与 retry 期限关闭；未知结果不能被推导成 not-executed。
 * - 满载拒绝新工作；已接纳工作始终可获得恢复/收尾预算。
 */

import {
  TREASURY_CORE_RECOVERY_BUDGET_PER_TICK,
  TREASURY_CORE_SCHEMA_VERSION,
  type TreasuryCoreDispatchPermit,
  type TreasuryCoreIdentityFacts,
  type TreasuryCoreMemory,
  type TreasuryCoreRearmPermit,
  type TreasuryCoreStoreHealth,
  type TreasuryCoreWorstCaseLeg,
} from "@/runtime/treasury/kernel/types";
import { cloneTreasuryDurableValue } from "@/runtime/treasury/durableClone";
import {
  applyTreasuryCoreStateCommand,
  type TreasuryCoreCommand,
  type TreasuryCoreEffect,
} from "@/runtime/treasury/kernel/commands";
import {
  detectLegacyTreasuryStores,
  initializeTreasuryCoreStore,
  readTreasuryCoreStoreHealth,
  writeTreasuryCoreMemory,
} from "@/runtime/treasury/kernel/store";
import {
  isValidTreasuryCoreWorkKey,
  mintTreasuryCoreDispatchPermit,
  mintTreasuryCoreRearmPermit,
  validateTreasuryCoreDispatchPermit,
  validateTreasuryCoreRearmPermit,
} from "@/runtime/treasury/kernel/identity";

/** kernel 依赖的窄 adapter 端口（facade 从注册表适配；kernel 不依赖注册表实现）。 */
export interface TreasuryCoreActionAdapterPort {
  readonly kind: string;
  readonly version: number;
  readonly registrationId: string;
  readonly semanticIdentity: string;
  /** 动作执行（受控调用边界的唯一外部副作用入口）。 */
  execute(args: unknown): { ok: boolean };
  /** adapter 显式声明：外部接口接受即世界效果确认（默认 false——保守）。 */
  readonly settlesOnAccept: boolean;
  /** adapter 显式声明：non-ok 返回的语义（默认 "unknown"——保守）。 */
  readonly nonOkOutcome: "not_executed" | "unknown";
}

export interface TreasuryCoreKernelPorts {
  readonly nowTick: () => number;
  /** runtime generation（facade service 生成号；global reset 后变化）。 */
  readonly runtimeGeneration: () => number;
  readonly findAdapter: (kind: string) => TreasuryCoreActionAdapterPort | undefined;
  /**
   * 接纳容量端口：由 facade 用 exact observation + 本 tick overlay +
   * kernel 占用口径实现。返回拒绝原因或 null（可用）。
   */
  readonly checkAdmissionCapacity: (worstCase: readonly TreasuryCoreWorstCaseLeg[]) => string | null;
  /** 外部消费者幂等释放端口（返回 false = 释放未确认，duty 保留）。 */
  readonly releaseExternalConsumer?: (consumerKey: string, attemptId: string) => boolean;
  /** 诊断事件流（可选；测试计量与 metrics 挂载点，不影响权威）。 */
  readonly onEffect?: (effect: TreasuryCoreEffect) => void;
}

export interface TreasuryCoreAdmissionInput {
  readonly workKey: string;
  readonly identity: TreasuryCoreIdentityFacts;
  readonly worstCase: readonly TreasuryCoreWorstCaseLeg[];
  readonly externalConsumers: readonly string[];
  /** 当次调用的 canonical frozen args（只进 permit，不持久）。 */
  readonly canonicalArgs: unknown;
}

export type TreasuryCoreAdmissionResult =
  | {
      readonly status: "admitted";
      readonly attemptId: string;
      readonly dispatch: TreasuryCoreDispatchPermit;
    }
  | { readonly status: "rejected"; readonly reason: string; readonly reasonCode: TreasuryCoreRejectionCode };

export type TreasuryCoreRejectionCode =
  | "policy_unavailable"
  | "policy_fault"
  | "policy_violation"
  | "insufficient_amount"
  | "store_unhealthy"
  | "store_incompatible"
  | "legacy_store_present"
  | "active_full"
  | "work_key_conflict"
  | "invalid_input"
  | "capacity_insufficient"
  | "write_failed";

export type TreasuryCoreDispatchOutcome =
  | { readonly status: "committed"; readonly attemptId: string }
  | { readonly status: "not_executed"; readonly attemptId: string }
  | { readonly status: "unknown"; readonly attemptId: string; readonly reason?: string }
  /** 前置拒绝：动作调用 0 次。 */
  | { readonly status: "rejected"; readonly reason: string }
  /** dispatching 发布失败：动作调用 0 次，聚合保持 pending。 */
  | { readonly status: "publish_failed"; readonly reason: string }
  /**
   * 结果持久失败：动作已发生（invocation 计 1），聚合按保守方向处理。
   * observed 是 kernel 在 heap 观察到的方向；持久状态至少推进为
   * outcome_unknown（endTick/beginTick 会再尝试恢复）。
   */
  | {
      readonly status: "persist_failed";
      readonly attemptId: string;
      readonly observed: "unknown" | "committed" | "not_executed";
      readonly reason: string;
    };

export interface TreasuryCoreKernelMetrics {
  readonly activeCount: number;
  readonly pendingCount: number;
  readonly unknownCount: number;
  readonly closingCount: number;
  readonly retryReadyCount: number;
  readonly ringCount: number;
  readonly frontier: number;
  readonly burned: number;
  readonly counters: TreasuryCoreMemory["counters"];
  readonly legacyStores: readonly string[];
}

/** 本 runtime 已消费的 permit（防同 tick 重入/重复执行）。 */
const consumedPermits = new WeakSet<TreasuryCoreDispatchPermit>();

export interface TreasuryCoreKernel {
  readonly health: () => TreasuryCoreStoreHealth;
  readonly legacyStores: () => readonly string[];
  readonly metrics: () => TreasuryCoreKernelMetrics;
  readonly admit: (input: TreasuryCoreAdmissionInput) => TreasuryCoreAdmissionResult;
  readonly executeDispatch: (permit: unknown) => TreasuryCoreDispatchOutcome;
  readonly settle: (input: {
    attemptId: string;
    evidenceKind: "adapter_reconcile" | "external_settlement_receipt";
    conclusion: "executed" | "not_executed" | "still_uncertain";
    /** adapter_reconcile 时的 reconciler 语义身份（必须与聚合一致）。 */
    adapterSemanticIdentity?: string;
  }) => { readonly status: "ok" } | { readonly status: "still_uncertain" } | { readonly status: "rejected"; readonly reason: string };
  readonly issueRearmPermit: (input: {
    parentAttemptId: string;
  }) => { readonly status: "ok"; readonly rearm: TreasuryCoreRearmPermit } | { readonly status: "rejected"; readonly reason: string };
  readonly executeRearm: (
    rearm: unknown,
    next: {
      readonly identity: TreasuryCoreIdentityFacts;
      readonly worstCase: readonly TreasuryCoreWorstCaseLeg[];
      readonly canonicalArgs: unknown;
    },
  ) => TreasuryCoreAdmissionResult;
  readonly closeWork: (input: {
    attemptId: string;
    reason: "retry_expired" | "abandoned";
  }) => { readonly status: "ok" } | { readonly status: "rejected"; readonly reason: string };
  readonly beginTick: () => { readonly recovered: number; readonly closed: number; readonly cleaned: number };
  readonly endTick: () => { readonly recoveredToUnknown: number };
}

export function createTreasuryCoreKernel(ports: TreasuryCoreKernelPorts): TreasuryCoreKernel {
  // 旧业务数据检测按调用时快照进行（运行中出现/清除都会被下一次检查反映；
  // 只读键存在性，成本 O(已知键数)）。
  function legacyNow(): readonly string[] {
    return detectLegacyTreasuryStores();
  }

  type WritableHealth =
    | { status: "writable"; memory: TreasuryCoreMemory }
    | { status: "blocked"; code: TreasuryCoreRejectionCode; reason: string };
  function requireWritableHealth(): WritableHealth {
    if (legacyNow().length > 0) {
      return {
        status: "blocked",
        code: "legacy_store_present",
        reason: `检测到旧 Treasury 业务数据（${legacyNow().join(",")}）——不解析、不擦除，新内核写入阻断`,
      };
    }
    const health = readTreasuryCoreStoreHealth();
    if (health.status === "unhealthy") return { status: "blocked", code: "store_unhealthy", reason: health.reason };
    if (health.status === "incompatible") return { status: "blocked", code: "store_incompatible", reason: health.reason };
    if (health.status === "absent") {
      const init = initializeTreasuryCoreStore(ports.nowTick());
      if (!init.initialized) {
        return { status: "blocked", code: "write_failed", reason: `内核显式初始化失败：${init.reason ?? "未知"}` };
      }
      const after = readTreasuryCoreStoreHealth();
      if (after.status !== "healthy") {
        return { status: "blocked", code: "write_failed", reason: `初始化后读取异常：${after.status === "absent" ? "缺失" : after.reason}` };
      }
      return { status: "writable", memory: after.memory };
    }
    return { status: "writable", memory: health.memory };
  }

  function runCommand(
    command: TreasuryCoreCommand,
  ): { readonly status: "applied"; readonly effects: readonly TreasuryCoreEffect[] } | { readonly status: "failed"; readonly reason: string } {
    const health = requireWritableHealth();
    if (health.status === "blocked") return { status: "failed", reason: health.reason };
    // 在写入副本上先跑纯转移：非 admit 命令被拒绝时不落盘；admit 的拒绝
    // 只递增 rejectedAdmissions 计数器（纯函数在副本上就地维护），同样
    // 写回。其余持久变更全部来自被接受的转移。
    const draft = cloneForCommand(health.memory);
    const result = applyTreasuryCoreStateCommand(draft, command, { nowTick: ports.nowTick() });
    if (result.status === "rejected" && command.type !== "admit") {
      return { status: "failed", reason: result.reason };
    }
    const write = writeTreasuryCoreMemory((root) => {
      Object.assign(root, draft);
    }, () => undefined);
    if (write.status === "failed") {
      return { status: "failed", reason: `持久化失败：${write.reason}` };
    }
    if (result.status === "rejected") return { status: "failed", reason: result.reason };
    for (const effect of result.effects) ports.onEffect?.(effect);
    return { status: "applied", effects: result.effects };
  }

  function admit(input: TreasuryCoreAdmissionInput): TreasuryCoreAdmissionResult {
    if (!isValidTreasuryCoreWorkKey(input.workKey)) {
      return { status: "rejected", reason: `workKey 非法（须 ${"biz:"} 前缀且有界）`, reasonCode: "invalid_input" };
    }
    if (input.worstCase.length === 0) {
      return { status: "rejected", reason: "worstCase 为空（动作必须声明最坏占用）", reasonCode: "invalid_input" };
    }
    const health = requireWritableHealth();
    if (health.status === "blocked") return { status: "rejected", reason: health.reason, reasonCode: health.code };
    const capacityProblem = ports.checkAdmissionCapacity(input.worstCase);
    if (capacityProblem !== null) {
      bumpRejectedCounter();
      return { status: "rejected", reason: capacityProblem, reasonCode: "capacity_insufficient" };
    }
    const run = runCommand({
      type: "admit",
      workKey: input.workKey,
      identity: input.identity,
      worstCase: input.worstCase,
      externalConsumers: input.externalConsumers,
    });
    if (run.status === "failed") {
      // 满载 / 排他冲突由纯函数拒绝并已计数；写入失败额外补计数。
      return { status: "rejected", reason: run.reason, reasonCode: classifyRejection(run.reason) };
    }
    const admitted = run.effects.find((e): e is { effect: "admitted"; attemptId: string } => e.effect === "admitted");
    if (!admitted) return { status: "rejected", reason: "接纳未产生 attempt（内部不一致）", reasonCode: "write_failed" };
    const dispatch = mintTreasuryCoreDispatchPermit({
      attemptId: admitted.attemptId,
      canonicalDigest: input.identity.canonicalDigest,
      canonicalArgs: input.canonicalArgs,
      actionKind: input.identity.actionKind,
      adapterRegistrationId: input.identity.adapterRegistrationId,
      adapterSemanticIdentity: input.identity.adapterSemanticIdentity,
      issuedAtTick: ports.nowTick(),
      runtimeGeneration: ports.runtimeGeneration(),
    });
    return { status: "admitted", attemptId: admitted.attemptId, dispatch };
  }

  function classifyRejection(reason: string): TreasuryCoreRejectionCode {
    if (reason.includes("满载")) return "active_full";
    if (reason.includes("排他冲突")) return "work_key_conflict";
    return "write_failed";
  }

  function bumpRejectedCounter(): void {
    const health = readTreasuryCoreStoreHealth();
    if (health.status !== "healthy") return;
    writeTreasuryCoreMemory((root) => {
      root.counters.rejectedAdmissions += 1;
    }, () => undefined);
  }

  function executeDispatch(permit: unknown): TreasuryCoreDispatchOutcome {
    const nowTick = ports.nowTick();
    const permitCheck = validateTreasuryCoreDispatchPermit(permit, nowTick, ports.runtimeGeneration());
    if (permitCheck.status !== "valid") return { status: "rejected", reason: permitCheck.reason };
    const typed = permitCheck.permit;
    if (consumedPermits.has(typed)) {
      return { status: "rejected", reason: "dispatch 许可已消费（同 attempt 实际调用至多一次）" };
    }
    const health = requireWritableHealth();
    if (health.status === "blocked") return { status: "rejected", reason: health.reason };
    const record = health.memory.active[typed.attemptId];
    if (record === undefined) {
      return { status: "rejected", reason: `attempt ${typed.attemptId} 不在活跃集合（无执行许可）` };
    }
    if (record.phase !== "pending") {
      return { status: "rejected", reason: `attempt ${typed.attemptId} 阶段为 ${record.phase}（不可再次调用）` };
    }
    if (record.identity.canonicalDigest !== typed.canonicalDigest) {
      return { status: "rejected", reason: "许可与聚合身份冲突（原事实保留，不执行）" };
    }
    const adapter = ports.findAdapter(record.identity.actionKind);
    if (
      adapter === undefined ||
      adapter.registrationId !== record.identity.adapterRegistrationId ||
      adapter.semanticIdentity !== record.identity.adapterSemanticIdentity ||
      adapter.version !== record.identity.adapterVersion
    ) {
      return {
        status: "rejected",
        reason: "adapter 注册身份与聚合不一致（执行环境语义已变化，旧授权失效）",
      };
    }
    // 1) dispatching 发布（持久 + 读回）。失败 → 零调用、保持 pending。
    const start = runCommand({ type: "dispatch_start", attemptId: typed.attemptId, canonicalDigest: typed.canonicalDigest });
    if (start.status === "failed") return { status: "publish_failed", reason: start.reason };
    // 2) 置 consumed（重入/同 tick 重复在此之后一律拒绝）。
    consumedPermits.add(typed);
    // 3) 动作恰好一次。invocation 事实先于调用记录在事件流（onEffect）
    //    中不可用——invocation 是 dispatch_result 命令的输入，由本函数
    //    在调用后统一持久（异常路径也持久 unknown）。
    let invocationOutcome: "committed" | "not_executed" | "unknown";
    let external: { accepted: boolean } | null = null;
    let errorMessage: string | null = null;
    try {
      const actionResult = adapter.execute(typed.canonicalArgs);
      external = { accepted: actionResult.ok };
      if (actionResult.ok && adapter.settlesOnAccept) {
        invocationOutcome = "committed";
      } else if (!actionResult.ok && adapter.nonOkOutcome === "not_executed") {
        invocationOutcome = "not_executed";
      } else {
        invocationOutcome = "unknown";
      }
    } catch (error) {
      invocationOutcome = "unknown";
      errorMessage = error instanceof Error ? error.message : String(error);
      external = null;
    }
    // 4) 结果持久（含 invocation/external 事实）。失败 → 保守 unknown 兜底。
    const evidence =
      invocationOutcome === "committed"
        ? { kind: "adapter_execution_semantics" as const, conclusion: "executed" as const, source: adapter.semanticIdentity.slice(0, 64), atTick: nowTick }
        : invocationOutcome === "not_executed"
          ? { kind: "adapter_execution_semantics" as const, conclusion: "not_executed" as const, source: adapter.semanticIdentity.slice(0, 64), atTick: nowTick }
          : null;
    const persist = runCommand({
      type: "dispatch_result",
      attemptId: typed.attemptId,
      invocationAtTick: nowTick,
      external,
      outcome: invocationOutcome,
      evidence,
      error: errorMessage,
    });
    if (persist.status === "failed") {
      // 兜底：至少推进为 unknown（写一次 conservative recovery）。
      const fallback = runCommand({ type: "recover_dispatching", attemptId: typed.attemptId });
      return {
        status: "persist_failed",
        attemptId: typed.attemptId,
        observed: invocationOutcome,
        reason: fallback.status === "applied" ? `结果写入失败，已保守恢复为 unknown（${persist.reason}）` : `结果写入与保守恢复均失败（${persist.reason}）`,
      };
    }
    if (invocationOutcome === "unknown") {
      return { status: "unknown", attemptId: typed.attemptId, reason: errorMessage ?? undefined };
    }
    return { status: invocationOutcome, attemptId: typed.attemptId };
  }

  function settle(input: Parameters<TreasuryCoreKernel["settle"]>[0]): ReturnType<TreasuryCoreKernel["settle"]> {
    const health = requireWritableHealth();
    if (health.status === "blocked") return { status: "rejected", reason: health.reason };
    const record = health.memory.active[input.attemptId];
    if (record === undefined) return { status: "rejected", reason: `attempt ${input.attemptId} 不在活跃集合` };
    if (input.evidenceKind === "adapter_reconcile") {
      if (input.adapterSemanticIdentity === undefined) {
        return { status: "rejected", reason: "adapter_reconcile 证据必须声明 reconciler 语义身份" };
      }
      if (input.adapterSemanticIdentity !== record.identity.adapterSemanticIdentity) {
        return { status: "rejected", reason: "reconciler 语义身份与聚合不一致（不得从其他 owner 反推结论）" };
      }
      const adapter = ports.findAdapter(record.identity.actionKind);
      if (
        adapter === undefined ||
        adapter.registrationId !== record.identity.adapterRegistrationId ||
        adapter.semanticIdentity !== record.identity.adapterSemanticIdentity
      ) {
        return { status: "rejected", reason: "reconciler 注册身份与聚合不一致" };
      }
    }
    const run = runCommand({
      type: "settle",
      attemptId: input.attemptId,
      evidence: { kind: input.evidenceKind, conclusion: input.conclusion, source: (input.adapterSemanticIdentity ?? "external").slice(0, 64) },
    });
    if (run.status === "failed") return { status: "rejected", reason: run.reason };
    if (input.conclusion === "still_uncertain") return { status: "still_uncertain" };
    return { status: "ok" };
  }

  function issueRearmPermit(input: Parameters<TreasuryCoreKernel["issueRearmPermit"]>[0]): ReturnType<TreasuryCoreKernel["issueRearmPermit"]> {
    const health = requireWritableHealth();
    if (health.status === "blocked") return { status: "rejected", reason: health.reason };
    const record = health.memory.active[input.parentAttemptId];
    if (record === undefined) return { status: "rejected", reason: `前代 attempt 不在活跃集合` };
    if (record.phase !== "retry_ready") {
      return { status: "rejected", reason: `前代阶段为 ${record.phase}（只有 exact not-executed + 清理完成才可 rearm）` };
    }
    if (record.identity.retryFactsDigest === null) {
      return { status: "rejected", reason: "前代缺少 retry 语义事实（non-rearmable）" };
    }
    const rearm = mintTreasuryCoreRearmPermit({
      parentAttemptId: record.attemptId,
      workKey: record.workKey,
      retryFactsDigest: record.identity.retryFactsDigest,
      issuedAtTick: ports.nowTick(),
      runtimeGeneration: ports.runtimeGeneration(),
    });
    return { status: "ok", rearm };
  }

  function executeRearm(
    rearm: unknown,
    next: Parameters<TreasuryCoreKernel["executeRearm"]>[1],
  ): TreasuryCoreAdmissionResult {
    const nowTick = ports.nowTick();
    const check = validateTreasuryCoreRearmPermit(rearm, nowTick, ports.runtimeGeneration());
    if (check.status !== "valid") return { status: "rejected", reason: check.reason, reasonCode: "invalid_input" };
    const typed = check.permit;
    if (consumedPermits.has(typed as unknown as TreasuryCoreDispatchPermit)) {
      return { status: "rejected", reason: "rearm 许可已消费（不会创建两个 child）", reasonCode: "invalid_input" };
    }
    const health = requireWritableHealth();
    if (health.status === "blocked") return { status: "rejected", reason: health.reason, reasonCode: health.code };
    const capacityProblem = ports.checkAdmissionCapacity(next.worstCase);
    if (capacityProblem !== null) {
      bumpRejectedCounter();
      return { status: "rejected", reason: capacityProblem, reasonCode: "capacity_insufficient" };
    }
    const run = runCommand({
      type: "rearm",
      parentAttemptId: typed.parentAttemptId,
      identity: next.identity,
      worstCase: next.worstCase,
    });
    if (run.status === "failed") return { status: "rejected", reason: run.reason, reasonCode: classifyRejection(run.reason) };
    const reared = run.effects.find((e): e is { effect: "rearmed"; parentAttemptId: string; attemptId: string } => e.effect === "rearmed");
    if (!reared) return { status: "rejected", reason: "rearm 未产生新 attempt", reasonCode: "write_failed" };
    consumedPermits.add(typed as unknown as TreasuryCoreDispatchPermit);
    const dispatch = mintTreasuryCoreDispatchPermit({
      attemptId: reared.attemptId,
      canonicalDigest: next.identity.canonicalDigest,
      canonicalArgs: next.canonicalArgs,
      actionKind: next.identity.actionKind,
      adapterRegistrationId: next.identity.adapterRegistrationId,
      adapterSemanticIdentity: next.identity.adapterSemanticIdentity,
      issuedAtTick: ports.nowTick(),
      runtimeGeneration: ports.runtimeGeneration(),
    });
    return { status: "admitted", attemptId: reared.attemptId, dispatch };
  }

  function closeWork(input: Parameters<TreasuryCoreKernel["closeWork"]>[0]): ReturnType<TreasuryCoreKernel["closeWork"]> {
    const run = runCommand({ type: "close", attemptId: input.attemptId, reason: input.reason });
    return run.status === "applied" ? { status: "ok" } : { status: "rejected", reason: run.reason };
  }

  function beginTick(): { recovered: number; closed: number; cleaned: number } {
    let recovered = 0;
    let closed = 0;
    let cleaned = 0;
    const health = readTreasuryCoreStoreHealth();
    if (health.status !== "healthy") return { recovered, closed, cleaned };
    if (legacyNow().length > 0) return { recovered, closed, cleaned };
    // 1) dispatching 残留 → 保守 unknown（可能已进入；不重发）。
    for (const record of sortedActive(health.memory)) {
      if (record.phase !== "dispatching") continue;
      if (applyRecoveryCommand({ type: "recover_dispatching", attemptId: record.attemptId })) recovered += 1;
    }
    // 2) retry 权利期限关闭。
    const nowTick = ports.nowTick();
    const afterRecover = readTreasuryCoreStoreHealth();
    if (afterRecover.status === "healthy") {
      for (const record of sortedActive(afterRecover.memory)) {
        if (record.phase !== "retry_ready") continue;
        if (record.retryDeadlineTick !== null && nowTick > record.retryDeadlineTick) {
          if (applyRecoveryCommand({ type: "close", attemptId: record.attemptId, reason: "retry_expired" })) closed += 1;
        }
      }
    }
    // 3) closing 清理公平推进（预算内；external consumer 释放经端口幂等确认）。
    const afterCloses = readTreasuryCoreStoreHealth();
    if (afterCloses.status === "healthy") {
      let budget = TREASURY_CORE_RECOVERY_BUDGET_PER_TICK;
      for (const record of sortedActive(afterCloses.memory)) {
        if (budget <= 0) break;
        if (record.phase !== "closing") continue;
        if (record.cleanup.consumerKeys.length === 0) {
          if (applyRecoveryCommand({ type: "advance_cleanup", attemptId: record.attemptId, releasedDuties: [] })) {
            cleaned += 1;
            budget -= 1;
          }
          continue;
        }
        const released: string[] = [];
        let allConfirmed = true;
        for (const consumerKey of record.cleanup.consumerKeys) {
          const ok = ports.releaseExternalConsumer?.(consumerKey, record.attemptId) ?? true;
          if (ok) released.push(consumerKey);
          else allConfirmed = false;
        }
        // 释放未确认的消费者义务保留（不因端口失败谎报完成）。
        if (applyRecoveryCommand({ type: "advance_cleanup", attemptId: record.attemptId, releasedDuties: released })) {
          cleaned += 1;
          budget -= 1;
          void allConfirmed;
        }
      }
    }
    // 4) lifecycle 标记。
    writeTreasuryCoreMemory((root) => {
      root.lifecycle.lastBeginTick = ports.nowTick();
    }, () => undefined);
    return { recovered, closed, cleaned };
  }

  function applyRecoveryCommand(command: TreasuryCoreCommand): boolean {
    const draftHealth = readTreasuryCoreStoreHealth();
    if (draftHealth.status !== "healthy") return false;
    const draft = cloneForCommand(draftHealth.memory);
    const result = applyTreasuryCoreStateCommand(draft, command, { nowTick: ports.nowTick() });
    if (result.status === "rejected") return false;
    const write = writeTreasuryCoreMemory((root) => {
      Object.assign(root, draft);
    }, () => undefined);
    if (write.status === "failed") return false;
    for (const effect of result.effects) ports.onEffect?.(effect);
    return true;
  }

  function endTick(): { recoveredToUnknown: number } {
    let recoveredToUnknown = 0;
    const health = readTreasuryCoreStoreHealth();
    if (health.status === "healthy" && legacyNow().length === 0) {
      // dispatching 残留（当次调用异常逃逸）→ 保守 unknown。
      for (const record of sortedActive(health.memory)) {
        if (record.phase !== "dispatching") continue;
        if (applyRecoveryCommand({ type: "recover_dispatching", attemptId: record.attemptId })) recoveredToUnknown += 1;
      }
      writeTreasuryCoreMemory((root) => {
        root.lifecycle.lastEndTick = ports.nowTick();
      }, () => undefined);
    }
    return { recoveredToUnknown };
  }

  function sortedActive(memory: TreasuryCoreMemory) {
    return Object.values(memory.active).sort((a, b) => (a.attemptId < b.attemptId ? -1 : 1));
  }

  function metrics(): TreasuryCoreKernelMetrics {
    const health = readTreasuryCoreStoreHealth();
    const empty: TreasuryCoreMemory = {
      version: TREASURY_CORE_SCHEMA_VERSION,
      installEpochId: "-",
      issuance: { frontier: 0, burned: 0 },
      lifecycle: { lastBeginTick: null, lastEndTick: null },
      active: {},
      ring: [],
      ringCursor: 0,
      counters: {
        admitted: 0,
        dispatched: 0,
        settledCommitted: 0,
        settledNotExecuted: 0,
        unknown: 0,
        rearmings: 0,
        rejectedAdmissions: 0,
        recoveryAdvances: 0,
        cleanupFailures: 0,
      },
    };
    const memory = health.status === "healthy" ? health.memory : empty;
    let pendingCount = 0;
    let unknownCount = 0;
    let closingCount = 0;
    let retryReadyCount = 0;
    for (const record of Object.values(memory.active)) {
      if (record.phase === "pending" || record.phase === "dispatching") pendingCount += 1;
      else if (record.phase === "outcome_unknown") unknownCount += 1;
      else if (record.phase === "closing") closingCount += 1;
      else if (record.phase === "retry_ready") retryReadyCount += 1;
    }
    return {
      activeCount: Object.keys(memory.active).length,
      pendingCount,
      unknownCount,
      closingCount,
      retryReadyCount,
      ringCount: memory.ring.length,
      frontier: memory.issuance.frontier,
      burned: memory.issuance.burned,
      counters: memory.counters,
      legacyStores: legacyNow(),
    };
  }

  return {
    health: () => readTreasuryCoreStoreHealth(),
    legacyStores: () => legacyNow(),
    metrics,
    admit,
    executeDispatch,
    settle,
    issueRearmPermit,
    executeRearm,
    closeWork,
    beginTick,
    endTick,
  };
}

/** 命令草稿副本（commands 在副本上转移；写入用 writeTreasuryCoreMemory 再 clone）。 */
function cloneForCommand(memory: TreasuryCoreMemory): TreasuryCoreMemory {
  return cloneTreasuryDurableValue(memory);
}
