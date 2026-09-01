/**
 * 【第十八轮 24.8】per-generation tombstone replacement verdict。
 *
 * Round 17 遗留断链：retention 只读通用 state 与三个布尔——上一代 retirement
 * 全 true 会错误授权当前代 tombstone 驱逐；A→B→C 后 B 不再是 root/current/
 * next，其 tombstone 找不到 lineage replacement 永久 pin。
 *
 * 本模块按"该具体 attempt generation"判定驱逐资格（generation-addressable
 * child ID v2 使任意历史代 attempt ID 与 binding 都可只凭 record O(1) 重算，
 * 不需要无界 attempt 数组）：
 * - replacement_match：lineage/generation/transaction ID（v2 派生 + checksum）
 *   /binding（重算比较）/proof class/resolution=not-executed 全部匹配，且该
 *   代 retirement 完成（历史代由状态机推进顺序证明；当前代要求三段全 true
 *   且 retirementGeneration===generation）→ 可驱逐；
 * - replacement_pending（当前代 retiring/三段未全）→ pin；
 * - replacement_conflict（class/binding/transactionId/当前代 digest 不匹配）
 *   → pin + 计数；
 * - replacement_missing（无 active record 且无 terminal summary；v1 ID 不可
 *   寻址）→ pin（不猜测 generation）；
 * - store_unhealthy → pin。
 *
 * committed 终态后的 committed tombstone 不经本模块（普通 retention——chain
 * 已闭合，root 永久门禁由 record/retirement summary 承担）。
 */

import {
  peekTreasuryAttemptLineageHealth,
  readTreasuryAttemptLineageRecord,
  lookupTreasuryAttemptLineageByAttemptId,
  expectedTreasuryLineageAttemptId,
  type TreasuryAttemptLineageRecord,
} from "@/runtime/treasury/attemptLineage";
import { parseTreasuryRearmChildTransactionIdV2 } from "@/runtime/treasury/transactionId";
import { computeTreasuryLineageBindingDigest } from "@/runtime/treasury/lineageBinding";
import { registerTreasuryRetentionLineageLookupForAssembly } from "@/runtime/treasury/resolutionStore";
import { lookupTreasuryRetirementSummaryByRoot, peekTreasuryRetirementSummaryHealth } from "@/runtime/treasury/lineageRetirementSummary";

export type TreasuryTombstoneReplacementVerdict =
  | { readonly verdict: "replacement_match" }
  | { readonly verdict: "replacement_pending"; readonly detail: string }
  | { readonly verdict: "replacement_conflict"; readonly detail: string }
  | { readonly verdict: "replacement_missing"; readonly detail: string }
  | { readonly verdict: "store_unhealthy"; readonly detail: string };

/** verdict 输入的最小 tombstone 视图。 */
export interface TreasuryTombstoneReplacementInput {
  readonly transactionId: string;
  readonly digest: string;
  readonly resolution: string;
  readonly stage: string;
  readonly proofLevel: string;
  /** 【v7 起携带】tr1_ not-executed tombstone 的 lineage binding proof。 */
  readonly lineageBindingDigest?: string;
}

/** 允许承担永久 retirement 门禁的 lineage 状态（retiring 进行中除外）。 */
const REPLACEMENT_ALLOWED_STATES: ReadonlySet<string> = new Set<string>([
  "rearm_ready",
  "capability_issued",
  "child_intent_pending",
  "child_active",
  "chain_committed",
  "non_rearmable_retired",
]);

function bindingOfGeneration(record: TreasuryAttemptLineageRecord, generation: number): string {
  const parent = expectedTreasuryLineageAttemptId(record, generation - 1);
  const child = expectedTreasuryLineageAttemptId(record, generation);
  return computeTreasuryLineageBindingDigest({
    lineageId: record.lineageId,
    generation,
    parentTransactionId: parent,
    childTransactionId: child,
  });
}

/**
 * 单条 final not-executed tombstone 的驱逐资格判定（evictExpiredTombstones
 * 逐条调用——单条 O(1) 索引查询，不扫描 lineage store）。
 */
export function treasuryTombstoneReplacementVerdict(
  tombstone: TreasuryTombstoneReplacementInput,
): TreasuryTombstoneReplacementVerdict {
  if (tombstone.resolution !== "not-executed" || tombstone.stage !== "final") {
    return { verdict: "replacement_missing", detail: "非 final not-executed tombstone 不参与 lineage replacement 判定" };
  }
  const lineageHealth = peekTreasuryAttemptLineageHealth();
  if (!lineageHealth.healthy) {
    return { verdict: "store_unhealthy", detail: lineageHealth.detail ?? "lineage store 损坏（retention fail closed）" };
  }
  // ── 定位 record：v2 child ID 自带 (lineageId, generation)；root/非 v2 ID
  //    经 root ∪ current 索引。
  const parsed = parseTreasuryRearmChildTransactionIdV2(tombstone.transactionId);
  let record: Readonly<TreasuryAttemptLineageRecord> | undefined;
  let generation: number;
  if (parsed !== null) {
    record = readTreasuryAttemptLineageRecord(parsed.lineageId);
    generation = parsed.generation;
  } else {
    record = lookupTreasuryAttemptLineageByAttemptId(tombstone.transactionId);
    generation = 0;
  }
  if (record === undefined) {
    // 无 active record：terminal summary（压缩后的 chain）证明 chain 已闭合
    // ——summary 是永久 root 门禁，历史 not-executed tombstone 可回收。
    const summaryHealth = peekTreasuryRetirementSummaryHealth();
    if (!summaryHealth.healthy) {
      return { verdict: "store_unhealthy", detail: summaryHealth.detail ?? "retirement summary store 损坏（retention fail closed）" };
    }
    const summary = lookupTreasuryRetirementSummaryByRoot(tombstone.transactionId);
    if (summary !== undefined && (summary.terminalState === "chain_committed" || summary.terminalState === "non_rearmable_retired")) {
      return { verdict: "replacement_match" };
    }
    if (parsed === null && tombstone.transactionId.startsWith("tr1_")) {
      return { verdict: "replacement_missing", detail: "v1 rearm child ID 不可 generation 寻址（无 replacement 证明——永久 pin，不猜测 generation）" };
    }
    return { verdict: "replacement_missing", detail: `attempt ${tombstone.transactionId.slice(0, 24)} 无 lineage replacement（Round 16 遗留 / backfill 未完成 / 已迁移隔离）` };
  }
  // root 命中时 generation 取 root 代（0）；current 命中取当前代。
  if (parsed === null) {
    if (record.rootTransactionId === tombstone.transactionId) {
      generation = 0;
    } else if (record.currentTransactionId === tombstone.transactionId) {
      generation = record.generation;
    } else {
      return { verdict: "replacement_missing", detail: "tombstone attempt 不属于该 lineage 的 root/current（无法定位 generation）" };
    }
  }
  if (generation > record.generation) {
    return { verdict: "replacement_conflict", detail: `tombstone generation ${String(generation)} 超过 lineage 当前代 ${String(record.generation)}（未来代不可证明）` };
  }
  // transaction ID 必须等于该代期望 attempt ID（v2 派生 + checksum；root=本身）。
  const expectedId = expectedTreasuryLineageAttemptId(record, generation);
  if (expectedId !== tombstone.transactionId) {
    return { verdict: "replacement_conflict", detail: `tombstone transaction ID 与 generation ${String(generation)} 期望 attempt ID 派生不一致` };
  }
  // proof class：tombstone.proofLevel 与 record authorityClass 必须一致。
  const expectedLevel = record.authorityClass;
  if (tombstone.proofLevel !== expectedLevel) {
    return { verdict: "replacement_conflict", detail: `tombstone proof class ${String(tombstone.proofLevel)} 与 lineage authority class ${String(expectedLevel)} 不匹配` };
  }
  // binding（v7 tombstone 携带时完整比较；历史代 binding 可 O(1) 重算）。
  if (generation >= 1) {
    const expectedBinding = bindingOfGeneration(record, generation);
    if (tombstone.lineageBindingDigest !== undefined && tombstone.lineageBindingDigest !== expectedBinding) {
      return { verdict: "replacement_conflict", detail: "tombstone lineage binding 与该 generation 重算 binding 不一致" };
    }
  }
  const isCurrentGeneration = generation === record.generation;
  if (isCurrentGeneration) {
    // 当前代：digest 完整比较 + 三段完成 + retirementGeneration 归属检查
    //（上一代全 true 不得授权当前代驱逐）。
    if (tombstone.digest !== record.currentIdentity.digest) {
      return { verdict: "replacement_conflict", detail: "tombstone digest 与 lineage 当前代 attempt identity digest 不一致" };
    }
    if (record.retirementGeneration !== record.generation) {
      return { verdict: "replacement_pending", detail: "lineage retirement facts 属于上一代（当前代驱逐不得沿用旧代完成标志）" };
    }
    if (!record.retirement.lineagePublished || !record.retirement.authorityReleased || !record.retirement.markerCleaned) {
      return { verdict: "replacement_pending", detail: "当前代 retirement 三段未全部完成（publication/release/marker pending）" };
    }
    if (!REPLACEMENT_ALLOWED_STATES.has(record.state)) {
      return { verdict: "replacement_pending", detail: `lineage 状态 ${String(record.state)} 未接管永久 retirement 门禁` };
    }
    return { verdict: "replacement_match" };
  }
  // 历史代（generation < record.generation）：状态机推进顺序保证该代
  // retirement 在下一代 capability 签发前已完成（rearm 只允许 rearm_ready）；
  // ID 协议 + checksum 绑定证明 tombstone 属于该代——attempt identity 经
  // handoff 协议链证明（签发/消费时已验证，不保存无界 identity 历史）。
  if (!REPLACEMENT_ALLOWED_STATES.has(record.state) && record.state !== "forensic_isolated") {
    return { verdict: "replacement_pending", detail: `lineage 状态 ${String(record.state)} 异常（历史代判定 fail closed）` };
  }
  return { verdict: "replacement_match" };
}

// 装配注册（resolutionStore 不 import 本模块——保持单向依赖；facade import
// 本模块保证注册生效）。
registerTreasuryRetentionLineageLookupForAssembly((tombstone) => treasuryTombstoneReplacementVerdict(tombstone));
