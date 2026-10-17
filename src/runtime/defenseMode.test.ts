jest.mock("@/runtime/runtimeServices", () => ({
  getTickContextService: () => ({ getMyRooms: () => Object.values(Game.rooms), getRoomContext: () => undefined }),
  getMemoryService: () => ({ ensureRuntime: () => Memory.runtime ??= {} }),
}));
jest.mock("@/runtime/safeZone", () => ({ getSafeZone: jest.fn(), getSafeZonePlanRevision: jest.fn(() => 1) }));
jest.mock("@/modules/errorMapper", () => ({ reportRuntimeError: jest.fn() }));
import { isDefenseMode, runDefenseMode, clearDefenseModeCacheForTest } from "@/runtime/defenseMode";
import { getSafeZone, getSafeZonePlanRevision } from "@/runtime/safeZone";
import { resetRuntimeIsolationForTest, getRuntimeRoomFaults } from "@/runtime/runtimeIsolation";

beforeEach(() => {
  jest.clearAllMocks(); clearDefenseModeCacheForTest(); resetRuntimeIsolationForTest();
  Game.time++; Memory.runtime = {};
  Game.rooms = Object.fromEntries(["W1N1", "W2N2"].map(name => [name, { name, find: () => [] }])) as unknown as typeof Game.rooms;
  (getSafeZone as jest.Mock).mockImplementation(name => {
    if (name === "W1N1") throw new Error("bad-layout");
    return new Set([1]);
  });
  (getSafeZonePlanRevision as jest.Mock).mockReturnValue(1);
});

it("单房布局异常不传播到出生/移动调用方，故障房保守防御，其他房保持真实状态", () => {
  expect(() => runDefenseMode()).not.toThrow();
  expect(isDefenseMode("W1N1")).toBe(true);
  expect(isDefenseMode("W2N2")).toBe(false);
  expect(Memory.runtime?.defenseFaults?.faults).toEqual([expect.objectContaining({ scope: "defenseMode:W1N1" })]);
  expect(getSafeZone).toHaveBeenCalledTimes(2);
  Game.time++;
  (getSafeZone as jest.Mock).mockReturnValue(new Set([1]));
  expect(isDefenseMode("W1N1")).toBe(false);
});

it("同 tick revision 读取异常只使该房转入防御；下一 tick 仍重试", () => {
  (getSafeZone as jest.Mock).mockReturnValue(new Set([1]));
  runDefenseMode();
  (getSafeZonePlanRevision as jest.Mock).mockImplementation(name => { if (name === "W1N1") throw new Error("bad-revision"); return 1; });
  expect(() => runDefenseMode()).not.toThrow();
  expect(isDefenseMode("W1N1")).toBe(true);
  expect(isDefenseMode("W2N2")).toBe(false);
});

it("快照前后的 revision 读取成功不能掩盖连续的安全区计算故障", () => {
  for (let index = 0; index < 3; index++) {
    Game.time++;
    expect(isDefenseMode("W1N1")).toBe(true);
    runDefenseMode();
  }
  expect(getRuntimeRoomFaults().find(fault => fault.scope === "defenseMode:W1N1")?.streak).toBe(3);
});
