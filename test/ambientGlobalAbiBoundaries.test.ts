import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import * as ts from "typescript";

const REPO_ROOT = resolve(__dirname, "..");
const SRC_ROOT = resolve(REPO_ROOT, "src");
const GLOBAL_DECLARATION = resolve(SRC_ROOT, "global.d.ts");

const PRIVATE_GLOBAL_SLOTS = new Set([
  "__runtimeServices",
  "__marketTickSession",
  "__marketSaleDiagnosticsPending",
  "__marketPerformanceCounters",
  "__cpuMonitor",
  "__productionSamples",
  "__creepMovementState",
  "__movementAnalytics",
  "__carrierTaskBoard",
  "__carrierTaskClaims",
  "__creepAssignmentState",
  "__pickupReservations",
  "__workerTaskBoard",
  "colours",
  "roomPlanCache",
]);

const BUILD_GLOBAL_CONSTANTS = new Set([
  "__BUILD_VERSION__",
  "__BUILD_GIT_HASH__",
  "__BUILD_TIME__",
  "__BUILD_TAG__",
  "__BUILD_COMMIT__",
  "__BUILD_TREE__",
  "__BUILD_BRANCH__",
  "__BUILD_DIRTY__",
  "__BUILD_DEPLOY_BRANCH__",
]);

const EXPECTED_PRIVATE_GLOBAL_SLOTS = [...PRIVATE_GLOBAL_SLOTS].sort();
const EXPECTED_BUILD_GLOBAL_CONSTANTS = [...BUILD_GLOBAL_CONSTANTS].sort();

const ABI_CONTRACT_SOURCE = `
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
      (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
type Expect<Value extends true> = Value;
type IsAny<Value> = 0 extends 1 & Value ? true : false;
type IsNever<Value> = [Value] extends [never] ? true : false;

type MemoryAudit = typeof import("@/runtime/consoleCommands").memoryAudit;
type MemoryAuditRaw = typeof import("@/runtime/consoleCommands").memoryAuditRaw;
type GrantMutationLease = typeof import("@/runtime/marketSaleAutomation").grantMarketSaleMutationLease;
type RevokeMutationLease = typeof import("@/runtime/marketSaleAutomation").revokeMarketSaleMutationLease;
type AttestPendingCreate = typeof import("@/runtime/marketSaleAutomation").attestMarketSalePendingCreate;
type ResolvePendingCreateAbsence = typeof import("@/runtime/marketSaleAutomation").resolveMarketSalePendingCreateAbsence;
type ExpandCanary = typeof import("@/runtime/marketSaleAutomation").expandMarketSaleCanary;
type EmergencyStopAutomation = typeof import("@/runtime/marketSaleAutomation").emergencyStopMarketSaleAutomation;
type AutomationStatus = typeof import("@/runtime/marketSaleAutomation").marketSaleAutomationStatus;

type ContainsAny<Values extends readonly unknown[]> =
  Values extends readonly [infer Head, ...infer Tail]
    ? IsAny<Head> extends true
      ? true
      : ContainsAny<Tail>
    : false;
type AllIncludeUndefined<Values extends readonly unknown[]> =
  Values extends readonly [infer Head, ...infer Tail]
    ? undefined extends Head
      ? AllIncludeUndefined<Tail>
      : false
    : true;
type AllNonNullableCallable<Values extends readonly unknown[]> =
  Values extends readonly [infer Head, ...infer Tail]
    ? IsNever<NonNullable<Head>> extends true
      ? false
      : NonNullable<Head> extends (...args: never[]) => unknown
        ? AllNonNullableCallable<Tail>
        : false
    : true;

type MarketOperatorTypes = [
  typeof global.grantMarketSaleMutationLease,
  typeof global.revokeMarketSaleMutationLease,
  typeof global.attestMarketSalePendingCreate,
  typeof global.resolveMarketSalePendingCreateAbsence,
  typeof global.resolveMarketSaleExternalOrderMutation,
  typeof global.resolveMarketSaleOrderDisappearance,
  typeof global.expandMarketSaleCanary,
  typeof global.emergencyStopMarketSaleAutomation,
  typeof global.marketSaleAutomationStatus,
  typeof global.resolveMarketSaleDirectPending,
  typeof global.proposeMarketDirectContinuousPermit,
  typeof global.acceptMarketDirectContinuousPermit,
  typeof global.marketDirectContinuousStatus,
  typeof global.proposeMarketBaseResourcePermit,
  typeof global.acceptMarketBaseResourcePermit,
  typeof global.marketBaseResourceStatus,
];
type MarketOperatorTypesAreConcrete = Expect<Equal<ContainsAny<MarketOperatorTypes>, false>>;
type MarketOperatorsAllowColdHeap = Expect<Equal<AllIncludeUndefined<MarketOperatorTypes>, true>>;
type MarketOperatorFunctionsAreCallable = Expect<
  Equal<AllNonNullableCallable<MarketOperatorTypes>, true>
>;
type MountAllowsColdHeap = Expect<Equal<typeof global.__screepsMounted, boolean | undefined>>;
type MemoryAuditTypesAreConcrete = Expect<
  Equal<ContainsAny<[typeof global.memoryAudit, typeof global.memoryAuditRaw]>, false>
>;

type MemoryAuditContract = Expect<Equal<typeof global.memoryAudit, MemoryAudit>>;
type MemoryAuditRawContract = Expect<Equal<typeof global.memoryAuditRaw, MemoryAuditRaw>>;
type GrantMutationLeaseContract = Expect<
  Equal<typeof global.grantMarketSaleMutationLease, GrantMutationLease | undefined>
>;
type RevokeMutationLeaseContract = Expect<
  Equal<typeof global.revokeMarketSaleMutationLease, RevokeMutationLease | undefined>
>;
type AttestPendingCreateContract = Expect<
  Equal<typeof global.attestMarketSalePendingCreate, AttestPendingCreate | undefined>
>;
type ResolvePendingCreateAbsenceContract = Expect<
  Equal<
    typeof global.resolveMarketSalePendingCreateAbsence,
    ResolvePendingCreateAbsence | undefined
  >
>;
type ExpandCanaryContract = Expect<
  Equal<typeof global.expandMarketSaleCanary, ExpandCanary | undefined>
>;
type EmergencyStopAutomationContract = Expect<
  Equal<typeof global.emergencyStopMarketSaleAutomation, EmergencyStopAutomation | undefined>
>;
type AutomationStatusContract = Expect<
  Equal<typeof global.marketSaleAutomationStatus, AutomationStatus | undefined>
>;

type PlannerLayout = {
  [structureType: string]: Array<{ x: number; y: number }>;
};
type PlannerContract = Expect<
  Equal<
    typeof global.RP,
    (room: string | Room, showPlan?: boolean) => PlannerLayout | false
  >
>;
type SpawnMaxCarrierContract = Expect<
  Equal<
    typeof global.spawnMaxCarrier,
    typeof import("@/runtime/console/operationsCommands").spawnMaxCarrierCommand
  >
>;
type SpawnMaxCarrierRawContract = Expect<
  Equal<
    typeof global.spawnMaxCarrierRaw,
    typeof import("@/runtime/console/operationsCommands").spawnMaxCarrierRaw
  >
>;

export {};
`;

interface GlobalWrite {
  name: string;
  fileName: string;
  line: number;
}

interface AmbientGlobalVariable {
  name: string;
  fileName: string;
  line: number;
  owner: "declare-global" | "script-top-level" | "namespace-export";
  kind:
    | "variable"
    | "function"
    | "class"
    | "enum"
    | "namespace"
    | "import-equals"
    | "namespace-export";
}

interface GlobalWriteScan {
  assignmentWrites: GlobalWrite[];
  deletions: GlobalWrite[];
  mutations: GlobalWrite[];
  unsupported: string[];
}

interface ProgramAnalysis {
  checker: ts.TypeChecker;
  sourceFiles: ts.SourceFile[];
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function repositoryPath(value: string): string {
  return normalizePath(relative(REPO_ROOT, value));
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => repositoryPath(fileName),
    getCurrentDirectory: () => REPO_ROOT,
    getNewLine: () => "\n",
  });
}

function parseConfig(fileName: string): ts.ParsedCommandLine {
  const configPath = resolve(REPO_ROOT, fileName);
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) {
    throw new Error(formatDiagnostics([loaded.error]));
  }

  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(formatDiagnostics(parsed.errors));
  }
  return parsed;
}

function listFiles(directory: string, suffix: string): string[] {
  const files: string[] = [];
  const visit = (currentDirectory: string): void => {
    for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
      const absolutePath = resolve(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.name.endsWith(suffix)) {
        files.push(absolutePath);
      }
    }
  };
  visit(directory);
  return files.sort();
}

function buildProgramAnalysis(): ProgramAnalysis {
  const config = parseConfig("tsconfig.build.json");
  const program = ts.createProgram({
    rootNames: config.fileNames,
    options: { ...config.options, noEmit: true },
  });
  return {
    checker: program.getTypeChecker(),
    sourceFiles: program.getSourceFiles().filter((sourceFile) => {
      const fileName = normalizePath(sourceFile.fileName);
      return fileName.startsWith(`${normalizePath(SRC_ROOT)}/`);
    }),
  };
}

function legacyJavaScriptAnalysis(): ProgramAnalysis {
  const config = parseConfig("tsconfig.build.json");
  const javaScriptFiles = listFiles(SRC_ROOT, ".js");
  const program = ts.createProgram({
    rootNames: javaScriptFiles,
    options: {
      ...config.options,
      allowJs: true,
      checkJs: false,
      noEmit: true,
    },
  });
  const javaScriptFileSet = new Set(javaScriptFiles.map(normalizePath));
  return {
    checker: program.getTypeChecker(),
    sourceFiles: program
      .getSourceFiles()
      .filter((sourceFile) => javaScriptFileSet.has(normalizePath(sourceFile.fileName))),
  };
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

function symbolOfExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  const unwrapped = unwrapExpression(expression);
  return ts.isIdentifier(unwrapped) ? checker.getSymbolAtLocation(unwrapped) : undefined;
}

function isConstVariableDeclaration(
  declaration: ts.VariableDeclaration,
): boolean {
  return (
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

function collectStableVariableAliases(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  rootSymbol: ts.Symbol,
): Set<ts.Symbol> {
  const aliases = new Set<ts.Symbol>([rootSymbol]);
  const declarations: ts.VariableDeclaration[] = [];
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isConstVariableDeclaration(node)
    ) {
      declarations.push(node);
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      const declarationSymbol = checker.getSymbolAtLocation(declaration.name);
      const initializerSymbol = symbolOfExpression(declaration.initializer!, checker);
      if (
        declarationSymbol &&
        initializerSymbol &&
        aliases.has(initializerSymbol) &&
        !aliases.has(declarationSymbol)
      ) {
        aliases.add(declarationSymbol);
        changed = true;
      }
    }
  }
  return aliases;
}

function staticGlobalPropertyName(
  expression: ts.Expression,
  aliases: ReadonlySet<ts.Symbol>,
  checker: ts.TypeChecker,
): string | undefined {
  const unwrapped = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return isGlobalAliasExpression(unwrapped.expression, aliases, checker)
      ? unwrapped.name.text
      : undefined;
  }
  if (ts.isElementAccessExpression(unwrapped)) {
    const argument = unwrapped.argumentExpression
      ? unwrapExpression(unwrapped.argumentExpression)
      : undefined;
    return isGlobalAliasExpression(unwrapped.expression, aliases, checker) &&
      argument &&
      (ts.isStringLiteralLike(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) &&
      argument.text.length > 0
      ? argument.text
      : undefined;
  }
  return undefined;
}

function isGlobalAliasExpression(
  expression: ts.Expression,
  aliases: ReadonlySet<ts.Symbol>,
  checker: ts.TypeChecker,
): boolean {
  const symbol = symbolOfExpression(expression, checker);
  return symbol !== undefined && aliases.has(symbol);
}

function globalPropertyProtocolViolation(
  expression: ts.Expression,
  aliases: ReadonlySet<ts.Symbol>,
  checker: ts.TypeChecker,
  globalThisAliases: ReadonlySet<ts.Symbol>,
): string | undefined {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isPropertyAccessExpression(unwrapped) && !ts.isElementAccessExpression(unwrapped)) {
    return undefined;
  }
  const receiverSymbol = symbolOfExpression(unwrapped.expression, checker);
  if (receiverSymbol && globalThisAliases.has(receiverSymbol)) {
    return "writes through globalThis; runtime bot globals must use the audited global root";
  }
  if (!receiverSymbol || !aliases.has(receiverSymbol) || !ts.isElementAccessExpression(unwrapped)) {
    return undefined;
  }
  const argument = unwrapped.argumentExpression
    ? unwrapExpression(unwrapped.argumentExpression)
    : undefined;
  if (!argument || !(ts.isStringLiteralLike(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
    return "uses a dynamic global[key] write; install names must be statically auditable";
  }
  return argument.text.length === 0
    ? "uses an empty global property name; install names must be non-empty"
    : undefined;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function invalidInstallerValueReason(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): string | undefined {
  const unwrapped = unwrapExpression(expression);
  if (unwrapped.kind === ts.SyntaxKind.NullKeyword) {
    return "uses null as a global installer value";
  }
  if (ts.isVoidExpression(unwrapped)) {
    return "uses a void expression as a global installer value";
  }
  if (ts.isIdentifier(unwrapped) && unwrapped.text === "undefined") {
    const symbol = checker.getSymbolAtLocation(unwrapped);
    const rootUndefined = checker.resolveName(
      "undefined",
      undefined,
      ts.SymbolFlags.Value,
      false,
    );
    if (!symbol || symbol === rootUndefined) {
      return "uses undefined as a global installer value";
    }
  }
  return undefined;
}

function staticCallTarget(
  expression: ts.LeftHandSideExpression,
): { owner: ts.Identifier; method: string | undefined } | undefined {
  const unwrapped = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped) && ts.isIdentifier(unwrapped.expression)) {
    return { owner: unwrapped.expression, method: unwrapped.name.text };
  }
  if (ts.isElementAccessExpression(unwrapped) && ts.isIdentifier(unwrapped.expression)) {
    const argument = unwrapped.argumentExpression
      ? unwrapExpression(unwrapped.argumentExpression)
      : undefined;
    return {
      owner: unwrapped.expression,
      method:
        argument &&
        (ts.isStringLiteralLike(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
          ? argument.text
          : undefined,
    };
  }
  return undefined;
}

function assignmentTargetSymbols(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.Symbol[] {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    const symbol = checker.getSymbolAtLocation(unwrapped);
    return symbol ? [symbol] : [];
  }
  if (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return assignmentTargetSymbols(unwrapped.left, checker);
  }
  if (ts.isArrayLiteralExpression(unwrapped)) {
    return unwrapped.elements.flatMap((element) =>
      ts.isOmittedExpression(element)
        ? []
        : assignmentTargetSymbols(
            ts.isSpreadElement(element) ? element.expression : element,
            checker,
          ),
    );
  }
  if (ts.isObjectLiteralExpression(unwrapped)) {
    return unwrapped.properties.flatMap((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        const symbol = checker.getShorthandAssignmentValueSymbol(property);
        return symbol ? [symbol] : [];
      }
      if (ts.isPropertyAssignment(property)) {
        return assignmentTargetSymbols(property.initializer, checker);
      }
      if (ts.isSpreadAssignment(property)) {
        return assignmentTargetSymbols(property.expression, checker);
      }
      return [];
    });
  }
  return [];
}

function assignmentTargetLeaves(
  expression: ts.Expression,
  nestedDefaults?: Set<ts.BinaryExpression>,
): ts.Expression[] {
  const unwrapped = unwrapExpression(expression);
  if (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    nestedDefaults?.add(unwrapped);
    return assignmentTargetLeaves(unwrapped.left, nestedDefaults);
  }
  if (ts.isArrayLiteralExpression(unwrapped)) {
    return unwrapped.elements.flatMap((element) =>
      ts.isOmittedExpression(element)
        ? []
        : assignmentTargetLeaves(
            ts.isSpreadElement(element) ? element.expression : element,
            nestedDefaults,
          ),
    );
  }
  if (ts.isObjectLiteralExpression(unwrapped)) {
    return unwrapped.properties.flatMap((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return [property.name];
      }
      if (ts.isPropertyAssignment(property)) {
        return assignmentTargetLeaves(property.initializer, nestedDefaults);
      }
      if (ts.isSpreadAssignment(property)) {
        return assignmentTargetLeaves(property.expression, nestedDefaults);
      }
      return [];
    });
  }
  return [unwrapped];
}

function isInsideTypeNode(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) {
      return true;
    }
    if (ts.isStatement(current) || ts.isSourceFile(current)) {
      return false;
    }
  }
  return false;
}

function transparentExpressionRoot(node: ts.Identifier): ts.Node {
  let current: ts.Node = node;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }
  return current;
}

function aliasValueEscapeReason(
  identifier: ts.Identifier,
  aliases: ReadonlySet<ts.Symbol>,
  checker: ts.TypeChecker,
): string | undefined {
  if (isInsideTypeNode(identifier)) {
    return undefined;
  }
  const parent = identifier.parent;
  if (
    (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) &&
    parent.name === identifier
  ) {
    return undefined;
  }

  const root = transparentExpressionRoot(identifier);
  const rootParent = root.parent;
  if (
    rootParent &&
    ts.isVariableDeclaration(rootParent) &&
    rootParent.initializer === root &&
    ts.isIdentifier(rootParent.name) &&
    isConstVariableDeclaration(rootParent)
  ) {
    const bindingSymbol = checker.getSymbolAtLocation(rootParent.name);
    if (bindingSymbol && aliases.has(bindingSymbol)) {
      return undefined;
    }
  }
  if (rootParent && ts.isPropertyAccessExpression(rootParent) && rootParent.expression === root) {
    return undefined;
  }
  if (rootParent && ts.isElementAccessExpression(rootParent) && rootParent.expression === root) {
    const argument = rootParent.argumentExpression
      ? unwrapExpression(rootParent.argumentExpression)
      : undefined;
    if (
      argument &&
      (ts.isStringLiteralLike(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) &&
      argument.text.length > 0
    ) {
      return undefined;
    }
    return "uses global or an alias as a dynamic/empty property receiver";
  }
  if (rootParent && ts.isCallExpression(rootParent) && rootParent.arguments.includes(root as ts.Expression)) {
    return "passes global or an alias as a call argument";
  }
  if (rootParent && ts.isReturnStatement(rootParent)) {
    return "returns global or an alias from a function";
  }
  if (rootParent && ts.isArrowFunction(rootParent) && rootParent.body === root) {
    return "returns global or an alias from a concise arrow";
  }
  if (
    rootParent &&
    ts.isVariableDeclaration(rootParent) &&
    rootParent.initializer === root &&
    !ts.isIdentifier(rootParent.name)
  ) {
    return "destructures global or an alias";
  }
  return "escapes global or an alias outside a stable const initializer or static property receiver";
}

function collectGlobalWrites(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): GlobalWriteScan {
  const rootGlobalSymbol = checker.resolveName(
    "global",
    undefined,
    ts.SymbolFlags.Value,
    false,
  );
  if (!rootGlobalSymbol) {
    throw new Error(`${repositoryPath(sourceFile.fileName)} cannot resolve the platform global`);
  }
  const rootGlobalThisSymbol = checker.resolveName(
    "globalThis",
    undefined,
    ts.SymbolFlags.Value,
    false,
  );
  const aliases = collectStableVariableAliases(sourceFile, checker, rootGlobalSymbol);
  const globalThisAliases = rootGlobalThisSymbol
    ? collectStableVariableAliases(sourceFile, checker, rootGlobalThisSymbol)
    : new Set<ts.Symbol>();
  const assignmentWrites: GlobalWrite[] = [];
  const deletions: GlobalWrite[] = [];
  const mutations: GlobalWrite[] = [];
  const nestedDefaultAssignments = new Set<ts.BinaryExpression>();
  const unsupported: string[] = [];
  const describeUnsupported = (node: ts.Node, reason: string): void => {
    const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    unsupported.push(`${repositoryPath(sourceFile.fileName)}:${location.line + 1} ${reason}`);
  };
  const invalidatedAliases = new Set<ts.Symbol>();
  const inspectAliasMutation = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      const left = unwrapExpression(node.left);
      const targetSymbols = assignmentTargetSymbols(node.left, checker);
      const reassignedAliases = targetSymbols.filter((symbol) => aliases.has(symbol));
      if (reassignedAliases.length > 0) {
        describeUnsupported(
          node,
          reassignedAliases.includes(rootGlobalSymbol)
            ? "reassigns the platform global binding"
            : ts.isIdentifier(left)
              ? "reassigns a global alias; mutable alias protocols are not auditable"
              : "reassigns a global alias through destructuring",
        );
        for (const symbol of reassignedAliases) {
          if (symbol !== rootGlobalSymbol) {
            invalidatedAliases.add(symbol);
          }
        }
      } else if (
        ts.isIdentifier(left) &&
        isGlobalAliasExpression(node.right, aliases, checker)
      ) {
        describeUnsupported(
          node,
          "establishes a global alias by assignment; declare a stable initialized binding instead",
        );
      }
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      const operand = unwrapExpression(node.operand);
      const operandSymbol = ts.isIdentifier(operand)
        ? checker.getSymbolAtLocation(operand)
        : undefined;
      if (operandSymbol && aliases.has(operandSymbol)) {
        describeUnsupported(node, "mutates a global alias binding");
        if (operandSymbol !== rootGlobalSymbol) {
          invalidatedAliases.add(operandSymbol);
        }
      }
    }
    ts.forEachChild(node, inspectAliasMutation);
  };
  inspectAliasMutation(sourceFile);
  const effectiveAliases = new Set(
    [...aliases].filter((alias) => !invalidatedAliases.has(alias)),
  );

  const inspectAliasEscapes = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol && globalThisAliases.has(symbol) && !isInsideTypeNode(node)) {
        const parent = node.parent;
        const isBindingName =
          (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) &&
          parent.name === node;
        if (!isBindingName) {
          describeUnsupported(
            node,
            "uses globalThis or an alias; runtime bot globals must use the audited global root",
          );
        }
      } else if (symbol && effectiveAliases.has(symbol)) {
        const reason = aliasValueEscapeReason(node, effectiveAliases, checker);
        if (reason) {
          describeUnsupported(node, reason);
        }
      }
    }
    ts.forEachChild(node, inspectAliasEscapes);
  };
  inspectAliasEscapes(sourceFile);

  const addStaticMutation = (
    expression: ts.Expression,
    target: GlobalWrite[],
  ): void => {
    const name = staticGlobalPropertyName(expression, effectiveAliases, checker);
    if (!name) {
      const violation = globalPropertyProtocolViolation(
        expression,
        effectiveAliases,
        checker,
        globalThisAliases,
      );
      if (violation) {
        describeUnsupported(expression, violation);
      }
      return;
    }
    const location = sourceFile.getLineAndCharacterOfPosition(expression.getStart(sourceFile));
    target.push({
      name,
      fileName: repositoryPath(sourceFile.fileName),
      line: location.line + 1,
    });
  };
  const rejectNestedOrLoopGlobalTarget = (
    expression: ts.Expression,
    protocol: "nested assignment" | "for-in/of",
  ): void => {
    for (const target of assignmentTargetLeaves(expression, nestedDefaultAssignments)) {
      const name = staticGlobalPropertyName(target, effectiveAliases, checker);
      if (name) {
        describeUnsupported(
          target,
          `${protocol} writes global.${name}; use a direct static assignment installer`,
        );
        continue;
      }
      const violation = globalPropertyProtocolViolation(
        target,
        effectiveAliases,
        checker,
        globalThisAliases,
      );
      if (violation) {
        describeUnsupported(target, `${protocol}: ${violation}`);
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      if (!nestedDefaultAssignments.has(node)) {
        const left = unwrapExpression(node.left);
        if (ts.isArrayLiteralExpression(left) || ts.isObjectLiteralExpression(left)) {
          rejectNestedOrLoopGlobalTarget(node.left, "nested assignment");
        } else if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const installerName = staticGlobalPropertyName(
            node.left,
            effectiveAliases,
            checker,
          );
          const invalidValue = installerName
            ? invalidInstallerValueReason(node.right, checker)
            : undefined;
          if (invalidValue) {
            describeUnsupported(node, `${invalidValue} for global.${installerName}`);
          } else {
            addStaticMutation(node.left, assignmentWrites);
          }
        } else {
          addStaticMutation(node.left, mutations);
        }
      }
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      addStaticMutation(node.operand, mutations);
    } else if (ts.isDeleteExpression(node)) {
      const name = staticGlobalPropertyName(node.expression, effectiveAliases, checker);
      if (name) {
        const location = sourceFile.getLineAndCharacterOfPosition(
          node.expression.getStart(sourceFile),
        );
        deletions.push({
          name,
          fileName: repositoryPath(sourceFile.fileName),
          line: location.line + 1,
        });
      } else {
        addStaticMutation(node.expression, deletions);
      }
    } else if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      rejectNestedOrLoopGlobalTarget(node.initializer, "for-in/of");
    } else if (ts.isCallExpression(node)) {
      const target = staticCallTarget(node.expression);
      const ownerSymbol = target ? checker.getSymbolAtLocation(target.owner) : undefined;
      const rootOwnerSymbol = target
        ? checker.resolveName(target.owner.text, undefined, ts.SymbolFlags.Value, false)
        : undefined;
      const firstArgument = node.arguments[0];
      const firstArgumentSymbol = firstArgument
        ? symbolOfExpression(firstArgument, checker)
        : undefined;
      const targetsAuditedGlobal = firstArgument
        ? isGlobalAliasExpression(firstArgument, effectiveAliases, checker) ||
          (firstArgumentSymbol !== undefined && globalThisAliases.has(firstArgumentSymbol))
        : false;
      const supportedMutationApi =
        target?.owner.text === "Object"
          ? target.method === "assign" ||
            target.method === "defineProperty" ||
            target.method === "defineProperties"
          : target?.owner.text === "Reflect"
            ? target.method === "defineProperty" || target.method === "set"
            : false;
      const dynamicMutationApi =
        (target?.owner.text === "Object" || target?.owner.text === "Reflect") &&
        target.method === undefined;
      if (
        target?.method === "valueOf" &&
        ownerSymbol !== undefined &&
        effectiveAliases.has(ownerSymbol)
      ) {
        describeUnsupported(
          node,
          `${node.expression.getText(sourceFile)} escapes the global object through valueOf()`,
        );
      }
      if (
        target &&
        ownerSymbol === rootOwnerSymbol &&
        targetsAuditedGlobal &&
        (supportedMutationApi || dynamicMutationApi)
      ) {
        describeUnsupported(
          node,
          `${node.expression.getText(sourceFile)} mutates global indirectly; use a static property assignment`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return {
    assignmentWrites,
    deletions,
    mutations,
    unsupported: [...new Set(unsupported)].sort(),
  };
}

function ambientGlobalVariables(sourceFile: ts.SourceFile): AmbientGlobalVariable[] {
  const variables: AmbientGlobalVariable[] = [];
  const addVariable = (
    declaration: ts.VariableDeclaration,
    owner: AmbientGlobalVariable["owner"],
  ): void => {
    if (!ts.isIdentifier(declaration.name)) {
      return;
    }
    const location = sourceFile.getLineAndCharacterOfPosition(
      declaration.name.getStart(sourceFile),
    );
    variables.push({
      name: declaration.name.text,
      fileName: repositoryPath(sourceFile.fileName),
      line: location.line + 1,
      owner,
      kind: "variable",
    });
  };
  const addNamedValue = (
    statement:
      | ts.FunctionDeclaration
      | ts.ClassDeclaration
      | ts.EnumDeclaration
      | ts.ModuleDeclaration
      | ts.ImportEqualsDeclaration,
    owner: AmbientGlobalVariable["owner"],
  ): void => {
    const name = statement.name;
    if (!name || (!ts.isIdentifier(name) && !ts.isStringLiteralLike(name))) {
      return;
    }
    const location = sourceFile.getLineAndCharacterOfPosition(name.getStart(sourceFile));
    variables.push({
      name: name.text,
      fileName: repositoryPath(sourceFile.fileName),
      line: location.line + 1,
      owner,
      kind: ts.isFunctionDeclaration(statement)
        ? "function"
        : ts.isClassDeclaration(statement)
          ? "class"
          : ts.isEnumDeclaration(statement)
            ? "enum"
            : ts.isModuleDeclaration(statement)
              ? "namespace"
              : "import-equals",
    });
  };

  for (const statement of sourceFile.statements) {
    if (
      !ts.isModuleDeclaration(statement) ||
      !ts.isIdentifier(statement.name) ||
      statement.name.text !== "global" ||
      (statement.flags & ts.NodeFlags.GlobalAugmentation) === 0 ||
      !statement.body ||
      !ts.isModuleBlock(statement.body)
    ) {
      continue;
    }
    for (const globalStatement of statement.body.statements) {
      if (ts.isVariableStatement(globalStatement)) {
        for (const declaration of globalStatement.declarationList.declarations) {
          addVariable(declaration, "declare-global");
        }
      } else if (
        ts.isFunctionDeclaration(globalStatement) ||
        ts.isClassDeclaration(globalStatement) ||
        ts.isEnumDeclaration(globalStatement) ||
        ts.isModuleDeclaration(globalStatement) ||
        ts.isImportEqualsDeclaration(globalStatement)
      ) {
        addNamedValue(globalStatement, "declare-global");
      }
    }
  }

  if (!ts.isExternalModule(sourceFile)) {
    for (const statement of sourceFile.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          addVariable(declaration, "script-top-level");
        }
      } else if (
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement) ||
        ts.isImportEqualsDeclaration(statement)
      ) {
        addNamedValue(statement, "script-top-level");
      }
    }
  }
  for (const statement of sourceFile.statements) {
    if (!ts.isNamespaceExportDeclaration(statement)) {
      continue;
    }
    const location = sourceFile.getLineAndCharacterOfPosition(
      statement.name.getStart(sourceFile),
    );
    variables.push({
      name: statement.name.text,
      fileName: repositoryPath(sourceFile.fileName),
      line: location.line + 1,
      owner: "namespace-export",
      kind: "namespace-export",
    });
  }
  return variables;
}

function globalDeclarationSource(): ts.SourceFile {
  return ts.createSourceFile(
    GLOBAL_DECLARATION,
    readFileSync(GLOBAL_DECLARATION, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function duplicateNames(values: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort();
}

function setDifference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((value) => !right.has(value)).sort();
}

function virtualProgramAnalysis(fileName: string, sourceText: string): ProgramAnalysis {
  const config = parseConfig("tsconfig.build.json");
  const virtualFileName = resolve(REPO_ROOT, fileName);
  const normalizedVirtualFileName = normalizePath(virtualFileName);
  const options: ts.CompilerOptions = { ...config.options, noEmit: true };
  const host = ts.createCompilerHost(options, true);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);

  host.fileExists = (candidate) =>
    normalizePath(candidate) === normalizedVirtualFileName || originalFileExists(candidate);
  host.readFile = (candidate) =>
    normalizePath(candidate) === normalizedVirtualFileName
      ? sourceText
      : originalReadFile(candidate);
  host.getSourceFile = (candidate, languageVersion, onError, shouldCreateNewSourceFile) =>
    normalizePath(candidate) === normalizedVirtualFileName
      ? ts.createSourceFile(
          virtualFileName,
          sourceText,
          languageVersion,
          true,
          ts.ScriptKind.TS,
        )
      : originalGetSourceFile(
          candidate,
          languageVersion,
          onError,
          shouldCreateNewSourceFile,
        );

  const program = ts.createProgram({
    rootNames: [virtualFileName],
    options,
    host,
  });
  const sourceFile = program.getSourceFile(virtualFileName);
  if (!sourceFile) {
    throw new Error(`virtual analysis source missing: ${fileName}`);
  }
  return { checker: program.getTypeChecker(), sourceFiles: [sourceFile] };
}

function compileAbiContract(): readonly ts.Diagnostic[] {
  const config = parseConfig("tsconfig.build.json");
  const virtualFileName = resolve(REPO_ROOT, "test/__ambientGlobalAbiContract.virtual.ts");
  const normalizedVirtualFileName = normalizePath(virtualFileName);
  const options: ts.CompilerOptions = {
    ...config.options,
    noEmit: true,
    strictNullChecks: true,
  };
  const host = ts.createCompilerHost(options, true);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);

  host.fileExists = (fileName) =>
    normalizePath(fileName) === normalizedVirtualFileName || originalFileExists(fileName);
  host.readFile = (fileName) =>
    normalizePath(fileName) === normalizedVirtualFileName
      ? ABI_CONTRACT_SOURCE
      : originalReadFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    normalizePath(fileName) === normalizedVirtualFileName
      ? ts.createSourceFile(
          virtualFileName,
          ABI_CONTRACT_SOURCE,
          languageVersion,
          true,
          ts.ScriptKind.TS,
        )
      : originalGetSourceFile(
          fileName,
          languageVersion,
          onError,
          shouldCreateNewSourceFile,
        );

  const program = ts.createProgram({
    rootNames: [...config.fileNames, virtualFileName],
    options,
    host,
  });
  const virtualSourceFile = program.getSourceFile(virtualFileName);
  if (!virtualSourceFile) {
    throw new Error("virtual ambient ABI contract was not added to the TypeScript Program");
  }
  return [
    ...program.getSyntacticDiagnostics(virtualSourceFile),
    ...program.getSemanticDiagnostics(virtualSourceFile),
  ];
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

function directValueOrTypeNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      bindingNames(declaration.name),
    );
  }
  if (ts.isExportDeclaration(statement) && statement.exportClause) {
    return ts.isNamedExports(statement.exportClause)
      ? statement.exportClause.elements.map((element) => element.name.text)
      : ts.isNamespaceExport(statement.exportClause)
        ? [statement.exportClause.name.text]
        : [];
  }
  if (ts.isNamespaceExportDeclaration(statement)) {
    return [statement.name.text];
  }
  const named = statement as unknown as ts.NamedDeclaration;
  return named.name &&
    (ts.isIdentifier(named.name) || ts.isStringLiteralLike(named.name))
    ? [named.name.text]
    : [];
}

function nodeJsGlobalMirrorViolations(sourceFile: ts.SourceFile): string[] {
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    const parent = node.parent;
    const isGlobalRoot =
      parent !== undefined &&
      (ts.isSourceFile(parent) ||
        (ts.isModuleBlock(parent) &&
          ts.isModuleDeclaration(parent.parent) &&
          ts.isIdentifier(parent.parent.name) &&
          parent.parent.name.text === "global" &&
          (parent.parent.flags & ts.NodeFlags.GlobalAugmentation) !== 0));
    if (
      ts.isModuleDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "NodeJS" &&
      isGlobalRoot &&
      node.body
    ) {
      if (ts.isModuleBlock(node.body)) {
        for (const statement of node.body.statements) {
          if (directValueOrTypeNames(statement).includes("Global")) {
            const location = sourceFile.getLineAndCharacterOfPosition(
              statement.getStart(sourceFile),
            );
            violations.push(
              `${repositoryPath(sourceFile.fileName)}:${location.line + 1} directly defines NodeJS.Global`,
            );
          }
        }
      } else if (
        ts.isModuleDeclaration(node.body) &&
        (ts.isIdentifier(node.body.name) || ts.isStringLiteralLike(node.body.name)) &&
        node.body.name.text === "Global"
      ) {
        const location = sourceFile.getLineAndCharacterOfPosition(
          node.body.name.getStart(sourceFile),
        );
        violations.push(
          `${repositoryPath(sourceFile.fileName)}:${location.line + 1} defines dotted NodeJS.Global`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

describe("ambient global ABI ownership boundaries", () => {
  test("write scanner recognizes static aliases and rejects indirect install protocols", () => {
    const fixture = virtualProgramAnalysis(
      "test/__ambientGlobalWriteScanner.fixture.ts",
      `
global.directInstall = directInstall;
global["stringInstall"] = stringInstall;
const typedAlias = (global as typeof global);
const nonNullAlias = typedAlias!;
const satisfiesAlias = nonNullAlias satisfies typeof global;
satisfiesAlias.aliasInstall = aliasInstall;
delete satisfiesAlias.deletedSlot;
satisfiesAlias.incrementedSlot++;
global.lifecyclePublic = lifecycleInstaller;
global.memoryAuditLike = ((undefined as unknown)!);
global.memoryAuditRawLike = (null as unknown);
global.marketStatusLike = ((void 0) as unknown);
delete global.lifecyclePublic;
global.lifecyclePublic++;
global.compoundAnd &&= compoundAndInstaller;
global.compoundOr ||= compoundOrInstaller;
global.compoundNullish ??= compoundNullishInstaller;
global.compoundAdd += compoundAddValue;
function installFromDefault(parameterAlias = global) {
  parameterAlias.parameterDefaultInstall = parameterDefaultInstall;
}
function shadowBindings(global, satisfiesAlias, Object) {
  global.shadowedGlobal = shadowedGlobal;
  satisfiesAlias.shadowedAlias = shadowedAlias;
  Object.assign(global, { shadowedObjectCall });
}
const reassignedAlias = global;
reassignedAlias = unrelatedObject;
reassignedAlias.afterReassignment = afterReassignment;
const destructuredVictim = global;
({ slot: destructuredVictim } = replacementObject);
destructuredVictim.afterDestructuring = afterDestructuring;
let lateAlias;
lateAlias = global;
lateAlias.lateInstall = lateInstall;
mutate(global);
const reflectedSet = Reflect.set;
reflectedSet(global, "escapedByBuiltinAlias", escapedByBuiltinAlias);
const { set: destructuredSet } = Reflect;
destructuredSet(global, "escapedByDestructure", escapedByDestructure);
const boundMutation = mutate.bind(undefined, global);
function leakGlobal() { return global; }
const getGlobal = () => global;
getGlobal().hiddenInstall = hiddenInstall;
const { Game: escapedGame } = global;
({ command: global.nestedObjectTarget } = nestedSource);
[global.nestedArrayTarget] = nestedArraySource;
({ command: global.nestedDefaultObject = nestedDefaultObject } = nestedDefaultSource);
[global.nestedDefaultArray = nestedDefaultArray] = nestedDefaultArraySource;
for (global.loopOfTarget of loopValues) {}
for (global.loopInTarget in loopObject) {}
global[dynamicName] = dynamicInstall;
global[""] = emptyInstall;
globalThis.globalThisInstall = globalThisInstall;
const globalThisAlias = globalThis;
globalThisAlias.aliasInstall = aliasInstall;
global.valueOf();
typedAlias["valueOf"]();
Object.assign(global, { assignedInstall });
Object["assign"](global, { computedAssignedInstall });
Object.defineProperty(typedAlias, "definedInstall", { value: definedInstall });
Reflect.defineProperty(nonNullAlias, "reflectedInstall", { value: reflectedInstall });
Reflect.set(global, "reflectedSetInstall", reflectedSetInstall);
`,
    );

    const scan = collectGlobalWrites(fixture.sourceFiles[0], fixture.checker);
    expect(
      [...new Set(scan.assignmentWrites.map((write) => write.name))].sort(),
    ).toEqual([
      "aliasInstall",
      "directInstall",
      "lifecyclePublic",
      "stringInstall",
    ]);
    expect(scan.deletions.map((deletion) => deletion.name).sort()).toEqual([
      "deletedSlot",
      "lifecyclePublic",
    ]);
    expect([...new Set(scan.mutations.map((mutation) => mutation.name))].sort()).toEqual([
      "compoundAdd",
      "compoundAnd",
      "compoundNullish",
      "compoundOr",
      "incrementedSlot",
      "lifecyclePublic",
    ]);
    expect(scan.unsupported.length).toBeGreaterThanOrEqual(18);
    expect(scan.unsupported.join("\n")).toContain("dynamic global[key] write");
    expect(scan.unsupported.join("\n")).toContain("empty global property name");
    expect(scan.unsupported.join("\n")).toContain("writes through globalThis");
    expect(scan.unsupported.join("\n")).toContain("reassigns a global alias");
    expect(scan.unsupported.join("\n")).toContain(
      "reassigns a global alias through destructuring",
    );
    expect(scan.unsupported.join("\n")).toContain("establishes a global alias by assignment");
    expect(scan.unsupported.join("\n")).toContain(
      "passes global or an alias as a call argument",
    );
    expect(scan.unsupported.join("\n")).toContain("returns global or an alias");
    expect(scan.unsupported.join("\n")).toContain("destructures global or an alias");
    expect(scan.unsupported.join("\n")).toContain("uses globalThis or an alias");
    expect(scan.unsupported.join("\n")).toContain(
      "uses undefined as a global installer value for global.memoryAuditLike",
    );
    expect(scan.unsupported.join("\n")).toContain(
      "uses null as a global installer value for global.memoryAuditRawLike",
    );
    expect(scan.unsupported.join("\n")).toContain(
      "uses a void expression as a global installer value for global.marketStatusLike",
    );
    expect(scan.unsupported.join("\n")).toContain(
      "escapes the global object through valueOf()",
    );
    expect(scan.unsupported.join("\n")).toContain(
      "nested assignment writes global.nestedObjectTarget",
    );
    expect(scan.unsupported.join("\n")).toContain(
      "nested assignment writes global.nestedArrayTarget",
    );
    expect(scan.unsupported.join("\n")).toContain(
      "nested assignment writes global.nestedDefaultObject",
    );
    expect(scan.unsupported.join("\n")).toContain(
      "nested assignment writes global.nestedDefaultArray",
    );
    expect(scan.unsupported.join("\n")).toContain("for-in/of writes global.loopOfTarget");
    expect(scan.unsupported.join("\n")).toContain("for-in/of writes global.loopInTarget");
    expect(scan.unsupported.join("\n")).toContain("Object.assign mutates global indirectly");
    expect(scan.unsupported.join("\n")).toContain('Object["assign"] mutates global indirectly');
    expect(scan.unsupported.join("\n")).toContain(
      "Object.defineProperty mutates global indirectly",
    );
    expect(scan.unsupported.join("\n")).toContain(
      "Reflect.defineProperty mutates global indirectly",
    );
    expect(scan.unsupported.join("\n")).toContain("Reflect.set mutates global indirectly");
  });

  test("ambient scanner distinguishes declare global from script and module-local declarations", () => {
    const scriptDeclaration = ts.createSourceFile(
      resolve(REPO_ROOT, "src/__ambientScript.fixture.d.ts"),
      `
declare var scriptGhost: string;
declare function scriptFunctionGhost(): void;
declare class ScriptClassGhost {}
declare namespace ScriptNamespaceGhost {}
`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const externalDeclaration = ts.createSourceFile(
      resolve(REPO_ROOT, "src/__ambientExternal.fixture.d.ts"),
      `
declare global { var publicCommand: () => void; }
declare global {
  interface PureInterface {}
  type PureType = string;
  function forbiddenFunction(): void;
  class ForbiddenClass {}
  enum ForbiddenEnum { Value }
  namespace ForbiddenNamespace {}
}
declare var moduleLocalGhost: string;
export as namespace Ghost;
export {};
`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    expect(ambientGlobalVariables(scriptDeclaration)).toEqual([
      expect.objectContaining({ name: "scriptGhost", owner: "script-top-level" }),
      expect.objectContaining({ name: "scriptFunctionGhost", owner: "script-top-level" }),
      expect.objectContaining({ name: "ScriptClassGhost", owner: "script-top-level" }),
      expect.objectContaining({ name: "ScriptNamespaceGhost", owner: "script-top-level" }),
    ]);
    expect(ambientGlobalVariables(externalDeclaration)).toEqual([
      expect.objectContaining({ name: "publicCommand", owner: "declare-global" }),
      expect.objectContaining({ name: "forbiddenFunction", kind: "function" }),
      expect.objectContaining({ name: "ForbiddenClass", kind: "class" }),
      expect.objectContaining({ name: "ForbiddenEnum", kind: "enum" }),
      expect.objectContaining({ name: "ForbiddenNamespace", kind: "namespace" }),
      expect.objectContaining({ name: "Ghost", kind: "namespace-export" }),
    ]);
  });

  test("production global writes and declare global expose the same public ABI", () => {
    const build = buildProgramAnalysis();
    const legacyJavaScript = legacyJavaScriptAnalysis();
    const scans = [
      ...build.sourceFiles
        .filter((sourceFile) => !sourceFile.isDeclarationFile)
        .map((sourceFile) => collectGlobalWrites(sourceFile, build.checker)),
      ...legacyJavaScript.sourceFiles.map((sourceFile) =>
        collectGlobalWrites(sourceFile, legacyJavaScript.checker),
      ),
    ];
    const writes = scans.flatMap((scan) => scan.assignmentWrites);
    const deletions = scans.flatMap((scan) => scan.deletions);
    const mutations = scans.flatMap((scan) => scan.mutations);
    const unsupportedWrites = scans.flatMap((scan) => scan.unsupported).sort();
    const installedSlots = new Set(writes.map((write) => write.name));
    const deletedSlots = new Set(deletions.map((deletion) => deletion.name));
    const ambientVariables = build.sourceFiles.flatMap(ambientGlobalVariables);
    const ambientSlots = new Set(ambientVariables.map((variable) => variable.name));

    const missingPrivateSlots = setDifference(PRIVATE_GLOBAL_SLOTS, installedSlots);
    const privateSlotsDeclaredAsPublic = [...PRIVATE_GLOBAL_SLOTS]
      .filter((name) => ambientSlots.has(name))
      .sort();
    const publicInstalledSlots = new Set(
      [...installedSlots].filter((name) => !PRIVATE_GLOBAL_SLOTS.has(name)),
    );
    const publicAmbientSlots = new Set(
      [...ambientSlots].filter((name) => !BUILD_GLOBAL_CONSTANTS.has(name)),
    );

    expect({
      privateSlots: [...PRIVATE_GLOBAL_SLOTS].sort(),
      buildConstants: [...BUILD_GLOBAL_CONSTANTS].sort(),
      missingPrivateSlots,
      privateSlotsDeclaredAsPublic,
      buildConstantsMissingFromAmbient: setDifference(BUILD_GLOBAL_CONSTANTS, ambientSlots),
      duplicateAmbientSlots: duplicateNames(ambientVariables.map((variable) => variable.name)),
      invalidAmbientOwners: ambientVariables
        .filter(
          (variable) =>
            variable.owner !== "declare-global" || variable.kind !== "variable",
        )
        .map(
          (variable) =>
            `${variable.fileName}:${variable.line} ${variable.kind} ${variable.name}`,
        )
        .sort(),
      productionScriptFiles: build.sourceFiles
        .filter((sourceFile) => !ts.isExternalModule(sourceFile))
        .map((sourceFile) => repositoryPath(sourceFile.fileName))
        .sort(),
      illegalPublicDeletions: [...deletedSlots]
        .filter((name) => !PRIVATE_GLOBAL_SLOTS.has(name))
        .sort(),
      illegalPublicMutations: [...new Set(mutations.map((mutation) => mutation.name))]
        .filter((name) => !PRIVATE_GLOBAL_SLOTS.has(name))
        .sort(),
      unsupportedWrites,
      publicInstallsMissingAmbient: setDifference(publicInstalledSlots, publicAmbientSlots),
      ambientWithoutPublicInstaller: setDifference(publicAmbientSlots, publicInstalledSlots),
    }).toEqual({
      privateSlots: EXPECTED_PRIVATE_GLOBAL_SLOTS,
      buildConstants: EXPECTED_BUILD_GLOBAL_CONSTANTS,
      missingPrivateSlots: [],
      privateSlotsDeclaredAsPublic: [],
      buildConstantsMissingFromAmbient: [],
      duplicateAmbientSlots: [],
      invalidAmbientOwners: [],
      productionScriptFiles: [],
      illegalPublicDeletions: [],
      illegalPublicMutations: [],
      unsupportedWrites: [],
      publicInstallsMissingAmbient: [],
      ambientWithoutPublicInstaller: [],
    });
  });

  test("global declaration contains no dead NodeJS.Global or module-local lodash mirror", () => {
    const declaration = globalDeclarationSource();
    const violations: string[] = [];

    for (const statement of declaration.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteralLike(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "lodash"
      ) {
        violations.push("global.d.ts must not import LoDashStatic for a module-local mirror");
      }
      if (ts.isVariableStatement(statement)) {
        for (const variable of statement.declarationList.declarations) {
          if (ts.isIdentifier(variable.name) && variable.name.text === "_") {
            violations.push("global.d.ts must not declare a module-local lodash _ variable");
          }
        }
      }
    }

    for (const sourceFile of buildProgramAnalysis().sourceFiles) {
      violations.push(...nodeJsGlobalMirrorViolations(sourceFile));
    }

    expect(violations).toEqual([]);
    const fixture = ts.createSourceFile(
      resolve(REPO_ROOT, "src/__nodeGlobalMirror.fixture.d.ts"),
      `
declare namespace NodeJS {
  interface Global {}
  interface Holder { Global: string; }
  namespace Nested { interface Global {} }
  export { Exported as Global };
  export * as Global from "node-global-fixture";
  export as namespace Global;
  const { item: Global } = source;
  const [Global] = list;
}
declare namespace NodeJS.Global { interface Shape {} }
declare namespace Outer.NodeJS { interface Global {} }
declare namespace Outer { namespace NodeJS { interface Global {} } }
export {};
`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const fixtureViolations = nodeJsGlobalMirrorViolations(fixture);
    expect(fixtureViolations).toHaveLength(7);
    expect(fixtureViolations.join("\n")).toContain("directly defines NodeJS.Global");
    expect(fixtureViolations.join("\n")).toContain("defines dotted NodeJS.Global");
  });

  test("public command signatures match their exported installers and planner runtime", () => {
    const diagnostics = compileAbiContract();
    expect(formatDiagnostics(diagnostics)).toBe("");
  });
});
