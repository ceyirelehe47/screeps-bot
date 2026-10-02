import { BUILD_INFO } from "@/buildMeta";
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { resetTreasuryCoreLifecycleFactsForTest } from "@/runtime/treasury/kernel/kernel";
import { clearMarketActionArbiterForTest } from "@/runtime/marketActionArbiter";
import { treasuryTaskCommitmentView } from "@/runtime/treasuryTaskCommitmentBridge";
import { ReceiverCapacityLedger } from "@/runtime/logistics/receiverCapacityLedger";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";

export const T2_SOURCE = "E4N58";
export const T2_TARGET = "E1N57";
export const T2_CAPACITY = 300_000;

export function t2Room(name: string, uh = 4000, energy = 10000): Room {
  const store = { UH: uh, H: 0, OH: 0, energy } as Record<string, number> & StoreDefinition;
  Object.defineProperties(store, {
    getUsedCapacity: { value(resource?: string) {
      return resource ? (this[resource] ?? 0) : this.UH + this.H + this.OH + this.energy;
    } },
    getFreeCapacity: { value() { return T2_CAPACITY - this.getUsedCapacity(); } },
    getCapacity: { value() { return T2_CAPACITY; } },
  });
  const room = {
    name, controller: { my: true, level: 8, owner: { username: "forster" } },
    storage: { id: `${name}-storage`, store: {
      getUsedCapacity: (resource?: string) => resource === RESOURCE_ENERGY ? 100000 : 0,
      getFreeCapacity: () => 900000,
    } }, find: () => [],
  } as unknown as Room;
  room.terminal = {
    id: `${name}-terminal`, room, structureType: STRUCTURE_TERMINAL, my: true,
    owner: { username: "forster" }, isActive: () => true, cooldown: 0, store,
    send: jest.fn(() => OK),
  } as unknown as StructureTerminal;
  return room;
}

export function t2Task(amount = 1715): ResourceTransferTask {
  return { id: "90:1:UH:E4N58->E1N57", resource: RESOURCE_UTRIUM_HYDRIDE,
    fromRoomName: T2_SOURCE, toRoomName: T2_TARGET, amount, remainingAmount: amount,
    status: "pending", origin: "automatic", reason: "synthesis:E1N57:UH2O",
    createdAt: 90, updatedAt: 90, lastProgressAt: 90 };
}

export function t2Ledger(target: Room, tasks: ResourceTransferTask[]): ReceiverCapacityLedger {
  return new ReceiverCapacityLedger({ receivers: [{ roomName: T2_TARGET,
    storageFreeCapacity: 300000, terminalFreeCapacity: target.terminal!.store.getFreeCapacity(),
    getTerminalResourceFreeCapacity: () => target.terminal!.store.getFreeCapacity(), }],
    tasks, storageSafetyReserve: 0, terminalSafetyReserve: 0,
    isTaskEndpointValid: () => true, isTaskHealthy: () => true });
}

export function initializeT2(amount = 1715): { source: Room; target: Room; task: ResourceTransferTask; treasury: TreasuryService } {
  resetTreasuryCoreLifecycleFactsForTest(); clearMarketActionArbiterForTest();
  (global as typeof global & { __DEPLOY_BUNDLE_HASH__?: string }).__DEPLOY_BUNDLE_HASH__ = "test-bundle";
  Game.time = 100; Game.shard = { name: "shard1" } as Game["shard"];
  Game.cpu = { getUsed: () => 0, tickLimit: 500, bucket: 10000 } as Game["cpu"];
  const source = t2Room(T2_SOURCE); const target = t2Room(T2_TARGET, 200, 2000);
  Game.rooms = { [T2_SOURCE]: source, [T2_TARGET]: target };
  Game.getObjectById = jest.fn((id: string) => Object.values(Game.rooms)
    .flatMap((room) => [room.terminal, room.storage]).find((structure) => structure?.id === id) ?? null) as Game["getObjectById"];
  Game.market = { calcTransactionCost: jest.fn(() => 10), getAllOrders: jest.fn(() => []),
    deal: jest.fn(() => OK), incomingTransactions: [], outgoingTransactions: [] } as unknown as Market;
  const task = t2Task(amount);
  Memory.cfg = { treasuryTerminalTransferSlice0: { mode: "off" },
    treasuryTerminalTransferT2: { mode: "off" }, synthesisControl: { enabled: true,
      rooms: { [T2_TARGET]: { enabled: true, reactions: [{ product: RESOURCE_UTRIUM_ACID, targetAmount: 5000, batchSize: 2500 }] } } },
  } as unknown as Memory["cfg"];
  Memory.data = { resourceControl: { tasks: { [task.id]: task } } } as unknown as Memory["data"];
  Memory.runtime = { lastDeployTag: BUILD_INFO.tag, lastDeployBundleHash: BUILD_INFO.bundleHash,
    synthesisControl: { updatedAt: 100, generatedTaskCount: 0, failedTaskCount: 0, successfulRunCount: 0,
      lastActions: [], bindings: {}, rooms: { [T2_TARGET]: { stage: "acquiring", activeProduct: RESOURCE_UTRIUM_ACID,
        reagentA: RESOURCE_UTRIUM_HYDRIDE, reagentB: RESOURCE_HYDROXIDE, targetAmount: 5000, batchSize: 2500,
        reagentLabIds: [], productLabIds: [], successfulRuns: 0, pendingTasks: 1, lastTransitionAt: 90,
      } } },
  } as Memory["runtime"];
  let treasury: TreasuryService;
  treasury = createTreasuryService({ getRooms: () => Object.values(Game.rooms), getTasks: () =>
    treasuryTaskCommitmentView(Memory.data?.resourceControl?.tasks ?? {}, treasury.kernelJournal().active) });
  return { source, target, task, treasury };
}

export function t2Receipt(source: Room, target: Room, engineId = "engine-T2-unique"): Transaction {
  const send = (source.terminal!.send as jest.Mock).mock.calls[0];
  return { transactionId: engineId, time: 100, sender: { username: "forster" },
    recipient: { username: "forster" }, from: T2_SOURCE, to: T2_TARGET,
    resourceType: RESOURCE_UTRIUM_HYDRIDE, amount: send[1], description: send[3] } as Transaction;
}

export function applyT2Stores(source: Room, target: Room): void {
  const sent = (source.terminal!.send as jest.Mock).mock.calls[0][1] as number;
  const quote = Game.market.calcTransactionCost(sent, T2_SOURCE, T2_TARGET);
  (source.terminal!.store as unknown as Record<string, number>).UH -= sent;
  (source.terminal!.store as unknown as Record<string, number>).energy -= quote;
  (target.terminal!.store as unknown as Record<string, number>).UH += sent;
}
