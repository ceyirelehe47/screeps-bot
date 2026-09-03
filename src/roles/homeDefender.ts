import { getSafeZone } from "@/runtime/safeZone";
import { measureCreepDecision, measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { getAssignedDefenseFront, getDefenderRole, getTowerFocusFront, type DefenseFrontSummary } from "@/runtime/defenseCoordination";
import { getPlayerHostiles } from "@/runtime/defenseMode";
import { chooseBoundaryBurstEngagement, chooseInsideBurstTarget } from "@/runtime/hostilePriorities";
import { createSafeZoneCostCallback, getBoundaryRamparts } from "@/runtime/safeZoneHelpers";
import {
  defenderEngagementMode,
  readRoomEngagementPlan,
  resolveRoomEngagementFallbackTarget,
} from "@/runtime/defenseFocusFire";
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
    const safeZoneCostCallback = createSafeZoneCostCallback(safeZone);
    // 【Defense Focus-Fire Sidecar 消费侧 + Remediation II G / III 十六/十七】
    // 本 tick 的房间 plan 给本槽位分配了联合集火目标时，以该目标为唯一作战
    // 对象——显式 assignment 优先，旧的 secondary 去重 / coverage rampart /
    // 独立评分不得把它改到另一目标。执行语义与 planner 的
    // defenderEngagementMode 单一语义源一致：贴身 attack()；纯远程（无
    // ATTACK 部件）≤3 距离 rangedAttack()（planner 才计入该伤害）；
    // approach 时 combat target 与接敌位置分离——敌在安全区内（inside）
    // 直接接敌；敌在边界外（boundary）前往合法 rampart 站位（不离开防线
    // 追逐共享目标）。分配目标失效 → 房间级一次性共享 live fallback（与
    // Tower 消费同一结果）；无合法 fallback 才本 tick 空转等待重规划。
    const engagementPlan = slot !== undefined ? readRoomEngagementPlan(roomName) : null;
    const plannedEngagement = slot !== undefined ? engagementPlan?.defenderEngagements?.[slot] : undefined;
    let plannedTargetId: string | undefined = plannedEngagement?.targetId ?? (slot !== undefined ? engagementPlan?.defenderAssignments?.[slot] : undefined);
    if (plannedTargetId !== undefined) {
      let plannedTarget = allHostiles.find((hostile) => hostile.id === plannedTargetId);
      let engagementPosition = plannedEngagement?.positionKind !== undefined && plannedTarget
        ? { x: plannedEngagement.position!.x, y: plannedEngagement.position!.y, kind: plannedEngagement.positionKind }
        : plannedTarget && engagementPlan?.engagementByTargetId?.[plannedTarget.id];
      if (!plannedTarget) {
        // 【Remediation III 十七】目标失效：房间级共享 fallback（每房间每
        // tick 至多一次解析；Tower 与 Defender 消费同一缓存结果）。
        const fallback = resolveRoomEngagementFallbackTarget(
          roomName,
          plannedTargetId,
          new Set(allHostiles.map((hostile) => hostile.id as string)),
        );
        if (fallback.targetId !== null) {
          plannedTargetId = fallback.targetId;
          plannedTarget = allHostiles.find((hostile) => hostile.id === plannedTargetId);
          engagementPosition = plannedTarget ? engagementPlan?.engagementByTargetId?.[plannedTarget.id] : undefined;
        }
      }
      if (plannedTargetId !== undefined && !plannedTarget) return false;
      if (plannedTarget) {
        const meleeDamage = creep.getActiveBodyparts(ATTACK) * ATTACK_POWER;
        const rangedDamage = creep.getActiveBodyparts(RANGED_ATTACK) * RANGED_ATTACK_POWER;
        const mode = defenderEngagementMode(
          { x: creep.pos.x, y: creep.pos.y, meleeDamage, rangedDamage },
          { x: plannedTarget.pos.x, y: plannedTarget.pos.y },
        );
        if (mode === "attack") {
          measureCreepIntent(() => creep.attack(plannedTarget!));
        } else if (mode === "ranged_attack") {
          measureCreepIntent(() => creep.rangedAttack(plannedTarget!));
        } else if (engagementPosition?.kind === "boundary") {
          // 【十六.3】敌在边界外：前往合法 rampart 站位（既有防线系统给出
          // 的接敌位置——不为追共享目标绕过 Rampart/离开 safe-zone）。
          const position =
            (typeof creep.room.getPositionAt === "function"
              ? creep.room.getPositionAt(engagementPosition.x, engagementPosition.y)
              : undefined) ?? ({ x: engagementPosition.x, y: engagementPosition.y, roomName } as unknown as RoomPosition);
          moveToTarget(creep, position, 0, {
            costCallback: safeZoneCostCallback,
            cacheKey: `safezone:${roomName}`,
            maxRooms: 1,
            reusePath: 3,
          });
        } else {
          // inside（或无站位信息）：直接接敌符合既有规则。
          moveToTarget(creep, plannedTarget, 1, {
            costCallback: safeZoneCostCallback,
            cacheKey: `safezone:${roomName}`,
            maxRooms: 1,
            reusePath: 2,
          });
        }
        return false;
      }
    }

    const hostiles = assignedFront
      ? allHostiles.filter((hostile) => assignedFront.hostileIds.includes(hostile.id))
      : allHostiles;
    if (hostiles.length === 0) return false;

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
