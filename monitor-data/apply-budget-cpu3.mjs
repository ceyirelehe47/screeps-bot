// 应用 budget 锚点更新：新 baseline(56a7ba5) + 187 suites/628 tests
// （市场 session/诊断/memo + 远采 backoff 测试入库）。
import fs from "node:fs";
const budgetPath = "test/test-suite-budget.json";
const b = JSON.parse(fs.readFileSync(budgetPath, "utf8"));
const NEW_BASELINE = process.argv[2];
const counts = JSON.parse(fs.readFileSync("monitor-data/jest-file-counts.json", "utf8"));

const NEW_FILES = [
  "src/movement/routing.backoff.test.ts",
  "src/runtime/marketSaleDiagnostics.test.ts",
  "src/runtime/marketSaleProtectionMemo.test.ts",
  "src/runtime/marketSaleSession.test.ts",
];
for (const key of NEW_FILES) {
  b.files[key] = { baseline: 0, budget: counts[key], tier: "high-risk" };
}
// 预算变化文件同步到实际用例数（单文件 budget 必须 >= 实际用例数）
for (const key of [
  "src/roles/remoteMiningCarrier.test.ts",
  "src/movement/metrics.flush.test.ts",
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
if (tests !== 628 || suites !== 187) {
  console.error("MISMATCH: expected 187/628");
  process.exit(1);
}
