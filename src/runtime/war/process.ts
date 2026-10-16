import { getSquadPolicy } from "./squadPolicy/index";
import { requestCombatObservation, OBSERVATION_REQUEST_TTL } from "@/runtime/powerBankObserver";
import { assessUnboostedNpc, isNpcWarTarget } from "@/runtime/warNpcPolicy";
import { MAX_STAGING_TICKS, T3_ATTACKER_BODY, T3_HEALER_BODY, TOWER_DRAIN_ATTACKER_BODY, TOWER_DRAIN_HEALER_BODY, WAR_CLEAR_DEBOUNCE_TICKS } from "./constants";
import type { WarTask } from "./store";
import { advancePatrol, completePatrolTarget } from "./patrol";
import { clearControllerAttackConfig, disableTaskProduction, ensureCombatConfigs, ensureControllerAttackConfig, prepareCombatSquad, reconcileGenerationLifecycle, releaseWarBoosts, synchronizeGenerationRoleArgs, transitionWarTaskTerminal } from "./production";
import { defaultWarMapRoute, getHostilePresence, hasControllerAttackBlockers, isControllerDefeated, isControllerDowngradeReady } from "./observation";
import { ensureWarStore, isPatrolTask, warPeriodicDue } from "./store";
import { isTowerDrainDuoTask } from "./squadPolicy/index";
import { requestWarRoomClear } from "./api";
import { setTaskStatus } from "./fsm";

export function processControllerVictory(task: WarTask): void {
  task.clearSince ??= Game.time;
  setTaskStatus(task, "clearing");
  if (!isPatrolTask(task)) {
    disableTaskProduction(task);
    releaseWarBoosts(task);
  }

  if (Game.time - task.clearSince + 1 < WAR_CLEAR_DEBOUNCE_TICKS) {
    return;
  }

  if (completePatrolTarget(task)) return;
  transitionWarTaskTerminal(task, "done", null);
}

export function processTask(task: WarTask): void {
  if (!task.routeTrace && task.routeRooms) task.routeTrace = { hops: Math.max(0, task.routeRooms.length - 1), avoided: {}, policy: task.routeOrigin === "map" ? "map_combat" : "manual" };
  if (task.routeOrigin === "map" && warPeriodicDue(task.routePlannedAt, task.targetRoom)) {
    const plan = defaultWarMapRoute(task.sourceRoom, task.targetRoom);
    const route = plan.rooms;
    task.routeTrace = plan.trace;
    task.routePlannedAt = Game.time;
    if (route && route.join("|") !== task.routeRooms?.join("|")) {
      task.routeRooms = route;
      synchronizeGenerationRoleArgs(task, false);
    }
  }
  if (task.npcAuto && getSquadPolicy(task).parallel && task.squadAssessedAt !== undefined && !warPeriodicDue(task.squadAssessedAt, task.targetRoom) && task.failReason?.startsWith("npc_")) return;
  if (task.npcAuto && getSquadPolicy(task).parallel && (task.squadAssessedAt === undefined || warPeriodicDue(task.squadAssessedAt, task.targetRoom))) {
    task.squadAssessedAt = Game.time;
    const room = Game.rooms[task.targetRoom];
    if (!room) { requestCombatObservation(task.targetRoom); task.failReason = "npc_policy_awaiting_vision"; return; }
    if (!isNpcWarTarget(room)) {
      // 空房继续既有清空判定；出现其它玩家的实际实体时停止自动升级。
      const otherOwner = room.controller?.owner?.username;
      if (otherOwner && otherOwner !== "Invader" && otherOwner !== "TooAngel") { task.failReason = "npc_identity_changed"; return; }
    }
    const decision = assessUnboostedNpc(room, task.routeRooms, TOWER_DRAIN_ATTACKER_BODY, TOWER_DRAIN_HEALER_BODY, Game.rooms[task.sourceRoom]?.energyCapacityAvailable);
    task.squadAssessedAt = Game.time;
    task.squadDecision = decision.reason;
    if (decision.reason === "entry_not_proven") { task.failReason = "npc_entry_not_proven"; return; }
    if (!decision.sufficient) {
      requestWarRoomClear(task.targetRoom, task.sourceRoom, { npcAuto: true, forcePolicyAssessment: true });
      // 下一帧由源房调度器重新准入，不能绕过已有T3队伍的串行生产所有权。
      setTaskStatus(ensureWarStore()[task.targetRoom], "queued");
      return;
    }
    if (task.failReason?.startsWith("npc_")) delete task.failReason;
  }
  if (task.npcAuto) {
    const capacity = Game.rooms[task.sourceRoom]?.energyCapacityAvailable;
    const bodies = getSquadPolicy(task).parallel ? [TOWER_DRAIN_ATTACKER_BODY, TOWER_DRAIN_HEALER_BODY] : [T3_ATTACKER_BODY, T3_HEALER_BODY];
    if (capacity !== undefined && bodies.some(body => body.reduce((sum, part) => sum + BODYPART_COST[part], 0) > capacity)) {
      task.failReason = "npc_source_capacity_insufficient";
      return;
    }
    if (task.failReason === "npc_source_capacity_insufficient") delete task.failReason;
  }
  if (getSquadPolicy(task).parallel || task.tactic === "t3TowerDrainDuo") requestCombatObservation(task.targetRoom);
  task.statusSince ??= task.createdAt;

  if (task.status === "patrol_waiting") {
    if (reconcileGenerationLifecycle(task)) return;
    if (Game.time < (task.patrolNextSweepAt ?? Game.time)) {
      if (!prepareCombatSquad(task)) return;
      ensureCombatConfigs(task);
      return;
    }
    if (!advancePatrol(task, 0)) return;
  }

  const room = Game.rooms[task.targetRoom];
  const stagingTooLong =
    task.status === "staging"
    && task.failReason !== "insufficient_labs"
    && Game.time - task.statusSince > MAX_STAGING_TICKS;
  if (stagingTooLong) {
    transitionWarTaskTerminal(task, "failed", "staging_timeout");
    return;
  }

  if (
    room
    && getSquadPolicy(task).allowsControllerAttack
    && task.reason === "manual"
    && !isPatrolTask(task)
    && isControllerDefeated(room)
    && !hasControllerAttackBlockers(room)
  ) {
    processControllerVictory(task);
    return;
  }

  if (reconcileGenerationLifecycle(task)) {
    return;
  }

  if (!room) {
    setTaskStatus(task, "staging");
    if (task.clearSince !== undefined) delete task.clearSince;
    if (!prepareCombatSquad(task)) return;
    ensureCombatConfigs(task);
    return;
  }

  const hostile = getHostilePresence(room, task);
  if (getSquadPolicy(task).allowsControllerAttack && task.reason === "manual" && !isPatrolTask(task) && isControllerDowngradeReady(room)) {
    if (task.clearSince !== undefined) delete task.clearSince;
    const combatReady = prepareCombatSquad(task);
    if (combatReady) ensureCombatConfigs(task);
    setTaskStatus(task, "downgrading");
    ensureControllerAttackConfig(task);
    return;
  }

  clearControllerAttackConfig(task);
  if (!hostile.present) {
    task.clearSince ??= Game.time;
    if (Game.time - task.clearSince + 1 < WAR_CLEAR_DEBOUNCE_TICKS) {
      setTaskStatus(task, "clearing");
      if (!prepareCombatSquad(task)) return;
      ensureCombatConfigs(task);
      return;
    }

    if (!completePatrolTarget(task)) {
      transitionWarTaskTerminal(task, "done", null);
    }
    return;
  }

  if (task.lastHostileSeenAt === undefined || task.status !== "clearing" || Game.time - task.lastHostileSeenAt >= 10) task.lastHostileSeenAt = Game.time;
  if (task.clearSince !== undefined) delete task.clearSince;
  setTaskStatus(task, "clearing");
  if (!prepareCombatSquad(task)) return;
  ensureCombatConfigs(task);
}
