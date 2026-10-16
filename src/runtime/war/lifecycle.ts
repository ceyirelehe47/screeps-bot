import { measureSampledCpuPhase } from "@/runtime/cpuPhaseProfiler";
import { getSquadPolicy } from "./squadPolicy/index";
import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import type { WarTask } from "./store";
import { disableTaskProduction, getQueuedConfigs, releaseWarBoosts } from "./production";
import { getLiveCreepsByConfig, getTaskConfigNames } from "./store";
import { isT3DuoTask } from "./squadPolicy/index";
import { processTask } from "./process";
import { onWarEntry, setTaskStatus } from "./fsm";

export function processScheduledTask(task: WarTask): void {
  const sleeping = task.status === "patrol_waiting" && Game.time < (task.patrolNextSweepAt ?? 0)
    || task.status === "staging" && !Game.rooms[task.targetRoom];
  const actors = getTaskConfigNames(task).flatMap(getLiveCreepsByConfig);
  const key = `${actors.map(c => `${c.name}:${c.room.name}`).join("|")}:${getQueuedConfigs(task).join("|")}:${getTaskConfigNames(task).flatMap(name => getTickContextService().getSpawningByConfigName(name)).map(s => s.name).join("|")}:${Game.rooms[task.sourceRoom]?.energyCapacityAvailable}:${task.routeRooms?.join("|")}`;
  if (sleeping && task.scheduleKey === key && (task.nextCheckAt ?? 0) > Game.time) return;
  if (sleeping && task.scheduleKey !== key) task.scheduleKey = key;
  processTask(task);
  if (sleeping) task.nextCheckAt = Math.min(Game.time + 5, task.patrolNextSweepAt ?? Infinity);
}

export function setTaskCreepsQueued(task: WarTask, queued: boolean): void {
  for (const creep of getTaskConfigNames(task).flatMap(getLiveCreepsByConfig)) {
    if (queued) { if (!creep.memory._warQueued) creep.memory._warQueued = true; }
    else if (creep.memory._warQueued) delete creep.memory._warQueued;
  }
}

export function parkQueuedFrontline(task: WarTask): void {
  if (task.status === "queued" && task.failReason === "frontline_queued" && task.entryEffect === "queued:frontline_queued") { setTaskCreepsQueued(task, true); return; }
  setTaskStatus(task, "queued");
  onWarEntry(task, "frontline_queued", () => {
    task.clearSince = undefined; task.boostStatus = undefined; task.failReason = "frontline_queued";
    disableTaskProduction(task); releaseWarBoosts(task);
  });
  setTaskCreepsQueued(task, true);
}

export function activateFrontline(task: WarTask): void {
  if (task.status === "queued") {
    setTaskStatus(task, "staging");
    if (task.failReason === "frontline_queued") {
      task.failReason = undefined;
    }
    if (getSquadPolicy(task).needsBoost) {
      task.boostStatus = "preparing";
    }
  }
  setTaskCreepsQueued(task, false);
}

