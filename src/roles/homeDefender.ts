import { getSafeZone } from "@/runtime/safeZone";
import { measureCreepDecision, measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { getAssignedDefenseFront, getDefenderRole, getTowerFocusFront, type DefenseFrontSummary } from "@/runtime/defenseCoordination";
import { getPlayerHostiles } from "@/runtime/defenseMode";
import { chooseBoundaryBurstEngagement, chooseInsideBurstTarget } from "@/runtime/hostilePriorities";
import { createSafeZoneCostCallback, getBoundaryRamparts } from "@/runtime/safeZoneHelpers";
import {
  defenderEngagementMode,
  readRoomEngagementPlan,
  type FocusFireDefenderEngagement,
} from "@/runtime/defenseFocusFire";
import { resolveRoomEngagementFallbackRevision } from "@/runtime/engagementFallbackRevision";
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
    // 【Defense Focus-Fire Sidecar 消费侧 + Remediation II G / III 十六/十七 +
    // IV 十七】本 tick 的 fresh plan 是唯一权威：本槽位在 defenderEngagements
    // 中（含显式 hold / targetId=null）即完全由 plan 决定——attack/
    // ranged_attack/engage_position/hold 都不回退旧独立评分。执行语义与
    // planner 的 defenderEngagementMode 单一语义源一致：贴身 attack()；纯
    // 远程（无 ATTACK 部件）≤3 距离 rangedAttack()（planner 才计入该伤害）；
    // approach 时 combat target 与接敌位置分离——敌在安全区内（inside）
    // 直接接敌；敌在边界外（boundary）前往 per-defender 唯一 rampart 站位
    //（不离开防线追逐共享目标）。分配目标失效 → 房间级一次性 fallback
    // revision（与 Tower 消费同一修订计划——front 约束与 per-defender 位置
    // 保留）；无 front-local 替代时本 tick hold（不跨 front、不回退独立
    // 评分）。slot 不在 plan 的 defenderEngagements 中 = planner 明确未让
    // 该 actor 参与（如 slot 推导失败）——保留既有独立行为。
    const engagementPlan = slot !== undefined ? readRoomEngagementPlan(roomName) : null;
    const plannedEngagement: FocusFireDefenderEngagement | undefined =
      slot !== undefined ? engagementPlan?.defenderEngagements?.[slot] : undefined;
    if (plannedEngagement !== undefined && engagementPlan !== null) {
      let plannedTargetId: string | null | undefined = plannedEngagement.targetId;
      let engagementPosition =
        plannedEngagement.positionKind !== undefined && plannedEngagement.position !== undefined
          ? { x: plannedEngagement.position.x, y: plannedEngagement.position.y, kind: plannedEngagement.positionKind }
          : undefined;
      let engagementMode = plannedEngagement.mode;
      let plannedTarget = plannedTargetId !== null && plannedTargetId !== undefined
        ? allHostiles.find((hostile) => hostile.id === plannedTargetId)
        : undefined;
      if (plannedTargetId !== null && plannedTargetId !== undefined && !plannedTarget) {
        // 【Remediation IV 十六】目标失效：房间级一次性 fallback revision
        //（每房间每 tick 至多一次生成；Tower 与 Defender 消费同一修订）。
        const { revision } = resolveRoomEngagementFallbackRevision(
          roomName,
          [plannedTargetId],
          new Set(allHostiles.map((hostile) => hostile.id as string)),
        );
        const revised = slot !== undefined ? revision?.defenderEngagementBySlot?.[slot] : undefined;
        if (revision !== null && revised !== undefined) {
          plannedTargetId = revised.targetId;
          engagementMode = revised.targetId !== null ? engagementMode : "hold";
          plannedTarget = plannedTargetId !== null ? allHostiles.find((hostile) => hostile.id === plannedTargetId) : undefined;
          engagementPosition =
            revised.targetId !== null && revised.position !== undefined && revised.positionKind !== undefined
              ? { x: revised.position.x, y: revised.position.y, kind: revised.positionKind }
              : plannedTarget !== undefined && plannedTargetId !== null
                ? engagementPlan.engagementByTargetId?.[plannedTargetId]
                : undefined;
        }
      }
      if (plannedTargetId !== null && plannedTargetId !== undefined && !plannedTarget) return false;
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
          // 【十六.3】敌在边界外：前往合法 rampart 站位（per-defender 唯一
          // 位置——不为追共享目标绕过 Rampart/离开 safe-zone）。
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
      // 【Remediation IV 十七】plan 显式 hold（或 fallback 无 front-local
      // 替代）：本 tick 保持——不回退独立评分、不跨 front 增援。
      if (engagementMode === "hold") return false;
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
