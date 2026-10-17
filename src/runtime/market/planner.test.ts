import { planCompactMarket, type CompactMarketPlanInput } from "@/runtime/market/planner";
import { compareNetUnitPrice, quoteNetDeal } from "@/runtime/market/pricing";
import { MARKET_RESOURCES, resolveCompactMarketPolicy } from "@/runtime/market/policy";
import { marketBaseResourcePolicy } from "@/runtime/marketBaseResourcePolicy";
import { planMarketDirectContinuous } from "@/runtime/marketDirectContinuousPlanner";
import { compactLane, compactOrder, legacyMarketFixture } from "../../../test/compactMarketFixture";

function input(): CompactMarketPlanInput {
  return { tick: Game.time, energyPrice: 32.06, lanes: [compactLane()],
    books: [{ resource: "H", complete: true, orders: [compactOrder()], ownOrderIds: [] }],
    transactionEnergy: amount => amount === 1 ? 1 : 100 };
}
describe("精简市场纯挑单", () => {
  it.each(MARKET_RESOURCES)("%s 普通政策保持当前 credits 单位与限额", resource => {
    const old = marketBaseResourcePolicy(resource), next = resolveCompactMarketPolicy(resource)!;
    expect(next).toMatchObject({ hardNetFloor: old.hardFloor, economicNetFloor: old.economicFloor,
      reserve: old.laneReserve, minNotional: old.minOrderNotional, maxPerDeal: old.maxDealAmount,
      minIntervalTicks: old.cooldownTicks, maxPerWindow: old.rollingMaxAmount, windowTicks: old.rollingWindowTicks,
      maxTransactionEnergy: old.maxTransactionEnergy, terminalEnergyReserve: old.terminalEnergyReserve });
  });
  it.each([500, 600, 483.06, 483.0599])("与旧纯内核对齐底价边界 %s", price => {
    const fixture = legacyMarketFixture([compactOrder("bid", price)]), legacy = planMarketDirectContinuous(fixture.input);
    expect(legacy.complete).toBe(true);
    const next = input(); next.books[0].orders = [compactOrder("bid", price)];
    const result = planCompactMarket(next);
    expect(result.complete).toBe(true);
    expect(result.selected?.orderId).toBe(legacy.safeCandidates[0]?.order.id);
    expect(result.selected?.netCreditsMilli).toBe(legacy.safeCandidates[0]?.netCreditsMilli);
  });
  it("支持变额，但对照时仍严格保持 1000", () => {
    const next = input(); next.lanes[0].sellable = 500; next.lanes[0].minNotional = 0; next.lanes[0].policy.minNotional = 0;
    expect(planCompactMarket(next).selected?.amount).toBe(500);
    expect(planCompactMarket({ ...next, minDealAmount: 1000 }).selected).toBeUndefined();
  });
  it("自有单排除、重复单去重、字典序打破平局，且不修改输入", () => {
    const next = input(); next.books[0].orders = [compactOrder("self", 900), compactOrder("z"), compactOrder("a"), compactOrder("a")];
    next.books[0].ownOrderIds = ["self"];
    const before = JSON.stringify(next); Object.freeze(next.books[0].orders);
    expect(planCompactMarket(next).selected?.orderId).toBe("a"); expect(JSON.stringify(next)).toBe(before);
  });
  it.each(["cost", "budget", "stale", "conflict", "unsafe", "counter", "identity"])("不完整 %s 不产生候选", kind => {
    const next = input();
    if (kind === "cost") next.transactionEnergy = () => undefined;
    if (kind === "budget") next.shouldStop = () => true;
    if (kind === "stale") next.lanes[0].fresh = false;
    if (kind === "conflict") next.books[0].orders = [compactOrder(), compactOrder("bid", 700)];
    if (kind === "unsafe") next.books[0].orders = [compactOrder("bid", Number.MAX_SAFE_INTEGER)];
    if (kind === "counter") next.lanes[0].windowAmount = -1;
    if (kind === "identity") next.books[0].ownOrderIds = undefined as any;
    expect(planCompactMarket(next)).toMatchObject({ complete: false, candidates: [] });
  });
  it.each(["claimed", "cooldown", "reserve", "cap", "interval"])("保留 %s 限制", kind => {
    const next = input(), lane = next.lanes[0];
    if (kind === "claimed") lane.terminal.claimed = true;
    if (kind === "cooldown") lane.terminal.cooldown = 1;
    if (kind === "reserve") lane.terminal.energy = 25099;
    if (kind === "cap") lane.windowAmount = lane.policy.maxPerWindow;
    if (kind === "interval") lane.lastDealTick = Game.time;
    expect(planCompactMarket(next)).toMatchObject({ complete: true, selected: undefined });
  });
  it("milli 保守舍入并检查 1 单位最坏运费", () => {
    expect(quoteNetDeal(100.0009, 1000, 1, 1, 0, 100.0001, 0)).toBeUndefined();
    expect(quoteNetDeal(500, 1000, 1, 2, 32.06, 451, 0)).toBeUndefined();
    expect(quoteNetDeal(600, 1000, 100, 1, 32.06, 451, 451000)?.netCreditsMilli).toBe(596794000);
  });
  it("大整数净价比较不使用危险交叉乘法", () => {
    expect(compareNetUnitPrice(Number.MAX_SAFE_INTEGER, 99999, Number.MAX_SAFE_INTEGER - 1, 99999)).toBe(1);
    expect(compareNetUnitPrice(6, 3, 4, 2)).toBe(0);
    expect(() => compareNetUnitPrice(1, 0, 2, 1)).toThrow();
    expect(resolveCompactMarketPolicy("H", { overrides: { H: { reserve: NaN } } })).toBeUndefined();
  });
});
