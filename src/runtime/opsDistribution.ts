import { getResourceControlPlanningEnergyBudget } from "@/runtime/resourceControlReadModel";
import { isDue } from "@/runtime/cadence";
import { createAutomaticResourceTransferTask, createResourceTransferTaskAmountIndex, ensureResourceTransferTaskStore } from "@/runtime/logistics/resourceTransferTasks";
import { getTerminalAmountOutsideMarketSaleExposure } from "@/runtime/marketSaleExposure";
import { collectPowerCreepOpsRoomPolicies, POWER_CREEP_OPS_SUPPLY_REASON } from "@/runtime/powerCreepOpsPolicy";
import { resolveRoomConfig } from "@/runtime/resourceControlRoomConfig";

const MIN_BATCH = 100;
const MAX_NEW_TASKS = 4;

/** 发布既有运输任务；搬入终端、费用、容量和 send 由 ResourceControl 执行。 */
export function runOpsDistribution(): void {
  if (!isDue("opsDistribution.plan", 25) || Memory.cfg?.resourceControl?.enabled === false) return;
  const policies = collectPowerCreepOpsRoomPolicies();
  if (policies.size === 0) return;
  const rooms = Object.values(Game.rooms).filter(room => room.controller?.my && room.terminal &&
    (typeof room.terminal.isActive !== "function" || room.terminal.isActive()));
  if (rooms.length < 2) return;
  const index = createResourceTransferTaskAmountIndex();
  const capacityReserved = new Map<string, number>();
  const feeReserved = new Map<string, number>();
  for (const task of Object.values(ensureResourceTransferTaskStore())) {
    if (task.status !== "pending") continue;
    capacityReserved.set(task.toRoomName, (capacityReserved.get(task.toRoomName) || 0) + task.remainingAmount);
    feeReserved.set(task.fromRoomName, (feeReserved.get(task.fromRoomName) || 0) +
      Game.market.calcTransactionCost(Math.min(resolveRoomConfig(task.fromRoomName).transferBatchSize, task.remainingAmount), task.fromRoomName, task.toRoomName));
  }
  const candidates = rooms.map(room => {
    const terminal = room.terminal!;
    const policy = policies.get(room.name);
    const stored = (room.storage?.store.getUsedCapacity(RESOURCE_OPS) || 0) +
      getTerminalAmountOutsideMarketSaleExposure(terminal, RESOURCE_OPS, room.name);
    const outgoing = index.getOutgoing(room.name, RESOURCE_OPS);
    const available = stored + (policy?.carried || 0) - outgoing + index.getIncoming(room.name, RESOURCE_OPS);
    return { room,
      surplus: Math.max(0, stored - (policy?.target || 0) - outgoing),
      deficit: policy && available < policy.lowWater ? Math.max(0, policy.target - available) : 0,
      available,
      capacity: Math.max(0, terminal.store.getFreeCapacity() - (capacityReserved.get(room.name) || 0)),
      feeEnergy: Math.max(0, getResourceControlPlanningEnergyBudget(room) - index.getOutgoing(room.name, RESOURCE_ENERGY) -
        (feeReserved.get(room.name) || 0)),
    };
  });
  const pairs = candidates.flatMap(source => candidates.filter(target => source !== target &&
    source.surplus >= MIN_BATCH && target.deficit >= MIN_BATCH).map(target => ({ source, target,
    distance: Game.map.getRoomLinearDistance(source.room.name, target.room.name) })));
  pairs.sort((a, b) => a.target.available - b.target.available || a.distance - b.distance ||
    b.source.surplus - a.source.surplus || a.source.room.name.localeCompare(b.source.room.name) ||
    a.target.room.name.localeCompare(b.target.room.name));
  let published = 0;
  for (const { source, target } of pairs) {
    if (published >= MAX_NEW_TASKS) break;
    let low = 0;
    let high = Math.floor(Math.min(source.surplus, target.deficit, target.capacity));
    while (low < high) {
      const next = Math.ceil((low + high) / 2);
      if (Game.market.calcTransactionCost(next, source.room.name, target.room.name) <= source.feeEnergy) low = next;
      else high = next - 1;
    }
    if (low < MIN_BATCH) continue;
    const result = createAutomaticResourceTransferTask(source.room.name, target.room.name, RESOURCE_OPS, low, POWER_CREEP_OPS_SUPPLY_REASON);
    if (typeof result === "string") continue;
    published++;
    source.surplus -= low;
    source.feeEnergy -= Game.market.calcTransactionCost(low, source.room.name, target.room.name);
    target.deficit -= low;
    target.capacity -= low;
  }
}
