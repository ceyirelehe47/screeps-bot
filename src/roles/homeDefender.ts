import { getSafeZone } from "@/runtime/safeZone";
import { measureCreepDecision, measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { getAssignedDefenseFront, getDefenderRole, getTowerFocusFront, type DefenseFrontSummary } from "@/runtime/defenseCoordination";
import { getPlayerHostiles } from "@/runtime/defenseMode";
import { chooseBoundaryBurstEngagement, chooseInsideBurstTarget } from "@/runtime/hostilePriorities";
import { createSafeZoneCostCallback, getBoundaryRamparts } from "@/runtime/safeZoneHelpers";
import { readRoomEngagementPlan } from "@/runtime/defenseFocusFire";
import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import type { RoleFactory } from "@/types/system";

function findEngagedHostileIdByOtherDefenders(creep: Creep, hostiles: Creep[]): Id<Creep> | null {
  for (const other of creep.room.find(FIND_MY_CREEPS)) {
    if (other.name === creep.name || other.memory.role !== "homeDefender") {
      continue;
    }

    for (const hostile of hostiles) {
      if (other.pos.getRangeTo(hostile.pos) <= 1) {
        return hostile.id;
      }
    }
  }

  return null;
}

function findNearestUnoccupiedRampartToFront(
  front: DefenseFrontSummary | null,
  ramparts: StructureRampart[],
  occupiedRampartIds: Set<Id<StructureRampart>>,
): StructureRampart | null {
  let best: StructureRampart | null = null;
  let bestRange = Infinity;
  const anchor = front ? new RoomPosition(front.centroid.x, front.centroid.y, ramparts[0]?.pos.roomName || "") : null;

  for (const rampart of ramparts) {
    if (occupiedRampartIds.has(rampart.id)) {
      continue;
    }

    if (!anchor) {
      return rampart;
    }

    const range = rampart.pos.getRangeTo(anchor);
    if (range < bestRange) {
      bestRange = range;
      best = rampart;
    }
  }

  return best;
}

function chooseAdjacentAttackTarget(creep: Creep, hostiles: Creep[]): Creep | null {
  const adjacentHostiles = hostiles.filter((hostile) => creep.pos.getRangeTo(hostile.pos) <= 1);
  return chooseInsideBurstTarget(adjacentHostiles);
}

export const homeDefenderRole: RoleFactory = (roomName: string, slot?: string) => ({
  target: (creep): boolean => {
    if (creep.room.name !== roomName) {
      moveToTargetRoom(creep, roomName);
      return false;
    }

    const safeZone = getSafeZone(roomName);
    if (safeZone.size === 0) return false;

    const allHostiles = measureCreepDecision(() => getPlayerHostiles(creep.room));
    const assignedFront = getAssignedDefenseFront(roomName, slot) || getTowerFocusFront(roomName);
    const defenderRole = getDefenderRole(roomName, slot);
    // 【Defense Focus-Fire Sidecar 消费侧】本 tick 的房间 plan 给本槽位分配了
    // 联合集火目标时，以该目标为唯一作战对象（与 Tower 共享同一伤害预算）；
    // 分配目标已失效（不在 hostiles 中）→ 本 tick 空转等待重规划（不回退
    // 独立评分——避免与 Tower 再度分裂火力）。
    const plannedTargetId = slot !== undefined ? readRoomEngagementPlan(roomName)?.defenderAssignments?.[slot] : undefined;
    const hostiles = plannedTargetId !== undefined
      ? allHostiles.filter((hostile) => hostile.id === plannedTargetId)
      : assignedFront
        ? allHostiles.filter((hostile) => assignedFront.hostileIds.includes(hostile.id))
        : allHostiles;
    if (hostiles.length === 0) return false;

    const safeZoneCostCallback = createSafeZoneCostCallback(safeZone);

    const insideHostiles = measureCreepDecision(() =>
      hostiles.filter((h) => safeZone.has(h.pos.x * 50 + h.pos.y)),
    );
    if (insideHostiles.length > 0) {
      const engagedHostileId = defenderRole === "secondary"
        ? measureCreepDecision(() => findEngagedHostileIdByOtherDefenders(creep, insideHostiles))
        : null;
      const targetPool = engagedHostileId ? insideHostiles.filter((hostile) => hostile.id !== engagedHostileId) : insideHostiles;
      const target = measureCreepDecision(() => chooseInsideBurstTarget(targetPool.length > 0 ? targetPool : insideHostiles));
      if (!target) return false;
      if (creep.pos.getRangeTo(target) <= 1) {
        measureCreepIntent(() => creep.attack(target));
      } else {
        moveToTarget(creep, target, 1, {
          costCallback: safeZoneCostCallback,
          cacheKey: `safezone:${roomName}`,
          maxRooms: 1,
          reusePath: 2,
        });
      }
      return false;
    }

    // Hostiles are outside the perimeter — position at the boundary rampart closest to them
    const ramparts = measureCreepDecision(() => getBoundaryRamparts(creep.room, safeZone));
    if (ramparts.length === 0) return false;

    const occupiedRampartIds = measureCreepDecision(() => {
      const occupied = new Set<Id<StructureRampart>>();
      for (const other of creep.room.find(FIND_MY_CREEPS)) {
        if (other.name === creep.name || other.memory.role !== "homeDefender") {
          continue;
        }

        const structures = other.pos.lookFor(LOOK_STRUCTURES);
        for (const structure of structures) {
          if (structure.structureType === STRUCTURE_RAMPART && (structure as StructureRampart).my) {
            occupied.add(structure.id as Id<StructureRampart>);
          }
        }
      }
      return occupied;
    });

    const engagedHostileId = defenderRole === "secondary"
      ? measureCreepDecision(() => findEngagedHostileIdByOtherDefenders(creep, hostiles))
      : null;
    const targetHostiles = engagedHostileId ? hostiles.filter((hostile) => hostile.id !== engagedHostileId) : hostiles;
    const engagement = measureCreepDecision(() =>
      chooseBoundaryBurstEngagement(targetHostiles.length > 0 ? targetHostiles : hostiles, ramparts, occupiedRampartIds),
    );
    if (!engagement) return false;

    const { hostile, rampart: targetRampart } = engagement;

    if (defenderRole === "secondary" && targetHostiles.length === 0) {
      const coverageRampart = measureCreepDecision(() =>
        findNearestUnoccupiedRampartToFront(assignedFront, ramparts, occupiedRampartIds),
      );
      if (coverageRampart && !creep.pos.isEqualTo(coverageRampart.pos)) {
        moveToTarget(creep, coverageRampart.pos, 0, {
          costCallback: safeZoneCostCallback,
          cacheKey: `safezone:${roomName}`,
          maxRooms: 1,
          reusePath: 3,
        });
        return false;
      }
    }

    if (!creep.pos.isEqualTo(targetRampart.pos)) {
      moveToTarget(creep, targetRampart.pos, 0, {
        costCallback: safeZoneCostCallback,
        cacheKey: `safezone:${roomName}`,
        maxRooms: 1,
        reusePath: 3,
      });
    }

    const attackTarget = creep.pos.getRangeTo(hostile.pos) <= 1
      ? hostile
      : measureCreepDecision(() => chooseAdjacentAttackTarget(creep, allHostiles));
    if (attackTarget) {
      measureCreepIntent(() => creep.attack(attackTarget));
    }

    return false;
  },
});
