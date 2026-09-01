/**
 * 【第十四轮第十二节】intent / quarantine / authorization-fault 共享的
 * durable 发布协议（写入前候选重算 + 发布后 read-back 完整身份比较）。
 *
 * 协议（三个 store 一致使用）：
 * 1. 候选构造：调用方构造深拷贝候选值并完成 shape / authority-level 矩阵 /
 *    cohort / descriptor 校验（各 store 的 validateEntryShape 承载）；
 * 2. 写入前：verifyTreasuryDurableCandidateForPublication——cohort digest 与
 *    durable identity 必须能由候选事实重算一致（不信任自带 digest 字符串）；
 * 3. 发布：store 写入 Memory（entryCount/revision/updatedAt 推进）；
 * 4. read-back：compareTreasuryAuthorityPublicationReadBack——从实际持久副本
 *    再次执行完整 identity 重算 + 与预期 entry 的**完整字段**比较（等级、
 *    durable identity、cohort、contract、adapter semantic identity、payload、
 *    descriptors、postings、outcome、settlement、source 等全部结构化身份
 *    字段——不是 digest 字符串子集）；
 * 5. 失败回滚：删除本次写入并恢复 entryCount/revision/updatedAt，返回结构化
 *    store fault——调用方不得继续删除源 authority 或执行任何 Game callback。
 *
 * 测试故障注入：setTreasuryDurablePublicationFaultForTest 在"发布后、
 * read-back 前"执行注入回调（模拟 Memory 在发布与验证之间被篡改），
 * 验证回滚路径（test-only，不影响生产行为）。
 */

import { verifyTreasuryEntryIdentity, type TreasuryIdentityFactsEntry } from "@/runtime/treasury/identityProof";

/** 发布协议覆盖的完整身份字段全集（read-back 逐项比较；undefined 语义按 optional 规范化）。 */
export interface TreasuryDurablePublicationFacts extends TreasuryIdentityFactsEntry {
  readonly authorityLevel?: string;
  readonly lowlevelSource?: string;
  readonly authorizationDigest?: string;
  readonly outcome?: string;
  readonly settlement?: string;
  /** 【第十五轮第十节】store-specific 安全关键不可变事实（quarantine / authorization-fault）。 */
  readonly phase?: string;
  readonly legacyV1?: boolean;
  readonly forensic?: { readonly reason?: string; readonly detail?: string } | undefined;
  readonly faultTick?: number;
  readonly rollbackConfirmed?: boolean;
  readonly tick?: number;
  readonly recordedAt?: number;
  readonly createdAtTick?: number;
  readonly detail?: string;
}

/**
 * 【第十五轮第十节】store-specific 语义 validator：read-back 在通用 identity
 * 重算与字段比较之上，重新执行该 store 的完整 shape 与语义校验（level 矩阵、
 * outcome/settlement 语义、forensic provenance、legacy 标记、固定事实——
 * 必须能检出"phase 被篡改但 digest 未变"一类语义矛盾）。返回 null = 通过。
 */
export type TreasuryDurablePublicationSemanticValidator = (
  persisted: TreasuryDurablePublicationFacts,
  label: string,
) => string | null;

type PublicationFaultPhase = "after_publish_before_read_back";

let publicationFaultInjector: ((phase: PublicationFaultPhase) => void) | null = null;

/** 仅供测试：注册发布协议故障注入（null 清除）。 */
export function setTreasuryDurablePublicationFaultForTest(injector: ((phase: PublicationFaultPhase) => void) | null): void {
  publicationFaultInjector = injector;
}

/** 发布协议确定性计数（heap；诊断）。 */
const publicationEvents = {
  readBackFaults: 0,
  candidateRejections: 0,
};

export function readTreasuryDurablePublicationCounters(): typeof publicationEvents {
  return { ...publicationEvents };
}

export function resetTreasuryDurablePublicationForTest(): void {
  publicationFaultInjector = null;
  publicationEvents.readBackFaults = 0;
  publicationEvents.candidateRejections = 0;
}

/**
 * 发布前候选验证：cohort digest 与 durable identity 必须能由候选持久事实
 * 重算一致。返回 null = 可发布。
 */
export function verifyTreasuryDurableCandidateForPublication(
  entry: TreasuryDurablePublicationFacts,
  label: string,
): string | null {
  const identityError = verifyTreasuryEntryIdentity(entry, `${label} 发布前重算`);
  if (identityError !== null) {
    publicationEvents.candidateRejections += 1;
    return identityError;
  }
  return null;
}

/** 触发 test-only 发布故障注入（发布后、read-back 前）。 */
function runPublicationFaultInjector(): void {
  if (publicationFaultInjector !== null) {
    publicationFaultInjector("after_publish_before_read_back");
  }
}

function optionalEqual(left: unknown, right: unknown): boolean {
  const normalizedLeft = left === undefined ? undefined : left;
  const normalizedRight = right === undefined ? undefined : right;
  return normalizedLeft === normalizedRight;
}

function boundedDeepEqual(left: unknown, right: unknown, depth: number): boolean {
  if (depth > 8) return Object.is(left, right);
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return left.every((item, index) => boundedDeepEqual(item, right[index], depth + 1));
  }
  if (left !== null && typeof left === "object" && right !== null && typeof right === "object") {
    if (Array.isArray(right)) return false;
    const leftKeys = Object.keys(left as Record<string, unknown>);
    const rightKeys = Object.keys(right as Record<string, unknown>);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) =>
      key in (right as Record<string, unknown>) &&
      boundedDeepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], depth + 1),
    );
  }
  return Object.is(left, right);
}

/**
 * 发布后 read-back 完整身份比较：从实际持久副本重算 identity（不信任
 * 持久副本自带 digest），再与预期 entry 的完整结构化身份字段逐项比较。
 * 返回 null = read-back 一致；否则有界错误（调用方回滚写入）。
 *
 * 注意：expected 是调用方预期的完整 entry；published 是从 Memory 实际读取
 * 的持久副本。任何身份字段（含 optional 字段的 undefined 规范化）不一致
 * 都判 fault——不比较运行时 bookkeeping 字段（entryCount/updatedAt 等）。
 */
export function compareTreasuryAuthorityPublicationReadBack(
  published: TreasuryDurablePublicationFacts,
  expected: TreasuryDurablePublicationFacts,
  label: string,
): string | null {
  // 1. 从持久副本重算（digest 是持久事实的派生证明，不是可信任事实）。
  const identityError = verifyTreasuryEntryIdentity(published, `${label} read-back 重算`);
  if (identityError !== null) {
    publicationEvents.readBackFaults += 1;
    return identityError;
  }
  // 2. 完整结构化身份字段比较（【第十五轮第十节】补齐 phase / forensic /
  //    legacyV1 / faultTick / rollbackConfirmed / tick / recordedAt /
  //    createdAtTick / detail 等安全关键不可变字段）。
  const fieldChecks: readonly (readonly [string, boolean])[] = [
    ["transactionId", optionalEqual(published.transactionId, expected.transactionId)],
    ["digest", optionalEqual(published.digest, expected.digest)],
    ["kind", optionalEqual(published.kind, expected.kind)],
    ["actionKind", optionalEqual(published.actionKind, expected.actionKind)],
    ["source", optionalEqual(published.source, expected.source)],
    ["authorityLevel", optionalEqual(published.authorityLevel, expected.authorityLevel)],
    ["lowlevelSource", optionalEqual(published.lowlevelSource, expected.lowlevelSource)],
    ["contractId", optionalEqual(published.contractId, expected.contractId)],
    ["contractDigest", optionalEqual(published.contractDigest, expected.contractDigest)],
    ["adapterVersion", optionalEqual(published.adapterVersion, expected.adapterVersion)],
    ["adapterRegistrationId", optionalEqual(published.adapterRegistrationId, expected.adapterRegistrationId)],
    ["adapterSemanticIdentity", optionalEqual(published.adapterSemanticIdentity, expected.adapterSemanticIdentity)],
    ["durablePayload", optionalEqual(published.durablePayload, expected.durablePayload)],
    ["durablePayloadVersion", optionalEqual(published.durablePayloadVersion, expected.durablePayloadVersion)],
    ["authorizationDigest", optionalEqual(published.authorizationDigest, expected.authorizationDigest)],
    ["authorizationCohortDigest", optionalEqual(published.authorizationCohortDigest, expected.authorizationCohortDigest)],
    ["ownerIdentity", optionalEqual(published.ownerIdentity, expected.ownerIdentity)],
    ["policyIdentity", optionalEqual(published.policyIdentity, expected.policyIdentity)],
    ["durableIdentityDigest", optionalEqual(published.durableIdentityDigest, expected.durableIdentityDigest)],
    // 【第十八轮 24.5】lineage proof 全字段 read-back 比较（检测写入后
    // binding 被删除 / generation 被篡改 / lineage ID 变化）。
    ["lineageId", optionalEqual(published.lineageId, expected.lineageId)],
    ["lineageGeneration", optionalEqual(published.lineageGeneration, expected.lineageGeneration)],
    ["parentTransactionId", optionalEqual(published.parentTransactionId, expected.parentTransactionId)],
    ["lineageBindingDigest", optionalEqual(published.lineageBindingDigest, expected.lineageBindingDigest)],
    ["outcome", optionalEqual(published.outcome, expected.outcome)],
    ["settlement", optionalEqual(published.settlement, expected.settlement)],
    ["phase", optionalEqual(published.phase, expected.phase)],
    ["legacyV1", optionalEqual(published.legacyV1, expected.legacyV1)],
    ["forensic", boundedDeepEqual(published.forensic, expected.forensic, 0)],
    ["faultTick", optionalEqual(published.faultTick, expected.faultTick)],
    ["rollbackConfirmed", optionalEqual(published.rollbackConfirmed, expected.rollbackConfirmed)],
    ["tick", optionalEqual(published.tick, expected.tick)],
    ["recordedAt", optionalEqual(published.recordedAt, expected.recordedAt)],
    ["createdAtTick", optionalEqual(published.createdAtTick, expected.createdAtTick)],
    ["detail", optionalEqual(published.detail, expected.detail)],
    ["postings", boundedDeepEqual(published.postings ?? published.deltas, expected.postings ?? expected.deltas, 0)],
    ["structureFacts", boundedDeepEqual(published.structureFacts, expected.structureFacts, 0)],
    ["authorizationCohort", boundedDeepEqual(published.authorizationCohort, expected.authorizationCohort, 0)],
  ];
  const mismatched = fieldChecks.filter(([, ok]) => !ok).map(([name]) => name);
  if (mismatched.length > 0) {
    publicationEvents.readBackFaults += 1;
    return `${label} read-back 完整身份比较不一致（${mismatched.join(",")}）——回滚本次写入，不得继续发布或执行 callback`;
  }
  return null;
}

/**
 * 发布协议执行器（写入→注入→read-back 的统一入口；不含回滚——回滚需要
 * store 私有 bookkeeping，由调用方在 fault 返回时执行）：
 * 调用方在 store 写入完成后调用本函数，返回 null = 发布验证通过；
 * 否则调用方执行回滚并返回结构化 store fault。
 * 【第十五轮第十节】可注入 store-specific 语义 validator——通用比较通过后
 * 对持久副本重新执行该 store 的完整 shape 与语义校验（phase/outcome/
 * settlement 矩阵、forensic provenance、legacy 标记、固定事实）。
 */
export function verifyTreasuryDurablePublicationReadBack(
  published: TreasuryDurablePublicationFacts,
  expected: TreasuryDurablePublicationFacts,
  label: string,
  semanticValidator?: TreasuryDurablePublicationSemanticValidator,
): string | null {
  runPublicationFaultInjector();
  const compareError = compareTreasuryAuthorityPublicationReadBack(published, expected, label);
  if (compareError !== null) {
    return compareError;
  }
  if (semanticValidator !== undefined) {
    const semanticError = semanticValidator(published, `${label} store-specific 语义校验`);
    if (semanticError !== null) {
      publicationEvents.readBackFaults += 1;
      return semanticError;
    }
  }
  return null;
}
