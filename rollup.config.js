import clear from "rollup-plugin-clear";
import screeps from "rollup-plugin-screeps";
import copy from "rollup-plugin-copy";
import typescript from "rollup-plugin-typescript2";
import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import replace from "@rollup/plugin-replace";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertDeployableGitState, diffRemoteModules } from "./scripts/lib/deployGuard.cjs";

const require = createRequire(import.meta.url);
const packageJson = require("./package.json");
const screepsPluginRequire = createRequire(require.resolve("rollup-plugin-screeps/package.json"));
const { ScreepsAPI } = screepsPluginRequire("screeps-api");

function run(command, fallback) {
  try {
    return execSync(command, { encoding: "utf8" }).trim();
  } catch {
    return fallback;
  }
}

// ─── 构建身份（阶段 B）────────────────────────────────────────────────────────
// buildGitHash 取 HEAD 引用，而编译输入是 working tree 文件——两者在"先构建
// push、后提交"的工作流下必然失真（2026-08-24 的 907f837/6fc4bf2 事件）。
// 因此生产 push（DEST:main）先经 deploy guard：clean tree + 可解析 HEAD +
// 明确目标 branch 三者缺一即拒绝（DEPLOY_ALLOW_DIRTY=1 为显式开发 override，
// 生产 Canary 禁用）；同时嵌入 commit/tree SHA 与 dirty 标志，上传后回读
// 远端 modules 做内容比对，成功不再只依赖 API 返回 ok。

const buildVersion = packageJson.version || "0.0.0";
const buildCommit = run("git rev-parse HEAD", "");
const buildGitHash = buildCommit ? buildCommit.slice(0, 7) : "nogit";
// Windows shell 会把 ^ 当转义符吃掉，tree 复合引用必须加引号。
const buildTree = run('git rev-parse "HEAD^{tree}"', "");
const buildBranch = run("git branch --show-current", "");
const gitStatusOutput = run("git status --porcelain", "");
const buildTime = new Date().toISOString();

let config;
if (!process.env.DEST) {
  console.log("No deployment target set. Build only.");
} else {
  const secret = require("./.secret.json");
  config = secret[process.env.DEST];
  if (!config) {
    throw new Error("Invalid DEST. Use DEST:main or DEST:local.");
  }
}

const isProductionDeploy = process.env.DEST === "main";
const allowDirty = process.env.DEPLOY_ALLOW_DIRTY === "1";

// 生产部署前置检查：默认拒绝脏树 / 无法解析 HEAD / branch 映射不明确。
// build-only 与 DEST:local 不走守卫（开发迭代允许 dirty），但身份中的
// dirty 标志始终如实记录。
const deployGuardResult = isProductionDeploy
  ? assertDeployableGitState({
      statusOutput: gitStatusOutput,
      headSha: buildCommit,
      currentBranch: buildBranch,
      configuredBranch: config?.branch ?? "default",
      allowDirty,
    })
  : null;

const buildDirty = gitStatusOutput.length > 0;
const configuredDeployBranch = config?.branch === "auto" || !config?.branch ? buildBranch || "default" : config.branch;
const deployBranch = deployGuardResult?.branch ?? configuredDeployBranch;

if (buildDirty && !isProductionDeploy) {
  console.warn("[deploy-guard] warning: building from a dirty working tree; embedded identity is not a committed state.");
}
if (buildDirty && isProductionDeploy) {
  console.warn("[deploy-guard] DEPLOY_ALLOW_DIRTY=1 override active: production identity will report dirty=true. Never use this for canary or production releases.");
}

const buildTag = `${buildVersion}+${buildGitHash}@${buildTime}`;

function createAwaitedScreepsPlugin(deployConfig) {
  // rollup-plugin-screeps@1.0.1 does not return its upload Promise from
  // writeBundle. Keep its source-map handling, but perform and await the
  // upload here so `npm run push` cannot report success before the API does.
  const sourceMapPlugin = screeps({ config: deployConfig, dryRun: true });
  return {
    ...sourceMapPlugin,
    async writeBundle(options, bundle) {
      await sourceMapPlugin.writeBundle.call(this, options, bundle);

      // 构建身份：对主产物（append 前）计算 SHA-256 并以全局赋值追加到
      // bundle 末尾——模块加载完成后 announceDeploy 首 tick 即可读取，
      // 与本地/远端的内容比对使用同一份最终文本。
      const mainOutputPath = options.file;
      const mainContent = readFileSync(mainOutputPath, "utf8");
      const bundleHash = createHash("sha256").update(mainContent).digest("hex");
      writeFileSync(
        mainOutputPath,
        `${mainContent}\n;globalThis.__DEPLOY_BUNDLE_HASH__=${JSON.stringify(bundleHash)};\n`,
      );
      console.log(`[deploy] bundle sha256: ${bundleHash.slice(0, 16)}… (full in Memory.runtime.lastDeployBundleHash)`);

      if (!deployConfig) {
        return;
      }

      const outputDirectory = path.dirname(options.file);
      const modules = {};
      for (const file of readdirSync(outputDirectory)) {
        const absolutePath = path.join(outputDirectory, file);
        // Keep source maps locally, but do not count the generated map module
        // against Screeps' 5 MB code upload limit.
        if (file.endsWith(".map.js")) {
          continue;
        }
        if (file.endsWith(".js")) {
          modules[file.replace(/\.js$/i, "")] = readFileSync(absolutePath, "utf8");
        } else if (file.endsWith(".wasm")) {
          modules[file] = { binary: readFileSync(absolutePath).toString("base64") };
        }
      }

      if (Object.keys(modules).length === 0) {
        throw new Error("Screeps upload failed: no runtime modules were generated");
      }
      const api = new ScreepsAPI(deployConfig);
      if (!deployConfig.token) {
        await api.auth();
      }
      const branch = deployGuardResult
        ? deployGuardResult.branch
        : deployConfig.branch === "auto"
          ? run("git branch --show-current", "default")
          : deployConfig.branch || "default";
      const branches = await api.raw.user.branches();
      const response = branches.list.some((entry) => entry.branch === branch)
        ? await api.code.set(branch, modules)
        : await api.raw.user.cloneBranch("", branch, modules);
      if (response?.ok !== 1) {
        throw new Error(`Screeps upload failed: ${JSON.stringify(response)}`);
      }
      console.log(
        `Uploaded ${Object.keys(modules).length} module(s) to Screeps branch ${branch}.`,
      );

      // 上传后回读验证：API 返回 ok 不代表远端内容与本地一致（版本失真
      // 事件的监控盲区）。用同一规范化方法重算 modules 哈希比对，不一致
      // 即非零退出；diff 明细不含任何凭据。
      const remote = await api.raw.user.code.get(branch);
      const verification = diffRemoteModules(modules, remote?.modules);
      if (!verification.match) {
        const detail = [
          verification.missing.length > 0 ? `missing on remote: ${verification.missing.join(", ")}` : null,
          verification.extra.length > 0 ? `unexpected on remote: ${verification.extra.join(", ")}` : null,
          verification.changed.length > 0 ? `content differs: ${verification.changed.join(", ")}` : null,
        ]
          .filter(Boolean)
          .join("; ");
        throw new Error(
          `Screeps upload verification FAILED for branch ${branch}: local sha256 ${verification.localHash.slice(0, 16)}… != remote ${String(verification.remoteHash ?? "none").slice(0, 16)}… (${detail || "module set mismatch"})`,
        );
      }
      console.log(`[deploy] upload verified: remote modules sha256 ${verification.localHash.slice(0, 16)}… matches local.`);
    },
  };
}

const deployPlugin =
  config && config.copyPath
    ? copy({
        targets: [
          {
            src: "dist/main.js",
            dest: config.copyPath,
          },
          {
            src: "dist/main.js.map",
            dest: config.copyPath,
            rename: (name) => `${name}.map.js`,
            transform: (contents) => `module.exports = ${contents.toString()};`,
          },
        ],
        hook: "writeBundle",
        verbose: true,
      })
    : createAwaitedScreepsPlugin(config);

export default {
  input: "src/main.ts",
  output: {
    file: "dist/main.js",
    format: "cjs",
    sourcemap: true,
  },
  plugins: [
    clear({ targets: ["dist"] }),
    resolve(),
    typescript({ tsconfig: "./tsconfig.build.json" }),
    replace({
      preventAssignment: true,
      values: {
        __BUILD_VERSION__: JSON.stringify(buildVersion),
        __BUILD_GIT_HASH__: JSON.stringify(buildGitHash),
        __BUILD_TIME__: JSON.stringify(buildTime),
        __BUILD_TAG__: JSON.stringify(buildTag),
        __BUILD_COMMIT__: JSON.stringify(buildCommit || "nogit"),
        __BUILD_TREE__: JSON.stringify(buildTree || "nogit"),
        __BUILD_BRANCH__: JSON.stringify(buildBranch || "detached"),
        __BUILD_DIRTY__: JSON.stringify(buildDirty ? "true" : "false"),
        __BUILD_DEPLOY_BRANCH__: JSON.stringify(deployBranch),
      },
    }),
    commonjs(),
    deployPlugin,
  ],
};
