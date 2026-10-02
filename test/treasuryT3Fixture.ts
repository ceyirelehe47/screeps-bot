import { BUILD_INFO } from "@/buildMeta";
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { resetTreasuryCoreLifecycleFactsForTest } from "@/runtime/treasury/kernel/kernel";
import { clearMarketActionArbiterForTest } from "@/runtime/marketActionArbiter";
import { treasuryTaskCommitmentView } from "@/runtime/treasuryTaskCommitmentBridge";
import { ReceiverCapacityLedger } from "@/runtime/logistics/receiverCapacityLedger";
import { clearMarketSaleExposureReservationsForTest } from "@/runtime/marketSaleExposure";
import { clearLocalCarrierDestinationCapacityForTest } from "@/runtime/localCarrierDestinationCapacity";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { treasuryT3CommittedOutgoingForLocation } from "@/runtime/treasuryT3LocationCommitments";

export const T3_SOURCE = "E4N58";
export const T3_TARGET = "E1N57";
export const T3_CAPACITY = 300_000;
export type T3MutableStore = StoreDefinition & Partial<Record<ResourceConstant, number>>;

export function t3Store(amounts: Partial<Record<ResourceConstant, number>>, capacity = T3_CAPACITY): T3MutableStore {
  const store = { ...amounts } as T3MutableStore;
  Object.defineProperties(store, {
    getUsedCapacity: { value(resource?: ResourceConstant) {
      return resource ? store[resource] ?? 0
        : Object.values(store).reduce((total, value) => total + (typeof value === "number" ? value : 0), 0);
    } },
    getFreeCapacity: { value() { return capacity - store.getUsedCapacity(); } },
    getCapacity: { value() { return capacity; } },
  });
  return store;
}

export function t3Room(name: string, amounts: Partial<Record<ResourceConstant, number>>): Room {
  const room = {
    name, controller: { my: true, level: 8, owner: { username: "forster" } }, find: () => [],
  } as unknown as Room;
  room.storage = {
    id: `${name}-storage`, room, structureType: STRUCTURE_STORAGE,
    store: t3Store({ [RESOURCE_ENERGY]: 100_000 }, 1_000_000),
  } as unknown as StructureStorage;
  room.terminal = {
    id: `${name}-terminal`, room, structureType: STRUCTURE_TERMINAL, my: true,
    owner: { username: "forster" }, isActive: () => true, cooldown: 0,
    store: t3Store(amounts), send: jest.fn(() => OK),
  } as unknown as StructureTerminal;
  return room;
}

export function t3Task(amount = 1715): ResourceTransferTask {
  return {
    id: "90:1:OH:E4N58->E1N57", resource: RESOURCE_HYDROXIDE,
    fromRoomName: T3_SOURCE, toRoomName: T3_TARGET, amount, remainingAmount: amount,
    status: "pending", origin: "automatic", reason: "synthesis:E1N57:UH2O",
    createdAt: 90, updatedAt: 90, lastProgressAt: 90,
  };
}

/** 默认目标剩余30产品，现有4 OH，真实缺口为26；任务大余量不能扩大首片。 */
export function initializeT3(amount = 1715, missing = 26, withLocationCommitments = true): {
  source: Room; target: Room; task: ResourceTransferTask; treasury: TreasuryService;
} {
  delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
  resetTreasuryCoreLifecycleFactsForTest(); clearMarketActionArbiterForTest();
  clearMarketSaleExposureReservationsForTest(); clearLocalCarrierDestinationCapacityForTest();
  (global as typeof global & { __DEPLOY_BUNDLE_HASH__?: string }).__DEPLOY_BUNDLE_HASH__ = "test-bundle";
  Game.time = 100; Game.shard = { name: "shard1" } as Game["shard"];
  Game.cpu = { getUsed: () => 0, tickLimit: 500, bucket: 10_000 } as Game["cpu"];
  const source = t3Room(T3_SOURCE, { [RESOURCE_HYDROXIDE]: 6000, [RESOURCE_KEANIUM]: 1800, [RESOURCE_ENERGY]: 10_000 });
  const productDeficit = Math.max(30, Math.ceil(missing / 5) * 5);
  const target = t3Room(T3_TARGET, {
    [RESOURCE_HYDROXIDE]: productDeficit - missing, [RESOURCE_UTRIUM_HYDRIDE]: 500,
    [RESOURCE_UTRIUM_ACID]: 2385 - productDeficit, [RESOURCE_KEANIUM]: 1800, [RESOURCE_ENERGY]: 2000,
  });
  Game.rooms = { [T3_SOURCE]: source, [T3_TARGET]: target }; Game.creeps = {}; Game.spawns = {};
  Game.getObjectById = jest.fn((id: string) => Object.values(Game.rooms)
    .flatMap((room) => [room.terminal, room.storage]).find((structure) => structure?.id === id) ?? null) as Game["getObjectById"];
  Game.market = {
    calcTransactionCost: jest.fn(() => 10), getAllOrders: jest.fn(() => []),
    deal: jest.fn(() => OK), incomingTransactions: [], outgoingTransactions: [],
  } as unknown as Market;
  const task = t3Task(amount);
  Memory.cfg = {
    treasuryTerminalTransferSlice0: { mode: "off" }, treasuryTerminalTransferT2: { mode: "off" },
    treasuryTerminalTransferT3: { mode: "off" }, synthesisControl: { enabled: true,
      rooms: { [T3_TARGET]: { enabled: true, reactions: [{ product: RESOURCE_UTRIUM_ACID,
        targetAmount: 2385, batchSize: 2500 }] } },
    },
  } as unknown as Memory["cfg"];
  Memory.data = { resourceControl: { tasks: { [task.id]: task } } } as unknown as Memory["data"];
  Memory.runtime = {
    lastDeployTag: BUILD_INFO.tag, lastDeployBundleHash: BUILD_INFO.bundleHash,
    synthesisControl: { updatedAt: 100, generatedTaskCount: 0, failedTaskCount: 0, successfulRunCount: 0,
      lastActions: [], bindings: {}, rooms: { [T3_TARGET]: { stage: "acquiring", activeProduct: RESOURCE_UTRIUM_ACID,
        reagentA: RESOURCE_UTRIUM_HYDRIDE, reagentB: RESOURCE_HYDROXIDE, targetAmount: 2385, batchSize: 2500,
        reagentLabIds: [], productLabIds: [], successfulRuns: 0, pendingTasks: 1, lastTransitionAt: 90,
      } },
    },
  } as Memory["runtime"];
  let treasury: TreasuryService;
  treasury = createTreasuryService({ getRooms: () => Object.values(Game.rooms), getTasks: () =>
    treasuryTaskCommitmentView(Memory.data?.resourceControl?.tasks ?? {}, treasury.kernelJournal().active),
    ...(withLocationCommitments ? { committedOutgoingForLocation: treasuryT3CommittedOutgoingForLocation } : {}),
  });
  return { source, target, task, treasury };
}

export function t3Ledger(target: Room, tasks: ResourceTransferTask[]): ReceiverCapacityLedger {
  return new ReceiverCapacityLedger({ receivers: [{ roomName: target.name,
    storageFreeCapacity: 900_000, terminalFreeCapacity: target.terminal!.store.getFreeCapacity(),
    getTerminalResourceFreeCapacity: () => target.terminal!.store.getFreeCapacity(), }],
    tasks, storageSafetyReserve: 0, terminalSafetyReserve: 0,
    isTaskEndpointValid: () => true, isTaskHealthy: () => true });
}

export function t3Receipt(source: Room, engineId = "engine-T3-unique"): Transaction {
  const send = (source.terminal!.send as jest.Mock).mock.calls[0];
  return { transactionId: engineId, time: Game.time, sender: { username: "forster" },
    recipient: { username: "forster" }, from: source.name, to: send[2],
    resourceType: send[0], amount: send[1], description: send[3] } as Transaction;
}

export function applyT3Stores(source: Room, target: Room): void {
  const send = (source.terminal!.send as jest.Mock).mock.calls[0];
  const sent = send[1] as number; const resource = send[0] as ResourceConstant;
  const quote = Game.market.calcTransactionCost(sent, source.name, target.name);
  const sourceStore = source.terminal!.store as T3MutableStore;
  const targetStore = target.terminal!.store as T3MutableStore;
  sourceStore[resource] = (sourceStore[resource] ?? 0) - sent;
  sourceStore[RESOURCE_ENERGY] = (sourceStore[RESOURCE_ENERGY] ?? 0) - quote;
  targetStore[resource] = (targetStore[resource] ?? 0) + sent;
}
