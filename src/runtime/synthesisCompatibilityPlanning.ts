import { isDue } from "@/runtime/cadence";
import {
  countPendingOutgoingResourceTransferTasksByRoom,
  createAutomaticResourceTransferTask,
  getIncomingResourceTransferAmount,
  getOutgoingResourceTransferAmount,
} from "@/runtime/logistics/resourceTransferTasks";
import {
  collectResourceControlSnapshots,
  getResourceControlDonorAvailable,
  getResourceControlRoomStock,
  getResourceControlSampleInterval,
  type ResourceControlSnapshot,
} from "@/runtime/resourceControlReadModel";
import { getMemoryService } from "@/runtime/runtimeServices";
import { normalizeBoolean, normalizeNumber, normalizeRoomNameList } from "@/runtime/configNormalize";

type ResourceThresholdMap = Partial<Record<ResourceConstant, number>>;

interface ResourceControlSynthesisRoomConfig {
  demands: ResourceThresholdMap;
  donorRoomNames?: string[];
}

interface ResourceControlSynthesisConfig {
  enabled: boolean;
  maxGeneratedPerRun: number;
  rooms: Record<string, ResourceControlSynthesisRoomConfig>;
}

interface SynthesisProducerBinding {
  fromRoomName: string;
  updatedAt: number;
  expiresAt: number;
}

type SynthesisBindingStore = Record<string, SynthesisProducerBinding>;

const BASE_MINERALS: ResourceConstant[] = [
  RESOURCE_HYDROGEN,
  RESOURCE_OXYGEN,
  RESOURCE_UTRIUM,
  RESOURCE_LEMERGIUM,
  RESOURCE_KEANIUM,
  RESOURCE_ZYNTHIUM,
  RESOURCE_CATALYST,
];
const DEFAULT_SYNTHESIS_MAX_GENERATED_PER_RUN = 2;
const MIN_SYNTHESIS_MAX_GENERATED_PER_RUN = 0;
const MAX_SYNTHESIS_MAX_GENERATED_PER_RUN = 10;
const DEFAULT_SYNTHESIS_CONFIG: ResourceControlSynthesisConfig = {
  enabled: false,
  maxGeneratedPerRun: DEFAULT_SYNTHESIS_MAX_GENERATED_PER_RUN,
  rooms: {},
};
const SYNTHESIS_BINDING_LEASE_TICKS = 200;
const SYNTHESIS_BINDING_STICKY_BONUS = 5;
const SYNTHESIS_BINDING_SWITCH_ADVANTAGE_RATIO = 1.2;

function normalizeResourceThresholdMap(
  value: unknown,
  fallback: ResourceThresholdMap,
  min: number,
  max: number,
): ResourceThresholdMap {
  const map = value && typeof value === "object" ? (value as Partial<Record<ResourceConstant, unknown>>) : {};
  const next: ResourceThresholdMap = {};

  for (const resource of Object.keys(fallback) as ResourceConstant[]) {
    next[resource] = normalizeNumber(map[resource], fallback[resource] || 0, min, max);
  }

  for (const resource of BASE_MINERALS) {
    if (next[resource] === undefined) {
      next[resource] = normalizeNumber(map[resource], fallback[resource] || 0, min, max);
    }
  }

  return next;
}

function normalizeSynthesisConfig(value: unknown): ResourceControlSynthesisConfig {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const roomsRaw = raw.rooms && typeof raw.rooms === "object" ? (raw.rooms as Record<string, unknown>) : {};
  const rooms: Record<string, ResourceControlSynthesisRoomConfig> = {};

  for (const [roomName, roomCfg] of Object.entries(roomsRaw)) {
    if (!roomCfg || typeof roomCfg !== "object") {
      continue;
    }

    const roomRecord = roomCfg as Record<string, unknown>;
    const demands = normalizeResourceThresholdMap(roomRecord.demands, {}, 0, 1_000_000);
    if (Object.keys(demands).length === 0) {
      continue;
    }

    rooms[roomName] = {
      demands,
      donorRoomNames: normalizeRoomNameList(roomRecord.donorRoomNames),
    };
  }

  return {
    enabled: normalizeBoolean(raw.enabled, DEFAULT_SYNTHESIS_CONFIG.enabled),
    maxGeneratedPerRun: normalizeNumber(
      raw.maxGeneratedPerRun,
      DEFAULT_SYNTHESIS_CONFIG.maxGeneratedPerRun,
      MIN_SYNTHESIS_MAX_GENERATED_PER_RUN,
      MAX_SYNTHESIS_MAX_GENERATED_PER_RUN,
    ),
    rooms,
  };
}

function resolveSynthesisConfig(): ResourceControlSynthesisConfig {
  return normalizeSynthesisConfig(Memory.cfg?.resourceControl?.synthesis);
}

function getBindingKey(targetRoomName: string, resource: ResourceConstant): string {
  return `${targetRoomName}:${resource}`;
}

function getSynthesisBindings(): SynthesisBindingStore {
  return Memory.runtime?.resourceControl?.synthesisBindings || {};
}

function getActiveSynthesisBinding(
  bindings: SynthesisBindingStore,
  targetRoomName: string,
  resource: ResourceConstant,
): SynthesisProducerBinding | null {
  const key = getBindingKey(targetRoomName, resource);
  const binding = bindings[key];
  if (!binding) {
    return null;
  }

  if (binding.expiresAt < Game.time) {
    delete bindings[key];
    return null;
  }

  return binding;
}

function setSynthesisBinding(
  bindings: SynthesisBindingStore,
  targetRoomName: string,
  resource: ResourceConstant,
  fromRoomName: string,
): void {
  const key = getBindingKey(targetRoomName, resource);
  bindings[key] = {
    fromRoomName,
    updatedAt: Game.time,
    expiresAt: Game.time + SYNTHESIS_BINDING_LEASE_TICKS,
  };
}

function scoreDonorCandidate(
  donor: ResourceControlSnapshot,
  targetRoomName: string,
  resource: ResourceConstant,
  amount: number,
  currentBinding: SynthesisProducerBinding | null,
): number {
  const available = getResourceControlDonorAvailable(donor, resource);
  const stockScore = Math.min(30, available / Math.max(1, amount));
  const transferCost = Game.market.calcTransactionCost(amount, donor.roomName, targetRoomName);
  const transferCostRatio = amount > 0 ? transferCost / amount : Infinity;
  const costPenalty = transferCostRatio * 8;
  const pendingPenalty = countPendingOutgoingResourceTransferTasksByRoom(donor.roomName) * 1.2;
  const stickyBonus = currentBinding?.fromRoomName === donor.roomName ? SYNTHESIS_BINDING_STICKY_BONUS : 0;

  return stockScore - costPenalty - pendingPenalty + stickyBonus;
}

function generateSynthesisTransferTasks(snapshots: ResourceControlSnapshot[]): { actions: string[]; bindings: SynthesisBindingStore } {
  if (Memory.cfg?.synthesisControl?.enabled === true) {
    return {
      actions: [],
      bindings: getSynthesisBindings(),
    };
  }

  const synthesisCfg = resolveSynthesisConfig();
  if (!synthesisCfg.enabled || synthesisCfg.maxGeneratedPerRun <= 0) {
    return { actions: [], bindings: getSynthesisBindings() };
  }

  const actions: string[] = [];
  const bindings = getSynthesisBindings();
  let created = 0;

  for (const [targetRoomName, targetCfg] of Object.entries(synthesisCfg.rooms)) {
    if (created >= synthesisCfg.maxGeneratedPerRun) {
      break;
    }

    const targetRoom = Game.rooms[targetRoomName];
    if (!targetRoom?.controller?.my || !targetRoom.terminal) {
      continue;
    }

    for (const [resourceName, demandTarget] of Object.entries(targetCfg.demands)) {
      if (created >= synthesisCfg.maxGeneratedPerRun) {
        break;
      }

      const resource = resourceName as ResourceConstant;
      const targetAmount = Math.max(0, Math.floor(demandTarget || 0));
      if (targetAmount <= 0) {
        continue;
      }

      const current = getResourceControlRoomStock(targetRoom, resource);
      const incoming = getIncomingResourceTransferAmount(targetRoomName, resource);
      const deficit = Math.max(0, targetAmount - current - incoming);
      if (deficit <= 0) {
        continue;
      }

      const donorCandidates = snapshots
        .filter((snapshot) => snapshot.roomName !== targetRoomName)
        .filter((snapshot) => snapshot.terminal.cooldown === 0)
        .filter((snapshot) =>
          targetCfg.donorRoomNames && targetCfg.donorRoomNames.length > 0
            ? targetCfg.donorRoomNames.includes(snapshot.roomName)
            : true,
        )
        .map((snapshot) => {
          const outgoing = getOutgoingResourceTransferAmount(snapshot.roomName, resource);
          const available = Math.max(0, getResourceControlDonorAvailable(snapshot, resource) - outgoing);
          return {
            snapshot,
            available,
          };
        })
        .filter((entry) => entry.available > 0)
        .sort((left, right) => right.available - left.available);

      if (donorCandidates.length === 0) {
        continue;
      }

      const binding = getActiveSynthesisBinding(bindings, targetRoomName, resource);
      const scored = donorCandidates
        .map((entry) => {
          const amountForScore = Math.min(deficit, entry.available, entry.snapshot.transferBatchSize);
          return {
            entry,
            amountForScore,
            score: scoreDonorCandidate(entry.snapshot, targetRoomName, resource, amountForScore, binding),
          };
        })
        .filter((item) => item.amountForScore > 0)
        .sort((left, right) => right.score - left.score);
      if (scored.length === 0) {
        continue;
      }

      const best = scored[0];
      let selected = best;
      if (binding) {
        const bound = scored.find((item) => item.entry.snapshot.roomName === binding.fromRoomName);
        if (bound && best.score < bound.score * SYNTHESIS_BINDING_SWITCH_ADVANTAGE_RATIO) {
          selected = bound;
        }
      }

      const donor = selected.entry.snapshot;
      const suggested = Math.min(deficit, selected.entry.available, donor.transferBatchSize);
      const amount = Math.max(0, Math.floor(suggested));
      if (amount <= 0) {
        continue;
      }

      const result = createAutomaticResourceTransferTask(
        donor.roomName,
        targetRoomName,
        resource,
        amount,
        `auto:synthesis:${targetRoomName}:${resource}`,
      );
      if (typeof result === "string") {
        actions.push(`task-generate-failed:${targetRoomName}:${resource}:${result}`);
        continue;
      }

      setSynthesisBinding(bindings, targetRoomName, resource, donor.roomName);

      created += 1;
      actions.push(`task-generated:${result.task.id}:${resource}=${amount}:${donor.roomName}->${targetRoomName}`);
    }
  }

  return { actions, bindings };
}

export function runSynthesisTaskPlanningCompatibility(): string[] | null {
  if (Memory.cfg?.resourceControl?.enabled === false) {
    return null;
  }

  const interval = getResourceControlSampleInterval();
  if (!isDue("synthesis.compatibility", interval)) {
    return null;
  }

  const snapshots = collectResourceControlSnapshots();
  if (snapshots.length === 0) {
    return null;
  }

  const autoTaskResult = generateSynthesisTransferTasks(snapshots);
  const runtime = getMemoryService().ensureRuntime();
  runtime.resourceControl = runtime.resourceControl || {
    updatedAt: Game.time,
    rooms: {},
    lastActions: [],
    lastMarketActions: [],
    synthesisBindings: {},
  };
  runtime.resourceControl.synthesisBindings = autoTaskResult.bindings;
  return autoTaskResult.actions;
}
