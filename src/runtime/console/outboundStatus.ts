import { outboundPhase, type OutboundFamily, type OutboundPhase } from "@/runtime/outboundMissionLifecycle";

interface OutboundMissionRow {
  family: OutboundFamily;
  id: string;
  source: string | null;
  target: string;
  status: string;
  phase: OutboundPhase;
  reason?: string;
  retryAt?: number;
}

/** 按需读取四类任务的共同调度状态，避免在 Memory 保存影子任务表。 */
export function outboundStatusRaw(filter: { room?: string; family?: OutboundFamily } = {}) {
  const rows: OutboundMissionRow[] = [];
  let total = 0;
  function add(row: OutboundMissionRow): void {
    if (filter.room && filter.room !== row.source && filter.room !== row.target) return;
    total++;
    if (rows.length < 100) rows.push(row);
  }
  if (!filter.family || filter.family === "remoteMining") {
    for (const [target, task] of Object.entries(Memory.data?.remoteMining ?? {})) {
      add({ family: "remoteMining", id: target, source: task.sourceRoom, target,
        status: task.status, phase: outboundPhase("remoteMining", task),
        reason: task.suspendReason ?? task.defenseReason ?? task.abandonedReason, retryAt: task.nextRetryAt });
    }
  }
  if (!filter.family || filter.family === "powerBank") {
    for (const task of Object.values(Memory.data?.powerBankHarvest ?? {})) {
      add({ family: "powerBank", id: task.id, source: task.sourceRoom || null, target: task.targetRoom,
        status: task.status, phase: outboundPhase("powerBank", task), reason: task.failReason ?? task.blocker, retryAt: task.nextAttemptAt });
    }
  }
  if (!filter.family || filter.family === "deposit") {
    for (const task of Object.values(Memory.data?.depositHarvest ?? {})) {
      add({ family: "deposit", id: task.id, source: task.sourceRoom || null, target: task.targetRoom,
        status: task.status, phase: outboundPhase("deposit", task), reason: task.stopReason ?? task.blocker, retryAt: task.nextAttemptAt });
    }
  }
  if (!filter.family || filter.family === "colonizationSupport") {
    for (const [target, task] of Object.entries(Memory.runtime?.colonizationSupport ?? {})) {
      add({ family: "colonizationSupport", id: task.runId, source: task.sourceRoom, target,
        status: task.status, phase: outboundPhase("colonizationSupport", task), reason: task.blocker });
    }
  }
  return { tick: Game.time, total, truncated: total > rows.length, tasks: rows };
}
