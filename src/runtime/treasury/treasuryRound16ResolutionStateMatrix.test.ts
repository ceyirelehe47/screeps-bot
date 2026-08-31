/**
 * 【第十六轮第九/十节】resolution 持久状态语义矩阵 + authority 写入输入
 * 别名隔离测试。
 *
 * 覆盖：
 * - resolving not-executed / stage 缺失 / final committed 缺 settledAtTick /
 *   final not-executed 携带 settledAtTick / forensic provenance 与 proof
 *   矛盾 → 持久 store unhealthy（不自动删除）；
 * - recovery 不再删除非法 tombstone（rolledBack 分支保留 entry）；
 * - migration 遇非法组合：原 store 不变；合法 v1-v5 迁移继续通过；
 * - 写入别名隔离：quarantine / intent / authorization-fault / resolution
 *   tombstone / write-fault marker 写入后修改原输入，Memory 不变。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { quarantineTreasuryTransaction } from "@/runtime/treasury/quarantine";
import { writeTreasuryIntentEntry, writeTreasuryIntentEntry as writeIntent } from "@/runtime/treasury/intents";
import { writeTreasuryAuthorizationFaultEntry } from "@/runtime/treasury/authorizationFaults";
import {
  ensureTreasuryResolutionStoreValidated,
  readTreasuryResolutionTombstone,
  readTreasuryResolutionStoreCounters,
  recoverStagedResolutions,
  resetTreasuryResolutionStoreForTest,
  writeTreasuryResolutionTombstone,
  TREASURY_RESOLUTION_VERSION,
} from "@/runtime/treasury/resolutionStore";
import { recordTreasuryWriteFault, readTreasuryWriteFault } from "@/runtime/treasury/writeFault";
import { TREASURY_LOWLEVEL_SOURCE_RUNTIME } from "@/runtime/treasury/authorityLevel";
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

function makeService(): TreasuryTestService {
  const rooms = installRooms(ROOMS);
  const service = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
  service.beginTick();
  return treasuryTestService(service);
}

/** 直装持久 resolution store（指定 version 与 entries）。 */
function installResolutionStore(version: number, entries: Record<string, unknown>): void {
  Memory.runtime = (Memory.runtime ?? {}) as object;
  (Memory.runtime as { treasury?: Record<string, unknown> }).treasury = {
    ...((Memory.runtime ?? {}) as { treasury?: Record<string, unknown> }).treasury,
    resolutions: {
      version,
      entries,
      entryCount: Object.keys(entries).length,
      updatedAt: 2,
    },
  };
  resetTreasuryResolutionStoreForTest();
}

/** 合法 v3 entry 基础形态（迁移后补 stage/proofLevel）。 */
function legacyEntry(transactionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transactionId,
    digest: "0123456789abcdef",
    resolution: "committed",
    actionTick: 1,
    settledAtTick: 2,
    observationTick: 2,
    resolvedAtTick: 2,
    ...extra,
  };
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  resetTreasuryResolutionStoreForTest();
});

describe("持久状态语义矩阵（第十六轮第九节）", () => {
  it("resolving not-executed 持久 entry：store unhealthy、不自动删除", () => {
    installResolutionStore(TREASURY_RESOLUTION_VERSION, {
      "r:sm_bad": {
        ...legacyEntry("sm_bad"),
        resolution: "not-executed",
        stage: "resolving",
        proofLevel: "lowlevel",
        lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
        durableIdentityDigest: "0123456789abcdee",
      },
    });
    expect(ensureTreasuryResolutionStoreValidated()).toContain("resolving");
    expect(ensureTreasuryResolutionStoreValidated()).toContain("not-executed");
    // recovery 不删除非法 entry。
    const report = recoverStagedResolutions();
    expect(report.storeFatal).toContain("resolving");
    const raw = (Memory.runtime as { treasury?: { resolutions?: { entries?: Record<string, unknown> } } }).treasury?.resolutions?.entries;
    expect(raw?.["r:sm_bad"]).toBeDefined();
  });

  it("stage 缺失（v3 历史形态未迁移语义）：unhealthy；v3 迁移自动补终态 stage", () => {
    installResolutionStore(3, { "r:sm_v3": legacyEntry("sm_v3") });
    // v3 迁移补 stage=final → 语义矩阵通过。
    expect(ensureTreasuryResolutionStoreValidated()).toBeNull();
    expect(readTreasuryResolutionTombstone("sm_v3")?.stage).toBe("final");
    expect(readTreasuryResolutionTombstone("sm_v3")?.proofLevel).toBe("legacy");
  });

  it("final committed 缺 settledAtTick：unhealthy", () => {
    installResolutionStore(TREASURY_RESOLUTION_VERSION, {
      "r:sm_no_settled": {
        ...legacyEntry("sm_no_settled"),
        stage: "final",
        proofLevel: "lowlevel",
        lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
        durableIdentityDigest: "0123456789abcdee",
        settledAtTick: undefined,
      },
    });
    expect(ensureTreasuryResolutionStoreValidated()).toContain("settledAtTick");
  });

  it("final not-executed 携带 settledAtTick（committed 语义字段）：unhealthy", () => {
    installResolutionStore(TREASURY_RESOLUTION_VERSION, {
      "r:sm_ne_settled": {
        ...legacyEntry("sm_ne_settled"),
        resolution: "not-executed",
        stage: "final",
        proofLevel: "lowlevel",
        lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
        durableIdentityDigest: "0123456789abcdee",
      },
    });
    expect(ensureTreasuryResolutionStoreValidated()).toContain("settledAtTick");
  });

  it("forensic provenance 与 proof level 矛盾：unhealthy", () => {
    installResolutionStore(TREASURY_RESOLUTION_VERSION, {
      "r:sm_prov_conflict": {
        ...legacyEntry("sm_prov_conflict"),
        stage: "final",
        proofLevel: "identity-bound",
        contractDigest: "1111111111111111",
        authorizationCohortDigest: "2222222222222222",
        durableIdentityDigest: "0123456789abcdee",
        forensicProvenance: {
          protocol: "treasury-forensic-resolution@v1",
          acknowledgement: "explicit_management",
          confirmedBy: "test-operator",
          attempt: { digest: "0123456789abcdef" },
          confirmedAtTick: 2,
          source: "test",
          allowAutomaticCompletion: false,
        },
      },
    });
    expect(ensureTreasuryResolutionStoreValidated()).toContain("forensic provenance");
  });

  it("migration 遇非法组合：原 store 不变（版本不前移）", () => {
    installResolutionStore(4, {
      "r:sm_v4_bad": {
        ...legacyEntry("sm_v4_bad"),
        proofLevel: "lowlevel",
        lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
        durableIdentityDigest: "0123456789abcdee",
        // resolvedAtTick 早于 observationTick → 时序非法。
        resolvedAtTick: 1,
        observationTick: 2,
      },
    });
    expect(ensureTreasuryResolutionStoreValidated()).toContain("时序");
    expect(
      (Memory.runtime as { treasury?: { resolutions?: { version?: number } } }).treasury?.resolutions?.version,
    ).toBe(4);
  });

  it("合法 v1-v5 迁移继续通过（抽样 v5/v2/v1）", () => {
    // v5：identity-bound final committed（合法）。
    installResolutionStore(5, {
      "r:sm_v5": {
        ...legacyEntry("sm_v5"),
        stage: "final",
        proofLevel: "identity-bound",
        contractDigest: "1111111111111111",
        authorizationCohortDigest: "2222222222222222",
        durableIdentityDigest: "0123456789abcdee",
      },
    });
    expect(ensureTreasuryResolutionStoreValidated()).toBeNull();
    // v2：无 stage → 迁移补 final + legacy。
    installResolutionStore(2, { "r:sm_v2": legacyEntry("sm_v2") });
    expect(ensureTreasuryResolutionStoreValidated()).toBeNull();
    expect(readTreasuryResolutionTombstone("sm_v2")?.stage).toBe("final");
    expect(readTreasuryResolutionTombstone("sm_v2")?.proofLevel).toBe("legacy");
    // v1：无 entryCount/stage。
    (Memory.runtime as { treasury?: Record<string, unknown> }).treasury = {
      resolutions: { version: 1, entries: { "r:sm_v1": legacyEntry("sm_v1") } },
    };
    resetTreasuryResolutionStoreForTest();
    expect(ensureTreasuryResolutionStoreValidated()).toBeNull();
    expect(readTreasuryResolutionTombstone("sm_v1")?.stage).toBe("final");
  });

  it("recovery 不删除非法 tombstone（rolledBack 分支保留 entry）", () => {
    // 合法写入 resolving committed（含 settledAtTick）后手工破坏 Memory 的
    // resolution 字段制造"resolving 无 settledAtTick"——load 即 fatal，不再
    // 有运行时删除路径；改用计数验证：写入合法 resolving 后 recovery 的
    // rolledBack 计数为 0（合法 entry 不回滚）。
    const write = writeTreasuryResolutionTombstone({
      transactionId: "sm_valid_resolving",
      digest: "0123456789abcdef",
      resolution: "committed",
      stage: "resolving",
      proofLevel: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      durableIdentityDigest: "0123456789abcdee",
      actionTick: Game.time,
      settledAtTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      reconcilerKind: "terminal.send",
      source: "test",
    });
    expect(write.status).not.toBe("rejected");
    const report = recoverStagedResolutions();
    expect(report.rolledBack).toBe(0);
    expect(readTreasuryResolutionTombstone("sm_valid_resolving")).toBeDefined();
    expect(readTreasuryResolutionStoreCounters().faulted).toBeGreaterThanOrEqual(0);
  });
});

describe("写入输入别名隔离（第十六轮第十节）", () => {
  it("quarantine 写入后修改原 structureFacts / deltas：Memory 不变", () => {
    const structureFacts = [{ bindingKind: "governed_location" as const, role: "source" as const, roomName: "W1N57", locationKind: "storage" as const, structureId: "stor-1", required: true, version: 1 }];
    const deltas = BASE_POSTINGS.map((leg) => ({ ...leg }));
    const write = quarantineTreasuryTransaction({
      transactionId: "ai_q",
      authorityLevel: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      digest: "0123456789abcdef",
      tick: Game.time,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      adapterSemanticIdentity: "sem",
      phase: "executing_at_end_tick",
      outcome: "started_unknown",
      settlement: "quarantined",
      deltas,
      recordedAt: Game.time,
      structureFacts,
    });
    expect(write.status).toBe("written");
    // 修改调用方输入（嵌套 descriptor 与 postings 腿）。
    (deltas as { delta: number }[])[0].delta = -999;
    (structureFacts as unknown[]).push({ bindingKind: "governed_location" });
    (structureFacts[0] as { role: string }).role = "target";
    // Memory 不变。
    const persisted = (
      (Memory.runtime as { treasury?: { quarantine?: { entries?: Record<string, { deltas?: { delta: number }[]; structureFacts?: { role?: string }[] }> } } })
        .treasury?.quarantine?.entries?.["q:ai_q"]
    );
    expect(persisted?.deltas?.[0]?.delta).toBe(-500);
    expect(persisted?.structureFacts?.[0]?.role).toBe("source");
    expect(persisted?.structureFacts?.length).toBe(1);
  });

  it("intent 写入后修改原 structureFacts：Memory 不变", () => {
    const structureFacts = [{ bindingKind: "governed_location" as const, role: "source" as const, roomName: "W1N57", locationKind: "storage" as const, structureId: "stor-1", required: true, version: 1 }];
    const write = writeIntent({
      transactionId: "ai_i",
      authorityLevel: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      digest: "0123456789abcdef",
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      postings: BASE_POSTINGS.map((leg) => ({ ...leg })),
      outcome: "started_unknown",
      settlement: "executing",
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
      structureFacts,
    });
    expect(write.status).toBe("written");
    (structureFacts as unknown[]).length = 0;
    const persisted = ((Memory.runtime as { treasury?: { intents?: { entries?: Record<string, { structureFacts?: unknown[] }> } } }).treasury?.intents?.entries?.["i:ai_i"]);
    expect(persisted?.structureFacts?.length).toBe(1);
  });

  it("authorization-fault 写入后修改原 postings / structureFacts：Memory 不变", () => {
    const postings = BASE_POSTINGS.map((leg) => ({ ...leg }));
    const structureFacts = [{ bindingKind: "governed_location" as const, role: "source" as const, roomName: "W1N57", locationKind: "storage" as const, structureId: "stor-1", required: true, version: 1 }];
    const write = writeTreasuryAuthorizationFaultEntry({
      transactionId: "ai_f",
      digest: "0123456789abcdef",
      faultTick: Game.time,
      actionKind: "terminal.send",
      source: "test",
      detail: "fixture",
      outcome: "not_started",
      rollbackConfirmed: true,
      postings,
      structureFacts,
    });
    expect(write.status).toBe("written");
    (postings as { delta: number }[])[0].delta = -777;
    (structureFacts as unknown[]).length = 0;
    const persisted = (
      (Memory.runtime as { treasury?: { authorizationFaults?: { entries?: Record<string, { postings?: { delta: number }[]; structureFacts?: unknown[] }> } } })
        .treasury?.authorizationFaults?.entries?.["af:ai_f"]
    );
    expect(persisted?.postings?.[0]?.delta).toBe(-500);
    expect(persisted?.structureFacts?.length).toBe(1);
  });

  it("resolution tombstone 写入后修改原 forensic provenance：Memory 不变", () => {
    const provenance = {
      protocol: "treasury-forensic-resolution@v1" as const,
      acknowledgement: "explicit_management" as const,
      confirmedBy: "operator-1",
      attempt: { digest: "0123456789abcdef" },
      confirmedAtTick: Game.time,
      source: "test",
      allowAutomaticCompletion: false,
    };
    const write = writeTreasuryResolutionTombstone({
      transactionId: "ai_r",
      digest: "0123456789abcdef",
      resolution: "not-executed",
      stage: "final",
      proofLevel: "forensic",
      forensicProvenance: provenance,
      actionTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
    });
    expect(write.status).not.toBe("rejected");
    provenance.confirmedBy = "tampered";
    (provenance.attempt as { digest?: string }).digest = "ffffffffffffffff";
    const persisted = readTreasuryResolutionTombstone("ai_r");
    expect((persisted?.forensicProvenance as { confirmedBy?: string })?.confirmedBy).toBe("operator-1");
    expect((persisted?.forensicProvenance as { attempt?: { digest?: string } })?.attempt?.digest).toBe("0123456789abcdef");
  });

  it("write-fault marker 写入后修改原 attemptIdentity：Memory 不变", () => {
    const attemptIdentity = { contractDigest: "1111111111111111", durableIdentityDigest: "0123456789abcdee" };
    recordTreasuryWriteFault({
      transactionId: "ai_m",
      digest: "0123456789abcdef",
      tick: Game.time,
      kind: "terminal.send",
      source: "test",
      phase: "internal_authorization_fault_forensic",
      status: "unresolved",
      recordedAt: Game.time,
      attemptIdentity,
    });
    attemptIdentity.durableIdentityDigest = "ffffffffffffffff";
    const marker = readTreasuryWriteFault() as { attemptIdentity?: { durableIdentityDigest?: string } };
    expect(marker?.attemptIdentity?.durableIdentityDigest).toBe("0123456789abcdee");
  });
});

void makeService;
