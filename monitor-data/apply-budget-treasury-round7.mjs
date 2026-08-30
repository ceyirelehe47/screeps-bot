// 应用 budget 锚点更新：empire-treasury-rearchitecture 第七轮 Quarantine
// Closure & Schema Activation 的用例变化（quarantine 6→13、faultResolution
// 9→17、typedOwnerMigration 19→33、safeExecute 23、writeArchitecture 7→11、
// writeAdmissionPerformance 6→9、writeFault 12、commitmentCompleteness 19、
// resourceReservation 2→20；新增 3 个 suite：quarantineAuthority 16、
// writeReadiness 7、reservationActivation 4；invalidation boundaries 5）。
import fs from "node:fs";
const budgetPath = "test/test-suite-budget.json";
const b = JSON.parse(fs.readFileSync(budgetPath, "utf8"));
const NEW_BASELINE = process.argv[2];
if (!NEW_BASELINE) throw new Error("usage: node apply-budget-treasury-round7.mjs <baseline-commit>");
const counts = JSON.parse(fs.readFileSync("monitor-data/jest-file-counts.json", "utf8"));

// treasury 相关文件 budget 更新至实际数（high-risk 层级）。
for (const key of [
  "src/runtime/resourceReservation.test.ts",
  "src/runtime/treasury/treasuryCommitmentCompleteness.test.ts",
  "src/runtime/treasury/treasuryCommitments.test.ts",
  "src/runtime/treasury/treasuryCore.test.ts",
  "src/runtime/treasury/treasuryFaultResolution.test.ts",
  "src/runtime/treasury/treasuryLifecycle.test.ts",
  "src/runtime/treasury/treasuryPreparedHandle.test.ts",
  "src/runtime/treasury/treasuryProjection.test.ts",
  "src/runtime/treasury/treasuryQuarantine.test.ts",
  "src/runtime/treasury/treasuryQuarantineAuthority.test.ts",
  "src/runtime/treasury/treasuryReservationActivation.test.ts",
  "src/runtime/treasury/treasurySafeExecute.test.ts",
  "src/runtime/treasury/treasuryShadow.test.ts",
  "src/runtime/treasury/treasuryTentativeLedger.test.ts",
  "src/runtime/treasury/treasuryTransactionIdVectors.test.ts",
  "src/runtime/treasury/treasuryTypedOwnerMigration.test.ts",
  "src/runtime/treasury/treasuryWriteAdmissionPerformance.test.ts",
  "src/runtime/treasury/treasuryWriteArchitecture.test.ts",
  "src/runtime/treasury/treasuryWriteFault.test.ts",
  "src/runtime/treasury/treasuryWriteReadiness.test.ts",
  "test/treasuryCommitmentInvalidationBoundaries.test.ts",
]) {
  if (!counts[key]) throw new Error(`missing count for ${key}`);
  b.files[key] = { baseline: 0, budget: counts[key], tier: "high-risk" };
}

const suites = Object.keys(b.files).length;
const tests = Object.values(b.files).reduce((sum, e) => sum + e.budget, 0);
if (suites !== 213 || tests !== 1045) {
  console.error(`MISMATCH: expected 213/1045, got ${suites}/${tests}`);
  process.exit(1);
}
b.baseline = { commit: NEW_BASELINE, suites, tests, passed: tests, failed: 0, pending: 0, todo: 0 };
b.target = { suites, tests, passed: tests, failed: 0, pending: 0, todo: 0 };
fs.writeFileSync(budgetPath, JSON.stringify(b, null, 2) + "\n");
console.log(`budget applied: suites=${suites} tests=${tests} baseline=${NEW_BASELINE}`);
