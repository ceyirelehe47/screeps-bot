import fs from "node:fs";
import path from "node:path";
const dir = process.env.SEAL_EV1_EVIDENCE_DIR;
let bad = 0;
for (const f of ["jest-key.json", "jest-treasury.json", "jest-defense.json", "jest-full.json"]) {
  const p = path.join(dir, f);
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const line = `${f}: suites=${j.numTotalTestSuites} tests=${j.numTotalTests} passed=${j.numPassedTests} failed=${j.numFailedTests} pending=${j.numPendingTests} todo=${j.numTodoTests} runtimeErrors=${(j.testResults || []).filter((r) => r.testExecError !== undefined).length}`;
  console.log(line);
  if (j.numFailedTests !== 0 || j.numPendingTests !== 0 || j.numTodoTests !== 0 || (j.testResults || []).some((r) => r.testExecError !== undefined)) bad += 1;
}
console.log(`JEST_JSON=${bad === 0 ? "PASS" : "FAIL"}`);
process.exit(bad === 0 ? 0 : 1);
