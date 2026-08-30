/**
 * Treasury 安全执行包装器测试（第五轮）：
 * - prepare 失败时 Game API callback 不得执行；
 * - fake Game API 返回非 OK → 自动 abort；返回 OK → commit；
 * - callback 抛错 → 自动 abort + rethrow 原始异常；
 * - callback 只调用一次；
 * - 正常完整执行后 outstanding prepared 恒为 0；
 * - tentative 预留在执行期间持续占用（他人 prepare 不得抢占）。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { installRooms, type RoomSpec } from "@mock/treasury";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000, O: 50_000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 5_000 },
  },
];

function makeService(): TreasuryService {
  const rooms = installRooms(ROOMS);
  const service = createTreasuryService({ getRooms: () => Object.values(rooms) });
  service.beginTick();
  return service;
}

function freshInput(service: TreasuryService, transactionId: string, delta = -500) {
  const epoch = service.observation().epoch;
  return {
    transactionId,
    kind: "terminal.send",
    source: "test",
    decision: { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick },
    postings: [{ roomName: "W1N57", locationKind: "storage" as const, resource: RESOURCE_ENERGY, delta }],
  };
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
});

describe("Treasury 安全执行包装器 executePreparedAction", () => {
  it("prepare 失败时 fake Game API 不调用（stale epoch → prepare_rejected）", () => {
    const service = makeService();
    let invoked = 0;
    const staleInput = freshInput(service, "ts1_stale");
    staleInput.decision.observedAtTick = Game.time - 1; // 非法决策 epoch
    const result = service.executePreparedAction(staleInput, () => {
      invoked += 1;
      return { ok: true };
    });
    expect(result.status).toBe("prepare_rejected");
    expect(invoked).toBe(0);
  });

  it("fake Game API 返回非 OK：自动 abort、零结算、预留释放", () => {
    const service = makeService();
    const result = service.executePreparedAction(freshInput(service, "ts1_not_ok"), () => ({ ok: false }));
    expect(result.status).toBe("executed_aborted");
    expect(service.journal()).toHaveLength(0);
    const metrics = service.metrics();
    expect(metrics.preparedActive).toBe(0);
    expect(metrics.tentativeCapacityKeys).toBe(0);
    expect(metrics.transactionPreparesAborted).toBe(1);
  });

  it("fake Game API 抛错：自动 abort 并 rethrow 原始异常", () => {
    const service = makeService();
    let rethrown: unknown = null;
    try {
      service.executePreparedAction(freshInput(service, "ts1_throw"), () => {
        throw new Error("game api boom");
      });
    } catch (error) {
      rethrown = error;
    }
    expect(rethrown).toBeInstanceOf(Error);
    expect((rethrown as Error).message).toBe("game api boom");
    expect(service.journal()).toHaveLength(0);
    const metrics = service.metrics();
    expect(metrics.preparedActive).toBe(0);
    expect(metrics.transactionPreparesAborted).toBe(1);
  });

  it("fake Game API 返回 OK：commit 生效（journal/overlay/receipt）", () => {
    const service = makeService();
    let sideEffect = 0;
    const result = service.executePreparedAction(freshInput(service, "ts1_ok"), () => {
      sideEffect += 1;
      return { ok: true, code: "OK" as const };
    });
    expect(result.status).toBe("executed_committed");
    if (result.status === "executed_committed") {
      expect(result.actionResult.code).toBe("OK");
      expect(result.committedAtTick).toBe(Game.time);
    }
    expect(sideEffect).toBe(1);
    expect(service.journal()).toHaveLength(1);
    expect(service.projectedUsedCapacity("W1N57", "storage")).toBe(149_500);
    // 同 id 重放（跨包装器）命中幂等。
    const replay = service.prepareTransaction(freshInput(service, "ts1_ok"));
    expect(replay.status).toBe("already_settled");
  });

  it("callback 只调用一次", () => {
    const service = makeService();
    let calls = 0;
    service.executePreparedAction(freshInput(service, "ts1_once"), () => {
      calls += 1;
      return { ok: true };
    });
    expect(calls).toBe(1);
  });

  it("正常完整执行后 outstanding prepared 数为 0（commit 与 abort 两分支）", () => {
    const service = makeService();
    service.executePreparedAction(freshInput(service, "ts1_c"), () => ({ ok: true }));
    service.executePreparedAction(freshInput(service, "ts1_a"), () => ({ ok: false }));
    const metrics = service.metrics();
    expect(metrics.preparedActive).toBe(0);
    expect(metrics.preparedOutstandingAtEnd).toBe(0);
    service.endTick();
    expect(service.preparedLeakAudit().outstanding).toBe(0);
  });

  it("执行期间 tentative 持续占用：callback 内他人 prepare 不得抢占同一资产", () => {
    const service = makeService();
    const outer = service.executePreparedAction(freshInput(service, "ts1_outer", -60_000), () => {
      // Game API 执行中（executing，tentative -60k 已占用）：他人对同一
      // storage energy 的 -60k prepare 必须被 tentative 拒绝。
      const inner = service.prepareTransaction(freshInput(service, "ts1_inner", -60_000));
      expect(inner.status).toBe("rejected");
      return { ok: true };
    });
    expect(outer.status).toBe("executed_committed");
    expect(service.journal()).toHaveLength(1);
  });
});
