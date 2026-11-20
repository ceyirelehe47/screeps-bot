import { OBSERVATION_REQUEST_TTL, requestCombatObservation } from "@/runtime/powerBankObserver";
import { getSquadPolicy } from "./squadPolicy";
import { assessUnboostedNpc, isNpcWarTarget } from "@/runtime/warNpcPolicy";
import { MAX_STAGING_TICKS, T3_ATTACKER_BODY, T3_HEALER_BODY, TOWER_DRAIN_ATTACKER_BODY, TOWER_DRAIN_HEALER_BODY, WAR_CLEAR_DEBOUNCE_TICKS } from "./constants";
import { advancePatrol, completePatrolTarget } from "./patrol";
import { clearControllerAttackConfig, disableTaskProduction, ensureCombatConfigs, ensureControllerAttackConfig, prepareCombatSquad, reconcileGenerationLifecycle, releaseWarBoosts, synchronizeGenerationRoleArgs, transitionWarTaskTerminal } from "./production";
import { defaultWarMapRoute } from "./observation";
import { ensureWarStore, isPatrolTask, warPeriodicDue, type WarTask } from "./store";
import { requestWarRoomClear } from "./api";
import { setTaskStatus } from "./fsm";
import { chooseWarOrder, selectAutomaticTactic } from "./campaign";

function refreshRoute(task: WarTask): void {
  if (!task.routeTrace && task.routeRooms) task.routeTrace = { hops: Math.max(0, task.routeRooms.length - 1), avoided: {}, policy: task.routeOrigin === "map" ? "map_combat" : "manual" };
  if (task.routeOrigin === "map" && warPeriodicDue(task.routePlannedAt, task.targetRoom)) {
    const plan = defaultWarMapRoute(task.sourceRoom, task.targetRoom, task.review?.avoidedIngress);
    const route = plan.rooms;
    task.routeTrace = plan.trace;
    task.routePlannedAt = Game.time;
    if (route && route.join("|") !== task.routeRooms?.join("|")) {
      task.routeRooms = route;
      synchronizeGenerationRoleArgs(task, false);
    }
  }
}

function canDispatch(task: WarTask): boolean {
  if (task.npcAuto && getSquadPolicy(task).parallel && task.squadAssessedAt !== undefined && !warPeriodicDue(task.squadAssessedAt, task.targetRoom) && task.failReason?.startsWith("npc_")) return false;
  if (task.npcAuto && getSquadPolicy(task).parallel && (task.squadAssessedAt === undefined || warPeriodicDue(task.squadAssessedAt, task.targetRoom))) {
    task.squadAssessedAt = Game.time;
    const room = Game.rooms[task.targetRoom];
    if (!room) { task.failReason = "npc_policy_awaiting_vision"; return false; }
    if (!isNpcWarTarget(room)) {
      // 空房继续既有清空判定；出现其它玩家的实际实体时停止自动升级。
      const otherOwner = room.controller?.owner?.username;
      if (otherOwner && otherOwner !== "Invader" && otherOwner !== "TooAngel") { task.failReason = "npc_identity_changed"; return false; }
    }
    const decision = assessUnboostedNpc(room, task.routeRooms, TOWER_DRAIN_ATTACKER_BODY, TOWER_DRAIN_HEALER_BODY, Game.rooms[task.sourceRoom]?.energyCapacityAvailable);
    task.squadAssessedAt = Game.time;
    task.squadDecision = decision.reason;
    if (decision.reason === "entry_not_proven") { task.failReason = "npc_entry_not_proven"; return false; }
    if (!decision.sufficient) {
      requestWarRoomClear(task.targetRoom, task.sourceRoom, { npcAuto: true, forcePolicyAssessment: true });
      // 下一帧由源房调度器重新准入，不能绕过已有T3队伍的串行生产所有权。
      setTaskStatus(ensureWarStore()[task.targetRoom], "queued");
      return false;
    }
    if (task.failReason?.startsWith("npc_")) delete task.failReason;
  }
  if (task.npcAuto || task.squad === "towerDrainDuo" || task.squad === "t3Duo" || task.tactic === "t3TowerDrainDuo") {
    const capacity = Game.rooms[task.sourceRoom]?.energyCapacityAvailable;
    const bodies = getSquadPolicy(task).parallel ? [TOWER_DRAIN_ATTACKER_BODY, TOWER_DRAIN_HEALER_BODY] : [T3_ATTACKER_BODY, T3_HEALER_BODY];
    if (capacity !== undefined && bodies.some(body => body.reduce((sum, part) => sum + BODYPART_COST[part], 0) > capacity)) {
      task.failReason = "npc_source_capacity_insufficient";
      return false;
    }
    if (task.failReason === "npc_source_capacity_insufficient") delete task.failReason;
  }
  return true;
}

function muster(task: WarTask): void {
  if (prepareCombatSquad(task)) ensureCombatConfigs(task);
}

function confirmClear(task: WarTask): void {
  const first = task.clearSince === undefined || task.order !== "confirm";
  if (first && !isPatrolTask(task)) {
    disableTaskProduction(task);
    releaseWarBoosts(task);
  }
  task.clearSince ??= Game.time;
  task.order = "confirm";
  setTaskStatus(task, "clearing");
  if (Game.time - task.clearSince + 1 >= WAR_CLEAR_DEBOUNCE_TICKS && !completePatrolTarget(task)) {
    transitionWarTaskTerminal(task, "done", null);
  }
}

export function processTask(task: WarTask): void {
  task.statusSince ??= task.createdAt;
  if (task.status === "patrol_waiting") {
    task.order = "patrol";
    if (Game.time < (task.patrolNextSweepAt ?? Game.time)) {
      if (!reconcileGenerationLifecycle(task)) muster(task);
      return;
    }
    if (!advancePatrol(task, 0)) return;
  }
  refreshRoute(task);
  const room = Game.rooms[task.targetRoom];
  if (room) selectAutomaticTactic(task, room);
  if (!room) {
    task.order = "observe";
    delete task.clearSince;
    const observerAvailable = requestCombatObservation(task.targetRoom);
    if (task.autoTactic && !task.activeGeneration && observerAvailable && Game.time - task.createdAt < OBSERVATION_REQUEST_TTL) return;
  } else if (getSquadPolicy(task).parallel || task.tactic === "t3TowerDrainDuo") {
    requestCombatObservation(task.targetRoom);
  }
  if (!canDispatch(task)) return;
  if (task.status === "staging" && task.failReason !== "insufficient_labs" && Game.time - task.statusSince > MAX_STAGING_TICKS) {
    transitionWarTaskTerminal(task, "failed", "staging_timeout");
    return;
  }
  const order = chooseWarOrder(task, room);
  if (order === "confirm") {
    clearControllerAttackConfig(task);
    confirmClear(task);
    return;
  }
  task.order = order;
  delete task.clearSince;
  if (reconcileGenerationLifecycle(task)) return;
  if (order === "observe") {
    setTaskStatus(task, "staging");
    muster(task);
    return;
  }
  if (order === "suppress") {
    setTaskStatus(task, "downgrading");
    muster(task);
    ensureControllerAttackConfig(task);
    return;
  }
  clearControllerAttackConfig(task);
  if (task.lastHostileSeenAt === undefined || task.status !== "clearing" || Game.time - task.lastHostileSeenAt >= 10) {
    task.lastHostileSeenAt = Game.time;
  }
  setTaskStatus(task, "clearing");
  muster(task);
}
