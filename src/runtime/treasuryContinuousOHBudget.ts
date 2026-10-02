/**
 * 连续 OH 运输的纯预算合同。
 *
 * history 只记录 native 调用前的永久扣减；失败、未决和后续恢复都不退款。
 * 本模块不读 Game/Memory，不剪裁历史，也不管理试运行 cohort。
 */
export const TREASURY_CONTINUOUS_OH_HARD_BOUNDS = Object.freeze({
  sliceAmount: 26,
  rolling24hOH: 260,
  rolling24hEnergy: 100,
  rolling24hNativeCalls: 30,
  lifetimeOH: 780,
  lifetimeEnergy: 300,
  lifetimeNativeCalls: 90,
  maxPrepareCycles: 128,
  minNativeIntervalTicks: 50,
} as const);

export interface TreasuryContinuousOHPolicy {
  sliceAmount: number;
  rolling24hOH: number;
  rolling24hEnergy: number;
  rolling24hNativeCalls: number;
  lifetimeOH: number;
  lifetimeEnergy: number;
  lifetimeNativeCalls: number;
  maxPrepareCycles: number;
  minNativeIntervalTicks: number;
}

export interface TreasuryContinuousOHConsumption {
  sequence: number;
  attemptId: string;
  amount: number;
  fee: number;
  atTick: number;
  atMs: number;
  epoch: number;
}

export type TreasuryContinuousOHBudgetCheck = {
  ok: boolean;
  reason: string;
};

export type TreasuryContinuousOHPolicyNormalizationResult =
  | { ok: true; policy: TreasuryContinuousOHPolicy }
  | { ok: false; reason: string };

export interface TreasuryContinuousOHBudgetSummary {
  rolling24h: { oh: number; energy: number; nativeCalls: number };
  epoch24h: {
    index: number;
    oh: number;
    energy: number;
    nativeCalls: number;
  };
  lifetime: { oh: number; energy: number; nativeCalls: number };
  lastNativeTick: number | null;
}

const DAY_MS = 86_400_000;
const MAX_NATIVE_INTERVAL_TICKS = 72_000;
const POLICY_KEYS = Object.keys(
  TREASURY_CONTINUOUS_OH_HARD_BOUNDS,
) as (keyof TreasuryContinuousOHPolicy)[];
const CONSUMPTION_KEYS = [
  "sequence", "attemptId", "amount", "fee", "atTick", "atMs", "epoch",
] as const;
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9:_\-.]{1,128}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasDataFields(
  value: unknown,
  names: readonly string[],
  partial = false,
): boolean {
  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length !== 0) {
    return false;
  }
  const keys = Object.getOwnPropertyNames(value);
  if (!partial && keys.length !== names.length) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return names.includes(key) && descriptor !== undefined && "value" in descriptor;
  });
}

function isDataHistory(history: readonly TreasuryContinuousOHConsumption[]): boolean {
  if (!Array.isArray(history) || Object.getPrototypeOf(history) !== Array.prototype ||
      Object.getOwnPropertySymbols(history).length !== 0 ||
      Object.getOwnPropertyNames(history).length !== history.length + 1) return false;
  for (let index = 0; index < history.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(history, String(index));
    if (!descriptor || !("value" in descriptor)) return false;
  }
  return true;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function failure(reason: string): TreasuryContinuousOHBudgetCheck {
  return { ok: false, reason };
}

/** 所有上限只能收紧；native 间隔只能从硬下限向上收紧。 */
function normalizePolicy(
  options?: Partial<TreasuryContinuousOHPolicy>,
): TreasuryContinuousOHPolicyNormalizationResult {
  if (options !== undefined && !isPlainObject(options)) {
    return { ok: false, reason: "invalid_policy_options" };
  }
  if (
    options !== undefined &&
    (Object.getOwnPropertySymbols(options).length > 0 ||
      Object.getOwnPropertyNames(options).some(
        (key) => !POLICY_KEYS.includes(key as keyof TreasuryContinuousOHPolicy),
      ))
  ) {
    return { ok: false, reason: "unknown_policy_key" };
  }
  if (options !== undefined && !hasDataFields(options, POLICY_KEYS, true)) {
    return { ok: false, reason: "invalid_policy_options" };
  }
  const policy: TreasuryContinuousOHPolicy = {
    ...TREASURY_CONTINUOUS_OH_HARD_BOUNDS,
    sliceAmount: 10,
  };
  for (const key of POLICY_KEYS) {
    if (options !== undefined && Object.prototype.hasOwnProperty.call(options, key)) {
      const value = Object.getOwnPropertyDescriptor(options, key)!.value;
      if (!isPositiveSafeInteger(value)) {
        return { ok: false, reason: `invalid_policy_${key}` };
      }
      if (key === "minNativeIntervalTicks") {
        if (
          value < TREASURY_CONTINUOUS_OH_HARD_BOUNDS.minNativeIntervalTicks ||
          value > MAX_NATIVE_INTERVAL_TICKS
        ) {
          return { ok: false, reason: "policy_minNativeIntervalTicks_hard_bound" };
        }
      } else if (value > TREASURY_CONTINUOUS_OH_HARD_BOUNDS[key]) {
        return { ok: false, reason: `policy_${key}_hard_bound` };
      }
      policy[key] = value;
    }
  }
  return { ok: true, policy };
}

export function normalizeTreasuryContinuousOHPolicy(
  options?: Partial<TreasuryContinuousOHPolicy>,
): TreasuryContinuousOHPolicyNormalizationResult {
  try {
    return normalizePolicy(options);
  } catch {
    return { ok: false, reason: "invalid_policy_options" };
  }
}

function isCompletePolicy(policy: TreasuryContinuousOHPolicy): boolean {
  if (!hasDataFields(policy, POLICY_KEYS)) return false;
  const normalized = normalizeTreasuryContinuousOHPolicy(policy);
  return normalized.ok && POLICY_KEYS.every((key) => policy[key] === normalized.policy[key]);
}

function exceededBudget(
  policy: TreasuryContinuousOHPolicy,
  summary: TreasuryContinuousOHBudgetSummary,
  amount: number,
  fee: number,
): TreasuryContinuousOHBudgetCheck {
  if (summary.rolling24h.oh + amount > policy.rolling24hOH) {
    return failure("rolling24h_oh_exceeded");
  }
  if (summary.rolling24h.energy + fee > policy.rolling24hEnergy) {
    return failure("rolling24h_energy_exceeded");
  }
  if (summary.rolling24h.nativeCalls + 1 > policy.rolling24hNativeCalls) {
    return failure("rolling24h_native_calls_exceeded");
  }
  if (summary.epoch24h.oh + amount > policy.rolling24hOH) {
    return failure("epoch24h_oh_exceeded");
  }
  if (summary.epoch24h.energy + fee > policy.rolling24hEnergy) {
    return failure("epoch24h_energy_exceeded");
  }
  if (summary.epoch24h.nativeCalls + 1 > policy.rolling24hNativeCalls) {
    return failure("epoch24h_native_calls_exceeded");
  }
  if (summary.lifetime.oh + amount > policy.lifetimeOH) {
    return failure("lifetime_oh_exceeded");
  }
  if (summary.lifetime.energy + fee > policy.lifetimeEnergy) {
    return failure("lifetime_energy_exceeded");
  }
  if (summary.lifetime.nativeCalls + 1 > policy.lifetimeNativeCalls) {
    return failure("lifetime_native_calls_exceeded");
  }
  return { ok: true, reason: "ok" };
}

/**
 * 只读聚合完整历史。调用方必须先完成完整性与当前时钟校验；此结果本身不授予额度。
 * rolling 下界严格排除恰好 24 小时前的扣减，epoch 以首次 enable 的毫秒锚定。
 */
export function summarizeTreasuryContinuousOHBudget(
  _policy: TreasuryContinuousOHPolicy,
  history: readonly TreasuryContinuousOHConsumption[],
  enabledAtMs: number,
  nowMs: number,
): TreasuryContinuousOHBudgetSummary {
  const index = Math.floor((nowMs - enabledAtMs) / DAY_MS);
  const summary: TreasuryContinuousOHBudgetSummary = {
    rolling24h: { oh: 0, energy: 0, nativeCalls: 0 },
    epoch24h: { index, oh: 0, energy: 0, nativeCalls: 0 },
    lifetime: { oh: 0, energy: 0, nativeCalls: 0 },
    lastNativeTick: null,
  };
  for (const entry of history) {
    summary.lifetime.oh += entry.amount;
    summary.lifetime.energy += entry.fee;
    summary.lifetime.nativeCalls += 1;
    summary.lastNativeTick = entry.atTick;
    if (entry.atMs > nowMs - DAY_MS) {
      summary.rolling24h.oh += entry.amount;
      summary.rolling24h.energy += entry.fee;
      summary.rolling24h.nativeCalls += 1;
    }
    if (entry.epoch === index) {
      summary.epoch24h.oh += entry.amount;
      summary.epoch24h.energy += entry.fee;
      summary.epoch24h.nativeCalls += 1;
    }
  }
  return summary;
}

function validateHistory(
  policy: TreasuryContinuousOHPolicy,
  history: readonly TreasuryContinuousOHConsumption[],
  enabledAtMs: number,
  enabledAtTick: number,
  sequenceHighWater: number,
): TreasuryContinuousOHBudgetCheck {
  if (!isCompletePolicy(policy)) return failure("invalid_policy");
  if (
    !isNonNegativeSafeInteger(enabledAtMs) ||
    !isNonNegativeSafeInteger(enabledAtTick) ||
    !isNonNegativeSafeInteger(sequenceHighWater) ||
    sequenceHighWater > policy.maxPrepareCycles
  ) {
    return failure("invalid_budget_anchor");
  }
  if (
    !isDataHistory(history) ||
    history.length > TREASURY_CONTINUOUS_OH_HARD_BOUNDS.lifetimeNativeCalls
  ) {
    return failure("invalid_budget_history");
  }
  const attemptIds = new Set<string>();
  const prefix: TreasuryContinuousOHConsumption[] = [];
  let previousSequence = 0;
  let previousTick = enabledAtTick;
  let previousMs = enabledAtMs;
  for (const entry of history) {
    if (
      !hasDataFields(entry, CONSUMPTION_KEYS) ||
      !isPositiveSafeInteger(entry.sequence) ||
      entry.sequence <= previousSequence ||
      entry.sequence > sequenceHighWater ||
      typeof entry.attemptId !== "string" ||
      !ATTEMPT_ID_PATTERN.test(entry.attemptId) ||
      attemptIds.has(entry.attemptId) ||
      !isPositiveSafeInteger(entry.amount) ||
      entry.amount > policy.sliceAmount ||
      !isNonNegativeSafeInteger(entry.fee) ||
      !isNonNegativeSafeInteger(entry.atTick) ||
      !isNonNegativeSafeInteger(entry.atMs) ||
      !isNonNegativeSafeInteger(entry.epoch) ||
      entry.atTick < previousTick ||
      entry.atMs < previousMs ||
      entry.epoch !== Math.floor((entry.atMs - enabledAtMs) / DAY_MS)
    ) {
      return failure("invalid_budget_history");
    }
    if (
      prefix.length > 0 &&
      entry.atTick - previousTick < policy.minNativeIntervalTicks
    ) {
      return failure("native_interval_not_elapsed");
    }
    const budget = exceededBudget(
      policy,
      summarizeTreasuryContinuousOHBudget(policy, prefix, enabledAtMs, entry.atMs),
      entry.amount,
      entry.fee,
    );
    if (!budget.ok) return budget;
    prefix.push(entry);
    attemptIds.add(entry.attemptId);
    previousSequence = entry.sequence;
    previousTick = entry.atTick;
    previousMs = entry.atMs;
  }
  return { ok: true, reason: "ok" };
}

/** 每个历史前缀都必须在当时的 rolling、epoch、lifetime 额度内。 */
export function validateTreasuryContinuousOHBudget(
  policy: TreasuryContinuousOHPolicy,
  history: readonly TreasuryContinuousOHConsumption[],
  enabledAtMs: number,
  enabledAtTick: number,
  sequenceHighWater: number,
): boolean {
  try {
    return validateHistory(policy, history, enabledAtMs, enabledAtTick, sequenceHighWater).ok;
  } catch {
    return false;
  }
}

/** 在 native 调用前同时检查 OH、费用与调用次数，三者必须一起写入 history。 */
function checkBudget(
  policy: TreasuryContinuousOHPolicy,
  history: readonly TreasuryContinuousOHConsumption[],
  enabledAtMs: number,
  nowMs: number,
  nowTick: number,
  amount: number,
  fee: number,
): TreasuryContinuousOHBudgetCheck {
  if (!isCompletePolicy(policy)) return failure("invalid_policy");
  const validation = validateHistory(policy, history, enabledAtMs, 0, policy.maxPrepareCycles);
  if (!validation.ok) return validation;
  if (
    !isNonNegativeSafeInteger(nowMs) ||
    !isNonNegativeSafeInteger(nowTick) ||
    nowMs < enabledAtMs
  ) {
    return failure("invalid_budget_clock");
  }
  const last = history[history.length - 1];
  if (last && (nowMs < last.atMs || nowTick < last.atTick)) {
    return failure("budget_clock_regression");
  }
  if (!isPositiveSafeInteger(amount) || amount > policy.sliceAmount) {
    return failure("invalid_slice_amount");
  }
  if (!isNonNegativeSafeInteger(fee)) return failure("invalid_native_fee");
  if (last && nowTick - last.atTick < policy.minNativeIntervalTicks) {
    return failure("native_interval_not_elapsed");
  }
  return exceededBudget(
    policy,
    summarizeTreasuryContinuousOHBudget(policy, history, enabledAtMs, nowMs),
    amount,
    fee,
  );
}

export function checkTreasuryContinuousOHBudget(
  policy: TreasuryContinuousOHPolicy,
  history: readonly TreasuryContinuousOHConsumption[],
  enabledAtMs: number,
  nowMs: number,
  nowTick: number,
  amount: number,
  fee: number,
): TreasuryContinuousOHBudgetCheck {
  try {
    return checkBudget(policy, history, enabledAtMs, nowMs, nowTick, amount, fee);
  } catch {
    return failure("invalid_budget_input");
  }
}
