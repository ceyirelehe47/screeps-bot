import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const E = process.argv[2];
const rows = [];
for (const dir of ["lab-observer", "lab-single-shot", "lab-run-i-main"]) {
  const manifest = JSON.parse(fs.readFileSync(path.join(E, dir, "manifest.json"), "utf8"));
  const file = path.join(E, dir, manifest.output.file);
  const body = fs.readFileSync(file);
  const code = body.toString("utf8");
  const actual = { bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") };
  const checks = {
    manifestBytesMatch: manifest.output.bytes === actual.bytes,
    manifestShaMatch: manifest.output.sha256 === actual.sha256,
    statusPreparedNotRun: manifest.status === "PREPARED_NOT_RUN",
    exampleJsonHistoricalConfig:
      JSON.parse(fs.readFileSync(path.join(E, dir, "example.experiment.json"), "utf8")).shardName === "Forst",
    embeddedExperimentId: code.includes('"lab-run1-cal-0002"'),
  };
  if (manifest.mode !== "run-i-main") {
    checks.embeddedShardForst = code.includes('"Forst"');
    checks.embeddedSourceId = code.includes('"aa17545ac3100001"');
    checks.embeddedTargetId = code.includes('"aa17545ac3100002"');
    checks.embeddedCap26 = code.includes("maxFeeEnergy: 26");
  } else {
    checks.embeddedTargetTick201 = code.includes("201");
  }
  rows.push({ dir, mode: manifest.mode, actual, repoSourceCommit: manifest.repoSourceCommit, checks });
}
fs.writeFileSync(path.join(E, "lab-bundle-identities.json"), JSON.stringify(rows, null, 2) + "\n");
const failed = rows.filter((row) => Object.entries(row.checks).some(([, v]) => typeof v === "boolean" && v !== true));
console.log(failed.length === 0 ? "BUNDLE_CHECK=OK" : `BUNDLE_CHECK=FAILED ${JSON.stringify(failed.map((r) => r.dir))}`);
process.exit(failed.length === 0 ? 0 : 1);
