'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const blob = b => crypto.createHash('sha1').update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');
function fail(code, detail) { const e = new Error(code); e.code = code; e.detail = detail; throw e; }
function eq(a, b, code = 'VALUE_MISMATCH') { if (JSON.stringify(a) !== JSON.stringify(b)) fail(code); }
function rel(n) { if (typeof n !== 'string' || !n || /[\\:\x00-\x1f]/.test(n) || path.isAbsolute(n) || n.split('/').some(s => !s || s === '.' || s === '..')) fail('UNSAFE_PATH'); return n; }
function safe(root, n = '') {
  const base = path.resolve(root); if (fs.lstatSync(base).isSymbolicLink()) fail('SYMLINK_FORBIDDEN');
  let p = base;
  if (n) for (const part of rel(n).split('/')) { p = path.join(p, part); if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) fail('SYMLINK_FORBIDDEN'); }
  return p;
}
function files(root, prefix = '') {
  const list = [];
  for (const e of fs.readdirSync(safe(root, prefix), { withFileTypes: true })) {
    const n = prefix ? prefix + '/' + e.name : e.name; rel(n);
    if (e.isSymbolicLink()) fail('SYMLINK_FORBIDDEN');
    if (e.isDirectory()) list.push(...files(root, n)); else if (e.isFile()) list.push(n); else fail('SPECIAL_FILE_FORBIDDEN');
  }
  return list.sort();
}
function json(b, code = 'JSON_INVALID') { try { return JSON.parse(Buffer.isBuffer(b) ? b.toString('utf8') : b); } catch { fail(code); } }
function read(p) { return json(fs.readFileSync(p)); }
const encoded = x => Buffer.from(JSON.stringify(x, null, 2) + '\n');
function put(p, x) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.isBuffer(x) ? x : typeof x === 'string' ? x : encoded(x), { flag: 'wx' }); }
function external(dir, roots) {
  if (!dir) fail('OUTPUT_REQUIRED'); const dest = path.resolve(dir);
  for (const root of [...roots, ROOT]) {
    const r = path.relative(path.resolve(root), dest);
    if (!r || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r))) fail('OUTPUT_MUST_BE_EXTERNAL');
  }
  let p = dest;
  while (true) { if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) fail('SYMLINK_FORBIDDEN'); const parent = path.dirname(p); if (p === parent) break; p = parent; }
  if (fs.existsSync(dest)) fail('OUTPUT_ALREADY_EXISTS'); return dest;
}
function env() {
  const e = { ...process.env, LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  // Never replace global/system configuration, identity, signing, or hooks.
  // Only prevent accidentally targeting a different index/worktree from the shell.
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) delete e[k];
  return e;
}
function gitResult(repo, args, input) {
  const r = cp.spawnSync('git', ['-C', path.resolve(repo), ...args], { input, encoding: null, env: env(), maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  if (r.error || r.signal || r.status === null) fail('GIT_EXECUTION_FAILED', { code: r.error?.code || null, signal: r.signal || null });
  return { code: r.status, stdout: r.stdout || Buffer.alloc(0), stderr: r.stderr || Buffer.alloc(0) };
}
function git(repo, args, input) { const r = gitResult(repo, args, input); if (r.code !== 0) fail('GIT_FAILED', { command: args[0], exit: r.code, stderr: r.stderr.toString('utf8').slice(0, 1000) }); return r.stdout; }
const text = (r, a) => git(r, a).toString('utf8').trim();
const split0 = b => b.toString('utf8').split('\0').filter(Boolean);
function cat(repo, ids) {
  const unique = [...new Set(ids)]; if (unique.some(x => !/^[0-9a-f]{40}$/.test(x))) fail('GIT_OID_INVALID');
  if (!unique.length) return new Map();
  const output = git(repo, ['cat-file', '--batch'], Buffer.from(unique.join('\n') + '\n')); const result = new Map(); let offset = 0;
  for (const id of unique) {
    const end = output.indexOf(10, offset); if (end < 0) fail('BATCH_FRAMING_INVALID');
    const header = output.subarray(offset, end).toString('ascii'); const match = /^([0-9a-f]{40}) blob ([0-9]+)$/.exec(header);
    if (!match || match[1] !== id) fail('BATCH_OBJECT_INVALID');
    const size = Number(match[2]), start = end + 1, bytes = output.subarray(start, start + size);
    if (!Number.isSafeInteger(size) || size < 0 || bytes.length !== size || output[start + size] !== 10 || blob(bytes) !== id) fail('BATCH_BYTES_INVALID');
    result.set(id, bytes); offset = start + size + 1;
  }
  if (offset !== output.length) fail('BATCH_TRAILING_BYTES'); return result;
}
function identity(b) { return { bytes: b.length, sha256: sha(b) }; }
function verifyBytes(b, expected, code) { if (!expected || b.length !== expected.bytes || sha(b) !== expected.sha256) fail(code); }
function fingerprint(map) { return sha(encoded([...map].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([n, b]) => [n, b.length, sha(b)]))); }
function integrity(root = ROOT) {
  const manifest = read(safe(root, 'INTEGRITY.json')); const actual = files(root).filter(n => n !== 'INTEGRITY.json');
  eq(actual, Object.keys(manifest.files).sort(), 'PACKAGE_FILE_SET_MISMATCH');
  for (const n of actual) verifyBytes(fs.readFileSync(safe(root, n)), manifest.files[n], 'PACKAGE_BYTES_MISMATCH');
  return { status: 'CLOSEOUT_PACKAGE_INTEGRITY_VERIFIED', files: actual.length, fingerprint: sha(fs.readFileSync(safe(root, 'INTEGRITY.json'))) };
}
module.exports = { fs, path, cp, ROOT, sha, blob, fail, eq, rel, safe, files, json, read, encoded, put, external, env, gitResult, git, text, split0, cat, identity, verifyBytes, fingerprint, integrity };
