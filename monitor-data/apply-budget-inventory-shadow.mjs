// 应用 budget 锚点更新（库存影子阶段）：新 baseline(3f7d148) +
// 193 suites / 666 tests（redaction 7 + 市场授权集成 5 + 库存索引 10 +
// 影子 5 + 微基准 1 + session 6→11 + gate 4→5）。
import fs from "node:fs";
const budgetPath = "test/test-suite-budget.json";
const b = JSON.parse(fs.readFileSync(budgetPath, "utf8"));
const NEW_BASELINE = process.argv[2];
const counts = JSON.parse(fs.readFileSync("monitor-data/jest-file-counts.json", "utf8"));

const NEW_FILES = [
  "scripts/lib/redactSecrets.test.ts",
  "src/runtime/marketSalePlanningAuthorization.test.ts",
  "src/runtime/empireInventoryIndex.test.ts",
  "src/runtime/empireInventoryShadow.test.ts",
  "src/runtime/empireInventoryBenchmark.test.ts",
];
for (const key of NEW_FILES) {
  b.files[key] = { baseline: 0, budget: counts[key], tier: "high-risk" };
}
// 预算变化文件同步到实际用例数（单文件 budget 必须 >= 实际用例数）
for (const key of [
  "src/runtime/marketSaleSession.test.ts",
  "src/runtime/marketSalePlanningGate.test.ts",
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
if (tests !== 666 || suites !== 193) {
  console.error("MISMATCH: expected 193/666");
  process.exit(1);
}
