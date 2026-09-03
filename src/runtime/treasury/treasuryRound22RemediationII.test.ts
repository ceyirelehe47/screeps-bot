/**
 * 【Round 22 Remediation II】enforced cleanup journal & exact settlement
 * relation 的确定性回归矩阵。
 *
 * 覆盖任务书四节 1-11：
 * 1  journal 容量满 → resolution 拒绝（capability 未消费/marker 未清/
 *    authority 未释放/无错误 final；释放容量后可重试）；
 * 2  已有同 ID identity conflict → open 冲突零状态变化；
 * 3  已有相反 resolution → fail closed（两种结论不共存）；
 * 4  本次新建 journal 后 staged 回滚 → 新建 entry 安全撤销；already-open
 *    entry 不误删（经 receipt-blocked 回滚路径驱动——与 capability 消费
 *    防御分支共用同一 revoke 语义）；
 * 5  not-executed admission 成功但 final proof 写失败 → 不留下谎称
 *    settlementProofDurable 的 entry、authority/marker 保持、可安全重试；
 * 6  authority release 后 resolver ok/inconsistent/store_unhealthy →
 *    不得 finalize / 不得报告 complete；
 * 7  not-executed converge 非 completed → retirement pending（不伪装
 *    complete_rearm_ready / complete_non_rearmable）；
 * 8  journal 持久形状负向矩阵（identity profile/class/requiredness/
 *    forbidden/lineage 整体性/generation/entryCount/容量/阶段越级）；
 * 9  阶段 boolean 撒谎（marker/authority/outcome/lineage 四窗口）→ 恢复
 *    重验外部事实，不得跳过并删除 entry；
 * 10 GRA exact mismatch 表驱动（generation/parent/binding/contract/cohort/
 *    durable/lowlevel/class-profile——digest 与 lineageId 相同前提下逐维
 *    篡改均被拒绝）；
 * 11 reservation 生命周期（阶段标记拒绝/恢复跳过/proof_durable open 激活）。
 *
 * 全部使用 mock（installRooms + 测试 reconciler），不调用真实 Game 写 API。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest, commitSettledReceipt } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { readTreasuryWriteFault, recordTreasuryWriteFault, setTreasuryCommitFaultInjectorForTest, type TreasuryWriteFaultPhase } from "@/runtime/treasury/writeFault";
import {
  readTreasuryQuarantineEntry,
  quarantineTreasuryTransaction,
  releaseTreasuryQuarantineEntry,
} from "@/runtime/treasury/quarantine";
import { releaseTreasuryIntentEntry } from "@/runtime/treasury/intents";
import {
  readTreasuryResolutionTombstone,
  writeTreasuryResolutionTombstone,
  resetTreasuryResolutionStoreForTest,
  peekTreasuryResolutionStoreHealth,
} from "@/runtime/treasury/resolutionStore";
import {
  acknowledgeTreasuryCleanupSettlementProof,
  registerTreasuryCleanupProofProbesForAssembly,
} from "@/runtime/treasury/settlementProofActivation";
import {
  openTreasuryResolutionCleanup,
  markTreasuryResolutionCleanupStage,
  readTreasuryResolutionCleanupEntry,
  peekTreasuryResolutionCleanupHealth,
  revokeTreasuryResolutionCleanup,
  recoverTreasuryResolutionCleanupAtTickBoundary,
  resetTreasuryResolutionCleanupHeapCacheForTest,
  registerTreasuryResolutionCleanupHandlersForAssembly,
  TREASURY_RESOLUTION_CLEANUP_MAX_ENTRIES,
  type TreasuryResolutionCleanupEntry,
  type TreasuryResolutionCleanupStore,
} from "@/runtime/treasury/resolutionCleanupJournal";
import { resolveTreasuryUnresolvedAuthority } from "@/runtime/treasury/unresolvedAuthority";
import * as unresolvedAuthorityModule from "@/runtime/treasury/unresolvedAuthority";
import {
  verifyTreasuryCurrentSettlement,
  verifyTreasuryOppositeProofAbsence,
  registerTreasurySettlementSummaryHealthSourceForAssembly,
  registerTreasurySettlementLineageHealthSourceForAssembly,
} from "@/runtime/treasury/currentSettlementCoordinator";
import { resetTreasuryGenerationRetirementRuntimeForTest, TREASURY_GENERATION_RETIREMENT_VERSION } from "@/runtime/treasury/generationRetirementAuthority";
import { computeTreasuryAttemptLineageId, deriveTreasuryLineageNextChildTransactionId } from "@/runtime/treasury/attemptLineage";
import { computeTreasuryGenerationRootIdentityDigest } from "@/runtime/treasury/generationRetirementAuthority";
import { computeTreasuryLineageBindingDigest } from "@/runtime/treasury/lineageBinding";
import {
  makeTreasuryTestTransferAdapter,
  replaceTreasuryActionAdapterForTest,
  type TreasuryActionReconcilerConclusion,
} from "@/runtime/treasury/actionContracts";
import { TREASURY_LOWLEVEL_SOURCE_RUNTIME } from "@/runtime/treasury/authorityLevel";
import { installRooms, type RoomSpec } from "@mock/treasury";
import type { TreasuryTransactionInput } from "@/runtime/treasury/types";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import type { TreasuryReconciliationCapability } from "@/runtime/treasury/reconciliation";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 5_000 },
  },
];

const DIGEST_A = "0123456789abcdef";
const DIGEST_B = "fedcba9876543210";
const DURABLE_A = "0cc99174bb6f2e74";
const COHORT_A = "aa11bb22cc33dd44";
const CONTRACT_A = "ee55ff66aa77bb88";

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

let reconcilerConclusion: TreasuryActionReconcilerConclusion = "observed_committed";

function registerTerminalSendReconciler(): void {
  replaceTreasuryActionAdapterForTest({
    ...makeTreasuryTestTransferAdapter(),
    kind: "terminal.send",
    semanticIdentity: "terminal.send@reconciler-semantics-v1",
    reconcile: () => reconcilerConclusion,
  });
}

function issueCapability(service: TreasuryTestService, transactionId: string, digest?: string): TreasuryReconciliationCapability | null {
  const issued = service.issueTreasuryReconciliationCapability({ transactionId, ...(digest !== undefined ? { digest } : {}) });
  return issued.status === "issued" ? issued.capability : null;
}

/** modern commit-fault quarantine（Game 确认 OK 的故障——完整 contract 身份）。 */
function makeCommittedFaultQuarantine(transactionId: string): { service: TreasuryTestService; digest: string; identity: Record<string, string> } {
  const service = makeService();
  let fired = false;
  setTreasuryCommitFaultInjectorForTest((phase) => {
    if (phase === "receipt_publish" && !fired) {
      fired = true;
      throw new Error("injected:receipt_publish");
    }
  });
  const result = service.executePreparedAction(freshInput(service, transactionId), () => ({ ok: true }));
  expect(result.status).toBe("executed_unsettled");
  service.endTick();
  const entry = readTreasuryQuarantineEntry(transactionId);
  expect(entry).toBeDefined();
  return {
    service,
    digest: entry!.digest,
    identity: {
      ...(entry!.contractDigest !== undefined ? { contractDigest: entry!.contractDigest } : {}),
      ...(entry!.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: entry!.authorizationCohortDigest } : {}),
      ...(entry!.durableIdentityDigest !== undefined ? { durableIdentityDigest: entry!.durableIdentityDigest } : {}),
    },
  };
}

/** execution-unknown quarantine（not-executed 允许的 phase）。 */
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

function resolveNotExecuted(service: TreasuryTestService, transactionId: string, capability: TreasuryReconciliationCapability) {
  return service.resolveUnresolvedTransaction({ transactionId, capability });
}

function resolveCommitted(service: TreasuryTestService, transactionId: string, capability: TreasuryReconciliationCapability) {
  return service.resolveUnresolvedTransaction({ transactionId, capability });
}

function advanceTick(): TreasuryTestService {
  Game.time += 1;
  const next = makeService();
  next.beginTick();
  return next;
}

// ── journal store 手工 fixture（load 校验负向矩阵共用） ─────────────────────

function journalBranch(): Record<string, unknown> {
  if (!Memory.runtime) Memory.runtime = {} as never;
  const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
  if (!runtime.treasury) runtime.treasury = {};
  return runtime.treasury;
}

function seedJournalStore(entries: Record<string, unknown>, entryCount?: number): void {
  const branch = journalBranch();
  branch.resolutionCleanup = {
    version: 1,
    entries,
    entryCount: entryCount ?? Object.keys(entries).length,
    updatedAt: Game.time,
  };
  resetTreasuryResolutionCleanupHeapCacheForTest();
}

function validJournalEntry(transactionId: string, overrides: Partial<TreasuryResolutionCleanupEntry> = {}): Record<string, unknown> {
  return {
    transactionId,
    digest: DIGEST_A,
    resolution: "not-executed",
    identityProfile: "legacy-replay",
    proofClass: "legacy",
    settlementProofDurable: true,
    markerDischarged: false,
    authorityReleased: false,
    outcomeFinalized: false,
    lineageFinalized: false,
    openedAtTick: Game.time,
    updatedAt: Game.time,
    ...overrides,
  };
}

// journal 的 heap 缓存不随 clearTreasuryPersistenceForTest 重置（模块自有
// test reset）——不重置会让后续写入落到已从 Memory 摘除的 detached store。
beforeEach(() => {
  resetTreasuryResolutionCleanupHeapCacheForTest();
});

function fillJournalToCapacity(): void {
  const entries: Record<string, unknown> = {};
  for (let i = 0; i < TREASURY_RESOLUTION_CLEANUP_MAX_ENTRIES; i++) {
    const tx = `r22ii_cap_${i}`;
    entries[`c:${tx}`] = validJournalEntry(tx);
  }
  seedJournalStore(entries);
}

describe("Remediation II 1：journal 容量满 → resolution fail closed", () => {
  beforeEach(() => {
    clearTreasuryPersistenceForTest();
    resetTreasuryCommitmentRevisionForTest();
    setTreasuryCommitFaultInjectorForTest(null);
    reconcilerConclusion = "observed_committed";
    registerTerminalSendReconciler();
  });

  it("满载：cleanup_journal_blocked；capability 未消费、marker/authority 保持、无错误 final；释放容量后同 capability 重试成功", () => {
    const { digest } = makeCommittedFaultQuarantine("r22ii_full");
    const next = advanceTick();
    fillJournalToCapacity();
    const capability = issueCapability(next, "r22ii_full", digest);
    expect(capability).not.toBeNull();
    const result = resolveCommitted(next, "r22ii_full", capability!);
    expect(result).toMatchObject({ status: "rejected", reason: "cleanup_journal_blocked" });
    // capability 未消费 / marker 未清 / authority 未释放 / 无错误 final。
    expect(readTreasuryWriteFault()).toBeDefined();
    expect(readTreasuryQuarantineEntry("r22ii_full")).toBeDefined();
    expect(readTreasuryResolutionTombstone("r22ii_full")).toBeUndefined();
    expect(readTreasuryResolutionCleanupEntry("r22ii_full")).toBeUndefined();
    // 释放容量（移除一条 pending entry）后同 capability 重试成功。
    const store = (journalBranch().resolutionCleanup as TreasuryResolutionCleanupStore);
    delete store.entries[`c:r22ii_cap_0`];
    store.entryCount -= 1;
    resetTreasuryResolutionCleanupHeapCacheForTest();
    const retry = resolveCommitted(next, "r22ii_full", capability!);
    expect(retry).toMatchObject({ status: "resolved", resolution: "committed" });
    expect(readTreasuryResolutionTombstone("r22ii_full")?.stage).toBe("final");
  });
});

describe("Remediation II 2/3：既有 entry 冲突 → open fail closed", () => {
  beforeEach(() => {
    clearTreasuryPersistenceForTest();
    resetTreasuryCommitmentRevisionForTest();
    setTreasuryCommitFaultInjectorForTest(null);
    reconcilerConclusion = "observed_committed";
    registerTerminalSendReconciler();
  });

  it("同 ID identity conflict：既有 entry 零变化、新 attempt 不得借用、capability 与 authority 保持", () => {
    const { digest } = makeCommittedFaultQuarantine("r22ii_conflict");
    const next = advanceTick();
    seedJournalStore({ "c:r22ii_conflict": validJournalEntry("r22ii_conflict", { resolution: "committed", digest: DIGEST_B }) });
    const before = JSON.parse(JSON.stringify((journalBranch().resolutionCleanup as TreasuryResolutionCleanupStore).entries["c:r22ii_conflict"]));
    const capability = issueCapability(next, "r22ii_conflict", digest);
    const result = resolveCommitted(next, "r22ii_conflict", capability!);
    expect(result).toMatchObject({ status: "rejected", reason: "cleanup_journal_blocked" });
    const after = (journalBranch().resolutionCleanup as TreasuryResolutionCleanupStore).entries["c:r22ii_conflict"];
    expect(JSON.parse(JSON.stringify(after))).toEqual(before);
    expect(readTreasuryQuarantineEntry("r22ii_conflict")).toBeDefined();
    expect(readTreasuryWriteFault()).toBeDefined();
    expect(readTreasuryResolutionTombstone("r22ii_conflict")).toBeUndefined();
  });

  it("同 ID 相反 resolution：fail closed——两种结论不得共存或互相覆盖", () => {
    const { digest } = makeCommittedFaultQuarantine("r22ii_opposite");
    const next = advanceTick();
    seedJournalStore({ "c:r22ii_opposite": validJournalEntry("r22ii_opposite", { resolution: "not-executed" }) });
    const capability = issueCapability(next, "r22ii_opposite", digest);
    const result = resolveCommitted(next, "r22ii_opposite", capability!);
    expect(result).toMatchObject({ status: "rejected", reason: "cleanup_journal_blocked" });
    const entry = (journalBranch().resolutionCleanup as TreasuryResolutionCleanupStore).entries["c:r22ii_opposite"] as TreasuryResolutionCleanupEntry;
    expect(entry.resolution).toBe("not-executed");
    expect(readTreasuryResolutionTombstone("r22ii_opposite")).toBeUndefined();
  });
});

describe("Remediation II 4：新建 journal 后 staged 回滚的安全撤销", () => {
  beforeEach(() => {
    clearTreasuryPersistenceForTest();
    resetTreasuryCommitmentRevisionForTest();
    setTreasuryCommitFaultInjectorForTest(null);
    reconcilerConclusion = "observed_committed";
    registerTerminalSendReconciler();
  });

  it("本次新建（opened）+ receipt blocked → tombstone 回滚且 entry 撤销（marker/authority 保持）", () => {
    const { digest, identity } = makeCommittedFaultQuarantine("r22ii_rollback");
    // 预塞 identity 冲突的既有 receipt → refresh blocked（identity_conflict）。
    expect(commitSettledReceipt("r22ii_rollback", Game.time, {
      digest,
      durableIdentityDigest: "bbbbbbbbbbbbbbbb",
      ...identity,
    }).status).not.toBe("rejected");
    const next = advanceTick();
    const capability = issueCapability(next, "r22ii_rollback", digest);
    const result = resolveCommitted(next, "r22ii_rollback", capability!);
    expect(result).toMatchObject({ status: "rejected" });
    if (result.status === "rejected") {
      expect(["settlement_identity_conflict", "settlement_proof_insufficient"]).toContain(result.reason);
    }
    // 回滚：resolving tombstone 删除 + 本次新建 journal entry 撤销。
    expect(readTreasuryResolutionTombstone("r22ii_rollback")).toBeUndefined();
    expect(readTreasuryResolutionCleanupEntry("r22ii_rollback")).toBeUndefined();
    expect(readTreasuryQuarantineEntry("r22ii_rollback")).toBeDefined();
    expect(readTreasuryWriteFault()).toBeDefined();
  });

  it("already-open 既有 entry（exact identity 一致）不误删", () => {
    const { digest, identity } = makeCommittedFaultQuarantine("r22ii_keep");
    expect(commitSettledReceipt("r22ii_keep", Game.time, {
      digest,
      durableIdentityDigest: "bbbbbbbbbbbbbbbb",
      ...identity,
    }).status).not.toBe("rejected");
    // 预开 exact identity 一致的 committed entry（模拟上一中断留下的 pending）。
    // 【Remediation IV 十一.2】entry 实际是 lowlevel authority（testHarness
    // 的 executePreparedAction 路径）——preOpen 按实际身份构造（新 candidate
    // 验证要求 profile↔facts 一致，modern-contract 缺 contract 会被写入前
    // 拒绝，与本 attempt 无关的 profile 不得混入）。
    const quarantineEntry = readTreasuryQuarantineEntry("r22ii_keep")!;
    const preOpen = openTreasuryResolutionCleanup({
      transactionId: "r22ii_keep",
      digest,
      resolution: "committed",
      identityProfile: "lowlevel",
      proofClass: "lowlevel",
      ...(quarantineEntry.lowlevelSource !== undefined ? { lowlevelSource: quarantineEntry.lowlevelSource } : {}),
      ...(quarantineEntry.durableIdentityDigest !== undefined ? { durableIdentityDigest: quarantineEntry.durableIdentityDigest } : {}),
    });
    expect(preOpen.status).toBe("opened");
    const next = advanceTick();
    const capability = issueCapability(next, "r22ii_keep", digest);
    const result = resolveCommitted(next, "r22ii_keep", capability!);
    expect(result.status).toBe("rejected");
    expect(readTreasuryResolutionTombstone("r22ii_keep")).toBeUndefined();
    // already-open 的既有 entry 保留（不得误删既有 journal）。
    const kept = readTreasuryResolutionCleanupEntry("r22ii_keep");
    expect(kept).toBeDefined();
    // 【Remediation V 九】open/reopen 恒不激活（settlement flow 未成立——
    // receipt blocked 回滚，entry 保持 reservation 原状）。
    expect(kept!.settlementProofDurable).toBe(false);
    expect(kept!.markerDischarged).toBe(false);
  });
});

describe("Remediation II 5：not-executed admission 成功但 proof 写失败", () => {
  beforeEach(() => {
    clearTreasuryPersistenceForTest();
    resetTreasuryCommitmentRevisionForTest();
    setTreasuryCommitFaultInjectorForTest(null);
    reconcilerConclusion = "observed_not_executed";
    registerTerminalSendReconciler();
  });

  it("final tombstone 写失败 → 保留未激活 reservation（不谎称 durable）、authority/marker 保持、可安全重试", () => {
    makeExecutingQuarantine("r22ii_ne1");
    const next = advanceTick();
    const capability = issueCapability(next, "r22ii_ne1");
    expect(capability).not.toBeNull();
    // 签发后、resolve 前预塞同 id 的 resolving committed tombstone →
    // finalWrite（final not-executed）被状态机拒绝（resolution 结论不同）。
    const preWrite = writeTreasuryResolutionTombstone({
      transactionId: "r22ii_ne1",
      digest: DIGEST_B,
      resolution: "committed",
      stage: "resolving",
      proofLevel: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      durableIdentityDigest: DURABLE_A,
      actionTick: Game.time,
      settledAtTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      source: "test",
    });
    expect(preWrite.status).not.toBe("rejected");
    const result = resolveNotExecuted(next, "r22ii_ne1", capability!);
    expect(result).toMatchObject({ status: "rejected", reason: "resolution_store_fatal" });
    // 未激活 reservation：entry 存在、settlementProofDurable=false。
    const reservation = readTreasuryResolutionCleanupEntry("r22ii_ne1");
    expect(reservation).toBeDefined();
    expect(reservation!.settlementProofDurable).toBe(false);
    expect(reservation!.markerDischarged).toBe(false);
    // authority/marker 保持；阶段不得推进。
    expect(readTreasuryQuarantineEntry("r22ii_ne1")).toBeDefined();
    expect(readTreasuryWriteFault()).toBeDefined();
    expect(markTreasuryResolutionCleanupStage("r22ii_ne1", "marker_discharge", "x")).toBe(false);
    // 重试仍 fail closed（不形成错误终态）。
    const retryCapability = issueCapability(next, "r22ii_ne1");
    const retry = resolveNotExecuted(next, "r22ii_ne1", retryCapability!);
    expect(retry).toMatchObject({ status: "rejected" });
    expect(readTreasuryQuarantineEntry("r22ii_ne1")).toBeDefined();
  });
});

describe("Remediation II 6：authority release read-back 是 finalize 硬门禁", () => {
  let spy: jest.SpyInstance | null = null;

  beforeEach(() => {
    clearTreasuryPersistenceForTest();
    resetTreasuryCommitmentRevisionForTest();
    setTreasuryCommitFaultInjectorForTest(null);
    reconcilerConclusion = "observed_committed";
    registerTerminalSendReconciler();
  });

  afterEach(() => {
    spy?.mockRestore();
    spy = null;
  });

  it.each([
    ["ok（仍有 Authority）", "replay_ok"],
    ["inconsistent", "inconsistent"],
    ["store_unhealthy", "store_unhealthy"],
  ] as const)("committed：release 后 resolver %s → 不 finalize、journal 阶段不推进", (_label, mode) => {
    const { digest } = makeCommittedFaultQuarantine("r22ii_readback");
    const next = advanceTick();
    const capability = issueCapability(next, "r22ii_readback", digest);
    const actual = unresolvedAuthorityModule.resolveTreasuryUnresolvedAuthority;
    // resolver 调用序：1 prevalidate 快路径、2 prevalidate 完整解析、
    // 3 refresh 后 verifier 输入、【Remediation IV】4 coordinator pre-release
    // gate、5 discharge 内部 gate（两处都必须真实 ok 才会 release）、
    // 6 release 后 read-back（伪造点）。
    let calls = 0;
    let verifierResult: ReturnType<typeof actual> | null = null;
    spy = jest.spyOn(unresolvedAuthorityModule, "resolveTreasuryUnresolvedAuthority");
    spy.mockImplementation(((transactionId: string) => {
      calls += 1;
      if (calls === 3) verifierResult = actual(transactionId);
      if (calls >= 6) {
        if (mode === "replay_ok" && verifierResult !== null && verifierResult.status === "ok") return verifierResult;
        if (mode === "inconsistent") return { status: "inconsistent", detail: "injected" } as const;
        return { status: "store_unhealthy", detail: "injected" } as const;
      }
      if (calls >= 4 && mode === "replay_ok" && verifierResult !== null && verifierResult.status === "ok") return verifierResult;
      return actual(transactionId);
    }) as typeof actual);
    const result = resolveCommitted(next, "r22ii_readback", capability!);
    expect(result).toMatchObject({ status: "rejected", reason: "authority_release_blocked" });
    // resolving 保留；final 不写；receipt 保留；journal authority-release 未推进。
    expect(readTreasuryResolutionTombstone("r22ii_readback")?.stage).toBe("resolving");
    const entry = readTreasuryResolutionCleanupEntry("r22ii_readback");
    expect(entry).toBeDefined();
    expect(entry!.markerDischarged).toBe(true);
    expect(entry!.authorityReleased).toBe(false);
    expect(entry!.outcomeFinalized).toBe(false);
  });

  it("not-executed：release 后 resolver 非 not_found → resolved + authority_release_pending（非 complete_*）", () => {
    reconcilerConclusion = "observed_not_executed";
    makeExecutingQuarantine("r22ii_ne_readback");
    const next = advanceTick();
    const capability = issueCapability(next, "r22ii_ne_readback");
    const actual = unresolvedAuthorityModule.resolveTreasuryUnresolvedAuthority;
    // resolver 调用序：1 prevalidate 快路径、2 prevalidate 完整解析、
    // 【Remediation IV】3 coordinator pre-release gate、4 discharge 内部
    // gate、5 release 后 read-back（伪造点）。
    let calls = 0;
    spy = jest.spyOn(unresolvedAuthorityModule, "resolveTreasuryUnresolvedAuthority");
    spy.mockImplementation(((transactionId: string) => {
      calls += 1;
      if (calls >= 5) return { status: "inconsistent", detail: "injected" } as const;
      return actual(transactionId);
    }) as typeof actual);
    const result = resolveNotExecuted(next, "r22ii_ne_readback", capability!);
    expect(result).toMatchObject({ status: "resolved", retirement: "authority_release_pending" });
    const entry = readTreasuryResolutionCleanupEntry("r22ii_ne_readback");
    expect(entry).toBeDefined();
    expect(entry!.authorityReleased).toBe(false);
    expect(entry!.outcomeFinalized).toBe(false);
  });
});

describe("Remediation II 7：not-executed converge 非 completed → retirement pending", () => {
  beforeEach(() => {
    clearTreasuryPersistenceForTest();
    resetTreasuryCommitmentRevisionForTest();
    setTreasuryCommitFaultInjectorForTest(null);
    reconcilerConclusion = "observed_not_executed";
    registerTerminalSendReconciler();
  });

  it("exact proof 写入冲突（同 key 已有它属 proof）→ exact_proof_pending，不得返回 complete_*", () => {
    const { digest } = makeExecutingQuarantine("r22ii_ne2");
    const quarantineEntry = readTreasuryQuarantineEntry("r22ii_ne2")!;
    const identity = {
      digest,
      ...(quarantineEntry.contractDigest !== undefined ? { contractDigest: quarantineEntry.contractDigest } : {}),
      ...(quarantineEntry.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: quarantineEntry.authorizationCohortDigest } : {}),
      ...(quarantineEntry.durableIdentityDigest !== undefined ? { durableIdentityDigest: quarantineEntry.durableIdentityDigest } : {}),
    };
    // 预计算 publication 将创建的 root lineageId，并在同 key 预塞自洽的它属 proof。
    const lid = computeTreasuryAttemptLineageId("r22ii_ne2", identity);
    const otherIdentity = { digest: DIGEST_B };
    const otherLid = computeTreasuryAttemptLineageId("r22ii_other_root", otherIdentity);
    const conflictingProof = {
      schemaVersion: 2 as const,
      identityProfile: "lowlevel" as const,
      lineageId: otherLid,
      rootTransactionId: "r22ii_other_root",
      rootIdentityDigest: computeTreasuryGenerationRootIdentityDigest(otherIdentity),
      generation: 0,
      transactionId: "r22ii_other_root",
      digest: DIGEST_B,
      durableIdentityDigest: DURABLE_A,
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      authorityClass: "lowlevel" as const,
      resolution: "not_executed" as const,
      retirement: { lineagePublished: true as const, authorityReleased: true as const, markerCleaned: true as const },
      completedAtTick: Game.time,
    };
    if (!Memory.runtime) Memory.runtime = {} as never;
    const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
    if (!runtime.treasury) runtime.treasury = {};
    runtime.treasury.generationRetirementProofs = {
      version: TREASURY_GENERATION_RETIREMENT_VERSION,
      entries: { [`gr:${lid}:000000`]: conflictingProof },
      entryCount: 1,
      updatedAt: Game.time,
    };
    resetTreasuryGenerationRetirementRuntimeForTest();
    const next = advanceTick();
    const capability = issueCapability(next, "r22ii_ne2");
    const result = resolveNotExecuted(next, "r22ii_ne2", capability!);
    expect(result).toMatchObject({ status: "resolved", retirement: "exact_proof_pending" });
    expect(result).not.toMatchObject({ retirement: "complete_rearm_ready" });
    expect(result).not.toMatchObject({ retirement: "complete_non_rearmable" });
  });
});

describe("Remediation II 8：journal 持久形状负向矩阵", () => {
  beforeEach(() => {
    clearTreasuryPersistenceForTest();
  });

  it.each([
    ["非法 identityProfile", { identityProfile: "modern-unknown" }],
    ["proofClass/profile 组合冲突", { proofClass: "lowlevel" }],
    ["modern-contract 缺 required 字段", { identityProfile: "modern-contract", proofClass: "identity-bound" }],
    ["lowlevel 缺 lowlevelSource", { identityProfile: "lowlevel", proofClass: "lowlevel", durableIdentityDigest: DURABLE_A }],
    ["lowlevel 携带 forbidden contract 事实", { identityProfile: "lowlevel", proofClass: "lowlevel", durableIdentityDigest: DURABLE_A, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME, contractDigest: CONTRACT_A }],
    ["partial lineage", { lineageId: "1111111111111111" }],
    ["非法 generation", { lineageId: "1111111111111111", lineageGeneration: 0, parentTransactionId: "p", lineageBindingDigest: "2222222222222222" }],
    ["阶段越级（authority 先于 marker）", { authorityReleased: true }],
    ["阶段越级（outcome 先于 authority）", { markerDischarged: true, outcomeFinalized: true }],
    ["reservation 携带已推进阶段", { settlementProofDurable: false, markerDischarged: true }],
  ] as const)("entry %s → store 结构化 unhealthy（不折叠为 pending 为空）", (_label, overrides) => {
    seedJournalStore({ "c:r22ii_bad": validJournalEntry("r22ii_bad", overrides as Partial<TreasuryResolutionCleanupEntry>) });
    const health = peekTreasuryResolutionCleanupHealth();
    expect(health.healthy).toBe(false);
    expect(health.detail).toBeTruthy();
    expect(openTreasuryResolutionCleanup({
      transactionId: "r22ii_other",
      digest: DIGEST_A,
      resolution: "not-executed",
      identityProfile: "legacy-replay",
      proofClass: "legacy",
    })).toMatchObject({ status: "rejected" });
  });

  it("store 级不变量：entryCount 错误 / 超容量 / 键前缀非法 → unhealthy", () => {
    seedJournalStore({ "c:r22ii_ok": validJournalEntry("r22ii_ok") }, 5);
    expect(peekTreasuryResolutionCleanupHealth().healthy).toBe(false);

    const entries: Record<string, unknown> = {};
    for (let i = 0; i <= TREASURY_RESOLUTION_CLEANUP_MAX_ENTRIES; i++) {
      const tx = `r22ii_over_${i}`;
      entries[`c:${tx}`] = validJournalEntry(tx);
    }
    seedJournalStore(entries);
    expect(peekTreasuryResolutionCleanupHealth().healthy).toBe(false);

    seedJournalStore({ "x:r22ii_key": validJournalEntry("r22ii_key") });
    expect(peekTreasuryResolutionCleanupHealth().healthy).toBe(false);
  });
});

describe("Remediation II 9：阶段 boolean 撒谎 → 恢复重验外部事实", () => {
  beforeEach(() => {
    clearTreasuryPersistenceForTest();
  });

  it("markerDischarged=true 但 matching marker 仍存在 → 恢复安全补 discharge 并完成", () => {
    // 场景：lowlevel authority + matching marker 在场；entry 谎称 marker 已 discharge。
    const tx = "r22ii_lie_marker";
    const write = quarantineTreasuryTransaction({
      transactionId: tx,
      authorityLevel: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      digest: DIGEST_A,
      tick: Game.time,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      adapterSemanticIdentity: "terminal.send@reconciler-semantics-v1",
      phase: "ok_pending_commit_unresolved",
      outcome: "returned_ok",
      settlement: "quarantined",
      deltas: [{ roomName: "W1N57", locationKind: "storage" as const, resource: "energy" as const, delta: -500 }],
      recordedAt: Game.time,
    });
    expect(write.status).toBe("written");
    // 【Remediation IV 六.3】durable 以 authority 重算值为单一来源（gate 的 journal↔authority exact identity）。
    const durable = readTreasuryQuarantineEntry(tx)?.durableIdentityDigest as string;
    expect(durable).toBeDefined();
    // final committed tombstone 经状态机两段写入（absent 不得直写 final committed）。
    const resolving = writeTreasuryResolutionTombstone({
      transactionId: tx,
      digest: DIGEST_A,
      resolution: "committed",
      stage: "resolving",
      proofLevel: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      durableIdentityDigest: durable,
      actionTick: Game.time,
      settledAtTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      source: "test",
    });
    expect(resolving.status).not.toBe("rejected");
    expect(writeTreasuryResolutionTombstone({ ...readTreasuryResolutionTombstone(tx)!, stage: "final" }).status).not.toBe("rejected");
    // 【Remediation IV 六.5】committed 场景的 pre-release gate 要求
    // release-trusted Receipt（生产时序对齐）。
    expect(commitSettledReceipt(tx, Game.time, {
      digest: DIGEST_A,
      durableIdentityDigest: durable,
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    }).status).not.toBe("rejected");
    // matching marker（与 entry 身份完全一致——lowlevel + durable + runtime source）。
    recordTreasuryWriteFault({
      transactionId: tx,
      digest: DIGEST_A,
      tick: Game.time,
      kind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick",
      status: "unresolved",
      recordedAt: Game.time,
      markerProtocol: 4,
      identityProfile: "lowlevel",
      authorityClass: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      durableIdentityDigest: durable,
    } as never);
    expect(readTreasuryWriteFault()).toBeDefined();
    // 打开 entry 并手工撒谎（marker 阶段 true 但 marker 未清除）。
    const opened = openTreasuryResolutionCleanup({
      transactionId: tx,
      digest: DIGEST_A,
      resolution: "committed",
      identityProfile: "lowlevel",
      proofClass: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      durableIdentityDigest: durable,
    });
    expect(opened.status).toBe("opened");
    const store = journalBranch().resolutionCleanup as TreasuryResolutionCleanupStore;
    const rawEntry = store.entries[`c:${tx}`];
    rawEntry.settlementProofDurable = true;
    rawEntry.markerDischarged = true;
    rawEntry.authorityReleased = true;
    rawEntry.outcomeFinalized = true;
    rawEntry.lineageFinalized = false;
    registerTreasuryResolutionCleanupHandlersForAssembly({
      authorityRelease: () => ({ status: "already_absent", detail: "not_found" }),
      outcomeFinalization: () => ({ status: "already_final", detail: "final" }),
      lineageFinalization: (entry) => entry.lineageId === undefined
        ? { status: "not_applicable", detail: "initial" }
        : { status: "finalized", detail: "ok" },
    });
    resetTreasuryResolutionCleanupHeapCacheForTest();
    const report = recoverTreasuryResolutionCleanupAtTickBoundary();
    expect(report.blocked).toBe(0);
    // matching marker 已被安全补清除；entry 完成删除（不得跳过并留下撒谎状态）。
    expect(readTreasuryWriteFault()).toBeUndefined();
    expect(readTreasuryResolutionCleanupEntry(tx)).toBeUndefined();
  });

  it("authorityReleased=true 但 resolver 仍有 Authority → 恢复重释放并 read-back 确认", () => {
    const tx = "r22ii_lie_authority";
    const write = quarantineTreasuryTransaction({
      transactionId: tx,
      authorityLevel: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      digest: DIGEST_A,
      tick: Game.time,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      adapterSemanticIdentity: "terminal.send@reconciler-semantics-v1",
      phase: "ok_pending_commit_unresolved",
      outcome: "returned_ok",
      settlement: "quarantined",
      deltas: [{ roomName: "W1N57", locationKind: "storage" as const, resource: "energy" as const, delta: -500 }],
      recordedAt: Game.time,
    });
    expect(write.status).toBe("written");
    // 【Remediation IV 六.3】durable 以 authority 重算值为单一来源。
    const durable = readTreasuryQuarantineEntry(tx)?.durableIdentityDigest as string;
    expect(durable).toBeDefined();
    const resolving = writeTreasuryResolutionTombstone({
      transactionId: tx,
      digest: DIGEST_A,
      resolution: "committed",
      stage: "resolving",
      proofLevel: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      durableIdentityDigest: durable,
      actionTick: Game.time,
      settledAtTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      source: "test",
    });
    expect(resolving.status).not.toBe("rejected");
    expect(writeTreasuryResolutionTombstone({ ...readTreasuryResolutionTombstone(tx)!, stage: "final" }).status).not.toBe("rejected");
    // 【Remediation IV 六.5】committed 场景的 pre-release gate 要求
    // release-trusted Receipt（生产时序对齐）。
    expect(commitSettledReceipt(tx, Game.time, {
      digest: DIGEST_A,
      durableIdentityDigest: durable,
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    }).status).not.toBe("rejected");
    const opened = openTreasuryResolutionCleanup({
      transactionId: tx,
      digest: DIGEST_A,
      resolution: "committed",
      identityProfile: "lowlevel",
      proofClass: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      durableIdentityDigest: durable,
    });
    expect(opened.status).toBe("opened");
    const store = journalBranch().resolutionCleanup as TreasuryResolutionCleanupStore;
    // 撒谎：marker/authority/outcome 全 true（marker 确实不在场）。
    const rawEntry = store.entries[`c:${tx}`];
    rawEntry.settlementProofDurable = true;
    rawEntry.markerDischarged = true;
    rawEntry.authorityReleased = true;
    rawEntry.outcomeFinalized = true;
    let authorityReleasedByHandler = false;
    registerTreasuryResolutionCleanupHandlersForAssembly({
      authorityRelease: (entry) => {
        const current = resolveTreasuryUnresolvedAuthority(entry.transactionId);
        if (current.status === "not_found") return { status: "already_absent", detail: "not_found" };
        // 重释放（production handler 的 release + read-back 语义）。
        releaseTreasuryQuarantineEntry(entry.transactionId);
        releaseTreasuryIntentEntry(entry.transactionId);
        authorityReleasedByHandler = true;
        return resolveTreasuryUnresolvedAuthority(entry.transactionId).status === "not_found"
          ? { status: "released", detail: "released + read-back" }
          : { status: "blocked", detail: "read-back 非 not_found" };
      },
      outcomeFinalization: () => ({ status: "already_final", detail: "final" }),
      lineageFinalization: (entry) => entry.lineageId === undefined
        ? { status: "not_applicable", detail: "initial" }
        : { status: "finalized", detail: "ok" },
    });
    resetTreasuryResolutionCleanupHeapCacheForTest();
    const report = recoverTreasuryResolutionCleanupAtTickBoundary();
    expect(report.blocked).toBe(0);
    expect(authorityReleasedByHandler).toBe(true);
    expect(readTreasuryResolutionCleanupEntry(tx)).toBeUndefined();
  });

  it("outcomeFinalized=true 但 final proof 缺失 → 恢复阻断（不得跳过并删除 entry）", () => {
    const tx = "r22ii_lie_outcome";
    const opened = openTreasuryResolutionCleanup({
      transactionId: tx,
      digest: DIGEST_A,
      resolution: "committed",
      identityProfile: "legacy-replay",
      proofClass: "legacy",
    });
    expect(opened.status).toBe("opened");
    const store = journalBranch().resolutionCleanup as TreasuryResolutionCleanupStore;
    const rawEntry = store.entries[`c:${tx}`];
    rawEntry.settlementProofDurable = true;
    rawEntry.markerDischarged = true;
    rawEntry.authorityReleased = true;
    rawEntry.outcomeFinalized = true;
    registerTreasuryResolutionCleanupHandlersForAssembly({
      authorityRelease: () => ({ status: "already_absent", detail: "not_found" }),
      outcomeFinalization: (entry) => readTreasuryResolutionTombstone(entry.transactionId) === undefined
        ? { status: "blocked", detail: "final proof 缺失" }
        : { status: "already_final", detail: "final" },
      lineageFinalization: () => ({ status: "not_applicable", detail: "initial" }),
    });
    resetTreasuryResolutionCleanupHeapCacheForTest();
    const report = recoverTreasuryResolutionCleanupAtTickBoundary();
    expect(report.blocked).toBe(1);
    expect(readTreasuryResolutionCleanupEntry(tx)).toBeDefined();
  });

  it("lineageFinalized=true 但 record 当前代不匹配 → 恢复阻断", () => {
    const tx = "r22ii_lie_lineage";
    const lid = "3333333333333333";
    const child = deriveTreasuryLineageNextChildTransactionId(lid, 1, "r22ii_lie_root");
    const opened = openTreasuryResolutionCleanup({
      transactionId: child,
      digest: DIGEST_A,
      resolution: "committed",
      identityProfile: "lowlevel",
      proofClass: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      durableIdentityDigest: DURABLE_A,
      lineageId: lid,
      lineageGeneration: 1,
      parentTransactionId: "r22ii_lie_root",
      lineageBindingDigest: "4444444444444444",
    });
    expect(opened.status).toBe("opened");
    const store = journalBranch().resolutionCleanup as TreasuryResolutionCleanupStore;
    const rawEntry = store.entries[`c:${child}`];
    rawEntry.settlementProofDurable = true;
    rawEntry.markerDischarged = true;
    rawEntry.authorityReleased = true;
    rawEntry.outcomeFinalized = true;
    rawEntry.lineageFinalized = true;
    // record 属于另一 attempt（generation/当前 attempt 不匹配）。
    const mismatchedRecord = { currentTransactionId: "other_attempt", generation: 2 };
    registerTreasuryResolutionCleanupHandlersForAssembly({
      authorityRelease: () => ({ status: "already_absent", detail: "not_found" }),
      outcomeFinalization: () => ({ status: "already_final", detail: "final" }),
      // 镜像 production facade handler 的 record 当前代一致性检查。
      lineageFinalization: (entry) => {
        if (entry.lineageId === undefined) return { status: "not_applicable", detail: "initial" };
        const recordMatches =
          mismatchedRecord.currentTransactionId === entry.transactionId &&
          mismatchedRecord.generation === entry.lineageGeneration;
        if (!recordMatches) return { status: "blocked", detail: "lineage record 与 entry 当前代不一致" };
        return { status: "already_final", detail: "chain_committed" };
      },
    });
    resetTreasuryResolutionCleanupHeapCacheForTest();
    const report = recoverTreasuryResolutionCleanupAtTickBoundary();
    expect(report.blocked).toBe(1);
    expect(readTreasuryResolutionCleanupEntry(child)).toBeDefined();
  });
});

describe("Remediation II 11：reservation 生命周期", () => {
  beforeEach(() => {
    clearTreasuryPersistenceForTest();
  });

  it("阶段标记拒绝；恢复跳过并计数 pendingReservations；proof_durable open 激活后可推进；revoke 拒绝已激活/已推进", () => {
    const opened = openTreasuryResolutionCleanup({
      transactionId: "r22ii_resv",
      digest: DIGEST_A,
      resolution: "not-executed",
      identityProfile: "legacy-replay",
      proofClass: "legacy",
    });
    expect(opened.status).toBe("opened");
    expect(readTreasuryResolutionCleanupEntry("r22ii_resv")!.settlementProofDurable).toBe(false);
    expect(markTreasuryResolutionCleanupStage("r22ii_resv", "marker_discharge", "already_absent")).toBe(false);
    registerTreasuryResolutionCleanupHandlersForAssembly({
      authorityRelease: () => ({ status: "released", detail: "x" }),
      outcomeFinalization: () => ({ status: "finalized", detail: "x" }),
      lineageFinalization: () => ({ status: "not_applicable", detail: "x" }),
    });
    resetTreasuryResolutionCleanupHeapCacheForTest();
    const skipped = recoverTreasuryResolutionCleanupAtTickBoundary();
    expect(skipped.pendingReservations).toBe(1);
    expect(skipped.examined).toBe(0);
    // 【Remediation IV 十一.1】proof 落盘后：open 不再自动激活（admission
    // 与 proof activation 分离）——激活只能经
    // acknowledgeTreasuryCleanupSettlementProof 的 proof activation 权威。
    const reopened = openTreasuryResolutionCleanup({
      transactionId: "r22ii_resv",
      digest: DIGEST_A,
      resolution: "not-executed",
      identityProfile: "legacy-replay",
      proofClass: "legacy",
    });
    expect(reopened.status).toBe("already_open_reservation");
    expect(readTreasuryResolutionCleanupEntry("r22ii_resv")!.settlementProofDurable).toBe(false);
    // matching final tombstone 落盘后经 activation authority 激活。
    const tombstoneWrite = writeTreasuryResolutionTombstone({
      transactionId: "r22ii_resv",
      digest: DIGEST_A,
      resolution: "not-executed",
      stage: "final",
      proofLevel: "legacy",
      actionTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      reconcilerKind: "terminal.send",
      source: "test",
    });
    expect(tombstoneWrite.status).not.toBe("rejected");
    registerTreasuryCleanupProofProbesForAssembly({
      readTombstone: (transactionId) => readTreasuryResolutionTombstone(transactionId),
      resolutionStoreHealthy: () => peekTreasuryResolutionStoreHealth().healthy,
    });
    const activation = acknowledgeTreasuryCleanupSettlementProof({ transactionId: "r22ii_resv" });
    expect(activation.outcome).toBe("activated");
    const entry = readTreasuryResolutionCleanupEntry("r22ii_resv")!;
    expect(entry.settlementProofDurable).toBe(true);
    expect(markTreasuryResolutionCleanupStage("r22ii_resv", "marker_discharge", "already_absent")).toBe(true);
    // 撤销：durable 事实不符 → refused；正确事实但阶段已推进 → refused。
    expect(revokeTreasuryResolutionCleanup({
      transactionId: "r22ii_resv",
      digest: DIGEST_A,
      resolution: "not-executed",
      identityProfile: "legacy-replay",
      proofClass: "legacy",
      settlementProofDurable: false,
    })).toMatchObject({ status: "refused" });
    expect(revokeTreasuryResolutionCleanup({
      transactionId: "r22ii_resv",
      digest: DIGEST_A,
      resolution: "not-executed",
      identityProfile: "legacy-replay",
      proofClass: "legacy",
      settlementProofDurable: true,
    })).toMatchObject({ status: "refused" });
  });

  it("revoke：零阶段未激活的本次 reservation → revoked；identity 不符 → refused 零状态变化", () => {
    openTreasuryResolutionCleanup({
      transactionId: "r22ii_revoke",
      digest: DIGEST_A,
      resolution: "not-executed",
      identityProfile: "legacy-replay",
      proofClass: "legacy",
    });
    expect(revokeTreasuryResolutionCleanup({
      transactionId: "r22ii_revoke",
      digest: DIGEST_B,
      resolution: "not-executed",
      identityProfile: "legacy-replay",
      proofClass: "legacy",
      settlementProofDurable: false,
    })).toMatchObject({ status: "refused" });
    expect(readTreasuryResolutionCleanupEntry("r22ii_revoke")).toBeDefined();
    expect(revokeTreasuryResolutionCleanup({
      transactionId: "r22ii_revoke",
      digest: DIGEST_A,
      resolution: "not-executed",
      identityProfile: "legacy-replay",
      proofClass: "legacy",
      settlementProofDurable: false,
    })).toMatchObject({ status: "revoked" });
    expect(readTreasuryResolutionCleanupEntry("r22ii_revoke")).toBeUndefined();
  });
});

describe("Remediation II 10：coordinator 的 GRA exact mismatch 表驱动", () => {
  const root = "r22ii_coord_root";
  const rootIdentity = {
    digest: DIGEST_A,
    contractDigest: CONTRACT_A,
    authorizationCohortDigest: COHORT_A,
    durableIdentityDigest: DURABLE_A,
  };
  // lineageId 由 (rootTransactionId, root identity) canonical 派生——与
  // GRA proof 的 root 绑定重算同一算法。
  const lid = computeTreasuryAttemptLineageId(root, rootIdentity);
  const child = deriveTreasuryLineageNextChildTransactionId(lid, 1, root);
  const binding = computeTreasuryLineageBindingDigest({ lineageId: lid, generation: 1, parentTransactionId: root, childTransactionId: child });

  function baseAttempt() {
    return {
      transactionId: child,
      digest: DIGEST_A,
      contractDigest: CONTRACT_A,
      authorizationCohortDigest: COHORT_A,
      durableIdentityDigest: DURABLE_A,
      proofClass: "identity-bound" as const,
      lineageId: lid,
      lineageGeneration: 1,
      parentTransactionId: root,
      lineageBindingDigest: binding,
    };
  }

  function seedCoordinatorScene(): void {
    clearTreasuryPersistenceForTest();
    // final not-executed tr1_ tombstone（与 attempt 完全一致）。
    const tombstone = writeTreasuryResolutionTombstone({
      transactionId: child,
      digest: DIGEST_A,
      resolution: "not-executed",
      stage: "final",
      proofLevel: "identity-bound",
      contractDigest: CONTRACT_A,
      authorizationCohortDigest: COHORT_A,
      durableIdentityDigest: DURABLE_A,
      actionTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      source: "test",
      lineageId: lid,
      lineageGeneration: 1,
      parentTransactionId: root,
      lineageBindingDigest: binding,
    });
    expect(tombstone.status).not.toBe("rejected");
    // matching GRA gen1 proof（root 绑定可重算——lineageId 与 rootIdentityDigest 同源派生）。
    const proof = {
      schemaVersion: 2 as const,
      identityProfile: "modern-contract" as const,
      lineageId: lid,
      rootTransactionId: root,
      rootIdentityDigest: computeTreasuryGenerationRootIdentityDigest(rootIdentity),
      generation: 1,
      transactionId: child,
      parentTransactionId: root,
      bindingDigest: binding,
      digest: DIGEST_A,
      contractDigest: CONTRACT_A,
      authorizationCohortDigest: COHORT_A,
      durableIdentityDigest: DURABLE_A,
      authorityClass: "identity-bound" as const,
      resolution: "not_executed" as const,
      retirement: { lineagePublished: true as const, authorityReleased: true as const, markerCleaned: true as const },
      completedAtTick: Game.time,
    };
    if (!Memory.runtime) Memory.runtime = {} as never;
    const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
    if (!runtime.treasury) runtime.treasury = {};
    runtime.treasury.generationRetirementProofs = {
      version: TREASURY_GENERATION_RETIREMENT_VERSION,
      entries: { [`gr:${lid}:000001`]: proof },
      entryCount: 1,
      updatedAt: Game.time,
    };
    resetTreasuryGenerationRetirementRuntimeForTest();
    resetTreasuryResolutionStoreForTest();
    // coordinator health sources 装配（production 由 facade 注册）。
    registerTreasurySettlementSummaryHealthSourceForAssembly(() => ({ healthy: true, detail: null }));
    registerTreasurySettlementLineageHealthSourceForAssembly(() => ({ healthy: true, detail: null }));
  }

  it("基线：完整一致 → not_executed_verified；opposite absence 不阻断", () => {
    seedCoordinatorScene();
    const verdict = verifyTreasuryCurrentSettlement({ outcome: "not-executed", attempt: baseAttempt(), identityProfile: "modern-contract" });
expect(verdict.verdict).toBe("not_executed_verified");
    const absence = verifyTreasuryOppositeProofAbsence({ outcome: "committed", attempt: baseAttempt() });
    expect(absence.blocked).toBe(true); // matching GRA not-executed proof 阻断 committed
  });

  it.each([
    ["generation", { lineageGeneration: 2 }],
    ["parent", { parentTransactionId: "other_parent" }],
    ["binding", { lineageBindingDigest: "6666666666666666" }],
    ["contract", { contractDigest: "7777777777777777" }],
    ["cohort", { authorizationCohortDigest: "8888888888888888" }],
    ["durable identity", { durableIdentityDigest: "9999999999999999" }],
    ["proof class/profile", { proofClass: "lowlevel" as const }],
    ["digest", { digest: "abcdefabcdefabcd" }],
  ] as const)("digest/lineageId 相同但 %s 篡改 → 拒绝（不 verified、opposite absence retained）", (_label, tamper) => {
    seedCoordinatorScene();
    const attempt = { ...baseAttempt(), ...tamper };
    const verdict = verifyTreasuryCurrentSettlement({ outcome: "not-executed", attempt, identityProfile: "modern-contract" });
    expect(verdict.verdict).not.toBe("not_executed_verified");
    expect(["conflict", "store_unhealthy", "insufficient"]).toContain(verdict.verdict);
    const absence = verifyTreasuryOppositeProofAbsence({ outcome: "committed", attempt });
    expect(absence.blocked).toBe(true);
  });
});
