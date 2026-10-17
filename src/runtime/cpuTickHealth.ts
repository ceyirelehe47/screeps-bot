import { getMemoryService } from "@/runtime/runtimeServices";

/** 独立健康记录。只恢复已保存的面包屑；硬终止丢弃整帧且 heap 丢失时只能推断缺口。 */
export interface CpuTickHealthSummary {
  globalStarts: number;
  lastGlobalStartAt: number;
  lastCompletedAt?: number;
  lastGap?: { afterTick: number; resumedAt: number; skippedTicks: number };
  lastIncomplete?: { tick: number; phase: string; creep?: string };
}

export interface CpuTickCheckpoint {
  tick: number;
  phase: string;
  creep?: string;
  completed: boolean;
}

let checkpoint: CpuTickCheckpoint | undefined;
let summary: CpuTickHealthSummary | undefined;

export function beginCpuTickHealth(): void {
  if (!summary) {
    const persisted = Memory.runtime?.cpuTickHealth;
    const previous = persisted?.summary ?? Memory.analytics?.cpuMonitor?.health;
    summary = { ...previous, globalStarts: (previous?.globalStarts ?? 0) + 1, lastGlobalStartAt: Game.time };
    if (persisted?.checkpoint && !persisted.checkpoint.completed && persisted.checkpoint.tick < Game.time) {
      summary.lastIncomplete = { tick: persisted.checkpoint.tick, phase: persisted.checkpoint.phase, creep: persisted.checkpoint.creep };
    }
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
  getMemoryService().ensureRuntime().cpuTickHealth = { checkpoint, summary };
}

/** 只记录最外层阶段；嵌套 creep 子阶段不覆盖正在执行的角色身份。 */
export function markCpuTickPhase(phase: string): void {
  if (checkpoint) { checkpoint.phase = phase; checkpoint.completed = false; delete checkpoint.creep; }
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
