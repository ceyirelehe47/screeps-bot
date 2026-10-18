export type PathCompleteness = "allowPartial" | "complete";
export interface MoveProfile {
  readonly completeness: PathCompleteness;
  readonly maxOps: number;
  readonly reusePath: number;
  readonly partialTtl: number;
}

/** 完整性、搜索上限和复用窗口独立；完整路径不会隐式增加搜索预算。 */
export const MOVE_PROFILES = Object.freeze({
  local: Object.freeze({ completeness: "allowPartial", maxOps: 8000, reusePath: 5, partialTtl: 2 }),
  travel: Object.freeze({ completeness: "allowPartial", maxOps: 8000, reusePath: 10, partialTtl: 2 }),
  combat: Object.freeze({ completeness: "complete", maxOps: 16000, reusePath: 3, partialTtl: 1 }),
  formation: Object.freeze({ completeness: "complete", maxOps: 16000, reusePath: 5, partialTtl: 1 }),
} satisfies Record<string, MoveProfile>);
export type MoveProfileName = keyof typeof MOVE_PROFILES;

export function resolveMoveProfile(options: Partial<MoveProfile> & { profile?: MoveProfileName }): MoveProfile {
  const defaults = MOVE_PROFILES[options.profile ?? "local"];
  return {
    completeness: options.completeness ?? defaults.completeness,
    maxOps: Math.max(1, Math.min(32000, Math.floor(Number.isFinite(options.maxOps) ? options.maxOps! : defaults.maxOps))),
    reusePath: Math.max(0, Math.floor(Number.isFinite(options.reusePath) ? options.reusePath! : defaults.reusePath)),
    partialTtl: Math.max(1, Math.min(5, Math.floor(Number.isFinite(options.partialTtl) ? options.partialTtl! : defaults.partialTtl))),
  };
}
