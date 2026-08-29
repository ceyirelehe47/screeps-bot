/**
 * Treasury 幂等 receipt 与生命周期持久化（Memory 最小状态）。
 *
 * 边界约束：
 * - 只保存最小 receipt（transactionId → 结算 tick）与生命周期标记，
 *   绝不持久化 overlay、observation、journal 或完整物理事实；
 * - receipt 权威跨 global reset 存活：heap 缓存丢失后凭 Memory receipt
 *   恢复幂等判断；
 * - retention/cap 双重清理规则：
 *   * retention：结算 tick 早于 now - RETENTION_TICKS 的 receipt 回收；
 *   * cap：超过 MAX_ENTRIES 时按结算 tick 从老到新驱逐；
 *   * 保护：驱逐遇到当前 tick 的 receipt 立即停止（洪峰下宁可超额，
 *     绝不让本 tick 内已结算的 id 被提前淘汰后重放）。
 * - version 字段为格式兼容锚点：未来格式变更必须先迁移再升级。
 */

import { TREASURY_TRANSACTION_ID_MAX_LENGTH } from "@/runtime/treasury/transactionId";

export const TREASURY_RECEIPT_RETENTION_TICKS = 5_000;
export const TREASURY_RECEIPT_MAX_ENTRIES = 4_096;
export const TREASURY_RECEIPT_VERSION = 1 as const;

export interface TreasuryReceiptStore {
  version: typeof TREASURY_RECEIPT_VERSION;
  settled: Record<string, number>;
  updatedAt: number;
}

export interface TreasuryLifecycleMemory {
  lastBeginTick?: number;
  lastEndTick?: number;
}

interface TreasuryMemoryBranch {
  receipts?: TreasuryReceiptStore;
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

/** 读取（不创建）：查询侧零写路径使用。 */
export function peekTreasuryReceiptStore(): TreasuryReceiptStore | undefined {
  const branch = (Memory.runtime as RuntimeMemoryWithTreasury | undefined)?.treasury;
  return branch?.receipts;
}

export function peekTreasuryLifecycle(): TreasuryLifecycleMemory | undefined {
  const branch = (Memory.runtime as RuntimeMemoryWithTreasury | undefined)?.treasury;
  return branch?.lifecycle;
}

/** 登记/幂等路径使用：确保 store 存在（登记路径允许写 Memory）。 */
export function ensureTreasuryReceiptStore(): TreasuryReceiptStore {
  const branch = treasuryBranch();
  if (!branch.receipts || branch.receipts.version !== TREASURY_RECEIPT_VERSION) {
    // 版本不兼容：丢弃旧 receipt 重建（幂等保护退化为冷启动，显式可审计）。
    branch.receipts = { version: TREASURY_RECEIPT_VERSION, settled: {}, updatedAt: Game.time };
  }
  return branch.receipts;
}

export function hasSettledReceipt(transactionId: string): number | undefined {
  const settledAt = peekTreasuryReceiptStore()?.settled[transactionId];
  return typeof settledAt === "number" ? settledAt : undefined;
}

export function recordSettledReceipt(transactionId: string, tick: number): void {
  const store = ensureTreasuryReceiptStore();
  store.settled[transactionId] = tick;
  store.updatedAt = tick;
}

export interface TreasuryReceiptCleanupReport {
  retentionEvicted: number;
  capEvicted: number;
  evictionsBlocked: number;
  remaining: number;
}

/**
 * 清理过期/超额 receipt。必须在 beginTick（tick 起点而非登记路径）调用，
 * 保证清理期间不会误伤同 tick 即将重放的 id。
 */
export function cleanupTreasuryReceipts(nowTick: number): TreasuryReceiptCleanupReport {
  const store = peekTreasuryReceiptStore();
  if (!store) {
    return { retentionEvicted: 0, capEvicted: 0, evictionsBlocked: 0, remaining: 0 };
  }

  const entries = Object.entries(store.settled);
  if (entries.length === 0) {
    return { retentionEvicted: 0, capEvicted: 0, evictionsBlocked: 0, remaining: 0 };
  }

  let retentionEvicted = 0;
  const survivors: Array<[string, number]> = [];
  for (const [transactionId, settledAt] of entries) {
    if (typeof settledAt === "number" && settledAt < nowTick - TREASURY_RECEIPT_RETENTION_TICKS) {
      delete store.settled[transactionId];
      retentionEvicted += 1;
    } else {
      survivors.push([transactionId, settledAt]);
    }
  }

  let capEvicted = 0;
  let evictionsBlocked = 0;
  if (survivors.length > TREASURY_RECEIPT_MAX_ENTRIES) {
    survivors.sort((left, right) => left[1] - right[1]);
    let excess = survivors.length - TREASURY_RECEIPT_MAX_ENTRIES;
    for (const [transactionId, settledAt] of survivors) {
      if (excess <= 0) break;
      if (settledAt >= nowTick) {
        // 当前 tick 的 receipt 绝不驱逐——宁超上限，不破坏本 tick 幂等。
        evictionsBlocked = excess;
        break;
      }
      delete store.settled[transactionId];
      capEvicted += 1;
      excess -= 1;
    }
  }

  if (retentionEvicted > 0 || capEvicted > 0) {
    store.updatedAt = nowTick;
  }
  return {
    retentionEvicted,
    capEvicted,
    evictionsBlocked,
    remaining: Object.keys(store.settled).length,
  };
}

export function writeTreasuryLifecycle(update: TreasuryLifecycleMemory): void {
  const branch = treasuryBranch();
  branch.lifecycle = { ...branch.lifecycle, ...update };
}

export function readTreasuryLifecycle(): TreasuryLifecycleMemory | undefined {
  return peekTreasuryLifecycle();
}

/** 仅供测试：清除 Treasury 持久状态（receipts + lifecycle）。 */
export function clearTreasuryPersistenceForTest(): void {
  const branch = (Memory.runtime as RuntimeMemoryWithTreasury | undefined)?.treasury;
  if (branch) {
    delete branch.receipts;
    delete branch.lifecycle;
  }
}

/** 校验 receipt 键与 transactionId 规范一致（诊断/测试用）。 */
export function isValidTreasuryReceiptKey(transactionId: string): boolean {
  return (
    typeof transactionId === "string" &&
    transactionId.length > 0 &&
    transactionId.length <= TREASURY_TRANSACTION_ID_MAX_LENGTH
  );
}
