/**
 * Treasury Shadow 测试（零行为写入）：
 * - 一致数据：shadow 检查运行且零 mismatch，指标快照写 Memory.runtime.treasuryPerf；
 * - 人为篡改（观察构建后修改真实 store）：直读通道检出 mismatch、样本有界；
 * - 低频节流（间隔内不重复执行）与 force 旁路；
 * - stale epoch 不产出等价性结论；
 * - shadow 全程零行为写入（Game store 内容与 Memory 任务表不变）。
 */
import {
  clearTreasuryShadowForTest,
  readTreasuryShadowStatus,
  runTreasuryShadowCheck,
  TREASURY_SHADOW_INTERVAL_TICKS,
} from "@/runtime/treasury/shadow";
import { createTreasuryService } from "@/runtime/treasury/facade";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";

type RuntimeGlobal = typeof global & { __runtimeServices?: unknown; __empireInventoryIndex?: unknown; __empireInventoryCounters?: unknown };
function clearRuntimeSingletonsForTest(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
  delete (global as RuntimeGlobal).__empireInventoryIndex;
  delete (global as RuntimeGlobal).__empireInventoryCounters;
}

const storePrototype = {
  getUsedCapacity(resource?: ResourceConstant): number {
    if (resource === undefined) {
      let total = 0;
      for (const key of Object.keys(this)) {
        const value = (this as unknown as Record<string, unknown>)[key];
        if (typeof value === "number") total += value;
      }
      return total;
    }
    return ((this as unknown as Record<string, number>)[resource] as number) || 0;
  },
  getFreeCapacity(): number {
    return (this as unknown as { __freeCapacity: number }).__freeCapacity;
  },
} as unknown as StoreDefinition;

function makeStore(resources: Record<string, number>, freeCapacity: number): StoreDefinition {
  const store = Object.create(storePrototype) as StoreDefinition;
  for (const [resource, amount] of Object.entries(resources)) {
    (store as unknown as Record<string, number>)[resource] = amount;
  }
  Object.defineProperty(store, "__freeCapacity", { value: freeCapacity, enumerable: false, writable: true });
  return store;
}

interface RoomSpec {
  name: string;
  storage?: Record<string, number> | null;
  terminal?: Record<string, number> | null;
}

function installRooms(specs: RoomSpec[]): Record<string, Room> {
  const rooms: Record<string, Room> = {};
  for (const spec of specs) {
    rooms[spec.name] = {
      name: spec.name,
      controller: { my: true, level: 8 },
      storage: spec.storage
        ? ({ id: `stor-${spec.name}`, store: makeStore(spec.storage, 1_000_000 - Object.values(spec.storage).reduce((a, b) => a + b, 0)) } as unknown as StructureStorage)
        : undefined,
      terminal: spec.terminal
        ? ({ id: `term-${spec.name}`, store: makeStore(spec.terminal, 300_000 - Object.values(spec.terminal).reduce((a, b) => a + b, 0)) } as unknown as StructureTerminal)
        : undefined,
    } as unknown as Room;
  }
  Game.rooms = rooms;
  return rooms;
}

const ROOM_SPECS: RoomSpec[] = [
  { name: "W1N57", storage: { energy: 320_000, U: 4_000 }, terminal: { energy: 30_000 } },
  { name: "E1N57", storage: { energy: 180_000, K: 20_000 }, terminal: null },
];

function snapshotGameStores(): string {
  const snapshot: Record<string, unknown> = {};
  for (const [name, room] of Object.entries(Game.rooms)) {
    snapshot[name] = {
      storage: room.storage ? { ...(room.storage.store as unknown as Record<string, number>) } : null,
      terminal: room.terminal ? { ...(room.terminal.store as unknown as Record<string, number>) } : null,
    };
  }
  return JSON.stringify(snapshot);
}

beforeEach(() => {
  clearRuntimeSingletonsForTest();
  Game.time = 5000;
  Memory.data = undefined;
  Memory.runtime = undefined;
  installRooms(ROOM_SPECS);
});

describe("Treasury shadow 对比", () => {
  it("一致数据零 mismatch 且指标快照写 treasuryPerf", () => {
    const treasury = createTreasuryService({ getRooms: () => Object.values(Game.rooms) });
    const ran = runTreasuryShadowCheck(treasury, { force: true });

    expect(ran).toBe(true);
    const status = readTreasuryShadowStatus(treasury);
    expect(status.checks).toBe(1);
    expect(status.totalMismatches).toBe(0);
    expect(status.mismatchSamples).toHaveLength(0);

    const perf = (Memory.runtime as { treasuryPerf?: Record<string, number | string> } | undefined)?.treasuryPerf;
    expect(perf).toBeDefined();
    expect(perf!.shadowChecks).toBe(1);
    expect(perf!.shadowMismatches).toBe(0);
    expect(perf!.storeEnumerations).toBeGreaterThan(0);
  });

  it("观察后篡改真实 store 由直读通道检出（且零行为写入）", () => {
    const treasury = createTreasuryService({ getRooms: () => Object.values(Game.rooms) });
    treasury.observation();
    const storesBefore = snapshotGameStores();

    // Treasury 与 EII 已缓存本 tick 观察；此刻外部篡改真实 store（模拟索引漂移）。
    (Game.rooms.W1N57.storage!.store as unknown as Record<string, number>).U = 9_999;

    runTreasuryShadowCheck(treasury, { force: true });
    const status = readTreasuryShadowStatus(treasury);
    expect(status.totalMismatches).toBeGreaterThan(0);
    expect(status.mismatchSamples.length).toBeGreaterThan(0);
    expect(status.mismatchSamples[0].field).toBe("storage_amount");
    expect(status.mismatchSamples[0].resource).toBe("U");

    // 零行为写入：除被测试自身篡改的 U 外，其余 store 内容不变；
    // shadow 不得再改动任何 store（快照在篡改后拍摄）。
    const storesAfterTamper = snapshotGameStores();
    runTreasuryShadowCheck(treasury, { force: true });
    expect(snapshotGameStores()).toBe(storesAfterTamper);
    expect(storesBefore).not.toBe(storesAfterTamper);
  });

  it("低频节流：间隔内不重复执行，force 旁路", () => {
    const treasury = createTreasuryService({ getRooms: () => Object.values(Game.rooms) });
    expect(runTreasuryShadowCheck(treasury, { force: true })).toBe(true);

    Game.time = 5000 + TREASURY_SHADOW_INTERVAL_TICKS - 1;
    expect(runTreasuryShadowCheck(treasury)).toBe(false);
    expect(readTreasuryShadowStatus(treasury).checks).toBe(1);

    Game.time = 5000 + TREASURY_SHADOW_INTERVAL_TICKS;
    expect(runTreasuryShadowCheck(treasury)).toBe(true);
    expect(readTreasuryShadowStatus(treasury).checks).toBe(2);
  });

  it("stale epoch 记录 mismatch 且不产出数值对比结论", () => {
    const treasury = createTreasuryService({ getRooms: () => Object.values(Game.rooms) });
    const staleObservation = treasury.observation();

    Game.time = 5001;
    // stub service 固定返回过期观察（模拟 shadow 在 epoch 过期后被调用），
    // stale 分支必须短路：只记录 stale_epoch，不做任何数值比较。
    const staleService = {
      observation: () => staleObservation,
      metrics: () => treasury.metrics(),
    } as unknown as typeof treasury;

    expect(runTreasuryShadowCheck(staleService, { force: true })).toBe(true);
    const status = readTreasuryShadowStatus(staleService);
    expect(status.totalMismatches).toBe(1);
    expect(status.mismatchSamples[0].field).toBe("stale_epoch");
  });

  it("重复计数检测：承诺索引与任务表逐条重算一致", () => {
    Memory.data = {
      resourceControl: {
        taskSchemaVersion: 2,
        tasks: {
          "t1": {
            id: "t1",
            resource: "U",
            fromRoomName: "W1N57",
            toRoomName: "E1N57",
            amount: 2_000,
            remainingAmount: 1_500,
            status: "pending",
            createdAt: 4900,
            updatedAt: 4950,
            origin: "manual",
            lastProgressAt: 4950,
          } as ResourceTransferTask,
        },
      },
    } as unknown as Memory["data"];

    const treasury = createTreasuryService({ getRooms: () => Object.values(Game.rooms) });
    const tasksBefore = JSON.stringify(Memory.data);
    runTreasuryShadowCheck(treasury, { force: true });

    const status = readTreasuryShadowStatus(treasury);
    expect(status.mismatchSamples.filter((m) => m.field === "commitment_index_consistency")).toHaveLength(0);
    // 任务表零写。
    expect(JSON.stringify(Memory.data)).toBe(tasksBefore);
  });

  it("clearTreasuryShadowForTest 重置采样状态", () => {
    const treasury = createTreasuryService({ getRooms: () => Object.values(Game.rooms) });
    runTreasuryShadowCheck(treasury, { force: true });
    clearTreasuryShadowForTest(treasury);
    const status = readTreasuryShadowStatus(treasury);
    expect(status.checks).toBe(0);
    expect(status.lastCheckTick).toBe(Number.NEGATIVE_INFINITY);
  });
});
