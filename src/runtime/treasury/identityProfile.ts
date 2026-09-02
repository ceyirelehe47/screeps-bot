/**
 * 【第二十二轮第十一节】explicit identity profile 单一权威。
 *
 * Round 21 及之前"是否 modern contract"由 optional 字段反向推断（lineage /
 * GRA / receipt 三处各自实现近似逻辑）：contract/cohort 同时丢失时
 * identity-bound proof 静默降级为"弱 identity-bound"继续参与协议，而非
 * store unhealthy。本轮起权威记录（Attempt Lineage / GRA / Terminal Exact
 * Summary / 新版 exact Marker）显式持久 identity profile，字段矩阵只有
 * 本模块一个实现：
 *
 * - modern-contract：digest / contractDigest / authorizationCohortDigest /
 *   durableIdentityDigest 全部 required；禁止 lowlevelSource。删除任一
 *   required 事实 → store unhealthy（不得降级为弱 identity-bound）。
 * - lowlevel：digest / durableIdentityDigest / 受控 lowlevelSource 全部
 *   required；禁止 contract/cohort 事实。
 * - legacy-replay：只能阻止旧 ID 重放与提供诊断——不得参与自动 release /
 *   rearm / commit / exact terminal validation / modern compaction。
 * - forensic-isolated：保持隔离，不参与普通协议。
 *
 * profile 与 proof class 的合法组合唯一：modern-contract ↔ identity-bound、
 * lowlevel ↔ lowlevel、legacy-replay ↔ legacy、forensic-isolated ↔ forensic。
 * Lineage transition 不得改变 profile；GRA / Summary / Marker 的 profile
 * 必须与 Lineage 一致（调用方比较，本模块提供矩阵）。
 */

import { validateTreasuryLowlevelSourceField } from "@/runtime/treasury/authorityLevel";

/** 显式 identity profile（四枚举——语义见模块头）。 */
export type TreasuryIdentityProfile =
  | "modern-contract"
  | "lowlevel"
  | "legacy-replay"
  | "forensic-isolated";

/** profile 合法枚举集合（形状校验共用）。 */
export const TREASURY_IDENTITY_PROFILES: ReadonlySet<string> = new Set<string>([
  "modern-contract",
  "lowlevel",
  "legacy-replay",
  "forensic-isolated",
]);

/** identity 事实输入（与 exactAttemptIdentity 的 facts 输入同源字段子集）。 */
export interface TreasuryIdentityProfileFactsInput {
  readonly digest?: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
}

/** profile → proof class（唯一合法映射）。 */
export function treasuryProofClassOfIdentityProfile(profile: TreasuryIdentityProfile): string {
  switch (profile) {
    case "modern-contract":
      return "identity-bound";
    case "lowlevel":
      return "lowlevel";
    case "legacy-replay":
      return "legacy";
    case "forensic-isolated":
      return "forensic";
  }
}

/** proof class → profile（反向唯一映射；未知 class → null 不猜测）。 */
export function treasuryIdentityProfileOfProofClass(proofClass: string): TreasuryIdentityProfile | null {
  switch (proofClass) {
    case "identity-bound":
      return "modern-contract";
    case "lowlevel":
      return "lowlevel";
    case "legacy":
      return "legacy-replay";
    case "forensic":
      return "forensic-isolated";
    default:
      return null;
  }
}

/**
 * profile 的 required/forbidden 字段矩阵校验：返回 null = 合法，否则有界
 * 错误描述。modern-contract 缺任一 required 事实 → 错误（调用方按
 * store unhealthy fail closed，不得降级）；lowlevel 携带 contract/cohort →
 * 错误；modern-contract 携带 lowlevelSource → 错误。
 */
export function validateTreasuryIdentityProfileFacts(
  profile: TreasuryIdentityProfile,
  facts: TreasuryIdentityProfileFactsInput | undefined,
): string | null {
  if (!TREASURY_IDENTITY_PROFILES.has(profile)) return `identity profile 非法枚举: ${String(profile).slice(0, 32)}`;
  if (facts === undefined || typeof facts !== "object") return "identity facts 缺失（profile requiredness 不可验证）";
  switch (profile) {
    case "modern-contract": {
      for (const field of ["digest", "contractDigest", "authorizationCohortDigest", "durableIdentityDigest"] as const) {
        if (facts[field] === undefined) {
          return `modern-contract profile 缺少 required 事实 ${field}（store unhealthy——不得降级为弱 identity-bound）`;
        }
      }
      if (facts.lowlevelSource !== undefined) {
        return "modern-contract profile 携带 lowlevelSource（forbidden 事实——class 矛盾）";
      }
      return null;
    }
    case "lowlevel": {
      for (const field of ["digest", "durableIdentityDigest", "lowlevelSource"] as const) {
        if (facts[field] === undefined) {
          return `lowlevel profile 缺少 required 事实 ${field}（store unhealthy——不得降级）`;
        }
      }
      const sourceError = validateTreasuryLowlevelSourceField(facts.lowlevelSource);
      if (sourceError !== null) return `lowlevel profile 的 lowlevelSource 非受控值: ${sourceError}`;
      if (facts.contractDigest !== undefined || facts.authorizationCohortDigest !== undefined) {
        return "lowlevel profile 携带 contract/cohort 事实（forbidden——class 矛盾）";
      }
      return null;
    }
    case "legacy-replay":
    case "forensic-isolated":
      // 隔离 profile 不强制字段（遗留形状原样保留供 replay 阻断与诊断）；
      // 协议参与限制由 treasuryProfileAllowsAutomaticProtocol 承载。
      return null;
  }
}

/**
 * 从 identity 事实确定性推导 profile（迁移用单一推导规则）：
 * - 受控 lowlevelSource + digest + durable（无 contract/cohort）→ lowlevel；
 * - digest + contract + cohort + durable 完整 → modern-contract；
 * - digest 存在、contract/cohort 同时缺失（含缺 durable 的弱身份遗留）→
 *   legacy-replay（不得假定 modern contract——不自动获得 execution /
 *   settlement 权限）；
 * - contract 与 cohort 恰好一个存在（partial）→ null（整 store fail closed）；
 * - lowlevel 维度不完整（有 source 缺 digest/durable，或同时携带 contract/
 *   cohort）→ null（矛盾，fail closed）；
 * - 缺 digest → null（基础维度不可证明）。
 */
export function treasuryIdentityProfileOfFacts(
  facts: TreasuryIdentityProfileFactsInput | undefined,
): TreasuryIdentityProfile | null {
  if (facts === undefined || typeof facts !== "object") return null;
  if (facts.digest === undefined) return null;
  const hasLowlevel = facts.lowlevelSource !== undefined;
  const hasContract = facts.contractDigest !== undefined;
  const hasCohort = facts.authorizationCohortDigest !== undefined;
  const hasDurable = facts.durableIdentityDigest !== undefined;
  if (hasContract !== hasCohort) return null;
  if (hasLowlevel) {
    if (hasContract || hasCohort) return null;
    if (!hasDurable) return null;
    if (validateTreasuryLowlevelSourceField(facts.lowlevelSource) !== null) return null;
    return "lowlevel";
  }
  if (hasContract && hasCohort && hasDurable) return "modern-contract";
  return "legacy-replay";
}

/**
 * profile 是否允许参与自动协议（release / rearm / commit / exact compaction /
 * 现代 Receipt 写入）。legacy-replay 与 forensic-isolated → false。
 */
export function treasuryProfileAllowsAutomaticProtocol(profile: TreasuryIdentityProfile): boolean {
  return profile === "modern-contract" || profile === "lowlevel";
}

/**
 * 权威记录间 profile 一致性比较（Lineage ↔ GRA / Summary / Marker）：
 * 不一致 → 有界错误描述；一致 → null。
 */
export function treasuryIdentityProfileConflictDetail(
  authority: string,
  left: TreasuryIdentityProfile,
  right: TreasuryIdentityProfile,
): string | null {
  if (left !== right) {
    return `${authority} 的 identity profile 不一致（${left} vs ${right}——profile 在 lineage 生命周期中不可变）`;
  }
  return null;
}
