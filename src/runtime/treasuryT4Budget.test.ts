import {
  TREASURY_CONTINUOUS_OH_HARD_BOUNDS as HARD_BOUNDS,
  normalizeTreasuryContinuousOHPolicy,
  checkTreasuryContinuousOHBudget,
  validateTreasuryContinuousOHBudget,
  summarizeTreasuryContinuousOHBudget,
  type TreasuryContinuousOHPolicy,
  type TreasuryContinuousOHConsumption,
} from "@/runtime/treasuryContinuousOHBudget";
import {
  enableTreasuryContinuousOH, normalizeTreasuryContinuousOHControl, writeTreasuryContinuousOHQuota,
  acceptTreasuryContinuousOHPilot, stopTreasuryContinuousOH, createTreasuryContinuousOHControl,
} from "@/runtime/treasuryContinuousOHControl";
import {
  PRIMARY, MIRROR, CONTINUOUS_RUN_ID, readTreasuryContinuousOHState, treasuryContinuousOHWorkKey,
  type TreasuryContinuousOHState,
} from "@/runtime/treasuryContinuousOHState";
import type { TreasuryT1Quota } from "@/runtime/treasuryTerminalResponsibility";
import { treasuryT1SerializedBytes } from "@/runtime/treasuryFirstLiveState";
import { initializeT4, setT4Missing } from "../../test/treasuryT4Fixture";

const DAY = 86_400_000;
const ENABLED_MS = 1_800_000_000_000;
const ENABLED_TICK = 100;

function policy(overrides: Partial<TreasuryContinuousOHPolicy> = {}): TreasuryContinuousOHPolicy {
  const result = normalizeTreasuryContinuousOHPolicy({ sliceAmount: 26, ...overrides });
  if (result.ok === false) throw Error(`测试 policy 被拒绝: ${result.reason}`);
  return result.policy;
}

/** 所有正常消费都先通过公开 budget gate，再追加该次 native 预扣。
 * 这里不写 Memory，不生成/仿造 control 签名，也不把数学单元证据当 native 证据。 */
function charge(
  history: TreasuryContinuousOHConsumption[],
  options: { amount?: number; fee?: number; tick?: number; ms?: number; sequence?: number } = {},
  bounds = policy(),
): TreasuryContinuousOHConsumption {
  const sequence = options.sequence ?? history.length + 1;
  const tick = options.tick ?? ENABLED_TICK + (sequence - 1) * 50;
  const ms = options.ms ?? ENABLED_MS + (sequence - 1) * 150_000;
  const amount = options.amount ?? 1;
  const fee = options.fee ?? 0;
  expect(checkTreasuryContinuousOHBudget(bounds, history, ENABLED_MS, ms, tick, amount, fee).ok).toBe(true);
  const entry: TreasuryContinuousOHConsumption = {
    sequence, attemptId: `budget-legal-attempt-${sequence}`, amount, fee, atTick: tick, atMs: ms,
    epoch: Math.floor((ms - ENABLED_MS) / DAY),
  };
  history.push(entry);
  expect(validateTreasuryContinuousOHBudget(bounds, history, ENABLED_MS, ENABLED_TICK, sequence)).toBe(true);
  return entry;
}

describe("T4 公开预算 gate 的固定边界", () => {
  it("hard policy固定26/260/100/30与780/300/90/128/50，默认计划slice10", () => {
    expect(HARD_BOUNDS).toEqual({ sliceAmount: 26, rolling24hOH: 260, rolling24hEnergy: 100,
      rolling24hNativeCalls: 30, lifetimeOH: 780, lifetimeEnergy: 300, lifetimeNativeCalls: 90,
      maxPrepareCycles: 128, minNativeIntervalTicks: 50 });
    expect(policy()).toEqual(HARD_BOUNDS);
    expect(normalizeTreasuryContinuousOHPolicy()).toEqual({ ok: true, policy: { ...HARD_BOUNDS, sliceAmount: 10 } });
    expect(validateTreasuryContinuousOHBudget(policy(), [], ENABLED_MS, ENABLED_TICK, 0)).toBe(true);
  });

  it.each(["sliceAmount", "rolling24hOH", "rolling24hEnergy", "rolling24hNativeCalls", "lifetimeOH",
    "lifetimeEnergy", "lifetimeNativeCalls", "maxPrepareCycles"] as const)("拒绝放宽 %s", (key) => {
    expect(normalizeTreasuryContinuousOHPolicy({ [key]: HARD_BOUNDS[key] + 1 }).ok).toBe(false);
  });

  it("native 最小间隔可以更保守，不能由 50 降到 49", () => {
    expect(normalizeTreasuryContinuousOHPolicy({ minNativeIntervalTicks: 49 }).ok).toBe(false);
    expect(policy({ minNativeIntervalTicks: 100 }).minNativeIntervalTicks).toBe(100);
  });

  it.each([0, -1, 1.5, NaN, Infinity])("拒绝非法 slice policy %s", (sliceAmount) => {
    expect(normalizeTreasuryContinuousOHPolicy({ sliceAmount }).ok).toBe(false);
  });

  it("配置只接受已命名policy字段，异常getter/proxy失败closed", () => {
    expect(normalizeTreasuryContinuousOHPolicy({ resetBudget: true } as Partial<TreasuryContinuousOHPolicy>).ok).toBe(false);
    const getter = Object.defineProperty({}, "sliceAmount", { enumerable: true,
      get() { throw Error("读取坏policy"); } }) as Partial<TreasuryContinuousOHPolicy>;
    const proxy = new Proxy({}, { ownKeys() { throw Error("坏policy keys"); } }) as Partial<TreasuryContinuousOHPolicy>;
    expect(normalizeTreasuryContinuousOHPolicy(getter).ok).toBe(false);
    expect(normalizeTreasuryContinuousOHPolicy(proxy).ok).toBe(false);
  });

  it("硬 slice26 精确可用，27 在空 ledger 也被拒绝", () => {
    const history: TreasuryContinuousOHConsumption[] = [];
    charge(history, { amount: 26 });
    expect(checkTreasuryContinuousOHBudget(policy(), [], ENABLED_MS, ENABLED_MS, ENABLED_TICK, 27, 0).ok).toBe(false);
  });

  it("合法预扣累计到 window260OH 后，再1OH失败且历史不变", () => {
    const history: TreasuryContinuousOHConsumption[] = [];
    for (let index = 0; index < 10; index += 1) charge(history, { amount: 26 });
    const before = JSON.stringify(history);
    expect(checkTreasuryContinuousOHBudget(policy(), history, ENABLED_MS, ENABLED_MS + 2_000_000, 600, 1, 0).ok).toBe(false);
    expect(JSON.stringify(history)).toBe(before);
  });

  it("window100 fee 精确可用；之后fee1失败，fee0仍按其它剩余预算处理", () => {
    const history: TreasuryContinuousOHConsumption[] = [];
    charge(history, { fee: 100 });
    expect(checkTreasuryContinuousOHBudget(policy(), history, ENABLED_MS, ENABLED_MS + 150_000, 150, 1, 1).ok).toBe(false);
    charge(history, { fee: 0 });
    expect(history.map((entry) => entry.fee)).toEqual([100, 0]);
  });

  it("window 第30笔 native 可用，第31笔即使金额和fee充足也失败", () => {
    const history: TreasuryContinuousOHConsumption[] = [];
    for (let index = 0; index < 30; index += 1) charge(history);
    expect(checkTreasuryContinuousOHBudget(policy(), history, ENABLED_MS, ENABLED_MS + 5_000_000, 1_600, 1, 0).ok).toBe(false);
    expect(history).toHaveLength(30);
  });

  it("native 第49tick拒绝，第50tick精确通过", () => {
    const history: TreasuryContinuousOHConsumption[] = [];
    charge(history);
    expect(checkTreasuryContinuousOHBudget(policy(), history, ENABLED_MS, ENABLED_MS + 1_000, 149, 1, 0).ok).toBe(false);
    charge(history, { tick: 150, ms: ENABLED_MS + 2_000 });
  });

  it("enable 锚点的24h边界续窗，原消费仍进入lifetime且原history保留", () => {
    const history: TreasuryContinuousOHConsumption[] = [];
    charge(history, { amount: 26, fee: 100 });
    const original = JSON.stringify(history[0]);
    charge(history, { amount: 26, fee: 100, tick: 200, ms: ENABLED_MS + DAY });
    expect(history.map((entry) => entry.epoch)).toEqual([0, 1]);
    expect(history.reduce((sum, entry) => sum + entry.amount, 0)).toBe(52);
    expect(history.reduce((sum, entry) => sum + entry.fee, 0)).toBe(200);
    expect(JSON.stringify(history[0])).toBe(original);
    expect(summarizeTreasuryContinuousOHBudget(policy(), history, ENABLED_MS, ENABLED_MS + DAY)).toEqual({
      rolling24h: { oh: 26, energy: 100, nativeCalls: 1 },
      epoch24h: { index: 1, oh: 26, energy: 100, nativeCalls: 1 },
      lifetime: { oh: 52, energy: 200, nativeCalls: 2 }, lastNativeTick: 200,
    });
  });

  it("不能仅换epoch绕过紧邻边界前的24h OH消费", () => {
    const history: TreasuryContinuousOHConsumption[] = [];
    for (let index = 0; index < 10; index += 1) charge(history, {
      amount: 26, tick: 100 + index * 50, ms: ENABLED_MS + DAY - 1_000_000 + index * 50_000,
    });
    expect(checkTreasuryContinuousOHBudget(policy(), history, ENABLED_MS, ENABLED_MS + DAY, 600, 1, 0).ok).toBe(false);
  });

  it("三个合法窗口 lifetime780OH 不因第4窗口出现新额度", () => {
    const history: TreasuryContinuousOHConsumption[] = [];
    for (let epoch = 0; epoch < 3; epoch += 1) for (let index = 0; index < 10; index += 1) charge(history, {
      amount: 26, tick: 100 + history.length * 50, ms: ENABLED_MS + epoch * DAY + index * 150_000,
    });
    expect(history.reduce((sum, entry) => sum + entry.amount, 0)).toBe(780);
    expect(checkTreasuryContinuousOHBudget(policy(), history, ENABLED_MS, ENABLED_MS + 3 * DAY, 1_600, 1, 0).ok).toBe(false);
    expect(history).toHaveLength(30);
  });

  it("lifetime300 fee 在三窗口达到后，不能用window rollover获得fee301", () => {
    const history: TreasuryContinuousOHConsumption[] = [];
    for (let epoch = 0; epoch < 3; epoch += 1) charge(history, {
      fee: 100, tick: 100 + epoch * 50, ms: ENABLED_MS + epoch * DAY,
    });
    expect(history.reduce((sum, entry) => sum + entry.fee, 0)).toBe(300);
    expect(checkTreasuryContinuousOHBudget(policy(), history, ENABLED_MS, ENABLED_MS + 3 * DAY, 250, 1, 1).ok).toBe(false);
  });

  it("lifetime 第90笔可用，第91笔不借第4窗口绕过native总数", () => {
    const history: TreasuryContinuousOHConsumption[] = [];
    for (let epoch = 0; epoch < 3; epoch += 1) for (let index = 0; index < 30; index += 1) charge(history, {
      tick: 100 + history.length * 50, ms: ENABLED_MS + epoch * DAY + index * 150_000,
    });
    expect(history).toHaveLength(90);
    expect(checkTreasuryContinuousOHBudget(policy(), history, ENABLED_MS, ENABLED_MS + 3 * DAY, 4_600, 1, 0).ok).toBe(false);
  });

  it("prepare 高水位允许128，不把非native prep当新native消费，129非法", () => {
    const history: TreasuryContinuousOHConsumption[] = [];
    charge(history, { sequence: 128 });
    expect(validateTreasuryContinuousOHBudget(policy(), history, ENABLED_MS, ENABLED_TICK, 128)).toBe(true);
    expect(validateTreasuryContinuousOHBudget(policy(), history, ENABLED_MS, ENABLED_TICK, 129)).toBe(false);
    expect(validateTreasuryContinuousOHBudget(policy(), history, ENABLED_MS, ENABLED_TICK, 127)).toBe(false);
  });

  it("更紧的policy由相同gate强制，不能以hard cap替代已授予额度", () => {
    const bounds = policy({ sliceAmount: 10, rolling24hOH: 10, rolling24hEnergy: 2, rolling24hNativeCalls: 1 });
    const history: TreasuryContinuousOHConsumption[] = [];
    charge(history, { amount: 10, fee: 2 }, bounds);
    expect(checkTreasuryContinuousOHBudget(bounds, history, ENABLED_MS, ENABLED_MS + 150_000, 150, 1, 0).ok).toBe(false);
    expect(checkTreasuryContinuousOHBudget(bounds, [], ENABLED_MS, ENABLED_MS, 100, 11, 0).ok).toBe(false);
  });

  it.each([
    { amount: 0, fee: 0 }, { amount: -1, fee: 0 }, { amount: 1.5, fee: 0 },
    { amount: 1, fee: -1 }, { amount: 1, fee: 0.5 }, { amount: 1, fee: Infinity },
  ])("非法native输入在空ledger失败closed：%p", ({ amount, fee }) => {
    expect(checkTreasuryContinuousOHBudget(policy(), [], ENABLED_MS, ENABLED_MS, 100, amount, fee).ok).toBe(false);
  });

  it("当前时间不能早于enable或已记账native，当前tick不能倒退", () => {
    const history: TreasuryContinuousOHConsumption[] = [];
    charge(history, { tick: 200, ms: ENABLED_MS + 1_000 });
    expect(checkTreasuryContinuousOHBudget(policy(), [], ENABLED_MS, ENABLED_MS - 1, 100, 1, 0).ok).toBe(false);
    expect(checkTreasuryContinuousOHBudget(policy(), history, ENABLED_MS, ENABLED_MS + 999, 250, 1, 0).ok).toBe(false);
    expect(checkTreasuryContinuousOHBudget(policy(), history, ENABLED_MS, ENABLED_MS + 2_000, 199, 1, 0).ok).toBe(false);
  });

  it.each(["epoch", "amount", "fee", "sequence", "atTick", "atMs", "attemptId"] as const)(
    "坏消费字段%s不能成为可继续消费的合法ledger", (field) => {
      const history: TreasuryContinuousOHConsumption[] = [];
      charge(history);
      const malformed = history.map((entry) => ({ ...entry }));
      Object.assign(malformed[0], { [field]: field === "attemptId" ? "" : -1 });
      expect(validateTreasuryContinuousOHBudget(policy(), malformed, ENABLED_MS, ENABLED_TICK, 1)).toBe(false);
      expect(checkTreasuryContinuousOHBudget(policy(), malformed, ENABLED_MS, ENABLED_MS + 150_000, 150, 1, 0).ok).toBe(false);
    },
  );

  it("重复event identity或乱序消费不能被当作正常history", () => {
    const history: TreasuryContinuousOHConsumption[] = [];
    charge(history); charge(history);
    const duplicate = history.map((entry) => ({ ...entry }));
    duplicate[1].attemptId = duplicate[0].attemptId;
    expect(validateTreasuryContinuousOHBudget(policy(), duplicate, ENABLED_MS, ENABLED_TICK, 2)).toBe(false);
    expect(validateTreasuryContinuousOHBudget(policy(), [...history].reverse(), ENABLED_MS, ENABLED_TICK, 2)).toBe(false);
  });

  it("history完整序列只读检查，旧window不被summary/check删除", () => {
    const history: TreasuryContinuousOHConsumption[] = [];
    charge(history, { amount: 10, fee: 2 });
    const retained = Object.freeze(history.map((entry) => Object.freeze({ ...entry })));
    const before = JSON.stringify(retained);
    expect(checkTreasuryContinuousOHBudget(policy(), retained, ENABLED_MS, ENABLED_MS + DAY, 150, 10, 2).ok).toBe(true);
    expect(summarizeTreasuryContinuousOHBudget(policy(), retained, ENABLED_MS, ENABLED_MS + DAY).lifetime)
      .toEqual({ oh: 10, energy: 2, nativeCalls: 1 });
    expect(JSON.stringify(retained)).toBe(before);
  });

  it("消费额外字段/accessor/symbol/异常对象不能进入合法ledger", () => {
    const history: TreasuryContinuousOHConsumption[] = [];
    charge(history);
    const extra = { ...history[0], refund: true };
    const getter = Object.defineProperty({ ...history[0] }, "fee", { enumerable: true,
      get() { throw Error("坏fee"); } });
    const symbol = Object.assign({ ...history[0] }, { [Symbol("bad")]: true });
    const proxy = new Proxy({ ...history[0] }, { ownKeys() { throw Error("坏entry keys"); } });
    for (const candidate of [extra, getter, symbol, proxy]) {
      expect(validateTreasuryContinuousOHBudget(policy(), [candidate], ENABLED_MS, ENABLED_TICK, 1)).toBe(false);
      expect(checkTreasuryContinuousOHBudget(policy(), [candidate], ENABLED_MS, ENABLED_MS + DAY, 150, 1, 0).ok).toBe(false);
    }
  });

  it("已发生的超额历史不能在旧window到期后伪装为有效预算", () => {
    const history: TreasuryContinuousOHConsumption[] = [];
    charge(history, { fee: 100 });
    const impossibleHistory = [...history, { ...history[0], sequence: 2, attemptId: "historical-over-budget",
      fee: 1, atTick: 150, atMs: ENABLED_MS + 1_000 }];
    expect(validateTreasuryContinuousOHBudget(policy(), impossibleHistory, ENABLED_MS, ENABLED_TICK, 2)).toBe(false);
    expect(checkTreasuryContinuousOHBudget(policy(), impossibleHistory, ENABLED_MS, ENABLED_MS + 2 * DAY, 200, 1, 0).ok).toBe(false);
  });
});

describe("T4 合法公共quota预扣入口的持久与失败closed", () => {
  let context: ReturnType<typeof initializeT4>;
  let clock: jest.SpyInstance;
  beforeEach(() => {
    context = initializeT4(undefined);
    clock = jest.spyOn(Date, "now").mockReturnValue(ENABLED_MS);
  });
  afterEach(() => clock.mockRestore());

  function state(): TreasuryContinuousOHState {
    const read = readTreasuryContinuousOHState();
    if (read.status !== "valid") throw Error(`预算state不可读: ${read.status}`);
    return read.value;
  }

  function enable(overrides: Partial<TreasuryContinuousOHPolicy> = {}): void {
    expect(enableTreasuryContinuousOH({ pilotTaskId: context.task.id,
      pilotTaskCreatedAt: context.task.createdAt, pilotTaskAmount: context.task.amount, policy: overrides }).ok).toBe(true);
  }

  /** 通过真实enable和产品normalize建立cycle，不签发测试专用state/证书。 */
  function startCycle(overrides: Partial<TreasuryContinuousOHPolicy> = {}): TreasuryT1Quota {
    enable(overrides);
    expect(normalizeTreasuryContinuousOHControl().ok).toBe(true);
    expect(normalizeTreasuryContinuousOHControl().ok).toBe(true);
    const cycle = state().currentCycle;
    if (!cycle || cycle.status !== "active") throw Error("合法预算cycle未active");
    return { schemaVersion: 2, runId: CONTINUOUS_RUN_ID, status: "reserved",
      taskId: cycle.taskId, taskCreatedAt: cycle.taskCreatedAt, taskAmount: cycle.taskAmount,
      workKey: treasuryContinuousOHWorkKey(cycle.taskId, cycle.sequence), attemptId: `budget-native-${cycle.sequence}`,
      amount: cycle.amount, reservedAtTick: Game.time };
  }

  function reserve(): TreasuryT1Quota {
    const quota = startCycle();
    expect(writeTreasuryContinuousOHQuota(quota, 2)).toBe(true);
    expect(state().consumption).toHaveLength(0);
    return quota;
  }

  it("enable绑定canonical初始913任务，计划10且固定72h/72000tick", () => {
    enable();
    expect(state()).toMatchObject({ enabledAtTick: 100, enabledAtMs: ENABLED_MS,
      deadlineTick: 72_100, deadlineMs: ENABLED_MS + 3 * DAY, sequenceHighWater: 0,
      policy: { sliceAmount: 10 }, pilot: { taskId: context.task.id, taskCreatedAt: 90, taskAmount: 913,
        cap: 26, sliceCap: 10, releasedAtTick: null, releasedAtMs: null } });
  });

  it.each(["taskId", "createdAt", "originalAmount"] as const)("拒绝不匹配initial%s绑定，不留新session", (field) => {
    expect(enableTreasuryContinuousOH({ pilotTaskId: field === "taskId" ? "missing-initial-task" : context.task.id,
      pilotTaskCreatedAt: context.task.createdAt + (field === "createdAt" ? 1 : 0),
      pilotTaskAmount: context.task.amount + (field === "originalAmount" ? 1 : 0) }).ok).toBe(false);
    expect(readTreasuryContinuousOHState().status).toBe("absent");
  });

  it("reserved不消费native预算；dispatching之前同步永久扣OH、fee、native一次", () => {
    const quota = reserve();
    expect(writeTreasuryContinuousOHQuota({ ...quota, status: "dispatching" }, 2)).toBe(true);
    expect(state().consumption).toEqual([{ sequence: 1, attemptId: quota.attemptId, amount: 10, fee: 2,
      atTick: 100, atMs: ENABLED_MS, epoch: 0 }]);
    expect(state().currentCycle?.quota?.status).toBe("dispatching");
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it("重复合法event identity不重扣，改变fee或amount不能借原ID取得额度", () => {
    const quota = reserve();
    expect(writeTreasuryContinuousOHQuota({ ...quota, status: "dispatching" }, 3)).toBe(false);
    expect(writeTreasuryContinuousOHQuota({ ...quota, status: "dispatching", amount: 9 }, 2)).toBe(false);
    expect(state().consumption).toHaveLength(0);
    expect(writeTreasuryContinuousOHQuota({ ...quota, status: "dispatching" }, 2)).toBe(true);
    const charged = JSON.stringify(state().consumption);
    writeTreasuryContinuousOHQuota({ ...quota, status: "dispatching" }, 2);
    expect(JSON.stringify(state().consumption)).toBe(charged);
    expect(state().consumption).toHaveLength(1);
  });

  it("预扣未闭合原attempt跨window与Memory重新解码及fresh module，原消费与identity继续占位", () => {
    const quota = reserve();
    expect(writeTreasuryContinuousOHQuota({ ...quota, status: "dispatching" }, 2)).toBe(true);
    const charged = JSON.stringify(state().consumption);
    const deadlines = [state().enabledAtMs, state().enabledAtTick, state().deadlineMs, state().deadlineTick];
    (global as unknown as { Memory: Memory }).Memory = JSON.parse(JSON.stringify(Memory));
    clock.mockReturnValue(ENABLED_MS + DAY); Game.time = 200;
    let freshControl: ReturnType<typeof createTreasuryContinuousOHControl>;
    jest.isolateModules(() => {
      const freshModule = require("@/runtime/treasuryContinuousOHControl") as typeof import("@/runtime/treasuryContinuousOHControl");
      freshControl = freshModule.createTreasuryContinuousOHControl();
    });
    expect(freshControl.readQuota()).toMatchObject({ status: "valid", value: { attemptId: quota.attemptId, status: "dispatching" } });
    freshControl.normalize(); freshControl.normalize();
    expect(state().currentCycle?.quota).toMatchObject({ attemptId: quota.attemptId, status: "dispatching" });
    expect(state().sequenceHighWater).toBe(1);
    expect(JSON.stringify(state().consumption)).toBe(charged);
    expect([state().enabledAtMs, state().enabledAtTick, state().deadlineMs, state().deadlineTick]).toEqual(deadlines);
    expect(acceptTreasuryContinuousOHPilot().ok).toBe(false);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it("pilot dispatching占原cohort，need上涨不能换task/续序列/release", () => {
    const quota = reserve();
    expect(writeTreasuryContinuousOHQuota({ ...quota, status: "dispatching" }, 2)).toBe(true);
    const newer = { ...context.task, id: `${context.task.id}:new`, createdAt: 101, updatedAt: 101 };
    Memory.data!.resourceControl!.tasks[newer.id] = newer;
    setT4Missing(context, 80); Game.time = 150; clock.mockReturnValue(ENABLED_MS + 150_000);
    normalizeTreasuryContinuousOHControl(); normalizeTreasuryContinuousOHControl();
    expect(state().currentCycle).toMatchObject({ sequence: 1, taskId: context.task.id, amount: 10 });
    expect(state().sequenceHighWater).toBe(1);
    expect(state().consumption.reduce((total, entry) => total + entry.amount, 0)).toBe(10);
    expect(acceptTreasuryContinuousOHPilot().ok).toBe(false);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it("未真实闭合的partial不能标drained或release，need0也不解除原责任", () => {
    const quota = reserve();
    expect(writeTreasuryContinuousOHQuota({ ...quota, status: "dispatching" }, 2)).toBe(true);
    setT4Missing(context, 0);
    expect(writeTreasuryContinuousOHQuota({ ...quota, status: "drained" })).toBe(false);
    expect(acceptTreasuryContinuousOHPilot().ok).toBe(false);
    expect(state().closedCycles).toHaveLength(0);
    expect(state().consumption).toHaveLength(1);
    expect(state().pilot.releasedAtTick).toBeNull();
  });

  it("mirror暂时半写失败返回false，已知合法baseline恢复后没有native收费", () => {
    const quota = reserve();
    const runtime = Memory.runtime as unknown as Record<string, unknown>;
    let mirror = runtime[MIRROR]; let writes = 0;
    Object.defineProperty(runtime, MIRROR, { enumerable: true, configurable: true,
      get: () => mirror, set(value: unknown) { writes += 1; if (writes === 1) throw Error("注入mirror写失败"); mirror = value; } });
    expect(writeTreasuryContinuousOHQuota({ ...quota, status: "dispatching" }, 2)).toBe(false);
    expect(readTreasuryContinuousOHState().status).toBe("valid");
    expect(state().consumption).toHaveLength(0);
    expect(state().currentCycle?.quota?.status).toBe("reserved");
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it("mirror坏值使partial write不能安全回滚时，保留invalid并阻断后续收费/release", () => {
    const quota = reserve();
    const runtime = Memory.runtime as unknown as Record<string, unknown>;
    let mirror = runtime[MIRROR];
    Object.defineProperty(runtime, MIRROR, { enumerable: true, configurable: true,
      get: () => mirror, set() { mirror = { damaged: true }; throw Error("不可恢复mirror故障"); } });
    expect(writeTreasuryContinuousOHQuota({ ...quota, status: "dispatching" }, 2)).toBe(false);
    expect(readTreasuryContinuousOHState().status).toBe("invalid");
    expect(writeTreasuryContinuousOHQuota({ ...quota, status: "dispatching" }, 2)).toBe(false);
    expect(acceptTreasuryContinuousOHPilot().ok).toBe(false);
    expect(normalizeTreasuryContinuousOHControl().ok).toBe(false);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it.each([PRIMARY, MIRROR])("合法旧%s单边回滚或消费history删除都使state失败closed", (key) => {
    const quota = reserve();
    const runtime = Memory.runtime as unknown as Record<string, unknown>;
    const old = JSON.parse(JSON.stringify(runtime[key]));
    expect(writeTreasuryContinuousOHQuota({ ...quota, status: "dispatching" }, 2)).toBe(true);
    const charged = JSON.parse(JSON.stringify(runtime[key]));
    runtime[key] = old;
    expect(readTreasuryContinuousOHState().status).toBe("invalid");
    expect(writeTreasuryContinuousOHQuota({ ...quota, status: "dispatching" }, 2)).toBe(false);
    runtime[key] = charged;
    expect(readTreasuryContinuousOHState().status).toBe("valid");
    (runtime[key] as { consumption: unknown[] }).consumption = [];
    expect(readTreasuryContinuousOHState().status).toBe("invalid");
    expect(acceptTreasuryContinuousOHPilot().ok).toBe(false);
  });

  it("prep仅取消原cycle也不清prepare高水位，maxPrepare1不能获得第2次准备", () => {
    enable({ maxPrepareCycles: 1 });
    expect(normalizeTreasuryContinuousOHControl().ok).toBe(true);
    expect(state().sequenceHighWater).toBe(1);
    Game.time = 701; clock.mockReturnValue(ENABLED_MS + 31 * 60_000);
    normalizeTreasuryContinuousOHControl(); normalizeTreasuryContinuousOHControl(); normalizeTreasuryContinuousOHControl();
    expect(state().sequenceHighWater).toBe(1);
    expect(state().closedCycles).toHaveLength(1);
    expect(state().closedCycles[0].outcome).toBe("cancelled");
    expect(state().currentCycle).toBeNull();
    expect(state().consumption).toHaveLength(0);
    expect(acceptTreasuryContinuousOHPilot().ok).toBe(false);
  });

  it("idle无消费也记录已观察时钟高水位，倒退不能重新prepare", () => {
    enable(); setT4Missing(context, 0);
    Game.time = 150; clock.mockReturnValue(ENABLED_MS + 10_000);
    expect(normalizeTreasuryContinuousOHControl().ok).toBe(true);
    expect(state().currentCycle).toBeNull();
    Game.time = 149; clock.mockReturnValue(ENABLED_MS + 9_999);
    setT4Missing(context, 26);
    normalizeTreasuryContinuousOHControl();
    expect(state().sessionStatus).toBe("stopped");
    expect(state().stopReason).toBe("clock_regressed");
    expect(state().sequenceHighWater).toBe(0);
    expect(state().consumption).toHaveLength(0);
  });

  it("64个合法取消证书的旧book在Memory1.84MB可原位更新，不把旧新book双计", () => {
    enable();
    expect(normalizeTreasuryContinuousOHControl().ok).toBe(true);
    for (let index = 0; index < 64; index += 1) {
      const preparing = state().currentCycle;
      expect(preparing?.status).toBe("preparing");
      clock.mockReturnValue(preparing!.controlUntilMs + 1); Game.time += 1;
      expect(normalizeTreasuryContinuousOHControl().ok).toBe(true);
      expect(normalizeTreasuryContinuousOHControl().ok).toBe(true);
    }
    expect(state().closedCycles).toHaveLength(64);
    expect(state().closedCycles.every((cert) => cert.outcome === "cancelled" && cert.ring === null &&
      cert.taskRemainingAtClose === 913 && cert.cycle.taskRemainingAtArm === 913)).toBe(true);
    expect(state().sequenceHighWater).toBe(65);
    expect(state().consumption).toHaveLength(0);
    const fullMemory = Memory as unknown as Record<string, unknown>;
    fullMemory.t4BudgetPadding = "";
    fullMemory.t4BudgetPadding = "a".repeat(1_840_000 - treasuryT1SerializedBytes(Memory));
    expect(treasuryT1SerializedBytes(Memory)).toBe(1_840_000);
    // 证明此输入会触发旧的双计拒绝，避免小book+padding也绿的伪回归。
    expect(treasuryT1SerializedBytes(Memory) + 2 * treasuryT1SerializedBytes(state()) + 512)
      .toBeGreaterThan(1_900_000);
    expect(normalizeTreasuryContinuousOHControl().ok).toBe(true);
    const cycle = state().currentCycle!;
    expect(cycle.status).toBe("active");
    const quota: TreasuryT1Quota = { schemaVersion: 2, runId: CONTINUOUS_RUN_ID, status: "reserved",
      taskId: cycle.taskId, taskCreatedAt: cycle.taskCreatedAt, taskAmount: cycle.taskAmount,
      workKey: treasuryContinuousOHWorkKey(cycle.taskId, cycle.sequence), attemptId: "budget-native-65",
      amount: cycle.amount, reservedAtTick: Game.time };
    expect(writeTreasuryContinuousOHQuota(quota, 2)).toBe(true);
    expect(writeTreasuryContinuousOHQuota({ ...quota, status: "dispatching" }, 2)).toBe(true);
    expect(state().closedCycles).toHaveLength(64);
    expect(state().consumption).toMatchObject([{ sequence: 65, amount: 10, fee: 2 }]);
    expect(context.task.remainingAmount).toBe(913);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  }, 30_000);

  it.each(["wall", "tick"] as const)("固定%s deadline达到即停止，不能reenable清额度延长", (kind) => {
    enable();
    const initial = state();
    if (kind === "wall") clock.mockReturnValue(initial.deadlineMs);
    else Game.time = initial.deadlineTick;
    expect(normalizeTreasuryContinuousOHControl().ok).toBe(true);
    expect(state()).toMatchObject({ sessionStatus: "stopped", enabledAtMs: initial.enabledAtMs,
      enabledAtTick: initial.enabledAtTick, deadlineMs: initial.deadlineMs, deadlineTick: initial.deadlineTick });
    expect(enableTreasuryContinuousOH({ pilotTaskId: context.task.id,
      pilotTaskCreatedAt: context.task.createdAt, pilotTaskAmount: context.task.amount }).ok).toBe(false);
    expect(state().deadlineMs).toBe(initial.deadlineMs);
  });

  it("operator stop保留已预扣history与unknown责任，禁止reset enable/release", () => {
    const quota = reserve();
    expect(writeTreasuryContinuousOHQuota({ ...quota, status: "dispatching" }, 2)).toBe(true);
    const before = JSON.stringify(state().consumption); const deadlines = [state().deadlineMs, state().deadlineTick];
    stopTreasuryContinuousOH();
    expect(state().sessionStatus).toBe("stopping");
    expect(JSON.stringify(state().consumption)).toBe(before);
    expect(state().currentCycle?.quota?.attemptId).toBe(quota.attemptId);
    expect([state().deadlineMs, state().deadlineTick]).toEqual(deadlines);
    expect(enableTreasuryContinuousOH({ pilotTaskId: context.task.id,
      pilotTaskCreatedAt: context.task.createdAt, pilotTaskAmount: context.task.amount }).ok).toBe(false);
    expect(acceptTreasuryContinuousOHPilot().ok).toBe(false);
  });
});
