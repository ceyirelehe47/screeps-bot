/**
 * Factory target queue planning, carrier logistics, production state machine,
 * and guarded purchase of missing regional raw resources.
 *
 * Normalizes config, enumerates eligible rooms, resolves the target queue with
 * recursive COMMODITIES decomposition, drives the production lifecycle
 * (carrier supply/unload tasks, factory.produce(), stage transitions). Factory
 * product selling is owned by the market-sale automation domain.
 */

import { normalizeBoolean, normalizeNumber } from "@/runtime/configNormalize";
import { getReservedProductionAmountExcludingOwner } from "@/runtime/resourceReservation";
import {
  replaceCarrierTasksForProducerRoom,
  type CarrierTaskDraft,
} from "@/runtime/carrierTaskBoard";
import {
  createSingleStepDraft,
  terminalStorageKind,
} from "@/runtime/carrierTaskHelpers";
import {
  declareMarketActionIntent,
  executeMarketDeal,
} from "@/runtime/marketActionArbiter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FactoryStage =
  | "idle"
  | "acquiring"
  | "loading"
  | "producing"
  | "unloading"
  | "blocked"
  | "sleeping";

interface TargetEntry {
  resource: ResourceConstant;
  targetAmount: number;
  cap: number;
}

interface MarketConfig {
  enabled: boolean;
  sellResources: ResourceConstant[];
  minSellPrice: Partial<Record<ResourceConstant, number>>;
  minNetCredits: number;
  minOrderAmount: number;
  minPriceRatio: number;
  maxEnergyCostRatio: number;
  orderBlacklist: Set<string>;
  orderAllowlist: Set<string>;
  roomAllowlist: Set<string>;
  maxBatch: number;
  purchaseEnabled: boolean;
  maxBuyPrice: Partial<Record<ResourceConstant, number>>;
  buyMaxBatch: number;
  dailyBudget: number;
  creditReserve: number;
  buyResources: ResourceConstant[];
}

interface RoomPlanConfig {
  enabled: boolean;
  targetQueue: TargetEntry[];
  resourceFloors: Partial<Record<ResourceConstant, number>>;
  productionCaps: Partial<Record<ResourceConstant, number>>;
  sleepTicks: number;
}

interface FactoryControlConfig {
  enabled: boolean;
  terminalEnergyReserve: number;
  market: MarketConfig;
  targetQueue: TargetEntry[];
  resourceFloors: Partial<Record<ResourceConstant, number>>;
  productionCaps: Partial<Record<ResourceConstant, number>>;
  sleepSettings: {
    cooldownOnError: number;
    cooldownOnMissing: number;
    maxSleepTicks: number;
  };
  rooms: Record<string, RoomPlanConfig>;
}

interface RoomRuntimeState {
  stage: FactoryStage;
  activeTarget?: ResourceConstant;
  missing?: Partial<Record<ResourceConstant, number>>;
  sleepReason?: string;
  sleepUntilTick?: number;
  lastError?: string;
  lastTransitionAt: number;
  loadingSinceTick?: number;
}

interface FactoryControlRuntime {
  updatedAt?: number;
  rooms: Record<string, RoomRuntimeState>;
  claimedOrders?: Array<{
    orderId: string;
    roomName: string;
    tick: number;
    purpose: "buy";
    credits?: number;
  }>;
}

type FactoryTaskType = "decompress_battery";
type FactoryTaskStatus = "pending" | "loading" | "producing" | "unloading" | "done" | "cancelled" | "failed";

export interface FactoryTask {
  id: string;
  roomName: string;
  type: FactoryTaskType;
  status: FactoryTaskStatus;
  requestedBatteryAmount: number;
  remainingBatteryAmount: number;
  producedEnergyAmount: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  lastError?: string;
}

export interface AddFactoryTaskOptions {
  amount: number;
}

export interface AddFactoryTaskResult {
  ok: true;
  taskId: string;
  task: FactoryTask;
}

export interface CancelFactoryTaskResult {
  ok: true;
  taskId: string;
  previousStatus: FactoryTaskStatus;
}

type FactoryTaskStore = Record<string, FactoryTask>;

// ---------------------------------------------------------------------------
// Config normalization
// ---------------------------------------------------------------------------

function normalizeTargetEntries(
  raw: unknown,
): TargetEntry[] {
  if (!Array.isArray(raw)) return [];

  const entries: TargetEntry[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.length > 0) {
      entries.push({
        resource: item as ResourceConstant,
        targetAmount: 0,
        cap: 0,
      });
      continue;
    }

    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const resource = rec.resource;
    if (typeof resource !== "string" || resource.length === 0) continue;

    entries.push({
      resource: resource as ResourceConstant,
      targetAmount:
        typeof rec.targetAmount === "number" && Number.isFinite(rec.targetAmount) && rec.targetAmount > 0
          ? Math.floor(rec.targetAmount)
          : 0,
      cap:
        typeof rec.cap === "number" && Number.isFinite(rec.cap) && rec.cap > 0
          ? Math.floor(rec.cap)
          : 0,
    });
  }
  return entries;
}

function normalizeResourceMap(raw: unknown): Partial<Record<ResourceConstant, number>> {
  if (!raw || typeof raw !== "object") return {};
  const result: Partial<Record<ResourceConstant, number>> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val === "number" && Number.isFinite(val) && val >= 0) {
      result[key as ResourceConstant] = Math.floor(val);
    }
  }
  return result;
}

function normalizeStringSet(raw: unknown): Set<string> {
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((v): v is string => typeof v === "string" && v.length > 0));
}

function normalizeSleepSettings(raw: unknown): FactoryControlConfig["sleepSettings"] {
  if (!raw || typeof raw !== "object") {
    return { cooldownOnError: 20, cooldownOnMissing: 10, maxSleepTicks: 500 };
  }
  const s = raw as Record<string, unknown>;
  return {
    cooldownOnError: normalizeNumber(s.cooldownOnError, 20, 1, 1000),
    cooldownOnMissing: normalizeNumber(s.cooldownOnMissing, 10, 1, 1000),
    maxSleepTicks: normalizeNumber(s.maxSleepTicks, 500, 1, 10000),
  };
}

function normalizeSellPriceMap(raw: unknown): Partial<Record<ResourceConstant, number>> {
  if (!raw || typeof raw !== "object") return {};
  const result: Partial<Record<ResourceConstant, number>> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val === "number" && Number.isFinite(val) && val >= 0) {
      result[key as ResourceConstant] = val;
    }
  }
  return result;
}

function normalizeResourceList(raw: unknown): ResourceConstant[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is ResourceConstant => typeof v === "string" && v.length > 0);
}

function normalizeMarketConfig(raw: unknown): MarketConfig {
  if (!raw || typeof raw !== "object") {
    return {
      enabled: false,
      sellResources: [],
      minSellPrice: {},
      minNetCredits: 0,
      minOrderAmount: 100,
      minPriceRatio: 0,
      maxEnergyCostRatio: 1,
      orderBlacklist: new Set(),
      orderAllowlist: new Set(),
      roomAllowlist: new Set(),
      maxBatch: 5000,
      purchaseEnabled: false,
      maxBuyPrice: {},
      buyMaxBatch: 5000,
      dailyBudget: 0,
      creditReserve: 10000,
      buyResources: [],
    };
  }
  const m = raw as Record<string, unknown>;
  return {
    enabled: normalizeBoolean(m.enabled, false),
    sellResources: normalizeResourceList(m.sellResources),
    minSellPrice: normalizeSellPriceMap(m.minSellPrice),
    minNetCredits: normalizeNumber(m.minNetCredits, 0, 0, 1e9),
    minOrderAmount: normalizeNumber(m.minOrderAmount, 100, 1, 1e6),
    minPriceRatio: normalizeNumber(m.minPriceRatio, 0, 0, 100),
    maxEnergyCostRatio: normalizeNumber(m.maxEnergyCostRatio, 1, 0, 100),
    orderBlacklist: normalizeStringSet(m.orderBlacklist),
    orderAllowlist: normalizeStringSet(m.orderAllowlist),
    roomAllowlist: normalizeStringSet(m.roomAllowlist),
    maxBatch: normalizeNumber(m.maxBatch, 5000, 1, 300000),
    purchaseEnabled: normalizeBoolean(m.purchaseEnabled, false),
    maxBuyPrice: normalizeSellPriceMap(m.maxBuyPrice),
    buyMaxBatch: normalizeNumber(m.buyMaxBatch, 5000, 1, 300000),
    dailyBudget: normalizeNumber(m.dailyBudget, 0, 0, 1e9),
    creditReserve: normalizeNumber(m.creditReserve, 10000, 0, 1e9),
    buyResources: normalizeResourceList(m.buyResources),
  };
}

function parseConfig(): FactoryControlConfig {
  const raw = Memory.cfg?.factoryControl;
  if (!raw || typeof raw !== "object") {
    return {
      enabled: false,
      terminalEnergyReserve: 0,
      market: normalizeMarketConfig(undefined),
      targetQueue: [],
      resourceFloors: {},
      productionCaps: {},
      sleepSettings: { cooldownOnError: 20, cooldownOnMissing: 10, maxSleepTicks: 500 },
      rooms: {},
    };
  }

  const rooms: Record<string, RoomPlanConfig> = {};
  const rawRooms = raw.rooms;
  if (rawRooms && typeof rawRooms === "object") {
    for (const [roomName, roomCfg] of Object.entries(rawRooms)) {
      if (!roomCfg || typeof roomCfg !== "object") continue;
      const rc = roomCfg as Record<string, unknown>;

      rooms[roomName] = {
        enabled: normalizeBoolean(rc.enabled, true),
        targetQueue: normalizeTargetEntries(rc.targetQueue ?? rc.targets),
        resourceFloors: normalizeResourceMap(rc.resourceFloors),
        productionCaps: normalizeResourceMap(rc.productionCaps),
        sleepTicks: normalizeNumber(rc.sleepTicks, 0, 0, 10000),
      };
    }
  }

  return {
    enabled: normalizeBoolean(raw.enabled, false),
    terminalEnergyReserve: normalizeNumber(raw.terminalEnergyReserve, 10000, 0, 500000),
    market: normalizeMarketConfig(raw.market),
    targetQueue: normalizeTargetEntries(raw.targetQueue ?? raw.targets),
    resourceFloors: normalizeResourceMap(raw.resourceFloors),
    productionCaps: normalizeResourceMap(raw.productionCaps),
    sleepSettings: normalizeSleepSettings(raw.sleepSettings),
    rooms,
  };
}

// ---------------------------------------------------------------------------
// Room eligibility
// ---------------------------------------------------------------------------

function findFactoryInRoom(room: Room): StructureFactory | null {
  const structures = room.find(FIND_MY_STRUCTURES, {
    filter: (s: Structure) => s.structureType === STRUCTURE_FACTORY,
  });
  return (structures[0] as StructureFactory | undefined) ?? null;
}

function isEligibleRoom(room: Room): boolean {
  if (!room.controller?.my) return false;
  if (!room.terminal) return false;
  const factory = findFactoryInRoom(room);
  return factory !== null;
}

// ---------------------------------------------------------------------------
// Resource stock helpers
// ---------------------------------------------------------------------------

function getRoomStock(room: Room, resource: ResourceConstant): number {
  let total = 0;
  if (room.storage) {
    total += room.storage.store.getUsedCapacity(resource) ?? 0;
  }
  if (room.terminal) {
    total += room.terminal.store.getUsedCapacity(resource) ?? 0;
  }
  const factory = findFactoryInRoom(room);
  if (factory) {
    total += factory.store.getUsedCapacity(resource) ?? 0;
  }
  return total;
}

function computeSurplus(
  room: Room,
  resource: ResourceConstant,
  floor: number,
  holderId: string,
): number {
  const stock = getRoomStock(room, resource);
  // factory 自排除：holderId 恒为自身 factory.id（game-object owner）。
  const reserved = getReservedProductionAmountExcludingOwner(room.name, resource, {
    kind: "game-object",
    id: holderId,
    roomName: room.name,
  });
  return Math.max(0, stock - floor - reserved);
}

// ---------------------------------------------------------------------------
// COMMODITIES decomposition
// ---------------------------------------------------------------------------

interface CommodityRecipe {
  amount: number;
  cooldown: number;
  level?: number;
  components: Partial<Record<ResourceConstant, number>>;
}

/**
 * Base resources that cannot be factory-produced (minerals, deposit resources,
 * energy, power). These terminate decomposition and appear in `missing`.
 */
const BASE_RESOURCES: Set<string> = new Set([
  "energy", "power",
  "H", "O", "U", "K", "L", "Z", "X", "G",
  "silicon", "biomass", "metal", "mist",
]);

const REGIONAL_RAW_RESOURCES: Set<string> = new Set([
  "mist", "biomass", "metal", "silicon",
]);

const FACTORY_CARRIER_TASK_PRODUCER = "factoryControl";
const FACTORY_TASK_PREFIX = "factoryTask";
const BATTERY_DECOMPRESS_BATCH_BATTERY = 50;
const BATTERY_DECOMPRESS_BATCH_ENERGY = 500;

function getCommodityRecipe(resource: ResourceConstant): CommodityRecipe | null {
  if (typeof COMMODITIES === "undefined") return null;
  const entry = (COMMODITIES as Record<string, CommodityRecipe>)[resource];
  if (!entry) return null;
  return entry;
}

function isProducible(resource: ResourceConstant): boolean {
  if (BASE_RESOURCES.has(resource)) return false;
  return getCommodityRecipe(resource) !== null;
}

function getRequiredFactoryLevel(resource: ResourceConstant): number {
  const recipe = getCommodityRecipe(resource);
  return recipe?.level ?? 0;
}

/**
 * Recursively walk COMMODITIES tree for a target product.
 * Returns the list of resources to produce in dependency order,
 * starting from the deepest missing component.
 *
 * If all components are available in sufficient surplus (above floors/reservations),
 * returns the original target. Otherwise returns the first missing producible component.
 * Base resources (not in COMMODITIES) that are missing are added to `missing`.
 */
interface DecompositionResult {
  /** The resource we should plan to produce (target or missing sub-component). */
  productionTarget: ResourceConstant;
  /** Base/producible resources that are missing and cannot be produced by factory. */
  missing: Partial<Record<ResourceConstant, number>>;
  /** Factory level required for the production target. */
  requiredLevel: number;
}

function decomposeTarget(
  targetResource: ResourceConstant,
  targetAmount: number,
  room: Room,
  resourceFloors: Partial<Record<ResourceConstant, number>>,
  holderId: string,
  visited: Set<ResourceConstant> = new Set(),
): DecompositionResult {
  // Guard against cycles
  if (visited.has(targetResource)) {
    return {
      productionTarget: targetResource,
      missing: {},
      requiredLevel: getRequiredFactoryLevel(targetResource),
    };
  }
  visited.add(targetResource);

  const recipe = getCommodityRecipe(targetResource);
  if (!recipe) {
    // Not a producible commodity — it's a base resource, report as missing
    return {
      productionTarget: targetResource,
      missing: { [targetResource]: targetAmount },
      requiredLevel: 0,
    };
  }

  const requiredLevel = recipe.level ?? 0;
  const components = recipe.components;

  // Check if we have enough surplus of each component
  const missing: Partial<Record<ResourceConstant, number>> = {};
  const missingProducible: Array<{ resource: ResourceConstant; needed: number }> = [];

  for (const [component, amountNeeded] of Object.entries(components)) {
    if (!amountNeeded || amountNeeded <= 0) continue;
    const comp = component as ResourceConstant;
    const floor = resourceFloors[comp] ?? 0;
    const surplus = computeSurplus(room, comp, floor, holderId);

    // Calculate total needed for the target amount
    const batchesNeeded = Math.ceil(targetAmount / recipe.amount);
    const totalNeeded = amountNeeded * batchesNeeded;

    if (surplus < totalNeeded) {
      const deficit = totalNeeded - surplus;
      if (isProducible(comp) && !BASE_RESOURCES.has(comp)) {
        missingProducible.push({ resource: comp, needed: deficit });
      } else {
        // Base or non-producible resource — report as missing
        missing[comp] = (missing[comp] ?? 0) + deficit;
      }
    }
  }

  // If we have missing producible components, recurse into the first one
  if (missingProducible.length > 0) {
    const firstMissing = missingProducible[0];
    const subResult = decomposeTarget(
      firstMissing.resource,
      firstMissing.needed,
      room,
      resourceFloors,
      holderId,
      new Set(visited),
    );

    // Merge missing from sub-result
    for (const [res, amt] of Object.entries(subResult.missing)) {
      if (amt && amt > 0) {
        missing[res as ResourceConstant] = (missing[res as ResourceConstant] ?? 0) + amt;
      }
    }

    return {
      productionTarget: subResult.productionTarget,
      missing,
      requiredLevel: subResult.requiredLevel,
    };
  }

  return {
    productionTarget: targetResource,
    missing,
    requiredLevel,
  };
}

// ---------------------------------------------------------------------------
// Target queue planning
// ---------------------------------------------------------------------------

function resolveTargetQueue(
  config: FactoryControlConfig,
  roomName: string,
): TargetEntry[] {
  const roomCfg = config.rooms[roomName];
  if (roomCfg && roomCfg.targetQueue.length > 0) {
    return roomCfg.targetQueue;
  }
  return config.targetQueue;
}

function resolveResourceFloors(
  config: FactoryControlConfig,
  roomName: string,
): Partial<Record<ResourceConstant, number>> {
  const roomCfg = config.rooms[roomName];
  if (roomCfg && Object.keys(roomCfg.resourceFloors).length > 0) {
    return roomCfg.resourceFloors;
  }
  return config.resourceFloors;
}

function resolveProductionCaps(
  config: FactoryControlConfig,
  roomName: string,
): Partial<Record<ResourceConstant, number>> {
  const roomCfg = config.rooms[roomName];
  if (roomCfg && Object.keys(roomCfg.productionCaps).length > 0) {
    return roomCfg.productionCaps;
  }
  return config.productionCaps;
}

// ---------------------------------------------------------------------------
// Runtime state helpers
// ---------------------------------------------------------------------------

function ensureRuntimeState(): FactoryControlRuntime {
  if (!Memory.runtime) {
    Memory.runtime = {};
  }
  if (!Memory.runtime.factoryControl) {
    Memory.runtime.factoryControl = {
      updatedAt: 0,
      rooms: {},
      claimedOrders: [],
    };
  }
  return Memory.runtime.factoryControl as unknown as FactoryControlRuntime;
}

function ensureFactoryTaskStore(): FactoryTaskStore {
  if (!Memory.data) {
    Memory.data = {};
  }
  if (!Memory.data.factoryTasks) {
    Memory.data.factoryTasks = {};
  }
  return Memory.data.factoryTasks as FactoryTaskStore;
}

function makeFactoryTaskId(roomName: string, type: FactoryTaskType, amount: number): string {
  return `${FACTORY_TASK_PREFIX}:${roomName}:${type}:${amount}`;
}

function isActiveFactoryTask(task: FactoryTask): boolean {
  return task.status !== "done" && task.status !== "cancelled" && task.status !== "failed";
}

function getActiveFactoryTaskForRoom(roomName: string): FactoryTask | null {
  const tasks = Object.values(ensureFactoryTaskStore())
    .filter((task) => task.roomName === roomName && isActiveFactoryTask(task))
    .sort((left, right) => left.createdAt - right.createdAt);
  return tasks[0] ?? null;
}

export function addFactoryTask(
  roomName: string,
  type: FactoryTaskType,
  options: AddFactoryTaskOptions,
): AddFactoryTaskResult | string {
  if (type !== "decompress_battery") {
    return `ERR_UNSUPPORTED_FACTORY_TASK:${type}`;
  }
  if (!options || !Number.isFinite(options.amount) || options.amount <= 0) {
    return "ERR_INVALID_AMOUNT";
  }

  const amount = Math.floor(options.amount);
  const taskId = makeFactoryTaskId(roomName, type, amount);
  const store = ensureFactoryTaskStore();
  const existing = store[taskId];
  if (existing && isActiveFactoryTask(existing)) {
    existing.requestedBatteryAmount += amount;
    existing.remainingBatteryAmount += amount;
    existing.updatedAt = Game.time;
    return { ok: true, taskId, task: existing };
  }

  const task: FactoryTask = {
    id: taskId,
    roomName,
    type,
    status: "pending",
    requestedBatteryAmount: amount,
    remainingBatteryAmount: amount,
    producedEnergyAmount: 0,
    createdAt: Game.time,
    updatedAt: Game.time,
  };
  store[taskId] = task;
  return { ok: true, taskId, task };
}

export function listFactoryTasks(roomName?: string): FactoryTask[] {
  return Object.values(ensureFactoryTaskStore())
    .filter((task) => !roomName || task.roomName === roomName)
    .sort((left, right) => left.createdAt - right.createdAt);
}

export function cancelFactoryTask(taskId: string): CancelFactoryTaskResult | string {
  const task = ensureFactoryTaskStore()[taskId];
  if (!task) {
    return `ERR_NO_FACTORY_TASK:${taskId}`;
  }
  if (!isActiveFactoryTask(task)) {
    return `ERR_FACTORY_TASK_NOT_ACTIVE:${taskId}`;
  }

  const previousStatus = task.status;
  task.status = "cancelled";
  task.updatedAt = Game.time;
  task.completedAt = Game.time;
  replaceCarrierTasksForProducerRoom(FACTORY_CARRIER_TASK_PRODUCER, task.roomName, []);
  return { ok: true, taskId, previousStatus };
}

function getRoomState(runtime: FactoryControlRuntime, roomName: string): RoomRuntimeState {
  if (!runtime.rooms[roomName]) {
    runtime.rooms[roomName] = {
      stage: "idle",
      lastTransitionAt: Game.time,
    };
  }
  return runtime.rooms[roomName];
}

function resolveSupplySourceStructure(
  room: Room,
  resource: ResourceConstant,
): StructureTerminal | StructureStorage | null {
  const terminalAmount = room.terminal?.store.getUsedCapacity(resource) ?? 0;
  const storageAmount = room.storage?.store.getUsedCapacity(resource) ?? 0;
  if (terminalAmount <= 0 && storageAmount <= 0) return null;
  if (terminalAmount >= storageAmount && room.terminal && terminalAmount > 0) {
    return room.terminal;
  }
  if (room.storage && storageAmount > 0) {
    return room.storage;
  }
  return room.terminal && terminalAmount > 0 ? room.terminal : null;
}

function generateFactorySupplyDrafts(
  room: Room,
  factory: StructureFactory,
  recipe: CommodityRecipe,
  roomName: string,
): CarrierTaskDraft[] {
  const drafts: CarrierTaskDraft[] = [];
  for (const [component, neededPerBatch] of Object.entries(recipe.components)) {
    if (!neededPerBatch || neededPerBatch <= 0) continue;
    const comp = component as ResourceConstant;

    const inFactory = factory.store.getUsedCapacity(comp) ?? 0;
    if (inFactory >= neededPerBatch) continue;

    const deficit = neededPerBatch - inFactory;
    const source = resolveSupplySourceStructure(room, comp);
    if (!source) continue;

    const sourceAmount = source.store.getUsedCapacity(comp) ?? 0;
    if (sourceAmount <= 0) continue;

    const fromKind = source.structureType === STRUCTURE_TERMINAL ? "terminal" : "storage";

    drafts.push(createSingleStepDraft({
      taskId: `factoryControl:factory_supply:${roomName}:${comp}`,
      type: "factory_supply",
      priority: 100,
      producer: FACTORY_CARRIER_TASK_PRODUCER,
      roomName,
      resource: comp,
      fromKind,
      toKind: "factory",
      fromId: source.id,
      toId: factory.id,
      amount: Math.min(deficit, sourceAmount),
    }));
  }
  return drafts;
}

function resolveFactoryUnloadTarget(
  room: Room,
  product: ResourceConstant,
): StructureTerminal | StructureStorage | null {
  if (room.terminal && room.terminal.store.getFreeCapacity(product) > 0) {
    return room.terminal;
  }
  const isLowRisk = product === RESOURCE_ENERGY || product === RESOURCE_BATTERY;
  if (isLowRisk && room.storage && room.storage.store.getFreeCapacity(product) > 0) {
    return room.storage;
  }
  return null;
}

function generateFactoryUnloadDraft(
  room: Room,
  factory: StructureFactory,
  product: ResourceConstant,
  roomName: string,
): CarrierTaskDraft | null {
  const productAmount = factory.store.getUsedCapacity(product) ?? 0;
  if (productAmount <= 0) return null;

  const target = resolveFactoryUnloadTarget(room, product);
  if (!target) return null;

  const toKind = terminalStorageKind(target);

  return createSingleStepDraft({
    taskId: `factoryControl:factory_unload:${roomName}:${product}`,
    type: "factory_unload",
    priority: 180,
    producer: FACTORY_CARRIER_TASK_PRODUCER,
    roomName,
    resource: product,
    fromKind: "factory",
    toKind,
    fromId: factory.id,
    toId: target.id,
    amount: productAmount,
  });
}

function generateBatteryDecompressSupplyDraft(
  room: Room,
  factory: StructureFactory,
  task: FactoryTask,
): CarrierTaskDraft | null {
  const inFactory = factory.store.getUsedCapacity(RESOURCE_BATTERY) ?? 0;
  const needed = Math.max(0, task.remainingBatteryAmount - inFactory);
  if (needed <= 0) return null;

  const source = resolveSupplySourceStructure(room, RESOURCE_BATTERY);
  if (!source) return null;

  const sourceAmount = source.store.getUsedCapacity(RESOURCE_BATTERY) ?? 0;
  if (sourceAmount <= 0) return null;

  const fromKind = source.structureType === STRUCTURE_TERMINAL ? "terminal" : "storage";
  return createSingleStepDraft({
    taskId: `${FACTORY_CARRIER_TASK_PRODUCER}:factory_task:${task.id}:supply`,
    type: "factory_supply",
    priority: 190,
    producer: FACTORY_CARRIER_TASK_PRODUCER,
    roomName: task.roomName,
    resource: RESOURCE_BATTERY,
    fromKind,
    toKind: "factory",
    fromId: source.id,
    toId: factory.id,
    amount: Math.min(needed, sourceAmount),
  });
}

function generateBatteryDecompressUnloadDraft(
  room: Room,
  factory: StructureFactory,
  task: FactoryTask,
): CarrierTaskDraft | null {
  const energyAmount = factory.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
  if (energyAmount <= 0) return null;

  const target = resolveFactoryUnloadTarget(room, RESOURCE_ENERGY);
  if (!target) return null;

  return createSingleStepDraft({
    taskId: `${FACTORY_CARRIER_TASK_PRODUCER}:factory_task:${task.id}:unload`,
    type: "factory_unload",
    priority: 190,
    producer: FACTORY_CARRIER_TASK_PRODUCER,
    roomName: task.roomName,
    resource: RESOURCE_ENERGY,
    fromKind: "factory",
    toKind: terminalStorageKind(target),
    fromId: factory.id,
    toId: target.id,
    amount: energyAmount,
  });
}

function executeBatteryDecompressTask(
  room: Room,
  factory: StructureFactory,
  state: RoomRuntimeState,
  task: FactoryTask,
  config: FactoryControlConfig,
): void {
  const previousStage = state.stage;
  state.activeTarget = RESOURCE_ENERGY;
  state.missing = undefined;
  state.sleepReason = undefined;
  state.lastError = undefined;

  const energyInFactory = factory.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
  if (energyInFactory > 0) {
    task.producedEnergyAmount = Math.max(task.producedEnergyAmount, energyInFactory);
    const unloadDraft = generateBatteryDecompressUnloadDraft(room, factory, task);
    if (unloadDraft) {
      task.status = "unloading";
      state.stage = "unloading";
      replaceCarrierTasksForProducerRoom(FACTORY_CARRIER_TASK_PRODUCER, task.roomName, [unloadDraft]);
    } else {
      task.status = "unloading";
      state.stage = "blocked";
      state.sleepReason = "unload_target_full";
      state.lastError = "unload_target_full";
      replaceCarrierTasksForProducerRoom(FACTORY_CARRIER_TASK_PRODUCER, task.roomName, []);
    }
  } else if (task.remainingBatteryAmount <= 0) {
    task.status = "done";
    task.updatedAt = Game.time;
    task.completedAt = Game.time;
    state.stage = "idle";
    state.activeTarget = undefined;
    replaceCarrierTasksForProducerRoom(FACTORY_CARRIER_TASK_PRODUCER, task.roomName, []);
  } else {
    const batteryInFactory = factory.store.getUsedCapacity(RESOURCE_BATTERY) ?? 0;
    if (batteryInFactory >= BATTERY_DECOMPRESS_BATCH_BATTERY) {
      task.status = "producing";
      state.stage = "producing";
      if (factory.cooldown <= 0) {
        const factoryFree = factory.store.getFreeCapacity() ?? 0;
        if (factoryFree < BATTERY_DECOMPRESS_BATCH_ENERGY) {
          state.stage = "blocked";
          state.sleepReason = "factory_output_full";
          state.lastError = "factory_full";
          state.sleepUntilTick = Game.time + config.sleepSettings.cooldownOnError;
        } else {
          const result = factory.produce(RESOURCE_ENERGY as CommodityConstant);
          if (result === OK) {
            task.remainingBatteryAmount = Math.max(0, task.remainingBatteryAmount - BATTERY_DECOMPRESS_BATCH_BATTERY);
            task.lastError = undefined;
          } else if (result === ERR_NOT_ENOUGH_RESOURCES) {
            task.status = "loading";
            state.stage = "loading";
            task.lastError = `produce_${result}`;
          } else {
            task.status = "failed";
            task.lastError = `produce_${result}`;
            task.completedAt = Game.time;
          }
        }
      }
      replaceCarrierTasksForProducerRoom(FACTORY_CARRIER_TASK_PRODUCER, task.roomName, []);
    } else {
      const supplyDraft = generateBatteryDecompressSupplyDraft(room, factory, task);
      task.status = "loading";
      state.stage = "loading";
      if (!state.loadingSinceTick) {
        state.loadingSinceTick = Game.time;
      }
      if (!supplyDraft) {
        task.lastError = "no_battery_source";
      }
      replaceCarrierTasksForProducerRoom(FACTORY_CARRIER_TASK_PRODUCER, task.roomName, supplyDraft ? [supplyDraft] : []);
    }
  }

  task.updatedAt = Game.time;
  if (state.stage !== previousStage) {
    state.lastTransitionAt = Game.time;
    if (state.stage !== "loading") {
      state.loadingSinceTick = undefined;
    }
  }
}

function executeProductionCycle(
  room: Room,
  factory: StructureFactory,
  state: RoomRuntimeState,
  config: FactoryControlConfig,
  roomName: string,
): void {
  const product = state.activeTarget!;
  const recipe = getCommodityRecipe(product);
  if (!recipe) {
    state.stage = "blocked";
    state.sleepReason = "no_recipe";
    state.lastError = "no_recipe";
    replaceCarrierTasksForProducerRoom(FACTORY_CARRIER_TASK_PRODUCER, roomName, []);
    return;
  }

  const productInFactory = factory.store.getUsedCapacity(product) ?? 0;
  const hasProduct = productInFactory > 0;

  let allInputsPresent = true;
  for (const [comp, needed] of Object.entries(recipe.components)) {
    if (!needed || needed <= 0) continue;
    const inFactory = factory.store.getUsedCapacity(comp as ResourceConstant) ?? 0;
    if (inFactory < needed) {
      allInputsPresent = false;
      break;
    }
  }

  let drafts: CarrierTaskDraft[] = [];
  const previousStage = state.stage;

  if (hasProduct) {
    const unloadDraft = generateFactoryUnloadDraft(room, factory, product, roomName);
    if (unloadDraft) {
      state.stage = "unloading";
      drafts = [unloadDraft];
    } else {
      state.stage = "blocked";
      state.sleepReason = "unload_target_full";
      state.lastError = "terminal_and_storage_full";
    }
  } else if (allInputsPresent) {
    if (factory.cooldown > 0) {
      state.stage = "producing";
    } else {
      const factoryFree = factory.store.getFreeCapacity() ?? 0;
      const hasOutputCapacity = factoryFree >= recipe.amount;
      const unloadTarget = resolveFactoryUnloadTarget(room, product);

      if (hasOutputCapacity && unloadTarget) {
        state.stage = "producing";
        const result = factory.produce(product as CommodityConstant);
        if (result !== OK) {
          state.lastError = `produce_${result}`;
          if (result === ERR_NOT_ENOUGH_RESOURCES) {
            state.stage = "loading";
            if (!state.loadingSinceTick) {
              state.loadingSinceTick = Game.time;
            }
            drafts = generateFactorySupplyDrafts(room, factory, recipe, roomName);
          } else {
            state.stage = "blocked";
            state.sleepReason = `produce_error_${result}`;
            state.sleepUntilTick = Game.time + config.sleepSettings.cooldownOnError;
          }
        }
      } else {
        state.stage = "blocked";
        if (!hasOutputCapacity) {
          state.sleepReason = "factory_output_full";
          state.lastError = "factory_full";
        } else {
          state.sleepReason = "terminal_backpressure";
          state.lastError = "unload_target_full";
        }
        state.sleepUntilTick = Game.time + config.sleepSettings.cooldownOnError;
      }
    }
  } else {
    state.stage = "loading";
    if (!state.loadingSinceTick) {
      state.loadingSinceTick = Game.time;
    }
    drafts = generateFactorySupplyDrafts(room, factory, recipe, roomName);
  }

  if (state.stage !== previousStage) {
    state.lastTransitionAt = Game.time;
    if (state.stage as string !== "loading" && state.stage as string !== "acquiring") {
      state.loadingSinceTick = undefined;
    }
  }

  replaceCarrierTasksForProducerRoom(FACTORY_CARRIER_TASK_PRODUCER, roomName, drafts);
}

// ---------------------------------------------------------------------------
// Market sale safeguards
// ---------------------------------------------------------------------------

interface SafeOrderSelection {
  order: Order;
  dealAmount: number;
  energyCost: number;
  netCredits: number;
}

function isOrderClaimed(
  runtime: FactoryControlRuntime,
  orderId: string,
  currentTick: number,
): boolean {
  const claims = runtime.claimedOrders;
  if (!claims) return false;
  return claims.some(c => c.orderId === orderId && c.tick === currentTick);
}

function claimOrder(
  runtime: FactoryControlRuntime,
  orderId: string,
  roomName: string,
  currentTick: number,
  credits?: number,
): void {
  if (!runtime.claimedOrders) {
    runtime.claimedOrders = [];
  }
  runtime.claimedOrders.push({ orderId, roomName, tick: currentTick, purpose: "buy", credits });
}

function findSafeSellOrder(
  resource: ResourceConstant,
  demandAmount: number,
  terminalEnergy: number,
  energyReserve: number,
  terminalFreeCapacity: number,
  roomName: string,
  marketCfg: MarketConfig,
  runtime: FactoryControlRuntime,
  currentTick: number,
  availableCredits: number,
): SafeOrderSelection | null {
  const maxPrice = marketCfg.maxBuyPrice[resource];
  if (maxPrice === undefined || !Number.isFinite(maxPrice)) return null;

  if (marketCfg.dailyBudget <= 0) return null;

  const allowlistHasEntries = marketCfg.orderAllowlist.size > 0;
  const roomAllowlistHasEntries = marketCfg.roomAllowlist.size > 0;

  const orders = Game.market.getAllOrders({ type: ORDER_SELL, resourceType: resource });
  let best: SafeOrderSelection | null = null;

  const spentThisTick = (runtime.claimedOrders ?? [])
    .filter(c => c.tick === currentTick && c.purpose === "buy" && c.credits)
    .reduce((sum, c) => sum + (c.credits ?? 0), 0);

  const budgetRemaining = Math.max(0, marketCfg.dailyBudget - spentThisTick);

  const creditAfterReserve = Math.max(0, availableCredits - marketCfg.creditReserve);
  const effectiveCreditLimit = Math.min(creditAfterReserve, budgetRemaining);

  for (const order of orders) {
    if (!order.roomName) continue;
    if (marketCfg.orderBlacklist.has(order.id)) continue;
    if (allowlistHasEntries && !marketCfg.orderAllowlist.has(order.id)) continue;
    if (roomAllowlistHasEntries && !marketCfg.roomAllowlist.has(order.roomName)) continue;
    if (order.amount < marketCfg.minOrderAmount) continue;
    if (isOrderClaimed(runtime, order.id, currentTick)) continue;
    if (order.price > maxPrice) continue;

    let dealAmount = Math.min(demandAmount, order.amount);
    if (terminalFreeCapacity > 0) {
      dealAmount = Math.min(dealAmount, terminalFreeCapacity);
    } else {
      continue;
    }
    if (marketCfg.buyMaxBatch > 0) {
      dealAmount = Math.min(dealAmount, marketCfg.buyMaxBatch);
    }
    if (dealAmount <= 0) continue;

    let energyCost = Game.market.calcTransactionCost(dealAmount, roomName, order.roomName);
    const affordableEnergy = Math.max(0, terminalEnergy - energyReserve);
    if (energyCost > affordableEnergy && dealAmount > 1) {
      let lo = 1;
      let hi = dealAmount;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const midCost = Game.market.calcTransactionCost(mid, roomName, order.roomName);
        if (midCost <= affordableEnergy) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      dealAmount = lo;
      energyCost = Game.market.calcTransactionCost(dealAmount, roomName, order.roomName);
    }
    if (dealAmount <= 0 || energyCost > affordableEnergy) continue;
    if (dealAmount < marketCfg.minOrderAmount) continue;

    const energyCostRatio = dealAmount > 0 ? energyCost / dealAmount : Infinity;
    if (energyCostRatio > marketCfg.maxEnergyCostRatio) continue;

    let totalCost = order.price * dealAmount;
    if (totalCost > effectiveCreditLimit && dealAmount > 1 && order.price > 0) {
      const creditLimitedAmount = Math.floor(effectiveCreditLimit / order.price);
      if (creditLimitedAmount >= 1) {
        dealAmount = Math.min(dealAmount, creditLimitedAmount);
        energyCost = Game.market.calcTransactionCost(dealAmount, roomName, order.roomName);
        totalCost = order.price * dealAmount;
      }
    }
    if (dealAmount <= 0 || dealAmount < marketCfg.minOrderAmount) continue;
    if (totalCost > effectiveCreditLimit) continue;

    if (!best || order.price < best.order.price) {
      best = { order, dealAmount, energyCost, netCredits: totalCost };
    }
  }

  return best;
}

function attemptRegionalRawPurchase(
  room: Room,
  state: RoomRuntimeState,
  config: FactoryControlConfig,
  runtime: FactoryControlRuntime,
  roomName: string,
): void {
  const marketCfg = config.market;
  if (!marketCfg.purchaseEnabled) return;
  if (!state.missing) return;
  if (!room.terminal) return;
  if (room.terminal.cooldown !== 0) return;

  const buyAllow = marketCfg.buyResources.length > 0
    ? new Set(marketCfg.buyResources.filter(r => REGIONAL_RAW_RESOURCES.has(r)))
    : REGIONAL_RAW_RESOURCES;

  const terminalEnergy = room.terminal.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
  const availableCredits = Game.market.credits ?? 0;

  for (const [resource, amount] of Object.entries(state.missing)) {
    if (!amount || amount <= 0) continue;
    if (!buyAllow.has(resource)) continue;

    const res = resource as ResourceConstant;
    const terminalFreeCapacity = room.terminal!.store.getFreeCapacity();
    if (terminalFreeCapacity <= 0) break;

    const selection = findSafeSellOrder(
      res,
      amount,
      terminalEnergy,
      config.terminalEnergyReserve,
      terminalFreeCapacity,
      roomName,
      marketCfg,
      runtime,
      Game.time,
      availableCredits,
    );

    if (!selection) {
      if (!state.lastError) {
        state.lastError = "purchase_no_safe_order";
      }
      continue;
    }

    if (typeof Game.market.getOrderById === "function") {
      const freshOrder = Game.market.getOrderById(selection.order.id);
      if (!freshOrder) {
        state.lastError = "purchase_order_gone";
        continue;
      }
      if (
        freshOrder.type !== ORDER_SELL ||
        freshOrder.resourceType !== res ||
        freshOrder.roomName !== selection.order.roomName ||
        freshOrder.price !== selection.order.price ||
        freshOrder.amount < selection.dealAmount
      ) {
        state.lastError = "purchase_order_changed";
        continue;
      }
    } else if (typeof Game.market.getAllOrders === "function") {
      const freshOrders = Game.market.getAllOrders({ type: ORDER_SELL, resourceType: res });
      const match = freshOrders.find(o => o.id === selection.order.id);
      if (!match) {
        state.lastError = "purchase_order_gone";
        continue;
      }
      if (
        match.type !== ORDER_SELL ||
        match.resourceType !== res ||
        match.roomName !== selection.order.roomName ||
        match.price !== selection.order.price ||
        match.amount < selection.dealAmount
      ) {
        state.lastError = "purchase_order_changed";
        continue;
      }
    } else {
      state.lastError = "purchase_no_revalidation";
      continue;
    }

    declareMarketActionIntent(
      "factoryControl:purchase",
      "market_deal",
      roomName,
    );
    const code = executeMarketDeal(
      selection.order.id,
      selection.dealAmount,
      roomName,
      "factoryControl:purchase",
      {
        orderType: ORDER_SELL,
        resourceType: res,
        orderRoomName: selection.order.roomName,
      },
    );
    if (code !== OK) {
      state.lastError = `purchase_deal_${code}`;
      continue;
    }

    claimOrder(runtime, selection.order.id, roomName, Game.time, selection.netCredits);
    break;
  }
}

// ---------------------------------------------------------------------------
// Main planning function
// ---------------------------------------------------------------------------

export function runFactoryControl(): void {
  const config = parseConfig();
  if (!config.enabled) return;

  const runtime = ensureRuntimeState();
  runtime.updatedAt = Game.time;

  for (const room of Object.values(Game.rooms)) {
    if (!isEligibleRoom(room)) continue;

    const roomName = room.name;
    const roomCfg = config.rooms[roomName];
    if (roomCfg && !roomCfg.enabled) continue;

    const factory = findFactoryInRoom(room);
    if (!factory) continue;

    const state = getRoomState(runtime, roomName);
    const holderId = factory.id as string;
    const previousActiveTarget = state.activeTarget;

    const factoryTask = getActiveFactoryTaskForRoom(roomName);
    if (factoryTask) {
      executeBatteryDecompressTask(room, factory, state, factoryTask, config);
      continue;
    }

    const targetQueue = resolveTargetQueue(config, roomName);
    const resourceFloors = resolveResourceFloors(config, roomName);
    const productionCaps = resolveProductionCaps(config, roomName);

    if (targetQueue.length === 0) {
      state.stage = "sleeping";
      state.sleepReason = "empty_target_queue";
      state.activeTarget = undefined;
      state.missing = undefined;
      state.lastTransitionAt = Game.time;
      replaceCarrierTasksForProducerRoom(FACTORY_CARRIER_TASK_PRODUCER, roomName, []);
      continue;
    }

    // Check if currently sleeping
    if (state.sleepUntilTick && state.sleepUntilTick > Game.time) {
      continue;
    }

    // Clear sleep if expired
    if (state.sleepUntilTick && state.sleepUntilTick <= Game.time) {
      state.sleepUntilTick = undefined;
      state.sleepReason = undefined;
    }

    let highestLevelGated: { resource: ResourceConstant; requiredLevel: number } | null = null;

    // Evaluate each target in queue order
    let planned = false;
    for (const target of targetQueue) {
      const resource = target.resource;
      const targetAmount = target.targetAmount || 0;
      const cap = target.cap || 0;

      const requiredLevel = getRequiredFactoryLevel(resource);
      if (requiredLevel > (factory.level ?? 0)) {
        if (!highestLevelGated || requiredLevel > highestLevelGated.requiredLevel) {
          highestLevelGated = { resource, requiredLevel };
        }
        continue;
      }

      // Check production cap
      const currentStock = getRoomStock(room, resource);
      const effectiveCap = productionCaps[resource] ?? cap;
      if (effectiveCap > 0 && currentStock >= effectiveCap) {
        continue;
      }

      // Check if target amount already satisfied
      if (targetAmount > 0 && currentStock >= targetAmount) {
        continue;
      }

      // Decompose to find what we actually need to produce
      const effectiveTarget = targetAmount > 0 ? targetAmount - currentStock : (effectiveCap > 0 ? effectiveCap - currentStock : 1);
      const decomposition = decomposeTarget(
        resource,
        Math.max(1, effectiveTarget),
        room,
        resourceFloors,
        holderId,
      );

      if (decomposition.requiredLevel > (factory.level ?? 0)) {
        if (!highestLevelGated || decomposition.requiredLevel > highestLevelGated.requiredLevel) {
          highestLevelGated = { resource, requiredLevel: decomposition.requiredLevel };
        }
        continue;
      }

      // Set active target
      if (decomposition.productionTarget === resource) {
        state.activeTarget = resource;
      } else {
        state.activeTarget = decomposition.productionTarget;
      }

      if (state.activeTarget !== previousActiveTarget) {
        state.loadingSinceTick = undefined;
      }

      state.missing = Object.keys(decomposition.missing).length > 0
        ? decomposition.missing
        : undefined;

      if (Object.keys(decomposition.missing).length > 0) {
        state.stage = "blocked";
        state.sleepReason = "missing_base_inputs";
        state.sleepUntilTick = Game.time + config.sleepSettings.cooldownOnMissing;
      } else {
        state.stage = "idle";
        state.sleepReason = undefined;
      }

      state.lastTransitionAt = Game.time;
      planned = true;
      break;
    }

    if (!planned) {
      state.activeTarget = undefined;
      state.missing = undefined;
      state.lastTransitionAt = Game.time;

      if (highestLevelGated) {
        state.stage = "sleeping";
        state.sleepReason = `factory_level_${highestLevelGated.requiredLevel}_required`;
        state.sleepUntilTick = Game.time + config.sleepSettings.maxSleepTicks;
      } else {
        state.stage = "sleeping";
        state.sleepReason = "all_targets_skipped";
        state.sleepUntilTick = Game.time + config.sleepSettings.maxSleepTicks;
      }
      replaceCarrierTasksForProducerRoom(FACTORY_CARRIER_TASK_PRODUCER, roomName, []);
      continue;
    }

    if (state.stage === "blocked" && state.missing) {
      attemptRegionalRawPurchase(room, state, config, runtime, roomName);
    }

    if (state.stage === "blocked") {
      replaceCarrierTasksForProducerRoom(FACTORY_CARRIER_TASK_PRODUCER, roomName, []);
      continue;
    }

    executeProductionCycle(room, factory, state, config, roomName);

  }
}

// ---------------------------------------------------------------------------
// Exported helpers for testing
// ---------------------------------------------------------------------------

export {
  parseConfig,
  isEligibleRoom,
  findFactoryInRoom,
  getRoomStock,
  computeSurplus,
  decomposeTarget,
  resolveTargetQueue,
  getRequiredFactoryLevel,
  isProducible,
  findSafeSellOrder,
  attemptRegionalRawPurchase,
  type TargetEntry,
  type RoomPlanConfig,
  type FactoryControlConfig,
  type FactoryStage,
  type RoomRuntimeState,
  type FactoryControlRuntime,
  type MarketConfig,
};
