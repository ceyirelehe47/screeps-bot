/**
 * 【Round 22 Remediation IV 六/七】pre-release settlement gate——marker
 * discharge 与 Authority release 之前的只读、无副作用统一验证器。
 *
 * Remediation III 的 cleanup 阶段链中，authority release handler 只按
 * transactionId 解析当前 Authority 后直接释放——没有验证当前 unresolved
 * Authority 自身是否属于 journal entry 的同一 exact attempt（Intent/
 * Quarantine/Authorization Fault 与 journal 身份冲突时仍被按 transactionId
 * 删除）；opposite proof 与 semantic lineage 检查也主要发生在 release 之后
 * 的 outcome 阶段（先清 marker、释放 Authority、之后才发现相反结论 proof）。
 *
 * 本 gate 在任何 marker discharge / Authority release 之前执行完整链：
 *
 *   journal exact identity
 *     ↔ target settlement proof exact identity（committed→release-trusted
 *       Receipt / not-executed→final tombstone）
 *     ↔ opposite proof absence（相反结论 match/conflict/insufficient/
 *       store unhealthy 全部阻断——只有确证 absent 才通过）
 *     ↔ semantic lineage purpose（tr1_ 的 committed_settlement /
 *       not_executed_retirement verdict 非 match 即阻断）
 *     ↔ 当前 unresolved Authority exact identity（Intent/Quarantine 经统一
 *       resolver 的完整 authority 视图；Authorization Fault 构造完整 exact
 *       identity——不再只比较 digest）
 *
 * 全部成立才返回 verified / authority_absent_recoverable（合法中断窗口：
 * Authority 已释放、authority 阶段尚未 ack、marker 已 ack 且全部 proof 通过）。
 * 调用方不得把结果折叠成 false 继续执行；每类失败都是结构化阻断。
 *
 * 只进行相关 store 的单 key 查询（O(1)）；无任何写操作。
 */

import {
  treasuryExactAttemptIdentityOfFacts,
  treasuryExactAttemptIdentityOfAuthority,
  treasuryExactAttemptIdentityOfTombstone,
  treasuryExactAttemptIdentityRelation,
  type TreasuryExactAttemptIdentity,
} from "@/runtime/treasury/exactAttemptIdentity";
import { resolveTreasuryUnresolvedAuthority } from "@/runtime/treasury/unresolvedAuthority";
import { readTreasuryAuthorizationFaultEntry } from "@/runtime/treasury/authorizationFaults";
import {
  readTreasuryResolutionTombstone,
  peekTreasuryResolutionStoreHealth,
} from "@/runtime/treasury/resolutionStore";
import { readTreasuryTrustedSettlementProofForAttempt } from "@/runtime/treasury/trustedSettlementProof";
import {
  checkTreasuryOppositeProofsForCommitted,
  checkTreasuryOppositeProofsForNotExecuted,
} from "@/runtime/treasury/oppositeProofMatrix";
import { validateTreasurySemanticLineage } from "@/runtime/treasury/semanticLineageValidation";
import {
  peekTreasuryMarkerDischargeState,
  treasuryMarkerDischargeExpectedOfFacts,
} from "@/runtime/treasury/markerDischarge";
import type { TreasuryResolutionCleanupEntry } from "@/runtime/treasury/resolutionCleanupJournal";

/** journal entry（含 identity 形状）→ exact attempt identity（单一构造口径）。 */
export function treasuryPreReleaseExactIdentityOfEntry(
  entry: Readonly<TreasuryResolutionCleanupEntry>,
): TreasuryExactAttemptIdentity | null {
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

/** Authorization Fault entry → 完整 exact identity（authorityLevel 显式定级——不只比较 digest）。 */
export function treasuryPreReleaseExactIdentityOfAuthorizationFault(
  fault: {
    readonly transactionId: string;
    readonly digest: string;
    readonly authorityLevel: string;
    readonly lowlevelSource?: string;
    readonly contractDigest?: string;
    readonly authorizationCohortDigest?: string;
    readonly durableIdentityDigest?: string;
  },
): TreasuryExactAttemptIdentity | null {
  const proofClass =
    fault.authorityLevel === "lowlevel"
      ? "lowlevel"
      : fault.authorityLevel === "modern" || fault.authorityLevel === "identity-bound"
        ? "identity-bound"
        : "legacy";
  return treasuryExactAttemptIdentityOfFacts(
    fault.transactionId,
    {
      digest: fault.digest,
      ...(fault.contractDigest !== undefined ? { contractDigest: fault.contractDigest } : {}),
      ...(fault.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: fault.authorizationCohortDigest } : {}),
      ...(fault.durableIdentityDigest !== undefined ? { durableIdentityDigest: fault.durableIdentityDigest } : {}),
      ...(proofClass === "lowlevel" && fault.lowlevelSource !== undefined ? { lowlevelSource: fault.lowlevelSource } : {}),
    },
    proofClass,
  );
}

export type TreasuryPreReleaseGateStatus =
  | "verified"
  | "authority_absent_recoverable"
  | "authority_absent_unexpected"
  | "authority_conflict"
  | "authority_insufficient"
  | "authority_inconsistent"
  | "authority_store_unhealthy"
  | "journal_identity_insufficient"
  | "target_proof_absent"
  | "target_proof_conflict"
  | "target_proof_store_unhealthy"
  | "opposite_proof_match"
  | "opposite_proof_conflict"
  | "opposite_proof_insufficient"
  | "opposite_proof_store_unhealthy"
  | "semantic_lineage_blocked";

export interface TreasuryPreReleaseGateResult {
  readonly status: TreasuryPreReleaseGateStatus;
  readonly detail: string;
  readonly journalIdentity?: TreasuryExactAttemptIdentity;
  /** authority 在场时其来源（release 消费——verified 才有效）。 */
  readonly authoritySource?: "intent-quarantine" | "authorization-fault";
}

/**
 * marker discharge / Authority release 前的统一 gate（只读）。短路顺序：
 * journal identity → target settlement proof → opposite proof → semantic
 * lineage purpose → authority exact identity（absent 时按 marker ack 状态
 * 区分 recoverable 与 unexpected）。
 */
export function gateTreasuryPreReleaseSettlement(
  entry: Readonly<TreasuryResolutionCleanupEntry>,
): TreasuryPreReleaseGateResult {
  const journalIdentity = treasuryPreReleaseExactIdentityOfEntry(entry);
  if (journalIdentity === null) {
    return { status: "journal_identity_insufficient", detail: "journal entry 身份无法构造 exact identity（required 维度缺失——不降级）" };
  }
  const result = (status: TreasuryPreReleaseGateStatus, detail: string): TreasuryPreReleaseGateResult => ({
    status,
    detail,
    journalIdentity,
  });

  // ── 1. target settlement proof exact identity。
  if (entry.resolution === "committed") {
    const trusted = readTreasuryTrustedSettlementProofForAttempt(entry.transactionId, journalIdentity);
    if (trusted.status === "absent") {
      return result("target_proof_absent", `committed trusted receipt absent: ${trusted.detail}（release 前必须成立）`);
    }
    if (trusted.status === "identity_conflict" || trusted.status === "legacy_insufficient") {
      return result("target_proof_conflict", `committed trusted receipt ${trusted.status}: ${trusted.detail}（exact identity 不一致——不释放）`);
    }
    if (trusted.status === "store_unhealthy") {
      return result("target_proof_store_unhealthy", `committed receipt store unhealthy: ${trusted.detail}`);
    }
  } else {
    if (!peekTreasuryResolutionStoreHealth().healthy) {
      return result("target_proof_store_unhealthy", "resolution store unhealthy（final not-executed tombstone 不可信）");
    }
    const tombstone = readTreasuryResolutionTombstone(entry.transactionId);
    if (tombstone === undefined) {
      return result("target_proof_absent", "final not-executed tombstone 缺失（release 前必须成立）");
    }
    if (tombstone.stage !== "final" || tombstone.resolution !== "not-executed") {
      return result("target_proof_conflict", `tombstone ${String(tombstone.stage)}/${String(tombstone.resolution)} 非 final not-executed`);
    }
    const tombstoneExact = treasuryExactAttemptIdentityOfTombstone(tombstone);
    if (tombstoneExact === null) {
      return result("target_proof_conflict", "final tombstone 身份无法构造 exact identity（维度不足）");
    }
    const relation = treasuryExactAttemptIdentityRelation(tombstoneExact, journalIdentity);
    if (relation !== "match") {
      return result("target_proof_conflict", `final tombstone 与 journal entry 身份 ${relation}（不释放）`);
    }
  }

  // ── 2. opposite proof gate（前移——marker discharge 之前；只有确证 absent 才通过）。
  const opposite =
    entry.resolution === "committed"
      ? checkTreasuryOppositeProofsForCommitted(entry.transactionId, journalIdentity)
      : checkTreasuryOppositeProofsForNotExecuted(entry.transactionId, journalIdentity);
  if (!opposite.clear) {
    const blocker = opposite.blockers[0]!;
    const status =
      blocker.classification === "exact_match"
        ? "opposite_proof_match"
        : blocker.classification === "identity_conflict"
          ? "opposite_proof_conflict"
          : blocker.classification === "insufficient"
            ? "opposite_proof_insufficient"
            : "opposite_proof_store_unhealthy";
    return result(status, `相反 proof 阻断（${blocker.source}/${blocker.classification}）: ${blocker.detail}（marker discharge 之前）`);
  }

  // ── 3. semantic lineage purpose（tr1_ entry——release 前确认；非 tr1_ 无 lineage 协议要求）。
  if (entry.lineageId !== undefined) {
    const semantic = validateTreasurySemanticLineage({
      transactionId: entry.transactionId,
      purpose: entry.resolution === "committed" ? "committed_settlement" : "not_executed_retirement",
      proof: {
        lineageId: entry.lineageId,
        lineageGeneration: entry.lineageGeneration!,
        parentTransactionId: entry.parentTransactionId!,
        lineageBindingDigest: entry.lineageBindingDigest!,
      },
      identity: {
        digest: entry.digest,
        ...(entry.contractDigest !== undefined ? { contractDigest: entry.contractDigest } : {}),
        ...(entry.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: entry.authorizationCohortDigest } : {}),
        ...(entry.durableIdentityDigest !== undefined ? { durableIdentityDigest: entry.durableIdentityDigest } : {}),
        ...(entry.lowlevelSource !== undefined ? { lowlevelSource: entry.lowlevelSource } : {}),
      },
    });
    if (semantic.verdict !== "match") {
      return result(
        "semantic_lineage_blocked",
        `semantic lineage purpose ${semantic.verdict}: ${"detail" in semantic ? semantic.detail : "purpose 矩阵拒绝"}`,
      );
    }
  }

  // ── 4. 当前 unresolved Authority exact identity。
  const current = resolveTreasuryUnresolvedAuthority(entry.transactionId);
  if (current.status === "ok") {
    const authorityExact = treasuryExactAttemptIdentityOfAuthority(current.authority);
    if (authorityExact === null) {
      return result("authority_insufficient", "当前 authority 身份无法构造 exact identity（不释放）");
    }
    const relation = treasuryExactAttemptIdentityRelation(authorityExact, journalIdentity);
    if (relation !== "match") {
      return result(
        relation === "conflict" ? "authority_conflict" : "authority_insufficient",
        `当前 unresolved authority 与 journal entry 身份 ${relation}（同 transaction ID 不视为同一 attempt——不释放）`,
      );
    }
    return { status: "verified", detail: "journal↔proof↔opposite↔lineage↔authority 全部 exact match", journalIdentity, authoritySource: "intent-quarantine" };
  }
  if (current.status === "inconsistent") {
    return result("authority_inconsistent", `unresolved authority inconsistent: ${current.detail}（零 destructive action）`);
  }
  if (current.status === "store_unhealthy") {
    return result("authority_store_unhealthy", `unresolved authority store unhealthy: ${current.detail}`);
  }
  // resolver not_found：authorization fault 可能仍在（resolver 只覆盖 intent/quarantine）。
  const fault = readTreasuryAuthorizationFaultEntry(entry.transactionId);
  if (fault !== undefined) {
    const faultExact = treasuryPreReleaseExactIdentityOfAuthorizationFault(fault);
    if (faultExact === null) {
      return result("authority_insufficient", "authorization fault entry 身份无法构造 exact identity（不释放）");
    }
    const relation = treasuryExactAttemptIdentityRelation(faultExact, journalIdentity);
    if (relation !== "match") {
      return result(
        relation === "conflict" ? "authority_conflict" : "authority_insufficient",
        `authorization fault entry 与 journal entry 身份 ${relation}（不只比较 digest——不释放）`,
      );
    }
    return { status: "verified", detail: "journal↔proof↔opposite↔lineage↔authorization-fault 全部 exact match", journalIdentity, authoritySource: "authorization-fault" };
  }
  // Authority 全部 absent：合法中断窗口（已释放、authority 阶段未 ack、
  // global reset）——marker 阶段已 ack，或**外部 marker 事实也已 absent**
  //（journal 幂等补开的历史遗留窗口：marker/authority 均已清理，marker
  // discharge ack 将以 already_absent 幂等完成——target proof / opposite /
  // semantic 已在上文验证）。marker 仍存在时 absent 即安全顺序破坏
  //（authority 先于 marker 消失——最后一把锁不得因 absent 被清除）。
  if (entry.markerDischarged) {
    return {
      status: "authority_absent_recoverable",
      detail: "authority 已释放（marker 阶段已 ack、target proof 匹配、opposite 确证 absent——合法中断窗口幂等确认）",
      journalIdentity,
    };
  }
  const markerState = peekTreasuryMarkerDischargeState(
    treasuryMarkerDischargeExpectedOfFacts({
      transactionId: entry.transactionId,
      digest: entry.digest,
      proofClass: entry.proofClass,
      ...(entry.contractDigest !== undefined ? { contractDigest: entry.contractDigest } : {}),
      ...(entry.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: entry.authorizationCohortDigest } : {}),
      ...(entry.durableIdentityDigest !== undefined ? { durableIdentityDigest: entry.durableIdentityDigest } : {}),
      ...(entry.lowlevelSource !== undefined ? { lowlevelSource: entry.lowlevelSource } : {}),
      ...(entry.lineageId !== undefined ? { lineageId: entry.lineageId } : {}),
      ...(entry.lineageGeneration !== undefined ? { lineageGeneration: entry.lineageGeneration } : {}),
      ...(entry.parentTransactionId !== undefined ? { parentTransactionId: entry.parentTransactionId } : {}),
      ...(entry.lineageBindingDigest !== undefined ? { lineageBindingDigest: entry.lineageBindingDigest } : {}),
    }),
  );
  if (!markerState.blocked) {
    return {
      status: "authority_absent_recoverable",
      detail: "authority 与外部 marker 均已 absent（journal 幂等补开的遗留窗口——marker discharge ack 幂等补完成，不因 absent 跳过任何验证）",
      journalIdentity,
    };
  }
  return result(
    "authority_absent_unexpected",
    "authority absent 但 marker 仍未清除（安全顺序 marker→authority 被破坏——最后一把锁不得因 absent 被清除）",
  );
}
