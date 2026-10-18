import { retireCreep } from "@/runtime/retirement";
import { cancelSpawning } from "./spawnIndex";
import { measureSampledCpuPhase } from "@/runtime/cpuPhaseProfiler";
import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { requestCombatObservation } from "@/runtime/powerBankObserver";
import { assessUnboostedNpc, isNpcWarTarget } from "@/runtime/warNpcPolicy";
import { TOWER_DRAIN_ATTACKER_BODY, TOWER_DRAIN_HEALER_BODY, WAR_CLEAR_DEBOUNCE_TICKS } from "./constants";
import { type WarGenerationState, type WarRole, type WarTask, ensureConfigStore, getControllerAttackConfigName, getGenerationBoostTaskId, getGenerationConfigName, getLiveCreepsByConfig, getTaskConfigNames } from "./store";
import { activateFrontline, processScheduledTask } from "./lifecycle";
import { clearControllerAttackConfig, collectSpawningForConfigs, detachWarTaskCreeps, ensureControllerAttackConfig, getSpawnsForRoom, isConfigQueuedInSpawns, isConfigSpawning, isGenerationComplete, releaseWarBoosts, removeConfig, removeQueuedConfigByName, resetWarCreepTargetState, synchronizeGenerationRoleArgs, transitionWarTaskTerminal } from "./production";

import { getHostilePresence, isControllerDefeated, isControllerDowngradeReady } from "./observation";
import { getRoleBody } from "./squadPolicy/index";
import { setTaskStatus } from "./fsm";

export function retireSharedCombat(task: WarTask): void {
  if (task.sharedRetiredAt !== undefined && !task.activeGeneration && !getTaskConfigNames(task).some(name => ensureConfigStore()[name] || getLiveCreepsByConfig(name).length || isConfigSpawning(name) || isConfigQueuedInSpawns(getSpawnsForRoom(task.sourceRoom), name))) return;
  task.sharedRetiredAt = Game.time;
  const names = new Set(getTaskConfigNames(task).filter((name) => name !== getControllerAttackConfigName(task)));
  const spawning = collectSpawningForConfigs(names);
  for (const creep of [...names].flatMap(getLiveCreepsByConfig)) {
    retireCreep(creep, { owner: "war", mode: "recycle", roomName: task.sourceRoom });
    resetWarCreepTargetState(creep);
  }
  detachWarTaskCreeps(task, names, false);
  for (const spawn of spawning) cancelSpawning(spawn);
  for (const name of names) { removeQueuedConfigByName(name); removeConfig(name); }
  releaseWarBoosts(task);
  delete task.activeGeneration;
}

export function retireSharedController(task: WarTask): void {
  const name = getControllerAttackConfigName(task);
  if (!ensureConfigStore()[name] && !getLiveCreepsByConfig(name).length && !isConfigSpawning(name) && !isConfigQueuedInSpawns(getSpawnsForRoom(task.sourceRoom), name) && task.controllerAttackerLastQueuedAt === undefined) return;
  const spawning = collectSpawningForConfigs(new Set([name]));
  for (const actor of getLiveCreepsByConfig(name)) {
    retireCreep(actor, { owner: "war", mode: "recycle", roomName: task.sourceRoom });
    resetWarCreepTargetState(actor);
  }
  for (const spawn of spawning) cancelSpawning(spawn);
  clearControllerAttackConfig(task);
  delete task.controllerAttackerLastQueuedAt;
}

export function sharedSquadScore(task: WarTask): number {
  const generation = task.activeGeneration;
  if (!generation) return 0;
  const members = Object.values(generation.configNames).map((name) => getLiveCreepsByConfig(name)[0]);
  if (members.some((creep) => !creep || creep.spawning)) return 1;
  const attacker = members[0]!;
  const power = attacker.body.reduce((sum, part) => sum + (part.type === ATTACK && part.hits > 0
    ? ATTACK_POWER * (part.boost ? (BOOSTS[ATTACK][part.boost]?.attack ?? 1) : 1) : 0), 0);
  return 1_000_000 + power * 1000 + Math.min(...members.map((creep) => creep!.ticksToLive ?? 0));
}

export function transferSharedGeneration(from: WarTask, to: WarTask): boolean {
  const previous = from.activeGeneration;
  if (!previous || previous.phase !== "deployed") return false;
  const roles: WarRole[] = ["meleeAttacker", "healer"];
  const members = roles.map((role) => getLiveCreepsByConfig(previous.configNames[role])[0]);
  if (members.some((creep) => !creep || creep.spawning)) return false;
  const id = Math.max(to.generationCounter ?? 0, previous.id) + 1;
  const generation: WarGenerationState = { ...previous, id, boostTaskId: getGenerationBoostTaskId(to, id), configNames: {
    meleeAttacker: getGenerationConfigName(to, id, "meleeAttacker"),
    healer: getGenerationConfigName(to, id, "healer"),
  } };
  to.squad = from.squad;
  to.boostTier = from.boostTier;
  to.boostStatus = from.boostStatus;
  to.activeGeneration = generation;
  to.generationCounter = id;
  to.npcAuto = true;
  const store = ensureConfigStore();
  for (let index = 0; index < roles.length; index++) {
    const role = roles[index];
    const member = members[index]!;
    const name = generation.configNames[role];
    removeQueuedConfigByName(previous.configNames[role]);
    removeConfig(previous.configNames[role]);
    member.memory.configName = name;
    getTickContextService().reindexCreepConfig(member, previous.configNames[role]);
    member.memory._warPartnerConfigName = generation.configNames[role === "meleeAttacker" ? "healer" : "meleeAttacker"];
    resetWarCreepTargetState(member);
    getCreepConfigService().set(name, { role, roomName: to.sourceRoom, args: [], body: getRoleBody(to, role), spawnOnce: { queuedAt: previous.createdAt } });
  }
  synchronizeGenerationRoleArgs(to, false);
  delete from.activeGeneration;
  releaseWarBoosts(from);
  setTaskStatus(to, "staging");
  delete to.failReason;
  return true;
}

export function runSharedWarSquads(store: Record<string, WarTask>): Set<WarTask> {
  const managed = new Set<WarTask>();
  for (const task of Object.values(store)) {
    if (task.sharedSquadWatchId && !Memory.cfg?.warRebuildWatch?.[task.sharedSquadWatchId]?.sharedSquad) {
      delete task.sharedSquadWatchId;
      delete task.combatClearedAt;
      delete task.combatClearSince;
    }
  }
  for (const [id, config] of Object.entries(Memory.cfg?.warRebuildWatch ?? {})) {
    if (!config.sharedSquad) continue;
    const state = getMemoryService().ensureRuntime().warRebuildWatch ??= {};
    const watch = state[id] ??= { clearedRooms: [], targets: {} };
    const tasks = config.targetRooms.map((name) => store[name]).filter((task): task is WarTask => !!task
      && task.sourceRoom === config.sourceRoom && task.status !== "done" && task.status !== "failed" && !managed.has(task));
    for (const task of tasks) {
      managed.add(task);
      if (task.sharedSquadWatchId !== id) task.sharedSquadWatchId = id;
      retireSharedController(task);
      if (!Game.rooms[config.sourceRoom]?.controller?.my) {
        retireSharedCombat(task);
        if (task.failReason !== "shared_source_not_owned") task.failReason = "shared_source_not_owned";
        continue;
      }
      if (task.failReason === "shared_source_not_owned") delete task.failReason;
      if (task.combatClearedAt === undefined) requestCombatObservation(task.targetRoom);
      const room = Game.rooms[task.targetRoom];
      if (!room) continue;
      if (room.controller?.my || (room.controller?.owner && room.controller.owner.username !== config.enemyUsername)) {
        if (task.failReason !== "shared_target_owner_changed") task.failReason = "shared_target_owner_changed";
        retireSharedCombat(task);
        continue;
      }
      if ((task.squad === "t3Duo" || task.boostTier === "t3") && isNpcWarTarget(room)) {
        const decision = assessUnboostedNpc(room, task.routeRooms, TOWER_DRAIN_ATTACKER_BODY, TOWER_DRAIN_HEALER_BODY, Game.rooms[task.sourceRoom]?.energyCapacityAvailable);
        if (decision.sufficient) {
          // 无强化优先也覆盖现役选择；只有新鲜能力证据充足才撤回旧T3。
          retireSharedCombat(task);
          task.squad = "towerDrainDuo";
          delete task.boostTier;
          delete task.boostStatus;
          task.npcAuto = true;
          task.squadAssessedAt = Game.time;
          task.squadDecision = decision.reason;
        }
      }
      const hostile = getHostilePresence(room, task);
      if (hostile.hostileCreeps > 0 || hostile.hostileStructures > 0) {
        delete task.combatClearedAt;
        delete task.combatClearSince;
      } else {
        if (task.rebuildIgnoreStructureIds && task.activeGeneration && task.activeGeneration.phase !== "deployed") retireSharedCombat(task);
        task.combatClearSince ??= Game.time;
        if (Game.time - task.combatClearSince + 1 >= WAR_CLEAR_DEBOUNCE_TICKS) task.combatClearedAt ??= Game.time;
      }
    }
    const pending = tasks.filter((task) => task.combatClearedAt === undefined && !task.failReason?.startsWith("shared_target_owner") && task.failReason !== "shared_source_not_owned");
    let owner = tasks.find((task) => task.targetRoom === watch.sharedSquadOwner && task.failReason !== "shared_target_owner_changed" && task.failReason !== "shared_source_not_owned");
    if (!owner) owner = [...pending].sort((a, b) => sharedSquadScore(b) - sharedSquadScore(a))[0];
    // 换策略时先收回重复生产/成员，再决定是否把现役成员交给下一房。
    for (const task of tasks) if (task !== owner) retireSharedCombat(task);
    if (owner?.combatClearedAt !== undefined) {
      const next = pending[0];
      if (next) transferSharedGeneration(owner, next);
      if (!next || owner.activeGeneration) retireSharedCombat(owner);
      owner = next;
    }
    if (watch.sharedSquadOwner !== owner?.targetRoom) watch.sharedSquadOwner = owner?.targetRoom;
    for (const task of tasks) {
      const room = Game.rooms[task.targetRoom];
      if (task.failReason === "shared_target_owner_changed" || task.failReason === "shared_source_not_owned") continue;
      if (task.combatClearedAt !== undefined) {
        if (room && isControllerDefeated(room)) transitionWarTaskTerminal(task, "done", null);
        else { setTaskStatus(task, "downgrading"); ensureControllerAttackConfig(task); }
        continue;
      }
      if (task !== owner) {
        setTaskStatus(task, "queued");
        if (task.failReason !== "shared_squad_queued") task.failReason = "shared_squad_queued";
        if (room && isControllerDowngradeReady(room)) ensureControllerAttackConfig(task);
        continue;
      }
      // 清空去抖只等视野稳定；不能为了等这几十tick再孵化一队。
      if (task.combatClearSince !== undefined) {
        setTaskStatus(task, "clearing");
        if (room && isControllerDowngradeReady(room)) ensureControllerAttackConfig(task);
        continue;
      }
      // 现役强化成员继续使用；只有真的需要新世代时重新评估无强化能力。
      if (task.activeGeneration?.phase === "deployed" && !isGenerationComplete(task.activeGeneration)) retireSharedCombat(task);
      if (!task.activeGeneration && room && isNpcWarTarget(room)) {
        const decision = assessUnboostedNpc(room, task.routeRooms, TOWER_DRAIN_ATTACKER_BODY, TOWER_DRAIN_HEALER_BODY, Game.rooms[task.sourceRoom]?.energyCapacityAvailable);
        if (decision.reason === "entry_not_proven") { task.failReason = "npc_entry_not_proven"; continue; }
        task.squad = decision.sufficient ? "towerDrainDuo" : "t3Duo";
        task.boostTier = decision.sufficient ? undefined : "t3";
        task.npcAuto = true;
        task.squadAssessedAt = Game.time;
        task.squadDecision = decision.reason;
      }
      activateFrontline(task);
      if (task.failReason === "shared_squad_queued") delete task.failReason;
      measureSampledCpuPhase("war.process", () => processScheduledTask(task));
    }
  }
  return managed;
}
