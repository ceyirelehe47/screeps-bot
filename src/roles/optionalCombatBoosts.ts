import { prepareCombatBoost } from "@/roles/combatBoosts";

/** upgrader 与殖民支援的可选强化策略；超时继续工作，保留原任务身份。 */
export function prepareOptionalCombatBoost(creep: Creep, taskId?: string, compounds?: string): boolean {
  if (taskId && creep.memory._optionalBoostSkipped === taskId) return true;
  const preparation = prepareCombatBoost(creep, taskId, compounds);
  if (preparation === "missing") {
    creep.memory._optionalBoostSkipped = taskId;
    return true;
  }
  return preparation === "ready";
}
