import { remoteCivilianMustReturn } from "@/runtime/remoteMiningMissionPolicy";
import { clearMovementState, moveToTargetRoom } from "@/roles/shared";
import { moveOffExit } from "@/movement/traffic";

/** 同一 tick 的远矿安全状态适用于已失去出生配置的旧工人。 */
export function shelterRemoteMiningCivilian(creep: Creep, targetRoom?: string): boolean {
  const [home, kind, target] = (creep.memory?.configName ?? "").split(":");
  if (kind !== "remoteMine" || !targetRoom || target !== targetRoom) return false;
  const task = Memory.data?.remoteMining?.[targetRoom];
  if (!task || task.sourceRoom !== home || !remoteCivilianMustReturn(task)) return false;
  if (creep.room.name !== home) {
    moveToTargetRoom(creep, home, creep.room.name === target ? target + "|" + home : undefined,
      { plainCost: 2, swampCost: 10, profile: "travel", reusePath: 10 });
  } else {
    clearMovementState(creep);
    if (creep.pos.x === 0 || creep.pos.x === 49 || creep.pos.y === 0 || creep.pos.y === 49) moveOffExit(creep);
  }
  return true;
}
