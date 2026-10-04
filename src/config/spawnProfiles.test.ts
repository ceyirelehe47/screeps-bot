import {
  getLinkMinerBodyForRegenSourceLevel,
  getLinkMinerWorkPartsForRegenSourceLevel,
  spawnProfiles,
} from "@/config/spawnProfiles";
import { buildStandardCarrierBody } from "@/runtime/carrierBodyPolicy";

function bodyCost(body: BodyPartConstant[]): number {
  return body.reduce((sum, part) => sum + BODYPART_COST[part], 0);
}

function makeRoom(energyCapacityAvailable: number): Room {
  return { energyCapacityAvailable } as Room;
}

describe("spawnProfiles", () => {
  it.each(["worker", "colonizerWorker", "crossShardColonizerWorker"] as const)(
    "%s 在高容量房间保留 16 个完整工作组",
    role => {
      for (const capacity of [3_400, 5_600, 12_900]) {
        const body = spawnProfiles[role](makeRoom(capacity));
        expect(body).toHaveLength(48);
        expect(body.filter(part => part === WORK)).toHaveLength(16);
        expect(body.filter(part => part === CARRY)).toHaveLength(16);
        expect(body.filter(part => part === MOVE)).toHaveLength(16);
        expect(bodyCost(body)).toBe(3_200);
      }
    },
  );

  it("worker 在能量与体型边界按完整组缩放", () => {
    for (const [capacity, units] of [
      [300, 1], [399, 1], [400, 2], [3_199, 15], [3_200, 16], [3_399, 16],
    ]) {
      const body = spawnProfiles.worker(makeRoom(capacity));
      expect(body).toHaveLength(units * 3);
      expect(body.filter(part => part === WORK)).toHaveLength(units);
      expect(body.filter(part => part === CARRY)).toHaveLength(units);
      expect(body.filter(part => part === MOVE)).toHaveLength(units);
      expect(bodyCost(body)).toBe(units * 200);
      expect(bodyCost(body)).toBeLessThanOrEqual(capacity);
    }
  });

  it("keeps representative fixed and shared production body contracts", () => {
    const hubUpgrader = (
      spawnProfiles as unknown as Record<string, (room: Room) => BodyPartConstant[]>
    ).hubUpgrader;
    const room = makeRoom(5_600);
    const upgraderBody = hubUpgrader(room);
    const carrierBody = buildStandardCarrierBody(room.energyCapacityAvailable);

    expect(upgraderBody).toHaveLength(30);
    expect(upgraderBody.filter(part => part === WORK)).toHaveLength(15);
    expect(upgraderBody.filter(part => part === CARRY)).toHaveLength(5);
    expect(upgraderBody.filter(part => part === MOVE)).toHaveLength(10);
    expect(bodyCost(upgraderBody)).toBe(2_250);
    expect(spawnProfiles.carrier(room)).toEqual(carrierBody);
    expect(spawnProfiles.remoteCarrier(room)).toEqual(carrierBody);
    expect(carrierBody.filter(part => part === CARRY)).toHaveLength(20);
    expect(carrierBody.filter(part => part === MOVE)).toHaveLength(20);

    const boostedMiner = getLinkMinerBodyForRegenSourceLevel(4);
    expect(getLinkMinerWorkPartsForRegenSourceLevel(4)).toBe(12);
    expect(boostedMiner.filter(part => part === WORK)).toHaveLength(12);
    expect(boostedMiner.filter(part => part === CARRY)).toHaveLength(8);
    expect(boostedMiner.filter(part => part === MOVE)).toHaveLength(10);
    expect(bodyCost(boostedMiner)).toBe(2_100);
  });

  it("keeps complete-unit scaling boundaries and minimum-body fallbacks", () => {
    for (const [energyCapacity, unitCount, expectedCost] of [
      [3_999, 15, 3_750],
      [4_000, 16, 4_000],
      [4_250, 16, 4_000],
    ] as const) {
      const room = makeRoom(energyCapacity);
      const body = spawnProfiles.mineralHarvester(room);

      expect(body).toEqual(
        Array.from({ length: unitCount }, () => [WORK, WORK, MOVE]).flat(),
      );
      expect(bodyCost(body)).toBe(expectedCost);
      expect(bodyCost(body)).toBeLessThanOrEqual(room.energyCapacityAvailable);
    }

    const reserverRoom = makeRoom(100);
    const workerRoom = makeRoom(200);
    expect(spawnProfiles.remoteMiningReserver(reserverRoom)).toEqual([WORK, CARRY, MOVE]);
    expect(spawnProfiles.remoteWorker(workerRoom)).toEqual([WORK, CARRY, MOVE]);
  });
});
