/**
 * Terminal Transfer Engine Lab Run I——离线接线自测（任务书 §4.4/§7.1）。
 *
 * 验证对象是**实际构建的三产物**（run-i-main × observer × single-shot），
 * 不是源码直连：测试自行调用构建器生成三个 bundle，再在 VM 沙箱中按
 * Screeps 模块系统装配——observer/single-shot 各自装载（自包含 CJS），
 * main 沙箱注入 require stub 解析 "observer"/"single-shot" 两模块名（对
 * 计数包装转发真实产物 loop，计数不拦截真实调用）。
 *
 * 离线接线事实清单（§4.4）：模块加载零动作；窗口外零调用；窗口内非目标
 * tick 只采样；目标 tick 先 observer 后 single-shot 且恰一次；正常武装
 * 场景总 send=1；无武装场景总 send=0；窗口结束不再采样/发送；装载晚错过
 * 目标 tick 不补调。本测试只是接线验证，不构成真实引擎结果。
 *
 * Wiring Remediation I 追加故障矩阵（main 沙箱 require/调用边界注入）：
 * observer 装配失败（require 抛错/导出不合法/loop 向外抛错）阻断本次
 * single-shot 的解析与调用（零 send、控制槽零触碰）；single-shot 不可用
 * 不阻断观察（反方向对照）；同 T 重复调用目标 tick 不增发。
 *
 * 另锁一个构建器身份事实（Run I Execution §4.3 合法迁移后）：三产物
 * manifest 声明与实际文件 hash 一致；三模块内嵌同一份已固定编译配置；
 * Remediation II 归档产物保留旧配置下的历史身份（完整性核对不变），
 * 当前产物因配置回填不再与归档逐字节相等——叶子逻辑等价由验证命令组
 * 的源码 diff 证明（允许清单：labConfig/sendGate 修复与测试迁移）。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { LAB_EXAMPLE_EXPERIMENT } from "./labConfig";
import { LAB_CONTROL_MEMORY_KEY } from "./controlRecord";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const BUILDER = join(REPO_ROOT, "scripts", "build-treasury-terminal-lab.mjs");
const EVIDENCE_FINAL = join(
  REPO_ROOT,
  "openspec",
  "changes",
  "empire-treasury-core-rewrite",
  "evidence",
  "terminal-transfer-engine-lab-prep-i-remediation-ii",
  "final",
);
const ARCHIVED_OBSERVER = join(EVIDENCE_FINAL, "lab-observer", "observer.js");
const ARCHIVED_SINGLE_SHOT = join(EVIDENCE_FINAL, "lab-single-shot", "single-shot.js");
/** Remediation II 归档产物固定身份（构建器扩展不得改变两旧模式产物）。 */
const ARCHIVED_OBSERVER_IDENTITY = {
  bytes: 9160,
  sha256: "96721926941004522d0f77ce76e3648d57aec04bcaa5f07d58493903ce8f48a4",
};
const ARCHIVED_SINGLE_SHOT_IDENTITY = {
  bytes: 27697,
  sha256: "7730421dd7ef5d453387f03e5ad0eedec5b0b3c9d990bdeda805dd1213811391",
};

interface RunIArtifacts {
  readonly observerBundle: string;
  readonly singleShotBundle: string;
  readonly mainBundle: string;
  readonly mainManifest: Record<string, any>;
  readonly observerCode: string;
  readonly singleShotCode: string;
  readonly mainCode: string;
}

let artifacts: RunIArtifacts;

/** 接线测试自行构建三产物到独立临时目录（不运行游戏服务器、不上传）。 */
beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), "labrun1-wiring-"));
  const observerOut = join(base, "observer");
  const singleShotOut = join(base, "single-shot");
  const mainOut = join(base, "run-i-main");
  const runBuild = (args: string[]): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, [BUILDER, ...args], { encoding: "utf8" });
  const observerRun = runBuild(["--out", observerOut]);
  if (observerRun.status !== 0) {
    throw new Error(`observer 构建失败（exit ${String(observerRun.status)}）：${observerRun.stderr}`);
  }
  const singleShotRun = runBuild(["--mode", "single-shot", "--out", singleShotOut]);
  if (singleShotRun.status !== 0) {
    throw new Error(`single-shot 构建失败（exit ${String(singleShotRun.status)}）：${singleShotRun.stderr}`);
  }
  const mainRun = runBuild(["--mode", "run-i-main", "--out", mainOut]);
  if (mainRun.status !== 0) {
    throw new Error(`run-i-main 构建失败（exit ${String(mainRun.status)}）：${mainRun.stderr}`);
  }
  artifacts = {
    observerBundle: join(observerOut, "observer.js"),
    singleShotBundle: join(singleShotOut, "single-shot.js"),
    mainBundle: join(mainOut, "main.js"),
    mainManifest: JSON.parse(readFileSync(join(mainOut, "manifest.json"), "utf8")),
    observerCode: readFileSync(join(observerOut, "observer.js"), "utf8"),
    singleShotCode: readFileSync(join(singleShotOut, "single-shot.js"), "utf8"),
    mainCode: readFileSync(join(mainOut, "main.js"), "utf8"),
  };
});

// ── Screeps 模块系统装配 harness ────────────────────────────────────────────

interface RunIWorldOptions {
  /** 控制槽：armed=合法武装小记录；absent=无槽（无武装场景）。 */
  readonly slot: "armed" | "absent";
  /** send stub 同步返回码（默认 0=OK）。 */
  readonly sendResult?: number;
  /**
   * main 沙箱 require 边界的故障注入谓词（按模块名与当前 Game.time 决定）；
   * 返回 null（默认）转发真实产物计数包装。注入只发生在模块解析或 loop
   * 调用边界，不修改 Memory、不取消武装。
   */
  readonly moduleFault?: (module: "observer" | "single-shot", tick: number) => LabModuleFault | null;
}

/**
 * 模块装配故障模式：require-throw/missing-module=require 边界抛错；
 * empty-exports/bad-loop-export/null-exports=解析成功但导出不合法；
 * loop-throw=装配成功、loop 调用时先计数再向外抛错（"已尝试调用"）。
 */
type LabModuleFault =
  | "require-throw"
  | "missing-module"
  | "empty-exports"
  | "bad-loop-export"
  | "null-exports"
  | "loop-throw";

interface RunIWorld {
  readonly game: Record<string, unknown>;
  readonly memory: Record<string, unknown>;
  readonly logLines: string[];
  readonly sendCalls: unknown[][];
  observerCalls(): number;
  singleShotCalls(): number;
  /** main 沙箱内 require stub 被调用的模块名序列（装载零动作断言用）。 */
  requireCalls(): string[];
  setTick(tick: number): void;
  loop(): void;
  labRecords(): Record<string, any>[];
}

/**
 * 全新世界 + 全新三模块 VM 装配：observer/single-shot 各自在独立沙箱装载
 * （自包含产物），main 沙箱注入 Screeps 风格 require——返回对真实产物 loop
 * 的计数转发包装（计数不拦截调用）。
 */
function loadRunIWorld(options: RunIWorldOptions): RunIWorld {
  const config = LAB_EXAMPLE_EXPERIMENT;
  const sendCalls: unknown[][] = [];
  const makeStore = (resources: Record<string, number>, freeCapacity: number) => ({
    ...resources,
    getFreeCapacity: () => freeCapacity,
    getUsedCapacity: () => 0,
    getCapacity: () => freeCapacity,
  });
  const sourceTerminal = {
    id: config.sourceTerminalId,
    owner: { username: config.username },
    store: makeStore({ H: 1000, energy: 10_000 }, 50_000),
    cooldown: 0,
    send(resourceType: unknown, amount: unknown, destination: unknown, description: unknown): number {
      sendCalls.push([resourceType, amount, destination, description]);
      return options.sendResult ?? 0;
    },
  };
  const targetTerminal = {
    id: config.targetTerminalId,
    owner: { username: config.username },
    store: makeStore({ energy: 2000 }, 100_000),
    cooldown: 0,
  };
  const game: Record<string, unknown> = {
    time: config.targetTick,
    shard: { name: config.shardName, type: "normal", ptr: false },
    rooms: {
      [config.sourceRoomName]: { name: config.sourceRoomName, terminal: sourceTerminal },
      [config.targetRoomName]: { name: config.targetRoomName, terminal: targetTerminal },
    },
    market: { calcTransactionCost: () => LAB_EXAMPLE_EXPERIMENT.maxFeeEnergy, incomingTransactions: [], outgoingTransactions: [] },
  };
  const memory: Record<string, unknown> = {};
  const initialControl = { experimentId: config.experimentId, armed: true, attempted: false };
  if (options.slot === "armed") {
    memory[LAB_CONTROL_MEMORY_KEY] = { ...initialControl };
  }
  const logLines: string[] = [];
  const vmConsole = { log: (...args: unknown[]) => logLines.push(args.map(String).join(" ")) };

  const loadLeafModule = (code: string, filename: string): { loop?: () => void } => {
    const moduleExports: { loop?: () => void } = {};
    runInNewContext(
      code,
      {
        exports: moduleExports,
        module: { exports: moduleExports },
        console: vmConsole,
        Game: game,
        Memory: memory,
      },
      { filename },
    );
    return moduleExports;
  };
  const observerExports = loadLeafModule(artifacts.observerCode, "vm-run-i-observer.js");
  const singleShotExports = loadLeafModule(artifacts.singleShotCode, "vm-run-i-single-shot.js");
  if (typeof observerExports.loop !== "function") throw new Error("observer 产物未导出 loop");
  if (typeof singleShotExports.loop !== "function") throw new Error("single-shot 产物未导出 loop");

  let observerCalls = 0;
  let singleShotCalls = 0;
  const requireNames: string[] = [];
  const moduleFault = options.moduleFault ?? (() => null);
  const requireStub = (name: string): unknown => {
    requireNames.push(name);
    if (name !== "observer" && name !== "single-shot") {
      throw new Error(`require: unknown module '${name}'`);
    }
    const fault = moduleFault(name, game.time as number);
    if (fault === "require-throw") throw new Error(`测试注入：require('${name}') 抛错`);
    if (fault === "missing-module") throw new Error(`require: unknown module '${name}'`);
    if (fault === "empty-exports") return {};
    if (fault === "bad-loop-export") return { loop: 1 };
    if (fault === "null-exports") return null;
    if (fault === "loop-throw") {
      if (name === "observer") {
        return { loop: () => { observerCalls += 1; throw new Error("测试注入：observer.loop 向外抛错"); } };
      }
      return { loop: () => { singleShotCalls += 1; throw new Error("测试注入：single-shot.loop 向外抛错"); } };
    }
    if (name === "observer") {
      return { loop: () => { observerCalls += 1; observerExports.loop(); } };
    }
    return { loop: () => { singleShotCalls += 1; singleShotExports.loop(); } };
  };
  const mainExports: { loop?: () => void } = {};
  runInNewContext(
    artifacts.mainCode,
    {
      exports: mainExports,
      module: { exports: mainExports },
      console: vmConsole,
      Game: game,
      Memory: memory,
      require: requireStub,
    },
    { filename: "vm-run-i-main.js" },
  );
  if (typeof mainExports.loop !== "function") throw new Error("run-i-main 产物未导出 loop");

  return {
    game,
    memory,
    logLines,
    sendCalls,
    observerCalls: () => observerCalls,
    singleShotCalls: () => singleShotCalls,
    requireCalls: () => requireNames,
    setTick(tick: number) {
      game.time = tick;
    },
    loop() {
      mainExports.loop();
    },
    labRecords() {
      return logLines
        .filter((line) => line.startsWith("{") && line.includes('"kind":"lab-'))
        .map((line) => JSON.parse(line) as Record<string, any>);
    },
  };
}

/** 逐 tick 驱动 main loop（含首尾闭区间）。 */
function runTicks(world: RunIWorld, first: number, last: number): void {
  for (let tick = first; tick <= last; tick += 1) {
    world.setTick(tick);
    world.loop();
  }
}

// ── 用例 ─────────────────────────────────────────────────────────────────────

describe("Terminal Transfer Engine Lab Run I——离线接线自测（main × observer × single-shot）", () => {
  it("三产物构建与清单：三 manifest 身份自洽且与实际文件一致；三模块内嵌同一已固定配置；Remediation II 归档历史身份完整；main 静态面（require 两模块、无 send 调用面、无控制槽键）", () => {
    // 三产物清单身份（自洽式：manifest 声明与实际产物一致）。
    expect(artifacts.mainManifest.mode).toBe("run-i-main");
    expect(artifacts.mainManifest.entry).toBe("runIMain.ts");
    expect(artifacts.mainManifest.status).toBe("PREPARED_NOT_RUN");
    expect(artifacts.mainManifest.output.file).toBe("main.js");
    for (const bundlePath of [artifacts.mainBundle, artifacts.observerBundle, artifacts.singleShotBundle]) {
      const manifest = JSON.parse(readFileSync(join(bundlePath, "..", "manifest.json"), "utf8"));
      const body = readFileSync(join(bundlePath, "..", manifest.output.file));
      expect(body.length).toBe(manifest.output.bytes);
      expect(createHash("sha256").update(body).digest("hex")).toBe(manifest.output.sha256);
    }
    const mainBundle = readFileSync(artifacts.mainBundle);
    expect(mainBundle.length).toBe(artifacts.mainManifest.output.bytes);
    expect(createHash("sha256").update(mainBundle).digest("hex")).toBe(artifacts.mainManifest.output.sha256);

    // observer/single-shot 内嵌同一份已固定编译配置（Run I Execution 真实
    // 身份；main 是薄装配入口，只内嵌窗口 tick，不复制结构身份）。
    for (const code of [artifacts.observerCode, artifacts.singleShotCode]) {
      expect(code).toContain(`"${LAB_EXAMPLE_EXPERIMENT.experimentId}"`);
      expect(code).toContain(`"${LAB_EXAMPLE_EXPERIMENT.sourceTerminalId}"`);
      expect(code).toContain(`"${LAB_EXAMPLE_EXPERIMENT.targetTerminalId}"`);
      expect(code).toContain(`"${LAB_EXAMPLE_EXPERIMENT.shardName}"`);
    }
    expect(artifacts.mainCode).toContain(String(LAB_EXAMPLE_EXPERIMENT.targetTick));

    // Remediation II 归档保留旧配置历史身份（证据完整性；当前产物因配置
    // 回填合法不等——§4.3 迁移，逻辑等价由验证命令组源码 diff 证明）。
    const archivedObserver = readFileSync(ARCHIVED_OBSERVER);
    const archivedSingleShot = readFileSync(ARCHIVED_SINGLE_SHOT);
    expect(archivedObserver.length).toBe(ARCHIVED_OBSERVER_IDENTITY.bytes);
    expect(createHash("sha256").update(archivedObserver).digest("hex")).toBe(ARCHIVED_OBSERVER_IDENTITY.sha256);
    expect(archivedSingleShot.length).toBe(ARCHIVED_SINGLE_SHOT_IDENTITY.bytes);
    expect(createHash("sha256").update(archivedSingleShot).digest("hex")).toBe(ARCHIVED_SINGLE_SHOT_IDENTITY.sha256);
    expect(readFileSync(artifacts.observerBundle).equals(archivedObserver)).toBe(false);
    expect(readFileSync(artifacts.singleShotBundle).equals(archivedSingleShot)).toBe(false);
    expect(statSync(artifacts.mainBundle).isFile()).toBe(true);

    // main 静态面：经 Screeps 模块系统引用两产物；自身零发送面、零控制槽访问。
    expect(artifacts.mainCode).toMatch(/require\(/);
    expect(artifacts.mainCode).toContain('"observer"');
    expect(artifacts.mainCode).toContain('"single-shot"');
    expect(artifacts.mainCode).not.toMatch(/\.send\(/);
    expect(artifacts.mainCode).not.toContain(LAB_CONTROL_MEMORY_KEY);
  });

  it("三模块联合装载零动作：零 console 行、零 require、零 send、控制槽原样", () => {
    const world = loadRunIWorld({ slot: "armed" });
    expect(world.logLines).toEqual([]);
    expect(world.sendCalls).toEqual([]);
    expect(world.observerCalls()).toBe(0);
    expect(world.singleShotCalls()).toBe(0);
    expect(world.requireCalls()).toEqual([]);
    expect(Object.keys(world.memory)).toEqual([LAB_CONTROL_MEMORY_KEY]);
    expect(world.memory[LAB_CONTROL_MEMORY_KEY]).toEqual({
      experimentId: LAB_EXAMPLE_EXPERIMENT.experimentId,
      armed: true,
      attempted: false,
    });
  });

  it("窗口外零调用：T−3 与 T+21 不调 observer/single-shot、零日志零 send", () => {
    const config = LAB_EXAMPLE_EXPERIMENT;
    const world = loadRunIWorld({ slot: "armed" });
    world.setTick(config.targetTick - 3);
    world.loop();
    expect(world.observerCalls()).toBe(0);
    expect(world.singleShotCalls()).toBe(0);
    expect(world.logLines).toEqual([]);
    expect(world.sendCalls).toEqual([]);
    world.setTick(config.targetTick + 21);
    world.loop();
    expect(world.observerCalls()).toBe(0);
    expect(world.singleShotCalls()).toBe(0);
    expect(world.logLines).toEqual([]);
    expect(world.sendCalls).toEqual([]);
    expect(world.requireCalls()).toEqual([]);
  });

  it("窗口内非目标 tick 只采样：T−2/T−1/T+1/T+20 各调 observer 一次不调 single-shot；窗口行恰一次；T+21 窗口结束停止采样", () => {
    const config = LAB_EXAMPLE_EXPERIMENT;
    const world = loadRunIWorld({ slot: "armed" });
    const first = config.targetTick - 2;
    runTicks(world, first, config.targetTick - 1);
    world.setTick(config.targetTick + 1);
    world.loop();
    world.setTick(config.targetTick + 20);
    world.loop();
    expect(world.observerCalls()).toBe(4);
    expect(world.singleShotCalls()).toBe(0);
    expect(world.sendCalls).toEqual([]);

    const records = world.labRecords();
    const windowLines = records.filter((record) => record.kind === "lab-run-i-window");
    expect(windowLines).toHaveLength(1);
    expect(windowLines[0]).toMatchObject({
      experimentId: config.experimentId,
      mode: "run-i-main",
      tick: first,
      windowFirstTick: first,
      targetTick: config.targetTick,
      windowLastTick: config.targetTick + 20,
      observerModule: "observer",
      singleShotModule: "single-shot",
    });
    expect(records.filter((record) => record.kind === "lab-sample")).toHaveLength(4);
    expect(records.some((record) => record.kind === "lab-send-attempt")).toBe(false);

    // 窗口结束（T+21）：不再采样、不再输出。
    world.setTick(config.targetTick + 21);
    world.loop();
    expect(world.observerCalls()).toBe(4);
    expect(world.labRecords().filter((record) => record.kind === "lab-sample")).toHaveLength(4);
  });

  it("目标 tick 恰一次：先 observer 后 single-shot、完整窗口 send=1、控制槽终态 attempted/stopped 成立且 ≤4096 UTF-8 字节", () => {
    const config = LAB_EXAMPLE_EXPERIMENT;
    const world = loadRunIWorld({ slot: "armed" });
    runTicks(world, config.targetTick - 2, config.targetTick + 20);
    expect(world.observerCalls()).toBe(23);
    expect(world.singleShotCalls()).toBe(1);
    expect(world.sendCalls).toHaveLength(1);
    expect(world.sendCalls[0]).toEqual([
      config.resourceType,
      config.amount,
      config.targetRoomName,
      config.description,
    ]);

    // 目标 tick 内顺序：先 observer 样本（前态），后 single-shot 发送边界。
    const records = world.labRecords();
    const sampleAtTarget = records.findIndex(
      (record) => record.kind === "lab-sample" && record.tick === config.targetTick,
    );
    const preCall = records.findIndex(
      (record) => record.kind === "lab-send-attempt" && record.phase === "pre-call",
    );
    expect(sampleAtTarget).toBeGreaterThanOrEqual(0);
    expect(preCall).toBeGreaterThan(sampleAtTarget);
    const phases = records
      .filter((record) => record.kind === "lab-send-attempt")
      .map((record) => record.phase);
    expect(phases).toEqual(["pre-call", "boundary", "sync-return"]);

    // 控制槽终态：attempted 保留 + 结果/stopped 写回成功；字节约束仍成立。
    const slot = world.memory[LAB_CONTROL_MEMORY_KEY] as Record<string, any>;
    expect(slot.attempted).toBe(true);
    expect(slot.attemptedTick).toBe(config.targetTick);
    expect(slot.stopped).toBe(true);
    expect(slot.syncResult).toMatchObject({ ok: true, code: 0 });
    expect(Buffer.byteLength(JSON.stringify(slot), "utf8")).toBeLessThanOrEqual(4096);
    expect(world.labRecords().filter((record) => record.kind === "lab-run-i-window")).toHaveLength(1);
  });

  it("无武装场景：目标 tick 仍调 single-shot 但门禁拒绝，零 send 零控制槽写", () => {
    const config = LAB_EXAMPLE_EXPERIMENT;
    const world = loadRunIWorld({ slot: "absent" });
    runTicks(world, config.targetTick - 2, config.targetTick + 20);
    expect(world.observerCalls()).toBe(23);
    expect(world.singleShotCalls()).toBe(1);
    expect(world.sendCalls).toEqual([]);
    const records = world.labRecords();
    expect(records.some((record) => record.kind === "lab-precondition-rejection")).toBe(true);
    expect(records.some((record) => record.kind === "lab-send-attempt")).toBe(false);
    expect(LAB_CONTROL_MEMORY_KEY in world.memory).toBe(false);
  });

  it("装载晚错过目标 tick：窗口内仍采样但不补调 single-shot、零 send、控制槽不被触碰", () => {
    const config = LAB_EXAMPLE_EXPERIMENT;
    const world = loadRunIWorld({ slot: "armed" });
    runTicks(world, config.targetTick + 3, config.targetTick + 20);
    expect(world.observerCalls()).toBe(18);
    expect(world.singleShotCalls()).toBe(0);
    expect(world.sendCalls).toEqual([]);
    const records = world.labRecords();
    expect(records.some((record) => record.kind === "lab-send-attempt")).toBe(false);
    const windowLines = records.filter((record) => record.kind === "lab-run-i-window");
    expect(windowLines).toHaveLength(1);
    expect(windowLines[0].tick).toBe(config.targetTick + 3);
    expect(world.memory[LAB_CONTROL_MEMORY_KEY]).toEqual({
      experimentId: config.experimentId,
      armed: true,
      attempted: false,
    });
  });

  // ── Wiring Remediation I：发送依赖观察装配的故障矩阵（T02）────────────────

  it("observer require 抛错（目标 T、合法武装）：single-shot 零解析零调用零 send、控制槽内容与引用不变；T 重复调用与 T+1 均无发送；T+1 恢复真实 observer 继续观察不补发", () => {
    const config = LAB_EXAMPLE_EXPERIMENT;
    // 同样世界的正常模块对照：除故障谓词外一切相同，send=1 证明零发送的唯一
    // 原因是 observer 装配故障，而非未武装/错 tick 等其他门禁拒绝。
    const healthyWorld = loadRunIWorld({ slot: "armed" });
    healthyWorld.setTick(config.targetTick);
    healthyWorld.loop();
    expect(healthyWorld.sendCalls).toHaveLength(1);

    const world = loadRunIWorld({
      slot: "armed",
      moduleFault: (module, tick) =>
        module === "observer" && tick === config.targetTick ? "require-throw" : null,
    });
    const slotRef = world.memory[LAB_CONTROL_MEMORY_KEY];
    const initialSlot = { experimentId: config.experimentId, armed: true, attempted: false };

    world.setTick(config.targetTick - 1);
    world.loop();
    world.setTick(config.targetTick);
    world.loop();
    world.loop(); // 目标 tick 重复调用：仍不得解析/调用 single-shot
    runTicks(world, config.targetTick + 1, config.targetTick + 3);

    expect(world.sendCalls).toEqual([]);
    expect(world.singleShotCalls()).toBe(0);
    expect(world.requireCalls()).not.toContain("single-shot");
    // T 两次装配失败 + T−1/T+1..T+3 四次真实采样。
    expect(world.observerCalls()).toBe(4);
    const records = world.labRecords();
    const moduleErrors = records.filter((record) => record.kind === "lab-run-i-module-error");
    expect(moduleErrors).toHaveLength(2);
    for (const error of moduleErrors) {
      expect(error).toMatchObject({ module: "observer", stage: "require" });
    }
    expect(records.some((record) => record.kind === "lab-send-attempt")).toBe(false);
    // T+1 恢复真实 observer：窗口内继续只读采样，不补发。
    expect(records.filter((record) => record.kind === "lab-sample")).toHaveLength(4);
    expect(world.memory[LAB_CONTROL_MEMORY_KEY]).toBe(slotRef);
    expect(world.memory[LAB_CONTROL_MEMORY_KEY]).toEqual(initialSlot);
  });

  it("observer 导出不合法（{} 缺 loop 与 {loop:1} 非函数，null 同组补充）：模块错误指向 loop-export；single-shot 零解析零 send、槽不变；两固定变体 T 重复+T+1 恢复观察不补发", () => {
    const config = LAB_EXAMPLE_EXPERIMENT;
    const initialSlot = { experimentId: config.experimentId, armed: true, attempted: false };
    const runExportFault = (fault: LabModuleFault) => {
      const world = loadRunIWorld({
        slot: "armed",
        moduleFault: (module, tick) =>
          module === "observer" && tick === config.targetTick ? fault : null,
      });
      const slotRef = world.memory[LAB_CONTROL_MEMORY_KEY];
      world.setTick(config.targetTick - 1);
      world.loop();
      world.setTick(config.targetTick);
      world.loop();
      world.loop(); // 目标 tick 重复调用
      runTicks(world, config.targetTick + 1, config.targetTick + 2);
      return { world, slotRef };
    };

    for (const fault of ["empty-exports", "bad-loop-export"] as const) {
      const { world, slotRef } = runExportFault(fault);
      expect(world.sendCalls).toEqual([]);
      expect(world.singleShotCalls()).toBe(0);
      expect(world.requireCalls()).not.toContain("single-shot");
      const records = world.labRecords();
      const moduleErrors = records.filter((record) => record.kind === "lab-run-i-module-error");
      expect(moduleErrors).toHaveLength(2);
      for (const error of moduleErrors) {
        expect(error).toMatchObject({ module: "observer", stage: "loop-export" });
      }
      expect(records.some((record) => record.kind === "lab-send-attempt")).toBe(false);
      expect(world.observerCalls()).toBe(3); // T−1、T+1、T+2（T 两次装配失败零调用）
      expect(records.filter((record) => record.kind === "lab-sample")).toHaveLength(3);
      expect(world.memory[LAB_CONTROL_MEMORY_KEY]).toBe(slotRef);
      expect(world.memory[LAB_CONTROL_MEMORY_KEY]).toEqual(initialSlot);
    }

    // null 导出同组补充：目标 tick 单点断言（同一 loop-export 拒绝路径）。
    const world = loadRunIWorld({
      slot: "armed",
      moduleFault: (module, tick) =>
        module === "observer" && tick === config.targetTick ? "null-exports" : null,
    });
    world.setTick(config.targetTick);
    world.loop();
    expect(world.sendCalls).toEqual([]);
    expect(world.singleShotCalls()).toBe(0);
    expect(world.requireCalls()).not.toContain("single-shot");
    expect(world.labRecords().filter((record) => record.kind === "lab-run-i-module-error")).toHaveLength(1);
    expect(world.memory[LAB_CONTROL_MEMORY_KEY]).toEqual(initialSlot);
  });

  it("observer.loop 向外抛错（目标 T、合法武装）：已尝试调用 observer；沿既有 dispatch 错误出口结束、single-shot 零解析零 send；注入不修改 Memory 不取消武装；T+1 恢复观察", () => {
    const config = LAB_EXAMPLE_EXPERIMENT;
    const world = loadRunIWorld({
      slot: "armed",
      moduleFault: (module, tick) =>
        module === "observer" && tick === config.targetTick ? "loop-throw" : null,
    });
    const slotRef = world.memory[LAB_CONTROL_MEMORY_KEY];
    const initialSlot = { experimentId: config.experimentId, armed: true, attempted: false };

    world.setTick(config.targetTick - 1);
    world.loop();
    world.setTick(config.targetTick);
    world.loop();
    world.loop(); // 目标 tick 重复调用：两次都沿既有异常出口结束
    world.setTick(config.targetTick + 1);
    world.loop();

    expect(world.sendCalls).toEqual([]);
    expect(world.singleShotCalls()).toBe(0);
    expect(world.requireCalls()).not.toContain("single-shot");
    // observer 已被尝试调用：T 两次（向外抛错）+ T−1/T+1 两次真实采样。
    expect(world.observerCalls()).toBe(4);
    const records = world.labRecords();
    const mainErrors = records.filter(
      (record) => record.kind === "lab-run-i-main-error" && record.stage === "dispatch",
    );
    expect(mainErrors).toHaveLength(2);
    expect(records.some((record) => record.kind === "lab-send-attempt")).toBe(false);
    expect(records.filter((record) => record.kind === "lab-sample")).toHaveLength(2);
    expect(world.memory[LAB_CONTROL_MEMORY_KEY]).toBe(slotRef);
    expect(world.memory[LAB_CONTROL_MEMORY_KEY]).toEqual(initialSlot);
  });

  // ── Wiring Remediation I：反方向对照与重复调用（T03）──────────────────────

  it("single-shot 缺失或导出不合法（反方向）：真实 observer 在 T 及后续窗口继续采样；send=0、槽不变", () => {
    const config = LAB_EXAMPLE_EXPERIMENT;
    const initialSlot = { experimentId: config.experimentId, armed: true, attempted: false };
    for (const fault of ["missing-module", "empty-exports"] as const) {
      const world = loadRunIWorld({
        slot: "armed",
        moduleFault: (module) => (module === "single-shot" ? fault : null),
      });
      runTicks(world, config.targetTick - 2, config.targetTick + 20);
      expect(world.observerCalls()).toBe(23);
      expect(world.singleShotCalls()).toBe(0);
      expect(world.sendCalls).toEqual([]);
      const records = world.labRecords();
      expect(records.filter((record) => record.kind === "lab-sample")).toHaveLength(23);
      expect(world.requireCalls().filter((name) => name === "single-shot")).toHaveLength(1);
      const moduleErrors = records.filter(
        (record) => record.kind === "lab-run-i-module-error" && record.module === "single-shot",
      );
      expect(moduleErrors).toHaveLength(1);
      expect(moduleErrors[0].stage).toBe(fault === "missing-module" ? "require" : "loop-export");
      expect(world.memory[LAB_CONTROL_MEMORY_KEY]).toEqual(initialSlot);
    }
  });

  it("同 T 重复调用目标 tick 不增发（正常三模块独立场景）：send 恰 1、发送边界一组、控制保护与 4096 字节约束保持", () => {
    const config = LAB_EXAMPLE_EXPERIMENT;
    const world = loadRunIWorld({ slot: "armed" });
    runTicks(world, config.targetTick - 2, config.targetTick - 1);
    world.setTick(config.targetTick);
    world.loop();
    world.loop(); // 同 tick 第二次调用：single-shot 自身门禁拒绝重发
    runTicks(world, config.targetTick + 1, config.targetTick + 20);

    expect(world.sendCalls).toHaveLength(1);
    expect(world.sendCalls[0]).toEqual([
      config.resourceType,
      config.amount,
      config.targetRoomName,
      config.description,
    ]);
    expect(world.singleShotCalls()).toBe(2); // 两次都被 main 调用，第二次零发送
    expect(world.observerCalls()).toBe(24); // 23 tick 各一次 + 目标 tick 第二次调用
    const sendAttempts = world.labRecords().filter((record) => record.kind === "lab-send-attempt");
    expect(sendAttempts.map((record) => record.phase)).toEqual(["pre-call", "boundary", "sync-return"]);
    const slot = world.memory[LAB_CONTROL_MEMORY_KEY] as Record<string, any>;
    expect(slot.attempted).toBe(true);
    expect(slot.attemptedTick).toBe(config.targetTick);
    expect(slot.stopped).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(slot), "utf8")).toBeLessThanOrEqual(4096);
  });
});
