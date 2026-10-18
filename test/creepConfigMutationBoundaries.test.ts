import { dirname, relative, resolve } from "path";
import * as ts from "typescript";

const root = resolve(__dirname, "..");
const configPath = resolve(root, "tsconfig.build.json");
const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
const config = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(configPath), { noEmit: true }, configPath);
const program = ts.createProgram({ rootNames: config.fileNames, options: config.options });
const checker = program.getTypeChecker();
const ownerFiles = new Set(["src/runtime/creepConfigService.ts", "src/runtime/memoryService.ts"]);
const assignments = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken]);

function configType(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some(configType);
  return !!type.getSymbol()?.declarations?.some(declaration => ts.isInterfaceDeclaration(declaration) && declaration.name.text === "CreepConfig" &&
    resolve(declaration.getSourceFile().fileName) === resolve(root, "src/types/system.ts"));
}
function configStoreType(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some(configStoreType);
  const indexed = type.getStringIndexType();
  return !!indexed && configType(indexed);
}
function configTarget(node: ts.Expression): boolean {
  if (configType(checker.getTypeAtLocation(node)) || configStoreType(checker.getTypeAtLocation(node))) return true;
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isNonNullExpression(node)) return configTarget(node.expression);
  return false;
}

function queueTarget(node: ts.Expression, depth = 0): boolean {
  if (depth > 8) return false;
  if (ts.isPropertyAccessExpression(node) && node.name.text === "spawnList") return true;
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) return queueTarget(node.expression, depth + 1);
  if (ts.isBinaryExpression(node)) return queueTarget(node.left, depth + 1);
  if (ts.isIdentifier(node)) return !!checker.getSymbolAtLocation(node)?.declarations?.some(declaration =>
    ts.isVariableDeclaration(declaration) && !!declaration.initializer && queueTarget(declaration.initializer, depth + 1));
  return false;
}

it("配置只能由 owner 写入，生产调用方不得保留可写根或修改 DTO", () => {
  const violations: string[] = [];
  for (const source of program.getSourceFiles()) {
    const file = relative(root, source.fileName).replace(/\\/g, "/");
    if (!file.startsWith("src/") || source.isDeclarationFile || ownerFiles.has(file)) continue;
    const report = (node: ts.Node, reason: string) => violations.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${reason}`);
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && assignments.has(node.operatorToken.kind) && configTarget(node.left)) report(node, "direct config write");
      if (ts.isDeleteExpression(node) && configTarget(node.expression)) report(node, "direct config delete");
      if (file !== "src/runtime/spawnRequests.ts") {
        if (ts.isBinaryExpression(node) && assignments.has(node.operatorToken.kind) && queueTarget(node.left)) report(node, "direct spawn queue write");
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
            ["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"].includes(node.expression.name.text) && queueTarget(node.expression.expression)) report(node, "spawn queue mutation through alias");
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        if (node.expression.name.text === "getCreepConfigStore") report(node, "raw config store access");
        if (["Object.assign", "Object.defineProperty"].includes(node.expression.getText(source)) && node.arguments[0] && configTarget(node.arguments[0])) report(node, "indirect config write");
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});
