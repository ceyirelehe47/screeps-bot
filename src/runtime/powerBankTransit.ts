import { requestCombatObservation } from "@/runtime/powerBankObserver";
import type { MoveToRoomOptions } from "@/movement/types";
import { measureSampledCpuPhase } from "@/runtime/cpuPhaseProfiler";

interface VisibleRoomOwnership {
  roomName: string;
  enemyOwner?: string;
}

let ownershipSnapshot: {
  game: Game;
  tick: number;
  rooms: Game["rooms"];
  observations: VisibleRoomOwnership[];
} | undefined;

function getVisibleRoomOwnership(): readonly VisibleRoomOwnership[] {
  return measureSampledCpuPhase("owned.snapshot", getVisibleRoomOwnershipImpl);
}

function getVisibleRoomOwnershipImpl(): readonly VisibleRoomOwnership[] {
  if (ownershipSnapshot?.game === Game && ownershipSnapshot.tick === Game.time &&
    ownershipSnapshot.rooms === Game.rooms) return ownershipSnapshot.observations;

  // 原生房间所有权是 tick 起始事实；多个来源预检与行军角色共用一次读取。
  // 只缓存 Game 事实，不缓存可变 intel 或最终避让集合。
  const observations = Object.values(Game.rooms).map(room => {
    const controller = room.controller;
    const owner = controller?.owner;
    return { roomName: room.name, enemyOwner: owner && !controller?.my ? owner.username : undefined };
  });
  ownershipSnapshot = { game: Game, tick: Game.time, rooms: Game.rooms, observations };
  return observations;
}

/** 下一房未知时先取得原生视野；固定任务路线不能覆盖当帧所有权。 */
export function isPowerBankTransitRoomAllowed(roomName: string): boolean {
  const room = Game.rooms[roomName];
  if (!room) {
    requestCombatObservation(roomName);
    return false;
  }
  return !room.controller?.owner || room.controller.my === true;
}

export function getPowerBankOwnedAvoidRooms(): string[] {
  return measureSampledCpuPhase("owned", getPowerBankOwnedAvoidRoomsImpl);
}

function getPowerBankOwnedAvoidRoomsImpl(): string[] {
  const runtime = Memory.runtime ??= {};
  const intel = runtime.powerBankOwnedRoomIntel ??= {};
  // 失去视野不能撤销已确认的敌方所有权。只有新的原生视野证明已无主
  // 或属于己方，才允许路线重新使用它；实际跨房仍由 fresh 视野门核验。
  for (const { roomName, enemyOwner } of getVisibleRoomOwnership()) {
    if (enemyOwner !== undefined) {
      const previous = intel[roomName];
      if (previous?.owner !== enemyOwner || previous.lastSeenAt !== Game.time) {
        intel[roomName] = { owner: enemyOwner, lastSeenAt: Game.time };
      }
    } else delete intel[roomName];
  }
  return Object.keys(intel);
}

/** 规划避开已知有主房间，执行前再验证实际迁房落点；仍可从旧错误房退出。 */
export function powerBankTransitOptions(creep: Creep, options: MoveToRoomOptions = {}): MoveToRoomOptions {
  return {
    ...options,
    avoidRooms: [...new Set([...(options.avoidRooms ?? []), ...getPowerBankOwnedAvoidRooms()])],
    canMoveStep: (pos) => (pos.roomName === creep.room.name || isPowerBankTransitRoomAllowed(pos.roomName)) && (options.canMoveStep?.(pos) ?? true),
  };
}
