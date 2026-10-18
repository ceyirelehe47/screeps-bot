import { RUNTIME_PROCESSES } from "@/runtime/processTable";
import { createProcessScheduler, resetProcessSchedulerForTest } from "@/runtime/processScheduler";
import { resetRuntimeServices } from "@mock/movement";
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
    ["coreDefense", "runCoreDefense"],
    ["defenseMode", "runDefenseMode"],
    ["homeDefense", "runHomeDefense"],
    ["towerControl", "runTowerControl"],
    ["marketSafetyLatch", "enforceLegacyMarketSafetyLatch"],
    ["marketSalePreflight", "runMarketSalePreflight"],
    ["homeDefenseSupply", "runHomeDefenseSupply"],
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
    ["depositHarvest", "runDepositHarvest"],
    ["powerCreepControl", "runPowerCreepControl"],
    ["powerSpawnControl", "runPowerSpawnControl"],
    ["roomPlannerConstruction", "runRoomPlannerConstruction"],
    ["linkControl", "runLinkControl"],
    ["refreshWorkerTasks", "refreshWorkerTasks"],
    ["bootstrapRooms", "bootstrapRooms"],
    ["remoteMining", "runRemoteMining"],
    ["scheduleSpawnTasks", "scheduleSpawnTasks"],
    ["spawnWork", "<inline>"],
    ["creepWork", "<inline>"],
    ["trafficResolution", "<inline>"],
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

  function extractMeasureCalls(): Array<{ phase: string; callback: string; callbackNode: ts.Expression }> {
    const statement = getProductionPhaseBlock().statements.find(node =>
      ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(mainAst) === "scheduler.runAll");
    if (!statement || !ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) throw new Error("process table execution missing");
    const work = statement.expression.arguments[0];
    if (!ts.isObjectLiteralExpression(work)) throw new Error("process work map missing");
    const entries = work.properties.filter(ts.isPropertyAssignment).map(property => ({
      phase: property.name.getText(mainAst), callback: ts.isIdentifier(property.initializer) ? property.initializer.text : "<inline>", callbackNode: property.initializer,
    }));
    return RUNTIME_PROCESSES.map(spec => {
      const entry = entries.find(candidate => candidate.phase === spec.id);
      if (!entry) throw new Error(`missing phase callback: ${spec.id}`);
      return entry;
    });
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
    const callback = extractMeasureCalls().find((entry) => entry.phase === phase)?.callbackNode;
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
    const entityGuard = entityCallback.body.statements[0];
    expect(ts.isTryStatement(entityGuard) && entityGuard.catchClause !== undefined).toBe(true);
    if (!ts.isTryStatement(entityGuard)) return;
    expect(entityGuard.catchClause!.getText(mainAst)).toContain("reportRuntimeError");
    const wrapperStatement = entityGuard.tryBlock.statements[0];
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
    expect(order).toHaveLength(42);
  });

  it("keeps one-time registrations outside and before gameLoop", () => {
    const gameLoopIndex = mainAst.statements.indexOf(getGameLoopDeclaration());
    const registrations = [
      "registerGlobalApi",
      "mountAll",
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

  it("isolates phase failures and flushes even if Treasury cleanup throws", () => {
    const gameLoop = getGameLoopDeclaration();
    const lifecycleGuard = gameLoop.body!.statements.find(ts.isTryStatement);
    expect(lifecycleGuard?.finallyBlock).toBeDefined();
    expect(containsCatchClause(gameLoop)).toBe(true);
    expect(countCalls(gameLoop, "cpuProfiler.flush")).toBe(1);
    expect(lifecycleGuard!.finallyBlock!.getText(mainAst)).toContain(
      'runPhase("treasuryEndTick", endTreasuryProductionTick)',
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
      'pixelGenerator: runPixelGenerator',
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

describe("主循环异常隔离", () => {
  beforeEach(() => {
    resetRuntimeServices(); resetProcessSchedulerForTest();
    Game.cpu = { ...Game.cpu, bucket: 10000, limit: 120, tickLimit: 500, getUsed: jest.fn(() => 0) };
    Memory.runtime = {};
  });
  // 运行实际 main.ts 编排；隔离游戏模块副作用，用依赖替身注入异常。
  function loadLoop(options: { failPhase?: string; begin?: boolean; flushThrows?: boolean } = {}) {
    resetProcessSchedulerForTest();
    createProcessScheduler(() => undefined, () => undefined).finish();
    Game.time += 3;
    const phases: string[] = [];
    const reportRuntimeError = jest.fn();
    const creepWorks = [jest.fn(() => { throw new Error("creep 失败"); }), jest.fn()];
    const spawnWorks = [jest.fn(() => { throw "spawn 失败"; }), jest.fn()];
    const flush = jest.fn(() => {
      if (options.flushThrows) throw new Error("flush 失败");
    });
    const profiler = {
      measure: (phase: string, work: () => unknown) => {
        phases.push(phase);
        if (phase === options.failPhase) throw new Error(`${phase} 失败`);
        return work();
      },
      measureCreep: (_creep: Creep, work: () => void) => work(),
      measureRoomPhase: (_phase: string, _room: string, work: () => void) => work(),
      flush,
    };
    const treasuryEnd = jest.fn();
    const memoryBegin = jest.fn();
    const memoryFinish = jest.fn();
    const dependencies: Record<string, unknown> = {
      errorMapper: (next: () => void) => next,
      reportRuntimeError,
      isPermitChainStorageUnavailableError: () => false,
      beginMemoryStorageTick: memoryBegin,
      finishMemoryStorageTick: memoryFinish,
      createTickCpuProfiler: () => profiler,
      createProcessScheduler,
      getTickContextService: () => ({
        getAllSpawns: () => spawnWorks.map((work, index) => ({ name: `spawn${index}`, room: { name: "E1N1" }, work })),
        getAllCreeps: () => creepWorks.map((work, index) => ({ name: `creep${index}`, work })),
      }),
      beginTreasuryProductionTick: () => options.begin ?? true,
      endTreasuryProductionTick: treasuryEnd,
    };
    const exports: { loop?: () => void } = {};
    const source = readFileSync(resolve(__dirname, "main.ts"), "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
    }).outputText;
    const { runInNewContext } = require("node:vm") as typeof import("node:vm");
    runInNewContext(compiled, {
      exports,
      require: () => new Proxy({}, { get: (_target, name: string) => dependencies[name] ?? (() => undefined) }),
    });
    return { loop: exports.loop!, phases, reportRuntimeError, creepWorks, spawnWorks, treasuryEnd, flush, memoryBegin, memoryFinish };
  }

  it("每个 phase 抛错后仍执行后续 phase 和收尾", () => {
    const baseline = loadLoop();
    baseline.loop();
    for (const failPhase of baseline.phases) {
      const runtime = loadLoop({ failPhase });
      expect(() => runtime.loop()).not.toThrow();
      // begin 异常时没有成功开启 Treasury 生命周期，因此不调用 end。
      const dependent = failPhase === "marketSalePreflight" ? ["homeDefenseSupply", "resourceControl", "marketSaleAutomation"] : [];
      expect(runtime.phases).toEqual(baseline.phases.filter(phase => !dependent.includes(phase) &&
        !(failPhase === "treasuryBeginTick" && phase === "treasuryEndTick")));
      expect(runtime.flush).toHaveBeenCalledTimes(1);
      expect(runtime.memoryBegin).toHaveBeenCalledTimes(1);
      expect(runtime.memoryFinish).toHaveBeenCalledTimes(1);
      expect(runtime.reportRuntimeError).toHaveBeenCalledWith(`phase:${failPhase}`, expect.anything());
      if (failPhase !== "spawnWork") expect(runtime.spawnWorks[1]).toHaveBeenCalledTimes(1);
      if (failPhase !== "creepWork") expect(runtime.creepWorks[1]).toHaveBeenCalledTimes(1);
    }
  });

  it("单只 creep 和单个 spawn 异常不阻断其它实体，并记录身份", () => {
    const runtime = loadLoop();
    runtime.loop();
    expect(runtime.spawnWorks[1]).toHaveBeenCalledTimes(1);
    expect(runtime.creepWorks[1]).toHaveBeenCalledTimes(1);
    expect(runtime.reportRuntimeError).toHaveBeenCalledWith("spawn:spawn0", "spawn 失败");
    expect(runtime.reportRuntimeError).toHaveBeenCalledWith("creep:creep0", expect.anything());
    expect(runtime.treasuryEnd).toHaveBeenCalledTimes(1);
    expect(runtime.flush).toHaveBeenCalledTimes(1);
  });

  it("未开启 Treasury 时不结束生命周期，flush 自身异常也可报告", () => {
    const runtime = loadLoop({ begin: false, flushThrows: true });
    expect(() => runtime.loop()).not.toThrow();
    expect(runtime.treasuryEnd).not.toHaveBeenCalled();
    expect(runtime.reportRuntimeError).toHaveBeenCalledWith("cpuProfiler.flush", expect.anything());
    expect(runtime.memoryFinish).toHaveBeenCalledTimes(1);
  });
});
