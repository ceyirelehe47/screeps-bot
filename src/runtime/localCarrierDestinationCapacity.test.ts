import {
  claimLocalCarrierDestinationCapacity,
  clearLocalCarrierDestinationCapacityForTest,
  getLocalCarrierDestinationAvailableAmount,
  getLocalCarrierDestinationCommittedAmount,
} from "@/runtime/localCarrierDestinationCapacity";
import {
  clearCreepAssignmentStateForTest,
  ensureCreepAssignmentState,
} from "@/runtime/creepAssignmentState";

function createStorage(
  id: string,
  roomName: string,
  getFreeCapacity: () => number,
): StructureStorage {
  return {
    id,
    structureType: STRUCTURE_STORAGE,
    pos: { x: 10, y: 10, roomName } as RoomPosition,
    store: {
      getFreeCapacity,
      getUsedCapacity: () => 0,
    } as StoreDefinition,
  } as unknown as StructureStorage;
}

function createCarrier(
  name: string,
  roomName: string,
  resource: ResourceConstant,
  amount: number,
): Creep {
  return {
    name,
    room: { name: roomName } as Room,
    store: {
      getUsedCapacity: (requested?: ResourceConstant) =>
        requested === undefined || requested === resource ? amount : 0,
      getFreeCapacity: () => 1_000 - amount,
    } as StoreDefinition,
  } as unknown as Creep;
}

describe("localCarrierDestinationCapacity", () => {
  beforeEach(() => {
    clearLocalCarrierDestinationCapacityForTest();
    clearCreepAssignmentStateForTest();
    Game.creeps = {};
    Game.time = 100;
  });

  it("reuses a claimant's seeded delivery commitment without double subtraction", () => {
    const storage = createStorage("storage-seeded-owner", "W1N2", () => 1_000);
    const carrier = createCarrier(
      "carrier-seeded-owner",
      "W1N2",
      RESOURCE_ENERGY,
      600,
    );
    Game.creeps[carrier.name] = carrier;
    Object.assign(ensureCreepAssignmentState(carrier.name), {
      carrierPlanMode: "deliver",
      carrierPlanTargetKind: "structure",
      carrierPlanTargetId: storage.id,
    });

    expect(getLocalCarrierDestinationCommittedAmount(storage.id)).toBe(600);
    const reused = claimLocalCarrierDestinationCapacity({
      claimantId: carrier.name,
      target: storage,
      resource: RESOURCE_ENERGY,
      requestedAmount: 600,
    });

    expect(reused?.amount).toBe(600);
    reused?.release();
    expect(getLocalCarrierDestinationCommittedAmount(storage.id)).toBe(600);
    expect(
      getLocalCarrierDestinationAvailableAmount(storage, RESOURCE_ENERGY),
    ).toBe(400);
  });

  it("shares total Store capacity across resources and releases failed claims", () => {
    const storage = createStorage("storage-shared", "W2N2", () => 1_000);
    const first = claimLocalCarrierDestinationCapacity({
      claimantId: "carrier-H",
      target: storage,
      resource: RESOURCE_HYDROGEN,
      requestedAmount: 800,
    });
    const second = claimLocalCarrierDestinationCapacity({
      claimantId: "carrier-O",
      target: storage,
      resource: RESOURCE_OXYGEN,
      requestedAmount: 800,
    });

    expect(first?.amount).toBe(800);
    expect(second?.amount).toBe(200);
    expect(getLocalCarrierDestinationCommittedAmount(storage.id)).toBe(1_000);
    expect(getLocalCarrierDestinationCommittedAmount(storage.id, RESOURCE_HYDROGEN)).toBe(800);
    expect(getLocalCarrierDestinationCommittedAmount(storage.id, RESOURCE_OXYGEN)).toBe(200);

    second?.release();
    expect(
      getLocalCarrierDestinationAvailableAmount(storage, RESOURCE_OXYGEN),
    ).toBe(200);
    first?.release();
    expect(getLocalCarrierDestinationCommittedAmount(storage.id)).toBe(0);
  });
});
