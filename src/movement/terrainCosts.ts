import type { MoveToTargetOptions } from "@/movement/types";

/** 与 Room.findPath 的道路模式一致：道路成本为 1，普通地形显式为 2/10。 */
export function resolveTerrainCosts(options: Pick<MoveToTargetOptions, "plainCost" | "swampCost">): { plainCost: number; swampCost: number } {
  return { plainCost: options.plainCost ?? 2, swampCost: options.swampCost ?? 10 };
}
