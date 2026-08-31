/**
 * Treasury authority / proof 的显式持久等级（第十三轮第八节；第十四轮
 * strict lowlevel 矩阵与迁移定级重构）。
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
 *   身份事实；migration 不得伪造缺失现代事实）；禁止携带任何现代
 *   contract/authorization 身份字段；
 * - forensic：不完整或不变量已被破坏的 authority（recovery 防御性直写/
 *   authority 写入失败兜底/partial-modern 迁移隔离）——阻断 writer、不签发
 *   普通 capability、不走普通 resolution，只能经显式 forensic 管理流程处理；
 * - lowlevel：明确的低层（非 contract）路径等级——【第十四轮第九节】不再
 *   是"modern 矩阵未通过的其余情况"垃圾桶：必须由当前运行时低层路径显式
 *   声明（lowlevelSource 来源标记 + 完整低层 required 矩阵 + 禁止任何
 *   部分 modern contract/authorization 字段），且 durable identity 必须能
 *   由持久事实重算一致。
 *
 * 等级判定是持久化事实：新写入由写入方声明（经矩阵校验）；旧 store 只在
 * 一次性版本化迁移中定级（classifyTreasuryAuthorityLevelForMigration）；
 * 此后 load 不再推断——authorityLevel 缺失/未知枚举 → store unhealthy。
 */

import { verifyTreasuryEntryIdentity, type TreasuryIdentityFactsEntry } from "@/runtime/treasury/identityProof";

export type TreasuryAuthorityLevel = "modern" | "legacy" | "forensic" | "lowlevel";

export const TREASURY_AUTHORITY_LEVELS: ReadonlySet<string> = new Set<string>([
  "modern",
  "legacy",
  "forensic",
  "lowlevel",
]);

/**
 * 【第十四轮第九节】lowlevel 的显式来源标记（required）：
 * - runtime-lowlevel@v1：当前运行时低层路径写入（非 contract 内部/测试
 *   两阶段路径——由写入方缺省声明）；
 * - migrated-lowlevel@v1：迁移认定的受支持旧 lowlevel schema（仅限旧
 *   store entry 已携带显式 authorityLevel="lowlevel" 且通过严格低层矩阵
 *   验证——第十三轮运行时显式声明的低层来源可被信任）。
 */
export const TREASURY_LOWLEVEL_SOURCE_RUNTIME = "runtime-lowlevel@v1" as const;
export const TREASURY_LOWLEVEL_SOURCE_MIGRATED = "migrated-lowlevel@v1" as const;

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

/** lowlevelSource 字段的形状校验（存在须为非空有界字符串）。 */
export function validateTreasuryLowlevelSourceField(source: unknown): string | null {
  if (typeof source !== "string" || source.length === 0 || source.length > 64) {
    return `lowlevelSource 非法（须为 1..64 字符的显式来源标记）: ${String(source).slice(0, 24)}`;
  }
  return null;
}

/** 定级与矩阵校验的 entry 视图（intent/quarantine/authorization-fault 共用形状）。 */
export interface TreasuryAuthorityLevelEntryView {
  readonly authorityLevel?: unknown;
  /** 迁移定级时的旧显式等级（第十三轮起 store 已带 authorityLevel）。 */
  readonly priorAuthorityLevel?: unknown;
  readonly lowlevelSource?: unknown;
  readonly transactionId?: unknown;
  readonly digest?: unknown;
  readonly contractId?: unknown;
  readonly contractDigest?: unknown;
  readonly actionKind?: unknown;
  readonly kind?: unknown;
  readonly source?: unknown;
  readonly adapterVersion?: unknown;
  readonly adapterRegistrationId?: unknown;
  readonly adapterSemanticIdentity?: unknown;
  readonly durablePayload?: unknown;
  readonly durablePayloadVersion?: unknown;
  readonly structureFacts?: readonly unknown[];
  readonly authorizationCohort?: unknown;
  readonly authorizationCohortDigest?: unknown;
  readonly authorizationDigest?: unknown;
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
 * 【第十四轮第九节】lowlevel required 字段矩阵：低层 authority 必须绑定
 * transactionId / canonical digest / action kind / source / canonical
 * postings / 完整 durable identity（可由事实重算）/ 显式 lowlevelSource
 * 来源标记——缺一即不是完整低层形态。
 */
function lowlevelMatrixMissingFields(entry: TreasuryAuthorityLevelEntryView): string[] {
  const missing: string[] = [];
  if (entry.transactionId === undefined) missing.push("transactionId");
  if (entry.digest === undefined) missing.push("digest");
  if ((entry.actionKind ?? entry.kind) === undefined) missing.push("actionKind");
  if (entry.source === undefined) missing.push("source");
  if (entry.durableIdentityDigest === undefined) missing.push("durableIdentityDigest");
  if (entry.lowlevelSource === undefined) missing.push("lowlevelSource");
  if ((entry.postings ?? entry.deltas) === undefined || (entry.postings ?? entry.deltas)!.length === 0) {
    missing.push("postings");
  }
  return missing;
}

/**
 * 【第十四轮第九节】lowlevel forbidden modern 字段：低层 authority 不得
 * 携带任何（哪怕完整的）modern contract/authorization 事实——这些字段属于
 * modern 通道，低层携带即身份来源不可判定（partial-modern 不得混入）。
 */
const LOWLEVEL_FORBIDDEN_MODERN_FIELDS: readonly string[] = [
  "contractId",
  "contractDigest",
  "authorizationCohort",
  "authorizationCohortDigest",
  "authorizationDigest",
  "adapterRegistrationId",
  "ownerIdentity",
  "policyIdentity",
] as const;

function lowlevelForbiddenModernFields(entry: TreasuryAuthorityLevelEntryView): string[] {
  return LOWLEVEL_FORBIDDEN_MODERN_FIELDS.filter((field) => (entry as Record<string, unknown>)[field] !== undefined);
}

/**
 * 【第十四轮第九节】legacy forbidden modern 字段：legacy entry 是"完全无
 * 现代身份事实"的版本化标记——携带任何现代身份字段即等级矛盾（不得静默
 * 接受为可解释的 legacy）。
 */
const LEGACY_FORBIDDEN_MODERN_FIELDS: readonly string[] = [
  "contractId",
  "contractDigest",
  "authorizationCohort",
  "authorizationCohortDigest",
  "authorizationDigest",
  "adapterRegistrationId",
  "ownerIdentity",
  "policyIdentity",
  "durableIdentityDigest",
] as const;

function legacyForbiddenModernFields(entry: TreasuryAuthorityLevelEntryView): string[] {
  return LEGACY_FORBIDDEN_MODERN_FIELDS.filter((field) => (entry as Record<string, unknown>)[field] !== undefined);
}

/**
 * 持久 entry 的等级一致性校验（load 全量验证/写入前共用；返回 null = 一致）：
 * - authorityLevel 必须为显式枚举（缺失/未知 → unhealthy——不得由字段推断）；
 * - modern：required 字段矩阵全齐（任一缺失 → unhealthy，绝不降级 legacy）；
 * - lowlevel：required 矩阵全齐 + forbidden modern 字段全空 + durable
 *   identity 可由持久事实重算一致（不可重算 = 身份不可证明）；
 * - legacy：forbidden modern 字段全空（携带现代身份字段 = 等级矛盾）；
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
    return null;
  }
  if (entry.authorityLevel === "lowlevel") {
    const sourceError = validateTreasuryLowlevelSourceField(entry.lowlevelSource);
    if (sourceError !== null) {
      authorityLevelEvents.proofLevelRejections += 1;
      return sourceError;
    }
    const missing = lowlevelMatrixMissingFields(entry);
    if (missing.length > 0) {
      authorityLevelEvents.proofLevelRejections += 1;
      return `lowlevel authority required 字段矩阵缺失: ${missing.join(",")}（低层不是部分事实垃圾桶——store unhealthy）`;
    }
    const forbidden = lowlevelForbiddenModernFields(entry);
    if (forbidden.length > 0) {
      authorityLevelEvents.proofLevelRejections += 1;
      return `lowlevel authority 禁止携带 modern contract/authorization 字段: ${forbidden.join(",")}（身份来源不可判定——store unhealthy）`;
    }
    return null;
  }
  if (entry.authorityLevel === "legacy") {
    const forbidden = legacyForbiddenModernFields(entry);
    if (forbidden.length > 0) {
      authorityLevelEvents.proofLevelRejections += 1;
      return `legacy authority 禁止携带现代身份字段: ${forbidden.join(",")}（等级矛盾——store unhealthy）`;
    }
    return null;
  }
  // forensic：隔离等级——允许部分事实，无额外 required/forbidden 矩阵
  //（本身就是不完整/不变量破坏痕迹的容器）。
  return null;
}

/**
 * 【第十四轮第十节】一次性版本化迁移的定级（旧 schema entry → 显式
 * authorityLevel）。返回 [level, level | null(仅 forensic 定级), error]：
 * - error 非 null → 无法安全定级（cohort XOR / 显式 modern 但 digest 与
 *   事实重算矛盾）→ 迁移层 fatal，原 store 保留；
 * - 带 priorLevel（第十三轮起 store 已有显式等级）：
 *   - modern + 矩阵完整 + identity 重算一致 → modern；矩阵缺失字段 →
 *     forensic 隔离（不得变 lowlevel）；digest 与事实重算矛盾 → error fatal；
 *   - lowlevel + 严格低层矩阵（required 齐 + forbidden 空 + durable 重算
 *     一致）→ lowlevel（补 lowlevelSource=migrated 标记）；否则 → forensic
 *     （受信任来源声明但事实不满足矩阵）；
 *   - legacy + 无现代身份字段 → legacy；携带现代字段 → forensic（矛盾隔离）；
 *   - forensic → forensic；
 * - 无 priorLevel（第十三轮前旧 schema）：
 *   - forensic 标志 → forensic；legacyV1 → legacy；
 *   - modern 矩阵完整 + identity 重算一致 → modern；
 *   - 完全无现代身份事实 → legacy；
 *   - 其余（部分现代事实——contract/cohort/durable 残缺组合）→ forensic
 *     隔离，**绝不 lowlevel**（无法证明由当前低层路径产生）。
 */
export function classifyTreasuryAuthorityLevelForMigration(
  entry: Omit<TreasuryAuthorityLevelEntryView, "authorityLevel"> & {
    readonly forensic?: unknown;
    readonly legacyV1?: unknown;
    readonly digest?: unknown;
  },
  options?: TreasuryAuthorityMatrixOptions,
): [TreasuryAuthorityLevel | null, TreasuryAuthorityLevel | null, string | null] {
  const hasCohortFacts = entry.authorizationCohort !== undefined;
  const hasCohortDigest = entry.authorizationCohortDigest !== undefined;
  if (hasCohortFacts !== hasCohortDigest) {
    authorityLevelEvents.proofLevelRejections += 1;
    return [null, null, "迁移定级发现 cohort facts 与 digest 不成对（无法安全定级，原 store 保留）"];
  }
  const identityError = verifyTreasuryEntryIdentity(entry as unknown as TreasuryIdentityFactsEntry, "迁移定级重算");
  if (identityError !== null) {
    authorityLevelEvents.proofLevelRejections += 1;
    return [null, null, `迁移定级 identity 重算失败（${identityError}）——原 store 保留`];
  }
  const priorLevel = entry.priorAuthorityLevel;
  if (priorLevel !== undefined) {
    const priorError = validateTreasuryAuthorityLevelField(priorLevel);
    if (priorError !== null) {
      authorityLevelEvents.proofLevelRejections += 1;
      return [null, null, priorError];
    }
    if (priorLevel === "forensic") return ["forensic", null, null];
    if (priorLevel === "modern") {
      const missing = modernMatrixMissingFields(entry as TreasuryAuthorityLevelEntryView, options ?? {});
      return missing.length === 0 ? ["modern", null, null] : ["forensic", null, null];
    }
    if (priorLevel === "legacy") {
      const forbidden = legacyForbiddenModernFields(entry as TreasuryAuthorityLevelEntryView);
      return forbidden.length === 0 ? ["legacy", null, null] : ["forensic", null, null];
    }
    // priorLevel === "lowlevel"：受支持的旧 lowlevel schema——严格矩阵复验。
    const missing = lowlevelMatrixMissingFields({ ...entry, lowlevelSource: entry.lowlevelSource ?? TREASURY_LOWLEVEL_SOURCE_MIGRATED } as TreasuryAuthorityLevelEntryView);
    const forbidden = lowlevelForbiddenModernFields(entry as TreasuryAuthorityLevelEntryView);
    return missing.length === 0 && forbidden.length === 0
      ? ["lowlevel", null, null]
      : ["forensic", null, null];
  }
  if (entry.forensic !== undefined) return ["forensic", null, null];
  if (entry.legacyV1 === true) return ["legacy", null, null];
  const matrixComplete = modernMatrixMissingFields(entry as TreasuryAuthorityLevelEntryView, options ?? {}).length === 0;
  if (matrixComplete) return ["modern", null, null];
  const noModernFacts =
    entry.durableIdentityDigest === undefined &&
    !hasCohortFacts &&
    !hasCohortDigest &&
    entry.contractId === undefined &&
    entry.contractDigest === undefined;
  if (noModernFacts) return ["legacy", null, null];
  // 部分现代事实：隔离（forensic）——不得由"剩余字段"猜测为 lowlevel。
  return ["forensic", null, null];
}

/**
 * 【第十四轮第十节】迁移定级结果的应用帮助：lowlevel 定级时补显式
 * migrated 来源标记（其余等级无附加字段）。返回可直接合并进 entry 的
 * 附加字段对象。
 */
export function treasuryMigrationLevelAnnotations(
  level: TreasuryAuthorityLevel,
): { readonly lowlevelSource?: string } {
  return level === "lowlevel" ? { lowlevelSource: TREASURY_LOWLEVEL_SOURCE_MIGRATED } : {};
}
