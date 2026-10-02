#!/usr/bin/env node
/** T1-EXIT-R1: 上传已冻结、已独立审查的默认 OFF 修复；未知响应不重试。 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const [mode, manifestPath, bundlePath] = process.argv.slice(2);
if (!(["--check", "--apply"].includes(mode) && manifestPath && bundlePath &&
      process.argv.length === 5)) {
  throw new Error("usage: deploy-frozen-t1.mjs --check|--apply manifest.json dist/main.js");
}
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const bundle = await readFile(bundlePath, "utf8");
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const digest = sha256(bundle);
if (manifest.schema !== "screeps-t1-exit-r1-release/v1" ||
    manifest.target !== "screeps.com/default/shard1" ||
    manifest.accountId !== "634fe406347a7b69b28aeccb" ||
    manifest.accountName !== "forster" ||
    manifest.expectedLiveSha256 !== "bdfde69f6b79f3b3bd1a3e51d184d58ec4d0c6f25b94ebdc18233c61248d55a2" ||
    git("merge-base", "--is-ancestor", manifest.sourceCommit, "HEAD") !== "" ||
    git("diff", "--name-only", manifest.sourceCommit, "HEAD", "--", ".", ":!docs") !== "" ||
    git("status", "--porcelain") !== "" ||
    git("remote", "get-url", "origin") !== "https://github.com/ceyirelehe47/screeps-bot.git" ||
    git("remote", "get-url", "--push", "--all", "origin") !== "https://github.com/ceyirelehe47/screeps-bot.git" ||
    manifest.mainSha256 !== digest || manifest.mainBytes !== Buffer.byteLength(bundle, "utf8") ||
    manifest.mainBytes >= 5_000_000 || manifest.mainBytes < 1_000_000 ||
    !bundle.includes("__DEPLOY_BUNDLE_HASH__")) {
  throw new Error("frozen source, target, byte, remote, or size check failed");
}

const secretPath = process.env.SCREEPS_SECRET_FILE || ".secret.json";
const secret = JSON.parse(await readFile(secretPath, "utf8"));
const config = secret.main;
const token = process.env.SCREEPS_TOKEN || config?.token;
if (!token || config?.hostname !== "screeps.com" || config?.branch !== "default") {
  throw new Error("target credential configuration mismatch");
}
const headers = { "X-Token": token, "X-Username": token };
async function request(path, init = {}) {
  const response = await fetch(new URL(path, "https://screeps.com"), {
    ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Screeps ${path.split("?")[0]} HTTP ${response.status}`);
  return response.json();
}
async function memory(path) {
  const url = new URL("/api/user/memory", "https://screeps.com");
  url.searchParams.set("shard", "shard1");
  url.searchParams.set("path", path);
  const body = await request(url);
  let value = body.data;
  if (typeof value === "string" && value.startsWith("gz:")) {
    value = gunzipSync(Buffer.from(value.slice(3), "base64")).toString("utf8");
  }
  return value === undefined || value === "undefined" ? undefined
    : typeof value === "string" ? JSON.parse(value) : value;
}
async function remoteCode() {
  const body = await request("/api/user/code?branch=default");
  if (body.ok !== 1 || body.branch !== "default" ||
      Object.keys(body.modules || {}).length !== 1 || typeof body.modules.main !== "string") {
    throw new Error("remote code response not an exact main-only module set");
  }
  return { bytes: Buffer.byteLength(body.modules.main, "utf8"), sha256: sha256(body.modules.main) };
}

const [me, live, deployTag, modeCfg, quota, control, mirror, core, tasks] = await Promise.all([
  request("/api/auth/me"), remoteCode(), memory("runtime.lastDeployTag"),
  memory("cfg.treasuryTerminalTransferSlice0"), memory("runtime.treasuryProductionT1Quota"),
  memory("runtime.treasuryT1FirstLiveControl"), memory("runtime.treasuryT1FirstLiveControlMirror"), memory("runtime.treasuryCore"), memory("data.resourceControl.tasks"),
]);
if (me._id !== manifest.accountId || me.username !== manifest.accountName ||
    live.sha256 !== manifest.expectedLiveSha256 ||
    deployTag !== manifest.expectedLiveDeployTag ||
    (modeCfg !== undefined && modeCfg?.mode !== "off") || quota !== undefined || control !== undefined || mirror !== undefined || core !== undefined ||
    !tasks || typeof tasks !== "object" || Array.isArray(tasks) ||
    Object.values(tasks).some((task) => !task || typeof task !== "object" || task.treasurySlice !== undefined)) {
  throw new Error("live account, code, mode, quota, or deployment identity changed");
}
console.log(JSON.stringify({ gate: "passed", mode, account: me.username,
  sourceCommit: manifest.sourceCommit, currentSha256: live.sha256,
  candidateSha256: digest, candidateBytes: manifest.mainBytes }));
if (mode === "--check") process.exit(0);

let postStatus = "unknown";
try {
  const body = await request("/api/user/code", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branch: "default", modules: { main: bundle } }),
  });
  postStatus = body.ok === 1 ? "accepted" : "unconfirmed";
} catch (error) {
  postStatus = `unconfirmed:${String(error?.message || error).slice(0, 80)}`;
}
// A failed/unknown response may already have applied. Never retry this POST.
const readback = await remoteCode();
console.log(JSON.stringify({ postStatus, readback, applied: readback.sha256 === digest }));
if (readback.sha256 !== digest) process.exitCode = 1;
