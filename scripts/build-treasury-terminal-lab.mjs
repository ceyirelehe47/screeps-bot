#!/usr/bin/env node
/**
 * Terminal Transfer Engine Lab Prep I——实验包本地构建入口（任务书 §4.5）。
 *
 * - 默认构建 observer（只读入口）；显式 `--mode single-shot` 只生成未武装
 *   调用版。两种产物均为 Screeps 可装载的 CJS（导出 loop）。
 * - 仅使用仓库现有 TypeScript/Rollup 依赖，**不加载根 rollup 配置及部署
 *   插件**；不读取凭证、不提供上传参数、不回退 DEST 配置；构建过程不
 *   安装/启动引擎、不进行网络请求。
 * - 输出到显式指定的独立目录（--out，必填）：不覆盖 dist/main.js、生产
 *   构建、源码或任何已有非空目录；失败非零退出。从仓库外（含空格路径）
 *   执行也可定位自己的仓库与依赖（repo 根从脚本路径向上解析）。
 * - 同时输出产物清单 manifest.json，状态固定 **PREPARED_NOT_RUN**。
 *
 * 用法：
 *   node scripts/build-treasury-terminal-lab.mjs --out <dir> [--mode observer|single-shot]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { rollup } from "rollup";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const rollupPackageInfo = require("rollup/package.json");

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const USAGE = [
  "用法：node scripts/build-treasury-terminal-lab.mjs --out <dir> [--mode observer|single-shot]",
  "  --out <dir>     输出目录（必填；须不存在或为空，且不得位于 dist/源码之内）",
  "  --mode <name>   observer（默认，只读）或 single-shot（未武装调用版）",
  "  --help          打印本说明",
].join("\n");

function fail(message) {
  process.stderr.write(`[build-treasury-terminal-lab] 失败：${message}\n`);
  process.exit(1);
}

function resolveRepoRoot(startDir) {
  let current = startDir;
  for (;;) {
    if (fs.existsSync(path.join(current, "package.json")) && fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  fail(`无法定位仓库根（${startDir} 起未找到同时包含 package.json 与 .git 的祖先目录）`);
  return undefined;
}

const REPO_ROOT = resolveRepoRoot(path.dirname(SCRIPT_PATH));
const LAB_DIR = path.join(REPO_ROOT, "test", "lab", "terminal-transfer");
const ENTRIES = { observer: "observer.ts", "single-shot": "singleShot.ts" };
/** 固定参考基准（读取过的源码 SHA，不是已实跑的安装组合；任务书 §5）。 */
const REFERENCE_SHAS = {
  engine: "80977824199a596d174d392fd0cf8c458c21fcbd",
  driver: "cf63d8adf902663e2ebddd7f8c5b7baa425dc928",
};

// ── 参数解析 ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const parsed = { mode: "observer", out: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      parsed.help = true;
    } else if (token === "--mode") {
      const value = argv[index + 1];
      if (value === undefined) fail("--mode 需要一个值（observer|single-shot）");
      if (value !== "observer" && value !== "single-shot") fail(`未知模式：${value}（仅支持 observer|single-shot）`);
      parsed.mode = value;
      index += 1;
    } else if (token === "--out") {
      const value = argv[index + 1];
      if (value === undefined) fail("--out 需要一个输出目录路径");
      parsed.out = value;
      index += 1;
    } else {
      fail(`未知参数：${token}\n${USAGE}`);
    }
  }
  return parsed;
}

// ── 输出目录校验（不覆盖任何已有内容） ─────────────────────────────────────

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function validateOutDirectory(rawOut) {
  const resolved = path.resolve(process.cwd(), rawOut);
  const relativeToRepo = toPosix(path.relative(REPO_ROOT, resolved));
  if (relativeToRepo === "" || relativeToRepo === ".." || relativeToRepo.startsWith("../")) {
    return { resolved, guarded: false }; // 仓库外任意位置允许
  }
  const guardedPrefixes = ["dist", "src", "test/lab/terminal-transfer", "scripts"];
  if (guardedPrefixes.some((prefix) => relativeToRepo === prefix || relativeToRepo.startsWith(`${prefix}/`))) {
    fail(`输出目录不得位于受保护路径之内：${relativeToRepo}（dist/生产源码/实验源码/scripts）`);
  }
  return { resolved, guarded: false };
}

function ensureEmptyOutputDirectory(resolved) {
  if (fs.existsSync(resolved)) {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) fail(`输出路径已存在且不是目录：${resolved}`);
    const entries = fs.readdirSync(resolved);
    if (entries.length > 0) fail(`输出目录已存在且非空（不覆盖已有内容）：${resolved}`);
  } else {
    fs.mkdirSync(resolved, { recursive: true });
  }
}

// ── 构建：transpile → rollup（无插件、无部署逻辑） ─────────────────────────

function sha256OfBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function gitHeadOrNull() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function transpileLabSources(stagingDir) {
  const labFiles = fs
    .readdirSync(LAB_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();
  if (labFiles.length === 0) fail(`实验源码目录为空：${LAB_DIR}`);
  for (const name of labFiles) {
    const source = fs.readFileSync(path.join(LAB_DIR, name), "utf8");
    const emitted = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2020,
      },
      fileName: name,
    });
    fs.writeFileSync(path.join(stagingDir, name.replace(/\.ts$/, ".js")), emitted.outputText);
  }
  return labFiles;
}

async function buildMode(mode, resolvedOut) {
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "treasury-terminal-lab-staging-"));
  let bundleCode;
  try {
    transpileLabSources(stagingDir);
    const entryPath = path.join(stagingDir, ENTRIES[mode].replace(/\.ts$/, ".js"));
    if (!fs.existsSync(entryPath)) fail(`入口源码缺失：test/lab/terminal-transfer/${ENTRIES[mode]}`);
    const bundle = await rollup({
      input: entryPath,
      // 不加载根 rollup 配置、不挂任何插件（staging 已是 ESM JS，相对导入
      // 由 rollup 内置解析）——构建器因此没有部署/上传/网络能力。
      plugins: [],
      onwarn(warning) {
        process.stderr.write(`[build-treasury-terminal-lab] rollup 警告：${warning.message}\n`);
      },
    });
    try {
      const outputName = mode === "observer" ? "observer.js" : "single-shot.js";
      const banner =
        mode === "observer"
          ? "/* Terminal Transfer Engine Lab Prep I——observer（默认只读入口）。PREPARED_NOT_RUN：仅本地构建与离线自测，未在真实引擎上运行。不发送、不写游戏 Memory。生成身份见同目录 manifest.json。 */"
          : "/* Terminal Transfer Engine Lab Prep I——single-shot（未武装调用版，仅供未来单独授权的隔离实验）。PREPARED_NOT_RUN：仅本地构建与离线自测，未在真实引擎上运行。默认零发送；仅在完整实验配置与一次性控制事实同时匹配的目标 tick，且 attempted 标记写入并读回确认后才尝试一次（标记未确认即零发送）。 */";
      const generated = await bundle.write({
        file: path.join(resolvedOut, outputName),
        format: "cjs",
        banner,
        sourcemap: false,
      });
      bundleCode = fs.readFileSync(path.join(resolvedOut, outputName));
      return { outputName, generated, bundleCode };
    } finally {
      await bundle.close();
    }
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

// ── main ────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
if (args.out === undefined) fail(`--out 是必填参数\n${USAGE}`);

const { resolved: outDir } = validateOutDirectory(args.out);
ensureEmptyOutputDirectory(outDir);

const buildResult = await buildMode(args.mode, outDir);
const bundleBytes = buildResult.bundleCode ?? Buffer.alloc(0);
const bundleSha256 = sha256OfBuffer(bundleBytes);
const lockfileBuffer = fs.readFileSync(path.join(REPO_ROOT, "package-lock.json"));

// 复制合成示例配置（文档面；运行时产物不读文件系统）。
fs.copyFileSync(path.join(LAB_DIR, "example.experiment.json"), path.join(outDir, "example.experiment.json"));

const manifest = {
  schema: "treasury-terminal-lab-manifest/v1",
  status: "PREPARED_NOT_RUN",
  note: "本产物只在本地构建并用假端口离线自测；未启动游戏服务器、未上传、未在真实引擎上运行。真实运行须单独授权。",
  mode: args.mode,
  entry: ENTRIES[args.mode],
  output: {
    file: buildResult.outputName,
    bytes: bundleBytes.length,
    sha256: bundleSha256,
  },
  repoSourceCommit: gitHeadOrNull() ?? "unknown",
  lockfileSha256: sha256OfBuffer(lockfileBuffer),
  toolchain: {
    node: process.version,
    typescript: ts.version,
    rollup: rollupPackageInfo.version,
  },
  referenceShas: REFERENCE_SHAS,
  buildCommand: `node ${toPosix(path.relative(REPO_ROOT, SCRIPT_PATH))} --mode ${args.mode} --out <out>`,
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

process.stdout.write(
  JSON.stringify({
    status: manifest.status,
    mode: manifest.mode,
    output: `${args.out}/${buildResult.outputName}`,
    bundleSha256,
    manifest: `${args.out}/manifest.json`,
  }) + "\n",
);
