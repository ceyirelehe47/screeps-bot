import { bumpTreasuryCommitmentRevision } from "@/runtime/treasury/commitmentRevision";
import {
  classifyTreasuryHolderIdAsOwner,
  isValidTreasuryOwnerIdentity,
  treasuryOwnerIdentityKey,
  treasuryReservationOwnerToken,
  type TreasuryOwnerIdentity,
} from "@/runtime/treasury/ownerIdentity";

const DEFAULT_TTL = 200;

/**
 * production reservation 权威 store（Memory.runtime.resourceReservations）。
 *
 * 第六轮起 store key 编码完整 typed owner identity：
 * `${room}:${resource}:${ownerToken}`（ownerToken = kind 前缀 +
 * logical-service namespace 段 + id，见 ownerIdentity.treasuryReservationOwnerToken）
 * ——同 id 不同 kind / 不同 namespace 的 owner 在持久层彻底分离，不再互相
 * 覆盖；entry 平铺字段（roomName/resource/holderId/amount/updatedAt/
 * expiresAt）与 owner 字段保持不变（读侧按 value 聚合的消费者零改动；
 * marketSaleProtectionAdapter 的 stableKey 直接内嵌 store key 字符串，无
 * key 解析依赖）。新写入口一律使用 *ForOwner 系列 typed mutation；旧字符串
 * 入口保留为 deprecated 兼容 adapter。持久 key 的拼接唯一权威在本文件
 * （makeReservationStoreKey）——外部模块不得自行拼接。
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

/**
 * typed owner store 版本标记：
 * - 1/undefined：裸 holderId 旧格式（key 不含 kind 编码、entry 无 owner）；
 * - 2：owner 字段已补写（第五轮），key 仍为 `${room}:${res}:${holderId}`；
 * - 3：key 已重编码完整 ownerToken（第六轮，当前版本）。
 * 版本低于 3 且 store 非空时授权侧 fail closed（见 facade authorizationSafe
 * 的 migration 条件），直至 migrateResourceReservationsForTypedOwner 成功推进。
 */
const RESERVATION_OWNER_VERSION = 3;

function ensureStore(): ReservationStore {
  if (!Memory.runtime) {
    Memory.runtime = {};
  }
  if (!Memory.runtime.resourceReservations) {
    Memory.runtime.resourceReservations = {};
  }
  return Memory.runtime.resourceReservations;
}

/**
 * 持久 key 的唯一拼接权威：编码完整 typed identity（room + resource +
 * ownerToken）。外部模块不得自行拼接 reservation store key。
 */
export function makeReservationStoreKey(
  roomName: string,
  resource: ResourceConstant,
  owner: TreasuryOwnerIdentity,
): string {
  return `${roomName}:${resource}:${treasuryReservationOwnerToken(owner)}`;
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
  const key = makeReservationStoreKey(roomName, resource, owner);
  store[key] = {
    roomName,
    resource,
    holderId: owner.id,
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
  const key = makeReservationStoreKey(roomName, resource, owner);
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
  const key = makeReservationStoreKey(roomName, resource, owner);
  const existing = store[key];
  if (!existing) return;
  store[key] = {
    roomName,
    resource,
    holderId: owner.id,
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
  /** 迁移执行状态：ok=本次成功推进到当前版本；already-migrated=版本已是当前值。 */
  status: "ok" | "already-migrated";
  /** 本次重编码 store key 并补写 owner 字段的条数。 */
  migrated: number;
  /** 已是 v3 形状（key 含 ownerToken 且 owner 字段合法）无需变更的条数。 */
  alreadyTyped: number;
  /** 发现损坏（malformed entry / legacy key 与平铺字段不一致 / 新 key 碰撞）——
   * 整个迁移终止：原数据保持不动、版本不推进、授权侧 fail closed。 */
  failure: string | null;
  /** 迁移执行后记录的版本标记（失败时保持原值）。 */
  version: number;
}

/**
 * 版本化原子迁移（第六轮 v3）：裸/半 typed reservation store → key 编码完整
 * typed owner identity。两阶段执行：
 * 1. 临时结构完成全部验证——entry 形状完整（roomName/resource/holderId/
 *    amount/updatedAt/expiresAt）、legacy key 与平铺字段严格一致
 *    （`${roomName}:${resource}:${holderId}`）、owner 字段合法或可由
 *    holderId 无损分类、新 key 无碰撞。任何 malformed/collision 立即终止，
 *    原 store 不动（零部分写入）；
 * 2. 全部通过后一次性引用切换替换 store、写 resourceReservationsOwnerVersion=3
 *    并 bump commitment revision（迁移后索引不得继续按旧 key 口径聚合）。
 * 幂等：版本已是 3 直接短路；失败后修复数据可重复执行。数值字段
 * （amount/updatedAt/expiresAt）一律不改写。
 */
export function migrateResourceReservationsForTypedOwner(): ReservationOwnerMigrationReport {
  const runtime = Memory.runtime;
  const currentVersion = runtime?.resourceReservationsOwnerVersion ?? (runtime?.resourceReservations ? 1 : RESERVATION_OWNER_VERSION);
  if (currentVersion === RESERVATION_OWNER_VERSION) {
    return { status: "already-migrated", migrated: 0, alreadyTyped: 0, failure: null, version: RESERVATION_OWNER_VERSION };
  }
  if (currentVersion !== 1 && currentVersion !== 2) {
    return {
      status: "ok",
      migrated: 0,
      alreadyTyped: 0,
      failure: `未知 resourceReservationsOwnerVersion ${String(currentVersion)}（支持 1/2 → ${String(RESERVATION_OWNER_VERSION)}；原数据保留，授权 fail closed）`,
      version: currentVersion,
    };
  }
  const store = runtime?.resourceReservations ?? {};
  if (!store || typeof store !== "object") {
    return {
      status: "ok",
      migrated: 0,
      alreadyTyped: 0,
      failure: "resourceReservations store 非对象（原数据保留，授权 fail closed）",
      version: currentVersion,
    };
  }

  // ── 阶段 1：临时结构全量验证（零写入） ───────────────────────────────────
  const entries = Object.entries(store);
  const rebuilt: ReservationStore = {};
  let migrated = 0;
  let alreadyTyped = 0;
  for (const [legacyKey, rawEntry] of entries) {
    const entry = rawEntry as ReservationEntry | null | undefined;
    if (!entry || typeof entry !== "object") {
      return {
        status: "ok",
        migrated: 0,
        alreadyTyped: 0,
        failure: `迁移发现非对象 entry（key ${legacyKey.slice(0, 64)}；原 store 保持不变）`,
        version: currentVersion,
      };
    }
    if (
      typeof entry.roomName !== "string" || entry.roomName.length === 0 ||
      typeof entry.resource !== "string" || entry.resource.length === 0 ||
      typeof entry.holderId !== "string" || entry.holderId.length === 0 ||
      typeof entry.amount !== "number" || !Number.isSafeInteger(entry.amount) || entry.amount < 0 ||
      typeof entry.updatedAt !== "number" || !Number.isSafeInteger(entry.updatedAt) || entry.updatedAt < 0 ||
      typeof entry.expiresAt !== "number" || !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt < 0
    ) {
      return {
        status: "ok",
        migrated: 0,
        alreadyTyped: 0,
        failure: `迁移发现 malformed entry（key ${legacyKey.slice(0, 64)}；原 store 保持不变）`,
        version: currentVersion,
      };
    }
    // owner 字段：合法则用之（v2 已补写）；非法形状不乐观忽略——终止迁移。
    let owner: TreasuryOwnerIdentity | undefined = coercePersistedOwner(entry.owner);
    if (entry.owner !== undefined && owner === undefined) {
      return {
        status: "ok",
        migrated: 0,
        alreadyTyped: 0,
        failure: `迁移发现非法 owner 字段（key ${legacyKey.slice(0, 64)}；原 store 保持不变）`,
        version: currentVersion,
      };
    }
    if (owner === undefined) {
      owner = classifyTreasuryHolderIdAsOwner(entry.holderId);
    }
    const newKey = makeReservationStoreKey(entry.roomName, entry.resource as ResourceConstant, owner);
    if (Object.prototype.hasOwnProperty.call(rebuilt, newKey)) {
      return {
        status: "ok",
        migrated: 0,
        alreadyTyped: 0,
        failure: `迁移发现新 key 碰撞（${newKey.slice(0, 96)}；原 store 保持不变）`,
        version: currentVersion,
      };
    }
    // legacy key 一致性：key 必须与其 entry 平铺字段一致（本迁移只用 value 字段
    // 重建，不一致说明数据已被外部篡改/损坏——不得猜测重排。
    if (legacyKey !== `${entry.roomName}:${entry.resource}:${entry.holderId}`) {
      return {
        status: "ok",
        migrated: 0,
        alreadyTyped: 0,
        failure: `迁移发现 store key 与 entry 平铺字段不一致（key ${legacyKey.slice(0, 64)}；原 store 保持不变）`,
        version: currentVersion,
      };
    }
    rebuilt[newKey] = { ...entry, holderId: owner.id, owner };
    if (newKey === legacyKey && coercePersistedOwner(entry.owner) !== undefined) {
      alreadyTyped += 1;
    } else {
      migrated += 1;
    }
  }

  // ── 阶段 2：原子替换（引用切换）+ 版本推进 + revision bump ────────────────
  if (!Memory.runtime) Memory.runtime = {};
  Memory.runtime.resourceReservations = rebuilt;
  Memory.runtime.resourceReservationsOwnerVersion = RESERVATION_OWNER_VERSION;
  if (entries.length > 0) bumpTreasuryCommitmentRevision();
  return { status: "ok", migrated, alreadyTyped, failure: null, version: RESERVATION_OWNER_VERSION };
}

/** 迁移健康检查（authorizationSafe 的 migration 条件；只读零写）。 */
export function isReservationOwnerMigrationComplete(): boolean {
  const runtime = Memory.runtime;
  const store = runtime?.resourceReservations;
  if (!store || Object.keys(store).length === 0) return true; // 无可迁移数据
  return runtime?.resourceReservationsOwnerVersion === RESERVATION_OWNER_VERSION;
}

/**
 * reservation store 损坏标志（第七轮）：GC/验证发现 malformed entry 时置
 * 位（entry 原样保留）——存在期间一切 mutation 拒绝、授权 fail closed，
 * 只有显式 repair 可清除。只读零写。
 */
export function isReservationStoreCorrupted(): boolean {
  return (Memory.runtime as { resourceReservationsCorrupted?: unknown } | undefined)?.resourceReservationsCorrupted !== undefined;
}
