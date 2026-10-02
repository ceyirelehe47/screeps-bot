import {
  checkTreasuryContinuousOHBudget,
  normalizeTreasuryContinuousOHPolicy,
  validateTreasuryContinuousOHBudget,
  type TreasuryContinuousOHConsumption,
  type TreasuryContinuousOHPolicy,
} from "@/runtime/treasuryContinuousOHBudget";
import {
  freezeTreasuryContinuousOHBook,
  isTreasuryContinuousOHProvenFrozenData,
  treasuryContinuousOHDataToken,
} from "@/runtime/treasuryContinuousOHDataTree";

const DAY = 86_400_000;
const ENABLED_MS = 1_800_000_000_000;
const ENABLED_TICK = 100;

function policy(overrides: Partial<TreasuryContinuousOHPolicy> = {}): TreasuryContinuousOHPolicy {
  const normalized = normalizeTreasuryContinuousOHPolicy({ sliceAmount: 26, ...overrides });
  if (normalized.ok === false) throw Error(normalized.reason);
  return normalized.policy;
}

function history(count = 2): TreasuryContinuousOHConsumption[] {
  return Array.from({ length: count }, (_, index) => ({
    sequence: index + 1, attemptId: `frozen-budget-attempt-${index + 1}`,
    amount: 2, fee: 1, atTick: ENABLED_TICK + index * 50,
    atMs: ENABLED_MS + 1_000 + index * 50_000, epoch: 0,
  }));
}

/** 与已有满预算案例相同：90 次消费分布在 128 次准备内，三天各 260 OH / 100 fee / 30 次。 */
function fullDebitHistory(): TreasuryContinuousOHConsumption[] {
  return Array.from({ length: 90 }, (_, index) => {
    const slot = index % 30;
    return {
      sequence: index + 1 + Math.floor(index * 38 / 89),
      attemptId: `full-frozen-budget-attempt-${index + 1}`,
      amount: slot < 20 ? 10 : 6, fee: slot < 10 ? 4 : 3,
      atTick: ENABLED_TICK + index * 50,
      atMs: ENABLED_MS + Math.floor(index / 30) * DAY + slot * 50_000,
      epoch: Math.floor(index / 30),
    };
  });
}

function proveFrozen(rows: TreasuryContinuousOHConsumption[]): void {
  const book = { consumption: rows };
  const token = treasuryContinuousOHDataToken(book);
  expect(token).not.toBeNull();
  expect(freezeTreasuryContinuousOHBook(book, token!)).toBe(true);
  expect(isTreasuryContinuousOHProvenFrozenData(rows)).toBe(true);
}

describe("T4 深冻结消费历史只复用成功数学证明", () => {
  afterEach(() => jest.restoreAllMocks());

  it("合法 90 消费的公开验证与预算查询不重复扫描 entry descriptors，动态总额度仍拒绝第 91 次", () => {
    const bounds = policy();
    const rows = fullDebitHistory();
    expect(validateTreasuryContinuousOHBudget(bounds, rows, ENABLED_MS, ENABLED_TICK, 128)).toBe(true);
    proveFrozen(rows);
    const entries = new Set<object>(rows);
    const descriptor = Object.getOwnPropertyDescriptor;
    let rowDescriptorReads = 0;
    jest.spyOn(Object, "getOwnPropertyDescriptor").mockImplementation((value, key) => {
      if (entries.has(value)) rowDescriptorReads += 1;
      return descriptor(value, key);
    });
    expect(validateTreasuryContinuousOHBudget(bounds, rows, ENABLED_MS, ENABLED_TICK, 128)).toBe(true);
    expect(rowDescriptorReads).toBeGreaterThanOrEqual(rows.length * 7);
    rowDescriptorReads = 0;
    expect(validateTreasuryContinuousOHBudget(bounds, rows, ENABLED_MS, ENABLED_TICK, 128)).toBe(true);
    expect(rowDescriptorReads).toBe(0);
    const check = () => checkTreasuryContinuousOHBudget(bounds, rows, ENABLED_MS,
      ENABLED_MS + 3 * DAY, 4_600, 1, 0);
    expect(check()).toEqual({ ok: false, reason: "lifetime_oh_exceeded" });
    expect(rowDescriptorReads).toBeGreaterThanOrEqual(rows.length * 7);
    rowDescriptorReads = 0;
    expect(check()).toEqual({ ok: false, reason: "lifetime_oh_exceeded" });
    expect(rowDescriptorReads).toBe(0);
    // State 的实际 anchor 与公开 check 的宽 anchor 各自保留，不互相顶掉。
    expect(validateTreasuryContinuousOHBudget(bounds, rows, ENABLED_MS, ENABLED_TICK, 128)).toBe(true);
    expect(rowDescriptorReads).toBe(0);
  });

  it("暖证明仍逐次检查 clock 回退、49/50 tick、下一片数量/费用和真正的 24h 出窗", () => {
    const bounds = policy({ sliceAmount: 10, rolling24hOH: 10, rolling24hEnergy: 4,
      lifetimeOH: 20, lifetimeEnergy: 8 });
    const rows = history(1); proveFrozen(rows);
    const before = JSON.stringify(rows);
    const check = (ms: number, tick: number, amount = 8, fee = 3) =>
      checkTreasuryContinuousOHBudget(bounds, rows, ENABLED_MS, ms, tick, amount, fee);
    expect(check(ENABLED_MS + 2_000, 150)).toEqual({ ok: true, reason: "ok" });
    expect(check(ENABLED_MS + 2_000, 149).reason).toBe("native_interval_not_elapsed");
    expect(check(ENABLED_MS + 999, 150).reason).toBe("budget_clock_regression");
    expect(check(ENABLED_MS + 2_000, 99).reason).toBe("budget_clock_regression");
    expect(check(ENABLED_MS + 2_000, 150, 11, 3).reason).toBe("invalid_slice_amount");
    expect(check(ENABLED_MS + 2_000, 150, 8, -1).reason).toBe("invalid_native_fee");
    expect(check(ENABLED_MS + 2_000, 150, 9, 3).reason).toBe("rolling24h_oh_exceeded");
    expect(check(ENABLED_MS + 2_000, 150, 8, 4).reason).toBe("rolling24h_energy_exceeded");
    expect(check(rows[0].atMs + DAY - 1, 150, 10, 4).ok).toBe(false);
    expect(check(rows[0].atMs + DAY, 150, 10, 4)).toEqual({ ok: true, reason: "ok" });
    expect(JSON.stringify(rows)).toBe(before);
  });

  it.each([false, true])("mutable / 仅浅冻结 %s 的历史改值不能沿用第一次成功结果", (shallow) => {
    const bounds = policy(); const rows = history();
    if (shallow) Object.freeze(rows);
    expect(isTreasuryContinuousOHProvenFrozenData(rows)).toBe(false);
    expect(checkTreasuryContinuousOHBudget(bounds, rows, ENABLED_MS, ENABLED_MS + 100_000, 200, 1, 0).ok).toBe(true);
    rows[1].attemptId = rows[0].attemptId;
    expect(checkTreasuryContinuousOHBudget(bounds, rows, ENABLED_MS, ENABLED_MS + 100_000, 200, 1, 0).reason)
      .toBe("invalid_budget_history");
  });

  it("新 history root 即使手工深冻结，也不能继承另一个已证明 root 的 valid", () => {
    const bounds = policy(); const rows = history(); proveFrozen(rows);
    expect(validateTreasuryContinuousOHBudget(bounds, rows, ENABLED_MS, ENABLED_TICK, 2)).toBe(true);
    const replacement = rows.map((row) => ({ ...row }));
    replacement[0].amount = 27;
    for (const row of replacement) Object.freeze(row);
    Object.freeze(replacement);
    expect(isTreasuryContinuousOHProvenFrozenData(replacement)).toBe(false);
    expect(validateTreasuryContinuousOHBudget(bounds, replacement, ENABLED_MS, ENABLED_TICK, 2)).toBe(false);
  });

  it.each(["sliceAmount", "rolling24hOH", "rolling24hEnergy", "rolling24hNativeCalls", "lifetimeOH",
    "lifetimeEnergy", "lifetimeNativeCalls", "maxPrepareCycles", "minNativeIntervalTicks"] as const)(
    "暖历史证明后 policy 的 %s 收紧必须重验，不能沿用原上限", (key) => {
      const bounds = policy(); const rows = fullDebitHistory(); proveFrozen(rows);
      expect(validateTreasuryContinuousOHBudget(bounds, rows, ENABLED_MS, ENABLED_TICK, 128)).toBe(true);
      bounds[key] = key === "sliceAmount" ? 9 : bounds[key] + (key === "minNativeIntervalTicks" ? 1 : -1);
      expect(validateTreasuryContinuousOHBudget(bounds, rows, ENABLED_MS, ENABLED_TICK, 128)).toBe(false);
      expect(checkTreasuryContinuousOHBudget(bounds, rows, ENABLED_MS, ENABLED_MS + 3 * DAY, 4_600, 1, 0).ok).toBe(false);
    },
  );

  it("policy 形状仍 fresh 校验，增加未知字段不能以原数字身份命中缓存", () => {
    const bounds = policy(); const rows = history(); proveFrozen(rows);
    expect(validateTreasuryContinuousOHBudget(bounds, rows, ENABLED_MS, ENABLED_TICK, 2)).toBe(true);
    Object.defineProperty(bounds, "unknownPolicy", { value: true, enumerable: false });
    expect(validateTreasuryContinuousOHBudget(bounds, rows, ENABLED_MS, ENABLED_TICK, 2)).toBe(false);
  });

  it.each([Object.prototype, Array.prototype])("prototype 新增 hook 撤销不可变缓存证据，不执行 hook 并重新检查消费", (prototype) => {
    const bounds = policy(); const rows = history(); proveFrozen(rows);
    expect(validateTreasuryContinuousOHBudget(bounds, rows, ENABLED_MS, ENABLED_TICK, 2)).toBe(true);
    const entries = new Set<object>(rows);
    const descriptor = Object.getOwnPropertyDescriptor;
    let rowDescriptorReads = 0;
    jest.spyOn(Object, "getOwnPropertyDescriptor").mockImplementation((value, key) => {
      if (entries.has(value)) rowDescriptorReads += 1;
      return descriptor(value, key);
    });
    const hook = jest.fn(() => ({}));
    Object.defineProperty(prototype, "toJSON", { get: hook, configurable: true });
    try {
      expect(isTreasuryContinuousOHProvenFrozenData(rows)).toBe(false);
      // Budget 是不执行 JSON 的纯算术门；撤销缓存后仍按原路径完整验证。
      expect(validateTreasuryContinuousOHBudget(bounds, rows, ENABLED_MS, ENABLED_TICK, 2)).toBe(true);
      expect(rowDescriptorReads).toBeGreaterThanOrEqual(rows.length * 7);
      expect(hook).not.toHaveBeenCalled();
    } finally { delete (prototype as Record<string, unknown>).toJSON; }
  });

  it.each(["enabledAtMs", "enabledAtTick", "sequenceHighWater"] as const)(
    "暖历史证明后 %s 改变仍检查完整历史关系", (anchor) => {
      const bounds = policy(); const rows = fullDebitHistory(); proveFrozen(rows);
      expect(validateTreasuryContinuousOHBudget(bounds, rows, ENABLED_MS, ENABLED_TICK, 128)).toBe(true);
      expect(validateTreasuryContinuousOHBudget(bounds, rows,
        ENABLED_MS + (anchor === "enabledAtMs" ? 1 : 0),
        ENABLED_TICK + (anchor === "enabledAtTick" ? 1 : 0),
        anchor === "sequenceHighWater" ? 127 : 128)).toBe(false);
    },
  );
});
