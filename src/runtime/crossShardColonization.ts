import { createTaskLifecycle } from "@/runtime/taskLifecycle";
import type { OutboundMissionOwner } from "@/runtime/outboundMissionRegistry";
import { getCreepConfigService, getTickContextService, getMemoryService } from "@/runtime/runtimeServices";
import { hasTaskActors } from "@/runtime/taskActors";

import { getGlobalOwnedRoomCount } from "@/runtime/globalRoomCount";
import { enqueueConfig, ensureConfigStore, getBodyCost, isConfigSpawning as hasSpawningConfig, removeQueuedSpawnConfig, selectLeastLoadedSpawn } from "@/runtime/spawnHelpers";
import { spawnProfiles } from "@/config/spawnProfiles";
import { encodeCrossShardTravelerName } from "@/runtime/crossShardNaming";

import { isDefenseMode } from "@/runtime/defenseMode";

type CrossShardColonizationStatus =
  | "planning"
  | "ready"
  | "spawning"
  | "in_transit"
  | "claimed"
  | "bootstrapping"
  | "completed"
  | "blocked"
  | "failed";

interface CrossShardColonizationTask {
  targetShard: string;
  targetRoom: string;
  preferredSourceRoom?: string;
  sourceRoom?: string;
  status: CrossShardColonizationStatus;
  flagName: string;
  reason?: string;
  portalId?: string;
  portalRoom?: string;
  destinationRoom?: string;
  claimerConfigName?: string;
  claimerName?: string;
  bootstrapConfigNames?: string[];
  bootstrapDispatchedAt?: number;
  bootstrapLaunched?: boolean;
  launchedAt?: number;
  claimedAt?: number;
  completedAt?: number;
  lastObservedAt?: number;
  createdAt: number;
  updatedAt: number;
  lastReadyAt?: number;
  claimAttempts?: number;
  remoteObservedVersion?: number;
  remoteAdvancedAt?: number;
}

interface CrossShardTaskSummary {
  id: string;
  targetShard: string;
  targetRoom: string;
  status: CrossShardColonizationStatus;
  sourceRoom?: string;
  portalId?: string;
  updatedAt: number;
}

interface RemoteClaimSummary {
  room: string;
  at: number;
}

interface RemoteRoomSummary {
  room: string;
  at: number;
  hasSpawn: boolean;
}

interface RemotePayload {
  version: number;
  updatedAt: number;
  shard: string;
  claims?: RemoteClaimSummary[];
  rooms?: RemoteRoomSummary[];
}

interface RemoteTargetState {
  claimAt?: number;
  fresh?: boolean;
  hasSpawn: boolean;
}

type InterShardPortalEntry = NonNullable<NonNullable<Memory["data"]>["interShardPortals"]> extends Record<string, infer T>
  ? T
  : never;

const FLAG_PREFIX = "CLX_";
const CLAIMER_BODY: BodyPartConstant[] = [CLAIM, MOVE];
const SCOUT_BODY: BodyPartConstant[] = [MOVE];
const MIN_PORTAL_TICKS_TO_DECAY = 200;
const INTER_SHARD_PROTOCOL_VERSION = 1;
const BOOTSTRAP_HARVESTER_COUNT = 2;
const BOOTSTRAP_WORKER_COUNT = 2;
const CLAIM_RETRY_TTL = 1500;
const BOOTSTRAP_RETRY_TTL = 2000;

function ensureTaskStore(): Record<string, CrossShardColonizationTask> {
  const data = getMemoryService().ensureData();
  if (!data.crossShardColonization) {
    data.crossShardColonization = {};
  }
  return data.crossShardColonization;
}

function getInterShardPortals(): Record<string, InterShardPortalEntry> {
  return Memory.data?.interShardPortals || {};
}

function hasColonizationSquadProductionCapability(spawn: StructureSpawn): boolean {
  const minimumRequiredEnergyCapacity = Math.max(
    getBodyCost(SCOUT_BODY),
    getBodyCost(CLAIMER_BODY),
    getBodyCost(spawnProfiles.colonizerHarvester(spawn.room)),
    getBodyCost([WORK, CARRY, MOVE]),
  );

  return spawn.isActive() && spawn.room.energyCapacityAvailable >= minimumRequiredEnergyCapacity;
}

function getOwnedSpawnRooms(): string[] {
  const rooms = Object.values(Game.spawns)
    .filter((spawn) => spawn.room.controller?.my)
    .filter((spawn) => !isDefenseMode(spawn.room.name))
    .filter((spawn) => hasColonizationSquadProductionCapability(spawn))
    .map((spawn) => spawn.room.name);

  return [...new Set(rooms)];
}

function getCrossShardFlags(): Flag[] {
  return Object.values(Game.flags).filter((flag) => flag.name.startsWith(FLAG_PREFIX));
}

function parseFlag(flagName: string): { targetShard: string; targetRoom: string; preferredSourceRoom?: string } | null {
  const match = /^CLX_([A-Za-z0-9-]+)_([WE]\d+[NS]\d+)(?:_([WE]\d+[NS]\d+))?$/.exec(flagName);
  if (!match) {
    return null;
  }

  return {
    targetShard: match[1],
    targetRoom: match[2],
    preferredSourceRoom: match[3],
  };
}

function selectSourceAndPortal(
  targetShard: string,
  preferredSourceRoom?: string,
  targetRoom?: string,
): { sourceRoom: string; portal: InterShardPortalEntry } | null {
  const sourceRooms = getOwnedSpawnRooms();
  if (sourceRooms.length === 0) {
    return null;
  }

  const portals = Object.values(getInterShardPortals()).filter(portal => portal.destinationShard === targetShard &&
    (portal.ticksToDecay === undefined || portal.ticksToDecay - Math.max(0, Game.time - portal.lastSeenAt) >= MIN_PORTAL_TICKS_TO_DECAY));
  if (portals.length === 0) {
    return null;
  }

  const orderedSourceRooms =
    preferredSourceRoom && sourceRooms.includes(preferredSourceRoom)
      ? [preferredSourceRoom]
      : sourceRooms;

  if (preferredSourceRoom && !sourceRooms.includes(preferredSourceRoom)) {
    return null;
  }

  let best: { sourceRoom: string; portal: InterShardPortalEntry; distance: number } | null = null;
  for (const sourceRoom of orderedSourceRooms) {
    for (const portal of portals) {
      const distance = Game.map.getRoomLinearDistance(sourceRoom, portal.originRoom) +
        (targetRoom ? (portal.destinationRoom ? Game.map.getRoomLinearDistance(portal.destinationRoom, targetRoom) : Infinity) : 0);
      // CLAIM 寿命为 600；按每房约 50 步留出入门与控制器接近余量。
      if (distance > 8) continue;
      if (!best || distance < best.distance) {
        best = { sourceRoom, portal, distance };
      }
    }
  }

  if (!best) {
    return null;
  }

  return { sourceRoom: best.sourceRoom, portal: best.portal };
}

function getTaskId(targetShard: string, targetRoom: string): string {
  return `${targetShard}:${targetRoom}`;
}

function getTaskConfigName(task: CrossShardColonizationTask, role: "claimer" | "harvester" | "worker", index: number): string {
  return `${task.sourceRoom}:crossShard:${task.targetShard}:${task.targetRoom}:${role}:${index}`;
}

function getSpawnsForRoom(roomName: string): StructureSpawn[] {
  return Object.values(Game.spawns).filter((spawn) => spawn.room.name === roomName);
}

function getLiveCreepsByConfig(configName: string): Creep[] {
  return getTickContextService().getAllCreeps().filter((creep) => creep.memory.configName === configName);
}

function isConfigSpawning(configName: string): boolean { return hasSpawningConfig(configName, Object.values(Game.spawns)); }

function removeQueuedConfig(task: CrossShardColonizationTask, configName: string): void { if (!task.sourceRoom) return; removeQueuedSpawnConfig(getSpawnsForRoom(task.sourceRoom), configName); }

function isConfigQueued(task: CrossShardColonizationTask, configName: string): boolean {
  if (!task.sourceRoom) {
    return false;
  }

  return getSpawnsForRoom(task.sourceRoom).some((spawn) => spawn.memory.spawnList?.includes(configName));
}

function isConfigActive(task: CrossShardColonizationTask, configName: string): boolean {
  return getLiveCreepsByConfig(configName).length > 0 || isConfigSpawning(configName) || isConfigQueued(task, configName);
}

function removeConfigWhenIdle(configName: string): void {
  if (getLiveCreepsByConfig(configName).length > 0 || isConfigSpawning(configName)) {
    return;
  }

  const store = ensureConfigStore();
  if (store[configName]) {
    getCreepConfigService().remove(configName);
  }
}

function safeJsonParse<T>(raw: string | null | undefined): T | null {
  if (!raw || raw.length === 0) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

let remotePayloadCache: { tick: number; reader: typeof InterShardMemory.getRemote; values: Map<string, RemotePayload | null> } | undefined;
function getRemoteState(task: CrossShardColonizationTask): RemoteTargetState {
  const { targetShard, targetRoom } = task;
  if (typeof InterShardMemory === "undefined") {
    return { hasSpawn: false };
  }

  if (!remotePayloadCache || remotePayloadCache.tick !== Game.time || remotePayloadCache.reader !== InterShardMemory.getRemote) {
    remotePayloadCache = { tick: Game.time, reader: InterShardMemory.getRemote, values: new Map() };
  }
  if (!remotePayloadCache.values.has(targetShard)) remotePayloadCache.values.set(targetShard, safeJsonParse<RemotePayload>(InterShardMemory.getRemote(targetShard)));
  const payload = remotePayloadCache.values.get(targetShard);
  if (!payload || payload.version !== INTER_SHARD_PROTOCOL_VERSION) {
    return { hasSpawn: false };
  }

  if (!Number.isSafeInteger(payload.updatedAt)) return { hasSpawn: false };
  if (task.remoteObservedVersion !== undefined && payload.updatedAt < task.remoteObservedVersion) {
    task.remoteObservedVersion = payload.updatedAt; task.remoteAdvancedAt = undefined; return { hasSpawn: false };
  }
  if (task.remoteObservedVersion !== payload.updatedAt) {
    if (task.remoteObservedVersion !== undefined) task.remoteAdvancedAt = Game.time;
    task.remoteObservedVersion = payload.updatedAt;
  }
  // 必须在本次任务开始后观察到对端确实推进；不同 shard 的 tick 不可直接相减。
  if (task.remoteAdvancedAt === undefined || Game.time - task.remoteAdvancedAt > 1000) return { hasSpawn: false };
  let claimAt: number | undefined;
  for (const claim of payload.claims || []) {
    if (claim.room !== targetRoom || claim.at < payload.updatedAt - 5 || claim.at > payload.updatedAt) {
      continue;
    }

    if (claimAt === undefined || claim.at > claimAt) {
      claimAt = claim.at;
    }
  }

  let hasSpawn = false;
  for (const room of payload.rooms || []) {
    if (room.room === targetRoom && room.hasSpawn && room.at >= payload.updatedAt - 5 && room.at <= payload.updatedAt && claimAt !== undefined) {
      hasSpawn = true;
      break;
    }
  }

  return { claimAt, hasSpawn, fresh: true };
}

function getAllTaskConfigNames(task: CrossShardColonizationTask): string[] {
  const names: string[] = [];
  if (task.claimerConfigName) {
    names.push(task.claimerConfigName);
  }
  for (const name of task.bootstrapConfigNames || []) {
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

function cleanupTaskConfigs(task: CrossShardColonizationTask): void {
  const configStore = ensureConfigStore();
  for (const configName of getAllTaskConfigNames(task)) {
    removeQueuedConfig(task, configName);

    const config = configStore[configName];
    if (config?.roomName) {
      getCreepConfigService().detachSpawn(configName);
    }

    removeConfigWhenIdle(configName);
  }
}

function markClaimed(task: CrossShardColonizationTask, claimedAt: number): void {
  taskLifecycle.transition(task, "claimed");
  task.claimedAt = claimedAt;
  task.reason = undefined;

  if (task.claimerConfigName) {
    removeQueuedConfig(task, task.claimerConfigName);
    removeConfigWhenIdle(task.claimerConfigName);
  }
}

function markCompleted(task: CrossShardColonizationTask): void {
  taskLifecycle.transition(task, "completed");
  task.completedAt = Game.time;
  task.reason = undefined;
  cleanupTaskConfigs(task);
}

function generateTravelerName(
  kind: "claimer" | "harvester" | "worker",
  task: CrossShardColonizationTask,
  index: number,
): string {
  if (!task.portalRoom) throw new Error("跨 shard 旅客缺少 portalRoom");
  const nonce = `${index.toString(36)}${Game.time.toString(36)}${Math.floor(Math.random() * 1296)
    .toString(36)
    .padStart(2, "0")}`;
  return encodeCrossShardTravelerName(kind, {
    targetShard: task.targetShard,
    targetRoom: task.targetRoom,
    portalRoom: task.portalRoom,
    destinationRoom: task.destinationRoom,
    nonce,
  });
}

function ensureClaimer(task: CrossShardColonizationTask): void {
  if (Number.isFinite(Game.gcl?.level) && getGlobalOwnedRoomCount([task.targetShard]) >= Game.gcl.level) {
    cleanupTaskConfigs(task); taskLifecycle.transition(task, "blocked"); task.reason = "target_shard_gcl_not_enough"; return;
  }
  if (!task.sourceRoom || !task.portalRoom) {
    taskLifecycle.transition(task, "blocked");
    task.reason = "missing source room or portal room";
    return;
  }

  const configName = task.claimerConfigName || getTaskConfigName(task, "claimer", 0);
  task.claimerConfigName = configName;

  if (task.launchedAt && Game.time - task.launchedAt > CLAIM_RETRY_TTL) {
    task.claimAttempts = (task.claimAttempts ?? 0) + 1;
    if (task.claimAttempts >= 3) {
      cleanupTaskConfigs(task); taskLifecycle.transition(task, "failed"); task.reason = "claim_retry_limit"; task.completedAt = Game.time; return;
    }
    removeQueuedConfig(task, configName);
    removeConfigWhenIdle(configName);
    task.launchedAt = undefined;
    task.claimerName = undefined;
    taskLifecycle.transition(task, "planning");
    task.reason = `claimer retry after ${CLAIM_RETRY_TTL} ticks without remote claim`;
  }

  if (!task.claimerName) {
    task.claimerName = generateTravelerName("claimer", task, 0);
  }

  const configStore = ensureConfigStore();
  getCreepConfigService().set(configName, {
    role: "crossShardClaimer",
    args: [task.targetShard, task.targetRoom, task.portalRoom, task.destinationRoom || ""],
    roomName: task.sourceRoom,
    body: CLAIMER_BODY,
    name: task.claimerName,
  });

  const spawns = getSpawnsForRoom(task.sourceRoom);
  if (spawns.length === 0) {
    taskLifecycle.transition(task, "blocked");
    task.reason = `source spawn missing in ${task.sourceRoom}`;
    return;
  }

  const liveCreeps = getLiveCreepsByConfig(configName);
  if (liveCreeps.length > 0) {
    if (!task.launchedAt) {
      task.launchedAt = Game.time;
    }
    task.lastObservedAt = Game.time;
    taskLifecycle.transition(task, "spawning");
    task.reason = undefined;
    return;
  }

  if (isConfigSpawning(configName) || isConfigQueued(task, configName)) {
    taskLifecycle.transition(task, "spawning");
    task.reason = undefined;
    return;
  }

  if (task.launchedAt) {
    taskLifecycle.transition(task, "in_transit");
    task.reason = `claimer launched at ${task.launchedAt}, waiting remote claim`;
    if (configStore[configName]?.roomName) {
      getCreepConfigService().detachSpawn(configName);
    }
    removeQueuedConfig(task, configName);
    removeConfigWhenIdle(configName);
    return;
  }

  const targetSpawn = selectLeastLoadedSpawn(spawns);
  if (targetSpawn) enqueueConfig(targetSpawn, configName, true);
  taskLifecycle.transition(task, "ready");
  task.reason = undefined;
}

function ensureBootstrapSquad(task: CrossShardColonizationTask): void {
  if (!task.sourceRoom || !task.portalRoom) {
    taskLifecycle.transition(task, "blocked");
    task.reason = "missing source room or portal room for bootstrap";
    return;
  }

  const spawns = getSpawnsForRoom(task.sourceRoom);
  if (spawns.length === 0) {
    taskLifecycle.transition(task, "blocked");
    task.reason = `source spawn missing in ${task.sourceRoom}`;
    return;
  }

  const referenceSpawn = spawns[0];

  if (task.bootstrapDispatchedAt && Game.time - task.bootstrapDispatchedAt > BOOTSTRAP_RETRY_TTL) {
    for (const configName of task.bootstrapConfigNames || []) {
      removeQueuedConfig(task, configName);
      removeConfigWhenIdle(configName);
    }

    task.bootstrapConfigNames = undefined;
    task.bootstrapDispatchedAt = undefined;
    task.bootstrapLaunched = undefined;
    task.reason = `bootstrap retry after ${BOOTSTRAP_RETRY_TTL} ticks without target spawn`;
  }

  if (task.bootstrapDispatchedAt) {
    const hasActiveBootstrapConfig = (task.bootstrapConfigNames || []).some((configName) => isConfigActive(task, configName));
    if (!hasActiveBootstrapConfig) {
      task.reason = "bootstrap squad dispatched, waiting target shard spawn";
    }

    taskLifecycle.transition(task, "bootstrapping");
    return;
  }

  const configStore = ensureConfigStore();
  const bootstrapConfigNames: string[] = [];

  for (let i = 0; i < BOOTSTRAP_HARVESTER_COUNT; i++) {
    const configName = getTaskConfigName(task, "harvester", i);
    bootstrapConfigNames.push(configName);
    getCreepConfigService().set(configName, {
      role: "crossShardColonizerHarvester",
      args: [task.targetShard, task.targetRoom, task.portalRoom, task.destinationRoom || ""],
      body: spawnProfiles.crossShardColonizerHarvester(referenceSpawn.room),
      name: generateTravelerName("harvester", task, i),
    });
    const targetSpawn = selectLeastLoadedSpawn(spawns);
    if (targetSpawn) enqueueConfig(targetSpawn, configName, false);
  }

  for (let i = 0; i < BOOTSTRAP_WORKER_COUNT; i++) {
    const configName = getTaskConfigName(task, "worker", i);
    bootstrapConfigNames.push(configName);
    getCreepConfigService().set(configName, {
      role: "crossShardColonizerWorker",
      args: [task.targetShard, task.targetRoom, task.portalRoom, task.destinationRoom || ""],
      body: spawnProfiles.crossShardColonizerWorker(referenceSpawn.room),
      name: generateTravelerName("worker", task, i),
    });
    const targetSpawn = selectLeastLoadedSpawn(spawns);
    if (targetSpawn) enqueueConfig(targetSpawn, configName, false);
  }

  task.bootstrapConfigNames = bootstrapConfigNames;
  task.bootstrapDispatchedAt = Game.time;
  task.bootstrapLaunched = false;
  taskLifecycle.transition(task, "bootstrapping");
  task.reason = "bootstrap squad dispatched";
}

function processTask(task: CrossShardColonizationTask): void {
  if (task.status === "completed" || task.status === "failed") {
    return;
  }

  if (task.sourceRoom && isDefenseMode(task.sourceRoom)) {
    return;
  }

  if (task.targetShard === Game.shard.name) {
    taskLifecycle.transition(task, "failed");
    task.reason = "target shard equals current shard";
    return;
  }

  const remoteState = getRemoteState(task);

  if (task.status !== "claimed" && task.status !== "bootstrapping") {
    if (remoteState.claimAt !== undefined) {
      markClaimed(task, remoteState.claimAt);
    }
  }

  if ((task.status === "claimed" || task.status === "bootstrapping") && remoteState.fresh && remoteState.claimAt === undefined) {
    cleanupTaskConfigs(task);
    taskLifecycle.transition(task, "planning"); task.claimedAt = undefined;
    task.bootstrapDispatchedAt = undefined; task.bootstrapConfigNames = undefined; task.bootstrapLaunched = undefined;
  }
  if (task.status === "claimed" || task.status === "bootstrapping") {
    if (remoteState.hasSpawn) {
      markCompleted(task);
      return;
    }

    ensureBootstrapSquad(task);
    task.lastReadyAt = Game.time;
    return;
  }

  // 已发出的名字和源房绑定；途中暂时失去观察或防御不能换母房。
  if ((task.status === "spawning" || task.status === "in_transit") && task.sourceRoom && task.portalRoom) {
    ensureClaimer(task);
    if (task.status === "spawning" || task.status === "in_transit") task.lastReadyAt = Game.time;
    return;
  }
  const selected = selectSourceAndPortal(task.targetShard, task.preferredSourceRoom, task.targetRoom);
  if (!selected) {
    cleanupTaskConfigs(task);
    taskLifecycle.transition(task, "blocked");
    task.reason = "no reachable source room or inter-shard portal";
    task.portalId = undefined;
    task.portalRoom = undefined;
    task.destinationRoom = undefined;
    return;
  }

  task.sourceRoom = selected.sourceRoom;
  task.portalId = selected.portal.id;
  task.portalRoom = selected.portal.originRoom;
  task.destinationRoom = selected.portal.destinationRoom;

  ensureClaimer(task);
  if (task.status === "ready" || task.status === "spawning" || task.status === "in_transit") {
    task.lastReadyAt = Game.time;
  }
}

function upsertTaskFromFlag(flag: Flag): void {
  const parsed = parseFlag(flag.name);
  if (!parsed) {
    console.log(`[cross-shard] ignore invalid flag format: ${flag.name}`);
    flag.remove();
    return;
  }

  const taskId = getTaskId(parsed.targetShard, parsed.targetRoom);
  const store = ensureTaskStore();
  const previous = store[taskId];
  const existing = previous && !["completed", "failed"].includes(previous.status) ? previous : undefined;
  const now = Game.time;

  store[taskId] = {
    targetShard: parsed.targetShard,
    targetRoom: parsed.targetRoom,
    preferredSourceRoom: parsed.preferredSourceRoom,
    sourceRoom: existing?.sourceRoom,
    status: existing?.status ?? "planning",
    flagName: flag.name,
    reason: existing?.reason,
    portalId: existing?.portalId,
    portalRoom: existing?.portalRoom,
    destinationRoom: existing?.destinationRoom,
    claimerConfigName: existing?.claimerConfigName,
    claimerName: existing?.claimerName,
    bootstrapConfigNames: existing?.bootstrapConfigNames,
    bootstrapDispatchedAt: existing?.bootstrapDispatchedAt,
    bootstrapLaunched: existing?.bootstrapLaunched,
    launchedAt: existing?.launchedAt,
    claimedAt: existing?.claimedAt,
    completedAt: existing?.completedAt,
    lastObservedAt: existing?.lastObservedAt,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastReadyAt: existing?.lastReadyAt,
    claimAttempts: existing?.claimAttempts,
    remoteObservedVersion: existing?.remoteObservedVersion,
    remoteAdvancedAt: existing?.remoteAdvancedAt,
  };

  flag.remove();
  const sourceHint = parsed.preferredSourceRoom ? ` preferredSource=${parsed.preferredSourceRoom}` : "";
  console.log(
    `[cross-shard] flag accepted: ${flag.name} targetShard=${parsed.targetShard} targetRoom=${parsed.targetRoom}${sourceHint}`,
  );
}

export function getCrossShardColonizationSummaries(limit = 20): CrossShardTaskSummary[] {
  const store = Memory.data?.crossShardColonization;
  if (!store) {
    return [];
  }

  return Object.entries(store)
    .map(([id, task]) => ({
      id,
      targetShard: task.targetShard,
      targetRoom: task.targetRoom,
      status: task.status,
      sourceRoom: task.sourceRoom,
      portalId: task.portalId,
      updatedAt: task.updatedAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

/** 唯一任务删除规则；中央 GC 和运行循环共用，活体/出生引用优先于 TTL。 */
export function cleanupCrossShardColonizationTasks(): number {
  const store = Memory.data?.crossShardColonization;
  if (!store) return 0;
  let removed = 0;
  for (const [id, task] of Object.entries(store)) {
    if (!["completed", "failed"].includes(task.status) || Game.time - (task.completedAt ?? task.updatedAt) <= 5000) continue;
    if (hasTaskActors(getAllTaskConfigNames(task), undefined, task.claimerName ? [task.claimerName] : [])) continue;
    cleanupTaskConfigs(task);
    delete store[id]; removed++;
  }
  return removed;
}

export function runCrossShardColonizationByFlag(): void {
  for (const flag of getCrossShardFlags()) {
    upsertTaskFromFlag(flag);
  }

  cleanupCrossShardColonizationTasks();
  const store = ensureTaskStore();
  for (const task of Object.values(store)) {
    if (task.status === "blocked" && Game.time - (task.lastReadyAt ?? task.createdAt) > 5000) {
      cleanupTaskConfigs(task); taskLifecycle.transition(task, "failed"); task.reason = "blocked_timeout"; task.completedAt = Game.time;
    }
    if (["completed", "failed"].includes(task.status)) { task.completedAt ??= Game.time; continue; }
    if ((task.bootstrapConfigNames ?? []).some(name => getLiveCreepsByConfig(name).length > 0 || isConfigSpawning(name))) task.bootstrapLaunched = true;
    if (task.sourceRoom && isDefenseMode(task.sourceRoom)) {
      const neverLaunched = !task.bootstrapLaunched && (task.bootstrapConfigNames ?? []).every(name =>
        getLiveCreepsByConfig(name).length === 0 && !isConfigSpawning(name));
      cleanupTaskConfigs(task);
      if (neverLaunched) { task.bootstrapDispatchedAt = undefined; task.bootstrapConfigNames = undefined; }
      task.updatedAt = Game.time;
      continue;
    }

    processTask(task);
    task.updatedAt = Game.time;
  }
}

/** 新 claim 不从 RESERVE 借款；已确认占领的跨 shard bootstrap 继续完成已投入任务。 */
export const crossShardColonizationMissionOwner: OutboundMissionOwner = {
  id: "crossShardColonization",
  matches: (_name, config) => ["crossShardClaimer", "crossShardColonizerHarvester", "crossShardColonizerWorker"].includes(config.role),
  evaluate(name, config, mode) {
    const task = Object.values(Memory.data?.crossShardColonization ?? {}).find(task =>
      task.sourceRoom === mode.sourceRoom && config.args[0] === task.targetShard && config.args[1] === task.targetRoom &&
      config.args[2] === task.portalRoom && getAllTaskConfigNames(task).includes(name));
    const bootstrap = config.role === "crossShardColonizerHarvester" || config.role === "crossShardColonizerWorker";
    return { intent: "expedition", committed: !!task && bootstrap && task.claimedAt !== undefined &&
      task.status !== "failed" && task.status !== "completed" && !!task.bootstrapConfigNames?.includes(name) };
  },
};

const TASK_STATUSES = ["planning","ready","spawning","in_transit","claimed","bootstrapping","completed","blocked","failed"] as const;
const taskLifecycle = createTaskLifecycle<CrossShardColonizationStatus, CrossShardColonizationTask>("crossShardColonization", { planning: TASK_STATUSES, ready: TASK_STATUSES, spawning: TASK_STATUSES, in_transit: TASK_STATUSES, claimed: TASK_STATUSES, bootstrapping: TASK_STATUSES, completed: ["completed"], blocked: TASK_STATUSES, failed: ["failed"] }, task => `${task.targetShard}:${task.targetRoom}`);
