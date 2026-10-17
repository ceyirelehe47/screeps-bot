import {
  createMarketDirectContinuousDetachedBookSnapshot,
  issueMarketDirectContinuousInvocationBookCapability,
  planMarketDirectContinuous,
  type MarketDirectContinuousEntryInput,
  type MarketDirectContinuousDetachedBookSnapshot,
  type PlanMarketDirectContinuousInput,
} from "@/runtime/marketDirectContinuousPlanner";
import type { MarketOrderSnapshot } from "@/runtime/marketSalePricing";

function order(
  id: string,
  resourceType: string,
  price: number,
  amount = 1_000,
  roomName = "E20S20",
): MarketOrderSnapshot {
  return {
    id,
    type: "buy",
    resourceType,
    price,
    amount,
    roomName,
  };
}

const ENTRY_DEFAULTS = {
  X: {
    roomName: "E6N59",
    hardNetFloor: 600,
    economicNetFloor: 600,
    minExecutableNotional: 600_000,
    cap: 8_000,
    requireNativeMineral: false,
  },
  H: {
    roomName: "E3N59",
    hardNetFloor: 428,
    economicNetFloor: 451,
    minExecutableNotional: 451_000,
    cap: 8_000,
    requireNativeMineral: true,
  },
  Z: {
    roomName: "E7N57",
    hardNetFloor: 43,
    economicNetFloor: 45,
    minExecutableNotional: 45_000,
    cap: 5_000,
    requireNativeMineral: true,
  },
} as const;


function planningInput(
  entries: readonly MarketDirectContinuousEntryInput[],
  globalOverrides: Partial<PlanMarketDirectContinuousInput["globalQuota"]> = {},
): PlanMarketDirectContinuousInput {
  return {
    entries,
    energyShadow: {
      complete: true,
      revision: "energy-shadow-v1",
      price: 32.06,
    },
    globalQuota: {
      complete: true,
      revision: "global-quota-v1",
      rollingCap: 12_000,
      confirmedAmount: 0,
      unmatchedPlannedAmount: 0,
      ...globalOverrides,
    },
    writeContext: {
      complete: true,
      revision: "write-v1",
      credits: 10_000_000,
      executorShard: "shard1",
      permitEpoch: 1,
      permitId: "permit-1",
      permitHead: "head-1",
      pendingState: "none",
      arbiterState: "available",
    },
  };
}

function v3Entry(
  resourceType: keyof typeof ENTRY_DEFAULTS,
  roomNames: readonly string[],
  orders: readonly MarketOrderSnapshot[],
  calculateTransactionEnergy:
    NonNullable<MarketDirectContinuousEntryInput["calculateTransactionEnergy"]> =
      (amount) => amount === 1 ? 1 : 100,
): MarketDirectContinuousEntryInput {
  const defaults = ENTRY_DEFAULTS[resourceType];
  return {
    policy: {
      entryId: `v3-${resourceType.toLowerCase()}`,
      revision: `${resourceType}-policy-v3`,
      resourceType,
      allowedRooms: roomNames,
      requireNativeMineral: true,
      grant: "continuous",
      hardNetFloor: defaults.hardNetFloor,
      economicNetFloor: defaults.economicNetFloor,
      minExecutableNotional: defaults.minExecutableNotional,
      maxRawOrders: 1_000,
      maxEligibleOrders: 200,
      maxTransactionEnergy: 1_000,
      terminalEnergyReserve: 25_000,
      resourceRollingCap: defaults.cap,
      opportunityReserve: 1_000,
      evaluatorVersion: 3,
    },
    quota: {
      complete: true,
      revision: `${resourceType}-quota-v3`,
      resourceType,
      rollingCap: defaults.cap,
      confirmedAmount: 0,
      unmatchedPlannedAmount: 0,
      opportunityReserveSatisfied: false,
    },
    book: {
      complete: true,
      revision: `${resourceType}-shared-book-v3`,
      orders,
      ownOrderIds: [],
    },
    calculateTransactionEnergy,
    lanes: roomNames.map((roomName) => ({
      lane: {
        roomName,
        resourceType,
        owned: true,
        hub: false,
        capacityEmergency: false,
        nativeMineralType: "O",
        authorization: "writable",
      },
      protection: {
        complete: true,
        revision: `${resourceType}-${roomName}-protection-v3`,
        sellableAmount: 100_000,
      },
      terminal: {
        revision: `${resourceType}-${roomName}-terminal-v3`,
        normal: true,
        ready: true,
        claimed: false,
        cooldown: 0,
        resourceAmount: 50_000,
        energy: 50_000,
        effectivePostDealEnergyReserve: 25_000,
      },
      quota: {
        complete: true,
        revision: `${resourceType}-${roomName}-quota-v3`,
        roomRollingCap: 5_000,
        roomConfirmedAmount: 0,
        roomUnmatchedPlannedAmount: 0,
        laneRollingCap: 3_000,
        laneConfirmedAmount: 0,
        laneUnmatchedPlannedAmount: 0,
      },
    })),
  };
}

function detachBook(
  entry: MarketDirectContinuousEntryInput,
): MarketDirectContinuousDetachedBookSnapshot {
  const detached = createMarketDirectContinuousDetachedBookSnapshot(entry.book!);
  if (!detached) throw new Error("detached book fixture failed");
  entry.book = detached.book;
  return detached;
}

function issueBookCapability(
  detached: MarketDirectContinuousDetachedBookSnapshot,
) {
  const capability = issueMarketDirectContinuousInvocationBookCapability(
    detached,
  );
  if (!capability) throw new Error("book capability fixture failed");
  return capability;
}

describe("multi-resource full-book tuple planner", () => {

  it("同 ID 同 canonical 内容只计一次；同 ID 冲突与跨资源复用均 fail closed", () => {
    const same = order("same", "X", 700, 1_000, "E3N3");
    const deduped = planMarketDirectContinuous(planningInput([
      v3Entry("X", ["E1N1"], [same, { ...same }], () => 0),
    ]));
    expect(deduped.complete).toBe(true);
    expect(deduped.safeCandidates).toHaveLength(1);

    const conflict = planMarketDirectContinuous(planningInput([
      v3Entry("X", ["E1N1"], [
        same,
        { ...same, price: 701 },
      ], () => 0),
    ]));
    expect(conflict).toMatchObject({
      complete: false,
      blocker: {
        reason: "duplicate_order_id",
        orderId: "same",
        detail: "same_resource_order_id_conflict",
      },
      safeCandidates: [],
    });

    const crossResource = planMarketDirectContinuous(planningInput([
      v3Entry("X", ["E1N1"], [
        order("cross", "X", 700, 1_000, "E3N3"),
      ], () => 0),
      v3Entry("H", ["E2N2"], [
        order("cross", "H", 700, 1_000, "E4N4"),
      ], () => 0),
    ]));
    expect(crossResource).toMatchObject({
      complete: false,
      blocker: {
        reason: "duplicate_order_id",
        orderId: "cross",
      },
      safeCandidates: [],
    });
  });

  it("多资源 artifact 精确保留排序、重复 ID、ownOrderIds 与可选字段", () => {
    const x = {
      ...order("x-low", "X", 1, 1_000, "E1N1"),
      created: -0,
      remainingAmount: 1_000,
      totalAmount: 1_000,
    };
    const h = {
      ...order("h-low", "H", 1, 1_000, "E2N2"),
      created: Number.POSITIVE_INFINITY,
    };
    const fastX = v3Entry("X", ["W1N1"], [{ ...x }, { ...x }], () => 0);
    const fastH = v3Entry("H", ["W2N2"], [{ ...h }, { ...h }], () => 0);
    fastX.book!.ownOrderIds = ["manual-b", "manual-a", "manual-a"];
    fastH.book!.ownOrderIds = ["manual-z", "manual-z"];
    const detachedBooks = [detachBook(fastX), detachBook(fastH)];
    const probe = jest.fn();
    const fast = planMarketDirectContinuous(
      planningInput([fastH, fastX]),
      {
        detachedBookCapabilities: detachedBooks.map(issueBookCapability),
        observeNormalizationArtifact: probe,
      },
    );

    const slowX = v3Entry("X", ["W1N1"], [{ ...x }, { ...x }], () => 0);
    const slowH = v3Entry("H", ["W2N2"], [{ ...h }, { ...h }], () => 0);
    slowX.book!.ownOrderIds = ["manual-a", "manual-b", "manual-a"];
    slowH.book!.ownOrderIds = ["manual-z", "manual-z"];
    const slow = planMarketDirectContinuous(planningInput([slowX, slowH]));

    expect(fast.complete).toBe(true);
    expect(fast.selected).toBeUndefined();
    expect(probe).toHaveBeenCalledWith(true);
    expect(fast.rejections).toEqual(slow.rejections);
    expect(fast.planningEvidence).toBe(slow.planningEvidence);
    expect(fast.planningFingerprint).toBe(slow.planningFingerprint);
  });
});


test("V3逐lane清仓价不外溢到同资源正常房，并在两读指纹中承诺", () => {
  const entry = v3Entry("X", ["E1N1", "E2N2"], [order("cheap", "X", 40)], () => 0);
  entry.lanes[0].pricing = { effectiveNetFloor: 1, minExecutableNotional: 1_000, tier: "liquidation" };
  const input = planningInput([entry]);
  const result = planMarketDirectContinuous(input);
  expect(result.complete).toBe(true);
  expect(result.safeCandidates.map(value => value.roomName)).toEqual(["E1N1"]);
  expect(result.selected).toMatchObject({ roomName: "E1N1", overflowTier: "liquidation", effectiveNetFloorMilli: 1_000 });
  const changed = { ...entry, lanes: entry.lanes.map((value, i) => i ? value : { ...value, pricing: { ...value.pricing!, effectiveNetFloor: 2 } }) };
  expect(planMarketDirectContinuous(planningInput([changed])).planningFingerprint).not.toBe(result.planningFingerprint);
});
