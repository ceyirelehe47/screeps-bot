/**
 * Treasury 幂等 receipt 与生命周期持久化（Memory 最小状态）。
 *
 * 边界约束：
 * - 只保存最小 receipt（transactionId → 结算 tick）与生命周期标记，
 *   绝不持久化 overlay、observation、journal 或完整物理事实；
 * - receipt 权威跨 global reset 存活：heap 缓存丢失后凭 Memory receipt
 *   恢复幂等判断；
 * - 安全驱逐契约（第三轮修复）：
 *   * 只有超过 retention 窗口（5000 tick）的 receipt 才允许自动回收；
 *   * retention 窗口内的 receipt 绝不因容量压力被驱逐——宁可拒绝新
 *     transaction（receipt_capacity_exhausted），也不让仍在幂等保证期内
 *     的 id 被提前淘汰后重放；
 *   * admission 预检在写入任何状态（journal/overlay/heap 缓存/Memory
 *     receipt）之前执行，失败零部分写入；
 * - admission 复杂度：快路径 O(1)（entryCount 计数）；满容时才触发一次
 *   有界过期回收扫描（低频故障路径，不构成每笔 transaction 的全表扫描）；
 * - key 编码：settled 普通对象的键一律为 "t:"+transactionId——transactionId
 *   字符集允许 "__proto__"/"constructor" 等危险字面量，前缀编码保证它们
 *   只会成为普通自有属性键，永不触发原型污染语义；
 * - 版本契约：version 1（裸键）→ version 2（前缀键 + entryCount）有已知
 *   迁移，只执行一次且保留全部 transactionId 与结算 tick；遇到未知/更高/
 *   无法解析版本或 entryCount 与实际条目数不符（手工损坏）时进入
 *   fail-closed：不删除旧数据、不接受新 transaction，直到人工清理
 *   （clearTreasuryPersistenceForTest 或修复 Memory）。
 */

import { TREASURY_TRANSACTION_ID_MAX_LENGTH } from "@/runtime/treasury/transactionId";

export const TREASURY_RECEIPT_RETENTION_TICKS = 5_000;
export const TREASURY_RECEIPT_MAX_ENTRIES = 4_096;
export const TREASURY_RECEIPT_VERSION = 2 as const;

const RECEIPT_KEY_PREFIX = "t:";

export interface TreasuryReceiptStore {
  version: typeof TREASURY_RECEIPT_VERSION;
  /** key = encodeReceiptKey(transactionId)；value = 结算 tick。 */
  settled: Record<string, number>;
  updatedAt: number;
  /** settled 自有键计数（加载时校验；admission 快路径的权威计数）。 */
  entryCount: number;
}

export interface TreasuryLifecycleMemory {
  lastBeginTick?: number;
  lastEndTick?: number;
}

interface TreasuryMemoryBranch {
  receipts?: { version?: number; settled?: Record<string, number>; updatedAt?: number; entryCount?: number };
  lifecycle?: TreasuryLifecycleMemory;
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

/** 诊断用解码（已是编码键则原样语义返回 transactionId）。 */
export function decodeReceiptKey(key: string): string {
  return key.startsWith(RECEIPT_KEY_PREFIX) ? key.slice(RECEIPT_KEY_PREFIX.length) : key;
}

function settledAtOf(store: { settled?: Record<string, number> }, encodedKey: string): number | undefined {
  const settled = store.settled;
  if (!settled || !Object.prototype.hasOwnProperty.call(settled, encodedKey)) return undefined;
  const value = settled[encodedKey];
  return typeof value === "number" ? value : undefined;
}

/** 读取（不创建）：查询侧零写路径使用。 */
export function peekTreasuryReceiptStore(): TreasuryReceiptStore | undefined {
  const branch = (Memory.runtime as RuntimeMemoryWithTreasury | undefined)?.treasury;
  return branch?.receipts as TreasuryReceiptStore | undefined;
}

export function peekTreasuryLifecycle(): TreasuryLifecycleMemory | undefined {
  const branch = (Memory.runtime as RuntimeMemoryWithTreasury | undefined)?.treasury;
  return branch?.lifecycle;
}

/** 诊断事件计数（heap，global reset 归零；facade metrics 聚合）。 */
const receiptEvents = { migrationsExecuted: 0, incompatibleFailures: 0 };

export function readTreasuryReceiptEventCounters(): Readonly<{ migrationsExecuted: number; incompatibleFailures: number }> {
  return { ...receiptEvents };
}

/**
 * 运行态 store（heap 缓存）：加载/迁移/校验一次，后续 admission O(1)。
 * fatal 非 null 时处于 fail-closed：原数据保留，一切登记拒绝。
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

/** v1（裸键）→ v2（前缀键 + entryCount）无损迁移；只执行一次（version 提升后不再进入）。 */
function migrateV1ToV2(raw: NonNullable<TreasuryMemoryBranch["receipts"]>): TreasuryReceiptStore {
  const source = raw.settled ?? {};
  const settled: Record<string, number> = {};
  let entryCount = 0;
  for (const key of Object.keys(source)) {
    const settledAt = source[key];
    if (typeof settledAt !== "number") continue; // 损坏值不迁移（无幂等语义）
    settled[encodeReceiptKey(decodeReceiptKey(key))] = settledAt;
    entryCount += 1;
  }
  const migrated: TreasuryReceiptStore = {
    version: TREASURY_RECEIPT_VERSION,
    settled,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Game.time,
    entryCount,
  };
  treasuryBranch().receipts = migrated;
  receiptEvents.migrationsExecuted += 1;
  return migrated;
}

/**
 * 加载（含迁移与校验）：登记/生命周期路径专用（可能写 Memory）。
 * 校验失败（entryCount 与实际不符 = 手工损坏）→ fail closed，不删数据。
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
    };
    treasuryBranch().receipts = created;
    heapStoreRuntime = { store: created, fatal: null };
    return heapStoreRuntime;
  }
  if (raw.version === TREASURY_RECEIPT_VERSION) {
    const actual = Object.keys(raw.settled ?? {}).length;
    const declared = typeof raw.entryCount === "number" ? raw.entryCount : -1;
    if (declared !== actual) {
      // 手工损坏：fail closed（不放宽容量、不自动"修复"绕过校验）。
      heapStoreRuntime = fatalRuntime(raw, `entryCount 校验失败: 声明 ${String(declared)} 实际 ${String(actual)}（手工损坏，拒绝登记直至人工清理）`);
      return heapStoreRuntime;
    }
    heapStoreRuntime = { store: raw as unknown as TreasuryReceiptStore, fatal: null };
    return heapStoreRuntime;
  }
  if (raw.version === 1) {
    heapStoreRuntime = { store: migrateV1ToV2(raw), fatal: null };
    return heapStoreRuntime;
  }
  // 未知/更高/无法解析版本：fail closed，原数据不动、不冷启动重建。
  heapStoreRuntime = fatalRuntime(
    raw,
    `未知 receipt 版本 ${String(raw.version)}（当前支持 ≤${String(TREASURY_RECEIPT_VERSION)}；原数据保留，拒绝登记直至人工处理）`,
  );
  return heapStoreRuntime;
}

/** 登记/幂等路径使用：确保 v2 store 存在（登记路径允许写 Memory）；fail closed 时抛出。 */
export function ensureTreasuryReceiptStore(): TreasuryReceiptStore {
  const runtime = loadReceiptStoreRuntime();
  if (runtime.fatal) {
    throw new Error(`Treasury receipt store fail-closed: ${runtime.fatal}`);
  }
  return runtime.store;
}

export function hasSettledReceipt(transactionId: string): number | undefined {
  const store = peekTreasuryReceiptStore();
  if (!store || store.version !== TREASURY_RECEIPT_VERSION) return undefined;
  return settledAtOf(store, encodeReceiptKey(transactionId));
}

export type TreasuryReceiptAdmission =
  | { readonly status: "admitted" }
  | { readonly status: "already_settled"; readonly firstSettledAtTick: number }
  | {
      readonly status: "rejected";
      readonly reason: "receipt_capacity_exhausted" | "receipt_store_incompatible";
      readonly detail: string;
    };

/**
 * 登记前 admission 预检（必须发生在写入 journal/overlay/heap 缓存/Memory
 * receipt 任何状态之前）：
 * - 已结算 id → already_settled（store 满不改变幂等结果）；
 * - 版本未知/损坏 → 拒绝（fail closed）；
 * - 未过期条目已达硬容量且无过期可回收 → 拒绝（绝不驱逐 retention 窗口内
 *   的 receipt 来腾容量）；满容时先做一次有界过期回收（低频路径）。
 */
export function admitTreasuryReceipt(transactionId: string, nowTick: number): TreasuryReceiptAdmission {
  const runtime = loadReceiptStoreRuntime();
  if (runtime.fatal) {
    return { status: "rejected", reason: "receipt_store_incompatible", detail: runtime.fatal };
  }
  const { store } = runtime;
  const existing = settledAtOf(store, encodeReceiptKey(transactionId));
  if (existing !== undefined) {
    return { status: "already_settled", firstSettledAtTick: existing };
  }
  if (store.entryCount >= TREASURY_RECEIPT_MAX_ENTRIES) {
    // 满容：低频故障路径——尝试回收过期条目（O(n) 但仅在满容时发生一次）。
    cleanupSettledEntries(store, nowTick);
    if (store.entryCount >= TREASURY_RECEIPT_MAX_ENTRIES) {
      return {
        status: "rejected",
        reason: "receipt_capacity_exhausted",
        detail: `未过期 receipt 已达硬容量 ${String(TREASURY_RECEIPT_MAX_ENTRIES)} 条且无过期可回收（retention 窗口内条目绝不因容量驱逐）`,
      };
    }
  }
  return { status: "admitted" };
}

/** 结算写入（admission 通过后的原子提交段调用）。 */
export function commitSettledReceipt(transactionId: string, tick: number): void {
  const runtime = loadReceiptStoreRuntime();
  if (runtime.fatal) return; // admission 已拦截；防御性 no-op
  const { store } = runtime;
  const key = encodeReceiptKey(transactionId);
  if (settledAtOf(store, key) !== undefined) return; // 双保险：不重复叠加
  store.settled[key] = tick;
  store.entryCount += 1;
  store.updatedAt = tick;
}

interface CleanupAccumulator {
  retentionEvicted: number;
  corruptedEvicted: number;
}

/** 原地回收过期/损坏条目并同步 entryCount（只删 retention 之外与无语义值）。 */
function cleanupSettledEntries(store: TreasuryReceiptStore, nowTick: number): CleanupAccumulator {
  const acc: CleanupAccumulator = { retentionEvicted: 0, corruptedEvicted: 0 };
  let mutated = false;
  for (const key of Object.keys(store.settled)) {
    const settledAt = store.settled[key];
    const expired = typeof settledAt === "number" && settledAt < nowTick - TREASURY_RECEIPT_RETENTION_TICKS;
    const corrupted = typeof settledAt !== "number";
    if (!expired && !corrupted) continue;
    delete store.settled[key];
    store.entryCount -= 1;
    if (corrupted) acc.corruptedEvicted += 1;
    else acc.retentionEvicted += 1;
    mutated = true;
  }
  if (mutated) store.updatedAt = nowTick;
  return acc;
}

export interface TreasuryReceiptCleanupReport {
  retentionEvicted: number;
  corruptedEvicted: number;
  remaining: number;
  /** 未过期但超过硬容量的条数（绝不驱逐，显式报告供监控）。 */
  overLimit: number;
  /** fail-closed 时的有界诊断（null = 正常）。 */
  fatalDetail: string | null;
}

/**
 * 生命周期清理（beginTick 或满容 admission 触发）：只回收超过 retention
 * 窗口的 receipt（+ 无语义损坏值）；绝不因容量驱逐 retention 内条目。
 * fail-closed 状态下不动任何数据。
 */
export function cleanupTreasuryReceipts(nowTick: number): TreasuryReceiptCleanupReport {
  const runtime = loadReceiptStoreRuntime();
  if (runtime.fatal) {
    const remaining = Object.keys(runtime.store.settled ?? {}).length;
    return { retentionEvicted: 0, corruptedEvicted: 0, remaining, overLimit: 0, fatalDetail: runtime.fatal };
  }
  const { store } = runtime;
  const acc = cleanupSettledEntries(store, nowTick);
  return {
    retentionEvicted: acc.retentionEvicted,
    corruptedEvicted: acc.corruptedEvicted,
    remaining: store.entryCount,
    overLimit: Math.max(0, store.entryCount - TREASURY_RECEIPT_MAX_ENTRIES),
    fatalDetail: null,
  };
}

export function writeTreasuryLifecycle(update: TreasuryLifecycleMemory): void {
  const branch = treasuryBranch();
  branch.lifecycle = { ...branch.lifecycle, ...update };
}

export function readTreasuryLifecycle(): TreasuryLifecycleMemory | undefined {
  return peekTreasuryLifecycle();
}

/** 仅供测试：清除 Treasury 持久状态（receipts + lifecycle）并失效 heap 缓存。 */
export function clearTreasuryPersistenceForTest(): void {
  const branch = (Memory.runtime as RuntimeMemoryWithTreasury | undefined)?.treasury;
  if (branch) {
    delete branch.receipts;
    delete branch.lifecycle;
  }
  heapStoreRuntime = null;
  receiptEvents.migrationsExecuted = 0;
  receiptEvents.incompatibleFailures = 0;
}

/** 校验 receipt 键与 transactionId 规范一致（诊断/测试用）。 */
export function isValidTreasuryReceiptKey(transactionId: string): boolean {
  return (
    typeof transactionId === "string" &&
    transactionId.length > 0 &&
    transactionId.length <= TREASURY_TRANSACTION_ID_MAX_LENGTH
  );
}
