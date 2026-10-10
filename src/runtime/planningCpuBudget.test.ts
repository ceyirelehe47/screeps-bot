import { claimHeavyPlanningSlot, hasPlanningCpuHeadroom } from "@/runtime/planningCpuBudget";

describe("规划 CPU 余量", () => {
  let used: number;
  beforeEach(() => {
    Game.time += 10;
    used = 80;
    Game.cpu = { limit: 120, tickLimit: 500, bucket: 10_000, getUsed: () => used } as Game["cpu"];
  });

  it("两个重规划入口同 tick 共用一个名额，下一 tick 恢复", () => {
    expect(claimHeavyPlanningSlot()).toBe(true);
    expect(claimHeavyPlanningSlot()).toBe(false);
    Game.time += 1;
    expect(claimHeavyPlanningSlot()).toBe(true);
  });

  it("冷启动或低 bucket 延后，恢复余量后同 tick 仍可开始", () => {
    used = 200;
    expect(claimHeavyPlanningSlot()).toBe(false);
    used = 80;
    Game.cpu.bucket = 1999;
    expect(claimHeavyPlanningSlot()).toBe(false);
    Game.cpu.bucket = 2000;
    expect(claimHeavyPlanningSlot()).toBe(true);
  });

  it("tickLimit 降低时仍为生产保留 CPU", () => {
    Game.cpu.tickLimit = 160;
    used = 40;
    expect(hasPlanningCpuHeadroom()).toBe(false);
    used = 39;
    expect(hasPlanningCpuHeadroom()).toBe(true);
  });

  it.each([Number.NaN, Infinity, -1])("异常 CPU 读数 %s 不启动新规划", value => {
    used = value;
    expect(hasPlanningCpuHeadroom()).toBe(false);
  });
});
