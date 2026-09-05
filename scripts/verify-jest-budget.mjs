import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repoRoot, "test", "test-suite-budget.json");
const jestEntrypoint = path.join(repoRoot, "node_modules", "jest", "bin", "jest.js");
const ignoredDirectories = new Set([".git", ".worktrees", "dist", "monitor-data", "node_modules"]);
// 【Core Rewrite I】新基线：旧 Treasury 多 store 协议套件退役（216/1099，
// 见 openspec/changes/empire-treasury-core-rewrite/test-migration-map.md）。
const requiredBaselineCommit = "ad50c03e3bb459179c2c5dd6cb4dbd4526428ae6";
const requiredTarget = Object.freeze({
  suites: 218,
  tests: 1163,
  passed: 1163,
  failed: 0,
  pending: 0,
  todo: 0,
});
const requiredProtectedFiles = Object.freeze([
  "src/main.test.ts",
  "src/movement/routing.segmentCache.test.ts",
  "src/runtime/bootstrapArchitecture.test.ts",
  "src/runtime/externalTelemetry.test.ts",
  "src/runtime/linkNetworkMemoryOwnership.test.ts",
  "src/runtime/marketWriteArchitecture.test.ts",
  "test/ambientGlobalAbiBoundaries.test.ts",
  "test/localDispatchArchitectureBoundaries.test.ts",
  "test/localDispatchPerformanceBaseline.test.ts",
  "test/memoryDeclarationBoundaries.test.ts",
  "test/roleIdentityCatalogBoundaries.test.ts",
  "test/taskSystemArchitectureBoundaries.test.ts",
  "test/taskSystemCatalogBoundaries.test.ts",
  "test/typescriptConfigBoundaries.test.ts",
  "test/warWorkflowLifecycleBoundaries.test.ts"
]);
const forbiddenJestModifiers = new Set(["failing", "only", "skip", "todo"]);
const forbiddenJestAliases = new Set(["fdescribe", "fit", "xdescribe", "xit", "xtest"]);
const jestRoots = new Set(["describe", "it", "test"]);

function normalizeRelative(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function compareFileSets(label, expected, actual, errors) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = sorted([...expectedSet].filter(file => !actualSet.has(file)));
  const unexpected = sorted([...actualSet].filter(file => !expectedSet.has(file)));
  if (missing.length > 0 || unexpected.length > 0) {
    errors.push(`${label}: missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)}`);
  }
}

function discoverRepositoryTests(directory = repoRoot, results = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        discoverRepositoryTests(path.join(directory, entry.name), results);
      }
      continue;
    }
    if (entry.isFile() && /\.test\.(?:ts|tsx|js|jsx)$/.test(entry.name)) {
      results.push(normalizeRelative(path.join(directory, entry.name)));
    }
  }
  return results;
}

function readBaselineTestFiles() {
  return sorted(execFileSync("git", ["ls-tree", "-r", "--name-only", requiredBaselineCommit], {
    cwd: repoRoot,
    encoding: "utf8"
  }).split("\n").filter(file => /\.test\.(?:ts|tsx|js|jsx)$/.test(file)));
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function expressionChain(expression) {
  if (ts.isIdentifier(expression)) return [expression.text];
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = expressionChain(expression.expression);
    return parent ? [...parent, expression.name.text] : null;
  }
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression && ts.isStringLiteralLike(expression.argumentExpression)) {
    const parent = expressionChain(expression.expression);
    return parent ? [...parent, expression.argumentExpression.text] : null;
  }
  if (ts.isCallExpression(expression)) return expressionChain(expression.expression);
  if (ts.isTaggedTemplateExpression(expression)) return expressionChain(expression.tag);
  return null;
}

function scanForbiddenJestCalls(file, errors) {
  const absolutePath = path.join(repoRoot, file);
  const sourceText = fs.readFileSync(absolutePath, "utf8");
  const scriptKind = file.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : file.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : file.endsWith(".js")
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const findings = new Set();
  function recordChain(node, chain) {
    if (!chain) return;
    const [root, ...members] = chain;
    if (forbiddenJestAliases.has(root) || (jestRoots.has(root) && members.some(member => forbiddenJestModifiers.has(member)))) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      findings.add(`${file}:${position.line + 1}:${position.character + 1} ${chain.join(".")}`);
    }
  }
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const chain = expressionChain(node.expression);
      recordChain(node, chain);
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      recordChain(node, expressionChain(node));
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  for (const finding of findings) errors.push(`forbidden Jest modifier: ${finding}`);
}

function runJest(args, options = {}) {
  return spawnSync(process.execPath, [jestEntrypoint, "--config", "jest.config.cjs", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    ...options
  });
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.schema !== "screeps-jest-test-budget/v1") {
  throw new Error(`Unsupported test budget schema: ${String(manifest.schema)}`);
}

const manifestFiles = sorted(Object.keys(manifest.files));
const manifestBudget = Object.values(manifest.files)
  .reduce((sum, entry) => sum + Number(entry.budget || 0), 0);
const errors = [];

if (manifest.baseline?.commit !== requiredBaselineCommit) {
  errors.push(`manifest baseline commit ${String(manifest.baseline?.commit)} != required ${requiredBaselineCommit}`);
}
for (const [field, expected] of Object.entries(requiredTarget)) {
  if (manifest.target?.[field] !== expected) {
    errors.push(`manifest target ${field} ${String(manifest.target?.[field])} != required ${expected}`);
  }
}
if (manifestFiles.length !== requiredTarget.suites) {
  errors.push(`manifest suite total ${manifestFiles.length} != required ${requiredTarget.suites}`);
}
if (manifestBudget !== requiredTarget.tests) {
  errors.push(`manifest test total ${manifestBudget} != required ${requiredTarget.tests}`);
}
for (const [file, entry] of Object.entries(manifest.files)) {
  if (!Number.isInteger(entry.budget) || entry.budget < 1) {
    errors.push(`${file}: invalid budget ${String(entry.budget)}`);
  }
}
for (const file of requiredProtectedFiles) {
  if (manifest.files[file]?.tier !== "protected-full") {
    errors.push(`${file}: required protected-full tier is missing`);
    continue;
  }
  const current = fs.readFileSync(path.join(repoRoot, file));
  const baseline = execFileSync("git", ["show", `${requiredBaselineCommit}:${file}`], {
    cwd: repoRoot
  });
  if (hash(current) !== hash(baseline)) {
    errors.push(`${file}: protected content differs from ${requiredBaselineCommit}`);
  }
}

const repositoryTests = sorted(discoverRepositoryTests());
const baselineTests = readBaselineTestFiles();
compareFileSets(`repository vs ${requiredBaselineCommit}`, baselineTests, repositoryTests, errors);
compareFileSets(`manifest vs ${requiredBaselineCommit}`, baselineTests, manifestFiles, errors);
compareFileSets("repository vs manifest", manifestFiles, repositoryTests, errors);
for (const file of repositoryTests) scanForbiddenJestCalls(file, errors);

const listRun = runJest(["--listTests", "--json"]);
if (listRun.status !== 0) {
  errors.push(`jest --listTests exited ${String(listRun.status)}: ${listRun.stderr.trim()}`);
}
let listedTests = [];
try {
  listedTests = sorted(JSON.parse(listRun.stdout || "[]").map(normalizeRelative));
} catch (error) {
  errors.push(`unable to parse jest --listTests JSON: ${error instanceof Error ? error.message : String(error)}`);
}
compareFileSets("jest discovery vs manifest", manifestFiles, listedTests, errors);

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "screeps-jest-budget-"));
const resultsPath = path.join(temporaryDirectory, "results.json");
let testRun;
let results;
try {
  testRun = runJest(["--runInBand", "--json", `--outputFile=${resultsPath}`], {
    stdio: ["ignore", "inherit", "inherit"]
  });
  if (!fs.existsSync(resultsPath)) {
    errors.push(`Jest did not write ${resultsPath}`);
  } else {
    results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  }
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

if (testRun?.status !== 0) {
  errors.push(`full Jest exited ${String(testRun?.status)}`);
}

if (results) {
  const summaryChecks = [
    ["numTotalTestSuites", requiredTarget.suites],
    ["numPassedTestSuites", requiredTarget.suites],
    ["numFailedTestSuites", 0],
    ["numPendingTestSuites", 0],
    ["numRuntimeErrorTestSuites", 0],
    ["numTotalTests", requiredTarget.tests],
    ["numPassedTests", requiredTarget.passed],
    ["numFailedTests", requiredTarget.failed],
    ["numPendingTests", requiredTarget.pending],
    ["numTodoTests", requiredTarget.todo]
  ];
  for (const [field, expected] of summaryChecks) {
    if (results[field] !== expected) {
      errors.push(`${field} ${String(results[field])} != ${String(expected)}`);
    }
  }

  const resultFiles = sorted(results.testResults.map(result => normalizeRelative(result.name)));
  compareFileSets("Jest results vs manifest", manifestFiles, resultFiles, errors);

  for (const result of results.testResults) {
    const file = normalizeRelative(result.name);
    const budget = manifest.files[file]?.budget;
    const assertions = result.assertionResults || [];
    if (assertions.length !== budget) {
      errors.push(`${file}: actual ${assertions.length} != budget ${String(budget)}`);
    }
    const nonPassed = assertions.filter(assertion => assertion.status !== "passed");
    if (nonPassed.length > 0) {
      errors.push(`${file}: ${nonPassed.length} assertions were not passed`);
    }
  }
}

if (errors.length > 0) {
  console.error("JEST_TEST_BUDGET=FAILED");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    status: "JEST_TEST_BUDGET=PASSED",
    suites: requiredTarget.suites,
    tests: requiredTarget.tests,
    manifest: normalizeRelative(manifestPath)
  }));
}
