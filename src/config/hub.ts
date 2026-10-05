export const HUB_TARGET_COMPOUNDS: ResourceConstant[] = [
  RESOURCE_CATALYZED_UTRIUM_ACID, // XUH2O
  RESOURCE_CATALYZED_UTRIUM_ALKALIDE, // XUHO2
  RESOURCE_CATALYZED_KEANIUM_ACID, // XKH2O
  RESOURCE_CATALYZED_KEANIUM_ALKALIDE, // XKHO2
  RESOURCE_CATALYZED_LEMERGIUM_ACID, // XLH2O
  RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE, // XLHO2
  RESOURCE_CATALYZED_ZYNTHIUM_ACID, // XZH2O
  RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE, // XZHO2
  RESOURCE_CATALYZED_GHODIUM_ACID, // XGH2O
  RESOURCE_CATALYZED_GHODIUM_ALKALIDE, // XGHO2
  RESOURCE_HYDROXIDE, // OH：仅 HUB 储备，作为全部 T3 的共用中间产物。
];

export function isHubOnlyReserveCompound(resource: ResourceConstant): boolean {
  return resource === RESOURCE_HYDROXIDE;
}

export const HUB_PLAN_INTERVAL = 50;
export const HUB_RESERVE_PER_ROOM = 5000;
export const HUB_RESERVE_PER_COMPOUND = 20_000;
/** T3 是供应网络的周转库存；发货只保留本房五千，生产补库目标独立。 */
export const HUB_T3_SUPPLY_FLOOR = 5_000;
export const HUB_OH_RESERVE = 50_000;

export function getHubOnlyReserve(config: { hubOnlyReservePerCompound?: number } | undefined): number {
  const amount = config?.hubOnlyReservePerCompound;
  return typeof amount === "number" && Number.isFinite(amount) && amount >= 0
    ? Math.floor(amount) : HUB_OH_RESERVE;
}
export const HUB_STORAGE_PAUSE_FREE_CAPACITY = 100_000;
export const HUB_SURPLUS_THRESHOLD = HUB_RESERVE_PER_ROOM + 500;
export const HUB_INTERNAL_ONLY = true;
export const HUB_DISTRIBUTED_STORAGE = true;
