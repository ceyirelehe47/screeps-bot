import { inspectConfiguredSynthesisTransferDemand } from "@/runtime/synthesisControl";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";

export type AutomaticSynthesisTransferDemand =
  | { status: "unmanaged" }
  | { status: "held"; reason: string }
  | { status: "bounded"; amount: number; reason: string };

/** 只收敛明确绑定本房已启用配方的自动补料；Treasury 原责任不在这里交还。 */
export function inspectAutomaticSynthesisTransferDemand(
  task: ResourceTransferTask,
  additionalCoveredAmount = 0,
): AutomaticSynthesisTransferDemand {
  if (task.origin !== "automatic" || task.status !== "pending") return { status: "unmanaged" };
  const identity = /^synthesis:([^:]+):([^:]+)$/.exec(task.reason || "");
  if (!identity || identity[1] !== task.toRoomName) return { status: "unmanaged" };
  if (task.treasurySlice !== undefined) return { status: "held", reason: "treasury_responsibility_retained" };
  const demand = inspectConfiguredSynthesisTransferDemand(
    task.toRoomName, task.resource, identity[2] as ResourceConstant, task.id,
  );
  if (demand.status !== "bounded") return demand;
  const covered = Number.isSafeInteger(additionalCoveredAmount) && additionalCoveredAmount > 0
    ? additionalCoveredAmount : 0;
  return { ...demand, amount: Math.max(0, demand.amount - covered) };
}

/** 已确认的单批生产补料可使用物理空位；不修改全局 Storage/Terminal 保留线。 */
export function resolveSynthesisStagingFeedCapacity(
  ordinaryFeedCapacity: number,
  terminalFreeCapacity: number,
  destinationCommittedAmount: number,
  demandBounded: boolean,
  requiredFeedAmount = Number.POSITIVE_INFINITY,
): number {
  if (!demandBounded) return ordinaryFeedCapacity;
  const physicalFree = Math.max(0, terminalFreeCapacity - destinationCommittedAmount);
  return Math.max(
    Math.min(ordinaryFeedCapacity, physicalFree),
    Math.min(physicalFree, Math.max(0, requiredFeedAmount)),
  );
}
