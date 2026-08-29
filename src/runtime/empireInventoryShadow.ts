/**
 * EmpireInventoryIndex 影子等价验证（Phase 2，只读观察者）：
 * - 每 40 tick（20–50 区间）低频执行一次「层检查」：默认按
 *   Core→Production→Field 子层轮转（降低单次 CPU 峰值），operator
 *   force（options.force 或 console 写 Memory.runtime.inventoryShadowForce
 *   = true）时全层全量；
 * - Core：任一侧出现过的每个 room/resource 的 storage/terminal amount、
 *   total、used/free capacity、cooldown、结构存在性与 storageId/terminalId，
 *   外加帝国级 resource 总量对账；
 * - Production：Factory/Lab/PowerSpawn/Nuker 的数量、每资源量、
 *   used/free capacity 总量与 resource-specific free capacity；
 * - Field：全部可见房间（owned + remote/走廊）的 Container、Dropped、
 *   Tombstone/Ruin，以及 Game.creeps 全量（含远采/殖民/战争单位，总量 +
 *   per-room）与 Game.powerCreeps 的 cargo；
 * - 独立 Oracle（每 5 次检查一次，force 必做）：用 RESOURCES_ALL 全枚举
 *   + store.getUsedCapacity(resource) 建立第三发现通道，验证
 *   sum(索引 amounts) === store.getUsedCapacity()，并检出
 *   index-only / oracle-only 资源——不与索引/直读侧共享任何 key 枚举
 *   helper（Object.keys 的失败模式两侧同源，oracle 必须独立）；
 * - 任何 mismatch：不改生产行为，只记 room/resource/field + 有界样本
 *   （global heap 环形缓冲，cap 32），不把完整 Memory 写进日志；
 * - console 只报告本次检查新增的 mismatch，不重复打印历史旧 mismatch；
 * - 计数器为普通数字桶（parityChecks/parityMismatches/lastCheckMismatches/
 *   oracleChecks/oracleMismatches 追加在索引计数器旁），随 shadow 检查
 *   低频快照到 Memory.runtime.inventoryPerf（小对象）。
 *
 * 本模块不消费索引做任何生产决策；ResourceControl/Market/Hub 等仍直读
 * Store。Phase 2 迁移前以此为等价性证据。
 */
import {
  getEmpireInventoryCore,
  getEmpireInventoryCreepCargo,
  getEmpireInventoryField,
  getEmpireInventoryFieldContainers,
  getEmpireInventoryPowerCreepCargo,
  getEmpireInventoryProduction,
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
    | "storageId"
    | "terminalId"
    | "storageUsedCapacity"
    | "storageFreeCapacity"
    | "terminalUsedCapacity"
    | "terminalFreeCapacity"
    | "terminalCooldown"
    | "empireTotal"
    | "factoryCount"
    | "factoryAmount"
    | "factoryUsedCapacity"
    | "factoryFreeCapacity"
    | "factoryFreeCapacityFor"
    | "labCount"
    | "labAmount"
    | "labUsedCapacity"
    | "labFreeCapacity"
    | "labFreeCapacityFor"
    | "powerSpawnCount"
    | "powerSpawnAmount"
    | "powerSpawnUsedCapacity"
    | "powerSpawnFreeCapacity"
    | "powerSpawnFreeCapacityFor"
    | "nukerCount"
    | "nukerAmount"
    | "nukerUsedCapacity"
    | "nukerFreeCapacity"
    | "nukerFreeCapacityFor"
    | "containerCount"
    | "containerAmount"
    | "droppedAmount"
    | "tombstoneAmount"
    | "ruinAmount"
    | "creepCargoTotal"
    | "creepCargoRoom"
    | "powerCreepCargoTotal"
    | "oracleStoreTotal"
    | "oracleResourceAmount";
  indexValue: number | boolean | string | undefined;
  directValue: number | boolean | string | undefined;
}

/** 轮转层（默认单层检查；force 全层）。 */
export type EmpireInventoryShadowLayer = "core" | "production" | "field";
const SHADOW_LAYERS: readonly EmpireInventoryShadowLayer[] = [
  "core",
  "production",
  "field",
];

type GlobalWithShadow = typeof global & {
  __empireInventoryShadow?: {
    lastCheckTick: number;
    mismatchSamples: EmpireInventoryShadowMismatch[];
    parityChecks: number;
    parityMismatches: number;
    /** 轮转游标（global reset 后从 core 层重来）。 */
    rotationIndex: number;
    /** 距下次 oracle 的倒计时（达到 N 次检查执行一次）。 */
    checksSinceOracle: number;
    oracleChecks: number;
    oracleMismatches: number;
    /** 最近一次检查实际执行的层（"all" 表示 force 全层）。 */
    lastLayer: string;
    /** 最近一次检查是否执行了 oracle。 */
    lastOracleRan: boolean;
  };
};

const shadowGlobal = global as GlobalWithShadow;

/** 影子检查间隔（tick）；20–50 区间内取 40。 */
export const EMPIRE_INVENTORY_SHADOW_INTERVAL_TICKS = 40;
/** Oracle 频率：每 N 次检查执行一次（force 检查必做）。 */
export const EMPIRE_INVENTORY_ORACLE_EVERY_N_CHECKS = 5;
const MISMATCH_SAMPLE_CAP = 32;

function shadowState() {
  let state = shadowGlobal.__empireInventoryShadow;
  if (!state) {
    state = {
      lastCheckTick: Number.NaN,
      mismatchSamples: [],
      parityChecks: 0,
      parityMismatches: 0,
      rotationIndex: 0,
      checksSinceOracle: 0,
      oracleChecks: 0,
      oracleMismatches: 0,
      lastLayer: "",
      lastOracleRan: false,
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
  oracleChecks: number;
  oracleMismatches: number;
  lastLayer: string;
  lastOracleRan: boolean;
  mismatchSamples: readonly EmpireInventoryShadowMismatch[];
} {
  const state = shadowState();
  return {
    lastCheckTick: state.lastCheckTick,
    parityChecks: state.parityChecks,
    parityMismatches: state.parityMismatches,
    oracleChecks: state.oracleChecks,
    oracleMismatches: state.oracleMismatches,
    lastLayer: state.lastLayer,
    lastOracleRan: state.lastOracleRan,
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

/** 直读侧聚合 store key（getUsedCapacity 实际 key，不探测 RESOURCES_ALL）。 */
function directStoreKeys(
  structure: { store: StoreDefinition } | undefined | null,
): ResourceConstant[] {
  if (!structure) return [];
  const keys: ResourceConstant[] = [];
  const record = structure.store as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (typeof record[key] === "number") keys.push(key as ResourceConstant);
  }
  return keys;
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
  expectEqual(null, "storageId", summary?.storageId, storage?.id);
  expectEqual(null, "terminalId", summary?.terminalId, terminal?.id);

  // 逐资源量：任一侧出现过的资源全集（索引只报 >0 的 key；直读侧用
  // 实际 key 枚举，避免 RESOURCES_ALL 探测）。
  const resourceUnion = new Set<ResourceConstant>();
  for (const structure of [storage, terminal]) {
    for (const key of directStoreKeys(structure)) {
      resourceUnion.add(key);
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

/** 帝国级总量对账：索引 empireTotal vs 直读 owned 房间求和。 */
function compareEmpireTotals(
  state: ReturnType<typeof shadowState>,
  core: ReturnType<typeof getEmpireInventoryCore>,
): void {
  const directTotals = new Map<ResourceConstant, number>();
  const resourceUnion = new Set<ResourceConstant>(core.empireResources());
  for (const room of Object.values(Game.rooms)) {
    if (!room.controller?.my) continue;
    for (const structure of [room.storage, room.terminal]) {
      if (!structure) continue;
      for (const key of directStoreKeys(structure)) {
        resourceUnion.add(key);
        directTotals.set(
          key,
          (directTotals.get(key) || 0) + directStoreAmount(structure, key),
        );
      }
    }
  }
  for (const resource of resourceUnion) {
    state.parityChecks += 1;
    const indexValue = core.empireTotal(resource);
    const directValue = directTotals.get(resource) || 0;
    if (indexValue !== directValue) {
      recordMismatch(state, "<empire>", resource, "empireTotal", indexValue, directValue);
    }
  }
}

/** Production 层对账：Factory/Lab/PowerSpawn/Nuker 数量与每资源量。 */
function compareProductionRoom(
  state: ReturnType<typeof shadowState>,
  roomName: string,
): void {
  const production = getEmpireInventoryProduction();
  const room = Game.rooms[roomName];
  const directByType = new Map<StructureConstant, { store: StoreDefinition }[]>();
  if (room) {
    for (const structure of room.find(FIND_MY_STRUCTURES) as unknown as (
      | { store?: StoreDefinition; structureType: StructureConstant }
      | { store: StoreDefinition; structureType: StructureConstant }
    )[]) {
      if (!("store" in structure) || !structure.store) continue;
      const bucket = directByType.get(structure.structureType);
      if (bucket) {
        bucket.push(structure as { store: StoreDefinition });
      } else {
        directByType.set(structure.structureType, [
          structure as { store: StoreDefinition },
        ]);
      }
    }
  }
  const entries: {
    fieldCount: EmpireInventoryShadowMismatch["field"];
    fieldAmount: EmpireInventoryShadowMismatch["field"];
    fieldUsed: EmpireInventoryShadowMismatch["field"];
    fieldFree: EmpireInventoryShadowMismatch["field"];
    fieldFreeFor: EmpireInventoryShadowMismatch["field"];
    type: StructureConstant;
    indexCount: number;
    indexAmount: (resource: ResourceConstant) => number;
    indexResources: () => readonly ResourceConstant[];
    indexUsedCapacity: number;
    indexFreeCapacity: number;
    indexFreeCapacityFor: (resource: ResourceConstant) => number;
    /** resource-specific free 的固定允许集（与索引构建口径一致）。 */
    fixedProbeResources: readonly ResourceConstant[];
  }[] = [
    {
      fieldCount: "factoryCount",
      fieldAmount: "factoryAmount",
      fieldUsed: "factoryUsedCapacity",
      fieldFree: "factoryFreeCapacity",
      fieldFreeFor: "factoryFreeCapacityFor",
      type: STRUCTURE_FACTORY,
      indexCount: production.factoryCount(roomName),
      indexAmount: (resource) => production.factoryAmount(roomName, resource),
      indexResources: () => production.factoryResources(roomName),
      indexUsedCapacity: production.factoryUsedCapacity(roomName),
      indexFreeCapacity: production.factoryFreeCapacity(roomName),
      indexFreeCapacityFor: (resource) =>
        production.factoryFreeCapacityFor(roomName, resource),
      fixedProbeResources: [],
    },
    {
      fieldCount: "labCount",
      fieldAmount: "labAmount",
      fieldUsed: "labUsedCapacity",
      fieldFree: "labFreeCapacity",
      fieldFreeFor: "labFreeCapacityFor",
      type: STRUCTURE_LAB,
      indexCount: production.labCount(roomName),
      indexAmount: (resource) => production.labAmount(roomName, resource),
      indexResources: () => production.labResources(roomName),
      indexUsedCapacity: production.labUsedCapacity(roomName),
      indexFreeCapacity: production.labFreeCapacity(roomName),
      indexFreeCapacityFor: (resource) =>
        production.labFreeCapacityFor(roomName, resource),
      fixedProbeResources: [RESOURCE_ENERGY],
    },
    {
      fieldCount: "powerSpawnCount",
      fieldAmount: "powerSpawnAmount",
      fieldUsed: "powerSpawnUsedCapacity",
      fieldFree: "powerSpawnFreeCapacity",
      fieldFreeFor: "powerSpawnFreeCapacityFor",
      type: STRUCTURE_POWER_SPAWN,
      indexCount: production.powerSpawnCount(roomName),
      indexAmount: (resource) => production.powerSpawnAmount(roomName, resource),
      indexResources: () => production.powerSpawnResources(roomName),
      indexUsedCapacity: production.powerSpawnUsedCapacity(roomName),
      indexFreeCapacity: production.powerSpawnFreeCapacity(roomName),
      indexFreeCapacityFor: (resource) =>
        production.powerSpawnFreeCapacityFor(roomName, resource),
      fixedProbeResources: [RESOURCE_ENERGY, RESOURCE_POWER],
    },
    {
      fieldCount: "nukerCount",
      fieldAmount: "nukerAmount",
      fieldUsed: "nukerUsedCapacity",
      fieldFree: "nukerFreeCapacity",
      fieldFreeFor: "nukerFreeCapacityFor",
      type: STRUCTURE_NUKER,
      indexCount: production.nukerCount(roomName),
      indexAmount: (resource) => production.nukerAmount(roomName, resource),
      indexResources: () => production.nukerResources(roomName),
      indexUsedCapacity: production.nukerUsedCapacity(roomName),
      indexFreeCapacity: production.nukerFreeCapacity(roomName),
      indexFreeCapacityFor: (resource) =>
        production.nukerFreeCapacityFor(roomName, resource),
      fixedProbeResources: [RESOURCE_ENERGY, RESOURCE_GHODIUM],
    },
  ];
  for (const entry of entries) {
    const direct = directByType.get(entry.type) ?? [];
    state.parityChecks += 1;
    if (entry.indexCount !== direct.length) {
      recordMismatch(
        state,
        roomName,
        null,
        entry.fieldCount,
        entry.indexCount,
        direct.length,
      );
    }
    // 资源全集 = 直读侧 key ∪ 索引侧 key（结构被同 tick 移除/新增时
    // 单侧 key 也能对账）。
    const resourceUnion = new Set<ResourceConstant>(entry.indexResources());
    for (const structure of direct) {
      for (const key of directStoreKeys(structure)) resourceUnion.add(key);
    }
    for (const resource of resourceUnion) {
      const directAmount = direct.reduce(
        (sum, structure) => sum + directStoreAmount(structure, resource),
        0,
      );
      if (directAmount > 0 || entry.indexAmount(resource) > 0) {
        state.parityChecks += 1;
        const indexValue = entry.indexAmount(resource);
        if (indexValue !== directAmount) {
          recordMismatch(
            state,
            roomName,
            resource,
            entry.fieldAmount,
            indexValue,
            directAmount,
          );
        }
      }
    }
    // capacity 总量（used/free）对账。
    const directUsedCapacity = direct.reduce(
      (sum, structure) => sum + (structure.store.getUsedCapacity() || 0),
      0,
    );
    state.parityChecks += 1;
    if (entry.indexUsedCapacity !== directUsedCapacity) {
      recordMismatch(
        state, roomName, null, entry.fieldUsed,
        entry.indexUsedCapacity, directUsedCapacity,
      );
    }
    const directFreeCapacity = direct.reduce(
      (sum, structure) => sum + (structure.store.getFreeCapacity() || 0),
      0,
    );
    state.parityChecks += 1;
    if (entry.indexFreeCapacity !== directFreeCapacity) {
      recordMismatch(
        state, roomName, null, entry.fieldFree,
        entry.indexFreeCapacity, directFreeCapacity,
      );
    }
    // resource-specific free：资源集 = 固定允许集 ∪ 索引持有资源（与索引
    // 构建 probe 口径一致；未持有的 lab mineral 槽语义依赖运行时槽位，
    // 双侧都不给承诺值）。
    const freeProbeUnion = new Set<ResourceConstant>(
      entry.fixedProbeResources,
    );
    for (const resource of entry.indexResources()) freeProbeUnion.add(resource);
    for (const resource of freeProbeUnion) {
      const directFreeFor = direct.reduce(
        (sum, structure) => sum + (structure.store.getFreeCapacity(resource) || 0),
        0,
      );
      state.parityChecks += 1;
      if (entry.indexFreeCapacityFor(resource) !== directFreeFor) {
        recordMismatch(
          state,
          roomName,
          resource,
          entry.fieldFreeFor,
          entry.indexFreeCapacityFor(resource),
          directFreeFor,
        );
      }
    }
  }
}

/** Field 层对账：containers / dropped / tombstones / ruins（可见房间全集）。 */
function compareFieldRoom(
  state: ReturnType<typeof shadowState>,
  roomName: string,
): void {
  const field = getEmpireInventoryField();
  const containersView = getEmpireInventoryFieldContainers();
  const room = Game.rooms[roomName];
  const containers = room
    ? (room.find(FIND_STRUCTURES, {
        filter: { structureType: STRUCTURE_CONTAINER },
      }) as unknown as { store: StoreDefinition }[])
    : [];
  state.parityChecks += 1;
  if (field.containerCount(roomName) !== containers.length) {
    recordMismatch(
      state,
      roomName,
      null,
      "containerCount",
      field.containerCount(roomName),
      containers.length,
    );
  }
  const containerResourceUnion = new Set<ResourceConstant>(
    containersView.containerResources(roomName),
  );
  for (const container of containers) {
    for (const key of directStoreKeys(container)) containerResourceUnion.add(key);
  }
  for (const resource of containerResourceUnion) {
    const directAmount = containers.reduce(
      (sum, container) => sum + directStoreAmount(container, resource),
      0,
    );
    if (directAmount > 0 || field.containerAmount(roomName, resource) > 0) {
      state.parityChecks += 1;
      const indexValue = field.containerAmount(roomName, resource);
      if (indexValue !== directAmount) {
        recordMismatch(
          state, roomName, resource, "containerAmount", indexValue, directAmount,
        );
      }
    }
  }

  const expectFieldAmount = (
    fieldMethod: EmpireInventoryShadowMismatch["field"],
    indexValue: number,
    directValue: number,
    resource: ResourceConstant,
  ): void => {
    if (directValue > 0 || indexValue > 0) {
      state.parityChecks += 1;
      if (indexValue !== directValue) {
        recordMismatch(state, roomName, resource, fieldMethod, indexValue, directValue);
      }
    }
  };

  if (room) {
    const droppedTotals = new Map<ResourceConstant, number>();
    for (const resource of room.find(FIND_DROPPED_RESOURCES)) {
      droppedTotals.set(
        resource.resourceType,
        (droppedTotals.get(resource.resourceType) || 0) + resource.amount,
      );
    }
    for (const [resource, amount] of droppedTotals) {
      expectFieldAmount(
        "droppedAmount",
        field.droppedAmount(roomName, resource),
        amount,
        resource,
      );
    }
    const tombstoneTotals = new Map<ResourceConstant, number>();
    for (const tombstone of room.find(FIND_TOMBSTONES)) {
      for (const key of directStoreKeys(tombstone)) {
        tombstoneTotals.set(
          key,
          (tombstoneTotals.get(key) || 0) + directStoreAmount(tombstone, key),
        );
      }
    }
    for (const [resource, amount] of tombstoneTotals) {
      expectFieldAmount(
        "tombstoneAmount",
        field.tombstoneAmount(roomName, resource),
        amount,
        resource,
      );
    }
    const ruinTotals = new Map<ResourceConstant, number>();
    for (const ruin of room.find(FIND_RUINS)) {
      for (const key of directStoreKeys(ruin)) {
        ruinTotals.set(
          key,
          (ruinTotals.get(key) || 0) + directStoreAmount(ruin, key),
        );
      }
    }
    for (const [resource, amount] of ruinTotals) {
      expectFieldAmount(
        "ruinAmount",
        field.ruinAmount(roomName, resource),
        amount,
        resource,
      );
    }
  }
}

/** creep cargo 对账：Game.creeps 全量（总量 + per-room）与 power creep。 */
function compareCreepCargo(
  state: ReturnType<typeof shadowState>,
): void {
  const cargo = getEmpireInventoryCreepCargo();
  const directTotals = new Map<ResourceConstant, number>();
  const directByRoom = new Map<string, Map<ResourceConstant, number>>();
  const resourceUnion = new Set<ResourceConstant>(cargo.resources());
  for (const creep of Object.values(Game.creeps)) {
    const roomName = creep.room?.name;
    for (const key of directStoreKeys(creep)) {
      resourceUnion.add(key);
      const amount = directStoreAmount(creep, key);
      directTotals.set(key, (directTotals.get(key) || 0) + amount);
      if (roomName !== undefined) {
        let bucket = directByRoom.get(roomName);
        if (!bucket) {
          bucket = new Map();
          directByRoom.set(roomName, bucket);
        }
        bucket.set(key, (bucket.get(key) || 0) + amount);
      }
    }
  }
  const roomUnion = new Set<string>(cargo.roomNames());
  for (const roomName of directByRoom.keys()) roomUnion.add(roomName);
  for (const resource of resourceUnion) {
    state.parityChecks += 1;
    const indexValue = cargo.total(resource);
    const directValue = directTotals.get(resource) || 0;
    if (indexValue !== directValue) {
      recordMismatch(state, "<creeps>", resource, "creepCargoTotal", indexValue, directValue);
    }
  }
  for (const roomName of roomUnion) {
    for (const resource of resourceUnion) {
      const directValue = directByRoom.get(roomName)?.get(resource) || 0;
      const indexValue = cargo.roomAmount(roomName, resource);
      if (directValue > 0 || indexValue > 0) {
        state.parityChecks += 1;
        if (indexValue !== directValue) {
          recordMismatch(
            state, roomName, resource, "creepCargoRoom", indexValue, directValue,
          );
        }
      }
    }
  }

  const powerCargo = getEmpireInventoryPowerCreepCargo();
  const directPowerTotals = new Map<ResourceConstant, number>();
  const powerResourceUnion = new Set<ResourceConstant>(powerCargo.resources());
  const powerCreeps = (Game as Game & { powerCreeps?: Record<string, PowerCreep> })
    .powerCreeps;
  for (const powerCreep of Object.values(powerCreeps || {})) {
    if (!powerCreep || !powerCreep.store) continue;
    for (const key of directStoreKeys(powerCreep)) {
      powerResourceUnion.add(key);
      directPowerTotals.set(
        key,
        (directPowerTotals.get(key) || 0) + directStoreAmount(powerCreep, key),
      );
    }
  }
  for (const resource of powerResourceUnion) {
    state.parityChecks += 1;
    const indexValue = powerCargo.total(resource);
    const directValue = directPowerTotals.get(resource) || 0;
    if (indexValue !== directValue) {
      recordMismatch(
        state, "<powerCreeps>", resource, "powerCreepCargoTotal", indexValue, directValue,
      );
    }
  }
}

// ─── 独立 Oracle：第三发现通道（不与索引/直读共享 key 枚举）──────────────

/**
 * 对一组 store 做 oracle 验证：
 * - oracle 侧逐资源量 = 对 RESOURCES_ALL 全枚举调 getUsedCapacity(resource)
 *   （独立通道：不经过 Object.keys，也不复用 directStoreKeys）；
 * - 逐资源：oracle>0 ∪ 索引>0 的资源全集上比较（index-only 与
 *   oracle-only 资源都记 mismatch）；
 * - 总量：sum(索引 amounts) vs store.getUsedCapacity()（用户指定的
 *   核心不变量）。
 * 低频执行（每 N 次检查一次 / force 必做），可接受较重探测成本。
 */
function oracleVerifyStoreGroup(
  state: ReturnType<typeof shadowState>,
  roomName: string,
  label: string,
  stores: readonly ({ store: StoreDefinition } | undefined | null)[],
  indexAmountOf: (resource: ResourceConstant) => number,
  indexResourcesOf: () => readonly ResourceConstant[],
): void {
  const present = stores.filter(
    (store): store is { store: StoreDefinition } => Boolean(store),
  );
  if (present.length === 0) return;
  // oracle 侧资源发现：RESOURCES_ALL 全枚举（独立通道）。
  const oracleAmounts = new Map<ResourceConstant, number>();
  for (const resource of RESOURCES_ALL) {
    let amount = 0;
    for (const unit of present) {
      amount += unit.store.getUsedCapacity(resource) || 0;
    }
    if (amount > 0) oracleAmounts.set(resource, amount);
  }
  // 索引侧资源发现：view 的冻结快照（源头是 Object.keys）。
  const union = new Set<ResourceConstant>(oracleAmounts.keys());
  for (const resource of indexResourcesOf()) {
    if (indexAmountOf(resource) > 0) union.add(resource);
  }
  for (const resource of union) {
    state.parityChecks += 1;
    const oracleValue = oracleAmounts.get(resource) || 0;
    const indexValue = indexAmountOf(resource);
    if (indexValue !== oracleValue) {
      state.oracleMismatches += 1;
      recordMismatch(
        state,
        `${roomName}:${label}`,
        resource,
        "oracleResourceAmount",
        indexValue,
        oracleValue,
      );
    }
  }
  // 总量不变量：sum(索引 amounts) === store.getUsedCapacity()。
  let indexSum = 0;
  for (const resource of indexResourcesOf()) {
    indexSum += indexAmountOf(resource);
  }
  let storeTotal = 0;
  for (const unit of present) {
    storeTotal += unit.store.getUsedCapacity() || 0;
  }
  state.parityChecks += 1;
  if (indexSum !== storeTotal) {
    state.oracleMismatches += 1;
    recordMismatch(
      state,
      `${roomName}:${label}`,
      null,
      "oracleStoreTotal",
      indexSum,
      storeTotal,
    );
  }
}

/** 对当次激活层执行 oracle 验证（force 时全层）。 */
function runOracleCheck(
  state: ReturnType<typeof shadowState>,
  layers: ReadonlySet<EmpireInventoryShadowLayer>,
): void {
  // Core 层：owned 房间 storage/terminal + creep/power creep cargo。
  if (layers.has("core")) {
    const core = getEmpireInventoryCore();
    for (const roomName of core.roomNames) {
      const room = Game.rooms[roomName];
      oracleVerifyStoreGroup(
        state, roomName, "storage", [room?.storage],
        (resource) => core.storageAmount(roomName, resource),
        () => core.roomResources(roomName),
      );
      oracleVerifyStoreGroup(
        state, roomName, "terminal", [room?.terminal],
        (resource) => core.terminalAmount(roomName, resource),
        () => core.roomResources(roomName),
      );
    }
    const cargo = getEmpireInventoryCreepCargo();
    oracleVerifyStoreGroup(
      state, "<creeps>", "cargo", Object.values(Game.creeps),
      (resource) => cargo.total(resource),
      () => cargo.resources(),
    );
    const powerCreeps = (Game as Game & {
      powerCreeps?: Record<string, PowerCreep>;
    }).powerCreeps;
    if (powerCreeps) {
      const powerCargo = getEmpireInventoryPowerCreepCargo();
      oracleVerifyStoreGroup(
        state, "<powerCreeps>", "cargo", Object.values(powerCreeps),
        (resource) => powerCargo.total(resource),
        () => powerCargo.resources(),
      );
    }
  }
  // Production 层：四类结构（按 room 聚合口径）。
  if (layers.has("production")) {
    const production = getEmpireInventoryProduction();
    for (const roomName of getEmpireInventoryCore().roomNames) {
      const room = Game.rooms[roomName];
      const groups: {
        label: string;
        type: StructureConstant;
        amount: (resource: ResourceConstant) => number;
        resources: () => readonly ResourceConstant[];
      }[] = [
        {
          label: "factory",
          type: STRUCTURE_FACTORY,
          amount: (resource) => production.factoryAmount(roomName, resource),
          resources: () => production.factoryResources(roomName),
        },
        {
          label: "lab",
          type: STRUCTURE_LAB,
          amount: (resource) => production.labAmount(roomName, resource),
          resources: () => production.labResources(roomName),
        },
        {
          label: "powerSpawn",
          type: STRUCTURE_POWER_SPAWN,
          amount: (resource) => production.powerSpawnAmount(roomName, resource),
          resources: () => production.powerSpawnResources(roomName),
        },
        {
          label: "nuker",
          type: STRUCTURE_NUKER,
          amount: (resource) => production.nukerAmount(roomName, resource),
          resources: () => production.nukerResources(roomName),
        },
      ];
      for (const group of groups) {
        const directStores = room
          ? (room.find(FIND_MY_STRUCTURES) as unknown as {
              structureType: StructureConstant;
              store?: StoreDefinition;
            }[]).filter(
              (structure): structure is { structureType: StructureConstant; store: StoreDefinition } =>
                structure.structureType === group.type && Boolean(structure.store),
            )
          : [];
        oracleVerifyStoreGroup(
          state, roomName, group.label, directStores,
          group.amount, group.resources,
        );
      }
    }
  }
  // Field 层：containers（按 room 聚合口径）。
  if (layers.has("field")) {
    const field = getEmpireInventoryField();
    for (const roomName of field.roomNames) {
      const room = Game.rooms[roomName];
      const containers = room
        ? (room.find(FIND_STRUCTURES, {
            filter: { structureType: STRUCTURE_CONTAINER },
          }) as unknown as { store: StoreDefinition }[])
        : [];
      oracleVerifyStoreGroup(
        state, roomName, "container", containers,
        (resource) => field.containerAmount(roomName, resource),
        () =>
          getEmpireInventoryFieldContainers().containerResources(roomName),
      );
    }
  }
}

function snapshotCountersToMemory(lastCheckMismatches: number): void {
  if (!Memory.runtime) Memory.runtime = {};
  const counters = readEmpireInventoryCounters();
  const state = shadowState();
  (Memory.runtime as { inventoryPerf?: Record<string, number | number[] | string | boolean> })
    .inventoryPerf = {
    ...counters,
    parityChecks: state.parityChecks,
    parityMismatches: state.parityMismatches,
    lastCheckMismatches,
    lastLayer: state.lastLayer,
    lastOracleRan: state.lastOracleRan,
    oracleChecks: state.oracleChecks,
    oracleMismatches: state.oracleMismatches,
    mismatchSampleTicks: state.mismatchSamples
      .slice(-8)
      .map((sample) => sample.tick),
    committedAtTick: Game.time,
  };
}

/**
 * 影子检查入口（主循环低频调用）。返回 true 表示本 tick 执行了比较。
 * 只读：不改变任何生产状态；mismatch 仅记录与 console 摘要（只报告
 * 本次检查新增的 mismatch，不重复历史）。
 * 默认按 Core→Production→Field 轮转单层检查（降低单次 CPU 峰值）；
 * force（options.force 或 console 写 Memory.runtime.inventoryShadowForce
 * = true）执行全层全量 + oracle。oracle 每 N 次检查一次（force 必做）。
 */
export function runEmpireInventoryShadowCheck(options?: {
  force?: boolean;
}): boolean {
  const state = shadowState();
  // operator/观察者 force 入口：console 写 Memory flag，本 tick 全层全量，
  // 消费即清（幂等）。
  const runtimeMemory = Memory.runtime as
    | { inventoryShadowForce?: boolean }
    | undefined;
  const memoryForced = runtimeMemory?.inventoryShadowForce === true;
  if (memoryForced) delete runtimeMemory!.inventoryShadowForce;
  const forced = options?.force === true || memoryForced;
  if (!forced) {
    if (Game.time === state.lastCheckTick) return false;
    if (
      Number.isFinite(state.lastCheckTick) &&
      Game.time - state.lastCheckTick < EMPIRE_INVENTORY_SHADOW_INTERVAL_TICKS
    ) {
      return false;
    }
  }
  state.lastCheckTick = Game.time;
  const mismatchesBefore = state.parityMismatches;

  // 层选择：默认轮转单层；force 全层。
  const layers = new Set<EmpireInventoryShadowLayer>();
  if (forced) {
    layers.add("core");
    layers.add("production");
    layers.add("field");
    state.lastLayer = "all";
  } else {
    const layer = SHADOW_LAYERS[state.rotationIndex % SHADOW_LAYERS.length];
    state.rotationIndex =
      (state.rotationIndex + 1) % SHADOW_LAYERS.length;
    layers.add(layer);
    state.lastLayer = layer;
  }
  // oracle 调度：每 N 次检查一次（force 必做）。
  state.checksSinceOracle += 1;
  const runOracle =
    forced || state.checksSinceOracle >= EMPIRE_INVENTORY_ORACLE_EVERY_N_CHECKS;
  if (runOracle) state.checksSinceOracle = 0;
  state.lastOracleRan = runOracle;

  if (layers.has("core")) {
    const core = getEmpireInventoryCore();
    // Core 房间全集：索引侧 ∪ 直读侧（owned）。
    const roomUnion = new Set<string>(core.roomNames);
    for (const room of Object.values(Game.rooms)) {
      if (room.controller?.my) roomUnion.add(room.name);
    }
    for (const roomName of roomUnion) {
      compareRoom(state, core, roomName);
    }
    compareEmpireTotals(state, core);
    compareCreepCargo(state);
  }
  if (layers.has("production")) {
    // Production 对账范围：owned core rooms（与索引层口径一致）。
    for (const roomName of getEmpireInventoryCore().roomNames) {
      compareProductionRoom(state, roomName);
    }
  }
  if (layers.has("field")) {
    // Field 对账范围：全部可见房间（owned + remote/走廊）。
    const field = getEmpireInventoryField();
    const fieldRoomUnion = new Set<string>(field.roomNames);
    for (const room of Object.values(Game.rooms)) {
      fieldRoomUnion.add(room.name);
    }
    for (const roomName of fieldRoomUnion) {
      compareFieldRoom(state, roomName);
    }
  }
  if (runOracle) {
    runOracleCheck(state, layers);
    state.oracleChecks += 1;
  }

  const mismatchesThisCheck = state.parityMismatches - mismatchesBefore;
  snapshotCountersToMemory(mismatchesThisCheck);

  // Console-only 摘要：仅本次检查新增 mismatch 时输出（不重复历史旧样本）。
  if (mismatchesThisCheck > 0) {
    const fresh = state.mismatchSamples.slice(-mismatchesThisCheck);
    const latest = fresh[fresh.length - 1];
    console.log(
      `[inventory-shadow] parity mismatch +${mismatchesThisCheck} this check ` +
        `(total ${state.parityMismatches}): tick=${latest.tick} ` +
        `room=${latest.roomName} resource=${latest.resource ?? "-"} ` +
        `field=${latest.field} ` +
        `index=${String(latest.indexValue)} direct=${String(latest.directValue)}`,
    );
  }
  return true;
}
