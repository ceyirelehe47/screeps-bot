jest.mock("@/roles/shared", () => ({
  moveToTargetRoom: jest.fn(() => OK),
}));

jest.mock("@/runtime/powerBankDiscovery", () => ({
  recordPowerBankDiscovery: jest.fn(),
}));

import { powerBankScoutRole, getActiveTransitDangerRooms } from "@/roles/powerBankScout";
import { isPowerBankSearchRoom } from "@/runtime/powerBankConstants";
import * as powerBankSearch from "@/runtime/powerBankSearch";

const { moveToTargetRoom } = jest.requireMock("@/roles/shared") as {
  moveToTargetRoom: jest.Mock;
};

class MockRoomPosition {
  constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}
}

function createMockCreep(roomName: string, memory: any = {}, hits = 1000, hitsMax = 1000): Creep {
  return {
    room: {
      name: roomName,
      find: jest.fn((constant: number) => {
        if (constant === FIND_STRUCTURES) return [];
        if (constant === FIND_HOSTILE_CREEPS) return [];
        if (constant === FIND_HOSTILE_POWER_CREEPS) return [];
        return [];
      }),
      controller: undefined,
    },
    memory: { ...memory },
    pos: new MockRoomPosition(25, 25, roomName) as unknown as RoomPosition,
    hits,
    hitsMax,
  } as unknown as Creep;
}

function addSearchSource(name: string, level = 6): { my: boolean; level: number } {
  const controller = { my: true, level };
  Game.rooms[name] = { name, controller } as unknown as Room;
  return controller;
}

function lastTarget(): string {
  return moveToTargetRoom.mock.calls[moveToTargetRoom.mock.calls.length - 1][1];
}

function arrive(creep: Creep, roomName: string): void {
  creep.room = createMockCreep(roomName).room;
  creep.pos = new MockRoomPosition(25, 25, roomName) as unknown as RoomPosition;
}

describe("powerBankScoutRole", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    Memory.runtime = {};
    Memory.data = {};
    Game.rooms = {};
    Game.time += 1;
    Game.map = {
      ...Game.map,
      getWorldSize: jest.fn(() => 202),
      getRoomStatus: jest.fn(() => ({ status: "normal" as const, timestamp: null })),
    } as unknown as GameMap;
    Object.assign(global, {
      RoomPosition: MockRoomPosition,
    });
  });

  it("使用来源位置生成高速房，不依赖固定巡逻名单", () => {
    const creep = createMockCreep("E5N55");

    powerBankScoutRole().source?.(creep);

    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, expect.any(String), undefined,
      expect.objectContaining({ plainCost: 1, swampCost: 1 }));
    expect(isPowerBankSearchRoom(moveToTargetRoom.mock.calls[0][1])).toBe(true);
    expect(moveToTargetRoom.mock.calls[0][1]).not.toBe("E0N60");
  });

  it("赶路期间每 tick 只校验当前目标状态，不重扫 117 房目录", () => {
    const origins = ["E1N57", "E3N54", "E3N59", "E4N57", "E4N58", "E5N59", "E6N59", "E7N57", "E7N58", "W1N57"];
    origins.forEach(name => addSearchSource(name));
    (Game.map.getWorldSize as jest.Mock).mockReturnValue(122);
    const candidates = powerBankSearch.getPowerBankSearchRooms();
    expect(candidates).toHaveLength(117);
    const creep = createMockCreep("E1N57", { _patrol: { originRoomName: "E1N57", patrolIndex: 2, patrolDirection: 1 } });
    const role = powerBankScoutRole();
    // 旧 patrol 的 filtered index 允许一次完整迁移；性能合同从下一帧开始。
    role.source?.(creep);
    const target = lastTarget();
    expect(target).toBe(candidates[2]);
    const status = Game.map.getRoomStatus as jest.Mock;
    for (const transit of ["E2N57", "E3N57", "E4N57"]) {
      Game.time += 1;
      status.mockClear();
      arrive(creep, transit);
      role.source?.(creep);
      expect(lastTarget()).toBe(target);
      expect(status.mock.calls).toEqual([[target]]);
    }
  });

  it("真实来源归属、RCL、成员、配置原点及世界边界变化立即约束目标", () => {
    const remote = addSearchSource("E43S43");
    const remoteRooms = powerBankSearch.getPowerBankSearchRooms();
    const originRooms = powerBankSearch.getPowerBankSearchRooms("E5N55");
    const creep = createMockCreep("E5N55", { configName: "scout" });
    const role = powerBankScoutRole();
    role.source?.(creep);
    expect(remoteRooms).toContain(lastTarget());
    expect(originRooms).not.toContain(lastTarget());

    remote.my = false;
    role.source?.(creep);
    expect(originRooms).toContain(lastTarget());
    remote.my = true;
    role.source?.(creep);
    expect(remoteRooms).toContain(lastTarget());
    remote.level = 5;
    role.source?.(creep);
    expect(originRooms).toContain(lastTarget());

    delete Game.rooms.E43S43;
    addSearchSource("E75S75");
    role.source?.(creep);
    expect(powerBankSearch.getPowerBankSearchRooms()).toContain(lastTarget());
    const outsideTarget = lastTarget();
    (Game.map.getWorldSize as jest.Mock).mockReturnValue(100);
    role.source?.(creep);
    expect(lastTarget()).not.toBe(outsideTarget);
    expect(powerBankSearch.getPowerBankSearchRooms("E5N55")).toContain(lastTarget());

    Memory.data!.creepConfigs = { scout: { role: "powerBankScout", args: [], roomName: "W35S35" } };
    role.source?.(creep);
    expect(powerBankSearch.getPowerBankSearchRooms("W35S35")).toContain(lastTarget());
  });

  it("旧 filtered index 仅迁移一次，未选房重开不改变正在赶路的目标身份", () => {
    addSearchSource("E5N55");
    const candidates = powerBankSearch.getPowerBankSearchRooms();
    const closed = new Set([candidates[0]]);
    const status = jest.fn((name: string) => ({ status: closed.has(name) ? "closed" as const : "normal" as const, timestamp: null }));
    Game.map.getRoomStatus = status;
    const creep = createMockCreep("E5N55", { _patrol: { originRoomName: "E5N55", patrolIndex: 2, patrolDirection: 1 } });
    const role = powerBankScoutRole();
    role.source?.(creep);
    expect(lastTarget()).toBe(candidates[3]);
    Game.time += 1;
    closed.clear();
    status.mockClear();
    role.source?.(creep);
    expect(lastTarget()).toBe(candidates[3]);
    expect(status.mock.calls).toEqual([[candidates[3]]]);
  });

  it("当前目标 closed、缺失、异常或新增危险时立即重选，危险撤销不打断新目标", () => {
    addSearchSource("E5N55");
    const failures = new Map<string, "closed" | "missing" | "throw">();
    const status = jest.fn((name: string) => {
      const failure = failures.get(name);
      if (failure === "throw") throw new Error("unavailable");
      if (failure === "missing") return null;
      return { status: failure === "closed" ? "closed" as const : "normal" as const, timestamp: null };
    });
    Game.map.getRoomStatus = status as unknown as GameMap["getRoomStatus"];
    const creep = createMockCreep("E5N55");
    const role = powerBankScoutRole();
    role.source?.(creep);
    for (const failure of ["closed", "missing", "throw"] as const) {
      const previousTarget = lastTarget();
      failures.set(previousTarget, failure);
      Game.time += 1;
      status.mockClear();
      role.source?.(creep);
      expect(lastTarget()).not.toBe(previousTarget);
      expect(failures.has(lastTarget())).toBe(false);
      expect(new Set(status.mock.calls.map(([name]) => name)).size).toBe(status.mock.calls.length);
    }
    const dangerous = lastTarget();
    Memory.runtime!.transitDangerRooms = { [dangerous]: Game.time + 100 };
    Game.time += 1;
    role.source?.(creep);
    const safeTarget = lastTarget();
    expect(safeTarget).not.toBe(dangerous);
    expect(moveToTargetRoom.mock.calls[moveToTargetRoom.mock.calls.length - 1][3].avoidRooms).toContain(dangerous);
    delete Memory.runtime!.transitDangerRooms![dangerous];
    Game.time += 1;
    status.mockClear();
    role.source?.(creep);
    expect(lastTarget()).toBe(safeTarget);
    expect(status.mock.calls).toEqual([[safeTarget]]);
  });

  it("到达后越过关闭尾部完整折返，不漏另一端开放房或重选当前房", () => {
    addSearchSource("E5N55");
    const candidates = powerBankSearch.getPowerBankSearchRooms();
    const open = new Set([candidates[1], candidates[2]]);
    const status = jest.fn((name: string) => {
      if (name === candidates[3]) throw new Error("unavailable");
      return { status: open.has(name) ? "normal" as const : "closed" as const, timestamp: null };
    });
    Game.map.getRoomStatus = status;
    const creep = createMockCreep("E5N55", { _patrol: { originRoomName: "E5N55", patrolIndex: 1, patrolDirection: 1 } });
    const role = powerBankScoutRole();
    role.source?.(creep);
    expect(lastTarget()).toBe(candidates[2]);
    arrive(creep, candidates[2]);
    Game.time += 1;
    status.mockClear();
    role.source?.(creep);
    expect(lastTarget()).toBe(candidates[1]);
    expect(new Set(status.mock.calls.map(([name]) => name)).size).toBe(status.mock.calls.length);
    expect(status.mock.calls.length).toBeLessThanOrEqual(candidates.length);

    // 升级帧恰好抵达旧目标时，也复用本次完整目录的 fail-closed 结论，不能把异常房读两次。
    const arrivedLegacy = createMockCreep(candidates[2], { _patrol: { originRoomName: "E5N55", patrolIndex: 1, patrolDirection: 1 } });
    Game.time += 1;
    status.mockClear();
    role.source?.(arrivedLegacy);
    expect(lastTarget()).toBe(candidates[1]);
    expect(new Set(status.mock.calls.map(([name]) => name)).size).toBe(status.mock.calls.length);
    expect(status.mock.calls.length).toBeLessThanOrEqual(candidates.length);
  });

  it("来源全关闭才回退稳定原点，两域全关闭或仅危险来源开放则等待", () => {
    addSearchSource("E43S43");
    const sources = powerBankSearch.getPowerBankSearchRooms();
    const local = powerBankSearch.getPowerBankSearchRooms("E5N55");
    expect(sources.every(name => !local.includes(name))).toBe(true);
    const open = new Set([local[1]]);
    const status = jest.fn((name: string) => {
      if (open.has(name)) return { status: "normal" as const, timestamp: null };
      // 同时覆盖无状态与异常，并证明同次选房不会重复查询异常房。
      if (name === sources[1]) return null;
      if (name === sources[2]) throw new Error("unavailable");
      return { status: "closed" as const, timestamp: null };
    });
    Game.map.getRoomStatus = status as unknown as GameMap["getRoomStatus"];
    const creep = createMockCreep("E5N55");
    const role = powerBankScoutRole();
    role.source?.(creep);
    expect(lastTarget()).toBe(local[1]);
    expect(new Set(status.mock.calls.map(([name]) => name)).size).toBe(status.mock.calls.length);

    // 未选来源重开不打断当前原点行程，仍只有实际目标一房状态检查。
    open.add(sources[0]);
    Game.time += 1;
    status.mockClear();
    role.source?.(creep);
    expect(lastTarget()).toBe(local[1]);
    expect(status.mock.calls).toEqual([[local[1]]]);

    open.clear();
    Game.time += 1;
    status.mockClear();
    moveToTargetRoom.mockClear();
    role.source?.(creep);
    expect(moveToTargetRoom).not.toHaveBeenCalled();
    expect(new Set(status.mock.calls.map(([name]) => name)).size).toBe(status.mock.calls.length);
    expect(status.mock.calls.length).toBe(new Set([...sources, ...local]).size);

    open.add(sources[0]);
    open.add(local[1]);
    Memory.runtime!.transitDangerRooms = { [sources[0]]: Game.time + 100 };
    Game.time += 1;
    role.source?.(creep);
    expect(moveToTargetRoom).not.toHaveBeenCalled();
  });

  describe("getActiveTransitDangerRooms", () => {

    it("retains permanent danger while cleaning expired temporary danger", () => {
      Memory.runtime = Memory.runtime || {} as any;
      Memory.runtime.transitDangerRooms = { E2N54: Game.time - 1 };
      (Memory.runtime as any).powerBankPermanentDangerRooms = { E3N57: true };

      const rooms = getActiveTransitDangerRooms();

      expect(rooms).toEqual(["E3N57"]);
      expect(Memory.runtime!.transitDangerRooms!["E2N54"]).toBeUndefined();
      expect((Memory.runtime as any).powerBankPermanentDangerRooms?.E3N57).toBe(true);
    });

    it("高速搜索房不豁免仍有效的危险记录", () => {
      Memory.runtime!.transitDangerRooms = { E0N60: Game.time + 100 };
      expect(getActiveTransitDangerRooms()).toContain("E0N60");
      expect(Memory.runtime!.transitDangerRooms.E0N60).toBe(Game.time + 100);
    });
  });
});
