/**
 * 【Round 22 Remediation VI】completion replacement——兼容外壳。
 *
 * Remediation V 的本模块曾是 supersession 判定 / headroom 回收的实现载体，
 * 但其判定只按 transactionId + resolution 字符串匹配（"proof 存在即
 * superseded"），并且 reclaim 直接调用底层 release——两处语义均已在
 * Remediation VI 迁移至 cleanupSupersessionAuthority（exact outcome +
 * 全维度 identity 验证、durable historical authority 交接、统一删除入口）。
 *
 * 本文件保留：
 * - probes 注册/查询的 re-export（resolutionCleanupStageHandlers 装配点
 *   import 路径不变）；
 * - verifyTreasuryCleanupCompletionSupersession：诊断查询的兼容外壳
 *   （在位 completion 经 exact 验证；completion absent 时 completion 的
 *   完成权威是 historical authority，不再由 GRA/tombstone 单独证明）；
 * - reclaimTreasuryCleanupCompletionHeadroom：委托 ensureTreasuryCleanup
 *   CompletionHeadroom（bounded exact archive + read-back，删除只经统一
 *   supersession authority 入口）。
 */

import {
  ensureTreasuryCleanupCompletionHeadroom,
  peekTreasuryCompletionReplacementProbes,
  registerTreasuryCompletionReplacementProbesForAssembly,
  verifyTreasuryExactCompletionReplacement,
  type TreasuryCompletionReplacementProbes,
} from "@/runtime/treasury/cleanupSupersessionAuthority";
import {
  lookupTreasuryCleanupCompletion,
  type TreasuryCleanupCompletionProof,
} from "@/runtime/treasury/cleanupCompletionAuthority";

export {
  peekTreasuryCompletionReplacementProbes,
  registerTreasuryCompletionReplacementProbesForAssembly,
  verifyTreasuryExactCompletionReplacement,
};
export type { TreasuryCompletionReplacementProbes };

export type TreasuryCompletionSupersession =
  | { readonly verdict: "superseded"; readonly via: "gra-proof" | "terminal-summary" | "final-tombstone"; readonly detail: string }
  | { readonly verdict: "no_replacement" }
  | { readonly verdict: "conflict"; readonly detail: string }
  | { readonly verdict: "store_unhealthy"; readonly detail: string };

/**
 * 【诊断/测试】在位 completion 的 exact replacement 查询：GRA / terminal
 * summary / final tombstone 必须与 completion 在 settlement outcome +
 * 全部 exact identity 维度完整匹配才 superseded。completion 不在时返回
 * no_replacement——完成事实的持久权威是 durable historical authority
 * （lookupTreasuryHistoricalCompletion），GRA/tombstone 不再单独证明。
 */
export function verifyTreasuryCleanupCompletionSupersession(
  transactionId: string,
): TreasuryCompletionSupersession {
  if (peekTreasuryCompletionReplacementProbes() === null) {
    return { verdict: "store_unhealthy", detail: "completion replacement probes 未装配（fail closed——supersession 不可证明）" };
  }
  const completion = lookupTreasuryCleanupCompletion(transactionId);
  if (completion.verdict === "store_unhealthy") {
    return { verdict: "store_unhealthy", detail: `completion store unhealthy: ${completion.detail}` };
  }
  if (completion.verdict === "conflict") {
    return { verdict: "store_unhealthy", detail: `completion 单条复验失败: ${completion.detail}` };
  }
  if (completion.verdict === "absent") {
    return { verdict: "no_replacement" };
  }
  return verifyTreasuryExactCompletionReplacement({ transactionId, completion: completion.proof });
}

/**
 * completion 容量回收（bounded compaction）：委托 state-changing headroom
 * preflight——逐条 exact archive（completion 完整验证 → durable historical
 * authority 写入 + read-back → 删除 + 删除 read-back），删除只经统一
 * supersession authority 入口；store unhealthy / archive 失败立即停止
 * （已回收项均有 durable authority）。
 */
export function reclaimTreasuryCleanupCompletionHeadroom(input: {
  readonly minSlots: number;
}): { readonly reclaimed: number; readonly detail: string } {
  const preflight = ensureTreasuryCleanupCompletionHeadroom({ minSlots: input.minSlots });
  return { reclaimed: preflight.reclaimed, detail: preflight.detail };
}

/**
 * 【诊断/测试】completion proof 逐项 exact supersession 查询（reclaim 的
 * 单件形式）。
 */
export function verifyTreasuryCleanupCompletionProofReplacement(
  proof: Pick<TreasuryCleanupCompletionProof, "transactionId">,
): TreasuryCompletionSupersession {
  return verifyTreasuryCleanupCompletionSupersession(proof.transactionId);
}
