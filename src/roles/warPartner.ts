import { registerSquadMovement } from "@/movement/traffic";
import { bindSquad, findSquadPartner, type Squad } from "@/runtime/squads/squad";
import { getTickContextService } from "@/runtime/runtimeServices";

/** 配置索引是 tick 快照；共享小队换名后必须再次核对当前归属。 */
export function warPartner(creep: Creep, role?: string, configName = creep.memory._warPartnerConfigName, readyOnly = false): Creep | undefined {
  if (!configName) return undefined;
  const partner = findSquadPartner(creep, getTickContextService().getCreepsByConfigName(configName), candidate =>
    Game.creeps[candidate.name] === candidate
    && candidate.memory.configName === configName && !candidate.memory._warDetached
    && (!role || candidate.memory.role === role) && (!readyOnly || !candidate.spawning));
  if (partner) {
    const squad = creep.memory.role === "meleeAttacker" ? warSquad(creep, partner) : warSquad(partner, creep);
    if (squad) registerSquadMovement(squad);
  }
  return partner;
}

export function warSquad(leader: Creep, follower: Creep): Squad | undefined {
  if (!leader.memory.configName || !follower.memory.configName || leader.memory.role !== "meleeAttacker" || follower.memory.role !== "healer") return undefined;
  return bindSquad({ owner: "war", taskId: JSON.stringify([leader.memory.configName, follower.memory.configName]),
    generation: JSON.stringify([leader.memory._warPartnerConfigName, follower.memory._warPartnerConfigName]), leader, follower },
    (member, slot) => !member.memory._warDetached && member.memory._warPartnerConfigName ===
      (slot === "leader" ? follower.memory.configName : leader.memory.configName));
}
