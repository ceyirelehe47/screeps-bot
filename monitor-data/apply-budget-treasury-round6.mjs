// 应用 budget 锚点更新：empire-treasury-rearchitecture 第六轮 Fault
// Recovery & Authority Integrity 的用例变化（preparedHandle 11→12、
// safeExecute 7→23、typedOwnerMigration 13→19、commitmentCompleteness
// 8→19；新增 2 个 suite：quarantine 6、faultResolution 9；其余 treasury
// 文件数量不变）。
import fs from "node:fs";
const budgetPath = "test/test-suite-budget.json";
const b = JSON.parse(fs.readFileSync(budgetPath, "utf8"));
const NEW_BASELINE = process.argv[2];
if (!NEW_BASELINE) throw new Error("usage: node apply-budget-treasury-round6.mjs <baseline-commit>");
const counts = JSON.parse(fs.readFileSync("monitor-data/jest-file-counts.json", "utf8"));

// treasury 相关文件 budget 更新至实际数（high-risk 层级）。
for (const key of [
  "src/runtime/treasury/treasuryCore.test.ts",
  "src/runtime/treasury/treasuryProjection.test.ts",
  "src/runtime/treasury/treasuryCommitments.test.ts",
  "src/runtime/treasury/treasuryShadow.test.ts",
  "src/runtime/treasury/treasuryLifecycle.test.ts",
  "src/runtime/treasury/treasuryTransactionIdVectors.test.ts",
  "src/runtime/treasury/treasuryTentativeLedger.test.ts",
  "src/runtime/treasury/treasuryPreparedHandle.test.ts",
  "src/runtime/treasury/treasuryWriteFault.test.ts",
  "src/runtime/treasury/treasurySafeExecute.test.ts",
  "src/runtime/treasury/treasuryTypedOwnerMigration.test.ts",
  "src/runtime/treasury/treasuryCommitmentCompleteness.test.ts",
  "src/runtime/treasury/treasuryWriteArchitecture.test.ts",
  "src/runtime/treasury/treasuryWriteAdmissionPerformance.test.ts",
  "src/runtime/treasury/treasuryQuarantine.test.ts",
  "src/runtime/treasury/treasuryFaultResolution.test.ts",
  "test/treasuryCommitmentInvalidationBoundaries.test.ts",
]) {
  if (!counts[key]) throw new Error(`missing count for ${key}`);
  b.files[key] = { baseline: 0, budget: counts[key], tier: "high-risk" };
}

const suites = Object.keys(b.files).length;
const tests = Object.values(b.files).reduce((sum, e) => sum + e.budget, 0);
if (suites !== 210 || tests !== 964) {
  console.error(`MISMATCH: expected 210/964, got ${suites}/${tests}`);
  process.exit(1);
}
b.baseline = { commit: NEW_BASELINE, suites, tests, passed: tests, failed: 0, pending: 0, todo: 0 };
b.target = { suites, tests, passed: tests, failed: 0, pending: 0, todo: 0 };
fs.writeFileSync(budgetPath, JSON.stringify(b, null, 2) + "\n");
console.log(`budget applied: suites=${suites} tests=${tests} baseline=${NEW_BASELINE}`);
