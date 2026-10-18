import { isDue } from "@/runtime/cadence";
/** 从 resourceControl.ts 分离的独立职责模块；共享状态仅由此处持有。 */
import { inspectSynthesisTransferNeed } from "@/runtime/synthesisReadModel";
import { validateReservationStoreHealth } from "@/runtime/resourceReservation";
import { listCarrierTasksByRoom, peekCarrierTasksByRoom } from "@/runtime/carrierTaskBoard";
import {
  DEFAULT_RECEIVER_CAPACITY_DEMAND_COVERAGE_GRACE_TICKS,
  getResourceTransferTaskListSorted,
  isHealthyReceiverCapacityCommitment,
  isHealthyResourceTransferTaskReservation,
  type ResourceTransferTask,
} from "@/runtime/logistics/resourceTransferTasks";
import { isHubOnlyReserveCompound } from "@/config/hub";
import { TREASURY_T3_LANE, TREASURY_T4_LANE, treasuryLaneTaskMatches } from "@/runtime/treasuryTerminalLane";
import {
  DEFAULT_CAPACITY_HEADROOM_POLICY,
  isReceiverAdmissionEligible,
  normalizeCapacityHeadroomPolicy,
  resolveCapacityState,
  type CapacityHeadroomPolicy,
  type CapacityState,
} from "@/runtime/logistics/capacityHeadroom";
import {
  createReceiverCapacityLedger,
  type ReceiverCapacityLedger,
  type ReceiverCapacityAvailability,
} from "@/runtime/logistics/receiverCapacityLedger";
import { LOGISTICS_CONTROL_STORE_LIMIT, resolveLogisticsControlConfig } from "@/runtime/logistics/logisticsControl";
import { type SynthesisShadowRoomFact } from "@/runtime/logistics/synthesisLogisticsShadow";
import { getTickContextService } from "@/runtime/runtimeServices";
import { normalizeNumber } from "@/runtime/configNormalize";
import {
  resolveRoomConfig,
  type ResourceControlRoomConfig,
  type ResourceThresholdMap,
} from "@/runtime/resourceControlRoomConfig";
import { getReservedProductionAmount, listProductionReservations } from "@/runtime/resourceReservation";
import { HUB_TARGET_COMPOUNDS } from "@/config/hub";
import {
  canTerminalSendPreserveMarketSaleExposure,
  compileLiveMarketSaleTerminalExposureIndex,
  getTerminalAmountOutsideMarketSaleExposure,
  getTerminalAmountsOutsideMarketSaleExposure,
  getMarketSaleTerminalExposure,
} from "@/runtime/marketSaleExposure";
import { getLocalCarrierDestinationCommittedAmount } from "@/runtime/localCarrierDestinationCapacity";
import { getTerminalActionEnergyOwnershipBudget } from "@/runtime/terminalActionEnergyOwnership";


export type ResourceControlState = "survival" | "balanced" | "export";
export type ResourceCapacityState = CapacityState;

export interface ResourceCapacityConfig extends CapacityHeadroomPolicy {
  maxPlannedAmountPerTask: number;
  maxNewTasksPerRun: number;
  automaticTaskNoProgressTtl: number;
  sourceDepletedGraceTicks: number;
  receiverCapacityDemandCoverageGraceTicks: number;
  t3ReservePerRoom: number;
}

export interface ResourceControlCapacityIndexBuildCounter {
  count: number;
}

export type TerminalStagingSuppressionReason =
  | "receiver_capacity"
  | "source_depleted"
  | "source_inventory"
  | "fee_budget"
  | "terminal_headroom"
  | "window_limit"
  | "invalid_endpoint";

export type TerminalStickyHeadroomReason =
  | "storage_full"
  | "protected_inventory"
  | "carrier_backlog"
  | "no_offloadable_resource";

export interface TerminalStagingObservation {
  admittedAmount: number;
  admittedTaskCount: number;
  admittedByResource: Partial<Record<ResourceConstant, number>>;
  suppressedCount: number;
  suppressedByReason: Partial<Record<TerminalStagingSuppressionReason, number>>;
}

interface TerminalRecoveryObservation {
  desiredTerminalFreeCapacity: number;
  terminalRecoveryGap: number;
  recoverableOffloadAmount: number;
  stickyHeadroom: boolean;
  stickyHeadroomReason?: TerminalStickyHeadroomReason;
}

export interface ResourceControlTransferContext {
  marketCargoTargets?: Map<string, { resource: ResourceConstant; targetStock: number }>;
  marketSellingResources?: Set<ResourceConstant>;
  tasks: ResourceTransferTask[];
  taskById: Map<string, ResourceTransferTask>;
  snapshotByRoom: Map<string, ResourceControlSnapshot>;
  receiverCapacityLedger: ReceiverCapacityLedger;
  healthyOutgoingByRoomResource: Map<string, number>;
  healthyIncomingByRoomResource: Map<string, number>;
  outgoingFeeByRoom: Map<string, number>;
  outgoingFeeByTaskId: Map<string, number>;
  healthyIncomingEnergyRooms: Set<string>;
  healthyIncomingEnergyRoomRefCount: Map<string, number>;
  reservedProductionByRoomResource: Map<string, number>;
  carrierProductionByRoomResource: Map<string, number>;
  existingTerminalOffloadCreatedAtByRoomTaskId: Map<
    string,
    Map<string, number>
  >;
  previousTerminalFreeCapacityByRoom: Map<string, number>;
  stagingObservationByRoom: Map<string, TerminalStagingObservation>;
  terminalRecoveryObservationByRoom: Map<string, TerminalRecoveryObservation>;
  taskContributionById: Map<string, ResourceControlTransferTaskContribution>;
  taskContributionIndex: ResourceControlTaskContributionIndexProbe;
  marketEnergyReadinessByRoom: Map<
    string,
    MarketTerminalEnergyReadinessObservation
  >;
}

export type ResourceControlCommitmentReadContext = Pick<
  ResourceControlTransferContext,
  | "taskById"
  | "snapshotByRoom"
  | "healthyOutgoingByRoomResource"
  | "outgoingFeeByRoom"
  | "outgoingFeeByTaskId"
  | "reservedProductionByRoomResource"
  | "carrierProductionByRoomResource"
> & {
  receiverCapacityLedger: Pick<ReceiverCapacityLedger, "getAvailability">;
  marketCargoTargets?: Map<string, { resource: ResourceConstant; targetStock: number }>;
  marketSellingResources?: Set<ResourceConstant>;
};

interface SynthesisShadowCaptureContext
  extends ResourceControlCommitmentReadContext {
  readonly tasks: ResourceTransferTask[];
  readonly indexBuildCount: 1;
  readonly productionReservationScanCount: 1;
  readonly invalidRecordCount: number;
}

interface ResourceControlTransferTaskContribution {
  readonly outgoingKey?: string;
  readonly outgoingAmount?: number;
  readonly incomingKey?: string;
  readonly incomingAmount?: number;
  readonly outgoingFeeRoomName?: string;
  readonly outgoingFee?: number;
  readonly incomingEnergyRoomName?: string;
}

export interface ResourceControlTaskContributionIndexProbe {
  initialTaskCount: number;
  syncCount: number;
  contributionEvaluationCount: number;
  productionReservationScanCount: number;
  productionReservationRecordCount: number;
  invalidProductionReservationCount: number;
}

export type MarketTerminalEnergyReadinessBlocker =
  | "not_authorized"
  | "authorization_invalid"
  | "authorization_expired"
  | "terminal_changed"
  | "capacity_emergency"
  | "terminal_claimed"
  | "terminal_headroom"
  | "storage_energy_floor"
  | "production_energy_ownership"
  | "terminal_capacity"
  | "energy_offload_conflict"
  | "draft_invalid";

export interface MarketTerminalEnergyReadinessContribution {
  id: string;
  amount: number;
  kind:
    | "ordinary_terminal_target"
    | "pending_energy_send"
    | "pending_internal_send_fee"
    | "terminal_production_commitment";
}

export interface MarketTerminalEnergyReadinessObservation {
  schemaVersion: 3;
  revision: string;
  observedAt: number;
  expiresAt: number;
  authorizationRevision?: string;
  roomInstanceId?: string;
  terminalId: string;
  authorized: boolean;
  effectivePostDealEnergyReserve: number;
  marketTerminalEnergyTarget: number;
  ordinaryTerminalEnergyTarget: number;
  unresolvedEnergySendAmount: number;
  unresolvedInternalSendFees: number;
  terminalScopedProductionEnergyCommitments: number;
  maxTransactionEnergy: number;
  contributionCount: number;
  contributions: MarketTerminalEnergyReadinessContribution[];
  desiredTerminalEnergy: number;
  plannedFeedAmount: number;
  status: "blocked" | "ready" | "feed_planned";
  blocker?: MarketTerminalEnergyReadinessBlocker;
}

export interface LogisticsShadowSelfExclusion {
  outgoingByRoomResource: Map<string, number>;
  incomingByRoomResource: Map<string, number>;
  incomingByRoom: Map<string, number>;
  feeByRoom: Map<string, number>;
}

interface LogisticsShadowCapturedSourceFacts {
  actionEnergyBudgetByRoom: ReadonlyMap<string, number>;
  sourceAvailableByRoomResource: ReadonlyMap<string, number>;
  terminalOutsideExposureByRoomResource: ReadonlyMap<string, number>;
}

export interface ResourceControlSnapshot {
  roomName: string;
  state: ResourceControlState;
  capacityState: ResourceCapacityState;
  storageUsedCapacity: number;
  storageFreeCapacity: number;
  terminalUsedCapacity: number;
  terminalFreeCapacity: number;
  storageEnergy: number;
  terminalEnergy: number;
  energyFloor: number;
  energyTarget: number;
  energyExportStart: number;
  terminalEnergyReserve: number;
  transferBatchSize: number;
  terminalCooldown?: number;
  storageResourceAmounts?: Partial<Record<ResourceConstant, number>>;
  terminalResourceAmounts?: Partial<Record<ResourceConstant, number>>;
  nativeMineralType?: MineralConstant;
  canMineNative: boolean;
  mineralFloor: ResourceThresholdMap;
  mineralExportStart: ResourceThresholdMap;
  storage?: StructureStorage;
  terminal: StructureTerminal;
}

const DEFAULT_INTERVAL = 10;
const MIN_INTERVAL = 5;
const MAX_INTERVAL = 100;
export const RESOURCE_CONTROL_TERMINAL_FEED_PRODUCER = "resourceControl:preload";
export const TERMINAL_STORAGE_CAPACITY = 300_000;
// 新恢复路径为 normal 房间预留默认 20k 的可承诺接收窗口：
// 60k 日常空闲 - 40k 默认 receiver 账本安全保留。
const NORMAL_TERMINAL_TARGET_FREE_CAPACITY = 60_000;
// 关闭 terminalHeadroomRecoveryEnabled 时保留的 legacy 使用量阈值。
export const TERMINAL_TOTAL_STORAGE_CAP = 250_000;
const DEFAULT_CAPACITY_CONFIG: ResourceCapacityConfig = {
  ...DEFAULT_CAPACITY_HEADROOM_POLICY,
  maxPlannedAmountPerTask: 50_000,
  maxNewTasksPerRun: 5,
  automaticTaskNoProgressTtl: 5_000,
  sourceDepletedGraceTicks: 100,
  receiverCapacityDemandCoverageGraceTicks:
    DEFAULT_RECEIVER_CAPACITY_DEMAND_COVERAGE_GRACE_TICKS,
  t3ReservePerRoom: 5_000,
};

export function normalizeInterval(value: unknown): number {
  return normalizeNumber(value, DEFAULT_INTERVAL, MIN_INTERVAL, MAX_INTERVAL);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeCapacityConfig(
  value: unknown,
): ResourceCapacityConfig {
  const raw =
    value && typeof value === "object"
      ? (value as Partial<ResourceCapacityConfig>)
      : {};
  return {
    ...normalizeCapacityHeadroomPolicy(raw),
    maxPlannedAmountPerTask: normalizeNumber(
      raw.maxPlannedAmountPerTask,
      DEFAULT_CAPACITY_CONFIG.maxPlannedAmountPerTask,
      100,
      300_000,
    ),
    maxNewTasksPerRun: normalizeNumber(
      raw.maxNewTasksPerRun,
      DEFAULT_CAPACITY_CONFIG.maxNewTasksPerRun,
      1,
      5,
    ),
    automaticTaskNoProgressTtl: normalizeNumber(
      raw.automaticTaskNoProgressTtl,
      DEFAULT_CAPACITY_CONFIG.automaticTaskNoProgressTtl,
      100,
      100_000,
    ),
    sourceDepletedGraceTicks: normalizeNumber(
      raw.sourceDepletedGraceTicks,
      DEFAULT_CAPACITY_CONFIG.sourceDepletedGraceTicks,
      1,
      5_000,
    ),
    receiverCapacityDemandCoverageGraceTicks: normalizeNumber(
      raw.receiverCapacityDemandCoverageGraceTicks,
      DEFAULT_CAPACITY_CONFIG.receiverCapacityDemandCoverageGraceTicks,
      50,
      5_000,
    ),
    t3ReservePerRoom: normalizeNumber(
      raw.t3ReservePerRoom,
      DEFAULT_CAPACITY_CONFIG.t3ReservePerRoom,
      0,
      500_000,
    ),
  };
}

export function resolveCapacityConfig(): ResourceCapacityConfig {
  return normalizeCapacityConfig(
    Memory.cfg?.resourceControl?.capacityBalancing,
  );
}

export function getResourceControlSampleInterval(): number {
  return normalizeInterval(Memory.cfg?.resourceControl?.sampleInterval);
}

export function isResourceControlFullPlanningTick(): boolean {
  return isDue("resourceControl.plan", getResourceControlSampleInterval());
}

function resolveState(
  storageEnergy: number,
  config: ResourceControlRoomConfig,
): ResourceControlState {
  if (storageEnergy < config.energyFloor) {
    return "survival";
  }
  if (storageEnergy >= config.energyExportStart) {
    return "export";
  }
  return "balanced";
}

let emptyResourceAmounts: Partial<Record<ResourceConstant, number>> | undefined;
export function collectResourceControlSnapshots(
  capturedResources?: readonly ResourceConstant[],
  liveRooms?: readonly Room[],
): ResourceControlSnapshot[] {
  const rooms = (liveRooms ?? getTickContextService().getMyRooms()).filter((room) => !!room.terminal);
  const capacityConfig = resolveCapacityConfig();

  return rooms.map((room) => {
    const config = resolveRoomConfig(room.name);
    const storageEnergy =
      room.storage?.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    const terminalEnergy =
      room.terminal?.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    const storageUsedCapacity = room.storage?.store.getUsedCapacity() || 0;
    const storageFreeCapacity = room.storage?.store.getFreeCapacity() || 0;
    const terminalUsedCapacity = room.terminal?.store.getUsedCapacity() || 0;
    const terminalFreeCapacity = room.terminal?.store.getFreeCapacity() || 0;
    const storageResourceAmounts: Partial<
      Record<ResourceConstant, number>
    > = {};
    emptyResourceAmounts ??= Object.fromEntries(RESOURCES_ALL.map(resource => [resource, 0]));
    const terminalResourceAmounts: Partial<Record<ResourceConstant, number>> = capturedResources ? {} : { ...emptyResourceAmounts };
    const storedResources = Object.keys(room.terminal!.store).filter(key => RESOURCES_ALL.includes(key as ResourceConstant)) as ResourceConstant[];
    const snapshotResources = capturedResources ?? (storedResources.length > 0 || terminalUsedCapacity === 0
      ? [...new Set<ResourceConstant>([RESOURCE_ENERGY, ...storedResources])] : RESOURCES_ALL);
    for (const resource of snapshotResources) {
      terminalResourceAmounts[resource] =
        resource === RESOURCE_ENERGY
          ? terminalEnergy
          : room.terminal?.store.getUsedCapacity(resource) || 0;
      if (capturedResources) {
        storageResourceAmounts[resource] =
          resource === RESOURCE_ENERGY
            ? storageEnergy
            : room.storage?.store.getUsedCapacity(resource) || 0;
      }
    }
    const previousCapacityState =
      Memory.runtime?.resourceControl?.rooms?.[room.name]?.capacityState;
    const mineral = room.find(FIND_MINERALS)[0] || null;
    const extractor = getTickContextService().getRoomContext(room)?.getMyStructures().find(
      structure => structure.structureType === STRUCTURE_EXTRACTOR,
    ) as StructureExtractor | undefined;

    return {
      roomName: room.name,
      state: resolveState(storageEnergy, config),
      capacityState: room.storage
        ? resolveCapacityState(
            storageFreeCapacity,
            terminalFreeCapacity,
            capacityConfig,
            previousCapacityState,
          )
        : "normal",
      storageUsedCapacity,
      storageFreeCapacity,
      terminalUsedCapacity,
      terminalFreeCapacity,
      storageEnergy,
      terminalEnergy,
      energyFloor: config.energyFloor,
      energyTarget: config.energyTarget,
      energyExportStart: config.energyExportStart,
      terminalEnergyReserve: config.terminalEnergyReserve,
      transferBatchSize: config.transferBatchSize,
      terminalResourceAmounts,
      ...(capturedResources
        ? {
            terminalCooldown: room.terminal?.cooldown || 0,
            storageResourceAmounts,
          }
        : {}),
      nativeMineralType: mineral?.mineralType,
      canMineNative: !!mineral && !!extractor,
      mineralFloor: config.mineralFloor,
      mineralExportStart: config.mineralExportStart,
      storage: room.storage || undefined,
      terminal: room.terminal as StructureTerminal,
    };
  });
}

export function getTerminalResourceAmount(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
): number {
  const projected = snapshot.terminalResourceAmounts?.[resource];
  return typeof projected === "number"
    ? projected
    : snapshot.terminal.store.getUsedCapacity(resource);
}

export function getStorageResourceAmount(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
): number {
  const projected = snapshot.storageResourceAmounts?.[resource];
  return typeof projected === "number"
    ? projected
    : snapshot.storage?.store.getUsedCapacity(resource) || 0;
}

export function getStock(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
): number {
  if (resource === RESOURCE_ENERGY) {
    return snapshot.storageEnergy + snapshot.terminalEnergy;
  }
  return (
    getStorageResourceAmount(snapshot, resource) +
    getTerminalResourceAmount(snapshot, resource)
  );
}

export function roomResourceKey(roomName: string, resource: ResourceConstant): string {
  return `${roomName}:${resource}`;
}

export function createTerminalStagingObservation(): TerminalStagingObservation {
  return {
    admittedAmount: 0,
    admittedTaskCount: 0,
    admittedByResource: {},
    suppressedCount: 0,
    suppressedByReason: {},
  };
}

export function createResourceControlTransferContext(
  snapshots: ResourceControlSnapshot[],
  capacityConfig: ResourceCapacityConfig,
  buildCounter: ResourceControlCapacityIndexBuildCounter,
  options: { readonlyCarrierBoard?: boolean } = {},
): ResourceControlTransferContext {
  buildCounter.count += 1;
  const tasks = getResourceTransferTaskListSorted();
  const taskById = new Map(tasks.map((task) => [task.id, task] as const));
  const snapshotByRoom = new Map(
    snapshots.map((snapshot) => [snapshot.roomName, snapshot] as const),
  );
  const healthyOutgoingByRoomResource = new Map<string, number>();
  const healthyIncomingByRoomResource = new Map<string, number>();
  const outgoingFeeByRoom = new Map<string, number>();
  const outgoingFeeByTaskId = new Map<string, number>();
  const healthyIncomingEnergyRooms = new Set<string>();
  const healthyIncomingEnergyRoomRefCount = new Map<string, number>();
  const reservedProductionByRoomResource = new Map<string, number>();
  const carrierProductionByRoomResource = new Map<string, number>();
  const existingTerminalOffloadCreatedAtByRoomTaskId = new Map<
    string,
    Map<string, number>
  >();
  const previousTerminalFreeCapacityByRoom = new Map<string, number>();
  const stagingObservationByRoom = new Map<
    string,
    TerminalStagingObservation
  >();
  const terminalRecoveryObservationByRoom = new Map<
    string,
    TerminalRecoveryObservation
  >();
  const taskContributionById = new Map<
    string,
    ResourceControlTransferTaskContribution
  >();
  const taskContributionIndex: ResourceControlTaskContributionIndexProbe = {
    initialTaskCount: tasks.length,
    syncCount: 0,
    contributionEvaluationCount: 0,
    productionReservationScanCount: 1,
    productionReservationRecordCount: 0,
    invalidProductionReservationCount: 0,
  };
  const productionReservations = listProductionReservations();
  taskContributionIndex.productionReservationRecordCount =
    productionReservations.length;
  for (const reservation of productionReservations) {
    if (reservation.expiresAt < Game.time) continue;
    const key = roomResourceKey(reservation.roomName, reservation.resource);
    if (
      !Number.isSafeInteger(reservation.amount) ||
      reservation.amount <= 0
    ) {
      taskContributionIndex.invalidProductionReservationCount += 1;
    }
    const previousAmount = reservedProductionByRoomResource.has(key)
      ? reservedProductionByRoomResource.get(key)!
      : 0;
    reservedProductionByRoomResource.set(
      key,
      previousAmount + reservation.amount,
    );
  }
  const marketEnergyReadinessByRoom = new Map<
    string,
    MarketTerminalEnergyReadinessObservation
  >();
  const receiverCapacityLedger = createReceiverCapacityLedger({
    receivers: snapshots
      .filter((snapshot) => !!snapshot.storage)
      .map((snapshot) => ({
        roomName: snapshot.roomName,
        storageFreeCapacity: snapshot.storageFreeCapacity,
        terminalFreeCapacity: snapshot.terminalFreeCapacity,
        getTerminalResourceFreeCapacity: (resource: ResourceConstant) =>
          getReceiverTerminalFreeCapacity(snapshot, resource),
      })),
    tasks,
    storageSafetyReserve: capacityConfig.storagePressureFreeCapacity,
    terminalSafetyReserve: capacityConfig.terminalPressureFreeCapacity,
    isTaskEndpointValid: (task) =>
      !!snapshotByRoom.get(task.fromRoomName)?.storage &&
      !!snapshotByRoom.get(task.toRoomName)?.storage,
    isTaskHealthy: (task) =>
      isHealthyReceiverCapacityCommitment(
        task,
        capacityConfig.automaticTaskNoProgressTtl,
      ),
  });

  for (const snapshot of snapshots) {
    const previousTerminalFreeCapacity =
      Memory.runtime?.resourceControl?.rooms[snapshot.roomName]
        ?.terminalFreeCapacity;
    if (typeof previousTerminalFreeCapacity === "number") {
      previousTerminalFreeCapacityByRoom.set(
        snapshot.roomName,
        previousTerminalFreeCapacity,
      );
    }
    stagingObservationByRoom.set(
      snapshot.roomName,
      createTerminalStagingObservation(),
    );
    const carrierTasks = options.readonlyCarrierBoard
      ? peekCarrierTasksByRoom(snapshot.roomName).map((entry) => entry.task)
      : listCarrierTasksByRoom(snapshot.roomName);
    for (const task of carrierTasks) {
      if (
        task.producer === RESOURCE_CONTROL_TERMINAL_FEED_PRODUCER &&
        task.type === "terminal_offload"
      ) {
        const offloadsByTaskId =
          existingTerminalOffloadCreatedAtByRoomTaskId.get(snapshot.roomName) ||
          new Map<string, number>();
        offloadsByTaskId.set(task.id, task.createdAt);
        existingTerminalOffloadCreatedAtByRoomTaskId.set(
          snapshot.roomName,
          offloadsByTaskId,
        );
      }
      if (task.type !== "lab_supply" && task.type !== "factory_supply")
        continue;
      for (const step of task.steps) {
        if (step.fromKind !== "storage" && step.fromKind !== "terminal")
          continue;
        const key = roomResourceKey(snapshot.roomName, step.resource);
        carrierProductionByRoomResource.set(
          key,
          (carrierProductionByRoomResource.get(key) || 0) + step.amount,
        );
      }
    }
  }

  const context: ResourceControlTransferContext = {
    tasks,
    taskById,
    snapshotByRoom,
    receiverCapacityLedger,
    healthyOutgoingByRoomResource,
    healthyIncomingByRoomResource,
    outgoingFeeByRoom,
    outgoingFeeByTaskId,
    healthyIncomingEnergyRooms,
    healthyIncomingEnergyRoomRefCount,
    reservedProductionByRoomResource,
    carrierProductionByRoomResource,
    existingTerminalOffloadCreatedAtByRoomTaskId,
    previousTerminalFreeCapacityByRoom,
    stagingObservationByRoom,
    terminalRecoveryObservationByRoom,
    taskContributionById,
    taskContributionIndex,
    marketEnergyReadinessByRoom,
  };
  for (const task of tasks) {
    const contribution = deriveResourceControlTransferTaskContribution(
      context,
      task,
    );
    context.taskContributionById.set(task.id, contribution);
    applyResourceControlTransferTaskContribution(
      context,
      task.id,
      contribution,
      1,
    );
  }
  return context;
}

/**
 * 写前 Shadow 只需要不可变 commitment/headroom 读模型，不需要 executor
 * 的 staging/recovery/market-readiness bookkeeping。这里让 task、reservation
 * 与 Carrier board 各只经过一次只读 pass；正式 ResourceControl phase 仍会
 * 在后续 production phases 之后重建完整 context，绝不复用这份写前状态执行。
 */
function isValidSynthesisShadowCaptureTask(
  value: unknown,
): value is ResourceTransferTask {
  if (!isPlainRecord(value)) return false;
  const amount = value.amount;
  const remainingAmount = value.remainingAmount;
  const status = value.status;
  const origin = value.origin;
  return (
    typeof value.id === "string" && value.id.length > 0 &&
    typeof value.fromRoomName === "string" && value.fromRoomName.length > 0 &&
    typeof value.toRoomName === "string" && value.toRoomName.length > 0 &&
    value.fromRoomName !== value.toRoomName &&
    typeof value.resource === "string" &&
    RESOURCES_ALL.includes(value.resource as ResourceConstant) &&
    Number.isSafeInteger(amount) && (amount as number) > 0 &&
    Number.isSafeInteger(remainingAmount) &&
    (remainingAmount as number) >= 0 &&
    (remainingAmount as number) <= (amount as number) &&
    (status === "pending" || status === "done" ||
      status === "cancelled" || status === "failed") &&
    (origin === "manual" || origin === "automatic") &&
    Number.isSafeInteger(value.createdAt) && (value.createdAt as number) >= 0 &&
    Number.isSafeInteger(value.updatedAt) && (value.updatedAt as number) >= 0 &&
    Number.isSafeInteger(value.lastProgressAt) &&
    (value.lastProgressAt as number) >= 0 &&
    (value.reason === undefined || typeof value.reason === "string") &&
    (value.lastError === undefined || typeof value.lastError === "string") &&
    (value.blockedReason === undefined ||
      value.blockedReason === "receiver_capacity" ||
      value.blockedReason === "source_depleted" ||
      value.blockedReason === "insufficient_terminal_resource_or_fee") &&
    (value.blockedSince === undefined ||
      (Number.isSafeInteger(value.blockedSince) &&
        (value.blockedSince as number) >= 0))
  );
}

function createSynthesisShadowCaptureContext(
  snapshots: ResourceControlSnapshot[],
  capacityConfig: ResourceCapacityConfig,
  buildCounter: ResourceControlCapacityIndexBuildCounter,
): SynthesisShadowCaptureContext {
  buildCounter.count += 1;
  let taskReadFailed = false;
  let tasks: ResourceTransferTask[] = [];
  try {
    tasks = getResourceTransferTaskListSorted();
  } catch {
    taskReadFailed = true;
  }
  const snapshotByRoom = new Map(
    snapshots.map((snapshot) => [snapshot.roomName, snapshot] as const),
  );
  const healthyOutgoingByRoomResource = new Map<string, number>();
  const healthyIncomingByRoomResource = new Map<string, number>();
  const healthyIncomingTotalByRoom = new Map<string, number>();
  const outgoingFeeByRoom = new Map<string, number>();
  const outgoingFeeByTaskId = new Map<string, number>();
  const reservedProductionByRoomResource = new Map<string, number>();
  const carrierProductionByRoomResource = new Map<string, number>();
  let invalidRecordCount = taskReadFailed ? 1 : 0;
  const seenTaskIds = new Set<string>();
  const validTasks: ResourceTransferTask[] = [];
  for (const task of tasks as unknown[]) {
    if (
      !isValidSynthesisShadowCaptureTask(task) ||
      seenTaskIds.has(task.id)
    ) {
      invalidRecordCount += 1;
      continue;
    }
    seenTaskIds.add(task.id);
    validTasks.push(task);
  }
  const taskById = new Map(
    validTasks.map((task) => [task.id, task] as const),
  );

  let productionReservations: ReturnType<typeof listProductionReservations> = [];
  try {
    productionReservations = listProductionReservations();
  } catch {
    invalidRecordCount += 1;
  }
  for (const reservation of productionReservations as readonly unknown[]) {
    if (
      !isPlainRecord(reservation) ||
      typeof reservation.roomName !== "string" ||
      reservation.roomName.length === 0 ||
      typeof reservation.resource !== "string" ||
      !RESOURCES_ALL.includes(reservation.resource as ResourceConstant) ||
      typeof reservation.holderId !== "string" ||
      reservation.holderId.length === 0 ||
      !Number.isSafeInteger(reservation.updatedAt) ||
      !Number.isSafeInteger(reservation.expiresAt) ||
      (reservation.updatedAt as number) < 0 ||
      (reservation.expiresAt as number) < 0 ||
      !Number.isSafeInteger(reservation.amount) ||
      (reservation.amount as number) <= 0
    ) {
      invalidRecordCount += 1;
      continue;
    }
    if ((reservation.expiresAt as number) < Game.time) continue;
    const key = roomResourceKey(
      reservation.roomName,
      reservation.resource as ResourceConstant,
    );
    reservedProductionByRoomResource.set(
      key,
      (reservedProductionByRoomResource.get(key) || 0) +
        (reservation.amount as number),
    );
  }

  for (const snapshot of snapshots) {
    let carrierEntries: readonly unknown[];
    try {
      carrierEntries = peekCarrierTasksByRoom(snapshot.roomName) as readonly unknown[];
    } catch {
      invalidRecordCount += 1;
      continue;
    }
    for (const entry of carrierEntries) {
      if (!isPlainRecord(entry)) {
        invalidRecordCount += 1;
        continue;
      }
      const task = entry.task;
      if (!isPlainRecord(task) || typeof task.type !== "string") {
        invalidRecordCount += 1;
        continue;
      }
      if (task.type !== "lab_supply" && task.type !== "factory_supply") {
        continue;
      }
      if (!Array.isArray(task.steps)) {
        invalidRecordCount += 1;
        continue;
      }
      const productionSteps: Array<{
        fromKind: "storage" | "terminal";
        resource: ResourceConstant;
        amount: number;
      }> = [];
      let taskValid = true;
      for (const step of task.steps) {
        if (!isPlainRecord(step)) {
          taskValid = false;
          break;
        }
        if (step.fromKind !== "storage" && step.fromKind !== "terminal") {
          continue;
        }
        if (
          typeof step.resource !== "string" ||
          !RESOURCES_ALL.includes(step.resource as ResourceConstant) ||
          !Number.isSafeInteger(step.amount) ||
          (step.amount as number) <= 0
        ) {
          taskValid = false;
          break;
        }
        productionSteps.push({
          fromKind: step.fromKind,
          resource: step.resource as ResourceConstant,
          amount: step.amount as number,
        });
      }
      if (!taskValid) {
        invalidRecordCount += 1;
        continue;
      }
      for (const step of productionSteps) {
        const key = roomResourceKey(snapshot.roomName, step.resource);
        carrierProductionByRoomResource.set(
          key,
          (carrierProductionByRoomResource.get(key) || 0) + step.amount,
        );
      }
    }
  }

  for (const task of validTasks) {
    if (isHealthyResourceTransferTaskReservation(task, "outgoing")) {
      const outgoingKey = roomResourceKey(task.fromRoomName, task.resource);
      adjustIndexedAmount(
        healthyOutgoingByRoomResource,
        outgoingKey,
        task.remainingAmount,
      );
      const source = snapshotByRoom.get(task.fromRoomName);
      const batchAmount = source
        ? Math.min(source.transferBatchSize, task.remainingAmount)
        : 0;
      if (batchAmount > 0) {
        let fee: number;
        try {
          fee = Game.market.calcTransactionCost(
            batchAmount,
            task.fromRoomName,
            task.toRoomName,
          );
        } catch {
          invalidRecordCount += 1;
          continue;
        }
        if (!Number.isSafeInteger(fee) || fee < 0) {
          invalidRecordCount += 1;
          continue;
        }
        if (fee > 0) {
          adjustIndexedAmount(outgoingFeeByRoom, task.fromRoomName, fee);
          outgoingFeeByTaskId.set(task.id, fee);
        }
      }
    }
    const source = snapshotByRoom.get(task.fromRoomName);
    const receiver = snapshotByRoom.get(task.toRoomName);
    if (
      !source?.storage ||
      !receiver?.storage ||
      !isHealthyReceiverCapacityCommitment(
        task,
        capacityConfig.automaticTaskNoProgressTtl,
      )
    ) {
      continue;
    }
    const amount = Math.max(0, Math.floor(task.remainingAmount));
    if (amount <= 0) continue;
    const incomingKey = roomResourceKey(task.toRoomName, task.resource);
    adjustIndexedAmount(healthyIncomingByRoomResource, incomingKey, amount);
    adjustIndexedAmount(healthyIncomingTotalByRoom, task.toRoomName, amount);
  }

  const receiverCapacityLedger: Pick<
    ReceiverCapacityLedger,
    "getAvailability"
  > = {
    getAvailability(
      roomName: string,
      resource: ResourceConstant,
    ): ReceiverCapacityAvailability {
      const snapshot = snapshotByRoom.get(roomName);
      if (!snapshot?.storage) {
        return {
          roomName,
          resource,
          storageSafeCapacity: 0,
          terminalTotalSafeCapacity: 0,
          terminalResourceFreeCapacity: 0,
          totalCommitted: 0,
          resourceCommitted: 0,
          reservationTotal: 0,
          reservationResource: 0,
          ownedReservationTotal: 0,
          ownedReservationResource: 0,
          excludedTaskAmount: 0,
          storageRemaining: 0,
          terminalTotalRemaining: 0,
          terminalResourceRemaining: 0,
          available: 0,
        };
      }
      const storageSafeCapacity = Math.max(
        0,
        Math.floor(snapshot.storageFreeCapacity) -
          capacityConfig.storagePressureFreeCapacity,
      );
      const terminalTotalSafeCapacity = Math.max(
        0,
        Math.floor(snapshot.terminalFreeCapacity) -
          capacityConfig.terminalPressureFreeCapacity,
      );
      const terminalResourceFreeCapacity = Math.max(
        0,
        Math.floor(getReceiverTerminalFreeCapacity(snapshot, resource)),
      );
      const totalCommitted =
        healthyIncomingTotalByRoom.get(roomName) || 0;
      const resourceCommitted =
        healthyIncomingByRoomResource.get(roomResourceKey(roomName, resource)) ||
        0;
      const storageRemaining = Math.max(
        0,
        storageSafeCapacity - totalCommitted,
      );
      const terminalTotalRemaining = Math.max(
        0,
        terminalTotalSafeCapacity - totalCommitted,
      );
      const terminalResourceRemaining = Math.max(
        0,
        terminalResourceFreeCapacity - resourceCommitted,
      );
      return {
        roomName,
        resource,
        storageSafeCapacity,
        terminalTotalSafeCapacity,
        terminalResourceFreeCapacity,
        totalCommitted,
        resourceCommitted,
        reservationTotal: 0,
        reservationResource: 0,
        ownedReservationTotal: 0,
        ownedReservationResource: 0,
        excludedTaskAmount: 0,
        storageRemaining,
        terminalTotalRemaining,
        terminalResourceRemaining,
        available: Math.min(
          storageRemaining,
          terminalTotalRemaining,
          terminalResourceRemaining,
        ),
      };
    },
  };

  return {
    tasks: validTasks,
    taskById,
    snapshotByRoom,
    receiverCapacityLedger,
    healthyOutgoingByRoomResource,
    outgoingFeeByRoom,
    outgoingFeeByTaskId,
    reservedProductionByRoomResource,
    carrierProductionByRoomResource,
    indexBuildCount: 1,
    productionReservationScanCount: 1,
    invalidRecordCount,
  };
}

function adjustIndexedAmount(
  index: Map<string, number>,
  key: string,
  delta: number,
): void {
  const amount = Math.max(0, (index.get(key) || 0) + delta);
  if (amount > 0) {
    index.set(key, amount);
  } else {
    index.delete(key);
  }
}

export function deriveResourceControlTransferTaskContribution(
  context: ResourceControlTransferContext,
  task: ResourceTransferTask,
): ResourceControlTransferTaskContribution {
  context.taskContributionIndex.contributionEvaluationCount += 1;
  const contribution: {
    outgoingKey?: string;
    outgoingAmount?: number;
    incomingKey?: string;
    incomingAmount?: number;
    outgoingFeeRoomName?: string;
    outgoingFee?: number;
    incomingEnergyRoomName?: string;
  } = {};

  if (isHealthyResourceTransferTaskReservation(task, "outgoing")) {
    contribution.outgoingKey = roomResourceKey(
      task.fromRoomName,
      task.resource,
    );
    contribution.outgoingAmount = task.remainingAmount;
    const source = context.snapshotByRoom.get(task.fromRoomName);
    const batchAmount = source
      ? Math.min(source.transferBatchSize, task.remainingAmount)
      : 0;
    if (batchAmount > 0) {
      contribution.outgoingFeeRoomName = task.fromRoomName;
      contribution.outgoingFee = Game.market.calcTransactionCost(
        batchAmount,
        task.fromRoomName,
        task.toRoomName,
      );
    }
  }
  if (isHealthyResourceTransferTaskReservation(task, "incoming")) {
    contribution.incomingKey = roomResourceKey(task.toRoomName, task.resource);
    contribution.incomingAmount = task.remainingAmount;
    if (task.resource === RESOURCE_ENERGY) {
      contribution.incomingEnergyRoomName = task.toRoomName;
    }
  }

  return Object.freeze(contribution);
}

export function applyResourceControlTransferTaskContribution(
  context: ResourceControlTransferContext,
  taskId: string,
  contribution: ResourceControlTransferTaskContribution,
  direction: 1 | -1,
): void {
  if (contribution.outgoingKey && contribution.outgoingAmount) {
    adjustIndexedAmount(
      context.healthyOutgoingByRoomResource,
      contribution.outgoingKey,
      direction * contribution.outgoingAmount,
    );
  }
  if (contribution.incomingKey && contribution.incomingAmount) {
    adjustIndexedAmount(
      context.healthyIncomingByRoomResource,
      contribution.incomingKey,
      direction * contribution.incomingAmount,
    );
  }
  if (contribution.outgoingFeeRoomName && contribution.outgoingFee) {
    adjustIndexedAmount(
      context.outgoingFeeByRoom,
      contribution.outgoingFeeRoomName,
      direction * contribution.outgoingFee,
    );
    if (direction > 0) {
      context.outgoingFeeByTaskId.set(taskId, contribution.outgoingFee);
    } else {
      context.outgoingFeeByTaskId.delete(taskId);
    }
  } else if (direction < 0) {
    context.outgoingFeeByTaskId.delete(taskId);
  }
  if (contribution.incomingEnergyRoomName) {
    adjustIndexedAmount(
      context.healthyIncomingEnergyRoomRefCount,
      contribution.incomingEnergyRoomName,
      direction,
    );
    if (
      (context.healthyIncomingEnergyRoomRefCount.get(
        contribution.incomingEnergyRoomName,
      ) || 0) > 0
    ) {
      context.healthyIncomingEnergyRooms.add(
        contribution.incomingEnergyRoomName,
      );
    } else {
      context.healthyIncomingEnergyRooms.delete(
        contribution.incomingEnergyRoomName,
      );
    }
  }
}

export function getOutgoingTransactionFeeReserve(
  snapshot: ResourceControlSnapshot,
  context: ResourceControlCommitmentReadContext,
  excludeTaskId?: string,
): number {
  return Math.max(
    0,
    (context.outgoingFeeByRoom.get(snapshot.roomName) || 0) -
      (excludeTaskId ? context.outgoingFeeByTaskId.get(excludeTaskId) || 0 : 0),
  );
}

export function getProductionCommitmentAmount(
  roomName: string,
  resource: ResourceConstant,
  context: ResourceControlCommitmentReadContext,
): number {
  const key = roomResourceKey(roomName, resource);
  const reserved = context.reservedProductionByRoomResource.get(key);
  return (
    (reserved === undefined ? 0 : reserved) +
    (context.carrierProductionByRoomResource.get(key) || 0)
  );
}

/**
 * 已存在跨房动作的 Energy 所有权预算。
 *
 * 房间恢复水位只决定本地状态与无任务自动平衡策略，不属于库存所有权；
 * ordinary Terminal reserve、生产、其他 transfer 与市场 exposure 仍先扣除。
 */
export function getTerminalActionEnergyBudget(
  snapshot: ResourceControlSnapshot,
  context: ResourceControlCommitmentReadContext,
  excludeTaskId?: string,
  terminalEnergyOutsideMarketExposureOverride?: number,
): number {
  const terminalEnergyOutsideMarketExposure =
    terminalEnergyOutsideMarketExposureOverride ??
    getTerminalAmountOutsideMarketSaleExposure(
      snapshot.terminal,
      RESOURCE_ENERGY,
      snapshot.roomName,
    );
  const marketExposureOwnership = Math.max(
    0,
    snapshot.terminalEnergy - terminalEnergyOutsideMarketExposure,
  );
  return getTerminalActionEnergyOwnershipBudget({
    totalEnergy: getStock(snapshot, RESOURCE_ENERGY),
    ordinaryTerminalEnergyReserve: snapshot.terminalEnergyReserve,
    productionEnergyCommitment: getProductionCommitmentAmount(
      snapshot.roomName,
      RESOURCE_ENERGY,
      context,
    ),
    otherOutgoingEnergyCommitment: getHealthyOutgoingCommitment(
      snapshot.roomName,
      RESOURCE_ENERGY,
      context,
      excludeTaskId,
    ),
    otherOutgoingFeeCommitment: getOutgoingTransactionFeeReserve(
      snapshot,
      context,
      excludeTaskId,
    ),
    otherExplicitEnergyOwnership: marketExposureOwnership,
  });
}

export function getResourceControlRoomStock(
  room: Room,
  resource: ResourceConstant,
): number {
  let total = 0;
  if (room.storage) {
    total += room.storage.store.getUsedCapacity(resource);
  }
  if (room.terminal) {
    total += room.terminal.store.getUsedCapacity(resource);
  }

  const consumers = room.find(FIND_MY_STRUCTURES, {
    filter: (structure) =>
      structure.structureType === STRUCTURE_LAB ||
      structure.structureType === STRUCTURE_FACTORY ||
      structure.structureType === STRUCTURE_POWER_SPAWN,
  }) as AnyStoreStructure[];
  for (const structure of consumers) {
    total += structure.store.getUsedCapacity(resource) ?? 0;
  }

  return total;
}

export function getReceiverTerminalFreeCapacity(
  receiver: ResourceControlSnapshot,
  resource: ResourceConstant,
): number {
  const totalFree = receiver.terminal.store.getFreeCapacity();
  const resourceFree = receiver.terminal.store.getFreeCapacity(resource);
  if (typeof totalFree === "number" && typeof resourceFree === "number") {
    return Math.max(0, Math.min(totalFree, resourceFree));
  }
  if (typeof totalFree === "number") return Math.max(0, totalFree);
  return typeof resourceFree === "number" ? Math.max(0, resourceFree) : 0;
}

export function getHealthyOutgoingCommitment(
  roomName: string,
  resource: ResourceConstant,
  context: ResourceControlCommitmentReadContext,
  excludeTaskId?: string,
): number {
  let total =
    context.healthyOutgoingByRoomResource.get(
      roomResourceKey(roomName, resource),
    ) || 0;
  if (excludeTaskId) {
    const excluded = context.taskById.get(excludeTaskId);
    if (
      excluded?.fromRoomName === roomName &&
      excluded.resource === resource &&
      isHealthyResourceTransferTaskReservation(excluded, "outgoing")
    ) {
      total -= excluded.remainingAmount;
    }
  }
  return Math.max(0, total);
}

export function getProtectedResourceAmount(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
  config: ResourceCapacityConfig,
  context: ResourceControlCommitmentReadContext,
  excludeTaskId?: string,
): number {
  let safetyFloor = snapshot.mineralFloor[resource] || 0;
  const hub = Memory.cfg?.hub;
  const transfer = excludeTaskId ? context.taskById.get(excludeTaskId) : undefined;
  const isHubSupply = transfer?.reason?.startsWith("hub:export:") && !isHubOnlyReserveCompound(resource);
  if (hub?.enabled && hub.hubRoomName === snapshot.roomName && !isHubSupply) {
    if ((hub.targetCompounds ?? HUB_TARGET_COMPOUNDS).includes(resource)) safetyFloor = Math.max(safetyFloor,
      isHubOnlyReserveCompound(resource) ? hub.hubOnlyReservePerCompound ?? 50_000 : hub.hubReservePerCompound ?? 20_000);
    if (["H", "O", "U", "K", "L", "Z", "X", "G"].includes(resource)) safetyFloor = Math.max(safetyFloor, Memory.cfg?.factoryControl?.hub?.mineralFloor ?? 20_000);
  }
  if (HUB_TARGET_COMPOUNDS.includes(resource) && !isHubOnlyReserveCompound(resource)) {
    safetyFloor = Math.max(safetyFloor, config.t3ReservePerRoom);
  }
  const exposure = getMarketSaleTerminalExposure(snapshot.roomName, resource);
  if (exposure.blocked) return getStock(snapshot, resource);
  const cargo = context.marketCargoTargets?.get(snapshot.roomName);
  return safetyFloor + getProductionCommitmentAmount(snapshot.roomName, resource, context) +
    Math.max(exposure.reservedAmount, cargo?.resource === resource ? cargo.targetStock : 0);
}

export function getTotalMovableResourceAmount(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
  config: ResourceCapacityConfig,
  context: ResourceControlCommitmentReadContext,
  excludeTaskId?: string,
): number {
  if (resource === RESOURCE_ENERGY) {
    return getTerminalActionEnergyBudget(snapshot, context, excludeTaskId);
  }
  return Math.max(
    0,
    getStock(snapshot, resource) -
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
}

function readLogisticsShadowCpuUsed(): number | undefined {
  try {
    const used = Game.cpu?.getUsed?.();
    return typeof used === "number" && Number.isFinite(used) && used >= 0
      ? used
      : undefined;
  } catch {
    return undefined;
  }
}

function logisticsShadowHash(value: string): string {
  // FNV-1a 变体：每次迭代混合两个 UTF-16 码元，迭代与 imul 次数减半。
  // 哈希值只做单次部署内的逐 epoch 比较（不跨部署持久比对），算法变更
  // 仅在部署切换时使 epoch 标识值发生一次不连续。
  let hash = 0x811c9dc5;
  const length = value.length;
  let index = 0;
  for (; index + 1 < length; index += 2) {
    hash ^= value.charCodeAt(index) | (value.charCodeAt(index + 1) << 16);
    hash = Math.imul(hash, 0x01000193);
  }
  if (index < length) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function createLogisticsShadowSelfExclusion(): LogisticsShadowSelfExclusion {
  return {
    outgoingByRoomResource: new Map<string, number>(),
    incomingByRoomResource: new Map<string, number>(),
    incomingByRoom: new Map<string, number>(),
    feeByRoom: new Map<string, number>(),
  };
}

function getLogisticsShadowReceiverHeadroom(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
  context: ResourceControlCommitmentReadContext,
  selfExclusion: LogisticsShadowSelfExclusion,
  localCommitmentByTargetId?: ReadonlyMap<string, number>,
): {
  storage: number;
  terminal: number;
  resource: number;
} {
  const availability = context.receiverCapacityLedger.getAvailability(
    snapshot.roomName,
    resource,
  );
  const totalDelta =
    selfExclusion.incomingByRoom.get(snapshot.roomName) || 0;
  const resourceDelta =
    selfExclusion.incomingByRoomResource.get(
      roomResourceKey(snapshot.roomName, resource),
    ) || 0;
  const storageLocalCommitment = snapshot.storage
    ? localCommitmentByTargetId?.get(snapshot.storage.id) ??
      getLocalCarrierDestinationCommittedAmount(snapshot.storage.id)
    : 0;
  const terminalLocalCommitment =
    localCommitmentByTargetId?.get(snapshot.terminal.id) ??
    getLocalCarrierDestinationCommittedAmount(snapshot.terminal.id);
  const previousTotalCommitted = Math.max(
    0,
    availability.totalCommitted - totalDelta,
  );
  const previousResourceCommitted = Math.max(
    0,
    availability.resourceCommitted - resourceDelta,
  );
  return {
    storage: Math.max(
      0,
      availability.storageSafeCapacity -
        previousTotalCommitted -
        availability.reservationTotal -
        storageLocalCommitment,
    ),
    terminal: Math.max(
      0,
      availability.terminalTotalSafeCapacity -
        previousTotalCommitted -
        availability.reservationTotal -
        terminalLocalCommitment,
    ),
    resource: Math.max(
      0,
      availability.terminalResourceFreeCapacity -
        previousResourceCommitted -
        availability.reservationResource -
        terminalLocalCommitment,
    ),
  };
}

function createLogisticsShadowRoomFacts(
  snapshots: ResourceControlSnapshot[],
  resources: readonly ResourceConstant[],
  epochRevision: string,
  epochFingerprint: string,
  capacityConfig: ResourceCapacityConfig,
  context: ResourceControlCommitmentReadContext,
  selfExclusion: LogisticsShadowSelfExclusion,
  localCommitmentByTargetId?: ReadonlyMap<string, number>,
  capturedSourceFacts?: LogisticsShadowCapturedSourceFacts,
): SynthesisShadowRoomFact[] {
  const provisional = snapshots.map((snapshot): SynthesisShadowRoomFact => {
    const receiverBaseline = getLogisticsShadowReceiverHeadroom(
      snapshot,
      resources[0] || RESOURCE_ENERGY,
      context,
      selfExclusion,
      localCommitmentByTargetId,
    );
    const outgoingEnergyDelta =
      selfExclusion.outgoingByRoomResource.get(
        roomResourceKey(snapshot.roomName, RESOURCE_ENERGY),
      ) || 0;
    const actionEnergyBudget =
      (capturedSourceFacts?.actionEnergyBudgetByRoom.get(snapshot.roomName) ??
        getTerminalActionEnergyBudget(snapshot, context)) +
      outgoingEnergyDelta +
      (selfExclusion.feeByRoom.get(snapshot.roomName) || 0);
    const terminalEnergyOutsideMarketExposure =
      capturedSourceFacts?.terminalOutsideExposureByRoomResource.get(
        roomResourceKey(snapshot.roomName, RESOURCE_ENERGY),
      ) ??
      getTerminalAmountOutsideMarketSaleExposure(
        snapshot.terminal,
        RESOURCE_ENERGY,
        snapshot.roomName,
      );
    const terminalActionEnergyAmount = Math.min(
      actionEnergyBudget,
      terminalEnergyOutsideMarketExposure,
    );
    const terminalReadyAt =
      Game.time + Math.max(
        0,
        Math.floor(
          snapshot.terminalCooldown ?? snapshot.terminal.cooldown ?? 0,
        ),
      );
    const { feedCapacity } = getTerminalLogisticsCapacityPlan(
      snapshot,
      capacityConfig,
    );
    const terminalLocalCommitment =
      localCommitmentByTargetId?.get(snapshot.terminal.id) ??
      getLocalCarrierDestinationCommittedAmount(snapshot.terminal.id);
    return {
      roomName: snapshot.roomName,
      epochRevision,
      epochFingerprint,
      revision: `pending:${Game.time}`,
      observedAt: Game.time,
      expiresAt: Game.time + Math.max(30, getResourceControlSampleInterval() * 2),
      owned: true,
      hasStorage: !!snapshot.storage,
      hasTerminal: true,
      terminalReachable: true,
      terminalReadyAt,
      transferBatchSize: snapshot.transferBatchSize,
      capacityState: snapshot.capacityState,
      receiverEligible: isReceiverAdmissionEligible(
        snapshot.storageFreeCapacity,
        snapshot.terminalFreeCapacity,
        snapshot.capacityState,
        capacityConfig,
      ),
      receiverStorageHeadroom: receiverBaseline.storage,
      receiverTerminalHeadroom: receiverBaseline.terminal,
      terminalStagingFreeCapacity: Math.max(
        0,
        feedCapacity - terminalLocalCommitment,
      ),
      actionEnergyBudget,
      terminalActionEnergyAmount,
      resources: resources.map((resource) => {
        const receiver = getLogisticsShadowReceiverHeadroom(
          snapshot,
          resource,
          context,
          selfExclusion,
          localCommitmentByTargetId,
        );
        const policyAvailableAmount =
          (capturedSourceFacts?.sourceAvailableByRoomResource.get(
            roomResourceKey(snapshot.roomName, resource),
          ) ??
            getTotalMovableResourceAmount(
              snapshot,
              resource,
              capacityConfig,
              context,
            )) +
          (selfExclusion.outgoingByRoomResource.get(
            roomResourceKey(snapshot.roomName, resource),
          ) || 0) +
          (resource === RESOURCE_ENERGY
            ? selfExclusion.feeByRoom.get(snapshot.roomName) || 0
            : 0);
        const terminalOutsideMarketExposure =
          resource === RESOURCE_ENERGY
            ? terminalActionEnergyAmount
            : capturedSourceFacts?.terminalOutsideExposureByRoomResource.get(
                roomResourceKey(snapshot.roomName, resource),
              ) ??
              getTerminalAmountOutsideMarketSaleExposure(
                snapshot.terminal,
                resource,
                snapshot.roomName,
              );
        const sourceAvailableAmount = resource === RESOURCE_ENERGY
          ? policyAvailableAmount
          : Math.min(
              policyAvailableAmount,
              getStorageResourceAmount(snapshot, resource) +
                terminalOutsideMarketExposure,
            );
        return {
          resource,
          sourceAvailableAmount,
          sourceTerminalAmount: Math.min(
            sourceAvailableAmount,
            terminalOutsideMarketExposure,
          ),
          receiverResourceHeadroom: receiver.resource,
        };
      }),
    };
  });
  return provisional;
}

export type SynthesisShadowEpochCaptureFailureReason =
  | "cpu_unavailable"
  | "shadow_unavailable"
  | "not_planning_tick"
  | "no_rooms"
  | "tick_changed"
  | "already_built"
  | "invalid_resources";

export interface SynthesisShadowEpochRoomFactBuildSuccess {
  readonly ok: true;
  readonly epochRevision: string;
  readonly epochFingerprint: string;
  readonly observedAt: number;
  readonly expiresAt: number;
  readonly captureCpuUsed: number;
  readonly indexBuildCount: 1;
  readonly roomFacts: readonly SynthesisShadowRoomFact[];
}

export type SynthesisShadowEpochRoomFactBuildResult =
  | SynthesisShadowEpochRoomFactBuildSuccess
  | {
      readonly ok: false;
      readonly reason: SynthesisShadowEpochCaptureFailureReason;
    };

export interface SynthesisShadowEpochCaptureSession {
  readonly ok: true;
  readonly observedAt: number;
  readonly epochRevision: string;
  readonly tasks: readonly Readonly<ResourceTransferTask>[];
  buildRoomFacts(
    resources: readonly ResourceConstant[],
  ): SynthesisShadowEpochRoomFactBuildResult;
}

export type SynthesisShadowEpochCaptureResult =
  | SynthesisShadowEpochCaptureSession
  | {
      readonly ok: false;
      readonly reason: SynthesisShadowEpochCaptureFailureReason;
    };

/**
 * 原 canonicalizeSynthesisShadowEpochFacts 的等价确定性摘要：同一字段集合、
 * 同一排序规则，但直接增量混入 FNV 状态，不构建中间大字符串。分隔符 mix
 * 防止相邻字段值拼接歧义；哈希值只在单次部署内比较。
 */
function hashSynthesisShadowEpochFacts(
  resources: readonly ResourceConstant[],
  facts: readonly SynthesisShadowRoomFact[],
): string {
  let hash = 0x811c9dc5;
  const mixString = (value: string): void => {
    const length = value.length;
    let index = 0;
    for (; index + 1 < length; index += 2) {
      hash ^= value.charCodeAt(index) | (value.charCodeAt(index + 1) << 16);
      hash = Math.imul(hash, 0x01000193);
    }
    if (index < length) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0x1f;
    hash = Math.imul(hash, 0x01000193);
  };
  const mixNumber = (value: number): void => {
    // room facts 数值全为安全整数：直接位混合避免逐数字符串化分配；
    // 非整数（不应出现）回退字符串路径保持确定性。
    if (Number.isSafeInteger(value)) {
      hash ^= value & 0xffff;
      hash = Math.imul(hash, 0x01000193);
      hash ^= Math.floor(value / 0x10000) & 0xffff;
      hash = Math.imul(hash, 0x01000193);
      hash ^= 0x1f;
      hash = Math.imul(hash, 0x01000193);
      return;
    }
    mixString(`${value}`);
  };
  const mixFlag = (value: boolean): void => {
    mixString(value ? "1" : "0");
  };
  mixString("synthesis-room-epoch/v2");
  mixString([...resources].sort().join(","));
  const sortedFacts = [...facts].sort((left, right) =>
    left.roomName.localeCompare(right.roomName),
  );
  for (const room of sortedFacts) {
    mixString(room.roomName);
    mixNumber(room.observedAt);
    mixNumber(room.expiresAt);
    mixFlag(room.owned);
    mixFlag(room.hasStorage);
    mixFlag(room.hasTerminal);
    mixFlag(room.terminalReachable);
    mixNumber(room.terminalReadyAt);
    mixNumber(room.transferBatchSize);
    mixString(room.capacityState);
    mixFlag(room.receiverEligible);
    mixNumber(room.receiverStorageHeadroom);
    mixNumber(room.receiverTerminalHeadroom);
    mixNumber(room.terminalStagingFreeCapacity);
    mixNumber(room.actionEnergyBudget);
    mixNumber(room.terminalActionEnergyAmount);
    const sortedResources = [...room.resources].sort((left, right) =>
      left.resource.localeCompare(right.resource),
    );
    for (const resource of sortedResources) {
      mixString(resource.resource);
      mixNumber(resource.sourceAvailableAmount);
      mixNumber(resource.sourceTerminalAmount);
      mixNumber(resource.receiverResourceHeadroom);
    }
  }
  return (hash >>> 0).toString(36);
}

/**
 * 在 Synthesis 写任何 legacy task 前冻结一次 P0 ResourceControl 索引。
 * session 只闭包持有本 tick 的数值索引；后续 build 不重新扫描 task store。
 */
export function beginSynthesisShadowEpochCapture(
  demandResources: readonly ResourceConstant[],
): SynthesisShadowEpochCaptureResult {
  const logisticsConfig = resolveLogisticsControlConfig();
  if (
    Memory.cfg?.resourceControl?.enabled === false ||
    !logisticsConfig.valid ||
    logisticsConfig.mode !== "shadow"
  ) {
    return { ok: false, reason: "shadow_unavailable" };
  }
  if (!isResourceControlFullPlanningTick()) {
    return { ok: false, reason: "not_planning_tick" };
  }
  const normalizedDemandResources = [...new Set(demandResources)].sort();
  if (
    normalizedDemandResources.length > LOGISTICS_CONTROL_STORE_LIMIT ||
    normalizedDemandResources.some((resource) =>
      !RESOURCES_ALL.includes(resource),
    )
  ) {
    return { ok: false, reason: "invalid_resources" };
  }
  const capturedResources = [
    ...new Set([...normalizedDemandResources, RESOURCE_ENERGY]),
  ].sort();
  const cpuStartedAt = readLogisticsShadowCpuUsed();
  if (cpuStartedAt === undefined) {
    return { ok: false, reason: "cpu_unavailable" };
  }
  const observedAt = Game.time;
  const snapshots = collectResourceControlSnapshots(capturedResources);
  if (snapshots.length === 0) return { ok: false, reason: "no_rooms" };
  const capacityConfig = resolveCapacityConfig();
  const buildCounter: ResourceControlCapacityIndexBuildCounter = { count: 0 };
  const context = createSynthesisShadowCaptureContext(
    snapshots,
    capacityConfig,
    buildCounter,
  );
  if (
    buildCounter.count !== 1 ||
    context.indexBuildCount !== 1 ||
    context.productionReservationScanCount !== 1 ||
    context.invalidRecordCount > 0
  ) {
    return { ok: false, reason: "invalid_resources" };
  }
  const frozenTasks = context.tasks.map((task) =>
    Object.freeze({ ...task }) as Readonly<ResourceTransferTask>,
  );
  const localCommitmentByTargetId = new Map<string, number>();
  const actionEnergyBudgetByRoom = new Map<string, number>();
  const sourceAvailableByRoomResource = new Map<string, number>();
  const terminalOutsideExposureByRoomResource = new Map<string, number>();
  const marketExposureIndex = compileLiveMarketSaleTerminalExposureIndex();
  for (const snapshot of snapshots) {
    if (snapshot.storage) {
      localCommitmentByTargetId.set(
        snapshot.storage.id,
        getLocalCarrierDestinationCommittedAmount(snapshot.storage.id),
      );
    }
    localCommitmentByTargetId.set(
      snapshot.terminal.id,
      getLocalCarrierDestinationCommittedAmount(snapshot.terminal.id),
    );
    const terminalAmountsOutsideExposure =
      getTerminalAmountsOutsideMarketSaleExposure(
        snapshot.terminal,
        capturedResources,
        marketExposureIndex,
        {
          roomName: snapshot.roomName,
          storedAmounts: snapshot.terminalResourceAmounts,
        },
      );
    for (const resource of capturedResources) {
      terminalOutsideExposureByRoomResource.set(
        roomResourceKey(snapshot.roomName, resource),
        terminalAmountsOutsideExposure.get(resource) || 0,
      );
    }
    const terminalEnergyOutsideMarketExposure =
      terminalOutsideExposureByRoomResource.get(
        roomResourceKey(snapshot.roomName, RESOURCE_ENERGY),
      ) || 0;
    const actionEnergyBudget = getTerminalActionEnergyBudget(
      snapshot,
      context,
      undefined,
      terminalEnergyOutsideMarketExposure,
    );
    actionEnergyBudgetByRoom.set(snapshot.roomName, actionEnergyBudget);
    terminalOutsideExposureByRoomResource.set(
      roomResourceKey(snapshot.roomName, RESOURCE_ENERGY),
      Math.min(actionEnergyBudget, terminalEnergyOutsideMarketExposure),
    );
    for (const resource of capturedResources) {
      sourceAvailableByRoomResource.set(
        roomResourceKey(snapshot.roomName, resource),
        resource === RESOURCE_ENERGY
          ? actionEnergyBudget
          : getTotalMovableResourceAmount(
              snapshot,
              resource,
              capacityConfig,
              context,
            ),
      );
    }
  }
  const capturedSourceFacts: LogisticsShadowCapturedSourceFacts = {
    actionEnergyBudgetByRoom,
    sourceAvailableByRoomResource,
    terminalOutsideExposureByRoomResource,
  };
  const cpuCapturedAt = readLogisticsShadowCpuUsed();
  if (cpuCapturedAt === undefined) {
    return { ok: false, reason: "cpu_unavailable" };
  }
  const beginCpuUsed = Math.max(0, cpuCapturedAt - cpuStartedAt);
  const epochRevision = `synthesis-room-epoch/v1:${observedAt}:${
    logisticsShadowHash(
      snapshots
        .map((snapshot) => snapshot.roomName)
        .sort()
        .join("|"),
    )
  }`;
  let built = false;
  return {
    ok: true,
    observedAt,
    epochRevision,
    tasks: Object.freeze(frozenTasks),
    buildRoomFacts(
      resources: readonly ResourceConstant[],
    ): SynthesisShadowEpochRoomFactBuildResult {
      if (built) return { ok: false, reason: "already_built" };
      built = true;
      if (Game.time !== observedAt) {
        return { ok: false, reason: "tick_changed" };
      }
      const normalizedResources = [...new Set(resources)].sort();
      if (
        normalizedResources.length > LOGISTICS_CONTROL_STORE_LIMIT ||
        normalizedResources.some((resource) =>
          !normalizedDemandResources.includes(resource),
        )
      ) {
        return { ok: false, reason: "invalid_resources" };
      }
      const buildCpuStartedAt = readLogisticsShadowCpuUsed();
      if (buildCpuStartedAt === undefined) {
        return { ok: false, reason: "cpu_unavailable" };
      }
      const provisional = normalizedResources.length === 0
        ? []
        : createLogisticsShadowRoomFacts(
            snapshots,
            normalizedResources,
            epochRevision,
            "pending",
            capacityConfig,
            context,
            createLogisticsShadowSelfExclusion(),
            localCommitmentByTargetId,
            capturedSourceFacts,
          );
      const epochFingerprint = `synthesis-room-epoch/v1:${
        hashSynthesisShadowEpochFacts(normalizedResources, provisional)
      }`;
      const roomFacts = provisional.map((room) => ({
        ...room,
        epochFingerprint,
        revision: `${room.roomName}@${epochRevision}`,
        resources: room.resources.map((resource) => ({ ...resource })),
      }));
      const buildCpuFinishedAt = readLogisticsShadowCpuUsed();
      if (buildCpuFinishedAt === undefined) {
        return { ok: false, reason: "cpu_unavailable" };
      }
      const captureCpuUsed = Math.max(
        0,
        Math.round(
          (beginCpuUsed + buildCpuFinishedAt - buildCpuStartedAt) * 1_000,
        ) / 1_000,
      );
      return {
        ok: true,
        epochRevision,
        epochFingerprint,
        observedAt,
        expiresAt:
          observedAt + Math.max(30, getResourceControlSampleInterval() * 2),
        captureCpuUsed,
        indexBuildCount: 1,
        roomFacts,
      };
    },
  };
}

export function getTerminalLogisticsCapacityPlan(
  snapshot: ResourceControlSnapshot,
  capacityConfig: ResourceCapacityConfig,
): {
  recoveringTerminal: boolean;
  desiredTerminalUsedCapacity: number;
  feedCapacity: number;
} {
  const recoveringTerminal =
    capacityConfig.terminalHeadroomRecoveryEnabled &&
    snapshot.capacityState !== "normal";
  const desiredTerminalUsedCapacity = !capacityConfig.terminalHeadroomRecoveryEnabled
    ? TERMINAL_TOTAL_STORAGE_CAP
    : Math.max(
        0,
        TERMINAL_STORAGE_CAPACITY -
          (recoveringTerminal
            ? capacityConfig.terminalReliefTargetFreeCapacity
            : Math.max(
                NORMAL_TERMINAL_TARGET_FREE_CAPACITY,
                capacityConfig.receiverTerminalMinFreeCapacity,
              )),
      );
  return {
    recoveringTerminal,
    desiredTerminalUsedCapacity,
    feedCapacity: Math.min(
      snapshot.terminalFreeCapacity,
      Math.max(0, desiredTerminalUsedCapacity - snapshot.terminalUsedCapacity),
    ),
  };
}

/** T2/T3 arm/admission/native 共用占用口径；仅交还接管切片，余量及费用仍承诺。 */
export function inspectTreasuryResourceTransferReadiness(task: ResourceTransferTask, amount: number, fee: number, liveLedger?: ReceiverCapacityLedger): {ok: boolean; reason: string} {
  return inspectTreasuryResourceTransferAvailability(task, amount, fee, liveLedger, true);
}

interface TreasuryPreparationContext {
  snapshots: ResourceControlSnapshot[];
  config: ResourceCapacityConfig;
  context: ResourceControlTransferContext;
}

/** 只用于同一个同步规划调用，不跨 tick 或 mutation 复用。 */
export function createTreasuryPreparationInspector(): (task: ResourceTransferTask, amount: number, fee: number) => {ok: boolean; reason: string} {
  const snapshots = collectResourceControlSnapshots(undefined, Object.values(Game.rooms).filter(room => room.controller?.my === true));
  const config = resolveCapacityConfig();
  const context = createResourceControlTransferContext(snapshots, config, {count:0}, {readonlyCarrierBoard:true});
  return (task, amount, fee) => [TREASURY_T3_LANE, TREASURY_T4_LANE].some(lane => treasuryLaneTaskMatches(lane, task))
    ? inspectTreasuryResourceTransferAvailability(task, amount, fee, undefined, false, { snapshots, config, context })
    : { ok: false, reason: "outside_preparation_lane" };
}

/** 仅 OH 准备入口可接受正常 Storage 备货；尚不授予 native。 */
export function inspectTreasuryResourceTransferPreparation(task: ResourceTransferTask, amount: number, fee: number): {ok: boolean; reason: string} {
  if (![TREASURY_T3_LANE,TREASURY_T4_LANE].some((lane) => treasuryLaneTaskMatches(lane, task))) return {ok:false,reason:"outside_preparation_lane"};
  return inspectTreasuryResourceTransferAvailability(task, amount, fee, undefined, false);
}

function inspectTreasuryResourceTransferAvailability(task: ResourceTransferTask, amount: number, fee: number, liveLedger: ReceiverCapacityLedger | undefined, requireTerminalStock: boolean, prepared?: TreasuryPreparationContext): {ok: boolean; reason: string} {
  try {
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100 || amount > task.remainingAmount ||
        !Number.isSafeInteger(fee) || fee < 0 || fee > 100 || !validateReservationStoreHealth().healthy) return {ok:false,reason:"shared_commitment_invalid"};
    const demand = inspectSynthesisTransferNeed(task.toRoomName, task.resource, RESOURCE_UTRIUM_ACID, task.id);
    if (!demand.ok) return {ok:false,reason:demand.reason};
    if (demand.amount < amount) return {ok:false,reason:"synthesis_need_below_slice"};
    const snapshots = prepared?.snapshots ?? collectResourceControlSnapshots(undefined, Object.values(Game.rooms).filter((room) => room.controller?.my === true));
    const donor = snapshots.find((entry) => entry.roomName === task.fromRoomName);
    const receiver = snapshots.find((entry) => entry.roomName === task.toRoomName);
    if (!donor?.storage || !receiver?.storage) return {ok:false,reason:"shared_endpoint_unavailable"};
    const config = prepared?.config ?? resolveCapacityConfig();
    const context = prepared?.context ?? createResourceControlTransferContext(snapshots, config, {count:0}, {readonlyCarrierBoard:true});
    const outgoing = getHealthyOutgoingCommitment(donor.roomName, task.resource, context);
    const ownHealthy = isHealthyResourceTransferTaskReservation(task,"outgoing");
    const residualResourceCommitment = Math.max(0,outgoing - (ownHealthy ? amount : 0));
    // OH 首片只自然备货真实缺口；本任务余量仍由房间库存承担，
    // 不要求把仍有承诺的 Storage 余量也提前塞进同一 Terminal。
    const terminalResourceCommitment = [TREASURY_T3_LANE,TREASURY_T4_LANE].some((lane) => treasuryLaneTaskMatches(lane, task))
      ? Math.max(0, outgoing - (ownHealthy ? task.remainingAmount : 0))
      : residualResourceCommitment;
    const roomResourceBudget = getStock(donor,task.resource) - getProtectedResourceAmount(donor,task.resource,config,context) - residualResourceCommitment;
    const sourceBudget = requireTerminalStock ? Math.min(roomResourceBudget,
      getTerminalResourceAmount(donor,task.resource) - getProductionCommitmentAmount(donor.roomName,task.resource,context) - terminalResourceCommitment,
    ) : roomResourceBudget;
    if (!Number.isSafeInteger(sourceBudget) || sourceBudget < amount) return {ok:false,reason:"shared_source_resource_protected"};
    const ownFee = context.outgoingFeeByTaskId.get(task.id) ?? 0;
    const remainderFee = ownFee > 0 && task.remainingAmount > amount ? Game.market.calcTransactionCost(task.remainingAmount - amount,task.fromRoomName,task.toRoomName) : 0;
    const terminalEnergyBudget = donor.terminalEnergy - getProductionCommitmentAmount(donor.roomName,RESOURCE_ENERGY,context) -
      getHealthyOutgoingCommitment(donor.roomName,RESOURCE_ENERGY,context) - getOutgoingTransactionFeeReserve(donor,context) + ownFee - remainderFee;
    const energyBudget = Math.min(terminalEnergyBudget, getTerminalActionEnergyBudget(donor,context) + ownFee - remainderFee);
    if (!Number.isSafeInteger(energyBudget) || energyBudget < fee || donor.terminalEnergy < fee) return {ok:false,reason:"shared_fee_energy_protected"};
    if (requireTerminalStock) {
      if (!canTerminalSendPreserveMarketSaleExposure(donor.terminal,task.resource,amount,fee)) return {ok:false,reason:"shared_market_exposure_protected"};
    } else {
      const exposure = getMarketSaleTerminalExposure(donor.roomName, task.resource);
      if (exposure.blocked || exposure.reservedAmount > 0 ||
          getTerminalAmountOutsideMarketSaleExposure(donor.terminal,RESOURCE_ENERGY) < fee) return {ok:false,reason:"shared_market_exposure_protected"};
    }
    const ledger = liveLedger ?? context.receiverCapacityLedger;
    const capacity = ledger.getAvailableAmount(receiver.roomName,task.resource,task.id) - Math.max(0,task.remainingAmount-amount);
    const cargoCapacity = getLocalCarrierDestinationCommittedAmount(receiver.terminal.id);
    if (!Number.isSafeInteger(capacity) || capacity - cargoCapacity < amount) return {ok:false,reason:"shared_receiver_capacity_protected"};
    return {ok:true,reason:"shared_ready"};
  } catch { return {ok:false,reason:"shared_commitment_unreadable"}; }
}

export function getResourceControlDonorAvailable(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
): number {
  const total = getStock(snapshot, resource);
  if (resource === RESOURCE_ENERGY) {
    const terminalEnergyOutsideMarketExposure =
      getTerminalAmountOutsideMarketSaleExposure(
        snapshot.terminal,
        RESOURCE_ENERGY,
        snapshot.roomName,
      );
    return getTerminalActionEnergyOwnershipBudget({
      totalEnergy: total,
      ordinaryTerminalEnergyReserve: snapshot.terminalEnergyReserve,
      productionEnergyCommitment: getReservedProductionAmount(
        snapshot.roomName,
        RESOURCE_ENERGY,
      ),
      otherOutgoingEnergyCommitment: 0,
      otherOutgoingFeeCommitment: 0,
      otherExplicitEnergyOwnership: Math.max(
        0,
        snapshot.terminalEnergy - terminalEnergyOutsideMarketExposure,
      ),
    });
  }
  const floor = snapshot.mineralFloor[resource] || 0;
  return Math.max(0, total - floor);
}
