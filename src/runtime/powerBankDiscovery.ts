import { POWER_BANK_STATUS, isPowerBankSearchRoom } from "@/runtime/powerBankConstants";
import { updatePowerBankObservation } from "@/runtime/powerBankTaskState";

export function ensureDiscoveryStore(): Record<string, PowerBankHarvestTask> {
  if (!Memory.data) {
    (Memory as any).data = {};
  }
  if (!Memory.data.powerBankHarvest) {
    Memory.data.powerBankHarvest = {};
  }
  return Memory.data.powerBankHarvest;
}

export function countFreeAdjacentTiles(pos: RoomPosition): number {
  const terrain = Game.map.getRoomTerrain(pos.roomName);
  let count = 0;

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const tx = pos.x + dx;
      const ty = pos.y + dy;
      if (tx < 0 || tx > 49 || ty < 0 || ty > 49) continue;
      const t = terrain.get(tx, ty);
      // 0 = plains, 1 = wall, 2 = swamp
      if (t !== 1) {
        count++;
      }
    }
  }

  return count;
}

export function recordPowerBankDiscovery(bank: StructurePowerBank): void {
  if (!isPowerBankSearchRoom(bank.pos.roomName)) {
    return;
  }

  const store = ensureDiscoveryStore();
  const existing = store[bank.id];

  if (existing) {
    updatePowerBankObservation(existing, bank);
    return;
  }

  store[bank.id] = {
    id: bank.id,
    status: POWER_BANK_STATUS.DISCOVERED,
    sourceRoom: "",
    targetRoom: bank.pos.roomName,
    bankId: bank.id,
    bankPos: { x: bank.pos.x, y: bank.pos.y },
    hits: bank.hits,
    power: bank.power,
    ticksToDecay: bank.ticksToDecay,
    freeTiles: countFreeAdjacentTiles(bank.pos),
    discoveredTick: Game.time,
    lastSeenTick: Game.time,
    lastVisibleAt: Game.time,
    bankExpiresAt: Game.time + bank.ticksToDecay,
    stageEnteredAt: Game.time,
    lastProgressAt: Game.time,
    lastBankHits: bank.hits,
    lastBankProgressAt: Game.time,
    activeGeneration: 0,
    activeIndex: 0,
    combatReady: false,
    primaryBoostOwnerId: `${bank.id}:primary:g0`,
    primaryBoostLabs: [],
    observedPower: 0,
    pickedUpPower: 0,
    deliveredPower: 0,
    lostPower: 0,
    haulerIds: [],
    boostLabs: [],
    compoundTransferTaskIds: [],
  };
}

const STALE_DISCOVERY_THRESHOLD = 500;

export function cleanupStaleDiscoveries(): void {
  const store = ensureDiscoveryStore();
  const now = Game.time;

  for (const id of Object.keys(store)) {
    const task = store[id];
    if (
      task.status === POWER_BANK_STATUS.DISCOVERED &&
      now - task.lastSeenTick > STALE_DISCOVERY_THRESHOLD
    ) {
      // 等待测距或复看不能提前丢弃；过期仍交由 manager 的绝对截止门收尾。
      if (task.blocker && ["target_not_visible", "target_bank_unconfirmed", "target_combat_threat", "path_measurement_pending"].includes(task.blocker) &&
          task.bankExpiresAt !== undefined && Number.isFinite(task.bankExpiresAt)) continue;
      delete store[id];
    }
  }
}
