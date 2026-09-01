/**
 * 【第十九轮】terminal summary 历史代证明测试（任务 25.6/25.9）。
 *
 * 覆盖（工作包 E）：
 * - A→B→C 端到端：A root not-executed、B child not-executed、C committed →
 *   beginTick 压缩 active record → A/B tombstone 到期后独立获得
 *   replacement_match 并回收（B 是压缩后历史代——凭 tombstone 自身完整
 *   lineage proof + summary 重演验证）；root ID 仍被 summary 永久阻断；
 *   A/B/C 旧 ID 不可直接 prepare；resolution store 不因历史 tombstone 满载；
 * - non-rearmable 变体（C non-rearmable retired 的 final 代 tombstone 回收）；
 * - 压缩前外部终态证明（chain_committed 无 matching receipt → 不压缩）；
 * - summary 满载 fail closed（v2 语义回归）；
 * - v1 summary 迁移（缺 authorityClass → 历史代 tombstone 保守 pin）；
 * - verdict 的 future generation / 错误 binding / 错误 class → conflict。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import {
  buildTreasuryActionContract,
  executeTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  replaceTreasuryActionAdapterForTest,
  resetTreasuryTestAdapterSideEffectsForTest,
  type TreasuryActionContract,
} from "@/runtime/treasury/actionContracts";
import { clearTreasuryPersistenceForTest, ensureTreasuryReceiptStore } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { readTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import {
  readTreasuryResolutionTombstone,
  writeTreasuryResolutionTombstone,
  ensureTreasuryResolutionSlotAvailable,
} from "@/runtime/treasury/resolutionStore";
import { lookupTreasuryAttemptLineageByAttemptId, peekTreasuryAttemptLineageHealth } from "@/runtime/treasury/attemptLineage";
import {
  lookupTreasuryRetirementSummaryByLineageId,
  lookupTreasuryRetirementSummaryByRoot,
  peekTreasuryRetirementSummaryHealth,
  resetTreasuryRetirementSummaryRuntimeForTest,
  TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES,
} from "@/runtime/treasury/lineageRetirementSummary";
import { treasuryTombstoneReplacementVerdict } from "@/runtime/treasury/lineageGenerationRetirement";
import { computeTreasuryLineageBindingDigest } from "@/runtime/treasury/lineageBinding";
import { registerTreasuryPolicyResolver, makeFixedReserveTreasuryPolicy } from "@/runtime/treasury/policyAuthority";
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

interface TransferArgs {
  readonly amount?: number;
  readonly outcome?: "ok" | "non-ok" | "throw";
}

function buildContract(service: TreasuryTestService, transactionId: string, args: TransferArgs): TreasuryActionContract {
  const built = buildTreasuryActionContract(service, {
    actionKind: "test.transfer",
    transactionId,
    args: {
      fromRoom: "W1N57",
      fromLocation: "storage",
      toRoom: "W1N57",
      toLocation: "terminal",
      resource: "energy",
      amount: args.amount ?? 500,
      outcome: args.outcome ?? "ok",
    },
  });
  expect(built.status).toBe("built");
  if (built.status !== "built") throw new Error("unreachable");
  return built.contract;
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

/** contract 路径制造 execution-unknown quarantine。 */
function makeNotExecutedParent(service: TreasuryTestService, transactionId: string): void {
  const contract = buildContract(service, transactionId, { outcome: "throw" });
  const authorized = service.authorizeTreasuryActionContract(contract);
  expect(authorized.status).toBe("authorized");
  if (authorized.status !== "authorized") return;
  try {
    executeTreasuryActionContract(service, { contract, authorization: authorized.bundle });
  } catch {
    /* expected */
  }
  expect(readTreasuryQuarantineEntry(transactionId)).toBeDefined();
}

/** 超龄 + 惰性清理触发（塞满 resolution store）。 */
function forceEvictionSweep(): void {
  Game.time += 6_000;
  for (let i = 0; i < 255; i += 1) {
    writeTreasuryResolutionTombstone({
      transactionId: `r19_evict_fill_${String(i)}`,
      digest: "0123456789abcdef",
      resolution: "not-executed",
      stage: "final",
      proofLevel: "legacy",
      actionTick: Game.time - 6_000,
      observationTick: Game.time - 6_000,
      resolvedAtTick: Game.time - 6_000,
    });
  }
  expect(ensureTreasuryResolutionSlotAvailable()).toBeNull();
}

/** A（root not-executed）→ B（child not-executed）→ C（child 执行）。 */
function advanceChain(root: string, cOutcome: "ok" | "non-ok") {
  const service = makeService();
  makeNotExecutedParent(service, root);
  const t1 = advanceTick();
  expect(resolveNotExecuted(t1, root).status).toBe("resolved");
  const a = t1.issueTreasuryRearmCapability({ parentTransactionId: root });
  expect(a.status).toBe("issued");
  if (a.status !== "issued") throw new Error("unreachable");
  const bContract = buildContract(t1, a.childTransactionId, { outcome: "non-ok" });
  const bAuth = t1.authorizeTreasuryActionContract(bContract, { rearmCapability: a.capability });
  expect(bAuth.status).toBe("authorized");
  if (bAuth.status !== "authorized") throw new Error("unreachable");
  expect(executeTreasuryActionContract(t1, { contract: bContract, authorization: bAuth.bundle, rearmCapability: a.capability }).status).toBe("executed_aborted");
  const b = t1.issueTreasuryRearmCapability({ parentTransactionId: a.childTransactionId });
  expect(b.status).toBe("issued");
  if (b.status !== "issued") throw new Error("unreachable");
  const cContract = buildContract(t1, b.childTransactionId, { outcome: cOutcome });
  const cAuth = t1.authorizeTreasuryActionContract(cContract, { rearmCapability: b.capability });
  expect(cAuth.status).toBe("authorized");
  if (cAuth.status !== "authorized") throw new Error("unreachable");
  const cExecuted = executeTreasuryActionContract(t1, { contract: cContract, authorization: cAuth.bundle, rearmCapability: b.capability });
  // gen1 = B（child not-executed 历史代）；gen2 = C（最终代）。
  return { t1, gen1: a.childTransactionId, gen2: b.childTransactionId, cExecuted };
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

describe("A→B→C 端到端：压缩后历史代 tombstone 由 summary 精确证明并回收（第十九轮 25.6）", () => {
  it("C committed → 压缩 → A/B tombstone 独立回收、root 永久阻断、旧 ID 不可 prepare、entryCount 收敛为 0", () => {
    const root = "r19_abc_root";
    const { gen1, gen2, cExecuted } = advanceChain(root, "ok");
    expect(cExecuted.status).toBe("executed_committed");
    // chain_committed → beginTick 压缩 active record。
    const after = advanceTick();
    expect(lookupTreasuryAttemptLineageByAttemptId(gen2)).toBeUndefined();
    const summary = lookupTreasuryRetirementSummaryByRoot(root);
    expect(summary).toBeDefined();
    expect(summary?.terminalState).toBe("chain_committed");
    expect(summary?.finalGeneration).toBe(2);
    expect(summary?.authorityClass).toBe("identity-bound");
    expect(summary?.finalAttemptId).toBe(gen2);
    expect(peekTreasuryAttemptLineageHealth().entryCount).toBe(0);
    // B（历史代 gen1 not-executed）的 tombstone 在压缩后仍可由 summary 证明。
    const bTombstone = readTreasuryResolutionTombstone(gen1);
    expect(bTombstone?.resolution).toBe("not-executed");
    expect(bTombstone?.lineageId).toBeDefined();
    const bVerdict = treasuryTombstoneReplacementVerdict({
      transactionId: gen1,
      digest: bTombstone!.digest,
      resolution: "not-executed",
      stage: "final",
      proofLevel: "identity-bound",
      ...(bTombstone!.lineageBindingDigest !== undefined ? { lineageBindingDigest: bTombstone!.lineageBindingDigest } : {}),
      ...(bTombstone!.lineageId !== undefined ? { lineageId: bTombstone!.lineageId } : {}),
      ...(bTombstone!.lineageGeneration !== undefined ? { lineageGeneration: bTombstone!.lineageGeneration } : {}),
      ...(bTombstone!.parentTransactionId !== undefined ? { parentTransactionId: bTombstone!.parentTransactionId } : {}),
      // 【第二十轮 12.2/12.4】完整 attempt identity 维度（exact proof 比较）。
      ...(bTombstone!.contractDigest !== undefined ? { contractDigest: bTombstone!.contractDigest } : {}),
      ...(bTombstone!.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: bTombstone!.authorizationCohortDigest } : {}),
      ...(bTombstone!.durableIdentityDigest !== undefined ? { durableIdentityDigest: bTombstone!.durableIdentityDigest } : {}),
      ...(bTombstone!.lowlevelSource !== undefined ? { lowlevelSource: bTombstone!.lowlevelSource } : {}),
    });
    expect(bVerdict.verdict).toBe("replacement_match");
    // A（root）tombstone 同样回收。
    forceEvictionSweep();
    expect(readTreasuryResolutionTombstone(root)).toBeUndefined();
    expect(readTreasuryResolutionTombstone(gen1)).toBeUndefined();
    // root ID 仍被 summary 永久阻断；A/B/C 旧 ID 不可直接 prepare。
    expect(after.prepareTransaction(freshInput(after, root)).status).toBe("rejected");
    expect(after.prepareTransaction(freshInput(after, gen1)).status).toBe("rejected");
    // resolution store 不因历史 child tombstone 满载。
    expect(ensureTreasuryResolutionSlotAvailable()).toBeNull();
  });

  it("C non-ok（chain 继续 rearm_ready——非终态）：不压缩、tombstone 随 forceEviction 后 record 仍是权威", () => {
    const root = "r19_nr_root";
    const { gen1 } = advanceChain(root, "non-ok");
    advanceTick();
    forceEvictionSweep();
    expect(readTreasuryResolutionTombstone(root)).toBeUndefined();
    expect(readTreasuryResolutionTombstone(gen1)).toBeUndefined();
    // rearm_ready 非终态 → 不压缩：active record 保留为驱逐后的权威
    //（gen1 已是历史代——按 root 定位 record）。
    const record = lookupTreasuryAttemptLineageByAttemptId(root);
    expect(record?.state).toBe("rearm_ready");
    expect(record?.generation).toBe(2);
    expect(peekTreasuryAttemptLineageHealth().entryCount).toBe(1);
    expect(lookupTreasuryRetirementSummaryByRoot(root)).toBeUndefined();
  });
});

describe("summary 压缩资格的外部终态证明（第十九轮 25.6：E.6）", () => {
  it("chain_committed 但 matching committed receipt 缺失（删除 receipt）→ 不压缩", () => {
    const root = "r19_norec_root";
    const { gen2 } = advanceChain(root, "ok");
    // 删除 committed receipt（模拟外部破坏——summary 无独立证明来源）。
    ensureTreasuryReceiptStore();
    delete (Memory.runtime!.treasury!.receipts!.settled as Record<string, unknown>)[`t:${gen2}`];
    Memory.runtime!.treasury!.receipts!.entryCount = Object.keys(Memory.runtime!.treasury!.receipts!.settled).length;
    const after = advanceTick();
    // 不压缩：active record 保留（终态证明不充分）。
    expect(lookupTreasuryAttemptLineageByAttemptId(gen2)?.state).toBe("chain_committed");
    expect(lookupTreasuryRetirementSummaryByRoot(root)).toBeUndefined();
    expect(peekTreasuryAttemptLineageHealth().entryCount).toBe(1);
    void after;
  });
});

describe("压缩后 verdict 的 summary 重演验证矩阵（第十九轮 25.6：E.2/E.5）", () => {
  /** 构造已压缩 chain（C committed）并返回 B（gen1）的 tombstone facts 与 summary。 */
  function compactedChain(root: string) {
    const { gen1 } = advanceChain(root, "ok");
    advanceTick();
    const summary = lookupTreasuryRetirementSummaryByRoot(root)!;
    expect(summary).toBeDefined();
    const tombstone = readTreasuryResolutionTombstone(gen1)!;
    expect(tombstone).toBeDefined();
    return { gen1, summary, tombstone };
  }

  it("future generation（finalGeneration+1）→ conflict", () => {
    const { gen1, summary, tombstone } = compactedChain("r19_vf_root");
    const futureId = `tr1_${summary.lineageId}_000003_00000000`;
    const verdict = treasuryTombstoneReplacementVerdict({
      transactionId: futureId,
      digest: tombstone.digest,
      resolution: "not-executed",
      stage: "final",
      proofLevel: "identity-bound",
      lineageId: summary.lineageId,
      lineageGeneration: summary.finalGeneration + 1,
      parentTransactionId: gen1,
      lineageBindingDigest: tombstone.lineageBindingDigest!,
    });
    expect(verdict.verdict).toBe("replacement_conflict");
  });

  it("错误 binding → conflict", () => {
    const { summary, tombstone } = compactedChain("r19_vb_root");
    const verdict = treasuryTombstoneReplacementVerdict({
      transactionId: tombstone.transactionId,
      digest: tombstone.digest,
      resolution: "not-executed",
      stage: "final",
      proofLevel: "identity-bound",
      lineageId: tombstone.lineageId,
      lineageGeneration: tombstone.lineageGeneration,
      parentTransactionId: tombstone.parentTransactionId,
      lineageBindingDigest: "9999999999999999",
    });
    void summary;
    expect(verdict.verdict).toBe("replacement_conflict");
  });

  it("错误 proof class → conflict", () => {
    const { tombstone } = compactedChain("r19_vc_root");
    const verdict = treasuryTombstoneReplacementVerdict({
      transactionId: tombstone.transactionId,
      digest: tombstone.digest,
      resolution: "not-executed",
      stage: "final",
      proofLevel: "lowlevel",
      lineageId: tombstone.lineageId,
      lineageGeneration: tombstone.lineageGeneration,
      parentTransactionId: tombstone.parentTransactionId,
      lineageBindingDigest: tombstone.lineageBindingDigest,
    });
    expect(verdict.verdict).toBe("replacement_conflict");
  });

  it("错误 lineageId（ID 内嵌与 proof 字段不一致）→ conflict", () => {
    const { tombstone } = compactedChain("r19_vl_root");
    const verdict = treasuryTombstoneReplacementVerdict({
      transactionId: tombstone.transactionId,
      digest: tombstone.digest,
      resolution: "not-executed",
      stage: "final",
      proofLevel: "identity-bound",
      lineageId: "ffffffffffffffff",
      lineageGeneration: tombstone.lineageGeneration,
      parentTransactionId: tombstone.parentTransactionId,
      lineageBindingDigest: tombstone.lineageBindingDigest,
    });
    expect(verdict.verdict).toBe("replacement_conflict");
  });

  it("无完整 proof 的旧 child tombstone（缺 lineage 字段）→ missing pin（不借 summary 猜测归属）", () => {
    const { tombstone } = compactedChain("r19_vnp_root");
    const verdict = treasuryTombstoneReplacementVerdict({
      transactionId: tombstone.transactionId,
      digest: tombstone.digest,
      resolution: "not-executed",
      stage: "final",
      proofLevel: "identity-bound",
    });
    expect(verdict.verdict).toBe("replacement_missing");
  });

  it("binding 重算一致性（summary (lineageId, gen, parent, child) 重算 == tombstone proof）", () => {
    const { summary, tombstone } = compactedChain("r19_vbr_root");
    const recomputed = computeTreasuryLineageBindingDigest({
      lineageId: summary.lineageId,
      generation: tombstone.lineageGeneration!,
      parentTransactionId: tombstone.parentTransactionId!,
      childTransactionId: tombstone.transactionId,
    });
    expect(recomputed).toBe(tombstone.lineageBindingDigest);
  });
});

describe("summary v1 迁移与满载（第十九轮 25.6/25.9）", () => {
  it("v1 summary store：原子迁移 v2（entry schemaVersion 提升）、root 门禁继续、历史代 class 不可证明 → pin", () => {
    const root = "r19_vmig_root";
    const { gen1 } = advanceChain(root, "ok");
    advanceTick();
    expect(lookupTreasuryRetirementSummaryByRoot(root)).toBeDefined();
    // 手工降级 summary store 为 v1（模拟 Round 18 部署环境）。
    const store = (Memory.runtime!.treasury as unknown as { lineageRetirementSummaries: { version: number; entries: Record<string, { schemaVersion: number }>; entryCount: number } }).lineageRetirementSummaries;
    store.version = 1;
    for (const key of Object.keys(store.entries)) {
      store.entries[key].schemaVersion = 1;
      delete (store.entries[key] as unknown as Record<string, unknown>).authorityClass;
    }
    resetTreasuryRetirementSummaryRuntimeForTest();
    // load 触发 v1→v2 迁移。
    const health = peekTreasuryRetirementSummaryHealth();
    expect(health.healthy).toBe(true);
    expect(health.entryCount).toBe(1);
    const migrated = (Memory.runtime!.treasury as unknown as { lineageRetirementSummaries: { version: number } }).lineageRetirementSummaries.version;
    expect(migrated).toBe(2);
    // root 门禁继续有效。
    const summary = lookupTreasuryRetirementSummaryByRoot(root);
    expect(summary).toBeDefined();
    expect(summary?.authorityClass).toBeUndefined();
    // 历史代 tombstone：class 不可证明 → 保守 pin。
    const tombstone = readTreasuryResolutionTombstone(gen1)!;
    const verdict = treasuryTombstoneReplacementVerdict({
      transactionId: gen1,
      digest: tombstone.digest,
      resolution: "not-executed",
      stage: "final",
      proofLevel: "identity-bound",
      lineageId: tombstone.lineageId,
      lineageGeneration: tombstone.lineageGeneration,
      parentTransactionId: tombstone.parentTransactionId,
      lineageBindingDigest: tombstone.lineageBindingDigest,
    });
    expect(verdict.verdict).toBe("replacement_missing");
    // lineageId 查询仍然可用（迁移后索引重建）。
    expect(lookupTreasuryRetirementSummaryByLineageId(summary!.lineageId)).toBeDefined();
  });

  it("summary 满载：不删除旧 summary、active record 保持、新 root 容量门禁拒绝（v2 语义回归）", () => {
    const entries: Record<string, unknown> = {};
    for (let i = 0; i < TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES; i += 1) {
      entries[`rs:r19_sum_fill_${String(i)}`] = {
        schemaVersion: 2,
        lineageId: `0000000000000${String(i).padStart(3, "0")}`.slice(-16),
        rootTransactionId: `r19_sum_fill_${String(i)}`,
        rootIdentityDigest: `1000000000000${String(i).padStart(3, "0")}`.slice(-16),
        terminalState: "non_rearmable_retired",
        finalGeneration: 0,
        finalAttemptId: `r19_sum_fill_${String(i)}`,
        finalizedAtTick: Game.time,
      };
    }
    Memory.runtime = Memory.runtime ?? {};
    (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury = {
      ...((Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury ?? {}),
      lineageRetirementSummaries: { version: 2, entries, entryCount: TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES, updatedAt: Game.time },
    };
    resetTreasuryRetirementSummaryRuntimeForTest();
    expect(peekTreasuryRetirementSummaryHealth().entryCount).toBe(TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES);
    // committed chain 无法压缩（summary 满）→ active 保持。
    const root = "r19_cmpf_root";
    const { gen2 } = advanceChain(root, "ok");
    advanceTick();
    expect(lookupTreasuryAttemptLineageByAttemptId(gen2)?.state).toBe("chain_committed");
    expect(peekTreasuryAttemptLineageHealth().entryCount).toBe(1);
    expect(Object.keys((Memory.runtime!.treasury as unknown as { lineageRetirementSummaries: { entries: Record<string, unknown> } }).lineageRetirementSummaries.entries).length).toBe(TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES);
  });
});
