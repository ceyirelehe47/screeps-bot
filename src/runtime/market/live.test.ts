import { runCompactMarketLive, runCompactMarketPreflight, compactMarketReadiness, type CompactMarketLiveDependencies } from "@/runtime/market/live";
import { compactConfiguration, compactMarketOwnsExecution, compactMarketExposure, validCompactLiveState, type CompactMarketLiveState } from "@/runtime/market/liveState";
import { MARKET_RESOURCES, resolveCompactMarketPolicy } from "@/runtime/market/policy";
import { resolveMarketSaleAutomationConfig } from "@/runtime/marketSaleConfig";
import { clearMarketActionArbiterForTest, declareMarketActionIntent, executeTerminalAction } from "@/runtime/marketActionArbiter";
import { getMarketSaleTerminalExposure, compileLiveMarketSaleTerminalExposureIndex } from "@/runtime/marketSaleExposure";
import { runMarketSalePreflight } from "@/runtime/marketSaleAutomation";
import { runLiveMarketSaleAutomation } from "@/runtime/marketSaleRuntime";
import { isPermitChainStorageReady } from "@/runtime/permitChainStorageGuard";
import { planAuthorizedMarketCargoTargets } from "@/runtime/resourceTerminalLogistics";
import { getResourceControlDonorAvailable } from "@/runtime/resourceControlReadModel";
import * as protectionAdapter from "@/runtime/marketSaleProtectionAdapter";

const commit = "a".repeat(40), roomName = "E1N57", resource = "L";
const pinned = { roomName, resource, terminalId: "terminal", controllerId: "controller" } as const;
const rawConfig = () => ({ mode: "off", directCapability: "continuous-v3", configRevision: "market-base-resource-v3-r8",
  sellResources: [...MARKET_RESOURCES], hardFloor: Object.fromEntries(MARKET_RESOURCES.map(r => [r, resolveCompactMarketPolicy(r)!.hardNetFloor])),
  economicFloor: Object.fromEntries(MARKET_RESOURCES.map(r => [r, resolveCompactMarketPolicy(r)!.economicNetFloor])),
  forecastBuffer: Object.fromEntries(MARKET_RESOURCES.map(r => [r, resolveCompactMarketPolicy(r)!.reserve])),
  minDealAmount: 1000, makerBatchAmount: 5000, creditReserve: 0, terminalEnergyReserve: 25000,
  maxDirectDealAmount: 1000, maxDirectDealsPerCycle: 1, minDirectOrderAmount: 1000, minDirectOrderNotional: 451000,
  maxDirectRawOrdersScannedPerCycle: 1000, maxDirectEligibleOrdersPricedPerCycle: 200, maxDirectTransactionEnergy: 1000,
  directCanaryMaxConfirmedDeals: 1, energyShadowHardFloor: 20, planningSnapshotMaxAgeTicks: 10,
  minHistoryDays: 7, minHistoryTransactions: 100, minHistoryVolume: 100000, historyFloorRatio: .95, historyMaxAgeDays: 2,
  canary: { enabled: true, allowExpansion: false } });
let state: CompactMarketLiveState, order: any, deps: CompactMarketLiveDependencies;
let stock: number;
function protection(): any {
  const tick = Game.time;
  return { currentTick: tick, revision: tick, observedAt: tick, expiresAt: tick, fresh: true, blockedEntryCount: 0,
    entries: { [`${roomName}:${resource}`]: { roomName, resource, revision: tick, observedAt: tick, expiresAt: tick,
      totalStock: stock, terminalStock: 50000, hardReserve: 10000, productionDemand: 0, forecastBuffer: 10000,
      localReserve: 10000, protectedOutgoing: 0, carrierOrInFlight: 0, protectedAmount: 10000, grossSurplus: stock-10000,
      managedExposure: 0, newExposureCapacity: stock-10000, sellableAmount: Math.min(50000,stock-10000),
      fresh: true, blocked: false, blockedReasons: [], issues: [], sourceContributions: [] } } };
}
function pricing(): any {
  return { observedAt: Game.time, asOfDate: new Date().toISOString().slice(0,10), energyShadowEvidence: { trusted: true, observedAt: Game.time, hardFloor: 20, effective: 20 },
    snapshots: { L: { resource, observedAt: Game.time, trusted: true, historyResult: { trusted: true }, historyFloor: 900, ratchetFloor: 900, effectiveNetFloor: 900 } } };
}
function ready(reserve = 25000): void {
  (Memory.runtime!.resourceControl as any).rooms = { [roomName]: { marketEnergyReadiness: {
    schemaVersion: 3, revision: `market-terminal-energy-v3:${Game.time}`, observedAt: Game.time, expiresAt: Game.time+1,
    authorizationRevision: `compact:${state.activation.archiveHash}`, roomInstanceId: `compact:${pinned.controllerId}:${pinned.terminalId}`,
    terminalId: pinned.terminalId, authorized: true, effectivePostDealEnergyReserve: reserve, marketTerminalEnergyTarget: reserve+1000,
    ordinaryTerminalEnergyTarget: reserve, unresolvedEnergySendAmount: 0, unresolvedInternalSendFees: 0,
    terminalScopedProductionEnergyCommitments: 0, maxTransactionEnergy: 1000, contributionCount: 1,
    contributions: [{ id: "ordinary", amount: reserve, kind: "ordinary_terminal_target" }], desiredTerminalEnergy: Math.max(100000,reserve+1000), plannedFeedAmount: 0, status: "ready",
  } } };
}
function next(ticks = 1): void { Game.time += ticks; Memory.runtime!.resourceControl!.updatedAt = Game.time; ready(); }
function transaction(amount = 1000): any {
  return { transactionId: "tx", time: state.pending!.attemptAt, from: roomName, to: order.roomName, resourceType: resource, amount,
    order: { id: order.id, type: ORDER_BUY, price: order.price } };
}
beforeEach(() => {
  Game.time = 10000; (Game as any).shard = { name: "shard1" };
  stock = 30000;
  Memory.cfg = { market: { mode: "live", overrides: { L: { maxPerDeal: 1000 } }, minBucket: 9000, maxCpu: 3, cutover: { sourceCommit: commit, archiveHash: "b".repeat(64), authorization: "用户明确批准切换", lanes: [pinned] } }, marketSaleAutomation: rawConfig() as any };
  Memory.runtime = { lastDeployCommit: commit, lastDeployBranch: "default", resourceControl: { updatedAt: Game.time } } as any;
  Memory.data = { market: { v: 1 }, marketSaleAutomation: { managedOrders: {}, pendingMutations: {}, pendingDirectDeals: {}, marketStaging: {}, marketReservations: {}, trustedFloors: {},
    directAutomation: { ledger: {}, pendingDirectDeals: {}, quarantinedPendingDirectDeals: {}, baseResourceV3: { scope: { laneLifecycles: [{ sellerRoomName: roomName, resource, stage: "continuous", status: "writable" }] }, ledger: { confirmedCooldownNotBefore: 9000, checkpoint: { confirmedCooldownNotBeforeHighWater: 8000 }, receipts: [] }, dynamicFloorProjection: { modelRevision: "direct-net-v2", schemaVersion: 1, updatedAt: Game.time, entries: [] } } } } } as any;
  state = { v: 1, configuration: compactConfiguration(Memory.cfg.market!), activation: Memory.cfg.market!.cutover!, phase: "active", quietTicks: [9998,9999], lanes: [pinned],
    pricingConfig: resolveMarketSaleAutomationConfig({ ...rawConfig(), mode: "direct" }), trustedFloors: {},
    receipts: [], lastDealAt: 0, cooldownHighWater: 0, attempts: 0, confirmed: 0, confirmedAmount: 0, confirmedNetCreditsMilli: 0, confirmedEnergy: 0, arbiter: {}, audit: [] };
  Memory.data!.market!.live = state;
  Game.rooms = { [roomName]: { name: roomName, controller: { my: true, id: pinned.controllerId }, terminal: { id: pinned.terminalId, my: true, isActive: () => true, cooldown: 0,
    store: { getUsedCapacity: (r: string) => r === RESOURCE_ENERGY ? 100000 : 50000 } }, storage: { store: { getFreeCapacity: () => 200000 } } } } as any;
  order = { id: "bid", type: ORDER_BUY, resourceType: resource, roomName: "W1N1", price: 1000, amount: 10000, remainingAmount: 10000 };
  (Game as any).market = { orders: {}, outgoingTransactions: [], credits: 1000000, getAllOrders: jest.fn(() => [order]), getOrderById: jest.fn(() => order), calcTransactionCost: jest.fn((amount: number) => amount === 1 ? 1 : 100), deal: jest.fn(() => OK) };
  (Game as any).cpu = { bucket: 10000, limit: 120, getUsed: () => 10 };
  deps = { collectProtection: jest.fn(protection), collectPricing: jest.fn(pricing) };
  ready();
  clearMarketActionArbiterForTest();
});

describe("精简市场正式执行与交接", () => {
  it("配置未初始化或绑定过期不接管库存账本，初始化失败留可见原因", () => {
    delete Memory.data!.market!.live;
    Memory.cfg!.market!.mode = "off";
    expect(compactMarketOwnsExecution()).toBe(false);
    expect(compactMarketExposure("E9N9", RESOURCE_ENERGY)).toEqual({ reservedAmount: 0, blocked: false });
    Memory.cfg!.market!.mode = "live";
    Memory.cfg!.market!.cutover!.sourceCommit = "c".repeat(40);
    expect(runMarketSalePreflight().rejectedByReason).toEqual({ activation_invalid: 1 });
    expect(Memory.data!.market!.initialization).toEqual({ tick: Game.time, reason: "activation_invalid" });
    expect(compactMarketOwnsExecution()).toBe(false);
    expect(Game.market.deal).not.toHaveBeenCalled();
  });
  it("损坏市场根只隔离已知lane，普通终端动作不被许可链总闸卡住", () => {
    (state as any).receipts = {};
    expect(isPermitChainStorageReady()).toBe(true);
    expect(compactMarketExposure(roomName, resource).blocked).toBe(true);
    expect(compactMarketExposure("E9N9", RESOURCE_POWER).blocked).toBe(false);
    const action = jest.fn(() => OK);
    expect(executeTerminalAction("E9N9", "resourceControl", "terminal_send", action)).toBe(OK);
    expect(action).toHaveBeenCalledTimes(1);
    runCompactMarketLive(deps); expect(Game.market.deal).not.toHaveBeenCalled();
  });
  it.each(["reconcile_mismatch", "receipt_capacity", "deal_threw"])("%s只停止市场新单并保护本房在途", blocker => {
    runCompactMarketLive(deps); state.blocker = blocker;
    expect(compactMarketExposure(roomName, resource)).toEqual({ reservedAmount: 1000, blocked: false });
    expect(compactMarketExposure(roomName, RESOURCE_ENERGY)).toEqual({ reservedAmount: 100, blocked: false });
    expect(compactMarketExposure(roomName, RESOURCE_POWER)).toEqual({ reservedAmount: 0, blocked: false });
    expect(compactMarketExposure("E9N9", resource)).toEqual({ reservedAmount: 0, blocked: false });
    const snapshot = { roomName: "E9N9", storageResourceAmounts: { power: 5000 }, terminalResourceAmounts: { power: 0 }, mineralFloor: {}, terminalEnergy: 30000, terminalEnergyReserve: 25000 } as any;
    expect(getResourceControlDonorAvailable(snapshot, RESOURCE_POWER, false)).toBe(5000);
    next(100); runCompactMarketLive(deps);
    expect(state.pending).toBeDefined(); expect(state.blocker).toBe(blocker);
    expect(Game.market.deal).toHaveBeenCalledTimes(1);
  });
  it("缺收据100tick且历史完整、终端实物不变时释放未执行占用，下tick重新读单", () => {
    runCompactMarketLive(deps); next(100); runCompactMarketLive(deps);
    expect(state.pending).toBeUndefined(); expect(state.blocker).toBeUndefined();
    expect(state.lastReason).toBe("not_executed:history_and_stock_unchanged");
    expect(state.arbiter).not.toHaveProperty("directMarketClaim");
    expect(Game.market.deal).toHaveBeenCalledTimes(1); expect(state.confirmed).toBe(0);
    next(5); runCompactMarketLive(deps); expect(Game.market.deal).toHaveBeenCalledTimes(2);
  });
  it.each(["unknown", "stock", "energy", "identity", "history", "legacy"])("缺收据但%s证据不足保持pending", kind => {
    runCompactMarketLive(deps);
    if (kind === "unknown") state.pending!.status = "unknown";
    if (kind === "legacy") delete state.pending!.terminalBefore;
    const terminal = Game.rooms[roomName].terminal!;
    if (kind === "stock" || kind === "energy") (terminal.store.getUsedCapacity as any) = (r: string) => r === RESOURCE_ENERGY ? (kind === "energy" ? 99900 : 100000) : 49000;
    if (kind === "identity") (terminal as any).id = "replacement";
    if (kind === "history") Game.market.outgoingTransactions = Array.from({ length: 100 }, (_, i) => ({ ...transaction(), transactionId: `other${i}`, time: Game.time + 1, order: { id: "other" } })) as any;
    next(101); runCompactMarketLive(deps);
    expect(state.pending).toBeDefined(); expect(state.blocker).toBe("reconcile_gap");
    expect(Game.market.deal).toHaveBeenCalledTimes(1);
  });
  it("成交记录在第100条以后仍能确认", () => {
    runCompactMarketLive(deps); Game.market.outgoingTransactions = [...Array.from({ length: 101 }, (_, i) => ({ ...transaction(), transactionId: `other${i}`, order: { id: "other" } })), transaction()];
    next(); runCompactMarketPreflight(); expect(state.confirmed).toBe(1); expect(state.pending).toBeUndefined();
  });
  it("无当tick搬运目标仍保护各lane已入终端的一批货，暂停后释放非在途", () => {
    expect(compactMarketExposure(roomName, resource).reservedAmount).toBe(1000);
    runCompactMarketLive(deps);
    const other = { ...pinned, roomName: "E2N57", terminalId: "terminal2", controllerId: "controller2" };
    state.lanes.push(other);
    Memory.cfg!.market!.cutover = { ...state.activation, lanes: [...state.lanes] };
    state.activation = Memory.cfg!.market!.cutover!; state.configuration = compactConfiguration(Memory.cfg!.market!);
    Game.rooms.E2N57 = { ...Game.rooms[roomName], name: "E2N57", controller: { my: true, id: other.controllerId }, terminal: { ...Game.rooms[roomName].terminal, id: other.terminalId } } as any;
    expect(compactMarketExposure("E2N57", resource).reservedAmount).toBe(1000);
    Memory.cfg!.market!.mode = "off";
    expect(compactMarketExposure("E2N57", resource).reservedAmount).toBe(0);
  });
  it.each([400, 10000])("普通档允许变额%s，终端冷却结束即可再成交", amount => {
    delete Memory.cfg!.market!.overrides; state.configuration = compactConfiguration(Memory.cfg!.market!);
    order.amount = order.remainingAmount = amount;
    runCompactMarketLive(deps); expect(state.pending?.amount).toBe(amount);
    Game.market.outgoingTransactions = [transaction(amount)]; next(10); runCompactMarketLive(deps);
    expect(Game.market.deal).toHaveBeenCalledTimes(2);
  });
  it("变额大单自动缩到1000费用预算内，不因整笔费用过高丢掉可成交部分", () => {
    delete Memory.cfg!.market!.overrides; state.configuration = compactConfiguration(Memory.cfg!.market!);
    (Game.market.calcTransactionCost as jest.Mock).mockImplementation((amount: number) => Math.ceil(amount * .5));
    runCompactMarketLive(deps); expect(state.pending).toMatchObject({ amount: 2000, transactionEnergy: 1000 });
  });

  it("dryRun没有获得执行所有权", () => {
    delete Memory.data!.market!.live; Memory.cfg!.market = { mode: "dryRun" };
    expect(compactMarketOwnsExecution()).toBe(false); expect(Game.market.deal).not.toHaveBeenCalled();
  });
  it("归档绑定、原可写lane与连续两tick静默后才激活，不重置旧冷却", () => {
    delete Memory.data!.market!.live;
    expect(runCompactMarketPreflight().writes).toBe(0);
    const live = Memory.data!.market!.live!;
    expect(live.phase).toBe("quiescing"); expect(live.lastDealAt).toBe(8000);
    runCompactMarketPreflight(); expect(live.quietTicks).toEqual([10000]);
    next(); runCompactMarketPreflight(); expect(live.phase).toBe("active"); expect(live.quietTicks).toEqual([10000,10001]);
    expect(live.cooldownHighWater).toBe(8000); expect(Game.market.deal).not.toHaveBeenCalled();
  });
  it.each(["pending", "orders", "legacyMode", "newLane", "wrongCommit"])("交接前 %s 阻止接管", kind => {
    delete Memory.data!.market!.live;
    if (kind === "pending") (Memory.data!.marketSaleAutomation!.directAutomation as any).baseResourceV3.ledger.pending = {};
    if (kind === "orders") Game.market.orders.self = { type: ORDER_SELL } as any;
    if (kind === "legacyMode") Memory.cfg!.marketSaleAutomation!.mode = "direct";
    if (kind === "newLane") (Memory.data!.marketSaleAutomation!.directAutomation as any).baseResourceV3.scope.laneLifecycles = [];
    if (kind === "wrongCommit") Memory.cfg!.market!.cutover!.sourceCommit = "c".repeat(40);
    expect(Object.keys(runCompactMarketPreflight().rejectedByReason)).not.toHaveLength(0);
    expect(Memory.data!.market!.live).toBeUndefined(); expect(Game.market.deal).not.toHaveBeenCalled();
  });
  it("非空执行经WAL/仲裁，只确认引擎记录，旧根保持不变", () => {
    const before = JSON.stringify(Memory.data!.marketSaleAutomation);
    expect(runCompactMarketLive(deps).writes).toBe(1); expect(state.pending?.status).toBe("submitted");
    expect(state.confirmed).toBe(0); expect(getMarketSaleTerminalExposure(roomName, resource)).toEqual({ reservedAmount: 1000, blocked: false });
    expect(getMarketSaleTerminalExposure(roomName, RESOURCE_ENERGY).reservedAmount).toBe(100);
    runCompactMarketLive(deps); expect(Game.market.deal).toHaveBeenCalledTimes(1);
    Game.market.outgoingTransactions = [transaction()]; next(); runCompactMarketPreflight();
    expect(state.pending).toBeUndefined(); expect(state.confirmed).toBe(1); expect(state.confirmedAmount).toBe(1000); expect(state.confirmedEnergy).toBe(100);
    runCompactMarketPreflight(); expect(state.confirmed).toBe(1);
    expect(compileLiveMarketSaleTerminalExposureIndex().get(roomName, resource).reservedAmount).toBe(1000);
    expect(JSON.stringify(Memory.data!.marketSaleAutomation)).toBe(before);
  });
  it("部分成交按实际数量、能量和净额入账", () => {
    runCompactMarketLive(deps); Game.market.outgoingTransactions = [transaction(500)]; next(); runCompactMarketPreflight();
    expect(state.confirmedAmount).toBe(500); expect(state.confirmedNetCreditsMilli).toBe(498000000);
  });
  it.each(["throw", "unknown"])("%s保留pending且不重复提交；成交证据到达后确认", kind => {
    (Game.market.deal as jest.Mock).mockImplementation(() => { if (kind === "throw") throw Error("interrupt"); return undefined; });
    runCompactMarketLive(deps); expect(state.pending?.status).toBe("unknown");
    Game.market.outgoingTransactions = [transaction()]; next(); runCompactMarketLive(deps);
    expect(state.confirmed).toBe(1); expect(Game.market.deal).toHaveBeenCalledTimes(1);
  });
  it("无成交证据即使过期也保持占用，不能重试", () => {
    runCompactMarketLive(deps); next(11); runCompactMarketLive(deps);
    expect(state.blocker).toBe("reconcile_gap"); expect(state.pending).toBeDefined(); expect(Game.market.deal).toHaveBeenCalledTimes(1);
    expect(getMarketSaleTerminalExposure(roomName, resource)).toEqual({ reservedAmount: 1000, blocked: false });
    expect(getMarketSaleTerminalExposure("E9N9", RESOURCE_ENERGY)).toEqual({ reservedAmount: 0, blocked: false });
  });
  it("明确非OK释放pending但不虚构确认", () => {
    (Game.market.deal as jest.Mock).mockReturnValue(ERR_FULL);
    runCompactMarketLive(deps); expect(state.pending).toBeUndefined(); expect(state.confirmed).toBe(0);
  });
  it.each(["price", "resource", "room", "amount", "owner", "terminal", "off"])("第二读 %s 改变时不交易", kind => {
    (Game.market.getOrderById as jest.Mock).mockImplementation(() => {
      if (kind === "price") order.price = 1;
      if (kind === "resource") order.resourceType = "X";
      if (kind === "room") order.roomName = "W2N2";
      if (kind === "amount") order.amount = 1;
      if (kind === "owner") Game.market.orders.bid = order;
      if (kind === "terminal") (Game.rooms[roomName].terminal as any).id = "replacement";
      if (kind === "off") Memory.cfg!.market!.mode = "off";
      return order;
    });
    runCompactMarketLive(deps); expect(Game.market.deal).not.toHaveBeenCalled(); expect(state.pending).toBeUndefined();
  });
  it("最后一读新增生产承诺不能穿透保护量", () => {
    (deps.collectProtection as jest.Mock).mockImplementationOnce(protection).mockImplementationOnce(() => { const p = protection(); Object.assign(p.entries[`${roomName}:${resource}`], { productionDemand: stock, protectedAmount: stock, grossSurplus: 0, newExposureCapacity: 0, sellableAmount: 0 }); return p; });
    runCompactMarketLive(deps); expect(Game.market.deal).not.toHaveBeenCalled();
  });
  it.each(["bucket", "cooldown", "window", "claim", "identity", "corrupt", "config"])("%s安全边界阻止写入", kind => {
    if (kind === "bucket") (Game.cpu as any).bucket = 100;
    if (kind === "cooldown") { Memory.cfg!.market!.overrides = { L: { minIntervalTicks: 1000 } }; state.configuration = compactConfiguration(Memory.cfg!.market!); state.lastDealAt = Game.time - 100; }
    if (kind === "window") { Memory.cfg!.market!.overrides = { L: { maxPerWindow: 1000 } }; state.configuration = compactConfiguration(Memory.cfg!.market!); state.receipts = [{ tick: Game.time-2000, roomName, resource, transactionId: "old", amount: 1000, transactionEnergy: 100, netCreditsMilli: 1 }]; }
    if (kind === "claim") declareMarketActionIntent("other", "market_deal", roomName);
    if (kind === "identity") (Game as any).shard.name = "shard2";
    if (kind === "corrupt") (state as any).receipts = {};
    if (kind === "config") Memory.cfg!.market!.overrides = { L: { reserve: 20000 } };
    runCompactMarketLive(deps); expect(Game.market.deal).not.toHaveBeenCalled();
  });
  it("停止模式仍对账，同时所有旧入口保持静默", () => {
    runCompactMarketLive(deps); Game.market.outgoingTransactions = [transaction()]; Memory.cfg!.market!.mode = "off"; next();
    const before = JSON.stringify(Memory.data!.marketSaleAutomation), legacy = jest.fn();
    runMarketSalePreflight(); runLiveMarketSaleAutomation({ runAutomation: legacy });
    expect(state.confirmed).toBe(1); expect(legacy).not.toHaveBeenCalled(); expect(JSON.stringify(Memory.data!.marketSaleAutomation)).toBe(before);
  });
  it("原许可segment不可用时，新Exposure与物流授权使用精简根", () => {
    Memory.data!.permitChainSegments = { mode: "segments" } as any;
    (Memory.data!.marketSaleAutomation!.directAutomation as any).baseResourceV3.permitChain = { kind: "permit-chain-segments-v1" };
    expect(isPermitChainStorageReady()).toBe(true); expect(validCompactLiveState(state)).toBe(true);
    expect(compactMarketReadiness()).toMatchObject({ ok: true, cargoLanes: [{ roomName, resource, terminalId: "terminal", maxDealAmount: 1000 }] });
    Memory.cfg!.market!.mode = "off"; expect(compactMarketReadiness().ok).toBe(false);
  });
  it("独立采集真实history/book定价，不读取V3 staged事实", () => {
    const history = (r: string) => Array.from({ length: 13 }, (_, index) => { const date = new Date(); date.setUTCDate(date.getUTCDate()-index-1); return { resourceType: r, date: date.toISOString().slice(0,10), transactions: 1000, volume: 1000000, avgPrice: r === RESOURCE_ENERGY ? 20 : 900, stddevPrice: 1 }; });
    (Game.market as any).getHistory = jest.fn(history);
    expect(runCompactMarketLive({ collectProtection: deps.collectProtection }).writes).toBe(1);
    expect(Game.market.getHistory).toHaveBeenCalled(); expect(Game.market.getAllOrders).toHaveBeenCalledWith({ resourceType: resource });
  });
  it("历史缓存跨UTC日期立即刷新，不等待5000tick", () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date("2030-01-01T23:59:50Z"));
      (Game.market as any).getHistory = jest.fn((r: string) => Array.from({ length: 13 }, (_, i) => { const date = new Date(); date.setUTCDate(date.getUTCDate() - i - 1); return { resourceType: r, date: date.toISOString().slice(0,10), transactions: 1000, volume: 1000000, avgPrice: r === RESOURCE_ENERGY ? 20 : 900, stddevPrice: 1 }; }));
      order.price = 1;
      runCompactMarketLive({ collectProtection: deps.collectProtection });
      const calls = (Game.market.getHistory as jest.Mock).mock.calls.length;
      expect(calls).toBeGreaterThan(0);
      next(5); runCompactMarketLive({ collectProtection: deps.collectProtection });
      expect(Game.market.getHistory).toHaveBeenCalledTimes(calls);
      jest.setSystemTime(new Date("2030-01-02T00:00:01Z"));
      next(5); runCompactMarketLive({ collectProtection: deps.collectProtection });
      expect((Game.market.getHistory as jest.Mock).mock.calls.length).toBeGreaterThan(calls);
    } finally { jest.useRealTimers(); }
  });
  it("多个匹配交易导致隔离，不能释放实物或重复成交", () => {
    runCompactMarketLive(deps);
    Game.market.outgoingTransactions = [transaction(), { ...transaction(), transactionId: "tx2" }];
    next(); runCompactMarketPreflight();
    expect(state.blocker).toBe("reconcile_mismatch"); expect(state.pending).toBeDefined(); expect(state.confirmed).toBe(0);
  });
  it("保持未接管lane的停采闩，并在清仓连续无买单时暂停采矿", () => {
    const old = { complete: true, paused: "no_bid", observedAt: Game.time, overflowThreshold: 40000 };
    (Memory.runtime as any).baseMineralOverflow = { updatedAt: Game.time, entries: { "E1N57:X": old } };
    stock = 200000; order.price = 1;
    for (let i = 0; i < 5; i++) { runCompactMarketLive(deps); next(5); }
    const entries = (Memory.runtime as any).baseMineralOverflow.entries;
    expect(entries["E1N57:X"]).toEqual(old);
    expect(entries["E1N57:L"]).toMatchObject({ paused: "no_bid", noBidRounds: 5 });
    expect(Game.market.deal).not.toHaveBeenCalled();
  });
  it("第二读从清仓回到普通区时重新应用较高地板", () => {
    stock = 200000; order.price = 500;
    state.dynamicFloor = { schemaVersion: 1, modelRevision: "direct-net-v2", updatedAt: Game.time-1, entries: [{ resource: "L", bookEma: 1000, bookObservedAt: Game.time-1, lastObservedPrice: 1000, dynamicFloor: 1000, inventoryFactor: 1, surplusRatio: 4, dailyAnchor: 1000, anchorDate: new Date().toISOString().slice(0,10) }] };
    (deps.collectProtection as jest.Mock).mockImplementationOnce(protection).mockImplementationOnce(() => { stock = 30000; return protection(); });
    runCompactMarketLive(deps); expect(Game.market.deal).not.toHaveBeenCalled();
  });
  it("执行期预算耗尽时丢弃不完整计划", () => {
    let used = 10; (Game.cpu as any).getUsed = () => used;
    (Game.market.calcTransactionCost as jest.Mock).mockImplementation((amount: number) => { used += 4; return amount === 1 ? 1 : 100; });
    runCompactMarketLive(deps); expect(Game.market.deal).not.toHaveBeenCalled(); expect(state.lastCompleteAt).toBeUndefined();
  });
  it("旧mode为off后，真实补货规划读取精简所有权且拒绝未授权lane", () => {
    const spy = jest.spyOn(protectionAdapter, "collectLiveMarketSaleProtectionLedger").mockImplementation(protection);
    try {
      const snapshots = [{ roomName, terminal: Game.rooms[roomName].terminal, storage: Game.rooms[roomName].storage,
        storageResourceAmounts: { L: 20000 }, terminalResourceAmounts: { L: 0 } }] as any;
      const auth = compactMarketReadiness();
      expect(planAuthorizedMarketCargoTargets(snapshots, auth).get(roomName)).toEqual({ resource, targetStock: 1000 });
      expect(planAuthorizedMarketCargoTargets(snapshots, { ...auth, cargoLanes: [{ roomName, resource: "X", terminalId: "terminal", maxDealAmount: 1000 }] }).size).toBe(0);
      runCompactMarketLive(deps); expect(planAuthorizedMarketCargoTargets(snapshots, auth).size).toBe(0);
    } finally { spy.mockRestore(); }
  });
  it("变额补货沿用实际live上限且余量不足一整批仍可备货", () => {
    delete Memory.cfg!.market!.overrides; state.configuration = compactConfiguration(Memory.cfg!.market!);
    stock = 15000;
    const spy = jest.spyOn(protectionAdapter, "collectLiveMarketSaleProtectionLedger").mockImplementation(protection);
    try {
      const snapshots = [{ roomName, terminal: Game.rooms[roomName].terminal, storage: Game.rooms[roomName].storage,
        storageResourceAmounts: { L: 15000 }, terminalResourceAmounts: { L: 0 } }] as any;
      expect(compactMarketReadiness().cargoLanes?.[0].maxDealAmount).toBe(10000);
      expect(planAuthorizedMarketCargoTargets(snapshots, compactMarketReadiness()).get(roomName)).toEqual({ resource, targetStock: 5000 });
    } finally { spy.mockRestore(); }
  });
  it.each(["reserve", "stale", "tampered", "missing"])("能量readiness %s时不交易", kind => {
    if (kind === "reserve") ready(100000);
    const r = (Memory.runtime!.resourceControl as any).rooms[roomName];
    if (kind === "stale") r.marketEnergyReadiness.observedAt--;
    if (kind === "tampered") r.marketEnergyReadiness.effectivePostDealEnergyReserve--;
    if (kind === "missing") delete r.marketEnergyReadiness;
    runCompactMarketLive(deps); expect(Game.market.deal).not.toHaveBeenCalled();
  });
  it("补给证据恢复时立即规划，不因5tick时钟与RC错相", () => {
    delete (Memory.runtime!.resourceControl as any).rooms[roomName].marketEnergyReadiness;
    runCompactMarketLive(deps); expect(state.lastPlanningAt).toBeUndefined();
    next(); expect(runCompactMarketLive(deps).writes).toBe(1);
  });
});
