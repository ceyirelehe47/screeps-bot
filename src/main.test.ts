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

  /** Extract direct top-level cpuProfiler.measure(...) calls from gameLoop in order. */
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
    for (const statement of getGameLoopDeclaration().body!.statements) {
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

  function containsTryStatement(node: ts.Node): boolean {
    if (ts.isTryStatement(node)) {
      return true;
    }
    let found = false;
    node.forEachChild((child) => {
      found ||= containsTryStatement(child);
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
    expect(order).toHaveLength(37);
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

  it("keeps fail-fast propagation and flush on the complete success path", () => {
    const gameLoop = getGameLoopDeclaration();
    const statements = gameLoop.body!.statements;
    const lastStatement = statements[statements.length - 1];

    expect(containsTryStatement(gameLoop)).toBe(false);
    expect(countCalls(gameLoop, "cpuProfiler.flush")).toBe(1);
    expect(ts.isExpressionStatement(lastStatement)).toBe(true);
    if (!ts.isExpressionStatement(lastStatement)) {
      return;
    }
    expect(ts.isCallExpression(lastStatement.expression)).toBe(true);
    if (!ts.isCallExpression(lastStatement.expression)) {
      return;
    }
    const flushCallee = lastStatement.expression.expression;
    expect(ts.isPropertyAccessExpression(flushCallee)).toBe(true);
    if (!ts.isPropertyAccessExpression(flushCallee)) {
      return;
    }
    expect(flushCallee.expression.getText(mainAst)).toBe("cpuProfiler");
    expect(flushCallee.name.text).toBe("flush");
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
