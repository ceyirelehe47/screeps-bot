import { getDepositHarvestConfig } from "@/runtime/depositHarvest";

export function depositStatusRaw() {
  return { tick: Game.time, config: getDepositHarvestConfig(),
    tasks: Object.values(Memory.data?.depositHarvest ?? {}).map((task) => ({
      id: task.id, status: task.status, sourceRoom: task.sourceRoom, targetRoom: task.targetRoom,
      resourceType: task.resourceType, expiresAt: task.expiresAt, lastCooldown: task.lastCooldown,
      expectedAmount: task.expectedAmount, harvestedAmount: task.harvestedAmount, deliveredAmount: task.deliveredAmount,
      bornAt: task.bornAt, blocker: task.blocker, stopReason: task.stopReason,
    })) };
}
export function depositStatusCommand(): string { return JSON.stringify(depositStatusRaw(), null, 2); }
