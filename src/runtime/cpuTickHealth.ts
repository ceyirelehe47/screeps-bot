/** 中断诊断不测时，不增加非采样 tick 的 getUsed 调用。 */
export interface CpuTickHealthSummary {
  globalStarts: number;
  lastGlobalStartAt: number;
  lastCompletedAt?: number;
  lastGap?: { afterTick: number; resumedAt: number; skippedTicks: number };
  lastIncomplete?: { tick: number; phase: string; creep?: string };
}

interface TickCheckpoint {
  tick: number;
  phase: string;
  creep?: string;
  completed: boolean;
}

let checkpoint: TickCheckpoint | undefined;
let summary: CpuTickHealthSummary | undefined;

export function beginCpuTickHealth(): void {
  if (!summary) {
    const previous = Memory.analytics?.cpuMonitor?.health;
    summary = { ...previous, globalStarts: (previous?.globalStarts ?? 0) + 1, lastGlobalStartAt: Game.time };
    if (previous?.lastCompletedAt !== undefined && Game.time > previous.lastCompletedAt + 1) {
      summary.lastGap = {
        afterTick: previous.lastCompletedAt, resumedAt: Game.time,
        skippedTicks: Game.time - previous.lastCompletedAt - 1,
      };
    }
  }
  if (checkpoint && checkpoint.tick < Game.time && !checkpoint.completed) {
    summary.lastIncomplete = { tick: checkpoint.tick, phase: checkpoint.phase, creep: checkpoint.creep };
  }
  checkpoint = { tick: Game.time, phase: "loopStart", completed: false };
}

/** 只记录最外层阶段；嵌套 creep 子阶段不覆盖正在执行的角色身份。 */
export function markCpuTickPhase(phase: string): void {
  if (checkpoint) checkpoint.phase = phase;
}

export function markCpuTickCreep(creep?: string): void {
  if (checkpoint) checkpoint.creep = creep;
}

export function completeCpuTickHealth(): void {
  if (!summary || !checkpoint) return;
  checkpoint.completed = true;
  summary.lastCompletedAt = Game.time;
  const monitor = Memory.analytics?.cpuMonitor;
  if (monitor) monitor.health = { ...summary };
}

/** 仅供测试：模拟 heap 丢失；持久字段由实际 Memory 提供。 */
export function resetCpuTickHealthForTests(): void {
  checkpoint = undefined;
  summary = undefined;
}
