/**
 * Treasury opaque prepared handle 专项测试（第五轮）：
 * - 防伪：结构相同的伪造对象、JSON round-trip 副本、其他 service
 *   generation 签发的 handle 一律无效（invalid_handle）；
 * - tick/generation 自校验：previous tick handle 即使未先 beginTick 也
 *   拒绝（handle_expired）；
 * - canonical snapshot：prepare 后修改原 input 不影响 canonical payload；
 * - payload digest：相同 ID 相同 payload 幂等返回同一 handle、不同 payload
 *   prepare_conflict；
 * - 状态机：commit 一次/abort 一次、terminal 不回退；
 * - 生命周期有界（第六轮）：大量 prepare→commit/abort/expire 循环后
 *   active strong registry 回到 0（不随历史 transaction 数量增长）；
 *   terminal handle 在引用仍存在时经 WeakMap 返回稳定幂等结果。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { installRooms, type RoomSpec } from "@mock/treasury";
import type { TreasuryPreparedHandle, TreasuryTransactionInput } from "@/runtime/treasury/types";

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

function input(service: TreasuryService, transactionId: string, delta = -500): TreasuryTransactionInput {
  const epoch = service.observation().epoch;
  return {
    transactionId,
    kind: "terminal.send",
    source: "test",
    decision: { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick },
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta }],
  };
}

function prepareOk(service: TreasuryService, transactionId: string, delta = -500): TreasuryPreparedHandle {
  const prepared = service.prepareTransaction(input(service, transactionId, delta));
  expect(prepared.status).toBe("prepared");
  if (prepared.status !== "prepared") throw new Error("prepare 失败");
  expect(Object.isFrozen(prepared.handle)).toBe(true);
  return prepared.handle;
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
});

describe("Treasury opaque handle 防伪", () => {
  it("commit/abort 使用真实 handle 成功", () => {
    const service = makeService();
    const handle = prepareOk(service, "ts1_real");
    expect(service.commitPreparedTransaction(handle).status).toBe("committed");
  });

  it("结构相同的伪造对象无效（invalid_handle）", () => {
    const service = makeService();
    const handle = prepareOk(service, "ts1_real");
    const forged = Object.freeze({
      __brand: "treasury-prepared-handle" as const,
      transactionId: handle.transactionId,
      digest: handle.digest,
    });
    const committed = service.commitPreparedTransaction(forged);
    expect(committed.status).toBe("rejected");
    if (committed.status === "rejected") expect(committed.reason).toBe("invalid_handle");
    const aborted = service.abortPreparedTransaction(forged);
    expect(aborted.status).toBe("rejected");
    if (aborted.status === "rejected") expect(aborted.reason).toBe("invalid_handle");
    // 真实 handle 仍可用（伪造尝试无副作用）。
    expect(service.commitPreparedTransaction(handle).status).toBe("committed");
    expect(service.metrics().invalidHandleRejections).toBeGreaterThanOrEqual(2);
  });

  it("JSON 序列化再反序列化的副本无效（对象身份防伪）", () => {
    const service = makeService();
    const handle = prepareOk(service, "ts1_real");
    const copy = JSON.parse(JSON.stringify(handle)) as TreasuryPreparedHandle;
    const committed = service.commitPreparedTransaction(copy);
    expect(committed.status).toBe("rejected");
    if (committed.status === "rejected") expect(committed.reason).toBe("invalid_handle");
  });

  it("另一个 Treasury service generation 的 handle 无效", () => {
    const first = makeService();
    const second = makeService();
    const foreignHandle = prepareOk(first, "ts1_foreign");
    const committed = second.commitPreparedTransaction(foreignHandle);
    expect(committed.status).toBe("rejected");
    if (committed.status === "rejected") expect(committed.reason).toBe("invalid_handle");
    const aborted = second.abortPreparedTransaction(foreignHandle);
    expect(aborted.status).toBe("rejected");
    if (aborted.status === "rejected") expect(aborted.reason).toBe("invalid_handle");
  });

  it("previous tick handle 即使未先 beginTick 也拒绝（handle 自校验 tick）", () => {
    const service = makeService();
    const handle = prepareOk(service, "ts1_old");
    Game.time += 1;
    // 不调用 beginTick，直接对旧 handle commit/abort。
    const committed = service.commitPreparedTransaction(handle);
    expect(committed.status).toBe("rejected");
    if (committed.status === "rejected") expect(committed.reason).toBe("handle_expired");
    const aborted = service.abortPreparedTransaction(handle);
    expect(aborted.status).toBe("rejected");
    if (aborted.status === "rejected") expect(aborted.reason).toBe("handle_expired");
  });

  it("global reset 语义：新 service 实例（新 generation）后旧 handle 不可恢复", () => {
    const first = makeService();
    const handle = prepareOk(first, "ts1_before_reset");
    // 模拟 global reset：同一 tick，全新 service 实例。
    const second = makeService();
    const committed = second.commitPreparedTransaction(handle);
    expect(committed.status).toBe("rejected");
    if (committed.status === "rejected") expect(committed.reason).toBe("invalid_handle");
  });
});

describe("Treasury handle payload digest 与状态机", () => {
  it("相同 ID 相同 payload 幂等返回同一 handle（对象身份相同）", () => {
    const service = makeService();
    const first = service.prepareTransaction(input(service, "ts1_idem"));
    const second = service.prepareTransaction(input(service, "ts1_idem"));
    expect(first.status).toBe("prepared");
    expect(second.status).toBe("prepared");
    if (first.status === "prepared" && second.status === "prepared") {
      expect(second.handle).toBe(first.handle);
      expect(second.digest).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("相同 ID 不同 payload 返回 prepare_conflict（不无条件 prepared）", () => {
    const service = makeService();
    expect(service.prepareTransaction(input(service, "ts1_clash", -500)).status).toBe("prepared");
    const conflict = service.prepareTransaction(input(service, "ts1_clash", -501));
    expect(conflict.status).toBe("rejected");
    if (conflict.status === "rejected") expect(conflict.reason).toBe("prepare_conflict");
    // 不同 source/kind 同样构成 payload 差异。
    const base = input(service, "ts1_clash2", -500);
    expect(service.prepareTransaction(base).status).toBe("prepared");
    const asSource = service.prepareTransaction({ ...base, source: "other" });
    expect(asSource.status).toBe("rejected");
    if (asSource.status === "rejected") expect(asSource.reason).toBe("prepare_conflict");
  });

  it("prepare 后调用方修改原 input 不影响 Treasury canonical payload", () => {
    const service = makeService();
    const original = input(service, "ts1_canonical", -500);
    expect(service.prepareTransaction(original).status).toBe("prepared");
    // 原地篡改：同 id 但"新 payload"与 canonical 相同 → 幂等而非 conflict。
    (original.postings[0] as { delta: number }).delta = -501;
    const again = service.prepareTransaction(input(service, "ts1_canonical", -500));
    expect(again.status).toBe("prepared");
    // 且与被篡改的 -501 payload 构成冲突。
    const conflict = service.prepareTransaction(original);
    expect(conflict.status).toBe("rejected");
    if (conflict.status === "rejected") expect(conflict.reason).toBe("prepare_conflict");
  });

  it("commit 只能成功一次：重复 commit 幂等 already_settled，不可再 abort", () => {
    const service = makeService();
    const handle = prepareOk(service, "ts1_once");
    expect(service.commitPreparedTransaction(handle).status).toBe("committed");
    expect(service.commitPreparedTransaction(handle).status).toBe("already_settled");
    const aborted = service.abortPreparedTransaction(handle);
    expect(aborted.status).toBe("already_finalized");
    if (aborted.status === "already_finalized") expect(aborted.finalizedAs).toBe("committed");
    expect(service.journal()).toHaveLength(1);
  });

  it("abort 只能成功一次：abort 后 commit 拒绝、重复 abort 幂等 already_finalized", () => {
    const service = makeService();
    const handle = prepareOk(service, "ts1_once");
    expect(service.abortPreparedTransaction(handle).status).toBe("aborted");
    const committed = service.commitPreparedTransaction(handle);
    expect(committed.status).toBe("rejected");
    if (committed.status === "rejected") expect(committed.reason).toBe("handle_finalized");
    const reabort = service.abortPreparedTransaction(handle);
    expect(reabort.status).toBe("already_finalized");
    if (reabort.status === "already_finalized") expect(reabort.finalizedAs).toBe("aborted");
    expect(service.journal()).toHaveLength(0);
    // aborted id 可重新 prepare（id 未被 receipt 占用）。
    expect(service.prepareTransaction(input(service, "ts1_once")).status).toBe("prepared");
  });
});

describe("handle 生命周期有界（第六轮）", () => {
  it("大量 prepare→commit/abort/expire 循环后 active registry 回到 0，terminal handle 幂等可用", () => {
    const service = makeService();
    const retainedHandles: TreasuryPreparedHandle[] = [];
    for (let index = 0; index < 200; index += 1) {
      const handle = prepareOk(service, `ts1_life${index}`);
      if (index % 2 === 0) {
        expect(service.commitPreparedTransaction(handle).status).toBe("committed");
      } else {
        expect(service.abortPreparedTransaction(handle).status).toBe("aborted");
      }
      retainedHandles.push(handle); // 模拟调用方仍持有 terminal handle 引用
    }
    // active strong registry 回到 0：终态记录已替换为轻量 stub（WeakMap），
    // 不随 200 笔历史 transaction 增长。
    expect(service.metrics().preparedActive).toBe(0);
    expect(service.metrics().tentativeCapacityKeys).toBe(0);

    // terminal handle 在引用仍存在时返回稳定幂等结果（不形成全局强引用）。
    const committedHandle = retainedHandles[0]!;
    expect(service.commitPreparedTransaction(committedHandle).status).toBe("already_settled");
    const abortedHandle = retainedHandles[1]!;
    const reaborted = service.abortPreparedTransaction(abortedHandle);
    expect(reaborted.status).toBe("already_finalized");

    // expire 路径同样 stub 化：未决 handle 在 tick 边界后 active 计数归零。
    prepareOk(service, "ts1_life_leak");
    expect(service.metrics().preparedActive).toBe(1);
    service.endTick();
    expect(service.metrics().preparedActive).toBe(0);
  });
});
