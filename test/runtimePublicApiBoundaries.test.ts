import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import * as ts from "typescript";

const root = resolve(__dirname, "..");
const baseline: Record<string, string[]> = JSON.parse(
  readFileSync(resolve(__dirname, "runtimePublicApiBaseline.json"), "utf8"),
);
const asts = new Map<string, ts.SourceFile>();

function resolvesExport(file: string, name: string, seen = new Set<string>()): boolean {
  const key = `${file}:${name}`;
  if (seen.has(key)) return false;
  seen.add(key);
  let ast = asts.get(file);
  if (!ast) {
    ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    asts.set(file, ast);
  }
  for (const statement of ast.statements) {
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier) && statement.exportClause &&
        ts.isNamedExports(statement.exportClause)) {
      const entry = statement.exportClause.elements.find(item => item.name.text === name);
      if (!entry) continue;
      const module = statement.moduleSpecifier.text;
      const target = module.startsWith("@/")
        ? resolve(root, "src", `${module.slice(2)}.ts`)
        : resolve(dirname(file), `${module}.ts`);
      if (resolvesExport(target, entry.propertyName?.text ?? name, seen)) return true;
    }
    if (!ts.canHaveModifiers(statement) ||
        !ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(
      declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name,
    )) return true;
    if ((ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement) ||
         ts.isTypeAliasDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) return true;
  }
  return false;
}

describe("拆分前 public API 的转发链", () => {
  for (const [module, names] of Object.entries(baseline)) {
    it(`${module} 的运行时值及类型仍可解析到实际声明`, () => {
      const file = resolve(root, "src/runtime", `${module}.ts`);
      expect(names.filter(name => !resolvesExport(file, name))).toEqual([]);
    });
  }
});
