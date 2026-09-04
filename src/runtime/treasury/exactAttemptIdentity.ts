/**
 * 【第二十轮第八节】exact attempt identity 单一构造层。
 *
 * Round 19 的审查断链：多个安全关键调用点（receipt 幂等、prepared commit
 * 预检、finalized intent proof 链、resolution 补完成比较、authorization-
 * fault 幂等、rearm parent identity）各自手工展开 attempt identity 的
 * 字段子集——lineage 四字段与 lowlevel provenance 在"比较视图"里被丢弃，
 * 而判定权威（identityProof.treasuryAttemptIdentityRelation）对"proof 携带
 * lineage 而 attempt 视图缺失"判 conflict，导致合法 matching rearm proof
 * 被误判。本模块收敛为唯一构造实现：安全关键路径的 attempt identity
 * 视图必须经此处生成，不得手工拼接（架构扫描保护）。
 *
 * 维度（按 proof class 包含适用事实）：
 * - transactionId（命名空间决定 rearm 语义）；
 * - canonical digest / contractDigest / authorizationCohortDigest /
 *   durableIdentityDigest（immutable identity）；
 * - lowlevelSource（lowlevel provenance——runtime 与 migrated 不能互相证明）；
 * - proofClass（identity-bound / lowlevel / legacy——class 变化即身份矛盾）；
 * - lineage 四字段（tr1_ 必携带；initial 禁止）。
 *
 * relation 对称区分 match / conflict / insufficient；marker 的 class-aware
 * 子集视图是明确允许的诊断性简化（不得用于 authority release / receipt
 * idempotence / compaction / tombstone eviction / committed finalization）。
 */

import { isTreasuryRearmAttemptId } from "@/runtime/treasury/transactionId";
import { validateTreasuryLowlevelSourceField } from "@/runtime/treasury/authorityLevel";

/**
 * proof / authority class（与 receipt proof level、tombstone proofLevel 同源）。
 * 【Remediation VII 修复五】forensic 为显式隔离等级（forensic-isolated
 * profile 的唯一合法 class）——不得在 exact relation 构造时折叠为 legacy
 * （隔离等级语义保留：不同 class 即身份冲突，同 class 才可能 match）。
 */
export type TreasuryAttemptProofClass = "identity-bound" | "lowlevel" | "legacy" | "forensic";

/** exact attempt identity 的规范视图（全部构造经本模块 helper）。 */
export interface TreasuryExactAttemptIdentity {
  readonly transactionId: string;
  readonly digest: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  /** lowlevel provenance（lowlevel class 必带；modern 禁止）。 */
  readonly lowlevelSource?: string;
  readonly proofClass: TreasuryAttemptProofClass;
  /** tr1_ rearm attempt 的 lineage proof（四字段整体携带；initial 禁止）。 */
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
}

/** identity 事实的可选输入形状（各 store 共同字段的并集视图）。 */
export interface TreasuryExactIdentityFactsInput {
  readonly digest?: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
}

/**
 * identity 事实的 proof class 推导（与 receipts 写入侧 receiptProofLevelOfIdentity
 * 同语义——有受控 lowlevelSource → lowlevel；完整身份（digest+durable）→
 * identity-bound；否则 legacy 无法定级）。
 */
export function treasuryProofClassOfIdentityFacts(
  identity: TreasuryExactIdentityFactsInput | undefined,
): TreasuryAttemptProofClass {
  if (
    identity?.lowlevelSource !== undefined &&
    validateTreasuryLowlevelSourceField(identity.lowlevelSource) === null
  ) {
    return "lowlevel";
  }
  if (identity?.digest !== undefined && identity?.durableIdentityDigest !== undefined) {
    return "identity-bound";
  }
  return "legacy";
}

/** unresolved authority level → proof class（modern→identity-bound；lowlevel→lowlevel；legacy/forensic→legacy 不可释放标记）。 */
/**
 * 【Remediation VII 修复五】持久化 proofClass 字符串的 canonical 转换：
 * lowlevel / identity-bound / forensic 原样保留（forensic 不折叠为
 * legacy——隔离 profile 的 exact identity 可比较、可区分）；其余 → legacy。
 */
export function treasuryProofClassOfPersistedClass(persisted: string): TreasuryAttemptProofClass {
  if (persisted === "lowlevel" || persisted === "identity-bound" || persisted === "forensic") return persisted;
  return "legacy";
}

export function treasuryProofClassOfAuthorityLevel(level: string | undefined): TreasuryAttemptProofClass {
  if (level === "lowlevel") return "lowlevel";
  if (level === "modern") return "identity-bound";
  return "legacy";
}

/** lineage proof class（identity-bound / lowlevel——lineage record 的两枚举权威 class）。 */
export type TreasuryLineageAuthorityClassInput = "identity-bound" | "lowlevel";

/**
 * 底层构造（单一实现——各来源适配最终都收敛到此处）：digest 必填；
 * tr1_ transactionId 必须携带完整 lineage 四字段（部分携带 = 构造拒绝，
 * 返回 null——调用方按 insufficient/形状异常 fail closed，不得静默降级）；
 * 非 tr1_ 携带 lineage 四字段同样拒绝（initial attempt 禁止 lineage proof）。
 */
export function treasuryExactAttemptIdentityOfFacts(
  transactionId: string,
  identity: TreasuryExactIdentityFactsInput,
  proofClass: TreasuryAttemptProofClass,
): TreasuryExactAttemptIdentity | null {
  if (typeof transactionId !== "string" || transactionId.length === 0) return null;
  if (identity.digest === undefined) return null;
  const lineageFieldCount =
    (identity.lineageId !== undefined ? 1 : 0) +
    (identity.lineageGeneration !== undefined ? 1 : 0) +
    (identity.parentTransactionId !== undefined ? 1 : 0) +
    (identity.lineageBindingDigest !== undefined ? 1 : 0);
  if (lineageFieldCount !== 0 && lineageFieldCount !== 4) return null;
  const isRearm = isTreasuryRearmAttemptId(transactionId);
  if (isRearm && lineageFieldCount !== 4) return null;
  if (!isRearm && lineageFieldCount !== 0) return null;
  return {
    transactionId,
    digest: identity.digest,
    ...(identity.contractDigest !== undefined ? { contractDigest: identity.contractDigest } : {}),
    ...(identity.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: identity.authorizationCohortDigest } : {}),
    ...(identity.durableIdentityDigest !== undefined ? { durableIdentityDigest: identity.durableIdentityDigest } : {}),
    ...(identity.lowlevelSource !== undefined ? { lowlevelSource: identity.lowlevelSource } : {}),
    proofClass,
    ...(identity.lineageId !== undefined ? { lineageId: identity.lineageId } : {}),
    ...(identity.lineageGeneration !== undefined ? { lineageGeneration: identity.lineageGeneration } : {}),
    ...(identity.parentTransactionId !== undefined ? { parentTransactionId: identity.parentTransactionId } : {}),
    ...(identity.lineageBindingDigest !== undefined ? { lineageBindingDigest: identity.lineageBindingDigest } : {}),
  };
}

/**
 * identity 输入视图（receipts.commitSettledReceipt 的 identity 参数、facade
 * prepared record 的 identity 展开）的 exact 构造：proof class 由事实推导。
 */
export function treasuryExactAttemptIdentityOfIdentityInput(
  transactionId: string,
  identity: TreasuryExactIdentityFactsInput | undefined,
): TreasuryExactAttemptIdentity | null {
  if (identity === undefined) return null;
  return treasuryExactAttemptIdentityOfFacts(transactionId, identity, treasuryProofClassOfIdentityFacts(identity));
}

/**
 * 持久 settlement proof（receipt）的 exact 视图（幂等比较用）：level=legacy
 * 的 proof 在此构造为 legacy class（与任何非 legacy attempt 比较 conflict /
 * insufficient——由 relation 承载；调用方通常在 legacy_committed 分支提前返回）。
 */
export function treasuryExactAttemptIdentityOfReceiptProof(
  transactionId: string,
  proof: {
    readonly level?: string;
    readonly digest?: string;
    readonly contractDigest?: string;
    readonly authorizationCohortDigest?: string;
    readonly durableIdentityDigest?: string;
    readonly lowlevelSource?: string;
    readonly lineageId?: string;
    readonly lineageGeneration?: number;
    readonly parentTransactionId?: string;
    readonly lineageBindingDigest?: string;
  },
): TreasuryExactAttemptIdentity | null {
  const digest = proof.digest !== undefined ? proof.digest : "";
  const proofClass: TreasuryAttemptProofClass =
    proof.level === "lowlevel" ? "lowlevel" : proof.level === "identity-bound" ? "identity-bound" : "legacy";
  return treasuryExactAttemptIdentityOfFacts(transactionId, { ...proof, digest }, proofClass);
}

/**
 * 统一 unresolved authority 的 exact 视图（lineage 四字段与 lowlevel
 * provenance 一并透传——Round 19 侧 authority 已携带，本构造不再丢弃）。
 */
export function treasuryExactAttemptIdentityOfAuthority(
  authority: {
    readonly transactionId: string;
    readonly digest: string;
    readonly contractDigest?: string;
    readonly authorizationCohortDigest?: string;
    readonly durableIdentityDigest?: string;
    readonly lowlevelSource?: string;
    readonly authorityLevel?: string;
    readonly lineageId?: string;
    readonly lineageGeneration?: number;
    readonly parentTransactionId?: string;
    readonly lineageBindingDigest?: string;
  },
): TreasuryExactAttemptIdentity | null {
  return treasuryExactAttemptIdentityOfFacts(
    authority.transactionId,
    {
      digest: authority.digest,
      ...(authority.contractDigest !== undefined ? { contractDigest: authority.contractDigest } : {}),
      ...(authority.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: authority.authorizationCohortDigest } : {}),
      ...(authority.durableIdentityDigest !== undefined ? { durableIdentityDigest: authority.durableIdentityDigest } : {}),
      ...(authority.lowlevelSource !== undefined ? { lowlevelSource: authority.lowlevelSource } : {}),
      ...(authority.lineageId !== undefined ? { lineageId: authority.lineageId } : {}),
      ...(authority.lineageGeneration !== undefined ? { lineageGeneration: authority.lineageGeneration } : {}),
      ...(authority.parentTransactionId !== undefined ? { parentTransactionId: authority.parentTransactionId } : {}),
      ...(authority.lineageBindingDigest !== undefined ? { lineageBindingDigest: authority.lineageBindingDigest } : {}),
    },
    treasuryProofClassOfAuthorityLevel(authority.authorityLevel),
  );
}

/**
 * resolution tombstone 的 exact 视图（proofLevel 即 proof class；lineage
 * proof v7 起整体透传）。
 */
export function treasuryExactAttemptIdentityOfTombstone(
  tombstone: {
    readonly transactionId: string;
    readonly digest: string;
    readonly proofLevel: string;
    readonly contractDigest?: string;
    readonly authorizationCohortDigest?: string;
    readonly durableIdentityDigest?: string;
    readonly lowlevelSource?: string;
    readonly lineageId?: string;
    readonly lineageGeneration?: number;
    readonly parentTransactionId?: string;
    readonly lineageBindingDigest?: string;
  },
): TreasuryExactAttemptIdentity | null {
  const proofClass: TreasuryAttemptProofClass =
    tombstone.proofLevel === "lowlevel" ? "lowlevel" : tombstone.proofLevel === "identity-bound" ? "identity-bound" : "legacy";
  return treasuryExactAttemptIdentityOfFacts(tombstone.transactionId, tombstone, proofClass);
}

/**
 * 对称 relation（两个规范视图的平权比较——与 identityProof 的
 * proof→attempt 单向语义互补）：
 * - transactionId / digest / proofClass 不同 → conflict（不同 attempt / class
 *   矛盾）；
 * - tr1_ 一方缺 lineage（视图构造不完整）→ insufficient；非 tr1_ 一方携带
 *   lineage → conflict（构造器已挡——防御）；
 * - 任一可选 identity 维度一方携带一方缺失 → insufficient（视图不完整，
 *   不得互相证明）；双方携带但不等 → conflict。
 */
export function treasuryExactAttemptIdentityRelation(
  left: TreasuryExactAttemptIdentity,
  right: TreasuryExactAttemptIdentity,
): "match" | "conflict" | "insufficient" {
  if (left.transactionId !== right.transactionId) return "conflict";
  if (left.digest !== right.digest) return "conflict";
  if (left.proofClass !== right.proofClass) return "conflict";
  const isRearm = isTreasuryRearmAttemptId(left.transactionId);
  const lineageOf = (view: TreasuryExactAttemptIdentity): boolean =>
    view.lineageId !== undefined && view.lineageGeneration !== undefined
    && view.parentTransactionId !== undefined && view.lineageBindingDigest !== undefined;
  const leftHasLineage = lineageOf(left);
  const rightHasLineage = lineageOf(right);
  if (isRearm) {
    if (!leftHasLineage || !rightHasLineage) return "insufficient";
    if (left.lineageId !== right.lineageId) return "conflict";
    if (left.lineageGeneration !== right.lineageGeneration) return "conflict";
    if (left.parentTransactionId !== right.parentTransactionId) return "conflict";
    if (left.lineageBindingDigest !== right.lineageBindingDigest) return "conflict";
  } else if (leftHasLineage || rightHasLineage) {
    return "conflict";
  }
  const optionalDimensions: readonly (keyof TreasuryExactAttemptIdentity)[] = [
    "contractDigest",
    "authorizationCohortDigest",
    "durableIdentityDigest",
    "lowlevelSource",
  ];
  for (const field of optionalDimensions) {
    const leftValue = left[field];
    const rightValue = right[field];
    if (leftValue === undefined && rightValue === undefined) continue;
    if (leftValue === undefined || rightValue === undefined) return "insufficient";
    if (leftValue !== rightValue) return "conflict";
  }
  return "match";
}
