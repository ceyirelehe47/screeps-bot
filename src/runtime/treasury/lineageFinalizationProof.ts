/**
 * 【Round 22 Remediation IV 八/九】lineage finalization proof——not-executed
 * outcome 的 GRA exact relation 与 lineage 终态判定的单一权威。
 *
 * Remediation III 的 outcome handler 对已有 GRA 使用 transactionId + digest
 * 快捷判断（generation/parent/binding/contract/cohort/durable/source/
 * retirement 阶段都不比较）；lineage handler 把 active record 读取 undefined
 * 一律解释为 not_applicable——lineage store unhealthy、active record 丢失、
 * terminal summary 存在、真正无 lineage 四种情况无法区分。
 *
 * 本模块提供两个只读判定：
 *
 * 1. relateTreasuryGenerationRetirementProofForOutcome：journal entry（完整
 *    exact identity + lineage 四字段）↔ final not-executed tombstone ↔ GRA
 *    exact proof 的三方完整 relation（复用 verifyTreasuryGenerationRetirement
 *    Relation 单一权威；root facts 从 active lineage record 或 terminal
 *    summary 权威解析——proof 自称的 root 不被信任）。返回 match / conflict /
 *    insufficient / store_unhealthy / absent——不存在 transactionId+digest
 *    快捷完成路径。
 *
 * 2. verifyTreasuryLineageFinalizationState：带 lineage 的 entry 的终态判定
 *    （active record 存在 → active 语义；active 缺失 → terminal summary 的
 *    final exact identity 完整 match + terminal state 与 resolution 一致才
 *    terminal_final；两者都缺 → lineage_missing；任一 store unhealthy →
 *    store_unhealthy——零阶段推进）。root not-executed（initial attempt 的
 *    cleanup entry 无 lineage 四字段，但 settlement 时已创建 root lineage）
 *    同样经 active/terminal 判定——意外缺失不得 not_applicable。
 *
 * 只读、无副作用；单 key 查询（byLineageId / byAttempt / byRoot 索引）。
 */

import {
  readTreasuryGenerationRetirementProof,
  lookupTreasuryGenerationRetirementProofByAttemptId,
  peekTreasuryGenerationRetirementHealth,
  computeTreasuryGenerationRootIdentityDigest,
} from "@/runtime/treasury/generationRetirementAuthority";
import { verifyTreasuryGenerationRetirementRelation } from "@/runtime/treasury/generationRetirementRelation";
import {
  readTreasuryAttemptLineageRecord,
  lookupTreasuryAttemptLineageByAttemptId,
  peekTreasuryAttemptLineageHealth,
  type TreasuryAttemptLineageRecord,
} from "@/runtime/treasury/attemptLineage";
import {
  lookupTreasuryRetirementSummaryByLineageId,
  lookupTreasuryRetirementSummaryByRoot,
  peekTreasuryRetirementSummaryHealth,
} from "@/runtime/treasury/lineageRetirementSummary";
import { readTreasuryResolutionTombstone } from "@/runtime/treasury/resolutionStore";
import { treasuryTerminalFinalExactOfSummary } from "@/runtime/treasury/terminalExactIdentity";
import { treasuryPreReleaseExactIdentityOfEntry } from "@/runtime/treasury/preReleaseSettlementGate";
import type { TreasuryResolutionCleanupEntry } from "@/runtime/treasury/resolutionCleanupJournal";

export type TreasuryGraOutcomeRelation =
  | { readonly verdict: "match" }
  | { readonly verdict: "conflict"; readonly detail: string }
  | { readonly verdict: "insufficient"; readonly detail: string }
  | { readonly verdict: "store_unhealthy"; readonly detail: string }
  | { readonly verdict: "absent"; readonly detail: string };

/** root facts 权威解析：active lineage record 优先，terminal summary 回落。 */
function resolveRootFactsOfLineage(
  lineageId: string,
): { readonly rootTransactionId: string; readonly rootIdentityDigest: string } | { readonly error: TreasuryGraOutcomeRelation } {
  const lineageHealth = peekTreasuryAttemptLineageHealth();
  if (!lineageHealth.healthy) {
    return { error: { verdict: "store_unhealthy", detail: `active lineage store unhealthy: ${lineageHealth.detail ?? "unknown"}` } };
  }
  const record = readTreasuryAttemptLineageRecord(lineageId);
  if (record !== undefined) {
    return {
      rootTransactionId: record.rootTransactionId,
      rootIdentityDigest: computeTreasuryGenerationRootIdentityDigest(record.rootIdentity),
    };
  }
  const summaryHealth = peekTreasuryRetirementSummaryHealth();
  if (!summaryHealth.healthy) {
    return { error: { verdict: "store_unhealthy", detail: `terminal summary store unhealthy: ${summaryHealth.detail ?? "unknown"}` } };
  }
  const summary = lookupTreasuryRetirementSummaryByLineageId(lineageId);
  if (summary !== undefined) {
    return { rootTransactionId: summary.rootTransactionId, rootIdentityDigest: summary.rootIdentityDigest };
  }
  return { error: { verdict: "insufficient", detail: `lineage ${lineageId.slice(0, 8)} 的 root facts 权威缺失（active record 与 terminal summary 均不存在）` } };
}

/**
 * not-executed outcome 的 GRA exact relation（journal ↔ tombstone ↔ proof
 * 三方完整比较）。proof 缺失 → absent（调用方可 converge 后重试）；同
 * attempt 存在但 (lineageId, generation) 不匹配的 GRA → conflict（身份冲突
 * 不可覆盖）；任何维度不同 / root facts 不可证 → conflict / insufficient。
 */
export function relateTreasuryGenerationRetirementProofForOutcome(
  entry: Readonly<TreasuryResolutionCleanupEntry>,
): TreasuryGraOutcomeRelation {
  const graHealth = peekTreasuryGenerationRetirementHealth();
  if (!graHealth.healthy) {
    return { verdict: "store_unhealthy", detail: `GRA store unhealthy: ${graHealth.detail ?? "unknown"}` };
  }
  if (entry.lineageId === undefined || entry.lineageGeneration === undefined) {
    return { verdict: "insufficient", detail: "entry 缺 lineage 字段（GRA outcome 只对 rearm attempt 定义）" };
  }
  const proof = readTreasuryGenerationRetirementProof(entry.lineageId, entry.lineageGeneration);
  if (proof === undefined) {
    // byAttempt 冲突检测：同 attemptId 存在其它 (lineage, generation) 的
    // proof —— 同 transaction ID 的身份冲突不可忽略。
    const byAttempt = lookupTreasuryGenerationRetirementProofByAttemptId(entry.transactionId);
    if (byAttempt !== undefined) {
      return {
        verdict: "conflict",
        detail: `同 attempt 存在 (lineage ${byAttempt.lineageId.slice(0, 8)}, gen ${String(byAttempt.generation)}) 的 GRA proof，与 journal (gen ${String(entry.lineageGeneration)}) 不一致`,
      };
    }
    return { verdict: "absent", detail: "matching (lineageId, generation) 的 exact retirement proof 缺失" };
  }
  const journalIdentity = treasuryPreReleaseExactIdentityOfEntry(entry);
  if (journalIdentity === null) {
    return { verdict: "insufficient", detail: "journal entry 身份无法构造 exact identity" };
  }
  const rootFacts = resolveRootFactsOfLineage(entry.lineageId);
  if ("error" in rootFacts) return rootFacts.error;
  const tombstone = readTreasuryResolutionTombstone(entry.transactionId);
  if (tombstone === undefined || tombstone.stage !== "final" || tombstone.resolution !== "not-executed") {
    return { verdict: "insufficient", detail: "final not-executed tombstone 缺失（三方 relation 不可构造）" };
  }
  const relation = verifyTreasuryGenerationRetirementRelation({
    exactProof: proof,
    expectedCurrent: {
      ...journalIdentity,
      rootTransactionId: rootFacts.rootTransactionId,
      rootIdentityDigest: rootFacts.rootIdentityDigest,
      authorityLineageId: entry.lineageId,
      authorityGeneration: entry.lineageGeneration,
    },
    tombstone,
  });
  return relation;
}

export type TreasuryLineageFinalizationState =
  | { readonly state: "active"; readonly record: Readonly<TreasuryAttemptLineageRecord> }
  | { readonly state: "terminal_final"; readonly terminalState: string }
  | { readonly state: "lineage_missing"; readonly detail: string }
  | { readonly state: "store_unhealthy"; readonly detail: string }
  | { readonly state: "summary_conflict"; readonly detail: string };

/**
 * 带 lineage 的 entry 的终态判定（lineageFinalization handler 消费）：
 * active record 存在 → active（record 的 current/generation/parent/binding
 * 匹配由 handler 复验）；active 缺失 → terminal summary 的 final exact
 * identity 完整 match + finalAttemptId/finalGeneration/terminalState 与
 * entry 一致才 terminal_final；都缺 → lineage_missing；store unhealthy →
 * 结构化阻断。root not-executed（entry 无 lineage 四字段）按 root
 * transactionId 查 active / terminal——意外缺失同样 lineage_missing。
 */
export function verifyTreasuryLineageFinalizationState(input: {
  readonly transactionId: string;
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly resolution: "committed" | "not-executed";
  readonly expectedDigest?: string;
}): TreasuryLineageFinalizationState {
  const lineageHealth = peekTreasuryAttemptLineageHealth();
  if (!lineageHealth.healthy) {
    return { state: "store_unhealthy", detail: `active lineage store unhealthy: ${lineageHealth.detail ?? "unknown"}` };
  }
  // active 查询：带 lineageId 用 lineageIdIndex；root not-executed 用
  // byAttempt（root ∪ current 索引）。
  const activeRecord =
    input.lineageId !== undefined
      ? readTreasuryAttemptLineageRecord(input.lineageId)
      : lookupTreasuryAttemptLineageByAttemptId(input.transactionId);
  if (activeRecord !== undefined) {
    return { state: "active", record: activeRecord };
  }
  // active 缺失：terminal summary 权威（byLineageId / byRoot 单 key）。
  const summaryHealth = peekTreasuryRetirementSummaryHealth();
  if (!summaryHealth.healthy) {
    return { state: "store_unhealthy", detail: `terminal summary store unhealthy: ${summaryHealth.detail ?? "unknown"}` };
  }
  const summary =
    input.lineageId !== undefined
      ? lookupTreasuryRetirementSummaryByLineageId(input.lineageId)
      : lookupTreasuryRetirementSummaryByRoot(input.transactionId);
  if (summary === undefined) {
    return {
      state: "lineage_missing",
      detail: `lineage ${input.lineageId !== undefined ? input.lineageId.slice(0, 8) : input.transactionId.slice(0, 8)} 的 active record 与 terminal summary 均不存在（${input.lineageId !== undefined ? "rearm attempt lineage" : "root lineage"} 意外缺失——不得 not_applicable）`,
    };
  }
  // final exact identity 完整 match + terminal state 与 resolution 一致。
  const finalView = treasuryTerminalFinalExactOfSummary(summary);
  if (finalView === null) {
    return { state: "summary_conflict", detail: "terminal summary 缺 v3 finalExact（replay-only——不可证明 terminal current）" };
  }
  if (summary.finalAttemptId !== input.transactionId) {
    return { state: "summary_conflict", detail: `terminal summary finalAttemptId ${summary.finalAttemptId.slice(0, 8)} 与 cleanup entry ${input.transactionId.slice(0, 8)} 不一致` };
  }
  if (input.lineageGeneration !== undefined && summary.finalGeneration !== input.lineageGeneration) {
    return { state: "summary_conflict", detail: `terminal summary finalGeneration ${String(summary.finalGeneration)} 与 entry lineageGeneration ${String(input.lineageGeneration)} 不一致` };
  }
  const expectedTerminalState = input.resolution === "committed" ? "chain_committed" : "non_rearmable_retired";
  if (summary.terminalState !== expectedTerminalState) {
    return { state: "summary_conflict", detail: `terminal summary state ${summary.terminalState} 与 resolution ${input.resolution} 期望（${expectedTerminalState}）不一致` };
  }
  if (input.expectedDigest !== undefined && finalView.exactIdentity.digest !== input.expectedDigest) {
    return { state: "summary_conflict", detail: "terminal summary finalExact digest 与 cleanup entry 不一致" };
  }
  return { state: "terminal_final", terminalState: summary.terminalState };
}
