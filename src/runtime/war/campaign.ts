import { getRefillableHostileTowers } from "@/runtime/combatTowerThreat";
import { isRebuildStructureRelevant } from "@/runtime/warRebuildScope";
import { defaultWarMapRoute, getHostilePresence, hasControllerAttackBlockers, isControllerDefeated } from "./observation";
import { getSquadPolicy } from "./squadPolicy";
import { isPatrolTask, type WarFieldStrength, type WarGenerationState, type WarOrder, type WarReview, type WarTask } from "./store";

export function chooseWarOrder(task: WarTask, room: Room | undefined): WarOrder {
  if (!room) return "observe";
  if (getSquadPolicy(task).allowsControllerAttack && task.reason === "manual" && !isPatrolTask(task)
      && !hasControllerAttackBlockers(room)) {
    if (isControllerDefeated(room)) return "confirm";
    if (room.controller?.owner && room.controller.level > 0) return "suppress";
  }
  return getHostilePresence(room, task).present ? "engage" : "confirm";
}

export function selectAutomaticTactic(task: WarTask, room: Room): void {
  if (!task.autoTactic || task.squad !== "t3Duo") return;
  // 耗塔队跨出目标房恢复时仍需保留原战术，直到该代结束。
  if (task.activeGeneration?.phase === "deployed") return;
  const drain = getRefillableHostileTowers(room).length > 0;
  task.tactic = drain ? "t3TowerDrainDuo" : undefined;
  task.squadDecision = drain ? "armed_tower" : "assault_no_tower_threat";
}

function fieldStrength(task: WarTask, room: Room): WarFieldStrength {
  const field = { structures: 0, hits: 0, towerEnergy: 0 };
  for (const structure of room.find(FIND_STRUCTURES)) {
    if (!("owner" in structure) && structure.structureType !== STRUCTURE_WALL) continue;
    if ((structure as OwnedStructure).my || !structure.hitsMax || structure.structureType === STRUCTURE_CONTROLLER
        || structure.structureType === STRUCTURE_KEEPER_LAIR || !isRebuildStructureRelevant(structure, task.rebuildIgnoreStructureIds)) continue;
    field.structures++;
    field.hits += structure.hits;
    if (structure.structureType === STRUCTURE_TOWER) field.towerEnergy += (structure as StructureTower).store.getUsedCapacity(RESOURCE_ENERGY);
  }
  return field;
}

const FIELD_SAMPLE_INTERVAL = 10;

export function observeGeneration(task: WarTask, generation: WarGenerationState): void {
  const room = Game.rooms[task.targetRoom];
  if (!room || (generation.lastObserved && Game.time - generation.lastObserved.at < FIELD_SAMPLE_INTERVAL)) return;
  const field = fieldStrength(task, room);
  generation.baseline ??= field;
  generation.lastObserved = { at: Game.time, field };
}

function evaluateGeneration(task: WarTask, generation: WarGenerationState): WarReview["result"] {
  const room = Game.rooms[task.targetRoom];
  const before = generation.baseline;
  if (room) generation.lastObserved = { at: Game.time, field: fieldStrength(task, room) };
  const last = generation.lastObserved;
  if (!last || !before || Game.time - last.at > FIELD_SAMPLE_INTERVAL) return "unconfirmed";
  const now = last.field;
  if (now.structures < before.structures) return "structure_removed";
  if (before.hits - now.hits >= 1000) return "structure_damaged";
  if (before.towerEnergy - now.towerEnergy >= 100) return "tower_drained";
  return room ? "no_progress" : "unconfirmed";
}

export function authorizeReplacement(task: WarTask, generation: WarGenerationState): boolean {
  const previous = task.review;
  if (previous?.generation === generation.id) return previous.action !== "stop";
  const result = evaluateGeneration(task, generation);
  const stalled = result === "no_progress" || result === "unconfirmed";
  const losses = stalled ? (previous?.consecutiveLosses ?? 0) + 1 : 0;
  const review: WarReview = { generation: generation.id, result, action: "replace", consecutiveLosses: losses, avoidedIngress: previous?.avoidedIngress };
  review.observedAt = generation.lastObserved?.at;
  if (task.oneShot) review.action = "stop";
  else if (losses >= 2) {
    review.action = "stop";
    const route = task.routeRooms;
    if (!review.avoidedIngress && task.routeOrigin === "map" && route && route.length >= 2) {
      const ingress = route[route.length - 2];
      const plan = defaultWarMapRoute(task.sourceRoom, task.targetRoom, ingress);
      if (plan.rooms) {
        review.action = "reroute";
        review.avoidedIngress = ingress;
        task.routeRooms = plan.rooms;
        task.routeTrace = plan.trace;
        task.routePlannedAt = Game.time;
        delete task.squadAssessedAt;
      }
    }
  }
  task.review = review;
  return review.action !== "stop";
}
