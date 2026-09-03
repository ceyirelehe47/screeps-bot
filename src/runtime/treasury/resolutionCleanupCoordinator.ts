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
  type TreasuryCleanupAckIdentity,
} from "@/runtime/treasury/cleanupStageAcknowledgement";
import { acknowledgeTreasuryCleanupSettlementProof } from "@/runtime/treasury/settlementProofActivation";
import { readTreasuryTrustedSettlementProofForAttempt } from "@/runtime/treasury/trustedSettlementProof";
import {
  treasuryExactAttemptIdentityOfFacts,
  type TreasuryExactAttemptIdentity,
} from "@/runtime/treasury/exactAttemptIdentity";
function expectedIdentityOfEntry(entry: Readonly<TreasuryResolutionCleanupEntry>): TreasuryExactAttemptIdentity | null {
  return treasuryExactAttemptIdentityOfFacts(
    entry.transactionId,
    {
      digest: entry.digest,
      ...(entry.contractDigest !== undefined ? { contractDigest: entry.contractDigest } : {}),
      ...(entry.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: entry.authorizationCohortDigest } : {}),
      ...(entry.durableIdentityDigest !== undefined ? { durableIdentityDigest: entry.durableIdentityDigest } : {}),
      ...(entry.lowlevelSource !== undefined ? { lowlevelSource: entry.lowlevelSource } : {}),
      ...(entry.lineageId !== undefined ? { lineageId: entry.lineageId } : {}),
      ...(entry.lineageGeneration !== undefined ? { lineageGeneration: entry.lineageGeneration } : {}),
      ...(entry.parentTransactionId !== undefined ? { parentTransactionId: entry.parentTransactionId } : {}),
      ...(entry.lineageBindingDigest !== undefined ? { lineageBindingDigest: entry.lineageBindingDigest } : {}),
    },
    entry.proofClass === "lowlevel" ? "lowlevel" : entry.proofClass === "identity-bound" ? "identity-bound" : "legacy",
  );
}

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
  readonly status: "completed" | "pending" | "absent" | "store_unhealthy";
  readonly pendingStage: TreasuryCleanupPendingStage;
  readonly detail: string;
  readonly phases: TreasuryCleanupPhases;
  /** marker ack 已执行时的全局 write admission 锁事实（未执行 = unknown）。 */
  readonly globalWriteAdmissionStillLocked: boolean;
  readonly globalWriteAdmissionLockedKnown: boolean;
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
): TreasuryCleanupAdvanceResult {
  return {
    status,
    pendingStage,
    detail,
    phases: phasesOfEntry(entry, journalEntryAbsent),
    globalWriteAdmissionStillLocked: false,
    globalWriteAdmissionLockedKnown: false,
  };
}

/**
 * 推进单个 attempt 的全部 cleanup 阶段（幂等——任意阶段已持久确认时
 * 复验外部事实后继续）。任一阶段未确认即停止并返回结构化 pending。
 */
export function advanceTreasuryResolutionCleanupPhases(input: {
  readonly transactionId: string;
  readonly expected?: TreasuryCleanupAckIdentity;
}): TreasuryCleanupAdvanceResult {
  const journalEntryAbsent = readBackTreasuryResolutionCleanupEntryFromMemory(input.transactionId).status === "absent";
  const entry = readTreasuryResolutionCleanupEntry(input.transactionId);
  if (entry === undefined) {
    // store 健康但 entry 不存在：advance 的调用方都在 open admission 成功
    // 之后进入——entry 缺失即已完成删除（幂等 completed：journal 删除
    // read-back 即完全完成的事实）。store 不健康（fatal 与 absent 同形
    // 折叠）→ store_unhealthy fail closed。
    if (journalEntryAbsent) {
      return {
        status: "completed",
        pendingStage: "none",
        detail: "cleanup entry 不存在且 store 健康（幂等——journal 删除已 read-back 确认）",
        phases: phasesOfEntry(undefined, true),
        globalWriteAdmissionStillLocked: false,
        globalWriteAdmissionLockedKnown: false,
      };
    }
    return pendingResult("none", "cleanup entry 读取失败（store unhealthy）", undefined, false, "store_unhealthy");
  }
  let globalLocked = false;
  let globalLockedKnown = false;
  // 阶段 0：proof activation（reservation → durable）。
  if (!entry.settlementProofDurable) {
    const activation = acknowledgeTreasuryCleanupSettlementProof({ transactionId: input.transactionId });
    if (activation.outcome !== "activated" && activation.outcome !== "already_activated") {
      return pendingResult("proof_activation", `settlement proof activation ${activation.outcome}: ${activation.detail}`, entry, false);
    }
  }
  // 阶段 0.5【九.1】：committed 的 marker discharge 是第一个 destructive
  // 动作——之前必须确认 release-trusted Receipt 成立（store 任一无关 entry
  // 损坏 / identity conflict / legacy 不足时不清 marker、不释放、不推进）。
  // not-executed 的 release 证据（final tombstone）已由 activation 验证。
  if (entry.resolution === "committed") {
    const markerExpected = expectedIdentityOfEntry(entry);
    if (markerExpected === null) {
      return pendingResult("marker_discharge", "committed entry 身份无法构造 exact identity（trusted 前置拒绝）", entry, false);
    }
    const markerTrusted = readTreasuryTrustedSettlementProofForAttempt(input.transactionId, markerExpected);
    if (
      markerTrusted.status === "store_unhealthy" ||
      markerTrusted.status === "identity_conflict" ||
      markerTrusted.status === "legacy_insufficient"
    ) {
      // 九.1：无关 entry 损坏 / identity 冲突 / legacy 不足时零 marker
      // discharge。absent 不阻断（receipt 尚未刷新的恢复窗口——
      // authority 阶段的 trusted 验证会在缺席时阻断）。
      return pendingResult(
        "marker_discharge",
        `committed trusted receipt ${markerTrusted.status}: ${markerTrusted.detail}（marker 不清除——零 destructive）`,
        entry,
        false,
      );
    }
  }
  // 阶段 1：marker discharge（含 discharge 自身 read-back + 阶段 read-back）。
  const marker = acknowledgeTreasuryCleanupMarkerDischarge({ transactionId: input.transactionId, expected: input.expected });
  if (marker.outcome !== "acknowledged" && marker.outcome !== "already_acknowledged") {
    const result = pendingResult("marker_discharge", `marker discharge ack ${marker.outcome}: ${marker.detail}`, entry, false);
    return marker.globalWriteAdmissionStillLocked !== undefined
      ? { ...result, globalWriteAdmissionStillLocked: marker.globalWriteAdmissionStillLocked, globalWriteAdmissionLockedKnown: true }
      : result;
  }
  globalLocked = marker.globalWriteAdmissionStillLocked ?? false;
  globalLockedKnown = marker.globalWriteAdmissionStillLocked !== undefined;
  // 阶段 2：authority release（resolver read-back not_found 硬门禁）。
  const authority = acknowledgeTreasuryCleanupAuthorityRelease({ transactionId: input.transactionId, expected: input.expected });
  if (authority.outcome !== "acknowledged" && authority.outcome !== "already_acknowledged") {
    const result = pendingResult("authority_release", `authority release ack ${authority.outcome}: ${authority.detail}`, entry, false);
    return { ...result, globalWriteAdmissionStillLocked: globalLocked, globalWriteAdmissionLockedKnown: globalLockedKnown };
  }
  // 阶段 3：outcome finalization（trusted proof + 相反 proof 门禁——装配
  // handler 承载）。
  const outcome = acknowledgeTreasuryCleanupOutcomeFinalization({ transactionId: input.transactionId, expected: input.expected });
  if (outcome.outcome !== "acknowledged" && outcome.outcome !== "already_acknowledged") {
    const result = pendingResult("outcome_finalization", `outcome finalization ack ${outcome.outcome}: ${outcome.detail}`, entry, false);
    return { ...result, globalWriteAdmissionStillLocked: globalLocked, globalWriteAdmissionLockedKnown: globalLockedKnown };
  }
  // 阶段 4：lineage finalization（initial attempt 经 not_applicable 同一
  // 结构化接口完成）。
  const lineage = acknowledgeTreasuryCleanupLineageFinalization({ transactionId: input.transactionId, expected: input.expected });
  if (lineage.outcome !== "acknowledged" && lineage.outcome !== "already_acknowledged") {
    const result = pendingResult("lineage_finalization", `lineage finalization ack ${lineage.outcome}: ${lineage.detail}`, entry, false);
    return { ...result, globalWriteAdmissionStillLocked: globalLocked, globalWriteAdmissionLockedKnown: globalLockedKnown };
  }
  // 阶段 5：journal completion（删除 + read-back absent 才是完全完成）。
  const completion = completeTreasuryCleanupAcknowledged(input.transactionId);
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
  | "journal_completion_pending";

export interface TreasuryCleanupStatusReport {
  readonly settlement: "committed" | "not-executed";
  readonly stage: TreasuryCleanupProgressStage;
  /** 全局 write admission 是否仍被（其它 attempt 的）marker 锁定。 */
  readonly globalWriteAdmissionStillLocked: boolean;
}

/** advance 结果 → API 完成状态报告（pendingStage 与 stage 一一映射）。 */
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
  return {
    settlement,
    stage: advance.status === "completed" ? "fully_complete" : stageOf[advance.pendingStage],
    globalWriteAdmissionStillLocked: advance.globalWriteAdmissionStillLocked,
  };
}
