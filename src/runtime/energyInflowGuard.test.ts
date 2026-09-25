import { shouldPauseEnergyExtraction } from "@/runtime/energyInflowGuard";

function bindRoom(input: {
  storageEnergy?: number;
  terminalEnergy?: number;
  available?: number;
} = {}): void {
  Game.rooms.E1N57 = {
    controller: { my: true },
    energyAvailable: input.available ?? 300,
    energyCapacityAvailable: 300,
    storage: {
      store: { getUsedCapacity: () => input.storageEnergy ?? 300_000 },
    },
    terminal: {
      store: { getUsedCapacity: () => input.terminalEnergy ?? 30_000 },
    },
  } as unknown as Room;
}

function bindPressure(state: "normal" | "pressure" | "emergency", tick = Game.time): void {
  Memory.runtime = {
    resourceControl: {
      updatedAt: tick,
      rooms: {
        E1N57: {
          capacityState: state,
          storageEnergy: 300_000,
          terminalEnergy: 30_000,
          energyFloor: 120_000,
          energyTarget: 200_000,
          energyExportStart: 250_000,
          terminalEnergyReserve: 20_000,
        },
      },
    },
  } as unknown as NonNullable<Memory["runtime"]>;
}

describe("shouldPauseEnergyExtraction", () => {
  it("压力房间有充足生产与防御储备时暂停，空位恢复即自动恢复", () => {
    bindRoom();
    bindPressure("emergency");
    expect(shouldPauseEnergyExtraction("E1N57")).toBe(true);
    bindPressure("normal");
    expect(shouldPauseEnergyExtraction("E1N57")).toBe(false);
  });

  it("旧快照、低库存与紧急补充扩展时不暂停采集", () => {
    bindRoom();
    bindPressure("pressure", Game.time - 1);
    expect(shouldPauseEnergyExtraction("E1N57")).toBe(false);

    bindPressure("pressure");
    bindRoom({ storageEnergy: 199_999 });
    expect(shouldPauseEnergyExtraction("E1N57")).toBe(false);
    bindRoom({ terminalEnergy: 20_000 });
    expect(shouldPauseEnergyExtraction("E1N57")).toBe(false);
    bindRoom({ available: 100 });
    expect(shouldPauseEnergyExtraction("E1N57")).toBe(false);
  });
});
