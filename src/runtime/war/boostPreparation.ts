import { prepareCombatBoost } from "@/roles/combatBoosts";
import { prepareOptionalCombatBoost } from "@/roles/optionalCombatBoosts";
import { retireCreep } from "@/runtime/retirement";
import { getCreepConfigService } from "@/runtime/runtimeServices";

/** 战争所有者决定缺失强化后的退役，共享 lab 执行器不解释战争 Memory。 */
export function prepareWarCombatBoost(creep: Creep, taskId?: string, compounds?: string): boolean {
  if (creep.memory._warQueued) return false;
  const name = creep.memory.configName;
  if (!name?.includes(":war:")) return prepareOptionalCombatBoost(creep, taskId, compounds);
  const preparation = prepareCombatBoost(creep, taskId, compounds);
  if (preparation === "missing") {
    retireCreep(creep, { owner: "war", mode: "recycle", roomName: getCreepConfigService().get(name)?.roomName ?? creep.room.name });
  }
  return preparation === "ready";
}
