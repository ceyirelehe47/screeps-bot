/**
 * Treasury durable quarantine（第六轮）——executing / commit-faulted
 * transaction 的跨 tick 持久隔离。
 *
 * 语义（不变量）：
 * - Game 结果未知（endTick 时 executing）或 commit 写故障（faulted）的
 *   prepared transaction 在 tick 边界**不得**按普通 prepared 释放——先落
 *   durable quarantine（Memory 持久，跨 global reset 与 service 重建存活），
 *   再清理 heap tentative（占用由持久 quarantine 接替）；
 * - quarantine 继续占用资源、容量与 transaction identity：授权计算计入其
 *   流出量（facade.query / projectedFreeCapacity），同一 transactionId 在
 *   quarantine 未解决前不得再次 prepare（transaction_quarantined）；
 * - quarantine 不进入 committed projection（不写 journal/overlay/receipt）；
 * - 有界：条目上限 TREASURY_QUARANTINE_MAX_ENTRIES；溢出置持久 overflowed
 *   标志（authorizationSafe 永久 fail closed 直至显式 resolution 清理）；
 * - 全局 write-admission lock（writeFault marker）继续使用，但 quarantine
 *   独立存活——管理路径误删 marker 不丢失占用事实；
 * - 解除只有显式 fault resolution（faultResolution.ts）：resolve-as-
 *   committed（补 receipt 后释放）或 resolve-as-not-executed（证据允许时
 *   释放）；本模块不提供任何无条件清空入口（clearTreasuryPersistenceForTest
 *   仅测试）。
 */

/** 单条 quarantine 的占用快照（合并腿；有界——prepare 验证过的 merged postings）。 */
export interface TreasuryQuarantineDeltas {
  readonly roomName: string;
  readonly locationKind: string;
  readonly resource: string;
  readonly delta: number;
}

export interface TreasuryQuarantineEntry {
  readonly transactionId: string;
  readonly digest: string;
  /** quarantine 建立时所处 tick（prepared/故障发生 tick）。 */
  readonly tick: number;
  readonly kind: string;
  readonly source: string;
  readonly phase: string;
  /** 资源占用（正=预期流入、负=流出占用；授权只按流出保守计入）。 */
  readonly resourceDeltas: readonly TreasuryQuarantineDeltas[];
  /** 容量占用（负值占用容量）。 */
  readonly capacityDeltas: readonly TreasuryQuarantineDeltas[];
  readonly recordedAt: number;
}

export interface TreasuryQuarantineStore {
  /** key = "q:"+transactionId（防 "__proto__" 等危险字面量的原型污染语义）。 */
  entries: Record<string, TreasuryQuarantineEntry>;
  /** 条目超限后置位（持久；authorizationSafe fail closed 直至 resolution 清理）。 */
  overflowed?: boolean;
}

export const TREASURY_QUARANTINE_MAX_ENTRIES = 64;

const QUARANTINE_KEY_PREFIX = "q:";

interface TreasuryQuarantineBranch {
  quarantine?: TreasuryQuarantineStore;
}

type RuntimeMemoryWithQuarantine = NonNullable<Memory["runtime"]> & {
  treasury?: TreasuryQuarantineBranch;
};

function quarantineStoreBranch(): TreasuryQuarantineStore {
  if (!Memory.runtime) Memory.runtime = {};
  const runtime = Memory.runtime as unknown as RuntimeMemoryWithQuarantine;
  if (!runtime.treasury) runtime.treasury = {};
  if (!runtime.treasury.quarantine) runtime.treasury.quarantine = { entries: {} };
  return runtime.treasury.quarantine;
}

/** 只读读取（查询/门禁路径零写）。 */
export function peekTreasuryQuarantineStore(): TreasuryQuarantineStore | undefined {
  return (Memory.runtime as unknown as RuntimeMemoryWithQuarantine | undefined)?.treasury?.quarantine;
}

function encodeQuarantineKey(transactionId: string): string {
  return QUARANTINE_KEY_PREFIX + transactionId;
}

/** 单条只读查询（O(1)；prepare 门禁用）。 */
export function readTreasuryQuarantineEntry(transactionId: string): TreasuryQuarantineEntry | undefined {
  const store = peekTreasuryQuarantineStore();
  if (!store) return undefined;
  return store.entries[encodeQuarantineKey(transactionId)] as TreasuryQuarantineEntry | undefined;
}

export function isTreasuryTransactionQuarantined(transactionId: string): boolean {
  return readTreasuryQuarantineEntry(transactionId) !== undefined;
}

/**
 * 写入 durable quarantine（tick 边界 executing/faulted 分类路径专用）。
 * 同 id 重复写入幂等保留首条（根因快照语义与 write-fault marker 一致）；
 * 条目超上限时保留前 MAX 条并置 overflowed（占用事实绝不丢失，授权侧
 * 永久 fail closed 直至显式 resolution）。
 */
export function quarantineTreasuryTransaction(entry: TreasuryQuarantineEntry): void {
  const store = quarantineStoreBranch();
  const key = encodeQuarantineKey(entry.transactionId);
  if (Object.prototype.hasOwnProperty.call(store.entries, key)) return;
  if (Object.keys(store.entries).length >= TREASURY_QUARANTINE_MAX_ENTRIES) {
    store.overflowed = true;
    return;
  }
  store.entries[key] = entry;
}

/** 显式 resolution 路径：释放单条 quarantine（返回是否确有条目被释放）。 */
export function releaseTreasuryQuarantineEntry(transactionId: string): boolean {
  const store = peekTreasuryQuarantineStore();
  if (!store) return false;
  const key = encodeQuarantineKey(transactionId);
  if (!Object.prototype.hasOwnProperty.call(store.entries, key)) return false;
  delete store.entries[key];
  return true;
}

/** 全部条目（诊断/resolution 枚举；顺序为插入序）。 */
export function listTreasuryQuarantineEntries(): TreasuryQuarantineEntry[] {
  const store = peekTreasuryQuarantineStore();
  if (!store) return [];
  return Object.values(store.entries) as TreasuryQuarantineEntry[];
}

/**
 * 授权阻断状态（authorizationSafe 的 quarantine 条件；只读零写）：
 * blocking = 存在任一未解决条目或 overflowed 标志。
 */
export function treasuryQuarantineBlockers(): {
  readonly blocking: boolean;
  readonly unresolvedCount: number;
  readonly overflowed: boolean;
} {
  const store = peekTreasuryQuarantineStore();
  if (!store) return { blocking: false, unresolvedCount: 0, overflowed: false };
  const unresolvedCount = Object.keys(store.entries).length;
  return {
    blocking: unresolvedCount > 0 || store.overflowed === true,
    unresolvedCount,
    overflowed: store.overflowed === true,
  };
}

/**
 * quarantine 的授权占用聚合（只读）：(room,location,resource) → 净 delta。
 * 只统计负 delta（流出占用——保守口径：可能已执行的动作占用的资源不得
 * 再授权他人；正流入不乐观计入 spendable）。
 */
export function treasuryQuarantineOutflowTotals(): Map<string, number> {
  const totals = new Map<string, number>();
  for (const entry of listTreasuryQuarantineEntries()) {
    if (!Array.isArray(entry.resourceDeltas)) continue;
    for (const delta of entry.resourceDeltas) {
      if (!delta || typeof delta !== "object") continue;
      if (typeof delta.delta !== "number" || delta.delta >= 0) continue;
      const key = `${String(delta.roomName)}\u0000${String(delta.locationKind)}\u0000${String(delta.resource)}`;
      totals.set(key, (totals.get(key) ?? 0) + delta.delta);
    }
  }
  return totals;
}

/** quarantine 的容量占用（只读）：locationKey → 净容量 delta（负值占用）。 */
export function treasuryQuarantineCapacityTotals(): Map<string, number> {
  const totals = new Map<string, number>();
  for (const entry of listTreasuryQuarantineEntries()) {
    if (!Array.isArray(entry.capacityDeltas)) continue;
    for (const delta of entry.capacityDeltas) {
      if (!delta || typeof delta !== "object") continue;
      if (typeof delta.delta !== "number") continue;
      const key = `${String(delta.roomName)}\u0000${String(delta.locationKind)}`;
      totals.set(key, (totals.get(key) ?? 0) + delta.delta);
    }
  }
  return totals;
}
