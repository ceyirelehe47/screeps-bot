import { applyMarketOps, type ResourceControlMarketConfig } from "@/runtime/resourceMarketOperations";
import type { ResourceControlSnapshot, ResourceControlTransferContext } from "@/runtime/resourceControlReadModel";
import { clearMarketActionArbiterForTest } from "@/runtime/marketActionArbiter";
import { createMockStore } from "@mock/powerBank";

function setup() {
  Game.time += 1; clearMarketActionArbiterForTest(); Game.rooms = {};
  Memory.cfg = { resourceControl: { synthesis: { rooms: { W1N1: { demands: { H: 1000, O: 1000 } }, W2N2: { demands: { H: 1000 } } } } } };
  Memory.runtime = {}; Memory.data = {};
  const market = { credits: 1_000_000, getAllOrders: jest.fn(({ resourceType }) => [
    { id: `sell-${resourceType}`, type: ORDER_SELL, resourceType, price: 0.1, amount: 1000, remainingAmount: 1000, roomName: "W9N9" }]),
    calcTransactionCost: jest.fn(() => 0), deal: jest.fn(() => OK) };
  Object.assign(Game, { market });
  const config: ResourceControlMarketConfig = { enabled: false, emergencyBuyEnabled: true,
    nativeMineralAutoSellThreshold: 10000, minDealAmount: 100, maxDealAmount: 1000, maxDealsPerRun: 5,
    maxDealEnergyCostRatio: 1, minSellPrice: {}, maxBuyPrice: { energy: 0.2, H: 1, O: 1 }, buyResources: [RESOURCE_HYDROGEN, RESOURCE_OXYGEN], sellResources: [],
    creditReserve: 100_000, energyShadowPrice: 0.5 };
  const incoming = new Map<string, number>();
  const context = { healthyIncomingByRoomResource: incoming, taskById: new Map(), healthyOutgoingByRoomResource: new Map(),
    reservedProductionByRoomResource: new Map(), carrierProductionByRoomResource: new Map() } as ResourceControlTransferContext;
  function snapshot(name = "W1N1", resources: Record<string, number> = { energy: 20000 }): ResourceControlSnapshot {
    const room = { name, controller: { my: true }, storage: { store: createMockStore({ energy: 20000 }) },
      terminal: { id: `${name}-terminal`, cooldown: 0, store: createMockStore(resources, 300000) }, find: () => [] } as unknown as Room;
    room.terminal!.room = room; Game.rooms[name] = room;
    return { roomName: name, storage: room.storage, terminal: room.terminal, mineralFloor: {}, state: "balanced", storageEnergy: 20000,
      terminalEnergy: resources.energy ?? 0, energyTarget: 40000, terminalEnergyReserve: 10000, terminalFreeCapacity: 250000 } as ResourceControlSnapshot;
  }
  return { market, config, context, incoming, snapshot };
}

it("应急能量缺口扣终端现货和在途调拨", () => {
  const w = setup(); const s = w.snapshot(); s.state = "survival";
  w.config.buyResources = []; applyMarketOps([s], w.config, new Set(), w.context);
  expect(w.market.deal).not.toHaveBeenCalled();
  s.terminalEnergy = 19000; w.incoming.set("W1N1:energy", 1000);
  applyMarketOps([s], w.config, new Set(), w.context); expect(w.market.deal).not.toHaveBeenCalled();
});
it("未配置时低于十万 credit 仍可应急购买，显式底线继续生效", () => {
  const w = setup(); const s = w.snapshot(); s.state = "survival"; s.energyTarget = 50000;
  w.config.buyResources = []; delete w.config.creditReserve;
  w.market.credits = 10_050;
  applyMarketOps([s], w.config, new Set(), w.context);
  expect(w.market.deal).not.toHaveBeenCalled();
  Game.time++; clearMarketActionArbiterForTest();
  w.market.credits = 50_000;
  w.config.creditReserve = 50_000;
  applyMarketOps([s], w.config, new Set(), w.context);
  expect(w.market.deal).not.toHaveBeenCalled();
  delete w.config.creditReserve;
  applyMarketOps([s], w.config, new Set(), w.context);
  expect(w.market.deal).toHaveBeenCalledTimes(1);
});
it("有效能量价格按净收到能量计算，矿物按费用估值计算", () => {
  const w = setup(); const s = w.snapshot(); s.state = "survival"; s.energyTarget = 50000;
  w.config.buyResources = []; w.market.calcTransactionCost.mockReturnValue(400);
  w.market.getAllOrders.mockReturnValue([{ id: "energy", type: ORDER_SELL, resourceType: RESOURCE_ENERGY,
    price: 0.15, amount: 1000, remainingAmount: 1000, roomName: "W9N9" }]);
  applyMarketOps([s], w.config, new Set(), w.context); expect(w.market.deal).not.toHaveBeenCalled();
  s.state = "balanced"; w.config.buyResources = [RESOURCE_HYDROGEN];
  w.market.getAllOrders.mockReturnValue([{ id: "mineral", type: ORDER_SELL, resourceType: RESOURCE_HYDROGEN,
    price: 0.99, amount: 1000, remainingAmount: 1000, roomName: "W9N9" }]);
  applyMarketOps([s], w.config, new Set(), w.context); expect(w.market.deal).not.toHaveBeenCalled();
});
it("购买保留 credit 和终端能量底线，矿物成交后本房立即停止", () => {
  const w = setup(); const s = w.snapshot(); w.market.credits = 100050;
  applyMarketOps([s], w.config, new Set(), w.context); expect(w.market.deal).not.toHaveBeenCalled();
  Game.time++; clearMarketActionArbiterForTest();
  w.market.credits = 100150; s.terminalEnergy = 10000; w.market.calcTransactionCost.mockReturnValue(1);
  applyMarketOps([s], w.config, new Set(), w.context); expect(w.market.deal).not.toHaveBeenCalled();
  w.market.calcTransactionCost.mockReturnValue(0); const other = w.snapshot("W2N2");
  applyMarketOps([s, other], w.config, new Set(), w.context);
  expect(w.market.deal).toHaveBeenCalledTimes(1);
});
it("旧合成 missing 不得重复覆盖已到货和 donor 在途", () => {
  const w = setup(); const s = w.snapshot("W1N1", { energy: 20000, H: 200 });
  w.config.buyResources = [RESOURCE_HYDROGEN];
  Memory.runtime = { synthesisControl: { rooms: { W1N1: { stage: "loading", activeProduct: RESOURCE_HYDROXIDE,
    targetAmount: 500, batchSize: 500, missing: { H: 500 } } } } } as any;
  w.incoming.set("W1N1:H", 300);
  applyMarketOps([s], w.config, new Set(), w.context); expect(w.market.deal).not.toHaveBeenCalled();
  // send(OK) 后 incoming 已扣减，原生 Store 要等下一 tick 才到货。
  w.incoming.clear(); s.terminalResourceAmounts = { H: 500 };
  applyMarketOps([s], w.config, new Set(), w.context); expect(w.market.deal).not.toHaveBeenCalled();
  s.terminal.store = createMockStore({ energy: 20000, H: 500 });
  Game.time += 10; clearMarketActionArbiterForTest();
  applyMarketOps([s], w.config, new Set(), w.context); expect(w.market.deal).not.toHaveBeenCalled();
});

it("自有房间可动矿足够时等待内部调拨，避免在缺口房重新买入", () => {
  const w = setup();
  const receiver = w.snapshot("W1N1"), donor = w.snapshot("W2N2", { energy: 20000, H: 5000 });
  w.config.buyResources = [RESOURCE_HYDROGEN];
  applyMarketOps([receiver, donor], w.config, new Set(), w.context);
  expect(w.market.deal).not.toHaveBeenCalled();
});
it("当前授权 V3 在卖的资源禁止旧买入路径再次采购", () => {
  const w = setup(), receiver = w.snapshot();
  w.config.buyResources = [RESOURCE_HYDROGEN];
  w.context.marketSellingResources = new Set([RESOURCE_HYDROGEN]);
  applyMarketOps([receiver], w.config, new Set(), w.context);
  expect(w.market.deal).not.toHaveBeenCalled();
});
