/**
 * CPU Monitor v2 — types, config defaults, normalization, and runtime store.
 *
 * This module defines the canonical v2 schema for CPU monitoring and provides
 * the global store, history, EMA, summary, heap capture, and persistence helpers.
 * Profiler rewrite, main-loop integration, console commands, and telemetry
 * migration live in later tasks.
 */

import {
  CPU_PROFILER_MAX_HISTORY_LIMIT,
  CPU_PROFILER_MAX_SAMPLE_INTERVAL,
  CPU_PROFILER_MIN_HISTORY_LIMIT,
  CPU_PROFILER_MIN_SAMPLE_INTERVAL,
} from "@/runtime/cpuProfilerConfig";
import { getMemoryService } from "@/runtime/runtimeServices";

// ─── v2 Config ────────────────────────────────────────────────────────────────

/** Config stored under `Memory.cfg.cpuProfiler` (v2 fields added to existing shape). */
export interface CpuMonitorConfig {
  enabled: boolean;
  sampleInterval: number;
  historyLimit: number;
  emaAlpha: number;
  roomRoleAggregation: boolean;
  heapStats: boolean;
  fixedActionCpuCost: number;
}

export const CPU_MONITOR_DEFAULTS: Readonly<CpuMonitorConfig> = {
  enabled: false,
  sampleInterval: 10,
  historyLimit: 120,
  emaAlpha: 0.1,
  roomRoleAggregation: true,
  heapStats: true,
  fixedActionCpuCost: 0.2,
} as const;

// ─── v2 Snapshot types ────────────────────────────────────────────────────────

/** Per-tick snapshot stored in the v2 history ring buffer. */
export interface CpuMonitorSnapshotV2 {
  tick: number;
  shard: string;
  totalUsed: number;
  bucket: number;
  limit: number;
  tickLimit: number;
  phases: Record<string, number>;
  fixedActionCounts: Record<string, number>;
  untracked: number;
  /** EMA-smoothed total CPU (set by runtime, 0 until first sample). */
  emaTotalUsed: number;
  /** Per-room CPU breakdown (populated when roomRoleAggregation is enabled). */
  rooms: Record<string, CpuMonitorRoomSummary>;
  /** Heap snapshot (populated when heapStats is enabled and available). */
  heap: CpuMonitorHeapSnapshot | null;
}

/** Per-room CPU summary within a tick snapshot. */
export interface CpuMonitorRoomSummary {
  totalUsed: number;
  roles: Record<string, CpuMonitorRoleSummary>;
}

/** Per-role CPU summary within a room. */
export interface CpuMonitorRoleSummary {
  count: number;
  used: number;
}

/** IVM heap statistics (nullable fields mirror Screeps API). */
export interface CpuMonitorHeapSnapshot {
  total_heap_size: number;
  total_heap_size_executable: number;
  total_physical_size: number;
  total_available_size: number;
  used_heap_size: number;
  heap_size_limit: number;
  malloced_memory: number;
  peak_malloced_memory: number;
  does_zap_garbage: number;
  externally_allocated_size: number;
}

// ─── v2 History entry (persisted to Memory.analytics.cpuMonitor) ──────────────

/** Single entry in the persisted history ring buffer. */
export interface CpuMonitorHistoryEntryV2 extends CpuMonitorSnapshotV2 {}

// ─── v2 Aggregated summary ────────────────────────────────────────────────────

/** Aggregated statistics computed over recent history. */
export interface CpuMonitorSummaryV2 {
  ticks: number;
  avgTotalUsed: number;
  maxTotalUsed: number;
  minBucket: number;
  maxBucket: number;
  avgBucket: number;
  avgUntracked: number;
  avgPhases: Record<string, number>;
  avgFixedActionCounts: Record<string, number>;
  emaTotalUsed: number;
}

// ─── v2 Memory schema ─────────────────────────────────────────────────────────

/**
 * Shape of `Memory.analytics.cpuMonitor` (v2 canonical).
 *
 * The legacy `Memory.analytics.moduleCpu` remains available during migration
 * and should NOT be removed by this task.
 */
export interface CpuMonitorMemoryV2 {
  version: 2;
  updatedAt: number;
  sampleInterval: number;
  historyLimit: number;
  latest: CpuMonitorSnapshotV2;
  summary: CpuMonitorSummaryV2 | null;
}

// ─── Raw config input type (read from Memory.cfg.cpuProfiler) ─────────────────

/** Loose user input shape — all fields optional. */
export interface CpuMonitorRawConfig {
  enabled?: boolean;
  sampleInterval?: number;
  historyLimit?: number;
  emaAlpha?: number;
  roomRoleAggregation?: boolean;
  heapStats?: boolean;
  fixedActionCpuCost?: number;
}

// ─── Config normalization ─────────────────────────────────────────────────────

/**
 * Normalize a single numeric field with fallback, floor, and clamp.
 * Returns `fallback` when value is non-finite or not a number.
 */
function normalizeNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const floored = Math.floor(value);
  return Math.max(min, Math.min(max, floored));
}

/**
 * Normalize the emaAlpha field: must be in (0, 1], default 0.1.
 * Non-finite, negative, or zero values fall back to default.
 */
function normalizeEmaAlpha(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return CPU_MONITOR_DEFAULTS.emaAlpha;
  }
  return Math.min(1, value);
}

/**
 * Normalize the fixedActionCpuCost field: must be non-negative finite, default 0.2.
 */
function normalizeFixedActionCpuCost(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return CPU_MONITOR_DEFAULTS.fixedActionCpuCost;
  }
  return value;
}

/**
 * Canonical config normalization — the single source of truth for
 * converting raw user config into a valid `CpuMonitorConfig`.
 *
 * Reuses the same min/max clamps as the existing CPU profiler config
 * for sampleInterval and historyLimit.
 */
export function normalizeCpuMonitorConfig(raw: CpuMonitorRawConfig | undefined | null): CpuMonitorConfig {
  if (!raw) {
    return { ...CPU_MONITOR_DEFAULTS };
  }

  return {
    enabled: raw.enabled === true,
    sampleInterval: normalizeNumber(
      raw.sampleInterval,
      CPU_PROFILER_MIN_SAMPLE_INTERVAL,
      CPU_PROFILER_MAX_SAMPLE_INTERVAL,
      CPU_MONITOR_DEFAULTS.sampleInterval,
    ),
    historyLimit: normalizeNumber(
      raw.historyLimit,
      CPU_PROFILER_MIN_HISTORY_LIMIT,
      CPU_PROFILER_MAX_HISTORY_LIMIT,
      CPU_MONITOR_DEFAULTS.historyLimit,
    ),
    emaAlpha: normalizeEmaAlpha(raw.emaAlpha),
    roomRoleAggregation: raw.roomRoleAggregation !== false,
    heapStats: raw.heapStats !== false,
    fixedActionCpuCost: normalizeFixedActionCpuCost(raw.fixedActionCpuCost),
  };
}

// ─── Global store ─────────────────────────────────────────────────────────────

/**
 * 增量滚动统计：push 时累加新样本贡献，淘汰旧样本时减去其贡献，
 * 避免 persist 时对完整 history 的 O(H×P) 重扫。窗口化的 max/min 无法
 * 增量维护，仅做一次 O(H) 数值遍历（不触及 phase map）。
 */
export interface CpuMonitorRollingSummary {
  ticks: number;
  sumTotalUsed: number;
  sumBucket: number;
  sumUntracked: number;
  phaseSums: Record<string, number>;
  fixedActionSums: Record<string, number>;
}

interface CpuMonitorGlobalStore {
  history: CpuMonitorSnapshotV2[];
  emaTotalUsed: number;
  seeded: boolean;
  rolling: CpuMonitorRollingSummary;
}

type GlobalWithCpuMonitor = typeof global & {
  __cpuMonitor?: CpuMonitorGlobalStore;
};

const cpuMonitorGlobal: GlobalWithCpuMonitor = global;

function createEmptyRollingSummary(): CpuMonitorRollingSummary {
  return {
    ticks: 0,
    sumTotalUsed: 0,
    sumBucket: 0,
    sumUntracked: 0,
    phaseSums: {},
    fixedActionSums: {},
  };
}

function applySnapshotToRollingSummary(
  rolling: CpuMonitorRollingSummary,
  snapshot: CpuMonitorSnapshotV2,
  direction: 1 | -1,
): void {
  rolling.ticks += direction;
  rolling.sumTotalUsed += direction * safeFinite(snapshot.totalUsed, 0);
  rolling.sumBucket += direction * safeFinite(snapshot.bucket, 0);
  rolling.sumUntracked += direction * safeFinite(snapshot.untracked, 0);
  const phaseSums = rolling.phaseSums;
  for (const [phase, used] of Object.entries(snapshot.phases)) {
    phaseSums[phase] = (phaseSums[phase] || 0) + direction * safeFinite(used, 0);
  }
  const fixedActionSums = rolling.fixedActionSums;
  for (const [action, count] of Object.entries(snapshot.fixedActionCounts)) {
    fixedActionSums[action] = (fixedActionSums[action] || 0) + direction * safeFinite(count, 0);
  }
}

function ensureCpuMonitorStore(): CpuMonitorGlobalStore {
  if (!cpuMonitorGlobal.__cpuMonitor) {
    cpuMonitorGlobal.__cpuMonitor = {
      history: [],
      emaTotalUsed: 0,
      seeded: false,
      rolling: createEmptyRollingSummary(),
    };
  }
  return cpuMonitorGlobal.__cpuMonitor;
}

export function getCpuMonitorHistory(): CpuMonitorSnapshotV2[] {
  return ensureCpuMonitorStore().history;
}

export function getCpuMonitorEma(): number {
  return ensureCpuMonitorStore().emaTotalUsed;
}

export function resetCpuMonitorStore(): void {
  cpuMonitorGlobal.__cpuMonitor = {
    history: [],
    emaTotalUsed: 0,
    seeded: false,
    rolling: createEmptyRollingSummary(),
  };
}

// ─── EMA helper ───────────────────────────────────────────────────────────────

function safeFinite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function computeEma(currentEma: number, newValue: number, alpha: number, seeded: boolean): number {
  const safeValue = safeFinite(newValue, 0);
  const safeAlpha = safeFinite(alpha, CPU_MONITOR_DEFAULTS.emaAlpha);
  if (!seeded) {
    return safeFinite(safeValue, 0);
  }
  const safeCurrent = safeFinite(currentEma, 0);
  return safeCurrent * (1 - safeAlpha) + safeValue * safeAlpha;
}

// ─── Heap capture ─────────────────────────────────────────────────────────────

export function captureCpuMonitorHeap(config: CpuMonitorConfig): CpuMonitorHeapSnapshot | null {
  if (!config.heapStats) {
    return null;
  }
  if (typeof Game.cpu.getHeapStatistics !== "function") {
    return null;
  }
  try {
    const stats = Game.cpu.getHeapStatistics();
    return {
      total_heap_size: safeFinite(stats.total_heap_size, 0),
      total_heap_size_executable: safeFinite(stats.total_heap_size_executable, 0),
      total_physical_size: safeFinite(stats.total_physical_size, 0),
      total_available_size: safeFinite(stats.total_available_size, 0),
      used_heap_size: safeFinite(stats.used_heap_size, 0),
      heap_size_limit: safeFinite(stats.heap_size_limit, 0),
      malloced_memory: safeFinite(stats.malloced_memory, 0),
      peak_malloced_memory: safeFinite(stats.peak_malloced_memory, 0),
      does_zap_garbage: safeFinite(stats.does_zap_garbage, 0),
      externally_allocated_size: safeFinite(stats.externally_allocated_size, 0),
    };
  } catch {
    return null;
  }
}

// ─── Summary calculations ─────────────────────────────────────────────────────

export function computeCpuMonitorSummary(history: CpuMonitorSnapshotV2[], emaTotalUsed: number): CpuMonitorSummaryV2 | null {
  if (history.length === 0) {
    return null;
  }

  let sumTotalUsed = 0;
  let maxTotalUsed = -Infinity;
  let sumBucket = 0;
  let minBucket = Infinity;
  let maxBucket = -Infinity;
  let sumUntracked = 0;
  const phaseSums: Record<string, number> = {};
  const fixedActionSums: Record<string, number> = {};

  for (const entry of history) {
    const total = safeFinite(entry.totalUsed, 0);
    const bucket = safeFinite(entry.bucket, 0);
    const untracked = safeFinite(entry.untracked, 0);

    sumTotalUsed += total;
    if (total > maxTotalUsed) maxTotalUsed = total;
    sumBucket += bucket;
    if (bucket < minBucket) minBucket = bucket;
    if (bucket > maxBucket) maxBucket = bucket;
    sumUntracked += untracked;

    for (const [phase, used] of Object.entries(entry.phases)) {
      phaseSums[phase] = (phaseSums[phase] || 0) + safeFinite(used, 0);
    }
    for (const [action, count] of Object.entries(entry.fixedActionCounts)) {
      fixedActionSums[action] = (fixedActionSums[action] || 0) + safeFinite(count, 0);
    }
  }

  const ticks = history.length;
  const avgPhases: Record<string, number> = {};
  for (const [phase, sum] of Object.entries(phaseSums)) {
    avgPhases[phase] = sum / ticks;
  }
  const avgFixedActionCounts: Record<string, number> = {};
  for (const [action, sum] of Object.entries(fixedActionSums)) {
    avgFixedActionCounts[action] = sum / ticks;
  }

  return {
    ticks,
    avgTotalUsed: sumTotalUsed / ticks,
    maxTotalUsed,
    minBucket,
    maxBucket,
    avgBucket: sumBucket / ticks,
    avgUntracked: sumUntracked / ticks,
    avgPhases,
    avgFixedActionCounts,
    emaTotalUsed: safeFinite(emaTotalUsed, 0),
  };
}

// ─── Sample persistence ───────────────────────────────────────────────────────

/**
 * 由滚动统计导出与 computeCpuMonitorSummary 等价的 summary。
 * 窗口化 max/min 做一次 O(H) 数值遍历；均值类字段全部来自增量累加。
 */
function buildRollingCpuMonitorSummary(
  history: CpuMonitorSnapshotV2[],
  rolling: CpuMonitorRollingSummary,
  emaTotalUsed: number,
): CpuMonitorSummaryV2 | null {
  if (rolling.ticks <= 0 || history.length === 0) {
    return null;
  }

  let maxTotalUsed = -Infinity;
  let minBucket = Infinity;
  let maxBucket = -Infinity;
  for (const entry of history) {
    const total = safeFinite(entry.totalUsed, 0);
    const bucket = safeFinite(entry.bucket, 0);
    if (total > maxTotalUsed) maxTotalUsed = total;
    if (bucket < minBucket) minBucket = bucket;
    if (bucket > maxBucket) maxBucket = bucket;
  }

  const ticks = rolling.ticks;
  const avgPhases: Record<string, number> = {};
  for (const [phase, sum] of Object.entries(rolling.phaseSums)) {
    // 贡献值非负：sum 为 0 说明该 phase 的样本已被全部淘汰，与批量版的键集保持一致。
    if (sum !== 0) {
      avgPhases[phase] = sum / ticks;
    }
  }
  const avgFixedActionCounts: Record<string, number> = {};
  for (const [action, sum] of Object.entries(rolling.fixedActionSums)) {
    if (sum !== 0) {
      avgFixedActionCounts[action] = sum / ticks;
    }
  }

  return {
    ticks,
    avgTotalUsed: rolling.sumTotalUsed / ticks,
    maxTotalUsed,
    minBucket,
    maxBucket,
    avgBucket: rolling.sumBucket / ticks,
    avgUntracked: rolling.sumUntracked / ticks,
    avgPhases,
    avgFixedActionCounts,
    emaTotalUsed: safeFinite(emaTotalUsed, 0),
  };
}

export function persistCpuMonitorSample(
  snapshot: CpuMonitorSnapshotV2,
  config: CpuMonitorConfig,
): void {
  const store = ensureCpuMonitorStore();

  store.emaTotalUsed = computeEma(store.emaTotalUsed, snapshot.totalUsed, config.emaAlpha, store.seeded);
  store.seeded = true;

  snapshot.emaTotalUsed = store.emaTotalUsed;

  store.history.push(snapshot);
  applySnapshotToRollingSummary(store.rolling, snapshot, 1);
  while (store.history.length > config.historyLimit) {
    const evicted = store.history.shift();
    if (evicted) {
      applySnapshotToRollingSummary(store.rolling, evicted, -1);
    }
  }

  const analytics = getMemoryService().ensureAnalytics();
  const summary = buildRollingCpuMonitorSummary(store.history, store.rolling, store.emaTotalUsed);

  analytics.cpuMonitor = {
    version: 2,
    updatedAt: snapshot.tick,
    sampleInterval: config.sampleInterval,
    historyLimit: config.historyLimit,
    latest: snapshot,
    summary,
  };
}
