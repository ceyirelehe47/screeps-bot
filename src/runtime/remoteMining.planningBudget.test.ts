jest.mock("@/runtime/powerBankObserver", () => ({ requestRemoteObservation: jest.fn() }));
import { processRemoteConstruction, REMOTE_MINING_DEFAULTS, type RemoteMiningTask } from "@/runtime/remoteMining";
import { claimHeavyPlanningSlot } from "@/runtime/planningCpuBudget";

class TestPosition {
  constructor(public x: number, public y: number, public roomName: string) {}
  lookFor(): unknown[] { return []; }
}

describe("外矿重规划错峰", () => {
  let search: jest.Mock;
  let used: number;
  let objects: Record<string, Source>;
  const config = { ...REMOTE_MINING_DEFAULTS, maxRemoteSitesPerRun: 2 };
  function addTask(targetRoom: string): RemoteMiningTask {
    const sourceRoom = "E1N57";
    const room = {
      name: targetRoom, controller: { my: false },
      find: () => [], getTerrain: () => ({ get: () => 0 }),
      createConstructionSite: jest.fn(() => OK),
    } as unknown as Room;
    Game.rooms[targetRoom] = room;
    const ids = ["a", "b"].map((suffix, index) => {
      const id = `${targetRoom}-${suffix}`;
      objects[id] = { id, room, pos: new TestPosition(10 + index * 10, 10, targetRoom) } as unknown as Source;
      return id;
    });
    return { sourceRoom, targetRoom, sourceIds: ids, status: "active", assignedAt: 1, updatedAt: 1 };
  }
  beforeEach(() => {
    Game.time += 10;
    Game.rooms = { E1N57: { name: "E1N57", storage: { pos: new TestPosition(25, 25, "E1N57") } } as unknown as Room };
    Game.constructionSites = {};
    Memory.cfg = { roomPlannerBuild: { enabled: true } };
    used = 80;
    Game.cpu = { ...Game.cpu, limit: 120, tickLimit: 500, bucket: 10000, getUsed: () => used };
    objects = {};
    Game.getObjectById = jest.fn(id => objects[String(id)] ?? null) as Game["getObjectById"];
    search = jest.fn((_origin, goal) => ({ path: [new TestPosition(9, 9, goal.pos.roomName)], incomplete: false }));
    Object.assign(global, {
      RoomPosition: TestPosition,
      PathFinder: { CostMatrix: class { set(): void {} }, search },
    });
  });

  it("三个到期矿点分三 tick 完成，每 tick 最多两次源测路", () => {
    const tasks = Object.fromEntries(["E1N58", "E2N57", "E8N58"].map(name => [name, addTask(name)]));
    for (let index = 0; index < 3; index += 1) {
      search.mockClear();
      processRemoteConstruction(tasks, config);
      expect(search).toHaveBeenCalledTimes(2);
      expect(Object.values(tasks).filter(task => task.roadPlan)).toHaveLength(index + 1);
      Game.time += 1;
      // 官方 Game 对象可每 tick 重建；不能因此把轮转游标重置。
      Object.assign(global, { Game: { ...Game, rooms: { ...Game.rooms } } });
    }
  });

  it("道路失败后轮到下一矿点，独立 container 建设继续", () => {
    const a = addTask("E1N58"), b = addTask("E2N57");
    search.mockImplementation((_origin, goal) => ({ path: [], incomplete: goal.pos.roomName === a.targetRoom }));
    processRemoteConstruction({ a, b }, config);
    expect(a.roadPlan).toBeUndefined();
    expect(Game.rooms[b.targetRoom].createConstructionSite).toHaveBeenCalledTimes(2);
    Game.time += 1;
    Object.assign(global, { Game: { ...Game } });
    processRemoteConstruction({ a, b }, config);
    expect(b.roadPlan?.generatedAt).toBe(Game.time);
  });

  it("余量不足时旧路径和时间保持原样，恢复后立即重规划", () => {
    const a = addTask("E1N58");
    a.roadPlan = { generatedAt: Game.time - 100, positions: [] };
    const previous = a.roadPlan;
    used = 200;
    processRemoteConstruction({ a }, config);
    expect(search).not.toHaveBeenCalled();
    expect(a.roadPlan).toBe(previous);
    expect(Object.keys(a.containerPositions!)).toHaveLength(2);
    used = 80;
    processRemoteConstruction({ a }, config);
    expect(a.roadPlan?.generatedAt).toBe(Game.time);
  });

  it("布局名额已占用时道路顺延，不影响 container", () => {
    const a = addTask("E1N58");
    expect(claimHeavyPlanningSlot()).toBe(true);
    processRemoteConstruction({ a }, config);
    expect(search).not.toHaveBeenCalled();
    expect(Game.rooms[a.targetRoom].createConstructionSite).toHaveBeenCalledTimes(2);
  });

  it("第一源测完后 CPU 上升，放弃部分计划，下一 tick 可重试", () => {
    const a = addTask("E1N58");
    search.mockImplementation((_origin, goal) => {
      used = 200;
      return { path: [new TestPosition(9, 9, goal.pos.roomName)], incomplete: false };
    });
    processRemoteConstruction({ a }, config);
    expect(search).toHaveBeenCalledTimes(1);
    expect(a.roadPlan).toBeUndefined();
    expect(Object.keys(a.containerPositions!)).toHaveLength(2);
  });
});
