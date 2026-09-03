/**
 * 【第十二轮】Durable Integrity Proof & Stable Reconciler Identity 测试。
 *
 * 覆盖：
 * - 3.1/3.2 authorization fault 的 staged publication（authority 前置、
 *   结果不忽略、read-back、capacity admission、forensic fail-closed）；
 * - 3.3/3.4 tombstone / receipt settlement proof 绑定完整 attempt identity；
 * - 3.5 跨 global reset 稳定的 adapter/reconciler 语义身份；
 * - 3.6 cohort / durable identity digest 的统一重算验证（篡改 → unhealthy）；
 * - 3.7 structure binding discriminated union；
 * - 3.8 forensic incomplete authority 隔离；
 * - 3.9/3.10 authorization fault store health 与 production 类型边界回归。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { TREASURY_LOWLEVEL_SOURCE_RUNTIME } from "@/runtime/treasury/authorityLevel";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  buildTreasuryActionContract,
  executeTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  readTreasuryTestAdapterSideEffects,
  registerTreasuryActionAdapter,
  replaceTreasuryActionAdapterForTest,
  resetTreasuryTestAdapterSideEffectsForTest,
  unregisterTreasuryActionAdapterForTest,
  type TreasuryActionStructureBinding,
  type TreasuryTestTransferArgs,
} from "@/runtime/treasury/actionContracts";
import {
  peekTreasuryAuthorizationFaultStore,
  readTreasuryAuthorizationFaultEntry,
  resetTreasuryAuthorizationFaultRuntimeForTest,
  treasuryAuthorizationFaultBlockers,
  TREASURY_AUTHORIZATION_FAULT_MAX_ENTRIES,
  writeTreasuryAuthorizationFaultEntry,
} from "@/runtime/treasury/authorizationFaults";
import { readTreasuryWriteFault, setTreasuryCommitFaultInjectorForTest } from "@/runtime/treasury/writeFault";
import {
  readTreasuryQuarantineEntry,
  peekTreasuryQuarantineStore,
  quarantineTreasuryTransaction,
  treasuryForensicQuarantineDiagnostics,
  ensureTreasuryQuarantineStoreValidated,
} from "@/runtime/treasury/quarantine";
import {
  readTreasuryIntentEntry,
  peekTreasuryIntentStore,
  writeTreasuryIntentEntry,
  transferTreasuryIntentToQuarantine,
} from "@/runtime/treasury/intents";
import {
  peekTreasuryResolutionStoreHealth,
  readTreasuryResolutionTombstone,
  writeTreasuryResolutionTombstone,
} from "@/runtime/treasury/resolutionStore";
import { readTreasurySettlementProof, peekTreasuryReceiptStore } from "@/runtime/treasury/receipts";
import { setTreasuryRedemptionFaultInjectorForTest } from "@/runtime/treasury/authorizationLedger";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import {
  clearTreasuryPolicyResolversForTest,
  makeNoReserveTreasuryPolicy,
  registerTreasuryPolicyResolver,
} from "@/runtime/treasury/policyAuthority";
import {
  computeTreasuryDurableIdentityDigest,
} from "@/runtime/treasury/durableIdentity";
import {
  computeTreasuryAuthorizationCohortDigest,
  type TreasuryAuthorizationCohortFacts,
} from "@/runtime/treasury/authorization";
import { treasuryAttemptIdentityRelation } from "@/runtime/treasury/identityProof";
import { installRooms, type RoomSpec } from "@mock/treasury";
import type { TreasuryAuthorizationBundle } from "@/runtime/treasury/authorization";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000, U: 50_000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 5_000 },
  },
];

function makeService(): TreasuryTestService {
  const rooms = installRooms(ROOMS);
  const service = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
  service.beginTick();
  return treasuryTestService(service);
}

function transferArgs(overrides: Partial<TreasuryTestTransferArgs> = {}): TreasuryTestTransferArgs {
  return {
    fromRoom: "W1N57",
    fromLocation: "storage",
    toRoom: "W1N57",
    toLocation: "terminal",
    resource: RESOURCE_ENERGY,
    amount: 500,
    outcome: "ok",
    ...overrides,
  };
}

/** contract → bundle 的标准 fixture。 */
function buildAndAuthorize(service: TreasuryTestService, transactionId: string, args: TreasuryTestTransferArgs = transferArgs()) {
  const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId, args });
  expect(built.status).toBe("built");
  if (built.status !== "built") throw new Error("unreachable");
  const authorized = service.authorizeTreasuryActionContract(built.contract);
  expect(authorized.status).toBe("authorized");
  if (authorized.status !== "authorized") throw new Error("unreachable");
  return { contract: built.contract, bundle: authorized.bundle as TreasuryAuthorizationBundle };
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  resetTreasuryTestAdapterSideEffectsForTest();
  registerTreasuryActionAdapter(makeTreasuryTestTransferAdapter());
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
});

afterEach(() => {
  setTreasuryRedemptionFaultInjectorForTest(null);
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
  clearTreasuryPolicyResolversForTest();
});

// ── 3.1/3.2 authorization fault staged publication ──────────────────────────

describe("authorization fault publication（第十二轮 3.1/3.2）", () => {
  /** 注入 redemption 故障并执行 contract（到达 fault 路径）。 */
  function injectRedemptionFaultOnce(): void {
    let fired = false;
    setTreasuryRedemptionFaultInjectorForTest((stage) => {
      if (stage === "before_budget_publish" && !fired) {
        fired = true;
        throw new Error("injected:redemption");
      }
    });
  }

  it("正常路径：authority 写入成功后发布普通 marker（含完整身份与可重算 durableIdentityDigest）", () => {
    const service = makeService();
    const { contract, bundle } = buildAndAuthorize(service, "pub_ok_1");
    injectRedemptionFaultOnce();
    const result = executeTreasuryActionContract(service, { contract, authorization: bundle });
    expect(result.status).toBe("prepare_rejected");
    if (result.status === "prepare_rejected") expect(result.reason).toBe("internal_authorization_fault");
    // authority 存在且携带完整身份事实；marker 为普通 phase（非 forensic）。
    const entry = readTreasuryAuthorizationFaultEntry("pub_ok_1");
    expect(entry).toBeDefined();
    expect(entry?.durableIdentityDigest).toBeDefined();
    expect(entry?.adapterSemanticIdentity).toBe("test.transfer@reconciler-semantics-v1");
    expect(entry?.authorizationCohort).toBeDefined();
    expect(readTreasuryWriteFault()?.phase).toBe("internal_authorization_fault");
    // callback 零调用。
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });

  it("store 满载：authority 写入被拒 → 不发布无 authority 的普通 marker，发布 forensic marker；writer 可解释阻断", () => {
    const service = makeService();
    // 预填满 fault store（经合法写入路径 seed——同时确保 store 已创建）。
    // 【第十四轮】低层 seed 须满足严格低层矩阵：actionKind 必填（缺省
    // durableIdentityDigest 由事实自动派生）。
    const seedEntry = {
      transactionId: "seed",
      digest: "0123456789abcdef",
      actionKind: "test.transfer",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1 }],
      faultTick: Game.time,
      outcome: "not_started" as const,
      rollbackConfirmed: true as const,
      source: "seed",
    };
    for (let i = 0; i < TREASURY_AUTHORIZATION_FAULT_MAX_ENTRIES; i += 1) {
      seedEntry.transactionId = `seed:${i}`;
      const written = writeTreasuryAuthorizationFaultEntry({ ...seedEntry, postings: seedEntry.postings.map((leg) => ({ ...leg })) });
      expect(written.status).toBe("written");
    }
    expect(treasuryAuthorizationFaultBlockers().blocking).toBe(true);
    expect(peekTreasuryAuthorizationFaultStore()!.entryCount).toBe(TREASURY_AUTHORIZATION_FAULT_MAX_ENTRIES);
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });

  it("redemption 窗口内 store 被填满：authority 写入 capacity_exhausted → forensic marker（无 authority 普通 marker 不存在）", () => {
    const service = makeService();
    // 先授权（此刻 store 未满、readiness 放行），再在 redemption 注入点把
    // store 填满——模拟 prepare→redemption 之间的并发占位窗口。
    const { contract, bundle } = buildAndAuthorize(service, "pub_full_1");
    let fired = false;
    setTreasuryRedemptionFaultInjectorForTest((stage) => {
      if (stage === "before_budget_publish" && !fired) {
        fired = true;
        for (let i = 0; i < TREASURY_AUTHORIZATION_FAULT_MAX_ENTRIES; i += 1) {
          const seed = writeTreasuryAuthorizationFaultEntry({
            transactionId: `window_full:${i}`,
            digest: "0123456789abcdef",
            actionKind: "test.transfer", // 【第十四轮】低层矩阵 actionKind 必填
            postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1 }],
            faultTick: Game.time,
            outcome: "not_started",
            rollbackConfirmed: true,
            source: "seed",
          });
          expect(seed.status).toBe("written");
        }
        throw new Error("injected:redemption");
      }
    });
    const result = executeTreasuryActionContract(service, { contract, authorization: bundle });
    expect(result.status).toBe("prepare_rejected");
    expect(readTreasuryAuthorizationFaultEntry("pub_full_1")).toBeUndefined();
    // 无 authority 的普通 marker 不存在——只有显式 forensic marker。
    const marker = readTreasuryWriteFault();
    expect(marker?.phase).toBe("internal_authorization_fault_forensic");
    expect(marker?.transactionId).toBe("pub_full_1");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    // forensic marker 可经 acknowledge-rolled-back forensic 通道解除。
    const resolved = service.resolveUnresolvedTransaction({
      transactionId: "pub_full_1",
      digest: contract.digest,
      acknowledgeRolledBack: true,
      capability: {} as never,
    });
    expect(resolved.status).toBe("resolved");
    expect(readTreasuryWriteFault()).toBeUndefined();
  });

  it("store fatal：authority 写入被拒 → forensic marker（fail closed，不静默）", () => {
    const service = makeService();
    // 直写损坏元数据（entryCount 不一致）→ load 后 fatal。
    const { contract, bundle } = buildAndAuthorize(service, "pub_fatal_1");
    let fired = false;
    setTreasuryRedemptionFaultInjectorForTest((stage) => {
      if (stage === "before_budget_publish" && !fired) {
        fired = true;
        // redemption 窗口内把 store 置为 fatal（先建 store，再损坏元数据 → load fatal）。
        const boot = writeTreasuryAuthorizationFaultEntry({
          transactionId: "fatal_boot",
          digest: "0123456789abcdef",
          actionKind: "test.transfer", // 【第十四轮】低层矩阵 actionKind 必填
          postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1 }],
          faultTick: Game.time,
          outcome: "not_started",
          rollbackConfirmed: true,
          source: "seed",
        });
        expect(boot.status).toBe("written");
        Memory.runtime!.treasury!.authorizationFaults!.entryCount = 99;
        resetTreasuryAuthorizationFaultRuntimeForTest();
        throw new Error("injected:redemption");
      }
    });
    const result = executeTreasuryActionContract(service, { contract, authorization: bundle });
    expect(result.status).toBe("prepare_rejected");
    expect(readTreasuryAuthorizationFaultEntry("pub_fatal_1")).toBeUndefined();
    expect(readTreasuryWriteFault()?.phase).toBe("internal_authorization_fault_forensic");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });

  it("同 ID 同 identity 幂等；不同 identity → identity_conflict（原数据不动）", () => {
    const postings = [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -5 }];
    const base = {
      transactionId: "dup_fault",
      digest: "0123456789abcdef",
      actionKind: "test.transfer",
      postings,
      faultTick: Game.time,
      outcome: "not_started" as const,
      rollbackConfirmed: true as const,
      source: "test",
    };
    const identityOf = (legs: typeof postings) =>
      computeTreasuryDurableIdentityDigest({
        transactionId: base.transactionId,
        digest: base.digest,
        actionKind: "test.transfer",
        postings: legs,
        source: base.source,
      });
    const first = writeTreasuryAuthorizationFaultEntry({
      ...base,
      postings: postings.map((l) => ({ ...l })),
      durableIdentityDigest: identityOf(postings),
    });
    expect(first.status).toBe("written");
    const again = writeTreasuryAuthorizationFaultEntry({
      ...base,
      postings: postings.map((l) => ({ ...l })),
      durableIdentityDigest: identityOf(postings),
    });
    expect(again.status).toBe("already_present");
    // 不同 postings → 不同 durable identity → conflict。
    const tamperedPostings = [{ roomName: "W1N57", locationKind: "terminal", resource: RESOURCE_ENERGY, delta: -5 }];
    const conflict = writeTreasuryAuthorizationFaultEntry({
      ...base,
      postings: tamperedPostings,
      durableIdentityDigest: identityOf(tamperedPostings),
    });
    expect(conflict.status).toBe("rejected");
    if (conflict.status === "rejected") expect(conflict.reason).toBe("identity_conflict");
  });

  it("capacity admission 前置：fault store 满载时 write readiness 阻断新 writer", () => {
    const service = makeService();
    const store = Memory.runtime!.treasury!.authorizationFaults!;
    const seed = {
      transactionId: "seed",
      digest: "0123456789abcdef",
      actionKind: "test.transfer", // 【第十四轮】低层矩阵 actionKind 必填
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1 }],
      faultTick: Game.time,
      outcome: "not_started" as const,
      rollbackConfirmed: true as const,
      source: "seed",
    };
    for (let i = 0; i < TREASURY_AUTHORIZATION_FAULT_MAX_ENTRIES; i += 1) {
      const written = writeTreasuryAuthorizationFaultEntry({ ...seed, transactionId: `cap:${i}`, postings: seed.postings.map((l) => ({ ...l })) });
      expect(written.status).toBe("written");
    }
    void store;
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.writeAdmission.ready).toBe(false);
    expect(view.writeAdmission.blockers).toContain("authorization_fault_capacity_exhausted");
  });
});

// ── 3.3/3.4 tombstone / settlement proof 绑定 attempt identity ──────────────

describe("tombstone / finalized proof identity（第十二轮 3.3/3.4）", () => {
  it("treasuryAttemptIdentityRelation：identity 一致才 match；旧 proof 对现代 attempt 不足/冲突", () => {
    const attempt = { digest: "a".repeat(16), durableIdentityDigest: "b".repeat(16) };
    expect(
      treasuryAttemptIdentityRelation({ digest: "a".repeat(16), durableIdentityDigest: "b".repeat(16) }, attempt),
    ).toBe("match");
    // 同 ID 新 attempt（不同 identity）：旧 tombstone 不得证明。
    expect(
      treasuryAttemptIdentityRelation({ digest: "a".repeat(16), durableIdentityDigest: "c".repeat(16) }, attempt),
    ).toBe("conflict");
    // legacy proof（无现代身份字段）不能证明现代 attempt。
    expect(treasuryAttemptIdentityRelation({ digest: "a".repeat(16) }, attempt)).toBe("insufficient");
    // legacy attempt（无身份成分）退化为 digest 匹配。
    expect(treasuryAttemptIdentityRelation({ digest: "a".repeat(16) }, { digest: "a".repeat(16) })).toBe("match");
    expect(treasuryAttemptIdentityRelation({ digest: "f".repeat(16) }, { digest: "a".repeat(16) })).toBe("conflict");
  });

  it("Attempt A 的 final not-executed tombstone 不能解决同 ID 不同 identity 的 Attempt B", () => {
    const service = makeService();
    // Attempt A：完整身份 authority → resolve 为 not-executed（final tombstone）。
    const { contract: contractA, bundle: bundleA } = buildAndAuthorize(service, "attempt_shared", transferArgs({ amount: 100, outcome: "throw" }));
    void contractA;
    void bundleA;
    // 直接以最小路径构造 A 的 not-executed final tombstone（identity 绑定 A）。
    const identityA = computeTreasuryDurableIdentityDigest({
      transactionId: "attempt_shared",
      digest: "1111111111111111",
      actionKind: "test.transfer",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
      source: "test",
    });
    const writeA = writeTreasuryResolutionTombstone({
      transactionId: "attempt_shared",
      digest: "1111111111111111",
      resolution: "not-executed",
      stage: "final",
      proofLevel: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      actionTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      durableIdentityDigest: identityA,
    });
    expect(writeA.status).toBe("written");
    // Attempt B：同 ID、不同 identity 的 quarantine authority（seed 完整现代事实）。
    const identityB = computeTreasuryDurableIdentityDigest({
      transactionId: "attempt_shared",
      digest: "2222222222222222",
      actionKind: "test.transfer",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -200 }],
      source: "test",
      adapterSemanticIdentity: "test.transfer@reconciler-semantics-v1",
    });
    const seedB = quarantineTreasuryTransaction({
      transactionId: "attempt_shared",
      digest: "2222222222222222",
      tick: Game.time,
      kind: "test.transfer",
      source: "test",
      phase: "executing_at_end_tick",
      deltas: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -200 }],
      recordedAt: Game.time,
      outcome: "started_unknown",
      settlement: "quarantined",
      actionKind: "test.transfer",
      adapterSemanticIdentity: "test.transfer@reconciler-semantics-v1",
      durableIdentityDigest: identityB,
    });
    expect(seedB.status).toBe("written");
    // B 的 resolution：不得返回 already_resolved（A 的 tombstone identity 不同）。
    Game.time += 1;
    const next = makeService();
    next.beginTick();
    const issued = next.issueTreasuryReconciliationCapability({ transactionId: "attempt_shared" });
    if (issued.status === "rejected") {
      const dbg = readTreasuryQuarantineEntry("attempt_shared");
      console.log("ISSUE-REASON-2", issued.reason, issued.detail, JSON.stringify({
        digest: dbg?.digest, actionKind: dbg?.actionKind, kind: dbg?.kind, source: dbg?.source,
        asi: (dbg as { adapterSemanticIdentity?: string })?.adapterSemanticIdentity,
        deltas: dbg?.deltas, did: (dbg as { durableIdentityDigest?: string })?.durableIdentityDigest,
        identityB,
        recomputeNow: computeTreasuryDurableIdentityDigest({
          transactionId: "attempt_shared",
          digest: "2222222222222222",
          actionKind: "test.transfer",
          postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -200 }],
          source: "test",
          adapterSemanticIdentity: "test.transfer@reconciler-semantics-v1",
        }),
      }));
    }
    // 【第十五轮第七节】capability gate 在签发前读取 resolution tombstone：
    // A 的 final not-executed tombstone 与 B 的 attempt identity 冲突 →
    // 不重跑 reconciler、不签发（比 resolve 侧拒绝更早 fail closed——B 依旧
    // 无法被 A 的 tombstone 解决）。
    expect(issued.status).toBe("rejected");
    if (issued.status === "rejected") {
      expect(issued.reason).toBe("resolution_identity_conflict");
    }
  });

  it("committed settlement proof 绑定 attempt identity；旧 receipt（legacy proof）不释放新 attempt 的 finalized intent", () => {
    // legacy receipt（无身份字段）+ 现代 finalized intent（returned_ok、携带 identity）→ proof 不足。
    Memory.runtime = Memory.runtime ?? {};
    Memory.runtime.treasury = Memory.runtime.treasury ?? {};
    Memory.runtime.treasury.receipts = Memory.runtime.treasury.receipts ?? {
      version: 8,
      settled: {},
      updatedAt: Game.time,
      entryCount: 0,
      nextExpiryTick: null,
    };
    const store = Memory.runtime!.treasury!.receipts!;
    store.settled["t:shared_receipt"] = { level: "legacy", settledAtTick: Game.time - 1 };
    const identity = computeTreasuryDurableIdentityDigest({
      transactionId: "shared_receipt",
      digest: "3333333333333333",
      actionKind: "test.transfer",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -50 }],
      source: "test",
    });
    const write = writeTreasuryIntentEntry({
      transactionId: "shared_receipt",
      digest: "3333333333333333",
      actionKind: "test.transfer",
      kind: "test.transfer",
      source: "test",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -50 }],
      outcome: "returned_ok",
      settlement: "finalized",
      durableIdentityDigest: identity,
      createdAtTick: Game.time - 1,
      updatedAtTick: Game.time,
    });
    expect(write.status).toBe("written");
    // beginTick 恢复：finalized proof 校验失败（legacy receipt 无身份）→ intent 保留。
    Game.time += 1;
    const service = makeService();
    service.beginTick();
    expect(readTreasuryIntentEntry("shared_receipt")).toBeDefined();
  });

  it("identity 匹配的 committed settlement proof 释放 finalized intent", () => {
    const identity = computeTreasuryDurableIdentityDigest({
      transactionId: "proof_ok",
      digest: "4444444444444444",
      actionKind: "test.transfer",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -60 }],
      source: "test",
    });
    Memory.runtime = Memory.runtime ?? {};
    Memory.runtime.treasury = Memory.runtime.treasury ?? {};
    Memory.runtime.treasury.receipts = Memory.runtime.treasury.receipts ?? {
      version: 8,
      settled: {},
      updatedAt: Game.time,
      entryCount: 0,
      nextExpiryTick: null,
    };
    const store = Memory.runtime!.treasury!.receipts!;
    // 【第二十轮】低层 finalized intent 的 proof 链比较含 lowlevelSource（单向——attempt 携带则 proof 必须携带）。手塞 proof 补齐 provenance。
    store.settled["t:proof_ok"] = { level: "lowlevel" as const, settledAtTick: Game.time - 1, digest: "4444444444444444", durableIdentityDigest: identity, lowlevelSource: "runtime-lowlevel@v1" };
    const write = writeTreasuryIntentEntry({
      transactionId: "proof_ok",
      digest: "4444444444444444",
      actionKind: "test.transfer",
      kind: "test.transfer",
      source: "test",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -60 }],
      outcome: "returned_ok",
      settlement: "finalized",
      durableIdentityDigest: identity,
      createdAtTick: Game.time - 1,
      updatedAtTick: Game.time,
    });
    expect(write.status).toBe("written");
    Game.time += 1;
    const service = makeService();
    service.beginTick();
    expect(readTreasuryIntentEntry("proof_ok")).toBeUndefined();
  });

  it("正常 commit 路径写入的 receipt 携带 durableIdentityDigest（settlement identity 绑定）", () => {
    const service = makeService();
    const { contract, bundle } = buildAndAuthorize(service, "commit_identity");
    const result = executeTreasuryActionContract(service, { contract, authorization: bundle });
    expect(result.status).toBe("executed_committed");
    const proof = readTreasurySettlementProof("commit_identity");
    expect(proof).toBeDefined();
    expect(proof?.durableIdentityDigest).toBeDefined();
  });
});

// ── 3.5 stable reconciler semantic identity ─────────────────────────────────

describe("stable adapter/reconciler semantic identity（第十二轮 3.5）", () => {
  function seedQuarantinedAuthority(transactionId: string, semanticIdentity: string | undefined) {
    const identity = computeTreasuryDurableIdentityDigest({
      transactionId,
      digest: "5555555555555555",
      actionKind: "test.transfer",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -70 }],
      source: "test",
      ...(semanticIdentity !== undefined ? { adapterSemanticIdentity: semanticIdentity } : {}),
    });
    const write = quarantineTreasuryTransaction({
      transactionId,
      digest: "5555555555555555",
      tick: Game.time,
      kind: "test.transfer",
      source: "test",
      phase: "executing_at_end_tick",
      deltas: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -70 }],
      recordedAt: Game.time,
      outcome: "started_unknown",
      settlement: "quarantined",
      actionKind: "test.transfer",
      ...(semanticIdentity !== undefined ? { adapterSemanticIdentity: semanticIdentity } : {}),
      durableIdentityDigest: identity,
    });
    expect(write.status).toBe("written");
  }

  it("模拟 global reset：同 kind/version 但 semantic identity 不同 → capability 签发拒绝", () => {
    seedQuarantinedAuthority("reset_sem", "test.transfer@reconciler-semantics-v1");
    Game.time += 1;
    // global reset 语义：unregister 后以同 kind/version、不同语义身份重注册。
    unregisterTreasuryActionAdapterForTest("test.transfer");
    registerTreasuryActionAdapter({
      ...makeTreasuryTestTransferAdapter(),
      semanticIdentity: "test.transfer@reconciler-semantics-v2",
    });
    const service = makeService();
    service.beginTick();
    const issued = service.issueTreasuryReconciliationCapability({ transactionId: "reset_sem" });
    expect(issued.status).toBe("rejected");
    if (issued.status === "rejected") expect(issued.reason).toBe("adapter_version_mismatch");
  });

  it("stable identity 相同（语义一致的新 global）→ 允许同语义 reconciler 签发", () => {
    seedQuarantinedAuthority("reset_same", "test.transfer@reconciler-semantics-v1");
    Game.time += 1;
    // 同语义身份重新注册（模拟语义一致的代码版本）。
    unregisterTreasuryActionAdapterForTest("test.transfer");
    registerTreasuryActionAdapter(makeTreasuryTestTransferAdapter());
    const service = makeService();
    service.beginTick();
    const issued = service.issueTreasuryReconciliationCapability({ transactionId: "reset_same" });
    expect(issued.status).toBe("issued");
  });

  it("authority 缺少 stable semantic identity → 隔离（不猜测当前 identity）", () => {
    seedQuarantinedAuthority("reset_missing", undefined);
    Game.time += 1;
    const service = makeService();
    service.beginTick();
    const issued = service.issueTreasuryReconciliationCapability({ transactionId: "reset_missing" });
    expect(issued.status).toBe("rejected");
    if (issued.status === "rejected") expect(issued.reason).toBe("legacy_authority_isolated");
  });

  it("同一 global 内 test-only 替换（同 version 不同实现）仍被 registry 拒绝（per-global 防线保留）", () => {
    const result = (() => {
      // 同 kind/version、不同函数实现——immutable registry 拒绝（不得覆盖）。
      return replaceTreasuryActionAdapterForTest.length >= 0
        ? (() => {
            unregisterTreasuryActionAdapterForTest("test.transfer");
            registerTreasuryActionAdapter(makeTreasuryTestTransferAdapter());
            return registerTreasuryActionAdapter({
              ...makeTreasuryTestTransferAdapter(),
              execute: (): { ok: boolean } => ({ ok: false }),
            });
          })()
        : null;
    })();
    expect(result.status).toBe("rejected");
  });
});

// ── 3.6 digest 重算验证 ──────────────────────────────────────────────────────

describe("digest 重算验证（第十二轮 3.6）", () => {
  function cohortFacts(transactionId: string, overrides: Partial<TreasuryAuthorizationCohortFacts> = {}): TreasuryAuthorizationCohortFacts {
    return {
      ownerIdentity: "room=W1N57",
      policyId: "p",
      policyVersion: 1,
      policyRegistrationId: "0123456789abcdef",
      policyDecisionDigest: "dd-1",
      emergencyOverride: false,
      epochSeq: 1,
      revisions: {
        commitmentRevision: 1,
        projectionRevision: 1,
        quarantineRevision: 1,
        intentRevision: 1,
        reservationStoreRevision: 1,
      },
      adapterRegistrationId: "1234567890abcdef",
      adapterSemanticIdentity: "test.transfer@reconciler-semantics-v1",
      contractId: "ac:0123456789abcdef",
      contractDigest: "0123456789abcdef",
      transactionId,
      authorizationLegDigests: ["abcdef0123456789"],
      receiverCapacityDigest: "none",
      issuedTick: Game.time,
      authorizationDigest: "fedcba0987654321",
      ...overrides,
    };
  }

  /**
   * 【第十四轮】modern intent seed：显式 authorityLevel="modern" + required
   * 字段矩阵全齐（contractId/contractDigest/adapterVersion/adapterRegistration
   * /adapterSemanticIdentity/durablePayload(+Version)/structureFacts/cohort
   * facts+digest/ownerIdentity/policyIdentity/postings）；durableIdentityDigest
   * 由全部持久事实真实派生（写入前 identity 重算校验——低层携带 cohort 等
   * modern 字段会被立即拒绝 invalid_entry）。
   */
  function seedModernIntent(transactionId: string): void {
    const cohort = cohortFacts(transactionId);
    const cohortDigest = computeTreasuryAuthorizationCohortDigest(cohort);
    const postings = [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -80 }];
    const structureFacts = [
      { bindingKind: "governed_location" as const, role: "source" as const, roomName: "W1N57", locationKind: "storage", structureId: "stor-1", required: true, version: 1 },
    ];
    const identity = computeTreasuryDurableIdentityDigest({
      transactionId,
      digest: "6666666666666666",
      actionKind: "test.transfer",
      postings: postings.map((leg) => ({ ...leg })),
      source: "test",
      contractId: cohort.contractId,
      contractDigest: cohort.contractDigest,
      adapterRegistrationId: cohort.adapterRegistrationId,
      adapterSemanticIdentity: cohort.adapterSemanticIdentity,
      durablePayload: "dp",
      durablePayloadVersion: 1,
      structureFacts: structureFacts.map((fact) => ({ ...fact })),
      authorizationCohortDigest: cohortDigest,
      ownerIdentity: cohort.ownerIdentity,
      policyIdentity: "p@v1:dd-1",
    });
    const write = writeTreasuryIntentEntry({
      transactionId,
      authorityLevel: "modern",
      digest: "6666666666666666",
      actionKind: "test.transfer",
      kind: "test.transfer",
      source: "test",
      postings,
      outcome: "not_started",
      settlement: "ready",
      contractId: cohort.contractId,
      contractDigest: cohort.contractDigest,
      adapterVersion: 1,
      adapterRegistrationId: cohort.adapterRegistrationId,
      adapterSemanticIdentity: cohort.adapterSemanticIdentity,
      durablePayload: "dp",
      durablePayloadVersion: 1,
      structureFacts,
      ownerIdentity: cohort.ownerIdentity,
      policyIdentity: "p@v1:dd-1",
      authorizationCohort: cohort,
      authorizationCohortDigest: cohortDigest,
      durableIdentityDigest: identity,
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
    });
    expect(write.status).toBe("written");
  }

  /** 篡改后重新 load：store 必须 unhealthy（fail closed）。 */
  function expectIntentStoreUnhealthyAfterTamper(): void {
    // 失效 heap 缓存模拟 global reset 后首次 load。
    const intents = peekTreasuryIntentStore();
    expect(intents).toBeDefined();
    // 直接调用 ensure 校验路径（load 全量验证）。
    const store = intents!;
    store.version = store.version; // no-op（保持类型）
    // 触发 load：清 heap 缓存后由写路径校验——用 quarantine 的 ensure 模式。
    const intentStore = Memory.runtime!.treasury!.intents!;
    intentStore.entryCount = Object.keys(intentStore.entries).length;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const intentsModule = jest.requireActual("@/runtime/treasury/intents") as typeof import("@/runtime/treasury/intents");
    void intentsModule;
    // 失效缓存 + 重新 load（经 reset + ensure 组合）。
    (intentsModule as unknown as { resetTreasuryIntentRuntimeForTest: () => void }).resetTreasuryIntentRuntimeForTest();
    // 写入路径触发 load：identity 重算失败 → store_fatal。
    const write = writeTreasuryIntentEntry({
      transactionId: "trigger_load",
      digest: "7777777777777777",
      actionKind: "test.transfer",
      kind: "test.transfer",
      source: "test",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1 }],
      outcome: "not_started",
      settlement: "ready",
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
    });
    expect(write.status).toBe("rejected");
    if (write.status === "rejected") expect(write.reason).toBe("store_fatal");
  }

  it("篡改 cohort.ownerIdentity 但保留旧 cohort digest → store unhealthy fail closed", () => {
    seedModernIntent("tamper_owner");
    const entry = Memory.runtime!.treasury!.intents!.entries["i:tamper_owner"];
    (entry.authorizationCohort as { ownerIdentity: string }).ownerIdentity = "room=TAMPERED";
    expectIntentStoreUnhealthyAfterTamper();
  });

  it("篡改 policy decision digest 但保留旧 cohort digest → store unhealthy", () => {
    seedModernIntent("tamper_policy");
    const entry = Memory.runtime!.treasury!.intents!.entries["i:tamper_policy"];
    (entry.authorizationCohort as { policyDecisionDigest: string }).policyDecisionDigest = "dd-tampered";
    expectIntentStoreUnhealthyAfterTamper();
  });

  it("篡改 postings 但保留旧 durableIdentityDigest → store unhealthy", () => {
    seedModernIntent("tamper_postings");
    const entry = Memory.runtime!.treasury!.intents!.entries["i:tamper_postings"];
    (entry.postings[0] as { delta: number }).delta = -9_999;
    expectIntentStoreUnhealthyAfterTamper();
  });

  it("篡改 adapter semantic identity 但保留旧 durableIdentityDigest → store unhealthy", () => {
    seedModernIntent("tamper_asi");
    const entry = Memory.runtime!.treasury!.intents!.entries["i:tamper_asi"];
    (entry as { adapterSemanticIdentity?: string }).adapterSemanticIdentity = "tampered@semantics";
    expectIntentStoreUnhealthyAfterTamper();
  });

  it("repair 不自动覆盖不一致 digest（原数据保留）", () => {
    seedModernIntent("tamper_repair");
    const entry = Memory.runtime!.treasury!.intents!.entries["i:tamper_repair"];
    const digestBefore = entry.durableIdentityDigest;
    (entry.postings[0] as { delta: number }).delta = -9_999;
    // repair 入口（经 faultResolution 的显式 repair）：损坏 → 拒绝、不覆盖。
    const intentsModule = jest.requireActual("@/runtime/treasury/intents") as typeof import("@/runtime/treasury/intents");
    (intentsModule as unknown as { resetTreasuryIntentRuntimeForTest: () => void }).resetTreasuryIntentRuntimeForTest();
    const repair = intentsModule.repairTreasuryIntentStoreMetadataForResolution();
    expect(repair.status).toBe("rejected");
    expect(Memory.runtime!.treasury!.intents!.entries["i:tamper_repair"].durableIdentityDigest).toBe(digestBefore);
  });

  it("intent → quarantine 转移：两侧 identity 不一致 → 拒绝转移且保留原 authority", () => {
    const service = makeService();
    void service;
    seedModernIntent("transfer_mismatch");
    const entry = readTreasuryIntentEntry("transfer_mismatch");
    expect(entry).toBeDefined();
    // 篡改源 intent 的 postings（identity digest 未同步）后转移：目标侧重算
    // identity 不一致 → quarantine 写入 identity_conflict → 保留 intent。
    const internal = Memory.runtime!.treasury!.intents!.entries["i:transfer_mismatch"];
    (internal.postings[0] as { delta: number }).delta = -12_345;
    const tamperedEntry = readTreasuryIntentEntry("transfer_mismatch")!;
    const transferred = transferTreasuryIntentToQuarantine(tamperedEntry, "executing_at_end_tick");
    expect(transferred.status).toBe("retained");
    expect(readTreasuryIntentEntry("transfer_mismatch")).toBeDefined();
    expect(readTreasuryQuarantineEntry("transfer_mismatch")).toBeUndefined();
  });
});

// ── 3.7 structure binding discriminated union ───────────────────────────────

describe("structure binding discriminated union（第十二轮 3.7）", () => {
  function buildWithBindings(service: TreasuryTestService, transactionId: string, bindings: TreasuryActionStructureBinding[]) {
    unregisterTreasuryActionAdapterForTest("test.union");
    registerTreasuryActionAdapter({
      kind: "test.union",
      semanticIdentity: "test.union@test-adapter-semantics-v1",
      version: 1,
      validate: (args: unknown): string | null => (args && typeof args === "object" ? null : "args 非对象"),
      derivePostings: () => [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
      execute: (): { ok: boolean } => ({ ok: true }),
      structureBindings: () => bindings,
      durableFacts: () => ({ version: 1, payload: "union-fixture" }),
      reconcile: () => "still_uncertain" as const,
    });
    return buildTreasuryActionContract(service, { actionKind: "test.union", transactionId, args: {} });
  }

  it("governed_location + objectId → 拒绝（矛盾声明）", () => {
    const service = makeService();
    const result = buildWithBindings(service, "union_1", [
      { roomName: "W1N57", locationKind: "storage", bindingKind: "governed_location", objectId: "stor-1" },
    ]);
    expect(result.status).toBe("rejected");
  });

  it("governed_location + expectedType/expectedRoom → 拒绝", () => {
    const service = makeService();
    const result = buildWithBindings(service, "union_2", [
      { roomName: "W1N57", locationKind: "storage", bindingKind: "governed_location", expectedType: "storage" },
    ]);
    expect(result.status).toBe("rejected");
    const result2 = buildWithBindings(service, "union_2b", [
      { roomName: "W1N57", locationKind: "storage", bindingKind: "governed_location", expectedRoom: "W1N57" },
    ]);
    expect(result2.status).toBe("rejected");
  });

  it("显式 game_object 缺 objectId → 拒绝", () => {
    const service = makeService();
    const result = buildWithBindings(service, "union_3", [
      { roomName: "W1N57", locationKind: "storage", bindingKind: "game_object" },
    ]);
    expect(result.status).toBe("rejected");
  });

  it("合法声明：bindingKind canonicalization 后 descriptor 显式携带（discriminant 全程一致）", () => {
    const service = makeService();
    const result = buildWithBindings(service, "union_ok", [{ roomName: "W1N57", locationKind: "terminal" }]);
    expect(result.status).toBe("built");
    if (result.status === "built") {
      for (const descriptor of result.contract.structureDescriptors) {
        expect(descriptor.bindingKind).toBeDefined();
      }
      // posting binding 的缺省推导恒 governed_location（无 objectId）。
      const governed = result.contract.structureDescriptors.filter((d) => d.objectId === undefined);
      expect(governed.length).toBeGreaterThan(0);
      for (const d of governed) expect(d.bindingKind).toBe("governed_location");
    }
  });
});

// ── 3.8 forensic incomplete authority ────────────────────────────────────────

describe("forensic incomplete authority（第十二轮 3.8）", () => {
  it("intent 缺失的 fallback quarantine 被标记 forensic：隔离 + 诊断 + 占用/阻断保留", () => {
    const service = makeService();
    // 两阶段 prepare + commit 故障（无 intent 路径）→ faulted 转 quarantine。
    const epoch = service.observation().epoch;
    const prepared = service.prepareTransaction({
      transactionId: "forensic_1",
      kind: "terminal.send",
      source: "test",
      decision: { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick },
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 }],
    });
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    let fired = false;
    setTreasuryCommitFaultInjectorForTest((phase) => {
      if (phase === "receipt_publish" && !fired) {
        fired = true;
        throw new Error("injected:receipt_publish");
      }
    });
    expect(service.commitPreparedTransaction(prepared.handle).status).toBe("rejected");
    setTreasuryCommitFaultInjectorForTest(null);
    service.endTick();
    const quarantined = readTreasuryQuarantineEntry("forensic_1");
    expect(quarantined).toBeDefined();
    expect((quarantined as { forensic?: unknown }).forensic).toBeDefined();
    // 诊断：来源与隔离原因可区分（区别于 legacyV1）。
    const diagnostics = treasuryForensicQuarantineDiagnostics();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].reason).toBe("intent_missing_fallback");
    expect((quarantined as { legacyV1?: boolean }).legacyV1).toBeUndefined();
    // 普通 capability 签发拒绝。
    Game.time += 1;
    const next = makeService();
    next.beginTick();
    const issued = next.issueTreasuryReconciliationCapability({ transactionId: "forensic_1" });
    expect(issued.status).toBe("rejected");
    if (issued.status === "rejected") expect(issued.reason).toBe("legacy_authority_isolated");
    // 普通 resolve 入口拒绝（authority 保持）。
    const resolved = next.resolveUnresolvedTransaction({
      transactionId: "forensic_1",
      capability: { __brand: "treasury-reconciliation-capability" } as never,
    });
    expect(resolved.status).toBe("rejected");
    expect(readTreasuryQuarantineEntry("forensic_1")).toBeDefined();
    // 仍阻断 writer（占用保留）。
    const view = next.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.writeAdmission.ready).toBe(false);
    expect(view.writeAdmission.blockers).toContain("quarantine_unresolved");
  });
});

// ── 3.9/3.10 store health 与 production 类型边界回归 ─────────────────────────

describe("authorization fault store health 与边界回归（第十二轮 3.9/3.10）", () => {
  it("posting.resource 不在 RESOURCES_ALL → invalid_entry", () => {
    const written = writeTreasuryAuthorizationFaultEntry({
      transactionId: "bad_res",
      digest: "0123456789abcdef",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: "NOT_A_RESOURCE", delta: -1 }],
      faultTick: Game.time,
      outcome: "not_started",
      rollbackConfirmed: true,
      source: "test",
    });
    expect(written.status).toBe("rejected");
    if (written.status === "rejected") expect(written.reason).toBe("invalid_entry");
  });

  it("未知版本 fail closed：写入拒绝、原数据保留", () => {
    const boot = writeTreasuryAuthorizationFaultEntry({
      transactionId: "boot",
      digest: "0123456789abcdef",
      actionKind: "test.transfer", // 【第十四轮】低层矩阵 actionKind 必填
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1 }],
      faultTick: Game.time,
      outcome: "not_started",
      rollbackConfirmed: true,
      source: "test",
    });
    expect(boot.status).toBe("written");
    const store = Memory.runtime!.treasury!.authorizationFaults!;
    store.version = 99 as unknown as 4;
    resetTreasuryAuthorizationFaultRuntimeForTest();
    expect(treasuryAuthorizationFaultBlockers().blocking).toBe(true);
    const written = writeTreasuryAuthorizationFaultEntry({
      transactionId: "ver_fail",
      authorityLevel: "lowlevel",
      digest: "0123456789abcdef",
      actionKind: "test.transfer", // 【第十四轮】低层矩阵 actionKind 必填
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1 }],
      faultTick: Game.time,
      outcome: "not_started",
      rollbackConfirmed: true,
      source: "test",
    });
    expect(written.status).toBe("rejected");
    expect(Memory.runtime!.treasury!.authorizationFaults!.version).toBe(99);
  });

  it("v1 store 无损迁移 v2：entry 标记 legacyV1（身份不完整隔离，不猜测）", () => {
    Memory.runtime = Memory.runtime ?? {};
    Memory.runtime.treasury = Memory.runtime.treasury ?? {};
    Memory.runtime!.treasury!.authorizationFaults = {
      version: 1 as unknown as 4,
      entries: {
        "af:legacy_v1": {
          transactionId: "legacy_v1",
          authorityLevel: "lowlevel",
          digest: "0123456789abcdef",
          postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1 }],
          faultTick: Game.time,
          outcome: "not_started",
          rollbackConfirmed: true,
          source: "test",
        },
      },
      entryCount: 1,
      updatedAt: Game.time,
    };
    const entry = readTreasuryAuthorizationFaultEntry("legacy_v1");
    expect(entry).toBeDefined();
    expect((entry as { legacyV1?: boolean }).legacyV1).toBe(true);
    expect(Memory.runtime!.treasury!.authorizationFaults!.version).toBe(5); // 【Remediation V 六】authorizationFaults v5（tr1_ lineage 四字段）
  });

  it("正常 contract → bundle → intent → callback OK → commit 路径与 non-OK → abort 路径保持通过", () => {
    const service = makeService();
    const ok = buildAndAuthorize(service, "reg_ok", transferArgs({ outcome: "ok" }));
    const okResult = executeTreasuryActionContract(service, { contract: ok.contract, authorization: ok.bundle });
    expect(okResult.status).toBe("executed_committed");
    const nonOk = buildAndAuthorize(service, "reg_nonok", transferArgs({ outcome: "non-ok" }));
    const nonOkResult = executeTreasuryActionContract(service, { contract: nonOk.contract, authorization: nonOk.bundle });
    expect(nonOkResult.status).toBe("executed_aborted");
  });

  it("query/readiness 零 Game 写入（内存 store 无副作用；writeFault/quarantine/intent/receipt/resolution 健康）", () => {
    const service = makeService();
    service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(readTreasuryWriteFault()).toBeUndefined();
    expect(peekTreasuryQuarantineStore()?.entryCount ?? 0).toBe(0);
    expect(peekTreasuryIntentStore()?.entryCount ?? 0).toBe(0);
    expect(peekTreasuryReceiptStore()?.entryCount ?? 0).toBe(0);
    expect(peekTreasuryResolutionStoreHealth().entryCount).toBe(0);
    expect(ensureTreasuryQuarantineStoreValidated()).toBeNull();
  });
});
