/**
 * Treasury Transaction Journal + Projected Overlay + Reconciler。
 *
 * 语义约束：
 * - 一个已接受动作 = 一个 transaction（唯一幂等 id）+ 一或多腿 posting，
 *   所有 posting 整体验证、一次性原子写入；任一 posting 非法则整笔回滚，
 *   绝不出现部分写入；
 * - 幂等三段：heap 本 tick 缓存 → Memory receipt（跨 tick / global reset
 *   权威，v2 前缀键 + entryCount 计数）→ 已结算 id 一律拒绝重复叠加；
 * - receipt admission 预检（满容 fail closed / 版本不兼容 fail closed）
 *   在写入任何状态之前执行，admission 失败零部分写入；
 * - 物理可行性验证使用 transaction decision 指向的 exact observation
 *   （shared 或某次 market-fresh），绝不回退到 shared observation：
 *   * decision observation 提供该决策时点的物理基线（数量/容量/结构存在性）；
 *   * Treasury overlay 提供本 tick 已被接受但尚未反映到下一 tick 物理事实
 *     的 intents（同 tick 多笔 transaction 依此防超卖同一资源/容量）；
 *   * exact fresh observation 不能被 shared observation 替代（fresh read
 *     的意义就在于决策时点的独立物理快照）；
 * - Observed 数值永不修改：投影只叠加在 overlay 上；容量 delta 按位置
 *   独立聚合（capacityDeltas），projectedUsed/Free 与 receiver headroom
 *   查询 O(1)，不扫描资源 overlay；
 * - 单调 projectionRevision 随每次成功提交递增：依赖 overlay 的派生缓存
 *   （receiver projected headroom 等）以它判断失效，绝不把依赖当前 overlay
 *   的 projected 数值缓存到旧结果里；
 * - endTick 归档投影终态（资源 finals + 房间/位置 manifest，含
 *   structureId），下一 tick beginTick 两层对账：
 *   1. manifest 结构层（每位置至多一条）：空房间/空结构的新建、摧毁、
 *      structureId 替换——零资源结构在稀疏 amounts 中不可见，只有 manifest
 *      层能发现；
 *   2. resource key union 层：数量差异按资源维度独立计数（inflow/outflow/
 *      new_resource），结构事件不在此层重复计数；
 *   tick gap 与 global reset 显式分类，不静默；
 * - journal（本 tick 明细 + 上一 tick 追溯副本）只在 heap，绝不持久化。
 */

import {
  type TreasuryEpoch,
  type TreasuryJournalEntry,
  type TreasuryLocationKind,
  type TreasuryLocationManifestEntry,
  type TreasuryObservationScope,
  type TreasuryObservationView,
  type TreasuryPosting,
  type TreasuryProjectedArchive,
  type TreasuryProjectedFinal,
  type TreasuryReconciliationCategory,
  type TreasuryReconciliationSample,
  type TreasuryReconciliationSummary,
  type TreasuryRejectedResult,
  type TreasuryRejectionReason,
  type TreasurySettlementResult,
  type TreasuryTickManifest,
  type TreasuryTransactionInput,
  treasuryLocationKey,
} from "@/runtime/treasury/types";
import { isValidTreasuryTransactionId } from "@/runtime/treasury/transactionId";
import type { TreasuryCanonicalTransaction } from "@/runtime/treasury/canonicalTransaction";
import {
  admitTreasuryReceipt,
  commitSettledReceipt,
  hasSettledReceipt,
  releaseAllTreasuryReceiptReservations,
  type TreasuryReceiptWriteResult,
} from "@/runtime/treasury/receipts";

const RECONCILIATION_SAMPLE_CAP = 16;
const RECONCILIATION_TRACE_TRANSACTION_CAP = 4;
/** 上一 tick journal 追溯副本上限（防洪峰 heap 膨胀；只截断追溯，不影响数值对账）。 */
const PREVIOUS_JOURNAL_CAP = 512;

const VALID_RESOURCES: ReadonlySet<string> = new Set<string>(RESOURCES_ALL);
const VALID_LOCATION_KINDS: ReadonlySet<string> = new Set<string>(["storage", "terminal"]);

/** 验证通过的交易形状：合并腿（净零腿已剔除）+ 位置容量聚合。 */
export interface TreasuryValidatedTransactionShape {
  readonly merged: ReadonlyArray<{
    roomName: string;
    locationKind: "storage" | "terminal";
    resource: string;
    delta: number;
  }>;
  readonly capacityDeltaByLocation: ReadonlyMap<string, number>;
}

type TransactionValidation =
  | { readonly status: "valid"; readonly shape: TreasuryValidatedTransactionShape }
  | { readonly status: "invalid"; readonly result: TreasuryRejectedResult };

export interface TreasuryProjectionState {
  /** 本 tick journal（endTick 归档时转存 previousJournal 并清空）。 */
  journal: TreasuryJournalEntry[];
  /** locationKey:resource → 累计 delta（本 tick）。 */
  overlay: Map<string, number>;
  /** locationKey → 该位置全部资源 delta 之和（容量净变化；O(1) 查询）。 */
  capacityDeltas: Map<string, number>;
  /** 本 tick 已结算 transactionId → tick（heap 加速；跨 tick 权威在 Memory receipt）。 */
  settledThisTick: Map<string, number>;
  /** 上一 tick journal 有界副本（对账追溯用）。 */
  previousJournal: readonly TreasuryJournalEntry[];
  /**
   * tentative ledger（第五轮新增）：prepared transaction 的资源/容量预留。
   * 与 committed overlay 分离——public projected 只含 committed，后续
   * prepare 的授权计算计入 tentative（防多笔 prepare 超卖同一资产）。
   */
  tentativeByReservation: Map<string, TentativeReservation>;
  tentativeResourceTotals: Map<string, number>;
  tentativeCapacityTotals: Map<string, number>;
}

/** 单笔 prepared transaction 的 tentative 预留。 */
export interface TentativeReservation {
  readonly resourceDeltas: Map<string, number>;
  readonly capacityDeltas: Map<string, number>;
}

export function createTreasuryProjectionState(): TreasuryProjectionState {
  return {
    journal: [],
    overlay: new Map(),
    capacityDeltas: new Map(),
    settledThisTick: new Map(),
    previousJournal: [],
    tentativeByReservation: new Map(),
    tentativeResourceTotals: new Map(),
    tentativeCapacityTotals: new Map(),
  };
}

function overlayKey(roomName: string, locationKind: string, resource: string): string {
  return `${treasuryLocationKey(roomName, locationKind as "storage" | "terminal")}:${resource}`;
}

function parseOverlayKey(
  key: string,
): { roomName: string; locationKind: "storage" | "terminal"; resource: string } | null {
  const firstSeparator = key.indexOf(":");
  const secondSeparator = key.indexOf(":", firstSeparator + 1);
  if (firstSeparator <= 0 || secondSeparator <= firstSeparator) return null;
  return {
    roomName: key.slice(0, firstSeparator),
    locationKind: key.slice(firstSeparator + 1, secondSeparator) as "storage" | "terminal",
    resource: key.slice(secondSeparator + 1),
  };
}

export interface TreasuryProjectionController {
  /** 幂等查询：返回首次结算 tick（heap 本 tick 缓存 → Memory receipt）。 */
  isSettled(transactionId: string): number | undefined;
  /**
   * 完整验证（格式 → 合并 → tentative 感知物理可行性），零写入。两阶段
   * prepare 与单阶段 recordTransaction 共用；epoch 校验（stale/unknown/
   * scope）由 facade 的注册表负责；observation 参数必须是 decision 指向
   * 的 exact observation。物理基线 = decision observation + committed
   * overlay + 全部 tentative 预留（excludeTentativeKey 指定的那笔自身
   * 预留除外——同一 handle 的重复校验不得重复计算自己的 tentative）。
   */
  validateTransaction(
    input: TreasuryTransactionInput,
    decisionObservation: TreasuryObservationView,
    excludeTentativeKey?: string,
  ): { status: "valid"; shape: TreasuryValidatedTransactionShape } | { status: "invalid"; result: TreasuryRejectedResult };
  /**
   * tentative ledger 预留：prepare 验证通过后登记该 handle 的资源/容量
   * tentative delta（后续 prepare/单阶段登记的授权计算都会计入）。
   */
  tentativeHold(reservationKey: string, shape: TreasuryValidatedTransactionShape): void;
  /** abort：原子释放该 handle 的全部 tentative 预留（返回是否确有预留）。 */
  tentativeRelease(reservationKey: string): boolean;
  /** tentative key 数（gauge：资源 key 数与容量 key 数）。 */
  tentativeKeyCounts(): { resourceKeys: number; capacityKeys: number };
  /** 生命周期兜底：释放全部 tentative 预留（tick 边界作废；不动 committed 状态）。 */
  tentativeReleaseAll(): number;
  /**
   * 原子登记：输入验证 → receipt admission 预检 → 物理可行性验证（金额
   * 非负/容量不越界，含 tentative 感知）→ 一次性写入 journal + overlay +
   * heap 缓存 + Memory receipt。任一步失败零部分写入。epoch 校验由 facade
   * 的注册表负责；observation 参数必须是 decision 指向的 exact
   * observation（由 facade 从 epoch 注册表解析），本函数不回退 shared。
   */
  recordTransaction(input: TreasuryTransactionInput, decisionObservation: TreasuryObservationView): TreasurySettlementResult;
  /**
   * staged commit 第 1 段——receipt 发布（Memory 权威，先于 heap）：返回
   * 明确结果；fatal 时调用方必须进入 write-fault 处理（不得静默 no-op
   * 后继续返回 committed）。
   */
  publishPreparedReceipt(transactionId: string, tick: number): TreasuryReceiptWriteResult;
  /**
   * staged commit 第 2 段——heap 发布：journal + committed overlay + 容量
   * 聚合 + heap 幂等缓存 + tentative 兑换。faultHook 在 journal 应用前与
   * overlay 应用前调用（write-fault 注入点；抛错由调用方统一捕获）。
   */
  publishPreparedHeapState(
    canonical: TreasuryCanonicalTransaction,
    shape: TreasuryValidatedTransactionShape,
    tentativeKey: string,
    faultHook?: (phase: "journal_publish" | "overlay_publish") => void,
  ): { readonly postings: number };
  /** 本 tick 累计投影 delta（无 delta 返回 0，不回读 Game）。 */
  projectedDelta(roomName: string, locationKind: "storage" | "terminal", resource: string): number;
  /** 本 tick 该位置的容量净变化（O(1) 位置聚合，不扫描资源 overlay）。 */
  locationCapacityDelta(roomName: string, locationKind: "storage" | "terminal"): number;
  /** 单调投影版本：每次成功提交/归档/清空递增（派生缓存失效依据）。 */
  projectionRevision(): number;
  journalSnapshot(): readonly TreasuryJournalEntry[];
  /**
   * endTick 归档：返回资源投影终态（observed+delta，含 structureId）+ 房间/
   * 位置 manifest（结构生命周期对账基准）；同时把 journal 转存
   * previousJournal（有界）并清空 overlay/capacityDeltas。
   */
  archiveProjectedFinal(observation: TreasuryObservationView): TreasuryProjectedArchive;
  /** 下一 tick 两层对账：manifest 结构层 + resource key union 层。 */
  reconcile(
    previous: TreasuryProjectedArchive | undefined,
    current: TreasuryObservationView,
  ): TreasuryReconciliationSummary;
  /** 仅供测试：清空全部投影状态（journal/overlay/容量聚合/heap 缓存/previousJournal）。 */
  resetForTest(): void;
}

export interface TreasuryProjectionCallbacks {
  onDuplicateRejected?: (transactionId: string) => void;
  onInvalidRejected?: (reason: string) => void;
  onRecorded?: (entry: TreasuryJournalEntry) => void;
  onReconciliation?: (summary: TreasuryReconciliationSummary) => void;
}

export function createTreasuryProjectionController(
  options: TreasuryProjectionCallbacks,
): TreasuryProjectionController {
  const state = createTreasuryProjectionState();
  let revision = 0;

  function isSettled(transactionId: string): number | undefined {
    const heapTick = state.settledThisTick.get(transactionId);
    if (heapTick !== undefined) return heapTick;
    return hasSettledReceipt(transactionId);
  }

  function projectedDelta(
    roomName: string,
    locationKind: "storage" | "terminal",
    resource: string,
  ): number {
    return state.overlay.get(overlayKey(roomName, locationKind, resource)) ?? 0;
  }

  function locationCapacityDelta(
    roomName: string,
    locationKind: "storage" | "terminal",
  ): number {
    return state.capacityDeltas.get(treasuryLocationKey(roomName, locationKind)) ?? 0;
  }

  /**
   * tentative 总量读取（授权计算用）：全部 prepared 预留之和，可排除指定
   * handle 自己的预留（同一 handle 重复校验不得重复计算自己的 tentative）。
   */
  function effectiveTentativeResourceDelta(overlayResourceKey: string, excludeKey?: string): number {
    const total = state.tentativeResourceTotals.get(overlayResourceKey) ?? 0;
    if (total === 0 || excludeKey === undefined) return total;
    const own = state.tentativeByReservation.get(excludeKey)?.resourceDeltas.get(overlayResourceKey) ?? 0;
    return total - own;
  }

  function effectiveTentativeCapacityDelta(locationKey: string, excludeKey?: string): number {
    const total = state.tentativeCapacityTotals.get(locationKey) ?? 0;
    if (total === 0 || excludeKey === undefined) return total;
    const own = state.tentativeByReservation.get(excludeKey)?.capacityDeltas.get(locationKey) ?? 0;
    return total - own;
  }

  function tentativeHold(reservationKey: string, shape: TreasuryValidatedTransactionShape): void {
    const resourceDeltas = new Map<string, number>();
    for (const posting of shape.merged) {
      const key = overlayKey(posting.roomName, posting.locationKind, posting.resource);
      resourceDeltas.set(key, (resourceDeltas.get(key) ?? 0) + posting.delta);
      state.tentativeResourceTotals.set(key, (state.tentativeResourceTotals.get(key) ?? 0) + posting.delta);
    }
    const capacityDeltas = new Map<string, number>();
    for (const [locationKey, delta] of shape.capacityDeltaByLocation) {
      capacityDeltas.set(locationKey, delta);
      state.tentativeCapacityTotals.set(locationKey, (state.tentativeCapacityTotals.get(locationKey) ?? 0) + delta);
    }
    state.tentativeByReservation.set(reservationKey, { resourceDeltas, capacityDeltas });
  }

  function tentativeRelease(reservationKey: string): boolean {
    const reservation = state.tentativeByReservation.get(reservationKey);
    if (!reservation) return false;
    for (const [key, delta] of reservation.resourceDeltas) {
      const remaining = (state.tentativeResourceTotals.get(key) ?? 0) - delta;
      if (remaining === 0) state.tentativeResourceTotals.delete(key);
      else state.tentativeResourceTotals.set(key, remaining);
    }
    for (const [key, delta] of reservation.capacityDeltas) {
      const remaining = (state.tentativeCapacityTotals.get(key) ?? 0) - delta;
      if (remaining === 0) state.tentativeCapacityTotals.delete(key);
      else state.tentativeCapacityTotals.set(key, remaining);
    }
    state.tentativeByReservation.delete(reservationKey);
    return true;
  }

  function tentativeKeyCounts(): { resourceKeys: number; capacityKeys: number } {
    return {
      resourceKeys: state.tentativeResourceTotals.size,
      capacityKeys: state.tentativeCapacityTotals.size,
    };
  }

  function tentativeReleaseAll(): number {
    const released = state.tentativeByReservation.size;
    state.tentativeByReservation = new Map();
    state.tentativeResourceTotals = new Map();
    state.tentativeCapacityTotals = new Map();
    return released;
  }

  /**
   * 完整验证（零写入）：格式 → 同 transaction 合并（安全整数/合并溢出拒绝、
   * 净零腿剔除、全抵消 no-op 拒绝）→ tentative 感知物理可行性（容量/金额，
   * 含结果安全整数边界）。物理基线 = decision observation + 本 tick
   * committed overlay + 全部 tentative 预留（excludeTentativeKey 自身除外）。
   */
  function validateTransaction(
    input: TreasuryTransactionInput,
    decisionObservation: TreasuryObservationView,
    excludeTentativeKey?: string,
  ): TransactionValidation {
    const rejected = (reason: TreasuryRejectionReason, detail?: string): TransactionValidation => ({
      status: "invalid",
      result: { status: "rejected", reason, detail },
    });
    if (!isValidTreasuryTransactionId(input.transactionId)) {
      return rejected("invalid_transaction_id", `transactionId 不符合 Treasury 边界规范: ${String(input.transactionId)}`);
    }
    if (typeof input.kind !== "string" || input.kind.trim().length === 0 || input.kind.length > 64) {
      return rejected("invalid_kind");
    }
    if (typeof input.source !== "string" || input.source.trim().length === 0 || input.source.length > 64) {
      return rejected("invalid_source");
    }
    if (!Array.isArray(input.postings) || input.postings.length === 0) {
      return rejected("no_postings");
    }

    // ── postings 合并（同一 transaction 内同 key 多腿先合并再验证） ────────
    // delta 一律非零安全整数（NaN/Infinity/非整数/非安全整数拒绝）；
    // 合并结果超出安全整数即溢出拒绝。
    const mergedMap = new Map<string, { roomName: string; locationKind: "storage" | "terminal"; resource: string; delta: number }>();
    for (const posting of input.postings) {
      if (!posting || typeof posting !== "object") {
        return rejected("invalid_posting_delta", "posting 非对象");
      }
      if (typeof posting.roomName !== "string" || posting.roomName.length === 0) {
        return rejected("invalid_posting_room");
      }
      if (typeof posting.locationKind !== "string" || !VALID_LOCATION_KINDS.has(posting.locationKind)) {
        return rejected("invalid_posting_room", `locationKind 非法: ${String(posting.locationKind)}`);
      }
      if (typeof posting.resource !== "string" || !VALID_RESOURCES.has(posting.resource)) {
        return rejected("invalid_posting_resource", `resource 非法: ${String(posting.resource)}`);
      }
      const delta = posting.delta;
      if (typeof delta !== "number" || !Number.isSafeInteger(delta) || delta === 0) {
        return rejected("invalid_posting_delta", `delta 必须为非零安全整数: ${String(delta)}`);
      }
      const key = overlayKey(posting.roomName, posting.locationKind, posting.resource);
      const existing = mergedMap.get(key);
      if (existing) {
        const combined = existing.delta + delta;
        if (!Number.isSafeInteger(combined)) {
          return rejected("invalid_posting_delta", `合并后 delta 溢出安全整数: ${String(existing.delta)}+${String(delta)}`);
        }
        existing.delta = combined;
      } else {
        mergedMap.set(key, {
          roomName: posting.roomName,
          locationKind: posting.locationKind as "storage" | "terminal",
          resource: posting.resource,
          delta,
        });
      }
    }
    // 净零腿剔除（同 key 多腿完全抵消无物理意义）；全部抵消 → no-op
    // transaction 整笔拒绝——无物理效果的登记不得占用幂等/容量语义。
    const merged = [...mergedMap.values()].filter((posting) => posting.delta !== 0);
    if (merged.length === 0) {
      return rejected("no_op_transaction", "全部 postings 合并后净值为零（no-op transaction）");
    }

    // ── 物理可行性验证：基于 decision observation 的物理基线 + 本 tick
    //    overlay（已接受 intents）。fresh 决策不得回退 shared 基线 ─────────
    const capacityDeltaByLocation = new Map<string, number>();
    for (const posting of merged) {
      const locationKey = treasuryLocationKey(posting.roomName, posting.locationKind);
      const combined = (capacityDeltaByLocation.get(locationKey) ?? 0) + posting.delta;
      if (!Number.isSafeInteger(combined)) {
        return rejected("invalid_posting_delta", "位置容量聚合溢出安全整数");
      }
      capacityDeltaByLocation.set(locationKey, combined);
    }
    for (const [locationKey, transactionCapacityDelta] of capacityDeltaByLocation) {
      const separator = locationKey.indexOf(":");
      const roomName = locationKey.slice(0, separator);
      const locationKind = locationKey.slice(separator + 1) as "storage" | "terminal";
      if (!decisionObservation.hasRoom(roomName)) {
        return rejected("unknown_room", roomName);
      }
      const location = decisionObservation.location(roomName, locationKind);
      if (!location.exists) {
        return rejected("location_missing", locationKey);
      }
      const existingCapacityDelta =
        locationCapacityDelta(roomName, locationKind) +
        effectiveTentativeCapacityDelta(locationKey, excludeTentativeKey);
      const projectedUsed = location.usedCapacity + existingCapacityDelta + transactionCapacityDelta;
      const physicalCapacity = location.usedCapacity + location.freeCapacity;
      if (
        !Number.isSafeInteger(projectedUsed) ||
        projectedUsed < 0 ||
        projectedUsed > physicalCapacity
      ) {
        return rejected(
          "capacity_overflow",
          `${locationKey}: projectedUsed=${projectedUsed} physical=${physicalCapacity}`,
        );
      }
    }
    for (const posting of merged) {
      const base = decisionObservation.amount(posting.roomName, posting.locationKind, posting.resource);
      const existing =
        projectedDelta(posting.roomName, posting.locationKind, posting.resource) +
        effectiveTentativeResourceDelta(
          overlayKey(posting.roomName, posting.locationKind, posting.resource),
          excludeTentativeKey,
        );
      const projected = base + existing + posting.delta;
      if (!Number.isSafeInteger(projected) || projected < 0) {
        return rejected(
          "insufficient_amount",
          `${posting.roomName}:${posting.locationKind}:${posting.resource} projected=${projected}`,
        );
      }
    }
    return { status: "valid", shape: { merged, capacityDeltaByLocation } };
  }

  /**
   * 原子写入段（验证已通过/槽位已预留）：journal + overlay + 容量聚合 +
   * heap 缓存 + receipt；tentativeKey 存在时同步完成 tentative → committed
   * 兑现（该预留从 tentative ledger 移除、数值并入 committed overlay）。
   */
  /** heap 发布段：journal + committed overlay + 容量聚合 + 幂等缓存 + tentative 兑换。 */
  function applyCommittedHeapState(
    entry: TreasuryJournalEntry,
    shape: TreasuryValidatedTransactionShape,
    tentativeKey?: string,
    faultHook?: (phase: "journal_publish" | "overlay_publish") => void,
  ): number {
    faultHook?.("journal_publish");
    state.journal.push(entry);
    faultHook?.("overlay_publish");
    for (const posting of shape.merged) {
      const key = overlayKey(posting.roomName, posting.locationKind, posting.resource);
      state.overlay.set(key, (state.overlay.get(key) ?? 0) + posting.delta);
    }
    for (const [locationKey, delta] of shape.capacityDeltaByLocation) {
      state.capacityDeltas.set(locationKey, (state.capacityDeltas.get(locationKey) ?? 0) + delta);
    }
    state.settledThisTick.set(entry.transactionId, entry.recordedAtTick);
    if (tentativeKey !== undefined) tentativeRelease(tentativeKey);
    revision += 1;
    options.onRecorded?.(entry);
    return entry.postings.length;
  }

  /**
   * 原子写入段（单阶段路径；验证已通过）：receipt 先行（fatal → 整笔拒绝、
   * 零 heap 写入），成功后一次性发布 heap 状态。
   */
  function writeAcceptedTransaction(
    fields: {
      transactionId: string;
      kind: string;
      source: string;
      decisionScope: TreasuryObservationScope;
      epochSeq: number;
    },
    shape: TreasuryValidatedTransactionShape,
    tentativeKey?: string,
  ): TreasurySettlementResult {
    const tick = Game.time;
    const frozenPostings: readonly TreasuryPosting[] = Object.freeze(
      shape.merged.map((posting) =>
        Object.freeze({
          roomName: posting.roomName,
          locationKind: posting.locationKind,
          resource: posting.resource,
          delta: posting.delta,
        }),
      ),
    );
    const entry: TreasuryJournalEntry = Object.freeze({
      transactionId: fields.transactionId,
      kind: fields.kind,
      source: fields.source,
      decisionScope: fields.decisionScope,
      epochSeq: fields.epochSeq,
      recordedAtTick: tick,
      postings: frozenPostings,
    });
    const receipt = commitSettledReceipt(fields.transactionId, tick);
    if (receipt.status === "fatal") {
      // admission 已拦截 fatal store，此处防御性拒绝（零 heap 写入）。
      return { status: "rejected", reason: "receipt_store_incompatible", detail: receipt.detail };
    }
    const postings = applyCommittedHeapState(entry, shape, tentativeKey);
    return { status: "recorded", transactionId: fields.transactionId, postings, tick };
  }

  function recordTransaction(
    input: TreasuryTransactionInput,
    decisionObservation: TreasuryObservationView,
  ): TreasurySettlementResult {
    // ── 幂等优先于一切：已结算 id 的重放无论 payload 一律拒绝叠加 ──────────
    const settledAt = isSettled(input.transactionId);
    if (settledAt !== undefined) {
      options.onDuplicateRejected?.(input.transactionId);
      return { status: "already_settled", transactionId: input.transactionId, firstRecordedAtTick: settledAt };
    }

    // ── receipt admission 预检：满容/版本不兼容时整笔拒绝，必须发生在写入
    //    journal/overlay/heap 缓存/Memory receipt 任何状态之前 ─────────────
    const admission = admitTreasuryReceipt(input.transactionId, Game.time);
    if (admission.status === "already_settled") {
      // migration 后 admission 才能看到的已结算 id（heap isSettled 未命中）。
      options.onDuplicateRejected?.(input.transactionId);
      return { status: "already_settled", transactionId: input.transactionId, firstRecordedAtTick: admission.firstSettledAtTick };
    }
    if (admission.status === "rejected") {
      options.onInvalidRejected?.(admission.reason);
      return { status: "rejected", reason: admission.reason, detail: admission.detail };
    }

    // 单阶段路径的物理验证计入全部 tentative 预留——不得抢占已被 prepared
    // transaction 预留的资源或容量（admission 的满容判定同样计入 pending）。
    const validation = validateTransaction(input, decisionObservation);
    if (validation.status === "invalid") {
      options.onInvalidRejected?.(validation.result.reason);
      return validation.result;
    }
    return writeAcceptedTransaction(
      {
        transactionId: input.transactionId,
        kind: input.kind,
        source: input.source,
        decisionScope: input.decision.scope,
        epochSeq: input.decision.epochSeq,
      },
      validation.shape,
    );
  }

  /** staged commit 第 1 段：receipt 发布（Memory 权威，先于 heap）。 */
  function publishPreparedReceipt(transactionId: string, tick: number): TreasuryReceiptWriteResult {
    return commitSettledReceipt(transactionId, tick);
  }

  /** staged commit 第 2 段：heap 发布（faultHook 为 write-fault 注入点）。 */
  function publishPreparedHeapState(
    canonical: TreasuryCanonicalTransaction,
    shape: TreasuryValidatedTransactionShape,
    tentativeKey: string,
    faultHook?: (phase: "journal_publish" | "overlay_publish") => void,
  ): { readonly postings: number } {
    const frozenPostings: readonly TreasuryPosting[] = Object.freeze(
      shape.merged.map((posting) =>
        Object.freeze({
          roomName: posting.roomName,
          locationKind: posting.locationKind,
          resource: posting.resource,
          delta: posting.delta,
        }),
      ),
    );
    const entry: TreasuryJournalEntry = Object.freeze({
      transactionId: canonical.transactionId,
      kind: canonical.kind,
      source: canonical.source,
      decisionScope: canonical.decisionScope,
      epochSeq: canonical.decisionEpochSeq,
      recordedAtTick: Game.time,
      postings: frozenPostings,
    });
    const postings = applyCommittedHeapState(entry, shape, tentativeKey, faultHook);
    return { postings };
  }

  function journalSnapshot(): readonly TreasuryJournalEntry[] {
    return Object.freeze([...state.journal]);
  }

  function buildManifest(observation: TreasuryObservationView): TreasuryTickManifest {
    const rooms: string[] = [];
    const locations: TreasuryLocationManifestEntry[] = [];
    for (const room of observation.data.rooms) {
      rooms.push(room.roomName);
      for (const location of [room.storage, room.terminal]) {
        const delta = location.exists
          ? state.capacityDeltas.get(treasuryLocationKey(location.roomName, location.kind)) ?? 0
          : 0;
        locations.push(
          Object.freeze({
            roomName: location.roomName,
            locationKind: location.kind,
            exists: location.exists,
            structureId: location.structureId,
            // manifest 容量为投影终态口径（observed ± 本 tick 已接受 delta）。
            usedCapacity: location.exists ? location.usedCapacity + delta : 0,
            freeCapacity: location.exists ? location.freeCapacity - delta : 0,
          }),
        );
      }
    }
    return Object.freeze({ tick: Game.time, rooms: Object.freeze(rooms), locations: Object.freeze(locations) });
  }

  function archiveProjectedFinal(observation: TreasuryObservationView): TreasuryProjectedArchive {
    const finals = new Map<string, TreasuryProjectedFinal>();
    const seenKeys = new Set<string>();
    // 第一遍：观察到的每位置/每非零资源 key 归档（base+delta，含 structureId）。
    for (const room of observation.data.rooms) {
      for (const location of [room.storage, room.terminal]) {
        for (const resource of Object.keys(location.amounts)) {
          const key = overlayKey(location.roomName, location.kind, resource);
          seenKeys.add(key);
          const base = location.amounts[resource] ?? 0;
          const delta = state.overlay.get(key) ?? 0;
          if (base !== 0 || delta !== 0) {
            finals.set(key, {
              roomName: location.roomName,
              locationKind: location.kind,
              resource,
              amount: base + delta,
              structureId: location.structureId,
            });
          }
        }
      }
    }
    // 第二遍（单次 overlay 遍历）：兜底归档观察未覆盖的 key——资源归零
    // （base=0 不在稀疏 amounts）或房间/位置已丢失（物理归零，对账时
    // observedNow=0 与 final 的差异即流出信号，保证对账无静默缺口）。
    for (const [key, delta] of state.overlay) {
      if (seenKeys.has(key) || delta === 0) continue;
      const parsed = parseOverlayKey(key);
      if (!parsed) continue;
      const location = observation.location(parsed.roomName, parsed.locationKind);
      finals.set(key, {
        roomName: parsed.roomName,
        locationKind: parsed.locationKind,
        resource: parsed.resource,
        amount: (location.amounts[parsed.resource] ?? 0) + delta,
        structureId: location.structureId,
      });
    }

    const manifest = buildManifest(observation);
    // journal 转存有界追溯副本；overlay/容量聚合/本 tick 缓存切换前清空。
    state.previousJournal =
      state.journal.length > PREVIOUS_JOURNAL_CAP
        ? Object.freeze(state.journal.slice(0, PREVIOUS_JOURNAL_CAP))
        : Object.freeze([...state.journal]);
    state.journal = [];
    state.overlay = new Map();
    state.capacityDeltas = new Map();
    state.settledThisTick = new Map();
    revision += 1;
    return { tick: Game.time, finals, manifest };
  }

  function traceTransactionsFor(key: string): { ids: string[]; kinds: string[] } {
    const ids: string[] = [];
    const kinds: string[] = [];
    const parsed = parseOverlayKey(key);
    if (!parsed) return { ids, kinds };
    for (const entry of state.previousJournal) {
      const touches = entry.postings.some(
        (posting) =>
          posting.roomName === parsed.roomName &&
          posting.locationKind === parsed.locationKind &&
          posting.resource === parsed.resource,
      );
      if (touches) {
        ids.push(entry.transactionId);
        kinds.push(entry.kind);
        if (ids.length >= RECONCILIATION_TRACE_TRANSACTION_CAP) break;
      }
    }
    return { ids, kinds };
  }

  function reconcile(
    previous: TreasuryProjectedArchive | undefined,
    current: TreasuryObservationView,
  ): TreasuryReconciliationSummary {
    const currentTick = Game.time;
    if (!previous) {
      return Object.freeze({
        previousTick: null,
        currentTick,
        tickGap: false,
        afterGlobalReset: false,
        checkedEntries: 0,
        inflowMismatches: 0,
        outflowMismatches: 0,
        structuralChanges: 0,
        samples: Object.freeze([]),
      });
    }

    const tickGap = previous.tick !== currentTick - 1;
    let checkedEntries = 0;
    let inflow = 0;
    let outflow = 0;
    let structural = 0;
    const samples: TreasuryReconciliationSample[] = [];
    const prev = previous;

    const pushStructureSample = (
      roomName: string,
      locationKind: TreasuryLocationKind,
      category: TreasuryReconciliationCategory,
      previousStructureId: string | undefined,
      currentStructureId: string | undefined,
    ) => {
      if (samples.length >= RECONCILIATION_SAMPLE_CAP) return;
      samples.push(
        Object.freeze({
          tick: prev.tick,
          roomName,
          locationKind,
          resource: "",
          projectedFinal: 0,
          observedNow: 0,
          diff: 0,
          category,
          previousStructureId,
          currentStructureId,
          transactionIds: Object.freeze([]),
          transactionKinds: Object.freeze([]),
          dimension: "structure",
        }),
      );
    };

    const pushResourceSample = (
      key: string,
      final: TreasuryProjectedFinal | undefined,
      observedNow: number,
      category: TreasuryReconciliationCategory,
    ) => {
      if (samples.length >= RECONCILIATION_SAMPLE_CAP) return;
      const trace = traceTransactionsFor(key);
      const parsed = parseOverlayKey(key);
      samples.push(
        Object.freeze({
          tick: prev.tick,
          roomName: final?.roomName ?? parsed?.roomName ?? key,
          locationKind: final?.locationKind ?? parsed?.locationKind ?? "storage",
          resource: final?.resource ?? parsed?.resource ?? "",
          projectedFinal: final?.amount ?? 0,
          observedNow,
          diff: observedNow - (final?.amount ?? 0),
          category,
          previousStructureId: final?.structureId,
          currentStructureId: undefined,
          transactionIds: Object.freeze(trace.ids),
          transactionKinds: Object.freeze(trace.kinds),
          dimension: "resource",
        }),
      );
    };

    // ── 第一层：manifest 结构对账（每位置至多一条事件） ─────────────────────
    const previousRooms = new Set<string>(prev.manifest.rooms);
    const previousLocations = new Map<string, TreasuryLocationManifestEntry>();
    for (const entry of prev.manifest.locations) {
      previousLocations.set(treasuryLocationKey(entry.roomName, entry.locationKind), entry);
    }
    const currentRooms = new Set<string>(current.roomNames());
    const currentLocations = new Map<string, { exists: boolean; structureId: string | undefined }>();
    for (const room of current.data.rooms) {
      for (const location of [room.storage, room.terminal]) {
        currentLocations.set(
          treasuryLocationKey(location.roomName, location.kind),
          { exists: location.exists, structureId: location.structureId },
        );
      }
    }
    checkedEntries += previousLocations.size;

    // 房间维度：丢失/新建（含无任何结构的空房间——稀疏资源层不可见）。
    for (const roomName of previousRooms) {
      if (!currentRooms.has(roomName)) {
        structural += 1;
        pushStructureSample(roomName, "storage", "room_lost", undefined, undefined);
      }
    }
    for (const roomName of currentRooms) {
      if (!previousRooms.has(roomName)) {
        structural += 1;
        pushStructureSample(roomName, "storage", "new_room", undefined, undefined);
      }
    }
    // 位置维度（房间仍存在的位置变化；房间级事件已单独计数）。
    for (const [locationKey, prevEntry] of previousLocations) {
      if (!currentRooms.has(prevEntry.roomName)) continue; // 房间丢失已计
      const currentEntry = currentLocations.get(locationKey);
      const currentExists = currentEntry?.exists ?? false;
      if (!prevEntry.exists && !currentExists) continue;
      if (!prevEntry.exists && currentExists) {
        structural += 1;
        pushStructureSample(prevEntry.roomName, prevEntry.locationKind, "new_location", undefined, currentEntry?.structureId);
        continue;
      }
      if (prevEntry.exists && !currentExists) {
        structural += 1;
        pushStructureSample(prevEntry.roomName, prevEntry.locationKind, "location_lost", prevEntry.structureId, undefined);
        continue;
      }
      if (prevEntry.structureId !== currentEntry?.structureId) {
        // 每位置计一次（金额一致也记录 incarnation 变化）；不随资源数重复。
        structural += 1;
        pushStructureSample(prevEntry.roomName, prevEntry.locationKind, "structure_replaced", prevEntry.structureId, currentEntry?.structureId);
      }
    }

    // ── 第二层：resource key union 数量对账（按资源维度独立计数） ──────────
    const observedNow = new Map<string, number>();
    for (const room of current.data.rooms) {
      for (const location of [room.storage, room.terminal]) {
        for (const resource of Object.keys(location.amounts)) {
          observedNow.set(overlayKey(location.roomName, location.kind, resource), location.amounts[resource] ?? 0);
        }
      }
    }
    const keyUnion = new Set<string>([...previous.finals.keys(), ...observedNow.keys()]);

    for (const key of keyUnion) {
      checkedEntries += 1;
      const final = previous.finals.get(key);
      const observed = observedNow.get(key);
      if (!parseOverlayKey(key)) continue;

      if (final === undefined) {
        // previous 无此资源 key：外部新增（新房间/新位置带来的结构事件由
        // manifest 层负责，此处只按资源维度计一次流入）。
        inflow += 1;
        pushResourceSample(key, undefined, observed ?? 0, "new_resource");
        continue;
      }
      const actual = observed ?? 0;
      const diff = actual - final.amount;
      if (diff > 0) {
        inflow += 1;
        pushResourceSample(key, final, actual, "inflow");
      } else if (diff < 0) {
        // 结构丢失（位置摧毁/房间丢失）由 manifest 层计数；资源层只计数量差异。
        outflow += 1;
        pushResourceSample(key, final, actual, "outflow");
      }
      // diff === 0：无资源维度事件。
    }

    const summary: TreasuryReconciliationSummary = Object.freeze({
      previousTick: previous.tick,
      currentTick,
      tickGap,
      afterGlobalReset: false,
      checkedEntries,
      inflowMismatches: inflow,
      outflowMismatches: outflow,
      structuralChanges: structural,
      samples: Object.freeze(samples),
    });
    options.onReconciliation?.(summary);
    return summary;
  }

  function resetForTest(): void {
    state.journal = [];
    state.overlay = new Map();
    state.capacityDeltas = new Map();
    state.settledThisTick = new Map();
    state.previousJournal = [];
    state.tentativeByReservation = new Map();
    state.tentativeResourceTotals = new Map();
    state.tentativeCapacityTotals = new Map();
    releaseAllTreasuryReceiptReservations();
    revision += 1;
  }

  return {
    isSettled,
    validateTransaction,
    tentativeHold,
    tentativeRelease,
    tentativeKeyCounts,
    tentativeReleaseAll,
    recordTransaction,
    publishPreparedReceipt,
    publishPreparedHeapState,
    projectedDelta,
    locationCapacityDelta,
    projectionRevision: () => revision,
    journalSnapshot,
    archiveProjectedFinal,
    reconcile,
    resetForTest,
  };
}

/** 兼容导出：epoch 只读类型供外部签名引用。 */
export type { TreasuryEpoch };
