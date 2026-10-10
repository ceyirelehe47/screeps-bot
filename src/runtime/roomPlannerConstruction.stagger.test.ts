jest.mock("@/modules/autoplanner", () => ({ runPlannerForRoom: jest.fn(() => false), savePlannerForRoom: jest.fn() }));
jest.mock("@/runtime/remoteEntranceLink", () => ({ addRemoteEntranceLinkPlans: () => false, REMOTE_ENTRANCE_LINK_LAYOUT_KEY: "remote_links" }));
import { runRoomPlannerConstruction } from "@/runtime/roomPlannerConstruction";
import { runPlannerForRoom } from "@/modules/autoplanner";
import { registerRuntimeServices } from "@/runtime/runtimeServices";
import { claimHeavyPlanningSlot } from "@/runtime/planningCpuBudget";

describe("房间建设检查错峰", () => {
  let used: number;
  beforeEach(() => {
    Game.time += 10;
    registerRuntimeServices(undefined);
    Game.rooms = Object.fromEntries(["E1N57", "E3N54", "E4N57"].map(name => [name,
      { name, controller: { my: true, level: 1 }, find: () => [] } as unknown as Room]));
    Game.spawns = {};
    Game.constructionSites = {};
    Memory.runtime = {};
    Memory.data = { roomPlanner: Object.fromEntries(Object.keys(Game.rooms).map(name => [name, { layout: {}, savedAt: 1 }])) };
    Memory.cfg = { roomPlannerBuild: { enabled: true } };
    used = 80;
    Game.cpu = { limit: 120, tickLimit: 500, bucket: 10000, getUsed: () => used } as Game["cpu"];
    jest.mocked(runPlannerForRoom).mockClear();
  });
  it("三个同周期房间分三 tick 检查，旧布局不重新计算", () => {
    for (let count = 1; count <= 3; count += 1) {
      runRoomPlannerConstruction();
      expect(Object.keys(Memory.runtime!.roomPlannerBuild!.rooms)).toHaveLength(count);
      Game.time += 1;
    }
    expect(runPlannerForRoom).not.toHaveBeenCalled();
  });
  it("CPU 忙时不更新 lastRunAt，恢复后继续", () => {
    used = 200;
    runRoomPlannerConstruction();
    expect(Memory.runtime!.roomPlannerBuild!.rooms).toEqual({});
    used = 80;
    runRoomPlannerConstruction();
    expect(Object.keys(Memory.runtime!.roomPlannerBuild!.rooms)).toHaveLength(1);
  });
  it("重规划名额被占时缺失布局顺延，已有布局仍能建设检查", () => {
    delete Memory.data!.roomPlanner!.E1N57;
    expect(claimHeavyPlanningSlot()).toBe(true);
    runRoomPlannerConstruction();
    expect(runPlannerForRoom).not.toHaveBeenCalled();
    expect(Memory.runtime!.roomPlannerBuild!.rooms.E1N57).toBeUndefined();
    expect(Memory.runtime!.roomPlannerBuild!.rooms.E3N54?.lastRunAt).toBe(Game.time);
  });
});
