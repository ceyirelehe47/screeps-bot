/**
 * Treasury Projection 测试（journal 幂等结算 + overlay + reconciler）：
 * - 只有显式登记的已接受动作产生投影 delta；Observed 数值不被修改；
 * - actionId 幂等：同 tick 与跨 tick 重复登记一律拒绝且不叠加；
 * - stale epoch 拒绝写入；
 * - 跨 tick 对账：投影终态 vs 新观察的非零差异计数（流入/流出分桶）+ 样本，
 *   一致时不计 mismatch；对账差异不静默。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import { createTreasuryProjectionController } from "@/runtime/treasury/projection";

type RuntimeGlobal = typeof global & { __runtimeServices?: unknown };
function clearRuntimeServicesForTest(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

const storePrototype = {
  getUsedCapacity(resource?: ResourceConstant): number {
    if (resource === undefined) {
      let total = 0;
      for (const key of Object.keys(this)) {
        const value = (this as unknown as Record<string, unknown>)[key];
        if (typeof value === "number") total += value;
      }
      return total;
    }
    return ((this as unknown as Record<string, number>)[resource] as number) || 0;
  },
  getFreeCapacity(): number {
    return (this as unknown as { __freeCapacity: number }).__freeCapacity;
  },
} as unknown as StoreDefinition;

function makeStore(resources: Record<string, number>, freeCapacity = 500_000): StoreDefinition {
  const store = Object.create(storePrototype) as StoreDefinition;
  for (const [resource, amount] of Object.entries(resources)) {
    (store as unknown as Record<string, number>)[resource] = amount;
  }
  Object.defineProperty(store, "__freeCapacity", { value: freeCapacity, enumerable: false, writable: true });
  return store;
}

function installRoom(resources: Record<string, number>): StructureStorage {
  const storage = {
    id: "stor-1",
    store: makeStore(resources),
  } as unknown as StructureStorage;
  Game.rooms = {
    W1N57: {
      name: "W1N57",
      controller: { my: true, level: 8 },
      storage,
      terminal: undefined,
    } as unknown as Room,
  };
  return storage;
}

function setStore(store: StructureStorage, resources: Record<string, number>): void {
  const record = store.store as unknown as Record<string, number>;
  for (const key of Object.keys(record)) delete record[key];
  Object.assign(record, resources);
}

beforeEach(() => {
  clearRuntimeServicesForTest();
  Game.time = 2000;
  Memory.data = undefined;
  Memory.runtime = undefined;
  installRoom({ energy: 100_000 });
});

describe("Treasury transaction journal 与投影", () => {
  it("已接受动作产生投影 delta 且不修改 Observed", () => {
    const treasury = createTreasuryService({ getRooms: () => Object.values(Game.rooms) });
    const result = treasury.recordAcceptedAction({
      actionId: "deal-1",
      kind: "market.deal",
      roomName: "W1N57",
      locationKind: "storage",
      resource: RESOURCE_ENERGY,
      delta: -5_000,
      source: "market/test",
    });

    expect(result.status).toBe("recorded");
    const observation = treasury.observation();
    expect(observation.amount("W1N57", "storage", RESOURCE_ENERGY)).toBe(100_000);
    const view = treasury.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"], subtractOutgoing: false, subtractReservations: false });
    expect(view.observed).toBe(100_000);
    expect(view.projected).toBe(95_000);
    expect(treasury.journal()).toHaveLength(1);
    expect(treasury.journal()[0].actionId).toBe("deal-1");
  });

  it("未登记的动作不产生投影（失败路径零 journal）", () => {
    const treasury = createTreasuryService({ getRooms: () => Object.values(Game.rooms) });
    treasury.observation();
    expect(treasury.journal()).toHaveLength(0);
    const view = treasury.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.projected).toBe(view.observed);
  });

  it("同 tick 重复登记被拒绝且不叠加", () => {
    const treasury = createTreasuryService({ getRooms: () => Object.values(Game.rooms) });
    const input = {
      actionId: "send-1",
      kind: "terminal.send",
      roomName: "W1N57",
      locationKind: "storage" as const,
      resource: RESOURCE_ENERGY,
      delta: -1_000,
      source: "test",
    };
    expect(treasury.recordAcceptedAction(input).status).toBe("recorded");
    const second = treasury.recordAcceptedAction(input);
    expect(second.status).toBe("already_settled");
    const view = treasury.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"], subtractOutgoing: false, subtractReservations: false });
    expect(view.projected).toBe(99_000);
    expect(treasury.metrics().duplicateSettlementsRejected).toBe(1);
    expect(treasury.metrics().journalEntries).toBe(1);
  });

  it("跨 tick 重复登记同一 actionId 仍被拒绝（幂等窗口）", () => {
    const treasury = createTreasuryService({ getRooms: () => Object.values(Game.rooms) });
    treasury.recordAcceptedAction({
      actionId: "send-1",
      kind: "terminal.send",
      roomName: "W1N57",
      locationKind: "storage",
      resource: RESOURCE_ENERGY,
      delta: -1_000,
      source: "test",
    });

    Game.time = 2001;
    const replay = treasury.recordAcceptedAction({
      actionId: "send-1",
      kind: "terminal.send",
      roomName: "W1N57",
      locationKind: "storage",
      resource: RESOURCE_ENERGY,
      delta: -1_000,
      source: "test",
    });
    expect(replay.status).toBe("already_settled");
    expect(treasury.metrics().duplicateSettlementsRejected).toBe(1);
  });

  it("stale epoch 登记被拒绝且不产生增量", () => {
    // 直接测 projection 语义：以过期 epoch 登记（模拟跨 tick 误用旧观察）。
    const projection = createTreasuryProjectionController({
      onStaleRejected: () => { staleRejected += 1; },
    });
    let staleRejected = 0;
    const staleEpoch = { scope: "shared" as const, epochSeq: 1, observedAtTick: Game.time - 1 };
    const result = projection.record(
      {
        actionId: "stale-1",
        kind: "terminal.send",
        roomName: "W1N57",
        locationKind: "storage",
        resource: RESOURCE_ENERGY,
        delta: -100,
        source: "test",
      },
      staleEpoch,
    );
    expect(result.status).toBe("stale_epoch");
    expect(projection.journalSnapshot()).toHaveLength(0);
    expect(staleRejected).toBe(1);
  });
});

describe("Treasury 跨 tick 对账", () => {
  it("外部变化（流入/流出）计入 reconciliation 差异并保留样本", () => {
    const storage = Game.rooms.W1N57.storage!;
    const treasury = createTreasuryService({ getRooms: () => Object.values(Game.rooms) });
    treasury.observation();
    // 登记一个已接受动作：storage energy -1000（投影终态 99000）。
    treasury.recordAcceptedAction({
      actionId: "send-1",
      kind: "terminal.send",
      roomName: "W1N57",
      locationKind: "storage",
      resource: RESOURCE_ENERGY,
      delta: -1_000,
      source: "test",
    });

    // 下一 tick：真实世界又发生外部流入 +500（如 creep 存入）→ 观察值 100500。
    Game.time = 2001;
    setStore(storage, { energy: 100_500 });
    treasury.observation();

    const reconciliation = treasury.lastReconciliation();
    expect(reconciliation).not.toBeNull();
    expect(reconciliation!.previousTick).toBe(2000);
    // projectedFinal=99000, observedNow=100500 → inflow mismatch +1500。
    expect(reconciliation!.inflowMismatches).toBe(1);
    expect(reconciliation!.outflowMismatches).toBe(0);
    expect(reconciliation!.samples[0].diff).toBe(1_500);
    expect(reconciliation!.samples[0].resource).toBe(RESOURCE_ENERGY);

    const metrics = treasury.metrics();
    expect(metrics.reconciliationInflowMismatches).toBe(1);
  });

  it("投影与观察一致时零 mismatch；外部流出计入 outflow", () => {
    const storage = Game.rooms.W1N57.storage!;
    const treasury = createTreasuryService({ getRooms: () => Object.values(Game.rooms) });
    treasury.recordAcceptedAction({
      actionId: "send-1",
      kind: "terminal.send",
      roomName: "W1N57",
      locationKind: "storage",
      resource: RESOURCE_ENERGY,
      delta: -1_000,
      source: "test",
    });

    // 下一 tick：世界与投影终态完全一致（99000）。
    Game.time = 2001;
    setStore(storage, { energy: 99_000 });
    treasury.observation();
    expect(treasury.lastReconciliation()!.inflowMismatches).toBe(0);
    expect(treasury.lastReconciliation()!.outflowMismatches).toBe(0);

    // 再下一 tick：外部流出 -2000（projection 已重置，观察直落）。
    Game.time = 2002;
    setStore(storage, { energy: 97_000 });
    treasury.observation();
    const second = treasury.lastReconciliation()!;
    expect(second.previousTick).toBe(2001);
    expect(second.outflowMismatches).toBe(1);
    expect(second.samples[0].diff).toBe(-2_000);
  });

  it("首个 tick 无前序状态时不产生对账结论", () => {
    const treasury = createTreasuryService({ getRooms: () => Object.values(Game.rooms) });
    treasury.observation();
    expect(treasury.lastReconciliation()).toBeNull();
    expect(treasury.metrics().reconciliationChecks).toBe(0);
  });
});
