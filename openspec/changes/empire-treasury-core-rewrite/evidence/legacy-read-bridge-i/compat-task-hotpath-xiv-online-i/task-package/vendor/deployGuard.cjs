// 部署守卫（阶段 B）：构建身份采集、脏工作树拒绝、bundle 内容哈希与上传回读比对。
//
// 背景：2026-08-24 的失真（lastDeployTag=2026.8.24-3+907f837 但线上内容=6fc4bf2）
// 根因是"先构建 push、后提交"的工作流：buildGitHash 取 HEAD 引用（纯 docs 提交
// 907f837），而 version 与编译内容来自 dirty working tree（6fc4bf2 的未提交内容，
// package.json 已手改为 2026.8.24-3）。本模块把"可部署的 git 状态"与"内容身份"
// 变成显式契约：生产 push 要求 clean tree + 可解析 HEAD + 明确的目标 branch，
// 上传后回读远端 modules 做哈希比对。
//
// 纯函数库：rollup.config.js（ESM）与 Jest 测试共用，不直接执行 git 命令
// （命令执行由调用方注入，便于测试）。
const { createHash } = require("node:crypto");

const DEPLOY_GUARD_ERROR = "DEPLOY_GUARD";

/** 解析 `git status --porcelain` 输出。untracked 文件计入 dirty（可能被 rollup 编译进产物）。 */
function parseGitStatusPorcelain(output) {
  const entries = String(output ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
  return {
    entries,
    dirty: entries.length > 0,
    staged: entries.some((line) => line[0] !== " " && line[0] !== "?"),
    untracked: entries.some((line) => line.startsWith("??")),
  };
}

/**
 * 生产部署前置检查。
 *
 * @param {object} input
 * @param {string} input.statusOutput `git status --porcelain` 原始输出
 * @param {string} input.headSha `git rev-parse HEAD`（空 = 无法解析）
 * @param {string} input.currentBranch `git branch --show-current`（空 = detached）
 * @param {string} input.configuredBranch .secret.json 的 branch（可为 "auto"）
 * @param {boolean} input.allowDirty 显式开发 override（DEPLOY_ALLOW_DIRTY=1）
 * @returns {{ branch: string, dirty: boolean, status: ReturnType<parseGitStatusPorcelain> }}
 */
function assertDeployableGitState({ statusOutput, headSha, currentBranch, configuredBranch, allowDirty }) {
  const status = parseGitStatusPorcelain(statusOutput);
  const errors = [];

  if (!headSha) {
    errors.push("HEAD cannot be resolved (git rev-parse HEAD returned nothing)");
  }
  if (status.dirty && !allowDirty) {
    errors.push(
      `working tree is dirty (${status.entries.length} uncommitted/untracked entries; ` +
        "commit them or use DEST:local; production canary must deploy from a clean tree)",
    );
  }

  let branch = configuredBranch;
  if (configuredBranch === "auto") {
    if (!currentBranch) {
      errors.push(
        "detached HEAD or ambiguous branch mapping: cannot determine target Screeps branch (branch=auto)",
      );
    } else {
      branch = currentBranch;
    }
  }

  if (errors.length > 0) {
    const error = new Error(`deploy guard rejected the build:\n  - ${errors.join("\n  - ")}`);
    error.code = DEPLOY_GUARD_ERROR;
    error.errors = errors;
    throw error;
  }

  return { branch: branch || "default", dirty: status.dirty };
}

/**
 * 计算 modules 内容哈希（本地组装与远端回读使用同一规范化，哈希即可比对）：
 * module 名排序后逐个以 NUL 分隔写入 key 与内容；binary module 写 "bin:" 前缀 + base64。
 * @param {Record<string, string | { binary: string }>} modules
 * @returns {string} hex SHA-256
 */
function computeModulesHash(modules) {
  const hash = createHash("sha256");
  for (const key of Object.keys(modules).sort()) {
    const value = modules[key];
    hash.update(key);
    hash.update("\0");
    if (typeof value === "string") {
      hash.update(value);
    } else if (value && typeof value.binary === "string") {
      hash.update("bin:");
      hash.update(value.binary);
    } else {
      hash.update(JSON.stringify(value ?? null));
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** 上传后回读比对：返回一致性与逐 module 差异（不抛错，由调用方决定退出码）。 */
function diffRemoteModules(localModules, remoteModules) {
  const localKeys = new Set(Object.keys(localModules));
  const remoteKeys = new Set(Object.keys(remoteModules ?? {}));
  const missing = [...localKeys].filter((key) => !remoteKeys.has(key));
  const extra = [...remoteKeys].filter((key) => !localKeys.has(key));
  const changed = [...localKeys]
    .filter((key) => remoteKeys.has(key))
    .filter((key) => {
      const local = localModules[key];
      const remote = remoteModules[key];
      if (typeof local === "string" && typeof remote === "string") {
        return local !== remote;
      }
      return JSON.stringify(local) !== JSON.stringify(remote);
    });
  const localHash = computeModulesHash(localModules);
  const remoteHash = remoteModules ? computeModulesHash(remoteModules) : null;
  return {
    match: remoteHash === localHash,
    localHash,
    remoteHash,
    missing,
    extra,
    changed,
  };
}

module.exports = { DEPLOY_GUARD_ERROR, parseGitStatusPorcelain, assertDeployableGitState, computeModulesHash, diffRemoteModules };
