import {
  countsResourceTransferTaskTowardDemand,
  createAutomaticResourceTransferTask,
  ensureResourceTransferTaskStore,
  resolveResourceTransferTaskHealthOptions,
  type ResourceTransferTask,
} from "@/runtime/logistics/resourceTransferTasks";
import {
  LOGISTICS_CONTROL_STORE_LIMIT,
  SYNTHESIS_ROOM_LOGISTICS_PRODUCER,
  mapLegacyTransferPriority,
  peekLogisticsControlStore,
  replaceLatestLogisticsDemandsForProducer,
  resolveLogisticsControlConfig,
  type LatestLogisticsDemandDraft,
  type LogisticsPriorityClass,
  type SynthesisLogisticsObservationDraft,
} from "@/runtime/logistics/logisticsControl";
import { measureLogisticsShadowCpu } from "@/runtime/logistics/logisticsShadowCpu";
import { limitActionLog } from "@/runtime/actionLog";
import { runSynthesisTaskPlanningCompatibility } from "@/runtime/synthesisCompatibilityPlanning";
import { recordFixedCpuAction } from "@/runtime/cpuPhaseProfiler";
import {
  pruneCarrierTasksForProducer,
  replaceCarrierTasksForProducerRoom,
  type CarrierTaskDraft,
  type CarrierTaskStep,
} from "@/runtime/carrierTaskBoard";
import { getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { getCreepAssignmentState } from "@/runtime/creepAssignmentState";
import { getReservedProductionAmountExcludingOwner } from "@/runtime/resourceReservation";
import { getActivePowerBankBoostLabIds } from "@/runtime/powerBankBoostMemory";
import { normalizeBoolean, normalizeNumber, normalizeRoomNameList } from "@/runtime/configNormalize";
import { getProductReagents, roundUpReactionAmount } from "@/runtime/reactionMap";
import { isTargetSatisfiedByReactionGranularity, markLoadingStart, isLoadingTimedOut } from "@/runtime/productionStateMachine";
import { resolveTerminalStorageTarget, terminalStorageKind } from "@/runtime/carrierTaskHelpers";
import {
  beginSynthesisShadowEpochCapture,
  isResourceControlFullPlanningTick,
  type SynthesisShadowEpochCaptureSession,
} from "@/runtime/resourceControl";

type SynthesisStage = "idle" | "acquiring" | "loading" | "synthesizing" | "unloading" | "blocked";

interface SynthesisReactionPlan {
  product: ResourceConstant;
  targetAmount: number;
  batchSize: number;
  donorRoomNames: string[];
}

interface SynthesisRoomConfig {
  enabled: boolean;
  batchSize: number;
  donorRoomNames: string[];
  reagentLabIds: string[];
  reactions: SynthesisReactionPlan[];
}

interface SynthesisControlConfig {
  enabled: boolean;
  sampleInterval: number;
  defaultBatchSize: number;
  rooms: Record<string, SynthesisRoomConfig>;
}

interface SynthesisBinding {
  fromRoomName: string;
  updatedAt: number;
  expiresAt: number;
}

type SynthesisBindingStore = Record<string, SynthesisBinding>;

interface BoostPauseState {
  reason: "powerBankBoost";
  taskId: string;
  taskIds?: string[];
  createdTick: number;
  pausedPlan: SynthesisReactionPlan | null;
  pausedStage: SynthesisStage;
}

interface SynthesisRoomRuntimeState {
  stage: SynthesisStage;
  activeProduct?: ResourceConstant;
  reagentA?: ResourceConstant;
  reagentB?: ResourceConstant;
  targetAmount?: number;
  batchSize?: number;
  reagentLabIds: string[];
  productLabIds: string[];
  successfulRuns: number;
  pendingTasks: number;
  missing?: Partial<Record<ResourceConstant, number>>;
  cleanupTasks?: Array<{
    labId: string;
    resource: ResourceConstant;
    amount: number;
    target: "terminal" | "storage";
  }>;
  lastError?: string;
  lastTransitionAt: number;
  loadingSinceTick?: number;
  nextReactionAt?: number;
  boostPause?: BoostPauseState;
}

interface SynthesisRuntimeState {
  updatedAt: number;
  generatedTaskCount: number;
  failedTaskCount: number;
  successfulRunCount: number;
  lastActions: string[];
  bindings: SynthesisBindingStore;
  rooms: Record<string, SynthesisRoomRuntimeState>;
}

interface LabTopology {
  reagentLabs: [StructureLab, StructureLab];
  productLabs: StructureLab[];
}

interface DonorCandidate {
  room: Room;
  sendable: number;
  score: number;
}

interface SynthesisLogisticsShadowBatch {
  readonly ttl: number;
  readonly epochCapture: SynthesisShadowEpochCaptureSession;
  readonly demands: LatestLogisticsDemandDraft[];
  readonly observations: SynthesisLogisticsObservationDraft[];
  totalCount: number;
  overflowCount: number;
}

interface SynthesisAutomaticMergeSnapshot {
  readonly taskId: string;
  readonly remainingAmount: number;
}

interface SynthesisTransferTaskIndexDiagnostics {
  readonly storeScanCount: number;
  readonly reusedInputCount: number;
  mergeSnapshotLookupCount: number;
}

interface SynthesisTransferTaskIndex {
  getOutgoingAmount(roomName: string, resource: ResourceConstant): number;
  getPendingOutgoingCount(roomName: string): number;
  getIncomingAmount(roomName: string, resource: ResourceConstant): number;
  getDemandCoveringIncomingCount(roomName: string): number;
  getMergeableAutomaticTaskSnapshot(
    fromRoomName: string,
    toRoomName: string,
    resource: ResourceConstant,
    reason: string,
  ): SynthesisAutomaticMergeSnapshot | null;
  recordAutomaticTask(task: ResourceTransferTask, amountDelta: number): void;
}

let lastTransferTaskIndexDiagnostics: SynthesisTransferTaskIndexDiagnostics = {
  storeScanCount: 0,
  reusedInputCount: 0,
  mergeSnapshotLookupCount: 0,
};

export function getLastSynthesisTransferTaskIndexDiagnostics(): Readonly<SynthesisTransferTaskIndexDiagnostics> {
  return { ...lastTransferTaskIndexDiagnostics };
}

function automaticMergeSnapshotKey(
  fromRoomName: string,
  toRoomName: string,
  resource: ResourceConstant,
  reason: string,
): string {
  return JSON.stringify([fromRoomName, toRoomName, resource, reason]);
}

function createSynthesisTransferTaskIndex(
  enableMergeSnapshots: boolean,
  seedTasks?: readonly ResourceTransferTask[],
): SynthesisTransferTaskIndex {
  const outgoingByRoom = new Map<string, Map<ResourceConstant, number>>();
  const pendingOutgoingCountByRoom = new Map<string, number>();
  const incomingByRoom = new Map<string, Map<ResourceConstant, number>>();
  const coveringIncomingCountByRoom = new Map<string, number>();
  const mergeableAutomaticTaskByKey = new Map<string, SynthesisAutomaticMergeSnapshot>();
  const indexedTaskIds = new Set<string>();
  const healthOptions = resolveResourceTransferTaskHealthOptions();
  const diagnostics: SynthesisTransferTaskIndexDiagnostics = {
    storeScanCount: seedTasks ? 0 : 1,
    reusedInputCount: seedTasks ? 1 : 0,
    mergeSnapshotLookupCount: 0,
  };
  lastTransferTaskIndexDiagnostics = diagnostics;

  const addAmount = (
    index: Map<string, Map<ResourceConstant, number>>,
    roomName: string,
    resource: ResourceConstant,
    amount: number,
  ): void => {
    const byResource = index.get(roomName) ?? new Map<ResourceConstant, number>();
    byResource.set(resource, (byResource.get(resource) || 0) + amount);
    index.set(roomName, byResource);
  };

  const record = (task: ResourceTransferTask, amountDelta: number): void => {
    if (task.status !== "pending" || amountDelta <= 0) return;
    const firstContribution = !indexedTaskIds.has(task.id);
    indexedTaskIds.add(task.id);
    addAmount(outgoingByRoom, task.fromRoomName, task.resource, amountDelta);
    if (firstContribution) {
      pendingOutgoingCountByRoom.set(
        task.fromRoomName,
        (pendingOutgoingCountByRoom.get(task.fromRoomName) || 0) + 1,
      );
    }
    if (!countsResourceTransferTaskTowardDemand(task, healthOptions)) return;
    if (enableMergeSnapshots) {
      measureLogisticsShadowCpu("producer", () => {
        if (task.origin !== "automatic" || !task.reason) return;
        const key = automaticMergeSnapshotKey(
          task.fromRoomName,
          task.toRoomName,
          task.resource,
          task.reason,
        );
        const current = mergeableAutomaticTaskByKey.get(key);
        if (!current || current.taskId === task.id) {
          mergeableAutomaticTaskByKey.set(key, {
            taskId: task.id,
            remainingAmount: task.remainingAmount,
          });
        }
      });
    }
    addAmount(incomingByRoom, task.toRoomName, task.resource, amountDelta);
    if (firstContribution) {
      coveringIncomingCountByRoom.set(
        task.toRoomName,
        (coveringIncomingCountByRoom.get(task.toRoomName) || 0) + 1,
      );
    }
  };

  for (const task of seedTasks ?? Object.values(ensureResourceTransferTaskStore())) {
    record(task, task.remainingAmount);
  }

  return {
    getOutgoingAmount(roomName, resource) {
      return outgoingByRoom.get(roomName)?.get(resource) || 0;
    },
    getPendingOutgoingCount(roomName) {
      return pendingOutgoingCountByRoom.get(roomName) || 0;
    },
    getIncomingAmount(roomName, resource) {
      return incomingByRoom.get(roomName)?.get(resource) || 0;
    },
    getDemandCoveringIncomingCount(roomName) {
      return coveringIncomingCountByRoom.get(roomName) || 0;
    },
    getMergeableAutomaticTaskSnapshot(fromRoomName, toRoomName, resource, reason) {
      diagnostics.mergeSnapshotLookupCount += 1;
      const snapshot = mergeableAutomaticTaskByKey.get(
        automaticMergeSnapshotKey(fromRoomName, toRoomName, resource, reason),
      );
      return snapshot ? { ...snapshot } : null;
    },
    recordAutomaticTask: record,
  };
}

const DEFAULT_SAMPLE_INTERVAL = 10;
const DEFAULT_BATCH_SIZE = 500;
const MIN_SAMPLE_INTERVAL = 5;
const MAX_SAMPLE_INTERVAL = 100;
const MIN_BATCH_SIZE = LAB_REACTION_AMOUNT;
const MAX_BATCH_SIZE = 3000;

const SYNTHESIS_BINDING_LEASE_TICKS = 200;
const SYNTHESIS_BINDING_STICKY_BONUS = 5;
const SYNTHESIS_BINDING_SWITCH_ADVANTAGE_RATIO = 1.2;
const SYNTHESIS_CARRIER_TASK_PRODUCER = "synthesisControl";
const SYNTHESIS_LEGACY_TRANSFER_PRIORITY_RANK = 2;
const DEFAULT_RESOURCE_CONTROL_SAMPLE_INTERVAL = 10;
const DEFAULT_RESOURCE_CONTROL_TRANSFER_BATCH_SIZE = 10_000;

function resolveSynthesisLogisticsTtl(synthesisSampleInterval: number): number {
  const resourceControlSampleInterval = normalizeNumber(
    Memory.cfg?.resourceControl?.sampleInterval,
    DEFAULT_RESOURCE_CONTROL_SAMPLE_INTERVAL,
    5,
    100,
  );
  return Math.min(
    500,
    Math.max(30, synthesisSampleInterval * 3, resourceControlSampleInterval * 2),
  );
}

function resolveResourceControlTransferBatchSize(roomName: string): number {
  return normalizeNumber(
    Memory.cfg?.resourceControl?.rooms?.[roomName]?.transferBatchSize,
    DEFAULT_RESOURCE_CONTROL_TRANSFER_BATCH_SIZE,
    100,
    50_000,
  );
}

function getLegacyOutgoingFeeCommitment(
  fromRoomName: string,
  toRoomName: string,
  remainingAmount: number,
): number {
  const batchAmount = Math.min(
    resolveResourceControlTransferBatchSize(fromRoomName),
    Math.max(0, Math.floor(remainingAmount)),
  );
  if (batchAmount <= 0) return 0;
  const fee = Game.market.calcTransactionCost(batchAmount, fromRoomName, toRoomName);
  return Number.isFinite(fee) ? Math.max(0, Math.floor(fee)) : 0;
}

function synthesisLogisticsDemandKey(
  roomName: string,
  product: ResourceConstant,
  reagent: ResourceConstant,
): string {
  return JSON.stringify(["synthesis_room/v1", roomName, product, reagent]);
}

function fingerprintSynthesisLogisticsInput(input: readonly unknown[]): string {
  const canonical = JSON.stringify(input);
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash = Math.imul(hash ^ canonical.charCodeAt(index), 0x01000193);
  }
  return `synthesis-shadow/v1:${(hash >>> 0).toString(16).padStart(8, "0")}:${canonical.length}`;
}

function appendSynthesisLogisticsShadowRecord(
  batch: SynthesisLogisticsShadowBatch | undefined,
  demand: LatestLogisticsDemandDraft,
  observation: Omit<SynthesisLogisticsObservationDraft, "decisionOrder">,
): void {
  if (!batch) return;
  batch.totalCount += 1;
  if (batch.demands.length >= LOGISTICS_CONTROL_STORE_LIMIT) {
    batch.overflowCount += 1;
    return;
  }
  batch.demands.push(demand);
  batch.observations.push({
    ...observation,
    decisionOrder: batch.observations.length,
  });
}

function withdrawSynthesisLogisticsShadow(): void {
  const current = peekLogisticsControlStore();
  if (!current.ok) return;
  const hasPublishedState = Object.values(current.store.latestIntents).some(
    (intent) => intent.producer === SYNTHESIS_ROOM_LOGISTICS_PRODUCER,
  ) || Object.values(current.store.synthesisObservations).some(
    (observation) => observation.producer === SYNTHESIS_ROOM_LOGISTICS_PRODUCER,
  ) || Object.values(current.store.producerSnapshots).some(
    (snapshot) => snapshot.producer === SYNTHESIS_ROOM_LOGISTICS_PRODUCER && snapshot.total > 0,
  ) || Object.keys(current.store.roomFacts).length > 0;
  if (!hasPublishedState) return;
  replaceLatestLogisticsDemandsForProducer(
    SYNTHESIS_ROOM_LOGISTICS_PRODUCER,
    [],
    [],
    { totalCount: 0, overflowCount: 0, roomFacts: [] },
  );
}

function normalizeReactionPlan(raw: unknown, roomCfg: SynthesisRoomConfig, defaultBatchSize: number): SynthesisReactionPlan | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const product = typeof record.product === "string" ? (record.product as ResourceConstant) : null;
  if (!product || !getProductReagents(product)) {
    return null;
  }

  const targetAmount = normalizeNumber(record.targetAmount, 0, 0, 500_000);
  if (targetAmount <= 0) {
    return null;
  }

  const batchSize = normalizeNumber(record.batchSize, roomCfg.batchSize || defaultBatchSize, MIN_BATCH_SIZE, MAX_BATCH_SIZE);
  const donorRoomNames = normalizeRoomNameList(record.donorRoomNames);
  return {
    product,
    targetAmount,
    batchSize,
    donorRoomNames,
  };
}

function normalizeRoomConfig(
  _roomName: string,
  raw: unknown,
  defaultBatchSize: number,
): SynthesisRoomConfig {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const roomCfg: SynthesisRoomConfig = {
    enabled: normalizeBoolean(record.enabled, true),
    batchSize: normalizeNumber(record.batchSize, defaultBatchSize, MIN_BATCH_SIZE, MAX_BATCH_SIZE),
    donorRoomNames: normalizeRoomNameList(record.donorRoomNames),
    reagentLabIds: normalizeRoomNameList(record.reagentLabIds),
    reactions: [],
  };

  if (roomCfg.reagentLabIds.length > 2) {
    roomCfg.reagentLabIds = roomCfg.reagentLabIds.slice(0, 2);
  }

  const reactionsRaw = Array.isArray(record.reactions) ? record.reactions : [];
  roomCfg.reactions = reactionsRaw
    .map((entry) => normalizeReactionPlan(entry, roomCfg, defaultBatchSize))
    .filter((entry): entry is SynthesisReactionPlan => !!entry);

  if (roomCfg.reagentLabIds.length > 0 && roomCfg.reagentLabIds.length < 2) {
    roomCfg.enabled = false;
  }

  return roomCfg;
}

function normalizeConfig(): SynthesisControlConfig {
  const raw = Memory.cfg?.synthesisControl;
  const enabled = normalizeBoolean(raw?.enabled, false);
  const sampleInterval = normalizeNumber(raw?.sampleInterval, DEFAULT_SAMPLE_INTERVAL, MIN_SAMPLE_INTERVAL, MAX_SAMPLE_INTERVAL);
  const defaultBatchSize = normalizeNumber(raw?.defaultBatchSize, DEFAULT_BATCH_SIZE, MIN_BATCH_SIZE, MAX_BATCH_SIZE);

  const roomsRaw = raw?.rooms && typeof raw.rooms === "object" ? (raw.rooms as Record<string, unknown>) : {};
  const rooms: Record<string, SynthesisRoomConfig> = {};
  for (const [roomName, roomCfg] of Object.entries(roomsRaw)) {
    rooms[roomName] = normalizeRoomConfig(roomName, roomCfg, defaultBatchSize);
  }

  return {
    enabled,
    sampleInterval,
    defaultBatchSize,
    rooms,
  };
}

function getRuntimeState(): SynthesisRuntimeState {
  const runtime = getMemoryService().ensureRuntime();
  runtime.synthesisControl = runtime.synthesisControl || {
    updatedAt: Game.time,
    generatedTaskCount: 0,
    failedTaskCount: 0,
    successfulRunCount: 0,
    lastActions: [],
    bindings: {},
    rooms: {},
  };

  runtime.synthesisControl.rooms = runtime.synthesisControl.rooms || {};
  runtime.synthesisControl.bindings = runtime.synthesisControl.bindings || {};
  return runtime.synthesisControl;
}

function roomResourceAmount(room: Room, resource: ResourceConstant): number {
  let total = 0;
  if (room.storage) {
    total += room.storage.store.getUsedCapacity(resource);
  }
  if (room.terminal) {
    total += room.terminal.store.getUsedCapacity(resource);
  }

  const structures = room.find(FIND_MY_STRUCTURES, {
    filter: (structure) =>
      structure.structureType === STRUCTURE_LAB ||
      structure.structureType === STRUCTURE_FACTORY ||
      structure.structureType === STRUCTURE_POWER_SPAWN,
  }) as AnyStoreStructure[];
  for (const structure of structures) {
    total += structure.store.getUsedCapacity(resource);
  }

  return total;
}

function roomTransferableAmount(room: Room, resource: ResourceConstant): number {
  let total = 0;
  if (room.storage) {
    total += room.storage.store.getUsedCapacity(resource);
  }
  if (room.terminal) {
    total += room.terminal.store.getUsedCapacity(resource);
  }
  return total;
}

function countInFlightSynthesisCargo(labId: string, resource: ResourceConstant): number {
  let total = 0;
  for (const creep of Object.values(Game.creeps)) {
    const state = getCreepAssignmentState(creep.name);
    if (!state) continue;
    if (state.synthesisCarrierPendingToId !== labId) continue;
    if (state.synthesisCarrierPendingResource !== resource) continue;
    const carried = creep.store.getUsedCapacity(resource);
    if (carried > 0) {
      total += carried;
    }
  }
  return total;
}

function getResourceReserve(roomName: string, resource: ResourceConstant): number {
  const roomCfg = Memory.cfg?.resourceControl?.rooms?.[roomName];
  if (resource === RESOURCE_ENERGY) {
    const energyTarget = roomCfg?.energyTarget;
    return typeof energyTarget === "number" && Number.isFinite(energyTarget)
      ? Math.max(0, Math.floor(energyTarget))
      : 200_000;
  }

  const floor = roomCfg?.mineralFloor?.[resource];
  return typeof floor === "number" && Number.isFinite(floor) ? Math.max(0, Math.floor(floor)) : 0;
}

function getBindingKey(targetRoomName: string, resource: ResourceConstant): string {
  return `${targetRoomName}:${resource}`;
}

function getActiveBinding(bindings: SynthesisBindingStore, targetRoomName: string, resource: ResourceConstant): SynthesisBinding | null {
  const key = getBindingKey(targetRoomName, resource);
  const binding = bindings[key];
  if (!binding) {
    return null;
  }

  if (binding.expiresAt < Game.time) {
    delete bindings[key];
    return null;
  }

  return binding;
}

function setBinding(bindings: SynthesisBindingStore, targetRoomName: string, resource: ResourceConstant, fromRoomName: string): void {
  const key = getBindingKey(targetRoomName, resource);
  bindings[key] = {
    fromRoomName,
    updatedAt: Game.time,
    expiresAt: Game.time + SYNTHESIS_BINDING_LEASE_TICKS,
  };
}

function selectDonor(
  targetRoom: Room,
  resource: ResourceConstant,
  amount: number,
  donorRoomNames: string[],
  bindings: SynthesisBindingStore,
  transferTasks: SynthesisTransferTaskIndex,
): DonorCandidate | null {
  const binding = getActiveBinding(bindings, targetRoom.name, resource);
  const candidates: DonorCandidate[] = [];

  for (const room of getTickContextService().getMyRooms()) {
    if (room.name === targetRoom.name || !room.terminal || room.terminal.cooldown > 0) {
      continue;
    }
    if (donorRoomNames.length > 0 && !donorRoomNames.includes(room.name)) {
      continue;
    }

    const total = roomResourceAmount(room, resource);
    const reserve = getResourceReserve(room.name, resource);
    const outgoing = transferTasks.getOutgoingAmount(room.name, resource);
    const reserved = getReservedProductionAmountExcludingOwner(room.name, resource, {
      kind: "logical-service",
      id: `synthesis:${targetRoom.name}:${resource}`,
      namespace: "synthesis",
      roomName: targetRoom.name,
    });
    const exportable = Math.max(0, total - reserve - outgoing - reserved);
    if (exportable <= 0) {
      continue;
    }

    const terminalAmount = room.terminal.store.getUsedCapacity(resource);
    const sendable = Math.min(exportable, terminalAmount);
    if (sendable <= 0) {
      continue;
    }

    const scoreAmount = Math.max(1, Math.min(amount, sendable));
    const transferCost = Game.market.calcTransactionCost(scoreAmount, room.name, targetRoom.name);
    const transferCostRatio = transferCost / scoreAmount;
    const queuePenalty = transferTasks.getPendingOutgoingCount(room.name) * 0.6;
    const stickyBonus = binding?.fromRoomName === room.name ? SYNTHESIS_BINDING_STICKY_BONUS : 0;
    const score = sendable / scoreAmount - transferCostRatio * 6 - queuePenalty + stickyBonus;
    candidates.push({ room, sendable, score });
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => right.score - left.score);
  const best = candidates[0];
  if (!binding) {
    return best;
  }

  const bound = candidates.find((candidate) => candidate.room.name === binding.fromRoomName);
  if (!bound) {
    return best;
  }

  if (best.score >= bound.score * SYNTHESIS_BINDING_SWITCH_ADVANTAGE_RATIO) {
    return best;
  }

  return bound;
}

function getConfiguredLab(room: Room, id: string): StructureLab | null {
  const candidate = Game.getObjectById(id as Id<StructureLab>);
  if (!candidate || candidate.room.name !== room.name || candidate.structureType !== STRUCTURE_LAB) {
    return null;
  }
  return candidate;
}

function resolveLabTopology(room: Room, roomCfg: SynthesisRoomConfig): LabTopology | null {
  const labs = room.find(FIND_MY_STRUCTURES, {
    filter: (structure) => structure.structureType === STRUCTURE_LAB,
  }) as StructureLab[];
  if (labs.length < 3) {
    return null;
  }

  if (roomCfg.reagentLabIds.length === 2) {
    const first = getConfiguredLab(room, roomCfg.reagentLabIds[0]);
    const second = getConfiguredLab(room, roomCfg.reagentLabIds[1]);
    if (first && second) {
      const productLabs = labs.filter(
        (lab) =>
          lab.id !== first.id &&
          lab.id !== second.id &&
          lab.pos.inRangeTo(first.pos, 2) &&
          lab.pos.inRangeTo(second.pos, 2),
      );
      if (productLabs.length > 0) {
        return {
          reagentLabs: [first, second],
          productLabs,
        };
      }
    }
  }

  // Prefer room planner layout's reagent lab positions over brute-force search.
  // getSortedLabPlannedPositions() returns [...planned.slice(-2), ...planned.slice(0, -2)],
  // so the last 2 positions in the layout array are the planned reagent labs.
  const plannedLayout = (Memory.data as any)?.roomPlanner?.[room.name]?.layout as
    | { [structureType: string]: { x: number; y: number }[] }
    | undefined;
  const plannedLabPositions = plannedLayout?.[STRUCTURE_LAB];
  if (plannedLabPositions && plannedLabPositions.length >= 2) {
    const reagentPositions = plannedLabPositions.slice(-2);
    const firstPlanned = labs.find(
      (lab) => lab.pos.x === reagentPositions[0].x && lab.pos.y === reagentPositions[0].y,
    );
    const secondPlanned = labs.find(
      (lab) => lab.pos.x === reagentPositions[1].x && lab.pos.y === reagentPositions[1].y,
    );
    if (firstPlanned && secondPlanned) {
      const productLabs = labs.filter(
        (lab) =>
          lab.id !== firstPlanned.id &&
          lab.id !== secondPlanned.id &&
          lab.pos.inRangeTo(firstPlanned.pos, 2) &&
          lab.pos.inRangeTo(secondPlanned.pos, 2),
      );
      if (productLabs.length > 0) {
        return {
          reagentLabs: [firstPlanned, secondPlanned],
          productLabs,
        };
      }
    }
  }

  let best: LabTopology | null = null;
  for (let i = 0; i < labs.length; i += 1) {
    for (let j = i + 1; j < labs.length; j += 1) {
      const first = labs[i];
      const second = labs[j];
      const productLabs = labs.filter(
        (lab) =>
          lab.id !== first.id &&
          lab.id !== second.id &&
          lab.pos.inRangeTo(first.pos, 2) &&
          lab.pos.inRangeTo(second.pos, 2),
      );
      if (productLabs.length === 0) {
        continue;
      }

      if (!best || productLabs.length > best.productLabs.length) {
        best = {
          reagentLabs: [first, second],
          productLabs,
        };
      }
    }
  }

  return best;
}

function isLabContaminatedForExpected(lab: StructureLab, expectedMineral: ResourceConstant): boolean {
  const mineralType = lab.mineralType as ResourceConstant | undefined;
  if (!mineralType) {
    return false;
  }

  if (lab.store.getUsedCapacity(mineralType) <= 0) {
    return false;
  }

  return mineralType !== expectedMineral;
}

function isReagentReady(lab: StructureLab, reagent: ResourceConstant): boolean {
  const mineralType = lab.mineralType as ResourceConstant | undefined;
  if (mineralType && mineralType !== reagent) {
    return false;
  }

  return lab.store.getUsedCapacity(reagent) >= LAB_REACTION_AMOUNT;
}

function canAcceptProduct(lab: StructureLab, product: ResourceConstant): boolean {
  const mineralType = lab.mineralType as ResourceConstant | undefined;
  if (mineralType && mineralType !== product) {
    return false;
  }

  const used = mineralType ? lab.store.getUsedCapacity(mineralType) : 0;
  return used < LAB_MINERAL_CAPACITY;
}

function reagentAssignmentPenalty(lab: StructureLab, reagent: ResourceConstant): number {
  const mineralType = lab.mineralType as ResourceConstant | undefined;
  if (!mineralType) {
    return 0;
  }
  if (mineralType === reagent || lab.store.getUsedCapacity(mineralType) <= 0) {
    return 0;
  }
  return 100;
}

function orderReagentLabs(
  reagentLabs: [StructureLab, StructureLab],
  reagents: [ResourceConstant, ResourceConstant],
): [StructureLab, StructureLab] {
  const directPenalty =
    reagentAssignmentPenalty(reagentLabs[0], reagents[0]) +
    reagentAssignmentPenalty(reagentLabs[1], reagents[1]);
  const swappedPenalty =
    reagentAssignmentPenalty(reagentLabs[0], reagents[1]) +
    reagentAssignmentPenalty(reagentLabs[1], reagents[0]);

  if (swappedPenalty < directPenalty) {
    return [reagentLabs[1], reagentLabs[0]];
  }

  return reagentLabs;
}

function createRoomState(stage: SynthesisStage, lastTransitionAt: number): SynthesisRoomRuntimeState {
  return {
    stage,
    reagentLabIds: [],
    productLabIds: [],
    successfulRuns: 0,
    pendingTasks: 0,
    lastTransitionAt,
  };
}

function getReactionInterval(product: ResourceConstant): number {
  const interval = (REACTION_TIME as Partial<Record<ResourceConstant, number>>)[product];
  return typeof interval === "number" && Number.isFinite(interval) && interval > 0
    ? Math.floor(interval)
    : 1;
}

function shouldWaitForScheduledReaction(
  roomState: SynthesisRoomRuntimeState,
  roomCfg: SynthesisRoomConfig,
  autoPlan?: SynthesisReactionPlan | null,
): boolean {
  if (
    roomState.stage !== "synthesizing" ||
    roomState.boostPause ||
    typeof roomState.nextReactionAt !== "number" ||
    !Number.isFinite(roomState.nextReactionAt) ||
    Game.time >= roomState.nextReactionAt ||
    roomState.productLabIds.length === 0
  ) {
    return false;
  }

  const plans = [
    ...roomCfg.reactions,
    ...(autoPlan ? [autoPlan] : []),
  ];
  const activePlanStillConfigured = plans.some(
    (plan) =>
      roomState.activeProduct === plan.product &&
      roomState.targetAmount === plan.targetAmount &&
      roomState.batchSize === plan.batchSize,
  );
  if (!activePlanStillConfigured) {
    return false;
  }

  if (roomCfg.reagentLabIds.length === 2) {
    const boundReagentIds = new Set(roomState.reagentLabIds);
    if (roomCfg.reagentLabIds.some((labId) => !boundReagentIds.has(labId))) {
      return false;
    }
  }

  return true;
}

function createCarrierTaskId(type: "lab_supply" | "lab_cleanup" | "lab_product_unload", roomName: string, product: ResourceConstant): string {
  return `synthesis:${type}:${roomName}:${product}`;
}

function createCarrierTaskStepId(resource: ResourceConstant, fromId: string, toId: string): string {
  return `${resource}:${fromId}->${toId}`;
}

function resolveCleanupTargetStructure(room: Room, resource: ResourceConstant): StructureTerminal | StructureStorage | null {
  return resolveTerminalStorageTarget(room, resource, "terminal");
}

function resolveSupplySourceStructure(room: Room, resource: ResourceConstant): StructureTerminal | StructureStorage | null {
  const terminalAmount = room.terminal?.store.getUsedCapacity(resource) || 0;
  const storageAmount = room.storage?.store.getUsedCapacity(resource) || 0;
  if (terminalAmount <= 0 && storageAmount <= 0) {
    return null;
  }

  if (terminalAmount >= storageAmount && room.terminal && terminalAmount > 0) {
    return room.terminal;
  }
  if (room.storage && storageAmount > 0) {
    return room.storage;
  }

  return room.terminal && terminalAmount > 0 ? room.terminal : null;
}

function generateCleanupTask(
  room: Room,
  orderedReagentLabs: [StructureLab, StructureLab],
  productLabs: StructureLab[],
  reagents: [ResourceConstant, ResourceConstant],
  product: ResourceConstant,
): CarrierTaskDraft | null {
  const steps: CarrierTaskStep[] = [];
  const expectedByLab = new Map<string, ResourceConstant>([
    [orderedReagentLabs[0].id, reagents[0]],
    [orderedReagentLabs[1].id, reagents[1]],
  ]);
  for (const lab of productLabs) {
    expectedByLab.set(lab.id, product);
  }

  for (const [labId, expectedMineral] of expectedByLab.entries()) {
    const lab = Game.getObjectById(labId as Id<StructureLab>);
    if (!lab) {
      continue;
    }

    const mineralType = lab.mineralType as ResourceConstant | undefined;
    if (!mineralType || mineralType === expectedMineral) {
      continue;
    }

    const amount = lab.store.getUsedCapacity(mineralType);
    if (amount <= 0) {
      continue;
    }

    const target = resolveCleanupTargetStructure(room, mineralType);
    if (!target) {
      if (Memory.cfg.hub?.hubRoomName === room.name) {
        if (!Memory.runtime.hub) Memory.runtime.hub = {};
        Memory.runtime.hub.lastError = "lab_cleanup_destination_full";
      }
      continue;
    }

    steps.push({
      id: createCarrierTaskStepId(mineralType, lab.id, target.id),
      resource: mineralType,
      amount,
      fromKind: "lab",
      toKind: terminalStorageKind(target),
      fromId: lab.id,
      toId: target.id,
    });
  }

  if (steps.length === 0) {
    return null;
  }

  return {
    id: createCarrierTaskId("lab_cleanup", room.name, product),
    type: "lab_cleanup",
    priority: 200,
    steps,
  };
}

function resolveProductUnloadTargetStructure(room: Room, resource: ResourceConstant): StructureStorage | StructureTerminal | null {
  return resolveTerminalStorageTarget(room, resource, "storage");
}

function generateProductUnloadTask(
  room: Room,
  productLabs: StructureLab[],
  product: ResourceConstant,
  targetAmount: number,
  minLabAmount: number = 700,
): CarrierTaskDraft | null {
  const transferableCurrent = roomTransferableAmount(room, product);
  if (transferableCurrent >= targetAmount) {
    return null;
  }

  const steps: CarrierTaskStep[] = [];
  for (const lab of productLabs) {
    if (lab.mineralType !== product) {
      continue;
    }
    const amount = lab.store.getUsedCapacity(product);
    if (amount < minLabAmount) {
      continue;
    }

    const target = resolveProductUnloadTargetStructure(room, product);
    if (!target) {
      if (Memory.cfg.hub?.hubRoomName === room.name) {
        if (!Memory.runtime.hub) Memory.runtime.hub = {};
        Memory.runtime.hub.lastError = "lab_product_unload_destination_full";
      }
      continue;
    }

    steps.push({
      id: createCarrierTaskStepId(product, lab.id, target.id),
      resource: product,
      amount,
      fromKind: "lab",
      toKind: terminalStorageKind(target),
      fromId: lab.id,
      toId: target.id,
    });
  }

  if (steps.length === 0) {
    return null;
  }

  return {
    id: createCarrierTaskId("lab_product_unload", room.name, product),
    type: "lab_product_unload",
    priority: 180,
    steps,
  };
}

function generateStrandedProductUnloadTask(
  room: Room,
  productLabs: StructureLab[],
  roomCfg: SynthesisRoomConfig,
  autoPlan?: SynthesisReactionPlan | null,
  minLabAmount: number = 700,
): { task: CarrierTaskDraft; product: ResourceConstant; targetAmount?: number } | null {
  const steps: CarrierTaskStep[] = [];
  let firstDetectedMineral: ResourceConstant | undefined;

  for (const lab of productLabs) {
    const mineralType = lab.mineralType;
    if (!mineralType) continue;
    const amount = lab.store.getUsedCapacity(mineralType);
    if (amount < minLabAmount) continue;

    const target = resolveProductUnloadTargetStructure(room, mineralType);
    if (!target) continue;

    if (!firstDetectedMineral) {
      firstDetectedMineral = mineralType;
    }

    steps.push({
      id: createCarrierTaskStepId(mineralType, lab.id, target.id),
      resource: mineralType,
      amount,
      fromKind: "lab",
      toKind: terminalStorageKind(target),
      fromId: lab.id,
      toId: target.id,
    });
  }

  if (steps.length === 0 || !firstDetectedMineral) {
    return null;
  }

  const detectedProduct = firstDetectedMineral as ResourceConstant;

  // Derive targetAmount from matching reaction in roomCfg or autoPlan
  let targetAmount: number | undefined;
  const matchingReaction = roomCfg.reactions.find((r) => r.product === detectedProduct);
  if (matchingReaction) {
    targetAmount = matchingReaction.targetAmount;
  } else if (autoPlan && autoPlan.product === detectedProduct) {
    targetAmount = autoPlan.targetAmount;
  }

  return {
    task: {
      id: createCarrierTaskId("lab_product_unload", room.name, detectedProduct),
      type: "lab_product_unload",
      priority: 180,
      steps,
    },
    product: detectedProduct,
    targetAmount,
  };
}

function generateReagentCleanupTask(
  room: Room,
  allLabs: StructureLab[],
  excludedLabIds: Set<string> = new Set(),
): CarrierTaskDraft | null {
  const steps: CarrierTaskStep[] = [];

  for (const lab of allLabs) {
    if (excludedLabIds.has(lab.id)) continue;
    const mineralType = lab.mineralType;
    if (!mineralType) continue;
    const amount = lab.store.getUsedCapacity(mineralType);
    if (amount <= 0) continue;

    const target = resolveProductUnloadTargetStructure(room, mineralType);
    if (!target) continue;

    steps.push({
      id: createCarrierTaskStepId(mineralType, lab.id, target.id),
      resource: mineralType,
      amount,
      fromKind: "lab",
      toKind: terminalStorageKind(target),
      fromId: lab.id,
      toId: target.id,
    });
  }

  if (steps.length === 0) return null;

  return {
    id: `synthesis:lab_cleanup:${room.name}:reagent-residue`,
    type: "lab_cleanup",
    priority: 190,
    steps,
  };
}

function generateSupplyTask(
  room: Room,
  orderedReagentLabs: [StructureLab, StructureLab],
  reagents: [ResourceConstant, ResourceConstant],
  batchSize: number,
  product: ResourceConstant,
  targetAmount: number,
): CarrierTaskDraft | null {
  const steps: CarrierTaskStep[] = [];
  const productDeficit = Math.max(0, targetAmount - roomResourceAmount(room, product));
  const deficitBoundedAmount = productDeficit > 0 ? roundUpReactionAmount(productDeficit) : 0;
  const desiredLabAmount = productDeficit > 0
    ? Math.min(LAB_MINERAL_CAPACITY, batchSize, deficitBoundedAmount)
    : Math.min(LAB_MINERAL_CAPACITY, Math.max(LAB_REACTION_AMOUNT, batchSize));

  for (let index = 0; index < orderedReagentLabs.length; index += 1) {
    const lab = orderedReagentLabs[index];
    const reagent = reagents[index];
    const mineralType = lab.mineralType as ResourceConstant | undefined;
    if (mineralType && mineralType !== reagent && lab.store.getUsedCapacity(mineralType) > 0) {
      continue;
    }

    const currentAmount = mineralType === reagent ? lab.store.getUsedCapacity(reagent) : 0;
    const inFlightAmount = countInFlightSynthesisCargo(lab.id, reagent);
    const effectiveCurrentAmount = currentAmount + inFlightAmount;
    if (effectiveCurrentAmount > 2200) continue;
    const deficit = Math.max(0, desiredLabAmount - effectiveCurrentAmount);
    const isPartialTopUp = deficit > 0 && deficit < LAB_REACTION_AMOUNT
      && desiredLabAmount >= LAB_REACTION_AMOUNT
      && effectiveCurrentAmount > 0;
    if (deficit < LAB_REACTION_AMOUNT && !isPartialTopUp) {
      continue;
    }

    const source = resolveSupplySourceStructure(room, reagent);
    if (!source) {
      continue;
    }

    const available = source.store.getUsedCapacity(reagent);
    const amount = Math.min(deficit, available);
    const isAmountPartialTopUp = amount > 0 && amount < LAB_REACTION_AMOUNT
      && desiredLabAmount >= LAB_REACTION_AMOUNT
      && effectiveCurrentAmount > 0;
    if (amount < LAB_REACTION_AMOUNT && !isAmountPartialTopUp) {
      continue;
    }

    steps.push({
      id: createCarrierTaskStepId(reagent, source.id, lab.id),
      resource: reagent,
      amount,
      fromKind: terminalStorageKind(source),
      toKind: "lab",
      fromId: source.id,
      toId: lab.id,
    });
  }

  if (steps.length === 0) {
    return null;
  }

  return {
    id: createCarrierTaskId("lab_supply", room.name, product),
    type: "lab_supply",
    priority: 100,
    steps,
  };
}

function chooseActivePlan(room: Room, roomCfg: SynthesisRoomConfig, autoPlan?: SynthesisReactionPlan | null): SynthesisReactionPlan | null {
  for (const plan of roomCfg.reactions) {
    const current = roomResourceAmount(room, plan.product);
    if (!isTargetSatisfiedByReactionGranularity(current, plan.targetAmount)) {
      return plan;
    }
  }

  if (autoPlan) {
    const current = roomResourceAmount(room, autoPlan.product);
    if (!isTargetSatisfiedByReactionGranularity(current, autoPlan.targetAmount)) {
      return autoPlan;
    }
  }

  return null;
}

function mergeDonorPriority(roomCfg: SynthesisRoomConfig, reactionPlan: SynthesisReactionPlan): string[] {
  if (reactionPlan.donorRoomNames.length > 0) {
    return reactionPlan.donorRoomNames;
  }

  return roomCfg.donorRoomNames;
}

function countPendingToRoom(
  roomName: string,
  transferTasks: SynthesisTransferTaskIndex,
): number {
  return transferTasks.getDemandCoveringIncomingCount(roomName);
}

function maybeGenerateSupplyTasks(
  room: Room,
  roomCfg: SynthesisRoomConfig,
  reactionPlan: SynthesisReactionPlan,
  reagents: [ResourceConstant, ResourceConstant],
  topology: LabTopology,
  transferTasks: SynthesisTransferTaskIndex,
  runtime: SynthesisRuntimeState,
  actions: string[],
  shadowBatch?: SynthesisLogisticsShadowBatch,
): { generated: number; failed: number; missing: Partial<Record<ResourceConstant, number>> } {
  const missing: Partial<Record<ResourceConstant, number>> = {};
  let generated = 0;
  let failed = 0;
  const mergedDonors = mergeDonorPriority(roomCfg, reactionPlan);

  const reagentNeedMap = new Map<ResourceConstant, number>();
  for (const reagent of reagents) {
    reagentNeedMap.set(reagent, (reagentNeedMap.get(reagent) || 0) + reactionPlan.batchSize);
  }

  for (const [reagent, needAmount] of reagentNeedMap.entries()) {
    const bufferedInLabs = topology.reagentLabs.reduce((sum, lab) => {
      const mineralType = lab.mineralType as ResourceConstant | undefined;
      if (!mineralType || mineralType !== reagent) {
        return sum;
      }

      return sum + lab.store.getUsedCapacity(reagent);
    }, 0);
    const current = roomTransferableAmount(room, reagent) + bufferedInLabs;
    const incoming = transferTasks.getIncomingAmount(room.name, reagent);
    const deficit = Math.max(0, needAmount - current - incoming);
    const reason = `synthesis:${room.name}:${reactionPlan.product}`;
    const shadowDemand = shadowBatch
      ? measureLogisticsShadowCpu("producer", () => {
          const demandKey = synthesisLogisticsDemandKey(room.name, reactionPlan.product, reagent);
          const priorityClass: LogisticsPriorityClass = mapLegacyTransferPriority("automatic", reason);
          const fixedSourceRoomNames = [...new Set(mergedDonors)].sort();
          const demand: LatestLogisticsDemandDraft = {
            demandKey,
            origin: "synthesis_room",
            active: true,
            targetRoomName: room.name,
            resource: reagent,
            desiredAmount: needAmount,
            priorityClass,
            ttl: shadowBatch.ttl,
            minBatch: 1,
            maxBatch: reactionPlan.batchSize,
            product: reactionPlan.product,
            ...(fixedSourceRoomNames.length === 0 ? {} : { fixedSourceRoomNames }),
          };
          return { demandKey, priorityClass, fixedSourceRoomNames, demand };
        })
      : null;
    if (deficit <= 0) {
      if (shadowDemand) {
        measureLogisticsShadowCpu("producer", () => {
          appendSynthesisLogisticsShadowRecord(shadowBatch, shadowDemand.demand, {
            demandKey: shadowDemand.demandKey,
            inputFingerprint: fingerprintSynthesisLogisticsInput([
              "synthesis_room/v1",
              Game.time,
              shadowDemand.demandKey,
              needAmount,
              current,
              incoming,
              deficit,
              shadowDemand.fixedSourceRoomNames,
              null,
              0,
              reason,
              shadowDemand.priorityClass,
              SYNTHESIS_LEGACY_TRANSFER_PRIORITY_RANK,
            ]),
            localAmount: current,
            incomingAmount: incoming,
            uncoveredAmount: deficit,
            comparableReason: "comparable",
            legacyDecision: "no_op",
            legacyPriorityRank: SYNTHESIS_LEGACY_TRANSFER_PRIORITY_RANK,
            legacyPriorityClass: shadowDemand.priorityClass,
            legacyAmount: 0,
            legacyAddedAmount: 0,
            legacyRemainingBefore: 0,
            legacyFeeDelta: 0,
          });
        });
      }
      continue;
    }

    missing[reagent] = deficit;
    const donor = selectDonor(
      room,
      reagent,
      deficit,
      mergedDonors,
      runtime.bindings,
      transferTasks,
    );
    if (!donor) {
      if (shadowDemand) {
        measureLogisticsShadowCpu("producer", () => {
          appendSynthesisLogisticsShadowRecord(shadowBatch, shadowDemand.demand, {
            demandKey: shadowDemand.demandKey,
            inputFingerprint: fingerprintSynthesisLogisticsInput([
              "synthesis_room/v1",
              Game.time,
              shadowDemand.demandKey,
              needAmount,
              current,
              incoming,
              deficit,
              shadowDemand.fixedSourceRoomNames,
              null,
              0,
              reason,
              shadowDemand.priorityClass,
              SYNTHESIS_LEGACY_TRANSFER_PRIORITY_RANK,
            ]),
            localAmount: current,
            incomingAmount: incoming,
            uncoveredAmount: deficit,
            comparableReason: "comparable",
            legacyDecision: "no_donor",
            legacyPriorityRank: SYNTHESIS_LEGACY_TRANSFER_PRIORITY_RANK,
            legacyPriorityClass: shadowDemand.priorityClass,
            legacyAmount: 0,
            legacyAddedAmount: 0,
            legacyRemainingBefore: 0,
            legacyFeeDelta: 0,
          });
        });
      }
      failed += 1;
      actions.push(`synthesis-task-failed:${room.name}:${reagent}:no_donor`);
      signalHubNeedsPlan(room.name);
      continue;
    }

    const amount = Math.min(deficit, donor.sendable, reactionPlan.batchSize);
    if (amount <= 0) {
      if (shadowDemand) {
        measureLogisticsShadowCpu("producer", () => {
          appendSynthesisLogisticsShadowRecord(shadowBatch, shadowDemand.demand, {
            demandKey: shadowDemand.demandKey,
            inputFingerprint: fingerprintSynthesisLogisticsInput([
              "synthesis_room/v1",
              Game.time,
              shadowDemand.demandKey,
              needAmount,
              current,
              incoming,
              deficit,
              shadowDemand.fixedSourceRoomNames,
              donor.room.name,
              donor.sendable,
              0,
              reason,
              shadowDemand.priorityClass,
              SYNTHESIS_LEGACY_TRANSFER_PRIORITY_RANK,
            ]),
            localAmount: current,
            incomingAmount: incoming,
            uncoveredAmount: deficit,
            comparableReason: "input_unavailable",
            legacyDecision: "no_op",
            legacyPriorityRank: SYNTHESIS_LEGACY_TRANSFER_PRIORITY_RANK,
            legacyPriorityClass: shadowDemand.priorityClass,
            legacySourceRoomName: donor.room.name,
            legacyAmount: 0,
            legacyAddedAmount: 0,
            legacyRemainingBefore: 0,
            legacyFeeDelta: 0,
          });
        });
      }
      continue;
    }

    const shadowLegacyInput = shadowDemand
      ? measureLogisticsShadowCpu("producer", () => {
          const mergeTargetBefore = transferTasks.getMergeableAutomaticTaskSnapshot(
            donor.room.name,
            room.name,
            reagent,
            reason,
          );
          const legacyRemainingBefore = mergeTargetBefore?.remainingAmount || 0;
          const inputFingerprint = fingerprintSynthesisLogisticsInput([
            "synthesis_room/v1",
            Game.time,
            shadowDemand.demandKey,
            needAmount,
            current,
            incoming,
            deficit,
            shadowDemand.fixedSourceRoomNames,
            donor.room.name,
            donor.sendable,
            donor.score,
            amount,
            mergeTargetBefore?.taskId ?? null,
            legacyRemainingBefore,
            resolveResourceControlTransferBatchSize(donor.room.name),
            getLegacyOutgoingFeeCommitment(
              donor.room.name,
              room.name,
              legacyRemainingBefore,
            ),
            reason,
            shadowDemand.priorityClass,
            SYNTHESIS_LEGACY_TRANSFER_PRIORITY_RANK,
          ]);
          return { mergeTargetBefore, legacyRemainingBefore, inputFingerprint };
        })
      : undefined;
    const mergeTargetBefore = shadowLegacyInput?.mergeTargetBefore ?? null;
    const legacyRemainingBefore = shadowLegacyInput?.legacyRemainingBefore || 0;
    const inputFingerprint = shadowLegacyInput?.inputFingerprint;

    const task = createAutomaticResourceTransferTask(
      donor.room.name,
      room.name,
      reagent,
      amount,
      reason,
    );
    if (typeof task === "string") {
      if (shadowDemand && inputFingerprint) {
        measureLogisticsShadowCpu("producer", () => {
          appendSynthesisLogisticsShadowRecord(shadowBatch, shadowDemand.demand, {
            demandKey: shadowDemand.demandKey,
            inputFingerprint,
            localAmount: current,
            incomingAmount: incoming,
            uncoveredAmount: deficit,
            comparableReason: "legacy_unpaired",
            legacyDecision: "failed",
            legacyPriorityRank: SYNTHESIS_LEGACY_TRANSFER_PRIORITY_RANK,
            legacyPriorityClass: shadowDemand.priorityClass,
            legacySourceRoomName: donor.room.name,
            legacyAmount: amount,
            legacyAddedAmount: 0,
            legacyRemainingBefore,
            legacyFeeDelta: 0,
          });
        });
      }
      failed += 1;
      actions.push(`synthesis-task-failed:${room.name}:${reagent}:${task}`);
      continue;
    }

    if (shadowDemand && inputFingerprint) {
      measureLogisticsShadowCpu("producer", () => {
        const exactRemainingBefore = mergeTargetBefore?.taskId === task.task.id
          ? mergeTargetBefore.remainingAmount
          : 0;
        const exactAddedAmount = Math.max(0, task.task.remainingAmount - exactRemainingBefore);
        const exactLegacyFeeBefore = getLegacyOutgoingFeeCommitment(
          donor.room.name,
          room.name,
          exactRemainingBefore,
        );
        const legacyFeeAfter = getLegacyOutgoingFeeCommitment(
          donor.room.name,
          room.name,
          task.task.remainingAmount,
        );
        appendSynthesisLogisticsShadowRecord(shadowBatch, shadowDemand.demand, {
          demandKey: shadowDemand.demandKey,
          inputFingerprint,
          localAmount: current,
          incomingAmount: incoming,
          uncoveredAmount: deficit,
          comparableReason: "comparable",
          legacyDecision: mergeTargetBefore?.taskId === task.task.id ? "merged" : "created",
          legacyPriorityRank: SYNTHESIS_LEGACY_TRANSFER_PRIORITY_RANK,
          legacyPriorityClass: shadowDemand.priorityClass,
          legacySourceRoomName: donor.room.name,
          legacyAmount: amount,
          legacyTaskId: task.task.id,
          legacyAddedAmount: exactAddedAmount,
          legacyRemainingBefore: exactRemainingBefore,
          legacyFeeDelta: Math.max(0, legacyFeeAfter - exactLegacyFeeBefore),
        });
      });
    }

    transferTasks.recordAutomaticTask(task.task, amount);
    setBinding(runtime.bindings, room.name, reagent, donor.room.name);
    generated += 1;
    actions.push(`synthesis-task-generated:${task.task.id}:${reagent}=${amount}:${donor.room.name}->${room.name}`);
  }

  return {
    generated,
    failed,
    missing,
  };
}

function signalHubNeedsPlan(roomName: string): void {
  const hubRoomName = Memory.cfg?.hub?.hubRoomName;
  const isHub = hubRoomName === roomName;

  if (!isHub) {
    if (!Memory.cfg?.synthesisControl?.rooms?.[roomName]) return;

    const lastPlanTick = Memory.runtime?.hub?.lastPlanTick ?? 0;
    const planInterval = Memory.cfg?.hub?.planInterval ?? 50;
    if (Game.time - lastPlanTick < planInterval) return;
  }

  if (!Memory.runtime) Memory.runtime = {} as any;
  if (!Memory.runtime.hub) {
    Memory.runtime.hub = { needsPlan: true, updatedAt: Game.time };
  } else {
    Memory.runtime.hub.needsPlan = true;
  }
}

function handleRoom(
  roomName: string,
  roomCfg: SynthesisRoomConfig,
  planningTick: boolean,
  runtime: SynthesisRuntimeState,
  actions: string[],
  transferTasks: SynthesisTransferTaskIndex,
  autoPlan?: SynthesisReactionPlan | null,
  shadowBatch?: SynthesisLogisticsShadowBatch,
): { generated: number; failed: number; runs: number } {
  let generated = 0;
  let failed = 0;
  let runs = 0;

  const roomState = runtime.rooms[roomName] || createRoomState("idle", Game.time);
  runtime.rooms[roomName] = roomState;

  if (!roomCfg.enabled) {
    replaceCarrierTasksForProducerRoom(SYNTHESIS_CARRIER_TASK_PRODUCER, roomName, []);
    runtime.rooms[roomName] = {
      ...roomState,
      stage: "blocked",
      cleanupTasks: undefined,
      nextReactionAt: undefined,
      lastError: "room_config_disabled",
      lastTransitionAt: Game.time,
    };
    return { generated, failed, runs };
  }

  const room = Game.rooms[roomName];
  if (!room?.controller?.my || !room.terminal) {
    replaceCarrierTasksForProducerRoom(SYNTHESIS_CARRIER_TASK_PRODUCER, roomName, []);
    runtime.rooms[roomName] = {
      ...roomState,
      stage: "blocked",
      cleanupTasks: undefined,
      nextReactionAt: undefined,
      lastError: "room_or_terminal_unavailable",
      lastTransitionAt: Game.time,
    };
    return { generated, failed, runs };
  }

  if (shouldWaitForScheduledReaction(roomState, roomCfg, autoPlan)) {
    return { generated, failed, runs };
  }

  const topology = resolveLabTopology(room, roomCfg);
  if (!topology) {
    replaceCarrierTasksForProducerRoom(SYNTHESIS_CARRIER_TASK_PRODUCER, roomName, []);
    runtime.rooms[roomName] = {
      ...roomState,
      stage: "blocked",
      lastError: "lab_topology_unavailable",
      lastTransitionAt: Game.time,
      reagentLabIds: [],
      productLabIds: [],
      cleanupTasks: undefined,
      nextReactionAt: undefined,
    };
    return { generated, failed, runs };
  }

  if (roomState.boostPause) {
    const allLabs = [...topology.reagentLabs, ...topology.productLabs];
    const excludedLabIds = getActivePowerBankBoostLabIds(roomName);
    const reagentCleanupTask = generateReagentCleanupTask(room, allLabs, excludedLabIds);
    replaceCarrierTasksForProducerRoom(
      SYNTHESIS_CARRIER_TASK_PRODUCER,
      roomName,
      reagentCleanupTask ? [reagentCleanupTask] : [],
    );
    runtime.rooms[roomName] = {
      ...roomState,
      stage: reagentCleanupTask ? "unloading" : "idle",
      pendingTasks: countPendingToRoom(roomName, transferTasks),
      reagentLabIds: topology.reagentLabs.map((lab) => lab.id),
      productLabIds: topology.productLabs.map((lab) => lab.id),
      nextReactionAt: undefined,
    };
    return { generated, failed, runs };
  }

  const activePlan = chooseActivePlan(room, roomCfg, autoPlan);
  if (!activePlan) {
    const unloadProduct = roomState.activeProduct as ResourceConstant | undefined;
    const unloadTarget = roomState.targetAmount as number | undefined;
    let productUnloadTask = unloadProduct && unloadTarget
      ? generateProductUnloadTask(room, topology.productLabs, unloadProduct, unloadTarget, 1)
      : null;

    let strandedResult: ReturnType<typeof generateStrandedProductUnloadTask> = null;
    if (!productUnloadTask && (!unloadProduct || !unloadTarget)) {
      strandedResult = generateStrandedProductUnloadTask(room, topology.productLabs, roomCfg, autoPlan, 1);
      if (strandedResult) {
        productUnloadTask = strandedResult.task;
      }
    }

    let reagentCleanupTask: CarrierTaskDraft | null = null;
    if (!productUnloadTask) {
      const allLabs = [...topology.reagentLabs, ...topology.productLabs];
      reagentCleanupTask = generateReagentCleanupTask(room, allLabs);
    }

    const allTasks = [
      ...(productUnloadTask ? [productUnloadTask] : []),
      ...(reagentCleanupTask ? [reagentCleanupTask] : []),
    ];
    replaceCarrierTasksForProducerRoom(
      SYNTHESIS_CARRIER_TASK_PRODUCER,
      roomName,
      allTasks,
    );

    const hasAnyCleanup = productUnloadTask || reagentCleanupTask;
    runtime.rooms[roomName] = {
      ...roomState,
      stage: hasAnyCleanup ? "unloading" : "idle",
      activeProduct: hasAnyCleanup
        ? (strandedResult ? strandedResult.product : unloadProduct ?? undefined)
        : undefined,
      reagentA: undefined,
      reagentB: undefined,
      targetAmount: hasAnyCleanup
        ? (strandedResult ? strandedResult.targetAmount ?? unloadTarget : unloadTarget) ?? undefined
        : undefined,
      batchSize: undefined,
      missing: undefined,
      cleanupTasks: undefined,
      lastError: undefined,
      loadingSinceTick: undefined,
      nextReactionAt: undefined,
      pendingTasks: countPendingToRoom(roomName, transferTasks),
      reagentLabIds: topology.reagentLabs.map((lab) => lab.id),
      productLabIds: topology.productLabs.map((lab) => lab.id),
    };

    if (!hasAnyCleanup && roomState.stage === "unloading") {
      signalHubNeedsPlan(room.name);
    }

    if (roomState.stage !== "idle" && roomState.stage !== "unloading") {
      signalHubNeedsPlan(room.name);
    }

    return { generated, failed, runs };
  }

  const reagents = getProductReagents(activePlan.product);
  if (!reagents) {
    replaceCarrierTasksForProducerRoom(SYNTHESIS_CARRIER_TASK_PRODUCER, roomName, []);
    runtime.rooms[roomName] = {
      ...roomState,
      stage: "blocked",
      activeProduct: activePlan.product,
      targetAmount: activePlan.targetAmount,
      batchSize: activePlan.batchSize,
      cleanupTasks: undefined,
      lastError: "invalid_reaction_product",
      nextReactionAt: undefined,
      pendingTasks: countPendingToRoom(roomName, transferTasks),
      reagentLabIds: topology.reagentLabs.map((lab) => lab.id),
      productLabIds: topology.productLabs.map((lab) => lab.id),
      lastTransitionAt: Game.time,
    };
    return { generated, failed, runs };
  }

  const planChanged =
    roomState.activeProduct !== activePlan.product ||
    roomState.batchSize !== activePlan.batchSize ||
    roomState.targetAmount !== activePlan.targetAmount;
  let stage = roomState.stage;
  let nextReactionAt = planChanged ? undefined : roomState.nextReactionAt;
  if (planChanged) {
    stage = "acquiring";
    roomState.lastTransitionAt = Game.time;
  }

  if (stage === "idle" || stage === "blocked") {
    stage = "acquiring";
    nextReactionAt = undefined;
    roomState.lastTransitionAt = Game.time;
  }

  if (stage === "acquiring" || stage === "loading") {
    nextReactionAt = undefined;
    markLoadingStart(roomState, Game.time);
  }

  const orderedReagentLabs = orderReagentLabs(topology.reagentLabs, reagents);
  const hasContamination =
    isLabContaminatedForExpected(orderedReagentLabs[0], reagents[0]) ||
    isLabContaminatedForExpected(orderedReagentLabs[1], reagents[1]) ||
    topology.productLabs.some((lab) => isLabContaminatedForExpected(lab, activePlan.product));
  const cleanupTask = hasContamination
    ? generateCleanupTask(room, orderedReagentLabs, topology.productLabs, reagents, activePlan.product)
    : null;
  const supplyTask = hasContamination
    ? null
    : generateSupplyTask(room, orderedReagentLabs, reagents, activePlan.batchSize, activePlan.product, activePlan.targetAmount);
  // Generate product unload unless acquiring/loading (suppressed to avoid disrupting reagent supply).
  // During synthesizing, only unload when lab amount exceeds 700 to avoid interrupting active reactions.
  const productUnloadTask = !hasContamination && stage !== "acquiring" && stage !== "loading"
    ? generateProductUnloadTask(room, topology.productLabs, activePlan.product, activePlan.targetAmount, stage === "synthesizing" ? 701 : 1)
    : null;
  const prevProductUnloadTask = roomState.activeProduct && roomState.activeProduct !== activePlan.product && roomState.targetAmount
    ? generateProductUnloadTask(room, topology.productLabs, roomState.activeProduct as ResourceConstant, roomState.targetAmount as number, 1)
    : null;
  const boardTasks = hasContamination
    ? [...(cleanupTask ? [cleanupTask] : []), ...(prevProductUnloadTask ? [prevProductUnloadTask] : [])]
    : [...(supplyTask ? [supplyTask] : []), ...(productUnloadTask ? [productUnloadTask] : []), ...(prevProductUnloadTask ? [prevProductUnloadTask] : [])];
  replaceCarrierTasksForProducerRoom(SYNTHESIS_CARRIER_TASK_PRODUCER, roomName, boardTasks);
  const cleanupTaskView = (cleanupTask?.steps || []).map((step) => ({
    labId: step.fromId,
    resource: step.resource,
    amount: step.amount,
    target: (step.toKind === "terminal" ? "terminal" : "storage") as "terminal" | "storage",
  }));

  if (hasContamination && stage !== "unloading") {
    stage = "unloading";
    roomState.lastTransitionAt = Game.time;
  }

  const LOADING_TIMEOUT = 500;
  if ((stage === "loading" || stage === "acquiring") && isLoadingTimedOut(roomState.loadingSinceTick, Game.time, LOADING_TIMEOUT)) {
    const abortedProduct = roomState.activeProduct || activePlan.product;
    runtime.rooms[roomName] = {
      ...roomState,
      stage: "idle",
      activeProduct: undefined,
      loadingSinceTick: undefined,
      nextReactionAt: undefined,
      lastTransitionAt: Game.time,
      lastError: undefined,
    };
    actions.push(`loading-timeout:abort:${abortedProduct}`);
    signalHubNeedsPlan(roomName);
    return { generated, failed, runs };
  }

  if (planningTick && (stage === "acquiring" || stage === "loading")) {
    const taskResult = maybeGenerateSupplyTasks(
      room,
      roomCfg,
      activePlan,
      reagents,
      topology,
      transferTasks,
      runtime,
      actions,
      shadowBatch,
    );
    generated += taskResult.generated;
    failed += taskResult.failed;
    roomState.missing = taskResult.missing;
  }

  const reagentReady =
    isReagentReady(orderedReagentLabs[0], reagents[0]) &&
    isReagentReady(orderedReagentLabs[1], reagents[1]);
  const productLabAvailable = topology.productLabs.some((lab) => canAcceptProduct(lab, activePlan.product));

  if (stage === "acquiring" && reagentReady && productLabAvailable && !hasContamination) {
    stage = "synthesizing";
    roomState.lastTransitionAt = Game.time;
    roomState.loadingSinceTick = undefined;
  } else if (stage === "loading" && reagentReady && productLabAvailable && !hasContamination) {
    stage = "synthesizing";
    roomState.lastTransitionAt = Game.time;
    roomState.loadingSinceTick = undefined;
  } else if (stage === "synthesizing" && hasContamination) {
    stage = "unloading";
    nextReactionAt = undefined;
    roomState.lastTransitionAt = Game.time;
  } else if (stage === "unloading" && !hasContamination) {
    stage = "loading";
    nextReactionAt = undefined;
    roomState.lastTransitionAt = Game.time;
    markLoadingStart(roomState, Game.time);
  }

  const reactionDue = nextReactionAt === undefined || Game.time >= nextReactionAt;
  if (stage === "synthesizing" && reactionDue) {
    let roomRuns = 0;
    const remainingCooldown = topology.productLabs.reduce(
      (maximum, lab) => Math.max(maximum, lab.cooldown),
      0,
    );

    if (remainingCooldown > 0) {
      nextReactionAt = Game.time + remainingCooldown;
    } else {
      for (const lab of topology.productLabs) {
        if (!canAcceptProduct(lab, activePlan.product)) {
          continue;
        }

        const code = lab.runReaction(orderedReagentLabs[0], orderedReagentLabs[1]);
        if (code === OK) {
          recordFixedCpuAction("synthesisControl");
          roomRuns += 1;
        } else if (code === ERR_NOT_ENOUGH_RESOURCES || code === ERR_INVALID_ARGS) {
          stage = hasContamination ? "unloading" : "loading";
        }
      }
    }

    if (roomRuns > 0) {
      runs += roomRuns;
      actions.push(`synthesis-runs:${room.name}:${activePlan.product}:count=${roomRuns}`);
      if (stage === "synthesizing") {
        nextReactionAt = Game.time + getReactionInterval(activePlan.product);
      }
    }
  }

  const productCurrent = roomResourceAmount(room, activePlan.product);
  if (isTargetSatisfiedByReactionGranularity(productCurrent, activePlan.targetAmount) && !hasContamination) {
    stage = "idle";
    nextReactionAt = undefined;
    roomState.lastTransitionAt = Game.time;
    roomState.loadingSinceTick = undefined;

    signalHubNeedsPlan(room.name);
  } else if (!reagentReady && !hasContamination) {
    stage = "loading";
    nextReactionAt = undefined;
    markLoadingStart(roomState, Game.time);
  }

  runtime.rooms[roomName] = {
    ...roomState,
    stage,
    activeProduct: activePlan.product,
    reagentA: reagents[0],
    reagentB: reagents[1],
    targetAmount: activePlan.targetAmount,
    batchSize: activePlan.batchSize,
    pendingTasks: countPendingToRoom(roomName, transferTasks),
    reagentLabIds: orderedReagentLabs.map((lab) => lab.id),
    productLabIds: topology.productLabs.map((lab) => lab.id),
    successfulRuns: (roomState.successfulRuns || 0) + runs,
    nextReactionAt: stage === "synthesizing" ? nextReactionAt : undefined,
    lastError: stage === "unloading" ? "lab_contaminated_waiting_clear" : undefined,
    missing: stage === "acquiring" || stage === "loading" ? roomState.missing : undefined,
    cleanupTasks: stage === "unloading" ? cleanupTaskView : undefined,
  };

  return { generated, failed, runs };
}

export function isSynthesisPaused(roomName: string): boolean {
  const runtime = getRuntimeState();
  const roomState = runtime.rooms[roomName];
  return !!roomState?.boostPause;
}

export function pauseSynthesisForBoost(roomName: string, taskId: string): boolean {
  const runtime = getRuntimeState();
  if (!Game.rooms[roomName]) {
    return false;
  }
  const roomState = runtime.rooms[roomName] || createRoomState("idle", Game.time);
  runtime.rooms[roomName] = roomState;

  if (roomState.boostPause) {
    const taskIds = roomState.boostPause.taskIds || [roomState.boostPause.taskId];
    if (!taskIds.includes(taskId)) taskIds.push(taskId);
    roomState.boostPause.taskIds = taskIds;
    return true;
  }

  const pausedPlan: SynthesisReactionPlan | null = roomState.activeProduct
    ? {
        product: roomState.activeProduct,
        targetAmount: roomState.targetAmount ?? 0,
        batchSize: roomState.batchSize ?? DEFAULT_BATCH_SIZE,
        donorRoomNames: [],
      }
    : null;

  roomState.boostPause = {
    reason: "powerBankBoost",
    taskId,
    taskIds: [taskId],
    createdTick: Game.time,
    pausedPlan,
    pausedStage: roomState.stage,
  };

  // Clear active production — this triggers reagent cleanup on next tick
  roomState.stage = "idle";
  roomState.activeProduct = undefined;
  roomState.reagentA = undefined;
  roomState.reagentB = undefined;
  roomState.targetAmount = undefined;
  roomState.batchSize = undefined;
  roomState.loadingSinceTick = undefined;
  roomState.nextReactionAt = undefined;
  roomState.lastTransitionAt = Game.time;

  return true;
}

export function resumeSynthesisAfterBoost(roomName: string, taskId?: string): void {
  const runtime = getRuntimeState();
  const roomState = runtime.rooms[roomName];
  if (!roomState?.boostPause) {
    return;
  }

  const pause = roomState.boostPause;
  if (taskId) {
    const remainingTaskIds = (pause.taskIds || [pause.taskId]).filter((id) => id !== taskId);
    if (remainingTaskIds.length > 0) {
      pause.taskId = remainingTaskIds[0];
      pause.taskIds = remainingTaskIds;
      return;
    }
  }

  if (pause.pausedPlan) {
    roomState.activeProduct = pause.pausedPlan.product;
    roomState.targetAmount = pause.pausedPlan.targetAmount;
    roomState.batchSize = pause.pausedPlan.batchSize;
    const reagents = getProductReagents(pause.pausedPlan.product);
    if (reagents) {
      roomState.reagentA = reagents[0];
      roomState.reagentB = reagents[1];
    }
  }

  roomState.stage = pause.pausedStage === "idle" ? "acquiring" : pause.pausedStage;
  roomState.lastTransitionAt = Game.time;
  roomState.loadingSinceTick = Game.time;
  roomState.nextReactionAt = undefined;

  delete roomState.boostPause;
}

export function clearBoostPause(roomName: string): void {
  const runtime = getRuntimeState();
  const roomState = runtime.rooms[roomName];
  if (!roomState) {
    return;
  }
  delete roomState.boostPause;
}

export function runSynthesisControl(): void {
  const runtime = getRuntimeState();
  // Clear stale hub lastError from previous ticks; the destination-full paths
  // below will re-set it within this tick if the storage/terminal is still full.
  if (Memory.runtime?.hub) {
    delete Memory.runtime.hub.lastError;
  }
  const cfg = normalizeConfig();
  const logisticsCfg = resolveLogisticsControlConfig();
  const actions: string[] = [];
  const planningTick = Game.time % cfg.sampleInterval === 0;
  const shadowEnabled = cfg.enabled
    && Memory.cfg?.resourceControl?.enabled !== false
    && logisticsCfg.valid
    && logisticsCfg.mode === "shadow";
  const resourceControlPlanningTick = isResourceControlFullPlanningTick();

  if (planningTick && !shadowEnabled) {
    withdrawSynthesisLogisticsShadow();
  }

  if (!cfg.enabled) {
    pruneCarrierTasksForProducer(SYNTHESIS_CARRIER_TASK_PRODUCER, new Set());
    const compatibilityActions = runSynthesisTaskPlanningCompatibility();
    if (!compatibilityActions) {
      return;
    }

    runtime.updatedAt = Game.time;
    runtime.generatedTaskCount = compatibilityActions.filter((action) => action.startsWith("task-generated:")).length;
    runtime.failedTaskCount = compatibilityActions.filter((action) => action.startsWith("task-generate-failed:")).length;
    runtime.successfulRunCount = 0;
    runtime.lastActions = limitActionLog(compatibilityActions);
    return;
  }

  const shadowBatch: SynthesisLogisticsShadowBatch | undefined =
    planningTick && shadowEnabled && resourceControlPlanningTick
      ? measureLogisticsShadowCpu("producer", () => {
          const captureResources = [...new Set(
            Object.values(cfg.rooms)
              .filter((room) => room.enabled)
              .flatMap((room) => room.reactions)
              .flatMap((reaction) => getProductReagents(reaction.product) ?? []),
          )].sort();
          const epochCapture = beginSynthesisShadowEpochCapture(captureResources);
          return epochCapture.ok
            ? {
                ttl: resolveSynthesisLogisticsTtl(cfg.sampleInterval),
                epochCapture,
                demands: [],
                observations: [],
                totalCount: 0,
                overflowCount: 0,
              }
            : undefined;
        })
      : undefined;
  const roomEntries = new Map(Object.entries(cfg.rooms));
  const transferTasks = createSynthesisTransferTaskIndex(
    !!shadowBatch,
    shadowBatch?.epochCapture.tasks,
  );
  const configuredRoomNames = new Set(roomEntries.keys());
  runtime.generatedTaskCount = 0;
  runtime.failedTaskCount = 0;
  runtime.successfulRunCount = 0;

  for (const [roomName, roomCfg] of roomEntries.entries()) {
    const result = handleRoom(
      roomName,
      roomCfg,
      planningTick,
      runtime,
      actions,
      transferTasks,
      null,
      shadowBatch,
    );
    runtime.generatedTaskCount += result.generated;
    runtime.failedTaskCount += result.failed;
    runtime.successfulRunCount += result.runs;
  }
  pruneCarrierTasksForProducer(SYNTHESIS_CARRIER_TASK_PRODUCER, configuredRoomNames);

  runtime.updatedAt = Game.time;
  runtime.lastActions = limitActionLog(actions);
  if (shadowBatch) {
    measureLogisticsShadowCpu("producer", () => {
      const factBuild = shadowBatch.epochCapture.buildRoomFacts(
        [...new Set(shadowBatch.demands.map((demand) => demand.resource))].sort(),
      );
      if (factBuild.ok) {
        replaceLatestLogisticsDemandsForProducer(
          SYNTHESIS_ROOM_LOGISTICS_PRODUCER,
          shadowBatch.demands,
          shadowBatch.observations,
          {
            totalCount: shadowBatch.totalCount,
            overflowCount: shadowBatch.overflowCount,
            ttl: Math.max(shadowBatch.ttl, factBuild.expiresAt - factBuild.observedAt),
            epochRevision: factBuild.epochRevision,
            epochFingerprint: factBuild.epochFingerprint,
            captureCpuUsed: factBuild.captureCpuUsed,
            indexBuildCount: factBuild.indexBuildCount,
            roomFacts: factBuild.roomFacts.map(({
              revision: _revision,
              observedAt,
              expiresAt,
              ...fact
            }) => ({
              ...fact,
              ttl: Math.max(1, expiresAt - observedAt),
            })),
          },
        );
      }
    });
  }
}
