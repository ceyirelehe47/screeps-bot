import { inspectSynthesisTransferNeed } from "@/runtime/synthesisControl";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import type { TreasuryTerminalLane } from "@/runtime/treasuryTerminalLane";

/** 新 OH 首片按当前真实需求收敛；旧 H/UH 的额度语义不变。 */
export function resolveTreasuryTerminalSliceAmount(lane: TreasuryTerminalLane, task: ResourceTransferTask, maximum = 100): number {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100 ||
      !Number.isSafeInteger(task.remainingAmount) || task.remainingAmount < 1) return 0;
  const amount = Math.min(maximum, task.remainingAmount, 100);
  if (!lane.demandBoundedSlice) return amount;
  if (lane.requiredProduct === undefined) return 0;
  const need = inspectSynthesisTransferNeed(task.toRoomName, task.resource, lane.requiredProduct, task.id);
  return need.ok && Number.isSafeInteger(need.amount) && need.amount > 0 ? Math.min(amount, need.amount) : 0;
}
