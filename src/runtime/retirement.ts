import { getTickContextService } from "@/runtime/runtimeServices";

interface Retirement {
  owner: "war" | "powerBank" | "colonization";
  mode: "detach" | "recycle" | "suicide";
  roomName?: string;
}

/** owner 选择退役方式；统一解除成员关系，保留角色与货物以完成返程。 */
export function retireCreepMemory(memory: CreepMemory, decision: Retirement): void {
  if (decision.owner === "war") {
    memory._warDetached = true;
    delete memory._warPartnerConfigName;
    delete memory._warQueued;
  }
  if (decision.mode === "recycle" && decision.roomName) memory._recycleToRoom = decision.roomName;
  delete memory.configName;
}

export function retireCreep(creep: Creep, decision: Retirement): boolean {
  const previousName = creep.memory.configName;
  const suicided = decision.mode === "suicide" && creep.suicide() === OK;
  retireCreepMemory(creep.memory, decision);
  if (previousName) getTickContextService().reindexCreepConfig(creep, previousName);
  return suicided;
}
