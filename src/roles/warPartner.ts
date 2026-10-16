import { getTickContextService } from "@/runtime/runtimeServices";

/** 配置索引是 tick 快照；共享小队换名后必须再次核对当前归属。 */
export function warPartner(creep: Creep, role?: string, configName = creep.memory._warPartnerConfigName): Creep | undefined {
  if (!configName) return undefined;
  return getTickContextService().getCreepsByConfigName(configName).find(candidate =>
    candidate !== creep && Game.creeps[candidate.name] === candidate
    && candidate.memory.configName === configName && !candidate.memory._warDetached
    && (!role || candidate.memory.role === role));
}
