// 应用 budget 锚点更新：empire-treasury-rearchitecture 第九轮 Contract-
// Bound Authority & Recovery Closure 的用例变化（durableIntent 21→32、
// faultResolution 25→37、writeArchitecture 15→16、writeAdmissionPerformance
// 12→14、actionContract 12 重写、authorization 19 适配；新增 2 个 suite：
// canonicalEncoding 11、contractAuthorization 14；其余 treasury 文件沿用
// 实际数）。总计 217/1130 → 219/1181。
import fs from "node:fs";
const budgetPath = "test/test-suite-budget.json";
const b = JSON.parse(fs.readFileSync(budgetPath, "utf8"));
const NEW_BASELINE = process.argv[2];
if (!NEW_BASELINE) throw new Error("usage: node apply-budget-treasury-round9.mjs <baseline-commit>");
const counts = JSON.parse(fs.readFileSync("monitor-data/jest-file-counts.json", "utf8"));

// treasury 相关文件 budget 更新至实际数（high-risk 层级）。
for (const key of [
  "src/runtime/resourceReservation.test.ts",
  "src/runtime/treasury/treasuryActionContract.test.ts",
  "src/runtime/treasury/treasuryAuthorization.test.ts",
  "src/runtime/treasury/treasuryCanonicalEncoding.test.ts",
  "src/runtime/treasury/treasuryCapacityViews.test.ts",
  "src/runtime/treasury/treasuryCommitmentCompleteness.test.ts",
  "src/runtime/treasury/treasuryCommitments.test.ts",
  "src/runtime/treasury/treasuryContractAuthorization.test.ts",
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
if (suites !== 219 || tests !== 1181) {
  console.error(`MISMATCH: expected 219/1181, got ${suites}/${tests}`);
  process.exit(1);
}
b.baseline = { commit: NEW_BASELINE, suites, tests, passed: tests, failed: 0, pending: 0, todo: 0 };
b.target = { suites, tests, passed: tests, failed: 0, pending: 0, todo: 0 };
fs.writeFileSync(budgetPath, JSON.stringify(b, null, 2) + "\n");
console.log(`budget applied: suites=${suites} tests=${tests} baseline=${NEW_BASELINE}`);
