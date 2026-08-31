/**
 * 【第十五轮第九节】authority-class-specific 的 same-ID 幂等比较器（唯一
 * 权威）。
 *
 * 背景：intent / quarantine / authorization-fault 三个 store 的同 ID 写入
 * 此前统一依赖 `treasuryDurableIdentitiesMatch(existing.durableIdentityDigest,
 * entry.durableIdentityDigest)`——空对空即判 same identity：legacy / forensic
 * entry 即使 digest、postings 或来源不同也被错误视为 already_present。本
 * 模块按 authority class 建立显式比较矩阵（modern / lowlevel / legacy /
 * forensic），三个 store 与双 authority 一致性判定共用：
 *
 * - 公共前置（全 class）：transactionId、digest、kind、actionKind、canonical
 *   postings、source 完全一致；
 * - modern：authorityLevel 相同；durableIdentityDigest 双方完整存在且相等；
 *   authorizationCohortDigest 双方完整存在且相等；contractId/contractDigest
 *   一致（含一方缺失）；
 * - lowlevel：authorityLevel 相同；受控 lowlevelSource 相同；durableIdentityDigest
 *   双方完整存在且相等；
 * - legacy：完整受控 legacy signature（公共前置 + legacyV1 标记一致）才幂等
 *   ——不再以"durable 双空"为通用幂等证明；
 * - forensic：forensic reason/provenance 一致 + 已知 attempt facts（contract/
 *   cohort/durable digest）逐字段相等 + outcome/settlement/phase 一致才幂等；
 *   provenance 不足（如 forensic 标记缺失）不视作 same；
 * - 跨 authority level 的 same-ID entry 永远 conflict。
 */

export interface TreasuryAuthorityIdempotenceEntryView {
  readonly transactionId?: unknown;
  readonly authorityLevel?: unknown;
  readonly lowlevelSource?: unknown;
  readonly digest?: unknown;
  readonly kind?: unknown;
  readonly actionKind?: unknown;
  readonly source?: unknown;
  /** 调用方归一化后的 canonical postings（intent= postings、quarantine= deltas 映射）。 */
  readonly postings?: readonly { roomName: string; locationKind: string; resource: string; delta: number }[];
  readonly contractId?: unknown;
  readonly contractDigest?: unknown;
  readonly authorizationCohortDigest?: unknown;
  readonly durableIdentityDigest?: unknown;
  readonly legacyV1?: unknown;
  readonly forensic?: { readonly reason?: unknown; readonly detail?: unknown } | undefined;
  readonly outcome?: unknown;
  readonly settlement?: unknown;
  readonly phase?: unknown;
  readonly faultTick?: unknown;
}

export type TreasuryAuthoritySameIdVerdict =
  | { readonly verdict: "same" }
  | { readonly verdict: "conflict"; readonly detail: string }
  | { readonly verdict: "insufficient"; readonly detail: string };

function describeDigest(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 16) : String(value ?? "(缺失)");
}

function postingSignature(postings: readonly { roomName: string; locationKind: string; resource: string; delta: number }[] | undefined): string {
  if (postings === undefined) return "(undefined)";
  return [...postings]
    .map((leg) => `${leg.roomName}\u0000${leg.locationKind}\u0000${leg.resource}\u0000${String(leg.delta)}`)
    .sort()
    .join("\u0001");
}

/** optional 字段的 undefined 规范化比较。 */
function normalizedEqual(left: unknown, right: unknown): boolean {
  return (left === undefined || left === null ? undefined : left) === (right === undefined || right === null ? undefined : right);
}

/**
 * 同 ID 既有 entry 与新候选的 class-specific 幂等判定：
 * - 全部要求成立 → same（才允许 already_present）；
 * - 身份/事实/等级/来源不一致 → conflict（原数据不动）；
 * - forensic 形态 provenance 不足 → insufficient（不视作 same，同样保持已有
 *   entry——按 conflict 语义拒绝写入）。
 */
export function compareTreasuryAuthoritySameIdIdentity(
  existing: TreasuryAuthorityIdempotenceEntryView,
  candidate: TreasuryAuthorityIdempotenceEntryView,
  label: string,
): TreasuryAuthoritySameIdVerdict {
  // 公共前置：任何 class 都必须完全一致的基础事实。
  if (!normalizedEqual(existing.transactionId, candidate.transactionId)) {
    return { verdict: "conflict", detail: `${label}: transactionId 不一致` };
  }
  if (!normalizedEqual(existing.digest, candidate.digest)) {
    return {
      verdict: "conflict",
      detail: `${label}: digest 不一致（既有 ${describeDigest(existing.digest)}，新 ${describeDigest(candidate.digest)}）——不得 already_present`,
    };
  }
  if (!normalizedEqual(existing.kind, candidate.kind)) {
    return { verdict: "conflict", detail: `${label}: kind 不一致（既有 ${String(existing.kind)}，新 ${String(candidate.kind)}）` };
  }
  if (!normalizedEqual(existing.actionKind ?? existing.kind, candidate.actionKind ?? candidate.kind)) {
    return { verdict: "conflict", detail: `${label}: actionKind 不一致（既有 ${String(existing.actionKind ?? existing.kind)}，新 ${String(candidate.actionKind ?? candidate.kind)}）` };
  }
  if (!normalizedEqual(existing.source, candidate.source)) {
    return { verdict: "conflict", detail: `${label}: source 不一致（既有 ${String(existing.source)}，新 ${String(candidate.source)}）` };
  }
  if (postingSignature(existing.postings) !== postingSignature(candidate.postings)) {
    return { verdict: "conflict", detail: `${label}: canonical postings 不一致（逐腿比较）——不得 already_present` };
  }
  if (!normalizedEqual(existing.faultTick, candidate.faultTick)) {
    return { verdict: "conflict", detail: `${label}: faultTick 不一致（既有 ${String(existing.faultTick)}，新 ${String(candidate.faultTick)}）` };
  }
  // 跨 authority level 的 same-ID entry 永远冲突。
  if (!normalizedEqual(existing.authorityLevel, candidate.authorityLevel)) {
    return {
      verdict: "conflict",
      detail: `${label}: authorityLevel 不一致（既有 ${String(existing.authorityLevel)}，新 ${String(candidate.authorityLevel)}）——跨等级 same-ID 永远冲突`,
    };
  }
  const level = candidate.authorityLevel;
  if (level === "modern") {
    if (existing.durableIdentityDigest === undefined || candidate.durableIdentityDigest === undefined) {
      return { verdict: "insufficient", detail: `${label}: modern durableIdentityDigest 不完整（等级矩阵已保证存在——缺失即身份不可证明）` };
    }
    if (existing.durableIdentityDigest !== candidate.durableIdentityDigest) {
      return { verdict: "conflict", detail: `${label}: modern durable identity 不一致（既有 ${describeDigest(existing.durableIdentityDigest)}，新 ${describeDigest(candidate.durableIdentityDigest)}）` };
    }
    if (existing.authorizationCohortDigest === undefined || candidate.authorizationCohortDigest === undefined) {
      return { verdict: "insufficient", detail: `${label}: modern authorizationCohortDigest 不完整（cohort identity 必须双方存在且相等）` };
    }
    if (existing.authorizationCohortDigest !== candidate.authorizationCohortDigest) {
      return { verdict: "conflict", detail: `${label}: cohort identity 不一致（既有 ${describeDigest(existing.authorizationCohortDigest)}，新 ${describeDigest(candidate.authorizationCohortDigest)}）` };
    }
    if (!normalizedEqual(existing.contractId, candidate.contractId)) {
      return { verdict: "conflict", detail: `${label}: modern contractId 不一致（含一方缺失）` };
    }
    if (!normalizedEqual(existing.contractDigest, candidate.contractDigest)) {
      return { verdict: "conflict", detail: `${label}: modern contractDigest 不一致（含一方缺失）` };
    }
    return { verdict: "same" };
  }
  if (level === "lowlevel") {
    if (!normalizedEqual(existing.lowlevelSource, candidate.lowlevelSource)) {
      return { verdict: "conflict", detail: `${label}: lowlevelSource 不一致（既有 ${String(existing.lowlevelSource)}，新 ${String(candidate.lowlevelSource)}）——受控来源是身份成分` };
    }
    if (existing.durableIdentityDigest === undefined || candidate.durableIdentityDigest === undefined) {
      return { verdict: "insufficient", detail: `${label}: lowlevel durableIdentityDigest 不完整（低层矩阵已保证存在）` };
    }
    if (existing.durableIdentityDigest !== candidate.durableIdentityDigest) {
      return { verdict: "conflict", detail: `${label}: lowlevel durable identity 不一致（既有 ${describeDigest(existing.durableIdentityDigest)}，新 ${describeDigest(candidate.durableIdentityDigest)}）` };
    }
    return { verdict: "same" };
  }
  if (level === "legacy") {
    // 完整受控 legacy signature：公共前置 + legacyV1 标记一致。
    if (!normalizedEqual(existing.legacyV1, candidate.legacyV1)) {
      return { verdict: "conflict", detail: `${label}: legacyV1 标记不一致（既有 ${String(existing.legacyV1)}，新 ${String(candidate.legacyV1)}）` };
    }
    return { verdict: "same" };
  }
  if (level === "forensic") {
    // forensic：provenance（reason）+ 已知 attempt facts + outcome/settlement/
    // phase 全部相同才幂等；provenance 不足不视作 same。
    if (existing.forensic === undefined || candidate.forensic === undefined) {
      return {
        verdict: "insufficient",
        detail: `${label}: forensic provenance 缺失（既有 ${existing.forensic === undefined ? "无" : "有"}，新 ${candidate.forensic === undefined ? "无" : "有"}）——缺少隔离原因标记，不视作 same identity`,
      };
    }
    if (!normalizedEqual(existing.forensic.reason, candidate.forensic.reason)) {
      return { verdict: "conflict", detail: `${label}: forensic reason 不一致（既有 ${String(existing.forensic.reason)}，新 ${String(candidate.forensic.reason)}）` };
    }
    if (!normalizedEqual(existing.contractDigest, candidate.contractDigest)) {
      return { verdict: "conflict", detail: `${label}: forensic 已知 contractDigest 不一致（含一方缺失）` };
    }
    if (!normalizedEqual(existing.authorizationCohortDigest, candidate.authorizationCohortDigest)) {
      return { verdict: "conflict", detail: `${label}: forensic 已知 cohortDigest 不一致（含一方缺失）` };
    }
    if (!normalizedEqual(existing.durableIdentityDigest, candidate.durableIdentityDigest)) {
      return { verdict: "conflict", detail: `${label}: forensic 已知 durable identity 不一致（含一方缺失）` };
    }
    if (!normalizedEqual(existing.outcome, candidate.outcome)) {
      return { verdict: "conflict", detail: `${label}: forensic outcome 不一致（既有 ${String(existing.outcome)}，新 ${String(candidate.outcome)}）` };
    }
    if (!normalizedEqual(existing.phase, candidate.phase)) {
      return { verdict: "conflict", detail: `${label}: forensic phase 不一致（既有 ${String(existing.phase)}，新 ${String(candidate.phase)}）` };
    }
    return { verdict: "same" };
  }
  // authorityLevel 缺失/未知（store 校验本应拦截）：不视作 same。
  return { verdict: "insufficient", detail: `${label}: authorityLevel 缺失或未知（${String(level)}）——无法按 class 判定 same identity` };
}
