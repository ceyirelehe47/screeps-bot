import {
  enableTreasuryContinuousOH, normalizeTreasuryContinuousOHControl, stopTreasuryContinuousOH,
} from "@/runtime/treasuryContinuousOHControl";
import { readTreasuryContinuousOHState } from "@/runtime/treasuryContinuousOHState";
import { TREASURY_T4_LANE } from "@/runtime/treasuryTerminalLane";
import { initializeT4 } from "../../test/treasuryT4Fixture";

describe("T4 停止交接必须读清原任务表", () => {
  function state() {
    const read = readTreasuryContinuousOHState();
    if (read.status !== "valid") throw Error("需要合法 T4 账本");
    return read.value;
  }
  function mode() {
    return (Memory.cfg as unknown as Record<string, { mode: string }>)[TREASURY_T4_LANE.configKey].mode;
  }

  it.each([null, [], "unreadable", { broken: null }, { broken: { id: "other" } }])(
    "损坏任务表 %j 在 stop/冷恢复时保持 drain，修复原表后才交还 OFF", (damaged) => {
      const clock = jest.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      try {
        const context = initializeT4(undefined);
        expect(enableTreasuryContinuousOH({ pilotTaskId: context.task.id,
          pilotTaskCreatedAt: context.task.createdAt, pilotTaskAmount: context.task.amount }).ok).toBe(true);
        const before = state();
        const originalTasks = Memory.data!.resourceControl!.tasks;
        const writtenModes: string[] = [];
        Memory.cfg = new Proxy(Memory.cfg!, {
          set(target, key, value) {
            if (key === TREASURY_T4_LANE.configKey) writtenModes.push(value.mode);
            return Reflect.set(target, key, value);
          },
        });
        (Memory.data!.resourceControl! as unknown as { tasks: unknown }).tasks = damaged;
        expect(stopTreasuryContinuousOH()).toEqual({ ok: false, reason: "task_store_unreadable" });
        expect(writtenModes).toEqual(["drain"]);
        expect(state()).toMatchObject({ sessionStatus: "stopping", stopReason: "operator_stop",
          deadlineTick: before.deadlineTick, deadlineMs: before.deadlineMs,
          sequenceHighWater: before.sequenceHighWater, consumption: before.consumption,
          closedCycles: before.closedCycles, currentCycle: null });
        expect(mode()).toBe("drain");

        // 换为实际序列化后读回的 Memory，旧 heap 校验不能完成停止交接。
        (global as unknown as { Memory: Memory }).Memory = JSON.parse(JSON.stringify(Memory));
        Game.time += 1; clock.mockReturnValue(1_800_000_001_000);
        expect(normalizeTreasuryContinuousOHControl()).toEqual({ ok: false, reason: "task_store_unreadable" });
        expect(state().sessionStatus).toBe("stopping");
        expect(state().consumption).toEqual(before.consumption);
        expect(mode()).toBe("drain");
        expect(context.source.terminal!.send).not.toHaveBeenCalled();

        Memory.data!.resourceControl!.tasks = originalTasks;
        expect(normalizeTreasuryContinuousOHControl()).toEqual({ ok: true, reason: "stopped" });
        expect(state().sessionStatus).toBe("stopped");
        expect(mode()).toBe("off");
        expect(context.source.terminal!.send).not.toHaveBeenCalled();
      } finally { clock.mockRestore(); }
    },
  );

  it("可读且无原责任的合法 stop 先 drain 再 OFF，保留原 session", () => {
    const clock = jest.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      const context = initializeT4(undefined);
      expect(enableTreasuryContinuousOH({ pilotTaskId: context.task.id,
        pilotTaskCreatedAt: context.task.createdAt, pilotTaskAmount: context.task.amount }).ok).toBe(true);
      const before = state();
      const writtenModes: string[] = [];
      Memory.cfg = new Proxy(Memory.cfg!, {
        set(target, key, value) {
          if (key === TREASURY_T4_LANE.configKey) writtenModes.push(value.mode);
          return Reflect.set(target, key, value);
        },
      });
      expect(stopTreasuryContinuousOH()).toEqual({ ok: true, reason: "stopped" });
      expect(writtenModes).toEqual(["drain", "off"]);
      expect(state()).toMatchObject({ sessionStatus: "stopped", sessionId: before.sessionId,
        deadlineTick: before.deadlineTick, deadlineMs: before.deadlineMs, consumption: before.consumption });
      expect(context.source.terminal!.send).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });
});
