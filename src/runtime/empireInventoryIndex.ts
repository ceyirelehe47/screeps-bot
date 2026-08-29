/**
 * EmpireInventoryIndex——帝国物理库存只读索引（影子阶段，Phase 2 扩展）。
 *
 * 目标（本轮只建影子，不接生产消费者）：
 * - 当前 tick 帝国物理库存只扫描一次（Core 与 Field 各子层各自至多
 *   build 一次，同 tick 多消费者复用；懒构建：首次访问才 build）；
 * - 只读视图对象本身也缓存进 index state：同 tick 重复调用入口函数
 *   返回同一 view 引用，不再重复创建闭包与数组（roomSummaries /
 *   roomResources / empireResources 均为冻结快照缓存）；
 * - 内部状态仅存 global heap（以 Game.time 标识，global reset 自然重建，
 *   不依赖对象引用跨 tick 稳定，不写入 Memory——engine object 永不落盘）；
 * - 扫描 Store 时只枚举实际存在的资源 key（单次 Object.keys），不做
 *   RESOURCES_ALL × getUsedCapacity 全量探测；
 * - 内部热路径（room/resource 二维查询）走数字 ordinal + 扁平数组，
 *   不构造 `${room}:${resource}` 字符串；
 * - 对外只暴露只读视图：返回冻结数组/Map 快照，调用方无法污染内部
 *   数据（内部数组 build 后整体 Object.freeze）。
 *
 * 分层（inventory reader 清单结论，见 docs/inventory-reader-survey.md）：
 * - Core（首次访问即建）：owned room、Storage/Terminal 存在性与 id、
 *   每 room/resource 物理量、Storage/Terminal used/free capacity、
 *   Terminal cooldown、帝国 resource 总量；
 * - Production（按需，复用 TickContext 的 my 结构分型索引）：
 *   Factory/Lab/PowerSpawn/Nuker 的存在性、数量、每 room 聚合 store、
 *   used/free capacity；
 * - Field（按需，五个独立懒子层；房间范围=全部可见房间，不限于
 *   owned core rooms）：
 *   - containers：Container 聚合（复用 TickContext.getContainers）；
 *   - looseResources：Dropped resources；
 *   - deadStores：Tombstone + Ruin 残余 store；
 *   - creepCargo：Game.creeps 全量（含远采/殖民/战争单位，按当前
 *     所在房间分桶；复用 TickContext.getAllCreeps）；
 *   - powerCreepCargo：Game.powerCreeps 全量（独立子层）。
 *
 * reader 语义对应：ResourceControl 快照（terminal 全资源+capacity+
 * cooldown）、hubPlanner/hubProgress/synthesisControl/factoryControl
 * （storage/terminal 每资源量）、nukerControl/powerSpawnControl/
 * boostControl（production 结构）、carrier/energyTargets（field 层
 * pickup 目标）。本阶段仅为索引与影子对账，上述模块仍直读 Store。
 */

import { getTickContextService } from "@/runtime/runtimeServices";

// ─── 低开销计数器（global heap 普通数字桶；50 tick 低频快照）────────────────

export interface EmpireInventoryCounters {
  inventoryBuilds: number;
  inventoryReuseHits: number;
  storeObjectsScanned: number;
  resourceKeysEnumerated: number;
  coreLayerBuilds: number;
  productionLayerBuilds: number;
  containerLayerBuilds: number;
  looseResourceLayerBuilds: number;
  deadStoreLayerBuilds: number;
  creepCargoLayerBuilds: number;
  powerCreepCargoLayerBuilds: number;
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
      containerLayerBuilds: 0,
      looseResourceLayerBuilds: 0,
      deadStoreLayerBuilds: 0,
      creepCargoLayerBuilds: 0,
      powerCreepCargoLayerBuilds: 0,
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

/** 单一结构/单位的每资源物理量（聚合可能跨多个同类对象）。 */
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
  /** 聚合中出现过的资源 key（冻结快照；影子对账与消费者枚举用）。 */
  resources: readonly ResourceConstant[];
  usedCapacity: number;
  freeCapacity: number;
}

/** creep/power creep cargo 子层：按当前所在房间分桶 + 帝国总量。 */
interface CreepCargoLayer {
  builtTick: number;
  roomNames: string[];
  rooms: Map<string, ResourceAmountMap>;
  totals: ResourceAmountMap;
  unitsCounted: number;
}

interface EmpireInventoryIndexState {
  core: {
    builtTick: number;
    roomNames: string[];
    roomOrdinalByName: Map<string, number>;
    rooms: CoreRoomRecord[];
    empireTotals: ResourceAmountMap;
    roomSummariesSnapshot?: readonly EmpireInventoryRoomSummary[];
    empireResourcesSnapshot?: readonly ResourceConstant[];
    roomResourcesSnapshots?: (readonly ResourceConstant[] | undefined)[];
  };
  coreView?: EmpireInventoryCoreView;
  production?: {
    builtTick: number;
    rooms: ProductionStructuresSnapshot[];
  };
  productionView?: EmpireInventoryProductionView;
  field: {
    builtTick: number;
    /** Field 房间范围 = 全部可见房间（含 remote/走廊），不限 owned。 */
    roomNames: string[];
    roomOrdinalByName: Map<string, number>;
    containers?: {
      builtTick: number;
      rooms: (ProductionAggregate | undefined)[];
    };
    containersView?: EmpireInventoryFieldContainersView;
    looseResources?: {
      builtTick: number;
      rooms: ResourceAmountMap[];
    };
    looseResourcesView?: EmpireInventoryFieldLooseResourcesView;
    deadStores?: {
      builtTick: number;
      tombstones: ResourceAmountMap[];
      ruins: ResourceAmountMap[];
    };
    deadStoresView?: EmpireInventoryFieldDeadStoresView;
    creepCargo?: CreepCargoLayer;
    creepCargoView?: EmpireInventoryCreepCargoView;
    powerCreepCargo?: CreepCargoLayer;
    powerCreepCargoView?: EmpireInventoryCreepCargoView;
    compositeView?: EmpireInventoryFieldView;
  };
}

// ─── Store 扫描原语：只枚举实际存在的 key（单次 Object.keys）────────────────

interface StoreScanResult {
  amounts: ResourceAmountMap;
  usedCapacity: number;
  freeCapacity: number;
}

function scanStoreKeys(store: StoreDefinition): ResourceAmountMap {
  const amounts: ResourceAmountMap = new Map();
  const record = store as unknown as Record<string, unknown>;
  const keys = Object.keys(record);
  for (const key of keys) {
    const amount = record[key];
    if (typeof amount === "number" && amount > 0) {
      amounts.set(key as ResourceConstant, amount);
    }
  }
  counters().resourceKeysEnumerated += keys.length;
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

const EMPTY_RESOURCES: readonly ResourceConstant[] = Object.freeze([]);

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
  return {
    count: structures.length,
    amounts,
    resources: Object.freeze([...amounts.keys()]) as readonly ResourceConstant[],
    usedCapacity,
    freeCapacity,
  };
}

/** TickContext 分型结构里只保留带 store 的对象。 */
function storedOf(
  structures: readonly Structure<StructureConstant>[],
): AnyStoreStructure[] {
  const stored: AnyStoreStructure[] = [];
  for (const structure of structures) {
    if ("store" in structure) stored.push(structure as AnyStoreStructure);
  }
  return stored;
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

// ─── Production 层 build（按需；复用 TickContext 的 my 结构分型索引）───────

function buildProductionLayer(
  core: EmpireInventoryIndexState["core"],
): NonNullable<EmpireInventoryIndexState["production"]> {
  counters().productionLayerBuilds += 1;
  const tickContext = getTickContextService();
  const emptySnapshot = (): ProductionStructuresSnapshot => ({
    factory: undefined,
    labs: undefined,
    powerSpawns: undefined,
    nukers: undefined,
  });
  const rooms: ProductionStructuresSnapshot[] = core.roomNames.map((roomName) => {
    const roomContext = tickContext.getRoomContext(roomName);
    if (!roomContext) return emptySnapshot();
    return {
      factory: aggregateStructures(
        storedOf(roomContext.getMyStructuresByType(STRUCTURE_FACTORY)),
      ),
      labs: aggregateStructures(
        storedOf(roomContext.getMyStructuresByType(STRUCTURE_LAB)),
      ),
      powerSpawns: aggregateStructures(
        storedOf(roomContext.getMyStructuresByType(STRUCTURE_POWER_SPAWN)),
      ),
      nukers: aggregateStructures(
        storedOf(roomContext.getMyStructuresByType(STRUCTURE_NUKER)),
      ),
    };
  });
  return { builtTick: Game.time, rooms };
}

// ─── Field 层（五个独立懒子层；房间范围 = 全部可见房间）────────────────────

function buildFieldScope(): EmpireInventoryIndexState["field"] {
  const roomNames: string[] = [];
  for (const room of Game.rooms ? Object.values(Game.rooms) : []) {
    roomNames.push(room.name);
  }
  const roomOrdinalByName = new Map<string, number>();
  roomNames.forEach((name, index) => {
    roomOrdinalByName.set(name, index);
  });
  return {
    builtTick: Game.time,
    roomNames,
    roomOrdinalByName,
  };
}

function buildFieldContainersLayer(
  field: EmpireInventoryIndexState["field"],
): NonNullable<EmpireInventoryIndexState["field"]["containers"]> {
  counters().containerLayerBuilds += 1;
  const tickContext = getTickContextService();
  const rooms: (ProductionAggregate | undefined)[] = field.roomNames.map(
    (roomName) => {
      const roomContext = tickContext.getRoomContext(roomName);
      if (!roomContext) return undefined;
      // TickContext.getContainers 与 FIND_STRUCTURES+container 同口径
      //（含非我方 container）。
      return aggregateStructures(storedOf(roomContext.getContainers()));
    },
  );
  return { builtTick: Game.time, rooms };
}

function buildLooseResourcesLayer(
  field: EmpireInventoryIndexState["field"],
): NonNullable<EmpireInventoryIndexState["field"]["looseResources"]> {
  counters().looseResourceLayerBuilds += 1;
  const rooms: ResourceAmountMap[] = field.roomNames.map((roomName) => {
    const room = Game.rooms[roomName];
    const dropped = new Map<ResourceConstant, number>();
    if (!room) return dropped;
    for (const resource of room.find(FIND_DROPPED_RESOURCES)) {
      dropped.set(
        resource.resourceType,
        (dropped.get(resource.resourceType) || 0) + resource.amount,
      );
    }
    return dropped;
  });
  return { builtTick: Game.time, rooms };
}

function buildDeadStoresLayer(
  field: EmpireInventoryIndexState["field"],
): NonNullable<EmpireInventoryIndexState["field"]["deadStores"]> {
  counters().deadStoreLayerBuilds += 1;
  const tombstones: ResourceAmountMap[] = [];
  const ruins: ResourceAmountMap[] = [];
  for (const roomName of field.roomNames) {
    const room = Game.rooms[roomName];
    const roomTombstones = new Map<ResourceConstant, number>();
    const roomRuins = new Map<ResourceConstant, number>();
    if (room) {
      for (const tombstone of room.find(FIND_TOMBSTONES)) {
        counters().storeObjectsScanned += 1;
        mergeInto(roomTombstones, scanStoreKeys(tombstone.store));
      }
      for (const ruin of room.find(FIND_RUINS)) {
        counters().storeObjectsScanned += 1;
        mergeInto(roomRuins, scanStoreKeys(ruin.store));
      }
    }
    tombstones.push(roomTombstones);
    ruins.push(roomRuins);
  }
  return { builtTick: Game.time, tombstones, ruins };
}

/**
 * creep cargo 子层：从 Game.creeps 全量建立（复用 TickContext.getAllCreeps
 * 的 tick 缓存），天然包含远采/殖民/战争单位；按 creep 当前所在房间分桶。
 */
function buildCreepCargoLayer(): CreepCargoLayer {
  counters().creepCargoLayerBuilds += 1;
  const tickContext = getTickContextService();
  const rooms = new Map<string, ResourceAmountMap>();
  const totals: ResourceAmountMap = new Map();
  let unitsCounted = 0;
  for (const creep of tickContext.getAllCreeps()) {
    counters().storeObjectsScanned += 1;
    const amounts = scanStoreKeys(creep.store);
    mergeInto(totals, amounts);
    const roomName = creep.room?.name;
    if (roomName !== undefined) {
      let bucket = rooms.get(roomName);
      if (!bucket) {
        bucket = new Map();
        rooms.set(roomName, bucket);
      }
      mergeInto(bucket, amounts);
    }
    unitsCounted += 1;
  }
  return {
    builtTick: Game.time,
    roomNames: [...rooms.keys()],
    rooms,
    totals,
    unitsCounted,
  };
}

/** power creep cargo 子层：Game.powerCreeps 单独建立（防御性 || {}）。 */
function buildPowerCreepCargoLayer(): CreepCargoLayer {
  counters().powerCreepCargoLayerBuilds += 1;
  const rooms = new Map<string, ResourceAmountMap>();
  const totals: ResourceAmountMap = new Map();
  let unitsCounted = 0;
  const powerCreeps = (Game as Game & { powerCreeps?: Record<string, PowerCreep> })
    .powerCreeps;
  for (const powerCreep of Object.values(powerCreeps || {})) {
    if (!powerCreep || !powerCreep.store) continue;
    counters().storeObjectsScanned += 1;
    const amounts = scanStoreKeys(powerCreep.store);
    mergeInto(totals, amounts);
    const roomName = powerCreep.room?.name;
    if (roomName !== undefined) {
      let bucket = rooms.get(roomName);
      if (!bucket) {
        bucket = new Map();
        rooms.set(roomName, bucket);
      }
      mergeInto(bucket, amounts);
    }
    unitsCounted += 1;
  }
  return {
    builtTick: Game.time,
    roomNames: [...rooms.keys()],
    rooms,
    totals,
    unitsCounted,
  };
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
    field: buildFieldScope(),
  };
  inventoryGlobal.__empireInventoryIndex = { tick: Game.time, index };
  return index;
}

function roomOrdinal(
  scope: { roomOrdinalByName: Map<string, number> },
  roomName: string,
): number {
  const ordinal = scope.roomOrdinalByName.get(roomName);
  return ordinal === undefined ? -1 : ordinal;
}

// ─── Core 只读视图 ───────────────────────────────────────────────────────────

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
  /** 每 room 摘要（冻结快照缓存：同 tick 同一引用，元素冻结）。 */
  roomSummaries(): readonly EmpireInventoryRoomSummary[];
  storageAmount(roomName: string, resource: ResourceConstant): number;
  terminalAmount(roomName: string, resource: ResourceConstant): number;
  /** room 内 storage+terminal 合计物理量。 */
  totalAmount(roomName: string, resource: ResourceConstant): number;
  /** room 内出现过的全部资源 key（storage+terminal 并集，冻结快照缓存）。 */
  roomResources(roomName: string): readonly ResourceConstant[];
  /** 帝国级 resource 总量（storage+terminal）。 */
  empireTotal(resource: ResourceConstant): number;
  /** 帝国级出现过的全部资源 key（冻结快照缓存）。 */
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

function buildRoomSummariesSnapshot(
  core: EmpireInventoryIndexState["core"],
): readonly EmpireInventoryRoomSummary[] {
  const summaries = core.rooms.map((record) =>
    Object.freeze({
      roomName: record.roomName,
      controllerLevel: record.controllerLevel,
      storageExists: record.storageExists,
      terminalExists: record.terminalExists,
      storageId: record.storageId,
      terminalId: record.terminalId,
    }),
  );
  return Object.freeze(summaries) as readonly EmpireInventoryRoomSummary[];
}

function buildEmpireResourcesSnapshot(
  core: EmpireInventoryIndexState["core"],
): readonly ResourceConstant[] {
  return Object.freeze([...core.empireTotals.keys()]) as readonly ResourceConstant[];
}

function buildRoomResourcesSnapshot(
  record: CoreRoomRecord,
): readonly ResourceConstant[] {
  const keys = new Set<ResourceConstant>();
  for (const resource of record.storageAmounts.keys()) keys.add(resource);
  for (const resource of record.terminalAmounts.keys()) keys.add(resource);
  return Object.freeze([...keys]);
}

function createCoreView(index: EmpireInventoryIndexState): EmpireInventoryCoreView {
  const core = index.core;
  const roomNames = Object.freeze([...core.roomNames]) as readonly string[];
  return {
    roomNames,
    roomSummaries: () => {
      if (!core.roomSummariesSnapshot) {
        core.roomSummariesSnapshot = buildRoomSummariesSnapshot(core);
      }
      return core.roomSummariesSnapshot;
    },
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
    roomResources: (roomName) => {
      const ordinal = roomOrdinal(core, roomName);
      if (ordinal < 0) return EMPTY_RESOURCES;
      if (!core.roomResourcesSnapshots) {
        core.roomResourcesSnapshots = core.rooms.map(() => undefined);
      }
      const existing = core.roomResourcesSnapshots[ordinal];
      if (existing) return existing;
      const snapshot = buildRoomResourcesSnapshot(core.rooms[ordinal]);
      core.roomResourcesSnapshots[ordinal] = snapshot;
      return snapshot;
    },
    empireTotal: (resource) => frozenAmount(core.empireTotals.get(resource)),
    empireResources: () => {
      if (!core.empireResourcesSnapshot) {
        core.empireResourcesSnapshot = buildEmpireResourcesSnapshot(core);
      }
      return core.empireResourcesSnapshot;
    },
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

/** Core 层入口：首次调用构建，同 tick 复用同一 view 引用。 */
export function getEmpireInventoryCore(): EmpireInventoryCoreView {
  const index = ensureIndex();
  if (!index.coreView) {
    index.coreView = createCoreView(index);
  }
  return index.coreView;
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
  /** 各结构聚合中出现过的资源 key（冻结快照；不做 RESOURCES_ALL 探测）。 */
  factoryResources(roomName: string): readonly ResourceConstant[];
  labResources(roomName: string): readonly ResourceConstant[];
  powerSpawnResources(roomName: string): readonly ResourceConstant[];
  nukerResources(roomName: string): readonly ResourceConstant[];
}

function createProductionAggregateAccessors(
  core: EmpireInventoryIndexState["core"],
  production: NonNullable<EmpireInventoryIndexState["production"]>,
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
    resources: (roomName: string): readonly ResourceConstant[] => {
      const ordinal = roomOrdinal(core, roomName);
      if (ordinal < 0) return EMPTY_RESOURCES;
      return select(production.rooms[ordinal])?.resources ?? EMPTY_RESOURCES;
    },
  };
}

/** Production 层入口：Core 已建前提下按需构建（同 tick 至多一次）。 */
export function getEmpireInventoryProduction(): EmpireInventoryProductionView {
  const index = ensureIndex();
  if (!index.production || index.production.builtTick !== Game.time) {
    index.production = buildProductionLayer(index.core);
    index.productionView = undefined;
  }
  if (!index.productionView) {
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
    index.productionView = {
      factoryCount: factory.count,
      labCount: labs.count,
      powerSpawnCount: powerSpawns.count,
      nukerCount: nukers.count,
      factoryAmount: factory.amount,
      labAmount: labs.amount,
      powerSpawnAmount: powerSpawns.amount,
      nukerAmount: nukers.amount,
      factoryResources: factory.resources,
      labResources: labs.resources,
      powerSpawnResources: powerSpawns.resources,
      nukerResources: nukers.resources,
    };
  }
  return index.productionView;
}

// ─── Field 子层只读视图 ─────────────────────────────────────────────────────

/** containers 子层视图。 */
export interface EmpireInventoryFieldContainersView {
  containerCount(roomName: string): number;
  containerAmount(roomName: string, resource: ResourceConstant): number;
  /** 容器聚合中出现过的资源 key（冻结快照）。 */
  containerResources(roomName: string): readonly ResourceConstant[];
}

/** looseResources 子层视图（dropped resources）。 */
export interface EmpireInventoryFieldLooseResourcesView {
  droppedAmount(roomName: string, resource: ResourceConstant): number;
}

/** deadStores 子层视图（tombstone + ruin）。 */
export interface EmpireInventoryFieldDeadStoresView {
  tombstoneAmount(roomName: string, resource: ResourceConstant): number;
  ruinAmount(roomName: string, resource: ResourceConstant): number;
}

/** creep / power creep cargo 子层视图（总量 + per-room）。 */
export interface EmpireInventoryCreepCargoView {
  /** 全部单位（含远采/殖民/战争）的 cargo 合计。 */
  total(resource: ResourceConstant): number;
  /** 指定房间内全部单位的 cargo 量（按单位当前所在房间）。 */
  roomAmount(roomName: string, resource: ResourceConstant): number;
  /** 出现过 cargo 的房间名（冻结快照）。 */
  roomNames(): readonly string[];
  /** cargo 中出现过的资源 key（冻结快照）。 */
  resources(): readonly ResourceConstant[];
  /** 被统计的单位数。 */
  unitsCounted(): number;
}

function fieldRoomOrdinal(
  field: EmpireInventoryIndexState["field"],
  roomName: string,
): number {
  return roomOrdinal(field, roomName);
}

/** containers 子层入口：按需构建（同 tick 至多一次），view 缓存。 */
export function getEmpireInventoryFieldContainers(): EmpireInventoryFieldContainersView {
  const index = ensureIndex();
  const field = index.field;
  if (!field.containers || field.containers.builtTick !== Game.time) {
    field.containers = buildFieldContainersLayer(field);
    field.containersView = undefined;
  }
  if (!field.containersView) {
    const containers = field.containers;
    field.containersView = {
      containerCount: (roomName) => {
        const ordinal = fieldRoomOrdinal(field, roomName);
        return ordinal < 0 ? 0 : (containers.rooms[ordinal]?.count ?? 0);
      },
      containerAmount: (roomName, resource) => {
        const ordinal = fieldRoomOrdinal(field, roomName);
        return ordinal < 0
          ? 0
          : frozenAmount(containers.rooms[ordinal]?.amounts.get(resource));
      },
      containerResources: (roomName) => {
        const ordinal = fieldRoomOrdinal(field, roomName);
        return ordinal < 0
          ? EMPTY_RESOURCES
          : (containers.rooms[ordinal]?.resources ?? EMPTY_RESOURCES);
      },
    };
  }
  return field.containersView;
}

/** looseResources 子层入口：按需构建（同 tick 至多一次），view 缓存。 */
export function getEmpireInventoryFieldLooseResources(): EmpireInventoryFieldLooseResourcesView {
  const index = ensureIndex();
  const field = index.field;
  if (!field.looseResources || field.looseResources.builtTick !== Game.time) {
    field.looseResources = buildLooseResourcesLayer(field);
    field.looseResourcesView = undefined;
  }
  if (!field.looseResourcesView) {
    const loose = field.looseResources;
    field.looseResourcesView = {
      droppedAmount: (roomName, resource) => {
        const ordinal = fieldRoomOrdinal(field, roomName);
        return ordinal < 0 ? 0 : frozenAmount(loose.rooms[ordinal].get(resource));
      },
    };
  }
  return field.looseResourcesView;
}

/** deadStores 子层入口：按需构建（同 tick 至多一次），view 缓存。 */
export function getEmpireInventoryFieldDeadStores(): EmpireInventoryFieldDeadStoresView {
  const index = ensureIndex();
  const field = index.field;
  if (!field.deadStores || field.deadStores.builtTick !== Game.time) {
    field.deadStores = buildDeadStoresLayer(field);
    field.deadStoresView = undefined;
  }
  if (!field.deadStoresView) {
    const dead = field.deadStores;
    field.deadStoresView = {
      tombstoneAmount: (roomName, resource) => {
        const ordinal = fieldRoomOrdinal(field, roomName);
        return ordinal < 0
          ? 0
          : frozenAmount(dead.tombstones[ordinal].get(resource));
      },
      ruinAmount: (roomName, resource) => {
        const ordinal = fieldRoomOrdinal(field, roomName);
        return ordinal < 0 ? 0 : frozenAmount(dead.ruins[ordinal].get(resource));
      },
    };
  }
  return field.deadStoresView;
}

function createCreepCargoView(layer: CreepCargoLayer): EmpireInventoryCreepCargoView {
  const roomNames = Object.freeze([...layer.roomNames]) as readonly string[];
  const resources = Object.freeze([...layer.totals.keys()]) as readonly ResourceConstant[];
  return {
    total: (resource) => frozenAmount(layer.totals.get(resource)),
    roomAmount: (roomName, resource) =>
      frozenAmount(layer.rooms.get(roomName)?.get(resource)),
    roomNames: () => roomNames,
    resources: () => resources,
    unitsCounted: () => layer.unitsCounted,
  };
}

/** creep cargo 子层入口：Game.creeps 全量（含远采/殖民/战争单位）。 */
export function getEmpireInventoryCreepCargo(): EmpireInventoryCreepCargoView {
  const index = ensureIndex();
  const field = index.field;
  if (!field.creepCargo || field.creepCargo.builtTick !== Game.time) {
    field.creepCargo = buildCreepCargoLayer();
    field.creepCargoView = undefined;
  }
  if (!field.creepCargoView) {
    field.creepCargoView = createCreepCargoView(field.creepCargo);
  }
  return field.creepCargoView;
}

/** power creep cargo 子层入口：Game.powerCreeps 全量（独立于 creep cargo）。 */
export function getEmpireInventoryPowerCreepCargo(): EmpireInventoryCreepCargoView {
  const index = ensureIndex();
  const field = index.field;
  if (!field.powerCreepCargo || field.powerCreepCargo.builtTick !== Game.time) {
    field.powerCreepCargo = buildPowerCreepCargoLayer();
    field.powerCreepCargoView = undefined;
  }
  if (!field.powerCreepCargoView) {
    field.powerCreepCargoView = createCreepCargoView(field.powerCreepCargo);
  }
  return field.powerCreepCargoView;
}

// ─── Field 聚合视图（兼容入口：方法各自懒委托到对应子层）──────────────────

export interface EmpireInventoryFieldView {
  /** Field 房间范围（全部可见房间，冻结快照）。 */
  readonly roomNames: readonly string[];
  containerCount(roomName: string): number;
  containerAmount(roomName: string, resource: ResourceConstant): number;
  droppedAmount(roomName: string, resource: ResourceConstant): number;
  tombstoneAmount(roomName: string, resource: ResourceConstant): number;
  ruinAmount(roomName: string, resource: ResourceConstant): number;
  /** 帝国级 my creep store 合计（Game.creeps 全量）。 */
  creepTotal(resource: ResourceConstant): number;
  /** 帝国级 power creep store 合计。 */
  powerCreepTotal(resource: ResourceConstant): number;
  /** per-room creep cargo 量。 */
  creepRoomAmount(roomName: string, resource: ResourceConstant): number;
}

/**
 * Field 聚合入口：不立即构建任何子层——各方法首次调用才触发对应
 * 子层构建（同 tick 至多一次），view 本身缓存。
 */
export function getEmpireInventoryField(): EmpireInventoryFieldView {
  const index = ensureIndex();
  const field = index.field;
  if (!field.compositeView) {
    field.compositeView = {
      roomNames: Object.freeze([...field.roomNames]) as readonly string[],
      containerCount: (roomName) =>
        getEmpireInventoryFieldContainers().containerCount(roomName),
      containerAmount: (roomName, resource) =>
        getEmpireInventoryFieldContainers().containerAmount(roomName, resource),
      droppedAmount: (roomName, resource) =>
        getEmpireInventoryFieldLooseResources().droppedAmount(roomName, resource),
      tombstoneAmount: (roomName, resource) =>
        getEmpireInventoryFieldDeadStores().tombstoneAmount(roomName, resource),
      ruinAmount: (roomName, resource) =>
        getEmpireInventoryFieldDeadStores().ruinAmount(roomName, resource),
      creepTotal: (resource) =>
        getEmpireInventoryCreepCargo().total(resource),
      powerCreepTotal: (resource) =>
        getEmpireInventoryPowerCreepCargo().total(resource),
      creepRoomAmount: (roomName, resource) =>
        getEmpireInventoryCreepCargo().roomAmount(roomName, resource),
    };
  }
  return field.compositeView;
}
