import * as coreStore from "@/runtime/treasury/kernel/store";
import * as terminalControl from "@/runtime/treasuryTerminalControl";
import * as responsibility from "@/runtime/treasuryTerminalResponsibility";
import { hasTreasuryTerminalFence, hasTreasuryT1TerminalFence } from "@/runtime/treasuryTaskCommitmentBridge";
import { TREASURY_T1_LANE, TREASURY_T2_LANE, TREASURY_TERMINAL_LANES } from "@/runtime/treasuryTerminalLane";
import { bumpTreasuryWorldSequence } from "@/runtime/treasury/observation";
import { bumpTreasuryCommitmentRevision } from "@/runtime/treasury/commitmentRevision";
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

  it("cold及warm每PUBLIC query恰好fresh读3旧control和3quota各一次，共享不跨query", () => {
    const controls = jest.spyOn(terminalControl, "readTreasuryTerminalFenceControl");
    const quotas = jest.spyOn(responsibility, "readTreasuryLaneFenceQuota");
    try {
      expect(hasTreasuryTerminalFence("E4N58")).toBe(false);
      expect(controls).toHaveBeenCalledTimes(3); expect(quotas).toHaveBeenCalledTimes(3);
      expect(new Set(controls.mock.calls.map(([lane]) => lane.name)).size).toBe(3);
      expect(new Set(quotas.mock.calls.map(([lane]) => lane.name)).size).toBe(3);
      controls.mockClear(); quotas.mockClear();
      expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(false);
      expect(controls).toHaveBeenCalledTimes(3); expect(quotas).toHaveBeenCalledTimes(3);
      controls.mockClear(); quotas.mockClear();
      expect(hasTreasuryT1TerminalFence()).toBe(false);
      expect(controls).toHaveBeenCalledTimes(3); expect(quotas).toHaveBeenCalledTimes(3);
    } finally { controls.mockRestore(); quotas.mockRestore(); }
  });

  it("合法镜像replacement及world/revision变化重新检查kernel，之后samequery复用", () => {
    expect(armTreasuryT2FirstLive(context.task.id, context.task.createdAt).ok).toBe(true);
    expect(closeTreasuryT2FirstLive("query_snapshot_no_native").ok).toBe(true);
    const scan = jest.spyOn(coreStore, "readTreasuryCoreStoreHealth");
    try {
      expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(false); const first = scan.mock.calls.length;
      const runtime = Memory.runtime as unknown as Record<string, unknown>;
      runtime.treasuryT2FirstLiveControlMirror = JSON.parse(JSON.stringify(runtime.treasuryT2FirstLiveControlMirror));
      expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(false); expect(scan.mock.calls.length).toBe(first + 1);
      bumpTreasuryWorldSequence();
      expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(false); expect(scan.mock.calls.length).toBe(first + 2);
      bumpTreasuryCommitmentRevision();
      expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(false); expect(scan.mock.calls.length).toBe(first + 3);
    } finally { scan.mockRestore(); }
  });

  it("foreign control坏态不扩大T1直接入口拒绝范围，related query仍held", () => {
    const runtime = Memory.runtime as unknown as Record<string, unknown>;
    runtime.treasuryT2FirstLiveControl = { schemaVersion: -1 };
    expect(hasTreasuryT1TerminalFence()).toBe(false);
    expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(true);
  });

  it("default/Native责任读取忽略人为注入的fence reader，仍拒真实bad quota", () => {
    const runtime = Memory.runtime as unknown as Record<string, unknown>;
    runtime[TREASURY_T2_LANE.quotaKey] = { schemaVersion: -1 };
    const reader = jest.fn(() => ({ status: "absent" as const }));
    expect(responsibility.readTreasuryLaneResponsibility(TREASURY_T1_LANE, undefined, false, undefined, reader).status).toBe("invalid");
    expect(reader).not.toHaveBeenCalled();
    expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(true);
  });

  it("未知旧control根getter不执行，related held且foreign直接入口不借其权限", () => {
    const runtime = Memory.runtime as unknown as Record<string, unknown>;
    const getter = jest.fn(() => ({ schemaVersion: -1 }));
    Object.defineProperty(runtime, TREASURY_T2_LANE.controlMirrorKey, { get: getter, enumerable: true, configurable: true });
    expect(hasTreasuryTerminalFence(T2_TARGET)).toBe(true);
    expect(hasTreasuryT1TerminalFence()).toBe(false); expect(getter).not.toHaveBeenCalled();
    expect(TREASURY_TERMINAL_LANES).toHaveLength(4);
  });
});
