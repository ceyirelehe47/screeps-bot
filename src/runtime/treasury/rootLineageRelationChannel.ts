/**
 * 【Round 22 Remediation V 七】root lineage exact relation 的装配 channel
 * （零依赖模块——打破 pre-release gate ↔ lineageFinalizationProof 的环）。
 *
 * gate（coordinator 下游）不得静态 import lineageFinalizationProof（其依赖
 * 链经 attemptLineage/GRA 回到 resolutionStore → coordinator → gate）；
 * root relation 的实现由 resolutionCleanupStageHandlers 模块加载时经本
 * channel 注册，gate 经 peek 消费——未装配 fail closed（与 stage handlers /
 * proof probes 同语义）。
 */

import type { TreasuryExactAttemptIdentity } from "@/runtime/treasury/exactAttemptIdentity";

/** root not-executed 的 exact relation 结果（lineageFinalizationProof 定义语义；此处仅为类型通道）。 */
export type TreasuryRootLineageRelationChannelResult =
  | { readonly verdict: "match"; readonly via: "active" | "terminal"; readonly state?: string; readonly terminalState?: string }
  | { readonly verdict: "conflict"; readonly detail: string }
  | { readonly verdict: "insufficient"; readonly detail: string }
  | { readonly verdict: "store_unhealthy"; readonly detail: string }
  | { readonly verdict: "lineage_missing"; readonly detail: string };

export type TreasuryRootLineageRelationSource = (
  journalIdentity: TreasuryExactAttemptIdentity,
) => TreasuryRootLineageRelationChannelResult;

let rootRelationSource: TreasuryRootLineageRelationSource | null = null;

export function registerTreasuryRootLineageRelationForAssembly(
  source: TreasuryRootLineageRelationSource | null,
): void {
  rootRelationSource = source;
}

export function peekTreasuryRootLineageRelation(): TreasuryRootLineageRelationSource | null {
  return rootRelationSource;
}
