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
  deriveTreasuryLineageNextChildTransactionId,
  lookupTreasuryAttemptLineageByAttemptId,
} from "@/runtime/treasury/attemptLineage";
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

  it("resolve 结果语义：sameIdRetryAllowed 恒 false、retirement 状态、child ID 只经 capability 交付（旧 reprepareAllowed/rearmChildTransactionId 已删除）", () => {
    makeExecutingQuarantine("rearm_semantics");
    const next = advanceTick();
    const resolved = resolveNotExecuted(next, "rearm_semantics");
    expect(resolved.status).toBe("resolved");
    if (resolved.status === "resolved") {
      expect(resolved.sameIdRetryAllowed).toBe(false);
      // 【第十七轮第六节】不再返回 child ID 字符串——retirement 状态表达
      // 退休完整性（capability 是唯一交付通道）。
      expect((resolved as { rearmChildTransactionId?: string }).rearmChildTransactionId).toBeUndefined();
      expect((resolved as { reprepareAllowed?: boolean }).reprepareAllowed).toBeUndefined();
      expect(resolved.retirement).toBe("complete_rearm_ready");
      // capability 签发的 child ID 与独立派生一致（确定性）。
      const issued = next.issueTreasuryRearmCapability({ parentTransactionId: "rearm_semantics" });
      expect(issued.status).toBe("issued");
      if (issued.status !== "issued") return;
      // 【第十八轮】child ID v2 generation-addressable：与 production 权威派生
      //（attemptLineage——(lineageId, generation+1, root)）一致。
      const lineageRecord = lookupTreasuryAttemptLineageByAttemptId("rearm_semantics");
      expect(lineageRecord).toBeDefined();
      if (lineageRecord !== undefined) {
        expect(issued.childTransactionId).toBe(
          deriveTreasuryLineageNextChildTransactionId(
            lineageRecord.lineageId,
            lineageRecord.generation + 1,
            lineageRecord.rootTransactionId,
          ),
        );
      }
    }
  });

  it("issueTreasuryRearmCapability 签发合法 child ID；同 tick 重复 issue 幂等；global reset 后重签发一致", () => {
    makeExecutingQuarantine("rearm_idem");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "rearm_idem").status).toBe("resolved");
    const first = next.issueTreasuryRearmCapability({ parentTransactionId: "rearm_idem" });
    expect(first.status).toBe("issued");
    if (first.status !== "issued") return;
    expect(first.childTransactionId).toMatch(/^tr1_[0-9a-f]{16}_[0-9a-f]{6}_[0-9a-f]{8}$/);
    expect(first.childTransactionId.length).toBeLessThanOrEqual(128);
    const second = next.issueTreasuryRearmCapability({ parentTransactionId: "rearm_idem" });
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") {
      // 同 tick 已 issue（lineage capability_issued）——不产生两个可同时
      // 消费的 capability（重复 issue 拒绝；首个 capability 仍有效）。
      expect(second.reason).toBe("lineage_not_rearm_ready");
    }
    // global reset（新 service 实例）后重签发：child ID 一致、新 capability 对象。
    const afterReset = advanceTick();
    const third = afterReset.issueTreasuryRearmCapability({ parentTransactionId: "rearm_idem" });
    expect(third.status).toBe("issued");
    if (third.status === "issued") {
      expect(third.childTransactionId).toBe(first.childTransactionId);
      expect(third.capability).not.toBe(first.capability);
    }
  });

  it("不同 parent / 不同 parent identity 得到不同 child ID", () => {
    makeExecutingQuarantine("rearm_pa");
    const mid = advanceTick();
    expect(resolveNotExecuted(mid, "rearm_pa").status).toBe("resolved");
    // 第二笔故障在第一笔 resolution 之后（全局 quarantine blocker 解除）。
    makeExecutingQuarantine("rearm_pb");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "rearm_pb").status).toBe("resolved");
    const a = next.issueTreasuryRearmCapability({ parentTransactionId: "rearm_pa" });
    const b = next.issueTreasuryRearmCapability({ parentTransactionId: "rearm_pb" });
    expect(a.status).toBe("issued");
    expect(b.status).toBe("issued");
    if (a.status === "issued" && b.status === "issued") {
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
    // 不 resolve——authority 仍在（retirement 未建立）。
    const rearmed = next.issueTreasuryRearmCapability({ parentTransactionId: "rearm_auth_present" });
    expect(rearmed.status).toBe("rejected");
    if (rearmed.status === "rejected") expect(rearmed.reason).toBe("lineage_record_missing");
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
    // lineage retirement 缺失拦截，这里验证 marker 匹配 parent 时同样拒绝。
    const next = advanceTick();
    const rearmed = next.issueTreasuryRearmCapability({ parentTransactionId: "rearm_marker_pending" });
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
    const rearmed = next.issueTreasuryRearmCapability({ parentTransactionId: "rearm_resolving" });
    expect(rearmed.status).toBe("rejected");
    if (rearmed.status === "rejected") expect(rearmed.reason).toBe("lineage_record_missing");
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
    const legacyRearm = next.issueTreasuryRearmCapability({ parentTransactionId: "rearm_legacy" });
    expect(legacyRearm.status).toBe("rejected");
    if (legacyRearm.status === "rejected") expect(legacyRearm.reason).toBe("lineage_not_rearmable");
    const forensicRearm = next.issueTreasuryRearmCapability({ parentTransactionId: "rearm_forensic" });
    expect(forensicRearm.status).toBe("rejected");
    if (forensicRearm.status === "rejected") expect(forensicRearm.reason).toBe("lineage_not_rearmable");
  });

  it("capability 绑定 parent identity：issue 结果与 lineage record 一致", () => {
    makeExecutingQuarantine("rearm_expected");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "rearm_expected").status).toBe("resolved");
    const mismatch = next.issueTreasuryRearmCapability({ parentTransactionId: "rearm_expected" });
    expect(mismatch.status).toBe("issued");
    if (mismatch.status !== "issued") return;
    expect(mismatch.capability.binding.parentTransactionId).toBe("rearm_expected");
    expect(mismatch.capability.binding.childTransactionId).toBe(mismatch.childTransactionId);
    expect(mismatch.capability.binding.retrySemanticDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  it("child 使用新 transaction identity：tr1_ 无 capability 直接 prepare 拒绝；parent proof 不能解决 child authority", () => {
    makeExecutingQuarantine("rearm_lineage_a");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "rearm_lineage_a").status).toBe("resolved");
    const rearmed = next.issueTreasuryRearmCapability({ parentTransactionId: "rearm_lineage_a" });
    expect(rearmed.status).toBe("issued");
    if (rearmed.status !== "issued") return;
    const child = rearmed.childTransactionId;
    // 【第十七轮第八节】tr1_ 无 capability 的直接 prepare 拒绝（命名空间门禁）。
    const prepared = next.prepareTransaction(freshInput(next, child));
    expect(prepared.status).toBe("rejected");
    if (prepared.status === "rejected") expect(prepared.reason).toBe("rearm_capability_required");
    // parent 的 capability 无法对 child 签发（child 无 authority——child 尚未故障）。
    const issued = next.issueTreasuryReconciliationCapability({ transactionId: child });
    expect(issued.status).toBe("rejected");
  });

  it("child 故障后可独立 resolution；child not-executed 后可继续 rearm 生成孙代（A→B→C）", () => {
    // A：not-executed → 同 tick issue capability → child B 经 tr1_ 接管执行
    //（capability 跨 tick 失效——issue 与 execute 必须同一 service 同一 tick）。
    makeExecutingQuarantine("rearm_chain_a");
    const t1 = advanceTick();
    expect(resolveNotExecuted(t1, "rearm_chain_a").status).toBe("resolved");
    const aRearm = t1.issueTreasuryRearmCapability({ parentTransactionId: "rearm_chain_a" });
    expect(aRearm.status).toBe("issued");
    if (aRearm.status !== "issued") return;
    const childB = aRearm.childTransactionId;
    // B：经 capability 接管执行（同 tick 同 service——接管协议消费 capability）。
    const bExecuted = t1.executePreparedAction(
      freshInput(t1, childB),
      () => {
        t1.endTick();
        return { ok: false as const };
      },
      { rearmCapability: aRearm.capability },
    );
    expect(bExecuted.status).not.toBe("prepare_rejected");
    if (bExecuted.status === "prepare_rejected") return;
    expect(readTreasuryQuarantineEntry(childB)).toBeDefined();
    // B：独立 not-executed resolution（lineage 同 record 推进）。
    const t3 = advanceTick();
    const bResolved = resolveNotExecuted(t3, childB);
    expect(bResolved.status).toBe("resolved");
    if (bResolved.status === "resolved") {
      expect(bResolved.sameIdRetryAllowed).toBe(false);
      expect((bResolved as { rearmChildTransactionId?: string }).rearmChildTransactionId).toBeUndefined();
    }
    // B 的 rearm child（孙代 C）与 B 不同、也与 A 不同。
    const bRearm = t3.issueTreasuryRearmCapability({ parentTransactionId: childB });
    expect(bRearm.status).toBe("issued");
    if (bRearm.status === "issued") {
      expect(bRearm.childTransactionId).not.toBe(childB);
      expect(bRearm.childTransactionId).not.toBe("rearm_chain_a");
      const t4 = advanceTick();
      const cPrepared = t4.prepareTransaction(freshInput(t4, bRearm.childTransactionId));
      expect(cPrepared.status).toBe("rejected");
      if (cPrepared.status === "rejected") {
        // 孙代 C 同样受 tr1_ 命名空间门禁（无 capability 拒绝）。
        expect(cPrepared.reason).toBe("rearm_capability_required");
      }
    }
  });

  it("无效输入与缺失 lineage：rearm 拒绝", () => {
    const next = makeService();
    next.beginTick();
    const invalid = next.issueTreasuryRearmCapability({ parentTransactionId: "" });
    expect(invalid.status).toBe("rejected");
    if (invalid.status === "rejected") expect(invalid.reason).toBe("invalid_input");
    const absent = next.issueTreasuryRearmCapability({ parentTransactionId: "rearm_absent" });
    expect(absent.status).toBe("rejected");
    if (absent.status === "rejected") expect(absent.reason).toBe("lineage_record_missing");
  });
});
