import * as canonicalHash from "@/runtime/marketDirectContinuousPolicy";
import { getTreasuryService } from "@/runtime/runtimeServices";
import { enableTreasuryContinuousOH, normalizeTreasuryContinuousOHControl } from "@/runtime/treasuryContinuousOHControl";
import { readTreasuryContinuousOHState, treasuryContinuousOHStatePayload, writeTreasuryContinuousOHState } from "@/runtime/treasuryContinuousOHState";
import { treasuryContinuousOHDataToken, treasuryContinuousOHJSONBytes } from "@/runtime/treasuryContinuousOHDataTree";
import { treasuryT1SerializedBytes } from "@/runtime/treasuryFirstLiveState";
import { hasTreasuryTerminalFence } from "@/runtime/treasuryTaskCommitmentBridge";
import { beginTreasuryProductionTick, endTreasuryProductionTick, registerTreasuryProductionTerminalTransfer,
  runTreasuryTerminalTransferTask } from "@/runtime/treasuryTerminalTransfer";
import { initializeT4, applyLatestT4Native, t4CanonicalTask, t4Ledger, T4_SOURCE, type T4Fixture } from "../../test/treasuryT4Fixture";

describe("T4完整数据指纹只复用纯valid结论", () => {
  let context: T4Fixture;
  let clock: jest.SpyInstance;
  let startMs: number;
  beforeAll(() => expect(registerTreasuryProductionTerminalTransfer()).toBe(true));
  beforeEach(() => {
    startMs = Date.now(); clock = jest.spyOn(Date, "now").mockReturnValue(startMs);
    context = initializeT4(undefined); context.treasury = getTreasuryService();
  });
  afterEach(() => { endTreasuryProductionTick(); jest.restoreAllMocks(); });

  function state() {
    const read = readTreasuryContinuousOHState();
    if (read.status !== "valid") throw Error("需要真实合法账本");
    return read.value;
  }
  function tick(tick: number) {
    Game.time = tick; clock.mockReturnValue(startMs + (tick - 100) * 1000);
    beginTreasuryProductionTick();
    try { return runTreasuryTerminalTransferTask(t4CanonicalTask(context), t4Ledger(context), true, jest.fn()); }
    finally { endTreasuryProductionTick(); }
  }
  function enable() {
    expect(enableTreasuryContinuousOH({ pilotTaskId: context.task.id,
      pilotTaskCreatedAt: context.task.createdAt, pilotTaskAmount: context.task.amount }).ok).toBe(true);
  }
  function completePilot() {
    enable();
    for (const at of [100, 150, 200]) {
      tick(at); applyLatestT4Native(context);
      for (let n = 1; n <= 12; n += 1) tick(at + n);
    }
    expect(state().consumption.map((row) => row.amount)).toEqual([10, 10, 6]);
    expect(state().closedCycles.every((row) => row.ring?.generation === 1)).toBe(true);
  }
  function rawBook(mirror = false): Record<string, any> {
    // 正常book已deepimmutable；坏态必须作为新的mutable root真实替换，不能掩去破坏。
    const runtime = Memory.runtime as unknown as Record<string, any>;
    const key = mirror ? "treasuryContinuousOHMirror" : "treasuryContinuousOH";
    const replacement = JSON.parse(JSON.stringify(runtime[key])); runtime[key] = replacement;
    return replacement;
  }

  it("一次完整校验供同字节主镜像与重复读取复用，换Game/Memory归属必须重验", () => {
    completePilot();
    (global as any).Memory = JSON.parse(JSON.stringify(Memory));
    const hash = jest.spyOn(canonicalHash, "canonicalStableHashV1");
    expect(readTreasuryContinuousOHState().status).toBe("valid");
    expect(hash).toHaveBeenCalledTimes(1);
    for (let n = 0; n < 20; n += 1) expect(readTreasuryContinuousOHState().status).toBe("valid");
    Game.time += 1; expect(readTreasuryContinuousOHState().status).toBe("valid");
    expect(hash).toHaveBeenCalledTimes(1);
    (global as any).Game = { ...Game };
    expect(readTreasuryContinuousOHState().status).toBe("valid"); expect(hash).toHaveBeenCalledTimes(2);
    (global as any).Memory = JSON.parse(JSON.stringify(Memory));
    expect(readTreasuryContinuousOHState().status).toBe("valid"); expect(hash).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])("同tick暖缓存后%s侧新root历史改值立刻invalid，不能凭旧proof发布", (mirror) => {
    completePilot(); const before = state();
    expect(hasTreasuryTerminalFence(T4_SOURCE)).toBe(false);
    rawBook(mirror).consumption[0].amount += 1;
    const damaged = JSON.stringify(Memory);
    expect(readTreasuryContinuousOHState().status).toBe("invalid");
    expect(hasTreasuryTerminalFence(T4_SOURCE)).toBe(true);
    expect(writeTreasuryContinuousOHState(treasuryContinuousOHStatePayload(before))).toBe(false);
    expect(JSON.stringify(Memory)).toBe(damaged);
  });

  it.each(["nonenum_extra", "nonenum_known", "nonenum_index", "getter", "symbol", "array_extra", "hole", "cycle", "prototype", "toJSON"])(
    "暖valid/cache clear后%s非JSON变更即时held且不调用getter或toJSON", (kind) => {
      completePilot(); state(); expect(hasTreasuryTerminalFence(T4_SOURCE)).toBe(false);
      const book = rawBook(true); const callback = jest.fn(() => book.policy.sliceAmount);
      const json = JSON.stringify(book);
      if (kind === "nonenum_extra") Object.defineProperty(book.consumption[0], "hidden", { value: 1, enumerable: false });
      if (kind === "nonenum_known") Object.defineProperty(book.policy, "sliceAmount", { value: 10, enumerable: false });
      if (kind === "nonenum_index") Object.defineProperty(book.closedCycles, "0", { value: book.closedCycles[0], enumerable: false });
      if (kind === "getter") Object.defineProperty(book.policy, "sliceAmount", { get: callback, enumerable: true });
      if (kind === "symbol") book.closedCycles[0][Symbol("hidden")] = 1;
      if (kind === "array_extra") book.closedCycles.extra = undefined;
      if (kind === "hole") delete book.consumption[0];
      if (kind === "cycle") book.policy.loop = book.policy;
      if (kind === "prototype") Object.setPrototypeOf(book.policy, { hidden: 1 });
      if (kind === "toJSON") book.policy.toJSON = callback;
      if (["nonenum_extra", "symbol", "array_extra", "prototype"].includes(kind)) expect(JSON.stringify(book)).toBe(json);
      expect(readTreasuryContinuousOHState().status).toBe("invalid");
      expect(hasTreasuryTerminalFence(T4_SOURCE)).toBe(true);
      expect(callback).not.toHaveBeenCalled();
    },
  );

  it("两本等长原地改同一历史值也不能复用旧hash/length/ref，fresh native保持零调用", () => {
    enable(); state();
    for (const mirror of [false, true]) rawBook(mirror).policy.lifetimeOH -= 1;
    expect(readTreasuryContinuousOHState().status).toBe("invalid");
    expect(tick(100).handled).toBe(true);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it("合法发布新高水位只完整校验新book一次，读回严格字节相等且随后只复用数学结论", () => {
    completePilot(); const before = state();
    const hash = jest.spyOn(canonicalHash, "canonicalStableHashV1");
    Game.time += 1; clock.mockReturnValue(startMs + 113_000);
    expect(writeTreasuryContinuousOHState(treasuryContinuousOHStatePayload(before))).toBe(true);
    expect(hash).toHaveBeenCalledTimes(2); // seal + 新字节的完整valid；镜像/读回不再重复hash。
    const read = state();
    expect(read.lastObservedAtTick).toBe(213);
    expect(read.closedCycles).toEqual(before.closedCycles); expect(read.consumption).toEqual(before.consumption);
    for (let n = 0; n < 10; n += 1) state();
    expect(hash).toHaveBeenCalledTimes(2);
  });

  it("读token零业务Memory写，已校验JSON的UTF-8字节与原硬门口径一致", () => {
    enable(); const before = JSON.stringify(Memory);
    state(); state(); expect(JSON.stringify(Memory)).toBe(before);
    const payload = { reason: "中文🚀", bytes: 10 };
    const token = treasuryContinuousOHDataToken(payload);
    expect(token).not.toBeNull(); expect(treasuryContinuousOHJSONBytes(token!)).toBe(treasuryT1SerializedBytes(payload));
  });

  it("mirror半写加入隐藏未知责任后抛错，回滚不得删除未知字段或恢复成valid", () => {
    enable(); const before = state();
    const runtime = Memory.runtime as unknown as Record<string, any>;
    let mirror = runtime.treasuryContinuousOHMirror; let writes = 0;
    // 出版根键仍是正常数据descriptor；仅写入时模拟宿主半写为新的unknown tree。
    (Memory as any).runtime = new Proxy(runtime, {
      set(target, key, value) {
        if (key !== "treasuryContinuousOHMirror") return Reflect.set(target, key, value);
        writes += 1; mirror = JSON.parse(JSON.stringify(value));
        Object.defineProperty(mirror, "hiddenUnknownResponsibility", { value: { unknown: true }, configurable: true });
        Reflect.set(target, key, mirror); throw Error("mirror半写并出现未知责任");
      },
    });
    Game.time += 1; clock.mockReturnValue(startMs + 1000);
    expect(writeTreasuryContinuousOHState(treasuryContinuousOHStatePayload(before))).toBe(false);
    expect(writes).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(mirror, "hiddenUnknownResponsibility")).toBe(true);
    expect(readTreasuryContinuousOHState().status).toBe("invalid");
    expect(hasTreasuryTerminalFence(T4_SOURCE)).toBe(true);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it("两独立root可发布同一deepimmutable值，原地赋值被拒且JSON事实不变", () => {
    completePilot(); const runtime = Memory.runtime as unknown as Record<string, any>;
    const primary = runtime.treasuryContinuousOH;
    expect(primary).toBe(runtime.treasuryContinuousOHMirror);
    expect(Object.isFrozen(primary)).toBe(true); expect(Object.isFrozen(primary.consumption[0])).toBe(true);
    const before = JSON.stringify(Memory);
    expect(Reflect.set(primary.consumption[0], "amount", 11)).toBe(false);
    expect(Reflect.set(primary.closedCycles[0].cycle.quota, "amount", 11)).toBe(false);
    expect(JSON.stringify(Memory)).toBe(before); expect(readTreasuryContinuousOHState().status).toBe("valid");
  });

  it("未证mutable/仅shallowFrozen的新root不能memo token，后代变更仍即时invalid", () => {
    completePilot(); const replacement = rawBook(true); Object.freeze(replacement);
    const first = treasuryContinuousOHDataToken(replacement);
    replacement.consumption[0].amount += 1;
    expect(treasuryContinuousOHDataToken(replacement)).not.toBe(first);
    expect(readTreasuryContinuousOHState().status).toBe("invalid"); expect(hasTreasuryTerminalFence(T4_SOURCE)).toBe(true);
  });

  it.each([Object.prototype, Array.prototype])("cached深冻结树仍拒绝prototype新增toJSON且getter零调用", (prototype) => {
    completePilot(); const callback = jest.fn(() => ({}));
    Object.defineProperty(prototype, "toJSON", { get: callback, configurable: true });
    try {
      expect(readTreasuryContinuousOHState().status).toBe("invalid");
      expect(hasTreasuryTerminalFence(T4_SOURCE)).toBe(true); expect(callback).not.toHaveBeenCalled();
    } finally { delete (prototype as Record<string, unknown>).toJSON; }
  });

  it("同tick多次正常维护只pub一次，wall先升后回退仍停止且durable保峰值", () => {
    completePilot(); Game.time = 213; clock.mockReturnValue(startMs + 113_000);
    expect(normalizeTreasuryContinuousOHControl().ok).toBe(true);
    const afterFirst = state(); const primary = (Memory.runtime as any).treasuryContinuousOH;
    for (let n = 1; n <= 5; n += 1) {
      clock.mockReturnValue(startMs + 113_000 + n);
      expect(normalizeTreasuryContinuousOHControl().ok).toBe(true);
      expect((Memory.runtime as any).treasuryContinuousOH).toBe(primary);
    }
    expect(state().lastObservedAtMs).toBe(afterFirst.lastObservedAtMs);
    clock.mockReturnValue(startMs + 113_001);
    normalizeTreasuryContinuousOHControl();
    expect(state().stopReason).toBe("clock_regressed");
    expect(state().lastObservedAtMs).toBeGreaterThanOrEqual(startMs + 113_005);
    expect(state().deadlineMs).toBe(afterFirst.deadlineMs); expect(state().consumption).toEqual(afterFirst.consumption);
  });

  it("warm immutable书的root accessor也属于bad形状，不能调用getter或复用clear", () => {
    completePilot(); expect(hasTreasuryTerminalFence(T4_SOURCE)).toBe(false);
    const runtime = Memory.runtime as unknown as Record<string, any>;
    const good = runtime.treasuryContinuousOHMirror; const getter = jest.fn(() => good);
    Object.defineProperty(runtime, "treasuryContinuousOHMirror", { get: getter, enumerable: true, configurable: true });
    expect(readTreasuryContinuousOHState().status).toBe("invalid");
    expect(hasTreasuryTerminalFence(T4_SOURCE)).toBe(true); expect(getter).not.toHaveBeenCalled();
  });

  it("真实unknown原责任在wall不变的新tick仍发布tick高水位，cold reset回退tick被拒", () => {
    enable(); tick(100); expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
    // native未应用receipt，保持真实unknown原attempt，不能补发。
    Game.time = 101; clock.mockReturnValue(startMs);
    normalizeTreasuryContinuousOHControl();
    expect(state().lastObservedAtTick).toBe(101);
    const history = state().consumption;
    (global as any).Memory = JSON.parse(JSON.stringify(Memory));
    Game.time = 100; normalizeTreasuryContinuousOHControl();
    expect(state().stopReason).toBe("clock_regressed"); expect(state().lastObservedAtTick).toBe(101);
    expect(state().consumption).toEqual(history); expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
  });

  it("ownBook有效但kernel坏态的失败held也耐久新tick高水位，失败结论不变", () => {
    completePilot(); Game.time = 213; clock.mockReturnValue(startMs + 113_000);
    const runtime = Memory.runtime as unknown as Record<string, any>; runtime.treasuryCore = { schemaVersion: -1 };
    const result = normalizeTreasuryContinuousOHControl(); expect(result.ok).toBe(false);
    expect(result.reason).toBe("kernel_or_uncertified_history_held");
    expect(state().lastObservedAtTick).toBe(213); expect(context.source.terminal!.send).toHaveBeenCalledTimes(3);
  });

  it("正常work后的finalizer时钟抛错仍闭成failed+drain，不向main逃异常", () => {
    completePilot(); Game.time = 213;
    clock.mockImplementationOnce(() => startMs + 113_000).mockImplementationOnce(() => { throw Error("finalizer clock unavailable"); });
    expect(normalizeTreasuryContinuousOHControl()).toEqual({ ok: false, reason: "control_normalization_failed" });
    expect((Memory.cfg as any).treasuryTerminalTransferT4.mode).toBe("drain");
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(3);
  });
});
