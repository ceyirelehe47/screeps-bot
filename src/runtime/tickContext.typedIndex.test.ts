/**
 * TickContext 类型化结构索引回归测试（任务书阶段 D2）：
 * 一次结构扫描构建按类型索引；不同 typed getter 共享；下一 tick 重建；
 * 全量 creep/spawn 快照。
 */
import { createTickContextService } from "@/runtime/tickContext";
import { resetRuntimeServices } from "@mock/movement";

function createRoomWithStructures(name: string): { room: Room; find: jest.Mock; structures: unknown[]; myStructures: unknown[] } {
  const structures: unknown[] = [];
  const myStructures: unknown[] = [];
  const room = {
    name,
    controller: { my: true, level: 4 },
    find: jest.fn((findConstant: number) => {
      switch (findConstant) {
        case FIND_STRUCTURES:
          return structures;
        case FIND_MY_STRUCTURES:
          return myStructures;
        default:
          return [];
      }
    }),
  } as unknown as Room;
  Game.rooms[name] = room;
  return { room, find: room.find as unknown as jest.Mock, structures, myStructures };
}

describe("tickContext typed structure index", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time += 1;
    Game.rooms = {};
    Game.creeps = {};
    Game.spawns = {};
  });

  it("同tick替换Game世界也重建房间与全creep/spawn快照", () => {
    const saved = Game;
    const { room: old } = createRoomWithStructures("W1N1");
    const service = createTickContextService();
    expect(service.getMyRooms()).toEqual([old]); expect(service.getAllCreeps()).toEqual([]); expect(service.getAllSpawns()).toEqual([]);
    const next = { name: "W2N2", controller: { my: true }, find: jest.fn(() => []) } as unknown as Room;
    const creep = { name: "new" } as Creep; const spawn = { name: "new-spawn" } as StructureSpawn;
    try {
      Object.assign(global, { Game: { ...Game, rooms: { W2N2: next }, creeps: { new: creep }, spawns: { new: spawn } } });
      expect(service.getMyRooms()).toEqual([next]); expect(service.getAllCreeps()).toEqual([creep]); expect(service.getAllSpawns()).toEqual([spawn]);
    } finally { Object.assign(global, { Game: saved }); }
  });

  it("同名Room对象替换不复用旧结构索引", () => {
    const first = createRoomWithStructures("W1N1"); first.structures.push({ id: "old", structureType: STRUCTURE_POWER_BANK });
    const service = createTickContextService(); expect(service.getRoomContext(first.room)!.getStructuresByType(STRUCTURE_POWER_BANK)[0].id).toBe("old");
    const second = createRoomWithStructures("W1N1"); second.structures.push({ id: "new", structureType: STRUCTURE_POWER_BANK });
    expect(service.getRoomContext(second.room)!.getStructuresByType(STRUCTURE_POWER_BANK)[0].id).toBe("new");
  });

  it("多个 typed getter 只触发一次主结构扫描并共享索引", () => {
    const { room, find, myStructures, structures } = createRoomWithStructures("W1N1");
    myStructures.push(
      { structureType: STRUCTURE_TOWER, pos: { x: 10, y: 10 } },
      { structureType: STRUCTURE_LINK, pos: { x: 11, y: 10 } },
      { structureType: STRUCTURE_LAB, pos: { x: 12, y: 10 } },
      { structureType: STRUCTURE_RAMPART, pos: { x: 13, y: 10 } },
    );
    structures.push(
      { structureType: STRUCTURE_CONTAINER, pos: { x: 20, y: 20 } },
      ...myStructures,
    );

    const service = createTickContextService();
    const context = service.getRoomContext(room)!;

    expect(context.getTowers()).toHaveLength(1);
    expect(context.getLinks()).toHaveLength(1);
    expect(context.getLabs()).toHaveLength(1);
    expect(context.getRamparts()).toHaveLength(1);
    expect(context.getContainers()).toHaveLength(1);

    // FIND_MY_STRUCTURES 只扫描一次（towers/links/labs/ramparts 共享索引），
    // FIND_STRUCTURES 只扫描一次（containers）。
    const myScans = find.mock.calls.filter((call) => call[0] === FIND_MY_STRUCTURES).length;
    const allScans = find.mock.calls.filter((call) => call[0] === FIND_STRUCTURES).length;
    expect(myScans).toBe(1);
    expect(allScans).toBe(1);

    // getStructuresByType 与 typed getter 使用同一份索引。
    expect(context.getMyStructuresByType(STRUCTURE_TOWER)).toHaveLength(1);
    expect(context.getStructuresByType(STRUCTURE_CONTAINER)).toHaveLength(1);
    expect(find.mock.calls.filter((call) => call[0] === FIND_MY_STRUCTURES).length).toBe(1);
    expect(find.mock.calls.filter((call) => call[0] === FIND_STRUCTURES).length).toBe(1);
  });

  it("下一 tick 重新建立快照", () => {
    const { room, find, structures } = createRoomWithStructures("W1N1");
    structures.push({ structureType: STRUCTURE_CONTAINER, pos: { x: 20, y: 20 } });

    const service = createTickContextService();
    expect(service.getRoomContext(room)!.getContainers()).toHaveLength(1);

    Game.time += 1;
    structures.push({ structureType: STRUCTURE_CONTAINER, pos: { x: 21, y: 20 } });
    expect(service.getRoomContext(room)!.getContainers()).toHaveLength(2);
    const allScans = find.mock.calls.filter((call) => call[0] === FIND_STRUCTURES).length;
    expect(allScans).toBe(2);
  });

  it("getAllCreeps/getAllSpawns 提供同 tick 快照", () => {
    const service = createTickContextService();
    Game.creeps = {
      a: { name: "a" } as Creep,
      b: { name: "b" } as Creep,
    };
    Game.spawns = { s1: { name: "s1" } as StructureSpawn };

    expect(service.getAllCreeps()).toHaveLength(2);
    expect(service.getAllSpawns()).toHaveLength(1);
    // 同 tick 内重复读取返回同一快照。
    expect(service.getAllCreeps()).toBe(service.getAllCreeps());

    Game.time += 1;
    Game.creeps = { a: { name: "a" } as Creep };
    expect(service.getAllCreeps()).toHaveLength(1);
  });

  it("mock 环境缺少部分 API 时保持兼容（空数组而非抛错）", () => {
    const { room } = createRoomWithStructures("W2N2");
    const service = createTickContextService();
    const context = service.getRoomContext(room)!;
    expect(context.getTowers()).toEqual([]);
    expect(context.getContainers()).toEqual([]);
    expect(context.getMyStructuresByType(STRUCTURE_NUKER)).toEqual([]);
  });
});
