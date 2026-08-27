import { ensureCreepMovementState, getCreepMovementState } from "@/movement/creepState";
import { recordMovementMetric } from "@/movement/metrics";
import { getTickContextService } from "@/runtime/runtimeServices";
import {
  getPositionAtDirection,
  isExitTile,
  isStandardCreep,
  isWalkableConstructionSite,
  isWalkableStructure,
} from "@/movement/common";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";

const ALL_DIRECTIONS: DirectionConstant[] = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT];

// ─── Lookup helpers ───────────────────────────────────────────────────────────

export function findMyCreepAt(pos: RoomPosition, excludeName?: string): Creep | null {
  const roomContext = getTickContextService().getRoomContext(pos.roomName);
  const myCreeps = roomContext?.getMyCreeps() || [];
  return myCreeps.find((c) => c.name !== excludeName && c.pos.x === pos.x && c.pos.y === pos.y) || null;
}

export function findMyOwnedUnitAt(pos: RoomPosition, exclude?: AnyCreep): AnyCreep | null {
  const roomContext = getTickContextService().getRoomContext(pos.roomName);
  const myCreeps = roomContext?.getMyCreeps() || [];
  const creep = myCreeps.find(
    (candidate) => candidate !== exclude && candidate.pos.x === pos.x && candidate.pos.y === pos.y,
  );
  if (creep) {
    return creep;
  }

  return Object.values(Game.powerCreeps || {}).find(
    (candidate) => candidate !== exclude &&
      candidate.ticksToLive != null &&
      candidate.room?.name === pos.roomName &&
      candidate.pos.x === pos.x &&
      candidate.pos.y === pos.y,
  ) || null;
}

// ─── Push ─────────────────────────────────────────────────────────────────────

export function isBlockerActivelyMoving(blocker: AnyCreep): boolean {
  const state = getCreepMovementState(blocker);
  if (!state) {
    return false;
  }
  // A creep with an active path/travel state is still on its own route even if
  // it has not executed yet this tick. Do not let earlier creeps in iteration
  // order push it away and create yield loops; idle roles must clear movement
  // state when they intentionally stop.
  if (state.pathingRequestedAt === Game.time) {
    return true;
  }
  if (state.movePathState && state.movePathState.expiresAt > Game.time) {
    return true;
  }
  if (state.travelState && state.travelState.targetRoom !== blocker.room?.name) {
    return true;
  }
  return false;
}

/**
 * Pushes a stationary blocker to a nearby free tile.
 * Returns true if the blocker was successfully moved.
 */
export function pushBlockingCreep(pusher: AnyCreep, blocker: AnyCreep): boolean {
  for (const candidate of getYieldCandidatePositions(pusher, blocker)) {
    const occupant = findMyOwnedUnitAt(candidate, blocker);
    if (occupant && occupant !== pusher) {
      continue;
    }
    if (moveBlockerToYieldPosition(pusher, blocker, candidate)) {
      return true;
    }
  }
  return false;
}

export function moveToAdjacentPosition(creep: AnyCreep, nextPos: RoomPosition): ScreepsReturnCode {
  if (creep.pos.getRangeTo(nextPos) > 1) {
    return ERR_NO_PATH;
  }

  const direction = creep.pos.getDirectionTo(nextPos);
  const blockingCreep = findMyOwnedUnitAt(nextPos, creep);
  if (!blockingCreep) {
    return issueMove(creep, direction);
  }

  if (isHeadOnWarDuoSwap(creep, blockingCreep)) {
    if (pushBlockingCreep(creep, blockingCreep)) {
      return issueMove(creep, direction);
    }
    return ERR_BUSY;
  }

  if (isBlockerActivelyMoving(blockingCreep)) {
    return issueMove(creep, direction);
  }

  if (pushBlockingCreep(creep, blockingCreep)) {
    return issueMove(creep, direction);
  }

  return ERR_BUSY;
}

function issueMove(creep: AnyCreep, direction: DirectionConstant): CreepMoveReturnCode {
  if (isStandardCreep(creep)) {
    return measureCreepIntent(() => creep.move(direction));
  }
  return creep.move(direction);
}

function isHeadOnWarDuoSwap(attacker: AnyCreep, healer: AnyCreep): boolean {
  if (!isStandardCreep(attacker) || !isStandardCreep(healer)) return false;
  if (attacker.memory.role !== "meleeAttacker" || healer.memory.role !== "healer") return false;
  if (attacker.memory._warDetached === true || healer.memory._warDetached === true) return false;

  const attackerConfig = attacker.memory.configName;
  const healerConfig = healer.memory.configName;
  if (!attackerConfig?.includes(":war:") || !attackerConfig.includes(":meleeAttacker:")) return false;
  if (!healerConfig?.includes(":war:") || !healerConfig.includes(":healer:")) return false;
  if (attacker.memory._warPartnerConfigName !== healerConfig) return false;
  if (healer.memory._warPartnerConfigName !== attackerConfig) return false;

  const nextStep = getPlannedNextStep(healer);
  return nextStep?.x === attacker.pos.x && nextStep.y === attacker.pos.y;
}

function getPlannedNextStep(creep: AnyCreep): { x: number; y: number } | null {
  const movePathState = getCreepMovementState(creep)?.movePathState;
  const steps = movePathState?.steps;
  if (!steps || steps.length === 0) return null;

  // 与 pathing.getNextStoredPathStep 相同的游标策略：正常前进只查 cursor 窗口。
  const cursor = Number.isInteger(movePathState.cursor) ? (movePathState.cursor as number) : -1;
  const windowEnd = Math.min(steps.length, cursor + 3);
  for (let index = Math.max(0, cursor); index < windowEnd; index += 1) {
    const step = steps[index];
    if (step.x === creep.pos.x && step.y === creep.pos.y) return steps[index + 1] ?? null;
  }

  const exactIndex = steps.findIndex((step) => step.x === creep.pos.x && step.y === creep.pos.y);
  if (exactIndex >= 0) return steps[exactIndex + 1] ?? null;

  let closest: { x: number; y: number } | null = null;
  let closestRange = Infinity;
  for (const step of steps) {
    const range = Math.max(Math.abs(creep.pos.x - step.x), Math.abs(creep.pos.y - step.y));
    if (range >= closestRange) continue;
    closest = step;
    closestRange = range;
  }

  return closestRange <= 1 ? closest : null;
}

function moveBlockerToYieldPosition(pusher: AnyCreep, blocker: AnyCreep, yieldPos: RoomPosition): boolean {
  const moveCode = issueMove(blocker, blocker.pos.getDirectionTo(yieldPos));
  if (moveCode !== OK) {
    return false;
  }

  const blockerState = ensureCreepMovementState(blocker);
  delete blockerState.movePathState;
  blockerState.movementPushedAt = Game.time;
  recordMovementMetric("yieldPushes", pusher.room?.name);
  return true;
}

// ─── Yield position selection ─────────────────────────────────────────────────

function getYieldCandidatePositions(pusher: AnyCreep, blocker: AnyCreep): RoomPosition[] {
  const candidates: Array<{ pos: RoomPosition; score: number }> = [];
  const haulerPair = isPowerBankHauler(pusher) && isPowerBankHauler(blocker);

  for (const direction of ALL_DIRECTIONS) {
    const pos = getPositionAtDirection(blocker.pos, direction);
    if (!pos || !isYieldTileWalkable(pos, blocker)) {
      continue;
    }
    if (haulerPair && pos.x === pusher.pos.x && pos.y === pusher.pos.y) {
      continue;
    }
    let score = scoreYieldPosition(pos, blocker, pusher);
    const occupant = findMyOwnedUnitAt(pos, blocker);
    if (occupant && occupant !== pusher) {
      score -= 15;
    }
    candidates.push({ pos, score });
  }

  return candidates.sort((a, b) => b.score - a.score).map((e) => e.pos);
}

function isPowerBankHauler(creep: AnyCreep): boolean {
  return isStandardCreep(creep) && creep.memory.role === "powerBankHauler";
}

function scoreYieldPosition(pos: RoomPosition, blocker: AnyCreep, pusher: AnyCreep): number {
  let score = 0;

  if (pos.x === pusher.pos.x && pos.y === pusher.pos.y) {
    score += 20;
  }

  if (!isExitTile(pos)) {
    score += 4;
  }

  const terrain = Game.map.getRoomTerrain(pos.roomName).get(pos.x, pos.y);
  score += terrain === TERRAIN_MASK_SWAMP ? -2 : 1;

  // Stationary creeps with a work anchor should stay close to it.
  const workAnchor = getCreepMovementState(blocker)?.workAnchor;
  if (workAnchor && workAnchor.roomName === pos.roomName) {
    const anchorPos = new RoomPosition(workAnchor.x, workAnchor.y, workAnchor.roomName);
    const dist = pos.getRangeTo(anchorPos);
    if (dist <= workAnchor.range) {
      // Strongly prefer staying within work range — this dominates swap and terrain bonuses.
      score += 30;
    } else {
      score -= dist;
    }
  }

  return score;
}

function isYieldTileWalkable(pos: RoomPosition, blocker: AnyCreep): boolean {
  const blockerRoom = blocker.room;
  if (!blockerRoom || pos.roomName !== blockerRoom.name) {
    return false;
  }
  if (Game.map.getRoomTerrain(pos.roomName).get(pos.x, pos.y) === TERRAIN_MASK_WALL) {
    return false;
  }

  const roomContext = getTickContextService().getRoomContext(blockerRoom);
  if (!roomContext) {
    return false;
  }

  for (const structure of roomContext.getStructures()) {
    if (structure.pos.x === pos.x && structure.pos.y === pos.y && !isWalkableStructure(structure)) {
      return false;
    }
  }

  for (const site of roomContext.getConstructionSites()) {
    if (site.pos.x === pos.x && site.pos.y === pos.y && site.my && !isWalkableConstructionSite(site)) {
      return false;
    }
  }

  return true;
}

// ─── Exit recovery ────────────────────────────────────────────────────────────

export function moveOffExit(creep: AnyCreep, avoidSwamp = true): ScreepsReturnCode {
  let swampDirection: DirectionConstant | undefined;

  for (const direction of [TOP, RIGHT, BOTTOM, LEFT, TOP_RIGHT, BOTTOM_RIGHT, BOTTOM_LEFT, TOP_LEFT] as DirectionConstant[]) {
    const pos = getPositionAtDirection(creep.pos, direction);
    if (!pos || isExitTile(pos) || !isYieldTileWalkable(pos, creep)) {
      continue;
    }
    if (findMyOwnedUnitAt(pos, creep)) {
      continue;
    }

    const terrain = Game.map.getRoomTerrain(pos.roomName).get(pos.x, pos.y);
    if (avoidSwamp && terrain === TERRAIN_MASK_SWAMP) {
      swampDirection = direction;
      continue;
    }

    return issueMove(creep, direction);
  }

  if (swampDirection) {
    return issueMove(creep, swampDirection);
  }

  return ERR_NO_PATH;
}
