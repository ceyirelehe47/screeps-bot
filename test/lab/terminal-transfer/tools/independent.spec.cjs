'use strict';
// Control Remediation I — Agent 独立增补场景（R01/R03）。
// 与包内 memory.spec.cjs / stop.spec.cjs 互补：initialize-on-existing、
// 写后世界推进、暂停后存储与玩家读数不一致、formal 前置拒绝与错误活动
// 入口的停止分支、control 模式即时纠错停止。仅 fake 端口，零真实进程。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SLOT, planMemoryUpdate, updateMemory, assessControlSamples } = require('./memory-control.cjs');
const { createStopController } = require('./stop-controller.cjs');
const cfg = require('./fixtures/review-base-config.json');

// ── R01：Memory 控制通路增补 ─────────────────────────────────────────────
const ID = 'agent-independent-test';
const pristine = { experimentId: ID, armed: false, attempted: false };
const rawOf = record => JSON.stringify({ keep: 'untouched', [SLOT]: record });
const sample = (tick, record) => ({ kind: 'lab-control-sample', sampler: { name: 'lab-control-probe', version: '1' },
  userId: 'u', user: { username: 'lab-u' }, expectedExperimentId: ID, tick, control: { status: 'ok', record } });

test('initialize refuses an existing control slot (no reset/overwrite)', () => {
  assert.throws(() => planMemoryUpdate(rawOf(pristine), 'initialize', ID), /absent/);
  const armedRaw = rawOf({ ...pristine, armed: true });
  assert.throws(() => planMemoryUpdate(armedRaw, 'initialize', ID), /absent/);
});

test('world advancing after the single env write aborts with no repair write', async () => {
  let value = rawOf(pristine), writes = 0, calls = 0;
  const io = {
    assertIdentity: async () => {},
    // 前两次稳定核对 tick=9（初始+写前复核）；写回读一致后第三次核对发现推进。
    assertPausedStable: async () => (++calls <= 2 ? 9 : 10),
    readRuntimeMemory: async () => value,
    writeRuntimeMemory: async s => { writes++; value = s; },
  };
  await assert.rejects(updateMemory(io, 'arm', ID), /advanced/);
  assert.equal(writes, 1);
});

test('post-pause storage differing from player reads is not player confirmation', () => {
  const armedRecord = { ...pristine, armed: true };
  const expected = { userId: 'u', username: 'lab-u', experimentId: ID, armed: true };
  const playerOk = assessControlSamples([sample(1, armedRecord), sample(2, armedRecord)], expected, rawOf(armedRecord));
  assert.equal(playerOk.ready, true);
  // 同一形状但存储端 armed=false：往返未闭合。
  const mismatch = assessControlSamples([sample(1, armedRecord), sample(2, armedRecord)], expected, rawOf(pristine));
  assert.equal(mismatch.ready, false);
  assert.ok(mismatch.issues.some(issue => issue.includes('storage differs')));
});

// ── R03：外部停止增补 ───────────────────────────────────────────────────
class Clock {
  time = 0; next = 0; timers = new Map();
  now = () => this.time;
  setTimer = (fn, ms) => { const id = ++this.next; this.timers.set(id, { at: this.time + ms, fn }); return id; };
  clearTimer = id => this.timers.delete(id);
  async advance(ms) {
    const end = this.time + ms;
    for (let i = 0; i < 12; i++) await Promise.resolve();
    for (;;) {
      const jobs = [...this.timers].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at);
      if (!jobs.length) break;
      const [, v] = jobs[0];
      this.timers.delete(jobs[0][0]); this.time = v.at; v.fn();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    }
    this.time = end;
    for (let i = 0; i < 12; i++) await Promise.resolve();
  }
}
function fixture() {
  const clock = new Clock(), pauses = [], kills = [], logs = [];
  const ports = {
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    audit: e => logs.push(e),
    pause: () => { pauses.push(clock.time); return Promise.resolve('OK'); },
    readState: async () => ({ paused: true, tick: cfg.targetTick + 21 }),
    killTree: async () => { kills.push(clock.time); },
  };
  const controller = createStopController({ userId: 'u', config: cfg }, ports);
  controller.start();
  return { clock, pauses, kills, controller };
}
const envelope = row => ({ channel: 'user:u/console', payload: JSON.stringify({ userId: 'u', messages: { log: [JSON.stringify(row)] } }) });
// control 模式先做 healthySample 检查：控制记录断言样本必须带完整健康端点。
const facts = require('./fixtures/review-base-facts.json');
function healthyRow(tick, record) {
  // 对齐采样来源与停止控制器身份；不替调用者修正 control.record。
  return { ...sample(tick, record),
    user: { username: cfg.username }, expectedExperimentId: cfg.experimentId,
    experimentId: cfg.experimentId, configTargetTick: cfg.targetTick,
    source: { ...facts.samples[1].source, roomName: cfg.sourceRoomName },
    target: { ...facts.samples[1].target, roomName: cfg.targetRoomName },
    feeQuote: { status: 'ok', energyCost: cfg.maxFeeEnergy },
    transactions: { incoming: { status: 'ok', records: [] }, outgoing: { status: 'ok', records: [] } } };
}

test('formal precondition rejection stops promptly without waiting for the window', async () => {
  const f = fixture();
  f.controller.ingest(envelope({ kind: 'lab-precondition-rejection', reason: 'no_control_record', tick: cfg.targetTick }));
  assert.equal(f.pauses.length, 1);
  await f.clock.advance(1100);
  const result = await f.controller.done;
  assert.equal(result.reason, 'send_precondition_rejected');
  assert.equal(result.ok, false);
  assert.equal(f.kills.length, 0); // 暂停成功确认即停，无需进程兜底
});

test('control-probe output during the formal window means the wrong active entry', async () => {
  const f = fixture();
  const row = sample(cfg.targetTick - 2, { ...pristine, experimentId: cfg.experimentId });
  row.expectedExperimentId = cfg.experimentId; row.user.username = cfg.username; row.userId = 'u';
  f.controller.ingest(envelope(row));
  assert.equal(f.pauses.length, 1);
  await f.clock.advance(1100);
  assert.equal((await f.controller.done).reason, 'wrong_active_entry');
});

test('control mode isolates the armed flag: first mismatch stops, two matching ticks confirm', async () => {
  function controlFixture(expectedArmed) {
    const clock = new Clock(), pauses = [], kills = [];
    const ports = {
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      audit: () => {}, pause: () => { pauses.push(clock.time); return Promise.resolve('OK'); },
      readState: async () => ({ paused: true, tick: 99 }),
      killTree: async () => { kills.push(clock.time); },
    };
    const controller = createStopController({ userId: 'u', config: cfg, mode: 'control', expectedArmed }, ports);
    controller.start();
    return { clock, pauses, kills, controller };
  }

  // 同时覆盖未武装和已武装准备阶段；每个对照使用新的控制器与时钟。
  // 仍为一个 Node 用例，不改变正常 Jest wrapper 的收集数。
  for (const expectedArmed of [false, true]) {
    const expected = { userId: 'u', username: cfg.username, experimentId: cfg.experimentId, armed: expectedArmed };
    const record = { experimentId: cfg.experimentId, armed: expectedArmed, attempted: false };
    const good = healthyRow(50, record);
    const goodNext = healthyRow(51, { ...record });
    const bad = JSON.parse(JSON.stringify(good));
    bad.control.record.armed = !expectedArmed;

    // 反例只允许一个差异，不能由另一个用户/实验 ID 提前触发同名拒绝。
    const restored = JSON.parse(JSON.stringify(bad));
    restored.control.record.armed = expectedArmed;
    assert.deepEqual(restored, good);
    assert.deepEqual(assessControlSamples([good], expected).issues, ['two player ticks required']);
    assert.equal(assessControlSamples([good, goodNext], expected).ready, true);

    const negative = controlFixture(expectedArmed);
    negative.controller.ingest(envelope(bad));
    assert.deepEqual(negative.pauses, [0]); // 第一条即实际请求暂停，不等第二条或 deadline。
    await negative.clock.advance(1100);
    const rejected = await negative.controller.done;
    assert.equal(rejected.reason, 'control_mismatch');
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.sampleTicks, [50]);
    assert.deepEqual(negative.kills, []);

    const positive = controlFixture(expectedArmed);
    positive.controller.ingest(envelope(good));
    await positive.clock.advance(500);
    assert.equal(positive.controller.state, 'running');
    assert.deepEqual(positive.pauses, []); // 单条正确样本不得误停，也不能提前确认。
    positive.controller.ingest(envelope(goodNext));
    assert.deepEqual(positive.pauses, [500]);
    await positive.clock.advance(1100);
    const confirmed = await positive.controller.done;
    assert.equal(confirmed.reason, 'control_confirmed');
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.pauseConfirmed, true);
    assert.deepEqual(confirmed.sampleTicks, [50, 51]);
    assert.deepEqual(positive.kills, []);
    assert.equal(positive.clock.timers.size, 0);
  }
});
