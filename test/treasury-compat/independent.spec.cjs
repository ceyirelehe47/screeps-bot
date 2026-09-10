'use strict';
/** Agent 独立反例轮（AGENT-VERIFY §6）。不复制交付方用例：场景、房间布局、
 * 记录形状与断言值均独立构造；真实固定源读取器（useReal）覆盖五组组合：
 * 非空/变更/到期、缺失/损坏、容量/身份、真实来源/主循环、窗口/泄露边界。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const ts = require('typescript');
const { ROOT, load, scene, guard, makeRoom } = require('./helpers.cjs');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/treasury-compat-source-manifest.json'), 'utf8'));
const PRODUCTION_BASE = manifest.productionBase;
const task = (o = {}) => ({ id: 'indep-task', origin: 'manual', status: 'pending', resource: 'H',
  fromRoomName: 'W1N1', toRoomName: 'W2N1', amount: 100, remainingAmount: 70,
  createdAt: 10, updatedAt: 20, lastProgressAt: 20, ...o });
const resv = (o = {}) => ({ roomName: 'W1N1', resource: 'H', holderId: 'synthesis:W1N1:H',
  amount: 25, expiresAt: 200, updatedAt: 20, ...o });
const crow = (s, room, resource) => s.report().commitments.rows.find(r => r.room === room && r.resource === resource);

// ── 组合1：非空旧状态、变更与到期（真实固定源读取器）──────────────────────
test('独立1a：两房非空正对照——done/cancelled 不计 outgoing，manual 计入对侧 incoming', () => {
  const s = scene({ rooms: ['W1N1', 'W2N1'] }, true);
  s.game.rooms.W2N1 = makeRoom('W2N1');
  s.memory.data.resourceControl.tasks = {
    a: task(),
    d: task({ id: 'fin', status: 'done', remainingAmount: 60, amount: 60 }),
    c: task({ id: 'cx', status: 'cancelled', remainingAmount: 50, amount: 50 }),
  };
  s.observer.run();
  const r = s.report();
  assert.equal(r.commitments.status, 'read_complete');
  assert.equal(crow(s, 'W1N1', 'H').outgoing, 70);
  assert.equal(crow(s, 'W2N1', 'H').incoming, 70);
  assert.equal(crow(s, 'W1N1', 'H').productionReserved, 0);
  assert.equal(crow(s, 'W1N1', 'H').completeness, 'complete');
});
test('独立1b：expiresAt 等于当前 tick 仍占用（严格小于才到期），跨过才排除且原记录保留', () => {
  const s = scene({}, true);
  s.memory.runtime.resourceReservations.r1 = resv({ expiresAt: 200, amount: 25 });
  s.observer.run();
  assert.equal(crow(s, 'W1N1', 'H').productionReserved, 25);
  s.game.time = 200; s.observer.run();
  assert.equal(crow(s, 'W1N1', 'H').productionReserved, 25);
  s.game.time = 300; s.observer.run();
  assert.equal(crow(s, 'W1N1', 'H').productionReserved, 0);
  assert.ok(s.memory.runtime.resourceReservations.r1, '到期只影响派生索引，不得删除原记录');
});
test('独立1c：旧 writer 状态迁移与新增记录（无 revision 通知），下一样本如实反映新值', () => {
  const s = scene({}, true);
  const t = task();
  s.memory.data.resourceControl.tasks.t1 = t;
  s.observer.run();
  assert.equal(crow(s, 'W1N1', 'H').outgoing, 70);
  t.status = 'done';
  s.memory.data.resourceControl.tasks.t2 = task({ id: 'new-writer', remainingAmount: 30, amount: 30 });
  s.game.time = 200; s.observer.run();
  assert.equal(crow(s, 'W1N1', 'H').outgoing, 30);
  assert.equal(s.calls.readers, 2);
});

// ── 组合2：缺失与损坏（不冒充空表；completeness 忠实跟随原索引）────────────
test('独立2a：reservations 为数组或 null 不冒充空表', () => {
  for (const value of [[], null]) {
    const s = scene({}, true);
    s.memory.runtime.resourceReservations = value;
    s.observer.run();
    assert.equal(s.report().legacyInputs.reservations.status, 'invalid_container');
    assert.equal(s.report().commitments.status, 'unavailable_legacy_input');
    assert.equal(s.calls.commitments, 0);
  }
});
test('独立2b：单条损坏（remaining>amount）→ read_incomplete 且 scope 级 incomplete，原记录不动', () => {
  const s = scene({}, true);
  s.memory.data.resourceControl.tasks.bad = task({ remainingAmount: 200, amount: 100 });
  const before = JSON.stringify(s.memory);
  s.observer.run();
  const r = s.report();
  assert.equal(r.commitments.status, 'read_incomplete');
  assert.equal(r.commitments.completeness.complete, false);
  assert.equal(r.commitments.completeness.invalidRecords, 1);
  assert.equal(crow(s, 'W1N1', 'H').completeness, 'incomplete-scope');
  assert.equal(JSON.stringify(s.memory), before);
});
test('独立2c：限定资源外（U）损坏记录——索引仍完整定位 scope，选定 H 行保持 complete', () => {
  const s = scene({}, true);
  s.memory.data.resourceControl.tasks.bad = task({ resource: 'U', remainingAmount: -5 });
  s.observer.run();
  const r = s.report();
  assert.equal(r.commitments.status, 'read_incomplete');
  assert.equal(r.commitments.completeness.invalidRecords, 1);
  assert.equal(r.commitments.completeness.globalIncomplete, false);
  assert.equal(crow(s, 'W1N1', 'H').completeness, 'complete');
});
test('独立2d：catalog 外资源记录 → 全局 incomplete 传染每个 scope（fail closed）', () => {
  const s = scene({}, true);
  s.memory.data.resourceControl.tasks.bad = task({ resource: 'unobtainium' });
  s.observer.run();
  const r = s.report();
  assert.equal(r.commitments.completeness.globalIncomplete, true);
  assert.equal(crow(s, 'W1N1', 'H').completeness, 'globally-incomplete');
});
test('独立2e：Proxy 守卫真实武装（写尝试被拦截计数），观察全程零写且原型未污染', () => {
  const s = scene({}, true);
  s.memory.runtime.resourceReservations.k1 = resv();
  const raw = s.memory, counter = { writes: 0 };
  const guarded = guard(raw, counter);
  assert.throws(() => { guarded.runtime.resourceReservations.k2 = 1; });
  assert.throws(() => { delete guarded.runtime.resourceReservations.k1; });
  assert.throws(() => { Object.defineProperty(guarded.runtime, 'x', { value: 1 }); });
  assert.ok(counter.writes >= 3, '守卫已武装：每次尝试都计入');
  s.memory = guarded;
  s.observer.run();
  assert.equal(counter.writes, 3);
  assert.equal(Object.keys(raw.runtime).join(','), 'resourceReservations');
  assert.equal(Object.prototype.treasuryWorldSequence, undefined);
});

// ── 组合3：容量与身份（真实 getCapacity，非 1M/8M 档位；身份变化不沿用基线）──
test('独立3a：非 1M/8M 档位的合法容量变化（1M→3M→2.5M）与结构 ID 替换', () => {
  const s = scene({}, true);
  const x = s.game.rooms.W1N1.storage;
  s.observer.run();
  x.capState.cap = 3000000; s.game.time = 200; s.observer.run();
  let row = s.report().endpoints.find(r => r.location === 'storage');
  assert.equal(row.direct.capacity, 3000000);
  assert.equal(row.change.status, 'endpoint_or_capacity_changed');
  assert.equal(row.coreComparison, 'match_selected_scope');
  x.id = 'storage-W1N1-alt'; s.game.time = 300; s.observer.run();
  row = s.report().endpoints.find(r => r.location === 'storage');
  assert.equal(row.change.status, 'endpoint_or_capacity_changed', '仅 ID 变化也不沿用旧基线');
  assert.equal(row.coreComparison, 'match_selected_scope');
});
test('独立3b：单房一端不可读 → 全房退出 observation/commitments（not_read），readers 零调用', () => {
  const s = scene({}, true);
  Object.defineProperty(s.game.rooms.W1N1.terminal.store, 'getCapacity', { value: () => undefined });
  s.observer.run();
  assert.equal(s.calls.readers, 0);
  assert.equal(s.report().commitments.status, 'not_read');
  assert.deepEqual(s.report().coreObservationRooms, []);
  const row = s.report().endpoints.find(r => r.location === 'terminal');
  assert.equal(row.directStatus, 'unreadable');
  assert.equal(row.direct, undefined);
});
test('独立3c：单资源方法读数超过总量 used → unreadable，不产出半份数据', () => {
  const s = scene({}, true);
  const store = s.game.rooms.W1N1.terminal.store;
  Object.defineProperty(store, 'getUsedCapacity', { value: r => (r === 'energy' ? 999999 : store.energy + store.H) });
  s.observer.run();
  const row = s.report().endpoints.find(r => r.location === 'terminal');
  assert.equal(row.directStatus, 'unreadable');
  assert.equal(row.direct, undefined);
});

// ── 组合4：真实来源与主循环（稀疏枚举对拍；实际候选 main.ts）────────────────
test('独立4a：真实 observation 稀疏键枚举与方法读数故意不一致 → mismatch；恢复后 match', () => {
  const s = scene({}, true);
  const store = s.game.rooms.W1N1.terminal.store;
  s.observer.run();
  assert.equal(s.report().endpoints.find(r => r.location === 'terminal').coreComparison, 'match_selected_scope');
  Object.defineProperty(store, 'getUsedCapacity', { value: r => (r === undefined ? store.energy + store.H : (r === 'H' ? 800 : store[r] || 0)) });
  s.game.time = 200; s.observer.run();
  const row = s.report().endpoints.find(r => r.location === 'terminal');
  assert.equal(row.direct.amounts.H, 800, '方法读数');
  assert.equal(row.coreComparison, 'mismatch');
  assert.ok(row.coreMismatches.includes('H'), '键枚举(1000)与方法(800)不一致必须可见');
  Object.defineProperty(store, 'getUsedCapacity', { value: r => (r === undefined ? store.energy + store.H : store[r] || 0) });
  s.game.time = 300; s.observer.run();
  assert.equal(s.report().endpoints.find(r => r.location === 'terminal').coreComparison, 'match_selected_scope');
});
test('独立4b：同 tick 投影但行字段为字符串 → unreadable 而非 match（comparisonPerformed=false）', () => {
  const s = scene({}, true);
  s.memory.runtime.resourceControl = { updatedAt: 100, rooms: { W1N1: { terminalUsedCapacity: 'garbage', terminalFreeCapacity: 0, terminalEnergy: 0 } } };
  s.observer.run();
  const p = s.report().endpoints.find(r => r.location === 'terminal').legacyProjection;
  assert.equal(p.status, 'unreadable');
  assert.equal(p.comparisonPerformed, false);
});
function runCandidateMain(text, compatFn, failPhase) {
  const code = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
  const ast = ts.createSourceFile('main.ts', text, ts.ScriptTarget.Latest, true);
  const imports = {}; const phases = []; let flushed = false;
  for (const n of ast.statements) if (ts.isImportDeclaration(n) && n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings)) {
    const values = {};
    for (const el of n.importClause.namedBindings.elements) {
      const key = el.name.text;
      values[key] = key === 'errorMapper' ? fn => fn
        : key === 'createTickCpuProfiler' ? () => ({ measure: (name, fn) => { phases.push(name); if (name === failPhase) throw new Error('old failure'); return fn(); }, flush: () => { flushed = true; } })
        : key === 'getTickContextService' ? () => ({ getAllSpawns: () => [], getAllCreeps: () => [] })
        : key === 'runTreasuryCompatRead' ? compatFn
        : () => {};
    }
    imports[n.moduleSpecifier.text] = values;
  }
  const exports = {};
  vmRun(code, { exports, require: k => imports[k] });
  let thrown = false;
  try { exports.loop(); } catch { thrown = true; }
  return { phases, flushed, thrown };
}
function vmRun(code, ctx) { require('node:vm').runInNewContext(code, ctx, { timeout: 5000 }); }
test('独立4c：候选实际 main.ts——39 阶段、首阶段业务异常 fail-fast 且 compatRead 未执行、compatRead 异常被包裹', () => {
  const patched = fs.readFileSync(path.join(ROOT, 'src/main.ts'), 'utf8');
  const original = cp.execFileSync('git', ['-C', ROOT, 'show', `${PRODUCTION_BASE}:src/main.ts`], { encoding: 'utf8' });
  const base = runCandidateMain(original, () => {});
  const after = runCandidateMain(patched, () => {});
  assert.equal(base.phases.length, 38);
  assert.equal(after.phases.length, 39);
  assert.deepEqual(after.phases.filter(p => p !== 'treasuryCompatRead'), base.phases);
  assert.equal(after.phases.at(-1), 'treasuryCompatRead', '诊断阶段在原 flush 前的最后位置');
  const earlyFail = runCandidateMain(patched, () => { throw new Error('should not reach'); }, base.phases[0]);
  assert.equal(earlyFail.thrown, true, '原业务异常仍 fail-fast');
  assert.equal(earlyFail.flushed, false);
  assert.ok(!earlyFail.phases.includes('treasuryCompatRead'));
  const s = scene(); s.ports.readers = () => { throw new Error('new read failure'); };
  const contained = runCandidateMain(patched, () => s.observer.run());
  assert.equal(contained.thrown, false);
  assert.equal(contained.flushed, true);
  assert.equal(s.report().status, 'fault_disabled');
});
test('独立4d：默认配置非合法启用 profile——enabled 翻转 alone 仍被拒绝', () => {
  const config = load('treasuryCompatConfig.ts');
  const api = load('treasuryCompatRead.ts');
  assert.equal(config.TREASURY_COMPAT_CONFIG.enabled, false);
  assert.equal(Object.isFrozen(config.TREASURY_COMPAT_CONFIG), true);
  assert.equal(api.validCompatConfig(config.TREASURY_COMPAT_CONFIG), false);
  assert.equal(api.validCompatConfig({ ...config.TREASURY_COMPAT_CONFIG, enabled: true }), false, '空房间/零窗口不是可启用 profile');
});

// ── 组合5：窗口与泄露边界 ───────────────────────────────────────────────────
test('独立5a：绝对窗口结束 + heap 重建不重开窗口，零新增读取', () => {
  const s = scene({ endTick: 500 });
  assert.equal(s.observer.run().status, 'sampled');
  s.game.time = 600;
  const before = s.calls.readers + s.calls.memory + s.calls.room;
  assert.equal(s.observer.run().status, 'outside_window');
  const rebuilt = s.api.createTreasuryCompatPreview(s.cfg, s.ports);
  assert.equal(rebuilt.run().status, 'outside_window');
  assert.equal(rebuilt.stats().retainedEndpoints, 0);
  assert.equal(s.calls.readers + s.calls.memory + s.calls.room, before);
});
test('独立5b：低 bucket 跳过消耗本 tick 尝试名额；同 tick 恢复也不补采', () => {
  const s = scene();
  s.bucket = 100;
  assert.equal(s.observer.run().status, 'cpu_skipped');
  assert.equal(s.calls.memory, 0);
  s.bucket = 9000;
  assert.equal(s.observer.run().status, 'not_due', '同一 tick 不因先前跳过而重试');
  s.game.time = 200;
  assert.equal(s.observer.run().status, 'sampled');
});
test('独立5c：fault 清空保留快照，不再以隐形基线比较', () => {
  const s = scene();
  s.observer.run();
  assert.equal(s.observer.stats().retainedEndpoints, 2);
  s.throwEmit = true; s.game.time = 200;
  assert.equal(s.observer.run().status, 'fault_disabled');
  assert.equal(s.observer.stats().retainedEndpoints, 0);
  s.throwEmit = false; s.game.time = 300;
  assert.equal(s.observer.run().status, 'disabled_after_fault');
});
test('独立5d：输出不含原始任务/预留负载、holder 身份串与凭据形态', () => {
  const s = scene({}, true);
  s.memory.data.resourceControl.tasks.leak = task({ id: 'task-payload-9f' });
  s.memory.runtime.resourceReservations['W1N1:H:synthesis:W1N1:H'] = resv({ holderId: 'synthesis:W1N1:H' });
  s.observer.run();
  const line = s.lines.at(-1);
  const report = JSON.parse(line);
  for (const needle of ['task-payload-9f', 'synthesis:W1N1:H', 'holderId', 'resourceReservationsOwnerVersion', 'token', 'secret']) {
    assert.ok(!line.includes(needle), `输出不得包含 ${needle}`);
  }
  assert.equal(report.authorizesActions, false);
  assert.equal(report.spendable, null);
});
