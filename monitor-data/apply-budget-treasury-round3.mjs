// 应用 budget 锚点更新：empire-treasury-rearchitecture 第三轮数据安全修复的
// 用例变化（treasuryLifecycle 18→32、core 15→21、projection 15→17、
// commitments 12→13、invalidation 边界 2→5；shadow/boundary 数量不变）。
import fs from "node:fs";
const budgetPath = "test/test-suite-budget.json";
const b = JSON.parse(fs.readFileSync(budgetPath, "utf8"));
const NEW_BASELINE = process.argv[2];
if (!NEW_BASELINE) throw new Error("usage: node apply-budget-treasury-round3.mjs <baseline-commit>");
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
if (suites !== 199 || tests !== 777) {
  console.error(`MISMATCH: expected 199/777, got ${suites}/${tests}`);
  process.exit(1);
}
b.baseline = { commit: NEW_BASELINE, suites, tests, passed: tests, failed: 0, pending: 0, todo: 0 };
b.target = { suites, tests, passed: tests, failed: 0, pending: 0, todo: 0 };
fs.writeFileSync(budgetPath, JSON.stringify(b, null, 2) + "\n");
console.log(`budget applied: suites=${suites} tests=${tests} baseline=${NEW_BASELINE}`);
