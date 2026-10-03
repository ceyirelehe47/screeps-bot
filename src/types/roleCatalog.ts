export const ROLE_CATALOG = Object.freeze({
  harvester: "active",
  mineralHarvester: "active",
  miner: "active",
  carrier: "active",
  worker: "active",
  upgrader: "active",
  /** @deprecated 仅用于兼容部署前遗留配置。 */
  hubUpgrader: "legacy",
  scout: "active",
  claimer: "active",
  colonizerHarvester: "active",
  colonizerWorker: "active",
  meleeAttacker: "active",
  healer: "active",
  homeDefender: "active",
  crossShardClaimer: "active",
  crossShardColonizerHarvester: "active",
  crossShardColonizerWorker: "active",
  flagScout: "active",
  remoteCarrier: "active",
  remoteMiningCarrier: "active",
  powerBankScout: "active",
  powerBankAttacker: "active",
  powerBankHealer: "active",
  powerBankHauler: "active",
  depositHarvester: "active",
  remoteMiningReserver: "active",
  remoteWorker: "active",
  remoteDefender: "active",
} as const);

export type RoleName = keyof typeof ROLE_CATALOG;
export type RoleLifecycleStatus = (typeof ROLE_CATALOG)[RoleName];

export function isRoleName(value: unknown): value is RoleName {
  return typeof value === "string"
    && Object.prototype.hasOwnProperty.call(ROLE_CATALOG, value);
}
