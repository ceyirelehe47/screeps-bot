'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');
const { LAB } = require('./ts-module.cjs');
const { captureLauncher, terminateLauncher, identityMatches, inspectProcess } = require('./process-scope.cjs');
const hash = x => createHash('sha256').update(x).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function within(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
function bounded(work, ms, label) {
  let timer;
  return Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timeout')), ms);
  })]).finally(() => clearTimeout(timer));
}
function validateBinding(options) {
  if (!['127.0.0.1', '::1'].includes(options.host)) throw new Error('literal loopback host required');
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('explicit storage port required');
  if (!/^[a-zA-Z0-9_-]+$/.test(options.userId || '') || !/^lab[-_]/.test(options.username || '')) throw new Error('explicit synthetic user binding required');
  const environmentRoot = fs.realpathSync(options.environmentRoot);
  const serverRoot = fs.realpathSync(path.join(environmentRoot, 'server'));
  const repo = path.resolve(LAB, '../../..');
  if (environmentRoot === path.parse(environmentRoot).root || within(environmentRoot, repo)
      || within(repo, environmentRoot) || !within(environmentRoot, serverRoot)) throw new Error('environment must be isolated from the bot repository');
  return { ...options, port, environmentRoot, serverRoot };
}

/** Load only the explicitly selected local installation. Does not launch a
 * server, load bot credentials, mutate DB rows, reset a world or deploy code. */
async function connectLocal(options, audit) {
  const binding = validateBinding(options);
  const owner = await captureLauncher(binding.pid, binding.environmentRoot);
  const localRequire = createRequire(path.join(binding.serverRoot, 'package.json'));
  const files = {};
  for (const pkg of ['@screeps/common', '@screeps/driver', '@screeps/backend', '@screeps/engine']) {
    const file = fs.realpathSync(localRequire.resolve(pkg + '/package.json'));
    if (!within(binding.serverRoot, file)) throw new Error('dependency resolved outside isolated server: ' + pkg);
    files[pkg] = { path: file, version: JSON.parse(fs.readFileSync(file)).version };
  }
  // Inspect the installed bytes, not a guessed upstream tag. These checks locate
  // this adapter's supported env Memory path; they are not engine verification.
  const driverRoot = path.dirname(files['@screeps/driver'].path);
  const backendRoot = path.dirname(files['@screeps/backend'].path);
  const paths = [path.join(driverRoot, 'lib/runtime/data.js'), path.join(driverRoot, 'lib/index.js'), path.join(backendRoot, 'lib/cli/system.js')];
  const sources = paths.map(file => ({ path: file, source: fs.readFileSync(file, 'utf8') }));
  if (!/env\.get\(\s*env\.keys\.MEMORY\s*\+\s*userId\s*\)/.test(sources[0].source)
      || !/env\.set\(\s*env\.keys\.MEMORY\s*\+\s*userId\s*,\s*memory\.data\s*\)/.test(sources[1].source)
      || !/MAIN_LOOP_PAUSED/.test(sources[2].source)) throw new Error('installed runtime path differs; refuse unsupported adapter');
  audit({ kind: 'runtime-binding', binding, owner, packages: files,
    sources: sources.map(s => ({ path: s.path, sha256: hash(s.source),
      lines: s.source.split('\n').flatMap((line, index) => /MEMORY|MAIN_LOOP_PAUSED/.test(line) ? [{ line: index + 1, text: line }] : []) })) });
  // These exact values replace inherited environment configuration before any
  // local Screeps module is evaluated. No localhost DNS or remote fallback.
  process.env.STORAGE_HOST = binding.host; process.env.STORAGE_PORT = String(binding.port);
  const common = localRequire('@screeps/common');
  const system = localRequire('@screeps/backend/lib/cli/system');
  await bounded(() => common.storage._connect(), 5000, 'storage connect');
  const { env, db, pubsub } = common.storage;
  for (const key of ['MEMORY', 'GAMETIME', 'MAIN_LOOP_PAUSED']) if (typeof env.keys[key] !== 'string' || !env.keys[key]) throw new Error('missing runtime key ' + key);
  let termination; // Reuse this exact cleanup attempt; a second call is not new evidence.
  const io = {
    binding, owner, pubsub, envKeys: env.keys,
    async assertIdentity() {
      const user = await bounded(() => db.users.findOne({ _id: binding.userId }), 2000, 'user identity');
      if (!user || user.username !== binding.username || typeof user.bot !== 'string' || !user.bot) throw new Error('synthetic user identity mismatch');
      const actual = await inspectProcess(owner.pid);
      if (!identityMatches(owner, actual)) throw new Error('launcher identity changed');
    },
    async readState() {
      const [tickRaw, paused] = await Promise.all([env.get(env.keys.GAMETIME), env.get(env.keys.MAIN_LOOP_PAUSED)]);
      if (!(typeof tickRaw === 'number' || (typeof tickRaw === 'string' && /^\d+$/.test(tickRaw)))) throw new Error('gametime unreadable');
      const tick = Number(tickRaw);
      if (!Number.isSafeInteger(tick) || tick < 0 || !['0', '1', 0, 1].includes(paused)) throw new Error('invalid simulation state');
      return { tick, paused: String(paused) === '1' };
    },
    async assertPausedStable() {
      const start = performance.now(); let prior, since;
      while (performance.now() - start < 4500) {
        const state = await bounded(() => io.readState(), 1000, 'pause state');
        if (!state.paused) throw new Error('simulation is not paused');
        if (state.tick !== prior) { prior = state.tick; since = performance.now(); }
        if (performance.now() - since >= 1000) { audit({ kind: 'paused-stable', ...state }); return state.tick; }
        await sleep(250);
      }
      throw new Error('paused tick not stable within bound');
    },
    readRuntimeMemory: () => bounded(() => env.get(env.keys.MEMORY + binding.userId), 2000, 'Memory read'),
    writeRuntimeMemory: raw => bounded(() => env.set(env.keys.MEMORY + binding.userId, raw), 2000, 'Memory write'),
    pause: () => system.pauseSimulation(),
    resume: () => system.resumeSimulation(),
    killTree: () => (termination ??= terminateLauncher(owner, audit)),
    async activeModules() {
      const code = await bounded(() => db['users.code'].findOne({ $and: [{ user: binding.userId }, { activeWorld: true }] }), 2000, 'active modules');
      if (!code || !code.modules || typeof code.modules !== 'object') throw new Error('active modules unavailable');
      audit({ kind: 'active-module-readback', branch: code.branch, modules: code.modules });
      return code.modules;
    },
    async finalSnapshot() {
      const [memory, transactions, objects, state] = await Promise.all([
        io.readRuntimeMemory(), db.transactions.find({ $or: [{ sender: binding.userId }, { recipient: binding.userId }] }),
        db['rooms.objects'].find({ user: binding.userId }), io.readState(),
      ]);
      return { memory, transactions, objects, state };
    },
  };
  await io.assertIdentity();
  return io;
}
module.exports = { within, bounded, validateBinding, connectLocal };
