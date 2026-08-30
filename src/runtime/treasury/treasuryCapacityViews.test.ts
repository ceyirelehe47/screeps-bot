/**
 * Treasury strict projected 与 risk-adjusted capacity 分立测试（第八轮）：
 * - 严格口径：strictProjectedUsed + strictProjectedFree = physical capacity
 *  （不含任何风险扣减；随本 tick overlay 推进）；
 * - risk-adjusted：单独扣除 quarantine/unresolved intent 正流入占用
 *  （可能已流入的 uncertain 资源占用空间；per-transaction 不抵消）；
 * - receiver admission 使用 risk-adjusted 口径（receiverCommitments 的
 *  strict/riskAdjusted 双字段）；旧名称（projectedFreeCapacity →
 *  risk-adjusted、projectedUsedCapacity → strict）兼容语义标注；
 * - 消费者不再误混两个口径。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { quarantineTreasuryTransaction } from "@/runtime/treasury/quarantine";
import { writeTreasuryIntentEntry } from "@/runtime/treasury/intents";
import { compatRecordAcceptedTransaction } from "@/runtime/treasury/compat";
import { installRooms, type RoomSpec } from "@mock/treasury";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    // used 90k / free 10k（physical = 100k）。
    storage: { id: "stor-1", resources: { energy: 90_000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 5_000 },
  },
];

function makeService(): TreasuryService {
  const rooms = installRooms(ROOMS);
  const service = createTreasuryService({ getRooms: () => Object.values(rooms) });
  service.beginTick();
  return service;
}

function injectQuarantine(transactionId: string, delta: number): void {
  quarantineTreasuryTransaction({
    transactionId,
    digest: "0123456789abcdef",
    tick: Game.time,
    kind: "test",
    source: "test",
    phase: "executing_at_end_tick",
    deltas: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta }],
    recordedAt: Game.time,
  });
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
});

describe("严格口径（strict projected）", () => {
  it("strictUsed + strictFree = physical capacity（不含风险扣减）；随 overlay 推进", () => {
    const service = makeService();
    // 基线：90k used + 10k free = 100k physical。
    expect(service.strictProjectedUsedCapacity("W1N57", "storage")).toBe(90_000);
    expect(service.strictProjectedFreeCapacity("W1N57", "storage")).toBe(10_000);
    // 本 tick overlay：commit 一笔 +300 流入。
    const epoch = service.observation().epoch;
    const recorded = compatRecordAcceptedTransaction(service, {
      transactionId: "cv_overlay",
      kind: "test",
      source: "test",
      decision: { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick },
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: 300 }],
    });
    expect(recorded.status).toBe("recorded");
    expect(service.strictProjectedUsedCapacity("W1N57", "storage")).toBe(90_300);
    expect(service.strictProjectedFreeCapacity("W1N57", "storage")).toBe(9_700);
    // 存在 quarantine 风险时严格口径不受影响。
    injectQuarantine("cv_q", 1_000);
    expect(service.strictProjectedUsedCapacity("W1N57", "storage")).toBe(90_300);
    expect(service.strictProjectedFreeCapacity("W1N57", "storage")).toBe(9_700);
  });

  it("旧名称兼容：projectedUsedCapacity = strict、projectedFreeCapacity = risk-adjusted", () => {
    const service = makeService();
    injectQuarantine("cv_alias_q", 2_000);
    expect(service.projectedUsedCapacity("W1N57", "storage")).toBe(service.strictProjectedUsedCapacity("W1N57", "storage"));
    expect(service.projectedFreeCapacity("W1N57", "storage")).toBe(service.riskAdjustedFreeCapacity("W1N57", "storage"));
  });
});

describe("risk-adjusted 口径", () => {
  it("单独扣除 quarantine 与 unresolved intent 正流入占用（不抵消流出腿）", () => {
    const service = makeService();
    injectQuarantine("cv_risk_in", 1_500);
    injectQuarantine("cv_risk_out", -500); // 流出腿不抵消流入腿、不释放空间
    expect(service.riskAdjustedFreeCapacity("W1N57", "storage")).toBe(10_000 - 1_500);
    // intent 占用并入同一口径。
    expect(
      writeTreasuryIntentEntry({
        transactionId: "cv_risk_intent",
        digest: "0123456789abcdef",
        actionKind: "test",
        kind: "test",
        source: "test",
        postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: 700 }],
        phase: "executing",
        createdAtTick: Game.time,
        updatedAtTick: Game.time,
      }).status,
    ).toBe("written");
    expect(service.riskAdjustedFreeCapacity("W1N57", "storage")).toBe(10_000 - 1_500 - 700);
    expect(service.metrics().riskAdjustedCapacityLookups).toBeGreaterThanOrEqual(2);
  });

  it("receiver 视图双口径：strict 保持物理互补、riskAdjusted 扣风险（admission 用 risk）", () => {
    const service = makeService();
    injectQuarantine("cv_recv_q", 3_000);
    const receiver = service.commitments().receiverCommitments("W1N57");
    // 无 incoming：strict = free 基线；riskAdjusted = free − 3000。
    expect(receiver.strictStorageHeadroom).toBe(10_000);
    expect(receiver.riskAdjustedStorageHeadroom).toBe(7_000);
    expect(receiver.projectedStorageHeadroom).toBe(7_000); // 旧字段 = risk-adjusted（兼容语义）
    expect(receiver.strictStorageHeadroom + receiver.storageFreeCapacity).toBeGreaterThanOrEqual(receiver.strictStorageHeadroom); // 数值健全
    // receiver admission 的判定字段与 risk-adjusted 口径一致。
    expect(receiver.riskAdjustedOvercommitted).toBe(false);
  });
});
