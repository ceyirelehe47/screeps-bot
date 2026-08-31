/**
 * 【第十五轮第十三节】唯一的 committed proof 三方 verifier（纯函数）。
 *
 * 背景：Round 14 的三方验证（receipt ↔ tombstone ↔ authority）只存在于
 * recoverStagedResolutions 的内联序列里，immediate resolve-as-committed 在
 * refresh 返回成功后直接释放 authority——两条路径的证明强度不一致。本模块
 * 抽取唯一的 verifier，供 normal resolve-as-committed、beginTick staged
 * recovery、finalize 补完成与 already-resolved 检查共同复用。
 *
 * 输入：resolution tombstone、unified unresolved authority 解析结果（status
 * ok / inconsistent / not_found——**不信任调用方缓存的旧 authority**，调用
 * 方必须在验证前重新解析）、持久 receipt proof（调用方从 Memory 重新读取，
 * 不信任 refresh 返回值）。
 *
 * 输出：verified（唯一释放许可）/ conflict / insufficient /
 * authority_inconsistent / receipt_absent / receipt_stale。
 */

import {
  treasuryAttemptIdentityRelation,
  type TreasuryAttemptIdentity,
} from "@/runtime/treasury/identityProof";
import type { TreasuryResolutionProofLevel, TreasuryResolutionTombstone } from "@/runtime/treasury/resolutionStore";
import type { TreasuryUnresolvedAuthorityResolution } from "@/runtime/treasury/unresolvedAuthority";

/** 持久 settlement receipt proof 的验证视图（readTreasurySettlementProof 快照）。 */
export interface TreasuryCommittedReceiptProofView {
  readonly level?: string;
  readonly settledAtTick: number;
  readonly digest?: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
}

export type TreasuryCommittedProofVerdict =
  | { readonly status: "verified"; readonly authorityPresent: boolean }
  | { readonly status: "conflict"; readonly detail: string }
  | { readonly status: "insufficient"; readonly detail: string }
  | { readonly status: "authority_inconsistent"; readonly detail: string }
  | { readonly status: "receipt_absent"; readonly detail: string }
  | { readonly status: "receipt_stale"; readonly detail: string };

/** tombstone / authority / receipt proof → 完整 attempt identity 视图。 */
function attemptIdentityOf(source: {
  readonly digest?: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
}): TreasuryAttemptIdentity {
  return {
    digest: source.digest ?? "",
    ...(source.contractDigest !== undefined ? { contractDigest: source.contractDigest } : {}),
    ...(source.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: source.authorizationCohortDigest } : {}),
    ...(source.durableIdentityDigest !== undefined ? { durableIdentityDigest: source.durableIdentityDigest } : {}),
  };
}

/**
 * 【第十五轮第八节】普通自动 recovery 的 proof level → authority 等级释放
 * 矩阵：只允许 identity-bound → modern 与 lowlevel → lowlevel。legacy 与
 * forensic 一律不自动释放（legacy replay blocker 语义保留，但不作为
 * authority release proof；forensic 只能经显式 provenance 流程）。
 */
export function treasuryProofLevelAutoReleasesAuthorityLevel(
  proofLevel: TreasuryResolutionProofLevel,
  authorityLevel: string | undefined,
): boolean {
  if (proofLevel === "identity-bound") return authorityLevel === "modern";
  if (proofLevel === "lowlevel") return authorityLevel === "lowlevel";
  return false;
}

/**
 * 三方 committed proof 验证（唯一权威；normal 与 recovery 共用）：
 * 1. authority inconsistent → 整体阻断（零释放，全部证据保留）；
 * 2. receipt 缺失 / tick 不足（settledAtTick < tombstone.settledAtTick）→
 *    receipt_absent / receipt_stale（调用方走 identity-aware refresh 后重读
 *    再验证，不得凭 refresh 返回值释放）；
 * 3. receipt proof 非 modern level → insufficient（legacy proof 不能证明
 *    当前 attempt 的 committed 结论、更不能释放 authority）；
 * 4. receipt ↔ tombstone 完整 attempt identity relation：match 才继续，
 *    conflict / insufficient 分别返回；
 * 5. authority 仍存在（status ok）：proof level ↔ authority 等级自动释放
 *    矩阵 + tombstone ↔ authority、receipt ↔ authority 双 relation match；
 * 6. authority 已不存在（not_found）：receipt ↔ tombstone match 且 tick 足够
 *    即为补完成 finalize 的许可（不伪造新 authority）。
 */
export function verifyTreasuryCommittedResolutionProof(input: {
  readonly tombstone: Pick<
    TreasuryResolutionTombstone,
    | "transactionId"
    | "digest"
    | "proofLevel"
    | "settledAtTick"
    | "contractDigest"
    | "authorizationCohortDigest"
    | "durableIdentityDigest"
  >;
  readonly authorityResolution: TreasuryUnresolvedAuthorityResolution;
  readonly receiptProof: TreasuryCommittedReceiptProofView | undefined;
}): TreasuryCommittedProofVerdict {
  const { tombstone, authorityResolution, receiptProof } = input;
  if (authorityResolution.status === "inconsistent") {
    return {
      status: "authority_inconsistent",
      detail: `同 id 双 authority inconsistent（${authorityResolution.detail}）——零释放，全部证据保留`,
    };
  }
  if (receiptProof === undefined) {
    return { status: "receipt_absent", detail: `transactionId ${tombstone.transactionId.slice(0, 48)} 无持久 settlement proof（refresh 后仍缺失或被清除）` };
  }
  if (tombstone.settledAtTick === undefined || receiptProof.settledAtTick < tombstone.settledAtTick) {
    return {
      status: "receipt_stale",
      detail: `receipt tick 不足（proof ${String(receiptProof.settledAtTick)} < tombstone settledAt ${String(tombstone.settledAtTick)}）`,
    };
  }
  if (receiptProof.level !== "modern") {
    return {
      status: "insufficient",
      detail: `receipt proof level 为 ${String(receiptProof.level)}（须 modern——legacy/未知 proof 不能证明当前 attempt 的 committed 结论）`,
    };
  }
  const tombstoneAttempt = attemptIdentityOf(tombstone);
  const receiptRelation = treasuryAttemptIdentityRelation(attemptIdentityOf(receiptProof), tombstoneAttempt);
  if (receiptRelation !== "match") {
    return receiptRelation === "conflict"
      ? { status: "conflict", detail: "receipt ↔ tombstone 完整 attempt identity conflict——不同 attempt 的 proof 不得释放当前 authority" }
      : { status: "insufficient", detail: "receipt ↔ tombstone identity 证明不足（proof 缺少当前 attempt 的身份事实）" };
  }
  if (authorityResolution.status === "not_found") {
    // authority 已在前一阶段释放、finalize 前中断：receipt ↔ tombstone match
    // 且 tick 足够即补完成许可——不伪造新 authority。
    return { status: "verified", authorityPresent: false };
  }
  const authority = authorityResolution.authority;
  if (!treasuryProofLevelAutoReleasesAuthorityLevel(tombstone.proofLevel, authority.authorityLevel)) {
    return {
      status: "insufficient",
      detail: `proof level ${tombstone.proofLevel} 不得自动释放 authority 等级 ${String(authority.authorityLevel)}（普通自动 recovery 只允许 identity-bound → modern、lowlevel → lowlevel；legacy/forensic 永久隔离）`,
    };
  }
  const authorityAttempt = attemptIdentityOf(authority);
  const tombstoneAuthorityRelation = treasuryAttemptIdentityRelation(tombstoneAttempt, authorityAttempt);
  if (tombstoneAuthorityRelation !== "match") {
    return tombstoneAuthorityRelation === "conflict"
      ? { status: "conflict", detail: "tombstone ↔ authority 完整 attempt identity conflict" }
      : { status: "insufficient", detail: "tombstone ↔ authority identity 证明不足" };
  }
  const receiptAuthorityRelation = treasuryAttemptIdentityRelation(attemptIdentityOf(receiptProof), authorityAttempt);
  if (receiptAuthorityRelation !== "match") {
    return receiptAuthorityRelation === "conflict"
      ? { status: "conflict", detail: "receipt ↔ authority 完整 attempt identity conflict" }
      : { status: "insufficient", detail: "receipt ↔ authority identity 证明不足" };
  }
  return { status: "verified", authorityPresent: true };
}
