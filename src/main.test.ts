import { readFileSync } from "fs";
import { resolve } from "path";
import * as ts from "typescript";

describe("main loop phase ordering", () => {
  const mainSrc = readFileSync(resolve(__dirname, "main.ts"), "utf-8");
  const mainAst = ts.createSourceFile(
    "main.ts",
    mainSrc,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const canonicalTickPhases = [
    ["announceDeploy", "announceDeploy"],
    ["marketSalePreflight", "runMarketSalePreflight"],
    ["pixelGenerator", "runPixelGenerator"],
    ["productionMonitor", "runProductionMonitor"],
    ["nukerControl", "runNukerControl"],
    ["hubPlanner", "runHubPlanner"],
    ["hubUpgradeControl", "runHubUpgradeControl"],
    ["synthesisControl", "runSynthesisControl"],
    ["factoryControl", "runFactoryControl"],
    ["mineralExtraction", "runMineralExtraction"],
    ["resourceControl", "runResourceControl"],
    ["marketSaleAutomation", "runLiveMarketSaleAutomation"],
    ["hubProgressAnalytics", "runHubProgressAnalytics"],
    ["hubProgressOverlay", "renderHubProgressOverlays"],
    ["externalTelemetryExport", "runExternalTelemetryExport"],
    ["memoryCleanup", "runMemoryCleanup"],
    ["portalDiscovery", "runPortalDiscovery"],
    ["flagControl", "runFlagControl"],
    ["crossShardSignals", "runCrossShardSignals"],
    ["interShardControl", "runInterShardControl"],
    ["warControl", "runWarControl"],
    ["powerBankObserver", "runPowerBankObserver"],
    ["powerBankHarvest", "runPowerBankHarvest"],
    ["powerCreepControl", "runPowerCreepControl"],
    ["powerSpawnControl", "runPowerSpawnControl"],
    ["roomPlannerConstruction", "runRoomPlannerConstruction"],
    ["linkControl", "runLinkControl"],
    ["coreDefense", "runCoreDefense"],
    ["defenseMode", "runDefenseMode"],
    ["homeDefense", "runHomeDefense"],
    ["towerControl", "runTowerControl"],
    ["refreshWorkerTasks", "refreshWorkerTasks"],
    ["bootstrapRooms", "bootstrapRooms"],
    ["remoteMining", "runRemoteMining"],
    ["scheduleSpawnTasks", "scheduleSpawnTasks"],
    ["spawnWork", "<inline>"],
    ["creepWork", "<inline>"],
    ["empireInventoryShadow", "runEmpireInventoryShadowCheck"],
  ] as const;

  function getGameLoopDeclaration(): ts.FunctionDeclaration {
    const declaration = mainAst.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "gameLoop",
    );
    if (!declaration?.body) {
      throw new Error("gameLoop declaration not found");
    }
    return declaration;
  }

  function getProductionPhaseBlock(): ts.Block {
    const guarded = getGameLoopDeclaration().body!.statements.find(ts.isTryStatement);
    if (!guarded?.finallyBlock) throw new Error("Treasury lifecycle guard not found");
    return guarded.tryBlock;
  }

  /** Extract the canonical production phases inside the lifecycle guard in order. */
  function extractMeasureCalls(): Array<{
    phase: string;
    callback: string;
    call: ts.CallExpression;
  }> {
    const calls: Array<{
      phase: string;
      callback: string;
      call: ts.CallExpression;
    }> = [];
    for (const statement of getProductionPhaseBlock().statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
        continue;
      }
      const callee = statement.expression.expression;
      if (
        !ts.isPropertyAccessExpression(callee) ||
        !ts.isIdentifier(callee.expression) ||
        callee.expression.text !== "cpuProfiler" ||
        callee.name.text !== "measure"
      ) {
        continue;
      }
      const phaseArgument = statement.expression.arguments[0];
      const callbackArgument = statement.expression.arguments[1];
      calls.push({
        phase:
          phaseArgument && ts.isStringLiteralLike(phaseArgument)
            ? phaseArgument.text
            : "<non-literal-phase>",
        callback: ts.isIdentifier(callbackArgument)
          ? callbackArgument.text
          : ts.isArrowFunction(callbackArgument)
            ? "<inline>"
            : "<unsupported-callback>",
        call: statement.expression,
      });
    }
    return calls;
  }

  function containsCatchClause(node: ts.Node): boolean {
    if (ts.isCatchClause(node)) {
      return true;
    }
    let found = false;
    node.forEachChild((child) => {
      found ||= containsCatchClause(child);
    });
    return found;
  }

  function countCalls(node: ts.Node, calleeText: string): number {
    let count = 0;
    if (ts.isCallExpression(node) && node.expression.getText(mainAst) === calleeText) {
      count += 1;
    }
    node.forEachChild((child) => {
      count += countCalls(child, calleeText);
    });
    return count;
  }

  function getInlinePhaseCallback(phase: "spawnWork" | "creepWork"): ts.ArrowFunction {
    const phaseCall = extractMeasureCalls().find((entry) => entry.phase === phase)?.call;
    const callback = phaseCall?.arguments[1];
    if (!callback || !ts.isArrowFunction(callback)) {
      throw new Error(`${phase} inline callback not found`);
    }
    return callback;
  }

  function expectWrappedForEach(options: {
    phase: "spawnWork" | "creepWork";
    collectionExpression: string;
    entity: "spawn" | "creep";
    wrapper: "measureRoomPhase" | "measureCreep";
    wrapperPrefixArguments: string[];
  }): void {
    const callback = getInlinePhaseCallback(options.phase);
    expect(ts.isBlock(callback.body)).toBe(true);
    if (!ts.isBlock(callback.body)) {
      return;
    }
    expect(callback.body.statements).toHaveLength(1);
    const forEachStatement = callback.body.statements[0];
    expect(ts.isExpressionStatement(forEachStatement)).toBe(true);
    if (!ts.isExpressionStatement(forEachStatement)) {
      return;
    }
    expect(ts.isCallExpression(forEachStatement.expression)).toBe(true);
    if (!ts.isCallExpression(forEachStatement.expression)) {
      return;
    }
    const forEachCall = forEachStatement.expression;
    // creepWork/spawnWork 遍历 TickContext 的本 tick 快照（getAllCreeps/
    // getAllSpawns），而不是各自再扫一遍 Object.values(Game.*)。
    expect(forEachCall.expression.getText(mainAst)).toBe(options.collectionExpression);
    expect(forEachCall.arguments).toHaveLength(1);
    const entityCallback = forEachCall.arguments[0];
    expect(ts.isArrowFunction(entityCallback)).toBe(true);
    if (!ts.isArrowFunction(entityCallback)) {
      return;
    }
    expect(entityCallback.parameters.map((parameter) => parameter.name.getText(mainAst))).toEqual([
      options.entity,
    ]);
    expect(ts.isBlock(entityCallback.body)).toBe(true);
    if (!ts.isBlock(entityCallback.body)) {
      return;
    }
    expect(entityCallback.body.statements).toHaveLength(1);
    const wrapperStatement = entityCallback.body.statements[0];
    expect(ts.isExpressionStatement(wrapperStatement)).toBe(true);
    if (!ts.isExpressionStatement(wrapperStatement)) {
      return;
    }
    expect(ts.isCallExpression(wrapperStatement.expression)).toBe(true);
    if (!ts.isCallExpression(wrapperStatement.expression)) {
      return;
    }
    const wrapperCall = wrapperStatement.expression;
    expect(wrapperCall.expression.getText(mainAst)).toBe(`cpuProfiler.${options.wrapper}`);
    const workCallback = wrapperCall.arguments[wrapperCall.arguments.length - 1];
    expect(
      wrapperCall.arguments
        .slice(0, -1)
        .map((argument) => argument.getText(mainAst)),
    ).toEqual(options.wrapperPrefixArguments);
    expect(ts.isArrowFunction(workCallback)).toBe(true);
    if (!ts.isArrowFunction(workCallback)) {
      return;
    }
    expect(workCallback.body.getText(mainAst)).toBe(`${options.entity}.work()`);
  }

  it("keeps the complete canonical phase order", () => {
    const calls = extractMeasureCalls();
    const phaseContract = calls.map(({ phase, callback }) => [phase, callback]);
    const order = calls.map(({ phase }) => phase);

    expect(phaseContract).toEqual(canonicalTickPhases);
    expect(new Set(order).size).toBe(order.length);
    expect(order).toHaveLength(38);
  });

  it("keeps one-time registrations outside and before gameLoop", () => {
    const gameLoopIndex = mainAst.statements.indexOf(getGameLoopDeclaration());
    const registrations = [
      "mountAll",
      "registerGlobalApi",
      "registerConsoleCommands",
      "registerProductionApi",
    ];
    const topLevelCalls = mainAst.statements.flatMap((statement, index) => {
      if (
        !ts.isExpressionStatement(statement) ||
        !ts.isCallExpression(statement.expression) ||
        !ts.isIdentifier(statement.expression.expression)
      ) {
        return [];
      }
      return [{ name: statement.expression.expression.text, index }];
    });
    const registrationCalls = topLevelCalls.filter(({ name }) =>
      registrations.includes(name),
    );

    expect(registrationCalls.map(({ name }) => name)).toEqual(registrations);
    expect(registrationCalls.every(({ index }) => index < gameLoopIndex)).toBe(true);
  });

  it("keeps fail-fast propagation and flush even if Treasury cleanup throws", () => {
    const gameLoop = getGameLoopDeclaration();
    const lifecycleGuard = gameLoop.body!.statements.find(ts.isTryStatement);
    expect(lifecycleGuard?.finallyBlock).toBeDefined();
    expect(containsCatchClause(gameLoop)).toBe(false);
    expect(countCalls(gameLoop, "cpuProfiler.flush")).toBe(1);
    expect(lifecycleGuard!.finallyBlock!.getText(mainAst)).toContain(
      'cpuProfiler.measure("treasuryEndTick", endTreasuryProductionTick)',
    );
    const cleanupGuard = lifecycleGuard!.finallyBlock!.statements.find(ts.isTryStatement);
    expect(cleanupGuard?.finallyBlock).toBeDefined();
    expect(countCalls(cleanupGuard!.finallyBlock!, "cpuProfiler.flush")).toBe(1);
    expect(mainSrc).toContain("export const loop = errorMapper(gameLoop);");
  });

  it("keeps the Pixel phase while the module owns the permanent disabled latch", () => {
    const pixelSrc = readFileSync(
      resolve(__dirname, "runtime/pixelGenerator.ts"),
      "utf-8",
    );
    expect(mainSrc).toContain(
      'cpuProfiler.measure("pixelGenerator", runPixelGenerator)',
    );
    expect(pixelSrc).toContain(
      "PIXEL_GENERATOR_PERMANENTLY_DISABLED = true",
    );
    expect(pixelSrc).not.toContain("Game.cpu.generatePixel(");
  });

  it("spawnWork wraps each spawn.work() with measureRoomPhase", () => {
    expectWrappedForEach({
      phase: "spawnWork",
      collectionExpression: "tickContext.getAllSpawns().forEach",
      entity: "spawn",
      wrapper: "measureRoomPhase",
      wrapperPrefixArguments: ['"spawnWork"', "spawn.room.name"],
    });
  });

  it("creepWork wraps each creep.work() with measureCreep", () => {
    expectWrappedForEach({
      phase: "creepWork",
      collectionExpression: "tickContext.getAllCreeps().forEach",
      entity: "creep",
      wrapper: "measureCreep",
      wrapperPrefixArguments: ["creep"],
    });
  });
});
