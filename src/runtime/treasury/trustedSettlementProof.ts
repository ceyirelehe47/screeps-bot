/**
 * 【第二十二轮第八节】trusted settlement proof——release 路径的 Receipt
 * 读取单一权威（attempt 绑定）。
 *
 * replay-readable（lookupTreasurySettledReceipt / readTreasurySettlementProof，
 * normalized lookup）只负责防重放与诊断：单键探测、容忍任意版本与无关
 * entry 损坏。任何释放 Authority / 关闭 Lineage / finalize committed
 * resolution / 压缩 Summary 的路径必须使用本模块（或经
 * currentSettlementCoordinator 复用）：
 *
 * - 先经 lookupTreasuryTrustedSettledReceipt 完成 store 整体 release 级
 *   验证（每 global 首次一次有界全表扫描，随后 O(1)）；
 * - trusted proof 与 expected attempt 的完整 exact identity 执行
 *   proof-class-aware relation（identity_conflict 单独分流——不折叠为
 *   absent）；
 * - legacy / store 损坏 / 缺失 → 结构化 fail closed（legacy_insufficient /
 *   store_unhealthy / absent）。
 */

import {
  lookupTreasuryTrustedSettledReceipt,
  type TreasurySettlementProof,
} from "@/runtime/treasury/receipts";
import {
  treasuryExactAttemptIdentityOfReceiptProof,
  treasuryExactAttemptIdentityRelation,
  type TreasuryExactAttemptIdentity,
} from "@/runtime/treasury/exactAttemptIdentity";

/** trusted settlement proof 读取结果（identity conflict 与 absent 分流）。 */
export type TreasuryTrustedSettlementProofForAttempt =
  | { readonly status: "trusted_proof"; readonly proof: TreasurySettlementProof }
  | { readonly status: "absent"; readonly detail: string }
  | { readonly status: "legacy_insufficient"; readonly detail: string }
  | { readonly status: "store_unhealthy"; readonly detail: string }
  | { readonly status: "identity_conflict"; readonly detail: string };

/**
 * release-trusted 读取（trusted proof 必须与 expected attempt 完整 exact
 * identity 一致）：Store 任一无关 entry 损坏时返回 store_unhealthy——
 * 不返回 trusted proof。
 */
export function readTreasuryTrustedSettlementProofForAttempt(
  transactionId: string,
  expected: TreasuryExactAttemptIdentity,
): TreasuryTrustedSettlementProofForAttempt {
  const lookup = lookupTreasuryTrustedSettledReceipt(transactionId);
  if (lookup.status === "store_unhealthy") return lookup;
  if (lookup.status === "legacy_insufficient") return lookup;
  if (lookup.status === "absent") {
    return { status: "absent", detail: "trusted receipt store 无该 entry（未结算）" };
  }
  const proofExact = treasuryExactAttemptIdentityOfReceiptProof(transactionId, lookup.proof);
  if (proofExact === null) {
    return { status: "legacy_insufficient", detail: "trusted proof 无法构造完整 exact attempt identity" };
  }
  const relation = treasuryExactAttemptIdentityRelation(proofExact, expected);
  if (relation === "conflict") {
    return { status: "identity_conflict", detail: "trusted receipt proof 与 expected attempt 的 exact identity 冲突（digest/class/contract/cohort/durable/lowlevel/lineage 任一维度）" };
  }
  if (relation === "insufficient") {
    return { status: "identity_conflict", detail: "trusted receipt proof 缺少 expected attempt 要求的身份维度（不可互相证明）" };
  }
  return { status: "trusted_proof", proof: lookup.proof };
}

/**
 * 相反结论检查（十六节）：committed 目标旁是否存在该 attempt 的
 * **not-executed 证明**——用于 compaction / committed finalize 前的显式
 * 相反 proof 拒绝（"目标结论 proof 存在"不等于"相反结论 proof 不存在"）。
 * 本函数只读；unresolved 权威结论由 coordinator 统一判定。
 */
export function peekTreasuryOppositeReceiptAbsence(
  transactionId: string,
): { readonly blocked: boolean; readonly detail: string } {
  const lookup = lookupTreasuryTrustedSettledReceipt(transactionId);
  // Receipt 层的"相反 proof"= committed proof 本身；not-executed 的相反
  // 检查由本函数的调用方（committed 目标时 absent 才放行）语义承载：
  // 这里统一暴露 store 健康性（损坏时不得放行任何方向的 finalize）。
  if (lookup.status === "store_unhealthy") {
    return { blocked: true, detail: lookup.detail };
  }
  return { blocked: false, detail: lookup.status };
}
