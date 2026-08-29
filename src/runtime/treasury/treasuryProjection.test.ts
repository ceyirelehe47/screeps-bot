/**
 * Treasury Transaction Journal 测试（原子多 posting + 输入验证 + 幂等 + 对账）：
 * - 多腿原子交易：terminal.send 式两腿、三腿交易 overlay 正确；
 * - 任一 posting 非法（NaN/Infinity/零 delta/非整数/非法资源/未知房间/
 *   位置缺失/流出超量/容量越界）→ 整笔拒绝、零部分写入；
 * - transactionId 幂等：同 tick / 跨 tick（Memory receipt）/ global reset
 *   重建服务后重放一律 already_settled；
 * - 跨 tick 对账 key 并集：新资源/新位置/新房间/房间丢失/位置丢失/
 *   structureId 替换/金额归零/外部流入流出全部显式分类，transaction 追溯保留。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest, peekTreasuryReceiptStore } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { formatTreasuryTransactionId } from "@/runtime/treasury/transactionId";
import { installRooms, makeStore, setStoreResources, type RoomSpec } from "@mock/treasury";

type RuntimeGlobal = typeof global & { __runtimeServices?: unknown };
function clearRuntimeServicesForTest(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

const DEFAULT_ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000, U: 2_000 }, freeCapacity: 50_000 },
    terminal: { id: "term-1", resources: { energy: 20_000, U: 500 }, freeCapacity: 30_000 },
  },
  { name: "E5N59", storage: { id: "stor-2", resources: { energy: 50_000 }, freeCapacity: 20_000 }, terminal: null },
];

interface ServiceFixture {
  service: TreasuryService;
  rooms: Record<string, Room>;
  decision(): { scope: "shared" | "market-fresh"; epochSeq: number; observedAtTick: number };
}

function makeFixture(roomSpecs: RoomSpec[] = DEFAULT_ROOMS): ServiceFixture {
  const rooms = installRooms(roomSpecs);
  const service = createTreasuryService({ getRooms: () => Object.values(rooms) });
  service.beginTick();
  return {
    service,
    rooms,
    decision(): { scope: "shared" | "market-fresh"; epochSeq: number; observedAtTick: number } {
      const epoch = service.observation().epoch;
      return { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick };
    },
  };
}

type Posting = { roomName: string; locationKind: "storage" | "terminal"; resource: string; delta: number };

function tx(fixture: ServiceFixture, transactionId: string, postings: Posting[], kind = "terminal.send") {
  return fixture.service.recordAcceptedTransaction({
    transactionId,
    kind,
    source: "test",
    decision: fixture.decision(),
    postings,
  });
}

beforeEach(() => {
  clearRuntimeServicesForTest();
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
});

describe("Treasury 原子 transaction journal", () => {
  it("两腿交易（storage→terminal 转账）overlay 双向正确且 observed 不变", () => {
    const fixture = makeFixture();
    const result = tx(fixture, formatTreasuryTransactionId("transfer", 1), [
      { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -5_000 },
      { roomName: "W1N57", locationKind: "terminal", resource: RESOURCE_ENERGY, delta: 5_000 },
    ]);
    expect(result.status).toBe("recorded");

    const journal = fixture.service.journal();
    expect(journal).toHaveLength(1);
    expect(journal[0].postings).toHaveLength(2);
    expect(fixture.service.projectedFreeCapacity("W1N57", "storage")).toBe(50_000 + 5_000);
    expect(fixture.service.projectedFreeCapacity("W1N57", "terminal")).toBe(30_000 - 5_000);
    expect(fixture.service.observation().amount("W1N57", "storage", RESOURCE_ENERGY)).toBe(100_000);
    expect(fixture.service.metrics().transactionsRecorded).toBe(1);
    expect(fixture.service.metrics().postingsRecorded).toBe(2);
  });

  it("三腿交易（资源 + energy 手续费回流）多资源多位置 overlay 正确；零 delta 整笔拒绝", () => {
    const fixture = makeFixture();
    const zeroDelta = tx(fixture, formatTreasuryTransactionId("deal", "order-1"), [
      { roomName: "W1N57", locationKind: "terminal", resource: "U", delta: -200 },
      { roomName: "W1N57", locationKind: "terminal", resource: RESOURCE_ENERGY, delta: -3_000 },
      { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: 0 },
    ]);
    expect(zeroDelta.status).toBe("rejected");
    if (zeroDelta.status === "rejected") expect(zeroDelta.reason).toBe("invalid_posting_delta");

    const good = tx(fixture, formatTreasuryTransactionId("deal", "order-2"), [
      { roomName: "W1N57", locationKind: "terminal", resource: "U", delta: -200 },
      { roomName: "W1N57", locationKind: "terminal", resource: RESOURCE_ENERGY, delta: -3_000 },
      { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: 3_000 },
    ]);
    expect(good.status).toBe("recorded");
    expect(fixture.service.query({ resource: "U", rooms: ["W1N57"], locations: ["terminal"] }).projected).toBe(500 - 200);
    expect(fixture.service.projectedUsedCapacity("W1N57", "terminal")).toBe(20_500 - 3_200);
    expect(fixture.service.metrics().postingsRecorded).toBe(3);
  });

  it("中间 posting 非法时整笔回滚（零 journal / 零 overlay / 零 receipt）", () => {
    const fixture = makeFixture();
    const bad = tx(fixture, formatTreasuryTransactionId("partial", 1), [
      { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -5_000 }, // 合法
      { roomName: "NOPE9X", locationKind: "storage", resource: RESOURCE_ENERGY, delta: 5_000 }, // 未知房间
    ]);
    expect(bad.status).toBe("rejected");
    if (bad.status === "rejected") expect(bad.reason).toBe("unknown_room");

    expect(fixture.service.journal()).toHaveLength(0);
    expect(fixture.service.projectedFreeCapacity("W1N57", "storage")).toBe(50_000);
    expect(fixture.service.metrics().transactionsRecorded).toBe(0);
    expect(Object.keys(peekTreasuryReceiptStore()?.settled ?? {})).toHaveLength(0);

    // 第二腿资源非法同理。
    const badResource = tx(fixture, formatTreasuryTransactionId("partial", 2), [
      { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -5_000 },
      { roomName: "W1N57", locationKind: "terminal", resource: "NOT_A_RESOURCE" as never, delta: 5_000 },
    ]);
    expect(badResource.status).toBe("rejected");
    if (badResource.status === "rejected") expect(badResource.reason).toBe("invalid_posting_resource");
    expect(fixture.service.journal()).toHaveLength(0);
  });

  it("NaN / Infinity / 零 / 非整数 delta 一律拒绝", () => {
    const fixture = makeFixture();
    for (const delta of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, 1.5]) {
      const result = tx(fixture, formatTreasuryTransactionId("bad", encodeURI(String(delta))), [
        { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta },
      ]);
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toBe("invalid_posting_delta");
    }
    expect(fixture.service.journal()).toHaveLength(0);
  });

  it("位置缺失 / 流出超量 / 容量越界（含多笔累计）分别拒绝且零写入", () => {
    const fixture = makeFixture();
    const missing = tx(fixture, formatTreasuryTransactionId("cap", 1), [
      { roomName: "E5N59", locationKind: "terminal", resource: RESOURCE_ENERGY, delta: 100 },
    ]);
    expect(missing.status).toBe("rejected");
    if (missing.status === "rejected") expect(missing.reason).toBe("location_missing");

    const tooMuch = tx(fixture, formatTreasuryTransactionId("cap", 2), [
      { roomName: "W1N57", locationKind: "storage", resource: "U", delta: -2_001 },
    ]);
    expect(tooMuch.status).toBe("rejected");
    if (tooMuch.status === "rejected") expect(tooMuch.reason).toBe("insufficient_amount");

    const overflow = tx(fixture, formatTreasuryTransactionId("cap", 3), [
      { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: 50_001 },
    ]);
    expect(overflow.status).toBe("rejected");
    if (overflow.status === "rejected") expect(overflow.reason).toBe("capacity_overflow");

    // 第一笔 40_000 合法；第二笔 +11_000 越界（累计口径）。
    expect(tx(fixture, formatTreasuryTransactionId("cap", 4), [
      { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: 40_000 },
    ]).status).toBe("recorded");
    const cumulative = tx(fixture, formatTreasuryTransactionId("cap", 5), [
      { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: 11_000 },
    ]);
    expect(cumulative.status).toBe("rejected");
    if (cumulative.status === "rejected") expect(cumulative.reason).toBe("capacity_overflow");
    expect(fixture.service.journal()).toHaveLength(1);
  });

  it("transactionId 幂等：同 tick 重放与跨 tick 重放均 already_settled 且不叠加", () => {
    const fixture = makeFixture();
    const transactionId = formatTreasuryTransactionId("idem", "a");
    expect(tx(fixture, transactionId, [
      { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1_000 },
    ]).status).toBe("recorded");

    const sameTick = tx(fixture, transactionId, [
      { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1_000 },
    ]);
    expect(sameTick.status).toBe("already_settled");
    expect(fixture.service.projectedFreeCapacity("W1N57", "storage")).toBe(51_000);

    fixture.service.endTick();
    Game.time += 1;
    fixture.service.beginTick();
    const nextTick = fixture.service.recordAcceptedTransaction({
      transactionId,
      kind: "terminal.send",
      source: "test",
      decision: fixture.decision(),
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1_000 }],
    });
    expect(nextTick.status).toBe("already_settled");
    if (nextTick.status === "already_settled") {
      expect(nextTick.firstRecordedAtTick).toBe(Game.time - 1);
    }
    expect(peekTreasuryReceiptStore()?.settled[transactionId]).toBe(Game.time - 1);
    // 不同 transactionId 不冲突。
    expect(tx(fixture, formatTreasuryTransactionId("idem", "b"), [
      { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1_000 },
    ]).status).toBe("recorded");
  });

  it("global reset（服务重建 + heap 丢失）后凭 Memory receipt 拒绝重放", () => {
    const rooms = installRooms(DEFAULT_ROOMS);
    const first = createTreasuryService({ getRooms: () => Object.values(rooms) });
    first.beginTick();
    const decision = {
      scope: first.observation().epoch.scope,
      epochSeq: first.observation().epoch.epochSeq,
      observedAtTick: first.observation().epoch.observedAtTick,
    };
    const transactionId = formatTreasuryTransactionId("reset-proof", "a");
    expect(first.recordAcceptedTransaction({
      transactionId,
      kind: "terminal.send",
      source: "test",
      decision,
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1_000 }],
    }).status).toBe("recorded");
    first.endTick();

    // global reset：新服务实例（heap 幂等缓存清零），Memory 保留。
    Game.time += 1;
    const second = createTreasuryService({ getRooms: () => Object.values(rooms) });
    second.beginTick();
    const replay = second.recordAcceptedTransaction({
      transactionId,
      kind: "terminal.send",
      source: "test",
      decision: second.observation().epoch,
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1_000 }],
    });
    expect(replay.status).toBe("already_settled");
    expect(second.metrics().duplicateSettlementsRejected).toBe(1);
    expect(second.journal()).toHaveLength(0);
  });

  it("transactionId 格式约束：空/超长/非法字符拒绝", () => {
    const fixture = makeFixture();
    for (const transactionId of ["", "with space", "中文id", `${"x".repeat(129)}`, "a$b"]) {
      const result = tx(fixture, transactionId, [
        { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 },
      ]);
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toBe("invalid_transaction_id");
    }
    expect(tx(fixture, "tick_1:send:A-B.c", [
      { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 },
    ]).status).toBe("recorded");
  });

  it("单 tick 超过 512 笔唯一 transaction：第一笔仍不可重放（无上限淘汰）", () => {
    const fixture = makeFixture();
    const firstId = formatTreasuryTransactionId("burst", "first");
    expect(tx(fixture, firstId, [
      { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1 },
    ]).status).toBe("recorded");
    for (let index = 0; index < 600; index += 1) {
      const result = tx(fixture, formatTreasuryTransactionId("burst", index), [
        { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1 },
      ]);
      if (result.status !== "recorded") throw new Error(`index=${index} ${JSON.stringify(result)}`);
    }
    const replay = tx(fixture, firstId, [
      { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1 },
    ]);
    expect(replay.status).toBe("already_settled");
    expect(fixture.service.metrics().transactionsRecorded).toBe(601);
  });
});

describe("Treasury 跨 tick 对账（key 并集）", () => {
  function advance(fixture: ServiceFixture): void {
    fixture.service.endTick();
    Game.time += 1;
    fixture.service.beginTick();
  }

  it("外部流入计入 inflow 且保留 transaction 追溯样本", () => {
    const fixture = makeFixture();
    const transactionId = formatTreasuryTransactionId("send", "trace");
    expect(tx(fixture, transactionId, [
      { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1_000 },
    ]).status).toBe("recorded");

    // tick 间：外部流入 +1_500 → 终态 99_000 vs 观察 100_500（diff +1_500）。
    setStoreResources(fixture.rooms["W1N57"].storage, { energy: 100_000 - 1_000 + 1_500, U: 2_000 });
    advance(fixture);

    const summary = fixture.service.lastReconciliation();
    expect(summary).not.toBeNull();
    expect(summary?.previousTick).toBe(Game.time - 1);
    expect(summary?.tickGap).toBe(false);
    expect(summary?.inflowMismatches).toBe(1);
    const sample = summary?.samples[0];
    expect(sample?.diff).toBe(1_500);
    expect(sample?.category).toBe("inflow");
    expect(sample?.transactionIds).toContain(transactionId);
    expect(fixture.service.metrics().reconciliationChecks).toBeGreaterThanOrEqual(1);
  });

  it("新资源首次出现 / 新位置出现被对账发现", () => {
    const fixture = makeFixture();
    advance(fixture);
    // 上一 tick W1N57 storage 无 Z；本 tick 首次出现。
    setStoreResources(fixture.rooms["W1N57"].storage, { energy: 100_000, U: 2_000, Z: 42 });
    advance(fixture);

    const sample = fixture.service.lastReconciliation()?.samples.find((entry) => entry.resource === "Z");
    expect(sample?.category).toBe("new_resource");
    expect(sample?.observedNow).toBe(42);
    expect(sample?.diff).toBe(42);

    // 新位置（E5N59 terminal 出现且带非零资源）→ new_location。
    const rooms = fixture.rooms;
    rooms["E5N59"] = {
      ...rooms["E5N59"],
      terminal: { id: "term-2", store: makeStore({ resources: { energy: 7_000 } }) } as unknown as StructureTerminal,
    } as unknown as Room;
    advance(fixture);
    const locationSample = fixture.service.lastReconciliation()?.samples.find(
      (entry) => entry.roomName === "E5N59" && entry.locationKind === "terminal",
    );
    expect(locationSample?.category).toBe("new_location");
  });

  it("新房间出现 / 资源归零 / 位置丢失 / 房间丢失全部显式分类", () => {
    const fixture = makeFixture();
    const rooms = fixture.rooms;
    advance(fixture);

    // 新房间 E7N59 出现（storage 带非零资源，否则稀疏枚举不可见）。
    rooms["E7N59"] = {
      name: "E7N59",
      controller: { my: true, level: 6 },
      storage: { id: "stor-7", store: makeStore({ resources: { energy: 5_000 } }) } as unknown as StructureStorage,
    } as unknown as Room;
    advance(fixture);
    const newRoomSample = fixture.service.lastReconciliation()?.samples.find((entry) => entry.roomName === "E7N59");
    expect(newRoomSample?.category).toBe("new_room");
    delete rooms["E7N59"];
    advance(fixture);

    // 资源归零：E5N59 storage energy 50_000 → 0。
    setStoreResources(rooms["E5N59"].storage, { energy: 0 });
    advance(fixture);
    const zeroed = fixture.service.lastReconciliation()?.samples.find(
      (entry) => entry.roomName === "E5N59" && entry.resource === RESOURCE_ENERGY,
    );
    expect(zeroed?.category).toBe("outflow");
    expect(zeroed?.diff).toBe(-50_000);

    // 位置丢失：W1N57 terminal 移除。
    rooms["W1N57"] = { ...rooms["W1N57"], terminal: undefined } as unknown as Room;
    advance(fixture);
    const lostLocation = fixture.service.lastReconciliation()?.samples.find(
      (entry) => entry.roomName === "W1N57" && entry.locationKind === "terminal" && entry.category === "location_lost",
    );
    expect(lostLocation).toBeDefined();

    // 房间丢失：E5N59 storage energy 恢复 3_000 后整房移除。
    setStoreResources(rooms["E5N59"].storage, { energy: 3_000 });
    advance(fixture);
    delete rooms["E5N59"];
    advance(fixture);
    const lostRoom = fixture.service.lastReconciliation()?.samples.find(
      (entry) => entry.roomName === "E5N59" && entry.category === "room_lost",
    );
    expect(lostRoom).toBeDefined();
    expect(lostRoom?.diff).toBe(-3_000);
  });

  it("structureId 替换（incarnation 变化）即使金额一致也被记录", () => {
    const fixture = makeFixture();
    advance(fixture);
    const rooms = fixture.rooms;
    rooms["W1N57"] = {
      ...rooms["W1N57"],
      storage: { id: "stor-1-rebuilt", store: rooms["W1N57"].storage!.store } as unknown as StructureStorage,
    } as unknown as Room;
    advance(fixture);

    const summary = fixture.service.lastReconciliation();
    expect(summary?.structuralChanges).toBeGreaterThanOrEqual(2); // energy + U 两个 key
    const sample = summary?.samples.find((entry) => entry.category === "structure_replaced");
    expect(sample?.previousStructureId).toBe("stor-1");
    expect(sample?.currentStructureId).toBe("stor-1-rebuilt");
    expect(sample?.diff).toBe(0);
    expect(fixture.service.metrics().reconciliationStructuralChanges).toBeGreaterThanOrEqual(2);
  });

  it("一致时零 mismatch；样本有界（RECONCILIATION_SAMPLE_CAP）", () => {
    const fixture = makeFixture();
    advance(fixture);
    const summary = fixture.service.lastReconciliation();
    expect(summary?.inflowMismatches).toBe(0);
    expect(summary?.outflowMismatches).toBe(0);
    expect(summary?.samples).toHaveLength(0);

    // 制造大量差异验证样本截断（计数完整，样本有限）。
    const burst: Record<string, number> = {};
    for (let index = 0; index < 40; index += 1) {
      burst[`X${index}`] = 100;
    }
    setStoreResources(fixture.rooms["W1N57"].storage, { energy: 100_000, U: 2_000, ...burst });
    advance(fixture);
    const bounded = fixture.service.lastReconciliation();
    expect(bounded?.inflowMismatches).toBe(40);
    expect((bounded?.samples ?? []).length).toBeLessThanOrEqual(16);
  });

  it("首个 tick 无前序状态时不产生对账结论", () => {
    const fixture = makeFixture();
    const summary = fixture.service.lastReconciliation();
    expect(summary?.previousTick).toBeNull();
  });
});
