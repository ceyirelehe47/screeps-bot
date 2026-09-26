import {
  clearCarrierTaskBoardForTest,
  getCarrierTasksByRoom,
  listCarrierDispatchEntriesByRoom,
  replaceCarrierTasksForProducerRoom,
} from "@/runtime/carrierTaskBoard";
import {
  createCarrierDispatchRef,
  encodeCarrierDispatchStepKey,
} from "@/runtime/dispatchOwnership/ref";
import { reserveProductionResource } from "@/runtime/resourceReservation";
import * as marketBaseResourceAutomationModule from "@/runtime/marketBaseResourceAutomation";
import * as marketSaleProtectionAdapterModule from "@/runtime/marketSaleProtectionAdapter";
import {
  MARKET_BASE_RESOURCE_CATALOG,
  MARKET_BASE_RESOURCE_CONFIG_REVISION,
  MARKET_BASE_RESOURCE_POLICIES,
} from "@/runtime/marketBaseResourcePolicy";
import {
  type MarketTerminalEnergyReadinessAuthorizationProjection,
  runResourceControl,
} from "@/runtime/resourceControl";
import {
  defaultMarketDirectContinuousDependencies,
} from "@/runtime/marketDirectContinuousAutomation";
import {
  clearMarketActionArbiterForTest,
} from "@/runtime/marketActionArbiter";
import { ensureCreepAssignmentState } from "@/runtime/creepAssignmentState";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

type GameWithPartialMarket = Omit<Game, "market"> & {
  market: Partial<Market>;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createRoom(options: {
  name: string;
  storageResources?: Partial<Record<ResourceConstant, number>>;
  terminalResources?: Partial<Record<ResourceConstant, number>>;
  nativeMineralType?: MineralConstant;
  hasExtractor?: boolean;
  storageFreeCapacity?: number;
}): Room {
  const storageResources = options.storageResources ?? {};
  const terminalResources = options.terminalResources ?? {};
  const storageFreeCapacity = options.storageFreeCapacity ?? 1_000_000;
  const nativeMineral = options.nativeMineralType
    ? ({
        id: `${options.name}-mineral`,
        mineralType: options.nativeMineralType,
      } as Mineral)
    : null;
  const extractor =
    nativeMineral && options.hasExtractor !== false
      ? ({
          id: `${options.name}-extractor`,
          structureType: STRUCTURE_EXTRACTOR,
        } as StructureExtractor)
      : null;
  const room = {
    name: options.name,
    controller: { my: true, level: 8 } as StructureController,
    storage: {
      id: `${options.name}-storage`,
      structureType: STRUCTURE_STORAGE,
      store: {
        ...storageResources,
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (!resource) {
            return Object.values(storageResources).reduce(
              (sum, value) => sum + (value || 0),
              0,
            );
          }
          return storageResources[resource] || 0;
        },
        getFreeCapacity: () => storageFreeCapacity,
      },
    } as unknown as StructureStorage,
    terminal: {
      id: `${options.name}-terminal`,
      structureType: STRUCTURE_TERMINAL,
      cooldown: 0,
      send: jest.fn(() => OK),
      store: {
        ...terminalResources,
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (!resource) {
            return Object.values(terminalResources).reduce(
              (sum, value) => sum + (value || 0),
              0,
            );
          }
          return terminalResources[resource] || 0;
        },
        getFreeCapacity: (resource?: ResourceConstant) => {
          const used = resource
            ? terminalResources[resource] || 0
            : Object.values(terminalResources).reduce(
                (sum, value) => sum + (value || 0),
                0,
              );
          return 300000 - used;
        },
      },
    } as unknown as StructureTerminal,
    find(
      type: FindConstant,
      opts?: { filter?: (structure: Structure) => boolean },
    ) {
      if (type === FIND_MINERALS) {
        return nativeMineral ? [nativeMineral] : [];
      }
      if (type === FIND_STRUCTURES) {
        const structures: Structure[] = extractor ? [extractor] : [];
        return opts?.filter
          ? structures.filter((structure) => opts.filter?.(structure))
          : structures;
      }
      return [];
    },
  } as Room;
  (room.terminal as StructureTerminal).room = room;
  return room;
}






let resourceControlReadinessDeriveSpy: jest.SpyInstance | undefined;

function authorizeMarketTerminalEnergyReadiness(
  room: Room,
  sourcePermitVersion: 2 | 3 = 3,
): void {
  Memory.cfg = {
    ...Memory.cfg,
    marketSaleAutomation: {
      mode: "direct",
    },
  } as unknown as Memory["cfg"];
  const readinessAuthorization: MarketTerminalEnergyReadinessAuthorizationProjection =
    {
      schemaVersion: 3,
      validated: true,
      status: "authorized",
      revision: `permit:${Game.time}`,
      updatedAt: Game.time,
      expiresAt: Game.time + 10,
      maxTransactionEnergy: 1_000,
      sourcePermitVersion,
      rooms: [
        {
          roomName: room.name,
          roomInstanceId: `room:${room.name}:1`,
          terminalId: room.terminal!.id,
          status: "authorized",
        },
      ],
    };
  Memory.data = {
    ...Memory.data,
    marketSaleAutomation: {
      managedOrders: {},
      directAutomation: {
        baseResourceV3: {
          readinessAuthorization,
        },
      },
    },
  } as unknown as Memory["data"];
  resourceControlReadinessDeriveSpy?.mockReturnValue({
    ok: true,
    revision: readinessAuthorization.revision,
    maxTransactionEnergy: 1_000,
    sourcePermitVersion,
    rooms: [
      {
        roomName: room.name,
        roomInstanceId: readinessAuthorization.rooms[0].roomInstanceId,
        terminalId: room.terminal!.id,
      },
    ],
  });
}

function getMarketEnergyReadinessObservation(
  roomName: string,
): Record<string, unknown> | undefined {
  const runtime = Memory.runtime?.resourceControl as unknown as
    | {
        rooms?: Record<
          string,
          {
            marketEnergyReadiness?: Record<string, unknown>;
          }
        >;
      }
    | undefined;
  return runtime?.rooms?.[roomName]?.marketEnergyReadiness;
}

describe("runResourceControl terminal feed tasks", () => {
  beforeEach(() => {
    resourceControlReadinessDeriveSpy = jest
      .spyOn(
        marketBaseResourceAutomationModule,
        "deriveMarketBaseResourceCanonicalReadinessAuthorization",
      )
      .mockReturnValue({
        ok: false,
        reason: "missing",
        rooms: [],
      });
    clearCarrierTaskBoardForTest();
    clearMarketActionArbiterForTest();
    resetRuntimeServices();
    Game.time = 10;
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        market: {
          enabled: false,
        },
      },
    };
    Memory.data = undefined;
    Memory.runtime = undefined;
    Memory.rooms = {};
    Game.rooms = {};
    (Game as GameWithPartialMarket).market = {
      calcTransactionCost: jest.fn(() => 0),
      getAllOrders: jest.fn(() => []),
      deal: jest.fn(() => OK),
    };
  });

  afterEach(() => {
    resourceControlReadinessDeriveSpy?.mockRestore();
    resourceControlReadinessDeriveSpy = undefined;
  });

  it("终端已有可入库 Energy 时不重复跨房补货并占用卖货终端", () => {
    const seller = createRoom({
      name: "E4N58",
      storageResources: { [RESOURCE_ENERGY]: 1_300_000 },
      terminalResources: { [RESOURCE_ENERGY]: 140_000 },
    });
    const receiver = createRoom({
      name: "E5N59",
      storageResources: { [RESOURCE_ENERGY]: 170_000 },
      terminalResources: { [RESOURCE_ENERGY]: 240_000 },
    });
    Game.rooms = { [seller.name]: seller, [receiver.name]: receiver };

    runResourceControl();

    expect(seller.terminal!.send).not.toHaveBeenCalled();
    expect(receiver.terminal!.send).not.toHaveBeenCalled();
  });

  it("本地 Energy 总量确实不足时仍允许跨房补货", () => {
    const donor = createRoom({
      name: "E4N58",
      storageResources: { [RESOURCE_ENERGY]: 1_300_000 },
      terminalResources: { [RESOURCE_ENERGY]: 140_000 },
    });
    const receiver = createRoom({
      name: "E5N59",
      storageResources: { [RESOURCE_ENERGY]: 80_000 },
      terminalResources: { [RESOURCE_ENERGY]: 20_000 },
    });
    Game.rooms = { [donor.name]: donor, [receiver.name]: receiver };

    runResourceControl();

    expect(donor.terminal!.send).toHaveBeenCalledWith(
      RESOURCE_ENERGY,
      expect.any(Number),
      receiver.name,
      expect.any(String),
    );
  });

  it("creates the exact E6 2,347 Energy readiness feed above the ordinary used-cap", () => {
    const room = createRoom({
      name: "E6N59",
      storageResources: {
        [RESOURCE_ENERGY]: 300_000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 23_653,
        [RESOURCE_KEANIUM]: 231_449,
      },
    });
    Game.rooms[room.name] = room;
    authorizeMarketTerminalEnergyReadiness(room, 2);

    runResourceControl();

    expect(
      getCarrierTasksByRoom(room.name)[
        `resourceControl:terminal_feed:${room.name}:${RESOURCE_ENERGY}`
      ],
    ).toMatchObject({
      type: "terminal_feed",
      steps: [
        {
          resource: RESOURCE_ENERGY,
          amount: 2_347,
        },
      ],
    });
    expect(getMarketEnergyReadinessObservation(room.name)).toMatchObject({
      schemaVersion: 3,
      authorized: true,
      effectivePostDealEnergyReserve: 25_000,
      marketTerminalEnergyTarget: 26_000,
      desiredTerminalEnergy: 26_000,
      plannedFeedAmount: 2_347,
      status: "feed_planned",
    });
  });

  it("ignores the room floor while retaining production ownership for Direct readiness", () => {
    const room = createRoom({
      name: "E6N58",
      storageResources: {
        [RESOURCE_ENERGY]: 30_000,
      },
      terminalResources: {
        [RESOURCE_ENERGY]: 23_653,
        [RESOURCE_KEANIUM]: 220_000,
      },
    });
    Game.rooms[room.name] = room;
    reserveProductionResource(
      room.name,
      RESOURCE_ENERGY,
      5_000,
      "direct-readiness-production",
    );
    const sharedTaskId = `shared:production-task:${"task->".repeat(32)}`;
    const sharedStepId = `shared->energy:step:${"step:".repeat(32)}`;
    const publishCarrierCommitment = (producer: string, amount: number): void => {
      replaceCarrierTasksForProducerRoom(producer, room.name, [{
        id: sharedTaskId,
        type: "factory_supply",
        priority: 100,
        steps: [{
          id: sharedStepId,
          resource: RESOURCE_ENERGY,
          fromKind: "terminal",
          toKind: "factory",
          fromId: room.terminal!.id,
          toId: `${room.name}:factory`,
          amount,
        }],
      }]);
    };
    const producerA = `producer:a:factory:${"owner->".repeat(32)}`;
    const producerB = `producer->b:factory:${"owner:".repeat(32)}`;
    publishCarrierCommitment(producerA, 2_000);
    publishCarrierCommitment(producerB, 3_000);
    authorizeMarketTerminalEnergyReadiness(room, 2);

    runResourceControl();

    const observation = getMarketEnergyReadinessObservation(room.name);
    expect(observation).toMatchObject({
      terminalScopedProductionEnergyCommitments: 10_000,
      plannedFeedAmount: 7_347,
      status: "feed_planned",
    });
    const producerARef = createCarrierDispatchRef(
      producerA,
      room.name,
      sharedTaskId,
    );
    const producerBRef = createCarrierDispatchRef(
      producerB,
      room.name,
      sharedTaskId,
    );
    expect(producerARef).toBeDefined();
    expect(producerBRef).toBeDefined();
    if (!producerARef || !producerBRef) return;
    const producerAKey = encodeCarrierDispatchStepKey(
      producerARef,
      sharedStepId,
    );
    const producerBKey = encodeCarrierDispatchStepKey(
      producerBRef,
      sharedStepId,
    );
    expect(producerAKey.length).toBeGreaterThan(256);
    expect(producerBKey.length).toBeGreaterThan(256);
    expect(observation?.contributions).toEqual(expect.arrayContaining([
      {
        id: producerAKey,
        amount: 2_000,
        kind: "terminal_production_commitment",
      },
      {
        id: producerBKey,
        amount: 3_000,
        kind: "terminal_production_commitment",
      },
    ]));
    const readTerminalReadiness = (): unknown =>
      defaultMarketDirectContinuousDependencies.readTerminal(
        room.name,
        RESOURCE_KEANIUM,
      )?.marketEnergyReadiness;
    expect(
      (readTerminalReadiness() as { contributions?: unknown })
        ?.contributions,
    ).toEqual(observation?.contributions);
    const malformedReadiness = JSON.parse(
      JSON.stringify(observation),
    ) as {
      contributions: Array<{ id: string }>;
    };
    const longContribution = malformedReadiness.contributions.find(
      ({ id }) => id.length > 256,
    );
    expect(longContribution).toBeDefined();
    if (longContribution) {
      longContribution.id = `${longContribution.id} `;
    }
    const runtimeRoom = (
      Memory.runtime!.resourceControl as unknown as {
        rooms: Record<
          string,
          { marketEnergyReadiness?: unknown }
        >;
      }
    ).rooms[room.name];
    const canonicalReadiness = runtimeRoom.marketEnergyReadiness;
    runtimeRoom.marketEnergyReadiness = malformedReadiness;
    expect(readTerminalReadiness()).toBeUndefined();
    runtimeRoom.marketEnergyReadiness = canonicalReadiness;
    expect(listCarrierDispatchEntriesByRoom(room.name).find(
      ({ task }) =>
        task.id ===
          `resourceControl:terminal_feed:${room.name}:${RESOURCE_ENERGY}`,
    )?.task).toMatchObject({
      steps: [expect.objectContaining({ amount: 7_347 })],
    });
  });

  it("已签发 V3 lane 在满 terminal 下先腾挪 Energy，再用原 carrier task 补一批货", () => {
    const room = createRoom({
      name: "E1N57",
      storageResources: {
        [RESOURCE_ENERGY]: 300_000,
        [RESOURCE_CATALYST]: 200_000,
      },
      storageFreeCapacity: 1_000,
      terminalResources: {
        [RESOURCE_ENERGY]: 299_000,
        [RESOURCE_KEANIUM]: 1_000,
      },
    });
    Game.rooms[room.name] = room;
    authorizeMarketTerminalEnergyReadiness(room, 3);
    const policies = MARKET_BASE_RESOURCE_POLICIES;
    Memory.cfg!.marketSaleAutomation = {
      mode: "direct",
      directCapability: "continuous-v3",
      configRevision: MARKET_BASE_RESOURCE_CONFIG_REVISION,
      sellResources: [...MARKET_BASE_RESOURCE_CATALOG],
      hardFloor: Object.fromEntries(policies.map((policy) => [policy.resource, policy.hardFloor])),
      economicFloor: Object.fromEntries(policies.map((policy) => [policy.resource, policy.economicFloor])),
      forecastBuffer: Object.fromEntries(policies.map((policy) => [policy.resource, policy.laneReserve])),
      minDealAmount: 1_000,
      makerBatchAmount: 5_000,
      creditReserve: 0,
      terminalEnergyReserve: 25_000,
      maxDirectDealAmount: 1_000,
      maxDirectDealsPerCycle: 1,
      minDirectOrderAmount: 1_000,
      minDirectOrderNotional: Math.max(...policies.map((policy) => policy.minOrderNotional)),
      maxDirectRawOrdersScannedPerCycle: 1_000,
      maxDirectEligibleOrdersPricedPerCycle: 200,
      maxDirectTransactionEnergy: 1_000,
      directCanaryMaxConfirmedDeals: 1,
      energyShadowHardFloor: 20,
      planningSnapshotMaxAgeTicks: 10,
      minHistoryDays: 7,
      minHistoryTransactions: 100,
      minHistoryVolume: 100_000,
      historyFloorRatio: 0.95,
      historyMaxAgeDays: 2,
      canary: { enabled: true, allowExpansion: false },
    } as NonNullable<Memory["cfg"]>["marketSaleAutomation"];
    (Memory.data!.marketSaleAutomation as unknown as {
      directAutomation: { baseResourceV3: { ledger?: unknown } };
    }).directAutomation.baseResourceV3.ledger = {};
    resourceControlReadinessDeriveSpy?.mockReturnValue({
      ok: true,
      revision: `permit:${Game.time}`,
      maxTransactionEnergy: 1_000,
      sourcePermitVersion: 3,
      rooms: [{ roomName: room.name, roomInstanceId: `room:${room.name}:1`, terminalId: room.terminal!.id }],
      cargoLanes: [{ roomName: room.name, resource: RESOURCE_CATALYST, terminalId: room.terminal!.id, maxDealAmount: 1_000 }],
    });
    const protectionSpy = jest.spyOn(
      marketSaleProtectionAdapterModule,
      "collectLiveMarketSaleProtectionLedger",
    ).mockImplementation(() => ({
      globalBlocked: false,
      entries: {
        [`${room.name}:${RESOURCE_CATALYST}`]: {
          roomName: room.name,
          resource: RESOURCE_CATALYST,
          revision: Game.time,
          observedAt: Game.time,
          expiresAt: Game.time,
          fresh: true,
          blocked: false,
          grossSurplus: 100_000,
          terminalStock: 0,
          sourceContributions: [],
        },
      },
    } as ReturnType<typeof marketSaleProtectionAdapterModule.collectLiveMarketSaleProtectionLedger>));
    try {
      runResourceControl();
      expect(getCarrierTasksByRoom(room.name)[
        `resourceControl:terminal_offload:${room.name}:${RESOURCE_ENERGY}`
      ]).toMatchObject({
        type: "terminal_offload",
        steps: [expect.objectContaining({ resource: RESOURCE_ENERGY, amount: 1_000 })],
      });

      Game.time = 20;
      const nextRoom = createRoom({
        name: room.name,
        storageResources: {
          [RESOURCE_ENERGY]: 301_000,
          [RESOURCE_CATALYST]: 200_000,
        },
        storageFreeCapacity: 0,
        terminalResources: {
          [RESOURCE_ENERGY]: 298_000,
          [RESOURCE_KEANIUM]: 1_000,
        },
      });
      Game.rooms[room.name] = nextRoom;
      resourceControlReadinessDeriveSpy?.mockReturnValue({
        ok: true,
        revision: `permit:${Game.time}`,
        maxTransactionEnergy: 1_000,
        sourcePermitVersion: 3,
        rooms: [{ roomName: room.name, roomInstanceId: `room:${room.name}:1`, terminalId: room.terminal!.id }],
        cargoLanes: [{ roomName: room.name, resource: RESOURCE_CATALYST, terminalId: room.terminal!.id, maxDealAmount: 1_000 }],
      });
      runResourceControl();
      expect(getCarrierTasksByRoom(room.name)[
        `resourceControl:terminal_feed:${room.name}:${RESOURCE_CATALYST}`
      ]).toMatchObject({
        type: "terminal_feed",
        dispatchClass: "market_egress",
        steps: [expect.objectContaining({ resource: RESOURCE_CATALYST, amount: 1_000 })],
      });

      // 下一 tick 已有 carrier 把整批 1k 取在路上时，不再重建第二批备货。
      Game.time = 21;
      Game.creeps = {
        "market-cargo-carrier": {
          name: "market-cargo-carrier",
          room: nextRoom,
          store: {
            getUsedCapacity: (resource?: ResourceConstant) =>
              resource === RESOURCE_CATALYST || resource === undefined ? 1_000 : 0,
          },
        } as Creep,
      };
      const inFlight = ensureCreepAssignmentState("market-cargo-carrier");
      inFlight.synthesisCarrierPendingToId = nextRoom.terminal!.id;
      inFlight.synthesisCarrierPendingResource = RESOURCE_CATALYST;
      runResourceControl();
      expect(getCarrierTasksByRoom(room.name)[
        `resourceControl:terminal_feed:${room.name}:${RESOURCE_CATALYST}`
      ]).toBeUndefined();
    } finally {
      protectionSpy.mockRestore();
    }
  });
});
