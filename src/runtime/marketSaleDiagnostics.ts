/**
 * 市场子 phase 临时诊断（提交 A：先测量后优化）。
 *
 * 目的：在不改变任何行为的前提下，短时（默认 200 tick 窗口）细分
 * marketSalePreflight / marketSaleAutomation 内部的真实 CPU 分布，
 * 为 MarketTickSession / ensureDataState 分层 / protection 缓存提供依据。
 *
 * 开关：Memory.cfg.marketSaleDiagnostics = { enabled: true, windowTicks?: N }。
 * - enabled 缺省/false：measureMarketSubPhase 直接调用回调，零观测成本；
 * - 窗口到期自动关闭 enabled 并写 final 标记，防止长期诊断税；
 * - 每计时 tick 的 per-phase 累计只在 global heap，tick 末尾一次性合入
 *   Memory.runtime.marketSaleDiagnostics（avg/max/calls + planning 标记）；
 * - global reset 后自然重建（窗口重开需重新设置 enabled）。
 */

export interface MarketSaleDiagnosticsConfig {
  enabled?: boolean;
  windowTicks?: number;
}

interface MarketSaleDiagnosticsPhaseStats {
  total: number;
  max: number;
  calls: number;
}

interface MarketSaleDiagnosticsMemory {
  window: { startedAt: number; until: number; final: boolean };
  samples: number;
  planningTicks: number;
  phases: Record<string, MarketSaleDiagnosticsPhaseStats>;
}

interface PendingTickPhases {
  tick: number;
  planning: boolean;
  phases: Map<string, { total: number; max: number; calls: number }>;
}

type GlobalWithDiagnostics = typeof global & {
  __marketSaleDiagnosticsPending?: PendingTickPhases;
};

const runtimeGlobal: GlobalWithDiagnostics = global;
const DEFAULT_WINDOW_TICKS = 200;
const MAX_WINDOW_TICKS = 1000;
const MAX_PHASE_COUNT = 48;

let diagnosticsWindow: { startedAt: number; until: number; final: boolean } | undefined;

function normalizeWindowTicks(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_WINDOW_TICKS;
  }
  return Math.min(MAX_WINDOW_TICKS, Math.floor(value));
}

export function isMarketSaleDiagnosticsEnabled(): boolean {
  const cfg = (Memory.cfg as { marketSaleDiagnostics?: MarketSaleDiagnosticsConfig } | undefined)
    ?.marketSaleDiagnostics;
  if (!cfg?.enabled) {
    return false;
  }
  if (!diagnosticsWindow) {
    diagnosticsWindow = {
      startedAt: Game.time,
      until: Game.time + normalizeWindowTicks(cfg.windowTicks),
      final: false,
    };
  }
  if (Game.time > diagnosticsWindow.until && !diagnosticsWindow.final) {
    // 窗口到期：自动关闭，最后一批 pending 在下次 flushMemory 合入。
    diagnosticsWindow.final = true;
    (Memory.cfg as { marketSaleDiagnostics?: MarketSaleDiagnosticsConfig }).marketSaleDiagnostics = {
      ...cfg,
      enabled: false,
    };
  }
  return !diagnosticsWindow.final;
}

/** 仅供测试：强制丢弃窗口 memo（模拟 global reset 后的重新开启）。 */
export function resetMarketSaleDiagnosticsForTest(): void {
  diagnosticsWindow = undefined;
  delete runtimeGlobal.__marketSaleDiagnosticsPending;
}

function ensurePendingTickPhases(): PendingTickPhases {
  let pending = runtimeGlobal.__marketSaleDiagnosticsPending;
  if (!pending || pending.tick !== Game.time) {
    pending = { tick: Game.time, planning: false, phases: new Map() };
    runtimeGlobal.__marketSaleDiagnosticsPending = pending;
  }
  return pending;
}

/** 标记本 tick 为 planning tick（ResourceControl 当前周期）。 */
export function markMarketSaleDiagnosticsPlanningTick(): void {
  if (!isMarketSaleDiagnosticsEnabled()) {
    return;
  }
  ensurePendingTickPhases().planning = true;
}

export function measureMarketSubPhase<T>(phase: string, fn: () => T): T {
  const getUsed = Game.cpu?.getUsed;
  if (typeof getUsed !== "function" || !isMarketSaleDiagnosticsEnabled()) {
    return fn();
  }
  const startedAt = getUsed.call(Game.cpu);
  try {
    return fn();
  } finally {
    const delta = Math.max(0, getUsed.call(Game.cpu) - startedAt);
    const pending = ensurePendingTickPhases();
    let stats = pending.phases.get(phase);
    if (!stats) {
      if (pending.phases.size >= MAX_PHASE_COUNT) {
        return;
      }
      stats = { total: 0, max: 0, calls: 0 };
      pending.phases.set(phase, stats);
    }
    stats.total += delta;
    if (delta > stats.max) stats.max = delta;
    stats.calls += 1;
  }
}

/** tick 末尾（automation envelope 之后）调用：把本 tick pending 合入 Memory 聚合。 */
export function flushMarketSaleDiagnostics(): void {
  const pending = runtimeGlobal.__marketSaleDiagnosticsPending;
  delete runtimeGlobal.__marketSaleDiagnosticsPending;
  if (!pending || pending.phases.size === 0 || !diagnosticsWindow) {
    return;
  }
  if (!Memory.runtime) Memory.runtime = {};
  const raw = (Memory.runtime as { marketSaleDiagnostics?: MarketSaleDiagnosticsMemory })
    .marketSaleDiagnostics;
  const memory: MarketSaleDiagnosticsMemory =
    raw && raw.window && raw.phases
      ? raw
      : {
          window: { startedAt: diagnosticsWindow.startedAt, until: diagnosticsWindow.until, final: false },
          samples: 0,
          planningTicks: 0,
          phases: {},
        };
  memory.window.final = diagnosticsWindow.final;
  memory.window.startedAt = diagnosticsWindow.startedAt;
  memory.window.until = diagnosticsWindow.until;
  memory.samples += 1;
  if (pending.planning) memory.planningTicks += 1;
  for (const [phase, stats] of pending.phases) {
    let acc = memory.phases[phase];
    if (!acc) {
      acc = { total: 0, max: 0, calls: 0 };
      memory.phases[phase] = acc;
    }
    acc.total += stats.total;
    if (stats.max > acc.max) acc.max = stats.max;
    acc.calls += stats.calls;
  }
  (Memory.runtime as { marketSaleDiagnostics?: MarketSaleDiagnosticsMemory }).marketSaleDiagnostics =
    memory;
}

/** avg = total / samples（报读口径：CPU/计时 tick，与顶层 phase 对齐）。 */
export function readMarketSaleDiagnosticsForTest(): MarketSaleDiagnosticsMemory | undefined {
  const runtime = Memory.runtime as { marketSaleDiagnostics?: MarketSaleDiagnosticsMemory } | undefined;
  return runtime?.marketSaleDiagnostics;
}
