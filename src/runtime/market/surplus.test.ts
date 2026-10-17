import { productionSellableAmount } from "@/runtime/market/surplus";
import { legacyMarketFixture } from "../../../test/compactMarketFixture";

describe("统一生产可卖量", () => {
  it("提高储备只补足高于既有绝对生产目标的部分，继续扣除在途暴露", () => {
    const entry = legacyMarketFixture().protection.entries["E3N59:H"];
    Object.assign(entry, { totalStock: 50000, absoluteTarget: 30000, protectedAmount: 30000,
      grossSurplus: 20000, managedExposure: 1000,
      sourceContributions: [{ bucket: "managedExposure", amount: 1000 }] });
    expect(productionSellableAmount(entry, Game.time, 20000)).toBe(4000);
    expect(productionSellableAmount(entry, Game.time, 48000)).toBe(1000);
    expect(productionSellableAmount(entry, Game.time, 0)).toBe(4000);
  });
  it("旧快照和阻断不能形成可卖量", () => {
    const entry = legacyMarketFixture().protection.entries["E3N59:H"];
    expect(productionSellableAmount(entry, Game.time + 1)).toBe(0);
    entry.blocked = true; expect(productionSellableAmount(entry, Game.time)).toBe(0);
  });
});
