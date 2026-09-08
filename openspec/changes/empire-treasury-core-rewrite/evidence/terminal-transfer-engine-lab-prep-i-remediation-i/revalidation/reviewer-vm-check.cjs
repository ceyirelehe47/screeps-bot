// 独立 reviewer VM 复验（任务书 §8.3 / 验收 Q02、Q03 的独立环境复验）
// 在第二树 labprep1-r1-tree2 内构建的 single-shot.js 产物上，用 Node VM
// 假端口复刻两个核心场景。不依赖仓库 Jest 断言，不修改被测代码。
//
// 场景甲（发送前标记失败 → 零 send）：控制槽 defineProperty——setter 抛错、
//   getter 返回合法 armed 记录。loop()×2（同 tick）+ tick 推进后 loop()×1。
//   断言 send 累计 0、输出含 kind=lab-mark-unconfirmed。
// 场景乙（预标记成功、结果写失败 → 恰 1 次 send）：控制槽 defineProperty
//   计数写次数——第 1 次 set 正常存、第 2 次起抛错。loop()×3（同 tick×2 +
//   下一 tick）。断言 send 累计恰 1、槽内终态 attempted=true 且无 stopped、
//   输出含 kind=lab-result-write-refused。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BUNDLE = path.join(__dirname, 'reviewer-bundle', 'single-shot.js');
const CONTROL_KEY = '__labTerminalTransferProbe';
const EXPERIMENT_ID = 'lab-prep1-example-0001';

const bundleSource = fs.readFileSync(BUNDLE, 'utf8');

// ---- 公共世界 stub（每个场景独立新建，互不共享） ----
function makeGameStub(sendSpy) {
  const sourceTerminal = {
    id: 'lab-term-source-synthetic',
    store: {
      H: 1000,
      energy: 10000,
      getFreeCapacity: () => 50000,
    },
    cooldown: 0,
    owner: { username: 'lab-synthetic-user' },
    send: (...args) => {
      sendSpy.count += 1;
      sendSpy.calls.push(args);
      return 0; // OK === 0
    },
  };
  const targetTerminal = {
    id: 'lab-term-target-synthetic',
    store: {
      energy: 2000,
      getFreeCapacity: () => 100000,
    },
    cooldown: 0,
    owner: { username: 'lab-synthetic-user' },
  };
  return {
    time: 12345,
    shard: { name: 'lab-synthetic-shard' },
    rooms: {
      W1N57: { terminal: sourceTerminal },
      W10N57: { terminal: targetTerminal },
    },
    market: {
      calcTransactionCost: () => 26,
      incomingTransactions: [],
      outgoingTransactions: [],
    },
  };
}

function loadModule(Game, Memory) {
  const logs = [];
  const sandboxConsole = { log: (...a) => logs.push(a.map(String).join(' ')) };
  const moduleObj = { exports: {} };
  const sandbox = {
    module: moduleObj,
    exports: moduleObj.exports,
    console: sandboxConsole,
    Game,
    Memory,
  };
  vm.runInNewContext(bundleSource, sandbox, { filename: 'reviewer-single-shot.js' });
  if (typeof moduleObj.exports.loop !== 'function') {
    throw new Error('产物未导出 loop 函数');
  }
  return { loop: moduleObj.exports.loop, logs };
}

const armedRecord = () =>
  Object.freeze({
    experimentId: EXPERIMENT_ID,
    armed: true,
    attempted: false,
  });

const results = [];
function assert(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || '' });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

// ---- 场景甲：发送前标记失败（setter 抛错）→ 零发送 ----
function scenarioA() {
  console.log('===== 场景甲：控制槽 setter 抛错（发送前标记失败） =====');
  const sendSpy = { count: 0, calls: [] };
  const Game = makeGameStub(sendSpy);
  const Memory = {};
  Object.defineProperty(Memory, CONTROL_KEY, {
    configurable: true,
    get() {
      return armedRecord(); // getter 始终返回合法 armed 记录
    },
    set() {
      throw new Error('reviewer: control slot setter refuses all writes');
    },
  });
  const { loop, logs } = loadModule(Game, Memory);

  loop(); // tick 12345 第 1 次
  loop(); // 同 tick 第 2 次
  Game.time = 12346; // 推进 tick
  loop(); // 下一 tick

  const markUnconfirmed = logs.filter((l) => l.includes('"kind":"lab-mark-unconfirmed"'));
  const sendAttempts = logs.filter((l) => l.includes('"kind":"lab-send-attempt"'));
  console.log(`send 累计调用: ${sendSpy.count}`);
  console.log(`lab-mark-unconfirmed 行数: ${markUnconfirmed.length}`);
  for (const line of markUnconfirmed) console.log('  ' + line);
  console.log(`lab-send-attempt 行数（boundary/pre-call/sync 输出）: ${sendAttempts.length}`);

  assert('甲: send spy 累计 0 次', sendSpy.count === 0, `actual=${sendSpy.count}`);
  assert(
    '甲: 输出含 lab-mark-unconfirmed',
    markUnconfirmed.length > 0,
    `lines=${markUnconfirmed.length}`
  );
  assert(
    '甲: 未打印任何发送边界输出（pre-call/boundary/sync）',
    sendAttempts.length === 0,
    `lines=${sendAttempts.length}`
  );
  return { sendCount: sendSpy.count, markUnconfirmed: markUnconfirmed.length };
}

// ---- 场景乙：预标记成功、结果写失败 → 恰 1 次 send ----
function scenarioB() {
  console.log('===== 场景乙：预标记成功、结果写失败（第 2 次 set 起抛错） =====');
  const sendSpy = { count: 0, calls: [] };
  const Game = makeGameSpyStubWithSendArgs(sendSpy);
  const Memory = {};
  let backing = { experimentId: EXPERIMENT_ID, armed: true, attempted: false };
  let setCount = 0;
  Object.defineProperty(Memory, CONTROL_KEY, {
    configurable: true,
    get() {
      return backing;
    },
    set(v) {
      setCount += 1;
      if (setCount === 1) {
        backing = v; // 第 1 次（预标记）正常存储
        return;
      }
      throw new Error('reviewer: control slot refuses subsequent writes');
    },
  });
  const { loop, logs } = loadModule(Game, Memory);

  loop(); // tick 12345 第 1 次 → 预标记写入成功（set#1）→ 读回确认 → send#1 → 结果写失败（set#2 抛错）
  loop(); // 同 tick 第 2 次 → 控制记录 attempted=true → 前置拒绝
  Game.time = 12346; // 下一 tick
  loop(); // tick_missed 拒绝

  const resultRefused = logs.filter((l) => l.includes('"kind":"lab-result-write-refused"'));
  console.log(`send 累计调用: ${sendSpy.count}`);
  if (sendSpy.count === 1 && sendSpy.calls.length === 1) {
    console.log(`send 调用参数: ${JSON.stringify(sendSpy.calls[0])}`);
  }
  console.log(`lab-result-write-refused 行数: ${resultRefused.length}`);
  for (const line of resultRefused) console.log('  ' + line);
  console.log(`控制槽终态: ${JSON.stringify(backing)}`);
  console.log(`控制槽 setter set 调用次数: ${setCount}`);

  assert('乙: send spy 累计恰 1 次', sendSpy.count === 1, `actual=${sendSpy.count}`);
  assert(
    '乙: send 参数为 (H, 100, W10N57, 描述)',
    sendSpy.count === 1 &&
      JSON.stringify(sendSpy.calls[0]) ===
        JSON.stringify([
          'H',
          100,
          'W10N57',
          'lab-prep1 single-shot terminal transfer experiment',
        ]),
    sendSpy.count === 1 ? JSON.stringify(sendSpy.calls[0]) : 'no call'
  );
  assert('乙: 槽内终态 attempted === true', backing.attempted === true, JSON.stringify(backing));
  assert(
    '乙: 槽内终态无 stopped（结果写失败未落盘为 stopped）',
    !('stopped' in backing) || backing.stopped !== true,
    'stopped' in backing ? `stopped=${JSON.stringify(backing.stopped)}` : 'stopped 键不存在'
  );
  assert(
    '乙: 输出含 lab-result-write-refused',
    resultRefused.length > 0,
    `lines=${resultRefused.length}`
  );
  return { sendCount: sendSpy.count, finalSlot: backing, setCount };
}

// 与 makeGameStub 相同的世界（复用于场景乙）
function makeGameSpyStubWithSendArgs(sendSpy) {
  return makeGameStub(sendSpy);
}

const a = scenarioA();
console.log('');
const b = scenarioB();

console.log('');
console.log('===== 断言汇总 =====');
let allPass = true;
for (const r of results) {
  if (!r.pass) allPass = false;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
}
console.log(`REVIEWER_VM_CHECK=${allPass ? 'ALL_PASS' : 'FAILURES_PRESENT'}`);
process.exitCode = allPass ? 0 : 1;
