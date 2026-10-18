import type { RoleName } from "@/types/system";

export type SpawnIntent = "local" | "income" | "expedition";

const OUTBOUND_ROLES = new Set<RoleName>([
  "colonizerHarvester", "colonizerWorker", "colonizerUpgrader", "crossShardColonizerHarvester",
  "crossShardColonizerWorker", "crossShardClaimer", "remoteCarrier", "remoteMiningCarrier",
  "remoteMiningReserver", "remoteWorker", "remoteDefender", "claimer", "scout", "flagScout", "powerBankScout",
  "powerBankAttacker", "powerBankHealer", "powerBankHauler", "depositHarvester",
]);
const EXPEDITION_ROLES = new Set<RoleName>([
  "powerBankAttacker", "powerBankHealer", "powerBankHauler", "depositHarvester",
  "claimer", "colonizerWorker", "colonizerUpgrader",
  "crossShardClaimer", "crossShardColonizerWorker", "crossShardColonizerHarvester",
]);

/** 防御/储备共用角色意图；具体任务所有者可补充配置级出征意图与投入证明。 */
export function getRoleSpawnIntent(role: RoleName): SpawnIntent {
  return EXPEDITION_ROLES.has(role) ? "expedition" : OUTBOUND_ROLES.has(role) ? "income" : "local";
}
