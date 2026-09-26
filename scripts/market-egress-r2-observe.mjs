#!/usr/bin/env node

/**
 * R2 trial control observer. Run only after a verified shard1 start. It sends
 * heartbeats, never a market deal, permit change, or trial start. On failure it
 * sends at most one stop and lets the game's 60-second control lease expire.
 */
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const RUN_ID = "market-base-egress-r2-2026-09-26";
const SHARD = "shard1";
const BASE = "https://screeps.com";
const INTERVAL_MS = 20_000;
const READBACK_MS = 15_000;

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--output") {
  throw new Error("Usage: node scripts/market-egress-r2-observe.mjs --output /absolute/path.jsonl");
}
const output = resolve(args[1]);
const secret = JSON.parse(await readFile(resolve(process.cwd(), ".secret.json"), "utf8"));
const token = process.env.SCREEPS_TOKEN || secret.main?.token;
if (typeof token !== "string" || !token) throw new Error("Screeps token missing");
const headers = { "X-Token": token, "X-Username": token };
let stopRequested = false;
process.once("SIGINT", () => { stopRequested = true; });
process.once("SIGTERM", () => { stopRequested = true; });

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function log(record) {
  const entry = JSON.stringify({ atUtc: new Date().toISOString(), ...record });
  await appendFile(output, `${entry}\n`, { mode: 0o600 });
  process.stdout.write(`${entry}\n`);
}

async function api(route, init = {}) {
  const response = await fetch(new URL(route, BASE), {
    ...init,
    headers: { ...headers, ...init.headers },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json();
  if (!response.ok || body.error) {
    throw new Error(`${route} HTTP ${response.status}: ${String(body.error || "API error").slice(0, 80)}`);
  }
  return body;
}

async function readPath(path) {
  const url = new URL("/api/user/memory", BASE);
  url.searchParams.set("shard", SHARD);
  url.searchParams.set("path", path);
  const body = await api(url);
  let data = body.data;
  if (typeof data === "string" && data.startsWith("gz:")) {
    data = gunzipSync(Buffer.from(data.slice(3), "base64")).toString("utf8");
  }
  return data === undefined || data === "undefined" ? undefined : JSON.parse(data);
}

async function trial() {
  const runtime = await readPath("runtime");
  const primary = runtime?.marketBaseResourceEgressTrialR2;
  const mirror = runtime?.marketBaseResourceEgressTrialR2Mirror;
  if (!primary || !mirror || primary.runId !== RUN_ID ||
      primary.hash !== mirror.hash || JSON.stringify(primary) !== JSON.stringify(mirror)) {
    throw new Error("trial primary/mirror missing or inconsistent");
  }
  return primary;
}

async function post(expression) {
  const body = await api("/api/user/console", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shard: SHARD, expression }),
  });
  if (body.ok !== 1) throw new Error("console expression not accepted");
  return body.insertedIds?.[0] || null;
}

let state;
try {
  state = await trial();
  if (state.status !== "active" || Date.now() >= state.controlUntilMs ||
      Date.now() >= state.endMs || state.callsReserved >= 10 ||
      state.amountReserved >= 10_000) {
    throw new Error("trial is not currently controllable");
  }
  await log({ event: "observed", runId: RUN_ID, status: state.status,
    startedAtTick: state.startedAtTick, endTick: state.endTick,
    endMs: state.endMs, callsReserved: state.callsReserved,
    amountReserved: state.amountReserved, controlUntilMs: state.controlUntilMs });
  while (!stopRequested && Date.now() < state.endMs) {
    const cycleStarted = Date.now();
    const priorControl = state.controlUntilMs;
    const operationId = await post("heartbeatMarketBaseResourceEgressTrialR2();");
    const readbackDeadline = Date.now() + READBACK_MS;
    let confirmed = false;
    while (Date.now() < readbackDeadline) {
      await sleep(3_000);
      state = await trial();
      if (state.status === "closed") {
        await log({ event: "closed", operationId, closeReason: state.closeReason,
          callsReserved: state.callsReserved, amountReserved: state.amountReserved });
        confirmed = true;
        break;
      }
      if (state.controlUntilMs > priorControl) {
        confirmed = true;
        break;
      }
    }
    if (!confirmed) throw new Error("heartbeat outcome not observed; no retry");
    if (state.status === "closed") break;
    if (state.callsReserved > 10 || state.amountReserved > 10_000 ||
        Date.now() >= state.controlUntilMs) {
      throw new Error("trial bound or control lease violated");
    }
    await log({ event: "heartbeat", operationId,
      callsReserved: state.callsReserved, amountReserved: state.amountReserved,
      lastAttemptSeq: state.lastAttemptSeq,
      controlUntilMs: state.controlUntilMs });
    await sleep(Math.max(0, INTERVAL_MS - (Date.now() - cycleStarted)));
  }
  if (state?.status === "active") {
    const operationId = await post("stopMarketBaseResourceEgressTrialR2('observer_done');");
    await log({ event: "stop_enqueued", operationId,
      reason: stopRequested ? "signal" : "wall_deadline" });
  }
} catch (error) {
  await log({ event: "observer_error", message: String(error?.message || error) });
  if (state?.status === "active") {
    try {
      const operationId = await post("stopMarketBaseResourceEgressTrialR2('observer_error');");
      await log({ event: "stop_enqueued", operationId, reason: "observer_error" });
    } catch (stopError) {
      await log({ event: "stop_unconfirmed", message: String(stopError?.message || stopError) });
    }
  }
  process.exitCode = 1;
}
