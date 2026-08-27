/**
 * 拓扑指纹回归测试：结构交换位置、Rampart 可通行状态变化必须改变指纹，
 * 同时保持对列表顺序的不敏感性。
 */
import { clearRoomTopologyRevisionCacheForTest, getRoomTopologyRevision } from "@/movement/roomTopologyRevision";
import { createRoom, resetRuntimeServices } from "@mock/movement";

interface StructureLike {
  structureType: string;
  pos: { x: number; y: number };
  my?: boolean;
  isPublic?: boolean;
}

function makeStructure(structureType: string, x: number, y: number, extra: Partial<StructureLike> = {}): StructureLike {
  return { structureType, pos: { x, y }, ...extra };
}

function setupRoomWithStructures(name: string, structures: StructureLike[]): Room {
  const room = createRoom(name);
  room.find = jest.fn((findConstant: number) => {
    if (findConstant === FIND_STRUCTURES || findConstant === FIND_MY_STRUCTURES) {
      return structures as unknown as Structure<StructureConstant>[];
    }
    return [];
  }) as unknown as Room["find"];
  return room;
}

describe("getRoomTopologyRevision", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearRoomTopologyRevisionCacheForTest();
    Game.rooms = {};
    Game.time += 1;
  });

  it("is stable within a tick and insensitive to structure list order", () => {
    const structures = [
      makeStructure(STRUCTURE_ROAD, 10, 10),
      makeStructure(STRUCTURE_SPAWN, 20, 20),
      makeStructure(STRUCTURE_EXTENSION, 30, 30),
    ];
    setupRoomWithStructures("W1N1", structures);

    const first = getRoomTopologyRevision("W1N1");
    expect(getRoomTopologyRevision("W1N1")).toBe(first);

    // 下一 tick 重新计算时，列表顺序重排不应改变指纹。
    Game.time += 1;
    clearRoomTopologyRevisionCacheForTest();
    const reordered = [structures[2], structures[0], structures[1]];
    setupRoomWithStructures("W1N1", reordered);
    expect(getRoomTopologyRevision("W1N1")).toBe(first);
  });

  it("changes when two structures of different types swap positions", () => {
    setupRoomWithStructures("W1N1", [
      makeStructure(STRUCTURE_ROAD, 10, 10),
      makeStructure(STRUCTURE_SPAWN, 20, 20),
    ]);
    const before = getRoomTopologyRevision("W1N1");

    Game.time += 1;
    clearRoomTopologyRevisionCacheForTest();
    setupRoomWithStructures("W1N1", [
      makeStructure(STRUCTURE_ROAD, 20, 20),
      makeStructure(STRUCTURE_SPAWN, 10, 10),
    ]);
    const after = getRoomTopologyRevision("W1N1");

    expect(after).not.toBe(before);
  });

  it("changes when a rampart public/ownership state flips without moving", () => {
    setupRoomWithStructures("W1N1", [
      makeStructure(STRUCTURE_RAMPART, 15, 15, { my: true, isPublic: true }),
    ]);
    const before = getRoomTopologyRevision("W1N1");

    Game.time += 1;
    clearRoomTopologyRevisionCacheForTest();
    setupRoomWithStructures("W1N1", [
      makeStructure(STRUCTURE_RAMPART, 15, 15, { my: true, isPublic: false }),
    ]);
    expect(getRoomTopologyRevision("W1N1")).not.toBe(before);

    Game.time += 1;
    clearRoomTopologyRevisionCacheForTest();
    setupRoomWithStructures("W1N1", [
      makeStructure(STRUCTURE_RAMPART, 15, 15, { my: false, isPublic: false }),
    ]);
    expect(getRoomTopologyRevision("W1N1")).not.toBe(before);
  });
});
