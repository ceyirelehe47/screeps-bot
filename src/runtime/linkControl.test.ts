import {
  hasSharedStorageControllerLinkCluster,
  isReceiverLink,
  isStorageReceiverLink,
  runLinkControl,
} from "@/runtime/linkControl";
import { MockPos, createMockStore } from "@mock/powerBank";
import { setActiveTickCpuProfiler, type TickCpuProfiler } from "@/runtime/cpuPhaseProfiler";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function createNoopProfiler(recordFixedAction: jest.Mock = jest.fn()): TickCpuProfiler {
  return {
    measure<T>(_phase: string, fn: () => T): T {
      return fn();
    },
    recordFixedAction,
    measureCreep(_creep: Creep, fn: () => void): void {
      fn();
    },
    measureRoomPhase<T>(_phase: string, _roomName: string, fn: () => T): T {
      return fn();
    },
    flush(): void {},
  };
}

function createPosition(rangeToTarget?: (target: { structureType?: StructureConstant }) => number): RoomPosition {
  return {
    getRangeTo(target: { structureType?: StructureConstant }): number {
      return rangeToTarget?.(target) ?? Number.POSITIVE_INFINITY;
    },
  } as RoomPosition;
}

function createLink(options: {
  id?: string;
  controllerRange?: number;
  storageRange?: number;
  storageControllerRange?: number;
}): StructureLink {
  const controllerRange = options.controllerRange ?? Number.POSITIVE_INFINITY;
  const storageRange = options.storageRange ?? Number.POSITIVE_INFINITY;
  const storageControllerRange = options.storageControllerRange ?? Number.POSITIVE_INFINITY;
  const controllerPos = createPosition();
  const storagePos = createPosition((target) => (target === controllerPos ? storageControllerRange : Number.POSITIVE_INFINITY));

  return {
    id: options.id ?? `link:${controllerRange}:${storageRange}`,
    pos: createPosition((target) => (target === storagePos ? storageRange : controllerRange)),
    room: {
      name: "W1N1",
      controller: {
        pos: controllerPos,
      } as StructureController,
      storage: {
        structureType: STRUCTURE_STORAGE,
        pos: storagePos,
      } as StructureStorage,
    } as Room,
  } as StructureLink;
}



beforeEach(() => {
  delete (global as RuntimeGlobal).__runtimeServices;
  Memory.runtime = undefined;
  Game.time = 100;
  Game.rooms = {};
  Game.getObjectById = jest.fn(() => null);
  setActiveTickCpuProfiler(createNoopProfiler());
});

afterEach(() => {
  delete (global as RuntimeGlobal).__runtimeServices;
  setActiveTickCpuProfiler(createNoopProfiler());
});

describe("isReceiverLink", () => {

  it("入口 link 作为发送端优先送仓库，本地源矿 link 继续优先控制器", () => {
    const links: StructureLink[] = [];
    const room = { name: "W1N1", controller: { my: true, level: 8, pos: new MockPos(30, 30, "W1N1") },
      storage: { pos: new MockPos(10, 10, "W1N1") },
      find: (kind: FindConstant) => kind === FIND_STRUCTURES || kind === FIND_MY_STRUCTURES ? links
        : kind === FIND_SOURCES ? [{ pos: new MockPos(4, 5, "W1N1") }] : [] } as unknown as Room;
    const make = (id: string, x: number, y: number, energy: number) => ({ id, room, my: true, structureType: STRUCTURE_LINK,
      pos: new MockPos(x, y, room.name), cooldown: 0, store: createMockStore({ energy }, 800), transferEnergy: jest.fn(() => OK) } as unknown as StructureLink);
    const entry = make("entry", 47, 20, 800), source = make("source", 5, 5, 800);
    const warehouse = make("warehouse", 11, 10, 0), controller = make("controller", 31, 30, 0);
    links.push(entry, source, warehouse, controller);
    Game.rooms = { W1N1: room };
    Game.getObjectById = jest.fn(id => links.find(l => l.id === id) ?? null) as typeof Game.getObjectById;
    Memory.data = { roomPlanner: { W1N1: { layout: { remote_entry_link: [{ x: 47, y: 20 }] }, savedAt: 0, timestamp: "" } } };
    runLinkControl();
    expect(entry.transferEnergy).toHaveBeenCalledWith(warehouse);
    expect(source.transferEnergy).toHaveBeenCalledWith(controller);
    expect(Memory.runtime!.linkNetwork!.W1N1.senderIds).toEqual([entry.id, source.id]);
  });

  it("keeps distant controller receiver links separate from storage receivers", () => {
    const link = createLink({ controllerRange: 3, storageRange: 4, storageControllerRange: 6 });

    expect(hasSharedStorageControllerLinkCluster(link.room)).toBe(false);
    expect(isReceiverLink(link)).toBe(true);
    expect(isStorageReceiverLink(link)).toBe(false);
  });

  it("uses cached receiver membership while retaining positional storage semantics", () => {
    const cachedControllerLink = createLink({
      id: "cached-controller",
      controllerRange: 10,
      storageRange: 10,
      storageControllerRange: 10,
    });
    const uncachedStorageLink = createLink({
      id: "uncached-storage",
      controllerRange: 10,
      storageRange: 2,
      storageControllerRange: 10,
    });
    Memory.runtime = {
      linkNetwork: {
        W1N1: {
          updatedAt: Game.time,
          senderIds: [],
          receiverIds: [cachedControllerLink.id],
        },
      },
    };

    expect(isReceiverLink(cachedControllerLink)).toBe(true);
    expect(isStorageReceiverLink(cachedControllerLink)).toBe(false);
    expect(isReceiverLink(uncachedStorageLink)).toBe(true);
    expect(isStorageReceiverLink(uncachedStorageLink)).toBe(false);
  });
});
