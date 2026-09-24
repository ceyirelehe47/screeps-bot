import {
  clearMarketActionArbiterForTest,
  executeMarketDeal,
  executeTerminalAction,
  executeTerminalSend,
  getMarketActionJournal,
} from "@/runtime/marketActionArbiter";
import { TREASURY_T1_RUN_ID } from "@/runtime/treasuryT1Facts";
import {
  clearMarketSaleExposureReservationsForTest,
  getTerminalAmountOutsideMarketSaleExposure,
} from "@/runtime/marketSaleExposure";

interface WritableMarketMock {
  deal: jest.Mock;
  calcTransactionCost: jest.Mock;
  createOrder: jest.Mock;
  extendOrder: jest.Mock;
  changeOrderPrice: jest.Mock;
  cancelOrder: jest.Mock;
}

function installMarketMock(overrides: Partial<WritableMarketMock> = {}): WritableMarketMock {
  const market: WritableMarketMock = {
    deal: jest.fn(() => OK),
    calcTransactionCost: jest.fn(() => 0),
    createOrder: jest.fn(() => OK),
    extendOrder: jest.fn(() => OK),
    changeOrderPrice: jest.fn(() => OK),
    cancelOrder: jest.fn(() => OK),
    ...overrides,
  };
  (Game as unknown as { market: WritableMarketMock }).market = market;
  return market;
}

function installTerminal(
  roomName: string,
  amounts: Partial<Record<ResourceConstant, number>> = {},
): StructureTerminal {
  const room = { name: roomName } as Room;
  const terminal = {
    id: `${roomName}-terminal`,
    room,
    store: {
      getUsedCapacity: (resource?: ResourceConstant) =>
        resource ? (amounts[resource] || 0) : 0,
    },
  } as unknown as StructureTerminal;
  room.terminal = terminal;
  Game.rooms[roomName] = room;
  return terminal;
}

function executeProductionBuy(
  orderId: string,
  amount: number,
  roomName: string,
  actor: string,
): ScreepsReturnCode {
  return executeMarketDeal(
    orderId,
    amount,
    roomName,
    actor,
    {
      orderType: ORDER_SELL,
      resourceType: RESOURCE_KEANIUM,
      orderRoomName: "W7N7",
    },
  );
}

describe("market action arbiter", () => {
  beforeEach(() => {
    Game.time = 100;
    Memory.data = undefined;
    Memory.runtime = undefined;
    clearMarketActionArbiterForTest();
    clearMarketSaleExposureReservationsForTest();
    for (const roomName of ["W1N1", "W2N2", "W8N8", "W9N9"]) {
      installTerminal(roomName, {
        [RESOURCE_ENERGY]: 100_000,
        [RESOURCE_KEANIUM]: 100_000,
      });
    }
  });

  it("holds both bounded terminal scopes during an unresolved Treasury dispatch", () => {
    const market = installMarketMock();
    const sender = installTerminal("E5N59", {
      [RESOURCE_HYDROGEN]: 100,
      [RESOURCE_ENERGY]: 100,
    });
    sender.send = jest.fn(() => OK);
    installTerminal("E4N58", { [RESOURCE_ENERGY]: 1_000 });
    Memory.runtime = {
      treasuryProductionT1Quota: { runId: TREASURY_T1_RUN_ID, status: "dispatching" },
    } as unknown as Memory["runtime"];

    const sourceAction = jest.fn(() => OK);
    expect(executeTerminalAction("E3N59", "legacy-source", "terminal_send", sourceAction)).toBe(ERR_BUSY);
    expect(sourceAction).not.toHaveBeenCalled();
    expect(executeTerminalSend({
      terminal: sender,
      resourceType: RESOURCE_HYDROGEN,
      amount: 100,
      transactionCost: 10,
      destinationRoomName: "E4N58",
      actor: "legacy-other-source",
    })).toBe(ERR_BUSY);
    expect(sender.send).not.toHaveBeenCalled();
    expect(executeProductionBuy("buy", 10, "E4N58", "legacy-target")).toBe(ERR_BUSY);
    expect(market.deal).not.toHaveBeenCalled();

    const outsideAction = jest.fn(() => OK);
    expect(executeTerminalAction("E6N59", "unrelated", "terminal_send", outsideAction)).toBe(OK);
    (Memory.runtime as unknown as { treasuryProductionT1Quota: { status: string } })
      .treasuryProductionT1Quota.status = "drained";
    expect(executeTerminalAction("E3N59", "legacy-source", "terminal_send", sourceAction)).toBe(OK);
    expect(sourceAction).toHaveBeenCalledTimes(1);
  });

  it("Direct gap 后生产购买不能消耗 transaction-energy exposure", () => {
    const terminal = installTerminal("W8N8", {
      [RESOURCE_ENERGY]: 1_000,
    });
    const market = installMarketMock({
      calcTransactionCost: jest.fn(() => 200),
    });
    Memory.data = {
      marketSaleAutomation: {
        managedOrders: {},
        pendingDirectDeals: {
          direct: {
            requestId: "direct-gap-energy",
            status: "reconcile_gap",
            canaryRoomName: "W8N8",
            resource: RESOURCE_KEANIUM,
            dealAmount: 1_000,
            transactionEnergy: 900,
          },
        },
      },
    } as unknown as Memory["data"];

    expect(
      executeProductionBuy(
        "production-buy",
        100,
        "W8N8",
        "resourceControl:legacy-mineral-buy",
      ),
    ).toBe(ERR_NOT_ENOUGH_RESOURCES);
    expect(market.deal).not.toHaveBeenCalled();
    expect(
      getTerminalAmountOutsideMarketSaleExposure(
        terminal,
        RESOURCE_ENERGY,
      ),
    ).toBe(100);
    expect(getMarketActionJournal()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actor: "resourceControl:legacy-mineral-buy",
        outcome: "non_ok",
        resultCode: ERR_NOT_ENOUGH_RESOURCES,
      }),
    ]));
  });

  it("普通生产卖出同时原子保护待售资源和 transaction energy", () => {
    const amounts: Partial<Record<ResourceConstant, number>> = {
      [RESOURCE_KEANIUM]: 1_099,
      [RESOURCE_ENERGY]: 2_000,
    };
    const terminal = installTerminal("W8N8", amounts);
    const market = installMarketMock({
      calcTransactionCost: jest.fn(() => 200),
    });
    Memory.data = {
      marketSaleAutomation: {
        managedOrders: {},
        pendingDirectDeals: {
          direct: {
            requestId: "direct-gap-resource-and-energy",
            status: "reconcile_gap",
            canaryRoomName: "W8N8",
            resource: RESOURCE_KEANIUM,
            dealAmount: 800,
            transactionEnergy: 900,
          },
        },
      },
    } as unknown as Memory["data"];
    const sell = () => executeMarketDeal(
      "production-sell",
      300,
      "W8N8",
      "resourceControl:legacy-sell",
      {
        orderType: ORDER_BUY,
        resourceType: RESOURCE_KEANIUM,
        orderRoomName: "W7N7",
      },
    );

    expect(sell()).toBe(ERR_NOT_ENOUGH_RESOURCES);
    amounts[RESOURCE_KEANIUM] = 1_200;
    amounts[RESOURCE_ENERGY] = 1_099;
    expect(sell()).toBe(ERR_NOT_ENOUGH_RESOURCES);
    expect(market.deal).not.toHaveBeenCalled();

    amounts[RESOURCE_ENERGY] = 1_100;
    expect(sell()).toBe(OK);
    expect(market.deal).toHaveBeenCalledTimes(1);
    expect(
      getTerminalAmountOutsideMarketSaleExposure(
        terminal,
        RESOURCE_KEANIUM,
      ),
    ).toBe(100);
    expect(
      getTerminalAmountOutsideMarketSaleExposure(
        terminal,
        RESOURCE_ENERGY,
      ),
    ).toBe(0);
  });
});
