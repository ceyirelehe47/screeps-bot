import * as runtimeServices from "@/runtime/runtimeServices";
import { prepareTreasuryT3FirstLive, armTreasuryT3FirstLive, heartbeatTreasuryT3FirstLive,
  readTreasuryT3FirstLiveControl, treasuryT3FirstLiveAllows } from "@/runtime/treasuryT3FirstLiveControl";
import { armTreasuryT1FirstLive } from "@/runtime/treasuryT1FirstLiveControl";
import { armTreasuryT2FirstLive } from "@/runtime/treasuryT2FirstLiveControl";
import { beginTreasuryProductionTick, endTreasuryProductionTick, registerTreasuryProductionTerminalTransfer,
  runTreasuryTerminalTransferTask } from "@/runtime/treasuryTerminalTransfer";
import { executeTreasuryFencedTerminalCargo, isTerminalCargoBlocked } from "@/runtime/treasuryTerminalCargo";
import { hasTreasuryTerminalFence } from "@/runtime/treasuryTaskCommitmentBridge";
import { initializeT3, t3Task, t3Room, t3Ledger, T3_SOURCE, T3_TARGET, T3MutableStore } from "../../test/treasuryT3Fixture";

describe("T3准备授权保护真实task并保留自然stage通路", () => {
  let context: ReturnType<typeof initializeT3>;
  let serviceSpy: jest.SpyInstance;
  beforeAll(() => expect(registerTreasuryProductionTerminalTransfer()).toBe(true));
  beforeEach(() => {
    context = initializeT3(913);
    (context.source.terminal!.store as T3MutableStore)[RESOURCE_HYDROXIDE] = 0;
    (context.source.storage!.store as T3MutableStore)[RESOURCE_HYDROXIDE] = 913;
    serviceSpy = jest.spyOn(runtimeServices, "getTreasuryService").mockReturnValue(context.treasury);
  });
  afterEach(() => { endTreasuryProductionTick(); serviceSpy.mockRestore(); });

  it("Terminal0+Storage913可prepare，只hold旧writer且cargo可自然stage26", () => {
    expect(prepareTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(true);
    expect(readTreasuryT3FirstLiveControl()).toMatchObject({ status: "valid", value: { status: "preparing", maxSliceAmount: 26 } });
    expect(treasuryT3FirstLiveAllows(context.task, 26)).toBe(false);
    beginTreasuryProductionTick();
    expect(runTreasuryTerminalTransferTask(context.task, t3Ledger(context.target, [context.task]), true, jest.fn()).handled).toBe(true);
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
    expect((Memory.runtime as unknown as Record<string, unknown>).treasuryProductionT3Quota).toBeUndefined();
    expect(context.treasury.kernelJournal().active).toHaveLength(0);
    expect(isTerminalCargoBlocked(context.source.terminal)).toBe(false);
    const stage = jest.fn(() => {
      (context.source.storage!.store as T3MutableStore)[RESOURCE_HYDROXIDE]! -= 26;
      (context.source.terminal!.store as T3MutableStore)[RESOURCE_HYDROXIDE] = 26;
      return OK;
    });
    expect(executeTreasuryFencedTerminalCargo(context.source.terminal, stage)).toBe(OK);
    expect(stage).toHaveBeenCalledTimes(1);
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(false);
    endTreasuryProductionTick(); Game.time += 1;
    expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(true);
    expect(isTerminalCargoBlocked(context.source.terminal)).toBe(true);
    expect(beginTreasuryProductionTick()).toBe(true);
    runTreasuryTerminalTransferTask(context.task, t3Ledger(context.target, [context.task]), true, jest.fn());
    expect((context.source.terminal!.send as jest.Mock).mock.calls[0].slice(0, 3)).toEqual([RESOURCE_HYDROXIDE, 26, T3_TARGET]);
  });

  it("prepare→arm保留600tick和30分钟固定起点，心跳只能更新lease", () => {
    const now = Date.now(); const clock = jest.spyOn(Date, "now").mockReturnValue(now);
    try {
      expect(prepareTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(true);
      const before = readTreasuryT3FirstLiveControl(); if (before.status !== "valid") throw Error("missing prepared control");
      clock.mockReturnValue(now + 30_000); Game.time = 110;
      expect(heartbeatTreasuryT3FirstLive().ok).toBe(true);
      (context.source.terminal!.store as T3MutableStore)[RESOURCE_HYDROXIDE] = 26;
      (context.source.storage!.store as T3MutableStore)[RESOURCE_HYDROXIDE] = 887;
      expect(armTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(true);
      const after = readTreasuryT3FirstLiveControl(); if (after.status !== "valid") throw Error("missing active control");
      expect(after.value).toMatchObject({ status: "active", startedAtTick: before.value.startedAtTick,
        startedAtMs: before.value.startedAtMs, deadlineTick: before.value.deadlineTick,
        deadlineMs: before.value.deadlineMs, maxSliceAmount: 26 });
      expect(after.value.deadlineTick).toBe(700); expect(after.value.deadlineMs).toBe(now + 30 * 60_000);
    } finally { clock.mockRestore(); }
  });

  it.each(["taskId", "createdAt", "cap"])("prepared不能用不同%s升级arm", (field) => {
    expect(prepareTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(true);
    (context.source.terminal!.store as T3MutableStore)[RESOURCE_HYDROXIDE] = 26;
    (context.source.storage!.store as T3MutableStore)[RESOURCE_HYDROXIDE] = 887;
    const other = { ...t3Task(913), id: "other-OH" };
    if (field === "taskId") Memory.data!.resourceControl!.tasks[other.id] = other;
    expect(armTreasuryT3FirstLive(field === "taskId" ? other.id : context.task.id,
      context.task.createdAt + (field === "createdAt" ? 1 : 0), field === "cap" ? 27 : 26).ok).toBe(false);
    expect(readTreasuryT3FirstLiveControl()).toMatchObject({ status: "valid", value: { status: "preparing", maxSliceAmount: 26 } });
    expect(context.source.terminal!.send).not.toHaveBeenCalled();
  });

  it("preparing失联60s自动OFF，原ordinary task被交回且无quota/native", () => {
    const now = Date.now(); const clock = jest.spyOn(Date, "now").mockReturnValue(now);
    try {
      expect(prepareTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(true);
      clock.mockReturnValue(now + 60_000); Game.time += 1;
      expect(beginTreasuryProductionTick()).toBe(false);
      expect(readTreasuryT3FirstLiveControl()).toMatchObject({ status: "valid", value: {
        status: "closed", closeReason: "control_lease_expired" } });
      expect((Memory.cfg as unknown as Record<string, { mode: string }>).treasuryTerminalTransferT3.mode).toBe("off");
      expect(runTreasuryTerminalTransferTask(context.task, t3Ledger(context.target, [context.task]), true, jest.fn()))
        .toEqual({ handled: false });
      expect(hasTreasuryTerminalFence(T3_SOURCE)).toBe(false); expect(hasTreasuryTerminalFence(T3_TARGET)).toBe(false);
      expect(context.task.remainingAmount).toBe(913);
      expect((Memory.runtime as unknown as Record<string, unknown>).treasuryProductionT3Quota).toBeUndefined();
      expect(context.source.terminal!.send).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it.each(["T1", "T2"])("preparing T3拒绝%s新授权，旧lane不借preparing通路", (name) => {
    const hSource = t3Room("E3N59", { [RESOURCE_HYDROGEN]: 1000, [RESOURCE_ENERGY]: 10_000 }); Game.rooms[hSource.name] = hSource;
    const old = name === "T1"
      ? { ...t3Task(25), id: "H-other-lane", fromRoomName: hSource.name, toRoomName: T3_SOURCE,
        resource: RESOURCE_HYDROGEN, origin: "manual" as const, reason: undefined }
      : { ...t3Task(25), id: "UH-other-lane", resource: RESOURCE_UTRIUM_HYDRIDE };
    Memory.data!.resourceControl!.tasks[old.id] = old;
    (context.source.terminal!.store as T3MutableStore)[RESOURCE_UTRIUM_HYDRIDE] = 1000;
    (context.target.terminal!.store as T3MutableStore)[RESOURCE_UTRIUM_HYDRIDE] = 0;
    expect(prepareTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(true);
    const arm = name === "T1" ? armTreasuryT1FirstLive : armTreasuryT2FirstLive;
    expect(arm(old.id, old.createdAt).ok).toBe(false);
    expect(context.source.terminal!.send).not.toHaveBeenCalled(); expect(hSource.terminal!.send).not.toHaveBeenCalled();
  });

  it("旧T2 active时不prepare T3，不改旧grant", () => {
    const uh = { ...t3Task(25), id: "active-UH", resource: RESOURCE_UTRIUM_HYDRIDE };
    Memory.data!.resourceControl!.tasks[uh.id] = uh;
    (context.source.terminal!.store as T3MutableStore)[RESOURCE_UTRIUM_HYDRIDE] = 1000;
    (context.target.terminal!.store as T3MutableStore)[RESOURCE_UTRIUM_HYDRIDE] = 0;
    expect(armTreasuryT2FirstLive(uh.id, uh.createdAt).ok).toBe(true);
    const old = JSON.stringify((Memory.runtime as unknown as Record<string, unknown>).treasuryT2FirstLiveControl);
    expect(prepareTreasuryT3FirstLive(context.task.id, context.task.createdAt, 26).ok).toBe(false);
    expect(JSON.stringify((Memory.runtime as unknown as Record<string, unknown>).treasuryT2FirstLiveControl)).toBe(old);
    expect(readTreasuryT3FirstLiveControl().status).toBe("absent");
  });
});
