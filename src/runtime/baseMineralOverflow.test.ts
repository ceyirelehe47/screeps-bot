import { baseMineralOverflowCooldownNotBefore, baseMineralOverflowNetFloor, classifyBaseMineralOverflow, readBaseMineralOverflow, recordBaseMineralOverflow } from "@/runtime/baseMineralOverflow";
import { MARKET_BASE_DYNAMIC_FLOOR_MODEL_REVISION, type MarketBaseDynamicFloorState } from "@/runtime/marketBaseResourcePolicy";
import type { MarketProtectionEntry } from "@/runtime/marketSaleProtection";

export function overflowEntry(stock: number, demand = 0): MarketProtectionEntry {
  return { roomName: "E1N1", resource: RESOURCE_CATALYST, totalStock: stock, terminalStock: 5_000,
    protectedAmount: 16_000 + demand, forecastBuffer: 16_000, managedExposure: 0,
    fresh: true, blocked: false, revision: Game.time, observedAt: Game.time, expiresAt: Game.time,
  } as MarketProtectionEntry;
}

describe("基础矿物生产保护与分层出口", () => {
  beforeEach(() => { Memory.runtime = {}; Memory.cfg = {}; Game.rooms = {}; });
  it("按每房实际保护量划分正常、溢出、清仓；生产上升自动抬线", () => {
    expect(classifyBaseMineralOverflow(overflowEntry(46_000), Game.time).tier).toBe("normal");
    expect(classifyBaseMineralOverflow(overflowEntry(46_001), Game.time).tier).toBe("overflow");
    expect(classifyBaseMineralOverflow(overflowEntry(96_001), Game.time).tier).toBe("liquidation");
    const protectedStock = classifyBaseMineralOverflow(overflowEntry(96_001, 70_000), Game.time);
    expect(protectedStock).toMatchObject({ tier: "normal", productionReserve: 70_000, safetyBuffer: 16_000, overflowAmount: 0 });
    expect(classifyBaseMineralOverflow(overflowEntry(20_000), Game.time, true).tier).toBe("liquidation");
    expect(classifyBaseMineralOverflow({ ...overflowEntry(100_000), blocked: true }, Game.time).complete).toBe(false);
  });
  it("清仓只要求扣除运费后的净收益；溢出使用新鲜EMA并保留每日限幅", () => {
    const date = new Date().toISOString().slice(0, 10);
    const projection = { schemaVersion: 1, modelRevision: MARKET_BASE_DYNAMIC_FLOOR_MODEL_REVISION, updatedAt: Game.time,
      entries: [{ resource: RESOURCE_CATALYST, bookEma: 100, bookObservedAt: Game.time, dailyAnchor: 100, anchorDate: date, lastObservedPrice: 100, dynamicFloor: 100, inventoryFactor: 1, surplusRatio: 2 }],
    } as MarketBaseDynamicFloorState;
    expect(baseMineralOverflowNetFloor(overflowEntry(100_000), Game.time, 390, projection, false)).toBe(1);
    expect(baseMineralOverflowNetFloor(overflowEntry(60_000), Game.time, 390, projection, false)).toBe(331.5);
    expect(baseMineralOverflowNetFloor(overflowEntry(60_000), Game.time, 390, undefined, false)).toBe(390);
    expect(baseMineralOverflowNetFloor(overflowEntry(30_000), Game.time, 390, projection, false)).toBe(390);
  });
  it("加速不回写canonical冷却，并尊重checkpoint；无权限等待不累计无买单轮次", () => {
    expect(baseMineralOverflowCooldownNotBefore(2_000, 500, "normal")).toBe(2_000);
    expect(baseMineralOverflowCooldownNotBefore(2_000, 500, "overflow")).toBe(1_100);
    expect(baseMineralOverflowCooldownNotBefore(2_000, 1_050, "liquidation")).toBe(1_050);
    for (let i = 0; i < 5; i++) { recordBaseMineralOverflow([overflowEntry(100_000)], Game.time, { "E1N1:X": "waiting" }); Game.time++; }
    expect(readBaseMineralOverflow("E1N1", "X")?.noBidRounds).toBe(0);
    for (let i = 0; i < 5; i++) { recordBaseMineralOverflow([overflowEntry(100_000)], Game.time, { "E1N1:X": "no_bid" }); Game.time++; }
    expect(readBaseMineralOverflow("E1N1", "X")?.noBidRounds).toBe(5);
    recordBaseMineralOverflow([overflowEntry(100_000)], Game.time, { "E1N1:X": "bid" });
    expect(readBaseMineralOverflow("E1N1", "X")?.noBidRounds).toBe(0);
  });
});
