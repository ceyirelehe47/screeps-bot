/**
 * 【第十八轮 24.8 / 【第二十轮第十/十二节】重写】per-generation tombstone
 * replacement verdict——exact retirement authority 单一证明源。
 *
 * Round 18/19 断链：历史 generation 只凭"generation < currentGeneration +
 * 状态机曾推进"即判 replacement_match——上一代 retirement 完成事实在 child
 * 接管时被整体复位删除，没有独立、持久、可验证的 per-generation 证明。
 * Round 20 删除该推断：
 *
 * - active record 历史代（generation < record.generation）：必须命中
 *   (lineageId, generation) 的 exact retirement proof 并完整比较
 *   （transactionId / parent / binding 派生重算 / proof class / digest 及
 *   contract/cohort/durable/lowlevel identity 维度）→ replacement_match；
 *   proof 缺失 → replacement_missing（pin，不猜测）；篡改 → conflict；
 * - 当前代：digest 完整比较 + 三段完成 + retirementGeneration 归属 +
 *   持久 parentTransactionId 与 record.currentParentTransactionId 完整比较；
 * - root tombstone：不再仅凭 rootTransactionId 命中 summary——重算
 *   rootIdentityDigest（tombstone 的 digest/contract/cohort/durable/
 *   lowlevelSource 五元）与 summary 比较 + proofLevel vs summary.authorityClass
 *   + terminal 语义 + generation 0 的 exact proof；同 root ID 不同 identity →
 *   conflict/pin；
 * - summary 历史代（压缩后）：summary 只提供定位与 finalGeneration 边界，
 *   membership 与 identity 由 exact retirement proof 证明（finalGeneration
 *   只是边界不是 membership proof）；缺 proof → missing/pin；
 * - v1 迁移 summary 缺 authorityClass / Round 18-19 旧数据缺 exact proof →
 *   保守 pin（不自动补现代 proof）；store unhealthy → pin。
 *
 * committed 终态后的 committed tombstone 不经本模块（普通 retention——chain
 * 已闭合，root 永久门禁由 record/retirement summary 承担）。
 */

import {
  peekTreasuryAttemptLineageHealth,
  readTreasuryAttemptLineageRecord,
  lookupTreasuryAttemptLineageByAttemptId,
  expectedTreasuryLineageAttemptId,
  deriveTreasuryLineageNextChildTransactionId,
  type TreasuryAttemptLineageRecord,
} from "@/runtime/treasury/attemptLineage";
import { parseTreasuryRearmChildTransactionIdV2, isTreasuryRearmAttemptId } from "@/runtime/treasury/transactionId";
import { computeTreasuryLineageBindingDigest } from "@/runtime/treasury/lineageBinding";
import { registerTreasuryRetentionLineageLookupForAssembly } from "@/runtime/treasury/resolutionStore";
import { lookupTreasuryRetirementSummaryByLineageId, lookupTreasuryRetirementSummaryByRoot, peekTreasuryRetirementSummaryHealth, TREASURY_RETIREMENT_SUMMARY_VERSION, type TreasuryLineageRetirementSummary } from "@/runtime/treasury/lineageRetirementSummary";
import {
  peekTreasuryGenerationRetirementHealth,
  readTreasuryGenerationRetirementProof,
  computeTreasuryGenerationRootIdentityDigest,
  type TreasuryGenerationRetirementProof,
} from "@/runtime/treasury/generationRetirementAuthority";
import {
  compareTreasuryGenerationProofWithTombstone,
  verifyTreasuryGenerationRetirementRelation,
} from "@/runtime/treasury/generationRetirementRelation";
import {
  expectedTreasuryCurrentLineageExactIdentity,
  describeTreasuryCurrentLineageRequiredness,
} from "@/runtime/treasury/currentLineageSettlementVerifier";

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
  /** 【第十九轮 E.1】tombstone 自身的完整 lineage proof。 */
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  /** 【第二十轮 12.2】完整 attempt identity 维度（root 五元重算与 exact proof 比较）。 */
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
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
 * 【第二十一轮 12.1】root tombstone 的 summary 精确身份验证：v3 summary 的
 * rootExact（canonical root exact identity）完整比较——digest/contract/
 * cohort/durable/lowlevel 五元 + proofLevel vs rootExact.proofClass +
 * canonical rootIdentityDigest 重算 + resolution 语义 + generation 0 的
 * exact proof。旧 v1/v2 summary（无 rootExact）→ replacement_missing/pin
 * （不猜测——root 永久重放门禁不受影响）。
 */
function verdictOfRootSummary(
  summary: Readonly<TreasuryLineageRetirementSummary>,
  tombstone: TreasuryTombstoneReplacementInput,
): TreasuryTombstoneReplacementVerdict {
  if (summary.authorityClass === undefined) {
    return { verdict: "replacement_missing", detail: "v1 迁移 summary 缺 authorityClass（proof class 不可证明——pin，不猜测）" };
  }
  if (summary.schemaVersion < TREASURY_RETIREMENT_SUMMARY_VERSION || summary.rootExact === undefined) {
    return {
      verdict: "replacement_missing",
      detail: "旧 terminal summary 缺少 root exact identity（replay-only——root 重放门禁保留，root replacement 不可证明，不猜测）",
    };
  }
  if (tombstone.proofLevel !== summary.rootExact.proofClass) {
    return {
      verdict: "replacement_conflict",
      detail: `root tombstone proof class ${String(tombstone.proofLevel)} 与 summary root exact proof class ${String(summary.rootExact.proofClass)} 不匹配`,
    };
  }
  // 【第二十一轮 7.1】canonical 单一口径：rootIdentityDigest 由 rootExact 五元
  // 重算（不再保留双口径任一匹配语义）。
  const canonicalRootDigest = computeTreasuryGenerationRootIdentityDigest(summary.rootExact);
  if (canonicalRootDigest !== summary.rootIdentityDigest) {
    return {
      verdict: "replacement_conflict",
      detail: "summary.rootIdentityDigest 与 rootExact canonical 重算不一致（单一口径被破坏——conflict/pin）",
    };
  }
  // rootExact 完整比较（tombstone 五元 vs 持久 rootExact——同 root ID 不同
  // identity 即 conflict）。
  if (
    tombstone.digest !== summary.rootExact.digest ||
    (tombstone.contractDigest ?? undefined) !== (summary.rootExact.contractDigest ?? undefined) ||
    (tombstone.authorizationCohortDigest ?? undefined) !== (summary.rootExact.authorizationCohortDigest ?? undefined) ||
    (tombstone.durableIdentityDigest ?? undefined) !== (summary.rootExact.durableIdentityDigest ?? undefined) ||
    (tombstone.lowlevelSource ?? undefined) !== (summary.rootExact.lowlevelSource ?? undefined)
  ) {
    return {
      verdict: "replacement_conflict",
      detail: "root tombstone 的五元 identity 与 summary 持久 rootExact 不一致（同 root ID 不同 identity——conflict/pin，不删除证据）",
    };
  }
  // root 代（generation 0）的 exact retirement proof：chain 经完整 retirement
  // 流程的 root 必有 proof；缺失（Round 18/19 旧数据 / 未走完流程）→ pin。
  const proofHealth = peekTreasuryGenerationRetirementHealth();
  if (!proofHealth.healthy) {
    return { verdict: "store_unhealthy", detail: proofHealth.detail ?? "exact generation retirement store 损坏（retention fail closed）" };
  }
  const rootProof = readTreasuryGenerationRetirementProof(summary.lineageId, 0);
  if (rootProof === undefined) {
    return {
      verdict: "replacement_missing",
      detail: "generation 0（root 代）无 exact retirement proof（Round 18/19 旧数据——pin，不自动补现代 proof）",
    };
  }
  const proofCompare = compareTreasuryGenerationProofWithTombstone(rootProof, tombstone, summary.rootTransactionId, undefined);
  if (proofCompare !== null) {
    return { verdict: proofCompare.kind === "missing" ? "replacement_missing" : "replacement_conflict", detail: proofCompare.detail };
  }
  return { verdict: "replacement_match" };
}

/**
 * 【第十九轮 E.2 / 第二十轮 12.4 / 第二十一轮 12.3 重写】压缩后历史
 * generation 的 verdict：summary 只提供定位与 finalGeneration 边界——
 * membership 与 identity 由 exact retirement proof 证明（finalGeneration 只是
 * 边界，不是单独的 membership/identity proof）。ID 派生 + checksum 绑定
 * root、binding 重算、tombstone 持久 parent 显式比较、proof class、final 代
 * 与 terminalState 相容由 summary 事实与 compareTreasuryGenerationProofWithTombstone
 * （单一 relation 实现）承载。旧 v1/v2 summary（无 exact identity）不得驱逐
 * historical child（14.2——pin）。
 */
function verdictOfSummaryProof(
  summary: Readonly<TreasuryLineageRetirementSummary>,
  tombstone: Pick<TreasuryTombstoneReplacementInput, "transactionId" | "proofLevel" | "lineageBindingDigest" | "digest" | "contractDigest" | "authorizationCohortDigest" | "durableIdentityDigest" | "lowlevelSource">,
  generation: number,
): TreasuryTombstoneReplacementVerdict {
  if (generation > summary.finalGeneration) {
    return { verdict: "replacement_conflict", detail: `tombstone generation ${String(generation)} 超过 summary 已闭合的 finalGeneration ${String(summary.finalGeneration)}（未来代不可证明）` };
  }
  if (summary.authorityClass === undefined) {
    return { verdict: "replacement_missing", detail: "v1 迁移 summary 缺 authorityClass（proof class 不可证明——pin，不猜测）" };
  }
  if (summary.schemaVersion < TREASURY_RETIREMENT_SUMMARY_VERSION) {
    return {
      verdict: "replacement_missing",
      detail: "旧 terminal summary（replay-only）不得驱逐 historical child tombstone（exact terminal authority 不可证明——pin）",
    };
  }
  const expectedId = generation <= 0
    ? summary.rootTransactionId
    : deriveTreasuryLineageNextChildTransactionId(summary.lineageId, generation, summary.rootTransactionId);
  if (expectedId !== tombstone.transactionId) {
    return { verdict: "replacement_conflict", detail: `tombstone transaction ID 与 summary (lineageId, generation, root) 派生不一致（checksum 绑定 root——错误 lineage/root 不可证明）` };
  }
  const expectedParent = generation - 1 <= 0
    ? summary.rootTransactionId
    : deriveTreasuryLineageNextChildTransactionId(summary.lineageId, generation - 1, summary.rootTransactionId);
  const expectedBinding = computeTreasuryLineageBindingDigest({
    lineageId: summary.lineageId,
    generation,
    parentTransactionId: expectedParent,
    childTransactionId: tombstone.transactionId,
  });
  if (tombstone.lineageBindingDigest !== undefined && tombstone.lineageBindingDigest !== expectedBinding) {
    return { verdict: "replacement_conflict", detail: "tombstone lineage binding 与 summary (lineageId, generation, parent, child) 重算不一致" };
  }
  if (tombstone.proofLevel !== summary.authorityClass) {
    return { verdict: "replacement_conflict", detail: `tombstone proof class ${String(tombstone.proofLevel)} 与 summary authority class ${String(summary.authorityClass)} 不匹配` };
  }
  if (generation === summary.finalGeneration && summary.terminalState !== "non_rearmable_retired") {
    return { verdict: "replacement_conflict", detail: `finalGeneration ${String(generation)} 是 committed 代（${summary.terminalState}）——committed 代不存在 not-executed 结局（generation 混用）` };
  }
  // 【第二十轮 12.4 / 第二十一轮 12.3】membership / identity 由 exact
  // retirement proof 证明（tombstone 持久 parent 由 compare 显式比较）。
  const proofHealth = peekTreasuryGenerationRetirementHealth();
  if (!proofHealth.healthy) {
    return { verdict: "store_unhealthy", detail: proofHealth.detail ?? "exact generation retirement store 损坏（retention fail closed）" };
  }
  const generationProof = readTreasuryGenerationRetirementProof(summary.lineageId, generation);
  if (generationProof === undefined) {
    return {
      verdict: "replacement_missing",
      detail: `summary finalGeneration=${String(summary.finalGeneration)} 存在但历史 generation ${String(generation)} 无 exact retirement authority（finalGeneration 只是边界不是 membership proof——pin）`,
    };
  }
  const proofCompare = compareTreasuryGenerationProofWithTombstone(
    generationProof,
    { ...tombstone, lineageBindingDigest: tombstone.lineageBindingDigest ?? expectedBinding },
    expectedParent,
    expectedBinding,
  );
  if (proofCompare !== null) {
    return { verdict: proofCompare.kind === "missing" ? "replacement_missing" : "replacement_conflict", detail: proofCompare.detail };
  }
  return { verdict: "replacement_match" };
}

/**
 * 单条 final not-executed tombstone 的驱逐资格判定（evictExpiredTombstones
 * 逐条调用——单条 O(1) 索引查询 + 单条 exact proof 查询，不扫描 lineage
 * store / exact retirement history）。
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
    // active record 缺失：root tombstone 按 root 查询 summary（五元重算 +
    // proofLevel + generation 0 exact proof——不再仅凭 ID 命中）；v2 child
    // 依据自身完整 lineage proof 按 lineageId 定位 summary 并重演验证
    //（membership 由 exact proof 证明）。
    const summaryHealth = peekTreasuryRetirementSummaryHealth();
    if (!summaryHealth.healthy) {
      return { verdict: "store_unhealthy", detail: summaryHealth.detail ?? "retirement summary store 损坏（retention fail closed）" };
    }
    const rootSummary = lookupTreasuryRetirementSummaryByRoot(tombstone.transactionId);
    if (rootSummary !== undefined && rootSummary.rootTransactionId === tombstone.transactionId) {
      return verdictOfRootSummary(rootSummary, tombstone);
    }
    if (parsed === null) {
      if (isTreasuryRearmAttemptId(tombstone.transactionId)) {
        return { verdict: "replacement_missing", detail: "v1 rearm child ID 不可 generation 寻址（无 replacement 证明——永久 pin，不猜测 generation）" };
      }
      return { verdict: "replacement_missing", detail: `attempt ${tombstone.transactionId.slice(0, 24)} 无 lineage replacement（Round 16 遗留 / backfill 未完成 / 已迁移隔离）` };
    }
    // v2 child：未携带完整 lineage proof 的旧 tombstone 不得借 summary 猜测
    // 归属（E.4）——继续 pin。
    if (
      tombstone.lineageId === undefined || tombstone.lineageGeneration === undefined ||
      tombstone.parentTransactionId === undefined || tombstone.lineageBindingDigest === undefined
    ) {
      return { verdict: "replacement_missing", detail: "v2 child tombstone 缺完整 lineage proof（压缩后不可由 summary 猜测归属——pin）" };
    }
    if (tombstone.lineageId !== parsed.lineageId || tombstone.lineageGeneration !== parsed.generation) {
      return { verdict: "replacement_conflict", detail: "tombstone 自身 lineage proof 与 ID 内嵌 (lineageId, generation) 不一致" };
    }
    const summary = lookupTreasuryRetirementSummaryByLineageId(parsed.lineageId);
    if (summary === undefined) {
      return { verdict: "replacement_missing", detail: `lineage ${parsed.lineageId.slice(0, 12)} 无 terminal summary（不可定位 replacement——pin）` };
    }
    return verdictOfSummaryProof(summary, tombstone, parsed.generation);
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
  // binding（v7 tombstone 携带时完整比较；任意历史代 binding 可 O(1) 重算）。
  const expectedBinding = generation >= 1 ? bindingOfGeneration(record, generation) : undefined;
  if (generation >= 1 && tombstone.lineageBindingDigest !== undefined && tombstone.lineageBindingDigest !== expectedBinding) {
    return { verdict: "replacement_conflict", detail: "tombstone lineage binding 与该 generation 重算 binding 不一致" };
  }
  const isCurrentGeneration = generation === record.generation;
  if (isCurrentGeneration) {
    // 当前代：digest 完整比较 + 持久 parent 完整比较（【第二十轮 12.2】不得
    // 只校验 binding 而忽略持久 parent 字段）+ identity 维度 + 三段完成 +
    // retirementGeneration 归属检查（上一代全 true 不得授权当前代驱逐）。
    if (tombstone.digest !== record.currentIdentity.digest) {
      return { verdict: "replacement_conflict", detail: "tombstone digest 与 lineage 当前代 attempt identity digest 不一致" };
    }
    if (
      (tombstone.contractDigest ?? undefined) !== (record.currentIdentity.contractDigest ?? undefined) ||
      (tombstone.authorizationCohortDigest ?? undefined) !== (record.currentIdentity.authorizationCohortDigest ?? undefined) ||
      (tombstone.durableIdentityDigest ?? undefined) !== (record.currentIdentity.durableIdentityDigest ?? undefined) ||
      (tombstone.lowlevelSource ?? undefined) !== (record.currentIdentity.lowlevelSource ?? record.lowlevelSource ?? undefined)
    ) {
      return { verdict: "replacement_conflict", detail: "tombstone 的 contract/cohort/durable/lowlevel identity 维度与 lineage 当前代不一致" };
    }
    if (generation >= 1) {
      if (tombstone.parentTransactionId === undefined) {
        return { verdict: "replacement_conflict", detail: "generation≥1 tombstone 缺持久 parentTransactionId（parent 维度不可省略）" };
      }
      if (tombstone.parentTransactionId !== record.currentParentTransactionId) {
        return { verdict: "replacement_conflict", detail: "tombstone 持久 parentTransactionId 与 record.currentParentTransactionId 不一致（篡改/代际混用）" };
      }
    } else if (tombstone.parentTransactionId !== undefined) {
      return { verdict: "replacement_conflict", detail: "generation 0（root 代）tombstone 不得携带 parentTransactionId" };
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
    // 【第二十一轮 9.1】当前代（含 root 代 generation 0）的 replacement 必须
    // 由 matching exact retirement proof 证明——三阶段布尔值不单独充当
    // replacement（record 已进入 rearm_ready 也一样：proof 缺失/冲突/损坏 →
    // pin，不删除证据）。
    const proofHealth = peekTreasuryGenerationRetirementHealth();
    if (!proofHealth.healthy) {
      return { verdict: "store_unhealthy", detail: proofHealth.detail ?? "exact generation retirement store 损坏（retention fail closed）" };
    }
    const currentGenerationProof = readTreasuryGenerationRetirementProof(record.lineageId, generation);
    if (currentGenerationProof === undefined) {
      return {
        verdict: "replacement_missing",
        detail: `当前 generation ${String(generation)} 无 matching exact retirement proof（三阶段布尔不构成 replacement——pin，不删除证据）`,
      };
    }
    const currentRequirednessError = describeTreasuryCurrentLineageRequiredness(record);
    const currentExact = currentRequirednessError === null ? expectedTreasuryCurrentLineageExactIdentity(record) : null;
    if (currentExact === null) {
      return {
        verdict: "replacement_missing",
        detail: `record current 身份不满足 requiredness（${currentRequirednessError ?? "构造失败"}）——当前代 replacement 不可证明（pin）`,
      };
    }
    const retirementRelation = verifyTreasuryGenerationRetirementRelation({
      exactProof: currentGenerationProof,
      expectedCurrent: {
        ...currentExact,
        rootTransactionId: record.rootTransactionId,
        rootIdentityDigest: computeTreasuryGenerationRootIdentityDigest(record.rootIdentity),
        authorityLineageId: record.lineageId,
        authorityGeneration: record.generation,
      },
      tombstone,
    });
    if (retirementRelation.verdict !== "match") {
      return {
        verdict: retirementRelation.verdict === "conflict" ? "replacement_conflict" : "replacement_missing",
        detail: `当前代 exact retirement proof 三方 relation 未通过（${retirementRelation.detail}）`,
      };
    }
    return { verdict: "replacement_match" };
  }
  // ──【第二十轮 12.3 / 第二十一轮 12.2】历史代（generation < record.generation）：
  //    删除 "状态机曾推进即 match" 的推断——必须命中 exact generation
  //    retirement authority 并完整比较（ID/parent/binding 派生、proof class、
  //    digest 及 contract/cohort/durable/lowlevel identity 维度、tombstone
  //    持久 parent 字段——单一 relation 实现）。
  const expectedParent = expectedTreasuryLineageAttemptId(record, generation - 1);
  const proofHealth = peekTreasuryGenerationRetirementHealth();
  if (!proofHealth.healthy) {
    return { verdict: "store_unhealthy", detail: proofHealth.detail ?? "exact generation retirement store 损坏（retention fail closed）" };
  }
  const generationProof = readTreasuryGenerationRetirementProof(record.lineageId, generation);
  if (generationProof === undefined) {
    return {
      verdict: "replacement_missing",
      detail: `历史 generation ${String(generation)} 无 exact retirement proof（generation < currentGeneration 不是证明——状态机曾推进不构成可验证的持久 attempt proof；pin，不猜测）`,
    };
  }
  const proofCompare = compareTreasuryGenerationProofWithTombstone(generationProof, tombstone, expectedParent, expectedBinding);
  if (proofCompare !== null) {
    return { verdict: proofCompare.kind === "missing" ? "replacement_missing" : "replacement_conflict", detail: proofCompare.detail };
  }
  return { verdict: "replacement_match" };
}

// 装配注册（resolutionStore 不 import 本模块——保持单向依赖；facade import
// 本模块保证注册生效）。
registerTreasuryRetentionLineageLookupForAssembly((tombstone) => treasuryTombstoneReplacementVerdict(tombstone));
