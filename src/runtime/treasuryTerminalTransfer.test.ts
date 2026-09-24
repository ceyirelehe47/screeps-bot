import { findTreasuryActionAdapter } from "@/runtime/treasury/actionContracts";
import {
  beginTreasuryProductionTick,
  registerTreasuryProductionTerminalTransfer,
  runTreasuryTerminalTransferTask,
} from "@/runtime/treasuryTerminalTransfer";
import { TREASURY_T1_ACTION_KIND, TREASURY_T1_RUN_ID } from "@/runtime/treasuryTaskCommitmentBridge";
import type { TreasuryActionReconcilerFacts } from "@/runtime/treasury/actionContracts";
import type { TreasuryObservationView } from "@/runtime/treasury/types";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import type { ReceiverCapacityLedger } from "@/runtime/logistics/receiverCapacityLedger";
import { encodeTreasuryT1DurableFacts, treasuryT1WorkKey } from "@/runtime/treasuryT1Facts";

const sourceRoom = "E3N59";
const targetRoom = "E4N58";
const contractId = "contract-T1-001";
const description = `treasury-T1-2026-09-24:${contractId}`;
const capacity = 100_000;

type TerminalAmounts = { hydrogen: number; energy: number };

function roomWithTerminal(name: string, amounts: TerminalAmounts): Room {
  const used = amounts.hydrogen + amounts.energy;
  const terminal = {
    id: `${name}-terminal`,
    my: true,
    owner: { username: "forster" },
    cooldown: 0,
    isActive: () => true,
    store: {
      getUsedCapacity: (resource?: ResourceConstant) =>
        resource === RESOURCE_HYDROGEN ? amounts.hydrogen
          : resource === RESOURCE_ENERGY ? amounts.energy : used,
      getFreeCapacity: () => capacity - used,
      getCapacity: () => capacity,
    },
  } as unknown as StructureTerminal;
  return {
    name,
    controller: { my: true, owner: { username: "forster" } },
    terminal,
  } as unknown as Room;
}

function reconcilerFacts(): TreasuryActionReconcilerFacts {
  return {
    actionKind: TREASURY_T1_ACTION_KIND,
    adapterVersion: 1,
    transactionId: contractId,
    postings: [
      { roomName: sourceRoom, locationKind: "terminal", resource: RESOURCE_HYDROGEN, delta: -100 },
      { roomName: sourceRoom, locationKind: "terminal", resource: RESOURCE_ENERGY, delta: -10 },
      { roomName: targetRoom, locationKind: "terminal", resource: RESOURCE_HYDROGEN, delta: 100 },
    ],
    durablePayload: encodeTreasuryT1DurableFacts({
      schemaVersion: 1,
      runId: TREASURY_T1_RUN_ID,
      taskId: "task-1",
      taskCreatedAt: 90,
      amount: 100,
      tick: 100,
      quote: 10,
      username: "forster",
      source: { id: `${sourceRoom}-terminal`, hydrogen: 1000, energy: 1000, used: 2000, free: 98000, capacity, cooldown: 0 },
      target: { id: `${targetRoom}-terminal`, hydrogen: 200, energy: 1000, used: 1200, free: 98800, capacity, cooldown: 0 },
    })!,
  };
}

function observation(): TreasuryObservationView {
  const snapshots = {
    [sourceRoom]: { hydrogen: 900, energy: 990, used: 1890, free: 98110 },
    [targetRoom]: { hydrogen: 300, energy: 1000, used: 1300, free: 98700 },
  };
  return {
    epoch: { observedAtTick: Game.time },
    isStale: () => false,
    location: (roomName: string) => ({
      exists: true,
      structureId: `${roomName}-terminal`,
      usedCapacity: snapshots[roomName as keyof typeof snapshots].used,
      freeCapacity: snapshots[roomName as keyof typeof snapshots].free,
    }),
    amount: (roomName: string, _kind: string, resource: string) =>
      snapshots[roomName as keyof typeof snapshots][resource === RESOURCE_HYDROGEN ? "hydrogen" : "energy"],
  } as unknown as TreasuryObservationView;
}

function transaction(serverId: string): Record<string, unknown> {
  return {
    transactionId: serverId,
    time: 100,
    sender: { username: "forster" },
    recipient: { username: "forster" },
    from: sourceRoom,
    to: targetRoom,
    resourceType: RESOURCE_HYDROGEN,
    amount: 100,
    description,
  };
}

describe("production Treasury terminal settlement", () => {
  beforeAll(() => {
    expect(registerTreasuryProductionTerminalTransfer()).toBe(true);
  });

  beforeEach(() => {
    Game.time = 101;
    Game.rooms = {
      [sourceRoom]: roomWithTerminal(sourceRoom, { hydrogen: 900, energy: 990 }),
      [targetRoom]: roomWithTerminal(targetRoom, { hydrogen: 300, energy: 1000 }),
    };
    (Game as Game & { market: Market }).market = {
      incomingTransactions: [transaction("server-generated-id")],
      outgoingTransactions: [transaction("server-generated-id")],
    } as unknown as Market;
  });

  it("keeps legacy task and reservation memory byte-for-byte when OFF", () => {
    const task = {
      id: "existing-task",
      fromRoomName: sourceRoom,
      toRoomName: targetRoom,
      resource: RESOURCE_HYDROGEN,
      amount: 250,
      remainingAmount: 250,
      status: "pending",
      createdAt: 80,
      updatedAt: 90,
    } as ResourceTransferTask;
    Memory.cfg = {};
    Memory.data = { resourceControl: { tasks: { [task.id]: task } } } as unknown as Memory["data"];
    Memory.runtime = {
      resourceReservations: {
        [`${sourceRoom}:H:legacy-holder`]: {
          roomName: sourceRoom,
          resource: RESOURCE_HYDROGEN,
          holderId: "legacy-holder",
          amount: 50,
          updatedAt: 90,
          expiresAt: 200,
        },
      },
    } as Memory["runtime"];
    const before = JSON.stringify(Memory);
    expect(beginTreasuryProductionTick()).toBe(false);
    expect(runTreasuryTerminalTransferTask(
      task,
      {} as ReceiverCapacityLedger,
      true,
      () => { throw new Error("OFF must not dispatch"); },
    )).toEqual({ handled: false });
    expect(JSON.stringify(Memory)).toBe(before);
  });

  it("does not hand a task back to legacy when only a dispatching quota survives", () => {
    const task = {
      id: "existing-task", fromRoomName: sourceRoom, toRoomName: targetRoom,
      resource: RESOURCE_HYDROGEN, amount: 100, remainingAmount: 100,
      status: "pending", origin: "manual", createdAt: 80, updatedAt: 90, lastProgressAt: 90,
    } as ResourceTransferTask;
    Memory.cfg = {};
    Memory.data = { resourceControl: { tasks: { [task.id]: task } } } as unknown as Memory["data"];
    Memory.runtime = { treasuryProductionT1Quota: {
      schemaVersion: 1, runId: TREASURY_T1_RUN_ID, status: "dispatching",
      taskId: task.id, workKey: treasuryT1WorkKey(task.id), attemptId: "tk1_lost",
      amount: 100, reservedAtTick: 100,
    } } as unknown as Memory["runtime"];
    expect(runTreasuryTerminalTransferTask(
      task, {} as ReceiverCapacityLedger, true,
      () => { throw new Error("unresolved quota must not dispatch"); },
    )).toEqual({ handled: true, status: "quota_unclosed" });
  });

  it("settles only after the engine's own transaction ID matches in both views", () => {
    const reconcile = findTreasuryActionAdapter(TREASURY_T1_ACTION_KIND)?.reconcile;
    expect(reconcile).toBeDefined();
    expect(reconcile!(reconcilerFacts(), observation())).toBe("observed_committed");

    (Game.market.outgoingTransactions as unknown as Record<string, unknown>[])[0].transactionId = "different-engine-id";
    expect(reconcile!(reconcilerFacts(), observation())).toBe("still_uncertain");
  });
});
