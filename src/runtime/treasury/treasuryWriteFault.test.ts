/**
 * Treasury staged commit 原子性与 write-fault 故障注入测试（第五轮）：
 * - 故障点注入：receipt publish 前 / receipt 后 heap 前 / journal publish /
 *   overlay publish / handle 状态更新——每个故障点必须证明：不存在静默
 *   半提交（显式 marker + faulted 终态 + 后续 writer fail closed）；
 * - faulted handle 的 tentative 预留与 receipt 槽不释放；
 * - write admission 全局锁阻断 prepare/commit/abort/单阶段；
 * - global reset（新 service 实例、Memory 保留）后仍能发现 unresolved
 *   write fault；修复流程必须显式（第六轮起为 fault resolution 协议），
 *   绝不自动清空；
 * - 正常路径无故障时 marker 恒缺失。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { compatRecordAcceptedTransaction } from "@/runtime/treasury/compat";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  readTreasuryWriteFault,
  setTreasuryCommitFaultInjectorForTest,
  type TreasuryWriteFaultPhase,
} from "@/runtime/treasury/writeFault";
import { resolveTreasuryQuarantinedTransactionAsCommitted } from "@/runtime/treasury/faultResolution";
import { readTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
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

function prepareOk(service: TreasuryService, transactionId: string): TreasuryTransactionInput & { handle: import("@/runtime/treasury/types").TreasuryPreparedHandle } {
  const epoch = service.observation().epoch;
  const input: TreasuryTransactionInput = {
    transactionId,
    kind: "terminal.send",
    source: "test",
    decision: { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick },
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 }],
  };
  const prepared = service.prepareTransaction(input);
  expect(prepared.status).toBe("prepared");
  if (prepared.status !== "prepared") throw new Error("prepare 失败");
  return { ...input, handle: prepared.handle };
}

/** 构造基于 service 当前 shared epoch 的输入（跨 tick 重试须重建 decision）。 */
function freshInput(service: TreasuryService, transactionId: string): TreasuryTransactionInput {
  const epoch = service.observation().epoch;
  return {
    transactionId,
    kind: "terminal.send",
    source: "test",
    decision: { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick },
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 }],
  };
}

/** 在指定 phase 注入一次故障。 */
function injectOnce(phase: TreasuryWriteFaultPhase): void {
  let fired = false;
  setTreasuryCommitFaultInjectorForTest((candidate) => {
    if (candidate === phase && !fired) {
      fired = true;
      throw new Error(`injected:${phase}`);
    }
  });
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  setTreasuryCommitFaultInjectorForTest(null);
});

afterEach(() => {
  setTreasuryCommitFaultInjectorForTest(null);
});

describe("staged commit 故障注入", () => {
  it("receipt publish 前失败：零 heap 状态、receipt 未写、faulted + 全局锁", () => {
    const service = makeService();
    const prepared = prepareOk(service, "ts1_fault_receipt");
    injectOnce("receipt_publish");
    const committed = service.commitPreparedTransaction(prepared.handle);
    expect(committed.status).toBe("rejected");
    if (committed.status === "rejected") expect(committed.reason).toBe("handle_faulted");
    // 零 heap 状态：无 journal、无投影变化。
    expect(service.journal()).toHaveLength(0);
    expect(service.projectedUsedCapacity("W1N57", "storage")).toBe(100_000);
    // receipt 未写：幂等未成立（该 id 后续在锁解除后可重新走）。
    // marker：phase=receipt_publish、unresolved、tentative/槽不释放。
    const marker = readTreasuryWriteFault();
    expect(marker).toBeDefined();
    expect(marker?.phase).toBe("receipt_publish");
    expect(marker?.transactionId).toBe("ts1_fault_receipt");
    expect(marker?.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(marker?.status).toBe("unresolved");
    const metrics = service.metrics();
    expect(metrics.commitFaults).toBe(1);
    expect(metrics.writeAdmissionLocked).toBe(1);
    expect(metrics.preparedActive).toBe(1); // faulted handle 仍占用（preparedById 未清）
    expect(metrics.tentativeCapacityKeys).toBe(1); // tentative 不释放
  });

  it("receipt 写入后 heap 发布前失败：receipt 权威保留、heap 零写入、marker 记录", () => {
    const service = makeService();
    const prepared = prepareOk(service, "ts1_fault_heap");
    injectOnce("heap_publish");
    const committed = service.commitPreparedTransaction(prepared.handle);
    expect(committed.status).toBe("rejected");
    if (committed.status === "rejected") expect(committed.reason).toBe("handle_faulted");
    expect(readTreasuryWriteFault()?.phase).toBe("heap_publish");
    // heap 零写入：journal 空、投影不变。
    expect(service.journal()).toHaveLength(0);
    expect(service.projectedUsedCapacity("W1N57", "storage")).toBe(100_000);
    // receipt 权威已写入：tick 边界 faulted 转 quarantine 后，显式
    // resolve-as-committed（幂等命中既有 receipt）解锁；同 id 重放命中
    // already_settled（幂等保住，不会二次结算）——半提交状态显式可恢复。
    service.endTick();
    const quarantined = readTreasuryQuarantineEntry("ts1_fault_heap");
    expect(quarantined).toBeDefined();
    const resolved = resolveTreasuryQuarantinedTransactionAsCommitted({ transactionId: "ts1_fault_heap" });
    expect(resolved.status).toBe("resolved");
    const replay = service.prepareTransaction({ ...prepared, handle: undefined } as unknown as TreasuryTransactionInput);
    expect(replay.status).toBe("already_settled");
  });

  it("journal publish 失败：不产生静默半提交（marker + 锁 + 故障计数）", () => {
    const service = makeService();
    const prepared = prepareOk(service, "ts1_fault_journal");
    injectOnce("journal_publish");
    expect(service.commitPreparedTransaction(prepared.handle).status).toBe("rejected");
    expect(readTreasuryWriteFault()?.phase).toBe("journal_publish");
    expect(service.journal()).toHaveLength(0);
    expect(service.metrics().writeAdmissionLocked).toBe(1);
  });

  it("overlay publish 失败：journal 有记录但 overlay 缺失——显式 faulted 而非静默", () => {
    const service = makeService();
    const prepared = prepareOk(service, "ts1_fault_overlay");
    injectOnce("overlay_publish");
    expect(service.commitPreparedTransaction(prepared.handle).status).toBe("rejected");
    expect(readTreasuryWriteFault()?.phase).toBe("overlay_publish");
    // journal 已 push、overlay 未推进：不一致状态被 marker + 全局锁显式
    // 封存（绝不当作 committed 成功返回）。
    expect(service.journal()).toHaveLength(1);
    expect(service.projectedUsedCapacity("W1N57", "storage")).toBe(100_000);
    expect(service.metrics().writeAdmissionLocked).toBe(1);
  });

  it("handle 状态更新失败：receipt+heap 已发布，commit 结果仍为故障而非成功", () => {
    const service = makeService();
    const prepared = prepareOk(service, "ts1_fault_handle");
    injectOnce("handle_state");
    const committed = service.commitPreparedTransaction(prepared.handle);
    expect(committed.status).toBe("rejected");
    if (committed.status === "rejected") expect(committed.reason).toBe("handle_faulted");
    expect(readTreasuryWriteFault()?.phase).toBe("handle_state");
    // 数据侧已发布（journal/overlay/receipt 均生效）——但状态被 marker 封存。
    expect(service.journal()).toHaveLength(1);
    expect(service.metrics().writeAdmissionLocked).toBe(1);
  });

  it("fatal commit fault 后其他 writer 全部 fail closed（prepare/commit/abort/单阶段）", () => {
    const service = makeService();
    const faulted = prepareOk(service, "ts1_fault_lock");
    injectOnce("receipt_publish");
    expect(service.commitPreparedTransaction(faulted.handle).status).toBe("rejected");
    // 另一笔正常 prepare：被全局锁拒绝。
    const other = service.prepareTransaction({
      ...faulted,
      handle: undefined,
      transactionId: "ts1_other",
    } as unknown as TreasuryTransactionInput);
    expect(other.status).toBe("rejected");
    if (other.status === "rejected") expect(other.reason).toBe("write_admission_locked");
    // 单阶段登记同样被锁。
    const single = compatRecordAcceptedTransaction(service, {
      ...faulted,
      handle: undefined,
      transactionId: "ts1_single",
    } as unknown as TreasuryTransactionInput);
    expect(single.status).toBe("rejected");
    if (single.status === "rejected") expect(single.reason).toBe("write_admission_locked");
  });

  it("global reset 后仍能发现 unresolved write fault（新 service 实例、Memory 保留）", () => {
    const first = makeService();
    const prepared = prepareOk(first, "ts1_reset_fault");
    injectOnce("receipt_publish");
    expect(first.commitPreparedTransaction(prepared.handle).status).toBe("rejected");
    // 模拟 global reset：heap 全失，Memory 保留——直接重建 service 实例。
    const rooms = installRooms(ROOMS);
    const second = createTreasuryService({ getRooms: () => Object.values(rooms) });
    second.beginTick();
    expect(second.metrics().writeAdmissionLocked).toBe(1);
    expect(readTreasuryWriteFault()?.transactionId).toBe("ts1_reset_fault");
    // 锁持续：新实例上一切 writer 拒绝。
    const locked = second.prepareTransaction({
      ...prepared,
      handle: undefined,
      transactionId: "ts1_after_reset",
    } as unknown as TreasuryTransactionInput);
    expect(locked.status).toBe("rejected");
    if (locked.status === "rejected") expect(locked.reason).toBe("write_admission_locked");
  });

  it("修复流程必须显式：多个 tick 的 begin/end 不自动清除，repair 后恢复", () => {
    const service = makeService();
    const prepared = prepareOk(service, "ts1_repair");
    injectOnce("receipt_publish");
    expect(service.commitPreparedTransaction(prepared.handle).status).toBe("rejected");
    // 多个 tick 生命周期不自动清除安全故障。
    Game.time += 1;
    service.beginTick();
    service.endTick();
    Game.time += 1;
    service.beginTick();
    expect(readTreasuryWriteFault()).toBeDefined();
    expect(service.metrics().writeAdmissionLocked).toBe(1);
    // 显式 resolution 路径解除（faulted 已在上一 endTick 转 quarantine）。
    const resolved = resolveTreasuryQuarantinedTransactionAsCommitted({ transactionId: "ts1_repair" });
    expect(resolved.status).toBe("resolved");
    expect(service.metrics().writeAdmissionLocked).toBe(0);
    const after = service.prepareTransaction(freshInput(service, "ts1_after_repair"));
    expect(after.status).toBe("prepared");
  });

  it("正常路径无故障时 marker 恒缺失", () => {
    const service = makeService();
    const prepared = prepareOk(service, "ts1_ok");
    expect(service.commitPreparedTransaction(prepared.handle).status).toBe("committed");
    expect(readTreasuryWriteFault()).toBeUndefined();
    expect(service.metrics().writeAdmissionLocked).toBe(0);
    expect(service.metrics().commitFaults).toBe(0);
  });
});

describe("endTick outstanding prepared 审计", () => {
  it("endTick 发现普通 outstanding prepare：计数 + 有界样本 + 指标，非静默 abort", () => {
    const service = makeService();
    prepareOk(service, "ts1_leak_a");
    prepareOk(service, "ts1_leak_b");
    service.endTick();
    const audit = service.preparedLeakAudit();
    expect(audit.context).toBe("end_tick");
    expect(audit.outstanding).toBe(2);
    expect(audit.executing).toBe(0);
    expect(audit.samples).toHaveLength(2);
    expect(audit.samples[0].transactionId).toBe("ts1_leak_a");
    expect(audit.samples[0].digest).toMatch(/^[0-9a-f]{16}$/);
    expect(audit.samples[0].preparedAtTick).toBe(Game.time);
    const metrics = service.metrics();
    expect(metrics.preparedOutstandingAtEnd).toBe(2);
    expect(metrics.preparedExecutingAtEnd).toBe(0);
    // 预留面被释放（普通 prepared 在 tick 边界失效）。
    expect(metrics.preparedActive).toBe(0);
    expect(metrics.tentativeCapacityKeys).toBe(0);
  });

  it("endTick 发现 executing handle：严重故障 → write-fault marker + 全局锁", () => {
    const service = makeService();
    const epoch = service.observation().epoch;
    // action 回调内重入 endTick：executing 状态暴露给 tick 边界。
    const inner = service.executePreparedAction(
      {
        transactionId: "ts1_executing_leak",
        kind: "terminal.send",
        source: "test",
        decision: { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick },
        postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 }],
      },
      () => {
        service.endTick();
        return { ok: true as const };
      },
    );
    expect(inner.status).toBe("executed_unsettled");
    if (inner.status === "executed_unsettled") {
      expect(inner.faultReason).not.toBe("invalid_handle");
      expect(inner.retryForbidden).toBe(true);
    }
    const marker = readTreasuryWriteFault();
    expect(marker?.phase).toBe("executing_at_end_tick");
    expect(marker?.transactionId).toBe("ts1_executing_leak");
    expect(service.metrics().preparedExecutingAtEnd).toBe(1);
    expect(service.metrics().writeAdmissionLocked).toBe(1);
  });

  it("下一 tick 旧 handle 不可用（expired），审计后重新 prepare 合法", () => {
    const service = makeService();
    const prepared = prepareOk(service, "ts1_cross");
    service.endTick();
    Game.time += 1;
    service.beginTick();
    const committed = service.commitPreparedTransaction(prepared.handle);
    expect(committed.status).toBe("rejected");
    if (committed.status === "rejected") expect(committed.reason).toBe("handle_expired");
    const again = service.prepareTransaction(freshInput(service, "ts1_cross"));
    expect(again.status).toBe("prepared");
  });
});
