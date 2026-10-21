import { collectResourceControlSnapshots, getResourceControlDonorAvailable, getResourceControlPlanningEnergyBudget } from "@/runtime/resourceControlReadModel";
import { isDue } from "@/runtime/cadence";
import { createAutomaticResourceTransferTask, createResourceTransferTaskAmountIndex, ensureResourceTransferTaskStore } from "@/runtime/logistics/resourceTransferTasks";
import { getTerminalAmountOutsideMarketSaleExposure } from "@/runtime/marketSaleExposure";
import { resolveRoomConfig } from "@/runtime/resourceControlRoomConfig";
import { runIsolatedRoutineRoomOperation } from "@/runtime/runtimeIsolation";

export const PROCESSING_RUNWAY_TICKS = 1_000;
const MIN_BATCH = 100;
const MAX_NEW_TASKS = 4;

export interface PowerDistributionRuntime {
  updatedAt: number;
  runwayTicks: number;
  status: "planned" | "disabled" | "insufficient_rooms";
  published: number;
  publishedAmount: number;
  unavailableRooms: string[];
  rooms: Record<string, {
    stored: number; physicalStock: number; movable: number; target: number; incoming: number; outgoing: number;
    surplus: number; deficit: number; feeEnergy: number; capacity: number; processing: boolean;
    blocker?: "market_or_production_protected" | "processing_reserve" | "energy_floor" | "capacity" | "fee";
  }>;
}

/** 只发布普通运输任务：搬入terminal、费用及实际send仍由既有调度执行。 */
export function runPowerDistribution(rooms: readonly Room[], processors: ReadonlyMap<string, StructurePowerSpawn>,
  options: { unavailableRooms?: readonly string[] } = {}): void {
  if (!isDue("powerDistribution.plan", 25)) return;
  const diagnostic: PowerDistributionRuntime = { updatedAt: Game.time, runwayTicks: PROCESSING_RUNWAY_TICKS,
    status: "planned", published: 0, publishedAmount: 0, unavailableRooms: [...(options.unavailableRooms ?? [])].slice(0, 8), rooms: {} };
  (Memory.runtime ??= {}).powerDistribution = diagnostic;
  if (Memory.cfg?.resourceControl?.enabled === false) { diagnostic.status = "disabled"; return; }
  if (rooms.filter((room) => room.controller?.my && room.terminal).length < 2) { diagnostic.status = "insufficient_rooms"; return; }
  const index = createResourceTransferTaskAmountIndex();
  const capacityReserved = new Map<string, number>();
  const feeReserved = new Map<string, number>();
  for (const task of Object.values(ensureResourceTransferTaskStore())) {
    if (task.status !== "pending") continue;
    capacityReserved.set(task.toRoomName, (capacityReserved.get(task.toRoomName) ?? 0) + task.remainingAmount);
    feeReserved.set(task.fromRoomName, (feeReserved.get(task.fromRoomName) ?? 0) + Game.market.calcTransactionCost(Math.min(resolveRoomConfig(task.fromRoomName).transferBatchSize, task.remainingAmount), task.fromRoomName, task.toRoomName));
  }
  const candidates = rooms.filter((room) => room.controller?.my && room.terminal
    && !options.unavailableRooms?.includes(room.name)).flatMap((room) => {
    const candidate = runIsolatedRoutineRoomOperation("powerDistribution", room.name, () => {
      const terminal = room.terminal!;
      if (typeof terminal.isActive === "function" && !terminal.isActive()) return null;
      const policy = resolveRoomConfig(room.name);
      const processor = processors.get(room.name);
      let rate = 1;
      for (const effect of processor?.effects ?? []) {
        if (effect.effect !== PWR_OPERATE_POWER || effect.ticksRemaining <= 0) continue;
        const value = POWER_INFO[PWR_OPERATE_POWER].effect;
        const extra = Array.isArray(value) ? value[(effect.level ?? 1) - 1] : value;
        if (typeof extra === "number") rate = Math.max(rate, 1 + extra);
      }
      // 本地加工需求由真实可消费能量决定；待外发的整笔能量不抹掉加工需求。
      const budget = Math.max(0, (room.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0) +
        getTerminalAmountOutsideMarketSaleExposure(terminal, RESOURCE_ENERGY, room.name) - policy.energyFloor - policy.terminalEnergyReserve);
      const target = processor ? Math.min(PROCESSING_RUNWAY_TICKS * rate, Math.floor(budget / POWER_SPAWN_ENERGY_RATIO)) : 0;
      const stored = (room.storage?.store.getUsedCapacity(RESOURCE_POWER) ?? 0) + getTerminalAmountOutsideMarketSaleExposure(terminal, RESOURCE_POWER, room.name);
      const inProcessor = processor?.store.getUsedCapacity(RESOURCE_POWER) ?? 0;
      const outgoing = index.getOutgoing(room.name, RESOURCE_POWER);
      const incoming = index.getPendingIncoming(room.name, RESOURCE_POWER);
      const snapshot = collectResourceControlSnapshots([RESOURCE_POWER], [room])[0];
      const physicalStock = (room.storage?.store.getUsedCapacity(RESOURCE_POWER) ?? 0) + terminal.store.getUsedCapacity(RESOURCE_POWER);
      const movable = Math.max(0, getResourceControlDonorAvailable(snapshot, RESOURCE_POWER) - outgoing);
      const surplus = Math.min(movable, Math.max(0, stored - Math.max(0, target - inProcessor) - outgoing - (processor ? 2 * MIN_BATCH : 0)));
      const result = { room, surplus,
        deficit: Math.max(0, target - stored - inProcessor + outgoing - incoming),
        capacity: Math.max(0, terminal.store.getFreeCapacity() - (capacityReserved.get(room.name) ?? 0)),
        feeEnergy: Math.max(0, getResourceControlPlanningEnergyBudget(room) - index.getOutgoing(room.name, RESOURCE_ENERGY) - (feeReserved.get(room.name) ?? 0)) };
      if (Object.keys(diagnostic.rooms).length < 32) diagnostic.rooms[room.name] = {
        stored, physicalStock, movable, target, incoming, outgoing, surplus, deficit: result.deficit, capacity: result.capacity,
        feeEnergy: result.feeEnergy, processing: !!processor,
        blocker: movable < MIN_BATCH && physicalStock >= MIN_BATCH ? "market_or_production_protected"
          : processor && target === 0 ? "energy_floor" : result.capacity < MIN_BATCH ? "capacity"
          : surplus < MIN_BATCH && stored >= MIN_BATCH ? "processing_reserve" : undefined,
      };
      return result;
    });
    if (candidate === undefined && diagnostic.unavailableRooms.length < 8 && !diagnostic.unavailableRooms.includes(room.name)) diagnostic.unavailableRooms.push(room.name);
    return candidate ? [candidate] : [];
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
    if (amount < MIN_BATCH) {
      const detail = diagnostic.rooms[source.room.name]; if (detail) detail.blocker = "fee";
      continue;
    }
    const result = createAutomaticResourceTransferTask(source.room.name, target.room.name, RESOURCE_POWER, amount, "powerProcessing:nearby");
    if (typeof result === "string") continue;
    published++;
    diagnostic.published = published;
    diagnostic.publishedAmount += amount;
    source.surplus -= amount;
    source.feeEnergy -= Game.market.calcTransactionCost(amount, source.room.name, target.room.name);
    target.deficit -= amount;
    target.capacity -= amount;
  }
}
