import { getMemoryService, getTickContextService, getTreasuryService } from "@/runtime/runtimeServices";

const SAMPLE_INTERVAL = 5;
const MAX_SAMPLES = 300;

interface ProductionSample {
  tick: number;
  energyAvailable: number;
  energyCapacity: number;
  droppedEnergy: number;
  containerEnergy: number;
  storageEnergy: number;
  terminalEnergy: number;
  linkEnergy: number;
  labEnergy: number;
  factoryEnergy: number;
  sourceEnergy: number;
  workerCount: number;
  carrierCount: number;
  harvesterCount: number;
  spawnSpawning: number;
  controllerLevel: number;
  controllerProgress: number;
}

interface ProductionSummary {
  roomName: string;
  ticks: number;
  looseEnergyTrend: number;
  sourceEnergyTrend: number;
  upgradeRate: number;
  avgSpawnBusy: number;
  avgWorkers: number;
  avgCarriers: number;
  avgHarvesters: number;
}

interface GlobalProductionSummary {
  rooms: number;
  totalLooseEnergy: number;
  totalStoredEnergy: number;
  totalSourceEnergy: number;
  avgSpawnBusy: number;
  avgUpgradeRate: number;
  avgLooseTrend: number;
}

interface RoomProductionSnapshot {
  tick: number;
  looseEnergy: number;
  storedEnergy: number;
  sourceEnergy: number;
  workerCount: number;
  carrierCount: number;
  harvesterCount: number;
  spawnSpawning: number;
  controllerLevel: number;
  controllerProgress: number;
}

export interface ProductionSignal {
  looseEnergyTrend: number;
  sourceEnergyTrend: number;
  upgradeRate: number;
  spawnBusy: number;
}

type ProductionSampleStore = Record<string, ProductionSample[]>;

type RuntimeGlobalWithProduction = typeof global & {
  __productionSamples?: ProductionSampleStore;
};

const runtimeGlobal: RuntimeGlobalWithProduction = global;

function ensureSampleStore(): ProductionSampleStore {
  if (!runtimeGlobal.__productionSamples) {
    runtimeGlobal.__productionSamples = {};
  }
  return runtimeGlobal.__productionSamples;
}

function ensurePersistentStore(): Record<string, { updatedAt: number; signal?: ProductionSignal; latest?: RoomProductionSnapshot }> {
  const analytics = getMemoryService().ensureAnalytics();
  analytics.production = analytics.production || {};

  if (!analytics.production.rooms) {
    analytics.production.rooms = {};
  }

  return analytics.production.rooms;
}

function getDroppedEnergy(room: Room): number {
  const roomContext = getTickContextService().getRoomContext(room);
  const dropped = roomContext?.getDroppedEnergyResources() || [];

  return dropped.reduce((sum, resource) => sum + resource.amount, 0);
}

function getContainerEnergy(room: Room): number {
  const roomContext = getTickContextService().getRoomContext(room);
  // 走单趟类型索引而非对全部结构 filter；无 context 的 mock 环境回退原路径。
  const containers = roomContext
    ? roomContext.getStructuresByType(STRUCTURE_CONTAINER)
    : (room.find(FIND_STRUCTURES).filter(
        (structure): structure is StructureContainer => structure.structureType === STRUCTURE_CONTAINER,
      ));

  return containers.reduce((sum, container) => {
    const energy = (container as StructureContainer).store.getUsedCapacity(RESOURCE_ENERGY);
    return energy > 0 ? sum + energy : sum;
  }, 0);
}

function getStructureEnergy(room: Room, structureType: StructureConstant): number {
  const roomContext = getTickContextService().getRoomContext(room);
  const structures = roomContext
    ? roomContext.getStructuresByType(structureType)
    : (room.find(FIND_STRUCTURES).filter(
        (structure): structure is AnyStoreStructure => structure.structureType === structureType,
      ));

  return structures.reduce((sum, structure) => {
    const storeStructure = structure as AnyStoreStructure;
    const energy = storeStructure.store?.getUsedCapacity(RESOURCE_ENERGY);
    return Number.isFinite(energy) ? sum + (energy as number) : sum;
  }, 0);
}

function getRoleCount(room: Room, role: "worker" | "carrier" | "harvester"): number {
  return getTickContextService().getCreepsByRoom(room.name).filter((creep) => creep.memory.role === role).length;
}

function createSample(room: Room): ProductionSample {
  const controller = room.controller;
  // storage/terminal 能量读取迁移至 Treasury observation（统一稀疏索引；
  // 同 tick 首次访问构建并缓存，不再逐房直读 store）。runProductionMonitor
  // 只遍历 my rooms，与 Treasury observation 管辖范围一致。
  const treasuryObservation = getTreasuryService().observation();

  return {
    tick: Game.time,
    energyAvailable: room.energyAvailable,
    energyCapacity: room.energyCapacityAvailable,
    droppedEnergy: getDroppedEnergy(room),
    containerEnergy: getContainerEnergy(room),
    storageEnergy: treasuryObservation.amount(room.name, "storage", RESOURCE_ENERGY),
    terminalEnergy: treasuryObservation.amount(room.name, "terminal", RESOURCE_ENERGY),
    linkEnergy: getStructureEnergy(room, STRUCTURE_LINK),
    labEnergy: getStructureEnergy(room, STRUCTURE_LAB),
    factoryEnergy: getStructureEnergy(room, STRUCTURE_FACTORY),
    sourceEnergy: (getTickContextService().getRoomContext?.(room)?.getSources() || room.find(FIND_SOURCES)).reduce(
      (sum, source) => sum + source.energy,
      0,
    ),
    workerCount: getRoleCount(room, "worker"),
    carrierCount: getRoleCount(room, "carrier"),
    harvesterCount: getRoleCount(room, "harvester"),
    spawnSpawning: getTickContextService().getSpawnsByRoom(room.name).filter((spawn) => !!spawn.spawning).length,
    controllerLevel: controller ? controller.level : 0,
    controllerProgress: controller ? controller.progress : 0,
  };
}

function toSnapshot(sample: ProductionSample): RoomProductionSnapshot {
  return {
    tick: sample.tick,
    looseEnergy: sample.droppedEnergy + sample.containerEnergy,
    storedEnergy: sample.storageEnergy + sample.terminalEnergy + sample.linkEnergy + sample.labEnergy + sample.factoryEnergy,
    sourceEnergy: sample.sourceEnergy,
    workerCount: sample.workerCount,
    carrierCount: sample.carrierCount,
    harvesterCount: sample.harvesterCount,
    spawnSpawning: sample.spawnSpawning,
    controllerLevel: sample.controllerLevel,
    controllerProgress: sample.controllerProgress,
  };
}

function persistRoomState(roomName: string, samples: ProductionSample[]): void {
  const persistent = ensurePersistentStore();
  const latest = samples.length > 0 ? samples[samples.length - 1] : undefined;
  const signal = summarizeWindow(samples);

  const nextState: { updatedAt: number; signal?: ProductionSignal; latest?: RoomProductionSnapshot } = {
    updatedAt: Game.time,
  };

  if (latest) {
    nextState.latest = toSnapshot(latest);
  }
  if (signal) {
    nextState.signal = signal;
  }

  persistent[roomName] = nextState;
}

function pushSample(room: Room): void {
  const sampleStore = ensureSampleStore();
  const samples = sampleStore[room.name] || [];
  samples.push(createSample(room));

  // 单次 splice 截断代替逐条 shift（外部按数组顺序消费样本，保持形态不变）。
  if (samples.length > MAX_SAMPLES) {
    samples.splice(0, samples.length - MAX_SAMPLES);
  }

  sampleStore[room.name] = samples;
  persistRoomState(room.name, samples);
}

function summarizeRoom(roomName: string, samples: ProductionSample[]): ProductionSummary | null {
  if (samples.length < 2) {
    return null;
  }

  const first = samples[0];
  const last = samples[samples.length - 1];
  const ticks = Math.max(1, last.tick - first.tick);

  const looseFirst = first.droppedEnergy + first.containerEnergy;
  const looseLast = last.droppedEnergy + last.containerEnergy;
  const looseEnergyTrend = (looseLast - looseFirst) / ticks;
  const sourceEnergyTrend = (last.sourceEnergy - first.sourceEnergy) / ticks;

  let upgradeRate = 0;
  if (last.controllerLevel === first.controllerLevel) {
    upgradeRate = (last.controllerProgress - first.controllerProgress) / ticks;
  }

  const avgSpawnBusy = samples.reduce((sum, sample) => sum + sample.spawnSpawning, 0) / samples.length;
  const avgWorkers = samples.reduce((sum, sample) => sum + sample.workerCount, 0) / samples.length;
  const avgCarriers = samples.reduce((sum, sample) => sum + sample.carrierCount, 0) / samples.length;
  const avgHarvesters = samples.reduce((sum, sample) => sum + sample.harvesterCount, 0) / samples.length;

  return {
    roomName,
    ticks,
    looseEnergyTrend,
    sourceEnergyTrend,
    upgradeRate,
    avgSpawnBusy,
    avgWorkers,
    avgCarriers,
    avgHarvesters,
  };
}

function summarizeWindow(samples: ProductionSample[], windowSize = 30): ProductionSignal | null {
  if (samples.length < 2) {
    return null;
  }

  const window = samples.slice(Math.max(0, samples.length - windowSize));
  if (window.length < 2) {
    return null;
  }

  const first = window[0];
  const last = window[window.length - 1];
  const ticks = Math.max(1, last.tick - first.tick);

  const looseFirst = first.droppedEnergy + first.containerEnergy;
  const looseLast = last.droppedEnergy + last.containerEnergy;
  const looseEnergyTrend = (looseLast - looseFirst) / ticks;
  const sourceEnergyTrend = (last.sourceEnergy - first.sourceEnergy) / ticks;
  const spawnBusy = window.reduce((sum, sample) => sum + sample.spawnSpawning, 0) / window.length;

  let upgradeRate = 0;
  if (last.controllerLevel === first.controllerLevel) {
    upgradeRate = (last.controllerProgress - first.controllerProgress) / ticks;
  }

  return {
    looseEnergyTrend,
    sourceEnergyTrend,
    upgradeRate,
    spawnBusy,
  };
}

function cleanupRoomSamples(): void {
  const rooms = new Set(getTickContextService().getMyRooms().map((room) => room.name));
  const sampleStore = ensureSampleStore();
  const persistentStore = ensurePersistentStore();

  for (const roomName of Object.keys(sampleStore)) {
    if (!rooms.has(roomName)) {
      delete sampleStore[roomName];
    }
  }

  for (const roomName of Object.keys(persistentStore)) {
    if (!rooms.has(roomName)) {
      delete persistentStore[roomName];
    }
  }
}

function printSummary(summary: ProductionSummary): void {
  console.log(
    `[prod] ${summary.roomName} ticks=${summary.ticks} looseTrend=${summary.looseEnergyTrend.toFixed(2)} sourceTrend=${summary.sourceEnergyTrend.toFixed(2)} upgradeRate=${summary.upgradeRate.toFixed(2)} spawnBusy=${summary.avgSpawnBusy.toFixed(2)} workers=${summary.avgWorkers.toFixed(2)} carriers=${summary.avgCarriers.toFixed(2)} harvesters=${summary.avgHarvesters.toFixed(2)}`,
  );
}

export function runProductionMonitor(): void {
  if (Memory.cfg?.productionMonitor?.enabled === false) {
    return;
  }

  if (Game.time % SAMPLE_INTERVAL !== 0) {
    return;
  }

  const rooms = getTickContextService().getMyRooms();
  for (const room of rooms) {
    pushSample(room);
  }

  cleanupRoomSamples();
}

export function reportProduction(roomName?: string): void {
  const sampleStore = ensureSampleStore();
  const persistentStore = ensurePersistentStore();

  if (roomName) {
    const summary = summarizeRoom(roomName, sampleStore[roomName] || []);
    if (!summary) {
      const persisted = persistentStore[roomName];
      if (!persisted?.latest && !persisted?.signal) {
        console.log(`[prod] ${roomName} no enough samples`);
        return;
      }

      const latest = persisted.latest;
      const signal = persisted.signal;
      console.log(
        `[prod] ${roomName} persisted tick=${latest?.tick ?? -1} loose=${latest?.looseEnergy ?? 0} stored=${latest?.storedEnergy ?? 0} source=${latest?.sourceEnergy ?? 0} looseTrend=${signal?.looseEnergyTrend?.toFixed(2) ?? "n/a"} sourceTrend=${signal?.sourceEnergyTrend?.toFixed(2) ?? "n/a"} upgradeRate=${signal?.upgradeRate?.toFixed(2) ?? "n/a"} spawnBusy=${signal?.spawnBusy?.toFixed(2) ?? "n/a"}`,
      );
      return;
    }

    printSummary(summary);
    return;
  }

  for (const [name, samples] of Object.entries(sampleStore)) {
    const summary = summarizeRoom(name, samples);
    if (summary) {
      printSummary(summary);
    }
  }
}

export function reportProductionGlobal(): void {
  const sampleStore = ensureSampleStore();
  const persistentStore = ensurePersistentStore();
  const summaries: ProductionSummary[] = [];

  for (const [name, samples] of Object.entries(sampleStore)) {
    const summary = summarizeRoom(name, samples);
    if (summary) {
      summaries.push(summary);
    }
  }

  if (summaries.length === 0) {
    const persistedRooms = Object.values(persistentStore);
    if (persistedRooms.length > 0) {
      const globalSummaryFromMemory: GlobalProductionSummary = {
        rooms: persistedRooms.length,
        totalLooseEnergy: persistedRooms.reduce((sum, room) => sum + (room.latest?.looseEnergy ?? 0), 0),
        totalStoredEnergy: persistedRooms.reduce((sum, room) => sum + (room.latest?.storedEnergy ?? 0), 0),
        totalSourceEnergy: persistedRooms.reduce((sum, room) => sum + (room.latest?.sourceEnergy ?? 0), 0),
        avgSpawnBusy:
          persistedRooms.reduce((sum, room) => sum + (room.signal?.spawnBusy ?? 0), 0) / persistedRooms.length,
        avgUpgradeRate:
          persistedRooms.reduce((sum, room) => sum + (room.signal?.upgradeRate ?? 0), 0) / persistedRooms.length,
        avgLooseTrend:
          persistedRooms.reduce((sum, room) => sum + (room.signal?.looseEnergyTrend ?? 0), 0) / persistedRooms.length,
      };

      console.log(
        `[prod-global] rooms=${globalSummaryFromMemory.rooms} loose=${globalSummaryFromMemory.totalLooseEnergy} stored=${globalSummaryFromMemory.totalStoredEnergy} source=${globalSummaryFromMemory.totalSourceEnergy} avgSpawnBusy=${globalSummaryFromMemory.avgSpawnBusy.toFixed(2)} avgUpgradeRate=${globalSummaryFromMemory.avgUpgradeRate.toFixed(2)} avgLooseTrend=${globalSummaryFromMemory.avgLooseTrend.toFixed(2)} source=persisted`,
      );
      return;
    }

    console.log("[prod] global no enough samples");
    return;
  }

  const latestSamples = Object.values(sampleStore)
    .map((samples) => (samples.length > 0 ? samples[samples.length - 1] : null))
    .filter((sample): sample is ProductionSample => sample !== null);

  const globalSummary: GlobalProductionSummary = {
    rooms: summaries.length,
    totalLooseEnergy: latestSamples.reduce((sum, s) => sum + s.droppedEnergy + s.containerEnergy, 0),
    totalStoredEnergy: latestSamples.reduce(
      (sum, s) => sum + s.storageEnergy + s.terminalEnergy + s.linkEnergy + s.labEnergy + s.factoryEnergy,
      0,
    ),
    totalSourceEnergy: latestSamples.reduce((sum, s) => sum + s.sourceEnergy, 0),
    avgSpawnBusy: summaries.reduce((sum, s) => sum + s.avgSpawnBusy, 0) / summaries.length,
    avgUpgradeRate: summaries.reduce((sum, s) => sum + s.upgradeRate, 0) / summaries.length,
    avgLooseTrend: summaries.reduce((sum, s) => sum + s.looseEnergyTrend, 0) / summaries.length,
  };

  console.log(
    `[prod-global] rooms=${globalSummary.rooms} loose=${globalSummary.totalLooseEnergy} stored=${globalSummary.totalStoredEnergy} source=${globalSummary.totalSourceEnergy} avgSpawnBusy=${globalSummary.avgSpawnBusy.toFixed(2)} avgUpgradeRate=${globalSummary.avgUpgradeRate.toFixed(2)} avgLooseTrend=${globalSummary.avgLooseTrend.toFixed(2)}`,
  );
}

export function getProductionSignal(roomName: string): ProductionSignal | null {
  const sampleStore = ensureSampleStore();
  const samples = sampleStore[roomName] || [];
  const signal = summarizeWindow(samples);
  if (signal) {
    return signal;
  }

  const persistent = ensurePersistentStore()[roomName];
  return persistent?.signal ?? null;
}

export function registerProductionApi(): void {
  global.reportProduction = reportProduction;
  global.reportProductionGlobal = reportProductionGlobal;
}
