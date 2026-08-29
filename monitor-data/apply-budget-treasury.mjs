// 应用 budget 锚点更新：empire-treasury-rearchitecture 提交的用例变化
// （新 4 个 treasury 测试文件 29 用例：core 9 / projection 8 /
// commitments 6 / shadow 6；main.test.ts 契约更新用例数不变 6）。
import fs from "node:fs";
const budgetPath = "test/test-suite-budget.json";
const b = JSON.parse(fs.readFileSync(budgetPath, "utf8"));
const NEW_BASELINE = process.argv[2];
if (!NEW_BASELINE) throw new Error("usage: node apply-budget-treasury.mjs <baseline-commit>");
const counts = JSON.parse(fs.readFileSync("monitor-data/jest-file-counts.json", "utf8"));

// 新增 treasury 测试文件：baseline 0、budget=实际用例数、tier high-risk。
for (const key of [
  "src/runtime/treasury/treasuryCore.test.ts",
  "src/runtime/treasury/treasuryProjection.test.ts",
  "src/runtime/treasury/treasuryCommitments.test.ts",
  "src/runtime/treasury/treasuryShadow.test.ts",
]) {
  if (!counts[key]) throw new Error(`missing count for ${key}`);
  b.files[key] = { baseline: 0, budget: counts[key], tier: "high-risk" };
}

const suites = Object.keys(b.files).length;
const tests = Object.values(b.files).reduce((sum, e) => sum + e.budget, 0);
if (suites !== 197 || tests !== 712) {
  console.error(`MISMATCH: expected 197/712, got ${suites}/${tests}`);
  process.exit(1);
}
b.baseline = { commit: NEW_BASELINE, suites, tests, passed: tests, failed: 0, pending: 0, todo: 0 };
b.target = { suites, tests, passed: tests, failed: 0, pending: 0, todo: 0 };
const tiers = Object.values(b.files).reduce((acc, e) => { acc[e.tier] = (acc[e.tier] || 0) + 1; return acc; }, {});
b.allocation = {
  protectedFullFiles: tiers["protected-full"],
  highRiskFiles: tiers["high-risk"],
  defaultFiles: tiers["default-max-2"],
};
fs.writeFileSync(budgetPath, JSON.stringify(b, null, 2) + "\n");
console.log("budget updated:", JSON.stringify({ baseline: NEW_BASELINE, suites, tests, allocation: b.allocation }));
