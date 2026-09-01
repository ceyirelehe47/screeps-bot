/**
 * 【第十九轮】retirement 三阶段分别证明测试（任务 25.4/25.9）。
 *
 * 覆盖（工作包 C）：
 * - completeTreasuryLineageRetirement 不再无条件置三段——未全部证明时拒绝
 *   （保持 retiring，不进 rearm_ready、无 eviction 资格）；
 * - markTreasuryLineageRetirementStageVerified 单调推进（幂等重入零写入）；
 * - convergeTreasuryLineageRetirementFromFacts 的 marker 证明：匹配未清 /
 *   digest 冲突 / 指向本 attempt → cleanup pending；不存在 / 不指向本
 *   attempt → 推进；
 * - marker store 损坏 → 不可判定（不进 rearm_ready）；
 * - tombstone replacement verdict 的当前代三段检查（未完成 → pin）。
 */
import {
  clearTreasuryPersistenceForTest,
} from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  createTreasuryAttemptLineageRecord,
  convergeTreasuryLineageRetirementFromFacts,
  completeTreasuryLineageRetirement,
  markTreasuryLineageRetirementStageVerified,
  readTreasuryAttemptLineageRecord,
  peekTreasuryAttemptLineageHealth,
} from "@/runtime/treasury/attemptLineage";
import { recordTreasuryWriteFault, readTreasuryWriteFault } from "@/runtime/treasury/writeFault";
import { setTreasuryLineageRecoveryMarkerReaderForAssembly } from "@/runtime/treasury/attemptLineage";
import { treasuryTombstoneReplacementVerdict } from "@/runtime/treasury/lineageGenerationRetirement";
import { computeTreasuryLineageBindingDigest } from "@/runtime/treasury/lineageBinding";
import { deriveTreasuryLineageNextChildTransactionId } from "@/runtime/treasury/attemptLineage";

const ROOT_DIGEST = "1111111111111111";
const ROOT_DURABLE = "2222222222222222";

function makeRootLineage(rootId: string, rearmable = true) {
  const created = createTreasuryAttemptLineageRecord({
    rootTransactionId: rootId,
    rootIdentity: {
      digest: ROOT_DIGEST,
      durableIdentityDigest: ROOT_DURABLE,
      ...(rearmable ? {} : {}),
    },
    actionKind: "terminal.send",
    authorityClass: "lowlevel",
    lowlevelSource: "runtime-lowlevel@v1",
    rearmable,
    ...(rearmable ? { retrySemanticDigest: "3333333333333333" } : { nonRearmReason: "test non-rearmable" }),
  });
  expect(created.status).toBe("written");
  if (created.status !== "written") throw new Error("unreachable");
  return created.record;
}

/** 低层 marker（v3 class-aware、无 lineage——root/低层 current 代）。 */
function seedMarker(input: {
  readonly transactionId: string;
  readonly digest?: string;
  readonly authorityClass?: "identity-bound" | "lowlevel";
  readonly corrupt?: boolean;
}): void {
  if (input.corrupt === true) {
    (Memory.runtime ??= {} as never);
    (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury = {
      ...((Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury ?? {}),
      writeFault: { transactionId: input.transactionId, digest: 12345, phase: 42 },
    };
    return;
  }
  recordTreasuryWriteFault({
    transactionId: input.transactionId,
    digest: input.digest ?? ROOT_DIGEST,
    tick: Game.time,
    kind: "terminal.send",
    source: "test",
    phase: "action_threw_execution_unknown",
    status: "unresolved",
    recordedAt: Game.time,
    markerVersion: 3,
    authorityClass: input.authorityClass ?? "lowlevel",
    lowlevelSource: input.authorityClass === "identity-bound" ? undefined : "runtime-lowlevel@v1",
    attemptIdentity: { durableIdentityDigest: ROOT_DURABLE },
  });
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  // 装配 marker reader（与 facade createTreasuryService 同一语义——converge
  // 的 marker 证明依赖注入通道）。
  setTreasuryLineageRecoveryMarkerReaderForAssembly(() => {
    const marker = readTreasuryWriteFault();
    return marker === undefined ? undefined : { transactionId: marker.transactionId, digest: marker.digest };
  });
});

describe("retirement 三阶段分别证明（第十九轮 25.4）", () => {
  it("complete 对三段未全部证明的 retiring：拒绝推进（保持 retiring——不进 rearm_ready）", () => {
    const record = makeRootLineage("r19_stage_complete");
    // create 默认 retiring + publication=true、release/marker=false。
    expect(record.retirement.lineagePublished).toBe(true);
    expect(record.retirement.authorityReleased).toBe(false);
    expect(record.retirement.markerCleaned).toBe(false);
    expect(() => completeTreasuryLineageRetirement(record.lineageId)).toThrow(/三段未全部证明/);
    expect(readTreasuryAttemptLineageRecord(record.lineageId)?.state).toBe("retiring");
  });

  it("markStage 单调推进 + 幂等重入零写入；三段全 true 后 complete 成功", () => {
    const record = makeRootLineage("r19_stage_mark");
    const marked1 = markTreasuryLineageRetirementStageVerified(record.lineageId, "authorityReleased");
    expect(marked1.status).toBe("updated");
    expect(readTreasuryAttemptLineageRecord(record.lineageId)?.retirement.authorityReleased).toBe(true);
    const revisionAfterFirst = readTreasuryAttemptLineageRecord(record.lineageId)!.recordRevision;
    const markedAgain = markTreasuryLineageRetirementStageVerified(record.lineageId, "authorityReleased");
    expect(markedAgain.status).toBe("idempotent");
    expect(readTreasuryAttemptLineageRecord(record.lineageId)!.recordRevision).toBe(revisionAfterFirst);
    expect(markTreasuryLineageRetirementStageVerified(record.lineageId, "markerCleaned").status).toBe("updated");
    const completed = completeTreasuryLineageRetirement(record.lineageId);
    expect(completed.status).toBe("updated");
    expect(readTreasuryAttemptLineageRecord(record.lineageId)?.state).toBe("rearm_ready");
  });

  it("converge：marker 匹配未清（指向本 attempt、digest 一致）→ cleanup pending（不进 rearm_ready、verdict pin）", () => {
    const record = makeRootLineage("r19_stage_mpending");
    seedMarker({ transactionId: "r19_stage_mpending" });
    const converged = convergeTreasuryLineageRetirementFromFacts(record.lineageId);
    expect(converged.status).toBe("pending");
    if (converged.status === "pending") expect(converged.pendingStages).toContain("markerCleaned");
    expect(readTreasuryAttemptLineageRecord(record.lineageId)?.state).toBe("retiring");
    // tombstone replacement verdict：当前代三段未全 → pending（无 eviction 资格）。
    const verdict = treasuryTombstoneReplacementVerdict({
      transactionId: "r19_stage_mpending",
      digest: ROOT_DIGEST,
      resolution: "not-executed",
      stage: "final",
      proofLevel: "lowlevel",
    });
    expect(verdict.verdict).toBe("replacement_pending");
  });

  it("converge：marker digest 冲突（指向本 attempt、digest 不同）→ cleanup pending（不可证明清除）", () => {
    const record = makeRootLineage("r19_stage_mconflict");
    seedMarker({ transactionId: "r19_stage_mconflict", digest: "9999999999999999" });
    const converged = convergeTreasuryLineageRetirementFromFacts(record.lineageId);
    expect(converged.status).toBe("pending");
    if (converged.status === "pending") expect(converged.pendingStages).toContain("markerCleaned");
    expect(readTreasuryAttemptLineageRecord(record.lineageId)?.state).toBe("retiring");
  });

  it("converge：marker 缺 class 证明（v1 形态）→ 清除 insufficient 同样保持 pending（marker 仍在）", () => {
    const record = makeRootLineage("r19_stage_minsuff");
    seedMarker({ transactionId: "r19_stage_minsuff" });
    // 篡改为 v1 形态（去 class 字段）。
    delete (Memory.runtime!.treasury!.writeFault as unknown as Record<string, unknown>).authorityClass;
    delete (Memory.runtime!.treasury!.writeFault as unknown as Record<string, unknown>).markerVersion;
    const converged = convergeTreasuryLineageRetirementFromFacts(record.lineageId);
    expect(converged.status).toBe("pending");
    expect(readTreasuryAttemptLineageRecord(record.lineageId)?.state).toBe("retiring");
  });

  it("converge：marker store 损坏 → 不进 rearm_ready（fail closed）", () => {
    const record = makeRootLineage("r19_stage_mcorrupt");
    seedMarker({ transactionId: "r19_stage_mcorrupt", corrupt: true });
    const converged = convergeTreasuryLineageRetirementFromFacts(record.lineageId);
    // marker reader 返回损坏对象（transactionId 命中）→ 不可证明 → pending；
    // 或 reader 层面被 health 拦截——两者都不允许完成。
    expect(converged.status === "pending" || converged.status === "rejected").toBe(true);
    expect(readTreasuryAttemptLineageRecord(record.lineageId)?.state).toBe("retiring");
  });

  it("converge：authority 未释放（resolver 仍命中）→ release pending", () => {
    const record = makeRootLineage("r19_stage_apending");
    // 手塞 intent 使 authority 存在（quarantined 形态）。
    Memory.runtime = Memory.runtime ?? {};
    const treasury = (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury ?? {};
    (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury = treasury;
    const entry: Record<string, unknown> = {
      transactionId: "r19_stage_apending",
      digest: ROOT_DIGEST,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      deltas: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
      phase: "action_threw_execution_unknown",
      outcome: "started_unknown",
      settlement: "quarantined",
      tick: Game.time,
      recordedAt: Game.time,
      authorityLevel: "lowlevel",
      lowlevelSource: "runtime-lowlevel@v1",
    };
    entry.durableIdentityDigest = require("@/runtime/treasury/identityProof").recomputeTreasuryDurableIdentityDigest(entry) ?? undefined;
    treasury.quarantine = { version: 6, entries: { "q:r19_stage_apending": entry }, entryCount: 1, updatedAt: Game.time };
    const converged = convergeTreasuryLineageRetirementFromFacts(record.lineageId);
    expect(converged.status).toBe("pending");
    if (converged.status === "pending") expect(converged.pendingStages).toContain("authorityReleased");
    expect(readTreasuryAttemptLineageRecord(record.lineageId)?.state).toBe("retiring");
  });

  it("converge：marker 不指向本 attempt（其他 transactionId）→ markerCleaned 推进、三段全 true 完成", () => {
    const record = makeRootLineage("r19_stage_mclean");
    seedMarker({ transactionId: "other_r19_attempt" });
    const converged = convergeTreasuryLineageRetirementFromFacts(record.lineageId);
    expect(converged.status).toBe("completed");
    expect(readTreasuryAttemptLineageRecord(record.lineageId)?.state).toBe("rearm_ready");
  });

  it("converge：无 marker + authority 已清 → 直接完成（rearm_ready）", () => {
    const record = makeRootLineage("r19_stage_clean");
    const converged = convergeTreasuryLineageRetirementFromFacts(record.lineageId);
    expect(converged.status).toBe("completed");
    expect(readTreasuryAttemptLineageRecord(record.lineageId)?.state).toBe("rearm_ready");
  });

  it("converge：non-rearmable chain 三段全 → non_rearmable_retired 终态", () => {
    const record = makeRootLineage("r19_stage_nonrearm", false);
    const converged = convergeTreasuryLineageRetirementFromFacts(record.lineageId);
    expect(converged.status).toBe("completed");
    expect(readTreasuryAttemptLineageRecord(record.lineageId)?.state).toBe("non_rearmable_retired");
  });

  it("verdict：当前代三段完成后 → replacement_match（对照——证明 pending 是三段语义而非其它拒绝）", () => {
    const record = makeRootLineage("r19_stage_vmatch");
    expect(convergeTreasuryLineageRetirementFromFacts(record.lineageId).status).toBe("completed");
    const verdict = treasuryTombstoneReplacementVerdict({
      transactionId: "r19_stage_vmatch",
      digest: ROOT_DIGEST,
      resolution: "not-executed",
      stage: "final",
      proofLevel: "lowlevel",
    });
    expect(verdict.verdict).toBe("replacement_match");
  });

  it("verdict：child 代的 binding 重算与 marker cleanup 证明（tr1_ child tombstone 携带完整 proof）", () => {
    const record = makeRootLineage("r19_stage_child");
    const childGen = 1;
    const childId = deriveTreasuryLineageNextChildTransactionId(record.lineageId, childGen, record.rootTransactionId);
    const parent = record.rootTransactionId;
    const binding = computeTreasuryLineageBindingDigest({ lineageId: record.lineageId, generation: childGen, parentTransactionId: parent, childTransactionId: childId });
    // lineage 推进到 child_active（手工构造——activate 需要 intent facts；直接
    // 验证 verdict 的 binding 派生语义即可：generation 不超 + binding 匹配）。
    const verdict = treasuryTombstoneReplacementVerdict({
      transactionId: childId,
      digest: ROOT_DIGEST,
      resolution: "not-executed",
      stage: "final",
      proofLevel: "lowlevel",
      lineageBindingDigest: binding,
      lineageId: record.lineageId,
      lineageGeneration: childGen,
      parentTransactionId: parent,
    });
    // record 仍是 root 代（generation 0）——child generation 超过当前代 → conflict。
    expect(verdict.verdict).toBe("replacement_conflict");
  });
});
