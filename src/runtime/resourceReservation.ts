import { bumpTreasuryCommitmentRevision } from "@/runtime/treasury/commitmentRevision";
import {
  classifyTreasuryHolderIdAsOwner,
  isValidTreasuryOwnerIdentity,
  treasuryOwnerIdentityKey,
  type TreasuryOwnerIdentity,
} from "@/runtime/treasury/ownerIdentity";

const DEFAULT_TTL = 200;

/**
 * production reservation 权威 store（Memory.runtime.resourceReservations）。
 *
 * 第五轮起 entry 携带持久 typed owner identity（owner 字段，附加于既有平铺
 * 字段之上——holderId 保留为兼容读口径，store key `${room}:${resource}:
 * ${holderId}` 不变，marketSaleProtectionAdapter 的 stableKey 兼容）。
 * 新写入口一律使用 *ForOwner 系列 typed mutation；旧字符串入口保留为
 * deprecated 兼容 adapter（自动分类为 legacy-unresolved 或已知 typed kind，
 * 不再生成含义不明的新记录）。
 */
interface ReservationEntry {
  roomName: string;
  resource: ResourceConstant;
  holderId: string;
  amount: number;
  updatedAt: number;
  expiresAt: number;
  /** 持久化形状（kind 为 string）；读取处经 isValidTreasuryOwnerIdentity 校验收窄。 */
  owner?: { kind: string; id: string; roomName?: string; namespace?: string; lifecycleRef?: string };
}

/** 持久 owner 字段 → typed identity（非法形状返回 undefined，调用方回退分类）。 */
function coercePersistedOwner(raw: unknown): TreasuryOwnerIdentity | undefined {
  return isValidTreasuryOwnerIdentity(raw) ? raw : undefined;
}

/** reservation entry 的有效 typed owner：持久字段合法则用之，否则按 holderId 分类。 */
export function getReservationEntryOwner(holderId: string, persistedOwner: unknown): TreasuryOwnerIdentity {
  return coercePersistedOwner(persistedOwner) ?? classifyTreasuryHolderIdAsOwner(holderId);
}

type ReservationStore = Record<string, ReservationEntry>;

/** typed owner store 版本标记（迁移完成后置 2；损坏时不乐观忽略）。 */
const RESERVATION_OWNER_VERSION = 2;

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

function ownerKeyString(owner: TreasuryOwnerIdentity): string {
  // owner.id 即既有 holderId 口径（store key 与既有数据完全兼容）。
  return owner.id;
}

export function reserveProductionResourceForOwner(
  roomName: string,
  resource: ResourceConstant,
  amount: number,
  owner: TreasuryOwnerIdentity,
  ttl: number = DEFAULT_TTL,
): void {
  if (amount <= 0) return;
  if (!isValidTreasuryOwnerIdentity(owner)) return; // 非法 owner 不落库（fail closed）
  const store = ensureStore();
  const key = makeKey(roomName, resource, ownerKeyString(owner));
  store[key] = {
    roomName,
    resource,
    holderId: ownerKeyString(owner),
    amount,
    updatedAt: Game.time,
    expiresAt: Game.time + ttl,
    owner,
  };
  bumpTreasuryCommitmentRevision();
}

export function releaseProductionReservationForOwner(
  roomName: string,
  resource: ResourceConstant,
  owner: TreasuryOwnerIdentity,
): void {
  if (!Memory.runtime?.resourceReservations) return;
  const key = makeKey(roomName, resource, ownerKeyString(owner));
  delete Memory.runtime.resourceReservations[key];
  bumpTreasuryCommitmentRevision();
}

export function renewProductionReservationForOwner(
  roomName: string,
  resource: ResourceConstant,
  amount: number,
  owner: TreasuryOwnerIdentity,
  ttl: number = DEFAULT_TTL,
): void {
  if (!isValidTreasuryOwnerIdentity(owner)) return;
  const store = ensureStore();
  const key = makeKey(roomName, resource, ownerKeyString(owner));
  const existing = store[key];
  if (!existing) return;
  store[key] = {
    roomName,
    resource,
    holderId: ownerKeyString(owner),
    amount,
    updatedAt: Game.time,
    expiresAt: Game.time + ttl,
    owner,
  };
  bumpTreasuryCommitmentRevision();
}

/**
 * @deprecated 兼容 adapter：裸 holderId 字符串入口。自动分类为 typed owner
 * （已知 namespace/object id/task/contract 形状或 legacy-unresolved）——不再
 * 生成含义不明的新记录；新代码必须使用 reserveProductionResourceForOwner。
 */
export function reserveProductionResource(
  roomName: string,
  resource: ResourceConstant,
  amount: number,
  holderId: string,
  ttl: number = DEFAULT_TTL,
): void {
  reserveProductionResourceForOwner(roomName, resource, amount, classifyTreasuryHolderIdAsOwner(holderId), ttl);
  bumpTreasuryCommitmentRevision();
}

/** @deprecated 兼容 adapter：见 reserveProductionResource。 */
export function releaseProductionReservation(
  roomName: string,
  resource: ResourceConstant,
  holderId: string,
): void {
  releaseProductionReservationForOwner(roomName, resource, classifyTreasuryHolderIdAsOwner(holderId));
  bumpTreasuryCommitmentRevision();
}

/** @deprecated 兼容 adapter：见 reserveProductionResource。 */
export function renewProductionReservation(
  roomName: string,
  resource: ResourceConstant,
  amount: number,
  holderId: string,
  ttl: number = DEFAULT_TTL,
): void {
  renewProductionReservationForOwner(roomName, resource, amount, classifyTreasuryHolderIdAsOwner(holderId), ttl);
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

/**
 * @deprecated 兼容读取（裸字符串排除）：仅按 holderId 字符串排除——同字符串
 * 不同 kind 的隔离语义见 getReservedProductionAmountExcludingOwner。
 */
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

/** typed owner 排除读取：同 kind + 同 id + 同 namespace 才排除（完整身份比较）。 */
export function getReservedProductionAmountExcludingOwner(
  roomName: string,
  resource: ResourceConstant,
  excludeOwner: TreasuryOwnerIdentity,
): number {
  const store = Memory.runtime?.resourceReservations;
  if (!store) return 0;
  const excludeKey = treasuryOwnerIdentityKey(excludeOwner);
  let total = 0;
  for (const entry of Object.values(store)) {
    if (!isActive(entry)) continue;
    if (entry.roomName !== roomName || entry.resource !== resource) continue;
    const owner = coercePersistedOwner(entry.owner) ?? classifyTreasuryHolderIdAsOwner(entry.holderId);
    if (treasuryOwnerIdentityKey(owner) === excludeKey) continue;
    total += entry.amount;
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

export interface ReservationOwnerMigrationReport {
  /** 本次从裸 holderId 分类并写入 owner 字段的条数。 */
  migrated: number;
  /** 已携带合法 owner、无需迁移的条数。 */
  alreadyTyped: number;
  /** 发现损坏（holderId 非字符串/owner 非法形状）——保持原样、不乐观忽略。 */
  damaged: number;
  /** 迁移执行时记录的版本标记（幂等短路后为当前标记值）。 */
  version: number;
}

/**
 * 版本化迁移：为存量裸 holderId 条目补写 typed owner（room/resource/
 * amount/expiresAt 一概不动，store key 不变）；完成后写入版本标记
 * resourceReservationsOwnerVersion=2 并 bump commitment revision（迁移后
 * 索引不得继续按旧口径聚合）。损坏条目保持原样并计入 damaged——绝不乐观
 * 忽略或猜测分类。
 */
export function migrateResourceReservationsForTypedOwner(): ReservationOwnerMigrationReport {
  const runtime = Memory.runtime;
  if (runtime?.resourceReservationsOwnerVersion === RESERVATION_OWNER_VERSION) {
    return { migrated: 0, alreadyTyped: 0, damaged: 0, version: RESERVATION_OWNER_VERSION };
  }
  const store = runtime?.resourceReservations ?? {};
  let migrated = 0;
  let alreadyTyped = 0;
  let damaged = 0;
  for (const entry of Object.values(store)) {
    if (isValidTreasuryOwnerIdentity(entry?.owner)) {
      alreadyTyped += 1;
      continue;
    }
    if (typeof entry?.holderId !== "string" || entry.holderId.length === 0) {
      damaged += 1; // 无法识别身份来源：原样保留，等待权威 owner/GC/人工修复
      continue;
    }
    entry.owner = classifyTreasuryHolderIdAsOwner(entry.holderId);
    migrated += 1;
  }
  if (!Memory.runtime) Memory.runtime = {};
  Memory.runtime.resourceReservationsOwnerVersion = RESERVATION_OWNER_VERSION;
  if (migrated > 0) bumpTreasuryCommitmentRevision();
  return { migrated, alreadyTyped, damaged, version: RESERVATION_OWNER_VERSION };
}
