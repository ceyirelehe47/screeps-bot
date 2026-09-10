#!/usr/bin/env node
'use strict';
/**
 * 线上前检（只读）：账号身份 / 活动分支 / 当前活动 modules。
 * - 凭据只从主仓库 .secret.json 进程内读取；token 不进命令行、不出 stdout。
 * - 输出仅脱敏摘要；完整 modules 原件写入受控本地目录（工作树外）。
 * 用法：node preflight-read.cjs <secretPath> <outDir>
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const [secretPath, outDir] = process.argv.slice(2);
if (!secretPath || !outDir) {
  console.error('usage: node preflight-read.cjs <secretPath> <outDir>');
  process.exit(2);
}
const secret = JSON.parse(fs.readFileSync(secretPath, 'utf8'))['main'];
const { ScreepsAPI } = require('screeps-api');

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// 与仓库 scripts/lib/deployGuard.cjs 相同的规范化集合摘要口径：
// 逐模块 sha256 后按名字典序拼接再整体 sha256。
function computeModulesHash(modules) {
  const names = Object.keys(modules).sort();
  const parts = names.map((n) => `${n}:${sha256(typeof modules[n] === 'string' ? modules[n] : JSON.stringify(modules[n]))}`);
  return { names, hash: sha256(parts.join('|')) };
}

(async () => {
  const api = new ScreepsAPI(secret);
  const requestedAt = new Date().toISOString();

  // 1) token 限流状态（只输出脱敏字段）
  let tokenState = {};
  try {
    const qt = await api.raw.auth.queryToken(secret.token);
    tokenState = {
      ok: qt?.ok,
      limited: qt?.token?.limited,
    };
  } catch (e) {
    tokenState = { error: String(e.message || e).slice(0, 120) };
  }

  // 2) 账号身份
  const me = await api.me();
  const account = {
    _id: me?._id,
    username: me?.username,
    badge: typeof me?.badge === 'object' ? 'present' : 'absent',
  };

  // 3) 活动分支
  const branches = await api.raw.user.branches();
  const active = branches?.list?.filter((b) => b.activeBranch) ?? [];
  const branchList = (branches?.list ?? []).map((b) => ({
    branch: b.branch,
    activeBranch: b.activeBranch,
    lastUsed: b.lastUsed,
  }));

  const activeBranchName = active[0]?.branch;

  // 4) 活动分支 modules（精确恢复原件）
  const code = await api.raw.user.code.get(activeBranchName);
  const modules = code?.modules ?? {};
  const files = Object.keys(modules).sort().map((name) => {
    const v = modules[name];
    const text = typeof v === 'string' ? v : Buffer.from(v.binary, 'base64');
    return {
      name,
      kind: typeof v === 'string' ? 'text' : 'binary',
      bytes: Buffer.byteLength(text),
      sha256: crypto.createHash('sha256').update(text).digest('hex'),
    };
  });
  const collection = computeModulesHash(modules);

  // 内嵌 bundle 摘要（若存在）
  let embeddedBundle;
  const mainText = typeof modules.main === 'string' ? modules.main : '';
  const m = mainText.match(/__DEPLOY_BUNDLE_HASH__\s*=\s*"([0-9a-f]{64})"/);
  if (m) embeddedBundle = m[1];
  const tagMatch = mainText.match(/__BUILD_TAG__|buildTag/);

  // 保存完整原件到受控目录（含原始 JSON）
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'pre-deploy-modules.json'), JSON.stringify(modules, null, 1));
  const manifest = {
    requestedAt,
    server: `${secret.protocol}://${secret.hostname}${secret.path}`,
    tokenState,
    account,
    activeBranch: activeBranchName,
    branchList,
    modules: { files, collectionHash: collection.hash, moduleNames: collection.names },
    embeddedBundleHash: embeddedBundle ?? null,
    embeddedBuildTagPresent: Boolean(tagMatch),
  };
  fs.writeFileSync(path.join(outDir, 'pre-deploy-identity.json'), JSON.stringify(manifest, null, 1));

  // stdout 只输出脱敏摘要（无 token、无完整代码）
  console.log(JSON.stringify({
    requestedAt,
    server: `${secret.protocol}://${secret.hostname}`,
    tokenState,
    accountUsername: account.username,
    activeBranch: activeBranchName,
    branchNames: branchList.map((b) => b.branch),
    moduleNames: collection.names,
    collectionHash16: collection.hash.slice(0, 16),
    embeddedBundleHash16: embeddedBundle ? embeddedBundle.slice(0, 16) : null,
    perModule: files.map((f) => ({ name: f.name, kind: f.kind, bytes: f.bytes, sha16: f.sha256.slice(0, 16) })),
  }, null, 1));
})().catch((e) => {
  console.error('preflight failed:', String(e.message || e).slice(0, 200));
  process.exit(1);
});
