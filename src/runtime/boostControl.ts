import { collectResourceControlSnapshots, getResourceControlDonorAvailable } from "@/runtime/resourceControlReadModel";
import { isDue } from "@/runtime/cadence";
import { resolveMarketCreditReserve, getAvailableMarketCredits } from "@/runtime/marketActionArbiter";
import { createResourceTransferTaskAmountIndex, ensureResourceTransferTaskStore, cancelResourceTransferTask, createAutomaticResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { isDefenseMode } from "@/runtime/defenseMode";
import { replaceCarrierTasksForProducerRoom, type CarrierTaskDraft } from "@/runtime/carrierTaskBoard";
import { recordFixedCpuAction } from "@/runtime/cpuPhaseProfiler";
import {
  declareMarketActionIntent,
  executeMarketDeal,
} from "@/runtime/marketActionArbiter";
import { getTickContextService } from "@/runtime/runtimeServices";
import { getTerminalAmountOutsideMarketSaleExposure } from "@/runtime/marketSaleExposure";
import { resolveRoomEnergyPolicyForRoom } from "@/runtime/roomEnergyPolicy";
import { calcEffectiveDamage } from "@/runtime/towerControl";

export const DEFENSE_BOOST_COMPOUND = RESOURCE_CATALYZED_UTRIUM_ACID;

const BOOST_CONTROL_PRODUCER = "boostControl";
const BOOST_LAB_SUPPLY_PRIORITY = 150;
const BOOST_TERMINAL_OFFLOAD_PRIORITY = 160;
const DEFAULT_BOOST_TARGET = 1000;
const DEFAULT_MAX_BUY_PRICE = 10;
const DEFAULT_MAX_DEAL_ENERGY_COST_RATIO = 0.3;

function getBoostTarget(): number {
  const v = Memory.cfg?.homeDefense?.boostTarget;
  return typeof v === "number" && v > 0 ? v : DEFAULT_BOOST_TARGET;
}

function getMaxBuyPrice(): number {
  const v = Memory.cfg?.homeDefense?.maxBoostBuyPrice;
  return typeof v === "number" && v > 0 ? v : DEFAULT_MAX_BUY_PRICE;
}

function getMaxEnergyCostRatio(): number {
  const v = Memory.cfg?.homeDefense?.maxBoostDealEnergyCostRatio;
  return typeof v === "number" && v >= 0 ? v : DEFAULT_MAX_DEAL_ENERGY_COST_RATIO;
}

function getBoostLabId(roomName: string): string | undefined {
  return Memory.cfg?.homeDefense?.rooms?.[roomName]?.boostLabId;
}

function getBoostStock(room: Room): number {
  const storageAmt = room.storage?.store.getUsedCapacity(DEFENSE_BOOST_COMPOUND) ?? 0;
  const terminalAmt = room.terminal?.store.getUsedCapacity(DEFENSE_BOOST_COMPOUND) ?? 0;
  const lab = getBoostLabId(room.name) ? Game.getObjectById(getBoostLabId(room.name) as Id<StructureLab>) : null;
  const index = createResourceTransferTaskAmountIndex();
  return Math.max(0, storageAmt + terminalAmt + (lab?.store.getUsedCapacity(DEFENSE_BOOST_COMPOUND) ?? 0) +
    index.getIncoming(room.name, DEFENSE_BOOST_COMPOUND) - index.getOutgoing(room.name, DEFENSE_BOOST_COMPOUND));
}

function calcTowerAttackAtRange(range: number): number {
  if (range <= TOWER_OPTIMAL_RANGE) return TOWER_POWER_ATTACK;
  if (range >= TOWER_FALLOFF_RANGE) return Math.floor(TOWER_POWER_ATTACK * (1 - TOWER_FALLOFF));
  const beyondOptimal = range - TOWER_OPTIMAL_RANGE;
  const falloffRange = TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE;
  return Math.floor(TOWER_POWER_ATTACK * (1 - TOWER_FALLOFF * (beyondOptimal / falloffRange)));
}

function calcHealPower(part: BodyPartDefinition, ranged: boolean): number {
  if (part.type !== HEAL || part.hits <= 0) return 0;
  const base = ranged ? RANGED_HEAL_POWER : HEAL_POWER;
  if (!part.boost) return base;
  const boostEntry = (BOOSTS[HEAL] as Record<string, { heal?: number; rangedHeal?: number } | undefined>)?.[part.boost];
  const multiplier = ranged ? boostEntry?.rangedHeal : boostEntry?.heal;
  return typeof multiplier === "number" && Number.isFinite(multiplier) ? Math.floor(base * multiplier) : base;
}

function calcIncomingHeal(hostiles: Creep[], target: Creep): number {
  let total = 0;
  for (const healer of hostiles) {
    const range = healer.pos.getRangeTo(target.pos);
    if (range > 3) continue;
    const ranged = range > 1;
    for (const part of healer.body) {
      total += calcHealPower(part, ranged);
    }
  }
  return total;
}

export function shouldBoostDefender(room: Room, hostiles: Creep[]): boolean {
  if (hostiles.length === 0) return false;

  const tickContext = getTickContextService();
  const towers = (tickContext.getRoomContext(room)?.getTowers() ?? []).filter(
    (t) => t.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
  );

  // Mirror homeDefenderBody: ATTACK+MOVE pairs, capped at 25
  const unitCost = BODYPART_COST[ATTACK] + BODYPART_COST[MOVE];
  const attackParts = Math.min(25, Math.floor(room.energyCapacityAvailable / unitCost));
  const rawAttack = attackParts * ATTACK_POWER;

  for (const hostile of hostiles) {
    const towerDamage = towers.reduce((sum, t) => sum + calcTowerAttackAtRange(t.pos.getRangeTo(hostile.pos)), 0);
    const heal = calcIncomingHeal(hostiles, hostile);
    if (calcEffectiveDamage(hostile, towerDamage + rawAttack) > heal) return false;
  }

  return true;
}

function findBestSellOrder(roomName: string, amount: number): Order | null {
  const maxPrice = getMaxBuyPrice();
  const maxRatio = getMaxEnergyCostRatio();
  const orders = Game.market.getAllOrders({ type: ORDER_SELL, resourceType: DEFENSE_BOOST_COMPOUND });
  let best: Order | null = null;

  for (const order of orders) {
    if (order.amount < amount || !order.roomName) continue;
    if (order.price > maxPrice) continue;
    const cost = Game.market.calcTransactionCost(amount, roomName, order.roomName);
    if (amount > 0 && cost / amount > maxRatio) continue;
    if (!best || order.price < best.price) best = order;
  }

  return best;
}

export function buyBoostIfNeeded(room: Room): void {
  if (!room.terminal) return;
  if (room.terminal.cooldown !== 0) return;
  if (!isDue("boost.plan", 5)) return;

  if (isDefenseMode(room.name)) for (const task of Object.values(ensureResourceTransferTaskStore())) {
    if (task.origin === "automatic" && task.status === "pending" && task.fromRoomName === room.name &&
        task.resource === DEFENSE_BOOST_COMPOUND && task.reason?.startsWith("hub:export:")) cancelResourceTransferTask(task.id);
  }
  const stock = getBoostStock(room);
  const target = getBoostTarget();
  if (stock >= target) return;

  const amount = Math.min(target - stock, room.terminal.store.getFreeCapacity(DEFENSE_BOOST_COMPOUND));
  if (amount <= 0) return;

  const transfers = createResourceTransferTaskAmountIndex();
  const donorSnapshot = collectResourceControlSnapshots().find(candidate => candidate.roomName !== room.name &&
    !isDefenseMode(candidate.roomName) && getResourceControlDonorAvailable(candidate, DEFENSE_BOOST_COMPOUND) -
      transfers.getOutgoing(candidate.roomName, DEFENSE_BOOST_COMPOUND) >= amount);
  const donor = donorSnapshot ? Game.rooms[donorSnapshot.roomName] : undefined;
  if (donor) {
    const created = createAutomaticResourceTransferTask(donor.name, room.name, DEFENSE_BOOST_COMPOUND, amount, `boost:defense:${room.name}`);
    if (typeof created !== "string" && created.ok) return;
  }
  if (getMaxBuyPrice() <= 0) return;

  const order = findBestSellOrder(room.name, amount);
  if (!order?.roomName) return;

  const transferCost = Game.market.calcTransactionCost(amount, room.name, order.roomName);
  const reserve = resolveRoomEnergyPolicyForRoom(room.name).terminalEnergyReserve;
  if (transferCost > room.terminal.store.getUsedCapacity(RESOURCE_ENERGY) - reserve) return;
  const creditReserve = resolveMarketCreditReserve();
  if (!Number.isFinite(Game.market.credits) || amount * order.price > getAvailableMarketCredits(creditReserve)) return;

  declareMarketActionIntent(
    BOOST_CONTROL_PRODUCER,
    "market_deal",
    room.name,
  );
  const code = executeMarketDeal(
    order.id,
    amount,
    room.name,
    BOOST_CONTROL_PRODUCER,
    {
      orderType: ORDER_SELL,
      resourceType: DEFENSE_BOOST_COMPOUND,
      orderRoomName: order.roomName,
        price: order.price,
    },
  );
  if (code === OK) {
    recordFixedCpuAction("boostControl");
    console.log(
      `[boostControl] buy ${room.name}: ${DEFENSE_BOOST_COMPOUND}=${amount} price=${order.price.toFixed(3)} cost=${transferCost}`,
    );
  }
}

export function syncBoostLabTask(room: Room): void {
  const labId = getBoostLabId(room.name);
  if (!labId) {
    replaceCarrierTasksForProducerRoom(BOOST_CONTROL_PRODUCER, room.name, []);
    return;
  }

  const lab = Game.getObjectById(labId as Id<StructureLab>);
  if (!lab || lab.room.name !== room.name) {
    replaceCarrierTasksForProducerRoom(BOOST_CONTROL_PRODUCER, room.name, []);
    return;
  }

  const storage = room.storage;
  const terminal = room.terminal;
  const drafts: CarrierTaskDraft[] = [];

  if (lab.mineralType && lab.mineralType !== DEFENSE_BOOST_COMPOUND) {
    const resource = lab.mineralType;
    const target = storage && storage.store.getFreeCapacity(resource) > 0 ? storage : terminal;
    if (target) drafts.push({ id: `boostControl:lab_cleanup:${room.name}:${lab.id}`, type: "lab_cleanup", priority: BOOST_TERMINAL_OFFLOAD_PRIORITY + 1,
      steps: [{ id: `${resource}:${lab.id}->${target.id}`, resource, fromKind: "lab", toKind: target.structureType === STRUCTURE_STORAGE ? "storage" : "terminal",
        fromId: lab.id, toId: target.id, amount: Math.min(lab.store.getUsedCapacity(resource), target.store.getFreeCapacity(resource)) }] });
    replaceCarrierTasksForProducerRoom(BOOST_CONTROL_PRODUCER, room.name, drafts);
    return;
  }

  // Step 1: offload terminal → storage so storage becomes the supply source
  if (terminal && storage) {
    const outgoing = createResourceTransferTaskAmountIndex().getOutgoing(room.name, DEFENSE_BOOST_COMPOUND);
    const terminalHas = Math.max(0, getTerminalAmountOutsideMarketSaleExposure(terminal, DEFENSE_BOOST_COMPOUND, room.name) - outgoing);
    const storageFree = storage.store.getFreeCapacity(DEFENSE_BOOST_COMPOUND);
    const offloadAmt = Math.min(terminalHas, storageFree);
    if (offloadAmt > 0) {
      drafts.push({
        id: `boostControl:terminal_offload:${room.name}:${DEFENSE_BOOST_COMPOUND}`,
        type: "terminal_offload",
        priority: BOOST_TERMINAL_OFFLOAD_PRIORITY,
        steps: [
          {
            id: `${DEFENSE_BOOST_COMPOUND}:${terminal.id}->${storage.id}`,
            resource: DEFENSE_BOOST_COMPOUND,
            fromKind: "terminal",
            toKind: "storage",
            fromId: terminal.id,
            toId: storage.id,
            amount: offloadAmt,
          },
        ],
      });
    }
  }

  // Step 2: supply lab from storage
  if (storage) {
    const unitCost = BODYPART_COST[ATTACK] + BODYPART_COST[MOVE];
    const attackParts = Math.min(25, Math.floor(room.energyCapacityAvailable / unitCost));
    const needed = attackParts * LAB_BOOST_MINERAL;
    const labHas = lab.store.getUsedCapacity(DEFENSE_BOOST_COMPOUND);
    const missing = Math.max(0, needed - labHas);

    if (missing > 0) {
      const storageHas = storage.store.getUsedCapacity(DEFENSE_BOOST_COMPOUND);
      const labFree = lab.store.getFreeCapacity(DEFENSE_BOOST_COMPOUND);
      const amount = Math.min(missing, storageHas, labFree);

      if (amount > 0) {
        drafts.push({
          id: `boostControl:lab_supply:${room.name}:${DEFENSE_BOOST_COMPOUND}`,
          type: "lab_supply",
          priority: BOOST_LAB_SUPPLY_PRIORITY,
          steps: [
            {
              id: `${DEFENSE_BOOST_COMPOUND}:${storage.id}->${lab.id}`,
              resource: DEFENSE_BOOST_COMPOUND,
              fromKind: "storage",
              toKind: "lab",
              fromId: storage.id,
              toId: lab.id,
              amount,
            },
          ],
        });
      }
    }
  }

  const attackParts = Math.min(25, Math.floor(room.energyCapacityAvailable / (BODYPART_COST[ATTACK] + BODYPART_COST[MOVE])));
  const energyMissing = Math.max(0, attackParts * LAB_BOOST_ENERGY - lab.store.getUsedCapacity(RESOURCE_ENERGY));
  const sourceEnergy = (source: StructureStorage | StructureTerminal): number => source === terminal
    ? getTerminalAmountOutsideMarketSaleExposure(source as StructureTerminal, RESOURCE_ENERGY, room.name)
    : source.store.getUsedCapacity(RESOURCE_ENERGY);
  const energySource = [storage, terminal].find(source => source && sourceEnergy(source) > 0);
  if (energySource && energyMissing > 0) {
    drafts.push({ id: `boostControl:lab_supply:${room.name}:energy`, type: "lab_supply", priority: BOOST_LAB_SUPPLY_PRIORITY,
      steps: [{ id: `energy:${energySource.id}->${lab.id}`, resource: RESOURCE_ENERGY,
        fromKind: energySource === storage ? "storage" : "terminal", toKind: "lab", fromId: energySource.id, toId: lab.id,
        amount: Math.min(energyMissing, sourceEnergy(energySource), lab.store.getFreeCapacity(RESOURCE_ENERGY)) }] });
  }
  replaceCarrierTasksForProducerRoom(BOOST_CONTROL_PRODUCER, room.name, drafts);
}

export function clearBoostLabTasks(roomName: string): void {
  replaceCarrierTasksForProducerRoom(BOOST_CONTROL_PRODUCER, roomName, []);
}
