import { getTickContextService } from "@/runtime/runtimeServices";
import { resolveRoomEnergyPolicy } from "@/runtime/roomEnergyPolicy";

export const TERMINAL_BOOTSTRAP_RECOVERY_STABLE_TICKS = 25;
const TERMINAL_BOOTSTRAP_RECOVERY_ENERGY_RATIO = 0.5;
const MINIMUM_SUSTAINABLE_ROOM_ENERGY = 300;

type RecoveryRuntimeState = NonNullable<
  NonNullable<NonNullable<Memory["runtime"]>["energyPickup"]>["terminalBootstrapRecovery"]
>[string];

function getFlagStore(): Record<string, boolean> | undefined {
  return Memory.cfg?.energyPickup?.terminalBootstrapRecoveryRooms;
}

function getRuntimeStore(
  create: boolean,
): Record<string, RecoveryRuntimeState> | undefined {
  const existing = Memory.runtime?.energyPickup?.terminalBootstrapRecovery;
  if (existing || !create) {
    return existing;
  }

  Memory.runtime = Memory.runtime || {};
  Memory.runtime.energyPickup = Memory.runtime.energyPickup || {};
  Memory.runtime.energyPickup.terminalBootstrapRecovery = {};
  return Memory.runtime.energyPickup.terminalBootstrapRecovery;
}

function pruneEmptyRuntimeContainers(): void {
  const energyPickup = Memory.runtime?.energyPickup;
  if (!energyPickup) return;

  const recovery = energyPickup.terminalBootstrapRecovery;
  if (recovery && Object.keys(recovery).length === 0) {
    delete energyPickup.terminalBootstrapRecovery;
  }
  if (Object.keys(energyPickup).length === 0) {
    delete Memory.runtime?.energyPickup;
  }
}

function clearRuntimeState(roomName: string): void {
  const store = getRuntimeStore(false);
  if (!store?.[roomName]) return;

  delete store[roomName];
  pruneEmptyRuntimeContainers();
}

/** 清理由 operator intent 不再显式启用的周期观测状态。 */
export function cleanupTerminalBootstrapRecoveryRuntime(): number {
  const store = getRuntimeStore(false);
  let removed = 0;
  if (store) {
    const flags = getFlagStore();
    for (const roomName of Object.keys(store)) {
      if (flags?.[roomName] === true) continue;
      delete store[roomName];
      removed += 1;
    }
  }

  pruneEmptyRuntimeContainers();
  return removed;
}

function clearRecoveryFlag(roomName: string): void {
  const flags = getFlagStore();
  if (flags?.[roomName] !== undefined) {
    delete flags[roomName];
    if (Object.keys(flags).length === 0) {
      delete Memory.cfg?.energyPickup?.terminalBootstrapRecoveryRooms;
    }
  }
  clearRuntimeState(roomName);
}

function isManagedLiveCreep(
  creep: Creep,
  roomName: string,
  role: "carrier" | "miner",
  canonicalConfigName?: string,
): boolean {
  if (
    creep.spawning === true ||
    creep.room.name !== roomName ||
    !creep.memory.configName ||
    (canonicalConfigName && creep.memory.configName !== canonicalConfigName)
  ) {
    return false;
  }

  const config = Memory.data?.creepConfigs?.[creep.memory.configName];
  return config?.role === role && config.roomName === roomName;
}

function hasStableManagedRoles(roomName: string): boolean {
  const creeps = getTickContextService().getAllCreeps();
  const canonicalCarrierConfigName = `${roomName}:carrier:0`;
  const hasCanonicalCarrier = creeps.some((creep) =>
    isManagedLiveCreep(
      creep,
      roomName,
      "carrier",
      canonicalCarrierConfigName,
    ),
  );
  if (!hasCanonicalCarrier) return false;

  return creeps.some((creep) =>
    isManagedLiveCreep(creep, roomName, "miner"),
  );
}

function getSustainableEnergyThreshold(room: Room): number {
  const capacity = Math.max(0, room.energyCapacityAvailable || 0);
  return Math.min(
    capacity,
    Math.max(
      MINIMUM_SUSTAINABLE_ROOM_ENERGY,
      Math.ceil(capacity * TERMINAL_BOOTSTRAP_RECOVERY_ENERGY_RATIO),
    ),
  );
}

function hasStableRecoveryEvidence(
  room: Room,
  state: RecoveryRuntimeState,
): boolean {
  const threshold = getSustainableEnergyThreshold(room);
  return threshold > 0 &&
    room.energyAvailable >= threshold &&
    state.lastRecoveryPickupAt !== Game.time &&
    hasStableManagedRoles(room.name);
}

/**
 * Observe a flagged room once per game tick and return its recovery-specific
 * Terminal Energy reserve while the grant remains active.
 */
export function observeTerminalBootstrapRecovery(
  roomName: string,
): number | undefined {
  if (getFlagStore()?.[roomName] !== true) {
    clearRuntimeState(roomName);
    return undefined;
  }

  const room = Game.rooms[roomName];
  if (!room?.controller?.my || !room.terminal) {
    const state = getRuntimeStore(true)![roomName] || {};
    delete state.healthySince;
    state.lastObservedAt = Game.time;
    getRuntimeStore(true)![roomName] = state;
    return undefined;
  }

  const runtimeStore = getRuntimeStore(true)!;
  const state = runtimeStore[roomName] || (runtimeStore[roomName] = {});
  if (state.lastObservedAt !== Game.time) {
    const observationsAreConsecutive = state.lastObservedAt === Game.time - 1;
    if (!observationsAreConsecutive) {
      delete state.healthySince;
    }
    state.lastObservedAt = Game.time;

    if (hasStableRecoveryEvidence(room, state)) {
      state.healthySince ??= Game.time;
    } else {
      delete state.healthySince;
    }
  }

  if (
    state.healthySince !== undefined &&
    Game.time - state.healthySince + 1 >=
      TERMINAL_BOOTSTRAP_RECOVERY_STABLE_TICKS
  ) {
    clearRecoveryFlag(roomName);
    return undefined;
  }

  return resolveRoomEnergyPolicy(
    Memory.cfg?.resourceControl?.rooms?.[roomName],
  ).terminalEnergyReserve;
}

export function noteTerminalBootstrapRecoveryPickup(roomName: string): void {
  if (getFlagStore()?.[roomName] !== true) return;

  const runtimeStore = getRuntimeStore(true)!;
  const state = runtimeStore[roomName] || (runtimeStore[roomName] = {});
  state.lastRecoveryPickupAt = Game.time;
  delete state.healthySince;
}
