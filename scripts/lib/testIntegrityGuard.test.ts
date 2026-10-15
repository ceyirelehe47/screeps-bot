export {};

const { compareFileSets, isTestFile, scanForbiddenJestCalls, validateResults } = require("./testIntegrityGuard.cjs");

function passingResults() {
  return {
    success: true, wasInterrupted: false,
    numTotalTestSuites: 1, numPassedTestSuites: 1,
    numFailedTestSuites: 0, numPendingTestSuites: 0, numRuntimeErrorTestSuites: 0,
    numTotalTests: 1, numPassedTests: 1,
    numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    testResults: [{ name: "src/example.test.ts", status: "passed", assertionResults: [{ title: "runs", status: "passed" }] }],
  };
}

describe("Jest 完整性守卫", () => {
  it("识别当前 Jest 命名约定并拒绝漏文件、额外文件和重复结果", () => {
    expect(["src/a.test.ts", "src/a.spec.jsx", "src/__tests__/a.ts"].every(isTestFile)).toBe(true);
    expect(isTestFile("test/mock/a.ts")).toBe(false);
    expect(compareFileSets("inventory", ["a", "b"], ["a", "b"])).toEqual([]);
    expect(compareFileSets("inventory", ["a", "b"], ["a"]).join("\n")).toContain('missing=["b"]');
    expect(compareFileSets("inventory", ["a"], ["a", "b"]).join("\n")).toContain('unexpected=["b"]');
    expect(compareFileSets("inventory", ["a"], ["a", "a"]).join("\n")).toContain("duplicate");
    const missing = passingResults();
    missing.testResults = [];
    expect(validateResults(["src/example.test.ts"], missing).join("\n")).toContain("missing=");
  });

  it("接受通过的非空套件，拒绝空结果和伪装 passed 的空套件", () => {
    expect(validateResults(["src/example.test.ts"], passingResults())).toEqual([]);
    expect(validateResults(["src/example.test.ts"], {}).join("\n")).toContain("Missing raw Jest");
    const empty = passingResults();
    empty.testResults[0].assertionResults = [];
    empty.numTotalTests = 0;
    empty.numPassedTests = 0;
    expect(validateResults(["src/example.test.ts"], empty).join("\n")).toContain("no executed test cases");
  });

  it("拒绝跳过用例、运行期错误和不一致的全局汇总", () => {
    const skipped = passingResults();
    skipped.testResults[0].assertionResults[0].status = "pending";
    skipped.numPendingTests = 1;
    expect(validateResults(["src/example.test.ts"], skipped).join("\n")).toContain("non-passed test case");
    const runtime = passingResults();
    runtime.numRuntimeErrorTestSuites = 1;
    expect(validateResults(["src/example.test.ts"], runtime).join("\n")).toContain("numRuntimeErrorTestSuites");
    const inconsistent = passingResults();
    inconsistent.numPassedTests = 2;
    expect(validateResults(["src/example.test.ts"], inconsistent).join("\n")).toContain("numPassedTests");
  });

  it("AST 检查链式和别名，且不把字符串注释当禁用调用", () => {
    const samples = [
      ['test.skip.each([1])("x", () => {});', "test.skip.each"],
      ['describe.only("x", () => {});', "describe.only"],
      ['test.todo("later");', "test.todo"],
      ['test.failing("x", () => {});', "test.failing"],
      ['fit("x", () => {});', "fit"],
      ['xdescribe("x", () => {});', "xdescribe"],
      ['import { test as check } from "@jest/globals"; check.only("x", () => {});', "test.only"],
      ['const { test: check } = require("@jest/globals"); check.only("x", () => {});', "test.only"],
      ['const { skip: omit } = test; omit("x", () => {});', "test.skip"],
      ['const check = test; check["skip"]("x", () => {});', "test.skip"],
      ['const modifier = "failing"; test[modifier]("x", () => { throw new Error("expected"); });', "dynamic Jest member:"],
      ['const globals = require("@jest/globals"); const modifier = "failing"; globals.test[modifier]("x", () => {});', "dynamic Jest member:"],
      ['import * as globals from "@jest/globals"; const method = "test"; globals[method].failing("x", () => { throw new Error("expected"); });', "dynamic Jest member:"],
      ['const key = "test"; const { [key]: check } = require("@jest/globals"); check.failing("x", () => { throw new Error("expected"); });', "dynamic Jest member:"],
    ];
    for (const [source, expected] of samples) expect(scanForbiddenJestCalls("fixture.test.ts", source).join("\n")).toContain(expected);
    expect(scanForbiddenJestCalls("fixture.test.ts", '/* test.skip("x") */ const text = "fit()"; test("x", () => expect(text).toBe("fit()"));')).toEqual([]);
    expect(scanForbiddenJestCalls("fixture.test.ts", 'const globals = globalThis; const key = "example"; globals[key] = 1; test("x", () => {});')).toEqual([]);
    expect(scanForbiddenJestCalls("fixture.test.ts", 'import * as globals from "@jest/globals"; const spy = globals.jest.fn(); spy(); globals.expect(spy.mock.calls[0]).toEqual([]);')).toEqual([]);
  });
});
