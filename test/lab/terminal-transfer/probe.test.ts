/**
 * Terminal Transfer Engine Lab Prep I——探针离线自测（任务书 §4.4；P03/P04）。
 *
 * 在本地 stub/spy 注入的 Game/Memory/Terminal API 上执行**同一源码构建出的
 * 两个真实入口产物**（beforeAll 实际调用构建器到独立临时目录，再 require
 * 产物——不是只检查源码字符串）。这里的"send 调用 1 次"只指 spy 调用，
 * 不是真实游戏经济动作；stub 的 send 返回 OK 时不修改库存、不给交易视图
 * 填记录，后续显式切换"后续 tick 观察 fixture"验证观察器报告输入差异。
 *
 * 该测试只证明包装与采样正确，不证明引擎真的这样运行（真实引擎边界
 * PREPARED_NOT_RUN，见实验交接说明）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LAB_EXAMPLE_EXPERIMENT } from "./labConfig";
import { LAB_CONTROL_MEMORY_KEY } from "./controlRecord";

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
    send(resourceType: unknown, amount: unknown, destination: unknown, description: unknown): number {
      sendCalls.push({ self: this, args: [resourceType, amount, destination, description] });
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
});
