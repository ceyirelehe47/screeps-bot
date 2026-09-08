/**
 * Terminal Transfer Engine Lab Prep I——探针离线自测（任务书 §4.4；P03/P04），
 * Lab Prep I · Remediation I 扩展（Q01–Q03：发送前标记确认与失败路径矩阵）。
 *
 * 在本地 stub/spy 注入的 Game/Memory/Terminal API 上执行**同一源码构建出的
 * 两个真实入口产物**（beforeAll 实际调用构建器到独立临时目录，再 require
 * 产物——不是只检查源码字符串）。这里的"send 调用 1 次"只指 spy 调用，
 * 不是真实游戏经济动作；stub 的 send 返回 OK 时不修改库存、不给交易视图
 * 填记录，后续显式切换"后续 tick 观察 fixture"验证观察器报告输入差异。
 *
 * Remediation I 新增：Q01 在固定旧产物（上轮归档 single-shot.js，VM 假端口）
 * 上复现 7 场景基线矩阵（三失败场景同 tick 双发 1/2/2）；同矩阵跑新产物
 * 断言 0/0/0 与零 boundary/sync 输出；Q02/Q03 覆盖写后读回异常/旧值/篡改、
 * send 入口内标记可见性、结果更新失败不回退 attempted、写入函数对超限与
 * 循环引用候选的明确拒绝、未知字段读取拒绝。
 *
 * 该测试只证明包装与采样正确，不证明引擎真的这样运行（真实引擎边界
 * PREPARED_NOT_RUN，见实验交接说明）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { LAB_EXAMPLE_EXPERIMENT } from "./labConfig";
import {
  LAB_CONTROL_MEMORY_KEY,
  readControlRecord,
  writeControlRecord,
  type LabControlRecord,
} from "./controlRecord";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const BUILDER = join(REPO_ROOT, "scripts", "build-treasury-terminal-lab.mjs");

interface LabArtifacts {
  readonly observerBundle: string;
  readonly singleShotBundle: string;
  readonly observerManifest: Record<string, any>;
  readonly singleShotManifest: Record<string, any>;
  readonly observerExample: Record<string, any>;
  readonly observerOut: string;
  readonly singleShotOut: string;
}

let artifacts: LabArtifacts;

/** 探针测试自行构建到独立临时目录并加载真实产物（不运行游戏服务器）。 */
beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), "labprep1-probe-"));
  const observerOut = join(base, "observer");
  const singleShotOut = join(base, "single-shot");
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
  artifacts = {
    observerBundle: join(observerOut, "observer.js"),
    singleShotBundle: join(singleShotOut, "single-shot.js"),
    observerManifest: JSON.parse(readFileSync(join(observerOut, "manifest.json"), "utf8")),
    singleShotManifest: JSON.parse(readFileSync(join(singleShotOut, "manifest.json"), "utf8")),
    observerExample: JSON.parse(readFileSync(join(observerOut, "example.experiment.json"), "utf8")),
    observerOut,
    singleShotOut,
  };
});

/** 每个用例重新执行产物模块（fresh 模块状态；全局 stub 在 it 内安装）。 */
beforeEach(() => {
  jest.resetModules();
});

// ── 世界 stub（轻量自制——不复用国库 mock，探针与国库测试环境隔离） ────────

interface LabWorldOptions {
  tick?: number;
  shardName?: string;
  username?: string;
  sourceTerminalId?: string;
  targetTerminalId?: string;
  fee?: number | { throws: Error };
  sendResult?: number | { throws: Error };
  incoming?: Record<string, unknown>[];
  outgoing?: Record<string, unknown>[];
  incomingThrows?: boolean;
  outgoingThrows?: boolean;
  dropTargetRoom?: boolean;
  sourceResources?: Record<string, number>;
  targetResources?: Record<string, number>;
  sourceFreeCapacity?: number;
  targetFreeCapacity?: number;
  sourceCooldown?: number;
  /** 控制槽故障模式（Remediation I：标记写入/读回故障注入；默认普通属性）。 */
  controlSlot?:
    | { readonly mode: "setter-throw" }
    | { readonly mode: "silent-drop" }
    | { readonly mode: "read-fail-after"; readonly reads: number }
    | {
        readonly mode: "tamper";
        readonly tamper: (record: Record<string, unknown>) => Record<string, unknown>;
      }
    | { readonly mode: "fail-writes-after"; readonly writes: number };
  /** 控制槽初始记录（controlSlot 模式下的 stored 初值）。 */
  initialControl?: unknown;
  /** send spy 入口回调（在记录调用后、返回前触发——Q02 入口内观察 Memory）。 */
  onSend?: () => void;
}

interface LabWorld {
  readonly options: LabWorldOptions;
  readonly game: Record<string, unknown>;
  readonly memory: Record<string, unknown>;
  readonly sourceTerminal: Record<string, unknown>;
  readonly sendCalls: { self: unknown; args: unknown[] }[];
  restore(): void;
}

/** 安装假 Game/Memory 世界（it 内调用；restore 还原全局，供同 it 内切换）。 */
function installLabWorld(options: LabWorldOptions = {}): LabWorld {
  const config = LAB_EXAMPLE_EXPERIMENT;
  const sendCalls: { self: unknown; args: unknown[] }[] = [];
  const makeStore = (resources: Record<string, number>, freeCapacity: number) => ({
    ...resources,
    getFreeCapacity: () => freeCapacity,
    getUsedCapacity: () => Object.values(resources).reduce((sum, value) => sum + value, 0),
    getCapacity: () => Object.values(resources).reduce((sum, value) => sum + value, 0) + freeCapacity,
  });
  const sourceTerminal = {
    id: options.sourceTerminalId ?? config.sourceTerminalId,
    owner: { username: options.username ?? config.username },
    store: makeStore(options.sourceResources ?? { H: 1000, energy: 10_000 }, options.sourceFreeCapacity ?? 50_000),
    cooldown: options.sourceCooldown ?? 0,
    // stub 的 send：只记录调用与 this 绑定；返回 OK 时**不**改库存/视图。
    // onSend 在记录后、返回前触发——Q02"send 入口内读取 Memory"的观察点。
    send(resourceType: unknown, amount: unknown, destination: unknown, description: unknown): number {
      sendCalls.push({ self: this, args: [resourceType, amount, destination, description] });
      if (options.onSend !== undefined) {
        options.onSend();
      }
      const result: number | { throws: Error } = options.sendResult ?? 0;
      if (typeof result === "object") {
        throw result.throws;
      }
      return result;
    },
  };
  const targetTerminal = {
    id: options.targetTerminalId ?? config.targetTerminalId,
    owner: { username: options.username ?? config.username },
    store: makeStore(options.targetResources ?? { energy: 2000 }, options.targetFreeCapacity ?? 100_000),
    cooldown: 0,
  };
  const rooms: Record<string, unknown> = {
    [config.sourceRoomName]: { name: config.sourceRoomName, terminal: sourceTerminal },
  };
  if (!options.dropTargetRoom) {
    rooms[config.targetRoomName] = { name: config.targetRoomName, terminal: targetTerminal };
  }
  // 市场端口读 options（引用保持）——测试可在安装后改写 options 模拟后续 tick fixture。
  // 交易视图按官方形状为**数组属性**（getter 求值：读异常仍可被探针 catch）。
  const game = {
    time: options.tick ?? config.targetTick,
    shard: { name: options.shardName ?? config.shardName, type: "normal", ptr: false },
    rooms,
    market: {
      calcTransactionCost: (): number => {
        const fee: number | { throws: Error } = options.fee ?? 26;
        if (typeof fee === "object") {
          throw fee.throws;
        }
        return fee;
      },
      get incomingTransactions(): Record<string, unknown>[] {
        if (options.incomingThrows) throw new Error("incoming 视图读取异常（stub fixture）");
        return options.incoming ?? [];
      },
      get outgoingTransactions(): Record<string, unknown>[] {
        if (options.outgoingThrows) throw new Error("outgoing 视图读取异常（stub fixture）");
        return options.outgoing ?? [];
      },
    },
  };
  const memory: Record<string, unknown> = {};
  // 控制槽故障注入（Remediation I）：getter/setter 计数与篡改——enumerable
  // 保持 true 以便 JSON 序列化往返（模拟世界侧 Memory reload）保留控制事实。
  if (options.controlSlot !== undefined) {
    const slot = options.controlSlot;
    let stored: unknown = options.initialControl ?? armedControl();
    let readCount = 0;
    let writeCount = 0;
    Object.defineProperty(memory, LAB_CONTROL_MEMORY_KEY, {
      configurable: true,
      enumerable: true,
      get() {
        readCount += 1;
        if (slot.mode === "read-fail-after" && readCount > slot.reads) {
          throw new Error("控制槽 getter 读回异常（stub fixture）");
        }
        return stored;
      },
      set(value) {
        writeCount += 1;
        if (slot.mode === "setter-throw") {
          throw new Error("控制槽 setter 故障（stub fixture）");
        }
        if (slot.mode === "silent-drop") return; // 静默丢写：stored 不更新
        if (slot.mode === "fail-writes-after" && writeCount > slot.writes) {
          throw new Error(`控制槽 setter 第 ${String(writeCount)} 次写入起故障（stub fixture）`);
        }
        stored = slot.mode === "tamper" ? slot.tamper(value as Record<string, unknown>) : value;
      },
    });
  } else if (options.initialControl !== undefined) {
    memory[LAB_CONTROL_MEMORY_KEY] = options.initialControl;
  }
  const globalScope = global as unknown as Record<string, unknown>;
  const previousGame = globalScope.Game;
  const previousMemory = globalScope.Memory;
  globalScope.Game = game;
  globalScope.Memory = memory;
  return {
    options,
    game,
    memory,
    sourceTerminal,
    sendCalls,
    restore() {
      globalScope.Game = previousGame;
      globalScope.Memory = previousMemory;
    },
  };
}

/** 捕获 console.log（探针的采样输出即外部日志面）。 */
function captureConsoleLog(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(" "));
  };
  return {
    lines,
    restore() {
      console.log = original;
    },
  };
}

/** 从捕获的输出行解析探针结构化记录（kind 以 lab- 开头）。 */
function parseLabRecords(lines: readonly string[]): Record<string, any>[] {
  return lines
    .filter((line) => line.startsWith("{") && line.includes('"kind":"lab-'))
    .map((line) => JSON.parse(line));
}

/** 武装控制记录（合法场景用；lab 合成身份）。 */
function armedControl(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { experimentId: LAB_EXAMPLE_EXPERIMENT.experimentId, armed: true, attempted: false, ...overrides };
}

function requireArtifact(bundlePath: string): { loop: () => void } {
  return require(bundlePath) as { loop: () => void };
}

// ── Q01 基线复现与新产物对照（VM 假端口，任务书 §3.2 七场景矩阵） ──────────

/** 上一轮归档的旧 single-shot 产物（固定身份——基线反例的唯一来源）。 */
const LEGACY_SINGLE_SHOT_BUNDLE = join(
  REPO_ROOT,
  "openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-engine-lab-prep-i/final/lab-single-shot/single-shot.js",
);
const LEGACY_SINGLE_SHOT_BYTES = 17520;
const LEGACY_SINGLE_SHOT_SHA256 = "9d8bfc54d542b9b5e8e37113b87e0f06e29149b7fa3cac1b9a7b8dfc7794ed4f";

/** 初始 JSON 长度恰为 4090 字符的记录（合法必要字段 + 程序补齐的 ASCII note）。 */
function buildOversizedControl(): Record<string, unknown> {
  const bare = JSON.stringify(armedControl()).length;
  const record = { ...armedControl(), note: "x".repeat(4090 - bare - 10) };
  if (JSON.stringify(record).length !== 4090) {
    throw new Error("note 补齐偏差——不应依赖手工数字符");
  }
  return record;
}

type VmSlotMode = "unarmed" | "normal" | "setter-throw" | "silent-drop" | "oversized";
type VmSendBehavior = "ok" | "non-ok" | "throw";

interface VmScenarioRow {
  readonly label: string;
  readonly slotMode: VmSlotMode;
  readonly sendBehavior: VmSendBehavior;
}

interface VmRunOutcome {
  readonly sendAfterLoop1: number;
  readonly sendAfterLoop2: number;
  readonly sendAfterNextTick: number;
  readonly slotFinalAttempted: unknown;
  readonly slotFinalStopped: unknown;
  readonly markUnconfirmed: string[];
  readonly rejections: string[];
  readonly sendAttemptPhases: string[];
  readonly writeRefusedLines: number;
}

/** 七场景固定矩阵（旧产物复现与新产物修复对照共用同一 harness）。 */
const VM_SCENARIOS: readonly VmScenarioRow[] = [
  { label: "S1 未武装/Memory 正常", slotMode: "unarmed", sendBehavior: "ok" },
  { label: "S2 正常武装/小记录/写入正常", slotMode: "normal", sendBehavior: "ok" },
  { label: "S3 send 非 OK/写入正常", slotMode: "normal", sendBehavior: "non-ok" },
  { label: "S4 send 抛错/写入正常", slotMode: "normal", sendBehavior: "throw" },
  { label: "S5 控制槽 setter 抛错", slotMode: "setter-throw", sendBehavior: "ok" },
  { label: "S6 控制槽 setter 静默丢写", slotMode: "silent-drop", sendBehavior: "ok" },
  { label: "S7 初始 4090 字符/更新后超限", slotMode: "oversized", sendBehavior: "ok" },
];

/**
 * 单场景 VM 执行：全新沙箱（新模块环境）装载产物代码，目标 tick 调两次
 * loop() 再推进一个 tick 调用——三时点累计 send spy 数即矩阵轨迹。
 * send spy 只记调用，不修改库存、冷却或交易记录。
 */
function runVmScenario(bundleCode: string, scenario: VmScenarioRow): VmRunOutcome {
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
      if (scenario.sendBehavior === "throw") throw new Error("send stub 同步异常（VM fixture）");
      return scenario.sendBehavior === "non-ok" ? -6 : 0;
    },
  };
  const targetTerminal = {
    id: config.targetTerminalId,
    owner: { username: config.username },
    store: makeStore({ energy: 2000 }, 100_000),
    cooldown: 0,
  };
  const game = {
    time: config.targetTick,
    shard: { name: config.shardName, type: "normal", ptr: false },
    rooms: {
      [config.sourceRoomName]: { name: config.sourceRoomName, terminal: sourceTerminal },
      [config.targetRoomName]: { name: config.targetRoomName, terminal: targetTerminal },
    },
    market: { calcTransactionCost: () => 26, incomingTransactions: [], outgoingTransactions: [] },
  };
  const memory: Record<string, unknown> = {};
  let stored: Record<string, unknown> | undefined;
  if (scenario.slotMode === "setter-throw" || scenario.slotMode === "silent-drop") {
    stored = armedControl();
    Object.defineProperty(memory, LAB_CONTROL_MEMORY_KEY, {
      configurable: true,
      enumerable: true,
      get() {
        return stored;
      },
      set(value) {
        if (scenario.slotMode === "setter-throw") throw new Error("控制槽 setter 故障（VM fixture）");
      },
    });
  } else if (scenario.slotMode === "oversized") {
    memory[LAB_CONTROL_MEMORY_KEY] = buildOversizedControl();
  } else if (scenario.slotMode === "unarmed") {
    memory[LAB_CONTROL_MEMORY_KEY] = { ...armedControl(), armed: false };
  } else {
    memory[LAB_CONTROL_MEMORY_KEY] = armedControl();
  }
  const logLines: string[] = [];
  const moduleExports: { loop?: () => void } = {};
  runInNewContext(
    bundleCode,
    {
      exports: moduleExports,
      module: { exports: moduleExports },
      console: { log: (...args: unknown[]) => logLines.push(args.map(String).join(" ")) },
      Game: game,
      Memory: memory,
    },
    { filename: "vm-single-shot-bundle.js" },
  );
  if (typeof moduleExports.loop !== "function") throw new Error("产物未导出 loop");
  moduleExports.loop();
  const sendAfterLoop1 = sendCalls.length;
  moduleExports.loop();
  const sendAfterLoop2 = sendCalls.length;
  (game as { time: number }).time = config.targetTick + 1;
  moduleExports.loop();
  const sendAfterNextTick = sendCalls.length;
  const labRecords = logLines
    .filter((line) => line.startsWith("{") && line.includes('"kind":"lab-'))
    .map((line) => JSON.parse(line) as Record<string, any>);
  const slotFinal = memory[LAB_CONTROL_MEMORY_KEY] as Record<string, unknown> | undefined;
  return {
    sendAfterLoop1,
    sendAfterLoop2,
    sendAfterNextTick,
    slotFinalAttempted: slotFinal?.attempted,
    slotFinalStopped: slotFinal?.stopped,
    markUnconfirmed: labRecords
      .filter((record) => record.kind === "lab-mark-unconfirmed")
      .map((record) => `${record.stage}/${record.reason}`),
    rejections: labRecords
      .filter((record) => record.kind === "lab-precondition-rejection")
      .map((record) => record.reason),
    sendAttemptPhases: labRecords
      .filter((record) => record.kind === "lab-send-attempt")
      .map((record) => record.phase),
    writeRefusedLines: labRecords.filter((record) => record.kind === "lab-control-write-refused").length,
  };
}

// ── 用例 ─────────────────────────────────────────────────────────────────────

describe("Terminal Transfer Engine Lab Prep I——探针离线自测（P03/P04）", () => {
  it("构建产物与清单：两入口真实生成、manifest PREPARED_NOT_RUN、bundle 哈希一致、observer 产物无 send 调用面", () => {
    expect(existsSync(artifacts.observerBundle)).toBe(true);
    expect(existsSync(artifacts.singleShotBundle)).toBe(true);
    const observerCode = readFileSync(artifacts.observerBundle, "utf8");
    const singleShotCode = readFileSync(artifacts.singleShotBundle, "utf8");
    // 行为隔离的静态面（辅助断言——主验证仍是下面的行为用例）：observer 产物
    // 不含可达发送分支；single-shot 产物恰包含受门禁保护的调用。
    expect(observerCode).not.toMatch(/\.send\s*\(/);
    expect(singleShotCode).toMatch(/\.send\s*\(/);
    const sha256 = (fileName: string): string => createHash("sha256").update(readFileSync(fileName)).digest("hex");
    for (const manifest of [artifacts.observerManifest, artifacts.singleShotManifest]) {
      expect(manifest.schema).toBe("treasury-terminal-lab-manifest/v1");
      expect(manifest.status).toBe("PREPARED_NOT_RUN");
      expect(manifest.referenceShas).toEqual({
        engine: "80977824199a596d174d392fd0cf8c458c21fcbd",
        driver: "cf63d8adf902663e2ebddd7f8c5b7baa425dc928",
      });
      expect(typeof manifest.repoSourceCommit).toBe("string");
      expect(manifest.repoSourceCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(manifest.lockfileSha256).toBe(sha256(join(REPO_ROOT, "package-lock.json")));
    }
    expect(artifacts.observerManifest.mode).toBe("observer");
    expect(artifacts.observerManifest.entry).toBe("observer.ts");
    expect(artifacts.observerManifest.output.file).toBe("observer.js");
    expect(artifacts.observerManifest.output.sha256).toBe(sha256(artifacts.observerBundle));
    expect(artifacts.observerManifest.output.bytes).toBe(statSync(artifacts.observerBundle).size);
    expect(artifacts.singleShotManifest.mode).toBe("single-shot");
    expect(artifacts.singleShotManifest.entry).toBe("singleShot.ts");
    expect(artifacts.singleShotManifest.output.file).toBe("single-shot.js");
    expect(artifacts.singleShotManifest.output.sha256).toBe(sha256(artifacts.singleShotBundle));
    expect(artifacts.singleShotManifest.output.bytes).toBe(statSync(artifacts.singleShotBundle).size);
    // 合成示例配置随产物分发且与源码常量一致（不含 _doc 说明键）。
    expect(artifacts.observerExample).toMatchObject({ ...LAB_EXAMPLE_EXPERIMENT });
  });

  it("模块加载无副作用：产物 require 不触 Game、不写 Memory、不发送、不武装", () => {
    const globalScope = global as unknown as Record<string, unknown>;
    const savedGame = globalScope.Game;
    const savedMemory = globalScope.Memory;
    delete globalScope.Game;
    const sentinelMemory: Record<string, unknown> = {};
    globalScope.Memory = sentinelMemory;
    let observerModule: unknown;
    let singleShotModule: unknown;
    try {
      expect(() => {
        observerModule = requireArtifact(artifacts.observerBundle);
        singleShotModule = requireArtifact(artifacts.singleShotBundle);
      }).not.toThrow();
    } finally {
      globalScope.Game = savedGame;
      globalScope.Memory = savedMemory;
    }
    expect(typeof (observerModule as { loop?: unknown }).loop).toBe("function");
    expect(typeof (singleShotModule as { loop?: unknown }).loop).toBe("function");
    expect(Object.keys(sentinelMemory)).toEqual([]);
  });

  it("observer 多 tick 零发送/零 Memory 写：采样行含两端原始读数、报价与两视图计数", () => {
    const world = installLabWorld({ tick: 100 });
    const capture = captureConsoleLog();
    try {
      const observer = requireArtifact(artifacts.observerBundle);
      for (let tick = 100; tick < 103; tick += 1) {
        (world.game as { time: number }).time = tick;
        observer.loop();
      }
    } finally {
      capture.restore();
      world.restore();
    }
    expect(world.sendCalls).toEqual([]); // observer 无发送分支
    expect(JSON.stringify(world.memory)).toBe("{}"); // 不写游戏 Memory
    const records = parseLabRecords(capture.lines);
    expect(records).toHaveLength(3);
    for (const [index, sample] of records.entries()) {
      expect(sample.kind).toBe("lab-sample");
      expect(sample.experimentId).toBe(LAB_EXAMPLE_EXPERIMENT.experimentId);
      expect(sample.mode).toBe("observer");
      expect(sample.tick).toBe(100 + index);
      expect(sample.configTargetTick).toBe(LAB_EXAMPLE_EXPERIMENT.targetTick);
      expect(sample.source.readStatus).toBe("ok");
      expect(sample.source.terminalId).toBe(LAB_EXAMPLE_EXPERIMENT.sourceTerminalId);
      expect(sample.source.ownerUsername).toBe(LAB_EXAMPLE_EXPERIMENT.username);
      expect(sample.source.resourceAmount).toBe(1000);
      expect(sample.source.energy).toBe(10_000);
      expect(sample.source.freeCapacity).toBe(50_000);
      expect(sample.source.cooldown).toBe(0);
      expect(sample.target.readStatus).toBe("ok");
      expect(sample.target.resourceAmount).toBe(0);
      expect(sample.target.freeCapacity).toBe(100_000);
      expect(sample.feeQuote.status).toBe("ok");
      expect(sample.feeQuote.energyCost).toBe(26); // 读自 stub 端口（非硬编码进产物）
      expect(sample.transactions.incoming.status).toBe("ok");
      expect(sample.transactions.incoming.count).toBe(0);
      expect(sample.transactions.outgoing.status).toBe("ok");
      expect(sample.transactions.outgoing.count).toBe(0);
    }
  });

  it("observer 读取异常显式报告：报价/视图 throw、缺房间不填 0 冒充成功；不自带完成结论", () => {
    const world = installLabWorld({
      dropTargetRoom: true,
      fee: { throws: new Error("calcTransactionCost stub 异常") },
      outgoingThrows: true,
    });
    const capture = captureConsoleLog();
    try {
      requireArtifact(artifacts.observerBundle).loop();
    } finally {
      capture.restore();
      world.restore();
    }
    const records = parseLabRecords(capture.lines);
    expect(records).toHaveLength(1);
    const sample = records[0];
    expect(sample.kind).toBe("lab-sample");
    expect(sample.feeQuote.status).toBe("unavailable");
    expect(sample.feeQuote.error).toContain("calcTransactionCost stub 异常");
    expect(sample.transactions.outgoing.status).toBe("read_error");
    expect(sample.transactions.outgoing.error).toContain("outgoing 视图读取异常");
    expect(sample.transactions.outgoing.count).toBeUndefined(); // 读失败不填 0 条
    expect(sample.target.readStatus).toBe("room_missing");
    expect(sample.target.resourceAmount).toBeUndefined(); // 缺房间不填 0
    expect(sample.target.terminalId).toBeUndefined();
    // 采样不自带对账结论（不复制国库 matcher）。
    expect(JSON.stringify(sample)).not.toContain("observed_committed");
    expect(JSON.stringify(sample)).not.toContain("observed_not_executed");
  });

  it("observer 原样保留同 ID 镜像与不同 ID 记录（不删改与预期不一致的数据）", () => {
    const mirror = {
      transactionId: "txn-mirror-1",
      time: 99,
      sender: { username: LAB_EXAMPLE_EXPERIMENT.username },
      recipient: { username: LAB_EXAMPLE_EXPERIMENT.username },
      resourceType: "H",
      amount: 100,
      from: LAB_EXAMPLE_EXPERIMENT.sourceRoomName,
      to: LAB_EXAMPLE_EXPERIMENT.targetRoomName,
      description: "完全不相关的既有交易",
    };
    const unrelated = {
      transactionId: "txn-other-2",
      time: 98,
      sender: { username: "someone-else" },
      recipient: { username: "another-user" },
      resourceType: "energy",
      amount: 999,
      from: "E1N1",
      to: "E2N2",
      description: "他人交易——与实验预期不一致也必须原样保留",
    };
    const world = installLabWorld({ incoming: [mirror, unrelated], outgoing: [mirror] });
    const capture = captureConsoleLog();
    try {
      requireArtifact(artifacts.observerBundle).loop();
    } finally {
      capture.restore();
      world.restore();
    }
    const sample = parseLabRecords(capture.lines)[0];
    expect(sample.transactions.incoming.status).toBe("ok");
    expect(sample.transactions.incoming.count).toBe(2);
    expect(sample.transactions.incoming.records).toEqual([mirror, unrelated]);
    expect(sample.transactions.outgoing.count).toBe(1);
    expect(sample.transactions.outgoing.records).toEqual([mirror]); // 同 ID 镜像原样
    const records = sample.transactions.incoming.records as Record<string, unknown>[];
    expect(records[1]?.amount).toBe(999); // 不一致数据未被删除/改写
  });

  it("single-shot 未武装/缺记录/损坏/实验 ID 不符——零调用并留前置拒绝原因", () => {
    const cases: readonly { label: string; control: unknown; reason: string }[] = [
      { label: "无控制记录", control: undefined, reason: "no_control_record" },
      { label: "控制记录损坏（字段类型非法）", control: { experimentId: 123, armed: true, attempted: false }, reason: "control_record_corrupt" },
      { label: "未武装", control: armedControl({ armed: false }), reason: "not_armed" },
      { label: "实验 ID 不符", control: armedControl({ experimentId: "another-experiment" }), reason: "experiment_id_mismatch" },
    ];
    for (const item of cases) {
      const world = installLabWorld();
      if (item.control !== undefined) {
        world.memory[LAB_CONTROL_MEMORY_KEY] = item.control;
      }
      const capture = captureConsoleLog();
      try {
        requireArtifact(artifacts.singleShotBundle).loop();
      } finally {
        capture.restore();
      }
      expect(world.sendCalls).toEqual([]);
      const rejections = parseLabRecords(capture.lines).filter((record) => record.kind === "lab-precondition-rejection");
      expect(rejections).toHaveLength(1);
      expect(rejections[0].reason).toBe(item.reason);
      expect(rejections[0].note).toContain("探针前置拒绝");
      world.restore();
    }
  });

  it("single-shot 错 shard/用户/结构/tick 与已尝试——零调用，拒绝原因逐项明确", () => {
    const cases: readonly { label: string; options: LabWorldOptions; control?: unknown; reason: string }[] = [
      { label: "shard 不符", options: { shardName: "official-looking-shard" }, control: armedControl(), reason: "shard_mismatch" },
      { label: "用户不符", options: { username: "not-the-synthetic-user" }, control: armedControl(), reason: "user_mismatch" },
      { label: "源结构 ID 不符", options: { sourceTerminalId: "term-someone-else" }, control: armedControl(), reason: "structure_mismatch" },
      { label: "tick 未到", options: { tick: LAB_EXAMPLE_EXPERIMENT.targetTick - 1 }, control: armedControl(), reason: "tick_not_reached" },
      { label: "tick 已错过", options: { tick: LAB_EXAMPLE_EXPERIMENT.targetTick + 1 }, control: armedControl(), reason: "tick_missed" },
      { label: "已经尝试过", options: {}, control: armedControl({ attempted: true }), reason: "already_attempted" },
      { label: "已停止", options: {}, control: armedControl({ stopped: true }), reason: "already_stopped" },
      { label: "源冷却中", options: { sourceCooldown: 5 }, control: armedControl(), reason: "cooldown_active" },
      { label: "报价超预算", options: { fee: LAB_EXAMPLE_EXPERIMENT.maxFeeEnergy + 1 }, control: armedControl(), reason: "fee_over_budget" },
      { label: "报价不可读", options: { fee: { throws: new Error("quote stub 异常") } }, control: armedControl(), reason: "fee_unreadable" },
      { label: "目标容量不足", options: { targetFreeCapacity: 60 }, control: armedControl(), reason: "target_capacity_insufficient" },
    ];
    for (const item of cases) {
      const world = installLabWorld(item.options);
      if (item.control !== undefined) {
        world.memory[LAB_CONTROL_MEMORY_KEY] = item.control;
      }
      const capture = captureConsoleLog();
      try {
        requireArtifact(artifacts.singleShotBundle).loop();
      } finally {
        capture.restore();
      }
      expect(world.sendCalls).toEqual([]);
      const rejections = parseLabRecords(capture.lines).filter((record) => record.kind === "lab-precondition-rejection");
      expect(rejections.map((record) => record.reason)).toEqual([item.reason]);
      world.restore();
    }
  });

  it("合法目标 tick 恰一次参数正确的调用；同 tick 重复 loop 与后续 tick 均不再调用", () => {
    const world = installLabWorld({});
    world.memory[LAB_CONTROL_MEMORY_KEY] = armedControl();
    const capture = captureConsoleLog();
    try {
      const singleShot = requireArtifact(artifacts.singleShotBundle);
      singleShot.loop();
      singleShot.loop(); // 同 tick 重复
      (world.game as { time: number }).time = LAB_EXAMPLE_EXPERIMENT.targetTick + 1;
      singleShot.loop(); // 后续 tick
    } finally {
      capture.restore();
    }
    try {
      expect(world.sendCalls).toHaveLength(1);
      const call = world.sendCalls[0];
      expect(call.args).toEqual([
        LAB_EXAMPLE_EXPERIMENT.resourceType,
        LAB_EXAMPLE_EXPERIMENT.amount,
        LAB_EXAMPLE_EXPERIMENT.targetRoomName,
        LAB_EXAMPLE_EXPERIMENT.description,
      ]);
      expect(call.self).toBe(world.sourceTerminal); // 方法所属对象绑定保持
      // 控制记录：调用前已标记 attempted；成功后 stopped 且不再次武装。
      const control = world.memory[LAB_CONTROL_MEMORY_KEY] as Record<string, any>;
      expect(control).toMatchObject({
        experimentId: LAB_EXAMPLE_EXPERIMENT.experimentId,
        armed: true,
        attempted: true,
        attemptedTick: LAB_EXAMPLE_EXPERIMENT.targetTick,
        syncResult: { ok: true, code: 0 },
        stopped: true,
      });
      expect(JSON.stringify(control).length).toBeLessThanOrEqual(4096); // 4KiB 上界
      // 三段发送记录：pre-call（含采样）/boundary/sync-return。
      const phases = parseLabRecords(capture.lines)
        .filter((record) => record.kind === "lab-send-attempt")
        .map((record) => record.phase);
      expect(phases).toEqual(["pre-call", "boundary", "sync-return"]);
    } finally {
      world.restore();
    }
  });

  it("同步非 OK 与同步抛错均不重试（attempted 已先行标记）", () => {
    for (const scenario of [
      { label: "同步非 OK", sendResult: -6, expectedCode: -6 },
      { label: "同步抛错", sendResult: { throws: new Error("send stub 同步异常") } },
    ] as const) {
      const world = installLabWorld({ sendResult: scenario.sendResult });
      world.memory[LAB_CONTROL_MEMORY_KEY] = armedControl();
      const capture = captureConsoleLog();
      try {
        const singleShot = requireArtifact(artifacts.singleShotBundle);
        singleShot.loop();
        (world.game as { time: number }).time += 1;
        singleShot.loop();
        (world.game as { time: number }).time += 1;
        singleShot.loop();
      } finally {
        capture.restore();
      }
      try {
        expect(world.sendCalls).toHaveLength(1); // 一次失败后零重试
        const control = world.memory[LAB_CONTROL_MEMORY_KEY] as Record<string, any>;
        expect(control.attempted).toBe(true);
        expect(control.stopped).toBe(true);
        if (typeof scenario.sendResult === "number") {
          expect(control.syncResult).toEqual({ ok: false, code: scenario.expectedCode });
        } else {
          expect(control.syncResult.ok).toBe(false);
          expect(control.syncResult.error).toContain("send stub 同步异常");
        }
      } finally {
        world.restore();
      }
    }
  });

  it("保留实验控制事实的 JSON 重载与模块重建不重发", () => {
    const world = installLabWorld({});
    world.memory[LAB_CONTROL_MEMORY_KEY] = armedControl();
    try {
      const singleShot = requireArtifact(artifacts.singleShotBundle);
      singleShot.loop();
      expect(world.sendCalls).toHaveLength(1);
      // JSON 重载（模拟世界侧 Memory 序列化往返）。
      (global as unknown as Record<string, unknown>).Memory = JSON.parse(JSON.stringify(world.memory));
      // 模块重建（global reset 后重新装载产物）。
      jest.resetModules();
      const reloaded = requireArtifact(artifacts.singleShotBundle);
      reloaded.loop();
      (world.game as { time: number }).time += 1;
      reloaded.loop();
      expect(world.sendCalls).toHaveLength(1); // 不重发
      const control = ((global as unknown as Record<string, unknown>).Memory as Record<string, unknown>)[
        LAB_CONTROL_MEMORY_KEY
      ] as Record<string, unknown>;
      expect(control.attempted).toBe(true);
    } finally {
      world.restore();
    }
  });

  it("OK 不自造效果：send 返回 OK 后库存/视图不变；后续 tick fixture 的差异由 observer 如实报告", () => {
    const world = installLabWorld({ sendResult: 0 });
    world.memory[LAB_CONTROL_MEMORY_KEY] = armedControl();
    try {
      const singleShot = requireArtifact(artifacts.singleShotBundle);
      const observer = requireArtifact(artifacts.observerBundle);
      singleShot.loop();
      expect(world.sendCalls).toHaveLength(1);
      // stub 未替引擎产生任何效果——探针也不自造（不改库存、不造交易记录）。
      let capture = captureConsoleLog();
      let samples: Record<string, any>[];
      try {
        observer.loop();
      } finally {
        capture.restore();
      }
      samples = parseLabRecords(capture.lines);
      expect(samples).toHaveLength(1);
      expect(samples[0].source.resourceAmount).toBe(1000);
      expect(samples[0].target.resourceAmount).toBe(0);
      expect(samples[0].transactions.incoming.count).toBe(0);
      expect(samples[0].transactions.outgoing.count).toBe(0);
      // 显式切换"后续 tick 观察 fixture"：模拟真实引擎 T+1 世界效果。
      const mirror = {
        transactionId: "txn-engine-1",
        time: LAB_EXAMPLE_EXPERIMENT.targetTick,
        sender: { username: LAB_EXAMPLE_EXPERIMENT.username },
        recipient: { username: LAB_EXAMPLE_EXPERIMENT.username },
        resourceType: "H",
        amount: 100,
        from: LAB_EXAMPLE_EXPERIMENT.sourceRoomName,
        to: LAB_EXAMPLE_EXPERIMENT.targetRoomName,
        description: LAB_EXAMPLE_EXPERIMENT.description,
      };
      (world.game as { time: number }).time = LAB_EXAMPLE_EXPERIMENT.targetTick + 1;
      const sourceStore = (world.sourceTerminal as { store: Record<string, number> }).store;
      sourceStore.H = 900;
      sourceStore.energy = 10_000 - 26;
      const targetTerminal = ((world.game as { rooms: Record<string, { terminal: { store: Record<string, number> } }> }).rooms)[
        LAB_EXAMPLE_EXPERIMENT.targetRoomName
      ].terminal;
      targetTerminal.store.H = 100;
      world.options.incoming = [mirror];
      world.options.outgoing = [mirror];
      capture = captureConsoleLog();
      try {
        observer.loop();
      } finally {
        capture.restore();
      }
      samples = parseLabRecords(capture.lines);
      expect(samples).toHaveLength(1);
      const later = samples[0];
      expect(later.tick).toBe(LAB_EXAMPLE_EXPERIMENT.targetTick + 1);
      expect(later.source.resourceAmount).toBe(900);
      expect(later.source.energy).toBe(10_000 - 26);
      expect(later.target.resourceAmount).toBe(100);
      expect(later.transactions.incoming.records).toEqual([mirror]);
      expect(later.transactions.outgoing.records).toEqual([mirror]); // 同 ID 镜像
      expect(world.sendCalls).toHaveLength(1); // 观察阶段零新增调用
    } finally {
      world.restore();
    }
  });

  it("Q01 基线复现：固定旧产物 VM 假端口七场景矩阵——三失败场景同 tick 双发 1/2/2", () => {
    // 旧产物三重身份（任务书 §3.1：字节 / Git blob 由归档提交保证 / SHA-256）。
    const bytes = readFileSync(LEGACY_SINGLE_SHOT_BUNDLE);
    expect(bytes.length).toBe(LEGACY_SINGLE_SHOT_BYTES);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(LEGACY_SINGLE_SHOT_SHA256);
    const code = bytes.toString("utf8");
    const rows = VM_SCENARIOS.map((scenario) => ({
      scenario: scenario.label,
      outcome: runVmScenario(code, scenario),
    }));
    console.log(`Q01-BASELINE ${JSON.stringify(rows)}`);
    const byLabel = new Map(rows.map((row) => [row.scenario, row.outcome]));
    const triple = (label: string): number[] => {
      const outcome = byLabel.get(label);
      if (outcome === undefined) throw new Error(`缺少场景 ${label}`);
      return [outcome.sendAfterLoop1, outcome.sendAfterLoop2, outcome.sendAfterNextTick];
    };
    // 对照组：未武装零发送；正常/非 OK/抛错各恰一次且不重试。
    expect(triple("S1 未武装/Memory 正常")).toEqual([0, 0, 0]);
    expect(triple("S2 正常武装/小记录/写入正常")).toEqual([1, 1, 1]);
    expect(triple("S3 send 非 OK/写入正常")).toEqual([1, 1, 1]);
    expect(triple("S4 send 抛错/写入正常")).toEqual([1, 1, 1]);
    // 三失败场景（旧行为基线）：标记没写上 → 同 tick 第二次 loop 再次发送。
    expect(triple("S5 控制槽 setter 抛错")).toEqual([1, 2, 2]);
    expect(triple("S6 控制槽 setter 静默丢写")).toEqual([1, 2, 2]);
    expect(triple("S7 初始 4090 字符/更新后超限")).toEqual([1, 2, 2]);
    // 旧缺陷特征留痕：S5/S7 写入被拒有日志但 send 仍发生；S6 完全无痕。
    expect(byLabel.get("S5 控制槽 setter 抛错")?.writeRefusedLines).toBeGreaterThanOrEqual(4);
    expect(byLabel.get("S7 初始 4090 字符/更新后超限")?.writeRefusedLines).toBeGreaterThanOrEqual(4);
    expect(byLabel.get("S6 控制槽 setter 静默丢写")?.writeRefusedLines).toBe(0);
    // 槽终态：旧产物失败后 attempted 仍为 false（正是重发根源）。
    for (const label of ["S5 控制槽 setter 抛错", "S6 控制槽 setter 静默丢写", "S7 初始 4090 字符/更新后超限"]) {
      expect(byLabel.get(label)?.slotFinalAttempted).toBe(false);
    }
    expect(byLabel.get("S2 正常武装/小记录/写入正常")?.slotFinalAttempted).toBe(true);
  });

  it("Q01/Q02 修复对照：新产物同矩阵三失败场景全零发送，且不打印 boundary/sync 输出", () => {
    const code = readFileSync(artifacts.singleShotBundle, "utf8");
    const rows = VM_SCENARIOS.map((scenario) => ({
      scenario: scenario.label,
      outcome: runVmScenario(code, scenario),
    }));
    console.log(`Q01-FIXED ${JSON.stringify(rows)}`);
    const byLabel = new Map(rows.map((row) => [row.scenario, row.outcome]));
    const triple = (label: string): number[] => {
      const outcome = byLabel.get(label);
      if (outcome === undefined) throw new Error(`缺少场景 ${label}`);
      return [outcome.sendAfterLoop1, outcome.sendAfterLoop2, outcome.sendAfterNextTick];
    };
    // 对照组行为保持：未武装 0；正常/非 OK/抛错恰一次。
    expect(triple("S1 未武装/Memory 正常")).toEqual([0, 0, 0]);
    expect(triple("S2 正常武装/小记录/写入正常")).toEqual([1, 1, 1]);
    expect(triple("S3 send 非 OK/写入正常")).toEqual([1, 1, 1]);
    expect(triple("S4 send 抛错/写入正常")).toEqual([1, 1, 1]);
    // 修复要求：三失败场景全部 0/0/0。
    expect(triple("S5 控制槽 setter 抛错")).toEqual([0, 0, 0]);
    expect(triple("S6 控制槽 setter 静默丢写")).toEqual([0, 0, 0]);
    expect(triple("S7 初始 4090 字符/更新后超限")).toEqual([0, 0, 0]);
    // 失败指向探针标记失败：S5 写入拒绝、S6 读回不匹配（静默丢写被真实读回发现）。
    expect(byLabel.get("S5 控制槽 setter 抛错")?.markUnconfirmed).toEqual([
      "mark_write/assign_failed",
      "mark_write/assign_failed",
    ]);
    expect(byLabel.get("S6 控制槽 setter 静默丢写")?.markUnconfirmed).toEqual([
      "mark_readback/readback_not_attempted",
      "mark_readback/readback_not_attempted",
    ]);
    // S7 如实口径：超限 note 记录在读取阶段即按 corrupt 拒绝（未走到写入超限分支）。
    const s7 = byLabel.get("S7 初始 4090 字符/更新后超限");
    expect(s7?.rejections).toEqual(["control_record_corrupt", "control_record_corrupt", "control_record_corrupt"]);
    expect(s7?.markUnconfirmed).toEqual([]);
    // 三失败场景不打印声称已进入实际发送的任何 phase（无 boundary/sync-return/pre-call）。
    for (const label of ["S5 控制槽 setter 抛错", "S6 控制槽 setter 静默丢写", "S7 初始 4090 字符/更新后超限"]) {
      expect(byLabel.get(label)?.sendAttemptPhases).toEqual([]);
    }
    // 正常路径仍完整经过 pre-call/boundary/sync（S4 为 throw 变体）。
    expect(byLabel.get("S2 正常武装/小记录/写入正常")?.sendAttemptPhases).toEqual([
      "pre-call",
      "boundary",
      "sync-return",
    ]);
    expect(byLabel.get("S4 send 抛错/写入正常")?.sendAttemptPhases).toEqual(["pre-call", "boundary", "sync-throw"]);
    expect(byLabel.get("S2 正常武装/小记录/写入正常")?.slotFinalAttempted).toBe(true);
    expect(byLabel.get("S2 正常武装/小记录/写入正常")?.slotFinalStopped).toBe(true);
  });

  it("Q02 正常预标记：send 入口内读 Memory 可见匹配 attempted（syncResult/stopped 尚未写入）", () => {
    let insideSend: unknown;
    const world = installLabWorld({
      onSend: () => {
        insideSend = (global as unknown as Record<string, unknown>).Memory?.[
          LAB_CONTROL_MEMORY_KEY
        ];
      },
    });
    world.memory[LAB_CONTROL_MEMORY_KEY] = armedControl();
    try {
      requireArtifact(artifacts.singleShotBundle).loop();
      expect(world.sendCalls).toHaveLength(1);
      // 入口内观察：不是只在 loop 结束后检查最终记录。
      expect(insideSend).toMatchObject({
        experimentId: LAB_EXAMPLE_EXPERIMENT.experimentId,
        armed: true,
        attempted: true,
        attemptedTick: LAB_EXAMPLE_EXPERIMENT.targetTick,
      });
      const observed = insideSend as Record<string, unknown>;
      expect(observed.syncResult).toBeUndefined(); // 结果尚未写（发送还没返回）
      expect(observed.stopped).toBeUndefined();
      // loop 结束后最终记录补齐 syncResult/stopped——两时点状态不同。
      const final = world.memory[LAB_CONTROL_MEMORY_KEY] as Record<string, unknown>;
      expect(final.syncResult).toEqual({ ok: true, code: 0 });
      expect(final.stopped).toBe(true);
    } finally {
      world.restore();
    }
  });

  it("Q02 写后读回故障：getter 异常/篡改实验 ID/篡改 tick——首次控制读取成功，零发送", () => {
    const cases: readonly {
      label: string;
      controlSlot: NonNullable<LabWorldOptions["controlSlot"]>;
      expectedReason: string;
      laterRejections: string[];
    }[] = [
      {
        label: "标记后读回 getter 抛错",
        controlSlot: { mode: "read-fail-after", reads: 1 },
        expectedReason: "readback_corrupt",
        // 后续 loop 的 gate 入口读同样抛错——readControlRecord 先于 tick 检查。
        laterRejections: ["control_record_corrupt", "control_record_corrupt"],
      },
      {
        label: "标记后读回实验 ID 被篡改",
        controlSlot: {
          mode: "tamper",
          tamper: (record) => ({ ...record, experimentId: "tampered-experiment-id" }),
        },
        expectedReason: "readback_experiment_mismatch",
        // 篡改记录 attempted=true 仍保留——后续 loop 均先撞 already_attempted（先于 tick 检查）。
        laterRejections: ["already_attempted", "already_attempted"],
      },
      {
        label: "标记后读回 attemptedTick 被篡改",
        controlSlot: {
          mode: "tamper",
          tamper: (record) => ({ ...record, attemptedTick: 99999 }),
        },
        expectedReason: "readback_tick_mismatch",
        laterRejections: ["already_attempted", "already_attempted"],
      },
    ];
    for (const item of cases) {
      const world = installLabWorld({ controlSlot: item.controlSlot });
      const capture = captureConsoleLog();
      try {
        const singleShot = requireArtifact(artifacts.singleShotBundle);
        singleShot.loop();
        singleShot.loop(); // 同 tick 重复
        (world.game as { time: number }).time = LAB_EXAMPLE_EXPERIMENT.targetTick + 1;
        singleShot.loop(); // 下一 tick
      } finally {
        capture.restore();
      }
      try {
        expect(world.sendCalls).toEqual([]);
        const records = parseLabRecords(capture.lines);
        // 第一次 loop 确实通过了门禁并进入标记阶段（故障在读回，不在入口读）。
        const marks = records.filter((record) => record.kind === "lab-mark-unconfirmed");
        expect(marks).toHaveLength(1);
        expect(marks[0]).toMatchObject({ stage: "mark_readback", reason: item.expectedReason });
        // 无任何发送边界输出。
        expect(records.filter((record) => record.kind === "lab-send-attempt")).toEqual([]);
        // 第二/三次 loop 的前置拒绝与各自读到的槽状态一致。
        expect(
          records.filter((record) => record.kind === "lab-precondition-rejection").map((record) => record.reason),
        ).toEqual(item.laterRejections);
      } finally {
        world.restore();
      }
    }
  });

  it("Q03 预标记成功后结果更新失败：attempted 不回退不重发；诊断超限拒写不破坏标记", () => {
    // 变体 a：结果/停止写回 setter 故障（第 1 次写成功、第 2 次起抛错）。
    {
      const world = installLabWorld({ controlSlot: { mode: "fail-writes-after", writes: 1 } });
      const capture = captureConsoleLog();
      try {
        const singleShot = requireArtifact(artifacts.singleShotBundle);
        singleShot.loop(); // 标记写（第 1 次）成功 + send 恰一次 + 结果写（第 2 次）抛错
        expect(world.sendCalls).toHaveLength(1);
        const afterFirst = world.memory[LAB_CONTROL_MEMORY_KEY] as Record<string, unknown>;
        expect(afterFirst).toMatchObject({
          experimentId: LAB_EXAMPLE_EXPERIMENT.experimentId,
          attempted: true,
          attemptedTick: LAB_EXAMPLE_EXPERIMENT.targetTick,
        });
        expect(afterFirst.stopped).toBeUndefined(); // 未谎报停止已保存
        singleShot.loop(); // 同 tick：already_attempted 拒——不回退标记以便再发
        (world.game as { time: number }).time = LAB_EXAMPLE_EXPERIMENT.targetTick + 1;
        singleShot.loop(); // 下一 tick
        // 保留该标记的 JSON 重载 + 模块重建（控制事实确实保留的 reset 对照）。
        (global as unknown as Record<string, unknown>).Memory = JSON.parse(JSON.stringify(world.memory));
        jest.resetModules();
        const reloaded = requireArtifact(artifacts.singleShotBundle);
        reloaded.loop();
        (world.game as { time: number }).time = LAB_EXAMPLE_EXPERIMENT.targetTick + 2;
        reloaded.loop();
        expect(world.sendCalls).toHaveLength(1); // 全程零增发
        const reloadedControl = ((global as unknown as Record<string, unknown>).Memory as Record<string, unknown>)[
          LAB_CONTROL_MEMORY_KEY
        ] as Record<string, unknown>;
        expect(reloadedControl.attempted).toBe(true); // 标记未被旧值覆盖或回滚
        expect(reloadedControl.stopped).toBeUndefined();
        const records = parseLabRecords(capture.lines);
        const refused = records.filter((record) => record.kind === "lab-result-write-refused");
        expect(refused.map((record) => record.reason)).toEqual(["assign_failed"]);
        expect(refused[0].syncResult).toEqual({ ok: true, code: 0 }); // 同步结果如实外记
      } finally {
        capture.restore();
        world.restore();
      }
    }
    // 变体 b：send 抛超长异常 → 结果写回因诊断超限被拒——attempted 保留、原始返回不改。
    {
      const world = installLabWorld({ sendResult: { throws: new Error("d".repeat(4500)) } });
      world.memory[LAB_CONTROL_MEMORY_KEY] = armedControl();
      const capture = captureConsoleLog();
      try {
        const singleShot = requireArtifact(artifacts.singleShotBundle);
        singleShot.loop();
        singleShot.loop();
        (world.game as { time: number }).time = LAB_EXAMPLE_EXPERIMENT.targetTick + 1;
        singleShot.loop();
      } finally {
        capture.restore();
      }
      try {
        expect(world.sendCalls).toHaveLength(1);
        const control = world.memory[LAB_CONTROL_MEMORY_KEY] as Record<string, unknown>;
        expect(control.attempted).toBe(true); // 超限拒写未破坏已确认标记
        expect(control.syncResult).toBeUndefined(); // 超长诊断未落槽
        expect(control.stopped).toBeUndefined();
        expect(JSON.stringify(control).length).toBeLessThanOrEqual(4096); // 控制记录保持有界
        const records = parseLabRecords(capture.lines);
        const refused = records.filter((record) => record.kind === "lab-result-write-refused");
        expect(refused.map((record) => record.reason)).toEqual(["size_limit"]);
        // 原始同步返回未被改为成功：sync-throw 如实记录 ok=false 与超长诊断。
        const syncThrow = records.find(
          (record) => record.kind === "lab-send-attempt" && record.phase === "sync-throw",
        );
        expect(syncThrow?.result.ok).toBe(false);
        expect(String(syncThrow?.result.error).length).toBeGreaterThan(4400);
      } finally {
        world.restore();
      }
    }
  });

  it("Q02 单元断言：写入函数明确拒绝超限/循环引用候选；未知顶层与 syncResult 字段读取按 corrupt", () => {
    const world = installLabWorld();
    try {
      // 超限候选（合法形状、超长 experimentId）：序列化前即拒，不触碰槽。
      const oversized: LabControlRecord = {
        experimentId: "x".repeat(4200),
        armed: true,
        attempted: true,
      };
      const oversizedWrite = writeControlRecord(oversized);
      expect(oversizedWrite.ok).toBe(false);
      expect((oversizedWrite as { reason?: string }).reason).toBe("size_limit");
      expect((oversizedWrite as { characters?: number }).characters ?? 0).toBeGreaterThan(4096);
      expect(world.memory[LAB_CONTROL_MEMORY_KEY]).toBeUndefined();
      // 循环引用：序列化失败明确拒绝（不静默返回 void）。
      const circular: Record<string, unknown> = { experimentId: "circular", armed: true, attempted: true };
      circular.self = circular;
      const circularWrite = writeControlRecord(circular as unknown as LabControlRecord);
      expect(circularWrite.ok).toBe(false);
      expect((circularWrite as { reason?: string }).reason).toBe("serialize_failed");
      expect(world.memory[LAB_CONTROL_MEMORY_KEY]).toBeUndefined();
      // 未知顶层字段（超限 note 类记录）：读取阶段即 corrupt。
      world.memory[LAB_CONTROL_MEMORY_KEY] = { ...armedControl(), note: "x".repeat(4090) };
      expect(readControlRecord().status).toBe("corrupt");
      // 未知 syncResult 字段：同样拒绝（不展开任意输入）。
      world.memory[LAB_CONTROL_MEMORY_KEY] = { ...armedControl(), syncResult: { ok: true, extra: 1 } };
      expect(readControlRecord().status).toBe("corrupt");
      // 合法记录正常读写。
      world.memory[LAB_CONTROL_MEMORY_KEY] = armedControl({ attempted: true, attemptedTick: 1 });
      const legal = readControlRecord();
      expect(legal.status).toBe("ok");
      if (legal.status === "ok") {
        expect(legal.record.attempted).toBe(true);
      }
      const legalWrite = writeControlRecord({ experimentId: "legal", armed: true, attempted: false });
      expect(legalWrite.ok).toBe(true);
      expect((world.memory[LAB_CONTROL_MEMORY_KEY] as Record<string, unknown>).experimentId).toBe("legal");
    } finally {
      world.restore();
    }
  });
});
