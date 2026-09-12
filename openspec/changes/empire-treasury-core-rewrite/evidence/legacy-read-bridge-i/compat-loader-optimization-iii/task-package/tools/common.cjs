'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const blob = b => crypto.createHash('sha1').update(Buffer.from('blob ' + b.length + '\0')).update(b).digest('hex');
function fail(code, detail) { const e = new Error(code); e.code = code; if (detail !== undefined) e.detail = detail; throw e; }
function check(ok, code, detail) { if (!ok) fail(code, detail); }
function list(root, prefix = '') { const out = []; for (const e of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
  const n = prefix ? prefix + '/' + e.name : e.name; check(!e.isSymbolicLink(), 'SYMLINK_REFUSED', n);
  if (e.isDirectory()) out.push(...list(root, n)); else { check(e.isFile(), 'SPECIAL_FILE_REFUSED', n); out.push(n); }
} return out.sort(); }
const json = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const encode = x => Buffer.from(JSON.stringify(x, null, 2) + '\n');
function writeNew(p, b) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.isBuffer(b) ? b : encode(b), { flag: 'wx' }); }
function real(p) { const a = path.resolve(p); if (fs.existsSync(a)) return fs.realpathSync(a); return path.join(real(path.dirname(a)), path.basename(a)); }
function outside(p, roots) { const a = real(p); for (const r of roots.filter(Boolean)) { const rel = path.relative(real(r), a); check(rel && (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)), 'OUTPUT_INSIDE_REPOSITORY'); } return a; }
function newOutput(p, roots = [ROOT]) { const a = outside(p, roots); check(!fs.existsSync(a), 'OUTPUT_ALREADY_EXISTS'); fs.mkdirSync(a, { recursive: true }); return a; }
function safePath(root, n) { check(typeof n === 'string' && !path.isAbsolute(n) && n.split('/').every(x => x && x !== '.' && x !== '..') && !n.includes('\\'), 'INVALID_RELATIVE_PATH');
  let p = root; for (const seg of n.split('/')) { p = path.join(p, seg); if (fs.existsSync(p)) check(!fs.lstatSync(p).isSymbolicLink(), 'SYMLINK_REFUSED'); } return p; }
function runGit(repo, args, opts = {}) {
  return cp.spawnSync('git', ['-C', path.resolve(repo), ...args], {
    encoding: null, maxBuffer: 64 * 1024 * 1024, timeout: 120000, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...opts });
}
function git(repo, args, opts) { const r = runGit(repo, args, opts); check(r.status === 0 && !r.error, 'GIT_COMMAND_FAILED', { command: args[0], exit: r.status, error: r.error?.code || null }); return r.stdout; }
const gt = (r, a) => git(r, a).toString('utf8').trim();
function status(repo) { return gt(repo, ['status', '--porcelain', '--untracked-files=all']); }
function clean(repo) { check(!status(repo), 'WORKTREE_NOT_CLEAN'); }
function pathList(b) { return b.toString('utf8').split('\0').filter(Boolean).sort(); }
function packet(b) { const bytes = Buffer.isBuffer(b) ? b : Buffer.from(b || ''); const text = bytes.toString('utf8');
  check(Buffer.from(text).equals(bytes), 'NON_UTF8_OUTPUT'); return { encoding: 'utf8', bytes: bytes.length, sha256: sha(bytes), text }; }
function validatePacket(p) { check(p?.encoding === 'utf8' && typeof p.text === 'string', 'OUTPUT_PACKET_INVALID'); const b = Buffer.from(p.text); check(b.length === p.bytes && sha(b) === p.sha256, 'OUTPUT_PACKET_CHANGED'); return p.text; }
function inventory(root) { return Object.fromEntries(list(root).map(n => { const b = fs.readFileSync(safePath(root, n)); return [n, { bytes: b.length, sha256: sha(b) }]; })); }
function verifyInventory(root, expected, excluded = []) {
  const actual = list(root).filter(n => !excluded.includes(n)); check(JSON.stringify(actual) === JSON.stringify(Object.keys(expected).sort()), 'FILE_SET_MISMATCH');
  for (const n of actual) { const b = fs.readFileSync(safePath(root, n)); check(b.length === expected[n].bytes && sha(b) === expected[n].sha256, 'FILE_BYTES_MISMATCH', n); }
}
function integrity(root = ROOT) { const m = json(path.join(root, 'INTEGRITY.json')); verifyInventory(root, m.files, ['INTEGRITY.json']); return { status: 'PACKAGE_INTEGRITY_VERIFIED', files: Object.keys(m.files).length }; }
function environment(modulePath) { const e = { ...process.env }; for (const k of Object.keys(e)) if (['DEST', 'DEPLOY_ALLOW_DIRTY', 'NODE_OPTIONS', 'NODE_PATH'].includes(k) || k.startsWith('SCREEPS_') || k.startsWith('CPU_DIAG_')) delete e[k];
  if (modulePath) e.NODE_PATH = modulePath; return e; }
function capture(out, name, args, options = {}) {
  const r = cp.spawnSync(process.execPath, args, { encoding: null, timeout: 900000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: environment(), ...options });
  const record = { command: args, exit: r.status, signal: r.signal || null, error: r.error?.code || null, stdout: packet(r.stdout || ''), stderr: packet(r.stderr || '') };
  writeNew(path.join(out, name + '.json'), record); check(r.status === 0 && !r.error && !r.signal, 'CHILD_CHECK_FAILED', { name, exit: r.status, error: record.error }); return record;
}
function tap(text, total) { const s = text.replace(/\r\n/g, '\n'); const counts = {};
  for (const n of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) { const m = [...s.matchAll(new RegExp('^# ' + n + ' (\\d+)$', 'gm'))]; check(m.length === 1, 'AMBIGUOUS_TEST_TOTAL', n); counts[n] = +m[0][1]; }
  check(counts.tests === total && counts.pass === total && ['fail', 'cancelled', 'skipped', 'todo'].every(n => counts[n] === 0), 'TEST_TOTAL_MISMATCH', counts); return counts;
}
module.exports = { fs, path, cp, ROOT, sha, blob, fail, check, list, json, encode, writeNew, real, outside, newOutput, safePath, git, gt, runGit, status, clean, pathList, packet, validatePacket, inventory, verifyInventory, integrity, environment, capture, tap };
