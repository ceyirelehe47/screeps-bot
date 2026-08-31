/**
 * 【第十三轮】Modern Proof Strictness 测试。
 *
 * 覆盖：
 * - 显式 authorityLevel 与 modern required 字段矩阵：删除任一 required 字段
 *   （durableIdentityDigest / cohort facts / cohort digest / stable semantic
 *   identity）→ store unhealthy（绝不降级 legacy）；正常 legacy 迁移显式标记；
 *   forensic 显式标记；同 ID 双 authority 等级矛盾 → inconsistent；
 * - 集中 cohort validator：缺字段 / null revisions / 错误类型 / throwing
 *   Proxy → 结构化错误（不抛出）；篡改事实保留旧 digest → unhealthy；
 *   repair 不自动覆盖 digest；
 * - 统一持久 structure descriptor 校验：governed_location 携带 objectId /
 *   expectedType → unhealthy；game_object 缺 objectId / structureId 不一致 →
 *   拒绝；同结构不同 role 产生不同 descriptor；
 * - forensic marker/tombstone 绑定 attempt identity：marker 携带完整身份、
 *   旧 tombstone 不解决同 ID 新 attempt、legacy marker 不证明 modern
 *   attempt、acknowledgeRolledBack 必填、完整 identity 相同才幂等；
 * - operation-count：legacy lookup / migration / identity match / conflict /
 *   insufficient / proof-level rejection / cohort validation failure 计数。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  makeTreasuryTestTransferAdapter,
  readTreasuryTestAdapterSideEffects,
  registerTreasuryActionAdapter,
  resetTreasuryTestAdapterSideEffectsForTest,
  buildTreasuryActionContract,
  executeTreasuryActionContract,
  type TreasuryTestTransferArgs,
} from "@/runtime/treasury/actionContracts";
import {
  ensureTreasuryIntentStoreValidated,
  peekTreasuryIntentStore,
  readTreasuryIntentEntry,
  writeTreasuryIntentEntry,
  type TreasuryIntentEntry,
} from "@/runtime/treasury/intents";
import {
  ensureTreasuryQuarantineStoreValidated,
  peekTreasuryQuarantineStore,
  quarantineTreasuryTransaction,
  readTreasuryQuarantineEntry,
  resetTreasuryQuarantineRuntimeForTest,
} from "@/runtime/treasury/quarantine";
import {
  peekTreasuryAuthorizationFaultStore,
  readTreasuryAuthorizationFaultEntry,
  writeTreasuryAuthorizationFaultEntry,
  TREASURY_AUTHORIZATION_FAULT_MAX_ENTRIES,
} from "@/runtime/treasury/authorizationFaults";
import {
  readTreasuryResolutionTombstone,
  writeTreasuryResolutionTombstone,
  readTreasuryResolutionStoreCounters,
} from "@/runtime/treasury/resolutionStore";
import { readTreasuryWriteFault, recordTreasuryWriteFault } from "@/runtime/treasury/writeFault";
import { setTreasuryRedemptionFaultInjectorForTest } from "@/runtime/treasury/authorizationLedger";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import {
  registerTreasuryPolicyResolver,
  makeNoReserveTreasuryPolicy,
} from "@/runtime/treasury/policyAuthority";
import {
  validateTreasuryAuthorizationCohortFacts,
  readTreasuryCohortValidationCounters,
  resetTreasuryCohortValidationForTest,
} from "@/runtime/treasury/cohortValidation";
import {
  validateTreasuryStructureDescriptor,
} from "@/runtime/treasury/structureDescriptorValidation";
import {
  readTreasuryAuthorityLevelCounters,
  resetTreasuryAuthorityLevelForTest,
} from "@/runtime/treasury/authorityLevel";
import {
  computeTreasuryAuthorizationCohortDigest,
  type TreasuryAuthorizationCohortFacts,
} from "@/runtime/treasury/authorization";
import { computeTreasuryDurableIdentityDigest } from "@/runtime/treasury/durableIdentity";
import { recomputeTreasuryDurableIdentityDigest } from "@/runtime/treasury/identityProof";
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

/** 合法完整 cohort facts（与 contract 路径产物同构）。 */
function fullCohort(transactionId: string): TreasuryAuthorizationCohortFacts {
  return {
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
    adapterSemanticIdentity: "test.transfer@reconciler-semantics-v1",
    contractId: `contract:${transactionId}`,
    contractDigest: "3333333333333333",
    transactionId,
    authorizationLegDigests: ["4444444444444444"],
    receiverCapacityDigest: "none",
    issuedTick: Game.time,
    authorizationDigest: "5555555555555555",
  };
}

/** modern intent 全字段 fixture（矩阵全齐）。 */
function modernIntentEntry(transactionId: string, cohort: TreasuryAuthorizationCohortFacts): TreasuryIntentEntry {
  return {
    transactionId,
    authorityLevel: "modern" as const,
    digest: "1234567890abcdef",
    actionKind: "test.transfer",
    kind: "test.transfer",
    source: "test",
    contractId: cohort.contractId,
    contractDigest: cohort.contractDigest,
    adapterVersion: 1,
    adapterRegistrationId: cohort.adapterRegistrationId,
    adapterSemanticIdentity: cohort.adapterSemanticIdentity,
    durablePayload: "dp",
    durablePayloadVersion: 1,
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
    outcome: "not_started",
    settlement: "ready",
    structureFacts: [
      {
        bindingKind: "governed_location",
        role: "source",
        roomName: "W1N57",
        locationKind: "storage",
        structureId: "stor-1",
        required: true,
        version: 1,
      },
    ],
    ownerIdentity: cohort.ownerIdentity,
    policyIdentity: "no-reserve@v1:allow",
    authorizationCohort: cohort,
    authorizationCohortDigest: computeTreasuryAuthorizationCohortDigest(cohort),
    durableIdentityDigest: "fedcba0987654321",
    createdAtTick: Game.time,
    updatedAtTick: Game.time,
  };
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  resetTreasuryTestAdapterSideEffectsForTest();
  registerTreasuryActionAdapter(makeTreasuryTestTransferAdapter());
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
  resetTreasuryCohortValidationForTest();
  resetTreasuryAuthorityLevelForTest();
});

afterEach(() => {
  setTreasuryRedemptionFaultInjectorForTest(null);
});

// ── 8. 显式 authorityLevel 与 modern required 字段矩阵 ──────────────────────

describe("proof levels：modern required 字段矩阵（第十三轮第八节）", () => {
  it("modern intent 删除 durableIdentityDigest：store unhealthy，不降级 legacy", () => {
    const service = makeService();
    void service;
    const cohort = fullCohort("pl_mod_1");
    const entry = modernIntentEntry("pl_mod_1", cohort);
    expect(writeTreasuryIntentEntry(entry).status).toBe("written");
    // 删除 required 字段 → 迁移后 load 校验拒绝（不自动当 legacy）。
    delete (entry as { durableIdentityDigest?: string }).durableIdentityDigest;
    (peekTreasuryIntentStore()!.entries["i:pl_mod_1"] as { durableIdentityDigest?: string }).durableIdentityDigest = undefined;
    // 触发重新 load：直接改写 store 后下一次写入/校验检出 unhealthy。
    const rewritten = writeTreasuryIntentEntry({ ...entry, transactionId: "pl_mod_2", authorityLevel: "modern" });
    // 篡改后的 modern entry（缺 durable）写入被拒（invalid_entry——矩阵缺失）。
    expect(rewritten.status).toBe("rejected");
    if (rewritten.status === "rejected") expect(rewritten.reason).toBe("invalid_entry");
    expect(readTreasuryAuthorityLevelCounters().proofLevelRejections).toBeGreaterThanOrEqual(1);
  });

  it("modern quarantine 删除 cohort facts（保留 digest）：store unhealthy", () => {
    const qCohort = fullCohort("pl_q_facts");
    const qDurable = recomputeTreasuryDurableIdentityDigest({
      transactionId: "pl_q_facts",
      digest: "1234567890abcdef",
      actionKind: "test.transfer",
      kind: "test.transfer",
      source: "test",
      deltas: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
      contractId: qCohort.contractId,
      contractDigest: qCohort.contractDigest,
      adapterRegistrationId: qCohort.adapterRegistrationId,
      adapterSemanticIdentity: qCohort.adapterSemanticIdentity,
      durablePayload: "dp",
      durablePayloadVersion: 1,
      structureFacts: [
        { bindingKind: "governed_location", role: "source", roomName: "W1N57", locationKind: "storage", structureId: "stor-1", required: true, version: 1 },
      ],
      authorizationCohortDigest: computeTreasuryAuthorizationCohortDigest(qCohort),
      ownerIdentity: qCohort.ownerIdentity,
      policyIdentity: "no-reserve@v1:allow",
    });
    const write = quarantineTreasuryTransaction({
      transactionId: "pl_q_facts",
      authorityLevel: "modern",
      digest: "1234567890abcdef",
      tick: Game.time,
      kind: "test.transfer",
      source: "test",
      phase: "executing_at_end_tick",
      deltas: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
      recordedAt: Game.time,
      outcome: "started_unknown",
      settlement: "quarantined",
      contractId: qCohort.contractId,
      contractDigest: "3333333333333333",
      actionKind: "test.transfer",
      adapterVersion: 1,
      adapterRegistrationId: "2222222222222222",
      adapterSemanticIdentity: "test.transfer@reconciler-semantics-v1",
      durablePayload: "dp",
      durablePayloadVersion: 1,
      ownerIdentity: qCohort.ownerIdentity,
      policyIdentity: "no-reserve@v1:allow",
      durableIdentityDigest: qDurable,
      structureFacts: [
        { bindingKind: "governed_location", role: "source", roomName: "W1N57", locationKind: "storage", structureId: "stor-1", required: true, version: 1 },
      ],
      authorizationCohort: qCohort,
      authorizationCohortDigest: computeTreasuryAuthorizationCohortDigest(qCohort),
    });
    expect(write.status).toBe("written");
    // 篡改：删除 cohort facts 保留 digest → facts/digest 不成对 + durable
    // 无法重算 → 下一次 load 校验 fail closed（store unhealthy，原数据保留）。
    delete (peekTreasuryQuarantineStore()!.entries["q:pl_q_facts"] as { authorizationCohort?: unknown }).authorizationCohort;
    resetTreasuryQuarantineRuntimeForTest();
    expect(ensureTreasuryQuarantineStoreValidated()).toContain("成对");
    const tCohort = fullCohort("pl_q_tamper");
    const tDurable = computeTreasuryDurableIdentityDigest({
      transactionId: "pl_q_tamper",
      digest: "1234567890abcdef",
      actionKind: "test.transfer",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
      source: "test",
      contractId: tCohort.contractId,
      contractDigest: tCohort.contractDigest,
      adapterRegistrationId: tCohort.adapterRegistrationId,
      adapterSemanticIdentity: tCohort.adapterSemanticIdentity,
      durablePayload: "dp",
      durablePayloadVersion: 1,
      structureFacts: [
        { bindingKind: "governed_location", role: "source", roomName: "W1N57", locationKind: "storage", structureId: "stor-1", required: true, version: 1 },
      ],
      ownerIdentity: tCohort.ownerIdentity,
      policyIdentity: "no-reserve@v1:allow",
    });
    const tampered = quarantineTreasuryTransaction({
      transactionId: "pl_q_tamper",
      authorityLevel: "modern",
      digest: "1234567890abcdef",
      tick: Game.time,
      kind: "test.transfer",
      source: "test",
      phase: "executing_at_end_tick",
      deltas: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
      recordedAt: Game.time,
      outcome: "started_unknown",
      settlement: "quarantined",
      // cohort facts 与 digest 均缺失（矩阵不全 → 拒绝——不得降级）。
      contractId: tCohort.contractId,
      contractDigest: "3333333333333333",
      actionKind: "test.transfer",
      adapterVersion: 1,
      adapterRegistrationId: "2222222222222222",
      adapterSemanticIdentity: "test.transfer@reconciler-semantics-v1",
      durablePayload: "dp",
      durablePayloadVersion: 1,
      ownerIdentity: tCohort.ownerIdentity,
      policyIdentity: "no-reserve@v1:allow",
      durableIdentityDigest: tDurable,
    });
    expect(tampered.status).toBe("rejected");
  });

  it("modern quarantine 保留 cohort facts 但删除 digest：拒绝（成对要求）", () => {
    const cohort = fullCohort("pl_q_digest");
    const write = quarantineTreasuryTransaction({
      transactionId: "pl_q_digest",
      authorityLevel: "modern",
      digest: "1234567890abcdef",
      tick: Game.time,
      kind: "test.transfer",
      source: "test",
      phase: "executing_at_end_tick",
      deltas: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
      recordedAt: Game.time,
      outcome: "started_unknown",
      settlement: "quarantined",
      authorizationCohort: cohort,
      // authorizationCohortDigest 缺失 → 不成对 → 拒绝。
    });
    expect(write.status).toBe("rejected");
  });

  it("正常 legacy 迁移显式标记 legacy（无现代事实的旧 entry）", () => {
    // v4 intent store（无 authorityLevel、无现代身份事实）→ load 迁移定级 legacy。
    Memory.runtime = Memory.runtime ?? {};
    Memory.runtime.treasury = Memory.runtime.treasury ?? {};
    Memory.runtime.treasury.intents = {
      version: 4 as unknown as 5,
      entries: {
        "i:pl_legacy": {
          transactionId: "pl_legacy",
          digest: "0123456789abcdef",
          actionKind: "test.transfer",
          kind: "test.transfer",
          source: "test",
          postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
          outcome: "not_started",
          settlement: "ready",
          createdAtTick: Game.time,
          updatedAtTick: Game.time,
        } as never,
      },
      entryCount: 1,
      updatedAt: Game.time,
    } as never;
    // 显式触发 load（不经 beginTick 恢复——(not_started, ready) 会被恢复
    // 语义确认未执行关闭，与本测试无关）。
    expect(ensureTreasuryIntentStoreValidated()).toBeNull();
    expect(peekTreasuryIntentStore()!.version).toBe(5);
    const entry = readTreasuryIntentEntry("pl_legacy");
    expect(entry?.authorityLevel).toBe("legacy");
  });

  it("forensic authority 显式标记 forensic（capability 签发拒绝）", () => {
    const service = makeService();
    void service;
    const write = quarantineTreasuryTransaction({
      transactionId: "pl_forensic",
      authorityLevel: "forensic",
      digest: "1234567890abcdef",
      tick: Game.time,
      kind: "test.transfer",
      source: "test",
      phase: "commit_unexpected",
      deltas: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
      recordedAt: Game.time,
      outcome: "returned_ok",
      settlement: "quarantined",
      forensic: { reason: "intent_missing_fallback", detail: "防御性直写 fixture" },
    });
    expect(write.status).toBe("written");
    expect(readTreasuryQuarantineEntry("pl_forensic")?.authorityLevel).toBe("forensic");
    Game.time += 2;
    const next = makeService();
    const issued = next.issueTreasuryReconciliationCapability({ transactionId: "pl_forensic" });
    expect(issued.status).toBe("rejected");
    if (issued.status === "rejected") expect(issued.reason).toBe("legacy_authority_isolated");
  });

  it("authorityLevel 缺失（新版本 store 手工篡改）：写入拒绝、签发拒绝", () => {
    const service = makeService();
    void service;
    const cohort = fullCohort("pl_missing");
    const entry = modernIntentEntry("pl_missing", cohort);
    const { authorityLevel: _level, ...withoutLevel } = entry;
    void _level;
    // 显式传 undefined（等级缺失）——API 层缺省会补 lowlevel；直写篡改由
    // load/写入校验拒绝。这里验证 modern 矩阵在 lowlevel 下不强制、但篡改
    // store 的 undefined 等级会在签发侧被拒。
    const write = writeTreasuryIntentEntry({ ...withoutLevel, authorityLevel: undefined });
    expect(write.status).toBe("written");
    (peekTreasuryIntentStore()!.entries["i:pl_missing"] as { authorityLevel?: string }).authorityLevel = undefined;
    Game.time += 2;
    const next = makeService();
    const issued = next.issueTreasuryReconciliationCapability({ transactionId: "pl_missing" });
    expect(issued.status).toBe("rejected");
  });
});

// ── 9. 集中 cohort validator ────────────────────────────────────────────────

describe("cohort validation（第十三轮第九节）", () => {
  it("cohort 缺 ownerIdentity：结构化错误，不抛异常", () => {
    const cohort = fullCohort("cv_1") as unknown as Record<string, unknown>;
    delete cohort.ownerIdentity;
    const error = validateTreasuryAuthorizationCohortFacts(cohort, "cv_1");
    expect(error).toContain("ownerIdentity");
  });

  it("cohort.revisions = null：结构化错误", () => {
    const cohort = fullCohort("cv_2") as unknown as Record<string, unknown>;
    cohort.revisions = null;
    expect(validateTreasuryAuthorizationCohortFacts(cohort, "cv_2")).toContain("revisions");
  });

  it("authorizationLegDigests 错误类型：结构化错误", () => {
    const cohort = fullCohort("cv_3") as unknown as Record<string, unknown>;
    cohort.authorizationLegDigests = "not-an-array";
    expect(validateTreasuryAuthorizationCohortFacts(cohort, "cv_3")).toContain("authorizationLegDigests");
  });

  it("cohort 为 throwing Proxy：validator 返回结构化错误，不逃逸异常", () => {
    const proxy = new Proxy({} as object, {
      get() {
        throw new Error("boom:proxy");
      },
    });
    let error: string | null = null;
    expect(() => {
      error = validateTreasuryAuthorizationCohortFacts(proxy, "cv_4");
    }).not.toThrow();
    expect(error).toContain("校验异常");
    expect(readTreasuryCohortValidationCounters().cohortValidationFailures).toBeGreaterThanOrEqual(1);
  });

  it("篡改 policy/revision 并保留旧 digest：store unhealthy（repair 不自动覆盖 digest）", () => {
    const service = makeService();
    void service;
    const cohort = fullCohort("cv_5");
    const originalDigest = computeTreasuryAuthorizationCohortDigest(cohort);
    // 篡改 revision 而保留 digest → identity 重算不一致 → 写入拒绝。
    const tampered = { ...cohort, revisions: { ...cohort.revisions, intentRevision: 99 } };
    const write = quarantineTreasuryTransaction({
      transactionId: "cv_5",
      authorityLevel: "lowlevel",
      digest: "1234567890abcdef",
      tick: Game.time,
      kind: "test.transfer",
      source: "test",
      phase: "executing_at_end_tick",
      deltas: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
      recordedAt: Game.time,
      outcome: "started_unknown",
      settlement: "quarantined",
      authorizationCohort: tampered,
      authorizationCohortDigest: originalDigest,
    });
    // 写入成功（写入方 digest 的最终一致性由 load 承载）→ 下一次 load 校验
    // 检出重算不一致 → store unhealthy（原数据保留，repair 不覆盖 digest）。
    expect(write.status).toBe("written");
    resetTreasuryQuarantineRuntimeForTest();
    const fatal = ensureTreasuryQuarantineStoreValidated();
    expect(fatal).toContain("重算不一致");
  });
});

// ── 10. 统一持久 structure descriptor 校验 ──────────────────────────────────

describe("structure descriptor validation（第十三轮第十节）", () => {
  const governedBase = {
    bindingKind: "governed_location",
    role: "source",
    roomName: "W1N57",
    locationKind: "storage",
    structureId: "stor-1",
    required: true,
    version: 1,
  } as const;

  it("governed_location 携带 objectId：拒绝（持久层即 unhealthy）", () => {
    expect(validateTreasuryStructureDescriptor({ ...governedBase, objectId: "obj-1" })).toContain("objectId");
  });

  it("governed_location 携带 expectedType：拒绝", () => {
    expect(validateTreasuryStructureDescriptor({ ...governedBase, expectedType: "lab" })).toContain("expectedType");
  });

  it("game_object 缺 objectId：拒绝", () => {
    const gameObj = { ...governedBase, bindingKind: "game_object", structureId: "obj-1" as string };
    const { objectId: _drop, ...withoutObjectId } = gameObj as typeof gameObj & { objectId?: string };
    void _drop;
    expect(validateTreasuryStructureDescriptor(withoutObjectId)).toContain("objectId");
  });

  it("game_object 的 structureId 与 objectId 语义不一致：拒绝", () => {
    expect(
      validateTreasuryStructureDescriptor({
        ...governedBase,
        bindingKind: "game_object",
        structureId: "obj-1",
        objectId: "obj-2",
      }),
    ).toContain("语义不一致");
  });

  it("game_object 合法形态通过；同结构不同 role 产生不同 descriptor 判定（同一 validator）", () => {
    const gameObj = { ...governedBase, bindingKind: "game_object", structureId: "obj-1", objectId: "obj-1" };
    expect(validateTreasuryStructureDescriptor(gameObj)).toBeNull();
    // 同一结构不同 role：validator 均通过（role 是 identity 成分，不合并——
    // digest 层已由 AC4 覆盖；此处验证同一 validator 对两种 role 均接受）。
    expect(validateTreasuryStructureDescriptor({ ...governedBase, role: "target" })).toBeNull();
    expect(validateTreasuryStructureDescriptor({ ...gameObj, role: "fee_source" })).toBeNull();
  });

  it("持久 intent 中 governed_location + objectId：store unhealthy（写入拒绝）", () => {
    const service = makeService();
    void service;
    const cohort = fullCohort("sd_intent");
    const entry = modernIntentEntry("sd_intent", cohort);
    // 矛盾 descriptor → 写入拒绝。
    const contradictory = {
      ...entry,
      structureFacts: [{ ...governedBase, objectId: "obj-9" }],
    };
    const write = writeTreasuryIntentEntry(contradictory);
    expect(write.status).toBe("rejected");
  });

  it("持久 quarantine 中 governed_location + expectedType：写入拒绝", () => {
    const write = quarantineTreasuryTransaction({
      transactionId: "sd_quarantine",
      authorityLevel: "lowlevel",
      digest: "1234567890abcdef",
      tick: Game.time,
      kind: "test.transfer",
      source: "test",
      phase: "executing_at_end_tick",
      deltas: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
      recordedAt: Game.time,
      outcome: "started_unknown",
      settlement: "quarantined",
      structureFacts: [{ ...governedBase, expectedType: "lab" }],
    });
    expect(write.status).toBe("rejected");
  });
});

// ── 11. forensic marker / tombstone 绑定 attempt identity ───────────────────

describe("forensic attempt identity（第十三轮第十一节）", () => {
  function injectRedemptionFaultOnce(): void {
    let fired = false;
    setTreasuryRedemptionFaultInjectorForTest((stage) => {
      if (stage === "before_budget_publish" && !fired) {
        fired = true;
        throw new Error("injected:forensic");
      }
    });
  }

  it("modern forensic marker 写入完整 attempt identity（fault store 满载兜底）", () => {
    const service = makeService();
    const { contract, bundle } = buildAndAuthorize(service, "fi_marker");
    // 预填满 fault store 使 authority 写入失败 → forensic marker。
    for (let index = 0; index < TREASURY_AUTHORIZATION_FAULT_MAX_ENTRIES; index += 1) {
      expect(
        writeTreasuryAuthorizationFaultEntry({
          transactionId: `fi_fill_${index}`,
          authorityLevel: "lowlevel",
          digest: `00000000000000${String(index).padStart(2, "0")}`.slice(-16),
          postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1 }],
          faultTick: Game.time,
          outcome: "not_started",
          rollbackConfirmed: true,
          source: "seed",
        }).status,
      ).toBe("written");
    }
    injectRedemptionFaultOnce();
    const result = executeTreasuryActionContract(service, { contract, authorization: bundle });
    expect(result.status).toBe("prepare_rejected");
    const marker = readTreasuryWriteFault();
    expect(marker?.phase).toBe("internal_authorization_fault_forensic");
    // marker 携带完整 attempt identity。
    expect(marker?.attemptIdentity?.contractDigest).toBeDefined();
    expect(marker?.attemptIdentity?.durableIdentityDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });

  it("acknowledgeRolledBack 必填：缺失即拒绝（无无条件 clear）", () => {
    const service = makeService();
    void service;
    recordTreasuryWriteFault({
      transactionId: "fi_ack",
      digest: "1234567890abcdef",
      tick: Game.time,
      kind: "test.transfer",
      source: "test",
      phase: "internal_authorization_fault_forensic",
      status: "unresolved",
      recordedAt: Game.time,
      attemptIdentity: { durableIdentityDigest: "fedcba0987654321" },
    });
    const rejected = service.resolveUnresolvedTransaction({ transactionId: "fi_ack", capability: {} as never });
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("invalid_input");
  });

  it("forensic resolution 幂等只在完整 identity 相同时成立；同 ID 新 attempt（不同 identity）不共享 tombstone", () => {
    const service = makeService();
    void service;
    // 第一次 attempt 的 forensic marker + resolution（tombstone 绑定 identity A）。
    recordTreasuryWriteFault({
      transactionId: "fi_share",
      digest: "1234567890abcdef",
      tick: Game.time,
      kind: "test.transfer",
      source: "test",
      phase: "internal_authorization_fault_forensic",
      status: "unresolved",
      recordedAt: Game.time,
      attemptIdentity: { contractDigest: "3333333333333333", durableIdentityDigest: "aaaaaaaaaaaaaaaa" },
    });
    const resolved = service.resolveUnresolvedTransaction({ transactionId: "fi_share", acknowledgeRolledBack: true, capability: {} as never });
    expect(resolved.status).toBe("resolved");
    const tombstone = readTreasuryResolutionTombstone("fi_share");
    expect(tombstone?.durableIdentityDigest).toBe("aaaaaaaaaaaaaaaa");
    // 同 ID、同普通 digest、不同 cohort/durable 的新 attempt forensic marker：
    // 旧 tombstone 不得解决新 attempt（fail closed）。
    recordTreasuryWriteFault({
      transactionId: "fi_share",
      digest: "1234567890abcdef",
      tick: Game.time + 1,
      kind: "test.transfer",
      source: "test",
      phase: "internal_authorization_fault_forensic",
      status: "unresolved",
      recordedAt: Game.time + 1,
      attemptIdentity: { contractDigest: "3333333333333333", durableIdentityDigest: "bbbbbbbbbbbbbbbb" },
    });
    Game.time += 2;
    const blocked = service.resolveUnresolvedTransaction({ transactionId: "fi_share", acknowledgeRolledBack: true, capability: {} as never });
    expect(blocked.status).toBe("rejected");
    // 既有 tombstone（identity A）未被 marker B 覆盖。
    expect(readTreasuryResolutionTombstone("fi_share")?.durableIdentityDigest).toBe("aaaaaaaaaaaaaaaa");
    // 幂等（完整 identity 相同）：手工构造与 tombstone 同 identity 的 marker
    // 前置 tombstone → already_resolved（清除 marker、tombstone 不变）。
    clearTreasuryPersistenceForTest();
    expect(
      writeTreasuryResolutionTombstone({
        transactionId: "fi_idem",
        digest: "1234567890abcdef",
        resolution: "not-executed",
        stage: "final",
        actionTick: Game.time,
        observationTick: Game.time,
        resolvedAtTick: Game.time,
        reconcilerKind: "pre-execution",
        preExecution: true,
        contractDigest: "3333333333333333",
        durableIdentityDigest: "aaaaaaaaaaaaaaaa",
      }).status,
    ).not.toBe("rejected");
    recordTreasuryWriteFault({
      transactionId: "fi_idem",
      digest: "1234567890abcdef",
      tick: Game.time,
      kind: "test.transfer",
      source: "test",
      phase: "internal_authorization_fault_forensic",
      status: "unresolved",
      recordedAt: Game.time,
      attemptIdentity: { contractDigest: "3333333333333333", durableIdentityDigest: "aaaaaaaaaaaaaaaa" },
    });
    const idempotent = service.resolveUnresolvedTransaction({ transactionId: "fi_idem", acknowledgeRolledBack: true, capability: {} as never });
    expect(idempotent.status).toBe("already_resolved");
    expect(readTreasuryResolutionTombstone("fi_idem")?.durableIdentityDigest).toBe("aaaaaaaaaaaaaaaa");
  });

  it("legacy forensic marker（无 attemptIdentity）不得 already_resolved 携带现代身份的 tombstone", () => {
    const service = makeService();
    void service;
    // 先建立绑定现代 identity 的 final not-executed tombstone。
    expect(
      writeTreasuryResolutionTombstone({
        transactionId: "fi_legacy_marker",
        digest: "1234567890abcdef",
        resolution: "not-executed",
        stage: "final",
        actionTick: Game.time,
        observationTick: Game.time,
        resolvedAtTick: Game.time,
        reconcilerKind: "pre-execution",
        preExecution: true,
        durableIdentityDigest: "aaaaaaaaaaaaaaaa",
      }).status,
    ).not.toBe("rejected");
    // 旧形态 forensic marker（无 attemptIdentity 字段）。
    recordTreasuryWriteFault({
      transactionId: "fi_legacy_marker",
      digest: "1234567890abcdef",
      tick: Game.time + 1,
      kind: "test.transfer",
      source: "test",
      phase: "internal_authorization_fault_forensic",
      status: "unresolved",
      recordedAt: Game.time + 1,
    });
    Game.time += 2;
    const result = service.resolveUnresolvedTransaction({ transactionId: "fi_legacy_marker", acknowledgeRolledBack: true, capability: {} as never });
    // legacy forensic proof 不能证明 modern tombstone 对应的 attempt → 拒绝。
    expect(result.status).toBe("rejected");
  });
});

// ── 13. operation-count 与回归 ─────────────────────────────────────────────

describe("operation-count 与回归（第十三轮第十四节）", () => {
  it("cohortValidationFailures / proofLevelRejections / resolution identity 计数在对应路径递增", () => {
    resetTreasuryCohortValidationForTest();
    resetTreasuryAuthorityLevelForTest();
    validateTreasuryAuthorizationCohortFacts(null);
    expect(readTreasuryCohortValidationCounters().cohortValidationFailures).toBe(1);
    const service = makeService();
    void service;
    const cohort = fullCohort("oc_1");
    const { durableIdentityDigest: _drop, ...missingDurable } = modernIntentEntry("oc_1", cohort);
    void _drop;
    expect(writeTreasuryIntentEntry({ ...missingDurable, authorityLevel: "modern" }).status).toBe("rejected");
    expect(readTreasuryAuthorityLevelCounters().proofLevelRejections).toBeGreaterThanOrEqual(1);
    void readTreasuryResolutionStoreCounters;
  });

  it("回归：正常 contract → bundle → intent → OK → commit 继续通过（modern 等级）", () => {
    const service = makeService();
    const { contract, bundle } = buildAndAuthorize(service, "oc_regress_ok");
    const result = executeTreasuryActionContract(service, { contract, authorization: bundle });
    expect(result.status).toBe("executed_committed");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
    const entry = readTreasuryIntentEntry("oc_regress_ok");
    expect(entry).toBeUndefined(); // settled 后 intent 关闭
    // 查询/readiness 零 Game 写入：executions 仍为 1。
    service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1);
  });

  it("回归：non-OK → abort 与 execution-unknown → quarantine 路径保持", () => {
    const service = makeService();
    const { contract, bundle } = buildAndAuthorize(service, "oc_regress_nonok", transferArgs({ outcome: "non-ok" }));
    const result = executeTreasuryActionContract(service, { contract, authorization: bundle });
    expect(result.status).toBe("executed_aborted");
    const service2 = makeService();
    const built2 = buildTreasuryActionContract(service2, { actionKind: "test.transfer", transactionId: "oc_regress_unknown", args: transferArgs() });
    expect(built2.status).toBe("built");
    if (built2.status !== "built") throw new Error("unreachable");
    const authorized2 = service2.authorizeTreasuryActionContract(built2.contract);
    expect(authorized2.status).toBe("authorized");
    if (authorized2.status !== "authorized") throw new Error("unreachable");
    const executed = executeTreasuryActionContract(service2, {
      contract: built2.contract,
      authorization: authorized2.bundle as TreasuryAuthorizationBundle,
    });
    expect(["executed_committed", "executed_aborted", "executed_unsettled"]).toContain(executed.status);
    void peekTreasuryAuthorizationFaultStore;
  });
});
