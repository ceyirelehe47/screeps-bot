import { cadenceOffset } from "@/runtime/cadence";
import { createTreasuryService } from "@/runtime/treasury/facade";
import {
  createAutomaticResourceTransferTask,
  createResourceTransferTask,
  ensureResourceTransferTaskStore,
  getIncomingResourceTransferAmount,
  markResourceTransferTaskBlocked,
} from "@/runtime/logistics/resourceTransferTasks";
import { registerRuntimeServices } from "@/runtime/runtimeServices";
import {
  type DistributedSynthesisPlan,
  getDefaultHubRuntime,
  planDistributedSynthesis,
  planHubChains,
  planHubImports,
  resupplyBusySynthesisRooms,
  runHubPlanner,
  writeSynthesisConfig,
  wireDistributedSynthesis,
  wireRouteTransferTasks,
} from "@/runtime/hubPlanner";


const HUB_ROOM = "W1N1";

function createSatelliteRoom(
  roomName: string,
  storageResources: Record<string, number>,
  terminalResources: Record<string, number> = {},
): Room {
  const storageEntries: Record<string, number> = { [RESOURCE_ENERGY]: 50000, ...storageResources };
  const terminalEntries: Record<string, number> = { [RESOURCE_ENERGY]: 20000, ...terminalResources };

  const storage = {
    id: `${roomName}-storage`,
    structureType: STRUCTURE_STORAGE,
    store: {
      ...storageEntries,
      getUsedCapacity: (resource?: string) => {
        if (resource) return storageEntries[resource] || 0;
        return Object.values(storageEntries).reduce((a: number, b: number) => a + b, 0);
      },
      getFreeCapacity: () => 500000,
    },
  };

  const terminal = {
    id: `${roomName}-terminal`,
    structureType: STRUCTURE_TERMINAL,
    store: {
      ...terminalEntries,
      getUsedCapacity: (resource?: string) => {
        if (resource) return terminalEntries[resource] || 0;
        return Object.values(terminalEntries).reduce((a: number, b: number) => a + b, 0);
      },
      getFreeCapacity: () => 300000,
      cooldown: 0,
    },
  };

  return {
    name: roomName,
    controller: { my: true, level: 8 },
    storage,
    terminal,
    find: () => [],
  } as unknown as Room;
}

function createHubRoomForImports(freeCapacity: number = 500000): Room {
  const storageEntries: Record<string, number> = { [RESOURCE_ENERGY]: 200000 };
  return {
    name: HUB_ROOM,
    controller: { my: true, level: 8 },
    storage: {
      id: "hub-storage",
      structureType: STRUCTURE_STORAGE,
      store: {
        ...storageEntries,
        getUsedCapacity: (resource?: string) => {
          if (resource) return storageEntries[resource] || 0;
          return Object.values(storageEntries).reduce((a: number, b: number) => a + b, 0);
        },
        getFreeCapacity: () => freeCapacity,
      },
    },
    terminal: {
      id: "hub-terminal",
      structureType: STRUCTURE_TERMINAL,
      store: {
        [RESOURCE_ENERGY]: 20000,
        getUsedCapacity: () => 0,
        getFreeCapacity: () => 300000,
        cooldown: 0,
      },
    },
    find: () => [],
  } as unknown as Room;
}

describe("planHubImports", () => {
  const HUB_ROOM = "W1N1";
  const SAT_ROOM = "W2N1";

  beforeEach(() => {
    Game.time = 50;
    Game.rooms = {};
    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: HUB_ROOM,
        planInterval: 50,
        reservePerRoom: 1000,
        targetCompounds: [RESOURCE_CATALYZED_GHODIUM_ALKALIDE], // XGHO2
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
      },
    };
    Memory.runtime = { hub: getDefaultHubRuntime() };
    Memory.data = {};
    (global as any).__runtimeServices = undefined;
    registerRuntimeServices();
  });

  it("HUB补料只承诺保护线以上的真实仓储现货，同轮多个卫星不能重复占用", () => {
    delete Memory.cfg!.hub!.targetCompounds;
    const hub = createSatelliteRoom(HUB_ROOM, { H: 25_000, G: 8_000, OH: 55_000, XUH2O: 10_000 });
    const first = createSatelliteRoom(SAT_ROOM, {}), second = createSatelliteRoom("W3N1", {});
    Game.rooms = { [hub.name]: hub, [first.name]: first, [second.name]: second };
    Memory.runtime = { synthesisControl: { rooms: {
      [first.name]: { stage: "loading", missing: { H: 10_000, G: 5_000, OH: 10_000, XUH2O: 1_000 } },
      [second.name]: { stage: "loading", missing: { H: 10_000, OH: 10_000 } },
    } } } as unknown as Memory["runtime"];
    // 预测库存故意包含不在仓储中的货，不能把它当成可出货的现货。
    resupplyBusySynthesisRooms(HUB_ROOM, { H: 50_000, G: 50_000, OH: 80_000, XUH2O: 30_000 }, 5_000);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    expect(tasks.reduce((sum, task) => sum + (task.resource === RESOURCE_HYDROGEN ? task.amount : 0), 0)).toBe(5_000);
    expect(tasks.reduce((sum, task) => sum + (task.resource === RESOURCE_HYDROXIDE ? task.amount : 0), 0)).toBe(5_000);
    expect(tasks.some(task => task.resource === RESOURCE_GHODIUM || task.resource === RESOURCE_CATALYZED_UTRIUM_ACID)).toBe(false);
  });

  it("survival 卫星房只导出默认5000保护线以上的基础矿", () => {
    Game.rooms[HUB_ROOM] = createHubRoomForImports();
    Game.rooms[SAT_ROOM] = createSatelliteRoom(SAT_ROOM, {
      [RESOURCE_HYDROGEN]: 5500,
    });
    Memory.runtime!.resourceControl = {
      updatedAt: Game.time,
      rooms: {
        [SAT_ROOM]: {
          state: "survival",
          storageEnergy: 50000,
          terminalEnergy: 20000,
          energyFloor: 120000,
          energyTarget: 200000,
          energyExportStart: 250000,
          canMineNative: false,
          minerals: {},
        },
      },
      lastActions: [],
      lastMarketActions: [],
    };
    const actions = planHubImports(Memory.cfg!.hub!);
    expect(actions).toContain(`import:${SAT_ROOM}:${RESOURCE_HYDROGEN}=500`);
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const hTask = tasks.find(
      (t) => t.resource === RESOURCE_HYDROGEN && t.reason === `hub:import:${RESOURCE_HYDROGEN}`,
    );
    expect(hTask).toBeDefined();
    expect(hTask!.amount).toBe(500);

    markResourceTransferTaskBlocked(hTask!, "receiver_capacity");
    Game.time += 500;
    const replacementActions = planHubImports(Memory.cfg!.hub!);
    expect(replacementActions).toContain(
      `import:${SAT_ROOM}:${RESOURCE_HYDROGEN}=500`,
    );
    const replacementTasks = Object.values(
      ensureResourceTransferTaskStore(),
    ).filter(
      (task) =>
        task.resource === RESOURCE_HYDROGEN &&
        task.reason === `hub:import:${RESOURCE_HYDROGEN}`,
    );
    expect(replacementTasks).toHaveLength(2);
    expect(
      replacementTasks.some(
        (task) => task.id !== hTask!.id && task.amount === 500,
      ),
    ).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// Integration tests: full HUB lifecycle crossing hubFlag → hubPlanner → resourceTransferTasks
// ---------------------------------------------------------------------------


function createIntegrationHubRoom(
  roomName: string,
  storageResources: Record<string, number>,
  options: {
    hasTerminal?: boolean;
    hasStorage?: boolean;
    labCount?: number;
    storageFreeCapacity?: number;
  } = {},
): Room {
  const {
    hasTerminal = true,
    hasStorage = true,
    labCount = 3,
    storageFreeCapacity = 500000,
  } = options;

  const storageEntries: Record<string, number> = {
    [RESOURCE_ENERGY]: 200000,
    ...storageResources,
  };

  const storage = hasStorage
    ? {
        id: `${roomName}-storage`,
        structureType: STRUCTURE_STORAGE,
        store: {
          ...storageEntries,
          getUsedCapacity: (resource?: string) => {
            if (resource) return storageEntries[resource] || 0;
            return Object.values(storageEntries).reduce(
              (a: number, b: number) => a + b,
              0,
            );
          },
          getFreeCapacity: () => storageFreeCapacity,
        },
      }
    : undefined;

  const terminal = hasTerminal
    ? {
        id: `${roomName}-terminal`,
        structureType: STRUCTURE_TERMINAL,
        store: {
          [RESOURCE_ENERGY]: 20000,
          getUsedCapacity: () => 0,
          getFreeCapacity: () => 300000,
          cooldown: 0,
        },
      }
    : undefined;

  const labs: Structure[] = [];
  for (let i = 0; i < labCount; i++) {
    labs.push({
      id: `${roomName}-lab-${i}`,
      structureType: STRUCTURE_LAB,
    } as Structure);
  }

  return {
    name: roomName,
    controller: { my: true, level: 8 },
    storage,
    terminal,
    find: (
      type: FindConstant,
      opts?: {
        filter?: ((s: Structure) => boolean) | { structureType: string };
      },
    ) => {
      if (type === FIND_MY_STRUCTURES) {
        if (!opts?.filter) return labs;
        if (typeof opts.filter === "function") return labs.filter(opts.filter);
        const targetType = (opts.filter as { structureType: string })
          .structureType;
        return labs.filter((s) => s.structureType === targetType);
      }
      return [];
    },
  } as unknown as Room;
}


const INTEGRATION_HUB = "W1N1";
const INTEGRATION_SAT = "W2N1";

describe("HUB lifecycle integration", () => {
  beforeEach(() => {
    Game.time = 50;
    Game.rooms = {};
    Game.flags = {};
    Memory.cfg = {};
    Memory.runtime = {};
    Memory.data = {};
    (global as any).__runtimeServices = undefined;
    registerRuntimeServices();
  });

  // Regression: healthy pending incoming prevents duplicate demand
  it("healthy pending Z import is counted and does not create duplicate demand", () => {
    const mineralsWithoutZ: Record<string, number> = {
      [RESOURCE_HYDROGEN]: 15000,
      [RESOURCE_OXYGEN]: 15000,
      [RESOURCE_UTRIUM]: 10000,
      [RESOURCE_LEMERGIUM]: 10000,
      [RESOURCE_KEANIUM]: 10000,
      [RESOURCE_CATALYST]: 10000,
    };

    Game.rooms[INTEGRATION_HUB] = createIntegrationHubRoom(INTEGRATION_HUB, mineralsWithoutZ);
    Game.rooms[INTEGRATION_SAT] = createSatelliteRoom(INTEGRATION_SAT, {
      [RESOURCE_ZYNTHIUM]: 5000,
      [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 1000,
    });

    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: INTEGRATION_HUB,
        planInterval: 50,
        reservePerRoom: 1000,
        hubReservePerCompound: 1000,
        targetCompounds: [RESOURCE_CATALYZED_GHODIUM_ALKALIDE],
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
      },
    };
    Memory.runtime = {
      hub: { ...getDefaultHubRuntime(), needsPlan: true },
    };

    // Create healthy pending import of Z (no lastError)
    createResourceTransferTask(
      INTEGRATION_SAT,
      INTEGRATION_HUB,
      RESOURCE_ZYNTHIUM,
      5000,
      `hub:import:${RESOURCE_ZYNTHIUM}`,
    );

    // Verify healthy import IS counted as incoming
    expect(getIncomingResourceTransferAmount(INTEGRATION_HUB, RESOURCE_ZYNTHIUM)).toBe(5000);

    runHubPlanner();

    // Hub should NOT be blocked — healthy Z import covers the deficit
    expect(Memory.runtime.hub!.status).not.toBe("blocked");
    expect(Memory.runtime.hub!.missingResources).not.toContain(RESOURCE_ZYNTHIUM);

    // Verify no duplicate Z import task was created
    const tasks = Object.values(ensureResourceTransferTaskStore());
    const zImportTasks = tasks.filter(
      (t) => t.resource === RESOURCE_ZYNTHIUM && t.reason === `hub:import:${RESOURCE_ZYNTHIUM}`,
    );
    expect(zImportTasks).toHaveLength(1);
    expect(zImportTasks[0].amount).toBe(5000);

    // A coverage-expired Hub export no longer satisfies the satellite reserve.
    // Hub must plan the missing replacement amount before ResourceControl gets
    // a chance to reconcile/cancel the old task later in the tick.
    Game.time = 0;
    Game.rooms = {
      [INTEGRATION_HUB]: createIntegrationHubRoom(INTEGRATION_HUB, {
        [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: 1000,
        [RESOURCE_GHODIUM_ALKALIDE]: 1000,
        [RESOURCE_CATALYST]: 1000,
      }),
      [INTEGRATION_SAT]: createSatelliteRoom(INTEGRATION_SAT, {}),
    };
    (global as any).__runtimeServices = undefined;
    registerRuntimeServices();
    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: INTEGRATION_HUB,
        planInterval: 50,
        reservePerRoom: 1000,
        hubReservePerCompound: 1000,
        targetCompounds: [RESOURCE_CATALYZED_GHODIUM_ALKALIDE],
        storagePauseFreeCapacity: 100_000,
        surplusThreshold: 1500,
        internalOnly: true,
      },
    };
    Memory.runtime = { hub: { ...getDefaultHubRuntime(), needsPlan: true } };
    Memory.data = {};
    const expiredExport = createAutomaticResourceTransferTask(
      INTEGRATION_HUB,
      INTEGRATION_SAT,
      RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
      1000,
      `hub:export:${RESOURCE_CATALYZED_GHODIUM_ALKALIDE}`,
    );
    if (typeof expiredExport === "string") throw new Error(expiredExport);
    markResourceTransferTaskBlocked(expiredExport.task, "receiver_capacity");
    Game.time = 500;
    runHubPlanner();
    expect(expiredExport.task.status).toBe("pending");
    expect(Memory.runtime.hub!.status).toBe("importing");
    expect(Memory.runtime.hub!.activeProduct).toBe(
      RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
    );

    // A plan with more runnable chain steps than physical rooms must never
    // reuse a room for a second active product. The uncovered work remains
    // observable through blockedTargets.
    const globalInventory: Record<string, number> = {
      [RESOURCE_HYDROGEN]: 15000,
      [RESOURCE_OXYGEN]: 15000,
      [RESOURCE_UTRIUM]: 15000,
      [RESOURCE_LEMERGIUM]: 15000,
      [RESOURCE_KEANIUM]: 15000,
      [RESOURCE_ZYNTHIUM]: 15000,
      [RESOURCE_CATALYST]: 15000,
    };
    Game.rooms = {
      [INTEGRATION_HUB]: createIntegrationHubRoom(INTEGRATION_HUB, globalInventory),
      [INTEGRATION_SAT]: createIntegrationHubRoom(INTEGRATION_SAT, globalInventory),
    };
    (global as any).__runtimeServices = undefined;
    registerRuntimeServices();
    Memory.data = {};
    Memory.runtime = { hub: getDefaultHubRuntime() };
    const constrainedPlan = planDistributedSynthesis(
      INTEGRATION_HUB,
      [RESOURCE_CATALYZED_GHODIUM_ALKALIDE],
      1000,
      1000,
      globalInventory,
    );
    const constrainedRooms = constrainedPlan.dispatchAssignments.map(assignment => assignment.roomName);
    expect(new Set(constrainedRooms).size).toBe(constrainedRooms.length);
    expect(constrainedRooms).toHaveLength(2);
    expect(constrainedPlan.blockedTargets).toContain(RESOURCE_CATALYZED_GHODIUM_ALKALIDE);

    const partialChain = planHubChains(
      {
        [RESOURCE_UTRIUM_ACID]: 1000,
        [RESOURCE_CATALYST]: 2000,
        [RESOURCE_HYDROGEN]: 10000,
        [RESOURCE_OXYGEN]: 10000,
      },
      {},
      1000,
      [
        RESOURCE_CATALYZED_UTRIUM_ACID,
        RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
      ],
    );
    expect(partialChain.blocked).toBe(false);
    expect(partialChain.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          product: RESOURCE_CATALYZED_UTRIUM_ACID,
        }),
      ]),
    );
    expect(partialChain.missingResources).toContain(RESOURCE_KEANIUM);

    // A room-level pendingTasks cache may contain unrelated traffic. Reassign
    // decisions must use the current amount index for each missing resource.
    Game.rooms.W4N1 = createIntegrationHubRoom("W4N1", globalInventory);
    Game.rooms.W7N1 = createIntegrationHubRoom("W7N1", globalInventory);
    (global as any).__runtimeServices = undefined;
    registerRuntimeServices();
    Memory.cfg = {
      synthesisControl: {
        enabled: true,
        rooms: {
          W3N1: {
            enabled: true,
            donorRoomNames: [],
            plannerOwnership: { owner: "hubPlanner", hubRoomName: INTEGRATION_HUB, revision: 3 },
            reactions: [{ product: RESOURCE_HYDROXIDE, targetAmount: 100, batchSize: 100 }],
          },
          W4N1: {
            enabled: true,
            donorRoomNames: [],
            plannerOwnership: { owner: "hubPlanner", hubRoomName: INTEGRATION_HUB, revision: 3 },
            reactions: [{ product: RESOURCE_HYDROXIDE, targetAmount: 100, batchSize: 100 }],
          },
          W5N1: {
            enabled: true,
            donorRoomNames: [],
            reactions: [{ product: RESOURCE_HYDROXIDE, targetAmount: 100, batchSize: 100 }],
          },
          W7N1: {
            enabled: true,
            donorRoomNames: [],
            plannerOwnership: { owner: "hubPlanner", hubRoomName: INTEGRATION_HUB, revision: 5 },
            reactions: [{ product: RESOURCE_HYDROXIDE, targetAmount: 100, batchSize: 100 }],
          },
        },
      },
    } as any;
    (Memory.cfg.synthesisControl!.rooms as any).W6N1 = {
      enabled: true,
      donorRoomNames: [],
      plannerOwnership: { owner: "anotherPlanner", hubRoomName: INTEGRATION_HUB, revision: 3 },
      reactions: [{ product: RESOURCE_HYDROXIDE, targetAmount: 100, batchSize: 100 }],
    };
    Memory.runtime = {
      hub: getDefaultHubRuntime(),
      synthesisControl: {
        updatedAt: Game.time,
        generatedTaskCount: 0,
        failedTaskCount: 0,
        successfulRunCount: 0,
        lastActions: [],
        bindings: {},
        rooms: {
          [INTEGRATION_SAT]: {
            stage: "loading",
            activeProduct: RESOURCE_ZYNTHIUM_KEANITE,
            targetAmount: 100,
            batchSize: 100,
            reagentLabIds: [],
            productLabIds: [],
            successfulRuns: 0,
            pendingTasks: 1,
            missing: { [RESOURCE_HYDROGEN]: 100 },
            lastTransitionAt: Game.time,
          },
          W4N1: {
            stage: "loading",
            activeProduct: RESOURCE_HYDROXIDE,
            targetAmount: 100,
            batchSize: 100,
            reagentLabIds: [],
            productLabIds: [],
            successfulRuns: 0,
            pendingTasks: 0,
            lastTransitionAt: Game.time,
          },
          W7N1: {
            stage: "idle",
            activeProduct: undefined,
            targetAmount: 0,
            batchSize: 100,
            reagentLabIds: [],
            productLabIds: [],
            successfulRuns: 0,
            pendingTasks: 0,
            lastTransitionAt: Game.time,
          },
        },
      },
    };
    Memory.data = {};
    createResourceTransferTask(
      INTEGRATION_HUB,
      INTEGRATION_SAT,
      RESOURCE_ZYNTHIUM,
      100,
      "unrelated:test",
    );

    const validPlan: DistributedSynthesisPlan = {
      dispatchAssignments: [{
        roomName: INTEGRATION_SAT,
        product: RESOURCE_HYDROXIDE,
        targetAmount: 100,
        isHubRoom: false,
        finalTarget: RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
      }],
      allocationLedger: {},
      routeDecisions: [{
        fromRoom: INTEGRATION_HUB,
        toRoom: INTEGRATION_SAT,
        resource: RESOURCE_HYDROGEN,
        amount: 100,
        fee: 0,
      }],
      blockedTargets: [],
      missingResources: [],
    };
    expect(wireDistributedSynthesis(
      INTEGRATION_HUB,
      4,
      [RESOURCE_CATALYZED_GHODIUM_ALKALIDE],
      1000,
      1000,
      globalInventory,
      [],
      false,
      1000,
      undefined,
      {},
      validPlan,
    )).toBe(true);

    const synthesisRooms = Memory.cfg.synthesisControl!.rooms! as Record<string, any>;
    expect(synthesisRooms[INTEGRATION_SAT].reactions?.[0]?.product).toBe(RESOURCE_HYDROXIDE);
    expect(synthesisRooms[INTEGRATION_SAT].plannerOwnership).toEqual({
      owner: "hubPlanner",
      hubRoomName: INTEGRATION_HUB,
      revision: 4,
    });
    expect(synthesisRooms.W3N1.reactions).toEqual([]);
    expect(synthesisRooms.W3N1.plannerOwnership).toBeUndefined();
    expect(synthesisRooms.W4N1.reactions?.[0]?.product).toBe(RESOURCE_HYDROXIDE);
    expect(synthesisRooms.W4N1.plannerOwnership?.revision).toBe(3);
    expect(synthesisRooms.W5N1.reactions?.[0]?.product).toBe(RESOURCE_HYDROXIDE);
    expect((synthesisRooms as any).W6N1.reactions[0].product).toBe(RESOURCE_HYDROXIDE);
    const distributedRuntime = Memory.runtime.hub!.distributedSynthesis as typeof Memory.runtime.hub.distributedSynthesis & {
      configReconcile: {
        revision: number;
        refreshedRooms: string[];
        clearedRooms: string[];
        skippedBusyRooms: string[];
        foreignOwnerRooms: string[];
      };
    };
    expect(distributedRuntime.configReconcile).toEqual({
      revision: 4,
      refreshedRooms: [INTEGRATION_SAT],
      clearedRooms: ["W3N1"],
      skippedBusyRooms: ["W4N1"],
      foreignOwnerRooms: ["W5N1", "W6N1"],
    });

    // Once the old owned room becomes idle, the next revision reclaims it.
    Memory.runtime.synthesisControl!.rooms.W4N1.stage = "idle";
    expect(wireDistributedSynthesis(
      INTEGRATION_HUB,
      5,
      [RESOURCE_CATALYZED_GHODIUM_ALKALIDE],
      1000,
      1000,
      globalInventory,
      [],
      false,
      1000,
      undefined,
      {},
      validPlan,
    )).toBe(true);
    expect(synthesisRooms.W4N1.reactions).toEqual([]);
    expect(synthesisRooms.W4N1.plannerOwnership).toBeUndefined();
    const nextDistributedRuntime = Memory.runtime.hub!.distributedSynthesis as typeof distributedRuntime;
    expect(nextDistributedRuntime.configReconcile).toMatchObject({
      revision: 5,
      clearedRooms: ["W4N1"],
      skippedBusyRooms: [],
    });

    (Game.rooms[INTEGRATION_SAT].storage!.store as unknown as Record<string, number>)[RESOURCE_OXYGEN] = 0;
    (Game.rooms[INTEGRATION_HUB].storage!.store as unknown as Record<string, number>)[RESOURCE_OXYGEN] = 0;
    (Game.rooms.W4N1.storage!.store as unknown as Record<string, number>)[RESOURCE_HYDROGEN] = 0;

    // The allocation ledger already counts healthy pending route work at the
    // receiver and subtracts it from the donor, so a new decision for the same
    // route is incremental demand. Preserve completed progress when merging it.
    wireRouteTransferTasks([{
      ...validPlan.routeDecisions[0],
      resource: RESOURCE_OXYGEN,
      amount: 100,
    }], INTEGRATION_HUB, 1000, false);
    const progressedRouteTask = Object.values(ensureResourceTransferTaskStore()).find(
      task => task.status === "pending" && task.reason === `synthesis:direct:${RESOURCE_OXYGEN}`,
    )!;
    progressedRouteTask.remainingAmount = 40;
    progressedRouteTask.lastProgressAt = Game.time;
    progressedRouteTask.updatedAt = Game.time;
    progressedRouteTask.lastError = "send_code_-6";
    const deliveredBeforeReplan = progressedRouteTask.amount - progressedRouteTask.remainingAmount;
    const lastProgressAtBeforeReplan = progressedRouteTask.lastProgressAt;
    const updatedAtBeforeReplan = progressedRouteTask.updatedAt;
    Game.time += 1;
    wireRouteTransferTasks([{
      ...validPlan.routeDecisions[0],
      resource: RESOURCE_OXYGEN,
      amount: 75,
    }], INTEGRATION_HUB, 1000, false);
    const progressedRouteTasks = Object.values(ensureResourceTransferTaskStore()).filter(
      task => task.reason === `synthesis:direct:${RESOURCE_OXYGEN}`,
    );
    expect(progressedRouteTasks).toHaveLength(1);
    expect(progressedRouteTask.amount).toBe(175);
    expect(progressedRouteTask.remainingAmount).toBe(115);
    expect(progressedRouteTask.amount - progressedRouteTask.remainingAmount).toBe(deliveredBeforeReplan);
    expect(progressedRouteTask.lastProgressAt).toBe(lastProgressAtBeforeReplan);
    expect(progressedRouteTask.updatedAt).toBeGreaterThan(updatedAtBeforeReplan);
    expect(progressedRouteTask.lastError).toBeUndefined();

    // A zero-delta revision means this healthy pending remainder already
    // covers the active assignment through effective inventory. It is not a
    // stale route merely because no new routeDecision was required.
    const coveredPlan: DistributedSynthesisPlan = {
      ...validPlan,
      routeDecisions: [],
    };
    synthesisRooms.W4N1 = {
      enabled: true,
      donorRoomNames: [],
      plannerOwnership: { owner: "hubPlanner", hubRoomName: INTEGRATION_HUB, revision: 5 },
      reactions: [{ product: RESOURCE_HYDROXIDE, targetAmount: 100, batchSize: 100 }],
    };
    Memory.runtime.synthesisControl!.rooms.W4N1 = {
      stage: "loading",
      activeProduct: RESOURCE_HYDROXIDE,
      targetAmount: 100,
      batchSize: 100,
      reagentLabIds: [],
      productLabIds: [],
      successfulRuns: 0,
      pendingTasks: 0,
      lastTransitionAt: Game.time,
    };
    Memory.runtime.synthesisControl!.rooms[INTEGRATION_SAT].activeProduct = RESOURCE_HYDROXIDE;
    const hubFallbackRoute = createAutomaticResourceTransferTask(
      INTEGRATION_SAT,
      INTEGRATION_HUB,
      RESOURCE_OXYGEN,
      50,
      `synthesis:direct:${RESOURCE_OXYGEN}`,
    );
    const busyContinuityRoute = createAutomaticResourceTransferTask(
      INTEGRATION_HUB,
      "W4N1",
      RESOURCE_HYDROGEN,
      60,
      `synthesis:direct:${RESOURCE_HYDROGEN}`,
    );
    const clearedRoomRoute = createAutomaticResourceTransferTask(
      INTEGRATION_HUB,
      "W7N1",
      RESOURCE_HYDROGEN,
      55,
      `synthesis:direct:${RESOURCE_HYDROGEN}`,
    );
    if (
      typeof hubFallbackRoute === "string" ||
      typeof busyContinuityRoute === "string" ||
      typeof clearedRoomRoute === "string"
    ) {
      throw new Error("failed_to_create_zero_delta_route_dependencies");
    }
    const treasury = createTreasuryService({ getRooms: () => Object.values(Game.rooms) });
    const beforeReplan = treasury.commitments();
    expect(beforeReplan.incoming("W7N1", RESOURCE_HYDROGEN)).toBe(55);
    expect(wireDistributedSynthesis(
      INTEGRATION_HUB,
      6,
      [RESOURCE_CATALYZED_GHODIUM_ALKALIDE],
      1000,
      1000,
      globalInventory,
      [{
        product: RESOURCE_HYDROXIDE,
        targetAmount: 100,
        reagents: [RESOURCE_HYDROGEN, RESOURCE_OXYGEN],
      }],
      true,
      1000,
      undefined,
      {},
      coveredPlan,
    )).toBe(true);
    expect(progressedRouteTask).toMatchObject({
      status: "pending",
      amount: 175,
      remainingAmount: 115,
      lastProgressAt: lastProgressAtBeforeReplan,
    });
    expect(hubFallbackRoute.task).toMatchObject({ status: "pending", remainingAmount: 50 });
    expect(busyContinuityRoute.task).toMatchObject({ status: "pending", remainingAmount: 60 });
    expect(synthesisRooms.W7N1.reactions).toEqual([]);
    expect(clearedRoomRoute.task).toMatchObject({
      status: "cancelled",
      lastError: "cancelled_by_replan",
    });

    expect(treasury.commitments().incoming("W7N1", RESOURCE_HYDROGEN)).toBe(0);
    expect(beforeReplan.incoming("W7N1", RESOURCE_HYDROGEN)).toBe(55);

    // Coverage-expired route work must not be rewritten back to life before
    // ResourceControl reconciliation. A fresh task is created instead.
    const oldRouteTask = progressedRouteTask;
    oldRouteTask.blockedReason = "receiver_capacity";
    oldRouteTask.blockedSince = Game.time;
    Game.time += 500;
    wireRouteTransferTasks([{
      ...validPlan.routeDecisions[0],
      resource: RESOURCE_OXYGEN,
      amount: 175,
    }], INTEGRATION_HUB, 1000, false);
    const routeTasks = Object.values(ensureResourceTransferTaskStore()).filter(
      task =>
        task.fromRoomName === INTEGRATION_HUB &&
        task.toRoomName === INTEGRATION_SAT &&
        task.reason === `synthesis:direct:${RESOURCE_OXYGEN}`,
    );
    expect(routeTasks).toHaveLength(2);
    expect(oldRouteTask.amount).toBe(175);
    expect(routeTasks.some(task => task.id !== oldRouteTask.id && task.amount === 175)).toBe(true);

    // An incompatible current product is reliable evidence that the fresh
    // healthy direct replacement is truly stale. The expired predecessor stays
    // pending for ResourceControl to record the canonical timeout reason.
    const transitRoute = createAutomaticResourceTransferTask(
      INTEGRATION_SAT,
      INTEGRATION_HUB,
      RESOURCE_LEMERGIUM,
      80,
      `synthesis:hub-route:${RESOURCE_LEMERGIUM}`,
    );
    const staleOldHubRoute = createAutomaticResourceTransferTask(
      INTEGRATION_SAT,
      "W9N9",
      RESOURCE_LEMERGIUM,
      70,
      `synthesis:hub-route:${RESOURCE_LEMERGIUM}`,
    );
    const surplusRoute = createAutomaticResourceTransferTask(
      INTEGRATION_SAT,
      INTEGRATION_HUB,
      RESOURCE_KEANIUM,
      90,
      `synthesis:surplus:${RESOURCE_KEANIUM}`,
    );
    const staleOldHubSurplus = createAutomaticResourceTransferTask(
      INTEGRATION_SAT,
      "W9N9",
      RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
      65,
      `synthesis:surplus:${RESOURCE_CATALYZED_GHODIUM_ALKALIDE}`,
    );
    if (
      typeof transitRoute === "string" ||
      typeof staleOldHubRoute === "string" ||
      typeof surplusRoute === "string" ||
      typeof staleOldHubSurplus === "string"
    ) {
      throw new Error("failed_to_create_route_progress_regression_tasks");
    }
    wireRouteTransferTasks([], INTEGRATION_HUB, 1000, false, [{
      ...validPlan.dispatchAssignments[0],
      product: RESOURCE_ZYNTHIUM_KEANITE,
    }]);
    const freshReplacement = routeTasks.find(task => task.id !== oldRouteTask.id)!;
    expect(oldRouteTask.status).toBe("pending");
    expect(oldRouteTask.lastError).not.toBe("cancelled_by_replan");
    expect(freshReplacement).toMatchObject({
      status: "cancelled",
      lastError: "cancelled_by_replan",
    });
    expect(transitRoute.task).toMatchObject({ status: "pending", remainingAmount: 80 });
    expect(staleOldHubRoute.task).toMatchObject({
      status: "cancelled",
      lastError: "cancelled_by_replan",
    });
    expect(surplusRoute.task).toMatchObject({ status: "pending", remainingAmount: 90 });
    expect(staleOldHubSurplus.task).toMatchObject({
      status: "cancelled",
      lastError: "cancelled_by_replan",
    });

    // distributedStorage=true is reliable policy evidence that non-T3
    // satellite surplus must no longer be centralized through the Hub.
    wireRouteTransferTasks([], INTEGRATION_HUB, 1000, true, [{
      ...validPlan.dispatchAssignments[0],
      product: RESOURCE_ZYNTHIUM_KEANITE,
    }]);
    expect(transitRoute.task).toMatchObject({ status: "pending", remainingAmount: 80 });
    expect(surplusRoute.task).toMatchObject({
      status: "cancelled",
      lastError: "cancelled_by_replan",
    });

    // The defensive validator runs before config, allocation, route, or
    // protection facts are committed. Inject a malformed plan to keep this
    // path testable even though the planner now enforces the invariant.
    const duplicatePlan: DistributedSynthesisPlan = {
      dispatchAssignments: [
        { roomName: INTEGRATION_SAT, product: RESOURCE_HYDROXIDE, targetAmount: 100, isHubRoom: false },
        { roomName: INTEGRATION_SAT, product: RESOURCE_ZYNTHIUM_KEANITE, targetAmount: 100, isHubRoom: false },
      ],
      allocationLedger: {
        [RESOURCE_HYDROGEN]: {
          resource: RESOURCE_HYDROGEN,
          totalAmount: 999,
          roomCommitments: { [INTEGRATION_HUB]: 999 },
        },
      },
      routeDecisions: [{
        fromRoom: INTEGRATION_HUB,
        toRoom: INTEGRATION_SAT,
        resource: RESOURCE_OXYGEN,
        amount: 999,
        fee: 0,
      }],
      blockedTargets: [RESOURCE_CATALYZED_GHODIUM_ALKALIDE],
      missingResources: [RESOURCE_CATALYST],
    };
    Memory.runtime.synthesisControl!.rooms[INTEGRATION_SAT].stage = "idle";
    const configBeforeInvalidPlan = JSON.parse(JSON.stringify(Memory.cfg.synthesisControl));
    const tasksBeforeInvalidPlan = JSON.parse(JSON.stringify(ensureResourceTransferTaskStore()));
    expect(() => wireDistributedSynthesis(
      INTEGRATION_HUB,
      6,
      [RESOURCE_CATALYZED_GHODIUM_ALKALIDE],
      1000,
      1000,
      globalInventory,
      [],
      false,
      1000,
      undefined,
      {},
      duplicatePlan,
    )).toThrow("duplicate_room_assignment");
    expect(Memory.cfg.synthesisControl).toEqual(configBeforeInvalidPlan);
    expect(ensureResourceTransferTaskStore()).toEqual(tasksBeforeInvalidPlan);
    expect(Memory.runtime.hub!.distributedSynthesis).toMatchObject({
      dispatchAssignments: [],
      allocationLedger: {},
      routeDecisions: [],
      blockedTargets: [RESOURCE_CATALYZED_GHODIUM_ALKALIDE],
      invariantViolations: [
        `duplicate_room_assignment:${INTEGRATION_SAT}:${RESOURCE_HYDROXIDE},${RESOURCE_ZYNTHIUM_KEANITE}`,
      ],
      configReconcile: {
        revision: 6,
        refreshedRooms: [],
        clearedRooms: [],
        skippedBusyRooms: [],
        foreignOwnerRooms: [],
      },
    });

    // A current assignment cannot adopt another planner's room. This is a
    // commit-time guard as well as a planner eligibility filter.
    synthesisRooms[INTEGRATION_SAT].plannerOwnership = {
      owner: "anotherPlanner",
      hubRoomName: INTEGRATION_HUB,
      revision: 6,
    };
    const foreignConfigBefore = JSON.parse(JSON.stringify(Memory.cfg.synthesisControl));
    const foreignTasksBefore = JSON.parse(JSON.stringify(ensureResourceTransferTaskStore()));
    expect(() => wireDistributedSynthesis(
      INTEGRATION_HUB,
      7,
      [RESOURCE_CATALYZED_GHODIUM_ALKALIDE],
      1000,
      1000,
      globalInventory,
      [],
      false,
      1000,
      undefined,
      {},
      validPlan,
    )).toThrow(`foreign_owner_assignment:${INTEGRATION_SAT}`);
    expect(Memory.cfg.synthesisControl).toEqual(foreignConfigBefore);
    expect(ensureResourceTransferTaskStore()).toEqual(foreignTasksBefore);
    expect(Memory.runtime.hub!.distributedSynthesis).toMatchObject({
      dispatchAssignments: [],
      allocationLedger: {},
      routeDecisions: [],
      invariantViolations: [`foreign_owner_assignment:${INTEGRATION_SAT}`],
      configReconcile: {
        revision: 7,
        refreshedRooms: [],
        clearedRooms: [],
        skippedBusyRooms: [],
        foreignOwnerRooms: [],
      },
    });

    // Hub-only fallback must obey the same foreign-owner guard as distributed
    // assignments; it cannot silently adopt another planner's hub room.
    synthesisRooms[INTEGRATION_HUB] = {
      enabled: true,
      donorRoomNames: [],
      plannerOwnership: {
        owner: "anotherPlanner",
        hubRoomName: INTEGRATION_HUB,
        revision: 7,
      },
      reactions: [{
        product: RESOURCE_ZYNTHIUM_KEANITE,
        targetAmount: 100,
        batchSize: 100,
      }],
    };
    const fallbackConfigBefore = JSON.parse(JSON.stringify(Memory.cfg.synthesisControl));
    expect(() => writeSynthesisConfig(
      INTEGRATION_HUB,
      8,
      [{
        product: RESOURCE_HYDROXIDE,
        targetAmount: 100,
        reagents: [RESOURCE_HYDROGEN, RESOURCE_OXYGEN],
      }],
      globalInventory,
    )).toThrow(`foreign_owner_assignment:${INTEGRATION_HUB}`);
    expect(Memory.cfg.synthesisControl).toEqual(fallbackConfigBefore);
    const foreignHubNaturalPlan = planDistributedSynthesis(
      INTEGRATION_HUB,
      [RESOURCE_CATALYZED_GHODIUM_ALKALIDE],
      1000,
      1000,
      globalInventory,
    );
    expect(
      foreignHubNaturalPlan.dispatchAssignments.some(
        (assignment) => assignment.roomName === INTEGRATION_HUB,
      ),
    ).toBe(false);

    // Disabled Hub cleanup remains fail-closed but retries skipped busy rooms
    // on bounded cadence until the owned config is safe to reclaim.
    Memory.cfg = {
      hub: {
        enabled: false,
        hubRoomName: INTEGRATION_HUB,
        planInterval: 50,
      },
      synthesisControl: {
        enabled: true,
        rooms: {
          W8N1: {
            enabled: true,
            donorRoomNames: [],
            plannerOwnership: { owner: "hubPlanner", hubRoomName: INTEGRATION_HUB, revision: 7 },
            reactions: [{ product: RESOURCE_HYDROXIDE, targetAmount: 100, batchSize: 100 }],
          },
        },
      },
    } as any;
    Memory.runtime = {
      hub: getDefaultHubRuntime(),
      synthesisControl: {
        updatedAt: Game.time,
        generatedTaskCount: 0,
        failedTaskCount: 0,
        successfulRunCount: 0,
        lastActions: [],
        bindings: {},
        rooms: {
          W8N1: {
            stage: "loading",
            activeProduct: RESOURCE_HYDROXIDE,
            targetAmount: 100,
            batchSize: 100,
            reagentLabIds: [],
            productLabIds: [],
            successfulRuns: 0,
            pendingTasks: 0,
            lastTransitionAt: Game.time,
          },
        },
      },
    };
    Memory.data = {};
    Game.time = 1;
    runHubPlanner();
    const disabledBusyRuntime = Memory.runtime.hub!.distributedSynthesis as typeof distributedRuntime;
    expect(disabledBusyRuntime.configReconcile).toMatchObject({
      revision: 8,
      clearedRooms: [],
      skippedBusyRooms: ["W8N1"],
    });
    expect(Memory.runtime.hub!.committedProtectionSnapshot?.valid).toBe(false);

    Memory.runtime.synthesisControl!.rooms.W8N1.stage = "idle";
    Game.time = 50 + cadenceOffset("hubPlanner.cleanup", 50);
    runHubPlanner();
    const disabledIdleRuntime = Memory.runtime.hub!.distributedSynthesis as typeof distributedRuntime;
    expect(disabledIdleRuntime.configReconcile).toMatchObject({
      revision: 9,
      clearedRooms: ["W8N1"],
      skippedBusyRooms: [],
    });
    expect((Memory.cfg.synthesisControl!.rooms!.W8N1 as any).plannerOwnership).toBeUndefined();
    expect(Memory.cfg.synthesisControl!.rooms!.W8N1.reactions).toEqual([]);
    expect(Memory.runtime.hub!.committedProtectionSnapshot?.valid).toBe(false);
  });
});
