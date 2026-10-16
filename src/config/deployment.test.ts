import { AUTHORITY_EXECUTOR_SHARD, AUTHORITY_ROOMS, readSpawnExitDirections } from "@/config/deployment";

describe("部署配置", () => {
  beforeEach(() => { Memory.cfg = undefined; });

  it("读取兼容策略不创建 Memory，返回独立数组", () => {
    const first = readSpawnExitDirections("E5N59", "Spawn20");
    expect(first).toEqual([TOP]);
    first!.push(BOTTOM);
    expect(readSpawnExitDirections("E5N59", "Spawn20")).toEqual([TOP]);
    expect(Memory.cfg).toBeUndefined();
  });

  it("支持新房间配置、显式恢复默认和每次读取配置更新", () => {
    Memory.cfg = { rooms: { W9N9: { spawnExitDirections: { Spawn1: [RIGHT, BOTTOM] } } } };
    expect(readSpawnExitDirections("W9N9", "Spawn1")).toEqual([RIGHT, BOTTOM]);
    Memory.cfg.rooms!.W9N9.spawnExitDirections!.Spawn1 = [LEFT];
    expect(readSpawnExitDirections("W9N9", "Spawn1")).toEqual([LEFT]);
    Memory.cfg.rooms!.E5N59 = { spawnExitDirections: { Spawn20: [] } };
    expect(readSpawnExitDirections("E5N59", "Spawn20")).toBeUndefined();
  });

  it("非法方向保留已知房间的安全出口，普通配置不改变已签名身份", () => {
    Memory.cfg = { rooms: { E5N59: { spawnExitDirections: { Spawn20: [9 as DirectionConstant] } } } };
    expect(readSpawnExitDirections("E5N59", "Spawn20")).toEqual([TOP]);
    expect(AUTHORITY_ROOMS.synthesisHub).toBe("E1N57");
    expect(AUTHORITY_EXECUTOR_SHARD).toBe("shard1");
    expect(Object.isFrozen(AUTHORITY_ROOMS)).toBe(true);
  });
});
