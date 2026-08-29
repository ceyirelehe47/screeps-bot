/**
 * Protection 同 tick memo 回归测试（提交 D）：
 * - 相同输入（config/managedOrders/options 同引用、同 tick）的第二次收集
 *   复用第一次的只读 ledger，不重扫全部来源；
 * - tick 变化或任一输入引用变化后重新收集；
 * - 复用结果与首次结果内容一致（等价性）。
 */
import {
  clearProtectionLedgerTickMemoForTest,
  collectLiveMarketSaleProtectionLedger,
  getProtectionLedgerMemoHitsForTest,
} from "@/runtime/marketSaleProtectionAdapter";
import { clearMarketPerformanceCountersForTest, readMarketPerformanceCounters } from "@/runtime/marketPerformanceCounters";
import type { MarketSaleAutomationConfig } from "@/runtime/marketSaleConfig";
import { resolveMarketSaleAutomationConfig } from "@/runtime/marketSaleConfig";

describe("protection ledger tick memo", () => {
  let collectCalls: number;

  beforeEach(() => {
    clearProtectionLedgerTickMemoForTest();
    clearMarketPerformanceCountersForTest();
    Game.time = 100;
    Memory.cfg = undefined;
    Memory.data = undefined;
    Game.rooms = {};
    Game.market = { orders: {} } as unknown as Market;
    collectCalls = 0;
  });

  function collectTwiceWithSameInputs() {
    const config = resolveMarketSaleAutomationConfig();
    const options = { candidates: [{ roomName: "E1N1", resource: RESOURCE_ENERGY }] };
    const first = collectLiveMarketSaleProtectionLedger(config, undefined, options);
    const second = collectLiveMarketSaleProtectionLedger(config, undefined, options);
    return { first, second, config, options };
  }

  it("reuses the ledger for identical inputs within the same tick and counts the avoided duplicate", () => {
    const { first, second } = collectTwiceWithSameInputs();

    expect(second).toBe(first);
    expect(getProtectionLedgerMemoHitsForTest()).toBe(1);
    expect(readMarketPerformanceCounters().duplicateProtectionReadsAvoided).toBe(1);
  });

  it("recollects after the tick advances", () => {
    const { first } = collectTwiceWithSameInputs();
    const hitsBeforeAdvance = getProtectionLedgerMemoHitsForTest();
    expect(hitsBeforeAdvance).toBe(1);
    Game.time += 1;
    const config = resolveMarketSaleAutomationConfig();
    const options = { candidates: [{ roomName: "E1N1", resource: RESOURCE_ENERGY }] };
    const next = collectLiveMarketSaleProtectionLedger(config, undefined, options);

    // tick 前进后不复用旧 ledger，也没有新的 memo 命中。
    expect(next).not.toBe(first);
    expect(getProtectionLedgerMemoHitsForTest()).toBe(hitsBeforeAdvance);
  });

  it("recollects when the options reference changes", () => {
    const config = resolveMarketSaleAutomationConfig() as MarketSaleAutomationConfig;
    const optionsA = { candidates: [{ roomName: "E1N1", resource: RESOURCE_ENERGY }] };
    const optionsB = { candidates: [{ roomName: "E1N1", resource: RESOURCE_ENERGY }] };
    const first = collectLiveMarketSaleProtectionLedger(config, undefined, optionsA);
    const second = collectLiveMarketSaleProtectionLedger(config, undefined, optionsB);

    // 内容相同但引用不同：保守重新收集（fail-closed），不复用。
    expect(second).not.toBe(first);
    expect(getProtectionLedgerMemoHitsForTest()).toBe(0);
  });
});
