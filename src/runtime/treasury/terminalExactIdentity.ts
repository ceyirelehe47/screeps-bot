/**
 * 【第二十一轮第七节】terminal exact identity 单一 canonical 表示。
 *
 * Round 20 的 terminal summary 只保存 finalAttemptId / finalGeneration /
 * authorityClass 外壳——压缩后无法证明 "当前 proof 就是被压缩掉的最终
 * attempt"。本模块定义 summary v3 持久化的 root / final exact identity 的
 * canonical 形状、构造与验证：
 *
 * - root exact：canonical rootIdentityDigest（单一五元算法——digest/contract/
 *   cohort/durable/lowlevelSource，缺省维度按空串；不再保留"双口径任一匹配"
 *   的永久语义）+ root proof class + root lowlevel provenance + identity
 *   算法版本；
 * - final exact：最终 attempt 的完整身份维度（digest/contract/cohort/durable/
 *   lowlevelSource/proof class + generation≥1 的 parent/binding + 可选
 *   retrySemanticDigest）+ exact identity schema 版本；
 * - 旧 v1/v2 summary（无 exact 字段）：replay-only——保留 root 永久重放门禁，
 *   不得证明 terminal current、不得授权新 Receipt 写入 / committed resolution /
 *   historical child 驱逐（语义由 semanticLineageValidation / verdict 消费方
 *   按 finalExact 缺失 fail closed 承载）；
 * - 幂等：同 root 已有 summary 时，全部 exact 字段一致才允许幂等压缩补完成。
 *
 * 无副作用；不 import lineageRetirementSummary（该模块 import 本模块——
 * 单向依赖；summary 类型用结构化视图承载）。
 */

import {
  treasuryExactAttemptIdentityOfFacts,
  treasuryExactAttemptIdentityRelation,
  type TreasuryExactAttemptIdentity,
  type TreasuryAttemptProofClass,
} from "@/runtime/treasury/exactAttemptIdentity";

/** root exact identity 的 canonical 算法版本（升级时递增——新旧不互证）。 */
export const TREASURY_TERMINAL_ROOT_IDENTITY_ALGORITHM = "root-identity@v1" as const;

/** final exact identity 的 schema 版本。 */
export const TREASURY_TERMINAL_EXACT_IDENTITY_SCHEMA = 1;

/** lineage authority class（与 attemptLineage 的两枚举一致）。 */
export type TreasuryTerminalAuthorityClass = "identity-bound" | "lowlevel";

/** summary v3 持久化的 root exact identity（canonical root authority）。 */
export interface TreasuryTerminalRootExactIdentity {
  readonly digest: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly proofClass: TreasuryTerminalAuthorityClass;
  /** canonical 合成算法版本（rootIdentityDigest 的口径声明）。 */
  readonly identityAlgorithm: typeof TREASURY_TERMINAL_ROOT_IDENTITY_ALGORITHM;
}

/** summary v3 持久化的 final attempt exact identity。 */
export interface TreasuryTerminalFinalExactIdentity {
  readonly digest: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly proofClass: TreasuryTerminalAuthorityClass;
  /** generation≥1 必填（final 代 parent / binding）。 */
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
  readonly retrySemanticDigest?: string;
  readonly exactIdentitySchema: typeof TREASURY_TERMINAL_EXACT_IDENTITY_SCHEMA;
}

/** summary 的最小结构化视图（lineageRetirementSummary 的 v3 entry 兼容）。 */
export interface TreasuryTerminalSummaryView {
  readonly schemaVersion: number;
  readonly lineageId: string;
  readonly rootTransactionId: string;
  readonly rootIdentityDigest: string;
  readonly finalGeneration: number;
  readonly finalAttemptId: string;
  readonly terminalState: string;
  readonly authorityClass?: TreasuryTerminalAuthorityClass;
  readonly rootExact?: TreasuryTerminalRootExactIdentity;
  readonly finalExact?: TreasuryTerminalFinalExactIdentity;
}

const DIGEST_PATTERN = /^[0-9a-f]{16}$/;

/** root exact 的形状校验（summary shape 的组成部分——返回 null = 合法）。 */
export function validateTreasuryTerminalRootExactShape(root: unknown): string | null {
  if (!root || typeof root !== "object") return "rootExact 非对象";
  const candidate = root as Partial<TreasuryTerminalRootExactIdentity>;
  if (typeof candidate.digest !== "string" || !DIGEST_PATTERN.test(candidate.digest)) return "rootExact.digest 非法（须 16 小写 hex）";
  for (const field of ["contractDigest", "authorizationCohortDigest", "durableIdentityDigest"] as const) {
    const value = candidate[field];
    if (value !== undefined && (typeof value !== "string" || !DIGEST_PATTERN.test(value))) return `rootExact.${field} 非法（须 16 小写 hex）`;
  }
  if (candidate.lowlevelSource !== undefined && typeof candidate.lowlevelSource !== "string") return "rootExact.lowlevelSource 非字符串";
  if (candidate.proofClass !== "identity-bound" && candidate.proofClass !== "lowlevel") {
    return `rootExact.proofClass 非法: ${String(candidate.proofClass)}`;
  }
  if (candidate.proofClass === "lowlevel" && candidate.lowlevelSource === undefined) return "lowlevel rootExact 缺 lowlevelSource（provenance 不可证明）";
  if (candidate.proofClass === "identity-bound" && candidate.lowlevelSource !== undefined) return "identity-bound rootExact 不得携带 lowlevelSource（class 矛盾）";
  if (candidate.identityAlgorithm !== TREASURY_TERMINAL_ROOT_IDENTITY_ALGORITHM) {
    return `rootExact.identityAlgorithm 未知（${String(candidate.identityAlgorithm)}——fail closed，不猜测口径）`;
  }
  return null;
}

/** final exact 的形状校验（summary shape 的组成部分——返回 null = 合法）。 */
export function validateTreasuryTerminalFinalExactShape(
  final: unknown,
  finalGeneration: number,
): string | null {
  if (!final || typeof final !== "object") return "finalExact 非对象";
  const candidate = final as Partial<TreasuryTerminalFinalExactIdentity>;
  if (typeof candidate.digest !== "string" || !DIGEST_PATTERN.test(candidate.digest)) return "finalExact.digest 非法（须 16 小写 hex）";
  for (const field of ["contractDigest", "authorizationCohortDigest", "durableIdentityDigest", "retrySemanticDigest"] as const) {
    const value = candidate[field];
    if (value !== undefined && (typeof value !== "string" || !DIGEST_PATTERN.test(value))) return `finalExact.${field} 非法（须 16 小写 hex）`;
  }
  if (candidate.lowlevelSource !== undefined && typeof candidate.lowlevelSource !== "string") return "finalExact.lowlevelSource 非字符串";
  if (candidate.proofClass !== "identity-bound" && candidate.proofClass !== "lowlevel") {
    return `finalExact.proofClass 非法: ${String(candidate.proofClass)}`;
  }
  if (candidate.exactIdentitySchema !== TREASURY_TERMINAL_EXACT_IDENTITY_SCHEMA) {
    return `finalExact.exactIdentitySchema 未知（${String(candidate.exactIdentitySchema)}——fail closed）`;
  }
  if (candidate.proofClass === "lowlevel" && candidate.lowlevelSource === undefined) return "lowlevel finalExact 缺 lowlevelSource（provenance 不可证明）";
  if (candidate.proofClass === "identity-bound" && candidate.lowlevelSource !== undefined) return "identity-bound finalExact 不得携带 lowlevelSource（class 矛盾）";
  if (finalGeneration >= 1) {
    if (candidate.parentTransactionId === undefined || candidate.lineageBindingDigest === undefined) {
      return "finalGeneration≥1 的 finalExact 缺 parentTransactionId/lineageBindingDigest（final rearm attempt 身份不完整）";
    }
    if (typeof candidate.parentTransactionId !== "string" || candidate.parentTransactionId.length === 0) return "finalExact.parentTransactionId 非法";
    if (typeof candidate.lineageBindingDigest !== "string" || !DIGEST_PATTERN.test(candidate.lineageBindingDigest)) return "finalExact.lineageBindingDigest 非法（须 16 小写 hex）";
  } else if (candidate.parentTransactionId !== undefined || candidate.lineageBindingDigest !== undefined) {
    return "finalGeneration=0（root 代）的 finalExact 不得携带 parent/binding";
  }
  return null;
}

/**
 * 从 summary 视图提取 final exact identity（旧 summary / 形状非法 → null——
 * 调用方按 replay-only fail closed，不猜测）。
 */
export function treasuryTerminalFinalExactOfSummary(
  summary: Pick<TreasuryTerminalSummaryView, "schemaVersion" | "finalExact" | "finalGeneration" | "finalAttemptId" | "lineageId">,
): (TreasuryFinalExactView & { readonly finalExact: TreasuryTerminalFinalExactIdentity }) | null {
  if (summary.finalExact === undefined || summary.schemaVersion < 3) return null;
  if (validateTreasuryTerminalFinalExactShape(summary.finalExact, summary.finalGeneration) !== null) return null;
  const exactIdentity = treasuryExactAttemptIdentityOfFacts(
    summary.finalAttemptId,
    {
      digest: summary.finalExact.digest,
      ...(summary.finalExact.contractDigest !== undefined ? { contractDigest: summary.finalExact.contractDigest } : {}),
      ...(summary.finalExact.authorizationCohortDigest !== undefined
        ? { authorizationCohortDigest: summary.finalExact.authorizationCohortDigest }
        : {}),
      ...(summary.finalExact.durableIdentityDigest !== undefined ? { durableIdentityDigest: summary.finalExact.durableIdentityDigest } : {}),
      ...(summary.finalExact.lowlevelSource !== undefined ? { lowlevelSource: summary.finalExact.lowlevelSource } : {}),
      ...(summary.finalGeneration >= 1
        ? {
            lineageId: summary.lineageId,
            lineageGeneration: summary.finalGeneration,
            parentTransactionId: summary.finalExact.parentTransactionId!,
            lineageBindingDigest: summary.finalExact.lineageBindingDigest!,
          }
        : {}),
    },
    summary.finalExact.proofClass,
  );
  if (exactIdentity === null) return null;
  return { exactIdentity, finalExact: summary.finalExact };
}

/** 便于消费的 final exact 视图（exact identity + 持久外壳）。 */
export interface TreasuryFinalExactView {
  readonly exactIdentity: TreasuryExactAttemptIdentity;
}

/**
 * final exact 与调用方 attempt 的 proof-class-aware 比较（terminal current
 * semantic validation 的核心）：null = match；否则有界错误（conflict /
 * insufficient 语义由 detail 承载，调用方按语义归类）。
 */
export function treasuryTerminalFinalExactRelation(
  summary: Pick<TreasuryTerminalSummaryView, "schemaVersion" | "finalExact" | "finalGeneration" | "finalAttemptId" | "lineageId">,
  attempt: TreasuryExactAttemptIdentity,
): "match" | "conflict" | "insufficient" {
  const view = treasuryTerminalFinalExactOfSummary(summary);
  if (view === null) {
    return "insufficient";
  }
  if (attempt.proofClass === "legacy" || view.exactIdentity.proofClass === "legacy") {
    return "conflict";
  }
  return treasuryTerminalExactIdentityRelation(view.exactIdentity, attempt);
}

/**
 * 两个规范 exact identity 视图的平权 relation（本模块与 exactAttemptIdentity
 * 的 relation 同语义——terminal 语义下 proofClass=legacy 一律冲突）。独立导出
 * 供 summary 幂等比较复用。
 */
export function treasuryTerminalExactIdentityRelation(
  left: TreasuryExactAttemptIdentity,
  right: TreasuryExactAttemptIdentity,
): "match" | "conflict" | "insufficient" {
  if (left.proofClass === "legacy" || right.proofClass === "legacy") return "conflict";
  // 复用 exactAttemptIdentity 的对称 relation（单一比较实现——terminal 语义
  // 只额外收紧 legacy class 一律冲突）。
  return treasuryExactAttemptIdentityRelation(left, right);
}

/** proof class 的受控窄化（legacy 不属于 terminal authority——防御性收窄）。 */
export function treasuryTerminalAuthorityClassOf(proofClass: TreasuryAttemptProofClass): TreasuryTerminalAuthorityClass | null {
  return proofClass === "identity-bound" || proofClass === "lowlevel" ? proofClass : null;
}
