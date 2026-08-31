/**
 * 【第十四轮第八节】authority-level 兼容矩阵（单一权威模块）。
 *
 * intent ↔ quarantine 同 id 双存在时，两条 authority 的显式 authorityLevel
 * 必须先经过本矩阵判定，等级不兼容（任何跨等级组合）即整体 inconsistent
 * ——不得任选其一、不得退回 optional 字段子集比较：
 *
 * | 组合              | 判定                                   |
 * |-------------------|----------------------------------------|
 * | modern + modern   | 允许继续比较完整 durable identity       |
 * | lowlevel + lowlevel | 允许按严格 lowlevel identity 比较     |
 * | legacy + legacy   | 仅允许受控 legacy 一致性比较            |
 * | forensic + forensic | 仅明确同一 forensic 隔离记录时可合并  |
 * | 任意跨等级组合     | incompatible（inconsistent fail closed）|
 *
 * especially：modern + legacy / modern + lowlevel / modern + forensic /
 * lowlevel + legacy / lowlevel + forensic 一律 incompatible——modern authority
 * 永远不得被低等级形态的并存记录"合并"或替代。
 */

import {
  TREASURY_AUTHORITY_LEVELS,
  type TreasuryAuthorityLevel,
} from "@/runtime/treasury/authorityLevel";

export type TreasuryAuthorityLevelPairCompatibility = "comparable" | "incompatible";

/**
 * 等级对兼容判定：同等级 → comparable；跨等级 → incompatible；未知/缺失
 * 等级（store unhealthy 形态）→ incompatible（保守 fail closed）。
 */
export function treasuryAuthorityLevelPairCompatibility(
  left: unknown,
  right: unknown,
): TreasuryAuthorityLevelPairCompatibility {
  if (typeof left !== "string" || typeof right !== "string") return "incompatible";
  if (!TREASURY_AUTHORITY_LEVELS.has(left) || !TREASURY_AUTHORITY_LEVELS.has(right)) return "incompatible";
  if (left !== right) return "incompatible";
  return "comparable";
}

/** 双 authority 一致性比较所需的等级语义描述（诊断/比较策略选择）。 */
export function treasuryAuthorityPairComparisonKind(
  level: TreasuryAuthorityLevel,
): "modern-full-identity" | "lowlevel-strict" | "legacy-controlled" | "forensic-provenance" {
  switch (level) {
    case "modern":
      return "modern-full-identity";
    case "lowlevel":
      return "lowlevel-strict";
    case "legacy":
      return "legacy-controlled";
    case "forensic":
      return "forensic-provenance";
  }
}
