import { getTreasuryService } from "@/runtime/runtimeServices";
import { runSynthesisControl } from "@/runtime/synthesisControl";
import { enableTreasuryContinuousOH, enableTreasuryContinuousOHFromDemand, acceptTreasuryContinuousOHPilot,
  inspectTreasuryContinuousOHProcurement } from "@/runtime/treasuryContinuousOHControl";
import { readTreasuryContinuousOHState } from "@/runtime/treasuryContinuousOHState";
import { resetTreasuryCoreLifecycleFactsForTest } from "@/runtime/treasury/kernel/kernel";
import { beginTreasuryProductionTick, endTreasuryProductionTick, registerTreasuryProductionTerminalTransfer,
  runTreasuryTerminalTransferTask } from "@/runtime/treasuryTerminalTransfer";
import { reconcileResourceTransferTasks, type ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { initializeT4, applyLatestT4Native, t4CanonicalTask, t4Ledger, t4Store, setT4Missing,
  T4_SOURCE, T4_TARGET, type T4Fixture, type T4MutableStore } from "../../test/treasuryT4Fixture";

describe("T4真实synthesis producer采购桥接", () => {
  let context: T4Fixture;
  let clock: jest.SpyInstance;
  let enabledWall: number;
  beforeAll(() => expect(registerTreasuryProductionTerminalTransfer()).toBe(true));
  beforeEach(() => {
    enabledWall = Date.now(); clock = jest.spyOn(Date, "now").mockReturnValue(enabledWall);
    context = initializeT4(undefined); context.treasury = getTreasuryService();
  });
  afterEach(() => { endTreasuryProductionTick(); clock.mockRestore(); });

  function at(tick: number): void {
    Game.time = tick; clock.mockReturnValue(enabledWall + (tick - 100) * 1000);
  }
  function dispatch(tick: number, task = t4CanonicalTask(context)): void {
    at(tick); beginTreasuryProductionTick();
    const canonical = Memory.data!.resourceControl!.tasks[task.id] as ResourceTransferTask;
    try { runTreasuryTerminalTransferTask(canonical, t4Ledger(context), true, jest.fn()); }
    finally { endTreasuryProductionTick(); }
  }
  function state() {
    const read = readTreasuryContinuousOHState();
    if (read.status !== "valid") throw Error("T4持久状态无效");
    return read.value;
  }
  function releaseRealPilot(policy?: { rolling24hOH: number }): void {
    expect(enableTreasuryContinuousOH({ pilotTaskId: context.task.id,
      pilotTaskCreatedAt: context.task.createdAt, pilotTaskAmount: context.task.amount, policy }).ok).toBe(true);
    for (const tick of [100, 150, 200]) {
      dispatch(tick); applyLatestT4Native(context);
      for (let n = 1; n <= 12; n += 1) dispatch(tick + n);
    }
    expect((context.source.terminal!.send as jest.Mock).mock.calls.map((call) => call[1])).toEqual([10, 10, 6]);
    expect(t4CanonicalTask(context)).toMatchObject({ amount: 913, remainingAmount: 887, status: "cancelled" });
    expect(state()).toMatchObject({ sessionStatus: "pilot_complete_awaiting_release", currentCycle: null });
    expect(context.treasury.kernelJournal().active).toHaveLength(0);
    at(250); expect(acceptTreasuryContinuousOHPilot().ok).toBe(true);
    expect(state()).toMatchObject({ sessionStatus: "running", pilot: { releasedAtTick: 250 } });
  }
  function equipSynthesisLabs(): StructureLab[] {
    const labs = [1, 2, 3].map((index) => ({
      id: `${T4_TARGET}-lab-${index}`, room: context.target, structureType: STRUCTURE_LAB,
      pos: { x: 20 + index, y: 20, roomName: T4_TARGET, inRangeTo: () => true },
      store: t4Store({}), cooldown: 0, runReaction: jest.fn(() => OK),
    } as unknown as StructureLab));
    context.target.find = ((type: FindConstant, options?: { filter?: (structure: Structure) => boolean }) =>
      type === FIND_MY_STRUCTURES ? labs.filter((lab) => !options?.filter || options.filter(lab)) : []) as Room["find"];
    const originalLookup = Game.getObjectById;
    Game.getObjectById = jest.fn((id: string) => labs.find((lab) => lab.id === id) ?? originalLookup(id)) as Game["getObjectById"];
    return labs;
  }
  function producer(tick: number): void { at(tick); runSynthesisControl(); }
  function demandStartupFixture(stored = 913): string {
    expect(reconcileResourceTransferTasks({ automaticTaskNoProgressTtl: 0 })).toBe(1);
    expect(t4CanonicalTask(context)).toMatchObject({ status: "cancelled", amount: 913, remainingAmount: 913,
      reason: `synthesis:${T4_TARGET}:UH2O`, lastError: "automatic_no_progress_timeout" });
    (context.source.storage!.store as T4MutableStore)[RESOURCE_HYDROXIDE] = stored;
    (context.source.terminal!.store as T4MutableStore)[RESOURCE_HYDROXIDE] = 0;
    equipSynthesisLabs();
    return JSON.stringify(t4CanonicalTask(context));
  }
  function rebootService(): void {
    const root = global as unknown as { Memory: Memory; __runtimeServices?: unknown };
    root.Memory = JSON.parse(JSON.stringify(Memory)) as Memory;
    delete root.__runtimeServices; resetTreasuryCoreLifecycleFactsForTest();
    context.treasury = getTreasuryService();
  }
  function naturalTask(): ResourceTransferTask {
    const tasks = Object.values(Memory.data!.resourceControl!.tasks) as ResourceTransferTask[];
    const created = tasks.filter((task) => task.id !== context.task.id && task.status === "pending" &&
      task.resource === RESOURCE_HYDROXIDE && task.fromRoomName === T4_SOURCE && task.toRoomName === T4_TARGET);
    expect(created).toHaveLength(1);
    return created[0];
  }

  it.each([[887, 0], [0, 10]])("真实pilot闭环release后Storage=%i/Terminal=%i自然创建canonical automatic OH10", (stored, terminal) => {
    releaseRealPilot(); equipSynthesisLabs(); setT4Missing(context, 10);
    (context.source.storage!.store as T4MutableStore)[RESOURCE_HYDROXIDE] = stored;
    (context.source.terminal!.store as T4MutableStore)[RESOURCE_HYDROXIDE] = terminal;
    const before = Object.keys(Memory.data!.resourceControl!.tasks);
    producer(260);
    const task = naturalTask();
    expect(before).not.toContain(task.id);
    expect(Memory.data!.resourceControl!.tasks[task.id]).toBe(task);
    expect(Memory.data!.resourceControl!.taskSchemaVersion).toBe(2);
    expect(task).toMatchObject({ origin: "automatic", reason: `synthesis:${T4_TARGET}:UH2O`,
      amount: 10, remainingAmount: 10, createdAt: 260, status: "pending" });
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(3);
    expect(state().consumption.map((entry) => entry.amount)).toEqual([10, 10, 6]);
  });

  it("产品goal剩余5、OH lab已有4时，released后的Storage-only真实缺OH1并自然创建OH1", () => {
    releaseRealPilot();
    const labs = equipSynthesisLabs();
    const terminal = context.target.terminal!.store as T4MutableStore;
    terminal[RESOURCE_UTRIUM_ACID] = 2380; terminal[RESOURCE_HYDROXIDE] = 0;
    labs[1].mineralType = RESOURCE_HYDROXIDE;
    (labs[1].store as T4MutableStore)[RESOURCE_HYDROXIDE] = 4;
    expect((context.source.storage!.store as T4MutableStore)[RESOURCE_HYDROXIDE]).toBe(887);
    expect((context.source.terminal!.store as T4MutableStore)[RESOURCE_HYDROXIDE]).toBe(0);
    producer(260);
    expect(naturalTask()).toMatchObject({ amount: 1, remainingAmount: 1, origin: "automatic",
      reason: `synthesis:${T4_TARGET}:UH2O`, createdAt: 260 });
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(3);
    expect(state().consumption.map((entry) => entry.amount)).toEqual([10, 10, 6]);
  });

  it("真实pilot消耗满24h OH26预算后，released的新need10即使Terminal10也禁止普通producer回退建单", () => {
    releaseRealPilot({ rolling24hOH: 26 }); equipSynthesisLabs(); setT4Missing(context, 10);
    (context.source.terminal!.store as T4MutableStore)[RESOURCE_HYDROXIDE] = 10;
    expect(state().policy.rolling24hOH).toBe(26);
    expect(state().consumption.reduce((total, entry) => total + entry.amount, 0)).toBe(26);
    const before = JSON.stringify(Memory.data!.resourceControl!.tasks);
    at(260);
    expect(inspectTreasuryContinuousOHProcurement(T4_SOURCE, T4_TARGET, RESOURCE_HYDROXIDE,
      RESOURCE_UTRIUM_ACID, 10)).toEqual({ ownsRoute: true, amount: 0 });
    for (const tick of [260, 270, 280]) producer(tick);
    expect(JSON.stringify(Memory.data!.resourceControl!.tasks)).toBe(before);
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(3);
    expect(context.treasury.kernelJournal().active).toHaveLength(0);
  });

  it.each(["canary", "off"] as const)("真实need100/current active10/Terminal10，raw %s反复producer不merge静态身份", (mode) => {
    releaseRealPilot(); equipSynthesisLabs(); setT4Missing(context, 100);
    (context.source.terminal!.store as T4MutableStore)[RESOURCE_HYDROXIDE] = 10;
    producer(260);
    const task = naturalTask();
    expect(task).toMatchObject({ amount: 10, remainingAmount: 10, createdAt: 260 });
    // 真实kernel调用产生未决attempt；source仍有887 Storage，旧Terminal路径足以错误合并。
    (context.source.terminal!.send as jest.Mock).mockImplementation(() => { context.nativeTicks.push(Game.time); return NaN; });
    dispatch(300, task);
    expect(state().currentCycle?.taskId).toBe(task.id);
    expect(context.treasury.kernelJournal().active).toHaveLength(1);
    const identity = { id: task.id, createdAt: task.createdAt, amount: task.amount, remainingAmount: task.remainingAmount };
    const attemptId = context.treasury.kernelJournal().active[0].attemptId;
    (Memory.cfg as unknown as { treasuryTerminalTransferT4: { mode: string } }).treasuryTerminalTransferT4.mode = mode;
    for (const tick of [310, 320, 330]) producer(tick);
    expect(naturalTask()).toMatchObject(identity);
    expect(Memory.data!.resourceControl!.tasks[task.id]).toBe(task);
    expect(context.treasury.kernelJournal().active[0].attemptId).toBe(attemptId);
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(4);
    expect((context.source.terminal!.store as T4MutableStore)[RESOURCE_HYDROXIDE]).toBe(10);
  });

  it("真实TTL cancelled913保留，demand启动自然建26并原子绑定，跨reset完成10/10/6后release再自然建Storage-only10", () => {
    const old = demandStartupFixture();
    expect(enableTreasuryContinuousOHFromDemand()).toMatchObject({ ok: true, reason: "enabled_awaiting_natural_pilot" });
    expect(state()).toMatchObject({ schemaVersion: 2, sequenceHighWater: 0, currentCycle: null, consumption: [],
      pilot: { taskId: null, taskCreatedAt: null, taskAmount: null } });
    rebootService(); producer(110);
    let task = naturalTask();
    expect(task).toMatchObject({ amount: 26, remainingAmount: 26, createdAt: 110, origin: "automatic",
      reason: `synthesis:${T4_TARGET}:UH2O` });
    expect(state().pilot.taskId).toBeNull();
    dispatch(111, task);
    const identity = { taskId: task.id, taskCreatedAt: task.createdAt, taskAmount: task.amount };
    expect(state().pilot).toMatchObject(identity);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
    rebootService(); task = naturalTask();
    expect(state().pilot).toMatchObject(identity);
    // 下一tick的本房备货结果；新task创建/绑定过程中Terminal始终为0。
    (context.source.storage!.store as T4MutableStore)[RESOURCE_HYDROXIDE] = 887;
    (context.source.terminal!.store as T4MutableStore)[RESOURCE_HYDROXIDE] = 26;
    (context.source.terminal!.send as jest.Mock).mockImplementation(() => {
      context.nativeTicks.push(Game.time);
      expect(state().pilot).toMatchObject(identity);
      const runtime = Memory.runtime as unknown as Record<string, unknown>;
      expect(runtime.treasuryContinuousOH).toEqual(runtime.treasuryContinuousOHMirror);
      return OK;
    });
    for (const tick of [120, 170, 220]) {
      dispatch(tick, task);
      expect(context.source.terminal!.send).toHaveBeenCalledTimes([120, 170, 220].indexOf(tick) + 1);
      applyLatestT4Native(context);
      for (let n = 1; n <= 12; n += 1) dispatch(tick + n, task);
    }
    task = Memory.data!.resourceControl!.tasks[task.id] as ResourceTransferTask;
    expect((context.source.terminal!.send as jest.Mock).mock.calls.map((call) => call[1])).toEqual([10, 10, 6]);
    expect(task).toMatchObject({ amount: 26, remainingAmount: 0, status: "done" });
    expect((context.target.terminal!.store as T4MutableStore)[RESOURCE_HYDROXIDE]).toBe(30);
    expect(state()).toMatchObject({ sessionStatus: "pilot_complete_awaiting_release", currentCycle: null });
    expect(state().closedCycles.map((entry) => [entry.outcome, entry.ring?.generation])).toEqual([
      ["committed", 1], ["committed", 1], ["committed", 1],
    ]);
    expect(context.treasury.kernelJournal().active).toHaveLength(0);
    at(250); expect(acceptTreasuryContinuousOHPilot().ok).toBe(true);
    setT4Missing(context, 10); producer(270);
    const future = naturalTask();
    expect(future.id).not.toBe(task.id);
    expect(future).toMatchObject({ amount: 10, remainingAmount: 10, origin: "automatic", createdAt: 270 });
    expect(state().pilot).toMatchObject(identity);
    expect(JSON.stringify(t4CanonicalTask(context))).toBe(old);
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(3);
  });

  it("unbound启动真实need26但Storage仅10时拒绝partial pilot，不造会停死的task10", () => {
    const old = demandStartupFixture(10);
    expect(enableTreasuryContinuousOHFromDemand().ok).toBe(false);
    expect(readTreasuryContinuousOHState().status).toBe("absent");
    producer(110); producer(120);
    expect(Object.values(Memory.data!.resourceControl!.tasks).filter((task) => task.status === "pending")).toHaveLength(0);
    expect(JSON.stringify(t4CanonicalTask(context))).toBe(old);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it("坏主本、mirror半写或真实T4未决历史都不能借demand启动覆盖重开", () => {
    const old = demandStartupFixture();
    expect(enableTreasuryContinuousOHFromDemand().ok).toBe(true);
    const runtime = Memory.runtime as unknown as Record<string, unknown>;
    const primary = JSON.stringify(runtime.treasuryContinuousOH);
    const mirror = JSON.stringify(runtime.treasuryContinuousOHMirror);
    runtime.treasuryContinuousOH = { schemaVersion: 2 };
    expect(readTreasuryContinuousOHState().status).toBe("invalid");
    expect(enableTreasuryContinuousOHFromDemand().ok).toBe(false);
    expect(runtime.treasuryContinuousOH).toEqual({ schemaVersion: 2 });
    runtime.treasuryContinuousOH = JSON.parse(primary);
    delete runtime.treasuryContinuousOHMirror;
    expect(readTreasuryContinuousOHState().status).toBe("invalid");
    expect(enableTreasuryContinuousOHFromDemand().ok).toBe(false);
    expect(runtime.treasuryContinuousOHMirror).toBeUndefined();
    runtime.treasuryContinuousOHMirror = JSON.parse(mirror);
    producer(110); const task = naturalTask(); dispatch(111, task);
    (context.source.storage!.store as T4MutableStore)[RESOURCE_HYDROXIDE] = 903;
    (context.source.terminal!.store as T4MutableStore)[RESOURCE_HYDROXIDE] = 10;
    (context.source.terminal!.send as jest.Mock).mockImplementation(() => { context.nativeTicks.push(Game.time); return NaN; });
    dispatch(120, task);
    expect(state().consumption).toHaveLength(1);
    const attempt = context.treasury.kernelJournal().active[0].attemptId;
    delete runtime.treasuryContinuousOH; delete runtime.treasuryContinuousOHMirror;
    (Memory.cfg as unknown as { treasuryTerminalTransferT4: { mode: string } }).treasuryTerminalTransferT4.mode = "off";
    expect(readTreasuryContinuousOHState().status).toBe("absent");
    expect(enableTreasuryContinuousOHFromDemand().ok).toBe(false);
    expect(readTreasuryContinuousOHState().status).toBe("absent");
    expect(context.treasury.kernelJournal().active[0].attemptId).toBe(attempt);
    expect(JSON.stringify(t4CanonicalTask(context))).toBe(old);
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
  });
});
