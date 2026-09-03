/**
 * 【Round 22 Remediation V 八】cleanup completion 的 replacement authority
 * ——completion proof 安全回收与 superseded 查询的单一权威。
 *
 * Remediation IV 建立了有界 completion store（128 满载 fail closed），但只有
 * rearm 链一处定向 release（child 激活回收 parent），且删除前不验证任何
 * replacement 事实；initial committed 的 completion 永久占用容量；被回收的
 * attempt 查询退化 no_cleanup_authority。
 *
 * 本模块提供三类闭环：
 *
 * 1. verifyTreasuryCleanupCompletionSupersession：某 attempt 的完成事实是否
 *    已被更高层持久权威安全替代（可查询 replacement）：
 *    - GRA proof byAttempt（tr1_ / root 的 per-generation exact retirement
 *      proof——release-trusted 写入，retirement 三段全 true）；
 *    - terminal summary byRoot（root 是 final 代 + non_rearmable_retired）；
 *    - final committed tombstone（initial committed 的持久 settlement 权威）。
 * 2. reclaimTreasuryCleanupCompletionHeadroom：bounded 扫描（≤硬容量）+
 *    逐项 supersession 验证 → 删除 → read-back absent——只回收有可查询
 *    replacement 的 completion（conflict/unhealthy 不回收，fail closed）。
 * 3. coordinator 的 journal-absent 判定接入：completion absent 时先验证
 *    supersession（superseded = completed 语义，不是 no_cleanup_authority）。
 *
 * store 读取全部经装配 probes 注入（attemptLineage / lineageRetirementSummary
 * / resolutionStore / GRA 均不得直接 import——避免与 coordinator /
 * acknowledgement 的模块环）；production 未装配 → fail closed。
 */

import {
  peekTreasuryCleanupCompletionHealth,
  releaseTreasuryCleanupCompletionOfAttempt,
  type TreasuryCleanupCompletionProof,
} from "@/runtime/treasury/cleanupCompletionAuthority";

/** 只读 store 探测（facade/resolutionCleanupStageHandlers 装配；test 可重入）。 */
export interface TreasuryCompletionReplacementProbes {
  readonly graStoreHealthy: () => boolean;
  readonly readGRAProofByAttempt: (transactionId: string) => { readonly transactionId: string; readonly resolution: string } | undefined;
  readonly summaryStoreHealthy: () => boolean;
  readonly readSummaryByRoot: (rootTransactionId: string) => {
    readonly rootTransactionId: string;
    readonly finalAttemptId: string;
    readonly terminalState: string;
  } | undefined;
  readonly resolutionStoreHealthy: () => boolean;
  readonly readTombstone: (transactionId: string) => {
    readonly transactionId: string;
    readonly resolution: string;
    readonly stage: string;
  } | undefined;
  /** 有界枚举当前 completion store 的全部 transactionId（bounded compaction 用）。 */
  readonly listCompletionTransactionIds: () => readonly string[];
  /** 删除后的 read-back（absent 确认——completion 模块单 key 直读）。 */
  readonly completionAbsentAfterRelease: (transactionId: string) => boolean;
}

let replacementProbes: TreasuryCompletionReplacementProbes | null = null;

export function registerTreasuryCompletionReplacementProbesForAssembly(
  probes: TreasuryCompletionReplacementProbes | null,
): void {
  replacementProbes = probes;
}

export function peekTreasuryCompletionReplacementProbes(): TreasuryCompletionReplacementProbes | null {
  return replacementProbes;
}

export type TreasuryCompletionSupersession =
  | { readonly verdict: "superseded"; readonly via: "gra-proof" | "terminal-summary" | "final-tombstone"; readonly detail: string }
  | { readonly verdict: "no_replacement" }
  | { readonly verdict: "store_unhealthy"; readonly detail: string };

/**
 * 某 attempt 的完成事实是否已被持久 replacement authority 安全替代
 * （单 key O(1)：GRA byAttempt / summary byRoot / tombstone 单键）。
 */
export function verifyTreasuryCleanupCompletionSupersession(
  transactionId: string,
): TreasuryCompletionSupersession {
  if (replacementProbes === null) {
    return { verdict: "store_unhealthy", detail: "completion replacement probes 未装配（fail closed——supersession 不可证明）" };
  }
  const probes = replacementProbes;
  // 1. GRA proof byAttempt：该代的 exact retirement proof（三段完成事实）。
  if (!probes.graStoreHealthy()) {
    return { verdict: "store_unhealthy", detail: "GRA store unhealthy（replacement 不可证明——fail closed）" };
  }
  const gra = probes.readGRAProofByAttempt(transactionId);
  if (gra !== undefined) {
    if (gra.transactionId !== transactionId || gra.resolution !== "not_executed") {
      return { verdict: "store_unhealthy", detail: "GRA byAttempt 索引返回身份不一致的 proof（fail closed）" };
    }
    return { verdict: "superseded", via: "gra-proof", detail: "exact per-generation retirement proof 证明该 attempt 的 not-executed retirement 三段完成（completion 的可查询 replacement）" };
  }
  // 2. terminal summary byRoot：root 是 final 代（finalGeneration=0 的
  // non-rearmable root）——summary 是 chain 级持久权威。
  if (!probes.summaryStoreHealthy()) {
    return { verdict: "store_unhealthy", detail: "terminal summary store unhealthy（replacement 不可证明——fail closed）" };
  }
  const summary = probes.readSummaryByRoot(transactionId);
  if (summary !== undefined) {
    if (summary.rootTransactionId !== transactionId || summary.finalAttemptId !== transactionId) {
      return { verdict: "no_replacement" };
    }
    if (summary.terminalState === "non_rearmable_retired") {
      return { verdict: "superseded", via: "terminal-summary", detail: "terminal summary 证明该 root attempt 的 non-rearmable 终局（completion 的可查询 replacement）" };
    }
    return { verdict: "no_replacement" };
  }
  // 3. final committed tombstone：initial committed 的持久 settlement 权威。
  if (!probes.resolutionStoreHealthy()) {
    return { verdict: "store_unhealthy", detail: "resolution store unhealthy（replacement 不可证明——fail closed）" };
  }
  const tombstone = probes.readTombstone(transactionId);
  if (tombstone !== undefined && tombstone.transactionId === transactionId && tombstone.resolution === "committed" && tombstone.stage === "final") {
    return { verdict: "superseded", via: "final-tombstone", detail: "final committed tombstone 证明该 attempt 的 committed settlement（completion 的可查询 replacement）" };
  }
  return { verdict: "no_replacement" };
}

/**
 * completion 容量回收（bounded compaction）：有界扫描 completion store，
 * 逐项验证 supersession（GRA / terminal summary / final tombstone 任一成立）
 * → 删除 → read-back absent；直到回收 minSlots 或扫描完成。store unhealthy /
 * read-back 失败 → 立即停止（已回收的保留——它们都有已验证 replacement）。
 */
export function reclaimTreasuryCleanupCompletionHeadroom(input: {
  readonly minSlots: number;
}): { readonly reclaimed: number; readonly detail: string } {
  if (replacementProbes === null) {
    return { reclaimed: 0, detail: "completion replacement probes 未装配（fail closed——不回收）" };
  }
  const probes = replacementProbes;
  const health = peekTreasuryCleanupCompletionHealth();
  if (!health.healthy) {
    return { reclaimed: 0, detail: `completion store unhealthy: ${health.detail}（不回收——fail closed）` };
  }
  let reclaimed = 0;
  const skipped: string[] = [];
  for (const transactionId of probes.listCompletionTransactionIds()) {
    if (reclaimed >= input.minSlots) break;
    const supersession = verifyTreasuryCleanupCompletionSupersession(transactionId);
    if (supersession.verdict !== "superseded") {
      skipped.push(supersession.verdict);
      continue;
    }
    const released = releaseTreasuryCleanupCompletionOfAttempt(transactionId);
    if (!released) {
      return { reclaimed, detail: `completion ${transactionId.slice(0, 12)} 删除失败（停止回收——已回收项均有已验证 replacement）` };
    }
    if (!probes.completionAbsentAfterRelease(transactionId)) {
      return { reclaimed, detail: `completion ${transactionId.slice(0, 12)} 删除后 read-back 仍存在（停止回收——fail closed）` };
    }
    reclaimed += 1;
  }
  return {
    reclaimed,
    detail: reclaimed >= input.minSlots
      ? `已回收 ${String(reclaimed)} 个 completion（均有已验证 replacement authority）`
      : `仅回收 ${String(reclaimed)} 个（${skipped.length > 0 ? `无可回收 replacement: ${skipped[0]}` : "store 为空"}）`,
  };
}

/**
 * 【诊断/测试】completion proof 逐项 supersession 查询（reclaim 的单件形式）。
 */
export function verifyTreasuryCleanupCompletionProofReplacement(
  proof: Pick<TreasuryCleanupCompletionProof, "transactionId">,
): TreasuryCompletionSupersession {
  return verifyTreasuryCleanupCompletionSupersession(proof.transactionId);
}
