/**
 * 【第十三轮】Receipt Migration Safety 测试。
 *
 * 覆盖：
 * - 统一 normalized receipt lookup：v1/v2/v3 未迁移 store 的零写 legacy
 *   识别（合法数字不再判 corrupted；v1 裸键 raw-key 探测；未知版本不遗忘
 *   已可靠解释的合法 ID）；
 * - v3/v4 → v5 迁移：原子、幂等、碰撞/损坏/部分身份 fail closed（原 store
 *   保留）、migrated proof 显式 legacy committed、retention 清理；
 * - already_settled 零发布：compat 单阶段零 heap 变化、prepared/contract
 *   路径 callback 零调用与 bundle/intent 不消费；
 * - existing proof 的 identity-aware commit：match 幂等 / conflict fault /
 *   legacy(insufficient) 隔离不覆盖；
 * - identity-aware refresh 与 staged recovery：legacy 不覆盖、conflict 不
 *   finalize、match 可 finalize、insufficient 不释放、独立计数。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import {
  clearTreasuryPersistenceForTest,
  commitSettledReceipt,
  ensureTreasuryReceiptStore,
  hasSettledReceipt,
  peekTreasuryReceiptStore,
  readTreasuryReceiptEventCounters,
  readTreasurySettlementProof,
  refreshSettledReceiptForResolution,
  releaseAllTreasuryReceiptReservations,
  TREASURY_RECEIPT_RETENTION_TICKS,
  TREASURY_RECEIPT_VERSION,
  encodeReceiptKey,
} from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  buildTreasuryActionContract,
  executeTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  readTreasuryTestAdapterSideEffects,
  registerTreasuryActionAdapter,
  resetTreasuryTestAdapterSideEffectsForTest,
  type TreasuryTestTransferArgs,
} from "@/runtime/treasury/actionContracts";
import { readTreasuryIntentEntry, peekTreasuryIntentStore } from "@/runtime/treasury/intents";
import { readTreasuryQuarantineEntry, quarantineTreasuryTransaction } from "@/runtime/treasury/quarantine";
import {
  peekTreasuryResolutionStoreHealth,
  readTreasuryResolutionStoreCounters,
  readTreasuryResolutionTombstone,
  writeTreasuryResolutionTombstone,
} from "@/runtime/treasury/resolutionStore";
import { readTreasuryWriteFault } from "@/runtime/treasury/writeFault";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import { registerTreasuryPolicyResolver, makeNoReserveTreasuryPolicy } from "@/runtime/treasury/policyAuthority";
import { installRooms, type RoomSpec } from "@mock/treasury";
import type { TreasuryAuthorizationBundle } from "@/runtime/treasury/authorization";

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

function buildAndAuthorize(service: TreasuryTestService, transactionId: string, args: TreasuryTestTransferArgs = transferArgs()) {
  const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId, args });
  expect(built.status).toBe("built");
  if (built.status !== "built") throw new Error("unreachable");
  const authorized = service.authorizeTreasuryActionContract(built.contract);
  expect(authorized.status).toBe("authorized");
  if (authorized.status !== "authorized") throw new Error("unreachable");
  return { contract: built.contract, bundle: authorized.bundle as TreasuryAuthorizationBundle };
}

/** 直写未迁移 v3 receipt store（纯数字 value；heap 缓存冷态）。 */
function installV3Receipts(rawEntries: Record<string, number>, updatedAt = 100): void {
  // 测试环境 Game.time 从小值开始——相对 tick 夹取到 [1, Game.time] 合法域。
  const entries: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawEntries)) {
    // 只夹取下限（小时钟下负 tick 会被误判损坏）；未来 tick 保留（损坏语义）。
    entries[key] = Math.max(0, value);
  }
  clearTreasuryPersistenceForTest();
  Memory.runtime = Memory.runtime ?? {};
  Memory.runtime.treasury = Memory.runtime.treasury ?? {};
  Memory.runtime.treasury.receipts = {
    version: 3,
    settled: entries,
    updatedAt,
    entryCount: Object.keys(entries).length,
    nextExpiryTick:
      Object.keys(entries).length === 0
        ? null
        : Math.min(...Object.values(entries)) + TREASURY_RECEIPT_RETENTION_TICKS + 1,
  } as never;
}

/** 两阶段 prepare 输入（decision 绑定当前 shared observation epoch）。 */
function prepareInput(service: TreasuryTestService, transactionId: string, delta = -100): never {
  const epoch = service.observation().epoch;
  return {
    transactionId,
    kind: "terminal.send",
    source: "test",
    decision: { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick },
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta }],
  } as never;
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  resetTreasuryTestAdapterSideEffectsForTest();
  registerTreasuryActionAdapter(makeTreasuryTestTransferAdapter());
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
  // 相对 tick（Game.time - N）与 retention(5000) 远古条目均落在 [0, Game.time] 合法域。
  Game.time += 6_100;
});

// ── 4.2 query 零写识别 legacy ───────────────────────────────────────────────

describe("receipt migration：query 零写识别 legacy（第十三轮 4.2）", () => {
  it("原始 v3 数字 receipt：hasSettledReceipt 返回 settled tick 且 Memory 零写", () => {
    installV3Receipts({ [encodeReceiptKey("rm_q_v3")]: Game.time - 5 });
    const before = JSON.stringify(Memory.runtime!.treasury!.receipts);
    expect(hasSettledReceipt("rm_q_v3")).toBe(Game.time - 5);
    expect(JSON.stringify(Memory.runtime!.treasury!.receipts)).toBe(before);
    expect(peekTreasuryReceiptStore()!.version).toBe(3); // 未迁移
    // readTreasurySettlementProof 归一为显式 legacy proof 快照（零写）。
    expect(readTreasurySettlementProof("rm_q_v3")).toMatchObject({ level: "legacy", settledAtTick: Game.time - 5 });
    expect(JSON.stringify(Memory.runtime!.treasury!.receipts)).toBe(before);
  });

  it("v1 裸键 store：合法数字零写识别（raw key 探测）", () => {
    Memory.runtime = Memory.runtime ?? {};
    Memory.runtime.treasury = { receipts: { version: 1, settled: { rm_v1_bare: 42 } } as never };
    expect(hasSettledReceipt("rm_v1_bare")).toBe(42);
    expect((peekTreasuryReceiptStore() as { version?: number }).version).toBe(1);
  });

  it("v3 损坏数字（未来 tick）：query 不识别（不乐观放行）", () => {
    installV3Receipts({ [encodeReceiptKey("rm_q_bad")]: Game.time + 999 });
    expect(hasSettledReceipt("rm_q_bad")).toBeUndefined();
  });

  it("未知版本 store：已可靠解释的合法 ID 不被遗忘（整体仍 fail closed）", () => {
    installV3Receipts({ [encodeReceiptKey("rm_unk_ok")]: Game.time - 5 });
    (Memory.runtime!.treasury!.receipts as { version: number }).version = 99;
    expect(hasSettledReceipt("rm_unk_ok")).toBe(Game.time - 5);
  });
});

// ── 4.3 / 5.2 历史 receipt 阻断 callback 与零发布 ────────────────────────────

describe("receipt migration：Game callback 前的阻断（第十三轮 4.3 / 5.2）", () => {
  it("原始 v3 数字 receipt 存在：contract 路径在授权/执行入口即阻断（callback 零调用、bundle/intent 不创建）", () => {
    const service = makeService();
    const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "rm_exec_v3", args: transferArgs() });
    expect(built.status).toBe("built");
    if (built.status !== "built") throw new Error("unreachable");
    // 历史 receipt 在 Game callback 之前阻断：contract 授权 admission 命中
    // already_settled（bundle 不签发、执行不可达）。
    installV3Receipts({ [encodeReceiptKey("rm_exec_v3")]: Game.time - 1 });
    const authorized = service.authorizeTreasuryActionContract(built.contract);
    expect(authorized.status).toBe("rejected");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    expect(readTreasuryIntentEntry("rm_exec_v3")).toBeUndefined();
    expect(peekTreasuryIntentStore()).toBeUndefined();
    expect(readTreasuryWriteFault()).toBeUndefined();
  });

  it("原始 v3 数字 receipt 存在：直接 prepare 返回 already_settled、不签发 handle", () => {
    const service = makeService();
    installV3Receipts({ [encodeReceiptKey("rm_prep_v3")]: Game.time - 1 });
    const prepared = service.prepareTransaction(prepareInput(service, "rm_prep_v3"));
    expect(prepared.status).toBe("already_settled");
    if (prepared.status === "already_settled") {
      expect(prepared.firstRecordedAtTick).toBe(Game.time - 1);
    }
  });

  it("原始 v3 数字 receipt 存在：compat 单阶段登记 journal/overlay/projectionRevision 零变化", () => {
    const service = makeService();
    installV3Receipts({ [encodeReceiptKey("rm_compat_v3")]: Game.time - 1 });
    const before = service.journal().length;
    const beforeRecorded = service.metrics().transactionsRecorded;
    const beforeEnergy = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] }).projected;
    const input = {
      transactionId: "rm_compat_v3",
      kind: "test.transfer",
      source: "test",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
    };
    const recorded = (service as unknown as {
      recordAcceptedTransaction(input: unknown): { status: string };
    }).recordAcceptedTransaction(input);
    expect(recorded.status).toBe("already_settled");
    expect(service.journal().length).toBe(before);
    expect(service.metrics().transactionsRecorded).toBe(beforeRecorded);
    expect(service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] }).projected).toBe(beforeEnergy);
  });
});

// ── 4.4 迁移幂等与防重放 ────────────────────────────────────────────────────

describe("receipt v3 → v5 migration（第十三轮 4.4）", () => {
  it("admission 触发迁移后仍返回 already_settled；迁移只执行一次且幂等", () => {
    const service = makeService();
    installV3Receipts({ [encodeReceiptKey("rm_mig_1")]: Game.time - 3, [encodeReceiptKey("rm_mig_2")]: Game.time - 2 });
    const prepared = service.prepareTransaction(prepareInput(service, "rm_mig_new"));
    expect(prepared.status).toBe("prepared");
    // 迁移完成：v5 显式 legacy proof。
    const store = peekTreasuryReceiptStore()!;
    expect(store.version).toBe(TREASURY_RECEIPT_VERSION);
    expect(store.settled[encodeReceiptKey("rm_mig_1")]).toMatchObject({ level: "legacy", settledAtTick: Game.time - 3 });
    expect(readTreasuryReceiptEventCounters().migrationsExecuted).toBe(1);
    // 迁移后同 id admission 仍 already_settled（修复：对象 proof 不再漏判）。
    const replay = service.prepareTransaction(prepareInput(service, "rm_mig_1"));
    expect(replay.status).toBe("already_settled");
    // 再次触发 load：迁移不重复执行（版本已提升）。
    expect(readTreasuryReceiptEventCounters().migrationsExecuted).toBe(1);
  });

  it("v4 完整身份 proof 迁移为显式 modern（保留 attempt identity）；无身份对象 → legacy", () => {
    clearTreasuryPersistenceForTest();
    Memory.runtime = Memory.runtime ?? {};
    Memory.runtime.treasury = {
      receipts: {
        version: 4,
        settled: {
          [encodeReceiptKey("rm_v4_mod")]: { settledAtTick: Game.time - 10, digest: "1111111111111111", durableIdentityDigest: "2222222222222222" },
          [encodeReceiptKey("rm_v4_leg")]: { settledAtTick: Game.time - 11 },
        },
        updatedAt: 100,
        entryCount: 2,
        nextExpiryTick: Game.time - 10 + TREASURY_RECEIPT_RETENTION_TICKS + 1,
      },
    } as never;
    const service = makeService();
    expect(ensureTreasuryReceiptStore().version).toBe(TREASURY_RECEIPT_VERSION);
    expect(readTreasurySettlementProof("rm_v4_mod")).toMatchObject({
      level: "modern",
      digest: "1111111111111111",
      durableIdentityDigest: "2222222222222222",
    });
    expect(readTreasurySettlementProof("rm_v4_leg")).toMatchObject({ level: "legacy", settledAtTick: Game.time - 11 });
    void service;
  });

  it("迁移碰撞或损坏 value：原 store 不变、fail closed", () => {
    // 损坏 value（未来 tick）。
    installV3Receipts({ [encodeReceiptKey("rm_bad_val")]: Game.time + 1 });
    const service = makeService();
    const prepared = service.prepareTransaction(prepareInput(service, "rm_bad_new"));
    expect(prepared.status).toBe("rejected");
    if (prepared.status === "rejected") expect(prepared.reason).toBe("receipt_store_incompatible");
    expect((peekTreasuryReceiptStore() as { version?: number }).version).toBe(3); // 原样保留
    expect((peekTreasuryReceiptStore() as unknown as { settled?: Record<string, unknown> }).settled?.[encodeReceiptKey("rm_bad_val")]).toBe(Game.time + 1);
  });

  it("v4 部分身份（digest 与 durable 不成对）：无法安全定级 → fail closed 原 store 保留", () => {
    clearTreasuryPersistenceForTest();
    Memory.runtime = Memory.runtime ?? {};
    Memory.runtime.treasury = {
      receipts: {
        version: 4,
        settled: { [encodeReceiptKey("rm_v4_partial")]: { settledAtTick: Game.time - 10, digest: "1111111111111111" } },
        updatedAt: 100,
        entryCount: 1,
        nextExpiryTick: Game.time - 10 + TREASURY_RECEIPT_RETENTION_TICKS + 1,
      },
    } as never;
    const service = makeService();
    const prepared = service.prepareTransaction(prepareInput(service, "rm_v4_partial_new"));
    expect(prepared.status).toBe("rejected");
    expect((peekTreasuryReceiptStore() as { version?: number }).version).toBe(4);
  });

  it("migrated legacy receipt 的过期清理仍遵守 retention", () => {
    installV3Receipts({ [encodeReceiptKey("rm_old_ret")]: Game.time - TREASURY_RECEIPT_RETENTION_TICKS - 100 });
    const service = makeService();
    expect(ensureTreasuryReceiptStore().version).toBe(TREASURY_RECEIPT_VERSION);
    Game.time += 1;
    service.beginTick();
    expect(hasSettledReceipt("rm_old_ret")).toBeUndefined();
    expect(peekTreasuryReceiptStore()!.settled[encodeReceiptKey("rm_old_ret")]).toBeUndefined();
  });
});

// ── 5.2/5.3 existing proof 的 identity-aware commit ─────────────────────────

describe("existing proof 的 identity-aware commit（第十三轮 5.2/5.3）", () => {
  const identity = { digest: "1234567890abcdef", durableIdentityDigest: "fedcba0987654321" };

  it("match：already_settled_match（幂等——不重复写入）", () => {
    const service = makeService();
    void service;
    expect(commitSettledReceipt("ep_match", Game.time, identity).status).toBe("written");
    Game.time += 1;
    const result = commitSettledReceipt("ep_match", Game.time, identity);
    expect(result.status).toBe("already_settled_match");
    expect(readTreasuryReceiptEventCounters().receiptIdentityMatches).toBeGreaterThanOrEqual(1);
  });

  it("identity conflict：identity_conflict（不覆盖既有 proof）", () => {
    const service = makeService();
    void service;
    expect(commitSettledReceipt("ep_conflict", Game.time, identity).status).toBe("written");
    Game.time += 1;
    const result = commitSettledReceipt("ep_conflict", Game.time, {
      digest: "1234567890abcdef",
      durableIdentityDigest: "aaaaaaaaaaaaaaaa",
    });
    expect(result.status).toBe("identity_conflict");
    expect(readTreasuryReceiptEventCounters().receiptIdentityConflicts).toBeGreaterThanOrEqual(1);
    // 既有 proof 未被覆盖。
    expect(readTreasurySettlementProof("ep_conflict")).toMatchObject({ durableIdentityDigest: identity.durableIdentityDigest });
  });

  it("legacy proof：already_settled_insufficient（不覆盖、不冒充现代证明）", () => {
    const service = makeService();
    void service;
    // 写 legacy proof（compat 单阶段无 identity）。
    expect(commitSettledReceipt("ep_legacy", Game.time).status).toBe("written");
    Game.time += 1;
    const result = commitSettledReceipt("ep_legacy", Game.time, identity);
    expect(result.status).toBe("already_settled_insufficient");
    if (result.status === "already_settled_insufficient") expect(result.relation).toBe("legacy");
    // 不被覆盖为 modern。
    expect(readTreasurySettlementProof("ep_legacy")).toMatchObject({ level: "legacy" });
    // replay blocker 保留：同 id 查询仍已结算。
    expect(hasSettledReceipt("ep_legacy")).toBeDefined();
  });

  it("identity 部分提供（digest 与 durable 不成对）：fatal 拒绝（store 不变）", () => {
    const service = makeService();
    void service;
    const result = commitSettledReceipt("ep_partial", Game.time, { digest: "1234567890abcdef" });
    expect(result.status).toBe("fatal");
    expect(hasSettledReceipt("ep_partial")).toBeUndefined();
  });
});

// ── 第六/七节 identity-aware refresh 与 staged recovery ─────────────────────

describe("identity-aware refresh 与 staged recovery（第十三轮第六/七节）", () => {
  const identity = { digest: "1234567890abcdef", durableIdentityDigest: "fedcba0987654321" };

  it("resolving modern attempt 遇 legacy receipt：不覆盖、不 finalize、authority 保留", () => {
    const service = makeService();
    void service;
    // legacy receipt（无身份）+ resolving tombstone（携带 modern identity）。
    expect(commitSettledReceipt("rr_legacy", Game.time).status).toBe("written");
    const write = writeTreasuryResolutionTombstone({
      transactionId: "rr_legacy",
      digest: identity.digest,
      resolution: "committed",
      stage: "resolving",
      actionTick: Game.time,
      settledAtTick: Game.time + 10,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      reconcilerKind: "test",
      durableIdentityDigest: identity.durableIdentityDigest,
    });
    expect(write.status).not.toBe("rejected");
    Game.time += 20;
    service.beginTick(); // recovery：receipt tick < settledAtTick → 续做 refresh
    // refresh 被 legacy proof 阻断：不覆盖、tombstone 保持 resolving。
    expect(readTreasurySettlementProof("rr_legacy")).toMatchObject({ level: "legacy" });
    expect(readTreasuryResolutionTombstone("rr_legacy")?.stage).toBe("resolving");
    const counters = readTreasuryResolutionStoreCounters();
    expect(counters.identityInsufficientBlockers).toBeGreaterThanOrEqual(1);
  });

  it("resolving modern attempt 遇 conflicting modern receipt：不 finalize", () => {
    const service = makeService();
    void service;
    expect(commitSettledReceipt("rr_conflict", Game.time, identity).status).toBe("written");
    const write = writeTreasuryResolutionTombstone({
      transactionId: "rr_conflict",
      digest: identity.digest,
      resolution: "committed",
      stage: "resolving",
      actionTick: Game.time,
      settledAtTick: Game.time + 10,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      reconcilerKind: "test",
      durableIdentityDigest: "bbbbbbbbbbbbbbbb", // 不同 durable identity
    });
    expect(write.status).not.toBe("rejected");
    Game.time += 20;
    service.beginTick();
    expect(readTreasuryResolutionTombstone("rr_conflict")?.stage).toBe("resolving");
    expect(readTreasuryResolutionStoreCounters().identityConflicts).toBeGreaterThanOrEqual(1);
  });

  it("resolving modern attempt 遇 matching modern receipt：可 finalize", () => {
    const service = makeService();
    void service;
    expect(commitSettledReceipt("rr_match", Game.time, identity).status).toBe("written");
    const write = writeTreasuryResolutionTombstone({
      transactionId: "rr_match",
      digest: identity.digest,
      resolution: "committed",
      stage: "resolving",
      actionTick: Game.time,
      settledAtTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      reconcilerKind: "test",
      durableIdentityDigest: identity.durableIdentityDigest,
    });
    expect(write.status).not.toBe("rejected");
    Game.time += 1;
    service.beginTick();
    expect(readTreasuryResolutionTombstone("rr_match")?.stage).toBe("final");
  });

  it("final not-executed tombstone 对 modern authority 返回 insufficient：不释放 authority", () => {
    const service = makeService();
    void service;
    // modern-ish quarantine authority（lowlevel + durable identity + semantic identity）。
    const quarantineWrite = quarantineTreasuryTransaction({
      transactionId: "rr_ne",
      authorityLevel: "lowlevel",
      digest: "1234567890abcdef",
      tick: Game.time,
      kind: "test.transfer",
      source: "test",
      phase: "action_threw_execution_unknown",
      deltas: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
      recordedAt: Game.time,
      outcome: "started_unknown",
      settlement: "quarantined",
      durableIdentityDigest: "fedcba0987654321",
      adapterSemanticIdentity: "test.transfer@reconciler-semantics-v1",
    });
    expect(quarantineWrite.status).not.toBe("rejected");
    // tombstone 无现代身份（旧 proof 形态）。
    const tombWrite = writeTreasuryResolutionTombstone({
      transactionId: "rr_ne",
      digest: "1234567890abcdef",
      resolution: "not-executed",
      stage: "final",
      actionTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      reconcilerKind: "test",
    });
    expect(tombWrite.status).not.toBe("rejected");
    Game.time += 1;
    service.beginTick();
    // 释放被 identity 判定阻断（insufficient——tombstone 无现代身份）。
    expect(readTreasuryQuarantineEntry("rr_ne")).toBeDefined();
    expect(readTreasuryResolutionStoreCounters().identityInsufficientBlockers).toBeGreaterThanOrEqual(1);
  });

  it("staged committed recovery 返回 insufficient：不释放 quarantine/intent/marker", () => {
    const service = makeService();
    void service;
    expect(commitSettledReceipt("rr_staged", Game.time, identity).status).toBe("written");
    // resolving tombstone（无现代身份——legacy proof 对 modern receipt）。
    expect(
      writeTreasuryResolutionTombstone({
        transactionId: "rr_staged",
        digest: "1234567890abcdef",
        resolution: "committed",
        stage: "resolving",
        actionTick: Game.time,
        settledAtTick: Game.time + 10,
        observationTick: Game.time,
        resolvedAtTick: Game.time,
        reconcilerKind: "test",
        // attempt 携带 cohort digest 而 receipt proof 无 → relation=insufficient。
        durableIdentityDigest: identity.durableIdentityDigest,
        authorizationCohortDigest: "aaaaaaaaaaaaaaaa",
      }).status,
    ).not.toBe("rejected");
    Game.time += 20;
    service.beginTick();
    expect(readTreasuryResolutionTombstone("rr_staged")?.stage).toBe("resolving");
  });

  it("refresh 直接调用：conflict 拒绝刷新（保持 authority 语义）", () => {
    const service = makeService();
    void service;
    expect(commitSettledReceipt("rr_direct", Game.time, identity).status).toBe("written");
    Game.time += 5;
    const blocked = refreshSettledReceiptForResolution("rr_direct", Game.time, {
      digest: "1234567890abcdef",
      durableIdentityDigest: "cccccccccccccccc",
    });
    expect(blocked.status).toBe("blocked");
    if (blocked.status === "blocked") expect(blocked.reason).toBe("identity_conflict");
    expect(readTreasurySettlementProof("rr_direct")).toMatchObject({ durableIdentityDigest: identity.durableIdentityDigest });
  });

  it("match 路径保持正常（refresh 只更新 settledAtTick、保留身份）", () => {
    const service = makeService();
    void service;
    expect(commitSettledReceipt("rr_ok", Game.time, identity).status).toBe("written");
    Game.time += 5;
    const refreshed = refreshSettledReceiptForResolution("rr_ok", Game.time, identity);
    expect(refreshed.status).toBe("refreshed");
    expect(readTreasurySettlementProof("rr_ok")).toMatchObject({
      level: "modern",
      settledAtTick: Game.time,
      durableIdentityDigest: identity.durableIdentityDigest,
    });
  });

  it("unknown receipt version：admission fail closed（未知版本不放宽）", () => {
    Memory.runtime = Memory.runtime ?? {};
    Memory.runtime.treasury = {
      receipts: { version: 99, settled: {}, updatedAt: 1, entryCount: 0, nextExpiryTick: null },
    } as never;
    const service = makeService();
    const prepared = service.prepareTransaction(prepareInput(service, "rm_unk_new"));
    expect(prepared.status).toBe("rejected");
  });
});
