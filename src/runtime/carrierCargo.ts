import { getCreepAssignmentState } from "@/runtime/creepAssignmentState";

let cache: { tick: number; creeps: typeof Game.creeps; targets: Map<string, Map<ResourceConstant, string[]>> } | undefined;

/** 每 tick 只建一次目的地索引；读取时仍核对责任和货物，允许同 tick 退货/交付。 */
export function getCarrierCargoByActor(targetId: string, resource: ResourceConstant): Map<string, number> {
  if (!cache || cache.tick !== Game.time || cache.creeps !== Game.creeps) {
    const targets = new Map<string, Map<ResourceConstant, string[]>>();
    for (const creep of Object.values(Game.creeps)) {
      const state = getCreepAssignmentState(creep.name);
      const toId = state?.synthesisCarrierPendingToId;
      const carriedResource = state?.synthesisCarrierPendingResource;
      if (!toId || !carriedResource) continue;
      let resources = targets.get(toId);
      if (!resources) targets.set(toId, resources = new Map());
      let actors = resources.get(carriedResource);
      if (!actors) resources.set(carriedResource, actors = []);
      actors.push(creep.name);
    }
    cache = { tick: Game.time, creeps: Game.creeps, targets };
  }
  const cargo = new Map<string, number>();
  for (const actor of cache.targets.get(targetId)?.get(resource) ?? []) {
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
  if (!cache || cache.tick !== Game.time || cache.creeps !== Game.creeps) return;
  const state = getCreepAssignmentState(actor);
  const target = state?.synthesisCarrierPendingToId, resource = state?.synthesisCarrierPendingResource;
  if (!target || !resource) return;
  let resources = cache.targets.get(target);
  if (!resources) cache.targets.set(target, resources = new Map());
  let actors = resources.get(resource);
  if (!actors) resources.set(resource, actors = []);
  if (!actors.includes(actor)) actors.push(actor);
}
