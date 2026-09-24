import {
  ensureReservationSchemaActivated,
  makeReservationStoreKey,
  reserveProductionResource,
  releaseProductionReservation,
  listProductionReservations,
} from "@/runtime/resourceReservation";
import { classifyTreasuryHolderIdAsOwner } from "@/runtime/treasury/ownerIdentity";

beforeEach(() => {
  Memory.runtime = {};
  Memory.cfg = {};
  Game.time = 1000;
});

describe("Treasury reservation activation", () => {
  const legacyKey = "E4N58:H:task:existing";
  const legacyEntry = {
    roomName: "E4N58",
    resource: RESOURCE_HYDROGEN,
    holderId: "task:existing",
    amount: 75,
    updatedAt: 900,
    expiresAt: 2000,
  };

  it("migrates a nonempty legacy store and keeps legacy writers on the new key", () => {
    Memory.runtime.resourceReservations = { [legacyKey]: { ...legacyEntry } };
    expect(ensureReservationSchemaActivated()).toEqual({ status: "ready" });
    const version = (Memory.runtime as unknown as { resourceReservationsOwnerVersion?: number })
      .resourceReservationsOwnerVersion;
    expect(version).toBe(4);
    const key = makeReservationStoreKey(
      "E4N58", RESOURCE_HYDROGEN, classifyTreasuryHolderIdAsOwner("task:existing"),
    );
    expect(Memory.runtime.resourceReservations[legacyKey]).toBeUndefined();
    expect(Memory.runtime.resourceReservations[key]?.amount).toBe(75);
    expect(reserveProductionResource("E4N58", RESOURCE_HYDROGEN, 80, "task:existing")).toMatchObject({
      status: "ok", mutated: true,
    });
    expect(Object.keys(Memory.runtime.resourceReservations)).toEqual([key]);
    expect(Memory.runtime.resourceReservations[key]?.amount).toBe(80);
  });

  it("preserves a damaged legacy store and rejects activation", () => {
    Memory.runtime.resourceReservations = { "wrong-key": { ...legacyEntry } };
    const before = JSON.stringify(Memory.runtime);
    expect(ensureReservationSchemaActivated()).toMatchObject({
      status: "rejected", reason: "migration_failed",
    });
    expect(JSON.stringify(Memory.runtime)).toBe(before);
  });
});

describe("resourceReservation", () => {
  describe("reserveProductionResource", () => {

    it("uses custom TTL when provided", () => {
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 500, "carrier1", 50);
      const entries = listProductionReservations();
      expect(entries[0].expiresAt).toBe(Game.time + 50);
    });
  });

  describe("releaseProductionReservation", () => {
    it("removes a specific holder reservation", () => {
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 500, "carrier1");
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 300, "carrier2");
      releaseProductionReservation("E4N58", "energy" as ResourceConstant, "carrier1");
      const entries = listProductionReservations();
      expect(entries).toHaveLength(1);
      expect(entries[0].holderId).toBe("carrier2");
    });
  });
});
