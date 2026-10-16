import { measureSampledCpuPhase } from "@/runtime/cpuPhaseProfiler";
import type { WarTask } from "./store";
import { getSquadPolicy } from "./squadPolicy/index";
import { runSharedWarSquads } from "./shared";
import { activateFrontline, parkQueuedFrontline, processScheduledTask } from "./lifecycle";

export function admitWarTasks(store: Record<string, WarTask>): void {
  const tasks = Object.values(store);
  const sharedTasks = measureSampledCpuPhase("war.shared", () => runSharedWarSquads(store));
  const tasksBySource = new Map<string, WarTask[]>();
  for (const task of tasks) {
    if (sharedTasks.has(task)) continue;
    const sourceTasks = tasksBySource.get(task.sourceRoom) ?? [];
    sourceTasks.push(task);
    tasksBySource.set(task.sourceRoom, sourceTasks);
  }

  for (const sourceTasks of tasksBySource.values()) {
    const candidates = sourceTasks.filter(
      (task) => task.status !== "done" && task.status !== "failed",
    );
    const serialCandidates = candidates.filter((task) => !getSquadPolicy(task).parallel);
    const active = serialCandidates.find((task) => task.status !== "queued") ?? serialCandidates[0];

    for (const task of serialCandidates) {
      if (task !== active) {
        parkQueuedFrontline(task);
      }
    }

    if (active) {
      activateFrontline(active);
      measureSampledCpuPhase("war.process", () => processScheduledTask(active));
    }
    // 耗塔任务使用各自的双人 generation，允许同母房多个目标并行。
    for (const task of candidates.filter(task => getSquadPolicy(task).parallel)) {
      activateFrontline(task);
      measureSampledCpuPhase("war.process", () => processScheduledTask(task));
    }
  }

}
