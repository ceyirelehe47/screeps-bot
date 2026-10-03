import { carrierRole } from "@/roles/carrier";
import { claimerRole } from "@/roles/claimer";
import { flagScoutRole } from "@/roles/flagScout";
import { colonizerHarvesterRole } from "@/roles/colonizerHarvester";
import { colonizerWorkerRole } from "@/roles/colonizerWorker";
import { crossShardColonizerHarvesterRole } from "@/roles/crossShardColonizerHarvester";
import { crossShardColonizerWorkerRole } from "@/roles/crossShardColonizerWorker";
import { crossShardClaimerRole } from "@/roles/crossShardClaimer";
import { harvesterRole } from "@/roles/harvester";
import { healerRole } from "@/roles/healer";
import { upgraderRole } from "@/roles/upgrader";
import { homeDefenderRole } from "@/roles/homeDefender";
import { meleeAttackerRole } from "@/roles/meleeAttacker";
import { minerRole } from "@/roles/miner";
import { mineralHarvesterRole } from "@/roles/mineralHarvester";
import { powerBankAttackerRole } from "@/roles/powerBankAttacker";
import { powerBankHaulerRole } from "@/roles/powerBankHauler";
import { powerBankHealerRole } from "@/roles/powerBankHealer";
import { powerBankScoutRole } from "@/roles/powerBankScout";
import { remoteCarrierRole } from "@/roles/remoteCarrier";
import { remoteMiningCarrierRole } from "@/roles/remoteMiningCarrier";
import { remoteMiningReserverRole } from "@/roles/remoteMiningReserver";
import { remoteDefenderRole } from "@/roles/remoteDefender";
import { remoteWorkerRole } from "@/roles/remoteWorker";
import { scoutRole } from "@/roles/scout";
import { workerRole } from "@/roles/worker";
import { depositHarvesterRole } from "@/roles/depositHarvester";
import type { RoleFactory, RoleName } from "@/types/system";

export const roleRegistry: Record<RoleName, RoleFactory> = {
  harvester: harvesterRole,
  mineralHarvester: mineralHarvesterRole,
  miner: minerRole,
  carrier: carrierRole,
  worker: workerRole,
  upgrader: upgraderRole,
  hubUpgrader: upgraderRole,
  scout: scoutRole,
  claimer: claimerRole,
  colonizerHarvester: colonizerHarvesterRole,
  colonizerWorker: colonizerWorkerRole,
  crossShardColonizerHarvester: crossShardColonizerHarvesterRole,
  crossShardColonizerWorker: crossShardColonizerWorkerRole,
  homeDefender: homeDefenderRole,
  meleeAttacker: meleeAttackerRole,
  healer: healerRole,
  crossShardClaimer: crossShardClaimerRole,
  flagScout: flagScoutRole,
  remoteCarrier: remoteCarrierRole,
  remoteMiningCarrier: remoteMiningCarrierRole,
  remoteMiningReserver: remoteMiningReserverRole,
  remoteWorker: remoteWorkerRole,
  remoteDefender: remoteDefenderRole,
  powerBankScout: powerBankScoutRole,
  powerBankAttacker: powerBankAttackerRole,
  powerBankHealer: powerBankHealerRole,
  powerBankHauler: powerBankHaulerRole,
  depositHarvester: depositHarvesterRole,
};
