import {
  priceToMilliDown,
  priceToMilliUp,
} from "@/runtime/marketSalePricing";
import { DIRECT_ENGINE_ASSUMPTIONS } from "@/runtime/marketSaleDirectEngineAssumptions";

export type DirectPendingStatus =
  | "prepared"
  | "submitted"
  | "reconcile_gap";

export type DirectDealOutcomeStatus =
  | "confirmed"
  | "failed"
  | "not_filled";

export interface DirectEnergyShadowComponents {
  hardFloor: number;
  explicit?: number;
  historyFloor?: number;
  ratchetFloor?: number;
}

export interface DirectPhysicalSnapshot {
  terminalResource: number;
  terminalEnergy: number;
  terminalCooldown: number;
  credits: number;
}

export interface DirectTransactionOrder {
  id: string;
  type: string;
  price: number;
}

export interface DirectOutgoingTransaction {
  transactionId: string;
  time: number;
  amount: number;
  resourceType: string;
  from: string;
  to: string;
  order?: DirectTransactionOrder;
}

export interface DirectOutgoingWindow {
  transactions: DirectOutgoingTransaction[];
  /** 调用方必须证明窗口覆盖 attemptAt，而不只是“读取成功”。 */
  coversAttemptAt: boolean;
  observedAt: number;
  oldestTime?: number;
  newestTime?: number;
}

export interface DirectFirstPostAttemptObservation {
  observedAt: number;
  windowCoversAttemptAt: boolean;
  terminalResourceUnchanged: boolean;
  terminalEnergyUnchanged: boolean;
  terminalCooldownUnchanged: boolean;
  creditsUnchanged: boolean;
}

export interface PendingDirectDeal {
  requestId: string;
  status: DirectPendingStatus;
  configRevision: string;
  directSafetyFingerprint: string;
  canaryRoomName: string;
  resource: ResourceConstant;
  orderId: string;
  orderRoomName: string;
  observedOrderPrice: number;
  observedOrderPriceMilli: number;
  observedOrderAmount: number;
  dealAmount: number;
  transactionEnergy: number;
  effectiveEnergyShadowPrice: number;
  effectiveEnergyShadowPriceMilli: number;
  energyShadowComponents: DirectEnergyShadowComponents;
  energyShadowObservedAt: number;
  netCreditsMilli: number;
  worstCaseActualAmount:
    typeof DIRECT_ENGINE_ASSUMPTIONS.minimumPositiveExecutionAmount;
  worstCaseNetCreditsMilli: number;
  effectiveNetFloor: number;
  effectiveNetFloorMilli: number;
  protectionRevision: number;
  terminalResourceBefore: number;
  terminalEnergyBefore: number;
  terminalCooldownBefore: number;
  creditsBefore: number;
  preparedAt: number;
  attemptAt: number;
  outgoingTransactionKeysBefore: string[];
  outgoingWindowBefore: {
    observedAt: number;
    count: number;
    oldestTime?: number;
    newestTime?: number;
  };
  firstPostAttemptObservation?: DirectFirstPostAttemptObservation;
  successfulMissingObservationTicks: number[];
  submittedAt?: number;
  resultCode?: number;
}

export interface DirectDealOutcome {
  requestId: string;
  orderId: string;
  status: DirectDealOutcomeStatus;
  resolvedAt: number;
  configRevision: string;
  directSafetyFingerprint: string;
  canaryRoomName: string;
  resource: ResourceConstant;
  orderRoomName: string;
  observedOrderPrice: number;
  observedOrderPriceMilli: number;
  observedOrderAmount: number;
  submittedDealAmount: number;
  plannedTransactionEnergy: number;
  effectiveEnergyShadowPrice: number;
  effectiveEnergyShadowPriceMilli: number;
  energyShadowComponents: DirectEnergyShadowComponents;
  energyShadowObservedAt: number;
  plannedNetCreditsMilli: number;
  worstCaseActualAmount:
    typeof DIRECT_ENGINE_ASSUMPTIONS.minimumPositiveExecutionAmount;
  worstCaseNetCreditsMilli: number;
  effectiveNetFloor: number;
  effectiveNetFloorMilli: number;
  protectionRevision: number;
  attemptAt: number;
  reason?: string;
  resultCode?: number;
  transactionId?: string;
  transactionTime?: number;
  actualOrderType?: string;
  actualOrderPrice?: number;
  actualResource?: string;
  actualFrom?: string;
  actualTo?: string;
  actualAmount?: number;
  actualTransactionEnergy?: number;
  actualNetCreditsMilli?: number;
  evidenceSource?: "automatic" | "operator";
  evidenceKey: string;
  pendingRecoveryFingerprint: string;
  operatorEvidenceFingerprint?: string;
  operator?: string;
}

export interface DirectPendingStore {
  pendingDirectDeals: Record<string, PendingDirectDeal>;
  /** Unknown/corrupt records remain blocking evidence but never enter typed math. */
  quarantinedPendingDirectDeals: Record<string, unknown>;
  directDealOutcomes: DirectDealOutcome[];
  processedDirectTransactionKeys: string[];
  directConfirmedDealCount: number;
  directPausedForReview: boolean;
}

export interface PrepareDirectPendingInput {
  requestId: string;
  configRevision: string;
  directSafetyFingerprint: string;
  canaryRoomName: string;
  resource: ResourceConstant;
  orderId: string;
  orderRoomName: string;
  observedOrderPrice: number;
  observedOrderAmount: number;
  dealAmount: number;
  transactionEnergy: number;
  effectiveEnergyShadowPrice: number;
  energyShadowComponents: DirectEnergyShadowComponents;
  energyShadowObservedAt: number;
  netCreditsMilli: number;
  worstCaseNetCreditsMilli: number;
  effectiveNetFloor: number;
  protectionRevision: number;
  physicalBefore: DirectPhysicalSnapshot;
  preparedAt: number;
  attemptAt: number;
  outgoingWindowBefore: DirectOutgoingWindow;
}

export interface DirectPendingReconcileDependencies {
  calculateTransactionEnergy: (
    amount: number,
    fromRoomName: string,
    toRoomName: string,
  ) => number;
  readPhysicalSnapshot: (
    pending: PendingDirectDeal,
  ) => DirectPhysicalSnapshot | undefined;
  releasePreparedClaims: (requestId: string) => void;
}

export interface DirectPendingReconcileResult {
  actions: string[];
  rejectedByReason: Record<string, number>;
  confirmed: number;
  resolved: number;
  gaps: number;
}

export interface OperatorDirectTransactionEvidence {
  kind: "transaction";
  requestId: string;
  orderId: string;
  operator: string;
  transaction: DirectOutgoingTransaction;
}

export interface OperatorDirectNoFillEvidence {
  kind: "not_filled";
  requestId: string;
  orderId: string;
  operator: string;
  window: DirectOutgoingWindow;
  physical: DirectPhysicalSnapshot;
}

export type OperatorDirectPendingEvidence =
  | OperatorDirectTransactionEvidence
  | OperatorDirectNoFillEvidence;

const MAX_DIRECT_OUTCOMES = 50;
const MAX_PROCESSED_TRANSACTION_KEYS = 200;

function boundedPush<T>(target: T[], value: T, limit: number): void {
  target.push(value);
  if (target.length > limit) {
    target.splice(0, target.length - limit);
  }
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function finiteNonNegative(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function finitePositive(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0
  );
}

function roomNameValid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[WE]\d+[NS]\d+$/.test(value)
  );
}

function outgoingTransactionShapeValid(
  value: unknown,
  requireOrder: boolean,
): value is DirectOutgoingTransaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const transaction = value as Partial<DirectOutgoingTransaction>;
  const order = transaction.order as
    | Partial<DirectTransactionOrder>
    | undefined;
  const orderValid =
    order === undefined
      ? !requireOrder
      : Boolean(
          order &&
            typeof order === "object" &&
            !Array.isArray(order) &&
            typeof order.id === "string" &&
            order.id.length > 0 &&
            typeof order.type === "string" &&
            order.type.length > 0 &&
            finitePositive(order.price),
        );
  return Boolean(
    typeof transaction.transactionId === "string" &&
      transaction.transactionId.length > 0 &&
      nonNegativeSafeInteger(transaction.time) &&
      positiveSafeInteger(transaction.amount) &&
      typeof transaction.resourceType === "string" &&
      transaction.resourceType.length > 0 &&
      roomNameValid(transaction.from) &&
      roomNameValid(transaction.to) &&
      orderValid,
  );
}

function operatorPhysicalSnapshotValid(
  value: unknown,
): value is DirectPhysicalSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const physical = value as Partial<DirectPhysicalSnapshot>;
  return Boolean(
    nonNegativeSafeInteger(physical.terminalResource) &&
      nonNegativeSafeInteger(physical.terminalEnergy) &&
      nonNegativeSafeInteger(physical.terminalCooldown) &&
      finiteNonNegative(physical.credits),
  );
}

function operatorWindowShapeValid(
  value: unknown,
  resolvedAt: number,
): value is DirectOutgoingWindow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const window = value as Partial<DirectOutgoingWindow>;
  if (
    window.coversAttemptAt !== true ||
    !nonNegativeSafeInteger(window.observedAt) ||
    window.observedAt > resolvedAt ||
    !Array.isArray(window.transactions) ||
    window.transactions.length > 100 ||
    window.transactions.some(
      (transaction) =>
        !outgoingTransactionShapeValid(transaction, false) ||
        transaction.time > window.observedAt!,
    ) ||
    (window.oldestTime !== undefined &&
      !nonNegativeSafeInteger(window.oldestTime)) ||
    (window.newestTime !== undefined &&
      !nonNegativeSafeInteger(window.newestTime)) ||
    (window.oldestTime !== undefined &&
      window.newestTime !== undefined &&
      window.oldestTime > window.newestTime) ||
    (window.newestTime !== undefined &&
      window.newestTime > window.observedAt)
  ) {
    return false;
  }
  return true;
}

function optionalNonNegativeFinite(value: unknown): boolean {
  return value === undefined || finiteNonNegative(value);
}

function validEnergyShadowComponents(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const components = value as Partial<DirectEnergyShadowComponents>;
  return Boolean(
    finiteNonNegative(components.hardFloor) &&
      optionalNonNegativeFinite(components.explicit) &&
      optionalNonNegativeFinite(components.historyFloor) &&
      optionalNonNegativeFinite(components.ratchetFloor),
  );
}

/**
 * Active WAL records are executable safety evidence, not a best-effort cache.
 * Validate every frozen field and the no-fill observation timeline before a
 * migrated record may participate in automatic reconciliation.
 */
export function isRecoverablePendingDirectDeal(
  value: unknown,
  expectedRequestId?: string,
): value is PendingDirectDeal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const pending = value as Partial<PendingDirectDeal>;
  if (
    typeof pending.requestId !== "string" ||
    pending.requestId.length === 0 ||
    (expectedRequestId !== undefined &&
      pending.requestId !== expectedRequestId) ||
    (pending.status !== "prepared" &&
      pending.status !== "submitted" &&
      pending.status !== "reconcile_gap") ||
    typeof pending.configRevision !== "string" ||
    pending.configRevision.length === 0 ||
    typeof pending.directSafetyFingerprint !== "string" ||
    pending.directSafetyFingerprint.length === 0 ||
    !roomNameValid(pending.canaryRoomName) ||
    typeof pending.resource !== "string" ||
    !RESOURCES_ALL.includes(pending.resource as ResourceConstant) ||
    typeof pending.orderId !== "string" ||
    pending.orderId.length === 0 ||
    !roomNameValid(pending.orderRoomName) ||
    !finitePositive(pending.observedOrderPrice) ||
    !positiveSafeInteger(pending.observedOrderPriceMilli) ||
    !positiveSafeInteger(pending.observedOrderAmount) ||
    !positiveSafeInteger(pending.dealAmount) ||
    pending.dealAmount > pending.observedOrderAmount ||
    !nonNegativeSafeInteger(pending.transactionEnergy) ||
    !finiteNonNegative(pending.effectiveEnergyShadowPrice) ||
    !nonNegativeSafeInteger(
      pending.effectiveEnergyShadowPriceMilli,
    ) ||
    !validEnergyShadowComponents(pending.energyShadowComponents) ||
    !nonNegativeSafeInteger(pending.energyShadowObservedAt) ||
    !positiveSafeInteger(pending.netCreditsMilli) ||
    pending.worstCaseActualAmount !==
      DIRECT_ENGINE_ASSUMPTIONS.minimumPositiveExecutionAmount ||
    !Number.isSafeInteger(pending.worstCaseNetCreditsMilli) ||
    !finitePositive(pending.effectiveNetFloor) ||
    !positiveSafeInteger(pending.effectiveNetFloorMilli) ||
    !nonNegativeSafeInteger(pending.protectionRevision) ||
    !nonNegativeSafeInteger(pending.terminalResourceBefore) ||
    !nonNegativeSafeInteger(pending.terminalEnergyBefore) ||
    !nonNegativeSafeInteger(pending.terminalCooldownBefore) ||
    !finiteNonNegative(pending.creditsBefore) ||
    !nonNegativeSafeInteger(pending.preparedAt) ||
    pending.attemptAt !== pending.preparedAt ||
    pending.protectionRevision !== pending.attemptAt ||
    pending.energyShadowObservedAt > pending.attemptAt ||
    !Array.isArray(pending.outgoingTransactionKeysBefore) ||
    !pending.outgoingWindowBefore ||
    typeof pending.outgoingWindowBefore !== "object" ||
    !Array.isArray(pending.successfulMissingObservationTicks)
  ) {
    return false;
  }

  let expectedObservedPriceMilli: number;
  let expectedEnergyShadowPriceMilli: number;
  let expectedFloorMilli: number;
  try {
    expectedObservedPriceMilli = priceToMilliDown(
      pending.observedOrderPrice,
    );
    expectedEnergyShadowPriceMilli =
      pending.effectiveEnergyShadowPrice === 0
        ? 0
        : priceToMilliUp(pending.effectiveEnergyShadowPrice);
    expectedFloorMilli = priceToMilliUp(pending.effectiveNetFloor);
  } catch {
    return false;
  }
  if (
    pending.observedOrderPriceMilli !== expectedObservedPriceMilli ||
    pending.effectiveEnergyShadowPriceMilli !==
      expectedEnergyShadowPriceMilli ||
    pending.effectiveNetFloorMilli !== expectedFloorMilli
  ) {
    return false;
  }

  const components =
    pending.energyShadowComponents as DirectEnergyShadowComponents;
  const componentMaximum = Math.max(
    components.hardFloor,
    components.explicit ?? 0,
    components.historyFloor ?? 0,
    components.ratchetFloor ?? 0,
  );
  if (pending.effectiveEnergyShadowPrice < componentMaximum) {
    return false;
  }

  const plannedGross = checkedMultiply(
    pending.observedOrderPriceMilli,
    pending.dealAmount,
  );
  const plannedEnergyCost = checkedMultiply(
    pending.effectiveEnergyShadowPriceMilli,
    pending.transactionEnergy,
  );
  const plannedFloor = checkedMultiply(
    pending.effectiveNetFloorMilli,
    pending.dealAmount,
  );
  const expectedPlannedNet =
    plannedGross === undefined || plannedEnergyCost === undefined
      ? undefined
      : checkedSubtract(plannedGross, plannedEnergyCost);
  if (
    expectedPlannedNet === undefined ||
    plannedFloor === undefined ||
    pending.netCreditsMilli !== expectedPlannedNet ||
    pending.netCreditsMilli < plannedFloor ||
    (pending.worstCaseNetCreditsMilli ?? -Infinity) <
      pending.effectiveNetFloorMilli
  ) {
    return false;
  }

  const baselineKeys = pending.outgoingTransactionKeysBefore;
  if (
    baselineKeys.length > 100 ||
    baselineKeys.some(
      (key) => typeof key !== "string" || key.length === 0,
    ) ||
    new Set(baselineKeys).size !== baselineKeys.length
  ) {
    return false;
  }
  const baseline = pending.outgoingWindowBefore;
  if (
    baseline.observedAt !== pending.attemptAt ||
    !nonNegativeSafeInteger(baseline.count) ||
    baseline.count !== baselineKeys.length ||
    (baseline.oldestTime !== undefined &&
      !nonNegativeSafeInteger(baseline.oldestTime)) ||
    (baseline.newestTime !== undefined &&
      !nonNegativeSafeInteger(baseline.newestTime)) ||
    (baseline.oldestTime !== undefined &&
      baseline.newestTime !== undefined &&
      baseline.oldestTime > baseline.newestTime) ||
    (baseline.newestTime !== undefined &&
      baseline.newestTime > pending.attemptAt)
  ) {
    return false;
  }

  if (
    (pending.submittedAt !== undefined &&
      pending.submittedAt !== pending.attemptAt) ||
    (pending.status === "submitted" &&
      pending.submittedAt !== pending.attemptAt) ||
    (pending.resultCode !== undefined &&
      !Number.isSafeInteger(pending.resultCode))
  ) {
    return false;
  }

  const first = pending.firstPostAttemptObservation;
  if (
    first !== undefined &&
    (!first ||
      typeof first !== "object" ||
      first.observedAt !== pending.attemptAt + 1 ||
      first.windowCoversAttemptAt !== true ||
      typeof first.terminalResourceUnchanged !== "boolean" ||
      typeof first.terminalEnergyUnchanged !== "boolean" ||
      typeof first.terminalCooldownUnchanged !== "boolean" ||
      typeof first.creditsUnchanged !== "boolean")
  ) {
    return false;
  }
  const firstUnchanged = Boolean(
    first?.terminalResourceUnchanged &&
      first.terminalEnergyUnchanged &&
      first.terminalCooldownUnchanged &&
      first.creditsUnchanged,
  );
  if (
    first !== undefined &&
    !firstUnchanged &&
    pending.status !== "reconcile_gap"
  ) {
    return false;
  }
  const missingTicks = pending.successfulMissingObservationTicks;
  if (
    missingTicks.length > 2 ||
    missingTicks.some(
      (tick) =>
        !nonNegativeSafeInteger(tick) ||
        (pending.attemptAt === undefined || tick <= pending.attemptAt),
    ) ||
    new Set(missingTicks).size !== missingTicks.length ||
    missingTicks.some(
      (tick, index) => index > 0 && tick <= missingTicks[index - 1],
    )
  ) {
    return false;
  }
  if (missingTicks.length > 0) {
    if (
      !first ||
      first.observedAt !== missingTicks[0] ||
      !first.terminalResourceUnchanged ||
      !first.terminalEnergyUnchanged ||
      !first.terminalCooldownUnchanged ||
      !first.creditsUnchanged
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Recover only the two statement-boundary states emitted by older/newer WAL
 * writers. Unknown corruption is quarantined instead of being coerced.
 */
export function recoverPendingDirectDeal(
  value: unknown,
  expectedRequestId?: string,
): PendingDirectDeal | undefined {
  if (isRecoverablePendingDirectDeal(value, expectedRequestId)) {
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Partial<PendingDirectDeal>;
  const observation = raw.firstPostAttemptObservation;
  const changedObservation = Boolean(
    observation &&
      typeof observation === "object" &&
      (observation.terminalResourceUnchanged === false ||
        observation.terminalEnergyUnchanged === false ||
        observation.terminalCooldownUnchanged === false ||
        observation.creditsUnchanged === false),
  );
  if (
    changedObservation &&
    (raw.status === "prepared" || raw.status === "submitted")
  ) {
    const gapCandidate = {
      ...raw,
      status: "reconcile_gap" as const,
    };
    if (
      isRecoverablePendingDirectDeal(
        gapCandidate,
        expectedRequestId,
      )
    ) {
      return gapCandidate;
    }
  }
  if (
    raw.status === "submitted" &&
    raw.submittedAt === undefined
  ) {
    const preparedCandidate = {
      ...raw,
      status: "prepared" as const,
    };
    if (
      isRecoverablePendingDirectDeal(
        preparedCandidate,
        expectedRequestId,
      )
    ) {
      return preparedCandidate;
    }
  }
  return undefined;
}

function checkedMultiply(left: number, right: number): number | undefined {
  const value = left * right;
  return Number.isSafeInteger(value) ? value : undefined;
}

function checkedSubtract(left: number, right: number): number | undefined {
  const value = left - right;
  return Number.isSafeInteger(value) ? value : undefined;
}

function transactionKey(transaction: DirectOutgoingTransaction): string {
  return `${transaction.transactionId}:${transaction.order?.id || ""}`;
}

function appendOutcome(
  store: DirectPendingStore,
  outcome: DirectDealOutcome,
): void {
  const existing = store.directDealOutcomes.find(
    (entry) =>
      entry.requestId === outcome.requestId &&
      entry.status === outcome.status &&
      entry.transactionId === outcome.transactionId,
  );
  if (existing) return;
  boundedPush(store.directDealOutcomes, outcome, MAX_DIRECT_OUTCOMES);
}

function canonicalFingerprint(value: unknown): string {
  const canonical = JSON.stringify(value);
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < canonical.length; index += 1) {
    const code = canonical.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `v1:${(left >>> 0).toString(16).padStart(8, "0")}${(
    right >>> 0
  )
    .toString(16)
    .padStart(8, "0")}`;
}

function pendingRecoveryFingerprint(
  pending: PendingDirectDeal,
): string {
  return canonicalFingerprint({
    requestId: pending.requestId,
    configRevision: pending.configRevision,
    directSafetyFingerprint: pending.directSafetyFingerprint,
    canaryRoomName: pending.canaryRoomName,
    resource: pending.resource,
    orderId: pending.orderId,
    orderRoomName: pending.orderRoomName,
    observedOrderPrice: pending.observedOrderPrice,
    observedOrderPriceMilli: pending.observedOrderPriceMilli,
    observedOrderAmount: pending.observedOrderAmount,
    dealAmount: pending.dealAmount,
    transactionEnergy: pending.transactionEnergy,
    effectiveEnergyShadowPrice:
      pending.effectiveEnergyShadowPrice,
    effectiveEnergyShadowPriceMilli:
      pending.effectiveEnergyShadowPriceMilli,
    energyShadowComponents: [
      pending.energyShadowComponents.hardFloor,
      pending.energyShadowComponents.explicit ?? null,
      pending.energyShadowComponents.historyFloor ?? null,
      pending.energyShadowComponents.ratchetFloor ?? null,
    ],
    energyShadowObservedAt: pending.energyShadowObservedAt,
    netCreditsMilli: pending.netCreditsMilli,
    worstCaseActualAmount: pending.worstCaseActualAmount,
    worstCaseNetCreditsMilli: pending.worstCaseNetCreditsMilli,
    effectiveNetFloor: pending.effectiveNetFloor,
    effectiveNetFloorMilli: pending.effectiveNetFloorMilli,
    protectionRevision: pending.protectionRevision,
    terminalResourceBefore: pending.terminalResourceBefore,
    terminalEnergyBefore: pending.terminalEnergyBefore,
    terminalCooldownBefore: pending.terminalCooldownBefore,
    creditsBefore: pending.creditsBefore,
    preparedAt: pending.preparedAt,
    attemptAt: pending.attemptAt,
    outgoingTransactionKeysBefore:
      pending.outgoingTransactionKeysBefore,
    outgoingWindowBefore: pending.outgoingWindowBefore,
  });
}

function operatorNoFillEvidenceFingerprint(
  window: DirectOutgoingWindow,
  physical: DirectPhysicalSnapshot,
): string {
  const transactions = window.transactions
    .map((transaction) => ({
      transactionId: transaction.transactionId,
      time: transaction.time,
      amount: transaction.amount,
      resourceType: transaction.resourceType,
      from: transaction.from,
      to: transaction.to,
      order: transaction.order
        ? {
            id: transaction.order.id,
            type: transaction.order.type,
            price: transaction.order.price,
          }
        : null,
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  return canonicalFingerprint({
    coversAttemptAt: window.coversAttemptAt,
    observedAt: window.observedAt,
    oldestTime: window.oldestTime ?? null,
    newestTime: window.newestTime ?? null,
    transactions,
    physical: {
      terminalResource: physical.terminalResource,
      terminalEnergy: physical.terminalEnergy,
      terminalCooldown: physical.terminalCooldown,
      credits: physical.credits,
    },
  });
}

function outcomeBase(
  pending: PendingDirectDeal,
): Omit<
  DirectDealOutcome,
  | "status"
  | "resolvedAt"
  | "reason"
  | "resultCode"
  | "transactionId"
  | "transactionTime"
  | "actualOrderType"
  | "actualOrderPrice"
  | "actualResource"
  | "actualFrom"
  | "actualTo"
  | "actualAmount"
  | "actualTransactionEnergy"
  | "actualNetCreditsMilli"
  | "evidenceSource"
  | "evidenceKey"
  | "operator"
> {
  return {
    requestId: pending.requestId,
    orderId: pending.orderId,
    configRevision: pending.configRevision,
    directSafetyFingerprint: pending.directSafetyFingerprint,
    canaryRoomName: pending.canaryRoomName,
    resource: pending.resource,
    orderRoomName: pending.orderRoomName,
    observedOrderPrice: pending.observedOrderPrice,
    observedOrderPriceMilli: pending.observedOrderPriceMilli,
    observedOrderAmount: pending.observedOrderAmount,
    submittedDealAmount: pending.dealAmount,
    plannedTransactionEnergy: pending.transactionEnergy,
    effectiveEnergyShadowPrice:
      pending.effectiveEnergyShadowPrice,
    effectiveEnergyShadowPriceMilli:
      pending.effectiveEnergyShadowPriceMilli,
    energyShadowComponents: {
      ...pending.energyShadowComponents,
    },
    energyShadowObservedAt: pending.energyShadowObservedAt,
    plannedNetCreditsMilli: pending.netCreditsMilli,
    worstCaseActualAmount:
      pending.worstCaseActualAmount,
    worstCaseNetCreditsMilli: pending.worstCaseNetCreditsMilli,
    effectiveNetFloor: pending.effectiveNetFloor,
    effectiveNetFloorMilli: pending.effectiveNetFloorMilli,
    protectionRevision: pending.protectionRevision,
    attemptAt: pending.attemptAt,
    pendingRecoveryFingerprint:
      pendingRecoveryFingerprint(pending),
  };
}

function transactionEvidenceFieldsAbsent(
  outcome: Partial<DirectDealOutcome>,
): boolean {
  return (
    outcome.transactionId === undefined &&
    outcome.transactionTime === undefined &&
    outcome.actualOrderType === undefined &&
    outcome.actualOrderPrice === undefined &&
    outcome.actualResource === undefined &&
    outcome.actualFrom === undefined &&
    outcome.actualTo === undefined &&
    outcome.actualAmount === undefined &&
    outcome.actualTransactionEnergy === undefined &&
    outcome.actualNetCreditsMilli === undefined
  );
}

export function isRecoverableDirectDealOutcome(
  value: unknown,
): value is DirectDealOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const outcome = value as Partial<DirectDealOutcome>;
  if (
    typeof outcome.requestId !== "string" ||
    outcome.requestId.length === 0 ||
    typeof outcome.orderId !== "string" ||
    outcome.orderId.length === 0 ||
    (outcome.status !== "confirmed" &&
      outcome.status !== "failed" &&
      outcome.status !== "not_filled") ||
    !nonNegativeSafeInteger(outcome.resolvedAt) ||
    typeof outcome.configRevision !== "string" ||
    outcome.configRevision.length === 0 ||
    typeof outcome.directSafetyFingerprint !== "string" ||
    outcome.directSafetyFingerprint.length === 0 ||
    !roomNameValid(outcome.canaryRoomName) ||
    typeof outcome.resource !== "string" ||
    !RESOURCES_ALL.includes(outcome.resource as ResourceConstant) ||
    !roomNameValid(outcome.orderRoomName) ||
    !finitePositive(outcome.observedOrderPrice) ||
    !positiveSafeInteger(outcome.observedOrderPriceMilli) ||
    !positiveSafeInteger(outcome.observedOrderAmount) ||
    !positiveSafeInteger(outcome.submittedDealAmount) ||
    outcome.submittedDealAmount > outcome.observedOrderAmount ||
    !nonNegativeSafeInteger(outcome.plannedTransactionEnergy) ||
    !finiteNonNegative(outcome.effectiveEnergyShadowPrice) ||
    !nonNegativeSafeInteger(
      outcome.effectiveEnergyShadowPriceMilli,
    ) ||
    !validEnergyShadowComponents(outcome.energyShadowComponents) ||
    !nonNegativeSafeInteger(outcome.energyShadowObservedAt) ||
    !positiveSafeInteger(outcome.plannedNetCreditsMilli) ||
    outcome.worstCaseActualAmount !==
      DIRECT_ENGINE_ASSUMPTIONS.minimumPositiveExecutionAmount ||
    !Number.isSafeInteger(outcome.worstCaseNetCreditsMilli) ||
    !finitePositive(outcome.effectiveNetFloor) ||
    !positiveSafeInteger(outcome.effectiveNetFloorMilli) ||
    !nonNegativeSafeInteger(outcome.protectionRevision) ||
    !nonNegativeSafeInteger(outcome.attemptAt) ||
    outcome.resolvedAt < outcome.attemptAt ||
    outcome.protectionRevision !== outcome.attemptAt ||
    outcome.energyShadowObservedAt > outcome.attemptAt ||
    (outcome.evidenceSource !== "automatic" &&
      outcome.evidenceSource !== "operator") ||
    typeof outcome.evidenceKey !== "string" ||
    outcome.evidenceKey.length === 0 ||
    typeof outcome.pendingRecoveryFingerprint !== "string" ||
    !/^v1:[0-9a-f]{16}$/.test(
      outcome.pendingRecoveryFingerprint,
    )
  ) {
    return false;
  }

  let observedPriceMilli: number;
  let energyShadowPriceMilli: number;
  let floorMilli: number;
  try {
    observedPriceMilli = priceToMilliDown(outcome.observedOrderPrice);
    energyShadowPriceMilli =
      outcome.effectiveEnergyShadowPrice === 0
        ? 0
        : priceToMilliUp(outcome.effectiveEnergyShadowPrice);
    floorMilli = priceToMilliUp(outcome.effectiveNetFloor);
  } catch {
    return false;
  }
  const components =
    outcome.energyShadowComponents as DirectEnergyShadowComponents;
  const componentMaximum = Math.max(
    components.hardFloor,
    components.explicit ?? 0,
    components.historyFloor ?? 0,
    components.ratchetFloor ?? 0,
  );
  const gross = checkedMultiply(
    outcome.observedOrderPriceMilli,
    outcome.submittedDealAmount,
  );
  const energyCost = checkedMultiply(
    outcome.effectiveEnergyShadowPriceMilli,
    outcome.plannedTransactionEnergy,
  );
  const required = checkedMultiply(
    outcome.effectiveNetFloorMilli,
    outcome.submittedDealAmount,
  );
  const plannedNet =
    gross === undefined || energyCost === undefined
      ? undefined
      : checkedSubtract(gross, energyCost);
  if (
    outcome.observedOrderPriceMilli !== observedPriceMilli ||
    outcome.effectiveEnergyShadowPriceMilli !==
      energyShadowPriceMilli ||
    outcome.effectiveNetFloorMilli !== floorMilli ||
    outcome.effectiveEnergyShadowPrice < componentMaximum ||
    plannedNet === undefined ||
    required === undefined ||
    outcome.plannedNetCreditsMilli !== plannedNet ||
    outcome.plannedNetCreditsMilli < required ||
    (outcome.worstCaseNetCreditsMilli ?? -Infinity) <
      outcome.effectiveNetFloorMilli
  ) {
    return false;
  }

  const operatorValid =
    outcome.evidenceSource === "operator"
      ? typeof outcome.operator === "string" &&
        outcome.operator.trim().length > 0
      : outcome.operator === undefined;
  if (!operatorValid) return false;

  if (outcome.status === "confirmed") {
    if (
      typeof outcome.transactionId !== "string" ||
      outcome.transactionId.length === 0 ||
      outcome.transactionTime !== outcome.attemptAt ||
      outcome.actualOrderType !== ORDER_BUY ||
      outcome.actualOrderPrice !== outcome.observedOrderPrice ||
      outcome.actualResource !== outcome.resource ||
      outcome.actualFrom !== outcome.canaryRoomName ||
      outcome.actualTo !== outcome.orderRoomName ||
      !positiveSafeInteger(outcome.actualAmount) ||
      outcome.actualAmount > outcome.submittedDealAmount ||
      !nonNegativeSafeInteger(outcome.actualTransactionEnergy) ||
      !Number.isSafeInteger(outcome.actualNetCreditsMilli) ||
      outcome.resolvedAt < outcome.attemptAt + 1 ||
      outcome.evidenceKey !==
        `${outcome.transactionId}:${outcome.orderId}` ||
      outcome.reason !== undefined ||
      outcome.resultCode !== undefined ||
      outcome.operatorEvidenceFingerprint !== undefined
    ) {
      return false;
    }
    const actualGross = checkedMultiply(
      outcome.observedOrderPriceMilli,
      outcome.actualAmount,
    );
    const actualEnergyCost = checkedMultiply(
      outcome.effectiveEnergyShadowPriceMilli,
      outcome.actualTransactionEnergy,
    );
    const actualRequired = checkedMultiply(
      outcome.effectiveNetFloorMilli,
      outcome.actualAmount,
    );
    const actualNet =
      actualGross === undefined || actualEnergyCost === undefined
        ? undefined
        : checkedSubtract(actualGross, actualEnergyCost);
    return Boolean(
      actualNet !== undefined &&
        actualRequired !== undefined &&
        outcome.actualNetCreditsMilli === actualNet &&
        actualNet >= actualRequired,
    );
  }
  if (outcome.status === "failed") {
    return Boolean(
      transactionEvidenceFieldsAbsent(outcome) &&
        Number.isSafeInteger(outcome.resultCode) &&
        outcome.resultCode! < 0 &&
        outcome.evidenceSource === "automatic" &&
        outcome.resolvedAt === outcome.attemptAt &&
        outcome.reason ===
          `deal_non_ok:${outcome.resultCode}` &&
        outcome.evidenceKey ===
          `deal-return:${outcome.resultCode}` &&
        outcome.operatorEvidenceFingerprint === undefined &&
        outcome.operator === undefined
    );
  }
  if (
    outcome.reason !== undefined ||
    outcome.resultCode !== undefined ||
    !transactionEvidenceFieldsAbsent(outcome)
  ) {
    return false;
  }
  if (outcome.evidenceSource === "automatic") {
    if (outcome.operatorEvidenceFingerprint !== undefined) {
      return false;
    }
    const match = /^missing:(\d+),(\d+)$/.exec(
      outcome.evidenceKey,
    );
    if (!match) return false;
    const first = Number(match[1]);
    const second = Number(match[2]);
    return Boolean(
      nonNegativeSafeInteger(first) &&
        nonNegativeSafeInteger(second) &&
        first === outcome.attemptAt + 1 &&
        second > first &&
        outcome.resolvedAt === second,
    );
  }
  const match = /^operator-window:(\d+):(\d+)$/.exec(
    outcome.evidenceKey,
  );
  if (!match) return false;
  const observedAt = Number(match[1]);
  const count = Number(match[2]);
  return Boolean(
    typeof outcome.operatorEvidenceFingerprint === "string" &&
      /^v1:[0-9a-f]{16}$/.test(
        outcome.operatorEvidenceFingerprint,
      ) &&
    nonNegativeSafeInteger(observedAt) &&
      nonNegativeSafeInteger(count) &&
      observedAt >= outcome.attemptAt + 1 &&
      count <= 100 &&
      outcome.resolvedAt >= observedAt,
  );
}

function energyShadowComponentsEqual(
  left: DirectEnergyShadowComponents,
  right: DirectEnergyShadowComponents,
): boolean {
  return (
    left.hardFloor === right.hardFloor &&
    left.explicit === right.explicit &&
    left.historyFloor === right.historyFloor &&
    left.ratchetFloor === right.ratchetFloor
  );
}

function recoverableOutcomeMatchesPending(
  outcome: DirectDealOutcome,
  pending: PendingDirectDeal,
): boolean {
  return (
    outcome.pendingRecoveryFingerprint ===
      pendingRecoveryFingerprint(pending) &&
    outcome.requestId === pending.requestId &&
    outcome.orderId === pending.orderId &&
    outcome.configRevision === pending.configRevision &&
    outcome.directSafetyFingerprint ===
      pending.directSafetyFingerprint &&
    outcome.canaryRoomName === pending.canaryRoomName &&
    outcome.resource === pending.resource &&
    outcome.orderRoomName === pending.orderRoomName &&
    outcome.observedOrderPrice === pending.observedOrderPrice &&
    outcome.observedOrderPriceMilli ===
      pending.observedOrderPriceMilli &&
    outcome.observedOrderAmount === pending.observedOrderAmount &&
    outcome.submittedDealAmount === pending.dealAmount &&
    outcome.plannedTransactionEnergy === pending.transactionEnergy &&
    outcome.effectiveEnergyShadowPrice ===
      pending.effectiveEnergyShadowPrice &&
    outcome.effectiveEnergyShadowPriceMilli ===
      pending.effectiveEnergyShadowPriceMilli &&
    energyShadowComponentsEqual(
      outcome.energyShadowComponents,
      pending.energyShadowComponents,
    ) &&
    outcome.energyShadowObservedAt ===
      pending.energyShadowObservedAt &&
    outcome.plannedNetCreditsMilli === pending.netCreditsMilli &&
    outcome.worstCaseActualAmount === pending.worstCaseActualAmount &&
    outcome.worstCaseNetCreditsMilli ===
      pending.worstCaseNetCreditsMilli &&
    outcome.effectiveNetFloor === pending.effectiveNetFloor &&
    outcome.effectiveNetFloorMilli ===
      pending.effectiveNetFloorMilli &&
    outcome.protectionRevision === pending.protectionRevision &&
    outcome.attemptAt === pending.attemptAt
  );
}

export function isResolvedDirectPendingCompatibilityAlias(
  value: unknown,
  outcomes: readonly unknown[],
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 1) return false;
  return entries.every(([requestId, candidate]) => {
    const recovered = recoverPendingDirectDeal(
      candidate,
      requestId,
    );
    if (!recovered) return false;
    return outcomes.some(
      (outcome) =>
        isRecoverableDirectDealOutcome(outcome) &&
        recoverableOutcomeMatchesPending(outcome, recovered),
    );
  });
}

function confirmedOutcomeMatchesTransaction(
  outcome: DirectDealOutcome,
  transaction: DirectOutgoingTransaction,
): boolean {
  return Boolean(
    outcome.status === "confirmed" &&
      transaction.order &&
      outcome.transactionId === transaction.transactionId &&
      outcome.evidenceKey === transactionKey(transaction) &&
      outcome.transactionTime === transaction.time &&
      outcome.actualOrderType === transaction.order.type &&
      outcome.actualOrderPrice === transaction.order.price &&
      outcome.actualResource === transaction.resourceType &&
      outcome.actualFrom === transaction.from &&
      outcome.actualTo === transaction.to &&
      outcome.actualAmount === transaction.amount,
  );
}

/**
 * Validate the persisted store before normalization. Empty fallbacks are only
 * for constructing new state; they must never erase a malformed or missing
 * schema-v1 WAL container.
 */
export function isRecoverableDirectPendingStoreShape(
  value: unknown,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const store = value as Partial<DirectPendingStore>;
  const quarantine = store.quarantinedPendingDirectDeals;
  if (
    !store.pendingDirectDeals ||
    typeof store.pendingDirectDeals !== "object" ||
    Array.isArray(store.pendingDirectDeals) ||
    (quarantine !== undefined &&
      (!quarantine ||
        typeof quarantine !== "object" ||
        Array.isArray(quarantine))) ||
    !Array.isArray(store.directDealOutcomes) ||
    !Array.isArray(store.processedDirectTransactionKeys) ||
    !nonNegativeSafeInteger(store.directConfirmedDealCount) ||
    typeof store.directPausedForReview !== "boolean"
  ) {
    return false;
  }
  const pendingEntries = Object.entries(store.pendingDirectDeals);
  const outcomes = store.directDealOutcomes;
  if (
    pendingEntries.length > 1 ||
    (quarantine !== undefined &&
      Object.keys(quarantine).length > 0) ||
    outcomes.length > MAX_DIRECT_OUTCOMES ||
    store.processedDirectTransactionKeys.length >
      MAX_PROCESSED_TRANSACTION_KEYS ||
    outcomes.some(
      (outcome) => !isRecoverableDirectDealOutcome(outcome),
    ) ||
    new Set(outcomes.map((outcome) => outcome.requestId)).size !==
      outcomes.length ||
    store.processedDirectTransactionKeys.some(
      (key) => typeof key !== "string" || key.length === 0,
    ) ||
    new Set(store.processedDirectTransactionKeys).size !==
      store.processedDirectTransactionKeys.length
  ) {
    return false;
  }
  for (const [requestId, rawPending] of pendingEntries) {
    const pending = recoverPendingDirectDeal(
      rawPending,
      requestId,
    );
    if (!pending) return false;
    if (
      outcomes.some(
        (outcome) =>
          outcome.requestId === requestId &&
          !recoverableOutcomeMatchesPending(outcome, pending),
      )
    ) {
      return false;
    }
  }
  return true;
}

function confirmedOutcomeCount(
  outcomes: readonly DirectDealOutcome[],
): number {
  return new Set(
    outcomes
      .filter(
        (outcome) =>
          isRecoverableDirectDealOutcome(outcome) &&
          outcome.status === "confirmed",
      )
      .map((outcome) => outcome.requestId),
  ).size;
}

export function createEmptyDirectPendingStore(): DirectPendingStore {
  return {
    pendingDirectDeals: {},
    quarantinedPendingDirectDeals: {},
    directDealOutcomes: [],
    processedDirectTransactionKeys: [],
    directConfirmedDealCount: 0,
    directPausedForReview: false,
  };
}

export function normalizeDirectPendingStore(
  value: Partial<DirectPendingStore> | undefined,
): DirectPendingStore {
  const store = value || {};
  const rawPendingContainer =
    store.pendingDirectDeals as unknown;
  const rawPendingDirectDeals =
    rawPendingContainer &&
    typeof rawPendingContainer === "object" &&
    !Array.isArray(rawPendingContainer)
      ? {
          ...(rawPendingContainer as Record<string, unknown>),
        }
      : {};
  const pendingDirectDeals: Record<string, PendingDirectDeal> = {};
  const rawQuarantineContainer =
    store.quarantinedPendingDirectDeals as unknown;
  const quarantinedPendingDirectDeals: Record<string, unknown> =
    rawQuarantineContainer &&
    typeof rawQuarantineContainer === "object" &&
    !Array.isArray(rawQuarantineContainer)
      ? {
          ...(rawQuarantineContainer as Record<string, unknown>),
        }
      : {};
  if (
    value !== undefined &&
    (!rawPendingContainer ||
      typeof rawPendingContainer !== "object" ||
      Array.isArray(rawPendingContainer))
  ) {
    quarantinedPendingDirectDeals[
      "__pending_direct_deals_container__"
    ] =
      rawPendingContainer === undefined
        ? "missing_pending_direct_deals_container"
        : rawPendingContainer;
  }
  if (
    rawQuarantineContainer !== undefined &&
    (!rawQuarantineContainer ||
      typeof rawQuarantineContainer !== "object" ||
      Array.isArray(rawQuarantineContainer))
  ) {
    quarantinedPendingDirectDeals[
      "__quarantine_container__"
    ] = rawQuarantineContainer;
  }
  for (const [requestId, pending] of Object.entries(
    rawPendingDirectDeals,
  )) {
    const recovered = recoverPendingDirectDeal(
      pending,
      requestId,
    );
    if (recovered) {
      pendingDirectDeals[requestId] = recovered;
      delete quarantinedPendingDirectDeals[requestId];
    } else {
      quarantinedPendingDirectDeals[requestId] = pending;
    }
  }
  const directDealOutcomes = Array.isArray(store.directDealOutcomes)
    ? store.directDealOutcomes.slice(-MAX_DIRECT_OUTCOMES)
    : [];
  const processedDirectTransactionKeys = Array.isArray(
    store.processedDirectTransactionKeys,
  )
    ? store.processedDirectTransactionKeys
        .filter((key): key is string => typeof key === "string")
        .slice(-MAX_PROCESSED_TRANSACTION_KEYS)
    : [];

  for (const outcome of directDealOutcomes) {
    if (!isRecoverableDirectDealOutcome(outcome)) continue;
    const pending = pendingDirectDeals[outcome.requestId];
    if (
      pending &&
      isRecoverablePendingDirectDeal(
        pending,
        outcome.requestId,
      ) &&
      recoverableOutcomeMatchesPending(outcome, pending)
    ) {
      delete pendingDirectDeals[outcome.requestId];
    }
    if (
      outcome.status === "confirmed" &&
      outcome.transactionId &&
      !processedDirectTransactionKeys.includes(
        `${outcome.transactionId}:${outcome.orderId}`,
      )
    ) {
      boundedPush(
        processedDirectTransactionKeys,
        `${outcome.transactionId}:${outcome.orderId}`,
        MAX_PROCESSED_TRANSACTION_KEYS,
      );
    }
  }
  const recoveredConfirmedCount =
    confirmedOutcomeCount(directDealOutcomes);
  return {
    pendingDirectDeals,
    quarantinedPendingDirectDeals,
    directDealOutcomes,
    processedDirectTransactionKeys,
    directConfirmedDealCount: nonNegativeSafeInteger(
      store.directConfirmedDealCount,
    )
      ? Math.max(
          store.directConfirmedDealCount,
          recoveredConfirmedCount,
        )
      : recoveredConfirmedCount,
    // 该终态只能从持久 true 继续，配置 revision 不得把它复位。
    directPausedForReview:
      store.directPausedForReview === true ||
      recoveredConfirmedCount > 0 ||
      directDealOutcomes.some(
        (outcome) =>
          isRecoverableDirectDealOutcome(outcome) &&
          outcome.status === "confirmed",
      ),
  };
}

export function prepareDirectPending(
  store: DirectPendingStore,
  input: PrepareDirectPendingInput,
): PendingDirectDeal | undefined {
  if (
    !input.requestId ||
    !input.configRevision ||
    !input.directSafetyFingerprint ||
    !input.canaryRoomName ||
    !input.orderId ||
    !input.orderRoomName ||
    !positiveSafeInteger(input.observedOrderAmount) ||
    !positiveSafeInteger(input.dealAmount) ||
    input.dealAmount > input.observedOrderAmount ||
    !nonNegativeSafeInteger(input.transactionEnergy) ||
    !finiteNonNegative(input.effectiveEnergyShadowPrice) ||
    !positiveSafeInteger(input.netCreditsMilli) ||
    !Number.isSafeInteger(input.worstCaseNetCreditsMilli) ||
    !finiteNonNegative(input.effectiveNetFloor) ||
    !nonNegativeSafeInteger(input.protectionRevision) ||
    !nonNegativeSafeInteger(input.preparedAt) ||
    input.attemptAt !== input.preparedAt ||
    !Array.isArray(input.outgoingWindowBefore.transactions) ||
    store.pendingDirectDeals[input.requestId] ||
    Object.keys(store.pendingDirectDeals).length > 0
  ) {
    return undefined;
  }

  let observedOrderPriceMilli: number;
  let effectiveEnergyShadowPriceMilli: number;
  let effectiveNetFloorMilli: number;
  try {
    observedOrderPriceMilli = priceToMilliDown(input.observedOrderPrice);
    effectiveEnergyShadowPriceMilli = priceToMilliUp(
      Math.max(input.effectiveEnergyShadowPrice, Number.MIN_VALUE),
    );
    if (input.effectiveEnergyShadowPrice === 0) {
      effectiveEnergyShadowPriceMilli = 0;
    }
    effectiveNetFloorMilli = priceToMilliUp(input.effectiveNetFloor);
  } catch {
    return undefined;
  }

  const pending: PendingDirectDeal = {
    requestId: input.requestId,
    status: "prepared",
    configRevision: input.configRevision,
    directSafetyFingerprint: input.directSafetyFingerprint,
    canaryRoomName: input.canaryRoomName,
    resource: input.resource,
    orderId: input.orderId,
    orderRoomName: input.orderRoomName,
    observedOrderPrice: input.observedOrderPrice,
    observedOrderPriceMilli,
    observedOrderAmount: input.observedOrderAmount,
    dealAmount: input.dealAmount,
    transactionEnergy: input.transactionEnergy,
    effectiveEnergyShadowPrice: input.effectiveEnergyShadowPrice,
    effectiveEnergyShadowPriceMilli,
    energyShadowComponents: { ...input.energyShadowComponents },
    energyShadowObservedAt: input.energyShadowObservedAt,
    netCreditsMilli: input.netCreditsMilli,
    worstCaseActualAmount:
      DIRECT_ENGINE_ASSUMPTIONS.minimumPositiveExecutionAmount,
    worstCaseNetCreditsMilli: input.worstCaseNetCreditsMilli,
    effectiveNetFloor: input.effectiveNetFloor,
    effectiveNetFloorMilli,
    protectionRevision: input.protectionRevision,
    terminalResourceBefore: input.physicalBefore.terminalResource,
    terminalEnergyBefore: input.physicalBefore.terminalEnergy,
    terminalCooldownBefore: input.physicalBefore.terminalCooldown,
    creditsBefore: input.physicalBefore.credits,
    preparedAt: input.preparedAt,
    attemptAt: input.attemptAt,
    outgoingTransactionKeysBefore:
      input.outgoingWindowBefore.transactions.map(transactionKey),
    outgoingWindowBefore: {
      observedAt: input.outgoingWindowBefore.observedAt,
      count: input.outgoingWindowBefore.transactions.length,
      oldestTime: input.outgoingWindowBefore.oldestTime,
      newestTime: input.outgoingWindowBefore.newestTime,
    },
    successfulMissingObservationTicks: [],
  };
  store.pendingDirectDeals[pending.requestId] = pending;
  return pending;
}

export function markDirectSubmissionResult(
  store: DirectPendingStore,
  requestId: string,
  input:
    | { kind: "ok"; tick: number; resultCode?: number }
    | { kind: "non_ok"; tick: number; resultCode: number }
    | { kind: "unknown"; tick: number; resultCode?: number }
    | { kind: "threw"; tick: number },
): void {
  const pending = store.pendingDirectDeals[requestId];
  if (!pending) return;
  if (input.kind === "ok") {
    // Commit marker 最后写。此前任一 CPU 截断仍是可恢复的 prepared，
    // 跨 tick 只会对账而不会重提。
    pending.resultCode = input.resultCode;
    pending.submittedAt = input.tick;
    pending.status = "submitted";
    return;
  }
  if (input.kind === "non_ok") {
    appendOutcome(store, {
      ...outcomeBase(pending),
      status: "failed",
      resolvedAt: input.tick,
      resultCode: input.resultCode,
      reason: `deal_non_ok:${input.resultCode}`,
      evidenceSource: "automatic",
      evidenceKey: `deal-return:${input.resultCode}`,
    });
    delete store.pendingDirectDeals[requestId];
    return;
  }
  // unknown/throw 可能发生在服务器已接收 intent 之后；保留 prepared，
  // 跨 tick 只对账，绝不重提。
  pending.resultCode =
    input.kind === "unknown" ? input.resultCode : undefined;
}

function physicalUnchanged(
  pending: PendingDirectDeal,
  physical: DirectPhysicalSnapshot,
): DirectFirstPostAttemptObservation {
  return {
    observedAt: 0,
    windowCoversAttemptAt: false,
    terminalResourceUnchanged:
      physical.terminalResource === pending.terminalResourceBefore,
    terminalEnergyUnchanged:
      physical.terminalEnergy === pending.terminalEnergyBefore,
    terminalCooldownUnchanged:
      physical.terminalCooldown === pending.terminalCooldownBefore,
    creditsUnchanged: physical.credits === pending.creditsBefore,
  };
}

function exactTupleMatches(
  pending: PendingDirectDeal,
  transaction: DirectOutgoingTransaction,
): boolean {
  return Boolean(
    transaction.order &&
      transaction.time === pending.attemptAt &&
      transaction.order.id === pending.orderId &&
      transaction.order.type === ORDER_BUY &&
      transaction.order.price === pending.observedOrderPrice &&
      transaction.from === pending.canaryRoomName &&
      transaction.to === pending.orderRoomName &&
      transaction.resourceType === pending.resource &&
      positiveSafeInteger(transaction.amount) &&
      transaction.amount <= pending.dealAmount,
  );
}

function finalizeConfirmed(
  store: DirectPendingStore,
  pending: PendingDirectDeal,
  transaction: DirectOutgoingTransaction,
  resolvedAt: number,
  dependencies: DirectPendingReconcileDependencies,
  evidenceSource: "automatic" | "operator",
  operator?: string,
): { ok: true } | { ok: false; reason: string } {
  if (!exactTupleMatches(pending, transaction)) {
    return { ok: false, reason: "direct_transaction_tuple_mismatch" };
  }
  const key = transactionKey(transaction);
  if (
    pending.outgoingTransactionKeysBefore.includes(key) ||
    store.processedDirectTransactionKeys.includes(key)
  ) {
    return { ok: false, reason: "direct_transaction_already_processed" };
  }

  let actualEnergy: number;
  try {
    actualEnergy = dependencies.calculateTransactionEnergy(
      transaction.amount,
      pending.canaryRoomName,
      pending.orderRoomName,
    );
  } catch {
    return { ok: false, reason: "direct_actual_energy_unknown" };
  }
  if (!nonNegativeSafeInteger(actualEnergy)) {
    return { ok: false, reason: "direct_actual_energy_invalid" };
  }
  const gross = checkedMultiply(
    pending.observedOrderPriceMilli,
    transaction.amount,
  );
  const shadowCost = checkedMultiply(
    actualEnergy,
    pending.effectiveEnergyShadowPriceMilli,
  );
  const required = checkedMultiply(
    pending.effectiveNetFloorMilli,
    transaction.amount,
  );
  if (
    gross === undefined ||
    shadowCost === undefined ||
    required === undefined
  ) {
    return { ok: false, reason: "direct_actual_milli_overflow" };
  }
  const actualNet = checkedSubtract(gross, shadowCost);
  if (actualNet === undefined || actualNet < required) {
    return { ok: false, reason: "direct_actual_net_below_floor" };
  }

  appendOutcome(store, {
    ...outcomeBase(pending),
    status: "confirmed",
    resolvedAt,
    transactionId: transaction.transactionId,
    transactionTime: transaction.time,
    actualOrderType: transaction.order!.type,
    actualOrderPrice: transaction.order!.price,
    actualResource: transaction.resourceType,
    actualFrom: transaction.from,
    actualTo: transaction.to,
    actualAmount: transaction.amount,
    actualTransactionEnergy: actualEnergy,
    actualNetCreditsMilli: actualNet,
    evidenceSource,
    evidenceKey: key,
    operator,
  });
  store.directConfirmedDealCount = Math.max(
    store.directConfirmedDealCount,
    confirmedOutcomeCount(store.directDealOutcomes),
  );
  store.directPausedForReview = true;
  boundedPush(
    store.processedDirectTransactionKeys,
    key,
    MAX_PROCESSED_TRANSACTION_KEYS,
  );
  // Active pending 最后删除；上述任一步中断时 normalize 可由完整 outcome 恢复。
  delete store.pendingDirectDeals[pending.requestId];
  return { ok: true };
}

function enterGap(
  pending: PendingDirectDeal,
  reason: string,
  result: DirectPendingReconcileResult,
): void {
  pending.status = "reconcile_gap";
  result.gaps += 1;
  result.rejectedByReason[reason] =
    (result.rejectedByReason[reason] || 0) + 1;
  result.actions.push(`direct-gap:${pending.requestId}:${reason}`);
}

function finalizeNotFilled(
  store: DirectPendingStore,
  pending: PendingDirectDeal,
  resolvedAt: number,
  evidenceSource: "automatic" | "operator",
  evidenceKey: string,
  operator?: string,
  operatorEvidenceFingerprint?: string,
): void {
  appendOutcome(store, {
    ...outcomeBase(pending),
    status: "not_filled",
    resolvedAt,
    evidenceSource,
    evidenceKey,
    operator,
    operatorEvidenceFingerprint,
  });
  delete store.pendingDirectDeals[pending.requestId];
}

/**
 * 每 tick 最早 preflight 调用。prepared 跨 tick 与 submitted 同等对账；
 * reconcile_gap 不自动清除，且 attemptAt+1 后无论结果如何都释放账户 claim。
 */
export function reconcileDirectPendingDeals(
  store: DirectPendingStore,
  input: {
    tick: number;
    outgoingWindow?: DirectOutgoingWindow;
  },
  dependencies: DirectPendingReconcileDependencies,
): DirectPendingReconcileResult {
  const result: DirectPendingReconcileResult = {
    actions: [],
    rejectedByReason: {},
    confirmed: 0,
    resolved: 0,
    gaps: 0,
  };
  for (const pending of Object.values(store.pendingDirectDeals).sort((a, b) =>
    a.requestId.localeCompare(b.requestId),
  )) {
    if (pending.status === "reconcile_gap") {
      if (input.tick >= pending.attemptAt + 1) {
        dependencies.releasePreparedClaims(pending.requestId);
      }
      result.gaps += 1;
      continue;
    }
    if (input.tick < pending.attemptAt) {
      enterGap(pending, "direct_tick_before_attempt", result);
      continue;
    }

    try {
      const window = input.outgoingWindow;
      if (!window) {
        if (input.tick >= pending.attemptAt + 1) {
          enterGap(pending, "direct_outgoing_window_missing", result);
        }
        continue;
      }
      if (window.observedAt !== input.tick) {
        if (input.tick >= pending.attemptAt + 1) {
          enterGap(pending, "direct_outgoing_window_stale", result);
        }
        continue;
      }
      const baseline = new Set(pending.outgoingTransactionKeysBefore);
      const newTransactions = window.transactions.filter(
        (transaction) =>
          !baseline.has(transactionKey(transaction)) &&
          !store.processedDirectTransactionKeys.includes(
            transactionKey(transaction),
          ),
      );
      const sameAttemptOrder = newTransactions.filter(
        (transaction) =>
          transaction.time === pending.attemptAt &&
          transaction.order?.id === pending.orderId,
      );
      const exact = sameAttemptOrder.filter((transaction) =>
        exactTupleMatches(pending, transaction),
      );

      if (sameAttemptOrder.length > 0) {
        if (sameAttemptOrder.length !== 1 || exact.length !== 1) {
          enterGap(pending, "direct_transaction_ambiguous", result);
          continue;
        }
        const confirmed = finalizeConfirmed(
          store,
          pending,
          exact[0],
          input.tick,
          dependencies,
          "automatic",
        );
        if ("reason" in confirmed) {
          enterGap(pending, confirmed.reason, result);
          continue;
        }
        result.confirmed += 1;
        result.resolved += 1;
        result.actions.push(
          `direct-confirmed:${pending.requestId}:${exact[0].amount}`,
        );
        continue;
      }

      if (input.tick < pending.attemptAt + 1) continue;
      if (!window.coversAttemptAt) {
        enterGap(pending, "direct_outgoing_window_truncated", result);
        continue;
      }
      if (input.tick === pending.attemptAt + 1) {
        const physical = dependencies.readPhysicalSnapshot(pending);
        if (!physical) {
          enterGap(pending, "direct_first_physical_observation_missing", result);
          continue;
        }
        const observation = physicalUnchanged(pending, physical);
        observation.observedAt = input.tick;
        observation.windowCoversAttemptAt = true;
        if (
          !observation.terminalResourceUnchanged ||
          !observation.terminalEnergyUnchanged ||
          !observation.terminalCooldownUnchanged ||
          !observation.creditsUnchanged
        ) {
          // 先写 gap commit marker，再保存 changed observation。任一 CPU
          // 截断都保持不确定 intent 与 exposure，绝不留下 invalid typed WAL。
          enterGap(pending, "direct_first_physical_state_changed", result);
          pending.firstPostAttemptObservation = observation;
          continue;
        }
        pending.firstPostAttemptObservation = observation;
      } else if (!pending.firstPostAttemptObservation) {
        enterGap(pending, "direct_first_observation_tick_missed", result);
        continue;
      } else if (
        !pending.firstPostAttemptObservation
          .terminalResourceUnchanged ||
        !pending.firstPostAttemptObservation.terminalEnergyUnchanged ||
        !pending.firstPostAttemptObservation
          .terminalCooldownUnchanged ||
        !pending.firstPostAttemptObservation.creditsUnchanged
      ) {
        enterGap(
          pending,
          "direct_first_physical_state_changed",
          result,
        );
        continue;
      }

      if (
        pending.successfulMissingObservationTicks.length === 0 &&
        pending.firstPostAttemptObservation
      ) {
        // 若上个 tick 在持久化首个 unchanged observation 后 CPU 截断，
        // 该 observation 本身已经证明当时窗口完整且无 exact transaction。
        pending.successfulMissingObservationTicks.push(
          pending.firstPostAttemptObservation.observedAt,
        );
      }
      if (pending.successfulMissingObservationTicks.length >= 2) {
        const completedTicks =
          pending.successfulMissingObservationTicks.slice(0, 2);
        finalizeNotFilled(
          store,
          pending,
          completedTicks[1],
          "automatic",
          `missing:${completedTicks.join(",")}`,
        );
        result.resolved += 1;
        result.actions.push(`direct-not-filled:${pending.requestId}`);
        continue;
      }
      if (
        !pending.successfulMissingObservationTicks.includes(input.tick)
      ) {
        pending.successfulMissingObservationTicks.push(input.tick);
        pending.successfulMissingObservationTicks =
          pending.successfulMissingObservationTicks.slice(-2);
      }
      if (pending.successfulMissingObservationTicks.length >= 2) {
        const completedTicks =
          pending.successfulMissingObservationTicks.slice(0, 2);
        finalizeNotFilled(
          store,
          pending,
          completedTicks[1],
          "automatic",
          `missing:${completedTicks.join(",")}`,
        );
        result.resolved += 1;
        result.actions.push(`direct-not-filled:${pending.requestId}`);
      }
    } finally {
      if (input.tick >= pending.attemptAt + 1) {
        dependencies.releasePreparedClaims(pending.requestId);
      }
    }
  }
  return result;
}

/**
 * Operator 只能提交 exact transaction 或权威 no-fill 证据；不能“强制清除”。
 */
export function resolveDirectPendingWithEvidence(
  store: DirectPendingStore,
  evidence: OperatorDirectPendingEvidence,
  resolvedAt: number,
  dependencies: DirectPendingReconcileDependencies,
): { ok: true; duplicate?: boolean } | { ok: false; error: string } {
  if (
    !evidence ||
    typeof evidence !== "object" ||
    typeof evidence.requestId !== "string" ||
    !evidence.requestId ||
    typeof evidence.orderId !== "string" ||
    !evidence.orderId ||
    typeof evidence.operator !== "string" ||
    !evidence.operator.trim() ||
    !nonNegativeSafeInteger(resolvedAt) ||
    (evidence.kind !== "transaction" &&
      evidence.kind !== "not_filled")
  ) {
    return { ok: false, error: "direct_operator_evidence_invalid" };
  }
  if (
    (evidence.kind === "transaction" &&
      !outgoingTransactionShapeValid(evidence.transaction, true)) ||
    (evidence.kind === "not_filled" &&
      (!operatorWindowShapeValid(evidence.window, resolvedAt) ||
        !operatorPhysicalSnapshotValid(evidence.physical)))
  ) {
    return { ok: false, error: "direct_operator_evidence_invalid" };
  }
  const pending = store.pendingDirectDeals[evidence.requestId];
  if (!pending) {
    const noFillFingerprint =
      evidence.kind === "not_filled"
        ? operatorNoFillEvidenceFingerprint(
            evidence.window,
            evidence.physical,
          )
        : undefined;
    const prior = store.directDealOutcomes.some(
      (outcome) => {
        if (
          !isRecoverableDirectDealOutcome(outcome) ||
          outcome.requestId !== evidence.requestId ||
          outcome.orderId !== evidence.orderId
        ) {
          return false;
        }
        if (evidence.kind === "transaction") {
          return confirmedOutcomeMatchesTransaction(
            outcome,
            evidence.transaction,
          );
        }
        return (
          outcome.status === "not_filled" &&
          outcome.evidenceSource === "operator" &&
          outcome.operator === evidence.operator.trim() &&
          outcome.evidenceKey ===
            `operator-window:${evidence.window.observedAt}:${evidence.window.transactions.length}` &&
          outcome.operatorEvidenceFingerprint === noFillFingerprint
        );
      },
    );
    if (prior) return { ok: true, duplicate: true };
    const conflictingPrior = store.directDealOutcomes.some(
      (outcome) =>
        isRecoverableDirectDealOutcome(outcome) &&
        outcome.requestId === evidence.requestId &&
        outcome.orderId === evidence.orderId,
    );
    if (conflictingPrior) {
      store.directPausedForReview = true;
      return {
        ok: false,
        error: "direct_operator_evidence_conflict",
      };
    }
    return { ok: false, error: "direct_pending_missing" };
  }
  if (
    pending.orderId !== evidence.orderId ||
    !evidence.operator.trim() ||
    resolvedAt < pending.attemptAt + 1
  ) {
    return { ok: false, error: "direct_operator_evidence_identity_mismatch" };
  }
  if (evidence.kind === "transaction") {
    const result = finalizeConfirmed(
      store,
      pending,
      evidence.transaction,
      resolvedAt,
      dependencies,
      "operator",
      evidence.operator.trim(),
    );
    if (!("reason" in result)) {
      dependencies.releasePreparedClaims(pending.requestId);
    }
    return "reason" in result
      ? { ok: false, error: result.reason }
      : { ok: true };
  }

  if (
    evidence.window.observedAt < pending.attemptAt + 1 ||
    evidence.window.transactions.some(
      (transaction) =>
        transaction.time === pending.attemptAt &&
        transaction.order?.id === pending.orderId,
    )
  ) {
    return { ok: false, error: "direct_operator_no_fill_window_invalid" };
  }
  const observation = physicalUnchanged(pending, evidence.physical);
  if (
    !observation.terminalResourceUnchanged ||
    !observation.terminalEnergyUnchanged ||
    !observation.terminalCooldownUnchanged ||
    !observation.creditsUnchanged
  ) {
    return { ok: false, error: "direct_operator_no_fill_physical_mismatch" };
  }
  finalizeNotFilled(
    store,
    pending,
    resolvedAt,
    "operator",
    `operator-window:${evidence.window.observedAt}:${evidence.window.transactions.length}`,
    evidence.operator.trim(),
    operatorNoFillEvidenceFingerprint(
      evidence.window,
      evidence.physical,
    ),
  );
  dependencies.releasePreparedClaims(pending.requestId);
  return { ok: true };
}

export function summarizeDirectPendingExposure(
  store: DirectPendingStore,
): {
  pendingCount: number;
  quarantinedCount: number;
  resourceAmount: number;
  transactionEnergy: number;
  reconcileGapCount: number;
} {
  const summary = Object.values(store.pendingDirectDeals).reduce(
    (summary, pending) => ({
      pendingCount: summary.pendingCount + 1,
      quarantinedCount: summary.quarantinedCount,
      resourceAmount: summary.resourceAmount + pending.dealAmount,
      transactionEnergy:
        summary.transactionEnergy + pending.transactionEnergy,
      reconcileGapCount:
        summary.reconcileGapCount +
        (pending.status === "reconcile_gap" ? 1 : 0),
    }),
    {
      pendingCount: 0,
      quarantinedCount: 0,
      resourceAmount: 0,
      transactionEnergy: 0,
      reconcileGapCount: 0,
    },
  );
  for (const evidence of Object.values(
    store.quarantinedPendingDirectDeals || {},
  )) {
    const raw =
      evidence &&
      typeof evidence === "object" &&
      !Array.isArray(evidence)
        ? (evidence as Partial<PendingDirectDeal>)
        : undefined;
    const resourceAmount = positiveSafeInteger(raw?.dealAmount)
      ? raw.dealAmount
      : 1;
    const transactionEnergy = nonNegativeSafeInteger(
      raw?.transactionEnergy,
    )
      ? raw.transactionEnergy
      : 1;
    summary.pendingCount += 1;
    summary.quarantinedCount += 1;
    summary.resourceAmount = Number.isSafeInteger(
      summary.resourceAmount + resourceAmount,
    )
      ? summary.resourceAmount + resourceAmount
      : Number.MAX_SAFE_INTEGER;
    summary.transactionEnergy = Number.isSafeInteger(
      summary.transactionEnergy + transactionEnergy,
    )
      ? summary.transactionEnergy + transactionEnergy
      : Number.MAX_SAFE_INTEGER;
    summary.reconcileGapCount += 1;
  }
  return summary;
}
