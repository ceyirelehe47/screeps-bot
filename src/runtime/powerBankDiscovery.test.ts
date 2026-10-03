import {
  countFreeAdjacentTiles,
  recordPowerBankDiscovery,
  ensureDiscoveryStore,
  cleanupStaleDiscoveries,
} from "@/runtime/powerBankDiscovery";
import { createMockPowerBank } from "@mock/powerBank";
import { getPowerBankLifecycleFailure } from "@/runtime/powerBankTaskState";

class MockRoomPosition {
  constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}
}

const createMockTerrain = (grid: number[][]) => ({
  get: (x: number, y: number) => grid[y]?.[x] ?? 0,
});


describe("powerBankDiscovery", () => {
  beforeEach(() => {
    Object.assign(global, {
      RoomPosition: MockRoomPosition,
    });
    Memory.data = {};
    if (!Game.map) {
      (Game as any).map = {} as GameMap;
    }
  });

  describe("countFreeAdjacentTiles", () => {
    it("returns 8 for open plains terrain around position", () => {
      const allPlains = Array.from({ length: 50 }, () => Array(50).fill(0));
      Game.map.getRoomTerrain = jest.fn(() => createMockTerrain(allPlains) as any);

      const pos = new RoomPosition(25, 25, "E0N60") as unknown as RoomPosition;
      expect(countFreeAdjacentTiles(pos)).toBe(8);
    });
  });

  describe("recordPowerBankDiscovery", () => {

    it("接受原名单外高速房的Bank，拒绝非高速房", () => {
      Game.map.getRoomTerrain = jest.fn(() => createMockTerrain(Array.from({ length: 50 }, () => Array(50).fill(0))) as any);
      recordPowerBankDiscovery(createMockPowerBank({ id: "pb-outside-list", roomName: "W20S7" }));
      recordPowerBankDiscovery(createMockPowerBank({ id: "pb-invalid-room", roomName: "E3N59" }));
      expect(ensureDiscoveryStore()["pb-outside-list"]).toMatchObject({ targetRoom: "W20S7", status: "discovered" });
      expect(ensureDiscoveryStore()["pb-invalid-room"]).toBeUndefined();
    });

    it("updates lastSeenTick and stats on duplicate sightings", () => {
      Game.map.getRoomTerrain = jest.fn(() => createMockTerrain(Array.from({ length: 50 }, () => Array(50).fill(0))) as any);

      const bank = createMockPowerBank({ id: "pb-1", roomName: "E3N60", hits: 2000000 });

      Game.time = 100;
      recordPowerBankDiscovery(bank);

      Game.time = 200;
      const updatedBank = createMockPowerBank({ id: "pb-1", roomName: "E3N60", hits: 1500000, power: 5000, ticksToDecay: 3800 });
      recordPowerBankDiscovery(updatedBank);

      const store = ensureDiscoveryStore();
      const task = store["pb-1"];
      expect(task.discoveredTick).toBe(100);
      expect(task.lastSeenTick).toBe(200);
      expect(task.hits).toBe(1500000);
      expect(task.ticksToDecay).toBe(3800);
    });
  });

  it("旧清理周期不丢弃正在等待Observer的发现任务", () => {
    Game.time = 100;
    Game.map.getRoomTerrain = jest.fn(() => createMockTerrain(Array.from({ length: 50 }, () => Array(50).fill(0))) as any);
    recordPowerBankDiscovery(createMockPowerBank({ id: "pb-await-vision", roomName: "E3N60", ticksToDecay: 4000 }));
    const task = ensureDiscoveryStore()["pb-await-vision"];
    task.blocker = "target_not_visible";
    Game.time = 700;
    cleanupStaleDiscoveries();
    expect(ensureDiscoveryStore()[task.id]).toBe(task);
  });

  it.each(["target_combat_threat", "path_measurement_pending"])("等待 %s 超过500 tick后他人攻击Bank不清除准入门", (blocker) => {
    Game.time = 100;
    Game.map.getRoomTerrain = jest.fn(() => createMockTerrain(Array.from({ length: 50 }, () => Array(50).fill(0))) as any);
    recordPowerBankDiscovery(createMockPowerBank({ id: "pb-wait-progress", roomName: "E3N60", hits: 2_000_000, ticksToDecay: 4000 }));
    const task = ensureDiscoveryStore()["pb-wait-progress"];
    task.blocker = blocker;
    task.nextAttemptAt = 705;

    // 等同 Observer 在 Harvest 之前 record 可见、正在被他人击打的Bank。
    Game.time = 700;
    recordPowerBankDiscovery(createMockPowerBank({ id: task.id, roomName: "E3N60", hits: 1_000_000, ticksToDecay: 3400 }));
    expect(task).toMatchObject({
      status: "discovered", blocker, nextAttemptAt: 705, stageEnteredAt: 100,
      lastSeenTick: 700, lastBankProgressAt: 700, lastProgressAt: 700,
      hits: 1_000_000, bankExpiresAt: 4100,
    });
    expect(getPowerBankLifecycleFailure(task)).toBeUndefined();
    expect(getPowerBankLifecycleFailure({ ...task, blocker: undefined })).toBe("stage_timeout:discovered");
    Game.time = 4100;
    expect(getPowerBankLifecycleFailure(task)).toBe("bank_expired");
  });

  it("活动任务的Bank hit进展仍清理blocker与retry", () => {
    Game.time = 100;
    Game.map.getRoomTerrain = jest.fn(() => createMockTerrain(Array.from({ length: 50 }, () => Array(50).fill(0))) as any);
    recordPowerBankDiscovery(createMockPowerBank({ id: "pb-active-progress", roomName: "E3N60", hits: 2_000_000 }));
    const task = ensureDiscoveryStore()["pb-active-progress"];
    task.status = "attacking";
    task.blocker = "attack_no_progress";
    task.nextAttemptAt = 105;
    Game.time = 101;
    recordPowerBankDiscovery(createMockPowerBank({ id: task.id, roomName: "E3N60", hits: 1_000_000 }));
    expect(task.lastBankProgressAt).toBe(101);
    expect(task.lastProgressAt).toBe(101);
    expect(task.blocker).toBeUndefined();
    expect(task.nextAttemptAt).toBeUndefined();
  });
});
