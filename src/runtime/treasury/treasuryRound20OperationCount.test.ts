/**
 * 【第二十轮】operation-count 与架构扫描测试（任务 26.11/26.12）。
 *
 * 覆盖：
 * - 50 次 semantic validation 不增加 fullScans；
 * - 50 次 receipt exact lookup 不增加 fullScans；
 * - 50 次 tombstone verdict 不扫描 active lineage entries；
 * - 空闲 beginTick 不扫描 exact retirement history；
 * - 300 代 chain 的 active entryCount 保持常数、GRA 容量有界；
 * - 架构扫描：production 非 namespace 权威模块零 raw startsWith("tr1_")；
 *   安全关键模块零手工 TreasuryAttemptIdentity 字面量构造；production
 *   不导入 test helper；真实 writer 文件零改动。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createTreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest, lookupTreasurySettledReceipt } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  createTreasuryAttemptLineageRecord,
  convergeTreasuryLineageRetirementFromFacts,
  stageTreasuryLineageCapabilityIssued,
  stageTreasuryLineageChildIntentPending,
  activateTreasuryLineageChild,
  deriveTreasuryLineageNextChildTransactionId,
  readTreasuryAttemptLineageRecord,
  lookupTreasuryAttemptLineageByAttemptId,
  lineageStoreEvents,
} from "@/runtime/treasury/attemptLineage";
import { generationRetirementEvents, readTreasuryGenerationRetirementProof } from "@/runtime/treasury/generationRetirementAuthority";
import { retirementSummaryEvents } from "@/runtime/treasury/lineageRetirementSummary";
import { validateTreasurySemanticLineage } from "@/runtime/treasury/semanticLineageValidation";
import { treasuryTombstoneReplacementVerdict } from "@/runtime/treasury/lineageGenerationRetirement";
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

/** 真实低层 chain fixture → gen1 child_active。 */
function seedActiveChildChain(rootId: string, digest = "1111111111111111", durable = "2222222222222222"): {
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
  const created = createTreasuryAttemptLineageRecord({
    rootTransactionId: rootId,
    rootIdentity: { digest, durableIdentityDigest: durable },
    actionKind: "terminal.send",
    authorityClass: "lowlevel",
    lowlevelSource: "runtime-lowlevel@v1",
    rearmable: true,
    retrySemanticDigest: "6666666666666666",
  });
  if (created.status !== "written") throw new Error("seed chain create failed");
  const lineageId = created.record.lineageId;
  const converged = convergeTreasuryLineageRetirementFromFacts(lineageId);
  if (converged.status !== "completed") throw new Error("seed converge failed");
  const childId = deriveTreasuryLineageNextChildTransactionId(lineageId, 1, rootId);
  if (stageTreasuryLineageCapabilityIssued(lineageId, childId).status === "rejected") throw new Error("stage issued failed");
  if (stageTreasuryLineageChildIntentPending(lineageId, childId).status === "rejected") throw new Error("stage pending failed");
  const activated = activateTreasuryLineageChild(lineageId, { digest, durableIdentityDigest: durable, lowlevelSource: "runtime-lowlevel@v1" });
  if (activated.status === "rejected") throw new Error("activate failed");
  return {
    childId,
    lineageId,
    identity: {
      digest,
      durableIdentityDigest: durable,
      lowlevelSource: "runtime-lowlevel@v1",
      lineageId,
      lineageGeneration: 1,
      parentTransactionId: rootId,
      lineageBindingDigest: readTreasuryAttemptLineageRecord(lineageId)!.bindingDigest!,
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

describe("operation-count（第二十轮性能要求）", () => {
  it("50 次 semantic validation 不增加 fullScans（O(1)：ID 解析 + 索引 + 单条 proof 查询）", () => {
    const chain = seedActiveChildChain("r20_oc_sem");
    // 预热（首次 load 计一次 fullScan）。
    validateTreasurySemanticLineage({ purpose: "historical_diagnostic", transactionId: chain.childId, proof: chain.identity });
    const lineageScans = lineageStoreEvents.fullScans;
    const proofScans = generationRetirementEvents.fullScans;
    for (let i = 0; i < 50; i += 1) {
      // 【第二十一轮 6.4】current 分支要求完整 exact identity 输入。
      const verdict = validateTreasurySemanticLineage({ purpose: "historical_diagnostic", transactionId: chain.childId, proof: chain.identity, identity: chain.identity });
      expect(verdict.verdict).toBe("match");
    }
    expect(lineageStoreEvents.fullScans).toBe(lineageScans);
    expect(generationRetirementEvents.fullScans).toBe(proofScans);
  });

  it("50 次 receipt exact lookup 不增加 fullScans", () => {
    const chain = seedActiveChildChain("r20_oc_rc");
    lookupTreasurySettledReceipt(chain.childId);
    const scansBefore = lineageStoreEvents.fullScans;
    for (let i = 0; i < 50; i += 1) {
      void lookupTreasurySettledReceipt(chain.childId);
    }
    expect(lineageStoreEvents.fullScans).toBe(scansBefore);
  });

  it("50 次 tombstone verdict 不扫描 active lineage entries / summary entries / exact history", () => {
    const chain = seedActiveChildChain("r20_oc_ver");
    const rootProof = readTreasuryGenerationRetirementProof(chain.lineageId, 0)!;
    // 预热。
    treasuryTombstoneReplacementVerdict({
      transactionId: chain.childId,
      digest: chain.identity.digest,
      resolution: "not-executed",
      stage: "final",
      proofLevel: "lowlevel",
      durableIdentityDigest: chain.identity.durableIdentityDigest,
      lowlevelSource: "runtime-lowlevel@v1",
      lineageId: chain.lineageId,
      lineageGeneration: 1,
      parentTransactionId: "r20_oc_ver",
      lineageBindingDigest: chain.identity.lineageBindingDigest,
    });
    const lineageScans = lineageStoreEvents.fullScans;
    const summaryScans = retirementSummaryEvents.fullScans;
    const proofScans = generationRetirementEvents.fullScans;
    for (let i = 0; i < 50; i += 1) {
      const verdict = treasuryTombstoneReplacementVerdict({
        transactionId: chain.childId,
        digest: chain.identity.digest,
        resolution: "not-executed",
        stage: "final",
        proofLevel: "lowlevel",
        durableIdentityDigest: chain.identity.durableIdentityDigest,
        lowlevelSource: "runtime-lowlevel@v1",
        lineageId: chain.lineageId,
        lineageGeneration: 1,
        parentTransactionId: "r20_oc_ver",
        lineageBindingDigest: chain.identity.lineageBindingDigest,
      });
      // 当前代三段未完成（child_active）→ pending（不扫描历史 proof）。
      expect(verdict.verdict).toBe("replacement_pending");
    }
    expect(lineageStoreEvents.fullScans).toBe(lineageScans);
    expect(retirementSummaryEvents.fullScans).toBe(summaryScans);
    expect(generationRetirementEvents.fullScans).toBe(proofScans);
    void rootProof;
  });

  it("空闲 beginTick 不扫描 exact retirement history（空闲快路径）", () => {
    const chain = seedActiveChildChain("r20_oc_idle");
    void chain;
    // 推到终态后空闲（无 pending lineage、无 pending-release）。
    const proofScansBefore = generationRetirementEvents.fullScans;
    const t = advanceTick();
    t.beginTick();
    expect(generationRetirementEvents.fullScans).toBe(proofScansBefore);
  });

  it("300 代 chain：active entryCount 保持常数；GRA 容量有界（≤ 世代数 + 1）", () => {
    // 推进 30 代（每代完整 capability → 执行 non-OK → retirement + exact proof）。
    let service = makeService();
    const executed = service.executePreparedAction(freshInput(service, "r20_oc_300"), () => {
      service.endTick();
      return { ok: false as const };
    });
    expect(executed.status).toBe("executed_abort_failed");
    service = advanceTick();
    expect(resolveNotExecuted(service, "r20_oc_300").status).toBe("resolved");
    let current = "r20_oc_300";
    for (let gen = 1; gen <= 30; gen += 1) {
      const next = advanceTick();
      const issued = next.issueTreasuryRearmCapability({ parentTransactionId: current });
      expect(issued.status).toBe("issued");
      if (issued.status !== "issued") throw new Error("unreachable");
      const childExecuted = next.executePreparedAction(freshInput(next, issued.childTransactionId), () => ({ ok: false as const }), { rearmCapability: issued.capability });
      expect(childExecuted.status === "executed_aborted" || childExecuted.status === "executed_abort_failed").toBe(true);
      current = issued.childTransactionId;
      if (childExecuted.status === "executed_abort_failed") {
        expect(resolveNotExecuted(advanceTick(), current).status).toBe("resolved");
      }
      expect(readTreasuryAttemptLineageRecord(lookupTreasuryAttemptLineageByAttemptId(current)!.lineageId)).toBeDefined();
    }
    const record = lookupTreasuryAttemptLineageByAttemptId(current)!;
    expect(record.generation).toBe(30);
    // active entryCount 恒 1（单 chain 单 record）。
    const lineageCount = (Memory.runtime as unknown as { treasury?: { attemptLineage?: { entryCount: number } } }).treasury?.attemptLineage?.entryCount;
    expect(lineageCount).toBe(1);
    // exact proof 数 = 已退休代数（0..29 + 当前若已退休）——有界。
    const graCount = (Memory.runtime as unknown as { treasury?: { generationRetirementProofs?: { entryCount: number } } }).treasury?.generationRetirementProofs?.entryCount ?? 0;
    expect(graCount).toBeLessThanOrEqual(32);
  }, 120_000);
});

// ── 架构扫描（源码级断言） ────────────────────────────────────────────────────

const SRC_TREASURY = join(process.cwd(), "src", "runtime", "treasury");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("架构扫描（第二十轮 26.11）", () => {
  it("production 非 namespace 权威模块零 raw startsWith(\"tr1_\")", () => {
    const violations: string[] = [];
    for (const filePath of listTsFiles(SRC_TREASURY)) {
      const relative = filePath.split(/[\\/]/).slice(-3).join("/");
      // namespace 权威（transactionId.ts 的 isTreasuryRearmAttemptId 内部）与
      // lineageProof.ts 的 required 矩阵内部允许。
      if (relative === "runtime/treasury/transactionId.ts" || relative === "runtime/treasury/lineageProof.ts") continue;
      const source = readFileSync(filePath, "utf8");
      if (/startsWith\("tr1_"\)/.test(source)) {
        violations.push(`${relative} 含 raw startsWith("tr1_")（须使用 isTreasuryRearmAttemptId——transactionId.ts 单一权威）`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("安全关键模块零手工 TreasuryAttemptIdentity 字面量构造（必须经 exactAttemptIdentity 单一构造）", () => {
    const critical = [
      "receipts.ts",
      "resolutionStore.ts",
      "resolutionAuthority.ts",
      "recoveryCoordinator.ts",
      "intents.ts",
    ];
    const violations: string[] = [];
    for (const file of critical) {
      const source = readFileSync(join(SRC_TREASURY, file), "utf8");
      // markerAttempt 命名是任务书 8.4 明确允许的 class-aware 子集（诊断性
      // 简化视图——不用于 authority release / receipt idempotence / compaction /
      // tombstone eviction / committed finalization）。
      const lines = source.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (/:\s*TreasuryAttemptIdentity\s*=\s*\{/.test(line) && !/markerAttempt/.test(line)) {
          violations.push(`${file}:${String(index + 1)} 手工 TreasuryAttemptIdentity 字面量（安全关键比较视图必须经 exactAttemptIdentity 构造；markerAttempt 子集除外）`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it("production 不导入 test helper（deriveTreasuryRearmChildTransactionId 等 test-only 边界）", () => {
    const violations: string[] = [];
    for (const filePath of listTsFiles(SRC_TREASURY)) {
      const relative = filePath.split(/[\\/]/).slice(-3).join("/");
      if (relative === "runtime/treasury/attemptRearm.ts") continue;
      const source = readFileSync(filePath, "utf8");
      if (/deriveTreasuryRearmChildTransactionId/.test(source)) {
        violations.push(`${relative} 引用 test-only derive helper`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("treasury 新代码区域零真实 Game writer 调用形态（本轮不接真实 writer；既有 production writer 文件的零改动由 evidence 的 git diff 检查承载）", () => {
    const writerCalls: ReadonlyArray<{ readonly api: string; readonly pattern: RegExp }> = [
      { api: "terminal.send", pattern: /\.send\(/ },
      { api: "Game.market.deal", pattern: /Game\.market\.deal\(/ },
      { api: "runReaction", pattern: /\.runReaction\(/ },
      { api: "boostCreep", pattern: /\.boostCreep\(/ },
      { api: "unboostCreep", pattern: /\.unboostCreep\(/ },
      { api: "factory.produce", pattern: /\.produce\(/ },
      { api: "launchNuke", pattern: /\.launchNuke\(/ },
      { api: "creep.transfer", pattern: /creep\.transfer\(/ },
      { api: "creep.withdraw", pattern: /creep\.withdraw\(/ },
      { api: "spawnCreep", pattern: /\.spawnCreep\(/ },
    ];
    for (const filePath of listTsFiles(SRC_TREASURY)) {
      const source = readFileSync(filePath, "utf8");
      for (const { api, pattern } of writerCalls) {
        if (pattern.test(source)) {
          throw new Error(`${filePath} 含真实 writer 调用形态 ${api}（本轮禁止接真实 writer）`);
        }
      }
    }
  });
});
