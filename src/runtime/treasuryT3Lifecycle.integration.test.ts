import * as runtimeServices from "@/runtime/runtimeServices";
import { armTreasuryT3FirstLive, heartbeatTreasuryT3FirstLive, readTreasuryT3FirstLiveControl,
  treasuryT3FirstLiveAllows } from "@/runtime/treasuryT3FirstLiveControl";
import { armTreasuryT2FirstLive, readTreasuryT2FirstLiveControl } from "@/runtime/treasuryT2FirstLiveControl";
import { resetTreasuryCoreLifecycleFactsForTest } from "@/runtime/treasury/kernel/kernel";
import { createTreasuryFirstLiveState } from "@/runtime/treasuryFirstLiveState";
import { TREASURY_T1_LANE, TREASURY_T2_LANE, TREASURY_T3_LANE, treasuryLaneWorkKey } from "@/runtime/treasuryTerminalLane";
import { beginTreasuryProductionTick, endTreasuryProductionTick, registerTreasuryProductionTerminalTransfer,
  runTreasuryTerminalTransferTask } from "@/runtime/treasuryTerminalTransfer";
import { hasTreasuryTerminalFence } from "@/runtime/treasuryTaskCommitmentBridge";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { initializeT3, t3Ledger, t3Task, T3_SOURCE, T3_TARGET, T3MutableStore } from "../../test/treasuryT3Fixture";

describe("T3签名期限和26 OH admission reset恢复", () => {
  let context: ReturnType<typeof initializeT3>;
  let serviceSpy: jest.SpyInstance;
  beforeAll(() => expect(registerTreasuryProductionTerminalTransfer()).toBe(true));
  beforeEach(() => {
    context = initializeT3();
    serviceSpy = jest.spyOn(runtimeServices, "getTreasuryService").mockReturnValue(context.treasury);
  });
  afterEach(() => { endTreasuryProductionTick(); serviceSpy.mockRestore(); });
  function recover(count = 12): void {
    for (let n = 0; n < count; n += 1) { Game.time += 1; beginTreasuryProductionTick(); endTreasuryProductionTick(); }
  }

  it.each([26, 100])("requested%i/need26 admission→quota reset只能abandon原attempt，零native不扣进度", (requested) => {
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, requested).ok).toBe(true);
    const original = context.treasury.authorizeTreasuryActionContract.bind(context.treasury);
    const admission = jest.spyOn(context.treasury, "authorizeTreasuryActionContract").mockImplementation((...args) => {
      const result = original(...args); expect(result.status).toBe("admitted");
      throw Error("T3 reset after admission before quota");
    });
    let attemptId: string;
    try {
      expect(beginTreasuryProductionTick()).toBe(true);
      expect(() => runTreasuryTerminalTransferTask(context.task, t3Ledger(context.target, [context.task]), true, jest.fn()))
        .toThrow("T3 reset after admission before quota");
      const record = context.treasury.kernelJournal().active[0];
      expect(record).toMatchObject({ phase: "pending", invocationBoundary: null }); attemptId = record.attemptId;
      expect((Memory.runtime as unknown as Record<string, unknown>).treasuryProductionT3Quota).toBeUndefined();
    } finally { admission.mockRestore(); endTreasuryProductionTick(); }
    if (requested === 100) (context.target.terminal!.store as T3MutableStore)[RESOURCE_HYDROXIDE] = 30;
    resetTreasuryCoreLifecycleFactsForTest(); recover();
    const runtime = Memory.runtime as unknown as Record<string, unknown>;
    expect(runtime.treasuryProductionT3Quota).toMatchObject({ status: "drained", amount: 26, attemptId });
    const canonical = Memory.data!.resourceControl!.tasks[context.task.id] as ResourceTransferTask;
    expect(canonical.remainingAmount).toBe(1715); expect(canonical.treasurySlice).toBeUndefined();
    expect(context.treasury.kernelJournal().active).toHaveLength(0);
    expect(context.treasury.kernelJournal().ring).toEqual(expect.arrayContaining([
      expect.objectContaining({ attemptId, terminalPhase: "abandoned" }),
    ]));
    expect(hasTreasuryTerminalFence(T3_SOURCE)).toBe(false); expect(hasTreasuryTerminalFence(T3_TARGET)).toBe(false);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, requested).ok).toBe(false);
  });

  it.each([26, 100])("requested%i未admit preparing lease过期且OHneed已覆满，清lease/OFF不花quota", (requested) => {
    const now = Date.now(); const clock = jest.spyOn(Date, "now").mockReturnValue(now);
    try {
      expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, requested).ok).toBe(true);
      context.task.treasurySlice = { schemaVersion: 1, runId: TREASURY_T3_LANE.runId,
        workKey: treasuryLaneWorkKey(TREASURY_T3_LANE, context.task.id), attemptId: "", amount: 26, phase: "preparing" };
      (context.target.terminal!.store as T3MutableStore)[RESOURCE_HYDROXIDE] = 30;
      clock.mockReturnValue(now + 60_000); recover();
      expect((Memory.data!.resourceControl!.tasks[context.task.id] as ResourceTransferTask).treasurySlice).toBeUndefined();
      expect((Memory.runtime as unknown as Record<string, unknown>).treasuryProductionT3Quota).toBeUndefined();
      expect(hasTreasuryTerminalFence(T3_SOURCE)).toBe(false); expect(hasTreasuryTerminalFence(T3_TARGET)).toBe(false);
      expect(context.source.terminal!.send).not.toHaveBeenCalled();
      expect(readTreasuryT3FirstLiveControl()).toMatchObject({ status: "valid", value: { status: "closed" } });
    } finally { clock.mockRestore(); }
  });

  it.each([TREASURY_T1_LANE, TREASURY_T2_LANE])("quota写失败且旧%s held时，仍恢复T3原26attempt", (lane) => {
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(true);
    const runtime = Memory.runtime as unknown as Record<string, unknown>;
    Object.defineProperty(runtime, "treasuryProductionT3Quota", { configurable: true, enumerable: true,
      get: () => undefined, set: () => undefined });
    expect(beginTreasuryProductionTick()).toBe(true);
    runTreasuryTerminalTransferTask(context.task, t3Ledger(context.target, [context.task]), true, jest.fn());
    const record = context.treasury.kernelJournal().active[0];
    expect(record).toMatchObject({ phase: "pending", invocationBoundary: null });
    expect(context.source.terminal!.send).not.toHaveBeenCalled(); endTreasuryProductionTick();
    delete runtime.treasuryProductionT3Quota;
    const foreign = { schemaVersion: 2, runId: lane.runId, status: "dispatching", taskId: "foreign-held",
      taskCreatedAt: 90, taskAmount: 100, workKey: treasuryLaneWorkKey(lane, "foreign-held"),
      attemptId: "foreign-attempt", amount: 100, reservedAtTick: 99 };
    runtime[lane.quotaKey] = foreign; const before = JSON.stringify(foreign);
    resetTreasuryCoreLifecycleFactsForTest(); recover();
    expect(context.treasury.kernelJournal().active).toHaveLength(0);
    expect(runtime.treasuryProductionT3Quota).toMatchObject({ status: "drained", amount: 26, attemptId: record.attemptId });
    expect(JSON.stringify(runtime[lane.quotaKey])).toBe(before);
    expect((Memory.data!.resourceControl!.tasks[context.task.id] as ResourceTransferTask).treasurySlice).toBeUndefined();
    expect(Memory.data!.resourceControl!.tasks[context.task.id].remainingAmount).toBe(1715);
    expect(hasTreasuryTerminalFence(T3_SOURCE)).toBe(true);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it("T3 maxSliceAmount签名不能改值或复制进旧T2字段集合", () => {
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(true);
    const runtime = Memory.runtime as unknown as Record<string, unknown>;
    const primary = runtime.treasuryT3FirstLiveControl as Record<string, unknown>;
    expect(primary.maxSliceAmount).toBe(26);
    runtime.treasuryT2FirstLiveControl = { ...primary }; runtime.treasuryT2FirstLiveControlMirror = { ...primary };
    expect(readTreasuryT2FirstLiveControl().status).toBe("invalid");
    primary.maxSliceAmount = 27;
    expect(readTreasuryT3FirstLiveControl().status).toBe("invalid");
    expect(treasuryT3FirstLiveAllows(context.task, 26)).toBe(false);
  });

  it("T2原签名字段无maxSliceAmount，显式塞入即invalid", () => {
    const uhTask = { ...t3Task(25), id: "UH-control-shape", resource: RESOURCE_UTRIUM_HYDRIDE };
    Memory.data!.resourceControl!.tasks[uhTask.id] = uhTask;
    (context.target.terminal!.store as unknown as { UH: number }).UH = 0;
    (context.source.terminal!.store as unknown as { UH: number }).UH = 1000;
    expect(armTreasuryT2FirstLive(uhTask.id, uhTask.createdAt).ok).toBe(true);
    const read = readTreasuryT2FirstLiveControl(); expect(read.status).toBe("valid");
    if (read.status !== "valid") throw Error("missing valid T2 control");
    expect(Object.keys(read.value)).not.toContain("maxSliceAmount");
    const { hash: _hash, ...payload } = read.value;
    const invalid = createTreasuryFirstLiveState(TREASURY_T2_LANE).seal({ ...payload, maxSliceAmount: 26 });
    const runtime = Memory.runtime as unknown as Record<string, unknown>;
    runtime.treasuryT2FirstLiveControl = invalid; runtime.treasuryT2FirstLiveControlMirror = { ...invalid };
    expect(readTreasuryT2FirstLiveControl().status).toBe("invalid");
  });

  it.each(["lease", "tick", "wall"])("T3在%s边界关闭unused授权且释放两端fence", (boundary) => {
    const now = Date.now(); const clock = jest.spyOn(Date, "now").mockReturnValue(now);
    try {
      expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(true);
      if (boundary === "wall") {
        for (let elapsed = 30_000; elapsed < 30 * 60_000; elapsed += 30_000) {
          clock.mockReturnValue(now + elapsed); expect(heartbeatTreasuryT3FirstLive().ok).toBe(true);
        }
      }
      if (boundary === "tick") Game.time = 700;
      else clock.mockReturnValue(now + (boundary === "wall" ? 30 * 60_000 : 60_000));
      expect(treasuryT3FirstLiveAllows(context.task, 26)).toBe(false);
      expect(beginTreasuryProductionTick()).toBe(false);
      expect(readTreasuryT3FirstLiveControl()).toMatchObject({ status: "valid", value: { status: "closed" } });
      expect(hasTreasuryTerminalFence(T3_SOURCE)).toBe(false); expect(hasTreasuryTerminalFence(T3_TARGET)).toBe(false);
      expect(context.source.terminal!.send).not.toHaveBeenCalled();
      expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(false);
    } finally { clock.mockRestore(); }
  });
});
