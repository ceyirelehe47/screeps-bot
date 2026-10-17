import { getMarketProtectionSellableAmount, isMarketProtectionEntryFresh, type MarketProtectionEntry } from "@/runtime/marketSaleProtection";
import { isBaseMarketResource } from "@/runtime/market/policy";

export const BASE_MINERAL_OVERFLOW_BAND = 30_000;
export const BASE_MINERAL_LIQUIDATION_BAND = 50_000;
export const BASE_MINERAL_NO_BID_ROUNDS = 5;
export type ProductionSurplusTier = "normal" | "overflow" | "liquidation";

export interface ProductionSurplusObservation {
  roomName: string;
  resource: string;
  observedAt: number;
  complete: boolean;
  stock: number;
  productionReserve: number;
  safetyBuffer: number;
  protectedAmount: number;
  overflowThreshold: number;
  liquidationThreshold: number;
  overflowAmount: number;
  tier: ProductionSurplusTier;
  noBidRounds: number;
  lastAttemptAt?: number;
  reason?: string;
  paused?: "no_bid" | "storage_full";
  blockers?: string[];
  priceFloor?: number;
  priceDate?: string;
  priceTier?: ProductionSurplusTier;
}

/** 生产承诺、在途及市场暴露只认 Protection；增加配置储备时保守补足差额。 */
export function productionSellableAmount(entry: MarketProtectionEntry, tick: number, reserve?: number): number {
  if (!isMarketProtectionEntryFresh(entry, tick)) return 0;
  const existingReserve = Math.max(entry.localReserve ?? 0, entry.absoluteTarget ?? 0);
  const extraReserve = Math.max(0, (reserve ?? existingReserve) - existingReserve);
  return Math.min(getMarketProtectionSellableAmount(entry, tick), Math.max(0,
    getMarketProtectionSellableAmount(entry, tick, { requireTerminalBacking: false }) - extraReserve));
}

/** 出售分层和采矿暂停共用同一组生产保护及溢出阈值。 */
export function classifyProductionSurplus(entry: MarketProtectionEntry, tick: number, pressure = false): ProductionSurplusObservation {
  const complete = isBaseMarketResource(entry.resource) && isMarketProtectionEntryFresh(entry, tick) && !entry.blocked &&
    [entry.totalStock, entry.protectedAmount, entry.managedExposure, entry.forecastBuffer].every(value => Number.isSafeInteger(value) && value >= 0);
  const protectedAmount = entry.protectedAmount + entry.managedExposure;
  const overflowThreshold = protectedAmount + BASE_MINERAL_OVERFLOW_BAND;
  const liquidationThreshold = overflowThreshold + BASE_MINERAL_LIQUIDATION_BAND;
  return {
    roomName: entry.roomName, resource: entry.resource, observedAt: tick, complete, stock: entry.totalStock,
    productionReserve: Math.max(0, protectedAmount - entry.forecastBuffer),
    safetyBuffer: entry.forecastBuffer, protectedAmount, overflowThreshold, liquidationThreshold,
    overflowAmount: complete ? Math.max(0, entry.totalStock - overflowThreshold) : 0,
    tier: !complete ? "normal" : pressure && entry.totalStock > protectedAmount ? "liquidation"
      : entry.totalStock <= overflowThreshold ? "normal" : entry.totalStock > liquidationThreshold ? "liquidation" : "overflow",
    noBidRounds: 0,
    blockers: entry.issues?.slice(0, 8).map(issue => `${issue.code}:${issue.sourceKind ?? ""}`),
  };
}
