import { bumpTreasuryCommitmentRevision } from "@/runtime/treasury/commitmentRevision";

const DEFAULT_TTL = 200;

interface ReservationEntry {
  roomName: string;
  resource: ResourceConstant;
  holderId: string;
  amount: number;
  updatedAt: number;
  expiresAt: number;
}

type ReservationStore = Record<string, ReservationEntry>;

function ensureStore(): ReservationStore {
  if (!Memory.runtime) {
    Memory.runtime = {};
  }
  if (!Memory.runtime.resourceReservations) {
    Memory.runtime.resourceReservations = {};
  }
  return Memory.runtime.resourceReservations;
}

function makeKey(roomName: string, resource: ResourceConstant, holderId: string): string {
  return `${roomName}:${resource}:${holderId}`;
}

export function reserveProductionResource(
  roomName: string,
  resource: ResourceConstant,
  amount: number,
  holderId: string,
  ttl: number = DEFAULT_TTL,
): void {
  if (amount <= 0) return;
  const store = ensureStore();
  const key = makeKey(roomName, resource, holderId);
  store[key] = {
    roomName,
    resource,
    holderId,
    amount,
    updatedAt: Game.time,
    expiresAt: Game.time + ttl,
  };
  bumpTreasuryCommitmentRevision();
}

export function releaseProductionReservation(
  roomName: string,
  resource: ResourceConstant,
  holderId: string,
): void {
  if (!Memory.runtime?.resourceReservations) return;
  const key = makeKey(roomName, resource, holderId);
  delete Memory.runtime.resourceReservations[key];
  bumpTreasuryCommitmentRevision();
}

export function renewProductionReservation(
  roomName: string,
  resource: ResourceConstant,
  amount: number,
  holderId: string,
  ttl: number = DEFAULT_TTL,
): void {
  const store = ensureStore();
  const key = makeKey(roomName, resource, holderId);
  const existing = store[key];
  if (!existing) return;
  store[key] = {
    roomName,
    resource,
    holderId,
    amount,
    updatedAt: Game.time,
    expiresAt: Game.time + ttl,
  };
  bumpTreasuryCommitmentRevision();
}

function isActive(entry: ReservationEntry): boolean {
  return entry.expiresAt >= Game.time;
}

export function getReservedProductionAmount(roomName: string, resource: ResourceConstant): number {
  const store = Memory.runtime?.resourceReservations;
  if (!store) return 0;
  let total = 0;
  for (const entry of Object.values(store)) {
    if (entry.roomName === roomName && entry.resource === resource && isActive(entry)) {
      total += entry.amount;
    }
  }
  return total;
}

export function getReservedProductionAmountExcludingHolder(
  roomName: string,
  resource: ResourceConstant,
  excludeHolderId: string,
): number {
  const store = Memory.runtime?.resourceReservations;
  if (!store) return 0;
  let total = 0;
  for (const entry of Object.values(store)) {
    if (
      entry.roomName === roomName &&
      entry.resource === resource &&
      entry.holderId !== excludeHolderId &&
      isActive(entry)
    ) {
      total += entry.amount;
    }
  }
  return total;
}

export function gcProductionReservations(): void {
  if (!Memory.runtime?.resourceReservations) return;
  const store = Memory.runtime.resourceReservations;
  let removed = 0;
  for (const [key, entry] of Object.entries(store)) {
    if (entry.expiresAt < Game.time) {
      delete store[key];
      removed += 1;
    }
  }
  if (removed > 0) bumpTreasuryCommitmentRevision();
}

export function listProductionReservations(): ReservationEntry[] {
  const store = Memory.runtime?.resourceReservations;
  if (!store) return [];
  return Object.values(store);
}
