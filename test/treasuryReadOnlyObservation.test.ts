/** Actual production facade/index/kernel read paths. Only the Screeps world is
 * mocked; a read-only Proxy detects even attempted Memory writes. */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createTreasuryService } from "@/runtime/treasury/facade";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { createTreasuryReadOnlyObserver, type TreasuryReadOnlyConfig } from "@/runtime/treasury/readOnlyObservation";
import { installRooms, mutateStoreResource } from "@mock/treasury";

const config: TreasuryReadOnlyConfig = {
  enabled: true, shardName: "readonly-fixture", rooms: ["W1N1"], resources: ["energy", "H"],
  intervalTicks: 100, maxSampleCpu: 2, reserveCpu: 5, minBucket: 2000, maxLogBytes: 16384,
};
function scene() {
  Game.time = 100;
  Object.assign(global, { Memory: {} });
  const rooms = installRooms([{ name: "W1N1",
    storage: { id: "storage-readonly", resources: { H: 300, energy: 5000 }, freeCapacity: 994700 },
    terminal: { id: "terminal-readonly", resources: { H: 1000, energy: 10000 }, freeCapacity: 289000 },
  }]);
  for (const s of [rooms.W1N1.storage!, rooms.W1N1.terminal!]) {
    const capacity = s.store.getUsedCapacity() + s.store.getFreeCapacity();
    Object.assign(s, { my: true, owner: { username: "fixture" }, isActive: () => true, cooldown: 0 });
    Object.defineProperty(s.store, "getCapacity", { value: () => capacity, enumerable: false });
  }
  const service = createTreasuryService({ getRooms: () => Object.values(rooms) });
  const lines: string[] = [];
  const observer = createTreasuryReadOnlyObserver(config, {
    getTick: () => Game.time, getShard: () => "readonly-fixture",
    cpu: () => ({ used: 0.1, tickLimit: 100, bucket: 10000 }),
    getRoom: name => Game.rooms[name], getResourceCatalog: () => RESOURCES_ALL,
    getMemory: () => Memory, getService: () => service, emit: line => { lines.push(line); },
  });
  return { service, observer, rooms, lines, report: () => JSON.parse(lines[lines.length - 1]) };
}
function guardedRead<T>(fn: () => T): T {
  const original = Memory, before = JSON.stringify(original);
  let attemptedWrites = 0;
  const seen = new WeakMap<object, object>();
  const guard = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    const existing = seen.get(value); if (existing) return existing;
    const refuse = (): never => { attemptedWrites += 1; throw new Error("observer attempted a Memory mutation"); };
    const proxy = new Proxy(value, {
      get: (target, key) => guard(Reflect.get(target, key)),
      set: refuse, deleteProperty: refuse, defineProperty: refuse, setPrototypeOf: refuse,
    });
    seen.set(value, proxy); return proxy;
  };
  Object.assign(global, { Memory: guard(original) });
  try { return fn(); }
  finally {
    Object.assign(global, { Memory: original });
    expect(attemptedWrites).toBe(0);
    expect(JSON.stringify(original)).toBe(before);
  }
}

beforeEach(() => { resetTreasuryCoreStoreForTest(); });

describe("Treasury production-side read-only observation", () => {
  it("runs the independent Node and real-main attachment tests", () => {
    const p = spawnSync(process.execPath, ["--test", resolve(__dirname, "treasury-read-only/local.spec.cjs")], {
      cwd: resolve(__dirname, ".."), encoding: "utf8", timeout: 45000,
    });
    if (p.status !== 0) throw new Error([p.error?.message, p.stdout, p.stderr].filter(Boolean).join("\n"));
    expect(p.status).toBe(0);
  });

  it("reads real facade balances without lifecycle, action, settlement or Memory writes", () => {
    const s = scene(); s.service.beginTick();
    const mutations = ["beginTick", "endTick", "authorizeTreasuryActionContract", "executeAuthorizedDispatch", "settleUnknownOutcome", "cancelPendingWork", "closeWork", "executeRearm"] as const;
    const spies = mutations.map(k => jest.spyOn(s.service, k));
    try {
      expect(guardedRead(() => s.observer.run()).status).toBe("sampled");
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      const row = s.report().endpoints.find((e: { location: string }) => e.location === "terminal");
      expect(row.comparison).toBe("match_selected_scope");
      expect(row.balances.H.observed).toBe(1000);
      expect(row.balances.H.spendable).toBe(1000);
      expect(row.riskAdjustedFreeCapacity).toBe(289000);
      expect(s.report().authorizesActions).toBe(false);
    } finally { for (const spy of spies) spy.mockRestore(); }
  });

  it("does not initialize missing runtime/Memory stores even on a fresh lazy read", () => {
    const s = scene();
    expect(guardedRead(() => s.observer.run()).status).toBe("sampled");
    expect((Memory as unknown as { runtime?: unknown }).runtime).toBeUndefined();
    expect(s.report().kernel.health.status).toBe("absent");
  });

  it("preserves damaged reservation input and reports blocked balances rather than repairing it", () => {
    const s = scene();
    Object.assign(Memory, { runtime: { resourceReservationsOwnerVersion: 4, resourceReservations: { bad: null } } });
    expect(guardedRead(() => s.observer.run()).status).toBe("sampled");
    const row = s.report().endpoints.find((e: { location: string }) => e.location === "terminal");
    expect(row.balances.H.authorizationSafe).toBe(false);
    expect(row.balances.H.blockers.length).toBeGreaterThan(0);
  });

  it("keeps unhealthy kernel facts and does not report zero active obligations", () => {
    const s = scene();
    Object.assign(Memory, { runtime: { treasuryCore: { version: 3, active: { broken: null } } } });
    expect(guardedRead(() => s.observer.run()).status).toBe("sampled");
    expect(s.report().kernel.health.status).toBe("unhealthy");
    expect(s.report().kernel.activeCount).toBeNull();
  });

  it("compares detached previous samples after a real new observation without inventing a writer", () => {
    const s = scene(); s.service.beginTick();
    expect(guardedRead(() => s.observer.run()).status).toBe("sampled");
    s.service.endTick();
    mutateStoreResource(s.rooms.W1N1.terminal, "H", -40);
    Game.time = 200; s.service.beginTick();
    expect(guardedRead(() => s.observer.run()).status).toBe("sampled");
    const row = s.report().endpoints.find((e: { location: string }) => e.location === "terminal");
    expect(row.direct.amounts.H).toBe(960);
    expect(row.changeSinceSample.status).toBe("net_change_unattributed");
    expect(row.changeSinceSample.amounts.H).toBe(-40);
  });

  it("keeps a missing terminal distinct from a healthy zero balance", () => {
    const s = scene();
    delete (s.rooms.W1N1 as unknown as { terminal?: unknown }).terminal;
    s.service.beginTick();
    expect(guardedRead(() => s.observer.run()).status).toBe("sampled");
    const row = s.report().endpoints.find((e: { location: string }) => e.location === "terminal");
    expect(row.directStatus).toBe("absent"); expect(row.comparison).toBe("both_absent");
    expect(row.balances).toBeUndefined();
  });
});
