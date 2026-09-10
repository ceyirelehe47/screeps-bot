#!/usr/bin/env node
'use strict';
/**
 * 精确恢复：把 pre-deploy-originals 保存的 modules 原样回传到活动分支。
 * 守卫：
 *  - 恢复前先回读当前活动分支 modules：
 *    - 当前 == 本次启用产物（deployed.json，若提供）→ 允许覆盖恢复；
 *    - 当前 == 备份原件 → 不重复写，ALREADY_RESTORED；
 *    - 其他（第三方新产物）→ CONFLICT，拒绝覆盖，非零退出。
 *  - 恢复后强制回读比对逐模块 SHA-256 与集合摘要，不一致即 UNCONFIRMED。
 *  - 任何失败都以非零退出；绝不打印凭据。
 * 用法：node restore-modules.cjs <secretPath> <branch> <backupJson> [deployedJson] [--dry-run]
 */
const fs = require('node:fs');
const crypto = require('node:crypto');

const args = process.argv.slice(2).filter((a) => a !== '--dry-run');
const dryRun = process.argv.includes('--dry-run');
const [secretPath, branch, backupJson, deployedJson] = args;
if (!secretPath || !branch || !backupJson) {
  console.error('usage: node restore-modules.cjs <secretPath> <branch> <backupJson> [deployedJson] [--dry-run]');
  process.exit(2);
}
const { ScreepsAPI } = require('screeps-api');

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}
function digest(modules) {
  const names = Object.keys(modules).sort();
  return {
    names,
    hash: sha256(names.map((n) => `${n}:${sha256(typeof modules[n] === 'string' ? modules[n] : JSON.stringify(modules[n]))}`).join('|')),
    per: Object.fromEntries(names.map((n) => [n, sha256(typeof modules[n] === 'string' ? modules[n] : JSON.stringify(modules[n]))])),
  };
}

(async () => {
  const secret = JSON.parse(fs.readFileSync(secretPath, 'utf8'))['main'];
  const backup = JSON.parse(fs.readFileSync(backupJson, 'utf8'));
  const backupDigest = digest(backup);
  const deployedDigest = deployedJson ? digest(JSON.parse(fs.readFileSync(deployedJson, 'utf8'))) : null;

  const api = new ScreepsAPI(secret);
  const current = (await api.raw.user.code.get(branch))?.modules ?? {};
  const currentDigest = digest(current);

  const result = {
    at: new Date().toISOString(),
    branch,
    currentHash16: currentDigest.hash.slice(0, 16),
    backupHash16: backupDigest.hash.slice(0, 16),
  };

  if (currentDigest.hash === backupDigest.hash) {
    console.log(JSON.stringify({ ...result, status: 'ALREADY_RESTORED', written: false }));
    return;
  }
  if (deployedDigest && currentDigest.hash !== deployedDigest.hash) {
    console.log(JSON.stringify({
      ...result,
      status: 'CONFLICT_CURRENT_NOT_OUR_DEPLOYMENT',
      written: false,
      note: '当前活动模块既不是备份原件也不是本次启用产物，拒绝自动覆盖',
    }));
    process.exit(3);
  }
  if (!deployedDigest) {
    // 未提供启用产物身份：只有当差异能逐模块解释（集合不同）时也拒绝盲写。
    console.log(JSON.stringify({
      ...result,
      status: 'CONFLICT_NO_DEPLOYED_REFERENCE',
      written: false,
      note: '未提供本次启用产物引用，无法证明当前产物归属，拒绝覆盖',
    }));
    process.exit(3);
  }

  if (dryRun) {
    console.log(JSON.stringify({ ...result, status: 'DRY_RUN_WOULD_RESTORE', written: false }));
    return;
  }

  const resp = await api.raw.user.code.set(branch, backup);
  if (resp?.ok !== 1) {
    console.log(JSON.stringify({ ...result, status: 'RESTORE_REQUEST_FAILED', written: false, apiOk: resp?.ok }));
    process.exit(4);
  }

  // 恢复后强制回读比对
  const after = (await api.raw.user.code.get(branch))?.modules ?? {};
  const afterDigest = digest(after);
  if (afterDigest.hash !== backupDigest.hash) {
    console.log(JSON.stringify({
      ...result,
      status: 'ONLINE_CLOSE_UNCONFIRMED',
      written: true,
      afterHash16: afterDigest.hash.slice(0, 16),
      note: '恢复请求已发送但回读不一致',
    }));
    process.exit(5);
  }
  console.log(JSON.stringify({
    ...result,
    status: 'RESTORED_AND_VERIFIED',
    written: true,
    afterHash16: afterDigest.hash.slice(0, 16),
    moduleNames: afterDigest.names,
  }));
})().catch((e) => {
  console.error('restore failed:', String(e.message || e).slice(0, 200));
  process.exit(1);
});
