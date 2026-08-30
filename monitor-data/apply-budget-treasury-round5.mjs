// 应用 budget 锚点更新：empire-treasury-rearchitecture 第五轮 Write-Admission
// Correctness 的用例变化（core 35→38、lifecycle 41→42；projection 21/
// commitments 14/shadow 6/invalidation 5/boundaries 6 数量不变；新增 9 个
// suite：vectors 30、tentativeLedger 12、preparedHandle 11、writeFault 12、
// safeExecute 7、typedOwnerMigration 13、commitmentCompleteness 8、
// writeArchitecture 5、writeAdmissionPerformance 6）。
import fs from "node:fs";
const budgetPath = "test/test-suite-budget.json";
const b = JSON.parse(fs.readFileSync(budgetPath, "utf8"));
const NEW_BASELINE = process.argv[2];
if (!NEW_BASELINE) throw new Error("usage: node apply-budget-treasury-round5.mjs <baseline-commit>");
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
  "test/treasuryCommitmentInvalidationBoundaries.test.ts",
]) {
  if (!counts[key]) throw new Error(`missing count for ${key}`);
  b.files[key] = { baseline: 0, budget: counts[key], tier: "high-risk" };
}

const suites = Object.keys(b.files).length;
const tests = Object.values(b.files).reduce((sum, e) => sum + e.budget, 0);
if (suites !== 208 || tests !== 913) {
  console.error(`MISMATCH: expected 208/913, got ${suites}/${tests}`);
  process.exit(1);
}
b.baseline = { commit: NEW_BASELINE, suites, tests, passed: tests, failed: 0, pending: 0, todo: 0 };
b.target = { suites, tests, passed: tests, failed: 0, pending: 0, todo: 0 };
fs.writeFileSync(budgetPath, JSON.stringify(b, null, 2) + "\n");
console.log(`budget applied: suites=${suites} tests=${tests} baseline=${NEW_BASELINE}`);
