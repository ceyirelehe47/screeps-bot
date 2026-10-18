import { createTaskLifecycle } from "@/runtime/taskLifecycle";
import type { WarStatus, WarTask } from "./store";
const ACTIVE: readonly WarStatus[] = ["queued", "staging", "clearing", "downgrading", "patrol_waiting", "done", "failed"];
export const WAR_TRANSITIONS: Readonly<Record<WarStatus, readonly WarStatus[]>> = {
  queued: ACTIVE, staging: ACTIVE, clearing: ACTIVE, downgrading: ACTIVE, patrol_waiting: ACTIVE,
  done: ["done"], failed: ["failed"],
};
export function setTaskStatus(task: WarTask, status: WarStatus): void {
  if (task.status === status) return;
  lifecycle.transition(task, status);
  delete task.nextCheckAt; delete task.scheduleKey; delete task.entryEffect;
}
/** 在副作用全部成功后记录，异常时下一 tick 可以继续清理。 */
export function onWarEntry(task: WarTask, event: string, enter: () => void): void {
  lifecycle.enter(task, event, enter);
}

const lifecycle = createTaskLifecycle<WarStatus, WarTask>("war", WAR_TRANSITIONS, task => task.targetRoom);
