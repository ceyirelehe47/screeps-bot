import { shouldPauseEnergyExtraction, shouldPauseRemoteEnergyExtraction } from "@/runtime/energyInflowGuard";

function bindRoom(input: {
  storageEnergy?: number;
  terminalEnergy?: number;
  available?: number;
  storageFree?: number | null;
} = {}): void {
  Game.rooms.E1N57 = {
    controller: { my: true },
    energyAvailable: input.available ?? 300,
    energyCapacityAvailable: 300,
    storage: {
      store: {
        getUsedCapacity: () => input.storageEnergy ?? 300_000,
        getFreeCapacity: () => input.storageFree,
      },
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

describe("shouldPauseRemoteEnergyExtraction", () => {
  it("母房 pressure 且库存高于本地目标，Storage 仍有真实余量时外矿继续采集", () => {
    bindRoom({ storageFree: 100_000 });
    bindPressure("pressure");
    expect(shouldPauseEnergyExtraction("E1N57")).toBe(true);
    expect(shouldPauseRemoteEnergyExtraction("E1N57")).toBe(false);
  });

  it("实际接收余量不足 5000 才暂停，恢复空间后无需改变压力标签便恢复", () => {
    bindPressure("pressure");
    bindRoom({ storageFree: 4_999 });
    expect(shouldPauseRemoteEnergyExtraction("E1N57")).toBe(true);
    bindRoom({ storageFree: 5_000 });
    expect(shouldPauseRemoteEnergyExtraction("E1N57")).toBe(false);
    bindRoom({ storageFree: 100_000 });
    expect(shouldPauseRemoteEnergyExtraction("E1N57")).toBe(false);
    expect(shouldPauseEnergyExtraction("E1N57")).toBe(true);
  });

  it("扣除当前实际容量承诺，不把 remaining 政策目标或旧快照当占用", () => {
    bindRoom({ storageFree: 10_000 });
    bindPressure("normal");
    const state = Memory.runtime!.resourceControl!.rooms.E1N57;
    Object.assign(state, { localOffloadCapacityCommitment: 2_000,
      capacityReservation: { committed: 3_001, remaining: 999_999 } });
    expect(shouldPauseRemoteEnergyExtraction("E1N57")).toBe(true);
    Object.assign(state, { capacityReservation: { committed: 3_000, remaining: 999_999 } });
    expect(shouldPauseRemoteEnergyExtraction("E1N57")).toBe(false);
    Object.assign(state, { localOffloadCapacityCommitment: -100_000,
      capacityReservation: { committed: Infinity, remaining: 999_999 } });
    expect(shouldPauseRemoteEnergyExtraction("E1N57")).toBe(false);
    Game.time += 1;
    Object.assign(state, { localOffloadCapacityCommitment: 100_000 });
    expect(shouldPauseRemoteEnergyExtraction("E1N57")).toBe(false);
  });

  it("powered Storage 超容量后的有限负余量按零空间暂停", () => {
    bindRoom({ storageFree: -1 });
    bindPressure("normal");
    expect(shouldPauseRemoteEnergyExtraction("E1N57")).toBe(true);
  });

  it.each([undefined, null, NaN, Infinity])("没有有限有效容量证据不伪判暂停（%s）", (storageFree) => {
    bindRoom({ storageFree });
    bindPressure("pressure");
    expect(shouldPauseRemoteEnergyExtraction("E1N57")).toBe(false);
  });

  it("无己方来源或 Storage 不伪判暂停；缺 ResourceControl 仍可按实际满仓保护", () => {
    delete Game.rooms.E1N57;
    expect(shouldPauseRemoteEnergyExtraction("E1N57")).toBe(false);
    Game.rooms.E1N57 = { controller: { my: true } } as unknown as Room;
    expect(shouldPauseRemoteEnergyExtraction("E1N57")).toBe(false);
    bindRoom({ storageFree: 0 });
    Memory.runtime = {};
    expect(shouldPauseRemoteEnergyExtraction("E1N57")).toBe(true);
    Game.rooms.E1N57 = { controller: { my: false }, storage: Game.rooms.E1N57.storage } as unknown as Room;
    expect(shouldPauseRemoteEnergyExtraction("E1N57")).toBe(false);
  });
});
