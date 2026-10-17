import { jsonCommand } from "@/runtime/console/jsonCommand";
interface TelemetryControlResult {
  ok: true;
  enabled: boolean;
  previousEnabled: boolean;
  sampleInterval: number;
  segmentId: number;
}

const TELEMETRY_DEFAULT_SAMPLE_INTERVAL = 10;
const TELEMETRY_MIN_SAMPLE_INTERVAL = 5;
const TELEMETRY_MAX_SAMPLE_INTERVAL = 100;
const TELEMETRY_DEFAULT_SEGMENT_ID = 90;

function ensureTelemetryConfig(): { enabled?: boolean; sampleInterval?: number; segmentId?: number } {
  Memory.cfg = Memory.cfg || {};
  if (!Memory.cfg.telemetry) {
    Memory.cfg.telemetry = {};
  }

  return Memory.cfg.telemetry;
}

function sanitizeTelemetrySampleInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return TELEMETRY_DEFAULT_SAMPLE_INTERVAL;
  }
  const normalized = Math.floor(value);
  return Math.max(TELEMETRY_MIN_SAMPLE_INTERVAL, Math.min(TELEMETRY_MAX_SAMPLE_INTERVAL, normalized));
}

function sanitizeTelemetrySegmentId(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return TELEMETRY_DEFAULT_SEGMENT_ID;
  }
  const normalized = Math.floor(value);
  return Math.max(0, Math.min(99, normalized));
}

function resolveTelemetrySampleInterval(next?: number): number | string {
  if (next === undefined) {
    return TELEMETRY_DEFAULT_SAMPLE_INTERVAL;
  }
  if (typeof next !== "number" || !Number.isFinite(next)) {
    return `ERR_INVALID_SAMPLE_INTERVAL:${String(next)}`;
  }

  const normalized = Math.floor(next);
  if (normalized < TELEMETRY_MIN_SAMPLE_INTERVAL || normalized > TELEMETRY_MAX_SAMPLE_INTERVAL) {
    return `ERR_SAMPLE_INTERVAL_OUT_OF_RANGE:${normalized}`;
  }

  return normalized;
}

function resolveTelemetrySegmentId(next?: number): number | string {
  if (next === undefined) {
    return TELEMETRY_DEFAULT_SEGMENT_ID;
  }
  if (typeof next !== "number" || !Number.isFinite(next)) {
    return `ERR_INVALID_SEGMENT_ID:${String(next)}`;
  }

  const normalized = Math.floor(next);
  if (normalized < 0 || normalized > 99) {
    return `ERR_SEGMENT_ID_OUT_OF_RANGE:${normalized}`;
  }

  return normalized;
}

export function startTelemetry(sampleInterval?: number, segmentId?: number): TelemetryControlResult | string {
  const cfg = ensureTelemetryConfig();
  const previousEnabled = cfg.enabled === true;

  const resolvedSampleInterval = resolveTelemetrySampleInterval(sampleInterval);
  if (typeof resolvedSampleInterval === "string") {
    return resolvedSampleInterval;
  }
  const resolvedSegmentId = resolveTelemetrySegmentId(segmentId);
  if (typeof resolvedSegmentId === "string") {
    return resolvedSegmentId;
  }

  cfg.enabled = true;
  cfg.sampleInterval = resolvedSampleInterval;
  cfg.segmentId = resolvedSegmentId;

  return {
    ok: true,
    enabled: true,
    previousEnabled,
    sampleInterval: resolvedSampleInterval,
    segmentId: resolvedSegmentId,
  };
}

export function stopTelemetryExport(): TelemetryControlResult {
  const cfg = ensureTelemetryConfig();
  const previousEnabled = cfg.enabled === true;
  const sampleInterval = sanitizeTelemetrySampleInterval(cfg.sampleInterval);
  const segmentId = sanitizeTelemetrySegmentId(cfg.segmentId);

  cfg.enabled = false;
  cfg.sampleInterval = sampleInterval;
  cfg.segmentId = segmentId;

  return {
    ok: true,
    enabled: false,
    previousEnabled,
    sampleInterval,
    segmentId,
  };
}

export function startTelemetryRaw(sampleInterval?: number, segmentId?: number): TelemetryControlResult | string {
  return startTelemetry(sampleInterval, segmentId);
}

export const startTelemetryCommand = jsonCommand((sampleInterval?: number, segmentId?: number) => startTelemetry(sampleInterval, segmentId), undefined, true);

export function stopTelemetryRaw(): TelemetryControlResult {
  return stopTelemetryExport();
}

export const stopTelemetryCommand = jsonCommand(() => stopTelemetryExport(), undefined, true);

export function statusTelemetryRaw(): TelemetryControlResult {
  const cfg = ensureTelemetryConfig();
  return {
    ok: true,
    enabled: cfg.enabled === true,
    previousEnabled: cfg.enabled === true,
    sampleInterval: sanitizeTelemetrySampleInterval(cfg.sampleInterval),
    segmentId: sanitizeTelemetrySegmentId(cfg.segmentId),
  };
}

export const statusTelemetryCommand = jsonCommand(() => statusTelemetryRaw(), undefined, true);

export function registerTelemetryConsoleCommands(): void {
  global.startTelemetry = startTelemetryCommand;
  global.startTelemetryRaw = startTelemetryRaw;
  global.stopTelemetry = stopTelemetryCommand;
  global.stopTelemetryRaw = stopTelemetryRaw;
  global.statusTelemetry = statusTelemetryCommand;
  global.statusTelemetryRaw = statusTelemetryRaw;
}
