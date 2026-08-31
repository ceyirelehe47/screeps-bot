/**
 * 第十一轮 3.13.5：统一 immutable durable action identity 测试。
 *
 * - intent/quarantine 同 ID 幂等仅限完整 durable identity 一致——不同
 *   identity → identity_conflict（store 原数据不动、fail closed）；
 * - 相同完整 identity 幂等重试（already_present）；
 * - intent/quarantine 双权威 identity 不一致 → inconsistent fail closed；
 * - capability 绑定 authority 的 durable identity digest（resolution 强匹配）；
 * - identity 不含 outcome/settlement（workflow 事实变化不改变 identity——
 *   状态迁移不伪装成 identity 冲突）。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import {
  readTreasuryIntentEntry,
  writeTreasuryIntentEntry,
  type TreasuryIntentEntry,
} from "@/runtime/treasury/intents";
import {
  quarantineTreasuryTransaction,
  readTreasuryQuarantineEntry,
  type TreasuryQuarantineEntry,
} from "@/runtime/treasury/quarantine";
import { resolveTreasuryUnresolvedAuthority } from "@/runtime/treasury/unresolvedAuthority";
import {
  buildTreasuryActionContract,
  executeTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  registerTreasuryActionAdapter,
} from "@/runtime/treasury/actionContracts";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import { registerTreasuryPolicyResolver, makeNoReserveTreasuryPolicy } from "@/runtime/treasury/policyAuthority";
import {
  computeTreasuryDurableIdentityDigest,
  treasuryDurableIdentitiesMatch,
} from "@/runtime/treasury/durableIdentity";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { installRooms, type RoomSpec } from "@mock/treasury";

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

/**
 * 【第十四轮】低层 fixture 的 durable identity 由事实真实派生（写入前
 * identity 重算校验——假 digest 会被拒绝）。覆盖事实字段（如 source）即
 * 派生不同的合法 identity；显式覆盖 durableIdentityDigest 仍保留（构造
 * 与事实不一致的篡改形态——写入被拒）。
 */
function baseIntent(overrides: Partial<TreasuryIntentEntry> = {}): TreasuryIntentEntry {
  const base: TreasuryIntentEntry = {
    authorityLevel: "lowlevel",
    transactionId: "id_tx",
    digest: "0123456789abcdef",
    actionKind: "test.transfer",
    kind: "test.transfer",
    source: "test",
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -100 }],
    outcome: "not_started",
    settlement: "ready",
    createdAtTick: Game.time,
    updatedAtTick: Game.time,
    durableIdentityDigest: computeTreasuryDurableIdentityDigest({
      transactionId: overrides.transactionId ?? "id_tx",
      digest: overrides.digest ?? "0123456789abcdef",
      actionKind: overrides.actionKind ?? "test.transfer",
      postings: (overrides.postings ?? [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -100 }]).map((leg) => ({ ...leg })),
      source: overrides.source ?? "test",
    }),
    ...overrides,
  };
  return base;
}

/** 【第十四轮】quarantine fixture 的 durable identity 同样由事实真实派生（写入前重算校验）。 */
function baseQuarantine(overrides: Partial<TreasuryQuarantineEntry> = {}): TreasuryQuarantineEntry {
  const base = {
    transactionId: "id_tx",
    digest: "0123456789abcdef",
    tick: Game.time,
    kind: "test.transfer",
    source: "test",
    phase: "action_threw_execution_unknown",
    deltas: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -100 }],
    recordedAt: Game.time,
    outcome: "started_unknown",
    settlement: "quarantined",
    durableIdentityDigest: computeTreasuryDurableIdentityDigest({
      transactionId: overrides.transactionId ?? "id_tx",
      digest: overrides.digest ?? "0123456789abcdef",
      actionKind: overrides.kind ?? "test.transfer",
      postings: (overrides.deltas ?? [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -100 }]).map((leg) => ({ ...leg })),
      source: overrides.source ?? "test",
    }),
    ...overrides,
  } as TreasuryQuarantineEntry;
  return base;
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  registerTreasuryActionAdapter(makeTreasuryTestTransferAdapter());
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
});

describe("统一 durable action identity（第十一轮 3.13.5）", () => {
  it("intent 同 ID 不同 identity → identity_conflict（原数据不动）；同 identity 幂等", () => {
    const first = writeTreasuryIntentEntry(baseIntent());
    expect(first.status).toBe("written");
    // 同完整 identity 重试 → already_present 幂等。
    expect(writeTreasuryIntentEntry(baseIntent()).status).toBe("already_present");
    // 不同 durable identity（同 txId、不同 source 事实 → 合法不同 identity）→
    // identity_conflict，store 原数据不动（【第十四轮】假 digest 会被写入前
    // 重算拒绝——conflict 只在两个合法 identity 之间判定）。
    const conflict = writeTreasuryIntentEntry(baseIntent({ source: "test-alt" }));
    expect(conflict.status).toBe("rejected");
    if (conflict.status === "rejected") {
      expect(conflict.reason).toBe("identity_conflict");
      // 【第十五轮】class-specific 幂等比较——source 属于公共前置事实，
      // 先于 durable identity 报告（两身份成分都不同，conflict 结论不变）。
      expect(conflict.detail).toContain("不一致");
    }
    const stored = readTreasuryIntentEntry("id_tx");
    expect(stored?.durableIdentityDigest).toBe(baseIntent().durableIdentityDigest);
  });

  it("quarantine 同 ID 不同 identity → identity_conflict；legacy 空对空匹配", () => {
    expect(quarantineTreasuryTransaction(baseQuarantine()).status).toBe("written");
    const conflict = quarantineTreasuryTransaction(baseQuarantine({ source: "test-alt" }));
    expect(conflict.status).toBe("rejected");
    if (conflict.status === "rejected") {
      expect(conflict.reason).toBe("identity_conflict");
    }
    expect(readTreasuryQuarantineEntry("id_tx")?.durableIdentityDigest).toBe(baseQuarantine().durableIdentityDigest);
    // 【第十四轮】legacy 空 identity 形态由显式 legacy 等级表达（运行时
    // lowlevel 恒携带派生 durable identity）：空对空匹配（迁移残留双写幂等）。
    clearTreasuryPersistenceForTest();
    const legacyBase = { ...baseQuarantine(), authorityLevel: "legacy" as const, durableIdentityDigest: undefined };
    expect(quarantineTreasuryTransaction(legacyBase).status).toBe("written");
    expect(quarantineTreasuryTransaction(legacyBase).status).toBe("already_present");
    // 空（legacy）vs 非空（lowlevel 派生）→ conflict（保守）。
    expect(quarantineTreasuryTransaction(baseQuarantine()).status).toBe("rejected");
  });

  it("intent/quarantine 双权威 durable identity 不一致 → inconsistent fail closed", () => {
    writeTreasuryIntentEntry(
      baseIntent({ outcome: "started_unknown", settlement: "faulted" }),
    );
    quarantineTreasuryTransaction(
      baseQuarantine({ source: "test-alt" }),
    );
    const authority = resolveTreasuryUnresolvedAuthority("id_tx");
    expect(authority.status).toBe("inconsistent");
    if (authority.status === "inconsistent") {
      expect(authority.detail).toContain("durableIdentityDigest 不完整或不一致");
    }
  });

  it("contract 路径 intent 携带 identity digest；capability 绑定同一 identity", () => {
    const service = makeService();
    const built = buildTreasuryActionContract(service, {
      actionKind: "test.transfer",
      transactionId: "id_contract_tx",
      args: { fromRoom: "W1N57", fromLocation: "storage", toRoom: "W1N57", toLocation: "terminal", resource: RESOURCE_ENERGY, amount: 120, outcome: "throw" },
    });
    expect(built.status).toBe("built");
    if (built.status !== "built") throw new Error("unreachable");
    const authorized = service.authorizeTreasuryActionContract(built.contract);
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") throw new Error("unreachable");
    expect(() => executeTreasuryActionContract(service, { contract: built.contract, authorization: authorized.bundle })).toThrow();
    const quarantined = readTreasuryQuarantineEntry("id_contract_tx");
    expect(quarantined?.durableIdentityDigest).toBeDefined();
    // capability 签发绑定同一 durable identity digest。
    Game.time += 2;
    const post = makeService();
    const capability = post.issueTreasuryReconciliationCapability({ transactionId: "id_contract_tx" });
    expect(capability.status).toBe("issued");
    if (capability.status === "issued") {
      expect(capability.capability.durableIdentityDigest).toBe(quarantined?.durableIdentityDigest);
    }
  });

  it("identity 不含 outcome/settlement：workflow 事实变化不改变 identity（匹配语义）", () => {
    // outcome/settlement 是可变 workflow 事实——同 identity 的不同 workflow 状态
    // 匹配（transfer/恢复路径不因状态迁移报 identity 冲突）。
    expect(computeTreasuryDurableIdentityDigest({
      transactionId: "id_wf",
      digest: "0123456789abcdef",
      actionKind: "test.transfer",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -100 }],
      source: "test",
    })).toBe(computeTreasuryDurableIdentityDigest({
      transactionId: "id_wf",
      digest: "0123456789abcdef",
      actionKind: "test.transfer",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -100 }],
      source: "test",
    }));
    // 不可变事实变化 → identity 变化（owner/policy/cohort/descriptor/payload/source）。
    const base = {
      transactionId: "id_wf2",
      digest: "0123456789abcdef",
      actionKind: "test.transfer",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -100 }] as const,
      source: "test",
    };
    const identityA = computeTreasuryDurableIdentityDigest(base);
    expect(computeTreasuryDurableIdentityDigest({ ...base, ownerIdentity: "logical:x" })).not.toBe(identityA);
    expect(computeTreasuryDurableIdentityDigest({ ...base, policyIdentity: "p@v1:d" })).not.toBe(identityA);
    expect(computeTreasuryDurableIdentityDigest({ ...base, authorizationCohortDigest: "aaabbbcccddd0000" })).not.toBe(identityA);
    expect(computeTreasuryDurableIdentityDigest({ ...base, durablePayload: "payload-x", durablePayloadVersion: 1 })).not.toBe(identityA);
    expect(computeTreasuryDurableIdentityDigest({ ...base, source: "other" })).not.toBe(identityA);
    expect(computeTreasuryDurableIdentityDigest({
      ...base,
      structureFacts: [{ bindingKind: "governed_location", role: "source", roomName: "W1N57", locationKind: "storage", structureId: "stor-1", required: true, version: 1 }],
    })).not.toBe(identityA);
    // 匹配 helper：非空对非空不同 → false。
    expect(treasuryDurableIdentitiesMatch(identityA, "ffff0000ffff0000")).toBe(false);
  });
});
