import { searchPlanningPath } from "@/movement/pathSearch";
import { replaceSpawnQueue } from "@/runtime/spawnRequests";
import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { isOwnedManagedRoom } from "@/runtime/roomTypes";
import { isDefenseMode } from "@/runtime/defenseMode";
import { requestRemoteObservation } from "@/runtime/powerBankObserver";
import { claimHeavyPlanningSlot, hasPlanningCpuHeadroom } from "@/runtime/planningCpuBudget";

export type RemoteMiningStatus = "scouting" | "active" | "suspended" | "defending" | "abandoned";

export type RemoteSuspendReason =
  | "hostile_creeps"
  | "hostile_reservation"
  | "hostile_owner"
  | "hostile_structures"
  | "invader_core_insufficient_capacity"
  | "source_keeper";

export type RemoteDefenseReason = "npc_invader" | "npc_invader_core" | "player_aggression";

export interface DamageSnapshot {
  tick: number;
  hits: number;
  ticksToDecay?: number;
}

export interface DamageSnapshots {
  creeps: Record<string, DamageSnapshot>;
  containers: Record<string, DamageSnapshot>;
}

export interface RemoteMiningTask {
  sourceRoom: string;
  targetRoom: string;
  status: RemoteMiningStatus;
  sourceIds: string[];
  assignedAt: number;
  updatedAt: number;
  lastVerifiedAt?: number;
  suspendReason?: RemoteSuspendReason | string;
  suspendedAt?: number;
  lastThreatAt?: number;
  safeSince?: number;
  abandonedReason?: string;
  nextRetryAt?: number;
  roadPlan?: {
    positions: Array<{ x: number; y: number; roomName: string }>;
    generatedAt: number;
  };
  containerPositions?: Record<string, { x: number; y: number; roomName: string }>;
  defendingSince?: number;
  lastDefenseThreatAt?: number;
  defenseReason?: RemoteDefenseReason;
  lastDefenseSafeAt?: number;
  damageSnapshots?: DamageSnapshots;
}

export interface RemoteMiningConfig {
  enabled: boolean;
  scanInterval: number;
  roadInterval: number;
  scoutTimeout: number;
  maxRemoteRoomsPerSourceRoom: number;
  maintenanceReserveEnergy: number;
  maxRemoteSitesPerRun: number;
  remoteSafeTicksToResume: number;
  remoteReservationRenewAt: number;
}

export const REMOTE_MINING_DEFAULTS: RemoteMiningConfig = {
  enabled: true,
  scanInterval: 50,
  roadInterval: 100,
  scoutTimeout: 1500,
  maxRemoteRoomsPerSourceRoom: 1,
  maintenanceReserveEnergy: 100,
  maxRemoteSitesPerRun: 2,
  remoteSafeTicksToResume: 100,
  remoteReservationRenewAt: 3000,
};

/**
 * RCL7 满扩展容量。当前 remoteDefender profile 在该容量下生成
 * 16 RANGED_ATTACK / 7 HEAL / 23 MOVE，足以在生命周期内单兵清理
 * 100,000 hits 的 level 0 Invader Core。
 */
export const REMOTE_INVADER_CORE_MIN_SOURCE_CAPACITY = 5300;
const INVADER_USERNAME = "Invader";
const REMOTE_OBSERVER_SCOUT_GRACE = 25;
const REMOTE_OBSERVER_LEASE_LIMIT = 64;
const REMOTE_OBSERVER_LEASE_TTL = 500;

interface RemoteObserverLease {
  sourceRoom: string;
  targetRoom: string;
  assignedAt: number;
  firstAcceptedAt: number;
  lastRequestedAt: number;
  lastSeenAt?: number;
}

// 临时租约不写入 Memory；排队成功只给一次宽限，实际视野才续租。
const remoteObserverLeases = new Map<string, RemoteObserverLease>();
let remoteObserverGame: Game | undefined;
let remoteObserverTick: number | undefined;
let remoteObserverShard: string | undefined;

function syncRemoteObserverLeases(store: Record<string, RemoteMiningTask>): void {
  const now = Game.time;
  const shard = Game.shard?.name;
  // 正常前进的 tick 可以重建 Game；同 tick 换世界或时间倒退才清空租约。
  if (
    remoteObserverTick !== undefined &&
    (now < remoteObserverTick ||
      (now === remoteObserverTick && Game !== remoteObserverGame) ||
      shard !== remoteObserverShard)
  ) {
    remoteObserverLeases.clear();
  }
  remoteObserverGame = Game;
  remoteObserverTick = now;
  remoteObserverShard = shard;

  for (const [key, lease] of remoteObserverLeases) {
    const task = store[lease.targetRoom];
    if (
      now - lease.lastRequestedAt > REMOTE_OBSERVER_LEASE_TTL ||
      lease.firstAcceptedAt > now ||
      !task ||
      task.status === "abandoned" ||
      task.sourceRoom !== lease.sourceRoom ||
      task.assignedAt !== lease.assignedAt
    ) {
      remoteObserverLeases.delete(key);
    } else if (Game.rooms[lease.targetRoom]) {
      lease.lastSeenAt = now;
    }
  }
}

function observerCanReplaceScout(sourceRoom: string, targetRoom: string): boolean {
  const store = ensureRemoteMiningStore();
  syncRemoteObserverLeases(store);
  const key = `${sourceRoom}:${targetRoom}`;
  if (!requestRemoteObservation(targetRoom)) {
    remoteObserverLeases.delete(key);
    return false;
  }

  const task = store[targetRoom];
  if (!task || task.status === "abandoned" || task.sourceRoom !== sourceRoom) {
    return false;
  }
  let lease = remoteObserverLeases.get(key);
  if (!lease) {
    // 满额时直接回退，不淘汰活跃租约来反复重开首次宽限。
    if (remoteObserverLeases.size >= REMOTE_OBSERVER_LEASE_LIMIT) return false;
    lease = {
      sourceRoom,
      targetRoom,
      assignedAt: task.assignedAt,
      firstAcceptedAt: Game.time,
      lastRequestedAt: Game.time,
    };
    remoteObserverLeases.set(key, lease);
  }
  lease.lastRequestedAt = Game.time;
  if (Game.rooms[targetRoom]) lease.lastSeenAt = Game.time;
  return (
    (lease.lastSeenAt !== undefined && Game.time - lease.lastSeenAt <= REMOTE_OBSERVER_SCOUT_GRACE) ||
    Game.time - lease.firstAcceptedAt <= REMOTE_OBSERVER_SCOUT_GRACE
  );
}

// Only cardinal neighbours (1/3/5/7) are candidates — diagonal rooms require multi-hop
// logistics and are excluded to keep CPU and carrier travel time bounded.
const CARDINAL_EXIT_DIRECTIONS = [FIND_EXIT_TOP, FIND_EXIT_RIGHT, FIND_EXIT_BOTTOM, FIND_EXIT_LEFT];

export function getRemoteMiningConfig(): RemoteMiningConfig {
  const overrides = Memory.cfg?.remoteMining;
  if (!overrides) {
    return { ...REMOTE_MINING_DEFAULTS };
  }
  return {
    enabled: overrides.enabled !== false,
    scanInterval: overrides.scanInterval ?? REMOTE_MINING_DEFAULTS.scanInterval,
    roadInterval: overrides.roadInterval ?? REMOTE_MINING_DEFAULTS.roadInterval,
    scoutTimeout: overrides.scoutTimeout ?? REMOTE_MINING_DEFAULTS.scoutTimeout,
    maxRemoteRoomsPerSourceRoom:
      overrides.maxRemoteRoomsPerSourceRoom ?? REMOTE_MINING_DEFAULTS.maxRemoteRoomsPerSourceRoom,
    maintenanceReserveEnergy: overrides.maintenanceReserveEnergy ?? REMOTE_MINING_DEFAULTS.maintenanceReserveEnergy,
    maxRemoteSitesPerRun: overrides.maxRemoteSitesPerRun ?? REMOTE_MINING_DEFAULTS.maxRemoteSitesPerRun,
    remoteSafeTicksToResume: overrides.remoteSafeTicksToResume ?? REMOTE_MINING_DEFAULTS.remoteSafeTicksToResume,
    remoteReservationRenewAt: overrides.remoteReservationRenewAt ?? REMOTE_MINING_DEFAULTS.remoteReservationRenewAt,
  };
}

export function ensureRemoteMiningStore(): Record<string, RemoteMiningTask> {
  const data = getMemoryService().ensureData();
  if (!data.remoteMining) {
    data.remoteMining = {};
  }
  return data.remoteMining;
}

export function getRemoteMiningHarvesterConfigName(
  sourceRoom: string,
  targetRoom: string,
  sourceId: string,
): string {
  return `${sourceRoom}:remoteMine:${targetRoom}:harvester:${sourceId}`;
}

export function getRemoteMiningCarrierConfigName(
  sourceRoom: string,
  targetRoom: string,
  index: number,
): string {
  return `${sourceRoom}:remoteMine:${targetRoom}:carrier:${index}`;
}

export function getRemoteMiningScoutConfigName(
  sourceRoom: string,
  targetRoom: string,
): string {
  return `${sourceRoom}:remoteMine:${targetRoom}:scout`;
}

export function getRemoteMiningReserverConfigName(
  sourceRoom: string,
  targetRoom: string,
): string {
  return `${sourceRoom}:remoteMine:${targetRoom}:reserver:0`;
}

export function getRemoteWorkerConfigName(
  sourceRoom: string,
  targetRoom: string,
): string {
  return `${sourceRoom}:remoteMine:${targetRoom}:worker:0`;
}

export function getRemoteDefenderConfigName(
  sourceRoom: string,
  targetRoom: string,
): string {
  return `${sourceRoom}:remoteMine:${targetRoom}:defender:0`;
}

function isRouteDirect(sourceRoom: string, targetRoom: string): boolean {
  const route = Game.map.findRoute(sourceRoom, targetRoom);
  if (route === ERR_NO_PATH || !Array.isArray(route)) {
    return false;
  }
  return route.length === 1;
}

function isRoomStatusNormal(roomName: string): boolean {
  return Game.map.getRoomStatus(roomName).status === "normal";
}
export function getRemoteThreatReason(room: Room): RemoteSuspendReason | null {
  const controller = room.controller;
  const invaderCores = getInvaderCores(room);

  if (controller?.owner && !controller.my) {
    return "hostile_owner";
  }

  if (
    controller?.reservation &&
    controller.reservation.username !== getMyUsername() &&
    controller.reservation.username !== INVADER_USERNAME
  ) {
    return "hostile_reservation";
  }

  // Level 0 Core is handled by the active remote-defense lifecycle. Higher-level
  // Strongholds remain a passive threat because a single remoteDefender is not a
  // sufficient or safe clearance force. Abandoned player structures stay ignored.
  if (invaderCores.some(core => core.level > 0)) {
    return "hostile_structures";
  }

  const keeperLairs = room.find(FIND_STRUCTURES, {
    filter: (structure) => structure.structureType === STRUCTURE_KEEPER_LAIR,
  });
  if (keeperLairs.length > 0) {
    return "source_keeper";
  }

  return null;
}

function getInvaderCores(room: Room): StructureInvaderCore[] {
  return room.find(FIND_HOSTILE_STRUCTURES, {
    filter: (structure) => structure.structureType === STRUCTURE_INVADER_CORE,
  }) as StructureInvaderCore[];
}

function getSupportedInvaderCore(room: Room): StructureInvaderCore | null {
  return getInvaderCores(room).find(core => core.level === 0) ?? null;
}

function hasActiveInvaderCoreInvulnerability(core: StructureInvaderCore): boolean {
  return (core.effects ?? []).some(
    effect => effect.effect === EFFECT_INVULNERABILITY && effect.ticksRemaining > 0,
  );
}

function hasInvaderCoreClearanceCapacity(task: RemoteMiningTask): boolean {
  const sourceRoom = Game.rooms[task.sourceRoom];
  return !!sourceRoom && sourceRoom.energyCapacityAvailable >= REMOTE_INVADER_CORE_MIN_SOURCE_CAPACITY;
}

function hasNpcInvaderCreep(room: Room): boolean {
  const hostiles = room.find(FIND_HOSTILE_CREEPS);
  return hostiles.some(c => (c.owner as { username: string } | undefined)?.username === INVADER_USERNAME);
}

function hasPlayerHostileCreeps(room: Room): boolean {
  const hostiles = room.find(FIND_HOSTILE_CREEPS);
  return hostiles.some(c => {
    const username = (c.owner as { username: string } | undefined)?.username;
    return username && username !== INVADER_USERNAME;
  });
}

const SNAPSHOT_STALE_TICKS = 150;

function snapshotCreepHits(
  task: RemoteMiningTask,
  creeps: Creep[],
): void {
  if (creeps.length === 0 && !task.damageSnapshots) return;
  if (!task.damageSnapshots) {
    task.damageSnapshots = { creeps: {}, containers: {} };
  }
  const snapshots = task.damageSnapshots;
  const now = Game.time;
  const validIds = new Set<string>();

  for (const creep of creeps) {
    validIds.add(creep.id);
    const prev = snapshots.creeps[creep.id];
    if (prev && now - prev.tick >= SNAPSHOT_STALE_TICKS) {
      // Re-baseline stale snapshots; do not trigger player aggression from old baselines
      snapshots.creeps[creep.id] = { tick: now, hits: creep.hits };
    } else {
      snapshots.creeps[creep.id] = { tick: now, hits: creep.hits };
    }
  }

  for (const id of Object.keys(snapshots.creeps)) {
    if (!validIds.has(id)) {
      delete snapshots.creeps[id];
    }
  }
}

function hasContainersNearSources(task: RemoteMiningTask, room: Room): boolean {
  for (const sourceId of task.sourceIds) {
    const source = Game.getObjectById?.(sourceId as Id<Source>) ?? null;
    if (!source) continue;
    const containers = room.find(FIND_STRUCTURES).filter(
      s =>
        s.structureType === STRUCTURE_CONTAINER &&
        Math.abs(s.pos.x - source.pos.x) <= 2 &&
        Math.abs(s.pos.y - source.pos.y) <= 2,
    );
    if (containers.length > 0) return true;
  }
  return false;
}

function snapshotContainerHits(
  task: RemoteMiningTask,
  room: Room,
): void {
  if (!task.damageSnapshots && !hasContainersNearSources(task, room)) return;
  if (!task.damageSnapshots) {
    task.damageSnapshots = { creeps: {}, containers: {} };
  }
  const snapshots = task.damageSnapshots;
  const now = Game.time;
  const validIds = new Set<string>();

  for (const sourceId of task.sourceIds) {
    const source = Game.getObjectById?.(sourceId as Id<Source>) ?? null;
    if (!source) continue;

    const containers = room.find(FIND_STRUCTURES).filter(
      s =>
        s.structureType === STRUCTURE_CONTAINER &&
        Math.abs(s.pos.x - source.pos.x) <= 2 &&
        Math.abs(s.pos.y - source.pos.y) <= 2,
    ) as StructureContainer[];

    for (const container of containers) {
      validIds.add(container.id);
      snapshots.containers[container.id] = { tick: now, hits: container.hits, ticksToDecay: container.ticksToDecay };
    }
  }

  for (const id of Object.keys(snapshots.containers)) {
    if (!validIds.has(id)) {
      delete snapshots.containers[id];
    }
  }
}

function detectPlayerAggression(
  task: RemoteMiningTask,
  creeps: Creep[],
  room: Room,
): boolean {
  if (!task.damageSnapshots) return false;
  const snapshots = task.damageSnapshots;
  const now = Game.time;

  for (const creep of creeps) {
    const prev = snapshots.creeps[creep.id];
    if (!prev) continue;
    if (now - prev.tick >= SNAPSHOT_STALE_TICKS) continue;
    if (creep.hits < prev.hits) return true;
  }

  for (const sourceId of task.sourceIds) {
    const source = Game.getObjectById?.(sourceId as Id<Source>) ?? null;
    if (!source) continue;

    const containers = room.find(FIND_STRUCTURES).filter(
      s =>
        s.structureType === STRUCTURE_CONTAINER &&
        Math.abs(s.pos.x - source.pos.x) <= 2 &&
        Math.abs(s.pos.y - source.pos.y) <= 2,
    ) as StructureContainer[];

    for (const container of containers) {
      const prev = snapshots.containers[container.id];
      if (!prev) continue;
      if (now - prev.tick >= SNAPSHOT_STALE_TICKS) continue;
      if (container.hits < prev.hits) {
        const isOwnedRoom = room.controller?.my === true;
        const decayInterval = isOwnedRoom ? CONTAINER_DECAY_TIME_OWNED : CONTAINER_DECAY_TIME;
        const ticksSinceSnapshot = now - prev.tick;
        const firstDecay = prev.ticksToDecay ?? (container.ticksToDecay >= decayInterval - ticksSinceSnapshot ? ticksSinceSnapshot : decayInterval);
        const decayIntervals = ticksSinceSnapshot >= firstDecay ? 1 + Math.floor((ticksSinceSnapshot - firstDecay) / decayInterval) : 0;
        const expectedDecay = decayIntervals * CONTAINER_DECAY;
        const actualLoss = prev.hits - container.hits;
        if (actualLoss > expectedDecay) return true;
      }
    }
  }

  return false;
}

function getOwnRemoteCreeps(task: RemoteMiningTask): Creep[] {
  const prefix = `${task.sourceRoom}:remoteMine:${task.targetRoom}:`;
  const result: Creep[] = [];
  for (const creep of getTickContextService().getAllCreeps()) {
    const configName = creep.memory.configName;
    if (configName && configName.startsWith(prefix)) {
      result.push(creep);
    }
  }
  return result;
}

/**
 * Determines whether a remote mining room requires active defense.
 *
 * Player aggression policy: player presence alone, regardless of body parts
 * (ATTACK, RANGED_ATTACK, HEAL, etc.), is NEVER sufficient to trigger a state
 * change. Only observed damage to our creeps or source containers (via hit
 * point snapshots) constitutes player aggression. This is a deliberate design
 * choice to avoid overreacting to passing players who are not attacking us.
 */
export function getActiveDefenseReason(room: Room, task: RemoteMiningTask): RemoteDefenseReason | null {
  if (hasNpcInvaderCreep(room)) {
    return "npc_invader";
  }

  const ownCreeps = getOwnRemoteCreeps(task);

  // Player present: detect aggression BEFORE updating snapshots so the
  // comparison uses the previous baseline. Damage snapshots are required;
  // player presence alone does not trigger defending.
  if (hasPlayerHostileCreeps(room)) {
    const playerAggressive = detectPlayerAggression(task, ownCreeps, room);

    snapshotCreepHits(task, ownCreeps);
    snapshotContainerHits(task, room);

    if (playerAggressive) {
      return "player_aggression";
    }
  } else {
    snapshotCreepHits(task, ownCreeps);
    snapshotContainerHits(task, room);
  }

  return getSupportedInvaderCore(room) ? "npc_invader_core" : null;
}

function isRemoteRoomSafe(room: Room): boolean {
  // Candidate discovery must not turn an unproven room into a combat mission.
  // Core clearance is only available to an already-established remote task.
  return getRemoteThreatReason(room) === null && getInvaderCores(room).length === 0;
}

export function getMyUsername(): string | null {
  const firstSpawn = Object.values(Game.spawns)[0];
  if (firstSpawn) {
    return firstSpawn.owner.username;
  }
  const firstCreep = getTickContextService().getAllCreeps()[0];
  if (firstCreep) {
    return firstCreep.owner.username;
  }
  return null;
}

function countSourceRoomRemotes(store: Record<string, RemoteMiningTask>, sourceRoom: string): number {
  let count = 0;
  for (const task of Object.values(store)) {
    if (task.sourceRoom === sourceRoom && task.status !== "abandoned") {
      count++;
    }
  }
  return count;
}

export function upsertScoutConfig(sourceRoom: string, targetRoom: string): void {
  if (observerCanReplaceScout(sourceRoom, targetRoom)) {
    removeScoutConfigAndSpawnQueues(sourceRoom, targetRoom);
    return;
  }
  const configName = getRemoteMiningScoutConfigName(sourceRoom, targetRoom);
  getCreepConfigService().upsert(configName, "scout", [targetRoom], sourceRoom);
}

function removeScoutConfig(sourceRoom: string, targetRoom: string): void {
  const configName = getRemoteMiningScoutConfigName(sourceRoom, targetRoom);
  const creepConfigs = getCreepConfigService();
  const tickContext = getTickContextService();
  const liveCreeps = tickContext.getCreepsByConfigName(configName);

  if (liveCreeps.length > 0) {
    const config = creepConfigs.get(configName);
    if (config) {
      getCreepConfigService().detachSpawn(configName);
    }
  } else {
    creepConfigs.remove(configName);
  }
}

function removeScoutConfigAndSpawnQueues(sourceRoom: string, targetRoom: string): void {
  removeScoutConfig(sourceRoom, targetRoom);
  removeScoutFromSpawnQueues(sourceRoom, targetRoom);
}

function removeScoutFromSpawnQueues(sourceRoom: string, targetRoom: string): void {
  const configName = getRemoteMiningScoutConfigName(sourceRoom, targetRoom);
  const tickContext = getTickContextService();
  for (const spawn of tickContext.getSpawnsByRoom(sourceRoom)) {
    const queue = spawn.memory.spawnList;
    if (!queue || queue.length === 0) {
      continue;
    }
    replaceSpawnQueue(spawn, queue.filter(name => name !== configName));
  }
}

function abandonTask(
  task: RemoteMiningTask,
  reason: "not_dual_source" | "unsafe" | "not_normal" | "not_direct" | "scout_timeout" | "owned_room",
): void {
  task.status = "abandoned";
  task.abandonedReason = reason;
  task.updatedAt = Game.time;
  task.nextRetryAt = Game.time + 5000;
}

function processScoutLifecycle(store: Record<string, RemoteMiningTask>, config: RemoteMiningConfig): void {
  const now = Game.time;

  for (const task of Object.values(store)) {
    if (task.status !== "scouting") {
      continue;
    }

    if (now - task.assignedAt > config.scoutTimeout) {
      abandonTask(task, "scout_timeout");
      removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
      removeScoutConfig(task.sourceRoom, task.targetRoom);
      continue;
    }

    upsertScoutConfig(task.sourceRoom, task.targetRoom);

    const visibleRoom = Game.rooms[task.targetRoom];
    if (!visibleRoom) {
      continue;
    }

    if (!isRouteDirect(task.sourceRoom, task.targetRoom)) {
      abandonTask(task, "not_direct");
      removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
      removeScoutConfig(task.sourceRoom, task.targetRoom);
      continue;
    }

    if (!isRoomStatusNormal(task.targetRoom)) {
      abandonTask(task, "not_normal");
      removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
      removeScoutConfig(task.sourceRoom, task.targetRoom);
      continue;
    }

    const sources = visibleRoom.find(FIND_SOURCES);
    if (sources.length !== 2) {
      abandonTask(task, "not_dual_source");
      removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
      removeScoutConfig(task.sourceRoom, task.targetRoom);
      continue;
    }

    if (visibleRoom.controller?.my) {
      abandonTask(task, "owned_room");
      removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
      removeScoutConfig(task.sourceRoom, task.targetRoom);
      continue;
    }

    if (!isRemoteRoomSafe(visibleRoom)) {
      abandonTask(task, "unsafe");
      removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
      removeScoutConfig(task.sourceRoom, task.targetRoom);
      continue;
    }

    task.status = "active";
    task.sourceIds = sources.map((s) => s.id);
    task.updatedAt = now;
    task.lastVerifiedAt = now;

    removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
    removeScoutConfig(task.sourceRoom, task.targetRoom);
  }
}

// ─── Remote road/container construction ─────────────────────────────

const GLOBAL_SITE_SOFT_CAP = 75;
const REMOTE_ROAD_PATH_MAX_OPS = 10000;
const REMOTE_ROAD_PATH_MAX_ROOMS = 16;

function getStartAnchor(sourceRoom: Room): RoomPosition | null {
  if (sourceRoom.storage) {
    return sourceRoom.storage.pos;
  }
  const spawn = getTickContextService().getPrimarySpawnByRoom(sourceRoom.name);
  if (spawn) {
    return spawn.pos;
  }
  if (sourceRoom.controller) {
    return sourceRoom.controller.pos;
  }
  return null;
}

function isWalkableTile(x: number, y: number): boolean {
  return x > 0 && x < 49 && y > 0 && y < 49;
}

function getAdjacentTiles(pos: RoomPosition): Array<{ x: number; y: number }> {
  const tiles: Array<{ x: number; y: number }> = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const nx = pos.x + dx;
      const ny = pos.y + dy;
      if (isWalkableTile(nx, ny)) {
        tiles.push({ x: nx, y: ny });
      }
    }
  }
  return tiles;
}

const BLOCKING_STRUCTURE_TYPES: Set<StructureConstant> = new Set([
  STRUCTURE_SPAWN, STRUCTURE_EXTENSION, STRUCTURE_TOWER, STRUCTURE_WALL,
  STRUCTURE_RAMPART, STRUCTURE_LINK, STRUCTURE_STORAGE, STRUCTURE_TERMINAL,
  STRUCTURE_NUKER, STRUCTURE_FACTORY, STRUCTURE_OBSERVER, STRUCTURE_POWER_SPAWN,
  STRUCTURE_LAB, STRUCTURE_EXTRACTOR,
]);

function isTileBlockedByStructure(room: Room, x: number, y: number): boolean {
  const pos = new RoomPosition(x, y, room.name);
  const structures = pos.lookFor(LOOK_STRUCTURES);
  for (const s of structures) {
    if (BLOCKING_STRUCTURE_TYPES.has(s.structureType)) return true;
  }
  const sites = pos.lookFor(LOOK_CONSTRUCTION_SITES);
  for (const site of sites) {
    if (BLOCKING_STRUCTURE_TYPES.has(site.structureType)) return true;
  }
  return false;
}

function selectContainerPosition(
  source: Source,
  pathPositions: Array<{ x: number; y: number; roomName: string }>,
  claimedKeys?: Set<string>,
): { x: number; y: number; roomName: string } | null {
  const room = source.room;
  const pathSet = new Set(pathPositions.filter(p => p.roomName === room.name).map(p => `${p.x}:${p.y}`));
  const adjacent = getAdjacentTiles(source.pos);
  const terrain = room.getTerrain();

  for (const tile of adjacent) {
    if (claimedKeys?.has(`${tile.x}:${tile.y}`)) continue;
    const terrainType = terrain.get(tile.x, tile.y);
    if (terrainType === TERRAIN_MASK_WALL) continue;
    if (isTileBlockedByStructure(room, tile.x, tile.y)) continue;
    if (pathSet.has(`${tile.x}:${tile.y}`)) {
      return { x: tile.x, y: tile.y, roomName: room.name };
    }
  }

  for (const tile of adjacent) {
    if (claimedKeys?.has(`${tile.x}:${tile.y}`)) continue;
    const terrainType = terrain.get(tile.x, tile.y);
    if (terrainType === TERRAIN_MASK_WALL) continue;
    if (isTileBlockedByStructure(room, tile.x, tile.y)) continue;
    return { x: tile.x, y: tile.y, roomName: room.name };
  }

  return null;
}

/**
 * Plan container positions for all sources. Tiles claimed by earlier sources
 * in this pass are excluded so closely-spaced sources get distinct containers.
 */
function generateContainerPositions(
  task: RemoteMiningTask,
  pathPositions: Array<{ x: number; y: number; roomName: string }>,
): Record<string, { x: number; y: number; roomName: string }> {
  const containers: Record<string, { x: number; y: number; roomName: string }> = {};
  const claimedKeys = new Set<string>();
  for (const sourceId of task.sourceIds) {
    const source = Game.getObjectById(sourceId as Id<Source>);
    if (!source) continue;
    const containerPos = selectContainerPosition(source, pathPositions, claimedKeys);
    if (containerPos) {
      containers[sourceId] = containerPos;
      claimedKeys.add(`${containerPos.x}:${containerPos.y}`);
    }
  }
  return containers;
}

function hasExactRoadOrSite(room: Room, x: number, y: number, structureType: BuildableStructureConstant): boolean {
  const pos = new RoomPosition(x, y, room.name);
  const structures = pos.lookFor(LOOK_STRUCTURES);
  if (structures.some(s => s.structureType === structureType)) return true;
  const sites = pos.lookFor(LOOK_CONSTRUCTION_SITES);
  if (sites.some(s => s.structureType === structureType)) return true;
  return false;
}

function hasContainerNearPosition(
  room: Room,
  sourcePos: RoomPosition,
  range: number = 2,
  excludedPositions?: Set<string>,
): boolean {
  const containers = room.find(FIND_STRUCTURES).filter(s =>
    s.structureType === STRUCTURE_CONTAINER &&
    Math.abs(s.pos.x - sourcePos.x) <= range &&
    Math.abs(s.pos.y - sourcePos.y) <= range &&
    !excludedPositions?.has(`${s.pos.x}:${s.pos.y}`),
  );
  if (containers.length > 0) return true;

  const sites = room.find(FIND_CONSTRUCTION_SITES).filter(s =>
    s.structureType === STRUCTURE_CONTAINER &&
    (s as ConstructionSite).my &&
    Math.abs(s.pos.x - sourcePos.x) <= range &&
    Math.abs(s.pos.y - sourcePos.y) <= range &&
    !excludedPositions?.has(`${s.pos.x}:${s.pos.y}`),
  );
  return sites.length > 0;
}

function generateRoadPlan(
  task: RemoteMiningTask,
): { positions: Array<{ x: number; y: number; roomName: string }>; containers: Record<string, { x: number; y: number; roomName: string }> } | null {
  const sourceRoom = Game.rooms[task.sourceRoom];
  if (!sourceRoom) {
    return null;
  }

  const startPos = getStartAnchor(sourceRoom);
  if (!startPos) {
    return null;
  }

  const allPositions: Array<{ x: number; y: number; roomName: string }> = [];
  const containers: Record<string, { x: number; y: number; roomName: string }> = {};
  // Track planned road positions from earlier source paths so later paths prefer them
  const plannedKeys = new Set<string>();
  // Track container tiles claimed by earlier sources so close neighbours get distinct containers
  const plannedContainerKeys = new Set<string>();

  // Pre-seed with existing roads/construction sites in the target room
  const targetRoomObj = Game.rooms[task.targetRoom];
  if (targetRoomObj) {
    const existingRoads = targetRoomObj.find(FIND_STRUCTURES).filter(s => s.structureType === STRUCTURE_ROAD);
    for (const r of existingRoads) {
      plannedKeys.add(`${r.pos.x}:${r.pos.y}`);
    }
    const existingSites = targetRoomObj.find(FIND_CONSTRUCTION_SITES).filter(s => s.structureType === STRUCTURE_ROAD);
    for (const s of existingSites) {
      plannedKeys.add(`${s.pos.x}:${s.pos.y}`);
    }
  }

  for (const sourceId of task.sourceIds) {
    const source = Game.getObjectById(sourceId as Id<Source>);
    if (!source) {
      return null;
    }

    // Build a roomCallback that makes planned positions cheap to encourage reuse
    const roomCallback = (roomName: string) => {
      const cm = new PathFinder.CostMatrix();
      if (roomName === task.targetRoom) {
        for (const key of plannedKeys) {
          const [sx, sy] = key.split(":").map(Number);
          cm.set(sx, sy, 1);
        }
      }
      return cm;
    };

    if (!hasPlanningCpuHeadroom()) return null;
    const result = searchPlanningPath(
      startPos,
      { pos: source.pos, range: 1 },
      {
        maxRooms: REMOTE_ROAD_PATH_MAX_ROOMS,
        maxOps: REMOTE_ROAD_PATH_MAX_OPS,
        plainCost: 2,
        swampCost: 10,
        roomCallback,
      },
    );

    if (result.incomplete) {
      return null;
    }

    for (const pos of result.path) {
      if (pos.roomName === task.targetRoom) {
        const key = `${pos.x}:${pos.y}`;
        plannedKeys.add(key);
        allPositions.push({ x: pos.x, y: pos.y, roomName: pos.roomName });
      }
    }

    const containerPos = selectContainerPosition(source, allPositions, plannedContainerKeys);
    if (containerPos) {
      containers[sourceId] = containerPos;
      plannedContainerKeys.add(`${containerPos.x}:${containerPos.y}`);
    }
  }

  // Deduplicate positions by roomName:x:y (shared corridor segments)
  const seen = new Set<string>();
  const deduped: Array<{ x: number; y: number; roomName: string }> = [];
  for (const p of allPositions) {
    const k = `${p.roomName}:${p.x}:${p.y}`;
    if (!seen.has(k)) {
      seen.add(k);
      deduped.push(p);
    }
  }

  return { positions: deduped, containers };
}

let roadPlanningGame: Game | undefined;
let roadPlanningTick = -1;
let roadPlanningCursor = 0;

function isRoadPlanDue(task: RemoteMiningTask, config: RemoteMiningConfig): boolean {
  return !task.roadPlan || Game.time < task.roadPlan.generatedAt ||
    Game.time - task.roadPlan.generatedAt >= config.roadInterval;
}

export function processRemoteConstruction(
  store: Record<string, RemoteMiningTask>,
  config: RemoteMiningConfig,
): void {
  if (Memory.cfg?.roomPlannerBuild?.enabled === false) {
    return;
  }

  const activePositions = new Set(Object.values(store).filter(task => task.status !== "abandoned").flatMap(task => [
    ...(task.roadPlan?.positions ?? []), ...Object.values(task.containerPositions ?? {})
  ]).map(pos => `${pos.roomName}:${pos.x}:${pos.y}`));
  const sitesByPosition = new Map<string, ConstructionSite[]>();
  for (const site of Object.values(Game.constructionSites ?? {})) {
    const key = `${site.pos.roomName}:${site.pos.x}:${site.pos.y}`;
    const entries = sitesByPosition.get(key) ?? [];
    entries.push(site);
    sitesByPosition.set(key, entries);
  }
  for (const task of Object.values(store).filter(task => task.status === "abandoned")) {
    for (const pos of [...(task.roadPlan?.positions ?? []), ...Object.values(task.containerPositions ?? {})]) {
      if (Game.rooms[pos.roomName]?.controller?.my || activePositions.has(`${pos.roomName}:${pos.x}:${pos.y}`)) continue;
      for (const site of sitesByPosition.get(`${pos.roomName}:${pos.x}:${pos.y}`) ?? []) {
        if (site.structureType === STRUCTURE_ROAD || site.structureType === STRUCTURE_CONTAINER) site.remove();
      }
    }
  }
  const globalSiteCount = Object.keys(Game.constructionSites ?? {}).length;
  if (globalSiteCount >= GLOBAL_SITE_SOFT_CAP) {
    return;
  }

  const tasks = Object.values(store);
  const candidates = tasks.filter(task => task.status === "active" && task.sourceIds.length > 0)
    .sort((left, right) => left.targetRoom.localeCompare(right.targetRoom));
  if (Game.time < roadPlanningTick || (Game.time === roadPlanningTick && roadPlanningGame !== Game)) {
    roadPlanningCursor = 0;
  }
  roadPlanningGame = Game;
  roadPlanningTick = Game.time;
  let selectedTask: RemoteMiningTask | undefined;
  // 失败也推进游标；没有视野的任务不抢名额。延后不消费 generatedAt。
  for (let offset = 0; offset < candidates.length; offset += 1) {
    const task = candidates[(roadPlanningCursor + offset) % candidates.length];
    if (Game.rooms[task.sourceRoom] && Game.rooms[task.targetRoom] &&
        !Game.rooms[task.targetRoom].controller?.my && isRoadPlanDue(task, config)) {
      selectedTask = task;
      break;
    }
  }

  for (const task of tasks) {
    if (task.status !== "active") continue;

    const visibleTarget = Game.rooms[task.targetRoom];
    if (visibleTarget && visibleTarget.controller?.my) continue;

    if (task === selectedTask && claimHeavyPlanningSlot()) {
      roadPlanningCursor = candidates.indexOf(task) + 1;
      const plan = generateRoadPlan(task);
      if (plan) {
        task.roadPlan = {
          positions: plan.positions,
          generatedAt: Game.time,
        };
        task.containerPositions = plan.containers;
      }
    }

    // Container planning is decoupled from road planning: a remote whose road
    // PathFinder fails must still get containers, otherwise it never builds any.
    const targetVisibleForContainers = Game.rooms[task.targetRoom];
    const containerPlanMissing = !task.containerPositions ||
      task.sourceIds.some(id => !task.containerPositions![id]);
    if (
      targetVisibleForContainers &&
      typeof targetVisibleForContainers.getTerrain === "function" &&
      task.sourceIds.length > 0 &&
      containerPlanMissing
    ) {
      const existingPath = task.roadPlan?.positions ?? [];
      task.containerPositions = generateContainerPositions(task, existingPath);
    }

    const hasRoads = !!task.roadPlan && task.roadPlan.positions.length > 0;
    const hasContainers = !!task.containerPositions && Object.keys(task.containerPositions).length > 0;
    if (!hasRoads && !hasContainers) continue;

    let sitesPlaced = 0;
    let globalRemaining = GLOBAL_SITE_SOFT_CAP - Object.keys(Game.constructionSites ?? {}).length;

    const containerKeySet = new Set<string>();
    if (task.containerPositions) {
      for (const sourceId of task.sourceIds) {
        if (sitesPlaced >= config.maxRemoteSitesPerRun) break;
        if (globalRemaining <= 0) break;

        const containerPos = task.containerPositions[sourceId];
        if (!containerPos) continue;

        containerKeySet.add(`${containerPos.x}:${containerPos.y}:${containerPos.roomName}`);

        const room = Game.rooms[containerPos.roomName];
        if (!room) continue;

        // Exclude containers/sites located at other sources' planned container positions,
        // so a close neighbour source's container does not satisfy this source's guard.
        const otherSourceContainerKeys = new Set<string>();
        for (const otherId of task.sourceIds) {
          if (otherId === sourceId) continue;
          const otherPos = task.containerPositions?.[otherId];
          if (otherPos) otherSourceContainerKeys.add(`${otherPos.x}:${otherPos.y}`);
        }

        const sourceObj = Game.getObjectById(sourceId as Id<Source>);
        if (sourceObj && hasContainerNearPosition(room, sourceObj.pos, 2, otherSourceContainerKeys)) continue;

        if (hasExactRoadOrSite(room, containerPos.x, containerPos.y, STRUCTURE_CONTAINER)) continue;

        const code = room.createConstructionSite(containerPos.x, containerPos.y, STRUCTURE_CONTAINER);
        if (code === OK) {
          sitesPlaced++;
          globalRemaining--;
        } else if (code === ERR_FULL) {
          return;
        }
      }
    }

    for (const pos of task.roadPlan?.positions ?? []) {
      if (sitesPlaced >= config.maxRemoteSitesPerRun) break;
      if (globalRemaining <= 0) break;
      if (pos.roomName !== task.targetRoom) continue;

      if (containerKeySet.has(`${pos.x}:${pos.y}:${pos.roomName}`)) continue;

      const room = Game.rooms[pos.roomName];
      if (!room) continue;

      if (hasExactRoadOrSite(room, pos.x, pos.y, STRUCTURE_ROAD)) continue;

      const code = room.createConstructionSite(pos.x, pos.y, STRUCTURE_ROAD);
      if (code === OK) {
        sitesPlaced++;
        globalRemaining--;
      } else if (code === ERR_FULL) {
        return;
      }
    }
  }
}

// ─── Config lifecycle ────────────────────────────────────────────

// RCL7 is the minimum for remote mining — below that the room lacks the infrastructure
// to support cross-room logistics (terminal, factory, enough spawn capacity for large haulers).
function isSourceRoomValidForRemote(sourceRoomName: string): boolean {
  const room = Game.rooms[sourceRoomName];
  if (!room) return false;
  if (!room.controller || !room.controller.my) return false;
  return room.controller.level >= 7;
}

function isRemoteManagedConfig(configName: string, sourceRoom: string, targetRoom: string): boolean {
  const prefix = `${sourceRoom}:remoteMine:${targetRoom}:`;
  if (!configName.startsWith(prefix)) return false;
  const suffix = configName.slice(prefix.length);
  return suffix.startsWith("harvester:") || suffix.startsWith("carrier:") || suffix.startsWith("reserver:");
}

function discoverStaleConfigNames(sourceRoom: string, targetRoom: string): string[] {
  const prefix = `${sourceRoom}:remoteMine:${targetRoom}:`;
  const creepConfigs = getCreepConfigService();
  const allConfigs = creepConfigs.list(prefix);
  const staleNames: string[] = [];
  for (const configName of Object.keys(allConfigs)) {
    const suffix = configName.slice(prefix.length);
    if (suffix.startsWith("harvester:") || suffix.startsWith("carrier:") || suffix.startsWith("reserver:")) {
      staleNames.push(configName);
    }
  }
  return staleNames;
}

function removeRemoteConfig(configName: string): void {
  const creepConfigs = getCreepConfigService();
  const tickContext = getTickContextService();
  const liveCreeps = tickContext.getCreepsByConfigName(configName);

  if (liveCreeps.length > 0) {
    const config = creepConfigs.get(configName);
    if (config) {
      getCreepConfigService().detachSpawn(configName);
    }
  } else {
    creepConfigs.remove(configName);
  }
}

function removeReserverConfig(sourceRoom: string, targetRoom: string): void {
  const configName = getRemoteMiningReserverConfigName(sourceRoom, targetRoom);
  removeRemoteConfig(configName);
  const tickContext = getTickContextService();
  for (const spawn of tickContext.getSpawnsByRoom(sourceRoom)) {
    const queue = spawn.memory.spawnList;
    if (!queue || queue.length === 0) continue;
    const idx = queue.indexOf(configName);
    if (idx >= 0) {
      replaceSpawnQueue(spawn, queue.filter((_, index) => index !== idx));
    }
  }
}

function removeRemotePrefixFromSpawnQueues(
  sourceRoom: string,
  targetRoom: string,
): void {
  const tickContext = getTickContextService();
  for (const spawn of tickContext.getSpawnsByRoom(sourceRoom)) {
    const queue = spawn.memory.spawnList;
    if (!queue || queue.length === 0) continue;
    replaceSpawnQueue(spawn, queue.filter(
      name => !isRemoteManagedConfig(name, sourceRoom, targetRoom),
    ));
  }
}

function cleanupRemoteConfigs(
  task: RemoteMiningTask,
): void {
  const staleNames = discoverStaleConfigNames(task.sourceRoom, task.targetRoom);
  removeRemotePrefixFromSpawnQueues(task.sourceRoom, task.targetRoom);
  for (const configName of staleNames) {
    removeRemoteConfig(configName);
  }
}

function isRemoteAllManagedConfig(configName: string, sourceRoom: string, targetRoom: string): boolean {
  const prefix = `${sourceRoom}:remoteMine:${targetRoom}:`;
  if (!configName.startsWith(prefix)) return false;
  const suffix = configName.slice(prefix.length);
  return suffix.startsWith("harvester:") || suffix.startsWith("carrier:") || suffix.startsWith("reserver:") ||
    suffix.startsWith("worker:") || suffix.startsWith("defender:");
}

function discoverAllStaleConfigNames(sourceRoom: string, targetRoom: string): string[] {
  const prefix = `${sourceRoom}:remoteMine:${targetRoom}:`;
  const creepConfigs = getCreepConfigService();
  const allConfigs = creepConfigs.list(prefix);
  const staleNames: string[] = [];
  for (const configName of Object.keys(allConfigs)) {
    const suffix = configName.slice(prefix.length);
    if (suffix.startsWith("harvester:") || suffix.startsWith("carrier:") || suffix.startsWith("reserver:") ||
      suffix.startsWith("worker:") || suffix.startsWith("defender:")) {
      staleNames.push(configName);
    }
  }
  return staleNames;
}

function removeAllRemotePrefixFromSpawnQueues(
  sourceRoom: string,
  targetRoom: string,
): void {
  const tickContext = getTickContextService();
  for (const spawn of tickContext.getSpawnsByRoom(sourceRoom)) {
    const queue = spawn.memory.spawnList;
    if (!queue || queue.length === 0) continue;
    replaceSpawnQueue(spawn, queue.filter(
      name => !isRemoteAllManagedConfig(name, sourceRoom, targetRoom),
    ));
  }
}

function cleanupAllRemoteConfigs(
  task: RemoteMiningTask,
): void {
  const staleNames = discoverAllStaleConfigNames(task.sourceRoom, task.targetRoom);
  removeAllRemotePrefixFromSpawnQueues(task.sourceRoom, task.targetRoom);
  for (const configName of staleNames) {
    removeRemoteConfig(configName);
  }
}

/** Remove carrier configs whose index exceeds task.sourceIds.length.
 *  Keeps carrier:0 through carrier:(sourceIds.length-1). Orphans configs
 *  with live creeps instead of deleting them, so existing creeps finish
 *  their lifecycle naturally. */
function reconcileStaleCarrierConfigs(task: RemoteMiningTask): void {
  const prefix = `${task.sourceRoom}:remoteMine:${task.targetRoom}:`;
  const creepConfigs = getCreepConfigService();
  const tickContext = getTickContextService();
  const allConfigs = creepConfigs.list(prefix);
  const maxValidIndex = task.sourceIds.length - 1;

  for (const configName of Object.keys(allConfigs)) {
    const suffix = configName.slice(prefix.length);
    if (!suffix.startsWith("carrier:")) continue;

    const indexStr = suffix.slice("carrier:".length);
    const index = parseInt(indexStr, 10);
    if (isNaN(index) || index <= maxValidIndex) continue;

    // Remove from spawn queues
    for (const spawn of tickContext.getSpawnsByRoom(task.sourceRoom)) {
      const queue = spawn.memory.spawnList;
      if (!queue || queue.length === 0) continue;
      const idx = queue.indexOf(configName);
      if (idx >= 0) {
        replaceSpawnQueue(spawn, queue.filter((_, index) => index !== idx));
      }
    }

    // Orphan or remove
    const liveCreeps = tickContext.getCreepsByConfigName(configName);
    if (liveCreeps.length > 0) {
      const config = creepConfigs.get(configName);
      if (config) {
        getCreepConfigService().detachSpawn(configName);
      }
    } else {
      creepConfigs.remove(configName);
    }
  }
}

function upsertHarvesterConfigs(task: RemoteMiningTask): void {
  const creepConfigs = getCreepConfigService();
  for (const sourceId of task.sourceIds) {
    const configName = getRemoteMiningHarvesterConfigName(
      task.sourceRoom,
      task.targetRoom,
      sourceId,
    );
    creepConfigs.upsert(
      configName,
      "colonizerHarvester",
      [task.targetRoom, sourceId],
      task.sourceRoom,
    );
  }
}

function upsertCarrierConfigs(task: RemoteMiningTask): void {
  const creepConfigs = getCreepConfigService();
  for (let i = 0; i < task.sourceIds.length; i++) {
    const sourceId = task.sourceIds[i];
    const configName = getRemoteMiningCarrierConfigName(
      task.sourceRoom,
      task.targetRoom,
      i,
    );
    creepConfigs.upsert(
      configName,
      "remoteMiningCarrier",
      [task.targetRoom, sourceId],
      task.sourceRoom,
    );
  }
}

function upsertReserverConfig(task: RemoteMiningTask, config: RemoteMiningConfig): void {
  const configName = getRemoteMiningReserverConfigName(task.sourceRoom, task.targetRoom);
  const creepConfigs = getCreepConfigService();
  const myUsername = getMyUsername();

  if ((Game.rooms[task.sourceRoom]?.energyCapacityAvailable ?? 0) < 1300) {
    removeReserverConfig(task.sourceRoom, task.targetRoom); return;
  }
  const visibleTarget = Game.rooms[task.targetRoom];
  if (visibleTarget) {
    const controller = visibleTarget.controller;
    if (controller?.owner) {
      removeReserverConfig(task.sourceRoom, task.targetRoom);
      return;
    }
    if (controller?.reservation && controller.reservation.username !== myUsername && controller.reservation.username !== "Invader") {
      removeReserverConfig(task.sourceRoom, task.targetRoom);
      return;
    }
    if (
      controller?.reservation &&
      controller.reservation.username === myUsername &&
      controller.reservation.ticksToEnd >= config.remoteReservationRenewAt
    ) {
      removeReserverConfig(task.sourceRoom, task.targetRoom);
      return;
    }
  }

  creepConfigs.upsert(
    configName,
    "remoteMiningReserver",
    [task.targetRoom],
    task.sourceRoom,
  );
}

function remoteNeedsInfrastructureWorker(task: RemoteMiningTask): boolean {
  if (task.status !== "active") return false;

  const targetRoom = Game.rooms[task.targetRoom];
  if (!targetRoom) return false;

  for (const sourceId of task.sourceIds) {
    const source = Game.getObjectById?.(sourceId as Id<Source>) ?? null;
    if (!source) continue;

    const containers = targetRoom.find(FIND_STRUCTURES).filter(s =>
      s.structureType === STRUCTURE_CONTAINER &&
      Math.abs(s.pos.x - source.pos.x) <= 2 &&
      Math.abs(s.pos.y - source.pos.y) <= 2 &&
      s.hits / s.hitsMax < 0.30,
    );
    if (containers.length > 0) return true;

    const sites = targetRoom.find(FIND_CONSTRUCTION_SITES).filter(s =>
      s.structureType === STRUCTURE_CONTAINER &&
      (s as ConstructionSite).my &&
      Math.abs(s.pos.x - source.pos.x) <= 2 &&
      Math.abs(s.pos.y - source.pos.y) <= 2,
    );
    if (sites.length > 0) return true;
  }

  const plannedRoadKeys = new Set(
    (task.roadPlan?.positions ?? [])
      .filter(pos => pos.roomName === task.targetRoom)
      .map(pos => `${pos.x}:${pos.y}`),
  );
  return targetRoom.find(FIND_CONSTRUCTION_SITES).some(site =>
    site.my &&
    site.structureType === STRUCTURE_ROAD &&
    plannedRoadKeys.has(`${site.pos.x}:${site.pos.y}`),
  );
}

function upsertRemoteWorkerConfig(task: RemoteMiningTask): void {
  const configName = getRemoteWorkerConfigName(task.sourceRoom, task.targetRoom);
  getCreepConfigService().upsert(
    configName,
    "remoteWorker",
    [task.targetRoom],
    task.sourceRoom,
  );
}

function removeRemoteWorkerConfig(sourceRoom: string, targetRoom: string): void {
  const configName = getRemoteWorkerConfigName(sourceRoom, targetRoom);
  removeRemoteConfig(configName);

  const tickContext = getTickContextService();
  for (const spawn of tickContext.getSpawnsByRoom(sourceRoom)) {
    const queue = spawn.memory.spawnList;
    if (!queue || queue.length === 0) continue;
    const idx = queue.indexOf(configName);
    if (idx >= 0) {
      replaceSpawnQueue(spawn, queue.filter((_, index) => index !== idx));
    }
  }
}

function upsertRemoteDefenderConfig(task: RemoteMiningTask): void {
  const configName = getRemoteDefenderConfigName(task.sourceRoom, task.targetRoom);
  getCreepConfigService().upsert(
    configName,
    "remoteDefender",
    [task.targetRoom],
    task.sourceRoom,
  );
}

function removeRemoteDefenderConfig(sourceRoom: string, targetRoom: string): void {
  const configName = getRemoteDefenderConfigName(sourceRoom, targetRoom);
  removeRemoteConfig(configName);

  const tickContext = getTickContextService();
  for (const spawn of tickContext.getSpawnsByRoom(sourceRoom)) {
    const queue = spawn.memory.spawnList;
    if (!queue || queue.length === 0) continue;
    replaceSpawnQueue(spawn, queue.filter(name => name !== configName));
  }
}

function clearRemoteDefenseState(task: RemoteMiningTask): void {
  delete task.defendingSince;
  delete task.lastDefenseThreatAt;
  delete task.defenseReason;
  delete task.lastDefenseSafeAt;
  delete task.damageSnapshots;
}

function enterRemoteDefense(task: RemoteMiningTask, reason: RemoteDefenseReason): void {
  task.status = "defending";
  task.defendingSince = task.defendingSince ?? Game.time;
  task.lastDefenseThreatAt = Game.time;
  task.defenseReason = reason;
  delete task.lastDefenseSafeAt;
  delete task.suspendReason;
  delete task.suspendedAt;
  delete task.lastThreatAt;
  delete task.safeSince;
  task.updatedAt = Game.time;
}

function suspendRemoteTask(task: RemoteMiningTask, reason: RemoteSuspendReason | string): void {
  task.status = "suspended";
  task.suspendReason = reason;
  task.suspendedAt = Game.time;
  task.lastThreatAt = Game.time;
  delete task.safeSince;
  clearRemoteDefenseState(task);
  task.updatedAt = Game.time;
}

function maintainInvaderCoreClearance(
  task: RemoteMiningTask,
  core: StructureInvaderCore,
): void {
  enterRemoteDefense(task, "npc_invader_core");
  cleanupRemoteConfigs(task);
  removeRemoteWorkerConfig(task.sourceRoom, task.targetRoom);

  // A scout remains alive for the entire clearance so a source room without an
  // Observer never mistakes lost visibility for completion.
  upsertScoutConfig(task.sourceRoom, task.targetRoom);

  if (hasActiveInvaderCoreInvulnerability(core)) {
    removeRemoteDefenderConfig(task.sourceRoom, task.targetRoom);
  } else {
    upsertRemoteDefenderConfig(task);
  }
}

function suspendInvaderCoreForInsufficientCapacity(task: RemoteMiningTask): void {
  suspendRemoteTask(task, "invader_core_insufficient_capacity");
  cleanupAllRemoteConfigs(task);
  removeRemoteWorkerConfig(task.sourceRoom, task.targetRoom);
  removeRemoteDefenderConfig(task.sourceRoom, task.targetRoom);
}

export function processRemoteConfigLifecycle(
  store: Record<string, RemoteMiningTask>,
  config: RemoteMiningConfig,
): void {
  for (const task of Object.values(store)) {
    if (task.status === "scouting") {
      continue;
    }

    if (task.status === "abandoned") {
      if (Game.time % 50 === 0 || task.updatedAt === Game.time) {
        cleanupAllRemoteConfigs(task);
        removeScoutConfigAndSpawnQueues(task.sourceRoom, task.targetRoom);
      }
      continue;
    }

    // If a visible target room is owned by me, it must never be a remote mining target.
    // Abandon the task and clean up all remote configs/spawn entries regardless of current status.
    const earlyVisibleTarget = Game.rooms[task.targetRoom];
    if (earlyVisibleTarget && earlyVisibleTarget.controller?.my) {
      task.status = "abandoned";
      task.abandonedReason = "owned_room";
      task.updatedAt = Game.time;
      task.nextRetryAt = Game.time + 5000;
      delete task.suspendReason;
      delete task.suspendedAt;
      delete task.lastThreatAt;
      delete task.safeSince;
      delete task.defendingSince;
      delete task.lastDefenseThreatAt;
      delete task.defenseReason;
      delete task.lastDefenseSafeAt;
      delete task.damageSnapshots;
      cleanupAllRemoteConfigs(task);
      removeRemoteWorkerConfig(task.sourceRoom, task.targetRoom);
      removeRemoteDefenderConfig(task.sourceRoom, task.targetRoom);
      removeScoutConfigAndSpawnQueues(task.sourceRoom, task.targetRoom);
      continue;
    }

    if (task.status === "suspended") {
      cleanupAllRemoteConfigs(task);

      if (task.suspendReason === "manual_war_pause") {
        removeScoutConfig(task.sourceRoom, task.targetRoom);
        removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
        continue;
      }

      let resumed = false;
      const visibleTarget = Game.rooms[task.targetRoom];
      if (visibleTarget) {
        const supportedCore = getSupportedInvaderCore(visibleTarget);
        if (
          supportedCore &&
          isSourceRoomValidForRemote(task.sourceRoom) &&
          !isDefenseMode(task.sourceRoom)
        ) {
          if (!hasInvaderCoreClearanceCapacity(task)) {
            suspendInvaderCoreForInsufficientCapacity(task);
            upsertScoutConfig(task.sourceRoom, task.targetRoom);
          } else {
            maintainInvaderCoreClearance(task, supportedCore);
          }
          continue;
        }

        const threatReason = getRemoteThreatReason(visibleTarget);
        if (threatReason !== null || getActiveDefenseReason(visibleTarget, task) !== null) {
          task.lastThreatAt = Game.time;
          task.updatedAt = Game.time;
          delete task.safeSince;
        } else {
          if (task.safeSince === undefined) {
            task.safeSince = Game.time;
          }
          const safeTicks = Game.time - task.safeSince;
          if (safeTicks >= config.remoteSafeTicksToResume) {
            task.status = "active";
            delete task.suspendReason;
            delete task.suspendedAt;
            delete task.lastThreatAt;
            delete task.safeSince;
            task.updatedAt = Game.time;
            resumed = true;
          }
        }
      }
      if (!resumed) {
        if (isSourceRoomValidForRemote(task.sourceRoom) && !isDefenseMode(task.sourceRoom)) {
          if (!Game.rooms[task.targetRoom]) {
            upsertScoutConfig(task.sourceRoom, task.targetRoom);
          } else {
            removeScoutConfig(task.sourceRoom, task.targetRoom);
            removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
          }
        } else {
          removeScoutConfigAndSpawnQueues(task.sourceRoom, task.targetRoom);
        }
        continue;
      }
    }

    if (task.status === "defending") {
      const visibleTarget = Game.rooms[task.targetRoom];

      if (!isSourceRoomValidForRemote(task.sourceRoom)) {
        task.status = "suspended";
        task.suspendReason = "source_room_invalid";
        task.suspendedAt = Game.time;
        task.lastThreatAt = Game.time;
        delete task.safeSince;
        delete task.defendingSince;
        delete task.lastDefenseThreatAt;
        delete task.defenseReason;
        delete task.lastDefenseSafeAt;
        delete task.damageSnapshots;
        task.updatedAt = Game.time;
        cleanupRemoteConfigs(task);
        removeRemoteWorkerConfig(task.sourceRoom, task.targetRoom);
        removeRemoteDefenderConfig(task.sourceRoom, task.targetRoom);
        removeScoutConfigAndSpawnQueues(task.sourceRoom, task.targetRoom);
        continue;
      }

      if (isDefenseMode(task.sourceRoom)) {
        task.status = "suspended";
        task.suspendReason = "source_room_defense_mode";
        task.suspendedAt = Game.time;
        task.lastThreatAt = Game.time;
        delete task.safeSince;
        delete task.defendingSince;
        delete task.lastDefenseThreatAt;
        delete task.defenseReason;
        delete task.lastDefenseSafeAt;
        delete task.damageSnapshots;
        task.updatedAt = Game.time;
        cleanupRemoteConfigs(task);
        removeRemoteWorkerConfig(task.sourceRoom, task.targetRoom);
        removeRemoteDefenderConfig(task.sourceRoom, task.targetRoom);
        removeScoutConfigAndSpawnQueues(task.sourceRoom, task.targetRoom);
        continue;
      }

      if (task.defenseReason === "npc_invader_core") {
        if (!visibleTarget) {
          cleanupRemoteConfigs(task);
          removeRemoteWorkerConfig(task.sourceRoom, task.targetRoom);
          removeRemoteDefenderConfig(task.sourceRoom, task.targetRoom);
          upsertScoutConfig(task.sourceRoom, task.targetRoom);
          continue;
        }

        const passiveThreat = getRemoteThreatReason(visibleTarget);
        if (passiveThreat !== null) {
          suspendRemoteTask(task, passiveThreat);
          cleanupAllRemoteConfigs(task);
          removeRemoteWorkerConfig(task.sourceRoom, task.targetRoom);
          removeRemoteDefenderConfig(task.sourceRoom, task.targetRoom);
          removeScoutConfig(task.sourceRoom, task.targetRoom);
          removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
          continue;
        }

        const supportedCore = getSupportedInvaderCore(visibleTarget);
        if (supportedCore) {
          if (!hasInvaderCoreClearanceCapacity(task)) {
            suspendInvaderCoreForInsufficientCapacity(task);
            upsertScoutConfig(task.sourceRoom, task.targetRoom);
          } else {
            maintainInvaderCoreClearance(task, supportedCore);
          }
          continue;
        }

        // Core absence is completion only because the target room is visible.
        // Re-check ordinary defense causes before resuming remote production.
        const nextDefenseReason = getActiveDefenseReason(visibleTarget, task);
        if (nextDefenseReason !== null) {
          enterRemoteDefense(task, nextDefenseReason);
          cleanupRemoteConfigs(task);
          removeRemoteWorkerConfig(task.sourceRoom, task.targetRoom);
          upsertRemoteDefenderConfig(task);
          removeScoutConfig(task.sourceRoom, task.targetRoom);
          removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
          continue;
        }

        task.status = "active";
        clearRemoteDefenseState(task);
        task.updatedAt = Game.time;
        removeRemoteDefenderConfig(task.sourceRoom, task.targetRoom);
        removeScoutConfig(task.sourceRoom, task.targetRoom);
        removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
        continue;
      }

      if (visibleTarget) {
        const passiveThreat = getRemoteThreatReason(visibleTarget);
        if (passiveThreat !== null) {
          task.status = "suspended";
          task.suspendReason = passiveThreat;
          task.suspendedAt = Game.time;
          task.lastThreatAt = Game.time;
          delete task.safeSince;
          delete task.defendingSince;
          delete task.lastDefenseThreatAt;
          delete task.defenseReason;
          delete task.lastDefenseSafeAt;
          delete task.damageSnapshots;
          task.updatedAt = Game.time;
          cleanupRemoteConfigs(task);
          removeRemoteWorkerConfig(task.sourceRoom, task.targetRoom);
          removeRemoteDefenderConfig(task.sourceRoom, task.targetRoom);
          removeScoutConfig(task.sourceRoom, task.targetRoom);
          removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
          continue;
        }

        const defenseReason = getActiveDefenseReason(visibleTarget, task);
        if (defenseReason !== null) {
          if (task.defendingSince !== undefined && Game.time - task.defendingSince > 750) {
            task.status = "suspended";
            task.suspendReason = "defense_timeout";
            task.suspendedAt = Game.time;
            task.lastThreatAt = Game.time;
            delete task.safeSince;
            delete task.defendingSince;
            delete task.lastDefenseThreatAt;
            delete task.defenseReason;
            delete task.lastDefenseSafeAt;
            delete task.damageSnapshots;
            task.updatedAt = Game.time;
            cleanupRemoteConfigs(task);
            removeRemoteWorkerConfig(task.sourceRoom, task.targetRoom);
            removeRemoteDefenderConfig(task.sourceRoom, task.targetRoom);
            removeScoutConfig(task.sourceRoom, task.targetRoom);
            removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
            continue;
          }

          if (defenseReason === "npc_invader_core") {
            if (!hasInvaderCoreClearanceCapacity(task)) {
              suspendInvaderCoreForInsufficientCapacity(task);
              upsertScoutConfig(task.sourceRoom, task.targetRoom);
            } else {
              const supportedCore = getSupportedInvaderCore(visibleTarget);
              if (supportedCore) {
                maintainInvaderCoreClearance(task, supportedCore);
              }
            }
            continue;
          }

          enterRemoteDefense(task, defenseReason);
          cleanupRemoteConfigs(task);
          removeRemoteWorkerConfig(task.sourceRoom, task.targetRoom);
          upsertRemoteDefenderConfig(task);
          removeScoutConfig(task.sourceRoom, task.targetRoom);
          removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
          continue;
        } else {
          if (task.lastDefenseSafeAt === undefined) {
            task.lastDefenseSafeAt = Game.time;
          }
          const safeTicks = Game.time - task.lastDefenseSafeAt;
          if (safeTicks >= config.remoteSafeTicksToResume) {
            task.status = "active";
            delete task.defendingSince;
            delete task.lastDefenseThreatAt;
            delete task.defenseReason;
            delete task.lastDefenseSafeAt;
            delete task.damageSnapshots;
            task.updatedAt = Game.time;
            removeRemoteDefenderConfig(task.sourceRoom, task.targetRoom);
            removeScoutConfig(task.sourceRoom, task.targetRoom);
            removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
            continue;
          } else {
            task.updatedAt = Game.time;
            upsertRemoteDefenderConfig(task);
            removeScoutConfig(task.sourceRoom, task.targetRoom);
            removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
            continue;
          }
        }
      } else {
        upsertScoutConfig(task.sourceRoom, task.targetRoom);
        upsertRemoteDefenderConfig(task);
        continue;
      }
    }

    if (!isSourceRoomValidForRemote(task.sourceRoom)) {
      cleanupAllRemoteConfigs(task);
      removeScoutConfigAndSpawnQueues(task.sourceRoom, task.targetRoom);
      continue;
    }

    if (isDefenseMode(task.sourceRoom)) {
      cleanupAllRemoteConfigs(task);
      removeScoutConfigAndSpawnQueues(task.sourceRoom, task.targetRoom);
      continue;
    }

    const visibleTarget = Game.rooms[task.targetRoom];
    if (visibleTarget) {
      const threatReason = getRemoteThreatReason(visibleTarget);
      if (threatReason !== null) {
        task.status = "suspended";
        task.suspendReason = threatReason;
        task.suspendedAt = Game.time;
        task.lastThreatAt = Game.time;
        delete task.safeSince;
        task.updatedAt = Game.time;
        cleanupAllRemoteConfigs(task);
        removeScoutConfig(task.sourceRoom, task.targetRoom);
        removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
        continue;
      }

      // No passive threat; check for active defense
      const defenseReason = getActiveDefenseReason(visibleTarget, task);
      if (defenseReason !== null) {
        if (defenseReason === "npc_invader_core") {
          if (!hasInvaderCoreClearanceCapacity(task)) {
            suspendInvaderCoreForInsufficientCapacity(task);
            upsertScoutConfig(task.sourceRoom, task.targetRoom);
          } else {
            const supportedCore = getSupportedInvaderCore(visibleTarget);
            if (supportedCore) {
              maintainInvaderCoreClearance(task, supportedCore);
            }
          }
          continue;
        }

        enterRemoteDefense(task, defenseReason);
        cleanupRemoteConfigs(task);
        removeRemoteWorkerConfig(task.sourceRoom, task.targetRoom);
        upsertRemoteDefenderConfig(task);
        continue;
      }
    }

    // Scout is only needed when room visibility is lost.
    if (!Game.rooms[task.targetRoom]) {
      upsertScoutConfig(task.sourceRoom, task.targetRoom);
    } else {
      removeScoutConfig(task.sourceRoom, task.targetRoom);
      removeScoutFromSpawnQueues(task.sourceRoom, task.targetRoom);
    }

    // Defense configs with live creeps are first orphaned so the role can
    // retire safely; later active ticks remove the config after the creep dies.
    removeRemoteDefenderConfig(task.sourceRoom, task.targetRoom);

    upsertHarvesterConfigs(task);
    upsertCarrierConfigs(task);
    reconcileStaleCarrierConfigs(task);
    upsertReserverConfig(task, config);

    if (remoteNeedsInfrastructureWorker(task)) {
      upsertRemoteWorkerConfig(task);
    } else {
      removeRemoteWorkerConfig(task.sourceRoom, task.targetRoom);
    }
  }
}

export function runRemoteMining(): void {
  const config = getRemoteMiningConfig();
  if (!config.enabled) {
    remoteObserverLeases.clear();
    return;
  }

  if (!Memory.runtime) {
    Memory.runtime = {};
  }
  if (!Memory.runtime.remoteMining) {
    Memory.runtime.remoteMining = {};
  }

  const store = ensureRemoteMiningStore();
  syncRemoteObserverLeases(store);

  processScoutLifecycle(store, config);
  if (Game.time % 25 === 0 || Object.values(store).some(task => task.assignedAt === Game.time)) processRemoteConstruction(store, config);
  processRemoteConfigLifecycle(store, config);

  const lastScanAt = Memory.runtime.remoteMining.lastScanAt;
  if (lastScanAt !== undefined && typeof lastScanAt === "number" && lastScanAt <= Game.time && Game.time - lastScanAt < config.scanInterval) {
    return;
  }

  Memory.runtime.remoteMining.lastScanAt = Game.time;

  const tickContext = getTickContextService();
  const myRooms = tickContext.getMyRooms();

  const sourceRooms = myRooms
    .filter((room) => {
      if (!isOwnedManagedRoom(room.name)) {
        return false;
      }
      if (!room.controller || !room.controller.my) {
        return false;
      }
      return room.controller.level >= 7;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // First-come-first-served: source rooms are sorted lexicographically; the first room
  // to claim an eligible target wins. This avoids coordination overhead between rooms.
  for (const sourceRoom of sourceRooms) {
    const currentCount = countSourceRoomRemotes(store, sourceRoom.name);
    if (currentCount >= config.maxRemoteRoomsPerSourceRoom) {
      continue;
    }

    const exits = Game.map.describeExits(sourceRoom.name);
    if (!exits) {
      continue;
    }

    for (const direction of CARDINAL_EXIT_DIRECTIONS) {
      const targetRoom = exits[direction];
      if (!targetRoom) {
        continue;
      }

      const previous = store[targetRoom];
      if (previous) {
        if (previous.status !== "abandoned" || Game.time < (previous.nextRetryAt ?? previous.updatedAt + 5000)) continue;
        cleanupAllRemoteConfigs(previous);
        removeScoutConfigAndSpawnQueues(previous.sourceRoom, previous.targetRoom);
        delete store[targetRoom];
      }

      if (!isRouteDirect(sourceRoom.name, targetRoom)) {
        continue;
      }

      if (!isRoomStatusNormal(targetRoom)) {
        continue;
      }

      const visibleRoom = Game.rooms[targetRoom];
      const now = Game.time;

      if (!visibleRoom) {
        store[targetRoom] = {
          sourceRoom: sourceRoom.name,
          targetRoom,
          status: "scouting",
          sourceIds: [],
          assignedAt: now,
          updatedAt: now,
        };
        upsertScoutConfig(sourceRoom.name, targetRoom);
        break;
      }

      const sources = visibleRoom.find(FIND_SOURCES);
      if (sources.length !== 2) {
        continue;
      }

      if (visibleRoom.controller?.my) {
        continue;
      }

      if (!isRemoteRoomSafe(visibleRoom)) {
        continue;
      }

      store[targetRoom] = {
        sourceRoom: sourceRoom.name,
        targetRoom,
        status: "active",
        sourceIds: sources.map((s) => s.id),
        assignedAt: now,
        updatedAt: now,
        lastVerifiedAt: now,
      };
      break;
    }
  }
}
