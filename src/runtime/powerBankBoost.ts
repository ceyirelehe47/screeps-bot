import { POWER_BANK_BODY_TIERS, POWER_BANK_BOOST_REQUIREMENTS } from "@/runtime/powerBankConstants";
import {
  pauseSynthesisForBoost,
  resumeSynthesisAfterBoost,
  withdrawSynthesisCarrierTasksForBoost,
} from "@/runtime/synthesisControl";
import {
  cancelResourceTransferTask,
  createAutomaticResourceTransferTask,
  ensureResourceTransferTaskStore,
  getOutgoingResourceTransferAmount,
  isHealthyReceiverCapacityCommitment,
} from "@/runtime/logistics/resourceTransferTasks";
import {
  pruneCarrierTasksForProducer,
  replaceCarrierTasksForProducerRoom,
  type CarrierTaskDraft,
} from "@/runtime/carrierTaskBoard";
import { getTickContextService } from "@/runtime/runtimeServices";
import { TERMINAL_ENERGY_PICKUP_RESERVE } from "@/runtime/energyPickupReservation";
import {
  ensurePowerBankBoostPrepStore,
  getActivePowerBankBoostLabIds,
  getPowerBankBoostPrep,
  type BoostLabAssignment,
  type BoostPrepMemory,
} from "@/runtime/powerBankBoostMemory";

const POWER_BANK_BOOST_PRODUCER = "powerBankBoost";
const BOOST_LAB_SUPPLY_PRIORITY = 140;
const BOOST_LAB_CLEANUP_PRIORITY = BOOST_LAB_SUPPLY_PRIORITY + 1;
const POWER_BANK_BOOST_PARTS: Partial<Record<ResourceConstant, BodyPartConstant>> = {
  [RESOURCE_CATALYZED_GHODIUM_ALKALIDE]: TOUGH,
  [RESOURCE_CATALYZED_UTRIUM_ACID]: ATTACK,
  [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE]: HEAL,
};

export interface BoostPrepResult {
  status: "preparing" | "ready" | "failed";
  reason?: string;
  labs: string[];
}

export interface BoostPrepOptions {
  requireLabEnergy?: boolean;
}

interface BoostTransferRequest {
  fromRoomName: string;
  toRoomName: string;
  resource: ResourceConstant;
  amount: number;
}

function getBoostTransferReason(taskId: string): string {
  return `powerBankBoost:${taskId}`;
}

function getOwnedIncomingBoostAmount(
  taskId: string,
  roomName: string,
  resource: ResourceConstant,
): number {
  const reason = getBoostTransferReason(taskId);
  let total = 0;
  for (const task of Object.values(ensureResourceTransferTaskStore())) {
    if (
      task.status !== "pending" ||
      task.toRoomName !== roomName ||
      task.resource !== resource ||
      task.reason !== reason ||
      !isHealthyReceiverCapacityCommitment(task)
    ) {
      continue;
    }
    total += task.remainingAmount;
  }
  return total;
}

function cancelPendingBoostTransferTasks(taskId: string): void {
  const reason = getBoostTransferReason(taskId);
  for (const task of Object.values(ensureResourceTransferTaskStore())) {
    if (
      task.status !== "pending" ||
      task.origin !== "automatic" ||
      task.reason !== reason
    ) {
      continue;
    }
    cancelResourceTransferTask(task.id);
  }
}

function rollbackBoostPreparation(taskId: string, sourceRoomName: string): void {
  const producer = `${POWER_BANK_BOOST_PRODUCER}:${taskId}`;
  pruneCarrierTasksForProducer(producer, new Set());

  const prepStore = ensurePowerBankBoostPrepStore();
  const prepSourceRoomName = prepStore[taskId]?.sourceRoomName;
  delete prepStore[taskId];

  cancelPendingBoostTransferTasks(taskId);
  const pausedRoomNames = new Set([sourceRoomName]);
  if (prepSourceRoomName) pausedRoomNames.add(prepSourceRoomName);
  for (const roomName of pausedRoomNames) {
    resumeSynthesisAfterBoost(roomName, taskId);
  }
}

function failBoostPreparation(
  taskId: string,
  sourceRoomName: string,
  reason: string,
  labs: StructureLab[] = [],
): BoostPrepResult {
  rollbackBoostPreparation(taskId, sourceRoomName);
  return {
    status: "failed",
    reason,
    labs: labs.map((lab) => lab.id),
  };
}

function getRequiredLabEnergy(mineralAmount: number): number {
  return Math.ceil(mineralAmount / LAB_BOOST_MINERAL) * LAB_BOOST_ENERGY;
}

function getRequiredCompounds(tier: number, requiredAmounts?: ReadonlyMap<ResourceConstant, number>): ResourceConstant[] {
  if (requiredAmounts) {
    return [...requiredAmounts.entries()]
      .filter(([, amount]) => amount > 0)
      .map(([compound]) => compound);
  }

  const req = POWER_BANK_BOOST_REQUIREMENTS[tier];
  if (!req) return [];
  const compounds: ResourceConstant[] = [
    ...req.attacker,
    ...req.healer,
  ];
  return [...new Set(compounds)];
}

function addCompoundAmount(
  amounts: Map<ResourceConstant, number>,
  body: BodyPartConstant[],
  compound: ResourceConstant,
): void {
  const boostedPart = POWER_BANK_BOOST_PARTS[compound];
  if (!boostedPart) return;
  const partCount = body.filter((part) => part === boostedPart).length;
  if (partCount <= 0) return;
  amounts.set(compound, (amounts.get(compound) ?? 0) + partCount * LAB_BOOST_MINERAL);
}

function getRequiredCompoundAmounts(tier: number): Map<ResourceConstant, number> {
  const requirements = POWER_BANK_BOOST_REQUIREMENTS[tier];
  const bodyTier = POWER_BANK_BODY_TIERS[tier];
  const amounts = new Map<ResourceConstant, number>();

  if (!requirements || !bodyTier) {
    return amounts;
  }

  for (const compound of requirements.attacker) {
    addCompoundAmount(amounts, bodyTier.attacker, compound);
  }
  for (const compound of requirements.healer) {
    addCompoundAmount(amounts, bodyTier.healer, compound);
  }

  return amounts;
}

function getLocalStock(room: Room, resource: ResourceConstant): number {
  let total = 0;
  if (room.storage) {
    total += room.storage.store.getUsedCapacity(resource);
  }
  if (room.terminal) {
    total += room.terminal.store.getUsedCapacity(resource);
  }
  return total;
}

function selectAvailableLabs(
  room: Room,
  sourceRoomName: string,
  compounds: ResourceConstant[],
  taskId: string,
): StructureLab[] {
  const labs = room.find(FIND_MY_STRUCTURES, {
    filter: (s): s is StructureLab => s.structureType === STRUCTURE_LAB,
  });
  const existingPrep = getPowerBankBoostPrep(taskId);
  if (existingPrep?.sourceRoomName === sourceRoomName) {
    const labsById = new Map<string, StructureLab>(labs.map((lab) => [lab.id, lab]));
    const assignedLabs = compounds.map((compound) => {
      const assignment = Object.values(existingPrep.labs).find((entry) => entry.compound === compound);
      return assignment ? labsById.get(assignment.labId) : undefined;
    });
    if (assignedLabs.every((lab): lab is StructureLab => !!lab)) {
      return assignedLabs;
    }
  }

  const reservedLabIds = getActivePowerBankBoostLabIds(sourceRoomName, taskId);
  const preferred = labs.filter((lab) => {
    if (reservedLabIds.has(lab.id)) return false;
    const mineralType = lab.mineralType as ResourceConstant | undefined;
    if (!mineralType) return true;
    if ((lab.store.getUsedCapacity(mineralType) ?? 0) <= 0) return true;
    return false;
  });
  const pool = preferred.length >= compounds.length ? preferred : labs.filter((lab) => !reservedLabIds.has(lab.id));
  return pool.slice(0, compounds.length);
}

function resolveBoostCleanupTarget(room: Room, resource: ResourceConstant): StructureTerminal | StructureStorage | null {
  const candidates = [room.terminal, room.storage].filter((structure): structure is StructureTerminal | StructureStorage => !!structure);
  for (const structure of candidates) {
    const free = Math.max(structure.store.getFreeCapacity(resource) ?? 0, structure.store.getFreeCapacity() ?? 0);
    if (free > 0) return structure;
  }
  return null;
}

function getLabFreeCapacityForResource(lab: StructureLab, resource: ResourceConstant): number {
  const mineralType = lab.mineralType as ResourceConstant | undefined;
  if (mineralType && mineralType !== resource) return 0;
  if (!mineralType) return lab.store.getFreeCapacity() ?? lab.store.getFreeCapacity(resource) ?? 0;
  return lab.store.getFreeCapacity(resource) ?? lab.store.getFreeCapacity() ?? 0;
}

export function prepareBoosts(
  taskId: string,
  sourceRoomName: string,
  tier: number,
  requiredAmountsOverride?: ReadonlyMap<ResourceConstant, number>,
  options: BoostPrepOptions = {},
): BoostPrepResult {
  const requiredAmounts = requiredAmountsOverride ?? getRequiredCompoundAmounts(tier);
  const compounds = getRequiredCompounds(tier, requiredAmounts);

  if (compounds.length === 0) {
    rollbackBoostPreparation(taskId, sourceRoomName);
    return { status: "ready", labs: [] };
  }

  const room = Game.rooms[sourceRoomName];
  if (!room) {
    return failBoostPreparation(taskId, sourceRoomName, "room_not_visible");
  }

  if (!pauseSynthesisForBoost(sourceRoomName, taskId)) {
    return failBoostPreparation(taskId, sourceRoomName, "synthesis_pause_failed");
  }

  const labs = selectAvailableLabs(room, sourceRoomName, compounds, taskId);
  if (labs.length < compounds.length) {
    return failBoostPreparation(taskId, sourceRoomName, "insufficient_labs", labs);
  }

  const prepStore = ensurePowerBankBoostPrepStore();
  const assignments: Record<string, BoostLabAssignment> = {};
  const drafts: CarrierTaskDraft[] = [];
  const transferRequests: BoostTransferRequest[] = [];

  for (let i = 0; i < compounds.length; i++) {
    const compound = compounds[i];
    const lab = labs[i];
    assignments[lab.id] = { labId: lab.id, compound };

    const needed = requiredAmounts.get(compound) ?? LAB_BOOST_MINERAL;
    const loadedMineral = lab.mineralType as ResourceConstant | undefined;
    if (loadedMineral && loadedMineral !== compound) {
      const loadedAmount = (lab.store.getUsedCapacity(loadedMineral) ?? 0);
      const target = resolveBoostCleanupTarget(room, loadedMineral);
      const targetFree = Math.max(target?.store.getFreeCapacity(loadedMineral) ?? 0, target?.store.getFreeCapacity() ?? 0);
      const cleanupAmount = Math.min(loadedAmount, targetFree);
      if (target && cleanupAmount > 0) {
        drafts.push({
          id: `powerBankBoost:lab_cleanup:${taskId}:${lab.id}:${loadedMineral}`,
          type: "lab_cleanup",
          priority: BOOST_LAB_CLEANUP_PRIORITY,
          steps: [
            {
              id: `${loadedMineral}:${lab.id}->${target.id}`,
              resource: loadedMineral,
              fromKind: "lab",
              toKind: target.structureType === STRUCTURE_TERMINAL ? "terminal" : "storage",
              fromId: lab.id,
              toId: target.id,
              amount: cleanupAmount,
            },
          ],
        });
      }
      continue;
    }

    const labHas = (lab.store.getUsedCapacity(compound) ?? 0);
    const localStock = getLocalStock(room, compound);

    const deficit = Math.max(0, needed - labHas);
    let localSupplyAmount = 0;

    if (deficit > 0 && localStock > 0) {
      const source = resolveBoostSupplySource(room, compound);
      if (source) {
        const amount = Math.min(deficit, localStock, source.store.getUsedCapacity(compound));
        const usableFree = getLabFreeCapacityForResource(lab, compound);
        const transferAmt = Math.min(amount, usableFree);
        if (transferAmt > 0) {
          localSupplyAmount = transferAmt;
          drafts.push({
            id: `powerBankBoost:lab_supply:${taskId}:${compound}`,
            type: "lab_supply",
            priority: BOOST_LAB_SUPPLY_PRIORITY,
            steps: [
              {
                id: `${compound}:${source.id}->${lab.id}`,
                resource: compound,
                fromKind: source.structureType === STRUCTURE_TERMINAL ? "terminal" : "storage",
                toKind: "lab",
                fromId: source.id,
                toId: lab.id,
                amount: transferAmt,
              },
            ],
          });
        }
      }
    }

    if (options.requireLabEnergy) {
      const requiredEnergy = getRequiredLabEnergy(needed);
      const energyDeficit = Math.max(0, requiredEnergy - lab.store.getUsedCapacity(RESOURCE_ENERGY));
      if (energyDeficit > 0) {
        const energySource = resolveBoostSupplySource(room, RESOURCE_ENERGY);
        const transferAmount = Math.min(
          energyDeficit,
          energySource ? getBoostSupplyAmount(energySource, RESOURCE_ENERGY) : 0,
          lab.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0,
        );
        if (!energySource || transferAmount < energyDeficit) {
          return failBoostPreparation(taskId, sourceRoomName, "insufficient_lab_energy", labs);
        }
        drafts.push({
          id: `powerBankBoost:lab_energy:${taskId}:${lab.id}`,
          type: "lab_supply",
          priority: BOOST_LAB_SUPPLY_PRIORITY,
          steps: [
            {
              id: `${RESOURCE_ENERGY}:${energySource.id}->${lab.id}`,
              resource: RESOURCE_ENERGY,
              fromKind: energySource.structureType === STRUCTURE_TERMINAL ? "terminal" : "storage",
              toKind: "lab",
              fromId: energySource.id,
              toId: lab.id,
              amount: transferAmount,
            },
          ],
        });
      }
    }

    const remainingDeficit = Math.max(0, deficit - localSupplyAmount);
    const incoming = getOwnedIncomingBoostAmount(taskId, sourceRoomName, compound);
    const donorDeficit = Math.max(0, remainingDeficit - incoming);

    if (donorDeficit > 0) {
      const donorRoom = findBestDonorRoom(compound, donorDeficit, [sourceRoomName]);
      if (donorRoom) {
        transferRequests.push({
          fromRoomName: donorRoom,
          toRoomName: sourceRoomName,
          resource: compound,
          amount: donorDeficit,
        });
      } else {
        return failBoostPreparation(taskId, sourceRoomName, "insufficient_boost_compound", labs);
      }
    }
  }

  prepStore[taskId] = {
    labs: assignments,
    taskId,
    sourceRoomName,
  };

  withdrawSynthesisCarrierTasksForBoost(sourceRoomName);

  replaceCarrierTasksForProducerRoom(
    `${POWER_BANK_BOOST_PRODUCER}:${taskId}`,
    sourceRoomName,
    drafts,
  );

  for (const request of transferRequests) {
    const result = createAutomaticResourceTransferTask(
      request.fromRoomName,
      request.toRoomName,
      request.resource,
      request.amount,
      getBoostTransferReason(taskId),
    );
    if (typeof result === "string") {
      return failBoostPreparation(taskId, sourceRoomName, "boost_transfer_create_failed", labs);
    }
  }

  if (checkBoostReadiness(taskId, compounds, requiredAmounts, options)) {
    return { status: "ready", labs: labs.map((l) => l.id) };
  }

  return { status: "preparing", labs: labs.map((l) => l.id) };
}

/**
 * Checks if all required compounds are loaded in reserved boost labs for a specific task.
 */
export function checkBoostReadiness(
  taskId: string,
  requiredCompounds: ResourceConstant[],
  requiredAmounts?: ReadonlyMap<ResourceConstant, number>,
  options: BoostPrepOptions = {},
): boolean {
  if (requiredCompounds.length === 0) return true;

  const prepStore = ensurePowerBankBoostPrepStore();
  const activePrep = prepStore[taskId];
  if (!activePrep) return false;

  for (const compound of requiredCompounds) {
    const assignment = Object.values(activePrep.labs).find(
      (a) => a.compound === compound,
    );
    if (!assignment) return false;

    const lab = Game.getObjectById(assignment.labId as Id<StructureLab>);
    if (!lab) return false;

    const labAmount = (lab.store.getUsedCapacity(compound) ?? 0);
    const requiredAmount = requiredAmounts?.get(compound) ?? LAB_BOOST_MINERAL;
    if (labAmount < requiredAmount) return false;
    if (options.requireLabEnergy) {
      const requiredEnergy = getRequiredLabEnergy(requiredAmount);
      if (lab.store.getUsedCapacity(RESOURCE_ENERGY) < requiredEnergy) return false;
    }
  }

  return true;
}

/**
 * Releases boost labs and resumes synthesis production.
 */
export function releaseBoostLabs(taskId: string, sourceRoomName: string): void {
  rollbackBoostPreparation(taskId, sourceRoomName);
}

/**
 * Finds the best donor room for a resource transfer. Prefers hub rooms.
 * Returns null if no room has sufficient surplus.
 */
export function findBestDonorRoom(
  resource: ResourceConstant,
  amount: number,
  excludeRooms: string[],
): string | null {
  const hubRoomName = Memory.cfg?.hub?.hubRoomName;
  const candidates: Array<{ roomName: string; surplus: number; isHub: boolean }> = [];

  for (const room of getTickContextService().getMyRooms()) {
    if (excludeRooms.includes(room.name)) continue;
    if (!room.terminal) continue;
    if (room.terminal.cooldown > 0) continue;

    const surplus = Math.max(
      0,
      room.terminal.store.getUsedCapacity(resource) -
        getOutgoingResourceTransferAmount(room.name, resource),
    );

    if (surplus < amount) continue;

    candidates.push({
      roomName: room.name,
      surplus,
      isHub: room.name === hubRoomName,
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.isHub !== b.isHub) return a.isHub ? -1 : 1;
    return b.surplus - a.surplus;
  });

  return candidates[0].roomName;
}

function resolveBoostSupplySource(
  room: Room,
  resource: ResourceConstant,
): StructureStorage | StructureTerminal | null {
  const terminalAmount = room.terminal ? getBoostSupplyAmount(room.terminal, resource) : 0;
  const storageAmount = room.storage ? getBoostSupplyAmount(room.storage, resource) : 0;

  if (storageAmount >= terminalAmount && room.storage && storageAmount > 0) {
    return room.storage;
  }
  if (room.terminal && terminalAmount > 0) {
    return room.terminal;
  }
  if (room.storage && storageAmount > 0) {
    return room.storage;
  }
  return null;
}

function getBoostSupplyAmount(
  structure: StructureStorage | StructureTerminal,
  resource: ResourceConstant,
): number {
  const amount = structure.store.getUsedCapacity(resource);
  if (resource === RESOURCE_ENERGY && structure.structureType === STRUCTURE_TERMINAL) {
    return Math.max(0, amount - TERMINAL_ENERGY_PICKUP_RESERVE);
  }
  return amount;
}
