export interface MarketLaneComparison {
  key: string;
  protectionEqual: boolean;
  floorEqual: boolean;
  selectionEqual: boolean;
}

export interface MarketComparisonSelection {
  room: string;
  resource: string;
  order: string;
  amount: number;
}

export interface MarketComparisonSample {
  tick: number;
  atMs: number;
  shard: string;
  sourceCommit: string;
  configuration: string;
  complete: boolean;
  reason?: string;
  lanes: MarketLaneComparison[];
  selected?: MarketComparisonSelection;
  legacySelected?: MarketComparisonSelection;
  legacyAdmitted?: MarketComparisonSelection;
  cpu: number;
  fullRead?: boolean;
}

export interface CompactMarketComparison {
  shard: string;
  sourceCommit: string;
  configuration: string;
  startedAtTick: number;
  startedAtMs: number;
  lastAttemptAt: number;
  lastFullReadAttemptAt?: number;
  attempts: number;
  comparable: number;
  mismatches: number;
  incomplete: number;
  cpu: { last: number; max: number; total: number };
  /** 这里只证明价格内核与保护，写入仲裁/额度切换仍需后续独立验收。 */
  scope: "v3-writable-price-and-protection";
  lanes: Record<string, { at: number; samples: number; mismatches: number; protection: number; floor: number; selection: number }>;
  days: Record<string, { comparable: number; mismatches: number; incomplete: number }>;
  audit: Array<{ tick: number; reason: string; lanes: string[] }>;
  latest: {
    complete: boolean;
    reason?: string;
    selected?: MarketComparisonSelection;
    legacySelected?: MarketComparisonSelection;
    legacyAdmitted?: MarketComparisonSelection;
  };
}

export interface CompactMarketState { v: 1; comparison?: CompactMarketComparison }

const MAX_LANES = 128;
const MAX_AUDIT = 20;
const MAX_DAYS = 7;
const LANE_TTL = 30_000;
const count = (value: number): number => Math.min(1_000_000_000, value + 1);
const finiteCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function validComparison(value: CompactMarketComparison | undefined): value is CompactMarketComparison {
  return !!value && typeof value === "object" && [value.startedAtTick, value.lastAttemptAt, value.attempts,
    value.comparable, value.incomplete, value.mismatches].every(finiteCount) &&
    (value.lastFullReadAttemptAt === undefined || finiteCount(value.lastFullReadAttemptAt)) &&
    Number.isFinite(value.startedAtMs) && !!value.cpu && Object.values(value.cpu).every(x => Number.isFinite(x) && x >= 0) &&
    !!value.lanes && typeof value.lanes === "object" && !Array.isArray(value.lanes) && Object.keys(value.lanes).length <= MAX_LANES &&
    Object.values(value.lanes).every(row => !!row && Object.values(row).every(finiteCount)) &&
    !!value.days && typeof value.days === "object" && !Array.isArray(value.days) &&
    Object.keys(value.days).length <= MAX_DAYS && Object.values(value.days).every(row => !!row && Object.values(row).every(finiteCount)) &&
    Array.isArray(value.audit) && value.audit.length <= MAX_AUDIT;
}

export function recordCompactMarketComparison(state: CompactMarketState, sample: MarketComparisonSample): void {
  if (!finiteCount(sample.tick) || !Number.isFinite(sample.atMs) || !Number.isFinite(sample.cpu) || sample.cpu < 0 ||
      sample.atMs < 0 || sample.atMs > 8.64e15) return;
  let comparison = state.comparison;
  if (!validComparison(comparison) || comparison.shard !== sample.shard || comparison.sourceCommit !== sample.sourceCommit ||
      comparison.configuration !== sample.configuration || comparison.lastAttemptAt > sample.tick) {
    comparison = {
      shard: sample.shard, sourceCommit: sample.sourceCommit, configuration: sample.configuration,
      startedAtTick: sample.tick, startedAtMs: sample.atMs, lastAttemptAt: sample.tick,
      attempts: 0, comparable: 0, mismatches: 0, incomplete: 0,
      cpu: { last: 0, max: 0, total: 0 }, scope: "v3-writable-price-and-protection", lanes: {}, days: {}, audit: [],
      latest: { complete: false, reason: "initializing" },
    };
    state.comparison = comparison;
  }
  comparison.lastAttemptAt = sample.tick;
  if (sample.fullRead) comparison.lastFullReadAttemptAt = sample.tick;
  comparison.attempts = count(comparison.attempts);
  comparison.cpu = { last: sample.cpu, max: Math.max(comparison.cpu.max, sample.cpu), total: comparison.cpu.total + sample.cpu };
  const date = new Date(sample.atMs).toISOString().slice(0, 10);
  const day = comparison.days[date] ??= { comparable: 0, mismatches: 0, incomplete: 0 };
  const differences = sample.lanes.filter(row => !row.protectionEqual || !row.floorEqual || !row.selectionEqual);
  if (sample.complete && sample.lanes.length > 0) {
    comparison.comparable = count(comparison.comparable); day.comparable = count(day.comparable);
    if (differences.length > 0) { comparison.mismatches = count(comparison.mismatches); day.mismatches = count(day.mismatches); }
    for (const lane of sample.lanes.slice(0, MAX_LANES)) {
      const row = comparison.lanes[lane.key] ??= { at: sample.tick, samples: 0, mismatches: 0, protection: 0, floor: 0, selection: 0 };
      row.at = sample.tick; row.samples = count(row.samples);
      if (!lane.protectionEqual || !lane.floorEqual || !lane.selectionEqual) row.mismatches = count(row.mismatches);
      if (!lane.protectionEqual) row.protection = count(row.protection);
      if (!lane.floorEqual) row.floor = count(row.floor);
      if (!lane.selectionEqual) row.selection = count(row.selection);
    }
  } else { comparison.incomplete = count(comparison.incomplete); day.incomplete = count(day.incomplete); }
  const reason = sample.reason ?? (differences.length ? "difference" : "matched");
  comparison.audit.push({ tick: sample.tick, reason: reason.slice(0, 100), lanes: differences.slice(0, 8).map(row => row.key) });
  comparison.audit = comparison.audit.slice(-MAX_AUDIT);
  comparison.days = Object.fromEntries(Object.entries(comparison.days).sort(([a], [b]) => b.localeCompare(a)).slice(0, MAX_DAYS));
  comparison.lanes = Object.fromEntries(Object.entries(comparison.lanes).filter(([, row]) =>
    row.at <= sample.tick && sample.tick - row.at <= LANE_TTL).sort(([a, x], [b, y]) => y.at - x.at || a.localeCompare(b)).slice(0, MAX_LANES));
  comparison.latest = { complete: sample.complete, reason: sample.reason, selected: sample.selected,
    legacySelected: sample.legacySelected, legacyAdmitted: sample.legacyAdmitted };
}
