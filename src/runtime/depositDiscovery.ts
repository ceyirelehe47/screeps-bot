import { isPowerBankSearchRoom } from "@/runtime/powerBankConstants";
import type { DepositHarvestTask } from "@/runtime/depositHarvest";
import { hasTaskActors } from "@/runtime/taskActors";

export function cleanupDepositDiscoveryTasks(): number {
  const tasks = Memory.data?.depositHarvest;
  if (!tasks) return 0;
  let removed = 0;
  for (const [id, task] of Object.entries(tasks)) {
    if (["complete", "aborted", "failed"].includes(task.status) && Game.time > task.expiresAt + 5_000 &&
        !hasTaskActors(task.configName ? [task.configName] : [], id)) {
      delete tasks[id]; removed++;
    }
  }
  return removed;
}

export function ensureDepositDiscoveryStore(): Record<string, DepositHarvestTask> {
  Memory.data ??= {};
  Memory.data.depositHarvest ??= {};
  return Memory.data.depositHarvest;
}

/** 同一 Deposit 只有一个任务；终态不会因再次观察而复活。 */
export function recordDepositDiscovery(deposit: Deposit): void {
  if (!deposit?.pos || !isPowerBankSearchRoom(deposit.pos.roomName) || typeof deposit.id !== "string" ||
    ![deposit.ticksToDecay, deposit.cooldown, deposit.lastCooldown].every((v) => Number.isSafeInteger(v) && v >= 0)) return;
  const tasks = ensureDepositDiscoveryStore();
  const prior = tasks[deposit.id];
  if (prior) {
    if (prior.resourceType !== deposit.depositType || prior.targetRoom !== deposit.pos.roomName ||
      prior.depositPos.x !== deposit.pos.x || prior.depositPos.y !== deposit.pos.y) return;
    prior.lastSeenAt = Game.time;
    prior.expiresAt = Game.time + deposit.ticksToDecay;
    prior.lastCooldown = deposit.lastCooldown;
    prior.cooldown = deposit.cooldown;
    return;
  }
  // 发现记录有界；先清已过期终态，绝不驱逐活任务或复活尚在场的终态。
  cleanupDepositDiscoveryTasks();
  if (Object.keys(tasks).length >= 256) return;
  tasks[deposit.id] = {
    id: deposit.id, depositId: deposit.id, status: "discovered", generation: 0,
    targetRoom: deposit.pos.roomName, depositPos: { x: deposit.pos.x, y: deposit.pos.y },
    resourceType: deposit.depositType, sourceRoom: "", discoveredAt: Game.time, lastSeenAt: Game.time,
    expiresAt: Game.time + deposit.ticksToDecay, cooldown: deposit.cooldown, lastCooldown: deposit.lastCooldown,
    harvestedAmount: 0, deliveredAmount: 0,
  };
}
