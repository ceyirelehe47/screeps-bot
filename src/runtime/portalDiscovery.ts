import { getMemoryService } from "@/runtime/runtimeServices";

const PORTAL_SCAN_INTERVAL = 11;
const PORTAL_STALE_TTL = 2500;

interface InterShardDestination {
  shard: string;
  room: string;
}

function ensurePortalStore(): NonNullable<NonNullable<Memory["data"]>["interShardPortals"]> {
  const data = getMemoryService().ensureData();
  if (!data.interShardPortals) {
    data.interShardPortals = {};
  }
  return data.interShardPortals;
}

function isInterShardDestination(
  destination: RoomPosition | InterShardDestination,
): destination is InterShardDestination {
  return typeof (destination as InterShardDestination).shard === "string";
}

function updatePortalEntriesFromVisibleRooms(store: NonNullable<NonNullable<Memory["data"]>["interShardPortals"]>): void {
  const now = Game.time;

  for (const room of Object.values(Game.rooms)) {
    const portals = room.find(FIND_STRUCTURES, {
      filter: (structure) => structure.structureType === STRUCTURE_PORTAL,
    }) as StructurePortal[];

    for (const portal of portals) {
      const destination = portal.destination;
      if (!destination || !isInterShardDestination(destination)) {
        continue;
      }

      const existing = store[portal.id];
      store[portal.id] = {
        id: portal.id,
        originRoom: room.name,
        destinationShard: destination.shard,
        destinationRoom: destination.room,
        discoveredAt: existing?.discoveredAt ?? now,
        lastSeenAt: now,
        ticksToDecay: portal.ticksToDecay,
      };
    }
  }
}

function cleanupStalePortalEntries(store: NonNullable<NonNullable<Memory["data"]>["interShardPortals"]>): void {
  const now = Game.time;
  for (const [portalId, entry] of Object.entries(store)) {
    const staleByTime = now - entry.lastSeenAt > PORTAL_STALE_TTL;
    const decayed = typeof entry.ticksToDecay === "number" && entry.ticksToDecay - (now - entry.lastSeenAt) <= 0;
    if (staleByTime || decayed) {
      delete store[portalId];
    }
  }
}

export function runPortalDiscovery(): void {
  if (Memory.cfg?.crossShard?.enabled === false) {
    return;
  }

  if (Game.time % PORTAL_SCAN_INTERVAL !== 0) {
    return;
  }

  const store = ensurePortalStore();
  updatePortalEntriesFromVisibleRooms(store);
  cleanupStalePortalEntries(store);
}
