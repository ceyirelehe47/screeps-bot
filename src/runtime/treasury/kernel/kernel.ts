/**
 * Treasury Core Kernel——装配与单一写入口（Core Rewrite II 运行核心）。
 *
 * 契约（design II §4–§6）：
 * - 一切持久状态变更经 applyTreasuryCoreCommand（commands.ts 纯转移 +
 *   writeTreasuryCoreMemory 发布确认：基线漂移检查 + 读回与草稿深度精确
 *   比较）。恢复、GC、容量回收没有旁路。
 * - 正向执行许可（dispatch permit）只在 admit / rearm 成功时签发，heap-only
 *   深冻结快照，跨 tick / runtime generation 失效；executeDispatch 校验
 *   许可对象身份、冻结完整性、活跃记录、当前阶段与完整身份事实后才调用
 *   动作——外部字符串 ID 永远不是许可，真许可的可变字段也不可信。
 * - dispatch 顺序固定：许可校验 → dispatching 发布（持久+发布确认，失败则
 *   零调用、保持 pending）→ permit 置 consumed → 动作恰好一次（参数来自
 *   冻结签发快照）→ 三种事实（invocation / external accept / settlement）
 *   分别持久。
 * - beginTick/endTick：dispatching 保守化 → 跨 tick pending 安全取消（§6.1）
 *   → retry 期限关闭 → closing 公平清理（持久游标轮转 + per-tick 操作预算，
 *   同 tick 多入口共享）；未知结果不能被推导成 not-executed。
 * - 结算结论只来自受控 reconcileOutcome 端口（facade 装配的注册
 *   reconciler）；自报 external receipt 通道不存在（R07）。
 * - 无受控释放端口时：非空 externalConsumers 的接纳被拒绝；已持久义务在
 *   端口缺失/未确认/抛错时保持 active（无默认成功——R05）。
 * - 满载拒绝新工作（含总序列化预算）；已接纳工作始终可获得恢复/收尾预算。
 */

import {
  TREASURY_CORE_RECOVERY_BUDGET_PER_TICK,
  TREASURY_CORE_SCHEMA_VERSION,
  TREASURY_CORE_SUBBUDGET_DISPATCHING,
  TREASURY_CORE_SUBBUDGET_RETRY_CLOSE,
  TREASURY_CORE_SUBBUDGET_SWEEP,
  TREASURY_CORE_TOTAL_CHAR_BUDGET,
  type TreasuryCoreAdmissionContext,
  type TreasuryCoreDispatchPermit,
  type TreasuryCoreIdentityFacts,
  type TreasuryCoreMemory,
  type TreasuryCoreRearmPermit,
  type TreasuryCoreStoreHealth,
  type TreasuryCoreWorstCaseLeg,
  type TreasuryCoreWorkRecord,
} from "@/runtime/treasury/kernel/types";
import { cloneTreasuryDurableValue } from "@/runtime/treasury/durableClone";
import { readTreasuryWorldSequence } from "@/runtime/treasury/observation";
import {
  applyTreasuryCoreStateCommand,
  type TreasuryCoreCommand,
  type TreasuryCoreEffect,
} from "@/runtime/treasury/kernel/commands";
import {
  detectLegacyTreasuryStores,
  initializeTreasuryCoreStore,
  readTreasuryCoreStoreHealth,
  resetTreasuryCoreRingLayer,
  treasuryCoreRingSlotWorstChars,
  treasuryCoreSerializedChars,
  treasuryCoreSlotWorstChars,
  writeTreasuryCoreMemory,
} from "@/runtime/treasury/kernel/store";
import {
  isValidTreasuryCoreWorkKey,
  mintTreasuryCoreDispatchPermit,
  mintTreasuryCoreRearmPermit,
  treasuryCorePermitRecordConflicts,
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

/** 受控对账端口：结论由 facade 装配的注册 reconciler 得出（内核唯一结算通道）。 */
export type TreasuryCoreReconcileOutcomePort = (record: TreasuryCoreWorkRecord) =>
  | { readonly status: "ok"; readonly conclusion: "executed" | "not_executed" | "still_uncertain"; readonly source: string }
  | { readonly status: "rejected"; readonly reason: string };

export interface TreasuryCoreKernelPorts {
  readonly nowTick: () => number;
  /** runtime generation（facade service 生成号；global reset 后变化）。 */
  readonly runtimeGeneration: () => number;
  readonly findAdapter: (kind: string) => TreasuryCoreActionAdapterPort | undefined;
  /** 受控对账端口（settle 结论唯一来源；缺省即无法结算——unknown 保留）。 */
  readonly reconcileOutcome?: TreasuryCoreReconcileOutcomePort;
  /**
   * 接纳容量端口（III/R2）：由 facade 用 exact observation + kernel 占用 +
   * 完整授权上下文实现——context 携带真实 contract 身份与经验证的 owner，
   * 不允许退化为匿名口径。返回拒绝原因或 null（可用）。
   */
  readonly checkAdmissionCapacity: (
    worstCase: readonly TreasuryCoreWorstCaseLeg[],
    context: TreasuryCoreAdmissionContext | undefined,
  ) => { readonly reason: string; readonly reasonCode?: TreasuryCoreRejectionCode } | null;
  /** 外部消费者幂等释放端口（返回 false = 释放未确认，duty 保留；缺失即无受控释放能力）。 */
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
  /** 签发时的原始 posting 腿（只进 permit，不持久）。 */
  readonly postings: readonly { roomName: string; locationKind: string; resource: string; delta: number }[];
  /** 完整授权上下文（真实 contract 身份 + 验证 owner；端口判定唯一口径）。 */
  readonly admissionContext: TreasuryCoreAdmissionContext;
  /** 签发时观察的结构绑定快照（只进 permit；复验比对 incarnation）。 */
  readonly structureBindings: readonly { roomName: string; locationKind: string; structureId: string }[];
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
  | "release_port_unavailable"
  | "memory_budget_exceeded"
  | "lifecycle_closed"
  | "structure_changed"
  | "write_failed";

export type TreasuryCoreDispatchOutcome =
  | { readonly status: "committed"; readonly attemptId: string }
  | { readonly status: "not_executed"; readonly attemptId: string }
  | { readonly status: "unknown"; readonly attemptId: string; readonly reason?: string }
  /** 前置拒绝：动作调用 0 次。 */
  | { readonly status: "rejected"; readonly reason: string }
  /**
   * 执行门禁阻断（III/§4.4）：当前授权窗口关闭、执行前复验失败或结构
   * incarnation 变化。动作调用 0 次，不消费许可，记录保持 pending（可
   * 显式取消或按既定规则过期取消）。
   */
  | { readonly status: "blocked"; readonly reasonCode: string; readonly reason: string }
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
  /** 事后结算（outcome_unknown → committed/not_executed；结论只来自受控对账端口）。 */
  readonly settle: (input: {
    attemptId: string;
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
      readonly postings: readonly { roomName: string; locationKind: string; resource: string; delta: number }[];
      readonly admissionContext: TreasuryCoreAdmissionContext;
      readonly structureBindings: readonly { roomName: string; locationKind: string; structureId: string }[];
    },
  ) => TreasuryCoreAdmissionResult;
  /** 安全取消：只结束确定未开始的当前 pending attempt（§6.1）。 */
  readonly cancelPending: (input: {
    attemptId: string;
  }) => { readonly status: "ok" } | { readonly status: "rejected"; readonly reason: string };
  readonly closeWork: (input: {
    attemptId: string;
    reason: "retry_expired" | "abandoned";
  }) => { readonly status: "ok" } | { readonly status: "rejected"; readonly reason: string };
  readonly beginTick: () => { readonly recovered: number; readonly closed: number; readonly cleaned: number; readonly cancelled: number };
  readonly endTick: () => { readonly recoveredToUnknown: number };
}

export function createTreasuryCoreKernel(ports: TreasuryCoreKernelPorts): TreasuryCoreKernel {
  // 旧业务数据检测按调用时快照进行（运行中出现/清除都会被下一次检查反映；
  // 只读键存在性，成本 O(已知键数)）。
  function legacyNow(): readonly string[] {
    return detectLegacyTreasuryStores();
  }

  type WritableHealth =
    | { status: "writable"; memory: TreasuryCoreMemory; ringDegraded: string | null }
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
      return { status: "writable", memory: after.memory, ringDegraded: after.ringDegraded };
    }
    return { status: "writable", memory: health.memory, ringDegraded: health.ringDegraded };
  }

  function runCommand(
    command: TreasuryCoreCommand,
  ): { readonly status: "applied"; readonly effects: readonly TreasuryCoreEffect[] } | { readonly status: "failed"; readonly reason: string } {
    const health = requireWritableHealth();
    if (health.status === "blocked") return { status: "failed", reason: health.reason };
    // 在写入副本上先跑纯转移：非 admit 命令被拒绝时不落盘；admit 的拒绝
    // 只递增 rejectedAdmissions 计数器（纯函数在副本上就地维护），同样
    // 写回。其余持久变更全部来自被接受的转移。ring 层损坏在下一次成功
    // 写入前重建（丢弃非权威明细；查询不修复——R10）。
    const draft = cloneForCommand(health.memory);
    if (health.ringDegraded !== null) resetTreasuryCoreRingLayer(draft);
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
    // 缺受控释放能力时拒绝非空消费者义务（§6.2：不接受义务后再写“以后接入”）。
    if (input.externalConsumers.length > 0 && ports.releaseExternalConsumer === undefined) {
      return {
        status: "rejected",
        reason: "无受控外部消费者释放端口（非空 externalConsumers 的接纳必须拒绝）",
        reasonCode: "release_port_unavailable",
      };
    }
    const health = requireWritableHealth();
    if (health.status === "blocked") return { status: "rejected", reason: health.reason, reasonCode: health.code };
    // 总序列化预算（§8.3）：逐槽完整生命周期上界法——当前实际序列化 +
    // 新聚合完整生命周期槽上界 + 新历史槽上界 ≤ 总预算。已接纳工作任何
    // 状态演化都不超过槽上界（受控字符集 + 字段硬上限），不会“先接纳短
    // pending、后无空间写长 closing”。
    const serializedNow = treasuryCoreSerializedChars(health.memory);
    const admissionWorst = treasuryCoreSlotWorstChars() + treasuryCoreRingSlotWorstChars();
    if (serializedNow > 0 && serializedNow + admissionWorst > TREASURY_CORE_TOTAL_CHAR_BUDGET) {
      bumpRejectedCounter();
      return {
        status: "rejected",
        reason: `treasuryCore 总序列化预算超限（当前 ${String(serializedNow)} + 新聚合完整生命周期上界 ${String(admissionWorst)} > ${String(TREASURY_CORE_TOTAL_CHAR_BUDGET)} 字符）`,
        reasonCode: "memory_budget_exceeded",
      };
    }
    // 容量端口携带完整授权上下文（R2：不退化为匿名裁决——owner/contract
    // 身份与接纳路径一致，own-reservation 的 exact 排除在端口内同样成立）。
    const capacityProblem = ports.checkAdmissionCapacity(input.worstCase, input.admissionContext);
    if (capacityProblem !== null) {
      bumpRejectedCounter();
      return { status: "rejected", reason: capacityProblem.reason, reasonCode: capacityProblem.reasonCode ?? "capacity_insufficient" };
    }
    const run = runCommand({
      type: "admit",
      workKey: input.workKey,
      identity: input.identity,
      worstCase: input.worstCase,
      externalConsumers: input.externalConsumers,
    });
    if (run.status === "failed") {
      // 满载 / 排他冲突 / 预算 / 输入上限由纯函数拒绝并已计数；写入失败额外补计数。
      return { status: "rejected", reason: run.reason, reasonCode: classifyRejection(run.reason) };
    }
    const admitted = run.effects.find((e): e is { effect: "admitted"; attemptId: string } => e.effect === "admitted");
    if (!admitted) return { status: "rejected", reason: "接纳未产生 attempt（内部不一致）", reasonCode: "write_failed" };
    const dispatch = mintTreasuryCoreDispatchPermit({
      attemptId: admitted.attemptId,
      canonicalDigest: input.identity.canonicalDigest,
      canonicalArgs: input.canonicalArgs,
      postings: input.postings,
      ownerIdentity: input.admissionContext.ownerIdentity,
      structureBindings: input.structureBindings,
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
    if (reason.includes("externalConsumers")) return "invalid_input";
    if (reason.includes("预算超限")) return "memory_budget_exceeded";
    return "write_failed";
  }

  function bumpRejectedCounter(): void {
    const health = readTreasuryCoreStoreHealth();
    if (health.status !== "healthy") return;
    writeTreasuryCoreMemory((root) => {
      if (root.counters.rejectedAdmissions < 9_999_999_999) root.counters.rejectedAdmissions += 1;
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
    // 执行前完整身份重验（§4.1）：可信签发快照与聚合当前事实逐项一致——
    // 许可对象身份可信不代表其字段可信；任何不匹配都拒绝且不消费许可。
    const identityConflict = treasuryCorePermitRecordConflicts(typed, record.identity);
    if (identityConflict !== null) {
      return { status: "rejected", reason: `许可与聚合身份冲突（${identityConflict}；原事实保留，不执行）` };
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
    // 调用边界世界序（效果侧锚点——在动作调用之前固定；§6.2 观察覆盖判定）。
    const invocationWorldSequence = readTreasuryWorldSequence();
    // 1) dispatching 发布（持久 + 发布确认）。失败 → 零调用、保持 pending。
    const start = runCommand({ type: "dispatch_start", attemptId: typed.attemptId, canonicalDigest: typed.canonicalDigest });
    if (start.status === "failed") return { status: "publish_failed", reason: start.reason };
    // 2) 置 consumed（重入/同 tick 重复在此之后一律拒绝）。
    consumedPermits.add(typed);
    // 3) 动作恰好一次：实际执行参数来自冻结签发快照（typed.canonicalArgs），
    //    不从公开可变字段重新派生（R01）。
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
      invocationWorldSequence,
      external,
      outcome: invocationOutcome,
      evidence,
      error: errorMessage,
    });
    if (persist.status === "failed") {
      // 兜底：至少推进为 unknown（写一次 conservative recovery）。不回滚到
      // pending、不恢复已使用许可（§4.2）。
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
    if (record.phase !== "outcome_unknown") {
      return { status: "rejected", reason: `attempt ${input.attemptId} 阶段为 ${record.phase}（仅结果未知的聚合可对账）` };
    }
    // 结论只来自受控对账端口（facade 装配的注册 reconciler）——调用者不能
    // 传入结论，也不存在 kernel.settle(rawConclusion) 旁路（R07/§4.4）。
    const port = ports.reconcileOutcome;
    if (port === undefined) {
      return { status: "rejected", reason: "无受控对账端口（unknown 保留，不猜测）" };
    }
    let reconciled: ReturnType<TreasuryCoreReconcileOutcomePort>;
    try {
      reconciled = port(record);
    } catch (error) {
      return { status: "rejected", reason: "对账端口抛错：" + String(error instanceof Error ? error.message : error).slice(0, 96) };
    }
    if (reconciled.status === "rejected") {
      return { status: "rejected", reason: `对账未成立（${reconciled.reason}）` };
    }
    const conclusion = reconciled.conclusion;
    if (conclusion !== "executed" && conclusion !== "not_executed" && conclusion !== "still_uncertain") {
      return { status: "rejected", reason: "对账端口返回未知结论（不转换，unknown 保留）" };
    }
    const run = runCommand({
      type: "settle",
      attemptId: input.attemptId,
      evidence: { kind: "adapter_reconcile", conclusion, source: reconciled.source.slice(0, 64) },
    });
    if (run.status === "failed") return { status: "rejected", reason: run.reason };
    if (conclusion === "still_uncertain") return { status: "still_uncertain" };
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
    const capacityProblem = ports.checkAdmissionCapacity(next.worstCase, next.admissionContext);
    if (capacityProblem !== null) {
      bumpRejectedCounter();
      return { status: "rejected", reason: capacityProblem.reason, reasonCode: capacityProblem.reasonCode ?? "capacity_insufficient" };
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
      postings: next.postings,
      ownerIdentity: next.admissionContext.ownerIdentity,
      structureBindings: next.structureBindings,
      actionKind: next.identity.actionKind,
      adapterRegistrationId: next.identity.adapterRegistrationId,
      adapterSemanticIdentity: next.identity.adapterSemanticIdentity,
      issuedAtTick: ports.nowTick(),
      runtimeGeneration: ports.runtimeGeneration(),
    });
    return { status: "admitted", attemptId: reared.attemptId, dispatch };
  }

  function cancelPending(input: Parameters<TreasuryCoreKernel["cancelPending"]>[0]): ReturnType<TreasuryCoreKernel["cancelPending"]> {
    const run = runCommand({ type: "cancel_pending", attemptId: input.attemptId });
    return run.status === "applied" ? { status: "ok" } : { status: "rejected", reason: run.reason };
  }

  function closeWork(input: Parameters<TreasuryCoreKernel["closeWork"]>[0]): ReturnType<TreasuryCoreKernel["closeWork"]> {
    const run = runCommand({ type: "close", attemptId: input.attemptId, reason: input.reason });
    return run.status === "applied" ? { status: "ok" } : { status: "rejected", reason: run.reason };
  }

  // ── beginTick：恢复推进（子预算公平 + 端口调用前持久预扣） ──────────────────
  //
  // 预算语义（§6.3/§7.1）：每 tick 恢复扫描/状态发布/外部清理调用共享
  // RECOVERY_BUDGET_PER_TICK；同 tick 重复 beginTick / 多实例 / 端口内重入
  // 经持久记账（recovery.budgetTick/budgetUsed）共享同一份额。
  //
  // 预扣协议（R6）：每次外部释放端口调用**之前**先持久发布
  // budgetUsed=used+1——预扣发布失败则不调用端口；端口抛错/失败/确认写回
  // 失败时该份额已消耗（不退回供重入再花）。硬终止（预扣后未进入端口）
  // 保守损失本 tick 这一次额度，下 tick 正常恢复。
  //
  // 子预算（§7.3）：dispatching 恢复 ≤2、pending sweep ≤3、retry 关闭 ≤1、
  // closing 清理保底 ≥2——持续到来的取消流量不能饿死健康清理。
  //
  // 游标（sweepCursor/cleanupCursor）是调度元信息：失效可安全重建，不是
  // 完成 proof；失败的任务也消耗预算并让后续任务在有限轮次获得机会。

  function readBudgetState(memory: TreasuryCoreMemory, nowTick: number): number {
    if (memory.recovery.budgetTick !== nowTick) return 0;
    return memory.recovery.budgetUsed;
  }

  /** 当前持久预算（每次从 Memory 现读——重入/多实例后的单一权威）。 */
  function currentBudgetUsed(nowTick: number): number {
    const health = readTreasuryCoreStoreHealth();
    if (health.status !== "healthy") return TREASURY_CORE_RECOVERY_BUDGET_PER_TICK;
    return readBudgetState(health.memory, nowTick);
  }

  /** 预算内执行一条恢复命令（命令写自身携带预算记账；持久值单调不回退）。 */
  function applyBudgetedCommand(
    used: number,
    command: TreasuryCoreCommand,
    cursors: { sweepCursor: number; cleanupCursor: number },
  ): { applied: boolean; used: number } {
    const nowTick = ports.nowTick();
    const draftHealth = readTreasuryCoreStoreHealth();
    if (draftHealth.status !== "healthy") return { applied: false, used };
    const draft = cloneForCommand(draftHealth.memory);
    // ring 层损坏在预算命令写入前重建（R7：与 runCommand 同一隔离——
    // cancel/close 的 ring 追加不得在坏历史上崩溃）。
    if (draftHealth.ringDegraded !== null) resetTreasuryCoreRingLayer(draft);
    const result = applyTreasuryCoreStateCommand(draft, command, { nowTick });
    if (result.status === "rejected") return { applied: false, used };
    // 预算记账从持久现读取 max（R6：重入/多实例可能已推高持久值，本地
    // used 不得把已消耗份额写回）。
    const effectiveUsed = Math.max(used, readBudgetState(draftHealth.memory, nowTick));
    draft.recovery = { sweepCursor: cursors.sweepCursor, cleanupCursor: cursors.cleanupCursor, budgetTick: nowTick, budgetUsed: effectiveUsed + 1 };
    const write = writeTreasuryCoreMemory((root) => {
      Object.assign(root, draft);
    }, () => undefined);
    if (write.status === "failed") return { applied: false, used: effectiveUsed };
    for (const effect of result.effects) ports.onEffect?.(effect);
    return { applied: true, used: effectiveUsed + 1 };
  }

  /**
   * 端口调用前的预算预扣（R6/§7.1）：持久发布 budgetUsed=used+1。
   * 返回 null（预扣失败——不得调用端口）或预扣后的 used 值。
   */
  function prepayReleaseBudget(
    cursors: { sweepCursor: number; cleanupCursor: number },
  ): number | null {
    const nowTick = ports.nowTick();
    const health = readTreasuryCoreStoreHealth();
    if (health.status !== "healthy") return null;
    const usedNow = readBudgetState(health.memory, nowTick);
    if (usedNow >= TREASURY_CORE_RECOVERY_BUDGET_PER_TICK) return null;
    const write = writeTreasuryCoreMemory((root) => {
      root.recovery = {
        sweepCursor: cursors.sweepCursor,
        cleanupCursor: cursors.cleanupCursor,
        budgetTick: nowTick,
        budgetUsed: usedNow + 1,
      };
    }, () => undefined);
    if (write.status === "failed") return null;
    return usedNow + 1;
  }

  function beginTick(): { recovered: number; closed: number; cleaned: number; cancelled: number } {
    let recovered = 0;
    let closed = 0;
    let cleaned = 0;
    let cancelled = 0;
    const health = readTreasuryCoreStoreHealth();
    // ring 层损坏（ringDegraded）不阻断恢复/收尾（R10）——只有安全层
    // unhealthy/incompatible 或旧业务数据存在才整体阻断。
    if (health.status !== "healthy") return { recovered, closed, cleaned, cancelled };
    if (legacyNow().length > 0) return { recovered, closed, cleaned, cancelled };
    const nowTick = ports.nowTick();
    const cursors = { sweepCursor: health.memory.recovery.sweepCursor, cleanupCursor: health.memory.recovery.cleanupCursor };
    let used = readBudgetState(health.memory, nowTick);

    // 1) dispatching 残留 → 保守 unknown（可能已进入；不重发）。子预算 ≤2。
    let dispatchingSpent = 0;
    for (const record of sortedActive(health.memory)) {
      if (dispatchingSpent >= TREASURY_CORE_SUBBUDGET_DISPATCHING) break;
      if (used >= TREASURY_CORE_RECOVERY_BUDGET_PER_TICK) break;
      if (record.phase !== "dispatching") continue;
      const step = applyBudgetedCommand(used, { type: "recover_dispatching", attemptId: record.attemptId }, cursors);
      used = step.used;
      dispatchingSpent += 1;
      if (step.applied) recovered += 1;
    }

    // 2) 跨 tick 失效 pending 的安全取消（§6.1）。子预算 ≤3。
    const afterRecover = readTreasuryCoreStoreHealth();
    if (afterRecover.status === "healthy") {
      const pendings = sortedActive(afterRecover.memory).filter((r) => r.phase === "pending" && r.admittedAtTick < nowTick);
      if (pendings.length > 0) {
        const start = cursors.sweepCursor % pendings.length;
        let visited = 0;
        while (visited < pendings.length && used < TREASURY_CORE_RECOVERY_BUDGET_PER_TICK) {
          if (used >= TREASURY_CORE_SUBBUDGET_DISPATCHING + TREASURY_CORE_SUBBUDGET_SWEEP) break;
          const record = pendings[(start + visited) % pendings.length];
          visited += 1;
          cursors.sweepCursor = (cursors.sweepCursor + 1) % pendings.length;
          const step = applyBudgetedCommand(used, { type: "cancel_pending", attemptId: record.attemptId }, cursors);
          used = step.used;
          if (step.applied) cancelled += 1;
        }
      } else {
        cursors.sweepCursor = 0;
      }
    }

    // 3) retry 权利期限关闭。子预算 ≤1。
    const afterSweep = readTreasuryCoreStoreHealth();
    if (afterSweep.status === "healthy") {
      let retryCloses = 0;
      for (const record of sortedActive(afterSweep.memory)) {
        if (retryCloses >= TREASURY_CORE_SUBBUDGET_RETRY_CLOSE) break;
        if (used >= TREASURY_CORE_RECOVERY_BUDGET_PER_TICK) break;
        if (record.phase !== "retry_ready") continue;
        if (record.retryDeadlineTick !== null && nowTick > record.retryDeadlineTick) {
          const step = applyBudgetedCommand(used, { type: "close", attemptId: record.attemptId, reason: "retry_expired" }, cursors);
          used = step.used;
          retryCloses += 1;
          if (step.applied) closed += 1;
        }
      }
    }

    // 4) closing 清理公平推进（游标轮转；清理保底 ≥2：前面最多消耗 6）。
    //    每次外部端口调用前先持久预扣预算（R6）。
    const afterCloses = readTreasuryCoreStoreHealth();
    if (afterCloses.status === "healthy") {
      const closings = sortedActive(afterCloses.memory).filter((r) => r.phase === "closing");
      if (closings.length > 0) {
        const start = cursors.cleanupCursor % closings.length;
        let visited = 0;
        while (visited < closings.length && used < TREASURY_CORE_RECOVERY_BUDGET_PER_TICK) {
          const record = closings[(start + visited) % closings.length];
          visited += 1;
          cursors.cleanupCursor = (cursors.cleanupCursor + 1) % closings.length;
          if (record.cleanup.consumerKeys.length === 0) {
            const step = applyBudgetedCommand(used, { type: "advance_cleanup", attemptId: record.attemptId, releasedDuties: [] }, cursors);
            used = step.used;
            if (step.applied) cleaned += 1;
            continue;
          }
          // 逐消费者幂等释放：端口调用前预扣预算（预扣失败即停）。
          const releasePort = ports.releaseExternalConsumer;
          if (releasePort === undefined) {
            // 端口缺失：不默认成功——保留义务并记录失败计数（有界诊断）。
            const step = applyBudgetedCommand(used, { type: "advance_cleanup", attemptId: record.attemptId, releasedDuties: [] }, cursors);
            used = step.used;
            if (step.applied) cleaned += 1;
            continue;
          }
          const released: string[] = [];
          let portFaulted = false;
          let budgetPrepayFailed = false;
          for (const consumerKey of record.cleanup.consumerKeys) {
            // 预扣从持久现读（重入/多实例后的单一权威；R6）。
            const prepaid = prepayReleaseBudget(cursors);
            if (prepaid === null) {
              budgetPrepayFailed = true;
              break;
            }
            used = prepaid;
            let ok: boolean;
            try {
              ok = releasePort(consumerKey, record.attemptId);
            } catch {
              // 端口抛错：该 duty 保留（不崩 tick、不默认成功）；预算已耗。
              portFaulted = true;
              ok = false;
            }
            if (ok) released.push(consumerKey);
          }
          if (budgetPrepayFailed && released.length === 0) {
            // 预算耗尽/预扣失败：本条记录本 tick 不再推进（duty 保留）。
            continue;
          }
          if (released.length === 0 && !portFaulted && !budgetPrepayFailed) {
            // 端口明确未确认（false）：推进失败计数（诊断），duty 保留。
            const step = applyBudgetedCommand(used, { type: "advance_cleanup", attemptId: record.attemptId, releasedDuties: [] }, cursors);
            used = step.used;
            if (step.applied) cleaned += 1;
            continue;
          }
          // 释放未确认的消费者义务保留（不因端口失败谎报完成）；确认写回
          // 失败时下次以同一幂等关联重试（§5.2）。
          const step = applyBudgetedCommand(used, { type: "advance_cleanup", attemptId: record.attemptId, releasedDuties: released }, cursors);
          used = step.used;
          if (step.applied) cleaned += 1;
        }
      } else {
        cursors.cleanupCursor = 0;
      }
    }

    // 5) lifecycle 标记 + 游标/预算终态持久化（终态预算 = 持久记账现值）。
    const finalUsed = Math.max(used, currentBudgetUsed(nowTick));
    writeTreasuryCoreMemory((root) => {
      root.lifecycle.lastBeginTick = nowTick;
      root.recovery = { ...cursors, budgetTick: nowTick, budgetUsed: finalUsed };
    }, () => undefined);
    return { recovered, closed, cleaned, cancelled };
  }

  function endTick(): { recoveredToUnknown: number } {
    let recoveredToUnknown = 0;
    const health = readTreasuryCoreStoreHealth();
    if (health.status === "healthy" && legacyNow().length === 0) {
      const nowTick = ports.nowTick();
      let used = readBudgetState(health.memory, nowTick);
      const cursors = { sweepCursor: health.memory.recovery.sweepCursor, cleanupCursor: health.memory.recovery.cleanupCursor };
      // dispatching 残留（当次调用异常逃逸）→ 保守 unknown（共享同 tick 预算）。
      for (const record of sortedActive(health.memory)) {
        if (used >= TREASURY_CORE_RECOVERY_BUDGET_PER_TICK) break;
        if (record.phase !== "dispatching") continue;
        const step = applyBudgetedCommand(used, { type: "recover_dispatching", attemptId: record.attemptId }, cursors);
        used = step.used;
        if (step.applied) recoveredToUnknown += 1;
      }
      writeTreasuryCoreMemory((root) => {
        root.lifecycle.lastEndTick = ports.nowTick();
        root.recovery = { ...cursors, budgetTick: nowTick, budgetUsed: used };
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
      recovery: { sweepCursor: 0, cleanupCursor: 0, budgetTick: 0, budgetUsed: 0 },
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
      // R7：ring 非数组（healthy + ringDegraded 可达）不得使 metrics 崩溃。
      ringCount: Array.isArray(memory.ring) ? memory.ring.length : 0,
      frontier: memory.issuance.frontier,
      burned: memory.issuance.burned,
      // 深快照：不泄漏底层持久 counters 引用（R06/B22）。
      counters: { ...memory.counters },
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
    cancelPending,
    closeWork,
    beginTick,
    endTick,
  };
}

/** 命令草稿副本（commands 在副本上转移；写入用 writeTreasuryCoreMemory 再 clone）。 */
function cloneForCommand(memory: TreasuryCoreMemory): TreasuryCoreMemory {
  return cloneTreasuryDurableValue(memory);
}
