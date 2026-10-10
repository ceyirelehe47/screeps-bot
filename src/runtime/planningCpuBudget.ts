/** 新的重规划只在有余量时启动；已经进行中的生产动作不经过此门。 */
export function hasPlanningCpuHeadroom(): boolean {
  const cpu = Game.cpu;
  // Simulation / 精简 mock 没有 CPU 接口时保留原行为。
  if (!cpu || typeof cpu.getUsed !== "function") return true;
  const used = cpu.getUsed();
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(cpu.tickLimit) ||
      !Number.isFinite(cpu.limit) || cpu.limit <= 0) return false;
  if (typeof cpu.bucket === "number" && cpu.bucket < 2000) return false;
  // 冷启动已花费较多 CPU 时顺延；为后续防御、补员和 creep.work 留余量。
  const startLimit = Math.min(cpu.limit * 1.5, cpu.tickLimit - Math.max(50, cpu.limit));
  return used < startLimit;
}

let planningSlot: { game: Game; tick: number; claimed: boolean } | undefined;

/** 自动布局与外矿道路规划共用一个重规划名额，避免同 tick 叠加。 */
export function claimHeavyPlanningSlot(): boolean {
  if (planningSlot?.game !== Game || planningSlot.tick !== Game.time) {
    planningSlot = { game: Game, tick: Game.time, claimed: false };
  }
  if (planningSlot.claimed || !hasPlanningCpuHeadroom()) return false;
  planningSlot.claimed = true;
  return true;
}
