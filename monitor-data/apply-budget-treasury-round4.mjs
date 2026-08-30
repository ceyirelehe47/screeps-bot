// 应用 budget 锚点更新：empire-treasury-rearchitecture 第四轮 Pre-Write
// Hardening 的用例变化（lifecycle 32→41、core 21→35、projection 17→21、
// commitments 13→14；invalidation 边界 5 与 shadow 6 数量不变）。
import fs from "node:fs";
const budgetPath = "test/test-suite-budget.json";
const b = JSON.parse(fs.readFileSync(budgetPath, "utf8"));
const NEW_BASELINE = process.argv[2];
if (!NEW_BASELINE) throw new Error("usage: node apply-budget-treasury-round4.mjs <baseline-commit>");
const counts = JSON.parse(fs.readFileSync("monitor-data/jest-file-counts.json", "utf8"));

// 更新 treasury 相关文件 budget 至实际数（high-risk 层级）。
for (const key of [
  "src/runtime/treasury/treasuryCore.test.ts",
  "src/runtime/treasury/treasuryProjection.test.ts",
  "src/runtime/treasury/treasuryCommitments.test.ts",
  "src/runtime/treasury/treasuryShadow.test.ts",
  "src/runtime/treasury/treasuryLifecycle.test.ts",
  "test/treasuryCommitmentInvalidationBoundaries.test.ts",
]) {
  if (!counts[key]) throw new Error(`missing count for ${key}`);
  b.files[key] = { baseline: 0, budget: counts[key], tier: "high-risk" };
}

const suites = Object.keys(b.files).length;
const tests = Object.values(b.files).reduce((sum, e) => sum + e.budget, 0);
if (suites !== 199 || tests !== 805) {
  console.error(`MISMATCH: expected 199/805, got ${suites}/${tests}`);
  process.exit(1);
}
b.baseline = { commit: NEW_BASELINE, suites, tests, passed: tests, failed: 0, pending: 0, todo: 0 };
b.target = { suites, tests, passed: tests, failed: 0, pending: 0, todo: 0 };
fs.writeFileSync(budgetPath, JSON.stringify(b, null, 2) + "\n");
console.log(`budget applied: suites=${suites} tests=${tests} baseline=${NEW_BASELINE}`);
