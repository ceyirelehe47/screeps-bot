/**
 * Treasury Transaction Journal + Projected Overlay + Reconciler。
 *
 * 语义约束：
 * - 一个已接受动作 = 一个 transaction（唯一幂等 id）+ 一或多腿 posting，
 *   所有 posting 整体验证、一次性原子写入；任一 posting 非法则整笔回滚，
 *   绝不出现部分写入；
 * - 幂等三段：heap 本 tick 缓存 → Memory receipt（跨 tick / global reset
 *   权威）→ 已结算 id 一律拒绝重复叠加；
 * - Observed 数值永不修改：投影只叠加在 overlay 上，容量投影与资源投影
 *   同步推进（used/free 随 delta 净变化）；
 * - endTick 归档投影终态（含 structureId），下一 tick beginTick 用
 *   previous-finals 与 current-observed 的 key 并集对账：外部流入/流出、
 *   新资源/新位置/新房间、房间/位置丢失、结构 incarnation 替换、tick gap
 *   与 global reset 全部显式分类，不静默；
 * - journal（本 tick 明细 + 上一 tick 追溯副本）只在 heap，绝不持久化。
 */

import {
  type TreasuryEpoch,
  type TreasuryJournalEntry,
  type TreasuryObservationView,
  type TreasuryPosting,
  type TreasuryProjectedFinal,
  type TreasuryReconciliationCategory,
  type TreasuryReconciliationSample,
  type TreasuryReconciliationSummary,
  type TreasuryRejectionReason,
  type TreasurySettlementResult,
  type TreasuryTransactionInput,
  treasuryLocationKey,
} from "@/runtime/treasury/types";
import { isValidTreasuryTransactionId } from "@/runtime/treasury/transactionId";
import { hasSettledReceipt, recordSettledReceipt } from "@/runtime/treasury/receipts";

const RECONCILIATION_SAMPLE_CAP = 16;
const RECONCILIATION_TRACE_TRANSACTION_CAP = 4;
/** 上一 tick journal 追溯副本上限（防洪峰 heap 膨胀；只截断追溯，不影响数值对账）。 */
const PREVIOUS_JOURNAL_CAP = 512;

const VALID_RESOURCES: ReadonlySet<string> = new Set<string>(RESOURCES_ALL);
const VALID_LOCATION_KINDS: ReadonlySet<string> = new Set<string>(["storage", "terminal"]);

export interface TreasuryProjectionState {
  /** 本 tick journal（endTick 归档时转存 previousJournal 并清空）。 */
  journal: TreasuryJournalEntry[];
  /** locationKey:resource → 累计 delta（本 tick）。 */
  overlay: Map<string, number>;
  /** 本 tick 已结算 transactionId → tick（heap 加速；跨 tick 权威在 Memory receipt）。 */
  settledThisTick: Map<string, number>;
  /** 上一 tick journal 有界副本（对账追溯用）。 */
  previousJournal: readonly TreasuryJournalEntry[];
}

export function createTreasuryProjectionState(): TreasuryProjectionState {
  return { journal: [], overlay: new Map(), settledThisTick: new Map(), previousJournal: [] };
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
   * 原子登记：输入验证 → 物理可行性验证（金额非负/容量不越界）→ 一次性写入
   * journal + overlay + heap 缓存 + Memory receipt。任一步失败零部分写入。
   * epoch 校验（stale/unknown/scope）由 facade 的注册表负责，此处不再复核。
   */
  recordTransaction(input: TreasuryTransactionInput, observation: TreasuryObservationView): TreasurySettlementResult;
  /** 本 tick 累计投影 delta（无 delta 返回 0，不回读 Game）。 */
  projectedDelta(roomName: string, locationKind: "storage" | "terminal", resource: string): number;
  /** 本 tick 该位置的容量净变化（Σ资源 delta；供 projected capacity）。 */
  locationCapacityDelta(roomName: string, locationKind: "storage" | "terminal"): number;
  journalSnapshot(): readonly TreasuryJournalEntry[];
  /**
   * endTick 归档：返回 (observed+delta) 终态快照（含 structureId）供下一 tick
   * 对账；同时把 journal 转存 previousJournal（有界）并清空 overlay。
   */
  archiveProjectedFinal(observation: TreasuryObservationView): Map<string, TreasuryProjectedFinal>;
  /** 下一 tick 对账：previous finals vs current observed 的 key 并集。 */
  reconcile(
    previous: { tick: number; finals: Map<string, TreasuryProjectedFinal> } | undefined,
    current: TreasuryObservationView,
  ): TreasuryReconciliationSummary;
  /** 仅供测试：清空全部投影状态（journal/overlay/heap 缓存/previousJournal）。 */
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
    const prefix = `${treasuryLocationKey(roomName, locationKind)}:`;
    let total = 0;
    for (const [key, delta] of state.overlay) {
      if (key.startsWith(prefix)) total += delta;
    }
    return total;
  }

  function recordTransaction(
    input: TreasuryTransactionInput,
    observation: TreasuryObservationView,
  ): TreasurySettlementResult {
    // ── 幂等优先于验证：已结算 id 的重放无论 payload 一律拒绝叠加 ──────────
    const settledAt = isSettled(input.transactionId);
    if (settledAt !== undefined) {
      options.onDuplicateRejected?.(input.transactionId);
      return { status: "already_settled", transactionId: input.transactionId, firstRecordedAtTick: settledAt };
    }

    // ── 输入格式验证（零写入，失败即返回） ──────────────────────────────────
    const rejected = (reason: TreasuryRejectionReason, detail?: string): TreasurySettlementResult => {
      options.onInvalidRejected?.(reason);
      return { status: "rejected", reason, detail };
    };
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
    const merged = new Map<string, { roomName: string; locationKind: "storage" | "terminal"; resource: string; delta: number }>();
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
      if (typeof delta !== "number" || !Number.isInteger(delta) || delta === 0) {
        return rejected("invalid_posting_delta", `delta 必须为非零有限整数: ${String(delta)}`);
      }
      const key = overlayKey(posting.roomName, posting.locationKind, posting.resource);
      const existing = merged.get(key);
      if (existing) {
        existing.delta += delta;
      } else {
        merged.set(key, {
          roomName: posting.roomName,
          locationKind: posting.locationKind as "storage" | "terminal",
          resource: posting.resource,
          delta,
        });
      }
    }
    // 合并后净值为零的多腿（完全抵消）不再产生物理变化，但交易仍合法记账。

    // ── 物理可行性验证（金额非负 / 位置存在 / 容量不越界） ──────────────────
    const capacityDeltaByLocation = new Map<string, number>();
    for (const posting of merged.values()) {
      const locationKey = treasuryLocationKey(posting.roomName, posting.locationKind);
      capacityDeltaByLocation.set(
        locationKey,
        (capacityDeltaByLocation.get(locationKey) ?? 0) + posting.delta,
      );
    }
    for (const [locationKey, transactionCapacityDelta] of capacityDeltaByLocation) {
      const separator = locationKey.indexOf(":");
      const roomName = locationKey.slice(0, separator);
      const locationKind = locationKey.slice(separator + 1) as "storage" | "terminal";
      if (!observation.hasRoom(roomName)) {
        return rejected("unknown_room", roomName);
      }
      const location = observation.location(roomName, locationKind);
      if (!location.exists) {
        return rejected("location_missing", locationKey);
      }
      const existingCapacityDelta = locationCapacityDelta(roomName, locationKind);
      const projectedUsed = location.usedCapacity + existingCapacityDelta + transactionCapacityDelta;
      const physicalCapacity = location.usedCapacity + location.freeCapacity;
      if (projectedUsed < 0 || projectedUsed > physicalCapacity) {
        return rejected(
          "capacity_overflow",
          `${locationKey}: projectedUsed=${projectedUsed} physical=${physicalCapacity}`,
        );
      }
    }
    for (const posting of merged.values()) {
      const base = observation.amount(posting.roomName, posting.locationKind, posting.resource);
      const existing = projectedDelta(posting.roomName, posting.locationKind, posting.resource);
      if (base + existing + posting.delta < 0) {
        return rejected(
          "insufficient_amount",
          `${posting.roomName}:${posting.locationKind}:${posting.resource} projected=${base + existing + posting.delta}`,
        );
      }
    }

    // ── 原子写入：journal + overlay + heap 缓存 + Memory receipt ────────────
    const tick = Game.time;
    const frozenPostings: readonly TreasuryPosting[] = Object.freeze(
      input.postings.map((posting) =>
        Object.freeze({
          roomName: posting.roomName,
          locationKind: posting.locationKind,
          resource: posting.resource,
          delta: posting.delta,
        }),
      ),
    );
    const entry: TreasuryJournalEntry = Object.freeze({
      transactionId: input.transactionId,
      kind: input.kind,
      source: input.source,
      decisionScope: input.decision.scope,
      epochSeq: input.decision.epochSeq,
      recordedAtTick: tick,
      postings: frozenPostings,
    });
    state.journal.push(entry);
    for (const posting of merged.values()) {
      const key = overlayKey(posting.roomName, posting.locationKind, posting.resource);
      state.overlay.set(key, (state.overlay.get(key) ?? 0) + posting.delta);
    }
    state.settledThisTick.set(input.transactionId, tick);
    recordSettledReceipt(input.transactionId, tick);
    options.onRecorded?.(entry);
    return { status: "recorded", transactionId: input.transactionId, postings: frozenPostings.length, tick };
  }

  function journalSnapshot(): readonly TreasuryJournalEntry[] {
    return Object.freeze([...state.journal]);
  }

  function archiveProjectedFinal(observation: TreasuryObservationView) {
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

    // journal 转存有界追溯副本；overlay/本 tick 缓存切换前清空。
    state.previousJournal =
      state.journal.length > PREVIOUS_JOURNAL_CAP
        ? Object.freeze(state.journal.slice(0, PREVIOUS_JOURNAL_CAP))
        : Object.freeze([...state.journal]);
    state.journal = [];
    state.overlay = new Map();
    state.settledThisTick = new Map();
    return finals;
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
    previous: { tick: number; finals: Map<string, TreasuryProjectedFinal> } | undefined,
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

    const pushSample = (
      key: string,
      final: TreasuryProjectedFinal | undefined,
      observedNow: number,
      category: TreasuryReconciliationCategory,
      currentStructureId: string | undefined,
    ) => {
      if (samples.length >= RECONCILIATION_SAMPLE_CAP) return;
      const trace = traceTransactionsFor(key);
      samples.push(
        Object.freeze({
          tick: prev.tick,
          roomName: final?.roomName ?? parseOverlayKey(key)?.roomName ?? key,
          locationKind: final?.locationKind ?? parseOverlayKey(key)?.locationKind ?? "storage",
          resource: final?.resource ?? parseOverlayKey(key)?.resource ?? "",
          projectedFinal: final?.amount ?? 0,
          observedNow,
          diff: observedNow - (final?.amount ?? 0),
          category,
          previousStructureId: final?.structureId,
          currentStructureId,
          transactionIds: Object.freeze(trace.ids),
          transactionKinds: Object.freeze(trace.kinds),
        }),
      );
    };

    // key 并集：previous finals ∪ current observed 非零资源。
    const observedNow = new Map<string, number>();
    for (const room of current.data.rooms) {
      for (const location of [room.storage, room.terminal]) {
        for (const resource of Object.keys(location.amounts)) {
          observedNow.set(overlayKey(location.roomName, location.kind, resource), location.amounts[resource] ?? 0);
        }
      }
    }
    const keyUnion = new Set<string>([...previous.finals.keys(), ...observedNow.keys()]);

    const previousRooms = new Set<string>();
    const previousLiveLocations = new Set<string>();
    for (const final of previous.finals.values()) {
      previousRooms.add(final.roomName);
      if (final.structureId !== undefined) {
        previousLiveLocations.add(treasuryLocationKey(final.roomName, final.locationKind));
      }
    }

    for (const key of keyUnion) {
      checkedEntries += 1;
      const final = previous.finals.get(key);
      const observed = observedNow.get(key);
      const parsed = parseOverlayKey(key);
      if (!parsed) continue;

      const currentLocation = current.location(parsed.roomName, parsed.locationKind);
      const currentStructureId = currentLocation.exists ? currentLocation.structureId : undefined;
      const actual = observed ?? 0;
      const diff = actual - (final?.amount ?? 0);
      const structureChanged = (final?.structureId ?? "") !== (currentStructureId ?? "");

      if (diff === 0 && !structureChanged) continue;

      if (final === undefined) {
        // previous 无此 key 且 observedNow 只含非零值：外部新增必然 diff>0。
        const category: TreasuryReconciliationCategory = !previousRooms.has(parsed.roomName)
          ? "new_room"
          : !previousLiveLocations.has(treasuryLocationKey(parsed.roomName, parsed.locationKind))
            ? "new_location"
            : "new_resource";
        inflow += 1;
        pushSample(key, undefined, actual, category, currentStructureId);
        continue;
      }

      if (structureChanged) {
        structural += 1;
        pushSample(key, final, actual, "structure_replaced", currentStructureId);
      }

      if (diff > 0) {
        inflow += 1;
        pushSample(key, final, actual, "inflow", currentStructureId);
        continue;
      }
      if (diff < 0) {
        // 流出细分：房间丢失 / 位置丢失 / 资源减少（含归零）。
        outflow += 1;
        const category: TreasuryReconciliationCategory = !current.hasRoom(parsed.roomName)
          ? "room_lost"
          : !current.locationExists(parsed.roomName, parsed.locationKind)
            ? "location_lost"
            : "outflow";
        pushSample(key, final, actual, category, currentStructureId);
      }
      // diff === 0 且 structureChanged：结构替换已显式记录，无金额差异。
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
    state.settledThisTick = new Map();
    state.previousJournal = [];
  }

  return {
    isSettled,
    recordTransaction,
    projectedDelta,
    locationCapacityDelta,
    journalSnapshot,
    archiveProjectedFinal,
    reconcile,
    resetForTest,
  };
}

/** 兼容导出：epoch 只读类型供外部签名引用。 */
export type { TreasuryEpoch };
