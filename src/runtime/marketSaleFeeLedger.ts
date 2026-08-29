import {
  allocateFeeDebtForFill,
  type FeeDebtAllocation,
  type MilliCredits,
} from "@/runtime/marketSalePricing";

export const MAX_FEE_EVENTS = 256;
export const MAX_SAME_TICK_FEE_RESERVATIONS = 32;
export const MAX_PROCESSED_FILL_RECEIPTS = 256;
export const MAX_CARRIED_FEE_RESOURCES = 64;

export type FeeBearingMarketAction = "create" | "extend" | "reprice_up";

export interface MarketFeeEvent {
  id: string;
  tick: number;
  action: FeeBearingMarketAction;
  feeMilli: MilliCredits;
}

export interface SameTickFeeReservation {
  id: string;
  tick: number;
  action: FeeBearingMarketAction;
  feeMilli: MilliCredits;
  status: "reserved" | "committed";
}

export interface ProcessedFillReceipt {
  key: string;
  transactionId: string;
  orderId: string;
  tick: number;
  filledAmount: number;
  preRemainingAmount: number;
  allocatedFeeDebtMilli: MilliCredits;
}

export interface FeeLedgerReconcileGap {
  reason:
    | "unknown_disappearance"
    | "external_order_mutation"
    | "server_expiry_refund_mismatch"
    | "fill_receipt_conflict"
    | "fill_receipt_capacity";
  orderId: string;
  observedAt: number;
  transactionId?: string;
}

export interface MarketSaleFeeLedgerState {
  feeEvents: MarketFeeEvent[];
  sameTickReservations: SameTickFeeReservation[];
  processedFills: ProcessedFillReceipt[];
  carriedFeeDebtMilli: Partial<Record<MarketResourceConstant, MilliCredits>>;
  reconcileGap?: FeeLedgerReconcileGap;
  /**
   * fail-closed blocker：持久化账本被内容级校验判定损坏后写入。
   * 存在期间一切 fee-bearing 操作（create/extend/reprice）与账本写入
   * 均被禁止；仅 operator 显式修复（resolveFeeLedgerInvalid）可清除。
   */
  invalid?: FeeLedgerInvalidMarker;
}

export interface FeeLedgerInvalidMarker {
  /** 校验失败原因（validateFeeLedger 的 RangeError message）。 */
  reason: string;
  /** blocker 写入 tick。 */
  observedAt: number;
  /**
   * 损坏账本的原始证据（有界 JSON 摘要）。证据随 ledger 自身持久化，
   * 不依赖 direct quarantine 的合并行为；operator 修复时随 blocker 一并
   * 清除（修复动作即证据处置决定，operatorAudit 保留 reason 摘要）。
   */
  rawEvidenceJson?: string;
}

/** 内容级校验结果：损坏时绝不静默替换为空账本（fail-closed）。 */
export type FeeLedgerValidationResult =
  | { status: "valid"; ledger: MarketSaleFeeLedgerState | undefined }
  | { status: "invalid"; reason: string };

export interface FeeLedgerLimits {
  feeWindowTicks: number;
  fillReceiptWindowTicks: number;
  maxFeeEvents?: number;
  maxSameTickReservations?: number;
  maxProcessedFills?: number;
}

interface NormalizedFeeLedgerLimits {
  feeWindowTicks: number;
  fillReceiptWindowTicks: number;
  maxFeeEvents: number;
  maxSameTickReservations: number;
  maxProcessedFills: number;
}

export interface OrderSlotGateState {
  usedOrderSlots: number;
  totalOrderSlots: number;
  minFreeOrderSlots: number;
  managedOrderCount: number;
  maxManagedOrders: number;
}

export interface ProspectiveFeeGateInput {
  ledger: MarketSaleFeeLedgerState;
  gameTime: number;
  action: FeeBearingMarketAction;
  prospectiveFeeMilli: MilliCredits;
  creditsMilli: MilliCredits;
  creditReserveMilli: MilliCredits;
  rollingFeeBudgetMilli: MilliCredits;
  limits: FeeLedgerLimits;
  orderSlots?: OrderSlotGateState;
}

export type ProspectiveFeeGateRejection =
  | "fee_ledger_invalid"
  | "reconcile_gap"
  | "credit_reserve"
  | "rolling_fee_budget"
  | "fee_event_capacity"
  | "reservation_capacity"
  | "reservation_already_exists"
  | "order_slot_state_missing"
  | "order_slot_state_invalid"
  | "free_order_slots"
  | "managed_order_limit";

export interface ProspectiveFeeGateResult {
  allowed: boolean;
  reasons: ProspectiveFeeGateRejection[];
  ledger: MarketSaleFeeLedgerState;
  rollingFeeMilli: MilliCredits;
  reservedThisTickMilli: MilliCredits;
  projectedRollingFeeMilli: MilliCredits;
  projectedCreditsMilli: MilliCredits;
  freeOrderSlotsAfter?: number;
}

export interface ReserveProspectiveFeeInput extends ProspectiveFeeGateInput {
  reservationId: string;
}

export interface ReserveProspectiveFeeResult extends ProspectiveFeeGateResult {
  alreadyReserved: boolean;
}

export interface ApplyFillFeeDebtResult {
  ledger: MarketSaleFeeLedgerState;
  applied: boolean;
  duplicate: boolean;
  reconcileGap: boolean;
  allocation?: FeeDebtAllocation;
}

export type OrderDisappearanceReason =
  | "policy_cancelled"
  | "server_expired"
  | "unknown";

export interface ReconcileDisappearedOrderInput {
  ledger: MarketSaleFeeLedgerState;
  gameTime: number;
  orderId: string;
  resourceType: MarketResourceConstant;
  remainingFeeDebtMilli: MilliCredits;
  reason: OrderDisappearanceReason;
  /**
   * 仅由外部已确认的 server-expiry credits/refund 对账提供。
   * 本 helper 不读取或推断订单 created tick。
   */
  verifiedRefundMilli?: MilliCredits;
}

export interface ReconcileDisappearedOrderResult {
  ledger: MarketSaleFeeLedgerState;
  resolved: boolean;
  classification: "policy_cancelled" | "server_expired" | "reconcile_gap";
  refundedFeeDebtMilli: MilliCredits;
  carriedFeeDebtMilli: MilliCredits;
  preservedFeeDebtMilli: MilliCredits;
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function assertBoundedIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new RangeError(`${label} must contain 1-256 characters`);
  }
}

function assertFeeBearingAction(
  value: string,
  label: string,
): asserts value is FeeBearingMarketAction {
  if (value !== "create" && value !== "extend" && value !== "reprice_up") {
    throw new RangeError(`${label} is not a fee-bearing market action`);
  }
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${label} exceeds safe integer precision`);
  }
  return result;
}

function sumMilli(values: readonly number[], label: string): MilliCredits {
  return values.reduce((sum, value) => {
    assertNonNegativeSafeInteger(value, label);
    return safeAdd(sum, value, label);
  }, 0);
}

function normalizeLimit(
  value: number | undefined,
  fallback: number,
  hardMaximum: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  assertPositiveSafeInteger(normalized, label);
  if (normalized > hardMaximum) {
    throw new RangeError(`${label} cannot exceed ${hardMaximum}`);
  }
  return normalized;
}

function normalizeLimits(limits: FeeLedgerLimits): NormalizedFeeLedgerLimits {
  assertPositiveSafeInteger(limits.feeWindowTicks, "feeWindowTicks");
  assertPositiveSafeInteger(limits.fillReceiptWindowTicks, "fillReceiptWindowTicks");
  return {
    feeWindowTicks: limits.feeWindowTicks,
    fillReceiptWindowTicks: limits.fillReceiptWindowTicks,
    maxFeeEvents: normalizeLimit(
      limits.maxFeeEvents,
      MAX_FEE_EVENTS,
      MAX_FEE_EVENTS,
      "maxFeeEvents",
    ),
    maxSameTickReservations: normalizeLimit(
      limits.maxSameTickReservations,
      MAX_SAME_TICK_FEE_RESERVATIONS,
      MAX_SAME_TICK_FEE_RESERVATIONS,
      "maxSameTickReservations",
    ),
    maxProcessedFills: normalizeLimit(
      limits.maxProcessedFills,
      MAX_PROCESSED_FILL_RECEIPTS,
      MAX_PROCESSED_FILL_RECEIPTS,
      "maxProcessedFills",
    ),
  };
}

function cloneLedger(ledger: MarketSaleFeeLedgerState): MarketSaleFeeLedgerState {
  return {
    feeEvents: ledger.feeEvents.map(event => ({ ...event })),
    sameTickReservations: ledger.sameTickReservations.map(reservation => ({ ...reservation })),
    processedFills: ledger.processedFills.map(receipt => ({ ...receipt })),
    carriedFeeDebtMilli: { ...ledger.carriedFeeDebtMilli },
    reconcileGap: ledger.reconcileGap ? { ...ledger.reconcileGap } : undefined,
    // fail-closed blocker 随账本克隆传播，窗口推进/克隆不得洗掉。
    invalid: ledger.invalid ? { ...ledger.invalid } : undefined,
  };
}

function validateFeeEvent(event: MarketFeeEvent): void {
  assertBoundedIdentifier(event.id, "fee event id");
  assertFeeBearingAction(event.action, "fee event action");
  assertNonNegativeSafeInteger(event.tick, "fee event tick");
  assertNonNegativeSafeInteger(event.feeMilli, "fee event feeMilli");
}

function validateReservation(reservation: SameTickFeeReservation): void {
  assertBoundedIdentifier(reservation.id, "fee reservation id");
  assertFeeBearingAction(reservation.action, "fee reservation action");
  assertNonNegativeSafeInteger(reservation.tick, "fee reservation tick");
  assertNonNegativeSafeInteger(reservation.feeMilli, "fee reservation feeMilli");
  if (reservation.status !== "reserved" && reservation.status !== "committed") {
    throw new RangeError("fee reservation status is invalid");
  }
}

function validateFillReceipt(receipt: ProcessedFillReceipt): void {
  assertBoundedIdentifier(receipt.key, "fill receipt key");
  assertBoundedIdentifier(receipt.transactionId, "transactionId");
  assertBoundedIdentifier(receipt.orderId, "orderId");
  assertNonNegativeSafeInteger(receipt.tick, "fill receipt tick");
  assertPositiveSafeInteger(receipt.filledAmount, "fill receipt filledAmount");
  assertPositiveSafeInteger(receipt.preRemainingAmount, "fill receipt preRemainingAmount");
  assertNonNegativeSafeInteger(
    receipt.allocatedFeeDebtMilli,
    "fill receipt allocatedFeeDebtMilli",
  );
}

function validateReconcileGap(gap: FeeLedgerReconcileGap): void {
  const reasons: readonly FeeLedgerReconcileGap["reason"][] = [
    "unknown_disappearance",
    "external_order_mutation",
    "server_expiry_refund_mismatch",
    "fill_receipt_conflict",
    "fill_receipt_capacity",
  ];
  assertBoundedIdentifier(gap.orderId, "reconcile gap orderId");
  if (!reasons.includes(gap.reason)) {
    throw new RangeError("reconcile gap reason is invalid");
  }
  assertNonNegativeSafeInteger(gap.observedAt, "reconcile gap observedAt");
  if (gap.transactionId !== undefined) {
    assertBoundedIdentifier(gap.transactionId, "reconcile gap transactionId");
  }
}

function validateInvalidMarker(
  marker: FeeLedgerInvalidMarker | undefined,
): void {
  if (marker === undefined) return;
  if (typeof marker !== "object" || Array.isArray(marker)) {
    throw new RangeError("fee ledger invalid marker is not a plain object");
  }
  if (
    typeof marker.reason !== "string" ||
    marker.reason.length === 0 ||
    marker.reason.length > 512
  ) {
    throw new RangeError("fee ledger invalid marker reason is malformed");
  }
  if (
    marker.rawEvidenceJson !== undefined &&
    typeof marker.rawEvidenceJson !== "string"
  ) {
    throw new RangeError("fee ledger invalid marker evidence is malformed");
  }
  assertNonNegativeSafeInteger(marker.observedAt, "invalid marker observedAt");
}

/**
 * 深恢复层的内容级校验（fail-closed）：对已持久化的 fee ledger 做逐条
 * 校验（同条目数但字段损坏也能检出）。损坏时返回 tagged invalid 结果
 * 与原因——绝不静默替换为空账本，否则「预算已耗尽但记录损坏」会被
 * 解释成「预算为零使用」。调用方负责隔离原始证据并写入
 * createFeeLedgerBlocked 的不可绕过 blocker。
 * 全部通过时原样返回传入引用（invalid blocker 形状合法的恢复中账本
 * 同样通过校验，blocker 由 gate 层持续生效）。
 */
export function validateFeeLedger(
  ledger: unknown,
): FeeLedgerValidationResult {
  if (ledger === undefined || ledger === null) {
    return { status: "valid", ledger: undefined };
  }
  try {
    if (typeof ledger !== "object" || Array.isArray(ledger)) {
      throw new RangeError("fee ledger is not a plain object");
    }
    const candidate = ledger as MarketSaleFeeLedgerState;
    if (!Array.isArray(candidate.feeEvents)) {
      throw new RangeError("feeEvents is not an array");
    }
    if (!Array.isArray(candidate.sameTickReservations)) {
      throw new RangeError("sameTickReservations is not an array");
    }
    if (!Array.isArray(candidate.processedFills)) {
      throw new RangeError("processedFills is not an array");
    }
    if (
      candidate.feeEvents.length > MAX_FEE_EVENTS ||
      candidate.sameTickReservations.length > MAX_SAME_TICK_FEE_RESERVATIONS ||
      candidate.processedFills.length > MAX_PROCESSED_FILL_RECEIPTS
    ) {
      throw new RangeError("fee ledger container exceeds hard cap");
    }
    if (
      candidate.carriedFeeDebtMilli === null ||
      typeof candidate.carriedFeeDebtMilli !== "object" ||
      Array.isArray(candidate.carriedFeeDebtMilli)
    ) {
      throw new RangeError("carriedFeeDebtMilli is not a plain object");
    }
    if (Object.keys(candidate.carriedFeeDebtMilli).length > MAX_CARRIED_FEE_RESOURCES) {
      throw new RangeError("carriedFeeDebtMilli exceeds resource cap");
    }
    for (const value of Object.values(candidate.carriedFeeDebtMilli)) {
      if (value === undefined) continue;
      assertNonNegativeSafeInteger(
        value,
        "carriedFeeDebtMilli entry",
      );
    }
    for (const event of candidate.feeEvents) validateFeeEvent(event);
    for (const reservation of candidate.sameTickReservations) {
      validateReservation(reservation);
    }
    for (const receipt of candidate.processedFills) {
      validateFillReceipt(receipt);
    }
    if (candidate.reconcileGap !== undefined) {
      validateReconcileGap(candidate.reconcileGap);
    }
    validateInvalidMarker(candidate.invalid);
    return { status: "valid", ledger: candidate };
  } catch (error) {
    return {
      status: "invalid",
      reason: error instanceof RangeError
        ? error.message
        : "fee ledger validation threw",
    };
  }
}

/**
 * 损坏账本的 fail-closed 替身：空窗口 + 不可绕过 invalid blocker（附
 * 有界原始证据摘要）。空窗口只是「安全读取默认值」（gate 会因 blocker
 * 拒绝一切费用操作），不是对预算状态的重新解释。
 */
export function createFeeLedgerBlocked(
  reason: string,
  observedAt: number,
  rawEvidence?: unknown,
): MarketSaleFeeLedgerState {
  if (
    typeof reason !== "string" ||
    reason.length === 0 ||
    reason.length > 512
  ) {
    throw new RangeError("fee ledger blocker reason is malformed");
  }
  assertNonNegativeSafeInteger(observedAt, "fee ledger blocker observedAt");
  let rawEvidenceJson: string | undefined;
  if (rawEvidence !== undefined) {
    try {
      rawEvidenceJson = JSON.stringify(rawEvidence);
    } catch {
      rawEvidenceJson = "\"<unserializable>\"";
    }
    // 有界：截断超长证据（损坏账本本身受容器上限约束，正常远小于此）。
    if (rawEvidenceJson.length > 4096) {
      rawEvidenceJson = rawEvidenceJson.slice(0, 4096);
    }
  }
  return {
    feeEvents: [],
    sameTickReservations: [],
    processedFills: [],
    carriedFeeDebtMilli: {},
    invalid: rawEvidenceJson === undefined
      ? { reason, observedAt }
      : { reason, observedAt, rawEvidenceJson },
  };
}

/**
 * Operator 显式修复：唯一清除 invalid blocker 的入口。原始损坏证据由
 * 调用方隔离保存（不随本调用销毁）；修复后从空窗口重新累积费用统计。
 */
export function resolveFeeLedgerInvalid(input: {
  ledger: MarketSaleFeeLedgerState;
  expectedReason?: string;
}): MarketSaleFeeLedgerState {
  const marker = input.ledger.invalid;
  if (!marker) {
    throw new RangeError("fee ledger has no invalid blocker to resolve");
  }
  if (
    input.expectedReason !== undefined &&
    marker.reason !== input.expectedReason
  ) {
    throw new RangeError("fee ledger blocker reason does not match operator attestation");
  }
  const resolved = cloneLedger(input.ledger);
  resolved.invalid = undefined;
  return resolved;
}

export function createEmptyMarketSaleFeeLedger(): MarketSaleFeeLedgerState {
  return {
    feeEvents: [],
    sameTickReservations: [],
    processedFills: [],
    carriedFeeDebtMilli: {},
  };
}

export function advanceFeeLedgerWindow(
  ledger: MarketSaleFeeLedgerState,
  gameTime: number,
  limitsInput: FeeLedgerLimits,
): MarketSaleFeeLedgerState {
  assertNonNegativeSafeInteger(gameTime, "gameTime");
  const limits = normalizeLimits(limitsInput);
  const carriedFeeEntries = Object.entries(ledger.carriedFeeDebtMilli);
  if (carriedFeeEntries.length > MAX_CARRIED_FEE_RESOURCES) {
    throw new RangeError("carried fee debt resource map exceeds its hard bound");
  }
  for (const [, value] of carriedFeeEntries) {
    assertNonNegativeSafeInteger(value, "carried fee debt");
  }
  if (
    ledger.feeEvents.length > MAX_FEE_EVENTS ||
    ledger.sameTickReservations.length > MAX_SAME_TICK_FEE_RESERVATIONS ||
    ledger.processedFills.length > MAX_PROCESSED_FILL_RECEIPTS
  ) {
    throw new RangeError("fee ledger array exceeds its hard bound");
  }

  const feeEvents = ledger.feeEvents
    .map(event => ({ ...event }))
    .filter((event) => {
      validateFeeEvent(event);
      if (event.tick > gameTime) throw new RangeError("fee event cannot be from the future");
      return gameTime - event.tick < limits.feeWindowTicks;
    });
  const sameTickReservations = ledger.sameTickReservations
    .map(reservation => ({ ...reservation }))
    .filter((reservation) => {
      validateReservation(reservation);
      if (reservation.tick > gameTime) {
        throw new RangeError("fee reservation cannot be from the future");
      }
      return reservation.tick === gameTime;
    });
  const processedFills = ledger.processedFills
    .map(receipt => ({ ...receipt }))
    .filter((receipt) => {
      validateFillReceipt(receipt);
      if (receipt.tick > gameTime) throw new RangeError("fill receipt cannot be from the future");
      return gameTime - receipt.tick < limits.fillReceiptWindowTicks;
    });

  if (new Set(feeEvents.map(event => event.id)).size !== feeEvents.length) {
    throw new RangeError("active fee events contain duplicate ids");
  }
  if (
    new Set(sameTickReservations.map(reservation => reservation.id)).size !==
    sameTickReservations.length
  ) {
    throw new RangeError("same-tick fee reservations contain duplicate ids");
  }
  if (
    new Set(processedFills.map(receipt => receipt.key)).size !==
    processedFills.length
  ) {
    throw new RangeError("active fill receipts contain duplicate keys");
  }

  if (
    feeEvents.length > limits.maxFeeEvents ||
    sameTickReservations.length > limits.maxSameTickReservations ||
    processedFills.length > limits.maxProcessedFills
  ) {
    throw new RangeError("active fee ledger window exceeds configured bound");
  }

  return {
    feeEvents,
    sameTickReservations,
    processedFills,
    carriedFeeDebtMilli: { ...ledger.carriedFeeDebtMilli },
    reconcileGap: ledger.reconcileGap ? { ...ledger.reconcileGap } : undefined,
    invalid: ledger.invalid ? { ...ledger.invalid } : undefined,
  };
}

export function getFeeLedgerTotals(ledger: MarketSaleFeeLedgerState): {
  rollingFeeMilli: MilliCredits;
  reservedThisTickMilli: MilliCredits;
  uncommittedReservationMilli: MilliCredits;
} {
  const rollingFeeMilli = sumMilli(
    ledger.feeEvents.map(event => event.feeMilli),
    "rolling fee total",
  );
  const reservedThisTickMilli = sumMilli(
    ledger.sameTickReservations.map(reservation => reservation.feeMilli),
    "same tick fee reservation total",
  );
  const uncommittedReservationMilli = sumMilli(
    ledger.sameTickReservations
      .filter(reservation => reservation.status === "reserved")
      .map(reservation => reservation.feeMilli),
    "uncommitted fee reservation total",
  );
  return {
    rollingFeeMilli,
    reservedThisTickMilli,
    uncommittedReservationMilli,
  };
}

function evaluateAdvancedFeeGate(
  input: Omit<ProspectiveFeeGateInput, "ledger" | "limits"> & {
    ledger: MarketSaleFeeLedgerState;
    limits: NormalizedFeeLedgerLimits;
  },
): ProspectiveFeeGateResult {
  assertNonNegativeSafeInteger(input.prospectiveFeeMilli, "prospectiveFeeMilli");
  assertFeeBearingAction(input.action, "market fee action");
  assertNonNegativeSafeInteger(input.creditsMilli, "creditsMilli");
  assertNonNegativeSafeInteger(input.creditReserveMilli, "creditReserveMilli");
  assertNonNegativeSafeInteger(input.rollingFeeBudgetMilli, "rollingFeeBudgetMilli");

  const totals = getFeeLedgerTotals(input.ledger);
  const projectedRollingFeeMilli = safeAdd(
    safeAdd(
      totals.rollingFeeMilli,
      totals.uncommittedReservationMilli,
      "projected rolling fees",
    ),
    input.prospectiveFeeMilli,
    "projected rolling fees",
  );
  const projectedCreditDebit = safeAdd(
    totals.reservedThisTickMilli,
    input.prospectiveFeeMilli,
    "projected same tick credit debit",
  );
  const projectedCreditsMilli = input.creditsMilli - projectedCreditDebit;
  if (!Number.isSafeInteger(projectedCreditsMilli)) {
    throw new RangeError("projected credits exceed safe integer precision");
  }

  const reasons: ProspectiveFeeGateRejection[] = [];
  // fail-closed：invalid blocker 存在即禁止一切 fee-bearing 操作，
  // 优先级高于其余判定（空窗口不得被解释为「预算为零使用」）。
  if (input.ledger.invalid) reasons.push("fee_ledger_invalid");
  if (input.ledger.reconcileGap) reasons.push("reconcile_gap");
  if (projectedCreditsMilli < input.creditReserveMilli) reasons.push("credit_reserve");
  if (projectedRollingFeeMilli > input.rollingFeeBudgetMilli) {
    reasons.push("rolling_fee_budget");
  }

  const pendingEventCount = input.ledger.sameTickReservations
    .filter(reservation => reservation.status === "reserved")
    .length;
  if (input.ledger.feeEvents.length + pendingEventCount >= input.limits.maxFeeEvents) {
    reasons.push("fee_event_capacity");
  }
  if (
    input.ledger.sameTickReservations.length >=
    input.limits.maxSameTickReservations
  ) {
    reasons.push("reservation_capacity");
  }

  let freeOrderSlotsAfter: number | undefined;
  if (input.action === "create") {
    const slots = input.orderSlots;
    if (!slots) {
      reasons.push("order_slot_state_missing");
    } else {
      assertNonNegativeSafeInteger(slots.usedOrderSlots, "usedOrderSlots");
      assertPositiveSafeInteger(slots.totalOrderSlots, "totalOrderSlots");
      assertNonNegativeSafeInteger(slots.minFreeOrderSlots, "minFreeOrderSlots");
      assertNonNegativeSafeInteger(slots.managedOrderCount, "managedOrderCount");
      assertPositiveSafeInteger(slots.maxManagedOrders, "maxManagedOrders");
      if (
        slots.usedOrderSlots > slots.totalOrderSlots ||
        slots.minFreeOrderSlots > slots.totalOrderSlots
      ) {
        reasons.push("order_slot_state_invalid");
      } else {
        freeOrderSlotsAfter =
          slots.totalOrderSlots - slots.usedOrderSlots - 1;
        if (freeOrderSlotsAfter < slots.minFreeOrderSlots) {
          reasons.push("free_order_slots");
        }
      }
      if (
        safeAdd(slots.managedOrderCount, 1, "projected managed order count") >
        slots.maxManagedOrders
      ) {
        reasons.push("managed_order_limit");
      }
    }
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    ledger: input.ledger,
    rollingFeeMilli: totals.rollingFeeMilli,
    reservedThisTickMilli: totals.reservedThisTickMilli,
    projectedRollingFeeMilli,
    projectedCreditsMilli,
    freeOrderSlotsAfter,
  };
}

export function evaluateProspectiveFeeGate(
  input: ProspectiveFeeGateInput,
): ProspectiveFeeGateResult {
  const limits = normalizeLimits(input.limits);
  const ledger = advanceFeeLedgerWindow(input.ledger, input.gameTime, input.limits);
  return evaluateAdvancedFeeGate({ ...input, ledger, limits });
}

export function reserveProspectiveFee(
  input: ReserveProspectiveFeeInput,
): ReserveProspectiveFeeResult {
  assertBoundedIdentifier(input.reservationId, "reservationId");
  assertFeeBearingAction(input.action, "market fee action");
  assertNonNegativeSafeInteger(input.prospectiveFeeMilli, "prospectiveFeeMilli");
  assertNonNegativeSafeInteger(input.creditsMilli, "creditsMilli");
  assertNonNegativeSafeInteger(input.creditReserveMilli, "creditReserveMilli");
  assertNonNegativeSafeInteger(input.rollingFeeBudgetMilli, "rollingFeeBudgetMilli");
  const limits = normalizeLimits(input.limits);
  const ledger = advanceFeeLedgerWindow(input.ledger, input.gameTime, input.limits);
  const existing = ledger.sameTickReservations.find(
    reservation => reservation.id === input.reservationId,
  );
  if (existing) {
    if (
      existing.tick !== input.gameTime ||
      existing.action !== input.action ||
      existing.feeMilli !== input.prospectiveFeeMilli
    ) {
      throw new RangeError("reservationId conflicts with a different fee reservation");
    }
    const totals = getFeeLedgerTotals(ledger);
    const projectedCreditsMilli =
      input.creditsMilli - totals.reservedThisTickMilli;
    if (!Number.isSafeInteger(projectedCreditsMilli)) {
      throw new RangeError("projected credits exceed safe integer precision");
    }
    return {
      allowed: false,
      reasons: ["reservation_already_exists"],
      ledger,
      rollingFeeMilli: totals.rollingFeeMilli,
      reservedThisTickMilli: totals.reservedThisTickMilli,
      projectedRollingFeeMilli: safeAdd(
        totals.rollingFeeMilli,
        totals.uncommittedReservationMilli,
        "projected rolling fees",
      ),
      projectedCreditsMilli,
      alreadyReserved: true,
    };
  }

  const gate = evaluateAdvancedFeeGate({ ...input, ledger, limits });
  if (!gate.allowed) {
    return {
      ...gate,
      alreadyReserved: false,
    };
  }
  return {
    ...gate,
    ledger: {
      ...ledger,
      sameTickReservations: [
        ...ledger.sameTickReservations,
        {
          id: input.reservationId,
          tick: input.gameTime,
          action: input.action,
          feeMilli: input.prospectiveFeeMilli,
          status: "reserved",
        },
      ],
    },
    alreadyReserved: false,
  };
}

export function commitProspectiveFeeReservation(input: {
  ledger: MarketSaleFeeLedgerState;
  reservationId: string;
  gameTime: number;
  limits: FeeLedgerLimits;
}): MarketSaleFeeLedgerState {
  assertBoundedIdentifier(input.reservationId, "reservationId");
  const limits = normalizeLimits(input.limits);
  const ledger = advanceFeeLedgerWindow(input.ledger, input.gameTime, input.limits);
  if (ledger.invalid) {
    throw new RangeError("cannot commit fee reservation while ledger is blocked");
  }
  const index = ledger.sameTickReservations.findIndex(
    reservation => reservation.id === input.reservationId,
  );
  if (index < 0) throw new RangeError("fee reservation does not exist in this tick");
  const reservation = ledger.sameTickReservations[index];
  if (reservation.status === "committed") return ledger;
  if (ledger.feeEvents.length >= limits.maxFeeEvents) {
    throw new RangeError("fee event capacity exhausted before commit");
  }

  const duplicateEvent = ledger.feeEvents.find(event => event.id === reservation.id);
  if (
    duplicateEvent &&
    (
      duplicateEvent.tick !== reservation.tick ||
      duplicateEvent.action !== reservation.action ||
      duplicateEvent.feeMilli !== reservation.feeMilli
    )
  ) {
    throw new RangeError("fee event id conflicts with existing event");
  }

  const reservations = ledger.sameTickReservations.map((item, itemIndex) =>
    itemIndex === index ? { ...item, status: "committed" as const } : item,
  );
  return {
    ...ledger,
    sameTickReservations: reservations,
    feeEvents: duplicateEvent
      ? ledger.feeEvents
      : [
          ...ledger.feeEvents,
          {
            id: reservation.id,
            tick: reservation.tick,
            action: reservation.action,
            feeMilli: reservation.feeMilli,
          },
        ],
  };
}

export function releaseProspectiveFeeReservation(input: {
  ledger: MarketSaleFeeLedgerState;
  reservationId: string;
  gameTime: number;
  limits: FeeLedgerLimits;
}): MarketSaleFeeLedgerState {
  assertBoundedIdentifier(input.reservationId, "reservationId");
  const ledger = advanceFeeLedgerWindow(input.ledger, input.gameTime, input.limits);
  const existing = ledger.sameTickReservations.find(
    reservation => reservation.id === input.reservationId,
  );
  if (!existing) return ledger;
  if (existing.status === "committed") {
    throw new RangeError("committed fee reservation cannot be released");
  }
  return {
    ...ledger,
    sameTickReservations: ledger.sameTickReservations.filter(
      reservation => reservation.id !== input.reservationId,
    ),
  };
}

export function buildProcessedFillKey(transactionId: string, orderId: string): string {
  assertBoundedIdentifier(transactionId, "transactionId");
  assertBoundedIdentifier(orderId, "orderId");
  return `${transactionId.length}:${transactionId}${orderId}`;
}

function markReconcileGap(
  ledger: MarketSaleFeeLedgerState,
  gap: FeeLedgerReconcileGap,
): MarketSaleFeeLedgerState {
  return {
    ...cloneLedger(ledger),
    reconcileGap: { ...gap },
  };
}

/**
 * Persist an unowned live order mutation without replacing an older,
 * unrelated reconciliation gap.  The managed-order record remains the
 * per-order source of truth; this ledger fence blocks every fee-bearing write.
 */
export function markExternalOrderMutationFeeGap(input: {
  ledger: MarketSaleFeeLedgerState;
  gameTime: number;
  orderId: string;
}): MarketSaleFeeLedgerState {
  assertNonNegativeSafeInteger(input.gameTime, "gameTime");
  assertBoundedIdentifier(input.orderId, "orderId");
  // fail-closed：blocked 账本不再叠加新的 gap fence（invalid blocker 已
  // 封锁全部 fee-bearing 操作），也不改动其余字段。
  if (input.ledger.invalid) return cloneLedger(input.ledger);
  const existing = input.ledger.reconcileGap;
  if (
    existing &&
    (existing.reason !== "external_order_mutation" ||
      existing.orderId !== input.orderId)
  ) {
    return cloneLedger(input.ledger);
  }
  if (existing) return cloneLedger(input.ledger);
  return markReconcileGap(input.ledger, {
    reason: "external_order_mutation",
    orderId: input.orderId,
    observedAt: input.gameTime,
  });
}

/**
 * Clear only the exact external-mutation fence attested by the operator and
 * carry the verified conservative debt into the next order for this resource.
 */
export function resolveExternalOrderMutationFeeGap(input: {
  ledger: MarketSaleFeeLedgerState;
  orderId: string;
  resourceType: MarketResourceConstant;
  verifiedRemainingFeeDebtMilli: MilliCredits;
}): MarketSaleFeeLedgerState {
  // 不可绕过：blocked 账本上的 operator 收敛必须先修复 ledger blocker。
  if (input.ledger.invalid) {
    throw new RangeError("cannot resolve order mutation fee gap while ledger is blocked");
  }
  assertBoundedIdentifier(input.orderId, "orderId");
  assertNonNegativeSafeInteger(
    input.verifiedRemainingFeeDebtMilli,
    "verifiedRemainingFeeDebtMilli",
  );
  const gap = input.ledger.reconcileGap;
  if (
    !gap ||
    gap.reason !== "external_order_mutation" ||
    gap.orderId !== input.orderId
  ) {
    throw new RangeError("external order mutation fee gap does not match");
  }
  const ledger = cloneLedger(input.ledger);
  ledger.reconcileGap = undefined;
  return addCarriedFeeDebt(
    ledger,
    input.resourceType,
    input.verifiedRemainingFeeDebtMilli,
  ).ledger;
}

export function applyFillFeeDebt(input: {
  ledger: MarketSaleFeeLedgerState;
  gameTime: number;
  transactionId: string;
  orderId: string;
  feeDebtMilli: MilliCredits;
  filledAmount: number;
  preRemainingAmount: number;
  limits: FeeLedgerLimits;
}): ApplyFillFeeDebtResult {
  assertNonNegativeSafeInteger(input.gameTime, "gameTime");
  assertNonNegativeSafeInteger(input.feeDebtMilli, "feeDebtMilli");
  assertPositiveSafeInteger(input.filledAmount, "filledAmount");
  assertPositiveSafeInteger(input.preRemainingAmount, "preRemainingAmount");
  const limits = normalizeLimits(input.limits);
  const ledger = advanceFeeLedgerWindow(input.ledger, input.gameTime, input.limits);
  // fail-closed：blocked 账本上不落任何 fill receipt——记录丢失好过在
  // 无效窗口上伪造对账证据（operator 修复后凭 transaction 键防重放）。
  if (ledger.invalid) {
    return {
      ledger,
      applied: false,
      duplicate: false,
      reconcileGap: true,
    };
  }
  const key = buildProcessedFillKey(input.transactionId, input.orderId);
  const existing = ledger.processedFills.find(receipt => receipt.key === key);
  if (existing) {
    const conflict =
      existing.transactionId !== input.transactionId ||
      existing.orderId !== input.orderId ||
      existing.filledAmount !== input.filledAmount ||
      existing.preRemainingAmount !== input.preRemainingAmount;
    if (conflict) {
      return {
        ledger: markReconcileGap(ledger, {
          reason: "fill_receipt_conflict",
          orderId: input.orderId,
          transactionId: input.transactionId,
          observedAt: input.gameTime,
        }),
        applied: false,
        duplicate: false,
        reconcileGap: true,
      };
    }
    return {
      ledger,
      applied: false,
      duplicate: true,
      reconcileGap: false,
    };
  }
  if (ledger.processedFills.length >= limits.maxProcessedFills) {
    return {
      ledger: markReconcileGap(ledger, {
        reason: "fill_receipt_capacity",
        orderId: input.orderId,
        transactionId: input.transactionId,
        observedAt: input.gameTime,
      }),
      applied: false,
      duplicate: false,
      reconcileGap: true,
    };
  }

  const allocation = allocateFeeDebtForFill({
    feeDebtMilli: input.feeDebtMilli,
    filledAmount: input.filledAmount,
    preRemainingAmount: input.preRemainingAmount,
  });
  return {
    ledger: {
      ...ledger,
      processedFills: [
        ...ledger.processedFills,
        {
          key,
          transactionId: input.transactionId,
          orderId: input.orderId,
          tick: input.gameTime,
          filledAmount: input.filledAmount,
          preRemainingAmount: input.preRemainingAmount,
          allocatedFeeDebtMilli: allocation.allocatedFeeDebtMilli,
        },
      ],
    },
    applied: true,
    duplicate: false,
    reconcileGap: false,
    allocation,
  };
}

function addCarriedFeeDebt(
  ledger: MarketSaleFeeLedgerState,
  resourceType: MarketResourceConstant,
  amountMilli: MilliCredits,
): { ledger: MarketSaleFeeLedgerState; totalCarriedMilli: MilliCredits } {
  assertNonNegativeSafeInteger(amountMilli, "carried fee debt amount");
  const current = ledger.carriedFeeDebtMilli[resourceType] ?? 0;
  assertNonNegativeSafeInteger(current, "existing carried fee debt");
  const totalCarriedMilli = safeAdd(current, amountMilli, "carried fee debt");
  return {
    ledger: {
      ...cloneLedger(ledger),
      carriedFeeDebtMilli: {
        ...ledger.carriedFeeDebtMilli,
        [resourceType]: totalCarriedMilli,
      },
    },
    totalCarriedMilli,
  };
}

export function takeCarriedFeeDebt(
  ledger: MarketSaleFeeLedgerState,
  resourceType: MarketResourceConstant,
): { ledger: MarketSaleFeeLedgerState; feeDebtMilli: MilliCredits } {
  if (ledger.invalid) {
    throw new RangeError("cannot extract carried fee debt while ledger is blocked");
  }
  const feeDebtMilli = ledger.carriedFeeDebtMilli[resourceType] ?? 0;
  assertNonNegativeSafeInteger(feeDebtMilli, "carried fee debt");
  const carriedFeeDebtMilli = { ...ledger.carriedFeeDebtMilli };
  delete carriedFeeDebtMilli[resourceType];
  return {
    ledger: {
      ...cloneLedger(ledger),
      carriedFeeDebtMilli,
    },
    feeDebtMilli,
  };
}

export function reconcileDisappearedOrderFeeDebt(
  input: ReconcileDisappearedOrderInput,
): ReconcileDisappearedOrderResult {
  assertNonNegativeSafeInteger(input.gameTime, "gameTime");
  assertBoundedIdentifier(input.orderId, "orderId");
  assertNonNegativeSafeInteger(
    input.remainingFeeDebtMilli,
    "remainingFeeDebtMilli",
  );

  // fail-closed：blocked 账本上不累积 carried debt、不写 gap——缺失的
  // 债务记录由 managed order 侧证据保留，operator 修复后再收敛。
  if (input.ledger.invalid) {
    return {
      ledger: cloneLedger(input.ledger),
      resolved: false,
      classification: "reconcile_gap",
      refundedFeeDebtMilli: 0,
      carriedFeeDebtMilli: 0,
      preservedFeeDebtMilli: input.remainingFeeDebtMilli,
    };
  }

  if (input.reason === "unknown") {
    return {
      ledger: markReconcileGap(input.ledger, {
        reason: "unknown_disappearance",
        orderId: input.orderId,
        observedAt: input.gameTime,
      }),
      resolved: false,
      classification: "reconcile_gap",
      refundedFeeDebtMilli: 0,
      carriedFeeDebtMilli: 0,
      preservedFeeDebtMilli: input.remainingFeeDebtMilli,
    };
  }

  if (input.reason === "policy_cancelled") {
    const carried = addCarriedFeeDebt(
      input.ledger,
      input.resourceType,
      input.remainingFeeDebtMilli,
    );
    return {
      ledger: carried.ledger,
      resolved: true,
      classification: "policy_cancelled",
      refundedFeeDebtMilli: 0,
      carriedFeeDebtMilli: input.remainingFeeDebtMilli,
      preservedFeeDebtMilli: 0,
    };
  }

  if (input.verifiedRefundMilli === undefined) {
    return {
      ledger: markReconcileGap(input.ledger, {
        reason: "unknown_disappearance",
        orderId: input.orderId,
        observedAt: input.gameTime,
      }),
      resolved: false,
      classification: "reconcile_gap",
      refundedFeeDebtMilli: 0,
      carriedFeeDebtMilli: 0,
      preservedFeeDebtMilli: input.remainingFeeDebtMilli,
    };
  }
  assertNonNegativeSafeInteger(input.verifiedRefundMilli, "verifiedRefundMilli");
  if (input.verifiedRefundMilli > input.remainingFeeDebtMilli) {
    return {
      ledger: markReconcileGap(input.ledger, {
        reason: "server_expiry_refund_mismatch",
        orderId: input.orderId,
        observedAt: input.gameTime,
      }),
      resolved: false,
      classification: "reconcile_gap",
      refundedFeeDebtMilli: 0,
      carriedFeeDebtMilli: 0,
      preservedFeeDebtMilli: input.remainingFeeDebtMilli,
    };
  }
  const residualDebtMilli =
    input.remainingFeeDebtMilli - input.verifiedRefundMilli;
  const carried = addCarriedFeeDebt(
    input.ledger,
    input.resourceType,
    residualDebtMilli,
  );
  return {
    ledger: carried.ledger,
    resolved: true,
    classification: "server_expired",
    refundedFeeDebtMilli: input.verifiedRefundMilli,
    carriedFeeDebtMilli: residualDebtMilli,
    preservedFeeDebtMilli: 0,
  };
}

/**
 * Operator closeout for an already persisted disappearance gap.  It clears
 * only the exact order fence; an invalid server-expiry refund immediately
 * recreates a mismatch gap through the normal reconciliation helper.
 */
export function resolveDisappearedOrderFeeGap(
  input: Omit<ReconcileDisappearedOrderInput, "reason"> & {
    reason: Exclude<OrderDisappearanceReason, "unknown">;
  },
): ReconcileDisappearedOrderResult {
  // 不可绕过：blocked 账本上的 operator 收敛必须先修复 ledger blocker。
  if (input.ledger.invalid) {
    throw new RangeError("cannot resolve order disappearance fee gap while ledger is blocked");
  }
  const gap = input.ledger.reconcileGap;
  if (
    !gap ||
    gap.orderId !== input.orderId ||
    (gap.reason !== "unknown_disappearance" &&
      gap.reason !== "server_expiry_refund_mismatch")
  ) {
    throw new RangeError("order disappearance fee gap does not match");
  }
  const ledger = cloneLedger(input.ledger);
  ledger.reconcileGap = undefined;
  return reconcileDisappearedOrderFeeDebt({
    ...input,
    ledger,
  });
}
