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

/** 可观察时等待原生视野，盲区回退至已确认的所有权情报。 */
export function isPowerBankTransitRoomAllowed(roomName: string): boolean {
  const room = Game.rooms[roomName];
  if (!room) {
    // 有观察覆盖时等待新鲜视野；覆盖不到时用已确认所有权避让。
    // 未知普通房只能在进入后确认，不能因此永久卡在边界。
    const observing = requestCombatObservation(roomName);
    return !observing && !Memory.runtime?.powerBankOwnedRoomIntel?.[roomName];
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
  // 或属于己方，才允许路线重新使用它；有观察能力的跨房仍需新鲜视野核验。
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
