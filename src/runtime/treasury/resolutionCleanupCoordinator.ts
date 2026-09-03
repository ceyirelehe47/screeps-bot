/**
 * 【Round 22 Remediation III 八】resolution cleanup coordinator——cleanup
 * 阶段推进的唯一 destructive owner。
 *
 * Remediation III 之前 immediate resolution（faultResolution /
 * resolutionAuthority / facade executed-aborted）、staged recovery
 * （recoverStagedResolutions）与 cleanup journal recovery 三条路径各自
 * 组合 discharge → release → finalize → lineage close → complete，部分
 * 调用点选择性忽略 boolean——同一 destructive 阶段存在多个并行实现。
 *
 * 本模块收敛为单一 advance 接口：
 *  settlement proof activation ack
 *  → marker discharge ack
 *  → authority release ack
 *  → outcome finalization ack
 *  → lineage finalization ack
 *  → journal completion ack（删除 + read-back absent）
 *
 * 每步都是 durable acknowledgement（cleanupStageAcknowledgement 协议：
 * 写入 + Memory read-back + 结构化结果）；前一步未持久确认时不得执行下一
 * 步 destructive action。immediate 路径（同一调用栈）与 beginTick 恢复
 * （journal recovery driver）都只经本函数推进——不存在第二套顺序。
 *
 * advance 不承载 settlement 动作本身（receipt 刷新 / resolving 或 final
 * tombstone 写入 / lineage publication 由调用方在各自上下文完成——它们
 * 有 capability / reconciler 语义）；advance 从"settlement proof 已持久"
 * 的 journal entry 出发完成全部 cleanup 阶段。
 */

import {
  readBackTreasuryResolutionCleanupEntryFromMemory,
  readTreasuryResolutionCleanupEntry,
  registerTreasuryResolutionCleanupRecoveryDriverForAssembly,
  type TreasuryResolutionCleanupEntry,
} from "@/runtime/treasury/resolutionCleanupJournal";
import {
  acknowledgeTreasuryCleanupMarkerDischarge,
  acknowledgeTreasuryCleanupAuthorityRelease,
  acknowledgeTreasuryCleanupOutcomeFinalization,
  acknowledgeTreasuryCleanupLineageFinalization,
  completeTreasuryCleanupAcknowledged,
} from "@/runtime/treasury/cleanupStageAcknowledgement";
import { acknowledgeTreasuryCleanupSettlementProof } from "@/runtime/treasury/settlementProofActivation";
import { gateTreasuryPreReleaseSettlement } from "@/runtime/treasury/preReleaseSettlementGate";
import { lookupTreasuryCleanupCompletion, peekTreasuryCleanupCompletionHealth } from "@/runtime/treasury/cleanupCompletionAuthority";
import { lookupTreasuryHistoricalCompletion } from "@/runtime/treasury/cleanupSupersessionAuthority";

export type TreasuryCleanupPendingStage =
  | "proof_activation"
  | "marker_discharge"
  | "authority_release"
  | "outcome_finalization"
  | "lineage_finalization"
  | "journal_completion"
  | "none";

/** cleanup 进度的持久事实快照（与 journal entry read-back 一致）。 */
export interface TreasuryCleanupPhases {
  readonly settlementProofDurable: boolean;
  readonly markerDischarged: boolean;
  readonly authorityReleased: boolean;
  readonly outcomeFinalized: boolean;
  readonly lineageFinalized: boolean;
  readonly journalEntryAbsent: boolean;
}

export interface TreasuryCleanupAdvanceResult {
  readonly status:
    | "completed"
    | "pending"
    | "absent"
    | "store_unhealthy"
    /** 【Remediation V 四】journal absent 且无任何完成权威（completion/replacement 均不成立）——明确未证明状态，不得映射为 fully_complete。 */
    | "no_cleanup_authority"
    /** 【Remediation V 四】journal absent 且 completion/replacement authority 身份冲突——结构化 fail closed。 */
    | "completion_conflict";
  readonly pendingStage: TreasuryCleanupPendingStage;
  readonly detail: string;
  readonly phases: TreasuryCleanupPhases;
  /** marker ack 已执行时的全局 write admission 锁事实（未执行 = unknown）。 */
  readonly globalWriteAdmissionStillLocked: boolean;
  readonly globalWriteAdmissionLockedKnown: boolean;
  /**
   * 【Remediation VI 4.4】authoritative settlement outcome——completed 时
   * 必有（来自 completion proof / durable historical authority / journal
   * entry 的持久权威）；pending 时为 journal entry 的 settlement（若有）。
   * 公共 cleanup status 的 settlement 标签必须与该权威一致（不一致 =
   * outcome relabel → cleanup_conflict，不得 fully_complete）。
   */
  readonly settlementOutcome?: "committed" | "not-executed";
}

/**
 * 【Remediation V 四】无 journal entry 时的 phases 语义：只有 completion
 * authority（或 replacement authority）已验证成立才能表达"全阶段完成"；
 * 无权威时全部阶段为未证明（false）——不得把五个阶段伪造成 true。
 */
function unprovenPhases(journalEntryAbsent: boolean): TreasuryCleanupPhases {
  return {
    settlementProofDurable: false,
    markerDischarged: false,
    authorityReleased: false,
    outcomeFinalized: false,
    lineageFinalized: false,
    journalEntryAbsent,
  };
}

function phasesOfEntry(entry: Readonly<TreasuryResolutionCleanupEntry> | undefined, journalEntryAbsent: boolean): TreasuryCleanupPhases {
  if (entry === undefined) {
    return {
      settlementProofDurable: true,
      markerDischarged: true,
      authorityReleased: true,
      outcomeFinalized: true,
      lineageFinalized: true,
      journalEntryAbsent,
    };
  }
  return {
    settlementProofDurable: entry.settlementProofDurable,
    markerDischarged: entry.markerDischarged,
    authorityReleased: entry.authorityReleased,
    outcomeFinalized: entry.outcomeFinalized,
    lineageFinalized: entry.lineageFinalized,
    journalEntryAbsent,
  };
}

function pendingResult(
  pendingStage: TreasuryCleanupPendingStage,
  detail: string,
  entry: Readonly<TreasuryResolutionCleanupEntry> | undefined,
  journalEntryAbsent: boolean,
  status: TreasuryCleanupAdvanceResult["status"] = "pending",
  /** 【Remediation V 四】无权威时 phases 表达未证明（不得伪造成 true）。 */
  unproven = false,
): TreasuryCleanupAdvanceResult {
  return {
    status,
    pendingStage,
    detail,
    phases: unproven ? unprovenPhases(journalEntryAbsent) : phasesOfEntry(entry, journalEntryAbsent),
    globalWriteAdmissionStillLocked: false,
    globalWriteAdmissionLockedKnown: false,
    // 【Remediation VI 4.4】pending/未证明结果的 settlement 来自 journal
    // entry 的持久权威（无 entry = 未证明，不带标签）。
    ...(entry !== undefined ? { settlementOutcome: entry.resolution } : {}),
  };
}

/**
 * 推进单个 attempt 的全部 cleanup 阶段（幂等——任意阶段已持久确认时
 * 复验外部事实后继续）。任一阶段未确认即停止并返回结构化 pending。
 *
 * 【Remediation IV 十一.4】不再接受调用方 expected——journal entry 是唯一
 * expected 来源；【六/七】marker discharge 之前先经 pre-release gate
 * （journal ↔ target proof ↔ opposite proof ↔ semantic lineage ↔ authority
 * 全 exact 验证——opposite proof 检查前移至任何 destructive 动作之前）。
 */
export function advanceTreasuryResolutionCleanupPhases(input: {
  readonly transactionId: string;
  readonly expectedIdentity?: import("@/runtime/treasury/exactAttemptIdentity").TreasuryExactAttemptIdentity;
  /** 【Remediation VI 4.4】期望 settlement outcome（提供时与持久权威比较——不一致 → completion_conflict，不得 relabel）。 */
  readonly expectedOutcome?: "committed" | "not-executed";
}): TreasuryCleanupAdvanceResult {
  const journalEntryAbsent = readBackTreasuryResolutionCleanupEntryFromMemory(input.transactionId).status === "absent";
  const entry = readTreasuryResolutionCleanupEntry(input.transactionId);
  if (entry === undefined) {
    // store 健康但 entry 不存在：【Remediation IV 十.3】journal absent 不再
    // 自动等于完成——matching completion authority 才能证明合法完成；absent
    // → no_cleanup_authority（fail closed）；冲突 → 阻断。
    // 【Remediation VI 4.2/4.3】完成事实的持久权威链 = completion proof →
    // durable historical authority（GRA / terminal summary / final
    // tombstone 只是 archive 前的 replacement 事实，不再单独证明 cleanup
    // completed——tombstone retention 到期 / GRA 生命周期回收后完成事实
    // 仍由 historical authority 存续）。
    if (journalEntryAbsent) {
      const completionHealth = peekTreasuryCleanupCompletionHealth();
      if (!completionHealth.healthy) {
        return pendingResult(
          "none",
          `completion authority store unhealthy: ${completionHealth.detail}`,
          undefined,
          false,
          "store_unhealthy",
          true,
        );
      }
      const completion = lookupTreasuryCleanupCompletion(input.transactionId, input.expectedIdentity, input.expectedOutcome);
      if (completion.verdict === "match") {
        return {
          status: "completed",
          pendingStage: "none",
          detail: "cleanup entry 不存在且 matching completion authority 存在（幂等——journal 删除已由 completion 证明）",
          phases: phasesOfEntry(undefined, true),
          globalWriteAdmissionStillLocked: completion.proof.globalWriteAdmissionStillLocked,
          globalWriteAdmissionLockedKnown: true,
          settlementOutcome: completion.proof.resolution,
        };
      }
      if (completion.verdict === "conflict") {
        return pendingResult(
          "none",
          `completion authority conflict: ${completion.detail}`,
          undefined,
          false,
          "completion_conflict",
          true,
        );
      }
      if (completion.verdict === "store_unhealthy") {
        return pendingResult("none", `completion authority ${completion.verdict}: ${completion.detail}`, undefined, false, "store_unhealthy", true);
      }
      // completion absent：durable historical authority（被安全回收的
      // completion 的持久交接权威——outcome + exact identity 绑定）。
      const historical = lookupTreasuryHistoricalCompletion(input.transactionId, input.expectedIdentity, input.expectedOutcome);
      if (historical.verdict === "match") {
        return {
          status: "completed",
          pendingStage: "none",
          detail: `cleanup entry 与 completion 均不存在，但 durable historical authority 持续证明完成（outcome=${historical.record.resolution}——跨 GRA/tombstone 回收存续）`,
          phases: phasesOfEntry(undefined, true),
          globalWriteAdmissionStillLocked: false,
          globalWriteAdmissionLockedKnown: false,
          settlementOutcome: historical.record.resolution,
        };
      }
      if (historical.verdict === "conflict") {
        return pendingResult(
          "none",
          `historical completion authority conflict: ${historical.detail}`,
          undefined,
          false,
          "completion_conflict",
          true,
        );
      }
      if (historical.verdict === "store_unhealthy") {
        return pendingResult("none", `historical authority store unhealthy: ${historical.detail}`, undefined, false, "store_unhealthy", true);
      }
      // final committed tombstone 单独存在不证明 cleanup 完成（T5）：它只
      // 证明 settlement outcome，不证明 marker discharge / authority release /
      // outcome finalize / lineage final / completion 曾合法存在。
      return pendingResult(
        "none",
        "no_cleanup_authority：journal entry 不存在且无 completion / durable historical authority（GRA/tombstone 单独存在不证明 cleanup 完成——完成未证明，不得视为已完成）",
        undefined,
        true,
        "no_cleanup_authority",
        true,
      );
    }
    return pendingResult("none", "cleanup entry 读取失败（store unhealthy）", undefined, false, "store_unhealthy");
  }
  let globalLocked = false;
  let globalLockedKnown = false;
  let lineageDisposition: "final" | "not_applicable" = "final";
  // 阶段 0：proof activation（reservation → durable）。
  if (!entry.settlementProofDurable) {
    const activation = acknowledgeTreasuryCleanupSettlementProof({ transactionId: input.transactionId });
    if (activation.outcome !== "activated" && activation.outcome !== "already_activated") {
      return pendingResult("proof_activation", `settlement proof activation ${activation.outcome}: ${activation.detail}`, entry, false);
    }
  }
  // 阶段 0.5【Remediation IV 六】：pre-release settlement gate——marker
  // discharge 是第一个 destructive 动作，之前必须确认 journal exact
  // identity ↔ target settlement proof exact identity ↔ opposite proof
  // 确证 absent ↔ semantic lineage purpose ↔ 当前 unresolved Authority
  // exact identity 全部成立（authority exact 验证与 opposite proof 检查
  // 从 outcome 阶段前移；同 transaction ID 的身份冲突 Authority 不得进入
  // marker 阶段）。verified / authority_absent_recoverable（marker 已 ack
  // 的合法中断窗口）才继续；其余结构化结果零 destructive 推进。
  const gate = gateTreasuryPreReleaseSettlement(entry);
  if (gate.status !== "verified" && gate.status !== "authority_absent_recoverable") {
    return pendingResult(
      "marker_discharge",
      `pre-release gate ${gate.status}: ${gate.detail}（marker 不清除、Authority 不释放——零 destructive）`,
      entry,
      false,
    );
  }
  // 阶段 1：marker discharge（含 discharge 自身 read-back + 阶段 read-back）。
  const marker = acknowledgeTreasuryCleanupMarkerDischarge({ transactionId: input.transactionId });
  if (marker.outcome !== "acknowledged" && marker.outcome !== "already_acknowledged") {
    const result = pendingResult("marker_discharge", `marker discharge ack ${marker.outcome}: ${marker.detail}`, entry, false);
    return marker.globalWriteAdmissionStillLocked !== undefined
      ? { ...result, globalWriteAdmissionStillLocked: marker.globalWriteAdmissionStillLocked, globalWriteAdmissionLockedKnown: true }
      : result;
  }
  globalLocked = marker.globalWriteAdmissionStillLocked ?? false;
  globalLockedKnown = marker.globalWriteAdmissionStillLocked !== undefined;
  // 阶段 2：authority release（pre-release gate verified discharge——resolver
  // read-back not_found 硬门禁）。
  const authority = acknowledgeTreasuryCleanupAuthorityRelease({ transactionId: input.transactionId });
  if (authority.outcome !== "acknowledged" && authority.outcome !== "already_acknowledged") {
    const result = pendingResult("authority_release", `authority release ack ${authority.outcome}: ${authority.detail}`, entry, false);
    return { ...result, globalWriteAdmissionStillLocked: globalLocked, globalWriteAdmissionLockedKnown: globalLockedKnown };
  }
  // 阶段 3：outcome finalization（trusted proof + 相反 proof 门禁——装配
  // handler 承载）。
  const outcome = acknowledgeTreasuryCleanupOutcomeFinalization({ transactionId: input.transactionId });
  if (outcome.outcome !== "acknowledged" && outcome.outcome !== "already_acknowledged") {
    const result = pendingResult("outcome_finalization", `outcome finalization ack ${outcome.outcome}: ${outcome.detail}`, entry, false);
    return { ...result, globalWriteAdmissionStillLocked: globalLocked, globalWriteAdmissionLockedKnown: globalLockedKnown };
  }
  // 阶段 4：lineage finalization（initial attempt 经 not_applicable 同一
  // 结构化接口完成——完成语义由 completion authority 持久化区分）。
  const lineage = acknowledgeTreasuryCleanupLineageFinalization({ transactionId: input.transactionId });
  if (lineage.outcome !== "acknowledged" && lineage.outcome !== "already_acknowledged") {
    const result = pendingResult("lineage_finalization", `lineage finalization ack ${lineage.outcome}: ${lineage.detail}`, entry, false);
    return { ...result, globalWriteAdmissionStillLocked: globalLocked, globalWriteAdmissionLockedKnown: globalLockedKnown };
  }
  if (lineage.lineageDisposition !== undefined) {
    lineageDisposition = lineage.lineageDisposition;
  }
  // 阶段 5：journal completion（completion proof 先持久化并 read-back，随后
  // 删除 journal + read-back absent 才是完全完成）。
  const completion = completeTreasuryCleanupAcknowledged({
    transactionId: input.transactionId,
    lineageDisposition,
    globalWriteAdmissionStillLocked: globalLocked,
  });
  if (completion.status === "store_unhealthy") {
    const result = pendingResult("journal_completion", completion.detail, entry, false, "store_unhealthy");
    return { ...result, globalWriteAdmissionStillLocked: globalLocked, globalWriteAdmissionLockedKnown: globalLockedKnown };
  }
  if (completion.status !== "completed" && completion.status !== "already_completed") {
    const result = pendingResult("journal_completion", completion.detail, entry, false);
    return { ...result, globalWriteAdmissionStillLocked: globalLocked, globalWriteAdmissionLockedKnown: globalLockedKnown };
  }
  return {
    status: "completed",
    pendingStage: "none",
    detail: `cleanup 全阶段持久确认并完成（${completion.detail}）`,
    phases: phasesOfEntry(undefined, true),
    globalWriteAdmissionStillLocked: globalLocked,
    globalWriteAdmissionLockedKnown: globalLockedKnown,
    settlementOutcome: entry.resolution,
  };
}

/**
 * journal recovery driver 装配（facade 模块加载时调用一次——beginTick 的
 * cleanup journal 恢复经 coordinator 推进，与 immediate 路径同一实现）。
 */
export function assembleTreasuryResolutionCleanupCoordinator(): void {
  registerTreasuryResolutionCleanupRecoveryDriverForAssembly({
    advance: (entry) => advanceTreasuryResolutionCleanupPhases({ transactionId: entry.transactionId }),
  });
}

// ── 【Remediation III 十一】API 完成状态的三层事实报告 ───────────────────────

/** cleanup 进度（settlement 结论已定时，后续阶段的真实持久状态）。 */
export type TreasuryCleanupProgressStage =
  | "fully_complete"
  | "proof_activation_pending"
  | "marker_pending"
  | "authority_pending"
  | "outcome_pending"
  | "lineage_pending"
  | "journal_completion_pending"
  /** 【Remediation V 四】journal absent 且无完成权威——完成未证明（不得折叠为 fully_complete）。 */
  | "no_cleanup_authority"
  /** 【Remediation V 四】completion/replacement authority 身份冲突——fail closed 待人工/恢复处理。 */
  | "cleanup_conflict"
  /** 【Remediation V 四】completion/journal store unhealthy——fail closed。 */
  | "cleanup_store_unhealthy";

export interface TreasuryCleanupStatusReport {
  readonly settlement: "committed" | "not-executed";
  readonly stage: TreasuryCleanupProgressStage;
  /** 全局 write admission 是否仍被（其它 attempt 的）marker 锁定。 */
  readonly globalWriteAdmissionStillLocked: boolean;
}

/**
 * advance 结果 → API 完成状态报告。【Remediation V 四】fully_complete 当且
 * 仅当 advance.status === "completed"（本次完成全部阶段并删除 journal，或
 * journal absent 且 completion/historical authority 已完整验证）；
 * no_cleanup_authority / completion_conflict / store_unhealthy 各自保持结构化
 * 语义——pendingStage 的 none 不再等价于 fully_complete。
 *
 * 【Remediation VI 4.4】settlement 标签不再由调用方独立决定：advance 携带
 * authoritative settlementOutcome（completion / historical authority /
 * journal 的持久权威），调用方标签与其冲突 → cleanup_conflict（outcome
 * relabel 被阻断——不得输出"not-executed + fully_complete"）。
 */
export function treasuryCleanupStatusOfAdvance(
  settlement: "committed" | "not-executed",
  advance: TreasuryCleanupAdvanceResult,
): TreasuryCleanupStatusReport {
  const stageOf: Record<TreasuryCleanupPendingStage, TreasuryCleanupProgressStage> = {
    none: "fully_complete",
    proof_activation: "proof_activation_pending",
    marker_discharge: "marker_pending",
    authority_release: "authority_pending",
    outcome_finalization: "outcome_pending",
    lineage_finalization: "lineage_pending",
    journal_completion: "journal_completion_pending",
  };
  if (advance.settlementOutcome !== undefined && advance.settlementOutcome !== settlement) {
    return {
      settlement,
      stage: "cleanup_conflict",
      globalWriteAdmissionStillLocked: advance.globalWriteAdmissionStillLocked,
    };
  }
  if (advance.status === "no_cleanup_authority") {
    return { settlement, stage: "no_cleanup_authority", globalWriteAdmissionStillLocked: advance.globalWriteAdmissionStillLocked };
  }
  if (advance.status === "completion_conflict") {
    return { settlement, stage: "cleanup_conflict", globalWriteAdmissionStillLocked: advance.globalWriteAdmissionStillLocked };
  }
  if (advance.status === "store_unhealthy") {
    return { settlement, stage: "cleanup_store_unhealthy", globalWriteAdmissionStillLocked: advance.globalWriteAdmissionStillLocked };
  }
  if (advance.status === "absent") {
    return { settlement, stage: "no_cleanup_authority", globalWriteAdmissionStillLocked: advance.globalWriteAdmissionStillLocked };
  }
  return {
    settlement,
    stage: advance.status === "completed" ? "fully_complete" : stageOf[advance.pendingStage],
    globalWriteAdmissionStillLocked: advance.globalWriteAdmissionStillLocked,
  };
}
