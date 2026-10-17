import { MockPos } from "@mock/powerBank";
let warGeometry: typeof import("./warGeometry").warGeometry;
let warTerrain: typeof import("./warGeometry").warTerrain;
let warTerrainVersion: typeof import("./warGeometry").warTerrainVersion;

describe("战争几何缓存", () => {
  beforeEach(() => {
    jest.resetModules();
    ({ warGeometry, warTerrain, warTerrainVersion } = require("./warGeometry"));
    Game.time += 20; Game.map = { ...Game.map, getRoomTerrain: () => ({ get: () => 0 }) } as unknown as GameMap;
  });

  it("原生 row-major buffer 正确转为内部列索引，不调用逐格原生 get", () => {
    const values = new Uint8Array(2500); values[9 * 50 + 7] = TERRAIN_MASK_SWAMP;
    const get = jest.fn(() => 0);
    Game.map.getRoomTerrain = (() => ({ get, getRawBuffer: () => values })) as unknown as GameMap["getRoomTerrain"];
    expect(warTerrain("E3N57")[7 * 50 + 9]).toBe(TERRAIN_MASK_SWAMP);
    expect(warTerrain("E3N57")[9 * 50 + 7]).toBe(0); expect(get).not.toHaveBeenCalled();
  });

  it("跨 tick 重建 Game/map/reader 时地形只读取一次，运行世界重置时失效", () => {
    const room = { name: "E3N57", find: () => [] } as unknown as Room;
    const read = jest.fn(() => ({ get: () => 0 }));
    Game.map.getRoomTerrain = read as GameMap["getRoomTerrain"];
    const first = warGeometry(room); const version = warTerrainVersion(room.name);
    const rebound = jest.fn(() => ({ get: () => 0 }));
    for (let i = 0; i < 3; i++) {
      Object.assign(global, { Game: { ...Game, time: Game.time + 1,
        map: { ...Game.map, getRoomTerrain: () => rebound() } } });
      expect(warGeometry(room).blocked).toBe(first.blocked); expect(warTerrainVersion(room.name)).toBe(version);
    }
    expect(read).toHaveBeenCalledTimes(1); expect(rebound).not.toHaveBeenCalled();
    Game.time -= 1;
    Game.map = { ...Game.map, getRoomTerrain: () => ({ get: (x: number, y: number) => x === 7 && y === 9 ? TERRAIN_MASK_WALL : 0 }) } as unknown as GameMap;
    expect(warGeometry(room, true).blocked[7 * 50 + 9]).toBe(1); expect(warTerrainVersion(room.name)).not.toBe(version);
  });

  it("道路增减、墙体消失及公共 rampart 开关会刷新几何，不改写旧数组", () => {
    Game.map.getRoomTerrain = (() => ({ get: (x: number, y: number) => x === 7 && y === 9 ? TERRAIN_MASK_SWAMP : 0 })) as unknown as GameMap["getRoomTerrain"];
    const wall = { id: "wall", structureType: STRUCTURE_WALL, hits: 100, pos: new MockPos(5, 5, "E3N57") } as unknown as Structure;
    const rampart = { id: "rampart", structureType: STRUCTURE_RAMPART, hits: 100, isPublic: false, pos: new MockPos(6, 6, "E3N57") } as unknown as StructureRampart;
    const structures: Structure[] = [wall, rampart];
    const room = { name: "E3N57", find: (kind: FindConstant) => kind === FIND_STRUCTURES ? structures : [] } as unknown as Room;
    const first = warGeometry(room); expect(first.swampTiles).toContain(7 * 50 + 9); expect(first.blocked[6 * 50 + 6]).toBe(1);
    structures.reverse();
    expect(warGeometry(room, true).signature).toBe(first.signature);
    structures.reverse();
    structures.shift(); rampart.isPublic = true;
    structures.push({ id: "road", structureType: STRUCTURE_ROAD, pos: new MockPos(7, 9, room.name) } as unknown as StructureRoad);
    const second = warGeometry(room, true);
    expect(warGeometry(room, true).blocked).toBe(second.blocked);
    expect(second.swampTiles).not.toContain(7 * 50 + 9); expect(second.blocked[5 * 50 + 5]).toBe(0); expect(second.blocked[6 * 50 + 6]).toBe(0);
    expect(first.blocked[5 * 50 + 5]).toBe(1);
    const previousSignature = second.signature;
    structures[1] = { id: "replacement-wall", structureType: STRUCTURE_WALL, hits: 100,
      pos: new MockPos(8, 8, room.name) } as unknown as StructureWall;
    const third = warGeometry(room, true);
    expect(third.signature).not.toBe(previousSignature);
    expect(third.blocked[8 * 50 + 8]).toBe(1);
  });

  it("超过缓存容量后重新访问旧房间仍具有有效的地形版本", () => {
    for (let i = 0; i < 40; i++) { warTerrain(`E${i}N1`); expect(warTerrainVersion(`E${i}N1`)).toBeGreaterThan(0); }
    Game.time++; Game.map = { ...Game.map, getRoomTerrain: () => ({ get: () => 0 }) } as unknown as GameMap;
    for (let i = 39; i >= 0; i--) expect(warTerrainVersion(`E${i}N1`)).toBeGreaterThan(0);
  });
});
