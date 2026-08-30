/**
 * Treasury 安全执行包装器测试（第五轮建立；第六轮扩展结果语义）：
 * - prepare 失败时 Game API callback 不得执行；
 * - fake Game API 返回非 OK → 自动 abort；返回 OK → commit；
 * - callback 抛错 → 自动 abort + rethrow 原始异常；
 * - callback 只调用一次；
 * - 正常完整执行后 outstanding prepared 恒为 0；
 * - tentative 预留在执行期间持续占用（他人 prepare 不得抢占）；
 * - 第六轮：Game OK 后 commit fault → executed_unsettled（Game 已执行、
 *   Treasury 未提交、禁止自动重试、actionResult/fault identity 保留、
 *   transaction 进 durable quarantine、同 id 下次 callback 零调用）；
 * - Game 非 OK 且 abort 未确认 → executed_abort_failed（不报告已正常 abort）；
 * - callback 抛错且 abort 未确认 → rethrow + abort_failed marker + quarantine；
 * - prepare 后人为损坏 receipt 再 commit → faulted + durable quarantine
 *   （corrupted 绝不解释为 already_settled）。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest, peekTreasuryReceiptStore } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  readTreasuryWriteFault,
  setTreasuryCommitFaultInjectorForTest,
  type TreasuryWriteFaultPhase,
} from "@/runtime/treasury/writeFault";
import { readTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
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
  setTreasuryCommitFaultInjectorForTest(null);
});

afterEach(() => {
  setTreasuryCommitFaultInjectorForTest(null);
});

function injectOnce(phase: TreasuryWriteFaultPhase): void {
  let fired = false;
  setTreasuryCommitFaultInjectorForTest((candidate) => {
    if (candidate === phase && !fired) {
      fired = true;
      throw new Error(`injected:${phase}`);
    }
  });
}

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

describe("第六轮结果语义：Game 已执行与 Treasury 故障不可混淆", () => {
  it("Game callback 成功后 commit fault：executed_unsettled（保留 Game 结果、禁止重试、进 quarantine）", () => {
    const service = makeService();
    let callbackCalls = 0;
    // receipt_publish 段注入：receipt 尚未写入（幂等未成立），下次同 id 调用
    // 必须经 write_admission_locked 在 callback 前被拒。
    injectOnce("receipt_publish");
    const first = service.executePreparedAction(freshInput(service, "ts1_unsettled"), () => {
      callbackCalls += 1;
      return { ok: true, code: "OK" as const };
    });
    // 绝不返回 prepare_rejected/aborted（那会暗示未执行、诱导自动重试）。
    expect(first.status).toBe("executed_unsettled");
    if (first.status === "executed_unsettled") {
      expect(first.actionResult.code).toBe("OK"); // 原始 Game 结果保留
      expect(first.retryForbidden).toBe(true);
      expect(first.transactionId).toBe("ts1_unsettled");
      expect(first.digest).toMatch(/^[0-9a-f]{16}$/);
      expect(first.faultReason).toBe("handle_faulted");
    }
    // transaction 进入 durable fault（marker）+ quarantine；heap 零发布。
    expect(readTreasuryWriteFault()?.transactionId).toBe("ts1_unsettled");
    expect(service.journal()).toHaveLength(0);
    // 同 id 下一次调用：callback 前被拒（executed_unsettled 已立即落 durable
    // quarantine——门禁优先于一切），计数保持 1。
    const second = service.executePreparedAction(freshInput(service, "ts1_unsettled"), () => {
      callbackCalls += 1;
      return { ok: true };
    });
    expect(second.status).toBe("prepare_rejected");
    if (second.status === "prepare_rejected") {
      expect(second.reason).toBe("transaction_quarantined");
    }
    expect(callbackCalls).toBe(1);
  });

  it("commit fault 后 endTick 将 faulted transaction 转 durable quarantine（跨 tick 占用）", () => {
    const service = makeService();
    injectOnce("receipt_publish");
    const result = service.executePreparedAction(freshInput(service, "ts1_unsettled_q"), () => ({ ok: true }));
    expect(result.status).toBe("executed_unsettled");
    service.endTick();
    const entry = readTreasuryQuarantineEntry("ts1_unsettled_q");
    expect(entry).toBeDefined();
    expect(entry?.phase).toBe("receipt_publish");
  });

  it("Game 非 OK 且 abort 未确认：executed_abort_failed（不报告已正常 abort）", () => {
    const service = makeService();
    const result = service.executePreparedAction(freshInput(service, "ts1_abort_fail"), () => {
      // callback 执行期间制造全局锁（另一笔 commit fault）：随后的自动 abort
      // 会被 write_admission_locked 拒绝——abort 未确认。
      const other = service.prepareTransaction(freshInput(service, "ts1_abort_trigger", -100));
      expect(other.status).toBe("prepared");
      injectOnce("receipt_publish");
      if (other.status === "prepared") {
        const triggered = service.commitPreparedTransaction(other.handle);
        expect(triggered.status).toBe("rejected");
      }
      return { ok: false, code: "NOT_ENOUGH_RESOURCES" as const };
    });
    expect(result.status).toBe("executed_abort_failed");
    if (result.status === "executed_abort_failed") {
      expect(result.reason).toBe("write_admission_locked");
      expect(result.actionResult.code).toBe("NOT_ENOUGH_RESOURCES");
    }
    // 该 handle 的 tentative 未释放（abort 未确认）——active 数含 callback 内
    // 制造锁的另一笔 faulted handle（ts1_abort_trigger）与被锁拒 abort 的
    // ts1_abort_fail 本身，二者都保持占用等 tick 边界处理。
    expect(service.metrics().preparedActive).toBe(2);
  });

  it("callback 抛错且 abort 未确认：rethrow 原始异常 + abort_failed marker + durable quarantine", () => {
    const service = makeService();
    let rethrown: unknown = null;
    try {
      service.executePreparedAction(freshInput(service, "ts1_throw_locked"), () => {
        const other = service.prepareTransaction(freshInput(service, "ts1_throw_trigger", -100));
        expect(other.status).toBe("prepared");
        injectOnce("receipt_publish");
        if (other.status === "prepared") {
          expect(service.commitPreparedTransaction(other.handle).status).toBe("rejected");
        }
        throw new Error("game api boom");
      });
    } catch (error) {
      rethrown = error;
    }
    expect((rethrown as Error).message).toBe("game api boom"); // 异常原样透传
    // marker 只保留首个 unresolved 根因（callback 内 trigger 的 commit fault）；
    // 抛错 handle 自身进 durable quarantine（phase=abort_failed）。
    const marker = readTreasuryWriteFault();
    expect(marker?.phase).toBe("receipt_publish");
    expect(marker?.transactionId).toBe("ts1_throw_trigger");
    const quarantined = readTreasuryQuarantineEntry("ts1_throw_locked");
    expect(quarantined).toBeDefined();
    expect(quarantined?.phase).toBe("abort_failed");
  });

  it("prepare 后人为损坏 receipt 再 commit：fatal fault + quarantine，绝不 already_settled", () => {
    const service = makeService();
    const prepared = service.prepareTransaction(freshInput(service, "ts1_corrupt"));
    expect(prepared.status).toBe("prepared");
    // 直接把已 load 的 store 中该 id 的 settled value 改为损坏值。
    const store = peekTreasuryReceiptStore();
    expect(store).toBeDefined();
    (store!.settled as Record<string, number>)["t:ts1_corrupt"] = Number.NaN;
    const committed = service.commitPreparedTransaction(
      (prepared as { status: "prepared"; handle: import("@/runtime/treasury/types").TreasuryPreparedHandle }).handle,
    );
    expect(committed.status).toBe("rejected");
    if (committed.status === "rejected") expect(committed.reason).toBe("handle_faulted");
    expect(readTreasuryWriteFault()?.transactionId).toBe("ts1_corrupt");
    // heap 零发布：损坏绝不触发 committed projection。
    expect(service.journal()).toHaveLength(0);
    service.endTick();
    expect(readTreasuryQuarantineEntry("ts1_corrupt")).toBeDefined();
  });
});

describe("第六轮 runtime input 验证前置：malformed input 结构化拒绝（不抛出）", () => {
  it.each([
    ["null input", null as never],
    ["undefined input", undefined as never],
    ["postings 非数组", { transactionId: "x1", kind: "k", source: "s", decision: { scope: "shared", epochSeq: 1, observedAtTick: 1 }, postings: "nope" } as never],
    ["postings 含 null 成员", { transactionId: "x2", kind: "k", source: "s", decision: { scope: "shared", epochSeq: 1, observedAtTick: 1 }, postings: [null] } as never],
    ["decision 缺失", { transactionId: "x3", kind: "k", source: "s", postings: [] } as never],
    ["decision 形状错误", { transactionId: "x4", kind: "k", source: "s", decision: "shared", postings: [] } as never],
    ["decision.scope 非法", { transactionId: "x5", kind: "k", source: "s", decision: { scope: "bogus", epochSeq: 1, observedAtTick: 1 }, postings: [] } as never],
    ["delta NaN", { transactionId: "x6", kind: "k", source: "s", decision: { scope: "shared", epochSeq: 1, observedAtTick: 1 }, postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: Number.NaN }] } as never],
    ["delta Infinity", { transactionId: "x7", kind: "k", source: "s", decision: { scope: "shared", epochSeq: 1, observedAtTick: 1 }, postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: Number.POSITIVE_INFINITY }] } as never],
    ["epochSeq 非整数", { transactionId: "x8", kind: "k", source: "s", decision: { scope: "shared", epochSeq: 1.5, observedAtTick: 1 }, postings: [] } as never],
  ])("%s：结构化 rejected（invalid_input），零副作用、callback 零调用", (_label, malformed) => {
    const service = makeService();
    let invoked = 0;
    const result = service.executePreparedAction(malformed, () => {
      invoked += 1;
      return { ok: true };
    });
    expect(result.status).toBe("prepare_rejected");
    if (result.status === "prepare_rejected") {
      expect(result.reason).toBe("invalid_input");
      expect(typeof result.detail).toBe("string");
    }
    expect(invoked).toBe(0);
    const metrics = service.metrics();
    expect(metrics.preparedActive).toBe(0);
    expect(metrics.tentativeCapacityKeys).toBe(0);
    expect(metrics.transactionsRejectedInvalid).toBe(1);
  });

  it("低层 prepareTransaction 同样前置验证（不抛出）", () => {
    const service = makeService();
    expect(() => service.prepareTransaction(null as never)).not.toThrow();
    const rejected = service.prepareTransaction(undefined as never);
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("invalid_input");
  });
});
