import {
  clearCarrierTaskBoardForTest,
  getCarrierTasksByRoom,
  peekCarrierTaskBoard,
  replaceCarrierTasksForProducerRoom,
} from "@/runtime/carrierTaskBoard";
import {
  createAutomaticResourceTransferTask,
  ensureResourceTransferTaskStore,
  getResourceTransferTaskListSorted,
  markResourceTransferTaskBlocked,
} from "@/runtime/logistics/resourceTransferTasks";
import {
  SYNTHESIS_ROOM_LOGISTICS_PRODUCER,
  peekLogisticsControlStore,
  replaceLatestLogisticsDemandsForProducer,
} from "@/runtime/logistics/logisticsControl";
import {
  runSynthesisLogisticsShadow,
  SYNTHESIS_SHADOW_MAX_TRANSACTION_COST_EVALUATIONS_PER_CANDIDATE,
  type SynthesisShadowContinuation,
  type SynthesisShadowLegacyDecisionObservation,
  type SynthesisShadowMatcherInput,
  type SynthesisShadowMatcherResult,
  type SynthesisShadowRoomFact,
} from "@/runtime/logistics/synthesisLogisticsShadow";
import { measureLogisticsShadowCpu } from "@/runtime/logistics/logisticsShadowCpu";
import {
  claimLocalCarrierDestinationCapacity,
  clearLocalCarrierDestinationCapacityForTest,
  getLocalCarrierDestinationCapacityObservation,
} from "@/runtime/localCarrierDestinationCapacity";
import {
  releaseProductionReservation,
  reserveProductionResource,
} from "@/runtime/resourceReservation";
import {
  clearMarketActionArbiterForTest,
  getMarketAccountClaim,
  getMarketActionJournal,
  getTerminalActionClaims,
} from "@/runtime/marketActionArbiter";
import {
  beginSynthesisShadowEpochCapture,
  collectResourceControlSnapshots,
  runResourceControl,
} from "@/runtime/resourceControl";

type RuntimeGlobal = typeof global & { __runtimeServices?: unknown };
type MutableStore = StoreDefinition & { set(resource: ResourceConstant, amount: number): void };
type GameWithPartialMarket = Omit<Game, "market"> & { market: Partial<Market> };

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createMutableStore(
  capacity: number,
  initial: Partial<Record<ResourceConstant, number>>,
): MutableStore {
  const amounts: Partial<Record<ResourceConstant, number>> = { ...initial };
  const store = {
    ...initial,
    getUsedCapacity(resource?: ResourceConstant): number {
      if (resource) return amounts[resource] || 0;
      return Object.values(amounts).reduce((sum, amount) => sum + (amount || 0), 0);
    },
    getFreeCapacity(): number {
      return Math.max(0, capacity - this.getUsedCapacity());
    },
    getCapacity(): number {
      return capacity;
    },
    set(resource: ResourceConstant, amount: number): void {
      const normalized = Math.max(0, Math.floor(amount));
      amounts[resource] = normalized;
      (store as unknown as Record<string, unknown>)[resource] = normalized;
    },
  } as unknown as MutableStore;
  return store;
}

function createMutableRoom(
  name: string,
  storageInitial: Partial<Record<ResourceConstant, number>>,
  terminalInitial: Partial<Record<ResourceConstant, number>>,
): Room {
  const storageStore = createMutableStore(1_000_000, storageInitial);
  const terminalStore = createMutableStore(300_000, terminalInitial);
  const terminal = {
    id: `${name}-terminal`,
    structureType: STRUCTURE_TERMINAL,
    cooldown: 0,
    store: terminalStore,
    send: jest.fn((resource: ResourceConstant, amount: number, toRoomName: string) => {
      const receiver = Game.rooms[toRoomName]?.terminal;
      if (!receiver) return ERR_INVALID_TARGET;
      const transactionCost = Game.market.calcTransactionCost(amount, name, toRoomName);
      const requiredEnergy = transactionCost + (resource === RESOURCE_ENERGY ? amount : 0);
      if (terminalStore.getUsedCapacity(resource) < amount) return ERR_NOT_ENOUGH_RESOURCES;
      if (terminalStore.getUsedCapacity(RESOURCE_ENERGY) < requiredEnergy) {
        return ERR_NOT_ENOUGH_RESOURCES;
      }
      if (receiver.store.getFreeCapacity() < amount) return ERR_FULL;

      if (resource === RESOURCE_ENERGY) {
        terminalStore.set(
          RESOURCE_ENERGY,
          terminalStore.getUsedCapacity(RESOURCE_ENERGY) - requiredEnergy,
        );
      } else {
        terminalStore.set(resource, terminalStore.getUsedCapacity(resource) - amount);
        terminalStore.set(
          RESOURCE_ENERGY,
          terminalStore.getUsedCapacity(RESOURCE_ENERGY) - transactionCost,
        );
      }
      const receiverStore = receiver.store as unknown as MutableStore;
      receiverStore.set(resource, receiverStore.getUsedCapacity(resource) + amount);
      return OK;
    }),
  } as unknown as StructureTerminal;

  const room = {
    name,
    controller: { my: true, level: 8 } as StructureController,
    storage: {
      id: `${name}-storage`,
      structureType: STRUCTURE_STORAGE,
      store: storageStore,
    } as unknown as StructureStorage,
    terminal,
    find(type: FindConstant) {
      if (type === FIND_MINERALS || type === FIND_STRUCTURES || type === FIND_MY_STRUCTURES) return [];
      return [];
    },
  } as unknown as Room;
  (terminal as StructureTerminal & { room: Room }).room = room;
  return room;
}

function executeTerminalOffloadTasks(room: Room): number {
  const terminalStore = room.terminal!.store as unknown as MutableStore;
  const storageStore = room.storage!.store as unknown as MutableStore;
  let moved = 0;
  for (const task of Object.values(getCarrierTasksByRoom(room.name))) {
    if (task.type !== "terminal_offload") continue;
    for (const step of task.steps) {
      if (step.fromKind !== "terminal" || step.toKind !== "storage") continue;
      const amount = Math.min(step.amount, terminalStore.getUsedCapacity(step.resource));
      terminalStore.set(step.resource, terminalStore.getUsedCapacity(step.resource) - amount);
      storageStore.set(step.resource, storageStore.getUsedCapacity(step.resource) + amount);
      moved += amount;
    }
  }
  return moved;
}

function executeTerminalFeedTasks(room: Room): number {
  const terminalStore = room.terminal!.store as unknown as MutableStore;
  const storageStore = room.storage!.store as unknown as MutableStore;
  let moved = 0;
  for (const task of Object.values(getCarrierTasksByRoom(room.name))) {
    if (task.type !== "terminal_feed") continue;
    for (const step of task.steps) {
      if (step.fromKind !== "storage" || step.toKind !== "terminal") continue;
      const amount = Math.min(
        step.amount,
        storageStore.getUsedCapacity(step.resource),
        terminalStore.getFreeCapacity(),
      );
      storageStore.set(step.resource, storageStore.getUsedCapacity(step.resource) - amount);
      terminalStore.set(step.resource, terminalStore.getUsedCapacity(step.resource) + amount);
      moved += amount;
    }
  }
  return moved;
}

function createShadowMatcherRoom(
  roomName: string,
  resources: Array<{
    resource: ResourceConstant;
    sourceAvailableAmount: number;
    sourceTerminalAmount: number;
    receiverResourceHeadroom: number;
  }>,
  options: {
    receiverHeadroom?: number;
    actionEnergyBudget?: number;
    terminalActionEnergyAmount?: number;
  } = {},
): SynthesisShadowRoomFact {
  const receiverHeadroom = options.receiverHeadroom ?? 100;
  const actionEnergyBudget = options.actionEnergyBudget ?? 1_000;
  return {
    roomName,
    epochRevision: "capacity-regression:epoch",
    epochFingerprint: "capacity-regression:fingerprint",
    revision: `${roomName}:1`,
    observedAt: 100,
    expiresAt: 200,
    owned: true,
    hasStorage: true,
    hasTerminal: true,
    terminalReachable: true,
    terminalReadyAt: 100,
    transferBatchSize: 100,
    capacityState: "normal",
    receiverEligible: true,
    receiverStorageHeadroom: receiverHeadroom,
    receiverTerminalHeadroom: receiverHeadroom,
    terminalStagingFreeCapacity: 1_000,
    actionEnergyBudget,
    terminalActionEnergyAmount:
      options.terminalActionEnergyAmount ?? actionEnergyBudget,
    resources,
  };
}

function runPagedShadowMatcher(
  input: SynthesisShadowMatcherInput,
  candidateBudget: number,
): SynthesisShadowMatcherResult {
  let continuation: SynthesisShadowContinuation | undefined;
  let result: SynthesisShadowMatcherResult | undefined;
  for (let iteration = 0; iteration < 30; iteration += 1) {
    result = runSynthesisLogisticsShadow({
      ...input,
      candidateBudget,
      ...(continuation ? { continuation } : {}),
    });
    if (result.complete) return result;
    continuation = result.continuation;
    if (!continuation) break;
  }
  throw new Error("shadow matcher continuation did not complete");
}

function captureShadowAuthorityBoundaryState(rooms: readonly Room[]): unknown {
  const memory = JSON.parse(JSON.stringify(Memory)) as {
    data?: { resourceControl?: { logistics?: unknown } };
    runtime?: { resourceControl?: { logistics?: unknown } };
  };
  if (memory.data?.resourceControl) {
    delete memory.data.resourceControl.logistics;
  }
  if (memory.runtime?.resourceControl) {
    delete memory.runtime.resourceControl.logistics;
  }
  return {
    resourceTasks: getResourceTransferTaskListSorted().map((task) => ({
      ...task,
    })),
    carrierBoard: peekCarrierTaskBoard(),
    arbiterClaims: getTerminalActionClaims(),
    marketAccountClaim: getMarketAccountClaim(),
    arbiterJournal: getMarketActionJournal(),
    receiverReservations: rooms.flatMap((room) =>
      [room.storage, room.terminal]
        .filter((structure): structure is StructureStorage | StructureTerminal =>
          !!structure,
        )
        .map((structure) =>
          getLocalCarrierDestinationCapacityObservation(
            room.name,
            structure.id,
          ),
        ),
    ),
    structures: rooms.map((room) => ({
      roomName: room.name,
      terminalCooldown: room.terminal?.cooldown,
      storageTotal: room.storage?.store.getUsedCapacity() || 0,
      terminalTotal: room.terminal?.store.getUsedCapacity() || 0,
      resources: RESOURCES_ALL.map((resource) => ({
        resource,
        storage: room.storage?.store.getUsedCapacity(resource) || 0,
        terminal: room.terminal?.store.getUsedCapacity(resource) || 0,
      })).filter((entry) => entry.storage > 0 || entry.terminal > 0),
    })),
    terminalSendCalls: rooms.reduce(
      (count, room) =>
        count + ((room.terminal?.send as jest.Mock | undefined)?.mock.calls.length || 0),
      0,
    ),
    marketDealCalls: (Game.market.deal as jest.Mock).mock.calls.length,
    memory,
  };
}

function runResourceControlAuthorityTwin(
  mode: "disabled" | "shadow",
): unknown {
  clearCarrierTaskBoardForTest();
  clearMarketActionArbiterForTest();
  clearLocalCarrierDestinationCapacityForTest();
  resetRuntimeServices();
  Memory.cfg = {
    resourceControl: {
      sampleInterval: 10,
      taskMaxPerRun: 5,
      market: { enabled: false },
    },
  };
  (Memory.cfg.resourceControl as unknown as {
    logistics: {
      schemaVersion: 1;
      mode: "disabled" | "shadow";
      canaryScopes: [];
    };
  }).logistics = {
    schemaVersion: 1,
    mode,
    canaryScopes: [],
  };
  Memory.data = undefined;
  Memory.runtime = undefined;
  Memory.rooms = {};
  Game.time = 100;
  const room = createMutableRoom(
    "W84N1",
    { [RESOURCE_ENERGY]: 200_000, [RESOURCE_HYDROGEN]: 10_000 },
    { [RESOURCE_ENERGY]: 20_000 },
  );
  Game.rooms = { [room.name]: room };
  (Game.market.calcTransactionCost as jest.Mock).mockClear();
  (Game.market.calcTransactionCost as jest.Mock).mockReturnValue(0);
  (Game.market.getAllOrders as jest.Mock).mockClear();
  (Game.market.getAllOrders as jest.Mock).mockReturnValue([]);
  (Game.market.deal as jest.Mock).mockClear();
  (Game.market.deal as jest.Mock).mockReturnValue(OK);

  if (mode === "shadow") {
    const capture = beginSynthesisShadowEpochCapture([RESOURCE_HYDROGEN]);
    if (capture.ok === false) throw new Error(capture.reason);
    const facts = capture.buildRoomFacts([RESOURCE_HYDROGEN]);
    if (facts.ok === false) throw new Error(facts.reason);
    const demandKey = JSON.stringify([
      "synthesis_room/v1",
      room.name,
      RESOURCE_HYDROXIDE,
      RESOURCE_HYDROGEN,
    ]);
    expect(replaceLatestLogisticsDemandsForProducer(
      SYNTHESIS_ROOM_LOGISTICS_PRODUCER,
      [{
        demandKey,
        origin: "synthesis_room",
        targetRoomName: room.name,
        resource: RESOURCE_HYDROGEN,
        product: RESOURCE_HYDROXIDE,
        desiredAmount: 100,
        priorityClass: "production",
        minBatch: 1,
        maxBatch: 100,
        ttl: 30,
      }],
      [{
        demandKey,
        decisionOrder: 0,
        inputFingerprint: "capacity-regression:twin:v1",
        // producer-local 来自同一 prewrite atomic snapshot；不得伪造为 desired。
        localAmount: 10_000,
        incomingAmount: 0,
        uncoveredAmount: 0,
        comparableReason: "comparable",
        legacyDecision: "no_op",
        legacyPriorityRank: 2,
        legacyPriorityClass: "production",
        legacyAmount: 0,
        legacyAddedAmount: 0,
        legacyRemainingBefore: 0,
        legacyFeeDelta: 0,
      }],
      {
        totalCount: 1,
        overflowCount: 0,
        ttl: facts.expiresAt - facts.observedAt,
        epochRevision: facts.epochRevision,
        epochFingerprint: facts.epochFingerprint,
        captureCpuUsed: facts.captureCpuUsed,
        indexBuildCount: facts.indexBuildCount,
        roomFacts: facts.roomFacts,
      },
    )).toEqual(expect.objectContaining({ ok: true }));
  }

  resetRuntimeServices();
  runResourceControl();
  // mode 是唯一实验输入；比较前归一回同一 cfg，保留其余 Memory 原样。
  (Memory.cfg.resourceControl as unknown as {
    logistics: { mode: "shadow" };
  }).logistics.mode = "shadow";
  return captureShadowAuthorityBoundaryState([room]);
}

describe("resource control live-like capacity recovery", () => {
  beforeEach(() => {
    clearCarrierTaskBoardForTest();
    resetRuntimeServices();
    Memory.cfg = {
      resourceControl: {
        sampleInterval: 10,
        taskMaxPerRun: 5,
        market: { enabled: false },
      },
    };
    Memory.data = undefined;
    Memory.runtime = undefined;
    Memory.rooms = {};
    Game.rooms = {};
    (Game as unknown as { cpu: { getUsed(): number } }).cpu = {
      getUsed: jest.fn(() => 0),
    };
    (Game as GameWithPartialMarket).market = {
      calcTransactionCost: jest.fn(() => 0),
      getAllOrders: jest.fn(() => []),
      deal: jest.fn(() => OK),
    };
  });

  function createOutgoingEnergyReliefScenario() {
    const pressureRoom = createMutableRoom(
      "E3N59",
      { [RESOURCE_ENERGY]: 191_141, [RESOURCE_HYDROGEN]: 660_000 },
      { [RESOURCE_ENERGY]: 18_531 },
    );
    const donor = createMutableRoom(
      "E4N58",
      { [RESOURCE_ENERGY]: 400_000 },
      { [RESOURCE_ENERGY]: 100_000, [RESOURCE_UTRIUM_HYDRIDE]: 10_000 },
    );
    const synthesisReceiver = createMutableRoom(
      "E1N57",
      { [RESOURCE_ENERGY]: 200_000 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    for (const room of [pressureRoom, donor, synthesisReceiver]) {
      Game.rooms[room.name] = room;
    }
    // Storage 尚未达到恢复水位；承接已有 relief，而不是本轮新规划责任。
    Memory.runtime = {
      resourceControl: {
        updatedAt: 0,
        rooms: { [pressureRoom.name]: { capacityState: "pressure" } },
        lastActions: [],
        lastMarketActions: [],
      },
    } as any;
    Game.time = 1;
    const relief = createAutomaticResourceTransferTask(
      pressureRoom.name,
      donor.name,
      RESOURCE_ENERGY,
      30_000,
      `capacity:relief:${RESOURCE_ENERGY}`,
    );
    const synthesis = createAutomaticResourceTransferTask(
      donor.name,
      synthesisReceiver.name,
      RESOURCE_UTRIUM_HYDRIDE,
      10_000,
      `synthesis:${synthesisReceiver.name}:${RESOURCE_UTRIUM_ACID}`,
    );
    if (typeof relief === "string") throw new Error(relief);
    if (typeof synthesis === "string") throw new Error(synthesis);
    Game.time = 10;
    return { pressureRoom, donor, synthesisReceiver, relief: relief.task, synthesis: synthesis.task };
  }

  it("does not reverse-feed a healthy outgoing Energy relief room and keeps the donor UH send window executable", () => {
    const { pressureRoom, donor, synthesisReceiver, relief, synthesis } =
      createOutgoingEnergyReliefScenario();

    runResourceControl();

    expect(Memory.runtime?.resourceControl?.rooms[pressureRoom.name]?.capacityState).toBe("pressure");
    expect(Memory.runtime?.resourceControl?.lastActions).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^send:E4N58->E3N59:energy=/)]),
    );
    expect(donor.terminal!.send).toHaveBeenCalledWith(
      RESOURCE_UTRIUM_HYDRIDE, 10_000, synthesisReceiver.name, expect.anything(),
    );
    expect(pressureRoom.terminal!.send).toHaveBeenCalledWith(
      RESOURCE_ENERGY, 10_000, donor.name, expect.anything(),
    );
    expect(relief.remainingAmount).toBe(20_000);
    expect(synthesis).toMatchObject({ status: "done", remainingAmount: 0 });
    expect(donor.terminal!.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["source-depleted", (task: ReturnType<typeof createOutgoingEnergyReliefScenario>["relief"]) => {
      task.blockedReason = "source_depleted";
      task.blockedSince = 9;
    }],
    ["receiver-capacity", (task: ReturnType<typeof createOutgoingEnergyReliefScenario>["relief"]) => {
      task.blockedReason = "receiver_capacity";
      task.blockedSince = 9;
    }],
    ["expired", (task: ReturnType<typeof createOutgoingEnergyReliefScenario>["relief"]) => {
      task.lastProgressAt = 0;
      Game.time = 5_010;
    }],
    ["done", (task: ReturnType<typeof createOutgoingEnergyReliefScenario>["relief"]) => {
      task.status = "done";
      task.remainingAmount = 0;
    }],
    ["cancelled", (task: ReturnType<typeof createOutgoingEnergyReliefScenario>["relief"]) => {
      task.status = "cancelled";
    }],
    ["failed", (task: ReturnType<typeof createOutgoingEnergyReliefScenario>["relief"]) => {
      task.status = "failed";
    }],
    ["empty-pending", (task: ReturnType<typeof createOutgoingEnergyReliefScenario>["relief"]) => {
      task.remainingAmount = 0;
    }],
    ["missing-target-room", (task: ReturnType<typeof createOutgoingEnergyReliefScenario>["relief"]) => {
      task.toRoomName = "E9N59";
    }],
    ["ordinary-energy-transfer", (task: ReturnType<typeof createOutgoingEnergyReliefScenario>["relief"]) => {
      task.reason = "energy-support";
    }],
    ["non-energy-relief", (task: ReturnType<typeof createOutgoingEnergyReliefScenario>["relief"]) => {
      task.resource = RESOURCE_HYDROGEN;
      task.reason = `capacity:relief:${RESOURCE_HYDROGEN}`;
    }],
  ] as const)("keeps ordinary Energy balancing available for %s outgoing relief responsibility", (_label, mutate) => {
    const { donor, relief } = createOutgoingEnergyReliefScenario();
    mutate(relief);

    runResourceControl();

    expect(Memory.runtime?.resourceControl?.lastActions).toEqual(
      expect.arrayContaining([expect.stringMatching(/^send:E4N58->E3N59:energy=/)]),
    );
    expect(donor.terminal!.send).toHaveBeenCalledWith(
      RESOURCE_ENERGY, 8_859, "E3N59", expect.anything(),
    );
  });

  it("recovers a sticky 50000-free terminal through real carrier moves without next-cycle jitter", () => {
    const room = createMutableRoom(
      "W82N1",
      { [RESOURCE_ENERGY]: 200_000 },
      { [RESOURCE_ENERGY]: 25_000, [RESOURCE_HYDROGEN]: 225_000 },
    );
    Game.rooms[room.name] = room;
    (Memory.cfg!.resourceControl as any).capacityBalancing = {
      terminalHeadroomRecoveryEnabled: true,
    };
    Memory.runtime = {
      resourceControl: {
        updatedAt: 0,
        rooms: { [room.name]: { capacityState: "pressure" } },
        lastActions: [],
        lastMarketActions: [],
      },
    } as any;

    let originalCreatedAt: number | undefined;
    for (const [index, expectedFreeCapacity] of [60_000, 70_000, 80_000].entries()) {
      Game.time = 10 + index * 10;
      resetRuntimeServices();
      runResourceControl();

      expect(Memory.runtime?.resourceControl?.rooms[room.name]?.capacityState).toBe("pressure");
      const tasks = getCarrierTasksByRoom(room.name);
      const offload = tasks[`resourceControl:terminal_offload:${room.name}:${RESOURCE_HYDROGEN}`];
      expect(offload).toMatchObject({
        type: "terminal_offload",
        steps: [{ resource: RESOURCE_HYDROGEN, amount: 10_000 }],
      });
      expect(Object.values(tasks).filter((task) => task.type === "terminal_feed")).toHaveLength(0);
      originalCreatedAt = originalCreatedAt ?? offload.createdAt;
      expect(offload.createdAt).toBe(originalCreatedAt);
      expect(executeTerminalOffloadTasks(room)).toBe(10_000);
      expect(room.terminal!.store.getFreeCapacity()).toBe(expectedFreeCapacity);
    }

    Game.time = 40;
    resetRuntimeServices();
    runResourceControl();
    expect(Memory.runtime?.resourceControl?.rooms[room.name]?.capacityState).toBe("normal");
    expect(getCarrierTasksByRoom(room.name)).toEqual({});

    Game.time = 50;
    resetRuntimeServices();
    runResourceControl();
    expect(room.terminal!.store.getFreeCapacity()).toBe(80_000);
    expect(Memory.runtime?.resourceControl?.rooms[room.name]?.capacityState).toBe("normal");
    expect(getCarrierTasksByRoom(room.name)).toEqual({});

    (Memory.runtime!.resourceControl as unknown as { logistics: unknown }).logistics = {
      available: true,
      complete: true,
      requestedMode: "shadow",
      updatedAt: 50,
      expiresAt: 999,
    };
    (Memory.cfg!.resourceControl as unknown as {
      logistics: { schemaVersion: 1; mode: "canary"; canaryScopes: [] };
    }).logistics = {
      schemaVersion: 1,
      mode: "canary",
      canaryScopes: [],
    };
    Game.time = 51;
    resetRuntimeServices();
    runResourceControl();
    expect((Memory.runtime!.resourceControl as unknown as {
      logistics: {
        available: boolean;
        blocker: string;
        requestedMode: string;
        updatedAt: number;
      };
    }).logistics).toEqual(expect.objectContaining({
      available: false,
      blocker: "matcher_unavailable",
      requestedMode: "canary",
      updatedAt: 51,
    }));

    (Memory.runtime!.resourceControl as unknown as { logistics: unknown }).logistics = {
      available: true,
      complete: true,
      requestedMode: "shadow",
      updatedAt: 51,
      expiresAt: 999,
    };
    Memory.cfg!.resourceControl!.enabled = false;
    Game.time = 52;
    const disabledSendCalls = (room.terminal!.send as jest.Mock).mock.calls.length;
    const disabledDealCalls = (Game.market.deal as jest.Mock).mock.calls.length;
    resetRuntimeServices();
    runResourceControl();
    expect((room.terminal!.send as jest.Mock).mock.calls).toHaveLength(
      disabledSendCalls,
    );
    expect((Game.market.deal as jest.Mock).mock.calls).toHaveLength(
      disabledDealCalls,
    );
    expect((Memory.runtime!.resourceControl as unknown as {
      logistics: { available: boolean; blocker: string; updatedAt: number; expiresAt: number };
    }).logistics).toEqual(expect.objectContaining({
      available: false,
      blocker: "mode_disabled",
      updatedAt: 52,
      expiresAt: 72,
    }));

    Memory.cfg!.resourceControl!.enabled = true;
    Game.rooms = {};
    Game.time = 60;
    resetRuntimeServices();
    runResourceControl();
    expect((Memory.runtime!.resourceControl as unknown as {
      logistics: { available: boolean; blocker: string; updatedAt: number; expiresAt: number };
    }).logistics).toEqual(expect.objectContaining({
      available: false,
      blocker: "input_unavailable",
      updatedAt: 60,
      expiresAt: 80,
    }));

    Memory.runtime = undefined;
    Game.time = 70;
    resetRuntimeServices();
    runResourceControl();
    expect((Memory.runtime!.resourceControl as unknown as {
      logistics: { available: boolean; blocker: string; updatedAt: number };
    }).logistics).toEqual(expect.objectContaining({
      available: false,
      blocker: "input_unavailable",
      updatedAt: 70,
    }));

    const reservationRoom = createMutableRoom(
      "W83N1",
      {
        [RESOURCE_ENERGY]: 200_000,
        [RESOURCE_HYDROGEN]: 10_000,
        [RESOURCE_UTRIUM]: 10_000,
      },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    Game.rooms = { [reservationRoom.name]: reservationRoom };
    (Memory.cfg!.resourceControl as unknown as {
      logistics: { schemaVersion: 1; mode: "shadow"; canaryScopes: [] };
    }).logistics = {
      schemaVersion: 1,
      mode: "shadow",
      canaryScopes: [],
    };
    Game.time = 80;
    resetRuntimeServices();
    const baselineCapture = beginSynthesisShadowEpochCapture([
      RESOURCE_HYDROGEN,
      RESOURCE_UTRIUM,
    ]);
    if (baselineCapture.ok === false) throw new Error(baselineCapture.reason);
    const baselineFacts = baselineCapture.buildRoomFacts([
      RESOURCE_HYDROGEN,
      RESOURCE_UTRIUM,
    ]);
    if (baselineFacts.ok === false) throw new Error(baselineFacts.reason);
    const baselineRoomFact = baselineFacts.roomFacts.find(
      (fact) => fact.roomName === reservationRoom.name,
    )!;
    const baselineHydrogenAvailable = baselineRoomFact.resources.find(
      (entry) => entry.resource === RESOURCE_HYDROGEN,
    )!.sourceAvailableAmount;
    expect(baselineHydrogenAvailable).toBeGreaterThan(0);
    reserveProductionResource(
      reservationRoom.name,
      RESOURCE_HYDROGEN,
      1_000,
      "capacity-regression:shadow-capture",
    );
    replaceCarrierTasksForProducerRoom(
      "capacity-regression:shadow-capture",
      reservationRoom.name,
      [{
        id: "production-commitment",
        type: "lab_supply",
        priority: 100,
        steps: [{
          id: "hydrogen-to-lab",
          resource: RESOURCE_HYDROGEN,
          amount: 2_000,
          fromKind: "storage",
          toKind: "lab",
          fromId: reservationRoom.storage!.id,
          toId: "capacity-regression-lab" as Id<StructureLab>,
        }],
      }],
    );
    const committedCapture = beginSynthesisShadowEpochCapture([
      RESOURCE_HYDROGEN,
      RESOURCE_UTRIUM,
    ]);
    if (committedCapture.ok === false) throw new Error(committedCapture.reason);
    const committedFacts = committedCapture.buildRoomFacts([
      RESOURCE_HYDROGEN,
      RESOURCE_UTRIUM,
    ]);
    if (committedFacts.ok === false) throw new Error(committedFacts.reason);
    expect(committedFacts.roomFacts.find(
      (fact) => fact.roomName === reservationRoom.name,
    )!.resources.find(
      (entry) => entry.resource === RESOURCE_HYDROGEN,
    )!.sourceAvailableAmount).toBe(baselineHydrogenAvailable - 3_000);
    releaseProductionReservation(
      reservationRoom.name,
      RESOURCE_HYDROGEN,
      "capacity-regression:shadow-capture",
    );
    replaceCarrierTasksForProducerRoom(
      "capacity-regression:shadow-capture",
      reservationRoom.name,
      [],
    );
    const logisticsBeforeInvalidCapture = JSON.stringify(
      (Memory.data?.resourceControl as unknown as { logistics?: unknown })
        ?.logistics,
    );

    (Memory.runtime as unknown as {
      resourceReservations: Record<string, unknown>;
    }).resourceReservations = {
      fractional: {
        roomName: reservationRoom.name,
        resource: RESOURCE_HYDROGEN,
        holderId: "fractional",
        amount: 0.5,
        updatedAt: Game.time,
        expiresAt: Game.time + 10,
      },
      invalid: {
        roomName: reservationRoom.name,
        resource: RESOURCE_UTRIUM,
        holderId: "invalid",
        amount: Number.NaN,
        updatedAt: Game.time,
        expiresAt: Game.time + 10,
      },
    };
    const indexedCapture = beginSynthesisShadowEpochCapture([
      RESOURCE_HYDROGEN,
      RESOURCE_UTRIUM,
    ]);
    expect(indexedCapture).toEqual({
      ok: false,
      reason: "invalid_resources",
    });
    expect(JSON.stringify(
      (Memory.data?.resourceControl as unknown as { logistics?: unknown })
        ?.logistics,
    )).toBe(logisticsBeforeInvalidCapture);
    (Memory.runtime as unknown as {
      resourceReservations: Record<string, unknown>;
    }).resourceReservations = {};

    const taskStore = ensureResourceTransferTaskStore();
    const malformedTaskBase = {
      id: "capacity-regression:malformed-task",
      resource: RESOURCE_HYDROGEN,
      fromRoomName: reservationRoom.name,
      toRoomName: "W84N1",
      amount: 100,
      remainingAmount: 100,
      status: "pending" as const,
      createdAt: Game.time,
      updatedAt: Game.time,
      origin: "automatic" as const,
      lastProgressAt: Game.time,
      reason: "synthesis:W84N1:OH",
    };
    taskStore["malformed-a"] = { ...malformedTaskBase };
    taskStore["malformed-b"] = { ...malformedTaskBase };
    expect(beginSynthesisShadowEpochCapture([
      RESOURCE_HYDROGEN,
    ])).toEqual({ ok: false, reason: "invalid_resources" });
    delete taskStore["malformed-b"];
    taskStore["malformed-a"].remainingAmount = Number.NaN;
    expect(beginSynthesisShadowEpochCapture([
      RESOURCE_HYDROGEN,
    ])).toEqual({ ok: false, reason: "invalid_resources" });
    taskStore["malformed-a"].remainingAmount = 100;
    const transactionCostMock = Game.market.calcTransactionCost as jest.Mock;
    const previousTransactionCostImplementation =
      transactionCostMock.getMockImplementation();
    transactionCostMock.mockImplementation(() => Number.NaN);
    expect(beginSynthesisShadowEpochCapture([
      RESOURCE_HYDROGEN,
    ])).toEqual({ ok: false, reason: "invalid_resources" });
    if (previousTransactionCostImplementation) {
      transactionCostMock.mockImplementation(
        previousTransactionCostImplementation,
      );
    } else {
      transactionCostMock.mockRestore();
    }
    delete taskStore["malformed-a"];

    replaceCarrierTasksForProducerRoom(
      "capacity-regression:malformed-carrier",
      reservationRoom.name,
      [{
        id: "malformed-production-commitment",
        type: "factory_supply",
        priority: 100,
        steps: [{
          id: "malformed-step",
          resource: RESOURCE_HYDROGEN,
          amount: 100,
          fromKind: "terminal",
          toKind: "factory",
          fromId: reservationRoom.terminal!.id,
          toId: "capacity-regression-factory" as Id<StructureFactory>,
        }],
      }],
    );
    const malformedCarrierTask = Object.values(
      getCarrierTasksByRoom(reservationRoom.name),
    ).find((task) => task.id === "malformed-production-commitment")!;
    (malformedCarrierTask.steps[0] as { amount: number }).amount = Number.NaN;
    expect(beginSynthesisShadowEpochCapture([
      RESOURCE_HYDROGEN,
    ])).toEqual({ ok: false, reason: "invalid_resources" });
    replaceCarrierTasksForProducerRoom(
      "capacity-regression:malformed-carrier",
      reservationRoom.name,
      [],
    );

    const disabledTwin = runResourceControlAuthorityTwin("disabled");
    const shadowTwin = runResourceControlAuthorityTwin("shadow");
    expect(shadowTwin).toEqual(disabledTwin);
  });

  it("bootstraps the full capacity-relief fee while retaining coverage-expiry observability", () => {
    const source = createMutableRoom(
      "E3N59",
      { [RESOURCE_ENERGY]: 146_000, [RESOURCE_HYDROGEN]: 854_000 },
      { [RESOURCE_ZYNTHIUM]: 195_000, [RESOURCE_KEANIUM]: 100_000 },
    );
    const receiver = createMutableRoom(
      "E4N58",
      { [RESOURCE_ENERGY]: 200_000 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    const shadowReceiver = createMutableRoom(
      "E5N58",
      { [RESOURCE_ENERGY]: 200_000 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    Game.rooms[source.name] = source;
    Game.rooms[receiver.name] = receiver;
    Game.rooms[shadowReceiver.name] = shadowReceiver;
    Memory.cfg!.resourceControl!.capacityBalancing = {
      terminalHeadroomRecoveryEnabled: true,
    };
    (Memory.cfg!.resourceControl as unknown as {
      logistics: { schemaVersion: 1; mode: "shadow"; canaryScopes: [] };
    }).logistics = {
      schemaVersion: 1,
      mode: "shadow",
      canaryScopes: [],
    };
    (Game.market.calcTransactionCost as jest.Mock).mockReturnValue(2_000);

    Game.time = 1;
    const created = createAutomaticResourceTransferTask(
      source.name,
      receiver.name,
      RESOURCE_ZYNTHIUM,
      2_500,
      `capacity:relief:${RESOURCE_ZYNTHIUM}`,
    );
    if (typeof created === "string") throw new Error(created);

    const expired = createAutomaticResourceTransferTask(
      source.name,
      receiver.name,
      RESOURCE_OXYGEN,
      100,
      `synthesis:${receiver.name}:${RESOURCE_HYDROXIDE}`,
    );
    if (typeof expired === "string") throw new Error(expired);
    markResourceTransferTaskBlocked(expired.task, "receiver_capacity");

    Game.time = 509;
    const saturatedFeeTask = createAutomaticResourceTransferTask(
      source.name,
      shadowReceiver.name,
      RESOURCE_KEANIUM,
      10_000,
      `synthesis:${shadowReceiver.name}:${RESOURCE_HYDROXIDE}`,
    );
    if (typeof saturatedFeeTask === "string") throw new Error(saturatedFeeTask);
    Game.time = 510;
    Memory.data = Memory.data || {};
    (Memory.data as unknown as {
      marketSaleAutomation: unknown;
    }).marketSaleAutomation = {
      managedOrders: {
        exposed: {
          roomName: source.name,
          resourceType: RESOURCE_KEANIUM,
          remainingExposure: 100_000,
        },
      },
    };
    const localTerminalClaim = claimLocalCarrierDestinationCapacity({
      claimantId: "capacity-regression:terminal-inflight",
      target: shadowReceiver.terminal!,
      resource: RESOURCE_KEANIUM,
      requestedAmount: 250_000,
    });
    expect(localTerminalClaim?.amount).toBe(250_000);
    localTerminalClaim!.commit();
    const normalSourceSnapshot = collectResourceControlSnapshots().find(
      (snapshot) => snapshot.roomName === source.name,
    );
    expect(Object.prototype.hasOwnProperty.call(
      normalSourceSnapshot?.terminalResourceAmounts || {},
      RESOURCE_LEMERGIUM,
    )).toBe(true);
    const disabledBoundaryState = captureShadowAuthorityBoundaryState([
      source,
      receiver,
      shadowReceiver,
    ]);
    const proofCapture = beginSynthesisShadowEpochCapture([
      RESOURCE_KEANIUM,
    ]);
    expect(proofCapture).toEqual(expect.objectContaining({ ok: true }));
    if (proofCapture.ok === false) throw new Error(proofCapture.reason);
    expect(Object.isFrozen(proofCapture.tasks)).toBe(true);
    expect(proofCapture.tasks.every((task) => Object.isFrozen(task))).toBe(true);
    const proofFacts = proofCapture.buildRoomFacts([RESOURCE_KEANIUM]);
    expect(proofFacts).toEqual(expect.objectContaining({ ok: true }));
    if (proofFacts.ok === false) throw new Error(proofFacts.reason);
    const proofResult = runSynthesisLogisticsShadow({
      now: Game.time,
      inputRevision: proofFacts.epochRevision,
      inputFingerprint: proofFacts.epochFingerprint,
      costModelRevision: "capacity-regression:authority-boundary",
      demands: [{
        comparisonKey: "capacity-regression:authority-boundary",
        demandKey: "capacity-regression:authority-boundary",
        origin: "synthesis_room",
        epochRevision: proofFacts.epochRevision,
        epochFingerprint: proofFacts.epochFingerprint,
        revision: "capacity-regression:authority-boundary:1",
        inputFingerprint: "capacity-regression:authority-boundary:fingerprint",
        targetRoom: shadowReceiver.name,
        resource: RESOURCE_KEANIUM,
        product: RESOURCE_HYDROXIDE,
        desiredAmount: 100,
        localAmount: 100,
        healthyIncomingAmount: 0,
        minimumBatchAmount: 1,
        maximumBatchAmount: 100,
        priorityClass: "production",
        firstObservedAt: Game.time,
        decisionOrder: 0,
        observedAt: Game.time,
        expiresAt: Game.time + 30,
      }],
      rooms: proofFacts.roomFacts,
      legacyDecisions: [{
        comparisonKey: "capacity-regression:authority-boundary",
        epochRevision: proofFacts.epochRevision,
        epochFingerprint: proofFacts.epochFingerprint,
        inputRevision: "capacity-regression:authority-boundary:1",
        inputFingerprint: "capacity-regression:authority-boundary:fingerprint",
        observedAt: Game.time,
        kind: "none",
        blocker: "demand_already_covered",
        coverage: "covered",
        capacity: "unknown",
        predictedStagingEligibility: "unknown",
      }],
      candidateBudget: 1,
      transactionCost: () => 0,
    });
    expect(proofResult).toEqual(expect.objectContaining({
      complete: true,
      comparisons: [expect.objectContaining({ status: "equal" })],
    }));
    expect(captureShadowAuthorityBoundaryState([
      source,
      receiver,
      shadowReceiver,
    ])).toEqual(disabledBoundaryState);

    const sourceTerminalStore = source.terminal!.store as unknown as {
      getUsedCapacity(resource?: ResourceConstant): number;
    };
    const originalTerminalGetUsedCapacity =
      sourceTerminalStore.getUsedCapacity.bind(sourceTerminalStore);
    const captureTerminalResourceReads: Array<ResourceConstant | undefined> = [];
    const terminalReadSpy = jest
      .spyOn(sourceTerminalStore, "getUsedCapacity")
      .mockImplementation((resource?: ResourceConstant) => {
        captureTerminalResourceReads.push(resource);
        return originalTerminalGetUsedCapacity(resource);
      });

    const epochCapture = beginSynthesisShadowEpochCapture([
      RESOURCE_KEANIUM,
      RESOURCE_HYDROGEN,
    ]);
    expect(epochCapture).toEqual(expect.objectContaining({ ok: true }));
    if (epochCapture.ok === false) throw new Error(epochCapture.reason);
    const frozenTaskState = JSON.stringify(epochCapture.tasks);
    expect(Object.isFrozen(epochCapture.tasks)).toBe(true);
    expect(epochCapture.tasks.every((task) => Object.isFrozen(task))).toBe(true);
    const sourceStorage = source.storage!.store as unknown as MutableStore;
    sourceStorage.set(RESOURCE_HYDROGEN, 0);
    (shadowReceiver.terminal as StructureTerminal & { cooldown: number })
      .cooldown = 99;
    const mergedFeeTask = createAutomaticResourceTransferTask(
      source.name,
      shadowReceiver.name,
      RESOURCE_KEANIUM,
      100,
      `synthesis:${shadowReceiver.name}:${RESOURCE_HYDROXIDE}`,
    );
    if (typeof mergedFeeTask === "string") throw new Error(mergedFeeTask);
    expect(mergedFeeTask.task.id).toBe(saturatedFeeTask.task.id);
    expect(mergedFeeTask.task.remainingAmount).toBe(10_100);
    expect(JSON.stringify(epochCapture.tasks)).toBe(frozenTaskState);
    expect(epochCapture.tasks.find((task) => task.id === mergedFeeTask.task.id))
      .toEqual(expect.objectContaining({ remainingAmount: 10_000 }));
    const frozenEpoch = epochCapture.buildRoomFacts([
      RESOURCE_KEANIUM,
      RESOURCE_HYDROGEN,
    ]);
    expect(frozenEpoch).toEqual(expect.objectContaining({ ok: true }));
    if (frozenEpoch.ok === false) throw new Error(frozenEpoch.reason);
    expect(captureTerminalResourceReads).not.toContain(RESOURCE_LEMERGIUM);
    terminalReadSpy.mockRestore();
    sourceStorage.set(RESOURCE_HYDROGEN, 854_000);
    (shadowReceiver.terminal as StructureTerminal & { cooldown: number })
      .cooldown = 0;
    const shadowDemandKey = JSON.stringify([
      "synthesis_room/v1",
      shadowReceiver.name,
      RESOURCE_HYDROXIDE,
      RESOURCE_KEANIUM,
    ]);
    const published = replaceLatestLogisticsDemandsForProducer(
      SYNTHESIS_ROOM_LOGISTICS_PRODUCER,
      [{
        demandKey: shadowDemandKey,
        origin: "synthesis_room",
        targetRoomName: shadowReceiver.name,
        resource: RESOURCE_KEANIUM,
        product: RESOURCE_HYDROXIDE,
        desiredAmount: 10_100,
        priorityClass: "production",
        minBatch: 1,
        maxBatch: 10_000,
        ttl: 30,
      }],
      [{
        demandKey: shadowDemandKey,
        decisionOrder: 0,
        inputFingerprint: "capacity-regression:saturated-fee:v1",
        localAmount: 0,
        incomingAmount: 10_000,
        uncoveredAmount: 100,
        comparableReason: "comparable",
        legacyDecision: "merged",
        legacyPriorityRank: 2,
        legacyPriorityClass: "production",
        legacySourceRoomName: source.name,
        legacyAmount: 100,
        legacyTaskId: mergedFeeTask.task.id,
        legacyAddedAmount: 100,
        legacyRemainingBefore: 10_000,
        // 已有 remainder 已占满默认 10k batch，merge 不新增 P0 fee commitment。
        legacyFeeDelta: 0,
      }],
      {
        totalCount: 1,
        overflowCount: 0,
        ttl: frozenEpoch.expiresAt - frozenEpoch.observedAt,
        epochRevision: frozenEpoch.epochRevision,
        epochFingerprint: frozenEpoch.epochFingerprint,
        captureCpuUsed: frozenEpoch.captureCpuUsed,
        indexBuildCount: frozenEpoch.indexBuildCount,
        roomFacts: frozenEpoch.roomFacts,
      },
    );
    expect(published).toEqual(expect.objectContaining({ ok: true }));

    const shadowSendCalls = (source.terminal!.send as jest.Mock).mock.calls.length;
    const shadowDealCalls = (Game.market.deal as jest.Mock).mock.calls.length;
    // This fixture invokes producer primitives directly instead of running
    // SynthesisControl; seal that artificial producer pass before its consumer.
    measureLogisticsShadowCpu("producer", () => undefined);
    resetRuntimeServices();
    runResourceControl();
    expect((source.terminal!.send as jest.Mock).mock.calls).toHaveLength(
      shadowSendCalls,
    );
    expect((Game.market.deal as jest.Mock).mock.calls).toHaveLength(
      shadowDealCalls,
    );

    expect(expired.task).toEqual(expect.objectContaining({
      status: "cancelled",
      lastError: "automatic_receiver_capacity_coverage_timeout",
    }));
    expect(Memory.runtime?.resourceControl?.taskSummary).toEqual(
      expect.objectContaining({
        pending: 2,
        demandCoveringIncoming: 2,
        coverageExpiredIncoming: 1,
        coverageExpiredByReason: {
          automatic_receiver_capacity_coverage_timeout: 1,
        },
      }),
    );
    expect((Memory.runtime?.resourceControl as unknown as {
      taskContributionIndex?: {
        productionReservationScanCount: number;
        productionReservationRecordCount: number;
        invalidProductionReservationCount: number;
      };
    })?.taskContributionIndex).toEqual(expect.objectContaining({
      productionReservationScanCount: 1,
      productionReservationRecordCount: 0,
      invalidProductionReservationCount: 0,
    }));
    const logistics = (
      Memory.runtime?.resourceControl as unknown as {
        logistics?: {
          available: boolean;
          complete: boolean;
          effectiveAuthority: string;
          comparison: {
            total: number;
            unresolved: number;
            samples: Array<{
              status: string;
              reason: string;
              targetRoomName: string;
              resource: ResourceConstant;
              decisionDelta: string;
              direction: string;
              causalCode: string;
              legacy?: { kind: string; sourceRoomName?: string };
              shadow?: { kind: string; reason?: string };
              candidate?: {
                evaluatedCount: number;
                feasibleCount: number;
                rejectedCount: number;
                rejectionCounts: Array<[string, number]>;
                legacySource?: { disposition: string; rejection?: string };
              };
            }>;
          };
          safety: {
            measurementBoundary: string;
            nonLegacyAuthorityRecords: number;
            activeContracts: number;
            activeLeases: number;
            activeClaims: number;
            shadowArbiterActorRecords: number;
            shadowClaimRecords: number;
            shadowJournalRecords: number;
            shadowCarrierTaskRecords: number;
            shadowReceiverReservationRecords: number;
            violations: string[];
          };
          resources: {
            runtimeBytes: number;
            totalBytes: number;
            withinLimit: boolean;
          };
        };
      } | undefined
    )?.logistics;
    expect(logistics).toEqual(expect.objectContaining({
      available: true,
      complete: true,
      effectiveAuthority: "legacy",
      comparison: expect.objectContaining({ total: 1, unresolved: 0 }),
      safety: expect.objectContaining({
        measurementBoundary: "observable_state_diff_v1",
        nonLegacyAuthorityRecords: 0,
        activeContracts: 0,
        activeLeases: 0,
        activeClaims: 0,
        shadowArbiterActorRecords: 0,
        shadowClaimRecords: 0,
        shadowJournalRecords: 0,
        shadowCarrierTaskRecords: 0,
        shadowReceiverReservationRecords: 0,
        violations: [],
      }),
      resources: expect.objectContaining({ withinLimit: true }),
    }));
    expect(logistics!.resources.runtimeBytes).toBeLessThanOrEqual(16_384);
    expect(logistics!.resources.totalBytes).toBeLessThanOrEqual(32_768);
    expect(Memory.runtime?.resourceControl?.rooms[source.name]?.capacityState)
      .toBe("emergency");
    expect(logistics!.comparison.samples).toEqual([
      expect.objectContaining({
        reason: "expected_policy_difference",
        targetRoomName: shadowReceiver.name,
        resource: RESOURCE_KEANIUM,
        decisionDelta: "legacy_only_route",
        direction: "shadow_more_conservative",
        causalCode: "source_protection",
        legacy: expect.objectContaining({
          kind: "route",
          sourceRoomName: source.name,
        }),
        shadow: expect.objectContaining({
          kind: "unmatched",
          reason: "source_protection",
        }),
        candidate: expect.objectContaining({
          evaluatedCount: 3,
          feasibleCount: 0,
          rejectedCount: 3,
          rejectionCounts: expect.arrayContaining([
            ["source_protection", 2],
          ]),
          legacySource: expect.objectContaining({
            disposition: "rejected",
            rejection: "source_protection",
          }),
        }),
      }),
    ]);
    const logisticsStore = peekLogisticsControlStore();
    expect(logisticsStore).toEqual(expect.objectContaining({ ok: true }));
    if (logisticsStore.ok) {
      const sourceFact = Object.values(logisticsStore.store.roomFacts).find(
        (fact) => fact.roomName === source.name,
      );
      expect(sourceFact?.resources.find(
        (resource) => resource.resource === RESOURCE_KEANIUM,
      )?.sourceAvailableAmount).toBe(0);
      expect(sourceFact?.resources.find(
        (resource) => resource.resource === RESOURCE_HYDROGEN,
      )?.sourceAvailableAmount).toBeGreaterThan(0);
      const receiverFact = Object.values(logisticsStore.store.roomFacts).find(
        (fact) => fact.roomName === shadowReceiver.name,
      );
      expect(receiverFact?.receiverTerminalHeadroom).toBe(0);
      expect(receiverFact?.terminalStagingFreeCapacity).toBe(0);
      expect(receiverFact?.terminalReadyAt).toBe(510);
    }
    expect(Memory.runtime?.resourceControl?.rooms[source.name]?.staging).toMatchObject({
      admittedAmount: 2_500,
      admittedTaskCount: 1,
      admittedByResource: { [RESOURCE_ZYNTHIUM]: 2_500 },
    });
    const feedTasks = Object.values(getCarrierTasksByRoom(source.name)).filter(
      (task) => task.type === "terminal_feed",
    );
    expect(feedTasks).toEqual([
      expect.objectContaining({
        id: `resourceControl:terminal_feed:${source.name}:${RESOURCE_ENERGY}`,
        steps: [expect.objectContaining({ resource: RESOURCE_ENERGY, amount: 2_000 })],
      }),
    ]);
    expect(feedTasks.some((task) =>
      task.steps.some((step) => step.resource === RESOURCE_ZYNTHIUM),
    )).toBe(false);

    expect(executeTerminalFeedTasks(source)).toBe(2_000);
    Game.time = 520;
    const coveredCapture = beginSynthesisShadowEpochCapture([
      RESOURCE_KEANIUM,
    ]);
    expect(coveredCapture).toEqual(expect.objectContaining({ ok: true }));
    if (coveredCapture.ok === false) throw new Error(coveredCapture.reason);
    const coveredEpoch = coveredCapture.buildRoomFacts([RESOURCE_KEANIUM]);
    expect(coveredEpoch).toEqual(expect.objectContaining({ ok: true }));
    if (coveredEpoch.ok === false) throw new Error(coveredEpoch.reason);
    expect(replaceLatestLogisticsDemandsForProducer(
      SYNTHESIS_ROOM_LOGISTICS_PRODUCER,
      [{
        demandKey: shadowDemandKey,
        origin: "synthesis_room",
        targetRoomName: shadowReceiver.name,
        resource: RESOURCE_KEANIUM,
        product: RESOURCE_HYDROXIDE,
        desiredAmount: 10_100,
        priorityClass: "production",
        minBatch: 1,
        maxBatch: 10_000,
        ttl: 30,
      }],
      [{
        demandKey: shadowDemandKey,
        decisionOrder: 0,
        inputFingerprint: "capacity-regression:covered:v1",
        localAmount: 0,
        incomingAmount: 10_100,
        uncoveredAmount: 0,
        comparableReason: "comparable",
        legacyDecision: "no_op",
        legacyPriorityRank: 2,
        legacyPriorityClass: "production",
        legacyAmount: 0,
        legacyAddedAmount: 0,
        legacyRemainingBefore: 0,
        legacyFeeDelta: 0,
      }],
      {
        totalCount: 1,
        overflowCount: 0,
        ttl: coveredEpoch.expiresAt - coveredEpoch.observedAt,
        epochRevision: coveredEpoch.epochRevision,
        epochFingerprint: coveredEpoch.epochFingerprint,
        captureCpuUsed: coveredEpoch.captureCpuUsed,
        indexBuildCount: coveredEpoch.indexBuildCount,
        roomFacts: coveredEpoch.roomFacts,
      },
    )).toEqual(expect.objectContaining({ ok: true }));
    measureLogisticsShadowCpu("producer", () => undefined);
    resetRuntimeServices();
    runResourceControl();

    expect(source.terminal!.send).toHaveBeenCalledWith(
      RESOURCE_ZYNTHIUM,
      2_500,
      receiver.name,
      expect.stringContaining("resourceControl:task:"),
    );
    expect(created.task.status).toBe("done");
    expect(receiver.terminal!.store.getUsedCapacity(RESOURCE_ZYNTHIUM)).toBe(2_500);
    const sourceZynthiumStock =
      (source.storage?.store.getUsedCapacity(RESOURCE_ZYNTHIUM) || 0) +
      source.terminal!.store.getUsedCapacity(RESOURCE_ZYNTHIUM);
    const receiverZynthiumStock =
      (receiver.storage?.store.getUsedCapacity(RESOURCE_ZYNTHIUM) || 0) +
      receiver.terminal!.store.getUsedCapacity(RESOURCE_ZYNTHIUM);
    expect(sourceZynthiumStock).toBe(192_500);
    expect(receiverZynthiumStock).toBe(2_500);
    expect(Memory.runtime?.resourceControl?.rooms[source.name]?.minerals?.[
      RESOURCE_ZYNTHIUM
    ]).toBe(sourceZynthiumStock);
    expect(Memory.runtime?.resourceControl?.rooms[receiver.name]?.minerals?.[
      RESOURCE_ZYNTHIUM
    ]).toBe(receiverZynthiumStock);
    const coveredLogistics = (
      Memory.runtime?.resourceControl as unknown as {
        logistics?: {
          complete: boolean;
          comparison: {
            samples: Array<{ status: string; reason: string }>;
          };
        };
      } | undefined
    )?.logistics;
    expect(coveredLogistics).toEqual(expect.objectContaining({
      complete: true,
      comparison: expect.objectContaining({
        samples: [expect.objectContaining({ status: "equal", reason: "equal" })],
      }),
    }));

    Game.time = 530;
    const emptyCapture = beginSynthesisShadowEpochCapture([
      RESOURCE_KEANIUM,
    ]);
    if (emptyCapture.ok === false) throw new Error(emptyCapture.reason);
    const emptyFacts = emptyCapture.buildRoomFacts([]);
    if (emptyFacts.ok === false) throw new Error(emptyFacts.reason);
    expect(emptyFacts.roomFacts).toEqual([]);
    expect(replaceLatestLogisticsDemandsForProducer(
      SYNTHESIS_ROOM_LOGISTICS_PRODUCER,
      [],
      [],
      {
        totalCount: 0,
        overflowCount: 0,
        ttl: emptyFacts.expiresAt - emptyFacts.observedAt,
        epochRevision: emptyFacts.epochRevision,
        epochFingerprint: emptyFacts.epochFingerprint,
        captureCpuUsed: emptyFacts.captureCpuUsed,
        indexBuildCount: emptyFacts.indexBuildCount,
        roomFacts: emptyFacts.roomFacts,
      },
    )).toEqual(expect.objectContaining({ ok: true }));
    resetRuntimeServices();
    runResourceControl();
    const emptyLogistics = (
      Memory.runtime?.resourceControl as unknown as {
        logistics?: {
          available: boolean;
          blocker?: string;
          complete: boolean;
          intent: { total: number; emitted: number };
          comparison: { total: number };
          safety: { violations: string[] };
          cpu: {
            attributionVersion: number;
            sampleTick: number;
            measurementAvailable: boolean;
            producerUsed: number;
            consumerUsed: number;
          };
        };
      } | undefined
    )?.logistics;
    expect(emptyLogistics).toEqual(expect.objectContaining({
      available: false,
      blocker: "input_unavailable",
      complete: false,
      intent: expect.objectContaining({ total: 0, emitted: 0 }),
      comparison: expect.objectContaining({ total: 0 }),
      safety: expect.objectContaining({
        violations: expect.arrayContaining(["cpu_measurement_unavailable"]),
      }),
      cpu: expect.objectContaining({
        attributionVersion: 2,
        sampleTick: 530,
        measurementAvailable: false,
        producerUsed: 0,
      }),
    }));

    Game.time = 540;
    const unavailableCapture = beginSynthesisShadowEpochCapture([
      RESOURCE_KEANIUM,
      RESOURCE_HYDROGEN,
    ]);
    if (unavailableCapture.ok === false) {
      throw new Error(unavailableCapture.reason);
    }
    const unavailableFacts = unavailableCapture.buildRoomFacts([
      RESOURCE_KEANIUM,
      RESOURCE_HYDROGEN,
    ]);
    if (unavailableFacts.ok === false) throw new Error(unavailableFacts.reason);
    const unavailableDrafts = [
      {
        resource: RESOURCE_KEANIUM,
        reason: "input_unavailable" as const,
      },
      {
        resource: RESOURCE_HYDROGEN,
        reason: "legacy_unpaired" as const,
      },
    ].map(({ resource, reason }) => ({
      demandKey: JSON.stringify([
        "synthesis_room/v1",
        shadowReceiver.name,
        RESOURCE_HYDROXIDE,
        resource,
      ]),
      resource,
      reason,
    }));
    expect(replaceLatestLogisticsDemandsForProducer(
      SYNTHESIS_ROOM_LOGISTICS_PRODUCER,
      unavailableDrafts.map(({ demandKey, resource }) => ({
        demandKey,
        origin: "synthesis_room" as const,
        targetRoomName: shadowReceiver.name,
        resource,
        product: RESOURCE_HYDROXIDE,
        desiredAmount: 100,
        priorityClass: "production" as const,
        minBatch: 1,
        maxBatch: 100,
        ttl: 30,
      })),
      unavailableDrafts.map(({ demandKey, reason }, decisionOrder) => ({
        demandKey,
        decisionOrder,
        inputFingerprint: `capacity-regression:${reason}:v1`,
        localAmount: 0,
        incomingAmount: 0,
        uncoveredAmount: 100,
        comparableReason: reason,
        legacyDecision: "failed" as const,
        legacyPriorityRank: 2,
        legacyPriorityClass: "production" as const,
        legacyAmount: 0,
        legacyAddedAmount: 0,
        legacyRemainingBefore: 0,
        legacyFeeDelta: 0,
      })),
      {
        totalCount: 2,
        overflowCount: 0,
        ttl: unavailableFacts.expiresAt - unavailableFacts.observedAt,
        epochRevision: unavailableFacts.epochRevision,
        epochFingerprint: unavailableFacts.epochFingerprint,
        captureCpuUsed: unavailableFacts.captureCpuUsed,
        indexBuildCount: unavailableFacts.indexBuildCount,
        roomFacts: unavailableFacts.roomFacts,
      },
    )).toEqual(expect.objectContaining({ ok: true }));
    resetRuntimeServices();
    runResourceControl();
    const unavailableLogistics = (
      Memory.runtime?.resourceControl as unknown as {
        logistics?: {
          complete: boolean;
          intent: { inputDrift: number };
          comparison: {
            unresolved: number;
            byReason: Record<string, number>;
            byCausalCode: Record<string, number>;
            samples: Array<{ producerReason?: string; reason: string }>;
          };
        };
      } | undefined
    )?.logistics;
    expect(unavailableLogistics).toEqual(expect.objectContaining({
      complete: false,
      intent: expect.objectContaining({ inputDrift: 2 }),
      comparison: expect.objectContaining({
        unresolved: 2,
        byReason: expect.objectContaining({
          input_drift: 2,
        }),
        byCausalCode: expect.objectContaining({ input_drift: 2 }),
        samples: expect.arrayContaining([
          expect.objectContaining({
            reason: "input_drift",
            producerReason: "legacy_unpaired",
          }),
          expect.objectContaining({
            reason: "input_drift",
            producerReason: "input_unavailable",
          }),
        ]),
      }),
    }));
    delete (Memory.data as unknown as { marketSaleAutomation?: unknown })
      .marketSaleAutomation;
  });

  it("rejects the whole fee bootstrap batch when only a smaller batch would fit", () => {
    const source = createMutableRoom(
      "E3N58",
      { [RESOURCE_ENERGY]: 146_000, [RESOURCE_HYDROGEN]: 840_000 },
      { [RESOURCE_ZYNTHIUM]: 299_000 },
    );
    const receiver = createMutableRoom(
      "E4N57",
      { [RESOURCE_ENERGY]: 200_000 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    Game.rooms[source.name] = source;
    Game.rooms[receiver.name] = receiver;
    (Game.market.calcTransactionCost as jest.Mock).mockImplementation(
      (amount: number) => Math.ceil(amount / 2),
    );

    Game.time = 1;
    const created = createAutomaticResourceTransferTask(
      source.name,
      receiver.name,
      RESOURCE_ZYNTHIUM,
      2_500,
      `capacity:relief:${RESOURCE_ZYNTHIUM}`,
    );
    if (typeof created === "string") throw new Error(created);

    Game.time = 10;
    resetRuntimeServices();
    runResourceControl();

    expect(Memory.runtime?.resourceControl?.rooms[source.name]?.staging).toMatchObject({
      admittedAmount: 0,
      admittedTaskCount: 0,
      suppressedByReason: { terminal_headroom: 1 },
    });
    expect(Object.values(getCarrierTasksByRoom(source.name)).filter(
      (task) => task.type === "terminal_feed",
    )).toEqual([]);
    expect(source.terminal!.send).not.toHaveBeenCalled();
    expect(created.task.remainingAmount).toBe(2_500);
  });

  it("admits exactly 50000 into a normal 150000-free Storage and none at 100000", () => {
    Memory.cfg!.resourceControl!.rooms = {
      W88N1: { transferBatchSize: 50_000 },
    };
    const source = createMutableRoom(
      "W88N1",
      { [RESOURCE_ENERGY]: 200_000, [RESOURCE_HYDROGEN]: 790_001 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    const receiver = createMutableRoom(
      "W88N2",
      { [RESOURCE_ENERGY]: 850_000 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    const saturated = createMutableRoom(
      "W88N3",
      { [RESOURCE_ENERGY]: 900_000 },
      { [RESOURCE_ENERGY]: 20_000 },
    );
    Game.rooms[source.name] = source;
    Game.rooms[receiver.name] = receiver;
    Game.rooms[saturated.name] = saturated;

    Game.time = 10;
    resetRuntimeServices();
    runResourceControl();

    const task = Object.values(ensureResourceTransferTaskStore()).find(
      (entry) => entry.fromRoomName === source.name,
    );
    expect(task).toMatchObject({
      toRoomName: receiver.name,
      resource: RESOURCE_HYDROGEN,
      remainingAmount: 50_000,
    });
    expect(Object.values(ensureResourceTransferTaskStore()).some(
      (entry) => entry.toRoomName === saturated.name,
    )).toBe(false);
    expect(Memory.runtime?.resourceControl?.rooms[receiver.name]?.capacityReservation).toEqual({
      committed: 50_000,
      remaining: 0,
    });
    expect(Memory.runtime?.resourceControl?.rooms[saturated.name]?.capacityReservation).toEqual({
      committed: 0,
      remaining: 0,
    });

    expect(executeTerminalFeedTasks(source)).toBe(50_000);
    Game.time = 20;
    resetRuntimeServices();
    runResourceControl();

    expect(source.terminal!.send).toHaveBeenCalledWith(
      RESOURCE_HYDROGEN,
      50_000,
      receiver.name,
      expect.stringContaining("resourceControl:task:"),
    );
    expect(task?.status).toBe("done");

    const makeDemand = (
      demandKey: string,
      targetRoom: string,
      resource: ResourceConstant,
      maximumBatchAmount = 60,
      allowedSourceRooms: string[] = ["A", "B"],
      decisionOrder = 0,
    ): SynthesisShadowMatcherInput["demands"][number] => ({
      comparisonKey: demandKey,
      demandKey,
      origin: "synthesis_room",
      epochRevision: "capacity-regression:epoch",
      epochFingerprint: "capacity-regression:fingerprint",
      revision: `${demandKey}:1`,
      inputFingerprint: `${demandKey}:fingerprint`,
      targetRoom,
      resource,
      desiredAmount: maximumBatchAmount,
      localAmount: 0,
      healthyIncomingAmount: 0,
      minimumBatchAmount: 1,
      maximumBatchAmount,
      priorityClass: "production",
      firstObservedAt: 100,
      decisionOrder,
      observedAt: 100,
      expiresAt: 200,
      allowedSourceRooms,
    });
    const xResource = RESOURCE_CATALYST;
    const baseMatcherInput: SynthesisShadowMatcherInput = {
      now: 100,
      inputRevision: "capacity-regression:epoch",
      inputFingerprint: "capacity-regression:fingerprint",
      costModelRevision: "zero-cost:v1",
      demands: [
        makeDemand("D1", "T1", xResource),
        makeDemand("D2", "T2", xResource),
      ],
      rooms: [
        createShadowMatcherRoom("A", [{
          resource: xResource,
          sourceAvailableAmount: 100,
          sourceTerminalAmount: 100,
          receiverResourceHeadroom: 100,
        }]),
        createShadowMatcherRoom("B", [{
          resource: xResource,
          sourceAvailableAmount: 100,
          sourceTerminalAmount: 100,
          receiverResourceHeadroom: 100,
        }]),
        createShadowMatcherRoom("T1", [{
          resource: xResource,
          sourceAvailableAmount: 0,
          sourceTerminalAmount: 0,
          receiverResourceHeadroom: 100,
        }]),
        createShadowMatcherRoom("T2", [{
          resource: xResource,
          sourceAvailableAmount: 0,
          sourceTerminalAmount: 0,
          receiverResourceHeadroom: 100,
        }]),
      ],
      transactionCost: () => 0,
    };
    const makeLegacyRouteDecision = (
      demand: SynthesisShadowMatcherInput["demands"][number],
      sourceRoom: string,
      amount = demand.maximumBatchAmount,
      capacity: "eligible" | "blocked" = "eligible",
      staging: "eligible" | "blocked" = "eligible",
    ): SynthesisShadowLegacyDecisionObservation => ({
      comparisonKey: demand.comparisonKey,
      epochRevision: demand.epochRevision,
      epochFingerprint: demand.epochFingerprint,
      inputRevision: demand.revision,
      inputFingerprint: demand.inputFingerprint,
      observedAt: 100,
      kind: "route",
      actionBasis: "standalone",
      remainingBefore: 0,
      transferBatchSize: 100,
      route: {
        sourceRoom,
        targetRoom: demand.targetRoom,
        resource: demand.resource,
        amount,
        actionAmount: amount,
        priorityClass: demand.priorityClass,
        coverage: amount >= demand.desiredAmount ? "covered" : "partial",
        capacity,
        predictedStagingEligibility: staging,
        terminalReadyAt: 100,
        transactionCost: 0,
        requiredEnergy: 0,
        energyCommitmentAmount: 0,
        terminalAllocatedAmount: amount,
        stagingRequiredAmount: 0,
        terminalEnergyAllocatedAmount: 0,
        feeStagingRequiredAmount: 0,
        stableKey:
          `${sourceRoom}\u0000${demand.targetRoom}\u0000${demand.resource}\u0000${demand.comparisonKey}`,
      },
    });
    const monolithic = runSynthesisLogisticsShadow({
      ...baseMatcherInput,
      candidateBudget: 256,
    });
    expect(monolithic.complete).toBe(true);
    for (const budget of [1, 2, 3, 5]) {
      const paged = runPagedShadowMatcher(baseMatcherInput, budget);
      expect(paged.decisions).toEqual(monolithic.decisions);
      expect(paged.unmatched).toEqual(monolithic.unmatched);
      expect(paged.metrics.totalCandidateEvaluations).toBe(
        monolithic.metrics.totalCandidateEvaluations,
      );
      expect(paged.metrics.totalTransactionCostEvaluations).toBe(
        monolithic.metrics.totalTransactionCostEvaluations,
      );
    }
    expect(monolithic.metrics.transactionCostEvaluations).toBeLessThanOrEqual(
      monolithic.metrics.candidateEvaluations *
        SYNTHESIS_SHADOW_MAX_TRANSACTION_COST_EVALUATIONS_PER_CANDIDATE,
    );
    const firstPage = runSynthesisLogisticsShadow({
      ...baseMatcherInput,
      candidateBudget: 1,
    });
    expect(firstPage.continuation?.partialBest).toBeDefined();
    const tamperedContinuation = {
      ...firstPage.continuation!,
      partialBest: undefined,
    };
    const rejectedContinuation = runSynthesisLogisticsShadow({
      ...baseMatcherInput,
      candidateBudget: 1,
      continuation: tamperedContinuation,
    });
    expect(rejectedContinuation.metrics.continuationInvalidated).toBe(true);

    const oversizedInput = runSynthesisLogisticsShadow({
      ...baseMatcherInput,
      rooms: [
        ...baseMatcherInput.rooms,
        ...Array.from({ length: 13 }, (_, index) => ({
          ...baseMatcherInput.rooms[0],
          roomName: `overflow-${index}`,
        })),
      ],
      candidateBudget: 1,
    });
    expect(oversizedInput).toEqual(expect.objectContaining({
      complete: false,
      comparisons: [],
      metrics: expect.objectContaining({
        candidateEvaluations: 0,
        inputLimitExceeded: true,
      }),
    }));
    expect(oversizedInput.continuation).toBeUndefined();
    const oversizedKey = runSynthesisLogisticsShadow({
      ...baseMatcherInput,
      demands: [{
        ...baseMatcherInput.demands[0],
        comparisonKey: "x".repeat(513),
      }],
      candidateBudget: 1,
    });
    expect(oversizedKey.metrics).toEqual(expect.objectContaining({
      candidateEvaluations: 0,
      inputLimitExceeded: true,
    }));
    const zeroBudget = runSynthesisLogisticsShadow({
      ...baseMatcherInput,
      candidateBudget: 0,
    });
    expect(zeroBudget).toEqual(expect.objectContaining({
      complete: false,
      continuation: expect.any(Object),
      metrics: expect.objectContaining({ candidateEvaluations: 0 }),
    }));

    const rejectedInput: SynthesisShadowMatcherInput = {
      ...baseMatcherInput,
      demands: [makeDemand("blocked", "T1", xResource)],
      rooms: baseMatcherInput.rooms.map((room) => ({
        ...room,
        resources: room.resources.map((resource) => ({
          ...resource,
          sourceAvailableAmount: 0,
          sourceTerminalAmount: 0,
        })),
      })),
    };
    const rejectedMonolithic = runSynthesisLogisticsShadow({
      ...rejectedInput,
      candidateBudget: 256,
    });
    const rejectedPaged = runPagedShadowMatcher(rejectedInput, 1);
    expect(rejectedPaged.unmatched).toEqual(rejectedMonolithic.unmatched);
    expect(rejectedMonolithic.unmatched).toEqual([
      expect.objectContaining({
        reason: "source_protection",
        candidateTrace: {
          donorCount: 4,
          evaluatedCount: 4,
          feasibleCount: 0,
          rejectedCount: 4,
          selectedRejection: "source_protection",
          rejectionCounts: [
            ["source_protection", 2],
            ["source_not_allowed", 1],
            ["same_room", 1],
          ],
          receiver: {
            kind: "present",
            receiverEligible: true,
            storageHeadroom: 100,
            terminalHeadroom: 100,
            resourceHeadroom: 100,
          },
        },
      }),
    ]);
    const blockedDemand = rejectedInput.demands[0];
    const legacyRouteShadowVeto = runSynthesisLogisticsShadow({
      ...rejectedInput,
      legacyDecisions: [makeLegacyRouteDecision(blockedDemand, "A")],
      candidateBudget: 256,
    });
    expect(legacyRouteShadowVeto.comparisons).toEqual([
      expect.objectContaining({
        status: "different",
        classification: "expected_policy_difference",
        differences: ["shadow_missing"],
        shadow: expect.objectContaining({
          reason: "source_protection",
          candidateTrace: expect.objectContaining({
            legacySource: {
              sourceRoom: "A",
              disposition: "rejected",
              rejection: "source_protection",
            },
          }),
        }),
      }),
    ]);
    expect(runPagedShadowMatcher({
      ...rejectedInput,
      legacyDecisions: [makeLegacyRouteDecision(blockedDemand, "A")],
    }, 1).unmatched).toEqual(legacyRouteShadowVeto.unmatched);

    // 稀缺源仲裁必须跟随 legacy 规划序（decisionOrder），而不是需求年龄或
    // 字典序：legacy 先规划 D-beta（消耗 S 的全部 60），后规划的 D-alpha 只能
    // source_protection。firstObservedAt 故意反向（D-alpha 更老）以证明
    // decisionOrder 主导仲裁。
    const arbAlpha = makeDemand("arb-alpha", "T1", xResource, 60, ["S"], 5);
    const arbBeta = makeDemand("arb-beta", "T2", xResource, 60, ["S"], 1);
    const arbitrationInput: SynthesisShadowMatcherInput = {
      ...baseMatcherInput,
      demands: [
        { ...arbAlpha, firstObservedAt: 50 },
        { ...arbBeta, firstObservedAt: 100 },
      ],
      rooms: [
        createShadowMatcherRoom("S", [{
          resource: xResource,
          sourceAvailableAmount: 60,
          sourceTerminalAmount: 60,
          receiverResourceHeadroom: 100,
        }]),
        createShadowMatcherRoom("T1", [{
          resource: xResource,
          sourceAvailableAmount: 0,
          sourceTerminalAmount: 0,
          receiverResourceHeadroom: 100,
        }]),
        createShadowMatcherRoom("T2", [{
          resource: xResource,
          sourceAvailableAmount: 0,
          sourceTerminalAmount: 0,
          receiverResourceHeadroom: 100,
        }]),
      ],
    };
    const arbitration = runPagedShadowMatcher(arbitrationInput, 4);
    expect(arbitration.decisions.map((entry) => entry.comparisonKey)).toEqual(["arb-beta"]);
    expect(arbitration.decisions[0]).toEqual(expect.objectContaining({
      sourceRoom: "S",
      amount: 60,
    }));
    expect(arbitration.unmatched).toEqual([
      expect.objectContaining({
        comparisonKey: "arb-alpha",
        reason: "source_protection",
      }),
    ]);

    const receiverVetoDemand = makeDemand(
      "receiver-veto",
      "T",
      xResource,
      60,
      ["A"],
    );
    const receiverVetoRooms: SynthesisShadowRoomFact[] = [
      createShadowMatcherRoom("A", [{
        resource: xResource,
        sourceAvailableAmount: 100,
        sourceTerminalAmount: 100,
        receiverResourceHeadroom: 100,
      }]),
      {
        ...createShadowMatcherRoom("T", [{
          resource: xResource,
          sourceAvailableAmount: 0,
          sourceTerminalAmount: 0,
          receiverResourceHeadroom: 100,
        }]),
        receiverEligible: false,
      },
    ];
    const legacyNoRoute = {
      comparisonKey: receiverVetoDemand.comparisonKey,
      epochRevision: receiverVetoDemand.epochRevision,
      epochFingerprint: receiverVetoDemand.epochFingerprint,
      inputRevision: receiverVetoDemand.revision,
      inputFingerprint: receiverVetoDemand.inputFingerprint,
      observedAt: 100,
      kind: "none" as const,
      blocker: "no_donor" as const,
      coverage: "none" as const,
      capacity: "unknown" as const,
      predictedStagingEligibility: "unknown" as const,
    };
    const bothNoRoute = runSynthesisLogisticsShadow({
      ...baseMatcherInput,
      demands: [receiverVetoDemand],
      rooms: receiverVetoRooms,
      legacyDecisions: [legacyNoRoute],
      candidateBudget: 256,
    });
    expect(bothNoRoute.comparisons).toEqual([
      expect.objectContaining({
        status: "different",
        classification: "expected_policy_difference",
        differences: ["capacity", "blocker"],
        shadow: expect.objectContaining({
          reason: "receiver_capacity",
          candidateTrace: {
            donorCount: 2,
            evaluatedCount: 2,
            feasibleCount: 0,
            rejectedCount: 2,
            selectedRejection: "receiver_capacity",
            rejectionCounts: [
              ["receiver_capacity", 1],
              ["same_room", 1],
            ],
            receiver: {
              kind: "present",
              receiverEligible: false,
              storageHeadroom: 100,
              terminalHeadroom: 100,
              resourceHeadroom: 100,
            },
          },
        }),
      }),
    ]);
    expect(bothNoRoute.comparisons[0].classification).not.toBe(
      "unsafe_candidate",
    );

    const shadowOnlyRoute = runSynthesisLogisticsShadow({
      ...baseMatcherInput,
      demands: [receiverVetoDemand],
      rooms: receiverVetoRooms.map((room) => ({
        ...room,
        receiverEligible: true,
      })),
      legacyDecisions: [{
        ...legacyNoRoute,
        blocker: "receiver_capacity",
        capacity: "blocked",
      }],
      candidateBudget: 256,
    });
    expect(shadowOnlyRoute.comparisons).toEqual([
      expect.objectContaining({
        status: "different",
        classification: "legacy_unpaired",
        differences: ["legacy_missing"],
        shadow: expect.objectContaining({
          sourceRoom: "A",
          candidateTrace: expect.objectContaining({
            feasibleCount: 1,
            topSourceRoom: "A",
          }),
        }),
      }),
    ]);

    const rankDemand = makeDemand("rank-difference", "T1", xResource);
    const traceTransactionCost = jest.fn(() => 0);
    const rankInput: SynthesisShadowMatcherInput = {
      ...baseMatcherInput,
      demands: [rankDemand],
      legacyDecisions: [makeLegacyRouteDecision(rankDemand, "B")],
      transactionCost: traceTransactionCost,
    };
    const rankDifference = runSynthesisLogisticsShadow({
      ...rankInput,
      candidateBudget: 256,
    });
    expect(rankDifference.comparisons).toEqual([
      expect.objectContaining({
        status: "different",
        classification: "expected_policy_difference",
        differences: ["source"],
        shadow: expect.objectContaining({
          sourceRoom: "A",
          candidateTrace: {
            donorCount: 4,
            evaluatedCount: 4,
            feasibleCount: 2,
            rejectedCount: 2,
            rejectionCounts: [
              ["source_not_allowed", 1],
              ["same_room", 1],
            ],
            topSourceRoom: "A",
            legacySource: {
              sourceRoom: "B",
              disposition: "feasible_lower_rank",
            },
            receiver: {
              kind: "present",
              receiverEligible: true,
              storageHeadroom: 100,
              terminalHeadroom: 100,
              resourceHeadroom: 100,
            },
          },
        }),
      }),
    ]);
    expect(traceTransactionCost).toHaveBeenCalledTimes(
      rankDifference.metrics.transactionCostEvaluations,
    );
    expect(runPagedShadowMatcher(rankInput, 1).decisions).toEqual(
      rankDifference.decisions,
    );
    const rankTracePage = runSynthesisLogisticsShadow({
      ...rankInput,
      candidateBudget: 2,
    });
    expect(rankTracePage.continuation).toEqual(expect.objectContaining({
      schemaVersion: 2,
      partialLegacySourceEvaluation: {
        sourceRoom: "B",
        outcome: "feasible",
      },
    }));
    const tamperedRankTrace = {
      ...rankTracePage.continuation!,
      partialLegacySourceEvaluation: {
        sourceRoom: "B",
        outcome: "rejected" as const,
        rejection: "source_protection" as const,
      },
    };
    expect(runSynthesisLogisticsShadow({
      ...rankInput,
      candidateBudget: 2,
      continuation: tamperedRankTrace,
    }).metrics.continuationInvalidated).toBe(true);

    const boundedDonorNames = Array.from(
      { length: 15 },
      (_, index) => `D${index.toString().padStart(2, "0")}`,
    );
    const boundedDemand = makeDemand(
      "bounded-rejections",
      "T16",
      xResource,
      60,
      boundedDonorNames,
    );
    const boundedInput: SynthesisShadowMatcherInput = {
      ...baseMatcherInput,
      demands: [boundedDemand],
      rooms: [
        ...boundedDonorNames.map((roomName) =>
          createShadowMatcherRoom(roomName, [{
            resource: xResource,
            sourceAvailableAmount: 0,
            sourceTerminalAmount: 0,
            receiverResourceHeadroom: 100,
          }])
        ),
        createShadowMatcherRoom("T16", [{
          resource: xResource,
          sourceAvailableAmount: 0,
          sourceTerminalAmount: 0,
          receiverResourceHeadroom: 100,
        }]),
      ],
      transactionCost: jest.fn(() => 0),
    };
    const boundedRejections = runSynthesisLogisticsShadow({
      ...boundedInput,
      candidateBudget: 256,
    });
    expect(boundedRejections.unmatched).toEqual([
      expect.objectContaining({
        reason: "source_protection",
        candidateTrace: expect.objectContaining({
          donorCount: 16,
          evaluatedCount: 16,
          feasibleCount: 0,
          rejectedCount: 16,
          selectedRejection: "source_protection",
          rejectionCounts: [
            ["source_protection", 15],
            ["same_room", 1],
          ],
        }),
      }),
    ]);
    expect(runPagedShadowMatcher(boundedInput, 1).unmatched).toEqual(
      boundedRejections.unmatched,
    );

    const yResource = RESOURCE_ZYNTHIUM;
    const sharedReceiver = runSynthesisLogisticsShadow({
      ...baseMatcherInput,
      demands: [
        makeDemand("shared-X", "T", xResource, 80, ["A"]),
        makeDemand("shared-Y", "T", yResource, 80, ["B"]),
      ],
      rooms: [
        createShadowMatcherRoom("A", [{
          resource: xResource,
          sourceAvailableAmount: 100,
          sourceTerminalAmount: 100,
          receiverResourceHeadroom: 100,
        }]),
        createShadowMatcherRoom("B", [{
          resource: yResource,
          sourceAvailableAmount: 100,
          sourceTerminalAmount: 100,
          receiverResourceHeadroom: 100,
        }]),
        createShadowMatcherRoom("T", [
          {
            resource: xResource,
            sourceAvailableAmount: 0,
            sourceTerminalAmount: 0,
            receiverResourceHeadroom: 100,
          },
          {
            resource: yResource,
            sourceAvailableAmount: 0,
            sourceTerminalAmount: 0,
            receiverResourceHeadroom: 100,
          },
        ], { receiverHeadroom: 100 }),
      ],
      candidateBudget: 256,
    });
    expect(sharedReceiver.decisions.reduce(
      (total, decision) => total + decision.amount,
      0,
    )).toBe(100);

    const sharedFee = runSynthesisLogisticsShadow({
      ...baseMatcherInput,
      demands: [
        makeDemand("fee-X", "T", xResource, 50, ["A"]),
        makeDemand("fee-Y", "T", yResource, 50, ["A"]),
      ],
      rooms: [
        createShadowMatcherRoom("A", [
          {
            resource: xResource,
            sourceAvailableAmount: 100,
            sourceTerminalAmount: 100,
            receiverResourceHeadroom: 100,
          },
          {
            resource: yResource,
            sourceAvailableAmount: 100,
            sourceTerminalAmount: 100,
            receiverResourceHeadroom: 100,
          },
        ], { actionEnergyBudget: 10, terminalActionEnergyAmount: 10 }),
        createShadowMatcherRoom("T", [
          {
            resource: xResource,
            sourceAvailableAmount: 0,
            sourceTerminalAmount: 0,
            receiverResourceHeadroom: 100,
          },
          {
            resource: yResource,
            sourceAvailableAmount: 0,
            sourceTerminalAmount: 0,
            receiverResourceHeadroom: 100,
          },
        ], { receiverHeadroom: 100 }),
      ],
      transactionCost: () => 7,
      candidateBudget: 256,
    });
    expect(sharedFee.decisions).toHaveLength(1);
    expect(sharedFee.unmatched).toEqual([
      expect.objectContaining({ reason: "fee_budget" }),
    ]);

    const actionBatchInput: SynthesisShadowMatcherInput = {
      ...baseMatcherInput,
      demands: [makeDemand("action-batch", "T", xResource, 400, ["A"])],
      rooms: [
        {
          ...createShadowMatcherRoom("A", [{
            resource: xResource,
            sourceAvailableAmount: 500,
            sourceTerminalAmount: 500,
            receiverResourceHeadroom: 500,
          }], { receiverHeadroom: 500 }),
          transferBatchSize: 300,
        },
        createShadowMatcherRoom("T", [{
          resource: xResource,
          sourceAvailableAmount: 0,
          sourceTerminalAmount: 0,
          receiverResourceHeadroom: 500,
        }], { receiverHeadroom: 500 }),
      ],
      transactionCost: (amount) => Math.ceil(amount / 10),
    };
    const actionBatch = runSynthesisLogisticsShadow({
      ...actionBatchInput,
      candidateBudget: 256,
    });
    expect(actionBatch.decisions).toEqual([
      expect.objectContaining({
        amount: 400,
        actionAmount: 300,
        transactionCost: 30,
        requiredEnergy: 30,
        energyCommitmentAmount: 30,
      }),
    ]);

    const energyInput: SynthesisShadowMatcherInput = {
      ...baseMatcherInput,
      demands: [
        makeDemand("energy-1", "T1", RESOURCE_ENERGY, 400, ["S"]),
        makeDemand("energy-2", "T2", RESOURCE_ENERGY, 200, ["S"]),
      ],
      rooms: [
        {
          ...createShadowMatcherRoom("S", [{
            resource: RESOURCE_ENERGY,
            sourceAvailableAmount: 1_000,
            sourceTerminalAmount: 1_000,
            receiverResourceHeadroom: 1_000,
          }], {
            receiverHeadroom: 1_000,
            actionEnergyBudget: 500,
            terminalActionEnergyAmount: 500,
          }),
          transferBatchSize: 300,
        },
        createShadowMatcherRoom("T1", [{
          resource: RESOURCE_ENERGY,
          sourceAvailableAmount: 0,
          sourceTerminalAmount: 0,
          receiverResourceHeadroom: 1_000,
        }], {
          receiverHeadroom: 1_000,
          actionEnergyBudget: 0,
          terminalActionEnergyAmount: 0,
        }),
        createShadowMatcherRoom("T2", [{
          resource: RESOURCE_ENERGY,
          sourceAvailableAmount: 0,
          sourceTerminalAmount: 0,
          receiverResourceHeadroom: 1_000,
        }], {
          receiverHeadroom: 1_000,
          actionEnergyBudget: 0,
          terminalActionEnergyAmount: 0,
        }),
      ],
      transactionCost: () => 10,
    };
    const sharedEnergy = runSynthesisLogisticsShadow({
      ...energyInput,
      candidateBudget: 256,
    });
    expect(sharedEnergy.decisions.map((decision) => ({
      amount: decision.amount,
      actionAmount: decision.actionAmount,
      requiredEnergy: decision.requiredEnergy,
      energyCommitmentAmount: decision.energyCommitmentAmount,
    }))).toEqual([
      {
        amount: 400,
        actionAmount: 300,
        requiredEnergy: 310,
        energyCommitmentAmount: 410,
      },
      {
        amount: 80,
        actionAmount: 80,
        requiredEnergy: 90,
        energyCommitmentAmount: 90,
      },
    ]);
    expect(sharedEnergy.decisions.reduce(
      (total, decision) => total + decision.energyCommitmentAmount,
      0,
    )).toBe(500);
    for (const budget of [1, 2, 3, 5]) {
      const pagedEnergy = runPagedShadowMatcher(energyInput, budget);
      expect(pagedEnergy.decisions).toEqual(sharedEnergy.decisions);
      expect(pagedEnergy.unmatched).toEqual(sharedEnergy.unmatched);
      expect(pagedEnergy.metrics.totalCandidateEvaluations).toBe(
        sharedEnergy.metrics.totalCandidateEvaluations,
      );
      expect(pagedEnergy.metrics.totalTransactionCostEvaluations).toBe(
        sharedEnergy.metrics.totalTransactionCostEvaluations,
      );
    }

    const mergeDemand = makeDemand(
      "merge-delta",
      "T",
      xResource,
      300,
      ["A"],
    );
    const mergeComparison = runSynthesisLogisticsShadow({
      ...actionBatchInput,
      demands: [mergeDemand],
      legacyDecisions: [{
        comparisonKey: mergeDemand.comparisonKey,
        epochRevision: mergeDemand.epochRevision,
        epochFingerprint: mergeDemand.epochFingerprint,
        inputRevision: mergeDemand.revision,
        inputFingerprint: mergeDemand.inputFingerprint,
        observedAt: 100,
        kind: "route",
        actionBasis: "merge_delta",
        remainingBefore: 300,
        transferBatchSize: 300,
        route: {
          sourceRoom: "A",
          targetRoom: "T",
          resource: xResource,
          amount: 300,
          actionAmount: 0,
          priorityClass: "production",
          coverage: "covered",
          capacity: "eligible",
          predictedStagingEligibility: "eligible",
          terminalReadyAt: 100,
          transactionCost: 0,
          requiredEnergy: 0,
          energyCommitmentAmount: 0,
          terminalAllocatedAmount: 0,
          stagingRequiredAmount: 0,
          terminalEnergyAllocatedAmount: 0,
          feeStagingRequiredAmount: 0,
          stableKey: `A\u0000T\u0000${xResource}\u0000merge-delta`,
        },
      }],
      transactionCost: () => 10,
      candidateBudget: 256,
    });
    expect(mergeComparison.comparisons).toEqual([
      expect.objectContaining({
        status: "different",
        classification: "expected_policy_difference",
        differences: ["amount", "staging", "cost"],
      }),
    ]);

    const coveredDemands = Array.from({ length: 21 }, (_, index) => ({
      ...makeDemand(`covered-${index}`, "T", xResource, 10, []),
      localAmount: 10,
    }));
    const fullComparisonAggregation = runSynthesisLogisticsShadow({
      ...baseMatcherInput,
      demands: coveredDemands,
      rooms: [createShadowMatcherRoom("T", [{
        resource: xResource,
        sourceAvailableAmount: 0,
        sourceTerminalAmount: 0,
        receiverResourceHeadroom: 1_000,
      }], {
        receiverHeadroom: 1_000,
        actionEnergyBudget: 0,
        terminalActionEnergyAmount: 0,
      })],
      legacyDecisions: coveredDemands.map((demand) => ({
        comparisonKey: demand.comparisonKey,
        epochRevision: demand.epochRevision,
        epochFingerprint: demand.epochFingerprint,
        inputRevision: demand.revision,
        inputFingerprint: demand.inputFingerprint,
        observedAt: 100,
        kind: "none" as const,
        blocker: "demand_already_covered" as const,
        coverage: "covered" as const,
        capacity: "unknown" as const,
        predictedStagingEligibility: "unknown" as const,
      })),
      transactionCost: () => 0,
      candidateBudget: 256,
    });
    expect(fullComparisonAggregation).toEqual(expect.objectContaining({
      complete: true,
      comparisons: expect.arrayContaining([
        expect.objectContaining({ status: "equal" }),
      ]),
      metrics: expect.objectContaining({
        comparisonCount: 21,
        equalCount: 21,
        differentCount: 0,
        unresolvedCount: 0,
      }),
    }));
    expect(fullComparisonAggregation.comparisons).toHaveLength(21);
  });
});
