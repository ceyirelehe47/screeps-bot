/**
 * 【第二十一轮 11.3】generation retirement relation 单一权威。
 *
 * Round 20 之后仍有两个调用方各自展开 "exact proof ↔ tombstone ↔ record"
 * 的比较子集（lineageGenerationRetirement.compareGenerationProofWithTombstone
 * 只覆盖 proof↔tombstone，compaction 只检查 proof 存在性）。本模块把该
 * relation 收敛为唯一实现：任何以 exact generation retirement proof 作为
 * replacement / eviction / compaction 依据的安全关键路径都必须经
 * verifyTreasuryGenerationRetirementRelation，不得自行比较字段子集。
 *
 * 比较维度（任务书 11.3 全集）：
 * transactionId / lineage / generation / parent / binding（派生重算）/
 * digest / contract / cohort / durable / proof class / lowlevelSource /
 * root identity（rootTransactionId + rootIdentityDigest）/ resolution /
 * retirement 三段。三方中任一维度不同 → conflict；期望侧缺证明维度 →
 * insufficient；null = match。malformed/store-unhealthy 由外围承担。
 *
 * 无副作用、无 store 依赖（纯比较——输入由调用方读取）。
 */

import type { TreasuryExactAttemptIdentity } from "@/runtime/treasury/exactAttemptIdentity";

/** exact retirement proof 的最小结构化视图（generationRetirementAuthority 的 proof 兼容）。 */
export interface TreasuryGenerationRetirementProofView {
  readonly lineageId: string;
  readonly rootTransactionId: string;
  readonly rootIdentityDigest: string;
  readonly generation: number;
  readonly transactionId: string;
  readonly parentTransactionId?: string;
  readonly bindingDigest?: string;
  readonly digest: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly authorityClass: "identity-bound" | "lowlevel";
  readonly resolution: string;
  readonly retirement: { readonly lineagePublished: boolean; readonly authorityReleased: boolean; readonly markerCleaned: boolean };
}

/** tombstone 的最小结构化视图（resolutionStore tombstone 兼容）。 */
export interface TreasuryRetirementRelationTombstoneView {
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
}

export type TreasuryGenerationRetirementRelationResult =
  | { readonly verdict: "match" }
  | { readonly verdict: "conflict"; readonly detail: string }
  | { readonly verdict: "insufficient"; readonly detail: string };

/** 可选 identity 维度的三方比较（期望 / proof / tombstone 任一不一致即冲突）。 */
function compareOptionalDimensions(
  expected: TreasuryExactAttemptIdentity,
  proof: TreasuryGenerationRetirementProofView,
  tombstone: TreasuryRetirementRelationTombstoneView,
): string | null {
  const dimensions: readonly (readonly [string, string | undefined, string | undefined, string | undefined])[] = [
    ["contractDigest", expected.contractDigest, proof.contractDigest, tombstone.contractDigest],
    ["authorizationCohortDigest", expected.authorizationCohortDigest, proof.authorizationCohortDigest, tombstone.authorizationCohortDigest],
    ["durableIdentityDigest", expected.durableIdentityDigest, proof.durableIdentityDigest, tombstone.durableIdentityDigest],
    ["lowlevelSource", expected.lowlevelSource, proof.lowlevelSource, tombstone.lowlevelSource],
  ];
  for (const [field, expectedValue, proofValue, tombstoneValue] of dimensions) {
    if (expectedValue === undefined) {
      // 期望侧（权威 record）无该维度：proof/tombstone 携带即身份形态矛盾。
      if (proofValue !== undefined) return `exact retirement proof 携带 ${field} 但权威当前代无该维度（身份形态矛盾）`;
      if (tombstoneValue !== undefined) return `tombstone 携带 ${field} 但权威当前代无该维度（身份形态矛盾）`;
      continue;
    }
    if (proofValue === undefined) return `exact retirement proof 缺少权威当前代要求的 ${field}（身份不可证明）`;
    if (proofValue !== expectedValue) return `exact retirement proof 的 ${field} 与权威当前代不一致`;
    if (tombstoneValue !== undefined && tombstoneValue !== expectedValue) return `tombstone 的 ${field} 与权威当前代不一致`;
  }
  return null;
}

/**
 * generation retirement 三方 relation（exactProof ↔ expectedCurrent ↔ tombstone）：
 * 期望侧（record / summary 派生）先构造完整 exact identity（调用方经
 * currentLineageSettlementVerifier / terminalExactIdentity——本函数不重复
 * requiredness，只做三方比较）。任一维度不同 → conflict；proof 缺期望维度 →
 * insufficient；null = match。
 */
export function verifyTreasuryGenerationRetirementRelation(input: {
  readonly exactProof: TreasuryGenerationRetirementProofView;
  readonly expectedCurrent: TreasuryExactAttemptIdentity & {
    readonly rootTransactionId: string;
    readonly rootIdentityDigest: string;
    /** 权威 lineageId（gen0 的 exact identity 视图不带 lineage 四字段——独立显式承载）。 */
    readonly authorityLineageId: string;
    /** 权威 generation（同上——gen0 显式承载）。 */
    readonly authorityGeneration: number;
  };
  readonly tombstone: TreasuryRetirementRelationTombstoneView;
}): TreasuryGenerationRetirementRelationResult {
  const { exactProof, expectedCurrent, tombstone } = input;
  // ── root identity 绑定（proof 的 rootTransactionId/rootIdentityDigest 与期望一致）。
  if (exactProof.rootTransactionId !== expectedCurrent.rootTransactionId) {
    return { verdict: "conflict", detail: "exact retirement proof 的 rootTransactionId 与权威 lineage root 不一致" };
  }
  if (exactProof.rootIdentityDigest !== expectedCurrent.rootIdentityDigest) {
    return { verdict: "conflict", detail: "exact retirement proof 的 rootIdentityDigest 与权威 root identity 合成不一致" };
  }
  // ── lineage / generation / transactionId 三方。
  if (exactProof.lineageId !== expectedCurrent.authorityLineageId) {
    return { verdict: "conflict", detail: "exact retirement proof 的 lineageId 与权威 lineage 不一致" };
  }
  if (exactProof.generation !== expectedCurrent.authorityGeneration) {
    return { verdict: "conflict", detail: `exact retirement proof 的 generation ${String(exactProof.generation)} 与权威当前代 ${String(expectedCurrent.authorityGeneration)} 不一致` };
  }
  if (exactProof.transactionId !== expectedCurrent.transactionId) {
    return { verdict: "conflict", detail: "exact retirement proof 的 transactionId 与权威当前代 attempt 不一致" };
  }
  if (tombstone.transactionId !== expectedCurrent.transactionId) {
    return { verdict: "conflict", detail: "tombstone transactionId 与权威当前代 attempt 不一致" };
  }
  // ── parent / binding（gen≥1 必较；gen0 禁携带）。
  if (expectedCurrent.authorityGeneration >= 1) {
    if (exactProof.parentTransactionId === undefined || exactProof.bindingDigest === undefined) {
      return { verdict: "insufficient", detail: "generation≥1 的 exact retirement proof 缺 parent/binding（不可证明）" };
    }
    if (exactProof.parentTransactionId !== expectedCurrent.parentTransactionId) {
      return { verdict: "conflict", detail: "exact retirement proof 的 parentTransactionId 与权威当前代 parent 不一致" };
    }
    if (exactProof.bindingDigest !== expectedCurrent.lineageBindingDigest) {
      return { verdict: "conflict", detail: "exact retirement proof 的 bindingDigest 与权威当前代 binding 不一致" };
    }
    // tombstone 自身持久 parent 字段直接比较（不得只信 proof 内的 parent）。
    if (tombstone.parentTransactionId !== undefined && tombstone.parentTransactionId !== expectedCurrent.parentTransactionId) {
      return { verdict: "conflict", detail: "tombstone 持久 parentTransactionId 与权威当前代 parent 不一致（篡改/代际混用）" };
    }
    if (tombstone.lineageBindingDigest !== undefined && tombstone.lineageBindingDigest !== expectedCurrent.lineageBindingDigest) {
      return { verdict: "conflict", detail: "tombstone 持久 lineageBindingDigest 与权威当前代 binding 不一致" };
    }
  } else if (exactProof.parentTransactionId !== undefined || exactProof.bindingDigest !== undefined) {
    return { verdict: "conflict", detail: "generation 0（root 代）的 exact retirement proof 不得携带 parent/binding" };
  }
  // ── proof class（proof.authorityClass vs 期望 proofClass vs tombstone.proofLevel）。
  if (exactProof.authorityClass !== expectedCurrent.proofClass) {
    return { verdict: "conflict", detail: `exact retirement proof class ${String(exactProof.authorityClass)} 与权威 proof class ${String(expectedCurrent.proofClass)} 不匹配` };
  }
  if (tombstone.proofLevel !== expectedCurrent.proofClass) {
    return { verdict: "conflict", detail: `tombstone proof class ${String(tombstone.proofLevel)} 与权威 proof class ${String(expectedCurrent.proofClass)} 不匹配` };
  }
  // ── digest（三方）与可选 identity 维度（三方）。
  if (exactProof.digest !== expectedCurrent.digest) {
    return { verdict: "conflict", detail: "exact retirement proof 的 digest 与权威当前代 digest 不一致" };
  }
  if (tombstone.digest !== expectedCurrent.digest) {
    return { verdict: "conflict", detail: "tombstone digest 与权威当前代 digest 不一致" };
  }
  const dimensionError = compareOptionalDimensions(expectedCurrent, exactProof, tombstone);
  if (dimensionError !== null) return { verdict: "conflict", detail: dimensionError };
  // ── resolution / 三段（proof 形状强制——relation 防御性复核，不替代形状校验）。
  if (exactProof.resolution !== "not_executed") {
    return { verdict: "conflict", detail: `exact retirement proof 的 resolution ${String(exactProof.resolution)} 非 not_executed（exact retirement 只证明 not-executed 代）` };
  }
  if (!exactProof.retirement.lineagePublished || !exactProof.retirement.authorityReleased || !exactProof.retirement.markerCleaned) {
    return { verdict: "conflict", detail: "exact retirement proof 的 retirement 三段未全部为 true" };
  }
  return { verdict: "match" };
}

/**
 * exact retirement proof ↔ tombstone 的二元比较（历史代——没有 record current
 * 视图时，proof 自身是完整持久权威）：transactionId / parent（期望派生）/
 * binding（期望重算）/ proof class / digest 及 contract/cohort/durable/
 * lowlevel 维度 / tombstone 持久 parent 字段。null = 一致。
 * 【第二十一轮 12.2】tombstone 持久的 parentTransactionId 必须与期望 parent
 * 显式一致——缺失 = 不可证明（missing，调用方 pin）；不等 = conflict。
 */
export function compareTreasuryGenerationProofWithTombstone(
  proof: TreasuryGenerationRetirementProofView,
  tombstone: TreasuryRetirementRelationTombstoneView,
  expectedParent: string,
  expectedBinding: string | undefined,
): { readonly kind: "conflict" | "missing"; readonly detail: string } | null {
  if (proof.transactionId !== tombstone.transactionId) {
    return { kind: "conflict", detail: "exact retirement proof 的 transactionId 与 tombstone 不一致" };
  }
  if (proof.parentTransactionId !== undefined || proof.bindingDigest !== undefined) {
    if (proof.parentTransactionId !== expectedParent) {
      return { kind: "conflict", detail: "exact retirement proof 的 parentTransactionId 与上一代确定性派生不一致" };
    }
    if (expectedBinding === undefined || proof.bindingDigest !== expectedBinding) {
      return { kind: "conflict", detail: "exact retirement proof 的 bindingDigest 与权威重算不一致" };
    }
    // tombstone 自身持久 parent/binding 字段直接比较（缺失 = 不可证明）。
    if (tombstone.parentTransactionId === undefined) {
      return { kind: "missing", detail: "tombstone 缺持久 parentTransactionId（parent 维度不可省略——pin，不猜测）" };
    }
    if (tombstone.parentTransactionId !== expectedParent) {
      return { kind: "conflict", detail: "tombstone 持久 parentTransactionId 与上一代确定性派生不一致（篡改/代际混用）" };
    }
    if (tombstone.lineageBindingDigest !== undefined && tombstone.lineageBindingDigest !== expectedBinding) {
      return { kind: "conflict", detail: "tombstone 持久 lineageBindingDigest 与权威重算不一致" };
    }
  }
  if (proof.authorityClass !== tombstone.proofLevel) {
    return { kind: "conflict", detail: `exact retirement proof class ${String(proof.authorityClass)} 与 tombstone proof class ${String(tombstone.proofLevel)} 不匹配` };
  }
  if (proof.digest !== tombstone.digest) {
    return { kind: "conflict", detail: "exact retirement proof 的 digest 与 tombstone 不一致（完整 attempt identity 冲突）" };
  }
  if (
    (proof.contractDigest ?? undefined) !== (tombstone.contractDigest ?? undefined) ||
    (proof.authorizationCohortDigest ?? undefined) !== (tombstone.authorizationCohortDigest ?? undefined) ||
    (proof.durableIdentityDigest ?? undefined) !== (tombstone.durableIdentityDigest ?? undefined) ||
    (proof.lowlevelSource ?? undefined) !== (tombstone.lowlevelSource ?? undefined)
  ) {
    return { kind: "conflict", detail: "exact retirement proof 的 contract/cohort/durable/lowlevel identity 维度与 tombstone 不一致" };
  }
  return null;
}
