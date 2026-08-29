/**
 * EmpireInventoryShadow 影子等价验证测试（Phase 2）：
 * - 一致数据：parityChecks>0 且 parityMismatches===0（覆盖 Core/帝国总量/
 *   Production/Field/creep+power creep cargo 全部对账路径）；
 * - 人为制造 mismatch（索引与直读不一致）：记录 room/resource/field、
 *   有界样本、不改生产数据、console 只输出有界摘要；
 * - 本次检查 mismatch 计数：零新增时不重复打印历史旧 mismatch；
 * - 低频节流（间隔内不重复执行）、force 旁路；
 * - global reset 后重建。
 */
import {
  clearEmpireInventoryShadowForTest,
  readEmpireInventoryShadowStatus,
  runEmpireInventoryShadowCheck,
  EMPIRE_INVENTORY_SHADOW_INTERVAL_TICKS,
  EMPIRE_INVENTORY_ORACLE_EVERY_N_CHECKS,
} from "@/runtime/empireInventoryShadow";
import {
  getEmpireInventoryCore,
  getEmpireInventoryCreepCargo,
  getEmpireInventoryField,
  getEmpireInventoryProduction,
} from "@/runtime/empireInventoryIndex";

// 测试直接清 runtimeServices 单例（先例：mountCreep.test.ts），确保
// TickContext 的 tick 缓存不跨用例污染。
type RuntimeGlobal = typeof global & { __runtimeServices?: unknown };
function clearRuntimeServicesForTest(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
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

interface RoomSpec {
  name: string;
  storage?: Record<string, number> | null;
  terminal?: Record<string, number> | null;
  cooldown?: number;
  structures?: { id: string; structureType: StructureConstant; resources?: Record<string, number> }[];
  dropped?: { resourceType: ResourceConstant; amount: number }[];
  controllerMy?: boolean;
}

interface InstalledRoom {
  room: Room;
  structures: { id: string; structureType: StructureConstant; store: StoreDefinition }[];
}

function installRooms(specs: RoomSpec[]): Record<string, InstalledRoom> {
  const rooms: Record<string, Room> = {};
  const installed: Record<string, InstalledRoom> = {};
  for (const spec of specs) {
    const structures = (spec.structures ?? []).map((structure) => ({
      id: structure.id,
      structureType: structure.structureType,
      store: makeStore(structure.resources ?? {}),
    }));
    const room = {
      name: spec.name,
      controller: { my: spec.controllerMy ?? true, level: 8 } as StructureController,
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
      find: (
        constant: FindConstant,
        options?: { filter?: { structureType?: StructureConstant } },
      ) => {
        if (options?.filter?.structureType) {
          return structures.filter(
            (structure) => structure.structureType === options.filter?.structureType,
          );
        }
        switch (constant) {
          case FIND_MY_STRUCTURES:
          case FIND_STRUCTURES:
            return structures;
          case FIND_DROPPED_RESOURCES:
            return (spec.dropped ?? []).map((drop, index) => ({
              id: `${spec.name}-drop-${index}` as Id<Resource>,
              resourceType: drop.resourceType,
              amount: drop.amount,
            }));
          default:
            return [];
        }
      },
    } as unknown as Room;
    rooms[spec.name] = room;
    installed[spec.name] = { room, structures };
  }
  Game.rooms = rooms;
  return installed;
}

function installCreeps(
  entries: { name: string; room: Room; resources: Record<string, number> }[],
): void {
  const creeps: Record<string, Creep> = {};
  for (const entry of entries) {
    creeps[entry.name] = {
      name: entry.name,
      store: makeStore(entry.resources),
      room: entry.room,
    } as unknown as Creep;
  }
  Game.creeps = creeps;
}

describe("empireInventoryShadow 影子等价验证", () => {
  beforeEach(() => {
    Game.time = 10_000;
    clearEmpireInventoryShadowForTest();
    clearRuntimeServicesForTest();
    Game.creeps = {};
    delete (Game as Game & { powerCreeps?: Record<string, PowerCreep> }).powerCreeps;
    Memory.runtime = undefined;
  });

  it("一致数据：checks 计数、零 mismatch、计数器快照落 Memory（全层对账）", () => {
    const installed = installRooms([
      {
        name: "W1N57",
        storage: { energy: 5000, U: 900 },
        terminal: { energy: 1200, X: 40 },
        cooldown: 11,
        structures: [
          { id: "f1", structureType: STRUCTURE_FACTORY, resources: { energy: 40 } },
          { id: "l1", structureType: STRUCTURE_LAB, resources: { energy: 10 } },
          { id: "l2", structureType: STRUCTURE_LAB, resources: { energy: 5 } },
          { id: "p1", structureType: STRUCTURE_POWER_SPAWN, resources: { power: 50 } },
          { id: "n1", structureType: STRUCTURE_NUKER, resources: { G: 30 } },
          { id: "c1", structureType: STRUCTURE_CONTAINER, resources: { energy: 70 } },
        ],
        dropped: [{ resourceType: RESOURCE_ENERGY, amount: 25 }],
      },
      {
        // remote 可见房间：进 Field 对账但不进 Core/Production。
        name: "E2N56",
        controllerMy: false,
        structures: [
          { id: "c2", structureType: STRUCTURE_CONTAINER, resources: { energy: 45 } },
        ],
        dropped: [{ resourceType: RESOURCE_UTRIUM, amount: 12 }],
      },
      { name: "E5N59", terminal: { energy: 300 } },
      { name: "E6N59", storage: { energy: 800, Z: 25 } },
    ]);
    installCreeps([
      { name: "home-hauler", room: installed.W1N57.room, resources: { energy: 30 } },
      {
        name: "E1N57:remoteMine:E2N56:miner1",
        room: installed.E2N56.room,
        resources: { energy: 20, U: 8 },
      },
    ]);
    Game.powerCreeps = {
      "pc-1": {
        name: "pc-1",
        store: makeStore({ ops: 60 }),
        room: installed.W1N57.room,
      } as unknown as PowerCreep,
    };
    expect(runEmpireInventoryShadowCheck({ force: true })).toBe(true);
    const status = readEmpireInventoryShadowStatus();
    expect(status.parityChecks).toBeGreaterThan(0);
    expect(status.parityMismatches).toBe(0);
    expect(status.mismatchSamples).toHaveLength(0);
    // 低频计数快照写入 Memory（小对象）：本次检查 mismatch 数为 0。
    const perf = (Memory.runtime as { inventoryPerf?: Record<string, unknown> })
      .inventoryPerf;
    expect(perf).toMatchObject({
      parityChecks: status.parityChecks,
      parityMismatches: 0,
      lastCheckMismatches: 0,
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

  it("本次检查 mismatch 计数：零新增不重复打印历史旧 mismatch", () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      installRooms([{ name: "W1N57", storage: { energy: 100 } }]);
      // 第一轮：制造 mismatch（同 tick 移除直读 storage）。
      getEmpireInventoryCore();
      delete (Game.rooms.W1N57 as unknown as { storage?: unknown }).storage;
      runEmpireInventoryShadowCheck({ force: true });
      const afterFirst = readEmpireInventoryShadowStatus();
      expect(afterFirst.parityMismatches).toBeGreaterThan(0);
      const firstCalls = logSpy.mock.calls.length;
      expect(firstCalls).toBeGreaterThan(0);
      expect(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]).toContain(
        "+",
      );

      // 第二轮：数据恢复一致（重建索引 + 直读一致）→ 零新增，
      // console 不再重复打印历史 mismatch，但累计 parityMismatches 保留。
      Game.time += EMPIRE_INVENTORY_SHADOW_INTERVAL_TICKS;
      installRooms([{ name: "W1N57", storage: { energy: 100 } }]);
      expect(runEmpireInventoryShadowCheck({ force: true })).toBe(true);
      expect(logSpy.mock.calls.length).toBe(firstCalls);
      const afterSecond = readEmpireInventoryShadowStatus();
      expect(afterSecond.parityMismatches).toBe(afterFirst.parityMismatches);
      const perf = (Memory.runtime as { inventoryPerf?: Record<string, unknown> })
        .inventoryPerf;
      expect(perf).toMatchObject({
        lastCheckMismatches: 0,
        parityMismatches: afterFirst.parityMismatches,
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("Production/creep cargo 对账检出直读侧失配", () => {
    const installed = installRooms([
      {
        name: "W1N57",
        storage: { energy: 100 },
        structures: [
          { id: "f1", structureType: STRUCTURE_FACTORY, resources: { energy: 40 } },
          { id: "c1", structureType: STRUCTURE_CONTAINER, resources: { energy: 70 } },
        ],
      },
    ]);
    installCreeps([
      { name: "hauler", room: installed.W1N57.room, resources: { energy: 30 } },
    ]);
    // 同 tick：先建索引（Core/Production/Field/creep cargo 子层），
    // 再破坏直读侧（删 factory、改 creep cargo）。
    getEmpireInventoryCore();
    getEmpireInventoryProduction();
    getEmpireInventoryField();
    getEmpireInventoryCreepCargo();
    installed.W1N57.structures.splice(
      installed.W1N57.structures.findIndex(
        (structure) => structure.structureType === STRUCTURE_FACTORY,
      ),
      1,
    );
    Game.creeps["hauler"] = {
      name: "hauler",
      store: makeStore({ energy: 99 }),
      room: installed.W1N57.room,
    } as unknown as Creep;
    runEmpireInventoryShadowCheck({ force: true });

    const status = readEmpireInventoryShadowStatus();
    expect(
      status.mismatchSamples.find((sample) => sample.field === "factoryCount"),
    ).toMatchObject({ indexValue: 1, directValue: 0 });
    expect(
      status.mismatchSamples.find((sample) => sample.field === "factoryAmount"),
    ).toMatchObject({ resource: RESOURCE_ENERGY, indexValue: 40, directValue: 0 });
    expect(
      status.mismatchSamples.find((sample) => sample.field === "creepCargoTotal"),
    ).toMatchObject({ resource: RESOURCE_ENERGY, indexValue: 30, directValue: 99 });
    expect(
      status.mismatchSamples.find((sample) => sample.field === "creepCargoRoom"),
    ).toMatchObject({ roomName: "W1N57", indexValue: 30, directValue: 99 });
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

  it("子层轮转：默认单层检查，Production 失配只在 production 轮检出", () => {
    // 影子对账检出的是「同 tick 内索引快照与直读分叉」（索引每 tick
    // 重建会吸收跨 tick 破坏），因此每轮检查前同 tick 建索引并破坏。
    const setupCorruptedFactory = (): {
      room: Room;
      structures: { id: string; structureType: StructureConstant; store: StoreDefinition }[];
    } => {
      const installed = installRooms([
        {
          name: "W1N57",
          storage: { energy: 100 },
          structures: [
            { id: "f1", structureType: STRUCTURE_FACTORY, resources: { energy: 40 } },
          ],
        },
      ]);
      getEmpireInventoryCore();
      getEmpireInventoryProduction();
      installed.W1N57.structures.splice(0, 1);
      return installed.W1N57;
    };

    // 第 1 次（core 轮）：不碰 Production → 无 factory 失配。
    setupCorruptedFactory();
    expect(runEmpireInventoryShadowCheck()).toBe(true);
    let status = readEmpireInventoryShadowStatus();
    expect(status.lastLayer).toBe("core");
    expect(
      status.mismatchSamples.find((s) => s.field === "factoryCount"),
    ).toBeUndefined();

    // 第 2 次（production 轮）：检出。
    Game.time += EMPIRE_INVENTORY_SHADOW_INTERVAL_TICKS;
    setupCorruptedFactory();
    expect(runEmpireInventoryShadowCheck()).toBe(true);
    status = readEmpireInventoryShadowStatus();
    expect(status.lastLayer).toBe("production");
    expect(
      status.mismatchSamples.find((s) => s.field === "factoryCount"),
    ).toMatchObject({ indexValue: 1, directValue: 0 });

    // 第 3 次（field 轮）游标回绕。
    Game.time += EMPIRE_INVENTORY_SHADOW_INTERVAL_TICKS;
    installRooms([{ name: "W1N57", storage: { energy: 100 } }]);
    expect(runEmpireInventoryShadowCheck()).toBe(true);
    expect(readEmpireInventoryShadowStatus().lastLayer).toBe("field");
  });

  it("Memory force flag：全层 + oracle 执行，消费即清", () => {
    const installed = installRooms([
      {
        name: "W1N57",
        storage: { energy: 100 },
        structures: [
          { id: "f1", structureType: STRUCTURE_FACTORY, resources: { energy: 40 } },
        ],
      },
    ]);
    getEmpireInventoryCore();
    getEmpireInventoryProduction();
    installed.W1N57.structures.splice(0, 1);
    // 轮转游标本该到 core 轮；Memory flag 旁路为全层。
    Memory.runtime = {
      inventoryShadowForce: true,
    } as unknown as NonNullable<Memory["runtime"]>;
    expect(runEmpireInventoryShadowCheck()).toBe(true);
    const status = readEmpireInventoryShadowStatus();
    expect(status.lastLayer).toBe("all");
    expect(status.lastOracleRan).toBe(true);
    expect(status.oracleChecks).toBeGreaterThan(0);
    expect(
      status.mismatchSamples.find((s) => s.field === "factoryCount"),
    ).toBeDefined();
    expect(
      (Memory.runtime as { inventoryShadowForce?: boolean })
        .inventoryShadowForce,
    ).toBeUndefined();
  });

  it("独立 oracle：Object.keys 不可见但 getUsedCapacity 可读的资源必须检出", () => {
    const installed = installRooms([
      { name: "W1N57", storage: { energy: 100 } },
    ]);
    // 构造引擎式 store：silicon 有正数容量，但 Object.keys 不暴露该 key
    //（索引 scanStoreKeys 与直读 directStoreKeys 同用 Object.keys，
    // 两者都看不到 → 普通对账必然漏检，只有 RESOURCES_ALL 全枚举的
    // oracle 能发现）。
    const hiddenStore = makeStore({ energy: 100 });
    Object.defineProperty(hiddenStore, "getUsedCapacity", {
      value: (resource?: ResourceConstant) =>
        resource === RESOURCE_SILICON
          ? 42
          : storePrototype.getUsedCapacity.call(hiddenStore, resource),
      enumerable: false,
    });
    (installed.W1N57.room as unknown as { storage?: unknown }).storage = {
      id: "W1N57-storage" as Id<StructureStorage>,
      store: hiddenStore,
    };

    runEmpireInventoryShadowCheck({ force: true });
    const status = readEmpireInventoryShadowStatus();
    // 常规对账（storageAmount 等能量侧一致）无失配；oracle 检出
    // silicon：索引 0 vs oracle 42。
    expect(
      status.mismatchSamples.find((s) => s.field === "storageAmount"),
    ).toBeUndefined();
    const oracleMismatch = status.mismatchSamples.find(
      (sample) =>
        sample.field === "oracleResourceAmount" &&
        sample.resource === RESOURCE_SILICON,
    );
    expect(oracleMismatch).toMatchObject({
      indexValue: 0,
      directValue: 42,
    });
    expect(status.oracleMismatches).toBeGreaterThan(0);
  });

  it("oracle 低频：非 force 检查每 N 次执行一次", () => {
    installRooms([{ name: "W1N57", storage: { energy: 10 } }]);
    // 连续 5 次到期检查：第 5 次（checksSinceOracle 达到 N）才跑 oracle。
    let oracleRounds = 0;
    for (let i = 0; i < EMPIRE_INVENTORY_ORACLE_EVERY_N_CHECKS; i += 1) {
      Game.time += EMPIRE_INVENTORY_SHADOW_INTERVAL_TICKS;
      runEmpireInventoryShadowCheck();
      if (readEmpireInventoryShadowStatus().lastOracleRan) oracleRounds += 1;
    }
    expect(oracleRounds).toBe(1);
    expect(readEmpireInventoryShadowStatus().oracleChecks).toBe(1);
    expect(readEmpireInventoryShadowStatus().oracleMismatches).toBe(0);
  });

  it("限定 store 总量口径：lab 无参 getUsedCapacity 不含专属槽，oracle 不误报", () => {
    // 复现线上 tick 73346113 的引擎语义：限定 store（lab/powerSpawn/
    // nuker）的无参 getUsedCapacity() 不含资源专属槽（lab 只含 energy
    // 槽）。旧口径（一律无参）会把 mineral 槽持有量当失配；新口径下
    // 限定 store 用 oracle 全枚举合计，零 mismatch。
    const installed = installRooms([
      {
        name: "W1N57",
        structures: [
          {
            id: "l1",
            structureType: STRUCTURE_LAB,
            resources: { energy: 2000, [RESOURCE_UTRIUM]: 5000 },
          },
          {
            id: "p1",
            structureType: STRUCTURE_POWER_SPAWN,
            resources: { energy: 500, power: 50 },
          },
          {
            id: "n1",
            structureType: STRUCTURE_NUKER,
            resources: { energy: 300000, [RESOURCE_GHODIUM]: 5000 },
          },
          { id: "f1", structureType: STRUCTURE_FACTORY, resources: { energy: 40 } },
        ],
      },
    ]);
    // 引擎式限定 store：覆写无参 getUsedCapacity（lab=energy 槽、
    // powerSpawn/nuker=0）；factory 是通用 store，保持原型语义。
    for (const structure of installed.W1N57.structures) {
      if (structure.structureType === STRUCTURE_FACTORY) continue;
      const store = structure.store;
      const bare =
        structure.structureType === STRUCTURE_LAB ? 2000 : 0;
      Object.defineProperty(store, "getUsedCapacity", {
        value: (resource?: ResourceConstant) =>
          resource !== undefined
            ? storePrototype.getUsedCapacity.call(store, resource)
            : bare,
        enumerable: false,
      });
    }
    runEmpireInventoryShadowCheck({ force: true });
    const status = readEmpireInventoryShadowStatus();
    expect(status.parityMismatches).toBe(0);
    expect(status.oracleMismatches).toBe(0);
    expect(
      status.mismatchSamples.find((s) => s.field === "oracleStoreTotal"),
    ).toBeUndefined();
  });
});
