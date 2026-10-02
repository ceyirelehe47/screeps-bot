import * as canonicalHash from "@/runtime/marketDirectContinuousPolicy";
import { getTreasuryService } from "@/runtime/runtimeServices";
import { enableTreasuryContinuousOH } from "@/runtime/treasuryContinuousOHControl";
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
    return (Memory.runtime as unknown as Record<string, any>)[mirror ? "treasuryContinuousOHMirror" : "treasuryContinuousOH"];
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

  it.each([false, true])("同tick暖缓存后%s侧历史原地改值立刻invalid，不能凭旧proof发布", (mirror) => {
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
    let mirror = rawBook(true); let writes = 0;
    Object.defineProperty(runtime, "treasuryContinuousOHMirror", {
      enumerable: true, configurable: true, get: () => mirror,
      set(value) {
        writes += 1; mirror = value;
        if (writes === 1) {
          Object.defineProperty(mirror, "hiddenUnknownResponsibility", { value: { unknown: true }, configurable: true });
          throw Error("mirror半写并出现未知责任");
        }
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
});
