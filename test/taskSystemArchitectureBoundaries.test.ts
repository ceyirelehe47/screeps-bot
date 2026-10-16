import { dirname, relative, resolve } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import * as ts from "typescript";

const REPO_ROOT = resolve(__dirname, "..");
const BUILD_CONFIG_PATH = resolve(REPO_ROOT, "tsconfig.build.json");
const MAIN_PATH = "src/main.ts";
const TASK_SYSTEM_ROOT = "src/runtime/taskSystem";
const CATALOG_PATH = `${TASK_SYSTEM_ROOT}/catalog.ts`;
const REGISTRY_PATH = `${TASK_SYSTEM_ROOT}/registry.ts`;
const SNAPSHOT_PATH = `${TASK_SYSTEM_ROOT}/snapshot.ts`;
const ADAPTER_ROOT = `${TASK_SYSTEM_ROOT}/adapters`;
const KNOWN_ROLLUP_JAVASCRIPT_PATHS = [
  "src/modules/autoplanner/MinCut.js",
  "src/modules/autoplanner/RoomVisual.js",
  "src/modules/autoplanner/planner.js",
] as const;
const PRODUCTION_JAVASCRIPT_EXTENSIONS = [".js", ".mjs", ".cjs"] as const;

const EXPECTED_SYSTEM_IDS = [
  "worker-work",
  "carrier-logistics",
  "power-creep-action",
  "resource-transfer",
  "factory-command",
  "remote-mining-workflow",
  "colonization-workflow",
  "rescue-workflow",
  "flag-hauling-workflow",
  "cross-shard-colonization-workflow",
  "war-workflow",
  "power-bank-workflow",
  "spawn-production",
] as const;

const EXCLUDED_SYSTEM_IDS = [
  "synthesis-plan",
  "hub-plan",
  "energy-pickup-reservation",
  "resource-reservation",
  "receiver-capacity-ledger",
  "local-destination-claim",
  "terminal-action-claim",
  "market-order",
  "market-wal",
  "market-pending-transaction",
] as const;

const EXCLUDED_SYSTEM_KEY_PATTERNS = [
  /(?:^|[-_])synthesis(?:$|[-_])/i,
  /(?:^|[-_])hub(?:[-_].*)?plan|plan(?:[-_].*)?hub/i,
  /(?:^|[-_])reservation(?:$|[-_])/i,
  /(?:^|[-_])ledger(?:$|[-_])/i,
  /(?:^|[-_])claim(?:$|[-_])/i,
  /(?:^|[-_])market(?:$|[-_])/i,
  /(?:^|[-_])wal(?:$|[-_])/i,
  /(?:^|[-_])order(?:$|[-_])/i,
] as const;

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function repositoryPath(value: string): string {
  return normalizePath(relative(REPO_ROOT, value));
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
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
  if (loaded.error) throw new Error(formatDiagnostics([loaded.error]));
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    dirname(BUILD_CONFIG_PATH),
    { noEmit: true },
    BUILD_CONFIG_PATH,
  );
  if (parsed.errors.length > 0) throw new Error(formatDiagnostics(parsed.errors));
  return parsed;
}

const buildConfig = parseBuildConfig();
const productionProgram = ts.createProgram({
  rootNames: buildConfig.fileNames,
  options: buildConfig.options,
});

function typescriptProductionSources(): ts.SourceFile[] {
  return productionProgram.getSourceFiles().filter((sourceFile) =>
    repositoryPath(sourceFile.fileName).startsWith("src/"));
}

function isProductionJavaScriptFileName(fileName: string): boolean {
  const extension = PRODUCTION_JAVASCRIPT_EXTENSIONS.find((candidate) =>
    fileName.endsWith(candidate));
  return extension !== undefined &&
    !fileName.endsWith(`.test${extension}`) &&
    !fileName.endsWith(`.spec${extension}`);
}

function sourceJavaScriptPaths(directory: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(resolve(REPO_ROOT, directory), { withFileTypes: true })) {
    const child = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      paths.push(...sourceJavaScriptPaths(child));
    } else if (
      entry.isFile() &&
      isProductionJavaScriptFileName(entry.name)
    ) {
      paths.push(child);
    }
  }
  return paths.sort();
}

const rollupJavaScriptSources = sourceJavaScriptPaths("src").map((fileName) =>
  ts.createSourceFile(
    resolve(REPO_ROOT, fileName),
    readFileSync(resolve(REPO_ROOT, fileName), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  ));

function productionSources(): ts.SourceFile[] {
  const sources = new Map<string, ts.SourceFile>();
  for (const sourceFile of [...typescriptProductionSources(), ...rollupJavaScriptSources]) {
    sources.set(repositoryPath(sourceFile.fileName), sourceFile);
  }
  return [...sources.values()];
}

function productionSourceFile(fileName: string): ts.SourceFile {
  const absolutePath = normalizePath(resolve(REPO_ROOT, fileName));
  const sourceFile = productionProgram.getSourceFiles().find(
    (candidate) => normalizePath(resolve(candidate.fileName)) === absolutePath,
  );
  if (!sourceFile) throw new Error(`${fileName} is not in the production TypeScript Program`);
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

function unwrapFreeze(expression: ts.Expression): ts.Expression {
  const current = unwrapExpression(expression);
  if (
    ts.isCallExpression(current) &&
    current.arguments.length === 1 &&
    ts.isPropertyAccessExpression(current.expression) &&
    ts.isIdentifier(current.expression.expression) &&
    current.expression.expression.text === "Object" &&
    current.expression.name.text === "freeze"
  ) {
    return unwrapExpression(current.arguments[0]);
  }
  return current;
}

function staticPropertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  throw new Error(`computed property is not allowed in an architecture oracle: ${name.getText()}`);
}

function exportedConstObject(sourceFile: ts.SourceFile, name: string): ts.ObjectLiteralExpression {
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
        const initializer = unwrapFreeze(declaration.initializer);
        if (ts.isObjectLiteralExpression(initializer)) return initializer;
      }
    }
  }
  throw new Error(`${repositoryPath(sourceFile.fileName)} must export const ${name} as a static object`);
}

function staticObjectEntries(
  sourceFile: ts.SourceFile,
  name: string,
): ReadonlyArray<readonly [string, ts.Expression]> {
  return exportedConstObject(sourceFile, name).properties.map((property) => {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(`${name} may contain only explicit property assignments`);
    }
    return [staticPropertyName(property.name), property.initializer] as const;
  });
}

type ModuleReferenceKind = "import" | "export" | "import-equals" | "require" | "dynamic-import";

interface ModuleReference {
  readonly specifier: string;
  readonly kind: ModuleReferenceKind;
  readonly runtime: boolean;
}

function importHasRuntimeEdge(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)) return true;
  return clause.namedBindings.elements.length === 0 ||
    clause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

function exportHasRuntimeEdge(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false;
  if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) return true;
  return node.exportClause.elements.length === 0 ||
    node.exportClause.elements.some((element) => !element.isTypeOnly);
}

function moduleReferences(sourceFile: ts.SourceFile): ModuleReference[] {
  const references: ModuleReference[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      references.push({
        specifier: node.moduleSpecifier.text,
        kind: "import",
        runtime: importHasRuntimeEdge(node),
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      references.push({
        specifier: node.moduleSpecifier.text,
        kind: "export",
        runtime: exportHasRuntimeEdge(node),
      });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      references.push({
        specifier: node.moduleReference.expression.text,
        kind: "import-equals",
        runtime: !node.isTypeOnly,
      });
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        references.push({ specifier: node.arguments[0].text, kind: "require", runtime: true });
      } else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        references.push({
          specifier: node.arguments[0].text,
          kind: "dynamic-import",
          runtime: true,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

function resolveModule(sourceFile: ts.SourceFile, specifier: string, runtime = false): string | undefined {
  // TS 优先选择同名 .d.ts；运行时图仍必须跟踪 Rollup 实际加载的 JS。
  if (runtime && specifier.startsWith(".") && isProductionJavaScriptFileName(specifier)) {
    const javascript = resolve(dirname(sourceFile.fileName), specifier);
    if (ts.sys.fileExists(javascript)) return repositoryPath(javascript);
  }
  const resolved = ts.resolveModuleName(
    specifier,
    sourceFile.fileName,
    buildConfig.options,
    ts.sys,
  ).resolvedModule;
  return resolved ? repositoryPath(resolved.resolvedFileName) : undefined;
}

interface ResolvedModuleReference extends ModuleReference {
  readonly target: string | undefined;
}

function resolvedModuleReferences(sourceFile: ts.SourceFile): ResolvedModuleReference[] {
  return moduleReferences(sourceFile).map((reference) => ({
    ...reference,
    target: resolveModule(sourceFile, reference.specifier, reference.runtime),
  }));
}

function isForbiddenProjectionModule(path: string): boolean {
  return path === REGISTRY_PATH || path === SNAPSHOT_PATH || isWithin(path, ADAPTER_ROOT);
}

type TaskSystemLayer = "catalog" | "model" | "adapter" | "registry" | "snapshot" | "unclassified";

function taskSystemLayer(path: string): TaskSystemLayer {
  if (path === CATALOG_PATH) return "catalog";
  if (path === `${TASK_SYSTEM_ROOT}/model.ts`) return "model";
  if (isWithin(path, ADAPTER_ROOT)) return "adapter";
  if (path === REGISTRY_PATH) return "registry";
  if (path === SNAPSHOT_PATH) return "snapshot";
  return "unclassified";
}

function taskSystemLayerViolations(
  sourcePath: string,
  references: readonly ResolvedModuleReference[],
): string[] {
  const layer = taskSystemLayer(sourcePath);
  const violations: string[] = [];
  for (const reference of references) {
    const target = reference.target;
    const dependency = `${sourcePath} ${reference.kind} ${reference.specifier}` +
      (target ? ` -> ${target}` : " (unresolved)");

    if (
      layer === "catalog" &&
      (reference.runtime || (target !== undefined && isWithin(target, TASK_SYSTEM_ROOT)))
    ) {
      violations.push(`catalog runtime or reverse taskSystem dependency: ${dependency}`);
    } else if (layer === "model" && (reference.runtime || target !== CATALOG_PATH)) {
      violations.push(`model dependency must be type-only catalog: ${dependency}`);
    } else if (
      layer === "adapter" &&
      target &&
      isWithin(target, TASK_SYSTEM_ROOT) &&
      target !== CATALOG_PATH &&
      target !== `${TASK_SYSTEM_ROOT}/model.ts`
    ) {
      violations.push(`adapter reverse or lateral dependency: ${dependency}`);
    } else if (
      layer === "registry" &&
      (target === undefined || (
        target !== CATALOG_PATH &&
        target !== `${TASK_SYSTEM_ROOT}/model.ts` &&
        !isWithin(target, ADAPTER_ROOT)
      ))
    ) {
      violations.push(`registry dependency outside catalog/model/adapters: ${dependency}`);
    } else if (
      layer === "snapshot" &&
      (target === undefined || (
        target !== CATALOG_PATH &&
        target !== `${TASK_SYSTEM_ROOT}/model.ts` &&
        target !== REGISTRY_PATH
      ))
    ) {
      violations.push(`snapshot dependency outside catalog/model/registry: ${dependency}`);
    }
  }
  return violations;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name));
}

function declaredNames(sourceFile: ts.SourceFile): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      if (node.name) names.push(node.name.text);
    } else if (ts.isVariableDeclaration(node)) {
      names.push(...bindingNames(node.name));
    } else if (
      (ts.isMethodDeclaration(node) ||
        ts.isMethodSignature(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isPropertySignature(node)) &&
      node.name
    ) {
      if (
        ts.isIdentifier(node.name) ||
        ts.isStringLiteralLike(node.name) ||
        ts.isNumericLiteral(node.name)
      ) {
        names.push(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function normalizeCapabilityName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function isForbiddenLogisticsCapability(name: string): boolean {
  const normalized = normalizeCapabilityName(name);
  return new Set([
    "transfercontract",
    "capacitylease",
    "stageworkclaim",
    "roomlogisticsagent",
    "logisticsprioritypolicy",
    "latestintentmatcher",
  ]).has(normalized) ||
    normalized.endsWith("matcher") ||
    normalized.includes("matchlatestintent") ||
    (normalized.includes("terminal") &&
      (normalized.includes("executor") || normalized.includes("arbiter")));
}

function sampleSource(text: string): ts.SourceFile {
  return ts.createSourceFile("architecture-sample.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

describe("unified task system architecture boundaries", () => {
  test("registry has one static adapter entry for every independent canonical system oracle", () => {
    const entries = staticObjectEntries(
      productionSourceFile(REGISTRY_PATH),
      "TASK_SYSTEM_ADAPTER_REGISTRY",
    );
    const systems = entries.map(([system]) => system);
    const counts = new Map<string, number>();
    const adapterBindings = new Set<string>();

    for (const [system, rawInitializer] of entries) {
      counts.set(system, (counts.get(system) ?? 0) + 1);
      const initializer = unwrapExpression(rawInitializer);
      if (!ts.isCallExpression(initializer) || !ts.isIdentifier(initializer.expression)) {
        throw new Error(`${system} must be registered through a static binder call`);
      }
      expect(["bindSourceAdapter", "bindSourceFreeAdapter"]).toContain(initializer.expression.text);
      const declaredSystem = initializer.arguments[0] && unwrapExpression(initializer.arguments[0]);
      if (!declaredSystem || !ts.isStringLiteralLike(declaredSystem)) {
        throw new Error(`${system} binder must repeat its canonical system as a string literal`);
      }
      expect(declaredSystem.text).toBe(system);
      const adapter = initializer.arguments[1] && unwrapExpression(initializer.arguments[1]);
      if (!adapter || !ts.isIdentifier(adapter)) {
        throw new Error(`${system} binder must use one statically imported adapter identifier`);
      }
      adapterBindings.add(adapter.text);
    }

    expect([...systems].sort()).toEqual([...EXPECTED_SYSTEM_IDS].sort());
    expect(entries).toHaveLength(EXPECTED_SYSTEM_IDS.length);
    expect(EXPECTED_SYSTEM_IDS.map((system) => counts.get(system))).toEqual(
      EXPECTED_SYSTEM_IDS.map(() => 1),
    );
    expect(adapterBindings.size).toBe(EXPECTED_SYSTEM_IDS.length);
  });

  test("catalog and registry keep plans, authorization primitives, and market transactions excluded", () => {
    const catalogSystems = staticObjectEntries(
      productionSourceFile(CATALOG_PATH),
      "TASK_SYSTEM_CATALOG",
    ).map(([system]) => system);
    const registrySystems = staticObjectEntries(
      productionSourceFile(REGISTRY_PATH),
      "TASK_SYSTEM_ADAPTER_REGISTRY",
    ).map(([system]) => system);

    expect([...catalogSystems].sort()).toEqual([...EXPECTED_SYSTEM_IDS].sort());
    for (const systems of [catalogSystems, registrySystems]) {
      expect(systems.filter((system) =>
        (EXCLUDED_SYSTEM_IDS as readonly string[]).includes(system))).toEqual([]);
      expect(systems.filter((system) =>
        EXCLUDED_SYSTEM_KEY_PATTERNS.some((pattern) => pattern.test(system)))).toEqual([]);
    }
  });

  test("Rollup production .js/.mjs/.cjs is parsed alongside the TypeScript Program", () => {
    expect([
      "runtime.js",
      "runtime.mjs",
      "runtime.cjs",
    ].map(isProductionJavaScriptFileName)).toEqual([true, true, true]);
    expect([
      "runtime.test.js",
      "runtime.spec.mjs",
      "runtime.test.cjs",
      "runtime.ts",
      "runtime.json",
    ].map(isProductionJavaScriptFileName)).toEqual([false, false, false, false, false]);

    const javascriptPaths = rollupJavaScriptSources.map((sourceFile) =>
      repositoryPath(sourceFile.fileName));
    expect(javascriptPaths).toEqual(
      expect.arrayContaining([...KNOWN_ROLLUP_JAVASCRIPT_PATHS]),
    );

    const planner = rollupJavaScriptSources.find(
      (sourceFile) => repositoryPath(sourceFile.fileName) === "src/modules/autoplanner/planner.js",
    );
    expect(planner).toBeDefined();
    expect(planner && moduleReferences(planner).map((reference) => reference.specifier)).toEqual([
      "lodash",
      "./MinCut",
    ]);
    expect(resolvedModuleReferences(productionSourceFile("src/modules/autoplanner/index.ts"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          specifier: "./planner.js",
          runtime: true,
          target: "src/modules/autoplanner/planner.js",
        }),
      ]),
    );
  });

  test("production modules outside taskSystem cannot import, re-export, or require projection internals", () => {
    const violations: string[] = [];
    for (const sourceFile of productionSources()) {
      const sourcePath = repositoryPath(sourceFile.fileName);
      if (isWithin(sourcePath, TASK_SYSTEM_ROOT)) continue;
      for (const reference of resolvedModuleReferences(sourceFile)) {
        const target = reference.target;
        if (target && isForbiddenProjectionModule(target)) {
          violations.push(`${sourcePath} ${reference.kind} ${reference.specifier} -> ${target}`);
        }
      }
    }
    expect(violations.sort()).toEqual([]);
  });

  test("taskSystem internals follow the catalog-to-snapshot one-way dependency layers", () => {
    const taskSystemSources = productionSources().filter((sourceFile) =>
      isWithin(repositoryPath(sourceFile.fileName), TASK_SYSTEM_ROOT));
    expect(taskSystemSources
      .map((sourceFile) => repositoryPath(sourceFile.fileName))
      .filter((path) => taskSystemLayer(path) === "unclassified")
      .sort()).toEqual([]);

    const modelReferences = resolvedModuleReferences(
      productionSourceFile(`${TASK_SYSTEM_ROOT}/model.ts`),
    );
    expect(modelReferences).toEqual([
      expect.objectContaining({ target: CATALOG_PATH, runtime: false, kind: "import" }),
    ]);

    const violations = taskSystemSources.flatMap((sourceFile) => {
      const sourcePath = repositoryPath(sourceFile.fileName);
      return taskSystemLayerViolations(sourcePath, resolvedModuleReferences(sourceFile));
    });
    expect(violations.sort()).toEqual([]);
  });

  test("taskSystem implementation is not runtime-reachable from main", () => {
    const graph = new Map<string, string[]>();
    for (const sourceFile of productionSources()) {
      const sourcePath = repositoryPath(sourceFile.fileName);
      const targets = resolvedModuleReferences(sourceFile)
        .filter((reference) => reference.runtime)
        .map((reference) => reference.target)
        .filter((target): target is string => !!target && target.startsWith("src/"));
      graph.set(sourcePath, [...new Set(targets)]);
    }

    const visited = new Set<string>();
    const pending = [MAIN_PATH];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...(graph.get(current) ?? []));
    }

    expect([...visited]).toEqual(expect.arrayContaining([...KNOWN_ROLLUP_JAVASCRIPT_PATHS]));
    expect([...visited].filter((path) => isWithin(path, TASK_SYSTEM_ROOT)).sort()).toEqual([]);
  });

  test("unified task system namespace does not declare logistics ownership capabilities", () => {
    const violations = productionSources()
      .filter((sourceFile) => isWithin(repositoryPath(sourceFile.fileName), TASK_SYSTEM_ROOT))
      .flatMap((sourceFile) => declaredNames(sourceFile)
        .filter(isForbiddenLogisticsCapability)
        .map((name) => `${repositoryPath(sourceFile.fileName)}:${name}`));
    expect(violations.sort()).toEqual([]);
  });

  test("AST calibration detects dependency syntax and declarations without matching prose or data", () => {
    const dependencySample = sampleSource(`
      import adapter from "@/runtime/taskSystem/adapters/workerWork";
      import type { TaskSystemAdapter } from "@/runtime/taskSystem/model";
      export { TASK_SYSTEM_ADAPTER_REGISTRY } from "@/runtime/taskSystem/registry";
      const snapshot = require("@/runtime/taskSystem/snapshot");
      void import("@/runtime/taskSystem/adapters/carrierLogistics");
      const harmless = "@/runtime/taskSystem/snapshot";
      const prose = "require('@/runtime/taskSystem/registry')";
      // export * from "@/runtime/taskSystem/snapshot";
    `);
    expect(moduleReferences(dependencySample)).toEqual([
      { specifier: "@/runtime/taskSystem/adapters/workerWork", kind: "import", runtime: true },
      { specifier: "@/runtime/taskSystem/model", kind: "import", runtime: false },
      { specifier: "@/runtime/taskSystem/registry", kind: "export", runtime: true },
      { specifier: "@/runtime/taskSystem/snapshot", kind: "require", runtime: true },
      {
        specifier: "@/runtime/taskSystem/adapters/carrierLogistics",
        kind: "dynamic-import",
        runtime: true,
      },
    ]);

    const declarationSample = sampleSource(`
      import type { TransferContract } from "domain/contracts";
      interface TransferContract {}
      class CapacityLease {}
      type StageWorkClaim = { readonly id: string };
      const terminalExecutor = () => undefined;
      function projectTransferContractStatus(): string { return "visible-only"; }
      const prose = "RoomLogisticsAgent latestIntentMatcher";
    `);
    expect(declaredNames(declarationSample).filter(isForbiddenLogisticsCapability).sort()).toEqual([
      "CapacityLease",
      "StageWorkClaim",
      "TransferContract",
      "terminalExecutor",
    ]);

    const edge = (
      target: string | undefined,
      runtime = true,
    ): ResolvedModuleReference => ({
      specifier: target ?? "unresolved-module",
      target,
      kind: "import",
      runtime,
    });
    expect(taskSystemLayerViolations(CATALOG_PATH, [edge("node_modules/lodash/index.js")]))
      .toHaveLength(1);
    expect(taskSystemLayerViolations(CATALOG_PATH, [edge(SNAPSHOT_PATH, false)]))
      .toHaveLength(1);
    expect(taskSystemLayerViolations(`${TASK_SYSTEM_ROOT}/model.ts`, [edge(CATALOG_PATH, false)]))
      .toEqual([]);
    expect(taskSystemLayerViolations(`${ADAPTER_ROOT}/workerWork.ts`, [
      edge(`${ADAPTER_ROOT}/carrierLogistics.ts`),
    ])).toHaveLength(1);
    expect(taskSystemLayerViolations(REGISTRY_PATH, [edge(`${ADAPTER_ROOT}/workerWork.ts`)]))
      .toEqual([]);
    expect(taskSystemLayerViolations(REGISTRY_PATH, [
      edge(CATALOG_PATH, false),
      edge(`${TASK_SYSTEM_ROOT}/model.ts`, false),
    ])).toEqual([]);
    expect(taskSystemLayerViolations(REGISTRY_PATH, [edge(SNAPSHOT_PATH)]))
      .toHaveLength(1);
    expect(taskSystemLayerViolations(REGISTRY_PATH, [edge("src/runtime/workerTaskPool.ts")]))
      .toHaveLength(1);
    expect(taskSystemLayerViolations(REGISTRY_PATH, [edge(undefined)]))
      .toHaveLength(1);
    expect(taskSystemLayerViolations(SNAPSHOT_PATH, [edge(REGISTRY_PATH)]))
      .toEqual([]);
    expect(taskSystemLayerViolations(SNAPSHOT_PATH, [
      edge(CATALOG_PATH, false),
      edge(`${TASK_SYSTEM_ROOT}/model.ts`, false),
    ])).toEqual([]);
    expect(taskSystemLayerViolations(SNAPSHOT_PATH, [edge(`${ADAPTER_ROOT}/workerWork.ts`)]))
      .toHaveLength(1);
    expect(taskSystemLayerViolations(SNAPSHOT_PATH, [edge("src/runtime/runtimeServices.ts")]))
      .toHaveLength(1);
    expect(taskSystemLayerViolations(SNAPSHOT_PATH, [edge(undefined)]))
      .toHaveLength(1);
  });
});
