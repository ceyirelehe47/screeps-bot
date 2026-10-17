import { isMarketBaseResource } from "@/runtime/marketBaseResourcePolicy";
import { BASE_MINERAL_NO_BID_ROUNDS, readBaseMineralOverflow, storageMineralPressure } from "@/runtime/baseMineralOverflow";

/** 原矿只在确认卖不动或仓储承压时停采；暂停后降到溢出线以下才恢复。 */
export function shouldPauseNativeMineralHarvest(room: Room | undefined, resource: ResourceConstant): boolean {
  if (!room || !isMarketBaseResource(resource)) return false;
  const stored = room.storage?.store.getUsedCapacity?.(resource) ?? 0;
  const terminal = room.terminal?.store.getUsedCapacity?.(resource) ?? 0;
  if (!Number.isSafeInteger(stored) || stored < 0 || !Number.isSafeInteger(terminal) || terminal < 0) return true;
  const observation = readBaseMineralOverflow(room.name, resource);
  if (storageMineralPressure(room)) return true;
  const stock = stored + terminal;
  const current = observation?.complete && observation.observedAt <= Game.time && Game.time - observation.observedAt <= 200;
  if (observation?.paused && stock > observation.overflowThreshold) return true;
  if (!current || !observation) return false;
  if (stock <= observation.overflowThreshold) {
    return false;
  }
  if (observation.paused) return true;
  if (stock > observation.liquidationThreshold && observation.noBidRounds >= BASE_MINERAL_NO_BID_ROUNDS) {
    return true;
  }
  return false;
}
