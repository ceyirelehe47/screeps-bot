/**
 * Treasury tentative ledger 专项测试（第五轮 write-admission）：
 * - 资源预留：100k 资产上 A prepare -60k 后 B prepare -60k 必须拒绝；
 *   A abort 后 B 成功——prepare 成功即预留资源，同资产不得被两笔 prepare
 *   超额授权；
 * - 容量预留：同位置容量不能被两笔 prepare 超配；
 * - tentative 与 projected 分离：tentative 不进入 public projected，
 *   commit 后 tentative 消失、committed projected 生效；
 * - abort 只释放自己的 tentative；不相关资源/位置的 prepare 可并行；
 * - receipt slot 与 tentative 资源/容量 key 数一致性（gauge 对齐）；
 * - 单阶段登记不得绕过 tentative（不得抢占 prepared 预留）。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { installRooms, type RoomSpec } from "@mock/treasury";
import type { TreasuryPreparedHandle, TreasuryTransactionInput } from "@/runtime/treasury/types";

const ROOMS: RoomSpec[] = [
  {
    // 资源维度测试房间：O 100k 垫底 used（302k 总量），使纯流出超量只
    // 来自资源维度（insufficient_amount）而非容量维度（used 非负恒满足）。
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000, U: 2_000, O: 100_000 }, freeCapacity: 100_000 },
    terminal: { id: "term-1", resources: { energy: 20_000, U: 500 }, freeCapacity: 5_000 },
  },
  { name: "E5N59", storage: { id: "stor-2", resources: { energy: 50_000 }, freeCapacity: 200_000 }, terminal: null },
];

/** 容量维度测试房间：storage free 仅 1_000（used 102_000 / 总 103_000）。 */
const TIGHT_ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000, U: 2_000 }, freeCapacity: 1_000 },
    terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 5_000 },
  },
];

function makeService(roomSpecs: RoomSpec[] = ROOMS): TreasuryService {
  const rooms = installRooms(roomSpecs);
  const service = createTreasuryService({ getRooms: () => Object.values(rooms) });
  service.beginTick();
  return service;
}

function prepareInput(
  service: TreasuryService,
  transactionId: string,
  postings: Array<{ roomName: string; locationKind: "storage" | "terminal"; resource: string; delta: number }>,
): TreasuryTransactionInput {
  const epoch = service.observation().epoch;
  return {
    transactionId,
    kind: "terminal.send",
    source: "test",
    decision: { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick },
    postings,
  };
}

function prepareOk(service: TreasuryService, transactionId: string, delta: number, resource: ResourceConstant = RESOURCE_ENERGY, roomName = "W1N57", locationKind: "storage" | "terminal" = "storage"): TreasuryPreparedHandle {
  const prepared = service.prepareTransaction(
    prepareInput(service, transactionId, [{ roomName, locationKind, resource, delta }]),
  );
  expect(prepared.status).toBe("prepared");
  if (prepared.status !== "prepared") throw new Error("prepare 失败");
  return prepared.handle;
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
});

describe("Treasury tentative resource ledger", () => {
  it("100k 资产：A prepare -60k 后 B prepare -60k 必须拒绝（同一资产不得超额授权）", () => {
    const service = makeService();
    const a = prepareOk(service, "ts1_aaa", -60_000);
    void a;
    const b = service.prepareTransaction(prepareInput(service, "ts1_bbb", [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -60_000 }]));
    expect(b.status).toBe("rejected");
    if (b.status === "rejected") expect(b.reason).toBe("insufficient_amount");
  });

  it("A abort 后 B prepare -60k 成功（tentative 释放即时生效）", () => {
    const service = makeService();
    const a = prepareOk(service, "ts1_aaa", -60_000);
    expect(service.abortPreparedTransaction(a).status).toBe("aborted");
    const b = prepareOk(service, "ts1_bbb", -60_000);
    expect(service.commitPreparedTransaction(b).status).toBe("committed");
  });

  it("A commit 后 B prepare -60k 仍拒绝（tentative 已转 committed，继续占用）", () => {
    const service = makeService();
    const a = prepareOk(service, "ts1_aaa", -60_000);
    expect(service.commitPreparedTransaction(a).status).toBe("committed");
    const b = service.prepareTransaction(prepareInput(service, "ts1_bbb", [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -60_000 }]));
    expect(b.status).toBe("rejected");
    if (b.status === "rejected") expect(b.reason).toBe("insufficient_amount");
  });

  it("资源边界精确：A prepare -60k 后 B prepare -40k 恰好可行", () => {
    const service = makeService();
    prepareOk(service, "ts1_aaa", -60_000);
    prepareOk(service, "ts1_bbb", -40_000); // 100k-60k-40k=0，恰好不为负
    const c = service.prepareTransaction(prepareInput(service, "ts1_ccc", [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1 }]));
    expect(c.status).toBe("rejected");
  });

  it("abort 只释放自己的 tentative：A(-40k) abort 后 B(-40k) 仍占用，可用恰 60k", () => {
    const service = makeService();
    const a = prepareOk(service, "ts1_aaa", -40_000);
    const b = prepareOk(service, "ts1_bbb", -40_000);
    expect(service.abortPreparedTransaction(a).status).toBe("aborted");
    // A 释放 + B 仍占用 → 可用恰 60_000：-60_001 拒绝、-60_000 恰可行。
    const tooBig = service.prepareTransaction(prepareInput(service, "ts1_ccc", [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -60_001 }]));
    expect(tooBig.status).toBe("rejected");
    if (tooBig.status === "rejected") expect(tooBig.reason).toBe("insufficient_amount");
    prepareOk(service, "ts1_ddd", -60_000);
    expect(service.commitPreparedTransaction(b).status).toBe("committed");
  });

  it("不相关资源/位置的 prepare 可并行（不同资产互不阻塞）", () => {
    const service = makeService();
    const a = prepareOk(service, "ts1_aaa", -60_000, RESOURCE_ENERGY, "W1N57", "storage");
    const b = prepareOk(service, "ts1_bbb", -1_500, "U", "W1N57", "storage"); // U 只有 2_000
    const c = prepareOk(service, "ts1_ccc", -45_000, RESOURCE_ENERGY, "E5N59", "storage");
    const d = prepareOk(service, "ts1_ddd", -19_000, RESOURCE_ENERGY, "W1N57", "terminal");
    expect(service.commitPreparedTransaction(a).status).toBe("committed");
    expect(service.commitPreparedTransaction(b).status).toBe("committed");
    expect(service.commitPreparedTransaction(c).status).toBe("committed");
    expect(service.commitPreparedTransaction(d).status).toBe("committed");
  });
});

describe("Treasury tentative capacity ledger", () => {
  it("容量不能被两笔 prepare 超配：storage free 1_000，A 流入 800 后 B 流入 800 拒绝", () => {
    const service = makeService(TIGHT_ROOMS);
    prepareOk(service, "ts1_aaa", 800);
    const b = service.prepareTransaction(prepareInput(service, "ts1_bbb", [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: 800 }]));
    expect(b.status).toBe("rejected");
    if (b.status === "rejected") expect(b.reason).toBe("capacity_overflow");
  });

  it("容量跨资源聚合：A 流入 energy 600 + B 流入 U 600 超 storage free 1_000 拒绝", () => {
    const service = makeService(TIGHT_ROOMS);
    prepareOk(service, "ts1_aaa", 600, RESOURCE_ENERGY);
    const b = service.prepareTransaction(prepareInput(service, "ts1_bbb", [{ roomName: "W1N57", locationKind: "storage", resource: "U", delta: 600 }]));
    expect(b.status).toBe("rejected");
    if (b.status === "rejected") expect(b.reason).toBe("capacity_overflow");
  });

  it("单阶段登记同样不得抢占 prepared 容量预留", () => {
    const service = makeService(TIGHT_ROOMS);
    prepareOk(service, "ts1_aaa", 800);
    const drain = service.recordAcceptedTransaction(
      prepareInput(service, "ts1_single", [{ roomName: "W1N57", locationKind: "storage", resource: "U", delta: 800 }]),
    );
    expect(drain.status).toBe("rejected");
    if (drain.status === "rejected") expect(drain.reason).toBe("capacity_overflow");
  });
});

describe("tentative 与 public projected 分离", () => {
  it("tentative 不进入 public projected：prepare 后 projected/容量口径不变", () => {
    const service = makeService();
    prepareOk(service, "ts1_aaa", -60_000);
    expect(service.observation().amount("W1N57", "storage", RESOURCE_ENERGY)).toBe(100_000);
    expect(service.observation().usedCapacity("W1N57", "storage")).toBe(202_000);
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"], locations: ["storage"] });
    expect(view.projected).toBe(100_000); // 无 committed transaction → projected = observed
    expect(view.observed).toBe(100_000);
    expect(service.projectedUsedCapacity("W1N57", "storage")).toBe(202_000);
  });

  it("commit 后 tentative 消失、committed projected 生效", () => {
    const service = makeService();
    const handle = prepareOk(service, "ts1_aaa", -60_000);
    expect(service.metrics().tentativeResourceKeys).toBe(1);
    expect(service.metrics().tentativeCapacityKeys).toBe(1);
    expect(service.commitPreparedTransaction(handle).status).toBe("committed");
    const metrics = service.metrics();
    expect(metrics.tentativeResourceKeys).toBe(0);
    expect(metrics.tentativeCapacityKeys).toBe(0);
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"], locations: ["storage"] });
    expect(view.projected).toBe(40_000);
    expect(service.projectedUsedCapacity("W1N57", "storage")).toBe(142_000);
  });

  it("receipt slot 与 tentative key 数一致性：N 笔并行 prepare 的 gauge 对齐", () => {
    const service = makeService();
    const handles = [
      prepareOk(service, "ts1_a1", -1_000),
      prepareOk(service, "ts1_a2", -2_000, "U"),
      prepareOk(service, "ts1_a3", -3_000, RESOURCE_ENERGY, "E5N59"),
      prepareOk(service, "ts1_a4", -4_000, RESOURCE_ENERGY, "W1N57", "terminal"),
    ];
    const metrics = service.metrics();
    expect(metrics.preparedActive).toBe(4);
    expect(metrics.tentativeResourceKeys).toBe(4); // 4 个不同 (room,location,resource) key
    expect(metrics.tentativeCapacityKeys).toBe(3); // W1N57 storage / E5N59 storage / W1N57 terminal
    expect(metrics.receiptSlotsRemaining).toBe(4_096 - 4);
    // 全部 commit：gauge 清零、receipt 占满 4。
    for (const handle of handles) {
      expect(service.commitPreparedTransaction(handle).status).toBe("committed");
    }
    const after = service.metrics();
    expect(after.preparedActive).toBe(0);
    expect(after.tentativeResourceKeys).toBe(0);
    expect(after.tentativeCapacityKeys).toBe(0);
    expect(after.receiptSlotsRemaining).toBe(4_096 - 4);
  });
});
