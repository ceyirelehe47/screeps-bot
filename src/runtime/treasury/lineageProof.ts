/**
 * 【第十九轮 A/G】lineage proof 单一权威——presence / relation / required 矩阵。
 *
 * Round 18 把四字段 proof 传进了各 store（intent / quarantine / receipt /
 * tombstone / marker），但 committed resolution 主链的各环节（unresolved
 * authority 归一化、capability 绑定、refresh、三方 verifier、marker 清除、
 * chain_committed 推进）各自实现"存在性 + 比较逻辑"或根本没有实现。本模块
 * 收敛这些判定，供全部环节复用（不得在 facade / faultResolution / receipts /
 * committedProofVerifier 各自实现近似算法）。
 *
 * 语义（任务书总原则 2）：
 * - 完整 proof = lineageId / lineageGeneration / parentTransactionId /
 *   lineageBindingDigest 四字段**整体存在或整体缺失**（部分存在 = 形状异常）；
 * - tr1_ rearm attempt 必须携带完整 proof；initial attempt 禁止携带；
 * - 同 transactionId 但 lineage / generation / parent / binding 任一不同 →
 *   conflict；generation N 的证明不能证明 N+1；parent proof 不能证明 child；
 * - 缺字段只能判 insufficient / 错误，不得 match。
 */

import { isValidTreasuryTransactionId } from "@/runtime/treasury/transactionId";

/** 完整 lineage proof（rearm attempt 的共同事实视图）。 */
export interface TreasuryLineageProofFacts {
  readonly lineageId: string;
  readonly lineageGeneration: number;
  readonly parentTransactionId: string;
  readonly lineageBindingDigest: string;
}

/** proof 携带方的最小字段视图（intent / quarantine / receipt / tombstone / capability）。 */
export type TreasuryLineageProofCarrier = {
  readonly lineageId?: unknown;
  readonly lineageGeneration?: unknown;
  readonly parentTransactionId?: unknown;
  readonly lineageBindingDigest?: unknown;
};

const LINEAGE_PROOF_DIGEST_PATTERN = /^[0-9a-f]{16}$/;

/** tr1_ rearm attempt ID 判定（transaction ID 协议前缀——required 矩阵输入）。 */
export function treasuryLineageProofRequiredForTransaction(transactionId: string): boolean {
  return typeof transactionId === "string" && transactionId.startsWith("tr1_");
}

/**
 * 从 entry 提取 proof：四字段全部存在且形状合法 → facts；全部缺失 →
 * undefined；部分存在或形状非法 → "partial"（形状异常——fail closed 输入）。
 */
export function treasuryLineageProofOfEntry(entry: TreasuryLineageProofCarrier): TreasuryLineageProofFacts | "partial" | undefined {
  const hasLineageId = entry.lineageId !== undefined;
  const hasGeneration = entry.lineageGeneration !== undefined;
  const hasParent = entry.parentTransactionId !== undefined;
  const hasBinding = entry.lineageBindingDigest !== undefined;
  if (!hasLineageId && !hasGeneration && !hasParent && !hasBinding) return undefined;
  if (!hasLineageId || !hasGeneration || !hasParent || !hasBinding) return "partial";
  const { lineageId, lineageGeneration, parentTransactionId, lineageBindingDigest } = entry as Required<TreasuryLineageProofCarrier>;
  if (
    typeof lineageId !== "string" || !LINEAGE_PROOF_DIGEST_PATTERN.test(lineageId) ||
    typeof lineageGeneration !== "number" || !Number.isSafeInteger(lineageGeneration) || lineageGeneration < 1 ||
    typeof parentTransactionId !== "string" || !isValidTreasuryTransactionId(parentTransactionId) ||
    typeof lineageBindingDigest !== "string" || !LINEAGE_PROOF_DIGEST_PATTERN.test(lineageBindingDigest)
  ) {
    return "partial";
  }
  return { lineageId, lineageGeneration, parentTransactionId, lineageBindingDigest };
}

/**
 * authority/proof 携带方相对其 transactionId 的 proof 形状验证（unified
 * resolver 单侧与双侧共用）：tr1_ → 必须完整；非 tr1_ → 必须全缺失。
 * 返回 null = 形状合法（完整或合法缺失）。
 */
export function treasuryLineageProofShapeErrorForTransaction(
  transactionId: string,
  entry: TreasuryLineageProofCarrier,
  label: string,
): string | null {
  const proof = treasuryLineageProofOfEntry(entry);
  if (treasuryLineageProofRequiredForTransaction(transactionId)) {
    if (proof === undefined) {
      return `${label} 是 tr1_ rearm attempt 但缺少完整 lineage proof（lineageId/generation/parent/binding 必填——不得当普通 attempt 归一化）`;
    }
    if (proof === "partial") {
      return `${label} 的 lineage proof 部分存在或形状非法（四字段必须整体存在——store 形态异常）`;
    }
    return null;
  }
  if (proof === "partial") {
    return `${label} 是 initial attempt 但 lineage proof 部分存在（形状异常——fail closed）`;
  }
  if (proof !== undefined) {
    return `${label} 是 initial attempt 但携带 lineage proof（tr1_ 专属字段不得出现在 initial attempt）`;
  }
  return null;
}

/** 完整 proof 的四字段 relation（任一不同 → conflict；输入必为完整 facts）。 */
export function treasuryLineageProofRelation(
  expected: TreasuryLineageProofFacts,
  actual: TreasuryLineageProofFacts,
): "match" | "conflict" {
  return expected.lineageId === actual.lineageId &&
      expected.lineageGeneration === actual.lineageGeneration &&
      expected.parentTransactionId === actual.parentTransactionId &&
      expected.lineageBindingDigest === actual.lineageBindingDigest
    ? "match"
    : "conflict";
}
