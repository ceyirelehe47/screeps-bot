import type { CarrierTask, CarrierTaskStep } from "@/runtime/carrierTaskBoard";
import { getCreepAssignmentState } from "@/runtime/creepAssignmentState";
import { inspectAutomaticSynthesisTransferDemand } from "@/runtime/synthesisTransferDemand";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";

export function terminalFeedBoundTaskIdentity(task: ResourceTransferTask): string {
  return JSON.stringify([task.id, task.createdAt, task.origin, task.fromRoomName, task.toRoomName, task.resource, task.reason ?? null, task.amount]);
}

interface PickupIntent { targetId: string; resource: ResourceConstant; amount: number }
interface DeliveryIntents { beforeAmount: number; amount: number }
let intentLedger: { game: Game; tick: number; pickups: Map<string, PickupIntent>; deliveries: Map<string, DeliveryIntents>; deliveredByActor: Map<string, PickupIntent> };
function ledger() {
  if (!intentLedger || intentLedger.game !== Game || intentLedger.tick !== Game.time) {
    intentLedger = { game: Game, tick: Game.time, pickups: new Map(), deliveries: new Map(), deliveredByActor: new Map() };
  }
  return intentLedger;
}
function resourceKey(targetId: string, resource: ResourceConstant): string { return JSON.stringify([targetId, resource]); }

/** 新板有明确 target；旧生产板只在唯一 canonical 自动补料身份可证明时恢复该上限。 */
export function readTerminalFeedTargetAmount(task: CarrierTask, step: CarrierTaskStep): number | undefined {
  if (task.type !== "terminal_feed" || step.toKind !== "terminal") return undefined;
  let target = step.destinationTargetAmount;
  if (target !== undefined && (!Number.isSafeInteger(target) || target < 0)) return 0;
  if (step.boundResourceTransferTaskId) {
    const live = Memory.data?.resourceControl?.tasks[step.boundResourceTransferTaskId];
    if (!live || live.fromRoomName !== task.roomName || live.resource !== step.resource ||
        step.boundResourceTransferTaskIdentity !== undefined && step.boundResourceTransferTaskIdentity !== terminalFeedBoundTaskIdentity(live)) return 0;
    const demand = inspectAutomaticSynthesisTransferDemand(live);
    return demand.status === "bounded" ? Math.min(target ?? demand.amount, demand.amount) : 0;
  }
  if (task.producer === "resourceControl:preload") {
    const candidates = Object.values(Memory.data?.resourceControl?.tasks || {}).filter((entry) =>
      entry.status === "pending" && entry.origin === "automatic" && entry.fromRoomName === task.roomName &&
      entry.resource === step.resource && /^synthesis:([^:]+):([^:]+)$/.test(entry.reason || ""));
    if (candidates.length === 1) {
      const demand = inspectAutomaticSynthesisTransferDemand(candidates[0]);
      if (demand.status === "bounded") target = Math.min(target ?? demand.amount, demand.amount);
      if (demand.status === "held") target = 0;
    }
  }
  return target;
}

export function revalidateTerminalFeedSnapshotTarget(
  target: AnyStoreStructure, resource: ResourceConstant, targetAmount: number, boundTaskId?: string, boundTaskIdentity?: string,
): number {
  if (!Number.isSafeInteger(targetAmount) || targetAmount < 0) return 0;
  if (!boundTaskId) return targetAmount;
  const task = Memory.data?.resourceControl?.tasks[boundTaskId];
  if (!task || task.fromRoomName !== target.room?.name || task.resource !== resource ||
      boundTaskIdentity !== undefined && boundTaskIdentity !== terminalFeedBoundTaskIdentity(task)) return 0;
  const demand = inspectAutomaticSynthesisTransferDemand(task);
  return demand.status === "bounded" ? Math.min(targetAmount, demand.amount) : 0;
}

/** Store 下一 tick 才改变：目标 stock、accepted 在途货与本 tick intent 必须一起覆盖目标。 */
export function getTerminalFeedRemainingTarget(
  target: AnyStoreStructure, resource: ResourceConstant, targetAmount: number, excludeCargoActor?: string,
): number {
  const current = ledger();
  const cargoByActor = new Map<string, number>();
  for (const creep of Object.values(Game.creeps)) {
    if (creep.name === excludeCargoActor) continue;
    const state = getCreepAssignmentState(creep.name);
    if (state?.synthesisCarrierPendingToId === target.id && state.synthesisCarrierPendingResource === resource && !state.synthesisCarrierPendingReturnToId) {
      const delivery = current.deliveredByActor.get(creep.name);
      const accepted = delivery?.targetId === target.id && delivery.resource === resource ? delivery.amount : 0;
      cargoByActor.set(creep.name, Math.max(0, creep.store.getUsedCapacity(resource) - accepted));
    }
  }
  for (const [actor, pickup] of current.pickups) {
    if (actor === excludeCargoActor || pickup.targetId !== target.id || pickup.resource !== resource) continue;
    if (getCreepAssignmentState(actor)?.synthesisCarrierPendingReturnToId) continue;
    const delivery = current.deliveredByActor.get(actor);
    const accepted = delivery?.targetId === target.id && delivery.resource === resource ? delivery.amount : 0;
    cargoByActor.set(actor, Math.max(cargoByActor.get(actor) || 0, Math.max(0, pickup.amount - accepted)));
  }
  const stock = target.store.getUsedCapacity(resource);
  const deliveries = current.deliveries.get(resourceKey(target.id, resource));
  const unreflectedDelivery = deliveries ? Math.max(0, deliveries.beforeAmount + deliveries.amount - stock) : 0;
  return Math.max(0, targetAmount - stock - unreflectedDelivery - [...cargoByActor.values()].reduce((sum, amount) => sum + amount, 0));
}

export function noteTerminalFeedAcceptedPickup(actor: string, targetId: string, resource: ResourceConstant, amount: number): void {
  ledger().pickups.set(actor, { targetId, resource, amount });
}
export function noteTerminalFeedAcceptedDelivery(actor: string, target: AnyStoreStructure, resource: ResourceConstant, amount: number, beforeAmount: number): void {
  const current = ledger();
  const key = resourceKey(target.id, resource);
  const previous = current.deliveries.get(key);
  current.deliveries.set(key, { beforeAmount: previous?.beforeAmount ?? beforeAmount, amount: (previous?.amount || 0) + amount });
  const actorDelivery = current.deliveredByActor.get(actor);
  current.deliveredByActor.set(actor, { targetId: target.id, resource, amount: (actorDelivery?.amount || 0) + amount });
}
