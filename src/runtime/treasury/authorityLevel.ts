/**
 * Treasury authority / proof 的显式持久等级（第十三轮第八节）。
 *
 * 背景：intent / quarantine / authorization-fault 的记录等级（modern /
 * legacy / forensic）此前完全由 optional 字段存在性隐式推断——Memory 删除
 * cohort facts / durable identity / stable semantic identity / structure
 * descriptors 字段即可把现代记录静默降级为 legacy 兼容记录。
 *
 * 本模块建立四级显式语义（entry 持久 authorityLevel 字段）：
 * - modern：现代 production contract authority——required 字段矩阵全齐
 *   （任一缺失 → store unhealthy，绝不降级 legacy）；
 * - legacy：版本化 migration 的显式标记（原数据确实来自旧 schema、无现代
 *   身份事实；migration 不得伪造缺失现代事实）；
 * - forensic：不完整或不变量已被破坏的 authority（recovery 防御性直写/
 *   authority 写入失败兜底）——阻断 writer、不签发普通 capability、不走
 *   普通 resolution，只能经显式 forensic 管理流程处理；
 * - lowlevel：明确的低层（非 contract）路径等级（含 test-only 两阶段）——
 *   保留既有低层语义（durable identity 绑定、可经 identity relation 释放），
 *   但不是现代 contract authority。
 *
 * 等级判定是持久化事实：新写入由写入方声明（经矩阵校验）；旧 store 只在
 * 一次性版本化迁移中定级（classifyTreasuryAuthorityLevel）；此后 load 不再
 * 推断——authorityLevel 缺失/未知枚举 → store unhealthy。
 */

export type TreasuryAuthorityLevel = "modern" | "legacy" | "forensic" | "lowlevel";

export const TREASURY_AUTHORITY_LEVELS: ReadonlySet<string> = new Set<string>([
  "modern",
  "legacy",
  "forensic",
  "lowlevel",
]);

/** 等级校验失败的确定性计数（heap；facade metrics 聚合）。 */
const authorityLevelEvents = {
  proofLevelRejections: 0,
};

export interface TreasuryAuthorityLevelCounters {
  readonly proofLevelRejections: number;
}

export function readTreasuryAuthorityLevelCounters(): TreasuryAuthorityLevelCounters {
  return { ...authorityLevelEvents };
}

/** 仅供测试：清零计数。 */
export function resetTreasuryAuthorityLevelForTest(): void {
  authorityLevelEvents.proofLevelRejections = 0;
}

/** 等级字段的形状校验（缺失/未知枚举 → 有界错误）。 */
export function validateTreasuryAuthorityLevelField(level: unknown): string | null {
  if (typeof level !== "string" || !TREASURY_AUTHORITY_LEVELS.has(level)) {
    return `authorityLevel 非法（须为显式枚举 modern|legacy|forensic|lowlevel）: ${String(level).slice(0, 24)}`;
  }
  return null;
}

/** 定级与矩阵校验的 entry 视图（intent/quarantine/authorization-fault 共用形状）。 */
export interface TreasuryAuthorityLevelEntryView {
  readonly authorityLevel?: unknown;
  readonly contractId?: unknown;
  readonly contractDigest?: unknown;
  readonly actionKind?: unknown;
  readonly kind?: unknown;
  readonly adapterVersion?: unknown;
  readonly adapterRegistrationId?: unknown;
  readonly adapterSemanticIdentity?: unknown;
  readonly durablePayload?: unknown;
  readonly durablePayloadVersion?: unknown;
  readonly structureFacts?: readonly unknown[];
  readonly authorizationCohort?: unknown;
  readonly authorizationCohortDigest?: unknown;
  readonly durableIdentityDigest?: unknown;
  readonly ownerIdentity?: unknown;
  readonly policyIdentity?: unknown;
  readonly postings?: readonly unknown[];
  readonly deltas?: readonly unknown[];
}

/** 矩阵开关：intent/quarantine 全要求；authorization-fault 为 pre-execution authority（无 durable payload / 独立 structure descriptors——结构事实由 contract digest 绑定）。 */
export interface TreasuryAuthorityMatrixOptions {
  readonly requireDurablePayload?: boolean;
  readonly requireStructureFacts?: boolean;
}

/** intent / quarantine / authorization-fault 的 modern required 字段矩阵（第八节 8.1）。 */
function modernMatrixMissingFields(entry: TreasuryAuthorityLevelEntryView, options: TreasuryAuthorityMatrixOptions): string[] {
  const missing: string[] = [];
  if (entry.contractId === undefined) missing.push("contractId");
  if (entry.contractDigest === undefined) missing.push("contractDigest");
  if ((entry.actionKind ?? entry.kind) === undefined) missing.push("actionKind");
  if (entry.adapterVersion === undefined) missing.push("adapterVersion");
  if (entry.adapterRegistrationId === undefined) missing.push("adapterRegistrationId");
  if (entry.adapterSemanticIdentity === undefined) missing.push("adapterSemanticIdentity");
  if (options.requireDurablePayload !== false) {
    if (entry.durablePayload === undefined) missing.push("durablePayload");
    if (entry.durablePayloadVersion === undefined) missing.push("durablePayloadVersion");
  }
  if (options.requireStructureFacts !== false) {
    if (entry.structureFacts === undefined || entry.structureFacts.length === 0) missing.push("structureFacts");
  }
  if (entry.authorizationCohort === undefined) missing.push("authorizationCohort");
  if (entry.authorizationCohortDigest === undefined) missing.push("authorizationCohortDigest");
  if (entry.durableIdentityDigest === undefined) missing.push("durableIdentityDigest");
  if (entry.policyIdentity === undefined) missing.push("policyIdentity");
  if ((entry.postings ?? entry.deltas) === undefined || (entry.postings ?? entry.deltas)!.length === 0) {
    missing.push("postings");
  }
  return missing;
}

/**
 * 持久 entry 的等级一致性校验（load 全量验证/写入前共用；返回 null = 一致）：
 * - authorityLevel 必须为显式枚举（缺失/未知 → unhealthy——不得由字段推断）；
 * - modern：required 字段矩阵全齐（任一缺失 → unhealthy，绝不降级 legacy）；
 * - 全部等级：authorizationCohort 与 authorizationCohortDigest 必须成对
 *   存在或同时缺失（一方存在一方缺失 = 损坏——不再自动当 legacy）。
 */
export function validateTreasuryAuthorityLevelConsistency(
  entry: TreasuryAuthorityLevelEntryView,
  options?: TreasuryAuthorityMatrixOptions,
): string | null {
  const levelError = validateTreasuryAuthorityLevelField(entry.authorityLevel);
  if (levelError !== null) {
    authorityLevelEvents.proofLevelRejections += 1;
    return levelError;
  }
  const hasCohortFacts = entry.authorizationCohort !== undefined;
  const hasCohortDigest = entry.authorizationCohortDigest !== undefined;
  if (hasCohortFacts !== hasCohortDigest) {
    authorityLevelEvents.proofLevelRejections += 1;
    return "authorizationCohort 与 authorizationCohortDigest 必须成对存在（一方缺失 = 损坏，不再自动当 legacy）";
  }
  if (entry.authorityLevel === "modern") {
    const missing = modernMatrixMissingFields(entry, options ?? {});
    if (missing.length > 0) {
      authorityLevelEvents.proofLevelRejections += 1;
      return `modern authority required 字段矩阵缺失: ${missing.join(",")}（不得降级 legacy——store unhealthy）`;
    }
  }
  return null;
}

/**
 * 一次性版本化迁移的定级（旧 schema entry → 显式 authorityLevel）：
 * - forensic 标志（quarantine 防御性直写）→ "forensic"；
 * - legacyV1 标志（v1 迁移残留）→ "legacy"；
 * - modern 矩阵全齐（cohort facts+digest 成对）→ "modern"；
 * - durableIdentityDigest 存在（有统一身份但矩阵不齐——低层/部分事实）→
 *   "lowlevel"；
 * - 完全无现代身份事实（无 durableIdentityDigest ∧ 无 cohort ∧ 无 cohort
 *   digest ∧ 无 contractId ∧ 无 contractDigest）→ "legacy"；
 * - 其余部分现代事实（无 durable 但有 contract/cohort 成分）→ "lowlevel"。
 *
 * 返回 [level, error]：定级本身不 fail closed（等级语义覆盖部分事实形态），
 * 矛盾（cohort XOR）返回 error 由迁移层 fatal。
 */
export function classifyTreasuryAuthorityLevel(
  entry: Omit<TreasuryAuthorityLevelEntryView, "authorityLevel"> & {
    readonly forensic?: unknown;
    readonly legacyV1?: unknown;
  },
  options?: TreasuryAuthorityMatrixOptions,
): [TreasuryAuthorityLevel | null, string | null] {
  const hasCohortFacts = entry.authorizationCohort !== undefined;
  const hasCohortDigest = entry.authorizationCohortDigest !== undefined;
  if (hasCohortFacts !== hasCohortDigest) {
    authorityLevelEvents.proofLevelRejections += 1;
    return [null, "迁移定级发现 cohort facts 与 digest 不成对（无法安全定级，原 store 保留）"];
  }
  if (entry.forensic !== undefined) return ["forensic", null];
  if (entry.legacyV1 === true) return ["legacy", null];
  const matrixComplete = modernMatrixMissingFields(entry, options ?? {}).length === 0;
  if (matrixComplete) return ["modern", null];
  const noModernFacts =
    entry.durableIdentityDigest === undefined &&
    !hasCohortFacts &&
    !hasCohortDigest &&
    entry.contractId === undefined &&
    entry.contractDigest === undefined;
  if (noModernFacts) return ["legacy", null];
  return ["lowlevel", null];
}
