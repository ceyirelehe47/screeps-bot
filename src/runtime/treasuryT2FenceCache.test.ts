import * as coreStore from "@/runtime/treasury/kernel/store";
import { hasTreasuryTerminalFence } from "@/runtime/treasuryTaskCommitmentBridge";
import { armTreasuryT2FirstLive, closeTreasuryT2FirstLive, readTreasuryT2FirstLiveControl } from "@/runtime/treasuryT2FirstLiveControl";
import { TREASURY_T2_RUN_ID, treasuryT2WorkKey } from "@/runtime/treasuryT2Facts";
import { initializeT2, T2_TARGET } from "../../test/treasuryT2Fixture";

describe("T2 carrier fence cache avoids empire scans without hiding same-tick responsibility", () => {
  let context: ReturnType<typeof initializeT2>;
  beforeEach(() => { context = initializeT2(); });

  it("only scans kernel responsibility once for repeated same-tick clear cargo/fence queries", () => {
    const scan = jest.spyOn(coreStore, "readTreasuryCoreStoreHealth");
    try {
      for (let i = 0; i < 25; i += 1) expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(false);
      expect(scan).toHaveBeenCalledTimes(1);
      const runtime = Memory.runtime as unknown as Record<string, unknown>;
      runtime.treasuryProductionT2Quota = { schemaVersion: 2, runId: TREASURY_T2_RUN_ID, status: "reserved",
        taskId: context.task.id, taskCreatedAt: context.task.createdAt, taskAmount: 1715,
        workKey: treasuryT2WorkKey(context.task.id), attemptId: "fresh-same-tick-attempt", amount: 100, reservedAtTick: 100 };
      expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(true);
      expect(scan).toHaveBeenCalledTimes(2);
      for (let i = 0; i < 25; i += 1) expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(true);
      expect(scan).toHaveBeenCalledTimes(2);
    } finally { scan.mockRestore(); }
  });

  it("sees a legitimate control publication in the same tick after a cached clear fence", () => {
    expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(false);
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(true);
    expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(true);
    expect(closeTreasuryT2FirstLive("isolated_no_native_close").ok).toBe(true);
    expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(false);
  });

  it("does not cache an in-place corrupted mirror as a safe closed control", () => {
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(true);
    expect(closeTreasuryT2FirstLive("isolated_no_native_close").ok).toBe(true);
    expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(false);
    const mirror = (Memory.runtime as unknown as { treasuryT2FirstLiveControlMirror: { controlUntilMs: number } }).treasuryT2FirstLiveControlMirror;
    mirror.controlUntilMs -= 1;
    expect(readTreasuryT2FirstLiveControl().status).toBe("invalid");
    expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(true);
  });

  it("does not hide an invalid quota extra field even when pointers and normal fields stay unchanged", () => {
    const runtime = Memory.runtime as unknown as Record<string, unknown>;
    const quota = { schemaVersion: 2, runId: TREASURY_T2_RUN_ID, status: "reserved",
      taskId: context.task.id, taskCreatedAt: context.task.createdAt, taskAmount: 1715,
      workKey: treasuryT2WorkKey(context.task.id), attemptId: "quota-shape-attempt", amount: 100, reservedAtTick: 100 };
    runtime.treasuryProductionT2Quota = quota;
    expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(true);
    (quota as unknown as Record<string, unknown>).unknownField = true;
    expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(true);
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(false);
  });
});
