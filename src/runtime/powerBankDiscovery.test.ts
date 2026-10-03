import {
  countFreeAdjacentTiles,
  recordPowerBankDiscovery,
  ensureDiscoveryStore,
  cleanupStaleDiscoveries,
} from "@/runtime/powerBankDiscovery";
import { createMockPowerBank } from "@mock/powerBank";

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
});
