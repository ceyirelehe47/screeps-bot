// 应用 budget 锚点更新：empire-treasury-rearchitecture 第八轮 Durable
// Intent & Authorization Binding 的用例变化（faultResolution 17→25、
// typedOwnerMigration 33→41、writeArchitecture 11→15、
// writeAdmissionPerformance 9→12、quarantineAuthority 16→22、
// quarantine 13、safeExecute 12、writeFault 12、authorization/contract/
// capacityViews 沿用本轮前值；新增 4 个 suite：durableIntent 21、
// authorization 19、actionContract 12、capacityViews 4）。
import fs from "node:fs";
const budgetPath = "test/test-suite-budget.json";
const b = JSON.parse(fs.readFileSync(budgetPath, "utf8"));
const NEW_BASELINE = process.argv[2];
if (!NEW_BASELINE) throw new Error("usage: node apply-budget-treasury-round8.mjs <baseline-commit>");
const counts = JSON.parse(fs.readFileSync("monitor-data/jest-file-counts.json", "utf8"));

// treasury 相关文件 budget 更新至实际数（high-risk 层级）。
for (const key of [
  "src/runtime/resourceReservation.test.ts",
  "src/runtime/treasury/treasuryActionContract.test.ts",
  "src/runtime/treasury/treasuryAuthorization.test.ts",
  "src/runtime/treasury/treasuryCapacityViews.test.ts",
  "src/runtime/treasury/treasuryCommitmentCompleteness.test.ts",
  "src/runtime/treasury/treasuryCommitments.test.ts",
  "src/runtime/treasury/treasuryCore.test.ts",
  "src/runtime/treasury/treasuryDurableIntent.test.ts",
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
if (suites !== 217 || tests !== 1130) {
  console.error(`MISMATCH: expected 217/1130, got ${suites}/${tests}`);
  process.exit(1);
}
b.baseline = { commit: NEW_BASELINE, suites, tests, passed: tests, failed: 0, pending: 0, todo: 0 };
b.target = { suites, tests, passed: tests, failed: 0, pending: 0, todo: 0 };
fs.writeFileSync(budgetPath, JSON.stringify(b, null, 2) + "\n");
console.log(`budget applied: suites=${suites} tests=${tests} baseline=${NEW_BASELINE}`);
