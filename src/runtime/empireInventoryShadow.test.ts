/**
 * EmpireInventoryShadow 影子等价验证测试（Phase 1）：
 * - 一致数据：parityChecks>0 且 parityMismatches===0；
 * - 人为制造 mismatch（索引与直读不一致）：记录 room/resource/field、
 *   有界样本、不改生产数据、console 只输出有界摘要；
 * - 低频节流（间隔内不重复执行）、force 旁路；
 * - global reset 后重建。
 */
import {
  clearEmpireInventoryShadowForTest,
  readEmpireInventoryShadowStatus,
  runEmpireInventoryShadowCheck,
  EMPIRE_INVENTORY_SHADOW_INTERVAL_TICKS,
} from "@/runtime/empireInventoryShadow";
import { getEmpireInventoryCore } from "@/runtime/empireInventoryIndex";

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
    return 0;
  },
} as unknown as StoreDefinition;

function makeStore(resources: Record<string, number>): StoreDefinition {
  const store = Object.create(storePrototype) as StoreDefinition;
  for (const [resource, amount] of Object.entries(resources)) {
    (store as unknown as Record<string, number>)[resource] = amount;
  }
  return store;
}

function installRooms(
  specs: {
    name: string;
    storage?: Record<string, number> | null;
    terminal?: Record<string, number> | null;
    cooldown?: number;
  }[],
): void {
  const rooms: Record<string, Room> = {};
  for (const spec of specs) {
    rooms[spec.name] = {
      name: spec.name,
      controller: { my: true, level: 8 } as StructureController,
      storage:
        spec.storage === null || spec.storage === undefined
          ? undefined
          : ({
              id: `${spec.name}-storage` as Id<StructureStorage>,
              store: makeStore(spec.storage),
            } as unknown as StructureStorage),
      terminal:
        spec.terminal === null || spec.terminal === undefined
          ? undefined
          : ({
              id: `${spec.name}-terminal` as Id<StructureTerminal>,
              store: makeStore(spec.terminal),
              cooldown: spec.cooldown ?? 0,
            } as unknown as StructureTerminal),
      find: () => [],
    } as unknown as Room;
  }
  Game.rooms = rooms;
}

describe("empireInventoryShadow 影子等价验证", () => {
  beforeEach(() => {
    Game.time = 10_000;
    clearEmpireInventoryShadowForTest();
  });

  it("一致数据：checks 计数、零 mismatch、计数器快照落 Memory", () => {
    installRooms([
      {
        name: "W1N57",
        storage: { energy: 5000, U: 900 },
        terminal: { energy: 1200, X: 40 },
        cooldown: 11,
      },
      { name: "E5N59", terminal: { energy: 300 } },
      { name: "E6N59", storage: { energy: 800, Z: 25 } },
    ]);
    expect(runEmpireInventoryShadowCheck({ force: true })).toBe(true);
    const status = readEmpireInventoryShadowStatus();
    expect(status.parityChecks).toBeGreaterThan(0);
    expect(status.parityMismatches).toBe(0);
    expect(status.mismatchSamples).toHaveLength(0);
    // 低频计数快照写入 Memory（小对象）。
    const perf = (Memory.runtime as { inventoryPerf?: Record<string, unknown> })
      .inventoryPerf;
    expect(perf).toMatchObject({
      parityChecks: status.parityChecks,
      parityMismatches: 0,
      committedAtTick: Game.time,
    });
  });

  it("mismatch：记录 room/resource/field，样本有界，不改生产数据", () => {
    installRooms([
      { name: "W1N57", storage: { energy: 5000 }, terminal: { energy: 1200 } },
    ]);
    // 同 tick：先建索引（storage 存在），再移除直读侧 storage，
    // comparator 复用已建索引 → 存在性失配被记录。
    getEmpireInventoryCore();
    delete (Game.rooms.W1N57 as unknown as { storage?: unknown }).storage;
    runEmpireInventoryShadowCheck({ force: true });

    const status = readEmpireInventoryShadowStatus();
    expect(status.parityMismatches).toBeGreaterThan(0);
    const mismatch = status.mismatchSamples.find(
      (sample) => sample.field === "storageExists",
    );
    expect(mismatch).toMatchObject({
      roomName: "W1N57",
      field: "storageExists",
      indexValue: true,
      directValue: false,
    });
    // 生产数据（Memory.data）不被影子检查触碰。
    expect(Memory.data).toBeUndefined();
    // 样本有界。
    expect(status.mismatchSamples.length).toBeLessThanOrEqual(32);
  });

  it("低频节流：间隔内不执行，到期/force 执行", () => {
    installRooms([{ name: "W1N57", storage: { energy: 10 } }]);
    expect(runEmpireInventoryShadowCheck({ force: true })).toBe(true);
    Game.time += 1;
    expect(runEmpireInventoryShadowCheck()).toBe(false);
    Game.time += EMPIRE_INVENTORY_SHADOW_INTERVAL_TICKS;
    expect(runEmpireInventoryShadowCheck()).toBe(true);
  });

  it("global reset 后重建并继续对账", () => {
    installRooms([{ name: "W1N57", storage: { energy: 10 } }]);
    runEmpireInventoryShadowCheck({ force: true });
    const before = readEmpireInventoryShadowStatus().parityChecks;
    clearEmpireInventoryShadowForTest();
    installRooms([{ name: "W1N57", storage: { energy: 10 } }]);
    expect(runEmpireInventoryShadowCheck({ force: true })).toBe(true);
    const after = readEmpireInventoryShadowStatus();
    expect(after.parityChecks).toBe(before);
    expect(after.parityMismatches).toBe(0);
  });

  it("多资源/0 库存/非基础商品两侧等价（energy/U/X/Z/G/boost）", () => {
    installRooms([
      {
        name: "E7N58",
        storage: { energy: 1, U: 2, G: 3, XLHO2: 4, ops: 5 },
        terminal: { energy: 0, Z: 6 },
        cooldown: 0,
      },
    ]);
    runEmpireInventoryShadowCheck({ force: true });
    // 显式 0 值 key（terminal energy:0）两侧都是 0 → 无 mismatch。
    expect(readEmpireInventoryShadowStatus().parityMismatches).toBe(0);
    expect(getEmpireInventoryCore().empireTotal("ops" as ResourceConstant)).toBe(5);
  });
});
