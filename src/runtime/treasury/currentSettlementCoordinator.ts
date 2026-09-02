/**
 * 【第二十二轮第九节】cross-store current settlement coordinator——
 * child-active commit 恢复、committed resolution、terminal compaction 的
 * 统一只读安全判定（单一实现，不再各自拼 cross-store 矩阵）。
 *
 * Round 21 及之前 child-active 恢复只比较 Receipt exact identity ↔ lineage
 * current identity，不检查 Intent/Quarantine 结论、Resolution tombstone、
 * Marker、相反 not-executed proof 与各 store health。本协调器按结论矩阵
 * 统一判定（全部单 key 查询，O(1)）：
 *
 * committed verified 需要：trusted Receipt 完整 exact match + semantic
 * lineage committed purpose 通过 + 无 matching final not-executed
 * tombstone + 无 matching GRA not-executed proof + Intent/Quarantine
 * absent 或同 attempt committed-compatible + 无双 authority 冲突 + 当前
 * attempt marker 不阻断 + 全部相关 store 健康。
 *
 * not_executed verified 需要：matching not-executed tombstone + matching
 * exact GRA proof + semantic retirement purpose 通过 + 无 matching
 * committed trusted Receipt + 无 matching committed tombstone + authority
 * 已安全释放 + marker 不阻断。
 *
 * 本模块只读（零状态变化）；summary/lineage store 的 health source 经装配
 * 注入（避免与 lineageRetirementSummary / attemptLineage 循环依赖——
 * production 未装配 fail closed）。相反 proof 子检查（十六节）单独导出供
 * compaction 复用："目标结论 proof 存在"不等于"相反结论 proof 不存在"。
 */

import {
  peekTreasuryReceiptHealth,
  readTreasurySettlementProof,
} from "@/runtime/treasury/receipts";
import {
  peekTreasuryResolutionStoreHealth,
  readTreasuryResolutionTombstone,
} from "@/runtime/treasury/resolutionStore";
import {
  peekTreasuryGenerationRetirementHealth,
  lookupTreasuryGenerationRetirementProofByAttemptId,
} from "@/runtime/treasury/generationRetirementAuthority";
import { resolveTreasuryUnresolvedAuthority } from "@/runtime/treasury/unresolvedAuthority";
import { peekTreasuryMarkerDischargeState } from "@/runtime/treasury/markerDischarge";
import {
  validateTreasurySemanticLineage,
  type TreasurySemanticLineagePurpose,
} from "@/runtime/treasury/semanticLineageValidation";
import {
  treasuryExactAttemptIdentityOfTombstone,
  treasuryExactAttemptIdentityRelation,
  type TreasuryExactAttemptIdentity,
} from "@/runtime/treasury/exactAttemptIdentity";
import {
  compareTreasuryGenerationProofWithTombstone,
  type TreasuryGenerationRetirementProofView,
} from "@/runtime/treasury/generationRetirementRelation";
import { readTreasuryTrustedSettlementProofForAttempt } from "@/runtime/treasury/trustedSettlementProof";
import {
  type TreasuryIdentityProfile,
  treasuryProfileAllowsAutomaticProtocol,
} from "@/runtime/treasury/identityProfile";
import type { TreasuryLineageProofFacts } from "@/runtime/treasury/lineageProof";

/** summary / lineage store 的 health source（装配注入——解循环依赖）。 */
type TreasurySettlementHealthSource = () => { readonly healthy: boolean; readonly detail: string | null };

let summaryHealthSource: TreasurySettlementHealthSource | null = null;
let lineageHealthSource: TreasurySettlementHealthSource | null = null;

export function registerTreasurySettlementSummaryHealthSourceForAssembly(source: TreasurySettlementHealthSource | null): void {
  summaryHealthSource = source;
}

export function registerTreasurySettlementLineageHealthSourceForAssembly(source: TreasurySettlementHealthSource | null): void {
  lineageHealthSource = source;
}

/** 协调器输入（全部单 key 事实——record 由调用方读取注入）。 */
export interface TreasuryCurrentSettlementQuery {
  readonly outcome: "committed" | "not-executed";
  readonly attempt: TreasuryExactAttemptIdentity;
  readonly identityProfile: TreasuryIdentityProfile;
  /** tr1_ 链的 lineage proof facts（semantic validation 输入）。 */
  readonly lineageProof?: TreasuryLineageProofFacts;
  /** identity 输入（semantic validation 的可选 exact 维度）。 */
  readonly identityFacts?: Parameters<typeof validateTreasurySemanticLineage>[0]["identity"];
}

export type TreasuryCurrentSettlementVerdict =
  | {
      readonly verdict: "committed_verified" | "not_executed_verified";
      readonly outcome: "committed" | "not-executed";
      readonly globalWriteAdmissionStillLocked: boolean;
    }
  | { readonly verdict: "conflict"; readonly sources: readonly string[]; readonly details: readonly string[] }
  | { readonly verdict: "insufficient"; readonly sources: readonly string[]; readonly details: readonly string[] }
  | { readonly verdict: "store_unhealthy"; readonly sources: readonly string[]; readonly details: readonly string[] };

interface SettlementCheckAccumulator {
  conflicts: string[];
  insufficiencies: string[];
  unhealthies: string[];
}

function accumulate(acc: SettlementCheckAccumulator, kind: keyof SettlementCheckAccumulator, source: string, detail: string): void {
  acc[kind].push(`${source}: ${detail}`);
}

/**
 * cross-store settlement 结论判定（只读、单 key 查询）。
 * 返回 conflict/insufficient/store_unhealthy 时 sources 携带结构化来源。
 */
export function verifyTreasuryCurrentSettlement(query: TreasuryCurrentSettlementQuery): TreasuryCurrentSettlementVerdict {
  const acc: SettlementCheckAccumulator = { conflicts: [], insufficiencies: [], unhealthies: [] };
  const { attempt } = query;
  const isCommitted = query.outcome === "committed";

  // 0) store health（receipt / resolution / GRA / lineage / summary /
  //    intent+quarantine 经 resolver；health source 未装配 → fail closed）。
  const receiptHealth = peekTreasuryReceiptHealth();
  if (!receiptHealth.healthy) accumulate(acc, "unhealthies", "receipt_store", receiptHealth.detail ?? "unhealthy");
  const resolutionHealth = peekTreasuryResolutionStoreHealth();
  if (!resolutionHealth.healthy) accumulate(acc, "unhealthies", "resolution_store", resolutionHealth.detail ?? "unhealthy");
  const graHealth = peekTreasuryGenerationRetirementHealth();
  if (!graHealth.healthy) accumulate(acc, "unhealthies", "generation_retirement_store", graHealth.detail ?? "unhealthy");
  if (lineageHealthSource === null) {
    accumulate(acc, "unhealthies", "lineage_store", "health source 未装配（production fail closed）");
  } else {
    const lineageHealth = lineageHealthSource();
    if (!lineageHealth.healthy) accumulate(acc, "unhealthies", "lineage_store", lineageHealth.detail ?? "unhealthy");
  }
  if (summaryHealthSource === null) {
    accumulate(acc, "unhealthies", "summary_store", "health source 未装配（production fail closed）");
  } else {
    const summaryHealth = summaryHealthSource();
    if (!summaryHealth.healthy) accumulate(acc, "unhealthies", "summary_store", summaryHealth.detail ?? "unhealthy");
  }
  if (acc.unhealthies.length > 0) {
    return { verdict: "store_unhealthy", sources: acc.unhealthies.map((d) => d.split(":")[0]), details: acc.unhealthies };
  }

  // 1) profile 参与检查：legacy-replay / forensic-isolated 不参与自动 settlement。
  if (!treasuryProfileAllowsAutomaticProtocol(query.identityProfile)) {
    accumulate(acc, "insufficiencies", "identity_profile", `attempt 的 profile ${query.identityProfile} 不参与自动 settlement（隔离）`);
  }

  // 2) marker：属于当前 attempt 且未清除 → 阻断（unrelated → 当前 attempt
  //    可继续，global lock 保留事实单独返回）。
  let globalWriteAdmissionStillLocked = false;
  const markerState = peekTreasuryMarkerDischargeState({
    transactionId: attempt.transactionId,
    digest: attempt.digest,
    proofClass: attempt.proofClass,
    identityProfile: query.identityProfile,
    ...(attempt.contractDigest !== undefined ? { contractDigest: attempt.contractDigest } : {}),
    ...(attempt.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: attempt.authorizationCohortDigest } : {}),
    ...(attempt.durableIdentityDigest !== undefined ? { durableIdentityDigest: attempt.durableIdentityDigest } : {}),
    ...(attempt.lowlevelSource !== undefined ? { lowlevelSource: attempt.lowlevelSource } : {}),
    ...(attempt.lineageId !== undefined ? { lineageId: attempt.lineageId } : {}),
    ...(attempt.lineageGeneration !== undefined ? { lineageGeneration: attempt.lineageGeneration } : {}),
    ...(attempt.parentTransactionId !== undefined ? { parentTransactionId: attempt.parentTransactionId } : {}),
    ...(attempt.lineageBindingDigest !== undefined ? { lineageBindingDigest: attempt.lineageBindingDigest } : {}),
  });
  if (markerState.relation.kind === "store_unhealthy") {
    accumulate(acc, "unhealthies", "write_fault_marker", markerState.relation.detail);
  } else if (markerState.blocked) {
    accumulate(acc, "insufficiencies", "write_fault_marker", `marker 仍属于当前 attempt（${markerState.relation.kind}: ${markerState.relation.detail}）——未 discharge 前不得 settlement`);
  } else if (markerState.relation.kind === "unrelated" && !markerState.relation.detail.includes("不存在")) {
    globalWriteAdmissionStillLocked = true;
  }

  // 3) Receipt：committed 需要 trusted exact match；not-executed 需要相反
  //    proof 不存在。
  const trustedReceipt = readTreasuryTrustedSettlementProofForAttempt(attempt.transactionId, attempt);
  if (isCommitted) {
    if (trustedReceipt.status === "trusted_proof") {
      // exact match ✓
    } else if (trustedReceipt.status === "absent") {
      accumulate(acc, "insufficiencies", "receipt", "committed settlement 缺少 trusted receipt（不可证明）");
    } else if (trustedReceipt.status === "store_unhealthy") {
      accumulate(acc, "unhealthies", "receipt_store", trustedReceipt.detail);
    } else if (trustedReceipt.status === "identity_conflict") {
      accumulate(acc, "conflicts", "receipt", trustedReceipt.detail);
    } else {
      accumulate(acc, "insufficiencies", "receipt", trustedReceipt.detail);
    }
  } else {
    if (trustedReceipt.status === "trusted_proof") {
      accumulate(acc, "conflicts", "receipt", "not-executed 目标存在 matching committed trusted receipt（相反结论 proof）");
    } else if (trustedReceipt.status === "store_unhealthy") {
      accumulate(acc, "unhealthies", "receipt_store", trustedReceipt.detail);
    } else if (trustedReceipt.status === "identity_conflict") {
      accumulate(acc, "conflicts", "receipt", trustedReceipt.detail);
    }
    // absent / legacy_insufficient：不构成 committed proof（legacy replay-only）。
  }

  // 4) Resolution tombstone。
  const tombstone = readTreasuryResolutionTombstone(attempt.transactionId);
  if (isCommitted) {
    if (tombstone !== undefined && tombstone.resolution === "not-executed" && tombstone.stage === "final") {
      const tombstoneExact = treasuryExactAttemptIdentityOfTombstone(tombstone);
      const relation = tombstoneExact === null ? "insufficient" : treasuryExactAttemptIdentityRelation(tombstoneExact, attempt);
      if (relation !== "insufficient") {
        accumulate(acc, "conflicts", "resolution_tombstone", "committed 目标存在 matching final not-executed tombstone（相反结论 proof）");
      }
    }
  } else {
    if (tombstone === undefined) {
      accumulate(acc, "insufficiencies", "resolution_tombstone", "not-executed settlement 缺少 matching tombstone（不可证明）");
    } else if (tombstone.resolution === "committed") {
      accumulate(acc, "conflicts", "resolution_tombstone", "not-executed 目标存在 matching committed tombstone（相反结论 proof）");
    } else if (tombstone.stage !== "final") {
      accumulate(acc, "insufficiencies", "resolution_tombstone", "not-executed tombstone 仍处于 resolving（结论未持久化）");
    } else {
      const tombstoneExact = treasuryExactAttemptIdentityOfTombstone(tombstone);
      const relation = tombstoneExact === null ? "insufficient" : treasuryExactAttemptIdentityRelation(tombstoneExact, attempt);
      if (relation === "conflict") {
        accumulate(acc, "conflicts", "resolution_tombstone", "final not-executed tombstone 与 attempt exact identity 冲突");
      } else if (relation === "insufficient") {
        accumulate(acc, "insufficiencies", "resolution_tombstone", "final not-executed tombstone 身份维度不足（不可证明 matching）");
      }
    }
  }

  // 5) GRA not-executed proof（byAttempt O(1)）。【Remediation II E】完整
  //    GRA exact relation（graExactRelationToAttempt 复用统一 matcher——
  //    digest/lineageId 之外的任一维度冲突同样 fail closed，不再放行）。
  const graProof = lookupTreasuryGenerationRetirementProofByAttemptId(attempt.transactionId);
  if (isCommitted) {
    if (graProof !== undefined) {
      const relation = graExactRelationToAttempt(graProof, attempt);
      if (relation === "match") {
        accumulate(acc, "conflicts", "generation_retirement_proof", "committed 目标存在 matching GRA not-executed exact proof（相反结论 proof）");
      } else {
        accumulate(acc, "conflicts", "generation_retirement_proof", `GRA proof 与 attempt 身份 ${relation}（同 attempt id 的 exact 维度冲突——fail closed）`);
      }
    }
  } else if (graProof === undefined) {
    // tr1_ 链的 not-executed 结论需要 exact proof；initial（非 tr1_）无
    // lineage 维度——GRA proof 不适用（resolution tombstone 已承载）。
    if (attempt.lineageId !== undefined) {
      accumulate(acc, "insufficiencies", "generation_retirement_proof", "tr1_ not-executed settlement 缺少 matching exact retirement proof");
    }
  } else {
    const relation = graExactRelationToAttempt(graProof, attempt);
    if (relation !== "match") {
      accumulate(acc, "conflicts", "generation_retirement_proof", `GRA proof 与 attempt 身份 ${relation}（exact 维度不一致——不得据此推进清理/删除 proof/授权 rearm）`);
    }
  }

  // 6) Intent/Quarantine（unified resolver）。
  const authority = resolveTreasuryUnresolvedAuthority(attempt.transactionId);
  if (authority.status === "store_unhealthy") {
    accumulate(acc, "unhealthies", "unresolved_authority", authority.detail);
  } else if (authority.status === "inconsistent") {
    accumulate(acc, "conflicts", "unresolved_authority", authority.detail);
  } else if (authority.status === "ok") {
    if (isCommitted) {
      // committed-compatible：execution 事实与 committed 结论不矛盾——
      // returned_non_ok（Game 明确非 OK）与 committed receipt 矛盾；
      // started_unknown 是 fault 中断时的过时快照，receipt 是更强证据
      // （可升级证明）。
      const outcome = authority.authority.outcome;
      if (outcome === "returned_non_ok") {
        accumulate(acc, "conflicts", "unresolved_authority", `committed 目标的 authority outcome 为 ${String(outcome)}（Game 明确非 OK——与 committed 结论矛盾）`);
      }
    } else {
      // not-executed：authority 必须已释放（或即将由 cleanup 编排释放——
      // verified 结论要求 not_found；仍存在 → insufficient 交由编排先释放）。
      accumulate(acc, "insufficiencies", "unresolved_authority", "not-executed 目标的 authority 未释放（cleanup 编排先行释放后重验）");
    }
  }

  // 7) semantic lineage purpose verdict（tr1_ 需要；initial 无 proof 时跳过）。
  if (query.lineageProof !== undefined) {
    const purpose: TreasurySemanticLineagePurpose = isCommitted ? "committed_settlement" : "not_executed_retirement";
    const verdict = validateTreasurySemanticLineage({
      transactionId: attempt.transactionId,
      proof: query.lineageProof,
      ...(query.identityFacts !== undefined ? { identity: query.identityFacts } : {}),
      purpose,
    });
    if (verdict.verdict === "store_unhealthy") {
      accumulate(acc, "unhealthies", "semantic_lineage", verdict.detail);
    } else if (verdict.verdict === "conflict") {
      accumulate(acc, "conflicts", "semantic_lineage", verdict.detail);
    } else if (verdict.verdict !== "match") {
      accumulate(acc, "insufficiencies", "semantic_lineage", verdict.detail);
    }
  }

  if (acc.conflicts.length > 0) {
    return { verdict: "conflict", sources: uniqueSources(acc.conflicts), details: acc.conflicts };
  }
  if (acc.unhealthies.length > 0) {
    return { verdict: "store_unhealthy", sources: uniqueSources(acc.unhealthies), details: acc.unhealthies };
  }
  if (acc.insufficiencies.length > 0) {
    return { verdict: "insufficient", sources: uniqueSources(acc.insufficiencies), details: acc.insufficiencies };
  }
  return {
    verdict: isCommitted ? "committed_verified" : "not_executed_verified",
    outcome: query.outcome,
    globalWriteAdmissionStillLocked,
  };
}

function uniqueSources(details: readonly string[]): readonly string[] {
  return [...new Set(details.map((detail) => detail.split(":")[0]))];
}

/**
 * 【Remediation II E】GRA not-executed proof ↔ attempt 的完整 exact relation
 * （复用 generationRetirementRelation 单一 matcher，不复制身份比较逻辑）：
 * transaction/attempt 关系、digest、proof class、contract/cohort/durable/
 * lowlevel 维度、parent/binding（期望派生 + tombstone 视图持久字段）、
 * lineageId/generation 显式一致（matcher 未覆盖的两维）、gen0/gen≥1 形态
 * （gen0 禁 parent/binding；tr1_ 必须完整 lineage 维度）。
 * match / conflict / insufficient（tombstone 视图缺持久 parent = 不可证明）。
 */
function graExactRelationToAttempt(
  graProof: TreasuryGenerationRetirementProofView,
  attempt: TreasuryExactAttemptIdentity,
): "match" | "conflict" | "insufficient" {
  if (attempt.lineageId !== undefined) {
    // tr1_：lineageId/generation 显式一致；parent/binding 必须完整可比较。
    if (graProof.lineageId !== attempt.lineageId) return "conflict";
    if (graProof.generation !== attempt.lineageGeneration) return "conflict";
    if (attempt.parentTransactionId === undefined || attempt.lineageBindingDigest === undefined) {
      return "insufficient";
    }
  } else {
    // initial attempt：GRA proof 必须是 gen0 形态（无 parent/binding——
    // proof.lineageId 由其内部 root 绑定重算语义承担，不与 attempt 比较）。
    if (graProof.generation !== 0) return "conflict";
    if (graProof.parentTransactionId !== undefined || graProof.bindingDigest !== undefined) return "conflict";
    if (graProof.transactionId !== attempt.transactionId) return "conflict";
  }
  const attemptTombstoneView = {
    transactionId: attempt.transactionId,
    digest: attempt.digest,
    proofLevel: attempt.proofClass,
    ...(attempt.contractDigest !== undefined ? { contractDigest: attempt.contractDigest } : {}),
    ...(attempt.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: attempt.authorizationCohortDigest } : {}),
    ...(attempt.durableIdentityDigest !== undefined ? { durableIdentityDigest: attempt.durableIdentityDigest } : {}),
    ...(attempt.lowlevelSource !== undefined ? { lowlevelSource: attempt.lowlevelSource } : {}),
    ...(attempt.lineageId !== undefined ? { lineageId: attempt.lineageId } : {}),
    ...(attempt.lineageGeneration !== undefined ? { lineageGeneration: attempt.lineageGeneration } : {}),
    ...(attempt.parentTransactionId !== undefined ? { parentTransactionId: attempt.parentTransactionId } : {}),
    ...(attempt.lineageBindingDigest !== undefined ? { lineageBindingDigest: attempt.lineageBindingDigest } : {}),
  };
  const relation = compareTreasuryGenerationProofWithTombstone(
    graProof,
    attemptTombstoneView,
    attempt.parentTransactionId ?? attempt.transactionId,
    attempt.lineageBindingDigest,
  );
  if (relation === null) return "match";
  return relation.kind === "conflict" ? "conflict" : "insufficient";
}

/**
 * 相反 proof 显式不存在检查（十六节——compaction 复用）：
 * committed 目标必须确认无 matching final not-executed tombstone / GRA
 * not-executed proof；not-executed 目标必须确认无 trusted committed
 * receipt / committed tombstone。exact identity 匹配——同 ID 的其它
 * attempt 不误阻断。
 */
export function verifyTreasuryOppositeProofAbsence(query: {
  readonly outcome: "committed" | "not-executed";
  readonly attempt: TreasuryExactAttemptIdentity;
}): { readonly blocked: boolean; readonly sources: readonly string[]; readonly details: readonly string[] } {
  const details: string[] = [];
  const { attempt } = query;
  const receiptHealth = peekTreasuryReceiptHealth();
  if (!receiptHealth.healthy) details.push(`receipt_store: ${receiptHealth.detail ?? "unhealthy"}`);
  const resolutionHealth = peekTreasuryResolutionStoreHealth();
  if (!resolutionHealth.healthy) details.push(`resolution_store: ${resolutionHealth.detail ?? "unhealthy"}`);
  const graHealth = peekTreasuryGenerationRetirementHealth();
  if (!graHealth.healthy) details.push(`generation_retirement_store: ${graHealth.detail ?? "unhealthy"}`);
  if (details.length > 0) {
    return { blocked: true, sources: uniqueSources(details), details };
  }
  if (query.outcome === "committed") {
    const tombstone = readTreasuryResolutionTombstone(attempt.transactionId);
    if (tombstone !== undefined && tombstone.resolution === "not-executed" && tombstone.stage === "final") {
      const tombstoneExact = treasuryExactAttemptIdentityOfTombstone(tombstone);
      if (tombstoneExact !== null && treasuryExactAttemptIdentityRelation(tombstoneExact, attempt) !== "insufficient") {
        details.push("resolution_tombstone: matching final not-executed tombstone（相反结论）");
      }
    }
    const graProof = lookupTreasuryGenerationRetirementProofByAttemptId(attempt.transactionId);
    if (graProof !== undefined) {
      // 【Remediation II E】完整 exact relation：matching → 相反结论 proof
      // 阻断；不 matching（同 attempt id 但任一维度冲突）→ 相反结论缺失
      // 不可证明，同样 retained（不删除、不推进）。
      const relation = graExactRelationToAttempt(graProof, attempt);
      if (relation === "match") {
        details.push("generation_retirement_proof: matching GRA not-executed exact proof（相反结论）");
      } else {
        details.push(`generation_retirement_proof: GRA proof 与 attempt 身份 ${relation}（相反结论缺失不可证明——retained）`);
      }
    }
  } else {
    const trustedReceipt = readTreasuryTrustedSettlementProofForAttempt(attempt.transactionId, attempt);
    if (trustedReceipt.status === "trusted_proof") {
      details.push("receipt: matching trusted committed receipt（相反结论）");
    } else if (trustedReceipt.status === "store_unhealthy") {
      details.push(`receipt_store: ${trustedReceipt.detail}`);
    }
    const tombstone = readTreasuryResolutionTombstone(attempt.transactionId);
    if (tombstone !== undefined && tombstone.resolution === "committed" && tombstone.stage === "final") {
      const tombstoneExact = treasuryExactAttemptIdentityOfTombstone(tombstone);
      if (tombstoneExact !== null && treasuryExactAttemptIdentityRelation(tombstoneExact, attempt) !== "insufficient") {
        details.push("resolution_tombstone: matching final committed tombstone（相反结论）");
      }
    }
  }
  return { blocked: details.length > 0, sources: uniqueSources(details), details };
}

/** replay-readable proof（诊断/防重放——不得用于 release 判定）。 */
export function peekTreasuryReplayReadableSettlementProof(
  transactionId: string,
): ReturnType<typeof readTreasurySettlementProof> {
  return readTreasurySettlementProof(transactionId);
}
