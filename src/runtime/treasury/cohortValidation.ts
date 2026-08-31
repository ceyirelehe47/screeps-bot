/**
 * Treasury authorization cohort facts 的唯一共享 validator（第十三轮第九节）。
 *
 * 背景：intent / quarantine / authorization-fault 三个持久 store 此前各自
 * 实现深度不一的 cohort 形状校验（intent 全量、quarantine/fault 仅 3-5 项），
 * 且 cohort 重算链路（identityProof → canonicalTreasuryCohortText）直接解引
 * 用全部字段、无异常边界——malformed cohort（缺字段/null/throwing Proxy）
 * 可能在 load 校验时抛 TypeError 中断 tick。
 *
 * 本模块是唯一权威：
 * - validateTreasuryAuthorizationCohortFacts：全字段形状校验（owner/policy
 *   四元组/decision digest/emergency override/epoch/五元 revisions/adapter
 *   registration 与 stable semantic identity/contract ID+digest/transactionId
 *   （与 entry 交叉一致）/authorization leg digests（1..8）/receiver
 *   capacity digest/issued tick/authorization digest/数组与字符串上限/安全
 *   整数/nested object）；
 * - 一切属性访问都在 try/catch 边界内——缺字段、null、错误类型、throwing
 *   Proxy 均返回有界结构化错误（cohortValidationFailures 计数），绝不抛出；
 * - intent / quarantine / authorization-fault 的 entry 形状校验、load 全量
 *   验证、read-back、migration、repair、capability 签发与 resolution
 *   prevalidation 共用本 validator；各 store 不得再保留私有近似副本。
 */

import type { TreasuryAuthorizationCohortFacts } from "@/runtime/treasury/authorization";

const COHORT_DIGEST_PATTERN = /^[0-9a-f]{16}$/;
const COHORT_STRING_MAX = 128;
const COHORT_POLICY_ID_MAX = 96;
const COHORT_POLICY_DECISION_MAX = 512;
const COHORT_RECEIVER_CAPACITY_MAX = 96;
const COHORT_LEGS_MAX = 8;

/** 确定性计数（heap，global reset 归零；facade metrics 聚合）。 */
const cohortValidationEvents = {
  /** 校验失败（含异常逃逸防御分支）次数。 */
  cohortValidationFailures: 0,
};

export interface TreasuryCohortValidationCounters {
  readonly cohortValidationFailures: number;
}

export function readTreasuryCohortValidationCounters(): TreasuryCohortValidationCounters {
  return { ...cohortValidationEvents };
}

/** 仅供测试：清零计数。 */
export function resetTreasuryCohortValidationForTest(): void {
  cohortValidationEvents.cohortValidationFailures = 0;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * cohort facts 的完整形状校验（返回 null = 合法，否则有界错误描述）。
 * expectedTransactionId 提供时校验 cohort.transactionId 与 entry 交叉一致。
 * 异常安全：任何属性访问异常（throwing Proxy 等）都返回结构化错误。
 * 一切失败（形状非法或异常）计入 cohortValidationFailures。
 */
export function validateTreasuryAuthorizationCohortFacts(
  facts: unknown,
  expectedTransactionId?: string,
): string | null {
  const error = validateCohortFactsInner(facts, expectedTransactionId);
  if (error !== null) cohortValidationEvents.cohortValidationFailures += 1;
  return error;
}

function validateCohortFactsInner(facts: unknown, expectedTransactionId?: string): string | null {
  try {
    if (!facts || typeof facts !== "object") return "authorizationCohort 非对象";
    const cohort = facts as Partial<TreasuryAuthorizationCohortFacts>;
    if (typeof cohort.ownerIdentity !== "string" || cohort.ownerIdentity.length > COHORT_STRING_MAX) {
      return "authorizationCohort.ownerIdentity 非法（须为 ≤128 字符）";
    }
    if (typeof cohort.policyId !== "string" || cohort.policyId.length === 0 || cohort.policyId.length > COHORT_POLICY_ID_MAX) {
      return "authorizationCohort.policyId 非法（须为 1..96 字符）";
    }
    if (!isSafeInteger(cohort.policyVersion) || (cohort.policyVersion as number) <= 0) {
      return "authorizationCohort.policyVersion 须为正安全整数";
    }
    if (typeof cohort.policyRegistrationId !== "string" || !COHORT_DIGEST_PATTERN.test(cohort.policyRegistrationId)) {
      return "authorizationCohort.policyRegistrationId 非法（16 hex）";
    }
    if (
      typeof cohort.policyDecisionDigest !== "string" ||
      cohort.policyDecisionDigest.length === 0 ||
      cohort.policyDecisionDigest.length > COHORT_POLICY_DECISION_MAX
    ) {
      return "authorizationCohort.policyDecisionDigest 非法（1..512 字符）";
    }
    if (typeof cohort.emergencyOverride !== "boolean") {
      return "authorizationCohort.emergencyOverride 须为布尔";
    }
    if (!isSafeInteger(cohort.epochSeq) || (cohort.epochSeq as number) < 0) {
      return "authorizationCohort.epochSeq 非法（非负安全整数）";
    }
    const revisions = cohort.revisions as Partial<TreasuryAuthorizationCohortFacts["revisions"]> | undefined;
    if (!revisions || typeof revisions !== "object") return "authorizationCohort.revisions 非对象";
    for (const key of [
      "commitmentRevision",
      "projectionRevision",
      "quarantineRevision",
      "intentRevision",
      "reservationStoreRevision",
    ] as const) {
      if (!isSafeInteger(revisions[key]) || (revisions[key] as number) < 0) {
        return `authorizationCohort.revisions.${key} 非法（非负安全整数）`;
      }
    }
    if (typeof cohort.adapterRegistrationId !== "string" || !COHORT_DIGEST_PATTERN.test(cohort.adapterRegistrationId)) {
      return "authorizationCohort.adapterRegistrationId 非法（16 hex）";
    }
    if (
      cohort.adapterSemanticIdentity !== undefined &&
      (typeof cohort.adapterSemanticIdentity !== "string" ||
        cohort.adapterSemanticIdentity.length === 0 ||
        cohort.adapterSemanticIdentity.length > COHORT_STRING_MAX)
    ) {
      return "authorizationCohort.adapterSemanticIdentity 非法（1..128 字符）";
    }
    if (typeof cohort.contractId !== "string" || cohort.contractId.length === 0 || cohort.contractId.length > COHORT_POLICY_ID_MAX) {
      return "authorizationCohort.contractId 非法（1..96 字符）";
    }
    if (typeof cohort.contractDigest !== "string" || !COHORT_DIGEST_PATTERN.test(cohort.contractDigest)) {
      return "authorizationCohort.contractDigest 非法（16 hex）";
    }
    if (typeof cohort.transactionId !== "string" || cohort.transactionId.length === 0) {
      return "authorizationCohort.transactionId 非法";
    }
    if (expectedTransactionId !== undefined && cohort.transactionId !== expectedTransactionId) {
      return "authorizationCohort.transactionId 与 entry 不一致";
    }
    if (
      !Array.isArray(cohort.authorizationLegDigests) ||
      cohort.authorizationLegDigests.length === 0 ||
      cohort.authorizationLegDigests.length > COHORT_LEGS_MAX
    ) {
      return "authorizationCohort.authorizationLegDigests 非法（1..8 项）";
    }
    for (const leg of cohort.authorizationLegDigests) {
      if (typeof leg !== "string" || !COHORT_DIGEST_PATTERN.test(leg)) {
        return "authorizationCohort.authorizationLegDigests 项非法（16 hex）";
      }
    }
    if (
      typeof cohort.receiverCapacityDigest !== "string" ||
      cohort.receiverCapacityDigest.length === 0 ||
      cohort.receiverCapacityDigest.length > COHORT_RECEIVER_CAPACITY_MAX
    ) {
      return "authorizationCohort.receiverCapacityDigest 非法（1..96 字符）";
    }
    if (!isSafeInteger(cohort.issuedTick) || (cohort.issuedTick as number) < 0) {
      return "authorizationCohort.issuedTick 非法（非负安全整数）";
    }
    if (typeof cohort.authorizationDigest !== "string" || !COHORT_DIGEST_PATTERN.test(cohort.authorizationDigest)) {
      return "authorizationCohort.authorizationDigest 非法（16 hex）";
    }
    return null;
  } catch (error) {
    return `authorizationCohort 校验异常（${String(error instanceof Error ? error.message : error).slice(0, 96)}）——fail closed`;
  }
}
