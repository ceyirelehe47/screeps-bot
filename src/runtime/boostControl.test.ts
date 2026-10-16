import { createMockStore } from "@mock/powerBank";
import { buyBoostIfNeeded, syncBoostLabTask, DEFENSE_BOOST_COMPOUND } from "@/runtime/boostControl";
import {
  clearMarketActionArbiterForTest,
  executeTerminalAction,
  getMarketActionJournal,
  getTerminalActionClaim,
} from "@/runtime/marketActionArbiter";

function createRoom(): Room {
  const room = {
    name: "W1N1",
    storage: {
      store: createMockStore({}),
    } as StructureStorage,
    terminal: {
      cooldown: 0,
      store: createMockStore({
        [RESOURCE_ENERGY]: 25000,
        [DEFENSE_BOOST_COMPOUND]: 0,
      }, 300000),
    } as StructureTerminal,
  } as Room;
  room.terminal!.room = room;
  Game.rooms[room.name] = room;
  return room;
}

function createBoostOrder(): Order {
  return {
    id: "boost-sell-order",
    type: ORDER_SELL,
    resourceType: DEFENSE_BOOST_COMPOUND,
    price: 5,
    amount: 1000,
    remainingAmount: 1000,
    roomName: "W2N2",
    created: 1,
  };
}

describe("boost control market gateway", () => {
  beforeEach(() => {
    Game.time = 100;
    clearMarketActionArbiterForTest();
    (Memory as any).cfg = {};
    (Memory.cfg as any).homeDefense = {
      boostTarget: 1000,
      maxBoostBuyPrice: 10,
      maxBoostDealEnergyCostRatio: 1,
    };
    (Game as any).market = {
      credits: 1_000_000,
      getAllOrders: jest.fn(() => [createBoostOrder()]),
      calcTransactionCost: jest.fn(() => 100),
      deal: jest.fn(() => OK),
    };
  });

  it("通过 arbiter 购买并记录 terminal claim", () => {
    const room = createRoom();
    Memory.data = {
      marketSaleAutomation: {
        managedOrders: {},
        pendingDirectDeals: {
          direct: {
            requestId: "direct-boost-gap",
            status: "reconcile_gap",
            canaryRoomName: room.name,
            resource: DEFENSE_BOOST_COMPOUND,
            dealAmount: 1_000,
            transactionEnergy: 24_900,
          },
        },
      },
    } as unknown as Memory["data"];

    buyBoostIfNeeded(room);

    expect(Game.market.deal).toHaveBeenCalledWith("boost-sell-order", 1000, "W1N1");
    expect(getTerminalActionClaim("W1N1")).toMatchObject({
      actor: "boostControl",
      kind: "market_deal",
      tick: 100,
    });
    expect(getMarketActionJournal()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actor: "boostControl",
        outcome: "intent",
        roomName: room.name,
      }),
    ]));
  });

  it("已有内部发送 claim 时不执行市场购买", () => {
    const room = createRoom();
    expect(executeTerminalAction("W1N1", "resourceControl", "terminal_send", () => OK)).toBe(OK);

    buyBoostIfNeeded(room);

    expect(Game.market.deal).not.toHaveBeenCalled();
    expect(getTerminalActionClaim("W1N1")?.actor).toBe("resourceControl");
  });
});


it("防御 boost lab 同时补矿物和 boost 能量", () => {
  const { clearCarrierTaskBoardForTest, listCarrierTasksByRoom } = require("@/runtime/carrierTaskBoard");
  clearCarrierTaskBoardForTest();
  Memory.cfg = { homeDefense: { rooms: { W1N1: { boostLabId: "lab" } } } };
  const room = createRoom(); Object.assign(room, { energyCapacityAvailable: 1300 });
  Object.assign(room.storage!, { id: "storage", store: createMockStore({ energy: 10000, [DEFENSE_BOOST_COMPOUND]: 1000 }) });
  const lab = { id: "lab", room, store: createMockStore({}, 3000) } as StructureLab;
  Game.getObjectById = jest.fn(() => lab) as unknown as Game["getObjectById"];
  syncBoostLabTask(room);
  const steps = listCarrierTasksByRoom(room.name).flatMap((task: any) => task.steps);
  expect(steps).toContainEqual(expect.objectContaining({ resource: RESOURCE_ENERGY, toId: "lab", amount: 200 }));
  expect(steps).toContainEqual(expect.objectContaining({ resource: DEFENSE_BOOST_COMPOUND, toId: "lab", amount: 300 }));
});
