import { retireCreep } from "@/runtime/retirement";
import { getTickContextService } from "@/runtime/runtimeServices";
import { issueMove } from "@/movement/traffic";
import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { getPositionAtDirection, isExitTile } from "@/movement/common";
import type { RoleFactory } from "@/types/system";
import type { RemoteDefenseReason } from "@/runtime/remoteMining";

const SOURCE_KEEPER_USERNAME = "Source Keeper";
const INVADER_USERNAME = "Invader";
const FLEE_DIRECTIONS: DirectionConstant[] = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT];

type RemoteDefenseTarget = Creep | StructureInvaderCore;

function getTargetRoomFromConfig(creep: Creep): string | null {
  const parts = creep.memory.configName?.split(":");
  if (!parts || parts.length < 3) return null;
  return parts[2];
}

function getSourceRoomFromConfig(creep: Creep): string | null {
  const parts = creep.memory.configName?.split(":");
  if (!parts || parts.length < 1) return null;
  return parts[0];
}

function getDefenseReason(targetRoom: string): RemoteDefenseReason | null {
  const task = Memory.data?.remoteMining?.[targetRoom];
  if (!task || task.status !== "defending") return null;
  return task.defenseReason ?? null;
}

function isTaskDefending(targetRoom: string): boolean {
  const task = Memory.data?.remoteMining?.[targetRoom];
  return task?.status === "defending";
}

function getUsername(creep: Creep): string {
  return (creep.owner as { username: string } | undefined)?.username ?? "";
}

function hasBodyPart(creep: Creep, partType: BodyPartConstant): boolean {
  if (typeof creep.getActiveBodyparts === "function") {
    return creep.getActiveBodyparts(partType) > 0;
  }
  return creep.body?.some((bp: BodyPartDefinition) => bp.type === partType && bp.hits > 0) ?? false;
}

function isEligibleTarget(hostile: Creep, defenseReason: RemoteDefenseReason | null): boolean {
  const username = getUsername(hostile);
  if (username === SOURCE_KEEPER_USERNAME) return false;
  if (username === INVADER_USERNAME) {
    return true;
  }
  return defenseReason === "player_aggression";
}

function isBoundaryBlockerTarget(creep: Creep, hostile: Creep, defenseReason: RemoteDefenseReason | null): boolean {
  if (!isExitTile(creep.pos) || creep.pos.getRangeTo(hostile.pos) > 3) {
    return false;
  }

  const username = getUsername(hostile);
  if (username === SOURCE_KEEPER_USERNAME) {
    return false;
  }
  if (username === INVADER_USERNAME) {
    return true;
  }
  return defenseReason === "player_aggression";
}

function getEligibleTargets(creep: Creep, hostiles: Creep[], defenseReason: RemoteDefenseReason | null): Creep[] {
  const activeThreats = hostiles.filter((h) => isEligibleTarget(h, defenseReason));
  if (activeThreats.length > 0) {
    return activeThreats;
  }
  return hostiles.filter((h) => isBoundaryBlockerTarget(creep, h, defenseReason));
}

function targetPriorityScore(hostile: Creep): number {
  const healParts = typeof hostile.getActiveBodyparts === "function"
    ? hostile.getActiveBodyparts(HEAL) : 0;
  const rangedParts = typeof hostile.getActiveBodyparts === "function"
    ? hostile.getActiveBodyparts(RANGED_ATTACK) : 0;
  const attackParts = typeof hostile.getActiveBodyparts === "function"
    ? hostile.getActiveBodyparts(ATTACK) : 0;
  if (healParts > 0) return 3;
  if (rangedParts > 0) return 2;
  if (attackParts > 0) return 1;
  return 0;
}

function pickTarget(creep: Creep, eligible: Creep[]): Creep | null {
  if (eligible.length === 0) return null;
  let best: Creep | null = null;
  let bestScore = -1;
  let bestRange = Infinity;
  for (const hostile of eligible) {
    const score = targetPriorityScore(hostile);
    const range = creep.pos.getRangeTo(hostile.pos);
    if (score > bestScore || (score === bestScore && range < bestRange)) {
      bestScore = score;
      bestRange = range;
      best = hostile;
    }
  }
  return best;
}

function pickInvaderCoreTarget(
  creep: Creep,
  defenseReason: RemoteDefenseReason | null,
): StructureInvaderCore | null {
  if (defenseReason !== "npc_invader_core") {
    return null;
  }

  const cores = creep.room.find(FIND_HOSTILE_STRUCTURES, {
    filter: structure => structure.structureType === STRUCTURE_INVADER_CORE,
  }) as StructureInvaderCore[];
  return creep.pos.findClosestByRange(cores);
}

function isInvaderCoreTarget(target: RemoteDefenseTarget): target is StructureInvaderCore {
  return "structureType" in target && target.structureType === STRUCTURE_INVADER_CORE;
}

function isFriendlyRemoteCreep(creep: Creep, sourceRoom: string, targetRoom: string): boolean {
  const prefix = `${sourceRoom}:remoteMine:${targetRoom}:`;
  return creep.my && !!creep.memory.configName?.startsWith(prefix);
}

function getFleeDirection(creep: Creep, hostile: Creep): DirectionConstant {
  const dir = hostile.pos.getDirectionTo(creep.pos);
  if (dir !== null) return dir;
  const dx = creep.pos.x - hostile.pos.x;
  const dy = creep.pos.y - hostile.pos.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? RIGHT : LEFT;
  }
  return dy >= 0 ? BOTTOM : TOP;
}

function isSafeFleeDirection(creep: Creep, hostile: Creep, direction: DirectionConstant, currentRange: number): boolean {
  const nextPos = getPositionAtDirection(creep.pos, direction);
  if (!nextPos || isExitTile(nextPos)) {
    return false;
  }
  return nextPos.getRangeTo(hostile.pos) > currentRange;
}

function getSafeFleeDirection(creep: Creep, hostile: Creep, currentRange: number): DirectionConstant | null {
  const preferred = getFleeDirection(creep, hostile);
  if (isSafeFleeDirection(creep, hostile, preferred, currentRange)) {
    return preferred;
  }

  let bestDirection: DirectionConstant | null = null;
  let bestRange = currentRange;
  for (const direction of FLEE_DIRECTIONS) {
    if (!isSafeFleeDirection(creep, hostile, direction, currentRange)) {
      continue;
    }
    const nextPos = getPositionAtDirection(creep.pos, direction);
    if (!nextPos) {
      continue;
    }
    const range = nextPos.getRangeTo(hostile.pos);
    if (range > bestRange) {
      bestRange = range;
      bestDirection = direction;
    }
  }

  if (bestDirection !== null) {
    return bestDirection;
  }

  return null;
}

function moveInwardDuringBoundaryReady(creep: Creep, targetRoom: string): void {
  if (creep.room.name !== targetRoom || !isExitTile(creep.pos)) {
    return;
  }

  const defenseReason = getDefenseReason(targetRoom);
  const hostiles: Creep[] = creep.room.find(FIND_HOSTILE_CREEPS);
  const target = pickTarget(creep, getEligibleTargets(creep, hostiles, defenseReason));
  if (!target) {
    return;
  }

  const targetRange = creep.pos.getRangeTo(target.pos);
  const fleeDir = getSafeFleeDirection(creep, target, targetRange);
  if (fleeDir !== null) {
    issueMove(creep, fleeDir);
  }
}

function retireTowardSource(creep: Creep, sourceRoom: string): void {
  if (creep.room.name !== sourceRoom) {
    moveToTargetRoom(creep, sourceRoom, undefined, { reusePath: 5 });
    return;
  }

  moveToTarget(creep, new RoomPosition(25, 25, sourceRoom), 3, { reusePath: 5 });
  if (creep.pos.roomName === sourceRoom) {
    retireCreep(creep, { owner: "remoteMining", mode: "suicide" });
  }
}

export const remoteDefenderRole: RoleFactory = (...args: string[]) => {
  const targetRoom = args[0];
  return {
    prepare: (creep: Creep): boolean => {
      const resolvedTargetRoom = targetRoom || getTargetRoomFromConfig(creep);
      if (resolvedTargetRoom) {
        moveInwardDuringBoundaryReady(creep, resolvedTargetRoom);
      }
      return true;
    },

    target: (creep: Creep): boolean => {
      const resolvedTargetRoom = targetRoom || getTargetRoomFromConfig(creep);
      if (!resolvedTargetRoom) return false;

      const sourceRoom = getSourceRoomFromConfig(creep) ?? resolvedTargetRoom;
      const defending = isTaskDefending(resolvedTargetRoom);

      if (!defending && creep.room.name !== resolvedTargetRoom) {
        retireTowardSource(creep, sourceRoom);
        return false;
      }

      if (creep.room.name !== resolvedTargetRoom) {
        moveToTargetRoom(creep, resolvedTargetRoom, undefined, {
          plainCost: 2,
          swampCost: 10,
          profile: "travel" as const,
          reusePath: 10,
        });
        return false;
      }

      const defenseReason = getDefenseReason(resolvedTargetRoom);

      const hostiles: Creep[] = creep.room.find(FIND_HOSTILE_CREEPS);
      const eligible = getEligibleTargets(creep, hostiles, defenseReason);
      const hostileTarget = pickTarget(creep, eligible);
      const target: RemoteDefenseTarget | null = hostileTarget ?? pickInvaderCoreTarget(creep, defenseReason);

      if (!target) {
        if (!defending) {
          retireTowardSource(creep, sourceRoom);
        }
        return false;
      }

      if (creep.hits < creep.hitsMax * 0.5) {
        creep.heal(creep);
        if (creep.room.name !== sourceRoom) {
          moveToTargetRoom(creep, sourceRoom, undefined, { reusePath: 5 });
        } else {
          moveToTarget(creep, new RoomPosition(25, 25, sourceRoom), 3, { reusePath: 5 });
        }
        return false;
      }

      if (creep.hits < creep.hitsMax) {
        creep.heal(creep);
      } else {
        let healed = false;
        const friendlies = getTickContextService().getAllCreeps().filter(
          (c) => c.name !== creep.name && isFriendlyRemoteCreep(c, sourceRoom, resolvedTargetRoom) && c.hits < c.hitsMax,
        );
        const adjacent = friendlies.filter((f) => creep.pos.getRangeTo(f.pos) <= 1);
        if (adjacent.length > 0) {
          const mostDamaged = adjacent.reduce((a, b) =>
            (a.hitsMax - a.hits) > (b.hitsMax - b.hits) ? a : b,
          );
          creep.heal(mostDamaged);
          healed = true;
        }
        if (!healed) {
          const inRangedRange = friendlies.filter((f) => creep.pos.getRangeTo(f.pos) <= 3);
          if (inRangedRange.length > 0) {
            const mostDamaged = inRangedRange.reduce((a, b) =>
              (a.hitsMax - a.hits) > (b.hitsMax - b.hits) ? a : b,
            );
            creep.rangedHeal(mostDamaged);
          }
        }
      }

      const targetRange = creep.pos.getRangeTo(target.pos);

      if (isInvaderCoreTarget(target)) {
        if (targetRange <= 3) {
          // Never use rangedMassAttack for structure clearance: a single-target
          // intent guarantees unrelated player structures are not damaged.
          creep.rangedAttack(target);
        } else {
          moveToTarget(creep, target, 3, { reusePath: 5, avoidExitTiles: true });
        }
        return false;
      }

      if (targetRange <= 3) {
        const eligibleInRange3 = eligible.filter((h) => creep.pos.getRangeTo(h.pos) <= 3);
        if (defenseReason === "npc_invader_core") {
          // Core clearance is always single-target, even while clearing an
          // Invader escort. Mass attack could damage unrelated player structures.
          creep.rangedAttack(target);
        } else if (eligibleInRange3.length >= 3) {
          creep.rangedMassAttack();
        } else {
          creep.rangedAttack(target);
        }
      } else {
        moveToTarget(creep, target, 3, { reusePath: 5, avoidExitTiles: true });
      }

      const shouldFleeMelee = hasBodyPart(target, ATTACK) && targetRange < 3;
      const shouldStepOffExit = isExitTile(creep.pos) && targetRange <= 3;
      if (shouldFleeMelee || shouldStepOffExit) {
        const fleeDir = getSafeFleeDirection(creep, target, targetRange);
        // Tactical directional move — not destination pathfinding
        if (fleeDir !== null) {
          issueMove(creep, fleeDir);
        }
      }

      return false;
    },
  };
};
