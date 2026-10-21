import { isBaseMarketResource, type CompactMarketConfig, type MarketResource } from "@/runtime/market/policy";
import type { CompactMarketCandidate } from "@/runtime/market/planner";
import type { MarketBaseDynamicFloorState } from "@/runtime/marketBaseResourcePolicy";
import type { MarketSaleAutomationConfig } from "@/runtime/marketSaleConfig";
import type { MarketSalePricingDataStore } from "@/runtime/marketSalePricingAdapter";

export interface CompactLiveLane {
  roomName: string;
  resource: MarketResource;
  terminalId: string;
  controllerId: string;
}
export interface CompactLiveReceipt {
  tick: number;
  transactionId: string;
  roomName: string;
  resource: MarketResource;
  amount: number;
  transactionEnergy: number;
  netCreditsMilli: number;
  imported?: true;
  date?: string;
}
export interface CompactLivePending extends CompactMarketCandidate {
  requestId: string;
  attemptAt: number;
  atMs: number;
  energyPrice: number;
  status: "prepared" | "submitted" | "unknown";
}
export interface CompactMarketLiveState extends MarketSalePricingDataStore {
  v: 1;
  configuration: string;
  activation: NonNullable<CompactMarketConfig["cutover"]>;
  phase: "quiescing" | "active";
  quietTicks: number[];
  lanes: CompactLiveLane[];
  pricingConfig: MarketSaleAutomationConfig;
  dynamicFloor?: MarketBaseDynamicFloorState;
  pending?: CompactLivePending;
  receipts: CompactLiveReceipt[];
  lastDealAt: number;
  cooldownHighWater: number;
  attempts: number;
  confirmed: number;
  confirmedAmount: number;
  confirmedNetCreditsMilli: number;
  confirmedEnergy: number;
  arbiter: Record<string, unknown>;
  audit: Array<{ tick: number; reason: string }>;
  lastPreflightAt?: number;
  lastPlanningAt?: number;
  lastCompleteAt?: number;
  selected?: CompactMarketCandidate;
  blocker?: string;
  lastReason?: string;
  cpu?: { last: number; max: number };
}
export const compactRecord = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export const compactCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const roomName = (value: unknown): value is string => typeof value === "string" && /^[WE]\d+[NS]\d+$/.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;

/** ownership 是粘性的；mode=off 只停止新单，不让旧执行器在 pending 中复活。 */
export function compactMarketOwnsExecution(): boolean {
  return Memory.cfg?.market?.cutover !== undefined || Memory.cfg?.market?.mode === "live" || Memory.data?.market?.live !== undefined;
}
export function compactConfiguration(config: CompactMarketConfig): string {
  const sorted = (value: any): any => Array.isArray(value) ? value.map(sorted) : compactRecord(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
  return JSON.stringify(sorted({ ...config, mode: undefined }));
}
export function validCompactLane(lane: unknown): lane is CompactLiveLane {
  return compactRecord(lane) && roomName(lane.roomName) && isBaseMarketResource(lane.resource) && text(lane.terminalId) && text(lane.controllerId);
}
export function validCompactReceipt(row: unknown): row is CompactLiveReceipt {
  return compactRecord(row) && compactCount(row.tick) && text(row.transactionId) && roomName(row.roomName) &&
    isBaseMarketResource(row.resource) && compactCount(row.amount) && row.amount > 0 &&
    compactCount(row.transactionEnergy) && compactCount(row.netCreditsMilli) && (row.date === undefined || /^\d{4}-\d{2}-\d{2}$/.test(row.date));
}
export function validCompactPending(row: unknown): row is CompactLivePending {
  return compactRecord(row) && roomName(row.roomName) && roomName(row.orderRoom) && isBaseMarketResource(row.resource) &&
    text(row.requestId) && text(row.orderId) && compactCount(row.attemptAt) && compactCount(row.atMs) && row.atMs > 0 && row.atMs <= 8.64e15 && compactCount(row.amount) && row.amount > 0 && row.amount <= 1000 &&
    compactCount(row.transactionEnergy) && row.transactionEnergy <= 1000 && compactCount(row.grossPriceMilli) && row.grossPriceMilli > 0 &&
    compactCount(row.floorMilli) && row.floorMilli > 0 && compactCount(row.netCreditsMilli) &&
    Number.isFinite(row.energyPrice) && row.energyPrice > 0 && ["prepared", "submitted", "unknown"].includes(row.status);
}
export function validCompactLiveState(value: unknown): value is CompactMarketLiveState {
  if (!compactRecord(value) || value.v !== 1 || !["quiescing", "active"].includes(value.phase) ||
      typeof value.configuration !== "string" || value.configuration.length > 5000 || !compactRecord(value.activation) ||
      !/^[a-f0-9]{40}$/.test(value.activation.sourceCommit) || !/^[a-f0-9]{64}$/.test(value.activation.archiveHash) || !text(value.activation.authorization) ||
      !Array.isArray(value.lanes) || value.lanes.length < 1 || value.lanes.length > 128 || !value.lanes.every(validCompactLane) || JSON.stringify(value.lanes) !== JSON.stringify(value.activation.lanes) ||
      new Set(value.lanes.map((lane: CompactLiveLane) => `${lane.roomName}:${lane.resource}`)).size !== value.lanes.length ||
      !Array.isArray(value.quietTicks) || value.quietTicks.length > 2 || !value.quietTicks.every(compactCount) ||
      value.phase === "active" && (value.quietTicks.length !== 2 || value.quietTicks[1] !== value.quietTicks[0] + 1) ||
      !compactRecord(value.pricingConfig) || !compactRecord(value.trustedFloors) || !compactRecord(value.arbiter) ||
      !Array.isArray(value.receipts) || value.receipts.length > 1024 || !value.receipts.every(validCompactReceipt) ||
      new Set(value.receipts.map((r: CompactLiveReceipt) => r.transactionId)).size !== value.receipts.length ||
      !Array.isArray(value.audit) || value.audit.length > 20 ||
      ![value.lastDealAt, value.cooldownHighWater, value.attempts, value.confirmed, value.confirmedAmount, value.confirmedNetCreditsMilli, value.confirmedEnergy].every(compactCount) ||
      value.pending !== undefined && !validCompactPending(value.pending)) return false;
  return value.pending === undefined || value.lanes.some((lane: CompactLiveLane) => lane.roomName === value.pending.roomName && lane.resource === value.pending.resource);
}
export function compactLanePresent(lane: CompactLiveLane): boolean {
  const room = Game.rooms[lane.roomName];
  return room?.controller?.my === true && room.controller.id === lane.controllerId && room.terminal?.id === lane.terminalId && room.terminal.my === true && room.terminal.isActive();
}
/** 每 tick 只检查可能形成旧写入/暴露的根，不重算旧许可链。 */
export function compactLegacyQuietReason(): string | undefined {
  if (Memory.cfg?.marketSaleAutomation?.mode !== "off") return "legacy_mode_not_off";
  const data: unknown = Memory.data?.marketSaleAutomation;
  if (!compactRecord(data) || !compactRecord(data.directAutomation)) return "legacy_state_invalid";
  const direct = data.directAutomation, base = direct.baseResourceV3;
  if (!compactRecord(base) || !compactRecord(base.ledger) || !compactRecord(direct.ledger)) return "legacy_ledger_invalid";
  for (const value of [data.managedOrders, data.pendingMutations, data.pendingDirectDeals, data.marketStaging, data.marketReservations,
    direct.pendingDirectDeals, direct.quarantinedPendingDirectDeals]) {
    if (!compactRecord(value) || Object.keys(value).length > 0) return "legacy_exposure";
  }
  if (data.pendingCreate !== undefined && data.pendingCreate !== null || direct.ledger.pending || base.ledger.pending ||
      direct.ledger.blocker || base.ledger.blocker || direct.migrationBlockedReason) return "legacy_pending_or_blocker";
  if (data.directMarketClaim !== undefined && (!compactRecord(data.directMarketClaim) || !compactCount(data.directMarketClaim.heldThroughTick) || data.directMarketClaim.heldThroughTick >= Game.time)) return "legacy_claim";
  if (!Game.market?.orders || Object.values(Game.market.orders).some(order => order.type === ORDER_SELL)) return "own_sell_orders";
  return undefined;
}
export function compactMarketExposure(room: string, resource: ResourceConstant): { reservedAmount: number; blocked: boolean } {
  const state = Memory.data?.market?.live;
  if (!validCompactLiveState(state) || state.phase !== "active" || state.blocker) return { reservedAmount: 0, blocked: true };
  const p = state.pending;
  return { reservedAmount: p?.roomName !== room ? 0 : resource === RESOURCE_ENERGY ? p.transactionEnergy : resource === p.resource ? p.amount : 0, blocked: false };
}
