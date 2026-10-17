import { resolveMarketCreditReserve, getAvailableMarketCredits } from "@/runtime/marketActionArbiter";
/** 从 resourceControl.ts 分离的独立职责模块；共享状态仅由此处持有。 */
import { getProductReagents, roundUpReactionAmount } from "@/runtime/reactionMap";
import { roomResourceAmount } from "@/runtime/synthesisReadModel";
import {
  RESOURCE_CONTROL_BASE_MINERALS as BASE_MINERALS,
  type ResourceThresholdMap,
} from "@/runtime/resourceControlRoomConfig";
import { declareMarketActionIntent, executeMarketDeal } from "@/runtime/marketActionArbiter";
import {
  roomResourceKey,
  getStock,
  getTotalMovableResourceAmount,
  resolveCapacityConfig,
  getTerminalResourceAmount,
  getResourceControlRoomStock,
} from "@/runtime/resourceControlReadModel";
import type { ResourceControlSnapshot, ResourceControlTransferContext } from "@/runtime/resourceControlReadModel";

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

const marketOrders = new Map<string, Order[]>();
function findBestBuyOrder(
  type: ORDER_BUY | ORDER_SELL,
  resource: ResourceConstant,
  roomName: string,
  amount: number,
  maxDealEnergyCostRatio: number,
  priceCap?: number,
  priceFloor?: number,
  energyShadowPrice = 0.12,
  minimumDealAmount = 1,
): Order | null {
  const key = `${type}:${resource}`;
  let orders = marketOrders.get(key);
  if (!orders) { orders = Game.market.getAllOrders({ type, resourceType: resource }).map(order => ({ ...order })); marketOrders.set(key, orders); }
  let best: Order | null = null;
  let bestEffectivePrice = Infinity;

  for (const order of orders) {
    if (order.amount < minimumDealAmount || !order.roomName) {
      continue;
    }

    if (priceCap !== undefined && order.price > priceCap) {
      continue;
    }
    if (priceFloor !== undefined && order.price < priceFloor) {
      continue;
    }

    const dealAmount = Math.min(amount, order.amount);
    const cost = Game.market.calcTransactionCost(dealAmount, roomName, order.roomName);
    const ratio = cost / dealAmount;
    if (ratio > maxDealEnergyCostRatio) {
      continue;
    }

    if (type === ORDER_SELL) {
      const effectivePrice = resource === RESOURCE_ENERGY
        ? (dealAmount > cost ? order.price * dealAmount / (dealAmount - cost) : Infinity)
        : order.price + cost / dealAmount * energyShadowPrice;
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

export function applyMarketOps(
  snapshots: ResourceControlSnapshot[],
  marketCfg: ResourceControlMarketConfig,
  terminalBusy: Set<string>,
  context: ResourceControlTransferContext,
): string[] {
  if (marketCfg.maxDealsPerRun <= 0) {
    return [];
  }

  marketOrders.clear();
  const actions: string[] = [];
  let dealsDone = 0;
  let availableCredits = getAvailableMarketCredits(resolveMarketCreditReserve(marketCfg.creditReserve));

  // 出售由 Direct automation 统一执行；这里只保留生存和生产购买。
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
    let amount = Math.min(need, marketCfg.maxDealAmount, terminalFree);
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
      marketCfg.minDealAmount,
    );
    if (!order || !order.roomName) {
      continue;
    }

    amount = Math.min(amount, order.amount);
    if (amount < marketCfg.minDealAmount) continue;
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
        price: order.price,
      },
    );
    if (code !== OK) {
      actions.push(`market-buy-failed:${room.roomName}:energy:code=${code}`);
      continue;
    }

    order.amount = Math.max(0, order.amount - amount);
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

      if (context.marketSellingResources?.has(resource)) continue;
      const capacityConfig = resolveCapacityConfig();
      const internalSupply = snapshots.filter(donor => donor.roomName !== room.roomName && donor.capacityState !== "emergency")
        .reduce((sum, donor) => sum + getTotalMovableResourceAmount(donor, resource, capacityConfig, context), 0);
      if (internalSupply >= deficit) continue;

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
      let amount = Math.min(deficit - internalSupply, marketCfg.maxDealAmount, terminalFree);
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
        marketCfg.minDealAmount,
      );
      if (!order || !order.roomName) {
        continue;
      }

      amount = Math.min(amount, order.amount);
      if (amount < marketCfg.minDealAmount) continue;
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
        price: order.price,
        },
      );
      if (code !== OK) {
        actions.push(
          `market-buy-failed:${room.roomName}:${resource}:code=${code}`,
        );
        continue;
      }

      order.amount = Math.max(0, order.amount - amount);
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
