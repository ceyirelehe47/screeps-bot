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
  return Object.values(Game.rooms).filter((room) => !!room.controller?.owner && !room.controller.my).map((room) => room.name);
}

/** 规划避开已知有主房间，执行前再验证实际迁房落点；仍可从旧错误房退出。 */
export function powerBankTransitOptions(creep: Creep, options: MoveToRoomOptions = {}): MoveToRoomOptions {
  return {
    ...options,
    avoidRooms: [...new Set([...(options.avoidRooms ?? []), ...getPowerBankOwnedAvoidRooms()])],
    canMoveStep: (pos) => (pos.roomName === creep.room.name || isPowerBankTransitRoomAllowed(pos.roomName)) && (options.canMoveStep?.(pos) ?? true),
  };
}
