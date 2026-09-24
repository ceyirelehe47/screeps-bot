/**
 * 市场写操作与主动 Terminal 动作的唯一网关。
 *
 * 该模块只负责当 tick 仲裁和调用 Screeps 写 API；订单归属、费用预算、
 * pending mutation 等跨 tick 协议由上层市场自动化负责。
 */

import {
  claimTerminalAmountOutsideMarketSaleExposure,
  claimTerminalSendOutsideMarketSaleExposure,
} from "@/runtime/marketSaleExposure";
import { hasTreasuryT1TerminalFence } from "@/runtime/treasuryTaskCommitmentBridge";
import {
  TREASURY_T1_RUN_ID,
  TREASURY_T1_SOURCE_ROOM,
  TREASURY_T1_TARGET_ROOM,
} from "@/runtime/treasuryT1Facts";

export type TerminalActionKind = "market_deal" | "terminal_send";
export type MarketAccountActionKind =
  | "market_deal"
  | "direct_market_deal"
  | "create_order"
  | "extend_order"
  | "change_order_price"
  | "cancel_order";

export interface TerminalActionClaim {
  roomName: string;
  tick: number;
  actor: string;
  kind: TerminalActionKind;
  requestId?: string;
}

export interface MarketAccountClaim {
  requestId: string;
  roomName: string;
  actor: string;
  attemptAt: number;
  heldThroughTick: number;
}

export interface MarketActionJournalEntry {
  id: string;
  tick: number;
  actor: string;
  kind: MarketAccountActionKind;
  outcome: "intent" | "ok" | "non_ok" | "unknown" | "threw" | "blocked";
  roomName?: string;
  requestId?: string;
  orderId?: string;
  resultCode?: number;
}

export interface PreparedDirectMarketClaimRequest {
  requestId: string;
  roomName: string;
  actor: string;
  attemptAt: number;
}

export interface PreparedDirectMarketDealRequest
  extends PreparedDirectMarketClaimRequest {
  orderId: string;
  amount: number;
}

/**
 * 普通生产成交的对手订单事实。ORDER_BUY 表示本方卖出 resourceType，
 * ORDER_SELL 表示本方买入 resourceType。
 */
export interface MarketDealExposureContext {
  orderType: ORDER_BUY | ORDER_SELL;
  resourceType: ResourceConstant;
  orderRoomName: string;
}

type CreateOrderParams = Parameters<Market["createOrder"]>[0];
type UnknownRecord = Record<string, unknown>;

export interface TerminalSendRequest {
  terminal: StructureTerminal;
  resourceType: ResourceConstant;
  amount: number;
  transactionCost: number;
  destinationRoomName: string;
  actor: string;
  description?: string;
}

function blockedByTreasuryT1(roomName: string, actor: string, destinationRoomName?: string): boolean {
  if (actor === `treasury:${TREASURY_T1_RUN_ID}`) return false;
  return hasTreasuryT1TerminalFence() && (
    roomName === TREASURY_T1_SOURCE_ROOM || roomName === TREASURY_T1_TARGET_ROOM ||
    destinationRoomName === TREASURY_T1_TARGET_ROOM
  );
}

let claimTick: number | undefined;
let claimGame: Game | undefined;
const terminalClaims = new Map<string, TerminalActionClaim>();
const terminalActionsInFlight = new Set<string>();
let marketAccountClaim: MarketAccountClaim | undefined;
let corruptPersistentMarketAccountClaim = false;

const MAX_MARKET_ACTION_JOURNAL_ENTRIES = 100;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidRoomName(value: unknown): value is string {
  return typeof value === "string" && /^[WE]\d+[NS]\d+$/.test(value);
}

function isValidTick(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function getAutomationArbiterData(create: boolean): UnknownRecord | undefined {
  const memory = Memory as unknown as { data?: unknown };
  if (memory.data === undefined) {
    if (!create) return undefined;
    memory.data = {};
  }
  if (!isRecord(memory.data)) return undefined;

  const data = memory.data;
  const current = data.marketSaleAutomation;
  if (current === undefined) {
    if (!create) return undefined;
    const created: UnknownRecord = { managedOrders: {} };
    data.marketSaleAutomation = created;
    return created;
  }
  return isRecord(current) ? current : undefined;
}

function parsePersistentMarketAccountClaim(
  value: unknown,
): MarketAccountClaim | "corrupt" | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return "corrupt";
  if (
    !isNonEmptyString(value.requestId) ||
    !isValidRoomName(value.roomName) ||
    !isNonEmptyString(value.actor) ||
    !isValidTick(value.attemptAt) ||
    !isValidTick(value.heldThroughTick) ||
    value.heldThroughTick !== value.attemptAt + 1
  ) {
    return "corrupt";
  }
  return {
    requestId: value.requestId,
    roomName: value.roomName,
    actor: value.actor,
    attemptAt: value.attemptAt,
    heldThroughTick: value.heldThroughTick,
  };
}

function readPersistentMarketAccountClaim(): MarketAccountClaim | "corrupt" | undefined {
  const data = getAutomationArbiterData(false);
  if (!data) return undefined;
  const parsed = parsePersistentMarketAccountClaim(data.directMarketClaim);
  if (
    parsed !== undefined &&
    parsed !== "corrupt" &&
    Game.time > parsed.heldThroughTick
  ) {
    delete data.directMarketClaim;
    return undefined;
  }
  return parsed;
}

function persistMarketAccountClaim(claim: MarketAccountClaim): boolean {
  const data = getAutomationArbiterData(true);
  if (!data) return false;
  data.directMarketClaim = { ...claim };
  return true;
}

function readMarketActionJournal(): {
  entries: MarketActionJournalEntry[];
  valid: boolean;
} {
  const data = getAutomationArbiterData(false);
  if (!data || data.marketActionJournal === undefined) {
    return { entries: [], valid: true };
  }
  if (!Array.isArray(data.marketActionJournal)) {
    return { entries: [], valid: false };
  }

  const entries: MarketActionJournalEntry[] = [];
  for (const value of data.marketActionJournal) {
    if (
      !isRecord(value) ||
      !isNonEmptyString(value.id) ||
      !isValidTick(value.tick) ||
      !isNonEmptyString(value.actor) ||
      !isNonEmptyString(value.kind) ||
      !isNonEmptyString(value.outcome)
    ) {
      return { entries: [], valid: false };
    }
    entries.push(value as unknown as MarketActionJournalEntry);
  }
  return { entries, valid: true };
}

function appendMarketActionJournal(
  entry: Omit<MarketActionJournalEntry, "id" | "tick">,
): boolean {
  const data = getAutomationArbiterData(true);
  if (!data) return false;
  if (data.marketActionJournal === undefined) {
    data.marketActionJournal = [];
  }
  if (!Array.isArray(data.marketActionJournal)) return false;

  const journal = data.marketActionJournal;
  journal.push({
    ...entry,
    id: `${Game.time}:${journal.length}:${entry.kind}:${entry.requestId || entry.actor}`,
    tick: Game.time,
  });
  if (journal.length > MAX_MARKET_ACTION_JOURNAL_ENTRIES) {
    journal.splice(0, journal.length - MAX_MARKET_ACTION_JOURNAL_ENTRIES);
  }
  return true;
}

function syncClaimTick(): void {
  if (claimTick === Game.time && claimGame === Game) return;
  claimTick = Game.time;
  claimGame = Game;
  terminalClaims.clear();
  terminalActionsInFlight.clear();
  marketAccountClaim = undefined;
  corruptPersistentMarketAccountClaim = false;

  const persistentClaim = readPersistentMarketAccountClaim();
  if (persistentClaim === "corrupt") {
    corruptPersistentMarketAccountClaim = true;
    return;
  }
  if (!persistentClaim) return;

  marketAccountClaim = persistentClaim;
  storeTerminalClaim(
    persistentClaim.roomName,
    persistentClaim.actor,
    "market_deal",
    persistentClaim.requestId,
  );
}

function storeTerminalClaim(
  roomName: string,
  actor: string,
  kind: TerminalActionKind,
  requestId?: string,
): void {
  terminalClaims.set(roomName, {
    roomName,
    tick: Game.time,
    actor,
    kind,
    ...(requestId ? { requestId } : {}),
  });
}

export function getTerminalActionClaim(roomName: string): TerminalActionClaim | undefined {
  syncClaimTick();
  const claim = terminalClaims.get(roomName);
  return claim ? { ...claim } : undefined;
}

export function getTerminalActionClaims(): TerminalActionClaim[] {
  syncClaimTick();
  return Array.from(terminalClaims.values(), claim => ({ ...claim }));
}

export function hasTerminalActionClaim(roomName: string): boolean {
  syncClaimTick();
  return terminalClaims.has(roomName);
}

export function getMarketAccountClaim(): MarketAccountClaim | undefined {
  syncClaimTick();
  return marketAccountClaim ? { ...marketAccountClaim } : undefined;
}

export function hasMarketAccountClaim(): boolean {
  syncClaimTick();
  return corruptPersistentMarketAccountClaim || !!marketAccountClaim;
}

export function getMarketActionJournal(): MarketActionJournalEntry[] {
  return readMarketActionJournal().entries.map(entry => ({ ...entry }));
}

export function hasMarketActionIntentThisTick(): boolean {
  const journal = readMarketActionJournal();
  return (
    !journal.valid ||
    journal.entries.some(entry => entry.tick === Game.time)
  );
}

/**
 * 生产模块在选出可执行订单并通过本地写前检查后、调用市场网关前声明本 tick
 * 的市场动作。后置 Direct 会看到该 intent 并让真实可执行的生产动作优先；
 * 只有需求但没有安全订单时不得制造永久阻塞 Direct Shadow 的空 intent。
 */
export function declareMarketActionIntent(
  actor: string,
  kind: MarketAccountActionKind = "market_deal",
  roomName?: string,
): boolean {
  syncClaimTick();
  const blocked = corruptPersistentMarketAccountClaim || !!marketAccountClaim;
  appendMarketActionJournal({
    actor,
    kind,
    outcome: blocked ? "blocked" : "intent",
    ...(roomName ? { roomName } : {}),
  });
  return !blocked;
}

function isSameDirectClaim(
  claim: MarketAccountClaim,
  request: PreparedDirectMarketClaimRequest,
): boolean {
  return (
    claim.requestId === request.requestId &&
    claim.roomName === request.roomName &&
    claim.actor === request.actor &&
    claim.attemptAt === request.attemptAt &&
    claim.heldThroughTick === request.attemptAt + 1
  );
}

/**
 * prepared 写前或 attemptAt+1 的最早 preflight 重建 Direct 独占 claim。
 * 超过 attemptAt+1 后拒绝重建，避免 reconcile gap 永久阻断生产。
 */
export function claimPreparedDirectMarketClaims(
  request: PreparedDirectMarketClaimRequest,
): boolean {
  if (
    !isNonEmptyString(request.requestId) ||
    !isValidRoomName(request.roomName) ||
    !isNonEmptyString(request.actor) ||
    !isValidTick(request.attemptAt) ||
    Game.time < request.attemptAt ||
    Game.time > request.attemptAt + 1
  ) {
    return false;
  }
  if (blockedByTreasuryT1(request.roomName, request.actor)) return false;

  syncClaimTick();
  if (corruptPersistentMarketAccountClaim) return false;
  if (marketAccountClaim) {
    return isSameDirectClaim(marketAccountClaim, request);
  }

  const terminalClaim = terminalClaims.get(request.roomName);
  if (
    terminalClaim &&
    terminalClaim.requestId !== request.requestId
  ) {
    return false;
  }
  if (terminalActionsInFlight.has(request.roomName)) return false;

  const journal = readMarketActionJournal();
  if (
    !journal.valid ||
    journal.entries.some(entry => entry.tick === Game.time)
  ) {
    return false;
  }

  const claim: MarketAccountClaim = {
    requestId: request.requestId,
    roomName: request.roomName,
    actor: request.actor,
    attemptAt: request.attemptAt,
    heldThroughTick: request.attemptAt + 1,
  };
  if (!persistMarketAccountClaim(claim)) return false;

  marketAccountClaim = claim;
  storeTerminalClaim(
    request.roomName,
    request.actor,
    "market_deal",
    request.requestId,
  );
  return true;
}

/**
 * Direct 最早 preflight 或明确非 OK 后释放独占 claim。exact requestId 保证
 * 重复调用幂等，且不会误释放另一笔请求。
 */
export function releasePreparedDirectMarketClaims(
  requestId: string,
): boolean {
  if (!isNonEmptyString(requestId)) return false;
  syncClaimTick();

  const data = getAutomationArbiterData(false);
  const persistent = parsePersistentMarketAccountClaim(
    data?.directMarketClaim,
  );
  if (persistent === "corrupt") return false;
  if (persistent && persistent.requestId !== requestId) return false;
  if (data && persistent) {
    delete data.directMarketClaim;
  }

  if (marketAccountClaim?.requestId === requestId) {
    const roomName = marketAccountClaim.roomName;
    marketAccountClaim = undefined;
    const terminalClaim = terminalClaims.get(roomName);
    if (terminalClaim?.requestId === requestId) {
      terminalClaims.delete(roomName);
    }
  }
  return true;
}

/**
 * 将任意需要 Terminal 主动执行的动作纳入同一房间、同一 tick 的独占仲裁。
 * 只有底层动作返回 OK 时才记录 claim；失败和异常不会占用该房间。
 */
export function executeTerminalAction(
  roomName: string,
  actor: string,
  kind: TerminalActionKind,
  action: () => ScreepsReturnCode,
): ScreepsReturnCode {
  syncClaimTick();
  if (blockedByTreasuryT1(roomName, actor)) return ERR_BUSY;
  if (terminalClaims.has(roomName) || terminalActionsInFlight.has(roomName)) return ERR_BUSY;

  terminalActionsInFlight.add(roomName);
  try {
    const code = action();
    if (code === OK) {
      storeTerminalClaim(roomName, actor, kind);
    }
    return code;
  } finally {
    terminalActionsInFlight.delete(roomName);
  }
}

export function executeMarketDeal(
  orderId: string,
  amount: number,
  roomName: string,
  actor: string,
  exposureContext: MarketDealExposureContext,
): ScreepsReturnCode {
  syncClaimTick();
  if (corruptPersistentMarketAccountClaim || marketAccountClaim) {
    appendMarketActionJournal({
      actor,
      kind: "market_deal",
      outcome: "blocked",
      roomName,
      orderId,
    });
    return ERR_BUSY;
  }

  if (
    !isNonEmptyString(orderId) ||
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    !isNonEmptyString(roomName) ||
    !isNonEmptyString(actor) ||
    !isRecord(exposureContext) ||
    (
      exposureContext.orderType !== ORDER_BUY &&
      exposureContext.orderType !== ORDER_SELL
    ) ||
    !RESOURCES_ALL.includes(exposureContext.resourceType) ||
    !isNonEmptyString(exposureContext.orderRoomName)
  ) {
    appendMarketActionJournal({
      actor,
      kind: "market_deal",
      outcome: "non_ok",
      roomName,
      orderId,
      resultCode: ERR_INVALID_ARGS,
    });
    return ERR_INVALID_ARGS;
  }

  const terminal = Game.rooms[roomName]?.terminal;
  if (!terminal) {
    appendMarketActionJournal({
      actor,
      kind: "market_deal",
      outcome: "non_ok",
      roomName,
      orderId,
      resultCode: ERR_INVALID_TARGET,
    });
    return ERR_INVALID_TARGET;
  }

  let transactionEnergy: number;
  try {
    transactionEnergy = Game.market.calcTransactionCost(
      amount,
      roomName,
      exposureContext.orderRoomName,
    );
  } catch {
    appendMarketActionJournal({
      actor,
      kind: "market_deal",
      outcome: "non_ok",
      roomName,
      orderId,
      resultCode: ERR_INVALID_ARGS,
    });
    return ERR_INVALID_ARGS;
  }
  if (
    !Number.isSafeInteger(transactionEnergy) ||
    transactionEnergy < 0
  ) {
    appendMarketActionJournal({
      actor,
      kind: "market_deal",
      outcome: "non_ok",
      roomName,
      orderId,
      resultCode: ERR_INVALID_ARGS,
    });
    return ERR_INVALID_ARGS;
  }

  const exposureClaim = exposureContext.orderType === ORDER_BUY
    ? claimTerminalSendOutsideMarketSaleExposure(
      terminal,
      exposureContext.resourceType,
      amount,
      transactionEnergy,
    )
    : transactionEnergy === 0
      ? { release: () => undefined }
      : claimTerminalAmountOutsideMarketSaleExposure(
        terminal,
        RESOURCE_ENERGY,
        transactionEnergy,
        roomName,
      );
  if (
    !exposureClaim ||
    (
      exposureContext.orderType === ORDER_SELL &&
      transactionEnergy > 0 &&
      "amount" in exposureClaim &&
      exposureClaim.amount !== transactionEnergy
    )
  ) {
    exposureClaim?.release();
    appendMarketActionJournal({
      actor,
      kind: "market_deal",
      outcome: "non_ok",
      roomName,
      orderId,
      resultCode: ERR_NOT_ENOUGH_RESOURCES,
    });
    return ERR_NOT_ENOUGH_RESOURCES;
  }

  try {
    const code = executeTerminalAction(
      roomName,
      actor,
      "market_deal",
      () => Game.market.deal(orderId, amount, roomName),
    );
    appendMarketActionJournal({
      actor,
      kind: "market_deal",
      outcome: code === OK ? "ok" : "non_ok",
      roomName,
      orderId,
      resultCode: code,
    });
    if (code !== OK) {
      exposureClaim.release();
    }
    return code;
  } catch (error) {
    exposureClaim.release();
    appendMarketActionJournal({
      actor,
      kind: "market_deal",
      outcome: "threw",
      roomName,
      orderId,
    });
    throw error;
  }
}

export function isExplicitMarketNonOkReturnCode(
  value: unknown,
): value is ScreepsReturnCode {
  return Number.isSafeInteger(value) && (value as number) < 0;
}

/**
 * prepared Direct 的唯一提交入口。同 requestId 已预占时允许提交一次；
 * 明确 Screeps 非 OK 才释放，OK、异常或未知返回均保守保留到 preflight。
 */
export function executePreparedDirectMarketDeal(
  request: PreparedDirectMarketDealRequest,
): ScreepsReturnCode {
  if (
    Game.time !== request.attemptAt ||
    !isNonEmptyString(request.orderId) ||
    !Number.isSafeInteger(request.amount) ||
    request.amount <= 0
  ) {
    return ERR_INVALID_ARGS;
  }
  if (!claimPreparedDirectMarketClaims(request)) return ERR_BUSY;

  const journal = readMarketActionJournal();
  if (
    !journal.valid ||
    journal.entries.some(entry =>
      entry.tick === Game.time &&
      entry.requestId === request.requestId &&
      entry.kind === "direct_market_deal" &&
      entry.outcome !== "intent"
    )
  ) {
    return ERR_BUSY;
  }
  if (terminalActionsInFlight.has(request.roomName)) return ERR_BUSY;

  terminalActionsInFlight.add(request.roomName);
  try {
    const code = Game.market.deal(
      request.orderId,
      request.amount,
      request.roomName,
    );
    const outcome = code === OK
      ? "ok"
      : isExplicitMarketNonOkReturnCode(code)
        ? "non_ok"
        : "unknown";
    appendMarketActionJournal({
      actor: request.actor,
      kind: "direct_market_deal",
      outcome,
      roomName: request.roomName,
      requestId: request.requestId,
      orderId: request.orderId,
      ...(Number.isSafeInteger(code) ? { resultCode: code } : {}),
    });
    if (isExplicitMarketNonOkReturnCode(code)) {
      releasePreparedDirectMarketClaims(request.requestId);
    }
    return code;
  } catch (error) {
    appendMarketActionJournal({
      actor: request.actor,
      kind: "direct_market_deal",
      outcome: "threw",
      roomName: request.roomName,
      requestId: request.requestId,
      orderId: request.orderId,
    });
    throw error;
  } finally {
    terminalActionsInFlight.delete(request.roomName);
  }
}

export function executeTerminalSend(
  request: TerminalSendRequest,
): ScreepsReturnCode {
  if (blockedByTreasuryT1(request.terminal.room.name, request.actor, request.destinationRoomName)) {
    return ERR_BUSY;
  }
  const exposureClaim = claimTerminalSendOutsideMarketSaleExposure(
    request.terminal,
    request.resourceType,
    request.amount,
    request.transactionCost,
  );
  if (!exposureClaim) return ERR_NOT_ENOUGH_RESOURCES;

  try {
    const code = executeTerminalAction(
      request.terminal.room.name,
      request.actor,
      "terminal_send",
      () =>
        request.terminal.send(
          request.resourceType,
          request.amount,
          request.destinationRoomName,
          request.description,
        ),
    );
    if (code !== OK) {
      exposureClaim.release();
    }
    return code;
  } catch (error) {
    exposureClaim.release();
    throw error;
  }
}

function executeAccountMarketAction(
  actor: string,
  kind: Exclude<MarketAccountActionKind, "market_deal" | "direct_market_deal">,
  action: () => ScreepsReturnCode,
  orderId?: string,
): ScreepsReturnCode {
  syncClaimTick();
  if (corruptPersistentMarketAccountClaim || marketAccountClaim) {
    appendMarketActionJournal({
      actor,
      kind,
      outcome: "blocked",
      ...(orderId ? { orderId } : {}),
    });
    return ERR_BUSY;
  }
  try {
    const code = action();
    appendMarketActionJournal({
      actor,
      kind,
      outcome: code === OK ? "ok" : "non_ok",
      ...(orderId ? { orderId } : {}),
      resultCode: code,
    });
    return code;
  } catch (error) {
    appendMarketActionJournal({
      actor,
      kind,
      outcome: "threw",
      ...(orderId ? { orderId } : {}),
    });
    throw error;
  }
}

export function executeCreateOrder(
  params: CreateOrderParams,
  actor = "marketSaleAutomation",
): ScreepsReturnCode {
  return executeAccountMarketAction(
    actor,
    "create_order",
    () => Game.market.createOrder(params),
  );
}

export function executeExtendOrder(
  orderId: string,
  addAmount: number,
  actor = "marketSaleAutomation",
): ScreepsReturnCode {
  return executeAccountMarketAction(
    actor,
    "extend_order",
    () => Game.market.extendOrder(orderId, addAmount),
    orderId,
  );
}

export function executeChangeOrderPrice(
  orderId: string,
  newPrice: number,
  actor = "marketSaleAutomation",
): ScreepsReturnCode {
  return executeAccountMarketAction(
    actor,
    "change_order_price",
    () => Game.market.changeOrderPrice(orderId, newPrice),
    orderId,
  );
}

export function executeCancelOrder(
  orderId: string,
  actor = "marketSaleAutomation",
): ScreepsReturnCode {
  return executeAccountMarketAction(
    actor,
    "cancel_order",
    () => Game.market.cancelOrder(orderId),
    orderId,
  );
}

export function clearMarketActionArbiterForTest(
  preservePersistent = false,
): void {
  claimTick = undefined;
  claimGame = undefined;
  terminalClaims.clear();
  terminalActionsInFlight.clear();
  marketAccountClaim = undefined;
  corruptPersistentMarketAccountClaim = false;
  if (!preservePersistent) {
    const data = getAutomationArbiterData(false);
    if (data) {
      delete data.directMarketClaim;
      delete data.marketActionJournal;
    }
  }
}
