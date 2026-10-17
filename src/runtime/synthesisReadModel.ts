import { getTickContextService } from "@/runtime/runtimeServices";
import { countCarrierCargo } from "@/runtime/carrierCargo";
/** 从 synthesisControl.ts 分离的独立职责模块；共享状态仅由此处持有。 */
import {
  countsResourceTransferTaskTowardDemand,
  resolveResourceTransferTaskHealthOptions,
  type ResourceTransferTask,
} from "@/runtime/logistics/resourceTransferTasks";
import { getCreepAssignmentState } from "@/runtime/creepAssignmentState";
import { normalizeBoolean, normalizeNumber, normalizeRoomNameList } from "@/runtime/configNormalize";
import { getProductReagents, roundUpReactionAmount } from "@/runtime/reactionMap";


export interface SynthesisReactionPlan {
  product: ResourceConstant;
  targetAmount: number;
  batchSize: number;
  donorRoomNames: string[];
}

export interface SynthesisRoomConfig {
  enabled: boolean;
  batchSize: number;
  donorRoomNames: string[];
  reagentLabIds: string[];
  reactions: SynthesisReactionPlan[];
}

export interface SynthesisControlConfig {
  enabled: boolean;
  sampleInterval: number;
  defaultBatchSize: number;
  rooms: Record<string, SynthesisRoomConfig>;
}

const DEFAULT_SAMPLE_INTERVAL = 10;
export const DEFAULT_BATCH_SIZE = 500;
const MIN_SAMPLE_INTERVAL = 5;
const MAX_SAMPLE_INTERVAL = 100;
const MIN_BATCH_SIZE = LAB_REACTION_AMOUNT;
const MAX_BATCH_SIZE = 3000;

function normalizeReactionPlan(raw: unknown, roomCfg: SynthesisRoomConfig, defaultBatchSize: number): SynthesisReactionPlan | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const product = typeof record.product === "string" ? (record.product as ResourceConstant) : null;
  if (!product || !getProductReagents(product)) {
    return null;
  }

  const targetAmount = normalizeNumber(record.targetAmount, 0, 0, 500_000);
  if (targetAmount <= 0) {
    return null;
  }

  const batchSize = normalizeNumber(record.batchSize, roomCfg.batchSize || defaultBatchSize, MIN_BATCH_SIZE, MAX_BATCH_SIZE);
  const donorRoomNames = normalizeRoomNameList(record.donorRoomNames);
  return {
    product,
    targetAmount,
    batchSize,
    donorRoomNames,
  };
}

function normalizeRoomConfig(
  _roomName: string,
  raw: unknown,
  defaultBatchSize: number,
): SynthesisRoomConfig {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const roomCfg: SynthesisRoomConfig = {
    enabled: normalizeBoolean(record.enabled, true),
    batchSize: normalizeNumber(record.batchSize, defaultBatchSize, MIN_BATCH_SIZE, MAX_BATCH_SIZE),
    donorRoomNames: normalizeRoomNameList(record.donorRoomNames),
    reagentLabIds: normalizeRoomNameList(record.reagentLabIds),
    reactions: [],
  };

  if (roomCfg.reagentLabIds.length > 2) {
    roomCfg.reagentLabIds = roomCfg.reagentLabIds.slice(0, 2);
  }

  const reactionsRaw = Array.isArray(record.reactions) ? record.reactions : [];
  roomCfg.reactions = reactionsRaw
    .map((entry) => normalizeReactionPlan(entry, roomCfg, defaultBatchSize))
    .filter((entry): entry is SynthesisReactionPlan => !!entry);

  if (roomCfg.reagentLabIds.length > 0 && roomCfg.reagentLabIds.length < 2) {
    roomCfg.enabled = false;
  }

  return roomCfg;
}

export function normalizeConfig(): SynthesisControlConfig {
  const raw = Memory.cfg?.synthesisControl;
  const enabled = normalizeBoolean(raw?.enabled, false);
  const sampleInterval = normalizeNumber(raw?.sampleInterval, DEFAULT_SAMPLE_INTERVAL, MIN_SAMPLE_INTERVAL, MAX_SAMPLE_INTERVAL);
  const defaultBatchSize = normalizeNumber(raw?.defaultBatchSize, DEFAULT_BATCH_SIZE, MIN_BATCH_SIZE, MAX_BATCH_SIZE);

  const roomsRaw = raw?.rooms && typeof raw.rooms === "object" ? (raw.rooms as Record<string, unknown>) : {};
  const rooms: Record<string, SynthesisRoomConfig> = {};
  for (const [roomName, roomCfg] of Object.entries(roomsRaw)) {
    rooms[roomName] = normalizeRoomConfig(roomName, roomCfg, defaultBatchSize);
  }

  return {
    enabled,
    sampleInterval,
    defaultBatchSize,
    rooms,
  };
}

export function roomResourceAmount(room: Room, resource: ResourceConstant): number {
  let total = 0;
  if (room.storage) {
    total += room.storage.store.getUsedCapacity(resource);
  }
  if (room.terminal) {
    total += room.terminal.store.getUsedCapacity(resource);
  }

  const structures = room.find(FIND_MY_STRUCTURES, {
    filter: (structure) =>
      structure.structureType === STRUCTURE_LAB ||
      structure.structureType === STRUCTURE_FACTORY ||
      structure.structureType === STRUCTURE_POWER_SPAWN,
  }) as AnyStoreStructure[];
  for (const structure of structures) {
    total += structure.store.getUsedCapacity(resource) ?? 0;
  }

  return total;
}

function roomSynthesisProductAmount(room: Room, product: ResourceConstant): number {
  let amount = roomResourceAmount(room, product);
  for (const target of [room.storage, room.terminal]) if (target) amount += countCarrierCargo(target.id, product);

  return amount;
}

/** 普通自动补料的已启用配方边界；完成后保留配方事实，避免旧整批余量继续发送。 */
export function inspectConfiguredSynthesisTransferDemand(
  roomName: string, resource: ResourceConstant, product: ResourceConstant, excludeTaskId: string,
): { status: "unmanaged" } | { status: "held"; reason: string } | { status: "bounded"; amount: number; reason: string } {
  try {
    const cfg = normalizeConfig();
    const roomCfg = cfg.rooms[roomName];
    const room = Game.rooms[roomName];
    const plans = roomCfg?.reactions.filter((entry) => entry.product === product) || [];
    if (!cfg.enabled || !roomCfg?.enabled || !room?.controller?.my || plans.length === 0 ||
        !getProductReagents(product)?.includes(resource)) return { status: "unmanaged" };
    // Task reason 不含 target/batch 身份；只有唯一已启用配方才能在 idle 后证明完成。
    if (plans.length === 1 && roomSynthesisProductAmount(room, product) >= plans[0].targetAmount) {
      return { status: "bounded", amount: 0, reason: "synthesis_target_satisfied" };
    }
    const need = inspectSynthesisTransferNeed(roomName, resource, product, excludeTaskId);
    if (need.ok || need.reason === "synthesis_need_already_covered") {
      return { status: "bounded", amount: need.amount, reason: need.reason };
    }
    return { status: "held", reason: need.reason };
  } catch { return { status: "held", reason: "synthesis_demand_unreadable" }; }
}

/** 只读复用真实合成目标：跨房补料不能仍按已被产品现货覆盖的整batch授权。 */
export function inspectSynthesisTransferNeed(roomName: string, resource: ResourceConstant, product: ResourceConstant, excludeTaskId: string): {ok: boolean; amount: number; reason: string} {
  try {
    const cfg = normalizeConfig(); const roomCfg = cfg.rooms[roomName];
    const room = Game.rooms[roomName]; const state = Memory.runtime?.synthesisControl?.rooms?.[roomName];
    if (!cfg.enabled || !roomCfg?.enabled || !room?.controller?.my || !state || state.activeProduct !== product ||
        !["acquiring","loading","synthesizing"].includes(state.stage) || state.boostPause !== undefined) {
      return {ok:false,amount:0,reason:"synthesis_demand_inactive"};
    }
    const plan = roomCfg.reactions.find((entry) => entry.product === product && entry.targetAmount === state.targetAmount && entry.batchSize === state.batchSize);
    const active = plan;
    if (!active || !Number.isSafeInteger(active.targetAmount) || !Number.isSafeInteger(active.batchSize) ||
        active.targetAmount !== state.targetAmount || active.batchSize !== state.batchSize || active.batchSize < 1 ||
        !getProductReagents(product)?.includes(resource)) return {ok:false,amount:0,reason:"synthesis_plan_identity_changed"};
    const productDeficit = Math.max(0, active.targetAmount - roomSynthesisProductAmount(room, product));
    const required = Math.min(active.batchSize, roundUpReactionAmount(productDeficit));
    let covered = roomResourceAmount(room, resource);
    for (const creep of getTickContextService().getAllCreeps()) {
      const cargo = creep.memory as unknown as {room?: string; home?: string; synthesisCarrierPendingResource?: ResourceConstant; synthesisCarrierPendingToId?: string};
      const assignment = getCreepAssignmentState(creep.name);
      const targetId = assignment?.synthesisCarrierPendingToId ?? cargo.synthesisCarrierPendingToId;
      const target = targetId ? Game.getObjectById(targetId as Id<AnyStoreStructure>) : null;
      if (creep.room?.name === roomName || target?.room?.name === roomName) covered += creep.store.getUsedCapacity(resource);
    }
    for (const task of Object.values(Memory.data?.resourceControl?.tasks ?? {})) {
      if (task.id !== excludeTaskId && task.toRoomName === roomName && task.resource === resource &&
          countsResourceTransferTaskTowardDemand(task as ResourceTransferTask, resolveResourceTransferTaskHealthOptions())) covered += task.remainingAmount;
    }
    const amount = Math.max(0, required - covered);
    return {ok:amount > 0,amount,reason:amount > 0 ? "synthesis_need_confirmed" : "synthesis_need_already_covered"};
  } catch { return {ok:false,amount:0,reason:"synthesis_demand_unreadable"}; }
}
