/**
 * Remediation I 修复冒烟：对**新构建**的 single-shot 产物跑与基线复现完全相同的
 * 7 场景矩阵，验证三失败场景修复为 0/0/0、对照组保持 1/1/1 或 0/0/0。
 * 用法：node smoke-fixed.cjs <single-shot.js 绝对路径>
 */
"use strict";

const path = require("node:path");
const vm = require("node:vm");
const fs = require("node:fs");

const BUNDLE = path.resolve(process.argv[2] ?? "");
const REPO_ROOT = "D:/code/screeps/screeps-bot";

const CONFIG = {
  experimentId: "lab-prep1-example-0001",
  shardName: "lab-synthetic-shard",
  username: "lab-synthetic-user",
  sourceRoomName: "W1N57",
  targetRoomName: "W10N57",
  sourceTerminalId: "lab-term-source-synthetic",
  targetTerminalId: "lab-term-target-synthetic",
  targetTick: 12345,
};
const CONTROL_KEY = "__labTerminalTransferProbe";

function armedControl() {
  return { experimentId: CONFIG.experimentId, armed: true, attempted: false };
}

function oversizedInitialRecord() {
  const bare = JSON.stringify(armedControl()).length;
  const record = { ...armedControl(), note: "x".repeat(4090 - bare - 10) };
  const actual = JSON.stringify(record).length;
  if (actual !== 4090) throw new Error(`note 补齐偏差：实际 ${actual}`);
  return record;
}

function installWorld(slotMode, sendBehavior) {
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
      sendCalls.push({ args: [resourceType, amount, destination, description], self: this });
      if (sendBehavior === "throw") throw new Error("send stub 同步异常（冒烟）");
      return sendBehavior === "non-ok" ? -6 : 0;
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
  let stored;
  if (slotMode === "setterThrow" || slotMode === "silentDrop") {
    stored = armedControl();
    Object.defineProperty(memory, CONTROL_KEY, {
      configurable: true,
      get() {
        return stored;
      },
      set(value) {
        if (slotMode === "setterThrow") throw new Error("控制槽 setter 故障（冒烟 stub）");
      },
    });
  } else if (slotMode === "oversized") {
    memory[CONTROL_KEY] = oversizedInitialRecord();
  } else if (slotMode === "unarmed") {
    memory[CONTROL_KEY] = { ...armedControl(), armed: false };
  } else {
    memory[CONTROL_KEY] = armedControl();
  }
  return { game, memory, sendCalls };
}

function loadBundleInVm(game, memory, logSink) {
  const code = fs.readFileSync(BUNDLE, "utf8");
  const moduleExports = {};
  const sandbox = {
    exports: moduleExports,
    module: { exports: moduleExports },
    console: { log: (...args) => logSink.push(args.map(String).join(" ")) },
    Game: game,
    Memory: memory,
  };
  vm.runInNewContext(code, sandbox, { filename: BUNDLE });
  if (typeof moduleExports.loop !== "function") throw new Error("产物未导出 loop");
  return moduleExports;
}

function runScenario(scenario) {
  const world = installWorld(scenario.slotMode, scenario.sendBehavior);
  const logLines = [];
  const bundle = loadBundleInVm(world.game, world.memory, logLines);
  bundle.loop();
  const n1 = world.sendCalls.length;
  bundle.loop();
  const n2 = world.sendCalls.length;
  world.game.time = CONFIG.targetTick + 1;
  bundle.loop();
  const n3 = world.sendCalls.length;
  const initialLength = scenario.slotMode === "oversized" ? 4090 : JSON.stringify(armedControl()).length;
  const slotNow = (() => {
    const value = world.memory[CONTROL_KEY];
    return value === undefined
      ? "<absent>"
      : `attempted=${String(value.attempted)} stopped=${String(value.stopped)}`;
  })();
  const markUnconfirmed = logLines
    .filter((line) => line.includes("lab-mark-unconfirmed"))
    .map((line) => {
      const parsed = JSON.parse(line);
      return `${parsed.stage}/${parsed.reason}`;
    });
  const rejections = logLines
    .filter((line) => line.includes("lab-precondition-rejection"))
    .map((line) => JSON.parse(line).reason);
  const sendAttemptPhases = logLines
    .filter((line) => line.includes("lab-send-attempt"))
    .map((line) => JSON.parse(line).phase);
  return {
    scenario: scenario.label,
    initialCharacters: initialLength,
    send: `${n1}/${n2}/${n3}`,
    slotFinal: slotNow,
    markUnconfirmed,
    rejections,
    sendAttemptPhases,
  };
}

(function main() {
  const bytes = fs.readFileSync(BUNDLE);
  const { createHash } = require("node:crypto");
  console.log(`新产物：bytes=${bytes.length} sha256=${createHash("sha256").update(bytes).digest("hex")}`);
  const scenarios = [
    { label: "S1 未武装/Memory 正常", slotMode: "unarmed", sendBehavior: "ok" },
    { label: "S2 正常武装/小记录/写入正常", slotMode: "normal", sendBehavior: "ok" },
    { label: "S3 send 非 OK/写入正常", slotMode: "normal", sendBehavior: "non-ok" },
    { label: "S4 send 抛错/写入正常", slotMode: "normal", sendBehavior: "throw" },
    { label: "S5 控制槽 setter 抛错", slotMode: "setterThrow", sendBehavior: "ok" },
    { label: "S6 控制槽 setter 静默丢写", slotMode: "silentDrop", sendBehavior: "ok" },
    { label: "S7 初始 4090 字符/更新后超限", slotMode: "oversized", sendBehavior: "ok" },
  ];
  const rows = [];
  for (const scenario of scenarios) {
    rows.push(runScenario(scenario));
  }
  for (const row of rows) {
    console.log(
      `${row.scenario} | 初始 ${row.initialCharacters} 字符 | send ${row.send} | 槽终态 ${row.slotFinal} | mark-unconfirmed ${JSON.stringify(row.markUnconfirmed)} | 前置拒绝 ${JSON.stringify(row.rejections)} | send-attempt phases ${JSON.stringify(row.sendAttemptPhases)}`,
    );
  }
})();
