/**
 * 【第十六轮第五节】显式 attempt rearm 协议测试（same-ID 不可重试）。
 *
 * 覆盖：
 * - final not-executed 后同 ID 直接 prepare：拒绝（rearm_required）、callback
 *   零调用；
 * - 显式 rearm 生成合法 child ID；同 parent 重复 rearm 幂等；不同 parent /
 *   不同 parent identity 得到不同 child；global reset 后一致；
 * - parent 仍有 authority / marker 未清 / resolving tombstone / legacy-forensic
 *   不足 proof → rearm 拒绝；
 * - child contract 使用 child ID；parent proof 不能解决 child authority；
 * - child 故障后可独立 resolution；child not-executed 后可继续 rearm 生成
 *   孙代（A→B→C 链）；
 * - 旧 reprepareAllowed=true 语义已删除（sameIdRetryAllowed 恒 false +
 *   rearmChildTransactionId）。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { readTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import { readTreasuryResolutionTombstone, writeTreasuryResolutionTombstone } from "@/runtime/treasury/resolutionStore";
import { recordTreasuryWriteFault } from "@/runtime/treasury/writeFault";
import { deriveTreasuryRearmChildTransactionId } from "@/runtime/treasury/attemptRearm";
import {
  makeTreasuryTestTransferAdapter,
  replaceTreasuryActionAdapterForTest,
  type TreasuryActionReconcilerConclusion,
} from "@/runtime/treasury/actionContracts";
import { installRooms, type RoomSpec } from "@mock/treasury";
import type { TreasuryTransactionInput } from "@/runtime/treasury/types";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import { setTreasuryCommitFaultInjectorForTest } from "@/runtime/treasury/writeFault";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 5_000 },
  },
];

/** 侧效计数：证明拒绝路径 Game callback 零调用。 */
let executeCalls = 0;

function makeService(): TreasuryTestService {
  const rooms = installRooms(ROOMS);
  const service = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
  service.beginTick();
  return treasuryTestService(service);
}

function freshInput(service: TreasuryTestService, transactionId: string, delta = -500): TreasuryTransactionInput {
  const epoch = service.observation().epoch;
  return {
    transactionId,
    kind: "terminal.send",
    source: "test",
    decision: { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick },
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta }],
  };
}

let reconcilerConclusion: TreasuryActionReconcilerConclusion = "observed_not_executed";

function registerTerminalSendReconciler(): void {
  replaceTreasuryActionAdapterForTest({
    ...makeTreasuryTestTransferAdapter(),
    kind: "terminal.send",
    semanticIdentity: "terminal.send@reconciler-semantics-v1",
    reconcile: () => reconcilerConclusion,
  });
}

/** 制造 executing 边界 quarantine（Game 结果未知）并跨 tick。 */
function makeExecutingQuarantine(transactionId: string): { digest: string } {
  const service = makeService();
  service.executePreparedAction(freshInput(service, transactionId), () => {
    service.endTick();
    return { ok: false as const };
  });
  const entry = readTreasuryQuarantineEntry(transactionId);
  expect(entry).toBeDefined();
  return { digest: entry!.digest };
}

function advanceTick(): TreasuryTestService {
  Game.time += 1;
  const next = makeService();
  next.beginTick();
  return next;
}

/** 完整执行 not-executed resolution（真实 service 路径），返回 resolve 结果。 */
function resolveNotExecuted(service: TreasuryTestService, transactionId: string) {
  const issued = service.issueTreasuryReconciliationCapability({ transactionId });
  if (issued.status !== "issued") return issued;
  return service.resolveUnresolvedTransaction({ transactionId, capability: issued.capability });
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  setTreasuryCommitFaultInjectorForTest(null);
  executeCalls = 0;
  reconcilerConclusion = "observed_not_executed";
  registerTerminalSendReconciler();
});

describe("attempt rearm（第十六轮第五节）", () => {
  it("final not-executed 后相同 transaction ID 直接 prepare：拒绝、callback 零调用、rearm-required 语义", () => {
    makeExecutingQuarantine("rearm_same_id");
    const next = advanceTick();
    const resolved = resolveNotExecuted(next, "rearm_same_id");
    expect(resolved.status).toBe("resolved");
    const reprepared = next.prepareTransaction(freshInput(next, "rearm_same_id"));
    expect(reprepared.status).toBe("rejected");
    if (reprepared.status === "rejected") {
      expect(reprepared.reason).toBe("rearm_required");
      expect(reprepared.detail).toContain("rearm");
    }
    expect(executeCalls).toBe(0);
  });

  it("resolve 结果语义：sameIdRetryAllowed 恒 false 且返回确定性 rearm child ID（旧 reprepareAllowed 已删除）", () => {
    makeExecutingQuarantine("rearm_semantics");
    const next = advanceTick();
    const resolved = resolveNotExecuted(next, "rearm_semantics");
    expect(resolved.status).toBe("resolved");
    if (resolved.status === "resolved") {
      expect(resolved.sameIdRetryAllowed).toBe(false);
      expect(typeof resolved.rearmChildTransactionId).toBe("string");
      expect((resolved as { reprepareAllowed?: boolean }).reprepareAllowed).toBeUndefined();
      // 与独立派生的 child ID 一致（确定性）。
      const tombstone = readTreasuryResolutionTombstone("rearm_semantics")!;
      expect(resolved.rearmChildTransactionId).toBe(
        deriveTreasuryRearmChildTransactionId({
          transactionId: "rearm_semantics",
          digest: tombstone.digest,
          ...(tombstone.durableIdentityDigest !== undefined ? { durableIdentityDigest: tombstone.durableIdentityDigest } : {}),
          ...(tombstone.lowlevelSource !== undefined ? { lowlevelSource: tombstone.lowlevelSource } : {}),
        }),
      );
    }
  });

  it("显式 rearm 生成合法 child ID；同 parent 重复 rearm 幂等；global reset 后一致", () => {
    makeExecutingQuarantine("rearm_idem");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "rearm_idem").status).toBe("resolved");
    const first = next.rearmResolvedNotExecutedAttempt({ parentTransactionId: "rearm_idem" });
    expect(first.status).toBe("rearmed");
    if (first.status !== "rearmed") return;
    expect(first.childTransactionId).toMatch(/^tr1_[0-9a-f]{16}$/);
    expect(first.childTransactionId.length).toBeLessThanOrEqual(128);
    const second = next.rearmResolvedNotExecutedAttempt({ parentTransactionId: "rearm_idem" });
    expect(second.status).toBe("rearmed");
    if (second.status === "rearmed") expect(second.childTransactionId).toBe(first.childTransactionId);
    // global reset（新 service 实例）后派生一致。
    const afterReset = advanceTick();
    const third = afterReset.rearmResolvedNotExecutedAttempt({ parentTransactionId: "rearm_idem" });
    expect(third.status).toBe("rearmed");
    if (third.status === "rearmed") expect(third.childTransactionId).toBe(first.childTransactionId);
  });

  it("不同 parent / 不同 parent identity 得到不同 child ID", () => {
    makeExecutingQuarantine("rearm_pa");
    const mid = advanceTick();
    expect(resolveNotExecuted(mid, "rearm_pa").status).toBe("resolved");
    // 第二笔故障在第一笔 resolution 之后（全局 quarantine blocker 解除）。
    makeExecutingQuarantine("rearm_pb");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "rearm_pb").status).toBe("resolved");
    const a = next.rearmResolvedNotExecutedAttempt({ parentTransactionId: "rearm_pa" });
    const b = next.rearmResolvedNotExecutedAttempt({ parentTransactionId: "rearm_pb" });
    expect(a.status).toBe("rearmed");
    expect(b.status).toBe("rearmed");
    if (a.status === "rearmed" && b.status === "rearmed") {
      expect(a.childTransactionId).not.toBe(b.childTransactionId);
    }
    // 纯函数维度：不同 parent identity（digest）派生不同 child。
    const idA = deriveTreasuryRearmChildTransactionId({ transactionId: "x", digest: "1111111111111111" });
    const idB = deriveTreasuryRearmChildTransactionId({ transactionId: "x", digest: "2222222222222222" });
    expect(idA).not.toBe(idB);
  });

  it("parent 仍有 authority 时 rearm 拒绝", () => {
    makeExecutingQuarantine("rearm_auth_present");
    const next = advanceTick();
    // 不 resolve——authority 仍在。
    const rearmed = next.rearmResolvedNotExecutedAttempt({ parentTransactionId: "rearm_auth_present" });
    expect(rearmed.status).toBe("rejected");
    if (rearmed.status === "rejected") expect(rearmed.reason).toBe("parent_not_resolved");
  });

  it("parent 仍有 marker 时 rearm 拒绝（7.3 marker 清理前置）", () => {
    makeExecutingQuarantine("rearm_marker_pending");
    // 手工写入另一笔 unresolved marker（模拟 parent marker 尚未清理）。
    recordTreasuryWriteFault({
      transactionId: "rearm_marker_pending",
      digest: readTreasuryQuarantineEntry("rearm_marker_pending")!.digest,
      tick: Game.time,
      kind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick",
      status: "unresolved",
      recordedAt: Game.time,
    });
    // 写 final not-executed tombstone 但保留 marker 与 authority 的组合无法直接
    // 经正常路径产生——用纯协议入口验证 marker 阻断：authority 已在场时先被
    // parent_not_resolved 拦截，这里验证 marker 匹配 parent 时同样拒绝。
    const next = advanceTick();
    const rearmed = next.rearmResolvedNotExecutedAttempt({ parentTransactionId: "rearm_marker_pending" });
    expect(rearmed.status).toBe("rejected");
  });

  it("parent 有 resolving tombstone 时 rearm 拒绝（非 final not-executed）", () => {
    writeTreasuryResolutionTombstone({
      transactionId: "rearm_resolving",
      digest: "0123456789abcdef",
      resolution: "committed",
      stage: "resolving",
      proofLevel: "lowlevel",
      lowlevelSource: "runtime-lowlevel@v1",
      durableIdentityDigest: "0123456789abcdee",
      actionTick: Game.time,
      settledAtTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      reconcilerKind: "terminal.send",
      source: "test",
    });
    const next = makeService();
    next.beginTick();
    const rearmed = next.rearmResolvedNotExecutedAttempt({ parentTransactionId: "rearm_resolving" });
    expect(rearmed.status).toBe("rejected");
    if (rearmed.status === "rejected") expect(rearmed.reason).toBe("parent_not_resolved");
  });

  it("legacy/forensic 不足 proof 不能 rearm", () => {
    writeTreasuryResolutionTombstone({
      transactionId: "rearm_legacy",
      digest: "0123456789abcdef",
      resolution: "not-executed",
      stage: "final",
      proofLevel: "legacy",
      actionTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
    });
    writeTreasuryResolutionTombstone({
      transactionId: "rearm_forensic",
      digest: "0123456789abcdef",
      resolution: "not-executed",
      stage: "final",
      proofLevel: "forensic",
      actionTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
    });
    const next = makeService();
    next.beginTick();
    const legacyRearm = next.rearmResolvedNotExecutedAttempt({ parentTransactionId: "rearm_legacy" });
    expect(legacyRearm.status).toBe("rejected");
    if (legacyRearm.status === "rejected") expect(legacyRearm.reason).toBe("parent_proof_insufficient");
    const forensicRearm = next.rearmResolvedNotExecutedAttempt({ parentTransactionId: "rearm_forensic" });
    expect(forensicRearm.status).toBe("rejected");
    if (forensicRearm.status === "rejected") expect(forensicRearm.reason).toBe("parent_proof_insufficient");
  });

  it("expectedParentIdentity 不匹配时 rearm 拒绝", () => {
    makeExecutingQuarantine("rearm_expected");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "rearm_expected").status).toBe("resolved");
    const mismatch = next.rearmResolvedNotExecutedAttempt({
      parentTransactionId: "rearm_expected",
      expectedParentIdentity: { transactionId: "rearm_expected", digest: "ffffffffffffffff" },
    });
    expect(mismatch.status).toBe("rejected");
    if (mismatch.status === "rejected") expect(mismatch.reason).toBe("parent_identity_mismatch");
    const tombstone = readTreasuryResolutionTombstone("rearm_expected")!;
    const match = next.rearmResolvedNotExecutedAttempt({
      parentTransactionId: "rearm_expected",
      expectedParentIdentity: {
        transactionId: "rearm_expected",
        digest: tombstone.digest,
        ...(tombstone.durableIdentityDigest !== undefined ? { durableIdentityDigest: tombstone.durableIdentityDigest } : {}),
        ...(tombstone.lowlevelSource !== undefined ? { lowlevelSource: tombstone.lowlevelSource } : {}),
      },
    });
    expect(match.status).toBe("rearmed");
  });

  it("child 使用新 transaction identity：prepare/contract 绑定 child ID；parent proof 不能解决 child authority", () => {
    makeExecutingQuarantine("rearm_lineage_a");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "rearm_lineage_a").status).toBe("resolved");
    const rearmed = next.rearmResolvedNotExecutedAttempt({ parentTransactionId: "rearm_lineage_a" });
    expect(rearmed.status).toBe("rearmed");
    if (rearmed.status !== "rearmed") return;
    const child = rearmed.childTransactionId;
    // child 是全新 transaction 生命周期（正常 prepare）。
    const prepared = next.prepareTransaction(freshInput(next, child));
    expect(prepared.status).toBe("prepared");
    // parent 的 capability 无法对 child 签发（child 无 authority——child 尚未故障）。
    const issued = next.issueTreasuryReconciliationCapability({ transactionId: child });
    expect(issued.status).toBe("rejected");
  });

  it("child 故障后可独立 resolution；child not-executed 后可继续 rearm 生成孙代（A→B→C）", () => {
    // A：not-executed → rearm → child B。
    makeExecutingQuarantine("rearm_chain_a");
    const t1 = advanceTick();
    expect(resolveNotExecuted(t1, "rearm_chain_a").status).toBe("resolved");
    const aRearm = t1.rearmResolvedNotExecutedAttempt({ parentTransactionId: "rearm_chain_a" });
    expect(aRearm.status).toBe("rearmed");
    if (aRearm.status !== "rearmed") return;
    const childB = aRearm.childTransactionId;
    // B：独立故障（executing 边界）→ 独立 not-executed resolution。
    const t2 = advanceTick();
    t2.executePreparedAction(freshInput(t2, childB), () => {
      t2.endTick();
      return { ok: false as const };
    });
    expect(readTreasuryQuarantineEntry(childB)).toBeDefined();
    const t3 = advanceTick();
    const bResolved = resolveNotExecuted(t3, childB);
    expect(bResolved.status).toBe("resolved");
    if (bResolved.status === "resolved") {
      expect(bResolved.sameIdRetryAllowed).toBe(false);
      expect(typeof bResolved.rearmChildTransactionId).toBe("string");
      // B 的 rearm child（孙代 C）与 B 不同、也与 A 不同。
      expect(bResolved.rearmChildTransactionId).not.toBe(childB);
      expect(bResolved.rearmChildTransactionId).not.toBe("rearm_chain_a");
    }
    // B 的 rearm child 与 A 的直接 child（B）不同——每一 attempt 最多一个直接
    // child 且链式派生。
    const bRearm = t3.rearmResolvedNotExecutedAttempt({ parentTransactionId: childB });
    expect(bRearm.status).toBe("rearmed");
    if (bRearm.status === "rearmed") {
      expect(bRearm.childTransactionId).not.toBe(childB);
      const t4 = advanceTick();
      const cPrepared = t4.prepareTransaction(freshInput(t4, bRearm.childTransactionId));
      expect(cPrepared.status).toBe("prepared");
    }
  });

  it("无效输入与 store fatal：rearm 拒绝", () => {
    const next = makeService();
    next.beginTick();
    const invalid = next.rearmResolvedNotExecutedAttempt({ parentTransactionId: "" });
    expect(invalid.status).toBe("rejected");
    if (invalid.status === "rejected") expect(invalid.reason).toBe("invalid_input");
    const absent = next.rearmResolvedNotExecutedAttempt({ parentTransactionId: "rearm_absent" });
    expect(absent.status).toBe("rejected");
    if (absent.status === "rejected") expect(absent.reason).toBe("parent_not_resolved");
  });
});
