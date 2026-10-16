import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { CONTROLLER_ATTACKER_QUEUE_INTERVAL, WAR_CLEAR_DEBOUNCE_TICKS } from "./constants";
import type { WarStatusCreepSnapshot, WarStatusTaskSnapshot, WarTask } from "./store";
import { ensureWarStore, getControllerAttackConfigName, getLiveCreepsByConfig, getTaskConfigNames } from "./store";
import { getHostilePresence } from "./observation";
import { getQueuedConfigs } from "./production";

export let telemetryRevision = "";

export function getTaskCreeps(task: WarTask): WarStatusCreepSnapshot[] {
  return getTaskConfigNames(task).flatMap(getLiveCreepsByConfig).map(creep => ({
    name: creep.name, role: creep.memory.role, configName: creep.memory.configName,
    roomName: creep.room.name, x: creep.pos.x, y: creep.pos.y, hits: creep.hits, hitsMax: creep.hitsMax,
    boostedParts: creep.body.filter(part => !!part.boost).length, spawning: !!creep.spawning, detached: creep.memory._warDetached === true,
  }));
}

export function buildTaskStatusSnapshot(task: WarTask): WarStatusTaskSnapshot {
  const room = Game.rooms[task.targetRoom];
  const hostile = room ? getHostilePresence(room, task) : undefined;
  const sourceRoom = Game.rooms[task.sourceRoom];
  const generation = task.activeGeneration;
  const controller = room?.controller;
  return {
    targetRoom: task.targetRoom,
    sourceRoom: task.sourceRoom,
    status: task.status,
    reason: task.reason,
    squad: task.squad,
    tactic: task.tactic,
    routeRooms: task.routeRooms,
    routeTrace: task.routeTrace,
    squadDecision: task.squadDecision,
    boostTier: task.boostTier,
    oneShot: task.oneShot === true,
    boostStatus: task.boostStatus,
    attempts: task.attempts,
    age: Math.max(0, Game.time - task.createdAt),
    statusAge: Math.max(0, Game.time - (task.statusSince ?? task.createdAt)),
    clearTicks: task.clearSince === undefined ? 0 : Math.max(0, Game.time - task.clearSince + 1),
    targetVisible: !!room,
    hostileCreeps: hostile?.hostileCreeps ?? 0,
    hostileStructures: hostile?.hostileStructures ?? 0,
    hostileReservation: hostile?.hostileReservation ?? false,
    sourceEnergyAvailable: sourceRoom?.energyAvailable,
    sourceEnergyCapacity: sourceRoom?.energyCapacityAvailable,
    creeps: getTaskCreeps(task),
    queuedConfigs: getQueuedConfigs(task),
    generationId: generation?.id,
    generationPhase: generation?.phase,
    boostGateOpen: generation?.boostGateOpenedAt !== undefined,
    generationAge: generation ? Math.max(0, Game.time - generation.createdAt) : 0,
    deployedAge: generation?.deployedAt === undefined ? 0 : Math.max(0, Game.time - generation.deployedAt),
    controllerLevel: controller?.level,
    controllerOwner: controller?.owner?.username,
    controllerTicksToDowngrade: controller?.ticksToDowngrade,
    controllerUpgradeBlocked: controller?.upgradeBlocked,
    controllerAttackerConfigName:
      task.status === "downgrading" ? getControllerAttackConfigName(task) : undefined,
    controllerAttackerLastQueuedAt: task.controllerAttackerLastQueuedAt,
    controllerAttackerNextQueueAt: task.controllerAttackerLastQueuedAt === undefined
      ? undefined
      : task.controllerAttackerLastQueuedAt + CONTROLLER_ATTACKER_QUEUE_INTERVAL,
    patrolRooms: task.patrolRooms,
    patrolIndex: task.patrolIndex,
    patrolInterval: task.patrolInterval,
    patrolNextSweepAt: task.patrolNextSweepAt,
    patrolNextSweepIn: task.patrolNextSweepAt === undefined
      ? undefined
      : Math.max(0, task.patrolNextSweepAt - Game.time),
  };
}

export function writeWarTelemetry(): void {
  const analytics = getMemoryService().ensureAnalytics();
  const store = ensureWarStore();
  const revision = Object.values(store).map(t => `${t.targetRoom}:${t.createdAt}:${t.attempts}:${t.status}:${t.statusSince}:${t.activeGeneration?.id}:${t.activeGeneration?.phase}:${t.failReason}:${t.routeRooms?.join("|")}`).join(";");
  const interval = Game.cpu?.bucket < 2000 ? 20 : 10;
  if (telemetryRevision === revision && Game.time - (analytics.war?.updatedAt ?? -Infinity) < interval) return;
  telemetryRevision = revision;
  const previous = analytics.war?.tasks;
  analytics.war = {
    updatedAt: Game.time,
    clearDebounceTicks: WAR_CLEAR_DEBOUNCE_TICKS,
    tasks: Object.fromEntries(
      Object.values(store).map((task) => [task.targetRoom, (task.status === "done" || task.status === "failed") && previous?.[task.targetRoom]?.status === task.status && previous[task.targetRoom].attempts === task.attempts && task.createdAt <= (analytics.war?.updatedAt ?? 0) ? previous[task.targetRoom] : buildTaskStatusSnapshot(task)]),
    ),
  };
}
