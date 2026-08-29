/**
 * Treasury 显式 tick 生命周期与决策 epoch 绑定测试：
 * - beginTick/endTick 幂等；无消费者时仍完成规定生命周期；
 * - endTick 后登记拒绝 tick_closed；上一 tick 缺 endTick 时 beginTick
 *   补救归档并显式计数（不静默）；
 * - 对账区分：正常相邻 tick / tick gap / global reset 恢复（Memory
 *   lifecycle 存在但 heap 丢失）/ 冷启动；
 * - begin 前业务访问触发懒初始化兜底计数；
 * - 决策 epoch 绑定：shared 成功、fresh 成功、stale 拒绝、unknown 拒绝、
 *   scope 混用拒绝（全部 Facade 级验证）；
 * - receipt retention/cap 清理边界：过期回收、超容驱逐、当前 tick 保护。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import {
  TREASURY_RECEIPT_MAX_ENTRIES,
  TREASURY_RECEIPT_RETENTION_TICKS,
  cleanupTreasuryReceipts,
  clearTreasuryPersistenceForTest,
  ensureTreasuryReceiptStore,
  peekTreasuryLifecycle,
  peekTreasuryReceiptStore,
} from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { formatTreasuryTransactionId } from "@/runtime/treasury/transactionId";
import { installRooms, type RoomSpec } from "@mock/treasury";

type RuntimeGlobal = typeof global & { __runtimeServices?: unknown };
function clearRuntimeServicesForTest(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

const ROOMS: RoomSpec[] = [
  { name: "W1N57", storage: { id: "stor-1", resources: { energy: 100_000 } }, terminal: { id: "term-1", resources: { energy: 20_000 } } },
];

function makeService(): { service: TreasuryService; rooms: Record<string, Room> } {
  const rooms = installRooms(ROOMS);
  return { service: createTreasuryService({ getRooms: () => Object.values(rooms) }), rooms };
}

function decision(service: TreasuryService, epoch?: { scope: "shared" | "market-fresh"; epochSeq: number; observedAtTick: number }) {
  const source = epoch ?? service.observation().epoch;
  return { scope: source.scope, epochSeq: source.epochSeq, observedAtTick: source.observedAtTick };
}

beforeEach(() => {
  clearRuntimeServicesForTest();
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
});

describe("Treasury 显式 tick 生命周期", () => {
  it("beginTick/endTick 重复调用幂等（计数不重复、观察引用不变）", () => {
    const { service } = makeService();
    service.beginTick();
    const observation = service.observation();
    service.beginTick(); // 同 tick 重复
    expect(service.observation()).toBe(observation);
    service.endTick();
    service.endTick(); // 重复 end
    expect(service.metrics().lifecycleBeginTicks).toBe(1);
    expect(service.metrics().lifecycleEndTicks).toBe(1);
  });

  it("无消费者时 begin/end 仍完成生命周期并写 Memory 标记", () => {
    const { service } = makeService();
    service.beginTick();
    service.endTick();
    expect(peekTreasuryLifecycle()?.lastBeginTick).toBe(Game.time);
    expect(peekTreasuryLifecycle()?.lastEndTick).toBe(Game.time);
    expect(service.metrics().lifecycleLazyInitializations).toBe(0);
  });

  it("endTick 后登记拒绝 tick_closed；下一 tick 恢复", () => {
    const { service } = makeService();
    service.beginTick();
    service.endTick();
    const result = service.recordAcceptedTransaction({
      transactionId: formatTreasuryTransactionId("late", 1),
      kind: "terminal.send",
      source: "test",
      decision: decision(service),
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
    });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe("tick_closed");
    expect(service.metrics().settlementsAfterEndRejected).toBe(1);

    Game.time += 1;
    service.beginTick();
    const next = service.recordAcceptedTransaction({
      transactionId: formatTreasuryTransactionId("late", 2),
      kind: "terminal.send",
      source: "test",
      decision: decision(service),
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
    });
    expect(next.status).toBe("recorded");
  });

  it("上一 tick 缺 endTick：beginTick 补救归档并显式计数", () => {
    const { service } = makeService();
    service.beginTick();
    const epoch = service.observation().epoch;
    service.recordAcceptedTransaction({
      transactionId: formatTreasuryTransactionId("send", 1),
      kind: "terminal.send",
      source: "test",
      decision: { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick },
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1_000 }],
    });
    // 不 endTick，直接切 tick（异常路径）。
    Game.time += 1;
    service.beginTick();
    expect(service.metrics().lifecycleMissingEndWarnings).toBe(1);
    // 补救归档参与对账：物理 100_000 vs 投影终态 99_000 → 外部流入 1_000。
    const summary = service.lastReconciliation();
    expect(summary?.inflowMismatches).toBe(1);
  });

  it("tick gap 对账显式标记（gap 期间差异为累积值，不静默）", () => {
    const { service } = makeService();
    service.beginTick();
    service.endTick();
    Game.time += 5; // 生命周期 gap
    service.beginTick();
    const summary = service.lastReconciliation();
    expect(summary?.tickGap).toBe(true);
    expect(summary?.previousTick).toBe(Game.time - 5);
    expect(service.metrics().tickGapReconciles).toBe(1);
  });

  it("global reset 恢复：Memory lifecycle 存在但 heap 丢失 → afterGlobalReset 标记", () => {
    const { service } = makeService();
    service.beginTick();
    service.endTick();
    expect(peekTreasuryLifecycle()?.lastEndTick).toBe(Game.time);

    // global reset：新服务实例，Memory 保留。
    Game.time += 1;
    const rooms = installRooms(ROOMS);
    const revived = createTreasuryService({ getRooms: () => Object.values(rooms) });
    revived.beginTick();
    const summary = revived.lastReconciliation();
    expect(summary?.afterGlobalReset).toBe(true);
    expect(summary?.previousTick).toBeNull(); // 无严格对账基准
    expect(revived.metrics().globalResetRecoveries).toBe(1);
  });

  it("冷启动（无 Memory 记录）不算 global reset", () => {
    const { service } = makeService();
    service.beginTick();
    const summary = service.lastReconciliation();
    expect(summary?.afterGlobalReset).toBe(false);
    expect(service.metrics().globalResetRecoveries).toBe(0);
  });

  it("begin 前业务访问触发懒初始化兜底计数（安全访问入口）", () => {
    const { service } = makeService();
    service.observation();
    expect(service.metrics().lifecycleLazyInitializations).toBe(1);
    expect(service.metrics().lifecycleBeginTicks).toBe(1);
    // 后续 beginTick 幂等不再重复。
    service.beginTick();
    expect(service.metrics().lifecycleBeginTicks).toBe(1);
    expect(service.metrics().lifecycleLazyInitializations).toBe(1);
  });
});

describe("Treasury 决策 epoch 绑定（Facade 级验证）", () => {
  it("shared epoch 决策成功结算", () => {
    const { service } = makeService();
    service.beginTick();
    const result = service.recordAcceptedTransaction({
      transactionId: formatTreasuryTransactionId("ep", "shared"),
      kind: "terminal.send",
      source: "test",
      decision: decision(service),
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
    });
    expect(result.status).toBe("recorded");
  });

  it("fresh epoch 决策成功结算（绑定那一次 fresh read）", () => {
    const { service } = makeService();
    service.beginTick();
    const fresh = service.beginFreshObservation();
    const result = service.recordAcceptedTransaction({
      transactionId: formatTreasuryTransactionId("ep", "fresh"),
      kind: "market.deal",
      source: "test",
      decision: decision(service, fresh.epoch),
      postings: [{ roomName: "W1N57", locationKind: "terminal", resource: RESOURCE_ENERGY, delta: -100 }],
    });
    expect(result.status).toBe("recorded");
    if (result.status === "recorded") expect(result.postings).toBe(1);
  });

  it("stale shared 决策（上一 tick epoch）拒绝", () => {
    const { service } = makeService();
    service.beginTick();
    const staleEpoch = service.observation().epoch;
    service.endTick();
    Game.time += 1;
    service.beginTick();
    const result = service.recordAcceptedTransaction({
      transactionId: formatTreasuryTransactionId("ep", "stale-shared"),
      kind: "terminal.send",
      source: "test",
      decision: { scope: staleEpoch.scope, epochSeq: staleEpoch.epochSeq, observedAtTick: staleEpoch.observedAtTick },
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
    });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe("stale_epoch");
    expect(service.metrics().staleEpochRejections).toBe(1);
  });

  it("stale fresh 决策拒绝；同 tick fresh epoch 有效", () => {
    const { service } = makeService();
    service.beginTick();
    const fresh = service.beginFreshObservation().epoch;
    service.endTick();
    Game.time += 1;
    service.beginTick();
    const result = service.recordAcceptedTransaction({
      transactionId: formatTreasuryTransactionId("ep", "stale-fresh"),
      kind: "market.deal",
      source: "test",
      decision: { scope: fresh.scope, epochSeq: fresh.epochSeq, observedAtTick: fresh.observedAtTick },
      postings: [{ roomName: "W1N57", locationKind: "terminal", resource: RESOURCE_ENERGY, delta: -100 }],
    });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe("stale_epoch");

    // 本 tick 新 fresh epoch 有效。
    const currentFresh = service.beginFreshObservation().epoch;
    const good = service.recordAcceptedTransaction({
      transactionId: formatTreasuryTransactionId("ep", "fresh-ok"),
      kind: "market.deal",
      source: "test",
      decision: { scope: currentFresh.scope, epochSeq: currentFresh.epochSeq, observedAtTick: currentFresh.observedAtTick },
      postings: [{ roomName: "W1N57", locationKind: "terminal", resource: RESOURCE_ENERGY, delta: -100 }],
    });
    expect(good.status).toBe("recorded");
  });

  it("scope 混用拒绝：声明 shared 但 epochSeq 注册为 market-fresh", () => {
    const { service } = makeService();
    service.beginTick();
    const fresh = service.beginFreshObservation().epoch;
    const result = service.recordAcceptedTransaction({
      transactionId: formatTreasuryTransactionId("ep", "scope"),
      kind: "terminal.send",
      source: "test",
      decision: { scope: "shared", epochSeq: fresh.epochSeq, observedAtTick: fresh.observedAtTick },
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
    });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe("scope_mismatch");
    expect(service.metrics().epochScopeMismatches).toBe(1);
  });

  it("未知 epochSeq 拒绝（本 tick 从未发行）", () => {
    const { service } = makeService();
    service.beginTick();
    const result = service.recordAcceptedTransaction({
      transactionId: formatTreasuryTransactionId("ep", "unknown"),
      kind: "terminal.send",
      source: "test",
      decision: { scope: "shared", epochSeq: 9_999, observedAtTick: Game.time },
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
    });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe("unknown_epoch");
    expect(service.metrics().unknownEpochRejections).toBe(1);
  });

  it("convenience 单 posting 入口同样强制 decision（无绕过 Gateway 的路径）", () => {
    const { service } = makeService();
    service.beginTick();
    const noDecision = service.recordAcceptedAction({
      transactionId: formatTreasuryTransactionId("ep", "single"),
      kind: "terminal.send",
      roomName: "W1N57",
      locationKind: "storage",
      resource: RESOURCE_ENERGY,
      delta: -100,
      source: "test",
      decision: undefined as never,
    });
    expect(noDecision.status).toBe("rejected");
    if (noDecision.status === "rejected") expect(noDecision.reason).toBe("stale_epoch");

    const good = service.recordAcceptedAction({
      transactionId: formatTreasuryTransactionId("ep", "single-ok"),
      kind: "terminal.send",
      roomName: "W1N57",
      locationKind: "storage",
      resource: RESOURCE_ENERGY,
      delta: -100,
      source: "test",
      decision: decision(service),
    });
    expect(good.status).toBe("recorded");
  });
});

describe("Treasury receipt retention/cap 清理边界", () => {
  it("过期 receipt 按 retention 窗口回收", () => {
    const { service } = makeService();
    service.beginTick();
    // 预置一张过期 receipt（结算于 RETENTION 之前）。
    const store = ensureTreasuryReceiptStore();
    store.settled["legacy:old"] = Game.time - TREASURY_RECEIPT_RETENTION_TICKS - 1;
    store.settled["legacy:fresh"] = Game.time - 100;

    service.endTick();
    Game.time += 1;
    service.beginTick();

    const settled = peekTreasuryReceiptStore()?.settled ?? {};
    expect(settled["legacy:old"]).toBeUndefined();
    expect(settled["legacy:fresh"]).toBeDefined();
    expect(service.metrics().receiptsEvictedByRetention).toBe(1);
  });

  it("超容驱逐按最老优先：最老被回收、较新保留、总量回到上限", () => {
    const { service } = makeService();
    service.beginTick();
    const store = ensureTreasuryReceiptStore();
    // 填满 MAX+100 张历史 receipt（全部早于当前 tick，越小越老）。
    for (let index = 0; index < TREASURY_RECEIPT_MAX_ENTRIES + 100; index += 1) {
      store.settled[`legacy:cap:${index}`] = Game.time - 500 - index;
    }

    service.endTick();
    Game.time += 1;
    service.beginTick();
    const settled = peekTreasuryReceiptStore()?.settled ?? {};
    expect(Object.keys(settled).length).toBe(TREASURY_RECEIPT_MAX_ENTRIES);
    // index 越大 tick 越早（越老）：最老的 100 张被驱逐，最新的保留。
    expect(settled[`legacy:cap:${TREASURY_RECEIPT_MAX_ENTRIES + 99}`]).toBeUndefined();
    expect(settled["legacy:cap:0"]).toBeDefined();
    expect(service.metrics().receiptsEvictedByCap).toBe(100);
  });

  it("cap 驱逐遇到当前 tick 的 receipt 立即停止（blocked 计数，宁超限不破坏本 tick 幂等）", () => {
    // 直接驱动 cleanup：洪峰全部结算于清理时刻的当前 tick。
    ensureTreasuryReceiptStore();
    const store = peekTreasuryReceiptStore()!;
    for (let index = 0; index < TREASURY_RECEIPT_MAX_ENTRIES + 50; index += 1) {
      store.settled[`flood:${index}`] = Game.time;
    }
    const report = cleanupTreasuryReceipts(Game.time);
    expect(report.retentionEvicted).toBe(0);
    expect(report.capEvicted).toBe(0);
    expect(report.evictionsBlocked).toBe(50);
    expect(report.remaining).toBe(TREASURY_RECEIPT_MAX_ENTRIES + 50);
  });
});
