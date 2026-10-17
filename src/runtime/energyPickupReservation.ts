import { resolveRoomEnergyPolicyForRoom } from "@/runtime/roomEnergyPolicy";
import {
  ensureCreepAssignmentState,
  getCreepAssignmentState,
} from "@/runtime/creepAssignmentState";

const RESERVATION_TTL = 12;
export const TERMINAL_ENERGY_PICKUP_RESERVE = 25_000;

type PickupTargetKind = "resource" | "structure";
type PickupTarget = Resource | AnyStoreStructure | Tombstone | Ruin;

export interface PickupAvailabilityOptions {
  terminalEnergyReserve?: number;
}

interface PickupReservationClaim {
  amount: number;
  until: number;
}

interface PickupTargetReservation {
  kind: PickupTargetKind;
  claims: Record<string, PickupReservationClaim>;
}

type PickupReservationStore = Record<string, Record<string, PickupTargetReservation>>;

type RuntimeGlobalWithPickupReservations = typeof global & {
  __pickupReservations?: PickupReservationStore;
};

const runtimeGlobal: RuntimeGlobalWithPickupReservations = global;

function getTargetKind(target: PickupTarget): PickupTargetKind {
  return (target as Resource).amount !== undefined ? "resource" : "structure";
}

function ensurePickupReservationStore(): PickupReservationStore {
  if (!runtimeGlobal.__pickupReservations) {
    runtimeGlobal.__pickupReservations = {};
  }

  return runtimeGlobal.__pickupReservations;
}

function getTerminalEnergyReserve(options?: PickupAvailabilityOptions, roomName?: string): number {
  const configured = options?.terminalEnergyReserve;
  if (configured === undefined || !Number.isFinite(configured)) {
    return roomName ? resolveRoomEnergyPolicyForRoom(roomName).terminalEnergyReserve : TERMINAL_ENERGY_PICKUP_RESERVE;
  }
  return Math.max(0, Math.floor(configured));
}

export function getPickupTargetEnergyAmount(
  target: PickupTarget,
  options?: PickupAvailabilityOptions,
): number {
  if ((target as Resource).amount !== undefined) {
    return (target as Resource).amount;
  }

  if ("store" in target) {
    const amount = target.store.getUsedCapacity(RESOURCE_ENERGY);
    if ((target as Structure).structureType === STRUCTURE_TERMINAL) {
      return Math.max(0, amount - getTerminalEnergyReserve(options, (target as StructureTerminal).room?.name));
    }
    return amount;
  }

  return 0;
}

function ensureRoomReservationStore(roomName: string): Record<string, PickupTargetReservation> {
  const store = ensurePickupReservationStore();
  if (!store[roomName]) {
    store[roomName] = {};
  }

  return store[roomName];
}

function cleanupClaims(entry: PickupTargetReservation): void {
  for (const [creepName, claim] of Object.entries(entry.claims)) {
    if (claim.until < Game.time || !Game.creeps[creepName]) {
      delete entry.claims[creepName];
    }
  }
}

function ensureReservationEntry(
  roomName: string,
  targetId: string,
  kind: PickupTargetKind,
): PickupTargetReservation {
  const store = ensureRoomReservationStore(roomName);
  let entry = store[targetId];
  if (!entry || entry.kind !== kind) {
    entry = {
      kind,
      claims: {},
    };
    store[targetId] = entry;
  }
  cleanupClaims(entry);
  return entry;
}

function clearTargetEntryIfEmpty(roomName: string, targetId: string): void {
  const roomStore = runtimeGlobal.__pickupReservations?.[roomName];
  if (!roomStore) {
    return;
  }

  const entry = roomStore[targetId];
  if (!entry) {
    return;
  }

  if (Object.keys(entry.claims).length === 0) {
    delete roomStore[targetId];
  }

  if (Object.keys(roomStore).length === 0) {
    delete runtimeGlobal.__pickupReservations?.[roomName];
  }
}

export function clearPickupReservationTargetMemory(creep: Creep): void {
  const assignmentState = ensureCreepAssignmentState(creep.name);
  delete assignmentState.energyPickupTargetId;
  delete assignmentState.energyPickupTargetKind;
  delete assignmentState.energyPickupRoomName;
}

export function releasePickupReservation(creep: Creep, targetId?: string): void {
  const assignmentState = ensureCreepAssignmentState(creep.name);
  const roomName = assignmentState.energyPickupRoomName || creep.room.name;
  const roomStore = runtimeGlobal.__pickupReservations?.[roomName];
  if (roomStore) {
    if (targetId) {
      const entry = roomStore[targetId];
      if (entry?.claims[creep.name]) {
        delete entry.claims[creep.name];
        clearTargetEntryIfEmpty(roomName, targetId);
      }
    } else {
      for (const [id, entry] of Object.entries(roomStore)) {
        if (entry.claims[creep.name]) {
          delete entry.claims[creep.name];
          clearTargetEntryIfEmpty(roomName, id);
        }
      }
    }
  }

  clearPickupReservationTargetMemory(creep);
}

function setReservedTargetMemory(creep: Creep, target: PickupTarget): void {
  const assignmentState = ensureCreepAssignmentState(creep.name);
  assignmentState.energyPickupTargetId = target.id;
  assignmentState.energyPickupTargetKind = getTargetKind(target);
  assignmentState.energyPickupRoomName = target.pos.roomName;
}

export function reservePickupTarget(
  creep: Creep,
  target: PickupTarget,
  desiredAmount: number,
  options?: PickupAvailabilityOptions,
): boolean {
  const available = getPickupTargetEnergyAmount(target, options);
  if (available <= 0) {
    return false;
  }

  const targetKind = getTargetKind(target);
  const entry = ensureReservationEntry(target.pos.roomName, target.id, targetKind);

  let reservedByOthers = 0;
  for (const [creepName, claim] of Object.entries(entry.claims)) {
    if (creepName !== creep.name) {
      reservedByOthers += claim.amount;
    }
  }

  const availableForThisCreep = Math.max(0, available - reservedByOthers);
  const wanted = Math.max(0, desiredAmount);
  if (wanted <= 0) {
    return false;
  }

  if (availableForThisCreep <= 0) {
    return false;
  }

  const claimAmount = Math.min(availableForThisCreep, wanted);

  entry.claims[creep.name] = {
    amount: claimAmount,
    until: Game.time + RESERVATION_TTL,
  };
  setReservedTargetMemory(creep, target);
  return true;
}

/**
 * 返回本 creep 当前 pickup reservation 实际持有的数量。
 *
 * 本函数不会创建或放大 claim；读取前会清理过期/死亡 creep claim，供执行层
 * 将最终 intent 严格限制在 reservePickupTarget() 已授予的数量内。
 */
export function getPickupReservationClaimAmount(
  creep: Creep,
  targetId?: string,
): number {
  const assignmentState = getCreepAssignmentState(creep.name);
  const reservedTargetId = assignmentState?.energyPickupTargetId;
  const requestedTargetId = targetId || reservedTargetId;
  if (
    !requestedTargetId ||
    !reservedTargetId ||
    requestedTargetId !== reservedTargetId
  ) {
    return 0;
  }

  const roomName = assignmentState.energyPickupRoomName || creep.room.name;
  const entry = runtimeGlobal.__pickupReservations?.[roomName]?.[requestedTargetId];
  if (!entry) {
    return 0;
  }

  cleanupClaims(entry);
  const claim = entry.claims[creep.name];
  if (!claim) {
    clearTargetEntryIfEmpty(roomName, requestedTargetId);
    return 0;
  }

  return Number.isSafeInteger(claim.amount) && claim.amount > 0
    ? claim.amount
    : 0;
}

export function getReservedPickupTarget(
  creep: Creep,
  options?: PickupAvailabilityOptions,
): PickupTarget | null {
  const assignmentState = ensureCreepAssignmentState(creep.name);
  const targetId = assignmentState.energyPickupTargetId;
  const targetKind = assignmentState.energyPickupTargetKind;
  if (!targetId || !targetKind) {
    return null;
  }

  let target: PickupTarget | null = null;
  if (targetKind === "resource") {
    target = Game.getObjectById(targetId as Id<Resource>);
  } else {
    target = Game.getObjectById(targetId as Id<AnyStoreStructure | Tombstone | Ruin>);
  }

  if (!target || getPickupTargetEnergyAmount(target, options) <= 0) {
    releasePickupReservation(creep, targetId);
    return null;
  }

  return target;
}

export function cleanupPickupReservationStore(ownedRooms: Set<string>): number {
  const store = runtimeGlobal.__pickupReservations;
  if (!store) {
    return 0;
  }

  let removed = 0;
  for (const [roomName, reservations] of Object.entries(store)) {
    const roomLost = !ownedRooms.has(roomName);
    for (const [targetId, reservation] of Object.entries(reservations)) {
      if (roomLost) {
        delete reservations[targetId];
        removed += 1;
        continue;
      }

      cleanupClaims(reservation);
      if (Object.keys(reservation.claims).length === 0) {
        delete reservations[targetId];
        removed += 1;
      }
    }

    if (Object.keys(reservations).length === 0) {
      delete store[roomName];
    }
  }

  if (Object.keys(store).length === 0) {
    delete runtimeGlobal.__pickupReservations;
  }

  return removed;
}

export function clearPickupReservationStoreForTest(): void {
  delete runtimeGlobal.__pickupReservations;
}

export function getPickupReservationsByRoom(roomName: string): Record<string, PickupTargetReservation> {
  return ensureRoomReservationStore(roomName);
}
