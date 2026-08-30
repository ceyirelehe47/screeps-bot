/**
 * Treasury 幂等 receipt 与生命周期持久化（Memory 最小状态）。
 *
 * 边界约束：
 * - 只保存最小 receipt（transactionId → 结算 tick）与生命周期标记，
 *   绝不持久化 overlay、observation、journal 或完整物理事实；
 * - receipt 权威跨 global reset 存活：heap 缓存丢失后凭 Memory receipt
 *   恢复幂等判断；
 * - 安全驱逐契约：
 *   * 只有超过 retention 窗口（5000 tick）的 receipt 才允许自动回收；
 *   * retention 窗口内的 receipt 绝不因容量压力被驱逐——宁可拒绝新
 *     transaction（receipt_capacity_exhausted），也不让仍在幂等保证期内
 *     的 id 被提前淘汰后重放；
 *   * admission 预检在写入任何状态（journal/overlay/heap 缓存/Memory
 *     receipt）之前执行，失败零部分写入；
 * - key 编码：settled 普通对象的键一律为 "t:"+transactionId——transactionId
 *   字符集允许 "__proto__"/"constructor" 等危险字面量，前缀编码保证它们
 *   只会成为普通自有属性键，永不触发原型污染语义；
 * - 版本契约（第四轮升级到 v3）：
 *   * v1（裸键）→ v3：v1 raw key 一律**原样**作为 transactionId 输入安全
 *     编码（绝不调用 decode——v1 中 `abc` 与 `t:abc` 是两个不同且都合法的
 *     transactionId，decode 再 encode 会让它们碰撞）；
 *   * v2（前缀键 + entryCount）→ v3：补 nextExpiryTick 过期调度元数据；
 *   * 迁移先在临时结构完成全部校验（transactionId 格式 / settled tick
 *     完整有效性 / 编码碰撞防御），自检通过后一次性原子替换原 store；
 *     任何碰撞/非法 key/非法 value 都使原 store 保持不变并 fail closed；
 *   * 只执行一次（version 提升后不再进入迁移分支）；
 *   * 未知/更高/无法解析版本 → fail closed：原数据保留、拒绝新登记，
 *     不冷启动重建、不静默丢弃；
 * - 损坏 value fail closed（第四轮修复）：settled tick 必须是
 *   [0, Game.time] 内的安全整数；NaN/Infinity/非整数/负数/未来 tick 等
 *   一律视为损坏——迁移不跳过、cleanup 不删除、admission 整体阻断
 *   （receipt_store_incompatible），只有显式管理/修复路径可解除；
 *   已能可靠识别的旧 transaction（own key 存在且 value 有效）查询仍
 *   返回 already_settled——store 损坏不得让幂等保证期内的 id 被遗忘；
 * - 过期调度元数据 nextExpiryTick（v3 新增，正常路径避免全表扫描）：
 *   * 空表为 null；非空 = min(settledAt)+retention+1（第一个可能有条目
 *     过期的 nowTick，与过期条件 settledAt < now-retention 严格一致）；
 *   * Game.time 未到 nextExpiryTick 时 beginTick 清理零扫描、满容
 *     admission 直接 O(1) 拒绝（不反复全表扫描）；
 *   * 到达过期点执行一次清理并重算 nextExpiryTick；
 *   * global reset 后 load 时对元数据做一次完整验证（与 entryCount、
 *     key 格式、value 有效性同批），损坏即 fail closed、不放宽容量；
 *   * 插入/迁移/清理后元数据始终一致（commitSettledReceipt 维护单调
 *     min，cleanup 全量重算）；
 * - admission 复杂度：快路径 O(1)（entryCount + pending 预留计数）；
 * - 两阶段槽位预留：prepare 成功即占用一个 admission 槽（pending
 *   heap 集合，有界），使 commit 兑现时不再可能因容量被拒；abort/commit
 *   释放；其余 admission 的满容判断计入 pending 数（不让出即超卖）。
 */

import {
  TREASURY_TRANSACTION_ID_MAX_LENGTH,
  isValidTreasuryTransactionId,
} from "@/runtime/treasury/transactionId";
import type { TreasuryWriteFaultMarker } from "@/runtime/treasury/writeFault";
import { resetTreasuryQuarantineRuntimeForTest } from "@/runtime/treasury/quarantine";
import { resetTreasuryResolutionEventsForTest } from "@/runtime/treasury/resolutionEvents";
import { resetTreasuryIntentRuntimeForTest } from "@/runtime/treasury/intents";
import { unsealTreasuryAdapterRegistryForTest } from "@/runtime/treasury/actionContracts";

export const TREASURY_RECEIPT_RETENTION_TICKS = 5_000;
export const TREASURY_RECEIPT_MAX_ENTRIES = 4_096;
export const TREASURY_RECEIPT_VERSION = 3 as const;

const RECEIPT_KEY_PREFIX = "t:";

export interface TreasuryReceiptStore {
  version: typeof TREASURY_RECEIPT_VERSION;
  /** key = encodeReceiptKey(transactionId)；value = 结算 tick。 */
  settled: Record<string, number>;
  updatedAt: number;
  /** settled 自有键计数（加载时校验；admission 快路径的权威计数）。 */
  entryCount: number;
  /**
   * 过期调度元数据：空表 null；非空 = min(settledAt)+retention+1。
   * 未到该 tick 的一切清理/满容回收路径都不得扫描 store。
   */
  nextExpiryTick: number | null;
}

export interface TreasuryLifecycleMemory {
  lastBeginTick?: number;
  lastEndTick?: number;
}

interface TreasuryMemoryBranch {
  receipts?: {
    version?: number;
    settled?: Record<string, number>;
    updatedAt?: number;
    entryCount?: number;
    nextExpiryTick?: number | null;
  };
  lifecycle?: TreasuryLifecycleMemory;
  /** staged commit 意外故障的最小持久 marker（详见 writeFault.ts）。 */
  writeFault?: TreasuryWriteFaultMarker;
}

type RuntimeMemoryWithTreasury = NonNullable<Memory["runtime"]> & {
  treasury?: TreasuryMemoryBranch;
};

function treasuryBranch(): TreasuryMemoryBranch {
  if (!Memory.runtime) Memory.runtime = {};
  const runtime = Memory.runtime as RuntimeMemoryWithTreasury;
  if (!runtime.treasury) runtime.treasury = {};
  return runtime.treasury;
}

/** receipt key 编码：防 "__proto__"/"constructor" 等合法 transactionId 字面量。 */
export function encodeReceiptKey(transactionId: string): string {
  return RECEIPT_KEY_PREFIX + transactionId;
}

/**
 * 诊断用解码（已是编码键则原样语义返回 transactionId）。
 * 注意：legacy 迁移禁止使用——v1 裸键 `abc` 与 `t:abc` 是不同 transactionId。
 */
export function decodeReceiptKey(key: string): string {
  return key.startsWith(RECEIPT_KEY_PREFIX) ? key.slice(RECEIPT_KEY_PREFIX.length) : key;
}

/** settled tick 完整有效性：[0, nowTick] 内的安全整数（损坏即 fail closed）。 */
function isValidSettledTick(value: unknown, nowTick: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= nowTick
  );
}

/**
 * 查找已结算 receipt：返回有效结算 tick；own key 存在但 value 无效返回
 * "corrupted"；不存在返回 undefined。不依赖 store 版本——fatal/旧格式上
 * 已可靠识别的 id 仍返回结算 tick（幂等保证不因 store 损坏而遗忘）。
 */
function lookupSettled(
  settled: Record<string, number> | undefined,
  encodedKey: string,
  nowTick: number,
): number | "corrupted" | undefined {
  if (!settled || !Object.prototype.hasOwnProperty.call(settled, encodedKey)) return undefined;
  const value = (settled as Record<string, unknown>)[encodedKey];
  if (isValidSettledTick(value, nowTick)) return value;
  return "corrupted";
}

/** 读取（不创建）：查询侧零写路径使用。 */
export function peekTreasuryReceiptStore(): TreasuryReceiptStore | undefined {
  const branch = (Memory.runtime as RuntimeMemoryWithTreasury | undefined)?.treasury;
  return branch?.receipts as TreasuryReceiptStore | undefined;
}

export interface TreasuryReceiptHealth {
  readonly healthy: boolean;
  readonly detail: string | null;
}

/**
 * receipt store 健康探测（只读零写；authorizationSafe 的 receipt 条件）：
 * - heap 缓存已 load 且 fatal → unhealthy（value 级损坏在 load 校验检出后
 *   持续 fail closed）；
 * - 未 load 时做轻量形状探测（version 可识别 / settled 对象 / entryCount
 *   数字）——不做全表扫描（value 级损坏由下一次 load 校验显式检出）。
 */
export function peekTreasuryReceiptHealth(): TreasuryReceiptHealth {
  if (heapStoreRuntime?.fatal) {
    return { healthy: false, detail: heapStoreRuntime.fatal };
  }
  const store = peekTreasuryReceiptStore();
  if (store === undefined) return { healthy: true, detail: null };
  if (store.version !== TREASURY_RECEIPT_VERSION && store.version !== 1 && store.version !== 2) {
    return { healthy: false, detail: `未知 receipt 版本 ${String(store.version)}（fail closed）` };
  }
  if (!store.settled || typeof store.settled !== "object") {
    return { healthy: false, detail: "receipt settled 对象缺失" };
  }
  if (typeof store.entryCount !== "number" || !Number.isSafeInteger(store.entryCount) || store.entryCount < 0) {
    return { healthy: false, detail: "receipt entryCount 非法" };
  }
  return { healthy: true, detail: null };
}

export function peekTreasuryLifecycle(): TreasuryLifecycleMemory | undefined {
  const branch = (Memory.runtime as RuntimeMemoryWithTreasury | undefined)?.treasury;
  return branch?.lifecycle;
}

/**
 * 确定性操作计数（heap，global reset 归零；facade metrics 聚合）。
 * fullScans = Object.keys 全表扫描次数（load 校验 / 迁移 / 到点清理 /
 * fatal-store 巡检）；entriesVisited = 全部扫描上下文实际访问的条目数；
 * admissionFastPaths = 未触发任何扫描即得出结论的 admission 次数；
 * admissionFullStoreBlocked = 满容 O(1) 拒绝（含回收后仍满的拒绝）；
 * expiryCleanupScans = 到达过期点触发的清理扫描次数。
 */
const receiptEvents = {
  migrationsExecuted: 0,
  incompatibleFailures: 0,
  receiptFullScans: 0,
  admissionFastPaths: 0,
  admissionFullStoreBlocked: 0,
  expiryCleanupScans: 0,
  /** 全部扫描上下文（load 校验/迁移/过期清理/fatal 巡检）访问的条目总数。 */
  receiptEntriesVisited: 0,
  /** 迁移扫描次数（源 store 遍历 + 迁移自检各计一次）。 */
  receiptMigrationScans: 0,
  /** load 校验（v3 形状自检）访问的条目数。 */
  receiptLoadValidationEntries: 0,
  /** 到期清理访问的条目数（清理与 nextExpiry 重算已合并为单次遍历）。 */
  receiptExpiryCleanupEntries: 0,
  /** fatal-store 巡检（beginTick 清理在 fail-closed 下的剩余量统计）访问的条目数。 */
  receiptFatalInspectionEntries: 0,
  /** resolve-as-committed 刷新既有 receipt 到 resolution tick 的次数（第八轮）。 */
  receiptRefreshes: 0,
};

export interface TreasuryReceiptCounters {
  readonly migrationsExecuted: number;
  readonly incompatibleFailures: number;
  readonly receiptFullScans: number;
  readonly admissionFastPaths: number;
  readonly admissionFullStoreBlocked: number;
  readonly expiryCleanupScans: number;
  readonly receiptEntriesVisited: number;
  readonly receiptMigrationScans: number;
  readonly receiptLoadValidationEntries: number;
  readonly receiptExpiryCleanupEntries: number;
  readonly receiptFatalInspectionEntries: number;
  /** resolve-as-committed 刷新既有 receipt 到 resolution tick 的次数（第八轮）。 */
  readonly receiptRefreshes: number;
  /** 剩余可登记槽位（MAX − entryCount − pending 预留；查询路径 peek 只读）。 */
  readonly slotsRemaining: number;
  /** 下一次可能过期的 tick（null = 空表或 store 不可用）。 */
  readonly nextExpiryTick: number | null;
}

/** 只读读取计数与容量 gauge（零写：peek Memory，不触发 load/迁移）。 */
export function readTreasuryReceiptEventCounters(): TreasuryReceiptCounters {
  const store = peekTreasuryReceiptStore();
  const storeUsable = store !== undefined && store.version === TREASURY_RECEIPT_VERSION;
  const entryCount = storeUsable && typeof store.entryCount === "number" ? store.entryCount : 0;
  const slotsRemaining = storeUsable
    ? Math.max(0, TREASURY_RECEIPT_MAX_ENTRIES - entryCount - pendingAdmissions.size)
    : 0;
  return {
    ...receiptEvents,
    slotsRemaining,
    nextExpiryTick: storeUsable && typeof store.nextExpiryTick === "number" ? store.nextExpiryTick : null,
  };
}

export type TreasuryReceiptRefreshResult =
  | { readonly status: "refreshed"; readonly previousTick: number }
  | { readonly status: "written" }
  | { readonly status: "fatal"; readonly detail: string };

/**
 * resolve-as-committed 的既有 receipt 刷新（第八轮 8.3）：own key 存在且
 * value 有效时**更新 settled tick 至 resolution tick**（不是 already_settled
 * 短路——原 action tick 的旧窗口不得缩短防重放），同步维护 updatedAt 与
 * nextExpiryTick（单次有界重算：旧 tick 移除可能降低 min）；不存在时按新
 * 条目写入（entryCount+1、nextExpiry min 收敛）。fatal store 拒绝。
 */
export function refreshSettledReceiptForResolution(transactionId: string, tick: number): TreasuryReceiptRefreshResult {
  const runtime = loadReceiptStoreRuntime();
  if (runtime.fatal) {
    return { status: "fatal", detail: runtime.fatal };
  }
  const { store } = runtime;
  const key = encodeReceiptKey(transactionId);
  const existing = lookupSettled(store.settled, key, tick);
  if (existing === "corrupted") {
    return {
      status: "fatal",
      detail: `transactionId ${transactionId.slice(0, 48)} 对应 receipt value 损坏，无法安全刷新（fail closed）`,
    };
  }
  if (existing !== undefined) {
    if (existing === tick) {
      receiptEvents.receiptRefreshes += 1;
      return { status: "refreshed", previousTick: tick };
    }
    store.settled[key] = tick;
    store.updatedAt = tick;
    // nextExpiry 重算：旧 tick 移除可能使 min 下降（单次有界扫描；resolution
    // 是低频管理事件）。
    receiptEvents.receiptFullScans += 1;
    receiptEvents.receiptEntriesVisited += Object.keys(store.settled).length;
    store.nextExpiryTick = computeNextExpiryTick(store.settled);
    receiptEvents.receiptRefreshes += 1;
    return { status: "refreshed", previousTick: existing };
  }
  store.settled[key] = tick;
  store.entryCount += 1;
  store.updatedAt = tick;
  pendingAdmissions.delete(transactionId);
  const freshExpiry = tick + TREASURY_RECEIPT_RETENTION_TICKS + 1;
  if (store.nextExpiryTick === null || freshExpiry < store.nextExpiryTick) {
    store.nextExpiryTick = freshExpiry;
  }
  return { status: "written" };
}

/**
 * 运行态 store（heap 缓存）：加载/迁移/校验一次，后续 admission O(1)。
 * fatal 非 null 时处于 fail-closed：原数据保留，一切新登记拒绝。
 */
interface ReceiptStoreRuntime {
  store: TreasuryReceiptStore;
  fatal: string | null;
}

let heapStoreRuntime: ReceiptStoreRuntime | null = null;

function fatalRuntime(raw: NonNullable<TreasuryMemoryBranch["receipts"]>, reason: string): ReceiptStoreRuntime {
  receiptEvents.incompatibleFailures += 1;
  return { store: raw as unknown as TreasuryReceiptStore, fatal: reason };
}

/** 从编码键提取 transactionId 并校验格式（v3 存储键的形状契约）。 */
function decodeValidStorageKey(key: string): string | null {
  if (!key.startsWith(RECEIPT_KEY_PREFIX)) return null;
  const transactionId = key.slice(RECEIPT_KEY_PREFIX.length);
  return isValidTreasuryTransactionId(transactionId) ? transactionId : null;
}

/** 重算过期调度元数据：空表 null；非空 = min(settledAt)+retention+1。 */
function computeNextExpiryTick(settled: Record<string, number>): number | null {
  let minSettledAt: number | null = null;
  for (const key of Object.keys(settled)) {
    const value = settled[key];
    if (typeof value !== "number") continue;
    if (minSettledAt === null || value < minSettledAt) minSettledAt = value;
  }
  return minSettledAt === null ? null : minSettledAt + TREASURY_RECEIPT_RETENTION_TICKS + 1;
}

/**
 * v3 store 完整形状自检（迁移写回前与 load 校验共用；一次全表扫描）：
 * own key 数、entryCount、每个存储键格式、每个 settled tick、
 * nextExpiryTick 与实际 min 的一致性。返回 null = 合法，否则有界错误描述。
 * context 决定 entries 计数归属（load 校验 / 迁移自检）。
 */
function validateReceiptStoreShape(
  store: TreasuryReceiptStore,
  nowTick: number,
  context: "load" | "migration",
): string | null {
  receiptEvents.receiptFullScans += 1;
  const settled = store.settled;
  if (!settled || typeof settled !== "object") return "settled 非对象";
  const ownKeys = Object.keys(settled);
  receiptEvents.receiptEntriesVisited += ownKeys.length;
  if (context === "load") receiptEvents.receiptLoadValidationEntries += ownKeys.length;
  if (store.entryCount !== ownKeys.length) {
    return `entryCount 校验失败: 声明 ${String(store.entryCount)} 实际 ${String(ownKeys.length)}`;
  }
  let minSettledAt: number | null = null;
  for (const key of ownKeys) {
    const transactionId = decodeValidStorageKey(key);
    if (transactionId === null) {
      return `存储键格式非法（须为 "t:"+合法 transactionId）: ${key.slice(0, TREASURY_TRANSACTION_ID_MAX_LENGTH + 8)}`;
    }
    const value = (settled as Record<string, unknown>)[key];
    if (!isValidSettledTick(value, nowTick)) {
      return `settled tick 损坏（须为 [0, ${String(nowTick)}] 安全整数）: ${transactionId.slice(0, 32)}=${String(value)}`;
    }
    if (minSettledAt === null || value < minSettledAt) minSettledAt = value;
  }
  const expectedNextExpiry = minSettledAt === null ? null : minSettledAt + TREASURY_RECEIPT_RETENTION_TICKS + 1;
  if (store.nextExpiryTick !== expectedNextExpiry) {
    return `nextExpiryTick 元数据损坏: 声明 ${String(store.nextExpiryTick)} 实际应为 ${String(expectedNextExpiry)}`;
  }
  return null;
}

/**
 * legacy 迁移（v1 裸键 / v2 前缀键 → v3）：临时结构完成全部校验，自检
 * 通过后一次性原子替换原 store；任何非法 key/value/碰撞都返回 fatal，
 * 原 store 保持不变（fail closed，绝不静默跳过损坏条目）。
 */
function migrateLegacyReceiptStore(
  raw: NonNullable<TreasuryMemoryBranch["receipts"]>,
  fromVersion: number,
  nowTick: number,
): ReceiptStoreRuntime {
  const source = raw.settled;
  if (!source || typeof source !== "object") {
    return fatalRuntime(raw, `v${String(fromVersion)} receipt store 缺失 settled 对象（原数据保留，拒绝登记）`);
  }
  const settled: Record<string, number> = {};
  let entryCount = 0;
  receiptEvents.receiptFullScans += 1;
  receiptEvents.receiptMigrationScans += 1;
  const sourceKeys = Object.keys(source);
  receiptEvents.receiptEntriesVisited += sourceKeys.length;
  for (const rawKey of sourceKeys) {
    // v1 裸键原样作为 transactionId（不 decode——`abc` 与 `t:abc` 不碰撞）；
    // v2 键已是编码形态，decode 后按 transactionId 重新走同一编码管道。
    const transactionId =
      fromVersion === 1 ? rawKey : decodeValidStorageKey(rawKey) ?? `@invalid:${rawKey.slice(0, 24)}`;
    if (!isValidTreasuryTransactionId(transactionId)) {
      return fatalRuntime(
        raw,
        `v${String(fromVersion)} 迁移发现非法 transactionId key（原 store 保持不变）: ${rawKey.slice(0, 48)}`,
      );
    }
    const value = (source as Record<string, unknown>)[rawKey];
    if (!isValidSettledTick(value, nowTick)) {
      return fatalRuntime(
        raw,
        `v${String(fromVersion)} 迁移发现损坏 settled tick（不得跳过；原 store 保持不变）: ${rawKey.slice(0, 48)}=${String(value)}`,
      );
    }
    const encodedKey = encodeReceiptKey(transactionId);
    if (Object.prototype.hasOwnProperty.call(settled, encodedKey)) {
      return fatalRuntime(
        raw,
        `v${String(fromVersion)} 迁移发现编码碰撞（原 store 保持不变）: ${transactionId.slice(0, 48)}`,
      );
    }
    settled[encodedKey] = value;
    entryCount += 1;
  }
  const candidate: TreasuryReceiptStore = {
    version: TREASURY_RECEIPT_VERSION,
    settled,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : nowTick,
    entryCount,
    nextExpiryTick: computeNextExpiryTick(settled),
  };
  // 迁移成功后立即验证：own key 数 / entry count / 存储键格式 / settled tick
  // / 元数据一致性（validateReceiptStoreShape 即该自检）。
  const shapeError = validateReceiptStoreShape(candidate, nowTick, "migration");
  if (shapeError !== null) {
    return fatalRuntime(raw, `v${String(fromVersion)} 迁移自检失败（原 store 保持不变）: ${shapeError}`);
  }
  treasuryBranch().receipts = candidate; // 一次性原子替换（引用切换）
  receiptEvents.migrationsExecuted += 1;
  return { store: candidate, fatal: null };
}

/**
 * 加载（含迁移与校验）：登记/生命周期路径专用（可能写 Memory）。
 * 校验失败（版本未知/entryCount 不符/value 损坏/元数据损坏）→ fail closed，
 * 不删数据、不放宽容量、不接受新 transaction，直至人工修复。
 */
function loadReceiptStoreRuntime(): ReceiptStoreRuntime {
  if (heapStoreRuntime) return heapStoreRuntime;
  const raw = treasuryBranch().receipts;
  if (!raw) {
    const created: TreasuryReceiptStore = {
      version: TREASURY_RECEIPT_VERSION,
      settled: {},
      updatedAt: Game.time,
      entryCount: 0,
      nextExpiryTick: null,
    };
    treasuryBranch().receipts = created;
    heapStoreRuntime = { store: created, fatal: null };
    return heapStoreRuntime;
  }
  if (raw.version === TREASURY_RECEIPT_VERSION) {
    const candidate = raw as unknown as TreasuryReceiptStore;
    // global reset 后的元数据验证：entryCount/键格式/value/nextExpiryTick
    // 一次全量校验（每 heap 生命周期一次），损坏即 fail closed。
    const shapeError = validateReceiptStoreShape(candidate, Game.time, "load");
    if (shapeError !== null) {
      heapStoreRuntime = fatalRuntime(raw, `${shapeError}（手工损坏，拒绝登记直至人工清理）`);
      return heapStoreRuntime;
    }
    heapStoreRuntime = { store: candidate, fatal: null };
    return heapStoreRuntime;
  }
  if (raw.version === 1 || raw.version === 2) {
    heapStoreRuntime = migrateLegacyReceiptStore(raw, raw.version, Game.time);
    return heapStoreRuntime;
  }
  // 未知/更高/无法解析版本：fail closed，原数据不动、不冷启动重建。
  heapStoreRuntime = fatalRuntime(
    raw,
    `未知 receipt 版本 ${String(raw.version)}（当前支持 ≤${String(TREASURY_RECEIPT_VERSION)}；原数据保留，拒绝登记直至人工处理）`,
  );
  return heapStoreRuntime;
}

/** 登记/幂等路径使用：确保 v3 store 存在（登记路径允许写 Memory）；fail closed 时抛出。 */
export function ensureTreasuryReceiptStore(): TreasuryReceiptStore {
  const runtime = loadReceiptStoreRuntime();
  if (runtime.fatal) {
    throw new Error(`Treasury receipt store fail-closed: ${runtime.fatal}`);
  }
  return runtime.store;
}

/**
 * 幂等查询（只读）：已可靠识别（own key 存在且 settled tick 有效）返回
 * 结算 tick；损坏/不存在/版本不可解析返回 undefined。store fail-closed
 * 期间仍尽力回答——幂等保证期内的 id 不因 store 损坏被遗忘。
 */
export function hasSettledReceipt(transactionId: string): number | undefined {
  const store = peekTreasuryReceiptStore();
  const found = store && lookupSettled(store.settled, encodeReceiptKey(transactionId), Game.time);
  return typeof found === "number" ? found : undefined;
}

export type TreasuryReceiptAdmission =
  | { readonly status: "admitted" }
  | { readonly status: "already_settled"; readonly firstSettledAtTick: number }
  | {
      readonly status: "rejected";
      readonly reason: "receipt_capacity_exhausted" | "receipt_store_incompatible";
      readonly detail: string;
    };

/** 当前满容判定（计入两阶段 prepare 的 pending 预留）。 */
function capacityExhausted(store: TreasuryReceiptStore): boolean {
  return store.entryCount + pendingAdmissions.size >= TREASURY_RECEIPT_MAX_ENTRIES;
}

/**
 * 登记前 admission 预检（必须发生在写入 journal/overlay/heap 缓存/Memory
 * receipt 任何状态之前）：
 * - 已结算 id → already_settled（store 满不改变幂等结果；fatal store 上
 *   仍可靠识别的 id 同样返回 already_settled）；
 * - 版本未知/损坏 → 拒绝（fail closed，新 transaction 一律阻断）；
 * - 未过期条目 + pending 预留已达硬容量：
 *   * 到达 nextExpiryTick → 执行一次过期回收（扫描）再判；
 *   * 未到过期点 → O(1) 直接拒绝（admissionFullStoreBlocked，不扫描）。
 */
export function admitTreasuryReceipt(transactionId: string, nowTick: number): TreasuryReceiptAdmission {
  const runtime = loadReceiptStoreRuntime();
  const { store } = runtime;
  const existing = lookupSettled(store.settled, encodeReceiptKey(transactionId), nowTick);
  if (typeof existing === "number") {
    receiptEvents.admissionFastPaths += 1;
    return { status: "already_settled", firstSettledAtTick: existing };
  }
  if (runtime.fatal) {
    // 损坏 store：可靠识别的 id 已在上面返回 already_settled，其余整体阻断。
    return { status: "rejected", reason: "receipt_store_incompatible", detail: runtime.fatal };
  }
  if (existing === "corrupted") {
    return {
      status: "rejected",
      reason: "receipt_store_incompatible",
      detail: `transactionId ${transactionId.slice(0, 48)} 对应 receipt value 损坏，无法可靠判断结算状态（fail closed）`,
    };
  }
  if (pendingAdmissions.has(transactionId)) {
    // 同 id 已预留槽位（两阶段重复 prepare 由 facade 层拦截，此处防御）。
    receiptEvents.admissionFastPaths += 1;
    return { status: "admitted" };
  }
  if (capacityExhausted(store)) {
    if (store.nextExpiryTick !== null && store.nextExpiryTick <= nowTick) {
      // 到达过期点：一次有界回收后重判（低频路径）。
      runExpiryCleanup(store, nowTick);
      if (capacityExhausted(store)) {
        receiptEvents.admissionFullStoreBlocked += 1;
        return {
          status: "rejected",
          reason: "receipt_capacity_exhausted",
          detail: `未过期 receipt 已达硬容量 ${String(TREASURY_RECEIPT_MAX_ENTRIES)} 条且回收后仍满（retention 窗口内条目绝不因容量驱逐）`,
        };
      }
    } else {
      // 满载且下一过期点仍在未来：O(1) fail closed，不反复全表扫描。
      receiptEvents.admissionFullStoreBlocked += 1;
      return {
        status: "rejected",
        reason: "receipt_capacity_exhausted",
        detail: `未过期 receipt 已达硬容量 ${String(TREASURY_RECEIPT_MAX_ENTRIES)} 条（下一过期点 tick ${String(store.nextExpiryTick)} 尚未到达，不做全表扫描）`,
      };
    }
  }
  receiptEvents.admissionFastPaths += 1;
  return { status: "admitted" };
}

// ── 两阶段槽位预留（prepare→Game API→commit/abort） ────────────────────────

/** prepare 成功占用的 admission 槽（heap，有界；commit/abort 释放）。 */
const pendingAdmissions = new Set<string>();
export const TREASURY_PREPARED_ADMISSION_LIMIT = 64;

/**
 * 两阶段 prepare 的 admission 预留：预检通过即占用一个容量槽，使后续
 * commit 兑现不再可能因他人挤占容量而被拒。其余 admission 的满容判定
 * 计入 pending 数——预留期间容量不被超卖。
 */
export function reserveTreasuryReceiptAdmission(transactionId: string, nowTick: number): TreasuryReceiptAdmission {
  const admission = admitTreasuryReceipt(transactionId, nowTick);
  if (admission.status !== "admitted") return admission;
  if (pendingAdmissions.size >= TREASURY_PREPARED_ADMISSION_LIMIT && !pendingAdmissions.has(transactionId)) {
    receiptEvents.admissionFullStoreBlocked += 1;
    return {
      status: "rejected",
      reason: "receipt_capacity_exhausted",
      detail: `并发 prepare 预留已达上限 ${String(TREASURY_PREPARED_ADMISSION_LIMIT)}`,
    };
  }
  pendingAdmissions.add(transactionId);
  return admission;
}

/** abort：释放 prepare 预留（返回是否确有预留被释放）。 */
export function releaseTreasuryReceiptReservation(transactionId: string): boolean {
  return pendingAdmissions.delete(transactionId);
}

/** 生命周期兜底：释放全部预留（endTick / resetForTest；正常逐个 release）。 */
export function releaseAllTreasuryReceiptReservations(): number {
  const released = pendingAdmissions.size;
  pendingAdmissions.clear();
  return released;
}

/** 结算写入（admission 通过/预留兑现后的原子提交段调用）。 */
/** 结算写入结果：written=已写入；already_settled=幂等命中；fatal=store 不可写。 */
export type TreasuryReceiptWriteResult =
  | { readonly status: "written" }
  | { readonly status: "already_settled" }
  | { readonly status: "fatal"; readonly detail: string };

/**
 * 结算写入（admission 通过/预留兑现后的 staged commit 段调用）。返回明确
 * 结果——fatal 时调用方必须进入 write-fault 处理，不得静默 no-op 后继续
 * 返回 committed。
 */
export function commitSettledReceipt(transactionId: string, tick: number): TreasuryReceiptWriteResult {
  const runtime = loadReceiptStoreRuntime();
  if (runtime.fatal) {
    return { status: "fatal", detail: runtime.fatal };
  }
  const { store } = runtime;
  const key = encodeReceiptKey(transactionId);
  const existing = lookupSettled(store.settled, key, tick);
  if (existing === "corrupted") {
    // 损坏绝不解释为 already_settled（第六轮）：该 id 的结算状态无法可靠
    // 判断——fatal fail closed，调用方（commit/resolution）进入 write-fault
    // 处理，绝不发布 committed heap projection。
    return {
      status: "fatal",
      detail: `transactionId ${transactionId.slice(0, 48)} 对应 receipt value 损坏，无法安全写入结算（fail closed）`,
    };
  }
  if (existing !== undefined) {
    pendingAdmissions.delete(transactionId); // 双保险：不重复叠加，仍释放预留
    return { status: "already_settled" };
  }
  store.settled[key] = tick;
  store.entryCount += 1;
  store.updatedAt = tick;
  pendingAdmissions.delete(transactionId);
  // 空表首条：建立过期点；否则新条目 settledAt=now 不会早于现有 min，
  // nextExpiryTick 保持不变（防御性 min 收敛）。
  const freshExpiry = tick + TREASURY_RECEIPT_RETENTION_TICKS + 1;
  if (store.nextExpiryTick === null || freshExpiry < store.nextExpiryTick) {
    store.nextExpiryTick = freshExpiry;
  }
  return { status: "written" };
}

interface CleanupAccumulator {
  retentionEvicted: number;
  /** 防御分支：损坏 value 既不删除也不迁移（正常流程 load 已 fail closed）。 */
  corruptedSkipped: number;
}

/**
 * 到期清理：只删除**经过完整验证且超过 retention** 的正常 receipt。单次
 * 遍历同时完成删除与 nextExpiryTick 重算（幸存条目 min 就地维护，不再
 * 二次全表扫描）；损坏 value 绝不删除（保留计数）。
 */
function runExpiryCleanup(store: TreasuryReceiptStore, nowTick: number): CleanupAccumulator {
  const acc: CleanupAccumulator = { retentionEvicted: 0, corruptedSkipped: 0 };
  receiptEvents.receiptFullScans += 1;
  receiptEvents.expiryCleanupScans += 1;
  const keys = Object.keys(store.settled);
  receiptEvents.receiptEntriesVisited += keys.length;
  receiptEvents.receiptExpiryCleanupEntries += keys.length;
  let mutated = false;
  let minSurvivor: number | null = null;
  for (const key of keys) {
    const settledAt = (store.settled as Record<string, unknown>)[key];
    if (!isValidSettledTick(settledAt, nowTick)) {
      acc.corruptedSkipped += 1;
      // 损坏条目不会被删除：min 计算视为 0（保守最早过期点，宁早扫描不漏删）。
      minSurvivor = 0;
      continue;
    }
    if (settledAt >= nowTick - TREASURY_RECEIPT_RETENTION_TICKS) {
      if (minSurvivor === null || settledAt < minSurvivor) minSurvivor = settledAt;
      continue;
    }
    delete store.settled[key];
    store.entryCount -= 1;
    acc.retentionEvicted += 1;
    mutated = true;
  }
  if (mutated) store.updatedAt = nowTick;
  store.nextExpiryTick = minSurvivor === null ? null : minSurvivor + TREASURY_RECEIPT_RETENTION_TICKS + 1;
  return acc;
}

export interface TreasuryReceiptCleanupReport {
  retentionEvicted: number;
  /** 损坏 value 被跳过（保留原样）的条数——正常运行恒为 0。 */
  corruptedSkipped: number;
  remaining: number;
  /** 未过期但超过硬容量的条数（绝不驱逐，显式报告供监控）。 */
  overLimit: number;
  /** fail-closed 时的有界诊断（null = 正常）。 */
  fatalDetail: string | null;
  /** 清理后的下一次过期点（null = 空表）。 */
  nextExpiryTick: number | null;
}

/**
 * 生命周期清理（beginTick 触发）：nextExpiryTick 未到 → 零扫描直接返回；
 * 到达 → 一次清理并重算过期点。只回收超过 retention 窗口的正常 receipt，
 * 绝不因容量驱逐 retention 内条目；fail-closed 状态下不动任何数据。
 */
export function cleanupTreasuryReceipts(nowTick: number): TreasuryReceiptCleanupReport {
  const runtime = loadReceiptStoreRuntime();
  if (runtime.fatal) {
    receiptEvents.receiptFullScans += 1;
    const fatalKeys = Object.keys(runtime.store.settled ?? {});
    receiptEvents.receiptEntriesVisited += fatalKeys.length;
    receiptEvents.receiptFatalInspectionEntries += fatalKeys.length;
    const remaining = fatalKeys.length;
    return {
      retentionEvicted: 0,
      corruptedSkipped: 0,
      remaining,
      overLimit: 0,
      fatalDetail: runtime.fatal,
      nextExpiryTick: null,
    };
  }
  const { store } = runtime;
  if (store.nextExpiryTick === null || store.nextExpiryTick > nowTick) {
    // 未到过期点：不扫描整个 store（过期调度元数据的正常路径）。
    return {
      retentionEvicted: 0,
      corruptedSkipped: 0,
      remaining: store.entryCount,
      overLimit: Math.max(0, store.entryCount - TREASURY_RECEIPT_MAX_ENTRIES),
      fatalDetail: null,
      nextExpiryTick: store.nextExpiryTick,
    };
  }
  const acc = runExpiryCleanup(store, nowTick);
  return {
    retentionEvicted: acc.retentionEvicted,
    corruptedSkipped: acc.corruptedSkipped,
    remaining: store.entryCount,
    overLimit: Math.max(0, store.entryCount - TREASURY_RECEIPT_MAX_ENTRIES),
    fatalDetail: null,
    nextExpiryTick: store.nextExpiryTick,
  };
}

export function writeTreasuryLifecycle(update: TreasuryLifecycleMemory): void {
  const branch = treasuryBranch();
  branch.lifecycle = { ...branch.lifecycle, ...update };
}

export function readTreasuryLifecycle(): TreasuryLifecycleMemory | undefined {
  return peekTreasuryLifecycle();
}

/**
 * resolution store 的测试清理钩子（第八轮）：resolutionStore 依赖本模块
 *（receipt 查询/retention 常量），为避免循环依赖，其测试 reset 经此注册
 * ——resolutionStore 模块加载时自注册；未加载（无 resolution 消费的测试）
 * 时无需清理。
 */
let resolutionResetHook: (() => void) | null = null;
export function registerTreasuryResolutionResetHook(hook: (() => void) | null): void {
  resolutionResetHook = hook;
}

/** 仅供测试：清除 Treasury 持久状态（receipts + lifecycle + writeFault + quarantine + resolutions + intents）并失效 heap 缓存。 */
export function clearTreasuryPersistenceForTest(): void {
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithTreasury | undefined)?.treasury;
  if (branch) {
    delete branch.receipts;
    delete branch.lifecycle;
    delete branch.writeFault;
    delete branch.quarantine;
    delete branch.resolutions;
    delete branch.intents;
  }
  heapStoreRuntime = null;
  pendingAdmissions.clear();
  resetTreasuryQuarantineRuntimeForTest();
  resetTreasuryResolutionEventsForTest();
  resetTreasuryIntentRuntimeForTest();
  // 第十一轮：registry seal 测试隔离（treasuryCore 的 RuntimeServices 集成
  // 会 seal 生产 registry——后续测试的动态注册默认解除）。
  unsealTreasuryAdapterRegistryForTest();
  resolutionResetHook?.();
  receiptEvents.migrationsExecuted = 0;
  receiptEvents.incompatibleFailures = 0;
  receiptEvents.receiptFullScans = 0;
  receiptEvents.admissionFastPaths = 0;
  receiptEvents.admissionFullStoreBlocked = 0;
  receiptEvents.expiryCleanupScans = 0;
  receiptEvents.receiptEntriesVisited = 0;
  receiptEvents.receiptMigrationScans = 0;
  receiptEvents.receiptLoadValidationEntries = 0;
  receiptEvents.receiptExpiryCleanupEntries = 0;
  receiptEvents.receiptFatalInspectionEntries = 0;
  receiptEvents.receiptRefreshes = 0;
}

/** 校验 receipt 键与 transactionId 规范一致（诊断/测试用）。 */
export function isValidTreasuryReceiptKey(transactionId: string): boolean {
  return (
    typeof transactionId === "string" &&
    transactionId.length > 0 &&
    transactionId.length <= TREASURY_TRANSACTION_ID_MAX_LENGTH
  );
}
