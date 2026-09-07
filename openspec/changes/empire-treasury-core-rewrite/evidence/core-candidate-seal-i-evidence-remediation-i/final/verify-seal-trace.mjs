import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const ts = require(repoRoot + "/node_modules/typescript");
const outDir = process.env.SEAL_EV1_EVIDENCE_DIR;
const head = fs.readFileSync(path.join(outDir, "validation-head.txt"), "utf8").trim();
const src = execFileSync("git", ["show", `${head}:test/mock/treasurySealEvidence.ts`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const blobHash = execFileSync("git", ["rev-parse", `${head}:test/mock/treasurySealEvidence.ts`], { encoding: "utf8" }).trim();
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "seal-ev1-verifier-"));
const jsFile = path.join(stage, "treasurySealEvidence.js");
fs.writeFileSync(jsFile, js);
const mod = require(jsFile);
const traceDirs = ["trace-key", "trace-treasury", "trace-full", "trace-budget"];
let failed = 0;
const lines = [];
for (const dir of traceDirs) {
  const root = path.join(outDir, dir);
  if (!fs.existsSync(root)) { lines.push(`MISSING ${dir}`); failed += 1; continue; }
  const runs = fs.readdirSync(root).sort();
  for (const run of runs) {
    const file = path.join(root, run, "H18-J06.json");
    if (!fs.existsSync(file)) { lines.push(`MISSING ${dir}/${run}/H18-J06.json`); failed += 1; continue; }
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const expected = { unknownIds: doc.fixture.unknownIds, plannedObserveTicks: doc.segments.observe.actualTicks };
    const verdict = mod.sealVerifyTraceCompleteness(doc, expected);
    const sha = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const size = fs.statSync(file).size;
    lines.push(`${dir}/${run}/H18-J06.json bytes=${size} sha256=${sha} completed=${doc.completed} checkpoints=${doc.checkpoints.length} problems=${verdict.problems.length}${verdict.problems.length > 0 ? " :: " + verdict.problems.slice(0, 3).join(" | ") : ""}`);
    if (!verdict.ok) failed += 1;
  }
}
fs.rmSync(stage, { recursive: true, force: true });
console.log(`verifier-source=${head}:test/mock/treasurySealEvidence.ts blob=${blobHash}`);
console.log(lines.join("\n"));
console.log(`TRACE_VERIFY=${failed === 0 ? "PASS" : "FAIL"} (${failed} failures)`);
process.exit(failed === 0 ? 0 : 1);
