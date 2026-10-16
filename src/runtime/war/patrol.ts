import type { WarTask } from "./store";
import { ensureWarStore, getPatrolInterval, isPatrolTask } from "./store";
import { hasTaskWarActivity, releaseWarTaskAssets, synchronizeGenerationRoleArgs } from "./production";
import { setTaskStatus } from "./fsm";

export function updatePatrolAssignments(task: WarTask): void {
  synchronizeGenerationRoleArgs(task, true);
}

export function advancePatrol(task: WarTask, nextIndex: number): boolean {
  const patrolRooms = task.patrolRooms;
  if (!patrolRooms?.[nextIndex]) return false;

  const store = ensureWarStore();
  const previousTarget = task.targetRoom;
  const nextTarget = patrolRooms[nextIndex];
  const collision = store[nextTarget];
  if (collision && collision !== task) {
    const terminal = collision.status === "done" || collision.status === "failed";
    if (terminal) {
      releaseWarTaskAssets(collision);
    }
    if (!terminal || hasTaskWarActivity(collision)) {
      task.failReason = `patrol_target_busy:${nextTarget}`;
      task.clearSince = Game.time;
      setTaskStatus(task, "clearing");
      return false;
    }
    delete store[nextTarget];
  }

  if (store[previousTarget] === task) {
    delete store[previousTarget];
  }
  task.targetRoom = nextTarget;
  task.patrolIndex = nextIndex;
  task.patrolNextSweepAt = undefined;
  task.routeRooms = undefined;
  task.clearSince = undefined;
  task.completedAt = undefined;
  task.controllerAttackerLastQueuedAt = undefined;
  task.failReason = undefined;
  task.attempts += 1;
  setTaskStatus(task, "staging");
  store[nextTarget] = task;
  updatePatrolAssignments(task);
  return true;
}

export function completePatrolTarget(task: WarTask): boolean {
  if (!isPatrolTask(task)) return false;

  const patrolRooms = task.patrolRooms!;
  const currentIndex = Math.max(0, task.patrolIndex ?? patrolRooms.indexOf(task.targetRoom));
  if (currentIndex + 1 < patrolRooms.length) {
    advancePatrol(task, currentIndex + 1);
    return true;
  }

  task.clearSince = undefined;
  task.patrolIndex = patrolRooms.length - 1;
  task.patrolNextSweepAt = Game.time + getPatrolInterval(task);
  setTaskStatus(task, "patrol_waiting");
  return true;
}
