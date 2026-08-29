/**
 * EmpireInventoryIndex 只读核心单元测试（影子阶段 Phase 2）：
 * - Store 只枚举实际 key（单次 Object.keys，不探测 RESOURCES_ALL）；
 * - Core/Production 与 Field 各子层每 tick 至多 build 一次、多消费者复用；
 * - 只读视图与 roomSummaries/roomResources/empireResources 同 tick 缓存；
 * - Field 房间范围 = 全部可见房间（不限 owned core rooms）；
 * - creep cargo 从 Game.creeps 全量建立（per-room 查询），power creep 独立；
 * - 无 Storage / 无 Terminal / 结构摧毁重建 / ID 变化 / global reset；
 * - 只读视图不可污染（冻结数组、缓存引用）。
 */
import {
  clearEmpireInventoryForTest,
  getEmpireInventoryCore,
  getEmpireInventoryCreepCargo,
  getEmpireInventoryField,
  getEmpireInventoryFieldContainers,
  getEmpireInventoryPowerCreepCargo,
  getEmpireInventoryProduction,
  readEmpireInventoryCounters,
} from "@/runtime/empireInventoryIndex";

// 测试直接清 runtimeServices 单例（先例：mountCreep.test.ts），确保
// TickContext 的 tick 缓存不跨用例污染。
type RuntimeGlobal = typeof global & { __runtimeServices?: unknown };
function clearRuntimeServicesForTest(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

// store 方法放原型上：Object.keys(store) 只暴露资源 key（与引擎 Store 一致）。
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
    return this.__freeCapacity ?? 0;
  },
} as unknown as StoreDefinition;

function makeStore(
  resources: Partial<Record<ResourceConstant, number>>,
  freeCapacity = 1_000_000,
): StoreDefinition {
  const store = Object.create(storePrototype) as StoreDefinition;
  for (const [resource, amount] of Object.entries(resources)) {
    (store as unknown as Record<string, number>)[resource] = amount as number;
  }
  // 非可枚举：Object.keys(store) 只暴露资源 key（与引擎 Store 一致）。
  Object.defineProperty(store, "__freeCapacity", {
    value: freeCapacity,
    enumerable: false,
    writable: true,
  });
  return store;
}

interface StructureSpec {
  id: string;
  structureType: StructureConstant;
  resources?: Partial<Record<ResourceConstant, number>>;
  freeCapacity?: number;
}

interface RoomSpec {
  name: string;
  storage?: StructureSpec | null;
  terminal?: StructureSpec | null;
  cooldown?: number;
  structures?: StructureSpec[];
  dropped?: { resourceType: ResourceConstant; amount: number }[];
  tombstones?: StructureSpec[];
  ruins?: StructureSpec[];
  creeps?: { name: string; resources: Partial<Record<ResourceConstant, number>> }[];
  controllerMy?: boolean;
}

function toStructure(spec: StructureSpec): AnyStoreStructure {
  return {
    id: spec.id,
    structureType: spec.structureType,
    store: makeStore(spec.resources ?? {}, spec.freeCapacity ?? 0),
  } as unknown as AnyStoreStructure;
}

function installRooms(specs: RoomSpec[]): void {
  const rooms: Record<string, Room> = {};
  const creeps: Record<string, Creep> = {};
  for (const spec of specs) {
    const structures = (spec.structures ?? []).map(toStructure);
    const room = {
      name: spec.name,
      controller: {
        my: spec.controllerMy ?? true,
        level: 8,
      } as StructureController,
      storage:
        spec.storage === null || spec.storage === undefined
          ? undefined
          : (toStructure(spec.storage) as unknown as StructureStorage),
      terminal:
        spec.terminal === null || spec.terminal === undefined
          ? undefined
          : (toStructure(spec.terminal) as unknown as StructureTerminal),
      find: (
        constant: FindConstant,
        options?: { filter?: { structureType?: StructureConstant } },
      ) => {
        // 引擎式 filter 对象：按 structureType 过滤。
        if (options?.filter?.structureType) {
          return structures.filter(
            (structure) =>
              structure.structureType === options.filter?.structureType,
          );
        }
        switch (constant) {
          case FIND_MY_STRUCTURES:
            return structures;
          case FIND_STRUCTURES:
            return structures;
          case FIND_DROPPED_RESOURCES:
            return (spec.dropped ?? []).map((drop, index) => ({
              id: `${spec.name}-drop-${index}` as Id<Resource>,
              resourceType: drop.resourceType,
              amount: drop.amount,
            }));
          case FIND_TOMBSTONES:
            return (spec.tombstones ?? []).map((tombstone) => ({
              id: tombstone.id,
              store: makeStore(tombstone.resources ?? {}),
            }));
          case FIND_RUINS:
            return (spec.ruins ?? []).map((ruin) => ({
              id: ruin.id,
              store: makeStore(ruin.resources ?? {}),
            }));
          default:
            return [];
        }
      },
    } as unknown as Room;
    if (room.terminal) {
      (room.terminal as StructureTerminal).cooldown = spec.cooldown ?? 0;
    }
    rooms[spec.name] = room;
    // creep cargo 数据源是 Game.creeps 全量（按当前所在房间分桶）。
    for (const creep of spec.creeps ?? []) {
      creeps[creep.name] = {
        name: creep.name,
        store: makeStore(creep.resources),
        room,
      } as unknown as Creep;
    }
  }
  Game.rooms = rooms;
  Game.creeps = creeps;
}

describe("EmpireInventoryIndex 只读核心", () => {
  beforeEach(() => {
    Game.time = 5000;
    clearEmpireInventoryForTest();
    clearRuntimeServicesForTest();
    Game.creeps = {};
  });

  it("只有 energy 的最小帝国：storage/terminal 量、容量、帝国总量", () => {
    installRooms([
      {
        name: "W1N57",
        storage: { id: "s1", structureType: STRUCTURE_STORAGE, resources: { energy: 1000 }, freeCapacity: 1_000_000 },
        terminal: { id: "t1", structureType: STRUCTURE_TERMINAL, resources: { energy: 500 } },
        cooldown: 7,
      },
    ]);
    const core = getEmpireInventoryCore();
    expect(core.roomNames).toEqual(["W1N57"]);
    expect(core.storageAmount("W1N57", RESOURCE_ENERGY)).toBe(1000);
    expect(core.terminalAmount("W1N57", RESOURCE_ENERGY)).toBe(500);
    expect(core.totalAmount("W1N57", RESOURCE_ENERGY)).toBe(1500);
    expect(core.empireTotal(RESOURCE_ENERGY)).toBe(1500);
    expect(core.storageUsedCapacity("W1N57")).toBe(1000);
    expect(core.storageFreeCapacity("W1N57")).toBe(1_000_000);
    expect(core.terminalCooldown("W1N57")).toBe(7);
  });

  it("多种资源 + 非基础商品（boost 化合物/G/ops/能量）跨结构正确聚合", () => {
    installRooms([
      {
        name: "E1N57",
        storage: {
          id: "s1",
          structureType: STRUCTURE_STORAGE,
          resources: { energy: 10_000, [RESOURCE_UTRIUM]: 4000, [RESOURCE_GHODIUM]: 300 },
        },
        terminal: {
          id: "t1",
          structureType: STRUCTURE_TERMINAL,
          resources: { energy: 5_000, XLHO2: 1200, ops: 900, [RESOURCE_UTRIUM]: 1000 },
        },
      },
      {
        name: "E3N59",
        storage: {
          id: "s2",
          structureType: STRUCTURE_STORAGE,
          resources: { energy: 20_000, [RESOURCE_ZYNTHIUM]: 600 },
        },
      },
    ]);
    const core = getEmpireInventoryCore();
    expect(core.totalAmount("E1N57", RESOURCE_UTRIUM)).toBe(5000);
    expect(core.empireTotal(RESOURCE_UTRIUM)).toBe(5000);
    expect(core.empireTotal(RESOURCE_ENERGY)).toBe(35_000);
    expect(core.empireTotal(RESOURCE_GHODIUM)).toBe(300);
    expect(core.empireTotal("XLHO2" as ResourceConstant)).toBe(1200);
    expect(core.empireTotal("ops" as ResourceConstant)).toBe(900);
    expect(core.empireResources()).toEqual(
      expect.arrayContaining([
        RESOURCE_ENERGY,
        RESOURCE_UTRIUM,
        RESOURCE_GHODIUM,
        RESOURCE_ZYNTHIUM,
      ]),
    );
    // 0 库存资源：两侧都无记录 → 0，且不出现在 empire 资源集合。
    expect(core.empireTotal(RESOURCE_KEANIUM)).toBe(0);
    expect(core.empireResources()).not.toContain(RESOURCE_KEANIUM);
  });

  it("0 库存与显式 0 值 key：量计 0、不计入资源集合", () => {
    installRooms([
      {
        name: "E4N58",
        storage: {
          id: "s1",
          structureType: STRUCTURE_STORAGE,
          resources: { energy: 50, [RESOURCE_HYDROGEN]: 0 },
        },
      },
    ]);
    const core = getEmpireInventoryCore();
    expect(core.storageAmount("E4N58", RESOURCE_ENERGY)).toBe(50);
    expect(core.storageAmount("E4N58", RESOURCE_HYDROGEN)).toBe(0);
    expect(core.empireResources()).toEqual([RESOURCE_ENERGY]);
  });

  it("没有 Storage / 没有 Terminal：存在性 false、量与容量 0", () => {
    installRooms([
      { name: "E5N59", terminal: { id: "t1", structureType: STRUCTURE_TERMINAL, resources: { energy: 800 } } },
      { name: "E6N59", storage: { id: "s2", structureType: STRUCTURE_STORAGE, resources: { energy: 900 } } },
      { name: "E7N58" },
    ]);
    const core = getEmpireInventoryCore();
    expect(core.roomSummaries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ roomName: "E5N59", storageExists: false, terminalExists: true }),
        expect.objectContaining({ roomName: "E6N59", storageExists: true, terminalExists: false }),
        expect.objectContaining({ roomName: "E7N58", storageExists: false, terminalExists: false }),
      ]),
    );
    expect(core.storageAmount("E5N59", RESOURCE_ENERGY)).toBe(0);
    expect(core.storageFreeCapacity("E5N59")).toBe(0);
    expect(core.terminalCooldown("E6N59")).toBe(0);
    expect(core.empireTotal(RESOURCE_ENERGY)).toBe(1700);
  });

  it("非 owned room 不进索引", () => {
    installRooms([
      { name: "W9N9", controllerMy: false, storage: { id: "sx", structureType: STRUCTURE_STORAGE, resources: { energy: 1 } } },
    ]);
    const core = getEmpireInventoryCore();
    expect(core.roomNames).toEqual([]);
    expect(core.empireTotal(RESOURCE_ENERGY)).toBe(0);
  });

  it("同 tick 多消费者只 build 一次；Field 子层各自懒构建一次", () => {
    installRooms([
      {
        name: "E1N57",
        storage: { id: "s1", structureType: STRUCTURE_STORAGE, resources: { energy: 100 } },
        terminal: { id: "t1", structureType: STRUCTURE_TERMINAL },
        structures: [
          { id: "f1", structureType: STRUCTURE_FACTORY, resources: { energy: 40, cell: 20 } },
          { id: "l1", structureType: STRUCTURE_LAB, resources: { energy: 10 } },
          { id: "l2", structureType: STRUCTURE_LAB, resources: { energy: 5 } },
          { id: "p1", structureType: STRUCTURE_POWER_SPAWN, resources: { power: 50 } },
          { id: "n1", structureType: STRUCTURE_NUKER, resources: { G: 30 } },
          { id: "c1", structureType: STRUCTURE_CONTAINER, resources: { energy: 70 } },
        ],
        dropped: [{ resourceType: RESOURCE_ENERGY, amount: 25 }],
        tombstones: [{ id: "tb1", structureType: STRUCTURE_CONTAINER, resources: { energy: 15 } }],
        ruins: [{ id: "r1", structureType: STRUCTURE_CONTAINER, resources: { [RESOURCE_UTRIUM]: 5 } }],
        creeps: [{ name: "c1", resources: { energy: 35 } }],
      },
    ]);
    const core1 = getEmpireInventoryCore();
    const core2 = getEmpireInventoryCore();
    expect(core2.storageAmount("E1N57", RESOURCE_ENERGY)).toBe(100);
    const production = getEmpireInventoryProduction();
    getEmpireInventoryProduction();
    const field = getEmpireInventoryField();
    getEmpireInventoryField();

    // 入口阶段：Core/Production 各一次 build；Field 聚合入口不触发任何
    // 子层 build（全部懒）；ensureIndex 复用 5 次（core2/production×2/
    // field×2，首调用各自 build 1 次不计）。
    const counters = readEmpireInventoryCounters();
    expect(counters.coreLayerBuilds).toBe(1);
    expect(counters.productionLayerBuilds).toBe(1);
    expect(counters.containerLayerBuilds).toBe(0);
    expect(counters.looseResourceLayerBuilds).toBe(0);
    expect(counters.deadStoreLayerBuilds).toBe(0);
    expect(counters.creepCargoLayerBuilds).toBe(0);
    expect(counters.powerCreepCargoLayerBuilds).toBe(0);
    expect(counters.inventoryReuseHits).toBe(5);

    expect(production.factoryCount("E1N57")).toBe(1);
    expect(production.factoryAmount("E1N57", "cell" as ResourceConstant)).toBe(20);
    expect(production.labCount("E1N57")).toBe(2);
    expect(production.labAmount("E1N57", RESOURCE_ENERGY)).toBe(15);
    expect(production.powerSpawnAmount("E1N57", RESOURCE_POWER)).toBe(50);
    expect(production.nukerAmount("E1N57", RESOURCE_GHODIUM)).toBe(30);

    expect(field.containerCount("E1N57")).toBe(1);
    expect(field.containerAmount("E1N57", RESOURCE_ENERGY)).toBe(70);
    expect(field.droppedAmount("E1N57", RESOURCE_ENERGY)).toBe(25);
    expect(field.tombstoneAmount("E1N57", RESOURCE_ENERGY)).toBe(15);
    expect(field.ruinAmount("E1N57", RESOURCE_UTRIUM)).toBe(5);
    expect(field.creepTotal(RESOURCE_ENERGY)).toBe(35);
    // 未知 room 一律 0，不抛错。
    expect(core1.storageAmount("NOPE", RESOURCE_ENERGY)).toBe(0);
    expect(production.labCount("NOPE")).toBe(0);
    expect(field.creepTotal("G" as ResourceConstant)).toBe(0);

    // 方法断言后：各子层恰好 build 一次（同 tick 多次调用复用）。
    const after = readEmpireInventoryCounters();
    expect(after.containerLayerBuilds).toBe(1);
    expect(after.looseResourceLayerBuilds).toBe(1);
    expect(after.deadStoreLayerBuilds).toBe(1);
    expect(after.creepCargoLayerBuilds).toBe(1);
    // power creep 子层未被触碰（creepTotal 不触发）。
    expect(after.powerCreepCargoLayerBuilds).toBe(0);
  });

  it("Field 房间范围=全部可见房间；per-room creep cargo 与 power creep 独立子层", () => {
    installRooms([
      {
        name: "E1N57",
        controllerMy: true,
        storage: { id: "s1", structureType: STRUCTURE_STORAGE, resources: { energy: 100 } },
        structures: [
          { id: "c1", structureType: STRUCTURE_CONTAINER, resources: { energy: 70 } },
        ],
        dropped: [{ resourceType: RESOURCE_ENERGY, amount: 25 }],
        creeps: [{ name: "home-hauler", resources: { energy: 30 } }],
      },
      {
        // remote 可见房间：非 owned，不进 Core，但必须进 Field。
        name: "E2N56",
        controllerMy: false,
        structures: [
          { id: "c2", structureType: STRUCTURE_CONTAINER, resources: { energy: 45 } },
        ],
        dropped: [{ resourceType: RESOURCE_UTRIUM, amount: 12 }],
        creeps: [{ name: "E1N57:remoteMine:E2N56:miner1", resources: { energy: 20, [RESOURCE_UTRIUM]: 8 } }],
      },
    ]);
    // 远采 creep 的 cargo 计入其当前所在房间（E2N56）。
    Game.creeps["war-duo-1"] = {
      name: "war-duo-1",
      store: makeStore({ energy: 5 }),
      room: Game.rooms["E2N56"],
    } as unknown as Creep;
    Game.powerCreeps = {
      "pc-1": {
        name: "pc-1",
        store: makeStore({ ops: 60, energy: 10 }),
        room: Game.rooms["E1N57"],
      } as unknown as PowerCreep,
    };

    const core = getEmpireInventoryCore();
    expect(core.roomNames).toEqual(["E1N57"]);

    const field = getEmpireInventoryField();
    // 非 owned 可见房间进 Field（containers/loose 均可见）。
    expect(field.roomNames).toEqual(["E1N57", "E2N56"]);
    expect(field.containerCount("E2N56")).toBe(1);
    expect(field.containerAmount("E2N56", RESOURCE_ENERGY)).toBe(45);
    expect(field.droppedAmount("E2N56", RESOURCE_UTRIUM)).toBe(12);

    // creep cargo：Game.creeps 全量（含远采/战争单位），按所在房间分桶。
    const cargo = getEmpireInventoryCreepCargo();
    expect(cargo.unitsCounted()).toBe(3);
    expect(cargo.total(RESOURCE_ENERGY)).toBe(55);
    expect(cargo.roomAmount("E1N57", RESOURCE_ENERGY)).toBe(30);
    expect(cargo.roomAmount("E2N56", RESOURCE_ENERGY)).toBe(25);
    expect(cargo.roomAmount("E2N56", RESOURCE_UTRIUM)).toBe(8);
    expect([...cargo.roomNames()].sort()).toEqual(["E1N57", "E2N56"]);
    expect(field.creepRoomAmount("E2N56", RESOURCE_UTRIUM)).toBe(8);

    // power creep cargo：独立子层、独立计数。
    const powerCargo = getEmpireInventoryPowerCreepCargo();
    expect(powerCargo.unitsCounted()).toBe(1);
    expect(powerCargo.total("ops" as ResourceConstant)).toBe(60);
    expect(powerCargo.roomAmount("E1N57", "ops" as ResourceConstant)).toBe(60);
    expect(field.powerCreepTotal("ops" as ResourceConstant)).toBe(60);

    const counters = readEmpireInventoryCounters();
    expect(counters.creepCargoLayerBuilds).toBe(1);
    expect(counters.powerCreepCargoLayerBuilds).toBe(1);
    // Game.powerCreeps 缺失（global reset 形态）不抛错。
    delete (Game as Game & { powerCreeps?: Record<string, PowerCreep> }).powerCreeps;
    Game.time += 1;
    expect(getEmpireInventoryPowerCreepCargo().unitsCounted()).toBe(0);
  });

  it("跨 tick 失效重建：结构摧毁/重建与新 ID 立即可见", () => {
    installRooms([
      {
        name: "E7N57",
        storage: { id: "storage-old", structureType: STRUCTURE_STORAGE, resources: { energy: 400 } },
        terminal: { id: "terminal-old", structureType: STRUCTURE_TERMINAL },
      },
    ]);
    const before = getEmpireInventoryCore();
    expect(before.roomSummaries()[0].storageId).toBe("storage-old");

    // Storage 被摧毁、Terminal 换新 ID、库存变化。
    Game.time += 1;
    installRooms([
      {
        name: "E7N57",
        terminal: { id: "terminal-new", structureType: STRUCTURE_TERMINAL, resources: { energy: 120 } },
      },
    ]);
    const after = getEmpireInventoryCore();
    expect(after.storageAmount("E7N57", RESOURCE_ENERGY)).toBe(0);
    expect(after.terminalAmount("E7N57", RESOURCE_ENERGY)).toBe(120);
    expect(after.roomSummaries()[0]).toMatchObject({
      storageExists: false,
      terminalExists: true,
      terminalId: "terminal-new",
    });
    expect(readEmpireInventoryCounters().coreLayerBuilds).toBe(2);
  });

  it("global reset 后安全重建（清空 global 槽）", () => {
    installRooms([
      { name: "W1N57", storage: { id: "s1", structureType: STRUCTURE_STORAGE, resources: { energy: 10 } } },
    ]);
    expect(getEmpireInventoryCore().empireTotal(RESOURCE_ENERGY)).toBe(10);
    clearEmpireInventoryForTest();
    installRooms([
      { name: "W1N57", storage: { id: "s1", structureType: STRUCTURE_STORAGE, resources: { energy: 999 } } },
    ]);
    expect(getEmpireInventoryCore().empireTotal(RESOURCE_ENERGY)).toBe(999);
  });

  it("调用方不能污染内部数据（冻结数组与缓存引用）", () => {
    installRooms([
      { name: "W1N57", storage: { id: "s1", structureType: STRUCTURE_STORAGE, resources: { energy: 10 } } },
    ]);
    const core = getEmpireInventoryCore();
    expect(() =>
      (core.roomNames as unknown as string[]).push("HACKED"),
    ).toThrow();
    expect(() =>
      (core.empireResources() as unknown as ResourceConstant[]).push(RESOURCE_CATALYST),
    ).toThrow();
    // roomSummaries：同 tick 缓存同一冻结引用，元素冻结不可改。
    const summaries = core.roomSummaries();
    expect(core.roomSummaries()).toBe(summaries);
    expect(Object.isFrozen(summaries)).toBe(true);
    expect(() =>
      (summaries as unknown as { roomName: string }[]).push({
        roomName: "HACKED",
      }),
    ).toThrow();
    // roomResources / empireResources：同样缓存冻结快照。
    const resources = core.roomResources("W1N57");
    expect(core.roomResources("W1N57")).toBe(resources);
    expect(resources).toEqual([RESOURCE_ENERGY]);
    expect(() =>
      (core.roomResources("W1N57") as unknown as ResourceConstant[]).push(
        RESOURCE_CATALYST,
      ),
    ).toThrow();
    expect(getEmpireInventoryCore().roomNames).toEqual(["W1N57"]);
  });

  it("只扫描实际存在的资源 key（storeObjectsScanned 与 resourceKeysEnumerated）", () => {
    installRooms([
      {
        name: "W1N57",
        storage: { id: "s1", structureType: STRUCTURE_STORAGE, resources: { energy: 5, [RESOURCE_UTRIUM]: 7 } },
        terminal: { id: "t1", structureType: STRUCTURE_TERMINAL, resources: { energy: 3 } },
      },
    ]);
    getEmpireInventoryCore();
    const counters = readEmpireInventoryCounters();
    // 2 个 store 对象；key 计数 = storage 2 + terminal 1 = 3
    //（远小于 RESOURCES_ALL×2 的全量探测成本）。
    expect(counters.storeObjectsScanned).toBe(2);
    expect(counters.resourceKeysEnumerated).toBe(3);
  });
});
