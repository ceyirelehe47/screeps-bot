import { getRefillableHostileTowers } from "@/runtime/combatTowerThreat";
import { warPartner } from "@/roles/warPartner";
import { clearMovementState, moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { prepareCombatBoost } from "@/roles/combatBoosts";
import { runTowerDrainPair } from "@/roles/towerDrainPair";
import {
  followMovingWarAttacker,
  isWarCounterstrikeCoordinationValid,
  shouldWarHealerHoldForCounterstrike,
} from "@/roles/meleeAttacker";
import { moveOffExit } from "@/movement/traffic";
import { measureCreepDecision, measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import type { RoleFactory } from "@/types/system";

const TRAVEL_OPTIONS = { plainCost: 2, swampCost: 8, routePurpose: "combat" } as const;
const TARGET_ROOM_MOVE_OPTIONS = {
  plainCost: 2,
  swampCost: 8,
  reusePath: 0,
  maxRooms: 1,
  avoidExitTiles: true,
  ignoreCreeps: false,
} as const;

function findPairedWarAttacker(creep: Creep): Creep | null { return warPartner(creep, "meleeAttacker") ?? null; }

function expectsWarAttacker(creep: Creep): boolean {
  return creep.memory._warDetached !== true
    && typeof creep.memory._warPartnerConfigName === "string"
    && creep.memory._warPartnerConfigName.length > 0;
}

function synchronizeWarPartnerConfigName(creep: Creep, partnerConfigName?: string): void {
  if (partnerConfigName && creep.memory._warDetached !== true) {
    creep.memory._warPartnerConfigName = partnerConfigName;
    return;
  }
  delete creep.memory._warPartnerConfigName;
}

function isOnExitDirection(pos: RoomPosition, direction: DirectionConstant): boolean {
  if (direction === TOP) return pos.y <= 0;
  if (direction === RIGHT) return pos.x >= 49;
  if (direction === BOTTOM) return pos.y >= 49;
  if (direction === LEFT) return pos.x <= 0;
  return false;
}

function isOnRoomExit(pos: RoomPosition): boolean {
  return pos.x <= 0 || pos.x >= 49 || pos.y <= 0 || pos.y >= 49;
}

function moveOffExitIntoRoom(creep: Creep): boolean {
  if (!isOnRoomExit(creep.pos)) return false;
  moveOffExit(creep);
  return true;
}

function moveToPartnerRoom(creep: Creep, roomName: string): void {
  const exitDirection = creep.room.findExitTo?.(roomName);
  if (
    typeof exitDirection === "number" &&
    exitDirection >= TOP &&
    exitDirection <= LEFT &&
    isOnExitDirection(creep.pos, exitDirection as DirectionConstant)
  ) {
    measureCreepIntent(() => creep.move(exitDirection as DirectionConstant));
    return;
  }

  moveToTargetRoom(creep, roomName, undefined, TRAVEL_OPTIONS);
}

function isPoisedToCrossInto(creep: Creep, targetRoom: string): boolean {
  if (creep.room.name === targetRoom) return false;

  const exitDirection = creep.room.findExitTo?.(targetRoom);
  if (typeof exitDirection !== "number" || exitDirection < TOP || exitDirection > LEFT) return false;

  return isOnExitDirection(creep.pos, exitDirection as DirectionConstant);
}

function getValidExitDirection(room: Room, targetRoom: string): DirectionConstant | null {
  const exitDirection = room.findExitTo?.(targetRoom);
  if (typeof exitDirection !== "number" || exitDirection < TOP || exitDirection > LEFT) return null;

  return exitDirection as DirectionConstant;
}

function shouldHoldForAttackerAtExit(creep: Creep, attacker: Creep, targetRoom: string): boolean {
  const exitDirection = getValidExitDirection(creep.room, targetRoom);
  if (!exitDirection) return false;

  return isOnExitDirection(creep.pos, exitDirection) && !isOnExitDirection(attacker.pos, exitDirection);
}

function healAttacker(creep: Creep, attacker: Creep): void {
  const shouldHealSelf =
    creep.hits < creep.hitsMax &&
    (attacker.room.name !== creep.room.name ||
      attacker.hits >= attacker.hitsMax ||
      creep.hits * attacker.hitsMax <= attacker.hits * creep.hitsMax);
  if (shouldHealSelf) {
    measureCreepIntent(() => creep.heal(creep));
    return;
  }

  if (attacker.room.name !== creep.room.name) {
    return;
  }

  const range = creep.pos.getRangeTo(attacker.pos);
  if (range <= 1) {
    measureCreepIntent(() => creep.heal(attacker));
  } else if (range <= 3) {
    measureCreepIntent(() => creep.rangedHeal(attacker));
  }
}

function coordinateCounterstrike(creep: Creep, attacker: Creep): boolean {
  const state = attacker.memory._warCounterstrike;
  if (!state?.healerCoordinated) return false;
  const elapsed = Game.time - state.createdAt;
  if (elapsed < 0 || elapsed > 2) return false;
  if (!isWarCounterstrikeCoordinationValid(attacker, creep, state)) {
    delete attacker.memory._warCounterstrike;
    return false;
  }
  if (elapsed === 0) return true;
  if (elapsed === 1) {
    state.healerReadyAt = Game.time;
    return true;
  }
  if (state.healerReadyAt !== state.createdAt + 1) {
    delete attacker.memory._warCounterstrike;
    return false;
  }
  if (!state.healerSwap) return true;

  const direction = creep.pos.getDirectionTo(attacker.pos);
  if (!direction) return false;
  clearMovementState(creep);
  measureCreepIntent(() => creep.move(direction));
  return true;
}

function moveWithWarAttackerFormation(creep: Creep, targetRoom: string, encodedRouteRooms?: string, towerDrain = false): boolean {
  if (!expectsWarAttacker(creep)) return false;

  const attacker = findPairedWarAttacker(creep);
  if (!attacker) return true;

  healAttacker(creep, attacker);
  if (!towerDrain && coordinateCounterstrike(creep, attacker)) return true;
  if (!towerDrain && shouldWarHealerHoldForCounterstrike(attacker, creep, targetRoom)) return true;

  if (creep.room.name === targetRoom && attacker.room.name !== targetRoom) {
    if (isPoisedToCrossInto(attacker, targetRoom)) {
      moveOffExitIntoRoom(creep);
      return true;
    }
    moveToPartnerRoom(creep, attacker.room.name);
    return true;
  }

  if (creep.room.name === targetRoom && attacker.room.name === targetRoom && isOnRoomExit(creep.pos)) {
    if (towerDrain) followMovingWarAttacker(creep, attacker);
    else moveOffExit(creep);
    return true;
  }

  if (attacker.room.name !== creep.room.name) {
    moveToPartnerRoom(creep, attacker.room.name);
    return true;
  }

  if (!creep.pos.isNearTo(attacker.pos)) {
    moveToTarget(creep, attacker, 1, { ...TARGET_ROOM_MOVE_OPTIONS, reusePath: !towerDrain && getRefillableHostileTowers(creep.room).length === 0 ? 3 : 0 });
    return true;
  }

  if (creep.room.name !== targetRoom) {
    if (shouldHoldForAttackerAtExit(creep, attacker, targetRoom)) return true;
    moveToTargetRoom(creep, targetRoom, encodedRouteRooms, TRAVEL_OPTIONS);
    return true;
  }

  followMovingWarAttacker(creep, attacker);
  return true;
}

function getEscortTarget(creep: Creep, targetRoom?: string): Creep | null {
  const pairedAttacker = findPairedWarAttacker(creep);
  if (pairedAttacker && (!targetRoom || pairedAttacker.room.name === targetRoom)) {
    return pairedAttacker;
  }

  if (creep.memory.configName?.includes(":war:") && creep.memory._warDetached !== true) {
    return null;
  }

  const friendlies = creep.room.find(FIND_MY_CREEPS, {
    filter: (ally) => ally.name !== creep.name && ally.memory.role === "meleeAttacker",
  });
  if (friendlies.length === 0) {
    return null;
  }

  const inTargetRoom = targetRoom ? friendlies.filter((ally) => ally.room.name === targetRoom) : friendlies;
  if (inTargetRoom.length > 0) {
    const damaged = inTargetRoom.filter((ally) => ally.hits < ally.hitsMax);
    if (damaged.length > 0) {
      return creep.pos.findClosestByRange(damaged);
    }

    return creep.pos.findClosestByRange(inTargetRoom);
  }

  return creep.pos.findClosestByRange(friendlies);
}

export const healerRole: RoleFactory = (
  targetRoom?: string,
  encodedRouteRooms?: string,
  boostTaskId?: string,
  encodedBoostCompounds?: string,
  partnerConfigName?: string,
  tactic?: string,
) => ({
  prepare: (creep): boolean => {
    synchronizeWarPartnerConfigName(creep, partnerConfigName);
    return prepareCombatBoost(creep, boostTaskId, encodedBoostCompounds);
  },
  source: (creep): boolean => {
    synchronizeWarPartnerConfigName(creep, partnerConfigName);
    if ((tactic === "towerDrainDuo" || tactic === "t3TowerDrainDuo") && targetRoom && runTowerDrainPair(creep, targetRoom, partnerConfigName ?? "", tactic === "t3TowerDrainDuo")) return false;
    if (targetRoom && moveWithWarAttackerFormation(creep, targetRoom, encodedRouteRooms, (tactic === "towerDrainDuo" || tactic === "t3TowerDrainDuo"))) return false;

    if (targetRoom && creep.room.name !== targetRoom) {
      moveToTargetRoom(creep, targetRoom, encodedRouteRooms, TRAVEL_OPTIONS);
      return false;
    }

    return true;
  },
  target: (creep): boolean => {
    synchronizeWarPartnerConfigName(creep, partnerConfigName);
    if ((tactic === "towerDrainDuo" || tactic === "t3TowerDrainDuo") && targetRoom && runTowerDrainPair(creep, targetRoom, partnerConfigName ?? "", tactic === "t3TowerDrainDuo")) return false;
    if (targetRoom && moveWithWarAttackerFormation(creep, targetRoom, encodedRouteRooms, (tactic === "towerDrainDuo" || tactic === "t3TowerDrainDuo"))) return false;

    if (targetRoom && creep.room.name !== targetRoom) {
      moveToTargetRoom(creep, targetRoom, encodedRouteRooms, TRAVEL_OPTIONS);
      return false;
    }

    let healed = false;
    const escortTarget = measureCreepDecision(() => getEscortTarget(creep, targetRoom));
    if (escortTarget) {
      if (escortTarget.hits < escortTarget.hitsMax) {
        const healCode = measureCreepIntent(() => creep.heal(escortTarget));
        healed = healCode === OK;
        if (healCode === ERR_NOT_IN_RANGE) {
          healed = measureCreepIntent(() => creep.rangedHeal(escortTarget)) === OK;
          moveToTarget(creep, escortTarget, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
        }
      } else if (!creep.pos.isNearTo(escortTarget)) {
        moveToTarget(creep, escortTarget, 1, { plainCost: 2, swampCost: 8, reusePath: 3, maxRooms: 1 });
      }
    }

    if (!healed && creep.hits < creep.hitsMax) {
      measureCreepIntent(() => creep.heal(creep));
    }

    return false;
  },
});
