import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";

/** 新的导出入口默认需要失效；只读查询和不改承诺事实的 schema/诊断入口显式登记。 */
const NON_COMMITMENT_WRITERS: Record<string, readonly string[]> = {
  "src/runtime/logistics/resourceTransferTasks.ts": [
    "getResourceTransferTaskListSorted", "listResourceTransferTasks", "getOutgoingResourceTransferAmount",
    "createResourceTransferTaskAmountIndex", "getIncomingResourceTransferAmount", "countPendingOutgoingResourceTransferTasksByRoom",
    "countPendingIncomingResourceTransferTasksByRoom", "countDemandCoveringIncomingResourceTransferTasksByRoom",
  ],
  "src/runtime/resourceReservation.ts": [
    "readReservationMutationCounters", "resetReservationMutationCountersForTest", "makeReservationStoreKey",
    "ensureReservationSchemaActivated", "getReservedProductionAmount", "getReservedProductionAmountExcludingHolder",
    "getReservedProductionAmountExcludingOwner", "listProductionReservations", "isReservationOwnerMigrationComplete",
    "validateReservationStoreHealth",
  ],
};
function parseFunctions(text: string): Map<string, { exported: boolean; node: ts.FunctionDeclaration; calls: Set<string> }> {
  const source = ts.createSourceFile("owner.ts", text, ts.ScriptTarget.Latest, true);
  const functions = new Map<string, { exported: boolean; node: ts.FunctionDeclaration; calls: Set<string> }>();
  for (const node of source.statements) {
    if (!ts.isFunctionDeclaration(node) || !node.name || !node.body) continue;
    const calls = new Set<string>();
    const visit = (child: ts.Node) => {
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) calls.add(child.expression.text);
      ts.forEachChild(child, visit);
    };
    visit(node.body);
    functions.set(node.name.text, { exported: !!node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword), node, calls });
  }
  return functions;
}
function reachesInvalidation(functions: ReturnType<typeof parseFunctions>, name: string, seen = new Set<string>()): boolean {
  if (name === "bumpTreasuryCommitmentRevision") return true;
  if (seen.has(name)) return false;
  seen.add(name);
  return [...(functions.get(name)?.calls ?? [])].some(called => reachesInvalidation(functions, called, seen));
}
describe("Treasury 承诺失效的权威写入口", () => {
  for (const [file, exemptions] of Object.entries(NON_COMMITMENT_WRITERS)) {
    it(`${file} 导出写入口直接或经本模块委托通知失效`, () => {
      const functions = parseFunctions(readFileSync(resolve(__dirname, "..", file), "utf8"));
      const violations = [...functions].filter(([name, entry]) => entry.exported && !exemptions.includes(name) && !reachesInvalidation(functions, name)).map(([name]) => name);
      expect(violations).toEqual([]);
    });
  }
  it("Hub 重规划只调用任务所有者，不直接修改任务字段", () => {
    const functions = parseFunctions(readFileSync(resolve(__dirname, "../src/runtime/hubPlanner.ts"), "utf8"));
    const entry = functions.get("cancelStaleSynthesisRouteTasks")!;
    expect(entry.calls.has("cancelAutomaticResourceTransferTaskForReplan")).toBe(true);
    const writes: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isPropertyAccessExpression(node.left) &&
          ts.isIdentifier(node.left.expression) && node.left.expression.text === "task") writes.push(node.left.name.text);
      ts.forEachChild(node, visit);
    };
    visit(entry.node);
    expect(writes).toEqual([]);
  });
  it("守护能发现委托链漏 bump，而不要求包装器重复 bump", () => {
    const good = "export function cancel(){ mutate(); } function mutate(){ bumpTreasuryCommitmentRevision(); }";
    expect(reachesInvalidation(parseFunctions(good), "cancel")).toBe(true);
    expect(reachesInvalidation(parseFunctions(good.replace("bumpTreasuryCommitmentRevision();", "")), "cancel")).toBe(false);
  });
});
