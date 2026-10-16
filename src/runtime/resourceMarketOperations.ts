/** 从 resourceControl.ts 分离的独立职责模块；共享状态仅由此处持有。 */
import { getProductReagents, roundUpReactionAmount } from "@/runtime/reactionMap";
import { roomResourceAmount } from "@/runtime/synthesisReadModel";
import { isHubOnlyReserveCompound } from "@/config/hub";
import {
  RESOURCE_CONTROL_BASE_MINERALS as BASE_MINERALS,
  type ResourceThresholdMap,
} from "@/runtime/resourceControlRoomConfig";
import { declareMarketActionIntent, executeMarketDeal } from "@/runtime/marketActionArbiter";
import {
  roomResourceKey,
  getStock,
  getTerminalResourceAmount,
  getResourceControlRoomStock,
} from "@/runtime/resourceControlReadModel";
import type { ResourceControlSnapshot, ResourceControlTransferContext } from "@/runtime/resourceControlReadModel";


const HUB_INTERMEDIATES: ResourceConstant[] = [
  RESOURCE_HYDROXIDE,
  RESOURCE_ZYNTHIUM_KEANITE,
  RESOURCE_UTRIUM_LEMERGITE,
  RESOURCE_GHODIUM,
  RESOURCE_UTRIUM_HYDRIDE,
  RESOURCE_UTRIUM_OXIDE,
  RESOURCE_KEANIUM_HYDRIDE,
  RESOURCE_KEANIUM_OXIDE,
  RESOURCE_LEMERGIUM_HYDRIDE,
  RESOURCE_LEMERGIUM_OXIDE,
  RESOURCE_ZYNTHIUM_HYDRIDE,
  RESOURCE_ZYNTHIUM_OXIDE,
  RESOURCE_GHODIUM_HYDRIDE,
  RESOURCE_GHODIUM_OXIDE,
  RESOURCE_UTRIUM_ACID,
  RESOURCE_UTRIUM_ALKALIDE,
  RESOURCE_KEANIUM_ACID,
  RESOURCE_KEANIUM_ALKALIDE,
  RESOURCE_LEMERGIUM_ACID,
  RESOURCE_LEMERGIUM_ALKALIDE,
  RESOURCE_ZYNTHIUM_ACID,
  RESOURCE_ZYNTHIUM_ALKALIDE,
  RESOURCE_GHODIUM_ACID,
  RESOURCE_GHODIUM_ALKALIDE,
];

export interface ResourceControlMarketConfig {
  enabled: boolean;
  emergencyBuyEnabled: boolean;
  creditReserve?: number;
  energyShadowPrice?: number;
  nativeMineralAutoSellThreshold: number;
  maxDealsPerRun: number;
  minDealAmount: number;
  maxDealAmount: number;
  maxDealEnergyCostRatio: number;
  minSellPrice: ResourceThresholdMap;
  maxBuyPrice: ResourceThresholdMap;
  sellResources: ResourceConstant[];
  buyResources: ResourceConstant[];
}

/**
 * 永久关闭 ResourceControl 和旧 Hub surplus 的所有出售写路径。
 *
 * 生产缺口和生存用途的购买仍由 emergencyBuyEnabled 单独控制。现代出售只能
 * 通过经过 permit/WAL 校验的 Direct automation 进入 market arbiter。
 */
export const LEGACY_RESOURCE_CONTROL_SELLER_PERMANENTLY_DISABLED = true;

function getSynthesisDemandTarget(
  roomName: string,
  resource: ResourceConstant,
): number {
  const value =
    Memory.cfg?.resourceControl?.synthesis?.rooms?.[roomName]?.demands?.[
      resource
    ];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

function getActiveSynthesisMissing(
  roomName: string,
  resource: ResourceConstant,
): number {
  const value =
    Memory.runtime?.synthesisControl?.rooms?.[roomName]?.missing?.[resource];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

function getEnergyAvailableForFees(snapshot: ResourceControlSnapshot): number {
  return Math.max(0, snapshot.terminalEnergy - snapshot.terminalEnergyReserve);
}

export function getNativeMineralAutoSellSurplus(
  room: ResourceControlSnapshot,
  nativeMineralAutoSellThreshold: number,
): number {
  if (!room.canMineNative || !room.nativeMineralType) {
    return 0;
  }

  return Math.max(
    0,
    getStock(room, room.nativeMineralType) - nativeMineralAutoSellThreshold,
  );
}

function getSellResourcesForRoom(
  room: ResourceControlSnapshot,
  marketCfg: ResourceControlMarketConfig,
): ResourceConstant[] {
  const sellResources = marketCfg.sellResources.filter(
    (resource) => resource !== RESOURCE_ENERGY,
  );
  const hubSellResources =
    room.roomName === Memory.cfg?.hub?.hubRoomName
      ? getHubMarketSellResources()
      : [];
  const combined = [...new Set([...hubSellResources, ...sellResources])];
  if (!room.canMineNative || !room.nativeMineralType) {
    return combined;
  }

  return [
    room.nativeMineralType,
    ...combined.filter((resource) => resource !== room.nativeMineralType),
  ];
}

function shouldSkipMarketBuyForResource(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
): boolean {
  if (resource === RESOURCE_ENERGY) {
    return false;
  }

  return snapshot.canMineNative && snapshot.nativeMineralType === resource;
}

function getMarketBuyDemandDeficit(
  snapshot: ResourceControlSnapshot,
  resource: ResourceConstant,
  context: ResourceControlTransferContext,
): number {
  if (resource === RESOURCE_ENERGY) {
    return 0;
  }

  const room = Game.rooms[snapshot.roomName];
  // 内部 send 已接受后 Store 尚未更新，而调拨任务已扣减；补上本 tick 快照的收货差量。
  const current = room?.controller?.my
    ? getResourceControlRoomStock(room, resource) + getTerminalResourceAmount(snapshot, resource)
      - (room.terminal?.store.getUsedCapacity(resource) ?? 0)
    : getStock(snapshot, resource);
  const incoming =
    context.healthyIncomingByRoomResource.get(
      roomResourceKey(snapshot.roomName, resource),
    ) || 0;
  const state = Memory.runtime?.synthesisControl?.rooms?.[snapshot.roomName];
  if (getActiveSynthesisMissing(snapshot.roomName, resource) > 0 && room && state?.activeProduct &&
      ["acquiring", "loading", "synthesizing"].includes(state.stage) &&
      getProductReagents(state.activeProduct)?.includes(resource) &&
      typeof state.batchSize === "number" && typeof state.targetAmount === "number") {
    // missing 是上次采样的净缺口；从实际批次重建毛需求，再扣当帧库存和在途。
    const productDeficit = Math.max(0, state.targetAmount - roomResourceAmount(room, state.activeProduct));
    const required = Math.min(state.batchSize, roundUpReactionAmount(productDeficit));
    return Math.max(0, required - current - incoming);
  }
  const demandTarget = getSynthesisDemandTarget(snapshot.roomName, resource);
  return Math.max(0, demandTarget - current - incoming);
}

function findBestBuyOrder(
  type: ORDER_BUY | ORDER_SELL,
  resource: ResourceConstant,
  roomName: string,
  amount: number,
  maxDealEnergyCostRatio: number,
  priceCap?: number,
  priceFloor?: number,
  energyShadowPrice = 0.12,
): Order | null {
  const orders = Game.market.getAllOrders({ type, resourceType: resource });
  let best: Order | null = null;
  let bestEffectivePrice = Infinity;

  for (const order of orders) {
    if (order.amount < amount || !order.roomName) {
      continue;
    }

    if (priceCap !== undefined && order.price > priceCap) {
      continue;
    }
    if (priceFloor !== undefined && order.price < priceFloor) {
      continue;
    }

    const cost = Game.market.calcTransactionCost(
      amount,
      roomName,
      order.roomName,
    );
    const ratio = amount > 0 ? cost / amount : Infinity;
    if (ratio > maxDealEnergyCostRatio) {
      continue;
    }

    if (type === ORDER_SELL) {
      const effectivePrice = resource === RESOURCE_ENERGY
        ? (amount > cost ? order.price * amount / (amount - cost) : Infinity)
        : order.price + cost / amount * energyShadowPrice;
      if (!Number.isFinite(effectivePrice) || (priceCap !== undefined && effectivePrice > priceCap)) continue;
      if (effectivePrice < bestEffectivePrice) { best = order; bestEffectivePrice = effectivePrice; }
      continue;
    }
    if (!best) {
      best = order;
      continue;
    }

    if (type === ORDER_BUY) {
      if (order.price > best.price) {
        best = order;
      }
    } else if (order.price < best.price) {
      best = order;
    }
  }

  return best;
}

function isHubProtectedResource(
  resource: ResourceConstant,
  roomName: string,
): boolean {
  const hubCfg = Memory.cfg?.hub;
  if (!hubCfg) {
    return false;
  }

  const isHubRoom = hubCfg.hubRoomName === roomName;
  const targetCompounds = hubCfg.targetCompounds || [];

  if (!isHubRoom) {
    if (targetCompounds.includes(resource) && !isHubOnlyReserveCompound(resource)) return true;
    if (isResourceCommittedToDistributedSynthesis(roomName, resource))
      return true;
    return false;
  }

  const surplus = Memory.runtime?.hub?.marketSellSurplus?.[resource];
  if (surplus != null && surplus > 0) {
    return false;
  }

  return (
    targetCompounds.includes(resource) ||
    HUB_INTERMEDIATES.includes(resource) ||
    BASE_MINERALS.includes(resource)
  );
}

function isResourceCommittedToDistributedSynthesis(
  roomName: string,
  resource: ResourceConstant,
): boolean {
  const assignments =
    Memory.runtime?.hub?.distributedSynthesis?.dispatchAssignments;
  if (!assignments) return false;

  const assignment = assignments.find((a) => a.roomName === roomName);
  if (!assignment) return false;

  const routeDecisions =
    Memory.runtime?.hub?.distributedSynthesis?.routeDecisions ?? [];
  for (const route of routeDecisions) {
    if (
      route.fromRoom === roomName &&
      route.resource === resource &&
      route.amount > 0
    ) {
      return true;
    }
  }

  return false;
}

function getHubMarketSellResources(): ResourceConstant[] {
  if (!Memory.cfg?.hub?.marketSellEnabled) return [];
  const surplus = Memory.runtime?.hub?.marketSellSurplus;
  if (!surplus) return [];
  return (Object.entries(surplus) as [ResourceConstant, number][])
    .filter(([, amount]) => amount > 0)
    .map(([resource]) => resource);
}

export function applyMarketOps(
  snapshots: ResourceControlSnapshot[],
  marketCfg: ResourceControlMarketConfig,
  terminalBusy: Set<string>,
  context: ResourceControlTransferContext,
): string[] {
  if (marketCfg.maxDealsPerRun <= 0) {
    return [];
  }

  const actions: string[] = [];
  let dealsDone = 0;
  let availableCredits = Math.max(0, (Game.market.credits || 0) - (marketCfg.creditReserve ?? 100_000));

  // 永久闩与 Memory 配置无关。Emergency/production purchases 仍由
  // `emergencyBuyEnabled` 独立控制，不能因关闭旧卖家而移除生存购买。
  if (
    !LEGACY_RESOURCE_CONTROL_SELLER_PERMANENTLY_DISABLED &&
    marketCfg.enabled
  ) {
    const exportRooms = snapshots
      .filter((snapshot) => snapshot.terminal.cooldown === 0)
      .filter(
        (snapshot) =>
          snapshot.state === "export" ||
          getNativeMineralAutoSellSurplus(
            snapshot,
            marketCfg.nativeMineralAutoSellThreshold,
          ) >= marketCfg.minDealAmount,
      )
      .sort((left, right) => right.storageEnergy - left.storageEnergy);

    for (const room of exportRooms) {
      if (dealsDone >= marketCfg.maxDealsPerRun) {
        break;
      }
      if (terminalBusy.has(room.roomName)) {
        continue;
      }

      for (const resource of getSellResourcesForRoom(room, marketCfg)) {
        if (
          resource !== RESOURCE_ENERGY &&
          isHubProtectedResource(resource, room.roomName)
        ) {
          continue;
        }

        const isNativeAutoSell =
          room.canMineNative && room.nativeMineralType === resource;
        const hubSurplusAmount =
          Memory.runtime?.hub?.marketSellSurplus?.[resource];
        const isHubSurplusSell =
          room.roomName === Memory.cfg?.hub?.hubRoomName &&
          hubSurplusAmount != null &&
          hubSurplusAmount > 0;
        if (room.state !== "export" && !isNativeAutoSell && !isHubSurplusSell) {
          continue;
        }

        const total = getStock(room, resource);
        const outgoingReserved =
          resource === RESOURCE_ENERGY
            ? 0
            : context.healthyOutgoingByRoomResource.get(
                roomResourceKey(room.roomName, resource),
              ) || 0;
        const effectiveTotal = Math.max(0, total - outgoingReserved);
        const exportStart =
          resource === RESOURCE_ENERGY
            ? room.energyExportStart
            : room.mineralExportStart[resource] || 0;
        const sellThreshold = isHubSurplusSell
          ? Math.max(0, effectiveTotal - hubSurplusAmount!)
          : isNativeAutoSell
            ? Math.min(exportStart, marketCfg.nativeMineralAutoSellThreshold)
            : exportStart;
        const surplus = isHubSurplusSell
          ? hubSurplusAmount!
          : Math.max(0, effectiveTotal - sellThreshold);
        if (surplus < marketCfg.minDealAmount) {
          continue;
        }

        const terminalResource = getTerminalResourceAmount(room, resource);
        let amount = Math.min(
          surplus,
          terminalResource,
          marketCfg.maxDealAmount,
        );
        if (amount < marketCfg.minDealAmount) {
          continue;
        }

        if (resource === RESOURCE_ENERGY) {
          amount = Math.min(
            amount,
            Math.max(0, getEnergyAvailableForFees(room)),
          );
          if (amount < marketCfg.minDealAmount) {
            continue;
          }
        }

        const minSellPrice = marketCfg.minSellPrice[resource];
        const order = findBestBuyOrder(
          ORDER_BUY,
          resource,
          room.roomName,
          amount,
          marketCfg.maxDealEnergyCostRatio,
          undefined,
          minSellPrice,
        );
        if (!order || !order.roomName) {
          continue;
        }

        const cost = Game.market.calcTransactionCost(
          amount,
          room.roomName,
          order.roomName,
        );
        if (
          resource === RESOURCE_ENERGY &&
          amount + cost > getEnergyAvailableForFees(room)
        ) {
          continue;
        }
        if (
          resource !== RESOURCE_ENERGY &&
          cost > getEnergyAvailableForFees(room)
        ) {
          continue;
        }

        const code = executeMarketDeal(
          order.id,
          amount,
          room.roomName,
          "resourceControl:legacy-sell",
          {
            orderType: ORDER_BUY,
            resourceType: resource,
            orderRoomName: order.roomName,
          },
        );
        if (code !== OK) {
          actions.push(
            `market-sell-failed:${room.roomName}:${resource}:code=${code}`,
          );
          continue;
        }

        room.terminalEnergy = Math.max(
          0,
          room.terminalEnergy -
            (resource === RESOURCE_ENERGY ? amount : 0) -
            cost,
        );
        terminalBusy.add(room.roomName);
        dealsDone += 1;
        actions.push(
          `market-sell:${room.roomName}:${resource}=${amount}:price=${order.price.toFixed(3)}:cost=${cost}`,
        );
        break;
      }
    }

    const hubCfg = Memory.cfg?.hub;
    if (hubCfg?.hubRoomName && dealsDone < marketCfg.maxDealsPerRun) {
      const hubSnapshot = snapshots.find(
        (s) => s.roomName === hubCfg.hubRoomName,
      );
      if (
        hubSnapshot &&
        hubSnapshot.terminal.cooldown === 0 &&
        !terminalBusy.has(hubSnapshot.roomName)
      ) {
        for (const resource of getHubMarketSellResources()) {
          if (dealsDone >= marketCfg.maxDealsPerRun) break;
          if (
            resource === RESOURCE_ENERGY ||
            resource === RESOURCE_POWER ||
            resource === RESOURCE_OPS
          )
            continue;

          const surplusAmount =
            Memory.runtime?.hub?.marketSellSurplus?.[resource];
          if (surplusAmount == null || surplusAmount < marketCfg.minDealAmount)
            continue;

          const terminalResource = getTerminalResourceAmount(
            hubSnapshot,
            resource,
          );
          const amount = Math.min(
            surplusAmount,
            terminalResource,
            marketCfg.maxDealAmount,
          );
          if (amount < marketCfg.minDealAmount) continue;

          const sellOrders = Game.market.getAllOrders({
            type: ORDER_SELL,
            resourceType: resource,
          });
          const referencePrice =
            sellOrders.length > 0
              ? Math.min(...sellOrders.map((o) => o.price))
              : 0;
          const priceFloor =
            referencePrice > 0
              ? referencePrice * 0.5
              : marketCfg.minSellPrice[resource];
          const order = findBestBuyOrder(
            ORDER_BUY,
            resource,
            hubSnapshot.roomName,
            amount,
            marketCfg.maxDealEnergyCostRatio,
            undefined,
            priceFloor,
          );
          if (!order || !order.roomName) continue;

          const actualCost = Game.market.calcTransactionCost(
            amount,
            hubSnapshot.roomName,
            order.roomName,
          );
          if (actualCost > hubSnapshot.terminalEnergy) continue;

          const code = executeMarketDeal(
            order.id,
            amount,
            hubSnapshot.roomName,
            "resourceControl:legacy-hub-sell",
            {
              orderType: ORDER_BUY,
              resourceType: resource,
              orderRoomName: order.roomName,
            },
          );
          if (code !== OK) {
            actions.push(
              `hub-surplus-sell-failed:${hubSnapshot.roomName}:${resource}:code=${code}`,
            );
            continue;
          }

          hubSnapshot.terminalEnergy = Math.max(
            0,
            hubSnapshot.terminalEnergy - actualCost,
          );
          terminalBusy.add(hubSnapshot.roomName);
          dealsDone += 1;
          actions.push(
            `hub-surplus-sell:${hubSnapshot.roomName}:${resource}=${amount}:price=${order.price.toFixed(3)}:cost=${actualCost}`,
          );
        }
      }
    }
  }

  if (!marketCfg.emergencyBuyEnabled || dealsDone >= marketCfg.maxDealsPerRun) {
    return actions;
  }

  const survivalRooms = snapshots
    .filter(
      (snapshot) =>
        snapshot.state === "survival" && snapshot.terminal.cooldown === 0,
    )
    .sort((left, right) => left.storageEnergy - right.storageEnergy);

  for (const room of survivalRooms) {
    if (dealsDone >= marketCfg.maxDealsPerRun) {
      break;
    }
    if (terminalBusy.has(room.roomName)) {
      continue;
    }

    const incoming = context.healthyIncomingByRoomResource.get(roomResourceKey(room.roomName, RESOURCE_ENERGY)) || 0;
    const need = Math.max(0, room.energyTarget - room.storageEnergy - room.terminalEnergy - incoming);
    if (need < marketCfg.minDealAmount) {
      continue;
    }

    if (shouldSkipMarketBuyForResource(room, RESOURCE_ENERGY)) {
      continue;
    }

    const terminalFree = Math.min(
      room.terminalFreeCapacity,
      room.terminal.store.getFreeCapacity(RESOURCE_ENERGY),
    );
    const amount = Math.min(need, marketCfg.maxDealAmount, terminalFree);
    if (amount < marketCfg.minDealAmount) {
      continue;
    }

    const maxBuyPrice = marketCfg.maxBuyPrice[RESOURCE_ENERGY];
    const order = findBestBuyOrder(
      ORDER_SELL,
      RESOURCE_ENERGY,
      room.roomName,
      amount,
      marketCfg.maxDealEnergyCostRatio,
      maxBuyPrice,
      undefined,
      marketCfg.energyShadowPrice,
    );
    if (!order || !order.roomName) {
      continue;
    }

    const transferCost = Game.market.calcTransactionCost(
      amount,
      room.roomName,
      order.roomName,
    );
    if (transferCost > getEnergyAvailableForFees(room) || amount * order.price > availableCredits) {
      continue;
    }

    declareMarketActionIntent(
      "resourceControl:legacy-energy-buy",
      "market_deal",
      room.roomName,
    );
    const code = executeMarketDeal(
      order.id,
      amount,
      room.roomName,
      "resourceControl:legacy-energy-buy",
      {
        orderType: ORDER_SELL,
        resourceType: RESOURCE_ENERGY,
        orderRoomName: order.roomName,
      },
    );
    if (code !== OK) {
      actions.push(`market-buy-failed:${room.roomName}:energy:code=${code}`);
      continue;
    }

    availableCredits -= amount * order.price;
    room.terminalEnergy = Math.max(
      0,
      room.terminalEnergy + amount - transferCost,
    );
    terminalBusy.add(room.roomName);
    dealsDone += 1;
    actions.push(
      `market-buy:${room.roomName}:energy=${amount}:price=${order.price.toFixed(3)}:cost=${transferCost}`,
    );
  }

  if (dealsDone >= marketCfg.maxDealsPerRun) {
    return actions;
  }

  const mineralBuyRooms = snapshots
    .filter((snapshot) => snapshot.terminal.cooldown === 0)
    .sort((left, right) => left.storageEnergy - right.storageEnergy);

  for (const room of mineralBuyRooms) {
    if (dealsDone >= marketCfg.maxDealsPerRun) {
      break;
    }
    if (terminalBusy.has(room.roomName)) {
      continue;
    }

    // Skip market buys for hub room when internalOnly is active
    const hubCfg = Memory.cfg?.hub;
    if (
      hubCfg &&
      hubCfg.enabled !== false &&
      hubCfg.hubRoomName === room.roomName &&
      hubCfg.internalOnly !== false
    ) {
      continue;
    }

    for (const resource of marketCfg.buyResources) {
      if (dealsDone >= marketCfg.maxDealsPerRun) {
        break;
      }
      if (resource === RESOURCE_ENERGY || !BASE_MINERALS.includes(resource)) {
        continue;
      }
      if (shouldSkipMarketBuyForResource(room, resource)) {
        continue;
      }

      const deficit = getMarketBuyDemandDeficit(room, resource, context);
      if (deficit < marketCfg.minDealAmount) {
        continue;
      }

      const maxBuyPrice = marketCfg.maxBuyPrice[resource];
      if (
        typeof maxBuyPrice !== "number" ||
        !Number.isFinite(maxBuyPrice) ||
        maxBuyPrice <= 0
      ) {
        continue;
      }

      const terminalFree = Math.min(
        room.terminalFreeCapacity,
        room.terminal.store.getFreeCapacity(resource),
      );
      const amount = Math.min(deficit, marketCfg.maxDealAmount, terminalFree);
      if (amount < marketCfg.minDealAmount) {
        continue;
      }

      const order = findBestBuyOrder(
        ORDER_SELL,
        resource,
        room.roomName,
        amount,
        marketCfg.maxDealEnergyCostRatio,
        maxBuyPrice,
        undefined,
        marketCfg.energyShadowPrice,
      );
      if (!order || !order.roomName) {
        continue;
      }

      const transferCost = Game.market.calcTransactionCost(
        amount,
        room.roomName,
        order.roomName,
      );
      if (transferCost > getEnergyAvailableForFees(room) || amount * order.price > availableCredits) {
        continue;
      }

      declareMarketActionIntent(
        "resourceControl:legacy-mineral-buy",
        "market_deal",
        room.roomName,
      );
      const code = executeMarketDeal(
        order.id,
        amount,
        room.roomName,
        "resourceControl:legacy-mineral-buy",
        {
          orderType: ORDER_SELL,
          resourceType: resource,
          orderRoomName: order.roomName,
        },
      );
      if (code !== OK) {
        actions.push(
          `market-buy-failed:${room.roomName}:${resource}:code=${code}`,
        );
        continue;
      }

      availableCredits -= amount * order.price;
      room.terminalEnergy = Math.max(0, room.terminalEnergy - transferCost);
      terminalBusy.add(room.roomName);
      dealsDone += 1;
      actions.push(
        `market-buy:${room.roomName}:${resource}=${amount}:price=${order.price.toFixed(3)}:cost=${transferCost}`,
      );
      break;
    }
  }

  return actions;
}
