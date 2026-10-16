import type { SquadPolicy } from "./types";
import { TOWER_DRAIN_ATTACKER_BODY, TOWER_DRAIN_HEALER_BODY } from "../constants";
export const towerDrainDuo: SquadPolicy = { id: "towerDrainDuo", duo: true, parallel: true, needsBoost: false, countsNeutralWalls: true, allowsControllerAttack: false, meleeCount: 1, healerCount: 1, bodies: { meleeAttacker: TOWER_DRAIN_ATTACKER_BODY, healer: TOWER_DRAIN_HEALER_BODY } };
