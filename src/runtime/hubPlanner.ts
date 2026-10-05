/**
 * Hub planner config schema, defaults, runtime state, and chain planning.
 *
 * PRODUCTION-RATE EXPECTATION:
 * Producing 1000 each of 10 T3 compounds (~10000 total T3 units) requires ~54k
 * base minerals and takes ~20k–30k ticks under one-room sequential lab execution
 * (3+ labs), depending on terminal contention and cleanup ticks.
 *
 * The 38 sequential reactions range from shared intermediates (OH, ZK, UL, G)
 * through tier-1, tier-2, to final T3 compounds. Each reaction cycle consumes
 * 5 ticks per batch; total duration is dominated by the depth of the longest
 * dependency chain plus terminal transfer overhead between rooms.
 */

import {
  countsResourceTransferTaskTowardDemand,
  createAutomaticResourceTransferTask,
  createResourceTransferTaskAmountIndex,
  ensureResourceTransferTaskStore,
  isHealthyReceiverCapacityCommitment,
  isHealthyResourceTransferTaskReservation,
  type ResourceTransferTask,
  type ResourceTransferTaskAmountIndex,
} from "@/runtime/logistics/resourceTransferTasks";
import {
  isReceiverAdmissionEligible,
  normalizeCapacityHeadroomPolicy,
  resolveCapacityState,
} from "@/runtime/logistics/capacityHeadroom";
import { createReceiverCapacityLedger } from "@/runtime/logistics/receiverCapacityLedger";
import {
  HUB_DISTRIBUTED_STORAGE,
  HUB_INTERNAL_ONLY,
  HUB_PLAN_INTERVAL,
  HUB_RESERVE_PER_COMPOUND,
  HUB_RESERVE_PER_ROOM,
  HUB_STORAGE_PAUSE_FREE_CAPACITY,
  HUB_SURPLUS_THRESHOLD,
  HUB_TARGET_COMPOUNDS,
  HUB_T3_SUPPLY_FLOOR,
  getHubOnlyReserve,
  isHubOnlyReserveCompound,
} from "@/config/hub";
import { getTickContextService } from "@/runtime/runtimeServices";
import { collectCarrierCargoInventory } from "@/runtime/hubProgress";
import { getProductReagentMap, roundUpReactionAmount } from "@/runtime/reactionMap";
import { getNukerGhodiumProductionDemand } from "@/runtime/nukerControl";
import {
  beginHubProtectionAttempt,
  buildCommittedHubProtectionSnapshot,
  observeHubProtectionConfigIncarnation,
  publishCommittedHubProtectionSnapshot,
  publishInvalidHubProtectionSnapshot,
  type HubRuntimeProtectionExtension,
} from "@/runtime/hubProtectionSnapshot";

export function getDefaultHubConfig(): NonNullable<Memory["cfg"]>["hub"] {
  return {
    enabled: false,
    hubRoomName: "",
    planInterval: HUB_PLAN_INTERVAL,
    reservePerRoom: HUB_RESERVE_PER_ROOM,
    hubReservePerCompound: HUB_RESERVE_PER_COMPOUND,
    hubOnlyReservePerCompound: getHubOnlyReserve(undefined),
    targetCompounds: [...HUB_TARGET_COMPOUNDS],
    storagePauseFreeCapacity: HUB_STORAGE_PAUSE_FREE_CAPACITY,
    surplusThreshold: HUB_SURPLUS_THRESHOLD,
    internalOnly: HUB_INTERNAL_ONLY,
    distributedStorage: HUB_DISTRIBUTED_STORAGE,
  };
}

export function getDefaultHubRuntime(): NonNullable<Memory["runtime"]>["hub"] {
  return {
    status: "idle",
    updatedAt: 0,
    activeProduct: "",
    activeStep: 0,
    missingResources: [],
    lastPlanActions: [],
    needsPlan: false,
  };
}

const OLD_DEFAULT_TARGET_COMPOUNDS = new Set<ResourceConstant>([
  RESOURCE_CATALYZED_GHODIUM_ALKALIDE, // XGHO2
  RESOURCE_CATALYZED_GHODIUM_ACID, // XGH2O
  RESOURCE_CATALYZED_UTRIUM_ACID, // XUH2O
  RESOURCE_CATALYZED_UTRIUM_ALKALIDE, // XUHO2
  RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE, // XLHO2
]);
const PRE_OH_DEFAULT_TARGET_COMPOUNDS = new Set(
  HUB_TARGET_COMPOUNDS.filter(resource => !isHubOnlyReserveCompound(resource)),
);

export function normalizeHubConfig(cfg: NonNullable<Memory["cfg"]>["hub"]): NonNullable<Memory["cfg"]>["hub"] {
  let migrated = { ...cfg };

  const compounds = cfg?.targetCompounds;
  const oldDefaultLists = [OLD_DEFAULT_TARGET_COMPOUNDS, PRE_OH_DEFAULT_TARGET_COMPOUNDS];
  if (compounds && oldDefaultLists.some(defaults => compounds.length === defaults.size &&
      compounds.every(compound => defaults.has(compound)) && new Set(compounds).size === defaults.size)) {
    migrated = { ...migrated, targetCompounds: [...HUB_TARGET_COMPOUNDS] };
  }

  if ((migrated.reservePerRoom ?? 0) < HUB_RESERVE_PER_ROOM) {
    migrated = { ...migrated, reservePerRoom: HUB_RESERVE_PER_ROOM };
  }

  if (migrated.distributedStorage === undefined) {
    migrated = { ...migrated, distributedStorage: HUB_DISTRIBUTED_STORAGE };
  }

  return migrated;
}

export interface ChainStep {
  product: ResourceConstant;
  targetAmount: number;
  reagents: [ResourceConstant, ResourceConstant];
}

// ---------------------------------------------------------------------------
// Distributed synthesis type contract — multi-room hub dispatch planning types
// ---------------------------------------------------------------------------

/** Describes a room's capability to participate in distributed synthesis. */
export interface SynthesisRoomCapability {
  roomName: string;
  labCount: number;
  hasTerminal: boolean;
  hasStorage: boolean;
  /** If this room has a lab reserved for boost operations (not available for synthesis). */
  boostLabExclusive: boolean;
  /** Distinct minerals available in this room (storage + terminal + lab). */
  mineralInventory: Partial<Record<ResourceConstant, number>>;
}

/** A dispatch assignment: which room should synthesize what, and how much. */
export interface SynthesisDispatchAssignment {
  roomName: string;
  product: ResourceConstant;
  targetAmount: number;
  /** Whether this is the hub room itself or an auxiliary room. */
  isHubRoom: boolean;
  /** The final T3 target this assignment contributes to. Optional/backward-compatible. */
  finalTarget?: ResourceConstant;
}

/** Tracks resource allocation commitments across rooms. */
export interface AllocationLedgerEntry {
  resource: ResourceConstant;
  totalAmount: number;
  /** How much each room has committed or holds. */
  roomCommitments: Record<string, number>;
}

/** A decision to send resources directly between rooms via terminal. */
export interface DirectRouteDecision {
  fromRoom: string;
  toRoom: string;
  resource: ResourceConstant;
  amount: number;
  /** Terminal send fee in energy. */
  fee: number;
  /**
   * True when this route carries a reagent demand for the hub room's own active
   * synthesis (toRoom === hubRoomName because the hub is synthesizing). Such
   * routes are NOT surplus returns and survive under distributedStorage even for
   * non-T3 resources. Untagged hub-bound routes are treated as surplus returns.
   */
  isHubReagentDemand?: boolean;
}

/** Represents an edge in the upstream/downstream production progress graph. */
export interface ProgressEdge {
  /** The room providing the resource (upstream). */
  fromRoom: string;
  /** The room receiving the resource (downstream). */
  toRoom: string;
  /** The resource flowing along this edge. */
  resource: ResourceConstant;
  /** How many units have been delivered so far. */
  delivered: number;
  /** Total units to deliver. */
  total: number;
}

const PROCESS_ORDER: ResourceConstant[] = [
  // T3 products (catalyzed)
  RESOURCE_CATALYZED_UTRIUM_ACID,
  RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
  RESOURCE_CATALYZED_KEANIUM_ACID,
  RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
  RESOURCE_CATALYZED_LEMERGIUM_ACID,
  RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
  RESOURCE_CATALYZED_ZYNTHIUM_ACID,
  RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE,
  RESOURCE_CATALYZED_GHODIUM_ACID,
  RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
  // T2 intermediates
  RESOURCE_UTRIUM_ACID,
  RESOURCE_UTRIUM_ALKALIDE,
  RESOURCE_KEANIUM_ACID,
  RESOURCE_KEANIUM_ALKALIDE,
  RESOURCE_LEMERGIUM_ACID,
  RESOURCE_LEMERGIUM_ALKALIDE,
  RESOURCE_ZYNTHIUM_ACID,
  RESOURCE_ZYNTHIUM_ALKALIDE,
  RESOURCE_GHODIUM_ACID,
  RESOURCE_GHODIUM_ALKALIDE,
  // T1 intermediates
  RESOURCE_UTRIUM_HYDRIDE,
  RESOURCE_UTRIUM_OXIDE,
  RESOURCE_KEANIUM_HYDRIDE,
  RESOURCE_KEANIUM_OXIDE,
  RESOURCE_LEMERGIUM_HYDRIDE,
  RESOURCE_LEMERGIUM_OXIDE,
  RESOURCE_ZYNTHIUM_HYDRIDE,
  RESOURCE_ZYNTHIUM_OXIDE,
  RESOURCE_GHODIUM_HYDRIDE,
  RESOURCE_GHODIUM_OXIDE,
  // Base intermediates
  RESOURCE_GHODIUM,
  RESOURCE_HYDROXIDE,
  RESOURCE_ZYNTHIUM_KEANITE,
  RESOURCE_UTRIUM_LEMERGITE,
];

const T3_TARGETS: ResourceConstant[] = [
  RESOURCE_CATALYZED_UTRIUM_ACID,
  RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
  RESOURCE_CATALYZED_KEANIUM_ACID,
  RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
  RESOURCE_CATALYZED_LEMERGIUM_ACID,
  RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
  RESOURCE_CATALYZED_ZYNTHIUM_ACID,
  RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE,
  RESOURCE_CATALYZED_GHODIUM_ACID,
  RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
];

const BASE_MINERALS: ResourceConstant[] = [
  RESOURCE_HYDROGEN,
  RESOURCE_OXYGEN,
  RESOURCE_UTRIUM,
  RESOURCE_LEMERGIUM,
  RESOURCE_KEANIUM,
  RESOURCE_ZYNTHIUM,
  RESOURCE_CATALYST,
];

const INTERMEDIATE_COMPOUNDS: ResourceConstant[] = [
  RESOURCE_HYDROXIDE,
  RESOURCE_ZYNTHIUM_KEANITE,
  RESOURCE_UTRIUM_LEMERGITE,
  RESOURCE_GHODIUM,
  RESOURCE_UTRIUM_HYDRIDE,
  RESOURCE_UTRIUM_OXIDE,
  RESOURCE_KEANIUM_HYDRIDE,
  RESOURCE_KEANIUM_OXIDE,
  RESOURCE_LEMERGIUM_HYDRIDE,
  RESOURCE_LEMERGIUM_OXIDE,
  RESOURCE_ZYNTHIUM_HYDRIDE,
  RESOURCE_ZYNTHIUM_OXIDE,
  RESOURCE_GHODIUM_HYDRIDE,
  RESOURCE_GHODIUM_OXIDE,
  RESOURCE_UTRIUM_ACID,
  RESOURCE_UTRIUM_ALKALIDE,
  RESOURCE_KEANIUM_ACID,
  RESOURCE_KEANIUM_ALKALIDE,
  RESOURCE_LEMERGIUM_ACID,
  RESOURCE_LEMERGIUM_ALKALIDE,
  RESOURCE_ZYNTHIUM_ACID,
  RESOURCE_ZYNTHIUM_ALKALIDE,
  RESOURCE_GHODIUM_ALKALIDE,
  RESOURCE_GHODIUM_ACID,
];

const BASE_MINERAL_SAFETY_FLOOR = 500;

const SHARED_BASE_INTERMEDIATES = new Set<ResourceConstant>([
  RESOURCE_HYDROXIDE,
  RESOURCE_ZYNTHIUM_KEANITE,
  RESOURCE_UTRIUM_LEMERGITE,
  RESOURCE_GHODIUM,
]);

const MIN_HUB_IMPORT_AMOUNT = 100;

const HUB_RUNTIME_ARRAY_CAP = 20;

export function planHubChains(
  hubInventory: Record<string, number>,
  incomingResources: Record<string, number>,
  targetReserve: number,
  targetCompounds: ResourceConstant[] = T3_TARGETS,
  additionalDemands: Partial<Record<ResourceConstant, number>> = {},
  hubOnlyTargetReserve: number = targetReserve,
): { steps: ChainStep[]; blocked: boolean; missingResources: ResourceConstant[] } {
  // 1. Merge hub inventory + healthy incoming into available pool
  const available: Record<string, number> = {};
  const merge = (rec: Record<string, number>) => {
    for (const [k, v] of Object.entries(rec)) {
      available[k] = (available[k] || 0) + v;
    }
  };
  merge(hubInventory);
  merge(incomingResources);

  // 2. Seed demand only for the target compounds parameter. Store the reserve
  // target here, not the deficit: the propagation pass subtracts current
  // inventory once for every product, including T3 targets.
  const needed: Record<string, number> = {};
  for (const t3 of targetCompounds) {
    const have = available[t3] || 0;
    const reserve = isHubOnlyReserveCompound(t3) ? hubOnlyTargetReserve : targetReserve;
    // OH 也是后续反应的原料：将库存目标与下游消耗相加后统一扣减库存。
    if (isHubOnlyReserveCompound(t3) || have < reserve) {
      needed[t3] = reserve;
    }
  }

  for (const [resource, rawAmount] of Object.entries(additionalDemands)) {
    if (typeof rawAmount !== "number" || !Number.isFinite(rawAmount)) continue;
    const amount = Math.max(0, Math.floor(rawAmount));
    if (amount <= 0) continue;
    needed[resource] = (needed[resource] || 0) + amount;
  }

  // If all targets are at reserve, nothing to produce
  if (Object.keys(needed).length === 0) {
    return { steps: [], blocked: false, missingResources: [] };
  }

  // 3. Propagate deficits down PROCESS_ORDER (T3 → base intermediates)
  for (const product of PROCESS_ORDER) {
    const demand = needed[product] || 0;
    if (demand <= 0) continue;

    const have = available[product] || 0;
    const toProduce = Math.max(0, demand - have);
    needed[product] = toProduce;

    if (toProduce > 0) {
      const reagents = getProductReagentMap()[product];
      if (reagents) {
        for (const r of reagents) {
          needed[r] = (needed[r] || 0) + toProduce;
        }
      }
    }
  }

  // Additional consumption demands are seeded as absolute demand so the same
  // inventory ledger can offset them. If inventory fully covers every seeded
  // product, propagation leaves no product to synthesize; this is a completed
  // plan, not a blocked one.
  if (!PROCESS_ORDER.some((product) => (needed[product] || 0) > 0)) {
    return { steps: [], blocked: false, missingResources: [] };
  }

  // 4. Build candidates: products with demand > 0 AND both reagents available
  const OUTPUT_ORDER: ResourceConstant[] = [
    // Base intermediates
    RESOURCE_HYDROXIDE,
    RESOURCE_ZYNTHIUM_KEANITE,
    RESOURCE_UTRIUM_LEMERGITE,
    RESOURCE_GHODIUM,
    // T1 intermediates
    RESOURCE_UTRIUM_HYDRIDE,
    RESOURCE_UTRIUM_OXIDE,
    RESOURCE_KEANIUM_HYDRIDE,
    RESOURCE_KEANIUM_OXIDE,
    RESOURCE_LEMERGIUM_HYDRIDE,
    RESOURCE_LEMERGIUM_OXIDE,
    RESOURCE_ZYNTHIUM_HYDRIDE,
    RESOURCE_ZYNTHIUM_OXIDE,
    RESOURCE_GHODIUM_HYDRIDE,
    RESOURCE_GHODIUM_OXIDE,
    // T2 intermediates
    RESOURCE_UTRIUM_ACID,
    RESOURCE_UTRIUM_ALKALIDE,
    RESOURCE_KEANIUM_ACID,
    RESOURCE_KEANIUM_ALKALIDE,
    RESOURCE_LEMERGIUM_ACID,
    RESOURCE_LEMERGIUM_ALKALIDE,
    RESOURCE_ZYNTHIUM_ACID,
    RESOURCE_ZYNTHIUM_ALKALIDE,
    RESOURCE_GHODIUM_ALKALIDE,
    RESOURCE_GHODIUM_ACID,
    // T3 products
    RESOURCE_CATALYZED_UTRIUM_ACID,
    RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
    RESOURCE_CATALYZED_KEANIUM_ACID,
    RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
    RESOURCE_CATALYZED_LEMERGIUM_ACID,
    RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
    RESOURCE_CATALYZED_ZYNTHIUM_ACID,
    RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE,
    RESOURCE_CATALYZED_GHODIUM_ACID,
    RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
  ];

  const candidates: ChainStep[] = [];
  for (const product of OUTPUT_ORDER) {
    const demand = needed[product] || 0;
    if (demand <= 0) continue;

    const reagents = getProductReagentMap()[product];
    if (!reagents) continue;

    const availA = available[reagents[0]] || 0;
    const availB = available[reagents[1]] || 0;

    if (availA <= 0 || availB <= 0) continue;

    const amount = Math.max(1, Math.min(demand, availA, availB));
    candidates.push({ product, targetAmount: amount, reagents });
  }

  // 5. Diagnose eventual base-mineral gaps even when some immediate steps can
  // still run. A partial candidate set is useful work, but must not erase the
  // resources that keep the rest of the requested chain uncovered.
  const missingResources: ResourceConstant[] = [];
  for (const base of BASE_MINERALS) {
    const have = available[base] || 0;
    const need = needed[base] || 0;
    if (need > have) {
      missingResources.push(base);
    }
  }

  // 6. If we have feasible candidates, return them unblocked while preserving
  // the eventual uncovered resource facts for runtime observability.
  if (candidates.length > 0) {
    return { steps: candidates, blocked: false, missingResources };
  }

  return {
    steps: [],
    blocked: true,
    missingResources,
  };
}

function countLabs(room: Room): number {
  return room.find(FIND_MY_STRUCTURES, {
    filter: { structureType: STRUCTURE_LAB },
  }).length;
}

/**
 * Compute direct-supply commitment for a satellite room's resource.
 * This is the sum of outgoing direct-supply transfers (synthesis:direct:*)
 * and route-decision demands from the active distributed synthesis plan.
 */
function getDirectSupplyCommitment(
  satelliteName: string,
  resource: ResourceConstant,
  transferAmounts: ResourceTransferTaskAmountIndex,
): number {
  let commitment = 0;

  commitment += transferAmounts.getPendingOutgoing(satelliteName, resource, "synthesis:direct:");
  commitment += transferAmounts.getPendingOutgoing(satelliteName, resource, "synthesis:hub-route:");

  const routeDecisions = Memory.runtime?.hub?.distributedSynthesis?.routeDecisions;
  if (routeDecisions) {
    for (const route of routeDecisions) {
      if (route.fromRoom === satelliteName && route.resource === resource) {
        commitment += route.amount;
      }
    }
  }

  return commitment;
}

/**
 * Compute the local reserve for a satellite room's resource based on
 * active distributed synthesis assignments. For T3 products, uses
 * reservePerRoom. For intermediates/base minerals needed by an active
 * reaction, returns the reagent demand for the assigned product's batch.
 */
function getLocalReserveForSynthesis(
  satelliteName: string,
  resource: string,
  reservePerRoom: number,
  targetCompounds: ResourceConstant[],
): number {
  if (targetCompounds.includes(resource as ResourceConstant) && !isHubOnlyReserveCompound(resource as ResourceConstant)) {
    return reservePerRoom;
  }

  const assignments = Memory.runtime?.hub?.distributedSynthesis?.dispatchAssignments;
  if (!assignments) return 0;

  const assignment = assignments.find(a => a.roomName === satelliteName);
  if (!assignment) return 0;

  const product = assignment.product as string;

  const batchSize = getBatchSizeForRoom(satelliteName);
  if (isReagentInChain(product, resource)) {
    return batchSize;
  }

  return 0;
}

/** Get the configured batch size for a room's synthesis reaction, default 5. */
function getBatchSizeForRoom(roomName: string): number {
  const roomCfg = Memory.cfg?.synthesisControl?.rooms?.[roomName];
  const reactions = roomCfg?.reactions;
  if (reactions && reactions.length > 0 && reactions[0].batchSize) {
    return reactions[0].batchSize;
  }
  return roomCfg?.batchSize ?? 5;
}

/** Check if a resource appears as a reagent anywhere in the reaction chain for a product. */
function isReagentInChain(product: string, resource: string): boolean {
  const visited = new Set<string>();
  const stack: string[] = [product];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const reagents = getProductReagentMap()[current];
    if (!reagents) continue;

    if (reagents[0] === resource || reagents[1] === resource) return true;
    stack.push(reagents[0], reagents[1]);
  }

  return false;
}

export function planHubImports(
  cfg: NonNullable<Memory["cfg"]>["hub"],
  transferAmounts: ResourceTransferTaskAmountIndex = createResourceTransferTaskAmountIndex(),
  hubInventory?: Record<string, number>,
): string[] {
  if (!cfg?.hubRoomName) return [];

  const hubRoom = Game.rooms[cfg.hubRoomName];
  if (!hubRoom?.storage) return [];

  const hubFreeCapacity = hubRoom.storage.store.getFreeCapacity();
  if (hubFreeCapacity < (cfg.storagePauseFreeCapacity ?? HUB_STORAGE_PAUSE_FREE_CAPACITY)) return [];

  const actions: string[] = [];
  const reservePerRoom = cfg.reservePerRoom ?? HUB_RESERVE_PER_ROOM;
  const surplusThreshold = cfg.surplusThreshold ?? HUB_SURPLUS_THRESHOLD;
  const targetCompounds = cfg.targetCompounds?.length ? cfg.targetCompounds : HUB_TARGET_COMPOUNDS;

  const hubOnlyShortages = new Map<ResourceConstant, number>();
  for (const compound of targetCompounds.filter(isHubOnlyReserveCompound)) {
    const stored = hubInventory?.[compound] ?? (
      (hubRoom.storage.store[compound] || 0) + (hubRoom.terminal?.store[compound] || 0) +
      (hubRoom.find(FIND_MY_STRUCTURES, { filter: structure =>
        structure.structureType === STRUCTURE_LAB || structure.structureType === STRUCTURE_FACTORY ||
        structure.structureType === STRUCTURE_POWER_SPAWN
      }) as AnyStoreStructure[]).reduce((sum, structure) => sum + (structure.store?.[compound] || 0), 0) +
      (collectCarrierCargoInventory(hubRoom.name)[compound] || 0)
    );
    hubOnlyShortages.set(compound, Math.max(0,
      getHubOnlyReserve(cfg) - stored - transferAmounts.getIncoming(hubRoom.name, compound)));
  }

  const existingKeys = new Set<string>();
  const taskStore = ensureResourceTransferTaskStore();
  for (const task of Object.values(taskStore)) {
    if (
      task.toRoomName === cfg.hubRoomName &&
      countsResourceTransferTaskTowardDemand(task)
    ) {
      existingKeys.add(`${task.fromRoomName}:${task.resource}:${task.reason}`);
    }
  }

  const myRooms = getTickContextService().getMyRooms();
  const satellites = myRooms.filter(
    (room) =>
      room.name !== cfg.hubRoomName &&
      room.controller?.my &&
      room.storage &&
      room.terminal,
  );

  for (const satellite of satellites) {
    const satResources: Record<string, number> = {};
    const storageStore = satellite.storage!.store as unknown as Record<string, number>;
    for (const [res, amt] of Object.entries(storageStore)) {
      if (res !== RESOURCE_ENERGY && typeof amt === "number" && amt > 0) {
        satResources[res] = amt;
      }
    }
    const terminalStore = satellite.terminal!.store as unknown as Record<string, number>;
    for (const [res, amt] of Object.entries(terminalStore)) {
      if (res !== RESOURCE_ENERGY && typeof amt === "number" && amt > 0) {
        satResources[res] = (satResources[res] || 0) + amt;
      }
    }

    // Distributed storage keeps base/intermediate surplus local; T3 reclaim stays
    // hub-bound.
    if (cfg.distributedStorage !== true) {
      for (const mineral of BASE_MINERALS) {
        const amount = satResources[mineral] || 0;
        if (amount <= BASE_MINERAL_SAFETY_FLOOR) continue;
        const directCommitment = getDirectSupplyCommitment(satellite.name, mineral, transferAmounts);
        const localReserve = getLocalReserveForSynthesis(satellite.name, mineral, reservePerRoom, targetCompounds);
        const sendAmount = amount - BASE_MINERAL_SAFETY_FLOOR - directCommitment - localReserve;
        if (sendAmount < MIN_HUB_IMPORT_AMOUNT) continue;
        const reason = `hub:import:${mineral}`;
        const key = `${satellite.name}:${mineral}:${reason}`;
        if (existingKeys.has(key)) continue;
        const result = createAutomaticResourceTransferTask(satellite.name, cfg.hubRoomName, mineral, sendAmount, reason);
        if (typeof result === "object" && result.ok) {
          actions.push(`import:${satellite.name}:${mineral}=${sendAmount}`);
        }
      }

      for (const compound of INTERMEDIATE_COMPOUNDS) {
        if (hubOnlyShortages.has(compound)) continue;
        const amount = satResources[compound] || 0;
        if (amount <= 0) continue;
        const directCommitment = getDirectSupplyCommitment(satellite.name, compound, transferAmounts);
        const localReserve = getLocalReserveForSynthesis(satellite.name, compound, reservePerRoom, targetCompounds);
        const sendAmount = amount - directCommitment - localReserve;
        if (sendAmount < MIN_HUB_IMPORT_AMOUNT) continue;
        const reason = `hub:import:${compound}`;
        const key = `${satellite.name}:${compound}:${reason}`;
        if (existingKeys.has(key)) continue;
        const result = createAutomaticResourceTransferTask(satellite.name, cfg.hubRoomName, compound, sendAmount, reason);
        if (typeof result === "object" && result.ok) {
          actions.push(`import:${satellite.name}:${compound}=${sendAmount}`);
        }
      }
    }

    for (const t3 of targetCompounds) {
      const hubOnly = isHubOnlyReserveCompound(t3);
      const amount = satResources[t3] || 0;
      if (hubOnly ? amount < MIN_HUB_IMPORT_AMOUNT : amount <= surplusThreshold) continue;
      const directCommitment = getDirectSupplyCommitment(satellite.name, t3, transferAmounts);
      const localReserve = getLocalReserveForSynthesis(satellite.name, t3, reservePerRoom, targetCompounds);
      const sendAmount = Math.min(amount - directCommitment - localReserve,
        hubOnly ? hubOnlyShortages.get(t3) || 0 : Infinity);
      if (hubOnly ? sendAmount < MIN_HUB_IMPORT_AMOUNT : sendAmount <= 0) continue;
      const reason = `hub:reclaim:${t3}`;
      const key = `${satellite.name}:${t3}:${reason}`;
      if (existingKeys.has(key)) continue;
      const result = createAutomaticResourceTransferTask(satellite.name, cfg.hubRoomName, t3, sendAmount, reason);
      if (typeof result === "object" && result.ok) {
        actions.push(`reclaim:${satellite.name}:${t3}=${sendAmount}`);
        if (hubOnly) hubOnlyShortages.set(t3, (hubOnlyShortages.get(t3) || 0) - sendAmount);
      }
    }
  }

  return actions;
}

export function planHubDistribution(cfg: NonNullable<Memory["cfg"]>["hub"]): string[] {
  if (!cfg?.hubRoomName) return [];

  const hubRoom = Game.rooms[cfg.hubRoomName];
  if (!hubRoom?.storage || !hubRoom?.terminal) return [];

  const reservePerRoom = cfg.reservePerRoom ?? HUB_RESERVE_PER_ROOM;
  const targetCompounds = (cfg.targetCompounds?.length ? cfg.targetCompounds : HUB_TARGET_COMPOUNDS)
    .filter(compound => !isHubOnlyReserveCompound(compound));
  const capacityPolicy = normalizeCapacityHeadroomPolicy(
    Memory.cfg?.resourceControl?.capacityBalancing,
  );

  const hubT3Available: Record<string, number> = {};
  const hubStorageStore = hubRoom.storage.store as unknown as Record<string, number>;
  const hubTerminalStore = hubRoom.terminal.store as unknown as Record<string, number>;
  for (const t3 of targetCompounds) {
    hubT3Available[t3] = (hubStorageStore[t3] || 0) + (hubTerminalStore[t3] || 0);
  }

  const taskStore = ensureResourceTransferTaskStore();
  const hubPendingOutgoing: Record<string, number> = {};
  const unhealthyAutomaticHubExportKeys = new Set<string>();
  const taskKey = (
    fromRoomName: string,
    toRoomName: string,
    resource: ResourceConstant,
    reason?: string,
  ): string => `${fromRoomName}\u0000${toRoomName}\u0000${resource}\u0000${reason || ""}`;
  const isOwnedResourceControlEndpoint = (roomName: string): boolean => {
    const room = Game.rooms[roomName];
    return Boolean(room?.controller?.my && room.storage && room.terminal);
  };
  const myRooms = getTickContextService().getMyRooms();
  const capacityLedger = createReceiverCapacityLedger({
    receivers: myRooms
      .filter((room) => room.controller?.my && room.storage && room.terminal)
      .map((room) => ({
        roomName: room.name,
        storageFreeCapacity: room.storage!.store.getFreeCapacity(),
        terminalFreeCapacity: room.terminal!.store.getFreeCapacity(),
        getTerminalResourceFreeCapacity: (resource: ResourceConstant) => {
          const resourceFree = room.terminal!.store.getFreeCapacity(resource);
          return typeof resourceFree === "number"
            ? resourceFree
            : room.terminal!.store.getFreeCapacity();
        },
      })),
    tasks: Object.values(taskStore),
    storageSafetyReserve: capacityPolicy.storagePressureFreeCapacity,
    terminalSafetyReserve: capacityPolicy.terminalPressureFreeCapacity,
    isTaskEndpointValid: (task) =>
      isOwnedResourceControlEndpoint(task.fromRoomName) &&
      isOwnedResourceControlEndpoint(task.toRoomName),
    isTaskHealthy: (task) => isHealthyReceiverCapacityCommitment(task),
  });
  for (const task of Object.values(taskStore)) {
    if (
      isHealthyResourceTransferTaskReservation(task, "outgoing") &&
      task.fromRoomName === cfg.hubRoomName &&
      task.reason?.startsWith("hub:export:")
    ) {
      hubPendingOutgoing[task.resource] = (hubPendingOutgoing[task.resource] || 0) + task.remainingAmount;
    }

    const isHealthyCommitment = isHealthyReceiverCapacityCommitment(task);
    if (
      task.status === "pending" &&
      task.origin === "automatic" &&
      task.fromRoomName === cfg.hubRoomName &&
      task.reason?.startsWith("hub:export:") &&
      !isHealthyCommitment
    ) {
      unhealthyAutomaticHubExportKeys.add(taskKey(
        task.fromRoomName,
        task.toRoomName,
        task.resource,
        task.reason,
      ));
    }

  }

  const hubSupplyFloor = Math.min(cfg.hubReservePerCompound ?? HUB_RESERVE_PER_COMPOUND, HUB_T3_SUPPLY_FLOOR);
  const hubRemaining: Record<string, number> = {};
  for (const t3 of targetCompounds) {
    hubRemaining[t3] = Math.max(0, (hubT3Available[t3] || 0) - (hubPendingOutgoing[t3] || 0) - hubSupplyFloor);
  }

  const satellites = myRooms.filter(
    (room) =>
      room.name !== cfg.hubRoomName &&
      room.controller?.my &&
      room.storage &&
      room.terminal,
  );

  const actions: string[] = [];

  for (const satellite of satellites) {
    const satStorageFree = satellite.storage!.store.getFreeCapacity();
    const satTerminalFree = satellite.terminal!.store.getFreeCapacity();
    const capacityState = resolveCapacityState(
      satStorageFree,
      satTerminalFree,
      capacityPolicy,
      Memory.runtime?.resourceControl?.rooms?.[satellite.name]?.capacityState,
    );
    if (!isReceiverAdmissionEligible(
      satStorageFree,
      satTerminalFree,
      capacityState,
      capacityPolicy,
    )) {
      continue;
    }
    for (const t3 of targetCompounds) {
      if (hubRemaining[t3] <= 0) continue;

      const satStorage = satellite.storage!.store as unknown as Record<string, number>;
      const satTerminal = satellite.terminal!.store as unknown as Record<string, number>;
      const current = (satStorage[t3] || 0) + (satTerminal[t3] || 0);

      const availability = capacityLedger.getAvailability(satellite.name, t3);
      const effectiveTotal = current + availability.resourceCommitted;
      if (effectiveTotal >= reservePerRoom) continue;

      const shortage = reservePerRoom - effectiveTotal;
      const cappedByHub = Math.min(shortage, hubRemaining[t3]);
      const amount = Math.min(
        cappedByHub,
        capacityLedger.getAvailableAmount(satellite.name, t3),
      );

      if (amount <= 0) continue;

      const reason = `hub:export:${t3}`;
      if (unhealthyAutomaticHubExportKeys.has(taskKey(
        cfg.hubRoomName,
        satellite.name,
        t3,
        reason,
      ))) {
        continue;
      }
      const result = createAutomaticResourceTransferTask(cfg.hubRoomName, satellite.name, t3, amount, reason);

      if (typeof result === "object" && result.ok) {
        capacityLedger.syncTask(result.task);
        actions.push(`export:${satellite.name}:${t3}=${amount}`);
        hubRemaining[t3] -= amount;
      }
    }
  }

  return actions;
}

export function writeSynthesisConfig(
  hubRoomName: string,
  attemptRevision: number,
  steps: ChainStep[],
  hubInventory: Record<string, number>,
  transferAmounts: ResourceTransferTaskAmountIndex = createResourceTransferTaskAmountIndex(),
): HubSynthesisConfigReconcile {
  const selectedRooms = new Set<string>();
  const refreshedRooms: string[] = [];
  const nextStep = steps.length > 0 ? steps[0] : null;
  if (
    nextStep &&
    !isSynthesisRoomAvailableToHubPlanner(hubRoomName, hubRoomName)
  ) {
    throw new Error(`foreign_owner_assignment:${hubRoomName}`);
  }
  if (!Memory.cfg) {
    return createConfigReconcileSummary(attemptRevision);
  }
  if (!Memory.cfg.synthesisControl) {
    Memory.cfg.synthesisControl = {};
  }
  Memory.cfg.synthesisControl.enabled = true;

  if (!Memory.cfg.synthesisControl.rooms) {
    Memory.cfg.synthesisControl.rooms = {};
  }

  if (!nextStep) {
    return reconcileHubOwnedSynthesisConfigs(
      hubRoomName,
      attemptRevision,
      selectedRooms,
      refreshedRooms,
      transferAmounts,
    );
  }

  selectedRooms.add(hubRoomName);
  const stage = Memory.runtime?.synthesisControl?.rooms?.[hubRoomName]?.stage;
  if (canRewriteSynthesisRoom(hubRoomName, stage, transferAmounts)) {
    writeOwnedSynthesisReaction(hubRoomName, hubRoomName, attemptRevision, {
      product: nextStep.product,
      targetAmount: roundUpReactionAmount((hubInventory[nextStep.product] || 0) + nextStep.targetAmount),
      batchSize: Math.min(3000, Math.max(5, roundUpReactionAmount(nextStep.targetAmount))),
      donorRoomNames: [],
    });
    refreshedRooms.push(hubRoomName);
  }

  return reconcileHubOwnedSynthesisConfigs(
    hubRoomName,
    attemptRevision,
    selectedRooms,
    refreshedRooms,
    transferAmounts,
  );
}

/**
 * Clear stale hub synthesis reactions when hub planning is blocked or disabled.
 * Preserves lab IDs and all other room config metadata.
 */
export function clearHubSynthesisReactions(hubRoomName: string): void {
  const transferAmounts = createResourceTransferTaskAmountIndex();
  if (!canReconcileOwnedSynthesisRoom(hubRoomName, transferAmounts)) return;
  clearOwnedSynthesisReaction(hubRoomName, hubRoomName);
}

function computeTotalSatelliteDeficit(
  cfg: NonNullable<Memory["cfg"]>["hub"],
  targetCompounds: ResourceConstant[],
  transferAmounts: ResourceTransferTaskAmountIndex,
): number {
  const reservePerRoom = cfg.reservePerRoom ?? HUB_RESERVE_PER_ROOM;
  const myRooms = getTickContextService().getMyRooms();
  const satellites = myRooms.filter(
    (room) =>
      room.name !== cfg.hubRoomName &&
      room.controller?.my &&
      room.storage &&
      room.terminal,
  );

  let totalDeficit = 0;
  for (const satellite of satellites) {
    for (const t3 of targetCompounds) {
      if (isHubOnlyReserveCompound(t3)) continue;
      const satStorage = satellite.storage!.store as unknown as Record<string, number>;
      const satTerminal = satellite.terminal!.store as unknown as Record<string, number>;
      const current = (satStorage[t3] || 0) + (satTerminal[t3] || 0);

      // Only serviceable demand coverage counts toward the satellite reserve;
      // raw pending remains available separately for audit/physical safety.
      const pendingIncoming = transferAmounts.getIncoming(
        satellite.name,
        t3,
        "hub:export:",
      );

      const effectiveTotal = current + pendingIncoming;
      const deficit = Math.max(0, reservePerRoom - effectiveTotal);
      totalDeficit += deficit;
    }
  }
  return totalDeficit;
}

/**
 * Discover all eligible rooms for distributed synthesis and score their capacity.
 *
 * Eligibility: visible owned room with storage, terminal, and at least 3 labs.
 * Labs must not ALL be boost-reserved (a single boost lab is fine).
 * Survival-state rooms ARE eligible.
 */
export function getEligibleSynthesisRooms(): SynthesisRoomCapability[] {
  const myRooms = getTickContextService().getMyRooms();
  const results: SynthesisRoomCapability[] = [];

  for (const room of myRooms) {
    if (!room.storage || !room.terminal) continue;

    const labCount = countLabs(room);
    if (labCount < 3) continue;

    // boostLabExclusive: a single boost lab is fine; only exclude when ALL labs are boost-reserved
    const boostLabId = Memory.cfg?.homeDefense?.rooms?.[room.name]?.boostLabId;
    const boostLabExclusive = labCount >= 1 && boostLabId != null && labCount <= 1;

    if (boostLabExclusive) continue;

    const mineralInventory: Partial<Record<ResourceConstant, number>> = {};

    const storageStore = room.storage.store as unknown as Record<string, number>;
    for (const [res, amt] of Object.entries(storageStore)) {
      if (res !== RESOURCE_ENERGY && amt > 0) {
        mineralInventory[res as ResourceConstant] = amt;
      }
    }

    const terminalStore = room.terminal.store as unknown as Record<string, number>;
    for (const [res, amt] of Object.entries(terminalStore)) {
      if (res !== RESOURCE_ENERGY && amt > 0) {
        mineralInventory[res as ResourceConstant] = (mineralInventory[res as ResourceConstant] || 0) + amt;
      }
    }

    results.push({
      roomName: room.name,
      labCount,
      hasTerminal: true,
      hasStorage: true,
      boostLabExclusive: false,
      mineralInventory,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Distributed synthesis: concurrent chain demand + global allocation ledger
// ---------------------------------------------------------------------------

/** Result of distributed synthesis planning across multiple rooms. */
export interface DistributedSynthesisPlan {
  /** Room → product assignments for concurrent synthesis. */
  dispatchAssignments: SynthesisDispatchAssignment[];
  /** Per-resource allocation ledger tracking committed amounts per room. */
  allocationLedger: Record<string, AllocationLedgerEntry>;
  /** Terminal transfer decisions for cross-room reagent routing. */
  routeDecisions: DirectRouteDecision[];
  /** T3 targets that cannot be produced due to insufficient global resources. */
  blockedTargets: ResourceConstant[];
  /** Base resources still missing after considering all eligible room inventory. */
  missingResources: ResourceConstant[];
}

export interface HubSynthesisConfigReconcile {
  revision: number;
  refreshedRooms: string[];
  clearedRooms: string[];
  skippedBusyRooms: string[];
  foreignOwnerRooms: string[];
}

interface HubPlannerOwnership {
  owner: string;
  hubRoomName: string;
  revision: number;
}

type HubDistributedSynthesisRuntime = NonNullable<
  NonNullable<NonNullable<Memory["runtime"]>["hub"]>["distributedSynthesis"]
> & {
  blockedTargets?: ResourceConstant[];
  invariantViolations?: string[];
  configReconcile?: HubSynthesisConfigReconcile;
};

type HubRuntimeLiveness = NonNullable<NonNullable<Memory["runtime"]>["hub"]> & {
  distributedSynthesis?: HubDistributedSynthesisRuntime;
};

/**
 * Compute concurrent chain demand for all configured T3 targets across
 * multiple synthesis-capable rooms and build a global allocation ledger.
 *
 * Leverages `planHubChains()` for demand propagation. The allocation ledger
 * is populated from room inventories (accounting for pending transfers and
 * local reserves) and decremented atomically as assignments are proposed,
 * ensuring two rooms cannot consume the same mineral stock.
 */
export function planDistributedSynthesis(
  hubRoomName: string,
  targetCompounds: ResourceConstant[],
  hubReservePerCompound: number,
  reservePerRoom: number,
  hubInventory: Record<string, number>,
  /**
   * Effective T3 production target to plan toward. Defaults to
   * `hubReservePerCompound` for backward compatibility. When the hub planner
   * computes `chainTarget = hubReservePerCompound + satelliteDeficit`, that
   * value must be passed here so distributed synthesis covers satellite export
   * demand instead of stopping at the bare hub reserve.
   */
  effectiveTargetReserve?: number,
  transferAmounts: ResourceTransferTaskAmountIndex = createResourceTransferTaskAmountIndex(),
  additionalDemands: Partial<Record<ResourceConstant, number>> = {},
  hubOnlyTargetReserve: number = hubReservePerCompound,
): DistributedSynthesisPlan {
  const targetReserve = effectiveTargetReserve ?? hubReservePerCompound;
  const rooms = getEligibleSynthesisRooms().filter(room =>
    isSynthesisRoomAvailableToHubPlanner(room.roomName, hubRoomName)
  );
  const allResources = [...BASE_MINERALS, ...INTERMEDIATE_COMPOUNDS, ...T3_TARGETS];

  // 1. Build per-room effective inventories (with pending transfers and reserves)
  const roomEffective: Record<string, Record<string, number>> = {};
  for (const room of rooms) {
    const effective: Record<string, number> = {};
    for (const [res, amt] of Object.entries(room.mineralInventory)) {
      effective[res] = amt;
    }
    for (const res of allResources) {
      const rc = res as ResourceConstant;
      const incoming = transferAmounts.getIncoming(room.roomName, rc);
      const outgoing = transferAmounts.getOutgoing(room.roomName, rc);
      effective[res] = (effective[res] || 0) + incoming - outgoing;
    }
    // Subtract local reserve for base minerals
    for (const base of BASE_MINERALS) {
      const have = effective[base] || 0;
      effective[base] = have > reservePerRoom ? have - reservePerRoom : 0;
    }
    roomEffective[room.roomName] = effective;
  }

  // 2. Build allocation ledger from per-room effective inventories
  const ledger: Record<string, AllocationLedgerEntry> = {};
  for (const room of rooms) {
    for (const res of allResources) {
      const amt = roomEffective[room.roomName][res] || 0;
      if (amt <= 0) continue;
      if (!ledger[res]) {
        ledger[res] = { resource: res as ResourceConstant, totalAmount: 0, roomCommitments: {} };
      }
      ledger[res].totalAmount += amt;
      ledger[res].roomCommitments[room.roomName] = amt;
    }
  }

  // 3-4. T3 reserve demand is hub-centric, but distributed synthesis can use
  // reagents held outside the hub. Use hub inventory for T3 target accounting
  // and the allocation ledger for base/intermediate feasibility.
  const chainInventory: Record<string, number> = {};
  for (const res of allResources) {
    const resource = res as ResourceConstant;
    const hubOnlyTarget = isHubOnlyReserveCompound(resource) && targetCompounds.includes(resource);
    chainInventory[res] = T3_TARGETS.includes(resource) || hubOnlyTarget
      ? (hubInventory[res] || 0) + (hubOnlyTarget
        ? transferAmounts.getIncoming(hubRoomName, resource) - transferAmounts.getOutgoing(hubRoomName, resource) : 0)
      : ledger[res]?.totalAmount ?? 0;
  }
  const chainResult = planHubChains(
    chainInventory,
    {},
    targetReserve,
    targetCompounds,
    additionalDemands,
    hubOnlyTargetReserve,
  );

  // 5. Assign steps to rooms using logistics-cost-aware scoring, decrementing ledger atomically
  const assignments: SynthesisDispatchAssignment[] = [];
  const routeDecisions: DirectRouteDecision[] = [];
  const blockedTargets: ResourceConstant[] = [];

  const roomOrder = [
    ...rooms
      .filter(room => room.roomName === hubRoomName)
      .map(room => room.roomName),
    ...rooms
      .filter(room => room.roomName !== hubRoomName)
      .map(room => room.roomName),
  ];

  // 5a. Cap each step's targetAmount so shared reagents are distributed fairly.
  // Without this, the first step consuming a shared reagent (e.g. OH consuming
  // all O, or the first T2 step consuming all OH) starves subsequent steps.
  // Applies to ALL reagents (base minerals, T1 intermediates like OH/UO, etc.)
  // because any can be a bottleneck shared across multiple chain steps.

  // Count how many steps need each reagent
  const reagentDemandCount: Record<string, number> = {};
  for (const step of chainResult.steps) {
    for (const reagent of step.reagents) {
      reagentDemandCount[reagent] = (reagentDemandCount[reagent] || 0) + 1;
    }
  }

  // Cap each step's targetAmount to its fair share of any reagent
  const cappedSteps = chainResult.steps.map(step => {
    let cap = step.targetAmount;
    for (const reagent of step.reagents) {
      const demandCount = reagentDemandCount[reagent] || 1;
      if (demandCount <= 1) continue; // no contention, skip
      const available = ledger[reagent]?.totalAmount ?? 0;
      const share = Math.floor(available / demandCount);
      cap = Math.min(cap, share);
    }
    return { ...step, targetAmount: Math.max(0, cap) };
  });

  // 5b. Tag capped steps with their possible final T3 targets, then
  // assign using first-pass diversification (one assignment per distinct
  // final T3 target) before allowing duplicate targets.

  interface TaggedStep {
    step: ChainStep;
    possibleTargets: ResourceConstant[];
    originalIndex: number;
  }

  const taggedSteps: TaggedStep[] = cappedSteps
    .filter(step => step.targetAmount > 0)
    .map((step, idx) => ({
      step,
      possibleTargets: getPossibleT3Targets(step.product, targetCompounds),
      originalIndex: idx,
    }));

  // Sort by specificity (fewer possible targets first) with original order
  // as tiebreaker. This ensures unique intermediates (UH→XUH2O) are assigned
  // before shared ones (OH→[XUH2O,XUHO2,...]), preventing shared intermediates
  // from claiming a target that a specific intermediate needs.
  taggedSteps.sort((a, b) => {
    const diff = a.possibleTargets.length - b.possibleTargets.length;
    return diff !== 0 ? diff : a.originalIndex - b.originalIndex;
  });

  const depGraph = new DependencyGraph();
  const usedRooms = new Set<string>();
  const assignedTargets = new Set<ResourceConstant>();
  const assignedIndices = new Set<number>();
  const deferredIndices: number[] = [];

  // First pass: one assignment per distinct final T3 target
  for (let i = 0; i < taggedSteps.length; i++) {
    const { step, possibleTargets } = taggedSteps[i];
    const target = possibleTargets.find(t => !assignedTargets.has(t));

    if (target) {
      const result = assignStepToRoom(ledger, step, roomOrder, hubRoomName, rooms, depGraph, usedRooms, transferAmounts);
      if (result) {
        result.assignment.finalTarget = target;
        assignments.push(result.assignment);
        routeDecisions.push(...result.routes);
        usedRooms.add(result.assignment.roomName);
        assignedTargets.add(target);
        assignedIndices.add(i);
      } else {
        deferredIndices.push(i);
      }
    } else {
      deferredIndices.push(i);
    }
  }

  // Second pass: assign shared intermediates (OH, ZK, UL, G) and steps
  // with uncovered targets. Skip uniquely-traceable steps (T1/T2/T3) whose
  // single target is already covered — those would create traceProductToFinalT3
  // duplicates without providing diversification value.
  for (const i of deferredIndices) {
    const { step, possibleTargets } = taggedSteps[i];
    if (
      possibleTargets.length === 1 &&
      !SHARED_BASE_INTERMEDIATES.has(step.product) &&
      assignedTargets.has(possibleTargets[0])
    ) continue;

    const target = possibleTargets.find(t => !assignedTargets.has(t)) ?? possibleTargets[0];
    const result = assignStepToRoom(ledger, step, roomOrder, hubRoomName, rooms, depGraph, usedRooms, transferAmounts);
    if (result) {
      result.assignment.finalTarget = target;
      assignments.push(result.assignment);
      routeDecisions.push(...result.routes);
      usedRooms.add(result.assignment.roomName);
      if (!assignedTargets.has(target)) assignedTargets.add(target);
      assignedIndices.add(i);
    }
  }

  // Third pass: fallback — allow duplicate uniquely-traceable steps when
  // unused rooms remain after diversification (feasibleTargets < rooms).
  const unusedRoomCount = roomOrder.filter(r => !usedRooms.has(r)).length;
  if (unusedRoomCount > 0) {
    for (let i = 0; i < taggedSteps.length; i++) {
      if (assignedIndices.has(i)) continue;
      const { step, possibleTargets } = taggedSteps[i];
      const result = assignStepToRoom(ledger, step, roomOrder, hubRoomName, rooms, depGraph, usedRooms, transferAmounts);
      if (result) {
        result.assignment.finalTarget = possibleTargets[0] ?? undefined;
        assignments.push(result.assignment);
        routeDecisions.push(...result.routes);
        usedRooms.add(result.assignment.roomName);
        assignedIndices.add(i);
      }
    }
  }

  // 6. Preserve targets with feasible-but-unassigned work (for example when
  // chain steps outnumber rooms), plus targets whose global base inputs remain
  // short. One successful assignment must not make the rest look covered.
  const blockedTargetSet = new Set<ResourceConstant>();
  for (let i = 0; i < taggedSteps.length; i++) {
    if (assignedIndices.has(i)) continue;
    for (const target of taggedSteps[i].possibleTargets) {
      if ((hubInventory[target] || 0) < (isHubOnlyReserveCompound(target) ? hubOnlyTargetReserve : targetReserve)) {
        blockedTargetSet.add(target);
      }
    }
  }
  for (const target of targetCompounds) {
    if ((hubInventory[target] || 0) >= (isHubOnlyReserveCompound(target) ? hubOnlyTargetReserve : targetReserve)) continue;
    if (
      chainResult.missingResources.length === 0
        ? chainResult.blocked
        : chainResult.missingResources.some(resource => isReagentInChain(target, resource))
    ) {
      blockedTargetSet.add(target);
    }
  }
  for (const target of targetCompounds) {
    if (blockedTargetSet.has(target)) blockedTargets.push(target);
  }

  return {
    dispatchAssignments: assignments,
    allocationLedger: ledger,
    routeDecisions,
    blockedTargets,
    missingResources: chainResult.missingResources,
  };
}

/**
 * Trace a product upward through getProductReagentMap() consumers to find which
 * configured T3 targets it ultimately feeds into.
 * T3 products map to themselves. T1/T2 intermediates map to their unique T3.
 * Shared intermediates (OH, ZK, UL, G) map to all configured T3 targets that
 * consume them through any chain path.
 */
function getPossibleT3Targets(product: ResourceConstant, targetCompounds: ResourceConstant[]): ResourceConstant[] {
  if (targetCompounds.includes(product)) return [product];

  const results: ResourceConstant[] = [];
  const visited = new Set<string>();
  const stack: string[] = [product];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);

    for (const [consumer, reagents] of Object.entries(getProductReagentMap())) {
      if (reagents[0] === current || reagents[1] === current) {
        const consumerRC = consumer as ResourceConstant;
        if (targetCompounds.includes(consumerRC)) {
          if (!results.includes(consumerRC)) {
            results.push(consumerRC);
          }
        } else {
          stack.push(consumer);
        }
      }
    }
  }

  return results;
}

const BUSY_STAGES = new Set(["loading", "synthesizing", "unloading", "cleanup"]);

interface RoomDispatchScore {
  roomName: string;
  score: number;
}

export function scoreRoomForStep(
  roomName: string,
  step: ChainStep,
  ledger: Record<string, AllocationLedgerEntry>,
  hubRoomName: string,
  roomCapabilities: SynthesisRoomCapability[],
  usedRooms?: Set<string>,
  transferAmounts: ResourceTransferTaskAmountIndex = createResourceTransferTaskAmountIndex(),
): RoomDispatchScore {
  const [reagentA, reagentB] = step.reagents;
  const needed = step.targetAmount;
  let score = 0;

  // A used room is not a low-scoring fallback: one room can persist only one
  // active reaction config in a plan revision.
  if (usedRooms?.has(roomName)) {
    return { roomName, score: Number.NEGATIVE_INFINITY };
  }

  if (roomName === hubRoomName) {
    score += 1;
  }

  const localA = ledger[reagentA]?.roomCommitments[roomName] ?? 0;
  const localB = ledger[reagentB]?.roomCommitments[roomName] ?? 0;
  if (localA >= needed && localB >= needed) {
    score += 100;
  } else if (localA > 0 && localB > 0) {
    score += 20 + Math.min(localA, localB) / needed * 30;
  } else if (localA > 0 || localB > 0) {
    score += 10;
  }

  const needsExternalA = localA < needed;
  const needsExternalB = localB < needed;
  if (roomName !== hubRoomName && (needsExternalA || needsExternalB)) {
    if (typeof Game.market?.calcTransactionCost === "function") {
      const feeDirect = Game.market.calcTransactionCost(needed, hubRoomName, roomName);
      score -= feeDirect / needed * 5;
    } else {
      score -= 5;
    }
  }

  const stage = Memory.runtime?.synthesisControl?.rooms?.[roomName]?.stage;
  if (stage && BUSY_STAGES.has(stage)) {
    score -= 200;
  }

  const cap = roomCapabilities.find(r => r.roomName === roomName);
  if (cap) {
    let loadA = 0;
    let loadB = 0;
    for (const res of [reagentA, reagentB] as ResourceConstant[]) {
      const outgoing = transferAmounts.getOutgoing(roomName, res);
      const incoming = transferAmounts.getIncoming(roomName, res);
      if (res === reagentA) loadA = outgoing + incoming;
      if (res === reagentB) loadB = outgoing + incoming;
    }
    const totalLoad = loadA + loadB;
    score -= totalLoad / (needed * 2 + 1) * 10;
  }

  return { roomName, score };
}

export class DependencyGraph {
  private deps: Map<string, Set<string>> = new Map();

  add(room: string, dependsOn: string): void {
    if (!this.deps.has(room)) {
      this.deps.set(room, new Set());
    }
    this.deps.get(room)!.add(dependsOn);
  }

  wouldCreateCycle(room: string, dependsOn: string): boolean {
    return this.reachable(dependsOn, room);
  }

  private reachable(from: string, target: string): boolean {
    const visited = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === target) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const depSet = this.deps.get(current);
      if (depSet) {
        for (const d of depSet) {
          stack.push(d);
        }
      }
    }
    return false;
  }
}

function assignStepToRoom(
  ledger: Record<string, AllocationLedgerEntry>,
  step: ChainStep,
  roomOrder: string[],
  hubRoomName: string,
  roomCapabilities: SynthesisRoomCapability[],
  depGraph: DependencyGraph,
  usedRooms: Set<string>,
  transferAmounts: ResourceTransferTaskAmountIndex,
): { assignment: SynthesisDispatchAssignment; routes: DirectRouteDecision[] } | null {
  const [reagentA, reagentB] = step.reagents;
  const globalA = ledger[reagentA]?.totalAmount ?? 0;
  const globalB = ledger[reagentB]?.totalAmount ?? 0;
  if (globalA <= 0 || globalB <= 0) return null;
  let needed = Math.min(step.targetAmount, globalA, globalB);
  if (needed <= 0) return null;

  const scored = roomOrder
    .filter(roomName => !usedRooms.has(roomName))
    .map(r => scoreRoomForStep(r, step, ledger, hubRoomName, roomCapabilities, usedRooms, transferAmounts))
    .sort((a, b) => b.score - a.score);

  for (const { roomName } of scored) {
    if (shouldSkipStalledActiveProduct(roomName, step.product, transferAmounts)) continue;

    const availA = ledger[reagentA]?.roomCommitments[roomName] ?? 0;
    const availB = ledger[reagentB]?.roomCommitments[roomName] ?? 0;
    if (availA >= needed && availB >= needed) {
      ledger[reagentA]!.roomCommitments[roomName] -= needed;
      ledger[reagentA]!.totalAmount -= needed;
      ledger[reagentB]!.roomCommitments[roomName] -= needed;
      ledger[reagentB]!.totalAmount -= needed;
      return {
        assignment: { roomName, product: step.product, targetAmount: needed, isHubRoom: roomName === hubRoomName },
        routes: [],
      };
    }

    const routes: DirectRouteDecision[] = [];
    const changes: Array<{ res: string; room: string; amt: number }> = [];
    const newDeps = new Set<string>();
    let remA = needed;
    let remB = needed;
    const isHubTarget = roomName === hubRoomName;

    const localA = availA;
    if (localA > 0) {
      const use = Math.min(localA, remA);
      changes.push({ res: reagentA, room: roomName, amt: use });
      remA -= use;
    }
    const localB = availB;
    if (localB > 0) {
      const use = Math.min(localB, remB);
      changes.push({ res: reagentB, room: roomName, amt: use });
      remB -= use;
    }

    for (const from of roomOrder) {
      if (remA <= 0 && remB <= 0) break;
      if (from === roomName) continue;

      if (depGraph.wouldCreateCycle(roomName, from)) continue;

      if (remA > 0) {
        const avail = ledger[reagentA]?.roomCommitments[from] ?? 0;
        if (avail > 0) {
          const send = Math.min(avail, remA);
          routes.push({ fromRoom: from, toRoom: roomName, resource: reagentA, amount: send, fee: 0, isHubReagentDemand: isHubTarget });
          changes.push({ res: reagentA, room: from, amt: send });
          newDeps.add(from);
          remA -= send;
        }
      }
      if (remB > 0) {
        const avail = ledger[reagentB]?.roomCommitments[from] ?? 0;
        if (avail > 0) {
          const send = Math.min(avail, remB);
          routes.push({ fromRoom: from, toRoom: roomName, resource: reagentB, amount: send, fee: 0, isHubReagentDemand: isHubTarget });
          changes.push({ res: reagentB, room: from, amt: send });
          newDeps.add(from);
          remB -= send;
        }
      }
    }

    if (remA <= 0 && remB <= 0) {
      for (const c of changes) {
        ledger[c.res]!.roomCommitments[c.room] -= c.amt;
        ledger[c.res]!.totalAmount -= c.amt;
      }
      for (const dep of newDeps) {
        depGraph.add(roomName, dep);
      }
      return {
        assignment: { roomName, product: step.product, targetAmount: needed, isHubRoom: roomName === hubRoomName },
        routes,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Distributed synthesis config writer — multi-room reaction assignment
// ---------------------------------------------------------------------------

const ACCEPT_REASSIGN_STAGES = new Set<string>(["idle", "blocked"]);

function isMissingInputUnserved(roomName: string, transferAmounts: ResourceTransferTaskAmountIndex): boolean {
  const roomState = Memory.runtime?.synthesisControl?.rooms?.[roomName];
  const missing = roomState?.missing;
  if (!missing) return false;

  const deficits = Object.entries(missing)
    .filter(([, deficit]) => (deficit ?? 0) > 0) as Array<[ResourceConstant, number]>;
  if (deficits.length === 0) return false;

  return deficits.every(([resource]) => transferAmounts.getIncoming(roomName, resource) <= 0);
}

function canRewriteSynthesisRoom(
  roomName: string,
  stage: string | undefined,
  transferAmounts: ResourceTransferTaskAmountIndex = createResourceTransferTaskAmountIndex(),
): boolean {
  if (!stage || ACCEPT_REASSIGN_STAGES.has(stage)) return true;
  return (stage === "acquiring" || stage === "loading") && isMissingInputUnserved(roomName, transferAmounts);
}

function shouldSkipStalledActiveProduct(
  roomName: string,
  product: ResourceConstant,
  transferAmounts: ResourceTransferTaskAmountIndex,
): boolean {
  const roomState = Memory.runtime?.synthesisControl?.rooms?.[roomName];
  if (roomState?.activeProduct !== product) return false;
  const stage = roomState.stage;
  if (stage !== "acquiring" && stage !== "loading") return false;
  return isMissingInputUnserved(roomName, transferAmounts);
}

type SynthesisControlConfig = NonNullable<NonNullable<Memory["cfg"]>["synthesisControl"]>;
type SynthesisRoomConfig = NonNullable<SynthesisControlConfig["rooms"]>[string];
type HubOwnedSynthesisRoomConfig = SynthesisRoomConfig & {
  plannerOwnership?: HubPlannerOwnership;
};
type HubOwnedSynthesisRoomConfigs = Record<string, HubOwnedSynthesisRoomConfig>;

function getHubOwnedSynthesisRoomConfigs(): HubOwnedSynthesisRoomConfigs | undefined {
  return Memory.cfg?.synthesisControl?.rooms as HubOwnedSynthesisRoomConfigs | undefined;
}

function boundedSortedRoomNames(roomNames: Iterable<string>): string[] {
  return [...new Set(roomNames)].sort().slice(0, HUB_RUNTIME_ARRAY_CAP);
}

function createConfigReconcileSummary(
  revision: number,
  refreshedRooms: Iterable<string> = [],
): HubSynthesisConfigReconcile {
  return {
    revision,
    refreshedRooms: boundedSortedRoomNames(refreshedRooms),
    clearedRooms: [],
    skippedBusyRooms: [],
    foreignOwnerRooms: [],
  };
}

function mergeConfigReconcileSummaries(
  revision: number,
  summaries: readonly HubSynthesisConfigReconcile[],
): HubSynthesisConfigReconcile {
  const refreshedRooms = boundedSortedRoomNames(
    summaries.flatMap(summary => summary.refreshedRooms),
  );
  const clearedRooms = boundedSortedRoomNames(
    summaries.flatMap(summary => summary.clearedRooms),
  );
  const skippedBusyRooms = boundedSortedRoomNames(
    summaries.flatMap(summary => summary.skippedBusyRooms),
  );
  const handledRooms = new Set([
    ...refreshedRooms,
    ...clearedRooms,
    ...skippedBusyRooms,
  ]);
  return {
    revision,
    refreshedRooms,
    clearedRooms,
    skippedBusyRooms,
    foreignOwnerRooms: boundedSortedRoomNames(
      summaries
        .flatMap(summary => summary.foreignOwnerRooms)
        .filter(roomName => !handledRooms.has(roomName)),
    ),
  };
}

function writeOwnedSynthesisReaction(
  roomName: string,
  hubRoomName: string,
  revision: number,
  reaction: NonNullable<SynthesisRoomConfig["reactions"]>[number],
): void {
  const rooms = getHubOwnedSynthesisRoomConfigs();
  if (!rooms) return;
  const current = rooms[roomName] ?? {
    enabled: true,
    donorRoomNames: [],
  };
  rooms[roomName] = {
    ...current,
    enabled: true,
    reactions: [reaction],
    plannerOwnership: {
      owner: "hubPlanner",
      hubRoomName,
      revision,
    },
  };
}

function isValidHubPlannerOwnership(
  ownership: HubPlannerOwnership | undefined,
  hubRoomName: string,
): ownership is HubPlannerOwnership {
  return isStructurallyValidHubPlannerOwnership(ownership) &&
    ownership.hubRoomName === hubRoomName;
}

function isStructurallyValidHubPlannerOwnership(
  ownership: HubPlannerOwnership | undefined,
): ownership is HubPlannerOwnership {
  return ownership?.owner === "hubPlanner" &&
    typeof ownership.hubRoomName === "string" &&
    ownership.hubRoomName.length > 0 &&
    Number.isSafeInteger(ownership.revision) &&
    ownership.revision >= 0;
}

function isSynthesisRoomAvailableToHubPlanner(
  roomName: string,
  hubRoomName: string,
): boolean {
  const ownership = getHubOwnedSynthesisRoomConfigs()?.[roomName]?.plannerOwnership;
  return ownership === undefined || isValidHubPlannerOwnership(ownership, hubRoomName);
}

function getHubPlannerOwnershipHubRoomNames(): string[] {
  const hubRoomNames = new Set<string>();
  for (const roomCfg of Object.values(getHubOwnedSynthesisRoomConfigs() ?? {})) {
    if (!isStructurallyValidHubPlannerOwnership(roomCfg.plannerOwnership)) continue;
    hubRoomNames.add(roomCfg.plannerOwnership.hubRoomName);
  }
  return [...hubRoomNames].sort();
}

function getHubPlannerOwnershipHighWater(hubRoomName?: string): number {
  let highWater = 0;
  for (const roomCfg of Object.values(getHubOwnedSynthesisRoomConfigs() ?? {})) {
    const ownership = roomCfg.plannerOwnership;
    if (!isStructurallyValidHubPlannerOwnership(ownership)) continue;
    if (hubRoomName !== undefined && ownership.hubRoomName !== hubRoomName) continue;
    highWater = Math.max(highWater, Math.floor(roomCfg.plannerOwnership.revision));
  }
  return highWater;
}

function getAssignmentInvariantViolations(
  assignments: readonly SynthesisDispatchAssignment[],
  hubRoomName: string,
): string[] {
  const violations = validateDistributedSynthesisAssignments(assignments);
  for (const assignment of [...assignments].sort((a, b) => a.roomName.localeCompare(b.roomName))) {
    if (isSynthesisRoomAvailableToHubPlanner(assignment.roomName, hubRoomName)) continue;
    violations.push(`foreign_owner_assignment:${assignment.roomName}`);
  }
  return [...new Set(violations)].slice(0, HUB_RUNTIME_ARRAY_CAP);
}

function clearOwnedSynthesisReaction(
  roomName: string,
  hubRoomName: string,
): boolean {
  const rooms = getHubOwnedSynthesisRoomConfigs();
  const current = rooms?.[roomName];
  if (
    !rooms ||
    !current ||
    !isValidHubPlannerOwnership(current.plannerOwnership, hubRoomName)
  ) {
    return false;
  }
  const { plannerOwnership: _plannerOwnership, ...preserved } = current;
  rooms[roomName] = {
    ...preserved,
    reactions: [],
  };
  return true;
}

function canReconcileOwnedSynthesisRoom(
  roomName: string,
  transferAmounts: ResourceTransferTaskAmountIndex,
): boolean {
  const stage = Memory.runtime?.synthesisControl?.rooms?.[roomName]?.stage;
  if (!stage || ACCEPT_REASSIGN_STAGES.has(stage)) return true;
  // A stale acquiring plan with no serviceable missing input is safe to
  // release. Loading and all later physical stages remain strictly busy.
  return stage === "acquiring" && isMissingInputUnserved(roomName, transferAmounts);
}

function reconcileHubOwnedSynthesisConfigs(
  hubRoomName: string,
  revision: number,
  selectedRooms: ReadonlySet<string>,
  refreshedRooms: Iterable<string>,
  transferAmounts: ResourceTransferTaskAmountIndex,
): HubSynthesisConfigReconcile {
  const summary = createConfigReconcileSummary(revision, refreshedRooms);
  const rooms = getHubOwnedSynthesisRoomConfigs();
  if (!rooms) return summary;
  const refreshedSet = new Set(summary.refreshedRooms);

  for (const roomName of Object.keys(rooms).sort()) {
    if (refreshedSet.has(roomName)) continue;
    const roomCfg = rooms[roomName];
    const ownership = roomCfg?.plannerOwnership;
    const hasManagedContent = (roomCfg?.reactions?.length ?? 0) > 0 || ownership !== undefined;

    if (!isValidHubPlannerOwnership(ownership, hubRoomName)) {
      if (hasManagedContent) summary.foreignOwnerRooms.push(roomName);
      continue;
    }

    if (selectedRooms.has(roomName) || ownership.revision >= revision) continue;
    if (!canReconcileOwnedSynthesisRoom(roomName, transferAmounts)) {
      summary.skippedBusyRooms.push(roomName);
      continue;
    }
    if (clearOwnedSynthesisReaction(roomName, hubRoomName)) {
      summary.clearedRooms.push(roomName);
    }
  }

  summary.clearedRooms = boundedSortedRoomNames(summary.clearedRooms);
  summary.skippedBusyRooms = boundedSortedRoomNames(summary.skippedBusyRooms);
  summary.foreignOwnerRooms = boundedSortedRoomNames(summary.foreignOwnerRooms);
  return summary;
}

/** Stable defensive validator for one-active-product-per-room plans. */
export function validateDistributedSynthesisAssignments(
  assignments: readonly SynthesisDispatchAssignment[],
): string[] {
  const byRoom = new Map<string, ResourceConstant[]>();
  for (const assignment of assignments) {
    const products = byRoom.get(assignment.roomName) ?? [];
    products.push(assignment.product);
    byRoom.set(assignment.roomName, products);
  }

  const violations: string[] = [];
  for (const roomName of [...byRoom.keys()].sort()) {
    const products = byRoom.get(roomName)!;
    if (products.length <= 1) continue;
    violations.push(
      `duplicate_room_assignment:${roomName}:${[...products].sort().join(",")}`,
    );
  }
  return violations.slice(0, HUB_RUNTIME_ARRAY_CAP);
}

/**
 * Write distributed synthesis reaction configs to multiple rooms.
 *
 * For each dispatch assignment, writes a reaction config to the target room
 * only if its runtime stage is idle, blocked, or undefined (never written to).
 * Preserves active reactions for rooms in loading/synthesizing/unloading/cleanup.
 *
 * Returns true if distributed mode was used (multiple rooms assigned),
 * false if hub-only fallback should be used instead.
 */
export function wireRouteTransferTasks(
  routeDecisions: DirectRouteDecision[],
  hubRoomName: string,
  reservePerRoom: number,
  distributedStorage?: boolean,
  activeAssignments: readonly SynthesisDispatchAssignment[] = [],
  knownSynthesisRooms: ReadonlySet<string> = new Set(
    activeAssignments.map(assignment => assignment.roomName),
  ),
): void {
  const directRoutes = routeDecisions.filter(r => r.toRoom !== hubRoomName);
  const hubRoutes = routeDecisions.filter(r => r.toRoom === hubRoomName);
  const plannedRoutes = new Map<string, DirectRouteDecision & { reason: string }>();

  function addPlannedRoute(
    fromRoom: string,
    toRoom: string,
    resource: ResourceConstant,
    amount: number,
    fee: number,
    reason: string,
  ): void {
    if (amount <= 0) return;

    const key = getSynthesisRouteTaskKey(fromRoom, toRoom, resource, reason);
    const existing = plannedRoutes.get(key);
    if (existing) {
      existing.amount += amount;
      return;
    }

    plannedRoutes.set(key, { fromRoom, toRoom, resource, amount, fee, reason });
  }

  const hubReagentDemandRoutes = hubRoutes.filter(r => r.isHubReagentDemand === true);
  const hubSurplusRoutes = hubRoutes.filter(r => r.isHubReagentDemand !== true);

  const directCommitment: Record<string, number> = {};
  for (const route of directRoutes) {
    const key = `${route.fromRoom}:${route.resource}`;
    directCommitment[key] = (directCommitment[key] || 0) + route.amount;
  }
  for (const route of hubReagentDemandRoutes) {
    const key = `${route.fromRoom}:${route.resource}`;
    directCommitment[key] = (directCommitment[key] || 0) + route.amount;
  }

  for (const route of directRoutes) {
    if (route.amount <= 0) continue;

    let preferDirect = true;
    // Source IS hub → hub-route creates same-room task (ERR_SAME_ROOM).
    if (route.fromRoom !== hubRoomName && typeof Game.market?.calcTransactionCost === "function") {
      const directFee = Game.market.calcTransactionCost(route.amount, route.fromRoom, route.toRoom);
      const feeToHub = Game.market.calcTransactionCost(route.amount, route.fromRoom, hubRoomName);
      const feeHubToTarget = Game.market.calcTransactionCost(route.amount, hubRoomName, route.toRoom);
      if (directFee >= feeToHub + feeHubToTarget) {
        preferDirect = false;
      }
    }

    if (preferDirect) {
      addPlannedRoute(
        route.fromRoom,
        route.toRoom,
        route.resource,
        route.amount,
        route.fee,
        `synthesis:direct:${route.resource}`,
      );
    } else {
      addPlannedRoute(
        route.fromRoom,
        hubRoomName,
        route.resource,
        route.amount,
        route.fee,
        `synthesis:hub-route:${route.resource}`,
      );
    }
  }

  // Active hub reagent demand: reagents the hub needs for its own synthesis.
  // Non-surplus reason, no reservePerRoom subtraction, survives distributedStorage.
  for (const route of hubReagentDemandRoutes) {
    if (route.amount <= 0) continue;
    addPlannedRoute(
      route.fromRoom,
      hubRoomName,
      route.resource,
      route.amount,
      route.fee,
      `synthesis:direct:${route.resource}`,
    );
  }

  // True surplus returns: existing behavior preserved.
  for (const route of hubSurplusRoutes) {
    if (route.amount <= 0) continue;

    const isT3 = T3_TARGETS.includes(route.resource);
    // Hub-bound route decisions without active downstream demand are surplus returns.
    // In distributed storage mode, only T3 surplus remains hub-central.
    if (distributedStorage === true && !isT3) continue;

    const key = `${route.fromRoom}:${route.resource}`;
    const committed = directCommitment[key] || 0;
    const effectiveAmount = route.amount - committed - reservePerRoom;
    if (effectiveAmount <= 0) continue;

    addPlannedRoute(
      route.fromRoom,
      hubRoomName,
      route.resource,
      effectiveAmount,
      route.fee,
      `synthesis:surplus:${route.resource}`,
    );
  }

  cancelStaleSynthesisRouteTasks(
    new Set(plannedRoutes.keys()),
    activeAssignments,
    distributedStorage === true,
    hubRoomName,
    knownSynthesisRooms,
  );
  for (const route of plannedRoutes.values()) {
    upsertSynthesisRouteTask(route.fromRoom, route.toRoom, route.resource, route.amount, route.reason);
  }
}

function getSynthesisRouteTaskKey(
  fromRoomName: string,
  toRoomName: string,
  resource: ResourceConstant,
  reason: string,
): string {
  return `${fromRoomName}->${toRoomName}:${resource}:${reason}`;
}

function upsertSynthesisRouteTask(
  fromRoomName: string,
  toRoomName: string,
  resource: ResourceConstant,
  amount: number,
  reason: string,
): void {
  // The allocation ledger already consumes healthy pending work, so this
  // decision is an additional uncovered amount. Reuse the canonical automatic
  // merge path: it increments amount/remaining together, preserves delivered
  // progress and lastProgressAt, and skips coverage-expired predecessors.
  createAutomaticResourceTransferTask(fromRoomName, toRoomName, resource, amount, reason);
}

interface ActiveSynthesisRouteDemand {
  byRoom: Map<string, Set<ResourceConstant>>;
  distributedStorage: boolean;
  hubRoomName: string;
  knownRooms: ReadonlySet<string>;
}

function getActiveSynthesisRouteDemand(
  activeAssignments: readonly SynthesisDispatchAssignment[],
  distributedStorage: boolean,
  hubRoomName: string,
  knownRooms: ReadonlySet<string>,
): ActiveSynthesisRouteDemand {
  const byRoom = new Map<string, Set<ResourceConstant>>();
  for (const assignment of activeAssignments) {
    const reagents = getDirectReagents(assignment.product);
    if (reagents.size > 0) byRoom.set(assignment.roomName, reagents);
  }
  return { byRoom, distributedStorage, hubRoomName, knownRooms };
}

function getEffectiveSynthesisRouteAssignments(
  plannedAssignments: readonly SynthesisDispatchAssignment[],
  eligibleRooms: readonly SynthesisRoomCapability[],
  transferAmounts: ResourceTransferTaskAmountIndex,
): SynthesisDispatchAssignment[] {
  const byRoom = new Map(
    plannedAssignments.map(assignment => [assignment.roomName, assignment]),
  );

  for (const room of eligibleRooms) {
    if (byRoom.has(room.roomName)) continue;

    const runtimeRoom = Memory.runtime?.synthesisControl?.rooms?.[room.roomName];
    const roomCfg = Memory.cfg?.synthesisControl?.rooms?.[room.roomName];
    let product: ResourceConstant | undefined;

    // A busy or otherwise non-rewriteable room keeps executing its runtime
    // product even when the new distributed plan deliberately leaves it out.
    if (!canRewriteSynthesisRoom(room.roomName, runtimeRoom?.stage, transferAmounts)) {
      product = runtimeRoom?.activeProduct as ResourceConstant | undefined;
    }

    // The distributed-storage Hub fallback and an enabled retained config can
    // both be active without appearing in dispatchAssignments. This read runs
    // after config writes, so it observes the product that will actually run.
    if (!product && roomCfg?.enabled !== false) {
      product = roomCfg?.reactions?.[0]?.product;
    }

    if (!product || !getProductReagentMap()[product]) continue;
    byRoom.set(room.roomName, {
      roomName: room.roomName,
      product,
      targetAmount: runtimeRoom?.batchSize ?? roomCfg?.reactions?.[0]?.batchSize ?? 0,
      isHubRoom: false,
    });
  }

  return [...byRoom.values()];
}

function supportsActiveSynthesisRouteDemand(
  task: ResourceTransferTask,
  activeDemand: ActiveSynthesisRouteDemand,
): boolean {
  if (!countsResourceTransferTaskTowardDemand(task)) return false;

  if (task.reason?.startsWith("synthesis:direct:")) {
    const activeReagents = activeDemand.byRoom.get(task.toRoomName);
    // A healthy route is an already-issued quantity commitment. Without
    // durable consumer provenance, zero incremental demand is not authority to
    // shrink it. Only a known active product that no longer uses the resource
    // is reliable direct-route stale evidence.
    if (activeReagents) return activeReagents.has(task.resource);
    return !activeDemand.knownRooms.has(task.toRoomName);
  }

  if (task.reason?.startsWith("synthesis:hub-route:")) {
    // A hub-route task is the first leg of a staged delivery, so its endpoint
    // does not identify the downstream synthesis room. Without persistent
    // consumer provenance, absence from this revision's incremental decisions
    // is not proof that the first leg is stale. Let completion/liveness TTL
    // resolve it rather than churning a route that the ledger already consumed.
    return task.toRoomName === activeDemand.hubRoomName;
  }

  if (task.reason?.startsWith("synthesis:surplus:")) {
    // Distributed storage explicitly stops centralizing non-T3 surplus, which
    // is reliable stale-policy evidence. Other surplus work has no durable
    // provenance, so let healthy tasks finish rather than churn revisions.
    if (task.toRoomName !== activeDemand.hubRoomName) {
      return false;
    }
    if (activeDemand.distributedStorage && !T3_TARGETS.includes(task.resource)) {
      return false;
    }
    return true;
  }

  return false;
}

function cancelStaleSynthesisRouteTasks(
  activeRouteKeys: Set<string>,
  activeAssignments: readonly SynthesisDispatchAssignment[],
  distributedStorage: boolean,
  hubRoomName: string,
  knownSynthesisRooms: ReadonlySet<string>,
): number {
  const taskStore = ensureResourceTransferTaskStore();
  const activeDemand = getActiveSynthesisRouteDemand(
    activeAssignments,
    distributedStorage,
    hubRoomName,
    knownSynthesisRooms,
  );
  let cancelled = 0;
  for (const task of Object.values(taskStore)) {
    if (
      task.status === "pending" &&
      task.origin === "automatic" &&
      (task.reason?.startsWith("synthesis:direct:") || task.reason?.startsWith("synthesis:hub-route:") || task.reason?.startsWith("synthesis:surplus:"))
    ) {
      const key = getSynthesisRouteTaskKey(task.fromRoomName, task.toRoomName, task.resource, task.reason);
      if (activeRouteKeys.has(key)) continue;
      // ResourceControl owns liveness terminalization and its machine-readable
      // timeout reason. A missing incremental key must not rewrite that audit
      // fact to the weaker cancelled_by_replan label earlier in the tick.
      if (!countsResourceTransferTaskTowardDemand(task)) continue;
      if (supportsActiveSynthesisRouteDemand(task, activeDemand)) continue;

      task.status = "cancelled";
      task.updatedAt = Game.time;
      task.lastError = "cancelled_by_replan";
      cancelled++;
    }
  }
  return cancelled;
}

export function resupplyBusySynthesisRooms(
  hubRoomName: string,
  hubInventory: Record<string, number>,
  reservePerRoom: number,
  transferAmounts: ResourceTransferTaskAmountIndex = createResourceTransferTaskAmountIndex(),
): string[] {
  const actions: string[] = [];

  const myRooms = getTickContextService().getMyRooms();
  const synthesisRooms = Memory.runtime?.synthesisControl?.rooms;
  if (!synthesisRooms) return actions;

  for (const room of myRooms) {
    if (room.name === hubRoomName) continue;
    if (!room.controller?.my || !room.terminal || !room.storage) continue;

    const roomState = synthesisRooms[room.name];
    if (!roomState) continue;

    const stage = roomState.stage;
    if (!stage || ACCEPT_REASSIGN_STAGES.has(stage)) continue;

    const missing = roomState.missing;
    if (!missing) continue;

    for (const [resource, deficit] of Object.entries(missing)) {
      if (!deficit || deficit <= 0) continue;
      const rc = resource as ResourceConstant;

      const incoming = transferAmounts.getIncoming(room.name, rc);
      if (incoming >= deficit) continue;

      const needed = deficit - incoming;

      const hubHas = hubInventory[rc] || 0;
      const hubOutgoing = transferAmounts.getOutgoing(hubRoomName, rc);
      const hubExportable = Math.max(0, hubHas - hubOutgoing - reservePerRoom);
      if (hubExportable <= 0) continue;

      const amount = Math.min(needed, hubExportable);
      const reason = `synthesis:resupply:${rc}`;
      const result = createAutomaticResourceTransferTask(hubRoomName, room.name, rc, amount, reason);
      if (typeof result === "object" && result.ok) {
        actions.push(`resupply:${room.name}:${rc}=${amount}`);
      }
    }
  }

  return actions;
}

function getDirectReagents(product: ResourceConstant | undefined): Set<ResourceConstant> {
  if (!product) return new Set();
  const pair = getProductReagentMap()[product];
  if (!pair) return new Set();
  return new Set(pair as ResourceConstant[]);
}

export function wireDistributedSynthesis(
  hubRoomName: string,
  attemptRevision: number,
  targetCompounds: ResourceConstant[],
  hubReservePerCompound: number,
  reservePerRoom: number,
  hubInventory: Record<string, number>,
  steps: ChainStep[],
  distributedStorage?: boolean,
  effectiveTargetReserve?: number,
  transferAmounts: ResourceTransferTaskAmountIndex = createResourceTransferTaskAmountIndex(),
  additionalDemands: Partial<Record<ResourceConstant, number>> = {},
  precomputedPlan?: DistributedSynthesisPlan,
  hubOnlyTargetReserve: number = hubReservePerCompound,
): boolean {
  if (precomputedPlan) {
    const precomputedViolations = getAssignmentInvariantViolations(
      precomputedPlan.dispatchAssignments,
      hubRoomName,
    );
    if (precomputedViolations.length > 0) {
      const hubRuntime = Memory.runtime?.hub as HubRuntimeLiveness | undefined;
      if (hubRuntime) {
        hubRuntime.distributedSynthesis = {
          roomCapabilities: {},
          dispatchAssignments: [],
          allocationLedger: {},
          routeDecisions: [],
          blockedTargets: precomputedPlan.blockedTargets.slice(0, HUB_RUNTIME_ARRAY_CAP),
          invariantViolations: precomputedViolations,
          configReconcile: createConfigReconcileSummary(attemptRevision),
        };
      }
      throw new Error(precomputedViolations.join("|"));
    }
  }

  const eligibleRooms = getEligibleSynthesisRooms().filter(room =>
    isSynthesisRoomAvailableToHubPlanner(room.roomName, hubRoomName)
  );
  const auxRooms = eligibleRooms.filter(r => r.roomName !== hubRoomName);

  if (auxRooms.length === 0) {
    return false;
  }

  const plan = precomputedPlan ?? planDistributedSynthesis(
    hubRoomName,
    targetCompounds,
    hubReservePerCompound,
    reservePerRoom,
    hubInventory,
    effectiveTargetReserve,
    transferAmounts,
    additionalDemands,
    hubOnlyTargetReserve,
  );

  // Prepare the effective plan entirely in local values. Busy-room continuity
  // may replace a proposed product, but no runtime/config/route fact is
  // committed until the final assignment set passes the invariant validator.
  const effectiveAssignments = plan.dispatchAssignments.map(assignment => ({ ...assignment }));
  const mismatches: Array<{ roomName: string; oldProduct: ResourceConstant; actualProduct: ResourceConstant }> = [];

  for (const room of eligibleRooms) {
    const runtimeRoom = Memory.runtime?.synthesisControl?.rooms?.[room.roomName];
    const stage = runtimeRoom?.stage;
    if (canRewriteSynthesisRoom(room.roomName, stage, transferAmounts)) continue;

    const activeProduct = runtimeRoom?.activeProduct as ResourceConstant | undefined;
    if (!activeProduct) continue;

    const existingIndex = effectiveAssignments.findIndex(a => a.roomName === room.roomName);

    if (existingIndex < 0) {
      // The room is executing an older plan that the current revision did not
      // select. Keep its config in reconcile as skipped-busy; do not turn that
      // continuity fact back into a new assignment/protection commitment.
    } else if (effectiveAssignments[existingIndex].product !== activeProduct) {
      const oldProduct = effectiveAssignments[existingIndex].product as ResourceConstant;
      mismatches.push({ roomName: room.roomName, oldProduct, actualProduct: activeProduct });

      effectiveAssignments[existingIndex] = {
        ...effectiveAssignments[existingIndex],
        product: activeProduct,
        targetAmount: runtimeRoom?.targetAmount ?? 0,
      };
    }
  }

  // Filter stale route decisions for mismatched rooms before validation, but
  // keep the result local until the assignment invariant succeeds.
  let filteredRouteDecisions = plan.routeDecisions;
  if (mismatches.length > 0) {
    const mismatchMap = new Map(mismatches.map(m => [m.roomName, m]));
    filteredRouteDecisions = plan.routeDecisions.filter(route => {
      const mismatch = mismatchMap.get(route.toRoom);
      if (!mismatch) return true;
      const oldReagents = getDirectReagents(mismatch.oldProduct);
      const actualReagents = getDirectReagents(mismatch.actualProduct);
      // Drop if resource is old-only direct reagent (not shared with actual product)
      return !(oldReagents.has(route.resource as ResourceConstant) && !actualReagents.has(route.resource as ResourceConstant));
    });
  }

  const invariantViolations = getAssignmentInvariantViolations(effectiveAssignments, hubRoomName);
  if (invariantViolations.length > 0) {
    const hubRuntime = Memory.runtime?.hub as HubRuntimeLiveness | undefined;
    if (hubRuntime) {
      hubRuntime.distributedSynthesis = {
        roomCapabilities: {},
        dispatchAssignments: [],
        allocationLedger: {},
        routeDecisions: [],
        blockedTargets: plan.blockedTargets.slice(0, HUB_RUNTIME_ARRAY_CAP),
        invariantViolations,
        configReconcile: createConfigReconcileSummary(attemptRevision),
      };
    }
    throw new Error(invariantViolations.join("|"));
  }

  const hubRuntime = Memory.runtime?.hub as HubRuntimeLiveness | undefined;
  if (!hubRuntime) return true;
  const roomCapabilities: Record<string, SynthesisRoomCapability> = {};
  for (const room of eligibleRooms) roomCapabilities[room.roomName] = room;
  hubRuntime.distributedSynthesis = {
    roomCapabilities,
    dispatchAssignments: effectiveAssignments,
    allocationLedger: plan.allocationLedger,
    routeDecisions: filteredRouteDecisions,
    blockedTargets: plan.blockedTargets.slice(0, HUB_RUNTIME_ARRAY_CAP),
    invariantViolations: [],
  };
  hubRuntime.missingResources = plan.missingResources.slice(0, HUB_RUNTIME_ARRAY_CAP);

  if (!Memory.cfg) return true;
  if (!Memory.cfg.synthesisControl) Memory.cfg.synthesisControl = {};
  Memory.cfg.synthesisControl.enabled = true;
  if (!Memory.cfg.synthesisControl.rooms) Memory.cfg.synthesisControl.rooms = {};

  const selectedRooms = new Set(effectiveAssignments.map(assignment => assignment.roomName));
  const refreshedRooms: string[] = [];
  for (const assignment of effectiveAssignments) {
    const roomName = assignment.roomName;
    const stage = Memory.runtime?.synthesisControl?.rooms?.[roomName]?.stage;
    if (!canRewriteSynthesisRoom(roomName, stage, transferAmounts)) continue;
    if (!getProductReagentMap()[assignment.product]) continue;

    const roomObj = Game.rooms[roomName];
    let existingAmount = 0;
    if (roomObj?.storage) {
      const storage = roomObj.storage.store as unknown as Record<string, number>;
      existingAmount += storage[assignment.product] || 0;
    }
    if (roomObj?.terminal) {
      const terminal = roomObj.terminal.store as unknown as Record<string, number>;
      existingAmount += terminal[assignment.product] || 0;
    }

    writeOwnedSynthesisReaction(roomName, hubRoomName, attemptRevision, {
      product: assignment.product,
      targetAmount: roundUpReactionAmount(existingAmount + assignment.targetAmount),
      batchSize: Math.min(3000, Math.max(5, roundUpReactionAmount(assignment.targetAmount))),
      donorRoomNames: [],
    });
    refreshedRooms.push(roomName);
  }

  // Hub-room synthesis config fallback:
  // When distributedStorage is active, the hub room may not appear in dispatch
  // assignments (planner assigns aux rooms instead). This block ensures the hub
  // room's synthesisControl config stays synchronized with the chain steps,
  // using the same write-pattern as writeSynthesisConfig.
  //
  // Guard: when the plan DOES include an explicit hub-room dispatch assignment,
  // the first-pass assignment writer above already owns the hub room config. The
  // fallback must not run in that case — otherwise, with empty `steps`, it would
  // clear the just-written hub assignment (e.g. reactions=[] overwriting UH).
  if (distributedStorage) {
    const hubHasDispatchAssignment = effectiveAssignments.some(a => a.roomName === hubRoomName);
    if (!hubHasDispatchAssignment) {
      const nextStep = steps.length > 0 ? steps[0] : null;
      const hubRoomAvailable = isSynthesisRoomAvailableToHubPlanner(
        hubRoomName,
        hubRoomName,
      );
      if (nextStep && hubRoomAvailable) selectedRooms.add(hubRoomName);
      const hubStage = Memory.runtime?.synthesisControl?.rooms?.[hubRoomName]?.stage;
      if (
        nextStep &&
        hubRoomAvailable &&
        canRewriteSynthesisRoom(hubRoomName, hubStage, transferAmounts)
      ) {
        writeOwnedSynthesisReaction(hubRoomName, hubRoomName, attemptRevision, {
          product: nextStep.product,
          targetAmount: roundUpReactionAmount((hubInventory[nextStep.product] || 0) + nextStep.targetAmount),
          batchSize: Math.min(3000, Math.max(5, roundUpReactionAmount(nextStep.targetAmount))),
          donorRoomNames: [],
        });
        refreshedRooms.push(hubRoomName);
      }
    }
  }

  hubRuntime.distributedSynthesis!.configReconcile = reconcileHubOwnedSynthesisConfigs(
    hubRoomName,
    attemptRevision,
    selectedRooms,
    refreshedRooms,
    transferAmounts,
  );

  const effectiveRouteAssignments = getEffectiveSynthesisRouteAssignments(
    effectiveAssignments,
    eligibleRooms,
    transferAmounts,
  );
  wireRouteTransferTasks(
    filteredRouteDecisions,
    hubRoomName,
    reservePerRoom,
    distributedStorage,
    effectiveRouteAssignments,
    new Set(eligibleRooms.map(room => room.roomName)),
  );

  return true;
}

type HubRuntimeState = NonNullable<Memory["runtime"]>["hub"];

type HubPlanningAttemptResult =
  | {
      valid: true;
      planMode: "distributed" | "fallback" | "blocked";
    }
  | {
      valid: false;
      reason: string;
    };

function resetUncommittedHubProtectionFields(
  rt: HubRuntimeState,
  diagnostics?: HubDistributedSynthesisRuntime,
): void {
  const runtime = rt as HubRuntimeLiveness;
  runtime.distributedSynthesis = {
    roomCapabilities: {},
    dispatchAssignments: [],
    allocationLedger: {},
    routeDecisions: [],
    blockedTargets: diagnostics?.blockedTargets?.slice(0, HUB_RUNTIME_ARRAY_CAP) ?? [],
    invariantViolations: diagnostics?.invariantViolations?.slice(0, HUB_RUNTIME_ARRAY_CAP) ?? [],
    ...(diagnostics?.configReconcile
      ? {
          configReconcile: {
            revision: diagnostics.configReconcile.revision,
            refreshedRooms: diagnostics.configReconcile.refreshedRooms.slice(0, HUB_RUNTIME_ARRAY_CAP),
            clearedRooms: diagnostics.configReconcile.clearedRooms.slice(0, HUB_RUNTIME_ARRAY_CAP),
            skippedBusyRooms: diagnostics.configReconcile.skippedBusyRooms.slice(0, HUB_RUNTIME_ARRAY_CAP),
            foreignOwnerRooms: diagnostics.configReconcile.foreignOwnerRooms.slice(0, HUB_RUNTIME_ARRAY_CAP),
          },
        }
      : {}),
  };
  rt.marketSellSurplus = {};
}

function protectionTransferTasks(): unknown[] {
  const tasks = Memory.data?.resourceControl?.tasks;
  if (!tasks || typeof tasks !== "object" || Array.isArray(tasks)) return [];
  return Object.values(tasks);
}

export function runHubPlanner(): void {
  let cfg = Memory.cfg?.hub;
  if (cfg?.enabled === true && cfg.hubRoomName) {
    cfg = normalizeHubConfig(cfg);
    if (cfg !== Memory.cfg?.hub) {
      Memory.cfg!.hub = cfg;
    }
  }

  const rt = Memory.runtime?.hub;
  if (!rt) {
    if (cfg?.enabled !== true && cfg?.hubRoomName) {
      clearHubSynthesisReactions(cfg.hubRoomName);
    }
    return;
  }

  const protectionRuntime = rt as HubRuntimeState &
    HubRuntimeProtectionExtension;
  const ownedHubRoomNames = getHubPlannerOwnershipHubRoomNames();
  const configOwnershipHighWater = getHubPlannerOwnershipHighWater(cfg?.hubRoomName);
  const runtimeHighWater = Number.isFinite(protectionRuntime.protectionAttemptHighWater)
    ? Math.max(0, Math.floor(protectionRuntime.protectionAttemptHighWater!))
    : 0;
  protectionRuntime.protectionAttemptHighWater = Math.max(
    runtimeHighWater,
    configOwnershipHighWater,
  );
  const protectionConfig = cfg ?? { enabled: false };
  const configObservation = observeHubProtectionConfigIncarnation(
    protectionRuntime,
    protectionConfig,
    Game.time,
  );

  if (cfg?.enabled !== true || !cfg.hubRoomName) {
    const cleanupHubRoomNames = cfg?.hubRoomName
      ? [cfg.hubRoomName]
      : ownedHubRoomNames;
    const cleanupCadence = Math.max(1, cfg?.planInterval || HUB_PLAN_INTERVAL);
    const cleanupDue = cleanupHubRoomNames.length > 0 && Game.time % cleanupCadence === 0;
    if (configObservation.changed || cleanupDue) {
      const disabledAttempt = beginHubProtectionAttempt(
        protectionRuntime,
        protectionConfig,
        Game.time,
      );
      resetUncommittedHubProtectionFields(rt);
      if (cleanupHubRoomNames.length > 0) {
        const transferAmounts = createResourceTransferTaskAmountIndex();
        (rt as HubRuntimeLiveness).distributedSynthesis!.configReconcile =
          mergeConfigReconcileSummaries(
            disabledAttempt.attemptRevision,
            cleanupHubRoomNames.map(hubRoomName =>
              reconcileHubOwnedSynthesisConfigs(
                hubRoomName,
                disabledAttempt.attemptRevision,
                new Set(),
                [],
                transferAmounts,
              )
            ),
          );
      }
      publishInvalidHubProtectionSnapshot(
        protectionRuntime,
        disabledAttempt,
        protectionConfig,
        Game.time,
        "blocked",
        cfg?.enabled === false ? "hub_disabled" : "hub_config_missing",
      );
    }
    return;
  }

  const onCadence = Game.time % (cfg.planInterval || 50) === 0;
  if (
    !configObservation.changed &&
    !onCadence &&
    rt.needsPlan !== true
  ) {
    return;
  }

  const attempt = beginHubProtectionAttempt(
    protectionRuntime,
    cfg,
    Game.time,
  );
  resetUncommittedHubProtectionFields(rt);

  let published = false;
  let failureStatus: "blocked" | "failed" = "failed";
  let failureReason = "hub_planning_incomplete";

  try {
    const result = runHubPlanningAttempt(cfg, rt, attempt.attemptRevision);
    if ("reason" in result) {
      failureStatus = "blocked";
      failureReason = result.reason;
    } else {
      const snapshot = buildCommittedHubProtectionSnapshot({
        revision: attempt.attemptRevision,
        configIncarnation: attempt.configIncarnation,
        tick: Game.time,
        expiresAt: Game.time + Math.max(1, cfg.planInterval || 50),
        config: cfg,
        runtime: rt,
        synthesisRooms: Memory.cfg?.synthesisControl?.rooms ?? {},
        transferTasks: protectionTransferTasks(),
        planMode: result.planMode,
      });
      publishCommittedHubProtectionSnapshot(
        protectionRuntime,
        attempt,
        snapshot,
      );
      rt.marketSellSurplus = {
        ...(snapshot.baseMineralSurplus.byRoom[cfg.hubRoomName] ?? {}),
      };
      rt.needsPlan = false;
      rt.lastPlanTick = Game.time;
      rt.updatedAt = Game.time;
      rt.lastError = undefined;
      published = true;
    }
  } catch (error) {
    failureStatus = "failed";
    failureReason =
      error instanceof Error ? error.message : "hub_planning_throw";
    rt.status = "blocked";
    rt.lastError = failureReason;
  } finally {
    if (!published) {
      const diagnostics = (rt as HubRuntimeLiveness).distributedSynthesis;
      resetUncommittedHubProtectionFields(rt, diagnostics);
      publishInvalidHubProtectionSnapshot(
        protectionRuntime,
        attempt,
        cfg,
        Game.time,
        failureStatus,
        failureReason,
      );
    }
  }
}

function blockHubPlanningAttempt(
  cfg: NonNullable<Memory["cfg"]>["hub"],
  rt: HubRuntimeState,
  attemptRevision: number,
  reason: string,
): HubPlanningAttemptResult {
  rt.status = "blocked";
  const transferAmounts = createResourceTransferTaskAmountIndex();
  (rt as HubRuntimeLiveness).distributedSynthesis!.configReconcile =
    reconcileHubOwnedSynthesisConfigs(
      cfg.hubRoomName,
      attemptRevision,
      new Set(),
      [],
      transferAmounts,
    );
  return { valid: false, reason };
}

function runHubPlanningAttempt(
  cfg: NonNullable<Memory["cfg"]>["hub"],
  rt: HubRuntimeState,
  attemptRevision: number,
): HubPlanningAttemptResult {
  const room = Game.rooms[cfg.hubRoomName];
  if (!room) {
    return blockHubPlanningAttempt(cfg, rt, attemptRevision, "hub_room_not_visible");
  }

  if (!room.controller?.my) {
    return blockHubPlanningAttempt(cfg, rt, attemptRevision, "hub_room_not_owned");
  }

  if (!room.storage) {
    return blockHubPlanningAttempt(cfg, rt, attemptRevision, "hub_storage_missing");
  }

  if (!room.terminal) {
    return blockHubPlanningAttempt(cfg, rt, attemptRevision, "hub_terminal_missing");
  }

  if (countLabs(room) < 3) {
    return blockHubPlanningAttempt(cfg, rt, attemptRevision, "hub_labs_insufficient");
  }

  const hubInventory: Record<string, number> = {};
  const storage = room.storage.store as unknown as Record<string, number>;
  for (const [res, amt] of Object.entries(storage)) {
    if (res !== RESOURCE_ENERGY && amt > 0) {
      hubInventory[res] = amt;
    }
  }
  const terminal = room.terminal.store as unknown as Record<string, number>;
  for (const [res, amt] of Object.entries(terminal)) {
    if (res !== RESOURCE_ENERGY && amt > 0) {
      hubInventory[res] = (hubInventory[res] || 0) + amt;
    }
  }

  // Include lab/factory/power-spawn mineral contents so hub inventory agrees
  // with synthesisControl roomResourceAmount (which also counts these structures).
  const labLikeStructures = room.find(FIND_MY_STRUCTURES, {
    filter: (s: Structure) =>
      s.structureType === STRUCTURE_LAB ||
      s.structureType === STRUCTURE_FACTORY ||
      s.structureType === STRUCTURE_POWER_SPAWN,
  }) as AnyStoreStructure[];
  for (const structure of labLikeStructures) {
    if (!structure.store) continue;
    const store = structure.store as unknown as Record<string, number>;
    for (const [res, amt] of Object.entries(store)) {
      if (res !== RESOURCE_ENERGY && amt > 0) {
        hubInventory[res] = (hubInventory[res] || 0) + amt;
      }
    }
  }

  const carrierCargo = collectCarrierCargoInventory(cfg.hubRoomName);
  for (const [res, amt] of Object.entries(carrierCargo)) {
    if (amt > 0) {
      hubInventory[res] = (hubInventory[res] || 0) + amt;
    }
  }

  const allRelevantResources = [...BASE_MINERALS, ...INTERMEDIATE_COMPOUNDS, ...T3_TARGETS];
  const transferAmountsBeforeImports = createResourceTransferTaskAmountIndex();
  const incomingResources: Record<string, number> = {};
  for (const res of allRelevantResources) {
    const amount = transferAmountsBeforeImports.getIncoming(cfg.hubRoomName, res);
    if (amount > 0) {
      incomingResources[res] = amount;
    }
  }

  const hubReservePerCompound = cfg.hubReservePerCompound ?? HUB_RESERVE_PER_COMPOUND;
  const hubOnlyTargetReserve = getHubOnlyReserve(cfg);
  const targetCompounds = cfg.targetCompounds?.length ? cfg.targetCompounds : HUB_TARGET_COMPOUNDS;
  const satelliteDeficit = computeTotalSatelliteDeficit(cfg, targetCompounds, transferAmountsBeforeImports);
  const chainTarget = hubReservePerCompound + satelliteDeficit;
  const nukerGhodiumDemand = getNukerGhodiumProductionDemand();
  const additionalProductionDemands: Partial<Record<ResourceConstant, number>> =
    nukerGhodiumDemand > 0
      ? { [RESOURCE_GHODIUM]: nukerGhodiumDemand }
      : {};

  planHubImports(cfg, transferAmountsBeforeImports, hubInventory);
  const transferAmountsAfterImports = createResourceTransferTaskAmountIndex();
  // 本帧新建的 OH 补库也算覆盖，避免 fallback 再生产一份相同的储备。
  for (const compound of targetCompounds.filter(isHubOnlyReserveCompound)) {
    incomingResources[compound] = transferAmountsAfterImports.getIncoming(cfg.hubRoomName, compound);
  }

  const result = planHubChains(
    hubInventory,
    incomingResources,
    chainTarget,
    targetCompounds,
    additionalProductionDemands,
    hubOnlyTargetReserve,
  );

  const distributedPreview = result.blocked
    ? planDistributedSynthesis(
        cfg.hubRoomName,
        targetCompounds,
        hubReservePerCompound,
        cfg.reservePerRoom ?? HUB_RESERVE_PER_ROOM,
        hubInventory,
        chainTarget,
        transferAmountsAfterImports,
        additionalProductionDemands,
        hubOnlyTargetReserve,
      )
    : null;
  const distributedAssignments = distributedPreview?.dispatchAssignments ?? [];
  const distributedCanProceed = distributedAssignments.length > 0;

  rt.missingResources = (
    distributedPreview?.missingResources ?? result.missingResources
  ).slice(0, HUB_RUNTIME_ARRAY_CAP);

  if (result.blocked && !distributedCanProceed) {
    rt.status = "blocked";
    rt.activeProduct = "";
    rt.activeStep = 0;
    rt.lastPlanActions = [];
    const blockedRuntime = rt as HubRuntimeLiveness;
    blockedRuntime.distributedSynthesis!.blockedTargets = (
      distributedPreview?.blockedTargets ?? targetCompounds
    ).slice(0, HUB_RUNTIME_ARRAY_CAP);
    blockedRuntime.distributedSynthesis!.configReconcile = writeSynthesisConfig(
      cfg.hubRoomName,
      attemptRevision,
      [],
      hubInventory,
      transferAmountsAfterImports,
    );
  } else if (result.steps.length === 0 && !distributedCanProceed) {
    rt.status = "distributing";
    rt.activeProduct = "";
    rt.activeStep = 0;
    rt.lastPlanActions = [];
  } else {
    rt.status = "importing";
    rt.activeProduct = result.steps[0]?.product ?? distributedAssignments[0]?.product ?? "";
    rt.activeStep = 0;
    rt.lastPlanActions = (result.steps.length > 0
      ? result.steps.map((s) => s.product)
      : distributedAssignments.map((assignment) => assignment.product)
    ).slice(0, HUB_RUNTIME_ARRAY_CAP);
  }

  if (!result.blocked || distributedCanProceed) {
    const hubReservePerCompound2 = cfg.hubReservePerCompound ?? HUB_RESERVE_PER_COMPOUND;
    const reservePerRoom2 = cfg.reservePerRoom ?? HUB_RESERVE_PER_ROOM;
    const targetCompounds2 = cfg.targetCompounds?.length ? cfg.targetCompounds : HUB_TARGET_COMPOUNDS;

    const distributed = wireDistributedSynthesis(
      cfg.hubRoomName,
      attemptRevision,
      targetCompounds2,
      hubReservePerCompound2,
      reservePerRoom2,
      hubInventory,
      result.steps,
      cfg.distributedStorage,
      chainTarget,
      transferAmountsAfterImports,
      additionalProductionDemands,
      distributedPreview ?? undefined,
      hubOnlyTargetReserve,
    );

    if (!distributed) {
      (rt as HubRuntimeLiveness).distributedSynthesis!.configReconcile = writeSynthesisConfig(
        cfg.hubRoomName,
        attemptRevision,
        result.steps,
        hubInventory,
        transferAmountsAfterImports,
      );
    }
  }

  const reservePerRoom3 = cfg.reservePerRoom ?? HUB_RESERVE_PER_ROOM;
  resupplyBusySynthesisRooms(cfg.hubRoomName, hubInventory, reservePerRoom3);

  if (room.storage && room.terminal) {
    planHubDistribution(cfg);
  }

  if (result.blocked && !distributedCanProceed) {
    return { valid: true, planMode: "blocked" };
  }
  return {
    valid: true,
    planMode:
      (rt.distributedSynthesis?.dispatchAssignments?.length ?? 0) > 0
        ? "distributed"
        : "fallback",
  };
}
