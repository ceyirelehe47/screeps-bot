/** Independent adversarial acceptance added by the verifying Agent (AGENT-VERIFY §3.1).
 * Same REAL frozen facade/kernel/registry chain as integration.test.ts: each case
 * mutates exactly one facet of the post-dispatch world or its transaction records
 * and asserts the kernel keeps outcome unknown, committed occupancy, the
 * single-flight boundary and an untouched world sequence. */
import { createTreasuryService } from "@/runtime/treasury/facade";
import { buildTreasuryActionContract, replaceTreasuryActionAdapterForTest, type TreasuryActionAdapter } from "@/runtime/treasury/actionContracts";
import { clearTreasuryPolicyResolversForTest, makeNoReserveTreasuryPolicy, registerTreasuryPolicyResolver } from "@/runtime/treasury/policyAuthority";
import { readTreasuryWorldSequence, bumpTreasuryWorldSequence } from "@/runtime/treasury/observation";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { createLiveCoordinator } from "./coordinator";
import { makeLiveTransferAdapter, LIVE_TRANSFER_KIND } from "./adapter";
import type { LabExperimentConfig } from "../terminal-transfer/labConfig";
const SLOT = "__labTerminalTransferProbe";
const C: LabExperimentConfig = {
  experimentId: "lab-treasury-kernel-0002", mode: "observer", shardName: "kernel-test", username: "lab-kernel-user",
  sourceRoomName: "W1N57", targetRoomName: "W10N57", sourceTerminalId: "a100000000000001", targetTerminalId: "a100000000000002",
  resourceType: "H", amount: 100, description: "lab-treasury-kernel-0002 100H", targetTick: 100, maxFeeEnergy: 26, maxSamples: 32,
};
function makeScene() {
  const calls: unknown[] = [], logs: object[] = [];
  let publications = 0;
  // Same real-API-shaped ports as integration.test.ts (getCapacity + ownership).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function makeRoom(name: string, id: string, h: number, energy: number): any {
    const store = { H: h, energy };
    Object.defineProperties(store, {
      getUsedCapacity: { value(resource?: string) { return resource ? this[resource] ?? 0 : Object.keys(this).reduce((n,k) => n + this[k], 0); } },
      getFreeCapacity: { value() { return 300000 - this.getUsedCapacity(); } },
      getCapacity: { value() { return 300000; } },
    });
    const room = { name, controller: { my: true, level: 8, owner: { username: C.username } }, terminal: undefined as unknown };
    room.terminal = { id, room, structureType: "terminal", my: true, owner: { username: C.username }, store, cooldown: 0, isActive: () => true,
      send: (...args: unknown[]) => { calls.push(args); return OK; } };
    return room;
  }
  const source = makeRoom(C.sourceRoomName, C.sourceTerminalId, 1000, 10000), target = makeRoom(C.targetRoomName, C.targetTerminalId, 0, 2000);
  const rooms = { [source.name]: source, [target.name]: target };
  Object.assign(Game, { time: C.targetTick, shard: { name: C.shardName }, rooms, market: {
    calcTransactionCost: () => 26, incomingTransactions: [], outgoingTransactions: [],
  }, getObjectById: (id: string) => Object.values(rooms).find(r => r.terminal.id === id)?.terminal ?? null });
  (Memory as unknown as Record<string, unknown>)[SLOT] = { experimentId: C.experimentId, armed: true, attempted: false };
  replaceTreasuryActionAdapterForTest(makeLiveTransferAdapter(C) as TreasuryActionAdapter);
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
  const service = createTreasuryService({ getRooms: () => Object.values(rooms) as Room[] });
  service.beginTick();
  const coordinator = createLiveCoordinator(C, { service, log: event => logs.push(event),
    // Real hook behind a counter: "publications === 0" proves reconcile never
    // tried to publish an unverified world change, not that the hook is inert.
    noteObservedWorldChange: () => { publications += 1; bumpTreasuryWorldSequence(); },
    buildContract: (args, workKey) => buildTreasuryActionContract(service, { actionKind: LIVE_TRANSFER_KIND, transactionId: workKey, args }) });
  function transaction(amount = 100, id = "tx100") {
    return { transactionId: id, time: C.targetTick, sender: { username: C.username }, recipient: { username: C.username },
      resourceType: "H", amount, from: C.sourceRoomName, to: C.targetRoomName, description: C.description };
  }
  function applyWorld(fee = 26, amount = 100) {
    source.terminal.store.H -= amount; source.terminal.store.energy -= fee; source.terminal.cooldown = 9;
    target.terminal.store.H += amount;
    Object.assign(Game.market, { incomingTransactions: [transaction(amount)], outgoingTransactions: [transaction(amount)] });
  }
  function setViews(tx: object) { Object.assign(Game.market, { incomingTransactions: [tx], outgoingTransactions: [tx] }); }
  return { service, coordinator, source, target, rooms, calls, logs, transaction, applyWorld, setViews,
    publications: () => publications };
}
function submit(s: ReturnType<typeof makeScene>) {
  const admission = s.coordinator.request();
  expect(admission.status).toBe("admitted");
  const result = s.coordinator.execute(admission); expect(result.status).toBe("unknown");
  return admission;
}
function next(s: Pick<ReturnType<typeof makeScene>, "service">) { s.service.endTick(); Game.time++; s.service.beginTick(); }
function activePhase(s: Pick<ReturnType<typeof makeScene>, "service">): string {
  const active = s.service.kernelJournal().active;
  expect(active).toHaveLength(1);
  return String(active[0].phase);
}
beforeEach(() => {
  Memory.runtime = {} as typeof Memory.runtime;
  Memory.data = {} as typeof Memory.data;
  resetTreasuryCoreStoreForTest(); clearTreasuryPolicyResolversForTest();
});

describe("Real Treasury integration, independent single-flaw adversarial worlds", () => {
  it("a contradictory same-ID mirror copy is never filtered into a success", () => {
    const s = makeScene(); submit(s); s.service.endTick(); s.applyWorld();
    (Game.market.outgoingTransactions as unknown as object[]).push({ ...s.transaction(60) });
    Game.time++; s.service.beginTick();
    const sequence = readTreasuryWorldSequence();
    s.coordinator.reconcilePendingOutcome();
    expect(activePhase(s)).toBe("outcome_unknown");
    expect(s.coordinator.projection().sourceH.committed).toBe(100);
    expect(readTreasuryWorldSequence()).toBe(sequence);
    expect(s.publications()).toBe(0);
    expect(s.calls).toHaveLength(1);
  });
  it("a physically moved world with zero transaction records stays unknown", () => {
    const s = makeScene(); submit(s); s.service.endTick(); s.applyWorld();
    Object.assign(Game.market, { incomingTransactions: [], outgoingTransactions: [] });
    Game.time++; s.service.beginTick();
    const sequence = readTreasuryWorldSequence();
    s.coordinator.reconcilePendingOutcome();
    expect(activePhase(s)).toBe("outcome_unknown");
    expect(s.coordinator.projection().sourceH.committed).toBe(100);
    expect(readTreasuryWorldSequence()).toBe(sequence);
    expect(s.publications()).toBe(0);
    expect(s.calls).toHaveLength(1);
  });
  it("fully matched amounts under a foreign description do not correlate", () => {
    const s = makeScene(); submit(s); s.service.endTick(); s.applyWorld();
    s.setViews({ ...s.transaction(), description: "another-experiment-9999 100H" });
    Game.time++; s.service.beginTick(); s.coordinator.reconcilePendingOutcome();
    expect(activePhase(s)).toBe("outcome_unknown");
    expect(s.coordinator.projection().sourceH.committed).toBe(100);
    expect(s.calls).toHaveLength(1);
  });
  it("swapped route, then a late tick stamp, each stay unknown on the same attempt", () => {
    const s = makeScene(); submit(s); s.service.endTick(); s.applyWorld();
    s.setViews({ ...s.transaction(), from: C.targetRoomName, to: C.sourceRoomName });
    Game.time++; s.service.beginTick(); s.coordinator.reconcilePendingOutcome();
    expect(activePhase(s)).toBe("outcome_unknown");
    s.setViews({ ...s.transaction(), time: C.targetTick + 1 });
    next(s); s.coordinator.reconcilePendingOutcome();
    expect(activePhase(s)).toBe("outcome_unknown");
    expect(s.coordinator.projection().sourceH.committed).toBe(100);
    expect(s.calls).toHaveLength(1);
  });
  it("an observed fee above the frozen quote stays unknown and is never retried away", () => {
    const s = makeScene(); submit(s); s.service.endTick(); s.applyWorld(27);
    Game.time++; s.service.beginTick();
    const sequence = readTreasuryWorldSequence();
    s.coordinator.reconcilePendingOutcome();
    expect(activePhase(s)).toBe("outcome_unknown");
    next(s); s.coordinator.reconcilePendingOutcome();
    expect(activePhase(s)).toBe("outcome_unknown");
    expect(s.coordinator.projection().sourceH.committed).toBe(100);
    expect(readTreasuryWorldSequence()).toBe(sequence);
    expect(s.publications()).toBe(0);
    expect(s.calls).toHaveLength(1);
  });
  it("unarmed, already-attempted and absent control slots never reach send through the real kernel", () => {
    for (const flaw of ["unarmed", "attempted", "absent"] as const) {
      resetTreasuryCoreStoreForTest(); clearTreasuryPolicyResolversForTest();
      const s = makeScene();
      const memory = Memory as unknown as Record<string, unknown>;
      if (flaw === "unarmed") (memory[SLOT] as { armed: boolean }).armed = false;
      else if (flaw === "attempted") (memory[SLOT] as { attempted: boolean }).attempted = true;
      else delete memory[SLOT];
      const admission = s.coordinator.request();
      expect(admission.status).toBe("rejected");
      if (admission.status === "rejected") expect(admission.reason).toBe("control_not_pristine_armed");
      expect(s.calls).toHaveLength(0);
      expect(s.service.kernelJournal().active).toHaveLength(0);
    }
  });
  it("a replaced target terminal identity keeps the attempt unknown", () => {
    const s = makeScene(); submit(s); s.service.endTick(); s.applyWorld();
    (s.target.terminal as { id: string }).id = "a100000000000099";
    Game.time++; s.service.beginTick(); s.coordinator.reconcilePendingOutcome();
    expect(activePhase(s)).toBe("outcome_unknown");
    expect(s.coordinator.projection().sourceH.committed).toBe(100);
    expect(s.calls).toHaveLength(1);
  });
});
