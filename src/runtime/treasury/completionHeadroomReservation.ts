/**
 * 【Round 22 Remediation VII 修复二】cleanup completion headroom 的持久
 * 独占 reservation——"检查当前还有一个槽"不是 reservation。
 *
 * Remediation VI 在 authorize / prepare / callback 前三处重复读取
 * entryCount < MAX：检查之间其它 transaction 可以占用最后一个槽；且
 * execute 的最终检查发生在 durable Intent 写入、capability 消费、
 * child_active 推进**之后**——最终检查失败时 callback 确实为零，却留下
 * executing Intent（下一 tick 按 execution-unknown 转 quarantine）甚至已
 * 永久消费的 rearm capability。
 *
 * 本模块建立真正的 reservation 语义（推荐顺序：authorize 预检 → prepare
 * 获取独占 reservation → execute 验证并绑定最终 exact identity →
 * callback → completion publication 消费）：
 *
 * - prepare 成功返回前 acquire 写入 Memory + read-back（幂等：同
 *   transactionId 重复 acquire 返回同一 reservation，不重复计数）；
 * - live completion + reserved slots ≤ completion 硬容量 恒成立（acquire
 *   时以调用方传入的 completion entry count 判定——模块不反向依赖
 *   completion authority，避免环）；
 * - execute 在 durable Intent 写入之前 verify + bind 最终 durable
 *   identity digest（final admission 前移：reservation 缺失/失效/冲突/
 *   store unhealthy → callback 零调用、零 Intent、零消费、零推进）；
 * - 释放只允许两种前提：callback 确定未开始（abort/expired/拒绝路径/
 *   TTL 且无 durable intent），或 completion authority 已成功接管
 *   （consume）；execution-unknown / quarantine 接管的 reservation 保留
 *   至 resolution cleanup 完成；
 * - global reset 后从 Memory 恢复（heap 缓存与 Memory 权威同对象；store
 *   不存在 = 健康空，未知版本/损坏 fail closed）。
 */

import { registerTreasuryResolutionCleanupResetHook } from "@/runtime/treasury/receipts";
import { cloneTreasuryDurableValue } from "@/runtime/treasury/durableClone";
import { readTreasuryIntentEntry } from "@/runtime/treasury/intents";
import { readTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";

export const TREASURY_COMPLETION_RESERVATION_VERSION = 1;
/**
 * TTL：reserved 后 callback 确定未开始且无 durable intent 的 reservation
 * 的兜底回收窗口（handle 为 heap 权威——global reset 后必然消失；正常
 * 路径由显式 release/consume 关闭，TTL 只兜泄漏）。
 */
export const TREASURY_COMPLETION_RESERVATION_TTL_TICKS = 1_000;
const RESERVATION_KEY_PREFIX = "hr:";
const RESERVATION_DIGEST_PATTERN = /^[0-9a-f]{16}$/;

export interface TreasuryCompletionHeadroomReservationEntry {
  readonly transactionId: string;
  readonly reservedAtTick: number;
  /** execute final admission 绑定的最终 durable identity digest。 */
  readonly boundIdentityDigest?: string;
}

export interface TreasuryCompletionHeadroomReservationStore {
  readonly version: typeof TREASURY_COMPLETION_RESERVATION_VERSION;
  entries: Record<string, TreasuryCompletionHeadroomReservationEntry>;
  entryCount: number;
  updatedAt: number;
}

interface TreasuryMemoryBranchWithReservations {
  completionHeadroomReservations?: TreasuryCompletionHeadroomReservationStore;
}

type RuntimeMemoryWithReservations = NonNullable<Memory["runtime"]> & {
  treasury?: TreasuryMemoryBranchWithReservations;
};

interface ReservationRuntime {
  store: TreasuryCompletionHeadroomReservationStore;
  fatal: string | null;
}

let heapRuntime: ReservationRuntime | null = null;

registerTreasuryResolutionCleanupResetHook(() => {
  heapRuntime = null;
});

function reservationBranch(): TreasuryMemoryBranchWithReservations {
  if (!Memory.runtime) Memory.runtime = {};
  const runtime = Memory.runtime as unknown as RuntimeMemoryWithReservations;
  if (!runtime.treasury) runtime.treasury = {};
  return runtime.treasury;
}

function validateReservationEntryShape(entry: unknown, key: string): string | null {
  if (!entry || typeof entry !== "object") return `headroom reservation ${key.slice(0, 11)} 非对象`;
  const candidate = entry as Partial<TreasuryCompletionHeadroomReservationEntry>;
  if (typeof candidate.transactionId !== "string" || candidate.transactionId.length === 0) {
    return `headroom reservation ${key.slice(0, 11)} transactionId 非法`;
  }
  if (key !== RESERVATION_KEY_PREFIX + candidate.transactionId) {
    return `headroom reservation ${key.slice(0, 11)} 键与 transactionId 不一致`;
  }
  if (!Number.isSafeInteger(candidate.reservedAtTick) || (candidate.reservedAtTick as number) < 0) {
    return `headroom reservation ${key.slice(0, 11)} reservedAtTick 非法`;
  }
  if (
    candidate.boundIdentityDigest !== undefined &&
    (typeof candidate.boundIdentityDigest !== "string" || !RESERVATION_DIGEST_PATTERN.test(candidate.boundIdentityDigest))
  ) {
    return `headroom reservation ${key.slice(0, 11)} boundIdentityDigest 非法（须 16 小写 hex）`;
  }
  return null;
}

function validateReservationStoreShape(store: unknown): string | null {
  if (!store || typeof store !== "object") return "headroom reservation store 非对象";
  const candidate = store as Partial<TreasuryCompletionHeadroomReservationStore>;
  if (candidate.version !== TREASURY_COMPLETION_RESERVATION_VERSION) {
    return `headroom reservation store 版本非法: ${String(candidate.version).slice(0, 16)}`;
  }
  if (!candidate.entries || typeof candidate.entries !== "object") return "headroom reservation store entries 非对象";
  const proto = Object.getPrototypeOf(candidate.entries);
  if (proto !== Object.prototype && proto !== null) return "headroom reservation store entries 原型非普通对象";
  const keys = Object.keys(candidate.entries);
  for (const key of keys) {
    if (key === "__proto__" || !key.startsWith(RESERVATION_KEY_PREFIX)) {
      return `headroom reservation store 键 ${key.slice(0, 11)} 缺少前缀`;
    }
    const error = validateReservationEntryShape(candidate.entries[key], key);
    if (error !== null) return error;
  }
  if (candidate.entryCount !== keys.length) {
    return `headroom reservation store entryCount ${String(candidate.entryCount)} != ${String(keys.length)}`;
  }
  return null;
}

function loadReservationRuntime(): ReservationRuntime {
  if (heapRuntime !== null) return heapRuntime;
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithReservations | undefined)?.treasury?.completionHeadroomReservations;
  if (raw === undefined) {
    const store: TreasuryCompletionHeadroomReservationStore = {
      version: TREASURY_COMPLETION_RESERVATION_VERSION,
      entries: {},
      entryCount: 0,
      updatedAt: Game.time,
    };
    reservationBranch().completionHeadroomReservations = store;
    heapRuntime = { store, fatal: null };
    return heapRuntime;
  }
  const shapeError = validateReservationStoreShape(raw);
  heapRuntime = { store: raw as unknown as TreasuryCompletionHeadroomReservationStore, fatal: shapeError };
  return heapRuntime;
}

export interface TreasuryCompletionHeadroomReservationHealth {
  readonly healthy: boolean;
  readonly detail: string | null;
}

/** 只读健康探测（store 不存在 = 健康空；损坏 → unhealthy）。 */
export function peekTreasuryCompletionHeadroomReservationHealth(): TreasuryCompletionHeadroomReservationHealth {
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithReservations | undefined)?.treasury?.completionHeadroomReservations;
  if (raw === undefined) return { healthy: true, detail: null };
  const shapeError = validateReservationStoreShape(raw);
  return shapeError === null ? { healthy: true, detail: null } : { healthy: false, detail: shapeError };
}

/** 当前 reservation 数（O(1) 计数权威——ensureHeadroom/容量判定计入占用）。 */
export function peekTreasuryCompletionHeadroomReservationCount(): number {
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithReservations | undefined)?.treasury?.completionHeadroomReservations;
  if (raw === undefined) return 0;
  const keys = raw && typeof raw === "object" ? Object.keys(raw.entries ?? {}) : [];
  return keys.length;
}

export type TreasuryCompletionHeadroomReservationAcquireResult =
  | { readonly status: "acquired" }
  | { readonly status: "already_reserved" }
  | { readonly status: "rejected"; readonly reason: "capacity_exhausted" | "store_unhealthy"; readonly detail: string };

/**
 * 独占 reservation 获取（prepare 成功返回前调用；幂等——同 transactionId
 * 返回同一 reservation，不重复计数、不重复占槽）。容量不变量：
 * completionEntryCount + reservationCount < completion 硬容量（调用方传入
 * completion 计数——本模块不反向依赖 completion authority）。
 */
export function acquireTreasuryCompletionHeadroomReservation(input: {
  readonly transactionId: string;
  readonly completionEntryCount: number;
  readonly completionHardCapacity: number;
}): TreasuryCompletionHeadroomReservationAcquireResult {
  const runtime = loadReservationRuntime();
  if (runtime.fatal !== null) {
    return { status: "rejected", reason: "store_unhealthy", detail: `headroom reservation store fail-closed: ${runtime.fatal}` };
  }
  const key = RESERVATION_KEY_PREFIX + input.transactionId;
  if (runtime.store.entries[key] !== undefined) {
    const existing = runtime.store.entries[key];
    const shapeError = validateReservationEntryShape(existing, key);
    if (shapeError !== null) {
      return { status: "rejected", reason: "store_unhealthy", detail: `既有 reservation 损坏: ${shapeError}` };
    }
    return { status: "already_reserved" };
  }
  if (input.completionEntryCount < 0) {
    return { status: "rejected", reason: "store_unhealthy", detail: "completion entry count 不可读（fail closed）" };
  }
  if (input.completionEntryCount + runtime.store.entryCount >= input.completionHardCapacity) {
    return {
      status: "rejected",
      reason: "capacity_exhausted",
      detail: `live completion ${String(input.completionEntryCount)} + reserved ${String(runtime.store.entryCount)} ≥ ${String(input.completionHardCapacity)}（独占 reservation 不可得——fail closed）`,
    };
  }
  const candidate: TreasuryCompletionHeadroomReservationEntry = cloneTreasuryDurableValue({
    transactionId: input.transactionId,
    reservedAtTick: Game.time,
  });
  runtime.store.entries[key] = candidate;
  runtime.store.entryCount += 1;
  runtime.store.updatedAt = Game.time;
  const rawStore = (Memory.runtime as unknown as RuntimeMemoryWithReservations | undefined)?.treasury?.completionHeadroomReservations;
  if (rawStore === undefined) {
    delete runtime.store.entries[key];
    runtime.store.entryCount -= 1;
    return { status: "rejected", reason: "store_unhealthy", detail: "reservation 写入后 Memory read-back store 缺失（已回滚）" };
  }
  const readBack = rawStore.entries[key];
  const readBackError = readBack === undefined ? "read-back entry 缺失" : validateReservationEntryShape(readBack, key);
  if (readBackError !== null || readBack.transactionId !== input.transactionId) {
    delete runtime.store.entries[key];
    runtime.store.entryCount -= 1;
    runtime.store.updatedAt = Game.time;
    return { status: "rejected", reason: "store_unhealthy", detail: `reservation read-back 失败: ${readBackError ?? "transactionId 不一致"}（已回滚）` };
  }
  return { status: "acquired" };
}

export type TreasuryCompletionHeadroomAdmissionResult =
  | { readonly status: "ok" }
  | { readonly status: "rejected"; readonly reason: "reservation_missing" | "identity_mismatch" | "store_unhealthy"; readonly detail: string };

/**
 * execute 的 final admission（durable Intent 写入 / executing 迁移 /
 * capability 消费 / child_active / Game callback 之前）：reservation 必须
 * 在位且与最终 durable identity digest 绑定一致。失败 → callback 零调用、
 * 零 Intent、零消费、零推进（调用方释放全部预留）。持有合法 reservation
 * 的 transaction 不受其它状态变化（普通 headroom 计数波动）影响。
 */
export function admitTreasuryCompletionHeadroomReservationForExecution(input: {
  readonly transactionId: string;
  readonly durableIdentityDigest: string;
}): TreasuryCompletionHeadroomAdmissionResult {
  const runtime = loadReservationRuntime();
  if (runtime.fatal !== null) {
    return { status: "rejected", reason: "store_unhealthy", detail: `headroom reservation store fail-closed: ${runtime.fatal}` };
  }
  if (!RESERVATION_DIGEST_PATTERN.test(input.durableIdentityDigest)) {
    return { status: "rejected", reason: "store_unhealthy", detail: "durable identity digest 非法（16 小写 hex）——final admission 拒绝" };
  }
  const key = RESERVATION_KEY_PREFIX + input.transactionId;
  const entry = runtime.store.entries[key];
  if (entry === undefined) {
    return {
      status: "rejected",
      reason: "reservation_missing",
      detail: `transactionId ${input.transactionId.slice(0, 24)} 无独占 completion headroom reservation（prepare 后被 GC/损坏——不得执行 Game callback）`,
    };
  }
  const shapeError = validateReservationEntryShape(entry, key);
  if (shapeError !== null) {
    return { status: "rejected", reason: "store_unhealthy", detail: `reservation 损坏: ${shapeError}` };
  }
  if (entry.boundIdentityDigest === undefined) {
    // 首次 admission：绑定最终 durable identity digest + read-back。
    const bound: TreasuryCompletionHeadroomReservationEntry = cloneTreasuryDurableValue({
      transactionId: entry.transactionId,
      reservedAtTick: entry.reservedAtTick,
      boundIdentityDigest: input.durableIdentityDigest,
    });
    runtime.store.entries[key] = bound;
    runtime.store.updatedAt = Game.time;
    const rawStore = (Memory.runtime as unknown as RuntimeMemoryWithReservations | undefined)?.treasury?.completionHeadroomReservations;
    const readBack = rawStore?.entries[key];
    if (rawStore === undefined || readBack === undefined || readBack.boundIdentityDigest !== input.durableIdentityDigest) {
      runtime.store.entries[key] = cloneTreasuryDurableValue(entry);
      runtime.store.updatedAt = Game.time;
      return { status: "rejected", reason: "store_unhealthy", detail: "reservation identity 绑定 read-back 失败（已回滚——fail closed）" };
    }
    return { status: "ok" };
  }
  if (entry.boundIdentityDigest !== input.durableIdentityDigest) {
    return {
      status: "rejected",
      reason: "identity_mismatch",
      detail: `reservation 已绑定不同 durable identity（${entry.boundIdentityDigest.slice(0, 8)} vs ${input.durableIdentityDigest.slice(0, 8)}——同 ID 不同 identity，不得执行）`,
    };
  }
  return { status: "ok" };
}

/**
 * completion publication 消费 reservation（completion 写入成功后的释放
 * 形态——live entry 已占用容量槽，reservation 必须同时移除，否则双重
 * 计数）。幂等（absent 无害）。
 */
export function consumeTreasuryCompletionHeadroomReservation(transactionId: string): void {
  releaseEntry(transactionId);
}

/**
 * 显式释放（callback 确定未开始的拒绝/abort/expired 路径）。幂等。
 * execution-unknown / quarantine 接管的路径**不得**调用本函数（reservation
 * 保留至 resolution cleanup 完成）。
 */
export function releaseTreasuryCompletionHeadroomReservation(transactionId: string): void {
  releaseEntry(transactionId);
}

function releaseEntry(transactionId: string): void {
  const runtime = loadReservationRuntime();
  if (runtime.fatal !== null) return;
  const key = RESERVATION_KEY_PREFIX + transactionId;
  if (runtime.store.entries[key] === undefined) return;
  delete runtime.store.entries[key];
  runtime.store.entryCount -= 1;
  runtime.store.updatedAt = Game.time;
}

/**
 * TTL 兜底回收（beginTick 调用；有界 ≤ reservation 数）：reservedAtTick +
 * TTL < Game.time 且无 durable intent / quarantine（callback 可能已开始的
 * 持久信号——intent 释放转 quarantine 后由 quarantine 承载）且非 heap
 * active handle 的 reservation 才释放——execution-unknown 路径保留至
 * resolution cleanup 完成。
 */
export function sweepExpiredTreasuryCompletionHeadroomReservations(
  activeTransactionIds: ReadonlySet<string>,
): number {
  const runtime = loadReservationRuntime();
  if (runtime.fatal !== null) return 0;
  let released = 0;
  for (const [key, entry] of Object.entries(runtime.store.entries)) {
    if (Game.time - entry.reservedAtTick <= TREASURY_COMPLETION_RESERVATION_TTL_TICKS) continue;
    if (activeTransactionIds.has(entry.transactionId)) continue;
    if (readTreasuryIntentEntry(entry.transactionId) !== undefined) continue;
    if (readTreasuryQuarantineEntry(entry.transactionId) !== undefined) continue;
    delete runtime.store.entries[key];
    released += 1;
  }
  if (released > 0) {
    runtime.store.entryCount -= released;
    runtime.store.updatedAt = Game.time;
  }
  return released;
}

/** test-only：删除 Memory 中的 reservation store（heap 一并失效）。 */
export function clearTreasuryCompletionHeadroomReservationDurableForTest(): void {
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithReservations | undefined)?.treasury;
  if (branch !== undefined) delete branch.completionHeadroomReservations;
  heapRuntime = null;
}

/** test-only：只清 heap 缓存（模拟 global reset 后从 Memory 恢复）。 */
export function resetTreasuryCompletionHeadroomReservationHeapCacheForTest(): void {
  heapRuntime = null;
}

/** 【诊断/测试】读取单条 reservation（只读快照）。 */
export function peekTreasuryCompletionHeadroomReservation(
  transactionId: string,
): TreasuryCompletionHeadroomReservationEntry | undefined {
  const raw = (Memory.runtime as unknown as RuntimeMemoryWithReservations | undefined)?.treasury?.completionHeadroomReservations;
  if (raw === undefined) return undefined;
  const entry = raw.entries[RESERVATION_KEY_PREFIX + transactionId];
  if (entry === undefined) return undefined;
  const shapeError = validateReservationEntryShape(entry, RESERVATION_KEY_PREFIX + transactionId);
  return shapeError === null ? entry : undefined;
}
