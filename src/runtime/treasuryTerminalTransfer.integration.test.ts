import * as runtimeServices from "@/runtime/runtimeServices";
import { BUILD_INFO } from "@/buildMeta";
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { treasuryTaskCommitmentView } from "@/runtime/treasuryTaskCommitmentBridge";
import { ReceiverCapacityLedger } from "@/runtime/logistics/receiverCapacityLedger";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { cleanupResourceTransferTaskStore } from "@/runtime/logistics/resourceTransferTasks";
import {
  beginTreasuryProductionTick,
  endTreasuryProductionTick,
  registerTreasuryProductionTerminalTransfer,
  runTreasuryTerminalTransferTask,
} from "@/runtime/treasuryTerminalTransfer";
import { clearMarketActionArbiterForTest, executeTerminalSend } from "@/runtime/marketActionArbiter";
import {
  armTreasuryT1FirstLive,
  heartbeatTreasuryT1FirstLive,
  readTreasuryT1FirstLiveControl,
} from "@/runtime/treasuryT1FirstLiveControl";
import { runResourceControl } from "@/runtime/resourceControl";

const sourceName = "E3N59";
const targetName = "E4N58";
const roomCapacity = 300_000;

function makeRoom(name: string, hydrogen: number, energy: number): Room {
  const store = { H: hydrogen, energy } as Record<string, number> & StoreDefinition;
  Object.defineProperties(store, {
    getUsedCapacity: { value(resource?: string) {
      return resource ? (this[resource] ?? 0) : this.H + this.energy;
    } },
    getFreeCapacity: { value() { return roomCapacity - this.H - this.energy; } },
    getCapacity: { value() { return roomCapacity; } },
  });
  const room = {
    name,
    controller: { my: true, level: 8, owner: { username: "forster" } },
    storage: {
      id: `${name}-storage`,
      store: {
        getUsedCapacity: (resource?: ResourceConstant) => resource === RESOURCE_ENERGY ? 100_000 : 0,
        getFreeCapacity: () => 900_000,
      },
    },
    find: () => [],
  } as unknown as Room;
  room.terminal = {
    id: `${name}-terminal`,
    room,
    structureType: STRUCTURE_TERMINAL,
    my: true,
    owner: { username: "forster" },
    isActive: () => true,
    cooldown: 0,
    store,
    send: jest.fn(() => OK),
  } as unknown as StructureTerminal;
  return room;
}

function makeTask(amount = 250): ResourceTransferTask {
  return {
    id: "existing-H-task",
    resource: RESOURCE_HYDROGEN,
    fromRoomName: sourceName,
    toRoomName: targetName,
    amount,
    remainingAmount: amount,
    status: "pending",
    origin: "manual",
    createdAt: 90,
    updatedAt: 90,
    lastProgressAt: 90,
  };
}

function makeLedger(target: Room, task: ResourceTransferTask): ReceiverCapacityLedger {
  return new ReceiverCapacityLedger({
    receivers: [{
      roomName: targetName,
      storageFreeCapacity: 300_000,
      terminalFreeCapacity: target.terminal!.store.getFreeCapacity(),
      getTerminalResourceFreeCapacity: () => target.terminal!.store.getFreeCapacity(),
    }],
    tasks: [task],
    storageSafetyReserve: 0,
    terminalSafetyReserve: 0,
    isTaskEndpointValid: () => true,
    isTaskHealthy: () => true,
  });
}

describe("production Treasury T1 real facade task path", () => {
  let treasury: TreasuryService;
  let serviceSpy: jest.SpyInstance;
  let source: Room;
  let target: Room;
  let task: ResourceTransferTask;

  beforeAll(() => {
    expect(registerTreasuryProductionTerminalTransfer()).toBe(true);
  });

  beforeEach(() => {
    clearMarketActionArbiterForTest();
    (global as typeof global & { __DEPLOY_BUNDLE_HASH__?: string }).__DEPLOY_BUNDLE_HASH__ = "test-bundle";
    Game.time = 100;
    Game.shard = { name: "shard1" } as Game["shard"];
    Game.cpu = { getUsed: () => 0, tickLimit: 500, bucket: 10_000 } as Game["cpu"];
    source = makeRoom(sourceName, 1000, 10000);
    target = makeRoom(targetName, 200, 2000);
    Game.rooms = { [sourceName]: source, [targetName]: target };
    Game.getObjectById = jest.fn((id: string) =>
      [source.terminal, target.terminal].find((terminal) => terminal?.id === id) ?? null,
    ) as Game["getObjectById"];
    Game.market = {
      calcTransactionCost: jest.fn(() => 10),
      getAllOrders: jest.fn(() => []),
      deal: jest.fn(() => OK),
      incomingTransactions: [],
      outgoingTransactions: [],
    } as unknown as Market;
    task = makeTask();
    Memory.cfg = { treasuryTerminalTransferSlice0: { mode: "off" } } as unknown as Memory["cfg"];
    Memory.data = { resourceControl: { tasks: { [task.id]: task } } } as unknown as Memory["data"];
    Memory.runtime = { lastDeployTag: BUILD_INFO.tag,
      lastDeployBundleHash: BUILD_INFO.bundleHash, resourceReservations: {
      "E1N57:H:synthesis:E1N57:H": {
        roomName: "E1N57", resource: RESOURCE_HYDROGEN,
        holderId: "synthesis:E1N57:H", amount: 50, updatedAt: 90, expiresAt: 200,
      },
    } } as Memory["runtime"];
    treasury = createTreasuryService({
      getRooms: () => [source, target],
      getTasks: () => treasuryTaskCommitmentView(
        Memory.data?.resourceControl?.tasks ?? {},
        treasury.kernelJournal().active,
      ),
    });
    serviceSpy = jest.spyOn(runtimeServices, "getTreasuryService").mockReturnValue(treasury);
  });

  afterEach(() => {
    serviceSpy.mockRestore();
  });

  it("sends one existing task slice and reduces remaining only after confirmed arrival", () => {
    const ledger = makeLedger(target, task);
    expect(armTreasuryT1FirstLive(task.id, task.createdAt)).toEqual({ ok: true, reason: "armed" });
    expect(beginTreasuryProductionTick()).toBe(true);
    const scheduled = jest.fn();
    const result = runTreasuryTerminalTransferTask(task, ledger, true, scheduled);
    expect(result).toEqual({ handled: true, status: "dispatch_unknown" });
    expect(source.terminal!.send).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveBeenCalledWith(100, 10);
    expect(task.remainingAmount).toBe(250);
    expect(treasury.kernelJournal().active[0]).toMatchObject({ phase: "outcome_unknown", outcome: "unknown" });
    expect((Memory.runtime as unknown as { resourceReservationsOwnerVersion?: number }).resourceReservationsOwnerVersion).toBe(4);

    const description = (source.terminal!.send as jest.Mock).mock.calls[0][3] as string;
    const transaction = {
      transactionId: "engine-generated-id",
      time: 100,
      sender: { username: "forster" }, recipient: { username: "forster" },
      from: sourceName, to: targetName,
      resourceType: RESOURCE_HYDROGEN, amount: 100, description,
    };
    endTreasuryProductionTick();
    (source.terminal!.store as unknown as { H: number; energy: number }).H -= 100;
    (source.terminal!.store as unknown as { H: number; energy: number }).energy -= 10;
    (target.terminal!.store as unknown as { H: number }).H += 100;
    Game.market.incomingTransactions = [transaction as unknown as Transaction];
    Game.market.outgoingTransactions = [transaction as unknown as Transaction];
    Game.time = 101;
    expect(beginTreasuryProductionTick()).toBe(true);
    expect(Memory.data?.resourceControl?.tasks[task.id].remainingAmount).toBe(150);
    expect(treasury.kernelJournal().active[0]).toMatchObject({ phase: "closing", outcome: "committed" });
    expect(source.terminal!.send).toHaveBeenCalledTimes(1);
    endTreasuryProductionTick();

    Memory.cfg = { treasuryTerminalTransferSlice0: { mode: "drain" } } as unknown as Memory["cfg"];
    for (let i = 0; i < 12 && treasury.kernelJournal().active.length > 0; i += 1) {
      Game.time += 1;
      beginTreasuryProductionTick();
      endTreasuryProductionTick();
    }
    expect(treasury.kernelJournal().active).toHaveLength(0);
    Memory.cfg = { treasuryTerminalTransferSlice0: { mode: "off" } } as unknown as Memory["cfg"];
    Game.time += 1;
    expect(beginTreasuryProductionTick()).toBe(true);
    const currentTask = Memory.data!.resourceControl!.tasks[task.id] as ResourceTransferTask;
    expect(runTreasuryTerminalTransferTask(currentTask, ledger, true, scheduled)).toEqual({ handled: false });
    expect(currentTask.treasurySlice).toBeUndefined();
    expect((Memory.runtime as unknown as { treasuryProductionT1Quota: { status: string } }).treasuryProductionT1Quota.status).toBe("drained");
    expect(currentTask.remainingAmount).toBe(150);
    expect(source.terminal!.send).toHaveBeenCalledTimes(1);
    endTreasuryProductionTick();
  });

  it("closes a 100 to 0 task from lifecycle after reset without a second send", () => {
    task = makeTask(100);
    Memory.data!.resourceControl!.tasks = { [task.id]: task };
    const ledger = makeLedger(target, task);
    expect(armTreasuryT1FirstLive(task.id, task.createdAt)).toEqual({ ok: true, reason: "armed" });
    expect(beginTreasuryProductionTick()).toBe(true);
    expect(runTreasuryTerminalTransferTask(task, ledger, true, jest.fn()).handled).toBe(true);
    expect(source.terminal!.send).toHaveBeenCalledTimes(1);
    const description = (source.terminal!.send as jest.Mock).mock.calls[0][3] as string;
    endTreasuryProductionTick();

    (source.terminal!.store as unknown as { H: number; energy: number }).H -= 100;
    (source.terminal!.store as unknown as { H: number; energy: number }).energy -= 10;
    (target.terminal!.store as unknown as { H: number }).H += 100;
    const transaction = {
      transactionId: "engine-generated-100", time: 100,
      sender: { username: "forster" }, recipient: { username: "forster" },
      from: sourceName, to: targetName,
      resourceType: RESOURCE_HYDROGEN, amount: 100, description,
    } as unknown as Transaction;
    Game.market.incomingTransactions = [transaction];
    Game.market.outgoingTransactions = [transaction];
    Game.time = 101;
    expect(beginTreasuryProductionTick()).toBe(true);
    expect(Memory.data!.resourceControl!.tasks[task.id]).toMatchObject({
      status: "done", remainingAmount: 0,
      treasurySlice: { phase: "closing", amount: 0, outcome: "committed" },
    });
    endTreasuryProductionTick();

    treasury = createTreasuryService({
      getRooms: () => [source, target],
      getTasks: () => treasuryTaskCommitmentView(
        Memory.data?.resourceControl?.tasks ?? {}, treasury.kernelJournal().active,
      ),
    });
    serviceSpy.mockReturnValue(treasury);
    Game.time = 102;
    expect(beginTreasuryProductionTick()).toBe(true);
    expect(Memory.data!.resourceControl!.tasks[task.id].remainingAmount).toBe(0);
    expect(source.terminal!.send).toHaveBeenCalledTimes(1);
    endTreasuryProductionTick();
    expect(cleanupResourceTransferTaskStore(new Set([sourceName, targetName]), 0)).toBe(0);

    Memory.cfg = { treasuryTerminalTransferSlice0: { mode: "off" } } as unknown as Memory["cfg"];
    const currentTask = () => Memory.data!.resourceControl!.tasks[task.id] as ResourceTransferTask;
    for (let i = 0; i < 15 && currentTask().treasurySlice; i += 1) {
      Game.time += 1;
      expect(beginTreasuryProductionTick()).toBe(true);
      endTreasuryProductionTick();
    }
    expect(Memory.data!.resourceControl!.tasks[task.id]).toMatchObject({ status: "done", remainingAmount: 0 });
    expect(currentTask().treasurySlice).toBeUndefined();
    expect((Memory.runtime as unknown as { treasuryProductionT1Quota: { status: string } }).treasuryProductionT1Quota.status).toBe("drained");
    expect(source.terminal!.send).toHaveBeenCalledTimes(1);
    expect(cleanupResourceTransferTaskStore(new Set([sourceName, targetName]), 0)).toBe(1);
  });

  it("retains an unknown native attempt across a new service and OFF", () => {
    const ledger = makeLedger(target, task);
    expect(armTreasuryT1FirstLive(task.id, task.createdAt)).toEqual({ ok: true, reason: "armed" });
    expect(beginTreasuryProductionTick()).toBe(true);
    expect(runTreasuryTerminalTransferTask(task, ledger, true, jest.fn())).toMatchObject({
      handled: true, status: "dispatch_unknown",
    });
    expect(source.terminal!.send).toHaveBeenCalledTimes(1);
    endTreasuryProductionTick();

    // Rebuild the facade from persisted Memory while no engine transaction or
    // physical arrival exists. The old heap's dispatch permit is not reused.
    Game.time = 101;
    treasury = createTreasuryService({
      getRooms: () => [source, target],
      getTasks: () => treasuryTaskCommitmentView(
        Memory.data?.resourceControl?.tasks ?? {}, treasury.kernelJournal().active,
      ),
    });
    serviceSpy.mockReturnValue(treasury);
    expect(beginTreasuryProductionTick()).toBe(true);
    expect(Memory.data?.resourceControl?.tasks[task.id].remainingAmount).toBe(250);
    expect(treasury.kernelJournal().active[0]).toMatchObject({ phase: "outcome_unknown", outcome: "unknown" });
    expect(runTreasuryTerminalTransferTask(task, ledger, true, jest.fn()).handled).toBe(true);
    expect(source.terminal!.send).toHaveBeenCalledTimes(1);
    endTreasuryProductionTick();

    Memory.cfg = { treasuryTerminalTransferSlice0: { mode: "off" } } as unknown as Memory["cfg"];
    Game.time = 102;
    expect(beginTreasuryProductionTick()).toBe(true);
    expect(runTreasuryTerminalTransferTask(task, ledger, true, jest.fn()).handled).toBe(true);
    expect(source.terminal!.send).toHaveBeenCalledTimes(1);
    endTreasuryProductionTick();
  });

  it("reaches the same bounded native send through the production resourceControl entry", () => {
    Memory.cfg = {
      treasuryTerminalTransferSlice0: { mode: "off" },
      resourceControl: { sampleInterval: 10, market: { enabled: false } },
    } as unknown as Memory["cfg"];
    expect(armTreasuryT1FirstLive(task.id, task.createdAt)).toEqual({ ok: true, reason: "armed" });
    expect(beginTreasuryProductionTick()).toBe(true);

    runResourceControl();

    expect(source.terminal!.send).toHaveBeenCalledTimes(1);
    expect((source.terminal!.send as jest.Mock).mock.calls[0].slice(0, 3)).toEqual([
      RESOURCE_HYDROGEN, 100, targetName,
    ]);
    expect(Memory.data?.resourceControl?.tasks[task.id].remainingAmount).toBe(250);
    expect(treasury.kernelJournal().active[0]).toMatchObject({ phase: "outcome_unknown" });
    endTreasuryProductionTick();
  });

  it.each([sourceName, targetName])(
    "rejects T1 in the production entry after a third-room send toward %s",
    (destinationRoomName) => {
      const third = makeRoom("E1N57", 1000, 10000);
      Game.rooms.E1N57 = third;
      expect(armTreasuryT1FirstLive(task.id, task.createdAt)).toEqual({ ok: true, reason: "armed" });
      expect(executeTerminalSend({
        terminal: third.terminal!, resourceType: RESOURCE_HYDROGEN,
        amount: 10, transactionCost: 1, destinationRoomName,
        actor: "resourceControl:ordinary",
      })).toBe(OK);
      expect(beginTreasuryProductionTick()).toBe(true);
      runResourceControl();
      expect(source.terminal!.send).not.toHaveBeenCalled();
      expect((Memory.runtime as unknown as { treasuryProductionT1Quota?: unknown })
        ?.treasuryProductionT1Quota).toBeUndefined();
      expect(task.remainingAmount).toBe(250);
      endTreasuryProductionTick();
    },
  );

  it("blocks third-room ingress to both endpoints after T1 admission and permits unrelated rooms", () => {
    Game.time = 120;
    const third = makeRoom("E1N57", 1000, 10000);
    Game.rooms.E1N57 = third;
    expect(armTreasuryT1FirstLive(task.id, task.createdAt)).toEqual({ ok: true, reason: "armed" });
    expect(beginTreasuryProductionTick()).toBe(true);
    runResourceControl();
    expect(source.terminal!.send).toHaveBeenCalledTimes(1);
    for (const destinationRoomName of [sourceName, targetName]) {
      expect(executeTerminalSend({ terminal: third.terminal!,
        resourceType: RESOURCE_HYDROGEN, amount: 10, transactionCost: 1,
        destinationRoomName, actor: "resourceControl:ordinary" })).toBe(ERR_BUSY);
    }
    expect(executeTerminalSend({ terminal: third.terminal!,
      resourceType: RESOURCE_HYDROGEN, amount: 10, transactionCost: 1,
      destinationRoomName: "E5N59", actor: "resourceControl:ordinary" })).toBe(OK);
    expect(third.terminal!.send).toHaveBeenCalledTimes(1);
    endTreasuryProductionTick();
  });

  it("does not admit after its fixed lease or deadline and cannot rearm", () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(now);
    try {
      expect(armTreasuryT1FirstLive(task.id, task.createdAt)).toEqual({ ok: true, reason: "armed" });
      const read = readTreasuryT1FirstLiveControl();
      expect(read.status).toBe("valid");
      clock.mockReturnValue(now + 60_001);
      expect(heartbeatTreasuryT1FirstLive()).toEqual({ ok: false, reason: "expired_or_consumed" });
      expect(beginTreasuryProductionTick()).toBe(true);
      expect(runTreasuryTerminalTransferTask(task, makeLedger(target, task), true, jest.fn()))
        .toEqual({ handled: true, status: "first_live_control_unavailable" });
      expect(source.terminal!.send).not.toHaveBeenCalled();
      expect(armTreasuryT1FirstLive(task.id, task.createdAt)).toEqual({ ok: false, reason: "already_used_or_unsettled" });
      endTreasuryProductionTick();
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps the original deadline through heartbeat and blocks identity or safety drift", () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(now);
    try {
      expect(armTreasuryT1FirstLive(task.id, task.createdAt).ok).toBe(true);
      const initial = readTreasuryT1FirstLiveControl();
      expect(initial.status).toBe("valid");
      clock.mockReturnValue(now + 30_000);
      expect(heartbeatTreasuryT1FirstLive()).toEqual({ ok: true, reason: "renewed" });
      const renewed = readTreasuryT1FirstLiveControl();
      expect(renewed.status).toBe("valid");
      if (initial.status !== "valid" || renewed.status !== "valid") throw Error("control missing");
      expect(renewed.value.deadlineTick).toBe(initial.value.deadlineTick);
      expect(renewed.value.deadlineMs).toBe(initial.value.deadlineMs);
      task.remainingAmount -= 1;
      expect(beginTreasuryProductionTick()).toBe(true);
      expect(runTreasuryTerminalTransferTask(task, makeLedger(target, task), true, jest.fn()))
        .toEqual({ handled: true, status: "first_live_control_unavailable" });
      expect(source.terminal!.send).not.toHaveBeenCalled();
      endTreasuryProductionTick();
    } finally {
      clock.mockRestore();
    }
  });

  it("does not enter native after the one-shot control mirror or CPU gate fails", () => {
    expect(armTreasuryT1FirstLive(task.id, task.createdAt).ok).toBe(true);
    Game.cpu = { getUsed: () => 0, tickLimit: 500, bucket: 1_999 } as Game["cpu"];
    expect(beginTreasuryProductionTick()).toBe(true);
    expect(runTreasuryTerminalTransferTask(task, makeLedger(target, task), true, jest.fn()))
      .toEqual({ handled: true, status: "first_live_control_unavailable" });
    endTreasuryProductionTick();
    Game.cpu = { getUsed: () => 0, tickLimit: 500, bucket: 10_000 } as Game["cpu"];
    (Memory.runtime as unknown as { treasuryT1FirstLiveControlMirror: { controlUntilMs: number } })
      .treasuryT1FirstLiveControlMirror.controlUntilMs -= 1;
    expect(readTreasuryT1FirstLiveControl().status).toBe("invalid");
    expect(armTreasuryT1FirstLive(task.id, task.createdAt).ok).toBe(false);
    expect(source.terminal!.send).not.toHaveBeenCalled();
  });

  it("keeps the 600 tick cutoff after reset even with a fresh wall-clock lease", () => {
    expect(armTreasuryT1FirstLive(task.id, task.createdAt).ok).toBe(true);
    Game.time = 700;
    expect(heartbeatTreasuryT1FirstLive()).toEqual({ ok: false, reason: "expired_or_consumed" });
    expect(beginTreasuryProductionTick()).toBe(true);
    expect(runTreasuryTerminalTransferTask(task, makeLedger(target, task), true, jest.fn()))
      .toEqual({ handled: true, status: "first_live_control_unavailable" });
    expect(source.terminal!.send).not.toHaveBeenCalled();
    endTreasuryProductionTick();
  });
});
