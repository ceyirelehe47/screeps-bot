import type { SquadPolicy } from "./types";
export const standard: SquadPolicy = { id: "standard", duo: false, parallel: false, needsBoost: false, countsNeutralWalls: false, allowsControllerAttack: true, meleeCount: 2, healerCount: 1, bodies: {} };
