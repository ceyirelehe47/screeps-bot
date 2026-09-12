'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { performance } = require('node:perf_hooks');
const GUARD_BLOB = '796e71d9b5572014fd2ce8e9a0ee797e4e04c7a8';
const CANDIDATE_BASE = '6a63a2aff064295ef65efc8def26c9865dfd9db3';
const ORIGINAL_DIGEST = Object.freeze({algorithm:'deployGuard.computeModulesHash/NUL-v1',hash:'84f769750c3a1b5ab5b4b70d13be603ff9b6acd709aa2c0a0fb61cacd8b410bf',files:[{name:'main',kind:'text',bytes:4494463,sha256:'37d20706908220a157fc30fbf668ed98c880fdb47a34ed34b6a0302e3f11f74b'}]});
const PRODUCTION_BASE = '06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c';
const PRODUCTION_TREE = '929fa9557b1a36135a5ef1605231be1d16e87366';
const PROBE_REFACTOR_BASE = 'eb00879a1ff71275ff32e310378d3590fc910e6a';
const EXPECTED = Object.freeze({ server: 'https://screeps.com', username: 'forster', userId: '634fe406347a7b69b28aeccb', branch: 'default', shard: 'shard1' });
class Failure extends Error { constructor(code, details = {}) { super(code); this.code = code; this.details = details; } }
function fail(code, details) { throw new Failure(code, details); }
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const own = (x, k) => Object.prototype.hasOwnProperty.call(x, k);
const sha256 = x => crypto.createHash('sha256').update(x).digest('hex');
const blob = b => crypto.createHash('sha1').update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');
const clone = x => JSON.parse(JSON.stringify(x));
const pause = ms => new Promise(r => setTimeout(r, ms));
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function integer(x, lo, hi, name) { if (!Number.isSafeInteger(x) || x < lo || x > hi) fail(name || 'INVALID_INTEGER'); return x; }
function options(argv, names, flags = []) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--') || own(o, k.slice(2))) fail('INVALID_ARGUMENTS');
    if (flags.includes(k.slice(2))) o[k.slice(2)] = true;
    else if (names.includes(k.slice(2)) && argv[i + 1] && !argv[i + 1].startsWith('--')) o[k.slice(2)] = argv[++i];
    else fail('INVALID_ARGUMENTS');
  }
  return o;
}
function required(o, ...keys) { for (const k of keys) if (!o[k]) fail('MISSING_ARGUMENT'); }
// Output policy: arbitrary exception messages, stacks, HTTP bodies and headers are NEVER logged.
// Redaction is an additional barrier for console evidence, not the exception policy.
function redactor(secrets = []) {
  const needles = [...new Set(secrets.flatMap(s => typeof s === 'string' && s.length >= 8
    ? [s, encodeURIComponent(s), s.slice(0, 8)] : []).filter(Boolean))].sort((a,b) => b.length-a.length);
  return function redact(value) {
    let s = String(value);
    for (const needle of needles) s = s.split(needle).join('<REDACTED>');
    s = s.replace(/(\"(?:_?token|access_token|authorization|x-token)\"\s*:\s*\")[^\"]*/gi, '$1<REDACTED>')
      .replace(/([?&](?:_?token|access_token)=)[^\s"'<>\\&]+/gi, '$1<REDACTED>')
      .replace(/((?:x-token|authorization|access_token|token)\s*[=:]\s*["']?)[^\s"',;}]+/gi, '$1<REDACTED>')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<REDACTED-UUID>')
      .replace(/(?<![0-9a-f])[0-9a-f]{36}(?![0-9a-f])/gi, '<REDACTED-36HEX>');
    return s;
  };
}
function safeFailure(e) {
  return e instanceof Failure ? { error: e.code, ...e.details } : { error: 'UNEXPECTED_LOCAL_FAILURE' };
}
function entrypoint(fn) {
  fn().catch(e => { process.stderr.write(JSON.stringify(safeFailure(e)) + '\n'); process.exitCode = 1; });
}
function readJson(p, max = 20 * 1024 * 1024) {
  try {
    const st = fs.statSync(p); if (!st.isFile() || st.size > max) fail('FILE_INVALID_OR_TOO_LARGE');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch(e) { if (e instanceof Failure) throw e; fail('LOCAL_JSON_UNREADABLE'); }
}
function writeNew(p, data) { const b = JSON.stringify(data, null, 2) + '\n'; fs.writeFileSync(p, b, { flag:'wx', mode:0o600 }); }
// Windows refuses to rename over a destination another process holds open, and guard,
// guard-readiness, probe and parent pollers all read these files while the writer runs.
// Retry briefly; if the swap stays blocked, overwrite in place rather than lose the
// evidence — a non-atomic heartbeat is survivable, a missing one terminates the run.
function replaceOverExisting(tmp, p) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try { fs.renameSync(tmp, p); return; }
    catch(e) {
      if (e.code !== 'EPERM' && e.code !== 'EACCES' && e.code !== 'EBUSY') throw e;
      sleepSync(20 * (attempt + 1));
    }
  }
  fs.writeFileSync(p, fs.readFileSync(tmp), { mode:0o600 });
}
function atomicJson(p, data) {
  const tmp = p + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try { writeNew(tmp, data); replaceOverExisting(tmp, p); }
  finally { if (fs.existsSync(tmp)) { try { fs.unlinkSync(tmp); } catch {} } }
}
function audit(p, data, redact = redactor()) {
  fs.appendFileSync(p, redact(JSON.stringify({ at: new Date().toISOString(), ...data }))+'\n', { mode:0o600 });
}
function loadGuard(repo) {
  const p = path.resolve(repo, 'scripts/lib/deployGuard.cjs'); let b;
  try { b = fs.readFileSync(p); } catch { fail('CANONICAL_GUARD_MISSING'); }
  if (blob(b) !== GUARD_BLOB) fail('CANONICAL_GUARD_CHANGED');
  return require(p); // Canonical implementation, not a parallel hash definition.
}
function loadSecret(p) {
  const s = readJson(p, 16384)?.main;
  if (!obj(s) || typeof s.token !== 'string' || s.token.length < 16 || /[\s\r\n]/.test(s.token)) fail('CREDENTIAL_FILE_INVALID');
  if (s.hostname !== 'screeps.com' || (s.protocol !== undefined && s.protocol !== 'https')
    || (s.port !== undefined && s.port !== 443) || (s.path !== undefined && s.path !== '/')
    || s.branch !== EXPECTED.branch) fail('CREDENTIAL_TARGET_MISMATCH');
  return { token:s.token, server:EXPECTED.server, redact:redactor([s.token]) };
}
function git(repo, args) {
  try { return cp.execFileSync('git', ['-C', repo, ...args], { encoding:'utf8', timeout:10000, stdio:['ignore','pipe','pipe'] }).trim(); }
  catch { fail('GIT_CHECK_FAILED'); }
}
function assertCandidate(repo) {
  if (process.env.DEST || process.env.DEPLOY_ALLOW_DIRTY) fail('UNSAFE_BUILD_ENVIRONMENT');
  const guard = loadGuard(repo), head = git(repo, ['rev-parse','HEAD']), tree = git(repo, ['rev-parse','HEAD^{tree}']);
  const status = git(repo, ['status','--porcelain']);
  guard.assertDeployableGitState({statusOutput:status, headSha:head, currentBranch:git(repo,['branch','--show-current']), configuredBranch:EXPECTED.branch, allowDirty:false});
  if (status) fail('DIRTY_CANDIDATE');
  git(repo,['merge-base','--is-ancestor',CANDIDATE_BASE,head]);
  const changed = git(repo,['diff','--name-only',CANDIDATE_BASE,head]).split('\n').filter(Boolean);
  if (changed.some(p => p !== 'src/runtime/treasuryCompatConfig.ts')) fail('CANDIDATE_SCOPE_CHANGED');
  return {head, tree, guard};
}
function remaining(deadline, clock = () => performance.now()) { const n = Math.floor(deadline-clock()); if (n <= 0) fail('OPERATION_DEADLINE'); return n; }
async function actionLock(dir, fn, waitMs=0) {
  const p=path.join(dir,'action.lock'); const end=performance.now()+waitMs; let fd;
  while (fd === undefined) {
    try { fd=fs.openSync(p,'wx',0o600); }
    catch(e) { if(e.code!=='EEXIST') fail('ACTION_LOCK_IO'); if(performance.now()>=end) fail('ACTION_BUSY'); await pause(Math.min(100,Math.max(1,end-performance.now()))); }
  }
  try { fs.writeFileSync(fd, JSON.stringify({pid:process.pid, at:new Date().toISOString()})); return await fn(); }
  finally { fs.closeSync(fd); fs.unlinkSync(p); }
}
module.exports={Failure,fail,obj,own,sha256,blob,clone,pause,integer,options,required,redactor,safeFailure,entrypoint,readJson,writeNew,atomicJson,audit,loadGuard,loadSecret,git,assertCandidate,remaining,actionLock,EXPECTED,CANDIDATE_BASE,PRODUCTION_BASE,PRODUCTION_TREE,PROBE_REFACTOR_BASE,GUARD_BLOB,ORIGINAL_DIGEST};
