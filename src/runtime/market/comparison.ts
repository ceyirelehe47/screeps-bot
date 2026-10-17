import type { PlanMarketDirectContinuousInput, MarketDirectContinuousPlanningResult } from "@/runtime/marketDirectContinuousPlanner";
import type { MarketSaleProtectionLedger } from "@/runtime/marketSaleProtection";
import { isBaseMarketResource, resolveCompactMarketPolicy, type CompactMarketConfig } from "@/runtime/market/policy";
import { planCompactMarket, type CompactMarketBook, type CompactMarketLane, type CompactMarketCandidate } from "@/runtime/market/planner";
import { productionSellableAmount } from "@/runtime/market/surplus";
import { recordCompactMarketComparison, type MarketLaneComparison, type MarketComparisonSample, type MarketComparisonSelection } from "@/runtime/market/state";
import { priceToMilliUp } from "@/runtime/marketSalePricing";

interface Cycle {
  game: typeof Game;
  tick: number;
  cfg: CompactMarketConfig;
  protection?: MarketSaleProtectionLedger;
  staged?: {
    input: PlanMarketDirectContinuousInput;
    result: MarketDirectContinuousPlanningResult;
    costs: ReadonlyMap<string, number>;
    protection?: MarketSaleProtectionLedger;
  };
}
let cycle: Cycle | undefined;
const positive = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

/** 在生产入口重置同帧暂存；本函数不动旧状态，也不开始 CPU 计时。 */
export function beginMarketComparisonCycle(): void {
  cycle = undefined;
  const cfg = Memory.cfg?.market;
  if (cfg?.mode !== "dryRun") return;
  const last = Memory.data?.market?.comparison?.lastFullReadAttemptAt;
  const interval = positive(cfg.sampleIntervalTicks, 50, 5, 10_000);
  if (Number.isSafeInteger(last) && last! <= Game.time && Game.time - last! < interval) return;
  cycle = { game: Game, tick: Game.time, cfg };
}

export function stageMarketComparisonProtection(protection: MarketSaleProtectionLedger | undefined): void {
  if (cycle?.game === Game && cycle.tick === Game.time) cycle.protection = protection;
}

/** 只暂存指针；不遍历、不调成本回调，绝不改变原 full-read 的预算。 */
export function stageMarketComparisonPlan(
  input: PlanMarketDirectContinuousInput, result: MarketDirectContinuousPlanningResult,
  costs: ReadonlyMap<string, number> | undefined,
): void {
  if (cycle?.game !== Game || cycle.tick !== Game.time || cycle.staged || !costs) return;
  cycle.staged = { input, result, costs, protection: cycle.protection };
}

const selection = (candidate: CompactMarketCandidate | undefined): MarketComparisonSelection | undefined => candidate &&
  ({ room: candidate.roomName, resource: candidate.resource, order: candidate.orderId, amount: candidate.amount });
const legacySelection = (candidate: MarketDirectContinuousPlanningResult["selected"]): MarketComparisonSelection | undefined => candidate &&
  ({ room: candidate.roomName, resource: candidate.resourceType, order: candidate.order.id, amount: candidate.plannedAmount });
const same = (left: MarketComparisonSelection | undefined, right: MarketComparisonSelection | undefined): boolean =>
  left?.room === right?.room && left?.resource === right?.resource && left?.order === right?.order && left?.amount === right?.amount;

/** 在原交易完成后调用；所有写入只进入新的诊断根，内部异常不会穿透生产入口。 */
export function flushMarketComparison(): void {
  const current = cycle; cycle = undefined;
  if (!current || current.game !== Game || current.tick !== Game.time || Memory.cfg?.market?.mode !== "dryRun") return;
  // 等待期间只节流诊断，不能节流捕捉完整读取，否则会与旧规划周期永久错相。
  const last = Memory.data?.market?.comparison?.lastAttemptAt;
  if (!current.staged && Number.isSafeInteger(last) && last! <= Game.time &&
      Game.time - last! < positive(current.cfg.sampleIntervalTicks, 50, 5, 10000)) return;
  const started = Game.cpu.getUsed();
  const sample: MarketComparisonSample = {
    tick: Game.time, atMs: Date.now(), shard: Game.shard.name,
    sourceCommit: Memory.runtime?.lastDeployCommit ?? "development",
    configuration: JSON.stringify(current.cfg.overrides ?? {}), complete: false, lanes: [], cpu: 0, fullRead: !!current.staged,
  };
  try {
    if (sample.configuration.length > 4000) { sample.configuration = "invalid"; throw new Error("configuration_too_large"); }
    if (Game.cpu.bucket < positive(current.cfg.minBucket, 9000, 0, 10_000) ||
        Game.cpu.limit - started < 15) throw new Error("cpu_budget");
    const staged = current.staged;
    if (!staged) throw new Error("waiting_for_v3_full_read");
    if (!staged.result.complete || !staged.input.energyShadow.complete || !staged.protection || staged.protection.globalBlocked) throw new Error("legacy_facts_incomplete");
    const maxCpu = positive(current.cfg.maxCpu, 3, 0.1, 5);
    const lanes: CompactMarketLane[] = [], books: CompactMarketBook[] = [], rows: MarketLaneComparison[] = [];
    for (const entry of staged.input.entries) {
      const resource = entry.policy.resourceType;
      if (!isBaseMarketResource(resource)) throw new Error("resource_invalid");
      const basePolicy = resolveCompactMarketPolicy(resource, current.cfg);
      if (!basePolicy) throw new Error("policy_invalid");
      const book = entry.book;
      if (!book) throw new Error("book_missing");
      books.push({ resource, complete: book.complete, orders: book.orders, ownOrderIds: book.ownOrderIds });
      for (const lane of entry.lanes) {
        const key = `${lane.lane.roomName}:${resource}`, protection = staged.protection.entries[key];
        if (!protection) throw new Error("protection_missing");
        // r8 溢出/清仓可以低于普通经济底价。首发以该分层报价作为输入事实，
        // 普通政策覆盖仍能显式提高观察底价；这里不声称独立验证 EMA/每日限幅模型。
        const tier = lane.pricing?.tier ?? "normal";
        const policy = { ...basePolicy };
        if (tier !== "normal") {
          policy.hardNetFloor = current.cfg.overrides?.[resource]?.hardNetFloor ?? lane.pricing!.effectiveNetFloor;
          policy.economicNetFloor = current.cfg.overrides?.[resource]?.economicNetFloor ?? lane.pricing!.effectiveNetFloor;
          policy.minNotional = current.cfg.overrides?.[resource]?.minNotional ?? lane.pricing!.minExecutableNotional;
        }
        const sellable = productionSellableAmount(protection, Game.time, policy.reserve);
        const floor = lane.pricing?.effectiveNetFloor ?? Math.max(entry.policy.hardNetFloor, entry.policy.economicNetFloor,
          entry.policy.historyNetFloor ?? 0, entry.policy.ratchetNetFloor ?? 0);
        rows.push({ key, protectionEqual: sellable === lane.protection.sellableAmount,
          floorEqual: priceToMilliUp(Math.max(policy.hardNetFloor, policy.economicNetFloor, floor)) === priceToMilliUp(floor), selectionEqual: false });
        lanes.push({ roomName: lane.lane.roomName, resource, fresh: protection.fresh && !protection.blocked &&
          protection.observedAt <= Game.time && protection.expiresAt >= Game.time,
          sellable, terminal: { ready: lane.terminal.normal && lane.terminal.ready === true,
            cooldown: lane.terminal.cooldown, claimed: lane.terminal.claimed,
            resourceAmount: lane.terminal.resourceAmount, energy: lane.terminal.energy,
            reserve: lane.terminal.effectivePostDealEnergyReserve ?? policy.terminalEnergyReserve },
          floor, minNotional: lane.pricing?.minExecutableNotional ?? entry.policy.minExecutableNotional, policy });
      }
    }
    const plan = planCompactMarket({ tick: Game.time, energyPrice: staged.input.energyShadow.price, lanes, books,
      minDealAmount: 1000,
      transactionEnergy: (amount, from, to) => staged.costs.get(`${amount}:${from}:${to}`),
      shouldStop: () => Game.cpu.getUsed() - started > maxCpu });
    sample.complete = plan.complete && rows.length > 0;
    sample.reason = plan.reason ?? (rows.length === 0 ? "no_writable_lanes" : undefined);
    for (const row of rows) {
      const best = plan.candidates.find(candidate => `${candidate.roomName}:${candidate.resource}` === row.key);
      const old = staged.result.safeCandidates.find(candidate => `${candidate.roomName}:${candidate.resourceType}` === row.key);
      row.selectionEqual = same(selection(best), legacySelection(old));
    }
    sample.lanes = rows;
    sample.selected = selection(plan.selected);
    sample.legacySelected = legacySelection(staged.result.safeCandidates[0]);
    sample.legacyAdmitted = legacySelection(staged.result.selected);
  } catch (error) {
    sample.complete = false;
    sample.reason = error instanceof Error ? error.message.slice(0, 100) : "observer_failed";
  }
  try {
    sample.cpu = Math.max(0, Game.cpu.getUsed() - started);
    // 未知 schema 保持原样；本阶段不迁移、不接管外部已有 market 根。
    if (Memory.data?.market !== undefined && Memory.data.market.v !== 1) return;
    if (!Memory.data) return;
    const state = Memory.data.market ??= { v: 1 };
    recordCompactMarketComparison(state, sample);
  } catch { /* 诊断异常不能改变已执行的交易与后续主循环。 */ }
}
