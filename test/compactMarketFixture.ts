import { resolveCompactMarketPolicy } from "@/runtime/market/policy";
import type { CompactMarketLane } from "@/runtime/market/planner";
import type { MarketDirectContinuousEntryInput, PlanMarketDirectContinuousInput } from "@/runtime/marketDirectContinuousPlanner";
import type { MarketProtectionEntry, MarketSaleProtectionLedger } from "@/runtime/marketSaleProtection";
import type { MarketOrderSnapshot } from "@/runtime/marketSalePricing";

export const compactOrder = (id = "bid", price = 600, amount = 1000): MarketOrderSnapshot =>
  ({ id, type: "buy", resourceType: "H", roomName: "E20S20", price, amount });
export function compactLane(roomName = "E3N59"): CompactMarketLane {
  const policy = resolveCompactMarketPolicy("H")!;
  return { roomName, resource: "H", fresh: true, sellable: 5000, floor: 451, minNotional: 451000, policy,
    terminal: { ready: true, cooldown: 0, claimed: false, resourceAmount: 5000, energy: 50000, reserve: 25000 } };
}
export function legacyMarketFixture(orders = [compactOrder()]): {
  input: PlanMarketDirectContinuousInput; protection: MarketSaleProtectionLedger; costs: Map<string, number>;
} {
  const costs = new Map<string, number>();
  const fee = (amount: number, order: MarketOrderSnapshot, from: string): number => {
    const value = amount === 1 ? 1 : 100;
    costs.set(`${amount}:${from}:${order.roomName}`, value); return value;
  };
  const entry: MarketDirectContinuousEntryInput = {
    policy: { entryId: "h-v3", revision: "h-v3", resourceType: "H", allowedRooms: ["E3N59"], requireNativeMineral: true,
      grant: "continuous", hardNetFloor: 428, economicNetFloor: 451, minExecutableNotional: 451000,
      maxRawOrders: 1000, maxEligibleOrders: 200, maxTransactionEnergy: 1000, terminalEnergyReserve: 25000,
      resourceRollingCap: 8000, opportunityReserve: 1000, evaluatorVersion: 3 },
    quota: { complete: true, revision: "quota", resourceType: "H", rollingCap: 8000, confirmedAmount: 0,
      unmatchedPlannedAmount: 0, opportunityReserveSatisfied: false },
    book: { complete: true, revision: "book", orders, ownOrderIds: [] }, calculateTransactionEnergy: fee,
    lanes: [{ lane: { roomName: "E3N59", resourceType: "H", owned: true, hub: false, capacityEmergency: false,
      nativeMineralType: "H", authorization: "writable" },
    protection: { complete: true, revision: "protection", sellableAmount: 5000 },
    terminal: { revision: "terminal", normal: true, ready: true, claimed: false, cooldown: 0,
      resourceAmount: 5000, energy: 50000, effectivePostDealEnergyReserve: 25000 },
    quota: { complete: true, revision: "lane-quota", roomRollingCap: 5000, roomConfirmedAmount: 0,
      roomUnmatchedPlannedAmount: 0, laneRollingCap: 3000, laneConfirmedAmount: 0, laneUnmatchedPlannedAmount: 0 } }],
  };
  const protectedEntry: MarketProtectionEntry = { roomName: "E3N59", resource: "H", totalStock: 21000, terminalStock: 5000,
    hardReserve: 16000, localReserve: 16000, productionDemand: 0, forecastBuffer: 16000, protectedOutgoing: 0,
    carrierOrInFlight: 0, protectedAmount: 16000, grossSurplus: 5000, managedExposure: 0, newExposureCapacity: 5000,
    sellableAmount: 5000, fresh: true, blocked: false, blockedReasons: [], issues: [], sourceContributions: [],
    revision: Game.time, observedAt: Game.time, expiresAt: Game.time };
  return { input: { entries: [entry], energyShadow: { complete: true, revision: "energy", price: 32.06 },
    globalQuota: { complete: true, revision: "global", rollingCap: 12000, confirmedAmount: 0, unmatchedPlannedAmount: 0 },
    writeContext: { complete: true, revision: "write", credits: 10000000, executorShard: "shard1", permitEpoch: 1,
      permitId: "permit", permitHead: "head", pendingState: "none", arbiterState: "available" } },
    protection: { currentTick: Game.time, fresh: true, entries: { "E3N59:H": protectedEntry }, blockedEntryCount: 0,
      revision: Game.time, observedAt: Game.time, expiresAt: Game.time }, costs };
}
