import type { MovePathState, TravelState, WorkAnchor } from "@/movement/types";
import { isStandardCreep } from "@/movement/common";

export interface CreepMovementState {
  movePathState?: MovePathState;
  travelState?: TravelState;
  movementPushedAt?: number;
  pathingRequestedAt?: number;
  lastPathFailure?: { at: number; reason: "staticBlocked" | "dynamicBlocked" | "policyDenied" | "budgetExhausted" | "invalidPath" };
  /** 业务下一步许可暂未满足；观察等待不等同于几何卡死。 */
  stepPolicyWaitAt?: number;
  workAnchor?: WorkAnchor;
  /** PB 跟随连续无路时允许领队回靠；只保留 heap 状态，随单位清理。 */
  pairFollowFailure?: { attackerId: string; at: number; count: number };
}

type MovementStateStore = Record<string, CreepMovementState>;

type RuntimeGlobalWithMovementState = typeof global & {
  __creepMovementState?: MovementStateStore;
};

const runtimeGlobal: RuntimeGlobalWithMovementState = global;
const POWER_CREEP_STATE_PREFIX = "power-creep:";

type MovementStateOwner = string | AnyCreep;

function getMovementStateKey(owner: MovementStateOwner): string {
  if (typeof owner === "string") {
    return owner;
  }
  return isStandardCreep(owner) ? owner.name : `${POWER_CREEP_STATE_PREFIX}${owner.name}`;
}

function ensureMovementStateStore(): MovementStateStore {
  if (!runtimeGlobal.__creepMovementState) {
    runtimeGlobal.__creepMovementState = {};
  }

  return runtimeGlobal.__creepMovementState;
}

export function ensureCreepMovementState(owner: MovementStateOwner): CreepMovementState {
  const store = ensureMovementStateStore();
  const key = getMovementStateKey(owner);
  const existing = store[key];
  if (existing) {
    return existing;
  }

  store[key] = {};
  return store[key];
}

export function getCreepMovementState(owner: MovementStateOwner): CreepMovementState | undefined {
  return runtimeGlobal.__creepMovementState?.[getMovementStateKey(owner)];
}

export function clearCreepMovementState(owner: MovementStateOwner): void {
  delete ensureMovementStateStore()[getMovementStateKey(owner)];
}

function pruneLiveTravelState(state: CreepMovementState, roomName: string): void {
  const travelState = state.travelState;
  if (!travelState) {
    return;
  }
  if (travelState.targetRoom === roomName) {
    delete state.travelState;
    return;
  }

}

export function pruneDeadCreepMovementState(): number {
  const store = runtimeGlobal.__creepMovementState;
  if (!store) {
    return 0;
  }

  let removed = 0;
  for (const key of Object.keys(store)) {
    if (key.startsWith(POWER_CREEP_STATE_PREFIX)) {
      const powerCreepName = key.slice(POWER_CREEP_STATE_PREFIX.length);
      const powerCreep = Game.powerCreeps?.[powerCreepName];
      if (powerCreep?.room && powerCreep.ticksToLive != null) {
        pruneLiveTravelState(store[key], powerCreep.room.name);
        continue;
      }
    } else {
      const creep = Game.creeps[key];
      if (creep) {
        pruneLiveTravelState(store[key], creep.room.name);
        continue;
      }
    }

    delete store[key];
    removed += 1;
  }

  if (Object.keys(store).length === 0) {
    delete runtimeGlobal.__creepMovementState;
  }

  return removed;
}

export function clearCreepMovementStateForTest(): void {
  delete runtimeGlobal.__creepMovementState;
}
