/**
 * Treasury 容量四口径测试（Core Rewrite I 适配版）。
 *
 * 语义保留：strict 投影 = observed ± 本 tick overlay（不含风险扣减）；
 * risk-adjusted = strict free 再扣 kernel unknown/closing 的最坏正流入
 *（占用从活跃聚合派生——旧 quarantine/intent 注入等价替换为 kernel
 * active 记录注入）。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import type { TreasuryCoreMemory, TreasuryCoreWorkRecord } from "@/runtime/treasury/kernel/types";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { installRooms, type RoomSpec } from "@mock/treasury";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    // used 90k / free 10k（physical = 100k）。
    storage: { id: "stor-1", resources: { energy: 90_000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 5_000 },
  },
];

let seq = 0;

function makeService(): TreasuryService {
  const rooms = installRooms(ROOMS);
  const service = createTreasuryService({ getRooms: () => Object.values(rooms) });
  service.beginTick();
  return service;
}

/** 直接注入 kernel 活跃聚合（等价旧 quarantine/intent 占用注入）。 */
function injectActiveWork(service: TreasuryService, phase: TreasuryCoreWorkRecord["phase"], delta: number): void {
  service.beginTick();
  if (!Memory.runtime) Memory.runtime = {} as never;
  if (!Memory.runtime.treasuryCore) {
    Memory.runtime.treasuryCore = {
      version: 3,
      installEpochId: "0123456789abcdef",
      issuance: { frontier: 0, burned: 0 },
      lifecycle: { lastBeginTick: Game.time, lastEndTick: null },
      recovery: { sweepCursor: 0, cleanupCursor: 0, budgetTick: Game.time, budgetUsed: 0 },
      active: {},
      ring: [],
      ringCursor: 0,
      counters: { admitted: 0, dispatched: 0, settledCommitted: 0, settledNotExecuted: 0, unknown: 0, rearmings: 0, rejectedAdmissions: 0, recoveryAdvances: 0, cleanupFailures: 0 },
    } as TreasuryCoreMemory;
  }
  const store = Memory.runtime.treasuryCore as unknown as TreasuryCoreMemory;
  seq += 1;
  const attemptId = `tk1_${String(seq).padStart(2, "0")}_ffffffffffffffff`;
  store.active[attemptId] = {
    workKey: `biz:capacity:${String(seq)}`,
    attemptId,
    generation: 1,
    parentAttemptId: null,
    phase,
    admittedAtTick: Game.time,
    updatedAtTick: Game.time,
    identity: {
      actionKind: "test.transfer",
      adapterVersion: 1,
      adapterRegistrationId: "r".repeat(16),
      adapterSemanticIdentity: "test.transfer@reconciler-semantics-v1",
      canonicalDigest: "a".repeat(16),
      postingsDigest: "b".repeat(16),
      retryFactsDigest: null,
      durableFacts: null,
    },
    worstCase: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta }],
    invocation: phase === "pending" ? null : { atTick: Game.time },
    external: null,
    outcome: phase === "closing" ? "committed" : "unknown",
    outcomeEvidence: null,
    cleanup: { consumerKeys: [], failures: 0 },
    retryDeadlineTick: null,
    lastError: null,
  } as TreasuryCoreWorkRecord;
  store.issuance.frontier = seq;
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
  resetTreasuryCommitmentRevisionForTest();
  seq = 0;
});

describe("严格口径（strict projected）", () => {
  it("strictUsed + strictFree = physical capacity（不含风险扣减）；风险占用不进入严格口径", () => {
    const service = makeService();
    // 基线：90k used + 10k free = 100k physical。
    expect(service.strictProjectedUsedCapacity("W1N57", "storage")).toBe(90_000);
    expect(service.strictProjectedFreeCapacity("W1N57", "storage")).toBe(10_000);
    // kernel unknown 风险占用不进入严格口径。
    injectActiveWork(service, "outcome_unknown", 1_000);
    expect(service.strictProjectedUsedCapacity("W1N57", "storage")).toBe(90_000);
    expect(service.strictProjectedFreeCapacity("W1N57", "storage")).toBe(10_000);
  });

  it("旧名称兼容：projectedUsedCapacity = strict、projectedFreeCapacity = risk-adjusted", () => {
    const service = makeService();
    injectActiveWork(service, "outcome_unknown", 2_000);
    expect(service.projectedUsedCapacity("W1N57", "storage")).toBe(service.strictProjectedUsedCapacity("W1N57", "storage"));
    expect(service.projectedFreeCapacity("W1N57", "storage")).toBe(service.riskAdjustedFreeCapacity("W1N57", "storage"));
  });
});

describe("risk-adjusted 口径", () => {
  it("单独扣除 kernel unknown/closing 正流入占用（流出腿不释放空间、不抵消流入腿）", () => {
    const service = makeService();
    injectActiveWork(service, "outcome_unknown", 1_500);
    injectActiveWork(service, "outcome_unknown", -500); // 流出腿：不抵消流入腿、不释放空间
    expect(service.riskAdjustedFreeCapacity("W1N57", "storage")).toBe(10_000 - 1_500);
    expect(service.metrics().riskAdjustedCapacityLookups).toBeGreaterThanOrEqual(1);
  });

  it("receiver 视图双口径：strict 保持物理互补、riskAdjusted 扣风险（admission 用 risk）", () => {
    const service = makeService();
    injectActiveWork(service, "outcome_unknown", 3_000);
    const receiver = service.commitments().receiverCommitments("W1N57");
    // 无 incoming：strict = free 基线；riskAdjusted = free − 3000。
    expect(receiver.strictStorageHeadroom).toBe(10_000);
    expect(receiver.riskAdjustedStorageHeadroom).toBe(7_000);
    expect(receiver.riskAdjustedStorageHeadroom).toBeLessThan(receiver.strictStorageHeadroom);
  });
});
