export interface SquadPolicy {
  readonly id: "standard" | "t3Duo" | "towerDrainDuo";
  readonly duo: boolean; readonly parallel: boolean; readonly needsBoost: boolean;
  readonly countsNeutralWalls: boolean; readonly allowsControllerAttack: boolean;
  readonly meleeCount: number; readonly healerCount: number;
  readonly bodies: Partial<Record<"meleeAttacker" | "healer", readonly BodyPartConstant[]>>;
}
