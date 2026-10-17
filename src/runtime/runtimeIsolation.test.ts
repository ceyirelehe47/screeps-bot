import { forEachIsolatedRoom, getRuntimeRoomFaults, resetRuntimeIsolationForTest } from "@/runtime/runtimeIsolation";
import { reportRuntimeError } from "@/modules/errorMapper";

jest.mock("@/modules/errorMapper", () => ({ reportRuntimeError: jest.fn() }));

describe("关键房间异常隔离", () => {
  beforeEach(() => { resetRuntimeIsolationForTest(); jest.clearAllMocks(); Game.time = 100; Memory.runtime = {}; Memory.cfg = { cpuProfiler: { enabled: false } }; });
  it("持续故障不熔断 T0，也不影响其余房间，重复报告限频", () => {
    const rooms = [{ name: "W1N1" }, { name: "W2N2" }] as Room[];
    const visited: string[] = [];
    for (let tick = 100; tick < 105; tick++) {
      Game.time = tick;
      forEachIsolatedRoom("towerControl", rooms, room => {
        visited.push(room.name);
        if (room.name === "W1N1") throw new Error("bad-room");
      });
    }
    expect(visited).toEqual(Array.from({ length: 5 }, () => ["W1N1", "W2N2"]).flat());
    expect(reportRuntimeError).toHaveBeenCalledTimes(1);
    expect(getRuntimeRoomFaults()).toEqual([expect.objectContaining({ scope: "towerControl:W1N1", failures: 5, suppressed: 4 })]);
    Game.time = 200;
    forEachIsolatedRoom("towerControl", rooms, () => { throw "bad-room"; });
    expect(reportRuntimeError).toHaveBeenCalledTimes(3);
  });
  it("日志设施异常仍继续，诊断范围有上限并过期", () => {
    (reportRuntimeError as jest.Mock).mockImplementationOnce(() => { throw "bad-logger"; });
    const rooms = Array.from({ length: 100 }, (_, index) => ({ name: `W${index}N1` })) as Room[];
    const work = jest.fn(() => { throw "bad-room"; });
    expect(() => forEachIsolatedRoom("homeDefense", rooms, work)).not.toThrow();
    expect(work).toHaveBeenCalledTimes(100);
    expect(getRuntimeRoomFaults()).toHaveLength(8);
    expect(Memory.runtime?.defenseFaults?.faults).toHaveLength(8);
    expect(JSON.stringify(Memory.runtime?.defenseFaults).length).toBeLessThan(4096);
    Game.time += 1001;
    forEachIsolatedRoom("homeDefense", [], () => undefined);
    expect(Memory.runtime?.defenseFaults).toBeUndefined();
    expect(getRuntimeRoomFaults()).toEqual([]);
  });
  it("健康入口不创建摘要；heap 重建后仍可读取未过期的故障并延续限频", () => {
    const rooms = [{ name: "W1N1" }] as Room[];
    forEachIsolatedRoom("homeDefense", rooms, () => undefined);
    expect(Memory.runtime?.defenseFaults).toBeUndefined();
    forEachIsolatedRoom("homeDefense", rooms, () => { throw new Error("persisted"); });
    expect(Memory.runtime?.defenseFaults?.faults).toHaveLength(1);
    resetRuntimeIsolationForTest(); Game.time++;
    forEachIsolatedRoom("homeDefense", rooms, () => { throw new Error("persisted"); });
    expect(getRuntimeRoomFaults()).toEqual([expect.objectContaining({ failures: 2, suppressed: 1 })]);
    expect(reportRuntimeError).toHaveBeenCalledTimes(1);
  });

});
