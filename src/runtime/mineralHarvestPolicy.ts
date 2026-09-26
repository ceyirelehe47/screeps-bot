import {
  MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE,
  isMarketBaseResource,
} from "@/runtime/marketBaseResourcePolicy";

/** 原矿已足以覆盖市场保护储备和额外生产缓冲时暂停净流入。 */
export function shouldPauseNativeMineralHarvest(
  room: Room | undefined,
  resource: ResourceConstant,
): boolean {
  if (!room || !isMarketBaseResource(resource)) return false;
  const policy = MARKET_BASE_RESOURCE_POLICY_BY_RESOURCE[resource];
  const stored = room.storage?.store.getUsedCapacity?.(resource) ?? 0;
  const terminal = room.terminal?.store.getUsedCapacity?.(resource) ?? 0;
  if (
    !Number.isSafeInteger(stored) ||
    stored < 0 ||
    !Number.isSafeInteger(terminal) ||
    terminal < 0
  ) {
    return true;
  }
  return (
    stored + terminal >=
    policy.laneReserve + Math.max(100_000, policy.inventoryReferenceAmount * 2)
  );
}
