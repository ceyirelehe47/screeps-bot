/**
 * Treasury Shadow——新旧物理库存对比（零行为写入）。
 *
 * 对比通道（相互独立，防同源错误）：
 * 1. Treasury observation vs 旧 empireInventoryIndex core 视图（旧消费者未来源）；
 * 2. Treasury observation vs 独立直读（Object.keys 一次/结构——最终真值）；
 * 3. 结构性检查：缺失位置、stale epoch、承诺索引自洽（索引聚合 = 任务表
 *    逐条重算，检测重复计数）。
 *
 * 约束：低频采样（默认 40 tick，可 force）；不执行任何 Game intent 写入、
 * 市场动作或任务状态变更；mismatch 进有界环形缓冲与聚合计数；指标低频
 * 快照至 Memory.runtime.treasuryPerf（沿用 inventoryPerf 未类型化断言先例）。
 */

import { getEmpireInventoryCore } from "@/runtime/empireInventoryIndex";
import type { TreasuryService } from "@/runtime/treasury/facade";
import {
  type TreasuryObservationView,
  type TreasuryLocationKind,
} from "@/runtime/treasury/types";
import { countsResourceTransferTaskTowardDemand, resolveResourceTransferTaskHealthOptions } from "@/runtime/logistics/resourceTransferTaskHealth";

export const TREASURY_SHADOW_INTERVAL_TICKS = 40;
const TREASURY_SHADOW_MISMATCH_SAMPLE_CAP = 32;

export type TreasuryShadowMismatchField =
  | "storage_amount"
  | "terminal_amount"
  | "storage_used_capacity"
  | "storage_free_capacity"
  | "terminal_used_capacity"
  | "terminal_free_capacity"
  | "empire_total"
  | "room_set"
  | "stale_epoch"
  | "commitment_index_consistency";

export interface TreasuryShadowMismatch {
  readonly checkedAtTick: number;
  readonly field: TreasuryShadowMismatchField;
  readonly roomName: string;
  readonly resource: string | undefined;
  readonly treasuryValue: number | string;
  readonly otherValue: number | string;
}

interface TreasuryShadowState {
  lastCheckTick: number;
  checks: number;
  totalMismatches: number;
  mismatchSamples: TreasuryShadowMismatch[];
}

const shadowStateByService = new WeakMap<TreasuryService, TreasuryShadowState>();

function shadowState(service: TreasuryService): TreasuryShadowState {
  let state = shadowStateByService.get(service);
  if (!state) {
    state = { lastCheckTick: Number.NEGATIVE_INFINITY, checks: 0, totalMismatches: 0, mismatchSamples: [] };
    shadowStateByService.set(service, state);
  }
  return state;
}

/** 直读通道：独立实现（不与索引共享枚举 helper，保证通道独立性）。 */
function directStoreAmounts(
  room: Room | undefined,
): { amounts: Record<string, number>; exists: boolean } {
  if (!room) return { amounts: {}, exists: false };
  const source = (kind: "storage" | "terminal") => {
    const structure = kind === "storage" ? room.storage : room.terminal;
    if (!structure) return null;
    const record = structure.store as unknown as Record<string, unknown>;
    const amounts: Record<string, number> = {};
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (typeof value === "number" && value > 0) amounts[key] = value;
    }
    return amounts;
  };
  return { amounts: { ...source("storage"), ...source("terminal") }, exists: true };
}

function collectResourceUnion(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): string[] {
  const union = new Set<string>(Object.keys(left));
  for (const key of Object.keys(right)) union.add(key);
  return [...union];
}

export interface TreasuryShadowReport {
  ran: boolean;
  checkedAtTick: number;
  newMismatches: readonly TreasuryShadowMismatch[];
  totalChecks: number;
}

export function runTreasuryShadowCheck(
  service: TreasuryService,
  options?: { force?: boolean },
): boolean {
  const state = shadowState(service);
  const tick = Game.time;
  if (!options?.force && tick - state.lastCheckTick < TREASURY_SHADOW_INTERVAL_TICKS) {
    return false;
  }
  state.lastCheckTick = tick;
  state.checks += 1;

  const newMismatches: TreasuryShadowMismatch[] = [];
  const record = (
    field: TreasuryShadowMismatchField,
    roomName: string,
    resource: string | undefined,
    treasuryValue: number | string,
    otherValue: number | string,
  ) => {
    newMismatches.push(
      Object.freeze({ checkedAtTick: tick, field, roomName, resource, treasuryValue, otherValue }),
    );
  };

  const observation = service.observation();

  // ── 结构性检查：stale epoch 不产出等价性结论 ─────────────────────────────
  if (observation.isStale()) {
    record("stale_epoch", "*", undefined, observation.epoch.observedAtTick, tick);
    finishShadow(service, state, newMismatches);
    return true;
  }

  // ── 通道 1：vs 旧 empireInventoryIndex core ──────────────────────────────
  const legacyCore = getEmpireInventoryCore();
  const treasuryRooms = new Set(observation.roomNames());
  const legacyRooms = new Set(legacyCore.roomNames);
  if (treasuryRooms.size !== legacyRooms.size || [...treasuryRooms].some((name) => !legacyRooms.has(name))) {
    const treasuryOnly = [...treasuryRooms].filter((name) => !legacyRooms.has(name));
    const legacyOnly = [...legacyRooms].filter((name) => !treasuryRooms.has(name));
    record(
      "room_set",
      treasuryOnly.length > 0 ? treasuryOnly[0] : legacyOnly[0],
      undefined,
      treasuryOnly.join(","),
      legacyOnly.join(","),
    );
  }

  for (const roomName of treasuryRooms) {
    const storageLocation = observation.location(roomName, "storage");
    const terminalLocation = observation.location(roomName, "terminal");

    for (const resource of collectResourceUnion(storageLocation.amounts, {})) {
      const treasuryValue = storageLocation.amounts[resource] ?? 0;
      const legacyValue = legacyCore.storageAmount(roomName, resource as ResourceConstant);
      if (treasuryValue !== legacyValue) {
        record("storage_amount", roomName, resource, treasuryValue, legacyValue);
      }
    }
    // 旧侧持有的资源 key 也要比对（并集另一方向）。
    for (const resource of legacyCore.roomResources(roomName)) {
      if (!(resource in storageLocation.amounts)) {
        const treasuryValue = 0;
        const legacyValue = legacyCore.storageAmount(roomName, resource);
        if (legacyValue !== 0) {
          record("storage_amount", roomName, resource, treasuryValue, legacyValue);
        }
      }
    }
    for (const resource of collectResourceUnion(terminalLocation.amounts, {})) {
      const treasuryValue = terminalLocation.amounts[resource] ?? 0;
      const legacyValue = legacyCore.terminalAmount(roomName, resource as ResourceConstant);
      if (treasuryValue !== legacyValue) {
        record("terminal_amount", roomName, resource, treasuryValue, legacyValue);
      }
    }
    for (const resource of legacyCore.roomResources(roomName)) {
      if (!(resource in terminalLocation.amounts)) {
        const legacyValue = legacyCore.terminalAmount(roomName, resource);
        if (legacyValue !== 0) {
          record("terminal_amount", roomName, resource, 0, legacyValue);
        }
      }
    }

    if (storageLocation.usedCapacity !== legacyCore.storageUsedCapacity(roomName)) {
      record(
        "storage_used_capacity",
        roomName,
        undefined,
        storageLocation.usedCapacity,
        legacyCore.storageUsedCapacity(roomName),
      );
    }
    if (storageLocation.freeCapacity !== legacyCore.storageFreeCapacity(roomName)) {
      record(
        "storage_free_capacity",
        roomName,
        undefined,
        storageLocation.freeCapacity,
        legacyCore.storageFreeCapacity(roomName),
      );
    }
    if (terminalLocation.usedCapacity !== legacyCore.terminalUsedCapacity(roomName)) {
      record(
        "terminal_used_capacity",
        roomName,
        undefined,
        terminalLocation.usedCapacity,
        legacyCore.terminalUsedCapacity(roomName),
      );
    }
    if (terminalLocation.freeCapacity !== legacyCore.terminalFreeCapacity(roomName)) {
      record(
        "terminal_free_capacity",
        roomName,
        undefined,
        terminalLocation.freeCapacity,
        legacyCore.terminalFreeCapacity(roomName),
      );
    }
  }

  for (const resource of observation.empireResources()) {
    const treasuryValue = observation.empireTotal(resource);
    const legacyValue = legacyCore.empireTotal(resource as ResourceConstant);
    if (treasuryValue !== legacyValue) {
      record("empire_total", "*", resource, treasuryValue, legacyValue);
    }
  }
  for (const resource of legacyCore.empireResources()) {
    if (observation.empireTotal(resource) !== legacyCore.empireTotal(resource)) {
      record("empire_total", "*", resource, observation.empireTotal(resource), legacyCore.empireTotal(resource));
    }
  }

  // ── 通道 2：vs 独立直读（最终真值；逐房间 storage/terminal）──────────────
  for (const roomName of treasuryRooms) {
    const room = Game.rooms[roomName];
    const treasuryStorage = observation.location(roomName, "storage");
    const treasuryTerminal = observation.location(roomName, "terminal");
    const directStorage = room?.storage;
    const directTerminal = room?.terminal;
    compareDirect(record, roomName, "storage", treasuryStorage, directStorage);
    compareDirect(record, roomName, "terminal", treasuryTerminal, directTerminal);
  }

  // ── 通道 3：承诺索引自洽（重复计数检测）──────────────────────────────────
  const commitments = service.commitments();
  const taskStore = Memory.data?.resourceControl?.tasks ?? {};
  const healthOptions = resolveResourceTransferTaskHealthOptions();
  const recomputedIncoming = new Map<string, number>();
  let pendingCount = 0;
  for (const task of Object.values(taskStore)) {
    if (task.status !== "pending") continue;
    pendingCount += 1;
    if (countsResourceTransferTaskTowardDemand(task, healthOptions)) {
      const key = `${task.toRoomName}\u0000${task.resource}`;
      recomputedIncoming.set(key, (recomputedIncoming.get(key) ?? 0) + task.remainingAmount);
    }
  }
  if (commitments.metrics.pendingTaskRecords !== pendingCount) {
    record(
      "commitment_index_consistency",
      "*",
      undefined,
      commitments.metrics.pendingTaskRecords,
      pendingCount,
    );
  }
  const roomsToCheck = new Set<string>();
  for (const key of recomputedIncoming.keys()) roomsToCheck.add(key.split("\u0000")[0]);
  for (const roomName of roomsToCheck) {
    for (const [key, expected] of recomputedIncoming) {
      if (!key.startsWith(`${roomName}\u0000`)) continue;
      const resource = key.split("\u0000")[1];
      const indexed = commitments.incoming(roomName, resource);
      if (indexed !== expected) {
        record("commitment_index_consistency", roomName, resource, indexed, expected);
      }
    }
  }

  finishShadow(service, state, newMismatches);
  return true;
}

type RecordMismatch = (
  field: TreasuryShadowMismatchField,
  roomName: string,
  resource: string | undefined,
  treasuryValue: number | string,
  otherValue: number | string,
) => void;

function compareDirect(
  record: RecordMismatch,
  roomName: string,
  kind: TreasuryLocationKind,
  treasuryLocation: { exists: boolean; amounts: Readonly<Record<string, number>> },
  structure: StructureStorage | StructureTerminal | undefined,
): void {
  const directExists = structure != null;
  if (treasuryLocation.exists !== directExists) {
    record(`${kind === "storage" ? "storage" : "terminal"}_amount`, roomName, undefined, treasuryLocation.exists ? 1 : 0, directExists ? 1 : 0);
    return;
  }
  if (!directExists) return;
  const recordStore = structure!.store as unknown as Record<string, unknown>;
  const directAmounts: Record<string, number> = {};
  for (const key of Object.keys(recordStore)) {
    const value = recordStore[key];
    if (typeof value === "number" && value > 0) directAmounts[key] = value;
  }
  for (const resource of collectResourceUnion(treasuryLocation.amounts, directAmounts)) {
    const treasuryValue = treasuryLocation.amounts[resource] ?? 0;
    const directValue = directAmounts[resource] ?? 0;
    if (treasuryValue !== directValue) {
      record(kind === "storage" ? "storage_amount" : "terminal_amount", roomName, resource, treasuryValue, directValue);
    }
  }
}

function finishShadow(
  service: TreasuryService,
  state: TreasuryShadowState,
  newMismatches: readonly TreasuryShadowMismatch[],
): void {
  state.totalMismatches += newMismatches.length;
  state.mismatchSamples.push(...newMismatches);
  if (state.mismatchSamples.length > TREASURY_SHADOW_MISMATCH_SAMPLE_CAP) {
    state.mismatchSamples.splice(0, state.mismatchSamples.length - TREASURY_SHADOW_MISMATCH_SAMPLE_CAP);
  }
  snapshotCountersToMemory(service, state);

  if (newMismatches.length > 0) {
    const fields = [...new Set(newMismatches.map((mismatch) => mismatch.field))].join(",");
    console.log(
      `[treasuryShadow] tick=${Game.time} newMismatches=${newMismatches.length} fields=${fields} ` +
        `sample=${JSON.stringify(newMismatches[0])}`,
    );
  }
}

type TreasuryPerfMemory = NonNullable<Memory["runtime"]> & {
  treasuryPerf?: Record<string, number | string>;
};

function snapshotCountersToMemory(service: TreasuryService, state: TreasuryShadowState): void {
  // 与 empireInventoryShadow 的 inventoryPerf 先例一致：仅指标快照写入，
  // 不触碰任何任务/生产/市场状态；Memory.runtime 缺失时先补空对象。
  if (!Memory.runtime) Memory.runtime = {};
  const metrics = service.metrics();
  const runtimeMemory = Memory.runtime as TreasuryPerfMemory;
  runtimeMemory.treasuryPerf = {
    ...metrics,
    shadowChecks: state.checks,
    shadowMismatches: state.totalMismatches,
    shadowLastCheckTick: state.lastCheckTick,
    shadowMismatchSampleTicks: state.mismatchSamples
      .slice(-8)
      .map((mismatch) => mismatch.checkedAtTick)
      .join(","),
    committedAtTick: Game.time,
  };
}

/** 读取 shadow 状态快照（测试/诊断）。 */
export function readTreasuryShadowStatus(service: TreasuryService): {
  lastCheckTick: number;
  checks: number;
  totalMismatches: number;
  mismatchSamples: readonly TreasuryShadowMismatch[];
} {
  const state = shadowState(service);
  return {
    lastCheckTick: state.lastCheckTick,
    checks: state.checks,
    totalMismatches: state.totalMismatches,
    mismatchSamples: Object.freeze([...state.mismatchSamples]),
  };
}

/** 仅供测试：清空 shadow 状态。 */
export function clearTreasuryShadowForTest(service: TreasuryService): void {
  const state = shadowState(service);
  state.lastCheckTick = Number.NEGATIVE_INFINITY;
  state.checks = 0;
  state.totalMismatches = 0;
  state.mismatchSamples = [];
}

export { directStoreAmounts };
