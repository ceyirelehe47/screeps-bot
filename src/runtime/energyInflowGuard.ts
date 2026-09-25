/**
 * 容量受压且安全库存充足时暂停新能量采集。仅消费本 tick 的
 * ResourceControl 事实；状态缺失或房间正在补充防御能量时照常采集。
 * 空位恢复到 normal 后自动恢复，不改写采集配置或储备账本。
 */
export function shouldPauseEnergyExtraction(homeRoomName: string): boolean {
  const room = Game.rooms[homeRoomName];
  const control = Memory.runtime?.resourceControl;
  const state = control?.rooms?.[homeRoomName];
  if (
    !room?.controller?.my ||
    !room.storage ||
    !room.terminal ||
    control?.updatedAt !== Game.time ||
    (state?.capacityState !== "pressure" &&
      state?.capacityState !== "emergency") ||
    !Number.isFinite(state.energyTarget) ||
    !Number.isFinite(state.energyFloor) ||
    !Number.isFinite(state.terminalEnergyReserve) ||
    !Number.isFinite(room.energyAvailable) ||
    !Number.isFinite(room.energyCapacityAvailable) ||
    room.energyAvailable < room.energyCapacityAvailable / 2
  ) {
    return false;
  }

  const storageEnergy = room.storage.store.getUsedCapacity(RESOURCE_ENERGY);
  const terminalEnergy = room.terminal.store.getUsedCapacity(RESOURCE_ENERGY);
  return (
    Number.isFinite(storageEnergy) &&
    Number.isFinite(terminalEnergy) &&
    storageEnergy >= Math.max(state.energyFloor, state.energyTarget) &&
    terminalEnergy >= (state.terminalEnergyReserve ?? 0) + 1_000
  );
}
