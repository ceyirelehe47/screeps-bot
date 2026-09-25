import { shouldPauseNativeMineralHarvest } from "@/runtime/mineralHarvestPolicy";

function roomWithMineral(stock: number, terminalStock = 0): Room {
  return {
    storage: { store: { getUsedCapacity: () => stock } },
    terminal: { store: { getUsedCapacity: () => terminalStock } },
  } as unknown as Room;
}

describe("原矿净流入门禁", () => {
  it("在保护储备加生产缓冲以上暂停，出货降到阈值下方后恢复", () => {
    expect(shouldPauseNativeMineralHarvest(roomWithMineral(2_942_223), RESOURCE_CATALYST)).toBe(true);
    expect(shouldPauseNativeMineralHarvest(roomWithMineral(199_000, 999), RESOURCE_CATALYST)).toBe(false);
    expect(shouldPauseNativeMineralHarvest(roomWithMineral(199_000, 1_000), RESOURCE_CATALYST)).toBe(true);
    expect(shouldPauseNativeMineralHarvest(roomWithMineral(71_000), RESOURCE_CATALYST)).toBe(false);
  });
});
