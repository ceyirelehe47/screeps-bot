import { dirname, relative, resolve } from "node:path";
import * as ts from "typescript";

const REPO_ROOT = resolve(__dirname, "..");
const BUILD_CONFIG_PATH = resolve(REPO_ROOT, "tsconfig.build.json");
const CATALOG_PATH = "src/types/roleCatalog.ts";
const SYSTEM_PATH = "src/types/system.ts";
const ROLE_REGISTRY_PATH = "src/roles/index.ts";
const SPAWN_PROFILES_PATH = "src/config/spawnProfiles.ts";
const MEMORY_CLEANUP_PATH = "src/runtime/memoryCleanup.ts";

const EXPECTED_ROLE_STATUSES = {
  harvester: "active",
  mineralHarvester: "active",
  miner: "active",
  carrier: "active",
  worker: "active",
  upgrader: "active",
  hubUpgrader: "legacy",
  scout: "active",
  claimer: "active",
  colonizerHarvester: "active",
  colonizerWorker: "active",
  meleeAttacker: "active",
  healer: "active",
  homeDefender: "active",
  crossShardClaimer: "active",
  crossShardColonizerHarvester: "active",
  crossShardColonizerWorker: "active",
  flagScout: "active",
  remoteCarrier: "active",
  remoteMiningCarrier: "active",
  powerBankScout: "active",
  powerBankAttacker: "active",
  powerBankHealer: "active",
  powerBankHauler: "active",
  depositHarvester: "active",
  remoteMiningReserver: "active",
  remoteWorker: "active",
  remoteDefender: "active",
} as const;

const EXPECTED_ROLE_NAMES = Object.keys(EXPECTED_ROLE_STATUSES).sort();

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function repositoryPath(value: string): string {
  return normalizePath(relative(REPO_ROOT, value));
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => REPO_ROOT,
    getNewLine: () => "\n",
  });
}

function parseBuildConfig(): ts.ParsedCommandLine {
  const loaded = ts.readConfigFile(BUILD_CONFIG_PATH, ts.sys.readFile);
  if (loaded.error) {
    throw new Error(formatDiagnostics([loaded.error]));
  }

  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    dirname(BUILD_CONFIG_PATH),
    { noEmit: true },
    BUILD_CONFIG_PATH,
  );
  if (parsed.errors.length > 0) {
    throw new Error(formatDiagnostics(parsed.errors));
  }
  return parsed;
}

const buildConfig = parseBuildConfig();
const productionProgram = ts.createProgram({
  rootNames: buildConfig.fileNames,
  options: buildConfig.options,
});
const typeChecker = productionProgram.getTypeChecker();

function productionSourceFile(fileName: string): ts.SourceFile {
  const absolutePath = resolve(REPO_ROOT, fileName);
  const sourceRoot = `${normalizePath(resolve(REPO_ROOT, "src"))}/`;
  if (!normalizePath(absolutePath).startsWith(sourceRoot)) {
    throw new Error(`Architecture boundary must inspect a production src file: ${fileName}`);
  }

  const sourceFile = productionProgram
    .getSourceFiles()
    .find((candidate) => normalizePath(resolve(candidate.fileName)) === normalizePath(absolutePath));
  if (!sourceFile) {
    throw new Error(`${fileName} is not present in the tsconfig.build.json production Program`);
  }
  if (sourceFile.isDeclarationFile) {
    throw new Error(`${fileName} unexpectedly resolved to a declaration file`);
  }
  return sourceFile;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function exportedConstInitializer(sourceFile: ts.SourceFile, name: string): ts.Expression {
  for (const statement of sourceFile.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
      (statement.declarationList.flags & ts.NodeFlags.Const) === 0
    ) {
      continue;
    }

    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
        return declaration.initializer;
      }
    }
  }
  throw new Error(`${repositoryPath(sourceFile.fileName)} must export const ${name}`);
}

function objectLiteralInitializer(sourceFile: ts.SourceFile, name: string): ts.ObjectLiteralExpression {
  let initializer = unwrapExpression(exportedConstInitializer(sourceFile, name));
  if (
    ts.isCallExpression(initializer) &&
    initializer.arguments.length === 1 &&
    ts.isPropertyAccessExpression(initializer.expression) &&
    ts.isIdentifier(initializer.expression.expression) &&
    initializer.expression.expression.text === "Object" &&
    initializer.expression.name.text === "freeze"
  ) {
    initializer = unwrapExpression(initializer.arguments[0]);
  }

  if (!ts.isObjectLiteralExpression(initializer)) {
    throw new Error(`${repositoryPath(sourceFile.fileName)}:${name} must use a static object literal`);
  }
  return initializer;
}

function staticPropertyName(property: ts.PropertyName): string {
  if (ts.isIdentifier(property) || ts.isStringLiteralLike(property) || ts.isNumericLiteral(property)) {
    return property.text;
  }
  throw new Error(`Computed property is not allowed in a role identity table: ${property.getText()}`);
}

function staticObjectEntries(
  sourceFile: ts.SourceFile,
  name: string,
): ReadonlyArray<readonly [string, ts.Expression]> {
  const objectLiteral = objectLiteralInitializer(sourceFile, name);
  const entries = objectLiteral.properties.map((property): readonly [string, ts.Expression] => {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(
        `${repositoryPath(sourceFile.fileName)}:${name} may contain only explicit property assignments`,
      );
    }
    return [staticPropertyName(property.name), property.initializer];
  });
  const uniqueKeys = new Set(entries.map(([key]) => key));
  if (uniqueKeys.size !== entries.length) {
    throw new Error(`${repositoryPath(sourceFile.fileName)}:${name} contains duplicate role keys`);
  }
  return entries;
}

function moduleDependencies(sourceFile: ts.SourceFile): string[] {
  const dependencies: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      dependencies.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      dependencies.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === "require") ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      dependencies.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return dependencies;
}

function identifiersNamed(sourceFile: ts.SourceFile, names: ReadonlySet<string>): string[] {
  const matches: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && names.has(node.text)) {
      matches.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return matches;
}

function screepsAmbientIdentifiers(sourceFile: ts.SourceFile): string[] {
  const matches = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const declarationPaths = symbolDeclarationPaths(typeChecker.getSymbolAtLocation(node));
      if (declarationPaths.some((path) => path.startsWith("node_modules/@types/screeps/"))) {
        matches.add(node.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...matches].sort();
}

function resolvedSymbol(symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  if (!symbol) {
    return undefined;
  }
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? typeChecker.getAliasedSymbol(symbol) : symbol;
}

function symbolDeclarationPaths(symbol: ts.Symbol | undefined): string[] {
  return (resolvedSymbol(symbol)?.declarations ?? [])
    .map((declaration) => repositoryPath(declaration.getSourceFile().fileName))
    .sort();
}

function isConfigRole(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression);
  return (
    ts.isPropertyAccessExpression(unwrapped) &&
    ts.isIdentifier(unwrapped.expression) &&
    unwrapped.expression.text === "config" &&
    unwrapped.name.text === "role"
  );
}

function isConfigStoreDelete(node: ts.Node): boolean {
  if (!ts.isDeleteExpression(node)) {
    return false;
  }
  const target = unwrapExpression(node.expression);
  return (
    ts.isElementAccessExpression(target) &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === "configStore" &&
    !!target.argumentExpression &&
    ts.isIdentifier(unwrapExpression(target.argumentExpression)) &&
    (unwrapExpression(target.argumentExpression) as ts.Identifier).text === "configName"
  );
}

function containsNode(root: ts.Node, predicate: (node: ts.Node) => boolean): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (predicate(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

describe("role identity catalog architecture boundaries", () => {
  test("all inspected files belong to the production TypeScript Program", () => {
    expect([
      CATALOG_PATH,
      SYSTEM_PATH,
      ROLE_REGISTRY_PATH,
      SPAWN_PROFILES_PATH,
      MEMORY_CLEANUP_PATH,
    ].map((fileName) => repositoryPath(productionSourceFile(fileName).fileName))).toEqual([
      CATALOG_PATH,
      SYSTEM_PATH,
      ROLE_REGISTRY_PATH,
      SPAWN_PROFILES_PATH,
      MEMORY_CLEANUP_PATH,
    ]);
  });

  test("catalog is dependency-free and contains only the canonical identity statuses", () => {
    const catalog = productionSourceFile(CATALOG_PATH);
    expect(moduleDependencies(catalog)).toEqual([]);
    expect(identifiersNamed(catalog, new Set(["Game", "Memory", "global", "globalThis"]))).toEqual([]);
    expect(screepsAmbientIdentifiers(catalog)).toEqual([]);

    expect(screepsAmbientIdentifiers(productionSourceFile(SPAWN_PROFILES_PATH))).toEqual(
      expect.arrayContaining(["CARRY", "MOVE", "WORK"]),
    );

    const moduleSymbol = typeChecker.getSymbolAtLocation(catalog);
    const exportNames = moduleSymbol
      ? typeChecker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.name).sort()
      : [];
    expect(exportNames).toEqual(expect.arrayContaining(["ROLE_CATALOG", "RoleName", "isRoleName"]));
    expect(exportNames.filter((name) => ![
      "ROLE_CATALOG",
      "RoleLifecycleStatus",
      "RoleName",
      "isRoleName",
    ].includes(name))).toEqual([]);

    const entries = staticObjectEntries(catalog, "ROLE_CATALOG");
    const statuses = Object.fromEntries(entries.map(([role, initializer]) => {
      const status = unwrapExpression(initializer);
      if (!ts.isStringLiteralLike(status)) {
        throw new Error(`ROLE_CATALOG.${role} must be a literal lifecycle status`);
      }
      if (status.text !== "active" && status.text !== "legacy") {
        throw new Error(`ROLE_CATALOG.${role} has unsupported lifecycle status ${status.text}`);
      }
      return [role, status.text];
    }));

    expect(Object.keys(statuses).sort()).toEqual(EXPECTED_ROLE_NAMES);
    expect(statuses).toEqual(EXPECTED_ROLE_STATUSES);
  });

  test("system keeps the RoleName import ABI by type-re-exporting the catalog type", () => {
    const system = productionSourceFile(SYSTEM_PATH);
    const localRoleAliases: ts.TypeAliasDeclaration[] = [];
    const roleReExports: ts.ExportSpecifier[] = [];

    for (const statement of system.statements) {
      if (ts.isTypeAliasDeclaration(statement) && statement.name.text === "RoleName") {
        localRoleAliases.push(statement);
      }
      if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteralLike(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "@/types/roleCatalog" &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const element of statement.exportClause.elements) {
          if (element.name.text === "RoleName" && (statement.isTypeOnly || element.isTypeOnly)) {
            roleReExports.push(element);
          }
        }
      }
    }

    expect(localRoleAliases).toEqual([]);
    expect(roleReExports).toHaveLength(1);

    const moduleSymbol = typeChecker.getSymbolAtLocation(system);
    const exportedRoleName = moduleSymbol
      ? typeChecker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === "RoleName")
      : undefined;
    expect(exportedRoleName).toBeDefined();
    expect(symbolDeclarationPaths(exportedRoleName)).toContain(CATALOG_PATH);
  });

  test("catalog, role registry, and spawn profiles expose the same exact role keys", () => {
    const catalogKeys = staticObjectEntries(
      productionSourceFile(CATALOG_PATH),
      "ROLE_CATALOG",
    ).map(([role]) => role).sort();
    const registryKeys = staticObjectEntries(
      productionSourceFile(ROLE_REGISTRY_PATH),
      "roleRegistry",
    ).map(([role]) => role).sort();
    const profileKeys = staticObjectEntries(
      productionSourceFile(SPAWN_PROFILES_PATH),
      "spawnProfiles",
    ).map(([role]) => role).sort();

    expect(catalogKeys).toEqual(EXPECTED_ROLE_NAMES);
    expect(registryKeys).toEqual(EXPECTED_ROLE_NAMES);
    expect(profileKeys).toEqual(EXPECTED_ROLE_NAMES);
    expect(registryKeys).toEqual(catalogKeys);
    expect(profileKeys).toEqual(catalogKeys);
  });

  test("memory cleanup validates config roles through the catalog guard", () => {
    const cleanup = productionSourceFile(MEMORY_CLEANUP_PATH);
    expect(identifiersNamed(cleanup, new Set(["VALID_ROLES"]))).toEqual([]);

    const guardImports = cleanup.statements.filter((statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "@/types/roleCatalog" &&
      !!statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some((element) =>
        element.name.text === "isRoleName" && (element.propertyName?.text ?? element.name.text) === "isRoleName"),
    );
    expect(guardImports).toHaveLength(1);

    const cleanupFunction = cleanup.statements.find((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "cleanupUnknownRoleConfigMemory",
    );
    expect(cleanupFunction).toBeDefined();

    const guardedDeletes: ts.IfStatement[] = [];
    if (cleanupFunction?.body) {
      const visit = (node: ts.Node): void => {
        if (ts.isIfStatement(node)) {
          const condition = unwrapExpression(node.expression);
          if (
            ts.isPrefixUnaryExpression(condition) &&
            condition.operator === ts.SyntaxKind.ExclamationToken
          ) {
            const call = unwrapExpression(condition.operand);
            if (
              ts.isCallExpression(call) &&
              ts.isIdentifier(call.expression) &&
              call.expression.text === "isRoleName" &&
              call.arguments.length === 1 &&
              isConfigRole(call.arguments[0]) &&
              symbolDeclarationPaths(typeChecker.getSymbolAtLocation(call.expression)).includes(CATALOG_PATH) &&
              containsNode(node.thenStatement, isConfigStoreDelete)
            ) {
              guardedDeletes.push(node);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(cleanupFunction.body);
    }

    expect(guardedDeletes).toHaveLength(1);
  });
});
