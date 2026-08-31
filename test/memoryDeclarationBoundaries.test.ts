import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import * as ts from "typescript";

const REPO_ROOT = resolve(__dirname, "..");
const GLOBAL_DECLARATION = "src/global.d.ts";

const MEMORY_BRANCHES = {
  cfg: {
    declaration: "src/types/memory/cfg.d.ts",
    interfaceName: "ScreepsMemoryConfig",
    schemaFingerprint: "2387e78f2a0639ee822d599374c3c9c9c5d4ffd4d4e27bb872a0a3cdd960ef51",
    imports: ["@/types/system:RoomType"],
    fields: [
      "rooms",
      "worker",
      "energyPickup",
      "pixelGenerator",
      "roomPlannerBuild",
      "productionMonitor",
      "crossShard",
      "telemetry",
      "movementMetrics",
      "marketSaleDiagnostics",
      "cpuProfiler",
      "synthesisControl",
      "homeDefense",
      "resourceControl",
      "marketSaleAutomation",
      "hub",
      "factoryControl",
      "remoteMining",
    ],
  },
  runtime: {
    declaration: "src/types/memory/runtime.d.ts",
    interfaceName: "ScreepsMemoryRuntime",
    // 【第十三轮】receipt store v5（显式 proof 等级 + contractDigest/
    // authorizationCohortDigest 身份字段）后的 schema 指纹。
    schemaFingerprint: "462258c486b7ff77a2c4753469364ad64ec5750a462e942d931d4f192a9d9370",
    imports: [
      "@/runtime/hubPlanner:AllocationLedgerEntry",
      "@/runtime/hubPlanner:DirectRouteDecision",
      "@/runtime/hubPlanner:ProgressEdge",
      "@/runtime/hubPlanner:SynthesisDispatchAssignment",
      "@/runtime/hubPlanner:SynthesisRoomCapability",
      "@/runtime/hubProtectionSnapshot:HubCommittedProtectionSnapshot",
      "@/runtime/hubProtectionSnapshot:HubProtectionAttempt",
      "@/runtime/resourceControl:MarketTerminalEnergyReadinessObservation",
    ],
    fields: [
      "lastDeployTag",
      "lastDeployCommit",
      "lastDeployTree",
      "lastDeployBundleHash",
      "lastDeployBranch",
      "lastDeployAt",
      "energyPickup",
      "spawnPlanner",
      "roomPlannerBuild",
      "linkNetwork",
      "towerEmergencyRamparts",
      "towerCombat",
      "illegalStructureCleanup",
      "defenseCoordination",
      "crossShard",
      "resourceControl",
      "marketSaleAutomation",
      "factoryControl",
      "synthesisControl",
      "hub",
      "nukerControl",
      "resourceReservations",
      "resourceReservationsCorrupted",
      "resourceReservationsOwnerVersion",
      "treasury",
      "treasuryPerf",
      "powerBankBoost",
      "powerBankObserver",
      "remoteMining",
      "transitDangerRooms",
      "powerBankPermanentDangerRooms",
    ],
  },
  data: {
    declaration: "src/types/memory/data.d.ts",
    interfaceName: "ScreepsMemoryData",
    schemaFingerprint: "e67962e577670078cbfb6befb8446d02259d1fd20323d1e49c4cd9f40a1f03b7",
    imports: [
      "@/runtime/marketActionArbiter:MarketAccountClaim",
      "@/runtime/marketActionArbiter:MarketActionJournalEntry",
      "@/runtime/marketBaseResourceAutomation:MarketBaseResourceV3RuntimeState",
      "@/runtime/marketDirectContinuousAutomation:ContinuousPendingProjection",
      "@/runtime/marketDirectContinuousAutomation:MarketDirectContinuousAutomationState",
      "@/runtime/marketSaleAutomation:MarketBaseResourceActivationAnchor",
      "@/runtime/marketSaleAutomation:MarketBaseResourceContinuousReviewSnapshot",
      "@/runtime/marketSaleDirectAutomation:DirectAutomationState",
      "@/runtime/marketSaleDirectPending:PendingDirectDeal",
      "@/runtime/marketSaleFeeLedger:MarketSaleFeeLedgerState",
      "@/runtime/remoteMining:RemoteMiningTask",
      "@/types/system:CreepConfig",
    ],
    fields: [
      "creepConfigs",
      "manualUpgraders",
      "marketSaleAutomation",
      "resourceControl",
      "factoryTasks",
      "colonization",
      "war",
      "roomPlanner",
      "rescue",
      "flagHauling",
      "crossShardColonization",
      "interShardPortals",
      "powerBankHarvest",
      "powerBankHarvestHistory",
      "remoteMining",
    ],
  },
  analytics: {
    declaration: "src/types/memory/analytics.d.ts",
    interfaceName: "ScreepsMemoryAnalytics",
    schemaFingerprint: "8dc56bc39214dd02906c02dba674664c2a2441d01a341a7d1a4bff1993f97245",
    imports: [
      "@/runtime/cpuMonitor:CpuMonitorMemoryV2",
      "@/runtime/hubProgress:HubProgressSnapshot",
      "@/runtime/warControl:WarStatusTaskSnapshot",
    ],
    fields: ["production", "war", "moduleCpu", "cpuMonitor", "hub"],
  },
} as const;

type MemoryRootName = keyof typeof MEMORY_BRANCHES;

interface LocatedInterface {
  fileName: string;
  declaration: ts.InterfaceDeclaration;
}

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

function listProductionDeclarations(): string[] {
  const declarations: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.name.endsWith(".d.ts")) {
        declarations.push(absolutePath);
      }
    }
  };
  visit(resolve(REPO_ROOT, "src"));
  return declarations.sort();
}

function parseDeclaration(absolutePath: string): ts.SourceFile {
  return ts.createSourceFile(
    absolutePath,
    readFileSync(absolutePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function locateInterfaces(sourceFiles: readonly ts.SourceFile[], name: string): LocatedInterface[] {
  const matches: LocatedInterface[] = [];
  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
        matches.push({
          fileName: repositoryPath(sourceFile.fileName),
          declaration: node,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return matches;
}

function propertyName(name: ts.PropertyName | undefined): string | undefined {
  if (name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))) {
    return name.text;
  }
  return undefined;
}

function isInsideGlobalAugmentation(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isModuleDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      current.name.text === "global" &&
      (current.flags & ts.NodeFlags.GlobalAugmentation) !== 0
    ) {
      return true;
    }
  }
  return false;
}

function isGloballyVisibleInterface(declaration: ts.InterfaceDeclaration): boolean {
  if (isInsideGlobalAugmentation(declaration)) {
    return true;
  }
  const sourceFile = declaration.getSourceFile();
  return declaration.parent === sourceFile && !ts.isExternalModule(sourceFile);
}

function globalScopeStatements(sourceFile: ts.SourceFile): ts.Statement[] {
  const statements: ts.Statement[] = ts.isExternalModule(sourceFile)
    ? []
    : [...sourceFile.statements];
  for (const statement of sourceFile.statements) {
    if (
      ts.isModuleDeclaration(statement) &&
      ts.isIdentifier(statement.name) &&
      statement.name.text === "global" &&
      (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0 &&
      statement.body &&
      ts.isModuleBlock(statement.body)
    ) {
      statements.push(...statement.body.statements);
    }
  }
  return statements;
}

function globalStatementNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations
      .map((declaration) =>
        ts.isIdentifier(declaration.name) ? declaration.name.text : undefined,
      )
      .filter((name): name is string => name !== undefined);
  }
  if (
    (ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isModuleDeclaration(statement)) &&
    statement.name &&
    (ts.isIdentifier(statement.name) || ts.isStringLiteralLike(statement.name))
  ) {
    return [statement.name.text];
  }
  return [];
}

function declarationRuntimeViolations(sourceFile: ts.SourceFile): string[] {
  const violations: string[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!statement.importClause?.isTypeOnly) {
        violations.push("non-type-only import");
      }
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.length === 0
    ) {
      continue;
    }
    if (
      ts.isModuleDeclaration(statement) &&
      ts.isIdentifier(statement.name) &&
      statement.name.text === "global" &&
      (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0
    ) {
      continue;
    }
    violations.push(`runtime-capable top-level ${ts.SyntaxKind[statement.kind]}`);
  }

  const visit = (node: ts.Node): void => {
    if (ts.isEnumDeclaration(node)) {
      violations.push("enum declaration");
    } else if (ts.isFunctionLike(node) && "body" in node && node.body) {
      violations.push(`function body at ${sourceFile.getLineAndCharacterOfPosition(node.pos).line + 1}`);
    } else if (
      (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isParameter(node)) &&
      node.initializer
    ) {
      violations.push(`initializer at ${sourceFile.getLineAndCharacterOfPosition(node.pos).line + 1}`);
    } else if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === "require") ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      violations.push(`runtime import at ${sourceFile.getLineAndCharacterOfPosition(node.pos).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return violations;
}

function hasExplicitEmptyExport(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some(
    (statement) =>
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.length === 0,
  );
}

function typeImportInventory(sourceFile: ts.SourceFile): string[] {
  const imports: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue;
    }
    const moduleName = statement.moduleSpecifier.text;
    const importClause = statement.importClause;
    if (!importClause) {
      imports.push(`${moduleName}:<side-effect>`);
      continue;
    }
    if (importClause.name) {
      imports.push(`${moduleName}:default as ${importClause.name.text}`);
    }
    const bindings = importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      imports.push(`${moduleName}:* as ${bindings.name.text}`);
    } else if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        const localSuffix = element.propertyName ? ` as ${element.name.text}` : "";
        imports.push(`${moduleName}:${importedName}${localSuffix}`);
      }
    }
  }
  return imports.sort();
}

function canonicalGlobalInterfaceViolations(
  sourceFile: ts.SourceFile,
  expectedInterfaceName: string,
): string[] {
  const globalAugmentations = sourceFile.statements.filter(
    (statement): statement is ts.ModuleDeclaration =>
      ts.isModuleDeclaration(statement) &&
      ts.isIdentifier(statement.name) &&
      statement.name.text === "global" &&
      (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0,
  );
  if (globalAugmentations.length !== 1) {
    return [`expected one declare global block, got ${globalAugmentations.length}`];
  }

  const body = globalAugmentations[0].body;
  if (!body || !ts.isModuleBlock(body)) {
    return ["declare global has no module block"];
  }
  if (
    body.statements.length !== 1 ||
    !ts.isInterfaceDeclaration(body.statements[0]) ||
    body.statements[0].name.text !== expectedInterfaceName
  ) {
    return [`declare global must contain only interface ${expectedInterfaceName}`];
  }
  const declaration = body.statements[0];
  if (
    declaration.typeParameters?.length ||
    declaration.heritageClauses?.length ||
    declaration.modifiers?.length
  ) {
    return [`interface ${expectedInterfaceName} must not add modifiers, generics, or heritage`];
  }
  return [];
}

function programRepositorySourceFiles(configName: string): ts.SourceFile[] {
  const config = parseConfig(configName);
  const program = ts.createProgram({
    rootNames: config.fileNames,
    options: { ...config.options, noEmit: true },
  });
  return program
    .getSourceFiles()
    .filter((sourceFile) => {
      const fileName = repositoryPath(sourceFile.fileName);
      return !fileName.startsWith("../") && !fileName.includes("node_modules/");
    })
    .map((sourceFile) =>
      ts.createSourceFile(
        sourceFile.fileName,
        sourceFile.text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      ),
    );
}

function programRepositoryFiles(configName: string): string[] {
  return programRepositorySourceFiles(configName)
    .map((sourceFile) => repositoryPath(sourceFile.fileName))
    .sort();
}

describe("Memory declaration ownership boundaries", () => {
  test("central Memory inventory owns four optional named root references", () => {
    const sourceFiles = programRepositorySourceFiles("tsconfig.build.json");
    const memoryInterfaces = locateInterfaces(sourceFiles, "Memory").filter((located) =>
      isGloballyVisibleInterface(located.declaration),
    );

    expect(memoryInterfaces).toHaveLength(1);
    expect(memoryInterfaces[0]?.fileName).toBe(GLOBAL_DECLARATION);
    expect(memoryInterfaces[0]?.declaration.members).toHaveLength(
      Object.keys(MEMORY_BRANCHES).length,
    );
    expect(memoryInterfaces[0]?.declaration.modifiers).toBeUndefined();
    expect(memoryInterfaces[0]?.declaration.typeParameters).toBeUndefined();
    expect(memoryInterfaces[0]?.declaration.heritageClauses).toBeUndefined();

    const rootMembers = new Map<MemoryRootName, ts.PropertySignature>();
    for (const member of memoryInterfaces[0]?.declaration.members ?? []) {
      if (!ts.isPropertySignature(member)) {
        continue;
      }
      const name = propertyName(member.name) as MemoryRootName | undefined;
      if (name && name in MEMORY_BRANCHES) {
        rootMembers.set(name, member);
      }
    }

    expect([...rootMembers.keys()].sort()).toEqual(Object.keys(MEMORY_BRANCHES).sort());
    for (const [rootName, branch] of Object.entries(MEMORY_BRANCHES) as Array<
      [MemoryRootName, (typeof MEMORY_BRANCHES)[MemoryRootName]]
    >) {
      const member = rootMembers.get(rootName);
      expect(member?.name && ts.isIdentifier(member.name)).toBe(true);
      expect(member?.modifiers).toBeUndefined();
      expect(member?.questionToken).toBeDefined();
      expect(member?.type && ts.isTypeReferenceNode(member.type)).toBe(true);
      expect(member?.type?.getText()).toBe(branch.interfaceName);
      expect(
        member?.type && ts.isTypeReferenceNode(member.type)
          ? member.type.typeArguments
          : undefined,
      ).toBeUndefined();
    }
  });

  test("branch declarations are external type-only modules with the frozen field inventories", () => {
    const violations: string[] = [];

    for (const [rootName, branch] of Object.entries(MEMORY_BRANCHES) as Array<
      [MemoryRootName, (typeof MEMORY_BRANCHES)[MemoryRootName]]
    >) {
      const absolutePath = resolve(REPO_ROOT, branch.declaration);
      if (!existsSync(absolutePath)) {
        violations.push(`${rootName}: missing ${branch.declaration}`);
        continue;
      }

      const sourceFile = parseDeclaration(absolutePath);
      if (!sourceFile.isDeclarationFile) {
        violations.push(`${rootName}: target is not a declaration file`);
      }
      if (!ts.isExternalModule(sourceFile)) {
        violations.push(`${rootName}: declaration is not an external module`);
      }
      if (!hasExplicitEmptyExport(sourceFile)) {
        violations.push(`${rootName}: declaration has no explicit export {}`);
      }
      for (const violation of declarationRuntimeViolations(sourceFile)) {
        violations.push(`${rootName}: ${violation}`);
      }
      for (const violation of canonicalGlobalInterfaceViolations(sourceFile, branch.interfaceName)) {
        violations.push(`${rootName}: ${violation}`);
      }
      const imports = typeImportInventory(sourceFile);
      const expectedImports = [...branch.imports].sort();
      if (JSON.stringify(imports) !== JSON.stringify(expectedImports)) {
        violations.push(
          `${rootName}: import inventory ${JSON.stringify(imports)} != ${JSON.stringify(expectedImports)}`,
        );
      }

      const matches = locateInterfaces([sourceFile], branch.interfaceName);
      if (matches.length !== 1 || matches[0]?.fileName !== branch.declaration) {
        violations.push(
          `${rootName}: expected one ${branch.interfaceName} in ${branch.declaration}, got ${matches
            .map((match) => match.fileName)
            .join(", ") || "none"}`,
        );
        continue;
      }
      if (!isInsideGlobalAugmentation(matches[0].declaration)) {
        violations.push(`${rootName}: ${branch.interfaceName} is not declared inside declare global`);
      }

      const fields = matches[0].declaration.members
        .filter(ts.isPropertySignature)
        .map((member) => propertyName(member.name))
        .filter((name): name is string => name !== undefined)
        .sort();
      const expectedFields = [...branch.fields].sort();
      if (JSON.stringify(fields) !== JSON.stringify(expectedFields)) {
        violations.push(
          `${rootName}: field inventory ${JSON.stringify(fields)} != ${JSON.stringify(expectedFields)}`,
        );
      }

      const printer = ts.createPrinter({
        removeComments: true,
        newLine: ts.NewLineKind.LineFeed,
      });
      const schemaText = matches[0].declaration.members
        .map((member) =>
          printer.printNode(
            ts.EmitHint.Unspecified,
            member,
            matches[0].declaration.getSourceFile(),
          ),
        )
        .join("\n");
      const schemaFingerprint = createHash("sha256").update(schemaText).digest("hex");
      if (schemaFingerprint !== branch.schemaFingerprint) {
        violations.push(
          `${rootName}: schema fingerprint ${schemaFingerprint} != ${branch.schemaFingerprint}`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  test("build and workspace Programs include the central and four branch declarations", () => {
    const expectedDeclarations = [
      GLOBAL_DECLARATION,
      ...Object.values(MEMORY_BRANCHES).map((branch) => branch.declaration),
    ];
    const missingByConfig: Record<string, string[]> = {};

    for (const configName of ["tsconfig.build.json", "tsconfig.json"]) {
      const files = new Set(programRepositoryFiles(configName));
      const missing = expectedDeclarations.filter((fileName) => !files.has(fileName));
      if (missing.length > 0) {
        missingByConfig[configName] = missing;
      }
    }

    expect(missingByConfig).toEqual({});
  });

  test("no production declaration repeats a Memory root binding", () => {
    const sourceFiles = programRepositorySourceFiles("tsconfig.build.json");
    const rootOwners = Object.fromEntries(
      Object.keys(MEMORY_BRANCHES).map((rootName) => [rootName, [] as string[]]),
    ) as Record<MemoryRootName, string[]>;

    for (const located of locateInterfaces(sourceFiles, "Memory").filter((candidate) =>
      isGloballyVisibleInterface(candidate.declaration),
    )) {
      for (const member of located.declaration.members) {
        if (!ts.isPropertySignature(member)) {
          continue;
        }
        const name = propertyName(member.name) as MemoryRootName | undefined;
        if (name && name in MEMORY_BRANCHES) {
          rootOwners[name].push(located.fileName);
        }
      }
    }

    expect(rootOwners).toEqual({
      cfg: [GLOBAL_DECLARATION],
      runtime: [GLOBAL_DECLARATION],
      data: [GLOBAL_DECLARATION],
      analytics: [GLOBAL_DECLARATION],
    });
  });

  test("named branch augmentations use optional properties with a single owner", () => {
    const sourceFiles = programRepositorySourceFiles("tsconfig.build.json");
    const violations: string[] = [];
    const branchNames = new Set<string>(
      Object.values(MEMORY_BRANCHES).map((branch) => branch.interfaceName),
    );

    for (const sourceFile of sourceFiles) {
      for (const statement of globalScopeStatements(sourceFile)) {
        for (const name of globalStatementNames(statement)) {
          if (branchNames.has(name) && !ts.isInterfaceDeclaration(statement)) {
            violations.push(
              `${name} in ${repositoryPath(sourceFile.fileName)} must be an interface declaration`,
            );
          }
        }
      }
    }

    for (const branch of Object.values(MEMORY_BRANCHES)) {
      const propertyOwners = new Map<string, string[]>();
      const declarations = locateInterfaces(sourceFiles, branch.interfaceName).filter((located) =>
        isGloballyVisibleInterface(located.declaration),
      );

      for (const located of declarations) {
        const declaration = located.declaration;
        if (
          declaration.modifiers?.length ||
          declaration.typeParameters?.length ||
          declaration.heritageClauses?.length
        ) {
          violations.push(
            `${branch.interfaceName} in ${located.fileName} adds modifiers, generics, or heritage`,
          );
        }
        for (const member of declaration.members) {
          if (!ts.isPropertySignature(member)) {
            violations.push(
              `${branch.interfaceName} in ${located.fileName} has non-property member ${ts.SyntaxKind[member.kind]}`,
            );
            continue;
          }
          const name = propertyName(member.name);
          if (!name) {
            violations.push(`${branch.interfaceName} in ${located.fileName} has computed property`);
            continue;
          }
          if (!member.questionToken) {
            violations.push(`${branch.interfaceName}.${name} in ${located.fileName} is required`);
          }
          const owners = propertyOwners.get(name) ?? [];
          owners.push(located.fileName);
          propertyOwners.set(name, owners);
        }
      }

      for (const [name, owners] of propertyOwners) {
        if (owners.length !== 1) {
          violations.push(`${branch.interfaceName}.${name} owners=${owners.join(",")}`);
        }
      }
      for (const field of branch.fields) {
        const owners = propertyOwners.get(field) ?? [];
        if (owners.length !== 1 || owners[0] !== branch.declaration) {
          violations.push(
            `${branch.interfaceName}.${field} canonical owner=${owners.join(",") || "none"}`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("named roots preserve NonNullable aliases, deep fields, and augmentation", () => {
    const config = parseConfig("tsconfig.build.json");
    const contractPath = resolve(REPO_ROOT, ".memory-declaration-contract.ts");
    const contractSource = `
export {};

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Expect<Value extends true> = Value;

declare global {
  interface ScreepsMemoryData {
    __memoryDeclarationBoundaryProbe?: "merged";
  }
}

type ConfigRoot = NonNullable<Memory["cfg"]>;
type RuntimeRoot = NonNullable<Memory["runtime"]>;
type DataRoot = NonNullable<Memory["data"]>;
type AnalyticsRoot = NonNullable<Memory["analytics"]>;

type ConfigAliasContract = Expect<Equal<ConfigRoot, ScreepsMemoryConfig>>;
type RuntimeAliasContract = Expect<Equal<RuntimeRoot, ScreepsMemoryRuntime>>;
type DataAliasContract = Expect<Equal<DataRoot, ScreepsMemoryData>>;
type AnalyticsAliasContract = Expect<Equal<AnalyticsRoot, ScreepsMemoryAnalytics>>;

declare const config: ConfigRoot;
declare const runtime: RuntimeRoot;
declare const data: DataRoot;
declare const analytics: AnalyticsRoot;

const configReceiverStorageThreshold: number | undefined =
  config.resourceControl?.capacityBalancing?.receiverStorageMinFreeCapacity;
const runtimeCapacityReservationRemaining: number | undefined =
  runtime.resourceControl?.rooms["E1N1"]?.capacityReservation?.remaining;
const dataBlockedReason:
  | "receiver_capacity"
  | "source_depleted"
  | "insufficient_terminal_resource_or_fee"
  | undefined = data.resourceControl?.tasks?.contract?.blockedReason;
const analyticsStoredEnergy: number | undefined =
  analytics.production?.rooms?.["E1N1"]?.latest?.storedEnergy;
const mergedExtension: "merged" | undefined = data.__memoryDeclarationBoundaryProbe;

const configToNamed: ScreepsMemoryConfig = config;
const runtimeToNamed: ScreepsMemoryRuntime = runtime;
const dataToNamed: ScreepsMemoryData = data;
const analyticsToNamed: ScreepsMemoryAnalytics = analytics;
const namedToConfig: ConfigRoot = configToNamed;
const namedToRuntime: RuntimeRoot = runtimeToNamed;
const namedToData: DataRoot = dataToNamed;
const namedToAnalytics: AnalyticsRoot = analyticsToNamed;
`;

    const compilerHost = ts.createCompilerHost(config.options, true);
    const originalFileExists = compilerHost.fileExists.bind(compilerHost);
    const originalReadFile = compilerHost.readFile.bind(compilerHost);
    const originalGetSourceFile = compilerHost.getSourceFile.bind(compilerHost);
    const isContractFile = (fileName: string): boolean => resolve(fileName) === contractPath;

    compilerHost.fileExists = (fileName) => isContractFile(fileName) || originalFileExists(fileName);
    compilerHost.readFile = (fileName) =>
      isContractFile(fileName) ? contractSource : originalReadFile(fileName);
    compilerHost.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
      isContractFile(fileName)
        ? ts.createSourceFile(fileName, contractSource, languageVersion, true, ts.ScriptKind.TS)
        : originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);

    const program = ts.createProgram({
      rootNames: [...config.fileNames, contractPath],
      options: { ...config.options, noEmit: true },
      host: compilerHost,
    });
    const contractFile = program.getSourceFile(contractPath);
    expect(contractFile).toBeDefined();

    const diagnostics = contractFile
      ? [
          ...program.getSyntacticDiagnostics(contractFile),
          ...program.getSemanticDiagnostics(contractFile),
        ]
      : [];
    expect(formatDiagnostics(diagnostics)).toBe("");
  });
});
