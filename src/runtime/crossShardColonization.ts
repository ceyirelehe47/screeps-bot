import { spawnProfiles } from "@/config/spawnProfiles";
import { encodeCrossShardTravelerName } from "@/runtime/crossShardNaming";
import { getMemoryService } from "@/runtime/runtimeServices";
import type { CreepConfig } from "@/types/system";
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
  launchedAt?: number;
  claimedAt?: number;
  completedAt?: number;
  lastObservedAt?: number;
  createdAt: number;
  updatedAt: number;
  lastReadyAt?: number;
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
  shard: string;
  claims?: RemoteClaimSummary[];
  rooms?: RemoteRoomSummary[];
}

interface RemoteTargetState {
  claimAt?: number;
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

function ensureConfigStore(): Record<string, CreepConfig> {
  return getMemoryService().getCreepConfigStore();
}

function getInterShardPortals(): Record<string, InterShardPortalEntry> {
  return Memory.data?.interShardPortals || {};
}

function getBodyCost(body: BodyPartConstant[]): number {
  return body.reduce((sum, part) => sum + BODYPART_COST[part], 0);
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
      const distance = Game.map.getRoomLinearDistance(sourceRoom, portal.originRoom);
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

function getSpawnQueueLoad(spawn: StructureSpawn): number {
  return (spawn.spawning ? 1 : 0) + (spawn.memory.spawnList?.length ?? 0);
}

function selectLeastLoadedSpawn(spawns: StructureSpawn[]): StructureSpawn | undefined {
  if (spawns.length === 0) return undefined;

  return [...spawns].sort((left, right) => {
    const loadDiff = getSpawnQueueLoad(left) - getSpawnQueueLoad(right);
    if (loadDiff !== 0) return loadDiff;
    return left.name.localeCompare(right.name);
  })[0];
}

function getLiveCreepsByConfig(configName: string): Creep[] {
  return Object.values(Game.creeps).filter((creep) => creep.memory.configName === configName);
}

function isConfigSpawning(configName: string): boolean {
  const creepMemory = Memory.creeps || {};
  return Object.values(Game.spawns).some((spawn) => {
    if (!spawn.spawning) {
      return false;
    }

    return creepMemory[spawn.spawning.name]?.configName === configName;
  });
}

function enqueueConfig(spawn: StructureSpawn, configName: string, toFront: boolean): void {
  const queue = spawn.memory.spawnList || [];
  if (toFront) {
    spawn.memory.spawnList = [configName, ...queue.filter((name) => name !== configName)];
    return;
  }

  if (!queue.includes(configName)) {
    spawn.addTask(configName);
  }
}

function removeQueuedConfig(task: CrossShardColonizationTask, configName: string): void {
  if (!task.sourceRoom) {
    return;
  }

  for (const spawn of getSpawnsForRoom(task.sourceRoom)) {
    if (!spawn.memory.spawnList) {
      continue;
    }

    spawn.memory.spawnList = spawn.memory.spawnList.filter((name) => name !== configName);
  }
}

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
    delete store[configName];
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

function getRemoteState(targetShard: string, targetRoom: string): RemoteTargetState {
  if (typeof InterShardMemory === "undefined") {
    return { hasSpawn: false };
  }

  const remoteRaw = InterShardMemory.getRemote(targetShard);
  const payload = safeJsonParse<RemotePayload>(remoteRaw);
  if (!payload || payload.version !== INTER_SHARD_PROTOCOL_VERSION) {
    return { hasSpawn: false };
  }

  let claimAt: number | undefined;
  for (const claim of payload.claims || []) {
    if (claim.room !== targetRoom) {
      continue;
    }

    if (claimAt === undefined || claim.at > claimAt) {
      claimAt = claim.at;
    }
  }

  let hasSpawn = false;
  for (const room of payload.rooms || []) {
    if (room.room === targetRoom && room.hasSpawn) {
      hasSpawn = true;
      break;
    }
  }

  return { claimAt, hasSpawn };
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
      delete config.roomName;
    }

    removeConfigWhenIdle(configName);
  }
}

function markClaimed(task: CrossShardColonizationTask, claimedAt: number): void {
  task.status = "claimed";
  task.claimedAt = claimedAt;
  task.reason = undefined;

  if (task.claimerConfigName) {
    removeQueuedConfig(task, task.claimerConfigName);
    removeConfigWhenIdle(task.claimerConfigName);
  }
}

function markCompleted(task: CrossShardColonizationTask): void {
  task.status = "completed";
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
  if (!task.sourceRoom || !task.portalRoom) {
    task.status = "blocked";
    task.reason = "missing source room or portal room";
    return;
  }

  const configName = task.claimerConfigName || getTaskConfigName(task, "claimer", 0);
  task.claimerConfigName = configName;

  if (task.launchedAt && Game.time - task.launchedAt > CLAIM_RETRY_TTL) {
    removeQueuedConfig(task, configName);
    removeConfigWhenIdle(configName);
    task.launchedAt = undefined;
    task.claimerName = undefined;
    task.status = "planning";
    task.reason = `claimer retry after ${CLAIM_RETRY_TTL} ticks without remote claim`;
  }

  if (!task.claimerName) {
    task.claimerName = generateTravelerName("claimer", task, 0);
  }

  const configStore = ensureConfigStore();
  configStore[configName] = {
    role: "crossShardClaimer",
    args: [task.targetShard, task.targetRoom, task.portalRoom, task.destinationRoom || ""],
    roomName: task.sourceRoom,
    body: CLAIMER_BODY,
    name: task.claimerName,
  };

  const spawns = getSpawnsForRoom(task.sourceRoom);
  if (spawns.length === 0) {
    task.status = "blocked";
    task.reason = `source spawn missing in ${task.sourceRoom}`;
    return;
  }

  const liveCreeps = getLiveCreepsByConfig(configName);
  if (liveCreeps.length > 0) {
    if (!task.launchedAt) {
      task.launchedAt = Game.time;
    }
    task.lastObservedAt = Game.time;
    task.status = "spawning";
    task.reason = undefined;
    return;
  }

  if (isConfigSpawning(configName) || isConfigQueued(task, configName)) {
    task.status = "spawning";
    task.reason = undefined;
    return;
  }

  if (task.launchedAt) {
    task.status = "in_transit";
    task.reason = `claimer launched at ${task.launchedAt}, waiting remote claim`;
    if (configStore[configName]?.roomName) {
      delete configStore[configName].roomName;
    }
    removeQueuedConfig(task, configName);
    removeConfigWhenIdle(configName);
    return;
  }

  const targetSpawn = selectLeastLoadedSpawn(spawns);
  if (targetSpawn) enqueueConfig(targetSpawn, configName, true);
  task.status = "ready";
  task.reason = undefined;
}

function ensureBootstrapSquad(task: CrossShardColonizationTask): void {
  if (!task.sourceRoom || !task.portalRoom) {
    task.status = "blocked";
    task.reason = "missing source room or portal room for bootstrap";
    return;
  }

  const spawns = getSpawnsForRoom(task.sourceRoom);
  if (spawns.length === 0) {
    task.status = "blocked";
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
    task.reason = `bootstrap retry after ${BOOTSTRAP_RETRY_TTL} ticks without target spawn`;
  }

  if (task.bootstrapDispatchedAt) {
    const hasActiveBootstrapConfig = (task.bootstrapConfigNames || []).some((configName) => isConfigActive(task, configName));
    if (!hasActiveBootstrapConfig) {
      task.reason = "bootstrap squad dispatched, waiting target shard spawn";
    }

    task.status = "bootstrapping";
    return;
  }

  const configStore = ensureConfigStore();
  const bootstrapConfigNames: string[] = [];

  for (let i = 0; i < BOOTSTRAP_HARVESTER_COUNT; i++) {
    const configName = getTaskConfigName(task, "harvester", i);
    bootstrapConfigNames.push(configName);
    configStore[configName] = {
      role: "crossShardColonizerHarvester",
      args: [task.targetShard, task.targetRoom, task.portalRoom, task.destinationRoom || ""],
      body: spawnProfiles.crossShardColonizerHarvester(referenceSpawn.room),
      name: generateTravelerName("harvester", task, i),
    };
    const targetSpawn = selectLeastLoadedSpawn(spawns);
    if (targetSpawn) enqueueConfig(targetSpawn, configName, false);
  }

  for (let i = 0; i < BOOTSTRAP_WORKER_COUNT; i++) {
    const configName = getTaskConfigName(task, "worker", i);
    bootstrapConfigNames.push(configName);
    configStore[configName] = {
      role: "crossShardColonizerWorker",
      args: [task.targetShard, task.targetRoom, task.portalRoom, task.destinationRoom || ""],
      body: spawnProfiles.crossShardColonizerWorker(referenceSpawn.room),
      name: generateTravelerName("worker", task, i),
    };
    const targetSpawn = selectLeastLoadedSpawn(spawns);
    if (targetSpawn) enqueueConfig(targetSpawn, configName, false);
  }

  task.bootstrapConfigNames = bootstrapConfigNames;
  task.bootstrapDispatchedAt = Game.time;
  task.status = "bootstrapping";
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
    task.status = "failed";
    task.reason = "target shard equals current shard";
    return;
  }

  const remoteState = getRemoteState(task.targetShard, task.targetRoom);

  if (task.status !== "claimed" && task.status !== "bootstrapping") {
    if (remoteState.claimAt !== undefined) {
      markClaimed(task, remoteState.claimAt);
    }
  }

  if (task.status === "claimed" || task.status === "bootstrapping") {
    if (remoteState.hasSpawn) {
      markCompleted(task);
      return;
    }

    ensureBootstrapSquad(task);
    return;
  }

  const selected = selectSourceAndPortal(task.targetShard, task.preferredSourceRoom);
  if (!selected) {
    cleanupTaskConfigs(task);
    task.status = "blocked";
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
  const existing = store[taskId];
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
    launchedAt: existing?.launchedAt,
    claimedAt: existing?.claimedAt,
    completedAt: existing?.completedAt,
    lastObservedAt: existing?.lastObservedAt,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastReadyAt: existing?.lastReadyAt,
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

export function runCrossShardColonizationByFlag(): void {
  for (const flag of getCrossShardFlags()) {
    upsertTaskFromFlag(flag);
  }

  const store = ensureTaskStore();
  for (const task of Object.values(store)) {
    if (task.sourceRoom && isDefenseMode(task.sourceRoom)) {
      cleanupTaskConfigs(task);
      task.updatedAt = Game.time;
      continue;
    }

    processTask(task);
    task.updatedAt = Game.time;
  }
}
