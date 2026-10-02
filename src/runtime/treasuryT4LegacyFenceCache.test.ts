import * as canonicalHash from "@/runtime/marketDirectContinuousPolicy";
import { createTreasuryFirstLiveState, type Control, type Payload } from "@/runtime/treasuryFirstLiveState";
import { readTreasuryTerminalControl, readTreasuryTerminalFenceControl } from "@/runtime/treasuryTerminalControl";
import { hasTreasuryTerminalFence, hasTreasuryT1TerminalFence } from "@/runtime/treasuryTaskCommitmentBridge";
import { TREASURY_T1_LANE, TREASURY_T2_LANE, TREASURY_T3_LANE,
  type TreasuryTerminalLane } from "@/runtime/treasuryTerminalLane";
import { initializeT2 } from "../../test/treasuryT2Fixture";

const OLD_LANES = [TREASURY_T1_LANE, TREASURY_T2_LANE, TREASURY_T3_LANE];
const START_MS = 1_800_000_000_000;
let fixtureSequence = 0;

function payload(lane: TreasuryTerminalLane): Payload {
  return {
    schemaVersion: 1, runId: lane.controlRunId, status: "closed",
    startedAtTick: 100, deadlineTick: 700, startedAtMs: START_MS, deadlineMs: START_MS + 30 * 60_000,
    lastHeartbeatAtMs: START_MS, controlUntilMs: START_MS + 60_000,
    taskId: `legacy-fence-${fixtureSequence}-${lane.name}`, taskCreatedAt: 90,
    taskAmount: 100, taskRemainingAtArm: 100,
    sourceTerminalId: `${lane.sourceRoom}-terminal`, targetTerminalId: `${lane.targetRoom}-terminal`,
    deployTag: "legacy-fence-test", deployBundleHash: "legacy-fence-test-bundle", closeReason: "test_closed",
    ...(lane.demandBoundedSlice ? { maxSliceAmount: 26 } : {}),
  };
}

function runtime(): Record<string, any> { return Memory.runtime as unknown as Record<string, any>; }
function raw(lane = TREASURY_T2_LANE, mirror = false): Control {
  return runtime()[mirror ? lane.controlMirrorKey : lane.controlKey];
}
function publish(lane: TreasuryTerminalLane, fields = payload(lane)): void {
  const sealed = createTreasuryFirstLiveState(lane).seal(fields);
  runtime()[lane.controlKey] = { ...sealed };
  runtime()[lane.controlMirrorKey] = { ...sealed };
}

describe("旧 T1/T2/T3 cargo control 只缓存完整 POD 字节的数学证明", () => {
  beforeEach(() => {
    fixtureSequence += 1; initializeT2();
    for (const lane of OLD_LANES) publish(lane);
  });
  afterEach(() => jest.restoreAllMocks());

  it("100 次真实公开 fence query 的 600 次旧本验签降至三个 unique token，各次 native read 仍验两本", () => {
    const hash = jest.spyOn(canonicalHash, "canonicalStableHashV1");
    for (let index = 0; index < 100; index += 1) {
      expect(hasTreasuryTerminalFence(index % 2 === 0 ? "E4N58" : "E1N57")).toBe(false);
    }
    expect(hash).toHaveBeenCalledTimes(3);
    hash.mockClear();
    for (let index = 0; index < 100; index += 1) {
      for (const lane of OLD_LANES) expect(readTreasuryTerminalControl(lane).status).toBe("valid");
    }
    expect(hash).toHaveBeenCalledTimes(600);
  });

  it("完整 POD 字节相同的 replacement 可以复用数学证明，旧 raw 保持可变而结果为当次只读 copy", () => {
    const before = JSON.stringify(Memory);
    const first = readTreasuryTerminalFenceControl(TREASURY_T2_LANE);
    expect(first.status).toBe("valid");
    if (first.status !== "valid") throw Error("需要合法旧控制快照");
    expect(first.value).not.toBe(raw()); expect(Object.isFrozen(first.value)).toBe(true);
    expect(Object.isFrozen(raw())).toBe(false); expect(Reflect.set(first.value, "taskAmount", 101)).toBe(false);
    expect(JSON.stringify(Memory)).toBe(before);
    const hash = jest.spyOn(canonicalHash, "canonicalStableHashV1");
    runtime()[TREASURY_T2_LANE.controlMirrorKey] = { ...raw(TREASURY_T2_LANE, true) };
    const next = readTreasuryTerminalFenceControl(TREASURY_T2_LANE);
    expect(next.status).toBe("valid"); expect(hash).not.toHaveBeenCalled();
    if (next.status !== "valid") throw Error("需要合法 replacement 快照");
    expect(next.value).not.toBe(first.value);
    raw().taskAmount = 101; raw(TREASURY_T2_LANE, true).taskAmount = 101;
    expect(readTreasuryTerminalFenceControl(TREASURY_T2_LANE).status).toBe("invalid");
    expect(first.value.taskAmount).toBe(100); expect(hasTreasuryTerminalFence("E1N57")).toBe(true);
  });

  it.each(["extra", "hidden", "hidden_known", "getter", "symbol", "toJSON", "prototype", "array"])(
    "暖证明后 %s 变更仍逐字段 fresh 检查，getter / toJSON 零调用", (kind) => {
      expect(hasTreasuryTerminalFence("E1N57")).toBe(false);
      const book = raw(TREASURY_T2_LANE, true) as unknown as Record<string, any>;
      const callback = jest.fn(() => book.taskAmount);
      if (kind === "extra") book.extra = true;
      if (kind === "hidden") Object.defineProperty(book, "hidden", { value: true });
      if (kind === "hidden_known") Object.defineProperty(book, "taskAmount", { enumerable: false });
      if (kind === "getter") Object.defineProperty(book, "taskAmount", { get: callback, enumerable: true });
      if (kind === "symbol") book[Symbol("unknown") as any] = true;
      if (kind === "toJSON") book.toJSON = callback;
      if (kind === "prototype") Object.setPrototypeOf(book, { hidden: true });
      if (kind === "array") runtime()[TREASURY_T2_LANE.controlMirrorKey] = Object.values(book);
      expect(readTreasuryTerminalFenceControl(TREASURY_T2_LANE).status).toBe("invalid");
      expect(hasTreasuryTerminalFence("E1N57")).toBe(true); expect(callback).not.toHaveBeenCalled();
    },
  );

  it.each(["getter", "hidden", "inherited"])("控制根 slot %s 不借旧数学证明且不执行未知 getter", (kind) => {
    expect(hasTreasuryTerminalFence("E1N57")).toBe(false);
    const before = raw();
    const callback = jest.fn(() => before);
    if (kind === "getter") Object.defineProperty(runtime(), TREASURY_T2_LANE.controlKey,
      { get: callback, enumerable: true, configurable: true });
    if (kind === "hidden") Object.defineProperty(runtime(), TREASURY_T2_LANE.controlKey,
      { value: before, enumerable: false, configurable: true });
    if (kind === "inherited") {
      delete runtime()[TREASURY_T2_LANE.controlKey];
      Object.setPrototypeOf(runtime(), { [TREASURY_T2_LANE.controlKey]: before });
    }
    expect(createTreasuryFirstLiveState(TREASURY_T2_LANE).readControlForFence().status).toBe("invalid");
    expect(hasTreasuryTerminalFence("E1N57")).toBe(true); expect(callback).not.toHaveBeenCalled();
  });

  it("runtime 根 getter 不执行；ForFence 自己也检查 owner slot", () => {
    const root = runtime(); const callback = jest.fn(() => root);
    Object.defineProperty(Memory, "runtime", { get: callback, enumerable: true, configurable: true });
    try {
      expect(createTreasuryFirstLiveState(TREASURY_T2_LANE).readControlForFence().status).toBe("invalid");
      expect(callback).not.toHaveBeenCalled();
    } finally { Object.defineProperty(Memory, "runtime", { value: root, enumerable: true, writable: true, configurable: true }); }
  });

  it.each([Object.prototype, Array.prototype])("暖 POD 证明也拒绝 prototype 新增 toJSON getter，原输入不受冻结改写", (prototype) => {
    expect(readTreasuryTerminalFenceControl(TREASURY_T2_LANE).status).toBe("valid");
    const callback = jest.fn(() => ({}));
    Object.defineProperty(prototype, "toJSON", { get: callback, configurable: true });
    try {
      expect(readTreasuryTerminalFenceControl(TREASURY_T2_LANE).status).toBe("invalid");
      expect(callback).not.toHaveBeenCalled(); expect(Object.isFrozen(raw())).toBe(false);
    } finally { delete (prototype as Record<string, unknown>).toJSON; }
  });

  it.each(["schema", "hash", "math"])("两本同步 %s 变化不能凭旧hash/ref命中成功", (kind) => {
    expect(hasTreasuryTerminalFence("E1N57")).toBe(false);
    if (kind === "math") publish(TREASURY_T2_LANE, { ...payload(TREASURY_T2_LANE), deadlineTick: 701 });
    else for (const mirror of [false, true]) {
      const book = raw(TREASURY_T2_LANE, mirror) as unknown as Record<string, any>;
      if (kind === "schema") book.schemaVersion = 2;
      else book.hash = "csh1:00000000000000000000000000000000";
    }
    expect(readTreasuryTerminalFenceControl(TREASURY_T2_LANE).status).toBe("invalid");
    expect(hasTreasuryTerminalFence("E1N57")).toBe(true);
  });

  it.each(["taskId", "sourceTerminalId", "targetTerminalId", "deployTag", "deployBundleHash", "closeReason",
    "runId", "status", "hash", "schemaVersion"])("超长 / 错 scalar %s 在构造 JSON token 前拒绝，故障查询不分配巨型字符串", (field) => {
      expect(readTreasuryTerminalFenceControl(TREASURY_T2_LANE).status).toBe("valid");
      for (const mirror of [false, true]) (raw(TREASURY_T2_LANE, mirror) as unknown as Record<string, unknown>)[field] = "x".repeat(4_096);
      const stringify = jest.spyOn(JSON, "stringify");
      expect(readTreasuryTerminalFenceControl(TREASURY_T2_LANE).status).toBe("invalid");
      expect(stringify).not.toHaveBeenCalled();
    },
  );

  it("主镜像仍要求原 JSON 字节顺序一致，不以 canonical hash 相同替代出版一致", () => {
    expect(readTreasuryTerminalFenceControl(TREASURY_T2_LANE).status).toBe("valid");
    const mirror = raw(TREASURY_T2_LANE, true);
    runtime()[TREASURY_T2_LANE.controlMirrorKey] = Object.fromEntries(Object.entries(mirror).reverse());
    expect(readTreasuryTerminalControl(TREASURY_T2_LANE).status).toBe("invalid");
    expect(readTreasuryTerminalFenceControl(TREASURY_T2_LANE).status).toBe("invalid");
  });

  it("lane 对象相同但摘要 domain 改变，不能借原 domain 的成功 token", () => {
    const lane = { ...TREASURY_T1_LANE }; const state = createTreasuryFirstLiveState(lane);
    expect(state.readControlForFence().status).toBe("valid");
    (lane as unknown as { name: string }).name = "T2";
    expect(state.readControlForFence().status).toBe("invalid");
    expect(readTreasuryTerminalFenceControl(TREASURY_T1_LANE).status).toBe("valid");
  });

  it("Array prototype 的恒定 toJSON 不执行，不能把跨 domain 身份压成同一 token", () => {
    const lane = { ...TREASURY_T1_LANE }; const state = createTreasuryFirstLiveState(lane);
    expect(state.readControlForFence().status).toBe("valid");
    const callback = jest.fn(() => "constant-identity");
    Object.defineProperty(Array.prototype, "toJSON", { value: callback, configurable: true });
    try {
      expect(state.readControlForFence().status).toBe("invalid");
      (lane as unknown as { name: string }).name = "T2";
      expect(state.readControlForFence().status).toBe("invalid"); expect(callback).not.toHaveBeenCalled();
    } finally { delete (Array.prototype as unknown as Record<string, unknown>).toJSON; }
  });

  it("每 lane 只保留四个数学身份，第五个合法版本后再次读最旧版本必须重验", () => {
    const lane = TREASURY_T1_LANE; const state = createTreasuryFirstLiveState(lane);
    const versions = Array.from({ length: 5 }, (_, index) => state.seal({ ...payload(lane),
      taskId: `bounded-legacy-fence-${fixtureSequence}-${index}` }));
    const hash = jest.spyOn(canonicalHash, "canonicalStableHashV1");
    const install = (book: Control) => {
      runtime()[lane.controlKey] = { ...book }; runtime()[lane.controlMirrorKey] = { ...book };
      expect(readTreasuryTerminalFenceControl(lane).status).toBe("valid");
    };
    for (const book of versions) install(book);
    expect(hash).toHaveBeenCalledTimes(5);
    install(versions[0]); expect(hash).toHaveBeenCalledTimes(6);
  });

  it("foreign control 坏态不扩大直接 T1 scope，fresh quota 坏态仍持住全部相关 lane", () => {
    expect(hasTreasuryT1TerminalFence()).toBe(false);
    Object.defineProperty(raw(TREASURY_T2_LANE, true), "hidden", { value: true });
    expect(hasTreasuryTerminalFence("E1N57")).toBe(true); expect(hasTreasuryT1TerminalFence()).toBe(false);
    runtime()[TREASURY_T2_LANE.quotaKey] = { schemaVersion: -1 };
    expect(hasTreasuryT1TerminalFence()).toBe(true);
  });
});
