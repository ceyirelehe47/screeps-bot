import { shouldPauseNativeMineralHarvest } from "@/runtime/mineralHarvestPolicy";
import { recordBaseMineralOverflow, type BaseMineralOverflowObservation } from "@/runtime/baseMineralOverflow";
import type { MarketProtectionEntry } from "@/runtime/marketSaleProtection";

function roomWithMineral(stock: number, free = 300_000): Room {
  return { name: "E1N1", storage: { store: { getUsedCapacity: () => stock, getFreeCapacity: () => free } },
    terminal: { store: { getUsedCapacity: () => 0 } },
  } as unknown as Room;
}
function noBid(stock = 200_000): void {
  const entry = { roomName: "E1N1", resource: RESOURCE_CATALYST, totalStock: stock, terminalStock: 5_000,
    protectedAmount: 16_000, forecastBuffer: 16_000, managedExposure: 0, fresh: true, blocked: false,
    revision: Game.time, observedAt: Game.time, expiresAt: Game.time } as MarketProtectionEntry;
  recordBaseMineralOverflow([entry], Game.time, { "E1N1:X": "no_bid" });
}
describe("原矿停采作为最后手段", () => {
  beforeEach(() => { Memory.runtime = {}; Memory.cfg = {}; Game.rooms = {}; });
  it("高库存本身不停采；连续五轮无买单才暂停，降至溢出线以下恢复", () => {
    expect(shouldPauseNativeMineralHarvest(roomWithMineral(2_942_223), RESOURCE_CATALYST)).toBe(false);
    for (let index = 0; index < 4; index++) { noBid(); expect(shouldPauseNativeMineralHarvest(roomWithMineral(200_000), RESOURCE_CATALYST)).toBe(false); Game.time++; }
    noBid();
    expect(shouldPauseNativeMineralHarvest(roomWithMineral(200_000), RESOURCE_CATALYST)).toBe(true);
    expect(shouldPauseNativeMineralHarvest(roomWithMineral(60_000), RESOURCE_CATALYST)).toBe(true);
    expect(shouldPauseNativeMineralHarvest(roomWithMineral(46_000), RESOURCE_CATALYST)).toBe(false);
  });
  it("仓储承压立即停止，原因可查；观测过期不能绕过停采滞回", () => {
    const pressureRoom = roomWithMineral(200_000, 99_999);
    Game.rooms[pressureRoom.name] = pressureRoom;
    noBid();
    const before = JSON.stringify(Memory.runtime);
    expect(shouldPauseNativeMineralHarvest(pressureRoom, RESOURCE_CATALYST)).toBe(true);
    expect(JSON.stringify(Memory.runtime)).toBe(before);
    const observation = (Memory.runtime as unknown as { baseMineralOverflow: { entries: Record<string, BaseMineralOverflowObservation> } }).baseMineralOverflow.entries["E1N1:X"];
    expect(observation.paused).toBe("storage_full");
    Game.time += 201;
    expect(shouldPauseNativeMineralHarvest(roomWithMineral(200_000), RESOURCE_CATALYST)).toBe(true);
    Game.rooms.E1N1 = roomWithMineral(46_000);
    expect(shouldPauseNativeMineralHarvest(Game.rooms.E1N1, RESOURCE_CATALYST)).toBe(false);
    noBid(46_000);
    expect(shouldPauseNativeMineralHarvest(roomWithMineral(46_000), RESOURCE_CATALYST)).toBe(false);
  });
});
