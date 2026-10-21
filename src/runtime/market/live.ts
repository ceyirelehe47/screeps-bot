import { enforceLegacyMarketSafetyLatch, resolveMarketSaleAutomationConfig } from "@/runtime/marketSaleConfig";
import { claimPreparedDirectMarketClaims, executePreparedDirectMarketDeal, getMarketAccountClaim, hasTerminalActionClaim, releasePreparedDirectMarketClaims, isExplicitMarketNonOkReturnCode } from "@/runtime/marketActionArbiter";
import { collectLiveMarketSaleProtectionLedger } from "@/runtime/marketSaleProtectionAdapter";
import { collectMarketSalePriceSnapshots, type MarketSalePricingReadMarket } from "@/runtime/marketSalePricingAdapter";
import { buildMarketBaseDynamicFloorState, marketBaseEnforcedDynamicFloors } from "@/runtime/marketBaseResourcePolicy";
import { baseMineralOverflowNetFloor, liveBaseMineralOverflow, recordBaseMineralOverflow } from "@/runtime/baseMineralOverflow";
import { computeEffectiveNetFloor, priceToMilliDown } from "@/runtime/marketSalePricing";
import { productionSellableAmount } from "@/runtime/market/surplus";
import { planCompactMarket, type CompactMarketLane, type CompactMarketPlan } from "@/runtime/market/planner";
import { resolveCompactMarketPolicy, type CompactMarketConfig, type MarketResource } from "@/runtime/market/policy";
import { quoteNetDeal } from "@/runtime/market/pricing";
import { compactConfiguration, compactCount, compactLanePresent, compactLegacyQuietReason, compactRecord, validCompactLane, validCompactLiveState, validCompactReceipt, type CompactMarketLiveState, type CompactLiveReceipt, type CompactLivePending } from "@/runtime/market/liveState";
import type { MarketSaleAutomationResult } from "@/runtime/marketSaleAutomation";
import type { MarketTerminalEnergyAuthorizationRead } from "@/runtime/resourceTerminalLogistics";
import { hasTreasuryTerminalFence } from "@/runtime/treasuryTaskCommitmentBridge";
import { readLiveMarketBaseTerminal } from "@/runtime/marketBaseResourceReadiness";

const ACTOR = "market:compact";
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const historyCache = new Map<string, { tick: number; game: typeof Game; rows: PriceHistory[] }>();

function note(state: CompactMarketLiveState, reason: string): void {
  state.lastReason = reason;
  state.audit.push({ tick: Game.time, reason });
  state.audit = state.audit.slice(-20);
}
function result(state: CompactMarketLiveState | undefined, reason?: string, writes = 0): MarketSaleAutomationResult {
  return { requestedMode: Memory.cfg?.market?.mode === "live" ? "direct" : "off", effectiveMode: state?.phase === "active" && !state.blocker && !reason ? "direct" : "off",
    phase: reason || state?.blocker || state?.phase !== "active" ? "stopped" : "direct", writes,
    actions: writes ? ["compact-deal-submitted"] : [], rejectedByReason: reason ? { [reason]: 1 } : {} };
}
function initialize(config: CompactMarketConfig): CompactMarketLiveState {
  const authorization = config.cutover;
  if (!authorization || authorization.sourceCommit !== Memory.runtime?.lastDeployCommit ||
      !/^[a-f0-9]{64}$/.test(authorization.archiveHash) || !authorization.authorization || authorization.authorization.length > 200 ||
      !Array.isArray(authorization.lanes) || !authorization.lanes.length || authorization.lanes.length > 128 ||
      !authorization.lanes.every(validCompactLane) || !authorization.lanes.every(compactLanePresent)) throw Error("activation_invalid");
  const data = Memory.data!.marketSaleAutomation!;
  const base = (data.directAutomation as any)?.baseResourceV3;
  if (!compactRecord(base?.scope) || !Array.isArray(base.scope.laneLifecycles) || !compactRecord(base.ledger) ||
      !compactCount(base.ledger.confirmedCooldownNotBefore) || !compactCount(base.ledger.checkpoint?.confirmedCooldownNotBeforeHighWater)) throw Error("migration_state_invalid");
  for (const lane of authorization.lanes) if (!base.scope.laneLifecycles.some((old: any) => old.stage === "continuous" && old.status === "writable" && old.sellerRoomName === lane.roomName && old.resource === lane.resource)) throw Error("lane_expansion_forbidden");
  const pricingConfig = resolveMarketSaleAutomationConfig({ ...Memory.cfg!.marketSaleAutomation, mode: "direct" });
  if (!pricingConfig.validForPlanning || pricingConfig.configRevision !== "market-base-resource-v3-r8" || !compactRecord(data.trustedFloors)) throw Error("pricing_migration_invalid");
  const receipts: CompactLiveReceipt[] = [];
  if (!Array.isArray(base.ledger.receipts)) throw Error("migration_receipts_invalid");
  for (const row of base.ledger.receipts) {
    if (row.status !== "confirmed" || row.transactionTime < Game.time - 30_000) continue;
    const receipt = { tick: row.transactionTime, transactionId: row.transactionId, roomName: row.sellerRoom,
      resource: row.resource, amount: row.actualAmount, transactionEnergy: row.actualTransactionEnergy, netCreditsMilli: row.actualNetCreditsMilli, imported: true as const };
    if (!validCompactReceipt(receipt)) throw Error("migration_receipts_invalid");
    receipts.push(receipt);
  }
  const state: CompactMarketLiveState = { v: 1, configuration: compactConfiguration(config), activation: copy(authorization), phase: "quiescing", quietTicks: [],
    lanes: copy(authorization.lanes), pricingConfig: copy(pricingConfig), trustedFloors: copy(data.trustedFloors), dynamicFloor: copy(base.dynamicFloorProjection),
    receipts, lastDealAt: Math.max(0, base.ledger.confirmedCooldownNotBefore - 1000), cooldownHighWater: base.ledger.checkpoint.confirmedCooldownNotBeforeHighWater,
    attempts: 0, confirmed: 0, confirmedAmount: 0, confirmedNetCreditsMilli: 0, confirmedEnergy: 0, arbiter: {}, audit: [] };
  if (!validCompactLiveState(state)) throw Error("migration_state_invalid");
  return state;
}

/** 只以引擎 outgoing transaction 确认；异常/未知返回永不重新提交同一 pending。 */
export function reconcileCompactMarketPending(state: CompactMarketLiveState): void {
  const pending = state.pending;
  if (!pending) return;
  if (pending.attemptAt > Game.time) { state.blocker = "pending_future_tick"; return; }
  if (pending.attemptAt === Game.time) return;
  const outgoing = Game.market.outgoingTransactions;
  if (!Array.isArray(outgoing)) { state.blocker = "reconcile_unavailable"; return; }
  const matches = outgoing.slice(0, 100).filter(row => row.order?.id === pending.orderId && row.time === pending.attemptAt && row.from === pending.roomName && row.to === pending.orderRoom && row.resourceType === pending.resource);
  if (matches.length === 0) {
    if (Game.time - pending.attemptAt > 10) state.blocker = "reconcile_gap";
    return;
  }
  const row = matches[0];
  if (matches.length !== 1 || !row.transactionId || !compactCount(row.amount) || row.amount < 1 || row.amount > pending.amount || row.order?.type !== ORDER_BUY || priceToMilliDown(row.order.price) < pending.grossPriceMilli || state.receipts.some(receipt => receipt.transactionId === row.transactionId)) {
    state.blocker = "reconcile_mismatch"; return;
  }
  const fee = Game.market.calcTransactionCost(row.amount, row.from, row.to);
  const worst = Game.market.calcTransactionCost(1, row.from, row.to);
  const quote = quoteNetDeal(row.order.price, row.amount, fee, worst, pending.energyPrice, pending.floorMilli / 1000, 0);
  if (!quote || fee > pending.transactionEnergy) { state.blocker = "reconcile_net_floor"; return; }
  const increments = [state.confirmed + 1, state.confirmedAmount + row.amount, state.confirmedNetCreditsMilli + quote.netCreditsMilli, state.confirmedEnergy + fee];
  if (!increments.every(compactCount) || state.receipts.length >= 1024) { state.blocker = "receipt_capacity"; return; }
  state.receipts.push({ tick: row.time, date: new Date(pending.atMs).toISOString().slice(0, 10), transactionId: row.transactionId, roomName: row.from, resource: pending.resource, amount: row.amount, transactionEnergy: fee, netCreditsMilli: quote.netCreditsMilli });
  [state.confirmed, state.confirmedAmount, state.confirmedNetCreditsMilli, state.confirmedEnergy] = increments;
  state.lastDealAt = Math.max(state.lastDealAt, pending.attemptAt);
  releasePreparedDirectMarketClaims(pending.requestId);
  delete state.pending;
  // 成交迟到可自动解开纯缺帧锁，其它损坏/身份问题保持锁定。
  if (state.blocker === "reconcile_gap" || state.blocker === "reconcile_unavailable") delete state.blocker;
  note(state, "confirmed");
}

export function runCompactMarketPreflight(): MarketSaleAutomationResult {
  enforceLegacyMarketSafetyLatch();
  const config = Memory.cfg?.market;
  let state = Memory.data?.market?.live;
  try {
    if (Game.shard.name !== "shard1" || Memory.runtime?.lastDeployBranch !== "default") return result(state, "execution_identity_invalid");
    if (state !== undefined && !validCompactLiveState(state)) return result(undefined, "live_state_invalid");
    if (state) {
      // 即使 mode=off、配置失配或旧入口被误开，也先对账、继续保留实物暴露。
      state.receipts = state.receipts.filter(row => row.tick >= Game.time - 30_000);
      reconcileCompactMarketPending(state);
    }
    const quietReason = compactLegacyQuietReason();
    if (quietReason) { if (state) note(state, quietReason); return result(state, quietReason); }
    if (!config || config.mode !== "live") return result(state, "compact_paused");
    if (!state) {
      state = initialize(config);
      if (!Memory.data) throw Error("data_root_missing");
      if (Memory.data.market?.v !== 1) throw Error("market_schema_invalid");
      Memory.data.market.live = state;
    }
    if (state.configuration !== compactConfiguration(config)) return result(state, "configuration_changed");
    if (state.blocker) return result(state, state.blocker);
    if (state.lastPreflightAt === Game.time) return result(state);
    state.lastPreflightAt = Game.time;
    if (state.phase === "quiescing") {
      if (state.quietTicks[state.quietTicks.length - 1] !== Game.time - 1) state.quietTicks = [];
      state.quietTicks.push(Game.time);
      if (state.quietTicks.length === 2) { state.phase = "active"; note(state, "activated_after_two_quiet_ticks"); }
    }
    return result(state);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "compact_preflight_failed";
    if (state) { state.blocker = reason; note(state, reason); }
    return result(state, reason);
  }
}

export function compactMarketReadiness(): MarketTerminalEnergyAuthorizationRead {
  const state = Memory.data?.market?.live;
  if (!validCompactLiveState(state) || state.phase !== "active" || state.blocker || Memory.cfg?.market?.mode !== "live" || state.configuration !== compactConfiguration(Memory.cfg.market) || compactLegacyQuietReason()) return { ok: false, reason: "invalid", rooms: [] };
  const lanes = state.lanes.filter(lane => compactLanePresent(lane) && !hasTreasuryTerminalFence(lane.roomName));
  return { ok: true, revision: `compact:${state.activation.archiveHash}`, maxTransactionEnergy: 1000,
    rooms: [...new Map(lanes.map(lane => [lane.roomName, { roomName: lane.roomName, roomInstanceId: `compact:${lane.controllerId}:${lane.terminalId}`, terminalId: lane.terminalId }])).values()],
    cargoLanes: lanes.map(lane => ({ ...lane, maxDealAmount: 1000 })) };
}

export interface CompactMarketLiveDependencies {
  collectProtection?: typeof collectLiveMarketSaleProtectionLedger;
  collectPricing?: typeof collectMarketSalePriceSnapshots;
}

/** 独立采集与执行：不消费 V3 staged input、planner、permit/WAL 或旧 runtime 投影。 */
export function runCompactMarketLive(dependencies: CompactMarketLiveDependencies = {}): MarketSaleAutomationResult {
  const preflight = runCompactMarketPreflight(), state = Memory.data?.market?.live;
  if (Object.keys(preflight.rejectedByReason).length || !validCompactLiveState(state) || state.phase !== "active" || state.pending) return preflight;
  if (Memory.runtime?.resourceControl?.updatedAt !== Game.time || state.lastPlanningAt !== undefined && Game.time - state.lastPlanningAt < 5) return preflight;
  const config = Memory.cfg!.market!;
  // 缺少同 tick 补给证据时不推进 planning 时钟，避免与 RC full cycle 永久错相。
  const authorization = compactMarketReadiness();
  if (!state.lanes.some(lane => compactLanePresent(lane) && readLiveMarketBaseTerminal(lane.roomName, lane.resource, authorization)?.ready)) return result(state, "terminal_not_ready");
  if (Game.cpu.bucket < (config.minBucket ?? 9000) || Game.cpu.limit - Game.cpu.getUsed() < 15) return result(state, "cpu_budget");
  const started = Game.cpu.getUsed();
  state.lastPlanningAt = Game.time;
  const collect = dependencies.collectProtection ?? collectLiveMarketSaleProtectionLedger;
  const pricingAdapter = dependencies.collectPricing ?? collectMarketSalePriceSnapshots;
  try {
    const lanes = state.lanes.filter(compactLanePresent);
    if (!lanes.length) return result(state, "no_live_lanes");
    const resources = [...new Set(lanes.map(lane => lane.resource))];
    const protectionOptions = () => ({ candidates: lanes.map(lane => ({ roomName: lane.roomName, resource: lane.resource })),
      laneReserveByEntry: Object.fromEntries(lanes.map(lane => [`${lane.roomName}:${lane.resource}`, resolveCompactMarketPolicy(lane.resource, config)!.reserve])) });
    const protection = collect(state.pricingConfig, undefined, protectionOptions());
    if (protection.globalBlocked || protection.observedAt !== Game.time || !protection.fresh) return result(state, "protection_incomplete");
    const rawBooks = new Map<MarketResource, Order[]>();
    for (const resource of resources) {
      const rows = Game.market.getAllOrders({ resourceType: resource });
      if (!Array.isArray(rows) || rows.length > 1000) throw Error("book_incomplete");
      rawBooks.set(resource, rows.map(row => ({ ...row })));
    }
    const readMarket: MarketSalePricingReadMarket = {
      orders: Game.market.orders,
      getHistory: resource => {
        if (!resource) throw Error("resource_required");
        let cached = historyCache.get(resource);
        if (!cached || cached.game !== Game || Game.time - cached.tick >= 5000 || cached.tick > Game.time) {
          const rows = Game.market.getHistory(resource);
          if (!Array.isArray(rows) || rows.length > 100) throw Error("history_incomplete");
          cached = { game: Game, tick: Game.time, rows: rows.map(row => ({ ...row })) }; historyCache.set(resource, cached);
        }
        return cached.rows.map(row => ({ ...row }));
      },
      getAllOrders: filter => typeof filter === "object" && filter?.resourceType ? rawBooks.get(filter.resourceType as MarketResource) ?? [] : [],
    };
    const pricing = pricingAdapter(state.pricingConfig, state, resources, { market: readMarket, gameTime: Game.time, nondecreasingTrustedFloors: true });
    if (!pricing.energyShadowEvidence?.trusted || !(pricing.energyShadowEvidence.effective! > 0)) throw Error("energy_shadow_incomplete");
    const energyPrice = pricing.energyShadowEvidence.effective!;
    const bestPrices = resources.flatMap(resource => {
      const rows = rawBooks.get(resource)!.filter(row => row.type === ORDER_BUY && !Game.market.orders[row.id] && row.amount >= 1000 && row.price > 0 && row.roomName);
      return rows.length ? [{ resource, price: Math.max(...rows.map(row => row.price)) }] : [];
    });
    state.dynamicFloor = buildMarketBaseDynamicFloorState({ previous: state.dynamicFloor, tick: Game.time, marketDate: pricing.asOfDate,
      bookBestPrices: bestPrices, laneSurplus: lanes.map(lane => ({ resource: lane.resource, sellable: protection.entries[`${lane.roomName}:${lane.resource}`]?.sellableAmount ?? 0, rollingMax: 5000 })),
      ratchetFloorByResource: Object.fromEntries(resources.map(resource => [resource, pricing.snapshots[resource]?.ratchetFloor])) });
    const dynamic = marketBaseEnforcedDynamicFloors(state.dynamicFloor);
    const plannedLanes: CompactMarketLane[] = [];
    const floors: Record<string, number> = {};
    const normalFloors: Record<string, number> = {};
    for (const lane of lanes) {
      const policy = resolveCompactMarketPolicy(lane.resource, config);
      const key = `${lane.roomName}:${lane.resource}`, entry = protection.entries[key], price = pricing.snapshots[lane.resource];
      if (!policy || policy.maxPerDeal > 1000 || policy.maxTransactionEnergy > 1000 || policy.windowTicks > 30_000 || !entry?.fresh || entry.blocked || !price?.historyResult?.trusted || !(price.historyFloor! > 0) || !(price.ratchetFloor! > 0)) throw Error("lane_incomplete");
      const normal = computeEffectiveNetFloor({ hardFloor: policy.hardNetFloor, economicFloor: policy.economicNetFloor, historyFloor: price.historyFloor, ratchetFloor: price.ratchetFloor, dynamicFloor: dynamic[lane.resource] });
      if (!normal.valid || !normal.floor) throw Error("floor_invalid");
      normalFloors[key] = normal.floor;
      const tier = liveBaseMineralOverflow(entry, Game.time).tier;
      if (tier === "liquidation") policy.minIntervalTicks = 0;
      else if (tier === "overflow") policy.minIntervalTicks = Math.min(100, policy.minIntervalTicks);
      const floor = baseMineralOverflowNetFloor(entry, Game.time, normal.floor, state.dynamicFloor);
      if (tier !== "normal") { policy.hardNetFloor = floor; policy.economicNetFloor = floor; policy.minNotional = Math.min(policy.minNotional, floor * 1000); }
      floors[key] = floor;
      const terminal = Game.rooms[lane.roomName].terminal!;
      const energyReadiness = readLiveMarketBaseTerminal(lane.roomName, lane.resource, compactMarketReadiness());
      const due = Game.time >= Math.max(state.cooldownHighWater, state.lastDealAt + (tier === "normal" ? 1000 : tier === "overflow" ? 100 : 0));
      const receipts = state.receipts.filter(row => row.roomName === lane.roomName && row.resource === lane.resource && row.tick > Game.time - policy.windowTicks);
      plannedLanes.push({ roomName: lane.roomName, resource: lane.resource, fresh: entry.observedAt === Game.time && entry.expiresAt >= Game.time,
        sellable: productionSellableAmount(entry, Game.time, policy.reserve), floor, minNotional: policy.minNotional, policy,
        lastDealTick: receipts.length ? Math.max(...receipts.map(row => row.tick)) : undefined, windowAmount: receipts.reduce((sum, row) => sum + row.amount, 0),
        terminal: { ready: due && energyReadiness?.ready === true, claimed: hasTerminalActionClaim(lane.roomName) || !!getMarketAccountClaim(), cooldown: terminal.cooldown,
          resourceAmount: terminal.store.getUsedCapacity(lane.resource), energy: terminal.store.getUsedCapacity(RESOURCE_ENERGY), reserve: Math.max(policy.terminalEnergyReserve, energyReadiness?.effectivePostDealEnergyReserve ?? policy.terminalEnergyReserve) } });
    }
    const planningStarted = Game.cpu.getUsed();
    const costs = new Map<string, number>();
    const plan: CompactMarketPlan = planCompactMarket({ tick: Game.time, energyPrice, lanes: plannedLanes, books: resources.map(resource => ({ resource, complete: true,
      orders: rawBooks.get(resource)!.filter(row => row.type === ORDER_BUY).map(row => ({ ...row, type: "buy" as const })), ownOrderIds: Object.keys(Game.market.orders) })), minDealAmount: 1000,
      transactionEnergy: (amount, from, to) => { const key = `${amount}:${from}:${to}`; if (!costs.has(key)) costs.set(key, Game.market.calcTransactionCost(amount, from, to)); return costs.get(key); },
      shouldStop: () => Game.cpu.getUsed() - planningStarted > (config.maxCpu ?? 3) || Game.cpu.getUsed() - started > 15 });
    const budgetExceeded = Game.cpu.getUsed() - planningStarted > (config.maxCpu ?? 3) || Game.cpu.getUsed() - started > 15;
    if (!plan.complete || budgetExceeded) { const reason = budgetExceeded ? "cpu_budget" : plan.reason ?? "plan_incomplete"; note(state, reason); return result(state, reason); }
    state.lastCompleteAt = Game.time; state.selected = plan.selected;
    recordBaseMineralOverflow(Object.values(protection.entries), Game.time, Object.fromEntries(plannedLanes.map(lane => [`${lane.roomName}:${lane.resource}`, plan.candidates.some(candidate => candidate.roomName === lane.roomName && candidate.resource === lane.resource) ? "bid" : lane.terminal.ready && !lane.terminal.claimed && lane.terminal.cooldown === 0 ? "no_bid" : "waiting"])), floors, true);
    if (!plan.selected) { note(state, "no_selection"); return preflight; }
    const selected = plan.selected;
    // 最后一读只重读被选单、Terminal 和生产承诺；不再推进 EMA 或可信地板。
    const order = Game.market.getOrderById(selected.orderId);
    const fresh = collect(state.pricingConfig, undefined, protectionOptions());
    const entry = fresh.entries[`${selected.roomName}:${selected.resource}`];
    const lane = plannedLanes.find(value => value.roomName === selected.roomName && value.resource === selected.resource)!;
    const pinned = lanes.find(value => value.roomName === selected.roomName && value.resource === selected.resource)!;
    const terminal = Game.rooms[selected.roomName]?.terminal;
    const energyReadiness = readLiveMarketBaseTerminal(selected.roomName, selected.resource, compactMarketReadiness());
    const fee = Game.market.calcTransactionCost(selected.amount, selected.roomName, selected.orderRoom);
    const worst = Game.market.calcTransactionCost(1, selected.roomName, selected.orderRoom);
    if (!order || order.type !== ORDER_BUY || order.resourceType !== selected.resource || order.roomName !== selected.orderRoom || Game.market.orders[order.id] ||
        order.amount < selected.amount || order.remainingAmount < selected.amount || priceToMilliDown(order.price) !== selected.grossPriceMilli ||
        fresh.globalBlocked || !fresh.fresh || !entry?.fresh || entry.blocked || entry.observedAt !== Game.time || entry.expiresAt < Game.time ||
        productionSellableAmount(entry, Game.time, lane.policy.reserve) < selected.amount || !compactLanePresent(pinned) || !terminal || terminal.cooldown !== 0 ||
        terminal.store.getUsedCapacity(selected.resource) < selected.amount || !energyReadiness?.ready || terminal.store.getUsedCapacity(RESOURCE_ENERGY) - Math.max(fee, worst) < Math.max(lane.terminal.reserve, energyReadiness.effectivePostDealEnergyReserve ?? lane.policy.terminalEnergyReserve) ||
        fee !== selected.transactionEnergy || fee > lane.policy.maxTransactionEnergy || worst > lane.policy.maxTransactionEnergy ||
        !quoteNetDeal(order.price, selected.amount, fee, worst, energyPrice, Math.max(selected.floorMilli / 1000, baseMineralOverflowNetFloor(entry, Game.time, normalFloors[`${selected.roomName}:${selected.resource}`], state.dynamicFloor)), lane.minNotional)) return result(state, "second_read_changed");
    if (state.receipts.length >= 1023 || Memory.cfg?.market?.mode !== "live" || state.configuration !== compactConfiguration(Memory.cfg!.market!) || compactLegacyQuietReason() || state.pending) return result(state, "execution_fence");
    if (Game.cpu.getUsed() - started > 15 || Game.cpu.limit - Game.cpu.getUsed() < 5) return result(state, "cpu_budget");
    enforceLegacyMarketSafetyLatch();
    const requestId = `compact:${Game.time}:${++state.attempts}`;
    const pending: CompactLivePending = { ...selected, requestId, attemptAt: Game.time, atMs: Date.now(), energyPrice, status: "prepared" };
    state.pending = pending;
    const claim = { requestId, roomName: selected.roomName, actor: ACTOR, attemptAt: Game.time };
    if (!claimPreparedDirectMarketClaims(claim)) { delete state.pending; note(state, "arbiter_busy"); return result(state, "arbiter_busy"); }
    try {
      const code = executePreparedDirectMarketDeal({ ...claim, orderId: selected.orderId, amount: selected.amount });
      if (isExplicitMarketNonOkReturnCode(code)) { delete state.pending; releasePreparedDirectMarketClaims(requestId); note(state, `deal_non_ok:${code}`); return result(state, "deal_non_ok"); }
      pending.status = code === OK ? "submitted" : "unknown";
      note(state, code === OK ? "submitted" : "deal_unknown");
      return result(state, undefined, 1);
    } catch { pending.status = "unknown"; note(state, "deal_threw"); return result(state, "deal_unknown", 1); }
  } catch (error) { const reason = error instanceof Error ? error.message : "compact_live_failed"; note(state, reason); return result(state, reason); }
  finally { const used = Game.cpu.getUsed() - started; if (Number.isFinite(used) && used >= 0) state.cpu = { last: used, max: Math.max(state.cpu?.max ?? 0, used) }; }
}
