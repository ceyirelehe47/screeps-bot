import { isDue } from "@/runtime/cadence";
import { getTickContextService } from "@/runtime/runtimeServices";
import { getCreepConfigService, getMemoryService } from "@/runtime/runtimeServices";
import { hasDiagnosticBudget } from "@/runtime/diagnosticBudget";
import { HUB_RESERVE_PER_COMPOUND, HUB_RESERVE_PER_ROOM, isHubOnlyReserveCompound, getHubOnlyReserve } from "@/config/hub";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { ensureResourceTransferTaskStore } from "@/runtime/logistics/resourceTransferTasks";
import type {
  SynthesisRoomCapability,
  SynthesisDispatchAssignment,
  AllocationLedgerEntry,
  DirectRouteDecision,
  ProgressEdge,
} from "@/runtime/hubPlanner";
import type {
  HubCommittedProtectionSnapshot,
  HubProtectionAttempt,
  HubProtectionRevisionMarker,
  HubRuntimeProtectionExtension,
} from "@/runtime/hubProtectionSnapshot";
import type { VisualSurface } from "@/visual/panel";
import { Card } from "@/visual/card";
import {
  VIS_DIM,
  VIS_ERROR,
  VIS_INBOUND,
  VIS_OK,
  VIS_OUTBOUND,
  VIS_TEXT,
  VIS_TITLE,
  VIS_WARN,
} from "@/visual/palette";

export interface HubProgressInput {
  factory?: HubFactoryProgress;
  hubConfig: {
    enabled?: boolean;
    hubRoomName?: string;
    targetCompounds?: ResourceConstant[];
    reservePerRoom?: number;
    hubReservePerCompound?: number;
    hubOnlyReservePerCompound?: number;
  } | null;
  hubRuntime:
    | ({
        status?: "idle" | "importing" | "synthesizing" | "distributing" | "blocked";
        updatedAt?: number;
        activeProduct?: string;
        activeStep?: number;
        missingResources?: string[];
        lastPlanActions?: string[];
        needsPlan?: boolean;
        lastError?: string;
      } & HubRuntimeProtectionExtension)
    | null;
  synthesisRuntime: {
    stage?: string;
    activeProduct?: ResourceConstant;
    reagentA?: ResourceConstant;
    reagentB?: ResourceConstant;
    targetAmount?: number;
  } | null;
  hubLabInventory?: Record<string, number>;
  hubStorageStore: Record<string, number> | null;
  hubTerminalStore: Record<string, number> | null;
  resourceControlRooms: Record<
    string,
    {
      state: string;
      storageEnergy: number;
      terminalEnergy: number;
      energyFloor: number;
      energyTarget: number;
      energyExportStart: number;
      terminalEnergyReserve?: number;
      taskHealth?: {
        pendingIncoming: number;
        pendingOutgoing: number;
        blockedIncoming: Partial<Record<string, number>>;
        blockedOutgoing: Partial<Record<string, number>>;
      };
      nativeMineralType?: MineralConstant;
      canMineNative: boolean;
      minerals: Partial<Record<ResourceConstant, number>>;
    }
  > | null;
  hubCarrierCargo?: Record<string, number>;
  transferTasks: Record<string, ResourceTransferTask> | null;
  currentTick: number;
  distributedSynthesis?: {
    roomCapabilities?: Record<string, SynthesisRoomCapability>;
    dispatchAssignments?: SynthesisDispatchAssignment[];
    allocationLedger?: Record<string, AllocationLedgerEntry>;
    routeDecisions?: DirectRouteDecision[];
    progressEdges?: ProgressEdge[];
  };
  synthesisControlRooms?: Record<string, {
    stage?: string;
    activeProduct?: ResourceConstant;
    reagentA?: ResourceConstant;
    reagentB?: ResourceConstant;
    targetAmount?: number;
    lastError?: string;
  }>;
  synthesisControlCfgRooms?: Record<string, {
    reactions?: Array<{ product?: ResourceConstant; targetAmount?: number }>;
  }>;
  satelliteStores?: Array<{
    roomName: string;
    storage: Record<string, number> | null;
    terminal: Record<string, number> | null;
  }>;
}

/** Represents a production room in the distributed synthesis chain. */
export interface ProductionRoomEntry {
  roomName: string;
  /** The compound this room is assigned to produce. */
  product: ResourceConstant;
  /** Current synthesis stage from synthesisControl runtime. */
  stage: string;
  /** currentAmount / targetAmount, capped at 1. */
  progressPercent: number;
  /** Current amount of product available (labs + storage + terminal). */
  currentAmount: number;
  /** Target amount for this assignment. */
  targetAmount: number;
  /** Whether this is the hub room itself. */
  isHubRoom: boolean;
  /** Upstream suppliers: rooms feeding resources into this room. */
  upstream: Array<{ roomName: string; resource: ResourceConstant }>;
  /** Downstream consumers: rooms receiving this room's product. */
  downstream: Array<{ roomName: string; resource: ResourceConstant }>;
  /** Amount committed to direct-routed transfers (not via hub). */
  directSupplyAmount: number;
  /** Amount designated to flow through the hub. */
  hubSurplusAmount: number;
  /** Reason the room is blocked, if any. */
  blocker: string | null;
}

export type HubTransferClassification = "import" | "reclaim" | "export";

export interface HubProgressPendingTask {
  resource: string;
  from: string;
  to: string;
  remaining: number;
  reason: string;
  classification: HubTransferClassification;
  createdAt: number;
  updatedAt: number;
  lastProgressAt: number;
  age: number;
  lastProgressAge: number;
  blockedReason: ResourceTransferTask["blockedReason"] | null;
  blockedSince: number | null;
  blockedAge: number | null;
}

export interface HubT3CompoundStatus {
  compound: string;
  hubAmount: number;
  hubReserve: number;
  hubSurplus: number;
  hubDeficit: number;
  networkDeficit: number;
}

export interface HubProgressSnapshot {
  factory?: HubFactoryProgress;
  updatedAt: number;
  enabled: boolean;
  hubRoomName: string;
  hubRoomVisible: boolean;
  status: string | null;
  stage: string | null;
  activeProduct: string | null;
  lastPlanActions: string[];
  missingResources: string[];
  lastError: string | null;
  needsPlan: boolean;
  hubStorageEnergy: number;
  hubTerminalEnergy: number;
  hubInventory: Record<string, number>;
  hubCarrierCargo: Record<string, number>;
  pendingImports: number;
  pendingReclaims: number;
  pendingExports: number;
  pendingTasks: HubProgressPendingTask[];
  roomTerminalBlockers: Array<{
    room: string;
    terminalEnergy: number;
    reserve: number;
    pendingNonEnergy: number;
  }>;
  hubLabInventory: Record<string, number>;
  synthesisTargetAmount?: number;
  /** Distributed production rooms with chain linkage data. */
  productionRooms: ProductionRoomEntry[];
  t3ReserveStatus: {
    hubSurplus: number;
    totalDeficit: Array<{ compound: string; needed: number }>;
    compounds: HubT3CompoundStatus[];
  };
  /**
   * 当前 planning attempt 的小型状态投影。它只用于判断旧 committed
   * snapshot 是否已被新 attempt 作废，不包含任何生产明细。
   */
  protectionAttempt?: HubProtectionAttempt | null;
  /**
   * committed protection 的有界 revision marker。各组件 revision/fingerprint
   * 保留在这里，monitor 可据此发现部分提交；大体积 rooms/tasks/ledger 不进入
   * analytics。
   */
  committedProtectionMarker?: HubCommittedProtectionProgressMarker | null;
}

export interface HubFactoryProgress {
  status: string;
  stage: string;
  product: string | null;
  missing: Record<string, number>;
  lastProducedAt: number | null;
}

export interface HubCommittedProtectionProgressMarker {
  schema: HubCommittedProtectionSnapshot["schema"];
  planRevision: number;
  configIncarnation: number;
  observedAt: number;
  expiresAt: number;
  configFingerprint: string;
  status: HubCommittedProtectionSnapshot["status"];
  valid: boolean;
  marker: HubProtectionRevisionMarker & {
    hubRoomName: string;
    planMode: HubCommittedProtectionSnapshot["marker"]["planMode"];
  };
  components: {
    synthesisConfig: HubProtectionRevisionMarker;
    transferTasks: HubProtectionRevisionMarker;
    distributed: HubProtectionRevisionMarker;
    baseMineralSurplus: HubProtectionRevisionMarker;
  };
  failureReason?: string;
}

const ANALYTICS_SAMPLE_INTERVAL = 5;
const MAX_LAST_PLAN_ACTIONS = 8;
const MAX_INVENTORY_EXTRA = 10;
const MAX_OVERLAY_LINES = 8;
const DEFAULT_TERMINAL_ENERGY_RESERVE = 20_000;
// Visual layout constants
const HUB_VISUAL_X = 1;
const HUB_VISUAL_Y = 2;
const HUB_VISUAL_WIDTH = 13.5;

export interface HubVisualModel {
  hubRoomName: string;
  status: string;
  stage: string | null;
  healthLevel: "ok" | "warn" | "error";
  healthLabel: "OK" | "WARN" | "ERROR";
  alerts: string[];
  alertOverflow: number;
  activeProduct: string | null;
  progressMode: "idle" | "activity" | "determinate";
  progressPercent: number | null;
  progressText: string;
  logistics: {
    totalTasks: number;
    imports: number;
    reclaims: number;
    exports: number;
    rows: HubLogisticsVisualRow[];
    overflow: number;
  };
  production: {
    activeRooms: number;
    blockedRooms: number;
  };
  factory?: HubFactoryProgress;
  t3Reserve: {
    totalCompounds: number;
    stockedCompounds: number;
    rows: HubReserveVisualRow[];
    overflow: number;
  };
}

export interface HubLogisticsVisualRow {
  classification: HubTransferClassification;
  direction: "in" | "out";
  counterpartRoom: string;
  resource: string;
  remaining: number;
  age: number;
  lastProgressAge: number;
  blockedReason: ResourceTransferTask["blockedReason"] | null;
  blockedAge: number | null;
}

export interface HubReserveVisualRow extends HubT3CompoundStatus {
  totalDeficit: number;
}

const MAX_ALERT_ROWS = 2;
const MAX_LOGISTICS_ROWS = 3;
const MAX_T3_ROWS = 3;
const ACTIVE_PRODUCTION_STAGES = new Set(["loading", "synthesizing", "unloading"]);

function protectionMarkerIsConsistent(marker: HubCommittedProtectionProgressMarker): boolean {
  const expected = marker.marker;
  return Object.values(marker.components).every(component =>
    component.revision === expected.revision &&
    component.configIncarnation === expected.configIncarnation &&
    component.configFingerprint === expected.configFingerprint,
  );
}

function buildHubHealth(snapshot: HubProgressSnapshot): Pick<HubVisualModel, "healthLevel" | "healthLabel" | "alerts" | "alertOverflow"> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (snapshot.lastError) errors.push(`error: ${snapshot.lastError}`);
  if (snapshot.status === "blocked") errors.push("hub status blocked");

  const attempt = snapshot.protectionAttempt;
  if (attempt && (!attempt.valid || attempt.status === "failed" || attempt.status === "blocked")) {
    errors.push(`protection ${attempt.reason || attempt.status}`);
  }

  const committed = snapshot.committedProtectionMarker;
  if (committed) {
    const committedFailure = committed.failureReason
      || (!committed.valid ? "invalid" : null)
      || (committed.status !== "committed" ? committed.status : null)
      || (committed.expiresAt < snapshot.updatedAt ? "expired" : null)
      || (!protectionMarkerIsConsistent(committed) ? "inconsistent" : null);
    if (committedFailure) errors.push(`protection snapshot ${committedFailure}`);
  }

  const blockedProductionRooms = snapshot.productionRooms
    .filter(room => room.stage === "blocked" || !!room.blocker)
    .map(room => room.roomName)
    .sort();
  if (blockedProductionRooms.length > 0) {
    errors.push(`production blocked: ${blockedProductionRooms.slice(0, 2).join(",")}${blockedProductionRooms.length > 2 ? ` +${blockedProductionRooms.length - 2}` : ""}`);
  }

  if (snapshot.needsPlan) warnings.push("needs plan");
  if (snapshot.missingResources.length > 0) {
    const visible = snapshot.missingResources.slice(0, 3);
    warnings.push(`missing: ${visible.join(",")}${snapshot.missingResources.length > visible.length ? ` +${snapshot.missingResources.length - visible.length}` : ""}`);
  }

  const blockedTasks = snapshot.pendingTasks.filter(task => !!task.blockedReason);
  if (blockedTasks.length > 0) warnings.push(`${blockedTasks.length} transfer blocked`);

  const terminalRiskRooms = snapshot.roomTerminalBlockers
    .filter(room => room.pendingNonEnergy > 0 && room.terminalEnergy < room.reserve)
    .map(room => room.room)
    .sort();
  if (terminalRiskRooms.length > 0) {
    warnings.push(`terminal reserve: ${terminalRiskRooms.slice(0, 2).join(",")}${terminalRiskRooms.length > 2 ? ` +${terminalRiskRooms.length - 2}` : ""}`);
  }

  const allAlerts = [...errors, ...warnings];
  const healthLevel = errors.length > 0 ? "error" : warnings.length > 0 ? "warn" : "ok";
  return {
    healthLevel,
    healthLabel: healthLevel === "error" ? "ERROR" : healthLevel === "warn" ? "WARN" : "OK",
    alerts: allAlerts.slice(0, MAX_ALERT_ROWS),
    alertOverflow: Math.max(0, allAlerts.length - MAX_ALERT_ROWS),
  };
}

export function buildHubVisualModel(snapshot: HubProgressSnapshot): HubVisualModel {
  const activeProduct = snapshot.activeProduct;
  const isBatchMode = !!activeProduct && typeof snapshot.synthesisTargetAmount === "number" && snapshot.synthesisTargetAmount > 0;

  let progressMode: HubVisualModel["progressMode"];
  let progressPercent: number | null;
  let progressText: string;

  if (!activeProduct) {
    progressMode = "idle";
    progressPercent = null;
    progressText = "idle";
  } else if (isBatchMode) {
    const target = snapshot.synthesisTargetAmount!;
    const currentAmount = (snapshot.hubInventory[activeProduct] || 0) + (snapshot.hubLabInventory[activeProduct] || 0);
    progressMode = "determinate";
    progressPercent = Math.min(currentAmount / target, 1);
    progressText = `${activeProduct} ${formatCompactAmount(currentAmount)}/${formatCompactAmount(target)} ${Math.round(progressPercent * 100)}%`;
  } else {
    const inventoryAmount = snapshot.hubInventory[activeProduct] || 0;
    const labAmount = snapshot.hubLabInventory[activeProduct] || 0;
    const activity = snapshot.stage ?? snapshot.status ?? "active";
    progressMode = "activity";
    progressPercent = null;
    progressText = `${activeProduct} ${formatCompactAmount(inventoryAmount + labAmount)} · ${activity}`;
  }

  const logisticsRows = snapshot.pendingTasks
    .map<HubLogisticsVisualRow>(task => ({
      classification: task.classification,
      direction: task.classification === "export" ? "out" : "in",
      counterpartRoom: task.classification === "export" ? task.to : task.from,
      resource: task.resource,
      remaining: task.remaining,
      age: task.age,
      lastProgressAge: task.lastProgressAge,
      blockedReason: task.blockedReason,
      blockedAge: task.blockedAge,
    }))
    .sort((left, right) =>
      Number(!!right.blockedReason) - Number(!!left.blockedReason) ||
      right.age - left.age ||
      right.remaining - left.remaining ||
      left.counterpartRoom.localeCompare(right.counterpartRoom) ||
      left.resource.localeCompare(right.resource) ||
      left.classification.localeCompare(right.classification),
    );

  const productionRooms = snapshot.productionRooms.filter(room => !room.isHubRoom);
  const activeRooms = productionRooms.filter(room => ACTIVE_PRODUCTION_STAGES.has(room.stage)).length;
  const blockedRooms = productionRooms.filter(room => room.stage === "blocked" || !!room.blocker).length;

  const reserveRows = snapshot.t3ReserveStatus.compounds
    .map<HubReserveVisualRow>(compound => ({
      ...compound,
      totalDeficit: compound.hubDeficit + compound.networkDeficit,
    }))
    .filter(compound => compound.totalDeficit > 0)
    .sort((left, right) => right.totalDeficit - left.totalDeficit || left.compound.localeCompare(right.compound));
  const stockedCompounds = snapshot.t3ReserveStatus.compounds.filter(
    compound => compound.hubDeficit === 0 && compound.networkDeficit === 0,
  ).length;

  return {
    hubRoomName: snapshot.hubRoomName,
    status: snapshot.status ?? "idle",
    stage: snapshot.stage,
    ...buildHubHealth(snapshot),
    activeProduct,
    progressMode,
    progressPercent,
    progressText,
    logistics: {
      totalTasks: snapshot.pendingTasks.length,
      imports: snapshot.pendingImports,
      reclaims: snapshot.pendingReclaims,
      exports: snapshot.pendingExports,
      rows: logisticsRows.slice(0, MAX_LOGISTICS_ROWS),
      overflow: Math.max(0, logisticsRows.length - MAX_LOGISTICS_ROWS),
    },
    production: { activeRooms, blockedRooms },
    factory: snapshot.factory,
    t3Reserve: {
      totalCompounds: snapshot.t3ReserveStatus.compounds.length,
      stockedCompounds,
      rows: reserveRows.slice(0, MAX_T3_ROWS),
      overflow: Math.max(0, reserveRows.length - MAX_T3_ROWS),
    },
  };
}

function formatCompactAmount(amount: number): string {
  if (amount >= 1000000) return `${Math.round(amount / 10000) / 100}M`;
  if (amount >= 1000) return `${Math.round(amount / 100) / 10}K`;
  return `${amount}`;
}

function formatTickAge(age: number): string {
  if (age >= 1000) return `${Math.round(age / 100) / 10}kt`;
  return `${age}t`;
}

function formatBlockedReason(reason: ResourceTransferTask["blockedReason"]): string {
  if (reason === "receiver_capacity") return "capacity";
  if (reason === "source_depleted") return "depleted";
  if (reason === "source_protected") return "protected";
  if (reason === "insufficient_terminal_resource_or_fee") return "terminal/fee";
  return "blocked";
}

function formatLogisticsRow(row: HubLogisticsVisualRow): string {
  const arrow = row.direction === "in" ? "←" : "→";
  const blocked = row.blockedReason
    ? ` ⚠${formatBlockedReason(row.blockedReason)}${row.blockedAge === null ? "" : ` ${formatTickAge(row.blockedAge)}`}`
    : "";
  return `${arrow} ${row.classification} ${row.counterpartRoom} ${row.resource} ${formatCompactAmount(row.remaining)} · ${formatTickAge(row.age)}${blocked}`;
}

function healthColor(model: HubVisualModel): string {
  if (model.healthLevel === "error") return VIS_ERROR;
  if (model.healthLevel === "warn") return VIS_WARN;
  return VIS_OK;
}

function blockedTag(row: HubLogisticsVisualRow): string {
  if (!row.blockedReason) return "";
  const age = row.blockedAge === null ? "" : ` ${formatTickAge(row.blockedAge)}`;
  return `⚠ ${formatBlockedReason(row.blockedReason)}${age}`;
}

export function drawHubVisualPanel(rv: VisualSurface, model: HubVisualModel): number {
  const card = new Card({ rv, x: HUB_VISUAL_X, y: HUB_VISUAL_Y, width: HUB_VISUAL_WIDTH });
  const accent = healthColor(model);

  const statusParts = [model.status];
  if (model.stage && model.stage !== model.status) statusParts.push(model.stage);
  card.header(`HUB ${model.hubRoomName}`, statusParts.join(" · "), { label: model.healthLabel, color: accent });

  const alertLines = model.alerts.map(alert => `⚠  ${alert}`);
  if (model.alertOverflow > 0) alertLines.push(`+${model.alertOverflow} more alerts`);
  card.callout(alertLines, model.healthLevel === "error" ? VIS_ERROR : VIS_WARN);

  // 生产
  const productionMeta = model.production.blockedRooms > 0
    ? { text: `${model.production.activeRooms} active · ${model.production.blockedRooms} blocked`, color: VIS_ERROR }
    : { text: `${model.production.activeRooms} active`, color: VIS_DIM };
  card.section("Production", productionMeta);
  if (model.progressMode === "determinate") {
    const pct = model.progressPercent ?? 0;
    const barColor = model.healthLevel === "error" ? VIS_ERROR : pct >= 1 ? VIS_OK : VIS_INBOUND;
    const right = model.progressText.startsWith(`${model.activeProduct} `)
      ? model.progressText.slice(`${model.activeProduct} `.length).replace(/ (\d+%)$/, "  ·  $1")
      : model.progressText;
    card.bar(pct, barColor, model.activeProduct ?? "", right);
  } else if (model.progressMode === "activity") {
    card.row([
      { text: "●", at: 0, color: VIS_OK },
      { text: model.progressText, at: 0.45, color: VIS_TITLE },
    ]);
  } else {
    card.row([{ text: "idle", at: 0, color: VIS_DIM }]);
  }

  if (model.factory) {
    const missing = Object.entries(model.factory.missing).slice(0, 3).map(([r, n]) => `${r}:${formatCompactAmount(n)}`);
    card.row([
      { text: "Factory", at: 0, color: VIS_DIM },
      { text: `${model.factory.product ?? "idle"} · ${model.factory.stage}`, at: 1.6, color: VIS_TITLE },
      { text: model.factory.status, at: 0, align: "right", color: missing.length > 0 ? VIS_WARN : VIS_DIM },
    ]);
    if (missing.length > 0) card.row([
      { text: "need", at: 0, color: VIS_DIM },
      { text: missing.join("  "), at: 1.6, font: 0.32, color: VIS_WARN },
    ]);
  }

  // 物流
  const inboundCount = model.logistics.imports + model.logistics.reclaims;
  card.section("Logistics", { text: `in ${inboundCount}   out ${model.logistics.exports}` });
  for (const row of model.logistics.rows) {
    const inbound = row.direction === "in";
    const tag = blockedTag(row);
    card.row([
      { text: `${inbound ? "←" : "→"}  ${row.classification} ${row.counterpartRoom}`, at: 0, color: row.blockedReason ? VIS_WARN : inbound ? VIS_INBOUND : VIS_OUTBOUND },
      { text: row.resource, at: 4.1, color: VIS_TITLE, bold: true },
      { text: tag ? `${formatCompactAmount(row.remaining)} · ${formatTickAge(row.age)}   ${tag}` : `${formatCompactAmount(row.remaining)} · ${formatTickAge(row.age)}`, at: 0, align: "right", color: tag ? VIS_WARN : VIS_DIM },
    ]);
  }
  if (model.logistics.totalTasks === 0) card.row([{ text: "no pending transfers", at: 0, color: VIS_DIM }]);
  if (model.logistics.overflow > 0) card.row([{ text: `+${model.logistics.overflow} more tasks`, at: 0, color: VIS_DIM }]);

  // 储备
  const reserveMeta = model.t3Reserve.totalCompounds > 0
    ? { text: `${model.t3Reserve.stockedCompounds}/${model.t3Reserve.totalCompounds} stocked`, color: model.t3Reserve.rows.length === 0 ? VIS_OK : VIS_DIM }
    : undefined;
  card.section("Reserve", reserveMeta);
  if (model.t3Reserve.totalCompounds === 0) {
    card.row([{ text: "not configured", at: 0, color: VIS_DIM }]);
  } else if (model.t3Reserve.rows.length === 0) {
    card.row([{ text: "✓ all compounds at reserve", at: 0, color: VIS_OK }]);
  }
  for (const row of model.t3Reserve.rows) {
    const severity = row.totalDeficit >= 5000 ? VIS_ERROR : VIS_WARN;
    const pct = row.hubReserve > 0 ? row.hubAmount / row.hubReserve : 0;
    card.meter(2.3, 4.2, pct, severity);
    card.row([
      { text: row.compound, at: 0, color: severity, bold: true },
      { text: `${formatCompactAmount(row.hubAmount)}/${formatCompactAmount(row.hubReserve)}`, at: 6.9, color: VIS_TEXT },
      { text: row.networkDeficit > 0 ? `net -${formatCompactAmount(row.networkDeficit)}` : "", at: 0, align: "right", color: VIS_DIM },
    ]);
  }
  if (model.t3Reserve.overflow > 0) card.row([{ text: `+${model.t3Reserve.overflow} more deficits`, at: 0, color: VIS_DIM }]);

  return card.flush();
}


/** Satellite visual panel position constants. */
const SATELLITE_VISUAL_X = 1;
const SATELLITE_VISUAL_Y = 2;
const SATELLITE_VISUAL_WIDTH = 13.5;

function formatRoomList(rooms: Array<{ roomName: string }>): string {
  const names = Array.from(new Set(rooms.map(r => r.roomName)));
  const shown = names.slice(0, MAX_LINK_LABELS).join(", ");
  return names.length > MAX_LINK_LABELS ? `${shown} +${names.length - MAX_LINK_LABELS}` : shown;
}

function satelliteStageColor(room: ProductionRoomEntry): string {
  if (room.stage === "blocked" || room.blocker) return VIS_ERROR;
  if (room.stage === "synthesizing" || (room.targetAmount > 0 && room.progressPercent >= 1)) return VIS_OK;
  if (room.stage === "idle") return VIS_DIM;
  return VIS_WARN;
}

/** 先构建卫星房卡片，输出前可核对精确调用数。 */
function buildSatelliteCard(rv: VisualSurface, room: ProductionRoomEntry): Card {
  const card = new Card({ rv, x: SATELLITE_VISUAL_X, y: SATELLITE_VISUAL_Y, width: SATELLITE_VISUAL_WIDTH });
  const accent = satelliteStageColor(room);
  card.header(`SAT ${room.roomName}`, "", { label: room.blocker ? "blocked" : room.stage, color: accent });

  if (room.blocker) card.callout([`⚠  ${room.blocker}`], VIS_ERROR);

  if (room.targetAmount > 0) {
    const pct = room.progressPercent;
    card.bar(pct, accent, room.product, `${formatCompactAmount(room.currentAmount)}/${formatCompactAmount(room.targetAmount)}  ${Math.round(pct * 100)}%`);
  } else {
    card.row([
      { text: room.product, at: 0, color: VIS_TITLE, bold: true },
      { text: `${formatCompactAmount(room.currentAmount)} · no target`, at: 0, align: "right", color: VIS_DIM },
    ]);
  }

  // 每行只用一次文字调用，控制单个卫星面板的绘图开销。
  if (room.upstream.length > 0) card.row([{ text: `←  from  ${formatRoomList(room.upstream)}`, at: 0, color: VIS_INBOUND }]);
  if (room.downstream.length > 0) card.row([{ text: `→  to  ${formatRoomList(room.downstream)}`, at: 0, color: VIS_OUTBOUND }]);
  const route: string[] = [];
  if (room.directSupplyAmount > 0) route.push(`direct ${formatCompactAmount(room.directSupplyAmount)}`);
  if (room.hubSurplusAmount > 0) route.push(`via hub ${formatCompactAmount(room.hubSurplusAmount)}`);
  if (route.length > 0) card.row([{ text: `route  ${route.join("  ·  ")}`, at: 0, color: VIS_DIM }]);
  return card;
}

const NULL_VISUAL_SURFACE: VisualSurface = {
  rect() { return NULL_VISUAL_SURFACE; },
  text() { return NULL_VISUAL_SURFACE; },
};

export function estimateSatellitePanelCalls(room: ProductionRoomEntry): number {
  return buildSatelliteCard(NULL_VISUAL_SURFACE, room).pendingCalls;
}

/** 在卫星房绘制紧凑生产卡片。 */
export function drawSatellitePanel(rv: VisualSurface, room: ProductionRoomEntry): number {
  return buildSatelliteCard(rv, room).flush();
}

function classifyTransferTask(
  reason: string | undefined,
): HubTransferClassification | null {
  if (!reason) return null;
  if (reason.startsWith("hub:import:")) return "import";
  if (reason.startsWith("hub:factory:")) return "import";
  if (reason.startsWith("hub:reclaim:")) return "reclaim";
  if (reason.startsWith("hub:export:")) return "export";
  return null;
}

export function collectCarrierCargoInventory(hubRoomName: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const creep of getTickContextService().getAllCreeps()) {
    if (creep.memory.role !== "carrier") continue;
    const configName = creep.memory.configName;
    const assignedRoom = configName
      ? getCreepConfigService().get(configName)?.roomName || creep.room.name
      : creep.room.name;
    if (assignedRoom !== hubRoomName) continue;
    const store = creep.store as unknown as Record<string, number>;
    for (const [resource, amount] of Object.entries(store)) {
      if (resource !== RESOURCE_ENERGY && amount > 0) {
        result[resource] = (result[resource] || 0) + amount;
      }
    }
  }
  return result;
}

function buildCompactInventory(
  storageStore: Record<string, number> | null,
  terminalStore: Record<string, number> | null,
  targetCompounds: ResourceConstant[],
  activeProduct: string | null,
  missingResources: string[],
  lastPlanActions: string[],
  carrierCargo: Record<string, number>,
): Record<string, number> {
  const combined: Record<string, number> = {};

  if (storageStore) {
    for (const [resource, amount] of Object.entries(storageStore)) {
      if (amount > 0) combined[resource] = (combined[resource] || 0) + amount;
    }
  }
  if (terminalStore) {
    for (const [resource, amount] of Object.entries(terminalStore)) {
      if (amount > 0) combined[resource] = (combined[resource] || 0) + amount;
    }
  }
  for (const [resource, amount] of Object.entries(carrierCargo)) {
    if (amount > 0) combined[resource] = (combined[resource] || 0) + amount;
  }

  const priorityResources = new Set<string>();
  for (const tc of targetCompounds) priorityResources.add(tc);
  if (activeProduct) priorityResources.add(activeProduct);
  for (const mr of missingResources) priorityResources.add(mr);
  for (const pa of lastPlanActions) priorityResources.add(pa);

  const result: Record<string, number> = {};
  for (const resource of priorityResources) {
    if (combined[resource] !== undefined) result[resource] = combined[resource];
  }

  const remaining = Object.entries(combined)
    .filter(([resource]) => !priorityResources.has(resource) && resource !== RESOURCE_ENERGY)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_INVENTORY_EXTRA);

  for (const [resource, amount] of remaining) {
    result[resource] = amount;
  }

  return result;
}

function countPendingHubTasks(
  transferTasks: Record<string, ResourceTransferTask> | null,
  hubRoomName: string,
  currentTick: number,
): {
  pendingImports: number;
  pendingReclaims: number;
  pendingExports: number;
  pendingTasks: HubProgressPendingTask[];
} {
  let pendingImports = 0;
  let pendingReclaims = 0;
  let pendingExports = 0;
  const pendingTasks: HubProgressPendingTask[] = [];

  if (!transferTasks) {
    return { pendingImports, pendingReclaims, pendingExports, pendingTasks };
  }

  for (const task of Object.values(transferTasks)) {
    if (task.status !== "pending") continue;
    const classification = classifyTransferTask(task.reason);
    if (!classification) continue;

    if (task.fromRoomName !== hubRoomName && task.toRoomName !== hubRoomName) continue;

    const createdAt = Number.isFinite(task.createdAt) ? task.createdAt : currentTick;
    const updatedAt = Number.isFinite(task.updatedAt) ? task.updatedAt : createdAt;
    const lastProgressAt = Number.isFinite(task.lastProgressAt) ? task.lastProgressAt : updatedAt;
    const blockedSince = Number.isFinite(task.blockedSince) ? task.blockedSince! : null;

    pendingTasks.push({
      resource: task.resource,
      from: task.fromRoomName,
      to: task.toRoomName,
      remaining: task.remainingAmount,
      reason: task.reason || "",
      classification,
      createdAt,
      updatedAt,
      lastProgressAt,
      age: Math.max(0, currentTick - createdAt),
      lastProgressAge: Math.max(0, currentTick - lastProgressAt),
      blockedReason: task.blockedReason ?? null,
      blockedSince,
      blockedAge: blockedSince === null ? null : Math.max(0, currentTick - blockedSince),
    });

    if (classification === "import") pendingImports++;
    else if (classification === "reclaim") pendingReclaims++;
    else if (classification === "export") pendingExports++;
  }

  return { pendingImports, pendingReclaims, pendingExports, pendingTasks };
}

function buildRoomTerminalBlockers(
  resourceControlRooms: HubProgressInput["resourceControlRooms"],
  transferTasks: Record<string, ResourceTransferTask> | null,
  hubRoomName: string,
): Array<{ room: string; terminalEnergy: number; reserve: number; pendingNonEnergy: number }> {
  if (!resourceControlRooms) return [];

  const result: Array<{ room: string; terminalEnergy: number; reserve: number; pendingNonEnergy: number }> = [];
  const roomEntries = Object.entries(resourceControlRooms).filter(([roomName]) => roomName !== hubRoomName);
  const needsPendingNonEnergyIndex = roomEntries.some(([, roomData]) => {
    if (!roomData.taskHealth) return true;
    return roomData.taskHealth.pendingIncoming + roomData.taskHealth.pendingOutgoing !== 0;
  });
  const pendingNonEnergyByRoom = new Map<string, number>();

  if (needsPendingNonEnergyIndex && transferTasks) {
    for (const task of Object.values(transferTasks)) {
      if (task.status !== "pending") continue;
      if (task.resource === RESOURCE_ENERGY) continue;

      pendingNonEnergyByRoom.set(
        task.fromRoomName,
        (pendingNonEnergyByRoom.get(task.fromRoomName) || 0) + 1,
      );
      if (task.toRoomName !== task.fromRoomName) {
        pendingNonEnergyByRoom.set(
          task.toRoomName,
          (pendingNonEnergyByRoom.get(task.toRoomName) || 0) + 1,
        );
      }
    }
  }

  for (const [roomName, roomData] of roomEntries) {
    const projectedPending = roomData.taskHealth
      ? roomData.taskHealth.pendingIncoming + roomData.taskHealth.pendingOutgoing
      : undefined;
    const pendingNonEnergy = projectedPending === 0 ? 0 : (pendingNonEnergyByRoom.get(roomName) || 0);

    result.push({
      room: roomName,
      terminalEnergy: roomData.terminalEnergy,
      reserve: roomData.terminalEnergyReserve ?? DEFAULT_TERMINAL_ENERGY_RESERVE,
      pendingNonEnergy,
    });
  }

  return result;
}

function buildProductionRooms(
  distributedSynthesis: HubProgressInput["distributedSynthesis"],
  synthesisControlRooms: HubProgressInput["synthesisControlRooms"],
  synthesisControlCfgRooms: HubProgressInput["synthesisControlCfgRooms"],
  hubRoomName: string,
): ProductionRoomEntry[] {
  if (!distributedSynthesis?.dispatchAssignments?.length) return [];

  const assignments = distributedSynthesis.dispatchAssignments;
  const routeDecisions = distributedSynthesis.routeDecisions ?? [];
  const progressEdges = distributedSynthesis.progressEdges ?? [];
  const allocationLedger = distributedSynthesis.allocationLedger ?? {};

  const busyStages = new Set(["loading", "synthesizing", "unloading"]);

  // Group assignments by roomName, preserving first-seen order.
  const roomGroups = new Map<string, typeof assignments>();
  const roomOrder: string[] = [];
  for (const a of assignments) {
    if (!roomGroups.has(a.roomName)) {
      roomGroups.set(a.roomName, []);
      roomOrder.push(a.roomName);
    }
    roomGroups.get(a.roomName)!.push(a);
  }

  // For each room, select the best assignment and build exactly one entry.
  const selectedAssignments: typeof assignments = [];
  for (const roomName of roomOrder) {
    const group = roomGroups.get(roomName)!;
    if (group.length === 1) {
      selectedAssignments.push(group[0]);
      continue;
    }

    const runtimeRoom = synthesisControlRooms?.[roomName];
    const activeProduct = runtimeRoom?.activeProduct;
    const stage = runtimeRoom?.stage ?? "idle";

    let selected = group[0];
    if (activeProduct && busyStages.has(stage)) {
      const match = group.find(a => a.product === activeProduct);
      if (match) selected = match;
    }
    selectedAssignments.push(selected);
  }

  return selectedAssignments.map((assignment) => {
    const { roomName, targetAmount, isHubRoom } = assignment;

    const runtimeRoom = synthesisControlRooms?.[roomName];
    const stage = runtimeRoom?.stage ?? "idle";

    // Show the actual configured product when the room is busy with a reaction,
    // not the planner's intended assignment (which may differ until reassignment).
    const cfgProduct = synthesisControlCfgRooms?.[roomName]?.reactions?.[0]?.product;
    const product = (cfgProduct && busyStages.has(stage)) ? cfgProduct as ResourceConstant : assignment.product;

    const room = Game.rooms[roomName];
    let currentAmount = 0;
    if (room) {
      const storageAmount = (room.storage?.store as unknown as Record<string, number>)?.[product] ?? 0;
      const terminalAmount = (room.terminal?.store as unknown as Record<string, number>)?.[product] ?? 0;
      let labAmount = 0;
      if (typeof room.find === "function") {
        const labs = room.find(FIND_MY_STRUCTURES, {
          filter: (s: AnyStructure) => s.structureType === STRUCTURE_LAB,
        }) as StructureLab[];
        for (const lab of labs) {
          const store = lab.store as unknown as Record<string, number>;
          labAmount += store[product] ?? 0;
        }
      }
      currentAmount = storageAmount + terminalAmount + labAmount;
    }

    const progressPercent = targetAmount > 0 ? Math.min(currentAmount / targetAmount, 1) : 0;

    const upstream: Array<{ roomName: string; resource: ResourceConstant }> = [];
    const downstream: Array<{ roomName: string; resource: ResourceConstant }> = [];

    for (const edge of progressEdges) {
      if (edge.toRoom === roomName) {
        upstream.push({ roomName: edge.fromRoom, resource: edge.resource });
      }
      if (edge.fromRoom === roomName) {
        downstream.push({ roomName: edge.toRoom, resource: edge.resource });
      }
    }

    let directSupplyAmount = 0;
    for (const route of routeDecisions) {
      if (route.fromRoom === roomName && route.toRoom !== hubRoomName) {
        directSupplyAmount += route.amount;
      }
    }

    let hubSurplusAmount = 0;
    for (const route of routeDecisions) {
      if (route.fromRoom === roomName && route.toRoom === hubRoomName) {
        hubSurplusAmount += route.amount;
      }
    }

    const blocker = runtimeRoom?.lastError ?? null;

    return {
      roomName,
      product,
      stage,
      progressPercent,
      currentAmount,
      targetAmount,
      isHubRoom,
      upstream,
      downstream,
      directSupplyAmount,
      hubSurplusAmount,
      blocker,
    };
  });
}

function buildT3ReserveStatus(
  hubStorageStore: Record<string, number> | null,
  hubTerminalStore: Record<string, number> | null,
  hubLabInventory: Record<string, number>,
  targetCompounds: ResourceConstant[],
  reservePerRoom: number,
  hubReservePerCompound: number,
  satelliteStores: HubProgressInput["satelliteStores"],
  hubOnlyReserve: number,
): {
  hubSurplus: number;
  totalDeficit: Array<{ compound: string; needed: number }>;
  compounds: HubT3CompoundStatus[];
} {
  let hubSurplus = 0;
  const hubAmountByCompound: Record<string, number> = {};
  for (const compound of targetCompounds) {
    const hubAmount = (hubStorageStore?.[compound] || 0) + (hubTerminalStore?.[compound] || 0) + (hubLabInventory[compound] || 0);
    hubAmountByCompound[compound] = hubAmount;
    hubSurplus += Math.max(0, hubAmount - (isHubOnlyReserveCompound(compound) ? hubOnlyReserve : hubReservePerCompound));
  }

  const compoundDeficit: Record<string, number> = {};
  if (satelliteStores) {
    for (const sat of satelliteStores) {
      for (const compound of targetCompounds) {
        if (isHubOnlyReserveCompound(compound)) continue;
        const current = (sat.storage?.[compound] || 0) + (sat.terminal?.[compound] || 0);
        const needed = Math.max(0, reservePerRoom - current);
        if (needed > 0) {
          compoundDeficit[compound] = (compoundDeficit[compound] || 0) + needed;
        }
      }
    }
  }

  const totalDeficit = Object.entries(compoundDeficit)
    .map(([compound, needed]) => ({ compound, needed }))
    .sort((a, b) => b.needed - a.needed);

  const compounds = targetCompounds.map<HubT3CompoundStatus>(compound => {
    const hubAmount = hubAmountByCompound[compound] || 0;
    const reserve = isHubOnlyReserveCompound(compound) ? hubOnlyReserve : hubReservePerCompound;
    return {
      compound,
      hubAmount,
      hubReserve: reserve,
      hubSurplus: Math.max(0, hubAmount - reserve),
      hubDeficit: Math.max(0, reserve - hubAmount),
      networkDeficit: compoundDeficit[compound] || 0,
    };
  });

  return { hubSurplus, totalDeficit, compounds };
}

function cloneProtectionAttempt(
  attempt: HubProtectionAttempt | undefined,
): HubProtectionAttempt | null {
  if (!attempt) return null;
  return {
    attemptRevision: attempt.attemptRevision,
    configIncarnation: attempt.configIncarnation,
    startedAt: attempt.startedAt,
    ...(attempt.finishedAt === undefined
      ? {}
      : { finishedAt: attempt.finishedAt }),
    configFingerprint: attempt.configFingerprint,
    status: attempt.status,
    valid: attempt.valid,
    ...(attempt.reason === undefined ? {} : { reason: attempt.reason }),
  };
}

function buildCommittedProtectionMarker(
  snapshot: HubCommittedProtectionSnapshot | undefined,
): HubCommittedProtectionProgressMarker | null {
  if (!snapshot) return null;
  return {
    schema: snapshot.schema,
    planRevision: snapshot.planRevision,
    configIncarnation: snapshot.configIncarnation,
    observedAt: snapshot.observedAt,
    expiresAt: snapshot.expiresAt,
    configFingerprint: snapshot.configFingerprint,
    status: snapshot.status,
    valid: snapshot.valid,
    marker: {
      revision: snapshot.marker.revision,
      configIncarnation: snapshot.marker.configIncarnation,
      configFingerprint: snapshot.marker.configFingerprint,
      hubRoomName: snapshot.marker.hubRoomName,
      planMode: snapshot.marker.planMode,
    },
    components: {
      synthesisConfig: {
        revision: snapshot.synthesisConfig.revision,
        configIncarnation:
          snapshot.synthesisConfig.configIncarnation,
        configFingerprint: snapshot.synthesisConfig.configFingerprint,
      },
      transferTasks: {
        revision: snapshot.transferTasks.revision,
        configIncarnation:
          snapshot.transferTasks.configIncarnation,
        configFingerprint: snapshot.transferTasks.configFingerprint,
      },
      distributed: {
        revision: snapshot.distributed.revision,
        configIncarnation:
          snapshot.distributed.configIncarnation,
        configFingerprint: snapshot.distributed.configFingerprint,
      },
      baseMineralSurplus: {
        revision: snapshot.baseMineralSurplus.revision,
        configIncarnation:
          snapshot.baseMineralSurplus.configIncarnation,
        configFingerprint: snapshot.baseMineralSurplus.configFingerprint,
      },
    },
    ...(snapshot.failureReason === undefined
      ? {}
      : { failureReason: snapshot.failureReason }),
  };
}

export function buildHubProgressSnapshot(input: HubProgressInput): HubProgressSnapshot {
  const { hubConfig, hubRuntime, synthesisRuntime, currentTick } = input;

  if (!hubConfig?.enabled) {
    return {
      updatedAt: currentTick,
      enabled: false,
      hubRoomName: hubConfig?.hubRoomName || "",
      hubRoomVisible: false,
      status: null,
      stage: null,
      activeProduct: null,
      lastPlanActions: [],
      missingResources: [],
      lastError: null,
      needsPlan: false,
      hubStorageEnergy: 0,
      hubTerminalEnergy: 0,
      hubInventory: {},
      pendingImports: 0,
      pendingReclaims: 0,
      pendingExports: 0,
      pendingTasks: [],
      roomTerminalBlockers: [],
      hubLabInventory: {},
      hubCarrierCargo: {},
      productionRooms: [],
      t3ReserveStatus: { hubSurplus: 0, totalDeficit: [], compounds: [] },
      protectionAttempt: cloneProtectionAttempt(
        hubRuntime?.currentProtectionAttempt,
      ),
      committedProtectionMarker: buildCommittedProtectionMarker(
        hubRuntime?.committedProtectionSnapshot,
      ),
    };
  }

  const hubRoomName = hubConfig.hubRoomName || "";
  const hubRoomVisible = !!(input.hubStorageStore !== null || input.hubTerminalStore !== null);

  const lastPlanActions = (hubRuntime?.lastPlanActions || []).slice(0, MAX_LAST_PLAN_ACTIONS);
  const missingResources = hubRuntime?.missingResources || [];
  const activeProduct = synthesisRuntime?.activeProduct || hubRuntime?.activeProduct || null;

  const hubStorageEnergy = input.hubStorageStore?.[RESOURCE_ENERGY] || 0;
  const hubTerminalEnergy = input.hubTerminalStore?.[RESOURCE_ENERGY] || 0;

  const hubCarrierCargo = input.hubCarrierCargo ?? {};
  const hubInventory = buildCompactInventory(
    input.hubStorageStore,
    input.hubTerminalStore,
    hubConfig.targetCompounds || [],
    activeProduct,
    missingResources,
    lastPlanActions,
    hubCarrierCargo,
  );

  const { pendingImports, pendingReclaims, pendingExports, pendingTasks } = countPendingHubTasks(
    input.transferTasks,
    hubRoomName,
    currentTick,
  );

  const roomTerminalBlockers = buildRoomTerminalBlockers(
    input.resourceControlRooms,
    input.transferTasks,
    hubRoomName,
  );

  const targetCompounds = hubConfig.targetCompounds?.length ? hubConfig.targetCompounds : [];
  const reservePerRoom = hubConfig.reservePerRoom ?? HUB_RESERVE_PER_ROOM;
  const hubReservePerCompound = hubConfig.hubReservePerCompound ?? HUB_RESERVE_PER_COMPOUND;
  const t3ReserveStatus = buildT3ReserveStatus(
    input.hubStorageStore,
    input.hubTerminalStore,
    input.hubLabInventory ?? {},
    targetCompounds,
    reservePerRoom,
    hubReservePerCompound,
    input.satelliteStores,
    getHubOnlyReserve(hubConfig),
  );

  return {
    updatedAt: currentTick,
    enabled: true,
    hubRoomName,
    hubRoomVisible,
    status: hubRuntime?.status || null,
    stage: synthesisRuntime?.stage || null,
    activeProduct,
    lastPlanActions,
    missingResources,
    lastError: hubRuntime?.lastError || null,
    needsPlan: hubRuntime?.needsPlan || false,
    hubStorageEnergy,
    hubTerminalEnergy,
    hubInventory,
    pendingImports,
    pendingReclaims,
    pendingExports,
    pendingTasks,
    roomTerminalBlockers,
    hubLabInventory: input.hubLabInventory ?? {},
    hubCarrierCargo,
    synthesisTargetAmount: input.synthesisRuntime?.targetAmount,
    factory: input.factory,
    productionRooms: buildProductionRooms(
      input.distributedSynthesis,
      input.synthesisControlRooms,
      input.synthesisControlCfgRooms,
      hubRoomName,
    ),
    t3ReserveStatus,
    protectionAttempt: cloneProtectionAttempt(
      hubRuntime?.currentProtectionAttempt,
    ),
    committedProtectionMarker: buildCommittedProtectionMarker(
      hubRuntime?.committedProtectionSnapshot,
    ),
  };
}

export function collectHubProgressSnapshot(): HubProgressSnapshot {
  const hubConfig = Memory.cfg?.hub ?? null;
  const hubRuntime = Memory.runtime?.hub ?? null;
  const hubRoomName = hubConfig?.hubRoomName || "";

  const synthesisRoom = Memory.runtime?.synthesisControl?.rooms?.[hubRoomName];
  const synthesisRuntime = synthesisRoom ?? null;

  const room = hubRoomName ? Game.rooms[hubRoomName] : undefined;
  const hubStorageStore = (room?.storage?.store as unknown as Record<string, number> | undefined) ?? null;
  const hubTerminalStore = (room?.terminal?.store as unknown as Record<string, number> | undefined) ?? null;

  const hubLabInventory: Record<string, number> = {};
  if (room && typeof room.find === "function") {
    const labs = room.find(FIND_MY_STRUCTURES, {
      filter: (s: AnyStructure) => s.structureType === STRUCTURE_LAB,
    }) as StructureLab[];
    for (const lab of labs) {
      const store = lab.store as unknown as Record<string, number>;
      for (const [resource, amount] of Object.entries(store)) {
        if (resource !== RESOURCE_ENERGY && amount > 0) {
          hubLabInventory[resource] = (hubLabInventory[resource] || 0) + amount;
        }
      }
    }
  }

  const resourceControlRooms = Memory.runtime?.resourceControl?.rooms ?? null;

  const transferTasks = ensureResourceTransferTaskStore();

  const hubCarrierCargo = collectCarrierCargoInventory(hubRoomName);
  const factoryPlan = Memory.runtime?.factoryControl?.hubPlan;
  const factoryState = Memory.runtime?.factoryControl?.rooms?.[hubRoomName];
  const factory: HubFactoryProgress | undefined = factoryPlan?.hubRoomName === hubRoomName ? {
    status: factoryPlan.status,
    stage: factoryState?.stage ?? "idle",
    product: factoryState?.activeTarget ?? factoryPlan.targets[0]?.resource ?? null,
    missing: { ...(factoryState?.missing ?? factoryPlan.missing) },
    lastProducedAt: factoryState?.lastProducedAt ?? null,
  } : undefined;

  const satelliteStores: Array<{
    roomName: string;
    storage: Record<string, number> | null;
    terminal: Record<string, number> | null;
  }> = [];
  if (hubRoomName) {
    for (const [roomName, room] of Object.entries(Game.rooms)) {
      if (roomName === hubRoomName) continue;
      if (!room.controller?.my) continue;
      if (!room.storage || !room.terminal) continue;
      satelliteStores.push({
        roomName,
        storage: room.storage.store as unknown as Record<string, number>,
        terminal: room.terminal.store as unknown as Record<string, number>,
      });
    }
  }

  return buildHubProgressSnapshot({
    hubConfig,
    hubRuntime,
    synthesisRuntime,
    hubStorageStore,
    hubTerminalStore,
    hubLabInventory,
    hubCarrierCargo,
    factory,
    resourceControlRooms,
    transferTasks,
    currentTick: Game.time,
    distributedSynthesis: Memory.runtime?.hub?.distributedSynthesis,
    synthesisControlRooms: Memory.runtime?.synthesisControl?.rooms,
    synthesisControlCfgRooms: Memory.cfg?.synthesisControl?.rooms,
    satelliteStores,
  });
}

interface HubVisualCacheEntry {
  collectedAt: number;
  signature: string;
  snapshot: HubProgressSnapshot;
  model: HubVisualModel;
}

const HUB_VISUAL_CACHE_TTL = 5;
let hubVisualCache: HubVisualCacheEntry | null = null;

function currentHubVisualSignature(): string {
  const cfg = Memory.cfg?.hub;
  const hub = Memory.runtime?.hub;
  const hubRoomName = cfg?.hubRoomName || "";
  const synthesis = Memory.runtime?.synthesisControl?.rooms?.[hubRoomName];
  const factory = Memory.runtime?.factoryControl?.rooms?.[hubRoomName];
  const attempt = hub?.currentProtectionAttempt;
  const committed = hub?.committedProtectionSnapshot;

  return JSON.stringify([
    cfg?.enabled ?? false,
    hubRoomName,
    cfg?.reservePerRoom ?? null,
    cfg?.hubReservePerCompound ?? null,
    cfg?.hubOnlyReservePerCompound ?? null,
    cfg?.targetCompounds?.join(",") ?? "",
    hub?.status ?? null,
    hub?.needsPlan ?? false,
    hub?.lastError ?? null,
    hub?.activeProduct ?? null,
    synthesis?.stage ?? null,
    synthesis?.activeProduct ?? null,
    synthesis?.targetAmount ?? null,
    Memory.runtime?.factoryControl?.hubPlan?.status ?? null,
    factory?.stage ?? null,
    factory?.activeTarget ?? null,
    attempt?.attemptRevision ?? null,
    attempt?.status ?? null,
    attempt?.valid ?? null,
    committed?.planRevision ?? null,
    committed?.status ?? null,
    committed?.valid ?? null,
    committed ? Game.time > committed.expiresAt : false,
  ]);
}

function cacheHubVisualSnapshot(snapshot: HubProgressSnapshot, signature = currentHubVisualSignature()): HubVisualCacheEntry {
  const entry: HubVisualCacheEntry = {
    collectedAt: Game.time,
    signature,
    snapshot,
    model: buildHubVisualModel(snapshot),
  };
  hubVisualCache = entry;
  return entry;
}

function getHubVisualState(): HubVisualCacheEntry {
  const signature = currentHubVisualSignature();
  const cacheAge = hubVisualCache ? Game.time - hubVisualCache.collectedAt : Number.POSITIVE_INFINITY;
  if (
    hubVisualCache &&
    cacheAge >= 0 &&
    cacheAge < HUB_VISUAL_CACHE_TTL &&
    hubVisualCache.signature === signature
  ) {
    return hubVisualCache;
  }

  return cacheHubVisualSnapshot(collectHubProgressSnapshot(), signature);
}

export function resetHubVisualCacheForTests(): void {
  hubVisualCache = null;
}

export function runHubProgressAnalytics(): void {
  const hubConfig = Memory.cfg?.hub;
  if (!hubConfig?.enabled) return;

  const hubRuntime = Memory.runtime?.hub;
  const needsPlan = hubRuntime?.needsPlan === true;

  if (!needsPlan && !isDue("hubProgress.analytics", ANALYTICS_SAMPLE_INTERVAL)) {
    return;
  }

  const snapshot = collectHubProgressSnapshot();
  cacheHubVisualSnapshot(snapshot);
  const analytics = getMemoryService().ensureAnalytics();
  analytics.hub = snapshot;
}

const MAX_LINK_LABELS = 2;
/**
 * 为主面板与最多 24 个卫星面板预留绘图预算。
 * 单卡片费用随内容变化，输出前按实际缓冲指令数检查预算。
 */
const MAX_SATELLITE_PANELS = 24;
const MAX_HUB_VISUAL_CALLS = 450;

export interface HubOverlayRenderStats {
  callsUsed: number;
  satellitePanels: number;
  skippedSatellitePanels: number;
}

function sortSatelliteCandidates(left: ProductionRoomEntry, right: ProductionRoomEntry): number {
  const leftBlocked = left.stage === "blocked" || !!left.blocker;
  const rightBlocked = right.stage === "blocked" || !!right.blocker;
  if (leftBlocked !== rightBlocked) return Number(rightBlocked) - Number(leftBlocked);

  const leftActive = ACTIVE_PRODUCTION_STAGES.has(left.stage);
  const rightActive = ACTIVE_PRODUCTION_STAGES.has(right.stage);
  if (leftActive !== rightActive) return Number(rightActive) - Number(leftActive);
  return left.roomName.localeCompare(right.roomName);
}

function buildSatelliteCandidates(snapshot: HubProgressSnapshot): ProductionRoomEntry[] {
  const candidates = new Map<string, ProductionRoomEntry>();
  for (const room of snapshot.productionRooms) {
    if (room.isHubRoom || room.roomName === snapshot.hubRoomName || !Game.rooms[room.roomName]) continue;
    if (!candidates.has(room.roomName)) candidates.set(room.roomName, room);
  }
  return Array.from(candidates.values()).sort(sortSatelliteCandidates);
}

export function renderHubProgressOverlays(): HubOverlayRenderStats | null {
  if (typeof RoomVisual === "undefined") return null;
  if (!Memory.cfg?.hub?.enabled) return null;
  const visuals = Memory.cfg.hub.visuals;
  if (visuals?.enabled !== true) return null;
  if (visuals.untilTick !== undefined &&
    (!Number.isFinite(visuals.untilTick) || Game.time >= visuals.untilTick)) return null;
  if (!hasDiagnosticBudget(visuals.minBucket)) return null;

  const visualState = getHubVisualState();
  const { snapshot, model } = visualState;
  if (!snapshot.enabled) return null;
  if (!snapshot.hubRoomName) return null;

  const hubRoom = Game.rooms[snapshot.hubRoomName];
  if (!hubRoom) return null;

  const rv = new RoomVisual(snapshot.hubRoomName);
  let callsUsed = drawHubVisualPanel(rv, model);
  let satellitePanels = 0;
  let skippedSatellitePanels = 0;

  for (const room of buildSatelliteCandidates(snapshot)) {
    if (satellitePanels >= MAX_SATELLITE_PANELS) {
      skippedSatellitePanels++;
      continue;
    }
    const satelliteCard = buildSatelliteCard(new RoomVisual(room.roomName), room);
    if (callsUsed + satelliteCard.pendingCalls > MAX_HUB_VISUAL_CALLS) {
      skippedSatellitePanels++;
      continue;
    }
    callsUsed += satelliteCard.flush();
    satellitePanels++;
  }

  if (skippedSatellitePanels > 0 && isDue("hubProgress.overlay", 100)) {
    console.log(`[hub-visual] skipped ${skippedSatellitePanels} satellite panels; calls=${callsUsed}/${MAX_HUB_VISUAL_CALLS}`);
  }

  return { callsUsed, satellitePanels, skippedSatellitePanels };
}
