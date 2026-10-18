import { jsonCommand } from "@/runtime/console/jsonCommand";
import {
  normalizeCpuMonitorConfig,
  computeCpuMonitorSummary,
  getCpuMonitorHistory,
  CPU_MONITOR_DEFAULTS,
} from "@/runtime/cpuMonitor";
import type {
  CpuMonitorSnapshotV2,
  CpuMonitorSummaryV2,
  CpuMonitorConfig,
  CpuMonitorHeapSnapshot,
} from "@/runtime/cpuMonitor";

interface CpuProfilerControlResult {
  ok: true;
  enabled: boolean;
  previousEnabled: boolean;
  sampleInterval: number;
  historyLimit: number;
}

interface CpuMonitorResult {
  ok: true;
  version: 2;
  enabled: boolean;
  sampleInterval: number;
  historyLimit: number;
  historySize: number;
  latest: CpuMonitorSnapshotV2 | null;
  recentHistory: CpuMonitorSnapshotV2[];
  summary: CpuMonitorSummaryV2 | null;
}

function ensureCpuProfilerConfig(): { enabled?: boolean; sampleInterval?: number; historyLimit?: number } {
  Memory.cfg = Memory.cfg || {};
  if (!Memory.cfg.cpuProfiler) {
    Memory.cfg.cpuProfiler = {};
  }

  return Memory.cfg.cpuProfiler;
}

function getConfig(): CpuMonitorConfig {
  return normalizeCpuMonitorConfig(Memory.cfg?.cpuProfiler);
}

export function startCpuProfiler(sampleInterval?: number, historyLimit?: number): CpuProfilerControlResult | string {
  const cfg = ensureCpuProfilerConfig();
  const previousEnabled = cfg.enabled === true;

  if (sampleInterval !== undefined) {
    if (typeof sampleInterval !== "number" || !Number.isFinite(sampleInterval)) {
      return `ERR_INVALID_CPU_PROFILER_SAMPLE_INTERVAL:${String(sampleInterval)}`;
    }
    const normalized = Math.floor(sampleInterval);
    const config = normalizeCpuMonitorConfig({ sampleInterval: normalized });
    if (normalized !== config.sampleInterval) {
      return `ERR_CPU_PROFILER_SAMPLE_INTERVAL_OUT_OF_RANGE:${normalized}`;
    }
    cfg.sampleInterval = normalized;
  }

  if (historyLimit !== undefined) {
    if (typeof historyLimit !== "number" || !Number.isFinite(historyLimit)) {
      return `ERR_INVALID_CPU_PROFILER_HISTORY_LIMIT:${String(historyLimit)}`;
    }
    const normalized = Math.floor(historyLimit);
    const config = normalizeCpuMonitorConfig({ historyLimit: normalized });
    if (normalized !== config.historyLimit) {
      return `ERR_CPU_PROFILER_HISTORY_LIMIT_OUT_OF_RANGE:${normalized}`;
    }
    cfg.historyLimit = normalized;
  }

  cfg.enabled = true;
  if (cfg.sampleInterval === undefined) cfg.sampleInterval = CPU_MONITOR_DEFAULTS.sampleInterval;
  if (cfg.historyLimit === undefined) cfg.historyLimit = CPU_MONITOR_DEFAULTS.historyLimit;

  const resolved = getConfig();
  return {
    ok: true,
    enabled: true,
    previousEnabled,
    sampleInterval: resolved.sampleInterval,
    historyLimit: resolved.historyLimit,
  };
}

export function stopCpuProfilerExport(): CpuProfilerControlResult {
  const cfg = ensureCpuProfilerConfig();
  const previousEnabled = cfg.enabled === true;

  cfg.enabled = false;
  const resolved = getConfig();

  return {
    ok: true,
    enabled: false,
    previousEnabled,
    sampleInterval: resolved.sampleInterval,
    historyLimit: resolved.historyLimit,
  };
}

function formatCpuMonitorNumber(value: number): string {
  return Number.isInteger(value) ? `${value}` : value.toFixed(2);
}

function formatTopCpuPhases(
  phases: Record<string, number>,
  fixedActionCounts: Record<string, number>,
  fixedActionCpuCost: number,
  limit = 5,
): string[] {
  const topLevelPhaseNames = new Set(Object.keys(phases).filter((phase) => !phase.includes(":")));
  for (const phase of Object.keys(fixedActionCounts)) {
    topLevelPhaseNames.add(phase);
  }

  const entries = [...topLevelPhaseNames]
    .map((phase) => {
      const raw = phases[phase] || 0;
      const fixed = (fixedActionCounts[phase] || 0) * fixedActionCpuCost;
      const logic = Math.max(0, raw - fixed);
      return { name: phase, raw, logic, fixed };
    })
    .sort((a, b) => b.raw - a.raw)
    .slice(0, limit);

  return entries.map(({ name, raw, logic, fixed }) => {
    if (fixed > 0) {
      return `[cpu-monitor]   ${name}  ${raw.toFixed(2)}  (${logic.toFixed(2)} + ${fixed.toFixed(2)} fixed)`;
    }
    return `[cpu-monitor]   ${name}  ${logic.toFixed(2)}`;
  });
}

function formatTopRoomRoles(rooms: Record<string, { totalUsed: number; roles: Record<string, { count: number; used: number }> }>, limit = 5): string[] {
  if (!rooms || Object.keys(rooms).length === 0) return [];

  const entries = Object.entries(rooms)
    .map(([roomName, room]) => ({
      roomName,
      totalUsed: room.totalUsed,
      roles: room.roles,
    }))
    .sort((a, b) => b.totalUsed - a.totalUsed)
    .slice(0, limit);

  const lines: string[] = [];
  for (const entry of entries) {
    const roleParts = Object.entries(entry.roles)
      .sort((a, b) => b[1].used - a[1].used)
      .map(([role, s]) => `${role}(${s.count}x ${s.used.toFixed(2)})`)
      .join("  ");
    lines.push(`[cpu-monitor]   ${entry.roomName}  ${entry.totalUsed.toFixed(2)}  ${roleParts}`);
  }
  return lines;
}

function formatHeap(heap: CpuMonitorHeapSnapshot | null): string[] {
  if (!heap) return [];
  const usedMb = (heap.used_heap_size / 1048576).toFixed(1);
  const totalMb = (heap.total_heap_size / 1048576).toFixed(1);
  const limitMb = (heap.heap_size_limit / 1048576).toFixed(0);
  return [`[cpu-monitor]   heap  ${usedMb}/${totalMb}MB  limit=${limitMb}MB`];
}

function formatCpuMonitorResult(result: CpuMonitorResult): string {
  const config = getConfig();
  const lines = [
    `[cpu-monitor] version=2  enabled=${result.enabled}  interval=${result.sampleInterval}  history=${result.historySize}/${result.historyLimit}`,
  ];

  if (!result.latest) {
    lines.push("[cpu-monitor] latest=none");
  } else {
    const latest = result.latest;
    const fixedEstimate = Object.entries(latest.fixedActionCounts || {})
      .reduce((sum, [, count]) => sum + count * config.fixedActionCpuCost, 0);

    lines.push(
      `[cpu-monitor] latest  t=${latest.tick}  shard=${latest.shard}  used=${latest.totalUsed.toFixed(2)}/${formatCpuMonitorNumber(latest.limit)}  bucket=${formatCpuMonitorNumber(latest.bucket)}  tickLimit=${formatCpuMonitorNumber(latest.tickLimit)}  untracked=${latest.untracked.toFixed(2)}  ema=${latest.emaTotalUsed.toFixed(2)}`,
    );
    lines.push(...formatTopCpuPhases(latest.phases, latest.fixedActionCounts, config.fixedActionCpuCost));
    if (fixedEstimate > 0) {
      lines.push(`[cpu-monitor]   fixed-action estimate=${fixedEstimate.toFixed(2)} (cost=${config.fixedActionCpuCost})`);
    }
    lines.push(...formatTopRoomRoles(latest.rooms || {}));
    lines.push(...formatHeap(latest.heap));
  }

  if (!result.summary) {
    lines.push("[cpu-monitor] summary=none");
  } else {
    const summary = result.summary;
    lines.push(
      `[cpu-monitor] avg(${summary.ticks})  avg=${summary.avgTotalUsed.toFixed(2)}  max=${summary.maxTotalUsed.toFixed(2)}  bucket=${formatCpuMonitorNumber(summary.minBucket)}-${formatCpuMonitorNumber(summary.maxBucket)}  untracked=${summary.avgUntracked.toFixed(2)}  ema=${summary.emaTotalUsed.toFixed(2)}`,
    );
    lines.push(...formatTopCpuPhases(summary.avgPhases, summary.avgFixedActionCounts, config.fixedActionCpuCost));
  }

  return lines.join("\n");
}

export function startCpuProfilerRaw(sampleInterval?: number, historyLimit?: number): CpuProfilerControlResult | string {
  return startCpuProfiler(sampleInterval, historyLimit);
}

export const startCpuProfilerCommand = jsonCommand((sampleInterval?: number, historyLimit?: number) => startCpuProfiler(sampleInterval, historyLimit), undefined, true);

export function stopCpuProfilerRaw(): CpuProfilerControlResult {
  return stopCpuProfilerExport();
}

export const stopCpuProfilerCommand = jsonCommand(() => stopCpuProfilerExport(), undefined, true);

export function statusCpuProfilerRaw(): CpuProfilerControlResult {
  const config = getConfig();
  return {
    ok: true,
    enabled: config.enabled,
    previousEnabled: config.enabled,
    sampleInterval: config.sampleInterval,
    historyLimit: config.historyLimit,
  };
}

export const statusCpuProfilerCommand = jsonCommand(() => statusCpuProfilerRaw(), undefined, true);

function computeSummaryFromHistory(recentHistory: CpuMonitorSnapshotV2[]): CpuMonitorSummaryV2 | null {
  return computeCpuMonitorSummary(recentHistory, recentHistory[recentHistory.length - 1]?.emaTotalUsed ?? 0);
}

export function cpuMonitorRaw(): CpuMonitorResult {
  const config = getConfig();
  const persisted = Memory.analytics?.cpuMonitor;
  const latest = persisted?.latest || null;
  const history = getCpuMonitorHistory();
  const recentHistory = history.slice(-10);
  const summary = persisted?.summary ?? computeSummaryFromHistory(recentHistory);

  return {
    ok: true,
    version: 2,
    enabled: config.enabled,
    sampleInterval: config.sampleInterval,
    historyLimit: config.historyLimit,
    historySize: history.length,
    latest,
    recentHistory,
    summary,
  };
}

export function cpuMonitorCommand(): string {
  return formatCpuMonitorResult(cpuMonitorRaw());
}

export function registerCpuProfilerConsoleCommands(): void {
  global.startCpuProfiler = startCpuProfilerCommand;
  global.startCpuProfilerRaw = startCpuProfilerRaw;
  global.stopCpuProfiler = stopCpuProfilerCommand;
  global.stopCpuProfilerRaw = stopCpuProfilerRaw;
  global.statusCpuProfiler = statusCpuProfilerCommand;
  global.statusCpuProfilerRaw = statusCpuProfilerRaw;
  global.cpuMonitor = cpuMonitorCommand;
  global.cpuMonitorRaw = cpuMonitorRaw;
}
