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
import { createTreasuryService, TREASURY_FRESH_EPOCH_LIMIT, type TreasuryService } from "@/runtime/treasury/facade";
import { compatRecordAcceptedAction, compatRecordAcceptedTransaction } from "@/runtime/treasury/compat";
import {
  TREASURY_RECEIPT_MAX_ENTRIES,
  TREASURY_RECEIPT_RETENTION_TICKS,
  TREASURY_RECEIPT_VERSION,
  clearTreasuryPersistenceForTest,
  encodeReceiptKey,
  ensureTreasuryReceiptStore,
  peekTreasuryLifecycle,
  peekTreasuryReceiptStore,
  readTreasuryReceiptEventCounters,
  type TreasuryReceiptStore,
} from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { formatTreasuryTransactionId } from "@/runtime/treasury/transactionId";
import { installRooms, setStoreResources, type RoomSpec } from "@mock/treasury";

type RuntimeGlobal = typeof global & { __runtimeServices?: unknown };
function clearRuntimeServicesForTest(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000, U: 50_000 } },
    terminal: { id: "term-1", resources: { energy: 20_000 } },
  },
];

function makeService(): { service: TreasuryService; rooms: Record<string, Room> } {
  const rooms = installRooms(ROOMS);
  return { service: createTreasuryService({ getRooms: () => Object.values(rooms) }), rooms };
}

function decision(service: TreasuryService, epoch?: { scope: "shared" | "market-fresh"; epochSeq: number; observedAtTick: number }) {
  const source = epoch ?? service.observation().epoch;
  return { scope: source.scope, epochSeq: source.epochSeq, observedAtTick: source.observedAtTick };
}

/** 预置 n 张 receipt（结算于 settledAt；直写 v3 store 并同步 entryCount/nextExpiryTick）。 */
function seedReceipts(count: number, settledAt: number, prefix = "seed"): TreasuryReceiptStore {
  const store = ensureTreasuryReceiptStore();
  for (let index = 0; index < count; index += 1) {
    store.settled[encodeReceiptKey(`${prefix}:${settledAt}:${index}`)] = settledAt;
  }
  store.entryCount = Object.keys(store.settled).length;
  store.updatedAt = Game.time;
  // 与实现同口径重算过期调度元数据（min(settledAt)+retention+1；空表 null）。
  let minSettledAt: number | null = null;
  for (const key of Object.keys(store.settled)) {
    const value = store.settled[key];
    if (minSettledAt === null || value < minSettledAt) minSettledAt = value;
  }
  store.nextExpiryTick = minSettledAt === null ? null : minSettledAt + TREASURY_RECEIPT_RETENTION_TICKS + 1;
  return store;
}

/** 直写一个 legacy receipt store（v1 裸键/v2 前缀键/v3 损坏场景共用）。 */
function installLegacyReceipts(raw: unknown): void {
  clearTreasuryPersistenceForTest();
  Memory.runtime = Memory.runtime ?? {};
  (Memory.runtime as { treasury?: { receipts?: unknown } }).treasury = { receipts: raw };
}

function send(service: TreasuryService, transactionId: string, delta = -100, kind = "terminal.send") {
  return compatRecordAcceptedTransaction(service, {
    transactionId,
    kind,
    source: "test",
    decision: decision(service),
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta }],
  });
}

beforeEach(() => {
  clearRuntimeServicesForTest();
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  // retention(5000)/迁移语义需要运行中段时钟：settled tick 必须是
  // [0, Game.time] 内安全整数（tick 1 下 -5001 的 seed 会被 value 完整
  // 验证正确判为损坏）。
  Game.time = 100_000;
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
    const result = compatRecordAcceptedTransaction(service, {
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
    const next = compatRecordAcceptedTransaction(service, {
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
    compatRecordAcceptedTransaction(service, {
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
    const result = compatRecordAcceptedTransaction(service, {
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
    const result = compatRecordAcceptedTransaction(service, {
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
    const result = compatRecordAcceptedTransaction(service, {
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
    const result = compatRecordAcceptedTransaction(service, {
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
    const good = compatRecordAcceptedTransaction(service, {
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
    const result = compatRecordAcceptedTransaction(service, {
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
    const result = compatRecordAcceptedTransaction(service, {
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
    const noDecision = compatRecordAcceptedAction(service, {
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

    const good = compatRecordAcceptedAction(service, {
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

describe("Treasury receipt admission 安全契约（retention 内绝不驱逐）", () => {
  it("过期 receipt 按 retention 窗口回收（唯一合法的自动删除路径）", () => {
    const { service } = makeService();
    service.beginTick();
    const oldSettledAt = Game.time - TREASURY_RECEIPT_RETENTION_TICKS - 1;
    const freshSettledAt = Game.time - 100;
    seedReceipts(1, oldSettledAt, "legacy-old");
    seedReceipts(1, freshSettledAt, "legacy-fresh");

    service.endTick();
    Game.time += 1;
    service.beginTick();

    const settled = peekTreasuryReceiptStore()?.settled ?? {};
    expect(settled[encodeReceiptKey(`legacy-old:${oldSettledAt}:0`)]).toBeUndefined();
    expect(settled[encodeReceiptKey(`legacy-fresh:${freshSettledAt}:0`)]).toBeDefined();
    expect(service.metrics().receiptsEvictedByRetention).toBe(1);
  });

  it("填满未过期 receipt 后新 transaction 被拒绝（receipt_capacity_exhausted）且零部分写入", () => {
    const { service } = makeService();
    service.beginTick();
    const store = seedReceipts(TREASURY_RECEIPT_MAX_ENTRIES, Game.time - 100);

    const result = send(service, "cap:rejected:1");
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toBe("receipt_capacity_exhausted");
      expect(result.detail).toContain("硬容量");
    }
    // 独立可审计指标。
    expect(service.metrics().receiptCapacityRejections).toBe(1);
    // 零部分写入：journal/overlay（projected 容量）/receipt 计数全部不变。
    expect(service.journal()).toHaveLength(0);
    expect(service.projectedFreeCapacity("W1N57", "storage")).toBe(500_000);
    expect(store.entryCount).toBe(TREASURY_RECEIPT_MAX_ENTRIES);
    expect(Object.keys(store.settled)).toHaveLength(TREASURY_RECEIPT_MAX_ENTRIES);
  });

  it("容量保护的最老 receipt 重放仍返回 already_settled（store 满不改变幂等结果）", () => {
    const { service } = makeService();
    service.beginTick();
    const store = seedReceipts(TREASURY_RECEIPT_MAX_ENTRIES, Game.time - 100);
    const oldestId = `seed:${Game.time - 100}:0`;

    const replay = send(service, oldestId);
    expect(replay.status).toBe("already_settled");
    if (replay.status === "already_settled") {
      expect(replay.firstRecordedAtTick).toBe(Game.time - 100);
    }
    // 重放不改变 store。
    expect(store.entryCount).toBe(TREASURY_RECEIPT_MAX_ENTRIES);
  });

  it("满容但有过期条目：admission 内回收后可再接纳新 transaction", () => {
    const { service } = makeService();
    service.beginTick();
    const store = seedReceipts(TREASURY_RECEIPT_MAX_ENTRIES, Game.time - TREASURY_RECEIPT_RETENTION_TICKS - 5, "expired");
    // 满容且全部过期 → admission 慢路径回收后放行。
    const result = send(service, "cap:recovered:1");
    expect(result.status).toBe("recorded");
    expect(store.entryCount).toBeLessThanOrEqual(TREASURY_RECEIPT_MAX_ENTRIES);
    expect(peekTreasuryReceiptStore()?.settled[encodeReceiptKey("cap:recovered:1")]).toBe(Game.time);
  });

  it("单 tick 超过 512 笔但未达硬容量的 transaction 正常结算（entryCount 同步）", () => {
    const { service } = makeService();
    service.beginTick();
    for (let index = 0; index < 601; index += 1) {
      const result = send(service, formatTreasuryTransactionId("burst", index), -1);
      if (result.status !== "recorded") throw new Error(`index=${index}: ${JSON.stringify(result)}`);
    }
    expect(service.metrics().transactionsRecorded).toBe(601);
    expect(peekTreasuryReceiptStore()?.entryCount).toBe(601);
  });

  it("global reset 后容量与 entryCount 从 Memory 恢复（继续拒绝满容登记）", () => {
    const { service, rooms } = makeService();
    service.beginTick();
    seedReceipts(TREASURY_RECEIPT_MAX_ENTRIES, Game.time - 100);
    service.endTick();

    Game.time += 1;
    const revived = createTreasuryService({ getRooms: () => Object.values(rooms) });
    revived.beginTick();
    const result = send(revived, "cap:after-reset:1");
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe("receipt_capacity_exhausted");
    expect(peekTreasuryReceiptStore()?.entryCount).toBe(TREASURY_RECEIPT_MAX_ENTRIES);
  });

  it("v1（裸键）无损迁移：`abc` 与 `t:abc` 是不同 transactionId，编码后不碰撞；危险字面量无损", () => {
    // 迁移数据用相对 tick（绝对古老数据迁移后会立即超过 retention 被合法回收）。
    const t0 = Game.time - 10;
    // "__proto__" 必须成为 own key（对象字面量会走原型语义），用 defineProperty。
    const v1Settled = Object.assign(Object.create(null) as Record<string, number>, {
      "abc": t0,
      "t:abc": t0 + 1,
      "constructor": t0 + 3,
    });
    Object.defineProperty(v1Settled, "__proto__", { value: t0 + 2, enumerable: true, writable: true, configurable: true });
    installLegacyReceipts({ version: 1, settled: v1Settled, updatedAt: t0 + 2 });

    const { service } = makeService();
    service.beginTick(); // 生命周期路径触发加载与迁移

    const store = peekTreasuryReceiptStore();
    expect(store?.version).toBe(TREASURY_RECEIPT_VERSION);
    // v1 raw key 原样编码：`abc`→`t:abc`、`t:abc`→`t:t:abc`（互不碰撞）。
    expect(Object.keys(store?.settled ?? {}).sort()).toEqual([
      "t:__proto__",
      "t:abc",
      "t:constructor",
      "t:t:abc",
    ]);
    expect(store?.entryCount).toBe(4);
    expect(store?.settled[encodeReceiptKey("abc")]).toBe(t0);
    expect(store?.settled[encodeReceiptKey("t:abc")]).toBe(t0 + 1);
    expect(store?.settled[encodeReceiptKey("__proto__")]).toBe(t0 + 2);
    expect(store?.nextExpiryTick).toBe(t0 + TREASURY_RECEIPT_RETENTION_TICKS + 1);
    expect(service.metrics().receiptStoreMigrationsExecuted).toBe(1);

    // 迁移后的 receipt 幂等立即生效（裸键时代 id 跨版本重放；两个 id 独立命中）。
    const replayAbc = send(service, "abc");
    expect(replayAbc.status).toBe("already_settled");
    if (replayAbc.status === "already_settled") expect(replayAbc.firstRecordedAtTick).toBe(t0);
    const replayTPrefixed = send(service, "t:abc");
    expect(replayTPrefixed.status).toBe("already_settled");
    if (replayTPrefixed.status === "already_settled") expect(replayTPrefixed.firstRecordedAtTick).toBe(t0 + 1);

    // 迁移只执行一次（版本已提升，再次加载不再迁移）。
    service.endTick();
    Game.time += 1;
    service.beginTick();
    expect(service.metrics().receiptStoreMigrationsExecuted).toBe(1);
  });

  it("v2（前缀键 + entryCount）无损迁移到 v3：补 nextExpiryTick、幂等命中", () => {
    const t0 = Game.time - 10;
    installLegacyReceipts({
      version: 2,
      settled: { [encodeReceiptKey("legacy:one")]: t0 },
      updatedAt: t0,
      entryCount: 1,
    });
    const { service } = makeService();
    service.beginTick();

    const store = peekTreasuryReceiptStore();
    expect(store?.version).toBe(TREASURY_RECEIPT_VERSION);
    expect(store?.settled[encodeReceiptKey("legacy:one")]).toBe(t0);
    expect(store?.entryCount).toBe(1);
    expect(store?.nextExpiryTick).toBe(t0 + TREASURY_RECEIPT_RETENTION_TICKS + 1);
    expect(service.metrics().receiptStoreMigrationsExecuted).toBe(1);
    const replay = send(service, "legacy:one");
    expect(replay.status).toBe("already_settled");
  });

  it("v1 含损坏 settled tick（NaN/负数/未来 tick）：不跳过、不迁移、原 store 保持不变", () => {
    installLegacyReceipts({
      version: 1,
      settled: { "good:1": 100, "bad:nan": Number.NaN, "bad:neg": -5, "bad:future": Game.time + 10_000 },
      updatedAt: 100,
    });
    const { service } = makeService();
    service.beginTick();

    const result = send(service, "fresh:tx:1");
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe("receipt_store_incompatible");
    // 原 v1 store 未被改写（不迁移、不删除、不修正）。
    const raw = (peekTreasuryReceiptStore() ?? {}) as { version?: number; settled?: Record<string, number> };
    expect(raw.version).toBe(1);
    expect(raw.settled?.["good:1"]).toBe(100);
    expect(raw.settled?.["bad:nan"]).toBeNaN();
  });

  it("v1 含非法 transactionId key（字符集外）：fail closed 不迁移", () => {
    installLegacyReceipts({ version: 1, settled: { "has space": 100 }, updatedAt: 100 });
    const { service } = makeService();
    service.beginTick();
    const result = send(service, "fresh:tx:2");
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe("receipt_store_incompatible");
    const rawVersion = (peekTreasuryReceiptStore() ?? {}) as { version?: number };
    expect(rawVersion.version).toBe(1);
  });

  it("v3 settled value 损坏整体阻断：新 transaction 拒、可靠旧 id 仍 already_settled、数据不动", () => {
    installLegacyReceipts({
      version: TREASURY_RECEIPT_VERSION,
      settled: { [encodeReceiptKey("ok:1")]: 100, [encodeReceiptKey("bad:1")]: Number.NaN },
      updatedAt: 100,
      entryCount: 2,
      nextExpiryTick: 100 + TREASURY_RECEIPT_RETENTION_TICKS + 1,
    });
    const { service } = makeService();
    service.beginTick();

    // 新 transaction：整体阻断（fail closed）。
    const fresh = send(service, "fresh:tx:3");
    expect(fresh.status).toBe("rejected");
    if (fresh.status === "rejected") expect(fresh.reason).toBe("receipt_store_incompatible");
    // 可靠识别的旧 id：仍 already_settled（幂等保证不因 store 损坏被遗忘）。
    const replay = send(service, "ok:1");
    expect(replay.status).toBe("already_settled");
    // 损坏 id 本身：无法可靠判断结算状态 → 阻断（不乐观放行）。
    const corrupted = send(service, "bad:1");
    expect(corrupted.status).toBe("rejected");
    if (corrupted.status === "rejected") expect(corrupted.reason).toBe("receipt_store_incompatible");
    // 原数据不动（无静默修正/删除）。
    const settled = peekTreasuryReceiptStore()?.settled ?? {};
    expect(settled[encodeReceiptKey("bad:1")]).toBeNaN();
    expect(settled[encodeReceiptKey("ok:1")]).toBe(100);
  });

  it("nextExpiryTick 元数据损坏（与实际 min 不一致）fail closed 而非放宽", () => {
    installLegacyReceipts({
      version: TREASURY_RECEIPT_VERSION,
      settled: { [encodeReceiptKey("a:1")]: 100 },
      updatedAt: 100,
      entryCount: 1,
      nextExpiryTick: 999_999, // 与 min(100)+5001 不符
    });
    const { service } = makeService();
    service.beginTick();
    const result = send(service, "fresh:tx:4");
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe("receipt_store_incompatible");
    expect(peekTreasuryReceiptStore()?.settled[encodeReceiptKey("a:1")]).toBe(100);
  });

  it("未知版本 fail closed：拒绝一切新登记且原数据不被删除", () => {
    clearTreasuryPersistenceForTest();
    Memory.runtime = Memory.runtime ?? {};
    const hostile = { version: 99, settled: { keep: 1 }, updatedAt: 1 };
    (Memory.runtime as { treasury?: { receipts?: unknown } }).treasury = { receipts: hostile };
    const { service } = makeService();
    service.beginTick();

    const result = send(service, "v99:reject:1");
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe("receipt_store_incompatible");
    expect(service.metrics().receiptStoreIncompatibleFailures).toBeGreaterThanOrEqual(1);
    // 原数据原样保留（不冷启动重建、不删除）。
    expect(peekTreasuryReceiptStore()).toBe(hostile as never);
    expect(service.journal()).toHaveLength(0);
  });

  it("entryCount 手工损坏（与实际条目数不符）fail closed 而非放宽容量", () => {
    clearTreasuryPersistenceForTest();
    Memory.runtime = Memory.runtime ?? {};
    (Memory.runtime as { treasury?: { receipts?: unknown } }).treasury = {
      receipts: { version: TREASURY_RECEIPT_VERSION, settled: { "t:only": 5 }, updatedAt: 5, entryCount: 999 },
    };
    const { service } = makeService();
    service.beginTick();
    const result = send(service, "corrupt:reject:1");
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe("receipt_store_incompatible");
    // 数据不动（人工修复前持续拒绝）。
    expect(peekTreasuryReceiptStore()?.settled[encodeReceiptKey("only")]).toBe(5);
  });

  it("\"__proto__\" 等危险字面量 transactionId 经 key 编码后只产生普通自有键", () => {
    const { service } = makeService();
    service.beginTick();
    expect(send(service, "__proto__").status).toBe("recorded");
    const store = peekTreasuryReceiptStore()!;
    // 编码键是普通自有属性：若赋值走了原型污染语义，Object.keys 会为空。
    expect(Object.keys(store.settled)).toEqual(["t:__proto__"]);
    expect(Object.prototype.hasOwnProperty.call(store.settled, "t:__proto__")).toBe(true);
    expect(store.entryCount).toBe(1);
    // 幂等读取命中（编码键往返无损）。
    expect(send(service, "__proto__").status).toBe("already_settled");
  });

  it("满载且未到过期点：连续 admission O(1) 拒绝（fullScans 不随重试增长）", () => {
    const { service } = makeService();
    service.beginTick();
    seedReceipts(TREASURY_RECEIPT_MAX_ENTRIES, Game.time - 100); // nextExpiryTick = now+4901
    const before = service.metrics();
    for (let index = 0; index < 10; index += 1) {
      send(service, `cap:retry:${index}`);
    }
    const after = service.metrics();
    expect(after.receiptCapacityRejections - before.receiptCapacityRejections).toBe(10);
    expect(after.receiptAdmissionFullStoreBlocked - before.receiptAdmissionFullStoreBlocked).toBe(10);
    expect(after.receiptAdmissionFastPaths).toBeGreaterThanOrEqual(before.receiptAdmissionFastPaths);
    // 核心不变量：满载重复拒绝绝不反复全表扫描。
    expect(after.receiptFullScans).toBe(before.receiptFullScans);
    expect(after.receiptExpiryCleanupScans).toBe(before.receiptExpiryCleanupScans);
    expect(after.receiptSlotsRemaining).toBe(0);
    expect(after.receiptNextExpiryTick).toBe(Game.time - 100 + TREASURY_RECEIPT_RETENTION_TICKS + 1);
  });

  it("beginTick 未到 nextExpiryTick 零扫描；到达后恰好执行一次清理并重算过期点", () => {
    const { service } = makeService();
    service.beginTick();
    seedReceipts(1, Game.time - 100);
    service.endTick();
    Game.time += 1;
    const scansBefore = service.metrics().receiptFullScans;
    service.beginTick(); // 未到过期点：零扫描
    expect(service.metrics().receiptFullScans).toBe(scansBefore);
    expect(service.metrics().receiptsEvictedByRetention).toBe(0);

    // 快进越过过期点：一次清理扫描，空表后 nextExpiryTick=null、slots 全额恢复。
    service.endTick();
    Game.time += TREASURY_RECEIPT_RETENTION_TICKS + 200;
    service.beginTick();
    const metrics = service.metrics();
    expect(metrics.receiptExpiryCleanupScans).toBe(1);
    expect(metrics.receiptsEvictedByRetention).toBe(1);
    expect(metrics.receiptNextExpiryTick).toBeNull();
    expect(metrics.receiptSlotsRemaining).toBe(TREASURY_RECEIPT_MAX_ENTRIES);
    expect(peekTreasuryReceiptStore()?.entryCount).toBe(0);
    // 扫描指标细化（第五轮）：清理与 nextExpiry 重算合并为单次遍历——
    // fullScans 恰好 +1、entries visited 计入过期清理条目（1 条）。
    expect(metrics.receiptFullScans).toBe(scansBefore + 1);
    expect(metrics.receiptExpiryCleanupEntries).toBeGreaterThanOrEqual(1);
  });

  it("receipt 扫描指标：load 校验/迁移/fatal 巡检的 entries 均被计数", () => {
    // 直写 v3 store（不经过 ensure——保持 heap 缓存冷态，load 校验路径
    // 才会在首个 lifecycle 调用时执行形状自检）。
    const settledAt = Game.time - 10;
    const settled: Record<string, number> = {};
    for (let i = 0; i < 3; i += 1) settled[encodeReceiptKey(`seed:${i}`)] = settledAt;
    Memory.runtime = Memory.runtime ?? {};
    Memory.runtime.treasury = {
      receipts: {
        version: 3,
        settled,
        updatedAt: Game.time,
        entryCount: 3,
        nextExpiryTick: settledAt + TREASURY_RECEIPT_RETENTION_TICKS + 1,
      },
    };
    const { service } = makeService(); // load 在首个 admission/lifecycle 路径触发
    service.beginTick();
    const loaded = service.metrics();
    expect(loaded.receiptLoadValidationEntries).toBe(3);
    expect(loaded.receiptEntriesVisited).toBeGreaterThanOrEqual(3);
    // admission 快路径不新增任何扫描。
    const scansBefore = service.metrics().receiptFullScans;
    const visitedBefore = service.metrics().receiptEntriesVisited;
    expect(
      compatRecordAcceptedTransaction(service, {
        transactionId: formatTreasuryTransactionId("fast", 1),
        kind: "terminal.send",
        source: "test",
        decision: {
          scope: service.observation().epoch.scope,
          epochSeq: service.observation().epoch.epochSeq,
          observedAtTick: service.observation().epoch.observedAtTick,
        },
        postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
      }).status,
    ).toBe("recorded");
    expect(service.metrics().receiptFullScans).toBe(scansBefore);
    expect(service.metrics().receiptEntriesVisited).toBe(visitedBefore);
  });
});

describe("Treasury fresh epoch 绑定 exact observation", () => {
  function setStorageFree(rooms: Record<string, Room>, free: number): void {
    (rooms["W1N57"].storage!.store as unknown as { __freeCapacity: number }).__freeCapacity = free;
  }

  it("shared 基线高、fresh 基线低：基于 fresh 的超量流出拒绝（不得回退 shared 救援）", () => {
    const { service, rooms } = makeService();
    service.beginTick();
    // shared 观察：storage U 50_000（energy 撑起 used 容量，使金额检查独立触发）。
    expect(service.observation().amount("W1N57", "storage", "U")).toBe(50_000);
    // 决策前 U 骤降 → fresh 观察 100。
    setStoreResources(rooms["W1N57"].storage, { energy: 100_000, U: 100 });
    const fresh = service.beginFreshObservation()!;
    expect(fresh.amount("W1N57", "storage", "U")).toBe(100);

    const result = compatRecordAcceptedTransaction(service, {
      transactionId: formatTreasuryTransactionId("fresh-low", 1),
      kind: "market.deal",
      source: "test",
      decision: decision(service, fresh.epoch),
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: "U", delta: -200 }],
    });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe("insufficient_amount");
    expect(service.journal()).toHaveLength(0);
  });

  it("fresh 容量较小：基于 fresh 的容量溢出拒绝（shared 大容量不得放行）", () => {
    const { service, rooms } = makeService();
    service.beginTick();
    // shared free 500_000；决策前收缩到 100。
    setStorageFree(rooms, 100);
    const fresh = service.beginFreshObservation()!;
    expect(fresh.freeCapacity("W1N57", "storage")).toBe(100);

    const result = compatRecordAcceptedTransaction(service, {
      transactionId: formatTreasuryTransactionId("fresh-cap", 1),
      kind: "market.deal",
      source: "test",
      decision: decision(service, fresh.epoch),
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: 200 }],
    });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe("capacity_overflow");
  });

  it("fresh transaction 成功时 journal 保留其 decision scope 与 epochSeq", () => {
    const { service } = makeService();
    service.beginTick();
    const fresh = service.beginFreshObservation()!;
    const result = compatRecordAcceptedTransaction(service, {
      transactionId: formatTreasuryTransactionId("fresh-journal", 1),
      kind: "market.deal",
      source: "test",
      decision: decision(service, fresh.epoch),
      postings: [{ roomName: "W1N57", locationKind: "terminal", resource: RESOURCE_ENERGY, delta: -100 }],
    });
    expect(result.status).toBe("recorded");
    const entry = service.journal()[0];
    expect(entry.decisionScope).toBe("market-fresh");
    expect(entry.epochSeq).toBe(fresh.epoch.epochSeq);
  });

  it("两个 fresh epoch 观察值不同：各自 transaction 使用对应 observation 验证", () => {
    const { service, rooms } = makeService();
    service.beginTick();
    const freshHigh = service.beginFreshObservation()!;
    expect(freshHigh.amount("W1N57", "storage", RESOURCE_ENERGY)).toBe(100_000);
    setStoreResources(rooms["W1N57"].storage, { energy: 500 });
    const freshLow = service.beginFreshObservation()!;
    expect(freshLow.amount("W1N57", "storage", RESOURCE_ENERGY)).toBe(500);

    // 基于 freshHigh 的一笔合法流出（shared/freshHigh 基线足够）。
    expect(compatRecordAcceptedTransaction(service, {
      transactionId: formatTreasuryTransactionId("dual", "high"),
      kind: "market.deal",
      source: "test",
      decision: decision(service, freshHigh.epoch),
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -80_000 }],
    }).status).toBe("recorded");
    // 基于 freshLow 的同等流出拒绝（fresh 基线 500 不足）。
    expect(compatRecordAcceptedTransaction(service, {
      transactionId: formatTreasuryTransactionId("dual", "low"),
      kind: "market.deal",
      source: "test",
      decision: decision(service, freshLow.epoch),
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -80_000 }],
    }).status).toBe("rejected");
  });

  it("fresh 发行后已有 overlay：后续 transaction 仍不能借 fresh 基线超卖", () => {
    const { service, rooms } = makeService();
    service.beginTick();
    // shared 结算 energy -99_000（overlay 已占用；物理 store 尚未变化——
    // overlay 语义是"已接受但未反映到物理事实的 intents"）。
    expect(send(service, formatTreasuryTransactionId("overlay", 1), -99_000).status).toBe("recorded");
    // fresh 独立观察（energy 90_000，比 shared 略低），overlay 是 tick 级共享
    // ——fresh 决策同样受限，不得借 fresh 基线绕过已接受 intents。
    setStoreResources(rooms["W1N57"].storage, { energy: 90_000, U: 50_000 });
    const fresh = service.beginFreshObservation()!;
    expect(fresh.amount("W1N57", "storage", RESOURCE_ENERGY)).toBe(90_000);
    const result = compatRecordAcceptedTransaction(service, {
      transactionId: formatTreasuryTransactionId("overlay", 2),
      kind: "market.deal",
      source: "test",
      decision: decision(service, fresh.epoch),
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -2_000 }],
    });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe("insufficient_amount");
  });

  it("endTick 后 beginFreshObservation 被拒绝（返回 null，不再发行 fresh epoch）", () => {
    const { service } = makeService();
    service.beginTick();
    service.endTick();
    expect(service.beginFreshObservation()).toBeNull();
  });

  it("fresh epoch 每 tick 数量上限：超出返回 null 并计数，下一 tick 恢复额度", () => {
    const { service } = makeService();
    service.beginTick();
    for (let index = 0; index < TREASURY_FRESH_EPOCH_LIMIT; index += 1) {
      expect(service.beginFreshObservation()).not.toBeNull();
    }
    expect(service.beginFreshObservation()).toBeNull();
    expect(service.metrics().freshEpochLimitRejections).toBe(1);
    // 新 tick 恢复额度（CPU 保护按 tick 计，不累积封锁）。
    service.endTick();
    Game.time += 1;
    service.beginTick();
    expect(service.beginFreshObservation()).not.toBeNull();
    expect(service.metrics().freshEpochLimitRejections).toBe(1);
  });

  it("epochSeq 单点递增无空洞（shared 与 fresh 连续编号，序列与注释一致）", () => {
    const { service } = makeService();
    service.beginTick();
    expect(service.observation().epoch.epochSeq).toBe(1);
    const fresh1 = service.beginFreshObservation()!;
    const fresh2 = service.beginFreshObservation()!;
    expect(fresh1.epoch.epochSeq).toBe(2);
    expect(fresh2.epoch.epochSeq).toBe(3);
    service.endTick();
    Game.time += 1;
    service.beginTick();
    expect(service.observation().epoch.epochSeq).toBe(4);
  });

  it("old fresh / unknown fresh / scope 伪造全部 fail closed", () => {
    const { service } = makeService();
    service.beginTick();
    const fresh = service.beginFreshObservation()!;
    service.endTick();
    Game.time += 1;
    service.beginTick();

    // 上一 tick 的 fresh epoch：stale。
    const stale = compatRecordAcceptedTransaction(service, {
      transactionId: formatTreasuryTransactionId("old-fresh", 1),
      kind: "market.deal",
      source: "test",
      decision: decision(service, fresh.epoch),
      postings: [{ roomName: "W1N57", locationKind: "terminal", resource: RESOURCE_ENERGY, delta: -100 }],
    });
    expect(stale.status).toBe("rejected");
    if (stale.status === "rejected") expect(stale.reason).toBe("stale_epoch");

    // 伪造 fresh scope 声明（epochSeq 实为 shared）。
    const sharedEpoch = service.observation().epoch;
    const forged = compatRecordAcceptedTransaction(service, {
      transactionId: formatTreasuryTransactionId("forge", 1),
      kind: "market.deal",
      source: "test",
      decision: { scope: "market-fresh", epochSeq: sharedEpoch.epochSeq, observedAtTick: sharedEpoch.observedAtTick },
      postings: [{ roomName: "W1N57", locationKind: "terminal", resource: RESOURCE_ENERGY, delta: -100 }],
    });
    expect(forged.status).toBe("rejected");
    if (forged.status === "rejected") expect(forged.reason).toBe("scope_mismatch");

    // 未注册的 fresh epochSeq。
    const unknown = compatRecordAcceptedTransaction(service, {
      transactionId: formatTreasuryTransactionId("unknown-fresh", 1),
      kind: "market.deal",
      source: "test",
      decision: { scope: "market-fresh", epochSeq: 987_654, observedAtTick: Game.time },
      postings: [{ roomName: "W1N57", locationKind: "terminal", resource: RESOURCE_ENERGY, delta: -100 }],
    });
    expect(unknown.status).toBe("rejected");
    if (unknown.status === "rejected") expect(unknown.reason).toBe("unknown_epoch");
  });
});
