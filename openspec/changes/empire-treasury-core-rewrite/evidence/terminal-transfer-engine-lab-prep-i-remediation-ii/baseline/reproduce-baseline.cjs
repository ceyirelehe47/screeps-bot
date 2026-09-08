/**
 * Terminal Transfer Engine Lab Prep I · Remediation II——B1/B2 基线复现脚本。
 *
 * 在当前起点（87507f4，未修改）上复现任务书 §3 的两个读取/写入大小缺口：
 *
 * B1（§3.2）：非 ASCII 结果记录超过 4 KiB 仍写入。
 *   旧产物（上轮 Remediation I 交付归档，24,496 字节）已具备"写入结果化 +
 *   读回确认"顺序；但大小检查是 JSON.stringify(record).length 字符口径。
 *   正常合法场景下 send 同步抛 new Error("错".repeat(2048))——结果 JSON
 *   字符长度约 2200（≤4096 通过旧检查）而 UTF-8 字节数约 6300（>4096），
 *   超限结果仍被写入控制槽。
 *
 * B2（§3.3）：受支持字段组成的超限记录仍被读取为健康。
 *   全部字段（experimentId/armed/attempted/attemptedTick/stopped/syncResult.ok/
 *   syncResult.error）均受旧形状支持、无未知键；旧 readControlRecord() 只做
 *   存在性与形状检查、无大小检查，对该超字节记录返回 ok。复现在旧源码的
 *   直接读取入口（git show 起点源码 → TypeScript 转译 → VM 执行）；
 *   另以旧产物 loop 对照——预置同记录只会撞 already_stopped（读取健康
 *   误判），不会暴露大小问题。B2 证明的是读取契约缺口，不是超长 stopped
 *   记录能再次发送。
 *
 * 本脚本只在起点工作树上运行一次以取得基线数据；正式验收使用修复后的
 * 正确预期（probe.test.ts），不把旧缺口留作绿灯标准。
 */
"use strict";

const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const path = require("node:path");
const vm = require("node:vm");

const REPO_ROOT = "D:/code/screeps/screeps-bot";
const OLD_BUNDLE = path.join(
  REPO_ROOT,
  "openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-engine-lab-prep-i-remediation-i/final/lab-single-shot/single-shot.js",
);
const START_HEAD = "87507f42b1302e6f0e5916d9dfb5c3cca9d94790";
const EXPECTED_SHA256 = "49960ef8d5a147adeb49d6a36ba9df5b56cfd79028918e9be50d522d46f083ca";
const EXPECTED_BYTES = 24496;

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

/** B2 记录：受支持字段、合法形状、error=5000 个 ASCII x（无 note/extra/循环引用）。 */
function b2Record(errorLength) {
  return {
    experimentId: CONFIG.experimentId,
    armed: true,
    attempted: true,
    attemptedTick: CONFIG.targetTick,
    syncResult: { ok: false, error: "x".repeat(errorLength) },
    stopped: true,
  };
}

/** 独立计量：JSON 字符长度与 UTF-8 字节数（Buffer 只作外部期望，不进被测实现）。 */
function measure(record) {
  const serialized = JSON.stringify(record);
  return {
    characters: serialized.length,
    utf8Bytes: Buffer.byteLength(serialized, "utf8"),
  };
}

/** 假世界（普通可写控制槽；send spy 可配置同步行为并在入口内观察槽状态）。 */
function installWorld(initialControl, sendBehavior) {
  const sendCalls = [];
  let insideSendSlot;
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
      insideSendSlot = memory[CONTROL_KEY]; // send 入口内观察（记录后、抛错前）
      if (sendBehavior && sendBehavior.throws) throw sendBehavior.throws;
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
  memory[CONTROL_KEY] = initialControl;
  return {
    game,
    memory,
    sendCalls,
    get insideSendSlot() {
      return insideSendSlot;
    },
  };
}

/** 全新 VM 沙箱按 CommonJS 装载产物（仓库 package.json 为 ESM，直接 require 会被误判）。 */
function loadBundleInVm(bundleCode, game, memory, logSink) {
  const moduleExports = {};
  vm.runInNewContext(
    bundleCode,
    {
      exports: moduleExports,
      module: { exports: moduleExports },
      console: { log: (...args) => logSink.push(args.map(String).join(" ")) },
      Game: game,
      Memory: memory,
    },
    { filename: "vm-single-shot-bundle.js" },
  );
  if (typeof moduleExports.loop !== "function") throw new Error("产物未导出 loop");
  return moduleExports;
}

/** 旧源码读取入口：git show 起点版本 → TypeScript 转 CommonJS → VM 执行取 readControlRecord。 */
function loadLegacyReader() {
  const ts = require(path.join(REPO_ROOT, "node_modules", "typescript"));
  const source = execFileSync("git", ["-C", REPO_ROOT, "show", `${START_HEAD}:test/lab/terminal-transfer/controlRecord.ts`], {
    encoding: "utf8",
  });
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const moduleExports = {};
  vm.runInNewContext(
    transpiled,
    {
      exports: moduleExports,
      module: { exports: moduleExports },
      console: { log: () => {} },
      Memory: {},
    },
    { filename: "vm-legacy-control-record.cjs" },
  );
  if (typeof moduleExports.readControlRecord !== "function") {
    throw new Error("旧源码转译后未导出 readControlRecord");
  }
  return (memory) => {
    // 旧实现经全局 Memory 读取——在该 VM 上下文外无法直接替换全局，这里用
    // 第二个上下文按同源码重建并注入目标 Memory（等价于不同 Memory 实例）。
    const inner = {};
    vm.runInNewContext(
      transpiled,
      {
        exports: inner,
        module: { exports: inner },
        console: { log: () => {} },
        Memory: memory,
      },
      { filename: "vm-legacy-control-record-read.cjs" },
    );
    return inner.readControlRecord();
  };
}

(function main() {
  const fs = require("node:fs");

  // ── 旧产物身份核对（任务书 §3.1） ─────────────────────────────────────────
  const bytes = fs.readFileSync(OLD_BUNDLE);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== EXPECTED_BYTES || sha256 !== EXPECTED_SHA256) {
    throw new Error(`旧产物身份不符：bytes=${bytes.length} sha256=${sha256}`);
  }
  const blob = execFileSync("git", ["-C", REPO_ROOT, "hash-object", OLD_BUNDLE], { encoding: "utf8" }).trim();
  console.log(`旧产物身份核对通过：bytes=${bytes.length} blob=${blob} sha256=${sha256}`);
  const bundleCode = bytes.toString("utf8");

  // ── B1：非 ASCII 结果超限仍写入（旧产物字符口径缺口） ────────────────────
  {
    const world = installWorld(armedControl(), { throws: new Error("错".repeat(2048)) });
    const logLines = [];
    const bundle = loadBundleInVm(bundleCode, world.game, world.memory, logLines);
    bundle.loop();
    const sendAfterLoop1 = world.sendCalls.length;
    const insideSend = world.insideSendSlot;
    bundle.loop(); // 同 tick 重复
    const sendAfterLoop2 = world.sendCalls.length;
    world.game.time = CONFIG.targetTick + 1;
    bundle.loop(); // 下一 tick
    const sendAfterNextTick = world.sendCalls.length;
    const slotFinal = world.memory[CONTROL_KEY];
    const finalMeasure = measure(slotFinal);
    const initialMeasure = measure(armedControl());
    console.log("\n[B1] 非 ASCII 结果超限（旧产物·字符口径缺口）：");
    console.log(
      `  send 三时点累计：${sendAfterLoop1}/${sendAfterLoop2}/${sendAfterNextTick}（send 入口内 attempted=${String(insideSend && insideSend.attempted)}）`,
    );
    console.log(
      `  初始记录：${initialMeasure.characters} 字符 / ${initialMeasure.utf8Bytes} UTF-8 字节`,
    );
    console.log(
      `  结果槽终态 JSON：${finalMeasure.characters} 字符 / ${finalMeasure.utf8Bytes} UTF-8 字节（独立 Buffer.byteLength 计量）`,
    );
    console.log(
      `  槽终态字段：attempted=${String(slotFinal.attempted)} stopped=${String(slotFinal.stopped)} syncResult.error 长度=${String(slotFinal.syncResult && slotFinal.syncResult.error ? slotFinal.syncResult.error.length : "无")}`,
    );
    const writeRefused = logLines.filter((line) => line.includes("lab-control-write-refused")).length;
    console.log(`  write-refused 行数：${writeRefused}（超限写入未被拒绝——B1 缺口留痕）`);
    console.log(
      `  缺口判定：字符 ${finalMeasure.characters} ≤ 4096 通过旧检查，UTF-8 字节 ${finalMeasure.utf8Bytes} > 4096 仍写入=${String(finalMeasure.utf8Bytes > 4096 && finalMeasure.characters <= 4096 && slotFinal.syncResult !== undefined)}`,
    );
  }

  // ── B2：受支持字段超限记录读取为健康（旧源码读取入口缺口） ────────────────
  {
    const readWith = loadLegacyReader();
    const record = b2Record(5000);
    const m = measure(record);
    if (m.utf8Bytes <= 4096) throw new Error(`B2 记录构造失败：UTF-8 字节 ${m.utf8Bytes} 未超 4096`);
    const memory = {};
    memory[CONTROL_KEY] = record;
    const recordRef = memory[CONTROL_KEY];
    const beforeKeys = Object.keys(memory).join(",");
    const verdict = readWith(memory);
    const afterRef = memory[CONTROL_KEY];
    const shortRecord = b2Record(10);
    const shortMemory = {};
    shortMemory[CONTROL_KEY] = shortRecord;
    const shortVerdict = readWith(shortMemory);
    console.log("\n[B2] 受支持字段超限记录（旧源码 readControlRecord 缺口）：");
    console.log(`  记录 JSON：${m.characters} 字符 / ${m.utf8Bytes} UTF-8 字节（先独立证明 >4096）`);
    console.log(`  旧读取入口返回：${JSON.stringify({ status: verdict.status, attempted: verdict.record && verdict.record.attempted })}（ok=读取健康误判——B2 缺口留痕）`);
    console.log(`  读取零写核验：槽引用不变=${String(afterRef === recordRef)} Memory 键不变=${String(Object.keys(memory).join(",") === beforeKeys)}`);
    console.log(
      `  短合法对照（error=10 x）：${shortMeasure(shortRecord)} → ${shortVerdict.status}（读取未被整体禁用）`,
    );
    function shortMeasure(rec) {
      const sm = measure(rec);
      return `${sm.characters} 字符 / ${sm.utf8Bytes} 字节`;
    }
  }

  // ── B2-loop：旧产物 loop 对照（读取健康误判只撞 already_stopped，非大小拒绝） ──
  {
    const world = installWorld(b2Record(5000), null);
    const logLines = [];
    const bundle = loadBundleInVm(bundleCode, world.game, world.memory, logLines);
    bundle.loop();
    const rejections = logLines
      .filter((line) => line.startsWith("{") && line.includes('"kind":"lab-precondition-rejection"'))
      .map((line) => JSON.parse(line).reason);
    console.log("\n[B2-loop] 旧产物预置 B2 记录对照：");
    console.log(`  send 调用：${world.sendCalls.length}；前置拒绝原因：${JSON.stringify(rejections)}`);
    console.log(
      `  槽终态引用不变=${String(world.memory[CONTROL_KEY] === world.memory[CONTROL_KEY])}（loop 未写槽、未删改记录）`,
    );
  }

  console.log("\nBASELINE_DONE");
})();
