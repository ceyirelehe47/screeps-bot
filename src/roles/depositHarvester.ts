import { setDepositTaskStatus } from "@/runtime/depositHarvest";
import { moveToTarget, moveToTargetRoom } from "@/roles/shared";
import { measureCreepIntent } from "@/runtime/cpuPhaseProfiler";
import { executeTreasuryFencedTerminalCargo } from "@/runtime/treasuryTerminalCargo";
import { findDepositSafeRoute, finishDepositTask, getDepositAvoidRooms, getDepositHarvestConfig,
  isDepositTerminal, type DepositHarvesterMemory, type DepositHarvestTask } from "@/runtime/depositHarvest";
import { isDepositRoomSafe, measureDepositReturn } from "@/runtime/depositPathDistance";
import { DEPOSIT_RETURN_BUFFER, predictDepositHarvest } from "@/runtime/depositViability";
import type { RoleFactory } from "@/types/system";

interface Delivery {
  target: StructureStorage | StructureTerminal;
  routeRooms: string[];
  travelTicks: number;
}
interface DeliveryPending { pending: true }
function memory(creep: Creep): CreepMemory & DepositHarvesterMemory {
  return creep.memory as CreepMemory & DepositHarvesterMemory;
}
function cargoResource(creep: Creep): ResourceConstant | undefined {
  const resource = memory(creep).depositResourceType;
  if (resource && creep.store.getUsedCapacity(resource) > 0) return resource;
  return Object.keys(creep.store).find((key) => typeof creep.store[key as ResourceConstant] === "number" &&
    creep.store.getUsedCapacity(key as ResourceConstant) > 0) as ResourceConstant | undefined;
}
function cargo(creep: Creep): number { return creep.store.getUsedCapacity() || 0; }
function getTask(creep: Creep, taskId?: string): DepositHarvestTask | undefined {
  const mem = memory(creep);
  const id = mem.taskId ?? taskId;
  const task = id ? Memory.data?.depositHarvest?.[id] : undefined;
  if (!task || task.configName !== creep.memory.configName || (task.creepName && task.creepName !== creep.name)) return undefined;
  mem.taskId = task.id; mem.depositHomeRoom = task.sourceRoom; mem.depositResourceType = task.resourceType;
  return task;
}
function activeBody(creep: Creep): BodyPartConstant[] {
  // MOVE/CARRY 只算有效部件；其余受损部件仍按质量上界保守计时。
  return creep.body.filter((part) => part.hits > 0 || (part.type !== MOVE && part.type !== CARRY)).map((p) => p.type);
}
function stop(creep: Creep, task: DepositHarvestTask | undefined, reason: string): void {
  const mem = memory(creep);
  mem.depositReturning = true;
  if (task && !isDepositTerminal(task)) {
    // 同 tick 再次 mounted 调用仍在等 transfer 对账，不能降回 returning。
    if (!mem.depositPendingTransfer) setDepositTaskStatus(task, "returning");
    task.stopReason ??= reason;
  }
}
function confirmPreviousActions(creep: Creep, task: DepositHarvestTask | undefined): void {
  const mem = memory(creep);
  const harvested = mem.depositHarvestBefore;
  if (harvested && harvested.tick < Game.time) {
    if (task) task.harvestedAmount += Math.max(0, (creep.store.getUsedCapacity(task.resourceType) || 0) - harvested.amount);
    delete mem.depositHarvestBefore;
  }
  const transfer = mem.depositPendingTransfer;
  if (transfer && transfer.tick < Game.time) {
    const delivered = Math.min(transfer.amount, Math.max(0, transfer.before - (creep.store.getUsedCapacity(transfer.resource) || 0)));
    if (task && transfer.resource === task.resourceType) task.deliveredAmount += delivered;
    delete mem.depositPendingTransfer;
  }
}
function deliveryCandidates(creep: Creep, prospective: number): Array<StructureStorage | StructureTerminal> {
  const mem = memory(creep); const avoid = getDepositAvoidRooms();
  const candidates = Object.values(Game.rooms).filter((r) => r.controller?.my && isDepositRoomSafe(r.name, avoid))
    .flatMap((r) => [r.storage, r.terminal].filter((s): s is StructureStorage | StructureTerminal =>
      Boolean(s && s.store.getFreeCapacity() >= Math.max(1, prospective))));
  return candidates.sort((a, b) => {
    const rank = (s: StructureStorage | StructureTerminal): number => s.id === mem.depositDeliveryTargetId ? 0 :
      s.room.name === mem.depositHomeRoom ? 1 : 2;
    return rank(a) - rank(b) || a.room.name.localeCompare(b.room.name) || a.id.localeCompare(b.id);
  });
}
function findDelivery(creep: Creep, loadedAmount: number): Delivery | DeliveryPending | undefined {
  const body = activeBody(creep);
  const maxCarry = body.filter((p) => p === CARRY).length * CARRY_CAPACITY;
  if (loadedAmount > maxCarry) return undefined;
  let pending = false;
  for (const target of deliveryCandidates(creep, memory(creep).depositReturning ? 1 : loadedAmount)) {
    const routeRooms = findDepositSafeRoute(creep.room.name, target.pos.roomName);
    if (!routeRooms) continue;
    const result = measureDepositReturn({ origin: creep.pos, returnTarget: target.pos, body, loadedAmount,
      routeRooms, avoidRooms: getDepositAvoidRooms() });
    if (result.status !== "ready") { pending = true; continue; }
    const moves = body.filter((p) => p === MOVE).length;
    const currentFatigueWait = moves > 0 ? Math.ceil(Math.max(0, creep.fatigue || 0) / (moves * 2)) : Infinity;
    const travelTicks = result.returnTravelTicks + currentFatigueWait;
    if (typeof creep.ticksToLive !== "number" || creep.ticksToLive <= travelTicks + DEPOSIT_RETURN_BUFFER) continue;
    return { target, routeRooms, travelTicks };
  }
  return pending ? { pending: true } : undefined;
}
function finishEmpty(creep: Creep, task: DepositHarvestTask | undefined): boolean {
  const mem = memory(creep);
  if (cargo(creep) > 0 || mem.depositPendingTransfer) return false;
  if (task && !isDepositTerminal(task)) finishDepositTask(task,
    task.deliveredAmount > 0 ? "complete" : "aborted", task.stopReason);
  creep.suicide();
  return false; // mounted lifecycle 不再在同 tick 切回 source。
}
function deliver(creep: Creep, task: DepositHarvestTask | undefined): boolean {
  const mem = memory(creep);
  if (mem.depositIntentTick === Game.time || mem.depositPendingTransfer) return false;
  if (cargo(creep) === 0) return finishEmpty(creep, task);
  const resource = cargoResource(creep);
  if (!resource) return false;
  const body = activeBody(creep);
  const usableCarry = body.filter((p) => p === CARRY).length * CARRY_CAPACITY;
  const measuredLoad = Math.min(cargo(creep), usableCarry);
  const delivery = findDelivery(creep, measuredLoad);
  if (!delivery || "pending" in delivery) {
    if (task) { task.blocker = "return_path_capacity_or_ttl_pending"; task.nextAttemptAt = Game.time + 1; }
    return false;
  }
  mem.depositDeliveryTargetId = delivery.target.id;
  if (task) { delete task.blocker; setDepositTaskStatus(task, "returning"); }
  if (creep.room.name !== delivery.target.pos.roomName) {
    moveToTargetRoom(creep, delivery.target.pos.roomName, delivery.routeRooms.join("|"),
      { profile: "travel", reusePath: 10, avoidRooms: getDepositAvoidRooms() });
    return false;
  }
  if (!creep.pos.isNearTo(delivery.target)) { moveToTarget(creep, delivery.target, 1); return false; }
  const before = creep.store.getUsedCapacity(resource) || 0;
  const amount = Math.min(before, delivery.target.store.getFreeCapacity());
  if (amount <= 0) return false;
  const code = measureCreepIntent(() => executeTreasuryFencedTerminalCargo(delivery.target,
    () => creep.transfer(delivery.target, resource, amount)));
  mem.depositIntentTick = Game.time;
  if (code === OK) {
    mem.depositPendingTransfer = { tick: Game.time, before, amount, resource, targetId: delivery.target.id };
    if (task) setDepositTaskStatus(task, "unloading");
  } else if (code === ERR_NOT_IN_RANGE) moveToTarget(creep, delivery.target, 1);
  return false;
}

/** 单次旅程；source/target 都尊重 store 次 tick 对账，不能同 tick harvest/transfer 两次。 */
export const depositHarvesterRole: RoleFactory = (taskId?: string, homeRoom?: string) => ({
  prepare(creep) {
    const task = getTask(creep, taskId); const mem = memory(creep);
    mem.depositHomeRoom ??= task?.sourceRoom ?? homeRoom ?? creep.memory.configName?.split(":")[0];
    if (!task || isDepositTerminal(task)) mem.depositReturning = true;
    return true;
  },
  source(creep) {
    const task = getTask(creep, taskId); const mem = memory(creep);
    confirmPreviousActions(creep, task);
    if (mem.depositIntentTick === Game.time) return false;
    if (!task || isDepositTerminal(task) || mem.depositReturning || task.status === "returning" || task.status === "unloading") {
      mem.depositReturning = true; return true;
    }
    const config = getDepositHarvestConfig();
    if (!config.enabled || Game.time >= task.expiresAt || !isDepositRoomSafe(creep.room.name, getDepositAvoidRooms())) {
      stop(creep, task, !config.enabled ? "disabled" : "expired_or_danger"); return true;
    }
    if (creep.room.name !== task.targetRoom) {
      const route = findDepositSafeRoute(creep.room.name, task.targetRoom);
      if (!route || typeof creep.ticksToLive !== "number" ||
        creep.ticksToLive <= (task.returnTravelTicks ?? Infinity) + DEPOSIT_RETURN_BUFFER + 1) {
        stop(creep, task, "outbound_route_or_ttl"); return true;
      }
      moveToTargetRoom(creep, task.targetRoom, route.join("|"), { profile: "travel", reusePath: 10, avoidRooms: getDepositAvoidRooms() });
      return false;
    }
    const deposit = Game.getObjectById<Deposit>(task.depositId as Id<Deposit>);
    if (!deposit || deposit.depositType !== task.resourceType || deposit.pos.roomName !== task.targetRoom ||
      deposit.pos.x !== task.depositPos.x || deposit.pos.y !== task.depositPos.y) {
      stop(creep, task, "deposit_missing_or_changed"); return true;
    }
    task.lastCooldown = deposit.lastCooldown; task.cooldown = deposit.cooldown; task.lastSeenAt = Game.time;
    task.expiresAt = Math.min(task.expiresAt, Game.time + deposit.ticksToDecay);
    if (!creep.pos.isNearTo(deposit)) { moveToTarget(creep, deposit, 1); return false; }
    const maxLoad = activeBody(creep).filter((p) => p === CARRY).length * CARRY_CAPACITY;
    const delivery = findDelivery(creep, maxLoad);
    if (!delivery) { stop(creep, task, "return_path_unproven"); return true; }
    if ("pending" in delivery) { task.blocker = "return_path_measurement_pending"; return false; }
    delete task.blocker;
    mem.depositDeliveryTargetId = delivery.target.id;
    const free = creep.store.getFreeCapacity(); const work = creep.getActiveBodyparts(WORK);
    const budget = Math.min(CREEP_LIFE_TIME, task.expiresAt - Game.time - 1,
      creep.ticksToLive! - delivery.travelTicks - DEPOSIT_RETURN_BUFFER - 1);
    const estimate = predictDepositHarvest({ lastCooldown: deposit.lastCooldown, cooldown: deposit.cooldown,
      workParts: work, capacity: Math.min(free, work), harvestBudget: Math.max(0, Math.floor(budget)), maxCooldown: config.maxCooldown });
    if (free <= 0 || work === 0 || estimate.expectedAmount <= 0 || deposit.lastCooldown > config.maxCooldown) {
      stop(creep, task, free <= 0 ? "full" : "cooldown_or_ttl_exhausted"); return true;
    }
    setDepositTaskStatus(task, "harvesting");
    if (deposit.cooldown > 0) return false;
    const before = creep.store.getUsedCapacity(task.resourceType) || 0;
    const code = measureCreepIntent(() => creep.harvest(deposit));
    mem.depositIntentTick = Game.time;
    if (code === OK) mem.depositHarvestBefore = { tick: Game.time, amount: before };
    else if (code !== ERR_TIRED && code !== ERR_NOT_IN_RANGE) { stop(creep, task, `harvest_error_${code}`); return true; }
    return false;
  },
  target(creep) {
    const task = getTask(creep, taskId);
    confirmPreviousActions(creep, task);
    stop(creep, task, task?.stopReason ?? "single_trip_return");
    return deliver(creep, task);
  },
});
