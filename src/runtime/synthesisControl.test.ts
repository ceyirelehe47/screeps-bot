import { cadenceOffset, isDue } from "@/runtime/cadence";
const cadenceTick = (tick: number): number => tick + cadenceOffset("resourceControl.plan", 10);
import {
  getLastSynthesisTransferTaskIndexDiagnostics,
  runSynthesisControl,
  pauseSynthesisForBoost,
  resumeSynthesisAfterBoost,
} from "@/runtime/synthesisControl";
import {
  countPendingIncomingResourceTransferTasksByRoom,
  createAutomaticResourceTransferTask,
  createResourceTransferTask,
  ensureResourceTransferTaskStore,
  getResourceTransferTaskListSorted,
  markResourceTransferTaskBlocked,
} from "@/runtime/logistics/resourceTransferTasks";
import {
  SYNTHESIS_ROOM_LOGISTICS_PRODUCER,
  peekLogisticsControlStore,
} from "@/runtime/logistics/logisticsControl";
import {
  getLogisticsShadowCpuDiagnosticsForTest,
  measureLogisticsShadowCpu,
  peekLogisticsShadowCpuSnapshot,
  resetLogisticsShadowCpuForTest,
} from "@/runtime/logistics/logisticsShadowCpu";
import {
  clearCarrierTaskBoardForTest,
  peekCarrierTaskBoard,
} from "@/runtime/carrierTaskBoard";
import {
  clearLocalCarrierDestinationCapacityForTest,
  getLocalCarrierDestinationCapacityObservation,
} from "@/runtime/localCarrierDestinationCapacity";
import {
  clearMarketActionArbiterForTest,
  getMarketAccountClaim,
  getMarketActionJournal,
  getTerminalActionClaims,
} from "@/runtime/marketActionArbiter";
import { runResourceControl } from "@/runtime/resourceControl";
import { resetRuntimeIsolationForTest } from "@/runtime/runtimeIsolation";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

type GameWithPartialMarket = Omit<Game, "market"> & {
  market: Partial<Market> & {
    calcTransactionCost: (amount: number, fromRoom: string, toRoom: string) => number;
  };
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createLab(room: Room, id: string): StructureLab {
  return {
    id,
    room,
    structureType: STRUCTURE_LAB,
    pos: {
      inRangeTo: () => true,
    } as unknown as RoomPosition,
    store: {
      getUsedCapacity: () => 0,
    },
    runReaction: jest.fn(() => OK),
    cooldown: 0,
  } as unknown as StructureLab;
}

function createRoomWithResources(options: {
  name: string;
  mineralType: MineralConstant;
  storageEnergy?: number;
  terminalResources?: Partial<Record<ResourceConstant, number>>;
}): Room {
  const terminalResources = options.terminalResources || {};
  const room = {
    name: options.name,
    controller: { my: true, level: 8 } as StructureController,
    storage: {
      id: `${options.name}-storage`,
      structureType: STRUCTURE_STORAGE,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (resource === RESOURCE_ENERGY) {
            return options.storageEnergy ?? 0;
          }
          return 0;
        },
        getFreeCapacity: () => 100000,
      },
    } as unknown as StructureStorage,
    terminal: {
      id: `${options.name}-terminal`,
      structureType: STRUCTURE_TERMINAL,
      cooldown: 0,
      send: jest.fn(() => OK),
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => {
          if (resource && resource in terminalResources) {
            return terminalResources[resource]!;
          }
          return 0;
        },
        getFreeCapacity: () => 100000,
      },
    } as unknown as StructureTerminal,
  } as Room;

  const labs = [
    createLab(room, `${options.name}-lab-1`),
    createLab(room, `${options.name}-lab-2`),
    createLab(room, `${options.name}-lab-3`),
  ];
  room.find = ((type: FindConstant, opts?: { filter?: (structure: Structure) => boolean }) => {
    if (type === FIND_MINERALS) {
      return [{ id: `${options.name}-mineral`, mineralType: options.mineralType, room } as Mineral];
    }
    if (type === FIND_MY_STRUCTURES) {
      return opts?.filter ? labs.filter((structure) => opts.filter?.(structure)) : labs;
    }
    return [];
  }) as Room["find"];
  return room;
}

function captureSynthesisShadowAuthorityBoundaryState(rooms: readonly Room[]): {
  readonly terminalSendCalls: number;
  readonly marketDealCalls: number;
  readonly state: unknown;
} {
  const resourceTasks = getResourceTransferTaskListSorted()
    .map((task) => ({ ...task }))
    .sort((left, right) => {
      const leftKey = JSON.stringify([
        left.fromRoomName,
        left.toRoomName,
        left.resource,
        left.reason ?? null,
        left.origin,
        left.createdAt,
        left.amount,
      ]);
      const rightKey = JSON.stringify([
        right.fromRoomName,
        right.toRoomName,
        right.resource,
        right.reason ?? null,
        right.origin,
        right.createdAt,
        right.amount,
      ]);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  const taskIdAliases = resourceTasks
    .map((task, index) => [task.id, `resource-task-${index}`] as const)
    .sort((left, right) => right[0].length - left[0].length);
  const normalizeTaskIdentity = (value: unknown): unknown => {
    if (typeof value === "string") {
      return taskIdAliases.reduce(
        (normalized, [taskId, alias]) => normalized.split(taskId).join(alias),
        value,
      );
    }
    if (Array.isArray(value)) return value.map(normalizeTaskIdentity);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      normalizeTaskIdentity(key) as string,
      normalizeTaskIdentity(entry),
    ]));
  };
  const memory = JSON.parse(JSON.stringify(Memory)) as {
    data?: { resourceControl?: { logistics?: unknown } };
    runtime?: { resourceControl?: { logistics?: unknown } };
  };
  if (memory.data?.resourceControl) delete memory.data.resourceControl.logistics;
  if (memory.runtime?.resourceControl) delete memory.runtime.resourceControl.logistics;

  const terminalSendCalls = rooms.reduce(
    (count, room) =>
      count + ((room.terminal?.send as jest.Mock | undefined)?.mock.calls.length ?? 0),
    0,
  );
  const marketDealCalls = ((Game.market.deal as jest.Mock | undefined)?.mock.calls.length ?? 0);
  const state = {
    resourceTasks,
    synthesis: memory.runtime && "synthesisControl" in memory.runtime
      ? memory.runtime.synthesisControl
      : undefined,
    carrierBoard: peekCarrierTaskBoard(),
    terminalClaims: getTerminalActionClaims(),
    marketAccountClaim: getMarketAccountClaim(),
    marketJournal: getMarketActionJournal(),
    receiverReservations: rooms.flatMap((room) =>
      [room.storage, room.terminal]
        .filter((structure): structure is StructureStorage | StructureTerminal => !!structure)
        .map((structure) =>
          getLocalCarrierDestinationCapacityObservation(room.name, structure.id),
        ),
    ),
    structures: rooms.map((room) => ({
      roomName: room.name,
      terminalCooldown: room.terminal?.cooldown,
      storageTotal: room.storage?.store.getUsedCapacity() ?? 0,
      terminalTotal: room.terminal?.store.getUsedCapacity() ?? 0,
      resources: RESOURCES_ALL.map((resource) => ({
        resource,
        storage: room.storage?.store.getUsedCapacity(resource) ?? 0,
        terminal: room.terminal?.store.getUsedCapacity(resource) ?? 0,
      })).filter((entry) => entry.storage > 0 || entry.terminal > 0),
    })),
    memory,
  };
  return {
    terminalSendCalls,
    marketDealCalls,
    state: normalizeTaskIdentity(state),
  };
}

function runSynthesisResourceControlAuthorityTwin(
  mode: "disabled" | "shadow",
): ReturnType<typeof captureSynthesisShadowAuthorityBoundaryState> & {
  readonly synthesisProducerCpu: ReturnType<
    typeof peekLogisticsShadowCpuSnapshot
  >;
  readonly synthesisProducerCpuDiagnostics: ReturnType<
    typeof getLogisticsShadowCpuDiagnosticsForTest
  >;
  readonly producerCpu: ReturnType<typeof peekLogisticsShadowCpuSnapshot>;
  readonly producerCpuDiagnostics: ReturnType<
    typeof getLogisticsShadowCpuDiagnosticsForTest
  >;
} {
  clearCarrierTaskBoardForTest();
  clearMarketActionArbiterForTest();
  clearLocalCarrierDestinationCapacityForTest();
  resetLogisticsShadowCpuForTest();
  resetRuntimeServices();
  Game.time = cadenceTick(10);
  Memory.cfg = {
    synthesisControl: {
      enabled: true,
      sampleInterval: 10,
      rooms: {
        W1N1: {
          reactions: [{ product: RESOURCE_UTRIUM_HYDRIDE, targetAmount: 5_000 }],
        },
      },
    },
    resourceControl: {
      enabled: true,
      sampleInterval: 10,
      market: { enabled: false },
      rooms: {
        W2N1: { transferBatchSize: 300 },
      },
    },
  };
  (Memory.cfg.resourceControl as unknown as {
    logistics: { schemaVersion: 1; mode: "disabled" | "shadow"; canaryScopes: [] };
  }).logistics = { schemaVersion: 1, mode, canaryScopes: [] };
  // 两次实验从同一持久队列身份开始，只让 mode 成为变量；仍比较全部事件和游标。
  Memory.runtime = { events: { epoch: "synthesis-authority-twin", nextSequence: 1, dropped: 0, entries: [] } };
  Memory.rooms = {};
  Memory.data = undefined;
  Game.spawns = {};
  let cpuUsed = 0;
  (Game as unknown as { cpu: { getUsed(): number } }).cpu = {
    getUsed: () => {
      cpuUsed += 0.125;
      return cpuUsed;
    },
  };
  (Game as GameWithPartialMarket).market = {
    calcTransactionCost: jest.fn((amount: number) => amount),
    getAllOrders: jest.fn(() => []),
    deal: jest.fn(() => OK),
  };

  const hubRoom = createRoomWithResources({
    name: "W1N1",
    mineralType: RESOURCE_UTRIUM,
    storageEnergy: 300_000,
  });
  const donorRoom = createRoomWithResources({
    name: "W2N1",
    mineralType: RESOURCE_HYDROGEN,
    storageEnergy: 300_000,
    terminalResources: {
      [RESOURCE_UTRIUM]: 10_000,
      [RESOURCE_HYDROGEN]: 10_000,
    },
  });
  Game.rooms = { [hubRoom.name]: hubRoom, [donorRoom.name]: donorRoom };

  const mergeResult = createAutomaticResourceTransferTask(
    donorRoom.name,
    hubRoom.name,
    RESOURCE_HYDROGEN,
    100,
    `synthesis:${hubRoom.name}:${RESOURCE_UTRIUM_HYDRIDE}`,
  );
  if (typeof mergeResult === "string") throw new Error("unexpected merge seed task failure");
  const expiredResult = createAutomaticResourceTransferTask(
    donorRoom.name,
    hubRoom.name,
    RESOURCE_UTRIUM,
    400,
    `synthesis:${hubRoom.name}:${RESOURCE_UTRIUM_HYDRIDE}`,
  );
  if (typeof expiredResult === "string") throw new Error("unexpected expired seed task failure");
  markResourceTransferTaskBlocked(expiredResult.task, "receiver_capacity");
  Game.time += 500;
  const hubImportResult = createResourceTransferTask(
    donorRoom.name,
    hubRoom.name,
    RESOURCE_UTRIUM,
    200,
    `hub:import:${RESOURCE_UTRIUM}`,
  );
  if (typeof hubImportResult === "string") throw new Error("unexpected hub import seed failure");

  runSynthesisControl();
  const synthesisProducerCpu = peekLogisticsShadowCpuSnapshot();
  const synthesisProducerCpuDiagnostics =
    getLogisticsShadowCpuDiagnosticsForTest();
  runResourceControl();
  const producerCpu = peekLogisticsShadowCpuSnapshot();
  const producerCpuDiagnostics = getLogisticsShadowCpuDiagnosticsForTest();

  // mode 是唯一实验输入；归一化后只允许两个 logistics owner 分支不同。
  (Memory.cfg.resourceControl as unknown as { logistics: { mode: "shadow" } })
    .logistics.mode = "shadow";
  return {
    ...captureSynthesisShadowAuthorityBoundaryState([hubRoom, donorRoom]),
    synthesisProducerCpu,
    synthesisProducerCpuDiagnostics,
    producerCpu,
    producerCpuDiagnostics,
  };
}

describe("runSynthesisControl hub import guard", () => {
  beforeEach(() => {
    resetLogisticsShadowCpuForTest();
    resetRuntimeServices();
    Game.time = cadenceTick(10);
    Memory.cfg = {
      synthesisControl: {
        enabled: true,
        sampleInterval: 10,
        rooms: {
          W1N1: {
            reactions: [
              {
                product: RESOURCE_UTRIUM_HYDRIDE,
                targetAmount: 5000,
              },
            ],
          },
        },
      },
      resourceControl: {
        enabled: true,
        sampleInterval: 10,
        rooms: {
          W2N1: {
            transferBatchSize: 300,
          },
        },
      },
    };
    (Memory.cfg.resourceControl as unknown as {
      logistics: { schemaVersion: 1; mode: "shadow"; canaryScopes: [] };
    }).logistics = {
      schemaVersion: 1,
      mode: "shadow",
      canaryScopes: [],
    };
    Memory.runtime = undefined;
    Memory.rooms = {};
    Memory.data = undefined;
    Game.rooms = {};
    Game.spawns = {};
    (Game as unknown as { cpu: { getUsed(): number } }).cpu = {
      getUsed: () => 0,
    };
    (Game as GameWithPartialMarket).market = {
      calcTransactionCost: () => 0,
    };
  });

  it("creates synthesis transfer for the live deficit while expired capacity tasks remain raw pending", () => {
    (Game as GameWithPartialMarket).market.calcTransactionCost = (amount) => amount;
    const hubRoom = createRoomWithResources({
      name: "W1N1",
      mineralType: RESOURCE_UTRIUM,
      storageEnergy: 300000,
    });
    const donorRoom = createRoomWithResources({
      name: "W2N1",
      mineralType: RESOURCE_HYDROGEN,
      storageEnergy: 300000,
      terminalResources: {
        [RESOURCE_UTRIUM]: 10000,
        [RESOURCE_HYDROGEN]: 10000,
      },
    });
    Game.rooms[hubRoom.name] = hubRoom;
    Game.rooms[donorRoom.name] = donorRoom;

    const mergeResult = createAutomaticResourceTransferTask(
      donorRoom.name,
      hubRoom.name,
      RESOURCE_HYDROGEN,
      100,
      `synthesis:${hubRoom.name}:${RESOURCE_UTRIUM_HYDRIDE}`,
    );
    if (typeof mergeResult === "string") throw new Error("unexpected merge seed task creation failure");

    const expiredResult = createAutomaticResourceTransferTask(
      donorRoom.name,
      hubRoom.name,
      RESOURCE_UTRIUM,
      400,
      `synthesis:${hubRoom.name}:${RESOURCE_UTRIUM_HYDRIDE}`,
    );
    if (typeof expiredResult === "string") throw new Error("unexpected automatic task creation failure");
    markResourceTransferTaskBlocked(expiredResult.task, "receiver_capacity");
    Game.time += 500;

    const hubImportResult = createResourceTransferTask(
      donorRoom.name,
      hubRoom.name,
      RESOURCE_UTRIUM,
      200,
      `hub:import:${RESOURCE_UTRIUM}`,
    );
    expect(hubImportResult).not.toBe("string" as never);

    runSynthesisControl();

    expect(getLastSynthesisTransferTaskIndexDiagnostics()).toEqual({
      storeScanCount: 0,
      reusedInputCount: 1,
      mergeSnapshotLookupCount: 2,
    });

    const tasks = ensureResourceTransferTaskStore();
    const allTasks = Object.values(tasks);

    const synthesisTasks = allTasks.filter(
      (t) => t.status === "pending" && t.reason?.startsWith("synthesis:"),
    );
    const utriumSynthesisTasks = synthesisTasks.filter(
      (t) => t.resource === RESOURCE_UTRIUM && t.id !== expiredResult.task.id,
    );
    expect(expiredResult.task.amount).toBe(400);
    expect(utriumSynthesisTasks).toHaveLength(1);
    expect(utriumSynthesisTasks[0].amount).toBe(300);
    expect(mergeResult.task.amount).toBe(500);
    expect(mergeResult.task.remainingAmount).toBe(500);
    expect(countPendingIncomingResourceTransferTasksByRoom(hubRoom.name)).toBe(4);
    expect(Memory.runtime!.synthesisControl!.rooms[hubRoom.name].pendingTasks).toBe(3);

    const shadow = peekLogisticsControlStore();
    expect(shadow).toEqual(expect.objectContaining({ ok: true }));
    if (!shadow.ok) return;
    const intents = Object.values(shadow.store.latestIntents).filter(
      (intent) => intent.producer === SYNTHESIS_ROOM_LOGISTICS_PRODUCER,
    );
    const observations = Object.values(shadow.store.synthesisObservations).filter(
      (observation) => observation.producer === SYNTHESIS_ROOM_LOGISTICS_PRODUCER,
    );
    expect(intents).toHaveLength(2);
    expect(observations).toHaveLength(2);
    expect(observations.map((observation) => observation.decisionOrder).sort((a, b) => a - b))
      .toEqual([0, 1]);
    const publishedSnapshot = Object.values(shadow.store.producerSnapshots).find(
      (snapshot) => snapshot.producer === SYNTHESIS_ROOM_LOGISTICS_PRODUCER,
    );
    expect(publishedSnapshot).toEqual(expect.objectContaining({
      producer: SYNTHESIS_ROOM_LOGISTICS_PRODUCER,
      observedAt: cadenceTick(510),
      expiresAt: cadenceTick(540),
      epochRevision: expect.stringContaining(`synthesis-room-epoch/v1:${cadenceTick(510)}:`),
      epochFingerprint: expect.stringContaining("synthesis-room-epoch/v1:"),
      captureCpuUsed: expect.any(Number),
      indexBuildCount: 1,
      total: 2,
      emitted: 2,
      dropped: 0,
      limit: 32,
      truncated: false,
    }));
    expect(publishedSnapshot!.captureCpuUsed).toBeGreaterThanOrEqual(0);
    expect(Object.values(shadow.store.roomFacts)).toHaveLength(2);
    expect(Object.values(shadow.store.roomFacts).every((fact) =>
      fact.epochRevision === publishedSnapshot!.epochRevision
      && fact.epochFingerprint === publishedSnapshot!.epochFingerprint
      && fact.observedAt === publishedSnapshot!.observedAt
    )).toBe(true);

    const utriumIntent = intents.find((intent) => intent.resource === RESOURCE_UTRIUM)!;
    const hydrogenIntent = intents.find((intent) => intent.resource === RESOURCE_HYDROGEN)!;
    const utriumObservation = observations.find((entry) => entry.intentId === utriumIntent.id)!;
    const hydrogenObservation = observations.find((entry) => entry.intentId === hydrogenIntent.id)!;
    expect(utriumIntent).toEqual(expect.objectContaining({
      active: true,
      desiredAmount: 500,
      priorityClass: "production",
      revision: 1,
      observedAt: cadenceTick(510),
    }));
    expect(utriumObservation).toEqual(expect.objectContaining({
      localAmount: 0,
      incomingAmount: 200,
      uncoveredAmount: 300,
      legacyDecision: "created",
      legacyPriorityRank: 2,
      legacyPriorityClass: "production",
      legacyTaskId: utriumSynthesisTasks[0].id,
      legacyAmount: 300,
      legacyAddedAmount: 300,
      legacyRemainingBefore: 0,
      legacyFeeDelta: 300,
    }));
    expect(utriumObservation.inputFingerprint).toMatch(/^synthesis-shadow\/v1:/);
    expect(hydrogenIntent).toEqual(expect.objectContaining({
      active: true,
      desiredAmount: 500,
      revision: 1,
      observedAt: cadenceTick(510),
    }));
    expect(hydrogenObservation).toEqual(expect.objectContaining({
      localAmount: 0,
      incomingAmount: 100,
      uncoveredAmount: 400,
      legacyDecision: "merged",
      legacyTaskId: mergeResult.task.id,
      legacyAmount: 400,
      legacyAddedAmount: 400,
      legacyRemainingBefore: 100,
      // ResourceControl only commits one 300-unit fee batch: 300 - 100, not the 400 added amount.
      legacyFeeDelta: 200,
    }));

    Game.time = cadenceTick(520);
    runSynthesisControl();
    const coveredShadow = peekLogisticsControlStore();
    expect(coveredShadow).toEqual(expect.objectContaining({ ok: true }));
    if (!coveredShadow.ok) return;
    const coveredIntents = Object.values(coveredShadow.store.latestIntents).filter(
      (intent) => intent.producer === SYNTHESIS_ROOM_LOGISTICS_PRODUCER,
    );
    const coveredObservations = Object.values(coveredShadow.store.synthesisObservations).filter(
      (observation) => observation.producer === SYNTHESIS_ROOM_LOGISTICS_PRODUCER,
    );
    expect(coveredIntents).toHaveLength(2);
    expect(coveredIntents.every(
      (intent) => intent.active && intent.revision === 1 && intent.observedAt === cadenceTick(520),
    )).toBe(true);
    expect(coveredObservations).toHaveLength(2);
    expect(coveredObservations.every(
      (observation) => observation.incomingAmount === 500
        && observation.uncoveredAmount === 0
        && observation.legacyDecision === "no_op"
        && observation.legacyAddedAmount === 0
        && observation.legacyFeeDelta === 0,
    )).toBe(true);
    expect(Object.values(coveredShadow.store.producerSnapshots).find(
      (snapshot) => snapshot.producer === SYNTHESIS_ROOM_LOGISTICS_PRODUCER,
    )).toEqual(expect.objectContaining({
      observedAt: cadenceTick(520),
      total: 2,
      emitted: 2,
      dropped: 0,
      truncated: false,
    }));
    expect(Object.values(ensureResourceTransferTaskStore())).toHaveLength(4);
    expect(mergeResult.task.amount).toBe(500);

    Memory.cfg.resourceControl!.sampleInterval = 15;
    Game.time = cadenceTick(530);
    runSynthesisControl();
    expect(getLastSynthesisTransferTaskIndexDiagnostics()).toEqual({
      storeScanCount: 1,
      reusedInputCount: 0,
      mergeSnapshotLookupCount: 0,
    });
    const misalignedShadow = peekLogisticsControlStore();
    expect(misalignedShadow).toEqual(expect.objectContaining({ ok: true }));
    if (!misalignedShadow.ok) return;
    expect(Object.values(misalignedShadow.store.latestIntents)).toHaveLength(2);
    expect(Object.values(misalignedShadow.store.producerSnapshots)[0])
      .toEqual(expect.objectContaining({ observedAt: cadenceTick(520), total: 2 }));

    Memory.cfg.synthesisControl!.rooms!.W1N1.reactions = [];
    const withdrawnAt = 540 + cadenceOffset("resourceControl.plan", 30);
    Game.time = withdrawnAt;
    runSynthesisControl();
    const withdrawnShadow = peekLogisticsControlStore();
    expect(withdrawnShadow).toEqual(expect.objectContaining({ ok: true }));
    if (!withdrawnShadow.ok) return;
    expect(Object.values(withdrawnShadow.store.latestIntents).filter(
      (intent) => intent.producer === SYNTHESIS_ROOM_LOGISTICS_PRODUCER,
    )).toHaveLength(0);
    expect(Object.values(withdrawnShadow.store.synthesisObservations).filter(
      (observation) => observation.producer === SYNTHESIS_ROOM_LOGISTICS_PRODUCER,
    )).toHaveLength(0);
    expect(Object.values(withdrawnShadow.store.producerSnapshots).find(
      (snapshot) => snapshot.producer === SYNTHESIS_ROOM_LOGISTICS_PRODUCER,
    )).toEqual(expect.objectContaining({
      observedAt: withdrawnAt,
      total: 0,
      emitted: 0,
      dropped: 0,
      truncated: false,
      indexBuildCount: 1,
    }));
    expect(withdrawnShadow.store.roomFacts).toEqual({});
    expect(Object.values(ensureResourceTransferTaskStore())).toHaveLength(4);
    expect(mergeResult.task.amount).toBe(500);

    const disabledAuthorityTwin = runSynthesisResourceControlAuthorityTwin("disabled");
    const shadowAuthorityTwin = runSynthesisResourceControlAuthorityTwin("shadow");
    expect(shadowAuthorityTwin.state).toEqual(disabledAuthorityTwin.state);
    expect(shadowAuthorityTwin.terminalSendCalls).toBe(
      disabledAuthorityTwin.terminalSendCalls,
    );
    expect(shadowAuthorityTwin.marketDealCalls).toBe(disabledAuthorityTwin.marketDealCalls);
    expect(disabledAuthorityTwin.synthesisProducerCpu).toBeUndefined();
    expect(disabledAuthorityTwin.synthesisProducerCpuDiagnostics).toBeUndefined();
    expect(shadowAuthorityTwin.synthesisProducerCpu).toEqual(expect.objectContaining({
      attributionVersion: 2,
      sampleTick: cadenceTick(510),
      measurementAvailable: true,
      producerUsed: expect.any(Number),
      consumerUsed: 0,
    }));
    expect(shadowAuthorityTwin.synthesisProducerCpu!.producerUsed).toBeGreaterThan(0);
    expect(shadowAuthorityTwin.synthesisProducerCpuDiagnostics).toEqual({
      sampleTick: cadenceTick(510),
      measurementAvailable: true,
      producerSegmentCount: 12,
      consumerSegmentCount: 0,
    });
    expect(disabledAuthorityTwin.producerCpu).toEqual(expect.objectContaining({
      producerUsed: 0,
      consumerUsed: expect.any(Number),
    }));
    expect(disabledAuthorityTwin.producerCpuDiagnostics).toEqual(expect.objectContaining({
      producerSegmentCount: 0,
      consumerSegmentCount: 1,
    }));
    expect(shadowAuthorityTwin.producerCpu).toEqual(expect.objectContaining({
      producerUsed: shadowAuthorityTwin.synthesisProducerCpu!.producerUsed,
      consumerUsed: expect.any(Number),
    }));

    // 同 segment 嵌套只由最外层计量；抛错仍通过 finally 守恒结算。
    resetLogisticsShadowCpuForTest();
    Game.time = cadenceTick(900);
    const cpuReadings = [0, 1, 2, 4, 5, 8];
    (Game as unknown as { cpu: { getUsed(): number } }).cpu = {
      getUsed: jest.fn(() => cpuReadings.shift()!),
    };
    measureLogisticsShadowCpu("producer", () => {
      measureLogisticsShadowCpu("producer", () => undefined);
    });
    measureLogisticsShadowCpu("producer", () => undefined);
    expect(() => measureLogisticsShadowCpu("producer", () => {
      throw new Error("producer-meter-test");
    })).toThrow("producer-meter-test");
    expect(peekLogisticsShadowCpuSnapshot()).toEqual({
      attributionVersion: 2,
      sampleTick: cadenceTick(900),
      measurementAvailable: true,
      producerUsed: 6,
      consumerUsed: 0,
    });

    Game.time = cadenceTick(901);
    expect(peekLogisticsShadowCpuSnapshot()).toBeUndefined();
    const backwardsReadings = [5, 4];
    (Game as unknown as { cpu: { getUsed(): number } }).cpu = {
      getUsed: () => backwardsReadings.shift()!,
    };
    measureLogisticsShadowCpu("producer", () => undefined);
    expect(peekLogisticsShadowCpuSnapshot()).toEqual({
      attributionVersion: 2,
      sampleTick: cadenceTick(901),
      measurementAvailable: false,
      producerUsed: 0,
      consumerUsed: 0,
    });

    Game.time = cadenceTick(902);
    (Game as unknown as { cpu: { getUsed(): number } }).cpu = {
      getUsed: () => {
        throw new Error("cpu-clock-unavailable");
      },
    };
    expect(measureLogisticsShadowCpu("producer", () => "work-preserved"))
      .toBe("work-preserved");
    expect(peekLogisticsShadowCpuSnapshot()).toEqual({
      attributionVersion: 2,
      sampleTick: cadenceTick(902),
      measurementAvailable: false,
      producerUsed: 0,
      consumerUsed: 0,
    });

    resetLogisticsShadowCpuForTest();
    Game.time = cadenceTick(903);
    const inFlightReadings = [0, 1];
    (Game as unknown as { cpu: { getUsed(): number } }).cpu = {
      getUsed: () => inFlightReadings.shift()!,
    };
    let inFlightSnapshot: ReturnType<typeof peekLogisticsShadowCpuSnapshot>;
    measureLogisticsShadowCpu("producer", () => {
      inFlightSnapshot = peekLogisticsShadowCpuSnapshot();
    });
    expect(inFlightSnapshot!).toBeUndefined();
    expect(peekLogisticsShadowCpuSnapshot()).toEqual(expect.objectContaining({
      measurementAvailable: true,
      producerUsed: 1,
    }));
    Game.time = cadenceTick(Number.NaN);
    expect(measureLogisticsShadowCpu("producer", () => "tick-unavailable"))
      .toBe("tick-unavailable");
    Game.time = cadenceTick(903);
    expect(peekLogisticsShadowCpuSnapshot()).toEqual(expect.objectContaining({
      measurementAvailable: false,
    }));

    resetLogisticsShadowCpuForTest();
    Game.time = cadenceTick(904);
    const interSegmentBackwardsReadings = [5, 6, 4, 5];
    (Game as unknown as { cpu: { getUsed(): number } }).cpu = {
      getUsed: () => interSegmentBackwardsReadings.shift()!,
    };
    measureLogisticsShadowCpu("producer", () => undefined);
    measureLogisticsShadowCpu("producer", () => undefined);
    expect(peekLogisticsShadowCpuSnapshot()).toEqual(expect.objectContaining({
      measurementAvailable: false,
    }));

    resetLogisticsShadowCpuForTest();
    Game.time = cadenceTick(905);
    const overlappingReadings = [0, 1];
    (Game as unknown as { cpu: { getUsed(): number } }).cpu = {
      getUsed: () => overlappingReadings.shift()!,
    };
    measureLogisticsShadowCpu("producer", () => {
      measureLogisticsShadowCpu("consumer", () => undefined);
    });
    expect(peekLogisticsShadowCpuSnapshot()).toEqual(expect.objectContaining({
      measurementAvailable: false,
      consumerUsed: 0,
    }));
  });
});

describe("synthesis boost pause/resume contract", () => {
  const ROOM = "W1N1";

  beforeEach(() => {
    resetLogisticsShadowCpuForTest();
    resetRuntimeServices();
    Game.time = cadenceTick(100);
    Memory.cfg = {
      synthesisControl: {
        enabled: true,
        sampleInterval: 10,
        rooms: {
          [ROOM]: {
            enabled: true,
            reactions: [
              { product: RESOURCE_UTRIUM_HYDRIDE, targetAmount: 5000, batchSize: 500 },
            ],
          },
        },
      },
    };
    Memory.runtime = undefined;
    Memory.rooms = {};
    Memory.data = undefined;
    Game.rooms = {};
    Game.spawns = {};
    (Game as GameWithPartialMarket).market = {
      calcTransactionCost: () => 0,
    };
  });

  function setupActiveRoom(): void {
    const room = createRoomWithResources({
      name: ROOM,
      mineralType: RESOURCE_UTRIUM,
      storageEnergy: 300000,
    });
    Game.rooms[ROOM] = room;

    Memory.runtime = {
      synthesisControl: {
        updatedAt: 0,
        generatedTaskCount: 0,
        failedTaskCount: 0,
        successfulRunCount: 0,
        lastActions: [],
        bindings: {},
        rooms: {
          [ROOM]: {
            stage: "synthesizing",
            activeProduct: RESOURCE_UTRIUM_HYDRIDE,
            reagentA: RESOURCE_UTRIUM,
            reagentB: RESOURCE_HYDROGEN,
            targetAmount: 5000,
            batchSize: 500,
            reagentLabIds: [`${ROOM}-lab-1`, `${ROOM}-lab-2`],
            productLabIds: [`${ROOM}-lab-3`],
            successfulRuns: 10,
            pendingTasks: 0,
            lastTransitionAt: 90,
            nextReactionAt: 150,
          },
        },
      },
    };
  }

  it("tracks concurrent boost tasks and resumes only after the last release", () => {
    setupActiveRoom();
    const first = pauseSynthesisForBoost(ROOM, "pb-task-1");
    expect(first).toBe(true);

    const second = pauseSynthesisForBoost(ROOM, "pb-task-2");
    expect(second).toBe(true);

    const roomState = Memory.runtime!.synthesisControl!.rooms[ROOM];
    expect(roomState.boostPause!.taskId).toBe("pb-task-1");
    expect(roomState.boostPause!.taskIds).toEqual(["pb-task-1", "pb-task-2"]);
    expect(roomState.nextReactionAt).toBeUndefined();

    resumeSynthesisAfterBoost(ROOM, "pb-task-1");
    expect(roomState.boostPause!.taskId).toBe("pb-task-2");
    expect(roomState.activeProduct).toBeUndefined();

    resumeSynthesisAfterBoost(ROOM, "pb-task-2");
    expect(roomState.boostPause).toBeUndefined();
    expect(roomState.activeProduct).toBe(RESOURCE_UTRIUM_HYDRIDE);
    expect(roomState.nextReactionAt).toBeUndefined();
  });
});


it("换配方重置补料超时，同份旧产物仅由一个清理任务认领", () => {
  resetRuntimeServices(); clearCarrierTaskBoardForTest(); Game.time = cadenceTick(1000); Game.creeps = {};
  Memory.cfg = { synthesisControl: { enabled: true, rooms: { W1N1: { enabled: true,
    reactions: [{ product: RESOURCE_HYDROXIDE, targetAmount: 5000, batchSize: 500 }] } } } };
  Memory.data = {};
  const room = createRoomWithResources({ name: "W1N1", mineralType: RESOURCE_CATALYST, storageEnergy: 300000 });
  Game.rooms = { W1N1: room };
  const labs = room.find(FIND_MY_STRUCTURES) as StructureLab[];
  const product = labs[2];
  Object.assign(product, { mineralType: RESOURCE_UTRIUM_HYDRIDE, store: {
    getUsedCapacity: (r?: ResourceConstant) => r === RESOURCE_UTRIUM_HYDRIDE ? 100 : 0,
    getFreeCapacity: () => 2900,
  } });
  Game.getObjectById = jest.fn(id => labs.find(lab => lab.id === id) ?? null) as Game["getObjectById"];
  Memory.runtime = { synthesisControl: { rooms: { W1N1: { stage: "loading", activeProduct: RESOURCE_UTRIUM_HYDRIDE,
    targetAmount: 5000, batchSize: 500, loadingSinceTick: 1, reagentLabIds: labs.slice(0, 2).map(l => l.id),
    productLabIds: [product.id] } } } } as any;
  runSynthesisControl();
  const state = Memory.runtime!.synthesisControl!.rooms.W1N1;
  expect(state.activeProduct).toBe(RESOURCE_HYDROXIDE);
  expect(state.loadingSinceTick).toBe(Game.time);
  const { listCarrierTasksByRoom } = require("@/runtime/carrierTaskBoard");
  const productClaims = listCarrierTasksByRoom(room.name).flatMap((task: any) => task.steps)
    .filter((step: any) => step.fromId === product.id && step.resource === RESOURCE_UTRIUM_HYDRIDE);
  expect(productClaims).toHaveLength(1);
});


it("合成补料比较可取库存，terminal 待售锁定后选择 storage", () => {
  const { createMockStore } = require("@mock/powerBank");
  const { clearMarketSaleExposureReservationsForTest } = require("@/runtime/marketSaleExposure");
  const { listCarrierTasksByRoom } = require("@/runtime/carrierTaskBoard");
  resetRuntimeServices(); clearCarrierTaskBoardForTest(); clearMarketSaleExposureReservationsForTest();
  Game.time = cadenceTick(1000); Game.creeps = {}; Memory.runtime = undefined;
  Memory.cfg = { synthesisControl: { enabled: true, rooms: { W1N1: { reactions: [{ product: RESOURCE_HYDROXIDE, targetAmount: 5000, batchSize: 500 }] } } } };
  const room = createRoomWithResources({ name: "W1N1", mineralType: RESOURCE_CATALYST, terminalResources: { H: 1000 } });
  Object.assign(room.storage!, { store: createMockStore({ energy: 300000, H: 500, O: 500 }) });
  const labs = room.find(FIND_MY_STRUCTURES) as StructureLab[];
  Game.rooms = { W1N1: room };
  Game.getObjectById = jest.fn(id => labs.find(lab => lab.id === id) ?? null) as Game["getObjectById"];
  Memory.data = { marketSaleAutomation: { managedOrders: {}, pendingDirectDeals: { held: {
    requestId: "held", status: "reconcile_gap", canaryRoomName: room.name, resource: RESOURCE_HYDROGEN,
    dealAmount: 1000, transactionEnergy: 0,
  } } } } as any;
  runSynthesisControl();
  expect(listCarrierTasksByRoom(room.name).flatMap((task: any) => task.steps))
    .toContainEqual(expect.objectContaining({ resource: RESOURCE_HYDROGEN, fromId: room.storage!.id }));
});


it("防御专用 boost lab 不会被常规合成抢占", () => {
  resetRuntimeServices(); clearCarrierTaskBoardForTest(); Game.time = cadenceTick(1000);
  const room = createRoomWithResources({ name: "W1N1", mineralType: RESOURCE_CATALYST });
  Game.rooms = { W1N1: room }; Memory.runtime = undefined; Memory.data = {};
  Memory.cfg = { homeDefense: { rooms: { W1N1: { boostLabId: "W1N1-lab-3" } } },
    synthesisControl: { enabled: true, rooms: { W1N1: { reactions: [{ product: RESOURCE_HYDROXIDE, targetAmount: 5000 }] } } } };
  runSynthesisControl();
  expect(Memory.runtime!.synthesisControl!.rooms.W1N1.lastError).toBe("lab_topology_unavailable");
  const { listCarrierTasksByRoom } = require("@/runtime/carrierTaskBoard");
  expect(listCarrierTasksByRoom(room.name)).toHaveLength(0);
});

it("真实合成入口在单房失败后撤回未执行 producer，保留已接受运输并继续健康房", () => {
  resetRuntimeIsolationForTest();
  runSynthesisResourceControlAuthorityTwin("shadow");
  const before = peekLogisticsControlStore();
  expect(before.ok).toBe(true);
  if (!before.ok) throw new Error("missing initial logistics store");
  expect(Object.values(before.store.producerSnapshots).some(s => s.producer === SYNTHESIS_ROOM_LOGISTICS_PRODUCER)).toBe(true);
  const accepted = getResourceTransferTaskListSorted().map(task => ({ task, json: JSON.stringify(task) }));
  expect(accepted.length).toBeGreaterThan(0);
  const cursor = before.store.cursor;
  const bad = Game.rooms.W1N1, oldFind = bad.find;
  const good = createRoomWithResources({ name: "W3N1", mineralType: RESOURCE_CATALYST, storageEnergy: 300000 });
  Game.rooms[good.name] = good;
  Memory.cfg!.synthesisControl!.rooms![good.name] = {
    enabled: true, reactions: [{ product: RESOURCE_UTRIUM_HYDRIDE, targetAmount: 5000 }],
  };
  bad.find = jest.fn(() => { throw new Error("synthesis lab input unavailable"); });
  try {
    Game.time = cadenceTick(530); resetRuntimeServices();
    expect(() => runSynthesisControl()).not.toThrow();
    const failed = peekLogisticsControlStore();
    expect(failed.ok).toBe(true);
    if (!failed.ok) throw new Error("producer invalidation damaged store");
    expect(Object.values(failed.store.producerSnapshots).some(s => s.producer === SYNTHESIS_ROOM_LOGISTICS_PRODUCER)).toBe(false);
    expect(Object.values(failed.store.latestIntents).some(i => i.producer === SYNTHESIS_ROOM_LOGISTICS_PRODUCER)).toBe(false);
    expect(failed.store.cursor).toBe(cursor);
    for (const { task, json } of accepted) expect(JSON.stringify(task)).toBe(json);
    expect(Memory.runtime!.synthesisControl!.rooms[good.name].reagentLabIds).toHaveLength(2);

    bad.find = oldFind;
    Game.time = cadenceTick(550); resetRuntimeServices();
    runSynthesisControl();
    const recovered = peekLogisticsControlStore();
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error("missing recovered logistics store");
    expect(Object.values(recovered.store.producerSnapshots).some(s =>
      s.producer === SYNTHESIS_ROOM_LOGISTICS_PRODUCER && s.observedAt === Game.time)).toBe(true);
  } finally { bad.find = oldFind; resetRuntimeIsolationForTest(); }
});
