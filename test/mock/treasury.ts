/**
 * Treasury 测试共享 mock helper。
 *
 * - Store mock：资源键放原型实例自身（可枚举，模拟真实 Screeps Store 的
 *   资源→数量记录），方法放原型（不可枚举）——Object.keys 只暴露资源 key，
 *   与游戏内稀疏枚举语义一致；
 * - Room mock：storage/terminal 属性直接挂对象（非 room.find）；
 * - Game.time 可写、Memory 每用例由 setup.ts 重建。
 */

export interface StoreSpec {
  resources?: Record<string, number>;
  freeCapacity?: number;
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

export function makeStore(spec: StoreSpec = {}): StoreDefinition {
  const store = Object.create(storePrototype) as StoreDefinition;
  for (const [resource, amount] of Object.entries(spec.resources ?? {})) {
    (store as unknown as Record<string, number>)[resource] = amount;
  }
  Object.defineProperty(store, "__freeCapacity", {
    value: spec.freeCapacity ?? 500_000,
    enumerable: false,
    writable: true,
  });
  return store;
}

export interface RoomSpec {
  name: string;
  storage?: { id: string; resources?: Record<string, number>; freeCapacity?: number } | null;
  terminal?: { id: string; resources?: Record<string, number>; freeCapacity?: number } | null;
}

export function buildRoom(spec: RoomSpec): Room {
  return {
    name: spec.name,
    controller: { my: true, level: 8 },
    storage:
      spec.storage === null || !spec.storage
        ? undefined
        : ({
            id: spec.storage.id,
            store: makeStore({ resources: spec.storage.resources, freeCapacity: spec.storage.freeCapacity }),
          } as unknown as StructureStorage),
    terminal:
      spec.terminal === null || !spec.terminal
        ? undefined
        : ({
            id: spec.terminal.id,
            store: makeStore({ resources: spec.terminal.resources, freeCapacity: spec.terminal.freeCapacity ?? 300_000 }),
          } as unknown as StructureTerminal),
  } as unknown as Room;
}

/** 安装 Game.rooms 并返回房间表（服务构造用引用而非 Game.rooms 快照）。 */
export function installRooms(specs: RoomSpec[]): Record<string, Room> {
  const rooms: Record<string, Room> = {};
  for (const spec of specs) {
    rooms[spec.name] = buildRoom(spec);
  }
  Game.rooms = rooms;
  return rooms;
}

/** 写入 storage/terminal 资源（模拟 tick 间外部变化）。 */
export function setStoreResources(
  structure: StructureStorage | StructureTerminal | undefined,
  resources: Record<string, number>,
): void {
  const record = structure?.store as unknown as Record<string, number>;
  if (!record) return;
  for (const key of Object.keys(record)) {
    if (typeof record[key] === "number") delete record[key];
  }
  for (const [resource, amount] of Object.entries(resources)) {
    record[resource] = amount;
  }
}

/**
 * 受控世界增量（Core Rewrite III/§6.2）：对 mock store 施加带符号资源变化
 * 并同步 __freeCapacity（used += delta → free −= delta）。测试 adapter 的
 * execute 以此把"API 接受"落实为"世界已更新"——观察覆盖依据受控世界
 * 更新与后续可信观察建立，不以净余额碰巧相等推断。
 */
export function mutateStoreResource(
  structure: StructureStorage | StructureTerminal | undefined,
  resource: string,
  delta: number,
): void {
  const holder = structure as unknown as { store?: Record<string, number> } | undefined;
  const record = holder?.store;
  if (!record) return;
  const next = (record[resource] ?? 0) + delta;
  if (next > 0) record[resource] = next;
  else delete record[resource];
  const free = (structure?.store as unknown as { __freeCapacity?: number }).__freeCapacity;
  if (typeof free === "number") {
    (structure?.store as unknown as { __freeCapacity: number }).__freeCapacity = Math.max(0, free - delta);
  }
}
