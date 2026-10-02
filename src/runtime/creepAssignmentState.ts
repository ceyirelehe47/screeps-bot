import type { CarrierTaskType } from "@/runtime/carrierTaskBoard";
import type {
  CarrierDispatchRef,
  WorkerDispatchRef,
} from "@/runtime/dispatchOwnership/ref";

type CarrierPlanTargetKind = "resource" | "structure";
type CarrierPlanMode = "pickup" | "deliver";
type PickupTargetKind = "resource" | "structure";

export interface CreepAssignmentState {
  carrierPlanMode?: CarrierPlanMode;
  carrierPlanTargetId?: string;
  carrierPlanTargetKind?: CarrierPlanTargetKind;
  carrierStorageOnlyMode?: boolean;
  yieldAfterCapacityReliefPickup?: boolean;
  energyPickupTargetId?: string;
  energyPickupTargetKind?: PickupTargetKind;
  energyPickupRoomName?: string;
  taskId?: string;
  synthesisCarrierTaskId?: string;
  dispatchBindings?: {
    worker?: WorkerDispatchRef;
    carrier?: CarrierDispatchRef;
  };
  synthesisCarrierPendingPickupTick?: number;
  synthesisCarrierPendingStepId?: string;
  synthesisCarrierPendingDeliveryTick?: number;
  synthesisCarrierPendingFromId?: string;
  synthesisCarrierPendingToId?: string;
  synthesisCarrierPendingResource?: ResourceConstant;
  synthesisCarrierPendingTaskType?: CarrierTaskType;
  synthesisCarrierPendingDestinationTargetAmount?: number;
  synthesisCarrierPendingBoundResourceTransferTaskId?: string;
  synthesisCarrierPendingBoundResourceTransferTaskIdentity?: string;
  /** 原 accepted cargo provenance 保留；额外标记安全退回源 Storage 的目的地。 */
  synthesisCarrierPendingReturnToId?: string;
  /** Accepted-cargo provenance; independent from the actor's current sticky binding. */
  synthesisCarrierPendingTaskRef?: CarrierDispatchRef;
}

type AssignmentStateStore = Record<string, CreepAssignmentState>;

export type CreepAssignmentStateSnapshot = Readonly<CreepAssignmentState>;
export type CreepAssignmentStateStoreSnapshot = Readonly<Record<string, CreepAssignmentStateSnapshot>>;

type RuntimeGlobalWithAssignmentState = typeof global & {
  __creepAssignmentState?: AssignmentStateStore;
};

const runtimeGlobal: RuntimeGlobalWithAssignmentState = global;

function ensureAssignmentStateStore(): AssignmentStateStore {
  if (!runtimeGlobal.__creepAssignmentState) {
    runtimeGlobal.__creepAssignmentState = Object.create(null) as AssignmentStateStore;
  }

  return runtimeGlobal.__creepAssignmentState;
}

function ownDataValue(target: object, key: string): { found: boolean; value?: unknown } {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(target, key);
  } catch {
    return { found: false };
  }
  if (!descriptor || !("value" in descriptor)) return { found: false };
  return { found: true, value: descriptor.value };
}

function defineOwnDataValue(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

export function ensureCreepAssignmentState(creepName: string): CreepAssignmentState {
  const store = ensureAssignmentStateStore();
  const existing = ownDataValue(store, creepName);
  if (existing.found && existing.value) {
    return existing.value as CreepAssignmentState;
  }

  const state: CreepAssignmentState = {};
  defineOwnDataValue(store, creepName, state);
  return state;
}

export function getCreepAssignmentState(creepName: string): CreepAssignmentState | undefined {
  const store = runtimeGlobal.__creepAssignmentState;
  if (!store) return undefined;
  const existing = ownDataValue(store, creepName);
  return existing.found ? existing.value as CreepAssignmentState : undefined;
}

function defineAssignmentSnapshotProperty(
  target: object,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function cloneAssignmentSnapshotValue(
  value: unknown,
  seen: WeakMap<object, unknown> = new WeakMap(),
): unknown {
  if (
    value === null
    || (typeof value !== "object" && typeof value !== "function")
  ) {
    return value;
  }

  const source = value as object;
  const existing = seen.get(source);
  if (existing !== undefined) {
    return existing;
  }

  let snapshot: object;
  if (Array.isArray(value)) {
    snapshot = new Array(value.length);
  } else if (typeof value === "function") {
    snapshot = function assignmentSnapshotFunction(): undefined {
      return undefined;
    };
  } else {
    const prototype = Object.getPrototypeOf(source);
    if (prototype === null) {
      snapshot = Object.create(null) as object;
    } else if (prototype === Object.prototype) {
      snapshot = {};
    } else {
      snapshot = Object.create(Object.freeze({})) as object;
    }
  }
  seen.set(source, snapshot);

  for (const key of Object.keys(source)) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(source, key);
    } catch {
      defineAssignmentSnapshotProperty(snapshot, key, undefined);
      continue;
    }

    if (!descriptor || !("value" in descriptor)) {
      defineAssignmentSnapshotProperty(snapshot, key, undefined);
      continue;
    }

    let clonedValue: unknown;
    try {
      clonedValue = cloneAssignmentSnapshotValue(descriptor.value, seen);
    } catch {
      clonedValue = undefined;
    }
    defineAssignmentSnapshotProperty(snapshot, key, clonedValue);
  }

  return snapshot;
}

function snapshotCreepAssignmentState(state: CreepAssignmentState): CreepAssignmentStateSnapshot {
  return cloneAssignmentSnapshotValue(state) as CreepAssignmentStateSnapshot;
}

/** Returns one isolated assignment snapshot without creating assignment state. */
export function peekCreepAssignmentState(creepName: string): CreepAssignmentStateSnapshot | undefined {
  const store = runtimeGlobal.__creepAssignmentState;
  if (!store) return undefined;
  const existing = ownDataValue(store, creepName);
  if (!existing.found) return undefined;
  return snapshotCreepAssignmentState(existing.value as CreepAssignmentState);
}

/** Returns an isolated assignment-store snapshot without creating the private heap store. */
export function peekCreepAssignmentStates(): CreepAssignmentStateStoreSnapshot {
  const store = runtimeGlobal.__creepAssignmentState;
  if (!store) {
    return {};
  }

  return cloneAssignmentSnapshotValue(store) as CreepAssignmentStateStoreSnapshot;
}

export function clearCreepAssignmentState(creepName: string): void {
  const store = runtimeGlobal.__creepAssignmentState;
  if (!store || !Object.prototype.hasOwnProperty.call(store, creepName)) return;
  delete store[creepName];
}

export function pruneDeadCreepAssignmentState(): number {
  const store = runtimeGlobal.__creepAssignmentState;
  if (!store) {
    return 0;
  }

  let removed = 0;
  for (const creepName of Object.keys(store)) {
    const liveCreep = ownDataValue(Game.creeps, creepName);
    if (liveCreep.found && liveCreep.value) {
      continue;
    }

    delete store[creepName];
    removed += 1;
  }

  if (Object.keys(store).length === 0) {
    delete runtimeGlobal.__creepAssignmentState;
  }

  return removed;
}

export function clearCreepAssignmentStateForTest(): void {
  delete runtimeGlobal.__creepAssignmentState;
}
