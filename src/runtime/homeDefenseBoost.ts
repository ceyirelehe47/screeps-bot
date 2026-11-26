import { prepareBoosts, releaseBoostLabs } from "./powerBankBoost";
import { getAssignedPowerBankBoostLabId, getPowerBankBoostPrep } from "./powerBankBoostMemory";

const compound = RESOURCE_CATALYZED_UTRIUM_ACID;
const taskId = (roomName: string) => `homeDefense:${roomName}`;

export function homeDefenseBoostLab(roomName: string): string | undefined {
  return Memory.cfg?.homeDefense?.rooms?.[roomName]?.boostLabId ??
    getAssignedPowerBankBoostLabId(taskId(roomName), compound);
}

/** 使用房内现货和空闲实验室，显式指定的防守实验室仍由既有补给任务管理。 */
export function prepareLocalDefenseBoost(room: Room, defenders: number): void {
  const id = taskId(room.name);
  if (!defenders || Memory.cfg?.homeDefense?.rooms?.[room.name]?.boostLabId) {
    if (getPowerBankBoostPrep(id)) releaseBoostLabs(id, room.name);
    return;
  }
  const stock = (room.storage?.store.getUsedCapacity(compound) ?? 0) + (room.terminal?.store.getUsedCapacity(compound) ?? 0);
  if (stock < LAB_BOOST_MINERAL && !getPowerBankBoostPrep(id)) return;
  const parts = Math.min(25, Math.floor(room.energyCapacityAvailable / (BODYPART_COST[ATTACK] + BODYPART_COST[MOVE])));
  const quantity = Math.min(LAB_MINERAL_CAPACITY, defenders * parts * LAB_BOOST_MINERAL);
  if (quantity > 0) prepareBoosts(id, room.name, 0, new Map([[compound, quantity]]), {requireLabEnergy:true});
}
