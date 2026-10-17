import type { SafeZoneConstraint } from "@/movement/types";

interface ZoneLayer { revision: number | null; zone: ReadonlySet<number>; blocked: number[] }
const zones = new Map<string, ZoneLayer>();
const matrices = new Map<string, { zone: ReadonlySet<number>; matrix: CostMatrix; at: number }>();

/** 安全区最后叠加，业务 callback 不能重新打开禁行格；稳定矩阵可跨 tick 复用。 */
export function applySafeZoneLayer(matrix: CostMatrix, policy?: SafeZoneConstraint, matrixKey?: string): CostMatrix {
  if (!policy) return matrix;
  let layer = zones.get(policy.roomName);
  if (!layer || layer.revision !== policy.revision || layer.zone !== policy.zone) {
    const blocked: number[] = [];
    for (let index = 0; index < 2500; index++) if (!policy.zone.has(index)) blocked.push(index);
    layer = { revision: policy.revision, zone: policy.zone, blocked };
    if (zones.size >= 64) zones.delete(zones.keys().next().value!);
    zones.set(policy.roomName, layer);
  }
  const key = matrixKey ? `${matrixKey}|sz:${policy.roomName}:${policy.revision}` : undefined;
  const cached = key ? matrices.get(key) : undefined;
  if (cached && cached.zone === policy.zone && cached.at <= Game.time && Game.time - cached.at < 100) return cached.matrix.clone();
  for (const index of layer.blocked) matrix.set(Math.floor(index / 50), index % 50, 255);
  if (key) {
    if (matrices.size >= 64) matrices.delete(matrices.keys().next().value!);
    matrices.set(key, { zone: policy.zone, matrix: matrix.clone(), at: Game.time });
  }
  return matrix;
}

export function clearSafeZoneLayersForTest(): void { zones.clear(); matrices.clear(); }
