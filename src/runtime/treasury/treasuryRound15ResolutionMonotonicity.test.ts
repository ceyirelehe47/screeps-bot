/**
 * 【第十五轮】Resolution State Monotonicity & Cross-Store Authority Release 测试。
 *
 * 覆盖（第十五节场景清单的新增不变量——回归场景由既有 suites 承载）：
 * - cross-store authority recovery：staged recovery 统一经
 *   resolveTreasuryUnresolvedAuthority——双 authority inconsistent（跨等级 /
 *   modern identity 不同）零释放且 intent/quarantine/tombstone/marker 全
 *   保留、独立计数；完全一致时正常补完成；旁路删除（不再 quarantine ??
 *   intent）；
 * - tombstone 不可逆状态机：合法创建 / 合法 finalize / 全部禁止转换 /
 *   exact idempotence / 状态冲突原数据不变 / 直接创建 final committed 拒绝；
 * - resolving capability gate：resolving 期间 reconciler 零调用、不签发第二
 *   份 capability；final identity match → already_resolved；identity conflict
 *   fail closed；恢复完成后才允许新 transaction 生命周期；
 * - immediate committed verifier：refresh 成功但持久 proof 被篡改 / 双
 *   authority 变 inconsistent / proof 变 legacy 均不释放；normal 与 recovery
 *   调用同一 verifier；
 * - resolution health：v3 轻量 probe 不误报 unknown、写路径触发完整迁移、
 *   v99 fail closed、未 load 不全表扫描。
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
  quarantineTreasuryTransaction,
  readTreasuryQuarantineEntry,
  resetTreasuryQuarantineRuntimeForTest,
} from "@/runtime/treasury/quarantine";
import {
  deleteTreasuryResolutionTombstone,
  ensureTreasuryResolutionStoreValidated,
  peekTreasuryResolutionStoreHealth,
  readTreasuryResolutionStoreCounters,
  readTreasuryResolutionTombstone,
  recoverStagedResolutions,
  resetTreasuryResolutionStoreForTest,
  treasuryResolutionResolvingInProgress,
  writeTreasuryResolutionTombstone,
  TREASURY_RESOLUTION_VERSION,
} from "@/runtime/treasury/resolutionStore";
import { recordTreasuryWriteFault, readTreasuryWriteFault } from "@/runtime/treasury/writeFault";
import { resolveTreasuryUnresolvedAuthority } from "@/runtime/treasury/unresolvedAuthority";
import { computeTreasuryDurableIdentityDigest } from "@/runtime/treasury/durableIdentity";
import { computeTreasuryAuthorizationCohortDigest } from "@/runtime/treasury/authorization";
import * as committedVerifierModule from "@/runtime/treasury/committedProofVerifier";
import {
  setTreasuryImmediateResolutionFaultForTest,
} from "@/runtime/treasury/faultResolution";
import { TREASURY_LOWLEVEL_SOURCE_RUNTIME } from "@/runtime/treasury/authorityLevel";
import {
  makeTreasuryTestTransferAdapter,
  replaceTreasuryActionAdapterForTest,
  unregisterTreasuryActionAdapterForTest,
  type TreasuryActionReconcilerConclusion,
} from "@/runtime/treasury/actionContracts";
import type { TreasuryReconciliationCapability } from "@/runtime/treasury/reconciliation";
import { installRooms, type RoomSpec } from "@mock/treasury";
import type { TreasuryTransactionInput } from "@/runtime/treasury/types";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 5_000 },
  },
];

const BASE_POSTINGS = [{ roomName: "W1N57", locationKind: "storage" as const, resource: "energy" as const, delta: -500 }];

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
let reconcilerCalls = 0;

function registerTerminalSendReconciler(): void {
  replaceTreasuryActionAdapterForTest({
    ...makeTreasuryTestTransferAdapter(),
    kind: "terminal.send",
    semanticIdentity: "terminal.send@reconciler-semantics-v1",
    reconcile: () => {
      reconcilerCalls += 1;
      return reconcilerConclusion;
    },
  });
}

function issueCapability(
  service: TreasuryTestService,
  transactionId: string,
  digest?: string,
):
  | { status: "issued"; capability: TreasuryReconciliationCapability }
  | { status: "already_resolved"; resolution: "committed" | "not-executed" }
  | { status: "rejected"; reason: string; detail: string } {
  const issued = service.issueTreasuryReconciliationCapability({
    transactionId,
    ...(digest !== undefined ? { digest } : {}),
  });
  if (issued.status === "issued") return { status: "issued", capability: issued.capability };
  if (issued.status === "already_resolved") return { status: "already_resolved", resolution: issued.resolution };
  return { status: "rejected", reason: issued.reason, detail: issued.detail };
}

function advanceTick(): TreasuryTestService {
  Game.time += 1;
  const next = makeService();
  next.beginTick();
  return next;
}

/** 懒 service（不跑 beginTick 恢复——保留 fixture 共存窗口供签发路径验证）。 */
function makeLazyService(): TreasuryTestService {
  Game.time += 1;
  const rooms = installRooms(ROOMS);
  const service = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
  return treasuryTestService(service);
}

/** 低层 fixture 的确定性 durable identity。 */
function lowlevelIdentity(transactionId: string, digest: string): string {
  return computeTreasuryDurableIdentityDigest({
    transactionId,
    digest,
    actionKind: "terminal.send",
    postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
    source: "test",
    adapterSemanticIdentity: "terminal.send@reconciler-semantics-v1",
  });
}

/** 合法低层 quarantine fixture（store 内部派生 durable identity——读回取用）。 */
function seedLowlevelQuarantine(transactionId: string, digest = "0123456789abcdef"): string {
  const write = quarantineTreasuryTransaction({
    transactionId,
    authorityLevel: "lowlevel",
    lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    digest,
    tick: Game.time,
    kind: "terminal.send",
    actionKind: "terminal.send",
    source: "test",
    adapterSemanticIdentity: "terminal.send@reconciler-semantics-v1",
    phase: "ok_pending_commit_unresolved",
    outcome: "returned_ok",
    settlement: "quarantined",
    deltas: BASE_POSTINGS.map((leg) => ({ ...leg })),
    recordedAt: Game.time,
  });
  expect(write.status).toBe("written");
  const identity = readTreasuryQuarantineEntry(transactionId)?.durableIdentityDigest;
  expect(identity).toBeDefined();
  return identity as string;
}

/** 与 quarantine 事实完全一致的并存 intent（双 authority 可合并形态）。 */
function seedMatchingIntent(transactionId: string, digest: string): string {
  const write = writeTreasuryIntentEntry({
    transactionId,
    authorityLevel: "lowlevel",
    lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    digest,
    kind: "terminal.send",
    actionKind: "terminal.send",
    source: "test",
    adapterSemanticIdentity: "terminal.send@reconciler-semantics-v1",
    postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
    outcome: "returned_ok",
    settlement: "faulted",
    createdAtTick: Game.time,
    updatedAtTick: Game.time,
  });
  expect(write.status).toBe("written");
  const identity = readTreasuryIntentEntry(transactionId)?.durableIdentityDigest;
  expect(identity).toBeDefined();
  return identity as string;
}

/**
 * 与 quarantine 冲突的并存 intent：不同 postings 事实派生的**真实** durable
 * identity（写入前重算可证明——resolver 判 inconsistent）。
 */
function seedConflictingIntent(transactionId: string, digest: string): string {
  const foreignPostings = [{ roomName: "W1N57", locationKind: "storage" as const, resource: "energy" as const, delta: -501 }];
  const write = writeTreasuryIntentEntry({
    transactionId,
    authorityLevel: "lowlevel",
    lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    digest,
    kind: "terminal.send",
    actionKind: "terminal.send",
    source: "test",
    adapterSemanticIdentity: "terminal.send@reconciler-semantics-v1",
    postings: foreignPostings.map((leg) => ({ ...leg })),
    outcome: "returned_ok",
    settlement: "faulted",
    createdAtTick: Game.time,
    updatedAtTick: Game.time,
  });
  expect(write.status).toBe("written");
  const identity = readTreasuryIntentEntry(transactionId)?.durableIdentityDigest;
  expect(identity).toBeDefined();
  return identity as string;
}

/**
 * 阻断 beginTick recovery 自动完成的 receipt 冲突 fixture：同 ID 既有
 * modern proof 绑定不同 durable identity → refresh blocked（identity_conflict）
 * → resolving tombstone 与 authority 均保留。
 */
function seedConflictingReceipt(transactionId: string): void {
  const foreign = lowlevelIdentity(`${transactionId}:foreign`, "9999999999999999");
  const write = commitSettledReceipt(transactionId, Game.time, {
    digest: "9999999999999999",
    durableIdentityDigest: foreign,
  });
  expect(write.status).toBe("written");
}

/** resolving committed tombstone fixture（lowlevel proof，settledAtTick 指定）。 */
function seedResolvingTombstone(transactionId: string, digest: string, identity: string, settledAtTick: number): void {
  const write = writeTreasuryResolutionTombstone({
    transactionId,
    digest,
    resolution: "committed",
    stage: "resolving",
    proofLevel: "lowlevel",
    lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    durableIdentityDigest: identity,
    actionTick: settledAtTick,
    settledAtTick,
    observationTick: settledAtTick,
    resolvedAtTick: settledAtTick,
    reconcilerKind: "terminal.send",
    source: "test",
  });
  expect(write.status).toBe("written");
}

function seedFinalNotExecutedTombstone(transactionId: string, digest: string, identity: string): void {
  const write = writeTreasuryResolutionTombstone({
    transactionId,
    digest,
    resolution: "not-executed",
    stage: "final",
    proofLevel: "lowlevel",
    lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    durableIdentityDigest: identity,
    actionTick: Game.time,
    observationTick: Game.time,
    resolvedAtTick: Game.time,
    reconcilerKind: "terminal.send",
    source: "test",
  });
  expect(write.status).toBe("written");
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  setTreasuryImmediateResolutionFaultForTest(null);
  reconcilerConclusion = "observed_committed";
  reconcilerCalls = 0;
  registerTerminalSendReconciler();
});

afterEach(() => {
  setTreasuryImmediateResolutionFaultForTest(null);
});

// ── 一、cross-store authority recovery（统一 unresolved authority resolver） ──

describe("cross-store authority recovery（第十五轮第五节）", () => {
  it("resolving committed + 低层 quarantine + 不同 durable 的并存 intent：inconsistent 零释放，全部证据保留", () => {
    const digest = "0123456789abcdef";
    const identity = seedLowlevelQuarantine("rc_inconsistent", digest);
    seedConflictingIntent("rc_inconsistent", digest);
    seedResolvingTombstone("rc_inconsistent", digest, identity, Game.time);
    recordTreasuryWriteFault({
      transactionId: "rc_inconsistent",
      digest,
      tick: Game.time,
      kind: "terminal.send",
      source: "test",
      phase: "ok_pending_commit_unresolved",
      status: "unresolved",
      recordedAt: Game.time,
    });

    const report = recoverStagedResolutions();
    expect(report.authorityInconsistent).toBe(1);
    expect(report.completed).toBe(0);
    // 两份 authority 均保留、tombstone 保持 resolving、marker 保留。
    expect(readTreasuryQuarantineEntry("rc_inconsistent")).toBeDefined();
    expect(readTreasuryIntentEntry("rc_inconsistent")).toBeDefined();
    expect(readTreasuryResolutionTombstone("rc_inconsistent")?.stage).toBe("resolving");
    expect(readTreasuryWriteFault()?.transactionId).toBe("rc_inconsistent");
    // write readiness 保持阻断（resolving 未完成）。
    expect(treasuryResolutionResolvingInProgress()).toBe(true);
    // 独立计数。
    expect(readTreasuryResolutionStoreCounters().authorityInconsistentBlockers).toBe(1);
  });

  it("resolving committed + 跨等级双 authority（modern quarantine + legacy intent）：零释放", () => {
    // 直接持久化跨等级双 authority（write API 拒绝 modern+legacy 混合的合法
    // 写入——fixture 绕过 store 写入口模拟历史并存数据；modern 侧携带完整
    // cohort facts + 重算一致的 durable identity，保证 load 校验通过）。
    const digest = "0123456789abcdef";
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
      contractId: "contract:rc_cross",
      contractDigest: "3333333333333333",
      transactionId: "rc_cross_level",
      authorizationLegDigests: ["4444444444444444"],
      receiverCapacityDigest: "none",
      issuedTick: Game.time,
      authorizationDigest: "5555555555555555",
    };
    const cohortDigest = computeTreasuryAuthorizationCohortDigest(cohort);
    const structureFacts = [
      { bindingKind: "governed_location" as const, role: "source" as const, roomName: "W1N57", locationKind: "storage" as const, structureId: "stor-1", required: true, version: 1 },
    ];
    const modernIdentity = computeTreasuryDurableIdentityDigest({
      transactionId: "rc_cross_level",
      digest,
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
    Memory.runtime = Memory.runtime ?? ({} as never);
    (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury = {
      ...((Memory.runtime ?? {}) as { treasury?: Record<string, unknown> }).treasury,
      quarantine: {
        version: 5,
        entries: {
          "q:rc_cross_level": {
            transactionId: "rc_cross_level",
            authorityLevel: "modern",
            digest,
            tick: Game.time,
            kind: "terminal.send",
            actionKind: "terminal.send",
            source: "test",
            phase: "ok_pending_commit_unresolved",
            deltas: BASE_POSTINGS.map((leg) => ({ ...leg })),
            recordedAt: Game.time,
            outcome: "returned_ok",
            settlement: "quarantined",
            contractId: "contract:rc_cross",
            contractDigest: "3333333333333333",
            adapterVersion: 1,
            adapterRegistrationId: "2222222222222222",
            adapterSemanticIdentity: "terminal.send@reconciler-semantics-v1",
            durablePayload: "dp",
            durablePayloadVersion: 1,
            structureFacts: [
              { bindingKind: "governed_location", role: "source", roomName: "W1N57", locationKind: "storage", structureId: "stor-1", required: true, version: 1 },
            ],
            ownerIdentity: cohort.ownerIdentity,
            policyIdentity: "no-reserve@v1:allow",
            authorizationCohort: cohort,
            authorizationCohortDigest: cohortDigest,
            durableIdentityDigest: modernIdentity,
          },
        },
        entryCount: 1,
      },
      intents: {
        version: 6,
        entries: {
          "i:rc_cross_level": {
            transactionId: "rc_cross_level",
            authorityLevel: "legacy",
            digest,
            kind: "terminal.send",
            actionKind: "terminal.send",
            source: "test",
            postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
            outcome: "started_unknown",
            settlement: "executing",
            createdAtTick: Game.time,
            updatedAtTick: Game.time,
          },
        },
        entryCount: 1,
        updatedAt: Game.time,
      },
    };
    resetTreasuryQuarantineRuntimeForTest();
    resetTreasuryIntentRuntimeForTest();
    expect(resolveTreasuryUnresolvedAuthority("rc_cross_level").status).toBe("inconsistent");
    seedResolvingTombstone("rc_cross_level", digest, modernIdentity, Game.time);

    const report = recoverStagedResolutions();
    expect(report.authorityInconsistent).toBe(1);
    expect(report.completed).toBe(0);
    expect(readTreasuryQuarantineEntry("rc_cross_level")).toBeDefined();
    expect(readTreasuryIntentEntry("rc_cross_level")).toBeDefined();
    expect(readTreasuryResolutionTombstone("rc_cross_level")?.stage).toBe("resolving");
  });

  it("final not-executed 补完成面对不一致双 authority：零释放", () => {
    const digest = "0123456789abcdef";
    const identity = seedLowlevelQuarantine("rc_ne_inconsistent", digest);
    seedConflictingIntent("rc_ne_inconsistent", digest);
    seedFinalNotExecutedTombstone("rc_ne_inconsistent", digest, identity);

    const report = recoverStagedResolutions();
    expect(report.authorityInconsistent).toBe(1);
    expect(report.completedRelease).toBe(0);
    expect(readTreasuryQuarantineEntry("rc_ne_inconsistent")).toBeDefined();
    expect(readTreasuryIntentEntry("rc_ne_inconsistent")).toBeDefined();
  });

  it("双 authority 完全一致：normalized authority 路径正常完成 finalize（一并释放）", () => {
    const digest = "0123456789abcdef";
    const identity = seedLowlevelQuarantine("rc_consistent", digest);
    expect(seedMatchingIntent("rc_consistent", digest)).toBe(identity);
    seedResolvingTombstone("rc_consistent", digest, identity, Game.time);
    expect(resolveTreasuryUnresolvedAuthority("rc_consistent").status).toBe("ok");
    // receipt 先行写入（identity-aware——lowlevel provenance 随行绑定）。
    expect(
      commitSettledReceipt("rc_consistent", Game.time, {
        digest,
        durableIdentityDigest: identity,
        lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      }).status,
    ).toBe("written");

    const report = recoverStagedResolutions();
    expect(report.authorityInconsistent).toBe(0);
    expect(report.completed).toBe(1);
    expect(readTreasuryQuarantineEntry("rc_consistent")).toBeUndefined();
    expect(readTreasuryIntentEntry("rc_consistent")).toBeUndefined();
    expect(readTreasuryResolutionTombstone("rc_consistent")?.stage).toBe("final");
    expect(treasuryResolutionResolvingInProgress()).toBe(false);
  });

  it("authority 已释放（not_found）：receipt↔tombstone match 仍可补完成 finalize", () => {
    const digest = "0123456789abcdef";
    const identity = lowlevelIdentity("rc_released", digest);
    seedResolvingTombstone("rc_released", digest, identity, Game.time);
    expect(
      commitSettledReceipt("rc_released", Game.time, { digest, durableIdentityDigest: identity, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME }).status,
    ).toBe("written");
    expect(resolveTreasuryUnresolvedAuthority("rc_released").status).toBe("not_found");

    const report = recoverStagedResolutions();
    expect(report.completed).toBe(1);
    expect(readTreasuryResolutionTombstone("rc_released")?.stage).toBe("final");
  });
});

// ── 二、tombstone 不可逆状态机 ────────────────────────────────────────────────

describe("resolution tombstone 状态机（第十五轮第六节）", () => {
  const digest = "0123456789abcdef";
  const identity = "aaaaaaaaaaaaaaaa";

  function baseEntry(overrides: Partial<Parameters<typeof writeTreasuryResolutionTombstone>[0]> = {}) {
    return {
      transactionId: "sm_tx",
      digest,
      resolution: "committed" as const,
      stage: "resolving" as const,
      proofLevel: "lowlevel" as const,
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      durableIdentityDigest: identity,
      actionTick: 10,
      settledAtTick: 12,
      observationTick: 12,
      resolvedAtTick: 12,
      reconcilerKind: "terminal.send",
      source: "test",
      ...overrides,
    };
  }

  it("absent → resolving committed 与 absent → final not-executed 是唯二合法创建", () => {
    expect(writeTreasuryResolutionTombstone(baseEntry()).status).toBe("written");
    expect(
      writeTreasuryResolutionTombstone(
        baseEntry({
          transactionId: "sm_ne",
          resolution: "not-executed",
          stage: "final",
          settledAtTick: undefined,
        }),
      ).status,
    ).toBe("written");
  });

  it("直接创建 final committed / resolving not-executed 拒绝", () => {
    expect(
      writeTreasuryResolutionTombstone(baseEntry({ transactionId: "sm_bad_fc", stage: "final" })).status,
    ).toBe("rejected");
    expect(
      writeTreasuryResolutionTombstone(
        baseEntry({ transactionId: "sm_bad_rne", resolution: "not-executed" }),
      ).status,
    ).toBe("rejected");
    expect(readTreasuryResolutionTombstone("sm_bad_fc")).toBeUndefined();
  });

  it("resolving committed → final committed 合法（同字段，仅 stage 推进）", () => {
    expect(writeTreasuryResolutionTombstone(baseEntry()).status).toBe("written");
    expect(writeTreasuryResolutionTombstone(baseEntry({ stage: "final" })).status).toBe("updated");
    expect(readTreasuryResolutionTombstone("sm_tx")?.stage).toBe("final");
  });

  it("resolving committed → final not-executed / resolving not-executed 拒绝且原数据不变", () => {
    writeTreasuryResolutionTombstone(baseEntry());
    const before = readTreasuryResolutionTombstone("sm_tx");
    expect(
      writeTreasuryResolutionTombstone(
        baseEntry({ resolution: "not-executed", stage: "final", settledAtTick: undefined }),
      ).status,
    ).toBe("rejected");
    expect(writeTreasuryResolutionTombstone(baseEntry({ resolution: "not-executed" })).status).toBe("rejected");
    expect(readTreasuryResolutionTombstone("sm_tx")).toEqual(before);
  });

  it("final committed → final not-executed、final not-executed → final committed、final → resolving 全部拒绝", () => {
    writeTreasuryResolutionTombstone(baseEntry());
    writeTreasuryResolutionTombstone(baseEntry({ stage: "final" }));
    expect(
      writeTreasuryResolutionTombstone(
        baseEntry({ resolution: "not-executed", settledAtTick: undefined }),
      ).status,
    ).toBe("rejected");
    const ne = writeTreasuryResolutionTombstone(
      baseEntry({
        transactionId: "sm_ne2",
        resolution: "not-executed",
        stage: "final",
        settledAtTick: undefined,
      }),
    );
    expect(ne.status).toBe("written");
    expect(
      writeTreasuryResolutionTombstone(
        baseEntry({ transactionId: "sm_ne2", resolution: "committed", stage: "resolving", settledAtTick: 12 }),
      ).status,
    ).toBe("rejected");
    expect(
      writeTreasuryResolutionTombstone(baseEntry({ transactionId: "sm_ne2", stage: "resolving", settledAtTick: undefined, resolution: "not-executed" })).status,
    ).toBe("rejected");
  });

  it("同 state、同完整内容重复写 → exact idempotent（非覆盖写）", () => {
    writeTreasuryResolutionTombstone(baseEntry());
    expect(writeTreasuryResolutionTombstone(baseEntry()).status).toBe("idempotent");
    writeTreasuryResolutionTombstone(baseEntry({ stage: "final" }));
    expect(writeTreasuryResolutionTombstone(baseEntry({ stage: "final" })).status).toBe("idempotent");
    // 内容任一差异（resolvedAtTick 不同） → 冲突。
    expect(writeTreasuryResolutionTombstone(baseEntry({ stage: "final", resolvedAtTick: 99 })).status).toBe("rejected");
  });

  it("同 ID 改变 digest / actionTick / proofLevel / attempt identity / 降低 settledAtTick 拒绝", () => {
    writeTreasuryResolutionTombstone(baseEntry());
    expect(writeTreasuryResolutionTombstone(baseEntry({ digest: "1111111111111111" })).status).toBe("rejected");
    expect(writeTreasuryResolutionTombstone(baseEntry({ actionTick: 11 })).status).toBe("rejected");
    expect(writeTreasuryResolutionTombstone(baseEntry({ proofLevel: "identity-bound" })).status).toBe("rejected");
    expect(writeTreasuryResolutionTombstone(baseEntry({ durableIdentityDigest: "bbbbbbbbbbbbbbbb" })).status).toBe("rejected");
    expect(writeTreasuryResolutionTombstone(baseEntry({ settledAtTick: 11 })).status).toBe("rejected");
    expect(writeTreasuryResolutionTombstone(baseEntry({ reconcilerKind: "other.kind" })).status).toBe("rejected");
    expect(writeTreasuryResolutionTombstone(baseEntry({ source: "other" })).status).toBe("rejected");
    expect(writeTreasuryResolutionTombstone(baseEntry({ observationTick: 13 })).status).toBe("rejected");
  });

  it("resolvedAtTick 只允许单调推进（finalize 不降）", () => {
    writeTreasuryResolutionTombstone(baseEntry());
    expect(writeTreasuryResolutionTombstone(baseEntry({ stage: "final", resolvedAtTick: 20 })).status).toBe("updated");
    // 已 final：任何写（含回退）都按 exact idempotence 拒绝。
    expect(writeTreasuryResolutionTombstone(baseEntry({ stage: "final", resolvedAtTick: 5 })).status).toBe("rejected");
  });

  it("delete 只允许 resolving 回滚：final 拒绝删除", () => {
    writeTreasuryResolutionTombstone(baseEntry());
    expect(deleteTreasuryResolutionTombstone("sm_tx")).toBe(true);
    writeTreasuryResolutionTombstone(baseEntry({ transactionId: "sm_final", stage: "final" }) as never).status;
    // 重建一笔 final committed（resolving→final 合法链）。
    writeTreasuryResolutionTombstone(baseEntry({ transactionId: "sm_final2" }));
    writeTreasuryResolutionTombstone(baseEntry({ transactionId: "sm_final2", stage: "final" }));
    expect(deleteTreasuryResolutionTombstone("sm_final2")).toBe(false);
    expect(readTreasuryResolutionTombstone("sm_final2")?.stage).toBe("final");
  });

  it("状态冲突时原 tombstone 完全不变（逐字段比较）", () => {
    writeTreasuryResolutionTombstone(baseEntry());
    const before = { ...(readTreasuryResolutionTombstone("sm_tx") as object) };
    writeTreasuryResolutionTombstone(baseEntry({ digest: "9999999999999999" }));
    const after = readTreasuryResolutionTombstone("sm_tx") as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(before)) {
      expect(after[key]).toEqual(value);
    }
  });
});

// ── 三、resolving capability gate ────────────────────────────────────────────

describe("resolving capability gate（第十五轮第七节）", () => {
  it("resolving tombstone 存在：capability 拒绝 resolution_in_progress 且 reconciler 零调用", () => {
    const digest = "0123456789abcdef";
    const identity = seedLowlevelQuarantine("gate_resolving", digest);
    seedConflictingReceipt("gate_resolving");
    seedResolvingTombstone("gate_resolving", digest, identity, Game.time);

    const next = advanceTick();
    const issued = issueCapability(next, "gate_resolving", digest);
    expect(issued.status).toBe("rejected");
    if (issued.status === "rejected") expect(issued.reason).toBe("resolution_in_progress");
    expect(reconcilerCalls).toBe(0);
    expect(readTreasuryQuarantineEntry("gate_resolving")).toBeDefined();
  });

  it("resolving tombstone identity 与 authority 冲突：resolution_identity_conflict，reconciler 零调用", () => {
    const digest = "0123456789abcdef";
    seedLowlevelQuarantine("gate_conflict", digest);
    seedConflictingReceipt("gate_conflict");
    // tombstone 绑定不同 durable identity（与 authority 冲突——真实派生值）。
    seedResolvingTombstone("gate_conflict", digest, lowlevelIdentity("gate_conflict:x", digest), Game.time);

    const next = advanceTick();
    const issued = issueCapability(next, "gate_conflict", digest);
    expect(issued.status).toBe("rejected");
    if (issued.status === "rejected") expect(issued.reason).toBe("resolution_identity_conflict");
    expect(reconcilerCalls).toBe(0);
  });

  it("final matching tombstone：already_resolved 语义，reconciler 零调用", () => {
    const digest = "0123456789abcdef";
    const identity = seedLowlevelQuarantine("gate_final", digest);
    seedFinalNotExecutedTombstone("gate_final", digest, identity);

    const next = makeLazyService();
    const issued = issueCapability(next, "gate_final", digest);
    expect(issued.status).toBe("already_resolved");
    expect(reconcilerCalls).toBe(0);
  });

  it("resolving 期间 not-executed 结论同样不签发（无第二份普通 capability）", () => {
    const digest = "0123456789abcdef";
    reconcilerConclusion = "observed_not_executed";
    const identity = seedLowlevelQuarantine("gate_ne", digest);
    seedConflictingReceipt("gate_ne");
    seedResolvingTombstone("gate_ne", digest, identity, Game.time);

    const next = advanceTick();
    const issued = issueCapability(next, "gate_ne", digest);
    expect(issued.status).toBe("rejected");
    if (issued.status === "rejected") expect(issued.reason).toBe("resolution_in_progress");
    expect(reconcilerCalls).toBe(0);
  });

  it("恢复完成后（authority 释放、tombstone final）：not_found——新 transaction 生命周期可开始", () => {
    const digest = "0123456789abcdef";
    const identity = seedLowlevelQuarantine("gate_after", digest);
    seedResolvingTombstone("gate_after", digest, identity, Game.time);
    expect(commitSettledReceipt("gate_after", Game.time, { digest, durableIdentityDigest: identity, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME }).status).toBe("written");
    const report = recoverStagedResolutions();
    expect(report.completed).toBe(1);

    const next = advanceTick();
    const issued = issueCapability(next, "gate_after", digest);
    expect(issued.status).toBe("rejected");
    if (issued.status === "rejected") expect(issued.reason).toBe("not_found");
  });
});

// ── 四、immediate committed verifier（normal 与 recovery 复用） ───────────────

describe("immediate committed verifier（第十五轮第十三节）", () => {
  const digest = "0123456789abcdef";

  function setupFaultAuthority(transactionId: string): string {
    return seedLowlevelQuarantine(transactionId, digest);
  }

  it("refresh 成功且三方 match：正常释放（verifier 被调用）", () => {
    const identity = setupFaultAuthority("iv_ok");
    const verifierSpy = jest.spyOn(committedVerifierModule, "verifyTreasuryCommittedResolutionProof");
    const next = advanceTick();
    const issued = issueCapability(next, "iv_ok", digest);
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    const resolved = next.resolveUnresolvedTransaction({ transactionId: "iv_ok", digest, capability: issued.capability });
    expect(resolved.status).toBe("resolved");
    expect(readTreasuryQuarantineEntry("iv_ok")).toBeUndefined();
    expect(readTreasuryResolutionTombstone("iv_ok")?.stage).toBe("final");
    expect(verifierSpy).toHaveBeenCalledTimes(1);
    verifierSpy.mockRestore();
  });

  it("refresh 成功后 receipt 被篡改：不释放、不 finalize、resolving 保留", () => {
    const identity = setupFaultAuthority("iv_tampered");
    setTreasuryImmediateResolutionFaultForTest(() => {
      // refresh 成功后、verifier 读取前：篡改持久 proof 的 durable identity。
      const settled = (Memory.runtime as unknown as { treasury?: { receipts?: { settled?: Record<string, unknown> } } })
        .treasury?.receipts?.settled;
      const key = Object.keys(settled ?? {}).find((k) => k.endsWith("iv_tampered"));
      if (key !== undefined && settled !== undefined) {
        (settled[key] as { durableIdentityDigest?: string }).durableIdentityDigest = "ffffffffffffffff";
      }
    });
    const next = advanceTick();
    const issued = issueCapability(next, "iv_tampered", digest);
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    const resolved = next.resolveUnresolvedTransaction({
      transactionId: "iv_tampered",
      digest,
      capability: issued.capability,
    });
    expect(resolved.status).toBe("rejected");
    if (resolved.status === "rejected") expect(resolved.reason).toBe("settlement_identity_conflict");
    expect(readTreasuryQuarantineEntry("iv_tampered")).toBeDefined();
    expect(readTreasuryResolutionTombstone("iv_tampered")?.stage).toBe("resolving");
  });

  it("refresh 成功后双 authority 变 inconsistent：不释放（authority_inconsistent）", () => {
    const identity = setupFaultAuthority("iv_inconsistent");
    setTreasuryImmediateResolutionFaultForTest(() => {
      // 注入与 authority 冲突的并存 intent（不同事实派生的真实 identity）。
      seedConflictingIntent("iv_inconsistent", digest);
    });
    const next = advanceTick();
    const issued = issueCapability(next, "iv_inconsistent", digest);
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    const resolved = next.resolveUnresolvedTransaction({
      transactionId: "iv_inconsistent",
      digest,
      capability: issued.capability,
    });
    expect(resolved.status).toBe("rejected");
    if (resolved.status === "rejected") expect(resolved.reason).toBe("authority_inconsistent");
    expect(readTreasuryQuarantineEntry("iv_inconsistent")).toBeDefined();
    expect(readTreasuryIntentEntry("iv_inconsistent")).toBeDefined();
    expect(readTreasuryResolutionTombstone("iv_inconsistent")?.stage).toBe("resolving");
  });

  it("refresh 成功后 receipt proof 变 legacy：不释放（proof 不足）", () => {
    const identity = setupFaultAuthority("iv_legacy");
    setTreasuryImmediateResolutionFaultForTest(() => {
      const settled = (Memory.runtime as unknown as { treasury?: { receipts?: { settled?: Record<string, unknown> } } })
        .treasury?.receipts?.settled;
      const key = Object.keys(settled ?? {}).find((k) => k.endsWith("iv_legacy"));
      if (key !== undefined && settled !== undefined) {
        settled[key] = { level: "legacy", settledAtTick: Game.time };
      }
    });
    const next = advanceTick();
    const issued = issueCapability(next, "iv_legacy", digest);
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    const resolved = next.resolveUnresolvedTransaction({
      transactionId: "iv_legacy",
      digest,
      capability: issued.capability,
    });
    expect(resolved.status).toBe("rejected");
    if (resolved.status === "rejected") expect(resolved.reason).toBe("settlement_proof_insufficient");
    expect(readTreasuryQuarantineEntry("iv_legacy")).toBeDefined();
    expect(readTreasuryResolutionTombstone("iv_legacy")?.stage).toBe("resolving");
  });

  it("normal 路径与 staged recovery 路径调用同一 verifier（模块级 spy 双命中）", () => {
    const verifierSpy = jest.spyOn(committedVerifierModule, "verifyTreasuryCommittedResolutionProof");
    // recovery 路径。
    const identityR = seedLowlevelQuarantine("iv_shared_r", digest);
    seedResolvingTombstone("iv_shared_r", digest, identityR, Game.time);
    expect(commitSettledReceipt("iv_shared_r", Game.time, { digest, durableIdentityDigest: identityR, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME }).status).toBe("written");
    recoverStagedResolutions();
    expect(verifierSpy).toHaveBeenCalledTimes(1);
    // normal（immediate）路径。
    seedLowlevelQuarantine("iv_shared_n", digest);
    const next = advanceTick();
    const issued = issueCapability(next, "iv_shared_n", digest);
    expect(issued.status).toBe("issued");
    if (issued.status === "issued") {
      next.resolveUnresolvedTransaction({ transactionId: "iv_shared_n", digest, capability: issued.capability });
    }
    expect(verifierSpy).toHaveBeenCalledTimes(2);
    verifierSpy.mockRestore();
  });
});

// ── 五、resolution health 版本兼容 ───────────────────────────────────────────

describe("resolution health 版本兼容（第十五轮第十节）", () => {
  function seedVersionedStore(version: number): void {
    Memory.runtime = Memory.runtime ?? ({} as never);
    (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury = {
      ...((Memory.runtime ?? {}) as { treasury?: Record<string, unknown> }).treasury,
      resolutions: {
        version,
        entries: {
          "r:hv_tx": {
            transactionId: "hv_tx",
            digest: "0123456789abcdef",
            resolution: "committed",
            ...(version >= 4 ? { proofLevel: "legacy" as const } : {}),
            actionTick: 1,
            settledAtTick: 2,
            observationTick: 2,
            resolvedAtTick: 2,
          },
        },
        entryCount: 1,
        updatedAt: 2,
      },
    };
    resetTreasuryResolutionStoreForTest();
  }

  it("v3 store 轻量 health：不误报 unknown（migration pending）且未 load 不全表扫描", () => {
    seedVersionedStore(3);
    const scansBefore = readTreasuryResolutionStoreCounters().fullScans;
    const health = peekTreasuryResolutionStoreHealth();
    expect(health.healthy).toBe(true);
    expect(health.detail).toBeNull();
    expect(readTreasuryResolutionStoreCounters().fullScans).toBe(scansBefore);
  });

  it("v3 在写路径触发完整 load/migration（升级至当前版本、幂等）", () => {
    seedVersionedStore(3);
    expect(ensureTreasuryResolutionStoreValidated()).toBeNull();
    expect(
      (Memory.runtime as unknown as { treasury?: { resolutions?: { version?: number } } }).treasury?.resolutions
        ?.version,
    ).toBe(TREASURY_RESOLUTION_VERSION);
    expect(readTreasuryResolutionTombstone("hv_tx")?.proofLevel).toBe("legacy");
    // 幂等。
    expect(ensureTreasuryResolutionStoreValidated()).toBeNull();
  });

  it("v4 轻量 health 同样 migration pending；写路径升级 v5", () => {
    seedVersionedStore(4);
    expect(peekTreasuryResolutionStoreHealth().healthy).toBe(true);
    expect(ensureTreasuryResolutionStoreValidated()).toBeNull();
    expect(
      (Memory.runtime as unknown as { treasury?: { resolutions?: { version?: number } } }).treasury?.resolutions
        ?.version,
    ).toBe(TREASURY_RESOLUTION_VERSION);
  });

  it("unknown 版本（v99）仍 fail closed", () => {
    seedVersionedStore(99);
    const health = peekTreasuryResolutionStoreHealth();
    expect(health.healthy).toBe(false);
    if (!health.healthy) expect(health.detail).toContain("未知");
    expect(ensureTreasuryResolutionStoreValidated()).toContain("未知");
  });

  it("write readiness 的 resolving blocker：store 存在时触发完整 load 后读缓存", () => {
    const digest = "0123456789abcdef";
    const identity = seedLowlevelQuarantine("hv_blocker", digest);
    seedResolvingTombstone("hv_blocker", digest, identity, Game.time);
    expect(treasuryResolutionResolvingInProgress()).toBe(true);
    // finalize 后 blocker 解除。
    expect(commitSettledReceipt("hv_blocker", Game.time, { digest, durableIdentityDigest: identity, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME }).status).toBe("written");
    recoverStagedResolutions();
    expect(treasuryResolutionResolvingInProgress()).toBe(false);
  });

  it("store 不存在时零写返回 false（查询路径不隐式创建 store）", () => {
    expect(treasuryResolutionResolvingInProgress()).toBe(false);
    expect(
      (Memory.runtime as { treasury?: { resolutions?: unknown } } | undefined)?.treasury?.resolutions,
    ).toBeUndefined();
  });
});
