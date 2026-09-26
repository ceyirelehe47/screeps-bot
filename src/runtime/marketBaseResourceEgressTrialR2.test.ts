import {
  activeMarketEgressTrialR2,
  closeExpiredMarketEgressTrialR2,
  heartbeatMarketEgressTrialR2,
  readMarketEgressTrialR2,
  reserveMarketEgressTrialNative,
  startMarketEgressTrialR2,
  stopMarketEgressTrialR2,
  trialCooldownNotBefore,
} from "@/runtime/marketBaseResourceEgressTrialR2";

function pending(attemptSeq: number, attemptAt: number): string {
  const frozenEvidenceHash = `csh1:evidence-${attemptSeq}`;
  Memory.data = {
    marketSaleAutomation: {
      directAutomation: { baseResourceV3: { ledger: { pending: {
        attemptSeq, attemptAt, frozenEvidenceHash,
        plannedAmount: 1_000, executionPolicy: "continuous",
        historicalPermit: { permitId: "permit-r7" },
        historicalLane: { sellerRoom: "E4N58", resource: "X" },
      } } } },
    },
  } as unknown as Memory["data"];
  return frozenEvidenceHash;
}

function reserve(tick: number, attemptSeq: number, baselineNotBefore: number): boolean {
  const pendingEvidenceHash = pending(attemptSeq, tick);
  return reserveMarketEgressTrialNative({
    tick, permitId: "permit-r7", permitEpoch: 17, attemptSeq,
    pendingEvidenceHash, roomName: "E4N58", resource: "X",
    stage: "continuous", capacityState: "pressure",
    policyCooldownTicks: 100, amount: 1_000, baselineNotBefore,
  });
}

describe("one-run market egress R2 trial", () => {
  beforeEach(() => {
    Memory.runtime = {} as Memory["runtime"];
    Memory.data = {} as Memory["data"];
    jest.spyOn(Date, "now").mockReturnValue(1_000_000);
  });
  afterEach(() => jest.restoreAllMocks());

  it("keeps the old notBefore, persists call reservations, and cannot rearm", () => {
    const started = startMarketEgressTrialR2({
      tick: 100, permitId: "permit-r7", permitEpoch: 17,
      originalNotBefore: 500, nextAttemptSeq: 15,
    });
    expect(started.ok).toBe(true);
    if ("reason" in started) throw new Error(started.reason);
    expect(trialCooldownNotBefore(started.trial, 500)).toBe(500);
    expect(reserve(499, 15, 500)).toBe(false);
    expect(reserve(500, 15, 500)).toBe(true);
    expect(reserve(500, 15, 500)).toBe(false);
    expect(reserve(599, 16, 1_500)).toBe(false);
    Memory.runtime = JSON.parse(JSON.stringify(Memory.runtime)) as Memory["runtime"];
    expect(reserve(600, 16, 1_500)).toBe(true);
    const state = readMarketEgressTrialR2();
    expect(state.status).toBe("valid");
    if (state.status !== "valid") return;
    expect(state.value).toMatchObject({
      callsReserved: 2, amountReserved: 2_000, lastAttemptSeq: 16,
    });
    expect(trialCooldownNotBefore(state.value, 1_600)).toBe(700);
    expect(stopMarketEgressTrialR2("operator_stop")).toBe(true);
    expect(startMarketEgressTrialR2({ tick: 700, permitId: "permit-r7",
      permitEpoch: 17, originalNotBefore: 700, nextAttemptSeq: 17 }).ok).toBe(false);
  });

  it("counts failed or unknown native attempts against the permanent ten-call limit", () => {
    expect(startMarketEgressTrialR2({ tick: 100, permitId: "permit-r7",
      permitEpoch: 17, originalNotBefore: 500, nextAttemptSeq: 15 }).ok).toBe(true);
    for (let index = 0; index < 10; index += 1) {
      const tick = 500 + index * 100;
      expect(reserve(tick, 15 + index, tick + (index === 0 ? 0 : 900))).toBe(true);
    }
    expect(reserve(1_500, 25, 2_400)).toBe(false);
    closeExpiredMarketEgressTrialR2(1_500);
    const state = readMarketEgressTrialR2();
    expect(state.status).toBe("valid");
    if (state.status === "valid") {
      expect(state.value).toMatchObject({
        status: "closed", closeReason: "call_limit",
        callsReserved: 10, amountReserved: 10_000,
      });
    }
  });

  it("fails closed on a damaged mirror or wrong lane", () => {
    expect(startMarketEgressTrialR2({ tick: 100, permitId: "permit-r7",
      permitEpoch: 17, originalNotBefore: 100, nextAttemptSeq: 15 }).ok).toBe(true);
    const evidence = pending(15, 200);
    expect(reserveMarketEgressTrialNative({
      tick: 200, permitId: "permit-r7", permitEpoch: 17,
      attemptSeq: 15, pendingEvidenceHash: evidence,
      roomName: "E3N59", resource: "H", stage: "canary",
      capacityState: "pressure", policyCooldownTicks: 100,
      amount: 1_000, baselineNotBefore: 100,
    })).toBe(false);
    (Memory.runtime as unknown as Record<string, unknown>).marketBaseResourceEgressTrialR2Mirror = {};
    expect(readMarketEgressTrialR2().status).toBe("invalid");
    expect(activeMarketEgressTrialR2({ tick: 200, permitId: "permit-r7", permitEpoch: 17 })).toBeNull();
    expect(startMarketEgressTrialR2({ tick: 200, permitId: "permit-r7",
      permitEpoch: 17, originalNotBefore: 200, nextAttemptSeq: 15 }).ok).toBe(false);
  });

  it("closes at its fixed tick deadline", () => {
    expect(startMarketEgressTrialR2({ tick: 100, permitId: "permit-r7",
      permitEpoch: 17, originalNotBefore: 100, nextAttemptSeq: 15 }).ok).toBe(true);
    closeExpiredMarketEgressTrialR2(3_100);
    expect(readMarketEgressTrialR2()).toMatchObject({
      status: "valid", value: { status: "closed", closeReason: "tick_deadline" },
    });

  });

  it("closes when both rooms recover", () => {
    expect(startMarketEgressTrialR2({ tick: 100, permitId: "permit-r7",
      permitEpoch: 17, originalNotBefore: 100, nextAttemptSeq: 15 }).ok).toBe(true);
    (Memory.runtime as unknown as Record<string, unknown>).resourceControl = {
      updatedAt: 101,
      rooms: { E4N58: { capacityState: "normal" }, E1N57: { capacityState: "normal" } },
    };
    closeExpiredMarketEgressTrialR2(101);
    expect(readMarketEgressTrialR2()).toMatchObject({
      status: "valid", value: { status: "closed", closeReason: "capacity_recovered" },
    });
  });

  it("closes at the wall-clock deadline even if game ticks advance slowly", () => {
    expect(startMarketEgressTrialR2({ tick: 100, permitId: "permit-r7",
      permitEpoch: 17, originalNotBefore: 100, nextAttemptSeq: 15 }).ok).toBe(true);
    (Date.now as jest.Mock).mockReturnValue(4_600_000);
    expect(activeMarketEgressTrialR2({ tick: 101, permitId: "permit-r7",
      permitEpoch: 17 })).toBeNull();
    closeExpiredMarketEgressTrialR2(101);
    expect(readMarketEgressTrialR2()).toMatchObject({
      status: "valid", value: { status: "closed", closeReason: "wall_deadline" },
    });
  });

  it("stops new admission when the external observer misses its control lease", () => {
    expect(startMarketEgressTrialR2({ tick: 100, permitId: "permit-r7",
      permitEpoch: 17, originalNotBefore: 100, nextAttemptSeq: 15 }).ok).toBe(true);
    (Date.now as jest.Mock).mockReturnValue(1_040_000);
    expect(heartbeatMarketEgressTrialR2(101)).toBe(true);
    (Date.now as jest.Mock).mockReturnValue(1_080_000);
    expect(activeMarketEgressTrialR2({ tick: 102, permitId: "permit-r7",
      permitEpoch: 17 })).not.toBeNull();
    (Date.now as jest.Mock).mockReturnValue(1_100_000);
    expect(activeMarketEgressTrialR2({ tick: 103, permitId: "permit-r7",
      permitEpoch: 17 })).toBeNull();
    closeExpiredMarketEgressTrialR2(103);
    expect(readMarketEgressTrialR2()).toMatchObject({
      status: "valid", value: { status: "closed", closeReason: "control_lost" },
    });
    expect(heartbeatMarketEgressTrialR2(104)).toBe(false);
  });
});
