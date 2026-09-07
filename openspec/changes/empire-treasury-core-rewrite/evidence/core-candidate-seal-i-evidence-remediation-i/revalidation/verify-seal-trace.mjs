// 独立 reviewer 落盘轨迹核验脚本（Core Candidate Seal I · Evidence Remediation I 复验）
// 用途：用 d9cd60e 已提交的 sealVerifyTraceCompleteness 对本 reviewer 自己导出的
//       H18-J06.json（trace-key 目录）做先写盘、再 JSON 读取后的核验。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const REVIEW_PARENT = "C:/Users/15027/AppData/Local/Temp/seal-ev1-review";
const WORKTREE = path.join(REVIEW_PARENT, "worktree");
const COMMIT = "d9cd60e07f4c4e7559aec14383ee805aea0e2051";
const VERIFIER_PATH = "test/mock/treasurySealEvidence.ts";
const TRACE_ROOT = path.join(REVIEW_PARENT, "output", "trace-key");

const nodeRequire = createRequire(import.meta.url);

// 1) 取已提交核验实现源码（git show d9cd60e:…），并记录 blob hash 与内容 sha256
const src = execFileSync("git", ["show", `${COMMIT}:${VERIFIER_PATH}`], {
  cwd: WORKTREE,
  encoding: "utf8",
});
const blobHash = execFileSync("git", ["rev-parse", `${COMMIT}:${VERIFIER_PATH}`], {
  cwd: WORKTREE,
  encoding: "utf8",
}).trim();
const srcSha256 = crypto.createHash("sha256").update(src, "utf8").digest("hex");

// 2) 用 worktree node_modules 内的 typescript.transpileModule 编译到临时 .cjs 再 require
const ts = nodeRequire(path.join(WORKTREE, "node_modules", "typescript"));
const transpiled = ts.transpileModule(src, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
});
const tmpJs = path.join(os.tmpdir(), `treasurySealEvidence-verify-${Date.now()}.cjs`);
fs.writeFileSync(tmpJs, transpiled.outputText);
let mod;
try {
  mod = nodeRequire(tmpJs);
} finally {
  fs.unlinkSync(tmpJs);
}
const verifier = mod.sealVerifyTraceCompleteness;
if (typeof verifier !== "function") {
  console.error("sealVerifyTraceCompleteness 未在已提交源码中找到");
  process.exit(1);
}

// 3) 递归定位 trace-key 下导出的 H18-J06.json
function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (entry.isFile() && entry.name === "H18-J06.json") acc.push(p);
  }
  return acc;
}
const traceFiles = fs.existsSync(TRACE_ROOT) ? walk(TRACE_ROOT, []) : [];
if (traceFiles.length === 0) {
  console.error(`未在 ${TRACE_ROOT} 下找到 H18-J06.json——文件缺失`);
  process.exit(1);
}

// 4) 逐个核验：先读盘再 JSON.parse（证明导出落盘后仍可核验），problems 非空即失败
let anyFailed = false;
for (const file of traceFiles.sort()) {
  const buf = fs.readFileSync(file);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const doc = JSON.parse(buf.toString("utf8"));
  const expected = {
    unknownIds: doc.fixture.unknownIds,
    plannedObserveTicks: doc.segments.observe.actualTicks,
  };
  const result = verifier(doc, expected);
  console.log(
    JSON.stringify(
      {
        file,
        bytes: buf.length,
        sha256,
        completed: doc.completed,
        checkpointCount: Array.isArray(doc.checkpoints) ? doc.checkpoints.length : null,
        unknownIdsCount: Array.isArray(expected.unknownIds) ? expected.unknownIds.length : null,
        plannedObserveTicks: expected.plannedObserveTicks,
        verifierOk: result.ok,
        problemsCount: result.problems.length,
        problems: result.problems,
        verifierSourcePath: VERIFIER_PATH,
        verifierSourceBlobHash: blobHash,
        verifierSourceSha256: srcSha256,
      },
      null,
      2,
    ),
  );
  if (!result.ok || result.problems.length > 0) anyFailed = true;
}

process.exit(anyFailed ? 1 : 0);
