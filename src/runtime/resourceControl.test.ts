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

  it("跨 tick 普通 terminal feed 扣除已取货在途的同资源额度", () => {
    const room = createRoom({
      name: "E6N59",
      storageResources: { [RESOURCE_ENERGY]: 300_000 },
      terminalResources: {
        [RESOURCE_ENERGY]: 23_653,
        [RESOURCE_KEANIUM]: 231_449,
      },
    });
    Game.rooms[room.name] = room;
    Game.time = 20;
    authorizeMarketTerminalEnergyReadiness(room, 2);
    Game.creeps = {
      "feed-carrier": {
        name: "feed-carrier",
        room,
        store: {
          getUsedCapacity: (resource?: ResourceConstant) =>
            resource === RESOURCE_ENERGY || resource === undefined ? 800 : 0,
        },
      } as Creep,
    };
    const state = ensureCreepAssignmentState("feed-carrier");
    state.synthesisCarrierPendingToId = room.terminal!.id;
    state.synthesisCarrierPendingResource = RESOURCE_ENERGY;
    runResourceControl();
    expect(getCarrierTasksByRoom(room.name)[
      `resourceControl:terminal_feed:${room.name}:${RESOURCE_ENERGY}`
    ]).toMatchObject({
      type: "terminal_feed",
      steps: [expect.objectContaining({ amount: 1_547 })],
    });
    expect(getMarketEnergyReadinessObservation(room.name)).toMatchObject({
      plannedFeedAmount: 1_547,
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
});
