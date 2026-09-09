/**
 * Terminal Transfer Engine Lab Prep I——探针离线自测（任务书 §4.4；P03/P04），
 * Lab Prep I · Remediation I 扩展（Q01–Q03：发送前标记确认与失败路径矩阵），
 * Lab Prep I · Remediation II 扩展（R01–R03：4 KiB UTF-8 字节预算统一读写口径）。
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
 * Remediation II 新增：R01 基线复现——固定旧产物（Remediation I 交付归档）
 * 在非 ASCII send 异常下结果 JSON 2200 字符/6296 UTF-8 字节仍写入（B1），
 * 受支持字段组成的 5145 字节记录被旧读取入口判为健康（B2，产物 loop 对照
 * 只撞 already_stopped）；R02——4095/4096/4097（ASCII 与非 ASCII）读写边界、
 * measureUtf8Bytes 与独立 Buffer 计量对照（中文/双字节/emoji/转义/孤立代理项）、
 * 发送前读回超限按不健康拒绝；R03——新产物同场景超限结果拒写、attempted
 * 保留 ≤4096 字节、含同 tick 新 VM 重载累计 send=1，产物零 Node 编码依赖。
 * 期望字节数一律由 Buffer.byteLength 独立计算，被测实现不生成 expected。
 *
 * Calibration Rerun 新增（C01/场景 A/预算边界 E）：撤销"缺 shard 以约定值
 * 放行"分支——缺 shard/null/name 非法/读取抛错一律 world_read_error 且
 * 零 send、不进入 attempted 写入；sentinel 期归档产物（Run I Execution
 * 交付）在同一输入下放行，作为接受集合扩大的前后对照；旧事故链四步复现
 * （shard_mismatch → structure_mismatch → fee_over_budget → proceed）与
 * 非 26 报价的 cap=q 预算边界。
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
import { LAB_EXAMPLE_EXPERIMENT, type LabExperimentConfig } from "./labConfig";
import { evaluateSingleShotGates } from "./sendGate";

/**
 * Lab Prep I 历史配置 fixture（旧产物内嵌身份的完整记录）。Run I Execution
 * §4.3 合法迁移后当前编译值已回填真实实验身份；旧产物（Remediation 归档
 * single-shot）的反例/基线复现继续用本旧配置构造假世界——不混用两个身份。
 */
const LEGACY_EXPERIMENT: LabExperimentConfig = {
  experimentId: "lab-prep1-example-0001",
  mode: "observer",
  shardName: "lab-synthetic-shard",
  username: "lab-synthetic-user",
  sourceRoomName: "W1N57",
  targetRoomName: "W10N57",
  sourceTerminalId: "lab-term-source-synthetic",
  targetTerminalId: "lab-term-target-synthetic",
  resourceType: "H",
  amount: 100,
  description: "lab-prep1 single-shot terminal transfer experiment",
  targetTick: 12345,
  maxFeeEnergy: 1000,
  maxSamples: 32,
};
import {
  LAB_CONTROL_MEMORY_KEY,
  measureUtf8Bytes,
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
  /** 模拟 standalone runtime（screeps@4.3.0）不暴露 Game.shard 的引擎形态（C01：缺属性即拒绝）。 */
  noShardRuntime?: boolean;
  /** 直接指定 Game.shard 值（null/{} /{name:123}/{name:""} 等畸形形态——C01 拒绝矩阵）。 */
  shardOverride?: unknown;
  /** Game.shard 属性读取即抛错（C01 读取抛错分支）。 */
  shardReadThrows?: boolean;
  /** Game.time 属性读取即抛错（C01 world_read_error 分支）。 */
  timeReadThrows?: boolean;
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
  const game: Record<string, unknown> = {
    time: options.tick ?? config.targetTick,
    rooms,
    market: {
      calcTransactionCost: (): number => {
        const fee: number | { throws: Error } = options.fee ?? LAB_EXAMPLE_EXPERIMENT.maxFeeEnergy;
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
  // shard/time 形态注入（Calibration Rerun C01）：缺省合法 shard 对象；
  // noShardRuntime=不定义该属性；shardOverride=直接指定畸形形态；
  // shardReadThrows/timeReadThrows=属性读取抛错。
  if (options.shardReadThrows === true) {
    Object.defineProperty(game, "shard", {
      get() {
        throw new Error("Game.shard 读取异常（stub fixture）");
      },
    });
  } else if (options.noShardRuntime !== true) {
    game.shard =
      "shardOverride" in options ? options.shardOverride : { name: options.shardName ?? config.shardName, type: "normal", ptr: false };
  }
  if (options.timeReadThrows === true) {
    Object.defineProperty(game, "time", {
      configurable: true,
      get() {
        throw new Error("Game.time 读取异常（stub fixture）");
      },
    });
  }
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

/**
 * Run I Execution sentinel 期归档 single-shot 产物（3a9fceb 构建身份）：
 * 内嵌"缺 shard 放行"分支与旧编译配置（shardName standalone-no-shard、
 * 源 ID b0254105a49b92c、maxFeeEnergy 10）——接受集合扩大反例的唯一
 * 来源（Calibration Rerun C01 前后对照；历史归档字节不改写）。
 */
const SENTINEL_ERA_BUNDLE = join(
  REPO_ROOT,
  "openspec/changes/empire-treasury-core-rewrite/evidence/terminal-transfer-engine-lab-run-i/offline/execution-mainval/lab-single-shot/single-shot.js",
);
const SENTINEL_ERA_BYTES = 29139;
const SENTINEL_ERA_SHA256 = "3266d7b280688bcbc2156adcf1b3876ca5034c52344f2bd0aa3cb1e8373988e3";

/** 初始 JSON 长度恰为 4090 字符的记录（合法必要字段 + 程序补齐的 ASCII note）。 */
function buildOversizedControl(): Record<string, unknown> {
  const bare = JSON.stringify(armedControl()).length;
  const record = { ...armedControl(), note: "x".repeat(4090 - bare - 10) };
  if (JSON.stringify(record).length !== 4090) {
    throw new Error("note 补齐偏差——不应依赖手工数字符");
  }
  return record;
}

/** B2 记录（Remediation II §3.3）：受支持字段、合法形状的已结束记录（error 为 ASCII x）。 */
function b2FinishedRecord(errorLength: number, experimentId: string = LAB_EXAMPLE_EXPERIMENT.experimentId): Record<string, unknown> {
  return {
    experimentId,
    armed: true,
    attempted: true,
    attemptedTick: LAB_EXAMPLE_EXPERIMENT.targetTick,
    syncResult: { ok: false, error: "x".repeat(errorLength) },
    stopped: true,
  };
}

/**
 * 完整 JSON 恰为指定 UTF-8 字节数的已结束记录（R02 边界矩阵构造器）。
 * 非 ASCII 类用 "错"（3 字节/字符）+ "x"（1 字节）程序补齐；独立自检
 * Buffer.byteLength（expected 不由被测实现生成）。只测读写用已结束记录，
 * 避免"未尝试记录还要加标记"的空间问题混进边界结果。
 */
function finishedRecordAtBytes(targetBytes: number, nonAscii: boolean): LabControlRecord {
  const probe = {
    experimentId: LAB_EXAMPLE_EXPERIMENT.experimentId,
    armed: true,
    attempted: true,
    attemptedTick: LAB_EXAMPLE_EXPERIMENT.targetTick,
    syncResult: { ok: false, error: "" },
    stopped: true,
  };
  const base = Buffer.byteLength(JSON.stringify(probe), "utf8");
  const remaining = targetBytes - base;
  if (remaining < 0) throw new Error(`目标 ${targetBytes} 字节低于基础记录 ${base} 字节`);
  const error = nonAscii
    ? "错".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3)
    : "x".repeat(remaining);
  const record = { ...probe, syncResult: { ok: false, error } };
  const actual = Buffer.byteLength(JSON.stringify(record), "utf8");
  if (actual !== targetBytes) throw new Error(`字节补齐偏差：实际 ${actual} 目标 ${targetBytes}`);
  return record as LabControlRecord;
}

type VmSlotMode =
  | "unarmed"
  | "normal"
  | "setter-throw"
  | "silent-drop"
  | "oversized"
  | "b2-oversized";
type VmSendBehavior = "ok" | "non-ok" | "throw" | "throw-nonascii";

interface VmScenarioRow {
  readonly label: string;
  readonly slotMode: VmSlotMode;
  readonly sendBehavior: VmSendBehavior;
  /** 同 tick 两次 loop 后：同一 Game/Memory 在全新 VM 沙箱重建模块再 loop（B1 重载对照）。 */
  readonly reloadAtTargetTick?: boolean;
}

interface VmRunOutcome {
  readonly sendAfterLoop1: number;
  readonly sendAfterLoop2: number;
  readonly sendAfterNextTick: number;
  /** reloadAtTargetTick 场景：同 tick 新 VM 重建后的累计 send（其余场景 undefined）。 */
  readonly sendAfterReloadVm: number | undefined;
  readonly slotFinalAttempted: unknown;
  readonly slotFinalStopped: unknown;
  /** 槽终态完整 JSON（槽缺失/不可序列化→null）——字节口径断言的对象。 */
  readonly slotFinalSerialized: string | null;
  readonly markUnconfirmed: string[];
  readonly rejections: string[];
  readonly sendAttemptPhases: string[];
  readonly sendAttemptRecords: Record<string, any>[];
  readonly writeRefusedLines: number;
  readonly writeRefusedRecords: Record<string, any>[];
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
function runVmScenario(
  bundleCode: string,
  scenario: VmScenarioRow,
  // 旧产物（Remediation 归档 single-shot，内嵌旧配置）传 LEGACY_EXPERIMENT；
  // 新产物默认当前编译配置——Run I Execution §4.3 不混用两个身份。
  experiment: LabExperimentConfig = LAB_EXAMPLE_EXPERIMENT,
): VmRunOutcome {
  const config = experiment;
  const legacyArmed = (): Record<string, unknown> => ({
    experimentId: config.experimentId,
    armed: true,
    attempted: false,
  });
  const legacyOversized = (): Record<string, unknown> => {
    const bare = JSON.stringify(legacyArmed()).length;
    const record = { ...legacyArmed(), note: "x".repeat(4090 - bare - 10) };
    if (JSON.stringify(record).length !== 4090) {
      throw new Error("note 补齐偏差——不应依赖手工数字符");
    }
    return record;
  };
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
      if (scenario.sendBehavior === "throw-nonascii") throw new Error("错".repeat(2048));
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
    market: { calcTransactionCost: () => config.maxFeeEnergy, incomingTransactions: [], outgoingTransactions: [] },
  };
  const memory: Record<string, unknown> = {};
  let stored: Record<string, unknown> | undefined;
  if (scenario.slotMode === "setter-throw" || scenario.slotMode === "silent-drop") {
    stored = legacyArmed();
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
    memory[LAB_CONTROL_MEMORY_KEY] = legacyOversized();
  } else if (scenario.slotMode === "b2-oversized") {
    memory[LAB_CONTROL_MEMORY_KEY] = b2FinishedRecord(5000, config.experimentId);
  } else if (scenario.slotMode === "unarmed") {
    memory[LAB_CONTROL_MEMORY_KEY] = { ...legacyArmed(), armed: false };
  } else {
    memory[LAB_CONTROL_MEMORY_KEY] = legacyArmed();
  }
  const logLines: string[] = [];
  const vmConsole = { log: (...args: unknown[]) => logLines.push(args.map(String).join(" ")) };
  const moduleExports: { loop?: () => void } = {};
  runInNewContext(
    bundleCode,
    {
      exports: moduleExports,
      module: { exports: moduleExports },
      console: vmConsole,
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
  let sendAfterReloadVm: number | undefined;
  if (scenario.reloadAtTargetTick === true) {
    // 同 tick 新 VM：同一 Game/Memory、全新模块环境（保留控制事实的重载对照——
    // 避免"错过 tick 门禁"掩盖保留事实失效的情况）。
    const reloadedExports: { loop?: () => void } = {};
    runInNewContext(
      bundleCode,
      {
        exports: reloadedExports,
        module: { exports: reloadedExports },
        console: vmConsole,
        Game: game,
        Memory: memory,
      },
      { filename: "vm-single-shot-bundle-reload.js" },
    );
    if (typeof reloadedExports.loop !== "function") throw new Error("重载产物未导出 loop");
    reloadedExports.loop();
    sendAfterReloadVm = sendCalls.length;
  }
  (game as { time: number }).time = config.targetTick + 1;
  moduleExports.loop();
  const sendAfterNextTick = sendCalls.length;
  const labRecords = logLines
    .filter((line) => line.startsWith("{") && line.includes('"kind":"lab-'))
    .map((line) => JSON.parse(line) as Record<string, any>);
  let slotFinal: unknown;
  try {
    slotFinal = memory[LAB_CONTROL_MEMORY_KEY];
  } catch {
    slotFinal = undefined;
  }
  const slotRecord = slotFinal as Record<string, unknown> | undefined;
  let slotFinalSerialized: string | null = null;
  if (slotFinal !== undefined) {
    try {
      slotFinalSerialized = JSON.stringify(slotFinal);
    } catch {
      slotFinalSerialized = null;
    }
  }
  const sendAttemptRecords = labRecords.filter((record) => record.kind === "lab-send-attempt");
  const writeRefusedRecords = labRecords.filter((record) => record.kind === "lab-control-write-refused");
  return {
    sendAfterLoop1,
    sendAfterLoop2,
    sendAfterNextTick,
    sendAfterReloadVm,
    slotFinalAttempted: slotRecord?.attempted,
    slotFinalStopped: slotRecord?.stopped,
    slotFinalSerialized,
    markUnconfirmed: labRecords
      .filter((record) => record.kind === "lab-mark-unconfirmed")
      .map((record) => `${record.stage}/${record.reason}`),
    rejections: labRecords
      .filter((record) => record.kind === "lab-precondition-rejection")
      .map((record) => record.reason),
    sendAttemptPhases: sendAttemptRecords.map((record) => record.phase),
    sendAttemptRecords,
    writeRefusedLines: writeRefusedRecords.length,
    writeRefusedRecords,
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
      expect(sample.feeQuote.energyCost).toBe(LAB_EXAMPLE_EXPERIMENT.maxFeeEnergy); // 读自 stub 端口（非硬编码进产物）
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

  it("Calibration C01 严格 shard 门禁：缺 shard/null/name 非法/读取抛错一律拒绝（零 send、不进入 attempted 写入）；sentinel 期旧产物同输入放行（接受集合扩大已撤销）", () => {
    // 函数级矩阵：配置显式声明旧 sentinel 字面值（测试局部变体）+ 其余条件合法。
    // mode 按 singleShot.ts 的派生规则自覆盖为 single-shot（observer 是文档
    // 默认，调用版内嵌模式才是门禁输入）。
    const sentinelConfig: LabExperimentConfig = { ...LAB_EXAMPLE_EXPERIMENT, mode: "single-shot", shardName: "standalone-no-shard" };
    const legalControl = {
      status: "ok" as const,
      record: { experimentId: LAB_EXAMPLE_EXPERIMENT.experimentId, armed: true, attempted: false },
    };
    const malformed: readonly { label: string; options: LabWorldOptions }[] = [
      { label: "缺 Game.shard（noShardRuntime）", options: { noShardRuntime: true } },
      { label: "shard 为 null", options: { shardOverride: null } },
      { label: "shard 为 {}（name 缺失）", options: { shardOverride: {} } },
      { label: "name 非字符串（123）", options: { shardOverride: { name: 123 } } },
      { label: "name 空串", options: { shardOverride: { name: "" } } },
      { label: "Game.shard 读取抛错", options: { shardReadThrows: true } },
      { label: "Game.time 读取抛错", options: { timeReadThrows: true } },
    ];
    for (const item of malformed) {
      const world = installLabWorld(item.options);
      try {
        const decision = evaluateSingleShotGates(sentinelConfig, legalControl);
        expect(decision).toEqual({ decision: "reject", reason: "world_read_error" });
      } finally {
        world.restore();
      }
    }
    // 信息完整的合法对照（避免"始终拒绝"假通过）：真实合法名与配置精确一致 → proceed。
    {
      const world = installLabWorld({}); // 缺省 shard 名 = 当前编译配置值
      try {
        const decision = evaluateSingleShotGates({ ...LAB_EXAMPLE_EXPERIMENT, mode: "single-shot" }, legalControl);
        expect(decision.decision).toBe("proceed");
        if (decision.decision === "proceed") {
          expect(decision.fee).toBe(LAB_EXAMPLE_EXPERIMENT.maxFeeEnergy);
        }
      } finally {
        world.restore();
      }
    }
    // 产物级：当前产物在无 shard 引擎上以 world_read_error 前置拒绝。
    const world = installLabWorld({ noShardRuntime: true });
    world.memory[LAB_CONTROL_MEMORY_KEY] = armedControl();
    const capture = captureConsoleLog();
    try {
      requireArtifact(artifacts.singleShotBundle).loop();
    } finally {
      capture.restore();
    }
    try {
      expect(world.sendCalls).toEqual([]);
      const rejections = parseLabRecords(capture.lines).filter((record) => record.kind === "lab-precondition-rejection");
      expect(rejections).toHaveLength(1);
      expect(rejections[0].reason).toBe("world_read_error");
      // 门禁在进入发送/标记阶段之前拒绝：控制记录保持原样（attempted 仍 false）。
      expect(world.memory[LAB_CONTROL_MEMORY_KEY]).toEqual({
        experimentId: LAB_EXAMPLE_EXPERIMENT.experimentId,
        armed: true,
        attempted: false,
      });
    } finally {
      world.restore();
    }
    // 前后对照（接受集合扩大的直接证据，函数级→产物级）：sentinel 期归档产物
    // 在同一"无 Game.shard"输入、其余条件匹配其内嵌旧配置（用户
    // lab-synthetic-user、tick 557、源 b0254105…、目标 c61a4141…、报价 10
    // ≤ cap 10）时放行并发送一次——该分支即本轮撤销的对象；历史归档字节
    // 保持不变（绑定迁移后新编译身份与之不同，世界按其内嵌旧身份显式构造）。
    const sentinelBytes = readFileSync(SENTINEL_ERA_BUNDLE);
    expect(sentinelBytes.length).toBe(SENTINEL_ERA_BYTES);
    expect(createHash("sha256").update(sentinelBytes).digest("hex")).toBe(SENTINEL_ERA_SHA256);
    const sentinelWorld = installLabWorld({
      noShardRuntime: true,
      username: "lab-synthetic-user",
      tick: 557,
      sourceTerminalId: "b0254105a49b92c",
      targetTerminalId: "c61a4141a4a9fcb",
      fee: 10,
    });
    sentinelWorld.memory[LAB_CONTROL_MEMORY_KEY] = armedControl({ experimentId: "lab-run1-exec-0001" });
    const sentinelCapture = captureConsoleLog();
    try {
      requireArtifact(SENTINEL_ERA_BUNDLE).loop();
    } finally {
      sentinelCapture.restore();
    }
    try {
      expect(sentinelWorld.sendCalls).toHaveLength(1); // 旧实现放行（接受集合扩大）
      expect(sentinelWorld.memory[LAB_CONTROL_MEMORY_KEY]).toMatchObject({ attempted: true });
    } finally {
      sentinelWorld.restore();
    }
  });

  it("Calibration 场景 A 旧事故链门禁复现（跨时间资料构造的离线诊断场景）：旧编译配置 shard_mismatch → 改 Forst 后 structure_mismatch → 纠正源 ID 后 fee_over_budget → cap 设 26 后 proceed", () => {
    // 固定独立世界 fixture＝上轮事故身份：源 b0254141a49b92c（该轮初始化/
    // 终态实测值）、目标 c61a4141a4a9fcb、报价 26、shard Forst（窗口后只读
    // 探查实测名）、用户 lab-synthetic-user、tick 557。本场景是离线诊断
    // 构造，不是 T557 世界的无损重放；26 只用于历史反例与合法对照，不能
    // 成为新实验常数。绑定迁移后当前编译身份（lab-run1-cal-0002 世界）
    // 与本事故族不同，故事故链配置显式声明、不隐式跟随当前编译值。
    const incidentWorld = () =>
      installLabWorld({
        shardName: "Forst",
        username: "lab-synthetic-user",
        tick: 557,
        sourceTerminalId: "b0254141a49b92c",
        targetTerminalId: "c61a4141a4a9fcb",
        fee: 26,
      });
    const incidentControl = {
      status: "ok" as const,
      record: { experimentId: "lab-run1-exec-0001", armed: true, attempted: false },
    };
    const steps: readonly { label: string; config: LabExperimentConfig; expected: string }[] = [
      {
        label: "旧编译配置（sentinel shard + 源 ID b0254105 + cap 10）",
        config: { ...LAB_EXAMPLE_EXPERIMENT, mode: "single-shot", experimentId: "lab-run1-exec-0001", username: "lab-synthetic-user", targetTerminalId: "c61a4141a4a9fcb", targetTick: 557, shardName: "standalone-no-shard", sourceTerminalId: "b0254105a49b92c", maxFeeEnergy: 10 },
        expected: "shard_mismatch",
      },
      {
        label: "只将配置 shard 改为 Forst",
        config: { ...LAB_EXAMPLE_EXPERIMENT, mode: "single-shot", experimentId: "lab-run1-exec-0001", username: "lab-synthetic-user", targetTerminalId: "c61a4141a4a9fcb", targetTick: 557, shardName: "Forst", sourceTerminalId: "b0254105a49b92c", maxFeeEnergy: 10 },
        expected: "structure_mismatch",
      },
      {
        label: "再将源 ID 纠正为 b0254141a49b92c",
        config: { ...LAB_EXAMPLE_EXPERIMENT, mode: "single-shot", experimentId: "lab-run1-exec-0001", username: "lab-synthetic-user", targetTerminalId: "c61a4141a4a9fcb", targetTick: 557, shardName: "Forst", sourceTerminalId: "b0254141a49b92c", maxFeeEnergy: 10 },
        expected: "fee_over_budget",
      },
      {
        label: "再把费用上限设为 26（=报价）",
        config: { ...LAB_EXAMPLE_EXPERIMENT, mode: "single-shot", experimentId: "lab-run1-exec-0001", username: "lab-synthetic-user", targetTerminalId: "c61a4141a4a9fcb", targetTick: 557, shardName: "Forst", sourceTerminalId: "b0254141a49b92c", maxFeeEnergy: 26 },
        expected: "proceed",
      },
    ];
    const world = incidentWorld();
    try {
      for (const step of steps) {
        const decision = evaluateSingleShotGates(step.config, incidentControl);
        if (step.expected === "proceed") {
          expect(decision.decision).toBe("proceed");
          if (decision.decision === "proceed") {
            expect(decision.fee).toBe(26);
          }
        } else {
          expect(decision).toEqual({ decision: "reject", reason: step.expected });
        }
      }
    } finally {
      world.restore();
    }
    // 产物级锚定：当前编译配置（lab-run1-cal-0002 新世界身份）在与其匹配的
    // 世界（installLabWorld 缺省跟随当前值）发送一次——证明事故链终态语义
    // 对当前绑定同样成立。
    const productWorld = installLabWorld({ shardName: "Forst" });
    productWorld.memory[LAB_CONTROL_MEMORY_KEY] = armedControl();
    const capture = captureConsoleLog();
    try {
      requireArtifact(artifacts.singleShotBundle).loop();
    } finally {
      capture.restore();
    }
    try {
      expect(productWorld.sendCalls).toHaveLength(1);
      expect(productWorld.memory[LAB_CONTROL_MEMORY_KEY]).toMatchObject({ attempted: true, stopped: true });
    } finally {
      productWorld.restore();
    }
  });

  it("Calibration E 预算边界（非 26 报价，无硬编码）：报价等于 cap 通过、大于 cap 拒绝、读取异常拒绝；cap 不被自动改大", () => {
    const world = installLabWorld({ fee: 37 });
    try {
      const control = {
        status: "ok" as const,
        record: { experimentId: LAB_EXAMPLE_EXPERIMENT.experimentId, armed: true, attempted: false },
      };
      const capEqualsQuote: LabExperimentConfig = { ...LAB_EXAMPLE_EXPERIMENT, mode: "single-shot", maxFeeEnergy: 37 };
      const atCap = evaluateSingleShotGates(capEqualsQuote, control);
      expect(atCap.decision).toBe("proceed");
      if (atCap.decision === "proceed") {
        expect(atCap.fee).toBe(37);
      }
      expect(capEqualsQuote.maxFeeEnergy).toBe(37); // cap 未被实现自动改大
      const below = evaluateSingleShotGates({ ...capEqualsQuote, maxFeeEnergy: 36 }, control);
      expect(below).toEqual({ decision: "reject", reason: "fee_over_budget" });
    } finally {
      world.restore();
    }
    const errorWorld = installLabWorld({ fee: { throws: new Error("quote stub 异常") } });
    try {
      const decision = evaluateSingleShotGates(
        { ...LAB_EXAMPLE_EXPERIMENT, mode: "single-shot", maxFeeEnergy: 37 },
        { status: "ok", record: { experimentId: LAB_EXAMPLE_EXPERIMENT.experimentId, armed: true, attempted: false } },
      );
      expect(decision).toEqual({ decision: "reject", reason: "fee_unreadable" });
    } finally {
      errorWorld.restore();
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
      expect(Buffer.byteLength(JSON.stringify(control), "utf8")).toBeLessThanOrEqual(4096); // 4KiB 字节上界（Remediation II 口径）
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
      sourceStore.energy = 10_000 - LAB_EXAMPLE_EXPERIMENT.maxFeeEnergy;
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
      expect(later.source.energy).toBe(10_000 - LAB_EXAMPLE_EXPERIMENT.maxFeeEnergy);
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
      outcome: runVmScenario(code, scenario, LEGACY_EXPERIMENT),
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
        expect(Buffer.byteLength(JSON.stringify(control), "utf8")).toBeLessThanOrEqual(4096); // 控制记录保持有界（字节口径）
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
      expect(oversizedWrite.bytes ?? 0).toBeGreaterThan(4096); // 拒绝单位为 UTF-8 字节
      expect(oversizedWrite.bytes).toBe(JSON.stringify(oversized).length); // 纯 ASCII 候选下字符=字节（诊断口径互证）
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

  it("R02 读写边界矩阵：4095/4096 通过、4097 拒写且读取不健康——ASCII 与非 ASCII 已结束记录（4096 精确合法对照）", () => {
    const world = installLabWorld();
    try {
      const rows: Record<string, unknown>[] = [];
      for (const nonAscii of [false, true]) {
        for (const target of [4095, 4096, 4097]) {
          const record = finishedRecordAtBytes(target, nonAscii);
          const serialized = JSON.stringify(record);
          const independentBytes = Buffer.byteLength(serialized, "utf8"); // expected 独立计算
          expect(independentBytes).toBe(target);
          if (target <= 4096) {
            // 合法值正常读写；精确 4096 是上限内的合法成功对照（不得实现为 >=4096 全拒）。
            const write = writeControlRecord(record);
            expect(write.ok).toBe(true);
            expect(world.memory[LAB_CONTROL_MEMORY_KEY]).toEqual(JSON.parse(serialized));
            expect(readControlRecord().status).toBe("ok");
            rows.push({ nonAscii, bytes: independentBytes, characters: serialized.length, write: "ok", read: "ok" });
          } else {
            // 4097：先放入一个合法旧值，再试超限写——拒写且旧槽不变。
            const keeper = finishedRecordAtBytes(4095, nonAscii);
            expect(writeControlRecord(keeper).ok).toBe(true);
            const keeperRef = world.memory[LAB_CONTROL_MEMORY_KEY];
            const refused = writeControlRecord(record);
            expect(refused.ok).toBe(false);
            expect((refused as { reason?: string }).reason).toBe("size_limit");
            expect(refused.bytes).toBe(4097);
            expect(refused.characters).toBe(serialized.length); // 诊断字段与字节分开报告
            expect(world.memory[LAB_CONTROL_MEMORY_KEY]).toBe(keeperRef); // 旧槽引用不变
            // 直接预置该超限值后读取不健康且零写。
            world.memory[LAB_CONTROL_MEMORY_KEY] = record;
            const recordRef = world.memory[LAB_CONTROL_MEMORY_KEY];
            expect(readControlRecord().status).toBe("corrupt");
            expect(world.memory[LAB_CONTROL_MEMORY_KEY]).toBe(recordRef); // 读取零写
            rows.push({ nonAscii, bytes: independentBytes, characters: serialized.length, write: "refused", read: "corrupt" });
          }
        }
      }
      console.log(`R02-BOUNDARY ${JSON.stringify(rows)}`);
    } finally {
      world.restore();
    }
  });

  it("R02 计量辅助对照：measureUtf8Bytes 与独立 Buffer 计量在中文/双字节/emoji/转义/孤立代理项上一致；短合法 Unicode 正常读写", () => {
    const cases: readonly string[] = [
      "",
      "plain ascii 123",
      "错",
      "错".repeat(100),
      "é", // U+00E9 双字节
      "ᛃ", // U+16C3 三字节 BMP
      "😀", // U+1F600 代理对四字节
      "😀错éx",
      'quote " back \\ slash',
      "line\nbreak\ttab",
      JSON.stringify({ error: 'quo"te\\back\nsl\u00e1sh' }),
      String.fromCharCode(0xd800), // 孤立高代理
      String.fromCharCode(0xdfff), // 孤立低代理
      "a" + String.fromCharCode(0xdbff), // 高代理结尾（无低代理跟随）
      String.fromCharCode(0xd800, 0xdc00), // 有效代理对
      String.fromCharCode(0xd800) + "错", // 孤立高代理后跟 BMP
    ];
    for (const value of cases) {
      expect(measureUtf8Bytes(value)).toBe(Buffer.byteLength(value, "utf8")); // expected 由 Buffer 独立生成
    }
    // JSON 序列化后的对照：孤立代理被 stringify 转义为 \uXXXX（ASCII 序列）——
    // 验证的是实际序列化字符串，不引入任意对象序列化协议。
    const serializedLoneSurrogate = JSON.stringify({ error: String.fromCharCode(0xd800) });
    expect(serializedLoneSurrogate).toContain("\\ud800");
    expect(measureUtf8Bytes(serializedLoneSurrogate)).toBe(
      Buffer.byteLength(serializedLoneSurrogate, "utf8"),
    );
    // 短合法 Unicode error 不被一律拒绝。
    const world = installLabWorld();
    try {
      const short: LabControlRecord = {
        experimentId: "unicode-short",
        armed: true,
        attempted: true,
        syncResult: { ok: false, error: "错é😀" },
      };
      expect(writeControlRecord(short).ok).toBe(true);
      const read = readControlRecord();
      expect(read.status).toBe("ok");
      if (read.status === "ok") {
        expect(read.record.syncResult?.error).toBe("错é😀");
      }
    } finally {
      world.restore();
    }
  });

  it("R01/R03 B1 非 ASCII 结果超限：产物拒绝超限结果写回、attempted 保留且槽 ≤4096 字节、异常如实外记、含同 tick 新 VM 重载累计 send=1", () => {
    // 静态面辅助断言：新产物无 Node 编码依赖（容量路径不依赖 Buffer/TextEncoder/process 注入；
    // VM 沙箱本身也只提供 exports/module/console/Game/Memory）。
    const bundleSource = readFileSync(artifacts.singleShotBundle, "utf8");
    expect(bundleSource).not.toMatch(/\bBuffer\b|\bTextEncoder\b|\bprocess\b|\brequire\s*\(/);
    const scenario: VmScenarioRow = {
      label: "B1 非 ASCII 结果超限",
      slotMode: "normal",
      sendBehavior: "throw-nonascii",
      reloadAtTargetTick: true,
    };
    const legacy = runVmScenario(readFileSync(LEGACY_SINGLE_SHOT_BUNDLE, "utf8"), scenario, LEGACY_EXPERIMENT);
    const fixed = runVmScenario(bundleSource, scenario);
    console.log(`R03-B1 ${JSON.stringify({ legacy, fixed })}`);
    // 旧产物（R01 基线缺口）：send 恰一次后超限结果仍写入——字符 ≤4096、字节 >4096。
    expect(
      [legacy.sendAfterLoop1, legacy.sendAfterLoop2, legacy.sendAfterNextTick, legacy.sendAfterReloadVm],
    ).toEqual([1, 1, 1, 1]);
    expect(legacy.slotFinalSerialized).not.toBeNull();
    const legacyBytes = legacy.slotFinalSerialized === null ? -1 : Buffer.byteLength(legacy.slotFinalSerialized, "utf8");
    expect(legacyBytes).toBeGreaterThan(4096);
    const legacyParsed = legacy.slotFinalSerialized === null ? {} : (JSON.parse(legacy.slotFinalSerialized) as Record<string, any>);
    expect(String(legacyParsed.syncResult?.error ?? "").length).toBeGreaterThan(2048);
    expect(legacyParsed.stopped).toBe(true); // 超限结果连同 stopped 一并落槽——缺口特征
    expect(legacy.writeRefusedLines).toBe(0); // 旧字符口径未拒绝
    // 新产物：合法 send 仍恰一次（结果超限不追溯取消调用），但超限结果写回被拒。
    expect(
      [fixed.sendAfterLoop1, fixed.sendAfterLoop2, fixed.sendAfterNextTick, fixed.sendAfterReloadVm],
    ).toEqual([1, 1, 1, 1]);
    expect(fixed.slotFinalSerialized).not.toBeNull();
    const fixedBytes = fixed.slotFinalSerialized === null ? -1 : Buffer.byteLength(fixed.slotFinalSerialized, "utf8");
    expect(fixedBytes).toBeGreaterThan(0);
    expect(fixedBytes).toBeLessThanOrEqual(4096); // 槽仅保留匹配的 attempted 标记
    const fixedParsed = fixed.slotFinalSerialized === null ? {} : (JSON.parse(fixed.slotFinalSerialized) as Record<string, any>);
    expect(fixedParsed).toMatchObject({
      experimentId: LAB_EXAMPLE_EXPERIMENT.experimentId,
      armed: true,
      attempted: true,
      attemptedTick: LAB_EXAMPLE_EXPERIMENT.targetTick,
    });
    expect(fixedParsed.syncResult).toBeUndefined(); // 超限结果未落槽
    expect(fixedParsed.stopped).toBeUndefined(); // 不谎报停止已保存
    // 超限拒写留痕：报告 bytes（UTF-8 字节）并声明单位；characters 仅诊断。
    const refusals = fixed.writeRefusedRecords.filter((record) => record.reason === "size_limit");
    expect(refusals).toHaveLength(1);
    expect(refusals[0].bytes).toBeGreaterThan(4096);
    expect(refusals[0].limitUnits).toBe("utf8-bytes");
    expect(refusals[0].characters).toBeLessThan(refusals[0].bytes); // 非 ASCII 下两口径必然不同
    // 同步异常在外部日志如实记录（sync-throw 含非 ASCII 超长诊断），不改为成功。
    expect(fixed.sendAttemptPhases).toEqual(["pre-call", "boundary", "sync-throw"]);
    const syncThrow = fixed.sendAttemptRecords.find((record) => record.phase === "sync-throw");
    expect(syncThrow?.result?.ok).toBe(false);
    expect(String(syncThrow?.result?.error ?? "").includes("错")).toBe(true);
    expect(String(syncThrow?.result?.error ?? "").length).toBeGreaterThan(2048);
    // 后续 loop（同 tick/新 VM/下一 tick）均因保留的 attempted 拒绝——零增发。
    expect(fixed.rejections).toEqual(["already_attempted", "already_attempted", "already_attempted"]);
  });

  it("R01/R03 B2 受支持字段超限记录：读取不健康且零写；产物 loop 在控制读取阶段拒绝（非 already_stopped）；短对照继续健康", () => {
    // 直接 reader（Node 环境）：受支持字段、合法形状、完整 JSON UTF-8 字节 >4096。
    const world = installLabWorld();
    try {
      const oversized = b2FinishedRecord(5000);
      const serialized = JSON.stringify(oversized);
      expect(Buffer.byteLength(serialized, "utf8")).toBeGreaterThan(4096); // 独立证明
      world.memory[LAB_CONTROL_MEMORY_KEY] = oversized;
      const recordRef = world.memory[LAB_CONTROL_MEMORY_KEY];
      expect(readControlRecord().status).toBe("corrupt");
      expect(world.memory[LAB_CONTROL_MEMORY_KEY]).toBe(recordRef); // 读取零写、不删除/裁剪/重置
      // 字段相同、短 error 的合法对照——读取没有被整体禁用。
      world.memory[LAB_CONTROL_MEMORY_KEY] = b2FinishedRecord(10);
      const short = readControlRecord();
      expect(short.status).toBe("ok");
      if (short.status === "ok") {
        expect(short.record.stopped).toBe(true);
      }
    } finally {
      world.restore();
    }
    // 产物 VM 对照：旧产物读取健康误判只撞 already_stopped；新产物在控制读取阶段拒绝。
    const scenario: VmScenarioRow = { label: "B2 受支持字段超限", slotMode: "b2-oversized", sendBehavior: "ok" };
    const legacy = runVmScenario(readFileSync(LEGACY_SINGLE_SHOT_BUNDLE, "utf8"), scenario, LEGACY_EXPERIMENT);
    const fixed = runVmScenario(readFileSync(artifacts.singleShotBundle, "utf8"), scenario);
    console.log(`R03-B2 ${JSON.stringify({ legacy, fixed })}`);
    expect(legacy.rejections).toEqual(["already_stopped", "already_stopped", "already_stopped"]); // 旧读取健康误判
    expect([legacy.sendAfterLoop1, legacy.sendAfterLoop2, legacy.sendAfterNextTick]).toEqual([0, 0, 0]);
    expect(fixed.rejections).toEqual(["control_record_corrupt", "control_record_corrupt", "control_record_corrupt"]);
    expect([fixed.sendAfterLoop1, fixed.sendAfterLoop2, fixed.sendAfterNextTick]).toEqual([0, 0, 0]);
    expect(fixed.sendAttemptPhases).toEqual([]);
    expect(fixed.slotFinalSerialized).toBe(JSON.stringify(b2FinishedRecord(5000))); // 原输入内容不变（零控制槽写）
  });

  it("R02 发送前读回超限：标记写后读回返回 ID/tick/attempted 匹配但 error 超限的已知字段对象——按不健康读回拒绝，零 send 零发送边界日志", () => {
    const world = installLabWorld({
      controlSlot: {
        mode: "tamper",
        // 故障只发生在写后读回阶段：标记写本身合法；读回对象用相同已知字段、
        // ID/tick/attempted 均匹配、仅 syncResult.error 超限（不含未知键）。
        tamper: (record) => ({ ...record, syncResult: { ok: false, error: "x".repeat(5000) } }),
      },
    });
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
      const marks = records.filter((record) => record.kind === "lab-mark-unconfirmed");
      expect(marks).toHaveLength(1);
      expect(marks[0]).toMatchObject({ stage: "mark_readback", reason: "readback_corrupt" });
      expect(records.filter((record) => record.kind === "lab-send-attempt")).toEqual([]); // 零发送边界日志
      // 读回对象确为"已知字段、身份匹配、仅大小超限"——拒绝来自读回大小检查，
      // 不是身份不匹配或未知键白名单。
      const tampered = world.memory[LAB_CONTROL_MEMORY_KEY] as Record<string, unknown>;
      expect(tampered).toMatchObject({
        experimentId: LAB_EXAMPLE_EXPERIMENT.experimentId,
        attempted: true,
        attemptedTick: LAB_EXAMPLE_EXPERIMENT.targetTick,
      });
      expect(Object.keys(tampered).sort()).toEqual(
        ["armed", "attempted", "attemptedTick", "experimentId", "syncResult"].sort(),
      );
      // 后续 loop 的 gate 读取同一超限记录——控制读取阶段拒绝（先于 already_stopped 暴露大小问题）。
      expect(
        records.filter((record) => record.kind === "lab-precondition-rejection").map((record) => record.reason),
      ).toEqual(["control_record_corrupt", "control_record_corrupt"]);
    } finally {
      world.restore();
    }
  });
});
