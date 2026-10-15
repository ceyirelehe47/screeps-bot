const ts = require("typescript");

// Match the test/spec and __tests__ conventions used by the current Jest config.
function isTestFile(file) {
  return /(?:^|\/)__tests__\/.*\.[jt]sx?$/.test(file) || /\.(?:test|spec)\.[jt]sx?$/.test(file);
}

function compareFileSets(label, expected, actual) {
  const errors = [];
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  if (expectedSet.size !== expected.length || actualSet.size !== actual.length) errors.push(`${label}: duplicate test file paths`);
  const missing = [...expectedSet].filter(file => !actualSet.has(file)).sort();
  const unexpected = [...actualSet].filter(file => !expectedSet.has(file)).sort();
  if (missing.length || unexpected.length) errors.push(`${label}: missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)}`);
  return errors;
}

function scanForbiddenJestCalls(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const roots = new Set(["describe", "it", "test"]);
  const forbiddenAliases = new Set(["fdescribe", "fit", "xdescribe", "xit", "xtest"]);
  const forbiddenModifiers = new Set(["failing", "only", "skip", "todo"]);
  const dynamicMember = "<computed>";
  const aliases = new Map();
  function chain(node) {
    if (ts.isIdentifier(node)) return aliases.get(node.text) || [node.text];
    if (ts.isPropertyAccessExpression(node)) {
      const parent = chain(node.expression);
      return parent && [...parent, node.name.text];
    }
    if (ts.isElementAccessExpression(node)) {
      const parent = chain(node.expression);
      const member = node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)
        ? node.argumentExpression.text : dynamicMember;
      return parent && [...parent, member];
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "require"
        && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])
        && node.arguments[0].text === "@jest/globals") return ["jestGlobals"];
      return chain(node.expression);
    }
    if (ts.isTaggedTemplateExpression(node)) return chain(node.tag);
    if (ts.isParenthesizedExpression(node)) return chain(node.expression);
    return null;
  }
  function canonical(parts) {
    return parts && ["global", "globalThis", "jestGlobals"].includes(parts[0]) ? parts.slice(1) : parts;
  }
  function collectAliases(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === "@jest/globals") {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) aliases.set(specifier.name.text, [specifier.propertyName?.text || specifier.name.text]);
      } else if (bindings && ts.isNamespaceImport(bindings)) aliases.set(bindings.name.text, ["jestGlobals"]);
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const original = chain(node.initializer);
      if (original && ts.isIdentifier(node.name)) aliases.set(node.name.text, original);
      else if (original && ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (ts.isIdentifier(element.name) && !element.dotDotDotToken) {
            const property = element.propertyName;
            const member = property && ts.isComputedPropertyName(property)
              ? ts.isStringLiteralLike(property.expression) ? property.expression.text : dynamicMember
              : property?.text || element.name.text;
            aliases.set(element.name.text, [...original, member]);
          }
        }
      }
    }
    ts.forEachChild(node, collectAliases);
  }
  collectAliases(source);
  const findings = new Set();
  function record(node, parts) {
    const normalized = canonical(parts);
    if (!normalized) return;
    const [root, ...members] = normalized;
    // A computed Jest member can select failing/skip/only without exposing that
    // modifier in the raw results; require an explicit member instead.
    if ((roots.has(root) && members.includes(dynamicMember))
      || (parts[0] === "jestGlobals" && parts[1] === dynamicMember)) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      findings.add(`dynamic Jest member: ${file}:${position.line + 1}:${position.character + 1} ${normalized.join(".")}`);
    }
    if (forbiddenAliases.has(root) || (roots.has(root) && members.some(member => forbiddenModifiers.has(member)))) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      findings.add(`forbidden Jest modifier: ${file}:${position.line + 1}:${position.character + 1} ${normalized.join(".")}`);
    }
  }
  function visit(node) {
    if (ts.isCallExpression(node)) record(node, chain(node.expression));
    else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) record(node, chain(node));
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...findings];
}

function validateResults(expectedFiles, results, normalize = file => file) {
  const errors = [];
  if (!results || !Array.isArray(results.testResults)) return ["Missing raw Jest testResults array"];
  const suites = results.testResults;
  errors.push(...compareFileSets("tracked vs raw Jest results", expectedFiles, suites.map(suite => normalize(suite.name))));
  let cases = 0;
  for (const suite of suites) {
    const name = normalize(suite.name);
    const assertions = suite.assertionResults;
    if (suite.status !== "passed" || suite.testExecError || suite.failureMessage) errors.push(`${name}: suite did not pass cleanly`);
    if (!Array.isArray(assertions) || assertions.length === 0) {
      errors.push(`${name}: suite has no executed test cases`);
      continue;
    }
    cases += assertions.length;
    for (const assertion of assertions) {
      if (assertion.status !== "passed") errors.push(`${name}: non-passed test case ${assertion.fullName || assertion.title || "(unnamed)"} (${assertion.status})`);
    }
  }
  if (!expectedFiles.length || !cases) errors.push("Full Jest results must contain test files and executed cases");
  if (results.success !== true || results.wasInterrupted !== false) errors.push("Jest run was unsuccessful or interrupted");
  const summary = {
    numTotalTestSuites: expectedFiles.length, numPassedTestSuites: expectedFiles.length,
    numFailedTestSuites: 0, numPendingTestSuites: 0, numRuntimeErrorTestSuites: 0,
    numTotalTests: cases, numPassedTests: cases,
    numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
  };
  for (const [field, expected] of Object.entries(summary)) {
    if (results[field] !== expected) errors.push(`${field} ${String(results[field])} != ${expected}`);
  }
  return errors;
}

module.exports = { compareFileSets, isTestFile, scanForbiddenJestCalls, validateResults };
