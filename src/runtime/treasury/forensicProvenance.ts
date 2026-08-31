/**
 * 【第十五轮第八节】forensic proof 的显式管理 provenance 语义。
 *
 * 背景：proofLevel=forensic 只描述"隔离容器"，不能证明"已经人工/显式管理
 * 确认"。migration-derived forensic（旧 partial identity 自动迁移、recovery
 * 防御直写）与"有人显式确认过风险"的 forensic 必须可区分——前者永久隔离，
 * 后者（本轮未实现完整流程）同样不由普通自动恢复释放。
 *
 * 语义字段（至少表达）：forensic 协议/版本、acknowledgement 类型、管理操作
 * 身份或 capability digest、attempt identity、确认时间、来源、是否允许自动
 * 补完成。
 */

export const TREASURY_FORENSIC_PROVENANCE_PROTOCOL = "treasury-forensic-resolution@v1" as const;

/** 显式 forensic 管理确认的 provenance（resolution tombstone v5 可选字段）。 */
export interface TreasuryForensicProvenance {
  readonly protocol: typeof TREASURY_FORENSIC_PROVENANCE_PROTOCOL;
  readonly acknowledgement: "explicit_management";
  /** 管理操作身份（有界字符串；或与 capabilityDigest 二选一提供）。 */
  readonly confirmedBy?: string;
  /** 管理操作 capability digest（16 小写 hex；或与 confirmedBy 二选一提供）。 */
  readonly capabilityDigest?: string;
  /** 确认时绑定的已知 attempt identity（digest 必填，身份字段按已知程度）。 */
  readonly attempt: {
    readonly digest: string;
    readonly contractDigest?: string;
    readonly authorizationCohortDigest?: string;
    readonly durableIdentityDigest?: string;
  };
  readonly confirmedAtTick: number;
  /** 来源（有界字符串——诊断与审计保留）。 */
  readonly source: string;
  /** 是否允许（显式 forensic 流程内部的）自动补完成；false = 永久隔离。 */
  readonly allowAutomaticCompletion: boolean;
}

const FORENSIC_STRING_MAX = 128;
const FORENSIC_DIGEST_PATTERN = /^[0-9a-f]{16}$/;

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * forensic provenance 的完整形状校验（持久 read-back 与写入共用；返回
 * null = 合法）。协议版本、acknowledgement 枚举、管理身份（confirmedBy 与
 * capabilityDigest 至少其一）、attempt digest、确认 tick、来源、自动补完成
 * 布尔全部显式校验——缺任一即不是可信任的显式管理 provenance。
 */
export function validateTreasuryForensicProvenanceShape(value: unknown): string | null {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    return "forensic provenance 非普通对象";
  }
  const candidate = value as Partial<TreasuryForensicProvenance>;
  if (candidate.protocol !== TREASURY_FORENSIC_PROVENANCE_PROTOCOL) {
    return `forensic provenance 协议非法（须为 ${TREASURY_FORENSIC_PROVENANCE_PROTOCOL}）: ${String(candidate.protocol).slice(0, 48)}`;
  }
  if (candidate.acknowledgement !== "explicit_management") {
    return `forensic provenance acknowledgement 非法（须为 explicit_management）: ${String(candidate.acknowledgement).slice(0, 32)}`;
  }
  const hasConfirmedBy =
    typeof candidate.confirmedBy === "string" && candidate.confirmedBy.length > 0 && candidate.confirmedBy.length <= FORENSIC_STRING_MAX;
  const hasCapabilityDigest =
    typeof candidate.capabilityDigest === "string" && FORENSIC_DIGEST_PATTERN.test(candidate.capabilityDigest);
  if (!hasConfirmedBy && !hasCapabilityDigest) {
    return "forensic provenance 缺少管理操作身份（confirmedBy 或 capabilityDigest 至少其一，1..128 字符 / 16 hex）";
  }
  if (candidate.attempt === undefined || candidate.attempt === null || typeof candidate.attempt !== "object") {
    return "forensic provenance 缺少 attempt identity";
  }
  const attempt = candidate.attempt as { digest?: unknown; contractDigest?: unknown; authorizationCohortDigest?: unknown; durableIdentityDigest?: unknown };
  if (typeof attempt.digest !== "string" || !FORENSIC_DIGEST_PATTERN.test(attempt.digest)) {
    return "forensic provenance attempt.digest 非法（须为 16 小写 hex）";
  }
  for (const field of ["contractDigest", "authorizationCohortDigest", "durableIdentityDigest"] as const) {
    const digest = attempt[field];
    if (digest !== undefined && (typeof digest !== "string" || !FORENSIC_DIGEST_PATTERN.test(digest))) {
      return `forensic provenance attempt.${field} 非法（须为 16 小写 hex）`;
    }
  }
  if (!isSafeInteger(candidate.confirmedAtTick) || candidate.confirmedAtTick < 0) {
    return "forensic provenance confirmedAtTick 非安全整数";
  }
  if (typeof candidate.source !== "string" || candidate.source.length === 0 || candidate.source.length > FORENSIC_STRING_MAX) {
    return `forensic provenance source 非法（须为 1..${String(FORENSIC_STRING_MAX)} 字符）`;
  }
  if (typeof candidate.allowAutomaticCompletion !== "boolean") {
    return "forensic provenance allowAutomaticCompletion 非布尔";
  }
  return null;
}

/**
 * tombstone 是否携带可信任的显式管理 provenance（形状完整）。migration-
 * derived forensic（无 provenance 或形状损坏）一律返回 false——永久隔离。
 */
export function hasExplicitTreasuryForensicProvenance(tombstone: { forensicProvenance?: unknown }): boolean {
  return tombstone.forensicProvenance !== undefined && validateTreasuryForensicProvenanceShape(tombstone.forensicProvenance) === null;
}
