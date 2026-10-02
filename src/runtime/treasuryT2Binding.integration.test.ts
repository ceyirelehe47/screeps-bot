import * as runtimeServices from "@/runtime/runtimeServices";
import { armTreasuryT2FirstLive, treasuryT2FirstLiveAllows, readTreasuryT2FirstLiveControl } from "@/runtime/treasuryT2FirstLiveControl";
import { armTreasuryT1FirstLive, closeTreasuryT1FirstLive, readTreasuryT1FirstLiveControl } from "@/runtime/treasuryT1FirstLiveControl";
import { TREASURY_T1_RUN_ID, treasuryT1WorkKey } from "@/runtime/treasuryT1Facts";
import { TREASURY_T2_RUN_ID } from "@/runtime/treasuryT2Facts";
import { beginTreasuryProductionTick, endTreasuryProductionTick, registerTreasuryProductionTerminalTransfer,
  runTreasuryTerminalTransferTask } from "@/runtime/treasuryTerminalTransfer";
import { treasuryTaskCommitmentView, hasTreasuryTerminalFence } from "@/runtime/treasuryTaskCommitmentBridge";
import { ReceiverCapacityLedger } from "@/runtime/logistics/receiverCapacityLedger";
import { reserveProductionResourceForOwner } from "@/runtime/resourceReservation";
import { clearMarketSaleExposureReservationsForTest } from "@/runtime/marketSaleExposure";
import { executeTerminalSend } from "@/runtime/marketActionArbiter";
import { initializeT2, t2Task, t2Room, t2Ledger, t2Receipt, applyT2Stores,
  T2_SOURCE, T2_TARGET, T2_CAPACITY } from "../../test/treasuryT2Fixture";

describe("T2 UH exact business binding and shared commitments", () => {
  let context: ReturnType<typeof initializeT2>;
  let spy: jest.SpyInstance;
  beforeAll(() => { expect(registerTreasuryProductionTerminalTransfer()).toBe(true); });
  beforeEach(() => {
    clearMarketSaleExposureReservationsForTest(); context = initializeT2();
    spy = jest.spyOn(runtimeServices, "getTreasuryService").mockReturnValue(context.treasury);
  });
  afterEach(() => { spy.mockRestore(); });

  function send(): void {
    expect(beginTreasuryProductionTick()).toBe(true);
    runTreasuryTerminalTransferTask(context.task, t2Ledger(context.target,
      Object.values(Memory.data!.resourceControl!.tasks)), true, jest.fn());
  }
  function recover(ticks = 8): void {
    for (let i = 0; i < ticks; i += 1) { Game.time += 1; beginTreasuryProductionTick(); endTreasuryProductionTick(); }
  }

  it.each([1, 99, 100, 101, 1715])("sends only min(100, %i UH), then settles that exact slice once", (amount) => {
    context.task.amount = amount; context.task.remainingAmount = amount;
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt)).toEqual({ ok: true, reason: "armed" });
    send();
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
    const calls = (context.source.terminal!.send as jest.Mock).mock.calls;
    expect(calls[0].slice(0, 3)).toEqual([RESOURCE_UTRIUM_HYDRIDE, Math.min(amount, 100), T2_TARGET]);
    expect(calls[0][3]).toMatch(/^treasury-T2-2026-10-02:/);
    expect(context.task.remainingAmount).toBe(amount);
    const record = context.treasury.kernelJournal().active[0];
    expect(record.identity.actionKind).toBe("production.terminal-transfer.uh-synthesis.slice0");
    expect(record.worstCase).toEqual(expect.arrayContaining([
      expect.objectContaining({ roomName: T2_SOURCE, resource: RESOURCE_UTRIUM_HYDRIDE, delta: -Math.min(amount, 100) }),
      expect.objectContaining({ roomName: T2_SOURCE, resource: RESOURCE_ENERGY, delta: -10 }),
      expect.objectContaining({ roomName: T2_TARGET, resource: RESOURCE_UTRIUM_HYDRIDE, delta: Math.min(amount, 100) }),
    ]));
    endTreasuryProductionTick(); applyT2Stores(context.source, context.target);
    const receipt = t2Receipt(context.source, context.target);
    Game.market.incomingTransactions = [receipt]; Game.market.outgoingTransactions = [receipt];
    recover();
    expect(Memory.data!.resourceControl!.tasks[context.task.id]).toMatchObject({
      remainingAmount: amount - Math.min(amount, 100), status: amount <= 100 ? "done" : "pending",
    });
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
    expect((Memory.runtime as unknown as Record<string, unknown>).treasuryProductionT2Quota).toMatchObject({ status: "drained", runId: TREASURY_T2_RUN_ID });
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(false);
  });

  it.each([
    ["H", { resource: RESOURCE_HYDROGEN }], ["OH", { resource: RESOURCE_HYDROXIDE }],
    ["wrong source", { fromRoomName: "E3N59" }], ["wrong target", { toRoomName: "E3N59" }],
    ["manual origin", { origin: "manual" }], ["other synthesis", { reason: "synthesis:E1N57:UHO2" }],
    ["missing reason", { reason: undefined }], ["done", { status: "done" }],
    ["zero", { amount: 0, remainingAmount: 0 }], ["unsafe amount", { amount: Number.MAX_SAFE_INTEGER + 1 }],
    ["unsafe remaining", { amount: Number.MAX_SAFE_INTEGER + 1, remainingAmount: Number.MAX_SAFE_INTEGER + 1 }],
  ])("refuses a %s binding before publishing a grant", (_label, change) => {
    Object.assign(context.task, change);
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(false);
    expect(readTreasuryT2FirstLiveControl().status).toBe("absent");
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it.each([
    ["resource", { resource: RESOURCE_HYDROGEN }], ["route", { toRoomName: "E3N59" }],
    ["origin", { origin: "manual" }], ["reason", { reason: "synthesis:E1N57:OH" }],
    ["identity", { createdAt: 91 }], ["amount", { amount: 1716 }],
    ["remaining", { remainingAmount: 1714 }],
  ])("does not spend an existing grant after bound %s facts drift", (_label, change) => {
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(true);
    Object.assign(context.task, change);
    expect(treasuryT2FirstLiveAllows(context.task, 100)).toBe(false);
    beginTreasuryProductionTick();
    runTreasuryTerminalTransferTask(context.task, t2Ledger(context.target, [context.task]), true, jest.fn());
    endTreasuryProductionTick();
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(false);
  });

  it("cannot authorize another task or the H grant by actor/run name", () => {
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(true);
    const other = { ...t2Task(), id: "other-real-task" };
    Memory.data!.resourceControl!.tasks[other.id] = other;
    expect(treasuryT2FirstLiveAllows(other, 100)).toBe(false);
    expect(armTreasuryT1FirstLive(other.id, other.createdAt).ok).toBe(false);
    send();
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
    const quota = (Memory.runtime as unknown as Record<string, unknown>).treasuryProductionT2Quota;
    expect(quota).toMatchObject({ taskId: context.task.id });
    expect((Memory.runtime as unknown as Record<string, unknown>).treasuryProductionT1Quota).toBeUndefined();
    endTreasuryProductionTick();
  });

  it.each([RESOURCE_UTRIUM_HYDRIDE, RESOURCE_HYDROGEN])("does not grant native authority to a caller-supplied actor for %s", (resource) => {
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(true);
    expect(executeTerminalSend({ terminal: context.source.terminal!, resourceType: resource, amount: 100,
      transactionCost: 10, destinationRoomName: T2_TARGET, actor: `treasury:${TREASURY_T2_RUN_ID}` })).toBe(ERR_BUSY);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
    expect((Memory.runtime as unknown as Record<string, unknown>).treasuryProductionT2Quota).toBeUndefined();
  });

  it.each(["reserved", "dispatching", "invalid", "drained-without-closure"])("cannot bypass old H %s responsibility with a new T2 run", (state) => {
    const runtime = Memory.runtime as unknown as Record<string, unknown>;
    runtime.treasuryProductionT1Quota = state === "invalid" ? {} : {
      schemaVersion: 2, runId: TREASURY_T1_RUN_ID, status: state === "drained-without-closure" ? "drained" : state,
      taskId: "old-H", taskCreatedAt: 10, taskAmount: 100,
      workKey: treasuryT1WorkKey("old-H"), attemptId: "old-attempt", amount: 100, reservedAtTick: 20,
    };
    const before = JSON.stringify(runtime.treasuryProductionT1Quota);
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(false);
    expect(JSON.stringify(runtime.treasuryProductionT1Quota)).toBe(before);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it("does not treat a damaged old H control as absent while binding T2", () => {
    const runtime = Memory.runtime as unknown as Record<string, unknown>;
    runtime.treasuryT1FirstLiveControlMirror = {};
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(false);
    expect(runtime.treasuryT1FirstLiveControlMirror).toEqual({});
    expect(readTreasuryT2FirstLiveControl().status).toBe("absent");
  });

  it("keeps a genuinely settled H quota consumed while granting the independent UH lane", () => {
    const oldSource = t2Room("E3N59", 0); Game.rooms[oldSource.name] = oldSource;
    (oldSource.terminal!.store as unknown as Record<string, number>).H = 1000;
    const hTask = { ...t2Task(100), id: "old-H-task", fromRoomName: oldSource.name, toRoomName: T2_SOURCE,
      resource: RESOURCE_HYDROGEN, origin: "manual" as const, reason: undefined };
    Memory.data!.resourceControl!.tasks[hTask.id] = hTask;
    expect(armTreasuryT1FirstLive(hTask.id, hTask.createdAt).ok).toBe(true);
    expect(beginTreasuryProductionTick()).toBe(true);
    const hLedger = new ReceiverCapacityLedger({ receivers: [{ roomName: T2_SOURCE,
      storageFreeCapacity: 900000, terminalFreeCapacity: context.source.terminal!.store.getFreeCapacity(),
      getTerminalResourceFreeCapacity: () => context.source.terminal!.store.getFreeCapacity() }],
      tasks: [hTask], storageSafetyReserve: 0, terminalSafetyReserve: 0,
      isTaskEndpointValid: () => true, isTaskHealthy: () => true });
    runTreasuryTerminalTransferTask(hTask, hLedger, true, jest.fn());
    expect(oldSource.terminal!.send).toHaveBeenCalledTimes(1);
    const description = (oldSource.terminal!.send as jest.Mock).mock.calls[0][3];
    endTreasuryProductionTick();
    (oldSource.terminal!.store as unknown as Record<string, number>).H -= 100;
    (oldSource.terminal!.store as unknown as Record<string, number>).energy -= 10;
    (context.source.terminal!.store as unknown as Record<string, number>).H += 100;
    const tx = { transactionId: "engine-H-prior", time: 100, sender: { username: "forster" }, recipient: { username: "forster" },
      from: oldSource.name, to: T2_SOURCE, resourceType: RESOURCE_HYDROGEN, amount: 100, description } as Transaction;
    Game.market.incomingTransactions = [tx]; Game.market.outgoingTransactions = [tx]; recover();
    const runtime = Memory.runtime as unknown as Record<string, unknown>;
    expect(runtime.treasuryProductionT1Quota).toMatchObject({ status: "drained", runId: TREASURY_T1_RUN_ID });
    const oldQuota = JSON.stringify(runtime.treasuryProductionT1Quota);
    expect(armTreasuryT1FirstLive(hTask.id, hTask.createdAt).ok).toBe(false);
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(true); send();
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(runtime.treasuryProductionT1Quota)).toBe(oldQuota);
    expect(runtime.treasuryProductionT2Quota).toMatchObject({ runId: TREASURY_T2_RUN_ID, taskId: context.task.id });
    endTreasuryProductionTick();
  });

  it("excludes exactly 100 from the 1715 task, keeps 1615 committed and does not inherit a reused ID", () => {
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(true); send();
    const records = context.treasury.kernelJournal().active;
    const current = treasuryTaskCommitmentView({ [context.task.id]: context.task }, records);
    expect(current[context.task.id].remainingAmount).toBe(1615);
    expect(context.task.remainingAmount).toBe(1715);
    expect(context.treasury.commitments().pendingOutgoing(T2_SOURCE, RESOURCE_UTRIUM_HYDRIDE)).toBe(1615);
    expect(context.treasury.commitments().pendingIncoming(T2_TARGET, RESOURCE_UTRIUM_HYDRIDE)).toBe(1615);
    const replacement = { ...context.task, createdAt: 101, treasurySlice: undefined };
    expect(treasuryTaskCommitmentView({ [replacement.id]: replacement }, records)[replacement.id].remainingAmount).toBe(1715);
    endTreasuryProductionTick();
  });

  it.each([2285, 2286])("respects UH production ownership %i while keeping the 1615 remainder", (reserved) => {
    expect(reserveProductionResourceForOwner(T2_SOURCE, RESOURCE_UTRIUM_HYDRIDE, reserved,
      { kind: "logical-service", id: `synthesis:${T2_SOURCE}:UH`, namespace: "synthesis" }, 100).status).toBe("ok");
    const arm = armTreasuryT2FirstLive(context.task.id, context.task.createdAt);
    if (reserved === 2286) {
      expect(arm.ok).toBe(false); expect(context.source.terminal!.send).not.toHaveBeenCalled();
    } else {
      expect(arm.ok).toBe(true); send();
      expect(context.source.terminal!.send).toHaveBeenCalledTimes(1); endTreasuryProductionTick();
    }
  });

  it.each([1715, 1714])("respects target capacity %i for the work plus original remainder", (free) => {
    Memory.cfg!.resourceControl = { capacityBalancing: { storagePressureFreeCapacity: 0, terminalPressureFreeCapacity: 0 } };
    (context.target.terminal!.store as unknown as Record<string, number>).OH = T2_CAPACITY - 2000 - 200 - free;
    const arm = armTreasuryT2FirstLive(context.task.id, context.task.createdAt);
    if (free === 1714) { expect(arm.ok).toBe(false); }
    else { expect(arm.ok).toBe(true); send(); expect(context.source.terminal!.send).toHaveBeenCalledTimes(1); endTreasuryProductionTick(); }
  });

  it.each([101, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])("refuses invalid or above-budget fee %s", (fee) => {
    (Game.market.calcTransactionCost as jest.Mock).mockReturnValue(fee);
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(false);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it("rejects a new same-tick production reservation at admission", () => {
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(true);
    expect(beginTreasuryProductionTick()).toBe(true);
    // Build a snapshot first; the public writer's revision makes the mutation visible immediately.
    expect(context.treasury.commitments().reservedProduction(T2_SOURCE, RESOURCE_UTRIUM_HYDRIDE)).toBe(0);
    expect(reserveProductionResourceForOwner(T2_SOURCE, RESOURCE_UTRIUM_HYDRIDE, 3000,
      { kind: "logical-service", id: `synthesis:${T2_SOURCE}:UH`, namespace: "synthesis" }, 100).status).toBe("ok");
    runTreasuryTerminalTransferTask(context.task, t2Ledger(context.target, [context.task]), true, jest.fn());
    expect(context.source.terminal!.send).not.toHaveBeenCalled(); endTreasuryProductionTick();
  });

  it("rechecks source ownership after admission immediately before the native boundary", () => {
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(true);
    const original = context.treasury.executeAuthorizedDispatch.bind(context.treasury);
    const injection = jest.spyOn(context.treasury, "executeAuthorizedDispatch").mockImplementation((...args) => {
      expect(context.treasury.kernelJournal().active[0].phase).toBe("pending");
      expect(reserveProductionResourceForOwner(T2_SOURCE, RESOURCE_UTRIUM_HYDRIDE, 3000,
        { kind: "logical-service", id: `synthesis:${T2_SOURCE}:UH`, namespace: "synthesis" }, 100).status).toBe("ok");
      return original(...args);
    });
    try { send(); } finally { injection.mockRestore(); endTreasuryProductionTick(); }
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
    recover();
    expect(Memory.data!.resourceControl!.tasks[context.task.id].remainingAmount).toBe(1715);
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(false);
  });

  it("keeps the original admitted attempt across failed quota publication plus a foreign held lane before reset recovery", () => {
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(true);
    const runtime = Memory.runtime as unknown as Record<string, unknown>;
    Object.defineProperty(runtime, "treasuryProductionT2Quota", { configurable: true, enumerable: true,
      get: () => undefined, set: () => undefined });
    send();
    const record = context.treasury.kernelJournal().active[0];
    expect(record).toMatchObject({ phase: "pending", invocationBoundary: null });
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
    expect(runtime.treasuryProductionT2Quota).toBeUndefined();
    endTreasuryProductionTick(); delete runtime.treasuryProductionT2Quota;
    const oldQuota = { schemaVersion: 2, runId: TREASURY_T1_RUN_ID, status: "dispatching",
      taskId: "legacy-held-H", taskCreatedAt: 90, taskAmount: 100, workKey: treasuryT1WorkKey("legacy-held-H"),
      attemptId: "legacy-held-H-attempt", amount: 100, reservedAtTick: 99 };
    runtime.treasuryProductionT1Quota = oldQuota;
    const oldBytes = JSON.stringify(oldQuota);
    recover();
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
    expect(Memory.data!.resourceControl!.tasks[context.task.id].remainingAmount).toBe(1715);
    expect(context.treasury.kernelJournal().active).toHaveLength(0);
    expect(runtime.treasuryProductionT2Quota).toMatchObject({ status: "drained", attemptId: record.attemptId });
    expect(JSON.stringify(runtime.treasuryProductionT1Quota)).toBe(oldBytes);
    expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(false);
    expect(hasTreasuryTerminalFence(T2_SOURCE)).toBe(true);
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(false);
  });

  it("refuses native when an old closed H activity gains a valid unclosed quota after T2 admission", () => {
    const oldSource = t2Room("E3N59", 0); Game.rooms[oldSource.name] = oldSource;
    (oldSource.terminal!.store as unknown as Record<string, number>).H = 1000;
    const hTask = { ...t2Task(100), id: "closed-H-task", fromRoomName: oldSource.name, toRoomName: T2_SOURCE,
      resource: RESOURCE_HYDROGEN, origin: "manual" as const, reason: undefined };
    Memory.data!.resourceControl!.tasks[hTask.id] = hTask;
    expect(armTreasuryT1FirstLive(hTask.id, hTask.createdAt).ok).toBe(true);
    expect(closeTreasuryT1FirstLive("isolated_no_native_close").ok).toBe(true);
    expect(readTreasuryT1FirstLiveControl()).toMatchObject({ status: "valid", value: { status: "closed" } });
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(true);
    const original = context.treasury.executeAuthorizedDispatch.bind(context.treasury);
    const injection = jest.spyOn(context.treasury, "executeAuthorizedDispatch").mockImplementation((...args) => {
      (Memory.runtime as unknown as Record<string, unknown>).treasuryProductionT1Quota = {
        schemaVersion: 2, runId: TREASURY_T1_RUN_ID, status: "dispatching", taskId: hTask.id,
        taskCreatedAt: hTask.createdAt, taskAmount: 100, workKey: treasuryT1WorkKey(hTask.id),
        attemptId: "old-H-unclosed-attempt", amount: 100, reservedAtTick: 100,
      };
      return original(...args);
    });
    try { send(); } finally { injection.mockRestore(); endTreasuryProductionTick(); }
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
    expect(oldSource.terminal!.send).not.toHaveBeenCalled();
    expect(Memory.data!.resourceControl!.tasks[context.task.id].remainingAmount).toBe(1715);
    expect((Memory.runtime as unknown as Record<string, unknown>).treasuryProductionT1Quota).toMatchObject({ status: "dispatching" });
    recover();
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
    expect((Memory.runtime as unknown as Record<string, unknown>).treasuryProductionT2Quota).toMatchObject({ status: "drained" });
    expect((Memory.runtime as unknown as Record<string, unknown>).treasuryProductionT1Quota).toMatchObject({ status: "dispatching" });
    expect((Memory.data!.resourceControl!.tasks[context.task.id] as typeof context.task).treasurySlice).toBeUndefined();
    expect(Memory.data!.resourceControl!.tasks[context.task.id].remainingAmount).toBe(1715);
    expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(false);
    expect(hasTreasuryTerminalFence(T2_SOURCE)).toBe(true);
  });

  it.each([9980, 9981])("keeps Energy production ownership %i separate from UH and the remaining task fee", (reserved) => {
    expect(reserveProductionResourceForOwner(T2_SOURCE, RESOURCE_ENERGY, reserved,
      { kind: "logical-service", id: `synthesis:${T2_SOURCE}:energy`, namespace: "synthesis" }, 100).status).toBe("ok");
    const arm = armTreasuryT2FirstLive(context.task.id, context.task.createdAt);
    if (reserved === 9981) { expect(arm.ok).toBe(false); }
    else { expect(arm.ok).toBe(true); send(); expect(context.source.terminal!.send).toHaveBeenCalledTimes(1); endTreasuryProductionTick(); }
  });

  it("refuses a room-total fee budget that cannot satisfy the actual terminal ownership scope", () => {
    expect(reserveProductionResourceForOwner(T2_SOURCE, RESOURCE_ENERGY, 89980,
      { kind: "logical-service", id: `synthesis:${T2_SOURCE}:energy`, namespace: "synthesis" }, 100).status).toBe("ok");
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt)).toEqual({ ok: false, reason: "shared_fee_energy_protected" });
    expect(readTreasuryT2FirstLiveControl().status).toBe("absent");
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it.each(["resource", "fee"])("preserves active market %s exposure at admission", (kind) => {
    Memory.data = { ...Memory.data, marketSaleAutomation: { managedOrders: { sale: {
      roomName: T2_SOURCE, resourceType: kind === "resource" ? RESOURCE_UTRIUM_HYDRIDE : RESOURCE_ENERGY,
      remainingExposure: kind === "resource" ? 3901 : 9991,
    } } } } as unknown as Memory["data"];
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(false);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it("leaves both default-OFF lanes and legacy reservation bytes unchanged", () => {
    const before = JSON.stringify(Memory);
    expect(beginTreasuryProductionTick()).toBe(false);
    expect(runTreasuryTerminalTransferTask(context.task, t2Ledger(context.target, [context.task]), true,
      () => { throw Error("OFF must not schedule"); })).toEqual({ handled: false });
    endTreasuryProductionTick();
    expect(JSON.stringify(Memory)).toBe(before);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it("refuses the archived 1715 UH task when 1885 UH2O plus 500 reagent already covers target 2385", () => {
    Memory.cfg!.synthesisControl!.rooms![T2_TARGET].reactions![0].targetAmount = 2385;
    Memory.runtime!.synthesisControl!.rooms[T2_TARGET].targetAmount = 2385;
    (context.target.terminal!.store as unknown as Record<string, number>).UH = 0;
    const productLab = { id: "product-lab", structureType: STRUCTURE_LAB, mineralType: RESOURCE_UTRIUM_ACID,
      store: { getUsedCapacity: (resource?: string) => resource === RESOURCE_UTRIUM_ACID ? 1885 : 0 } };
    const reagentLab = { id: "reagent-lab", structureType: STRUCTURE_LAB, mineralType: RESOURCE_UTRIUM_HYDRIDE,
      store: { getUsedCapacity: (resource?: string) => resource === RESOURCE_UTRIUM_HYDRIDE ? 500 : 0 } };
    context.target.find = jest.fn(() => [productLab, reagentLab]) as Room["find"];
    const before = JSON.stringify(context.task);
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(false);
    expect(readTreasuryT2FirstLiveControl().status).toBe("absent");
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
    expect(JSON.stringify(context.task)).toBe(before);
  });

  it("refuses duplicate UH supply when a different healthy inbound already covers the product deficit", () => {
    const third = t2Room("E5N59"); Game.rooms[third.name] = third;
    const incoming = { ...t2Task(2300), id: "other-UH-demand-inbound", fromRoomName: third.name };
    Memory.data!.resourceControl!.tasks[incoming.id] = incoming;
    const before = JSON.stringify(Memory.data!.resourceControl!.tasks);
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(false);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
    expect(JSON.stringify(Memory.data!.resourceControl!.tasks)).toBe(before);
  });

  it.each(["missing transaction", "different engine ID", "duplicate", "resource", "route", "amount",
    "tick", "description", "source extra UH", "target foreign energy"])
  ("keeps the original unknown attempt for %s evidence and never decrements or retries", (failure) => {
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(true); send();
    const attempt = context.treasury.kernelJournal().active[0].attemptId;
    endTreasuryProductionTick(); applyT2Stores(context.source, context.target);
    const incoming = t2Receipt(context.source, context.target);
    const outgoing = { ...incoming };
    if (failure === "different engine ID") outgoing.transactionId = "conflicting-engine-id";
    if (failure === "resource") outgoing.resourceType = RESOURCE_HYDROGEN;
    if (failure === "route") outgoing.from = "E3N59";
    if (failure === "amount") outgoing.amount = 99;
    if (failure === "tick") outgoing.time = 99;
    if (failure === "description") outgoing.description = "ordinary:unrelated";
    Game.market.incomingTransactions = failure === "missing transaction" ? [] : [incoming];
    Game.market.outgoingTransactions = failure === "missing transaction" ? [] : [outgoing];
    if (failure === "duplicate") {
      Game.market.incomingTransactions.push({ ...incoming, transactionId: "second-engine-id" });
      Game.market.outgoingTransactions.push({ ...outgoing, transactionId: "second-engine-id" });
    }
    if (failure === "source extra UH") (context.source.terminal!.store as unknown as Record<string, number>).UH += 1;
    if (failure === "target foreign energy") (context.target.terminal!.store as unknown as Record<string, number>).energy += 1;
    recover(4);
    expect(Memory.data!.resourceControl!.tasks[context.task.id].remainingAmount).toBe(1715);
    expect(context.treasury.kernelJournal().active[0]).toMatchObject({ attemptId: attempt, outcome: "unknown" });
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(false);
  });

  it.each([undefined, NaN, 1, -999, "0"])("keeps an actually executed malformed native return %s unknown until original evidence settles", (result) => {
    (context.source.terminal!.send as jest.Mock).mockImplementation((resource: ResourceConstant, amount: number, destination: string, description: string) => {
      (context.source.terminal!.store as unknown as Record<string, number>).UH -= amount;
      (context.source.terminal!.store as unknown as Record<string, number>).energy -= 10;
      (context.target.terminal!.store as unknown as Record<string, number>).UH += amount;
      const tx = { transactionId: "engine-malformed-T2", time: 100, sender: { username: "forster" }, recipient: { username: "forster" },
        from: T2_SOURCE, to: destination, resourceType: resource, amount, description } as Transaction;
      Game.market.incomingTransactions = [tx]; Game.market.outgoingTransactions = [tx];
      return result;
    });
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(true); send();
    const attempt = context.treasury.kernelJournal().active[0].attemptId;
    expect(context.treasury.kernelJournal().active[0]).toMatchObject({ phase: "outcome_unknown", outcome: "unknown" });
    expect(context.task.remainingAmount).toBe(1715);
    expect((Memory.runtime as unknown as Record<string, unknown>).treasuryProductionT2Quota).toMatchObject({ status: "dispatching", attemptId: attempt });
    expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(true);
    endTreasuryProductionTick(); recover();
    expect(Memory.data!.resourceControl!.tasks[context.task.id].remainingAmount).toBe(1615);
    expect((Memory.runtime as unknown as Record<string, unknown>).treasuryProductionT2Quota).toMatchObject({ status: "drained", attemptId: attempt });
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
    expect(context.treasury.kernelJournal().ring).toEqual(expect.arrayContaining([expect.objectContaining({ attemptId: attempt, terminalPhase: "committed" })]));
    expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(false);
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(false);
  });

  it("preserves original H durable recovery when its real native effect returns undefined", () => {
    const oldSource = t2Room("E3N59", 0); Game.rooms[oldSource.name] = oldSource;
    (oldSource.terminal!.store as unknown as Record<string, number>).H = 1000;
    const hTask = { ...t2Task(100), id: "malformed-H-task", fromRoomName: oldSource.name, toRoomName: T2_SOURCE,
      resource: RESOURCE_HYDROGEN, origin: "manual" as const, reason: undefined };
    Memory.data!.resourceControl!.tasks[hTask.id] = hTask;
    (oldSource.terminal!.send as jest.Mock).mockImplementation((resource: ResourceConstant, amount: number, destination: string, description: string) => {
      (oldSource.terminal!.store as unknown as Record<string, number>).H -= amount;
      (oldSource.terminal!.store as unknown as Record<string, number>).energy -= 10;
      (context.source.terminal!.store as unknown as Record<string, number>).H += amount;
      const tx = { transactionId: "engine-malformed-H", time: 100, sender: { username: "forster" }, recipient: { username: "forster" },
        from: oldSource.name, to: destination, resourceType: resource, amount, description } as Transaction;
      Game.market.incomingTransactions = [tx]; Game.market.outgoingTransactions = [tx];
      return undefined;
    });
    expect(armTreasuryT1FirstLive(hTask.id, hTask.createdAt).ok).toBe(true); expect(beginTreasuryProductionTick()).toBe(true);
    const ledger = new ReceiverCapacityLedger({ receivers: [{ roomName: T2_SOURCE,
      storageFreeCapacity: 900000, terminalFreeCapacity: context.source.terminal!.store.getFreeCapacity(),
      getTerminalResourceFreeCapacity: () => context.source.terminal!.store.getFreeCapacity() }],
      tasks: [hTask], storageSafetyReserve: 0, terminalSafetyReserve: 0,
      isTaskEndpointValid: () => true, isTaskHealthy: () => true });
    runTreasuryTerminalTransferTask(hTask, ledger, true, jest.fn());
    const attempt = context.treasury.kernelJournal().active[0].attemptId;
    expect(context.treasury.kernelJournal().active[0]).toMatchObject({ outcome: "unknown" });
    expect(hTask.remainingAmount).toBe(100);
    expect(hasTreasuryTerminalFence(oldSource.name)).toBe(true);
    endTreasuryProductionTick(); recover();
    expect(Memory.data!.resourceControl!.tasks[hTask.id]).toMatchObject({ remainingAmount: 0, status: "done" });
    expect((Memory.runtime as unknown as Record<string, unknown>).treasuryProductionT1Quota).toMatchObject({ status: "drained", attemptId: attempt });
    expect(oldSource.terminal!.send).toHaveBeenCalledTimes(1);
    expect(context.task.remainingAmount).toBe(1715);
  });
});
