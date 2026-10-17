import type { MarketOrderSnapshot } from "@/runtime/marketSalePricing";
import { priceToMilliDown, priceToMilliUp } from "@/runtime/marketSalePricing";
import type { CompactMarketPolicy, MarketResource } from "@/runtime/market/policy";
import { compareNetUnitPrice, quoteNetDeal } from "@/runtime/market/pricing";

export interface CompactMarketLane {
  roomName: string;
  resource: MarketResource;
  fresh: boolean;
  sellable: number;
  terminal: { ready: boolean; cooldown: number; claimed: boolean; resourceAmount: number; energy: number; reserve: number };
  floor: number;
  minNotional: number;
  policy: CompactMarketPolicy;
  lastDealTick?: number;
  windowAmount?: number;
}

export interface CompactMarketBook {
  resource: MarketResource;
  complete: boolean;
  orders: readonly MarketOrderSnapshot[];
  ownOrderIds: readonly string[];
}

export interface CompactMarketCandidate {
  roomName: string;
  resource: MarketResource;
  orderId: string;
  orderRoom: string;
  amount: number;
  transactionEnergy: number;
  grossPriceMilli: number;
  netCreditsMilli: number;
  floorMilli: number;
}

export interface CompactMarketPlanInput {
  tick: number;
  energyPrice: number;
  lanes: readonly CompactMarketLane[];
  books: readonly CompactMarketBook[];
  transactionEnergy: (amount: number, from: string, to: string) => number | undefined;
  /** 对照旧管线时明确传 1000；未来普通政策允许变额。 */
  minDealAmount?: number;
  shouldStop?: () => boolean;
}

export interface CompactMarketPlan {
  complete: boolean;
  reason?: string;
  candidates: CompactMarketCandidate[];
  selected?: CompactMarketCandidate;
  evaluatedTuples: number;
}

const validAmount = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const stable = (left: string, right: string): number => left === right ? 0 : left < right ? -1 : 1;

export function compareCompactMarketCandidates(left: CompactMarketCandidate, right: CompactMarketCandidate): number {
  return -compareNetUnitPrice(left.netCreditsMilli, left.amount, right.netCreditsMilli, right.amount) ||
    (left.netCreditsMilli === right.netCreditsMilli ? 0 : left.netCreditsMilli > right.netCreditsMilli ? -1 : 1) ||
    (left.grossPriceMilli === right.grossPriceMilli ? 0 : left.grossPriceMilli > right.grossPriceMilli ? -1 : 1) ||
    stable(left.resource, right.resource) || stable(left.roomName, right.roomName) || stable(left.orderId, right.orderId);
}

/** 纯挑单：一个 lane 保留最优单；没有 Game/Memory、许可、仲裁或交易写入依赖。 */
export function planCompactMarket(input: CompactMarketPlanInput): CompactMarketPlan {
  let evaluatedTuples = 0;
  const incomplete = (reason: string): CompactMarketPlan => ({ complete: false, reason, candidates: [], evaluatedTuples });
  if (!Number.isSafeInteger(input.tick) || input.tick < 0 || !Number.isFinite(input.energyPrice) || input.energyPrice < 0 ||
      input.lanes.length > 128 || input.books.length > 7) return incomplete("input_invalid");
  const minimum = input.minDealAmount ?? 1;
  if (!validAmount(minimum) || minimum < 1) return incomplete("amount_invalid");
  const books = new Map<MarketResource, MarketOrderSnapshot[]>();
  const allOrderIds = new Map<string, string>();
  for (const book of input.books) {
    if (!book.complete || books.has(book.resource) || !Array.isArray(book.orders) || book.orders.length > 1000) return incomplete("book_incomplete");
    const own = new Set(book.ownOrderIds), orders: MarketOrderSnapshot[] = [];
    for (const order of book.orders) {
      if (input.shouldStop?.()) return incomplete("cpu_budget");
      if (!order || typeof order.id !== "string" || !order.id || order.type !== "buy" || order.resourceType !== book.resource || typeof order.roomName !== "string" || !order.roomName ||
          !Number.isFinite(order.price) || order.price <= 0 || !validAmount(order.amount) || order.amount < 1 ||
          order.remainingAmount !== undefined && (!validAmount(order.remainingAmount) || order.remainingAmount < 1)) return incomplete("order_invalid");
      const identity = [book.resource, order.roomName, order.price, order.amount, order.remainingAmount ?? ""].join("|");
      const previous = allOrderIds.get(order.id);
      if (previous !== undefined) { if (previous !== identity) return incomplete("order_conflict"); else continue; }
      allOrderIds.set(order.id, identity);
      if (!own.has(order.id)) orders.push(order);
    }
    books.set(book.resource, orders);
  }
  const candidates: CompactMarketCandidate[] = [], laneIds = new Set<string>();
  for (const lane of input.lanes) {
    const key = `${lane.roomName}:${lane.resource}`, policy = lane.policy, terminal = lane.terminal;
    if (laneIds.has(key) || !lane.fresh || ![lane.sellable, terminal.resourceAmount, terminal.energy, terminal.reserve, terminal.cooldown].every(validAmount) ||
        !Number.isFinite(lane.floor) || lane.floor <= 0 || !Number.isFinite(lane.minNotional) || lane.minNotional < 0) return incomplete("lane_incomplete");
    laneIds.add(key);
    const orders = books.get(lane.resource);
    if (!orders) return incomplete("book_missing");
    if (!Object.values(policy).every(value => Number.isFinite(value) && value >= 0) ||
        ![policy.maxPerDeal, policy.maxPerWindow, policy.minIntervalTicks, policy.maxTransactionEnergy, policy.terminalEnergyReserve].every(validAmount) ||
        policy.maxPerDeal < 1 || policy.hardNetFloor <= 0) return incomplete("policy_invalid");
    if (terminal.ready !== true || terminal.claimed || terminal.cooldown !== 0 || lane.lastDealTick !== undefined && input.tick < lane.lastDealTick + policy.minIntervalTicks) continue;
    let best: CompactMarketCandidate | undefined;
    for (const order of orders) {
      if (input.shouldStop?.() || ++evaluatedTuples > 24_000) return incomplete("cpu_budget");
      const remaining = Math.min(order.amount, order.remainingAmount ?? order.amount);
      const amount = Math.min(remaining, lane.sellable, terminal.resourceAmount, policy.maxPerDeal,
        Math.max(0, policy.maxPerWindow - (lane.windowAmount ?? 0)));
      if (!validAmount(amount)) return incomplete("amount_invalid");
      if (amount < minimum) continue;
      try {
        const notional = priceToMilliDown(order.price) * amount;
        if (!Number.isSafeInteger(notional)) return incomplete("unsafe_arithmetic");
        if (notional < priceToMilliUp(Math.max(lane.minNotional, policy.minNotional))) continue;
      } catch { return incomplete("unsafe_arithmetic"); }
      // 对照时 callback 只读 memo，缺失绝不重跑原 V3 的成本回调。
      const fee = input.transactionEnergy(amount, lane.roomName, order.roomName!);
      const worst = input.transactionEnergy(1, lane.roomName, order.roomName!);
      if (fee === undefined || worst === undefined) return incomplete("cost_evidence_missing");
      if (![fee, worst].every(validAmount)) return incomplete("cost_invalid");
      if (fee > policy.maxTransactionEnergy || worst > policy.maxTransactionEnergy ||
          terminal.energy - Math.max(fee, worst) < Math.max(terminal.reserve, policy.terminalEnergyReserve)) continue;
      const quote = quoteNetDeal(order.price, amount, fee, worst, input.energyPrice,
        Math.max(policy.hardNetFloor, policy.economicNetFloor, lane.floor), Math.max(policy.minNotional, lane.minNotional));
      if (!quote) continue;
      const candidate: CompactMarketCandidate = { roomName: lane.roomName, resource: lane.resource,
        orderId: order.id, orderRoom: order.roomName!, amount, transactionEnergy: fee,
        grossPriceMilli: quote.grossPriceMilli, netCreditsMilli: quote.netCreditsMilli, floorMilli: quote.floorMilli };
      if (!best || compareCompactMarketCandidates(candidate, best) < 0) best = candidate;
    }
    if (best) candidates.push(best);
  }
  candidates.sort(compareCompactMarketCandidates);
  return { complete: true, candidates, selected: candidates[0], evaluatedTuples };
}
