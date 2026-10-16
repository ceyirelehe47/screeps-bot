/** 从 marketSaleAutomation.ts 分离的独立职责模块；共享状态仅由此处持有。 */
import { executeCancelOrder } from "@/runtime/marketActionArbiter";
import { type MarketSaleAutomationConfig, type ResolvedMarketSaleAutomationConfig } from "@/runtime/marketSaleConfig";
import { type MarketBaseResourceCpuTrace } from "@/runtime/marketBaseResourceAutomation";
import { priceToMilliUp } from "@/runtime/marketSalePricing";
import {
  applyFillFeeDebt,
  createEmptyMarketSaleFeeLedger,
  markExternalOrderMutationFeeGap,
  reconcileDisappearedOrderFeeDebt,
} from "@/runtime/marketSaleFeeLedger";
import {
  createPendingMutation,
  markPendingMutationSubmitted,
  reconcilePendingCreate,
  reconcilePendingMutation,
  type ManagedMarketOrderState,
  type MarketOrderSnapshot,
  type OrderMutationLease,
  type PendingCreateState,
} from "@/runtime/marketSaleLifecycle";
import { boundedPush, MAX_FEE_EVENTS, appendAudit } from "@/runtime/marketSaleOperators";
import type { MarketSaleDataState, OwnedPendingCreate, OwnedManagedOrder } from "@/runtime/marketSaleOperators";

export const MAX_RECENT_ACTIONS = 20;
const MAX_TRANSACTION_KEYS = 200;

export type MarketSaleRuntimeState = NonNullable<
  NonNullable<Memory["runtime"]>["marketSaleAutomation"]
> & {
  lastShadowCycleTick?: number;
  shadowConfigSignature?: string;
};

export interface RunContext {
  config: ResolvedMarketSaleAutomationConfig;
  data: MarketSaleDataState;
  runtime: MarketSaleRuntimeState;
  liveOrders: MarketOrderSnapshot[];
  liveOrderById: Map<string, MarketOrderSnapshot>;
  /** liveOrders 是否已加载（懒标记：同 tick 至多读一次 Game.market.orders）。 */
  liveOrdersLoaded: boolean;
  actions: string[];
  rejectedByReason: Record<string, number>;
  writes: number;
  shadowPlanComplete: boolean;
  stagingAmount: number;
  reservationAmount: number;
  marketDomainActivityValid: boolean;
  marketBaseResourceCpuTrace?: MarketBaseResourceCpuTrace;
  /**
   * 本 tick 的合成 planning 判定（外层显式授权 && RC 新鲜度）。
   * 由 runMarketSaleAutomation 在进入 planning 段前写入；内部组件
   * （updateShadowCount 等）读此字段，不得再从 ResourceControl.updatedAt
   * 自行推导。
   */
  planningCycleCurrent?: boolean;
}

export function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

export function orderFingerprint(order: MarketOrderSnapshot): string {
  return [
    order.id,
    order.type,
    order.resourceType,
    order.roomName || "",
    order.price,
    order.totalAmount ?? "",
    order.created,
  ].join("|");
}

export function reject(context: RunContext, reason: string): void {
  context.rejectedByReason[reason] =
    (context.rejectedByReason[reason] || 0) + 1;
}

export function recordAction(context: RunContext, action: string): void {
  boundedPush(context.actions, action, MAX_RECENT_ACTIONS);
}

export function carryFeeDebt(
  data: MarketSaleDataState,
  resource: ResourceConstant,
  amountMilli: number,
  id: string,
): void {
  const amount = nonNegativeInteger(amountMilli);
  if (amount <= 0) return;
  data.carriedFeeDebtMilli[resource] =
    nonNegativeInteger(data.carriedFeeDebtMilli[resource]) + amount;
  if (!data.feeEvents.some((event) => event.id === id)) {
    boundedPush(
      data.feeEvents,
      {
        id,
        tick: Game.time,
        resource,
        amountMilli: amount,
        kind: "carry",
      },
      MAX_FEE_EVENTS,
    );
  }
}

type PendingCreateZeroDeltaEvidence = "absent" | "filled" | "insufficient";

function creditsToMilli(value: number): number | undefined {
  const milli = Math.round(value * 1_000);
  return Number.isSafeInteger(milli) && milli >= 0 ? milli : undefined;
}

/**
 * 仅凭 order-ID 零差异无法区分“未创建”与“观察前已经成交完”。必须用预写的
 * credits、terminal 与 outgoing transaction 基线把结果收敛到唯一结论。
 */
function classifyPendingCreateZeroDelta(
  pending: OwnedPendingCreate,
): PendingCreateZeroDeltaEvidence {
  if (
    typeof pending.creditsBefore !== "number" ||
    !Number.isFinite(pending.creditsBefore) ||
    typeof pending.terminalStockBefore !== "number" ||
    !Number.isSafeInteger(pending.terminalStockBefore) ||
    pending.terminalStockBefore < 0 ||
    !Array.isArray(pending.outgoingKeysBefore) ||
    !pending.tuple.roomName
  ) {
    return "insufficient";
  }
  const credits = Game.market?.credits;
  const terminal = roomTerminal(pending.tuple.roomName);
  const terminalStock = terminal?.store.getUsedCapacity(
    pending.tuple.resourceType,
  );
  if (
    typeof credits !== "number" ||
    !Number.isFinite(credits) ||
    typeof terminalStock !== "number" ||
    !Number.isSafeInteger(terminalStock) ||
    terminalStock < 0
  ) {
    return "insufficient";
  }
  const creditsBeforeMilli = creditsToMilli(pending.creditsBefore);
  const creditsAfterMilli = creditsToMilli(credits);
  if (creditsBeforeMilli === undefined || creditsAfterMilli === undefined) {
    return "insufficient";
  }

  const outgoingBaseline = new Set(pending.outgoingKeysBefore);
  const newOutgoing = (Game.market?.outgoingTransactions || []).filter(
    (transaction) => !outgoingBaseline.has(transaction.transactionId),
  );
  const creditDeltaMilli = creditsAfterMilli - creditsBeforeMilli;
  if (
    newOutgoing.length === 0 &&
    terminalStock === pending.terminalStockBefore &&
    creditDeltaMilli === -pending.feeMilli
  ) {
    return "absent";
  }

  let priceMilli: number;
  try {
    priceMilli = priceToMilliUp(pending.tuple.price);
  } catch {
    return "insufficient";
  }
  const matchingOrderIds = new Set<string>();
  let filledAmount = 0;
  for (const transaction of newOutgoing) {
    const transactionOrder = transaction.order;
    let transactionPriceMilli: number | undefined;
    try {
      transactionPriceMilli = transactionOrder
        ? priceToMilliUp(transactionOrder.price)
        : undefined;
    } catch {
      return "insufficient";
    }
    if (
      !transactionOrder ||
      transactionOrder.type !== ORDER_SELL ||
      transaction.resourceType !== pending.tuple.resourceType ||
      transaction.from !== pending.tuple.roomName ||
      transactionPriceMilli !== priceMilli ||
      !Number.isSafeInteger(transaction.amount) ||
      transaction.amount <= 0 ||
      transaction.time < pending.requestedAt
    ) {
      return "insufficient";
    }
    matchingOrderIds.add(transactionOrder.id);
    filledAmount += transaction.amount;
  }
  if (
    newOutgoing.length > 0 &&
    matchingOrderIds.size === 1 &&
    filledAmount === pending.tuple.totalAmount &&
    terminalStock === pending.terminalStockBefore - pending.tuple.totalAmount &&
    creditDeltaMilli ===
      priceMilli * pending.tuple.totalAmount - pending.feeMilli
  ) {
    return "filled";
  }
  return "insufficient";
}

function transactionOrderId(transaction: Transaction): string | undefined {
  const order = transaction.order as { id?: string } | undefined;
  return typeof order?.id === "string" ? order.id : undefined;
}

function transactionKey(transaction: Transaction, orderId: string): string {
  return `${transaction.transactionId}:${orderId}`;
}

function unprocessedFillTransactions(
  data: MarketSaleDataState,
  orderId: string,
  notBeforeTick: number,
): Transaction[] {
  const processed = new Set(data.processedTransactionKeys);
  return (Game.market?.outgoingTransactions || [])
    .filter(
      (transaction) =>
        transactionOrderId(transaction) === orderId &&
        transaction.time >= notBeforeTick &&
        !processed.has(transactionKey(transaction, orderId)),
    )
    .sort(
      (left, right) =>
        left.time - right.time ||
        left.transactionId.localeCompare(right.transactionId),
    );
}

function markTransactionsProcessed(
  data: MarketSaleDataState,
  orderId: string,
  transactions: readonly Transaction[],
): void {
  for (const transaction of transactions) {
    const key = transactionKey(transaction, orderId);
    if (!data.processedTransactionKeys.includes(key)) {
      boundedPush(data.processedTransactionKeys, key, MAX_TRANSACTION_KEYS);
    }
  }
}

function allocateObservedFill(
  data: MarketSaleDataState,
  managed: ManagedMarketOrderState,
  filledAmount: number,
  transactions: readonly Transaction[],
  config: MarketSaleAutomationConfig,
): boolean {
  if (filledAmount <= 0) return true;
  const transactionAmount = transactions.reduce(
    (sum, transaction) => sum + nonNegativeInteger(transaction.amount),
    0,
  );
  if (transactionAmount !== filledAmount) return false;
  let feeDebtMilli = nonNegativeInteger(managed.feeDebtMilli);
  let preRemainingAmount = managed.lastRemainingAmount;
  try {
    for (const transaction of transactions) {
      const amount = nonNegativeInteger(transaction.amount);
      if (amount <= 0 || amount > preRemainingAmount) return false;
      const result = applyFillFeeDebt({
        ledger: data.feeLedger || createEmptyMarketSaleFeeLedger(),
        gameTime: Game.time,
        transactionId: transaction.transactionId,
        orderId: managed.orderId,
        feeDebtMilli,
        filledAmount: amount,
        preRemainingAmount,
        limits: {
          feeWindowTicks: config.feeWindowTicks,
          fillReceiptWindowTicks: config.feeWindowTicks,
        },
      });
      data.feeLedger = result.ledger;
      if (
        result.reconcileGap ||
        result.duplicate ||
        !result.applied ||
        !result.allocation
      ) {
        return false;
      }
      feeDebtMilli = result.allocation.remainingFeeDebtMilli;
      preRemainingAmount = result.allocation.postRemainingAmount;
    }
  } catch {
    return false;
  }
  managed.feeDebtMilli = feeDebtMilli;
  managed.lastRemainingAmount = preRemainingAmount;
  managed.remainingExposure = preRemainingAmount;
  managed.lastFillAt = Game.time;
  markTransactionsProcessed(data, managed.orderId, transactions);
  return true;
}

export function adoptPendingOrder(
  context: RunContext,
  pending: PendingCreateState,
  orderId: string,
): boolean {
  const order = context.liveOrderById.get(orderId);
  if (!order || !order.roomName) return false;
  const carried = nonNegativeInteger(
    context.data.carriedFeeDebtMilli[
      pending.tuple.resourceType as ResourceConstant
    ],
  );
  const managed: OwnedManagedOrder = {
    orderId,
    roomName: order.roomName,
    resourceType: pending.tuple.resourceType as ResourceConstant,
    price: order.price,
    originalAmount: pending.tuple.totalAmount,
    lastRemainingAmount: pending.tuple.totalAmount,
    remainingExposure: pending.tuple.totalAmount,
    feeDebtMilli: pending.feeMilli + carried,
    createdAt: pending.requestedAt,
    lastSeenAt: pending.requestedAt,
    policyCancelAtTick: pending.requestedAt + context.config.orderPolicyTtl,
    serverCreatedTick: order.created,
  };
  context.data.carriedFeeDebtMilli[
    pending.tuple.resourceType as ResourceConstant
  ] = 0;
  context.data.managedOrders[orderId] = managed;
  context.data.pendingCreate = undefined;
  appendAudit(context.data, {
    action: "pending_create_adopted",
    orderId,
    requestId: pending.requestId,
  });
  recordAction(context, `adopt:${orderId}`);
  return true;
}

function reconcilePendingCreateState(context: RunContext): void {
  const pending = context.data.pendingCreate;
  if (!pending) return;
  const lease = Memory.cfg?.marketSaleAutomation?.orderMutationLease as
    OrderMutationLease | undefined;
  const baselineChanged = Boolean(
    pending.baselineOrderFingerprints &&
    Object.entries(pending.baselineOrderFingerprints).some(
      ([orderId, fingerprint]) => {
        const live = context.liveOrderById.get(orderId);
        return !live || orderFingerprint(live) !== fingerprint;
      },
    ),
  );
  const result = reconcilePendingCreate({
    pending,
    liveOrders: context.liveOrders,
    lease: baselineChanged ? undefined : lease,
    gameTime: Game.time,
  });
  if (result.adoptedOrderId) {
    if (!adoptPendingOrder(context, pending, result.adoptedOrderId)) {
      context.data.pendingCreate = {
        ...pending,
        status: "ambiguous",
      };
      reject(context, "pending_create_adoption_failed");
    }
    return;
  }
  if (result.pending) {
    context.data.pendingCreate = {
      ...result.pending,
      creditsBefore: pending.creditsBefore,
      terminalStockBefore: pending.terminalStockBefore,
      outgoingKeysBefore: pending.outgoingKeysBefore,
      baselineOrderFingerprints: pending.baselineOrderFingerprints,
      operatorResolutionCandidateIds: pending.operatorResolutionCandidateIds,
    } as unknown as OwnedPendingCreate;
    if (result.blockedReason)
      reject(context, `pending_create:${result.blockedReason}`);
    return;
  }
  if (result.resolvedAs === "filled_or_absent") {
    const operatorResolved =
      pending.operatorResolutionCandidateIds !== undefined;
    const evidence = operatorResolved
      ? "absent"
      : classifyPendingCreateZeroDelta(pending);
    if (evidence === "insufficient") {
      context.data.pendingCreate = {
        ...pending,
        status: "ambiguous",
        zeroDeltaConfirmations: Math.max(2, pending.zeroDeltaConfirmations),
        lastZeroDeltaTick: Game.time,
        audit: [
          ...pending.audit,
          {
            tick: Game.time,
            action: "zero_delta_evidence_incomplete",
            candidateIds: [],
          },
        ].slice(-20),
      };
      reject(context, "pending_create:zero_delta_evidence_incomplete");
      appendAudit(context.data, {
        action: "pending_create_zero_delta_evidence_incomplete",
        requestId: pending.requestId,
      });
      return;
    }
    if (evidence === "absent") {
      carryFeeDebt(
        context.data,
        pending.tuple.resourceType as ResourceConstant,
        pending.feeMilli,
        `pending-create-carry:${pending.requestId}`,
      );
    }
    context.data.pendingCreate = undefined;
    appendAudit(context.data, {
      action: operatorResolved
        ? "pending_create_operator_absence_confirmed"
        : evidence === "filled"
          ? "pending_create_filled_confirmed"
          : "pending_create_absence_confirmed",
      requestId: pending.requestId,
      candidateIds: pending.operatorResolutionCandidateIds,
    });
    recordAction(context, `pending-create-resolved:${pending.requestId}`);
  }
}

function reconcilePendingMutationStates(context: RunContext): void {
  for (const [orderId, pending] of Object.entries(
    context.data.pendingMutations,
  )) {
    const live = context.liveOrderById.get(orderId);
    // fail-closed：fee ledger blocker 存在时，费用承担型 mutation
    // （extend/reprice）的确认会追加费用债务——一律停在 reconcile_gap，
    // 不推进。cancel（撤单）不写 fee ledger，允许继续收敛。
    if (
      pending.kind !== "cancel" &&
      context.data.feeLedger?.invalid
    ) {
      context.data.pendingMutations[orderId] = {
        ...pending,
        status: "reconcile_gap",
      };
      reject(context, "fee_ledger_invalid_fence");
      continue;
    }
    const result = reconcilePendingMutation({ pending, liveOrder: live });
    if (!result.confirmed) {
      if (result.pending)
        context.data.pendingMutations[orderId] = result.pending;
      if (result.reconcileGap)
        reject(context, "pending_mutation_reconcile_gap");
      continue;
    }
    const managed = context.data.managedOrders[orderId];
    if (pending.kind === "cancel") {
      if (managed) {
        if (managed.externalMutationGap) {
          managed.remainingExposure = Math.max(
            nonNegativeInteger(managed.remainingExposure),
            nonNegativeInteger(pending.conservativeExposure),
            nonNegativeInteger(
              managed.externalMutationGap.conservativeExposure,
            ),
          );
          managed.externalMutationGap.conservativeExposure =
            managed.remainingExposure;
          managed.lastSeenAt = Game.time;
          delete context.data.pendingMutations[orderId];
          recordAction(
            context,
            `external-mutation-cancel-confirmed:${orderId}`,
          );
          continue;
        }
        carryFeeDebt(
          context.data,
          managed.resourceType as ResourceConstant,
          managed.feeDebtMilli,
          `cancel-carry:${orderId}:${pending.requestedAt}`,
        );
        delete context.data.managedOrders[orderId];
      }
      delete context.data.pendingMutations[orderId];
      recordAction(context, `cancel-confirmed:${orderId}`);
      continue;
    }
    if (!managed || !live) {
      context.data.pendingMutations[orderId] = {
        ...pending,
        status: "reconcile_gap",
      };
      reject(context, "pending_mutation_managed_order_missing");
      continue;
    }
    const filled = nonNegativeInteger(result.observedFillAmount);
    const transactions = unprocessedFillTransactions(
      context.data,
      orderId,
      pending.requestedAt,
    );
    const preRemaining =
      pending.kind === "extend"
        ? pending.pre.remainingAmount +
          nonNegativeInteger(pending.requested.addAmount)
        : pending.pre.remainingAmount;
    managed.lastRemainingAmount = preRemaining;
    if (
      !allocateObservedFill(
        context.data,
        managed,
        filled,
        transactions,
        context.config,
      )
    ) {
      context.data.pendingMutations[orderId] = {
        ...pending,
        status: "reconcile_gap",
      };
      reject(context, "pending_mutation_fill_gap");
      continue;
    }
    if (pending.kind === "extend") {
      managed.originalAmount += nonNegativeInteger(pending.requested.addAmount);
    } else if (pending.requested.price !== undefined) {
      managed.price = pending.requested.price;
    }
    managed.lastRemainingAmount = live.remainingAmount;
    managed.remainingExposure = live.remainingAmount;
    managed.lastSeenAt = Game.time;
    managed.feeDebtMilli += pending.prospectiveFeeMilli;
    delete context.data.pendingMutations[orderId];
    recordAction(context, `${pending.kind}-confirmed:${orderId}`);
  }
}

function reconcileManagedOrders(context: RunContext): void {
  for (const [orderId, managed] of Object.entries(context.data.managedOrders)) {
    if (context.data.pendingMutations[orderId]) continue;
    const live = context.liveOrderById.get(orderId);
    if (managed.externalMutationGap) {
      if (live) {
        managed.remainingExposure = Math.max(
          nonNegativeInteger(managed.remainingExposure),
          nonNegativeInteger(live.remainingAmount),
          nonNegativeInteger(managed.externalMutationGap.conservativeExposure),
        );
        managed.externalMutationGap.conservativeExposure =
          managed.remainingExposure;
        requestCancel(context, orderId);
      }
      continue;
    }
    if (managed.disappearanceGap) continue;
    if (!live) {
      const transactions = unprocessedFillTransactions(
        context.data,
        orderId,
        managed.lastSeenAt,
      );
      if (
        managed.lastRemainingAmount > 0 &&
        allocateObservedFill(
          context.data,
          managed,
          managed.lastRemainingAmount,
          transactions,
          context.config,
        )
      ) {
        delete context.data.managedOrders[orderId];
        recordAction(context, `filled:${orderId}`);
      } else {
        try {
          const reconciliation = reconcileDisappearedOrderFeeDebt({
            ledger: context.data.feeLedger || createEmptyMarketSaleFeeLedger(),
            gameTime: Game.time,
            orderId,
            resourceType: managed.resourceType,
            remainingFeeDebtMilli: nonNegativeInteger(managed.feeDebtMilli),
            reason: "unknown",
          });
          context.data.feeLedger = reconciliation.ledger;
          managed.disappearanceGap = {
            detectedAt: Game.time,
            reason:
              reconciliation.ledger.reconcileGap?.reason ===
              "server_expiry_refund_mismatch"
                ? "server_expiry_refund_mismatch"
                : "unknown_disappearance",
          };
        } catch {
          reject(context, "fee_ledger_invalid");
        }
        managed.backoffUntil = Math.max(
          managed.backoffUntil || 0,
          Game.time + context.config.mutationBackoffTicks,
        );
        reject(context, "managed_order_unknown_disappearance");
      }
      continue;
    }
    if (live.type === ORDER_BUY) {
      // market-sale 只拥有 SELL 生命周期。即使一个损坏/外部篡改的旧
      // managed 记录误指向 BUY，也只能 fail-closed 留给 operator
      // 处理，绝不能把购买路径当作 Maker exposure 自动撤销。
      context.runtime.safetyViolationCount += 1;
      reject(context, "managed_order_buy_identity_quarantined");
      continue;
    }
    let priceChanged = true;
    try {
      priceChanged =
        priceToMilliUp(live.price) !== priceToMilliUp(managed.price);
    } catch {
      priceChanged = true;
    }
    const liveTotalAmount = live.totalAmount;
    const totalAmountChanged =
      !Number.isSafeInteger(liveTotalAmount) ||
      liveTotalAmount !== managed.originalAmount;
    if (priceChanged || totalAmountChanged) {
      const conservativeExposure = Math.max(
        nonNegativeInteger(managed.remainingExposure),
        nonNegativeInteger(managed.lastRemainingAmount),
        nonNegativeInteger(live.remainingAmount),
      );
      managed.externalMutationGap = {
        detectedAt: Game.time,
        expectedPrice: managed.price,
        observedPrice: live.price,
        expectedTotalAmount: managed.originalAmount,
        observedTotalAmount: Number.isSafeInteger(liveTotalAmount)
          ? liveTotalAmount
          : undefined,
        conservativeExposure,
      };
      managed.remainingExposure = conservativeExposure;
      try {
        context.data.feeLedger = markExternalOrderMutationFeeGap({
          ledger: context.data.feeLedger || createEmptyMarketSaleFeeLedger(),
          gameTime: Game.time,
          orderId,
        });
      } catch {
        reject(context, "fee_ledger_invalid");
      }
      context.runtime.safetyViolationCount += 1;
      reject(context, "managed_order_external_mutation");
      appendAudit(context.data, {
        action: "managed_order_external_mutation",
        orderId,
      });
      requestCancel(context, orderId);
      continue;
    }
    if (
      live.type !== ORDER_SELL ||
      live.resourceType !== managed.resourceType ||
      live.roomName !== managed.roomName ||
      live.remainingAmount > managed.lastRemainingAmount
    ) {
      context.runtime.safetyViolationCount += 1;
      reject(context, "managed_order_identity_changed");
      requestCancel(context, orderId);
      continue;
    }
    const filled = managed.lastRemainingAmount - live.remainingAmount;
    if (filled > 0) {
      const transactions = unprocessedFillTransactions(
        context.data,
        orderId,
        managed.lastSeenAt,
      );
      if (
        !allocateObservedFill(
          context.data,
          managed,
          filled,
          transactions,
          context.config,
        )
      ) {
        context.runtime.safetyViolationCount += 1;
        reject(context, "managed_order_fill_gap");
        requestCancel(context, orderId);
        continue;
      }
    }
    managed.price = live.price;
    managed.lastRemainingAmount = live.remainingAmount;
    managed.remainingExposure = live.remainingAmount;
    managed.lastSeenAt = Game.time;
    if (Game.time >= managed.policyCancelAtTick) {
      reject(context, "managed_order_policy_ttl_expired");
      requestCancel(context, orderId);
    }
  }
}

export function reconcilePersistentState(context: RunContext): void {
  reconcilePendingCreateState(context);
  reconcilePendingMutationStates(context);
  reconcileManagedOrders(context);
}

export function requestCancel(context: RunContext, orderId: string): boolean {
  if (context.data.pendingMutations[orderId]) return false;
  const managed = context.data.managedOrders[orderId];
  const live = context.liveOrderById.get(orderId);
  if (!managed || !live) return false;
  if ((managed.backoffUntil || 0) > Game.time) {
    reject(context, "cancel_backoff");
    return false;
  }
  let pending = createPendingMutation({
    kind: "cancel",
    order: live,
    gameTime: Game.time,
    conservativeExposure: Math.max(
      managed.remainingExposure,
      live.remainingAmount,
    ),
  });
  context.data.pendingMutations[orderId] = pending;
  const code = executeCancelOrder(orderId);
  context.writes += 1;
  if (code === OK) {
    pending = markPendingMutationSubmitted(pending);
    context.data.pendingMutations[orderId] = pending;
    recordAction(context, `cancel-submitted:${orderId}`);
    return true;
  }
  delete context.data.pendingMutations[orderId];
  managed.backoffUntil = Game.time + context.config.mutationBackoffTicks;
  reject(context, `cancel_error:${code}`);
  return false;
}

export function roomTerminal(roomName: string): StructureTerminal | undefined {
  const room = Game.rooms?.[roomName];
  return room?.terminal || undefined;
}
