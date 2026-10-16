/** 从 resourceControl.ts 分离的独立职责模块；共享状态仅由此处持有。 */
import { terminalFeedBoundTaskIdentity } from "@/runtime/terminalFeedTarget";
import {
  inspectAutomaticSynthesisTransferDemand,
  resolveSynthesisStagingFeedCapacity,
} from "@/runtime/synthesisTransferDemand";
import {
  listCarrierDispatchEntriesByRoom,
  pruneCarrierTasksForProducer,
  replaceCarrierTasksForProducerRoom,
  type CarrierTaskDispatchClass,
  type CarrierTaskDraft,
} from "@/runtime/carrierTaskBoard";
import { encodeCarrierDispatchStepKey } from "@/runtime/dispatchOwnership/ref";
import { type ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { getReceiverSafeCapacity } from "@/runtime/logistics/capacityHeadroom";
import { listProductionReservations } from "@/runtime/resourceReservation";
import { getTerminalAmountOutsideMarketSaleExposure } from "@/runtime/marketSaleExposure";
import { isMarketBaseResource, MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE } from "@/runtime/marketBaseResourcePolicy";
import { resolveMarketSaleAutomationConfig } from "@/runtime/marketSaleConfig";
import {
  getMarketProtectionEntryKey,
  getMarketProtectionSellableAmount,
  isMarketProtectionEntryFresh,
} from "@/runtime/marketSaleProtection";
import { collectLiveMarketSaleProtectionLedger } from "@/runtime/marketSaleProtectionAdapter";
import { getLocalCarrierDestinationCommittedAmount } from "@/runtime/localCarrierDestinationCapacity";
import { getTerminalActionRequiredEnergy } from "@/runtime/terminalActionEnergyOwnership";
import {
  isPlainRecord,
  createTerminalStagingObservation,
  roomResourceKey,
  getStock,
  getProductionCommitmentAmount,
  getHealthyOutgoingCommitment,
  getOutgoingTransactionFeeReserve,
  getTerminalResourceAmount,
  getStorageResourceAmount,
  getTerminalActionEnergyBudget,
  getProtectedResourceAmount,
  getTotalMovableResourceAmount,
  TERMINAL_STORAGE_CAPACITY,
  RESOURCE_CONTROL_TERMINAL_FEED_PRODUCER,
  TERMINAL_TOTAL_STORAGE_CAP,
  getTerminalLogisticsCapacityPlan,
} from "@/runtime/resourceControlReadModel";
import type {
  TerminalStagingSuppressionReason,
  ResourceControlSnapshot,
  ResourceControlTransferContext,
  TerminalStagingObservation,
  MarketTerminalEnergyReadinessContribution,
  MarketTerminalEnergyReadinessObservation,
  MarketTerminalEnergyReadinessBlocker,
  ResourceCapacityConfig,
  ResourceCapacityState,
  ResourceControlCommitmentReadContext,
  TerminalStickyHeadroomReason,
} from "@/runtime/resourceControlReadModel";
import type { ResourceControlMarketConfig } from "@/runtime/resourceMarketOperations";


interface TerminalStagingBatch {
  resource: ResourceConstant;
  amount: number;
  transactionFee: number;
  dispatchClass?: CarrierTaskDispatchClass;
  productionDemandBounded?: boolean;
  productionResourceTransferTaskId?: string;
}

interface TerminalEnergyPlanOptions {
  stagingBatch?: TerminalStagingBatch;
  legacyBacklog?: boolean;
}

export interface MarketTerminalEnergyAuthorizedRoom {
  roomName: string;
  roomInstanceId: string;
  terminalId: string;
}

export interface MarketTerminalEnergyAuthorizationRead {
  ok: boolean;
  reason?: "missing" | "invalid" | "expired" | "market_mode_not_direct";
  revision?: string;
  maxTransactionEnergy?: number;
  rooms: MarketTerminalEnergyAuthorizedRoom[];
  cargoLanes?: Array<{
    roomName: string;
    resource: ResourceConstant;
    terminalId: string;
    maxDealAmount: number;
  }>;
}

interface TerminalStagingAttempt {
  batch?: TerminalStagingBatch;
  suppressedReason?: TerminalStagingSuppressionReason;
}
const RESOURCE_CONTROL_TERMINAL_FEED_PRIORITY = 80;
const RESOURCE_CONTROL_TERMINAL_OFFLOAD_PRIORITY = 90;
const MARKET_TERMINAL_ENERGY_SCHEMA_VERSION = 3;
const MARKET_TERMINAL_ENERGY_MAX_TRANSACTION_ENERGY = 1_000;
const MARKET_TERMINAL_ENERGY_BASE_RESERVE = 25_000;
const MARKET_TERMINAL_ENERGY_MIN_FREE_CAPACITY = 40_000;
const MARKET_TERMINAL_ENERGY_EVIDENCE_TTL = 1;
const MARKET_TERMINAL_ENERGY_MAX_CONTRIBUTIONS = 64;

function isEnergyExportEligible(snapshot: ResourceControlSnapshot): boolean {
  return snapshot.storageEnergy >= snapshot.energyExportStart;
}

function getTerminalStagingObservation(
  context: ResourceControlTransferContext,
  roomName: string,
): TerminalStagingObservation {
  const existing = context.stagingObservationByRoom.get(roomName);
  if (existing) return existing;
  const observation = createTerminalStagingObservation();
  context.stagingObservationByRoom.set(roomName, observation);
  return observation;
}

function recordTerminalStagingAdmission(
  context: ResourceControlTransferContext,
  roomName: string,
  batch: TerminalStagingBatch,
  taskBacked = true,
): void {
  const observation = getTerminalStagingObservation(context, roomName);
  observation.admittedAmount += batch.amount;
  if (taskBacked) {
    observation.admittedTaskCount += 1;
  }
  observation.admittedByResource[batch.resource] =
    (observation.admittedByResource[batch.resource] || 0) + batch.amount;
}

function recordTerminalStagingSuppression(
  context: ResourceControlTransferContext,
  roomName: string,
  reason: TerminalStagingSuppressionReason,
): void {
  const observation = getTerminalStagingObservation(context, roomName);
  observation.suppressedCount += 1;
  observation.suppressedByReason[reason] =
    (observation.suppressedByReason[reason] || 0) + 1;
}

function addMarketEnergyContribution(
  contributions: Map<string, MarketTerminalEnergyReadinessContribution>,
  contribution: MarketTerminalEnergyReadinessContribution,
): void {
  if (contribution.amount <= 0 || !Number.isSafeInteger(contribution.amount)) {
    return;
  }
  const existing = contributions.get(contribution.id);
  if (!existing) {
    contributions.set(contribution.id, contribution);
    return;
  }

  // 同 stable ID 只能算一次。重复观测取更保守的较大值，而不是相加。
  contributions.set(contribution.id, {
    ...existing,
    amount: Math.max(existing.amount, contribution.amount),
  });
}

function collectMarketTerminalEnergyContributions(
  snapshot: ResourceControlSnapshot,
  context: ResourceControlTransferContext,
): {
  contributions: MarketTerminalEnergyReadinessContribution[];
  ordinaryTerminalEnergyTarget: number;
  unresolvedEnergySendAmount: number;
  unresolvedInternalSendFees: number;
  terminalScopedProductionEnergyCommitments: number;
  bounded: boolean;
} {
  const byId = new Map<string, MarketTerminalEnergyReadinessContribution>();
  let carrierIdentityComplete = true;
  addMarketEnergyContribution(byId, {
    id: `ordinary-terminal-target:${snapshot.roomName}`,
    amount: Math.max(0, Math.floor(snapshot.terminalEnergyReserve)),
    kind: "ordinary_terminal_target",
  });

  for (const task of context.tasks) {
    const contribution = context.taskContributionById.get(task.id);
    if (!contribution) continue;
    if (
      contribution.outgoingKey ===
        roomResourceKey(snapshot.roomName, RESOURCE_ENERGY) &&
      contribution.outgoingAmount
    ) {
      addMarketEnergyContribution(byId, {
        id: `resource-transfer:${task.id}:energy`,
        amount: Math.floor(contribution.outgoingAmount),
        kind: "pending_energy_send",
      });
    }
    if (
      contribution.outgoingFeeRoomName === snapshot.roomName &&
      contribution.outgoingFee
    ) {
      addMarketEnergyContribution(byId, {
        id: `resource-transfer:${task.id}:fee`,
        amount: Math.floor(contribution.outgoingFee),
        kind: "pending_internal_send_fee",
      });
    }
  }

  for (const reservation of listProductionReservations()) {
    if (
      reservation.roomName !== snapshot.roomName ||
      reservation.resource !== RESOURCE_ENERGY ||
      reservation.expiresAt < Game.time
    ) {
      continue;
    }
    addMarketEnergyContribution(byId, {
      id: `production-reservation:${reservation.holderId}`,
      amount: Math.floor(reservation.amount),
      kind: "terminal_production_commitment",
    });
  }

  for (const { ref: taskRef, task } of listCarrierDispatchEntriesByRoom(
    snapshot.roomName,
  )) {
    if (task.type !== "lab_supply" && task.type !== "factory_supply") {
      continue;
    }
    if (
      taskRef.namespace !== task.producer ||
      taskRef.scope.roomName !== snapshot.roomName ||
      taskRef.scope.roomName !== task.roomName ||
      taskRef.localId !== task.id
    ) {
      carrierIdentityComplete = false;
      continue;
    }
    for (const step of task.steps) {
      if (step.resource !== RESOURCE_ENERGY || step.fromKind !== "terminal") {
        continue;
      }
      let contributionId: string;
      try {
        contributionId = encodeCarrierDispatchStepKey(taskRef, step.id);
      } catch {
        carrierIdentityComplete = false;
        continue;
      }
      addMarketEnergyContribution(byId, {
        id: contributionId,
        amount: Math.floor(step.amount),
        kind: "terminal_production_commitment",
      });
    }
  }

  const contributions = [...byId.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const sumKind = (
    kind: MarketTerminalEnergyReadinessContribution["kind"],
  ): number =>
    contributions.reduce(
      (sum, contribution) =>
        contribution.kind === kind ? sum + contribution.amount : sum,
      0,
    );
  return {
    contributions: contributions.slice(
      0,
      MARKET_TERMINAL_ENERGY_MAX_CONTRIBUTIONS,
    ),
    ordinaryTerminalEnergyTarget: sumKind("ordinary_terminal_target"),
    unresolvedEnergySendAmount: sumKind("pending_energy_send"),
    unresolvedInternalSendFees: sumKind("pending_internal_send_fee"),
    terminalScopedProductionEnergyCommitments: sumKind(
      "terminal_production_commitment",
    ),
    bounded:
      carrierIdentityComplete &&
      contributions.length <= MARKET_TERMINAL_ENERGY_MAX_CONTRIBUTIONS,
  };
}

function createMarketTerminalEnergyReadinessObservation(
  snapshot: ResourceControlSnapshot,
  context: ResourceControlTransferContext,
  authorization: MarketTerminalEnergyAuthorizationRead,
): MarketTerminalEnergyReadinessObservation {
  const contributions = collectMarketTerminalEnergyContributions(
    snapshot,
    context,
  );
  const productionAndTransferReserve =
    contributions.ordinaryTerminalEnergyTarget +
    contributions.unresolvedEnergySendAmount +
    contributions.unresolvedInternalSendFees +
    contributions.terminalScopedProductionEnergyCommitments;
  const effectivePostDealEnergyReserve = Math.max(
    MARKET_TERMINAL_ENERGY_BASE_RESERVE,
    productionAndTransferReserve,
  );
  const maxTransactionEnergy =
    authorization.maxTransactionEnergy ??
    MARKET_TERMINAL_ENERGY_MAX_TRANSACTION_ENERGY;
  const authorizedRoom = authorization.ok
    ? authorization.rooms.find((room) => room.roomName === snapshot.roomName)
    : undefined;
  const terminalMatches =
    !!authorizedRoom && authorizedRoom.terminalId === snapshot.terminal.id;
  const blocker: MarketTerminalEnergyReadinessBlocker | undefined =
    !authorization.ok
      ? authorization.reason === "expired"
        ? "authorization_expired"
        : authorization.reason === "missing" ||
            authorization.reason === "market_mode_not_direct"
          ? "not_authorized"
          : "authorization_invalid"
      : !authorizedRoom
        ? "not_authorized"
        : !terminalMatches
          ? "terminal_changed"
          : !contributions.bounded
            ? "draft_invalid"
            : undefined;

  return {
    schemaVersion: MARKET_TERMINAL_ENERGY_SCHEMA_VERSION,
    revision: `market-terminal-energy-v3:${Game.time}`,
    observedAt: Game.time,
    expiresAt: Game.time + MARKET_TERMINAL_ENERGY_EVIDENCE_TTL,
    ...(authorization.revision
      ? { authorizationRevision: authorization.revision }
      : {}),
    ...(authorizedRoom
      ? { roomInstanceId: authorizedRoom.roomInstanceId }
      : {}),
    terminalId: snapshot.terminal.id,
    authorized: !blocker,
    effectivePostDealEnergyReserve,
    marketTerminalEnergyTarget:
      effectivePostDealEnergyReserve + maxTransactionEnergy,
    ordinaryTerminalEnergyTarget: contributions.ordinaryTerminalEnergyTarget,
    unresolvedEnergySendAmount: contributions.unresolvedEnergySendAmount,
    unresolvedInternalSendFees: contributions.unresolvedInternalSendFees,
    terminalScopedProductionEnergyCommitments:
      contributions.terminalScopedProductionEnergyCommitments,
    maxTransactionEnergy,
    contributionCount: contributions.contributions.length,
    contributions: contributions.contributions,
    desiredTerminalEnergy: contributions.ordinaryTerminalEnergyTarget,
    plannedFeedAmount: 0,
    status: blocker ? "blocked" : "ready",
    ...(blocker ? { blocker } : {}),
  };
}

export function getEnergyBalancingSurplus(
  snapshot: ResourceControlSnapshot,
  context: ResourceControlTransferContext,
  excludeTaskId?: string,
): number {
  if (!isEnergyExportEligible(snapshot)) {
    return 0;
  }
  return getProtectedEnergySurplus(snapshot, context, excludeTaskId);
}

function getProtectedEnergySurplus(
  snapshot: ResourceControlSnapshot,
  context: ResourceControlTransferContext,
  excludeTaskId?: string,
): number {
  return Math.max(
    0,
    getStock(snapshot, RESOURCE_ENERGY) -
      snapshot.energyTarget -
      getProductionCommitmentAmount(
        snapshot.roomName,
        RESOURCE_ENERGY,
        context,
      ) -
      getHealthyOutgoingCommitment(
        snapshot.roomName,
        RESOURCE_ENERGY,
        context,
        excludeTaskId,
      ) -
      getOutgoingTransactionFeeReserve(snapshot, context, excludeTaskId),
  );
}

export function computeLargestAffordableAmount(
  maximum: number,
  canAfford: (amount: number) => boolean,
): number {
  let low = 1;
  let high = Math.max(0, Math.floor(maximum));
  let result = 0;

  while (low <= high) {
    const candidate = Math.floor((low + high) / 2);
    if (canAfford(candidate)) {
      result = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }

  return result;
}

export function isStorageConstrained(
  snapshot: ResourceControlSnapshot | undefined,
  capacityConfig: ResourceCapacityConfig,
): boolean {
  return (
    (snapshot?.storage?.store.getFreeCapacity() ?? 0) <=
    capacityConfig.storagePressureFreeCapacity
  );
}

function getTransferTaskPriority(
  task: ResourceTransferTask,
  energyDeficitRooms: Set<string>,
  storageConstrainedRooms: Set<string>,
  capacityStateByRoom: Map<string, ResourceCapacityState>,
): number {
  if (
    task.resource === RESOURCE_ENERGY &&
    energyDeficitRooms.has(task.toRoomName)
  )
    return 0;
  const reason = task.reason;
  if (task.origin === "manual" && (!reason || reason.startsWith("manual:")))
    return 1;
  if (!reason) return 3;
  if (reason.startsWith("capacity:relief:")) {
    return capacityStateByRoom.get(task.fromRoomName) === "emergency" ? 1 : 3;
  }
  if (
    reason.startsWith("synthesis:") ||
    reason.startsWith("auto:synthesis:") ||
    reason.startsWith("powerBankBoost")
  )
    return 2;
  if (
    reason.startsWith("hub:export:") &&
    storageConstrainedRooms.has(task.fromRoomName)
  )
    return 4;
  if (reason.startsWith("hub:import:")) return 5;
  if (reason.startsWith("hub:reclaim:")) return 6;
  if (reason.startsWith("hub:export:")) return 7;
  return 3;
}

interface TransferTaskPriorityContext {
  energyDeficitRooms: Set<string>;
  storageConstrainedRooms: Set<string>;
  capacityStateByRoom: Map<string, ResourceCapacityState>;
}

function createTransferTaskPriorityContext(
  snapshots: ResourceControlSnapshot[],
  capacityConfig: ResourceCapacityConfig,
  remainingEnergyNeedByRoom: Map<string, number>,
): TransferTaskPriorityContext {
  return {
    energyDeficitRooms: new Set(
      snapshots
        .filter(
          (snapshot) =>
            (remainingEnergyNeedByRoom.get(snapshot.roomName) || 0) > 0,
        )
        .map((snapshot) => snapshot.roomName),
    ),
    storageConstrainedRooms: new Set(
      snapshots
        .filter((snapshot) => isStorageConstrained(snapshot, capacityConfig))
        .map((snapshot) => snapshot.roomName),
    ),
    capacityStateByRoom: new Map(
      snapshots.map(
        (snapshot) => [snapshot.roomName, snapshot.capacityState] as const,
      ),
    ),
  };
}

export function sortTransferTasksByPriority(
  tasks: ResourceTransferTask[],
  priorityContext: TransferTaskPriorityContext,
): ResourceTransferTask[] {
  return [...tasks].sort((a, b) => {
    const pa = getTransferTaskPriority(
      a,
      priorityContext.energyDeficitRooms,
      priorityContext.storageConstrainedRooms,
      priorityContext.capacityStateByRoom,
    );
    const pb = getTransferTaskPriority(
      b,
      priorityContext.energyDeficitRooms,
      priorityContext.storageConstrainedRooms,
      priorityContext.capacityStateByRoom,
    );
    if (pa !== pb) return pa - pb;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id.localeCompare(b.id);
  });
}

export function getMovableResourceAmount(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
  location: "storage" | "terminal",
  config: ResourceCapacityConfig,
  context: ResourceControlCommitmentReadContext,
  excludeTaskId?: string,
): number {
  if (resource === RESOURCE_ENERGY) {
    const structureStock =
      location === "terminal"
        ? getTerminalResourceAmount(snapshot, resource)
        : getStorageResourceAmount(snapshot, resource);
    return Math.min(
      structureStock,
      getTerminalActionEnergyBudget(snapshot, context, excludeTaskId),
    );
  }
  const totalStock = getStock(snapshot, resource);
  const movableTotal = Math.max(
    0,
    totalStock -
      getProtectedResourceAmount(
        snapshot,
        resource,
        config,
        context,
        excludeTaskId,
      ) -
      getHealthyOutgoingCommitment(
        snapshot.roomName,
        resource,
        context,
        excludeTaskId,
      ),
  );
  const structureStock =
    location === "terminal"
      ? getTerminalResourceAmount(snapshot, resource)
      : getStorageResourceAmount(snapshot, resource);
  return Math.min(structureStock, movableTotal);
}

export function getCapacityReliefRecoveryGap(
  source: ResourceControlSnapshot,
  config: ResourceCapacityConfig,
): number {
  if (source.terminalFreeCapacity < config.terminalReliefTargetFreeCapacity) {
    return (
      config.terminalReliefTargetFreeCapacity - source.terminalFreeCapacity
    );
  }
  return Math.max(
    0,
    config.storageReliefTargetFreeCapacity - source.storageFreeCapacity,
  );
}

export function computeSafeCapacityReliefAmount(
  source: ResourceControlSnapshot,
  receiverRoomName: string,
  resource: ResourceConstant,
  requestedAmount: number,
  config: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
  excludeTaskId?: string,
): number {
  const resourceMovable = getTotalMovableResourceAmount(
    source,
    resource,
    config,
    context,
    excludeTaskId,
  );
  const candidate = Math.floor(Math.min(requestedAmount, resourceMovable));
  if (resource !== RESOURCE_ENERGY) {
    return candidate;
  }

  const energyBudget = getTotalMovableResourceAmount(
    source,
    RESOURCE_ENERGY,
    config,
    context,
    excludeTaskId,
  );
  return computeLargestAffordableAmount(candidate, (amount) => {
    const fee = Game.market.calcTransactionCost(
      amount,
      source.roomName,
      receiverRoomName,
    );
    return amount + fee <= energyBudget;
  });
}

export function getCapacityReliefReceivableAmount(
  receiver: ResourceControlSnapshot,
  config: ResourceCapacityConfig,
): number {
  return getReceiverSafeCapacity(
    receiver.storageFreeCapacity,
    receiver.terminalFreeCapacity,
    config,
  );
}

export function getCapacityReliefLedgerAvailableAmount(
  receiver: ResourceControlSnapshot,
  resource: ResourceConstant,
  context: ResourceControlTransferContext,
  excludeTaskId?: string,
): number {
  return context.receiverCapacityLedger.getAvailableAmount(
    receiver.roomName,
    resource,
    excludeTaskId,
  );
}

export function isWarBoostShipment(task: ResourceTransferTask): boolean {
  const reason = task.reason || "";
  return (
    reason.startsWith("powerBankBoost:war:") || reason.startsWith("war boost ")
  );
}

export function inspectTaskSynthesisDemand(
  task: ResourceTransferTask,
  context: ResourceControlTransferContext,
) {
  const receiver = context.snapshotByRoom.get(task.toRoomName);
  // send 是 tick 末生效的 intent；从 task 扣除后，已发送切片仍须覆盖本 tick 的需求。
  const liveTerminalAmount = Game.rooms[task.toRoomName]?.terminal?.store.getUsedCapacity(task.resource) || 0;
  const projectedIncoming = receiver
    ? Math.max(0, getTerminalResourceAmount(receiver, task.resource) - liveTerminalAmount)
    : 0;
  return inspectAutomaticSynthesisTransferDemand(task, projectedIncoming);
}

function createTerminalFeedTask(
  room: ResourceControlSnapshot,
  resource: ResourceConstant,
  targetStock: number,
): CarrierTaskDraft | null {
  if (!room.storage || targetStock <= 0) {
    return null;
  }

  const terminalAmount = getTerminalResourceAmount(room, resource);
  const storageAmount = room.storage.store.getUsedCapacity(resource);
  const terminalFree = Math.min(
    room.terminalFreeCapacity,
    room.terminal.store.getFreeCapacity(resource),
  );
  const missing = Math.min(
    storageAmount,
    terminalFree,
    Math.max(0, targetStock - terminalAmount),
  );
  if (missing <= 0) {
    return null;
  }

  return {
    id: `resourceControl:terminal_feed:${room.roomName}:${resource}`,
    type: "terminal_feed",
    priority: RESOURCE_CONTROL_TERMINAL_FEED_PRIORITY,
    steps: [
      {
        id: `${resource}:${room.storage.id}->${room.terminal.id}`,
        resource,
        fromKind: "storage",
        toKind: "terminal",
        fromId: room.storage.id,
        toId: room.terminal.id,
        amount: missing,
        destinationTargetAmount: terminalAmount + missing,
      },
    ],
  };
}

function createTerminalOffloadTask(
  room: ResourceControlSnapshot,
  resource: ResourceConstant,
  amount: number,
  availableAmount = getTerminalResourceAmount(room, resource),
): CarrierTaskDraft | null {
  if (!room.storage || amount <= 0) {
    return null;
  }

  const storageFree = room.storage.store.getFreeCapacity(resource);
  const movable = Math.min(availableAmount, storageFree, amount);
  if (movable <= 0) {
    return null;
  }

  return {
    id: `resourceControl:terminal_offload:${room.roomName}:${resource}`,
    type: "terminal_offload",
    priority: RESOURCE_CONTROL_TERMINAL_OFFLOAD_PRIORITY,
    steps: [
      {
        id: `${resource}:${room.terminal.id}->${room.storage.id}`,
        resource,
        fromKind: "terminal",
        toKind: "storage",
        fromId: room.terminal.id,
        toId: room.storage.id,
        amount: movable,
      },
    ],
  };
}

function getPlannedEnergySendBatch(
  room: ResourceControlSnapshot,
  context: ResourceControlTransferContext,
  options: TerminalEnergyPlanOptions = {},
): number {
  if (options.stagingBatch) {
    return options.stagingBatch.resource === RESOURCE_ENERGY
      ? options.stagingBatch.amount
      : 0;
  }
  if (options.legacyBacklog) {
    const outgoingEnergy =
      context.healthyOutgoingByRoomResource.get(
        roomResourceKey(room.roomName, RESOURCE_ENERGY),
      ) || 0;
    return outgoingEnergy > 0
      ? Math.min(room.transferBatchSize, outgoingEnergy)
      : isEnergyExportEligible(room)
        ? room.transferBatchSize
        : 0;
  }
  if (!isEnergyExportEligible(room)) return 0;
  return room.transferBatchSize;
}

function getEnergySendFeeBudget(
  room: ResourceControlSnapshot,
  snapshots: ResourceControlSnapshot[],
  amount: number,
  context: ResourceControlTransferContext,
  options: TerminalEnergyPlanOptions = {},
): number {
  if (!options.legacyBacklog && options.stagingBatch) {
    return options.stagingBatch.transactionFee;
  }
  if (options.legacyBacklog) {
    const pendingFeeBudget = context.outgoingFeeByRoom.get(room.roomName) || 0;
    if (amount <= 0) return pendingFeeBudget;
    const outgoingEnergy =
      context.healthyOutgoingByRoomResource.get(
        roomResourceKey(room.roomName, RESOURCE_ENERGY),
      ) || 0;
    if (outgoingEnergy > 0 || !isEnergyExportEligible(room)) {
      return pendingFeeBudget;
    }
    const receiver = snapshots
      .filter(
        (snapshot) =>
          snapshot.roomName !== room.roomName &&
          snapshot.storageEnergy < snapshot.energyTarget,
      )
      .sort((left, right) => {
        const leftNeed = left.energyTarget - left.storageEnergy;
        const rightNeed = right.energyTarget - right.storageEnergy;
        return (
          rightNeed - leftNeed || left.roomName.localeCompare(right.roomName)
        );
      })[0];
    return receiver
      ? pendingFeeBudget +
          Game.market.calcTransactionCost(
            amount,
            room.roomName,
            receiver.roomName,
          )
      : pendingFeeBudget;
  }
  if (amount <= 0 || !isEnergyExportEligible(room)) {
    return 0;
  }
  const receiver = snapshots
    .filter(
      (snapshot) =>
        snapshot.roomName !== room.roomName &&
        snapshot.storageEnergy < snapshot.energyTarget,
    )
    .sort((left, right) => {
      const leftNeed = left.energyTarget - left.storageEnergy;
      const rightNeed = right.energyTarget - right.storageEnergy;
      return (
        rightNeed - leftNeed || left.roomName.localeCompare(right.roomName)
      );
    })[0];
  return receiver
    ? Game.market.calcTransactionCost(amount, room.roomName, receiver.roomName)
    : 0;
}

function getReservedTerminalEnergyForPendingSends(
  room: ResourceControlSnapshot,
  snapshots: ResourceControlSnapshot[],
  context: ResourceControlTransferContext,
  options: TerminalEnergyPlanOptions = {},
): number {
  const stagedEnergy = getPlannedEnergySendBatch(room, context, options);
  const feeBudget = getEnergySendFeeBudget(
    room,
    snapshots,
    stagedEnergy,
    context,
    options,
  );
  return stagedEnergy + feeBudget;
}

function getProtectedTerminalEnergy(
  snapshot: ResourceControlSnapshot,
  snapshots: ResourceControlSnapshot[],
  context: ResourceControlTransferContext,
  options: TerminalEnergyPlanOptions = {},
): number {
  const protectedEnergy = Math.max(
    25_000,
    snapshot.terminalEnergyReserve +
      getReservedTerminalEnergyForPendingSends(
        snapshot,
        snapshots,
        context,
        options,
      ),
  );
  const existingProtectedEnergy = options.legacyBacklog
    ? protectedEnergy
    : protectedEnergy +
      getProductionCommitmentAmount(
        snapshot.roomName,
        RESOURCE_ENERGY,
        context,
      );
  const readiness = context.marketEnergyReadinessByRoom.get(snapshot.roomName);
  return readiness?.authorized
    ? Math.max(
        existingProtectedEnergy,
        readiness.effectivePostDealEnergyReserve,
      )
    : existingProtectedEnergy;
}

function createEnergyTerminalTask(
  room: ResourceControlSnapshot,
  snapshots: ResourceControlSnapshot[],
  context: ResourceControlTransferContext,
  options: TerminalEnergyPlanOptions = {},
): CarrierTaskDraft | null {
  if (!room.storage) {
    return null;
  }

  const terminalEnergy = room.terminalEnergy;
  const reservedTerminalEnergy = getReservedTerminalEnergyForPendingSends(
    room,
    snapshots,
    context,
    options,
  );
  const protectedTerminalEnergy = getProtectedTerminalEnergy(
    room,
    snapshots,
    context,
    options,
  );
  const trueOffloadableTerminalEnergy = Math.max(
    0,
    terminalEnergy - protectedTerminalEnergy,
  );

  const storageDeficit = room.energyTarget - room.storageEnergy;
  if (
    storageDeficit > room.transferBatchSize &&
    trueOffloadableTerminalEnergy >= room.transferBatchSize
  ) {
    return createTerminalOffloadTask(
      room,
      RESOURCE_ENERGY,
      Math.min(room.transferBatchSize, storageDeficit),
      trueOffloadableTerminalEnergy,
    );
  }

  const stagedEnergy = getPlannedEnergySendBatch(room, context, options);
  const feeBudget = reservedTerminalEnergy - stagedEnergy;
  const desiredTerminalEnergy =
    room.terminalEnergyReserve + stagedEnergy + feeBudget;
  return createTerminalFeedTask(room, RESOURCE_ENERGY, desiredTerminalEnergy);
}

interface TerminalOverflowPlan {
  desiredUsedCapacity: number;
  storageOffloadCapacity: number;
  recoveryOffloadBudget?: number;
  energyOptions?: TerminalEnergyPlanOptions;
  getProtectedNonEnergy(resource: ResourceConstant, stored: number): number;
}

interface TerminalOverflowDiagnostics {
  storedAmount: number;
  protectedAmount: number;
}

function appendTerminalOverflowDrafts(
  snapshot: ResourceControlSnapshot,
  snapshots: ResourceControlSnapshot[],
  context: ResourceControlTransferContext,
  drafts: CarrierTaskDraft[],
  offloadedResources: Set<ResourceConstant>,
  plan: TerminalOverflowPlan,
): TerminalOverflowDiagnostics {
  const diagnostics: TerminalOverflowDiagnostics = {
    storedAmount: 0,
    protectedAmount: 0,
  };
  if (
    !snapshot.storage ||
    snapshot.terminalUsedCapacity <= plan.desiredUsedCapacity
  ) {
    return diagnostics;
  }

  let overflowTotal = snapshot.terminalUsedCapacity;
  let storageOffloadCapacity = plan.storageOffloadCapacity;
  let recoveryOffloadBudget =
    plan.recoveryOffloadBudget ?? Number.POSITIVE_INFINITY;
  const allResources = RESOURCES_ALL.filter(
    (resource) =>
      getTerminalResourceAmount(snapshot, resource) > 0 &&
      !offloadedResources.has(resource),
  );
  allResources.sort((a, b) => {
    if (a === RESOURCE_ENERGY && b !== RESOURCE_ENERGY) return 1;
    if (a !== RESOURCE_ENERGY && b === RESOURCE_ENERGY) return -1;
    return 0;
  });

  for (const resource of allResources) {
    const stored = getTerminalResourceAmount(snapshot, resource);
    if (stored <= 0) continue;
    const protectedAmount =
      resource === RESOURCE_ENERGY
        ? getProtectedTerminalEnergy(
            snapshot,
            snapshots,
            context,
            plan.energyOptions,
          )
        : plan.getProtectedNonEnergy(resource, stored);
    diagnostics.storedAmount += stored;
    diagnostics.protectedAmount += Math.min(
      stored,
      Math.max(0, protectedAmount),
    );
    const amount = Math.min(
      stored - protectedAmount,
      overflowTotal - plan.desiredUsedCapacity,
      snapshot.transferBatchSize,
      storageOffloadCapacity,
      recoveryOffloadBudget,
    );
    if (amount <= 0) continue;
    const draft = createTerminalOffloadTask(snapshot, resource, amount);
    if (!draft) continue;

    drafts.push(draft);
    offloadedResources.add(resource);
    overflowTotal -= amount;
    storageOffloadCapacity -= amount;
    recoveryOffloadBudget -= amount;
  }
  return diagnostics;
}

function recordTerminalRecoveryObservation(
  snapshot: ResourceControlSnapshot,
  context: ResourceControlTransferContext,
  desiredTerminalUsedCapacity: number,
  storageOffloadCapacity: number,
  drafts: CarrierTaskDraft[],
  diagnostics: TerminalOverflowDiagnostics,
): void {
  const desiredTerminalFreeCapacity = Math.max(
    0,
    TERMINAL_STORAGE_CAPACITY - desiredTerminalUsedCapacity,
  );
  const terminalRecoveryGap = Math.max(
    0,
    desiredTerminalFreeCapacity - snapshot.terminalFreeCapacity,
  );
  const recoverableOffloadAmount =
    terminalRecoveryGap > 0
      ? Math.min(
          terminalRecoveryGap,
          drafts.reduce(
            (sum, draft) =>
              draft.type === "terminal_offload"
                ? sum +
                  draft.steps.reduce(
                    (stepSum, step) => stepSum + step.amount,
                    0,
                  )
                : sum,
            0,
          ),
        )
      : 0;
  let stickyHeadroom = false;
  let stickyHeadroomReason: TerminalStickyHeadroomReason | undefined;
  if (terminalRecoveryGap > 0) {
    if (storageOffloadCapacity <= 0) {
      stickyHeadroom = true;
      stickyHeadroomReason = "storage_full";
    } else if (recoverableOffloadAmount > 0) {
      const existingOffloadsByTaskId =
        context.existingTerminalOffloadCreatedAtByRoomTaskId.get(
          snapshot.roomName,
        );
      const hasMatchingExistingOffload = drafts.some((draft) => {
        if (draft.type !== "terminal_offload") return false;
        const createdAt = existingOffloadsByTaskId?.get(draft.id);
        return createdAt !== undefined && createdAt < Game.time;
      });
      const previousTerminalFreeCapacity =
        context.previousTerminalFreeCapacityByRoom.get(snapshot.roomName);
      if (
        hasMatchingExistingOffload &&
        previousTerminalFreeCapacity !== undefined &&
        snapshot.terminalFreeCapacity <= previousTerminalFreeCapacity
      ) {
        stickyHeadroom = true;
        stickyHeadroomReason = "carrier_backlog";
      }
    } else {
      stickyHeadroom = true;
      stickyHeadroomReason =
        diagnostics.storedAmount > 0 &&
        diagnostics.protectedAmount >= diagnostics.storedAmount
          ? "protected_inventory"
          : "no_offloadable_resource";
    }
  }
  context.terminalRecoveryObservationByRoom.set(snapshot.roomName, {
    desiredTerminalFreeCapacity,
    terminalRecoveryGap,
    recoverableOffloadAmount,
    stickyHeadroom,
    ...(stickyHeadroomReason ? { stickyHeadroomReason } : {}),
  });
}

function appendTerminalResourceFeedDrafts(
  snapshot: ResourceControlSnapshot,
  _marketCfg: ResourceControlMarketConfig,
  drafts: CarrierTaskDraft[],
  offloadedResources: Set<ResourceConstant>,
  desiredFeedByResource: Map<ResourceConstant, number>,
  initialFeedCapacity: number,
  limitByAdditionalCapacity = false,
  dispatchClassByResource?: ReadonlyMap<
    ResourceConstant,
    CarrierTaskDispatchClass
  >,
  boundResourceTransferTaskByResource?: ReadonlyMap<ResourceConstant, string>,
): void {
  // 永久闩：ResourceControl 不再为 native/Hub legacy seller 搬运待售货物。
  // desiredFeedByResource 来自既有内部 transfer staging 或已签名的
  // V3 市场出货货物准备；本函数不创建新的市场 writer。

  let feedCapacity = initialFeedCapacity;
  for (const [resource, target] of desiredFeedByResource.entries()) {
    if (feedCapacity <= 0) break;
    let requestedDraft = createTerminalFeedTask(
      snapshot,
      resource,
      limitByAdditionalCapacity ? target : Math.min(target, feedCapacity),
    );
    if (!requestedDraft) continue;
    const boundTaskId = boundResourceTransferTaskByResource?.get(resource);
    if (boundTaskId) {
      const boundTask = Memory.data?.resourceControl?.tasks?.[boundTaskId];
      requestedDraft = { ...requestedDraft, steps: requestedDraft.steps.map((step) => ({ ...step, boundResourceTransferTaskId: boundTaskId,
        ...(boundTask ? { boundResourceTransferTaskIdentity: terminalFeedBoundTaskIdentity(boundTask) } : {}) })) };
    }
    const draft = limitByAdditionalCapacity
      ? limitCarrierTaskDraftAmount(requestedDraft, feedCapacity)
      : requestedDraft;
    if (!draft) continue;
    const feedAmount = draft.steps.reduce((sum, step) => sum + step.amount, 0);
    feedCapacity -= feedAmount;
    const dispatchClass = dispatchClassByResource?.get(resource);
    drafts.push(dispatchClass ? { ...draft, dispatchClass } : draft);
  }
}

function getCarrierDraftAmount(
  draft: CarrierTaskDraft,
  resource?: ResourceConstant,
): number {
  return draft.steps.reduce(
    (sum, step) =>
      resource === undefined || step.resource === resource
        ? sum + step.amount
        : sum,
    0,
  );
}

function carrierDraftSetIsValid(drafts: CarrierTaskDraft[]): boolean {
  const draftIds = new Set<string>();
  const stepIds = new Set<string>();
  for (const draft of drafts) {
    if (!draft.id || draftIds.has(draft.id) || draft.steps.length === 0) {
      return false;
    }
    draftIds.add(draft.id);
    for (const step of draft.steps) {
      if (
        !step.id ||
        stepIds.has(step.id) ||
        !Number.isSafeInteger(step.amount) ||
        step.amount <= 0
      ) {
        return false;
      }
      stepIds.add(step.id);
    }
  }
  return true;
}

function blockMarketTerminalEnergyReadiness(
  observation: MarketTerminalEnergyReadinessObservation,
  blocker: MarketTerminalEnergyReadinessBlocker,
): void {
  observation.status = "blocked";
  observation.blocker = blocker;
  observation.plannedFeedAmount = 0;
}

/**
 * 在同一 per-room draft 集合中原位提升已有 Energy feed。返回 false 表示
 * draft 构造本身不可信，此时调用方必须保留旧 task set、不得部分 replace。
 */
function mergeMarketTerminalEnergyReadinessDraft(
  snapshot: ResourceControlSnapshot,
  drafts: CarrierTaskDraft[],
  capacityConfig: ResourceCapacityConfig,
  terminalClaimed: boolean,
  context: ResourceControlTransferContext,
): boolean {
  const observation = context.marketEnergyReadinessByRoom.get(
    snapshot.roomName,
  );
  if (!carrierDraftSetIsValid(drafts)) {
    if (observation) {
      blockMarketTerminalEnergyReadiness(observation, "draft_invalid");
    }
    return false;
  }
  if (!observation?.authorized) {
    return true;
  }

  const energyFeedId = `resourceControl:terminal_feed:${snapshot.roomName}:${RESOURCE_ENERGY}`;
  const energyOffloadId = `resourceControl:terminal_offload:${snapshot.roomName}:${RESOURCE_ENERGY}`;
  const energyFeedIndex = drafts.findIndex(
    (draft) => draft.id === energyFeedId,
  );
  const energyOffload = drafts.some((draft) => draft.id === energyOffloadId);
  const ordinaryFeedAmount =
    energyFeedIndex >= 0
      ? getCarrierDraftAmount(drafts[energyFeedIndex], RESOURCE_ENERGY)
      : 0;
  observation.desiredTerminalEnergy = Math.max(
    snapshot.terminalEnergy + ordinaryFeedAmount,
    observation.marketTerminalEnergyTarget,
  );

  if (terminalClaimed) {
    blockMarketTerminalEnergyReadiness(observation, "terminal_claimed");
    return true;
  }
  if (energyOffload) {
    blockMarketTerminalEnergyReadiness(observation, "energy_offload_conflict");
    return true;
  }

  const desiredFeedAmount = Math.max(
    0,
    observation.desiredTerminalEnergy - snapshot.terminalEnergy,
  );
  if (desiredFeedAmount <= 0) {
    observation.status = "ready";
    observation.plannedFeedAmount = 0;
    delete observation.blocker;
    return true;
  }

  // emergency lane 可以使用 terminal 已有 Energy，但不得使用 readiness egress
  // 例外从 storage 补给。
  if (snapshot.capacityState === "emergency") {
    blockMarketTerminalEnergyReadiness(observation, "capacity_emergency");
    return true;
  }
  if (!snapshot.storage) {
    blockMarketTerminalEnergyReadiness(observation, "storage_energy_floor");
    return true;
  }

  const replacement = createTerminalFeedTask(
    snapshot,
    RESOURCE_ENERGY,
    observation.desiredTerminalEnergy,
  );
  if (
    !replacement ||
    getCarrierDraftAmount(replacement, RESOURCE_ENERGY) !== desiredFeedAmount
  ) {
    blockMarketTerminalEnergyReadiness(observation, "terminal_capacity");
    return true;
  }

  const prospectiveDrafts = [...drafts];
  if (energyFeedIndex >= 0) {
    prospectiveDrafts[energyFeedIndex] = replacement;
  } else {
    prospectiveDrafts.push(replacement);
  }
  if (!carrierDraftSetIsValid(prospectiveDrafts)) {
    blockMarketTerminalEnergyReadiness(observation, "draft_invalid");
    return false;
  }

  const totalTerminalFeed = prospectiveDrafts
    .filter((draft) => draft.type === "terminal_feed")
    .reduce((sum, draft) => sum + getCarrierDraftAmount(draft), 0);
  const projectedTerminalFree =
    snapshot.terminalFreeCapacity - totalTerminalFeed;
  const minimumTerminalFree = Math.max(
    MARKET_TERMINAL_ENERGY_MIN_FREE_CAPACITY,
    capacityConfig.terminalPressureFreeCapacity,
  );
  if (projectedTerminalFree < minimumTerminalFree) {
    blockMarketTerminalEnergyReadiness(observation, "terminal_headroom");
    return true;
  }

  const totalEnergyFeed = prospectiveDrafts
    .filter((draft) => draft.type === "terminal_feed")
    .reduce(
      (sum, draft) =>
        sum + getCarrierDraftAmount(draft, RESOURCE_ENERGY),
      0,
    );
  const productionEnergyOwnership = getProductionCommitmentAmount(
    snapshot.roomName,
    RESOURCE_ENERGY,
    context,
  );
  if (
    !Number.isSafeInteger(productionEnergyOwnership) ||
    productionEnergyOwnership < 0 ||
    snapshot.storageEnergy - totalEnergyFeed <
      productionEnergyOwnership
  ) {
    blockMarketTerminalEnergyReadiness(
      observation,
      "production_energy_ownership",
    );
    return true;
  }

  drafts.splice(0, drafts.length, ...prospectiveDrafts);
  observation.status = "feed_planned";
  observation.plannedFeedAmount = desiredFeedAmount;
  delete observation.blocker;
  return true;
}

function commitTerminalLogisticsDrafts(
  snapshot: ResourceControlSnapshot,
  drafts: CarrierTaskDraft[],
  actions: string[],
): void {
  replaceCarrierTasksForProducerRoom(
    RESOURCE_CONTROL_TERMINAL_FEED_PRODUCER,
    snapshot.roomName,
    drafts,
  );
  if (drafts.length > 0) {
    actions.push(
      `terminal-logistics:${snapshot.roomName}:count=${drafts.length}`,
    );
  }
}

function prepareMarketTerminalEnergyReadiness(
  snapshot: ResourceControlSnapshot,
  context: ResourceControlTransferContext,
  authorization: MarketTerminalEnergyAuthorizationRead,
  actions: string[],
): boolean {
  const observation = createMarketTerminalEnergyReadinessObservation(
    snapshot,
    context,
    authorization,
  );
  context.marketEnergyReadinessByRoom.set(snapshot.roomName, observation);

  const productionEnergyOwnership = getProductionCommitmentAmount(
    snapshot.roomName,
    RESOURCE_ENERGY,
    context,
  );
  if (
    Number.isSafeInteger(productionEnergyOwnership) &&
    productionEnergyOwnership >= 0
  ) {
    return true;
  }

  blockMarketTerminalEnergyReadiness(
    observation,
    "production_energy_ownership",
  );
  // Clear every task owned by this producer so a previously valid feed cannot
  // remain runnable after ownership becomes untrustworthy.
  commitTerminalLogisticsDrafts(snapshot, [], actions);
  actions.push(
    `terminal-logistics-invalid-production-ownership:${snapshot.roomName}`,
  );
  return false;
}

function syncLegacyTerminalFeedTasks(
  snapshots: ResourceControlSnapshot[],
  marketCfg: ResourceControlMarketConfig,
  capacityConfig: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
  authorization: MarketTerminalEnergyAuthorizationRead,
  terminalBusy: Set<string>,
): string[] {
  const pendingByRoom = new Map<string, Map<ResourceConstant, number>>();
  const snapshotByRoom = new Map(
    snapshots.map((snapshot) => [snapshot.roomName, snapshot] as const),
  );
  for (const task of context.tasks) {
    if (task.status !== "pending" || task.resource === RESOURCE_ENERGY) {
      continue;
    }

    let pendingAmount = task.remainingAmount;
    if (task.reason?.startsWith("capacity:relief:")) {
      const source = snapshotByRoom.get(task.fromRoomName);
      const receiver = snapshotByRoom.get(task.toRoomName);
      if (
        !source ||
        !receiver ||
        source.capacityState === "normal" ||
        receiver.capacityState !== "normal" ||
        task.blockedReason === "receiver_capacity"
      ) {
        continue;
      }
      pendingAmount = computeSafeCapacityReliefAmount(
        source,
        task.toRoomName,
        task.resource,
        Math.min(
          task.remainingAmount,
          getCapacityReliefRecoveryGap(source, capacityConfig),
        ),
        capacityConfig,
        context,
        task.id,
      );
      if (
        source.terminalFreeCapacity <
        capacityConfig.terminalReliefTargetFreeCapacity
      ) {
        pendingAmount = Math.min(
          pendingAmount,
          getMovableResourceAmount(
            source,
            task.resource,
            "terminal",
            capacityConfig,
            context,
            task.id,
          ),
        );
      }
      if (pendingAmount <= 0) continue;
    }

    const roomPending =
      pendingByRoom.get(task.fromRoomName) ||
      new Map<ResourceConstant, number>();
    roomPending.set(
      task.resource,
      (roomPending.get(task.resource) || 0) + pendingAmount,
    );
    pendingByRoom.set(task.fromRoomName, roomPending);
  }

  const validRoomNames = new Set(
    snapshots.map((snapshot) => snapshot.roomName),
  );
  const actions: string[] = [];
  for (const snapshot of snapshots) {
    if (
      !prepareMarketTerminalEnergyReadiness(
        snapshot,
        context,
        authorization,
        actions,
      )
    ) {
      continue;
    }
    const drafts: CarrierTaskDraft[] = [];
    const offloadedResources = new Set<ResourceConstant>();
    const energyDraft = createEnergyTerminalTask(snapshot, snapshots, context, {
      legacyBacklog: true,
    });
    if (energyDraft) {
      drafts.push(energyDraft);
      if (energyDraft.type === "terminal_offload") {
        offloadedResources.add(RESOURCE_ENERGY);
      }
    }

    const roomPending = pendingByRoom.get(snapshot.roomName);
    const storageOffloadCapacity = snapshot.storage
      ? Math.max(
          0,
          snapshot.storage.store.getFreeCapacity() -
            getLocalCarrierDestinationCommittedAmount(snapshot.storage.id),
        )
      : 0;
    const overflowDiagnostics = appendTerminalOverflowDrafts(
      snapshot,
      snapshots,
      context,
      drafts,
      offloadedResources,
      {
        desiredUsedCapacity: TERMINAL_TOTAL_STORAGE_CAP,
        storageOffloadCapacity,
        energyOptions: { legacyBacklog: true },
        getProtectedNonEnergy: (resource, stored) =>
          Math.min(stored, roomPending?.get(resource) ?? 0),
      },
    );

    const offloadTotal = drafts.reduce(
      (sum, draft) =>
        draft.type === "terminal_offload"
          ? sum +
            draft.steps.reduce((stepSum, step) => stepSum + step.amount, 0)
          : sum,
      0,
    );
    const feedCapacity = Math.max(
      0,
      TERMINAL_TOTAL_STORAGE_CAP -
        (snapshot.terminalUsedCapacity - offloadTotal),
    );

    const desiredFeedByResource = new Map<ResourceConstant, number>();
    if (roomPending) {
      for (const [resource, amount] of roomPending.entries()) {
        if (offloadedResources.has(resource)) continue;
        desiredFeedByResource.set(
          resource,
          Math.min(snapshot.transferBatchSize, amount),
        );
      }
    }
    appendTerminalResourceFeedDrafts(
      snapshot,
      marketCfg,
      drafts,
      offloadedResources,
      desiredFeedByResource,
      feedCapacity,
    );
    recordTerminalRecoveryObservation(
      snapshot,
      context,
      TERMINAL_TOTAL_STORAGE_CAP,
      storageOffloadCapacity,
      drafts,
      overflowDiagnostics,
    );
    if (
      mergeMarketTerminalEnergyReadinessDraft(
        snapshot,
        drafts,
        capacityConfig,
        terminalBusy.has(snapshot.roomName),
        context,
      )
    ) {
      commitTerminalLogisticsDrafts(snapshot, drafts, actions);
    } else {
      actions.push(`terminal-logistics-invalid:${snapshot.roomName}`);
    }
  }

  pruneCarrierTasksForProducer(
    RESOURCE_CONTROL_TERMINAL_FEED_PRODUCER,
    validRoomNames,
  );
  return actions;
}

function limitCarrierTaskDraftAmount(
  draft: CarrierTaskDraft,
  maximumAmount: number,
): CarrierTaskDraft | null {
  let remaining = Math.max(0, Math.floor(maximumAmount));
  const steps = draft.steps
    .map((step) => {
      const amount = Math.min(step.amount, remaining);
      remaining -= amount;
      return { ...step, amount,
        ...(step.destinationTargetAmount !== undefined
          ? { destinationTargetAmount: Math.max(0, step.destinationTargetAmount - step.amount) + amount }
          : {}),
      };
    })
    .filter((step) => step.amount > 0);
  return steps.length > 0 ? { ...draft, steps } : null;
}

function getRequiredTerminalStagingFeedAmount(
  source: ResourceControlSnapshot,
  resource: ResourceConstant,
  amount: number,
  transactionFee: number,
): { energy: number; resource: number; total: number } {
  const resourceFeedAmount =
    resource === RESOURCE_ENERGY
      ? 0
      : Math.max(0, amount - getTerminalResourceAmount(source, resource));
  const desiredEnergy =
    transactionFee + (resource === RESOURCE_ENERGY ? amount : 0);
  const energyFeedAmount = Math.max(0, desiredEnergy - source.terminalEnergy);
  return {
    energy: energyFeedAmount,
    resource: resourceFeedAmount,
    total: energyFeedAmount + resourceFeedAmount,
  };
}

interface TerminalStagingAssessment {
  affordableAmount: number;
  suppressedReason?: TerminalStagingSuppressionReason;
}

function assessTransferTaskStagingBatch(
  source: ResourceControlSnapshot,
  receiver: ResourceControlSnapshot,
  task: ResourceTransferTask,
  maximumAmount: number,
  capacityConfig: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
): TerminalStagingAssessment {
  const synthesisDemand = inspectTaskSynthesisDemand(task, context);
  if (synthesisDemand.status === "held" || synthesisDemand.status === "bounded" && synthesisDemand.amount <= 0) {
    return { affordableAmount: 0, suppressedReason: "source_inventory" };
  }
  if (synthesisDemand.status === "bounded") maximumAmount = Math.min(maximumAmount, synthesisDemand.amount);
  if (maximumAmount <= 0) {
    return { affordableAmount: 0, suppressedReason: "source_depleted" };
  }
  const sourceSafeAmount =
    task.resource === RESOURCE_ENERGY
      ? getTerminalActionEnergyBudget(source, context, task.id)
      : getTotalMovableResourceAmount(
          source,
          task.resource,
          capacityConfig,
          context,
          task.id,
        );
  if (sourceSafeAmount <= 0) {
    return { affordableAmount: 0, suppressedReason: "source_inventory" };
  }
  const usePhysicalTerminalHeadroom = isWarBoostShipment(task);
  const receiverAllowance = usePhysicalTerminalHeadroom
    ? context.receiverCapacityLedger.getTerminalAvailableAmount(
        receiver.roomName,
        task.resource,
        task.id,
      )
    : context.receiverCapacityLedger.getAvailableAmount(
        receiver.roomName,
        task.resource,
        task.id,
      );
  if (receiverAllowance <= 0) {
    return { affordableAmount: 0, suppressedReason: "receiver_capacity" };
  }
  const maximum = Math.floor(
    Math.min(maximumAmount, sourceSafeAmount, receiverAllowance),
  );
  if (maximum <= 0) {
    return { affordableAmount: 0, suppressedReason: "source_inventory" };
  }

  if (task.resource !== RESOURCE_ENERGY) {
    const maximumTransactionFee = Game.market.calcTransactionCost(
      maximum,
      source.roomName,
      receiver.roomName,
    );
    const maximumRequiredFeed = getRequiredTerminalStagingFeedAmount(
      source,
      task.resource,
      maximum,
      maximumTransactionFee,
    );
    if (
      maximumRequiredFeed.resource === 0 &&
      maximumRequiredFeed.total > source.terminalFreeCapacity
    ) {
      return { affordableAmount: 0, suppressedReason: "terminal_headroom" };
    }
  }

  const energyBudget = getTerminalActionEnergyBudget(
    source,
    context,
    task.id,
  );
  const { feedCapacity } = getTerminalLogisticsCapacityPlan(
    source,
    capacityConfig,
  );
  const productionFeedCapacity = resolveSynthesisStagingFeedCapacity(
    feedCapacity, source.terminalFreeCapacity,
    getLocalCarrierDestinationCommittedAmount(source.terminal.id),
    synthesisDemand.status === "bounded",
  );
  const getSuppressionReason = (
    amount: number,
  ): TerminalStagingSuppressionReason | undefined => {
    const transactionFee = Game.market.calcTransactionCost(
      amount,
      source.roomName,
      receiver.roomName,
    );
    const spentEnergy = getTerminalActionRequiredEnergy({
      energyPayload: task.resource === RESOURCE_ENERGY,
      amount,
      transactionFee,
    });
    const requiredFeed = getRequiredTerminalStagingFeedAmount(
      source,
      task.resource,
      amount,
      transactionFee,
    );
    if (
      requiredFeed.resource >
      source.storage!.store.getUsedCapacity(task.resource)
    ) {
      return "source_inventory";
    }
    if (
      spentEnergy > energyBudget ||
      requiredFeed.energy >
        source.storage!.store.getUsedCapacity(RESOURCE_ENERGY)
    ) {
      return "fee_budget";
    }
    const actionBoundFeedCapacity =
      task.resource !== RESOURCE_ENERGY && requiredFeed.resource === 0
        ? synthesisDemand.status === "bounded"
          ? productionFeedCapacity
          : Math.max(feedCapacity, source.terminalFreeCapacity)
        : productionFeedCapacity;
    if (requiredFeed.total > actionBoundFeedCapacity) {
      return "terminal_headroom";
    }
    return undefined;
  };
  const canStage = (amount: number): boolean =>
    getSuppressionReason(amount) === undefined;

  const affordableAmount = computeLargestAffordableAmount(maximum, canStage);
  if (affordableAmount <= 0) {
    return {
      affordableAmount: 0,
      suppressedReason:
        getSuppressionReason(Math.min(1, maximum)) || "source_inventory",
    };
  }
  return { affordableAmount };
}

function reserveTransferTaskStagingBatch(
  source: ResourceControlSnapshot,
  receiver: ResourceControlSnapshot,
  task: ResourceTransferTask,
  maximumAmount: number,
  capacityConfig: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
): TerminalStagingAttempt {
  const assessment = assessTransferTaskStagingBatch(
    source,
    receiver,
    task,
    maximumAmount,
    capacityConfig,
    context,
  );
  if (assessment.affordableAmount <= 0) {
    return { suppressedReason: assessment.suppressedReason };
  }
  const grantedAmount = context.receiverCapacityLedger.reserve(
    task.id,
    receiver.roomName,
    task.resource,
    assessment.affordableAmount,
    isWarBoostShipment(task)
      ? { ownerTaskId: task.id, allowTerminalSafetyReserve: true }
      : { ownerTaskId: task.id },
  );
  if (grantedAmount <= 0) {
    return { suppressedReason: "receiver_capacity" };
  }
  const amount = Math.min(assessment.affordableAmount, grantedAmount);
  const reservedAmount = context.receiverCapacityLedger.reserve(
    task.id,
    receiver.roomName,
    task.resource,
    amount,
    isWarBoostShipment(task)
      ? { ownerTaskId: task.id, allowTerminalSafetyReserve: true }
      : { ownerTaskId: task.id },
  );
  if (reservedAmount <= 0) {
    return { suppressedReason: "receiver_capacity" };
  }

  return {
    batch: {
      resource: task.resource,
      amount: reservedAmount,
      ...(inspectTaskSynthesisDemand(task, context).status === "bounded" ? { productionDemandBounded: true, productionResourceTransferTaskId: task.id } : {}),
      transactionFee: Game.market.calcTransactionCost(
        reservedAmount,
        source.roomName,
        receiver.roomName,
      ),
    },
  };
}

function reserveEnergyDeficitStagingBatch(
  source: ResourceControlSnapshot,
  snapshots: ResourceControlSnapshot[],
  planningEnergyNeedByRoom: Map<string, number>,
  context: ResourceControlTransferContext,
  capacityConfig: ResourceCapacityConfig,
): TerminalStagingBatch | undefined {
  if (
    !source.storage ||
    !isEnergyExportEligible(source) ||
    (context.healthyOutgoingByRoomResource.get(
      roomResourceKey(source.roomName, RESOURCE_ENERGY),
    ) || 0) > 0
  ) {
    return undefined;
  }

  const sourceEnergyBudget = getEnergyBalancingSurplus(source, context);
  if (sourceEnergyBudget <= 0) return undefined;
  const { feedCapacity } = getTerminalLogisticsCapacityPlan(
    source,
    capacityConfig,
  );
  if (feedCapacity <= 0) return undefined;

  const canStageBatch = (amount: number, receiverRoomName: string): boolean => {
    const transactionFee = Game.market.calcTransactionCost(
      amount,
      source.roomName,
      receiverRoomName,
    );
    if (amount + transactionFee > sourceEnergyBudget) return false;
    const energyDraft = createEnergyTerminalTask(source, snapshots, context, {
      stagingBatch: {
        resource: RESOURCE_ENERGY,
        amount,
        transactionFee,
      },
    });
    if (!energyDraft) return true;
    return (
      energyDraft.type === "terminal_feed" &&
      energyDraft.steps.reduce((sum, step) => sum + step.amount, 0) <=
        feedCapacity
    );
  };

  const receivers = snapshots
    .filter(
      (receiver) => receiver.roomName !== source.roomName && !!receiver.storage,
    )
    .filter(
      (receiver) => !context.healthyIncomingEnergyRooms.has(receiver.roomName),
    )
    .filter(
      (receiver) => (planningEnergyNeedByRoom.get(receiver.roomName) || 0) > 0,
    )
    .sort((left, right) => {
      const leftNeed = planningEnergyNeedByRoom.get(left.roomName) || 0;
      const rightNeed = planningEnergyNeedByRoom.get(right.roomName) || 0;
      return (
        rightNeed - leftNeed || left.roomName.localeCompare(right.roomName)
      );
    });

  for (const receiver of receivers) {
    const receiverNeed = planningEnergyNeedByRoom.get(receiver.roomName) || 0;
    const receiverCapacity = context.receiverCapacityLedger.getAvailableAmount(
      receiver.roomName,
      RESOURCE_ENERGY,
    );
    const maximum = Math.floor(
      Math.min(
        source.transferBatchSize,
        receiverNeed,
        receiverCapacity,
        sourceEnergyBudget,
      ),
    );
    const amount = computeLargestAffordableAmount(maximum, (candidate) =>
      canStageBatch(candidate, receiver.roomName),
    );
    if (amount <= 0) continue;

    const reservationId = `resourceControl:terminal-energy-staging:${source.roomName}`;
    const grantedAmount = context.receiverCapacityLedger.reserve(
      reservationId,
      receiver.roomName,
      RESOURCE_ENERGY,
      amount,
    );
    const reservedAmount = computeLargestAffordableAmount(
      Math.min(grantedAmount, receiverNeed),
      (candidate) => canStageBatch(candidate, receiver.roomName),
    );
    context.receiverCapacityLedger.reserve(
      reservationId,
      receiver.roomName,
      RESOURCE_ENERGY,
      reservedAmount,
    );
    if (reservedAmount <= 0) continue;

    const batch = {
      resource: RESOURCE_ENERGY,
      amount: reservedAmount,
      transactionFee: Game.market.calcTransactionCost(
        reservedAmount,
        source.roomName,
        receiver.roomName,
      ),
    };
    const energyDraft = createEnergyTerminalTask(source, snapshots, context, {
      stagingBatch: batch,
    });
    if (
      energyDraft?.type !== "terminal_feed" ||
      energyDraft.steps.reduce((sum, step) => sum + step.amount, 0) >
        feedCapacity
    ) {
      context.receiverCapacityLedger.reserve(
        reservationId,
        receiver.roomName,
        RESOURCE_ENERGY,
        0,
      );
      continue;
    }

    planningEnergyNeedByRoom.set(
      receiver.roomName,
      Math.max(0, receiverNeed - reservedAmount),
    );
    return batch;
  }

  return undefined;
}

interface AuthorizedMarketCargoTarget {
  resource: ResourceConstant;
  targetStock: number;
}

/**
 * 仅为当前 V3 permit 允许的新成交搬运一批货。可售量仍由原保护账本
 * 扣除生产、在途与其他 exposure；这里不签发市场写权限。
 */
function planAuthorizedMarketCargoTargets(
  snapshots: ResourceControlSnapshot[],
  authorization: MarketTerminalEnergyAuthorizationRead,
): Map<string, AuthorizedMarketCargoTarget> {
  const targets = new Map<string, AuthorizedMarketCargoTarget>();
  if (!authorization.ok || !authorization.cargoLanes?.length) return targets;
  const marketData = Memory.data?.marketSaleAutomation as unknown;
  if (!isPlainRecord(marketData) ||
      !isPlainRecord(marketData.managedOrders) ||
      Object.keys(marketData.managedOrders).length > 0) {
    return targets;
  }
  const direct = isPlainRecord(marketData.directAutomation)
    ? marketData.directAutomation
    : undefined;
  const v3 = direct && isPlainRecord(direct.baseResourceV3)
    ? direct.baseResourceV3
    : undefined;
  const ledgerState = v3 && isPlainRecord(v3.ledger) ? v3.ledger : undefined;
  if (!ledgerState || ledgerState.pending !== undefined || ledgerState.blocker !== undefined) {
    return targets;
  }
  const config = resolveMarketSaleAutomationConfig(
    Memory.cfg?.marketSaleAutomation,
  );
  if (!config.validForPlanning || config.mode !== "direct") return targets;

  const snapshotByRoom = new Map(snapshots.map((snapshot) => [snapshot.roomName, snapshot] as const));
  const lanes = authorization.cargoLanes.filter((lane) => {
    const snapshot = snapshotByRoom.get(lane.roomName);
    return isMarketBaseResource(lane.resource) &&
      snapshot?.terminal?.id === lane.terminalId &&
      snapshot.storage !== undefined &&
      lane.maxDealAmount === MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[lane.resource].maxDealAmount &&
      getTerminalResourceAmount(snapshot, lane.resource) < lane.maxDealAmount &&
      snapshot.storage.store.getUsedCapacity(lane.resource) > 0;
  });
  if (lanes.length === 0) return targets;
  const protection = collectLiveMarketSaleProtectionLedger(config, [], {
    candidates: lanes.map((lane) => ({
      roomName: lane.roomName,
      resource: lane.resource,
    })),
    laneReserveByEntry: Object.fromEntries(lanes.map((lane) => [
      getMarketProtectionEntryKey(lane.roomName, lane.resource),
      MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[lane.resource as keyof typeof MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE].laneReserve,
    ])),
  });
  if (protection.globalBlocked) return targets;
  const ranked = lanes.flatMap((lane) => {
    const entry = protection.entries[getMarketProtectionEntryKey(lane.roomName, lane.resource)];
    if (!entry || !isMarketProtectionEntryFresh(entry, Game.time)) return [];
    const surplus = getMarketProtectionSellableAmount(entry, Game.time, {
      requireTerminalBacking: false,
    });
    return surplus >= lane.maxDealAmount
      ? [{ lane, surplus }]
      : [];
  }).sort((left, right) =>
    right.surplus - left.surplus ||
    left.lane.roomName.localeCompare(right.lane.roomName) ||
    left.lane.resource.localeCompare(right.lane.resource),
  );
  for (const { lane } of ranked) {
    if (!targets.has(lane.roomName)) {
      targets.set(lane.roomName, {
        resource: lane.resource,
        targetStock: lane.maxDealAmount,
      });
    }
  }
  return targets;
}

export function syncTerminalFeedTasks(
  snapshots: ResourceControlSnapshot[],
  marketCfg: ResourceControlMarketConfig,
  capacityConfig: ResourceCapacityConfig,
  context: ResourceControlTransferContext,
  remainingEnergyNeedByRoom: Map<string, number>,
  authorization: MarketTerminalEnergyAuthorizationRead,
  terminalBusy: Set<string>,
): string[] {
  if (!capacityConfig.terminalHeadroomRecoveryEnabled) {
    return syncLegacyTerminalFeedTasks(
      snapshots,
      marketCfg,
      capacityConfig,
      context,
      authorization,
      terminalBusy,
    );
  }

  const stagingBatchByRoom = new Map<string, TerminalStagingBatch>();
  const marketCargoTargets = planAuthorizedMarketCargoTargets(
    snapshots,
    authorization,
  );
  const planningEnergyNeedByRoom = new Map(remainingEnergyNeedByRoom);
  const snapshotByRoom = new Map(
    snapshots.map((snapshot) => [snapshot.roomName, snapshot] as const),
  );
  const priorityContext = createTransferTaskPriorityContext(
    snapshots,
    capacityConfig,
    remainingEnergyNeedByRoom,
  );
  for (const task of sortTransferTasksByPriority(
    context.tasks,
    priorityContext,
  )) {
    if (task.status !== "pending") continue;
    const source = snapshotByRoom.get(task.fromRoomName);
    const receiver = snapshotByRoom.get(task.toRoomName);
    if (!source?.storage || !receiver?.storage) {
      recordTerminalStagingSuppression(
        context,
        task.fromRoomName,
        "invalid_endpoint",
      );
      continue;
    }
    if (task.blockedReason === "receiver_capacity") {
      recordTerminalStagingSuppression(
        context,
        task.fromRoomName,
        "receiver_capacity",
      );
      continue;
    }
    if (task.blockedReason === "source_depleted") {
      recordTerminalStagingSuppression(
        context,
        task.fromRoomName,
        "source_depleted",
      );
      continue;
    }

    let pendingAmount = Math.min(
      task.remainingAmount,
      source.transferBatchSize,
    );
    const synthesisDemand = inspectTaskSynthesisDemand(task, context);
    if (synthesisDemand.status === "held" || synthesisDemand.status === "bounded" && synthesisDemand.amount <= 0) {
      recordTerminalStagingSuppression(context, task.fromRoomName, "source_inventory");
      continue;
    }
    if (synthesisDemand.status === "bounded") pendingAmount = Math.min(pendingAmount, synthesisDemand.amount);
    if (task.reason?.startsWith("capacity:relief:")) {
      if (source.capacityState === "normal") {
        recordTerminalStagingSuppression(
          context,
          task.fromRoomName,
          "source_depleted",
        );
        continue;
      }
      if (receiver.capacityState !== "normal") {
        recordTerminalStagingSuppression(
          context,
          task.fromRoomName,
          "receiver_capacity",
        );
        continue;
      }
      pendingAmount = computeSafeCapacityReliefAmount(
        source,
        task.toRoomName,
        task.resource,
        Math.min(
          task.remainingAmount,
          source.transferBatchSize,
          getCapacityReliefRecoveryGap(source, capacityConfig),
          getCapacityReliefReceivableAmount(receiver, capacityConfig),
          getCapacityReliefLedgerAvailableAmount(
            receiver,
            task.resource,
            context,
            task.id,
          ),
        ),
        capacityConfig,
        context,
        task.id,
      );
      if (
        source.terminalFreeCapacity <
        capacityConfig.terminalReliefTargetFreeCapacity
      ) {
        pendingAmount = Math.min(
          pendingAmount,
          getMovableResourceAmount(
            source,
            task.resource,
            "terminal",
            capacityConfig,
            context,
            task.id,
          ),
        );
      }
      if (pendingAmount <= 0) {
        recordTerminalStagingSuppression(
          context,
          task.fromRoomName,
          context.receiverCapacityLedger.getAvailableAmount(
            receiver.roomName,
            task.resource,
            task.id,
          ) <= 0
            ? "receiver_capacity"
            : "source_inventory",
        );
        continue;
      }
    }

    if (stagingBatchByRoom.has(task.fromRoomName)) {
      const assessment = assessTransferTaskStagingBatch(
        source,
        receiver,
        task,
        pendingAmount,
        capacityConfig,
        context,
      );
      recordTerminalStagingSuppression(
        context,
        task.fromRoomName,
        assessment.suppressedReason || "window_limit",
      );
      continue;
    }

    const attempt = reserveTransferTaskStagingBatch(
      source,
      receiver,
      task,
      pendingAmount,
      capacityConfig,
      context,
    );
    if (!attempt.batch) {
      recordTerminalStagingSuppression(
        context,
        task.fromRoomName,
        attempt.suppressedReason || "source_inventory",
      );
      continue;
    }
    const batch = task.origin === "automatic" &&
      task.reason?.startsWith("capacity:relief:")
      ? {
          ...attempt.batch,
          dispatchClass: "capacity_relief" as const,
        }
      : attempt.batch;
    stagingBatchByRoom.set(task.fromRoomName, batch);
    recordTerminalStagingAdmission(context, task.fromRoomName, batch);
  }

  // Persisted/manual/capacity tasks already own an explicit send window. Only
  // rooms without such a batch may use speculative automatic Energy staging.
  for (const snapshot of snapshots) {
    if (stagingBatchByRoom.has(snapshot.roomName)) continue;
    const energyBatch = reserveEnergyDeficitStagingBatch(
      snapshot,
      snapshots,
      planningEnergyNeedByRoom,
      context,
      capacityConfig,
    );
    if (energyBatch) {
      stagingBatchByRoom.set(snapshot.roomName, energyBatch);
      recordTerminalStagingAdmission(
        context,
        snapshot.roomName,
        energyBatch,
        false,
      );
    }
  }

  const validRoomNames = new Set(
    snapshots.map((snapshot) => snapshot.roomName),
  );
  const actions: string[] = [];
  for (const snapshot of snapshots) {
    if (
      !prepareMarketTerminalEnergyReadiness(
        snapshot,
        context,
        authorization,
        actions,
      )
    ) {
      continue;
    }
    const drafts: CarrierTaskDraft[] = [];
    const stagingBatch = stagingBatchByRoom.get(snapshot.roomName);
    const marketCargoTarget = !stagingBatch && !terminalBusy.has(snapshot.roomName)
      ? marketCargoTargets.get(snapshot.roomName)
      : undefined;
    // 已接货/在途的所有 terminal 投递都先占物理容量；保守地从单批
    // 待售目标中扣除，避免跨 tick 的第二名 carrier 重复搬同一批货。
    const marketCargoOutstanding = marketCargoTarget
      ? Math.max(0, marketCargoTarget.targetStock -
          getTerminalResourceAmount(snapshot, marketCargoTarget.resource) -
          getLocalCarrierDestinationCommittedAmount(snapshot.terminal.id))
      : 0;
    const energyDraft = createEnergyTerminalTask(snapshot, snapshots, context, {
      stagingBatch,
    });
    const {
      recoveringTerminal,
      desiredTerminalUsedCapacity,
      feedCapacity: safeFeedCapacity,
    } = getTerminalLogisticsCapacityPlan(snapshot, capacityConfig);
    const stagingFeedRequirement = stagingBatch
      ? getRequiredTerminalStagingFeedAmount(
          snapshot,
          stagingBatch.resource,
          stagingBatch.amount,
          stagingBatch.transactionFee,
        )
      : undefined;

    // Terminal overflow: offload surplus above cap to storage
    // Compute offload drafts first so we can suppress conflicting feed drafts
    const offloadedResources = new Set<ResourceConstant>();
    const effectiveStorageOffloadCapacity = snapshot.storage
      ? Math.max(
          0,
          snapshot.storage.store.getFreeCapacity() -
            capacityConfig.storageReliefTargetFreeCapacity -
            getLocalCarrierDestinationCommittedAmount(snapshot.storage.id),
        )
      : 0;
    let storageOffloadCapacity = effectiveStorageOffloadCapacity;
    if (!recoveringTerminal && energyDraft?.type === "terminal_offload") {
      const limitedEnergyOffload = limitCarrierTaskDraftAmount(
        energyDraft,
        storageOffloadCapacity,
      );
      if (limitedEnergyOffload) {
        const amount = limitedEnergyOffload.steps.reduce(
          (sum, step) => sum + step.amount,
          0,
        );
        drafts.push(limitedEnergyOffload);
        offloadedResources.add(RESOURCE_ENERGY);
        storageOffloadCapacity -= amount;
      }
    }

    const overflowDiagnostics = appendTerminalOverflowDrafts(
      snapshot,
      snapshots,
      context,
      drafts,
      offloadedResources,
      {
        desiredUsedCapacity: desiredTerminalUsedCapacity,
        storageOffloadCapacity,
        recoveryOffloadBudget: recoveringTerminal
          ? Math.min(
              snapshot.terminalUsedCapacity - desiredTerminalUsedCapacity,
              snapshot.transferBatchSize,
              storageOffloadCapacity,
            )
          : Number.POSITIVE_INFINITY,
        energyOptions: { stagingBatch },
        getProtectedNonEnergy: (resource, stored) =>
          Math.min(
            stored,
            (stagingBatch?.resource === resource ? stagingBatch.amount : 0) +
              getProductionCommitmentAmount(
                snapshot.roomName,
                resource,
                context,
              ),
          ),
      },
    );

    // 出货准备只需物理空位。普通入库的 80k terminal / 200k storage
    // 安全容量不得阻断 terminal -> storage 的临时腾挪；仍保留全部
    // 生产/市场 Energy 预约，并且每房最多为一笔已授权货物腾出 1k。
    if (marketCargoTarget && snapshot.storage) {
      const missingHeadroom = Math.max(
        0,
        marketCargoOutstanding - snapshot.terminalFreeCapacity,
      );
      const physicalStorageFree = Math.max(
        0,
        snapshot.storage.store.getFreeCapacity() -
          getLocalCarrierDestinationCommittedAmount(snapshot.storage.id),
      );
      const unclaimedEnergy = Math.max(
        0,
        getTerminalAmountOutsideMarketSaleExposure(
          snapshot.terminal,
          RESOURCE_ENERGY,
          snapshot.roomName,
        ) - getProtectedTerminalEnergy(snapshot, snapshots, context, { stagingBatch }),
      );
      const offloadAmount = Math.min(
        missingHeadroom,
        physicalStorageFree,
        unclaimedEnergy,
        snapshot.transferBatchSize,
      );
      if (offloadAmount > 0 && !offloadedResources.has(RESOURCE_ENERGY)) {
        const draft = createTerminalOffloadTask(
          snapshot,
          RESOURCE_ENERGY,
          offloadAmount,
          unclaimedEnergy,
        );
        if (draft) {
          drafts.push(draft);
          offloadedResources.add(RESOURCE_ENERGY);
        }
      }
    }

    const marketCargoFeedCapacity = marketCargoTarget
      ? Math.min(snapshot.terminalFreeCapacity, marketCargoOutstanding)
      : 0;
    const productionFeedCapacity = resolveSynthesisStagingFeedCapacity(
      safeFeedCapacity, snapshot.terminalFreeCapacity,
      getLocalCarrierDestinationCommittedAmount(snapshot.terminal.id),
      stagingBatch?.productionDemandBounded === true,
      stagingFeedRequirement?.total,
    );
    let feedCapacity = Math.max(productionFeedCapacity, marketCargoFeedCapacity);
    if (
      energyDraft?.type === "terminal_feed" &&
      !offloadedResources.has(RESOURCE_ENERGY)
    ) {
      const maximumEnergyFeed = stagingBatch?.dispatchClass === "capacity_relief" &&
        stagingFeedRequirement
        ? stagingFeedRequirement.energy
        : stagingBatch?.resource !== RESOURCE_ENERGY && stagingFeedRequirement
          ? Math.max(
              stagingFeedRequirement.energy,
              feedCapacity - stagingFeedRequirement.resource,
            )
          : feedCapacity;
      const limitedEnergyFeed = limitCarrierTaskDraftAmount(
        energyDraft,
        maximumEnergyFeed,
      );
      if (limitedEnergyFeed) {
        const amount = limitedEnergyFeed.steps.reduce(
          (sum, step) => sum + step.amount,
          0,
        );
        drafts.push(stagingBatch?.dispatchClass
          ? {
              ...limitedEnergyFeed,
              dispatchClass: stagingBatch.dispatchClass,
            }
          : limitedEnergyFeed);
        feedCapacity -= amount;
      }
    }

    const desiredFeedByResource = new Map<ResourceConstant, number>();
    if (
      stagingBatch &&
      stagingBatch.resource !== RESOURCE_ENERGY &&
      !offloadedResources.has(stagingBatch.resource)
    ) {
      desiredFeedByResource.set(
        stagingBatch.resource,
        Math.min(snapshot.transferBatchSize, stagingBatch.amount),
      );
    }
    if (marketCargoTarget && marketCargoOutstanding > 0 &&
        !offloadedResources.has(marketCargoTarget.resource)) {
      desiredFeedByResource.set(
        marketCargoTarget.resource,
        getTerminalResourceAmount(snapshot, marketCargoTarget.resource) +
          marketCargoOutstanding,
      );
    }

    appendTerminalResourceFeedDrafts(
      snapshot,
      marketCfg,
      drafts,
      offloadedResources,
      desiredFeedByResource,
      feedCapacity,
      true,
      new Map([
        ...(stagingBatch?.dispatchClass && stagingBatch.resource !== RESOURCE_ENERGY
          ? [[stagingBatch.resource, stagingBatch.dispatchClass] as const]
          : []),
        ...(marketCargoTarget && marketCargoOutstanding > 0
          ? [[marketCargoTarget.resource, "market_egress" as const] as const]
          : []),
      ]),
      stagingBatch?.productionResourceTransferTaskId
        ? new Map([[stagingBatch.resource, stagingBatch.productionResourceTransferTaskId]])
        : undefined,
    );
    const validDraftSet = mergeMarketTerminalEnergyReadinessDraft(
      snapshot,
      drafts,
      capacityConfig,
      terminalBusy.has(snapshot.roomName) ||
        stagingBatch?.dispatchClass === "capacity_relief",
      context,
    );
    recordTerminalRecoveryObservation(
      snapshot,
      context,
      desiredTerminalUsedCapacity,
      effectiveStorageOffloadCapacity,
      drafts,
      overflowDiagnostics,
    );
    if (validDraftSet) {
      commitTerminalLogisticsDrafts(snapshot, drafts, actions);
    } else {
      actions.push(`terminal-logistics-invalid:${snapshot.roomName}`);
    }
  }

  pruneCarrierTasksForProducer(
    RESOURCE_CONTROL_TERMINAL_FEED_PRODUCER,
    validRoomNames,
  );
  return actions;
}
