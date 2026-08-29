/**
 * Store 扫描微基准（诊断性 fixture，非 wall-clock 门槛）：
 * - 旧方式：rooms × RESOURCES_ALL × getUsedCapacity(resource) 全量探测
 *  （ResourceControl getStoredResources / 快照捕获的口径）；
 * - 新方式：Store 实际 key 枚举（EmpireInventoryIndex）；
 * - 确定性通过门槛：旧方式 getUsedCapacity(perResource) 调用数 =
 *   rooms × RESOURCES_ALL × 2 结构；新方式 resourceKeysEnumerated =
 *   实际资源 key 总数（远小于前者）；两侧每 room/resource 结果等价；
 * - wall-clock 仅打印诊断，不作为通过条件（本地时钟噪声大）。
 */
import { performance } from "node:perf_hooks";
import {
  clearEmpireInventoryForTest,
  getEmpireInventoryCore,
  readEmpireInventoryCounters,
} from "@/runtime/empireInventoryIndex";

let perResourceUsedCalls = 0;

const storePrototype = {
  getUsedCapacity(resource?: ResourceConstant): number {
    if (resource !== undefined) {
      perResourceUsedCalls += 1;
      return (
        ((this as unknown as Record<string, number>)[resource] as number) || 0
      );
    }
    let total = 0;
    for (const key of Object.keys(this)) {
      const value = (this as unknown as Record<string, unknown>)[key];
      if (typeof value === "number") total += value;
    }
    return total;
  },
  getFreeCapacity(): number {
    return 100_000;
  },
} as unknown as StoreDefinition;

function makeStore(resources: Record<string, number>): StoreDefinition {
  const store = Object.create(storePrototype) as StoreDefinition;
  for (const [resource, amount] of Object.entries(resources)) {
    (store as unknown as Record<string, number>)[resource] = amount;
  }
  return store;
}

/** 8 房间、每房间 3-12 个资源 key 的合成帝国（对齐线上规模）。 */
function installSyntheticEmpire(): { roomNames: string[] } {
  const roomNames = [
    "W1N57",
    "E1N57",
    "E3N59",
    "E4N58",
    "E5N59",
    "E6N59",
    "E7N58",
    "E7N57",
  ];
  const rooms: Record<string, Room> = {};
  roomNames.forEach((name, index) => {
    const storageResources: Record<string, number> = { energy: 100_000 + index };
    const terminalResources: Record<string, number> = { energy: 20_000 + index };
    // 每房间 2-10 个非 energy key。
    const minerals = ["U", "K", "L", "O", "Z", "H", "X", "G", "ops", "XLHO2"];
    for (let i = 0; i <= (index % 5) + 1 && i < minerals.length; i += 1) {
      storageResources[minerals[i]] = 500 * (i + 1);
      if (i % 2 === 0) terminalResources[minerals[i]] = 300 * (i + 1);
    }
    rooms[name] = {
      name,
      controller: { my: true, level: 8 } as StructureController,
      storage: {
        id: `${name}-s` as Id<StructureStorage>,
        store: makeStore(storageResources),
      } as unknown as StructureStorage,
      terminal: {
        id: `${name}-t` as Id<StructureTerminal>,
        store: makeStore(terminalResources),
        cooldown: 0,
      } as unknown as StructureTerminal,
      find: () => [],
    } as unknown as Room;
  });
  Game.rooms = rooms;
  return { roomNames };
}

/** 旧方式：全量 RESOURCES_ALL 探测（RC getStoredResources 口径）。 */
function legacyFullScan(roomNames: string[]): {
  totals: Map<string, Map<string, number>>;
  actualKeyCount: number;
} {
  const totals = new Map<string, Map<string, number>>();
  let actualKeyCount = 0;
  for (const roomName of roomNames) {
    const room = Game.rooms[roomName] as unknown as {
      storage?: { store: StoreDefinition };
      terminal?: { store: StoreDefinition };
    };
    const perRoom = new Map<string, number>();
    for (const structure of [room.storage, room.terminal]) {
      if (!structure) continue;
      for (const resource of RESOURCES_ALL) {
        const amount = structure.store.getUsedCapacity(resource);
        if (amount > 0) {
          perRoom.set(resource, (perRoom.get(resource) || 0) + amount);
        }
      }
      actualKeyCount += Object.keys(structure.store).length;
    }
    totals.set(roomName, perRoom);
  }
  return { totals, actualKeyCount };
}

describe("EmpireInventoryIndex Store 扫描微基准", () => {
  beforeEach(() => {
    Game.time = 7000;
    perResourceUsedCalls = 0;
    clearEmpireInventoryForTest();
  });

  it("确定性门槛：调用数/扫描数/结果等价（wall-clock 仅诊断）", () => {
    const { roomNames } = installSyntheticEmpire();

    // ── 旧方式 ──
    const legacyStart = performance.now();
    const legacy = legacyFullScan(roomNames);
    const legacyMs = performance.now() - legacyStart;

    // ── 新方式 ──
    const indexStart = performance.now();
    const core = getEmpireInventoryCore();
    for (const roomName of roomNames) {
      for (const resource of RESOURCES_ALL) {
        core.totalAmount(roomName, resource);
      }
    }
    const indexMs = performance.now() - indexStart;
    const counters = readEmpireInventoryCounters();

    // 门槛 1：旧方式调用数 = rooms × RESOURCES_ALL × 2（确定性）。
    expect(perResourceUsedCalls).toBe(roomNames.length * RESOURCES_ALL.length * 2);
    // 门槛 2：新方式只枚举实际 key。
    expect(counters.resourceKeysEnumerated).toBe(legacy.actualKeyCount);
    expect(counters.storeObjectsScanned).toBe(roomNames.length * 2);
    // 门槛 3：扫描成本数量级——实际 key 数远小于全量探测调用数。
    expect(counters.resourceKeysEnumerated).toBeLessThan(
      perResourceUsedCalls / 10,
    );
    // 门槛 4：结果等价——两侧每 room/resource 总量一致。
    for (const [roomName, legacyRoom] of legacy.totals) {
      for (const [resource, amount] of legacyRoom) {
        expect(core.totalAmount(roomName, resource as ResourceConstant)).toBe(
          amount,
        );
      }
      // 旧方式未出现的资源在新索引同样为 0。
      expect(
        core.totalAmount(roomName, RESOURCE_CATALYST),
      ).toBe(legacyRoom.get(RESOURCE_CATALYST) || 0);
    }
    // 诊断输出（非门槛）。
    // eslint-disable-next-line no-console
    console.log(
      `[inventory-bench] rooms=${roomNames.length} ` +
        `legacyPerResourceCalls=${perResourceUsedCalls} ` +
        `newKeyEnumeration=${counters.resourceKeysEnumerated} ` +
        `legacyScanMs=${legacyMs.toFixed(3)} indexBuildMs=${indexMs.toFixed(3)}`,
    );
  });
});
