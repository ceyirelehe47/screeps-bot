/**
 * Treasury Asset Observation——storage/terminal 不可变稀疏物理观察。
 *
 * 构建约束（性能与语义，继承 empireInventoryIndex 已验证的模式）：
 * - 房间源由外部注入（生产=TickContext.getMyRooms()），本模块零 room.find；
 * - 每个受管辖 Store 只做一次 Object.keys 稀疏枚举 + 一次无参 capacity 读，
 *   绝不做 RESOURCES_ALL × getUsedCapacity 全量探测；
 * - 只保留数值与 structureId，不保留任何 Game Store/Structure 活引用，
 *   构建后不存在 live 回退读（fallbackLiveReads 恒 0）；
 * - 全部数据 deepFreeze：同 tick 同 epoch 的 Observed 不可变；
 * - 物理事实绝不持久化到 Memory。
 */

import {
  type TreasuryEpoch,
  type TreasuryLocationKind,
  type TreasuryLocationObservation,
  type TreasuryObservationData,
  type TreasuryObservationScope,
  type TreasuryObservationView,
  type TreasuryRoomObservation,
  treasuryLocationKey,
} from "@/runtime/treasury/types";

/** 审计全局根上的世界序槽（私有全局槽；global reset 归零不影响保守方向）。 */
type GlobalWithWorldSequence = typeof global & {
  __treasuryWorldSequence?: number;
};

const worldSequenceGlobal = global as GlobalWithWorldSequence;

/** 受控世界序（单调计数；观察覆盖判定的世界侧锚点——§6.2）。 */
export function readTreasuryWorldSequence(): number {
  return worldSequenceGlobal.__treasuryWorldSequence ?? 0;
}

/** 受控世界真实更新时递增（同步 adapter 写世界 / 测试宿主施加效果时调用）。 */
export function bumpTreasuryWorldSequence(): void {
  worldSequenceGlobal.__treasuryWorldSequence = (worldSequenceGlobal.__treasuryWorldSequence ?? 0) + 1;
}

export interface TreasuryObservationBuildOptions {
  readonly scope: TreasuryObservationScope;
  readonly epochSeq: number;
  readonly rooms: readonly Room[];
  readonly onStoreScanned?: (nonZeroKeys: number) => void;
}

interface LocationScan {
  exists: boolean;
  structureId: string | undefined;
  amounts: Record<string, number>;
  usedCapacity: number;
  freeCapacity: number;
  nonZeroKeys: number;
}

function scanLocation(structure: StructureStorage | StructureTerminal | undefined): LocationScan {
  if (!structure) {
    return {
      exists: false,
      structureId: undefined,
      amounts: {},
      usedCapacity: 0,
      freeCapacity: 0,
      nonZeroKeys: 0,
    };
  }
  // 单次 Object.keys 稀疏枚举：store 本体即资源→数量记录（ts 类型上隐藏）。
  const record = structure.store as unknown as Record<string, unknown>;
  const amounts: Record<string, number> = {};
  let nonZeroKeys = 0;
  for (const key of Object.keys(record)) {
    const amount = record[key];
    if (typeof amount === "number" && amount > 0) {
      amounts[key] = amount;
      nonZeroKeys += 1;
    }
  }
  return {
    exists: true,
    structureId: structure.id,
    amounts,
    usedCapacity: structure.store.getUsedCapacity(),
    freeCapacity: structure.store.getFreeCapacity(),
    nonZeroKeys,
  };
}

function freezeLocation(
  roomName: string,
  kind: TreasuryLocationKind,
  scan: LocationScan,
): TreasuryLocationObservation {
  return Object.freeze({
    roomName,
    kind,
    exists: scan.exists,
    structureId: scan.structureId,
    amounts: Object.freeze(scan.amounts),
    usedCapacity: scan.usedCapacity,
    freeCapacity: scan.freeCapacity,
  });
}

function deepFreezeRoom(room: TreasuryRoomObservation): TreasuryRoomObservation {
  return Object.freeze({
    roomName: room.roomName,
    storage: room.storage,
    terminal: room.terminal,
  });
}

function createObservationView(data: TreasuryObservationData): TreasuryObservationView {
  const roomsByOrdinal: readonly TreasuryRoomObservation[] = data.rooms;
  const roomByName = new Map<string, TreasuryRoomObservation>();
  for (const room of roomsByOrdinal) roomByName.set(room.roomName, room);

  let cachedEmpireResources: readonly string[] | undefined;
  const roomResourcesCache = new Map<string, readonly string[]>();

  const locationOf = (
    roomName: string,
    kind: TreasuryLocationKind,
  ): TreasuryLocationObservation => {
    const room = roomByName.get(roomName);
    if (!room) {
      return Object.freeze({
        roomName,
        kind,
        exists: false,
        structureId: undefined,
        amounts: Object.freeze({}) as Readonly<Record<string, number>>,
        usedCapacity: 0,
        freeCapacity: 0,
      });
    }
    return kind === "storage" ? room.storage : room.terminal;
  };

  return {
    data,
    epoch: data.epoch,
    roomNames(): readonly string[] {
      return roomsByOrdinal.map((room) => room.roomName);
    },
    hasRoom(roomName: string): boolean {
      return roomByName.has(roomName);
    },
    locationExists(roomName: string, kind: TreasuryLocationKind): boolean {
      return locationOf(roomName, kind).exists;
    },
    location: locationOf,
    amount(roomName: string, kind: TreasuryLocationKind, resource: string): number {
      return locationOf(roomName, kind).amounts[resource] ?? 0;
    },
    roomAmount(roomName: string, resource: string): number {
      const room = roomByName.get(roomName);
      if (!room) return 0;
      return (room.storage.amounts[resource] ?? 0) + (room.terminal.amounts[resource] ?? 0);
    },
    roomResources(roomName: string): readonly string[] {
      const cached = roomResourcesCache.get(roomName);
      if (cached) return cached;
      const room = roomByName.get(roomName);
      const merged = new Set<string>();
      if (room) {
        for (const key of Object.keys(room.storage.amounts)) merged.add(key);
        for (const key of Object.keys(room.terminal.amounts)) merged.add(key);
      }
      const snapshot = Object.freeze([...merged]);
      roomResourcesCache.set(roomName, snapshot);
      return snapshot;
    },
    empireTotal(resource: string): number {
      return data.empireTotals[resource] ?? 0;
    },
    empireResources(): readonly string[] {
      if (!cachedEmpireResources) {
        cachedEmpireResources = Object.freeze(Object.keys(data.empireTotals));
      }
      return cachedEmpireResources;
    },
    usedCapacity(roomName: string, kind: TreasuryLocationKind): number {
      return locationOf(roomName, kind).usedCapacity;
    },
    freeCapacity(roomName: string, kind: TreasuryLocationKind): number {
      return locationOf(roomName, kind).freeCapacity;
    },
    isStale(): boolean {
      return data.epoch.observedAtTick !== Game.time;
    },
  };
}

/**
 * 构建一次观察。shared scope 由 facade 缓存复用；market-fresh scope
 * 每次调用都新建（调用方保证不落缓存，fresh 语义）。
 */
export function buildTreasuryObservation(
  options: TreasuryObservationBuildOptions,
): TreasuryObservationView {
  const epoch: TreasuryEpoch = {
    scope: options.scope,
    epochSeq: options.epochSeq,
    observedAtTick: Game.time,
    worldSequence: readTreasuryWorldSequence(),
  };

  const rooms: TreasuryRoomObservation[] = [];
  const empireTotals: Record<string, number> = {};

  for (const room of options.rooms) {
    const storageScan = scanLocation(room.storage ?? undefined);
    const terminalScan = scanLocation(room.terminal ?? undefined);
    // 只对真实存在的 Store 计数枚举（missing 位置无枚举成本）；
    // nonZeroKeys 复用 scanLocation 的单次枚举结果。
    if (storageScan.exists) options.onStoreScanned?.(storageScan.nonZeroKeys);
    if (terminalScan.exists) options.onStoreScanned?.(terminalScan.nonZeroKeys);

    rooms.push(
      deepFreezeRoom({
        roomName: room.name,
        storage: freezeLocation(room.name, "storage", storageScan),
        terminal: freezeLocation(room.name, "terminal", terminalScan),
      }),
    );
    // 帝国总量 = 全部位置桶之和（构建期求和；missing 位置贡献 0）。
    for (const scan of [storageScan, terminalScan]) {
      for (const [resource, amount] of Object.entries(scan.amounts)) {
        empireTotals[resource] = (empireTotals[resource] ?? 0) + amount;
      }
    }
  }

  const data: TreasuryObservationData = Object.freeze({
    epoch: Object.freeze(epoch),
    rooms: Object.freeze(rooms),
    empireTotals: Object.freeze(empireTotals),
  });

  return createObservationView(data);
}

/** 供 shadow/测试用的位置桶枚举（冻结数据，无 Game 读）。 */
export function treasuryLocationBuckets(
  observation: TreasuryObservationView,
): readonly TreasuryLocationObservation[] {
  const buckets: TreasuryLocationObservation[] = [];
  for (const room of observation.data.rooms) {
    buckets.push(room.storage, room.terminal);
  }
  return buckets;
}

export { treasuryLocationKey };
