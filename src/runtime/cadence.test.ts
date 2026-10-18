import { cadenceOffset, isDue, tickPhase } from "@/runtime/cadence";
import { summarizeCpuCadencePhases } from "@/runtime/cpuMonitor";

it("一个周期内每个 key 恰好运行一次，重启不改变相位，多个任务分散", () => {
  const keys = ["resourceControl.plan", "synthesis.plan", "factory.terminalGc", "hubPlanner.plan", "portal.scan"];
  const offsets = keys.map(key => cadenceOffset(key, 100));
  expect(new Set(offsets).size).toBeGreaterThan(3);
  for (const key of keys) {
    const due = Array.from({ length: 300 }, (_, tick) => tick).filter(tick => isDue(key, 100, tick));
    expect(due).toEqual([cadenceOffset(key, 100), cadenceOffset(key, 100) + 100, cadenceOffset(key, 100) + 200]);
  }
  expect(tickPhase(-1, 10)).toBe(9);
  expect(isDue("bad_config", NaN, 100)).toBe(true);
});

it("CPU 相位分桶只统计窗口中存在的有限样本，覆盖重复相位峰值", () => {
  expect(summarizeCpuCadencePhases([
    { tick: 1, totalUsed: 10 }, { tick: 101, totalUsed: 30 }, { tick: 2, totalUsed: 7 },
    { tick: 201, totalUsed: NaN }, { tick: Infinity, totalUsed: 50 },
  ])).toEqual({ "1": { samples: 2, avgUsed: 20, maxUsed: 30 }, "2": { samples: 1, avgUsed: 7, maxUsed: 7 } });
});
