import { readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import * as ts from "typescript";

const REPO_ROOT = resolve(__dirname, "..");
const SRC_ROOT = resolve(REPO_ROOT, "src");
const BUILD_CONFIG_PATH = resolve(REPO_ROOT, "tsconfig.build.json");

const DISPATCH_ROOT = "src/runtime/dispatchOwnership";
const CREEP_ASSIGNMENT_STATE = "src/runtime/creepAssignmentState.ts";
const WORKER_TASK_POOL = "src/runtime/workerTaskPool.ts";
const CARRIER_TASK_BOARD = "src/runtime/carrierTaskBoard.ts";
const WORKER_SLOT = `${DISPATCH_ROOT}/workerSlot.ts`;
const ACTOR_BINDING = `${DISPATCH_ROOT}/actorBinding.ts`;

const KNOWN_ROLLUP_JAVASCRIPT_PATHS = [
  "src/modules/autoplanner/MinCut.js",
  "src/modules/autoplanner/RoomVisual.js",
  "src/modules/autoplanner/planner.js",
] as const;
const PRODUCTION_JAVASCRIPT_EXTENSIONS = [".js", ".mjs", ".cjs"] as const;

const ASSIGNMENT_IDENTITY_FIELDS = new Set([
  "dispatchBindings",
  "taskId",
  "synthesisCarrierTaskId",
]);
const CARRIER_TASK_IDENTITY_FIELDS = new Set([
  "id",
  "producer",
  "roomName",
  "steps",
  "publishOrder",
]);
const ARRAY_MUTATORS = new Set([
  "copyWithin",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "unshift",
]);

const APPROVED_WRITERS: Readonly<Record<ControlledFieldKind, ReadonlySet<string>>> = {
  "assignment-identity": new Set([ACTOR_BINDING]),
  "worker-assignees": new Set([WORKER_TASK_POOL, WORKER_SLOT]),
  "carrier-task-identity": new Set([CARRIER_TASK_BOARD]),
};

type ModuleReferenceKind =
  | "import"
  | "export"
  | "import-equals"
  | "import-type"
  | "require"
  | "dynamic-import";

interface ImportedBinding {
  readonly imported: string;
  readonly local: string;
  readonly typeOnly: boolean;
}

interface ModuleReference {
  readonly specifier: string;
  readonly kind: ModuleReferenceKind;
  readonly runtime: boolean;
  readonly bindings: readonly ImportedBinding[] | undefined;
}

interface ResolvedModuleReference extends ModuleReference {
  readonly target: string | undefined;
}

type ControlledFieldKind =
  | "assignment-identity"
  | "worker-assignees"
  | "carrier-task-identity";

interface ControlledField {
  readonly kind: ControlledFieldKind;
  readonly field: string;
}

interface ControlledWrite extends ControlledField {
  readonly sourcePath: string;
  readonly line: number;
  readonly syntax: string;
}

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
    { noEmit: true, allowJs: true, checkJs: false },
    BUILD_CONFIG_PATH,
  );
  if (parsed.errors.length > 0) throw new Error(formatDiagnostics(parsed.errors));
  return parsed;
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
    } else if (entry.isFile() && isProductionJavaScriptFileName(entry.name)) {
      paths.push(resolve(REPO_ROOT, child));
    }
  }
  return paths.sort();
}

const buildConfig = parseBuildConfig();
const javascriptRootNames = sourceJavaScriptPaths("src");
const productionProgram = ts.createProgram({
  rootNames: [...buildConfig.fileNames, ...javascriptRootNames],
  options: buildConfig.options,
});
const checker = productionProgram.getTypeChecker();

function productionSources(): ts.SourceFile[] {
  return productionProgram.getSourceFiles().filter((sourceFile) => {
    const path = normalizePath(sourceFile.fileName);
    return path.startsWith(`${normalizePath(SRC_ROOT)}/`) &&
      !/\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(path);
  });
}

function sourceLine(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function importBindings(node: ts.ImportDeclaration): readonly ImportedBinding[] | undefined {
  const clause = node.importClause;
  if (!clause) return undefined;
  const bindings: ImportedBinding[] = [];
  if (clause.name) {
    bindings.push({
      imported: "default",
      local: clause.name.text,
      typeOnly: clause.isTypeOnly,
    });
  }
  const namedBindings = clause.namedBindings;
  if (namedBindings && ts.isNamespaceImport(namedBindings)) {
    bindings.push({
      imported: "*",
      local: namedBindings.name.text,
      typeOnly: clause.isTypeOnly,
    });
  } else if (namedBindings && ts.isNamedImports(namedBindings)) {
    for (const element of namedBindings.elements) {
      bindings.push({
        imported: element.propertyName?.text ?? element.name.text,
        local: element.name.text,
        typeOnly: clause.isTypeOnly || element.isTypeOnly,
      });
    }
  }
  return bindings;
}

function exportBindings(node: ts.ExportDeclaration): readonly ImportedBinding[] | undefined {
  if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) return undefined;
  return node.exportClause.elements.map((element) => ({
    imported: element.propertyName?.text ?? element.name.text,
    local: element.name.text,
    typeOnly: node.isTypeOnly || element.isTypeOnly,
  }));
}

function importHasRuntimeEdge(node: ts.ImportDeclaration): boolean {
  const bindings = importBindings(node);
  return bindings === undefined || bindings.length === 0 || bindings.some((binding) => !binding.typeOnly);
}

function exportHasRuntimeEdge(node: ts.ExportDeclaration): boolean {
  const bindings = exportBindings(node);
  return bindings === undefined || bindings.length === 0 || bindings.some((binding) => !binding.typeOnly);
}

function requireBindings(node: ts.CallExpression): readonly ImportedBinding[] | undefined {
  const parent = node.parent;
  if (!ts.isVariableDeclaration(parent)) return undefined;
  if (ts.isIdentifier(parent.name)) {
    return [{ imported: "*", local: parent.name.text, typeOnly: false }];
  }
  if (!ts.isObjectBindingPattern(parent.name)) return undefined;
  return parent.name.elements.flatMap((element) => {
    const imported = element.propertyName
      ? propertyNameText(element.propertyName)
      : ts.isIdentifier(element.name)
        ? element.name.text
        : undefined;
    const local = ts.isIdentifier(element.name) ? element.name.text : undefined;
    return imported && local ? [{ imported, local, typeOnly: false }] : [];
  });
}

function moduleReferences(sourceFile: ts.SourceFile): ModuleReference[] {
  const references: ModuleReference[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      references.push({
        specifier: node.moduleSpecifier.text,
        kind: "import",
        runtime: importHasRuntimeEdge(node),
        bindings: importBindings(node),
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
        bindings: exportBindings(node),
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
        bindings: [{ imported: "*", local: node.name.text, typeOnly: node.isTypeOnly }],
      });
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      const qualifier = node.qualifier && ts.isIdentifier(node.qualifier)
        ? node.qualifier.text
        : "*";
      references.push({
        specifier: node.argument.literal.text,
        kind: "import-type",
        runtime: false,
        bindings: [{ imported: qualifier, local: qualifier, typeOnly: true }],
      });
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        references.push({
          specifier: node.arguments[0].text,
          kind: "require",
          runtime: true,
          bindings: requireBindings(node),
        });
      } else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        references.push({
          specifier: node.arguments[0].text,
          kind: "dynamic-import",
          runtime: true,
          bindings: undefined,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

function resolveModule(sourceFile: ts.SourceFile, specifier: string): string | undefined {
  const resolved = ts.resolveModuleName(
    specifier,
    sourceFile.fileName,
    buildConfig.options,
    ts.sys,
  ).resolvedModule;
  return resolved ? repositoryPath(resolved.resolvedFileName) : undefined;
}

function resolvedModuleReferences(sourceFile: ts.SourceFile): ResolvedModuleReference[] {
  return moduleReferences(sourceFile).map((reference) => ({
    ...reference,
    target: resolveModule(sourceFile, reference.specifier),
  }));
}

function dependencyLabel(sourcePath: string, reference: ResolvedModuleReference): string {
  const bindings = reference.bindings?.map((binding) =>
    `${binding.typeOnly ? "type " : ""}${binding.imported}`).join(", ") ?? "*";
  return `${sourcePath} ${reference.kind} {${bindings}} from ${reference.specifier}` +
    (reference.target ? ` -> ${reference.target}` : " (unresolved)");
}

function isLocalDispatchDomainModule(path: string): boolean {
  return isWithin(path, DISPATCH_ROOT) ||
    path === CREEP_ASSIGNMENT_STATE ||
    path === WORKER_TASK_POOL ||
    path === CARRIER_TASK_BOARD;
}


function declarationContainerName(declaration: ts.Declaration): string | undefined {
  let current: ts.Node | undefined = declaration.parent;
  while (current) {
    if (
      (ts.isInterfaceDeclaration(current) ||
        ts.isClassDeclaration(current) ||
        ts.isTypeAliasDeclaration(current)) &&
      current.name
    ) {
      return current.name.text;
    }
    current = current.parent;
  }
  return undefined;
}

function controlledFieldFromSymbol(symbol: ts.Symbol | undefined): ControlledField | undefined {
  if (!symbol) return undefined;
  const declarations = symbol.declarations ?? [];
  for (const declaration of declarations) {
    const sourcePath = repositoryPath(declaration.getSourceFile().fileName);
    const field = symbol.name;
    const container = declarationContainerName(declaration);
    if (sourcePath === CREEP_ASSIGNMENT_STATE && ASSIGNMENT_IDENTITY_FIELDS.has(field)) {
      return { kind: "assignment-identity", field };
    }
    if (
      sourcePath === "src/types/system.ts" &&
      field === "assignedCreeps" &&
      container === "WorkerTask"
    ) {
      return { kind: "worker-assignees", field };
    }
    if (
      sourcePath === CARRIER_TASK_BOARD &&
      CARRIER_TASK_IDENTITY_FIELDS.has(field) &&
      (container === "CarrierTask" || field === "publishOrder")
    ) {
      return { kind: "carrier-task-identity", field };
    }
  }
  return undefined;
}

function propertySymbol(expression: ts.Expression, field: string): ts.Symbol | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    return checker.getSymbolAtLocation(expression.name) ??
      checker.getTypeAtLocation(expression.expression).getProperty(field);
  }
  if (ts.isElementAccessExpression(expression)) {
    return checker.getTypeAtLocation(expression.expression).getProperty(field);
  }
  return checker.getTypeAtLocation(expression).getProperty(field);
}

function controlledFieldForAccess(expression: ts.Expression): ControlledField | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    return controlledFieldFromSymbol(propertySymbol(expression, expression.name.text));
  }
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return controlledFieldFromSymbol(
      propertySymbol(expression, expression.argumentExpression.text),
    );
  }
  return undefined;
}

function controlledFieldInExpression(expression: ts.Expression): ControlledField | undefined {
  const direct = controlledFieldForAccess(expression);
  if (direct) return direct;
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return controlledFieldInExpression(expression.expression);
  }
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return controlledFieldInExpression(expression.expression);
  }
  return undefined;
}

function staticFieldForTarget(target: ts.Expression, field: string): ControlledField | undefined {
  return controlledFieldFromSymbol(checker.getTypeAtLocation(target).getProperty(field));
}

function assignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function writeTargets(node: ts.Expression): ts.Expression[] {
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap((element) => {
      if (ts.isSpreadElement(element)) return writeTargets(element.expression);
      if (ts.isExpression(element)) return writeTargets(element);
      return [];
    });
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.flatMap((property) => {
      if (ts.isSpreadAssignment(property)) return writeTargets(property.expression);
      if (ts.isPropertyAssignment(property)) return writeTargets(property.initializer);
      if (ts.isShorthandPropertyAssignment(property)) return [property.name];
      return [];
    });
  }
  return [node];
}

function collectControlledWrites(sourceFile: ts.SourceFile): ControlledWrite[] {
  const sourcePath = repositoryPath(sourceFile.fileName);
  const writes: ControlledWrite[] = [];
  const record = (node: ts.Node, controlled: ControlledField | undefined, syntax: string): void => {
    if (!controlled) return;
    writes.push({
      ...controlled,
      sourcePath,
      line: sourceLine(sourceFile, node),
      syntax,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && assignmentOperator(node.operatorToken.kind)) {
      for (const target of writeTargets(node.left)) {
        record(target, controlledFieldInExpression(target), "assignment");
      }
    } else if (
      ts.isDeleteExpression(node) ||
      ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken))
    ) {
      const operand = ts.isDeleteExpression(node) ? node.expression : node.operand;
      record(node, controlledFieldInExpression(operand), ts.isDeleteExpression(node) ? "delete" : "increment");
    } else if (ts.isPropertyAssignment(node)) {
      const field = propertyNameText(node.name);
      if (field) {
        record(node, controlledFieldFromSymbol(checker.getSymbolAtLocation(node.name)), "object-initializer");
      }
    } else if (ts.isShorthandPropertyAssignment(node)) {
      const contextual = checker.getContextualType(node.parent);
      record(node, controlledFieldFromSymbol(contextual?.getProperty(node.name.text)), "object-initializer");
    } else if (ts.isSpreadAssignment(node)) {
      const contextual = checker.getContextualType(node.parent);
      if (contextual) {
        for (const field of [
          ...ASSIGNMENT_IDENTITY_FIELDS,
          "assignedCreeps",
          ...CARRIER_TASK_IDENTITY_FIELDS,
        ]) {
          record(node, controlledFieldFromSymbol(contextual.getProperty(field)), "object-spread");
        }
      }
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression;
      const method = node.expression.name.text;
      if (ARRAY_MUTATORS.has(method)) {
        record(node, controlledFieldInExpression(receiver), `mutator:${method}`);
      } else if (
        ts.isIdentifier(receiver) &&
        receiver.text === "Object" &&
        method === "assign" &&
        node.arguments.length >= 2
      ) {
        const target = node.arguments[0];
        if (ts.isExpression(target)) {
          record(node, controlledFieldInExpression(target), "Object.assign-target");
          for (const source of node.arguments.slice(1)) {
            if (!ts.isObjectLiteralExpression(source)) continue;
            for (const property of source.properties) {
              if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
              const field = propertyNameText(property.name);
              if (field) record(property, staticFieldForTarget(target, field), "Object.assign-field");
            }
          }
        }
      } else if (
        ((ts.isIdentifier(receiver) && receiver.text === "Object" && method === "defineProperty") ||
          (ts.isIdentifier(receiver) && receiver.text === "Reflect" && method === "set")) &&
        node.arguments.length >= 2 &&
        ts.isExpression(node.arguments[0]) &&
        ts.isStringLiteralLike(node.arguments[1])
      ) {
        record(
          node,
          staticFieldForTarget(node.arguments[0], node.arguments[1].text),
          `${receiver.getText(sourceFile)}.${method}`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return writes;
}

function writeViolations(writes: readonly ControlledWrite[]): string[] {
  return writes
    .filter((write) => !APPROVED_WRITERS[write.kind].has(write.sourcePath))
    .map((write) =>
      `${write.sourcePath}:${write.line} writes ${write.kind}.${write.field} via ${write.syntax}`);
}

function mutableGatewayImportViolations(
  sourcePath: string,
  references: readonly ResolvedModuleReference[],
): string[] {
  const violations: string[] = [];
  for (const reference of references) {
    const target = reference.target;
    if (!target) continue;
    const isMutableBoardModule = target === WORKER_TASK_POOL || target === CARRIER_TASK_BOARD;
    if (
      isLocalDispatchDomainModule(target) &&
      (!reference.bindings || reference.bindings.some((binding) =>
        !binding.typeOnly && (binding.imported === "*" || binding.imported === "default")))
    ) {
      violations.push(`production uses an unauditable local-dispatch namespace import: ${dependencyLabel(sourcePath, reference)}`);
      continue;
    }
    if (!reference.bindings) continue;
    for (const binding of reference.bindings) {
      if (
        isMutableBoardModule &&
        (binding.imported === "getWorkerTasksByRoom" || binding.imported === "getCarrierTasksByRoom")
      ) {
        violations.push(`production imports mutable task-board gateway: ${dependencyLabel(sourcePath, reference)}`);
      }
      if (
        isLocalDispatchDomainModule(target) &&
        /ForTest$/.test(binding.imported)
      ) {
        violations.push(`production imports test-only local-dispatch helper: ${dependencyLabel(sourcePath, reference)}`);
      }
    }
  }
  return violations;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name));
}

interface NamedDeclaration {
  readonly name: string;
  readonly node: ts.Node;
  readonly category: "type" | "value" | "member";
  readonly container: string | undefined;
}

function namedDeclarations(sourceFile: ts.SourceFile): NamedDeclaration[] {
  const declarations: NamedDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      if (node.name) declarations.push({
        name: node.name.text,
        node,
        category: "type",
        container: undefined,
      });
    } else if (ts.isFunctionDeclaration(node)) {
      if (node.name) declarations.push({
        name: node.name.text,
        node,
        category: "value",
        container: undefined,
      });
    } else if (ts.isVariableDeclaration(node)) {
      for (const name of bindingNames(node.name)) {
        declarations.push({ name, node, category: "value", container: undefined });
      }
    } else if (
      (ts.isMethodDeclaration(node) ||
        ts.isMethodSignature(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isPropertySignature(node)) &&
      node.name
    ) {
      const name = propertyNameText(node.name);
      if (name) declarations.push({
        name,
        node,
        category: "member",
        container: declarationContainerName(node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declarations;
}

function normalizedCapabilityName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function isAllowedDomainClaimName(normalized: string): boolean {
  return normalized.includes("workerslot") ||
    (normalized.includes("carrier") &&
      normalized.includes("amount") &&
      (normalized.includes("slice") || normalized.includes("step")));
}

function forbiddenCapabilityReason(declaration: NamedDeclaration): string | undefined {
  const normalized = normalizedCapabilityName(declaration.name);
  const normalizedContainer = declaration.container
    ? normalizedCapabilityName(declaration.container)
    : "";
  if ([
    "transfercontract",
    "capacitylease",
    "stageworkclaim",
    "roomlogisticsagent",
  ].some((capability) => normalized.includes(capability))) {
    return "reserved logistics-contract capability";
  }
  if (normalized.includes("taskmanager")) return "generic TaskManager";
  if (normalized.includes("reservation")) return "reservation ownership";
  if (normalized.includes("arbiter")) return "dispatch/terminal/market arbiter";
  if (
    (normalized.includes("terminal") || normalized.includes("market")) &&
    (normalized.includes("executor") || normalized.includes("authority"))
  ) {
    return "terminal/market execution authority";
  }
  if (
    normalized.includes("claim") &&
    !isAllowedDomainClaimName(normalized) &&
    !isAllowedDomainClaimName(normalizedContainer) &&
    (declaration.category === "type" || normalized === "claim" || normalized.endsWith("claimport"))
  ) {
    return "generic claim interface";
  }
  return undefined;
}

function forbiddenCapabilityViolations(sourceFile: ts.SourceFile): string[] {
  const sourcePath = repositoryPath(sourceFile.fileName);
  const violations = namedDeclarations(sourceFile).flatMap((declaration) => {
    const reason = forbiddenCapabilityReason(declaration);
    return reason
      ? [`${sourcePath}:${sourceLine(sourceFile, declaration.node)} declares ${declaration.name} (${reason})`]
      : [];
  });
  for (const reference of moduleReferences(sourceFile)) {
    for (const binding of reference.bindings ?? []) {
      const reason = forbiddenCapabilityReason({
        name: binding.imported,
        node: sourceFile,
        category: binding.typeOnly ? "type" : "value",
        container: undefined,
      });
      if (reason) {
        violations.push(
          `${sourcePath} imports ${binding.imported} from ${reference.specifier} (${reason})`,
        );
      }
    }
  }

  if (isWithin(sourcePath, DISPATCH_ROOT)) {
    const normalizedFileName = normalizedCapabilityName(
      sourcePath.slice(DISPATCH_ROOT.length + 1).replace(/\.[^.]+$/, ""),
    );
    if (
      normalizedFileName.includes("taskmanager") ||
      normalizedFileName.includes("reservation") ||
      normalizedFileName.includes("transfercontract") ||
      normalizedFileName.includes("capacitylease") ||
      normalizedFileName.includes("stageworkclaim") ||
      normalizedFileName.includes("roomlogisticsagent") ||
      normalizedFileName.includes("arbiter")
    ) {
      violations.push(`${sourcePath} uses a forbidden dispatch capability filename`);
    }
  }
  return violations;
}

function sampleSource(text: string, kind: ts.ScriptKind = ts.ScriptKind.TS): ts.SourceFile {
  return ts.createSourceFile(
    kind === ts.ScriptKind.JS ? "architecture-sample.js" : "architecture-sample.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
}

describe("local dispatch ownership architecture boundaries", () => {
  test("production source inventory includes mixed Rollup JavaScript", () => {
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
    ].map(isProductionJavaScriptFileName)).toEqual([false, false, false, false]);

    const paths = productionSources().map((sourceFile) => repositoryPath(sourceFile.fileName));
    expect(paths).toEqual(expect.arrayContaining([...KNOWN_ROLLUP_JAVASCRIPT_PATHS]));

    const planner = productionSources().find((sourceFile) =>
      repositoryPath(sourceFile.fileName) === "src/modules/autoplanner/planner.js");
    expect(planner).toBeDefined();
    expect(planner && moduleReferences(planner).map((reference) => reference.specifier)).toEqual([
      "lodash",
      "./MinCut",
    ]);
  });

  test("dispatch 不再依赖已删除的 TaskSystem 观察层", () => {
    const references = productionSources()
      .filter(source => isWithin(repositoryPath(source.fileName), DISPATCH_ROOT))
      .flatMap(source => moduleReferences(source))
      .filter(reference => reference.specifier.includes("taskSystem/"));
    expect(references).toEqual([]);
  });

  test("canonical identity, Worker assignees, and Carrier identity have only approved writers", () => {
    const writes = productionSources().flatMap(collectControlledWrites);
    expect(writeViolations(writes).sort()).toEqual([]);
    expect(writes.some((write) =>
      write.kind === "worker-assignees" &&
      APPROVED_WRITERS[write.kind].has(write.sourcePath))).toBe(true);
    expect(writes.some((write) =>
      write.kind === "carrier-task-identity" &&
      APPROVED_WRITERS[write.kind].has(write.sourcePath))).toBe(true);

    expect([...APPROVED_WRITERS["assignment-identity"]]).toEqual([ACTOR_BINDING]);
    expect([...APPROVED_WRITERS["worker-assignees"]].sort()).toEqual([
      WORKER_SLOT,
      WORKER_TASK_POOL,
    ]);
    expect([...APPROVED_WRITERS["carrier-task-identity"]]).toEqual([CARRIER_TASK_BOARD]);
  });

  test("production cannot import mutable room gateways or local-dispatch test helpers", () => {
    const violations = productionSources().flatMap((sourceFile) => {
      const sourcePath = repositoryPath(sourceFile.fileName);
      return mutableGatewayImportViolations(sourcePath, resolvedModuleReferences(sourceFile));
    });
    expect(violations.sort()).toEqual([]);
  });

  test("dispatch does not declare contracts, leases, agents, reservations, arbiters, or generic managers", () => {
    const violations = productionSources()
      .filter((sourceFile) => isWithin(repositoryPath(sourceFile.fileName), DISPATCH_ROOT))
      .flatMap(forbiddenCapabilityViolations);
    expect(violations.sort()).toEqual([]);
  });

  test("AST calibration catches forbidden edges and capabilities without matching prose", () => {
    const edge = (
      target: string | undefined,
      runtime: boolean,
      imported: string,
      kind: ModuleReferenceKind = "import",
    ): ResolvedModuleReference => ({
      specifier: target ?? "unresolved",
      target,
      kind,
      runtime,
      bindings: [{ imported, local: imported, typeOnly: !runtime }],
    });

    const forbidden = sampleSource(`
      import type { TransferContractStore } from "domain/contracts";
      interface TransferContract {}
      class CapacityLease {}
      type StageWorkClaim = { id: string };
      const roomLogisticsAgent = {};
      class GenericTaskManager {}
      interface GenericClaimPort { claim(work: unknown, amount?: number): unknown }
      const terminalArbiter = {};
      const reservationLedger = {};
      const prose = "TransferContract CapacityLease RoomLogisticsAgent";
      // interface MarketArbiter {}
    `);
    expect(forbiddenCapabilityViolations(forbidden)).toHaveLength(10);

    const allowed = sampleSource(`
      interface WorkerSlotClaimPort { acquire(): boolean }
      interface CarrierAmountSlicePort { claim(): number }
      function claimCarrierTaskStepAmount(): number { return 0; }
      const prose = "TaskManager reservation terminalArbiter";
    `);
    expect(forbiddenCapabilityViolations(allowed)).toEqual([]);

    const javascript = sampleSource(`
      class TaskManager {}
      const prose = "CapacityLease";
    `, ts.ScriptKind.JS);
    expect(namedDeclarations(javascript).map((declaration) => declaration.name)).toContain("TaskManager");
    expect(forbiddenCapabilityViolations(javascript)).toHaveLength(1);
  });

  test("module scanner recognizes ESM, CommonJS, dynamic, and type-only forms", () => {
    const sample = sampleSource(`
      import type { WorkRef } from "@/runtime/taskSystem/model";
      import { type CarrierDispatchRef, bindActorDispatch as bind } from "@/runtime/dispatchOwnership/actorBinding";
      export type { WorkerDispatchRef } from "@/runtime/dispatchOwnership/ref";
      const { peekCarrierDispatchBoard: peek } = require("@/runtime/dispatchOwnership/read");
      void import("@/runtime/dispatchOwnership/command");
      type Inline = import("@/runtime/taskSystem/model").WorkRef;
      const prose = "require('@/runtime/taskSystem/snapshot')";
      // export * from "@/runtime/taskSystem/registry";
    `);
    expect(moduleReferences(sample)).toEqual([
      {
        specifier: "@/runtime/taskSystem/model",
        kind: "import",
        runtime: false,
        bindings: [{ imported: "WorkRef", local: "WorkRef", typeOnly: true }],
      },
      {
        specifier: "@/runtime/dispatchOwnership/actorBinding",
        kind: "import",
        runtime: true,
        bindings: [
          { imported: "CarrierDispatchRef", local: "CarrierDispatchRef", typeOnly: true },
          { imported: "bindActorDispatch", local: "bind", typeOnly: false },
        ],
      },
      {
        specifier: "@/runtime/dispatchOwnership/ref",
        kind: "export",
        runtime: false,
        bindings: [{ imported: "WorkerDispatchRef", local: "WorkerDispatchRef", typeOnly: true }],
      },
      {
        specifier: "@/runtime/dispatchOwnership/read",
        kind: "require",
        runtime: true,
        bindings: [{ imported: "peekCarrierDispatchBoard", local: "peek", typeOnly: false }],
      },
      {
        specifier: "@/runtime/dispatchOwnership/command",
        kind: "dynamic-import",
        runtime: true,
        bindings: undefined,
      },
      {
        specifier: "@/runtime/taskSystem/model",
        kind: "import-type",
        runtime: false,
        bindings: [{ imported: "WorkRef", local: "WorkRef", typeOnly: true }],
      },
    ]);
  });
});
