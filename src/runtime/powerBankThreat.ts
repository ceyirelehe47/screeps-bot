import { getTickContextService } from "@/runtime/runtimeServices";

/** Observer 只用当前可见敌方战斗能力拒绝新的资源投入，不发布战斗意图。 */
export function getPowerBankRoomThreat(room: Room): boolean {
  const candidate = Game.rooms[room.name] === room ? getTickContextService().getRoomContext(room) : null;
  const context = candidate?.room === room ? candidate : null;
  if ((context?.getHostilePowerCreeps() ?? room.find(FIND_HOSTILE_POWER_CREEPS)).length > 0) return true;
  return (context?.getHostileCreeps() ?? room.find(FIND_HOSTILE_CREEPS)).some((creep) => {
    if (typeof creep.getActiveBodyparts === "function") {
      return creep.getActiveBodyparts(ATTACK) > 0 ||
        creep.getActiveBodyparts(RANGED_ATTACK) > 0 || creep.getActiveBodyparts(HEAL) > 0;
    }
    // 缺少战斗能力证据时保守等待，不能把未知实体当作安全 Scout。
    if (!Array.isArray(creep.body)) return true;
    return creep.body.some((part) => part.hits > 0 &&
      (part.type === ATTACK || part.type === RANGED_ATTACK || part.type === HEAL));
  });
}
