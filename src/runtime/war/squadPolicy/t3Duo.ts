import type { SquadPolicy } from "./types";
import { T3_ATTACKER_BODY, T3_HEALER_BODY } from "../constants";
export const t3Duo: SquadPolicy = { id: "t3Duo", duo: true, parallel: false, needsBoost: true, countsNeutralWalls: false, allowsControllerAttack: true, meleeCount: 1, healerCount: 1, bodies: { meleeAttacker: T3_ATTACKER_BODY, healer: T3_HEALER_BODY } };
