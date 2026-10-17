/** GCL 属于账号；远端 tick 只用于检测推进，不与本 shard 的 tick 相减。 */
interface RoomSummaryPayload {
  version?: number;
  shard?: string;
  updatedAt?: number;
  ownedRoomCount?: number;
  rooms?: { room: string; at: number }[];
}
let cache: { tick: number; game: typeof Game; reader: typeof InterShardMemory.getRemote;
  remotes: Map<string, number> } | undefined;
const observations = new Map<string, { version: number; seenAt: number; reader: typeof InterShardMemory.getRemote }>();

export function getGlobalOwnedRoomCount(extraShards: string[] = []): number {
  let count = Object.values(Game.rooms).filter(room => room.controller?.my).length;
  if (typeof InterShardMemory === "undefined") return count;
  const reader = InterShardMemory.getRemote;
  if (!cache || cache.tick !== Game.time || cache.game !== Game || cache.reader !== reader) {
    cache = { tick: Game.time, game: Game, reader, remotes: new Map() };
  }
  const shards = new Set([...Object.keys(Game.cpu?.shardLimits ?? {}),
    ...Object.keys(Memory.runtime?.crossShard?.remotes ?? {}), ...extraShards]);
  shards.delete(Game.shard.name);
  for (const shard of shards) {
    if (!cache.remotes.has(shard)) {
      let payload: RoomSummaryPayload | undefined;
      try { payload = JSON.parse(InterShardMemory.getRemote(shard) || "null"); } catch { /* 无效摘要留给原生 claim 错误冷却。 */ }
      let remoteCount = 0;
      if (payload?.version === 1 && payload.shard === shard && Number.isSafeInteger(payload.updatedAt)) {
        const version = payload.updatedAt!;
        let observed = observations.get(shard);
        if (!observed || observed.reader !== reader || observed.version !== version || observed.seenAt > Game.time) {
          observations.set(shard, observed = { version, seenAt: Game.time, reader });
        }
        if (Game.time - observed.seenAt <= 1000) {
          remoteCount = Number.isSafeInteger(payload.ownedRoomCount) && payload.ownedRoomCount! >= 0
            ? payload.ownedRoomCount! : new Set((payload.rooms ?? []).filter(room =>
              typeof room.room === "string" && room.at >= version - 5 && room.at <= version).map(room => room.room)).size;
        }
      }
      cache.remotes.set(shard, remoteCount);
    }
    count += cache.remotes.get(shard)!;
  }
  return count;
}
