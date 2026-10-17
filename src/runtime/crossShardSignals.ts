import { getMemoryService } from "@/runtime/runtimeServices";

const MAX_CLAIM_SUMMARIES = 512;
const MAX_ROOM_SUMMARIES = 512;

export interface CrossShardClaimSummary {
  room: string;
  by?: string;
  at: number;
}

export interface CrossShardRoomSummary {
  room: string;
  at: number;
  hasSpawn: boolean;
  hasStorage: boolean;
}

function ensureCrossShardRuntimeStore(): NonNullable<NonNullable<Memory["runtime"]>["crossShard"]> {
  const runtime = getMemoryService().ensureRuntime();
  runtime.crossShard = runtime.crossShard || {};
  runtime.crossShard.remotes = runtime.crossShard.remotes || {};
  runtime.crossShard.claims = runtime.crossShard.claims || {};
  runtime.crossShard.rooms = runtime.crossShard.rooms || {};
  return runtime.crossShard;
}

export function recordCrossShardClaim(roomName: string, creepName: string): void {
  const store = ensureCrossShardRuntimeStore();
  store.claims = store.claims || {};
  store.claims[roomName] = {
    updatedAt: Game.time,
    by: creepName,
  };
}

export function getCrossShardClaimSummaries(limit = MAX_CLAIM_SUMMARIES): CrossShardClaimSummary[] {
  const claims = Memory.runtime?.crossShard?.claims;
  if (!claims) {
    return [];
  }

  return Object.entries(claims)
    .map(([room, claim]) => ({ room, by: claim.by, at: claim.updatedAt }))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

export function getCrossShardRoomSummaries(limit = MAX_ROOM_SUMMARIES): CrossShardRoomSummary[] {
  const rooms = Memory.runtime?.crossShard?.rooms;
  if (!rooms) {
    return [];
  }

  return Object.entries(rooms)
    .map(([room, summary]) => ({
      room,
      at: summary.updatedAt,
      hasSpawn: summary.hasSpawn,
      hasStorage: summary.hasStorage,
    }))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

export function runCrossShardSignals(): void {
  if (Memory.cfg?.crossShard?.enabled === false) {
    return;
  }

  const store = ensureCrossShardRuntimeStore();
  const claims = store.claims || {};
  const rooms = store.rooms || {};
  for (const name of Object.keys(claims)) if (!Game.rooms[name]?.controller?.my) delete claims[name];
  for (const name of Object.keys(rooms)) if (!Game.rooms[name]?.controller?.my) delete rooms[name];

  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my) {
      continue;
    }

    claims[room.name] = {
      updatedAt: Game.time,
      by: claims[room.name]?.by,
    };
    rooms[room.name] = {
      updatedAt: Game.time,
      hasSpawn: room.find(FIND_MY_STRUCTURES, {
        filter: (structure) => structure.structureType === STRUCTURE_SPAWN,
      }).length > 0,
      hasStorage: !!room.storage,
    };
  }
}
