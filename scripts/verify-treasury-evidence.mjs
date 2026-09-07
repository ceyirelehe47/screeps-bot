#!/usr/bin/env node
/**
 * Treasury 证据核验驱动（Terminal Transfer Slice 0／工作 A：上轮三个后置
 * .mjs 驱动的整合收尾）。
 *
 * 整合范围（只整合现有调用，不重写风险比较器、不新增归档平台）：
 * - evidence/…/core-candidate-seal-i-evidence-remediation-i/final/verify-seal-trace.mjs
 *   （trace 核验：git show 固定提交的 treasurySealEvidence.ts → transpile →
 *   sealVerifyTraceCompleteness）；
 * - 同目录 check-jest-json.mjs（原始 Jest JSON 的失败/pending/todo/runtime
 *   error 检查）；
 * - 同证据根 revalidation/verify-seal-trace.mjs 的递归 walk 与输入记录能力
 *   （去除其硬编码的绝对临时路径——本入口显式接收参数）。
 *
 * 与旧驱动的关键差异（任务书 §2）：expected 使用本轮已固定的夹具约束
 * （H18：20 个指定 unknown、12 个观察窗口），不再把待检查文件自带的
 * fixture.unknownIds／actualTicks 当作 expected；待检文件与固定约束不符
 * 即失败。旧原件与日志保留历史身份，本脚本不重写它们。
 *
 * 用法：
 *   node scripts/verify-treasury-evidence.mjs \
 *     --validation-head <git-sha> --run-dir <dir> --fixture h18
 *
 * 退出码：0=全部通过；1=任一核验失败；2=参数/输入不可用（缺输入、零输入、
 * 版本不匹配、helper 源缺失）。
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);

/**
 * 仓库定位（Remediation I · T1/N07）：从脚本实际路径向上找 .git 祖先目录，
 * 不依赖调用者 cwd——仓库外以绝对路径运行时不再失败或选中另一个仓库。
 * 所有 Git 调用与依赖解析显式锚定该根；run-dir 相对路径仍按**调用者 cwd**
 * 解析（见 main），不因切换 Git cwd 改变输入含义。
 */
function resolveRepoRoot() {
  let dir = path.dirname(scriptPath);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  console.error(`无法从脚本路径定位仓库根（未找到 .git 祖先目录）: ${scriptPath}`);
  process.exit(2);
}

const REPO_ROOT = resolveRepoRoot();

/** H18 固定夹具约束（来源：treasuryRemediationIVKernel.test.ts J06 fixture，锚点 5360e66 系列：30 closing ×3 + 20 unknown + 10 retry + 4 pending，observe plannedTicks=12）。 */
const FIXTURES = {
  h18: Object.freeze({
    testId: "H18-J06",
    plannedObserveTicks: 12,
    unknownIds: Object.freeze(
      Array.from({ length: 20 }, (_, i) => `tk1_h18_${(30 + i).toString().padStart(2, "0")}`),
    ),
  }),
};

const TRACE_DIRS = ["trace-key", "trace-treasury", "trace-full", "trace-budget"];
const JEST_JSON_FILES = ["jest-key.json", "jest-treasury.json", "jest-defense.json", "jest-full.json"];
const HELPER_PATH = "test/mock/treasurySealEvidence.ts";

function usage(exitCode) {
  console.error("用法: node scripts/verify-treasury-evidence.mjs --validation-head <git-sha> --run-dir <dir> --fixture h18");
  console.error(`可用夹具: ${Object.keys(FIXTURES).join(", ")}`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const out = { validationHead: undefined, runDir: undefined, fixture: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage(0);
    const key = ["--validation-head", "--run-dir", "--fixture"].find((k) => arg === k || arg.startsWith(`${k}=`));
    if (key === undefined) {
      console.error(`未知参数: ${arg}`);
      usage(2);
    }
    const value = arg.includes("=") ? arg.slice(key.length + 1) : argv[(i += 1)];
    if (value === undefined || value.length === 0) {
      console.error(`参数 ${key} 缺少取值`);
      usage(2);
    }
    const slot = { "--validation-head": "validationHead", "--run-dir": "runDir", "--fixture": "fixture" }[key];
    out[slot] = value;
  }
  if (out.validationHead === undefined || out.runDir === undefined || out.fixture === undefined) {
    console.error("缺少必填参数（--validation-head/--run-dir/--fixture 全部必填）");
    usage(2);
  }
  if (!/^[0-9a-f]{7,40}$/i.test(out.validationHead)) {
    console.error(`--validation-head 须为 git commit SHA: ${out.validationHead}`);
    usage(2);
  }
  if (!(out.fixture in FIXTURES)) {
    console.error(`未知夹具 ${out.fixture}（可用: ${Object.keys(FIXTURES).join(", ")}）`);
    usage(2);
  }
  return out;
}

/** 从指定固定提交加载 treasurySealEvidence（git show → transpile → 临时 js require；Git 调用全部锚定 REPO_ROOT）。 */
function loadVerifierFromCommit(validationHead) {
  let src;
  let blobHash;
  try {
    src = execFileSync("git", ["show", `${validationHead}:${HELPER_PATH}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    blobHash = execFileSync("git", ["rev-parse", `${validationHead}:${HELPER_PATH}`], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch (error) {
    console.error(`无法从提交 ${validationHead} 读取 ${HELPER_PATH}（版本不匹配或提交不可用）: ${String(error.message).slice(0, 160)}`);
    process.exit(2);
  }
  const ts = require(path.resolve(REPO_ROOT, "node_modules", "typescript"));
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "treasury-evidence-verifier-"));
  try {
    const jsFile = path.join(stage, "treasurySealEvidence.js");
    fs.writeFileSync(jsFile, js);
    return { mod: require(jsFile), blobHash };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** 递归收集目录下全部指定文件名的相对路径（按路径排序，确定性输出）。 */
function walkCollect(root, fileName, prefix, out) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    out.problems.push(`${prefix}: 目录不可读（${String(error.message).slice(0, 96)}）`);
    return;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walkCollect(path.join(root, entry.name), fileName, rel, out);
    else if (entry.name === fileName) out.files.push(rel);
  }
}

function verifyTraces(runDir, fixture, verifier, failures, lines) {
  const seenRoots = [];
  for (const dir of TRACE_DIRS) {
    const root = path.join(runDir, dir);
    if (!fs.existsSync(root)) continue;
    seenRoots.push(dir);
    const walk = { files: [], problems: [] };
    walkCollect(root, `${fixture.testId}.json`, dir, walk);
    for (const problem of walk.problems) {
      lines.push(`FAIL ${problem}`);
      failures.push(problem);
    }
    if (walk.files.length === 0) {
      const message = `${dir}: 目录存在但未找到任何 ${fixture.testId}.json（零有效输入）`;
      lines.push(`FAIL ${message}`);
      failures.push(message);
      continue;
    }
    for (const rel of walk.files) {
      const file = path.join(runDir, rel);
      let doc;
      try {
        doc = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (error) {
        const message = `${rel}: JSON 解析失败（${String(error.message).slice(0, 96)}）`;
        lines.push(`FAIL ${message}`);
        failures.push(message);
        continue;
      }
      // 固定夹具约束（任务书 §2）：待检文件自带的 fixture 值不再是 expected
      // 来源——与固定约束不符即失败（文档篡改/错夹具输出都会被拦下）。
      const docUnknown = Array.isArray(doc?.fixture?.unknownIds) ? doc.fixture.unknownIds : null;
      if (docUnknown === null || docUnknown.length !== fixture.unknownIds.length || fixture.unknownIds.some((id, i) => docUnknown[i] !== id)) {
        const message = `${rel}: fixture.unknownIds 与固定夹具约束不符（期望 ${fixture.unknownIds.length} 个指定 unknown）`;
        lines.push(`FAIL ${message}`);
        failures.push(message);
        continue;
      }
      const docTicks = doc?.segments?.observe?.actualTicks;
      if (docTicks !== fixture.plannedObserveTicks) {
        const message = `${rel}: observe.actualTicks=${String(docTicks)} 与固定夹具约束 ${String(fixture.plannedObserveTicks)} 不符`;
        lines.push(`FAIL ${message}`);
        failures.push(message);
        continue;
      }
      const verdict = verifier.mod.sealVerifyTraceCompleteness(doc, {
        unknownIds: fixture.unknownIds,
        plannedObserveTicks: fixture.plannedObserveTicks,
      });
      const sha = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      const size = fs.statSync(file).size;
      const checkpoints = Array.isArray(doc?.checkpoints) ? doc.checkpoints.length : -1;
      lines.push(
        `${rel} bytes=${size} sha256=${sha} completed=${String(doc?.completed)} checkpoints=${String(checkpoints)} problems=${String(verdict.problems.length)}${verdict.problems.length > 0 ? ` :: ${verdict.problems.slice(0, 3).join(" | ")}` : ""}`,
      );
      if (!verdict.ok) failures.push(`${rel}: sealVerifyTraceCompleteness 报告 ${String(verdict.problems.length)} 条问题`);
    }
  }
  if (seenRoots.length === 0) {
    const message = `run-dir 下不存在任何 trace 目录（${TRACE_DIRS.join("/")} 至少一个）——零输入`;
    lines.push(`FAIL ${message}`);
    failures.push(message);
  }
  return seenRoots;
}

function verifyJestJson(runDir, failures, lines) {
  const seen = [];
  for (const name of JEST_JSON_FILES) {
    const file = path.join(runDir, name);
    if (!fs.existsSync(file)) continue;
    seen.push(name);
    let j;
    try {
      j = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      const message = `${name}: JSON 解析失败（${String(error.message).slice(0, 96)}）`;
      lines.push(`FAIL ${message}`);
      failures.push(message);
      continue;
    }
    const runtimeErrors = (j.testResults || []).filter((r) => r.testExecError !== undefined).length;
    lines.push(
      `${name}: suites=${String(j.numTotalTestSuites)} tests=${String(j.numTotalTests)} passed=${String(j.numPassedTests)} failed=${String(j.numFailedTests)} pending=${String(j.numPendingTests)} todo=${String(j.numTodoTests)} runtimeErrors=${String(runtimeErrors)}`,
    );
    if (
      j.numFailedTests !== 0 ||
      j.numPendingTests !== 0 ||
      j.numTodoTests !== 0 ||
      runtimeErrors !== 0
    ) {
      failures.push(`${name}: 存在失败/pending/todo/runtime error`);
    }
  }
  if (seen.length === 0) {
    const message = `run-dir 下不存在任何 Jest JSON（${JEST_JSON_FILES.join("/")} 至少一份）——零输入`;
    lines.push(`FAIL ${message}`);
    failures.push(message);
  }
  return seen;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // T1/N07：run-dir 相对路径按**调用者 cwd**解析（与 Git cwd 解耦），并记录
  // 解析结果——输入含义不因脚本内部切换 Git cwd 而改变。
  const resolvedRunDir = path.resolve(process.cwd(), args.runDir);
  console.log(`repo-root=${REPO_ROOT}`);
  console.log(`run-dir-resolved=${resolvedRunDir} (cwd=${process.cwd()})`);
  if (!fs.existsSync(resolvedRunDir) || !fs.statSync(resolvedRunDir).isDirectory()) {
    console.error(`--run-dir 不存在或不是目录: ${args.runDir}（解析为 ${resolvedRunDir}；零输入）`);
    process.exit(2);
  }
  // 版本一致性：run-dir 自带 validation-head.txt 时（主验证模板会写入），
  // 必须与 --validation-head 一致，否则视为版本不匹配。
  const headFile = path.join(resolvedRunDir, "validation-head.txt");
  if (fs.existsSync(headFile)) {
    const recorded = fs.readFileSync(headFile, "utf8").trim();
    if (recorded.length >= 7 && recorded !== args.validationHead && !args.validationHead.startsWith(recorded) && !recorded.startsWith(args.validationHead)) {
      console.error(`版本不匹配: run-dir 记录 validation-head ${recorded} ≠ 参数 ${args.validationHead}`);
      process.exit(2);
    }
  }
  const verifier = loadVerifierFromCommit(args.validationHead);
  const fixture = FIXTURES[args.fixture];
  const failures = [];
  const lines = [];
  const traceRoots = verifyTraces(resolvedRunDir, fixture, verifier, failures, lines);
  const jestFiles = verifyJestJson(resolvedRunDir, failures, lines);
  const driverSha = createHash("sha256").update(fs.readFileSync(scriptPath)).digest("hex");
  console.log(`verifier-source=${args.validationHead}:${HELPER_PATH} blob=${verifier.blobHash}`);
  console.log(`driver=${scriptPath} sha256=${driverSha}`);
  console.log(`run-dir=${args.runDir} fixture=${args.fixture} trace-roots=${traceRoots.join(",")} jest-json=${jestFiles.join(",")}`);
  console.log(lines.join("\n"));
  console.log(`TREASURY_EVIDENCE_VERIFY=${failures.length === 0 ? "PASS" : "FAIL"} (${String(failures.length)} failures)`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
}

main();
