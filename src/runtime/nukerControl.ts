import { runIsolatedRoutineRoomOperation } from "@/runtime/runtimeIsolation";
import { isDue } from "@/runtime/cadence";
import { countCarrierCargo } from "@/runtime/carrierCargo";
import { limitActionLog } from "@/runtime/actionLog";
import {
  listCarrierTasksByRoom,
  pruneCarrierTasksForProducer,
  replaceCarrierTasksForProducerRoom,
  type CarrierStructureKind,
  type CarrierTaskDraft,
  type CarrierTaskStep,
} from "@/runtime/carrierTaskBoard";
import { createCarrierTaskStep } from "@/runtime/carrierTaskHelpers";
import { STANDARD_CARRIER_MAX_CAPACITY } from "@/runtime/carrierBodyPolicy";
import { getCreepAssignmentState } from "@/runtime/creepAssignmentState";
import {
  createAutomaticResourceTransferTask,
  createResourceTransferTaskAmountIndex,
} from "@/runtime/logistics/resourceTransferTasks";
import { getTerminalAmountOutsideMarketSaleExposure } from "@/runtime/marketSaleExposure";
import {
  collectResourceControlSnapshots,
  getResourceControlDonorAvailable,
  type ResourceControlSnapshot,
} from "@/runtime/resourceControlReadModel";
import {
  getReservedProductionAmountExcludingHolder,
  listProductionReservations,
  releaseProductionReservation,
  reserveProductionResource,
} from "@/runtime/resourceReservation";
import { resolveRoomEnergyPolicyForRoom } from "@/runtime/roomEnergyPolicy";
import { isRoomInReserveMode } from "@/runtime/roomReserve";
import { getMemoryService, getTickContextService } from "@/runtime/runtimeServices";

export const NUKER_CARRIER_TASK_PRODUCER = "nukerControl";
export const NUKER_GHODIUM_SUPPLY_PRIORITY = 140;
export const NUKER_ENERGY_SUPPLY_PRIORITY = 0;

const NUKER_RESERVATION_PREFIX = "nuker:";
const NUKER_RESERVATION_TTL = 3;
const DEFAULT_GHODIUM_CAPACITY = 5_000;

type SupplySource = StructureStorage | StructureTerminal;

interface SourceCommitments {
  total: number;
  bySourceId: Map<string, number>;
}

interface RoomNukerPlan {
  room: Room;
  nuker: StructureNuker;
  reserveMode: boolean;
  ghodium: number;
  ghodiumCapacity: number;
  ghodiumDeficit: number;
  carriedGhodium: number;
  localGhodiumPlanned: number;
  energy: number;
  energyCapacity: number;
  energyDeficit: number;
  carriedEnergy: number;
  safeEnergy: number;
  drafts: CarrierTaskDraft[];
  lastError?: string;
}

function getReservationHolderId(
  nuker: StructureNuker,
  resource: ResourceConstant,
): string {
  return `${NUKER_RESERVATION_PREFIX}${nuker.id}:${resource}`;
}

export function getOwnedNuker(room: Room): StructureNuker | null {
  return (getTickContextService().getRoomContext(room)
    ?.getMyStructuresByType(STRUCTURE_NUKER)[0] as StructureNuker | undefined) ?? null;
}

export function getNukerGhodiumProductionDemand(): number {
  const currentRuntime = Memory.runtime?.nukerControl;
  if (currentRuntime?.updatedAt === Game.time) {
    return currentRuntime.ghodiumProductionDemand;
  }

  let demand = 0;
  for (const room of getTickContextService().getMyRooms()) {
    const nuker = getOwnedNuker(room);
    if (!nuker) continue;
    demand += nuker.store.getFreeCapacity(RESOURCE_GHODIUM) || 0;
  }
  return demand;
}

function getSourceKind(source: SupplySource): CarrierStructureKind {
  return source.structureType === STRUCTURE_TERMINAL
    ? "terminal"
    : "storage";
}

function getSourceAmount(
  source: SupplySource,
  resource: ResourceConstant,
  roomName: string,
): number {
  if (source.structureType === STRUCTURE_TERMINAL) {
    return getTerminalAmountOutsideMarketSaleExposure(
      source,
      resource,
      roomName,
    );
  }
  return source.store.getUsedCapacity(resource);
}

function getOtherCarrierCommitments(
  roomName: string,
  resource: ResourceConstant,
): SourceCommitments {
  const bySourceId = new Map<string, number>();
  let total = 0;

  for (const task of listCarrierTasksByRoom(roomName)) {
    if (task.producer === NUKER_CARRIER_TASK_PRODUCER) continue;
    for (const step of task.steps) {
      if (
        step.resource !== resource ||
        (step.fromKind !== "storage" && step.fromKind !== "terminal")
      ) {
        continue;
      }
      const amount = Math.max(0, Math.floor(step.amount));
      total += amount;
      bySourceId.set(step.fromId, (bySourceId.get(step.fromId) || 0) + amount);
    }
  }

  return { total, bySourceId };
}

const getCarriedAmountToNuker = countCarrierCargo;

function allocateSupplySteps(params: {
  room: Room;
  nuker: StructureNuker;
  resource: ResourceConstant;
  amount: number;
  sources: SupplySource[];
  sourceLimits: Map<string, number>;
}): CarrierTaskStep[] {
  let remaining = Math.max(0, Math.floor(params.amount));
  const steps: CarrierTaskStep[] = [];

  for (const source of params.sources) {
    if (remaining <= 0) break;
    const sourceLimit = Math.max(
      0,
      Math.floor(params.sourceLimits.get(source.id) || 0),
    );
    const amount = Math.min(remaining, sourceLimit);
    if (amount <= 0) continue;

    steps.push(createCarrierTaskStep({
      producer: NUKER_CARRIER_TASK_PRODUCER,
      roomName: params.room.name,
      resource: params.resource,
      fromKind: getSourceKind(source),
      toKind: "nuker",
      fromId: source.id,
      toId: params.nuker.id,
      amount,
    }));
    remaining -= amount;
  }

  return steps;
}

function buildGhodiumDraft(
  room: Room,
  nuker: StructureNuker,
  ghodiumDeficit: number,
  carriedGhodium: number,
): { draft: CarrierTaskDraft | null; plannedAmount: number } {
  const remainingDeficit = Math.max(0, ghodiumDeficit - carriedGhodium);
  const sources = [room.terminal, room.storage].filter(
    (source): source is SupplySource => !!source,
  );
  const commitments = getOtherCarrierCommitments(
    room.name,
    RESOURCE_GHODIUM,
  );
  const holderId = getReservationHolderId(nuker, RESOURCE_GHODIUM);
  const protectedAmount =
    getReservedProductionAmountExcludingHolder(
      room.name,
      RESOURCE_GHODIUM,
      holderId,
    ) +
    createResourceTransferTaskAmountIndex().getOutgoing(
      room.name,
      RESOURCE_GHODIUM,
    );

  const sourceLimits = new Map<string, number>();
  let availableAfterSourceCommitments = 0;
  for (const source of sources) {
    const amount = Math.max(
      0,
      getSourceAmount(source, RESOURCE_GHODIUM, room.name) -
        (commitments.bySourceId.get(source.id) || 0),
    );
    sourceLimits.set(source.id, amount);
    availableAfterSourceCommitments += amount;
  }

  const plannedAmount = Math.min(
    remainingDeficit,
    Math.max(0, availableAfterSourceCommitments - protectedAmount),
  );
  const steps = allocateSupplySteps({
    room,
    nuker,
    resource: RESOURCE_GHODIUM,
    amount: plannedAmount,
    sources,
    sourceLimits,
  });
  const allocatedAmount = steps.reduce((sum, step) => sum + step.amount, 0);

  return {
    plannedAmount: allocatedAmount,
    draft: allocatedAmount > 0
      ? {
          id: `${NUKER_CARRIER_TASK_PRODUCER}:ghodium:${room.name}`,
          type: "nuker_supply",
          priority: NUKER_GHODIUM_SUPPLY_PRIORITY,
          steps,
        }
      : null,
  };
}

function buildEnergyDraft(
  room: Room,
  nuker: StructureNuker,
  energyDeficit: number,
  carriedEnergy: number,
  reserveMode: boolean,
): { draft: CarrierTaskDraft | null; safeEnergy: number; plannedAmount: number } {
  if (reserveMode) {
    return { draft: null, safeEnergy: 0, plannedAmount: 0 };
  }

  const sources = [room.storage, room.terminal].filter(
    (source): source is SupplySource => !!source,
  );
  const commitments = getOtherCarrierCommitments(room.name, RESOURCE_ENERGY);
  const holderId = getReservationHolderId(nuker, RESOURCE_ENERGY);
  const policy = resolveRoomEnergyPolicyForRoom(room.name);
  const outgoing = createResourceTransferTaskAmountIndex().getOutgoing(
    room.name,
    RESOURCE_ENERGY,
  );
  const otherReservations = getReservedProductionAmountExcludingHolder(
    room.name,
    RESOURCE_ENERGY,
    holderId,
  );

  const storageEnergy = room.storage?.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
  const terminalEnergy = room.terminal
    ? getTerminalAmountOutsideMarketSaleExposure(
        room.terminal,
        RESOURCE_ENERGY,
        room.name,
      )
    : 0;
  // ResourceControl treats the Storage floor and Terminal reserve as separate
  // safety pools. Do not let a full Terminal mask a survival-floor deficit:
  // Nuker filling starts only after Storage itself reaches the room floor, then
  // may consume the excess above both boundaries.
  const energyAboveSafetyBoundaries = storageEnergy >= policy.energyFloor
    ? storageEnergy - policy.energyFloor +
      Math.max(0, terminalEnergy - policy.terminalEnergyReserve)
    : 0;
  const safeEnergy = Math.max(
    0,
    energyAboveSafetyBoundaries -
      otherReservations -
      outgoing -
      commitments.total,
  );

  const sourceLimits = new Map<string, number>();
  if (room.storage) {
    sourceLimits.set(
      room.storage.id,
      Math.max(
        0,
        storageEnergy -
          policy.energyFloor -
          (commitments.bySourceId.get(room.storage.id) || 0),
      ),
    );
  }
  if (room.terminal) {
    sourceLimits.set(
      room.terminal.id,
      Math.max(
        0,
        terminalEnergy -
          policy.terminalEnergyReserve -
          (commitments.bySourceId.get(room.terminal.id) || 0),
      ),
    );
  }

  const plannedAmount = Math.min(
    Math.max(0, energyDeficit - carriedEnergy),
    safeEnergy,
    STANDARD_CARRIER_MAX_CAPACITY,
  );
  const steps = allocateSupplySteps({
    room,
    nuker,
    resource: RESOURCE_ENERGY,
    amount: plannedAmount,
    sources,
    sourceLimits,
  });
  const allocatedAmount = steps.reduce((sum, step) => sum + step.amount, 0);

  return {
    safeEnergy,
    plannedAmount: allocatedAmount,
    draft: allocatedAmount > 0
      ? {
          id: `${NUKER_CARRIER_TASK_PRODUCER}:energy:${room.name}`,
          type: "nuker_supply",
          priority: NUKER_ENERGY_SUPPLY_PRIORITY,
          steps,
        }
      : null,
  };
}

function planRoomNuker(room: Room, nuker: StructureNuker): RoomNukerPlan {
  const ghodium = nuker.store.getUsedCapacity(RESOURCE_GHODIUM);
  const ghodiumCapacity = nuker.store.getCapacity(RESOURCE_GHODIUM) || 0;
  const ghodiumDeficit = nuker.store.getFreeCapacity(RESOURCE_GHODIUM) || 0;
  const carriedGhodium = getCarriedAmountToNuker(
    nuker.id,
    RESOURCE_GHODIUM,
  );
  const ghodiumPlan = buildGhodiumDraft(
    room,
    nuker,
    ghodiumDeficit,
    carriedGhodium,
  );

  const energy = nuker.store.getUsedCapacity(RESOURCE_ENERGY);
  const energyCapacity = nuker.store.getCapacity(RESOURCE_ENERGY) || 0;
  const energyDeficit = nuker.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
  const carriedEnergy = getCarriedAmountToNuker(nuker.id, RESOURCE_ENERGY);
  const reserveMode = isRoomInReserveMode(room.name);
  const energyPlan = buildEnergyDraft(
    room,
    nuker,
    energyDeficit,
    carriedEnergy,
    reserveMode,
  );
  const drafts = [ghodiumPlan.draft, energyPlan.draft].filter(
    (draft): draft is CarrierTaskDraft => !!draft,
  );

  return {
    room,
    nuker,
    reserveMode,
    ghodium,
    ghodiumCapacity,
    ghodiumDeficit,
    carriedGhodium,
    localGhodiumPlanned: ghodiumPlan.plannedAmount,
    energy,
    energyCapacity,
    energyDeficit,
    carriedEnergy,
    safeEnergy: energyPlan.safeEnergy,
    drafts,
  };
}

function publishRoomPlan(plan: RoomNukerPlan, actions: string[]): Set<string> {
  replaceCarrierTasksForProducerRoom(
    NUKER_CARRIER_TASK_PRODUCER,
    plan.room.name,
    plan.drafts,
  );

  const validHolders = new Set<string>();
  const ghodiumDraft = plan.drafts.find((draft) =>
    draft.steps.some((step) => step.resource === RESOURCE_GHODIUM),
  );
  if (ghodiumDraft) {
    const amount = ghodiumDraft.steps.reduce(
      (sum, step) => sum + step.amount,
      0,
    );
    const holderId = getReservationHolderId(
      plan.nuker,
      RESOURCE_GHODIUM,
    );
    validHolders.add(holderId);
    reserveProductionResource(
      plan.room.name,
      RESOURCE_GHODIUM,
      amount,
      holderId,
      NUKER_RESERVATION_TTL,
    );
    actions.push(`local-ghodium:${plan.room.name}:${amount}`);
  }

  const energyDraft = plan.drafts.find((draft) =>
    draft.steps.some((step) => step.resource === RESOURCE_ENERGY),
  );
  if (energyDraft) {
    const amount = energyDraft.steps.reduce(
      (sum, step) => sum + step.amount,
      0,
    );
    const holderId = getReservationHolderId(plan.nuker, RESOURCE_ENERGY);
    validHolders.add(holderId);
    reserveProductionResource(
      plan.room.name,
      RESOURCE_ENERGY,
      amount,
      holderId,
      NUKER_RESERVATION_TTL,
    );
    actions.push(`local-energy:${plan.room.name}:${amount}`);
  }

  return validHolders;
}

function cleanupReservations(validHolderIds: Set<string>): void {
  for (const reservation of listProductionReservations()) {
    if (
      !reservation.holderId.startsWith(NUKER_RESERVATION_PREFIX) ||
      validHolderIds.has(reservation.holderId)
    ) {
      continue;
    }
    releaseProductionReservation(
      reservation.roomName,
      reservation.resource,
      reservation.holderId,
    );
  }
}

function getSnapshotSafeGhodiumStock(snapshot: ResourceControlSnapshot): number {
  const storageAmount =
    snapshot.storage?.store.getUsedCapacity(RESOURCE_GHODIUM) || 0;
  const terminalAmount = getTerminalAmountOutsideMarketSaleExposure(
    snapshot.terminal,
    RESOURCE_GHODIUM,
    snapshot.roomName,
  );
  return storageAmount + terminalAmount;
}

function getDonorAvailableGhodium(
  snapshot: ResourceControlSnapshot,
  planByRoom: Map<string, RoomNukerPlan>,
  plannedOutgoing: Map<string, number>,
  pendingOutgoing: number,
): number {
  const ownPlan = planByRoom.get(snapshot.roomName);
  const ownHolderId = ownPlan
    ? getReservationHolderId(ownPlan.nuker, RESOURCE_GHODIUM)
    : "";
  const otherReservations = ownHolderId
    ? getReservedProductionAmountExcludingHolder(
        snapshot.roomName,
        RESOURCE_GHODIUM,
        ownHolderId,
      )
    : getReservedProductionAmountExcludingHolder(
        snapshot.roomName,
        RESOURCE_GHODIUM,
        "",
      );
  const commitments = getOtherCarrierCommitments(
    snapshot.roomName,
    RESOURCE_GHODIUM,
  ).total;
  const safeStock = getSnapshotSafeGhodiumStock(snapshot);
  const floor = snapshot.mineralFloor[RESOURCE_GHODIUM] || 0;
  const baseAvailable = Math.min(
    getResourceControlDonorAvailable(snapshot, RESOURCE_GHODIUM),
    Math.max(0, safeStock - floor),
  );
  const ownNukerDeficit = ownPlan?.ghodiumDeficit || 0;

  return Math.max(
    0,
    baseAvailable -
      otherReservations -
      pendingOutgoing -
      (plannedOutgoing.get(snapshot.roomName) || 0) -
      commitments -
      ownNukerDeficit,
  );
}

function getTransferCost(
  amount: number,
  fromRoomName: string,
  toRoomName: string,
): number {
  if (typeof Game.market?.calcTransactionCost !== "function") return 0;
  try {
    return Game.market.calcTransactionCost(
      amount,
      fromRoomName,
      toRoomName,
    );
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function planCrossRoomGhodiumTransfers(
  plans: RoomNukerPlan[],
  actions: string[],
): void {
  if (plans.length === 0) return;

  const transferAmounts = createResourceTransferTaskAmountIndex();
  const remainingByRoom = new Map(plans.map((plan) => [
    plan.room.name,
    Math.max(
      0,
      plan.ghodiumDeficit -
        plan.carriedGhodium -
        plan.localGhodiumPlanned -
        transferAmounts.getIncoming(
          plan.room.name,
          RESOURCE_GHODIUM,
        ),
    ),
  ]));
  if (![...remainingByRoom.values()].some((amount) => amount > 0)) return;

  if (!isDue("nuker.plan", 25)) return;
  const snapshots = collectResourceControlSnapshots([RESOURCE_GHODIUM]);
  const planByRoom = new Map(
    plans.map((plan) => [plan.room.name, plan]),
  );
  const plannedOutgoing = new Map<string, number>();

  for (const plan of [...plans].sort((left, right) =>
    left.room.name.localeCompare(right.room.name),
  )) {
    let remaining = remainingByRoom.get(plan.room.name) || 0;

    while (remaining > 0) {
      const candidates = snapshots
        .filter((snapshot) => snapshot.roomName !== plan.room.name)
        .map((snapshot) => {
          const available = getDonorAvailableGhodium(
            snapshot,
            planByRoom,
            plannedOutgoing,
            transferAmounts.getOutgoing(
              snapshot.roomName,
              RESOURCE_GHODIUM,
            ),
          );
          const amount = Math.min(
            remaining,
            available,
            snapshot.transferBatchSize,
          );
          return {
            snapshot,
            available,
            amount,
            transferCost: amount > 0
              ? getTransferCost(
                  amount,
                  snapshot.roomName,
                  plan.room.name,
                )
              : Number.MAX_SAFE_INTEGER,
          };
        })
        .filter((candidate) => candidate.amount > 0)
        .sort((left, right) =>
          left.transferCost - right.transferCost ||
          right.available - left.available ||
          left.snapshot.roomName.localeCompare(right.snapshot.roomName),
        );

      const selected = candidates[0];
      if (!selected) {
        actions.push(`ghodium-waiting:${plan.room.name}:${remaining}`);
        break;
      }

      const result = createAutomaticResourceTransferTask(
        selected.snapshot.roomName,
        plan.room.name,
        RESOURCE_GHODIUM,
        selected.amount,
        `nuker:${plan.room.name}:G`,
      );
      if (typeof result === "string") {
        plan.lastError = result;
        actions.push(`transfer-error:${plan.room.name}:${result}`);
        break;
      }

      plannedOutgoing.set(
        selected.snapshot.roomName,
        (plannedOutgoing.get(selected.snapshot.roomName) || 0) +
          selected.amount,
      );
      remaining -= selected.amount;
      actions.push(
        `transfer-ghodium:${selected.snapshot.roomName}->${plan.room.name}:${selected.amount}`,
      );
    }
  }
}

function shouldRequestHubPlan(
  demandBaseline: number | undefined,
  nextDemand: number,
  ghodiumCapacityThreshold: number,
): boolean {
  if (demandBaseline === undefined) return nextDemand > 0;
  if ((demandBaseline === 0) !== (nextDemand === 0)) return true;
  return Math.abs(demandBaseline - nextDemand) >= ghodiumCapacityThreshold;
}

export function runNukerControl(): void {
  const memory = getMemoryService();
  const runtime = memory.ensureRuntime();
  const previousNukerRuntime = runtime.nukerControl;
  const previousDemand = previousNukerRuntime?.ghodiumProductionDemand;
  let hubPlanDemandBaseline = previousNukerRuntime?.hubPlanDemandBaseline;
  if (
    previousDemand !== undefined &&
    runtime.hub?.lastPlanTick === Game.time - 1
  ) {
    hubPlanDemandBaseline = previousDemand;
  }
  const plans: RoomNukerPlan[] = [];
  const validRoomNames = new Set<string>();
  const validHolderIds = new Set<string>();
  const actions: string[] = [];

  const failedRooms = new Set<string>();
  for (const room of getTickContextService().getMyRooms()) {
    const completed = runIsolatedRoutineRoomOperation("nukerControl", room.name, () => {
      const nuker = getOwnedNuker(room);
      if (!nuker) {
        replaceCarrierTasksForProducerRoom(NUKER_CARRIER_TASK_PRODUCER, room.name, []);
        return true;
      }
      const plan = planRoomNuker(room, nuker);
      for (const holderId of publishRoomPlan(plan, actions)) validHolderIds.add(holderId);
      validRoomNames.add(room.name);
      plans.push(plan);
      return true;
    });
    if (!completed) { failedRooms.add(room.name); validRoomNames.add(room.name); }
  }
  // 单房输入未知时保留其旧任务与预约；不把部分需求发布成新的全局基线。
  if (failedRooms.size) {
    for (const reservation of listProductionReservations()) {
      if (failedRooms.has(reservation.roomName) && reservation.holderId.startsWith(NUKER_RESERVATION_PREFIX)) {
        reserveProductionResource(reservation.roomName, reservation.resource, reservation.amount,
          reservation.holderId, NUKER_RESERVATION_TTL);
      }
    }
    return;
  }

  pruneCarrierTasksForProducer(
    NUKER_CARRIER_TASK_PRODUCER,
    validRoomNames,
  );
  cleanupReservations(validHolderIds);
  planCrossRoomGhodiumTransfers(plans, actions);

  const transferAmountsAfterPlanning = createResourceTransferTaskAmountIndex();
  const ghodiumProductionDemand = plans.reduce(
    (sum, plan) => sum + plan.ghodiumDeficit,
    0,
  );
  const ghodiumCapacityThreshold = Math.max(
    DEFAULT_GHODIUM_CAPACITY,
    ...plans.map((plan) => plan.ghodiumCapacity),
  );
  if (
    shouldRequestHubPlan(
      hubPlanDemandBaseline,
      ghodiumProductionDemand,
      ghodiumCapacityThreshold,
    )
  ) {
    runtime.hub = runtime.hub || {};
    runtime.hub.needsPlan = true;
    hubPlanDemandBaseline = ghodiumProductionDemand;
    actions.push(`hub-replan:${ghodiumProductionDemand}`);
  }

  runtime.nukerControl = {
    updatedAt: Game.time,
    ghodiumProductionDemand,
    hubPlanDemandBaseline,
    lastActions: limitActionLog(actions),
    rooms: Object.fromEntries(plans.map((plan) => [
      plan.room.name,
      {
        nukerId: plan.nuker.id,
        reserveMode: plan.reserveMode,
        ghodium: plan.ghodium,
        ghodiumCapacity: plan.ghodiumCapacity,
        ghodiumDeficit: plan.ghodiumDeficit,
        energy: plan.energy,
        energyCapacity: plan.energyCapacity,
        energyDeficit: plan.energyDeficit,
        safeEnergy: plan.safeEnergy,
        pendingIncomingGhodium:
          transferAmountsAfterPlanning.getPendingIncoming(
            plan.room.name,
            RESOURCE_GHODIUM,
          ),
        carrierTaskCount: plan.drafts.length,
        lastError: plan.lastError,
      },
    ])),
  };
}
