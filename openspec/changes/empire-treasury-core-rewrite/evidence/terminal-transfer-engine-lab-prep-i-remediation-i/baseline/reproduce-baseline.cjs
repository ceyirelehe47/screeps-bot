/**
 * Terminal Transfer Engine Lab Prep I · Remediation I——Q01 基线复现脚本。
 *
 * 在固定旧产物（上一轮归档的 single-shot.js）上以 Node 假端口复现
 * 任务书 §3.2 的 7 场景矩阵：目标 tick 调两次 loop()，再推进一个 tick 调用，
 * 记录三时点累计 send spy 数。只证明旧行为（基线），不作为修复验收标准。
 *
 * 旧产物固定身份（任务书 §3.1）：
 *   - 17,520 字节；Git blob 6ce38daaaabff1febab3e710ac948f4e7cdaa7db；
 *   - SHA-256 9d8bfc54d542b9b5e8e37113b87e0f06e29149b7fa3cac1b9a7b8dfc7794ed4f。
 */
"use strict";

const { createHash } = require("node:crypto");
const path = require("node:path");

const REPO_ROOT = "D:/code/screeps/screeps-bot";
const OLD_BUNDLE = path.join(
  REPO_ROOT,
  "openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-engine-lab-prep-i/final/lab-single-shot/single-shot.js",
);
const EXPECTED_SHA256 = "9d8bfc54d542b9b5e8e37113b87e0f06e29149b7fa3cac1b9a7b8dfc7794ed4f";
const EXPECTED_BYTES = 17520;

const CONFIG = {
  experimentId: "lab-prep1-example-0001",
  mode: "single-shot",
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
  maxFeeEnergy: 1000,
  maxSamples: 32,
};
const CONTROL_KEY = "__labTerminalTransferProbe";

function armedControl() {
  return { experimentId: CONFIG.experimentId, armed: true, attempted: false };
}

/** 构造 4090 字符初始记录：合法必要字段 + 程序补齐的 ASCII note。 */
function oversizedInitialRecord() {
  const base = armedControl();
  const bare = JSON.stringify(base).length;
  // JSON 增量：`,"note":"xxxx"` → 10 + note 长度（逗号+键名+冒号+两引号）。目标总长 4090。
  const noteLength = 4090 - bare - 10;
  if (noteLength <= 0) throw new Error("基础记录已超 4090，无法构造");
  const record = { ...base, note: "x".repeat(noteLength) };
  const actual = JSON.stringify(record).length;
  if (actual !== 4090) throw new Error(`note 补齐偏差：实际 ${actual}`);
  return record;
}

/**
 * 安装假世界。slotMode：
 *   normal    普通可写属性；
 *   setterThrow  setter 抛错、getter 正常返回初始记录；
 *   silentDrop   setter 静默丢写（getter 始终返回初始记录）；
 *   oversized    普通可写对象、初始记录 JSON 长度 4090（含 ASCII note）。
 */
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
      if (sendBehavior === "throw") throw new Error("send stub 同步异常（基线复现）");
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
    market: {
      calcTransactionCost: () => 26,
      incomingTransactions: [],
      outgoingTransactions: [],
    },
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
        if (slotMode === "setterThrow") throw new Error("控制槽 setter 故障（基线 stub）");
        // silentDrop：静默丢弃——stored 不更新。
      },
    });
  } else if (slotMode === "oversized") {
    memory[CONTROL_KEY] = oversizedInitialRecord();
  } else if (slotMode === "unarmed") {
    memory[CONTROL_KEY] = { ...armedControl(), armed: false };
  } else {
    memory[CONTROL_KEY] = armedControl();
  }
  const globalScope = globalThis;
  const previousGame = globalScope.Game;
  const previousMemory = globalScope.Memory;
  globalScope.Game = game;
  globalScope.Memory = memory;
  return {
    game,
    memory,
    get stored() {
      return stored;
    },
    sendCalls,
    restore() {
      globalScope.Game = previousGame;
      globalScope.Memory = previousMemory;
    },
  };
}

/** 每场景在全新 VM 沙箱内按 CommonJS 执行旧产物（仓库 package.json 为 ESM，直接 require 会被误判）。 */
function loadOldBundleInVm(game, memory, logSink) {
  const vm = require("node:vm");
  const fs = require("node:fs");
  const code = fs.readFileSync(OLD_BUNDLE, "utf8");
  const moduleExports = {};
  const sandbox = {
    exports: moduleExports,
    module: { exports: moduleExports },
    console: { log: (...args) => logSink.push(args.map(String).join(" ")) },
    Game: game,
    Memory: memory,
  };
  vm.runInNewContext(code, sandbox, { filename: OLD_BUNDLE });
  if (typeof moduleExports.loop !== "function") throw new Error("旧产物未导出 loop");
  return moduleExports;
}

function runScenario(scenario) {
  const world = installWorld(scenario.slotMode, scenario.sendBehavior);
  const logLines = [];
  let n1;
  let n2;
  let n3;
  try {
    const bundle = loadOldBundleInVm(world.game, world.memory, logLines);
    bundle.loop();
    n1 = world.sendCalls.length;
    bundle.loop();
    n2 = world.sendCalls.length;
    world.game.time = CONFIG.targetTick + 1;
    bundle.loop();
    n3 = world.sendCalls.length;
  } finally {
    world.restore();
  }
  const initialLength = scenario.slotMode === "oversized" ? 4090 : JSON.stringify(armedControl()).length;
  const slotNow = (() => {
    try {
      const value = world.memory[CONTROL_KEY];
      return value === undefined ? "<absent>" : `attempted=${String(value.attempted)} stopped=${String(value.stopped)}`;
    } catch {
      return "<getter 异常>";
    }
  })();
  const writeRefusals = logLines.filter((line) => line.includes("lab-control-write-refused")).length;
  return {
    scenario: scenario.label,
    initialCharacters: initialLength,
    sendAfterLoop1: n1,
    sendAfterLoop2: n2,
    sendAfterNextTick: n3,
    slotFinal: slotNow,
    writeRefusalLines: writeRefusals,
  };
}

(function main() {
  const fs = require("node:fs");
  const bytes = fs.readFileSync(OLD_BUNDLE);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== EXPECTED_BYTES || sha256 !== EXPECTED_SHA256) {
    throw new Error(`旧产物身份不符：bytes=${bytes.length} sha256=${sha256}`);
  }
  console.log(`旧产物身份核对通过：bytes=${bytes.length} sha256=${sha256}`);
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
  console.log("\n基线矩阵（旧产物·三时点累计 send：目标 tick 第 1 次 / 第 2 次 / 下一 tick）：");
  for (const row of rows) {
    console.log(
      `${row.scenario} | 初始 ${row.initialCharacters} 字符 | send ${row.sendAfterLoop1}/${row.sendAfterLoop2}/${row.sendAfterNextTick} | 槽终态 ${row.slotFinal} | write-refused 行 ${row.writeRefusalLines}`,
    );
  }
  console.log(`\n${JSON.stringify(rows, null, 2)}`);
})();
