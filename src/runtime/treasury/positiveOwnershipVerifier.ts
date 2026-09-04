/**
 * 【Round 22 Remediation XII 工作流 A / 3.1-3.3】opening-bound positive
 * ownership verifier——ticket handoff 的正向 owner 唯一判定权威。
 *
 * XI 及之前的缺陷：
 *  - `resolveTreasuryAttemptLifecycleOwnership` 只按 transactionId 判定
 *    exact_owner（同 ID 不同 contract/durable/cohort 的 owner 会被误判为
 *    "已接管"——O1/O2）；
 *  - resolver 是 12 级 first-match：前方 matching Intent 遮蔽后方 store
 *    unhealthy / identity conflict（3.3 禁止）。
 *
 * 本模块把正向 owner 验证与通用 GC 判定分离（4.1——通用 resolver 保留给
 * orphan GC / TTL sweep / sequence abandon / "不得删除"判断）：
 *  - expected identity 必须由当前执行状态机构造（facade 的 contract /
 *    lowlevel 通道——4.2），不得从 owner entry 反推；
 *  - 全部相关 source 先收集、后统一裁决（无 first-match short-circuit）：
 *    Intent / Quarantine / cleanup journal / Authorization Fault / write-fault
 *    marker / Resolution tombstone / attempt lineage / live completion /
 *    historical completion / settled receipt / GRA proof / retirement summary /
 *    chain certificate / retired range；
 *  - 裁决优先级（3.3）：store_unhealthy > probe_unavailable > identity_
 *    conflict > outcome_conflict > insufficient > protocol_only/retired_only
 *    （与 exact match 并存时同样阻断）> 全部一致 match → owner phase；
 *  - verdict 区分 matching_not_started_owner / matching_execution_owner /
 *    matching_terminal_owner（4.4——not_started 不得被解释为 handoff
 *    recovered；execution/terminal 才允许幂等 consume）；
 *  - 全部读取零写（XII 工作流 D 的 query-pure API）。
 */

import {
  peekTreasuryIntentStoreValidation,
  readTreasuryIntentEntryForQuery,
} from "@/runtime/treasury/intents";
import {
  peekTreasuryQuarantineStoreValidation,
  readTreasuryQuarantineEntryForQuery,
} from "@/runtime/treasury/quarantine";
import {
  peekTreasuryResolutionCleanupHealth,
  readTreasuryResolutionCleanupEntry,
} from "@/runtime/treasury/resolutionCleanupJournal";
import {
  peekTreasuryAuthorizationFaultStoreValidation,
  readTreasuryAuthorizationFaultEntry,
} from "@/runtime/treasury/authorizationFaults";
import { peekTreasuryWriteFaultHealth, readTreasuryWriteFault } from "@/runtime/treasury/writeFault";
import { readTreasuryResolutionTombstone } from "@/runtime/treasury/resolutionStore";
import { lookupTreasuryAttemptLineageByAttemptId, peekTreasuryAttemptLineageHealth } from "@/runtime/treasury/attemptLineage";
import { lookupTreasuryCleanupCompletion } from "@/runtime/treasury/cleanupCompletionAuthority";
import { lookupTreasuryHistoricalCompletion } from "@/runtime/treasury/cleanupSupersessionAuthority";
import {
  lookupTreasurySettledReceipt,
  peekTreasuryReceiptStoreTrustedValidation,
} from "@/runtime/treasury/receipts";
import {
  lookupTreasuryGenerationRetirementProofByAttemptId,
  peekTreasuryGenerationRetirementHealth,
} from "@/runtime/treasury/generationRetirementAuthority";
import { lookupTreasuryRetirementSummaryByRoot, peekTreasuryRetirementSummaryHealth } from "@/runtime/treasury/lineageRetirementSummary";
import {
  lookupTreasuryChainRetirementCertificate,
  lookupTreasuryRetiredRangeStructured,
  peekTreasuryChainRetirementCertificateHealth,
} from "@/runtime/treasury/chainRetirementCertificate";
import {
  treasuryExactAttemptIdentityOfAuthority,
  treasuryExactAttemptIdentityOfReceiptProof,
  treasuryExactAttemptIdentityOfTombstone,
  treasuryExactAttemptIdentityOfFacts,
  treasuryExactAttemptIdentityRelation,
  treasuryProofClassOfPersistedClass,
  type TreasuryExactAttemptIdentity,
} from "@/runtime/treasury/exactAttemptIdentity";

/** 【XII 4.1】正向 owner verdict（具体语义见文件头）。 */
export type TreasuryPositiveOwnershipVerdict =
  | { readonly verdict: "matching_not_started_owner"; readonly owner: string }
  | { readonly verdict: "matching_execution_owner"; readonly owner: string }
  | { readonly verdict: "matching_terminal_owner"; readonly owner: string; readonly terminalOutcome: "committed" | "not-executed" | "unknown" }
  | { readonly verdict: "absent" }
  | { readonly verdict: "identity_conflict"; readonly detail: string }
  | { readonly verdict: "outcome_conflict"; readonly detail: string }
  | { readonly verdict: "insufficient"; readonly detail: string }
  | { readonly verdict: "store_unhealthy"; readonly detail: string }
  | { readonly verdict: "probe_unavailable"; readonly detail: string }
  | { readonly verdict: "protocol_only"; readonly detail: string }
  | { readonly verdict: "retired_only"; readonly detail: string };

/** attempt 的 owner phase（4.4：not_started / execution / terminal 严格分离）。 */
type TreasuryOwnerPhase = "not_started" | "execution" | "terminal";

/** terminal source 的结论（用于 outcome_conflict 检测）。 */
type TreasuryTerminalOutcome = "committed" | "not-executed" | "unknown";

/** 单个 source 的聚合前观察。 */
interface SourceObservation {
  readonly source: string;
  readonly relation:
    | "absent"
    | "match"
    | "conflict"
    | "insufficient"
    | "unhealthy"
    | "protocol_only"
    | "retired_only";
  readonly phase?: TreasuryOwnerPhase;
  readonly terminalOutcome?: TreasuryTerminalOutcome;
  readonly owner?: string;
  readonly detail?: string;
}

const ABSENT = (source: string): SourceObservation => ({ source, relation: "absent" });

/**
 * expected opening identity 与单个持久 authority entry 的精确 relation。
 * 返回 null = 维度不足（entry 无法构造 exact 视图——insufficient）。
 */
function identityOfIntentEntry(entry: NonNullable<ReturnType<typeof readTreasuryIntentEntryForQuery>>): TreasuryExactAttemptIdentity | null {
  return treasuryExactAttemptIdentityOfAuthority({
    transactionId: entry.transactionId,
    digest: entry.digest,
    contractDigest: entry.contractDigest,
    authorizationCohortDigest: entry.authorizationCohortDigest,
    durableIdentityDigest: entry.durableIdentityDigest,
    lowlevelSource: entry.lowlevelSource,
    authorityLevel: entry.authorityLevel,
    lineageId: entry.lineageId,
    lineageGeneration: entry.lineageGeneration,
    parentTransactionId: entry.parentTransactionId,
    lineageBindingDigest: entry.lineageBindingDigest,
  });
}

function identityOfQuarantineEntry(entry: NonNullable<ReturnType<typeof readTreasuryQuarantineEntryForQuery>>): TreasuryExactAttemptIdentity | null {
  return treasuryExactAttemptIdentityOfAuthority({
    transactionId: entry.transactionId,
    digest: entry.digest,
    contractDigest: entry.contractDigest,
    authorizationCohortDigest: entry.authorizationCohortDigest,
    durableIdentityDigest: entry.durableIdentityDigest,
    lowlevelSource: entry.lowlevelSource,
    authorityLevel: (entry as { authorityLevel?: string }).authorityLevel,
    lineageId: entry.lineageId,
    lineageGeneration: entry.lineageGeneration,
    parentTransactionId: entry.parentTransactionId,
    lineageBindingDigest: entry.lineageBindingDigest,
  });
}

/** intent (outcome, settlement) → owner phase（4.4 状态机映射）。 */
function intentOwnerPhase(outcome: string, settlement: string): TreasuryOwnerPhase {
  if (outcome === "not_started") {
    // (not_started, ready) = callback 确定未开始；其余组合为 shape 校验挡的
    // 非法态——防御按 execution（保守：可能已开始）。
    return settlement === "ready" ? "not_started" : "execution";
  }
  if (outcome === "returned_ok" || outcome === "returned_non_ok" || outcome === "aborted_final") {
    return settlement === "finalized" ? "terminal" : "execution";
  }
  // started_unknown 及未知值：callback 可能已开始——execution（保守）。
  return "execution";
}

/**
 * 【XII 工作流 A 核心】opening-bound 正向 owner 验证（全 source 聚合，无
 * first-match）。expected 必须由当前执行状态机构造（完整维度——contract
 * 通道含 canonical digest / contract digest / cohort digest / durable
 * identity digest / proofClass；tr1_ 含 lineage 四字段；某维度对通道不
 * 适用时省略，但持久 owner 携带而 expected 省略的维度按 insufficient
 * 判定——不得静默跳过）。
 */
export function verifyTreasuryPositiveOwnershipForOpening(
  transactionId: string,
  expected: TreasuryExactAttemptIdentity,
): TreasuryPositiveOwnershipVerdict {
  if (expected.transactionId !== transactionId) {
    return { verdict: "identity_conflict", detail: "expected opening identity 的 transactionId 与查询目标不一致（内部协议错误）" };
  }
  const observations: SourceObservation[] = [];

  // 1) durable Intent（owner phase 判定的主 source）。
  const intentValidation = peekTreasuryIntentStoreValidation();
  if (intentValidation.status === "unhealthy" || intentValidation.status === "migration_required") {
    observations.push({ source: "intent", relation: "unhealthy", detail: intentValidation.detail });
  } else {
    const entry = readTreasuryIntentEntryForQuery(transactionId);
    if (entry === undefined) {
      observations.push(ABSENT("intent"));
    } else {
      const identity = identityOfIntentEntry(entry);
      if (identity === null) {
        observations.push({ source: "intent", relation: "insufficient", owner: "durable intent", detail: "intent entry 无法构造 exact identity 视图（缺 digest / lineage 部分携带）" });
      } else if ((entry as { legacyV1?: boolean }).legacyV1 === true) {
        observations.push({ source: "intent", relation: "insufficient", owner: "durable intent", detail: "legacy intent entry（replay-only——不得作为 modern exact owner）" });
      } else {
        const relation = treasuryExactAttemptIdentityRelation(identity, expected);
        observations.push(
          relation === "match"
            ? { source: "intent", relation: "match", phase: intentOwnerPhase(entry.outcome, entry.settlement), owner: "durable intent" }
            : { source: "intent", relation, owner: "durable intent", detail: `intent identity ${relation}` },
        );
      }
    }
  }

  // 2) Quarantine（execution-unknown / fault 的保守权威）。
  const quarantineValidation = peekTreasuryQuarantineStoreValidation();
  if (quarantineValidation.status === "unhealthy" || quarantineValidation.status === "migration_required") {
    observations.push({ source: "quarantine", relation: "unhealthy", detail: quarantineValidation.detail });
  } else {
    const entry = readTreasuryQuarantineEntryForQuery(transactionId);
    if (entry === undefined) {
      observations.push(ABSENT("quarantine"));
    } else if ((entry as { legacyV1?: boolean }).legacyV1 === true || (entry as { forensic?: unknown }).forensic !== undefined) {
      observations.push({ source: "quarantine", relation: "insufficient", owner: "durable quarantine", detail: "legacy/forensic quarantine entry（不可作为 modern exact owner）" });
    } else {
      const identity = identityOfQuarantineEntry(entry);
      if (identity === null) {
        observations.push({ source: "quarantine", relation: "insufficient", owner: "durable quarantine", detail: "quarantine entry 无法构造 exact identity 视图" });
      } else {
        const relation = treasuryExactAttemptIdentityRelation(identity, expected);
        observations.push(
          relation === "match"
            ? { source: "quarantine", relation: "match", phase: "execution", owner: "durable quarantine" }
            : { source: "quarantine", relation, owner: "durable quarantine", detail: `quarantine identity ${relation}` },
        );
      }
    }
  }

  // 3) cleanup journal（四阶段 pending 权威——identity 完整）。
  const journalHealth = peekTreasuryResolutionCleanupHealth();
  if (!journalHealth.healthy) {
    observations.push({ source: "cleanup-journal", relation: "unhealthy", detail: journalHealth.detail ?? "" });
  } else {
    const entry = readTreasuryResolutionCleanupEntry(transactionId);
    if (entry === undefined) {
      observations.push(ABSENT("cleanup-journal"));
    } else {
      const identity = treasuryExactAttemptIdentityOfFacts(
        transactionId,
        {
          digest: entry.digest,
          contractDigest: entry.contractDigest,
          authorizationCohortDigest: entry.authorizationCohortDigest,
          durableIdentityDigest: entry.durableIdentityDigest,
          lowlevelSource: entry.lowlevelSource,
          lineageId: entry.lineageId,
          lineageGeneration: entry.lineageGeneration,
          parentTransactionId: entry.parentTransactionId,
          lineageBindingDigest: entry.lineageBindingDigest,
        },
        treasuryProofClassOfPersistedClass(entry.proofClass),
      );
      if (identity === null) {
        observations.push({ source: "cleanup-journal", relation: "insufficient", owner: "cleanup journal", detail: "journal entry 无法构造 exact identity 视图" });
      } else {
        const relation = treasuryExactAttemptIdentityRelation(identity, expected);
        observations.push(
          relation === "match"
            ? { source: "cleanup-journal", relation: "match", phase: "execution", owner: "cleanup journal" }
            : { source: "cleanup-journal", relation, owner: "cleanup journal", detail: `journal identity ${relation}` },
        );
      }
    }
  }

  // 4) Authorization Fault（active 类）。
  const faultValidation = peekTreasuryAuthorizationFaultStoreValidation();
  if (faultValidation.status === "unhealthy" || faultValidation.status === "migration_required") {
    observations.push({ source: "authorization-fault", relation: "unhealthy", detail: faultValidation.detail });
  } else {
    const entry = readTreasuryAuthorizationFaultEntry(transactionId);
    if (entry === undefined) {
      observations.push(ABSENT("authorization-fault"));
    } else {
      const identity = treasuryExactAttemptIdentityOfAuthority({
        transactionId: entry.transactionId,
        digest: entry.digest,
        contractDigest: entry.contractDigest,
        authorizationCohortDigest: entry.authorizationCohortDigest,
        durableIdentityDigest: entry.durableIdentityDigest,
        lowlevelSource: entry.lowlevelSource,
        authorityLevel: (entry as { authorityLevel?: string }).authorityLevel,
        lineageId: entry.lineageId,
        lineageGeneration: entry.lineageGeneration,
        parentTransactionId: entry.parentTransactionId,
        lineageBindingDigest: entry.lineageBindingDigest,
      });
      if (identity === null) {
        observations.push({ source: "authorization-fault", relation: "insufficient", owner: "authorization fault", detail: "fault entry 无法构造 exact identity 视图" });
      } else {
        const relation = treasuryExactAttemptIdentityRelation(identity, expected);
        observations.push(
          relation === "match"
            ? { source: "authorization-fault", relation: "match", phase: "execution", owner: "authorization fault" }
            : { source: "authorization-fault", relation, owner: "authorization fault", detail: `fault identity ${relation}` },
        );
      }
    }
  }

  // 5) write-fault marker（单条全局 marker——transactionId 匹配才相关）。
  const markerHealth = peekTreasuryWriteFaultHealth();
  if (!markerHealth.healthy) {
    observations.push({ source: "write-fault-marker", relation: "unhealthy", detail: markerHealth.detail ?? "" });
  } else {
    const marker = readTreasuryWriteFault();
    if (marker === undefined || marker.transactionId !== transactionId) {
      observations.push(ABSENT("write-fault-marker"));
    } else {
      const identity = treasuryExactAttemptIdentityOfFacts(
        transactionId,
        {
          digest: (marker as { digest?: string }).digest,
          contractDigest: (marker as { contractDigest?: string }).contractDigest,
          authorizationCohortDigest: (marker as { authorizationCohortDigest?: string }).authorizationCohortDigest,
          durableIdentityDigest: (marker as { durableIdentityDigest?: string }).durableIdentityDigest,
          lowlevelSource: (marker as { lowlevelSource?: string }).lowlevelSource,
          lineageId: marker.lineageId,
          lineageGeneration: marker.lineageGeneration,
          parentTransactionId: marker.parentTransactionId,
          lineageBindingDigest: marker.lineageBindingDigest,
        },
        treasuryProofClassOfIdentityFactsOf(marker),
      );
      if (identity === null) {
        observations.push({ source: "write-fault-marker", relation: "insufficient", owner: "write-fault marker", detail: "marker 无法构造 exact identity 视图" });
      } else {
        const relation = treasuryExactAttemptIdentityRelation(identity, expected);
        observations.push(
          relation === "match"
            ? { source: "write-fault-marker", relation: "match", phase: "execution", owner: "write-fault marker" }
            : { source: "write-fault-marker", relation, owner: "write-fault marker", detail: `marker identity ${relation}` },
        );
      }
    }
  }

  // 6) Resolution tombstone（resolving = execution；final = terminal + 结论）。
  const tombstone = readTreasuryResolutionTombstone(transactionId);
  if (tombstone === undefined) {
    observations.push(ABSENT("resolution-tombstone"));
  } else {
    const identity = treasuryExactAttemptIdentityOfTombstone(tombstone as Parameters<typeof treasuryExactAttemptIdentityOfTombstone>[0]);
    const outcome = (tombstone as { resolution?: string }).resolution === "committed" ? "committed" : "not-executed";
    if (identity === null) {
      observations.push({ source: "resolution-tombstone", relation: "insufficient", owner: "resolution tombstone", detail: "tombstone 无法构造 exact identity 视图" });
    } else {
      const relation = treasuryExactAttemptIdentityRelation(identity, expected);
      const stage = (tombstone as { stage?: unknown }).stage;
      observations.push(
        relation === "match"
          ? stage === "final"
            ? { source: "resolution-tombstone", relation: "match", phase: "terminal", terminalOutcome: outcome, owner: "final resolution tombstone" }
            : { source: "resolution-tombstone", relation: "match", phase: "execution", owner: "resolving resolution" }
          : { source: "resolution-tombstone", relation, owner: "resolution tombstone", detail: `tombstone identity ${relation}` },
      );
    }
  }

  // 7) attempt lineage（active/terminal record）。
  const lineageHealth = peekTreasuryAttemptLineageHealth();
  if (!lineageHealth.healthy) {
    observations.push({ source: "attempt-lineage", relation: "unhealthy", detail: lineageHealth.detail ?? "" });
  } else {
    const record = lookupTreasuryAttemptLineageByAttemptId(transactionId);
    if (record === undefined) {
      observations.push(ABSENT("attempt-lineage"));
    } else if (record.state === "chain_committed" || record.state === "non_rearmable_retired" || record.state === "forensic_isolated") {
      observations.push({ source: "attempt-lineage", relation: "protocol_only", owner: `terminal lineage（${record.state}）`, detail: "terminal lineage 只构成 protocol 阻断（root 级 chain 权威——不是该 attempt 的 exact owner）" });
    } else {
      observations.push({ source: "attempt-lineage", relation: "protocol_only", owner: `active lineage（${record.state}）`, detail: "lineage record 是 chain 协议权威（child/current 接管语义由 capability/lineage 承载）——不按 attempt exact identity 判定 owner" });
    }
  }

  // 8) live completion（pair——已有 expected 参数的权威比较）。
  const completion = lookupTreasuryCleanupCompletion(transactionId, expected);
  if (completion.verdict === "store_unhealthy") {
    observations.push({ source: "live-completion", relation: "unhealthy", detail: completion.detail });
  } else if (completion.verdict === "conflict") {
    observations.push({ source: "live-completion", relation: "conflict", owner: "live completion", detail: "live completion 权威冲突（identity 不一致）" });
  } else if (completion.verdict === "match") {
    observations.push({ source: "live-completion", relation: "match", phase: "terminal", terminalOutcome: "unknown", owner: "matching live completion（pair）" });
  } else {
    observations.push(ABSENT("live-completion"));
  }

  // 9) historical completion（archive——已有 expected 参数）。
  const historical = lookupTreasuryHistoricalCompletion(transactionId, expected);
  if (historical.verdict === "store_unhealthy") {
    observations.push({ source: "historical-completion", relation: "unhealthy", detail: historical.detail });
  } else if (historical.verdict === "conflict") {
    observations.push({ source: "historical-completion", relation: "conflict", owner: "historical completion", detail: "historical completion 权威冲突" });
  } else if (historical.verdict === "match") {
    observations.push({ source: "historical-completion", relation: "match", phase: "terminal", terminalOutcome: "unknown", owner: "historical completion（durable archive）" });
  } else {
    observations.push(ABSENT("historical-completion"));
  }

  // 10) settled receipt（terminal 权威——trusted 校验 + normalized 零写读取）。
  const receiptValidation = peekTreasuryReceiptStoreTrustedValidation();
  if (receiptValidation.status === "absent") {
    observations.push(ABSENT("settled-receipt"));
  } else if (receiptValidation.status !== "valid") {
    observations.push({ source: "settled-receipt", relation: "unhealthy", detail: receiptValidation.detail });
  } else {
    const receipt = lookupTreasurySettledReceipt(transactionId);
    if (receipt.status === "corrupted" || receipt.status === "incompatible") {
      observations.push({ source: "settled-receipt", relation: "unhealthy", detail: `settled receipt ${receipt.status}` });
    } else if (receipt.status === "legacy_committed") {
      observations.push({ source: "settled-receipt", relation: "insufficient", owner: "settled receipt", detail: "legacy receipt（replay-only——不得作为 modern exact owner，O5）" });
    } else if (receipt.status === "modern_committed") {
      const proof = receipt.proof as Parameters<typeof treasuryExactAttemptIdentityOfReceiptProof>[1];
      const identity = treasuryExactAttemptIdentityOfReceiptProof(transactionId, proof);
      if (identity === null || (proof.level ?? "legacy") === "legacy") {
        observations.push({ source: "settled-receipt", relation: "insufficient", owner: "settled receipt", detail: "legacy 等级 receipt proof（replay-only——不得作为 modern exact owner，O5）" });
      } else {
        const relation = treasuryExactAttemptIdentityRelation(identity, expected);
        observations.push(
          relation === "match"
            ? { source: "settled-receipt", relation: "match", phase: "terminal", terminalOutcome: "committed", owner: "settled receipt" }
            : { source: "settled-receipt", relation, owner: "settled receipt", detail: `receipt identity ${relation}` },
        );
      }
    } else {
      observations.push(ABSENT("settled-receipt"));
    }
  }

  // 11) GRA proof（terminal——exact per-generation retirement proof）。
  const graHealth = peekTreasuryGenerationRetirementHealth();
  if (!graHealth.healthy) {
    observations.push({ source: "gra-proof", relation: "unhealthy", detail: graHealth.detail ?? "" });
  } else {
    const proof = lookupTreasuryGenerationRetirementProofByAttemptId(transactionId);
    if (proof === undefined) {
      observations.push(ABSENT("gra-proof"));
    } else {
      const identity = treasuryExactAttemptIdentityOfFacts(
        transactionId,
        {
          digest: proof.digest,
          contractDigest: proof.contractDigest,
          authorizationCohortDigest: proof.authorizationCohortDigest,
          durableIdentityDigest: proof.durableIdentityDigest,
          lowlevelSource: proof.lowlevelSource,
          lineageId: proof.lineageId,
          lineageGeneration: proof.generation,
          parentTransactionId: proof.parentTransactionId,
          lineageBindingDigest: proof.bindingDigest,
        },
        proof.authorityClass === "lowlevel" ? "lowlevel" : "identity-bound",
      );
      if (identity === null) {
        observations.push({ source: "gra-proof", relation: "insufficient", owner: "generation retirement proof", detail: "GRA proof 无法构造 exact identity 视图" });
      } else {
        const relation = treasuryExactAttemptIdentityRelation(identity, expected);
        observations.push(
          relation === "match"
            ? { source: "gra-proof", relation: "match", phase: "terminal", terminalOutcome: "not-executed", owner: "generation retirement proof" }
            : { source: "gra-proof", relation, owner: "generation retirement proof", detail: `GRA identity ${relation}` },
        );
      }
    }
  }

  // 12) retirement summary（root 级 protocol 权威——chain 终局）。
  const summaryHealth = peekTreasuryRetirementSummaryHealth();
  if (!summaryHealth.healthy) {
    observations.push({ source: "retirement-summary", relation: "unhealthy", detail: summaryHealth.detail ?? "" });
  } else {
    const summary = lookupTreasuryRetirementSummaryByRoot(transactionId);
    if (summary === undefined) {
      observations.push(ABSENT("retirement-summary"));
    } else {
      observations.push({ source: "retirement-summary", relation: "protocol_only", owner: "retirement summary", detail: "summary 是 root 级 chain 终局协议权威（阻断执行——不构成 attempt 级 exact owner）" });
    }
  }

  // 13) chain certificate / retired range（protocol / anti-reuse 权威）。
  const certificateHealth = peekTreasuryChainRetirementCertificateHealth();
  if (!certificateHealth.healthy) {
    observations.push({ source: "chain-certificate", relation: "unhealthy", detail: certificateHealth.detail ?? "" });
  } else if (lookupTreasuryChainRetirementCertificate(transactionId) !== undefined) {
    observations.push({ source: "chain-certificate", relation: "protocol_only", owner: "chain certificate", detail: "certificate 覆盖该 root（protocol 阻断——不得用于消费 active ticket，O7）" });
  } else {
    observations.push(ABSENT("chain-certificate"));
  }
  const range = lookupTreasuryRetiredRangeStructured(transactionId);
  if (range.status === "store_unhealthy" || range.status === "malformed") {
    observations.push({ source: "retired-range", relation: "unhealthy", detail: `retired range ${range.status}` });
  } else if (range.status === "present") {
    observations.push({ source: "retired-range", relation: "retired_only", owner: "retired range", detail: range.detail });
  } else {
    observations.push(ABSENT("retired-range"));
  }

  return adjudicatePositiveOwnership(observations);
}

function treasuryProofClassOfIdentityFactsOf(entry: { digest?: string; durableIdentityDigest?: string; lowlevelSource?: string }): "identity-bound" | "lowlevel" | "legacy" {
  if (entry.lowlevelSource !== undefined) return "lowlevel";
  if (entry.digest !== undefined && entry.durableIdentityDigest !== undefined) return "identity-bound";
  return "legacy";
}

/**
 * 严格 relation（expected 的可选维度缺失 + owner 携带 → insufficient——
 * 复用 exactAttemptIdentity 的对称 relation 语义，本函数只是命名包装）。
 */
/**
 * 统一裁决（3.3——全部观察到齐后判定，无 first-match）：
 *  1. 任一 store unhealthy → store_unhealthy（前方 match 不得遮蔽）；
 *  2. 任一 identity conflict → identity_conflict；
 *  3. 有结论的 terminal source 互相相反 → outcome_conflict；
 *  4. 任一 exact source 只能给出 insufficient（legacy / 视图不完整）→
 *     insufficient（legacy receipt 不得升级为 modern owner——O5）；
 *  5. exact match 与 protocol_only/retired_only 并存 → protocol_only /
 *     retired_only（retired 权威在位时 exact owner 不得接管——4.5）；
 *  6. 全部 exact match 一致 → 按 phase 聚合（not_started/execution/terminal
 *     的相容矩阵，不相容 → outcome_conflict）；
 *  7. 全部 absent → absent。
 */
function adjudicatePositiveOwnership(observations: readonly SourceObservation[]): TreasuryPositiveOwnershipVerdict {
  const unhealthy = observations.find((o) => o.relation === "unhealthy");
  if (unhealthy !== undefined) {
    return { verdict: "store_unhealthy", detail: `${unhealthy.source}: ${unhealthy.detail ?? ""}` };
  }
  const conflict = observations.find((o) => o.relation === "conflict");
  if (conflict !== undefined) {
    return { verdict: "identity_conflict", detail: `${conflict.source}: ${conflict.detail ?? "identity conflict"}` };
  }
  // outcome_conflict：两个有结论的 terminal 观察相反。
  const withOutcome = observations.filter((o) => o.relation === "match" && o.phase === "terminal" && o.terminalOutcome !== undefined && o.terminalOutcome !== "unknown");
  const committed = withOutcome.find((o) => o.terminalOutcome === "committed");
  const notExecuted = withOutcome.find((o) => o.terminalOutcome === "not-executed");
  if (committed !== undefined && notExecuted !== undefined) {
    return { verdict: "outcome_conflict", detail: `terminal 结论相反（${committed.source}=committed 与 ${notExecuted.source}=not-executed）` };
  }
  const insufficient = observations.find((o) => o.relation === "insufficient");
  if (insufficient !== undefined) {
    return { verdict: "insufficient", detail: `${insufficient.source}: ${insufficient.detail ?? "insufficient identity"}` };
  }
  const retired = observations.find((o) => o.relation === "retired_only");
  if (retired !== undefined) {
    return { verdict: "retired_only", detail: retired.detail ?? "retired range 已吸收该 sequence" };
  }
  const matches = observations.filter((o) => o.relation === "match");
  const protocol = observations.find((o) => o.relation === "protocol_only");
  if (matches.length === 0) {
    if (protocol !== undefined) {
      return { verdict: "protocol_only", detail: protocol.detail ?? "protocol 权威在位（阻断执行——不构成 exact owner）" };
    }
    return { verdict: "absent" };
  }
  if (protocol !== undefined) {
    return { verdict: "protocol_only", detail: `${protocol.source} 在位与 exact owner 并存（${protocol.detail ?? ""}——保守阻断）` };
  }
  // phase 聚合：not_started ⊂ execution ⊂ terminal（终局覆盖未定；committed
  // 与 not_started 不相容 → outcome_conflict）。
  const phases = new Set(matches.map((o) => o.phase ?? "execution"));
  if (phases.has("terminal")) {
    const terminal = matches.find((o) => o.phase === "terminal")!;
    const notStarted = matches.find((o) => o.phase === "not_started");
    if (notStarted !== undefined && terminal.terminalOutcome === "committed") {
      return { verdict: "outcome_conflict", detail: "not_started owner 与 committed terminal 权威并存（callback 未开始却已有 committed 结论——矛盾）" };
    }
    return {
      verdict: "matching_terminal_owner",
      owner: terminal.owner ?? "terminal authority",
      terminalOutcome: terminal.terminalOutcome ?? "unknown",
    };
  }
  if (phases.has("execution")) {
    const execution = matches.find((o) => o.phase === "execution")!;
    return { verdict: "matching_execution_owner", owner: execution.owner ?? "execution authority" };
  }
  const notStarted = matches.find((o) => o.phase === "not_started")!;
  return { verdict: "matching_not_started_owner", owner: notStarted.owner ?? "not-started authority" };
}

/**
 * 【XII 工作流 A / 4.2】early ownership probe（execute 层 gate 在 redemption
 * 之前调用——expected 的 durable/cohort 维度尚未构造）。只对**确定**结论
 * 短路：同 ID 且已提供维度（digest/contract）精确比较——全部相等且 owner
 * 处于 execution/terminal phase → owner-present（重试短路，gate 幂等完成
 * handoff）；任一不等 → identity-conflict（O1——不同 opening 不得接管）。
 * 结论不确定（insufficient / not-started owner / 全 absent / unhealthy 由
 * 完整 verify 在 intent 写入后承载）→ indeterminate（继续协议）。
 */
export type TreasuryEarlyOwnershipProbe =
  | { readonly probe: "owner_present"; readonly owner: string }
  | { readonly probe: "identity_conflict"; readonly detail: string }
  | { readonly probe: "indeterminate" };

export function probeTreasuryOpeningOwnershipEarly(
  transactionId: string,
  known: { readonly digest: string; readonly contractDigest?: string },
): TreasuryEarlyOwnershipProbe {
  // early probe 只查"会阻断重试的 active/terminal exact source"：Intent /
  // Quarantine / Authorization Fault（这三个最常见）；其余 source 的聚合
  // 判定由完整 verify 承载（它们即使存在也在 full verify 阶段处理——
  // redemption 之前的中途失败用 not-owner-blocking reason 由上层拒绝）。
  const intentValidation = peekTreasuryIntentStoreValidation();
  if (intentValidation.status === "valid") {
    const entry = readTreasuryIntentEntryForQuery(transactionId);
    if (entry !== undefined && (entry as { legacyV1?: boolean }).legacyV1 !== true) {
      const knownRelation = compareKnownDimensions(
        { digest: entry.digest, contractDigest: entry.contractDigest },
        known,
      );
      if (knownRelation === "conflict") {
        return { probe: "identity_conflict", detail: `durable intent 的 digest/contract 与当前 opening 不一致（同 ID 不同 opening——不得接管，O1）` };
      }
      if (knownRelation === "match") {
        const phase = intentOwnerPhase(entry.outcome, entry.settlement);
        if (phase !== "not_started") return { probe: "owner_present", owner: `durable intent（${phase}）` };
      }
    }
  }
  const quarantineValidation = peekTreasuryQuarantineStoreValidation();
  if (quarantineValidation.status === "valid") {
    const entry = readTreasuryQuarantineEntryForQuery(transactionId);
    if (entry !== undefined && (entry as { legacyV1?: boolean }).legacyV1 !== true && (entry as { forensic?: unknown }).forensic === undefined) {
      const knownRelation = compareKnownDimensions(
        { digest: entry.digest, contractDigest: entry.contractDigest },
        known,
      );
      if (knownRelation === "conflict") {
        return { probe: "identity_conflict", detail: "durable quarantine 的 digest/contract 与当前 opening 不一致（同 ID 不同 opening——不得接管）" };
      }
      if (knownRelation === "match") return { probe: "owner_present", owner: "durable quarantine（execution）" };
    }
  }
  const faultValidation = peekTreasuryAuthorizationFaultStoreValidation();
  if (faultValidation.status === "valid") {
    const entry = readTreasuryAuthorizationFaultEntry(transactionId);
    if (entry !== undefined) {
      const knownRelation = compareKnownDimensions(
        { digest: entry.digest, contractDigest: entry.contractDigest },
        known,
      );
      if (knownRelation === "conflict") {
        return { probe: "identity_conflict", detail: "authorization fault 的 digest/contract 与当前 opening 不一致（同 ID 不同 opening——不得接管）" };
      }
      if (knownRelation === "match") return { probe: "owner_present", owner: "authorization fault（execution）" };
    }
  }
  return { probe: "indeterminate" };
}

/** 已提供维度的精确比较（未提供维度不比较——不视为 match 依据也不视为冲突）。 */
function compareKnownDimensions(
  owner: { readonly digest?: string; readonly contractDigest?: string },
  known: { readonly digest: string; readonly contractDigest?: string },
): "match" | "conflict" | "indeterminate" {
  if (owner.digest !== undefined && owner.digest !== known.digest) return "conflict";
  if (known.contractDigest !== undefined && owner.contractDigest !== undefined && owner.contractDigest !== known.contractDigest) return "conflict";
  if (owner.digest !== known.digest) return "indeterminate";
  if (known.contractDigest !== undefined && owner.contractDigest === undefined) return "indeterminate";
  return "match";
}
