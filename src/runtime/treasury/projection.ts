/**
 * Treasury Transaction Journal + Projected Overlay + Reconciler。
 *
 * 语义约束：
 * - 只有调用方在 Game API 返回 OK 后显式登记的动作才产生投影增量；
 *   计划、reservation、pending task 一律不得进入 journal；
 * - actionId 幂等：同 tick 或跨 tick（FIFO 窗口内）重复登记一律拒绝；
 * - stale epoch 拒绝写入（登记必须基于当前 tick 的 observation）；
 * - Observed 数值永不修改：投影只叠加在 overlay 上；
 * - 下一 tick 构建观察时对账上一 tick 投影终态，差异计数+样本，不静默。
 */

import {
  type TreasuryEpoch,
  type TreasuryJournalEntry,
  type TreasuryObservationView,
  type TreasuryRecordActionInput,
  type TreasuryRecordActionResult,
  type TreasuryReconciliationSample,
  type TreasuryReconciliationSummary,
  treasuryLocationKey,
} from "@/runtime/treasury/types";

const SETTLED_ACTION_WINDOW = 512;

export interface TreasuryProjectionState {
  /** 本 tick journal（tick 切换时归档进 reconciliation 后清空）。 */
  journal: TreasuryJournalEntry[];
  /** locationKey:resource → 累计 delta（本 tick）。 */
  overlay: Map<string, number>;
  /** actionId → 首次结算 tick（FIFO cap，跨 tick 幂等窗口）。 */
  settledActionIds: Map<string, number>;
}

export function createTreasuryProjectionState(): TreasuryProjectionState {
  return { journal: [], overlay: new Map(), settledActionIds: new Map() };
}

function overlayKey(roomName: string, locationKind: string, resource: string): string {
  return `${treasuryLocationKey(roomName, locationKind as "storage" | "terminal")}:${resource}`;
}

export interface TreasuryProjectionController {
  record(
    input: TreasuryRecordActionInput,
    currentEpoch: TreasuryEpoch,
  ): TreasuryRecordActionResult;
  /** 本 tick 累计投影 delta（无 delta 返回 0，不回读 Game）。 */
  projectedDelta(roomName: string, locationKind: "storage" | "terminal", resource: string): number;
  journalSnapshot(): readonly TreasuryJournalEntry[];
  /** tick 结束归档：返回 (observed+delta) 终态快照供下一 tick 对账。 */
  archiveProjectedFinal(
    observation: TreasuryObservationView,
  ): Map<string, { roomName: string; locationKind: "storage" | "terminal"; resource: string; amount: number }>;
  /** 下一 tick 对账：previous 为上一 tick 终态快照（含当时 tick 号）。 */
  reconcile(
    previous: { tick: number; finals: Map<string, { roomName: string; locationKind: "storage" | "terminal"; resource: string; amount: number }> } | undefined,
    current: TreasuryObservationView,
  ): TreasuryReconciliationSummary;
  /** 归档后重置 journal/overlay（settledActionIds 保留跨 tick 幂等窗口）。 */
  beginNextTick(): void;
}

export interface TreasuryReconcileCounters {
  inflow: number;
  outflow: number;
  checked: number;
  samples: TreasuryReconciliationSample[];
}

const RECONCILIATION_SAMPLE_CAP = 16;

export function createTreasuryProjectionController(options: {
  onDuplicateRejected?: (actionId: string) => void;
  onStaleRejected?: (observedAtTick: number) => void;
  onRecorded?: (entry: TreasuryJournalEntry) => void;
  onReconciliation?: (summary: TreasuryReconciliationSummary) => void;
}): TreasuryProjectionController {
  const state = createTreasuryProjectionState();

  function record(
    input: TreasuryRecordActionInput,
    currentEpoch: TreasuryEpoch,
  ): TreasuryRecordActionResult {
    if (currentEpoch.observedAtTick !== Game.time) {
      options.onStaleRejected?.(currentEpoch.observedAtTick);
      return { status: "stale_epoch", observedAtTick: currentEpoch.observedAtTick };
    }
    const firstTick = state.settledActionIds.get(input.actionId);
    if (firstTick !== undefined) {
      options.onDuplicateRejected?.(input.actionId);
      return { status: "already_settled", actionId: input.actionId, firstRecordedAtTick: firstTick };
    }

    const entry: TreasuryJournalEntry = Object.freeze({
      actionId: input.actionId,
      kind: input.kind,
      roomName: input.roomName,
      locationKind: input.locationKind,
      resource: input.resource,
      delta: input.delta,
      recordedAtTick: Game.time,
      epochSeq: currentEpoch.epochSeq,
      source: input.source,
    });
    state.settledActionIds.set(input.actionId, Game.time);
    if (state.settledActionIds.size > SETTLED_ACTION_WINDOW) {
      const oldest = state.settledActionIds.keys().next().value;
      if (oldest !== undefined) state.settledActionIds.delete(oldest);
    }
    state.journal.push(entry);
    const key = overlayKey(input.roomName, input.locationKind, input.resource);
    state.overlay.set(key, (state.overlay.get(key) ?? 0) + input.delta);
    options.onRecorded?.(entry);
    return { status: "recorded", entry };
  }

  function projectedDelta(
    roomName: string,
    locationKind: "storage" | "terminal",
    resource: string,
  ): number {
    return state.overlay.get(overlayKey(roomName, locationKind, resource)) ?? 0;
  }

  function journalSnapshot(): readonly TreasuryJournalEntry[] {
    return state.journal;
  }

  function archiveProjectedFinal(observation: TreasuryObservationView) {
    const finals = new Map<
      string,
      { roomName: string; locationKind: "storage" | "terminal"; resource: string; amount: number }
    >();
    const seenKeys = new Set<string>();
    // 第一遍：观察到的每位置/每非零资源 key 归档（base+delta）。
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
      const separator = key.indexOf(":");
      const secondSeparator = key.indexOf(":", separator + 1);
      const roomName = key.slice(0, separator);
      const locationKind = key.slice(separator + 1, secondSeparator) as "storage" | "terminal";
      const resource = key.slice(secondSeparator + 1);
      const base = observation.location(roomName, locationKind).amounts[resource] ?? 0;
      finals.set(key, {
        roomName,
        locationKind,
        resource,
        amount: base + delta,
      });
    }
    return finals;
  }

  function reconcile(
    previous:
      | {
          tick: number;
          finals: Map<
            string,
            { roomName: string; locationKind: "storage" | "terminal"; resource: string; amount: number }
          >;
        }
      | undefined,
    current: TreasuryObservationView,
  ): TreasuryReconciliationSummary {
    if (!previous) {
      return {
        previousTick: null,
        checkedEntries: 0,
        inflowMismatches: 0,
        outflowMismatches: 0,
        samples: [],
      };
    }

    const counters: TreasuryReconcileCounters = { inflow: 0, outflow: 0, checked: 0, samples: [] };
    const observedNow = new Map<string, number>();
    for (const room of current.data.rooms) {
      for (const location of [room.storage, room.terminal]) {
        for (const resource of Object.keys(location.amounts)) {
          observedNow.set(overlayKey(location.roomName, location.kind, resource), location.amounts[resource] ?? 0);
        }
      }
    }

    for (const [key, final] of previous.finals) {
      counters.checked += 1;
      const actual = observedNow.get(key) ?? 0;
      const diff = actual - final.amount;
      if (diff === 0) continue;
      if (diff > 0) counters.inflow += 1;
      else counters.outflow += 1;
      if (counters.samples.length < RECONCILIATION_SAMPLE_CAP) {
        counters.samples.push(
          Object.freeze({
            tick: previous.tick,
            roomName: final.roomName,
            locationKind: final.locationKind,
            resource: final.resource,
            projectedFinal: final.amount,
            observedNow: actual,
            diff,
          }),
        );
      }
    }

    const summary: TreasuryReconciliationSummary = Object.freeze({
      previousTick: previous.tick,
      checkedEntries: counters.checked,
      inflowMismatches: counters.inflow,
      outflowMismatches: counters.outflow,
      samples: Object.freeze(counters.samples),
    });
    options.onReconciliation?.(summary);
    return summary;
  }

  function beginNextTick(): void {
    state.journal = [];
    state.overlay = new Map();
  }

  return {
    record,
    projectedDelta,
    journalSnapshot,
    archiveProjectedFinal,
    reconcile,
    beginNextTick,
  };
}
