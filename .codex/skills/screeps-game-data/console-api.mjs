#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const DEFAULT_SHARDS = ["shard0", "shard1", "shard2", "shard3"];
const PROBE_PATH = "__codexSkillProbe";

function printHelp() {
  console.log(`Screeps console API helper

Usage:
  node .codex/skills/screeps-game-data/console-api.mjs --expr <expression> --shard <shard>
  node .codex/skills/screeps-game-data/console-api.mjs --probe [--shards shard1,shard2]

Options:
  --expr <expression>       Console expression to enqueue
  --shard <name>            Target shard for --expr
  --probe                   Temporarily writes and removes Memory.${PROBE_PATH} to verify execution
  --shards <csv>            Shards to probe (default: shard0,shard1,shard2,shard3)
  --timeout-ms <ms>         Probe wait timeout (default: 60000)
  --help                    Show this help
`);
}

function parseArgs(argv) {
  const args = { probe: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      args.help = true;
      continue;
    }
    if (arg === "--probe") {
      args.probe = true;
      continue;
    }

    const [key, inlineValue] = arg.includes("=") ? arg.split("=", 2) : [arg, undefined];
    if (key !== "--expr" && key !== "--shard" && key !== "--shards" && key !== "--timeout-ms") {
      throw new Error(`Unknown argument: ${arg}`);
    }

    const value = inlineValue === undefined ? argv[index + 1] : inlineValue;
    if (value === undefined) {
      throw new Error(`Missing value for ${key}`);
    }
    if (inlineValue === undefined) {
      index += 1;
    }

    if (key === "--expr") args.expr = value;
    if (key === "--shard") args.shard = value;
    if (key === "--shards") args.shards = value;
    if (key === "--timeout-ms") args.timeoutMs = value;
  }
  return args;
}

async function readSecretConfig() {
  const raw = await readFile(resolve(process.cwd(), ".secret.json"), "utf8");
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === "object" ? parsed : {};
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url.toString();
}

function buildConfig(secret) {
  const secretMain = secret.main && typeof secret.main === "object" ? secret.main : {};
  const token = process.env.SCREEPS_TOKEN || secretMain.token;
  if (!token) {
    throw new Error("Missing Screeps token. Use SCREEPS_TOKEN or .secret.json main.token.");
  }

  const protocol = typeof secretMain.protocol === "string" ? secretMain.protocol : "https";
  const hostname = typeof secretMain.hostname === "string" ? secretMain.hostname : "screeps.com";
  const port = typeof secretMain.port === "number" ? `:${secretMain.port}` : "";
  const path = typeof secretMain.path === "string" ? secretMain.path : "/";
  return {
    token,
    baseUrl: normalizeBaseUrl(`${protocol}://${hostname}${port}${path}`),
  };
}

async function apiJson(config, route, options = {}) {
  const response = await fetch(new URL(route, config.baseUrl), {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Token": config.token,
      ...options.headers,
    },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${route} returned ${response.status}: ${text.slice(0, 160)}`);
  }
  return { body, response };
}

async function postConsole(config, shard, expression) {
  const { body, response } = await apiJson(config, "/api/user/console", {
    method: "POST",
    body: JSON.stringify({ expression, shard }),
  });
  if (body.ok !== 1) {
    throw new Error(`Console command was not accepted: ${JSON.stringify(body)}`);
  }
  return {
    ok: body.ok,
    insertedCount: body.insertedCount,
    shard,
    operationId: Array.isArray(body.insertedIds) ? body.insertedIds[0] : undefined,
    rateLimit: {
      limit: response.headers.get("x-ratelimit-limit"),
      remaining: response.headers.get("x-ratelimit-remaining"),
      reset: response.headers.get("x-ratelimit-reset"),
    },
  };
}

function decodeMemoryValue(body) {
  let data = body.data;
  if (typeof data === "string" && data.startsWith("gz:")) {
    data = gunzipSync(Buffer.from(data.slice(3), "base64")).toString("utf8");
  }
  if (data === undefined || data === "undefined") {
    return undefined;
  }
  return JSON.parse(data);
}

async function readMemoryPath(config, shard, path) {
  const url = new URL("/api/user/memory", config.baseUrl);
  url.searchParams.set("path", path);
  url.searchParams.set("shard", shard);
  const response = await fetch(url, {
    headers: {
      "X-Token": config.token,
    },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Memory read returned ${response.status}: ${JSON.stringify(body).slice(0, 160)}`);
  }
  return decodeMemoryValue(body);
}

async function waitForProbe(config, shards, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const shard of shards) {
      const value = await readMemoryPath(config, shard, PROBE_PATH);
      if (value && value.marker === marker) {
        return {
          requestShard: shard,
          tick: value.tick,
          shard: value.shard,
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return null;
}

async function runProbe(config, shards, timeoutMs) {
  const marker = `skillProbe${Date.now()}`;
  const setExpression = `Memory.${PROBE_PATH}={marker:${JSON.stringify(marker)},tick:Game.time,shard:Game.shard.name}; "ok"`;
  const deleteExpression = `delete Memory.${PROBE_PATH}; "deleted"`;

  for (const shard of shards) {
    await postConsole(config, shard, setExpression);
  }
  const observed = await waitForProbe(config, shards, marker, timeoutMs);
  for (const shard of shards) {
    await postConsole(config, shard, deleteExpression);
  }
  return observed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const config = buildConfig(await readSecretConfig());
  if (args.probe) {
    const shards = args.shards ? args.shards.split(",").map((shard) => shard.trim()).filter(Boolean) : DEFAULT_SHARDS;
    const timeoutMs = Number.parseInt(args.timeoutMs || "60000", 10);
    const observed = await runProbe(config, shards, timeoutMs);
    console.log(JSON.stringify({ consoleMemoryProbe: !!observed, observed }, null, 2));
    if (!observed) {
      process.exitCode = 1;
    }
    return;
  }

  if (!args.expr || !args.shard) {
    throw new Error("Use --expr with --shard, or use --probe.");
  }

  const result = await postConsole(config, args.shard, args.expr);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
