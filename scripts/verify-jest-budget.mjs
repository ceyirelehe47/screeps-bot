import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import integrityGuard from "./lib/testIntegrityGuard.cjs";

const { compareFileSets, isTestFile, scanForbiddenJestCalls, validateResults } = integrityGuard;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jestEntrypoint = path.join(repoRoot, "node_modules", "jest", "bin", "jest.js");
const schema = "screeps-jest-integrity/v1";
const listArgs = ["--config", "jest.config.cjs", "--listTests", "--json"];
const errors = [];

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--help") return { help: true };
    if (flag !== "--output-dir" && flag !== "--results") throw new Error(`Unknown argument ${flag}; Jest filters are not accepted`);
    const value = args[++index];
    if (!value || value.startsWith("--") || options[flag]) throw new Error(`Expected one value for ${flag}`);
    options[flag] = path.resolve(value);
  }
  if (options["--output-dir"] && options["--results"]) throw new Error("--output-dir and --results cannot be combined");
  return options;
}

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceIdentity() {
  const inputFiles = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const file of inputFiles) {
    hash.update(`${file}\0`);
    const absolute = path.join(repoRoot, file);
    if (!fs.existsSync(absolute)) {
      hash.update("missing\0");
      continue;
    }
    hash.update(fs.readFileSync(absolute));
    hash.update("\0");
  }
  return { commit: git(["rev-parse", "HEAD"]).trim(), workspaceSha256: hash.digest("hex") };
}

function discoverDiskTests(directory = repoRoot, results = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) discoverDiskTests(absolute, results);
    else if (entry.isFile()) {
      const relative = path.relative(repoRoot, absolute).split(path.sep).join("/");
      if (isTestFile(relative)) results.push(relative);
    }
  }
  return results.sort();
}

function normalizeTestPath(file, originalRoot = repoRoot) {
  return path.relative(originalRoot, path.resolve(originalRoot, file)).split(path.sep).join("/");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function checkOutputDirectory(directory) {
  const relative = path.relative(repoRoot, directory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
  const ignored = spawnSync("git", ["check-ignore", "--no-index", "-q", "--", `${relative}/`], { cwd: repoRoot });
  if (!relative || ignored.status !== 0) throw new Error("Output directory must be outside the repository or Git-ignored, so artifacts do not change the input fingerprint");
}

function runJest(args, outputDirectory, prefix) {
  const stdout = fs.openSync(path.join(outputDirectory, `${prefix}.stdout.log`), "wx");
  const stderr = fs.openSync(path.join(outputDirectory, `${prefix}.stderr.log`), "wx");
  try {
    const result = spawnSync(process.execPath, [jestEntrypoint, ...args], {
      cwd: repoRoot, stdio: ["ignore", stdout, stderr],
    });
    return { status: result.status, signal: result.signal, error: result.error?.message };
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
}

function verifyArtifacts(resultsPath, currentIdentity, trackedTests, diskTests) {
  const directory = path.dirname(resultsPath);
  const metadata = readJson(path.join(directory, "execution.json"));
  if (metadata.schema !== schema) errors.push("Unsupported or missing integrity artifact schema");
  for (const field of ["commit", "workspaceSha256"]) {
    if (metadata.sourceBefore?.[field] !== currentIdentity[field]
      || metadata.sourceAfter?.[field] !== currentIdentity[field]) {
      errors.push(`Artifact source ${field} does not match the current working tree`);
    }
  }
  const expectedRunArgs = ["--config", "jest.config.cjs", "--runInBand", "--json", `--outputFile=${metadata.resultsPath}`];
  if (JSON.stringify(metadata.listArgs) !== JSON.stringify(listArgs)
    || JSON.stringify(metadata.runArgs) !== JSON.stringify(expectedRunArgs)) {
    errors.push("Artifact commands were not the unfiltered full Jest commands");
  }
  if (metadata.discoveryRun?.status !== 0 || metadata.testRun?.status !== 0
    || metadata.discoveryRun?.signal || metadata.testRun?.signal
    || metadata.discoveryRun?.error || metadata.testRun?.error) {
    errors.push("Artifact Jest discovery or full run did not exit successfully");
  }
  const discoveryText = fs.readFileSync(path.join(directory, "discovered-tests.json"), "utf8");
  const resultsText = fs.readFileSync(resultsPath, "utf8");
  if (digest(discoveryText) !== metadata.discoverySha256 || digest(resultsText) !== metadata.resultsSha256) {
    errors.push("Raw discovery/results digest differs from the recorded run");
  }
  const listed = JSON.parse(discoveryText);
  if (!Array.isArray(listed) || listed.some(file => typeof file !== "string")) throw new Error("Jest discovery must be an array of file paths");
  const listedTests = listed.map(file => normalizeTestPath(file, metadata.repoRoot));
  const results = JSON.parse(resultsText);
  errors.push(...compareFileSets("tracked vs disk", trackedTests, diskTests));
  errors.push(...compareFileSets("tracked vs Jest discovery", trackedTests, listedTests));
  errors.push(...validateResults(trackedTests, results, file => normalizeTestPath(file, metadata.repoRoot)));
  return { suites: results.numTotalTestSuites, cases: results.numTotalTests };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run test:verify -- [--output-dir DIRECTORY | --results DIRECTORY/results.json]");
    console.log("Runs one unfiltered full Jest suite and preserves logs. --results only rechecks that run and its source-bound sidecars.");
    return;
  }
  const trackedFiles = git(["ls-files", "-z"]).split("\0").filter(Boolean).sort();
  const trackedTests = trackedFiles.filter(isTestFile);
  const diskTests = discoverDiskTests();
  errors.push(...compareFileSets("tracked vs disk", trackedTests, diskTests));
  if (trackedTests.length === 0) errors.push("The tracked test inventory is empty");
  for (const file of diskTests) errors.push(...scanForbiddenJestCalls(file, fs.readFileSync(path.join(repoRoot, file), "utf8")));
  const before = sourceIdentity();
  let resultsPath = options["--results"];
  let outputDirectory;
  if (resultsPath) outputDirectory = path.dirname(resultsPath);
  else {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    outputDirectory = options["--output-dir"] || path.join(repoRoot, "monitor-data", "test-integrity", `${stamp}-${process.pid}`);
    checkOutputDirectory(outputDirectory);
    fs.mkdirSync(path.dirname(outputDirectory), { recursive: true });
    fs.mkdirSync(outputDirectory);
    resultsPath = path.join(outputDirectory, "results.json");
  }
  console.log(`JEST_TEST_INTEGRITY_ARTIFACTS=${outputDirectory}`);
  let counts;
  if (errors.length === 0 && !options["--results"]) {
    const discoveryRun = runJest(listArgs, outputDirectory, "discovery");
    const discoveryText = fs.readFileSync(path.join(outputDirectory, "discovery.stdout.log"), "utf8");
    fs.writeFileSync(path.join(outputDirectory, "discovered-tests.json"), discoveryText);
    try {
      const listed = JSON.parse(discoveryText);
      if (!Array.isArray(listed) || listed.some(file => typeof file !== "string")) throw new Error("Expected a path array");
      errors.push(...compareFileSets("tracked vs Jest discovery", trackedTests, listed.map(file => normalizeTestPath(file))));
    } catch (error) {
      errors.push(`Cannot parse Jest discovery: ${error.message}`);
    }
    if (discoveryRun.status !== 0 || discoveryRun.signal || discoveryRun.error) errors.push("Jest discovery did not exit successfully; see discovery.stderr.log");
    if (errors.length === 0) {
      const runArgs = ["--config", "jest.config.cjs", "--runInBand", "--json", `--outputFile=${resultsPath}`];
      const testRun = runJest(runArgs, outputDirectory, "jest");
      writeJson(path.join(outputDirectory, "execution.json"), {
        schema, repoRoot, resultsPath, nodeVersion: process.version,
        sourceBefore: before, sourceAfter: sourceIdentity(),
        listArgs, runArgs, discoveryRun, testRun,
        discoverySha256: digest(discoveryText),
        resultsSha256: fs.existsSync(resultsPath) ? digest(fs.readFileSync(resultsPath)) : null,
      });
      if (!fs.existsSync(resultsPath)) errors.push("Jest did not write results.json; see jest.stderr.log");
    }
  }
  if (errors.length === 0) {
    const currentTests = git(["ls-files", "-z"]).split("\0").filter(isTestFile).sort();
    counts = verifyArtifacts(resultsPath, sourceIdentity(), currentTests, discoverDiskTests());
  }
  const report = {
    status: errors.length ? "JEST_TEST_INTEGRITY=FAILED" : "JEST_TEST_INTEGRITY=PASSED",
    mode: options["--results"] ? "verify-existing" : "run-full",
    source: before, resultsPath, ...counts, errors,
  };
  writeJson(path.join(outputDirectory, options["--results"] ? "reverification.json" : "verification.json"), report);
  console.log(JSON.stringify(report));
  if (errors.length) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`JEST_TEST_INTEGRITY=FAILED: ${error.stack || error}`);
  process.exitCode = 1;
}
