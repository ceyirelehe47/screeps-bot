import {
  cleanupResourceTransferTaskStore,
  createResourceTransferTask,
} from "@/runtime/logistics/resourceTransferTasks";
import * as resourceTransferTaskModule from "@/runtime/logistics/resourceTransferTasks";
import {
  clearLogisticsControlValidatedArtifactForTest,
  cleanupLogisticsControlStore,
  ensureLogisticsControlStore,
  getLogisticsControlCodecDiagnostics,
  getLogisticsControlStoreUsage,
  LOGISTICS_CONTROL_DATA_LIMIT_BYTES,
  mapLegacyTransferOrigin,
  mapLegacyTransferPriority,
  peekLogisticsControlStore,
  readLogisticsControlStoreExact,
  replaceLatestLogisticsDemandsForProducer,
  invalidateLogisticsProducerSnapshot,
  replaceLogisticsRoomFacts,
  resetLogisticsControlCodecDiagnosticsForTest,
  resolveLogisticsControlConfig,
  resolveLogisticsExecutionAuthority,
} from "@/runtime/logistics/logisticsControl";
import { registerRuntimeServices } from "@/runtime/runtimeServices";
import { runMemoryCleanup } from "@/runtime/memoryCleanup";

type CreatedTask = Exclude<ReturnType<typeof createResourceTransferTask>, string>["task"];
type TaskHealthApi = {
  createAutomaticResourceTransferTask?: typeof createResourceTransferTask;
  countDemandCoveringIncomingResourceTransferTasksByRoom?: (roomName: string) => number;
  countsResourceTransferTaskTowardDemand?: (
    task: CreatedTask,
    options?: {
      automaticTaskNoProgressTtl: number;
      sourceDepletedGraceTicks: number;
      receiverCapacityDemandCoverageGraceTicks: number;
    },
  ) => boolean;
  createResourceTransferTaskAmountIndex?: () => {
    getIncoming(roomName: string, resource: ResourceConstant, reasonPrefix?: string): number;
    getPendingIncoming(roomName: string, resource: ResourceConstant, reasonPrefix?: string): number;
  };
  getIncomingResourceTransferAmount?: (roomName: string, resource: ResourceConstant) => number;
  getResourceTransferTaskDemandCoverageExpirationReason?: (
    task: CreatedTask,
    options?: {
      automaticTaskNoProgressTtl: number;
      sourceDepletedGraceTicks: number;
      receiverCapacityDemandCoverageGraceTicks: number;
    },
  ) => string | null;
  isHealthyReceiverCapacityCommitment?: (
    task: CreatedTask,
    automaticTaskNoProgressTtl?: number,
  ) => boolean;
  markResourceTransferTaskBlocked?: (
    task: CreatedTask,
    reason: "receiver_capacity" | "source_depleted" | "insufficient_terminal_resource_or_fee",
  ) => void;
  clearResourceTransferTaskBlocker?: (task: CreatedTask) => void;
  recordResourceTransferTaskProgress?: (task: CreatedTask) => void;
  reconcileResourceTransferTasks?: (options?: {
    automaticTaskNoProgressTtl?: number;
    sourceDepletedGraceTicks?: number;
    receiverCapacityDemandCoverageGraceTicks?: number;
  }) => number;
};

const taskHealthApi = resourceTransferTaskModule as typeof resourceTransferTaskModule & TaskHealthApi;

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

describe("resource transfer task health v2", () => {
  beforeEach(() => {
    resetRuntimeServices();
    registerRuntimeServices();
    clearLogisticsControlValidatedArtifactForTest();
    resetLogisticsControlCodecDiagnosticsForTest();
    Game.time = 100;
    Memory.cfg = undefined;
    Memory.data = undefined;
    Memory.runtime = undefined;
  });

  it("健康同资源反向调拨阻止自动对冲，手动操作不受此策略阻挡", () => {
    const create = resourceTransferTaskModule.createAutomaticResourceTransferTask;
    expect(create("W1N1", "W2N2", RESOURCE_HYDROGEN, 1000, "capacity:relief:test")).toMatchObject({ ok: true });
    expect(create("W2N2", "W1N1", RESOURCE_HYDROGEN, 1000, "hub:reclaim:test")).toBe("ERR_REVERSE_TRANSFER_ACTIVE");
    expect(createResourceTransferTask("W2N2", "W1N1", RESOURCE_HYDROGEN, 1000, "operator")).toMatchObject({ ok: true });
  });

  it("creates console-compatible manual tasks that retain demand coverage and normalizes receiver grace", () => {
    expect(resolveLogisticsControlConfig()).toEqual(expect.objectContaining({
      schemaVersion: 1,
      mode: "disabled",
      canaryScopes: [],
      valid: true,
    }));
    Memory.cfg = { resourceControl: 7 } as unknown as Memory["cfg"];
    expect(resolveLogisticsControlConfig()).toEqual(expect.objectContaining({
      mode: "disabled",
      valid: false,
      issue: "malformed",
    }));
    Memory.cfg = undefined;

    const result = createResourceTransferTask("W1N1", "W2N1", RESOURCE_ENERGY, 500, "operator-request");
    if (typeof result === "string") throw new Error("unexpected task creation failure");

    expect(result.task).toEqual(
      expect.objectContaining({
        origin: "manual",
        lastProgressAt: 100,
      }),
    );

    const countsTowardDemand = taskHealthApi.countsResourceTransferTaskTowardDemand;
    const markBlocked = taskHealthApi.markResourceTransferTaskBlocked;
    const reconcile = taskHealthApi.reconcileResourceTransferTasks;
    expect(countsTowardDemand).toBeDefined();
    expect(markBlocked).toBeDefined();
    expect(reconcile).toBeDefined();
    if (!countsTowardDemand || !markBlocked || !reconcile) return;

    markBlocked(result.task, "receiver_capacity");
    Game.time = 10_100;
    expect(countsTowardDemand(result.task)).toBe(true);
    expect(reconcile()).toBe(0);
    expect(result.task).toEqual(expect.objectContaining({
      status: "pending",
      blockedReason: "receiver_capacity",
      blockedSince: 100,
    }));

    expect(taskHealthApi.resolveResourceTransferTaskHealthOptions()).toEqual(expect.objectContaining({
      receiverCapacityDemandCoverageGraceTicks: 500,
    }));
    Memory.cfg = { resourceControl: { capacityBalancing: {} } };
    const capacityBalancing = Memory.cfg.resourceControl!
      .capacityBalancing as {
        receiverCapacityDemandCoverageGraceTicks?: number;
      };
    capacityBalancing.receiverCapacityDemandCoverageGraceTicks = 1;
    expect(taskHealthApi.resolveResourceTransferTaskHealthOptions().receiverCapacityDemandCoverageGraceTicks).toBe(50);
    capacityBalancing.receiverCapacityDemandCoverageGraceTicks = 50_001;
    expect(taskHealthApi.resolveResourceTransferTaskHealthOptions().receiverCapacityDemandCoverageGraceTicks).toBe(5_000);

    Memory.cfg = {
      resourceControl: {
        logistics: {
          schemaVersion: 1,
          mode: "canary",
          canaryScopes: [
            { origin: "synthesis_room", sourceRoomName: "W1N1" },
            { origin: "capacity_relief", sourceRoomName: "W2N2" },
          ],
        },
      },
    } as unknown as Memory["cfg"];
    const canary = resolveLogisticsControlConfig();
    expect(canary).toEqual(expect.objectContaining({
      mode: "canary",
      canaryScopes: [
        { origin: "capacity_relief", sourceRoomName: "W2N2" },
        { origin: "synthesis_room", sourceRoomName: "W1N1" },
      ],
      valid: true,
    }));
    expect(resolveLogisticsExecutionAuthority(canary, "synthesis_room", "W1N1")).toEqual(expect.objectContaining({
      requestedAuthority: "legacy",
      effectiveAuthority: "legacy",
      reason: "backend_unavailable",
    }));
    expect(resolveLogisticsExecutionAuthority(canary, "synthesis_room", "W1N1", true)).toEqual(expect.objectContaining({
      requestedAuthority: "contract",
      effectiveAuthority: "contract",
      reason: "contract_requested",
    }));
    expect(resolveLogisticsExecutionAuthority(canary, "capacity_relief", "W1N1", true).reason).toBe(
      "outside_canary_scope",
    );

    Memory.cfg = {
      resourceControl: {
        logistics: {
          schemaVersion: 1,
          mode: "enabled",
          canaryScopes: [],
          rollbackRequest: {
            schemaVersion: 1,
            requestId: "rollback-1",
            requestedAt: Game.time,
            targetAuthority: "legacy",
            reason: "operator safety rollback",
            scope: {
              origins: ["synthesis_room"],
              sourceRooms: ["W1N1"],
            },
            phase: "requested",
            updatedAt: Game.time,
          },
        },
      },
    } as unknown as Memory["cfg"];
    const rollback = resolveLogisticsControlConfig();
    expect(resolveLogisticsExecutionAuthority(rollback, "synthesis_room", "W1N1", true)).toEqual(expect.objectContaining({
      requestedAuthority: "legacy",
      reason: "rollback_requested",
      rollbackRequestId: "rollback-1",
    }));
    expect(resolveLogisticsExecutionAuthority(rollback, "capacity_relief", "W1N1", true).requestedAuthority).toBe(
      "contract",
    );

    const unknownConfigBefore = JSON.stringify({
      resourceControl: { logistics: { schemaVersion: 99, mode: "enabled", opaque: "keep" } },
    });
    Memory.cfg = JSON.parse(unknownConfigBefore) as Memory["cfg"];
    expect(resolveLogisticsControlConfig()).toEqual(expect.objectContaining({
      mode: "disabled",
      valid: false,
      issue: "unsupported_schema",
    }));
    expect(JSON.stringify(Memory.cfg)).toBe(unknownConfigBefore);

    expect(mapLegacyTransferPriority("manual", "manual:operator")).toBe("operator");
    expect(mapLegacyTransferPriority("automatic", "energy-support")).toBe("survival_energy");
    expect(mapLegacyTransferPriority("automatic", "capacity:relief:H", { capacityEmergency: true })).toBe(
      "capacity_emergency",
    );
    expect(mapLegacyTransferPriority("automatic", "capacity:relief:H")).toBe("capacity_pressure");
    expect(mapLegacyTransferPriority("automatic", "synthesis:W1N1:OH")).toBe("production");
    expect(mapLegacyTransferPriority("automatic", "hub:export:H")).toBe("balance");
    expect(mapLegacyTransferPriority("automatic", "market:sell:H")).toBe("market");
    expect(mapLegacyTransferPriority("automatic", "synthesis:W1N1:OH", { deadlineAt: Game.time })).toBe(
      "deadline",
    );
    expect(mapLegacyTransferOrigin("automatic", "synthesis:W1N1:OH")).toBe("synthesis_room");
    expect(mapLegacyTransferOrigin("automatic", "synthesis:hub-route:OH")).toBe(
      "synthesis_distributed_demand",
    );
    expect(mapLegacyTransferOrigin("automatic", "auto:synthesis:W1N1:H")).toBe("synthesis_compatibility");
  });

  it("migrates legacy tasks and applies automatic demand-coverage lifecycle boundaries", () => {
    const reconcile = taskHealthApi.reconcileResourceTransferTasks;
    expect(reconcile).toBeDefined();
    if (!reconcile) return;

    const legacyTask = (id: string, reason?: string, lastError?: string, updatedAt: number | undefined = 90) => ({
      id,
      resource: RESOURCE_HYDROGEN,
      fromRoomName: `W${id.length}N1`,
      toRoomName: "W9N9",
      amount: 100,
      remainingAmount: 100,
      status: "pending",
      createdAt: 80,
      updatedAt,
      reason,
      lastError,
    });
    const knownReasons = [
      "hub:import:H",
      "synthesis:direct:H",
      "auto:synthesis:W1N1:H",
      "powerBankBoost:task-1",
      "energy-support",
      "capacity:relief:H",
    ];
    const tasks: Record<string, ReturnType<typeof legacyTask>> = {};
    knownReasons.forEach((reason, index) => {
      tasks[`known-${index}`] = legacyTask(`known-${index}`, reason, index === 0 ? "insufficient_terminal_resource_or_fee" : undefined);
    });
    tasks["known-4"].updatedAt = undefined;
    tasks.unknown = legacyTask("unknown", "operator-request");
    tasks.absent = legacyTask("absent");
    Memory.data = { resourceControl: { tasks } } as unknown as NonNullable<Memory["data"]>;

    expect(reconcile()).toBe(0);
    const resourceControl = Memory.data!.resourceControl as NonNullable<Memory["data"]>["resourceControl"] & {
      taskSchemaVersion?: number;
    };
    const migrated = resourceControl!.tasks! as Record<string, CreatedTask>;
    expect(resourceControl!.taskSchemaVersion).toBe(2);
    for (let index = 0; index < knownReasons.length; index += 1) {
      expect(migrated[`known-${index}`]).toEqual(
        expect.objectContaining({
          origin: "automatic",
          lastProgressAt: index === 4 ? 80 : 90,
        }),
      );
    }
    expect(migrated["known-0"]).toEqual(
      expect.objectContaining({
        blockedReason: "insufficient_terminal_resource_or_fee",
        blockedSince: 90,
        lastError: undefined,
      }),
    );
    expect(migrated.unknown).toEqual(expect.objectContaining({ origin: "manual", status: "pending" }));
    expect(migrated.absent).toEqual(expect.objectContaining({ origin: "manual", status: "pending" }));

    const once = JSON.stringify(resourceControl);
    expect(reconcile()).toBe(0);
    expect(JSON.stringify(resourceControl)).toBe(once);

    const createAutomatic = taskHealthApi.createAutomaticResourceTransferTask;
    const markBlocked = taskHealthApi.markResourceTransferTaskBlocked;
    const countsTowardDemand = taskHealthApi.countsResourceTransferTaskTowardDemand;
    const expirationReason = taskHealthApi.getResourceTransferTaskDemandCoverageExpirationReason;
    const getIncoming = taskHealthApi.getIncomingResourceTransferAmount;
    const createAmountIndex = taskHealthApi.createResourceTransferTaskAmountIndex;
    const countDemandCovering = taskHealthApi.countDemandCoveringIncomingResourceTransferTasksByRoom;
    expect(createAutomatic).toBeDefined();
    expect(markBlocked).toBeDefined();
    expect(countsTowardDemand).toBeDefined();
    expect(expirationReason).toBeDefined();
    expect(getIncoming).toBeDefined();
    expect(createAmountIndex).toBeDefined();
    expect(countDemandCovering).toBeDefined();
    if (
      !createAutomatic ||
      !markBlocked ||
      !countsTowardDemand ||
      !expirationReason ||
      !getIncoming ||
      !createAmountIndex ||
      !countDemandCovering
    ) return;

    Memory.data = undefined;
    Memory.cfg = undefined;
    Game.time = 1_000;
    const capacityResult = createAutomatic("W1N1", "W2N1", RESOURCE_HYDROGEN, 400, "synthesis:W2N1:OH");
    if (typeof capacityResult === "string") throw new Error("unexpected automatic task creation failure");
    markBlocked(capacityResult.task, "receiver_capacity");

    Game.time = 1_499;
    expect(countsTowardDemand(capacityResult.task)).toBe(true);
    expect(expirationReason(capacityResult.task)).toBeNull();
    expect(getIncoming("W2N1", RESOURCE_HYDROGEN)).toBe(400);
    expect(createAmountIndex().getIncoming("W2N1", RESOURCE_HYDROGEN)).toBe(400);
    expect(countDemandCovering("W2N1")).toBe(1);

    Game.time = 1_500;
    expect(countsTowardDemand(capacityResult.task)).toBe(false);
    expect(expirationReason(capacityResult.task)).toBe("automatic_receiver_capacity_coverage_timeout");
    expect(getIncoming("W2N1", RESOURCE_HYDROGEN)).toBe(0);
    const expiredIndex = createAmountIndex();
    expect(expiredIndex.getIncoming("W2N1", RESOURCE_HYDROGEN)).toBe(0);
    expect(expiredIndex.getPendingIncoming("W2N1", RESOURCE_HYDROGEN)).toBe(400);
    expect(resourceTransferTaskModule.getOutgoingResourceTransferAmount("W1N1", RESOURCE_HYDROGEN)).toBe(400);
    expect(resourceTransferTaskModule.countPendingIncomingResourceTransferTasksByRoom("W2N1")).toBe(1);
    expect(countDemandCovering("W2N1")).toBe(0);

    const replacementResult = createAutomatic("W1N1", "W2N1", RESOURCE_HYDROGEN, 150, "synthesis:W2N1:OH");
    if (typeof replacementResult === "string") throw new Error("unexpected replacement task creation failure");
    expect(replacementResult.task.id).not.toBe(capacityResult.task.id);
    expect(capacityResult.task.remainingAmount).toBe(400);
    expect(replacementResult.task.remainingAmount).toBe(150);
    expect(getIncoming("W2N1", RESOURCE_HYDROGEN)).toBe(150);
    expect(resourceTransferTaskModule.countPendingIncomingResourceTransferTasksByRoom("W2N1")).toBe(2);
    expect(countDemandCovering("W2N1")).toBe(1);

    expect(reconcile({ receiverCapacityDemandCoverageGraceTicks: 500 })).toBe(1);
    expect(capacityResult.task).toEqual(expect.objectContaining({
      status: "cancelled",
      blockedReason: "receiver_capacity",
      blockedSince: 1_000,
      lastError: "automatic_receiver_capacity_coverage_timeout",
    }));
    expect(replacementResult.task.status).toBe("pending");

    Game.time = 2_000;
    const sourceResult = createAutomatic("W3N1", "W2N1", RESOURCE_OXYGEN, 200, "synthesis:W2N1:OH");
    if (typeof sourceResult === "string") throw new Error("unexpected source task creation failure");
    markBlocked(sourceResult.task, "source_depleted");
    Game.time = 2_099;
    expect(countsTowardDemand(sourceResult.task)).toBe(true);
    Game.time = 2_100;
    expect(countsTowardDemand(sourceResult.task)).toBe(false);
    expect(expirationReason(sourceResult.task)).toBe("automatic_source_depleted_timeout");
    expect(getIncoming("W2N1", RESOURCE_OXYGEN)).toBe(0);
    const sourceExpiredIndex = createAmountIndex();
    expect(sourceExpiredIndex.getIncoming("W2N1", RESOURCE_OXYGEN)).toBe(0);
    expect(sourceExpiredIndex.getPendingIncoming("W2N1", RESOURCE_OXYGEN)).toBe(200);
    expect(reconcile({ sourceDepletedGraceTicks: 100 })).toBe(1);
    expect(sourceResult.task.lastError).toBe("automatic_source_depleted_timeout");

    Memory.data = undefined;
    Game.time = 3_000;
    const stalledResult = createAutomatic(
      "W4N1",
      "W2N1",
      RESOURCE_KEANIUM,
      100,
      "synthesis:W2N1:KH",
    );
    if (typeof stalledResult === "string") {
      throw new Error("unexpected stalled task creation failure");
    }
    Game.time = 8_000;
    expect(countsTowardDemand(stalledResult.task)).toBe(true);
    expect(expirationReason(stalledResult.task)).toBeNull();
    Game.time = 8_001;
    expect(countsTowardDemand(stalledResult.task)).toBe(false);
    expect(expirationReason(stalledResult.task)).toBe(
      "automatic_no_progress_timeout",
    );
    expect(reconcile()).toBe(1);
    expect(stalledResult.task.lastError).toBe(
      "automatic_no_progress_timeout",
    );

    Memory.data = undefined;
    Game.time = 9_000;
    const legacySibling = createResourceTransferTask(
      "W1N1",
      "W2N1",
      RESOURCE_HYDROGEN,
      25,
      "operator-sibling",
    );
    if (typeof legacySibling === "string") throw new Error("unexpected sibling task creation failure");
    const ensured = ensureLogisticsControlStore();
    expect(ensured).toEqual(expect.objectContaining({ ok: true, created: true }));
    if (!ensured.ok) return;
    expect(Object.keys(ensured.store).sort()).toEqual([
      "cursor",
      "generation",
      "latestIntents",
      "producerSnapshots",
      "roomFacts",
      "schemaVersion",
      "synthesisObservations",
    ]);

    const producer = "__proto__";
    const demandKey = "constructor:toString";
    const draft = {
      demandKey,
      origin: "synthesis_room" as const,
      targetRoomName: "W2N1",
      resource: RESOURCE_HYDROGEN,
      desiredAmount: 100,
      priorityClass: "production" as const,
      fixedSourceRoomNames: ["W1N1"],
      ttl: 2,
      active: true,
      product: RESOURCE_HYDROXIDE,
      maxBatch: 500,
    };
    const first = replaceLatestLogisticsDemandsForProducer(producer, [draft], [{
      demandKey,
      inputFingerprint: "input-fingerprint-1",
      localAmount: 10,
      incomingAmount: 20,
      uncoveredAmount: 70,
      decisionOrder: 0,
      comparableReason: "comparable",
      legacyDecision: "created",
      legacyPriorityRank: 2,
      legacyPriorityClass: "production",
      legacySourceRoomName: "W1N1",
      legacyAmount: 25,
      legacyTaskId: legacySibling.task.id,
      legacyAddedAmount: 25,
      legacyRemainingBefore: 0,
      legacyFeeDelta: 1,
    }], { totalCount: 2, overflowCount: 1, ttl: 2 });
    expect(first).toEqual(expect.objectContaining({ ok: true }));
    if (!first.ok) return;
    expect(first.entries[0]).toEqual(expect.objectContaining({
      producer,
      demandKey,
      generation: 1,
      revision: 1,
      firstObservedAt: 9_000,
      desiredAmount: 100,
      expiresAt: 9_002,
    }));
    const firstStore = peekLogisticsControlStore();
    expect(firstStore).toEqual(expect.objectContaining({ ok: true }));
    if (!firstStore.ok) return;
    expect(Object.values(firstStore.store.producerSnapshots)).toEqual([
      expect.objectContaining({
        producer,
        observedAt: 9_000,
        expiresAt: 9_002,
        total: 2,
        emitted: 1,
        dropped: 1,
        limit: 32,
        truncated: true,
      }),
    ]);
    const smallExpandedSemantic = JSON.stringify(firstStore.store);
    const smallExpanded = JSON.parse(smallExpandedSemantic) as Record<string, unknown>;
    expect(Buffer.byteLength(JSON.stringify(smallExpanded), "utf8"))
      .toBeLessThanOrEqual(LOGISTICS_CONTROL_DATA_LIMIT_BYTES);
    (Memory.data!.resourceControl as unknown as { logistics: unknown }).logistics = smallExpanded;
    expect(peekLogisticsControlStore()).toEqual(expect.objectContaining({ ok: true }));
    expect(ensureLogisticsControlStore()).toEqual(expect.objectContaining({
      ok: true,
      created: false,
    }));
    const smallMigratedRaw = (Memory.data!.resourceControl as unknown as {
      logistics: { wireFormat?: unknown };
    }).logistics;
    expect(smallMigratedRaw.wireFormat).toBe("compact-v1");
    const smallMigrated = peekLogisticsControlStore();
    expect(smallMigrated).toEqual(expect.objectContaining({ ok: true }));
    if (!smallMigrated.ok) return;
    expect(JSON.stringify(smallMigrated.store)).toBe(smallExpandedSemantic);

    Game.time = 9_001;
    const heartbeat = replaceLatestLogisticsDemandsForProducer(producer, [draft], [{
      demandKey,
      inputFingerprint: "input-fingerprint-2",
      localAmount: 15,
      incomingAmount: 20,
      uncoveredAmount: 65,
      decisionOrder: 0,
      comparableReason: "expected_policy_difference",
      legacyDecision: "merged",
      legacyPriorityRank: 2,
      legacyPriorityClass: "production",
    }]);
    expect(heartbeat).toEqual(expect.objectContaining({ ok: true }));
    if (!heartbeat.ok) return;
    expect(heartbeat.entries[0]).toEqual(expect.objectContaining({
      generation: 1,
      revision: 1,
      firstObservedAt: 9_000,
      observedAt: 9_001,
      expiresAt: 9_003,
    }));
    const heartbeatStore = peekLogisticsControlStore();
    expect(heartbeatStore).toEqual(expect.objectContaining({ ok: true }));
    if (!heartbeatStore.ok) return;
    expect(Object.values(heartbeatStore.store.synthesisObservations)).toEqual([
      expect.objectContaining({
        intentId: heartbeat.entries[0].id,
        inputFingerprint: "input-fingerprint-2",
        localAmount: 15,
      }),
    ]);

    Game.time = 9_002;
    const changed = replaceLatestLogisticsDemandsForProducer(producer, [{ ...draft, desiredAmount: 150 }]);
    expect(changed).toEqual(expect.objectContaining({ ok: true }));
    if (!changed.ok) return;
    expect(changed.entries[0]).toEqual(expect.objectContaining({
      generation: 1,
      revision: 2,
      firstObservedAt: 9_000,
    }));
    const inactive = replaceLatestLogisticsDemandsForProducer(producer, [{ ...draft, active: false }]);
    expect(inactive).toEqual(expect.objectContaining({ ok: true }));
    if (!inactive.ok) return;
    expect(inactive.entries[0]).toEqual(expect.objectContaining({ generation: 1, revision: 3, active: false }));

    Game.time = 9_003;
    const reappeared = replaceLatestLogisticsDemandsForProducer(producer, [draft]);
    expect(reappeared).toEqual(expect.objectContaining({ ok: true }));
    if (!reappeared.ok) return;
    expect(reappeared.entries[0]).toEqual(expect.objectContaining({
      generation: 2,
      revision: 1,
      firstObservedAt: 9_003,
    }));
    Game.time = 9_006;
    const expiredHeartbeat = replaceLatestLogisticsDemandsForProducer(producer, [draft]);
    expect(expiredHeartbeat).toEqual(expect.objectContaining({ ok: true }));
    if (!expiredHeartbeat.ok) return;
    expect(expiredHeartbeat.entries[0]).toEqual(expect.objectContaining({
      generation: 3,
      revision: 1,
      firstObservedAt: 9_006,
      observedAt: 9_006,
    }));
    const expiredIntentId = expiredHeartbeat.entries[0].id;
    const rotationDrafts = Array.from({ length: 32 }, (_, index) => ({
      demandKey: index.toString(36),
      origin: "synthesis_room" as const,
      targetRoomName: "W2N1",
      resource: RESOURCE_HYDROGEN,
      desiredAmount: 1,
      priorityClass: "production" as const,
      ttl: 2,
    }));
    const rotated = replaceLatestLogisticsDemandsForProducer(producer, rotationDrafts);
    expect(rotated).toEqual(expect.objectContaining({ ok: true }));
    if (!rotated.ok) return;
    expect(rotated.entries).toHaveLength(32);
    const rotatedStore = peekLogisticsControlStore();
    expect(rotatedStore).toEqual(expect.objectContaining({ ok: true }));
    if (!rotatedStore.ok) return;
    expect(rotatedStore.store.cursor).toBe(35);
    expect(Object.keys(rotatedStore.store.generation).some((key) => {
      const decoded = JSON.parse(key) as unknown[];
      return decoded[2] === demandKey;
    })).toBe(false);
    const afterTombstoneEviction = replaceLatestLogisticsDemandsForProducer(producer, [draft]);
    expect(afterTombstoneEviction).toEqual(expect.objectContaining({ ok: true }));
    if (!afterTombstoneEviction.ok) return;
    expect(afterTombstoneEviction.entries[0]).toEqual(expect.objectContaining({
      generation: 36,
      revision: 1,
      firstObservedAt: 9_006,
    }));
    expect(afterTombstoneEviction.entries[0].id).not.toBe(expiredIntentId);
    const compactResources: ResourceConstant[] = [
      RESOURCE_ENERGY,
      RESOURCE_HYDROGEN,
      RESOURCE_OXYGEN,
      RESOURCE_UTRIUM,
      RESOURCE_LEMERGIUM,
      RESOURCE_KEANIUM,
      RESOURCE_ZYNTHIUM,
      RESOURCE_CATALYST,
    ];
    const compactDrafts = Array.from({ length: 16 }, (_, index) => index === 0
      ? draft
      : {
          ...draft,
          demandKey: `fixture-${index.toString().padStart(2, "0")}`,
          targetRoomName: `W${(index % 8) + 1}N1`,
          resource: compactResources[index % compactResources.length],
        });
    const compactFacts = Array.from({ length: 8 }, (_, index) => ({
      roomName: `W${index + 1}N1`,
      epochRevision: "fixture-epoch:9006",
      epochFingerprint: "fixture-fingerprint:9006",
      ttl: 30,
      owned: true,
      hasStorage: true,
      hasTerminal: true,
      terminalReachable: true,
      terminalReadyAt: Game.time + index,
      capacityState: "normal" as const,
      receiverEligible: true,
      receiverStorageHeadroom: 50_000,
      receiverTerminalHeadroom: 60_000,
      terminalStagingFreeCapacity: 40_000,
      transferBatchSize: 10_000,
      actionEnergyBudget: 20_000,
      terminalActionEnergyAmount: 10_000,
      resources: compactResources.map((resource, resourceIndex) => ({
        resource,
        sourceAvailableAmount: 10_000 + resourceIndex,
        sourceTerminalAmount: 5_000 + resourceIndex,
        receiverResourceHeadroom: 60_000 - resourceIndex,
      })),
    }));
    resetLogisticsControlCodecDiagnosticsForTest();
    const compact = replaceLatestLogisticsDemandsForProducer(
      producer,
      compactDrafts,
      compactDrafts.map((entry, index) => ({
        demandKey: entry.demandKey,
        inputFingerprint: `synthesis-shadow/v1:${index.toString(16).padStart(8, "0")}:100`,
        localAmount: index,
        incomingAmount: index * 2,
        uncoveredAmount: Math.max(0, entry.desiredAmount - index * 3),
        decisionOrder: index,
        comparableReason: "comparable",
        legacyDecision: "created",
        legacyPriorityRank: 2,
        legacyPriorityClass: "production",
        legacySourceRoomName: `W${((index + 1) % 8) + 1}N1`,
        legacyAmount: 10 + index,
        legacyTaskId: `fixture-task-${index}`,
        legacyAddedAmount: 10 + index,
        legacyRemainingBefore: index,
        legacyFeeDelta: index,
      })),
      {
        totalCount: 16,
        overflowCount: 0,
        ttl: 30,
        epochRevision: "fixture-epoch:9006",
        epochFingerprint: "fixture-fingerprint:9006",
        captureCpuUsed: 1.25,
        indexBuildCount: 1,
        roomFacts: compactFacts,
      },
    );
    expect(compact).toEqual(expect.objectContaining({ ok: true }));
    if (!compact.ok) return;
    expect(compact.entries).toHaveLength(16);
    const compactStore = readLogisticsControlStoreExact();
    expect(compactStore).toEqual(expect.objectContaining({ ok: true }));
    if (!compactStore.ok) return;
    expect(compactStore.readSource).toBe("same_tick_validated_artifact");
    expect(compactStore.artifactToken.length).toBeLessThan(64);
    expect(compactStore.usage.utf8Bytes).toBe(5_043);
    expect(getLogisticsControlCodecDiagnostics()).toEqual({
      encodePasses: 1,
      // prepare 保留 decode 往返以维持 canonical 形态；decode 侧逐记录
      // 谓词已被 trusted 校验替代。本 tick 内全部读取走 artifact 快路径。
      decodePasses: 1,
      wireSerializePasses: 3,
      strictReads: 0,
      artifactFastReads: 2,
      unchangedWireFastReads: 0,
      artifactFallbacks: 0,
      attachSuccesses: 1,
      roomFactEpochShortCircuits: 0,
      roomFactSemanticComparisons: 0,
    });
    const compactUsage = getLogisticsControlStoreUsage(compactStore.store);
    expect(compactUsage.utf8Bytes).toBe(5_043);
    expect(compactUsage.utf8Bytes).toBeLessThanOrEqual(LOGISTICS_CONTROL_DATA_LIMIT_BYTES);
    expect(compactUsage.utf8Bytes).toBeLessThanOrEqual(12_000);
    expect(Object.values(compactStore.store.producerSnapshots)).toEqual([
      expect.objectContaining({
        total: 16,
        emitted: 16,
        dropped: 0,
        truncated: false,
      }),
    ]);
    const compactSemantic = JSON.stringify(compactStore.store);
    const compactIntent = Object.values(compactStore.store.latestIntents)[0];
    expect(Object.isFrozen(compactStore.store)).toBe(true);
    expect(Object.isFrozen(compactStore.store.latestIntents)).toBe(true);
    expect(Object.isFrozen(compactIntent)).toBe(true);
    expect(Object.isFrozen(compactStore.usage)).toBe(true);
    expect(Reflect.set(
      compactStore.store as unknown as Record<string, unknown>,
      "cursor",
      compactStore.store.cursor + 1,
    )).toBe(false);
    expect(Reflect.set(
      compactIntent as unknown as Record<string, unknown>,
      "desiredAmount",
      999_999,
    )).toBe(false);
    expect(Reflect.set(
      compactStore.usage as unknown as Record<string, unknown>,
      "utf8Bytes",
      0,
    )).toBe(false);
    const immutableArtifactRead = readLogisticsControlStoreExact();
    expect(immutableArtifactRead).toEqual(expect.objectContaining({
      ok: true,
      readSource: "same_tick_validated_artifact",
      artifactToken: compactStore.artifactToken,
      usage: compactStore.usage,
    }));
    if (!immutableArtifactRead.ok) return;
    expect(JSON.stringify(immutableArtifactRead.store)).toBe(compactSemantic);
    const expandedFixture = JSON.parse(compactSemantic) as Record<string, unknown>;
    expect(Buffer.byteLength(JSON.stringify(expandedFixture), "utf8"))
      .toBeGreaterThan(LOGISTICS_CONTROL_DATA_LIMIT_BYTES);
    (Memory.data!.resourceControl as unknown as { logistics: unknown }).logistics = expandedFixture;
    expect(peekLogisticsControlStore()).toEqual(expect.objectContaining({
      ok: false,
      reason: "malformed_store",
    }));
    expect(ensureLogisticsControlStore()).toEqual(expect.objectContaining({ ok: true }));
    const migratedCompact = peekLogisticsControlStore();
    expect(migratedCompact).toEqual(expect.objectContaining({ ok: true }));
    if (!migratedCompact.ok) return;
    expect(JSON.stringify(migratedCompact.store)).toBe(compactSemantic);
    const rawCompact = (Memory.data!.resourceControl as unknown as { logistics: Record<string, unknown> }).logistics;
    expect(rawCompact.wireFormat).toBe("compact-v1");
    expect(Buffer.byteLength(JSON.stringify(rawCompact), "utf8")).toBe(5_043);
    expect(Object.keys(rawCompact).sort()).toEqual([
      "c", "f", "i", "o", "p", "s", "schemaVersion", "wireFormat",
    ]);
    resetLogisticsControlCodecDiagnosticsForTest();
    Memory.data = JSON.parse(JSON.stringify(Memory.data)) as Memory["data"];
    resetRuntimeServices();
    registerRuntimeServices();
    // 引擎式 Memory 往返后 wire 内容未改写：跨 tick 等值缓存以字节级 token
    // 比对直接复用已冻结 store，跳过 decode+逐记录校验。
    const cachedRoundTrip = readLogisticsControlStoreExact();
    expect(cachedRoundTrip).toEqual(expect.objectContaining({ ok: true }));
    if (!cachedRoundTrip.ok) return;
    expect(cachedRoundTrip.readSource).toBe("unchanged_wire_cache");
    expect(JSON.stringify(cachedRoundTrip.store)).toBe(compactSemantic);
    expect(getLogisticsControlCodecDiagnostics()).toEqual(expect.objectContaining({
      decodePasses: 0,
      wireSerializePasses: 1,
      strictReads: 1,
      unchangedWireFastReads: 1,
      artifactFallbacks: 1,
    }));
    // 清掉缓存后同 wire 必须仍能走完整 strict_compact 校验（防外部篡改
    // 场景的回归覆盖）。
    clearLogisticsControlValidatedArtifactForTest();
    resetLogisticsControlCodecDiagnosticsForTest();
    const compactRoundTrip = readLogisticsControlStoreExact();
    expect(compactRoundTrip).toEqual(expect.objectContaining({ ok: true }));
    if (!compactRoundTrip.ok) return;
    expect(compactRoundTrip.readSource).toBe("strict_compact");
    expect(getLogisticsControlCodecDiagnostics()).toEqual(expect.objectContaining({
      encodePasses: 0,
      decodePasses: 1,
      wireSerializePasses: 1,
      strictReads: 1,
      artifactFastReads: 0,
      // artifact 已被测试助手直接清除，本读没有 fallback 计数。
      artifactFallbacks: 0,
      attachSuccesses: 0,
    }));
    expect(JSON.stringify(compactRoundTrip.store)).toBe(compactSemantic);
    const restoredAfterCompact = replaceLatestLogisticsDemandsForProducer(producer, [draft]);
    expect(restoredAfterCompact).toEqual(expect.objectContaining({ ok: true }));
    if (!restoredAfterCompact.ok) return;
    expect(restoredAfterCompact.entries[0]).toEqual(expect.objectContaining({
      generation: 36,
      revision: 1,
      firstObservedAt: 9_006,
    }));
    expect(
      replaceLatestLogisticsDemandsForProducer(
        "too-many",
        Array.from({ length: 33 }, (_, index) => ({ ...draft, demandKey: `demand-${index}` })),
      ),
    ).toEqual({ ok: false, reason: "invalid_producer_or_count" });

    const factDraft = {
      roomName: "W1N1",
      epochRevision: "test-epoch:9006",
      epochFingerprint: "test-fingerprint:9006",
      ttl: 2,
      owned: true,
      hasStorage: true,
      hasTerminal: true,
      terminalReachable: true,
      terminalReadyAt: Game.time,
      capacityState: "normal" as const,
      receiverEligible: true,
      receiverStorageHeadroom: 50_000,
      receiverTerminalHeadroom: 60_000,
      terminalStagingFreeCapacity: 40_000,
      transferBatchSize: 10_000,
      actionEnergyBudget: 10_000,
      terminalActionEnergyAmount: 5_000,
      resources: [{
        resource: RESOURCE_HYDROGEN,
        sourceAvailableAmount: 5_000,
        sourceTerminalAmount: 1_000,
        receiverResourceHeadroom: 60_000,
      }],
    };
    const roomFactCounterBefore = getLogisticsControlCodecDiagnostics();
    const facts = replaceLogisticsRoomFacts([factDraft]);
    expect(facts).toEqual(expect.objectContaining({ ok: true }));
    if (!facts.ok) return;
    const changedRoomFactCounter = getLogisticsControlCodecDiagnostics();
    expect(changedRoomFactCounter.roomFactEpochShortCircuits)
      .toBe(roomFactCounterBefore.roomFactEpochShortCircuits + 1);
    expect(changedRoomFactCounter.roomFactSemanticComparisons)
      .toBe(roomFactCounterBefore.roomFactSemanticComparisons);
    expect(facts.entries[0]).toEqual(expect.objectContaining({ revision: 2, expiresAt: 9_008 }));
    Game.time = 9_007;
    const factHeartbeat = replaceLogisticsRoomFacts([factDraft]);
    expect(factHeartbeat).toEqual(expect.objectContaining({ ok: true }));
    if (!factHeartbeat.ok) return;
    expect(getLogisticsControlCodecDiagnostics().roomFactSemanticComparisons)
      .toBe(changedRoomFactCounter.roomFactSemanticComparisons + 1);
    expect(factHeartbeat.entries[0]).toEqual(expect.objectContaining({
      revision: 2,
      observedAt: 9_007,
      expiresAt: 9_009,
    }));

    resetLogisticsControlCodecDiagnosticsForTest();
    Game.time = 9_008;
    const tickRolloverRead = readLogisticsControlStoreExact();
    expect(tickRolloverRead).toEqual(expect.objectContaining({
      ok: true,
      // tick 翻转使 same-tick artifact 失效，但 wire 未被改写：跨 tick 等值
      // 缓存以字节级 token 比对命中，跳过完整 strict 校验。
      readSource: "unchanged_wire_cache",
    }));
    expect(getLogisticsControlCodecDiagnostics()).toEqual(expect.objectContaining({
      strictReads: 1,
      unchangedWireFastReads: 1,
      artifactFastReads: 0,
      artifactFallbacks: 1,
    }));
    Game.time = 9_007;
    expect(replaceLogisticsRoomFacts([factDraft])).toEqual(expect.objectContaining({ ok: true }));

    resetLogisticsControlCodecDiagnosticsForTest();
    clearLogisticsControlValidatedArtifactForTest();
    const globalResetRead = readLogisticsControlStoreExact();
    expect(globalResetRead).toEqual(expect.objectContaining({
      ok: true,
      readSource: "strict_compact",
    }));
    expect(getLogisticsControlCodecDiagnostics()).toEqual(expect.objectContaining({
      strictReads: 1,
      artifactFastReads: 0,
      artifactFallbacks: 0,
    }));

    const serializedData = JSON.stringify(Memory.data);
    Memory.data = JSON.parse(serializedData) as Memory["data"];
    resetRuntimeServices();
    registerRuntimeServices();
    const afterReset = peekLogisticsControlStore();
    expect(afterReset).toEqual(expect.objectContaining({ ok: true }));
    if (!afterReset.ok) return;
    expect(Object.values(afterReset.store.latestIntents)).toEqual([
      expect.objectContaining({ producer, demandKey, generation: 36, revision: 1 }),
    ]);
    const resetHeartbeat = replaceLatestLogisticsDemandsForProducer(producer, [draft]);
    expect(resetHeartbeat).toEqual(expect.objectContaining({ ok: true }));
    if (!resetHeartbeat.ok) return;
    expect(resetHeartbeat.entries[0]).toEqual(expect.objectContaining({ generation: 36, revision: 1 }));
    const writerInvariantBefore = JSON.stringify(Memory.data);
    expect(replaceLatestLogisticsDemandsForProducer(producer, [{
      ...draft,
      active: "yes" as unknown as boolean,
    }])).toEqual({ ok: false, reason: "invalid_draft" });
    expect(replaceLatestLogisticsDemandsForProducer(
      producer,
      [draft, { ...draft, demandKey: "duplicate-order" }],
      [
        {
          demandKey,
          inputFingerprint: "duplicate-order:0",
          localAmount: 0,
          incomingAmount: 0,
          uncoveredAmount: 100,
          decisionOrder: 0,
          comparableReason: "comparable",
          legacyDecision: "no_donor",
          legacyPriorityRank: 2,
          legacyPriorityClass: "production",
        },
        {
          demandKey: "duplicate-order",
          inputFingerprint: "duplicate-order:1",
          localAmount: 0,
          incomingAmount: 0,
          uncoveredAmount: 100,
          decisionOrder: 0,
          comparableReason: "comparable",
          legacyDecision: "no_donor",
          legacyPriorityRank: 2,
          legacyPriorityClass: "production",
        },
      ],
    )).toEqual({ ok: false, reason: "duplicate_observation_order" });
    expect(JSON.stringify(Memory.data)).toBe(writerInvariantBefore);

    const knownV1Data = JSON.stringify(Memory.data);
    let rawLogistics = (Memory.data!.resourceControl as unknown as {
      logistics: { schemaVersion: number; c: number; p: unknown[] };
    }).logistics;
    resetLogisticsControlCodecDiagnosticsForTest();
    rawLogistics.c = Number.MAX_SAFE_INTEGER;
    const cursorOverflowBefore = JSON.stringify(Memory.data);
    expect(replaceLatestLogisticsDemandsForProducer(producer, [{
      ...draft,
      demandKey: "cursor-overflow",
    }])).toEqual({ ok: false, reason: "generation_cursor_overflow" });
    expect(JSON.stringify(Memory.data)).toBe(cursorOverflowBefore);
    expect(getLogisticsControlCodecDiagnostics()).toEqual(expect.objectContaining({
      encodePasses: 0,
      decodePasses: 1,
      wireSerializePasses: 1,
      strictReads: 1,
      artifactFastReads: 0,
      artifactFallbacks: 1,
      attachSuccesses: 0,
    }));

    Memory.data = JSON.parse(knownV1Data) as Memory["data"];
    rawLogistics = (Memory.data!.resourceControl as unknown as {
      logistics: { schemaVersion: number; c: number; p: unknown[] };
    }).logistics;
    rawLogistics.c = 0;
    const regressedCursorBefore = JSON.stringify(Memory.data);
    expect(peekLogisticsControlStore()).toEqual(expect.objectContaining({
      ok: false,
      reason: "malformed_store",
    }));
    expect(ensureLogisticsControlStore()).toEqual(expect.objectContaining({
      ok: false,
      reason: "malformed_store",
    }));
    expect(JSON.stringify(Memory.data)).toBe(regressedCursorBefore);

    Memory.data = JSON.parse(knownV1Data) as Memory["data"];
    rawLogistics = (Memory.data!.resourceControl as unknown as {
      logistics: { schemaVersion: number; c: number; p: unknown[] };
    }).logistics;
    rawLogistics.p = [];
    const missingSnapshotBefore = JSON.stringify(Memory.data);
    expect(peekLogisticsControlStore()).toEqual(expect.objectContaining({
      ok: false,
      reason: "malformed_store",
    }));
    expect(ensureLogisticsControlStore()).toEqual(expect.objectContaining({
      ok: false,
      reason: "malformed_store",
    }));
    expect(JSON.stringify(Memory.data)).toBe(missingSnapshotBefore);

    Memory.data = JSON.parse(knownV1Data) as Memory["data"];
    rawLogistics = (Memory.data!.resourceControl as unknown as {
      logistics: { schemaVersion: number; c: number; p: unknown[] };
    }).logistics;
    rawLogistics.schemaVersion = 99;
    const unknownStoreBefore = JSON.stringify(Memory.data);
    expect(ensureLogisticsControlStore()).toEqual(expect.objectContaining({
      ok: false,
      reason: "unsupported_schema",
      schemaVersion: 99,
    }));
    expect(JSON.stringify(Memory.data)).toBe(unknownStoreBefore);

    Memory.data = JSON.parse(knownV1Data) as Memory["data"];
    resetRuntimeServices();
    registerRuntimeServices();
    const taskAfterReset = Memory.data!.resourceControl!.tasks![legacySibling.task.id];
    taskAfterReset.status = "done";
    taskAfterReset.remainingAmount = 0;
    taskAfterReset.updatedAt = Game.time - 1;
    expect(cleanupResourceTransferTaskStore(new Set(["W1N1", "W2N1"]), 0)).toBe(1);
    expect(Memory.data?.resourceControl?.tasks).toEqual({});
    expect(peekLogisticsControlStore()).toEqual(expect.objectContaining({ ok: true }));
    const mixedExpiry = replaceLatestLogisticsDemandsForProducer(producer, [
      draft,
      { ...draft, demandKey: "long-lived-sibling", ttl: 20 },
    ]);
    expect(mixedExpiry).toEqual(expect.objectContaining({ ok: true }));
    if (!mixedExpiry.ok) return;
    expect(mixedExpiry.entries).toHaveLength(2);

    Game.time = 9_010;
    expect(cleanupLogisticsControlStore(new Set(["W1N1", "W2N1"]))).toBe(4);
    const cleaned = peekLogisticsControlStore();
    expect(cleaned).toEqual(expect.objectContaining({ ok: true }));
    if (cleaned.ok) {
      expect(cleaned.store.latestIntents).toEqual({});
      expect(cleaned.store.roomFacts).toEqual({});
      expect(cleaned.store.synthesisObservations).toEqual({});
      expect(cleaned.store.producerSnapshots).toEqual({});
    }
    expect(peekLogisticsControlStore()).toEqual(expect.objectContaining({ ok: true }));
    const emptySnapshot = replaceLatestLogisticsDemandsForProducer(
      producer,
      [],
      [],
      { totalCount: 0, overflowCount: 0, ttl: 1 },
    );
    expect(emptySnapshot).toEqual(expect.objectContaining({ ok: true }));
    Game.time = 9_012;
    expect(cleanupLogisticsControlStore(new Set(["W1N1", "W2N1"]))).toBe(1);
    const afterEmptySnapshotTtl = peekLogisticsControlStore();
    expect(afterEmptySnapshotTtl).toEqual(expect.objectContaining({ ok: true }));
    if (afterEmptySnapshotTtl.ok) {
      expect(afterEmptySnapshotTtl.store.producerSnapshots).toEqual({});
    }

    Game.time = 9_020;
    Memory.runtime = {
      resourceControl: {
        updatedAt: Game.time,
        rooms: {},
        lastActions: [],
        lastMarketActions: [],
        logistics: { schemaVersion: 1, mode: "shadow" },
      },
    } as unknown as Memory["runtime"];
    runMemoryCleanup();
    expect((Memory.runtime?.resourceControl as unknown as { logistics?: unknown })?.logistics).toEqual({
      schemaVersion: 1,
      mode: "shadow",
    });

    const compactOverflowBefore = JSON.stringify(Memory.data);
    const compactStringOverflow = replaceLatestLogisticsDemandsForProducer(
      producer,
      Array.from({ length: 17 }, (_, intentIndex) => ({
        ...draft,
        demandKey: `string-table-overflow-${intentIndex}`,
        fixedSourceRoomNames: Array.from(
          { length: 32 },
          (__, roomIndex) => `W${100 + intentIndex * 32 + roomIndex}N1`,
        ),
      })),
    );
    expect(compactStringOverflow).toEqual({ ok: false, reason: "compact_wire_invalid" });
    expect(JSON.stringify(Memory.data)).toBe(compactOverflowBefore);
    expect(peekLogisticsControlStore()).toEqual(expect.objectContaining({ ok: true }));

    const sortedFixedSources = replaceLatestLogisticsDemandsForProducer(producer, [{
      ...draft,
      demandKey: "canonical-fixed-sources",
      fixedSourceRoomNames: ["W1N1", "W2N1"],
    }]);
    expect(sortedFixedSources).toEqual(expect.objectContaining({ ok: true }));
    const rawCanonicalStore = (Memory.data!.resourceControl as unknown as {
      logistics: { i: unknown[][] };
    }).logistics;
    const fixedSourceIndexes = rawCanonicalStore.i[0][14];
    if (!Array.isArray(fixedSourceIndexes)) throw new Error("missing compact fixed-source indexes");
    rawCanonicalStore.i[0][14] = [...fixedSourceIndexes].reverse();
    expect(peekLogisticsControlStore()).toEqual(expect.objectContaining({
      ok: false,
      reason: "malformed_store",
    }));
  });
});


it("invalidates producer completeness without deleting accepted legacy cargo or demand generations", () => {
  Game.time = 9000;
  const producer = "synthesisControl:room";
  const result = replaceLatestLogisticsDemandsForProducer(producer, [{
    demandKey: "H:W2N2", targetRoomName: "W2N2", origin: "synthesis_room", resource: RESOURCE_HYDROGEN,
    desiredAmount: 100, priorityClass: "production", ttl: 100, active: true,
  }]);
  expect(result.ok).toBe(true);
  const before = peekLogisticsControlStore();
  expect(before.ok).toBe(true);
  if (!before.ok) return;
  const intents = JSON.stringify(before.store.latestIntents);
  const generation = JSON.stringify(before.store.generation);
  expect(invalidateLogisticsProducerSnapshot(producer)).toBe(true);
  const after = peekLogisticsControlStore();
  expect(after.ok).toBe(true);
  if (!after.ok) return;
  expect(Object.values(after.store.producerSnapshots).some(s => s.producer === producer)).toBe(false);
  expect(JSON.stringify(after.store.latestIntents)).toBe(intents);
  expect(JSON.stringify(after.store.generation)).toBe(generation);
});
