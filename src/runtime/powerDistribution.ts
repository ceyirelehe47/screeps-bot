import { isDue } from "@/runtime/cadence";
import { createAutomaticResourceTransferTask, createResourceTransferTaskAmountIndex, ensureResourceTransferTaskStore } from "@/runtime/logistics/resourceTransferTasks";
import { getTerminalAmountOutsideMarketSaleExposure } from "@/runtime/marketSaleExposure";
import { resolveRoomConfig } from "@/runtime/resourceControlRoomConfig";

const PROCESSING_RUNWAY_TICKS = 500;
const MIN_BATCH = 100;
const MAX_NEW_TASKS = 4;

/** 只发布普通运输任务：搬入terminal、费用及实际send仍由既有调度执行。 */
export function runPowerDistribution(rooms: readonly Room[], processors: ReadonlyMap<string, StructurePowerSpawn>): void {
  if (!isDue("powerDistribution.plan", 25) || Memory.cfg?.resourceControl?.enabled === false) return;
  if (rooms.filter((room) => room.controller?.my && room.terminal).length < 2) return;
  const index = createResourceTransferTaskAmountIndex();
  const capacityReserved = new Map<string, number>();
  const feeReserved = new Map<string, number>();
  for (const task of Object.values(ensureResourceTransferTaskStore())) {
    if (task.status !== "pending") continue;
    capacityReserved.set(task.toRoomName, (capacityReserved.get(task.toRoomName) ?? 0) + task.remainingAmount);
    feeReserved.set(task.fromRoomName, (feeReserved.get(task.fromRoomName) ?? 0) + Game.market.calcTransactionCost(task.remainingAmount, task.fromRoomName, task.toRoomName));
  }
  const candidates = rooms.filter((room) => room.controller?.my && room.terminal
    && (typeof room.terminal.isActive !== "function" || room.terminal.isActive())).map((room) => {
    const terminal = room.terminal!;
    const policy = resolveRoomConfig(room.name);
    const processor = processors.get(room.name);
    let rate = 1;
    for (const effect of processor?.effects ?? []) {
      if (effect.effect !== PWR_OPERATE_POWER || effect.ticksRemaining <= 0) continue;
      const value = POWER_INFO[PWR_OPERATE_POWER].effect;
      const extra = Array.isArray(value) ? value[(effect.level ?? 1) - 1] : value;
      if (typeof extra === "number") rate = Math.max(rate, 1 + extra);
    }
    const energy = (room.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0) + terminal.store.getUsedCapacity(RESOURCE_ENERGY);
    const budget = Math.max(0, energy - policy.energyFloor - index.getOutgoing(room.name, RESOURCE_ENERGY));
    const target = processor ? Math.min(PROCESSING_RUNWAY_TICKS * rate, Math.floor(budget / POWER_SPAWN_ENERGY_RATIO)) : 0;
    const stored = (room.storage?.store.getUsedCapacity(RESOURCE_POWER) ?? 0) + getTerminalAmountOutsideMarketSaleExposure(terminal, RESOURCE_POWER, room.name);
    const inProcessor = processor?.store.getUsedCapacity(RESOURCE_POWER) ?? 0;
    const outgoing = index.getOutgoing(room.name, RESOURCE_POWER);
    const incoming = index.getPendingIncoming(room.name, RESOURCE_POWER);
    return { room, surplus: Math.max(0, stored - Math.max(0, target - inProcessor) - outgoing - (processor ? 2 * MIN_BATCH : 0)),
      deficit: Math.max(0, target - stored - inProcessor + outgoing - incoming),
      capacity: Math.max(0, terminal.store.getFreeCapacity() - (capacityReserved.get(room.name) ?? 0)),
      feeEnergy: Math.max(0, terminal.store.getUsedCapacity(RESOURCE_ENERGY) - policy.terminalEnergyReserve - index.getOutgoing(room.name, RESOURCE_ENERGY) - (feeReserved.get(room.name) ?? 0)) };
  });
  const pairs = candidates.flatMap((source) => candidates.filter((target) => source !== target && target.deficit >= MIN_BATCH && source.surplus >= MIN_BATCH)
    .map((target) => ({ source, target, distance: Game.map.getRoomLinearDistance(source.room.name, target.room.name) })));
  pairs.sort((a, b) => a.distance - b.distance || b.target.deficit - a.target.deficit || b.source.surplus - a.source.surplus
    || a.source.room.name.localeCompare(b.source.room.name) || a.target.room.name.localeCompare(b.target.room.name));
  let published = 0;
  for (const { source, target } of pairs) {
    if (published >= MAX_NEW_TASKS) break;
    let amount = Math.floor(Math.min(source.surplus, target.deficit, target.capacity));
    if (amount < MIN_BATCH) continue;
    // 费用不足时缩小批次，不制造长期无法执行的运输承诺。
    let low = 0; let high = amount;
    while (low < high) {
      const next = Math.ceil((low + high) / 2);
      if (Game.market.calcTransactionCost(next, source.room.name, target.room.name) <= source.feeEnergy) low = next;
      else high = next - 1;
    }
    amount = low;
    if (amount < MIN_BATCH) continue;
    const result = createAutomaticResourceTransferTask(source.room.name, target.room.name, RESOURCE_POWER, amount, "powerProcessing:nearby");
    if (typeof result === "string") continue;
    published++;
    source.surplus -= amount;
    source.feeEnergy -= Game.market.calcTransactionCost(amount, source.room.name, target.room.name);
    target.deficit -= amount;
    target.capacity -= amount;
  }
}
