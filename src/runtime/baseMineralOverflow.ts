import {
  MARKET_BASE_BOOK_EMA_MAX_AGE_TICKS,
  MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE,
  clampMarketBaseDynamicFloorDailyDrop,
  isMarketBaseResource,
  type MarketBaseDynamicFloorState,
} from "@/runtime/marketBaseResourcePolicy";
import { isMarketProtectionEntryFresh, type MarketProtectionEntry } from "@/runtime/marketSaleProtection";
import { roundMarketPriceUp } from "@/runtime/marketSalePricing";
import { normalizeCapacityHeadroomPolicy } from "@/runtime/logistics/capacityHeadroom";

export const BASE_MINERAL_OVERFLOW_BAND = 30_000;
export const BASE_MINERAL_LIQUIDATION_BAND = 50_000;
export const BASE_MINERAL_NO_BID_ROUNDS = 5;
export type BaseMineralOverflowTier = "normal" | "overflow" | "liquidation";

export interface BaseMineralOverflowObservation {
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
  tier: BaseMineralOverflowTier;
  noBidRounds: number;
  lastAttemptAt?: number;
  reason?: string;
  paused?: "no_bid" | "storage_full";
  blockers?: string[];
  priceFloor?: number;
  priceDate?: string;
  priceTier?: BaseMineralOverflowTier;
}

interface OverflowRuntime {
  updatedAt: number;
  entries: Record<string, BaseMineralOverflowObservation>;
}

function runtime(): { baseMineralOverflow?: OverflowRuntime } | undefined {
  return Memory.runtime as unknown as { baseMineralOverflow?: OverflowRuntime } | undefined;
}

export function readBaseMineralOverflow(roomName: string, resource: string): BaseMineralOverflowObservation | undefined {
  return runtime()?.baseMineralOverflow?.entries[`${roomName}:${resource}`];
}

export function storageMineralPressure(room: Room | undefined): boolean {
  const free = room?.storage?.store.getFreeCapacity?.();
  const config = Memory.cfg?.resourceControl as unknown as { capacityBalancing?: unknown } | undefined;
  return typeof free === "number" && Number.isFinite(free) &&
    free < normalizeCapacityHeadroomPolicy(config?.capacityBalancing).storagePressureFreeCapacity;
}

/** 生产、在途与 exposure 原样保护；分层只使用账本扣除这些承诺后的余量。 */
export function classifyBaseMineralOverflow(entry: MarketProtectionEntry, tick: number, pressure = false): BaseMineralOverflowObservation {
  const complete = isMarketBaseResource(entry.resource) && isMarketProtectionEntryFresh(entry, tick) && !entry.blocked &&
    [entry.totalStock, entry.protectedAmount, entry.managedExposure, entry.forecastBuffer].every(value => Number.isSafeInteger(value) && value >= 0);
  const protectedAmount = entry.protectedAmount + entry.managedExposure;
  const overflowThreshold = protectedAmount + BASE_MINERAL_OVERFLOW_BAND;
  const liquidationThreshold = overflowThreshold + BASE_MINERAL_LIQUIDATION_BAND;
  return {
    roomName: entry.roomName, resource: entry.resource, observedAt: tick, complete,
    stock: entry.totalStock,
    productionReserve: Math.max(0, protectedAmount - entry.forecastBuffer),
    safetyBuffer: entry.forecastBuffer, protectedAmount, overflowThreshold, liquidationThreshold,
    overflowAmount: complete ? Math.max(0, entry.totalStock - overflowThreshold) : 0,
    tier: !complete ? "normal" : pressure && entry.totalStock > protectedAmount ? "liquidation"
      : entry.totalStock <= overflowThreshold ? "normal" : entry.totalStock > liquidationThreshold ? "liquidation" : "overflow",
    noBidRounds: 0,
    blockers: entry.issues?.slice(0, 8).map(issue => `${issue.code}:${issue.sourceKind ?? ""}`),
  };
}

export function liveBaseMineralOverflow(entry: MarketProtectionEntry, tick: number): BaseMineralOverflowObservation {
  return classifyBaseMineralOverflow(entry, tick, storageMineralPressure(Game.rooms?.[entry.roomName]));
}

/** 净价已在 planner 扣除运费能量影子成本，因此 1 credit 是成本之上的净收益。 */
export function baseMineralOverflowNetFloor(
  entry: MarketProtectionEntry,
  tick: number,
  normalFloor: number,
  projection: MarketBaseDynamicFloorState | undefined,
  pressure = storageMineralPressure(Game.rooms?.[entry.roomName]),
): number {
  const observation = classifyBaseMineralOverflow(entry, tick, pressure);
  if (!observation.complete || observation.tier === "normal") return normalFloor;
  if (observation.tier === "liquidation") return 1;
  const price = projection?.entries.find(value => value.resource === entry.resource);
  if (!price || price.bookEma === null || !Number.isFinite(price.bookEma) || price.bookEma <= 0 ||
    !Number.isSafeInteger(price.bookObservedAt) || price.bookObservedAt > tick || tick - price.bookObservedAt > MARKET_BASE_BOOK_EMA_MAX_AGE_TICKS) return normalFloor;
  const policy = isMarketBaseResource(entry.resource) ? MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[entry.resource] : undefined;
  if (!policy) return normalFloor;
  // 每条 lane 独立持久化下移锚；不能用正常区 EMA 地板每天把折让重新顶回去。
  const previous = readBaseMineralOverflow(entry.roomName, entry.resource);
  const date = new Date().toISOString().slice(0, 10);
  const hasAnchor = previous?.priceTier === "overflow" && typeof previous.priceFloor === "number" &&
    previous.priceFloor > 0 && typeof previous.priceDate === "string" && previous.priceDate <= date;
  const elapsedDays = hasAnchor ? Math.max(0, Math.floor((Date.parse(date) - Date.parse(previous.priceDate!)) / 86_400_000)) : 1;
  const floor = clampMarketBaseDynamicFloorDailyDrop({ target: Math.max(1, price.bookEma * 0.6),
    previous: hasAnchor ? previous.priceFloor! : normalFloor, maxDailyDynamicDrop: policy.maxDailyDynamicDrop,
    daysAdvanced: Number.isSafeInteger(elapsedDays) ? elapsedDays : 0 });
  return roundMarketPriceUp(Math.min(normalFloor, floor));
}

/** 保留 canonical 1000 tick 冷却；只对当前清仓/溢出连续 lane 投影较早门槛。 */
export function baseMineralOverflowCooldownNotBefore(baseline: number, checkpoint: number, tier: BaseMineralOverflowTier): number {
  return tier === "normal" ? baseline : Math.max(checkpoint, baseline - 1_000 + (tier === "overflow" ? 100 : 0));
}

export function recordBaseMineralOverflow(
  entries: readonly MarketProtectionEntry[], tick: number,
  attempts: Readonly<Record<string, "no_bid" | "bid" | "waiting">> = {},
  prices: Readonly<Record<string, number>> = {},
): void {
  const state = runtime();
  if (!state) return;
  const previous = state.baseMineralOverflow;
  const next: Record<string, BaseMineralOverflowObservation> = {};
  for (const entry of entries.slice(0, 112)) {
    if (!isMarketBaseResource(entry.resource)) continue;
    const key = `${entry.roomName}:${entry.resource}`;
    const old = previous?.entries[key];
    const observation = liveBaseMineralOverflow(entry, tick);
    const attempt = attempts[key];
    const continuous = old?.complete && old.observedAt <= tick && tick - old.observedAt <= 200;
    observation.noBidRounds = observation.tier === "liquidation" && continuous ? old.noBidRounds : 0;
    observation.lastAttemptAt = old?.lastAttemptAt;
    observation.priceFloor = old?.priceFloor;
    observation.priceDate = old?.priceDate;
    observation.priceTier = old?.priceTier;
    if (Number.isFinite(prices[key]) && prices[key] > 0) {
      observation.priceFloor = prices[key]; observation.priceDate = new Date().toISOString().slice(0, 10); observation.priceTier = observation.tier;
    }
    if (observation.complete && attempt && attempt !== "waiting" && old?.lastAttemptAt !== tick) {
      observation.lastAttemptAt = tick;
      observation.noBidRounds = attempt === "bid" ? 0 : Math.min(BASE_MINERAL_NO_BID_ROUNDS, observation.noBidRounds + 1);
    }
    observation.reason = !observation.complete ? "protection_incomplete" : attempt ?? "not_attempted";
    if ((!observation.complete || observation.tier !== "normal") && old?.paused) observation.paused = old.paused;
    if (observation.complete && observation.tier === "liquidation" && observation.noBidRounds >= BASE_MINERAL_NO_BID_ROUNDS) observation.paused = "no_bid";
    if (storageMineralPressure(Game.rooms?.[entry.roomName])) observation.paused = "storage_full";
    next[key] = observation;
  }
  state.baseMineralOverflow = { updatedAt: tick, entries: next };
}
