/**
 * Treasury 显式 fault resolution 协议测试（第六轮）：
 * - resolve-as-committed：补全/确认 receipt（幂等、最多提交一次）、释放
 *   quarantine、清除匹配 marker、防重放（同 id 再 prepare 命中
 *   already_settled）、global reset 后仍可完成、重复调用幂等；
 * - resolve-as-not-executed：仅 Game 结果未确认 phase（executing_at_end_tick
 *   / abort_failed）允许；释放 quarantine、不写 receipt、不生成 committed
 *   projection、显式返回允许重新 prepare；Game 确认 OK 后的 commit 故障
 *   phase 一律拒绝；
 * - 参数校验：未知 transactionId、digest 不匹配 → 拒绝且 fault/quarantine
 *   不动；resolution 完成前 write admission 持续锁定。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest, hasSettledReceipt } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  readTreasuryWriteFault,
  setTreasuryCommitFaultInjectorForTest,
  type TreasuryWriteFaultPhase,
} from "@/runtime/treasury/writeFault";
import { readTreasuryQuarantineEntry, treasuryQuarantineBlockers } from "@/runtime/treasury/quarantine";
import {
  resolveTreasuryQuarantinedTransactionAsCommitted,
  resolveTreasuryQuarantinedTransactionAsNotExecuted,
} from "@/runtime/treasury/faultResolution";
import { installRooms, type RoomSpec } from "@mock/treasury";
import type { TreasuryTransactionInput } from "@/runtime/treasury/types";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 5_000 },
  },
];

function makeService(): TreasuryService {
  const rooms = installRooms(ROOMS);
  const service = createTreasuryService({ getRooms: () => Object.values(rooms) });
  service.beginTick();
  return service;
}

function freshInput(service: TreasuryService, transactionId: string, delta = -500): TreasuryTransactionInput {
  const epoch = service.observation().epoch;
  return {
    transactionId,
    kind: "terminal.send",
    source: "test",
    decision: { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick },
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta }],
  };
}

function injectOnce(phase: TreasuryWriteFaultPhase): void {
  let fired = false;
  setTreasuryCommitFaultInjectorForTest((candidate) => {
    if (candidate === phase && !fired) {
      fired = true;
      throw new Error(`injected:${phase}`);
    }
  });
}

/** 制造一笔 commit-fault 后跨 tick 的 quarantine（Game 确认 OK 的故障）。 */
function makeCommittedFaultQuarantine(): { service: TreasuryService; digest: string } {
  const service = makeService();
  injectOnce("receipt_publish");
  const result = service.executePreparedAction(freshInput(service, "ts1_res_c"), () => ({ ok: true }));
  expect(result.status).toBe("executed_unsettled");
  if (result.status === "executed_unsettled") {
    service.endTick();
    return { service, digest: result.digest };
  }
  throw new Error("unreachable");
}

/** 制造一笔 executing 边界 quarantine（Game 结果未知）。 */
function makeExecutingQuarantine(): { service: TreasuryService; digest: string } {
  const service = makeService();
  const result = service.executePreparedAction(freshInput(service, "ts1_res_e"), () => {
    service.endTick();
    return { ok: false as const };
  });
  const entry = readTreasuryQuarantineEntry("ts1_res_e");
  expect(entry).toBeDefined();
  return { service, digest: entry!.digest };
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  setTreasuryCommitFaultInjectorForTest(null);
});

afterEach(() => {
  setTreasuryCommitFaultInjectorForTest(null);
});

describe("resolve-as-committed", () => {
  it("补全 settlement：释放 quarantine、清除 marker、防重放、重复调用幂等", () => {
    const { service, digest } = makeCommittedFaultQuarantine();
    expect(readTreasuryQuarantineEntry("ts1_res_c")).toBeDefined();
    expect(readTreasuryWriteFault()?.transactionId).toBe("ts1_res_c");
    const resolved = resolveTreasuryQuarantinedTransactionAsCommitted({ transactionId: "ts1_res_c", digest });
    expect(resolved.status).toBe("resolved");
    if (resolved.status === "resolved") {
      expect(resolved.resolution).toBe("committed");
      expect(resolved.receiptWritten).toBe(true); // receipt_publish 故障：receipt 未写，本次补全
      expect(resolved.reprepareAllowed).toBe(false);
    }
    expect(readTreasuryQuarantineEntry("ts1_res_c")).toBeUndefined();
    expect(readTreasuryWriteFault()).toBeUndefined(); // 匹配 marker 被清除
    expect(hasSettledReceipt("ts1_res_c")).toBe(1); // entry.tick（故障发生 tick）
    // 防重放：同 id 再 prepare 命中 already_settled。
    expect(service.prepareTransaction(freshInput(service, "ts1_res_c")).status).toBe("already_settled");
    // 重复 resolution：幂等 already_resolved（不重复计账）。
    const again = resolveTreasuryQuarantinedTransactionAsCommitted({ transactionId: "ts1_res_c" });
    expect(again.status).toBe("already_resolved");
  });

  it("global reset 后仍可完成（新 service 实例、Memory 保留）", () => {
    const { digest } = makeCommittedFaultQuarantine();
    Game.time += 1;
    const rooms = installRooms(ROOMS);
    const second = createTreasuryService({ getRooms: () => Object.values(rooms) });
    second.beginTick();
    expect(second.metrics().writeAdmissionLocked).toBe(1); // 解除前锁定
    const resolved = resolveTreasuryQuarantinedTransactionAsCommitted({ transactionId: "ts1_res_c", digest });
    expect(resolved.status).toBe("resolved");
    expect(second.metrics().writeAdmissionLocked).toBe(0);
    expect(treasuryQuarantineBlockers().blocking).toBe(false);
  });

  it("receipt 已写入的故障（heap_publish）：resolution 幂等确认，不重复计账", () => {
    const service = makeService();
    injectOnce("heap_publish");
    const result = service.executePreparedAction(freshInput(service, "ts1_res_h"), () => ({ ok: true }));
    expect(result.status).toBe("executed_unsettled");
    service.endTick();
    // receipt 在 heap_publish 故障前已写入。
    expect(hasSettledReceipt("ts1_res_h")).toBeDefined();
    const resolved = resolveTreasuryQuarantinedTransactionAsCommitted({ transactionId: "ts1_res_h" });
    expect(resolved.status).toBe("resolved");
    if (resolved.status === "resolved") expect(resolved.receiptWritten).toBe(false); // 幂等命中
    // settlement 只计一次：重复 resolution 后仍只有一条 receipt。
    resolveTreasuryQuarantinedTransactionAsCommitted({ transactionId: "ts1_res_h" });
    expect(hasSettledReceipt("ts1_res_h")).toBe(1);
  });
});

describe("resolve-as-not-executed", () => {
  it("executing_at_end_tick（Game 结果未知）：允许释放且可重新 prepare，不产生 receipt/projection", () => {
    const { service } = makeExecutingQuarantine();
    Game.time += 1;
    service.beginTick();
    const resolved = resolveTreasuryQuarantinedTransactionAsNotExecuted({ transactionId: "ts1_res_e" });
    expect(resolved.status).toBe("resolved");
    if (resolved.status === "resolved") {
      expect(resolved.resolution).toBe("not-executed");
      expect(resolved.receiptWritten).toBe(false);
      expect(resolved.reprepareAllowed).toBe(true);
    }
    expect(readTreasuryQuarantineEntry("ts1_res_e")).toBeUndefined();
    expect(readTreasuryWriteFault()).toBeUndefined();
    expect(hasSettledReceipt("ts1_res_e")).toBeUndefined(); // 无虚假 receipt
    // 允许重新 prepare（同 id 新一轮完整协议）。
    const reprepared = service.prepareTransaction(freshInput(service, "ts1_res_e"));
    expect(reprepared.status).toBe("prepared");
  });

  it("Game 确认 OK 后的 commit 故障 phase：不允许 not-executed（fault 不动）", () => {
    makeCommittedFaultQuarantine(); // ts1_res_c：Game callback 已确认成功
    const rejected = resolveTreasuryQuarantinedTransactionAsNotExecuted({ transactionId: "ts1_res_c" });
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("resolution_not_allowed");
    // fault/quarantine 保持不变，锁仍生效。
    expect(readTreasuryQuarantineEntry("ts1_res_c")).toBeDefined();
    expect(readTreasuryWriteFault()?.transactionId).toBe("ts1_res_c");
  });
});

describe("resolution 参数校验与安全边界", () => {
  it("未知 transactionId：拒绝且零副作用", () => {
    const rejected = resolveTreasuryQuarantinedTransactionAsCommitted({ transactionId: "ts1_unknown" });
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("not_found");
  });

  it("digest 不匹配：拒绝解决错误 transaction（fault/quarantine 不动）", () => {
    makeCommittedFaultQuarantine();
    const rejected = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "ts1_res_c",
      digest: "deadbeefdeadbeef",
    });
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("digest_mismatch");
    expect(readTreasuryQuarantineEntry("ts1_res_c")).toBeDefined();
    expect(readTreasuryWriteFault()?.transactionId).toBe("ts1_res_c");
  });

  it("malformed input：结构化拒绝", () => {
    expect(resolveTreasuryQuarantinedTransactionAsCommitted({ transactionId: "" }).status).toBe("rejected");
    expect(
      resolveTreasuryQuarantinedTransactionAsNotExecuted(null as never).status,
    ).toBe("rejected");
  });

  it("marker 指向其它 transaction 时：resolution 不清除该 marker（锁持续）", () => {
    // 同 tick 两笔：ts1_a 先 commit fault（marker 根因=ts1_a）；ts1_b 的
    // Game callback 已成功但 commit 被全局锁拒（executed_unsettled——立即
    // 落 durable fault+quarantine）。解决 ts1_b 不触碰 ts1_a 的 marker。
    const service = makeService();
    const bResult = service.executePreparedAction(freshInput(service, "ts1_b"), () => {
      const a = service.prepareTransaction(freshInput(service, "ts1_a"));
      expect(a.status).toBe("prepared");
      injectOnce("receipt_publish");
      if (a.status === "prepared") {
        expect(service.commitPreparedTransaction(a.handle).status).toBe("rejected");
      }
      return { ok: true as const };
    });
    expect(bResult.status).toBe("executed_unsettled"); // Game OK，commit 被锁拒 → 立即隔离
    expect(readTreasuryQuarantineEntry("ts1_b")).toBeDefined();
    expect(readTreasuryWriteFault()?.transactionId).toBe("ts1_a"); // 首条根因
    // 解决 ts1_b：释放其 quarantine，但 marker（ts1_a 根因）不动——锁持续。
    const resolved = resolveTreasuryQuarantinedTransactionAsCommitted({ transactionId: "ts1_b" });
    expect(resolved.status).toBe("resolved");
    expect(readTreasuryWriteFault()?.transactionId).toBe("ts1_a");
    expect(readTreasuryQuarantineEntry("ts1_b")).toBeUndefined();
    expect(readTreasuryQuarantineEntry("ts1_a")).toBeUndefined(); // ts1_a 仍 faulted（等 tick 边界）
  });
});
