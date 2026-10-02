import { createTreasuryService, type TreasuryService, type TreasuryServiceDeps } from "@/runtime/treasury/facade";
import { treasuryTaskCommitmentView } from "@/runtime/treasuryTaskCommitmentBridge";
import { clearCarrierTaskBoardForTest } from "@/runtime/carrierTaskBoard";
import { clearCreepAssignmentStateForTest } from "@/runtime/creepAssignmentState";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { initializeT3, t3Ledger, t3Room, t3Store, type T3MutableStore } from "./treasuryT3Fixture";

export const T4_SOURCE = "E4N58";
export const T4_TARGET = "E1N57";
export type T4MutableStore = T3MutableStore;
export const t4Room = t3Room;
export const t4Store = t3Store;

export interface T4Fixture {
  source: Room;
  target: Room;
  task: ResourceTransferTask;
  treasury: TreasuryService;
  nativeTicks: number[];
  appliedCalls: Set<number>;
}

/** 真实缺口26，原任务913：发10后，903责任由887 Storage及16 Terminal分别支持。 */
export function initializeT4(
  locationHook: TreasuryServiceDeps["committedOutgoingForLocation"], amount = 913, missing = 26,
): T4Fixture {
  clearCarrierTaskBoardForTest(); clearCreepAssignmentStateForTest();
  const context = initializeT3(amount, missing, false);
  const oldId = context.task.id;
  context.task.id = "90:1:OH:E4N58->E1N57:T4";
  delete Memory.data!.resourceControl!.tasks[oldId];
  Memory.data!.resourceControl!.tasks[context.task.id] = context.task;
  (context.source.terminal!.store as T4MutableStore)[RESOURCE_HYDROXIDE] = Math.min(amount, Math.max(26, missing));
  (context.source.storage!.store as T4MutableStore)[RESOURCE_HYDROXIDE] = Math.max(0,
    amount - context.source.terminal!.store.getUsedCapacity(RESOURCE_HYDROXIDE));
  (Game.market.calcTransactionCost as jest.Mock).mockReturnValue(2);
  const nativeTicks: number[] = [];
  (context.source.terminal!.send as jest.Mock).mockImplementation(() => { nativeTicks.push(Game.time); return OK; });
  let treasury: TreasuryService;
  treasury = createTreasuryService({ getRooms: () => Object.values(Game.rooms), getTasks: () =>
    treasuryTaskCommitmentView(Memory.data!.resourceControl!.tasks, treasury.kernelJournal().active),
    ...(locationHook === undefined ? {} : { committedOutgoingForLocation: locationHook }),
  });
  return { ...context, treasury, nativeTicks, appliedCalls: new Set() };
}

export function t4Ledger(context: T4Fixture) {
  return t3Ledger(context.target, Object.values(Memory.data!.resourceControl!.tasks) as ResourceTransferTask[]);
}

/** 使用最后一次真实mock native的参数和tick，不回放第一片、不先扣task进度。 */
export function applyLatestT4Native(context: T4Fixture, engineId?: string): Transaction {
  const calls = (context.source.terminal!.send as jest.Mock).mock.calls;
  const index = calls.length - 1;
  if (index < 0 || context.appliedCalls.has(index)) throw Error("没有未应用的T4 native调用");
  const call = calls[index]; const amount = call[1] as number; const resource = call[0] as ResourceConstant;
  const fee = Game.market.calcTransactionCost(amount, context.source.name, context.target.name);
  const source = context.source.terminal!.store as T4MutableStore;
  const target = context.target.terminal!.store as T4MutableStore;
  source[resource] = (source[resource] ?? 0) - amount;
  source[RESOURCE_ENERGY] = (source[RESOURCE_ENERGY] ?? 0) - fee;
  target[resource] = (target[resource] ?? 0) + amount;
  context.appliedCalls.add(index);
  const receipt = { transactionId: engineId ?? `T4-engine-${index + 1}`, time: context.nativeTicks[index],
    sender: { username: "forster" }, recipient: { username: "forster" }, from: context.source.name,
    to: call[2], resourceType: resource, amount, description: call[3] } as Transaction;
  Game.market.incomingTransactions = [...Game.market.incomingTransactions, receipt];
  Game.market.outgoingTransactions = [...Game.market.outgoingTransactions, receipt];
  return receipt;
}

export function setT4Missing(context: T4Fixture, missing: number): void {
  const deficit = Math.max(30, Math.ceil(missing / 5) * 5);
  const target = context.target.terminal!.store as T4MutableStore;
  target[RESOURCE_UTRIUM_ACID] = 2385 - deficit;
  target[RESOURCE_HYDROXIDE] = deficit - missing;
}

export function t4CanonicalTask(context: T4Fixture): ResourceTransferTask {
  return Memory.data!.resourceControl!.tasks[context.task.id] as ResourceTransferTask;
}
