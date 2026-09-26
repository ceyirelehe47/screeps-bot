import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  acceptMarketBaseResourcePermit,
  proposeMarketBaseResourcePolicyMigration,
  startMarketBaseResourceEgressTrialR2,
} from "@/runtime/marketSaleAutomation";
import { MARKET_BASE_RESOURCE_CONFIG_REVISION } from "@/runtime/marketBaseResourcePolicy";
import { canonicalStableHashV1 } from "@/runtime/marketDirectContinuousPolicy";
import {
  readMarketEgressTrialR2,
  reserveMarketEgressTrialNative,
  trialCooldownNotBefore,
} from "@/runtime/marketBaseResourceEgressTrialR2";
import type { MarketBaseResourceScopeState } from "@/runtime/marketBaseResourceAutomation";
import {
  validateMarketBaseResourcePermitChain,
  type MarketBaseResourcePermitChainState,
} from "@/runtime/marketBaseResourcePermit";
import {
  MARKET_BASE_RESOURCE_OUTCOME_HASH_REVISION,
  advanceMarketBaseResourceWal,
  buildMarketBaseResourceHistoricalPermitRef,
  prepareMarketBaseResourceAttempt,
  recordMarketBaseResourceOutcome,
  sealMarketBaseResourceOutcome,
  validateMarketBaseResourceLedger,
  type MarketBaseResourceLedger,
} from "@/runtime/marketBaseResourceLedger";

interface R6Fixture {
  readonly v3: {
    readonly permitChain: MarketBaseResourcePermitChainState;
    readonly ledger: MarketBaseResourceLedger;
  };
}

test("the live r6 permit and WAL remain valid under the r7 reader without resetting history", () => {
  const fixture = JSON.parse(readFileSync(join(__dirname,
    "../../docs/reports/market-egress-R2-evidence-20260926/r6-preflight.json"), "utf8")) as R6Fixture;
  const { permitChain, ledger } = fixture.v3;
  expect(validateMarketBaseResourcePermitChain(permitChain)).toMatchObject({ ok: true });
  expect(validateMarketBaseResourceLedger(ledger, undefined, permitChain))
    .toMatchObject({ ok: true });
  expect(ledger.pending).toBeUndefined();
  expect(ledger.receipts.length).toBeGreaterThan(0);
  expect(ledger.confirmedCooldownNotBefore).toBeGreaterThan(0);
  expect(permitChain.currentPermitEpoch).toBe(16);
});

test("the real r6 operator snapshot proposes and accepts an r7 policy successor without clearing WAL", () => {
  const fixture = JSON.parse(readFileSync(join(__dirname,
    "../../docs/reports/market-egress-R2-evidence-20260926/r6-market-operator-fixture.json"), "utf8")) as {
      marketConfig: Record<string, unknown>;
      marketData: { directAutomation: { baseResourceV3: {
        preflightAt: number;
        scope: { sellerRooms: Array<{ roomName: string; terminalId: string }> };
        ledger: MarketBaseResourceLedger;
      } } };
    };
  const before = fixture.marketData.directAutomation.baseResourceV3.ledger;
  const oldCfg = Memory.cfg;
  const oldData = Memory.data;
  const oldRuntime = Memory.runtime;
  const oldRooms = Game.rooms;
  const oldShard = Game.shard;
  const oldTime = Game.time;
  try {
    Game.time = fixture.marketData.directAutomation.baseResourceV3.preflightAt + 1;
    Game.shard = { name: "shard1" } as Game["shard"];
    Game.rooms = Object.fromEntries(
      fixture.marketData.directAutomation.baseResourceV3.scope.sellerRooms.map((room) => [
        room.roomName,
        { name: room.roomName,
          controller: { my: true, owner: { username: "forster" } },
          terminal: { id: room.terminalId, my: true, owner: { username: "forster" } },
        } as Room,
      ]),
    );
    Memory.cfg = { marketSaleAutomation: {
      ...fixture.marketConfig,
      configRevision: MARKET_BASE_RESOURCE_CONFIG_REVISION,
    } } as unknown as Memory["cfg"];
    Memory.data = { marketSaleAutomation: fixture.marketData } as unknown as Memory["data"];
    Memory.runtime = {} as Memory["runtime"];
    const proposed = proposeMarketBaseResourcePolicyMigration();
    if (!proposed.ok) throw new Error(JSON.stringify(proposed));
    expect(proposed).toMatchObject({ ok: true });
    const proposalId = (proposed as { proposalId?: string }).proposalId;
    expect(proposalId).toEqual(expect.any(String));
    const accepted = acceptMarketBaseResourcePermit(proposalId!);
    expect(accepted).toMatchObject({ ok: true });
    const state = (Memory.data!.marketSaleAutomation as unknown as {
      directAutomation: { baseResourceV3: { permitChain: MarketBaseResourcePermitChainState;
        ledger: MarketBaseResourceLedger; scope: MarketBaseResourceScopeState } };
    }).directAutomation.baseResourceV3;
    expect(state.permitChain.currentPermitEpoch).toBe(17);
    expect(state.ledger.receiptHeadHash).toBe(before.receiptHeadHash);
    expect(state.ledger.finalizedAttemptSeq).toBe(before.finalizedAttemptSeq);
    expect(state.ledger.confirmedCooldownNotBefore).toBe(before.confirmedCooldownNotBefore);
    expect(validateMarketBaseResourceLedger(state.ledger, Game.time, state.permitChain))
      .toMatchObject({ ok: true });
    const started = startMarketBaseResourceEgressTrialR2();
    if (!started.ok) throw new Error(JSON.stringify(started));
    expect(started).toMatchObject({
      ok: true,
      originalNotBefore: before.confirmedCooldownNotBefore,
    });
    const permit = state.permitChain.retainedPermits.find((record) =>
      record.schemaVersion === 3 && record.permitId === state.permitChain.currentPermitId);
    if (!permit || permit.schemaVersion !== 3) throw new Error("r7 permit missing");
    const priorChain = fixture.marketData.directAutomation.baseResourceV3 as unknown as {
      permitChain: MarketBaseResourcePermitChainState;
    };
    const priorPermit = priorChain.permitChain.retainedPermits.find((record) =>
      record.schemaVersion === 3 && record.permitId === priorChain.permitChain.currentPermitId);
    if (!priorPermit || priorPermit.schemaVersion !== 3) throw new Error("r6 permit missing");
    for (const resource of ["L", "X"] as const) {
      const oldPolicy = priorPermit.resourcePolicies.find((value) => value.resource === resource)!;
      const newPolicy = permit.resourcePolicies.find((value) => value.resource === resource)!;
      expect(newPolicy.cooldownTicks).toBe(100);
      expect(oldPolicy.cooldownTicks).toBe(1_000);
      expect([newPolicy.hardFloor, newPolicy.economicFloor,
        newPolicy.laneReserve, newPolicy.maxDealAmount,
        newPolicy.maxTransactionEnergy, newPolicy.terminalEnergyReserve])
        .toEqual([oldPolicy.hardFloor, oldPolicy.economicFloor,
          oldPolicy.laneReserve, oldPolicy.maxDealAmount,
          oldPolicy.maxTransactionEnergy, oldPolicy.terminalEnergyReserve]);
    }
    const lane = state.scope.laneLifecycles.find((value) =>
      value.sellerRoomName === "E4N58" && value.resource === "X");
    if (!lane) throw new Error("X continuous lane missing");
    const tick = before.confirmedCooldownNotBefore - 1;
    const digest = (label: string) => canonicalStableHashV1(`market-r2:${label}`);
    const dynamicScope = {
      admissionPolicyFingerprint: permit.sharedPolicy.roomAdmissionPolicy.fingerprint,
      rosterFingerprint: state.scope.rosterFingerprint,
      laneSetFingerprint: state.scope.laneSetFingerprint,
      laneId: lane.laneId,
      roomInstanceId: lane.roomInstanceId,
    };
    const input = {
      tick,
      resourceLimit: permit.resourcePolicies.find((value) => value.resource === "X")!.rollingMaxAmount,
      permitChain: state.permitChain,
      executionPolicy: "continuous" as const,
      historicalPermit: buildMarketBaseResourceHistoricalPermitRef(permit),
      historicalLane: {
        laneId: lane.laneId, roomInstanceId: lane.roomInstanceId,
        sellerRoom: lane.sellerRoomName, resource: lane.resource,
        resourcePolicyId: lane.resourcePolicyId,
        resourcePolicyFingerprint: lane.resourcePolicyFingerprint,
        roomFingerprint: lane.roomFingerprint,
        sharedPolicyFingerprint: lane.sharedPolicyFingerprint,
      },
      firstDynamicScope: dynamicScope,
      secondDynamicScope: { ...dynamicScope },
      fullReads: {
        firstReadFingerprint: digest("full"), secondReadFingerprint: digest("full"),
        bookFingerprint: digest("book"), protectionFingerprint: digest("protection"),
        energyReadinessFingerprint: digest("energy"), arbiterFingerprint: digest("arbiter"),
      },
      executionEvidence: {
        observedOrderPriceMilli: 700_000, observedOrderAmount: 10_000,
        effectiveEnergyShadowPriceMilli: 100, effectiveNetFloorMilli: 390_000,
        terminalResourceBefore: 2_000, terminalEnergyBefore: 50_000,
        terminalCooldownBefore: 0, creditsBefore: 1_000_000,
        outgoingTransactionKeysBefore: [], outgoingWindowObservedAt: tick,
        outgoingWindowCoversAttemptAt: true as const,
      },
      orderId: "0123456789abcdef01234567", orderRoom: "W9N9",
      plannedTransactionEnergy: 400, plannedNetCreditsMilli: 699_960_000,
      worstUnitNetCreditsMilli: 699_900, evidenceKeyHint: digest("request"),
    };
    expect(prepareMarketBaseResourceAttempt(state.ledger, input)).toMatchObject({
      action: "blocked", blockerCode: "quota_or_global_cooldown",
    });
    const trialPrepared = prepareMarketBaseResourceAttempt(state.ledger, {
      ...input,
      trialCooldownNotBefore: tick - 1,
      trialPermitId: permit.permitId,
    });
    expect(trialPrepared.action).toBe("prepared");
    expect(trialPrepared.state.pending?.quota.confirmedCooldownNotBefore)
      .toBe(before.confirmedCooldownNotBefore);
    expect(trialPrepared.state.receiptHeadHash).toBe(before.receiptHeadHash);
    expect(prepareMarketBaseResourceAttempt(state.ledger, {
      ...input, executionPolicy: "canary", trialCooldownNotBefore: tick - 1,
      trialPermitId: permit.permitId,
    })).toMatchObject({ action: "blocked", blockerCode: "prepare_input_invalid" });
    const currentInput = {
      ...input,
      tick: Game.time,
      evidenceKeyHint: digest("current-request"),
      executionEvidence: {
        ...input.executionEvidence,
        outgoingWindowObservedAt: Game.time,
      },
    };
    const currentPrepared = prepareMarketBaseResourceAttempt(state.ledger, {
      ...currentInput,
      trialCooldownNotBefore: before.confirmedCooldownNotBefore,
      trialPermitId: permit.permitId,
    });
    expect(currentPrepared.action).toBe("prepared");
    const pending = currentPrepared.state.pending!;
    const marketData = Memory.data!.marketSaleAutomation as unknown as {
      directAutomation: { baseResourceV3: typeof state };
    };
    marketData.directAutomation = {
      ...marketData.directAutomation,
      baseResourceV3: { ...state, ledger: currentPrepared.state },
    };
    const reservation = {
      tick: Game.time,
      permitId: permit.permitId,
      permitEpoch: permit.epoch,
      attemptSeq: pending.attemptSeq,
      pendingEvidenceHash: pending.frozenEvidenceHash,
      roomName: "E4N58", resource: "X", stage: "continuous",
      capacityState: "pressure", policyCooldownTicks: 100,
      amount: 1_000,
      baselineNotBefore: before.confirmedCooldownNotBefore,
    };
    expect(reserveMarketEgressTrialNative(reservation)).toBe(true);
    expect(reserveMarketEgressTrialNative(reservation)).toBe(false);
    expect(readMarketEgressTrialR2()).toMatchObject({
      status: "valid", value: { callsReserved: 1, amountReserved: 1_000 },
    });
    const outcome = sealMarketBaseResourceOutcome({
      schemaVersion: 3,
      hashRevision: MARKET_BASE_RESOURCE_OUTCOME_HASH_REVISION,
      attemptSeq: pending.attemptSeq,
      status: "confirmed",
      permitId: pending.historicalPermit.permitId,
      permitEpoch: pending.historicalPermit.permitEpoch,
      laneId: pending.historicalLane.laneId,
      sellerRoom: pending.historicalLane.sellerRoom,
      resource: pending.historicalLane.resource,
      orderId: pending.orderId,
      orderRoom: pending.orderRoom,
      attemptAt: pending.attemptAt,
      plannedAmount: pending.plannedAmount,
      resolvedAt: Game.time + 1,
      evidenceKey: digest("first-confirmed-evidence"),
      actualAmount: 1_000,
      transactionId: "r2-first-confirmed-tx",
      transactionTime: Game.time,
      actualTransactionEnergy: 400,
      actualNetCreditsMilli: 699_960_000,
      pendingEvidenceHash: pending.frozenEvidenceHash,
    });
    let settled = recordMarketBaseResourceOutcome(
      currentPrepared.state, outcome, state.permitChain);
    expect(settled.action).toBe("outcome_written");
    for (const action of ["receipt_written", "processed_key_written", "pending_deleted"]) {
      settled = advanceMarketBaseResourceWal(settled.state, state.permitChain);
      expect(settled.action).toBe(action);
    }
    expect(validateMarketBaseResourceLedger(settled.state,
      Game.time + 1, state.permitChain)).toMatchObject({ ok: true });
    expect(settled.state.confirmedCooldownNotBefore).toBe(Game.time + 1_000);
    const activeTrial = readMarketEgressTrialR2();
    if (activeTrial.status !== "valid") throw new Error("trial state missing");
    const nextInput = (nextTick: number) => ({
      ...currentInput,
      tick: nextTick,
      evidenceKeyHint: digest(`second-request:${nextTick}`),
      executionEvidence: {
        ...currentInput.executionEvidence,
        outgoingWindowObservedAt: nextTick,
      },
      trialCooldownNotBefore: trialCooldownNotBefore(
        activeTrial.value, settled.state.confirmedCooldownNotBefore),
      trialPermitId: permit.permitId,
    });
    expect(prepareMarketBaseResourceAttempt(settled.state,
      nextInput(Game.time + 99))).toMatchObject({
        action: "blocked", blockerCode: "quota_or_global_cooldown",
      });
    expect(prepareMarketBaseResourceAttempt(settled.state,
      nextInput(Game.time + 100)).action).toBe("prepared");
    expect(prepareMarketBaseResourceAttempt(settled.state, {
      ...nextInput(Game.time + 100),
      trialCooldownNotBefore: undefined,
      trialPermitId: undefined,
    })).toMatchObject({
      action: "blocked", blockerCode: "quota_or_global_cooldown",
    });
  } finally {
    Memory.cfg = oldCfg;
    Memory.data = oldData;
    Memory.runtime = oldRuntime;
    Game.rooms = oldRooms;
    Game.shard = oldShard;
    Game.time = oldTime;
  }
});
