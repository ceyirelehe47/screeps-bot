/**
 * 【第十五轮】Authority Class Semantics 测试。
 *
 * 覆盖：
 * - class-specific same-ID 幂等：legacy（不同 digest 的空 durable → conflict、
 *   同 digest 不同 postings → conflict、完整 signature → 幂等）、forensic
 *   （reason / attempt facts 不同 → conflict、provenance 相同 → 幂等、
 *   provenance 缺失 → 不视作 same）、modern（等级 / durable / cohort /
 *   contract）、lowlevel（受控 source / durable）——比较器矩阵 + 三 store
 *   集成；不再依赖空 durable digest 匹配；
 * - forensic provenance：migration-derived forensic 不被普通 beginTick 释放、
 *   无 provenance 保持隔离、legacy/forensic proof 不释放 modern/lowlevel
 *   authority、诊断保留来源；
 * - publication store-specific 语义：quarantine phase / forensic reason /
 *   legacyV1 篡改回滚、authorization-fault faultTick / rollbackConfirmed 篡改
 *   回滚、intent 非法 outcome/settlement 组合回滚、bookkeeping 恢复、失败
 *   路径零副作用；
 * - deep snapshot：读取快照的 cohort revisions / forensic / descriptor /
 *   cohort legs / tombstone provenance / list 嵌套对象全部封闭（修改不影响
 *   Memory）；
 * - lowlevel provenance：未知 source 拒绝、runtime 内部缺省通过、migrated
 *   仅迁移生成、test-only 不得进入 production store、旧任意 source 迁移 →
 *   forensic、source 变化 → same-ID conflict。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest, commitSettledReceipt } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  readTreasuryIntentEntry,
  resetTreasuryIntentRuntimeForTest,
  writeTreasuryIntentEntry,
} from "@/runtime/treasury/intents";
import {
  listTreasuryQuarantineEntries,
  quarantineTreasuryTransaction,
  readTreasuryQuarantineEntry,
  resetTreasuryQuarantineRuntimeForTest,
  treasuryForensicQuarantineDiagnostics,
} from "@/runtime/treasury/quarantine";
import {
  ensureTreasuryResolutionStoreValidated,
  readTreasuryResolutionStoreCounters,
  readTreasuryResolutionTombstone,
  recoverStagedResolutions,
  resetTreasuryResolutionStoreForTest,
  writeTreasuryResolutionTombstone,
} from "@/runtime/treasury/resolutionStore";
import {
  readTreasuryAuthorizationFaultEntry,
  resetTreasuryAuthorizationFaultRuntimeForTest,
  writeTreasuryAuthorizationFaultEntry,
} from "@/runtime/treasury/authorizationFaults";
import {
  classifyTreasuryAuthorityLevelForMigration,
  validateTreasuryLowlevelSourceField,
  TREASURY_LOWLEVEL_SOURCE_MIGRATED,
  TREASURY_LOWLEVEL_SOURCE_RUNTIME,
  TREASURY_LOWLEVEL_SOURCE_TEST,
} from "@/runtime/treasury/authorityLevel";
import {
  compareTreasuryAuthoritySameIdIdentity,
  type TreasuryAuthorityIdempotenceEntryView,
} from "@/runtime/treasury/authorityIdempotence";
import {
  setTreasuryDurablePublicationFaultForTest,
  readTreasuryDurablePublicationCounters,
} from "@/runtime/treasury/durablePublication";
import {
  validateTreasuryForensicProvenanceShape,
  TREASURY_FORENSIC_PROVENANCE_PROTOCOL,
} from "@/runtime/treasury/forensicProvenance";
import { computeTreasuryDurableIdentityDigest } from "@/runtime/treasury/durableIdentity";
import { computeTreasuryAuthorizationCohortDigest } from "@/runtime/treasury/authorization";
import { installRooms, type RoomSpec } from "@mock/treasury";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 5_000 },
  },
];

const BASE_POSTINGS = [{ roomName: "W1N57", locationKind: "storage" as const, resource: "energy" as const, delta: -500 }];
const ALT_POSTINGS = [{ roomName: "W1N57", locationKind: "storage" as const, resource: "energy" as const, delta: -501 }];

function makeService(): TreasuryTestService {
  const rooms = installRooms(ROOMS);
  const service = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
  service.beginTick();
  return treasuryTestService(service);
}

function lowlevelIdentity(transactionId: string, digest: string, postings = BASE_POSTINGS): string {
  return computeTreasuryDurableIdentityDigest({
    transactionId,
    digest,
    actionKind: "terminal.send",
    postings,
    source: "test",
    adapterSemanticIdentity: "terminal.send@reconciler-semantics-v1",
  });
}

function buildCohort(transactionId: string) {
  const cohort = {
    ownerIdentity: "game-object:stor-1",
    policyId: "no-reserve",
    policyVersion: 1,
    policyRegistrationId: "1111111111111111",
    policyDecisionDigest: "allow",
    emergencyOverride: false,
    epochSeq: 1,
    revisions: {
      commitmentRevision: 1,
      projectionRevision: 1,
      quarantineRevision: 0,
      intentRevision: 0,
      reservationStoreRevision: 1,
    },
    adapterRegistrationId: "2222222222222222",
    adapterSemanticIdentity: "terminal.send@reconciler-semantics-v1",
    contractId: `contract:${transactionId}`,
    contractDigest: "3333333333333333",
    transactionId,
    authorizationLegDigests: ["4444444444444444"],
    receiverCapacityDigest: "none",
    issuedTick: Game.time,
    authorizationDigest: "5555555555555555",
  };
  const cohortDigest = computeTreasuryAuthorizationCohortDigest(cohort);
  const structureFacts = [
    { bindingKind: "governed_location" as const, role: "source" as const, roomName: "W1N57", locationKind: "storage" as const, structureId: "stor-1", required: true, version: 1 },
  ];
  const durableIdentity = computeTreasuryDurableIdentityDigest({
    transactionId,
    digest: "0123456789abcdef",
    actionKind: "terminal.send",
    postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
    source: "test",
    contractId: cohort.contractId,
    contractDigest: cohort.contractDigest,
    adapterRegistrationId: cohort.adapterRegistrationId,
    adapterSemanticIdentity: cohort.adapterSemanticIdentity,
    durablePayload: "dp",
    durablePayloadVersion: 1,
    structureFacts,
    authorizationCohortDigest: cohortDigest,
    ownerIdentity: cohort.ownerIdentity,
    policyIdentity: "no-reserve@v1:allow",
  });
  return { cohort, cohortDigest, structureFacts, durableIdentity };
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  setTreasuryDurablePublicationFaultForTest(null);
});

afterEach(() => {
  setTreasuryDurablePublicationFaultForTest(null);
});

// ── 一、class-specific same-ID 幂等（比较器矩阵） ────────────────────────────

describe("authority-class same-ID 幂等矩阵（第十五轮第九节）", () => {
  const digest = "0123456789abcdef";
  const foreignDigest = "1111111111111111";

  function legacyView(overrides: Partial<TreasuryAuthorityIdempotenceEntryView> = {}): TreasuryAuthorityIdempotenceEntryView {
    return {
      transactionId: "tx",
      authorityLevel: "legacy",
      digest,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
      ...overrides,
    };
  }

  it("legacy 同 ID、不同 digest、durable 均为空：identity conflict（不返回 already_present）", () => {
    const verdict = compareTreasuryAuthoritySameIdIdentity(
      legacyView(),
      legacyView({ digest: foreignDigest }),
      "legacy",
    );
    expect(verdict.verdict).toBe("conflict");
  });

  it("legacy 同 ID、同 digest 但 postings 不同：conflict", () => {
    const verdict = compareTreasuryAuthoritySameIdIdentity(
      legacyView(),
      legacyView({ postings: ALT_POSTINGS.map((leg) => ({ ...leg })) }),
      "legacy",
    );
    expect(verdict.verdict).toBe("conflict");
  });

  it("legacy 完整 signature 相同：幂等（same）", () => {
    const verdict = compareTreasuryAuthoritySameIdIdentity(legacyView(), legacyView(), "legacy");
    expect(verdict.verdict).toBe("same");
  });

  it("forensic 同 ID、reason 不同：conflict", () => {
    const base = {
      authorityLevel: "forensic" as const,
      transactionId: "tx",
      digest,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
      outcome: "started_unknown",
      phase: "executing_at_end_tick",
    };
    const verdict = compareTreasuryAuthoritySameIdIdentity(
      { ...base, forensic: { reason: "intent_missing_fallback", detail: "a" } },
      { ...base, forensic: { reason: "authority_write_failed", detail: "a" } },
      "forensic",
    );
    expect(verdict.verdict).toBe("conflict");
  });

  it("forensic 同 ID、已知 attempt facts 不同：conflict", () => {
    const base = {
      authorityLevel: "forensic" as const,
      transactionId: "tx",
      digest,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
      outcome: "started_unknown",
      phase: "executing_at_end_tick",
      forensic: { reason: "intent_missing_fallback", detail: "a" },
    };
    const verdict = compareTreasuryAuthoritySameIdIdentity(
      { ...base, durableIdentityDigest: digest },
      { ...base, durableIdentityDigest: foreignDigest },
      "forensic",
    );
    expect(verdict.verdict).toBe("conflict");
  });

  it("forensic 完整 provenance 相同：幂等；provenance 缺失：不视作 same", () => {
    const base = {
      authorityLevel: "forensic" as const,
      transactionId: "tx",
      digest,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
      outcome: "started_unknown",
      phase: "executing_at_end_tick",
      forensic: { reason: "intent_missing_fallback", detail: "a" },
    };
    expect(compareTreasuryAuthoritySameIdIdentity(base, { ...base, forensic: { ...base.forensic } }, "forensic").verdict).toBe("same");
    const missing = compareTreasuryAuthoritySameIdIdentity(base, { ...base, forensic: undefined }, "forensic");
    expect(missing.verdict).not.toBe("same");
  });

  it("modern 同 ID 但 authority level 不同：conflict；lowlevel source 不同：conflict", () => {
    const modern = {
      authorityLevel: "modern" as const,
      transactionId: "tx",
      digest,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
      contractId: "c1",
      contractDigest: digest,
      authorizationCohortDigest: digest,
      durableIdentityDigest: digest,
    };
    expect(
      compareTreasuryAuthoritySameIdIdentity(modern, { ...modern, authorityLevel: "lowlevel" }, "cross").verdict,
    ).toBe("conflict");
    const lowlevel = {
      authorityLevel: "lowlevel" as const,
      transactionId: "tx",
      digest,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      durableIdentityDigest: digest,
    };
    expect(
      compareTreasuryAuthoritySameIdIdentity(
        lowlevel,
        { ...lowlevel, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_MIGRATED },
        "lowlevel",
      ).verdict,
    ).toBe("conflict");
  });

  it("modern durable/cohort 缺失或不同：insufficient / conflict；完整一致：same", () => {
    const modern = {
      authorityLevel: "modern" as const,
      transactionId: "tx",
      digest,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
      contractId: "c1",
      contractDigest: digest,
      authorizationCohortDigest: digest,
      durableIdentityDigest: digest,
    };
    expect(compareTreasuryAuthoritySameIdIdentity(modern, { ...modern, durableIdentityDigest: undefined }, "m").verdict).toBe("insufficient");
    expect(
      compareTreasuryAuthoritySameIdIdentity(modern, { ...modern, authorizationCohortDigest: foreignDigest }, "m").verdict,
    ).toBe("conflict");
    expect(compareTreasuryAuthoritySameIdIdentity(modern, { ...modern }, "m").verdict).toBe("same");
  });
});

// ── 二、三 store 的 same-ID 幂等集成 ────────────────────────────────────────

describe("store 集成：class 幂等规则应用于三 store（第十五轮第九节）", () => {
  const digest = "0123456789abcdef";

  it("quarantine legacy：同 ID 不同 digest（durable 均空）→ identity_conflict；完整 signature → already_present", () => {
    const base = {
      transactionId: "q_legacy",
      authorityLevel: "legacy" as const,
      digest,
      tick: Game.time,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick" as const,
      deltas: BASE_POSTINGS.map((leg) => ({ ...leg })),
      recordedAt: Game.time,
      outcome: "started_unknown" as const,
      settlement: "quarantined" as const,
    };
    expect(quarantineTreasuryTransaction(base).status).toBe("written");
    const conflict = quarantineTreasuryTransaction({ ...base, digest: "1111111111111111" });
    expect(conflict.status).toBe("rejected");
    if (conflict.status === "rejected") expect(conflict.reason).toBe("identity_conflict");
    const idempotent = quarantineTreasuryTransaction(base);
    expect(idempotent.status).toBe("already_present");
  });

  it("intent lowlevel：同 ID、受控 source 不同（runtime vs migrated）→ identity_conflict", () => {
    const base = {
      transactionId: "i_lowlevel",
      authorityLevel: "lowlevel" as const,
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      digest,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
      outcome: "not_started" as const,
      settlement: "ready" as const,
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
    };
    expect(writeTreasuryIntentEntry(base).status).toBe("written");
    const conflict = writeTreasuryIntentEntry({ ...base, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_MIGRATED });
    expect(conflict.status).toBe("rejected");
    if (conflict.status === "rejected") expect(conflict.reason).toBe("identity_conflict");
    expect(writeTreasuryIntentEntry(base).status).toBe("already_present");
  });

  it("intent modern（完整事实）→ 同 ID 改写为 lowlevel：跨等级 identity_conflict", () => {
    const transactionId = "i_modern";
    const { cohort, cohortDigest, structureFacts, durableIdentity } = buildCohort(transactionId);
    const write = writeTreasuryIntentEntry({
      transactionId,
      authorityLevel: "modern",
      digest,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      contractId: cohort.contractId,
      contractDigest: cohort.contractDigest,
      adapterVersion: 1,
      adapterRegistrationId: cohort.adapterRegistrationId,
      adapterSemanticIdentity: cohort.adapterSemanticIdentity,
      durablePayload: "dp",
      durablePayloadVersion: 1,
      structureFacts,
      ownerIdentity: cohort.ownerIdentity,
      policyIdentity: "no-reserve@v1:allow",
      authorizationCohort: cohort,
      authorizationCohortDigest: cohortDigest,
      durableIdentityDigest: durableIdentity,
      postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
      outcome: "returned_ok",
      settlement: "finalized",
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
    });
    expect(write.status).toBe("written");
    const conflict = writeTreasuryIntentEntry({
      transactionId,
      authorityLevel: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      digest,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
      outcome: "returned_ok",
      settlement: "faulted",
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
    });
    expect(conflict.status).toBe("rejected");
    if (conflict.status === "rejected") expect(conflict.reason).toBe("identity_conflict");
  });

  it("authorization-fault：同 ID 同事实 → already_present；faultTick 不同 → identity_conflict", () => {
    const base = {
      transactionId: "af_tx",
      authorityLevel: "lowlevel" as const,
      digest,
      actionKind: "authorization.redeem",
      source: "test",
      postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
      faultTick: Game.time,
      outcome: "not_started" as const,
      rollbackConfirmed: true as const,
    };
    expect(writeTreasuryAuthorizationFaultEntry(base).status).toBe("written");
    expect(writeTreasuryAuthorizationFaultEntry(base).status).toBe("already_present");
    const conflict = writeTreasuryAuthorizationFaultEntry({ ...base, faultTick: Game.time + 1 });
    expect(conflict.status).toBe("rejected");
    if (conflict.status === "rejected") expect(conflict.reason).toBe("identity_conflict");
  });
});

// ── 三、forensic provenance ──────────────────────────────────────────────────

describe("forensic provenance（第十五轮第八节）", () => {
  const digest = "0123456789abcdef";

  it("migration-derived forensic proof + forensic authority：普通 beginTick recovery 不释放", () => {
    const identity = lowlevelIdentity("fp_migrated", digest);
    // forensic authority（隔离容器——recoveryCoordinator 防御直写形态）。
    const forensicWrite = quarantineTreasuryTransaction({
      transactionId: "fp_migrated",
      authorityLevel: "forensic",
      digest,
      tick: Game.time,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick",
      deltas: BASE_POSTINGS.map((leg) => ({ ...leg })),
      recordedAt: Game.time,
      outcome: "started_unknown",
      settlement: "quarantined",
      forensic: { reason: "intent_missing_fallback", detail: "test fixture" },
    });
    expect(forensicWrite.status).toBe("written");
    // 【第十六轮第九节】forensic 不得处于普通 resolving——migration-derived
    // forensic resolving 是非法持久状态（写入被语义矩阵拒绝）。
    const tombstoneWrite = writeTreasuryResolutionTombstone({
      transactionId: "fp_migrated",
      digest,
      resolution: "committed",
      stage: "resolving",
      proofLevel: "forensic",
      durableIdentityDigest: identity,
      actionTick: Game.time,
      settledAtTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      reconcilerKind: "terminal.send",
      source: "test",
    });
    expect(tombstoneWrite.status).toBe("rejected"); // forensic resolving 非法持久状态

    // forensic resolving 写入被拒（无 tombstone）→ recovery 无待处理项；
    // forensic authority 不被任何自动路径释放（O(1) 空闲快路径）。
    const report = recoverStagedResolutions();
    expect(report.idleFastPath).toBe(true);
    expect(report.completed).toBe(0);
    expect(readTreasuryQuarantineEntry("fp_migrated")).toBeDefined();
    expect(readTreasuryResolutionTombstone("fp_migrated")).toBeUndefined();
  });

  it("legacy proof 不释放 legacy authority（普通自动 recovery 释放矩阵收敛）", () => {
    const legacyWrite = quarantineTreasuryTransaction({
      transactionId: "fp_legacy",
      authorityLevel: "legacy",
      digest,
      tick: Game.time,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick",
      deltas: BASE_POSTINGS.map((leg) => ({ ...leg })),
      recordedAt: Game.time,
      outcome: "started_unknown",
      settlement: "quarantined",
    });
    expect(legacyWrite.status).toBe("written");
    const tombstoneWrite = writeTreasuryResolutionTombstone({
      transactionId: "fp_legacy",
      digest,
      resolution: "not-executed",
      stage: "final",
      proofLevel: "legacy",
      actionTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      reconcilerKind: "terminal.send",
      source: "test",
    });
    expect(tombstoneWrite.status).toBe("written");

    const report = recoverStagedResolutions();
    expect(report.completedRelease).toBe(0);
    expect(readTreasuryQuarantineEntry("fp_legacy")).toBeDefined();
    expect(report.identityInsufficient).toBeGreaterThanOrEqual(1);
  });

  it("forensic provenance 形状校验：协议/acknowledgement/管理身份/attempt 全显式", () => {
    const valid = {
      protocol: TREASURY_FORENSIC_PROVENANCE_PROTOCOL,
      acknowledgement: "explicit_management",
      confirmedBy: "operator:test",
      attempt: { digest },
      confirmedAtTick: Game.time,
      source: "test",
      allowAutomaticCompletion: false,
    };
    expect(validateTreasuryForensicProvenanceShape(valid)).toBeNull();
    expect(validateTreasuryForensicProvenanceShape({ ...valid, protocol: "unknown@v9" })).toContain("协议");
    expect(validateTreasuryForensicProvenanceShape({ ...valid, acknowledgement: "auto" })).toContain("acknowledgement");
    expect(validateTreasuryForensicProvenanceShape({ ...valid, confirmedBy: undefined })).toContain("管理操作身份");
    expect(validateTreasuryForensicProvenanceShape({ ...valid, attempt: undefined })).toContain("attempt");
  });

  it("forensic 诊断保留来源（reason/detail 可见）", () => {
    const write = quarantineTreasuryTransaction({
      transactionId: "fp_diag",
      authorityLevel: "forensic",
      digest,
      tick: Game.time,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick",
      deltas: BASE_POSTINGS.map((leg) => ({ ...leg })),
      recordedAt: Game.time,
      outcome: "started_unknown",
      settlement: "quarantined",
      forensic: { reason: "intent_missing_fallback", detail: "diagnostic source" },
    });
    expect(write.status).toBe("written");
    const diagnostics = treasuryForensicQuarantineDiagnostics();
    const found = diagnostics.find((item) => item.transactionId === "fp_diag");
    expect(found).toBeDefined();
    expect(found?.reason).toBe("intent_missing_fallback");
    expect(found?.detail).toBe("diagnostic source");
  });
});

// ── 四、publication store-specific 语义验证 ─────────────────────────────────

describe("publication store-specific 语义验证（第十五轮第十节）", () => {
  const digest = "0123456789abcdef";

  function quarantineBase(transactionId: string) {
    return {
      transactionId,
      authorityLevel: "lowlevel" as const,
      digest,
      tick: Game.time,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick" as const,
      deltas: BASE_POSTINGS.map((leg) => ({ ...leg })),
      recordedAt: Game.time,
      outcome: "started_unknown" as const,
      settlement: "quarantined" as const,
    };
  }

  function tamperAfterPublish(mutate: () => void): void {
    setTreasuryDurablePublicationFaultForTest(() => {
      mutate();
    });
  }

  function entryCountOf(store: "quarantine" | "intents" | "authorizationFaults"): number {
    const treasury = (Memory.runtime as unknown as { treasury?: Record<string, { entryCount?: number }> }).treasury;
    return treasury?.[store]?.entryCount ?? 0;
  }

  it("quarantine 发布后篡改 phase（digest 未变）：read-back 失败并回滚", () => {
    tamperAfterPublish(() => {
      const entries = (Memory.runtime as unknown as { treasury?: { quarantine?: { entries?: Record<string, { phase?: string }> } } })
        .treasury?.quarantine?.entries;
      const key = Object.keys(entries ?? {}).find((k) => k.includes("pub_phase"));
      if (key !== undefined && entries) entries[key].phase = "ok_pending_commit_unresolved";
    });
    const faultsBefore = readTreasuryDurablePublicationCounters().readBackFaults;
    const result = quarantineTreasuryTransaction(quarantineBase("pub_phase"));
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe("store_fatal");
    expect(readTreasuryQuarantineEntry("pub_phase")).toBeUndefined();
    expect(entryCountOf("quarantine")).toBe(0);
    expect(readTreasuryDurablePublicationCounters().readBackFaults).toBe(faultsBefore + 1);
  });

  it("quarantine 发布后篡改 forensic reason：回滚", () => {
    tamperAfterPublish(() => {
      const entries = (Memory.runtime as unknown as { treasury?: { quarantine?: { entries?: Record<string, { forensic?: { reason: string; detail: string } }> } } })
        .treasury?.quarantine?.entries;
      const key = Object.keys(entries ?? {}).find((k) => k.includes("pub_forensic"));
      if (key !== undefined && entries) {
        entries[key]!.forensic = { reason: "tampered_reason", detail: "x" };
      }
    });
    const result = quarantineTreasuryTransaction({
      ...quarantineBase("pub_forensic"),
      authorityLevel: "forensic",
      forensic: { reason: "intent_missing_fallback", detail: "original" },
    });
    expect(result.status).toBe("rejected");
    expect(readTreasuryQuarantineEntry("pub_forensic")).toBeUndefined();
    expect(entryCountOf("quarantine")).toBe(0);
  });

  it("quarantine 发布后篡改 legacyV1：回滚", () => {
    tamperAfterPublish(() => {
      const entries = (Memory.runtime as unknown as { treasury?: { quarantine?: { entries?: Record<string, { legacyV1?: boolean }> } } })
        .treasury?.quarantine?.entries;
      const key = Object.keys(entries ?? {}).find((k) => k.includes("pub_legacy"));
      if (key !== undefined && entries) entries[key]!.legacyV1 = true;
    });
    const result = quarantineTreasuryTransaction(quarantineBase("pub_legacy"));
    expect(result.status).toBe("rejected");
    expect(entryCountOf("quarantine")).toBe(0);
  });

  it("authorization-fault 发布后篡改 faultTick：回滚且 updatedAt 恢复原值", () => {
    // 先建 store 并记录原 updatedAt（写第一条成功 entry 建立基线）。
    const first = writeTreasuryAuthorizationFaultEntry({
      transactionId: "pub_fault_baseline",
      authorityLevel: "lowlevel",
      digest,
      actionKind: "authorization.redeem",
      source: "test",
      postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
      faultTick: Game.time,
      outcome: "not_started",
      rollbackConfirmed: true,
    });
    expect(first.status).toBe("written");
    const previousUpdatedAt = (Memory.runtime as unknown as { treasury?: { authorizationFaults?: { updatedAt: number } } }).treasury
      ?.authorizationFaults?.updatedAt as number;
    tamperAfterPublish(() => {
      const entries = (Memory.runtime as unknown as { treasury?: { authorizationFaults?: { entries?: Record<string, { faultTick?: number }> } } })
        .treasury?.authorizationFaults?.entries;
      const key = Object.keys(entries ?? {}).find((k) => k.includes("pub_fault_tick"));
      if (key !== undefined && entries) entries[key]!.faultTick = Game.time + 99;
    });
    const result = writeTreasuryAuthorizationFaultEntry({
      transactionId: "pub_fault_tick",
      authorityLevel: "lowlevel",
      digest,
      actionKind: "authorization.redeem",
      source: "test",
      postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
      faultTick: Game.time,
      outcome: "not_started",
      rollbackConfirmed: true,
    });
    expect(result.status).toBe("rejected");
    expect(readTreasuryAuthorizationFaultEntry("pub_fault_tick")).toBeUndefined();
    // bookkeeping 恢复：entryCount 回到基线、updatedAt 恢复原值（不再错写 Game.time）。
    expect(entryCountOf("authorizationFaults")).toBe(1);
    const currentUpdatedAt = (Memory.runtime as unknown as { treasury?: { authorizationFaults?: { updatedAt: number } } }).treasury
      ?.authorizationFaults?.updatedAt as number;
    expect(currentUpdatedAt).toBe(previousUpdatedAt);
  });

  it("authorization-fault 发布后 rollbackConfirmed 改为 false：回滚（store 语义 validator 拒绝）", () => {
    tamperAfterPublish(() => {
      const entries = (Memory.runtime as unknown as { treasury?: { authorizationFaults?: { entries?: Record<string, { rollbackConfirmed?: boolean }> } } })
        .treasury?.authorizationFaults?.entries;
      const key = Object.keys(entries ?? {}).find((k) => k.includes("pub_rb"));
      if (key !== undefined && entries) entries[key]!.rollbackConfirmed = false;
    });
    const result = writeTreasuryAuthorizationFaultEntry({
      transactionId: "pub_rb",
      authorityLevel: "lowlevel",
      digest,
      actionKind: "authorization.redeem",
      source: "test",
      postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
      faultTick: Game.time,
      outcome: "not_started",
      rollbackConfirmed: true,
    });
    expect(result.status).toBe("rejected");
    expect(entryCountOf("authorizationFaults")).toBe(0);
  });

  it("intent 发布后制造非法 outcome/settlement 组合：回滚", () => {
    tamperAfterPublish(() => {
      const entries = (Memory.runtime as unknown as { treasury?: { intents?: { entries?: Record<string, { settlement?: string }> } } })
        .treasury?.intents?.entries;
      const key = Object.keys(entries ?? {}).find((k) => k.includes("pub_intent"));
      if (key !== undefined && entries) entries[key]!.settlement = "finalized";
    });
    const result = writeTreasuryIntentEntry({
      transactionId: "pub_intent",
      authorityLevel: "lowlevel",
      digest,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
      outcome: "not_started",
      settlement: "ready",
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
    });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe("store_fatal");
    expect(readTreasuryIntentEntry("pub_intent")).toBeUndefined();
    expect(entryCountOf("intents")).toBe(0);
  });
});

// ── 五、deep snapshot 封闭 ───────────────────────────────────────────────────

describe("authority 读取深冻结（第十五轮第十一节）", () => {
  const digest = "0123456789abcdef";

  it("修改 read quarantine 的 cohort.revisions / forensic 对象：Memory 不变", () => {
    const transactionId = "snap_q";
    const { cohort, cohortDigest, structureFacts, durableIdentity } = buildCohort(transactionId);
    expect(
      quarantineTreasuryTransaction({
        transactionId,
        authorityLevel: "modern",
        digest,
        tick: Game.time,
        kind: "terminal.send",
        actionKind: "terminal.send",
        source: "test",
        phase: "executing_at_end_tick",
        deltas: BASE_POSTINGS.map((leg) => ({ ...leg })),
        recordedAt: Game.time,
        outcome: "started_unknown",
        settlement: "quarantined",
        contractId: cohort.contractId,
        contractDigest: cohort.contractDigest,
        adapterVersion: 1,
        adapterRegistrationId: cohort.adapterRegistrationId,
        adapterSemanticIdentity: cohort.adapterSemanticIdentity,
        durablePayload: "dp",
        durablePayloadVersion: 1,
        structureFacts,
        ownerIdentity: cohort.ownerIdentity,
        policyIdentity: "no-reserve@v1:allow",
        authorizationCohort: cohort,
        authorizationCohortDigest: cohortDigest,
        durableIdentityDigest: durableIdentity,
      }).status,
    ).toBe("written");
    const before = JSON.stringify(readTreasuryQuarantineEntry(transactionId));
    const snapshot = readTreasuryQuarantineEntry(transactionId);
    expect(snapshot).toBeDefined();
    const cohortSnapshot = (snapshot as unknown as { authorizationCohort?: { revisions: Record<string, number> } })
      .authorizationCohort;
    expect(cohortSnapshot).toBeDefined();
    // 深冻结生效：严格模式写入抛错（快照与 Memory 无共享可变引用）。
    expect(() => {
      if (cohortSnapshot) cohortSnapshot.revisions.commitmentRevision = 999;
    }).toThrow();
    expect(JSON.stringify(readTreasuryQuarantineEntry(transactionId))).toBe(before);

    // forensic 对象同样封闭。
    expect(
      quarantineTreasuryTransaction({
        transactionId: "snap_qf",
        authorityLevel: "forensic",
        digest,
        tick: Game.time,
        kind: "terminal.send",
        actionKind: "terminal.send",
        source: "test",
        phase: "executing_at_end_tick",
        deltas: BASE_POSTINGS.map((leg) => ({ ...leg })),
        recordedAt: Game.time,
        outcome: "started_unknown",
        settlement: "quarantined",
        forensic: { reason: "intent_missing_fallback", detail: "x" },
      }).status,
    ).toBe("written");
    const forensicBefore = JSON.stringify(readTreasuryQuarantineEntry("snap_qf"));
    const forensicSnapshot = readTreasuryQuarantineEntry("snap_qf") as unknown as { forensic?: { reason: string } };
    expect(() => {
      if (forensicSnapshot.forensic) forensicSnapshot.forensic.reason = "tampered";
    }).toThrow();
    expect(JSON.stringify(readTreasuryQuarantineEntry("snap_qf"))).toBe(forensicBefore);
  });

  it("修改 read authorization-fault 的 structure descriptor / cohort legs：Memory 不变", () => {
    const transactionId = "snap_af";
    const { cohort, cohortDigest, structureFacts } = buildCohort(transactionId);
    // fault authority 无 durable payload——durable identity 以其实际事实集重算。
    const faultIdentity = computeTreasuryDurableIdentityDigest({
      transactionId,
      digest: "0123456789abcdef",
      actionKind: "authorization.redeem",
      postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
      source: "test",
      contractId: cohort.contractId,
      contractDigest: cohort.contractDigest,
      adapterRegistrationId: cohort.adapterRegistrationId,
      adapterSemanticIdentity: cohort.adapterSemanticIdentity,
      structureFacts,
      authorizationCohortDigest: cohortDigest,
      ownerIdentity: cohort.ownerIdentity,
      policyIdentity: "no-reserve@v1:allow",
    });
    expect(
      writeTreasuryAuthorizationFaultEntry({
        transactionId,
        authorityLevel: "modern",
        digest,
        actionKind: "authorization.redeem",
        source: "test",
        postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
        faultTick: Game.time,
        outcome: "not_started",
        rollbackConfirmed: true,
        contractId: cohort.contractId,
        contractDigest: cohort.contractDigest,
        adapterVersion: 1,
        adapterRegistrationId: cohort.adapterRegistrationId,
        adapterSemanticIdentity: cohort.adapterSemanticIdentity,
        structureFacts,
        ownerIdentity: cohort.ownerIdentity,
        policyIdentity: "no-reserve@v1:allow",
        authorizationCohort: cohort,
        authorizationCohortDigest: cohortDigest,
        durableIdentityDigest: faultIdentity,
      }).status,
    ).toBe("written");
    const before = JSON.stringify(readTreasuryAuthorizationFaultEntry(transactionId));
    const snapshot = readTreasuryAuthorizationFaultEntry(transactionId);
    expect(snapshot).toBeDefined();
    const descriptor = (snapshot as unknown as { structureFacts?: { version?: number }[] }).structureFacts;
    expect(() => {
      if (descriptor && descriptor[0]) descriptor[0].version = 999;
    }).toThrow();
    const legs = (snapshot as unknown as { authorizationCohort?: { authorizationLegDigests: string[] } }).authorizationCohort;
    expect(() => {
      if (legs) legs.authorizationLegDigests[0] = "tampered";
    }).toThrow();
    expect(JSON.stringify(readTreasuryAuthorizationFaultEntry(transactionId))).toBe(before);
  });

  it("修改 read resolution tombstone 的嵌套 forensic provenance：Memory 不变", () => {
    const provenance = {
      protocol: TREASURY_FORENSIC_PROVENANCE_PROTOCOL,
      acknowledgement: "explicit_management" as const,
      confirmedBy: "operator:test",
      attempt: { digest: "0123456789abcdef" },
      confirmedAtTick: Game.time,
      source: "test",
      allowAutomaticCompletion: false,
    };
    expect(
      writeTreasuryResolutionTombstone({
        transactionId: "snap_tomb",
        digest: "0123456789abcdef",
        resolution: "not-executed",
        stage: "final",
        proofLevel: "forensic",
        forensicProvenance: provenance,
        actionTick: Game.time,
        observationTick: Game.time,
        resolvedAtTick: Game.time,
        reconcilerKind: "terminal.send",
        source: "test",
      }).status,
    ).toBe("written");
    const before = JSON.stringify(readTreasuryResolutionTombstone("snap_tomb"));
    const snapshot = readTreasuryResolutionTombstone("snap_tomb") as unknown as { forensicProvenance?: { confirmedBy: string } };
    expect(() => {
      if (snapshot.forensicProvenance) snapshot.forensicProvenance.confirmedBy = "tampered";
    }).toThrow();
    expect(JSON.stringify(readTreasuryResolutionTombstone("snap_tomb"))).toBe(before);
  });

  it("list API 嵌套对象同样封闭", () => {
    const transactionId = "snap_list";
    const { cohort, cohortDigest, structureFacts, durableIdentity } = buildCohort(transactionId);
    expect(
      quarantineTreasuryTransaction({
        transactionId,
        authorityLevel: "modern",
        digest,
        tick: Game.time,
        kind: "terminal.send",
        actionKind: "terminal.send",
        source: "test",
        phase: "executing_at_end_tick",
        deltas: BASE_POSTINGS.map((leg) => ({ ...leg })),
        recordedAt: Game.time,
        outcome: "started_unknown",
        settlement: "quarantined",
        contractId: cohort.contractId,
        contractDigest: cohort.contractDigest,
        adapterVersion: 1,
        adapterRegistrationId: cohort.adapterRegistrationId,
        adapterSemanticIdentity: cohort.adapterSemanticIdentity,
        durablePayload: "dp",
        durablePayloadVersion: 1,
        structureFacts,
        ownerIdentity: cohort.ownerIdentity,
        policyIdentity: "no-reserve@v1:allow",
        authorizationCohort: cohort,
        authorizationCohortDigest: cohortDigest,
        durableIdentityDigest: durableIdentity,
      }).status,
    ).toBe("written");
    const before = JSON.stringify(listTreasuryQuarantineEntries().map((entry) => readTreasuryQuarantineEntry(entry.transactionId)));
    const list = listTreasuryQuarantineEntries();
    expect(() => {
      for (const entry of list) {
        const cohortView = (entry as unknown as { authorizationCohort?: { revisions: Record<string, number> } }).authorizationCohort;
        if (cohortView) cohortView.revisions.projectionRevision = 999;
        const descriptor = (entry as unknown as { structureFacts?: { version?: number }[] }).structureFacts;
        if (descriptor && descriptor[0]) descriptor[0].version = 999;
      }
    }).toThrow();
    expect(JSON.stringify(listTreasuryQuarantineEntries().map((entry) => readTreasuryQuarantineEntry(entry.transactionId)))).toBe(before);
  });
});

// ── 六、lowlevel provenance 受控权威 ─────────────────────────────────────────

describe("lowlevel provenance 受控权威（第十五轮第十二节）", () => {
  const digest = "0123456789abcdef";

  it("任意未知 lowlevelSource：store 写入拒绝；validate 收敛为受控枚举", () => {
    expect(validateTreasuryLowlevelSourceField("totally-custom-source")).not.toBeNull();
    expect(validateTreasuryLowlevelSourceField(TREASURY_LOWLEVEL_SOURCE_RUNTIME)).toBeNull();
    expect(validateTreasuryLowlevelSourceField(TREASURY_LOWLEVEL_SOURCE_MIGRATED)).toBeNull();
    // test-only 来源不得进入 production store 校验。
    expect(validateTreasuryLowlevelSourceField(TREASURY_LOWLEVEL_SOURCE_TEST)).not.toBeNull();
    const rejected = quarantineTreasuryTransaction({
      transactionId: "ll_unknown",
      authorityLevel: "lowlevel",
      lowlevelSource: "totally-custom-source",
      digest,
      tick: Game.time,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick",
      deltas: BASE_POSTINGS.map((leg) => ({ ...leg })),
      recordedAt: Game.time,
      outcome: "started_unknown",
      settlement: "quarantined",
    });
    expect(rejected.status).toBe("rejected");
    const testOnly = quarantineTreasuryTransaction({
      transactionId: "ll_test_only",
      authorityLevel: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_TEST,
      digest,
      tick: Game.time,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick",
      deltas: BASE_POSTINGS.map((leg) => ({ ...leg })),
      recordedAt: Game.time,
      outcome: "started_unknown",
      settlement: "quarantined",
    });
    expect(testOnly.status).toBe("rejected");
  });

  it("runtime 来源由 store 内部缺省写入可通过（production 写路径）", () => {
    const result = quarantineTreasuryTransaction({
      transactionId: "ll_runtime",
      authorityLevel: "lowlevel",
      digest,
      tick: Game.time,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick",
      deltas: BASE_POSTINGS.map((leg) => ({ ...leg })),
      recordedAt: Game.time,
      outcome: "started_unknown",
      settlement: "quarantined",
    });
    expect(result.status).toBe("written");
    expect(readTreasuryQuarantineEntry("ll_runtime")?.lowlevelSource).toBe(TREASURY_LOWLEVEL_SOURCE_RUNTIME);
  });

  it("迁移定级：旧显式 lowlevel 携带无法证明的任意 source → forensic（不得直接信任）", () => {
    const base = {
      transactionId: "ll_migration",
      digest,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      adapterSemanticIdentity: "terminal.send@reconciler-semantics-v1",
      postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
      durableIdentityDigest: lowlevelIdentity("ll_migration", digest),
    };
    const [levelWithForeign] = classifyTreasuryAuthorityLevelForMigration({
      ...base,
      priorAuthorityLevel: "lowlevel",
      lowlevelSource: "ancient-arbitrary-source",
    });
    expect(levelWithForeign).toBe("forensic");
    // 受控 migrated 来源（矩阵满足）→ lowlevel。
    const [levelWithMigrated] = classifyTreasuryAuthorityLevelForMigration({
      ...base,
      priorAuthorityLevel: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_MIGRATED,
    });
    expect(levelWithMigrated).toBe("lowlevel");
  });

  it("source 变化导致 same-ID conflict（lowlevel 身份成分）", () => {
    const base = {
      transactionId: "ll_source_conflict",
      authorityLevel: "lowlevel" as const,
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      digest,
      tick: Game.time,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick" as const,
      deltas: BASE_POSTINGS.map((leg) => ({ ...leg })),
      recordedAt: Game.time,
      outcome: "started_unknown" as const,
      settlement: "quarantined" as const,
    };
    expect(quarantineTreasuryTransaction(base).status).toBe("written");
    const conflict = quarantineTreasuryTransaction({ ...base, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_MIGRATED });
    expect(conflict.status).toBe("rejected");
    if (conflict.status === "rejected") expect(conflict.reason).toBe("identity_conflict");
  });
});
