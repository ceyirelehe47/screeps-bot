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
 * 另锁一个构建器事实：--mode run-i-main 加入后，observer/single-shot 两
 * 产物必须与 Remediation II 归档产物逐字节一致（构建器扩展零影响）。
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
}

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
    market: { calcTransactionCost: () => 26, incomingTransactions: [], outgoingTransactions: [] },
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
  const requireStub = (name: string): { loop(): void } => {
    requireNames.push(name);
    if (name === "observer") {
      return { loop: () => { observerCalls += 1; observerExports.loop(); } };
    }
    if (name === "single-shot") {
      return { loop: () => { singleShotCalls += 1; singleShotExports.loop(); } };
    }
    throw new Error(`require: unknown module '${name}'`);
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
  it("三产物构建与清单：run-i-main manifest 身份自洽；observer/single-shot 与 Remediation II 归档逐字节一致；main 静态面（require 两模块、无 send 调用面、无控制槽键）", () => {
    // run-i-main 清单身份（自洽式：manifest 声明与实际产物一致）。
    expect(artifacts.mainManifest.mode).toBe("run-i-main");
    expect(artifacts.mainManifest.entry).toBe("runIMain.ts");
    expect(artifacts.mainManifest.status).toBe("PREPARED_NOT_RUN");
    expect(artifacts.mainManifest.output.file).toBe("main.js");
    const mainBundle = readFileSync(artifacts.mainBundle);
    expect(mainBundle.length).toBe(artifacts.mainManifest.output.bytes);
    expect(createHash("sha256").update(mainBundle).digest("hex")).toBe(artifacts.mainManifest.output.sha256);

    // 构建器加入第三模式后，旧两模式产物必须与 Remediation II 归档逐字节一致。
    const rebuiltObserver = readFileSync(artifacts.observerBundle);
    const rebuiltSingleShot = readFileSync(artifacts.singleShotBundle);
    const archivedObserver = readFileSync(ARCHIVED_OBSERVER);
    const archivedSingleShot = readFileSync(ARCHIVED_SINGLE_SHOT);
    expect(archivedObserver.length).toBe(ARCHIVED_OBSERVER_IDENTITY.bytes);
    expect(createHash("sha256").update(archivedObserver).digest("hex")).toBe(ARCHIVED_OBSERVER_IDENTITY.sha256);
    expect(archivedSingleShot.length).toBe(ARCHIVED_SINGLE_SHOT_IDENTITY.bytes);
    expect(createHash("sha256").update(archivedSingleShot).digest("hex")).toBe(ARCHIVED_SINGLE_SHOT_IDENTITY.sha256);
    expect(rebuiltObserver.equals(archivedObserver)).toBe(true);
    expect(rebuiltSingleShot.equals(archivedSingleShot)).toBe(true);
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
});
