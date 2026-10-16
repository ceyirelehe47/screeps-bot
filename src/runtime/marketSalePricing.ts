export const MARKET_PRICE_TICK = 0.001;
export const MILLI_CREDITS_PER_CREDIT = 1_000;
export const MARKET_ORDER_FEE_DIVISOR = 20;
export const MIN_TRUSTED_HISTORY_DAYS = 5;

const LOG_MAD_SCALE = 1.4826;
const ZERO_MAD_EPSILON = 1e-12;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

export type MilliCredits = number;
export type MarketOrderSide = "buy" | "sell";

export interface MarketHistoryDay {
  resourceType?: string;
  date: string;
  transactions: number;
  volume: number;
  avgPrice: number;
  stddevPrice?: number;
  complete?: boolean;
}

export interface TrustedHistoryOptions {
  /** Current UTC calendar date. History entries on or after this date are incomplete. */
  asOfDate: string;
  resourceType?: string;
  minValidDays?: number;
  minTransactionsPerDay: number;
  minVolumePerDay: number;
  logMadZThreshold?: number;
  maxSqrtVolumeWeightMultiple?: number;
  historyFloorRatio?: number;
}

export type HistoryDayRejectionReason =
  | "invalid_date"
  | "incomplete_day"
  | "resource_mismatch"
  | "duplicate_date"
  | "invalid_values"
  | "transactions_below_minimum"
  | "volume_below_minimum"
  | "log_mad_outlier";

export interface HistoryDayRejection {
  date: string;
  reason: HistoryDayRejectionReason;
}

export interface TrustedHistoryResult {
  trusted: boolean;
  reason?: "insufficient_complete_days" | "insufficient_days_after_outlier_filter";
  latestHistoryDate?: string;
  referencePrice?: number;
  trustedFloor?: number;
  medianLogPrice?: number;
  madLogPrice?: number;
  completeDayCount: number;
  acceptedDayCount: number;
  acceptedDates: string[];
  rejectedDays: HistoryDayRejection[];
}

export interface WeightedValue {
  value: number;
  weight: number;
}

export interface TrustedFloorObservation {
  historyDate: string;
  floor: number;
}

export interface TrustedFloorState {
  historyDate: string;
  floor: number;
  observedFloor: number;
}

export interface TrustedFloorAdvanceOptions {
  maxDailyDropRatio?: number;
}

export interface TrustedFloorAdvanceResult {
  state: TrustedFloorState;
  changed: boolean;
  daysAdvanced: number;
  ratchetFloor: number;
  reason: "initialized" | "advanced" | "same_history_day" | "older_history_day";
}

export interface EffectiveNetFloorInput {
  hardFloor: number;
  economicFloor?: number;
  historyFloor?: number;
  ratchetFloor?: number;
  /**
   * enforce 模式动态地板：提供且有效时整体替代 {history, ratchet} 两
   * 分量（动态地板自身已满足 ≤ratchet、≥hardFloor 的区间约束，简单
   * 加入 max 会被同源的 history/ratchet 盖掉）。缺席时保持 observe
   * 四分量语义。
   */
  dynamicFloor?: number;
}

export type EffectiveFloorComponent =
  | "hard"
  | "economic"
  | "history"
  | "ratchet"
  | "dynamic";

export interface EffectiveNetFloorResult {
  valid: boolean;
  reason?: "hard_floor_missing_or_invalid" | "component_invalid";
  floor?: number;
  floorMilli?: MilliCredits;
  dominantComponent?: EffectiveFloorComponent;
  components: {
    hard?: number;
    economic?: number;
    history?: number;
    ratchet?: number;
    dynamic?: number;
  };
}

export interface EnergyShadowPriceResult extends EffectiveNetFloorResult {
  price?: number;
  priceMilli?: MilliCredits;
}

export interface MarketOrderSnapshot {
  id: string;
  type: MarketOrderSide;
  resourceType: string;
  price: number;
  amount: number;
  remainingAmount?: number;
  totalAmount?: number;
  roomName?: string;
  created?: number;
}

export interface OrderBookDepthPolicy {
  minOrderAmount: number;
  minOrderNotional?: number;
  minCumulativeDepth: number;
  minOrderCount?: number;
  minDistinctRooms?: number;
  maxDepthContributionPerOrder?: number;
  maxDepthContributionPerRoom?: number;
}

export type OrderBookRejectionReason =
  | "duplicate_order_id"
  | "side_mismatch"
  | "resource_mismatch"
  | "invalid_order"
  | "dust_amount"
  | "dust_notional";

export interface OrderBookRejection {
  orderId: string;
  reason: OrderBookRejectionReason;
}

export interface OrderBookDepthAssessment {
  trusted: boolean;
  eligibleOrders: MarketOrderSnapshot[];
  rejectedOrders: OrderBookRejection[];
  eligibleAmount: number;
  trustedDepth: number;
  distinctOrderCount: number;
  distinctRoomCount: number;
}

export interface AssessOrderBookInput {
  orders: readonly MarketOrderSnapshot[];
  side: MarketOrderSide;
  resourceType: string;
  policy: OrderBookDepthPolicy;
}

export type DirectOrderRejectionReason =
  | "book_depth_untrusted"
  | "deal_amount_below_minimum"
  | "quote_below_floor"
  | "invalid_energy_cost"
  | "energy_budget_exceeded"
  | "energy_cost_ratio_exceeded"
  | "net_price_below_floor";

export interface DirectOrderRejection {
  orderId?: string;
  reason: DirectOrderRejectionReason;
}

export interface DirectBuyOrderCandidate {
  order: MarketOrderSnapshot;
  dealAmount: number;
  partialOrderFill: boolean;
  transactionEnergy: number;
  transactionEnergyPerUnit: number;
  directNetPrice: number;
  grossCredits: number;
  netCreditsAfterEnergyShadow: number;
}

export interface RankDirectBuyOrdersInput {
  orders: readonly MarketOrderSnapshot[];
  resourceType: string;
  safeAmount: number;
  minDealAmount: number;
  absoluteQuoteFloor: number;
  effectiveNetFloor: number;
  energyShadowPrice: number;
  orderBookPolicy: OrderBookDepthPolicy;
  requireTrustedDepth?: boolean;
  maxTransactionEnergy?: number;
  maxTransactionEnergyCostRatio?: number;
  calculateTransactionEnergy: (amount: number, order: MarketOrderSnapshot) => number;
}

export interface DirectBuyOrderRanking {
  book: OrderBookDepthAssessment;
  executableBook: OrderBookDepthAssessment;
  candidates: DirectBuyOrderCandidate[];
  selected?: DirectBuyOrderCandidate;
  rejected: DirectOrderRejection[];
}

export type MarketPriceAction =
  | {
      kind: "create";
      amount: number;
    }
  | {
      kind: "extend";
      currentPrice: number;
      currentRemainingAmount: number;
      addAmount: number;
    }
  | {
      kind: "repriceUp";
      currentPrice: number;
      remainingAmount: number;
    }
  | {
      kind: "repriceDown";
      currentPrice: number;
      remainingAmount: number;
    };

export interface EvaluatePostActionInvariantInput {
  effectiveNetFloor: number;
  feeDebtMilli: MilliCredits;
  action: MarketPriceAction;
  candidatePrice?: number;
}

export interface PostActionInvariantEvaluation {
  action: MarketPriceAction["kind"];
  candidatePrice: number;
  candidatePriceMilli: MilliCredits;
  postRemainingAmount: number;
  prospectiveFeeMilli: MilliCredits;
  postActionFeeDebtMilli: MilliCredits;
  grossRemainingValueMilli: MilliCredits;
  netRemainingValueMilli: MilliCredits;
  requiredNetValueMilli: MilliCredits;
  satisfiesInvariant: boolean;
}

export interface FindMinimumSafePriceInput {
  effectiveNetFloor: number;
  feeDebtMilli: MilliCredits;
  action: MarketPriceAction;
  maxPrice?: number;
}

export interface MinimumSafePriceResult {
  safe: boolean;
  reason?: "no_safe_price_within_limit" | "no_safe_down_reprice" | "current_extend_price_unsafe";
  minimumSafePrice: number;
  minimumSafePriceMilli: MilliCredits;
  recommendedPrice?: number;
  evaluation?: PostActionInvariantEvaluation;
}

export interface AllocateFeeDebtInput {
  feeDebtMilli: MilliCredits;
  filledAmount: number;
  preRemainingAmount: number;
}

export interface FeeDebtAllocation {
  allocatedFeeDebtMilli: MilliCredits;
  remainingFeeDebtMilli: MilliCredits;
  postRemainingAmount: number;
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function assertSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} exceeds safe integer precision`);
  }
  return value;
}

function scaledIntegerTolerance(scaled: number): number {
  return Number.EPSILON * Math.max(1, Math.abs(scaled)) * 8;
}

function ceilScaledInteger(value: number, scale: number): number {
  const scaled = value * scale;
  const nearestInteger = Math.round(scaled);
  const floatingTolerance = scaledIntegerTolerance(scaled);
  return Math.abs(scaled - nearestInteger) <= floatingTolerance
    ? nearestInteger
    : Math.ceil(scaled);
}

function floorScaledInteger(value: number, scale: number): number {
  const scaled = value * scale;
  const nearestInteger = Math.round(scaled);
  const floatingTolerance = scaledIntegerTolerance(scaled);
  return Math.abs(scaled - nearestInteger) <= floatingTolerance
    ? nearestInteger
    : Math.floor(scaled);
}

function ceilDivide(numerator: number, denominator: number): number {
  assertNonNegativeInteger(numerator, "numerator");
  assertPositiveInteger(denominator, "denominator");
  return Math.floor(numerator / denominator) + (numerator % denominator === 0 ? 0 : 1);
}

function isValidIsoDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date;
}

function isoDateDayNumber(date: string): number {
  if (!isValidIsoDate(date)) {
    throw new RangeError(`invalid ISO date: ${date}`);
  }
  return Math.floor(Date.parse(`${date}T00:00:00.000Z`) / MILLISECONDS_PER_DAY);
}

function normalizeHistoryOptions(options: TrustedHistoryOptions): Required<Omit<TrustedHistoryOptions, "resourceType">> & {
  resourceType?: string;
} {
  if (!isValidIsoDate(options.asOfDate)) {
    throw new RangeError("asOfDate must be a valid YYYY-MM-DD date");
  }
  assertPositiveInteger(options.minTransactionsPerDay, "minTransactionsPerDay");
  if (!isFinitePositive(options.minVolumePerDay)) {
    throw new RangeError("minVolumePerDay must be positive");
  }

  const requestedMinValidDays =
    options.minValidDays ?? MIN_TRUSTED_HISTORY_DAYS;
  assertPositiveInteger(requestedMinValidDays, "minValidDays");
  const minValidDays = Math.max(MIN_TRUSTED_HISTORY_DAYS, requestedMinValidDays);
  const logMadZThreshold = options.logMadZThreshold ?? 3.5;
  const maxSqrtVolumeWeightMultiple = options.maxSqrtVolumeWeightMultiple ?? 3;
  const historyFloorRatio = options.historyFloorRatio ?? 1;

  if (!isFinitePositive(logMadZThreshold)) {
    throw new RangeError("logMadZThreshold must be positive");
  }
  if (!isFinitePositive(maxSqrtVolumeWeightMultiple)) {
    throw new RangeError("maxSqrtVolumeWeightMultiple must be positive");
  }
  if (!isFinitePositive(historyFloorRatio)) {
    throw new RangeError("historyFloorRatio must be positive");
  }

  return {
    asOfDate: options.asOfDate,
    resourceType: options.resourceType,
    minValidDays,
    minTransactionsPerDay: options.minTransactionsPerDay,
    minVolumePerDay: options.minVolumePerDay,
    logMadZThreshold,
    maxSqrtVolumeWeightMultiple,
    historyFloorRatio,
  };
}

export function median(values: readonly number[]): number | null {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 === 1
    ? finite[middle]
    : (finite[middle - 1] + finite[middle]) / 2;
}

export function weightedMedian(values: readonly WeightedValue[]): number | null {
  const valid = values
    .filter((entry) => Number.isFinite(entry.value) && isFinitePositive(entry.weight))
    .sort((left, right) => left.value - right.value);
  if (valid.length === 0) return null;

  const totalWeight = valid.reduce((sum, entry) => sum + entry.weight, 0);
  const midpoint = totalWeight / 2;
  let cumulative = 0;
  for (const entry of valid) {
    cumulative += entry.weight;
    if (cumulative >= midpoint) return entry.value;
  }
  return valid[valid.length - 1].value;
}

/**
 * Compress every room to one representative quote, then give every room one
 * equal vote. The upper middle quote is used for an even room count because a
 * sell-side safety anchor must not be pulled down by one low-price room.
 */
export function roomBalancedMedianPrice(
  orders: readonly MarketOrderSnapshot[],
  maxWeightPerOrder: number,
): number | null {
  assertPositiveInteger(maxWeightPerOrder, "maxWeightPerOrder");
  const byRoom = new Map<string, WeightedValue[]>();
  for (const order of orders) {
    if (
      typeof order.roomName !== "string" ||
      order.roomName.length === 0 ||
      !isFinitePositive(order.price) ||
      !Number.isSafeInteger(order.amount) ||
      order.amount <= 0
    ) {
      continue;
    }
    const values = byRoom.get(order.roomName) || [];
    values.push({
      value: order.price,
      weight: Math.min(order.amount, maxWeightPerOrder),
    });
    byRoom.set(order.roomName, values);
  }

  const roomPrices = [...byRoom.values()]
    .map((values) => weightedMedian(values))
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  if (roomPrices.length === 0) return null;
  return roomPrices[Math.floor(roomPrices.length / 2)];
}

export function priceToMilliUp(price: number): MilliCredits {
  if (!isFinitePositive(price)) {
    throw new RangeError("price must be a finite positive number");
  }
  return assertSafeInteger(
    ceilScaledInteger(price, MILLI_CREDITS_PER_CREDIT),
    "price in milli-credits",
  );
}

export function roundMarketPriceUp(price: number): number {
  return priceToMilliUp(price) / MILLI_CREDITS_PER_CREDIT;
}

export function priceToMilliDown(price: number): MilliCredits {
  if (!isFinitePositive(price)) {
    throw new RangeError("price must be a finite positive number");
  }
  return assertSafeInteger(
    floorScaledInteger(price, MILLI_CREDITS_PER_CREDIT),
    "price cap in milli-credits",
  );
}

/** Convert a credit amount to integer milli-credits using conservative upward rounding. */
export function ceilMilli(credits: number): MilliCredits {
  assertFiniteNonNegative(credits, "credits");
  return assertSafeInteger(
    ceilScaledInteger(credits, MILLI_CREDITS_PER_CREDIT),
    "credits in milli-credits",
  );
}

export function milliToCredits(milliCredits: MilliCredits): number {
  assertNonNegativeInteger(milliCredits, "milliCredits");
  return milliCredits / MILLI_CREDITS_PER_CREDIT;
}

export function calculateOrderFeeMilli(price: number, amount: number): MilliCredits {
  assertPositiveInteger(amount, "amount");
  const priceMilli = priceToMilliUp(price);
  const rawFeeMilliNumerator = assertSafeInteger(
    priceMilli * amount,
    "order fee numerator",
  );
  return ceilDivide(rawFeeMilliNumerator, MARKET_ORDER_FEE_DIVISOR);
}

export function calculatePriceIncreaseFeeMilli(
  currentPrice: number,
  candidatePrice: number,
  remainingAmount: number,
): MilliCredits {
  assertPositiveInteger(remainingAmount, "remainingAmount");
  const currentPriceMilli = priceToMilliUp(currentPrice);
  const candidatePriceMilli = priceToMilliUp(candidatePrice);
  if (candidatePriceMilli <= currentPriceMilli) return 0;
  const numerator = assertSafeInteger(
    (candidatePriceMilli - currentPriceMilli) * remainingAmount,
    "price increase fee numerator",
  );
  return ceilDivide(numerator, MARKET_ORDER_FEE_DIVISOR);
}

export function buildTrustedHistoryFloor(
  days: readonly MarketHistoryDay[],
  rawOptions: TrustedHistoryOptions,
): TrustedHistoryResult {
  const options = normalizeHistoryOptions(rawOptions);
  const rejectedDays: HistoryDayRejection[] = [];
  const syntacticallyValidDateCounts = new Map<string, number>();

  for (const day of days) {
    if (!isValidIsoDate(day.date)) continue;
    syntacticallyValidDateCounts.set(
      day.date,
      (syntacticallyValidDateCounts.get(day.date) || 0) + 1,
    );
  }

  const completeDays: MarketHistoryDay[] = [];
  for (const day of days) {
    if (!isValidIsoDate(day.date)) {
      rejectedDays.push({ date: day.date, reason: "invalid_date" });
      continue;
    }
    if (day.complete === false || day.date >= options.asOfDate) {
      rejectedDays.push({ date: day.date, reason: "incomplete_day" });
      continue;
    }
    if (options.resourceType !== undefined && day.resourceType !== options.resourceType) {
      rejectedDays.push({ date: day.date, reason: "resource_mismatch" });
      continue;
    }
    if ((syntacticallyValidDateCounts.get(day.date) || 0) > 1) {
      rejectedDays.push({ date: day.date, reason: "duplicate_date" });
      continue;
    }
    if (
      !isFinitePositive(day.avgPrice) ||
      !Number.isSafeInteger(day.transactions) ||
      day.transactions <= 0 ||
      !isFinitePositive(day.volume)
    ) {
      rejectedDays.push({ date: day.date, reason: "invalid_values" });
      continue;
    }
    if (day.transactions < options.minTransactionsPerDay) {
      rejectedDays.push({ date: day.date, reason: "transactions_below_minimum" });
      continue;
    }
    if (day.volume < options.minVolumePerDay) {
      rejectedDays.push({ date: day.date, reason: "volume_below_minimum" });
      continue;
    }
    completeDays.push(day);
  }

  if (completeDays.length < options.minValidDays) {
    return {
      trusted: false,
      reason: "insufficient_complete_days",
      completeDayCount: completeDays.length,
      acceptedDayCount: 0,
      acceptedDates: [],
      rejectedDays,
    };
  }

  const logPrices = completeDays.map((day) => Math.log(day.avgPrice));
  const medianLogPrice = median(logPrices)!;
  const deviations = logPrices.map((value) => Math.abs(value - medianLogPrice));
  const madLogPrice = median(deviations)!;
  const scaledMad = madLogPrice * LOG_MAD_SCALE;

  const acceptedDays: MarketHistoryDay[] = [];
  for (let index = 0; index < completeDays.length; index += 1) {
    const deviation = deviations[index];
    const isOutlier = scaledMad <= ZERO_MAD_EPSILON
      ? deviation > ZERO_MAD_EPSILON
      : deviation > options.logMadZThreshold * scaledMad;
    if (isOutlier) {
      rejectedDays.push({
        date: completeDays[index].date,
        reason: "log_mad_outlier",
      });
      continue;
    }
    acceptedDays.push(completeDays[index]);
  }

  if (acceptedDays.length < options.minValidDays) {
    return {
      trusted: false,
      reason: "insufficient_days_after_outlier_filter",
      medianLogPrice,
      madLogPrice,
      completeDayCount: completeDays.length,
      acceptedDayCount: acceptedDays.length,
      acceptedDates: acceptedDays.map((day) => day.date).sort(),
      rejectedDays,
    };
  }

  const rawWeights = acceptedDays.map((day) => Math.sqrt(day.volume));
  const medianWeight = median(rawWeights)!;
  const maximumWeight = medianWeight * options.maxSqrtVolumeWeightMultiple;
  const referencePrice = weightedMedian(
    acceptedDays.map((day, index) => ({
      value: day.avgPrice,
      weight: Math.min(rawWeights[index], maximumWeight),
    })),
  )!;
  const trustedFloor = roundMarketPriceUp(referencePrice * options.historyFloorRatio);
  const acceptedDates = acceptedDays.map((day) => day.date).sort();

  return {
    trusted: true,
    latestHistoryDate: acceptedDates[acceptedDates.length - 1],
    referencePrice,
    trustedFloor,
    medianLogPrice,
    madLogPrice,
    completeDayCount: completeDays.length,
    acceptedDayCount: acceptedDays.length,
    acceptedDates,
    rejectedDays,
  };
}

export function advanceTrustedFloor(
  previous: TrustedFloorState | undefined,
  observation: TrustedFloorObservation,
  options: TrustedFloorAdvanceOptions = {},
): TrustedFloorAdvanceResult {
  if (!isValidIsoDate(observation.historyDate)) {
    throw new RangeError("observation.historyDate must be a valid YYYY-MM-DD date");
  }
  if (!isFinitePositive(observation.floor)) {
    throw new RangeError("observation.floor must be positive");
  }

  const observedFloor = roundMarketPriceUp(observation.floor);
  if (!previous) {
    const state: TrustedFloorState = {
      historyDate: observation.historyDate,
      floor: observedFloor,
      observedFloor,
    };
    return {
      state,
      changed: true,
      daysAdvanced: 0,
      ratchetFloor: observedFloor,
      reason: "initialized",
    };
  }

  if (!isValidIsoDate(previous.historyDate) || !isFinitePositive(previous.floor)) {
    throw new RangeError("previous trusted floor state is invalid");
  }
  const previousState: TrustedFloorState = {
    historyDate: previous.historyDate,
    floor: roundMarketPriceUp(previous.floor),
    observedFloor: roundMarketPriceUp(previous.observedFloor),
  };
  if (observation.historyDate === previous.historyDate) {
    return {
      state: previousState,
      changed: false,
      daysAdvanced: 0,
      ratchetFloor: previousState.floor,
      reason: "same_history_day",
    };
  }
  if (observation.historyDate < previous.historyDate) {
    return {
      state: previousState,
      changed: false,
      daysAdvanced: 0,
      ratchetFloor: previousState.floor,
      reason: "older_history_day",
    };
  }

  const maxDailyDropRatio = options.maxDailyDropRatio ?? 0.05;
  if (!Number.isFinite(maxDailyDropRatio) || maxDailyDropRatio < 0 || maxDailyDropRatio >= 1) {
    throw new RangeError("maxDailyDropRatio must be in [0, 1)");
  }
  const daysAdvanced = Math.max(
    1,
    isoDateDayNumber(observation.historyDate) - isoDateDayNumber(previous.historyDate),
  );
  const ratchetFloor = roundMarketPriceUp(
    previousState.floor * Math.pow(1 - maxDailyDropRatio, daysAdvanced),
  );
  const nextFloor = roundMarketPriceUp(Math.max(observedFloor, ratchetFloor));
  return {
    state: {
      historyDate: observation.historyDate,
      floor: nextFloor,
      observedFloor,
    },
    changed: nextFloor !== previousState.floor || observation.historyDate !== previous.historyDate,
    daysAdvanced,
    ratchetFloor,
    reason: "advanced",
  };
}

export function computeEffectiveNetFloor(
  input: EffectiveNetFloorInput,
): EffectiveNetFloorResult {
  const components: EffectiveNetFloorResult["components"] = {};
  if (!isFinitePositive(input.hardFloor)) {
    return {
      valid: false,
      reason: "hard_floor_missing_or_invalid",
      components,
    };
  }

  const entries: Array<[EffectiveFloorComponent, number | undefined]> =
    input.dynamicFloor !== undefined && isFinitePositive(input.dynamicFloor)
      ? [
          ["hard", input.hardFloor],
          ["economic", input.economicFloor],
          ["dynamic", input.dynamicFloor],
        ]
      : [
          ["hard", input.hardFloor],
          ["economic", input.economicFloor],
          ["history", input.historyFloor],
          ["ratchet", input.ratchetFloor],
        ];
  let dominantComponent: EffectiveFloorComponent = "hard";
  let maximum = input.hardFloor;
  for (const [name, value] of entries) {
    if (value === undefined) continue;
    if (!isFinitePositive(value)) {
      return {
        valid: false,
        reason: "component_invalid",
        components,
      };
    }
    components[name] = value;
    if (value > maximum) {
      maximum = value;
      dominantComponent = name;
    }
  }

  const floorMilli = priceToMilliUp(maximum);
  return {
    valid: true,
    floor: milliToCredits(floorMilli),
    floorMilli,
    dominantComponent,
    components,
  };
}

export function computeEnergyShadowPrice(
  input: EffectiveNetFloorInput,
): EnergyShadowPriceResult {
  const floor = computeEffectiveNetFloor(input);
  return {
    ...floor,
    price: floor.floor,
    priceMilli: floor.floorMilli,
  };
}

function normalizeDepthPolicy(policy: OrderBookDepthPolicy): Required<OrderBookDepthPolicy> {
  assertPositiveInteger(policy.minOrderAmount, "minOrderAmount");
  assertNonNegativeInteger(policy.minCumulativeDepth, "minCumulativeDepth");
  const minOrderNotional = policy.minOrderNotional ?? 0;
  const minOrderCount = policy.minOrderCount ?? 1;
  const minDistinctRooms = policy.minDistinctRooms ?? 1;
  const maxDepthContributionPerOrder =
    policy.maxDepthContributionPerOrder ?? Number.MAX_SAFE_INTEGER;
  const maxDepthContributionPerRoom =
    policy.maxDepthContributionPerRoom ?? Number.MAX_SAFE_INTEGER;
  assertFiniteNonNegative(minOrderNotional, "minOrderNotional");
  assertPositiveInteger(minOrderCount, "minOrderCount");
  assertPositiveInteger(minDistinctRooms, "minDistinctRooms");
  assertPositiveInteger(maxDepthContributionPerOrder, "maxDepthContributionPerOrder");
  assertPositiveInteger(maxDepthContributionPerRoom, "maxDepthContributionPerRoom");
  return {
    minOrderAmount: policy.minOrderAmount,
    minOrderNotional,
    minCumulativeDepth: policy.minCumulativeDepth,
    minOrderCount,
    minDistinctRooms,
    maxDepthContributionPerOrder,
    maxDepthContributionPerRoom,
  };
}

export function assessOrderBookDepth(
  input: AssessOrderBookInput,
): OrderBookDepthAssessment {
  const policy = normalizeDepthPolicy(input.policy);
  const eligibleOrders: MarketOrderSnapshot[] = [];
  const rejectedOrders: OrderBookRejection[] = [];
  const seenOrderIds = new Set<string>();
  const distinctRooms = new Set<string>();
  const trustedDepthByRoom = new Map<string, number>();
  let eligibleAmount = 0;
  let trustedDepth = 0;

  for (const order of input.orders) {
    if (seenOrderIds.has(order.id)) {
      rejectedOrders.push({ orderId: order.id, reason: "duplicate_order_id" });
      continue;
    }
    seenOrderIds.add(order.id);
    if (order.type !== input.side) {
      rejectedOrders.push({ orderId: order.id, reason: "side_mismatch" });
      continue;
    }
    if (order.resourceType !== input.resourceType) {
      rejectedOrders.push({ orderId: order.id, reason: "resource_mismatch" });
      continue;
    }
    if (
      typeof order.id !== "string" ||
      order.id.length === 0 ||
      !isFinitePositive(order.price) ||
      !Number.isSafeInteger(order.amount) ||
      order.amount <= 0 ||
      typeof order.roomName !== "string" ||
      order.roomName.length === 0
    ) {
      rejectedOrders.push({ orderId: order.id, reason: "invalid_order" });
      continue;
    }
    if (order.amount < policy.minOrderAmount) {
      rejectedOrders.push({ orderId: order.id, reason: "dust_amount" });
      continue;
    }
    if (order.price * order.amount < policy.minOrderNotional) {
      rejectedOrders.push({ orderId: order.id, reason: "dust_notional" });
      continue;
    }

    eligibleOrders.push(order);
    distinctRooms.add(order.roomName);
    eligibleAmount = assertSafeInteger(
      eligibleAmount + order.amount,
      "eligible order amount",
    );
    const previousRoomDepth = trustedDepthByRoom.get(order.roomName) || 0;
    const roomRemaining = Math.max(
      0,
      policy.maxDepthContributionPerRoom - previousRoomDepth,
    );
    const depthContribution = Math.min(
      order.amount,
      policy.maxDepthContributionPerOrder,
      roomRemaining,
    );
    trustedDepthByRoom.set(
      order.roomName,
      assertSafeInteger(
        previousRoomDepth + depthContribution,
        "trusted room depth",
      ),
    );
    trustedDepth = assertSafeInteger(
      trustedDepth + depthContribution,
      "trusted order depth",
    );
  }

  return {
    trusted:
      eligibleOrders.length >= policy.minOrderCount &&
      distinctRooms.size >= policy.minDistinctRooms &&
      trustedDepth >= policy.minCumulativeDepth,
    eligibleOrders,
    rejectedOrders,
    eligibleAmount,
    trustedDepth,
    distinctOrderCount: eligibleOrders.length,
    distinctRoomCount: distinctRooms.size,
  };
}

export function rankDirectBuyOrders(
  input: RankDirectBuyOrdersInput,
): DirectBuyOrderRanking {
  assertPositiveInteger(input.safeAmount, "safeAmount");
  assertPositiveInteger(input.minDealAmount, "minDealAmount");
  if (!isFinitePositive(input.absoluteQuoteFloor)) {
    throw new RangeError("absoluteQuoteFloor must be positive");
  }
  if (!isFinitePositive(input.effectiveNetFloor)) {
    throw new RangeError("effectiveNetFloor must be positive");
  }
  assertFiniteNonNegative(input.energyShadowPrice, "energyShadowPrice");
  if (input.maxTransactionEnergy !== undefined) {
    assertFiniteNonNegative(input.maxTransactionEnergy, "maxTransactionEnergy");
  }
  if (input.maxTransactionEnergyCostRatio !== undefined) {
    assertFiniteNonNegative(
      input.maxTransactionEnergyCostRatio,
      "maxTransactionEnergyCostRatio",
    );
  }

  const book = assessOrderBookDepth({
    orders: input.orders,
    side: "buy",
    resourceType: input.resourceType,
    policy: input.orderBookPolicy,
  });
  const rejected: DirectOrderRejection[] = [];
  if ((input.requireTrustedDepth ?? true) && !book.trusted) {
    rejected.push({ reason: "book_depth_untrusted" });
    return {
      book,
      executableBook: {
        trusted: false,
        eligibleOrders: [],
        rejectedOrders: [],
        eligibleAmount: 0,
        trustedDepth: 0,
        distinctOrderCount: 0,
        distinctRoomCount: 0,
      },
      candidates: [],
      rejected,
    };
  }

  const candidates: DirectBuyOrderCandidate[] = [];
  for (const order of book.eligibleOrders) {
    const dealAmount = Math.min(input.safeAmount, order.amount);
    if (dealAmount < input.minDealAmount) {
      rejected.push({ orderId: order.id, reason: "deal_amount_below_minimum" });
      continue;
    }
    if (order.price < input.absoluteQuoteFloor) {
      rejected.push({ orderId: order.id, reason: "quote_below_floor" });
      continue;
    }

    let transactionEnergy: number;
    try {
      transactionEnergy = input.calculateTransactionEnergy(dealAmount, order);
    } catch {
      rejected.push({ orderId: order.id, reason: "invalid_energy_cost" });
      continue;
    }
    if (!Number.isFinite(transactionEnergy) || transactionEnergy < 0) {
      rejected.push({ orderId: order.id, reason: "invalid_energy_cost" });
      continue;
    }
    if (
      input.maxTransactionEnergy !== undefined &&
      transactionEnergy > input.maxTransactionEnergy
    ) {
      rejected.push({ orderId: order.id, reason: "energy_budget_exceeded" });
      continue;
    }

    const transactionEnergyPerUnit = transactionEnergy / dealAmount;
    if (
      input.maxTransactionEnergyCostRatio !== undefined &&
      transactionEnergyPerUnit > input.maxTransactionEnergyCostRatio
    ) {
      rejected.push({ orderId: order.id, reason: "energy_cost_ratio_exceeded" });
      continue;
    }
    const directNetPrice =
      order.price - transactionEnergyPerUnit * input.energyShadowPrice;
    if (directNetPrice < input.effectiveNetFloor) {
      rejected.push({ orderId: order.id, reason: "net_price_below_floor" });
      continue;
    }

    const grossCredits = order.price * dealAmount;
    const netCreditsAfterEnergyShadow =
      grossCredits - transactionEnergy * input.energyShadowPrice;
    candidates.push({
      order,
      dealAmount,
      partialOrderFill: dealAmount < order.amount,
      transactionEnergy,
      transactionEnergyPerUnit,
      directNetPrice,
      grossCredits,
      netCreditsAfterEnergyShadow,
    });
  }

  candidates.sort((left, right) =>
    right.directNetPrice - left.directNetPrice ||
    right.netCreditsAfterEnergyShadow - left.netCreditsAfterEnergyShadow ||
    right.order.price - left.order.price ||
    left.order.id.localeCompare(right.order.id),
  );
  const executableBook = assessOrderBookDepth({
    orders: candidates.map((candidate) => candidate.order),
    side: "buy",
    resourceType: input.resourceType,
    policy: input.orderBookPolicy,
  });
  if ((input.requireTrustedDepth ?? true) && !executableBook.trusted) {
    rejected.push({ reason: "book_depth_untrusted" });
    return {
      book,
      executableBook,
      candidates: [],
      rejected,
    };
  }
  return {
    book,
    executableBook,
    candidates,
    selected: candidates[0],
    rejected,
  };
}

function normalizeActionAmount(action: MarketPriceAction): void {
  switch (action.kind) {
    case "create":
      assertPositiveInteger(action.amount, "amount");
      break;
    case "extend":
      assertNonNegativeInteger(action.currentRemainingAmount, "currentRemainingAmount");
      assertPositiveInteger(action.addAmount, "addAmount");
      priceToMilliUp(action.currentPrice);
      break;
    case "repriceUp":
    case "repriceDown":
      assertPositiveInteger(action.remainingAmount, "remainingAmount");
      priceToMilliUp(action.currentPrice);
      break;
  }
}

function getPostRemainingAmount(action: MarketPriceAction): number {
  switch (action.kind) {
    case "create":
      return action.amount;
    case "extend":
      return assertSafeInteger(
        action.currentRemainingAmount + action.addAmount,
        "post-extend remaining amount",
      );
    case "repriceUp":
    case "repriceDown":
      return action.remainingAmount;
  }
}

function getActionCandidatePriceMilli(
  action: MarketPriceAction,
  candidatePrice?: number,
): MilliCredits {
  if (action.kind === "extend") {
    return priceToMilliUp(action.currentPrice);
  }
  if (candidatePrice === undefined) {
    throw new RangeError("candidatePrice is required for this action");
  }
  const candidatePriceMilli = priceToMilliUp(candidatePrice);
  if (action.kind === "repriceUp") {
    if (candidatePriceMilli <= priceToMilliUp(action.currentPrice)) {
      throw new RangeError("repriceUp candidate must be above current price");
    }
  } else if (action.kind === "repriceDown") {
    if (candidatePriceMilli > priceToMilliUp(action.currentPrice)) {
      throw new RangeError("repriceDown candidate must not exceed current price");
    }
  }
  return candidatePriceMilli;
}

function calculateProspectiveFeeMilliFromPrice(
  action: MarketPriceAction,
  candidatePriceMilli: MilliCredits,
): MilliCredits {
  switch (action.kind) {
    case "create": {
      const numerator = assertSafeInteger(
        candidatePriceMilli * action.amount,
        "create fee numerator",
      );
      return ceilDivide(numerator, MARKET_ORDER_FEE_DIVISOR);
    }
    case "extend":
      return calculateOrderFeeMilli(action.currentPrice, action.addAmount);
    case "repriceUp": {
      const currentPriceMilli = priceToMilliUp(action.currentPrice);
      const numerator = assertSafeInteger(
        (candidatePriceMilli - currentPriceMilli) * action.remainingAmount,
        "up-reprice fee numerator",
      );
      return ceilDivide(numerator, MARKET_ORDER_FEE_DIVISOR);
    }
    case "repriceDown":
      return 0;
  }
}

export function calculateProspectiveFeeMilli(
  action: MarketPriceAction,
  candidatePrice?: number,
): MilliCredits {
  normalizeActionAmount(action);
  const candidatePriceMilli = getActionCandidatePriceMilli(action, candidatePrice);
  return calculateProspectiveFeeMilliFromPrice(action, candidatePriceMilli);
}

/**
 * 编排层在执行 create/extend/reprice 前调用：候选价格、现有费用债务和本次预期费用
 * 都在 milli-credit 固定点中结算，返回值可直接作为动作放行条件。
 */
export function evaluatePostActionInvariant(
  input: EvaluatePostActionInvariantInput,
): PostActionInvariantEvaluation {
  normalizeActionAmount(input.action);
  assertNonNegativeInteger(input.feeDebtMilli, "feeDebtMilli");
  const floorMilli = priceToMilliUp(input.effectiveNetFloor);
  const candidatePriceMilli = getActionCandidatePriceMilli(
    input.action,
    input.candidatePrice,
  );
  const postRemainingAmount = getPostRemainingAmount(input.action);
  const prospectiveFeeMilli = calculateProspectiveFeeMilliFromPrice(
    input.action,
    candidatePriceMilli,
  );
  const postActionFeeDebtMilli = assertSafeInteger(
    input.feeDebtMilli + prospectiveFeeMilli,
    "post-action fee debt",
  );
  const grossRemainingValueMilli = assertSafeInteger(
    candidatePriceMilli * postRemainingAmount,
    "gross remaining order value",
  );
  const netRemainingValueMilli = grossRemainingValueMilli - postActionFeeDebtMilli;
  const requiredNetValueMilli = assertSafeInteger(
    floorMilli * postRemainingAmount,
    "required net order value",
  );
  return {
    action: input.action.kind,
    candidatePrice: milliToCredits(candidatePriceMilli),
    candidatePriceMilli,
    postRemainingAmount,
    prospectiveFeeMilli,
    postActionFeeDebtMilli,
    grossRemainingValueMilli,
    netRemainingValueMilli,
    requiredNetValueMilli,
    satisfiesInvariant: netRemainingValueMilli >= requiredNetValueMilli,
  };
}

function findSafeCandidateMilli(
  input: FindMinimumSafePriceInput,
  startPriceMilli: MilliCredits,
): { priceMilli?: MilliCredits; evaluation?: PostActionInvariantEvaluation } {
  const maxPriceMilli = input.maxPrice === undefined
    ? Number.MAX_SAFE_INTEGER
    : priceToMilliDown(input.maxPrice);
  let candidatePriceMilli = Math.max(1, startPriceMilli);
  let attempts = 0;
  while (candidatePriceMilli <= maxPriceMilli && attempts < 10_000) {
    const candidatePrice = milliToCredits(candidatePriceMilli);
    const evaluation = evaluatePostActionInvariant({
      effectiveNetFloor: input.effectiveNetFloor,
      feeDebtMilli: input.feeDebtMilli,
      action: input.action,
      candidatePrice,
    });
    if (evaluation.satisfiesInvariant) {
      return { priceMilli: candidatePriceMilli, evaluation };
    }
    candidatePriceMilli += 1;
    attempts += 1;
  }
  return {};
}

export function findMinimumSafePrice(
  input: FindMinimumSafePriceInput,
): MinimumSafePriceResult {
  normalizeActionAmount(input.action);
  assertNonNegativeInteger(input.feeDebtMilli, "feeDebtMilli");
  const floorMilli = priceToMilliUp(input.effectiveNetFloor);
  const action = input.action;

  if (action.kind === "extend") {
    const postRemainingAmount = getPostRemainingAmount(action);
    const prospectiveFeeMilli = calculateOrderFeeMilli(
      action.currentPrice,
      action.addAmount,
    );
    const requiredGrossMilli = assertSafeInteger(
      floorMilli * postRemainingAmount +
        input.feeDebtMilli +
        prospectiveFeeMilli,
      "extend required gross value",
    );
    const minimumSafePriceMilli = ceilDivide(
      requiredGrossMilli,
      postRemainingAmount,
    );
    const evaluation = evaluatePostActionInvariant({
      effectiveNetFloor: input.effectiveNetFloor,
      feeDebtMilli: input.feeDebtMilli,
      action,
    });
    return {
      safe: evaluation.satisfiesInvariant,
      reason: evaluation.satisfiesInvariant
        ? undefined
        : "current_extend_price_unsafe",
      minimumSafePrice: milliToCredits(minimumSafePriceMilli),
      minimumSafePriceMilli,
      recommendedPrice: action.currentPrice,
      evaluation,
    };
  }

  const postRemainingAmount = getPostRemainingAmount(action);
  if (action.kind === "repriceDown") {
    const requiredGrossMilli = assertSafeInteger(
      floorMilli * postRemainingAmount + input.feeDebtMilli,
      "down-reprice required gross value",
    );
    const minimumSafePriceMilli = ceilDivide(
      requiredGrossMilli,
      postRemainingAmount,
    );
    const currentPriceMilli = priceToMilliUp(action.currentPrice);
    if (minimumSafePriceMilli > currentPriceMilli) {
      return {
        safe: false,
        reason: "no_safe_down_reprice",
        minimumSafePrice: milliToCredits(minimumSafePriceMilli),
        minimumSafePriceMilli,
      };
    }
    const evaluation = evaluatePostActionInvariant({
      effectiveNetFloor: input.effectiveNetFloor,
      feeDebtMilli: input.feeDebtMilli,
      action,
      candidatePrice: milliToCredits(minimumSafePriceMilli),
    });
    return {
      safe: evaluation.satisfiesInvariant,
      minimumSafePrice: milliToCredits(minimumSafePriceMilli),
      minimumSafePriceMilli,
      recommendedPrice: milliToCredits(minimumSafePriceMilli),
      evaluation,
    };
  }

  let startPriceMilli: number;
  if (action.kind === "create") {
    const requiredNetMilli = assertSafeInteger(
      floorMilli * postRemainingAmount + input.feeDebtMilli,
      "create required net value",
    );
    startPriceMilli = ceilDivide(
      assertSafeInteger(requiredNetMilli * MARKET_ORDER_FEE_DIVISOR, "create price numerator"),
      assertSafeInteger(
        (MARKET_ORDER_FEE_DIVISOR - 1) * postRemainingAmount,
        "create price denominator",
      ),
    );
  } else {
    const currentPriceMilli = priceToMilliUp(action.currentPrice);
    const requiredNetMilli = assertSafeInteger(
      floorMilli * postRemainingAmount + input.feeDebtMilli,
      "up-reprice required net value",
    );
    const numerator = Math.max(
      0,
      assertSafeInteger(
        requiredNetMilli * MARKET_ORDER_FEE_DIVISOR -
          currentPriceMilli * postRemainingAmount,
        "up-reprice price numerator",
      ),
    );
    startPriceMilli = Math.max(
      currentPriceMilli + 1,
      ceilDivide(
        numerator,
        assertSafeInteger(
          (MARKET_ORDER_FEE_DIVISOR - 1) * postRemainingAmount,
          "up-reprice price denominator",
        ),
      ),
    );
  }

  const found = findSafeCandidateMilli(input, startPriceMilli);
  if (found.priceMilli === undefined || !found.evaluation) {
    return {
      safe: false,
      reason: "no_safe_price_within_limit",
      minimumSafePrice: milliToCredits(startPriceMilli),
      minimumSafePriceMilli: startPriceMilli,
    };
  }
  return {
    safe: true,
    minimumSafePrice: milliToCredits(found.priceMilli),
    minimumSafePriceMilli: found.priceMilli,
    recommendedPrice: milliToCredits(found.priceMilli),
    evaluation: found.evaluation,
  };
}

function floorMultiplyRatio(
  value: number,
  multiplier: number,
  divisor: number,
): number {
  const quotient = Math.floor(value / divisor);
  const remainder = value % divisor;
  const remainderProduct = assertSafeInteger(
    remainder * multiplier,
    "proportional fee debt remainder product",
  );
  return assertSafeInteger(
    quotient * multiplier + Math.floor(remainderProduct / divisor),
    "proportional fee debt allocation",
  );
}

export function allocateFeeDebtForFill(
  input: AllocateFeeDebtInput,
): FeeDebtAllocation {
  assertNonNegativeInteger(input.feeDebtMilli, "feeDebtMilli");
  assertNonNegativeInteger(input.filledAmount, "filledAmount");
  assertPositiveInteger(input.preRemainingAmount, "preRemainingAmount");
  if (input.filledAmount > input.preRemainingAmount) {
    throw new RangeError("filledAmount cannot exceed preRemainingAmount");
  }

  const allocatedFeeDebtMilli = floorMultiplyRatio(
    input.feeDebtMilli,
    input.filledAmount,
    input.preRemainingAmount,
  );
  return {
    allocatedFeeDebtMilli,
    remainingFeeDebtMilli: input.feeDebtMilli - allocatedFeeDebtMilli,
    postRemainingAmount: input.preRemainingAmount - input.filledAmount,
  };
}
