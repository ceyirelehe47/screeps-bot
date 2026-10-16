import type { WarStatus, WarTask } from "./store";
const ACTIVE: readonly WarStatus[] = ["queued", "staging", "clearing", "downgrading", "patrol_waiting", "done", "failed"];
export const WAR_TRANSITIONS: Readonly<Record<WarStatus, readonly WarStatus[]>> = {
  queued: ACTIVE, staging: ACTIVE, clearing: ACTIVE, downgrading: ACTIVE, patrol_waiting: ACTIVE,
  done: ["done"], failed: ["failed"],
};
export function setTaskStatus(task: WarTask, status: WarStatus): void {
  if (task.status === status) return;
  if (!WAR_TRANSITIONS[task.status].includes(status)) throw new Error(`非法战争转移 ${task.status} -> ${status}`);
  task.status = status; task.statusSince = Game.time; task.updatedAt = Game.time;
  delete task.nextCheckAt; delete task.scheduleKey; delete task.entryEffect;
}
/** 在副作用全部成功后记录，异常时下一 tick 可以继续清理。 */
export function onWarEntry(task: WarTask, event: string, enter: () => void): void {
  const key = `${task.status}:${event}`;
  if (task.entryEffect === key) return;
  enter(); task.entryEffect = key;
}
