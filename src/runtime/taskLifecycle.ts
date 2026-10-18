import { appendRuntimeEvent } from "@/runtime/runtimeEvents";

export interface TaskLifecycleState<Status extends string> {
  status: Status;
  statusSince?: number;
  updatedAt?: number;
  entryEffect?: string;
}

/** owner 给出合法转移；共享层只管理时间、事件及可重试副作用，不解释具体任务。 */
export function createTaskLifecycle<Status extends string, Task extends TaskLifecycleState<Status>>(owner: string,
  transitions: Readonly<Record<Status, readonly Status[]>>, identity: (task: Task) => string) {
  return {
    transition(task: Task, next: Status): boolean {
      if (task.status === next) return false;
      if (!transitions[task.status]?.includes(next)) throw new Error(`非法任务转移 ${owner}: ${task.status} -> ${next}`);
      const previous = task.status;
      task.status = next; task.statusSince = Game.time; task.updatedAt = Game.time;
      delete task.entryEffect;
      appendRuntimeEvent({ owner, id: identity(task), kind: "transition", from: previous, to: next });
      return true;
    },
    enter(task: Task, key: string, effect: () => void): void {
      const event = `${task.status}:${key}`;
      if (task.entryEffect === event) return;
      effect();
      task.entryEffect = event;
    },
  };
}
