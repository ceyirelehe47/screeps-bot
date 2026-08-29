#!/usr/bin/env node

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { gunzipSync } from "node:zlib";
import { redactErrorMessage, redactSensitiveText } from "./lib/redactSecrets.cjs";

const DEFAULT_MEMORY_INTERVAL_MS = 60_000;
const DEFAULT_SEGMENT_INTERVAL_MS = 10_000;
const DEFAULT_HTTP_PORT = 3131;
const DEFAULT_HISTORY_LIMIT = 200;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_OUTPUT_PATH = "monitor-data/snapshots.jsonl";
const RESOURCE_CONTROL_ROUTE_LIMIT = 20;
const RESOURCE_CONTROL_LOGISTICS_ARRAY_LIMIT = 20;
const RESOURCE_CONTROL_LOGISTICS_INTENT_LIMIT = 32;
const RESOURCE_CONTROL_LOGISTICS_BYTE_LIMIT = 32_768;
const RESOURCE_CONTROL_LOGISTICS_DATA_BYTE_LIMIT = 16_384;
const RESOURCE_CONTROL_LOGISTICS_RUNTIME_BYTE_LIMIT = 16_384;
const RESOURCE_CONTROL_LOGISTICS_DATA_ITEM_LIMIT = 160;
const RESOURCE_CONTROL_LOGISTICS_RUNTIME_ITEM_LIMIT = 128;
const RESOURCE_CONTROL_LOGISTICS_RUNTIME_V2_ITEM_LIMIT = 200;
const RESOURCE_CONTROL_LOGISTICS_STORE_LIMIT = 32;
const RESOURCE_CONTROL_LOGISTICS_COMPACT_STRING_LIMIT = 512;
const RESOURCE_CONTROL_LOGISTICS_SYNTHESIS_PRODUCER =
  "synthesisControl:room";
const RESOURCE_CONTROL_LOGISTICS_CANDIDATE_BUDGET_LIMIT = 256;
const RESOURCE_CONTROL_LOGISTICS_MAX_BATCH_AMOUNT = 50_000;
const RESOURCE_CONTROL_LOGISTICS_INDEX_BUILD_LIMIT = 1;
const RESOURCE_CONTROL_LOGISTICS_CAUSAL_SAMPLE_LIMIT = 8;
const RESOURCE_CONTROL_LOGISTICS_COST_EVALUATIONS_PER_CANDIDATE_LIMIT = 17;
const RESOURCE_CONTROL_LOGISTICS_COST_EVALUATIONS_PER_RUN_LIMIT = 4_352;
const RESOURCE_CONTROL_LOGISTICS_COST_EVALUATIONS_PER_EPOCH_LIMIT = 8_704;
const HUB_DISTRIBUTED_SYNTHESIS_ARRAY_LIMIT = 100;
const CONTINUOUS_DIRECT_ENTRY_LIMIT = 20;
const MARKET_BASE_RESOURCE_CATALOG_LIMIT = 7;
const MARKET_BASE_RESOURCE_ROSTER_LIMIT = 16;
const MARKET_BASE_RESOURCE_LIFECYCLE_LIMIT = 64;
const MARKET_BASE_RESOURCE_READINESS_ROOM_LIMIT = 16;
const OBSERVABILITY_STRING_LIMIT = 256;
const MONITOR_LOG_LINE_LIMIT = 4_096;
const MONITOR_LOG_TRUNCATION_SUFFIX = " …[truncated]";

const RESOURCE_CONTROL_LOGISTICS_MODES = new Set([
  "disabled",
  "shadow",
  "canary",
  "enabled",
]);
const RESOURCE_CONTROL_LOGISTICS_BLOCKERS = new Set([
  "mode_disabled",
  "config_invalid",
  "store_missing",
  "store_invalid",
  "input_unavailable",
  "matcher_unavailable",
]);
const RESOURCE_CONTROL_LOGISTICS_ORIGINS = new Set([
  "ordinary_balance",
  "capacity_relief",
  "synthesis_room",
  "synthesis_distributed_demand",
  "synthesis_surplus",
  "synthesis_compatibility",
  "power_bank_boost",
  "survival_energy",
  "operator",
  "market",
]);
const RESOURCE_CONTROL_LOGISTICS_DIMENSIONS = [
  "donor",
  "route",
  "priority",
  "demandCoverage",
  "receiverHeadroom",
  "predictedStagingEligibility",
];
const RESOURCE_CONTROL_LOGISTICS_SAMPLE_STATUSES = new Set([
  "equal",
  "different",
  "unresolved",
]);
const RESOURCE_CONTROL_LOGISTICS_DIFFERENCE_REASONS = new Set([
  "expected_policy_difference",
  "legacy_unpaired",
  "shadow_unpaired",
  "unsafe_candidate",
  "input_unavailable",
]);
const RESOURCE_CONTROL_LOGISTICS_UNRESOLVED_REASONS = new Set([
  "input_unavailable",
  "input_drift",
  "stale_intent",
  "candidate_budget_exhausted",
  "legacy_observation_missing",
  "malformed_input",
  "input_limit_exceeded",
]);
const RESOURCE_CONTROL_LOGISTICS_COMPARISON_REASONS = new Set([
  "equal",
  "expected_policy_difference",
  "legacy_unpaired",
  "shadow_unpaired",
  "unsafe_candidate",
  "input_unavailable",
  "input_drift",
  "stale_intent",
  "candidate_budget_exhausted",
  "legacy_observation_missing",
  "malformed_input",
  "input_limit_exceeded",
]);
const RESOURCE_CONTROL_LOGISTICS_STAGING_ELIGIBILITY = new Set([
  "eligible",
  "blocked",
  "unknown",
]);
const RESOURCE_CONTROL_LOGISTICS_COVERAGE = new Set([
  "covered",
  "partial",
  "none",
  "unknown",
]);
const RESOURCE_CONTROL_LOGISTICS_DECISION_DELTAS = new Set([
  "same_route",
  "different_route",
  "both_no_route",
  "legacy_only_route",
  "shadow_only_route",
  "input_unavailable",
]);
const RESOURCE_CONTROL_LOGISTICS_DIFFERENCE_DIRECTIONS = new Set([
  "same",
  "shadow_more_conservative",
  "shadow_more_permissive",
  "policy_difference",
  "input_unavailable",
]);
const RESOURCE_CONTROL_LOGISTICS_CANDIDATE_REJECTION_ORDER = [
  "stale_receiver_fact",
  "invalid_receiver_endpoint",
  "receiver_capacity",
  "stale_source_fact",
  "invalid_source_endpoint",
  "source_protection",
  "fee_budget",
  "staging_capacity",
  "terminal_readiness",
  "transaction_cost_unavailable",
  "source_not_allowed",
  "same_room",
  "below_minimum_batch",
];
const RESOURCE_CONTROL_LOGISTICS_CANDIDATE_REJECTIONS = new Set(
  RESOURCE_CONTROL_LOGISTICS_CANDIDATE_REJECTION_ORDER,
);
const RESOURCE_CONTROL_LOGISTICS_UNMATCHED_REASONS = new Set([
  ...RESOURCE_CONTROL_LOGISTICS_CANDIDATE_REJECTION_ORDER,
  "demand_already_covered",
  "no_donor",
  "donor_limit_exceeded",
  "malformed_input",
  "stale_intent",
]);
const RESOURCE_CONTROL_LOGISTICS_CAUSAL_CODES = new Set([
  "matched",
  "route_rank",
  "route_fact_difference",
  "legacy_blocker",
  "input_unavailable",
  ...RESOURCE_CONTROL_LOGISTICS_UNMATCHED_REASONS,
  ...RESOURCE_CONTROL_LOGISTICS_UNRESOLVED_REASONS,
]);
const RESOURCE_CONTROL_LOGISTICS_LEGACY_SOURCE_DISPOSITIONS = new Set([
  "selected",
  "feasible_lower_rank",
  "rejected",
  "not_candidate",
  "not_evaluated",
]);
const RESOURCE_CONTROL_LOGISTICS_COMPACT_WIRE_KEYS = [
  "schemaVersion",
  "wireFormat",
  "s",
  "i",
  "o",
  "f",
  "p",
  "c",
];
const RESOURCE_CONTROL_LOGISTICS_PRIORITY_CLASS_COUNT = 8;
const RESOURCE_CONTROL_LOGISTICS_OBSERVATION_REASON_COUNT = 7;
const RESOURCE_CONTROL_LOGISTICS_LEGACY_DECISION_COUNT = 5;
const RESOURCE_CONTROL_LOGISTICS_CAPACITY_STATE_COUNT = 3;
const RESOURCE_CONTROL_LOGISTICS_RESOURCES = new Set([
  "energy", "power", "ops",
  "U", "L", "K", "Z", "O", "H", "X",
  "OH", "ZK", "UL", "G",
  "UH", "UO", "KH", "KO", "LH", "LO", "ZH", "ZO", "GH", "GO",
  "UH2O", "UHO2", "KH2O", "KHO2", "LH2O", "LHO2", "ZH2O", "ZHO2",
  "GH2O", "GHO2", "XUH2O", "XUHO2", "XKH2O", "XKHO2", "XLH2O",
  "XLHO2", "XZH2O", "XZHO2", "XGH2O", "XGHO2",
  "biomass", "metal", "mist", "silicon",
  "utrium_bar", "lemergium_bar", "zynthium_bar", "keanium_bar",
  "ghodium_melt", "oxidant", "reductant", "purifier", "battery",
  "composite", "crystal", "liquid",
  "wire", "switch", "transistor", "microchip", "circuit", "device",
  "cell", "phlegm", "tissue", "muscle", "organoid", "organism",
  "alloy", "tube", "fixtures", "frame", "hydraulics", "machine",
  "condensate", "concentrate", "extract", "spirit", "emanation", "essence",
]);

function printHelp() {
  console.log(`Screeps monitor service

Usage:
  node scripts/monitor-service.mjs [options]

Options:
  --once                          Fetch once and print JSON
  --token <token>                 Screeps auth token
  --base-url <url>                API base URL (default: https://screeps.com/)
  --memory-interval-ms <ms>       Memory polling interval (default: 60000)
  --segment-id <id>               Optional RawMemory segment id (0-99)
  --shard <name>                  Optional shard name (e.g. shard2)
  --shards <csv>                  Shard candidates for auto-selection (default: shard0,shard1,shard2,shard3)
  --segment-interval-ms <ms>      Segment polling interval (default: 10000)
  --output <path|off>             JSONL output path (default: monitor-data/snapshots.jsonl)
  --port <port>                   HTTP server port (default: 3131)
  --history-limit <n>             In-memory history length (default: 200)
  --request-timeout-ms <ms>       API request timeout (default: 15000)
  --no-http                       Disable HTTP server mode
  --lean-memory                   Skip gate-irrelevant path reads (hub, direct market data) to save API quota
  --memory-fixture <path>         Load memory from JSON file instead of API (for testing)
  --help                          Show this help

Shard behavior:
  Without --shard, the monitor tries all --shards candidates and selects the
  one with the most recent hub analytics, deploy tag timestamp, or latest tick.

Environment variables:
  SCREEPS_TOKEN
  SCREEPS_BASE_URL
  SCREEPS_MONITOR_MEMORY_INTERVAL_MS
  SCREEPS_MONITOR_SEGMENT_ID
  SCREEPS_MONITOR_SHARD
  SCREEPS_MONITOR_SHARDS
  SCREEPS_MONITOR_SEGMENT_INTERVAL_MS
  SCREEPS_MONITOR_OUTPUT
  SCREEPS_MONITOR_PORT
  SCREEPS_MONITOR_HISTORY_LIMIT
  SCREEPS_MONITOR_REQUEST_TIMEOUT_MS
  SCREEPS_MONITOR_MEMORY_FIXTURE
`);
}

function parseArgs(argv) {
  const args = {
    once: false,
    noHttp: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help") {
      args.help = true;
      continue;
    }
    if (arg === "--once") {
      args.once = true;
      continue;
    }
    if (arg === "--no-http") {
      args.noHttp = true;
      continue;
    }
    if (arg === "--lean-memory") {
      args.leanMemory = true;
      continue;
    }

    const [key, inlineValue] = arg.includes("=") ? arg.split("=", 2) : [arg, undefined];
    if (
      key !== "--token" &&
      key !== "--base-url" &&
      key !== "--memory-interval-ms" &&
      key !== "--segment-id" &&
      key !== "--shard" &&
      key !== "--segment-interval-ms" &&
      key !== "--output" &&
      key !== "--port" &&
      key !== "--history-limit" &&
      key !== "--request-timeout-ms" &&
      key !== "--memory-fixture" &&
      key !== "--shards"
    ) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    const nextValue = inlineValue === undefined ? argv[index + 1] : inlineValue;
    if (nextValue === undefined) {
      throw new Error(`Missing value for ${key}`);
    }
    if (inlineValue === undefined) {
      index += 1;
    }

    if (key === "--token") {
      args.token = nextValue;
    } else if (key === "--base-url") {
      args.baseUrl = nextValue;
    } else if (key === "--memory-interval-ms") {
      args.memoryIntervalMs = nextValue;
    } else if (key === "--segment-id") {
      args.segmentId = nextValue;
    } else if (key === "--shard") {
      args.shard = nextValue;
    } else if (key === "--segment-interval-ms") {
      args.segmentIntervalMs = nextValue;
    } else if (key === "--output") {
      args.outputPath = nextValue;
    } else if (key === "--port") {
      args.port = nextValue;
    } else if (key === "--history-limit") {
      args.historyLimit = nextValue;
    } else if (key === "--request-timeout-ms") {
      args.requestTimeoutMs = nextValue;
    } else if (key === "--memory-fixture") {
      args.memoryFixture = nextValue;
    } else if (key === "--shards") {
      args.shards = nextValue;
    }
  }

  return args;
}

function normalizeBaseUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url.toString();
}

function toInteger(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function toOptionalInteger(value, min, max) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (value === "off") {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return Math.max(min, Math.min(max, parsed));
}

function toOutputPath(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_OUTPUT_PATH;
  }
  const normalized = String(value).trim();
  if (normalized === "off") {
    return null;
  }
  return normalized;
}

function toOptionalShard(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }
  return normalized;
}

async function readSecretConfig() {
  try {
    const raw = await readFile(resolve(process.cwd(), ".secret.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : null;
  } catch {
    return null;
  }
}

function buildBaseUrlFromSecret(secretMain) {
  if (!secretMain || typeof secretMain !== "object") {
    return null;
  }
  const protocol = typeof secretMain.protocol === "string" ? secretMain.protocol : "https";
  const hostname = typeof secretMain.hostname === "string" ? secretMain.hostname : "screeps.com";
  const port = typeof secretMain.port === "number" ? `:${secretMain.port}` : "";
  const path = typeof secretMain.path === "string" ? secretMain.path : "/";
  return normalizeBaseUrl(`${protocol}://${hostname}${port}${path}`);
}

async function resolveConfig(args) {
  const secret = await readSecretConfig();
  const secretMain = secret && typeof secret.main === "object" ? secret.main : null;

  const memoryFixture =
    process.env.SCREEPS_MONITOR_MEMORY_FIXTURE || args.memoryFixture || null;

  const token = args.token || process.env.SCREEPS_TOKEN || (secretMain && secretMain.token) || null;
  // Token required for live API; fixture-only mode with no segment can work without token
  const segmentId = toOptionalInteger(args.segmentId || process.env.SCREEPS_MONITOR_SEGMENT_ID, 0, 99);
  if (!token && !memoryFixture) {
    throw new Error("Missing Screeps token. Use --token, SCREEPS_TOKEN, or .secret.json main.token.");
  }
  if (!token && memoryFixture && segmentId !== null) {
    throw new Error("Missing Screeps token. Token required for segment fetch even with --memory-fixture. Use --segment-id off to disable.");
  }

  const secretBaseUrl = buildBaseUrlFromSecret(secretMain);
  const baseUrl =
    normalizeBaseUrl(args.baseUrl || process.env.SCREEPS_BASE_URL || secretBaseUrl || "https://screeps.com/") ||
    "https://screeps.com/";

  const memoryIntervalMs = toInteger(
    args.memoryIntervalMs || process.env.SCREEPS_MONITOR_MEMORY_INTERVAL_MS,
    DEFAULT_MEMORY_INTERVAL_MS,
    5_000,
    3_600_000,
  );
  const shard = toOptionalShard(args.shard || process.env.SCREEPS_MONITOR_SHARD);
  const segmentIntervalMs = toInteger(
    args.segmentIntervalMs || process.env.SCREEPS_MONITOR_SEGMENT_INTERVAL_MS,
    DEFAULT_SEGMENT_INTERVAL_MS,
    5_000,
    3_600_000,
  );
  const outputPath = toOutputPath(args.outputPath || process.env.SCREEPS_MONITOR_OUTPUT);
  const port = toInteger(args.port || process.env.SCREEPS_MONITOR_PORT, DEFAULT_HTTP_PORT, 1, 65535);
  const historyLimit = toInteger(
    args.historyLimit || process.env.SCREEPS_MONITOR_HISTORY_LIMIT,
    DEFAULT_HISTORY_LIMIT,
    1,
    10_000,
  );
  const requestTimeoutMs = toInteger(
    args.requestTimeoutMs || process.env.SCREEPS_MONITOR_REQUEST_TIMEOUT_MS,
    DEFAULT_REQUEST_TIMEOUT_MS,
    1_000,
    120_000,
  );

  const shardsRaw = args.shards || process.env.SCREEPS_MONITOR_SHARDS || "shard0,shard1,shard2,shard3";
  const shardCandidates = String(shardsRaw)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const explicitShard = !!(args.shard || process.env.SCREEPS_MONITOR_SHARD);

  return {
    once: args.once,
    noHttp: args.noHttp,
    leanMemory: args.leanMemory === true,
    token,
    baseUrl,
    memoryIntervalMs,
    segmentId,
    shard,
    explicitShard,
    shardCandidates,
    segmentIntervalMs,
    outputPath,
    port,
    historyLimit,
    requestTimeoutMs,
    memoryFixture,
  };
}

function safeJsonParse(value) {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function decodeScreepsDataString(value) {
  if (typeof value !== "string") {
    return value;
  }

  if (!value.startsWith("gz:")) {
    return safeJsonParse(value) ?? value;
  }

  const encoded = value.slice(3);
  try {
    const decompressed = gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
    return safeJsonParse(decompressed) ?? decompressed;
  } catch {
    return null;
  }
}

function extractRateLimit(headers) {
  return {
    limit: headers.get("x-ratelimit-limit"),
    remaining: headers.get("x-ratelimit-remaining"),
    reset: headers.get("x-ratelimit-reset"),
  };
}

async function fetchApiJson(config, endpoint, params) {
  const url = new URL(endpoint, config.baseUrl);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === null || value === undefined) {
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-Token": config.token,
      "User-Agent": "screeps-monitor-service",
    },
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });

  const text = await response.text();
  const parsed = safeJsonParse(text);
  const payload = parsed === null ? text : parsed;
  const rateLimit = extractRateLimit(response.headers);

  if (!response.ok) {
    // 响应体可能含带 token 的链接（如 429 noratelimit），错误文本统一脱敏后再抛出。
    const bodyText = typeof payload === "string" ? payload : JSON.stringify(payload);
    throw new Error(
      `HTTP ${response.status} for ${endpoint}: ${redactSensitiveText(bodyText.slice(0, 300))} | remaining=${rateLimit.remaining ?? "?"}`,
    );
  }

  return {
    payload,
    rateLimit,
  };
}

function parseMemoryBody(payload) {
  if (payload && typeof payload === "object") {
    if ("data" in payload) {
      const data = payload.data;
      if (typeof data === "string") {
        const decoded = decodeScreepsDataString(data);
        if (decoded && typeof decoded === "object") {
          return decoded;
        }
        return null;
      }
      if (data && typeof data === "object") {
        return data;
      }
      return null;
    }
    if ("memory" in payload) {
      const memory = payload.memory;
      if (typeof memory === "string") {
        return safeJsonParse(memory);
      }
      if (memory && typeof memory === "object") {
        return memory;
      }
      return null;
    }
    if ("analytics" in payload) {
      return payload;
    }
  }

  if (typeof payload === "string") {
    const decoded = decodeScreepsDataString(payload);
    if (decoded && typeof decoded === "object") {
      return decoded;
    }
    return null;
  }
  return null;
}

function summarizeProduction(production) {
  const roomsRecord = production && typeof production === "object" ? production.rooms : null;
  if (!roomsRecord || typeof roomsRecord !== "object") {
    return {
      roomCount: 0,
      latestTick: null,
      totals: {
        looseEnergy: 0,
        storedEnergy: 0,
        sourceEnergy: 0,
        workers: 0,
        carriers: 0,
        harvesters: 0,
      },
      rooms: [],
    };
  }

  const rooms = Object.entries(roomsRecord).map(([roomName, roomState]) => {
    const latest = roomState && typeof roomState === "object" ? roomState.latest : null;
    const signal = roomState && typeof roomState === "object" ? roomState.signal : null;

    return {
      roomName,
      updatedAt: roomState && typeof roomState === "object" ? roomState.updatedAt ?? null : null,
      latest: {
        tick: latest && typeof latest === "object" ? latest.tick ?? null : null,
        looseEnergy: latest && typeof latest === "object" ? latest.looseEnergy ?? null : null,
        storedEnergy: latest && typeof latest === "object" ? latest.storedEnergy ?? null : null,
        sourceEnergy: latest && typeof latest === "object" ? latest.sourceEnergy ?? null : null,
        workerCount: latest && typeof latest === "object" ? latest.workerCount ?? null : null,
        carrierCount: latest && typeof latest === "object" ? latest.carrierCount ?? null : null,
        harvesterCount: latest && typeof latest === "object" ? latest.harvesterCount ?? null : null,
      },
      signal: {
        looseEnergyTrend: signal && typeof signal === "object" ? signal.looseEnergyTrend ?? null : null,
        sourceEnergyTrend: signal && typeof signal === "object" ? signal.sourceEnergyTrend ?? null : null,
        upgradeRate: signal && typeof signal === "object" ? signal.upgradeRate ?? null : null,
        spawnBusy: signal && typeof signal === "object" ? signal.spawnBusy ?? null : null,
      },
    };
  });

  rooms.sort((left, right) => left.roomName.localeCompare(right.roomName));

  let latestTick = null;
  const totals = {
    looseEnergy: 0,
    storedEnergy: 0,
    sourceEnergy: 0,
    workers: 0,
    carriers: 0,
    harvesters: 0,
  };

  for (const room of rooms) {
    if (typeof room.latest.tick === "number") {
      latestTick = latestTick === null ? room.latest.tick : Math.max(latestTick, room.latest.tick);
    }
    totals.looseEnergy += typeof room.latest.looseEnergy === "number" ? room.latest.looseEnergy : 0;
    totals.storedEnergy += typeof room.latest.storedEnergy === "number" ? room.latest.storedEnergy : 0;
    totals.sourceEnergy += typeof room.latest.sourceEnergy === "number" ? room.latest.sourceEnergy : 0;
    totals.workers += typeof room.latest.workerCount === "number" ? room.latest.workerCount : 0;
    totals.carriers += typeof room.latest.carrierCount === "number" ? room.latest.carrierCount : 0;
    totals.harvesters += typeof room.latest.harvesterCount === "number" ? room.latest.harvesterCount : 0;
  }

  return {
    roomCount: rooms.length,
    latestTick,
    totals,
    rooms,
  };
}

function summarizeModuleCpu(moduleCpu) {
  if (!moduleCpu || typeof moduleCpu !== "object") {
    return {
      available: false,
      source: "legacy",
      updatedAt: null,
      sampleInterval: null,
      historyLimit: null,
      latest: null,
    };
  }

  const latestRaw = moduleCpu.latest && typeof moduleCpu.latest === "object" ? moduleCpu.latest : null;
  const phasesRaw = latestRaw && latestRaw.phases && typeof latestRaw.phases === "object" ? latestRaw.phases : {};
  const normalizedPhases = {};
  for (const [phase, used] of Object.entries(phasesRaw)) {
    if (typeof used === "number" && Number.isFinite(used)) {
      normalizedPhases[phase] = used;
    }
  }

  const topPhases = Object.entries(normalizedPhases)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([phase, used]) => ({ phase, used }));

  return {
    available: true,
    source: "legacy",
    updatedAt: typeof moduleCpu.updatedAt === "number" ? moduleCpu.updatedAt : null,
    sampleInterval: typeof moduleCpu.sampleInterval === "number" ? moduleCpu.sampleInterval : null,
    historyLimit: typeof moduleCpu.historyLimit === "number" ? moduleCpu.historyLimit : null,
    latest: latestRaw
      ? {
          tick: typeof latestRaw.tick === "number" ? latestRaw.tick : null,
          shard: typeof latestRaw.shard === "string" ? latestRaw.shard : null,
          totalUsed: typeof latestRaw.totalUsed === "number" ? latestRaw.totalUsed : null,
          bucket: typeof latestRaw.bucket === "number" ? latestRaw.bucket : null,
          limit: typeof latestRaw.limit === "number" ? latestRaw.limit : null,
          tickLimit: typeof latestRaw.tickLimit === "number" ? latestRaw.tickLimit : null,
          untracked: typeof latestRaw.untracked === "number" ? latestRaw.untracked : null,
          phases: normalizedPhases,
          topPhases,
        }
      : null,
  };
}

function summarizeCpuMonitor(cpuMonitor, fallbackModuleCpu) {
  // Prefer v2 cpuMonitor when present
  if (cpuMonitor && typeof cpuMonitor === "object" && cpuMonitor.version === 2) {
    const latestRaw = cpuMonitor.latest && typeof cpuMonitor.latest === "object" ? cpuMonitor.latest : null;
    const summaryRaw = cpuMonitor.summary && typeof cpuMonitor.summary === "object" ? cpuMonitor.summary : null;

    const phasesRaw = latestRaw && latestRaw.phases && typeof latestRaw.phases === "object" ? latestRaw.phases : {};
    const normalizedPhases = {};
    for (const [phase, used] of Object.entries(phasesRaw)) {
      if (typeof used === "number" && Number.isFinite(used)) {
        normalizedPhases[phase] = used;
      }
    }
    const topPhases = Object.entries(normalizedPhases)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([phase, used]) => ({ phase, used }));

    // Config: segment shape uses cpuMonitor.config.*, Memory shape uses top-level fields
    const configRaw = cpuMonitor.config && typeof cpuMonitor.config === "object" ? cpuMonitor.config : {};
    const sampleInterval = typeof cpuMonitor.sampleInterval === "number" ? cpuMonitor.sampleInterval
      : typeof configRaw.sampleInterval === "number" ? configRaw.sampleInterval : null;
    const historyLimit = typeof cpuMonitor.historyLimit === "number" ? cpuMonitor.historyLimit
      : typeof configRaw.historyLimit === "number" ? configRaw.historyLimit : null;
    const fixedActionCpuCost = typeof configRaw.fixedActionCpuCost === "number" ? configRaw.fixedActionCpuCost : 0.2;

    // Fixed action estimate — 3-tier priority:
    // 1. Sum latest.fixedActionCounts * cost (most precise)
    // 2. latest.fixedActionEstimate if present (segment pre-computed)
    // 3. summary.fixedActionEstimate fallback (aggregated)
    const fixedActionCounts = latestRaw && latestRaw.fixedActionCounts && typeof latestRaw.fixedActionCounts === "object"
      ? latestRaw.fixedActionCounts : {};
    let fixedActionEstimate = 0;
    for (const count of Object.values(fixedActionCounts)) {
      if (typeof count === "number" && Number.isFinite(count)) {
        fixedActionEstimate += count * fixedActionCpuCost;
      }
    }
    if (fixedActionEstimate === 0) {
      if (latestRaw && typeof latestRaw.fixedActionEstimate === "number" && Number.isFinite(latestRaw.fixedActionEstimate)) {
        fixedActionEstimate = latestRaw.fixedActionEstimate;
      } else if (summaryRaw && typeof summaryRaw.fixedActionEstimate === "number" && Number.isFinite(summaryRaw.fixedActionEstimate)) {
        fixedActionEstimate = summaryRaw.fixedActionEstimate;
      }
    }

    // Top rooms/roles
    const topRooms = [];
    const topRoomRoles = [];
    if (latestRaw && latestRaw.rooms && typeof latestRaw.rooms === "object") {
      const roomEntries = [];
      for (const [roomName, roomData] of Object.entries(latestRaw.rooms)) {
        if (!roomData || typeof roomData !== "object") continue;
        let roomTotal = typeof roomData.totalUsed === "number" ? roomData.totalUsed : 0;
        roomEntries.push({ roomName, totalUsed: roomTotal, roles: roomData.roles || {} });
      }
      roomEntries.sort((a, b) => b.totalUsed - a.totalUsed);
      for (const re of roomEntries.slice(0, 5)) {
        topRooms.push({ room: re.roomName, totalUsed: re.totalUsed });
        if (re.roles && typeof re.roles === "object") {
          const roleEntries = Object.entries(re.roles)
            .filter(([, rd]) => rd && typeof rd === "object")
            .map(([role, rd]) => ({ room: re.roomName, role, avgUsed: typeof rd.used === "number" ? rd.used : 0, count: typeof rd.count === "number" ? rd.count : 0 }))
            .sort((a, b) => b.avgUsed - a.avgUsed);
          for (const rre of roleEntries.slice(0, 3)) {
            topRoomRoles.push(rre);
          }
        }
      }
    }

    // Heap
    const heapRaw = latestRaw && latestRaw.heap ? latestRaw.heap : null;
    let heap = null;
    if (heapRaw && typeof heapRaw === "object") {
      heap = {
        used_heap_size: typeof heapRaw.used_heap_size === "number" ? heapRaw.used_heap_size : null,
        total_heap_size: typeof heapRaw.total_heap_size === "number" ? heapRaw.total_heap_size : null,
        heap_size_limit: typeof heapRaw.heap_size_limit === "number" ? heapRaw.heap_size_limit : null,
      };
    }

    // Summary top phases: Memory shape uses avgPhases (record), segment shape uses topPhases (record or array)
    const summaryTopPhases = [];
    if (summaryRaw && summaryRaw.avgPhases && typeof summaryRaw.avgPhases === "object" && !Array.isArray(summaryRaw.avgPhases)) {
      for (const [phase, avg] of Object.entries(summaryRaw.avgPhases).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
        if (typeof avg === "number" && Number.isFinite(avg)) {
          summaryTopPhases.push({ phase, avgUsed: avg });
        }
      }
    } else if (summaryRaw && summaryRaw.topPhases && typeof summaryRaw.topPhases === "object" && !Array.isArray(summaryRaw.topPhases)) {
      // Segment shape: topPhases is a record { phase: avgUsed }
      for (const [phase, avg] of Object.entries(summaryRaw.topPhases).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
        if (typeof avg === "number" && Number.isFinite(avg)) {
          summaryTopPhases.push({ phase, avgUsed: avg });
        }
      }
    } else if (summaryRaw && Array.isArray(summaryRaw.topPhases)) {
      for (const entry of summaryRaw.topPhases.slice(0, 8)) {
        if (entry && typeof entry === "object") {
          const phase = typeof entry.phase === "string" ? entry.phase : String(entry.phase ?? "");
          const avgUsed = typeof entry.avgUsed === "number" && Number.isFinite(entry.avgUsed) ? entry.avgUsed : 0;
          if (phase) summaryTopPhases.push({ phase, avgUsed });
        }
      }
    }

    // Summary top room roles (segment shape)
    const summaryTopRoomRoles = [];
    if (summaryRaw && Array.isArray(summaryRaw.topRoomRoles)) {
      for (const entry of summaryRaw.topRoomRoles.slice(0, 10)) {
        if (entry && typeof entry === "object") {
          summaryTopRoomRoles.push({
            room: typeof entry.room === "string" ? entry.room : "",
            role: typeof entry.role === "string" ? entry.role : "",
            avgUsed: typeof entry.avgUsed === "number" && Number.isFinite(entry.avgUsed) ? entry.avgUsed : 0,
            count: typeof entry.count === "number" ? entry.count : 0,
          });
        }
      }
    }

    // History size
    const historyRaw = Array.isArray(cpuMonitor.history) ? cpuMonitor.history : null;
    const historySize = historyRaw ? historyRaw.length : null;

    return {
      available: true,
      version: 2,
      source: "cpuMonitor",
      updatedAt: typeof cpuMonitor.updatedAt === "number" ? cpuMonitor.updatedAt : null,
      sampleInterval,
      historyLimit,
      config: Object.keys(configRaw).length > 0 ? { fixedActionCpuCost, sampleInterval, historyLimit } : null,
      historySize,
      latest: latestRaw
        ? {
            tick: typeof latestRaw.tick === "number" ? latestRaw.tick : null,
            shard: typeof latestRaw.shard === "string" ? latestRaw.shard : null,
            totalUsed: typeof latestRaw.totalUsed === "number" ? latestRaw.totalUsed : null,
            bucket: typeof latestRaw.bucket === "number" ? latestRaw.bucket : null,
            limit: typeof latestRaw.limit === "number" ? latestRaw.limit : null,
            tickLimit: typeof latestRaw.tickLimit === "number" ? latestRaw.tickLimit : null,
            untracked: typeof latestRaw.untracked === "number" ? latestRaw.untracked : null,
            emaTotalUsed: typeof latestRaw.emaTotalUsed === "number" ? latestRaw.emaTotalUsed : null,
            phases: normalizedPhases,
            topPhases,
            fixedActionEstimate,
            topRooms,
            topRoomRoles,
            heap,
          }
        : null,
      summary: summaryRaw
        ? {
            ticks: typeof summaryRaw.ticks === "number" ? summaryRaw.ticks : null,
            avgTotalUsed: typeof summaryRaw.avgTotalUsed === "number" ? summaryRaw.avgTotalUsed : null,
            maxTotalUsed: typeof summaryRaw.maxTotalUsed === "number" ? summaryRaw.maxTotalUsed : null,
            avgBucket: typeof summaryRaw.avgBucket === "number" ? summaryRaw.avgBucket : null,
            minBucket: typeof summaryRaw.minBucket === "number" ? summaryRaw.minBucket : null,
            emaTotalUsed: typeof summaryRaw.emaTotalUsed === "number" ? summaryRaw.emaTotalUsed : null,
            fixedActionEstimate: (() => {
              if (typeof summaryRaw.fixedActionEstimate === "number" && Number.isFinite(summaryRaw.fixedActionEstimate)) {
                return summaryRaw.fixedActionEstimate;
              }
              if (summaryRaw.avgFixedActionCounts && typeof summaryRaw.avgFixedActionCounts === "object") {
                let sum = 0;
                for (const count of Object.values(summaryRaw.avgFixedActionCounts)) {
                  if (typeof count === "number" && Number.isFinite(count)) sum += count;
                }
                if (sum > 0) return sum * fixedActionCpuCost;
              }
              return null;
            })(),
            topPhases: summaryTopPhases,
            topRoomRoles: summaryTopRoomRoles,
          }
        : null,
    };
  }

  // Legacy fallback
  if (fallbackModuleCpu && typeof fallbackModuleCpu === "object") {
    const legacy = summarizeModuleCpu(fallbackModuleCpu);
    return {
      ...legacy,
      version: 1,
    };
  }

  return {
    available: false,
    version: null,
    source: "none",
    updatedAt: null,
    sampleInterval: null,
    historyLimit: null,
    config: null,
    historySize: null,
    latest: null,
    summary: null,
  };
}

function buildResourceControlCpuPhaseEvidence(cpuMonitor) {
  const byTick = new Map();
  const ambiguousTicks = new Set();
  if (
    !cpuMonitor ||
    typeof cpuMonitor !== "object" ||
    cpuMonitor.version !== 2
  ) {
    return { byTick, ambiguousTicks };
  }
  const entries = [
    ...(Array.isArray(cpuMonitor.history)
      ? cpuMonitor.history.slice(-DEFAULT_HISTORY_LIMIT)
      : []),
    ...(cpuMonitor.latest && typeof cpuMonitor.latest === "object"
      ? [cpuMonitor.latest]
      : []),
  ];
  for (const entry of entries) {
    const tick = nonNegativeSafeIntegerOrNull(entry?.tick);
    const phases = objectOrNull(entry?.phases);
    const resourceControlUsed = finiteNumberWithinOrNull(
      phases?.resourceControl,
      0,
      Number.MAX_VALUE,
    );
    if (tick === null || resourceControlUsed === null) continue;
    if (
      byTick.has(tick) &&
      byTick.get(tick) !== resourceControlUsed
    ) {
      ambiguousTicks.add(tick);
      continue;
    }
    byTick.set(tick, resourceControlUsed);
  }
  return { byTick, ambiguousTicks };
}

function summarizeHub(hub, runtimeHub) {
  const analytics = objectOrNull(hub);
  const runtime = objectOrNull(runtimeHub);
  if (!analytics) {
    return {
      available: false,
      updatedAt: null,
      distributedSynthesis: summarizeDistributedSynthesis(
        runtime?.distributedSynthesis,
      ),
    };
  }
  const source = analytics;
  return {
    available: true,
    updatedAt: source.updatedAt ?? null,
    enabled: source.enabled ?? false,
    hubRoomName: source.hubRoomName ?? "",
    hubRoomVisible: source.hubRoomVisible ?? false,
    status: source.status ?? null,
    stage: source.stage ?? null,
    activeProduct: source.activeProduct ?? null,
    missingResources: Array.isArray(source.missingResources) ? source.missingResources : [],
    lastError: source.lastError ?? null,
    needsPlan: source.needsPlan ?? false,
    hubStorageEnergy: source.hubStorageEnergy ?? 0,
    hubTerminalEnergy: source.hubTerminalEnergy ?? 0,
    hubInventory: source.hubInventory && typeof source.hubInventory === "object" ? source.hubInventory : {},
    pendingImports: source.pendingImports ?? 0,
    pendingReclaims: source.pendingReclaims ?? 0,
    pendingExports: source.pendingExports ?? 0,
    pendingTaskCount: Array.isArray(source.pendingTasks) ? source.pendingTasks.length : 0,
    roomTerminalBlockers: Array.isArray(source.roomTerminalBlockers) ? source.roomTerminalBlockers : [],
    protectionAttempt: summarizeHubProtectionAttempt(
      source.protectionAttempt,
    ),
    committedProtectionMarker:
      summarizeHubCommittedProtectionMarker(
        source.committedProtectionMarker,
      ),
    distributedSynthesis: summarizeDistributedSynthesis(
      runtime?.distributedSynthesis,
    ),
  };
}

function finiteNumberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function tickAge(referenceTick, eventTick) {
  if (!Number.isFinite(referenceTick) || !Number.isFinite(eventTick)) {
    return null;
  }
  return Math.max(0, referenceTick - eventTick);
}

function summarizeCountMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, count]) => typeof count === "number" && Number.isFinite(count))
      .sort(([leftReason], [rightReason]) => leftReason.localeCompare(rightReason)),
  );
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function boundedStringOrNull(value) {
  return typeof value === "string"
    ? value.slice(0, OBSERVABILITY_STRING_LIMIT)
    : null;
}

function summarizeBoundedStringArrayOrNull(value, limit) {
  if (!Array.isArray(value)) return null;
  const result = [];
  const scanLimit = Math.min(value.length, limit);
  for (let index = 0; index < scanLimit; index += 1) {
    const entry = value[index];
    if (typeof entry === "string") {
      result.push(entry.slice(0, OBSERVABILITY_STRING_LIMIT));
    }
  }
  return result;
}

function hasValidBoundedStringArrayShape(value, limit) {
  if (!Array.isArray(value)) return false;
  const scanLimit = Math.min(value.length, limit);
  for (let index = 0; index < scanLimit; index += 1) {
    if (typeof value[index] !== "string") return false;
  }
  return true;
}

function summarizeDistributedSynthesis(value) {
  const distributed = objectOrNull(value);
  const reconcile = objectOrNull(
    distributed?.configReconcile,
  );
  const blockedTargets = summarizeBoundedStringArrayOrNull(
    distributed?.blockedTargets,
    HUB_DISTRIBUTED_SYNTHESIS_ARRAY_LIMIT,
  );
  const invariantViolations = summarizeBoundedStringArrayOrNull(
    distributed?.invariantViolations,
    HUB_DISTRIBUTED_SYNTHESIS_ARRAY_LIMIT,
  );
  const revision = finiteNumberOrNull(reconcile?.revision);
  const refreshedRooms = summarizeBoundedStringArrayOrNull(
    reconcile?.refreshedRooms,
    HUB_DISTRIBUTED_SYNTHESIS_ARRAY_LIMIT,
  );
  const clearedRooms = summarizeBoundedStringArrayOrNull(
    reconcile?.clearedRooms,
    HUB_DISTRIBUTED_SYNTHESIS_ARRAY_LIMIT,
  );
  const skippedBusyRooms = summarizeBoundedStringArrayOrNull(
    reconcile?.skippedBusyRooms,
    HUB_DISTRIBUTED_SYNTHESIS_ARRAY_LIMIT,
  );
  const foreignOwnerRooms = summarizeBoundedStringArrayOrNull(
    reconcile?.foreignOwnerRooms,
    HUB_DISTRIBUTED_SYNTHESIS_ARRAY_LIMIT,
  );
  const livenessAvailable =
    distributed !== null &&
    hasValidBoundedStringArrayShape(
      distributed.blockedTargets,
      HUB_DISTRIBUTED_SYNTHESIS_ARRAY_LIMIT,
    ) &&
    hasValidBoundedStringArrayShape(
      distributed.invariantViolations,
      HUB_DISTRIBUTED_SYNTHESIS_ARRAY_LIMIT,
    ) &&
    blockedTargets !== null &&
    invariantViolations !== null &&
    reconcile !== null &&
    revision !== null &&
    hasValidBoundedStringArrayShape(
      reconcile.refreshedRooms,
      HUB_DISTRIBUTED_SYNTHESIS_ARRAY_LIMIT,
    ) &&
    hasValidBoundedStringArrayShape(
      reconcile.clearedRooms,
      HUB_DISTRIBUTED_SYNTHESIS_ARRAY_LIMIT,
    ) &&
    hasValidBoundedStringArrayShape(
      reconcile.skippedBusyRooms,
      HUB_DISTRIBUTED_SYNTHESIS_ARRAY_LIMIT,
    ) &&
    hasValidBoundedStringArrayShape(
      reconcile.foreignOwnerRooms,
      HUB_DISTRIBUTED_SYNTHESIS_ARRAY_LIMIT,
    ) &&
    refreshedRooms !== null &&
    clearedRooms !== null &&
    skippedBusyRooms !== null &&
    foreignOwnerRooms !== null;

  return {
    livenessAvailable,
    blockedTargets,
    invariantViolations,
    configReconcile:
      reconcile === null
        ? null
        : {
            revision,
            refreshedRooms,
            clearedRooms,
            skippedBusyRooms,
            foreignOwnerRooms,
          },
  };
}

function finiteNumberWithinOrNull(value, minimum, maximum) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null;
}

function boundedMonitorLogLine(value) {
  if (value.length <= MONITOR_LOG_LINE_LIMIT) {
    return value;
  }
  return (
    value.slice(
      0,
      MONITOR_LOG_LINE_LIMIT -
        MONITOR_LOG_TRUNCATION_SUFFIX.length,
    ) + MONITOR_LOG_TRUNCATION_SUFFIX
  );
}

function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function summarizeRevisionMarker(value) {
  const marker = objectOrNull(value);
  if (!marker) return null;
  return {
    revision: finiteNumberOrNull(marker.revision),
    configIncarnation: finiteNumberOrNull(
      marker.configIncarnation,
    ),
    configFingerprint: boundedStringOrNull(
      marker.configFingerprint,
    ),
  };
}

function summarizeHubProtectionAttempt(value) {
  const attempt = objectOrNull(value);
  if (!attempt) return null;
  return {
    attemptRevision: finiteNumberOrNull(
      attempt.attemptRevision,
    ),
    configIncarnation: finiteNumberOrNull(
      attempt.configIncarnation,
    ),
    startedAt: finiteNumberOrNull(attempt.startedAt),
    finishedAt: finiteNumberOrNull(attempt.finishedAt),
    configFingerprint: boundedStringOrNull(
      attempt.configFingerprint,
    ),
    status: boundedStringOrNull(attempt.status),
    valid: booleanOrNull(attempt.valid),
    reason: boundedStringOrNull(attempt.reason),
  };
}

function summarizeHubCommittedProtectionMarker(value) {
  const snapshot = objectOrNull(value);
  if (!snapshot) return null;
  const marker = objectOrNull(snapshot.marker);
  const components = objectOrNull(snapshot.components);
  const summarizedComponents =
    components === null
      ? null
      : {
          synthesisConfig: summarizeRevisionMarker(
            components.synthesisConfig,
          ),
          transferTasks: summarizeRevisionMarker(
            components.transferTasks,
          ),
          distributed: summarizeRevisionMarker(
            components.distributed,
          ),
          baseMineralSurplus: summarizeRevisionMarker(
            components.baseMineralSurplus,
          ),
        };
  const revisions = [
    finiteNumberOrNull(snapshot.planRevision),
    finiteNumberOrNull(marker?.revision),
    summarizedComponents?.synthesisConfig?.revision,
    summarizedComponents?.transferTasks?.revision,
    summarizedComponents?.distributed?.revision,
    summarizedComponents?.baseMineralSurplus?.revision,
  ];
  const configIncarnations = [
    finiteNumberOrNull(snapshot.configIncarnation),
    finiteNumberOrNull(marker?.configIncarnation),
    summarizedComponents?.synthesisConfig?.configIncarnation,
    summarizedComponents?.transferTasks?.configIncarnation,
    summarizedComponents?.distributed?.configIncarnation,
    summarizedComponents?.baseMineralSurplus?.configIncarnation,
  ];
  const fingerprints = [
    boundedStringOrNull(snapshot.configFingerprint),
    boundedStringOrNull(marker?.configFingerprint),
    summarizedComponents?.synthesisConfig?.configFingerprint,
    summarizedComponents?.transferTasks?.configFingerprint,
    summarizedComponents?.distributed?.configFingerprint,
    summarizedComponents?.baseMineralSurplus?.configFingerprint,
  ];
  const revisionComplete = revisions.every(
    (revision) => revision !== null && revision !== undefined,
  );
  const configIncarnationComplete = configIncarnations.every(
    (incarnation) =>
      incarnation !== null && incarnation !== undefined,
  );
  const fingerprintComplete = fingerprints.every(
    (fingerprint) =>
      fingerprint !== null && fingerprint !== undefined,
  );
  return {
    schema: boundedStringOrNull(snapshot.schema),
    planRevision: finiteNumberOrNull(snapshot.planRevision),
    configIncarnation: finiteNumberOrNull(
      snapshot.configIncarnation,
    ),
    observedAt: finiteNumberOrNull(snapshot.observedAt),
    expiresAt: finiteNumberOrNull(snapshot.expiresAt),
    configFingerprint: boundedStringOrNull(
      snapshot.configFingerprint,
    ),
    status: boundedStringOrNull(snapshot.status),
    valid: booleanOrNull(snapshot.valid),
    marker:
      marker === null
        ? null
        : {
            revision: finiteNumberOrNull(marker.revision),
            configIncarnation: finiteNumberOrNull(
              marker.configIncarnation,
            ),
            configFingerprint: boundedStringOrNull(
              marker.configFingerprint,
            ),
            hubRoomName: boundedStringOrNull(marker.hubRoomName),
            planMode: boundedStringOrNull(marker.planMode),
          },
    components: summarizedComponents,
    consistent:
      revisionComplete &&
      configIncarnationComplete &&
      fingerprintComplete
        ? revisions.every(
            (revision) => revision === revisions[0],
          ) &&
          configIncarnations.every(
            (incarnation) =>
              incarnation === configIncarnations[0],
          ) &&
          fingerprints.every(
            (fingerprint) =>
              fingerprint === fingerprints[0],
          )
        : null,
    failureReason: boundedStringOrNull(snapshot.failureReason),
  };
}

function summarizeCountMapOrNull(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return summarizeCountMap(value);
}

function summarizeCoverageExpirationCountMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { value: null, valid: false };
  }
  const allowedReasons = new Set([
    "automatic_no_progress_timeout",
    "automatic_source_depleted_timeout",
    "automatic_receiver_capacity_coverage_timeout",
  ]);
  const result = {};
  let ownKeyCount = 0;
  for (const reason in value) {
    if (!Object.prototype.hasOwnProperty.call(value, reason)) continue;
    ownKeyCount += 1;
    if (ownKeyCount > allowedReasons.size || !allowedReasons.has(reason)) {
      return { value: result, valid: false };
    }
    const count = value[reason];
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
      return { value: result, valid: false };
    }
    result[reason] = count;
  }
  return { value: result, valid: true };
}

function summarizeCapacityPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    enabled: booleanOrNull(value.enabled),
    terminalHeadroomRecoveryEnabled: booleanOrNull(value.terminalHeadroomRecoveryEnabled),
    storagePressureFreeCapacity: finiteNumberOrNull(value.storagePressureFreeCapacity),
    storageReliefTargetFreeCapacity: finiteNumberOrNull(value.storageReliefTargetFreeCapacity),
    receiverStorageMinFreeCapacity: finiteNumberOrNull(value.receiverStorageMinFreeCapacity),
    terminalPressureFreeCapacity: finiteNumberOrNull(value.terminalPressureFreeCapacity),
    terminalReliefTargetFreeCapacity: finiteNumberOrNull(value.terminalReliefTargetFreeCapacity),
    receiverTerminalMinFreeCapacity: finiteNumberOrNull(value.receiverTerminalMinFreeCapacity),
  };
}

function summarizeCapacityReservation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    committed: finiteNumberOrNull(value.committed),
    remaining: finiteNumberOrNull(value.remaining),
  };
}

function summarizeStaging(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    admittedAmount: finiteNumberOrNull(value.admittedAmount),
    admittedTaskCount: finiteNumberOrNull(value.admittedTaskCount),
    admittedByResource: summarizeCountMap(value.admittedByResource),
    suppressedCount: finiteNumberOrNull(value.suppressedCount),
    suppressedByReason: summarizeCountMap(value.suppressedByReason),
  };
}

function summarizeTaskHealth(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    pendingIncoming: finiteNumberOrNull(value.pendingIncoming),
    pendingOutgoing: finiteNumberOrNull(value.pendingOutgoing),
    blockedIncoming: summarizeCountMap(value.blockedIncoming),
    blockedOutgoing: summarizeCountMap(value.blockedOutgoing),
  };
}

function summarizeMarketEnergyReadiness(value) {
  const readiness = objectOrNull(value);
  if (!readiness) return null;
  return {
    schemaVersion: finiteNumberOrNull(
      readiness.schemaVersion,
    ),
    revision: boundedStringOrNull(readiness.revision),
    observedAt: finiteNumberOrNull(readiness.observedAt),
    expiresAt: finiteNumberOrNull(readiness.expiresAt),
    authorizationRevision: boundedStringOrNull(
      readiness.authorizationRevision,
    ),
    roomInstanceId: boundedStringOrNull(
      readiness.roomInstanceId,
    ),
    terminalId: boundedStringOrNull(readiness.terminalId),
    authorized: booleanOrNull(readiness.authorized),
    effectivePostDealEnergyReserve: finiteNumberOrNull(
      readiness.effectivePostDealEnergyReserve,
    ),
    marketTerminalEnergyTarget: finiteNumberOrNull(
      readiness.marketTerminalEnergyTarget,
    ),
    ordinaryTerminalEnergyTarget: finiteNumberOrNull(
      readiness.ordinaryTerminalEnergyTarget,
    ),
    unresolvedEnergySendAmount: finiteNumberOrNull(
      readiness.unresolvedEnergySendAmount,
    ),
    unresolvedInternalSendFees: finiteNumberOrNull(
      readiness.unresolvedInternalSendFees,
    ),
    terminalScopedProductionEnergyCommitments:
      finiteNumberOrNull(
        readiness.terminalScopedProductionEnergyCommitments,
      ),
    maxTransactionEnergy: finiteNumberOrNull(
      readiness.maxTransactionEnergy,
    ),
    contributionCount: finiteNumberOrNull(
      readiness.contributionCount,
    ),
    desiredTerminalEnergy: finiteNumberOrNull(
      readiness.desiredTerminalEnergy,
    ),
    plannedFeedAmount: finiteNumberOrNull(
      readiness.plannedFeedAmount,
    ),
    status: boundedStringOrNull(readiness.status),
    blocker: boundedStringOrNull(readiness.blocker),
  };
}

function summarizeTaskSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const demandCoveringIncoming = finiteNumberOrNull(
    value.demandCoveringIncoming,
  );
  const coverageExpiredIncoming = finiteNumberOrNull(
    value.coverageExpiredIncoming,
  );
  const coverageExpirationSummary = summarizeCoverageExpirationCountMap(
    value.coverageExpiredByReason,
  );
  const coverageExpiredByReason = coverageExpirationSummary.value;
  const livenessAvailable =
    demandCoveringIncoming !== null &&
    demandCoveringIncoming >= 0 &&
    coverageExpiredIncoming !== null &&
    coverageExpiredIncoming >= 0 &&
    coverageExpirationSummary.valid;
  return {
    pending: finiteNumberOrNull(value.pending),
    manualPending: finiteNumberOrNull(value.manualPending),
    automaticPending: finiteNumberOrNull(value.automaticPending),
    blockedByReason: summarizeCountMap(value.blockedByReason),
    livenessAvailable,
    demandCoveringIncoming,
    coverageExpiredIncoming,
    coverageExpiredByReason,
  };
}

function summarizeCapacityReliefRoutes(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((route) => route && typeof route === "object" && !Array.isArray(route))
    .slice(-RESOURCE_CONTROL_ROUTE_LIMIT)
    .map((route) => ({
      tick: finiteNumberOrNull(route.tick),
      taskId: typeof route.taskId === "string" ? route.taskId : null,
      fromRoomName: typeof route.fromRoomName === "string" ? route.fromRoomName : null,
      toRoomName: typeof route.toRoomName === "string" ? route.toRoomName : null,
      resource: typeof route.resource === "string" ? route.resource : null,
      amount: finiteNumberOrNull(route.amount),
      transferCost: finiteNumberOrNull(route.transferCost),
    }));
}

function nonNegativeSafeIntegerOrNull(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? value
    : null;
}

function serializedUtf8ByteLengthOrNull(value) {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string"
      ? Buffer.byteLength(serialized, "utf8")
      : null;
  } catch {
    return null;
  }
}

function summarizeLogisticsDataUsage(value) {
  const store = objectOrNull(value);
  if (!store) {
    return { valid: false, itemCount: null, utf8Bytes: null };
  }
  const strings = store.s;
  const intents = store.i;
  const observations = store.o;
  const facts = store.f;
  const snapshots = store.p;
  const utf8Bytes = serializedUtf8ByteLengthOrNull(store);
  const collectionsValid =
    Array.isArray(strings) &&
    strings.length <= RESOURCE_CONTROL_LOGISTICS_COMPACT_STRING_LIMIT &&
    Array.isArray(intents) &&
    intents.length <= RESOURCE_CONTROL_LOGISTICS_STORE_LIMIT &&
    Array.isArray(observations) &&
    observations.length <= RESOURCE_CONTROL_LOGISTICS_STORE_LIMIT &&
    Array.isArray(facts) &&
    facts.length <= RESOURCE_CONTROL_LOGISTICS_STORE_LIMIT &&
    Array.isArray(snapshots) &&
    snapshots.length <= RESOURCE_CONTROL_LOGISTICS_STORE_LIMIT;
  const itemCount = collectionsValid
    ? (2 * intents.length) + observations.length + facts.length + snapshots.length
    : null;
  if (!collectionsValid) {
    return { valid: false, itemCount, utf8Bytes };
  }

  const topKeys = Object.keys(store);
  let valid =
    store.schemaVersion === 1 &&
    store.wireFormat === "compact-v1" &&
    nonNegativeSafeIntegerOrNull(store.c) !== null &&
    topKeys.length === RESOURCE_CONTROL_LOGISTICS_COMPACT_WIRE_KEYS.length &&
    topKeys.every(
      (key, index) =>
        key === RESOURCE_CONTROL_LOGISTICS_COMPACT_WIRE_KEYS[index],
    ) &&
    strings.every(
      (entry) =>
        typeof entry === "string" &&
        entry.length > 0 &&
        entry.length <= RESOURCE_CONTROL_LOGISTICS_COMPACT_STRING_LIMIT,
    );

  const readString = (index) => {
    const normalized = nonNegativeSafeIntegerOrNull(
      index,
      strings.length - 1,
    );
    return normalized === null ? null : strings[normalized];
  };
  const isUnsigned = (entry, maximum = Number.MAX_SAFE_INTEGER) =>
    nonNegativeSafeIntegerOrNull(entry, maximum) !== null;
  const isOptionalUnsigned = (entry) => entry === null || isUnsigned(entry);
  const isEnumIndex = (entry, count) => isUnsigned(entry, count - 1);
  const isRecordString = (entry) =>
    typeof entry === "string" &&
    entry.length > 0 &&
    entry.length <= OBSERVABILITY_STRING_LIMIT;
  const isRoomName = (entry) =>
    typeof entry === "string" && /^[WE]\d+[NS]\d+$/.test(entry);
  const compareCanonicalStrings = (left, right) =>
    left < right ? -1 : left > right ? 1 : 0;
  const isCanonicalSortedUnique = (entries) =>
    entries.every(
      (entry, index) =>
        index === 0 ||
        compareCanonicalStrings(entries[index - 1], entry) < 0,
    );

  // The producer encodes a canonical intern table. Replaying the exact field
  // traversal here rejects unused, duplicate, reordered, or aliased indexes.
  const canonicalStrings = [];
  const canonicalIndexes = new Map();
  const useStringIndex = (index) => {
    const entry = readString(index);
    if (entry === null) {
      valid = false;
      return null;
    }
    let canonicalIndex = canonicalIndexes.get(entry);
    if (canonicalIndex === undefined) {
      canonicalIndex = canonicalStrings.length;
      canonicalIndexes.set(entry, canonicalIndex);
      canonicalStrings.push(entry);
    }
    if (index !== canonicalIndex) valid = false;
    return entry;
  };
  const useOptionalStringIndex = (index) =>
    index === null ? null : useStringIndex(index);

  const intentKeys = [];
  const intentMetadata = [];
  let maximumIntentGeneration = 0;
  for (const tuple of intents) {
    if (!Array.isArray(tuple) || tuple.length !== 18) {
      valid = false;
      continue;
    }
    const producer = useStringIndex(tuple[0]);
    const demandKey = useStringIndex(tuple[1]);
    const targetRoomName = useStringIndex(tuple[6]);
    const resource = useStringIndex(tuple[7]);
    const fixedSourceIndexes = tuple[14];
    const fixedSourceRoomNames = [];
    if (fixedSourceIndexes !== null) {
      if (
        !Array.isArray(fixedSourceIndexes) ||
        fixedSourceIndexes.length > RESOURCE_CONTROL_LOGISTICS_STORE_LIMIT
      ) {
        valid = false;
      } else {
        for (const index of fixedSourceIndexes) {
          const roomName = useStringIndex(index);
          if (roomName !== null) fixedSourceRoomNames.push(roomName);
        }
      }
    }
    const product = useOptionalStringIndex(tuple[17]);

    if (
      !isRecordString(producer) ||
      !isRecordString(demandKey) ||
      !isUnsigned(tuple[2]) ||
      tuple[2] === 0 ||
      !isUnsigned(tuple[3]) ||
      tuple[3] === 0 ||
      !isEnumIndex(tuple[4], RESOURCE_CONTROL_LOGISTICS_ORIGINS.size) ||
      (tuple[5] !== 0 && tuple[5] !== 1) ||
      !isRoomName(targetRoomName) ||
      !RESOURCE_CONTROL_LOGISTICS_RESOURCES.has(resource) ||
      !isUnsigned(tuple[8]) ||
      !isEnumIndex(
        tuple[9],
        RESOURCE_CONTROL_LOGISTICS_PRIORITY_CLASS_COUNT,
      ) ||
      !isUnsigned(tuple[10]) ||
      !isUnsigned(tuple[11]) ||
      !isUnsigned(tuple[12]) ||
      tuple[10] > tuple[11] ||
      tuple[11] > tuple[12] ||
      !isOptionalUnsigned(tuple[13]) ||
      !isOptionalUnsigned(tuple[15]) ||
      !isOptionalUnsigned(tuple[16]) ||
      (tuple[15] !== null &&
        tuple[16] !== null &&
        tuple[15] > tuple[16]) ||
      fixedSourceRoomNames.some((roomName) => !isRoomName(roomName)) ||
      !isCanonicalSortedUnique(fixedSourceRoomNames) ||
      (product !== null &&
        !RESOURCE_CONTROL_LOGISTICS_RESOURCES.has(product))
    ) {
      valid = false;
    }
    if (producer !== null && demandKey !== null) {
      intentKeys.push(
        JSON.stringify(["logistics-intent/v1", producer, demandKey]),
      );
    }
    intentMetadata.push({
      producer,
      generation: tuple[2],
      expiresAt: tuple[12],
    });
    if (isUnsigned(tuple[2])) {
      maximumIntentGeneration = Math.max(
        maximumIntentGeneration,
        tuple[2],
      );
    }
  }
  if (!isCanonicalSortedUnique(intentKeys)) valid = false;

  let previousObservationIntentIndex = -1;
  const observationOrdersByProducer = new Map();
  for (const tuple of observations) {
    if (!Array.isArray(tuple) || tuple.length !== 17) {
      valid = false;
      continue;
    }
    const intentIndex = tuple[0];
    useStringIndex(tuple[1]);
    const legacySourceRoomName = useOptionalStringIndex(tuple[11]);
    useOptionalStringIndex(tuple[13]);
    if (
      !isUnsigned(intentIndex, intents.length - 1) ||
      intentIndex <= previousObservationIntentIndex ||
      !isUnsigned(tuple[2]) ||
      !isUnsigned(tuple[3]) ||
      !isUnsigned(tuple[4]) ||
      !isUnsigned(tuple[5], RESOURCE_CONTROL_LOGISTICS_STORE_LIMIT - 1) ||
      !isUnsigned(tuple[6]) ||
      !isEnumIndex(
        tuple[7],
        RESOURCE_CONTROL_LOGISTICS_OBSERVATION_REASON_COUNT,
      ) ||
      !isEnumIndex(
        tuple[8],
        RESOURCE_CONTROL_LOGISTICS_LEGACY_DECISION_COUNT,
      ) ||
      !isUnsigned(tuple[9]) ||
      !isEnumIndex(
        tuple[10],
        RESOURCE_CONTROL_LOGISTICS_PRIORITY_CLASS_COUNT,
      ) ||
      (legacySourceRoomName !== null &&
        !isRoomName(legacySourceRoomName)) ||
      !isOptionalUnsigned(tuple[12]) ||
      !isOptionalUnsigned(tuple[14]) ||
      !isOptionalUnsigned(tuple[15]) ||
      !isOptionalUnsigned(tuple[16])
    ) {
      valid = false;
    }
    if (isUnsigned(intentIndex)) previousObservationIntentIndex = intentIndex;
    const observationProducer = isUnsigned(
      intentIndex,
      intentMetadata.length - 1,
    )
      ? intentMetadata[intentIndex]?.producer
      : null;
    if (isRecordString(observationProducer) && isUnsigned(tuple[5])) {
      const orders = observationOrdersByProducer.get(observationProducer) ||
        new Set();
      if (orders.has(tuple[5])) valid = false;
      orders.add(tuple[5]);
      observationOrdersByProducer.set(observationProducer, orders);
    }
  }

  const factRoomNames = [];
  for (const tuple of facts) {
    if (!Array.isArray(tuple) || tuple.length !== 16) {
      valid = false;
      continue;
    }
    const roomName = useStringIndex(tuple[0]);
    useStringIndex(tuple[2]);
    useStringIndex(tuple[3]);
    const resources = tuple[15];
    const resourceNames = [];
    if (
      !Array.isArray(resources) ||
      resources.length > RESOURCE_CONTROL_LOGISTICS_STORE_LIMIT
    ) {
      valid = false;
    } else {
      for (const resourceTuple of resources) {
        if (!Array.isArray(resourceTuple) || resourceTuple.length !== 4) {
          valid = false;
          continue;
        }
        const resource = useStringIndex(resourceTuple[0]);
        if (resource !== null) resourceNames.push(resource);
        if (
          !RESOURCE_CONTROL_LOGISTICS_RESOURCES.has(resource) ||
          !isUnsigned(resourceTuple[1]) ||
          !isUnsigned(resourceTuple[2]) ||
          resourceTuple[2] > resourceTuple[1] ||
          !isUnsigned(resourceTuple[3])
        ) {
          valid = false;
        }
      }
      if (!isCanonicalSortedUnique(resourceNames)) valid = false;
    }
    if (
      !isRoomName(roomName) ||
      !isUnsigned(tuple[1]) ||
      tuple[1] === 0 ||
      !isUnsigned(tuple[4]) ||
      !isUnsigned(tuple[5]) ||
      tuple[4] > tuple[5] ||
      !isUnsigned(tuple[6], 31) ||
      !isUnsigned(tuple[7]) ||
      !isEnumIndex(
        tuple[8],
        RESOURCE_CONTROL_LOGISTICS_CAPACITY_STATE_COUNT,
      ) ||
      !isUnsigned(tuple[9]) ||
      !isUnsigned(tuple[10]) ||
      !isUnsigned(tuple[11]) ||
      !isUnsigned(tuple[12]) ||
      tuple[12] === 0 ||
      !isUnsigned(tuple[13]) ||
      !isUnsigned(tuple[14]) ||
      tuple[14] > tuple[13]
    ) {
      valid = false;
    }
    if (roomName !== null) factRoomNames.push(roomName);
  }
  if (!isCanonicalSortedUnique(factRoomNames)) valid = false;

  const snapshotProducers = [];
  const snapshotMetadata = new Map();
  for (const tuple of snapshots) {
    if (!Array.isArray(tuple) || tuple.length !== 12) {
      valid = false;
      continue;
    }
    const producer = useStringIndex(tuple[0]);
    useStringIndex(tuple[1]);
    useStringIndex(tuple[2]);
    if (
      !isRecordString(producer) ||
      !isUnsigned(tuple[3]) ||
      !isUnsigned(tuple[4]) ||
      tuple[3] > tuple[4] ||
      typeof tuple[5] !== "number" ||
      !Number.isFinite(tuple[5]) ||
      tuple[5] < 0 ||
      !isUnsigned(tuple[6], RESOURCE_CONTROL_LOGISTICS_STORE_LIMIT) ||
      !isUnsigned(tuple[7]) ||
      !isUnsigned(tuple[8], RESOURCE_CONTROL_LOGISTICS_STORE_LIMIT) ||
      tuple[8] > tuple[7] ||
      !isUnsigned(tuple[9]) ||
      tuple[9] !== tuple[7] - tuple[8] ||
      tuple[10] !== RESOURCE_CONTROL_LOGISTICS_STORE_LIMIT ||
      (tuple[11] !== 0 && tuple[11] !== 1) ||
      tuple[11] !== (tuple[9] > 0 ? 1 : 0)
    ) {
      valid = false;
    }
    if (producer !== null) {
      snapshotProducers.push(producer);
      snapshotMetadata.set(producer, {
        expiresAt: tuple[4],
        emitted: tuple[8],
        truncated: tuple[11] === 1,
      });
    }
  }
  if (!isCanonicalSortedUnique(snapshotProducers)) valid = false;

  const intentStatsByProducer = new Map();
  for (const metadata of intentMetadata) {
    if (
      !isRecordString(metadata.producer) ||
      !isUnsigned(metadata.expiresAt)
    ) {
      continue;
    }
    const stats = intentStatsByProducer.get(metadata.producer) || {
      count: 0,
      expiresAt: 0,
    };
    stats.count += 1;
    stats.expiresAt = Math.max(stats.expiresAt, metadata.expiresAt);
    intentStatsByProducer.set(metadata.producer, stats);
  }
  if (maximumIntentGeneration > store.c) valid = false;
  for (const [producer, stats] of intentStatsByProducer) {
    const snapshot = snapshotMetadata.get(producer);
    if (
      !snapshot ||
      snapshot.emitted !== stats.count ||
      snapshot.expiresAt < stats.expiresAt
    ) {
      valid = false;
    }
  }
  for (const [producer, snapshot] of snapshotMetadata) {
    const expectedIntentCount =
      intentStatsByProducer.get(producer)?.count || 0;
    if (snapshot.emitted !== expectedIntentCount) valid = false;
    if (!snapshot.truncated) {
      const orders = [
        ...(observationOrdersByProducer.get(producer) || []),
      ].sort((left, right) => left - right);
      if (orders.some((order, index) => order !== index)) valid = false;
    }
  }

  valid =
    valid &&
    canonicalStrings.length === strings.length &&
    canonicalStrings.every((entry, index) => entry === strings[index]) &&
    itemCount !== null &&
    itemCount <= RESOURCE_CONTROL_LOGISTICS_DATA_ITEM_LIMIT &&
    utf8Bytes !== null &&
    utf8Bytes <= RESOURCE_CONTROL_LOGISTICS_DATA_BYTE_LIMIT;
  return {
    valid,
    itemCount,
    utf8Bytes,
  };
}

function hasOnlyAllowedOwnKeys(value, allowedKeys) {
  const record = objectOrNull(value);
  if (!record) return false;
  const allowed = allowedKeys instanceof Set ? allowedKeys : new Set(allowedKeys);
  return Object.keys(record).every((key) => allowed.has(key));
}

function summarizeClosedNonNegativeIntegerMap(
  value,
  allowedKeys,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  const record = objectOrNull(value);
  if (!record) return { value: null, valid: false };
  const result = {};
  let valid = true;
  for (const [key, count] of Object.entries(record).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (!allowedKeys.has(key)) {
      valid = false;
      continue;
    }
    const normalized = nonNegativeSafeIntegerOrNull(count, maximum);
    if (normalized === null) {
      valid = false;
      continue;
    }
    result[key] = normalized;
  }
  return { value: result, valid };
}

function summarizeStrictBoundedStringArray(value, allowedValues = null) {
  if (!Array.isArray(value)) return { value: null, valid: false };
  const result = [];
  let valid = value.length <= RESOURCE_CONTROL_LOGISTICS_ARRAY_LIMIT;
  const seen = new Set();
  for (const entry of value.slice(0, RESOURCE_CONTROL_LOGISTICS_ARRAY_LIMIT)) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > OBSERVABILITY_STRING_LIMIT ||
      (allowedValues && !allowedValues.has(entry)) ||
      seen.has(entry)
    ) {
      valid = false;
      if (typeof entry === "string") {
        result.push(entry.slice(0, OBSERVABILITY_STRING_LIMIT));
      }
      continue;
    }
    seen.add(entry);
    result.push(entry);
  }
  return { value: result, valid };
}

function summarizeLogisticsDimension(value) {
  const dimension = objectOrNull(value);
  const allowedKeys = new Set(["matched", "different", "unresolved"]);
  const matched = nonNegativeSafeIntegerOrNull(
    dimension?.matched,
    RESOURCE_CONTROL_LOGISTICS_INTENT_LIMIT,
  );
  const different = nonNegativeSafeIntegerOrNull(
    dimension?.different,
    RESOURCE_CONTROL_LOGISTICS_INTENT_LIMIT,
  );
  const unresolved = nonNegativeSafeIntegerOrNull(
    dimension?.unresolved,
    RESOURCE_CONTROL_LOGISTICS_INTENT_LIMIT,
  );
  return {
    value: dimension
      ? { matched, different, unresolved }
      : null,
    valid:
      dimension !== null &&
      hasOnlyAllowedOwnKeys(dimension, allowedKeys) &&
      matched !== null &&
      different !== null &&
      unresolved !== null,
  };
}

function isScreepsRoomName(value) {
  return typeof value === "string" &&
    /^[WE]\d+[NS]\d+$/.test(value);
}

function positiveSafeIntegerOrNull(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum
    ? value
    : null;
}

function summarizeLogisticsComparisonSampleV1(value) {
  const sample = objectOrNull(value);
  if (!sample) return { value: null, valid: false };
  const intentId = boundedStringOrNull(sample.intentId);
  const status = RESOURCE_CONTROL_LOGISTICS_SAMPLE_STATUSES.has(sample.status)
    ? sample.status
    : null;
  const reason = RESOURCE_CONTROL_LOGISTICS_COMPARISON_REASONS.has(sample.reason)
    ? sample.reason
    : null;
  const differingDimensions = summarizeStrictBoundedStringArray(
    sample.differingDimensions,
    new Set(RESOURCE_CONTROL_LOGISTICS_DIMENSIONS),
  );
  const legacySourceRoomName = boundedStringOrNull(
    sample.legacySourceRoomName,
  );
  const shadowSourceRoomName = boundedStringOrNull(
    sample.shadowSourceRoomName,
  );
  const predictedStagingEligibility =
    RESOURCE_CONTROL_LOGISTICS_STAGING_ELIGIBILITY.has(
      sample.predictedStagingEligibility,
    )
      ? sample.predictedStagingEligibility
      : null;
  const requiredStringsValid =
    typeof sample.intentId === "string" &&
    sample.intentId.length > 0 &&
    sample.intentId.length <= OBSERVABILITY_STRING_LIMIT;
  const optionalStringsValid =
    (sample.legacySourceRoomName === undefined ||
      (typeof sample.legacySourceRoomName === "string" &&
        sample.legacySourceRoomName.length > 0 &&
        sample.legacySourceRoomName.length <= OBSERVABILITY_STRING_LIMIT)) &&
    (sample.shadowSourceRoomName === undefined ||
      (typeof sample.shadowSourceRoomName === "string" &&
        sample.shadowSourceRoomName.length > 0 &&
        sample.shadowSourceRoomName.length <= OBSERVABILITY_STRING_LIMIT));
  const statusReasonValid =
    (status === "equal" &&
      reason === "equal" &&
      differingDimensions.value?.length === 0) ||
    (status === "different" &&
      RESOURCE_CONTROL_LOGISTICS_DIFFERENCE_REASONS.has(reason) &&
      (differingDimensions.value?.length ?? 0) > 0) ||
    (status === "unresolved" &&
      RESOURCE_CONTROL_LOGISTICS_UNRESOLVED_REASONS.has(reason));
  return {
    value: {
      intentId,
      status,
      reason,
      differingDimensions: differingDimensions.value,
      legacySourceRoomName,
      shadowSourceRoomName,
      predictedStagingEligibility,
    },
    valid:
      hasOnlyAllowedOwnKeys(sample, new Set([
        "intentId",
        "status",
        "reason",
        "differingDimensions",
        "legacySourceRoomName",
        "shadowSourceRoomName",
        "predictedStagingEligibility",
      ])) &&
      requiredStringsValid &&
      optionalStringsValid &&
      status !== null &&
      reason !== null &&
      statusReasonValid &&
      differingDimensions.valid &&
      predictedStagingEligibility !== null,
  };
}

function summarizeLogisticsRouteOutcomeV2(value) {
  const route = objectOrNull(value);
  if (!route || route.kind !== "route") {
    return { value: null, valid: false };
  }
  const sourceRoomName = isScreepsRoomName(route.sourceRoomName)
    ? route.sourceRoomName
    : null;
  const coverage = RESOURCE_CONTROL_LOGISTICS_COVERAGE.has(route.coverage)
    ? route.coverage
    : null;
  const capacity = RESOURCE_CONTROL_LOGISTICS_STAGING_ELIGIBILITY.has(
    route.capacity,
  )
    ? route.capacity
    : null;
  const staging = RESOURCE_CONTROL_LOGISTICS_STAGING_ELIGIBILITY.has(
    route.staging,
  )
    ? route.staging
    : null;
  const amount = positiveSafeIntegerOrNull(route.amount);
  const actionAmount = nonNegativeSafeIntegerOrNull(route.actionAmount);
  const feeAmount = nonNegativeSafeIntegerOrNull(route.feeAmount);
  const terminalReadyAt = nonNegativeSafeIntegerOrNull(
    route.terminalReadyAt,
  );
  const requiredEnergy = nonNegativeSafeIntegerOrNull(
    route.requiredEnergy,
  );
  const energyCommitmentAmount = nonNegativeSafeIntegerOrNull(
    route.energyCommitmentAmount,
  );
  const terminalAllocatedAmount = nonNegativeSafeIntegerOrNull(
    route.terminalAllocatedAmount,
  );
  const stagingRequiredAmount = nonNegativeSafeIntegerOrNull(
    route.stagingRequiredAmount,
  );
  const terminalEnergyAllocatedAmount = nonNegativeSafeIntegerOrNull(
    route.terminalEnergyAllocatedAmount,
  );
  const feeStagingRequiredAmount = nonNegativeSafeIntegerOrNull(
    route.feeStagingRequiredAmount,
  );
  return {
    value: {
      kind: "route",
      sourceRoomName,
      coverage,
      capacity,
      staging,
      amount,
      actionAmount,
      feeAmount,
      terminalReadyAt,
      requiredEnergy,
      energyCommitmentAmount,
      terminalAllocatedAmount,
      stagingRequiredAmount,
      terminalEnergyAllocatedAmount,
      feeStagingRequiredAmount,
    },
    valid:
      hasOnlyAllowedOwnKeys(route, new Set([
        "kind",
        "sourceRoomName",
        "coverage",
        "capacity",
        "staging",
        "amount",
        "actionAmount",
        "feeAmount",
        "terminalReadyAt",
        "requiredEnergy",
        "energyCommitmentAmount",
        "terminalAllocatedAmount",
        "stagingRequiredAmount",
        "terminalEnergyAllocatedAmount",
        "feeStagingRequiredAmount",
      ])) &&
      sourceRoomName !== null &&
      coverage !== null &&
      (coverage === "covered" || coverage === "partial") &&
      capacity !== null &&
      staging !== null &&
      amount !== null &&
      actionAmount !== null &&
      actionAmount <= amount &&
      feeAmount !== null &&
      terminalReadyAt !== null &&
      requiredEnergy !== null &&
      energyCommitmentAmount !== null &&
      energyCommitmentAmount >= requiredEnergy &&
      terminalAllocatedAmount !== null &&
      stagingRequiredAmount !== null &&
      terminalAllocatedAmount + stagingRequiredAmount === actionAmount &&
      terminalEnergyAllocatedAmount !== null &&
      terminalEnergyAllocatedAmount <= requiredEnergy &&
      feeStagingRequiredAmount !== null &&
      feeStagingRequiredAmount <= feeAmount,
  };
}

function summarizeLogisticsLegacyOutcomeV2(value) {
  const outcome = objectOrNull(value);
  if (!outcome) return { value: null, valid: false };
  if (outcome.kind === "route") {
    return summarizeLogisticsRouteOutcomeV2(outcome);
  }
  const blocker = RESOURCE_CONTROL_LOGISTICS_UNMATCHED_REASONS.has(
    outcome.blocker,
  )
    ? outcome.blocker
    : null;
  const coverage = RESOURCE_CONTROL_LOGISTICS_COVERAGE.has(
    outcome.coverage,
  )
    ? outcome.coverage
    : null;
  const capacity = RESOURCE_CONTROL_LOGISTICS_STAGING_ELIGIBILITY.has(
    outcome.capacity,
  )
    ? outcome.capacity
    : null;
  const staging = RESOURCE_CONTROL_LOGISTICS_STAGING_ELIGIBILITY.has(
    outcome.staging,
  )
    ? outcome.staging
    : null;
  return {
    value: {
      kind: outcome.kind === "none" ? "none" : null,
      blocker,
      coverage,
      capacity,
      staging,
    },
    valid:
      outcome.kind === "none" &&
      hasOnlyAllowedOwnKeys(outcome, new Set([
        "kind",
        "blocker",
        "coverage",
        "capacity",
        "staging",
      ])) &&
      blocker !== null &&
      coverage !== null &&
      capacity !== null &&
      staging !== null,
  };
}

function summarizeLogisticsShadowOutcomeV2(value) {
  const outcome = objectOrNull(value);
  if (!outcome) return { value: null, valid: false };
  if (outcome.kind === "route") {
    return summarizeLogisticsRouteOutcomeV2(outcome);
  }
  const reason = RESOURCE_CONTROL_LOGISTICS_UNMATCHED_REASONS.has(
    outcome.reason,
  )
    ? outcome.reason
    : null;
  const coverage = RESOURCE_CONTROL_LOGISTICS_COVERAGE.has(
    outcome.coverage,
  )
    ? outcome.coverage
    : null;
  const capacity = RESOURCE_CONTROL_LOGISTICS_STAGING_ELIGIBILITY.has(
    outcome.capacity,
  )
    ? outcome.capacity
    : null;
  const staging = RESOURCE_CONTROL_LOGISTICS_STAGING_ELIGIBILITY.has(
    outcome.staging,
  )
    ? outcome.staging
    : null;
  const uncoveredAmount = nonNegativeSafeIntegerOrNull(
    outcome.uncoveredAmount,
  );
  return {
    value: {
      kind: outcome.kind === "unmatched" ? "unmatched" : null,
      reason,
      coverage,
      capacity,
      staging,
      uncoveredAmount,
    },
    valid:
      outcome.kind === "unmatched" &&
      hasOnlyAllowedOwnKeys(outcome, new Set([
        "kind",
        "reason",
        "coverage",
        "capacity",
        "staging",
        "uncoveredAmount",
      ])) &&
      reason !== null &&
      coverage !== null &&
      capacity !== null &&
      staging !== null &&
      uncoveredAmount !== null,
  };
}

function summarizeLogisticsCandidateTraceV2(value) {
  const candidate = objectOrNull(value);
  if (!candidate) {
    return { value: null, valid: false, rejectionTupleCount: 0 };
  }
  const donorCount = nonNegativeSafeIntegerOrNull(
    candidate.donorCount,
    RESOURCE_CONTROL_LOGISTICS_STORE_LIMIT / 2,
  );
  const evaluatedCount = nonNegativeSafeIntegerOrNull(
    candidate.evaluatedCount,
    RESOURCE_CONTROL_LOGISTICS_STORE_LIMIT / 2,
  );
  const feasibleCount = nonNegativeSafeIntegerOrNull(
    candidate.feasibleCount,
    RESOURCE_CONTROL_LOGISTICS_STORE_LIMIT / 2,
  );
  const rejectedCount = nonNegativeSafeIntegerOrNull(
    candidate.rejectedCount,
    RESOURCE_CONTROL_LOGISTICS_STORE_LIMIT / 2,
  );
  const selectedRejection = candidate.selectedRejection === undefined
    ? null
    : RESOURCE_CONTROL_LOGISTICS_CANDIDATE_REJECTIONS.has(
        candidate.selectedRejection,
      )
      ? candidate.selectedRejection
      : undefined;
  const rejectionCounts = [];
  let rejectionCountsValid = Array.isArray(candidate.rejectionCounts) &&
    candidate.rejectionCounts.length <=
      RESOURCE_CONTROL_LOGISTICS_CANDIDATE_REJECTION_ORDER.length;
  let previousRejectionIndex = -1;
  let rejectionTotal = 0;
  for (const tuple of Array.isArray(candidate.rejectionCounts)
    ? candidate.rejectionCounts
    : []) {
    if (!Array.isArray(tuple) || tuple.length !== 2) {
      rejectionCountsValid = false;
      continue;
    }
    const [reason, rawCount] = tuple;
    const reasonIndex =
      RESOURCE_CONTROL_LOGISTICS_CANDIDATE_REJECTION_ORDER.indexOf(
        reason,
      );
    const count = positiveSafeIntegerOrNull(rawCount);
    if (reasonIndex <= previousRejectionIndex || count === null) {
      rejectionCountsValid = false;
      continue;
    }
    previousRejectionIndex = reasonIndex;
    rejectionTotal += count;
    rejectionCounts.push([reason, count]);
  }

  const topSourceRoom = candidate.topSourceRoom === undefined
    ? null
    : isScreepsRoomName(candidate.topSourceRoom)
      ? candidate.topSourceRoom
      : undefined;
  const legacySourceRecord = candidate.legacySource === undefined
    ? null
    : objectOrNull(candidate.legacySource);
  let legacySource = null;
  let legacySourceValid = candidate.legacySource === undefined;
  if (legacySourceRecord) {
    const sourceRoom = isScreepsRoomName(legacySourceRecord.sourceRoom)
      ? legacySourceRecord.sourceRoom
      : null;
    const disposition =
      RESOURCE_CONTROL_LOGISTICS_LEGACY_SOURCE_DISPOSITIONS.has(
        legacySourceRecord.disposition,
      )
        ? legacySourceRecord.disposition
        : null;
    const rejection = legacySourceRecord.rejection === undefined
      ? null
      : RESOURCE_CONTROL_LOGISTICS_CANDIDATE_REJECTIONS.has(
          legacySourceRecord.rejection,
        )
        ? legacySourceRecord.rejection
        : undefined;
    legacySource = { sourceRoom, disposition, rejection };
    legacySourceValid =
      hasOnlyAllowedOwnKeys(legacySourceRecord, new Set([
        "sourceRoom",
        "disposition",
        "rejection",
      ])) &&
      sourceRoom !== null &&
      disposition !== null &&
      rejection !== undefined &&
      (disposition === "rejected"
        ? rejection !== null
        : rejection === null);
  }

  const receiverRecord = objectOrNull(candidate.receiver);
  let receiver = null;
  let receiverValid = false;
  if (receiverRecord?.kind === "missing") {
    receiver = { kind: "missing" };
    receiverValid = hasOnlyAllowedOwnKeys(
      receiverRecord,
      new Set(["kind"]),
    );
  } else if (receiverRecord?.kind === "present") {
    const receiverEligible = booleanOrNull(
      receiverRecord.receiverEligible,
    );
    const storageHeadroom = nonNegativeSafeIntegerOrNull(
      receiverRecord.storageHeadroom,
    );
    const terminalHeadroom = nonNegativeSafeIntegerOrNull(
      receiverRecord.terminalHeadroom,
    );
    const resourceHeadroom = nonNegativeSafeIntegerOrNull(
      receiverRecord.resourceHeadroom,
    );
    receiver = {
      kind: "present",
      receiverEligible,
      storageHeadroom,
      terminalHeadroom,
      resourceHeadroom,
    };
    receiverValid = hasOnlyAllowedOwnKeys(receiverRecord, new Set([
      "kind",
      "receiverEligible",
      "storageHeadroom",
      "terminalHeadroom",
      "resourceHeadroom",
    ])) &&
      receiverEligible !== null &&
      storageHeadroom !== null &&
      terminalHeadroom !== null &&
      resourceHeadroom !== null;
  }
  const countAccountingValid =
    donorCount !== null &&
    evaluatedCount !== null &&
    feasibleCount !== null &&
    rejectedCount !== null &&
    evaluatedCount <= donorCount &&
    feasibleCount + rejectedCount === evaluatedCount &&
    rejectionTotal === rejectedCount;
  return {
    value: {
      donorCount,
      evaluatedCount,
      feasibleCount,
      rejectedCount,
      selectedRejection:
        selectedRejection === undefined ? null : selectedRejection,
      rejectionCounts,
      topSourceRoom: topSourceRoom === undefined ? null : topSourceRoom,
      legacySource,
      receiver,
    },
    valid:
      hasOnlyAllowedOwnKeys(candidate, new Set([
        "donorCount",
        "evaluatedCount",
        "feasibleCount",
        "rejectedCount",
        "selectedRejection",
        "rejectionCounts",
        "topSourceRoom",
        "legacySource",
        "receiver",
      ])) &&
      countAccountingValid &&
      selectedRejection !== undefined &&
      (selectedRejection === null ||
        rejectionCounts[0]?.[0] === selectedRejection) &&
      rejectionCountsValid &&
      topSourceRoom !== undefined &&
      legacySourceValid &&
      receiverValid,
    rejectionTupleCount: rejectionCounts.length,
  };
}

function summarizeLogisticsComparisonSampleV2(value) {
  const sample = objectOrNull(value);
  if (!sample) {
    return { value: null, valid: false, rejectionTupleCount: 0 };
  }
  const intentId = boundedStringOrNull(sample.intentId);
  const targetRoomName = isScreepsRoomName(sample.targetRoomName)
    ? sample.targetRoomName
    : null;
  const resource = RESOURCE_CONTROL_LOGISTICS_RESOURCES.has(sample.resource)
    ? sample.resource
    : null;
  const status = RESOURCE_CONTROL_LOGISTICS_SAMPLE_STATUSES.has(sample.status)
    ? sample.status
    : null;
  const reason = RESOURCE_CONTROL_LOGISTICS_COMPARISON_REASONS.has(sample.reason)
    ? sample.reason
    : null;
  const producerReason = sample.producerReason === undefined
    ? null
    : RESOURCE_CONTROL_LOGISTICS_DIFFERENCE_REASONS.has(
        sample.producerReason,
      )
      ? sample.producerReason
      : undefined;
  const decisionDelta = RESOURCE_CONTROL_LOGISTICS_DECISION_DELTAS.has(
    sample.decisionDelta,
  )
    ? sample.decisionDelta
    : null;
  const direction = RESOURCE_CONTROL_LOGISTICS_DIFFERENCE_DIRECTIONS.has(
    sample.direction,
  )
    ? sample.direction
    : null;
  const causalCode = RESOURCE_CONTROL_LOGISTICS_CAUSAL_CODES.has(
    sample.causalCode,
  )
    ? sample.causalCode
    : null;
  const differingDimensions = summarizeStrictBoundedStringArray(
    sample.differingDimensions,
    new Set(RESOURCE_CONTROL_LOGISTICS_DIMENSIONS),
  );
  const legacy = sample.legacy === undefined
    ? { value: null, valid: true }
    : summarizeLogisticsLegacyOutcomeV2(sample.legacy);
  const shadow = sample.shadow === undefined
    ? { value: null, valid: true }
    : summarizeLogisticsShadowOutcomeV2(sample.shadow);
  const candidate = sample.candidate === undefined
    ? { value: null, valid: true, rejectionTupleCount: 0 }
    : summarizeLogisticsCandidateTraceV2(sample.candidate);

  const statusReasonValid =
    (status === "equal" &&
      reason === "equal" &&
      differingDimensions.value?.length === 0) ||
    (status === "different" &&
      RESOURCE_CONTROL_LOGISTICS_DIFFERENCE_REASONS.has(reason) &&
      (differingDimensions.value?.length ?? 0) > 0) ||
    (status === "unresolved" &&
      (RESOURCE_CONTROL_LOGISTICS_UNRESOLVED_REASONS.has(reason) ||
        reason === "input_unavailable"));
  const legacyKind = legacy.value?.kind ?? null;
  const shadowKind = shadow.value?.kind ?? null;
  const deltaValid =
    (decisionDelta === "same_route" &&
      legacyKind === "route" &&
      shadowKind === "route" &&
      legacy.value.sourceRoomName === shadow.value.sourceRoomName) ||
    (decisionDelta === "different_route" &&
      legacyKind === "route" &&
      shadowKind === "route" &&
      legacy.value.sourceRoomName !== shadow.value.sourceRoomName) ||
    (decisionDelta === "both_no_route" &&
      legacyKind === "none" && shadowKind === "unmatched") ||
    (decisionDelta === "legacy_only_route" &&
      legacyKind === "route" && shadowKind === "unmatched") ||
    (decisionDelta === "shadow_only_route" &&
      legacyKind === "none" && shadowKind === "route") ||
    (decisionDelta === "input_unavailable" &&
      status === "unresolved");
  const routeEndpointValid =
    (legacyKind !== "route" ||
      (legacy.value.sourceRoomName !== targetRoomName &&
        legacy.value.amount <=
          RESOURCE_CONTROL_LOGISTICS_MAX_BATCH_AMOUNT)) &&
    (shadowKind !== "route" ||
      (shadow.value.sourceRoomName !== targetRoomName &&
        shadow.value.amount <=
          RESOURCE_CONTROL_LOGISTICS_MAX_BATCH_AMOUNT &&
        shadow.value.actionAmount > 0 &&
        shadow.value.capacity === "eligible" &&
        shadow.value.staging === "eligible"));
  const directionValid =
    (status === "equal" && direction === "same") ||
    (status === "unresolved" && direction === "input_unavailable") ||
    (status === "different" &&
      ((decisionDelta === "legacy_only_route" &&
        direction === "shadow_more_conservative") ||
       (decisionDelta === "shadow_only_route" &&
        direction === "shadow_more_permissive") ||
       (!["legacy_only_route", "shadow_only_route"].includes(
          decisionDelta,
        ) && direction === "policy_difference")));
  const shadowReceiver = candidate.value?.receiver;
  const shadowConflictsWithFrozenSafety = shadowKind === "route" && (
    shadow.value.capacity !== "eligible" ||
    shadow.value.staging !== "eligible" ||
    shadowReceiver?.kind !== "present" ||
    shadowReceiver.receiverEligible !== true ||
    shadowReceiver.storageHeadroom < shadow.value.amount ||
    shadowReceiver.terminalHeadroom < shadow.value.amount ||
    shadowReceiver.resourceHeadroom < shadow.value.amount
  );
  const expectedDifferenceReason = (() => {
    if (status !== "different") return null;
    if (shadowKind === "unmatched") {
      return "expected_policy_difference";
    }
    if (shadowKind !== "route" || legacy.value === null) return null;
    if (shadowConflictsWithFrozenSafety) return "unsafe_candidate";
    if (legacyKind === "none") return "legacy_unpaired";
    if (legacyKind === "route") {
      return "expected_policy_difference";
    }
    return null;
  })();
  const classificationValid = status !== "different" ||
    reason === expectedDifferenceReason;
  const causalValid =
    (status === "equal" && causalCode === "matched") ||
    (status === "unresolved" && causalCode === reason) ||
    (status === "different" && shadowKind === "unmatched" &&
      causalCode === shadow.value.reason) ||
    (status === "different" && legacyKind === "route" &&
      shadowKind === "route" &&
      ((decisionDelta === "different_route" && causalCode === "route_rank") ||
        (decisionDelta === "same_route" &&
          causalCode === "route_fact_difference"))) ||
    (status === "different" && legacyKind === "none" &&
      shadowKind === "route" &&
      causalCode === legacy.value.blocker);
  const expectedVisibleDimensions = (() => {
    const expected = new Set();
    if (status === "unresolved" || status === "equal") return expected;
    if (
      (legacyKind === "route" && shadowKind === "unmatched") ||
      (legacyKind === "none" && shadowKind === "route")
    ) {
      expected.add("donor");
      expected.add("route");
      return expected;
    }
    if (legacyKind === "route" && shadowKind === "route") {
      if (legacy.value.sourceRoomName !== shadow.value.sourceRoomName) {
        expected.add("donor");
      }
      if (
        legacy.value.amount !== shadow.value.amount ||
        legacy.value.actionAmount !== shadow.value.actionAmount ||
        legacy.value.terminalReadyAt !== shadow.value.terminalReadyAt ||
        legacy.value.feeAmount !== shadow.value.feeAmount ||
        legacy.value.requiredEnergy !== shadow.value.requiredEnergy ||
        legacy.value.energyCommitmentAmount !==
          shadow.value.energyCommitmentAmount
      ) {
        expected.add("route");
      }
      if (legacy.value.coverage !== shadow.value.coverage) {
        expected.add("demandCoverage");
      }
      if (legacy.value.capacity !== shadow.value.capacity) {
        expected.add("receiverHeadroom");
      }
      if (
        legacy.value.staging !== shadow.value.staging ||
        legacy.value.terminalAllocatedAmount !==
          shadow.value.terminalAllocatedAmount ||
        legacy.value.stagingRequiredAmount !==
          shadow.value.stagingRequiredAmount ||
        legacy.value.terminalEnergyAllocatedAmount !==
          shadow.value.terminalEnergyAllocatedAmount ||
        legacy.value.feeStagingRequiredAmount !==
          shadow.value.feeStagingRequiredAmount
      ) {
        expected.add("predictedStagingEligibility");
      }
      return expected;
    }
    if (legacyKind === "none" && shadowKind === "unmatched") {
      if (legacy.value.blocker !== shadow.value.reason) {
        expected.add("route");
      }
      if (legacy.value.coverage !== shadow.value.coverage) {
        expected.add("demandCoverage");
      }
      if (legacy.value.capacity !== shadow.value.capacity) {
        expected.add("receiverHeadroom");
      }
      if (legacy.value.staging !== shadow.value.staging) {
        expected.add("predictedStagingEligibility");
      }
    }
    return expected;
  })();
  const visibleDimensions = (differingDimensions.value || [])
    .filter((dimension) => dimension !== "priority");
  const outcomeDimensionsValid =
    visibleDimensions.length === expectedVisibleDimensions.size &&
    visibleDimensions.every((dimension) =>
      expectedVisibleDimensions.has(dimension));
  const candidateAlignmentValid =
    (shadowKind === null && candidate.value === null) ||
    (shadowKind === "route" &&
      candidate.value !== null &&
      candidate.value.feasibleCount > 0 &&
      candidate.value.selectedRejection === null &&
      candidate.value.topSourceRoom === shadow.value.sourceRoomName) ||
    (shadowKind === "unmatched" &&
      candidate.value !== null &&
      candidate.value.feasibleCount === 0 &&
      candidate.value.topSourceRoom === null &&
      (RESOURCE_CONTROL_LOGISTICS_CANDIDATE_REJECTIONS.has(
        shadow.value.reason,
      )
        ? candidate.value.selectedRejection === shadow.value.reason
        : candidate.value.selectedRejection === null));
  const shadowReceiverEvidenceValid = shadowKind !== "route" || (
    candidate.value?.receiver?.kind === "present" &&
    candidate.value.receiver.receiverEligible === true &&
    candidate.value.receiver.storageHeadroom >= shadow.value.amount &&
    candidate.value.receiver.terminalHeadroom >= shadow.value.amount &&
    candidate.value.receiver.resourceHeadroom >= shadow.value.amount
  );
  const noCandidateReasons = new Set([
    "malformed_input",
    "stale_intent",
    "demand_already_covered",
    "donor_limit_exceeded",
  ]);
  const candidateEvaluationValid = candidate.value === null || (
    shadowKind === "unmatched" &&
      noCandidateReasons.has(shadow.value.reason)
      ? candidate.value.evaluatedCount === 0
      : candidate.value.evaluatedCount === candidate.value.donorCount
  );
  const unmatchedCandidateCanonical = shadowKind !== "unmatched" ||
    candidate.value === null ||
    (shadow.value.reason === "no_donor"
      ? candidate.value.donorCount === 0 &&
        candidate.value.evaluatedCount === 0 &&
        candidate.value.rejectedCount === 0 &&
        candidate.value.rejectionCounts.length === 0
      : noCandidateReasons.has(shadow.value.reason)
        ? candidate.value.evaluatedCount === 0 &&
          candidate.value.feasibleCount === 0 &&
          candidate.value.rejectedCount === 0 &&
          candidate.value.rejectionCounts.length === 0
        : RESOURCE_CONTROL_LOGISTICS_CANDIDATE_REJECTIONS.has(
            shadow.value.reason,
          ) &&
          candidate.value.donorCount > 0 &&
          candidate.value.evaluatedCount === candidate.value.donorCount &&
          candidate.value.rejectedCount === candidate.value.donorCount);
  const legacySource = candidate.value?.legacySource;
  const legacyDispositionValid = legacySource === null ||
    legacySource === undefined ||
    (legacySource.disposition === "selected"
      ? legacySource.sourceRoom === candidate.value.topSourceRoom &&
        legacySource.rejection === null &&
        candidate.value.feasibleCount > 0
      : legacySource.disposition === "feasible_lower_rank"
        ? candidate.value.topSourceRoom !== null &&
          legacySource.sourceRoom !== candidate.value.topSourceRoom &&
          legacySource.rejection === null &&
          candidate.value.feasibleCount >= 2
        : legacySource.disposition === "rejected"
          ? legacySource.rejection !== null &&
            legacySource.sourceRoom !== candidate.value.topSourceRoom &&
            candidate.value.rejectionCounts.some(
              ([rejection]) => rejection === legacySource.rejection,
            )
          : legacySource.disposition === "not_evaluated"
            ? candidate.value.evaluatedCount < candidate.value.donorCount &&
              legacySource.sourceRoom !== candidate.value.topSourceRoom
            : legacySource.disposition === "not_candidate" &&
              legacySource.sourceRoom !== candidate.value.topSourceRoom &&
              legacySource.rejection === null);
  const legacyTraceValid = candidate.value === null ||
    (legacyKind === "route"
      ? legacySource?.sourceRoom === legacy.value.sourceRoomName &&
        legacyDispositionValid
      : legacySource === null);
  const routeEnergyAccountingValid = (outcome) => {
    if (outcome?.kind !== "route" || resource === null) return true;
    const payloadEnergy = resource === "energy";
    return outcome.requiredEnergy ===
        outcome.feeAmount + (payloadEnergy ? outcome.actionAmount : 0) &&
      outcome.energyCommitmentAmount ===
        outcome.feeAmount + (payloadEnergy ? outcome.amount : 0) &&
      outcome.terminalEnergyAllocatedAmount +
        outcome.feeStagingRequiredAmount +
        (payloadEnergy ? outcome.stagingRequiredAmount : 0) ===
          outcome.requiredEnergy;
  };
  const legacyZeroActionValid = legacyKind !== "route" ||
    legacy.value.actionAmount !== 0 || (
      legacy.value.feeAmount === 0 &&
      legacy.value.requiredEnergy === 0 &&
      legacy.value.terminalAllocatedAmount === 0 &&
      legacy.value.stagingRequiredAmount === 0 &&
      legacy.value.terminalEnergyAllocatedAmount === 0 &&
      legacy.value.feeStagingRequiredAmount === 0
    );
  const unmatchedOutcomeCanonical = shadowKind !== "unmatched" || (() => {
    const capacityBlocked = new Set([
      "receiver_capacity",
      "stale_receiver_fact",
      "invalid_receiver_endpoint",
    ]).has(shadow.value.reason);
    const stagingBlocked = shadow.value.reason === "staging_capacity";
    const capacityValid = shadow.value.capacity ===
      (capacityBlocked ? "blocked" : "unknown");
    const stagingValid = shadow.value.staging ===
      (stagingBlocked ? "blocked" : "unknown");
    if (!capacityValid || !stagingValid) return false;
    if (shadow.value.reason === "demand_already_covered") {
      return shadow.value.uncoveredAmount === 0 &&
        shadow.value.coverage === "covered";
    }
    if (shadow.value.reason === "malformed_input") {
      return shadow.value.uncoveredAmount === 0 &&
        shadow.value.coverage === "unknown";
    }
    if (shadow.value.reason === "stale_intent") return true;
    return shadow.value.uncoveredAmount > 0 &&
      (shadow.value.coverage === "none" ||
        shadow.value.coverage === "partial");
  })();
  const unmatchedReceiverTraceCanonical = shadowKind !== "unmatched" ||
    candidate.value === null || (() => {
      const receiver = candidate.value.receiver;
      if (shadow.value.reason === "invalid_receiver_endpoint") {
        return receiver?.kind === "present";
      }
      if (shadow.value.reason === "receiver_capacity") {
        return receiver?.kind === "present" && (
          receiver.receiverEligible === false ||
          receiver.storageHeadroom === 0 ||
          receiver.terminalHeadroom === 0 ||
          receiver.resourceHeadroom === 0
        );
      }
      return true;
    })();
  const unsafeValid = reason !== "unsafe_candidate" ||
    (status === "different" &&
      shadowKind === "route" &&
      shadowConflictsWithFrozenSafety);
  const outcomesSemanticallyEqual = () => {
    if (legacyKind === "route" && shadowKind === "route") {
      return [
        "sourceRoomName",
        "coverage",
        "capacity",
        "staging",
        "amount",
        "actionAmount",
        "feeAmount",
        "terminalReadyAt",
        "requiredEnergy",
        "energyCommitmentAmount",
        "terminalAllocatedAmount",
        "stagingRequiredAmount",
        "terminalEnergyAllocatedAmount",
        "feeStagingRequiredAmount",
      ].every((key) => legacy.value[key] === shadow.value[key]);
    }
    if (legacyKind === "none" && shadowKind === "unmatched") {
      return legacy.value.blocker === shadow.value.reason &&
        legacy.value.coverage === shadow.value.coverage &&
        legacy.value.capacity === shadow.value.capacity &&
        legacy.value.staging === shadow.value.staging;
    }
    return false;
  };
  const outcomeEqualityValid =
    status !== "equal" ||
    outcomesSemanticallyEqual();
  return {
    value: {
      intentId,
      targetRoomName,
      resource,
      status,
      reason,
      producerReason:
        producerReason === undefined ? null : producerReason,
      decisionDelta,
      direction,
      causalCode,
      differingDimensions: differingDimensions.value,
      legacy: legacy.value,
      shadow: shadow.value,
      candidate: candidate.value,
    },
    valid:
      hasOnlyAllowedOwnKeys(sample, new Set([
        "intentId",
        "targetRoomName",
        "resource",
        "status",
        "reason",
        "producerReason",
        "decisionDelta",
        "direction",
        "causalCode",
        "differingDimensions",
        "legacy",
        "shadow",
        "candidate",
      ])) &&
      typeof sample.intentId === "string" &&
      sample.intentId.length > 0 &&
      sample.intentId.length <= OBSERVABILITY_STRING_LIMIT &&
      targetRoomName !== null &&
      resource !== null &&
      status !== null &&
      reason !== null &&
      producerReason !== undefined &&
      decisionDelta !== null &&
      direction !== null &&
      causalCode !== null &&
      differingDimensions.valid &&
      statusReasonValid &&
      legacy.valid &&
      shadow.valid &&
      candidate.valid &&
      deltaValid &&
      routeEndpointValid &&
      directionValid &&
      classificationValid &&
      causalValid &&
      outcomeDimensionsValid &&
      candidateAlignmentValid &&
      shadowReceiverEvidenceValid &&
      candidateEvaluationValid &&
      unmatchedCandidateCanonical &&
      legacyTraceValid &&
      routeEnergyAccountingValid(legacy.value) &&
      routeEnergyAccountingValid(shadow.value) &&
      legacyZeroActionValid &&
      unmatchedOutcomeCanonical &&
      unmatchedReceiverTraceCanonical &&
      unsafeValid &&
      outcomeEqualityValid,
    rejectionTupleCount: candidate.rejectionTupleCount,
  };
}

function summarizeLogisticsComparisonSamples(value, schemaVersion) {
  if (!Array.isArray(value)) return { value: null, valid: false };
  const result = [];
  const sampleLimit = schemaVersion === 2
    ? RESOURCE_CONTROL_LOGISTICS_CAUSAL_SAMPLE_LIMIT
    : RESOURCE_CONTROL_LOGISTICS_ARRAY_LIMIT;
  let valid = value.length <= sampleLimit;
  let rejectionTupleCount = 0;
  for (const rawSample of value.slice(0, sampleLimit)) {
    const sample = schemaVersion === 2
      ? summarizeLogisticsComparisonSampleV2(rawSample)
      : summarizeLogisticsComparisonSampleV1(rawSample);
    if (!sample.valid) valid = false;
    if (sample.value !== null) result.push(sample.value);
    rejectionTupleCount += sample.rejectionTupleCount || 0;
  }
  if (schemaVersion === 2) {
    const priority = (sample) => {
      if (sample.reason === "unsafe_candidate") return 0;
      if (sample.status === "unresolved" ||
          sample.reason === "input_unavailable") return 1;
      if (sample.status === "different") return 2;
      return 3;
    };
    for (let index = 1; index < result.length; index += 1) {
      const previous = result[index - 1];
      const current = result[index];
      if (
        priority(previous) > priority(current) ||
        (priority(previous) === priority(current) &&
          previous.intentId.localeCompare(current.intentId) >= 0)
      ) {
        valid = false;
      }
    }
  }
  return { value: result, valid, rejectionTupleCount };
}

function summarizeLogisticsCpu(
  value,
  schemaVersion,
  updatedAt,
  snapshotCoherence,
  cpuPhaseEvidence,
) {
  const cpuRecord = objectOrNull(value);
  if (!cpuRecord) return { value: null, valid: false };
  if (schemaVersion !== 2) {
    const measurementAvailable = booleanOrNull(
      cpuRecord.measurementAvailable,
    );
    const captureUsed = finiteNumberWithinOrNull(
      cpuRecord.captureUsed,
      0,
      Number.MAX_VALUE,
    );
    const used = finiteNumberWithinOrNull(
      cpuRecord.used,
      0,
      Number.MAX_VALUE,
    );
    return {
      value: {
        measurementAvailable,
        captureUsed,
        used,
        cpuGateEligible: false,
        gateInconclusive: true,
      },
      valid:
        hasOnlyAllowedOwnKeys(
          cpuRecord,
          new Set(["measurementAvailable", "captureUsed", "used"]),
        ) &&
        measurementAvailable === true &&
        captureUsed !== null &&
        used !== null &&
        used >= captureUsed,
    };
  }

  const attributionVersion = cpuRecord.attributionVersion === 2
    ? 2
    : null;
  const sampleTick = nonNegativeSafeIntegerOrNull(cpuRecord.sampleTick);
  const measurementAvailable = booleanOrNull(
    cpuRecord.measurementAvailable,
  );
  const producerUsed = finiteNumberWithinOrNull(
    cpuRecord.producerUsed,
    0,
    Number.MAX_VALUE,
  );
  const consumerUsed = finiteNumberWithinOrNull(
    cpuRecord.consumerUsed,
    0,
    Number.MAX_VALUE,
  );
  const rawValid = hasOnlyAllowedOwnKeys(
    cpuRecord,
    new Set([
      "attributionVersion",
      "sampleTick",
      "measurementAvailable",
      "producerUsed",
      "consumerUsed",
    ]),
  ) &&
    attributionVersion === 2 &&
    sampleTick !== null &&
    measurementAvailable === true &&
    producerUsed !== null &&
    consumerUsed !== null;
  const tickAligned = rawValid && sampleTick === updatedAt;
  const phaseAmbiguous = tickAligned &&
    cpuPhaseEvidence?.ambiguousTicks?.has(sampleTick);
  const outerResourceControlUsed = tickAligned && !phaseAmbiguous
    ? cpuPhaseEvidence?.byTick?.get(sampleTick) ?? null
    : null;
  const coherentSnapshot =
    snapshotCoherence?.attestationMatched === true &&
    snapshotCoherence?.snapshotIncoherent !== true &&
    snapshotCoherence?.inconclusive !== true;
  const consumerWithinOuter =
    outerResourceControlUsed !== null &&
    consumerUsed !== null &&
    consumerUsed <= outerResourceControlUsed;
  const cpuGateEligible = rawValid &&
    coherentSnapshot &&
    tickAligned &&
    outerResourceControlUsed !== null &&
    consumerWithinOuter;
  const gateInconclusive = rawValid &&
    (!coherentSnapshot || !tickAligned ||
      outerResourceControlUsed === null);
  return {
    value: {
      attributionVersion,
      sampleTick,
      measurementAvailable,
      producerUsed,
      consumerUsed,
      shadowUsed: producerUsed !== null && consumerUsed !== null
        ? producerUsed + consumerUsed
        : null,
      outerResourceControlUsed,
      gateUsed: outerResourceControlUsed !== null && producerUsed !== null
        ? outerResourceControlUsed + producerUsed
        : null,
      cpuGateEligible,
      gateInconclusive,
    },
    valid: rawValid,
  };
}

function missingLogisticsSummary() {
  return {
    available: false,
    livenessAvailable: false,
    snapshotIncoherent: false,
    inconclusive: false,
    snapshotAttestationMatched: false,
    coherenceRetryCount: 0,
    initialEpochSkew: false,
    schemaVersion: null,
    updatedAt: null,
    expiresAt: null,
    requestedMode: null,
    effectiveAuthority: null,
    blocker: null,
    complete: null,
    projectionTruncated: null,
    inScopeByOrigin: null,
    outOfScopeByOrigin: null,
    intent: null,
    comparison: null,
    matcher: null,
    safety: null,
    resources: null,
    cpu: null,
  };
}

function summarizeResourceControlLogistics(
  value,
  dataLogistics,
  currentTick,
  snapshotCoherence = null,
  cpuPhaseEvidence = null,
) {
  const logistics = objectOrNull(value);
  if (!logistics) return missingLogisticsSummary();

  const topShapeValid = hasOnlyAllowedOwnKeys(logistics, new Set([
    "schemaVersion",
    "updatedAt",
    "expiresAt",
    "requestedMode",
    "effectiveAuthority",
    "available",
    "blocker",
    "complete",
    "projectionTruncated",
    "inScopeByOrigin",
    "outOfScopeByOrigin",
    "intent",
    "comparison",
    "matcher",
    "safety",
    "resources",
    "cpu",
  ]));

  const schemaVersion =
    logistics.schemaVersion === 1 || logistics.schemaVersion === 2
      ? logistics.schemaVersion
      : null;
  const updatedAt = nonNegativeSafeIntegerOrNull(logistics.updatedAt);
  const expiresAt = nonNegativeSafeIntegerOrNull(logistics.expiresAt);
  const requestedMode = RESOURCE_CONTROL_LOGISTICS_MODES.has(
    logistics.requestedMode,
  )
    ? logistics.requestedMode
    : null;
  const effectiveAuthority = logistics.effectiveAuthority === "legacy"
    ? "legacy"
    : null;
  const rawBlocker = logistics.blocker;
  const blocker = rawBlocker === undefined
    ? null
    : RESOURCE_CONTROL_LOGISTICS_BLOCKERS.has(rawBlocker)
      ? rawBlocker
      : null;
  const blockerValid =
    rawBlocker === undefined ||
    RESOURCE_CONTROL_LOGISTICS_BLOCKERS.has(rawBlocker);
  const rawAvailable = typeof logistics.available === "boolean"
    ? logistics.available
    : false;
  const availabilityValid =
    typeof logistics.available === "boolean" &&
    (rawAvailable ? rawBlocker === undefined : blocker !== null);
  const complete = booleanOrNull(logistics.complete);
  const projectionTruncated = booleanOrNull(
    logistics.projectionTruncated,
  );

  const inScope = summarizeClosedNonNegativeIntegerMap(
    logistics.inScopeByOrigin,
    RESOURCE_CONTROL_LOGISTICS_ORIGINS,
  );
  const outOfScope = summarizeClosedNonNegativeIntegerMap(
    logistics.outOfScopeByOrigin,
    RESOURCE_CONTROL_LOGISTICS_ORIGINS,
  );

  const intentRecord = objectOrNull(logistics.intent);
  const intent = intentRecord
    ? {
        total: nonNegativeSafeIntegerOrNull(
          intentRecord.total,
          RESOURCE_CONTROL_LOGISTICS_INTENT_LIMIT,
        ),
        active: nonNegativeSafeIntegerOrNull(
          intentRecord.active,
          RESOURCE_CONTROL_LOGISTICS_INTENT_LIMIT,
        ),
        fresh: nonNegativeSafeIntegerOrNull(
          intentRecord.fresh,
          RESOURCE_CONTROL_LOGISTICS_INTENT_LIMIT,
        ),
        stale: nonNegativeSafeIntegerOrNull(
          intentRecord.stale,
          RESOURCE_CONTROL_LOGISTICS_INTENT_LIMIT,
        ),
        paired: nonNegativeSafeIntegerOrNull(
          intentRecord.paired,
          RESOURCE_CONTROL_LOGISTICS_INTENT_LIMIT,
        ),
        inputDrift: nonNegativeSafeIntegerOrNull(
          intentRecord.inputDrift,
          RESOURCE_CONTROL_LOGISTICS_INTENT_LIMIT,
        ),
        emitted: nonNegativeSafeIntegerOrNull(
          intentRecord.emitted,
          RESOURCE_CONTROL_LOGISTICS_INTENT_LIMIT,
        ),
        dropped: nonNegativeSafeIntegerOrNull(intentRecord.dropped),
        truncated: booleanOrNull(intentRecord.truncated),
      }
    : null;
  const intentValues = intent ? Object.values(intent) : [];
  const inScopeTotal = Object.values(inScope.value || {}).reduce(
    (sum, count) => sum + count,
    0,
  );
  const intentValid =
    intent !== null &&
    hasOnlyAllowedOwnKeys(intentRecord, new Set([
      "total",
      "active",
      "fresh",
      "stale",
      "paired",
      "inputDrift",
      "emitted",
      "dropped",
      "truncated",
    ])) &&
    intentValues.every((entry) => entry !== null) &&
    intent.active <= intent.total &&
    intent.fresh <= intent.total &&
    intent.stale <= intent.total &&
    intent.active <= intent.emitted &&
    intent.paired <= intent.active &&
    intent.inputDrift <= intent.active &&
    intent.emitted === intent.total &&
    inScopeTotal === intent.total &&
    (schemaVersion !== 2 || (
      (inScope.value?.synthesis_room || 0) === intent.total &&
      Object.entries(inScope.value || {}).every(
        ([origin, count]) => origin === "synthesis_room" || count === 0,
      )
    )) &&
    intent.fresh + intent.stale === intent.emitted &&
    intent.dropped === 0 &&
    intent.truncated === false;

  const comparisonRecord = objectOrNull(logistics.comparison);
  const byReason = summarizeClosedNonNegativeIntegerMap(
    comparisonRecord?.byReason,
    RESOURCE_CONTROL_LOGISTICS_COMPARISON_REASONS,
    RESOURCE_CONTROL_LOGISTICS_INTENT_LIMIT,
  );
  const byDecisionDelta = schemaVersion === 2
    ? summarizeClosedNonNegativeIntegerMap(
        comparisonRecord?.byDecisionDelta,
        RESOURCE_CONTROL_LOGISTICS_DECISION_DELTAS,
        RESOURCE_CONTROL_LOGISTICS_INTENT_LIMIT,
      )
    : { value: null, valid: true };
  const byCausalCode = schemaVersion === 2
    ? summarizeClosedNonNegativeIntegerMap(
        comparisonRecord?.byCausalCode,
        RESOURCE_CONTROL_LOGISTICS_CAUSAL_CODES,
        RESOURCE_CONTROL_LOGISTICS_INTENT_LIMIT,
      )
    : { value: null, valid: true };
  const dimensionsRecord = objectOrNull(comparisonRecord?.dimensions);
  const dimensions = {};
  let dimensionsValid =
    dimensionsRecord !== null &&
    hasOnlyAllowedOwnKeys(
      dimensionsRecord,
      new Set(RESOURCE_CONTROL_LOGISTICS_DIMENSIONS),
    );
  for (const dimensionName of RESOURCE_CONTROL_LOGISTICS_DIMENSIONS) {
    const dimension = summarizeLogisticsDimension(
      dimensionsRecord?.[dimensionName],
    );
    dimensions[dimensionName] = dimension.value;
    if (!dimension.valid) dimensionsValid = false;
  }
  const samples = summarizeLogisticsComparisonSamples(
    comparisonRecord?.samples,
    schemaVersion,
  );
  const comparison = comparisonRecord
    ? {
        total: nonNegativeSafeIntegerOrNull(
          comparisonRecord.total,
          RESOURCE_CONTROL_LOGISTICS_INTENT_LIMIT,
        ),
        matched: nonNegativeSafeIntegerOrNull(
          comparisonRecord.matched,
          RESOURCE_CONTROL_LOGISTICS_INTENT_LIMIT,
        ),
        different: nonNegativeSafeIntegerOrNull(
          comparisonRecord.different,
          RESOURCE_CONTROL_LOGISTICS_INTENT_LIMIT,
        ),
        unresolved: nonNegativeSafeIntegerOrNull(
          comparisonRecord.unresolved,
          RESOURCE_CONTROL_LOGISTICS_INTENT_LIMIT,
        ),
        byReason: byReason.value,
        ...(schemaVersion === 2
          ? {
              byDecisionDelta: byDecisionDelta.value,
              byCausalCode: byCausalCode.value,
            }
          : {}),
        dimensions,
        ...(schemaVersion === 2
          ? {
              sampled: nonNegativeSafeIntegerOrNull(
                comparisonRecord.sampled,
                RESOURCE_CONTROL_LOGISTICS_CAUSAL_SAMPLE_LIMIT,
              ),
              detailsDropped: nonNegativeSafeIntegerOrNull(
                comparisonRecord.detailsDropped,
                RESOURCE_CONTROL_LOGISTICS_INTENT_LIMIT,
              ),
            }
          : {}),
        samples: samples.value,
      }
    : null;
  const sampleValues = samples.value || [];
  const sampleStatusCounts = {
    equal: sampleValues.filter((sample) => sample.status === "equal").length,
    different: sampleValues.filter((sample) => sample.status === "different").length,
    unresolved: sampleValues.filter((sample) => sample.status === "unresolved").length,
  };
  const sampleReasonCounts = sampleValues.reduce((counts, sample) => {
    if (sample.reason !== null) {
      counts[sample.reason] = (counts[sample.reason] || 0) + 1;
    }
    return counts;
  }, {});
  const sampleDecisionDeltaCounts = sampleValues.reduce(
    (counts, sample) => {
      if (sample.decisionDelta !== undefined &&
          sample.decisionDelta !== null) {
        counts[sample.decisionDelta] =
          (counts[sample.decisionDelta] || 0) + 1;
      }
      return counts;
    },
    {},
  );
  const sampleCausalCodeCounts = sampleValues.reduce(
    (counts, sample) => {
      if (sample.causalCode !== undefined && sample.causalCode !== null) {
        counts[sample.causalCode] =
          (counts[sample.causalCode] || 0) + 1;
      }
      return counts;
    },
    {},
  );
  const comparisonAllowedKeys = schemaVersion === 2
    ? new Set([
        "total",
        "matched",
        "different",
        "unresolved",
        "byReason",
        "byDecisionDelta",
        "byCausalCode",
        "dimensions",
        "sampled",
        "detailsDropped",
        "samples",
      ])
    : new Set([
        "total",
        "matched",
        "different",
        "unresolved",
        "byReason",
        "dimensions",
        "samples",
      ]);
  const reasonCounts = byReason.value || {};
  const differenceExclusiveCount = [
    "expected_policy_difference",
    "legacy_unpaired",
    "shadow_unpaired",
    "unsafe_candidate",
  ].reduce((sum, reason) => sum + (reasonCounts[reason] || 0), 0);
  const unresolvedExclusiveCount = [
    "input_drift",
    "stale_intent",
    "candidate_budget_exhausted",
    "legacy_observation_missing",
    "malformed_input",
    "input_limit_exceeded",
  ].reduce((sum, reason) => sum + (reasonCounts[reason] || 0), 0);
  const sharedInputUnavailableCount =
    reasonCounts.input_unavailable || 0;
  const differentInputUnavailableCount =
    (comparison?.different ?? 0) - differenceExclusiveCount;
  const reasonStatusAccountingValid =
    (reasonCounts.equal || 0) === comparison?.matched &&
    differenceExclusiveCount <= (comparison?.different ?? -1) &&
    unresolvedExclusiveCount <= (comparison?.unresolved ?? -1) &&
    sharedInputUnavailableCount ===
      ((comparison?.different ?? -1) - differenceExclusiveCount) +
      ((comparison?.unresolved ?? -1) - unresolvedExclusiveCount);
  const samplePriorityCounts = sampleValues.reduce(
    (counts, sample) => {
      const priority = sample.reason === "unsafe_candidate"
        ? 0
        : sample.status === "unresolved" ||
            sample.reason === "input_unavailable"
          ? 1
          : sample.status === "different"
            ? 2
            : 3;
      counts[priority] += 1;
      return counts;
    },
    [0, 0, 0, 0],
  );
  let remainingSampleSlots = comparison?.sampled ?? 0;
  const expectedSamplePriorityCounts = [
    reasonCounts.unsafe_candidate || 0,
    (comparison?.unresolved || 0) + differentInputUnavailableCount,
    (comparison?.different || 0) -
      differentInputUnavailableCount -
      (reasonCounts.unsafe_candidate || 0),
    comparison?.matched || 0,
  ].map((count) => {
    const sampled = Math.min(Math.max(0, count), remainingSampleSlots);
    remainingSampleSlots -= sampled;
    return sampled;
  });
  const canonicalSamplePrefixValid =
    comparison?.sampled === Math.min(
      comparison?.total ?? Number.MAX_SAFE_INTEGER,
      RESOURCE_CONTROL_LOGISTICS_CAUSAL_SAMPLE_LIMIT,
    ) &&
    samplePriorityCounts.every(
      (count, index) => count === expectedSamplePriorityCounts[index],
    );
  const sampledMaterialCount = sampleValues.filter(
    (sample) => sample.status !== "equal",
  ).length;
  const sampledEqualCount = sampleValues.length - sampledMaterialCount;
  const materialDetailsComplete =
    sampledMaterialCount ===
      (comparison?.different ?? -1) + (comparison?.unresolved ?? -1) &&
    comparison?.detailsDropped ===
      (comparison?.matched ?? -1) - sampledEqualCount;
  const materialReasonAggregatesExact =
    [...RESOURCE_CONTROL_LOGISTICS_COMPARISON_REASONS].every(
      (reason) =>
        (byReason.value?.[reason] || 0) ===
          (sampleReasonCounts[reason] || 0) +
          (reason === "equal" ? (comparison?.detailsDropped || 0) : 0),
    );
  const materialCausalAggregatesExact =
    [...RESOURCE_CONTROL_LOGISTICS_CAUSAL_CODES].every(
      (code) =>
        (byCausalCode.value?.[code] || 0) ===
          (sampleCausalCodeCounts[code] || 0) +
          (code === "matched" ? (comparison?.detailsDropped || 0) : 0),
    );
  const materialDecisionDeltaAggregatesExact = [
    "different_route",
    "legacy_only_route",
    "shadow_only_route",
    "input_unavailable",
  ].every(
    (delta) =>
      (byDecisionDelta.value?.[delta] || 0) ===
        (sampleDecisionDeltaCounts[delta] || 0),
  );
  const v2ComparisonValid = schemaVersion !== 2 || (
    byDecisionDelta.valid &&
    byCausalCode.valid &&
    Object.values(byDecisionDelta.value || {}).reduce(
      (sum, count) => sum + count,
      0,
    ) === comparison?.total &&
    Object.values(byCausalCode.value || {}).reduce(
      (sum, count) => sum + count,
      0,
    ) === comparison?.total &&
    comparison?.sampled === sampleValues.length &&
    comparison?.sampled + comparison?.detailsDropped ===
      comparison?.total &&
    Object.entries(sampleDecisionDeltaCounts).every(
      ([delta, count]) =>
        count <= (byDecisionDelta.value?.[delta] || 0),
    ) &&
    Object.entries(sampleCausalCodeCounts).every(
      ([code, count]) =>
        count <= (byCausalCode.value?.[code] || 0),
    ) &&
    reasonStatusAccountingValid &&
    canonicalSamplePrefixValid &&
    materialDetailsComplete &&
    materialReasonAggregatesExact &&
    materialCausalAggregatesExact &&
    materialDecisionDeltaAggregatesExact
  );
  const comparisonValid =
    comparison !== null &&
    hasOnlyAllowedOwnKeys(comparisonRecord, comparisonAllowedKeys) &&
    comparison.total !== null &&
    comparison.matched !== null &&
    comparison.different !== null &&
    comparison.unresolved !== null &&
    comparison.matched + comparison.different + comparison.unresolved ===
      comparison.total &&
    comparison.total === intent?.active &&
    byReason.valid &&
    Object.values(byReason.value || {}).reduce(
      (sum, count) => sum + count,
      0,
    ) === comparison.total &&
    dimensionsValid &&
    RESOURCE_CONTROL_LOGISTICS_DIMENSIONS.every((dimensionName) => {
      const dimension = dimensions[dimensionName];
      const sampledDimension = sampleValues.reduce(
        (counts, sample) => {
          if (sample.status === "unresolved") counts.unresolved += 1;
          else if (sample.differingDimensions?.includes(dimensionName)) {
            counts.different += 1;
          } else counts.matched += 1;
          return counts;
        },
        { matched: 0, different: 0, unresolved: 0 },
      );
      return dimension &&
        dimension.unresolved === comparison.unresolved &&
        dimension.different <= comparison.different &&
        (schemaVersion === 2
          ? dimension.matched ===
              sampledDimension.matched + comparison.detailsDropped &&
            dimension.different === sampledDimension.different
          : dimension.matched >= sampledDimension.matched &&
            dimension.different >= sampledDimension.different) &&
        dimension.unresolved >= sampledDimension.unresolved &&
        dimension.matched + dimension.different + dimension.unresolved ===
          comparison.total;
    }) &&
    samples.valid &&
    sampleValues.length <= comparison.total &&
    new Set(sampleValues.map((sample) => sample.intentId)).size ===
      sampleValues.length &&
    sampleStatusCounts.equal <= comparison.matched &&
    sampleStatusCounts.different <= comparison.different &&
    sampleStatusCounts.unresolved <= comparison.unresolved &&
    Object.entries(sampleReasonCounts).every(
      ([reason, count]) => count <= (byReason.value?.[reason] || 0),
    ) &&
    v2ComparisonValid;

  const matcherRecord = objectOrNull(logistics.matcher);
  const continuationCursor = matcherRecord?.continuationCursor;
  const continuationCursorValid =
    continuationCursor === undefined ||
    (typeof continuationCursor === "string" &&
      continuationCursor.length > 0 &&
      continuationCursor.length <= OBSERVABILITY_STRING_LIMIT);
  const matcher = matcherRecord
    ? {
        indexBuilds: nonNegativeSafeIntegerOrNull(
          matcherRecord.indexBuilds,
          RESOURCE_CONTROL_LOGISTICS_INDEX_BUILD_LIMIT,
        ),
        candidateEvaluations: nonNegativeSafeIntegerOrNull(
          matcherRecord.candidateEvaluations,
          RESOURCE_CONTROL_LOGISTICS_CANDIDATE_BUDGET_LIMIT,
        ),
        transactionCostEvaluations: nonNegativeSafeIntegerOrNull(
          matcherRecord.transactionCostEvaluations,
          RESOURCE_CONTROL_LOGISTICS_COST_EVALUATIONS_PER_RUN_LIMIT,
        ),
        totalTransactionCostEvaluations: nonNegativeSafeIntegerOrNull(
          matcherRecord.totalTransactionCostEvaluations,
          RESOURCE_CONTROL_LOGISTICS_COST_EVALUATIONS_PER_EPOCH_LIMIT,
        ),
        candidateBudget: nonNegativeSafeIntegerOrNull(
          matcherRecord.candidateBudget,
          RESOURCE_CONTROL_LOGISTICS_CANDIDATE_BUDGET_LIMIT,
        ),
        budgetExhausted: booleanOrNull(matcherRecord.budgetExhausted),
        continuationCursor:
          typeof continuationCursor === "string"
            ? continuationCursor.slice(0, OBSERVABILITY_STRING_LIMIT)
            : null,
      }
    : null;
  const sampledCandidateEvaluations = sampleValues.reduce(
    (total, sample) =>
      total + (sample.candidate?.evaluatedCount || 0),
    0,
  );
  const matcherValid =
    matcher !== null &&
    hasOnlyAllowedOwnKeys(matcherRecord, new Set([
      "indexBuilds",
      "candidateEvaluations",
      "transactionCostEvaluations",
      "totalTransactionCostEvaluations",
      "candidateBudget",
      "budgetExhausted",
      "continuationCursor",
    ])) &&
    matcher.indexBuilds !== null &&
    matcher.candidateEvaluations !== null &&
    matcher.transactionCostEvaluations !== null &&
    matcher.totalTransactionCostEvaluations !== null &&
    matcher.candidateBudget !== null &&
    matcher.candidateEvaluations <= matcher.candidateBudget &&
    matcher.transactionCostEvaluations <=
      matcher.candidateEvaluations *
        RESOURCE_CONTROL_LOGISTICS_COST_EVALUATIONS_PER_CANDIDATE_LIMIT &&
    matcher.totalTransactionCostEvaluations >=
      matcher.transactionCostEvaluations &&
    (schemaVersion !== 2 || (
      matcher.candidateEvaluations >= sampledCandidateEvaluations &&
      (comparison?.total > RESOURCE_CONTROL_LOGISTICS_CAUSAL_SAMPLE_LIMIT ||
        matcher.candidateEvaluations === sampledCandidateEvaluations)
    )) &&
    matcher.budgetExhausted !== null &&
    matcher.budgetExhausted === false &&
    continuationCursorValid;

  const safetyRecord = objectOrNull(logistics.safety);
  // v1 只投影 tick 边界结束时仍可见的 Shadow records。这里没有跨模块
  // attempt instrumentation，不能据此声称发生后回滚/失败的 send/deal 不存在。
  // Monitor 可独立复核 data v1 没有 contract/lease/claim 集合；arbiter、
  // CarrierTask 与 receiver reservation records 依赖 producer 边界差分和本地 A/B gate。
  const safetyCounterKeys = [
    "nonLegacyAuthorityRecords",
    "activeContracts",
    "activeLeases",
    "activeClaims",
    "shadowArbiterActorRecords",
    "shadowClaimRecords",
    "shadowJournalRecords",
    "shadowCarrierTaskRecords",
    "shadowReceiverReservationRecords",
  ];
  const measurementBoundary = safetyRecord?.measurementBoundary ===
    "observable_state_diff_v1"
    ? "observable_state_diff_v1"
    : null;
  const safety = safetyRecord
    ? { measurementBoundary }
    : null;
  let safetyValid = safetyRecord !== null;
  let zeroObservableRecords = true;
  for (const key of safetyCounterKeys) {
    const count = nonNegativeSafeIntegerOrNull(safetyRecord?.[key]);
    if (safety) safety[key] = count;
    if (count === null) safetyValid = false;
    if (count !== 0) zeroObservableRecords = false;
  }
  const violations = summarizeStrictBoundedStringArray(
    safetyRecord?.violations,
  );
  if (safety) safety.violations = violations.value;
  safetyValid =
    safetyValid &&
    hasOnlyAllowedOwnKeys(
      safetyRecord,
      new Set([
        "measurementBoundary",
        ...safetyCounterKeys,
        "violations",
      ]),
    ) &&
    measurementBoundary !== null &&
    violations.valid;
  if ((violations.value?.length ?? 0) !== 0) {
    zeroObservableRecords = false;
  }

  const resourceRecord = objectOrNull(logistics.resources);
  const dataUsage = summarizeLogisticsDataUsage(dataLogistics);
  const resources = resourceRecord
    ? {
        dataItems: nonNegativeSafeIntegerOrNull(
          resourceRecord.dataItems,
          RESOURCE_CONTROL_LOGISTICS_DATA_ITEM_LIMIT,
        ),
        runtimeItems: nonNegativeSafeIntegerOrNull(
          resourceRecord.runtimeItems,
          schemaVersion === 2
            ? RESOURCE_CONTROL_LOGISTICS_RUNTIME_V2_ITEM_LIMIT
            : RESOURCE_CONTROL_LOGISTICS_RUNTIME_ITEM_LIMIT,
        ),
        dataBytes: nonNegativeSafeIntegerOrNull(
          resourceRecord.dataBytes,
          RESOURCE_CONTROL_LOGISTICS_DATA_BYTE_LIMIT,
        ),
        runtimeBytes: nonNegativeSafeIntegerOrNull(
          resourceRecord.runtimeBytes,
          RESOURCE_CONTROL_LOGISTICS_RUNTIME_BYTE_LIMIT,
        ),
        totalBytes: nonNegativeSafeIntegerOrNull(
          resourceRecord.totalBytes,
          RESOURCE_CONTROL_LOGISTICS_BYTE_LIMIT,
        ),
        withinLimit: booleanOrNull(resourceRecord.withinLimit),
        observedDataItems: dataUsage.itemCount,
        observedDataBytes: dataUsage.utf8Bytes,
      }
    : null;
  const expectedRuntimeItems =
    sampleValues.length +
    (schemaVersion === 2 ? samples.rejectionTupleCount : 0) +
    (violations.value?.length || 0) +
    Object.keys(inScope.value || {}).length +
    Object.keys(outOfScope.value || {}).length +
    Object.keys(byReason.value || {}).length +
    (schemaVersion === 2
      ? Object.keys(byDecisionDelta.value || {}).length +
        Object.keys(byCausalCode.value || {}).length
      : 0);
  const observedRuntimeBytes = serializedUtf8ByteLengthOrNull(logistics);
  if (resources) {
    resources.observedRuntimeItems = expectedRuntimeItems;
    resources.observedRuntimeBytes = observedRuntimeBytes;
  }
  const resourcesValid =
    resources !== null &&
    hasOnlyAllowedOwnKeys(resourceRecord, new Set([
      "dataItems",
      "runtimeItems",
      "dataBytes",
      "runtimeBytes",
      "totalBytes",
      "withinLimit",
    ])) &&
    Object.values(resources).every((entry) => entry !== null) &&
    dataUsage.valid &&
    resources.dataItems === resources.observedDataItems &&
    resources.dataBytes === resources.observedDataBytes &&
    resources.runtimeItems === expectedRuntimeItems &&
    resources.runtimeBytes === observedRuntimeBytes &&
    resources.totalBytes === resources.dataBytes + resources.runtimeBytes &&
    resources.withinLimit === true;

  const cpuSummary = summarizeLogisticsCpu(
    logistics.cpu,
    schemaVersion,
    updatedAt,
    snapshotCoherence,
    cpuPhaseEvidence,
  );
  const cpu = cpuSummary.value;
  const cpuValid = cpuSummary.valid;

  const livenessAvailable =
    snapshotCoherence?.snapshotIncoherent !== true &&
    snapshotCoherence?.inconclusive !== true &&
    snapshotCoherence?.attestationMatched === true &&
    topShapeValid &&
    schemaVersion !== null &&
    updatedAt !== null &&
    expiresAt !== null &&
    Number.isSafeInteger(currentTick) &&
    currentTick >= 0 &&
    updatedAt <= currentTick &&
    currentTick <= expiresAt &&
    requestedMode !== null &&
    requestedMode !== "disabled" &&
    (schemaVersion !== 2 || requestedMode === "shadow") &&
    effectiveAuthority === "legacy" &&
    blockerValid &&
    availabilityValid &&
    rawAvailable &&
    complete === true &&
    projectionTruncated === false &&
    inScope.valid &&
    outOfScope.valid &&
    intentValid &&
    intent.paired === intent.active &&
    intent.inputDrift === 0 &&
    comparisonValid &&
    comparison.unresolved === 0 &&
    matcherValid &&
    matcher.indexBuilds === RESOURCE_CONTROL_LOGISTICS_INDEX_BUILD_LIMIT &&
    (comparison.byReason?.input_unavailable || 0) === 0 &&
    safetyValid &&
    zeroObservableRecords &&
    resourcesValid &&
    cpuValid;
  if (cpu && schemaVersion === 2) {
    cpu.cpuGateEligible = cpu.cpuGateEligible && livenessAvailable;
  }

  return {
    available: rawAvailable,
    livenessAvailable,
    snapshotIncoherent:
      snapshotCoherence?.snapshotIncoherent === true,
    inconclusive: snapshotCoherence?.inconclusive === true,
    snapshotAttestationMatched:
      snapshotCoherence?.attestationMatched === true,
    coherenceRetryCount:
      snapshotCoherence?.retryCount === 1 ? 1 : 0,
    initialEpochSkew:
      snapshotCoherence?.initialEpochSkew === true,
    schemaVersion,
    updatedAt,
    expiresAt,
    requestedMode,
    effectiveAuthority,
    blocker,
    complete,
    projectionTruncated,
    inScopeByOrigin: inScope.value,
    outOfScopeByOrigin: outOfScope.value,
    intent,
    comparison,
    matcher,
    safety,
    resources,
    cpu,
  };
}

function summarizeResourceControl(
  runtimeResourceControl,
  transferTaskStore,
  dataLogistics,
  currentTick,
  snapshotCoherence = null,
  cpuPhaseEvidence = null,
) {
  const runtime =
    runtimeResourceControl && typeof runtimeResourceControl === "object" && !Array.isArray(runtimeResourceControl)
      ? runtimeResourceControl
      : null;
  const tasks =
    transferTaskStore && typeof transferTaskStore === "object" && !Array.isArray(transferTaskStore)
      ? transferTaskStore
      : null;
  const referenceTick = runtime ? finiteNumberOrNull(runtime.updatedAt) : null;
  const roomsRecord =
    runtime && runtime.rooms && typeof runtime.rooms === "object" && !Array.isArray(runtime.rooms)
      ? runtime.rooms
      : {};

  const rooms = Object.entries(roomsRecord)
    .sort(([leftRoomName], [rightRoomName]) => leftRoomName.localeCompare(rightRoomName))
    .map(([roomName, roomState]) => {
      const room = roomState && typeof roomState === "object" && !Array.isArray(roomState) ? roomState : {};
      return {
        roomName,
        state: typeof room.state === "string" ? room.state : null,
        capacityState: typeof room.capacityState === "string" ? room.capacityState : null,
        storageUsedCapacity: finiteNumberOrNull(room.storageUsedCapacity),
        storageFreeCapacity: finiteNumberOrNull(room.storageFreeCapacity),
        terminalUsedCapacity: finiteNumberOrNull(room.terminalUsedCapacity),
        terminalFreeCapacity: finiteNumberOrNull(room.terminalFreeCapacity),
        localOffloadCapacityCommitment: finiteNumberOrNull(room.localOffloadCapacityCommitment),
        storageEnergy: finiteNumberOrNull(room.storageEnergy),
        terminalEnergy: finiteNumberOrNull(room.terminalEnergy),
        energyFloor: finiteNumberOrNull(room.energyFloor),
        energyTarget: finiteNumberOrNull(room.energyTarget),
        energyExportStart: finiteNumberOrNull(room.energyExportStart),
        terminalEnergyReserve: finiteNumberOrNull(room.terminalEnergyReserve),
        desiredTerminalFreeCapacity: finiteNumberOrNull(room.desiredTerminalFreeCapacity),
        terminalRecoveryGap: finiteNumberOrNull(room.terminalRecoveryGap),
        recoverableOffloadAmount: finiteNumberOrNull(room.recoverableOffloadAmount),
        stickyHeadroom: booleanOrNull(room.stickyHeadroom),
        stickyHeadroomReason: typeof room.stickyHeadroomReason === "string" ? room.stickyHeadroomReason : null,
        capacityReservation: summarizeCapacityReservation(room.capacityReservation),
        staging: summarizeStaging(room.staging),
        taskHealth: summarizeTaskHealth(room.taskHealth),
        marketEnergyReadiness:
          summarizeMarketEnergyReadiness(
            room.marketEnergyReadiness,
          ),
      };
    });

  const pendingTasks = Object.entries(tasks || {})
    .filter(([, task]) => task && typeof task === "object" && task.status === "pending")
    .sort(([leftId, leftTask], [rightId, rightTask]) => {
      const leftCreatedAt = finiteNumberOrNull(leftTask.createdAt) ?? Number.MAX_SAFE_INTEGER;
      const rightCreatedAt = finiteNumberOrNull(rightTask.createdAt) ?? Number.MAX_SAFE_INTEGER;
      if (leftCreatedAt !== rightCreatedAt) {
        return leftCreatedAt - rightCreatedAt;
      }
      const normalizedLeftId = typeof leftTask.id === "string" ? leftTask.id : leftId;
      const normalizedRightId = typeof rightTask.id === "string" ? rightTask.id : rightId;
      return normalizedLeftId.localeCompare(normalizedRightId);
    })
    .map(([taskId, task]) => ({
      id: typeof task.id === "string" ? task.id : taskId,
      resource: typeof task.resource === "string" ? task.resource : null,
      origin: typeof task.origin === "string" ? task.origin : null,
      reason: typeof task.reason === "string" ? task.reason : null,
      sourceRoom: typeof task.fromRoomName === "string" ? task.fromRoomName : null,
      destinationRoom: typeof task.toRoomName === "string" ? task.toRoomName : null,
      remainingAmount: finiteNumberOrNull(task.remainingAmount),
      age: tickAge(referenceTick, task.createdAt),
      blocker: typeof task.blockedReason === "string" ? task.blockedReason : null,
      blockerAge: tickAge(referenceTick, task.blockedSince),
      lastProgressAge: tickAge(referenceTick, task.lastProgressAt),
    }));

  return {
    available: runtime !== null || tasks !== null,
    updatedAt: referenceTick,
    roomCount: rooms.length,
    rooms,
    capacityPolicy: summarizeCapacityPolicy(runtime?.capacityPolicy),
    eligibleReceiverCount: finiteNumberOrNull(runtime?.eligibleReceiverCount),
    receiverExcludedByReason: summarizeCountMapOrNull(runtime?.receiverExcludedByReason),
    suppressedStagingCount: summarizeCountMapOrNull(runtime?.suppressedStagingCount),
    capacityIndexBuildCount: finiteNumberOrNull(runtime?.capacityIndexBuildCount),
    taskSummary: summarizeTaskSummary(runtime?.taskSummary),
    recentCapacityReliefRoutes: summarizeCapacityReliefRoutes(runtime?.recentCapacityReliefRoutes),
    logistics: summarizeResourceControlLogistics(
      runtime?.logistics,
      dataLogistics,
      currentTick,
      snapshotCoherence,
      cpuPhaseEvidence,
    ),
    pendingTaskCount: pendingTasks.length,
    pendingTasks,
  };
}

function summarizeDirectCanary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    roomName: typeof value.roomName === "string" ? value.roomName : null,
    resourceType:
      typeof value.resourceType === "string" ? value.resourceType : null,
    lockedAt: finiteNumberOrNull(value.lockedAt),
    configRevision:
      typeof value.configRevision === "string" ? value.configRevision : null,
    safetyFingerprint:
      typeof value.safetyFingerprint === "string"
        ? value.safetyFingerprint
        : null,
  };
}

function summarizeDirectBuyBook(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    rawOrderCount: finiteNumberOrNull(value.rawOrderCount),
    rawOrderLimit: finiteNumberOrNull(value.rawOrderLimit),
    eligibleOrderCount: finiteNumberOrNull(value.eligibleOrderCount),
    eligibleOrderLimit: finiteNumberOrNull(value.eligibleOrderLimit),
    eligibleDepth: finiteNumberOrNull(value.eligibleDepth),
    eligibleDistinctRoomCount: finiteNumberOrNull(
      value.eligibleDistinctRoomCount,
    ),
    pricedOrderCount: finiteNumberOrNull(value.pricedOrderCount),
    safeCandidateCount: finiteNumberOrNull(value.safeCandidateCount),
    rejectedOrderCount: finiteNumberOrNull(value.rejectedOrderCount),
    highestGrossPrice: finiteNumberOrNull(value.highestGrossPrice),
    selectedOrderId:
      typeof value.selectedOrderId === "string"
        ? value.selectedOrderId
        : null,
    cycleRejection:
      typeof value.cycleRejection === "string"
        ? value.cycleRejection
        : null,
    orderRejectionCounts: summarizeCountMapOrNull(
      value.orderRejectionCounts,
    ),
  };
}

function summarizeDirectOpportunity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    orderId: typeof value.orderId === "string" ? value.orderId : null,
    orderRoomName:
      typeof value.orderRoomName === "string"
        ? value.orderRoomName
        : null,
    price: finiteNumberOrNull(value.price),
    orderAmount: finiteNumberOrNull(value.orderAmount),
    dealAmount: finiteNumberOrNull(value.dealAmount),
    transactionEnergy: finiteNumberOrNull(value.transactionEnergy),
    netCreditsMilli: finiteNumberOrNull(value.netCreditsMilli),
    worstCaseNetCreditsMilli: finiteNumberOrNull(
      value.worstCaseNetCreditsMilli,
    ),
    effectiveNetFloorMilli: finiteNumberOrNull(
      value.effectiveNetFloorMilli,
    ),
  };
}

function summarizeDirectEnergyShadowComponents(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    hardFloor: finiteNumberOrNull(value.hardFloor),
    explicit: finiteNumberOrNull(value.explicit),
    historyFloor: finiteNumberOrNull(value.historyFloor),
    ratchetFloor: finiteNumberOrNull(value.ratchetFloor),
  };
}

function summarizeDirectPlanningSnapshot(value, referenceTick) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const observedAt = finiteNumberOrNull(value.observedAt);
  const maxAgeTicks = finiteNumberOrNull(value.maxAgeTicks);
  const projectedAge = finiteNumberOrNull(value.age);
  const age = projectedAge ?? tickAge(referenceTick, observedAt);
  const projectedFresh = booleanOrNull(value.fresh);
  const fresh =
    projectedFresh ??
    (age !== null && maxAgeTicks !== null ? age <= maxAgeTicks : null);
  const manualBuyOrderCount = finiteNumberOrNull(
    value.manualBuyOrderCount,
  );
  const manualSellOrderCount = finiteNumberOrNull(
    value.manualSellOrderCount,
  );
  const manualOrderBlockers = [];
  if (manualBuyOrderCount !== null && manualBuyOrderCount > 0) {
    manualOrderBlockers.push("manual_buy_order_present");
  }
  if (manualSellOrderCount !== null && manualSellOrderCount > 0) {
    manualOrderBlockers.push("manual_sell_order_present");
  }

  return {
    observedAt,
    age,
    maxAgeTicks,
    fresh,
    result: typeof value.result === "string" ? value.result : null,
    configRevision:
      typeof value.configRevision === "string"
        ? value.configRevision
        : null,
    safetyFingerprint:
      typeof value.safetyFingerprint === "string"
        ? value.safetyFingerprint
        : null,
    canary: summarizeDirectCanary(value.canary),
    structuralCandidateCount: finiteNumberOrNull(
      value.structuralCandidateCount,
    ),
    eligibleStructuralCandidateCount: finiteNumberOrNull(
      value.eligibleStructuralCandidateCount,
    ),
    buyBook: summarizeDirectBuyBook(value.buyBook),
    opportunity: summarizeDirectOpportunity(value.opportunity),
    manualBuyOrderCount,
    manualSellOrderCount,
    zeroRemainingOwnOrderCount: finiteNumberOrNull(
      value.zeroRemainingOwnOrderCount,
    ),
    manualOrderBlocked:
      manualBuyOrderCount === null && manualSellOrderCount === null
        ? null
        : manualOrderBlockers.length > 0,
    manualOrderBlockers:
      manualBuyOrderCount === null && manualSellOrderCount === null
        ? null
        : manualOrderBlockers,
    effectiveNetFloor: finiteNumberOrNull(value.effectiveNetFloor),
    effectiveEnergyShadowPrice: finiteNumberOrNull(
      value.effectiveEnergyShadowPrice,
    ),
    energyShadowObservedAt: finiteNumberOrNull(
      value.energyShadowObservedAt,
    ),
    energyShadowComponents: summarizeDirectEnergyShadowComponents(
      value.energyShadowComponents,
    ),
    rejectedByReason: summarizeCountMapOrNull(value.rejectedByReason),
  };
}

function summarizeContinuousDirectLifecycle(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    stage: typeof value.stage === "string" ? value.stage : null,
    resourceFingerprint:
      typeof value.resourceFingerprint === "string"
        ? value.resourceFingerprint
        : null,
    sharedFingerprint:
      typeof value.sharedFingerprint === "string"
        ? value.sharedFingerprint
        : null,
    shadowConsecutiveCycles: finiteNumberOrNull(
      value.consecutiveCompleteCycles,
    ),
    lastCycleTick: finiteNumberOrNull(value.lastCycleTick),
    lastShadowResult:
      typeof value.lastShadowResult === "string"
        ? value.lastShadowResult
        : null,
    qualifiedAt: finiteNumberOrNull(value.qualifiedAt),
    canaryConfirmedAt: finiteNumberOrNull(value.canaryConfirmedAt),
    canaryConfirmedCount: finiteNumberOrNull(
      value.canaryConfirmedCount,
    ),
    sharedReviewRequired: booleanOrNull(
      value.sharedReviewRequired,
    ),
  };
}

function summarizeContinuousDirectQuota(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const resourceConfirmed = finiteNumberOrNull(
    value.resourceConfirmedActual,
  );
  const resourceReserved = finiteNumberOrNull(
    value.resourceUnmatchedPlanned,
  );
  const globalConfirmed = finiteNumberOrNull(
    value.globalConfirmedActual,
  );
  const globalReserved = finiteNumberOrNull(
    value.globalUnmatchedPlanned,
  );
  const confirmedCooldownNotBefore = finiteNumberOrNull(
    value.confirmedCooldownNotBefore,
  );
  const retryNotBefore = finiteNumberOrNull(value.retryNotBefore);
  const nextEligibleTicks = [
    confirmedCooldownNotBefore,
    retryNotBefore,
  ].filter((tick) => tick !== null);

  return {
    tick: finiteNumberOrNull(value.tick),
    windowStartTick: finiteNumberOrNull(value.windowStartTick),
    resource: {
      resourceType:
        typeof value.resource === "string" ? value.resource : null,
      limit: finiteNumberOrNull(value.resourceLimit),
      confirmed: resourceConfirmed,
      reserved: resourceReserved,
      used:
        resourceConfirmed !== null && resourceReserved !== null
          ? resourceConfirmed + resourceReserved
          : null,
      remaining: finiteNumberOrNull(value.resourceRemaining),
      lastConfirmedAt: finiteNumberOrNull(
        value.lastResourceConfirmedAt,
      ),
    },
    global: {
      limit: finiteNumberOrNull(value.globalLimit),
      confirmed: globalConfirmed,
      reserved: globalReserved,
      used:
        globalConfirmed !== null && globalReserved !== null
          ? globalConfirmed + globalReserved
          : null,
      remaining: finiteNumberOrNull(value.globalRemaining),
      lastConfirmedAt: finiteNumberOrNull(
        value.lastGlobalConfirmedAt,
      ),
    },
    confirmedCooldownNotBefore,
    retryNotBefore,
    nextEligibleTick:
      nextEligibleTicks.length > 0
        ? Math.max(...nextEligibleTicks)
        : null,
  };
}

function summarizeContinuousDirectBestTuple(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    entryId:
      typeof value.entryId === "string" ? value.entryId : null,
    resourceType:
      typeof value.resource === "string" ? value.resource : null,
    sellerRoom:
      typeof value.roomName === "string" ? value.roomName : null,
    orderId:
      typeof value.orderId === "string" ? value.orderId : null,
    grossPrice: finiteNumberOrNull(value.grossPrice),
    unitNetPrice: finiteNumberOrNull(value.unitNetPrice),
    transactionEnergy: finiteNumberOrNull(
      value.transactionEnergy,
    ),
  };
}

function summarizeContinuousDirectPlanning(value, referenceTick) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const observedAt = finiteNumberOrNull(value.observedAt);
  const normalizeResources = (resources) =>
    Array.isArray(resources)
      ? [
          ...new Set(
            resources.filter(
              (resource) => typeof resource === "string",
            ),
          ),
        ].sort()
      : null;
  return {
    observedAt,
    age: tickAge(referenceTick, observedAt),
    complete: booleanOrNull(value.complete),
    planningFingerprint:
      typeof value.planningFingerprint === "string"
        ? value.planningFingerprint
        : null,
    blocker:
      typeof value.blocker === "string" ? value.blocker : null,
    safeResourceTypes: normalizeResources(
      value.safeResourceTypes,
    ),
    admittedResourceTypes: normalizeResources(
      value.admittedResourceTypes,
    ),
    rejectedByReason: summarizeCountMapOrNull(
      value.rejectedByReason,
    ),
    bestTuple: summarizeContinuousDirectBestTuple(
      value.selected,
    ),
  };
}

function summarizeContinuousDirectPermit(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const grants = Array.isArray(value.grants)
    ? value.grants
        .filter(
          (grant) =>
            grant &&
            typeof grant === "object" &&
            !Array.isArray(grant),
        )
        .sort((left, right) => {
          const leftId =
            typeof left.entryId === "string" ? left.entryId : "";
          const rightId =
            typeof right.entryId === "string" ? right.entryId : "";
          return leftId.localeCompare(rightId);
        })
        .slice(0, CONTINUOUS_DIRECT_ENTRY_LIMIT)
        .map((grant) => ({
          entryId:
            typeof grant.entryId === "string"
              ? grant.entryId
              : null,
          stage:
            typeof grant.stage === "string"
              ? grant.stage
              : null,
          newDealGrant:
            typeof grant.newDealGrant === "string"
              ? grant.newDealGrant
              : null,
        }))
    : null;
  return {
    epoch: finiteNumberOrNull(value.epoch),
    permitId:
      typeof value.permitId === "string" ? value.permitId : null,
    permitHead:
      typeof value.permitHead === "string"
        ? value.permitHead
        : null,
    grants,
  };
}

function summarizeContinuousDirectBlocker(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    code: typeof value.code === "string" ? value.code : null,
    detectedAt: finiteNumberOrNull(value.detectedAt),
    detailHash:
      typeof value.detailHash === "string"
        ? value.detailHash
        : null,
  };
}

function summarizeContinuousDirectPending(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    attemptSeq: finiteNumberOrNull(value.attemptSeq),
    requestId:
      typeof value.requestId === "string" ? value.requestId : null,
    entryId:
      typeof value.entryId === "string" ? value.entryId : null,
    sellerRoom:
      typeof value.sellerRoom === "string"
        ? value.sellerRoom
        : null,
    resourceType:
      typeof value.resource === "string" ? value.resource : null,
    orderId:
      typeof value.orderId === "string" ? value.orderId : null,
    attemptAt: finiteNumberOrNull(value.attemptAt),
    plannedAmount: finiteNumberOrNull(value.plannedAmount),
    plannedTransactionEnergy: finiteNumberOrNull(
      value.plannedTransactionEnergy,
    ),
  };
}

function summarizeContinuousDirectLifetime(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const summarizeCounter = (counter) =>
    counter && typeof counter === "object" && !Array.isArray(counter)
      ? {
          count: finiteNumberOrNull(counter.count),
          amount: finiteNumberOrNull(counter.amount),
        }
      : null;
  const resources =
    value.resources &&
    typeof value.resources === "object" &&
    !Array.isArray(value.resources)
      ? Object.fromEntries(
          Object.entries(value.resources)
            .filter(
              ([resource]) => typeof resource === "string",
            )
            .sort(([left], [right]) =>
              left.localeCompare(right),
            )
            .slice(0, CONTINUOUS_DIRECT_ENTRY_LIMIT)
            .map(([resource, counter]) => [
              resource,
              summarizeCounter(counter),
            ]),
        )
      : null;
  return {
    global: summarizeCounter(value.global),
    resources,
  };
}

function summarizeContinuousDirectOpportunity(
  entry,
  planning,
  quota,
) {
  const reserveAmount = finiteNumberOrNull(
    entry.opportunityReserveAmount,
  );
  const resourceType =
    typeof entry.resourceType === "string"
      ? entry.resourceType
      : null;
  const safe =
    resourceType !== null &&
    Array.isArray(planning?.safeResourceTypes)
      ? planning.safeResourceTypes.includes(resourceType)
      : null;
  const admitted =
    resourceType !== null &&
    Array.isArray(planning?.admittedResourceTypes)
      ? planning.admittedResourceTypes.includes(resourceType)
      : null;
  const resourceRemaining = quota?.resource?.remaining ?? null;
  const resourceUsed = quota?.resource?.used ?? null;
  const resourceEligible =
    reserveAmount !== null && resourceRemaining !== null
      ? resourceRemaining >= reserveAmount
      : null;
  const required =
    safe === false
      ? false
      : safe === true && resourceEligible !== null
        ? resourceEligible
        : null;
  const unmetAmount =
    required === false
      ? 0
      : required === true &&
          reserveAmount !== null &&
          resourceUsed !== null
        ? Math.max(0, reserveAmount - resourceUsed)
        : null;
  let admission = null;
  if (safe === false) {
    admission = "not_safe";
  } else if (safe === true && resourceEligible === false) {
    admission = "resource_quota_blocked";
  } else if (safe === true && admitted === true) {
    admission = "admitted";
  } else if (safe === true && admitted === false) {
    admission = "global_quota_or_opportunity_reserve_blocked";
  }
  return {
    reserveAmount,
    safe,
    required,
    unmetAmount,
    satisfied:
      required === true && unmetAmount !== null
        ? unmetAmount === 0
        : null,
    admitted,
    admission,
  };
}

function summarizeContinuousDirectEntry(
  value,
  lifecycleByEntry,
  planning,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entryId =
    typeof value.entryId === "string" ? value.entryId : null;
  const lifecycle =
    summarizeContinuousDirectLifecycle(value.lifecycle) ||
    summarizeContinuousDirectLifecycle(
      entryId === null ? null : lifecycleByEntry?.[entryId],
    );
  const quota = summarizeContinuousDirectQuota(value.quota);
  return {
    entryId,
    resourceType:
      typeof value.resourceType === "string"
        ? value.resourceType
        : null,
    lane: {
      allowedRoomNames: Array.isArray(value.allowedRoomNames)
        ? [
            ...new Set(
              value.allowedRoomNames.filter(
                (roomName) => typeof roomName === "string",
              ),
            ),
          ].sort()
        : null,
      requireNativeMineral: booleanOrNull(
        value.requireNativeMineral,
      ),
      reserve: finiteNumberOrNull(value.laneReserve),
    },
    floor: {
      hard: finiteNumberOrNull(value.hardFloor),
      economic: finiteNumberOrNull(value.economicFloor),
    },
    rollingWindowTicks: finiteNumberOrNull(
      value.rollingWindowTicks,
    ),
    rollingMaxAmount: finiteNumberOrNull(
      value.rollingMaxAmount,
    ),
    lifecycle,
    quota,
    opportunity: summarizeContinuousDirectOpportunity(
      value,
      planning,
      quota,
    ),
  };
}

function summarizeContinuousDirectGlobalQuota(entries) {
  const quotas = entries
    .map((entry) => entry?.quota)
    .filter((quota) => quota !== null && quota !== undefined);
  if (quotas.length === 0) return null;
  const first = quotas[0];
  const signature = (quota) =>
    JSON.stringify({
      tick: quota.tick,
      windowStartTick: quota.windowStartTick,
      global: quota.global,
      confirmedCooldownNotBefore:
        quota.confirmedCooldownNotBefore,
      retryNotBefore: quota.retryNotBefore,
      nextEligibleTick: quota.nextEligibleTick,
    });
  return {
    tick: first.tick,
    windowStartTick: first.windowStartTick,
    ...first.global,
    confirmedCooldownNotBefore:
      first.confirmedCooldownNotBefore,
    retryNotBefore: first.retryNotBefore,
    nextEligibleTick: first.nextEligibleTick,
    consistent: quotas.every(
      (quota) => signature(quota) === signature(first),
    ),
  };
}

function summarizeContinuousDirectMarketSale(
  value,
  referenceTick,
) {
  const planning = summarizeContinuousDirectPlanning(
    value.lastPlanningSnapshot,
    referenceTick,
  );
  const lifecycleByEntry =
    value.lifecycleByEntry &&
    typeof value.lifecycleByEntry === "object" &&
    !Array.isArray(value.lifecycleByEntry)
      ? value.lifecycleByEntry
      : null;
  const entries = Array.isArray(value.entries)
    ? value.entries
        .filter(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            !Array.isArray(entry),
        )
        .sort((left, right) => {
          const leftId =
            typeof left.entryId === "string" ? left.entryId : "";
          const rightId =
            typeof right.entryId === "string" ? right.entryId : "";
          return leftId.localeCompare(rightId);
        })
        .slice(0, CONTINUOUS_DIRECT_ENTRY_LIMIT)
        .map((entry) =>
          summarizeContinuousDirectEntry(
            entry,
            lifecycleByEntry,
            planning,
          ),
        )
        .filter((entry) => entry !== null)
    : [];
  const ledger =
    value.ledger &&
    typeof value.ledger === "object" &&
    !Array.isArray(value.ledger)
      ? value.ledger
      : null;
  const ledgerBlocker = summarizeContinuousDirectBlocker(
    ledger?.blocker,
  );
  const migrationBlockedReason =
    typeof value.migrationBlockedReason === "string"
      ? value.migrationBlockedReason
      : null;
  const effectiveBlocker =
    migrationBlockedReason !== null
      ? {
          source: "migration",
          code: migrationBlockedReason,
          detectedAt: null,
          detailHash: null,
        }
      : ledgerBlocker?.code
        ? { source: "ledger", ...ledgerBlocker }
        : planning?.blocker
          ? {
              source: "planning",
              code: planning.blocker,
              detectedAt: planning.observedAt,
              detailHash: planning.planningFingerprint,
            }
          : null;
  const requiredEntries = entries.filter(
    (entry) => entry.opportunity.required === true,
  );
  const opportunityAdmission =
    planning === null
      ? null
      : {
          safeResourceTypes: planning.safeResourceTypes,
          requiredResourceTypes: requiredEntries
            .map((entry) => entry.resourceType)
            .filter((resource) => resource !== null)
            .sort(),
          admittedResourceTypes:
            planning.admittedResourceTypes,
          unmetByResource: Object.fromEntries(
            requiredEntries
              .filter(
                (entry) =>
                  entry.resourceType !== null &&
                  entry.opportunity.unmetAmount !== null,
              )
              .sort((left, right) =>
                left.resourceType.localeCompare(
                  right.resourceType,
                ),
              )
              .map((entry) => [
                entry.resourceType,
                entry.opportunity.unmetAmount,
              ]),
          ),
          totalUnmetAmount: requiredEntries.every(
            (entry) =>
              entry.opportunity.unmetAmount !== null,
          )
            ? requiredEntries.reduce(
                (sum, entry) =>
                  sum + entry.opportunity.unmetAmount,
                0,
              )
            : null,
        };

  return {
    available: true,
    strategyActive: booleanOrNull(value.strategyActive),
    capability:
      typeof value.capability === "string"
        ? value.capability
        : null,
    schemaVersion: finiteNumberOrNull(value.schemaVersion),
    migrationStatus:
      typeof value.migrationStatus === "string"
        ? value.migrationStatus
        : null,
    migrationBlockedReason,
    permit: summarizeContinuousDirectPermit(value.permit),
    proposedPermitId:
      typeof value.proposedPermitId === "string"
        ? value.proposedPermitId
        : null,
    entries,
    globalQuota: summarizeContinuousDirectGlobalQuota(entries),
    opportunityAdmission,
    bestTuple: planning?.bestTuple ?? null,
    planning:
      planning === null
        ? null
        : {
            observedAt: planning.observedAt,
            age: planning.age,
            complete: planning.complete,
            planningFingerprint:
              planning.planningFingerprint,
            blocker: planning.blocker,
            safeResourceTypes:
              planning.safeResourceTypes,
            admittedResourceTypes:
              planning.admittedResourceTypes,
            rejectedByReason:
              planning.rejectedByReason,
          },
    coverage: {
      startTick: finiteNumberOrNull(
        ledger?.coverageStartTick,
      ),
      receiptHead:
        typeof ledger?.receiptHeadHash === "string"
          ? ledger.receiptHeadHash
          : null,
    },
    highWater: {
      finalizedAttemptSeq: finiteNumberOrNull(
        ledger?.finalizedAttemptSeq,
      ),
      nextAttemptSeq: finiteNumberOrNull(
        ledger?.nextAttemptSeq,
      ),
      permitEpoch: finiteNumberOrNull(
        ledger?.permitEpochHighWater,
      ),
      permitChainHead:
        typeof ledger?.permitChainHeadHighWater === "string"
          ? ledger.permitChainHeadHighWater
          : null,
    },
    ledger: {
      pending: summarizeContinuousDirectPending(
        ledger?.pending,
      ),
      quarantinedCount: finiteNumberOrNull(
        ledger?.quarantinedCount,
      ),
      lifetimeConfirmed:
        summarizeContinuousDirectLifetime(
          ledger?.lifetimeConfirmed,
        ),
      blocker: ledgerBlocker,
    },
    blocker: effectiveBlocker,
  };
}

function summarizeBoundedStringSet(value, limit) {
  if (!Array.isArray(value)) return null;
  const rawValues = [
    ...new Set(
      value.filter((entry) => typeof entry === "string"),
    ),
  ].sort();
  return {
    total: rawValues.length,
    values: rawValues
      .slice(0, limit)
      .map((entry) => boundedStringOrNull(entry)),
    truncated: rawValues.length > limit,
  };
}

function summarizeMarketBaseCatalog(value) {
  const catalog = objectOrNull(value);
  if (!catalog) return null;
  return {
    revision: boundedStringOrNull(catalog.revision),
    configRevision: boundedStringOrNull(
      catalog.configRevision,
    ),
    resources: summarizeBoundedStringSet(
      catalog.resources,
      MARKET_BASE_RESOURCE_CATALOG_LIMIT,
    ),
  };
}

function summarizeMarketBaseRoster(value) {
  const scope = objectOrNull(value);
  if (!scope) return null;
  const rawRooms = Array.isArray(scope.sellerRooms)
    ? scope.sellerRooms
        .filter(
          (room) =>
            room &&
            typeof room === "object" &&
            !Array.isArray(room),
        )
        .sort((left, right) =>
          String(left.roomName ?? "").localeCompare(
            String(right.roomName ?? ""),
          ),
        )
    : null;
  const knownRoomNames = summarizeBoundedStringSet(
    objectOrNull(scope.roomRegistry)?.knownRoomNames,
    MARKET_BASE_RESOURCE_ROSTER_LIMIT,
  );
  return {
    updatedAt: finiteNumberOrNull(scope.updatedAt),
    accountIdentity: boundedStringOrNull(
      scope.accountIdentity,
    ),
    sharedPolicyFingerprint: boundedStringOrNull(
      scope.sharedPolicyFingerprint,
    ),
    rosterFingerprint: boundedStringOrNull(
      scope.rosterFingerprint,
    ),
    laneSetFingerprint: boundedStringOrNull(
      scope.laneSetFingerprint,
    ),
    shadowCursor: boundedStringOrNull(scope.shadowCursor),
    knownRoomNames,
    roomCount: rawRooms === null ? null : rawRooms.length,
    rooms:
      rawRooms === null
        ? null
        : rawRooms
            .slice(0, MARKET_BASE_RESOURCE_ROSTER_LIMIT)
            .map((room) => ({
              roomName: boundedStringOrNull(room.roomName),
              roomInstanceId: boundedStringOrNull(
                room.roomInstanceId,
              ),
              incarnation: finiteNumberOrNull(
                room.incarnation,
              ),
              roomClass: boundedStringOrNull(room.roomClass),
              terminalId: boundedStringOrNull(room.terminalId),
              status: boundedStringOrNull(room.status),
            })),
    truncated:
      rawRooms === null
        ? null
        : rawRooms.length >
          MARKET_BASE_RESOURCE_ROSTER_LIMIT,
  };
}

function summarizeMarketBaseLifecycles(value) {
  const scope = objectOrNull(value);
  if (!scope || !Array.isArray(scope.laneLifecycles)) {
    return null;
  }
  const lanes = scope.laneLifecycles
    .filter(
      (lane) =>
        lane &&
        typeof lane === "object" &&
        !Array.isArray(lane),
    )
    .sort((left, right) =>
      String(left.laneId ?? "").localeCompare(
        String(right.laneId ?? ""),
      ),
    );
  return {
    total: lanes.length,
    samples: lanes
      .slice(0, MARKET_BASE_RESOURCE_LIFECYCLE_LIMIT)
      .map((lane) => {
        const shadow = objectOrNull(lane.shadowEvidence);
        return {
          laneId: boundedStringOrNull(lane.laneId),
          resource: boundedStringOrNull(lane.resource),
          sellerRoomName: boundedStringOrNull(
            lane.sellerRoomName,
          ),
          roomInstanceId: boundedStringOrNull(
            lane.roomInstanceId,
          ),
          stage: boundedStringOrNull(lane.stage),
          status: boundedStringOrNull(lane.status),
          completeShadowCycles: finiteNumberOrNull(
            shadow?.completeCycles,
          ),
          lastCompleteShadowTick: finiteNumberOrNull(
            shadow?.lastCompleteTick,
          ),
          stableFingerprint: boundedStringOrNull(
            lane.stableFingerprint,
          ),
        };
      }),
    truncated:
      lanes.length >
      MARKET_BASE_RESOURCE_LIFECYCLE_LIMIT,
  };
}

function summarizeMarketBaseGrant(value) {
  const grant = objectOrNull(value);
  if (!grant) return null;
  return {
    laneId: boundedStringOrNull(grant.laneId),
    roomInstanceId: boundedStringOrNull(
      grant.roomInstanceId,
    ),
    resource: boundedStringOrNull(grant.resource),
    stage: boundedStringOrNull(grant.stage),
    status: boundedStringOrNull(grant.status),
    newDealGrant: boundedStringOrNull(grant.newDealGrant),
  };
}

function summarizeMarketBasePermit(value) {
  const chain = objectOrNull(value);
  if (!chain) return null;
  const retained = Array.isArray(chain.retainedPermits)
    ? chain.retainedPermits.filter(
        (permit) =>
          permit &&
          typeof permit === "object" &&
          !Array.isArray(permit),
      )
    : null;
  const currentPermit =
    retained === null
      ? null
      : retained.find(
          (permit) =>
            permit.permitId === chain.currentPermitId,
        ) ?? null;
  const grants = Array.isArray(
    currentPermit?.signedLaneGrants,
  )
    ? currentPermit.signedLaneGrants
        .map(summarizeMarketBaseGrant)
        .filter((grant) => grant !== null)
        .sort((left, right) =>
          String(left.laneId ?? "").localeCompare(
            String(right.laneId ?? ""),
          ),
        )
    : null;
  const prefix = objectOrNull(chain.prefixCheckpoint);
  const blocker = objectOrNull(chain.blocker);
  return {
    schemaVersion: finiteNumberOrNull(
      chain.schemaVersion,
    ),
    hashRevision: boundedStringOrNull(chain.hashRevision),
    currentPermitEpoch: finiteNumberOrNull(
      chain.currentPermitEpoch,
    ),
    currentPermitId: boundedStringOrNull(
      chain.currentPermitId,
    ),
    permitChainHead: boundedStringOrNull(
      chain.permitChainHead,
    ),
    permitEpochHighWater: finiteNumberOrNull(
      chain.permitEpochHighWater,
    ),
    totalChainLength: finiteNumberOrNull(
      chain.totalChainLength,
    ),
    retainedPermitCount:
      retained === null ? null : retained.length,
    prefix:
      prefix === null
        ? null
        : {
            prunedThroughEpoch: finiteNumberOrNull(
              prefix.prunedThroughEpoch,
            ),
            referencedPermitBindingCount:
              Array.isArray(
                prefix.referencedPermitBindings,
              )
                ? prefix.referencedPermitBindings.length
                : null,
            prefixCommitment: boundedStringOrNull(
              prefix.prefixCommitment,
            ),
          },
    legacyV2GrantSuspended: booleanOrNull(
      chain.legacyV2GrantSuspended,
    ),
    grants:
      grants === null
        ? null
        : {
            total: grants.length,
            samples: grants.slice(
              0,
              MARKET_BASE_RESOURCE_LIFECYCLE_LIMIT,
            ),
            truncated:
              grants.length >
              MARKET_BASE_RESOURCE_LIFECYCLE_LIMIT,
          },
    blocker:
      blocker === null
        ? typeof chain.blocker === "string"
          ? {
              code: chain.blocker,
              detectedAt: null,
              detailHash: null,
            }
          : null
        : {
            code: boundedStringOrNull(blocker.code),
            detectedAt: finiteNumberOrNull(
              blocker.detectedAt,
            ),
            detailHash: boundedStringOrNull(
              blocker.detailHash,
            ),
          },
  };
}

function summarizeMarketBaseQuotaBucket(value) {
  const quota = objectOrNull(value);
  if (!quota) return null;
  const limit =
    finiteNumberOrNull(quota.limit) ??
    finiteNumberOrNull(quota.rollingCap) ??
    finiteNumberOrNull(quota.cap);
  const confirmed =
    finiteNumberOrNull(quota.confirmed) ??
    finiteNumberOrNull(quota.confirmedAmount);
  const reserved =
    finiteNumberOrNull(quota.reserved) ??
    finiteNumberOrNull(quota.unmatchedPlannedAmount) ??
    finiteNumberOrNull(quota.unmatched);
  const used =
    finiteNumberOrNull(quota.used) ??
    (confirmed !== null && reserved !== null
      ? confirmed + reserved
      : null);
  return {
    limit,
    confirmed,
    reserved,
    used,
    remaining:
      finiteNumberOrNull(quota.remaining) ??
      (limit !== null && used !== null
        ? Math.max(0, limit - used)
        : null),
  };
}

function summarizeMarketBaseQuotaMap(value, limit) {
  const quotas = objectOrNull(value);
  if (!quotas) return null;
  const entries = Object.entries(quotas)
    .sort(([left], [right]) => left.localeCompare(right));
  return {
    total: entries.length,
    samples: Object.fromEntries(
      entries
        .slice(0, limit)
        .map(([key, quota]) => [
          boundedStringOrNull(key) ?? "",
          summarizeMarketBaseQuotaBucket(quota),
        ]),
    ),
    truncated: entries.length > limit,
  };
}

function summarizeMarketBaseQuota(value) {
  const quota = objectOrNull(value);
  if (!quota) return null;
  return {
    observedAt: finiteNumberOrNull(quota.observedAt),
    revision: boundedStringOrNull(quota.revision),
    global: summarizeMarketBaseQuotaBucket(
      quota.global,
    ),
    resources: summarizeMarketBaseQuotaMap(
      quota.resources,
      MARKET_BASE_RESOURCE_CATALOG_LIMIT,
    ),
    rooms: summarizeMarketBaseQuotaMap(
      quota.rooms,
      MARKET_BASE_RESOURCE_ROSTER_LIMIT,
    ),
    lanes: summarizeMarketBaseQuotaMap(
      quota.lanes,
      MARKET_BASE_RESOURCE_LIFECYCLE_LIMIT,
    ),
    confirmedCooldownNotBefore: finiteNumberOrNull(
      quota.confirmedCooldownNotBefore ??
        quota.cooldownNotBefore,
    ),
    retryNotBefore: finiteNumberOrNull(
      quota.retryNotBefore,
    ),
  };
}

function summarizeMarketBaseReadinessAuthorization(value) {
  const authorization = objectOrNull(value);
  if (!authorization) return null;
  const rooms = Array.isArray(authorization.rooms)
    ? authorization.rooms
        .filter(
          (room) =>
            room &&
            typeof room === "object" &&
            !Array.isArray(room),
        )
        .sort((left, right) =>
          String(left.roomName ?? "").localeCompare(
            String(right.roomName ?? ""),
          ),
        )
    : null;
  return {
    schemaVersion: finiteNumberOrNull(
      authorization.schemaVersion,
    ),
    validated: booleanOrNull(authorization.validated),
    status: boundedStringOrNull(authorization.status),
    revision: boundedStringOrNull(authorization.revision),
    updatedAt: finiteNumberOrNull(
      authorization.updatedAt,
    ),
    expiresAt: finiteNumberOrNull(
      authorization.expiresAt,
    ),
    maxTransactionEnergy: finiteNumberOrNull(
      authorization.maxTransactionEnergy,
    ),
    sourcePermitVersion: finiteNumberOrNull(
      authorization.sourcePermitVersion,
    ),
    roomCount: rooms === null ? null : rooms.length,
    rooms:
      rooms === null
        ? null
        : rooms
            .slice(
              0,
              MARKET_BASE_RESOURCE_READINESS_ROOM_LIMIT,
            )
            .map((room) => ({
              roomName: boundedStringOrNull(room.roomName),
              roomInstanceId: boundedStringOrNull(
                room.roomInstanceId,
              ),
              terminalId: boundedStringOrNull(room.terminalId),
              status: boundedStringOrNull(room.status),
            })),
    truncated:
      rooms === null
        ? null
        : rooms.length >
          MARKET_BASE_RESOURCE_READINESS_ROOM_LIMIT,
  };
}

const MARKET_BASE_RESOURCE_CPU_CUT_PHASES = new Set([
  "outer_session",
  "scope_core_read1",
  "scope_core_read2",
  "market_facts_read1",
  "market_facts_read2",
  "shadow_batch_read1",
  "shadow_batch_read2",
  "inner_apply",
  "outer_precommit",
]);
const MARKET_BASE_RESOURCE_MARKET_FACTS_DISPOSITIONS = new Set([
  "not_reached",
  "skipped_no_consumer",
  "read",
]);

function closedEnumOrNull(value, allowed) {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

function summarizeMarketBaseCpuTrace(value) {
  const trace = objectOrNull(value);
  if (!trace) return null;
  const exactFields = [
    "observedAt",
    "cpuAfterOuterSession",
    "cpuAfterScopeCore",
    "cpuAfterMarketFacts",
    "cpuAfterShadowBatch",
    "cpuAfterInnerApply",
    "cpuCutPhase",
    "marketFactsDisposition",
  ];
  if (
    Object.keys(trace).length !== exactFields.length ||
    exactFields.some((field) => !(field in trace)) ||
    !Number.isSafeInteger(trace.observedAt) ||
    trace.observedAt < 0
  ) {
    return null;
  }
  const cpuValues = [
    trace.cpuAfterOuterSession,
    trace.cpuAfterScopeCore,
    trace.cpuAfterMarketFacts,
    trace.cpuAfterShadowBatch,
    trace.cpuAfterInnerApply,
  ];
  let previous = 0;
  let trailingNull = false;
  for (const candidate of cpuValues) {
    if (candidate === null) {
      trailingNull = true;
      continue;
    }
    if (
      trailingNull ||
      typeof candidate !== "number" ||
      !Number.isFinite(candidate) ||
      candidate < previous ||
      candidate < 0 ||
      candidate > 100
    ) {
      return null;
    }
    previous = candidate;
  }
  if (
    (trace.cpuCutPhase !== null &&
      !MARKET_BASE_RESOURCE_CPU_CUT_PHASES.has(trace.cpuCutPhase)) ||
    !MARKET_BASE_RESOURCE_MARKET_FACTS_DISPOSITIONS.has(
      trace.marketFactsDisposition,
    )
  ) {
    return null;
  }
  return {
    observedAt: trace.observedAt,
    cpuAfterOuterSession: cpuValues[0],
    cpuAfterScopeCore: cpuValues[1],
    cpuAfterMarketFacts: cpuValues[2],
    cpuAfterShadowBatch: cpuValues[3],
    cpuAfterInnerApply: cpuValues[4],
    cpuCutPhase: trace.cpuCutPhase,
    marketFactsDisposition: trace.marketFactsDisposition,
  };
}

function summarizeMarketBasePlanning(value) {
  const planning = objectOrNull(value);
  if (!planning) return null;
  const selected = objectOrNull(planning.selected);
  return {
    observedAt: finiteNumberOrNull(planning.observedAt),
    complete: booleanOrNull(planning.complete),
    blocker: boundedStringOrNull(planning.blocker),
    cpuUsed: finiteNumberOrNull(planning.cpuUsed),
    rawOrderCount: finiteNumberOrNull(
      planning.rawOrderCount,
    ),
    eligibleOrderCount: finiteNumberOrNull(
      planning.eligibleOrderCount,
    ),
    distinctOrderRoomCount: finiteNumberOrNull(
      planning.distinctOrderRoomCount,
    ),
    transactionCostEvaluationBudget:
      finiteNumberOrNull(
        planning.transactionCostEvaluationBudget,
      ),
    shadowPlannerMode: boundedStringOrNull(
      planning.shadowPlannerMode,
    ),
    shadowPlannerInvocationCount: finiteNumberOrNull(
      planning.shadowPlannerInvocationCount,
    ),
    actualTransactionEnergyEvaluations: finiteNumberOrNull(
      planning.actualTransactionEnergyEvaluations,
    ),
    evaluatedShadowResourceCount: finiteNumberOrNull(
      planning.evaluatedShadowResourceCount,
    ),
    candidateIdentityOrderChecks: finiteNumberOrNull(
      planning.candidateIdentityOrderChecks,
    ),
    cpuTrace: summarizeMarketBaseCpuTrace(planning.cpuTrace),
    sampledShadowLaneIds: summarizeBoundedStringSet(
      planning.sampledShadowLaneIds,
      MARKET_BASE_RESOURCE_LIFECYCLE_LIMIT,
    ),
    selected:
      selected === null
        ? null
        : {
            laneId:
              boundedStringOrNull(selected.laneId) ??
              boundedStringOrNull(selected.entryId),
            resourceType:
              boundedStringOrNull(selected.resourceType) ??
              boundedStringOrNull(selected.resource),
            sellerRoom:
              boundedStringOrNull(selected.sellerRoom) ??
              boundedStringOrNull(selected.roomName),
            orderId: boundedStringOrNull(selected.orderId),
            grossPrice: finiteNumberOrNull(
              selected.grossPrice,
            ),
            unitNetPrice: finiteNumberOrNull(
              selected.unitNetPrice,
            ),
            transactionEnergy: finiteNumberOrNull(
              selected.transactionEnergy,
            ),
          },
  };
}

function summarizeMarketBaseResourceV3(value, runtimeCpuTraceValue) {
  const state = objectOrNull(value);
  if (!state) return null;
  const ledger = objectOrNull(state.ledger);
  const quota =
    state.quota ??
    state.quotaProjection ??
    ledger?.quota ??
    ledger?.quotaProjection;
  const planning = summarizeMarketBasePlanning(
    state.lastPlanningSnapshot,
  );
  const runtimeCpuTrace = summarizeMarketBaseCpuTrace(
    runtimeCpuTraceValue,
  );
  const canonicalCpuTrace = planning?.cpuTrace ?? null;
  const cpuTrace =
    runtimeCpuTrace &&
    (!canonicalCpuTrace ||
      (runtimeCpuTrace.observedAt ?? -1) >=
        (canonicalCpuTrace.observedAt ?? -1))
      ? runtimeCpuTrace
      : canonicalCpuTrace;
  if (planning) planning.cpuTrace = cpuTrace;
  return {
    schemaVersion: finiteNumberOrNull(
      state.schemaVersion,
    ),
    catalog: summarizeMarketBaseCatalog(state.catalog),
    roster: summarizeMarketBaseRoster(state.scope),
    lifecycle: summarizeMarketBaseLifecycles(
      state.scope,
    ),
    permit: summarizeMarketBasePermit(
      state.permitChain,
    ),
    quota: summarizeMarketBaseQuota(quota),
    readinessAuthorization:
      summarizeMarketBaseReadinessAuthorization(
        state.readinessAuthorization,
      ),
    planning,
    cpuTrace,
    blocker:
      typeof state.blocker === "string"
        ? {
            code: boundedStringOrNull(state.blocker),
            detectedAt: null,
            detailHash: null,
          }
        : summarizeContinuousDirectBlocker(
            state.blocker,
          ),
  };
}

function summarizeDirectMarketSale(
  value,
  referenceTick,
  rawDirectAutomation,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  if (
    value.capability === "market-direct-continuous" ||
    value.schemaVersion === 2
  ) {
    const summary = summarizeContinuousDirectMarketSale(
      value,
      referenceTick,
    );
    const rawDirect = objectOrNull(rawDirectAutomation);
    summary.baseResourceV3 =
      summarizeMarketBaseResourceV3(
        rawDirect?.baseResourceV3 ??
          value.baseResourceV3,
        value.baseResourceV3CpuTrace,
      );
    return summary;
  }
  return {
    available: true,
    baseResourceV3: summarizeMarketBaseResourceV3(
      objectOrNull(rawDirectAutomation)?.baseResourceV3 ??
        value.baseResourceV3,
      value.baseResourceV3CpuTrace,
    ),
    strategyActive: booleanOrNull(value.strategyActive),
    shadowConsecutiveCycles: finiteNumberOrNull(
      value.shadowConsecutiveCycles,
    ),
    qualifiedAt: finiteNumberOrNull(value.qualifiedAt),
    activationAuthorized: booleanOrNull(value.activationAuthorized),
    canary: summarizeDirectCanary(value.canary),
    pendingCount: finiteNumberOrNull(value.pendingCount),
    pendingByStatus: summarizeCountMapOrNull(value.pendingByStatus),
    confirmedDealCount: finiteNumberOrNull(value.confirmedDealCount),
    pausedForReview: booleanOrNull(value.pausedForReview),
    migrationBlockedReason:
      typeof value.migrationBlockedReason === "string"
        ? value.migrationBlockedReason
        : null,
    exposure:
      value.exposure &&
      typeof value.exposure === "object" &&
      !Array.isArray(value.exposure)
        ? {
            pendingCount: finiteNumberOrNull(
              value.exposure.pendingCount,
            ),
            quarantinedCount: finiteNumberOrNull(
              value.exposure.quarantinedCount,
            ),
            resourceAmount: finiteNumberOrNull(
              value.exposure.resourceAmount,
            ),
            transactionEnergy: finiteNumberOrNull(
              value.exposure.transactionEnergy,
            ),
            reconcileGapCount: finiteNumberOrNull(
              value.exposure.reconcileGapCount,
            ),
          }
        : null,
    snapshot: summarizeDirectPlanningSnapshot(
      value.snapshot,
      referenceTick,
    ),
  };
}

function summarizeMarketSaleAutomation(
  value,
  rawDirectAutomation = null,
) {
  const runtime =
    value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  if (!runtime) {
    return {
      available: false,
      updatedAt: null,
      requestedMode: null,
      phase: null,
      configRevision: null,
      shadowConfigRevision: null,
      shadowConsecutiveCycles: null,
      managedOrderCount: null,
      managedOrders: null,
      managedOrderSummaryTruncated: null,
      orderSlots: null,
      backoffSummary: null,
      pendingCreateCount: null,
      pendingMutationCount: null,
      stagingAmount: null,
      reservationAmount: null,
      exposureAmount: null,
      rollingFeeMilli: null,
      creditReserve: null,
      creditSummary: null,
      terminalClaims: null,
      rejectedByReason: null,
      candidates: null,
      canaryLock: null,
      recentActions: null,
      safetyViolationCount: null,
      direct: null,
    };
  }

  const candidates =
    runtime.candidates && typeof runtime.candidates === "object" && !Array.isArray(runtime.candidates)
      ? Object.entries(runtime.candidates)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, candidate]) => {
            const row =
              candidate && typeof candidate === "object" && !Array.isArray(candidate)
                ? candidate
                : {};
            return {
              key,
              roomName: typeof row.roomName === "string" ? row.roomName : null,
              resource: typeof row.resource === "string" ? row.resource : null,
              revision: finiteNumberOrNull(row.revision),
              observedAt: finiteNumberOrNull(row.observedAt),
              expiresAt: finiteNumberOrNull(row.expiresAt),
              sellableAmount: finiteNumberOrNull(row.sellableAmount),
              protectedAmount: finiteNumberOrNull(row.protectedAmount),
              hardFloor: finiteNumberOrNull(row.hardFloor),
              historyTrusted:
                typeof row.historyTrusted === "boolean"
                  ? row.historyTrusted
                  : null,
              historyCompleteDayCount: finiteNumberOrNull(
                row.historyCompleteDayCount,
              ),
              historyAcceptedDayCount: finiteNumberOrNull(
                row.historyAcceptedDayCount,
              ),
              historyFloor: finiteNumberOrNull(row.historyFloor),
              ratchetFloor: finiteNumberOrNull(row.ratchetFloor),
              effectiveNetFloor: finiteNumberOrNull(row.effectiveNetFloor),
              makerPrice: finiteNumberOrNull(row.makerPrice),
              makerNetPrice: finiteNumberOrNull(row.makerNetPrice),
              bestDirectNetPrice: finiteNumberOrNull(row.bestDirectNetPrice),
              rejectedReason:
                typeof row.rejectedReason === "string" ? row.rejectedReason : null,
            };
          })
      : null;
  const managedOrders = Array.isArray(runtime.managedOrders)
    ? runtime.managedOrders
        .filter(
          (managed) =>
            managed &&
            typeof managed === "object" &&
            !Array.isArray(managed),
        )
        .sort((left, right) => {
          const leftId =
            typeof left.orderId === "string" ? left.orderId : "";
          const rightId =
            typeof right.orderId === "string" ? right.orderId : "";
          return leftId.localeCompare(rightId);
        })
        .slice(0, 20)
        .map((managed) => ({
          orderId:
            typeof managed.orderId === "string" ? managed.orderId : null,
          roomName:
            typeof managed.roomName === "string" ? managed.roomName : null,
          resourceType:
            typeof managed.resourceType === "string"
              ? managed.resourceType
              : null,
          remainingExposure: finiteNumberOrNull(
            managed.remainingExposure,
          ),
          liveRemainingAmount: finiteNumberOrNull(
            managed.liveRemainingAmount,
          ),
          policyCancelAtTick: finiteNumberOrNull(
            managed.policyCancelAtTick,
          ),
          backoffUntil: finiteNumberOrNull(managed.backoffUntil),
          pendingMutationKind:
            typeof managed.pendingMutationKind === "string"
              ? managed.pendingMutationKind
              : null,
        }))
    : null;
  const orderSlots =
    runtime.orderSlots &&
    typeof runtime.orderSlots === "object" &&
    !Array.isArray(runtime.orderSlots)
      ? {
          total: finiteNumberOrNull(runtime.orderSlots.total),
          current: finiteNumberOrNull(runtime.orderSlots.current),
          free: finiteNumberOrNull(runtime.orderSlots.free),
          reserved: finiteNumberOrNull(runtime.orderSlots.reserved),
          minFree: finiteNumberOrNull(runtime.orderSlots.minFree),
        }
      : null;
  const backoffSummary =
    runtime.backoffSummary &&
    typeof runtime.backoffSummary === "object" &&
    !Array.isArray(runtime.backoffSummary)
      ? {
          activeCount: finiteNumberOrNull(
            runtime.backoffSummary.activeCount,
          ),
          nextUntil: finiteNumberOrNull(runtime.backoffSummary.nextUntil),
        }
      : null;
  const creditSummary =
    runtime.creditSummary &&
    typeof runtime.creditSummary === "object" &&
    !Array.isArray(runtime.creditSummary)
      ? {
          credits: finiteNumberOrNull(runtime.creditSummary.credits),
          reserve: finiteNumberOrNull(runtime.creditSummary.reserve),
          reservedFeesThisTick: finiteNumberOrNull(
            runtime.creditSummary.reservedFeesThisTick,
          ),
          availableAfterReserve: finiteNumberOrNull(
            runtime.creditSummary.availableAfterReserve,
          ),
        }
      : null;
  const lock =
    runtime.canaryLock &&
    typeof runtime.canaryLock === "object" &&
    !Array.isArray(runtime.canaryLock)
      ? {
          roomName:
            typeof runtime.canaryLock.roomName === "string"
              ? runtime.canaryLock.roomName
              : null,
          resourceType:
            typeof runtime.canaryLock.resourceType === "string"
              ? runtime.canaryLock.resourceType
              : null,
          lockedAt: finiteNumberOrNull(runtime.canaryLock.lockedAt),
          configRevision:
            typeof runtime.canaryLock.configRevision === "string"
              ? runtime.canaryLock.configRevision
              : null,
        }
      : null;

  return {
    available: true,
    updatedAt: finiteNumberOrNull(runtime.updatedAt),
    requestedMode:
      typeof runtime.requestedMode === "string" ? runtime.requestedMode : null,
    phase: typeof runtime.phase === "string" ? runtime.phase : null,
    configRevision:
      typeof runtime.configRevision === "string" ? runtime.configRevision : null,
    shadowConfigRevision:
      typeof runtime.shadowConfigRevision === "string"
        ? runtime.shadowConfigRevision
        : null,
    shadowConsecutiveCycles: finiteNumberOrNull(runtime.shadowConsecutiveCycles),
    managedOrderCount: finiteNumberOrNull(runtime.managedOrderCount),
    managedOrders,
    managedOrderSummaryTruncated:
      typeof runtime.managedOrderSummaryTruncated === "boolean"
        ? runtime.managedOrderSummaryTruncated
        : null,
    orderSlots,
    backoffSummary,
    pendingCreateCount: finiteNumberOrNull(runtime.pendingCreateCount),
    pendingMutationCount: finiteNumberOrNull(runtime.pendingMutationCount),
    stagingAmount: finiteNumberOrNull(runtime.stagingAmount),
    reservationAmount: finiteNumberOrNull(runtime.reservationAmount),
    exposureAmount: finiteNumberOrNull(runtime.exposureAmount),
    rollingFeeMilli: finiteNumberOrNull(runtime.rollingFeeMilli),
    creditReserve: finiteNumberOrNull(runtime.creditReserve),
    creditSummary,
    terminalClaims: Array.isArray(runtime.terminalClaims)
      ? runtime.terminalClaims.filter((claim) => typeof claim === "string")
      : null,
    rejectedByReason: summarizeCountMapOrNull(runtime.rejectedByReason),
    candidates,
    canaryLock: lock,
    recentActions: Array.isArray(runtime.recentActions)
      ? runtime.recentActions.filter((action) => typeof action === "string").slice(-20)
      : null,
    safetyViolationCount: finiteNumberOrNull(runtime.safetyViolationCount),
    direct: summarizeDirectMarketSale(
      runtime.direct,
      finiteNumberOrNull(runtime.updatedAt),
      rawDirectAutomation,
    ),
  };
}

function parseSegmentSnapshot(segmentId, payload) {
  if (!payload || typeof payload !== "object") {
    return {
      segmentId,
      parsed: null,
      rawSize: 0,
    };
  }

  const raw = "data" in payload ? payload.data : null;
  if (typeof raw === "string") {
    const parsed = decodeScreepsDataString(raw);
    return {
      segmentId,
      parsed,
      rawSize: raw.length,
    };
  }

  if (raw && typeof raw === "object") {
    return {
      segmentId,
      parsed: raw,
      rawSize: JSON.stringify(raw).length,
    };
  }

  return {
    segmentId,
    parsed: null,
    rawSize: 0,
  };
}

function extractAnalyticsData(parsed) {
  let production = null;
  let moduleCpu = null;
  let cpuMonitor = null;
  let hub = null;

  if (!parsed || typeof parsed !== "object") {
    return { production, moduleCpu, cpuMonitor, hub };
  }

  if ("analytics" in parsed && parsed.analytics) {
    const analytics = parsed.analytics;
    if (typeof analytics === "object" && analytics) {
      if ("production" in analytics) production = analytics.production;
      if ("moduleCpu" in analytics) moduleCpu = analytics.moduleCpu;
      if ("cpuMonitor" in analytics) cpuMonitor = analytics.cpuMonitor;
      if ("hub" in analytics) hub = analytics.hub;
    }
  }
  if (!production && "production" in parsed && parsed.production) {
    production = parsed.production;
    if (!moduleCpu && "moduleCpu" in parsed) moduleCpu = parsed.moduleCpu;
    if (!cpuMonitor && "cpuMonitor" in parsed) cpuMonitor = parsed.cpuMonitor;
  }
  if (!production && "rooms" in parsed) {
    production = parsed;
    if (!moduleCpu && "moduleCpu" in parsed) moduleCpu = parsed.moduleCpu;
    if (!cpuMonitor && "cpuMonitor" in parsed) cpuMonitor = parsed.cpuMonitor;
  }
  // Top-level hub or cpuMonitor overrides
  if ("hub" in parsed && parsed.hub) hub = parsed.hub;
  if ("cpuMonitor" in parsed && parsed.cpuMonitor && !cpuMonitor) cpuMonitor = parsed.cpuMonitor;

  return { production, moduleCpu, cpuMonitor, hub };
}

function extractFixtureResourceControlData(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return {
      runtimeResourceControl: null,
      runtimeHub: null,
      transferTaskStore: null,
      dataResourceControlLogistics: null,
      runtimeMarketSaleAutomation: null,
      dataDirectAutomation: null,
    };
  }

  const runtime = parsed.runtime && typeof parsed.runtime === "object" ? parsed.runtime : null;
  const data = parsed.data && typeof parsed.data === "object" ? parsed.data : null;
  const dataResourceControl =
    data && data.resourceControl && typeof data.resourceControl === "object" ? data.resourceControl : null;
  const dataMarketSaleAutomation =
    data &&
    data.marketSaleAutomation &&
    typeof data.marketSaleAutomation === "object" &&
    !Array.isArray(data.marketSaleAutomation)
      ? data.marketSaleAutomation
      : null;

  return {
    runtimeResourceControl:
      runtime && runtime.resourceControl && typeof runtime.resourceControl === "object"
        ? runtime.resourceControl
        : null,
    runtimeHub:
      runtime && runtime.hub && typeof runtime.hub === "object"
        ? runtime.hub
        : null,
    transferTaskStore:
      dataResourceControl && dataResourceControl.tasks && typeof dataResourceControl.tasks === "object"
        ? dataResourceControl.tasks
        : null,
    dataResourceControlLogistics:
      dataResourceControl &&
      dataResourceControl.logistics &&
      typeof dataResourceControl.logistics === "object" &&
      !Array.isArray(dataResourceControl.logistics)
        ? dataResourceControl.logistics
        : null,
    runtimeMarketSaleAutomation:
      runtime &&
      runtime.marketSaleAutomation &&
      typeof runtime.marketSaleAutomation === "object"
        ? runtime.marketSaleAutomation
        : null,
    dataDirectAutomation:
      dataMarketSaleAutomation &&
      dataMarketSaleAutomation.directAutomation &&
      typeof dataMarketSaleAutomation.directAutomation ===
        "object" &&
      !Array.isArray(
        dataMarketSaleAutomation.directAutomation,
      )
        ? dataMarketSaleAutomation.directAutomation
        : null,
  };
}

function createFixtureMemoryPathReader(parsed) {
  const fixtureReadSequences = objectOrNull(
    objectOrNull(parsed)?.__monitorMemoryPathReads,
  );
  const sequenceIndexes = new Map();
  const reader = async (path) => {
    const sequence = fixtureReadSequences?.[path];
    if (Array.isArray(sequence) && sequence.length > 0) {
      const index = sequenceIndexes.get(path) || 0;
      if (index >= sequence.length) {
        throw new Error(
          `Fixture memory read sequence exhausted for ${path}`,
        );
      }
      sequenceIndexes.set(path, index + 1);
      return sequence[index];
    }
    let current = parsed;
    for (const part of path.split(".")) {
      current = objectOrNull(current)?.[part];
      if (current === undefined) return null;
    }
    return current ?? null;
  };
  reader.assertExhausted = () => {
    for (const [path, sequence] of Object.entries(
      fixtureReadSequences || {},
    )) {
      if (
        Array.isArray(sequence) &&
        (sequenceIndexes.get(path) || 0) !== sequence.length
      ) {
        throw new Error(
          `Fixture memory read sequence not exhausted for ${path}`,
        );
      }
    }
  };
  return reader;
}

async function fetchOptionalMemoryPath(config, shard, path) {
  try {
    const { payload } = await fetchApiJson(config, "/api/user/memory", { shard, path });
    return parseMemoryBody(payload);
  } catch {
    return null;
  }
}

const COHERENT_LOGISTICS_SNAPSHOT = Object.freeze({
  snapshotIncoherent: false,
  inconclusive: false,
  attestationMatched: true,
  retryCount: 0,
  initialEpochSkew: false,
});

const UNVERIFIED_LOGISTICS_SNAPSHOT = Object.freeze({
  ...COHERENT_LOGISTICS_SNAPSHOT,
  attestationMatched: false,
});

function extractResourceControlLogistics(value) {
  const resourceControl = objectOrNull(value);
  return objectOrNull(resourceControl?.logistics);
}

function extractLogisticsRuntimeEpoch(runtimeResourceControl) {
  const logistics = extractResourceControlLogistics(
    runtimeResourceControl,
  );
  return nonNegativeSafeIntegerOrNull(logistics?.updatedAt);
}

function extractLogisticsDataEpoch(dataResourceControl) {
  const logistics = extractResourceControlLogistics(
    dataResourceControl,
  );
  const strings = logistics?.s;
  const snapshots = logistics?.p;
  if (!Array.isArray(strings) || !Array.isArray(snapshots)) {
    return null;
  }
  let producerEpoch = null;
  for (const snapshot of snapshots) {
    if (!Array.isArray(snapshot)) continue;
    const producerIndex = nonNegativeSafeIntegerOrNull(
      snapshot[0],
      strings.length - 1,
    );
    if (
      producerIndex === null ||
      strings[producerIndex] !==
        RESOURCE_CONTROL_LOGISTICS_SYNTHESIS_PRODUCER
    ) {
      continue;
    }
    const observedAt = nonNegativeSafeIntegerOrNull(snapshot[3]);
    if (observedAt === null || producerEpoch !== null) return null;
    producerEpoch = observedAt;
  }
  return producerEpoch;
}

function logisticsPairMatchesAttestation(
  runtimeResourceControl,
  dataResourceControl,
) {
  const runtimeLogistics = extractResourceControlLogistics(
    runtimeResourceControl,
  );
  const dataLogistics = extractResourceControlLogistics(
    dataResourceControl,
  );
  if (
    runtimeLogistics?.available !== true ||
    !dataLogistics
  ) {
    return false;
  }
  const runtimeEpoch = extractLogisticsRuntimeEpoch(
    runtimeResourceControl,
  );
  const dataEpoch = extractLogisticsDataEpoch(dataResourceControl);
  const attestedBytes = nonNegativeSafeIntegerOrNull(
    objectOrNull(runtimeLogistics.resources)?.dataBytes,
  );
  const observedBytes = serializedUtf8ByteLengthOrNull(dataLogistics);
  return runtimeEpoch !== null &&
    dataEpoch === runtimeEpoch &&
    attestedBytes !== null &&
    observedBytes === attestedBytes;
}

function selectCoherentLogisticsRuntime(
  firstRuntimeResourceControl,
  dataResourceControl,
  secondRuntimeResourceControl,
) {
  // Prefer the newer endpoint of the bracket. If data belongs to R1, retaining
  // that historical pair is still coherent and safer than mixing it with R2.
  if (
    logisticsPairMatchesAttestation(
      secondRuntimeResourceControl,
      dataResourceControl,
    )
  ) {
    return secondRuntimeResourceControl;
  }
  if (
    logisticsPairMatchesAttestation(
      firstRuntimeResourceControl,
      dataResourceControl,
    )
  ) {
    return firstRuntimeResourceControl;
  }
  return null;
}

function logisticsSnapshotEpochSkew(
  firstRuntimeResourceControl,
  dataResourceControl,
  secondRuntimeResourceControl,
) {
  const readableEpochs = [
    extractLogisticsRuntimeEpoch(firstRuntimeResourceControl),
    extractLogisticsDataEpoch(dataResourceControl),
    extractLogisticsRuntimeEpoch(secondRuntimeResourceControl),
  ].filter((epoch) => epoch !== null);
  return readableEpochs.length >= 2 &&
    new Set(readableEpochs).size > 1;
}

async function fetchCoherentResourceControlPair(readMemoryPath) {
  const firstRuntimeResourceControl = await readMemoryPath(
    "runtime.resourceControl",
  );
  const firstDataResourceControl = await readMemoryPath(
    "data.resourceControl",
  );

  // Every observation is a full R1-D-R2 bracket, including the common case
  // where R1 and D already appear to match. Otherwise a write immediately
  // after D could be mistaken for a coherent latest snapshot.
  const secondRuntimeResourceControl = await readMemoryPath(
    "runtime.resourceControl",
  );
  const initialEpochSkew = logisticsSnapshotEpochSkew(
    firstRuntimeResourceControl,
    firstDataResourceControl,
    secondRuntimeResourceControl,
  );
  const initialCoherentRuntime = selectCoherentLogisticsRuntime(
    firstRuntimeResourceControl,
    firstDataResourceControl,
    secondRuntimeResourceControl,
  );
  if (initialCoherentRuntime) {
    return {
      runtimeResourceControl: initialCoherentRuntime,
      dataResourceControl: firstDataResourceControl,
      snapshotCoherence: {
        ...COHERENT_LOGISTICS_SNAPSHOT,
        initialEpochSkew,
      },
    };
  }
  if (
    extractResourceControlLogistics(firstRuntimeResourceControl)
      ?.available !== true &&
    extractResourceControlLogistics(secondRuntimeResourceControl)
      ?.available !== true
  ) {
    return {
      runtimeResourceControl: secondRuntimeResourceControl ||
        firstRuntimeResourceControl,
      dataResourceControl: firstDataResourceControl,
      snapshotCoherence: UNVERIFIED_LOGISTICS_SNAPSHOT,
    };
  }

  // A stable R1-D-R2 epoch proves a real same-epoch attestation failure.
  // Retrying it would hide corruption, so preserve strict fail-closed output.
  if (!initialEpochSkew) {
    return {
      runtimeResourceControl: secondRuntimeResourceControl,
      dataResourceControl: firstDataResourceControl,
      snapshotCoherence: UNVERIFIED_LOGISTICS_SNAPSHOT,
    };
  }

  // Exactly one bounded retry is permitted after an observed epoch crossing.
  const retryFirstRuntimeResourceControl = await readMemoryPath(
    "runtime.resourceControl",
  );
  const retryDataResourceControl = await readMemoryPath(
    "data.resourceControl",
  );
  const retrySecondRuntimeResourceControl = await readMemoryPath(
    "runtime.resourceControl",
  );
  const retryCoherentRuntime = selectCoherentLogisticsRuntime(
    retryFirstRuntimeResourceControl,
    retryDataResourceControl,
    retrySecondRuntimeResourceControl,
  );
  if (retryCoherentRuntime) {
    return {
      runtimeResourceControl: retryCoherentRuntime,
      dataResourceControl: retryDataResourceControl,
      snapshotCoherence: {
        ...COHERENT_LOGISTICS_SNAPSHOT,
        retryCount: 1,
        initialEpochSkew: true,
      },
    };
  }

  const retryEpochSkew = logisticsSnapshotEpochSkew(
    retryFirstRuntimeResourceControl,
    retryDataResourceControl,
    retrySecondRuntimeResourceControl,
  );
  return {
    runtimeResourceControl: retrySecondRuntimeResourceControl,
    dataResourceControl: retryDataResourceControl,
    snapshotCoherence: {
      snapshotIncoherent: retryEpochSkew,
      inconclusive: retryEpochSkew,
      attestationMatched: false,
      retryCount: 1,
      initialEpochSkew: true,
    },
  };
}

function extractResourceControlDataStore(dataResourceControl) {
  const data = objectOrNull(dataResourceControl);
  return {
    transferTaskStore: objectOrNull(data?.tasks),
    dataResourceControlLogistics: objectOrNull(data?.logistics),
  };
}

async function fetchResourceControlData(config, shard) {
  const readMemoryPath = (path) =>
    fetchOptionalMemoryPath(config, shard, path);
  const [
    resourceControlPair,
    runtimeHub,
    runtimeMarketSaleAutomation,
    dataDirectAutomation,
  ] =
    await Promise.all([
    fetchCoherentResourceControlPair(readMemoryPath),
    // --lean-memory skips gate-irrelevant path reads (hub analytics and the
    // direct-market data store) so long captures fit the daily API quota.
    config.leanMemory
      ? null
      : await fetchOptionalMemoryPath(config, shard, "runtime.hub"),
    fetchOptionalMemoryPath(config, shard, "runtime.marketSaleAutomation"),
    config.leanMemory
      ? null
      : await fetchOptionalMemoryPath(
          config,
          shard,
          "data.marketSaleAutomation.directAutomation",
        ),
  ]);
  const {
    transferTaskStore,
    dataResourceControlLogistics,
  } = extractResourceControlDataStore(
    resourceControlPair.dataResourceControl,
  );
  return {
    runtimeResourceControl:
      resourceControlPair.runtimeResourceControl,
    runtimeHub,
    transferTaskStore,
    dataResourceControlLogistics,
    snapshotCoherence: resourceControlPair.snapshotCoherence,
    runtimeMarketSaleAutomation,
    dataDirectAutomation,
  };
}

async function fetchMemorySnapshot(config, options = {}) {
  // Fixture mode: read from file instead of API
  if (config.memoryFixture) {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(config.memoryFixture, "utf-8");
    const parsed = JSON.parse(raw);
    const rateLimit = { limit: "?", remaining: "?", reset: "?" };
    const { production, moduleCpu, cpuMonitor, hub } = extractAnalyticsData(parsed);
    const fixtureResourceControl =
      extractFixtureResourceControlData(parsed);
    const {
      runtimeHub,
      runtimeMarketSaleAutomation,
      dataDirectAutomation,
    } = fixtureResourceControl;
    const fixtureMemoryPathReader =
      createFixtureMemoryPathReader(parsed);
    const resourceControlPair =
      await fetchCoherentResourceControlPair(
        fixtureMemoryPathReader,
      );
    fixtureMemoryPathReader.assertExhausted();
    const {
      transferTaskStore,
      dataResourceControlLogistics,
    } = extractResourceControlDataStore(
      resourceControlPair.dataResourceControl,
    );
    const summary = summarizeProduction(production);
    const cpuPhaseEvidence =
      buildResourceControlCpuPhaseEvidence(cpuMonitor);

    const snapshot = {
      source: "memory",
      fetchedAt: new Date().toISOString(),
      rateLimit,
      summary,
      cpuMonitor: summarizeCpuMonitor(cpuMonitor, moduleCpu),
      moduleCpu: summarizeModuleCpu(moduleCpu),
      hub: summarizeHub(hub, runtimeHub),
      resourceControl: summarizeResourceControl(
        resourceControlPair.runtimeResourceControl,
        transferTaskStore,
        dataResourceControlLogistics,
        summary.latestTick,
        resourceControlPair.snapshotCoherence,
        cpuPhaseEvidence,
      ),
      marketSaleAutomation: summarizeMarketSaleAutomation(
        runtimeMarketSaleAutomation,
        dataDirectAutomation,
      ),
    };
    Object.defineProperty(snapshot, "_resourceControlCpuPhaseEvidence", {
      value: cpuPhaseEvidence,
      enumerable: false,
    });
    return snapshot;
  }

  const { payload, rateLimit } = await fetchApiJson(config, "/api/user/memory", {
    shard: config.shard,
    path: "analytics",
  });
  const memoryOrProduction = parseMemoryBody(payload);
  const { production, moduleCpu, cpuMonitor, hub } = extractAnalyticsData(memoryOrProduction);
  const summary = summarizeProduction(production);
  const cpuPhaseEvidence =
    buildResourceControlCpuPhaseEvidence(cpuMonitor);
  const {
    runtimeResourceControl,
    runtimeHub,
    transferTaskStore,
    dataResourceControlLogistics,
    snapshotCoherence,
    runtimeMarketSaleAutomation,
    dataDirectAutomation,
  } = options.includeResourceControl === false
    ? {
      runtimeResourceControl: null,
      runtimeHub: null,
      transferTaskStore: null,
      dataResourceControlLogistics: null,
      snapshotCoherence: UNVERIFIED_LOGISTICS_SNAPSHOT,
      runtimeMarketSaleAutomation: null,
      dataDirectAutomation: null,
    }
    : await fetchResourceControlData(config, config.shard);

  const snapshot = {
    source: "memory",
    fetchedAt: new Date().toISOString(),
    rateLimit,
    summary,
    cpuMonitor: summarizeCpuMonitor(cpuMonitor, moduleCpu),
    moduleCpu: summarizeModuleCpu(moduleCpu),
    hub: summarizeHub(hub, runtimeHub),
    resourceControl: summarizeResourceControl(
      runtimeResourceControl,
      transferTaskStore,
      dataResourceControlLogistics,
      summary.latestTick,
      snapshotCoherence,
      cpuPhaseEvidence,
    ),
    marketSaleAutomation: summarizeMarketSaleAutomation(
      runtimeMarketSaleAutomation,
      dataDirectAutomation,
    ),
  };
  Object.defineProperty(snapshot, "_resourceControlCpuPhaseEvidence", {
    value: cpuPhaseEvidence,
    enumerable: false,
  });
  return snapshot;
}

function extractDeployTime(lastDeployTag) {
  if (typeof lastDeployTag !== "string") {
    return -1;
  }

  const markerIndex = lastDeployTag.lastIndexOf("@");
  if (markerIndex < 0) {
    return -1;
  }

  const parsed = Date.parse(lastDeployTag.slice(markerIndex + 1));
  return Number.isFinite(parsed) ? parsed : -1;
}

async function fetchRuntimeInfo(config, shard) {
  try {
    const { payload } = await fetchApiJson(config, "/api/user/memory", {
      shard,
      path: "runtime",
    });
    const runtime = parseMemoryBody(payload);
    const lastDeployTag = runtime && typeof runtime === "object" ? runtime.lastDeployTag ?? null : null;
    return {
      lastDeployTag,
      deployTime: extractDeployTime(lastDeployTag),
    };
  } catch {
    return {
      lastDeployTag: null,
      deployTime: -1,
    };
  }
}

async function fetchSegmentSnapshot(config, segmentId) {
  const { payload, rateLimit } = await fetchApiJson(config, "/api/user/memory-segment", {
    segment: segmentId,
    shard: config.shard,
  });

  return {
    source: "segment",
    fetchedAt: new Date().toISOString(),
    rateLimit,
    snapshot: parseSegmentSnapshot(segmentId, payload),
  };
}

async function appendSnapshot(outputPath, payload) {
  if (!outputPath) {
    return;
  }
  const absolute = resolve(process.cwd(), outputPath);
  await mkdir(dirname(absolute), { recursive: true });
  await appendFile(absolute, `${JSON.stringify(payload)}\n`, "utf8");
}

function createState(config) {
  return {
    startedAt: new Date().toISOString(),
    config: {
      baseUrl: config.baseUrl,
      memoryIntervalMs: config.memoryIntervalMs,
      segmentId: config.segmentId,
      shard: config.shard,
      segmentIntervalMs: config.segmentIntervalMs,
      outputPath: config.outputPath,
      port: config.port,
    },
    latest: {
      memory: null,
      segment: null,
    },
    history: [],
    errors: [],
  };
}

function pushHistory(state, entry, limit) {
  state.history.push(entry);
  while (state.history.length > limit) {
    state.history.shift();
  }
}

function pushError(state, message, limit) {
  state.errors.push({
    at: new Date().toISOString(),
    message,
  });
  while (state.errors.length > limit) {
    state.errors.shift();
  }
}

function summarizeState(state) {
  const memory = state.latest.memory;
  const segment = state.latest.segment;
  const cpuMonitor = memory && memory.cpuMonitor ? memory.cpuMonitor : null;
  const moduleCpu = memory && memory.moduleCpu ? memory.moduleCpu : null;
  const segmentParsed =
    segment && segment.snapshot && segment.snapshot.parsed && typeof segment.snapshot.parsed === "object"
      ? segment.snapshot.parsed
      : null;

  // Prefer v2 cpuMonitor from segment, fall back to legacy moduleCpu
  const segmentCpuMonitor =
    segmentParsed && segmentParsed.cpuMonitor && typeof segmentParsed.cpuMonitor === "object"
      ? summarizeCpuMonitor(segmentParsed.cpuMonitor, segmentParsed.moduleCpu)
      : (segmentParsed && segmentParsed.moduleCpu
        ? summarizeCpuMonitor(null, segmentParsed.moduleCpu)
        : null);

  const latestCpu = cpuMonitor && cpuMonitor.available ? cpuMonitor :
    (segmentCpuMonitor && segmentCpuMonitor.available ? segmentCpuMonitor : null);
  const latestCpuLatest = latestCpu && latestCpu.latest ? latestCpu.latest : null;

  const segmentTruncated = !!(segmentParsed && segmentParsed.truncated);
  const segmentSchemaVersion = segmentParsed && typeof segmentParsed.version === "number" ? segmentParsed.version : null;

  return {
    startedAt: state.startedAt,
    roomCount: memory ? memory.summary.roomCount : 0,
    latestTick: memory ? memory.summary.latestTick : null,
    totals: memory ? memory.summary.totals : null,
    hub: memory?.hub ?? null,
    resourceControl: memory?.resourceControl ?? null,
    marketSaleAutomation: memory?.marketSaleAutomation ?? null,
    cpuMonitorAvailable: latestCpu ? latestCpu.available : false,
    cpuMonitorVersion: latestCpu ? latestCpu.version : null,
    cpuMonitorSource: latestCpu ? latestCpu.source : null,
    cpuMonitorTick: latestCpuLatest ? latestCpuLatest.tick : null,
    cpuMonitorTotalUsed: latestCpuLatest ? latestCpuLatest.totalUsed : null,
    cpuMonitorEmaTotalUsed: latestCpuLatest ? latestCpuLatest.emaTotalUsed : null,
    cpuMonitorTopPhases: latestCpuLatest ? latestCpuLatest.topPhases : [],
    cpuMonitorTopRooms: latestCpuLatest ? (latestCpuLatest.topRooms || []) : [],
    cpuMonitorTopRoomRoles: latestCpuLatest ? (latestCpuLatest.topRoomRoles || []) : [],
    cpuMonitorHeap: latestCpuLatest ? (latestCpuLatest.heap || null) : null,
    cpuMonitorFixedActionEstimate: latestCpuLatest ? (latestCpuLatest.fixedActionEstimate || 0) : 0,
    cpuMonitorSummary: latestCpu && latestCpu.summary ? latestCpu.summary : null,
    moduleCpuAvailable: moduleCpu ? moduleCpu.available : false,
    moduleCpuTick: moduleCpu && moduleCpu.latest ? moduleCpu.latest.tick : null,
    moduleCpuTotalUsed: moduleCpu && moduleCpu.latest ? moduleCpu.latest.totalUsed : null,
    moduleCpuTopPhases: moduleCpu && moduleCpu.latest ? moduleCpu.latest.topPhases : [],
    segmentTruncated,
    segmentSchemaVersion,
    hasSegment: !!segment,
    segmentTick:
      segment && segment.snapshot && segment.snapshot.parsed && typeof segment.snapshot.parsed.tick === "number"
        ? segment.snapshot.parsed.tick
        : null,
    errorCount: state.errors.length,
    lastError: state.errors.length > 0 ? state.errors[state.errors.length - 1] : null,
  };
}

function writeJson(res, statusCode, body) {
  const serialized = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(serialized);
}

function createHttpServer(state) {
  return createServer((req, res) => {
    if (!req.url) {
      writeJson(res, 400, { ok: false, error: "missing url" });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    if (url.pathname === "/health") {
      writeJson(res, 200, { ok: true, summary: summarizeState(state) });
      return;
    }
    if (url.pathname === "/state") {
      writeJson(res, 200, state);
      return;
    }
    if (url.pathname === "/rooms") {
      writeJson(res, 200, {
        rooms: state.latest.memory ? state.latest.memory.summary.rooms : [],
      });
      return;
    }
    if (url.pathname === "/history") {
      writeJson(res, 200, {
        history: state.history,
      });
      return;
    }
    if (url.pathname === "/cpu") {
      const segmentParsed =
        state.latest.segment &&
        state.latest.segment.snapshot &&
        state.latest.segment.snapshot.parsed &&
        typeof state.latest.segment.snapshot.parsed === "object"
          ? state.latest.segment.snapshot.parsed
          : null;
      const segmentCpuMonitor = segmentParsed && segmentParsed.cpuMonitor
        ? summarizeCpuMonitor(segmentParsed.cpuMonitor, segmentParsed.moduleCpu)
        : (segmentParsed && segmentParsed.moduleCpu
          ? summarizeCpuMonitor(null, segmentParsed.moduleCpu)
          : null);
      const segmentHistory = segmentParsed && segmentParsed.cpuMonitor && Array.isArray(segmentParsed.cpuMonitor.history)
        ? segmentParsed.cpuMonitor.history
        : [];
      writeJson(res, 200, {
        memoryCpuMonitor: state.latest.memory ? state.latest.memory.cpuMonitor : null,
        segmentCpuMonitor,
        segmentCpuMonitorHistory: segmentHistory,
        memoryModuleCpu: state.latest.memory ? state.latest.memory.moduleCpu : null,
        segmentModuleCpu: segmentParsed && segmentParsed.moduleCpu ? segmentParsed.moduleCpu : null,
        segmentTick: segmentParsed && typeof segmentParsed.tick === "number" ? segmentParsed.tick : null,
        segmentTruncated: !!(segmentParsed && segmentParsed.truncated),
        segmentSchemaVersion: segmentParsed && typeof segmentParsed.version === "number" ? segmentParsed.version : null,
      });
      return;
    }
    if (url.pathname === "/hub") {
      const hub = state.latest.memory?.hub ?? null;
      writeJson(res, 200, { ok: true, hub, selectedShard: state.selectedShard ?? null });
      return;
    }
    if (url.pathname === "/resource-control") {
      const resourceControl = state.latest.memory?.resourceControl ?? null;
      writeJson(res, 200, { ok: true, resourceControl, selectedShard: state.selectedShard ?? null });
      return;
    }
    if (url.pathname === "/market-sale") {
      const marketSaleAutomation = state.latest.memory?.marketSaleAutomation ?? null;
      writeJson(res, 200, {
        ok: true,
        marketSaleAutomation,
        selectedShard: state.selectedShard ?? null,
      });
      return;
    }

    writeJson(res, 200, {
      summary: summarizeState(state),
      endpoints: [
        "/health",
        "/state",
        "/rooms",
        "/history",
        "/cpu",
        "/hub",
        "/resource-control",
        "/market-sale",
      ],
    });
  });
}

function logMemorySnapshot(snapshot) {
  const summary = snapshot.summary;
  const cpuMon = snapshot.cpuMonitor && snapshot.cpuMonitor.available ? snapshot.cpuMonitor : null;
  const cpuLatest = cpuMon && cpuMon.latest ? cpuMon.latest : null;
  const cpuSource = cpuMon ? cpuMon.source : "none";
  const cpuVersion = cpuMon ? cpuMon.version : "n/a";

  // Prefer v2 fields
  const topPhase = cpuLatest && cpuLatest.topPhases && cpuLatest.topPhases.length > 0
    ? `${cpuLatest.topPhases[0].phase}:${cpuLatest.topPhases[0].used.toFixed(2)}`
    : "n/a";
  const emaStr = cpuLatest && typeof cpuLatest.emaTotalUsed === "number"
    ? ` ema=${cpuLatest.emaTotalUsed.toFixed(2)}`
    : "";
  const fixedStr = cpuLatest && typeof cpuLatest.fixedActionEstimate === "number" && cpuLatest.fixedActionEstimate > 0
    ? ` fixedAct=${cpuLatest.fixedActionEstimate.toFixed(2)}`
    : "";
  const heapStr = cpuLatest && cpuLatest.heap
    ? ` heap=${(cpuLatest.heap.used_heap_size / 1048576).toFixed(1)}MB`
    : "";
  const cpuTick = cpuLatest ? cpuLatest.tick : "n/a";
  const cpuUsed = cpuLatest ? cpuLatest.totalUsed : "n/a";

  // Fallback to legacy moduleCpu when v2 absent
  if (!cpuMon && snapshot.moduleCpu && snapshot.moduleCpu.available && snapshot.moduleCpu.latest) {
    const legacy = snapshot.moduleCpu.latest;
    const legacyTop = legacy.topPhases && legacy.topPhases.length > 0
      ? `${legacy.topPhases[0].phase}:${legacy.topPhases[0].used.toFixed(2)}`
      : "n/a";
    console.log(
      boundedMonitorLogLine(
        `[monitor][memory] tick=${summary.latestTick ?? "n/a"} rooms=${summary.roomCount} workers=${summary.totals.workers} carriers=${summary.totals.carriers} loose=${summary.totals.looseEnergy} [legacy] moduleCpuTick=${legacy.tick ?? "n/a"} moduleCpuUsed=${legacy.totalUsed ?? "n/a"} topPhase=${legacyTop}${hubStr(snapshot.hub)}${resourceControlStr(snapshot.resourceControl)}${marketSaleStr(snapshot.marketSaleAutomation)} remaining=${snapshot.rateLimit.remaining ?? "?"}`,
      ),
    );
    return;
  }

  console.log(
    boundedMonitorLogLine(
      `[monitor][memory] tick=${summary.latestTick ?? "n/a"} rooms=${summary.roomCount} workers=${summary.totals.workers} carriers=${summary.totals.carriers} loose=${summary.totals.looseEnergy} [cpu-v${cpuVersion}|${cpuSource}] cpuTick=${cpuTick} cpuUsed=${cpuUsed}${emaStr}${fixedStr}${heapStr} topPhase=${topPhase}${hubStr(snapshot.hub)}${resourceControlStr(snapshot.resourceControl)}${marketSaleStr(snapshot.marketSaleAutomation)} remaining=${snapshot.rateLimit.remaining ?? "?"}`,
    ),
  );
}

function hubStr(hub) {
  if (!hub || !hub.available) return "";
  const attempt = hub.protectionAttempt;
  const committed = hub.committedProtectionMarker;
  return ` hub=${hub.hubRoomName} status=${hub.status ?? "n/a"} stage=${hub.stage ?? "n/a"} product=${hub.activeProduct ?? "n/a"} imports=${hub.pendingImports} exports=${hub.pendingExports} hubProtection=${attempt?.attemptRevision ?? "n/a"}/${committed?.planRevision ?? "n/a"}:${committed?.status ?? "n/a"}:consistent=${committed?.consistent ?? "n/a"}`;
}

function resourceControlStr(resourceControl) {
  if (!resourceControl || !resourceControl.available) return "";
  const readiness = Array.isArray(resourceControl.rooms)
    ? resourceControl.rooms
        .map((room) => room.marketEnergyReadiness)
        .filter((entry) => entry !== null)
    : [];
  const ready = readiness.filter(
    (entry) => entry.status === "ready",
  ).length;
  const feedPlanned = readiness.filter(
    (entry) => entry.status === "feed_planned",
  ).length;
  const blocked = readiness.filter(
    (entry) => entry.status === "blocked",
  ).length;
  return ` transferTasks=${resourceControl.pendingTaskCount} marketEnergyReadiness=${ready}/${feedPlanned}/${blocked}`;
}

function directMarketSaleStr(direct) {
  if (!direct || !direct.available) return "";
  if (direct.capability === "market-direct-continuous") {
    const permit = direct.permit;
    const tuple = direct.bestTuple;
    const globalQuota = direct.globalQuota;
    const entries = Array.isArray(direct.entries)
      ? direct.entries
          .map((entry) => {
            const resource =
              entry.resourceType ?? entry.entryId ?? "n/a";
            const stage = entry.lifecycle?.stage ?? "n/a";
            const shadow =
              entry.lifecycle?.shadowConsecutiveCycles ?? "n/a";
            const quota = entry.quota?.resource;
            const opportunity =
              entry.opportunity?.admission ?? "n/a";
            return `${resource}:${stage}:s${shadow}:q${quota?.used ?? "n/a"}/${quota?.limit ?? "n/a"}:o=${opportunity}`;
          })
          .join(",")
      : "n/a";
    const base = direct.baseResourceV3;
    const catalog = base?.catalog?.resources;
    const roster = base?.roster;
    const lifecycle = base?.lifecycle;
    const basePermit = base?.permit;
    const baseQuota = base?.quota;
    const readiness = base?.readinessAuthorization;
    const planning = base?.planning;
    return [
      ` directV2=${direct.schemaVersion ?? "n/a"}`,
      ` directPermit=${permit ? `${permit.epoch ?? "n/a"}:${permit.permitId ?? "n/a"}:${permit.permitHead ?? "n/a"}` : "none"}`,
      ` directEntries=${entries}`,
      ` directSelected=${tuple ? `${tuple.resourceType ?? "n/a"}@${tuple.sellerRoom ?? "n/a"}:${tuple.orderId ?? "n/a"}:net=${tuple.unitNetPrice ?? "n/a"}` : "none"}`,
      ` directGlobal=${globalQuota ? `${globalQuota.used ?? "n/a"}/${globalQuota.limit ?? "n/a"}:reserved=${globalQuota.reserved ?? "n/a"}` : "n/a"}`,
      ` directPending=${direct.ledger?.pending ? 1 : 0}`,
      ` directCoverage=${direct.coverage?.startTick ?? "n/a"}`,
      ` directHighWater=${direct.highWater ? `${direct.highWater.finalizedAttemptSeq ?? "n/a"}/${direct.highWater.nextAttemptSeq ?? "n/a"}:p${direct.highWater.permitEpoch ?? "n/a"}` : "n/a"}`,
      ` directBlocker=${direct.blocker?.code ?? "none"}`,
      ` baseCatalog=${catalog ? `${catalog.values.join("")}:${catalog.total}` : "n/a"}`,
      ` baseRoster=${roster ? `${roster.roomCount ?? "n/a"}/${roster.knownRoomNames?.total ?? "n/a"}` : "n/a"}`,
      ` baseLifecycle=${lifecycle ? `${lifecycle.total}:truncated=${lifecycle.truncated}` : "n/a"}`,
      ` basePermit=${basePermit ? `${basePermit.currentPermitEpoch ?? "n/a"}:${basePermit.currentPermitId ?? "n/a"}:retained=${basePermit.retainedPermitCount ?? "n/a"}` : "n/a"}`,
      ` baseQuota=${baseQuota ? `${baseQuota.global?.used ?? "n/a"}/${baseQuota.global?.limit ?? "n/a"}` : "n/a"}`,
      ` baseReadiness=${readiness ? `${readiness.roomCount ?? "n/a"}:${readiness.status ?? "n/a"}` : "n/a"}`,
      ` basePlanning=${planning ? `cpu=${planning.cpuUsed ?? "n/a"}:blocker=${planning.blocker ?? "none"}` : "n/a"}`,
    ].join("");
  }
  const snapshot = direct.snapshot;
  const book = snapshot?.buyBook;
  const opportunity = snapshot?.opportunity;
  const freshness =
    snapshot?.fresh === true
      ? "fresh"
      : snapshot?.fresh === false
        ? "stale"
        : "unknown";
  const components = snapshot?.energyShadowComponents;
  const energyShadow = snapshot
    ? `${snapshot.effectiveEnergyShadowPrice ?? "n/a"}(hard=${components?.hardFloor ?? "n/a"},explicit=${components?.explicit ?? "n/a"},history=${components?.historyFloor ?? "n/a"},ratchet=${components?.ratchetFloor ?? "n/a"})`
    : "n/a";
  return [
    ` directShadow=${direct.shadowConsecutiveCycles ?? "n/a"}`,
    ` directPending=${direct.pendingCount ?? "n/a"}`,
    ` directConfirmed=${direct.confirmedDealCount ?? "n/a"}`,
    ` directPaused=${direct.pausedForReview ?? "n/a"}`,
    ` directSnapshot=${snapshot ? `${freshness}:${snapshot.age ?? "n/a"}/${snapshot.maxAgeTicks ?? "n/a"}` : "n/a"}`,
    ` directBuy=${book ? `${book.rawOrderCount ?? "n/a"}/${book.rawOrderLimit ?? "n/a"}:${book.eligibleOrderCount ?? "n/a"}/${book.eligibleOrderLimit ?? "n/a"}:${book.safeCandidateCount ?? "n/a"}:depth=${book.eligibleDepth ?? "n/a"}:rooms=${book.eligibleDistinctRoomCount ?? "n/a"}` : "n/a"}`,
    ` directSelected=${opportunity ? `${opportunity.orderId ?? "n/a"}:${opportunity.price ?? "n/a"}x${opportunity.dealAmount ?? "n/a"}` : "none"}`,
    ` directManual=${snapshot ? `${snapshot.manualBuyOrderCount ?? "n/a"}/${snapshot.manualSellOrderCount ?? "n/a"}` : "n/a"}`,
    ` directEnergyShadow=${energyShadow}`,
    ` directExposure=${direct.exposure ? `${direct.exposure.resourceAmount ?? "n/a"}/${direct.exposure.transactionEnergy ?? "n/a"}` : "n/a"}`,
  ].join("");
}

function marketSaleStr(marketSaleAutomation) {
  if (!marketSaleAutomation || !marketSaleAutomation.available) return "";
  return ` marketSale=${marketSaleAutomation.phase ?? "n/a"} shadow=${marketSaleAutomation.shadowConsecutiveCycles ?? "n/a"} orders=${marketSaleAutomation.managedOrderCount ?? "n/a"}${directMarketSaleStr(marketSaleAutomation.direct)}`;
}

function logSegmentSnapshot(snapshot) {
  const parsed = snapshot.snapshot.parsed;
  const tick = parsed && typeof parsed === "object" && typeof parsed.tick === "number" ? parsed.tick : "n/a";
  const version = parsed && typeof parsed === "object" && typeof parsed.version === "number" ? parsed.version : "n/a";
  const truncated = !!(parsed && typeof parsed === "object" && parsed.truncated);

  // Prefer v2 cpuMonitor from segment
  const cpuMon = parsed && typeof parsed === "object" && parsed.cpuMonitor
    ? summarizeCpuMonitor(parsed.cpuMonitor, parsed.moduleCpu)
    : (parsed && typeof parsed === "object" && parsed.moduleCpu
      ? summarizeCpuMonitor(null, parsed.moduleCpu)
      : null);
  const cpuSource = cpuMon ? cpuMon.source : "none";
  const phaseCount = cpuMon && cpuMon.latest && cpuMon.latest.phases ? Object.keys(cpuMon.latest.phases).length : 0;

  console.log(
    `[monitor][segment] id=${snapshot.snapshot.segmentId} tick=${tick} ver=${version} truncated=${truncated} cpuSource=${cpuSource} phaseCount=${phaseCount} size=${snapshot.snapshot.rawSize} remaining=${snapshot.rateLimit.remaining ?? "?"}`,
  );
}

async function fetchWithShardFallback(config) {
  const candidates = [undefined, ...config.shardCandidates];
  let bestResult = null;
  let bestShard = null;
  let bestShardValue;
  let bestHubTime = -1;
  let bestDeployTime = -1;
  let bestTick = -1;
  const shardResults = [];

  for (const shard of candidates) {
    try {
      const result = await fetchMemorySnapshot(
        { ...config, shard, memoryFixture: config.memoryFixture },
        { includeResourceControl: false },
      );
      const runtimeInfo = await fetchRuntimeInfo(config, shard);
      const hubTime = result.memory?.hub?.updatedAt ?? result.hub?.updatedAt ?? -1;
      const tick = result.memory?.summary?.latestTick ?? result.summary?.latestTick ?? -1;
      shardResults.push({
        shard: shard ?? "(default)",
        ok: true,
        hubTime,
        deployTime: runtimeInfo.deployTime,
        lastDeployTag: runtimeInfo.lastDeployTag,
        tick,
      });
      if (
        hubTime > bestHubTime ||
        (hubTime === bestHubTime && runtimeInfo.deployTime > bestDeployTime) ||
        (hubTime === bestHubTime && runtimeInfo.deployTime === bestDeployTime && tick > bestTick)
      ) {
        bestResult = result;
        bestShard = shard ?? "(default)";
        bestShardValue = shard;
        bestHubTime = hubTime;
        bestDeployTime = runtimeInfo.deployTime;
        bestTick = tick;
      }
    } catch (e) {
      shardResults.push({ shard: shard ?? "(default)", ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (bestResult) {
    const {
      runtimeResourceControl,
      runtimeHub,
      transferTaskStore,
      dataResourceControlLogistics,
      snapshotCoherence,
      runtimeMarketSaleAutomation,
      dataDirectAutomation,
    } = await fetchResourceControlData(config, bestShardValue);
    bestResult.resourceControl = summarizeResourceControl(
      runtimeResourceControl,
      transferTaskStore,
      dataResourceControlLogistics,
      bestTick >= 0 ? bestTick : null,
      snapshotCoherence,
      bestResult._resourceControlCpuPhaseEvidence,
    );
    bestResult.hub = {
      ...bestResult.hub,
      distributedSynthesis: summarizeDistributedSynthesis(
        runtimeHub?.distributedSynthesis,
      ),
    };
    bestResult.marketSaleAutomation = summarizeMarketSaleAutomation(
      runtimeMarketSaleAutomation,
      dataDirectAutomation,
    );
    bestResult.selectedShard = bestShard;
    bestResult.shardCandidates = shardResults;
  }
  return bestResult;
}

async function fetchSelectedMemorySnapshot(config) {
  return config.explicitShard || config.memoryFixture
    ? fetchMemorySnapshot(config)
    : fetchWithShardFallback(config);
}

async function runOnce(config) {
  const memory = await fetchSelectedMemorySnapshot(config);
  const segment = config.segmentId === null ? null : await fetchSegmentSnapshot(config, config.segmentId);
  const payload = {
    capturedAt: new Date().toISOString(),
    memory,
    segment,
  };
  await appendSnapshot(config.outputPath, payload);
  console.log(JSON.stringify(payload, null, 2));
}

async function runService(config) {
  const state = createState(config);
  let server = null;
  let memoryBusy = false;
  let segmentBusy = false;

  const pollMemory = async () => {
    if (memoryBusy) {
      return;
    }
    memoryBusy = true;
    try {
      const snapshot = await fetchSelectedMemorySnapshot(config);
      if (!snapshot) {
        throw new Error("No shard candidate returned a memory snapshot");
      }
      state.latest.memory = snapshot;
      state.selectedShard = snapshot.selectedShard ?? config.shard ?? null;
      pushHistory(
        state,
        {
          type: "memory",
          at: snapshot.fetchedAt,
          tick: snapshot.summary.latestTick,
          roomCount: snapshot.summary.roomCount,
        },
        config.historyLimit,
      );
      await appendSnapshot(config.outputPath, {
        capturedAt: snapshot.fetchedAt,
        memory: snapshot,
        segment: state.latest.segment,
      });
      logMemorySnapshot(snapshot);
    } catch (error) {
      // 错误消息统一脱敏后再入历史/控制台（Screeps 429 响应体含带 token 的链接）。
      const message = redactErrorMessage(error);
      pushError(state, `[memory] ${message}`, config.historyLimit);
      console.error(`[monitor][memory][error] ${message}`);
    } finally {
      memoryBusy = false;
    }
  };

  const pollSegment = async () => {
    if (config.segmentId === null || segmentBusy) {
      return;
    }
    segmentBusy = true;
    try {
      const snapshot = await fetchSegmentSnapshot(config, config.segmentId);
      state.latest.segment = snapshot;
      pushHistory(
        state,
        {
          type: "segment",
          at: snapshot.fetchedAt,
          tick:
            snapshot.snapshot.parsed &&
            typeof snapshot.snapshot.parsed === "object" &&
            typeof snapshot.snapshot.parsed.tick === "number"
              ? snapshot.snapshot.parsed.tick
              : null,
          size: snapshot.snapshot.rawSize,
        },
        config.historyLimit,
      );
      logSegmentSnapshot(snapshot);
    } catch (error) {
      const message = redactErrorMessage(error);
      pushError(state, `[segment] ${message}`, config.historyLimit);
      console.error(`[monitor][segment][error] ${message}`);
    } finally {
      segmentBusy = false;
    }
  };

  if (!config.noHttp) {
    server = createHttpServer(state);
    await new Promise((resolvePromise) => {
      server.listen(config.port, () => resolvePromise());
    });
    console.log(`[monitor] HTTP server listening on http://127.0.0.1:${config.port}`);
  }

  await pollMemory();
  if (config.segmentId !== null) {
    await pollSegment();
  }

  const memoryTimer = setInterval(() => {
    void pollMemory();
  }, config.memoryIntervalMs);

  const segmentTimer =
    config.segmentId === null
      ? null
      : setInterval(() => {
          void pollSegment();
        }, config.segmentIntervalMs);

  const shutdown = () => {
    clearInterval(memoryTimer);
    if (segmentTimer) {
      clearInterval(segmentTimer);
    }
    if (server) {
      server.close(() => process.exit(0));
      return;
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const config = await resolveConfig(args);
  console.log(
    `[monitor] base=${config.baseUrl} shard=${config.shard ?? "auto"} memoryInterval=${config.memoryIntervalMs}ms segment=${config.segmentId ?? "off"} output=${config.outputPath ?? "off"} memoryFixture=${config.memoryFixture ?? "off"} leanMemory=${config.leanMemory}`,
  );

  if (config.once) {
    await runOnce(config);
    return;
  }

  await runService(config);
}

main().catch((error) => {
  const message = redactErrorMessage(error);
  console.error(`[monitor][fatal] ${message}`);
  process.exit(1);
});
