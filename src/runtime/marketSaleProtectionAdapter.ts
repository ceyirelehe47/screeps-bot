import {
  listCarrierDispatchEntriesByRoom,
  type CarrierTask,
  type CarrierDispatchEntry,
} from "@/runtime/carrierTaskBoard";
import { getCreepAssignmentState } from "@/runtime/creepAssignmentState";
import {
  cloneCarrierDispatchRef,
  encodeCarrierDispatchStepKey,
  type CarrierDispatchRef,
} from "@/runtime/dispatchOwnership/ref";
import {
  findFactoryInRoom,
  parseConfig as parseFactoryConfig,
  resolveTargetQueue,
} from "@/runtime/factoryControl";
import {
  buildMarketSaleProtectionLedger,
  getMarketProtectionEntryKey,
  type MarketProtectionCandidate,
  type MarketProtectionFact,
  type MarketProtectionSourceKind,
  type MarketProtectionSourceSnapshot,
  type MarketSaleProtectionLedger,
} from "@/runtime/marketSaleProtection";
import type { MarketSaleAutomationConfig } from "@/runtime/marketSaleConfig";
import { getProductReagents } from "@/runtime/reactionMap";
import {
  resolveRoomConfig,
} from "@/runtime/resourceControl";
import { POWER_BANK_BOOST_REQUIREMENTS } from "@/runtime/powerBankConstants";
import {
  readFreshCommittedHubProtectionSnapshot,
} from "@/runtime/hubProtectionSnapshot";

export interface LiveManagedOrderExposure {
  orderId: string;
  roomName: string;
  resourceType: ResourceConstant;
  remainingExposure: number;
}

export type LiveManagedOrderCollection =
  | readonly LiveManagedOrderExposure[]
  | Readonly<Record<string, LiveManagedOrderExposure>>;

export interface CollectLiveMarketSaleProtectionOptions {
  candidates?: readonly MarketProtectionCandidate[];
  /**
   * Exact current-permit reserves keyed by `roomName:resource`.
   *
   * Continuous orchestration should pass this after validating the permit.
   * The adapter also understands the persisted v2 permit shape so a missing
   * call-site projection cannot accidentally fall back to a lower reserve.
   */
  laneReserveByEntry?: Readonly<Record<string, number>>;
}

type MutableSourceMap = Record<
  MarketProtectionSourceKind,
  MarketProtectionSourceSnapshot
>;

type UnknownRecord = Record<string, unknown>;

interface SourceCollection {
  complete: boolean;
  facts: MarketProtectionFact[];
}

const WAR_T3_BOOSTS: readonly ResourceConstant[] = [
  RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE,
  RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
  RESOURCE_CATALYZED_UTRIUM_ACID,
  RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
];

const BASE_REACTION_MINERALS = new Set<ResourceConstant>([
  RESOURCE_HYDROGEN,
  RESOURCE_OXYGEN,
  RESOURCE_UTRIUM,
  RESOURCE_LEMERGIUM,
  RESOURCE_KEANIUM,
  RESOURCE_ZYNTHIUM,
  RESOURCE_CATALYST,
]);

const TERMINAL_POWER_BANK_STATUSES = new Set([
  "complete",
  "failed",
  "aborted",
]);

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validResource(value: unknown): value is ResourceConstant {
  return typeof value === "string" && value.length > 0;
}

function validRoomName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function currentSnapshot(
  complete: boolean,
  facts: readonly MarketProtectionFact[],
): MarketProtectionSourceSnapshot {
  return {
    revision: Game.time,
    observedAt: Game.time,
    expiresAt: Game.time,
    complete,
    facts,
  };
}

function uniqueCandidates(
  candidates: readonly MarketProtectionCandidate[],
): MarketProtectionCandidate[] {
  const seen = new Set<string>();
  const result: MarketProtectionCandidate[] = [];
  for (const candidate of candidates) {
    if (
      !validRoomName(candidate.roomName) ||
      !validResource(candidate.resource)
    ) {
      continue;
    }
    const key = `${candidate.roomName}:${candidate.resource}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function resolveCandidates(
  config: MarketSaleAutomationConfig,
  options: CollectLiveMarketSaleProtectionOptions,
): MarketProtectionCandidate[] {
  if (options.candidates) {
    return uniqueCandidates(options.candidates);
  }

  const candidates: MarketProtectionCandidate[] = [];
  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my || !room.terminal) continue;
    for (const resource of config.sellResources) {
      candidates.push({ roomName: room.name, resource });
    }
  }
  return uniqueCandidates(candidates);
}

function getTransferableStock(
  room: Room,
  resource: ResourceConstant,
): { totalStock: number; terminalStock: number } | undefined {
  if (!room.controller?.my || !room.terminal) return undefined;
  const storageStock = room.storage?.store.getUsedCapacity(resource) ?? 0;
  const terminalStock = room.terminal.store.getUsedCapacity(resource) ?? 0;
  if (!finiteNonNegative(storageStock) || !finiteNonNegative(terminalStock)) {
    return undefined;
  }
  return {
    totalStock: storageStock + terminalStock,
    terminalStock,
  };
}

function collectStock(
  candidates: readonly MarketProtectionCandidate[],
): SourceCollection {
  const facts: MarketProtectionFact[] = [];
  for (const candidate of candidates) {
    const room = Game.rooms[candidate.roomName];
    if (!room) continue;
    const stock = getTransferableStock(room, candidate.resource);
    if (!stock) continue;
    facts.push({
      roomName: candidate.roomName,
      resource: candidate.resource,
      amount: stock.totalStock,
      terminalStock: stock.terminalStock,
      stableKey: `stock:${candidate.roomName}:${candidate.resource}`,
    });
  }
  return { complete: true, facts };
}

function collectRoomFloors(
  candidates: readonly MarketProtectionCandidate[],
): SourceCollection {
  // mineralFloor/mineralExportStart 是 room config 的派生值（resolveRoomConfig
  // 归一化产物，ResourceControlSnapshot 的同两字段即取自它），与 room 实时
  // store/structure 状态无关——直接读 config，免去全量快照采集。不走
  // tickContext.getMyRooms 的 per-tick 缓存，保持本 collector 无跨调用
  // 共享状态。
  let byRoom: Map<string, ReturnType<typeof resolveRoomConfig>>;
  try {
    byRoom = new Map(
      Object.values(Game.rooms || {})
        .filter(
          (room) => room.controller?.my === true && room.terminal !== undefined,
        )
        .map((room) => [room.name, resolveRoomConfig(room.name)] as const),
    );
  } catch {
    return { complete: false, facts: [] };
  }
  let factoryConfig: ReturnType<typeof parseFactoryConfig> | undefined;
  try {
    factoryConfig = parseFactoryConfig();
  } catch {
    return { complete: false, facts: [] };
  }
  let complete = true;
  const facts: MarketProtectionFact[] = [];
  for (const candidate of candidates) {
    const roomConfig = byRoom.get(candidate.roomName);
    const floor = roomConfig?.mineralFloor[candidate.resource];
    const exportStart =
      roomConfig?.mineralExportStart?.[candidate.resource];
    if (BASE_REACTION_MINERALS.has(candidate.resource)) {
      if (!finiteNonNegative(floor) || !finiteNonNegative(exportStart)) {
        complete = false;
        continue;
      }
    }
    if (finiteNonNegative(floor)) {
      facts.push({
        roomName: candidate.roomName,
        resource: candidate.resource,
        amount: floor,
        stableKey: `floor:mineral:${candidate.roomName}:${candidate.resource}`,
        bucket: "hardReserve",
      });
    }
    if (finiteNonNegative(exportStart)) {
      facts.push({
        roomName: candidate.roomName,
        resource: candidate.resource,
        amount: exportStart,
        stableKey: `floor:mineral-export:${candidate.roomName}:${candidate.resource}`,
        bucket: "hardReserve",
      });
    }
    const roomFactoryConfig = factoryConfig.rooms[candidate.roomName];
    const factoryFloor =
      roomFactoryConfig?.resourceFloors[candidate.resource] ??
      factoryConfig.resourceFloors[candidate.resource];
    if (factoryFloor !== undefined && !finiteNonNegative(factoryFloor)) {
      complete = false;
      continue;
    }
    if (!finiteNonNegative(factoryFloor)) continue;
    facts.push({
      roomName: candidate.roomName,
      resource: candidate.resource,
      amount: factoryFloor,
      stableKey: `floor:factory:${candidate.roomName}:${candidate.resource}`,
      bucket: "hardReserve",
    });
  }
  return { complete, facts };
}

interface PermitLaneReserveView {
  complete: boolean;
  found: boolean;
  values: Map<string, number>;
}

function permitExecutionEntries(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return undefined;
  if (Array.isArray(record.entries)) return record.entries;
  return Object.values(record);
}

function collectPersistedPermitLaneReserves(): PermitLaneReserveView {
  const marketData = asRecord(Memory.data?.marketSaleAutomation);
  const directAutomation = asRecord(marketData?.directAutomation);
  const directContinuous = asRecord(marketData?.directContinuous);
  const permit =
    asRecord(directAutomation?.currentPermit) ??
    asRecord(directContinuous?.currentPermit);
  if (!permit) {
    return { complete: true, found: false, values: new Map() };
  }
  const entries = permitExecutionEntries(
    permit.executionTable ?? permit.canonicalExecutionTable,
  );
  if (!entries) {
    return { complete: false, found: true, values: new Map() };
  }

  let complete = true;
  const values = new Map<string, number>();
  for (const rawEntry of entries) {
    const entry = asRecord(rawEntry);
    const resource = entry?.resourceType ?? entry?.resource;
    const roomNames = entry?.allowedRoomNames ?? entry?.allowedRooms;
    const laneReserve = entry?.laneReserve;
    if (
      !entry ||
      !validResource(resource) ||
      !Array.isArray(roomNames) ||
      roomNames.length === 0 ||
      !finiteNonNegative(laneReserve) ||
      laneReserve < 1_000
    ) {
      complete = false;
      continue;
    }
    for (const roomName of roomNames) {
      if (!validRoomName(roomName)) {
        complete = false;
        continue;
      }
      const key = getMarketProtectionEntryKey(roomName, resource);
      const existing = values.get(key);
      if (existing !== undefined && existing !== laneReserve) {
        complete = false;
        continue;
      }
      values.set(key, laneReserve);
    }
  }
  if (values.size === 0) complete = false;
  return { complete, found: true, values };
}

function collectForecast(
  config: MarketSaleAutomationConfig,
  candidates: readonly MarketProtectionCandidate[],
  options: CollectLiveMarketSaleProtectionOptions,
): SourceCollection {
  const minimumForecastBuffer = Math.max(
    config.minDealAmount,
    config.makerBatchAmount,
  );
  const explicit = options.laneReserveByEntry;
  const persisted = collectPersistedPermitLaneReserves();
  const permitBacked = explicit !== undefined || persisted.found;
  let complete =
    config.validForPlanning &&
    Number.isFinite(minimumForecastBuffer) &&
    minimumForecastBuffer > 0 &&
    persisted.complete;
  const facts: MarketProtectionFact[] = [];
  for (const candidate of candidates) {
    const key = getMarketProtectionEntryKey(
      candidate.roomName,
      candidate.resource,
    );
    const amount = explicit
      ? explicit[key]
      : persisted.found
        ? persisted.values.get(key)
        : config.forecastBuffer[candidate.resource];
    const requiredMinimum = permitBacked
      ? Math.max(1_000, minimumForecastBuffer)
      : minimumForecastBuffer;
    if (
      typeof amount !== "number" ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount < requiredMinimum
    ) {
      complete = false;
      continue;
    }
    facts.push({
      roomName: candidate.roomName,
      resource: candidate.resource,
      amount,
      stableKey: `lane-reserve:${candidate.roomName}:${candidate.resource}`,
      bucket: "forecastBuffer",
    });
  }
  return {
    complete,
    facts,
  };
}

function collectResourceReservations(): SourceCollection {
  const store = Memory.runtime?.resourceReservations;
  if (store === undefined) {
    return { complete: true, facts: [] };
  }
  if (!asRecord(store)) {
    return { complete: false, facts: [] };
  }

  let complete = true;
  const facts: MarketProtectionFact[] = [];
  for (const [storeKey, rawEntry] of Object.entries(store)) {
    const entry = asRecord(rawEntry);
    if (
      !entry ||
      !validRoomName(entry.roomName) ||
      !validResource(entry.resource) ||
      typeof entry.holderId !== "string" ||
      !finiteNonNegative(entry.amount) ||
      !finiteNonNegative(entry.updatedAt) ||
      !finiteNonNegative(entry.expiresAt)
    ) {
      complete = false;
      continue;
    }
    if (entry.expiresAt < Game.time) continue;
    facts.push({
      roomName: entry.roomName,
      resource: entry.resource,
      amount: entry.amount,
      stableKey: `reservation:${storeKey}`,
      observedAt: entry.updatedAt,
      expiresAt: entry.expiresAt,
    });
  }
  return { complete, facts };
}

function collectOutgoingTransfers(): SourceCollection {
  const tasks = Memory.data?.resourceControl?.tasks;
  if (!tasks || !asRecord(tasks)) {
    return { complete: false, facts: [] };
  }

  const noProgressTtl =
    Memory.cfg?.resourceControl?.capacityBalancing?.automaticTaskNoProgressTtl;
  const normalizedTtl = finiteNonNegative(noProgressTtl)
    ? noProgressTtl
    : 5_000;
  // ResourceControl only plans on its sample ticks, but its task store is the
  // durable source of truth between samples. Re-reading and validating that
  // store here is a current-tick observation; requiring ResourceControl itself
  // to have run would make every managed market order unmaintainable between
  // sample ticks.
  let complete = true;
  const facts: MarketProtectionFact[] = [];
  for (const [taskKey, rawTask] of Object.entries(tasks)) {
    const task = asRecord(rawTask);
    if (!task) {
      complete = false;
      continue;
    }
    if (task.status !== "pending") continue;
    if (
      !validRoomName(task.fromRoomName) ||
      !validResource(task.resource) ||
      !finiteNonNegative(task.remainingAmount) ||
      typeof task.id !== "string"
    ) {
      complete = false;
      continue;
    }

    const isCapacityRelief =
      task.origin === "automatic" &&
      typeof task.reason === "string" &&
      task.reason.startsWith("capacity:relief:");
    const contractExpired =
      isCapacityRelief &&
      finiteNonNegative(task.lastProgressAt) &&
      Game.time - task.lastProgressAt > normalizedTtl;
    facts.push({
      roomName: task.fromRoomName,
      resource: task.resource,
      amount: task.remainingAmount,
      stableKey: `transfer:${task.id || taskKey}`,
      status: task.blockedReason ? "blocked" : "pending",
      blockedReason:
        typeof task.blockedReason === "string" ? task.blockedReason : undefined,
      disposable: isCapacityRelief,
      contractExpired,
    });
  }
  return { complete, facts };
}

function carrierFactKey(ref: CarrierDispatchRef, stepId: string): string {
  return encodeCarrierDispatchStepKey(ref, stepId);
}

function validCarrierTask(task: CarrierTask): boolean {
  return (
    validRoomName(task.id) &&
    validRoomName(task.roomName) &&
    Array.isArray(task.steps)
  );
}

function collectCarrierCommitments(
  candidates: readonly MarketProtectionCandidate[],
): SourceCollection {
  const roomNames = new Set(candidates.map((candidate) => candidate.roomName));
  // CarrierTaskBoard and creep assignment memory can change on any tick (for
  // example, synthesis/factory run before market-sale). Inspect them directly
  // every tick instead of inheriting ResourceControl's slower cadence.
  let complete = true;
  const facts: MarketProtectionFact[] = [];

  for (const roomName of roomNames) {
    let entries: readonly CarrierDispatchEntry[];
    try {
      entries = listCarrierDispatchEntriesByRoom(roomName);
    } catch {
      complete = false;
      continue;
    }
    for (const { ref: taskRef, task } of entries) {
      if (
        !validCarrierTask(task) ||
        task.roomName !== roomName ||
        taskRef.namespace !== task.producer ||
        taskRef.scope.roomName !== task.roomName ||
        taskRef.localId !== task.id
      ) {
        complete = false;
        continue;
      }
      for (const step of task.steps) {
        if (
          !validRoomName(step.id) ||
          !validResource(step.resource) ||
          !finiteNonNegative(step.amount)
        ) {
          complete = false;
          continue;
        }
        let stableKey: string;
        try {
          stableKey = carrierFactKey(taskRef, step.id);
        } catch {
          complete = false;
          continue;
        }
        facts.push({
          roomName,
          resource: step.resource,
          amount: step.amount,
          stableKey,
          status: "pending",
        });
      }
    }
  }

  for (const creep of Object.values(Game.creeps)) {
    const state = getCreepAssignmentState(creep.name);
    const resource = state?.synthesisCarrierPendingResource;
    if (!resource) continue;
    const amount = creep.store.getUsedCapacity(resource);
    if (!finiteNonNegative(amount) || amount <= 0) continue;
    const taskRef = cloneCarrierDispatchRef(
      state?.synthesisCarrierPendingTaskRef,
    );
    if (!taskRef) {
      complete = false;
      continue;
    }
    const roomName = taskRef.scope.roomName;
    if (!roomNames.has(roomName)) continue;
    const stepId =
      state.synthesisCarrierPendingStepId ??
      `inflight:${creep.name}:${resource}`;
    let stableKey: string;
    try {
      stableKey = carrierFactKey(taskRef, stepId);
    } catch {
      complete = false;
      continue;
    }
    facts.push({
      roomName,
      resource,
      amount,
      stableKey,
      status: "active",
    });
  }

  return { complete, facts };
}

interface CommodityRecipeView {
  amount: number;
  components: Record<string, number>;
}

function getCommodityRecipe(
  resource: ResourceConstant,
): CommodityRecipeView | undefined {
  if (typeof COMMODITIES === "undefined") return undefined;
  const raw = (COMMODITIES as unknown as Record<string, unknown>)[resource];
  const record = asRecord(raw);
  const components = asRecord(record?.components);
  if (
    !record ||
    !components ||
    !finiteNonNegative(record.amount) ||
    record.amount <= 0
  ) {
    return undefined;
  }
  const normalized: Record<string, number> = {};
  for (const [component, amount] of Object.entries(components)) {
    if (!finiteNonNegative(amount) || amount <= 0) continue;
    normalized[component] = amount;
  }
  return { amount: record.amount, components: normalized };
}

function appendFactoryComponents(
  facts: MarketProtectionFact[],
  roomName: string,
  rootTarget: ResourceConstant,
  resource: ResourceConstant,
  amount: number,
  path: readonly string[] = [],
): boolean {
  const recipe = getCommodityRecipe(resource);
  if (!recipe) return false;
  if (path.includes(resource) || path.length > 20) return false;
  const batches = Math.ceil(amount / recipe.amount);
  let complete = true;
  for (const [componentName, perBatch] of Object.entries(recipe.components)) {
    const component = componentName as ResourceConstant;
    const required = perBatch * batches;
    const componentPath = [...path, resource, component].join(">");
    facts.push({
      roomName,
      resource: component,
      amount: required,
      stableKey: `factory:component:${roomName}:${rootTarget}:${componentPath}`,
      status: "active",
      bucket: "consumptiveDemand",
    });
    if (getCommodityRecipe(component)) {
      complete =
        appendFactoryComponents(
          facts,
          roomName,
          rootTarget,
          component,
          required,
          [...path, resource],
        ) && complete;
    }
  }
  return complete;
}

function collectFactory(candidates: readonly MarketProtectionCandidate[]): {
  targets: SourceCollection;
  components: SourceCollection;
  tasks: SourceCollection;
} {
  const targetFacts: MarketProtectionFact[] = [];
  const componentFacts: MarketProtectionFact[] = [];
  const taskFacts: MarketProtectionFact[] = [];
  const rawConfig = Memory.cfg?.factoryControl;
  let targetsComplete = true;
  let componentsComplete = true;

  if (rawConfig?.enabled === true) {
    const runtime = Memory.runtime?.factoryControl;
    if (runtime?.updatedAt !== Game.time) {
      targetsComplete = false;
      componentsComplete = false;
    } else {
      let config: ReturnType<typeof parseFactoryConfig> | undefined;
      try {
        config = parseFactoryConfig();
      } catch {
        targetsComplete = false;
        componentsComplete = false;
      }
      if (!config) {
        return {
          targets: { complete: false, facts: targetFacts },
          components: { complete: false, facts: componentFacts },
          tasks: { complete: false, facts: taskFacts },
        };
      }
      const candidateRooms = new Set(
        candidates.map((candidate) => candidate.roomName),
      );
      for (const roomName of candidateRooms) {
        const room = Game.rooms[roomName];
        if (!room || config.rooms[roomName]?.enabled === false) continue;
        let factory: StructureFactory | null;
        try {
          factory = findFactoryInRoom(room);
        } catch {
          factory = null;
          targetsComplete = false;
          componentsComplete = false;
        }
        if (!factory) continue;

        const queue = resolveTargetQueue(config, roomName);
        for (const target of queue) {
          const recipe = getCommodityRecipe(target.resource);
          const targetAmount =
            target.targetAmount > 0
              ? target.targetAmount
              : target.cap > 0
                ? target.cap
                : recipe?.amount;
          if (!finiteNonNegative(targetAmount) || targetAmount <= 0) {
            targetsComplete = false;
            componentsComplete = false;
            continue;
          }
          targetFacts.push({
            roomName,
            resource: target.resource,
            amount: targetAmount,
            stableKey: `factory:target:${roomName}:${target.resource}`,
            status: "active",
            bucket: "absoluteTarget",
          });
          if (!recipe) {
            componentsComplete = false;
            continue;
          }
          const productStock = getTransferableStock(room, target.resource);
          const targetGap = Math.max(
            0,
            targetAmount - (productStock?.totalStock ?? 0),
          );
          if (targetGap > 0) {
            componentsComplete =
              appendFactoryComponents(
                componentFacts,
                roomName,
                target.resource,
                target.resource,
                targetGap,
              ) && componentsComplete;
          }
        }

        const activeTarget = runtime.rooms?.[roomName]?.activeTarget;
        if (
          activeTarget &&
          !queue.some((target) => target.resource === activeTarget)
        ) {
          const activeRecipe = getCommodityRecipe(activeTarget);
          if (!activeRecipe) {
            componentsComplete = false;
          } else {
            componentFacts.push({
              roomName,
              resource: activeTarget,
              amount: activeRecipe.amount,
              stableKey: `factory:runtime-target:${roomName}:${activeTarget}`,
              status: "active",
              bucket: "absoluteTarget",
            });
            componentsComplete =
              appendFactoryComponents(
                componentFacts,
                roomName,
                activeTarget,
                activeTarget,
                activeRecipe.amount,
              ) && componentsComplete;
          }
        }
      }
    }
  }

  const taskStore = Memory.data?.factoryTasks;
  let tasksComplete = true;
  if (taskStore !== undefined && !asRecord(taskStore)) {
    tasksComplete = false;
  } else {
    for (const [taskKey, rawTask] of Object.entries(taskStore || {})) {
      const task = asRecord(rawTask);
      if (
        !task ||
        !validRoomName(task.roomName) ||
        typeof task.id !== "string" ||
        !finiteNonNegative(task.remainingBatteryAmount)
      ) {
        tasksComplete = false;
        continue;
      }
      if (task.status === "done" || task.status === "cancelled") continue;
      taskFacts.push({
        roomName: task.roomName,
        resource: RESOURCE_BATTERY,
        amount: task.remainingBatteryAmount,
        stableKey: `factory:task:${task.id || taskKey}`,
        bucket: "consumptiveDemand",
        status:
          task.status === "failed"
            ? "failed"
            : task.status === "pending"
              ? "pending"
              : "active",
      });
    }
  }

  return {
    targets: { complete: targetsComplete, facts: targetFacts },
    components: { complete: componentsComplete, facts: componentFacts },
    tasks: { complete: tasksComplete, facts: taskFacts },
  };
}

function synthesisPlanStableKey(
  roomName: string,
  product: ResourceConstant,
): string {
  return `synthesis:plan:${roomName}:${product}`;
}

function appendSynthesisPlanFacts(
  facts: MarketProtectionFact[],
  roomName: string,
  planStableKey: string,
  product: ResourceConstant,
  targetAmount: number,
  status: "active" | "paused",
): {
  complete: boolean;
  reagentDeficits: ReadonlyMap<ResourceConstant, number>;
} {
  if (!finiteNonNegative(targetAmount) || targetAmount <= 0) {
    return { complete: false, reagentDeficits: new Map() };
  }
  const reagents = getProductReagents(product);
  if (!reagents) {
    return { complete: false, reagentDeficits: new Map() };
  }
  const room = Game.rooms[roomName];
  const productStock = room
    ? getTransferableStock(room, product)?.totalStock
    : undefined;
  if (!finiteNonNegative(productStock)) {
    return { complete: false, reagentDeficits: new Map() };
  }
  const targetGap = Math.max(0, targetAmount - productStock);
  const reagentDeficits = new Map<ResourceConstant, number>();
  facts.push({
    roomName,
    resource: product,
    amount: targetAmount,
    stableKey: `${planStableKey}:product`,
    status,
    bucket: "absoluteTarget",
  });
  if (targetGap > 0) {
    for (const reagent of reagents) {
      const localReagentStock = getTransferableStock(room!, reagent)?.totalStock;
      if (!finiteNonNegative(localReagentStock)) {
        return { complete: false, reagentDeficits: new Map() };
      }
      facts.push({
        roomName,
        resource: reagent,
        amount: targetGap,
        stableKey: `${planStableKey}:reagent:${reagent}`,
        status,
        bucket: "consumptiveDemand",
      });
      reagentDeficits.set(
        reagent,
        Math.max(0, targetGap - localReagentStock),
      );
    }
  }
  return { complete: true, reagentDeficits };
}

function synthesisDonorCandidates(
  targetRoomName: string,
  rawDonorRoomNames: unknown,
): { complete: boolean; roomNames: string[] } {
  if (!Array.isArray(rawDonorRoomNames)) {
    return { complete: false, roomNames: [] };
  }
  const explicit = rawDonorRoomNames.filter(validRoomName);
  if (explicit.length !== rawDonorRoomNames.length) {
    return { complete: false, roomNames: [] };
  }
  const roomNames =
    explicit.length > 0
      ? [...new Set(explicit)]
      : Object.values(Game.rooms)
          .filter(
            (room) =>
              room.name !== targetRoomName &&
              room.controller?.my &&
              !!room.terminal,
          )
          .map((room) => room.name);
  for (const roomName of roomNames) {
    const room = Game.rooms[roomName];
    if (!room || !room.controller?.my || !room.terminal) {
      return { complete: false, roomNames: [] };
    }
  }
  return { complete: true, roomNames: roomNames.sort() };
}

function appendSynthesisDonorFacts(
  facts: MarketProtectionFact[],
  candidateKeys: ReadonlySet<string>,
  runtime: NonNullable<typeof Memory.runtime>["synthesisControl"] | undefined,
  targetRoomName: string,
  planStableKey: string,
  reagentDeficits: ReadonlyMap<ResourceConstant, number>,
  rawDonorRoomNames: unknown,
  status: "active" | "paused",
): boolean {
  if (
    [...reagentDeficits.values()].every((deficit) => deficit <= 0)
  ) {
    return true;
  }
  const candidates = synthesisDonorCandidates(
    targetRoomName,
    rawDonorRoomNames,
  );
  if (!candidates.complete) return false;

  for (const [reagent, deficit] of reagentDeficits) {
    if (deficit <= 0) continue;
    const binding = asRecord(
      asRecord(runtime?.bindings)?.[`${targetRoomName}:${reagent}`],
    );
    const boundRoom =
      binding &&
      validRoomName(binding.fromRoomName) &&
      finiteNonNegative(binding.expiresAt) &&
      binding.expiresAt >= Game.time &&
      candidates.roomNames.includes(binding.fromRoomName)
        ? binding.fromRoomName
        : undefined;
    if (boundRoom) {
      facts.push({
        roomName: boundRoom,
        resource: reagent,
        amount: deficit,
        stableKey: `${planStableKey}:donor:${reagent}`,
        status,
        bucket: "consumptiveDemand",
      });
      continue;
    }

    for (const donorRoomName of candidates.roomNames) {
      if (
        !candidateKeys.has(
          getMarketProtectionEntryKey(donorRoomName, reagent),
        )
      ) {
        continue;
      }
      facts.push({
        roomName: donorRoomName,
        resource: reagent,
        amount: 0,
        stableKey: `${planStableKey}:unbound-donor:${reagent}:${donorRoomName}`,
        status,
        bucket: "consumptiveDemand",
        blocksSale: true,
        blockedReason: `synthesis donor unresolved for ${targetRoomName}/${reagent}`,
      });
    }
  }
  return true;
}

function collectSynthesis(candidates: readonly MarketProtectionCandidate[]): {
  active: SourceCollection;
  paused: SourceCollection;
} {
  const activeFacts: MarketProtectionFact[] = [];
  const pausedFacts: MarketProtectionFact[] = [];
  const rawConfig = Memory.cfg?.synthesisControl;
  if (rawConfig?.enabled !== true) {
    return {
      active: { complete: true, facts: [] },
      paused: { complete: true, facts: [] },
    };
  }

  const runtime = Memory.runtime?.synthesisControl;
  let activeComplete = runtime?.updatedAt === Game.time;
  let pausedComplete = runtime?.updatedAt === Game.time;
  const candidateKeys = new Set(
    candidates.map((candidate) =>
      getMarketProtectionEntryKey(candidate.roomName, candidate.resource),
    ),
  );
  const configuredRooms = asRecord(rawConfig.rooms) || {};

  for (const [roomName, rawRoomConfig] of Object.entries(configuredRooms)) {
    if (!validRoomName(roomName)) {
      activeComplete = false;
      continue;
    }
    const roomConfig = asRecord(rawRoomConfig);
    if (!roomConfig || roomConfig.enabled === false) continue;
    const roomDonors = roomConfig.donorRoomNames ?? [];
    const rawReactions = roomConfig.reactions;
    if (rawReactions !== undefined && !Array.isArray(rawReactions)) {
      activeComplete = false;
      continue;
    }
    const reactions = Array.isArray(rawReactions) ? rawReactions : [];
    for (const rawReaction of reactions) {
      const reaction = asRecord(rawReaction);
      if (
        !reaction ||
        !validResource(reaction.product) ||
        !finiteNonNegative(reaction.targetAmount) ||
        reaction.targetAmount <= 0
      ) {
        activeComplete = false;
        continue;
      }
      try {
        const planKey = synthesisPlanStableKey(roomName, reaction.product);
        const appended = appendSynthesisPlanFacts(
          activeFacts,
          roomName,
          planKey,
          reaction.product,
          reaction.targetAmount,
          "active",
        );
        activeComplete =
          appended.complete &&
          appendSynthesisDonorFacts(
            activeFacts,
            candidateKeys,
            runtime,
            roomName,
            planKey,
            appended.reagentDeficits,
            reaction.donorRoomNames ?? roomDonors,
            "active",
          ) &&
          activeComplete;
      } catch {
        activeComplete = false;
      }
    }

    const state = runtime?.rooms?.[roomName];
    if (!state) {
      activeComplete = false;
      pausedComplete = false;
      continue;
    }
    if (state.activeProduct) {
      try {
        const planKey = synthesisPlanStableKey(roomName, state.activeProduct);
        const appended = appendSynthesisPlanFacts(
            activeFacts,
            roomName,
            planKey,
            state.activeProduct,
            state.targetAmount ?? 0,
            "active",
          );
        activeComplete =
          appended.complete &&
          appendSynthesisDonorFacts(
            activeFacts,
            candidateKeys,
            runtime,
            roomName,
            planKey,
            appended.reagentDeficits,
            roomDonors,
            "active",
          ) &&
          activeComplete;
      } catch {
        activeComplete = false;
      }
    }
    const pausedPlan = state.boostPause?.pausedPlan;
    if (pausedPlan) {
      try {
        const planKey = synthesisPlanStableKey(
          roomName,
          pausedPlan.product,
        );
        const appended = appendSynthesisPlanFacts(
            pausedFacts,
            roomName,
            planKey,
            pausedPlan.product,
            pausedPlan.targetAmount,
            "paused",
          );
        pausedComplete =
          appended.complete &&
          appendSynthesisDonorFacts(
            pausedFacts,
            candidateKeys,
            runtime,
            roomName,
            planKey,
            appended.reagentDeficits,
            pausedPlan.donorRoomNames ?? roomDonors,
            "paused",
          ) &&
          pausedComplete;
      } catch {
        pausedComplete = false;
      }
    }
  }

  return {
    active: { complete: activeComplete, facts: activeFacts },
    paused: { complete: pausedComplete, facts: pausedFacts },
  };
}

function collectHub(
  candidates: readonly MarketProtectionCandidate[],
): SourceCollection {
  const cfg = Memory.cfg?.hub;
  if (cfg?.enabled !== true) {
    return { complete: true, facts: [] };
  }
  if (!validRoomName(cfg.hubRoomName)) {
    return { complete: false, facts: [] };
  }

  const runtime = Memory.runtime?.hub;
  const snapshot = readFreshCommittedHubProtectionSnapshot(
    runtime,
    cfg,
    Game.time,
  );
  if (!snapshot) {
    return { complete: false, facts: [] };
  }

  let complete = true;
  const facts: MarketProtectionFact[] = [];
  const reserve = snapshot.marker.hubReservePerCompound;
  for (const resource of snapshot.marker.targetCompounds) {
    if (!validResource(resource)) {
      complete = false;
      continue;
    }
    facts.push({
      roomName: cfg.hubRoomName,
      resource,
      amount: reserve,
      stableKey: `hub:target:${cfg.hubRoomName}:${resource}`,
      status: "active",
      bucket: "absoluteTarget",
    });
  }

  const distributed = snapshot.distributed;
  // `planDistributedSynthesis` seeds allocationLedger from effective room
  // inventories, then decrements it as assignments and routes consume stock.
  // Persisted roomCommitments are therefore residual available supply, not
  // production demand. Only the concrete assignments and routes below are
  // protection commitments.

  for (const rawAssignment of distributed.dispatchAssignments) {
    const assignment = asRecord(rawAssignment);
    if (
      !assignment ||
      !validRoomName(assignment.roomName) ||
      !validResource(assignment.product) ||
      !finiteNonNegative(assignment.targetAmount)
    ) {
      complete = false;
      continue;
    }
    try {
      const appended = appendSynthesisPlanFacts(
          facts,
          assignment.roomName,
          synthesisPlanStableKey(assignment.roomName, assignment.product),
          assignment.product,
          assignment.targetAmount,
          "active",
        );
      complete = appended.complete && complete;
    } catch {
      complete = false;
    }
  }

  for (const [index, rawRoute] of (
    distributed.routeDecisions
  ).entries()) {
    const route = asRecord(rawRoute);
    if (
      !route ||
      !validRoomName(route.fromRoom) ||
      !validRoomName(route.toRoom) ||
      !validResource(route.resource) ||
      !finiteNonNegative(route.amount)
    ) {
      complete = false;
      continue;
    }
    facts.push({
      roomName: route.fromRoom,
      resource: route.resource,
      amount: route.amount,
      stableKey: `hub:route:${index}:${route.fromRoom}->${route.toRoom}:${route.resource}`,
      status: "pending",
      bucket: "hubCommitments",
    });
  }

  for (const candidate of candidates) {
    if (candidate.roomName !== cfg.hubRoomName) continue;
    const room = Game.rooms[candidate.roomName];
    const stock = room
      ? getTransferableStock(room, candidate.resource)
      : undefined;
    if (!stock) {
      complete = false;
      continue;
    }
    const declaredSurplus =
      snapshot.baseMineralSurplus.byRoom[candidate.roomName]?.[
        candidate.resource
      ];
    const sellable = finiteNonNegative(declaredSurplus) ? declaredSurplus : 0;
    facts.push({
      roomName: candidate.roomName,
      resource: candidate.resource,
      amount: Math.max(0, stock.totalStock - sellable),
      stableKey: `hub:surplus-limit:${candidate.roomName}:${candidate.resource}`,
      status: "active",
      bucket: "absoluteTarget",
    });
  }

  return { complete, facts };
}

function reactionDemandAmount(amount: unknown): number | undefined {
  if (
    !finiteNonNegative(amount) ||
    amount <= 0 ||
    typeof LAB_REACTION_AMOUNT !== "number" ||
    !Number.isFinite(LAB_REACTION_AMOUNT) ||
    LAB_REACTION_AMOUNT <= 0
  ) {
    return undefined;
  }
  const normalized =
    Math.ceil(amount / LAB_REACTION_AMOUNT) * LAB_REACTION_AMOUNT;
  return finiteNonNegative(normalized) && normalized > 0
    ? normalized
    : undefined;
}

function expandReactionBaseAmounts(
  product: ResourceConstant,
  amount: unknown,
): { amount: number; baseAmounts: Map<ResourceConstant, number> } | undefined {
  const normalizedAmount = reactionDemandAmount(amount);
  if (normalizedAmount === undefined || BASE_REACTION_MINERALS.has(product)) {
    return undefined;
  }

  const baseAmounts = new Map<ResourceConstant, number>();
  const visit = (
    resource: ResourceConstant,
    required: number,
    path: readonly ResourceConstant[],
  ): boolean => {
    if (BASE_REACTION_MINERALS.has(resource)) {
      baseAmounts.set(resource, (baseAmounts.get(resource) || 0) + required);
      return true;
    }
    if (path.includes(resource) || path.length >= 20) return false;

    let reagents: [ResourceConstant, ResourceConstant] | null;
    try {
      reagents = getProductReagents(resource);
    } catch {
      return false;
    }
    if (
      !reagents ||
      reagents.length !== 2 ||
      !validResource(reagents[0]) ||
      !validResource(reagents[1])
    ) {
      return false;
    }
    const nextPath = [...path, resource];
    return (
      visit(reagents[0], required, nextPath) &&
      visit(reagents[1], required, nextPath)
    );
  };

  if (!visit(product, normalizedAmount, [])) return undefined;
  if (
    baseAmounts.size === 0 ||
    [...baseAmounts.values()].some(
      (baseAmount) => !finiteNonNegative(baseAmount) || baseAmount <= 0,
    )
  ) {
    return undefined;
  }
  return { amount: normalizedAmount, baseAmounts };
}

function appendBoostWarReactionDemand(
  facts: MarketProtectionFact[],
  roomName: string,
  stablePrefix: string,
  product: ResourceConstant,
  amount: unknown,
): boolean {
  const expanded = expandReactionBaseAmounts(product, amount);
  if (!expanded) return false;

  facts.push({
    roomName,
    resource: product,
    amount: expanded.amount,
    stableKey: stablePrefix,
    status: "active",
    bucket: "boostWar",
  });
  for (const [baseResource, baseAmount] of [
    ...expanded.baseAmounts.entries(),
  ].sort(([left], [right]) => left.localeCompare(right))) {
    facts.push({
      roomName,
      resource: baseResource,
      amount: baseAmount,
      stableKey: `${stablePrefix}:base:${baseResource}`,
      status: "active",
      bucket: "boostWar",
    });
  }
  return true;
}

function boostContractStablePrefix(
  taskId: string,
  product: ResourceConstant,
): string {
  return `boost-contract:${taskId}:${product}`;
}

function appendPowerBankHarvestDemand(
  facts: MarketProtectionFact[],
): boolean {
  const tasks = Memory.data?.powerBankHarvest;
  if (tasks === undefined) return true;
  if (!asRecord(tasks)) return false;

  let complete = true;
  for (const rawTask of Object.values(tasks)) {
    const task = asRecord(rawTask);
    if (!task || typeof task.status !== "string") {
      complete = false;
      continue;
    }
    if (TERMINAL_POWER_BANK_STATUSES.has(task.status)) continue;
    if (
      typeof task.id !== "string" ||
      task.id.length === 0 ||
      !validRoomName(task.sourceRoom) ||
      !Number.isSafeInteger(task.tier) ||
      (task.tier as number) <= 0
    ) {
      // A discovered task is resolved by powerBankHarvest after market-sale
      // in the main loop. Until its source/tier is known, block rather than
      // expose a one-tick unprotected production window.
      complete = false;
      continue;
    }
    const requirements = POWER_BANK_BOOST_REQUIREMENTS[task.tier as number];
    if (!requirements) {
      complete = false;
      continue;
    }
    const compounds = [
      ...new Set<ResourceConstant>([
        ...requirements.attacker,
        ...requirements.healer,
      ]),
    ];
    if (compounds.length === 0) {
      complete = false;
      continue;
    }
    for (const compound of compounds) {
      complete =
        appendBoostWarReactionDemand(
          facts,
          task.sourceRoom,
          boostContractStablePrefix(task.id, compound),
          compound,
          typeof LAB_MINERAL_CAPACITY === "number"
            ? LAB_MINERAL_CAPACITY
            : undefined,
        ) && complete;
    }
  }
  return complete;
}

function collectBoost(): SourceCollection {
  let complete = true;
  const facts: MarketProtectionFact[] = [];
  const defenseConfig = Memory.cfg?.homeDefense;
  const configuredTarget = defenseConfig?.boostTarget;
  const target =
    configuredTarget === undefined || configuredTarget === 0
      ? 1_000
      : finiteNonNegative(configuredTarget)
        ? configuredTarget
        : undefined;
  if (configuredTarget !== undefined && target === undefined) {
    complete = false;
  }
  for (const [roomName, rawRoom] of Object.entries(
    defenseConfig?.rooms || {},
  )) {
    const roomConfig = asRecord(rawRoom);
    if (!roomConfig || !validRoomName(roomName)) {
      complete = false;
      continue;
    }
    if (typeof roomConfig.boostLabId !== "string") continue;
    if (target === 0) continue;
    if (target === undefined) {
      complete = false;
      continue;
    }
    complete =
      appendBoostWarReactionDemand(
        facts,
        roomName,
        `boost:homeDefense:${roomName}`,
        RESOURCE_CATALYZED_UTRIUM_ACID,
        target,
      ) && complete;
  }

  const prepStore = Memory.runtime?.powerBankBoost;
  if (prepStore !== undefined && !asRecord(prepStore)) {
    complete = false;
  } else {
    for (const [taskKey, rawPrep] of Object.entries(prepStore || {})) {
      const prep = asRecord(rawPrep);
      const labs = asRecord(prep?.labs);
      if (
        !prep ||
        !labs ||
        !validRoomName(prep.sourceRoomName) ||
        typeof prep.taskId !== "string"
      ) {
        complete = false;
        continue;
      }
      for (const rawAssignment of Object.values(labs)) {
        const assignment = asRecord(rawAssignment);
        if (!assignment || !validResource(assignment.compound)) {
          complete = false;
          continue;
        }
        complete =
          appendBoostWarReactionDemand(
            facts,
            prep.sourceRoomName,
            boostContractStablePrefix(
              prep.taskId || taskKey,
              assignment.compound,
            ),
            assignment.compound,
            typeof LAB_MINERAL_CAPACITY === "number"
              ? LAB_MINERAL_CAPACITY
              : undefined,
          ) && complete;
      }
    }
  }
  complete = appendPowerBankHarvestDemand(facts) && complete;
  return { complete, facts };
}

function collectWar(): SourceCollection {
  const store = Memory.data?.war;
  if (store !== undefined && !asRecord(store)) {
    return { complete: false, facts: [] };
  }

  let complete = true;
  const facts: MarketProtectionFact[] = [];
  for (const rawTask of Object.values(store || {})) {
    const task = asRecord(rawTask);
    if (
      !task ||
      !validRoomName(task.sourceRoom) ||
      typeof task.status !== "string"
    ) {
      complete = false;
      continue;
    }
    if (task.status === "done" || task.status === "failed") continue;
    if (task.squad !== "t3Duo" && task.boostTier !== "t3") continue;
    const activeGeneration = asRecord(task.activeGeneration);
    const boostTaskId =
      typeof activeGeneration?.boostTaskId === "string" &&
      activeGeneration.boostTaskId.length > 0
        ? activeGeneration.boostTaskId
        : validRoomName(task.targetRoom)
          ? `war:${task.sourceRoom}:${task.targetRoom}`
          : undefined;
    if (!boostTaskId) {
      complete = false;
      continue;
    }
    for (const resource of WAR_T3_BOOSTS) {
      complete =
        appendBoostWarReactionDemand(
          facts,
          task.sourceRoom,
          boostContractStablePrefix(boostTaskId, resource),
          resource,
          typeof LAB_MINERAL_CAPACITY === "number"
            ? LAB_MINERAL_CAPACITY
            : undefined,
        ) && complete;
    }
  }
  return { complete, facts };
}

function normalizeManagedOrders(
  managedOrders: LiveManagedOrderCollection | undefined,
): readonly LiveManagedOrderExposure[] | undefined {
  if (!managedOrders) return undefined;
  return Array.isArray(managedOrders)
    ? managedOrders
    : Object.values(managedOrders);
}

function collectManagedExposure(
  managedOrders: LiveManagedOrderCollection | undefined,
  directStrategyActive: boolean,
): SourceCollection {
  const marketData = Memory.data?.marketSaleAutomation;
  const explicit = normalizeManagedOrders(managedOrders);
  const rawManaged = explicit ?? Object.values(marketData?.managedOrders || {});
  let complete =
    explicit !== undefined ||
    marketData === undefined ||
    asRecord(marketData.managedOrders) !== undefined;
  const facts: MarketProtectionFact[] = [];
  const orderLocation = new Map<
    string,
    { roomName: string; resource: ResourceConstant }
  >();

  for (const rawOrder of rawManaged) {
    const order = asRecord(rawOrder);
    if (
      !order ||
      typeof order.orderId !== "string" ||
      !validRoomName(order.roomName) ||
      !validResource(order.resourceType) ||
      !finiteNonNegative(order.remainingExposure)
    ) {
      complete = false;
      continue;
    }
    const liveOrder = Game.market?.orders?.[order.orderId];
    const liveRemaining = finiteNonNegative(liveOrder?.remainingAmount)
      ? liveOrder.remainingAmount
      : finiteNonNegative(liveOrder?.amount)
        ? liveOrder.amount
        : 0;
    const amount = Math.max(order.remainingExposure, liveRemaining);
    orderLocation.set(order.orderId, {
      roomName: order.roomName,
      resource: order.resourceType,
    });
    facts.push({
      roomName: order.roomName,
      resource: order.resourceType,
      amount,
      stableKey: `managed-order:${order.orderId}`,
      managedOrderId: order.orderId,
      status: "active",
    });
  }

  const pendingCreate = asRecord(marketData?.pendingCreate);
  if (pendingCreate && finiteNonNegative(pendingCreate.exposure)) {
    const tuple = asRecord(pendingCreate.tuple);
    if (
      !tuple ||
      !validRoomName(tuple.roomName) ||
      !validResource(tuple.resourceType) ||
      typeof pendingCreate.requestId !== "string"
    ) {
      complete = false;
    } else {
      facts.push({
        roomName: tuple.roomName,
        resource: tuple.resourceType,
        amount: pendingCreate.exposure,
        stableKey: `pending-create:${pendingCreate.requestId}`,
        status: "pending",
      });
    }
  } else if (pendingCreate) {
    complete = false;
  }

  const marketDataRecord = asRecord(marketData);
  const rawDirectAutomation =
    marketDataRecord?.directAutomation;
  const directAutomation = asRecord(rawDirectAutomation);
  const directMigrationBlocker =
    directAutomation?.migrationBlockedReason;
  const rawQuarantine =
    directAutomation?.quarantinedPendingDirectDeals;
  const quarantine = asRecord(rawQuarantine);
  const ledger = asRecord(directAutomation?.ledger);
  const ledgerBlocker = asRecord(ledger?.blocker);
  const pendingDirectRecord = asRecord(
    directAutomation?.pendingDirectDeals,
  );
  const quarantineKeys = Object.keys(quarantine || {});
  const inactiveMissingDirectState =
    !directStrategyActive &&
    directAutomation?.capability === "market-direct-continuous" &&
    directAutomation?.migrationStatus === "blocked" &&
    directMigrationBlocker === "direct_state_missing" &&
    ledgerBlocker?.code === "direct_state_missing" &&
    ledger?.pending === undefined &&
    pendingDirectRecord !== undefined &&
    Object.keys(pendingDirectRecord).length === 0 &&
    quarantineKeys.length === 1 &&
    quarantineKeys[0] ===
      "__continuous_blocked__:direct_state_missing" &&
    Array.isArray(directAutomation?.directDealOutcomes) &&
    directAutomation.directDealOutcomes.length === 0 &&
    Array.isArray(
      directAutomation?.processedDirectTransactionKeys,
    ) &&
    directAutomation.processedDirectTransactionKeys.length === 0 &&
    directAutomation?.directConfirmedDealCount === 0 &&
    directAutomation?.directPausedForReview === true;
  if (
    (rawDirectAutomation !== undefined && !directAutomation) ||
    (!inactiveMissingDirectState &&
      ((directMigrationBlocker !== undefined &&
        directMigrationBlocker !==
          "direct_qualification_state_invalid") ||
        (rawQuarantine !== undefined &&
          (!quarantine || quarantineKeys.length > 0))))
  ) {
    // Quarantine 中的损坏 WAL 不能安全归属 room/resource。把完整
    // managedExposure 源标为 stale，使所有候选 sellableAmount=0。
    complete = false;
  }
  const rawPendingDirectDeals = marketDataRecord?.pendingDirectDeals;
  const pendingDirectDeals = asRecord(rawPendingDirectDeals);
  if (rawPendingDirectDeals !== undefined && !pendingDirectDeals) {
    complete = false;
  } else {
    for (const [requestId, rawPending] of Object.entries(
      pendingDirectDeals || {},
    )) {
      const pending = asRecord(rawPending);
      const roomName = pending?.canaryRoomName ?? pending?.roomName;
      const resource = pending?.resource ?? pending?.resourceType;
      const amount = pending?.dealAmount ?? pending?.amount;
      if (
        !pending ||
        !validRoomName(roomName) ||
        !validResource(resource) ||
        !finiteNonNegative(amount) ||
        amount <= 0 ||
        typeof pending.status !== "string" ||
        !["prepared", "submitted", "reconcile_gap"].includes(
          pending.status,
        )
      ) {
        complete = false;
        continue;
      }
      facts.push({
        roomName,
        resource,
        amount,
        stableKey: `pending-direct:${requestId}`,
        status: "pending",
      });
    }
  }

  const pendingMutations = asRecord(marketData?.pendingMutations);
  if (marketData && !pendingMutations) {
    complete = false;
  } else {
    for (const [orderId, rawMutation] of Object.entries(
      pendingMutations || {},
    )) {
      const mutation = asRecord(rawMutation);
      const location = orderLocation.get(orderId);
      if (
        !mutation ||
        !location ||
        !finiteNonNegative(mutation.conservativeExposure)
      ) {
        complete = false;
        continue;
      }
      facts.push({
        roomName: location.roomName,
        resource: location.resource,
        amount: mutation.conservativeExposure,
        stableKey: `managed-order:${orderId}`,
        managedOrderId: orderId,
        status: "pending",
      });
    }
  }

  return { complete, facts };
}

function toSources(
  config: MarketSaleAutomationConfig,
  candidates: readonly MarketProtectionCandidate[],
  managedOrders: LiveManagedOrderCollection | undefined,
  options: CollectLiveMarketSaleProtectionOptions,
): MutableSourceMap {
  const stock = collectStock(candidates);
  const floor = collectRoomFloors(candidates);
  const forecast = collectForecast(config, candidates, options);
  const reservations = collectResourceReservations();
  const outgoing = collectOutgoingTransfers();
  const carrier = collectCarrierCommitments(candidates);
  const factory = collectFactory(candidates);
  const synthesis = collectSynthesis(candidates);
  const hub = collectHub(candidates);
  const boost = collectBoost();
  const war = collectWar();
  const directStrategyActive =
    config.mode === "direct" ||
    (config.mode === "shadow" &&
      config.shadowStrategy === "direct");
  const exposure = collectManagedExposure(
    managedOrders,
    directStrategyActive,
  );

  return {
    stock: currentSnapshot(stock.complete, stock.facts),
    floor: currentSnapshot(floor.complete, floor.facts),
    forecast: currentSnapshot(forecast.complete, forecast.facts),
    resourceReservations: currentSnapshot(
      reservations.complete,
      reservations.facts,
    ),
    blockedOutgoing: currentSnapshot(outgoing.complete, outgoing.facts),
    carrierInFlight: currentSnapshot(carrier.complete, carrier.facts),
    factoryTargets: currentSnapshot(
      factory.targets.complete,
      factory.targets.facts,
    ),
    factoryComponents: currentSnapshot(
      factory.components.complete,
      factory.components.facts,
    ),
    factoryTasks: currentSnapshot(factory.tasks.complete, factory.tasks.facts),
    synthesisActive: currentSnapshot(
      synthesis.active.complete,
      synthesis.active.facts,
    ),
    synthesisPaused: currentSnapshot(
      synthesis.paused.complete,
      synthesis.paused.facts,
    ),
    hub: currentSnapshot(hub.complete, hub.facts),
    boost: currentSnapshot(boost.complete, boost.facts),
    war: currentSnapshot(war.complete, war.facts),
    managedExposure: currentSnapshot(exposure.complete, exposure.facts),
  };
}

// ── 同 tick 结果 memo（提交 D）─────────────────────────────────────────────
// planning tick 的外层收集与 V3 full-read 的 fresh 收集使用完全相同的输入
// （同 tick 的 config / managedOrders / canonical options 均为同一引用），
// 而 toSources 的全部来源都是 Game/Memory 的纯读取——同 tick 内输出确定
// 性相同。第二次调用直接复用只读 ledger，消除整段重复扫描。
// 失效：Game.time 变化、任一输入引用变化；global reset 后自然重建。
// 单槽缓存：重复读总是紧邻发生，无需多槽。
interface ProtectionLedgerTickMemo {
  tick: number;
  config: MarketSaleAutomationConfig;
  managedOrders: LiveManagedOrderCollection | undefined;
  options: CollectLiveMarketSaleProtectionOptions;
  ledger: MarketSaleProtectionLedger;
}

let protectionLedgerTickMemo: ProtectionLedgerTickMemo | undefined;

export function clearProtectionLedgerTickMemoForTest(): void {
  protectionLedgerTickMemo = undefined;
  protectionLedgerMemoHits = 0;
}

export function getProtectionLedgerMemoHitsForTest(): number {
  return protectionLedgerMemoHits;
}

let protectionLedgerMemoHits = 0;

function recordProtectionLedgerMemoHit(): void {
  protectionLedgerMemoHits += 1;
  const globalWithCounter = global as typeof global & {
    __marketPerformanceCounters?: Record<string, number>;
  };
  const counters = (globalWithCounter.__marketPerformanceCounters ??= {});
  counters.duplicateProtectionReadsAvoided = (counters.duplicateProtectionReadsAvoided || 0) + 1;
}

export function collectLiveMarketSaleProtectionLedger(
  config: MarketSaleAutomationConfig,
  managedOrders?: LiveManagedOrderCollection,
  options: CollectLiveMarketSaleProtectionOptions = {},
): MarketSaleProtectionLedger {
  const memo = protectionLedgerTickMemo;
  if (
    memo &&
    memo.tick === Game.time &&
    memo.config === config &&
    memo.managedOrders === managedOrders &&
    memo.options === options
  ) {
    recordProtectionLedgerMemoHit();
    return memo.ledger;
  }
  const candidates = resolveCandidates(config, options);
  const ledger = buildMarketSaleProtectionLedger({
    currentTick: Game.time,
    revision: Game.time,
    observedAt: Game.time,
    expiresAt: Game.time,
    candidates,
    sources: toSources(config, candidates, managedOrders, options),
  });
  protectionLedgerTickMemo = {
    tick: Game.time,
    config,
    managedOrders,
    options,
    ledger,
  };
  return ledger;
}
