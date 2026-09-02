/**
 * 【第二十二轮第六节】marker exact identity 单一权威。
 *
 * Round 21 及之前 marker 身份有三套近似表示并存（旧式嵌套
 * attemptIdentity、顶层 class-aware v2/v3 字段、调用方另行拼接的 proof
 * 字段），relation 只比较 binding 与 generation、不显式比较 lineageId，
 * 且 transactionId 不同 / identity 冲突 / proof 不足 / store 损坏全部折叠
 * 成 boolean false。本轮统一：
 *
 * - 新写 marker（protocol v4）绑定足以精确证明 attempt 的完整权威事实：
 *   transactionId / canonical digest / explicit identity profile /
 *   authority class / contract / cohort / durable identity（profile 适用
 *   时）/ lowlevel source（profile 适用时）/ lineage ID / generation /
 *   parent / binding / marker protocol 版本。fault phase / action kind /
 *   source 属于 marker 基础字段（writeFault 形状契约），不参与身份比较。
 * - 旧 marker（v1/v2/v3）保留兼容读取，但不得冒充 v4 exact marker：v3 按
 *   其协议携带的维度（digest/class/provenance/lineageId/binding/generation）
 *   比较；v2 在 tr1_ 场景因缺 lineageId 判 insufficient；v1（legacy）同
 *   transaction 无法证明 → insufficient；任何版本 transactionId 不同 →
 *   unrelated（属于其它 attempt——绝不删除）。
 * - relation 显式比较 lineageId、generation、parent（v4）与 binding——不
 *   依赖 binding 碰撞概率。
 * - legacy-replay / forensic-isolated profile 的 marker 不参与普通
 *   discharge（insufficient——显式 forensic / 人工通道）。
 */

import {
  type TreasuryIdentityProfile,
  treasuryIdentityProfileOfProofClass,
  treasuryProofClassOfIdentityProfile,
  validateTreasuryIdentityProfileFacts,
} from "@/runtime/treasury/identityProfile";

/** 新版 exact marker 协议版本（携带完整 attempt 权威事实）。 */
export const TREASURY_MARKER_EXACT_PROTOCOL = 4;

/** profile requiredness 检查的 digest 占位（digest 由 marker 基础字段承载）。 */
const DIGEST_REQUIRED_PLACEHOLDER = "0000000000000000";

/** v4 exact marker 的身份字段（写入侧由 treasuryMarkerExactIdentityOfFacts 构造）。 */
export interface TreasuryMarkerExactIdentityFields {
  readonly markerProtocol: 4;
  readonly identityProfile: TreasuryIdentityProfile;
  readonly authorityClass: "identity-bound" | "lowlevel" | "legacy" | "forensic";
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
}

/** relation 判定（六值——boolean 的歧义语义全部展开）。 */
export type TreasuryMarkerExactRelationKind =
  | "match"
  | "conflict"
  | "insufficient"
  | "unrelated"
  | "store_unhealthy";

export interface TreasuryMarkerExactRelation {
  readonly kind: TreasuryMarkerExactRelationKind;
  readonly detail: string;
  /** match 时的协议强度（v4 全维 / v3 携带维度——不冒充）。 */
  readonly protocol?: 3 | 4;
}

/** marker 的 class-aware 身份读取视图（readTreasuryWriteFault 快照即可）。 */
export interface TreasuryMarkerReadView {
  readonly transactionId: string;
  readonly digest: string;
  readonly markerProtocol?: number;
  readonly markerVersion?: number;
  readonly authorityClass?: string;
  readonly lowlevelSource?: string;
  readonly identityProfile?: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
  readonly attemptGeneration?: number;
  readonly attemptIdentity?: {
    readonly contractDigest?: string;
    readonly authorizationCohortDigest?: string;
    readonly durableIdentityDigest?: string;
  };
}

/**
 * marker 协议版本探测（v4 / v3 / v2 / v1 / malformed）。
 * v4 = 显式 markerProtocol 4；v3 = markerVersion 3 或携带 lineageId；
 * v2 = markerVersion 2 或任一顶层 class 字段；v1 = 基础字段 only。
 */
export function treasuryMarkerProtocolOf(marker: unknown): 1 | 2 | 3 | 4 | "malformed" {
  if (!marker || typeof marker !== "object") return "malformed";
  const candidate = marker as Partial<TreasuryMarkerReadView>;
  if (
    typeof candidate.transactionId !== "string" ||
    candidate.transactionId.length === 0 ||
    typeof candidate.digest !== "string" ||
    candidate.digest.length === 0
  ) {
    return "malformed";
  }
  if (candidate.markerProtocol === 4) return 4;
  if (candidate.markerProtocol !== undefined) return "malformed";
  if (candidate.markerVersion === 3 || candidate.lineageId !== undefined) return 3;
  if (
    candidate.markerVersion === 2 ||
    candidate.authorityClass !== undefined ||
    candidate.lowlevelSource !== undefined ||
    candidate.lineageBindingDigest !== undefined ||
    candidate.attemptGeneration !== undefined
  ) {
    return 2;
  }
  return 1;
}

/**
 * 从 attempt 权威事实构造 v4 exact marker 身份字段（写入调用方共用——
 * 不再手拼顶层/嵌套两套表示）。profile requiredness 不满足时返回 null
 * （调用方 fail closed：不写不完整 marker）。
 */
export function treasuryMarkerExactIdentityOfFacts(input: {
  readonly identityProfile: TreasuryIdentityProfile;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
}): TreasuryMarkerExactIdentityFields | null {
  const factsError = validateTreasuryIdentityProfileFacts(input.identityProfile, {
    contractDigest: input.contractDigest,
    authorizationCohortDigest: input.authorizationCohortDigest,
    durableIdentityDigest: input.durableIdentityDigest,
    lowlevelSource: input.lowlevelSource,
    // digest 由 marker 基础字段承载（写入调用方必填，形状校验强制）——
    // 此处以占位值通过 requiredness 的 digest 检查。
    digest: DIGEST_REQUIRED_PLACEHOLDER,
  });
  if (factsError !== null) return null;
  const authorityClass = treasuryProofClassOfIdentityProfile(input.identityProfile);
  return {
    markerProtocol: TREASURY_MARKER_EXACT_PROTOCOL,
    identityProfile: input.identityProfile,
    authorityClass: authorityClass as TreasuryMarkerExactIdentityFields["authorityClass"],
    ...(input.contractDigest !== undefined ? { contractDigest: input.contractDigest } : {}),
    ...(input.authorizationCohortDigest !== undefined
      ? { authorizationCohortDigest: input.authorizationCohortDigest }
      : {}),
    ...(input.durableIdentityDigest !== undefined ? { durableIdentityDigest: input.durableIdentityDigest } : {}),
    ...(input.lowlevelSource !== undefined ? { lowlevelSource: input.lowlevelSource } : {}),
    ...(input.lineageId !== undefined ? { lineageId: input.lineageId } : {}),
    ...(input.lineageGeneration !== undefined ? { lineageGeneration: input.lineageGeneration } : {}),
    ...(input.parentTransactionId !== undefined ? { parentTransactionId: input.parentTransactionId } : {}),
    ...(input.lineageBindingDigest !== undefined ? { lineageBindingDigest: input.lineageBindingDigest } : {}),
  };
}

/**
 * marker exact relation（单一权威）：
 *
 * - marker 非对象 / 基础字段 malformed → store_unhealthy；
 * - transactionId 不同 → unrelated（marker 属于其它 attempt——不删除）；
 * - transactionId 相同但 digest / class / profile / contract / cohort /
 *   durable / lowlevel source / lineageId / generation / parent / binding
 *   任一冲突 → conflict（不清理、不 finalize）；
 * - v4 requiredness 缺失 / v2/v1 无法证明 / legacy-replay 或 forensic
 *   profile → insufficient（保留 marker，fail closed）；
 * - v3 marker 按其协议维度比较（不携带的维度不冒充证明）。
 */
export function treasuryMarkerExactIdentityRelation(
  expected: {
    readonly transactionId: string;
    readonly digest: string;
    readonly proofClass: string;
    readonly identityProfile: TreasuryIdentityProfile;
    readonly contractDigest?: string;
    readonly authorizationCohortDigest?: string;
    readonly durableIdentityDigest?: string;
    readonly lowlevelSource?: string;
    readonly lineageId?: string;
    readonly lineageGeneration?: number;
    readonly parentTransactionId?: string;
    readonly lineageBindingDigest?: string;
  },
  marker: unknown,
): TreasuryMarkerExactRelation {
  const protocol = treasuryMarkerProtocolOf(marker);
  if (protocol === "malformed") {
    return { kind: "store_unhealthy", detail: "marker 基础字段 malformed（exact relation 不可判定）" };
  }
  const view = marker as TreasuryMarkerReadView;
  if (view.transactionId !== expected.transactionId) {
    return {
      kind: "unrelated",
      detail: `marker 属于其它 transaction ${view.transactionId.slice(0, 12)}…（不删除——global write lock 保留）`,
    };
  }
  if (view.digest !== expected.digest) {
    return { kind: "conflict", detail: "同 transaction marker 的 canonical digest 不一致" };
  }
  if (protocol === 4) {
    const profileError = validateTreasuryIdentityProfileFacts(
      expected.identityProfile,
      {
        digest: expected.digest,
        contractDigest: view.contractDigest,
        authorizationCohortDigest: view.authorizationCohortDigest,
        durableIdentityDigest: view.durableIdentityDigest,
        lowlevelSource: view.lowlevelSource,
      },
    );
    // marker 侧 requiredness 缺失 → insufficient（不猜测）；forbidden 携带 → conflict。
    if (profileError !== null) {
      const forbidden = profileError.includes("forbidden") || profileError.includes("矛盾");
      return {
        kind: forbidden ? "conflict" : "insufficient",
        detail: `marker v4 身份字段与 ${expected.identityProfile} profile 矩阵不符: ${profileError}`,
      };
    }
    if (view.identityProfile !== expected.identityProfile) {
      return { kind: "conflict", detail: `marker v4 identity profile 不一致（${String(view.identityProfile)} vs ${expected.identityProfile}）` };
    }
    if (view.authorityClass !== expected.proofClass) {
      return { kind: "conflict", detail: `marker v4 authority class 不一致（${String(view.authorityClass)} vs ${expected.proofClass}）` };
    }
    for (const field of ["contractDigest", "authorizationCohortDigest", "durableIdentityDigest", "lowlevelSource"] as const) {
      const markerValue = view[field];
      const expectedValue = expected[field];
      if (markerValue === undefined || expectedValue === undefined) continue;
      if (markerValue !== expectedValue) {
        return { kind: "conflict", detail: `marker v4 ${field} 不一致` };
      }
    }
    return compareLineageDimensions(expected, view, true);
  }
  // v3 / v2 / v1 兼容读取（不冒充 exact marker）。
  if (view.authorityClass !== undefined && view.authorityClass !== expected.proofClass) {
    return { kind: "conflict", detail: `marker ${String(protocol)} authority class 不一致（${view.authorityClass} vs ${expected.proofClass}）` };
  }
  if (expected.proofClass === "lowlevel" && view.lowlevelSource !== undefined && view.lowlevelSource !== expected.lowlevelSource) {
    return { kind: "conflict", detail: "marker lowlevelSource 不一致（runtime 与 migrated 互不证明）" };
  }
  if (expected.proofClass !== "lowlevel" && expected.proofClass !== "legacy" && view.lowlevelSource !== undefined) {
    return { kind: "conflict", detail: "identity-bound marker 携带 lowlevelSource（class 矛盾）" };
  }
  // 嵌套 attemptIdentity（旧 forensic ledger 写入）：携带的维度参与比较。
  const nestedContract = view.attemptIdentity?.contractDigest;
  const nestedCohort = view.attemptIdentity?.authorizationCohortDigest;
  const nestedDurable = view.attemptIdentity?.durableIdentityDigest;
  for (const [markerValue, expectedValue, field] of [
    [nestedContract, expected.contractDigest, "attemptIdentity.contractDigest"],
    [nestedCohort, expected.authorizationCohortDigest, "attemptIdentity.authorizationCohortDigest"],
    [nestedDurable, expected.durableIdentityDigest, "attemptIdentity.durableIdentityDigest"],
  ] as const) {
    if (markerValue !== undefined && expectedValue !== undefined && markerValue !== expectedValue) {
      return { kind: "conflict", detail: `marker ${field} 不一致` };
    }
  }
  if (protocol === 3) {
    return compareLineageDimensions(expected, view, false);
  }
  if (protocol === 2) {
    // v2 无 lineageId：tr1_ 场景无法绑定链 → insufficient（保守）。
    if (expected.lineageId !== undefined) {
      return { kind: "insufficient", detail: "v2 marker 缺少 lineageId（tr1_ attempt 无法绑定链——不猜测）" };
    }
    if (view.attemptGeneration !== undefined) {
      return { kind: "conflict", detail: "initial attempt 的 v2 marker 携带 generation（维度矛盾）" };
    }
    if (view.lineageBindingDigest !== undefined) {
      return { kind: "conflict", detail: "initial attempt 的 v2 marker 携带 binding（维度矛盾）" };
    }
    return { kind: "match", detail: "v2 marker class-aware 维度一致（协议 v2 语义）" };
  }
  // v1：legacy marker 同 transaction 无法证明 → insufficient。
  return { kind: "insufficient", detail: "v1 legacy marker 同 transaction 无法证明 exact identity（不猜测）" };
}

/** lineage 维度比较（v4 全维；v3 按携带维度——parent 除外，v3 无该字段）。 */
function compareLineageDimensions(
  expected: {
    readonly lineageId?: string;
    readonly lineageGeneration?: number;
    readonly parentTransactionId?: string;
    readonly lineageBindingDigest?: string;
  },
  view: TreasuryMarkerReadView,
  full: boolean,
): TreasuryMarkerExactRelation {
  if (expected.lineageId !== undefined) {
    if (view.lineageId === undefined) {
      return { kind: "insufficient", detail: "marker 缺少 lineageId（tr1_ attempt 无法绑定链）" };
    }
    if (view.lineageId !== expected.lineageId) {
      return { kind: "conflict", detail: "marker lineageId 不一致（显式链维度——不依赖 binding 碰撞概率）" };
    }
  } else if (view.lineageId !== undefined) {
    return { kind: "conflict", detail: "initial attempt marker 携带 lineageId（链维度矛盾）" };
  }
  const markerGeneration = view.lineageGeneration ?? view.attemptGeneration;
  // generation 0（root 代）是平凡维度——恒为 0 且无 parent/binding，expected
  // 携带 0 不构成 marker 必须携带的要求（携带了则参与比较）。
  const expectedGeneration = expected.lineageGeneration === 0 ? undefined : expected.lineageGeneration;
  if (expectedGeneration !== undefined) {
    if (markerGeneration === undefined) {
      return { kind: "insufficient", detail: "marker 缺少 attempt generation" };
    }
    if (markerGeneration !== expectedGeneration) {
      return { kind: "conflict", detail: "marker attempt generation 不一致" };
    }
  } else if (markerGeneration !== undefined && markerGeneration !== 0) {
    return { kind: "conflict", detail: "initial attempt marker 携带 generation（维度矛盾）" };
  }
  if (expected.lineageBindingDigest !== undefined) {
    if (view.lineageBindingDigest === undefined) {
      return { kind: "insufficient", detail: "marker 缺少 lineageBindingDigest" };
    }
    if (view.lineageBindingDigest !== expected.lineageBindingDigest) {
      return { kind: "conflict", detail: "marker lineageBindingDigest 不一致" };
    }
  } else if (view.lineageBindingDigest !== undefined) {
    return { kind: "conflict", detail: "initial attempt marker 携带 binding（维度矛盾）" };
  }
  if (full) {
    // v4 显式比较 parent（v3 无该字段——不冒充）。
    if (expected.parentTransactionId !== undefined) {
      if (view.parentTransactionId === undefined) {
        return { kind: "insufficient", detail: "marker v4 缺少 parentTransactionId（exact parent 不可证明）" };
      }
      if (view.parentTransactionId !== expected.parentTransactionId) {
        return { kind: "conflict", detail: "marker v4 parentTransactionId 不一致" };
      }
    } else if (view.parentTransactionId !== undefined) {
      return { kind: "conflict", detail: "initial attempt marker v4 携带 parent（维度矛盾）" };
    }
    return { kind: "match", detail: "marker v4 exact identity 全维一致", protocol: 4 };
  }
  return { kind: "match", detail: "marker v3 class-aware lineage 维度一致（协议 v3 语义）", protocol: 3 };
}

/** expected 的 profile/class 互验（构造 expected 的调用方防错用）。 */
export function treasuryMarkerExpectedProfileOfClass(
  proofClass: string,
): TreasuryIdentityProfile | null {
  return treasuryIdentityProfileOfProofClass(proofClass);
}
