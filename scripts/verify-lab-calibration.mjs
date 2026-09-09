#!/usr/bin/env node
/**
 * Terminal Transfer Engine Lab Run I · Calibration Rerun——独立配置核对 CLI
 * （任务书 §5，C02）。读取固定源码实际使用的编译配置（test/lab/terminal-transfer/
 * labConfig.ts，转译求值——不把手写 JSON 或第二份配置当权威），与独立落盘的
 * facts 文件（只读元信息采样 + 收集通道组装）逐项比较，输出完整 JSON 报告。
 *
 * 约束：零写权限——不写任何文件、不连游戏、不写游戏 Memory、不武装控制槽、
 * 不调用 send；退出码 0=全部通过，1=存在 fail/missing（含缺失、不健康、来源
 * 混用、陈旧），2=输入不可用。比较结果不构成游戏运行时的新授权字段。
 *
 * 用法：
 *   node scripts/verify-lab-calibration.mjs --facts <calibration-facts.json>
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);
const ts = require("typescript");

function resolveRepoRoot() {
  let dir = path.dirname(scriptPath);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(path.dirname(scriptPath), "..");
}

const REPO_ROOT = resolveRepoRoot();
const LAB_DIR = path.join(REPO_ROOT, "test", "lab", "terminal-transfer");

function failUsage(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write("用法：node scripts/verify-lab-calibration.mjs --facts <calibration-facts.json>\n");
  process.exit(0);
}
const factsIndex = args.indexOf("--facts");
if (factsIndex === -1 || args[factsIndex + 1] === undefined) failUsage("缺少 --facts <file> 参数");
const factsPath = path.resolve(args[factsIndex + 1]);

/** 转译并求值一个自包含 TS 模块（CommonJS；labConfig/calibrationCheck 均无运行时导入）。 */
function evaluateTsModule(tsPath) {
  const source = fs.readFileSync(tsPath, "utf8");
  const emitted = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: path.basename(tsPath),
  }).outputText;
  const moduleExports = {};
  const run = new Function("exports", "module", "require", emitted);
  run(moduleExports, { exports: moduleExports }, (name) => {
    throw new Error(`配置核对模块不应有运行时依赖：require('${name}')`);
  });
  return moduleExports;
}

const labConfigModule = evaluateTsModule(path.join(LAB_DIR, "labConfig.ts"));
const calibrationModule = evaluateTsModule(path.join(LAB_DIR, "calibrationCheck.ts"));
const config = labConfigModule.LAB_EXAMPLE_EXPERIMENT;
if (config === undefined || typeof config !== "object") failUsage("labConfig.ts 未导出 LAB_EXAMPLE_EXPERIMENT");

let factsBytes;
try {
  factsBytes = fs.readFileSync(factsPath);
} catch (error) {
  failUsage(`facts 文件不可读：${factsPath}（${String(error)})`);
}
let facts;
try {
  facts = JSON.parse(factsBytes.toString("utf8"));
} catch (error) {
  failUsage(`facts 不是合法 JSON：${String(error)}`);
}
if (typeof facts !== "object" || facts === null || typeof facts.context !== "object" || facts.context === null) {
  failUsage("facts 形状不符合 CalibrationFacts（缺 context）");
}

const labConfigBytes = fs.readFileSync(path.join(LAB_DIR, "labConfig.ts"));
const labConfigSha256 = createHash("sha256").update(labConfigBytes).digest("hex");
let repoHead = null;
try {
  repoHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
} catch {
  repoHead = null;
}

// 配置侧来源由 CLI 从实际输入注入（世界观测字段一律来自 facts，不改写）。
const effectiveFacts = {
  ...facts,
  context: {
    ...facts.context,
    codeSource: { repoHead, labConfigSha256 },
  },
};

const report = calibrationModule.checkLabCalibration(config, effectiveFacts);

const output = {
  tool: { name: "verify-lab-calibration", schema: "lab-calibration-report/v1" },
  inputs: {
    factsPath,
    factsSha256: createHash("sha256").update(factsBytes).digest("hex"),
    configSource: {
      kind: "labConfig.ts（转译求值，唯一编译配置来源）",
      path: path.join("test", "lab", "terminal-transfer", "labConfig.ts"),
      sha256: labConfigSha256,
      repoHead,
    },
    note: "codeSource 由 CLI 从实际读取的 labConfig.ts 字节与仓库 HEAD 注入；世界观测字段全部来自 facts 文件。",
  },
  config,
  report,
};

for (const check of report.checks) {
  process.stderr.write(`${check.result.toUpperCase().padEnd(7)} [${check.category}] ${check.item}${check.note ? ` —— ${check.note}` : ""}\n`);
}
process.stderr.write(
  `合计 ${report.summary.total} 项：pass=${report.summary.passed} fail=${report.summary.failed} missing=${report.summary.missing} → ${report.status}\n`,
);
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
process.exit(report.status === "pass" ? 0 : 1);
