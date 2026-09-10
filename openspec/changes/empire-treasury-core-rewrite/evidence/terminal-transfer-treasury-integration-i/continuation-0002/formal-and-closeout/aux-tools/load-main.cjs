#!/usr/bin/env node
'use strict';
// Lab-only admin loader: install ONE main module for the synthetic lab user in
// the isolated standalone world, through the installed storage adapter.
// It does not touch the game runtime, does not publish, and does not read or
// write any credential. Usage:
//   node load-main.cjs <serverRoot> <storageHost> <storagePort> <userId> <bundleDir> <branch>
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');

const [serverRoot, host, port, userId, bundleDir, branch] = process.argv.slice(2);
if (!serverRoot || !host || !port || !userId || !bundleDir || !branch) {
  console.error('usage: load-main.cjs <serverRoot> <host> <port> <userId> <bundleDir> <branch>');
  process.exit(2);
}
const code = fs.readFileSync(path.join(bundleDir, 'main.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8'));
if (manifest.enabled !== true || manifest.mode !== 'treasury-integration') {
  console.error('refusing: manifest is not the enabled treasury-integration build');
  process.exit(1);
}
process.env.STORAGE_HOST = host;
process.env.STORAGE_PORT = String(port);
const localRequire = createRequire(path.join(serverRoot, 'package.json'));
const common = localRequire('@screeps/common');

(async () => {
  await common.storage._connect();
  const db = common.storage.db;
  const user = await db.users.findOne({ _id: userId });
  if (!user) throw new Error('synthetic user not found');
  const timestamp = Date.now();
  const result = await db['users.code'].update({ user: userId }, {
    $set: { modules: { main: code }, branch, activeWorld: true, timestamp },
  });
  const readback = await db['users.code'].findOne({ user: userId, activeWorld: true });
  const sha256 = createHash('sha256').update(readback.modules.main).digest('hex');
  console.log(JSON.stringify({
    kind: 'lab-main-load', userId, username: user.username, branch: readback.branch, timestamp,
    modules: Object.keys(readback.modules), units: readback.modules.main.length,
    sha256, expectedSha256: createHash('sha256').update(code).digest('hex'),
    bytes: Buffer.byteLength(readback.modules.main, 'utf8'),
    manifestSha256: manifest.output.sha256, manifestCommit: manifest.repoSourceCommit,
    modified: result && result.modified,
  }, null, 2));
})().catch(error => { console.error(String(error)); process.exit(1); });
