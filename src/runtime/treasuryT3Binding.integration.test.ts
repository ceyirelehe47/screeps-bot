import * as runtimeServices from "@/runtime/runtimeServices";
import { armTreasuryT3FirstLive, readTreasuryT3FirstLiveControl, treasuryT3FirstLiveAllows } from "@/runtime/treasuryT3FirstLiveControl";
import { armTreasuryT1FirstLive } from "@/runtime/treasuryT1FirstLiveControl";
import { armTreasuryT2FirstLive } from "@/runtime/treasuryT2FirstLiveControl";
import { TREASURY_T1_LANE, TREASURY_T2_LANE, TREASURY_T3_LANE, treasuryLaneWorkKey } from "@/runtime/treasuryTerminalLane";
import { decodeTreasuryT3DurableFacts } from "@/runtime/treasuryT3Facts";
import { beginTreasuryProductionTick, endTreasuryProductionTick, registerTreasuryProductionTerminalTransfer,
  runTreasuryTerminalTransferTask } from "@/runtime/treasuryTerminalTransfer";
import { hasTreasuryTerminalFence, treasuryTaskCommitmentView } from "@/runtime/treasuryTaskCommitmentBridge";
import { executeMarketDeal, executeTerminalSend } from "@/runtime/marketActionArbiter";
import { reserveProductionResourceForOwner } from "@/runtime/resourceReservation";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { createTreasuryService } from "@/runtime/treasury/facade";
import { treasuryT3CommittedOutgoingForLocation } from "@/runtime/treasuryT3LocationCommitments";
import * as coreStore from "@/runtime/treasury/kernel/store";
import { bumpTreasuryWorldSequence } from "@/runtime/treasury/observation";
import { initializeT3, t3Task, t3Room, t3Store, t3Ledger, t3Receipt, applyT3Stores,
  T3_SOURCE, T3_TARGET, T3MutableStore } from "../../test/treasuryT3Fixture";

describe("T3 OH真实补料首片与三lane责任", () => {
  let context: ReturnType<typeof initializeT3>;
  let serviceSpy: jest.SpyInstance;
  beforeAll(() => expect(registerTreasuryProductionTerminalTransfer()).toBe(true));
  beforeEach(() => {
    context = initializeT3();
    serviceSpy = jest.spyOn(runtimeServices, "getTreasuryService").mockReturnValue(context.treasury);
  });
  afterEach(() => { endTreasuryProductionTick(); serviceSpy.mockRestore(); });

  function run(): void {
    expect(beginTreasuryProductionTick()).toBe(true);
    runTreasuryTerminalTransferTask(context.task, t3Ledger(context.target,
      Object.values(Memory.data!.resourceControl!.tasks)), true, jest.fn());
  }
  function recover(count = 12): void {
    for (let n = 0; n < count; n += 1) { Game.time += 1; beginTreasuryProductionTick(); endTreasuryProductionTick(); }
  }
  function acknowledge(source: Room, target: Room, id: string): void {
    const receipt = t3Receipt(source, id); endTreasuryProductionTick(); applyT3Stores(source, target);
    Game.market.incomingTransactions = [receipt]; Game.market.outgoingTransactions = [receipt]; recover();
  }

  it("26 OH经单次native与两端和fee闭环，仅扣26且保持首片消耗", () => {
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26)).toEqual({ ok: true, reason: "armed" });
    expect(readTreasuryT3FirstLiveControl()).toMatchObject({ status: "valid", value: { maxSliceAmount: 26 } });
    run();
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
    const call = (context.source.terminal!.send as jest.Mock).mock.calls[0];
    expect(call.slice(0, 3)).toEqual([RESOURCE_HYDROXIDE, 26, T3_TARGET]);
    expect(call[3]).toMatch(/^treasury-T3-2026-10-02:/);
    expect(context.task.remainingAmount).toBe(1715);
    const record = context.treasury.kernelJournal().active[0];
    expect(record.identity.actionKind).toBe(TREASURY_T3_LANE.actionKind);
    expect(record.worstCase).toEqual(expect.arrayContaining([
      expect.objectContaining({ roomName: T3_SOURCE, resource: RESOURCE_HYDROXIDE, delta: -26 }),
      expect.objectContaining({ roomName: T3_SOURCE, resource: RESOURCE_ENERGY, delta: -10 }),
      expect.objectContaining({ roomName: T3_TARGET, resource: RESOURCE_HYDROXIDE, delta: 26 }),
    ]));
    const projected = treasuryTaskCommitmentView({ [context.task.id]: context.task }, context.treasury.kernelJournal().active);
    expect(projected[context.task.id].remainingAmount).toBe(1689);
    acknowledge(context.source, context.target, "T3-26-confirmed");
    expect(Memory.data!.resourceControl!.tasks[context.task.id]).toMatchObject({ remainingAmount: 1689, status: "pending" });
    expect((Memory.data!.resourceControl!.tasks[context.task.id] as ResourceTransferTask).treasurySlice).toBeUndefined();
    expect((Memory.runtime as unknown as Record<string, unknown>).treasuryProductionT3Quota)
      .toMatchObject({ status: "drained", amount: 26, taskId: context.task.id, runId: TREASURY_T3_LANE.runId });
    expect(hasTreasuryTerminalFence(T3_SOURCE)).toBe(false); expect(hasTreasuryTerminalFence(T3_TARGET)).toBe(false);
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(false);
    recover();
    expect(Memory.data!.resourceControl!.tasks[context.task.id].remainingAmount).toBe(1689);
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
  });

  it.each([[1, 100, 26, 1], [25, 100, 26, 25], [1715, 100, 26, 26],
    [1715, 10, 26, 10], [1715, 100, 200, 100], [1715, 26, 200, 26]])
  ("任务余量%i 请求%i 真实需求%i，仅授权%i OH", (pending, requested, missing, expected) => {
    context = initializeT3(pending, missing); serviceSpy.mockReturnValue(context.treasury);
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, requested).ok).toBe(true);
    run();
    expect((context.source.terminal!.send as jest.Mock).mock.calls[0].slice(0, 3))
      .toEqual([RESOURCE_HYDROXIDE, expected, T3_TARGET]);
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 101, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("拒绝不合法请求上限%s", (requested) => {
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, requested).ok).toBe(false);
    expect(readTreasuryT3FirstLiveControl().status).toBe("absent");
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it.each(["OH现货", "产品已达标", "健康其他incoming", "carrier cargo"])("真实需求被%s覆盖后不arm", (coverage) => {
    const target = context.target.terminal!.store as T3MutableStore;
    if (coverage === "OH现货") target[RESOURCE_HYDROXIDE] = 30;
    if (coverage === "产品已达标") target[RESOURCE_UTRIUM_ACID] = 2385;
    if (coverage === "健康其他incoming") {
      const incoming = { ...t3Task(26), id: "other-real-incoming" };
      Memory.data!.resourceControl!.tasks[incoming.id] = incoming;
    }
    if (coverage === "carrier cargo") {
      Game.creeps = { carrying: { name: "carrying", memory: {}, room: context.target,
        store: t3Store({ [RESOURCE_HYDROXIDE]: 26 }, 100) } as unknown as Creep };
    }
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(false);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it("native前需求缩到12，保持原26 durable事实并拒绝发送，不重发", () => {
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(true);
    const original = context.treasury.executeAuthorizedDispatch.bind(context.treasury);
    let originalFacts: unknown;
    const injection = jest.spyOn(context.treasury, "executeAuthorizedDispatch").mockImplementation((...args) => {
      const record = context.treasury.kernelJournal().active[0];
      originalFacts = record.identity.durableFacts!.payload;
      Game.creeps = { carrying: { name: "carrying", memory: {}, room: context.target,
        store: t3Store({ [RESOURCE_HYDROXIDE]: 14 }, 100) } as unknown as Creep };
      return original(...args);
    });
    try { run(); } finally { injection.mockRestore(); }
    const record = context.treasury.kernelJournal().active[0];
    expect(record.identity.durableFacts!.payload).toEqual(originalFacts);
    expect(decodeTreasuryT3DurableFacts(record.identity.durableFacts!.payload)).toMatchObject({ amount: 26 });
    expect(context.source.terminal!.send).not.toHaveBeenCalled(); endTreasuryProductionTick(); recover();
    expect(Memory.data!.resourceControl!.tasks[context.task.id].remainingAmount).toBe(1715);
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(false);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it.each([
    ["UH", { resource: RESOURCE_UTRIUM_HYDRIDE }], ["H", { resource: RESOURCE_HYDROGEN }],
    ["source", { fromRoomName: "E3N59" }], ["target", { toRoomName: "E3N59" }],
    ["manual", { origin: "manual" }], ["purpose", { reason: "synthesis:E1N57:UHO2" }],
    ["done", { status: "done" }], ["zero", { amount: 0, remainingAmount: 0 }],
  ])("拒绝%s业务重绑", (_label, change) => {
    Object.assign(context.task, change);
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(false);
    expect(readTreasuryT3FirstLiveControl().status).toBe("absent");
  });

  it.each(["createdAt", "amount", "remainingAmount", "sourceTerminal", "targetTerminal"])("arm后%s漂移不花授权", (field) => {
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(true);
    if (field === "sourceTerminal") Object.assign(context.source.terminal!, { id: "replacement-source" });
    else if (field === "targetTerminal") Object.assign(context.target.terminal!, { id: "replacement-target" });
    else context.task[field as "createdAt" | "amount" | "remainingAmount"] += 1;
    expect(treasuryT3FirstLiveAllows(context.task, 26)).toBe(false);
    beginTreasuryProductionTick();
    runTreasuryTerminalTransferTask(context.task, t3Ledger(context.target, [context.task]), true, jest.fn());
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it.each([TREASURY_T1_LANE, TREASURY_T2_LANE])("旧%s未闭环责任挡住独立OH授权", (lane) => {
    const runtime = Memory.runtime as unknown as Record<string, unknown>;
    const prior = { schemaVersion: 2, runId: lane.runId, status: "dispatching", taskId: "old-work",
      taskCreatedAt: 90, taskAmount: 100, workKey: treasuryLaneWorkKey(lane, "old-work"),
      attemptId: "old-attempt", amount: 100, reservedAtTick: 90 };
    runtime[lane.quotaKey] = prior;
    const before = JSON.stringify(prior);
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(false);
    expect(JSON.stringify(runtime[lane.quotaKey])).toBe(before);
  });

  it("T1和T2各自真实闭环后，旧quota保持消耗而T3只发26 OH", () => {
    const hSource = t3Room("E3N59", { [RESOURCE_HYDROGEN]: 1000, [RESOURCE_ENERGY]: 10_000 });
    Game.rooms[hSource.name] = hSource;
    const hTask = { ...t3Task(100), id: "old-H-settled", fromRoomName: hSource.name, toRoomName: T3_SOURCE,
      resource: RESOURCE_HYDROGEN, origin: "manual" as const, reason: undefined };
    Memory.data!.resourceControl!.tasks[hTask.id] = hTask;
    expect(armTreasuryT1FirstLive(hTask.id, hTask.createdAt).ok).toBe(true);
    expect(beginTreasuryProductionTick()).toBe(true);
    runTreasuryTerminalTransferTask(hTask, t3Ledger(context.source, [hTask]), true, jest.fn());
    acknowledge(hSource, context.source, "T1-prior-confirmed");
    const runtime = Memory.runtime as unknown as Record<string, unknown>;
    expect(runtime.treasuryProductionT1Quota).toMatchObject({ status: "drained" });
    const oldH = JSON.stringify(runtime.treasuryProductionT1Quota);
    const sourceStore = context.source.terminal!.store as T3MutableStore;
    const targetStore = context.target.terminal!.store as T3MutableStore;
    sourceStore[RESOURCE_UTRIUM_HYDRIDE] = 4000; targetStore[RESOURCE_UTRIUM_HYDRIDE] = 200;
    targetStore[RESOURCE_UTRIUM_ACID] = 1885;
    const uhTask = { ...t3Task(250), id: "old-UH-settled", resource: RESOURCE_UTRIUM_HYDRIDE };
    Memory.data!.resourceControl!.tasks[uhTask.id] = uhTask;
    expect(armTreasuryT2FirstLive(uhTask.id, uhTask.createdAt).ok).toBe(true);
    expect(beginTreasuryProductionTick()).toBe(true);
    runTreasuryTerminalTransferTask(uhTask, t3Ledger(context.target, [uhTask, context.task]), true, jest.fn());
    acknowledge(context.source, context.target, "T2-prior-confirmed");
    expect(runtime.treasuryProductionT2Quota).toMatchObject({ status: "drained" });
    const oldUH = JSON.stringify(runtime.treasuryProductionT2Quota);
    // 将已完成旧UH的测试native调用与T3调用独立计数；不清理任何durable状态。
    (context.source.terminal!.send as jest.Mock).mockClear();
    targetStore[RESOURCE_UTRIUM_HYDRIDE] = 500; targetStore[RESOURCE_UTRIUM_ACID] = 2355;
    expect(armTreasuryT1FirstLive(hTask.id, hTask.createdAt).ok).toBe(false);
    expect(armTreasuryT2FirstLive(uhTask.id, uhTask.createdAt).ok).toBe(false);
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(true);
    run();
    expect((context.source.terminal!.send as jest.Mock).mock.calls[0].slice(0, 3)).toEqual([RESOURCE_HYDROXIDE, 26, T3_TARGET]);
    expect(JSON.stringify(runtime.treasuryProductionT1Quota)).toBe(oldH);
    expect(JSON.stringify(runtime.treasuryProductionT2Quota)).toBe(oldUH);
  });

  it("OH source生产保护和原任务余量必须保留", () => {
    expect(reserveProductionResourceForOwner(T3_SOURCE, RESOURCE_HYDROXIDE, 4500,
      { kind: "logical-service", id: "synthesis:E4N58:OH", namespace: "synthesis" }, 100).status).toBe("ok");
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(false);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it("自然只stage26至terminal且887留Storage时，913任务可发26，余量保持887", () => {
    context = initializeT3(913); serviceSpy.mockReturnValue(context.treasury);
    (context.source.terminal!.store as T3MutableStore)[RESOURCE_HYDROXIDE] = 26;
    (context.source.storage!.store as T3MutableStore)[RESOURCE_HYDROXIDE] = 887;
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(true);
    run();
    expect((context.source.terminal!.send as jest.Mock).mock.calls[0].slice(0, 3)).toEqual([RESOURCE_HYDROXIDE, 26, T3_TARGET]);
    acknowledge(context.source, context.target, "T3-natural-staged26");
    expect(Memory.data!.resourceControl!.tasks[context.task.id].remainingAmount).toBe(887);
    expect((context.source.storage!.store as T3MutableStore)[RESOURCE_HYDROXIDE]).toBe(887);
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
  });

  it("位置hook只定位Terminal，自家887 room commitment与policy口径仍完整", () => {
    context = initializeT3(913); serviceSpy.mockReturnValue(context.treasury);
    (context.source.terminal!.store as T3MutableStore)[RESOURCE_HYDROXIDE] = 26;
    (context.source.storage!.store as T3MutableStore)[RESOURCE_HYDROXIDE] = 887;
    const checked: Array<{ room: number; located: number; pending: number }> = [];
    let service: ReturnType<typeof createTreasuryService>;
    service = createTreasuryService({ getRooms: () => Object.values(Game.rooms), getTasks: () =>
      treasuryTaskCommitmentView(Memory.data!.resourceControl!.tasks, service.kernelJournal().active),
      committedOutgoingForLocation: (request) => {
        const value = treasuryT3CommittedOutgoingForLocation(request);
        if (request.roomName === T3_SOURCE && request.resource === RESOURCE_HYDROXIDE && value !== undefined) {
          checked.push({ room: request.roomCommittedOutgoing, located: value,
            pending: request.commitments.pendingOutgoing(T3_SOURCE, RESOURCE_HYDROXIDE) });
          expect(treasuryT3CommittedOutgoingForLocation({ ...request, candidate: null })).toBeUndefined();
          expect(treasuryT3CommittedOutgoingForLocation({ ...request, locationKind: "storage" })).toBeUndefined();
          const candidate = request.candidate!;
          expect(treasuryT3CommittedOutgoingForLocation({ ...request, candidate: { ...candidate,
            identity: { ...candidate.identity, adapterSemanticIdentity: "foreign-adapter" } } })).toBeUndefined();
          expect(treasuryT3CommittedOutgoingForLocation({ ...request, observation: { ...request.observation,
            location: (room, kind) => kind === "storage" ? { ...request.observation.location(room, kind), exists: false }
              : request.observation.location(room, kind) } })).toBeUndefined();
          expect(treasuryT3CommittedOutgoingForLocation({ ...request, observation: { ...request.observation,
            amount: (room, kind, resource) => room === T3_SOURCE && kind === "storage" && resource === RESOURCE_HYDROXIDE
              ? 886 : request.observation.amount(room, kind, resource) } })).toBeUndefined();
          const cargoRoot = global as unknown as { __carrierTaskBoard?: unknown };
          const originalBoard = cargoRoot.__carrierTaskBoard;
          try {
            for (const badBoard of [{}, new Map([[T3_SOURCE, { byOwner: {} }]]),
              new Map([[T3_SOURCE, { byOwner: new Map([["owner", new Map([["skipped-raw-row", {}]])]]),
                revision: 0, nextPublishOrder: 1 }]])]) {
              cargoRoot.__carrierTaskBoard = badBoard;
              expect(treasuryT3CommittedOutgoingForLocation(request)).toBeUndefined();
            }
          } finally {
            if (originalBoard === undefined) delete cargoRoot.__carrierTaskBoard;
            else cargoRoot.__carrierTaskBoard = originalBoard;
          }
        }
        return value;
      },
    });
    context.treasury = service; serviceSpy.mockReturnValue(service);
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(true); run();
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
    expect(checked.length).toBeGreaterThanOrEqual(2);
    for (const row of checked) expect(row).toEqual({ room: 887, located: 0, pending: 887 });
    expect(service.commitments().pendingOutgoing(T3_SOURCE, RESOURCE_HYDROXIDE)).toBe(887);
  });

  it("缺位置hook继续旧保守门，不能借Storage证明绕过Terminal887扣减", () => {
    context = initializeT3(913, 26, false); serviceSpy.mockReturnValue(context.treasury);
    (context.source.terminal!.store as T3MutableStore)[RESOURCE_HYDROXIDE] = 26;
    (context.source.storage!.store as T3MutableStore)[RESOURCE_HYDROXIDE] = 887;
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(true); run();
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
    expect((Memory.runtime as unknown as Record<string, unknown>).treasuryProductionT3Quota).toBeUndefined();
    expect(context.task.remainingAmount).toBe(913);
  });

  it.each(["other-task", "production"])("Storage保留自家余量仍不能放掉%s独立terminal承诺", (commitment) => {
    context = initializeT3(913); serviceSpy.mockReturnValue(context.treasury);
    (context.source.terminal!.store as T3MutableStore)[RESOURCE_HYDROXIDE] = 26;
    (context.source.storage!.store as T3MutableStore)[RESOURCE_HYDROXIDE] = 1000;
    if (commitment === "production") {
      expect(reserveProductionResourceForOwner(T3_SOURCE, RESOURCE_HYDROXIDE, 1,
        { kind: "logical-service", id: "synthesis:E4N58:OH", namespace: "synthesis" }, 100).status).toBe("ok");
    } else {
      const third = t3Room("E5N59", { [RESOURCE_ENERGY]: 10_000 }); Game.rooms[third.name] = third;
      const other = { ...t3Task(1), id: "other-source-commitment", toRoomName: third.name,
        origin: "manual" as const, reason: undefined };
      Memory.data!.resourceControl!.tasks[other.id] = other;
    }
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(false);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it("Storage只有886不足以支持原913任务，不能因Terminal有26而arm", () => {
    context = initializeT3(913); serviceSpy.mockReturnValue(context.treasury);
    (context.source.terminal!.store as T3MutableStore)[RESOURCE_HYDROXIDE] = 26;
    (context.source.storage!.store as T3MutableStore)[RESOURCE_HYDROXIDE] = 886;
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(false);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it("admission后Storage backing被移动，native前复核拒绝而不修改26事实", () => {
    context = initializeT3(913); serviceSpy.mockReturnValue(context.treasury);
    (context.source.terminal!.store as T3MutableStore)[RESOURCE_HYDROXIDE] = 26;
    (context.source.storage!.store as T3MutableStore)[RESOURCE_HYDROXIDE] = 887;
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(true);
    const original = context.treasury.executeAuthorizedDispatch.bind(context.treasury);
    let durable: string;
    const injection = jest.spyOn(context.treasury, "executeAuthorizedDispatch").mockImplementation((...args) => {
      durable = context.treasury.kernelJournal().active[0].identity.durableFacts!.payload;
      (context.source.storage!.store as T3MutableStore)[RESOURCE_HYDROXIDE] = 886;
      return original(...args);
    });
    try { run(); } finally { injection.mockRestore(); }
    expect(context.treasury.kernelJournal().active[0].identity.durableFacts!.payload).toBe(durable);
    expect(context.source.terminal!.send).not.toHaveBeenCalled(); endTreasuryProductionTick(); recover();
    expect(Memory.data!.resourceControl!.tasks[context.task.id].remainingAmount).toBe(913);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it.each([T3_SOURCE, T3_TARGET])("ordinary先触碰%s端点，本tick不能arm", (endpoint) => {
    const third = t3Room("E5N59", { [RESOURCE_KEANIUM]: 1000, [RESOURCE_ENERGY]: 10_000 }); Game.rooms[third.name] = third;
    expect(executeTerminalSend({ terminal: Game.rooms[endpoint].terminal!, resourceType: RESOURCE_KEANIUM,
      amount: 1, transactionCost: 1, destinationRoomName: third.name, actor: "ordinary" })).toBe(OK);
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26))
      .toEqual({ ok: false, reason: "terminal_action_this_tick" });
  });

  it("T3已arm阻挡两端ordinary send/deal，第三房send正常", () => {
    const third = t3Room("E5N59", { [RESOURCE_KEANIUM]: 1000, [RESOURCE_ENERGY]: 10_000 });
    const fourth = t3Room("E6N59", { [RESOURCE_KEANIUM]: 0, [RESOURCE_ENERGY]: 10_000 });
    Game.rooms[third.name] = third; Game.rooms[fourth.name] = fourth;
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(true);
    for (const endpoint of [T3_SOURCE, T3_TARGET]) {
      expect(executeTerminalSend({ terminal: Game.rooms[endpoint].terminal!, resourceType: RESOURCE_KEANIUM,
        amount: 1, transactionCost: 1, destinationRoomName: third.name, actor: "ordinary" })).toBe(ERR_BUSY);
      expect(executeMarketDeal("ordinary", 1, endpoint, "ordinary", { orderType: ORDER_BUY,
        resourceType: RESOURCE_KEANIUM, orderRoomName: third.name })).toBe(ERR_BUSY);
    }
    expect(executeTerminalSend({ terminal: third.terminal!, resourceType: RESOURCE_KEANIUM,
      amount: 1, transactionCost: 1, destinationRoomName: fourth.name, actor: "ordinary" })).toBe(OK);
    expect(context.source.terminal!.send).not.toHaveBeenCalled(); expect(Game.market.deal).not.toHaveBeenCalled();
  });

  it("同端点clear共享一次core scan，world sequence和T3自己的quota变化各重扫", () => {
    const scan = jest.spyOn(coreStore, "readTreasuryCoreStoreHealth");
    try {
      for (let n = 0; n < 25; n += 1) expect(hasTreasuryTerminalFence(T3_TARGET)).toBe(false);
      expect(scan).toHaveBeenCalledTimes(1);
      bumpTreasuryWorldSequence();
      expect(hasTreasuryTerminalFence(T3_TARGET)).toBe(false); expect(scan).toHaveBeenCalledTimes(2);
      (Memory.runtime as unknown as Record<string, unknown>).treasuryProductionT3Quota = {
        schemaVersion: 2, runId: TREASURY_T3_LANE.runId, status: "reserved", taskId: context.task.id,
        taskCreatedAt: context.task.createdAt, taskAmount: context.task.amount,
        workKey: treasuryLaneWorkKey(TREASURY_T3_LANE, context.task.id),
        attemptId: "T3-own-same-tick", amount: 26, reservedAtTick: Game.time,
      };
      expect(hasTreasuryTerminalFence(T3_TARGET)).toBe(true); expect(scan).toHaveBeenCalledTimes(3);
      for (let n = 0; n < 25; n += 1) expect(hasTreasuryTerminalFence(T3_TARGET)).toBe(true);
      expect(scan).toHaveBeenCalledTimes(3);
      expect(context.source.terminal!.send).not.toHaveBeenCalled();
    } finally { scan.mockRestore(); }
  });

  it("共享core health读取throw时保守保持T3端点fence，不能抛崩tick", () => {
    const scan = jest.spyOn(coreStore, "readTreasuryCoreStoreHealth").mockImplementation(() => { throw Error("unreadable core"); });
    try {
      expect(() => hasTreasuryTerminalFence(T3_TARGET)).not.toThrow();
      expect(hasTreasuryTerminalFence(T3_TARGET)).toBe(true);
      expect(context.source.terminal!.send).not.toHaveBeenCalled();
    } finally { scan.mockRestore(); }
  });
});
