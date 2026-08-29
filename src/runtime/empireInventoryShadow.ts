/**
 * EmpireInventoryIndex 影子等价验证（Phase 1，只读观察者）：
 * - 每 40 tick（20–50 区间）低频比较新索引与"直接 Store 读取"的旧口径；
 * - 覆盖任一侧出现过的每个 room/resource：storage/terminal amount、total、
 *   storage/terminal used/free capacity、terminal cooldown、结构存在性；
 * - 任何 mismatch：不改生产行为，只记 room/resource/field + 有界样本
 *   （global heap 环形缓冲，cap 32），不把完整 Memory 写进日志；
 * - 计数器为普通数字桶（parityChecks/parityMismatches 追加在索引计数器
 *   旁），随 shadow 检查低频快照到 Memory.runtime.inventoryPerf（小对象）；
 * - Console-only 报告：仅在出现 mismatch 时输出一行有界摘要。
 *
 * 本模块不消费索引做任何生产决策；ResourceControl/Market/Hub 等仍直读
 * Store。Phase 2 迁移前以此为等价性证据。
 */
import {
  getEmpireInventoryCore,
  readEmpireInventoryCounters,
  clearEmpireInventoryForTest,
} from "@/runtime/empireInventoryIndex";

export interface EmpireInventoryShadowMismatch {
  tick: number;
  roomName: string;
  resource: string | null;
  field:
    | "storageAmount"
    | "terminalAmount"
    | "storageExists"
    | "terminalExists"
    | "storageUsedCapacity"
    | "storageFreeCapacity"
    | "terminalUsedCapacity"
    | "terminalFreeCapacity"
    | "terminalCooldown";
  indexValue: number | boolean | string | undefined;
  directValue: number | boolean | string | undefined;
}

type GlobalWithShadow = typeof global & {
  __empireInventoryShadow?: {
    lastCheckTick: number;
    mismatchSamples: EmpireInventoryShadowMismatch[];
    parityChecks: number;
    parityMismatches: number;
  };
};

const shadowGlobal = global as GlobalWithShadow;

/** 影子检查间隔（tick）；20–50 区间内取 40。 */
export const EMPIRE_INVENTORY_SHADOW_INTERVAL_TICKS = 40;
const MISMATCH_SAMPLE_CAP = 32;

function shadowState() {
  let state = shadowGlobal.__empireInventoryShadow;
  if (!state) {
    state = {
      lastCheckTick: Number.NaN,
      mismatchSamples: [],
      parityChecks: 0,
      parityMismatches: 0,
    };
    shadowGlobal.__empireInventoryShadow = state;
  }
  return state;
}

/** 仅供测试/operator：读取影子状态（浅拷贝）。 */
export function readEmpireInventoryShadowStatus(): {
  lastCheckTick: number;
  parityChecks: number;
  parityMismatches: number;
  mismatchSamples: readonly EmpireInventoryShadowMismatch[];
} {
  const state = shadowState();
  return {
    lastCheckTick: state.lastCheckTick,
    parityChecks: state.parityChecks,
    parityMismatches: state.parityMismatches,
    mismatchSamples: state.mismatchSamples.map((sample) => ({ ...sample })),
  };
}

/** 仅供测试：清空影子状态与索引（模拟 global reset）。 */
export function clearEmpireInventoryShadowForTest(): void {
  delete shadowGlobal.__empireInventoryShadow;
  clearEmpireInventoryForTest();
}

function recordMismatch(
  state: ReturnType<typeof shadowState>,
  roomName: string,
  resource: string | null,
  field: EmpireInventoryShadowMismatch["field"],
  indexValue: EmpireInventoryShadowMismatch["indexValue"],
  directValue: EmpireInventoryShadowMismatch["directValue"],
): void {
  state.parityMismatches += 1;
  if (state.mismatchSamples.length >= MISMATCH_SAMPLE_CAP) {
    state.mismatchSamples.shift();
  }
  state.mismatchSamples.push({
    tick: Game.time,
    roomName,
    resource,
    field,
    indexValue,
    directValue,
  });
}

/** 旧口径直读：与 ResourceControl 快照同源的 Store API 调用。 */
function directStoreAmount(
  structure: { store: StoreDefinition } | undefined | null,
  resource: ResourceConstant,
): number {
  if (!structure) return 0;
  return structure.store.getUsedCapacity(resource) || 0;
}

function compareRoom(
  state: ReturnType<typeof shadowState>,
  core: ReturnType<typeof getEmpireInventoryCore>,
  roomName: string,
): void {
  const room = Game.rooms[roomName];
  const storage = room?.storage ?? undefined;
  const terminal = room?.terminal ?? undefined;

  const expectEqual = (
    resource: string | null,
    field: EmpireInventoryShadowMismatch["field"],
    indexValue: number | boolean | string | undefined,
    directValue: number | boolean | string | undefined,
  ): void => {
    state.parityChecks += 1;
    if (indexValue !== directValue) {
      recordMismatch(state, roomName, resource, field, indexValue, directValue);
    }
  };

  const summary = core.roomSummaries().find(
    (candidate) => candidate.roomName === roomName,
  );
  expectEqual(null, "storageExists", summary?.storageExists, Boolean(storage));
  expectEqual(null, "terminalExists", summary?.terminalExists, Boolean(terminal));

  // 逐资源量：任一侧出现过的资源全集（索引只报 >0 的 key；直读侧用
  // 实际 key 枚举，避免 RESOURCES_ALL 探测）。
  const resourceUnion = new Set<ResourceConstant>();
  for (const structure of [storage, terminal]) {
    if (!structure) continue;
    for (const key of Object.keys(structure.store)) {
      if (typeof (structure.store as unknown as Record<string, unknown>)[key] === "number") {
        resourceUnion.add(key as ResourceConstant);
      }
    }
  }
  for (const summaryResource of core.empireResources()) {
    if (core.totalAmount(roomName, summaryResource) > 0) {
      resourceUnion.add(summaryResource);
    }
  }
  for (const resource of resourceUnion) {
    expectEqual(
      resource,
      "storageAmount",
      core.storageAmount(roomName, resource),
      directStoreAmount(storage, resource),
    );
    expectEqual(
      resource,
      "terminalAmount",
      core.terminalAmount(roomName, resource),
      directStoreAmount(terminal, resource),
    );
  }

  // 容量与 cooldown
  expectEqual(
    null,
    "storageUsedCapacity",
    core.storageUsedCapacity(roomName),
    storage ? storage.store.getUsedCapacity() : 0,
  );
  expectEqual(
    null,
    "storageFreeCapacity",
    core.storageFreeCapacity(roomName),
    storage ? storage.store.getFreeCapacity() : 0,
  );
  expectEqual(
    null,
    "terminalUsedCapacity",
    core.terminalUsedCapacity(roomName),
    terminal ? terminal.store.getUsedCapacity() : 0,
  );
  expectEqual(
    null,
    "terminalFreeCapacity",
    core.terminalFreeCapacity(roomName),
    terminal ? terminal.store.getFreeCapacity() : 0,
  );
  expectEqual(
    null,
    "terminalCooldown",
    core.terminalCooldown(roomName),
    terminal?.cooldown ?? 0,
  );
}

function snapshotCountersToMemory(): void {
  if (!Memory.runtime) Memory.runtime = {};
  const counters = readEmpireInventoryCounters();
  const state = shadowState();
  (Memory.runtime as { inventoryPerf?: Record<string, number | number[]> })
    .inventoryPerf = {
    ...counters,
    parityChecks: state.parityChecks,
    parityMismatches: state.parityMismatches,
    mismatchSampleTicks: state.mismatchSamples
      .slice(-8)
      .map((sample) => sample.tick),
    committedAtTick: Game.time,
  };
}

/**
 * 影子检查入口（主循环低频调用）。返回 true 表示本 tick 执行了比较。
 * 只读：不改变任何生产状态；mismatch 仅记录与 console 摘要。
 */
export function runEmpireInventoryShadowCheck(options?: {
  force?: boolean;
}): boolean {
  const state = shadowState();
  if (!options?.force) {
    if (Game.time === state.lastCheckTick) return false;
    if (
      Number.isFinite(state.lastCheckTick) &&
      Game.time - state.lastCheckTick < EMPIRE_INVENTORY_SHADOW_INTERVAL_TICKS
    ) {
      return false;
    }
  }
  state.lastCheckTick = Game.time;

  const core = getEmpireInventoryCore();
  // 房间全集：索引侧 ∪ 直读侧（owned）。
  const roomUnion = new Set<string>(core.roomNames);
  for (const room of Object.values(Game.rooms)) {
    if (room.controller?.my) roomUnion.add(room.name);
  }
  for (const roomName of roomUnion) {
    compareRoom(state, core, roomName);
  }

  snapshotCountersToMemory();

  if (state.parityMismatches > 0 && state.mismatchSamples.length > 0) {
    const latest = state.mismatchSamples[state.mismatchSamples.length - 1];
    // 有界 console 摘要（Console-only 报告）：不打印完整 Memory。
    console.log(
      `[inventory-shadow] parity mismatch #${state.parityMismatches}: ` +
        `tick=${latest.tick} room=${latest.roomName} ` +
        `resource=${latest.resource ?? "-"} field=${latest.field} ` +
        `index=${String(latest.indexValue)} direct=${String(latest.directValue)}`,
    );
  }
  return true;
}
