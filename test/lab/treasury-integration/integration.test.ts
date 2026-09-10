/** Full-repository tests: REAL frozen facade/kernel/registry, fake Game API only.
 * In particular, world changes below do not call the fake host's sequence hook:
 * the new coordinator must bridge an actual observed asynchronous effect. */
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
  experimentId: "lab-treasury-kernel-0001", mode: "observer", shardName: "kernel-test", username: "lab-kernel-user",
  sourceRoomName: "W1N57", targetRoomName: "W10N57", sourceTerminalId: "a100000000000001", targetTerminalId: "a100000000000002",
  resourceType: "H", amount: 100, description: "lab-treasury-kernel-0001 100H", targetTick: 100, maxFeeEnergy: 26, maxSamples: 32,
};
function makeScene() {
  const calls: unknown[] = [], logs: object[] = [];
  let quote = 26;
  // Test code intentionally provides more complete real-API shapes than the
  // older Slice0 Store stub (which had neither getCapacity nor ownership).
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
    calcTransactionCost: () => quote, incomingTransactions: [], outgoingTransactions: [],
  }, getObjectById: (id: string) => Object.values(rooms).find(r => r.terminal.id === id)?.terminal ?? null });
  (Memory as unknown as Record<string, unknown>)[SLOT] = { experimentId: C.experimentId, armed: true, attempted: false };
  replaceTreasuryActionAdapterForTest(makeLiveTransferAdapter(C) as TreasuryActionAdapter);
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
  const service = createTreasuryService({ getRooms: () => Object.values(rooms) as Room[] });
  service.beginTick();
  const coordinator = createLiveCoordinator(C, { service, log: event => logs.push(event), noteObservedWorldChange: bumpTreasuryWorldSequence,
    buildContract: (args, workKey) => buildTreasuryActionContract(service, { actionKind: LIVE_TRANSFER_KIND, transactionId: workKey, args }) });
  function transaction(amount = 100, id = "tx100") {
    return { transactionId: id, time: C.targetTick, sender: { username: C.username }, recipient: { username: C.username },
      resourceType: "H", amount, from: C.sourceRoomName, to: C.targetRoomName, description: C.description };
  }
  function applyWorld(fee = 26, amount = 100) {
    // Deliberately NOT mutateStoreResource()/setStoreResources(): a real
    // processor cannot bump the player's persistent world sequence for it.
    source.terminal.store.H -= amount; source.terminal.store.energy -= fee; source.terminal.cooldown = 9;
    target.terminal.store.H += amount;
    Object.assign(Game.market, { incomingTransactions: [transaction(amount)], outgoingTransactions: [transaction(amount)] });
  }
  return { service, coordinator, source, target, rooms, calls, logs, transaction, applyWorld, quote: (n: number) => { quote = n; } };
}
function submit(s: ReturnType<typeof makeScene>) {
  const admission = s.coordinator.request();
  expect(admission.status).toBe("admitted");
  const result = s.coordinator.execute(admission); expect(result.status).toBe("unknown");
  return admission;
}
function next(s: Pick<ReturnType<typeof makeScene>, "service">) { s.service.endTick(); Game.time++; s.service.beginTick(); }
function cleanup(s: Pick<ReturnType<typeof makeScene>, "service" | "coordinator">) {
  for (let i = 0; i < 12 && s.service.kernelJournal().active.length; i++) { s.coordinator.reconcilePendingOutcome(); next(s); }
}
beforeEach(() => {
  Memory.runtime = {} as typeof Memory.runtime;
  Memory.data = {} as typeof Memory.data;
  resetTreasuryCoreStoreForTest(); clearTreasuryPolicyResolversForTest();
});

describe("Real Treasury integration, fixed single live-adapter business", () => {
  for (const fee of [26, 10]) it(`quote 26, observed fee ${fee}: unknown -> real reconciliation -> no residual/double occupancy`, () => {
    const s = makeScene(), before = s.coordinator.projection(); submit(s);
    expect(s.calls).toHaveLength(1);
    expect(s.source.terminal.store.H).toBe(1000);
    const pending = s.coordinator.projection();
    expect(pending.sourceH.committed).toBe(100); expect(pending.sourceH.spendable).toBe(900);
    expect(pending.sourceEnergy.committed).toBe(26); expect(pending.sourceEnergy.spendable).toBe(9974);
    expect(pending.targetRiskAdjustedFree).toBe(before.targetRiskAdjustedFree - 100);
    expect(s.service.kernelJournal().active[0].phase).toBe("outcome_unknown");
    const sequence = readTreasuryWorldSequence(); s.service.endTick(); s.applyWorld(fee); Game.time++; s.service.beginTick();
    expect(readTreasuryWorldSequence()).toBe(sequence);
    s.coordinator.reconcilePendingOutcome();
    expect(readTreasuryWorldSequence()).toBeGreaterThan(sequence);
    const closing = s.coordinator.projection();
    expect(closing.sourceH.spendable).toBe(900); expect(closing.sourceH.committed).toBe(0);
    expect(closing.sourceEnergy.spendable).toBe(10000 - fee); expect(closing.sourceEnergy.committed).toBe(0);
    expect(closing.targetRiskAdjustedFree).toBe(297900);
    cleanup(s); expect(s.service.kernelJournal().active).toHaveLength(0);
    expect(s.calls).toHaveLength(1);
    expect(s.coordinator.request("biz:terminal-lab:another").status).toBe("rejected");
  });
  it("unknown persists without transactions, without advancing sequence or admitting a different workKey", () => {
    const s = makeScene(); submit(s); const sequence = readTreasuryWorldSequence();
    for (let i = 0; i < 4; i++) { next(s); s.coordinator.reconcilePendingOutcome(); }
    expect(readTreasuryWorldSequence()).toBe(sequence);
    expect(s.service.kernelJournal().active[0].phase).toBe("outcome_unknown");
    expect(s.coordinator.projection().sourceH.committed).toBe(100);
    expect(s.coordinator.request("biz:terminal-lab:second").status).toBe("rejected"); expect(s.calls).toHaveLength(1);
  });
  it("full+partial correlated records remain unknown, not filtered into a full success", () => {
    const s = makeScene(); submit(s); s.service.endTick(); s.applyWorld();
    (Game.market.incomingTransactions as unknown as object[]).push(s.transaction(60, "tx200"));
    Game.time++; s.service.beginTick(); s.coordinator.reconcilePendingOutcome();
    expect(s.service.kernelJournal().active[0].phase).toBe("outcome_unknown");
    expect(s.coordinator.projection().sourceH.committed).toBe(100); expect(s.calls).toHaveLength(1);
  });
  it("fee/capacity drift between admission and dispatch is rejected with zero API calls", () => {
    for (const condition of ["fee", "capacity"]) {
      resetTreasuryCoreStoreForTest(); clearTreasuryPolicyResolversForTest();
      const s = makeScene(), admission = s.coordinator.request(); expect(admission.status).toBe("admitted");
      if (condition === "fee") s.quote(25); else s.target.terminal.store.energy = 299950;
      expect(s.coordinator.execute(admission).status).toBe("rejected"); expect(s.calls).toHaveLength(0);
    }
  });
  it("forged dispatch cannot bypass the real kernel even with a valid admission's other fields", () => {
    const s = makeScene(), admission = s.coordinator.request(); expect(admission.status).toBe("admitted");
    if (admission.status !== "admitted") throw Error("unexpected refusal");
    expect(s.coordinator.execute({ ...admission, dispatch: {} }).status).toBe("rejected"); expect(s.calls).toHaveLength(0);
  });
  it("full module reset preserves unknown; stable reconciler later closes it without reusing the old permit", () => {
    const s = makeScene(), old = submit(s); s.service.endTick(); Game.time++;
    // Independent module registry and service; same Game world and persistent Memory.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let recovered: any;
    jest.isolateModules(() => {
      const ac = require("@/runtime/treasury/actionContracts");
      const pa = require("@/runtime/treasury/policyAuthority");
      const live = require("./adapter");
      ac.registerTreasuryActionAdapter(live.makeLiveTransferAdapter(C));
      pa.registerTreasuryPolicyResolver(pa.makeNoReserveTreasuryPolicy());
      const service = require("@/runtime/treasury/facade").createTreasuryService({ getRooms: () => Object.values(s.rooms) });
      const coordinator = require("./coordinator").createLiveCoordinator(C, { service, log: () => {},
        noteObservedWorldChange: require("@/runtime/treasury/observation").bumpTreasuryWorldSequence,
        buildContract: (args: unknown, workKey: string) => ac.buildTreasuryActionContract(service, { actionKind: live.LIVE_TRANSFER_KIND, transactionId: workKey, args }) });
      service.beginTick(); recovered = { service, coordinator };
    });
    expect(recovered.coordinator.execute(old).status).toBe("rejected");
    expect(recovered.coordinator.request("biz:terminal-lab:after-reset").status).toBe("rejected");
    expect(s.calls).toHaveLength(1);
    recovered.service.endTick(); s.applyWorld(10); Game.time++; recovered.service.beginTick();
    cleanup(recovered); expect(recovered.service.kernelJournal().active).toHaveLength(0);
    expect(recovered.coordinator.projection().sourceEnergy.spendable).toBe(9990); expect(s.calls).toHaveLength(1);
  });
  it("physical success without complete player transaction views never clears Treasury risk", () => {
    const s = makeScene(); submit(s); s.service.endTick(); s.applyWorld(); Game.time++; s.service.beginTick();
    Object.assign(Game.market, { outgoingTransactions: undefined }); s.coordinator.reconcilePendingOutcome();
    expect(s.service.kernelJournal().active[0].phase).toBe("outcome_unknown");
    expect(s.coordinator.projection().sourceH.committed).toBe(100); expect(s.calls).toHaveLength(1);
  });
});
