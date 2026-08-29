// 应用 budget 锚点更新：新 baseline(2b5291a) + 193 suites/670 tests
// （市场 commitment 移除 + 索引懒子层 + 影子全层对账三个提交的用例变化）。
import fs from "node:fs";
const budgetPath = "test/test-suite-budget.json";
const b = JSON.parse(fs.readFileSync(budgetPath, "utf8"));
const NEW_BASELINE = process.argv[2];
if (!NEW_BASELINE) throw new Error("usage: node apply-budget-inventory-phase2.mjs <baseline-commit>");
const counts = JSON.parse(fs.readFileSync("monitor-data/jest-file-counts.json", "utf8"));

// 预算变化文件同步到实际用例数（单文件 budget 必须 >= 实际用例数）
for (const key of [
  "src/runtime/marketSaleSession.test.ts",
  "src/runtime/empireInventoryIndex.test.ts",
  "src/runtime/empireInventoryShadow.test.ts",
]) {
  b.files[key].budget = counts[key];
}

const suites = Object.keys(b.files).length;
const tests = Object.values(b.files).reduce((sum, e) => sum + e.budget, 0);
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
if (tests !== 670 || suites !== 193) {
  console.error("MISMATCH: expected 193/670");
  process.exit(1);
}
