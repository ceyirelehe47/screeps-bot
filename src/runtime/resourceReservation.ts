import { bumpTreasuryCommitmentRevision } from "@/runtime/treasury/commitmentRevision";
import {
  classifyTreasuryHolderIdAsOwner,
  isValidTreasuryOwnerIdentity,
  treasuryOwnerIdentityKey,
  treasuryReservationOwnerToken,
  treasuryReservationOwnerTokenV3,
  type TreasuryOwnerIdentity,
} from "@/runtime/treasury/ownerIdentity";

const DEFAULT_TTL = 200;

/**
 * production reservation 权威 store（Memory.runtime.resourceReservations）。
 *
 * 第七轮 schema v4：store key 编码 canonical owner token（长度前缀
 * `ow2:<kindCode>:<nsLen>:<namespace><id>`，见 ownerIdentity.
 * treasuryReservationOwnerToken）——字段边界无歧义（冒号/Unicode/空格/空串
 * 均不碰撞），同 id 不同 kind/namespace 的 owner 持久层彻底分离。entry 平铺
 * 字段（roomName/resource/holderId/amount/updatedAt/expiresAt）与 owner
 * 字段保持不变（读侧按 value 聚合的消费者零改动）。
 *
 * schema activation gate（第七轮）：一切 mutation（typed 与 deprecated
 * adapter）之前必须完成 schema 激活——空 store 原子初始化当前版本；legacy
 * store（v1/v2/v3）先迁移成功才允许 mutation；失败返回结构化拒绝（零写入）
 * 且授权侧 fail closed（facade 的 migration blocker）。挂载点：facade.
 * beginTick（bootstrap，先于全部 planner/reservation writer）+ 每个 mutation
 * 入口自检（双保险）；memoryCleanup 的 17 tick 迁移保留为幂等兜底而非唯一
 * 路径。绝不出现混合版本 store（legacy key 与新 key 并存）。
 *
 * mutation 权威（第七轮）：reserve/renew/release 返回结构化结果并全验证
 * （roomName 形状 / resource ∈ RESOURCES_ALL / amount 正安全整数 / ttl 正
 * 安全整数 / Game.time+ttl 不溢出 / owner kind-specific / schema gate ready /
 * store 健康）；非法输入与 migration 失败零写入；实际 mutation 成功才 bump
 * commitment revision 且每次只 bump 一次（deprecated adapter 不二次 bump；
 * no-op release/renew 不 bump）。listProductionReservations 返回冻结深拷贝
 * 快照。持久 key 的拼接唯一权威在本文件（makeReservationStoreKey）——外部
 * 模块不得自行拼接。
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

/** 持久 typed owner → typed identity（非法形状返回 undefined，调用方回退分类）。 */
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
 * - 3：key 已重编码 ownerToken v3（第六轮，kind 前缀 + namespace 段 + id）；
 * - 4：key 重编码 canonical owner token v4（第七轮，长度前缀，当前版本）。
 * 版本低于 4 且 store 非空时授权侧 fail closed（见 facade authorizationSafe
 * 的 migration 条件），直至 ensureReservationSchemaActivated 成功推进。
 */
const RESERVATION_OWNER_VERSION = 4;

/** mutation/gate 验证用的资源 catalog（RESOURCES_ALL 全集）。 */
const VALID_RESOURCES: ReadonlySet<string> = new Set<string>(RESOURCES_ALL);
/** Screeps 房间名形状（W/E + 1..3 位 + N/S + 1..3 位，如 W1N57 / E127S0）。 */
const ROOM_NAME_PATTERN = /^[WE]\d{1,3}[NS]\d{1,3}$/;

/** 确定性计数器（heap，global reset 归零；facade metrics 聚合）。 */
const reservationEvents = {
  schemaActivationFailures: 0,
  mutationRejections: 0,
};

export interface TreasuryReservationMutationCounters {
  readonly schemaActivationFailures: number;
  readonly mutationRejections: number;
}

export function readReservationMutationCounters(): TreasuryReservationMutationCounters {
  return { ...reservationEvents };
}

/** 仅供测试：清零（clearTreasuryPersistenceForTest 之外的低层清理）。 */
export function resetReservationMutationCountersForTest(): void {
  reservationEvents.schemaActivationFailures = 0;
  reservationEvents.mutationRejections = 0;
}

/** 结构化 mutation 结果：ok（含是否实际变更）或结构化拒绝（零写入）。 */
export type ReservationMutationResult =
  | { readonly status: "ok"; readonly mutated: boolean }
  | {
      readonly status: "rejected";
      readonly reason:
        | "invalid_room"
        | "invalid_resource"
        | "invalid_amount"
        | "invalid_ttl"
        | "expiry_overflow"
        | "invalid_owner"
        | "schema_not_ready"
        | "store_corrupted";
      readonly detail: string;
    };

function rejected(reason: Extract<ReservationMutationResult, { status: "rejected" }>["reason"], detail: string): ReservationMutationResult {
  reservationEvents.mutationRejections += 1;
  return { status: "rejected", reason, detail };
}

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
 * 持久 key 的唯一拼接权威：编码 canonical typed identity（room + resource +
 * ownerToken v4）。外部模块不得自行拼接 reservation store key。
 */
export function makeReservationStoreKey(
  roomName: string,
  resource: ResourceConstant,
  owner: TreasuryOwnerIdentity,
): string {
  return `${roomName}:${resource}:${treasuryReservationOwnerToken(owner)}`;
}

// ── schema activation gate（第七轮） ────────────────────────────────────────

export type ReservationSchemaGate =
  | { readonly status: "ready" }
  | {
      readonly status: "rejected";
      readonly reason: "migration_failed" | "unknown_version" | "store_corrupted";
      readonly detail: string;
    };

/**
 * schema activation gate：在任何 reservation mutation / commitment authorization
 * / 业务规划使用 reservation 之前调用。
 * - store 不存在或为空 → 原子初始化为当前版本（version=4）；
 * - version===4 → ready（O(1) 短路）；
 * - version 1/2/3 → 执行迁移：成功 ready / 失败 rejected（migration_failed，
 *   原数据不动、版本不推进）；
 * - version 非法（0、>4、非整数）→ rejected（unknown_version，fail closed）；
 * - 持久 corrupted 标志存在 → rejected（store_corrupted——GC 发现 malformed
 *   entry 后置位，显式 repair 才可清除）。
 */
export function ensureReservationSchemaActivated(): ReservationSchemaGate {
  const runtime = Memory.runtime as (NonNullable<typeof Memory.runtime> & { resourceReservationsCorrupted?: string }) | undefined;
  if (runtime?.resourceReservationsCorrupted !== undefined) {
    reservationEvents.schemaActivationFailures += 1;
    return { status: "rejected", reason: "store_corrupted", detail: runtime.resourceReservationsCorrupted };
  }
  const store = runtime?.resourceReservations;
  if (!store || Object.keys(store).length === 0) {
    // 空 store：原子初始化为当前版本（空对象 + version 标记）。
    ensureStore();
    if (!Memory.runtime) Memory.runtime = {};
    (Memory.runtime as NonNullable<typeof Memory.runtime>).resourceReservationsOwnerVersion = RESERVATION_OWNER_VERSION;
    return { status: "ready" };
  }
  // v1 语义 = version 字段缺失（undefined）且 store 非空——宽化为 number
  // 绕过声明类型的字面量收窄（declared 只声明 2|3|4，缺省即 v1）。
  const declared = (Memory.runtime as NonNullable<typeof Memory.runtime>).resourceReservationsOwnerVersion;
  const currentVersion = (declared ?? 1) as number;
  if (currentVersion === RESERVATION_OWNER_VERSION) return { status: "ready" };
  if (currentVersion === 1 || currentVersion === 2 || currentVersion === 3) {
    const migration = migrateResourceReservationsForTypedOwner();
    if (migration.failure !== null) {
      reservationEvents.schemaActivationFailures += 1;
      return { status: "rejected", reason: "migration_failed", detail: migration.failure };
    }
    return { status: "ready" };
  }
  reservationEvents.schemaActivationFailures += 1;
  return {
    status: "rejected",
    reason: "unknown_version",
    detail: `未知 resourceReservationsOwnerVersion ${String(currentVersion)}（支持 1/2/3 → ${String(RESERVATION_OWNER_VERSION)}；fail closed）`,
  };
}

// ── 结构化 mutation（第七轮：全验证 + gate + 单次 bump） ───────────────────

/** mutation 公共前置：schema gate + 输入全验证（非法零写入）。 */
function preflightMutation(
  roomName: string,
  resource: ResourceConstant,
  amountOrTtl: { amount?: number; ttl?: number },
  owner: TreasuryOwnerIdentity,
): ReservationMutationResult | { ready: true } {
  const gate = ensureReservationSchemaActivated();
  if (gate.status === "rejected") {
    reservationEvents.mutationRejections += 1;
    return { status: "rejected", reason: "schema_not_ready", detail: gate.detail };
  }
  if (typeof roomName !== "string" || !ROOM_NAME_PATTERN.test(roomName)) {
    return rejected("invalid_room", `roomName 非法: ${String(roomName).slice(0, 24)}`);
  }
  if (typeof resource !== "string" || !VALID_RESOURCES.has(resource)) {
    return rejected("invalid_resource", `resource 不在 RESOURCES_ALL: ${String(resource).slice(0, 24)}`);
  }
  if (amountOrTtl.amount !== undefined) {
    if (typeof amountOrTtl.amount !== "number" || !Number.isSafeInteger(amountOrTtl.amount) || amountOrTtl.amount <= 0) {
      return rejected("invalid_amount", `amount 须为正安全整数: ${String(amountOrTtl.amount)}`);
    }
  }
  if (amountOrTtl.ttl !== undefined) {
    if (typeof amountOrTtl.ttl !== "number" || !Number.isSafeInteger(amountOrTtl.ttl) || amountOrTtl.ttl <= 0) {
      return rejected("invalid_ttl", `ttl 须为正安全整数: ${String(amountOrTtl.ttl)}`);
    }
    if (!Number.isSafeInteger(Game.time + amountOrTtl.ttl)) {
      return rejected("expiry_overflow", `Game.time + ttl 溢出安全整数: ${String(Game.time)}+${String(amountOrTtl.ttl)}`);
    }
  }
  if (!isValidTreasuryOwnerIdentity(owner)) {
    return rejected("invalid_owner", "owner 非法（kind-specific：logical-service 的 namespace 必填、其他 kind 禁止）");
  }
  return { ready: true };
}

export function reserveProductionResourceForOwner(
  roomName: string,
  resource: ResourceConstant,
  amount: number,
  owner: TreasuryOwnerIdentity,
  ttl: number = DEFAULT_TTL,
): ReservationMutationResult {
  const preflight = preflightMutation(roomName, resource, { amount, ttl }, owner);
  if (!("ready" in preflight)) return preflight;
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
  bumpTreasuryCommitmentRevision(); // 实际 mutation：恰好一次
  return { status: "ok", mutated: true };
}

export function releaseProductionReservationForOwner(
  roomName: string,
  resource: ResourceConstant,
  owner: TreasuryOwnerIdentity,
): ReservationMutationResult {
  // release 不写 key，但同样经 schema gate（不得在混合 store 上操作）与
  // room/resource 形状验证；owner 非法同样拒绝（无法定位 key）。
  const preflight = preflightMutation(roomName, resource, {}, owner);
  if (!("ready" in preflight)) return preflight;
  if (!Memory.runtime?.resourceReservations) return { status: "ok", mutated: false };
  const key = makeReservationStoreKey(roomName, resource, owner);
  if (!Object.prototype.hasOwnProperty.call(Memory.runtime.resourceReservations, key)) {
    return { status: "ok", mutated: false }; // no-op：不重复 bump
  }
  delete Memory.runtime.resourceReservations[key];
  bumpTreasuryCommitmentRevision(); // 实际删除：恰好一次
  return { status: "ok", mutated: true };
}

export function renewProductionReservationForOwner(
  roomName: string,
  resource: ResourceConstant,
  amount: number,
  owner: TreasuryOwnerIdentity,
  ttl: number = DEFAULT_TTL,
): ReservationMutationResult {
  const preflight = preflightMutation(roomName, resource, { amount, ttl }, owner);
  if (!("ready" in preflight)) return preflight;
  const store = ensureStore();
  const key = makeReservationStoreKey(roomName, resource, owner);
  if (!Object.prototype.hasOwnProperty.call(store, key)) {
    return { status: "ok", mutated: false }; // 不存在时不创建（保留既有语义）
  }
  store[key] = {
    roomName,
    resource,
    holderId: owner.id,
    amount,
    updatedAt: Game.time,
    expiresAt: Game.time + ttl,
    owner,
  };
  bumpTreasuryCommitmentRevision(); // 实际更新：恰好一次
  return { status: "ok", mutated: true };
}

/**
 * @deprecated 兼容 adapter：裸 holderId 字符串入口。自动分类为 typed owner
 * （已知 namespace/object id/task/contract 形状或 legacy-unresolved）——不再
 * 生成含义不明的新记录；新代码必须使用 reserveProductionResourceForOwner。
 * 与 typed 入口走同一实现（schema gate + 全验证 + 单次 bump，不二次 bump）。
 */
export function reserveProductionResource(
  roomName: string,
  resource: ResourceConstant,
  amount: number,
  holderId: string,
  ttl: number = DEFAULT_TTL,
): ReservationMutationResult {
  return reserveProductionResourceForOwner(roomName, resource, amount, classifyTreasuryHolderIdAsOwner(holderId), ttl);
}

/** @deprecated 兼容 adapter：见 reserveProductionResource。 */
export function releaseProductionReservation(
  roomName: string,
  resource: ResourceConstant,
  holderId: string,
): ReservationMutationResult {
  return releaseProductionReservationForOwner(roomName, resource, classifyTreasuryHolderIdAsOwner(holderId));
}

/** @deprecated 兼容 adapter：见 reserveProductionResource。 */
export function renewProductionReservation(
  roomName: string,
  resource: ResourceConstant,
  amount: number,
  holderId: string,
  ttl: number = DEFAULT_TTL,
): ReservationMutationResult {
  return renewProductionReservationForOwner(roomName, resource, amount, classifyTreasuryHolderIdAsOwner(holderId), ttl);
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

export interface ReservationGcReport {
  removed: number;
  /** 发现的 malformed entry 数（不删除——置持久 corrupted 标志，显式 repair 解除）。 */
  corrupted: number;
}

/**
 * GC（17 tick memoryCleanup 调用）：删除过期 entry（实际删除才 bump）。
 * malformed entry（非对象/字段缺失/数值非法）**不删除**——置
 * Memory.runtime.resourceReservationsCorrupted 持久标志（有界描述），此后
 * 一切 mutation 拒绝、授权 fail closed，只有显式 repair（验证全 store 合法
 * 后清除标志）可恢复。绝不"删掉损坏 entry 后恢复乐观授权"。
 */
export function gcProductionReservations(): ReservationGcReport {
  const report: ReservationGcReport = { removed: 0, corrupted: 0 };
  const store = Memory.runtime?.resourceReservations;
  if (!store) return report;
  let removed = 0;
  for (const [key, entry] of Object.entries(store)) {
    if (!entry || typeof entry !== "object" || typeof entry.expiresAt !== "number" || !Number.isSafeInteger(entry.expiresAt)) {
      report.corrupted += 1;
      continue; // 损坏 entry 保留原样（不删）
    }
    if (entry.expiresAt < Game.time) {
      delete store[key];
      removed += 1;
    }
  }
  if (report.corrupted > 0) {
    if (!Memory.runtime) Memory.runtime = {};
    const runtime = Memory.runtime as NonNullable<typeof Memory.runtime> & { resourceReservationsCorrupted?: string };
    if (runtime.resourceReservationsCorrupted === undefined) {
      runtime.resourceReservationsCorrupted = `gc 发现 ${String(report.corrupted)} 条 malformed reservation entry（原样保留，显式 repair 前全部 mutation/授权 fail closed）`;
    }
  }
  if (removed > 0) bumpTreasuryCommitmentRevision();
  report.removed = removed;
  return report;
}

/** 冻结深拷贝的单个 entry（含 owner 对象；外部修改不影响 Memory）。 */
function freezeEntryCopy(entry: ReservationEntry): Readonly<ReservationEntry> {
  return Object.freeze({
    ...entry,
    ...(entry.owner !== undefined ? { owner: Object.freeze({ ...entry.owner }) } : {}),
  });
}

/**
 * 全部 reservation 的冻结快照（深拷贝）：外部调用者修改 list 结果不得改变
 * Memory、不得绕过 revision——返回冻结数组 + 冻结 entry（含冻结 owner）。
 */
export function listProductionReservations(): readonly Readonly<ReservationEntry>[] {
  const store = Memory.runtime?.resourceReservations;
  if (!store) return Object.freeze([]);
  return Object.freeze(Object.values(store).map(freezeEntryCopy));
}

export interface ReservationOwnerMigrationReport {
  /** 迁移执行状态：ok=本次成功推进到当前版本；already-migrated=版本已是当前值。 */
  status: "ok" | "already-migrated";
  /** 本次重编码 store key 并补写 owner 字段的条数。 */
  migrated: number;
  /** 已是当前版本形状（key 为 v4 token 且 owner 字段合法）无需变更的条数。 */
  alreadyTyped: number;
  /** 发现损坏（malformed entry / 旧 key 与平铺字段不一致 / 新 key 碰撞）——
   * 整个迁移终止：原数据保持不动、版本不推进、授权侧 fail closed。 */
  failure: string | null;
  /** 迁移执行后记录的版本标记（失败时保持原值）。 */
  version: number;
}

/** 单条 entry 的形状验证（迁移阶段 1 与显式 repair 共用）。 */
function validateReservationEntryShape(entry: unknown, key: string): string | null {
  if (!entry || typeof entry !== "object") {
    return `迁移发现非对象 entry（key ${key.slice(0, 64)}；原 store 保持不变）`;
  }
  const candidate = entry as Partial<ReservationEntry>;
  if (
    typeof candidate.roomName !== "string" || candidate.roomName.length === 0 ||
    typeof candidate.resource !== "string" || !VALID_RESOURCES.has(candidate.resource) ||
    typeof candidate.holderId !== "string" || candidate.holderId.length === 0 ||
    typeof candidate.amount !== "number" || !Number.isSafeInteger(candidate.amount) || candidate.amount < 0 ||
    typeof candidate.updatedAt !== "number" || !Number.isSafeInteger(candidate.updatedAt) || candidate.updatedAt < 0 ||
    typeof candidate.expiresAt !== "number" || !Number.isSafeInteger(candidate.expiresAt) || candidate.expiresAt < 0
  ) {
    return `迁移发现 malformed entry（key ${key.slice(0, 64)}；原 store 保持不变）`;
  }
  return null;
}

/**
 * 版本化原子迁移（第七轮 v4）：legacy store → key 重编码 canonical owner
 * token v4。两阶段执行：
 * 1. 临时结构完成全部验证——entry 形状完整、owner 字段合法（v2+ 数据；
 *    logical-service 缺 namespace 时按 id 注册表前缀无损补全，v3 数据常见）
 *    或可由 holderId 无损分类（v1）、**旧 key 一致性按版本核验**（v1/v2：
 *    `${roomName}:${resource}:${holderId}`；v3：v3 token——以验证过的
 *    entry.owner 为权威重算，不解析 token 反推）、新 key 无碰撞。任何
 *    malformed/collision/不一致立即终止，原 store 不动（零部分写入）；
 * 2. 全部通过后一次性引用切换替换 store、写 resourceReservationsOwnerVersion=4
 *    并 bump commitment revision（迁移后索引不得继续按旧 key 口径聚合）。
 * 幂等：版本已是 4 直接短路；失败后修复数据可重复执行。数值字段
 * （amount/updatedAt/expiresAt）一律不改写。
 */
export function migrateResourceReservationsForTypedOwner(): ReservationOwnerMigrationReport {
  const runtime = Memory.runtime;
  const currentVersion = runtime?.resourceReservationsOwnerVersion ?? (runtime?.resourceReservations ? 1 : RESERVATION_OWNER_VERSION);
  if (currentVersion === RESERVATION_OWNER_VERSION) {
    return { status: "already-migrated", migrated: 0, alreadyTyped: 0, failure: null, version: RESERVATION_OWNER_VERSION };
  }
  if (currentVersion !== 1 && currentVersion !== 2 && currentVersion !== 3) {
    return {
      status: "ok",
      migrated: 0,
      alreadyTyped: 0,
      failure: `未知 resourceReservationsOwnerVersion ${String(currentVersion)}（支持 1/2/3 → ${String(RESERVATION_OWNER_VERSION)}；原数据保留，授权 fail closed）`,
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
    const shapeError = validateReservationEntryShape(rawEntry, legacyKey);
    if (shapeError !== null) {
      return { status: "ok", migrated: 0, alreadyTyped: 0, failure: shapeError, version: currentVersion };
    }
    const entry = rawEntry as ReservationEntry;
    // owner 权威：以经过完整验证的 entry.owner 字段为准（不解析旧 token 字符串）；
    // owner 非法形状不乐观忽略——终止迁移；缺失则按 holderId 无损分类。
    let owner: TreasuryOwnerIdentity | undefined = coercePersistedOwner(entry.owner);
    if (entry.owner !== undefined && owner === undefined) {
      // v3 存量常见：logical-service 无 namespace（第六轮校验未要求）——按
      // id 注册表前缀无损补全后仍非法（如非 logical-service 带 namespace）才终止。
      const fallback = classifyTreasuryHolderIdAsOwner(entry.holderId);
      if (
        entry.owner &&
        typeof entry.owner === "object" &&
        typeof (entry.owner as Partial<TreasuryOwnerIdentity>).kind === "string" &&
        (entry.owner as Partial<TreasuryOwnerIdentity>).kind === fallback.kind &&
        typeof (entry.owner as Partial<TreasuryOwnerIdentity>).id === "string" &&
        (entry.owner as Partial<TreasuryOwnerIdentity>).id === fallback.id
      ) {
        owner = fallback; // kind/id 一致的半 typed owner：仅缺 namespace，无损补全
      } else {
        return {
          status: "ok",
          migrated: 0,
          alreadyTyped: 0,
          failure: `迁移发现非法 owner 字段（key ${legacyKey.slice(0, 64)}；原 store 保持不变）`,
          version: currentVersion,
        };
      }
    }
    if (owner === undefined) {
      owner = classifyTreasuryHolderIdAsOwner(entry.holderId);
    }
    // 旧 key 一致性（按版本核验）：key 必须与其 entry 的平铺字段/owner 严格
    // 一致——不一致说明数据被外部篡改/损坏，不得猜测重排。
    const flatKey = `${entry.roomName}:${entry.resource}:${entry.holderId}`;
    const expectedLegacyKey = currentVersion === 3 ? `${entry.roomName}:${entry.resource}:${treasuryReservationOwnerTokenV3(owner)}` : flatKey;
    if (legacyKey !== expectedLegacyKey) {
      return {
        status: "ok",
        migrated: 0,
        alreadyTyped: 0,
        failure: `迁移发现 store key 与 entry ${currentVersion === 3 ? "owner token(v3)" : "平铺字段"}不一致（key ${legacyKey.slice(0, 64)}；原 store 保持不变）`,
        version: currentVersion,
      };
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

/**
 * 显式 repair（仅供测试/管理修复路径调用，生产 tick 禁用——架构测试守护）：
 * 验证全 store entry 形状合法后清除持久 corrupted 标志。任何 malformed
 * entry → 拒绝（原数据不动，人工处理）。
 */
export function repairReservationStoreCorruptionForRepair(): { status: "repaired" | "rejected"; detail: string } {
  const runtime = Memory.runtime as (NonNullable<typeof Memory.runtime> & { resourceReservationsCorrupted?: string }) | undefined;
  if (runtime?.resourceReservationsCorrupted === undefined) {
    return { status: "rejected", detail: "无 corrupted 标志（无需 repair）" };
  }
  const store = runtime?.resourceReservations;
  if (!store || typeof store !== "object") {
    return { status: "rejected", detail: "resourceReservations store 非对象（人工处理）" };
  }
  for (const [key, entry] of Object.entries(store)) {
    const shapeError = validateReservationEntryShape(entry, key);
    if (shapeError !== null) {
      return { status: "rejected", detail: shapeError };
    }
  }
  delete runtime.resourceReservationsCorrupted;
  return { status: "repaired", detail: "corrupted 标志已清除（全部 entry 验证通过）" };
}
