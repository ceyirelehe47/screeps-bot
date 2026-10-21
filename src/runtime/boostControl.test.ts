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
        [RESOURCE_ENERGY]: 30000,
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

  it.each([3_000, 6_000])("供体只有%d boost 时按5000保护线选源，不能用保护库存虚报 incoming", stock => {
    const receiver = createRoom();
    const donor = { name: "W3N3", controller: { my: true, level: 8 }, find: () => [],
      storage: { id: "donor-storage", store: createMockStore({ [DEFENSE_BOOST_COMPOUND]: stock }, 1_000_000) },
      terminal: { id: "donor-terminal", cooldown: 0, structureType: STRUCTURE_TERMINAL,
        store: createMockStore({ [RESOURCE_ENERGY]: 30_000 }, 300_000) } } as unknown as Room;
    donor.terminal!.room = donor; Game.rooms[donor.name] = donor;
    buyBoostIfNeeded(receiver);
    const tasks = Object.values(Memory.data?.resourceControl?.tasks ?? {});
    if (stock === 3_000) { expect(tasks).toHaveLength(0); expect(Game.market.deal).toHaveBeenCalled(); }
    else { expect(tasks).toHaveLength(1); expect(tasks[0]).toMatchObject({ fromRoomName: donor.name, amount: 1_000 }); expect(Game.market.deal).not.toHaveBeenCalled(); }
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
