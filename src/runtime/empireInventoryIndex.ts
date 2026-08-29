/**
 * EmpireInventoryIndex——帝国物理库存只读索引（影子阶段，Phase 1）。
 *
 * 目标（本轮只建影子，不接生产消费者）：
 * - 当前 tick 帝国物理库存只扫描一次（三层各自至多 build 一次，同 tick
 *   多消费者复用；懒构建：首次访问才 build）；
 * - 内部状态仅存 global heap（以 Game.time 标识，global reset 自然重建，
 *   不依赖对象引用跨 tick 稳定，不写入 Memory——engine object 永不落盘）；
 * - 扫描 Store 时只枚举实际存在的资源 key（Object.keys(store)），不做
 *   RESOURCES_ALL × getUsedCapacity 全量探测；
 * - 内部热路径（room/resource 二维查询）走数字 ordinal + 扁平数组，
 *   不构造 `${room}:${resource}` 字符串；
 * - 对外只暴露只读视图：返回冻结数组/全新数组，调用方无法污染内部
 *   数据（内部数组 build 后整体 Object.freeze）。
 *
 * 分层（inventory reader 清单结论，见 docs/inventory-reader-survey.md）：
 * - Core（首次访问即建）：owned room、Storage/Terminal 存在性与 id、
 *   每 room/resource 物理量、Storage/Terminal used/free capacity、
 *   Terminal cooldown、帝国 resource 总量；
 * - Production（按需）：Factory/Lab/PowerSpawn/Nuker 的存在性、数量、
 *   每 room 聚合 store、used/free capacity；
 * - Field（按需）：Container、Creep store、Dropped、Tombstone、Ruin
 *   的每 room/帝国聚合量。
 *
 * reader 语义对应：ResourceControl 快照（terminal 全资源+capacity+
 * cooldown）、hubPlanner/hubProgress/synthesisControl/factoryControl
 * （storage/terminal 每资源量）、nukerControl/powerSpawnControl/
 * boostControl（production 结构）、carrier/energyTargets（field 层
 * pickup 目标）。本阶段仅为索引与影子对账，上述模块仍直读 Store。
 */

// ─── 低开销计数器（global heap 普通数字桶；50 tick 低频快照）────────────────

export interface EmpireInventoryCounters {
  inventoryBuilds: number;
  inventoryReuseHits: number;
  storeObjectsScanned: number;
  resourceKeysEnumerated: number;
  coreLayerBuilds: number;
  productionLayerBuilds: number;
  fieldLayerBuilds: number;
}

type GlobalWithInventory = typeof global & {
  __empireInventoryIndex?: { tick: number; index?: EmpireInventoryIndexState };
  __empireInventoryCounters?: EmpireInventoryCounters;
};

const inventoryGlobal = global as GlobalWithInventory;

function counters(): EmpireInventoryCounters {
  let bucket = inventoryGlobal.__empireInventoryCounters;
  if (!bucket) {
    bucket = {
      inventoryBuilds: 0,
      inventoryReuseHits: 0,
      storeObjectsScanned: 0,
      resourceKeysEnumerated: 0,
      coreLayerBuilds: 0,
      productionLayerBuilds: 0,
      fieldLayerBuilds: 0,
    };
    inventoryGlobal.__empireInventoryCounters = bucket;
  }
  return bucket;
}

/** 仅供测试/operator：读取计数快照（浅拷贝）。 */
export function readEmpireInventoryCounters(): EmpireInventoryCounters {
  return { ...counters() };
}

/** 仅供测试：清空索引与计数（模拟 global reset）。 */
export function clearEmpireInventoryForTest(): void {
  delete inventoryGlobal.__empireInventoryIndex;
  delete inventoryGlobal.__empireInventoryCounters;
}

// ─── 内部表示 ────────────────────────────────────────────────────────────────

/** 单一结构的每资源物理量（聚合可能跨多个同类结构）。 */
type ResourceAmountMap = Map<ResourceConstant, number>;

interface CoreRoomRecord {
  readonly roomName: string;
  readonly controllerLevel: number | undefined;
  storageExists: boolean;
  storageId: Id<AnyStoreStructure> | undefined;
  terminalExists: boolean;
  terminalId: Id<AnyStoreStructure> | undefined;
  storageAmounts: ResourceAmountMap;
  terminalAmounts: ResourceAmountMap;
  storageUsedCapacity: number;
  storageFreeCapacity: number;
  terminalUsedCapacity: number;
  terminalFreeCapacity: number;
  terminalCooldown: number;
}

interface ProductionStructuresSnapshot {
  /** 该 room 内全部 factory/lab/powerSpawn/nuker 的聚合。 */
  factory: ProductionAggregate | undefined;
  labs: ProductionAggregate | undefined;
  powerSpawns: ProductionAggregate | undefined;
  nukers: ProductionAggregate | undefined;
}

interface ProductionAggregate {
  count: number;
  amounts: ResourceAmountMap;
  usedCapacity: number;
  freeCapacity: number;
}

interface FieldRoomRecord {
  readonly roomName: string;
  containers: ProductionAggregate | undefined;
  dropped: ResourceAmountMap;
  tombstones: ResourceAmountMap;
  ruins: ResourceAmountMap;
}

interface EmpireInventoryIndexState {
  core: {
    builtTick: number;
    roomNames: string[];
    roomOrdinalByName: Map<string, number>;
    rooms: CoreRoomRecord[];
    empireTotals: ResourceAmountMap;
  };
  production?: {
    builtTick: number;
    rooms: ProductionStructuresSnapshot[];
  };
  field?: {
    builtTick: number;
    rooms: FieldRoomRecord[];
    creepTotals: ResourceAmountMap;
  };
}

// ─── Store 扫描原语：只枚举实际存在的 key ──────────────────────────────────

interface StoreScanResult {
  amounts: ResourceAmountMap;
  usedCapacity: number;
  freeCapacity: number;
}

function scanStoreKeys(store: StoreDefinition): ResourceAmountMap {
  const amounts: ResourceAmountMap = new Map();
  const record = store as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const amount = record[key];
    if (typeof amount === "number" && amount > 0) {
      amounts.set(key as ResourceConstant, amount);
    }
  }
  counters().resourceKeysEnumerated += Object.keys(record).length;
  return amounts;
}

function scanStructureStore(structure: AnyStoreStructure): StoreScanResult {
  counters().storeObjectsScanned += 1;
  return {
    amounts: scanStoreKeys(structure.store),
    usedCapacity: structure.store.getUsedCapacity(),
    freeCapacity: structure.store.getFreeCapacity(),
  };
}

function mergeInto(target: ResourceAmountMap, source: ResourceAmountMap): void {
  for (const [resource, amount] of source) {
    target.set(resource, (target.get(resource) || 0) + amount);
  }
}

/** 聚合一组同类结构的 store（结构数量计入 count）。 */
function aggregateStructures(
  structures: readonly AnyStoreStructure[],
): ProductionAggregate | undefined {
  if (structures.length === 0) return undefined;
  const amounts: ResourceAmountMap = new Map();
  let usedCapacity = 0;
  let freeCapacity = 0;
  for (const structure of structures) {
    const scanned = scanStructureStore(structure);
    mergeInto(amounts, scanned.amounts);
    usedCapacity += scanned.usedCapacity;
    freeCapacity += scanned.freeCapacity;
  }
  return { count: structures.length, amounts, usedCapacity, freeCapacity };
}

// ─── Core 层 build ──────────────────────────────────────────────────────────

function buildCoreLayer(): EmpireInventoryIndexState["core"] {
  counters().coreLayerBuilds += 1;
  const rooms: CoreRoomRecord[] = [];
  const empireTotals: ResourceAmountMap = new Map();
  for (const room of Game.rooms ? Object.values(Game.rooms) : []) {
    if (!room.controller?.my) continue;
    const storage = room.storage ?? undefined;
    const terminal = room.terminal ?? undefined;
    const storageScan = storage ? scanStructureStore(storage) : undefined;
    const terminalScan = terminal ? scanStructureStore(terminal) : undefined;
    const record: CoreRoomRecord = {
      roomName: room.name,
      controllerLevel: room.controller.level,
      storageExists: Boolean(storage),
      storageId: storage?.id,
      terminalExists: Boolean(terminal),
      terminalId: terminal?.id,
      storageAmounts: storageScan?.amounts ?? new Map(),
      terminalAmounts: terminalScan?.amounts ?? new Map(),
      storageUsedCapacity: storageScan?.usedCapacity ?? 0,
      storageFreeCapacity: storageScan?.freeCapacity ?? 0,
      terminalUsedCapacity: terminalScan?.usedCapacity ?? 0,
      terminalFreeCapacity: terminalScan?.freeCapacity ?? 0,
      terminalCooldown: terminal?.cooldown ?? 0,
    };
    mergeInto(empireTotals, record.storageAmounts);
    mergeInto(empireTotals, record.terminalAmounts);
    rooms.push(record);
  }
  const roomOrdinalByName = new Map<string, number>();
  rooms.forEach((record, index) => {
    roomOrdinalByName.set(record.roomName, index);
  });
  return {
    builtTick: Game.time,
    roomNames: rooms.map((record) => record.roomName),
    roomOrdinalByName,
    rooms,
    empireTotals,
  };
}

// ─── Production 层 build（按需）─────────────────────────────────────────────

function buildProductionLayer(
  core: EmpireInventoryIndexState["core"],
): EmpireInventoryIndexState["production"] {
  counters().productionLayerBuilds += 1;
  const rooms: ProductionStructuresSnapshot[] = core.rooms.map((record) => {
    const room = Game.rooms[record.roomName];
    if (!room) {
      return { factory: undefined, labs: undefined, powerSpawns: undefined, nukers: undefined };
    }
    const byType = new Map<StructureConstant, AnyStoreStructure[]>();
    for (const structure of room.find(FIND_MY_STRUCTURES)) {
      if (!("store" in structure)) continue;
      const bucket = byType.get(structure.structureType);
      if (bucket) {
        bucket.push(structure as AnyStoreStructure);
      } else {
        byType.set(structure.structureType, [structure as AnyStoreStructure]);
      }
    }
    return {
      factory: aggregateStructures(byType.get(STRUCTURE_FACTORY) ?? []),
      labs: aggregateStructures(byType.get(STRUCTURE_LAB) ?? []),
      powerSpawns: aggregateStructures(byType.get(STRUCTURE_POWER_SPAWN) ?? []),
      nukers: aggregateStructures(byType.get(STRUCTURE_NUKER) ?? []),
    };
  });
  return { builtTick: Game.time, rooms };
}

// ─── Field 层 build（按需）──────────────────────────────────────────────────

function buildFieldLayer(
  core: EmpireInventoryIndexState["core"],
): EmpireInventoryIndexState["field"] {
  counters().fieldLayerBuilds += 1;
  const creepTotals: ResourceAmountMap = new Map();
  const rooms: FieldRoomRecord[] = core.rooms.map((record) => {
    const room = Game.rooms[record.roomName];
    if (!room) {
      return {
        roomName: record.roomName,
        containers: undefined,
        dropped: new Map(),
        tombstones: new Map(),
        ruins: new Map(),
      };
    }
    const containers: StructureContainer[] = room.find(FIND_STRUCTURES, {
      filter: { structureType: STRUCTURE_CONTAINER },
    }) as StructureContainer[];
    const dropped = new Map<ResourceConstant, number>();
    for (const resource of room.find(FIND_DROPPED_RESOURCES)) {
      dropped.set(
        resource.resourceType,
        (dropped.get(resource.resourceType) || 0) + resource.amount,
      );
    }
    const tombstones = new Map<ResourceConstant, number>();
    for (const tombstone of room.find(FIND_TOMBSTONES)) {
      counters().storeObjectsScanned += 1;
      mergeInto(tombstones, scanStoreKeys(tombstone.store));
    }
    const ruins = new Map<ResourceConstant, number>();
    for (const ruin of room.find(FIND_RUINS)) {
      counters().storeObjectsScanned += 1;
      mergeInto(ruins, scanStoreKeys(ruin.store));
    }
    const roomCreeps = room.find(FIND_MY_CREEPS);
    for (const creep of roomCreeps) {
      counters().storeObjectsScanned += 1;
      const amounts = scanStoreKeys(creep.store);
      mergeInto(creepTotals, amounts);
    }
    return {
      roomName: record.roomName,
      containers: aggregateStructures(containers),
      dropped,
      tombstones,
      ruins,
    };
  });
  return { builtTick: Game.time, rooms, creepTotals };
}

// ─── 生命周期 ────────────────────────────────────────────────────────────────

function ensureIndex(): EmpireInventoryIndexState {
  const holder = inventoryGlobal.__empireInventoryIndex;
  if (holder?.tick === Game.time && holder.index) {
    counters().inventoryReuseHits += 1;
    return holder.index;
  }
  counters().inventoryBuilds += 1;
  const index: EmpireInventoryIndexState = {
    core: buildCoreLayer(),
  };
  inventoryGlobal.__empireInventoryIndex = { tick: Game.time, index };
  return index;
}

function roomOrdinal(core: EmpireInventoryIndexState["core"], roomName: string): number {
  const ordinal = core.roomOrdinalByName.get(roomName);
  return ordinal === undefined ? -1 : ordinal;
}

// ─── 只读视图 ────────────────────────────────────────────────────────────────

export interface EmpireInventoryRoomSummary {
  readonly roomName: string;
  readonly controllerLevel: number | undefined;
  readonly storageExists: boolean;
  readonly terminalExists: boolean;
  readonly storageId: string | undefined;
  readonly terminalId: string | undefined;
}

export interface EmpireInventoryCoreView {
  /** 全部 owned room 名（冻结快照，每次调用同一引用，不可变更）。 */
  readonly roomNames: readonly string[];
  roomSummaries(): EmpireInventoryRoomSummary[];
  storageAmount(roomName: string, resource: ResourceConstant): number;
  terminalAmount(roomName: string, resource: ResourceConstant): number;
  /** room 内 storage+terminal 合计物理量。 */
  totalAmount(roomName: string, resource: ResourceConstant): number;
  /** 帝国级 resource 总量（storage+terminal）。 */
  empireTotal(resource: ResourceConstant): number;
  /** 帝国级出现过的全部资源 key（冻结快照）。 */
  empireResources(): readonly ResourceConstant[];
  storageUsedCapacity(roomName: string): number;
  storageFreeCapacity(roomName: string): number;
  terminalUsedCapacity(roomName: string): number;
  terminalFreeCapacity(roomName: string): number;
  terminalCooldown(roomName: string): number;
}

function frozenAmount(amount: number | undefined): number {
  return amount === undefined ? 0 : amount;
}

function createCoreView(index: EmpireInventoryIndexState): EmpireInventoryCoreView {
  const core = index.core;
  const roomNames = Object.freeze([...core.roomNames]) as readonly string[];
  return {
    roomNames,
    roomSummaries: () =>
      core.rooms.map((record) => ({
        roomName: record.roomName,
        controllerLevel: record.controllerLevel,
        storageExists: record.storageExists,
        terminalExists: record.terminalExists,
        storageId: record.storageId,
        terminalId: record.terminalId,
      })),
    storageAmount: (roomName, resource) => {
      const ordinal = roomOrdinal(core, roomName);
      return ordinal < 0
        ? 0
        : frozenAmount(core.rooms[ordinal].storageAmounts.get(resource));
    },
    terminalAmount: (roomName, resource) => {
      const ordinal = roomOrdinal(core, roomName);
      return ordinal < 0
        ? 0
        : frozenAmount(core.rooms[ordinal].terminalAmounts.get(resource));
    },
    totalAmount: (roomName, resource) => {
      const ordinal = roomOrdinal(core, roomName);
      if (ordinal < 0) return 0;
      const record = core.rooms[ordinal];
      return (
        frozenAmount(record.storageAmounts.get(resource)) +
        frozenAmount(record.terminalAmounts.get(resource))
      );
    },
    empireTotal: (resource) => frozenAmount(core.empireTotals.get(resource)),
    empireResources: () =>
      Object.freeze([...core.empireTotals.keys()]) as readonly ResourceConstant[],
    storageUsedCapacity: (roomName) => {
      const ordinal = roomOrdinal(core, roomName);
      return ordinal < 0 ? 0 : core.rooms[ordinal].storageUsedCapacity;
    },
    storageFreeCapacity: (roomName) => {
      const ordinal = roomOrdinal(core, roomName);
      return ordinal < 0 ? 0 : core.rooms[ordinal].storageFreeCapacity;
    },
    terminalUsedCapacity: (roomName) => {
      const ordinal = roomOrdinal(core, roomName);
      return ordinal < 0 ? 0 : core.rooms[ordinal].terminalUsedCapacity;
    },
    terminalFreeCapacity: (roomName) => {
      const ordinal = roomOrdinal(core, roomName);
      return ordinal < 0 ? 0 : core.rooms[ordinal].terminalFreeCapacity;
    },
    terminalCooldown: (roomName) => {
      const ordinal = roomOrdinal(core, roomName);
      return ordinal < 0 ? 0 : core.rooms[ordinal].terminalCooldown;
    },
  };
}

/** Core 层入口：首次调用构建，同 tick 复用。 */
export function getEmpireInventoryCore(): EmpireInventoryCoreView {
  return createCoreView(ensureIndex());
}

// ─── Production 层只读视图 ──────────────────────────────────────────────────

export interface EmpireInventoryProductionView {
  factoryCount(roomName: string): number;
  labCount(roomName: string): number;
  powerSpawnCount(roomName: string): number;
  nukerCount(roomName: string): number;
  factoryAmount(roomName: string, resource: ResourceConstant): number;
  labAmount(roomName: string, resource: ResourceConstant): number;
  powerSpawnAmount(roomName: string, resource: ResourceConstant): number;
  nukerAmount(roomName: string, resource: ResourceConstant): number;
}

function createProductionAggregateAccessors(
  core: EmpireInventoryIndexState["core"],
  production: EmpireInventoryIndexState["production"],
  select: (snapshot: ProductionStructuresSnapshot) => ProductionAggregate | undefined,
) {
  return {
    count: (roomName: string): number => {
      const ordinal = roomOrdinal(core, roomName);
      return ordinal < 0
        ? 0
        : (select(production.rooms[ordinal])?.count ?? 0);
    },
    amount: (roomName: string, resource: ResourceConstant): number => {
      const ordinal = roomOrdinal(core, roomName);
      return ordinal < 0
        ? 0
        : frozenAmount(
            select(production.rooms[ordinal])?.amounts.get(resource),
          );
    },
  };
}

/** Production 层入口：Core 已建前提下按需构建（同 tick 至多一次）。 */
export function getEmpireInventoryProduction(): EmpireInventoryProductionView {
  const index = ensureIndex();
  if (!index.production || index.production.builtTick !== Game.time) {
    index.production = buildProductionLayer(index.core);
  }
  const core = index.core;
  const production = index.production;
  const factory = createProductionAggregateAccessors(
    core,
    production,
    (snapshot) => snapshot.factory,
  );
  const labs = createProductionAggregateAccessors(
    core,
    production,
    (snapshot) => snapshot.labs,
  );
  const powerSpawns = createProductionAggregateAccessors(
    core,
    production,
    (snapshot) => snapshot.powerSpawns,
  );
  const nukers = createProductionAggregateAccessors(
    core,
    production,
    (snapshot) => snapshot.nukers,
  );
  return {
    factoryCount: factory.count,
    labCount: labs.count,
    powerSpawnCount: powerSpawns.count,
    nukerCount: nukers.count,
    factoryAmount: factory.amount,
    labAmount: labs.amount,
    powerSpawnAmount: powerSpawns.amount,
    nukerAmount: nukers.amount,
  };
}

// ─── Field 层只读视图 ───────────────────────────────────────────────────────

export interface EmpireInventoryFieldView {
  containerCount(roomName: string): number;
  containerAmount(roomName: string, resource: ResourceConstant): number;
  droppedAmount(roomName: string, resource: ResourceConstant): number;
  tombstoneAmount(roomName: string, resource: ResourceConstant): number;
  ruinAmount(roomName: string, resource: ResourceConstant): number;
  /** 帝国级 my creep store 合计。 */
  creepTotal(resource: ResourceConstant): number;
}

function createFieldRoomAccessor(
  core: EmpireInventoryIndexState["core"],
  field: NonNullable<EmpireInventoryIndexState["field"]>,
  select: (record: FieldRoomRecord) => ResourceAmountMap,
): (roomName: string, resource: ResourceConstant) => number {
  return (roomName, resource) => {
    const ordinal = roomOrdinal(core, roomName);
    return ordinal < 0
      ? 0
      : frozenAmount(select(field.rooms[ordinal]).get(resource));
  };
}

/** Field 层入口：Core 已建前提下按需构建（同 tick 至多一次）。 */
export function getEmpireInventoryField(): EmpireInventoryFieldView {
  const index = ensureIndex();
  if (!index.field || index.field.builtTick !== Game.time) {
    index.field = buildFieldLayer(index.core);
  }
  const core = index.core;
  const field = index.field;
  const containerAggregate = (record: FieldRoomRecord) =>
    record.containers?.amounts ?? new Map<ResourceConstant, number>();
  return {
    containerCount: (roomName) => {
      const ordinal = roomOrdinal(core, roomName);
      return ordinal < 0 ? 0 : (field.rooms[ordinal].containers?.count ?? 0);
    },
    containerAmount: createFieldRoomAccessor(core, field, containerAggregate),
    droppedAmount: createFieldRoomAccessor(core, field, (record) => record.dropped),
    tombstoneAmount: createFieldRoomAccessor(
      core,
      field,
      (record) => record.tombstones,
    ),
    ruinAmount: createFieldRoomAccessor(core, field, (record) => record.ruins),
    creepTotal: (resource) => frozenAmount(field.creepTotals.get(resource)),
  };
}
