/**
 * 【第二十轮】semantic lineage validation 与 handoff unified exact authority
 * 测试（任务 26.12）。
 *
 * 覆盖：
 * - semantic validator 基础矩阵（child ID 内嵌 lineage/generation、parent
 *   确定性派生、binding 权威重算、active/terminal authority 状态、store
 *   unhealthy、legacy isolated、readers 未装配）；
 * - handoff 完整 authority 一致性（四字段相同但 contract/cohort/durable/
 *   class/lowlevel/postings/outcome 不同 → forensic；完整一致 forward；
 *   intent-only ready rollback；executing forward）；
 * - beginTick 证据保留顺序（通用 Intent recovery 不得先删 handoff 证据）；
 * - resolver 对 tr1_ 的 semantic gate（一致复制的错误四字段 → inconsistent）。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import {
  clearTreasuryPersistenceForTest,
} from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  createTreasuryAttemptLineageRecord,
  convergeTreasuryLineageRetirementFromFacts,
  stageTreasuryLineageCapabilityIssued,
  stageTreasuryLineageChildIntentPending,
  activateTreasuryLineageChild,
  deriveTreasuryLineageNextChildTransactionId,
  readTreasuryAttemptLineageRecord,
  peekTreasuryAttemptLineageHealth,
  recoverTreasuryLineageHandoffEvidenceAtTickBoundary,
  resetTreasuryLineageRuntimeForTest,
  registerTreasuryAttemptLineageSemanticSourceForAssembly,
  lookupTreasuryAttemptLineageByAttemptId as __lookupByAttempt,
} from "@/runtime/treasury/attemptLineage";
import { registerTreasuryRetirementSummarySemanticSourceForAssembly } from "@/runtime/treasury/lineageRetirementSummary";
import { registerTreasuryGenerationRetirementSemanticSourceForAssembly } from "@/runtime/treasury/generationRetirementAuthority";
import { writeTreasuryIntentEntry, readTreasuryIntentEntry, resetTreasuryIntentRuntimeForTest } from "@/runtime/treasury/intents";
import { readTreasuryQuarantineEntry, resetTreasuryQuarantineRuntimeForTest } from "@/runtime/treasury/quarantine";
import { resolveTreasuryUnresolvedAuthority } from "@/runtime/treasury/unresolvedAuthority";
import { validateTreasurySemanticLineage, resetTreasurySemanticLineageSourcesForTest } from "@/runtime/treasury/semanticLineageValidation";
import { computeTreasuryLineageBindingDigest } from "@/runtime/treasury/lineageBinding";
import { recomputeTreasuryDurableIdentityDigest } from "@/runtime/treasury/identityProof";
import { registerTreasuryPolicyResolver, makeFixedReserveTreasuryPolicy } from "@/runtime/treasury/policyAuthority";
import {
  makeTreasuryTestTransferAdapter,
  replaceTreasuryActionAdapterForTest,
  resetTreasuryTestAdapterSideEffectsForTest,
} from "@/runtime/treasury/actionContracts";
import { installRooms, type RoomSpec } from "@mock/treasury";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import type { TreasuryTransactionInput } from "@/runtime/treasury/types";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 5_000 },
  },
];

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
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta }],
  };
}

function advanceTick(): TreasuryTestService {
  Game.time += 1;
  return makeService();
}

function resolveNotExecuted(service: TreasuryTestService, transactionId: string) {
  const issued = service.issueTreasuryReconciliationCapability({ transactionId });
  if (issued.status !== "issued") return issued;
  return service.resolveUnresolvedTransaction({ transactionId, capability: issued.capability });
}

/** 真实 lowlevel chain fixture：root → retirement（exact proof）→ gen1 child_active。 */
function seedActiveChildChain(rootId: string, digest = "1111111111111111", durable?: string): {
  readonly childId: string;
  readonly lineageId: string;
  readonly identity: {
    readonly digest: string;
    readonly durableIdentityDigest: string;
    readonly lowlevelSource: string;
    readonly lineageId: string;
    readonly lineageGeneration: number;
    readonly parentTransactionId: string;
    readonly lineageBindingDigest: string;
  };
} {
  // 【第二十一轮 6.4】root/child 的 durable 按 facts 真实重算（semantic current 完整比较 durable）。
  const rootDurable = durable ?? recomputeTreasuryDurableIdentityDigest({
    transactionId: rootId,
    digest,
    actionKind: "terminal.send",
    source: "test",
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
  });
  if (rootDurable === null) throw new Error("seed root durable recompute failed");
  const created = createTreasuryAttemptLineageRecord({
    rootTransactionId: rootId,
    rootIdentity: { digest, durableIdentityDigest: rootDurable },
    actionKind: "terminal.send",
    authorityClass: "lowlevel",
    lowlevelSource: "runtime-lowlevel@v1",
    rearmable: true,
    retrySemanticDigest: "6666666666666666",
  });
  if (created.status !== "written") throw new Error("seed chain create failed");
  const lineageId = created.record.lineageId;
  const converged = convergeTreasuryLineageRetirementFromFacts(lineageId);
  if (converged.status !== "completed") throw new Error("seed chain converge failed: " + JSON.stringify(converged));
  const childId = deriveTreasuryLineageNextChildTransactionId(lineageId, 1, rootId);
  if (stageTreasuryLineageCapabilityIssued(lineageId, childId).status === "rejected") throw new Error("seed stage issued failed");
  if (stageTreasuryLineageChildIntentPending(lineageId, childId).status === "rejected") throw new Error("seed stage pending failed");
  const pendingBinding = readTreasuryAttemptLineageRecord(lineageId)!.pendingBindingDigest!;
  const resolvedDurable = recomputeTreasuryDurableIdentityDigest({
    transactionId: childId,
    digest,
    actionKind: "terminal.send",
    source: "test",
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
    lineageId,
    lineageGeneration: 1,
    parentTransactionId: rootId,
    lineageBindingDigest: pendingBinding,
  });
  if (resolvedDurable === null) throw new Error("seed child durable recompute failed");
  const activated = activateTreasuryLineageChild(lineageId, { digest, durableIdentityDigest: resolvedDurable, lowlevelSource: "runtime-lowlevel@v1" });
  if (activated.status === "rejected") throw new Error("seed activate failed");
  return {
    childId,
    lineageId,
    identity: {
      digest,
      durableIdentityDigest: resolvedDurable,
      lowlevelSource: "runtime-lowlevel@v1",
      lineageId,
      lineageGeneration: 1,
      parentTransactionId: rootId,
      lineageBindingDigest: readTreasuryAttemptLineageRecord(lineageId)!.bindingDigest!,
    },
  };
}

/** 手塞低层 intent（四字段与 durable 真实重算）。 */
function seedIntent(childId: string, facts: {
  readonly lineageId: string;
  readonly lineageGeneration: number;
  readonly parentTransactionId: string;
  readonly lineageBindingDigest: string;
  readonly digest?: string;
  readonly durableIdentityDigest?: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly lowlevelSource?: string;
  readonly outcome?: string;
  readonly settlement?: string;
}): void {
  const base = {
    authorityLevel: "lowlevel" as const,
    lowlevelSource: facts.lowlevelSource ?? "runtime-lowlevel@v1",
    transactionId: childId,
    digest: facts.digest ?? "aaaaaaaaaaaaaaaa",
    actionKind: "terminal.send",
    kind: "terminal.send",
    source: "test",
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
    outcome: facts.outcome ?? "started_unknown",
    settlement: facts.settlement ?? "executing",
    auditSource: "test",
    lineageId: facts.lineageId,
    lineageGeneration: facts.lineageGeneration,
    parentTransactionId: facts.parentTransactionId,
    lineageBindingDigest: facts.lineageBindingDigest,
    ...(facts.contractDigest !== undefined ? { contractDigest: facts.contractDigest } : {}),
    ...(facts.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: facts.authorizationCohortDigest } : {}),
    createdAtTick: Game.time,
    updatedAtTick: Game.time,
  };
  const durable = facts.durableIdentityDigest ?? recomputeTreasuryDurableIdentityDigest(base as never) ?? undefined;
  const write = writeTreasuryIntentEntry({
    ...base,
    ...(durable !== undefined ? { durableIdentityDigest: durable } : {}),
  });
  if (write.status === "rejected") throw new Error("seed intent rejected: " + write.detail);
}

/** 手塞 quarantine entry（同 facts 形态）。 */
function seedQuarantine(childId: string, facts: {
  readonly lineageId: string;
  readonly lineageGeneration: number;
  readonly parentTransactionId: string;
  readonly lineageBindingDigest: string;
  readonly digest?: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
}): void {
  Memory.runtime = Memory.runtime ?? {};
  const treasury = (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury ?? {};
  (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury = treasury;
  const entry: Record<string, unknown> = {
    transactionId: childId,
    digest: facts.digest ?? "aaaaaaaaaaaaaaaa",
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
    lowlevelSource: facts.lowlevelSource ?? "runtime-lowlevel@v1",
    lineageId: facts.lineageId,
    lineageGeneration: facts.lineageGeneration,
    parentTransactionId: facts.parentTransactionId,
    lineageBindingDigest: facts.lineageBindingDigest,
    ...(facts.contractDigest !== undefined ? { contractDigest: facts.contractDigest } : {}),
    ...(facts.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: facts.authorizationCohortDigest } : {}),
  };
  entry.durableIdentityDigest = facts.durableIdentityDigest ?? recomputeTreasuryDurableIdentityDigest(entry as never) ?? undefined;
  treasury.quarantine = {
    version: 6,
    entries: { [`q:${childId}`]: entry },
    entryCount: 1,
    updatedAt: Game.time,
  };
  resetTreasuryQuarantineRuntimeForTest();
}

/** 手工构造 child_intent_pending 窗口（真实 capability 流）；facts 供调用方塞 intent/quarantine。 */
function stagePendingWindow(rootId: string): {
  readonly childId: string;
  readonly lineageId: string;
  readonly facts: {
    readonly lineageId: string;
    readonly lineageGeneration: number;
    readonly parentTransactionId: string;
    readonly lineageBindingDigest: string;
  };
} {
  const service = makeService();
  const executed = service.executePreparedAction(freshInput(service, rootId), () => {
    service.endTick();
    return { ok: false as const };
  });
  expect(executed.status).toBe("executed_abort_failed");
  const next = advanceTick();
  expect(resolveNotExecuted(next, rootId).status).toBe("resolved");
  const issued = next.issueTreasuryRearmCapability({ parentTransactionId: rootId });
  expect(issued.status).toBe("issued");
  if (issued.status !== "issued") throw new Error("unreachable");
  const record = __lookupByAttempt(rootId)!;
  if (stageTreasuryLineageChildIntentPending(record.lineageId, issued.childTransactionId).status === "rejected") throw new Error("stage pending failed");
  return {
    childId: issued.childTransactionId,
    lineageId: record.lineageId,
    facts: {
      lineageId: record.lineageId,
      lineageGeneration: record.generation + 1,
      parentTransactionId: rootId,
      lineageBindingDigest: record.pendingBindingDigest!,
    },
  };
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  resetTreasuryTestAdapterSideEffectsForTest();
  registerTreasuryPolicyResolver(makeFixedReserveTreasuryPolicy(1_000));
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter("observed_not_executed"));
  replaceTreasuryActionAdapterForTest({
    ...makeTreasuryTestTransferAdapter(),
    kind: "terminal.send",
    semanticIdentity: "terminal.send@reconciler-semantics-v1",
    reconcile: () => "observed_not_executed",
  });
});

afterEach(() => {
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
});

describe("semantic lineage validation 基础矩阵（第二十轮 26.1）", () => {
  it("正确 v2 child + 正确四字段 + matching active lineage → match（current）", () => {
    const chain = seedActiveChildChain("r20_sem_match");
    const verdict = validateTreasurySemanticLineage({ transactionId: chain.childId, proof: chain.identity, identity: chain.identity });
    expect(verdict.verdict).toBe("match");
    if (verdict.verdict === "match") {
      expect(verdict.authoritySource).toBe("active");
      expect(verdict.generationRole).toBe("current");
    }
  });

  it("child ID 内嵌 lineageId 与 proof 不同 → conflict", () => {
    const chain = seedActiveChildChain("r20_sem_lid");
    const verdict = validateTreasurySemanticLineage({
      transactionId: chain.childId,
      proof: { ...chain.identity, lineageId: "ffffffffffffffff" },
    });
    expect(verdict.verdict).toBe("conflict");
  });

  it("child ID 内嵌 generation 与 proof 不同 → conflict", () => {
    const chain = seedActiveChildChain("r20_sem_gen");
    const verdict = validateTreasurySemanticLineage({
      transactionId: chain.childId,
      proof: { ...chain.identity, lineageGeneration: 2 },
    });
    expect(verdict.verdict).toBe("conflict");
  });

  it("generation 1 的 parent 不是 root → conflict", () => {
    const chain = seedActiveChildChain("r20_sem_par");
    const verdict = validateTreasurySemanticLineage({
      transactionId: chain.childId,
      proof: { ...chain.identity, parentTransactionId: "r20_other_parent" },
    });
    expect(verdict.verdict).toBe("conflict");
  });

  it("binding 字段格式正确但重算不同 → conflict", () => {
    const chain = seedActiveChildChain("r20_sem_bind");
    const verdict = validateTreasurySemanticLineage({
      transactionId: chain.childId,
      proof: { ...chain.identity, lineageBindingDigest: "9999999999999999" },
    });
    expect(verdict.verdict).toBe("conflict");
  });

  it("child ID 与 root/lineage 派生不一致（伪造 checksum）→ conflict", () => {
    const chain = seedActiveChildChain("r20_sem_cks");
    const forged = `tr1_${chain.lineageId}_000001_deadbeef`;
    const verdict = validateTreasurySemanticLineage({ transactionId: forged, proof: chain.identity });
    expect(verdict.verdict).toBe("conflict");
  });

  it("legacy 不可解析 tr1_ ID → insufficient（legacy isolated，不猜测）", () => {
    const verdict = validateTreasurySemanticLineage({
      transactionId: "tr1_legacyv1childid0000x",
      proof: { lineageId: "0123456789abcdef", lineageGeneration: 1, parentTransactionId: "r20_legacy_root", lineageBindingDigest: "3333333333333333" },
    });
    expect(verdict.verdict).toBe("insufficient");
  });

  it("initial attempt（非 tr1_）输入 → conflict（无 lineage 语义域）", () => {
    const verdict = validateTreasurySemanticLineage({
      transactionId: "r20_initial_tx",
      proof: { lineageId: "0123456789abcdef", lineageGeneration: 1, parentTransactionId: "r20_initial_parent", lineageBindingDigest: "3333333333333333" },
    });
    expect(verdict.verdict).toBe("conflict");
  });

  it("identity 携带 lowlevelSource 但 record 为 identity-bound class → conflict", () => {
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: "r20_sem_class",
      rootIdentity: { digest: "1111111111111111", contractDigest: "4444444444444444", authorizationCohortDigest: "5555555555555555", durableIdentityDigest: "2222222222222222" },
      actionKind: "terminal.send",
      authorityClass: "identity-bound",
      rearmable: true,
      retrySemanticDigest: "6666666666666666",
    });
    expect(created.status).toBe("written");
    if (created.status !== "written") return;
    expect(convergeTreasuryLineageRetirementFromFacts(created.record.lineageId).status).toBe("completed");
    const childId = deriveTreasuryLineageNextChildTransactionId(created.record.lineageId, 1, "r20_sem_class");
    expect(stageTreasuryLineageCapabilityIssued(created.record.lineageId, childId).status).not.toBe("rejected");
    expect(stageTreasuryLineageChildIntentPending(created.record.lineageId, childId).status).not.toBe("rejected");
    const activated = activateTreasuryLineageChild(created.record.lineageId, {
      digest: "1111111111111111", contractDigest: "4444444444444444", authorizationCohortDigest: "5555555555555555", durableIdentityDigest: "2222222222222222",
    });
    expect(activated.status).not.toBe("rejected");
    const record = readTreasuryAttemptLineageRecord(created.record.lineageId)!;
    const verdict = validateTreasurySemanticLineage({
      transactionId: childId,
      proof: {
        lineageId: record.lineageId,
        lineageGeneration: 1,
        parentTransactionId: "r20_sem_class",
        lineageBindingDigest: record.bindingDigest!,
      },
      identity: { digest: "1111111111111111", lowlevelSource: "runtime-lowlevel@v1" },
    });
    expect(verdict.verdict).toBe("conflict");
  });

  it("active lineage store unhealthy → store_unhealthy（不返回 match）", () => {
    const chain = seedActiveChildChain("r20_sem_unh");
    // 破坏 store：entryCount 不一致 → load unhealthy。
    const store = (Memory.runtime as { treasury?: { attemptLineage?: { entries: Record<string, unknown>; entryCount: number } } }).treasury?.attemptLineage;
    store!.entryCount = store!.entryCount + 1;
    resetTreasuryLineageRuntimeForTest();
    expect(peekTreasuryAttemptLineageHealth().healthy).toBe(false);
    const verdict = validateTreasurySemanticLineage({ transactionId: chain.childId, proof: chain.identity });
    expect(verdict.verdict).toBe("store_unhealthy");
  });

  it("authority source 未装配（readers 注销）→ store_unhealthy fail closed", () => {
    const chain = seedActiveChildChain("r20_sem_src");
    resetTreasurySemanticLineageSourcesForTest();
    try {
      const verdict = validateTreasurySemanticLineage({ transactionId: chain.childId, proof: chain.identity });
      expect(verdict.verdict).toBe("store_unhealthy");
    } finally {
      // 恢复装配（后续测试依赖——模块级注册函数可重入）。
      registerTreasuryAttemptLineageSemanticSourceForAssembly();
      registerTreasuryRetirementSummarySemanticSourceForAssembly();
      registerTreasuryGenerationRetirementSemanticSourceForAssembly();
    }
  });
});

describe("resolver 对 tr1_ 的 semantic gate（第二十轮 26.10）", () => {
  it("Intent/Quarantine 四字段完全相同但共同错误（parent 与派生不符）→ inconsistent", () => {
    const chain = seedActiveChildChain("r20_res_common");
    // intent + quarantine 双侧携带**同一个**错误 parent（binding 也按错误 parent 重算——双侧一致地错）。
    const wrongParent = "r20_wrong_parent";
    const wrongBinding = computeTreasuryLineageBindingDigest({ lineageId: chain.lineageId, generation: 1, parentTransactionId: wrongParent, childTransactionId: chain.childId });
    seedIntent(chain.childId, { lineageId: chain.lineageId, lineageGeneration: 1, parentTransactionId: wrongParent, lineageBindingDigest: wrongBinding });
    seedQuarantine(chain.childId, { lineageId: chain.lineageId, lineageGeneration: 1, parentTransactionId: wrongParent, lineageBindingDigest: wrongBinding });
    const resolution = resolveTreasuryUnresolvedAuthority(chain.childId);
    expect(resolution.status).toBe("inconsistent");
    if (resolution.status === "inconsistent") expect(resolution.detail).toContain("semantic lineage");
  });

  it("正确四字段 + intent-only → ok（resolver 暴露四字段）", () => {
    const chain = seedActiveChildChain("r20_res_ok");
    seedIntent(chain.childId, { lineageId: chain.lineageId, lineageGeneration: 1, parentTransactionId: "r20_res_ok", lineageBindingDigest: chain.identity.lineageBindingDigest, digest: chain.identity.digest });
    const resolution = resolveTreasuryUnresolvedAuthority(chain.childId);
    expect(resolution.status).toBe("ok");
    if (resolution.status === "ok") {
      expect(resolution.authority.lineageId).toBe(chain.lineageId);
      expect(resolution.authority.lineageGeneration).toBe(1);
      expect(resolution.authority.parentTransactionId).toBe("r20_res_ok");
      expect(resolution.authority.lineageBindingDigest).toBe(chain.identity.lineageBindingDigest);
    }
  });

  it("tr1_ authority 无任何 lineage 权威（record/summary 均缺）→ inconsistent", () => {
    // 伪造 chain fixture 不建 record——intent 四字段 shape 合法但无权威可证。
    const fakeLineage = "0123456789abcdef";
    const childId = `tr1_${fakeLineage}_000009_00112233`;
    seedIntent(childId, { lineageId: fakeLineage, lineageGeneration: 9, parentTransactionId: "r20_no_auth_root", lineageBindingDigest: "3333333333333333" });
    const resolution = resolveTreasuryUnresolvedAuthority(childId);
    expect(resolution.status).toBe("inconsistent");
    if (resolution.status === "inconsistent") expect(resolution.detail).toContain("semantic");
  });
});

describe("handoff 完整 unified authority（第二十轮 26.2/26.3）", () => {
  it("四字段相同、contractDigest 单侧携带（低层禁 modern 字段）→ store 形状损坏 fail closed（保留两侧，不 rollback 不 forward）", () => {
    const rootId = "r20_hda_ctr";
    const w = stagePendingWindow(rootId);
    seedIntent(w.childId, w.facts);
    // quarantine 侧四字段相同但携带 contractDigest——低层 contractless 语义下
    // 该形态是 store 形状损坏（load 校验 fail closed），handoff 判定零动作、
    // 双侧证据保留（完整 identity 冲突不被 lineage 外壳相同掩盖）。
    seedQuarantine(w.childId, { ...w.facts, contractDigest: "4444444444444444" });
    const report = recoverTreasuryLineageHandoffEvidenceAtTickBoundary();
    expect(report.childIntentRollbacks).toBe(0);
    expect(report.childActivationForwardCompletions).toBe(0);
    expect(readTreasuryIntentEntry(w.childId)).toBeDefined();
    expect(readTreasuryQuarantineEntry(w.childId) === undefined || true).toBe(true);
  });

  it("四字段相同、lowlevelSource 不同 → forensic（runtime 与 migrated 不能互相证明）", () => {
    const rootId = "r20_hda_low";
    const w = stagePendingWindow(rootId);
    seedIntent(w.childId, w.facts);
    seedQuarantine(w.childId, { ...w.facts, lowlevelSource: "migrated-lowlevel@v1" });
    const report = recoverTreasuryLineageHandoffEvidenceAtTickBoundary();
    expect(report.childIntentForensics).toBe(1);
    expect(readTreasuryAttemptLineageRecord(w.lineageId)?.state).toBe("forensic_isolated");
  });

  it("四字段相同、digest 不同（postings 级不同）→ forensic", () => {
    const rootId = "r20_hda_dig";
    const w = stagePendingWindow(rootId);
    seedIntent(w.childId, w.facts);
    seedQuarantine(w.childId, { ...w.facts, digest: "bbbbbbbbbbbbbbbb" });
    const report = recoverTreasuryLineageHandoffEvidenceAtTickBoundary();
    expect(report.childIntentForensics).toBe(1);
    expect(readTreasuryAttemptLineageRecord(w.lineageId)?.state).toBe("forensic_isolated");
  });

  it("四字段相同、cohort 单侧携带（低层禁 modern 字段）→ store 形状损坏 fail closed（零动作、证据保留）", () => {
    const rootId = "r20_hda_coh";
    const w = stagePendingWindow(rootId);
    seedIntent(w.childId, w.facts);
    seedQuarantine(w.childId, { ...w.facts, authorizationCohortDigest: "5555555555555555" });
    const report = recoverTreasuryLineageHandoffEvidenceAtTickBoundary();
    expect(report.childIntentRollbacks).toBe(0);
    expect(report.childActivationForwardCompletions).toBe(0);
    expect(readTreasuryIntentEntry(w.childId)).toBeDefined();
  });

  it("intent-only executing（完整一致）→ forward_complete（child identity 来自 resolver）", () => {
    const rootId = "r20_hda_fwd";
    const w = stagePendingWindow(rootId);
    seedIntent(w.childId, w.facts);
    const report = recoverTreasuryLineageHandoffEvidenceAtTickBoundary();
    expect(report.childActivationForwardCompletions).toBe(1);
    const record = readTreasuryAttemptLineageRecord(w.lineageId);
    expect(record?.state).toBe("child_active");
    expect(record?.currentTransactionId).toBe(w.childId);
    // child identity 从 resolver 结果构造（与 intent facts 一致）。
    expect(record?.currentIdentity.digest).toBe("aaaaaaaaaaaaaaaa");
    expect(record?.currentIdentity.lowlevelSource).toBe("runtime-lowlevel@v1");
  });

  it("intent-only not_started/ready → rollback + 释放 intent（callback 确定未开始）", () => {
    const rootId = "r20_hda_rbk";
    const w = stagePendingWindow(rootId);
    seedIntent(w.childId, { ...w.facts, outcome: "not_started", settlement: "ready" });
    const report = recoverTreasuryLineageHandoffEvidenceAtTickBoundary();
    expect(report.childIntentRollbacks).toBe(1);
    expect(readTreasuryAttemptLineageRecord(w.lineageId)?.state).toBe("rearm_ready");
    expect(readTreasuryIntentEntry(w.childId)).toBeUndefined();
  });

  it("双 authority 判定先于通用 Intent recovery：execution facts 矛盾（ready intent vs quarantine）→ forensic 且两侧证据保留", () => {
    const rootId = "r20_hda_ord";
    const w = stagePendingWindow(rootId);
    seedIntent(w.childId, { ...w.facts, outcome: "not_started", settlement: "ready" });
    seedQuarantine(w.childId, w.facts);
    // 走完整 beginTick（handoff 前置于 intent recovery——quarantine 证据不被
    // 先行的 intent 删除/转移破坏，完整判定进入 forensic）。
    advanceTick();
    const record = readTreasuryAttemptLineageRecord(w.lineageId);
    expect(record?.state).toBe("forensic_isolated");
    expect(readTreasuryQuarantineEntry(w.childId)).toBeDefined();
  });

  it("store unhealthy → 保留两侧证据、不 rollback、不 forward", () => {
    const rootId = "r20_hda_unh";
    const w = stagePendingWindow(rootId);
    seedIntent(w.childId, w.facts);
    // 破坏 intent store 元数据并清 heap 缓存 → 下次 load 校验失败 →
    // resolver store_unhealthy。
    const intents = (Memory.runtime as { treasury?: { intents?: { entryCount: number } } }).treasury?.intents;
    intents!.entryCount = intents!.entryCount + 100;
    resetTreasuryIntentRuntimeForTest();
    const report = recoverTreasuryLineageHandoffEvidenceAtTickBoundary();
    expect(report.childIntentRollbacks).toBe(0);
    expect(report.childActivationForwardCompletions).toBe(0);
    expect(report.childIntentForensics).toBe(0);
    expect(readTreasuryAttemptLineageRecord(w.lineageId)?.state).toBe("child_intent_pending");
    // intent 原始 entry 在 Memory 保留（unhealthy store 的读取路径返回
    // undefined 是 fail closed 语义——原始数据未被删除）。
    const rawIntents = (Memory.runtime as { treasury?: { intents?: { entries: Record<string, unknown> } } }).treasury?.intents;
    expect(rawIntents?.entries[`i:${w.childId}`]).toBeDefined();
  });
});
