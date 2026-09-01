/**
 * 【第二十一轮第六节 / 第八节】current lineage exact settlement verifier。
 *
 * Round 20 断链（任务书"二、本轮背景"）：
 * - active current 的 semantic validation 只完整验证 ID / parent / binding /
 *   普通 digest——contract / cohort / durable / proof class / lowlevel
 *   provenance 未与 record.currentIdentity 及 record.authorityClass 比较；
 * - child_active 的 beginTick commit 补完成只读 Receipt 的 binding +
 *   generation 即释放 Intent 并推进 chain_committed——未验证 Receipt 的
 *   digest / contract / cohort / durable / proof class / provenance。
 *
 * 本模块是以下路径的单一权威（不得在各调用方展开近似比较）：
 * - semantic lineage active current（validateTreasurySemanticLineage 的
 *   generation === record.generation 分支）；
 * - child-active commit recovery（attemptLineage beginTick 补完成）；
 * - chain-committed 推进 / terminal compaction / current generation tombstone
 *   replacement / generation retirement proof 比较 / committed resolution 后的
 *   lineage 推进——这些路径的 expected 视图统一经
 *   expectedTreasuryCurrentLineageExactIdentity 构造。
 *
 * requiredness（6.2）：
 * - identity-bound：digest + durableIdentityDigest + class=identity-bound +
 *   禁 lowlevelSource；modern contract 来源（current 或 root identity 携带
 *   contract 维度）还必须保留 contractDigest + authorizationCohortDigest——
 *   缺失不得降级为可匹配的弱 identity-bound；
 * - lowlevel：digest + durableIdentityDigest + class=lowlevel + 受控
 *   lowlevelSource；禁携带 modern contract/cohort 事实。
 *
 * verdict（6.3）：match / conflict / insufficient（malformed、store-unhealthy
 * 由外围承担）。无副作用；record 用结构化视图承载（type-only import
 * attemptLineage——无运行时循环依赖）。
 */

import {
  treasuryExactAttemptIdentityOfFacts,
  treasuryExactAttemptIdentityOfReceiptProof,
  treasuryExactAttemptIdentityRelation,
  treasuryProofClassOfIdentityFacts,
  type TreasuryExactAttemptIdentity,
  type TreasuryExactIdentityFactsInput,
} from "@/runtime/treasury/exactAttemptIdentity";
import type { TreasuryLineageProofFacts } from "@/runtime/treasury/lineageProof";
import type { TreasuryAttemptLineageRecord } from "@/runtime/treasury/attemptLineage";

/** active record 的最小结构化视图（TreasuryAttemptLineageRecord 结构兼容）。 */
export type TreasuryCurrentLineageRecordView = Pick<
  TreasuryAttemptLineageRecord,
  | "lineageId"
  | "rootTransactionId"
  | "currentTransactionId"
  | "currentIdentity"
  | "rootIdentity"
  | "generation"
  | "currentParentTransactionId"
  | "bindingDigest"
  | "authorityClass"
  | "lowlevelSource"
> & { readonly retrySemanticDigest?: string };

export type TreasuryCurrentExactVerdict =
  | { readonly verdict: "match" }
  | { readonly verdict: "conflict"; readonly detail: string }
  | { readonly verdict: "insufficient"; readonly detail: string };

/** modern contract 来源判定：current/root identity 任一携带 contract 维度。 */
function isModernContractLineage(record: TreasuryCurrentLineageRecordView): boolean {
  return record.currentIdentity.contractDigest !== undefined || record.rootIdentity.contractDigest !== undefined;
}

/**
 * 从 active record 构造 current attempt 的权威 exact identity（6.1——唯一
 * 构造入口，复用 exactAttemptIdentity 底层）：requiredness 失败返回 null
 * （record 侧身份不可证明——调用方按 insufficient fail closed，不得降级）。
 */
export function expectedTreasuryCurrentLineageExactIdentity(
  record: TreasuryCurrentLineageRecordView,
): TreasuryExactAttemptIdentity | null {
  if (record.generation >= 1 && (record.currentParentTransactionId === undefined || record.bindingDigest === undefined)) {
    return null;
  }
  const lowlevelSource = record.currentIdentity.lowlevelSource ?? record.lowlevelSource;
  // ── requiredness（6.2）。
  if (record.authorityClass === "identity-bound") {
    if (record.currentIdentity.durableIdentityDigest === undefined) return null;
    if (lowlevelSource !== undefined) return null;
    if (isModernContractLineage(record)) {
      if (record.currentIdentity.contractDigest === undefined || record.currentIdentity.authorizationCohortDigest === undefined) {
        return null;
      }
    }
  } else {
    if (record.currentIdentity.durableIdentityDigest === undefined || lowlevelSource === undefined) return null;
    if (record.currentIdentity.contractDigest !== undefined || record.currentIdentity.authorizationCohortDigest !== undefined) {
      return null;
    }
  }
  return treasuryExactAttemptIdentityOfFacts(
    record.currentTransactionId,
    {
      digest: record.currentIdentity.digest,
      ...(record.currentIdentity.contractDigest !== undefined ? { contractDigest: record.currentIdentity.contractDigest } : {}),
      ...(record.currentIdentity.authorizationCohortDigest !== undefined
        ? { authorizationCohortDigest: record.currentIdentity.authorizationCohortDigest }
        : {}),
      ...(record.currentIdentity.durableIdentityDigest !== undefined ? { durableIdentityDigest: record.currentIdentity.durableIdentityDigest } : {}),
      ...(lowlevelSource !== undefined ? { lowlevelSource } : {}),
      ...(record.generation >= 1
        ? {
            lineageId: record.lineageId,
            lineageGeneration: record.generation,
            parentTransactionId: record.currentParentTransactionId!,
            lineageBindingDigest: record.bindingDigest!,
          }
        : {}),
    },
    record.authorityClass,
  );
}

/**
 * requiredness 失败的可诊断描述（调用方需要区分"record 身份不可构造"与
 * "输入不完整"时使用；语义与 expectedTreasuryCurrentLineageExactIdentity
 * 的 null 一致）。
 */
export function describeTreasuryCurrentLineageRequiredness(
  record: TreasuryCurrentLineageRecordView,
): string | null {
  if (record.generation >= 1 && (record.currentParentTransactionId === undefined || record.bindingDigest === undefined)) {
    return "generation≥1 的 record 缺 currentParentTransactionId/bindingDigest（current exact identity 不可构造）";
  }
  const lowlevelSource = record.currentIdentity.lowlevelSource ?? record.lowlevelSource;
  if (record.authorityClass === "identity-bound") {
    if (record.currentIdentity.durableIdentityDigest === undefined) {
      return "identity-bound current 缺 durableIdentityDigest（弱 identity-bound 不得匹配）";
    }
    if (lowlevelSource !== undefined) return "identity-bound current 携带 lowlevelSource（class 矛盾）";
    if (isModernContractLineage(record)) {
      if (record.currentIdentity.contractDigest === undefined || record.currentIdentity.authorizationCohortDigest === undefined) {
        return "modern contract 来源的 current 缺 contractDigest/authorizationCohortDigest（不得降级为弱 identity-bound）";
      }
    }
    return null;
  }
  if (record.currentIdentity.durableIdentityDigest === undefined) return "lowlevel current 缺 durableIdentityDigest";
  if (lowlevelSource === undefined) return "lowlevel current 缺 lowlevelSource（provenance 不可证明）";
  if (record.currentIdentity.contractDigest !== undefined || record.currentIdentity.authorizationCohortDigest !== undefined) {
    return "lowlevel current 携带 modern contract/cohort 事实（class 矛盾）";
  }
  return null;
}

/**
 * active current 的完整 exact identity 验证（6.3/6.4——semantic lineage
 * validation 的 current 分支单一权威）：
 * - 输入 identity 缺失 → insufficient（current 语义要求完整 exact identity，
 *   不得 match）；
 * - proof class / lowlevelSource / digest / contract / cohort / durable /
 *   lineage 四字段任一不同 → conflict；期望维度缺失 → insufficient；
 * - 输入携带权威不具备的维度（或反向）→ conflict（身份形态矛盾）。
 *
 * proof 参数是 validator 输入的 lineage 四字段（identity 视图携带 lineage
 * 时必须与之一致——两套四字段不一致即 conflict）。
 */
export function verifyTreasuryCurrentLineageExactIdentity(input: {
  readonly record: TreasuryCurrentLineageRecordView;
  readonly identity: TreasuryExactIdentityFactsInput | undefined;
  readonly proof?: TreasuryLineageProofFacts;
}): TreasuryCurrentExactVerdict {
  const { record, identity, proof } = input;
  if (identity === undefined) {
    return { verdict: "insufficient", detail: "active current 验证要求输入携带完整 exact identity（缺失即不可证明——不得 match）" };
  }
  const requirednessError = describeTreasuryCurrentLineageRequiredness(record);
  if (requirednessError !== null) {
    return { verdict: "insufficient", detail: `record current 身份不满足 requiredness（${requirednessError}）——权威侧不可证明` };
  }
  const expected = expectedTreasuryCurrentLineageExactIdentity(record);
  if (expected === null) {
    return { verdict: "insufficient", detail: "record current exact identity 构造失败（防御——与 requiredness 判定不一致）" };
  }
  // proof class：输入推导 class 与权威 authorityClass 不同 → conflict。
  const inputClass = treasuryProofClassOfIdentityFacts(identity);
  if (inputClass !== record.authorityClass) {
    return {
      verdict: "conflict",
      detail: `输入 attempt 的 proof class ${String(inputClass)} 与 lineage authority class ${String(record.authorityClass)} 不匹配`,
    };
  }
  // lineage 四字段：identity 视图携带的 lineage 必须与 validator 输入 proof 一致。
  const identityHasLineage =
    identity.lineageId !== undefined || identity.lineageGeneration !== undefined
    || identity.parentTransactionId !== undefined || identity.lineageBindingDigest !== undefined;
  if (proof !== undefined && identityHasLineage) {
    if (identity.lineageId !== proof.lineageId || identity.lineageGeneration !== proof.lineageGeneration
      || identity.parentTransactionId !== proof.parentTransactionId || identity.lineageBindingDigest !== proof.lineageBindingDigest) {
      return { verdict: "conflict", detail: "identity 视图的 lineage 四字段与 proof 四字段不一致（同一 attempt 携带两套 lineage 事实）" };
    }
  }
  const caller = treasuryExactAttemptIdentityOfFacts(
    record.currentTransactionId,
    {
      ...identity,
      // lineage 四字段以 validator 输入的 proof 为权威并入 caller 视图
      //（proof 已与 record current 三元比较；identity 单独携带 lineage 时
      // 上文已强制与 proof 一致——两个入口殊途同归）。
      ...(proof !== undefined
        ? {
            lineageId: proof.lineageId,
            lineageGeneration: proof.lineageGeneration,
            parentTransactionId: proof.parentTransactionId,
            lineageBindingDigest: proof.lineageBindingDigest,
          }
        : {}),
    },
    record.authorityClass,
  );
  if (caller === null) {
    return { verdict: "insufficient", detail: "输入 identity 无法构造完整 exact attempt identity（维度缺失/形状异常）" };
  }
  const relation = treasuryExactAttemptIdentityRelation(caller, expected);
  if (relation === "match") return { verdict: "match" };
  if (relation === "conflict") {
    return { verdict: "conflict", detail: "输入 attempt 与 record.currentIdentity 的 exact identity 不一致（digest/contract/cohort/durable/lowlevel/lineage 任一维度冲突）" };
  }
  return { verdict: "insufficient", detail: "输入 attempt 缺少 record.currentIdentity 要求的身份维度（不可证明——不降级 match）" };
}

// ── child-active commit recovery（第八节 8.1） ─────────────────────────────

/** receipt settlement proof 的最小结构化视图（receipts.TreasurySettlementProof 兼容）。 */
export interface TreasuryCommitReceiptProofView {
  readonly level?: string;
  readonly digest?: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
}

export type TreasuryChildActiveCommitRecoveryResult =
  | { readonly status: "verified" }
  | { readonly status: "conflict"; readonly detail: string }
  | { readonly status: "insufficient"; readonly detail: string }
  | { readonly status: "legacy"; readonly detail: string };

/**
 * child_active beginTick 补完成的单一 commit recovery verifier（8.1）：
 * Receipt store 健康由调用方先行检查；此处验证——
 * - Receipt 非 legacy（legacy 是不可证明的 replay blocker，不关闭 lineage）；
 * - Receipt proof class 与 record.authorityClass 一致；
 * - Receipt exact identity 与 record current exact identity 完整 match
 *   （digest/contract/cohort/durable/lowlevel + lineage 四字段）；
 * - Receipt transactionId 等于 record.currentTransactionId（调用方保证）。
 * 只有 verified 才允许 close chain_committed → read-back → 释放 Intent。
 */
export function verifyTreasuryChildActiveCommitRecovery(input: {
  readonly record: TreasuryCurrentLineageRecordView;
  readonly receiptProof: TreasuryCommitReceiptProofView;
}): TreasuryChildActiveCommitRecoveryResult {
  const { record, receiptProof } = input;
  if (receiptProof.level === "legacy" || receiptProof.level === undefined || receiptProof.level === "modern") {
    return {
      status: "legacy",
      detail: `committed receipt proof 是 legacy/不可定级形态（${String(receiptProof.level)}）——不可证明当前 child_active attempt，不关闭 lineage`,
    };
  }
  if (receiptProof.level !== record.authorityClass) {
    return {
      status: "conflict",
      detail: `committed receipt proof class ${String(receiptProof.level)} 与 lineage authority class ${String(record.authorityClass)} 不匹配`,
    };
  }
  const requirednessError = describeTreasuryCurrentLineageRequiredness(record);
  if (requirednessError !== null) {
    return { status: "insufficient", detail: `record current 身份不满足 requiredness（${requirednessError}）——保留全部证据，不自动升级` };
  }
  const expected = expectedTreasuryCurrentLineageExactIdentity(record);
  if (expected === null) {
    return { status: "insufficient", detail: "record current exact identity 构造失败（防御）" };
  }
  const receiptExact = treasuryExactAttemptIdentityOfReceiptProof(record.currentTransactionId, receiptProof);
  if (receiptExact === null) {
    return { status: "insufficient", detail: "committed receipt proof 无法构造完整 exact identity（维度缺失/形状异常——保留证据，不关闭）" };
  }
  const relation = treasuryExactAttemptIdentityRelation(receiptExact, expected);
  if (relation === "match") return { status: "verified" };
  if (relation === "conflict") {
    return {
      status: "conflict",
      detail: "committed receipt 的 exact identity 与 record current 不一致（digest/contract/cohort/durable/lowlevel/lineage 任一维度冲突）——child_active 与 Intent 保留，记录 proof conflict",
    };
  }
  return {
    status: "insufficient",
    detail: "committed receipt 缺少 record current 要求的身份维度（不可证明——保留全部证据，不自动升级）",
  };
}
