import { getCrossShardColonizationSummaries } from "@/runtime/crossShardColonization";
import { getCrossShardClaimSummaries, getCrossShardRoomSummaries } from "@/runtime/crossShardSignals";
import { getMemoryService } from "@/runtime/runtimeServices";

const INTER_SHARD_PROTOCOL_VERSION = 1;
const INTER_SHARD_SYNC_INTERVAL = 5;
const REMOTE_SHARD_STALE_TTL = 200;
const MAX_PORTALS_IN_SUMMARY = 32;

interface InterShardPortalSummary {
  id: string;
  originRoom: string;
  destinationShard: string;
  destinationRoom?: string;
  ticksToDecay?: number;
  lastSeenAt: number;
}

interface InterShardColonizationSummary {
  id: string;
  targetShard: string;
  targetRoom: string;
  status:
    | "planning"
    | "ready"
    | "spawning"
    | "in_transit"
    | "claimed"
    | "bootstrapping"
    | "completed"
    | "blocked"
    | "failed";
  sourceRoom?: string;
  portalId?: string;
  updatedAt: number;
}

interface InterShardClaimSummary {
  room: string;
  by?: string;
  at: number;
}

interface InterShardRoomSummary {
  room: string;
  at: number;
  hasSpawn: boolean;
  hasStorage: boolean;
}

interface InterShardLocalPayload {
  version: number;
  shard: string;
  updatedAt: number;
  portals: InterShardPortalSummary[];
  colonization: InterShardColonizationSummary[];
  claims: InterShardClaimSummary[];
  rooms: InterShardRoomSummary[];
}

function ensureCrossShardRuntimeStore(): NonNullable<NonNullable<Memory["runtime"]>["crossShard"]> {
  const runtime = getMemoryService().ensureRuntime();
  runtime.crossShard = runtime.crossShard || {};
  runtime.crossShard.remotes = runtime.crossShard.remotes || {};
  runtime.crossShard.claims = runtime.crossShard.claims || {};
  runtime.crossShard.rooms = runtime.crossShard.rooms || {};
  return runtime.crossShard;
}

function getKnownShardNames(): string[] {
  const shardLimits = Game.cpu?.shardLimits;
  if (!shardLimits) {
    return [Game.shard.name];
  }

  const names = Object.keys(shardLimits);
  if (!names.includes(Game.shard.name)) {
    names.push(Game.shard.name);
  }
  return names;
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

function normalizePayload(payload: InterShardLocalPayload | null): InterShardLocalPayload {
  if (!payload || payload.version !== INTER_SHARD_PROTOCOL_VERSION || payload.shard !== Game.shard.name) {
    return {
      version: INTER_SHARD_PROTOCOL_VERSION,
      shard: Game.shard.name,
      updatedAt: Game.time,
      portals: [],
      colonization: [],
      claims: [],
      rooms: [],
    };
  }

  return {
    version: INTER_SHARD_PROTOCOL_VERSION,
    shard: Game.shard.name,
    updatedAt: Game.time,
    portals: payload.portals || [],
    colonization: payload.colonization || [],
    claims: payload.claims || [],
    rooms: payload.rooms || [],
  };
}

function buildPortalSummary(): InterShardPortalSummary[] {
  const portals = Object.values(Memory.data?.interShardPortals || {})
    .filter((entry) => entry.destinationShard)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_PORTALS_IN_SUMMARY)
    .map((entry) => ({
      id: entry.id,
      originRoom: entry.originRoom,
      destinationShard: entry.destinationShard,
      destinationRoom: entry.destinationRoom,
      ticksToDecay: entry.ticksToDecay,
      lastSeenAt: entry.lastSeenAt,
    }));

  return portals;
}

function writeLocalPayload(): void {
  const raw = InterShardMemory.getLocal();
  const parsed = safeJsonParse<InterShardLocalPayload>(raw);
  const payload = normalizePayload(parsed);
  payload.updatedAt = Game.time;
  payload.portals = buildPortalSummary();
  payload.colonization = getCrossShardColonizationSummaries();
  payload.claims = getCrossShardClaimSummaries();
  payload.rooms = getCrossShardRoomSummaries();
  InterShardMemory.setLocal(JSON.stringify(payload));
}

function readRemotePayloads(): void {
  const runtime = ensureCrossShardRuntimeStore();
  const remotes = runtime.remotes ??= {};
  const knownShards = getKnownShardNames();
  const now = Game.time;

  for (const shardName of knownShards) {
    if (shardName === Game.shard.name) {
      continue;
    }

    const remoteRaw = InterShardMemory.getRemote(shardName);
    const remote = safeJsonParse<InterShardLocalPayload>(remoteRaw);
    if (!remote || remote.version !== INTER_SHARD_PROTOCOL_VERSION) {
      continue;
    }

    remotes[shardName] = {
      updatedAt: remotes[shardName]?.remoteUpdatedAt === remote.updatedAt ? remotes[shardName].updatedAt : now,
      remoteUpdatedAt: remote.updatedAt,
      portalCount: remote.portals?.length ?? 0,
      colonyCount: remote.colonization?.length ?? 0,
      claimCount: remote.claims?.length ?? 0,
      roomCount: remote.rooms?.length ?? 0,
    };
  }

  for (const [shardName, meta] of Object.entries(remotes)) {
    if (now - meta.updatedAt > REMOTE_SHARD_STALE_TTL) {
      delete remotes[shardName];
    }
  }
}

export function runInterShardControl(): void {
  if (Memory.cfg?.crossShard?.enabled === false) {
    return;
  }

  if (typeof InterShardMemory === "undefined") {
    return;
  }

  ensureCrossShardRuntimeStore();

  if (Game.time % INTER_SHARD_SYNC_INTERVAL !== 0) {
    return;
  }

  writeLocalPayload();
  readRemotePayloads();
}
