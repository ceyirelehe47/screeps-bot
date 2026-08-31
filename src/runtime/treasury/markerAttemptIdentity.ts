/**
 * 【第十七轮第十四节】class-aware marker attempt identity——write-fault
 * marker v2 的身份比较单一权威。
 *
 * Round 16 及之前 marker 清除只依赖 transactionId + digest：runtime-lowlevel
 * marker 可清 migrated-lowlevel tombstone、parent marker 可被 child proof
 * 清除、modern marker 可被 lowlevel/legacy proof 清除。Round 17 起清除必须
 * 使用完整 class-aware attempt relation：
 *
 * - authority class 双方必须存在且一致（identity-bound / lowlevel；legacy/
 *   forensic marker 不可被普通 resolution 清除——显式 forensic 通道）；
 * - lowlevel class：lowlevelSource 双方必须携带且相等（runtime 与 migrated
 *   互不证明）；
 * - identity-bound：任一方携带 lowlevelSource 即矛盾（conflict）；
 * - lineage binding：marker 携带 binding 时 proof 必须携带且相等（parent
 *   marker 不得被 child proof 清除、不同 lineage 互不清除）；marker 不携带
 *   而 proof 携带 → conflict（child proof 不得清除 initial attempt marker）；
 * - attempt generation：双方都携带时必须相等；marker 携带而 proof 缺失 →
 *   insufficient。
 *
 * v1 marker（无 authorityClass）class 不可证明 → insufficient（保守不清除，
 * 绝不猜测 class）。
 */

/** marker / 清除 proof 的 class-aware 身份视图。 */
export interface TreasuryClassAwareAttemptIdentity {
  readonly transactionId: string;
  readonly digest: string;
  readonly authorityClass?: "identity-bound" | "lowlevel" | "legacy" | "forensic";
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly lineageBindingDigest?: string;
  readonly attemptGeneration?: number;
}

export type TreasuryClassAwareMarkerRelation = "match" | "conflict" | "insufficient";

/**
 * marker 与清除 proof 的 class-aware relation 判定（match 才允许清除）。
 * 永不抛出（malformed 输入 → insufficient——结构化拒绝，不中断 tick）。
 */
export function treasuryClassAwareMarkerRelation(
  marker: TreasuryClassAwareAttemptIdentity | undefined,
  proof: TreasuryClassAwareAttemptIdentity,
): TreasuryClassAwareMarkerRelation {
  if (marker === undefined || !marker || typeof marker !== "object") return "insufficient";
  if (!proof || typeof proof !== "object") return "insufficient";
  try {
    if (typeof marker.transactionId !== "string" || marker.transactionId !== proof.transactionId) return "conflict";
    if (typeof marker.digest !== "string" || marker.digest !== proof.digest) return "conflict";
    // authority class：双方必须可证明且一致。
    if (marker.authorityClass === undefined || proof.authorityClass === undefined) return "insufficient";
    if (marker.authorityClass !== proof.authorityClass) return "conflict";
    if (marker.authorityClass === "legacy" || marker.authorityClass === "forensic") {
      // legacy/forensic marker 不参与普通 class-aware 清除（显式 forensic 通道）。
      return "insufficient";
    }
    if (marker.authorityClass === "lowlevel") {
      if (marker.lowlevelSource === undefined || proof.lowlevelSource === undefined) return "insufficient";
      if (marker.lowlevelSource !== proof.lowlevelSource) return "conflict";
    } else {
      if (marker.lowlevelSource !== undefined || proof.lowlevelSource !== undefined) {
        return "conflict";
      }
    }
    // 现代身份 digest：marker 携带的每个成分 proof 必须同样携带且相等。
    for (const field of ["contractDigest", "authorizationCohortDigest", "durableIdentityDigest"] as const) {
      const markerValue = marker[field];
      if (markerValue !== undefined) {
        const proofValue = proof[field];
        if (proofValue === undefined) return "insufficient";
        if (proofValue !== markerValue) return "conflict";
      }
    }
    // lineage binding（parent/child 与跨 lineage 隔离维度）。
    if (marker.lineageBindingDigest !== undefined) {
      if (proof.lineageBindingDigest === undefined) return "insufficient";
      if (proof.lineageBindingDigest !== marker.lineageBindingDigest) return "conflict";
    } else if (proof.lineageBindingDigest !== undefined) {
      return "conflict";
    }
    // generation（rearm/lineage 代际维度）。
    if (marker.attemptGeneration !== undefined) {
      if (proof.attemptGeneration === undefined) return "insufficient";
      if (proof.attemptGeneration !== marker.attemptGeneration) return "conflict";
    }
    return "match";
  } catch {
    return "insufficient";
  }
}

/**
 * 从 authority/tombstone 事实构造清除 proof 的 class-aware identity
 * （authorityLevel → class 映射与 resolution proofLevel 映射一致）。
 */
export function classAwareIdentityOfAttempt(input: {
  readonly transactionId: string;
  readonly digest: string;
  readonly authorityLevel?: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly lineageBindingDigest?: string;
  readonly attemptGeneration?: number;
}): TreasuryClassAwareAttemptIdentity {
  const authorityClass =
    input.authorityLevel === "modern"
      ? ("identity-bound" as const)
      : input.authorityLevel === "lowlevel"
        ? ("lowlevel" as const)
        : input.authorityLevel === "legacy"
          ? ("legacy" as const)
          : input.authorityLevel === "forensic"
            ? ("forensic" as const)
            : undefined;
  return {
    transactionId: input.transactionId,
    digest: input.digest,
    ...(authorityClass !== undefined ? { authorityClass } : {}),
    ...(input.contractDigest !== undefined ? { contractDigest: input.contractDigest } : {}),
    ...(input.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: input.authorizationCohortDigest } : {}),
    ...(input.durableIdentityDigest !== undefined ? { durableIdentityDigest: input.durableIdentityDigest } : {}),
    ...(input.lowlevelSource !== undefined ? { lowlevelSource: input.lowlevelSource } : {}),
    ...(input.lineageBindingDigest !== undefined ? { lineageBindingDigest: input.lineageBindingDigest } : {}),
    ...(input.attemptGeneration !== undefined ? { attemptGeneration: input.attemptGeneration } : {}),
  };
}
