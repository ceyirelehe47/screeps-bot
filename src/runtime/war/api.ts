import { sameArray } from "./store";
import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { assessUnboostedNpc, isNpcWarTarget } from "@/runtime/warNpcPolicy";
import { DEFAULT_PATROL_INTERVAL_TICKS, MIN_PATROL_INTERVAL_TICKS, TOWER_DRAIN_ATTACKER_BODY, TOWER_DRAIN_HEALER_BODY } from "./constants";
import type { StartWarOptions, StartWarPatrolOptions, StartWarPatrolResult, StartWarResult, StopWarOptions, StopWarResult, WarBoostTier, WarSquad, WarStatus, WarStatusSnapshot } from "./store";
import { buildTaskStatusSnapshot, writeWarTelemetry } from "./telemetry";
import { defaultWarMapRoute } from "./observation";
import { ensureWarStore } from "./store";
import { hasTaskWarActivity, releaseWarTaskAssets } from "./production";

export function requestWarRoomClear(
  targetRoom: string,
  sourceRoom: string,
  options?: { routeRooms?: string[]; reason?: "npc_reservation" | "manual"; squad?: WarSquad; tactic?: "t3TowerDrainDuo"; boostTier?: WarBoostTier; oneShot?: boolean; npcAuto?: true; forcePolicyAssessment?: true },
): void {
  const store = ensureWarStore();
  const existing = store[targetRoom];
  const now = Game.time;
  const sameRequest = existing && existing.status !== "done" && existing.status !== "failed" && existing.sourceRoom === sourceRoom
    && !options?.forcePolicyAssessment
    && (options?.routeRooms === undefined || existing.routeOrigin === "manual" && sameArray(existing.routeRooms, options.routeRooms))
    && (options?.reason ?? existing.reason) === existing.reason
    && (options?.squad ?? existing.squad) === existing.squad
    && (options?.tactic ?? existing.tactic) === existing.tactic
    && (options?.boostTier ?? existing.boostTier) === existing.boostTier
    && (options?.oneShot ?? existing.oneShot) === existing.oneShot
    && (options?.squad !== undefined || options?.boostTier !== undefined ? undefined : options?.npcAuto ?? existing.npcAuto) === existing.npcAuto;
  if (sameRequest) return;
  const restarting = !existing || existing.status === "done" || existing.status === "failed";
  const npcAuto = options?.squad !== undefined || options?.boostTier !== undefined ? undefined
    : options?.npcAuto ?? existing?.npcAuto ?? ((!existing || restarting) && (options?.reason === "npc_reservation" || Game.rooms[targetRoom] && isNpcWarTarget(Game.rooms[targetRoom])) ? true : undefined);
  const inheritedRoute = existing?.sourceRoom === sourceRoom ? existing.routeRooms : undefined;
  const plan = options?.routeRooms || inheritedRoute ? undefined : defaultWarMapRoute(sourceRoom, targetRoom);
  const routeRooms = options?.routeRooms ?? inheritedRoute ?? plan?.rooms;
  const decision = npcAuto && Game.rooms[targetRoom] ? assessUnboostedNpc(Game.rooms[targetRoom], routeRooms, TOWER_DRAIN_ATTACKER_BODY, TOWER_DRAIN_HEALER_BODY, Game.rooms[sourceRoom]?.energyCapacityAvailable) : undefined;
  const needsT3 = !restarting && existing?.squad === "t3Duo" || decision && !decision.sufficient && decision.reason !== "entry_not_proven";
  const squad = options?.squad ?? (npcAuto ? needsT3 ? "t3Duo" : "towerDrainDuo" : existing?.squad);
  const changedSquad = !!existing && existing.squad !== squad;
  const restart = !existing || existing.status === "done" || existing.status === "failed"
    || existing.sourceRoom !== sourceRoom || changedSquad;
  const nextStatus: WarStatus = restart ? "staging" : existing.status;
  const nextAttempts = restart ? (existing?.attempts ?? 0) + 1 : (existing?.attempts ?? 1);

  if (existing && restart) {
    releaseWarTaskAssets(existing);
  }

  store[targetRoom] = {
    ...(restart ? {} : existing),
    members: restart ? undefined : existing?.members,
    membersVersion: restart ? undefined : existing?.membersVersion,
    targetRoom,
    sourceRoom,
    status: nextStatus,
    reason: options?.reason ?? existing?.reason ?? "npc_reservation",
    routeRooms,
    routeOrigin: options?.routeRooms ? "manual" : existing?.sourceRoom === sourceRoom && existing.routeRooms ? existing.routeOrigin ?? "manual" : "map",
    routePlannedAt: options?.routeRooms || !existing?.routeRooms ? now : existing.routePlannedAt,
    routeTrace: options?.routeRooms ? { hops: Math.max(0, options.routeRooms.length - 1), avoided: {}, policy: "manual" } : inheritedRoute ? existing?.routeTrace ?? { hops: inheritedRoute.length - 1, avoided: {}, policy: existing?.routeOrigin === "map" ? "map_combat" : "manual" } : plan?.trace,
    npcAuto,
    squadDecision: npcAuto ? decision?.reason ?? "awaiting_vision" : "explicit_or_player_default",
    squadAssessedAt: npcAuto && decision && decision.reason !== "entry_not_proven" ? now : undefined,
    squad,
    tactic: squad === "t3Duo" ? options?.tactic ?? existing?.tactic : undefined,
    boostTier: squad === "towerDrainDuo" ? undefined : options?.boostTier ?? (npcAuto && squad === "t3Duo" ? "t3" : existing?.boostTier),
    boostLabs: restart ? undefined : existing?.boostLabs,
    boostStatus: restart ? undefined : existing?.boostStatus,
    oneShot: options?.oneShot ?? existing?.oneShot,
    failReason: restart ? undefined : existing?.failReason,
    attempts: nextAttempts,
    createdAt: restart ? now : (existing?.createdAt ?? now),
    statusSince: restart ? now : (existing?.statusSince ?? now),
    lastHostileSeenAt: restart ? undefined : existing?.lastHostileSeenAt,
    clearSince: restart ? undefined : existing?.clearSince,
    updatedAt: now,
    completedAt: restart ? undefined : existing?.completedAt,
    assetsReleasedAt: restart ? undefined : existing?.assetsReleasedAt,
    controllerAttackerLastQueuedAt: restart ? undefined : existing?.controllerAttackerLastQueuedAt,
    generationCounter: restart
      ? (existing?.sourceRoom === sourceRoom
        ? Math.max(existing.generationCounter ?? 0, existing.activeGeneration?.id ?? 0)
        : undefined)
      : existing?.generationCounter,
    activeGeneration: restart ? undefined : existing?.activeGeneration,
  };
}

export function startWarRoom(targetRoom: string, sourceRoom: string, options: StartWarOptions = {}): StartWarResult | string {
  if (!targetRoom || !sourceRoom) {
    return "ERR_INVALID_ARGS:startWar(targetRoom, sourceRoom)";
  }

  if (options.tactic && (options.tactic !== "t3TowerDrainDuo" || (options.squad !== undefined && options.squad !== "t3Duo"))) return "ERR_INVALID_ARGS:T3 tactic requires t3Duo";

  const npcAuto = options.tactic === undefined && options.squad === undefined && options.boostTier === undefined && !!Game.rooms[targetRoom] && isNpcWarTarget(Game.rooms[targetRoom]);
  const squad = npcAuto ? undefined : options.squad ?? "t3Duo";
  const boostTier = squad === "towerDrainDuo" ? undefined : options.boostTier ?? (squad === "t3Duo" ? "t3" : undefined);
  const oneShot = options.oneShot ?? true;

  requestWarRoomClear(targetRoom, sourceRoom, {
    routeRooms: options.routeRooms,
    reason: "manual",
    squad,
    tactic: options.tactic,
    boostTier,
    oneShot,
    npcAuto: npcAuto ? true : undefined,
  });

  const task = ensureWarStore()[targetRoom];
  return {
    ok: true,
    targetRoom: task.targetRoom,
    sourceRoom: task.sourceRoom,
    status: task.status,
    reason: "manual",
    squad: task.squad,
    tactic: task.tactic,
    boostTier: task.boostTier,
    oneShot: task.oneShot === true,
    attempts: task.attempts,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function startWarPatrol(
  sourceRoom: string,
  targetRooms: string[],
  options: StartWarPatrolOptions = {},
): StartWarPatrolResult | string {
  const patrolRooms = [...new Set(targetRooms.filter((roomName) => roomName.length > 0))];
  if (!sourceRoom || patrolRooms.length === 0) {
    return "ERR_INVALID_ARGS:startWarPatrol(sourceRoom, targetRooms, options?)";
  }

  const store = ensureWarStore();
  for (const task of Object.values(store)) {
    const terminal = task.status === "done" || task.status === "failed";
    const overlapsPatrol = patrolRooms.some((roomName) =>
      task.targetRoom === roomName || task.patrolRooms?.includes(roomName)
    );
    if (terminal && (task.sourceRoom === sourceRoom || overlapsPatrol)) {
      releaseWarTaskAssets(task);
    }
  }

  const sourceConflict = Object.values(store).find((task) =>
    task.sourceRoom === sourceRoom && task.status !== "done" && task.status !== "failed"
  );
  if (sourceConflict) {
    return `ERR_SOURCE_FRONTLINE_ACTIVE:${sourceRoom}:${sourceConflict.targetRoom}`;
  }

  const sourceActivity = Object.values(store).find((task) =>
    task.sourceRoom === sourceRoom && hasTaskWarActivity(task)
  );
  if (sourceActivity) {
    return `ERR_SOURCE_WAR_ACTIVITY:${sourceRoom}:${sourceActivity.targetRoom}`;
  }

  for (const roomName of patrolRooms) {
    const collision = Object.values(store).find((task) =>
      task.targetRoom === roomName || task.patrolRooms?.includes(roomName)
    );
    if (!collision) continue;

    const terminal = collision.status === "done" || collision.status === "failed";
    if (!terminal) {
      return `ERR_PATROL_TARGET_ACTIVE:${roomName}`;
    }
    if (hasTaskWarActivity(collision)) {
      return `ERR_PATROL_TARGET_ACTIVITY:${roomName}`;
    }
  }

  for (const [key, task] of Object.entries(store)) {
    const overlapsPatrol = patrolRooms.some((roomName) =>
      task.targetRoom === roomName || task.patrolRooms?.includes(roomName)
    );
    if (
      (task.sourceRoom === sourceRoom || overlapsPatrol)
      && (task.status === "done" || task.status === "failed")
    ) {
      delete store[key];
    }
  }

  const intervalTicks = Number.isFinite(options.intervalTicks)
    ? Math.max(MIN_PATROL_INTERVAL_TICKS, Math.floor(options.intervalTicks!))
    : DEFAULT_PATROL_INTERVAL_TICKS;
  const result = startWarRoom(patrolRooms[0], sourceRoom, {
    squad: "t3Duo",
    boostTier: "t3",
    oneShot: false,
  });
  if (typeof result === "string") return result;

  const task = store[patrolRooms[0]];
  task.patrolRooms = patrolRooms;
  task.patrolIndex = 0;
  task.patrolInterval = intervalTicks;
  task.patrolNextSweepAt = undefined;
  return {
    ...result,
    patrolRooms: [...patrolRooms],
    patrolIndex: 0,
    patrolInterval: intervalTicks,
  };
}

export function isWarRoomClearDone(roomName: string): boolean {
  const task = Memory.data?.war?.[roomName];
  return task?.status === "done";
}

export function clearWarRoomTask(roomName: string): void {
  releaseWarTaskOwner(roomName);
}

export function releaseWarTaskOwner(taskKey: string, options: StopWarOptions = {}): StopWarResult | string {
  const store = Memory.data?.war;
  if (!store || !Object.prototype.hasOwnProperty.call(store, taskKey)) {
    return `ERR_NO_WAR_TASK:${taskKey}`;
  }
  const task = store[taskKey];
  const released = releaseWarTaskAssets(task, options);
  delete store[taskKey];
  writeWarTelemetry();

  return {
    ok: true,
    targetRoom: task.targetRoom,
    removedTask: true,
    removedConfigs: released.removedConfigs,
    removedQueuedTasks: released.removedQueuedTasks,
    cancelledSpawns: released.cancelledSpawns,
    suicidedCreeps: released.suicidedCreeps,
    releasedBoosts: released.releasedBoosts,
  };
}

export function stopWarRoom(targetRoom: string, options: StopWarOptions = {}): StopWarResult | string {
  const store = Memory.data?.war;
  if (!store) {
    return `ERR_NO_WAR_TASK:${targetRoom}`;
  }
  const taskEntry = Object.entries(store).find(([key, candidate]) =>
    key === targetRoom || candidate.targetRoom === targetRoom || candidate.patrolRooms?.includes(targetRoom)
  );
  if (!taskEntry) {
    return `ERR_NO_WAR_TASK:${targetRoom}`;
  }
  return releaseWarTaskOwner(taskEntry[0], options);
}

export function getWarStatus(targetRoom?: string): WarStatusSnapshot {
  return {
    ok: true,
    tick: Game.time,
    tasks: Object.values(ensureWarStore())
      .filter((task) => !targetRoom || task.targetRoom === targetRoom || task.patrolRooms?.includes(targetRoom))
      .map((task) => buildTaskStatusSnapshot(task)),
  };
}

export function configureWarRebuildWatch(sourceRoom: string, targetRooms: string[], enemyUsername: string, intervalTicks = 100, sharedSquad = false): { ok: true; id: string } | string {
  const rooms = [...new Set(targetRooms)].sort();
  const validRoom = (name: string) => /^[WE]\d+[NS]\d+$/.test(name);
  const source = Game.rooms[sourceRoom];
  if (!source?.controller?.my || !validRoom(sourceRoom) || !rooms.length || rooms.some((name) => !validRoom(name) || name === sourceRoom)
    || !enemyUsername || enemyUsername === source.controller.owner?.username || !Number.isFinite(intervalTicks) || intervalTicks < 1) return "ERR_INVALID_REBUILD_WATCH";
  const id = `${sourceRoom}:${enemyUsername}:${rooms.join("|")}`;
  getMemoryService().ensureCfg().warRebuildWatch ??= {};
  getMemoryService().ensureCfg().warRebuildWatch![id] = { sourceRoom, targetRooms: rooms, enemyUsername, intervalTicks: Math.floor(intervalTicks), ...(sharedSquad ? { sharedSquad: true } : {}) };
  return { ok: true, id };
}
