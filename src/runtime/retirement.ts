import { getCreepAssignmentState } from "@/runtime/creepAssignmentState";
import { appendRuntimeEvent } from "@/runtime/runtimeEvents";
import { clearCreepMovementState } from "@/movement/creepState";
import { releasePickupReservation } from "@/runtime/energyPickupReservation";
import { getTickContextService } from "@/runtime/runtimeServices";

export type RetirementOwner = "war" | "powerBank" | "colonization" | "workforce";
interface Retirement {
  owner: RetirementOwner;
  mode: "detach" | "recycle" | "suicide";
  roomName?: string;
  releaseTask?: boolean;
}

/** owner 选择退役方式；统一解除成员关系，保留角色与货物以完成返程。 */
export function retireCreepMemory(memory: CreepMemory, decision: Retirement): void {
  if (decision.mode === "suicide") memory._retireSuicideOwner = decision.owner;
  if (decision.owner === "war") {
    memory._warDetached = true;
    delete memory._warPartnerConfigName;
    delete memory._warQueued;
  }
  if (memory._warRetireToRoom && !memory._recycleToRoom) memory._recycleToRoom = memory._warRetireToRoom;
  if (decision.mode === "recycle" && decision.roomName) memory._recycleToRoom = decision.roomName;
  if (decision.releaseTask) delete (memory as CreepMemory & { taskId?: string }).taskId;
  delete memory._warRetireToRoom;
  delete memory.configName;
}

const suicideAttempts = new WeakMap<Creep, number>();
function submitSuicide(creep: Creep): boolean {
  if (suicideAttempts.get(creep) === Game.time) return false;
  suicideAttempts.set(creep, Game.time);
  return creep.suicide() === OK;
}

export function retireCreep(creep: Creep, decision: Retirement): boolean {
  const previousName = creep.memory.configName;
  const changed = !!previousName || decision.mode === "recycle" && creep.memory._recycleToRoom !== decision.roomName;
  retireCreepMemory(creep.memory, decision);
  const suicided = decision.mode === "suicide" && submitSuicide(creep);
  if (previousName) getTickContextService().reindexCreepConfig(creep, previousName);
  clearCreepMovementState(creep);
  const assignment = getCreepAssignmentState(creep.name);
  if (assignment?.energyPickupTargetId || assignment?.energyPickupRoomName) releasePickupReservation(creep);
  if (changed) appendRuntimeEvent({ owner: decision.owner, id: creep.name, kind: "retirement", from: previousName, to: decision.mode });
  return suicided;
}

/** 孵化中的单位不能立即 suicide；保留 owner 请求，出生后优先提交退役，在实际死亡前始终阻止业务。 */
export function continueCreepRetirement(creep: Creep): boolean {
  if (!creep.memory._retireSuicideOwner) return false;
  if (!creep.spawning) submitSuicide(creep);
  return true;
}
