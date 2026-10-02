import * as runtimeServices from "@/runtime/runtimeServices";
import * as continuousControl from "@/runtime/treasuryContinuousOHControl";
import * as continuousState from "@/runtime/treasuryContinuousOHState";
import { enableTreasuryContinuousOH, acceptTreasuryContinuousOHPilot, stopTreasuryContinuousOH } from "@/runtime/treasuryContinuousOHControl";
import { readTreasuryContinuousOHState } from "@/runtime/treasuryContinuousOHState";
import { beginTreasuryProductionTick, endTreasuryProductionTick, registerTreasuryProductionTerminalTransfer,
  runTreasuryTerminalTransferTask } from "@/runtime/treasuryTerminalTransfer";
import { resetTreasuryCoreLifecycleFactsForTest } from "@/runtime/treasury/kernel/kernel";
import { bumpTreasuryWorldSequence } from "@/runtime/treasury/observation";
import { treasuryTaskCommitmentView, hasTreasuryTerminalFence } from "@/runtime/treasuryTaskCommitmentBridge";
import { TREASURY_T4_LANE } from "@/runtime/treasuryTerminalLane";
import { armTreasuryT1FirstLive } from "@/runtime/treasuryT1FirstLiveControl";
import { armTreasuryT2FirstLive } from "@/runtime/treasuryT2FirstLiveControl";
import { armTreasuryT3FirstLive } from "@/runtime/treasuryT3FirstLiveControl";
import { decodeTreasuryT4DurableFacts } from "@/runtime/treasuryT4Facts";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { initializeT4, applyLatestT4Native, t4CanonicalTask, t4Ledger, setT4Missing,
  T4_SOURCE, T4_TARGET, type T4Fixture, type T4MutableStore } from "../../test/treasuryT4Fixture";
import { t4Room } from "../../test/treasuryT4Fixture";

describe("T4真实facade/kernel自动多片pilot", () => {
  let context: T4Fixture;
  let clock: jest.SpyInstance;
  let enabledWall: number;
  beforeAll(() => expect(registerTreasuryProductionTerminalTransfer()).toBe(true));
  beforeEach(() => {
    enabledWall = Date.now(); clock = jest.spyOn(Date, "now").mockReturnValue(enabledWall);
    context = initializeT4(undefined); context.treasury = runtimeServices.getTreasuryService();
  });
  afterEach(() => { endTreasuryProductionTick(); clock.mockRestore(); });

  function enable(): void {
    expect(enableTreasuryContinuousOH({ pilotTaskId: context.task.id,
      pilotTaskCreatedAt: context.task.createdAt, pilotTaskAmount: context.task.amount }).ok).toBe(true);
  }
  function state() {
    const read = readTreasuryContinuousOHState(); expect(read.status).toBe("valid");
    if (read.status !== "valid") throw Error("T4状态不是合法持久值");
    return read.value;
  }
  function tickAt(tick: number, task = t4CanonicalTask(context), wall = enabledWall + (tick - 100) * 1000) {
    Game.time = tick; clock.mockReturnValue(wall);
    beginTreasuryProductionTick();
    try { return runTreasuryTerminalTransferTask(task,
      t4Ledger({ ...context, target: Game.rooms[task.toRoomName] }), true, jest.fn()); }
    finally { endTreasuryProductionTick(); }
  }
  function settle(): void {
    applyLatestT4Native(context);
    for (let n = 0; n < 12; n += 1) tickAt(Game.time + 1);
  }
  function completePilot(): void {
    enable(); tickAt(100); settle(); tickAt(150); settle(); tickAt(200); settle();
  }
  function rebootService(): void {
    const root = global as unknown as { Memory: Memory; __runtimeServices?: unknown };
    root.Memory = JSON.parse(JSON.stringify(Memory)) as Memory;
    delete root.__runtimeServices; resetTreasuryCoreLifecycleFactsForTest();
    context.treasury = runtimeServices.getTreasuryService();
  }

  it("仅enable一次后自动10+10+6，三笔各自真实gen1闭环且不伪装清完913旧任务", () => {
    enable(); tickAt(100);
    expect((context.source.terminal!.send as jest.Mock).mock.calls.map((c) => c[1])).toEqual([10]);
    expect(t4CanonicalTask(context).remainingAmount).toBe(913); settle();
    expect(t4CanonicalTask(context).remainingAmount).toBe(903);
    expect((context.source.terminal!.store as T4MutableStore)[RESOURCE_HYDROXIDE]).toBe(16);
    expect((context.source.storage!.store as T4MutableStore)[RESOURCE_HYDROXIDE]).toBe(887);
    tickAt(150); settle(); expect(t4CanonicalTask(context).remainingAmount).toBe(893);
    tickAt(200); settle();
    expect((context.source.terminal!.send as jest.Mock).mock.calls.map((c) => c.slice(0, 3)))
      .toEqual([[RESOURCE_HYDROXIDE, 10, T4_TARGET], [RESOURCE_HYDROXIDE, 10, T4_TARGET], [RESOURCE_HYDROXIDE, 6, T4_TARGET]]);
    expect(new Set((context.source.terminal!.send as jest.Mock).mock.calls.map((c) => c[3])).size).toBe(3);
    expect(t4CanonicalTask(context)).toMatchObject({ amount: 913, remainingAmount: 887, status: "cancelled" });
    expect((context.source.storage!.store as T4MutableStore)[RESOURCE_HYDROXIDE]).toBe(887);
    expect(state()).toMatchObject({ sessionStatus: "pilot_complete_awaiting_release", sequenceHighWater: 3, currentCycle: null });
    expect(state().closedCycles.map((c) => [c.sequence, c.outcome, c.ring?.generation]))
      .toEqual([[1, "committed", 1], [2, "committed", 1], [3, "committed", 1]]);
    expect(state().consumption.map((c) => c.amount)).toEqual([10, 10, 6]);
    expect(context.treasury.kernelJournal().active).toHaveLength(0);
    const history = JSON.stringify(state().consumption); tickAt(250); tickAt(300);
    expect(JSON.stringify(state().consumption)).toBe(history);
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(3);
    expect(t4CanonicalTask(context).remainingAmount).toBe(887);
  });

  it("49tick不再native，50tick可自动第二片，ONscope等待仍held普通writer", () => {
    enable(); tickAt(100); settle();
    expect(tickAt(149).handled).toBe(true);
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
    tickAt(150); expect(context.source.terminal!.send).toHaveBeenCalledTimes(2);
    expect(context.nativeTicks).toEqual([100, 150]);
  });

  it("需求上涨也只花初始cohort26，awaiting release不接另一task", () => {
    enable(); tickAt(100); settle(); tickAt(150); settle();
    setT4Missing(context, 200); tickAt(200); settle();
    expect((context.source.terminal!.send as jest.Mock).mock.calls.map((c) => c[1])).toEqual([10, 10, 6]);
    expect(state().sessionStatus).toBe("pilot_complete_awaiting_release");
    const other = { ...t4CanonicalTask(context), id: "next-natural-OH-task", createdAt: 220,
      amount: 100, remainingAmount: 100, status: "pending" as const, treasurySlice: undefined };
    Memory.data!.resourceControl!.tasks[other.id] = other;
    expect(tickAt(300, other).handled).toBe(true);
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(3);
    expect(state().consumption.reduce((n, c) => n + c.amount, 0)).toBe(26);
  });

  it("多片accept只release一次，消费和起点不重置且release当tick不派新片", () => {
    completePilot(); const before = state(); const history = JSON.stringify(before.consumption);
    const next = { ...t4CanonicalTask(context), id: "next-epoch-OH-task", createdAt: Game.time,
      amount: 100, remainingAmount: 100, status: "pending" as const, treasurySlice: undefined };
    Memory.data!.resourceControl!.tasks[next.id] = next; setT4Missing(context, 100);
    (context.source.storage!.store as T4MutableStore)[RESOURCE_HYDROXIDE]! -= 10;
    (context.source.terminal!.store as T4MutableStore)[RESOURCE_HYDROXIDE] = 10;
    Game.time = 250; clock.mockReturnValue(enabledWall + 150_000);
    expect(acceptTreasuryContinuousOHPilot().ok).toBe(true);
    expect(acceptTreasuryContinuousOHPilot().ok).toBe(false);
    expect(state()).toMatchObject({ enabledAtTick: before.enabledAtTick, enabledAtMs: before.enabledAtMs,
      deadlineTick: before.deadlineTick, deadlineMs: before.deadlineMs, sequenceHighWater: 3 });
    expect(JSON.stringify(state().consumption)).toBe(history);
    tickAt(250, next); expect(context.source.terminal!.send).toHaveBeenCalledTimes(3);
    tickAt(251, next); expect(context.source.terminal!.send).toHaveBeenCalledTimes(4);
    expect(state().sequenceHighWater).toBe(4);
    expect(state().consumption.slice(0, 3)).toEqual(before.consumption);
  });

  it("只有1笔已确认后他路覆满需求，标准cancel余量但不能accept成多片成功", () => {
    enable(); tickAt(100); settle(); expect(acceptTreasuryContinuousOHPilot().ok).toBe(false);
    setT4Missing(context, 0); tickAt(149);
    expect(t4CanonicalTask(context)).toMatchObject({ amount: 913, remainingAmount: 903, status: "cancelled" });
    expect(acceptTreasuryContinuousOHPilot().ok).toBe(false);
    tickAt(150); tickAt(200);
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
    expect(state().closedCycles.filter((c) => c.outcome === "committed")).toHaveLength(1);
  });

  it("真实need0时enable保持idle，无manual heartbeat/prepare/native", () => {
    setT4Missing(context, 0); enable(); tickAt(100); tickAt(150);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ currentCycle: null, sequenceHighWater: 0, consumption: [] });
    expect(acceptTreasuryContinuousOHPilot().ok).toBe(false);
  });

  it.each(["id", "createdAt", "amount"])("enable不能把错误%s当初始cohort", (part) => {
    expect(enableTreasuryContinuousOH({ pilotTaskId: part === "id" ? "wrong-task" : context.task.id,
      pilotTaskCreatedAt: context.task.createdAt + (part === "createdAt" ? 1 : 0),
      pilotTaskAmount: context.task.amount + (part === "amount" ? 1 : 0) }).ok).toBe(false);
    expect(readTreasuryContinuousOHState().status).toBe("absent");
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it("unknown预扣跨heap reset和24h仍占cohort且只恢复原attempt", () => {
    (context.source.terminal!.send as jest.Mock).mockImplementation(() => { context.nativeTicks.push(Game.time); return NaN; });
    enable(); tickAt(100);
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
    const original = state().consumption[0]; const attempt = context.treasury.kernelJournal().active[0].attemptId;
    expect(original.amount).toBe(10); expect(acceptTreasuryContinuousOHPilot().ok).toBe(false);
    rebootService(); setT4Missing(context, 200);
    for (let n = 0; n < 10; n += 1) tickAt(2000 + n, undefined, enabledWall + 86_400_000 + n);
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
    expect(state().consumption).toEqual([original]);
    expect(context.treasury.kernelJournal().active[0].attemptId).toBe(attempt);
    expect(t4CanonicalTask(context).remainingAmount).toBe(913);
    expect(acceptTreasuryContinuousOHPilot().ok).toBe(false);
  });

  it("native前消费先持久，任一未闭合attempt不能借新sequence再发", () => {
    (context.source.terminal!.send as jest.Mock).mockImplementation(() => {
      context.nativeTicks.push(Game.time);
      expect(state().consumption).toHaveLength(1);
      expect(state().consumption[0]).toMatchObject({ amount: 10, fee: 2, sequence: 1 });
      expect(state().currentCycle?.quota?.status).toBe("dispatching");
      return OK;
    });
    enable(); tickAt(100); const first = state().consumption[0];
    tickAt(150); tickAt(200);
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
    expect(state().consumption).toEqual([first]);
    expect(t4CanonicalTask(context).remainingAmount).toBe(913);
  });

  it("admission后Storage887缩到886，fresh native复核不能释放完整887位置责任", () => {
    enable();
    const original = context.treasury.executeAuthorizedDispatch.bind(context.treasury);
    let payload: string;
    const injection = jest.spyOn(context.treasury, "executeAuthorizedDispatch").mockImplementation((...args) => {
      payload = context.treasury.kernelJournal().active[0].identity.durableFacts!.payload;
      expect(decodeTreasuryT4DurableFacts(payload)).toMatchObject({ amount: 10, sequence: 1 });
      (context.source.storage!.store as T4MutableStore)[RESOURCE_HYDROXIDE] = 886;
      return original(...args);
    });
    try { tickAt(100); } finally { injection.mockRestore(); }
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
    expect(t4CanonicalTask(context).remainingAmount).toBe(913);
    expect(context.treasury.kernelJournal().active[0].identity.durableFacts!.payload).toBe(payload);
  });

  it("OFF停止新派单仍恢复原10attempt，反复receipt不重扣且最终明确交回ordinary", () => {
    enable(); tickAt(100); expect(stopTreasuryContinuousOH().ok).toBe(true);
    applyLatestT4Native(context); rebootService();
    for (let n = 0; n < 12; n += 1) tickAt(101 + n);
    expect(t4CanonicalTask(context).remainingAmount).toBe(903);
    expect(state().sessionStatus).toBe("stopped");
    expect(state().closedCycles.map((c) => c.outcome)).toEqual(["committed"]);
    expect(tickAt(150).handled).toBe(false);
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
    expect(state().consumption.map((c) => c.amount)).toEqual([10]);
  });

  it.each(["tick", "wall"])("固定%s到期停止新但原native责任仍可确认关闭", (boundary) => {
    enable(); tickAt(100); const deadline = state(); applyLatestT4Native(context);
    const targetTick = boundary === "tick" ? deadline.deadlineTick : 2000;
    const targetWall = boundary === "wall" ? deadline.deadlineMs : enabledWall + 1000;
    for (let n = 0; n < 12; n += 1) tickAt(targetTick + n, undefined, targetWall + n);
    expect(t4CanonicalTask(context).remainingAmount).toBe(903);
    expect(state().sessionStatus).toBe("stopped");
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
    expect(state().consumption.map((c) => c.amount)).toEqual([10]);
    expect(tickAt(targetTick + 20, undefined, targetWall + 20).handled).toBe(false);
  });

  it("admission→quota之间reset只取消原sequence/attempt，不native、不扣消费或原913进度", () => {
    enable(); const original = context.treasury.authorizeTreasuryActionContract.bind(context.treasury);
    const admission = jest.spyOn(context.treasury, "authorizeTreasuryActionContract").mockImplementation((...args) => {
      const result = original(...args); expect(result.status).toBe("admitted"); throw Error("T4 reset before quota");
    });
    let attempt: string;
    try {
      expect(() => tickAt(100)).toThrow("T4 reset before quota");
      const record = context.treasury.kernelJournal().active[0]; attempt = record.attemptId;
      expect(record).toMatchObject({ phase: "pending", invocationBoundary: null });
      expect(decodeTreasuryT4DurableFacts(record.identity.durableFacts!.payload)).toMatchObject({ sequence: 1, amount: 10 });
    } finally { admission.mockRestore(); }
    expect(stopTreasuryContinuousOH().ok).toBe(true); rebootService();
    for (let n = 0; n < 12; n += 1) tickAt(101 + n);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
    expect(t4CanonicalTask(context).remainingAmount).toBe(913);
    expect(context.treasury.kernelJournal().active).toHaveLength(0);
    expect(state()).toMatchObject({ sessionStatus: "stopped", consumption: [], sequenceHighWater: 1, currentCycle: null });
    expect(state().closedCycles[0]).toMatchObject({ sequence: 1, outcome: "not_executed", ring: { attemptId: attempt, generation: 1, terminalPhase: "abandoned" } });
  });

  it("dispatching预扣成功后native调用前reset仍永久占10/fee2，跨新window绝不重发", () => {
    enable(); const original = continuousControl.writeTreasuryContinuousOHQuota;
    const injection = jest.spyOn(continuousControl, "writeTreasuryContinuousOHQuota").mockImplementation((value, fee) => {
      const result = original(value, fee);
      if (value.status === "dispatching" && result) throw Error("T4 reset after debit before native");
      return result;
    });
    try { tickAt(100); } catch (error) { expect(String(error)).toContain("reset after debit"); }
    finally { injection.mockRestore(); }
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
    expect(state().consumption).toHaveLength(1);
    const debit = state().consumption[0]; expect(debit).toMatchObject({ amount: 10, fee: 2, sequence: 1 });
    expect(stopTreasuryContinuousOH().ok).toBe(true); rebootService();
    for (let n = 0; n < 12; n += 1) tickAt(2000 + n, undefined, enabledWall + 86_400_000 + n);
    expect(state().consumption).toEqual([debit]);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
    expect(t4CanonicalTask(context).remainingAmount).toBe(913);
  });

  it("certificate已持久而canary handoff半写，fresh service恢复原cert/预算继续10+10+6", () => {
    enable(); tickAt(100); applyLatestT4Native(context);
    const cfg = Memory.cfg as unknown as Record<string, unknown>; const key = TREASURY_T4_LANE.configKey;
    let stored = cfg[key];
    Object.defineProperty(cfg, key, { configurable: true, enumerable: true, get: () => stored,
      set: (value: unknown) => {
        if ((value as { mode?: string })?.mode === "canary" && state().closedCycles.length === 1 &&
            state().modeTransition === "canary_after_closure") throw Error("reset after certificate before canary");
        stored = value;
      },
    });
    try {
      for (let n = 0; n < 12 && state().modeTransition === null; n += 1) tickAt(101 + n);
      expect(state().modeTransition).toBe("canary_after_closure");
      expect(state().closedCycles).toHaveLength(1);
      expect(state().closedCycles[0]).toMatchObject({ outcome: "committed", ring: { generation: 1 } });
      expect((stored as { mode: string }).mode).toBe("drain");
    } finally { Object.defineProperty(cfg, key, { configurable: true, enumerable: true, writable: true, value: stored }); }
    const originalCert = state().closedCycles[0]; const debit = state().consumption[0];
    rebootService(); tickAt(150); settle(); tickAt(200); settle();
    expect((context.source.terminal!.send as jest.Mock).mock.calls.map((c) => c[1])).toEqual([10, 10, 6]);
    expect(state().closedCycles[0]).toEqual(originalCert); expect(state().consumption[0]).toEqual(debit);
    expect(state()).toMatchObject({ sessionStatus: "pilot_complete_awaiting_release", currentCycle: null, sequenceHighWater: 3, modeTransition: null });
  });

  it("task ID重用不能让旧10成交扣新任务，也不能把旧attempt换sequence", () => {
    enable(); tickAt(100); const attempt = context.treasury.kernelJournal().active[0].attemptId;
    const replacement = { ...t4CanonicalTask(context), createdAt: 101, treasurySlice: undefined };
    Memory.data!.resourceControl!.tasks[replacement.id] = replacement;
    expect(treasuryTaskCommitmentView({ [replacement.id]: replacement }, context.treasury.kernelJournal().active)
      [replacement.id].remainingAmount).toBe(913);
    applyLatestT4Native(context); rebootService();
    for (let n = 0; n < 12; n += 1) tickAt(101 + n);
    expect(t4CanonicalTask(context).remainingAmount).toBe(913);
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
    expect(state().consumption[0].attemptId).toBe(attempt);
    expect(state().sequenceHighWater).toBe(1);
    expect(hasTreasuryTerminalFence(T4_SOURCE)).toBe(true);
  });

  it("T1/T2/T3真实已消费控制、quota和gen1历史在启用T4后完整保留", () => {
    const hSource = t4Room("E3N59", { [RESOURCE_HYDROGEN]: 1000, [RESOURCE_ENERGY]: 10_000 }); Game.rooms[hSource.name] = hSource;
    const hTask = { ...t4CanonicalTask(context), id: "history-H", resource: RESOURCE_HYDROGEN,
      fromRoomName: hSource.name, toRoomName: T4_SOURCE, amount: 100, remainingAmount: 100,
      origin: "manual" as const, reason: undefined };
    Memory.data!.resourceControl!.tasks[hTask.id] = hTask;
    expect(armTreasuryT1FirstLive(hTask.id, hTask.createdAt).ok).toBe(true); tickAt(100, hTask);
    applyLatestT4Native({ ...context, source: hSource, target: context.source, nativeTicks: [100], appliedCalls: new Set() }, "history-H-receipt");
    for (let n = 0; n < 12; n += 1) tickAt(Game.time + 1);
    const source = context.source.terminal!.store as T4MutableStore; const target = context.target.terminal!.store as T4MutableStore;
    source[RESOURCE_UTRIUM_HYDRIDE] = 1000; target[RESOURCE_UTRIUM_HYDRIDE] = 0;
    const uhTask = { ...t4CanonicalTask(context), id: "history-UH", resource: RESOURCE_UTRIUM_HYDRIDE,
      amount: 25, remainingAmount: 25 };
    Memory.data!.resourceControl!.tasks[uhTask.id] = uhTask;
    expect(armTreasuryT2FirstLive(uhTask.id, uhTask.createdAt).ok).toBe(true); tickAt(Game.time, uhTask); settle();
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(true); tickAt(Game.time); settle();
    const runtime = Memory.runtime as unknown as Record<string, unknown>;
    const keys = [1, 2, 3].flatMap((n) => [`treasuryT${n}FirstLiveControl`, `treasuryT${n}FirstLiveControlMirror`, `treasuryProductionT${n}Quota`]);
    for (let n = 1; n <= 3; n += 1) expect(runtime[`treasuryProductionT${n}Quota`]).toMatchObject({ status: "drained" });
    const historic = JSON.stringify(keys.map((key) => [key, runtime[key]]));
    const rings = context.treasury.kernelJournal().ring.map((entry) => ({ ...entry }));
    expect(rings).toHaveLength(3); expect(rings.map((r) => r.generation)).toEqual([1, 1, 1]);
    (context.source.terminal!.send as jest.Mock).mockClear(); context.nativeTicks.length = 0; context.appliedCalls.clear();
    setT4Missing(context, 26); source[RESOURCE_HYDROXIDE] = 10;
    (context.source.storage!.store as T4MutableStore)[RESOURCE_HYDROXIDE]! -= 10;
    enable(); tickAt(200); settle();
    expect(context.source.terminal!.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(keys.map((key) => [key, runtime[key]]))).toBe(historic);
    expect(context.treasury.kernelJournal().ring).toEqual(expect.arrayContaining(rings));
    expect(armTreasuryT1FirstLive(hTask.id, hTask.createdAt).ok).toBe(false);
    expect(armTreasuryT2FirstLive(uhTask.id, uhTask.createdAt).ok).toBe(false);
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(false);
  });

  it("真实成长book重复cargo只验一次，world/write/deep mirror失效且cache不授权native", () => {
    completePilot(); Game.time = 250; clock.mockReturnValue(enabledWall + 150_000);
    const scan = jest.spyOn(continuousState, "readTreasuryContinuousOHState");
    try {
      for (let n = 0; n < 25; n += 1) expect(hasTreasuryTerminalFence(T4_SOURCE)).toBe(false);
      expect(scan).toHaveBeenCalledTimes(1);
      bumpTreasuryWorldSequence(); scan.mockClear();
      for (let n = 0; n < 25; n += 1) expect(hasTreasuryTerminalFence(T4_SOURCE)).toBe(false);
      expect(scan).toHaveBeenCalledTimes(1);
      expect(acceptTreasuryContinuousOHPilot().ok).toBe(true); scan.mockClear();
      for (let n = 0; n < 25; n += 1) expect(hasTreasuryTerminalFence(T4_SOURCE)).toBe(false);
      expect(scan).toHaveBeenCalledTimes(1);
      type MutableBook = { hash: string; consumption: Array<{ amount: number }>; closedCycles: Array<{ cycle: { amount: number } }> };
      const runtime = Memory.runtime as unknown as Record<string, unknown>;
      const primary = runtime.treasuryContinuousOH as MutableBook;
      const mirror = runtime.treasuryContinuousOHMirror as MutableBook;
      const priorPrimaryHash = primary.hash; const priorMirrorHash = mirror.hash;
      const amount = primary.consumption[0].amount;
      primary.consumption[0].amount = amount + 1; scan.mockClear();
      expect(primary.hash).toBe(priorPrimaryHash); expect(primary.consumption).toHaveLength(3);
      expect(hasTreasuryTerminalFence(T4_SOURCE)).toBe(true); expect(scan).toHaveBeenCalledTimes(1);
      primary.consumption[0].amount = amount;
      expect(hasTreasuryTerminalFence(T4_SOURCE)).toBe(false);
      const mirrorAmount = mirror.closedCycles[0].cycle.amount;
      mirror.closedCycles[0].cycle.amount = mirrorAmount + 1; scan.mockClear();
      expect(mirror.hash).toBe(priorMirrorHash); expect(mirror.closedCycles).toHaveLength(3);
      expect(hasTreasuryTerminalFence(T4_SOURCE)).toBe(true); expect(scan).toHaveBeenCalledTimes(1);
      mirror.closedCycles[0].cycle.amount = mirrorAmount;
      expect(hasTreasuryTerminalFence(T4_SOURCE)).toBe(false);
      const hiddenSymbol = Symbol("invalid-budget-metadata");
      const firstEntry = primary.consumption[0] as unknown as Record<PropertyKey, unknown>;
      Object.defineProperty(firstEntry, hiddenSymbol, { configurable: true, value: true });
      expect(hasTreasuryTerminalFence(T4_SOURCE)).toBe(true);
      delete firstEntry[hiddenSymbol]; expect(hasTreasuryTerminalFence(T4_SOURCE)).toBe(false);
      const historyArray = primary.consumption as unknown as Record<string, unknown>;
      Object.defineProperty(historyArray, "extra", { configurable: true, value: undefined });
      expect(hasTreasuryTerminalFence(T4_SOURCE)).toBe(true);
      delete historyArray.extra; expect(hasTreasuryTerminalFence(T4_SOURCE)).toBe(false);
      const secondEntry = primary.consumption[1]; const amountDescriptor = Object.getOwnPropertyDescriptor(secondEntry, "amount")!;
      const getter = jest.fn(() => amountDescriptor.value);
      Object.defineProperty(secondEntry, "amount", { configurable: true, enumerable: true, get: getter });
      expect(hasTreasuryTerminalFence(T4_SOURCE)).toBe(true); expect(getter).not.toHaveBeenCalled();
      Object.defineProperty(secondEntry, "amount", amountDescriptor);
      expect(hasTreasuryTerminalFence(T4_SOURCE)).toBe(false);
      const next = { ...t4CanonicalTask(context), id: "fresh-authority-OH", createdAt: 250,
        amount: 100, remainingAmount: 100, status: "pending" as const, treasurySlice: undefined };
      Memory.data!.resourceControl!.tasks[next.id] = next; setT4Missing(context, 100);
      (context.source.storage!.store as T4MutableStore)[RESOURCE_HYDROXIDE]! -= 10;
      (context.source.terminal!.store as T4MutableStore)[RESOURCE_HYDROXIDE] = 10;
      primary.consumption[0].amount = amount + 1;
      tickAt(251, next);
      expect(context.source.terminal!.send).toHaveBeenCalledTimes(3);
      expect(readTreasuryContinuousOHState().status).toBe("invalid");
      expect(next.remainingAmount).toBe(100);
    } finally { scan.mockRestore(); }
  });
});
