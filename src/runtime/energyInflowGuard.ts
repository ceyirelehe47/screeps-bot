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

/** 外矿只按母房 Storage 的实际接收余量暂停，不沿用本地库存目标。 */
export function shouldPauseRemoteEnergyExtraction(homeRoomName: string): boolean {
  const room = Game.rooms[homeRoomName];
  const storage = room?.storage;
  if (!room?.controller?.my || !storage || typeof storage.store?.getFreeCapacity !== "function") return false;
  const free = storage.store.getFreeCapacity();
  if (typeof free !== "number" || !Number.isFinite(free)) return false;

  const control = Memory.runtime?.resourceControl;
  const state = control?.updatedAt === Game.time ? control.rooms?.[homeRoomName] : undefined;
  const commitment = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  const available = Math.max(0, free) - commitment(state?.localOffloadCapacityCommitment) -
    commitment(state?.capacityReservation?.committed);
  return available < 5_000;
}
