import { getCreepAssignmentState } from "@/runtime/creepAssignmentState";

import { getTickContextService } from "@/runtime/runtimeServices";

/** 每 tick 只建一次目的地索引；读取时仍核对责任和货物，允许同 tick 退货/交付。 */
export function getCarrierCargoByActor(targetId: string, resource: ResourceConstant): Map<string, number> {
  const cargo = new Map<string, number>();
  for (const actor of getTickContextService().getCarrierCargoActors(targetId, resource)) {
    const state = getCreepAssignmentState(actor);
    if (state?.synthesisCarrierPendingToId !== targetId || state.synthesisCarrierPendingResource !== resource ||
        state.synthesisCarrierPendingReturnToId) continue;
    cargo.set(actor, Game.creeps[actor]?.store.getUsedCapacity(resource) ?? 0);
  }
  return cargo;
}

export function countCarrierCargo(targetId: string, resource: ResourceConstant): number {
  let total = 0;
  for (const amount of getCarrierCargoByActor(targetId, resource).values()) total += amount;
  return total;
}

/** carrier 在决策阶段新建或重定向快照后同步登记，后续同 tick 消费者可见。 */
export function refreshCarrierCargoActor(actor: string): void {
  getTickContextService().refreshCarrierCargoActor(actor);
}
