import { requestCombatObservation } from "@/runtime/powerBankObserver";
import type { MoveToRoomOptions } from "@/movement/types";

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
  const runtime = Memory.runtime ??= {};
  const intel = runtime.powerBankOwnedRoomIntel ??= {};
  // 失去视野不能撤销已确认的敌方所有权。只有新的原生视野证明已无主
  // 或属于己方，才允许路线重新使用它；实际跨房仍由 fresh 视野门核验。
  for (const room of Object.values(Game.rooms)) {
    const owner = room.controller?.owner;
    if (owner && !room.controller?.my) {
      const previous = intel[room.name];
      if (previous?.owner !== owner.username || previous.lastSeenAt !== Game.time) {
        intel[room.name] = { owner: owner.username, lastSeenAt: Game.time };
      }
    } else delete intel[room.name];
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
