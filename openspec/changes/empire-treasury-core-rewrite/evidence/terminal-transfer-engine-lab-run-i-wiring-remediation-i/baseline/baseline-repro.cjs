/**
 * Terminal Transfer Engine Lab Run I · Wiring Remediation I——§3 基线复现。
 *
 * 用起点（457b052）归档的旧 main 产物 + 真实归档 observer/single-shot，
 * 在 Node VM 中按 Screeps 模块系统装配，经 main 沙箱 require 边界注入
 * observer 装配故障，复现两个确定反例：observer 模块错误后 single-shot
 * 仍被解析/调用并发生一次 send。不编辑任何旧 JS。
 *
 * 场景矩阵（其余条件全部合法：目标 tick、正确合成身份、充足资源/费用/
 * 容量、合法武装小控制记录）：
 * - observer-require-throw：require("observer") 抛错
 * - observer-empty-exports：require("observer") 返回 {}
 * - observer-bad-loop-export：require("observer") 返回 { loop: 1 }
 * - observer-null-exports：require("observer") 返回 null（同组补充）
 * - observer-loop-throw：真实 observer 装配成功，loop() 向外抛错
 * - normal：真实三模块（正向对照，send=1）
 */
"use strict";
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { runInNewContext } = require("node:vm");
const path = require("node:path");

const REPO_ROOT = "D:/code/screeps/screeps-bot";
const MAINVAL = path.join(
  REPO_ROOT,
  "openspec", "changes", "empire-treasury-core-rewrite", "evidence",
  "terminal-transfer-engine-lab-run-i", "offline", "mainval",
);

// ── §3.2 固定旧产物身份核对 ────────────────────────────────────────────────
const IDENTITY = {
  main: { file: path.join(MAINVAL, "lab-run-i-main", "main.js"), bytes: 7430, sha256: "44f624ccaa4a98da7b3441794fe2cd4b4b0c45b52f709c0039fd1ccc47a4d9c0" },
  observer: { file: path.join(MAINVAL, "lab-observer", "observer.js"), bytes: 9160, sha256: "96721926941004522d0f77ce76e3648d57aec04bcaa5f07d58493903ce8f48a4" },
  singleShot: { file: path.join(MAINVAL, "lab-single-shot", "single-shot.js"), bytes: 27697, sha256: "7730421dd7ef5d453387f03e5ad0eedec5b0b3c9d990bdeda805dd1213811391" },
};
for (const [name, id] of Object.entries(IDENTITY)) {
  const buf = readFileSync(id.file);
  const sha = createHash("sha256").update(buf).digest("hex");
  if (buf.length !== id.bytes || sha !== id.sha256) {
    throw new Error(`身份核对失败 ${name}: ${buf.length}B/${sha}`);
  }
  console.log(`identity-ok ${name} bytes=${buf.length} sha256=${sha}`);
}

const OLD_MAIN_CODE = readFileSync(IDENTITY.main.file, "utf8");
const OBSERVER_CODE = readFileSync(IDENTITY.observer.file, "utf8");
const SINGLE_SHOT_CODE = readFileSync(IDENTITY.singleShot.file, "utf8");

// ── 合成世界（与 runI.test.ts harness 同构；自包含，不导入仓库 TS）─────────
const CONFIG = {
  experimentId: "lab-prep1-example-0001",
  shardName: "lab-synthetic-shard",
  username: "lab-synthetic-user",
  sourceRoomName: "W1N57",
  targetRoomName: "W10N57",
  sourceTerminalId: "lab-term-source-synthetic",
  targetTerminalId: "lab-term-target-synthetic",
  resourceType: "H",
  amount: 100,
  description: "lab-prep1 single-shot terminal transfer experiment",
  targetTick: 12345,
};
const CONTROL_MEMORY_KEY = "__labTerminalTransferProbe";

/**
 * 装配一个基线世界并跑一次 main.loop（tick=targetTick）。
 * observerFault 决定 main 沙箱 require("observer") 边界的注入：
 *   require-throw / empty-exports / bad-loop-export / null-exports /
 *   loop-throw（装配成功但调用即向外抛错）/ 无（真实转发）。
 */
function runScenario(scenario) {
  const sendCalls = [];
  const makeStore = (resources, freeCapacity) => ({
    ...resources,
    getFreeCapacity: () => freeCapacity,
    getUsedCapacity: () => 0,
    getCapacity: () => freeCapacity,
  });
  const sourceTerminal = {
    id: CONFIG.sourceTerminalId,
    owner: { username: CONFIG.username },
    store: makeStore({ H: 1000, energy: 10000 }, 50000),
    cooldown: 0,
    send(resourceType, amount, destination, description) {
      sendCalls.push([resourceType, amount, destination, description]);
      return 0;
    },
  };
  const targetTerminal = {
    id: CONFIG.targetTerminalId,
    owner: { username: CONFIG.username },
    store: makeStore({ energy: 2000 }, 100000),
    cooldown: 0,
  };
  const game = {
    time: CONFIG.targetTick,
    shard: { name: CONFIG.shardName, type: "normal", ptr: false },
    rooms: {
      [CONFIG.sourceRoomName]: { name: CONFIG.sourceRoomName, terminal: sourceTerminal },
      [CONFIG.targetRoomName]: { name: CONFIG.targetRoomName, terminal: targetTerminal },
    },
    market: { calcTransactionCost: () => 26, incomingTransactions: [], outgoingTransactions: [] },
  };
  const memory = {};
  const initialControl = { experimentId: CONFIG.experimentId, armed: true, attempted: false };
  memory[CONTROL_MEMORY_KEY] = { ...initialControl };
  const initialControlRef = memory[CONTROL_MEMORY_KEY];
  const logLines = [];
  const vmConsole = { log: (...args) => logLines.push(args.map(String).join(" ")) };

  // 叶子模块各自装载（自包含 CJS；observer 零 Memory 引用，single-shot 需要）。
  const loadLeaf = (code, filename) => {
    const moduleExports = {};
    runInNewContext(
      code,
      { exports: moduleExports, module: { exports: moduleExports }, console: vmConsole, Game: game, Memory: memory },
      { filename },
    );
    return moduleExports;
  };
  const observerExports = loadLeaf(OBSERVER_CODE, "baseline-observer.js");
  const singleShotExports = loadLeaf(SINGLE_SHOT_CODE, "baseline-single-shot.js");
  if (typeof observerExports.loop !== "function") throw new Error("observer 产物未导出 loop");
  if (typeof singleShotExports.loop !== "function") throw new Error("single-shot 产物未导出 loop");

  let observerCalls = 0;
  let singleShotCalls = 0;
  const requireNames = [];
  const requireStub = (name) => {
    requireNames.push(name);
    if (name === "observer") {
      if (scenario === "observer-require-throw") throw new Error("baseline 注入：observer require 抛错");
      if (scenario === "observer-empty-exports") return {};
      if (scenario === "observer-bad-loop-export") return { loop: 1 };
      if (scenario === "observer-null-exports") return null;
      return { loop: () => { observerCalls += 1; observerExports.loop(); } };
    }
    if (name === "single-shot") {
      return { loop: () => { singleShotCalls += 1; singleShotExports.loop(); } };
    }
    throw new Error(`require: unknown module '${name}'`);
  };
  // observer-loop-throw：装配成功（真实 require 边界不注入），调用时先计数再抛。
  if (scenario === "observer-loop-throw") {
    // 用包装 require 替换：直接在 requireStub 分支处理不可行，改注入调用层。
  }

  const mainExports = {};
  runInNewContext(
    OLD_MAIN_CODE,
    { exports: mainExports, module: { exports: mainExports }, console: vmConsole, Game: game, require: requireStub },
    { filename: "baseline-old-main.js" },
  );
  if (typeof mainExports.loop !== "function") throw new Error("旧 main 未导出 loop");

  if (scenario === "observer-loop-throw") {
    // 调用层注入：包装 main loop 不可取（要观察的是 main 对 observer 抛错的反应）；
    // 正确注入点在 require 返回值——重新装配一个专用 require。
    // 为保持单一装配路径，这里改为：重新装载一个 main 沙箱，其 require("observer")
    // 返回先计数再抛错的包装。
    const mainExports2 = {};
    const requireNames2 = [];
    const requireStub2 = (name) => {
      requireNames2.push(name);
      if (name === "observer") {
        return { loop: () => { observerCalls += 1; throw new Error("baseline 注入：observer.loop 向外抛错"); } };
      }
      if (name === "single-shot") {
        return { loop: () => { singleShotCalls += 1; singleShotExports.loop(); } };
      }
      throw new Error(`require: unknown module '${name}'`);
    };
    runInNewContext(
      OLD_MAIN_CODE,
      { exports: mainExports2, module: { exports: mainExports2 }, console: vmConsole, Game: game, require: requireStub2 },
      { filename: "baseline-old-main-loop-throw.js" },
    );
    mainExports2.loop();
    requireNames.length = 0;
    requireNames.push(...requireNames2);
  } else {
    mainExports.loop();
  }

  const slot = memory[CONTROL_MEMORY_KEY];
  return {
    scenario,
    sendCount: sendCalls.length,
    sendArgs: sendCalls,
    observerCalls,
    singleShotCalls,
    requireNames,
    slotAfter: slot,
    slotRefUnchanged: slot === initialControlRef,
    slotDeepEqualInitial: JSON.stringify(slot) === JSON.stringify(initialControl),
    moduleErrors: logLines
      .filter((line) => line.startsWith("{") && line.includes('"kind":"lab-run-i-module-error"'))
      .map((line) => JSON.parse(line)),
    sendBoundaryLines: logLines.filter((line) => line.includes('"lab-send-attempt"')).length,
    mainErrorLines: logLines.filter((line) => line.includes('"lab-run-i-main-error"')).length,
    sampleLines: logLines.filter((line) => line.includes('"lab-sample"')).length,
  };
}

const scenarios = [
  "observer-require-throw",
  "observer-empty-exports",
  "observer-bad-loop-export",
  "observer-null-exports",
  "observer-loop-throw",
  "normal",
];
const results = scenarios.map(runScenario);
const summary = {};
for (const r of results) {
  summary[r.scenario] = {
    sendCount: r.sendCount,
    observerCalls: r.observerCalls,
    singleShotCalls: r.singleShotCalls,
    requireNames: r.requireNames,
    moduleErrorStages: r.moduleErrors.map((e) => `${e.module}:${e.stage}`),
    slotRefUnchanged: r.slotRefUnchanged,
    slotDeepEqualInitial: r.slotDeepEqualInitial,
  };
}
console.log(JSON.stringify({ summary }, null, 2));
const outFile = path.join(__dirname, "baseline-results.json");
require("node:fs").writeFileSync(outFile, JSON.stringify({ results }, null, 2));
console.log(`baseline-results.json 写入 ${outFile}`);
console.log("BASELINE_REPRO_DONE");
