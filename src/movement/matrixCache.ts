interface MatrixEntry { layer: string; revision: string; builtAt: number; matrix: CostMatrix }
const entries = new Map<string, MatrixEntry>();
let epoch: { game: typeof Game; tick: number; shard: string | undefined } | undefined;

/** 静态矩阵与派生矩阵统一拥有缓存；原矩阵不外露，调用方只修改 clone。 */
export function readMatrixLayer(layer: "static" | "travel", roomName: string, revision: string,
  build: () => CostMatrix, capacity: number, ttl = 100): { matrix: CostMatrix; built: boolean } {
  const shard = Game.shard?.name;
  if (epoch && (Game.time < epoch.tick || Game !== epoch.game && Game.time === epoch.tick || shard !== epoch.shard)) entries.clear();
  epoch = { game: Game, tick: Game.time, shard };
  const key = `${layer}:${roomName}`, cached = entries.get(key);
  if (cached?.revision === revision && cached.builtAt <= Game.time && Game.time - cached.builtAt <= ttl) {
    return { matrix: cached.matrix.clone(), built: false };
  }
  for (const [id, entry] of entries) if (entry.builtAt > Game.time || Game.time - entry.builtAt > ttl) entries.delete(id);
  const matrix = build();
  entries.delete(key);
  const layerEntries = [...entries.entries()].filter(([, entry]) => entry.layer === layer);
  if (layerEntries.length >= capacity) {
    const oldest = layerEntries.reduce((left, right) => left[1].builtAt <= right[1].builtAt ? left : right);
    entries.delete(oldest[0]);
  }
  entries.set(key, { layer, revision, builtAt: Game.time, matrix });
  return { matrix: matrix.clone(), built: true };
}

export function matrixLayerSize(layer: string): number { return [...entries.values()].filter(entry => entry.layer === layer).length; }
export function clearMatrixLayer(layer: string): void { for (const [key, entry] of entries) if (entry.layer === layer) entries.delete(key); }
