import { createTaskLifecycle, type TaskLifecycleState } from "@/runtime/taskLifecycle";
import type { DepositHarvestStatus } from "@/runtime/depositHarvest";
import type { RemoteMiningStatus } from "@/runtime/remoteMining";

export type OutboundPhase = "discovering" | "waiting" | "preparing" | "active" | "returning" | "complete" | "stopped";
type SupportStatus = NonNullable<ScreepsMemoryRuntime["colonizationSupport"]>[string]["status"];

const phases = {
  remoteMining: {
    scouting: "discovering", active: "active", suspended: "waiting", defending: "active", abandoned: "stopped",
  } satisfies Record<RemoteMiningStatus, OutboundPhase>,
  powerBank: {
    discovered: "discovering", preparing_boosts: "preparing", spawning: "preparing", renewing: "preparing",
    boosting: "preparing", travelling: "active", attacking: "active", hauling: "returning", complete: "complete", aborted: "stopped", failed: "stopped",
  } satisfies Record<PowerBankHarvestStatus, OutboundPhase>,
  deposit: {
    discovered: "discovering", spawning: "preparing", outbound: "active", harvesting: "active",
    returning: "returning", unloading: "returning", complete: "complete", aborted: "stopped", failed: "stopped",
  } satisfies Record<DepositHarvestStatus, OutboundPhase>,
  colonizationSupport: {
    waiting_claim: "waiting", supporting: "active", paused: "waiting", complete: "complete",
  } satisfies Record<SupportStatus, OutboundPhase>,
} as const;

export type OutboundFamily = keyof typeof phases;
type Stage<F extends OutboundFamily> = Extract<keyof (typeof phases)[F], string>;
interface WaitState { blocker?: string; nextAttemptAt?: number }

export function outboundPhase<F extends OutboundFamily>(family: F, task: {status: Stage<F>} & WaitState): OutboundPhase {
  const stage: OutboundPhase = (phases[family] as Record<string, OutboundPhase>)[task.status];
  if (stage === "discovering" || stage === "preparing" || stage === "active") {
    if (task.blocker && (task.nextAttemptAt ?? 0) > Game.time) return "waiting";
  }
  return stage;
}

export function outboundStageEnded<F extends OutboundFamily>(family: F, status: Stage<F>): boolean {
  const phase = outboundPhase(family, { status });
  return phase === "complete" || phase === "stopped";
}

export function deferOutboundTask(task: WaitState, reason: string, retryAfter: number): void {
  task.blocker = reason;
  task.nextAttemptAt = Game.time + Math.max(1, retryAfter);
}

export function outboundRetryDue(task: WaitState): boolean {
  return task.nextAttemptAt === undefined || Game.time >= task.nextAttemptAt;
}

/** 同一任务类型先结算返程，再维护在途单位，最后才把本轮预算交给新候选。
 * 已到期或暂时等待的记录仍交给 owner 检查期限，避免跳过终态回收。 */
export function orderOutboundWork<F extends OutboundFamily, T extends TaskLifecycleState<Stage<F>> & WaitState>(
  family: F, tasks: readonly T[], compareCandidates: (left: T, right: T) => number,
): T[] {
  const returning: T[] = [], ongoing: T[] = [], candidates: T[] = [];
  for (const task of tasks) {
    const nativePhase = outboundPhase(family, { status: task.status });
    if (nativePhase === "returning") returning.push(task);
    else if (nativePhase === "discovering") candidates.push(task);
    else ongoing.push(task);
  }
  return returning.concat(ongoing, candidates.sort(compareCandidates));
}

/** 原生阶段留在任务自己的记录里，关闭的任务不可通过相同身份再开一轮。 */
export function createOutboundLifecycle<F extends OutboundFamily, T extends TaskLifecycleState<Stage<F>>>(
  family: F, transitions: Readonly<Record<Stage<F>, readonly Stage<F>[]>>, identity: (task: T) => string,
) {
  const lifecycle = createTaskLifecycle<Stage<F>, T>(family, transitions, identity);
  return {
    transition(task: T, next: Stage<F>): boolean {
      if (next !== task.status && outboundStageEnded(family, task.status)) {
        throw new Error(`外出任务已结束 ${family}/${identity(task)} ${task.status} -> ${next}`);
      }
      return lifecycle.transition(task, next);
    },
  };
}
