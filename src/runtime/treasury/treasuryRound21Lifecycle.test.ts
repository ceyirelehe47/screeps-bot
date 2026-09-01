/**
 * 【第二十一轮】300 代长期收敛、retention 窗口容量边界、operation-count
 * 与架构扫描测试（任务书第十五/十六/十八节）。
 *
 * 场景 A（15.1 长期收敛）：≥300 代完整生命周期（root not-executed
 * retirement → exact proof → child 接管 → …），周期推进 Game.time 触发合法
 * retention/eviction——active lineage entryCount 恒 1、每代 child ID 唯一、
 * 历史 tombstone 与 exact proof 随依赖消失收敛、当前代 proof 保留、
 * store 容量有界、root 重放门禁继续。
 *
 * 场景 B（15.2 容量窗口）：全部 tombstone 位于 retention 窗口内时逼近
 * Resolution 硬容量 → 明确 fail closed（不提前驱逐未过期 proof、不覆盖）。
 *
 * 场景 C（15.3/18 operation-count）：300 代推进不引入 active 全表扫描；
 * semantic validation / byAttempt 查询 O(1)；空闲恢复 O(1)。
 *
 * 场景 D（16 架构扫描）：binding+generation 快捷放行、proof 存在性压缩、
 * 手工 attempt identity 构造、raw startsWith("tr1_") 散落的安全关键负向检查。
 */
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import {
  createTreasuryAttemptLineageRecord,
  convergeTreasuryLineageRetirementFromFacts,
  deriveTreasuryLineageNextChildTransactionId,
  stageTreasuryLineageCapabilityIssued,
  stageTreasuryLineageChildIntentPending,
  activateTreasuryLineageChild,
  readTreasuryAttemptLineageRecord,
  retireTreasuryLineageCurrentAttempt,
  recoverTreasuryAttemptLineageAtTickBoundary,
  peekTreasuryAttemptLineageHealth,
  lineageStoreEvents,
  resetTreasuryLineageRuntimeForTest,
} from "@/runtime/treasury/attemptLineage";
import {
  readTreasuryGenerationRetirementProof,
  peekTreasuryGenerationRetirementHealth,
  lookupTreasuryGenerationRetirementProofByAttemptId,
  generationRetirementEvents,
  resetTreasuryGenerationRetirementRuntimeForTest,
} from "@/runtime/treasury/generationRetirementAuthority";
import { writeTreasuryResolutionTombstone, peekTreasuryResolutionStoreHealth, TREASURY_RESOLUTION_MAX_ENTRIES } from "@/runtime/treasury/resolutionStore";
// retention verdict 的装配注册（lineageGenerationRetirement 模块加载即注册——驱逐资格判定依赖）。
import { treasuryTombstoneReplacementVerdict as _retentionVerdictForAssembly } from "@/runtime/treasury/lineageGenerationRetirement";
void _retentionVerdictForAssembly;
import { validateTreasurySemanticLineage } from "@/runtime/treasury/semanticLineageValidation";
import { recomputeTreasuryDurableIdentityDigest } from "@/runtime/treasury/identityProof";
import { TREASURY_LOWLEVEL_SOURCE_RUNTIME } from "@/runtime/treasury/authorityLevel";
import * as fs from "node:fs";
import * as path from "node:path";

beforeEach(() => {
  clearTreasuryPersistenceForTest();
});

const POSTINGS = [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }] as const;

function rootDurableOf(rootId: string, digest: string): string {
  return recomputeTreasuryDurableIdentityDigest({
    transactionId: rootId,
    digest,
    actionKind: "terminal.send",
    source: "test",
    postings: POSTINGS,
  })!;
}

/**
 * 长期生命周期驱动：root 建链后推进 generations 代（每代 not-executed
 * retirement → exact proof → final tombstone → 下一代接管），周期推进
 * Game.time（每代 +100——retention 5000 即约 50 代后旧 tombstone 可驱逐；
 * Resolution 满载写入自动触发惰性驱逐）。返回观察快照。
 */
function driveLifecycle(rootId: string, generations: number): {
  readonly lineageId: string;
  readonly childIds: readonly string[];
  readonly activeEntryCountMax: number;
  readonly graEntryCountMax: number;
  readonly resolutionEntryCountMax: number;
} {
  const digest = "1111111111111111";
  const created = createTreasuryAttemptLineageRecord({
    rootTransactionId: rootId,
    rootIdentity: { digest, durableIdentityDigest: rootDurableOf(rootId, digest) },
    actionKind: "terminal.send",
    authorityClass: "lowlevel",
    lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    rearmable: true,
    retrySemanticDigest: "6666666666666666",
  });
  if (created.status !== "written") throw new Error("create failed");
  const lineageId = created.record.lineageId;
  const childIds: string[] = [];
  let current = rootId;
  let activeEntryCountMax = 0;
  let graEntryCountMax = 0;
  let resolutionEntryCountMax = 0;
  for (let gen = 1; gen <= generations; gen += 1) {
    Game.time += 100;
    // ── 当前代 not-executed retirement（gen0 由 create 后直接 converge；后续代显式 retire）。
    if (gen > 1) {
      if (retireTreasuryLineageCurrentAttempt({ lineageId, rearmable: true, retrySemanticDigest: "6666666666666666" }).status === "rejected") throw new Error(`retire gen ${gen} failed`);
    }
    if (convergeTreasuryLineageRetirementFromFacts(lineageId).status !== "completed") throw new Error(`converge gen ${gen - 1} failed`);
    const recordBefore = readTreasuryAttemptLineageRecord(lineageId)!;
    // ── 该代 final not-executed tombstone（retention 驱逐候选；满载自动 evict）。
    const tombstone = writeTreasuryResolutionTombstone({
      transactionId: recordBefore.currentTransactionId,
      digest: recordBefore.currentIdentity.digest,
      resolution: "not-executed",
      stage: "final",
      proofLevel: recordBefore.authorityClass,
      actionTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      durableIdentityDigest: recordBefore.currentIdentity.durableIdentityDigest,
      lowlevelSource: recordBefore.lowlevelSource,
      ...(gen >= 2 ? {
        lineageId: recordBefore.lineageId,
        lineageGeneration: recordBefore.generation,
        parentTransactionId: recordBefore.currentParentTransactionId,
        lineageBindingDigest: recordBefore.bindingDigest,
      } : {}),
    });
    if (tombstone.status === "rejected") throw new Error(`tombstone gen ${gen - 1} rejected: ` + JSON.stringify(tombstone));
    // ── 下一代接管。
    const childId = deriveTreasuryLineageNextChildTransactionId(lineageId, gen, rootId);
    if (stageTreasuryLineageCapabilityIssued(lineageId, childId).status === "rejected") throw new Error(`stage issued gen ${gen}`);
    if (stageTreasuryLineageChildIntentPending(lineageId, childId).status === "rejected") throw new Error(`stage pending gen ${gen}`);
    const pendingBinding = readTreasuryAttemptLineageRecord(lineageId)!.pendingBindingDigest!;
    const childDurable = recomputeTreasuryDurableIdentityDigest({
      transactionId: childId,
      digest,
      actionKind: "terminal.send",
      source: "test",
      postings: POSTINGS,
      lineageId,
      lineageGeneration: gen,
      parentTransactionId: current,
      lineageBindingDigest: pendingBinding,
    })!;
    if (activateTreasuryLineageChild(lineageId, { digest, durableIdentityDigest: childDurable, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME }).status === "rejected") {
      throw new Error(`activate gen ${gen} failed`);
    }
    childIds.push(childId);
    current = childId;
    activeEntryCountMax = Math.max(activeEntryCountMax, peekTreasuryAttemptLineageHealth().entryCount);
    graEntryCountMax = Math.max(graEntryCountMax, peekTreasuryGenerationRetirementHealth().entryCount);
    resolutionEntryCountMax = Math.max(resolutionEntryCountMax, peekTreasuryResolutionStoreHealth().entryCount);
  }
  return { lineageId, childIds, activeEntryCountMax, graEntryCountMax, resolutionEntryCountMax };
}

describe("300 代长期收敛（第二十一轮 15.1）", () => {
  it("300 代完整生命周期：entryCount 恒 1、child ID 唯一、依赖收敛、store 有界", () => {
    const result = driveLifecycle("r21_300_root", 300);
    const record = readTreasuryAttemptLineageRecord(result.lineageId)!;
    expect(record.generation).toBe(300);
    // active lineage entryCount 恒 1。
    expect(result.activeEntryCountMax).toBe(1);
    expect(peekTreasuryAttemptLineageHealth().entryCount).toBe(1);
    // 每代 child ID 唯一。
    expect(new Set(result.childIds).size).toBe(300);
    // Resolution / GRA 容量有界（未超硬容量）。
    expect(result.resolutionEntryCountMax).toBeLessThanOrEqual(TREASURY_RESOLUTION_MAX_ENTRIES);
    expect(peekTreasuryResolutionStoreHealth().entryCount).toBeLessThanOrEqual(TREASURY_RESOLUTION_MAX_ENTRIES);
    expect(peekTreasuryGenerationRetirementHealth().entryCount).toBeLessThanOrEqual(256);
    // 历史 proof 随 tombstone 驱逐收敛（远小于代数）。
    expect(peekTreasuryGenerationRetirementHealth().entryCount).toBeLessThan(120);
    // 当前代 exact proof 在位（下一代 capability 门禁依据）。
    expect(readTreasuryGenerationRetirementProof(result.lineageId, 299)).toBeDefined();
    // root 重放门禁：同 root 再建链拒绝。
    const replay = createTreasuryAttemptLineageRecord({
      rootTransactionId: "r21_300_root",
      rootIdentity: { digest: "1111111111111111", durableIdentityDigest: rootDurableOf("r21_300_root", "1111111111111111") },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      rearmable: true,
    });
    expect(replay.status).toBe("rejected");
  }, 120_000);

  it("当前代 proof 不会因历史代驱逐提前释放（capability 门禁依赖保留）", () => {
    const result = driveLifecycle("r21_cur_pin", 60);
    const record = readTreasuryAttemptLineageRecord(result.lineageId)!;
    expect(record.generation).toBe(60);
    // gen59 是当前代的上一代 retirement proof——在 gen60 接管后是历史代，
    // 其 tombstone 在窗口内未驱逐 → proof 仍在；当前代 gen60 的 proof 尚未
    // 写入（retire 才写）——验证 gen59 proof 可查且 gen0 之前的代已收敛。
    expect(readTreasuryGenerationRetirementProof(result.lineageId, 59)).toBeDefined();
    expect(lookupTreasuryGenerationRetirementProofByAttemptId(result.childIds[58])).toBeDefined();
  });
});

describe("retention 窗口内容量边界（第二十一轮 15.2）", () => {
  it("全部 tombstone 位于窗口内时达到硬容量 → fail closed（不提前驱逐、不覆盖）", () => {
    // 手塞 TREASURY_RESOLUTION_MAX_ENTRIES 条未过期 final not-executed tombstone。
    for (let i = 0; i < TREASURY_RESOLUTION_MAX_ENTRIES; i += 1) {
      const rootId = `r21_cap_${i}`;
      const written = writeTreasuryResolutionTombstone({
        transactionId: rootId,
        digest: "1111111111111111",
        resolution: "not-executed",
        stage: "final",
        proofLevel: "lowlevel",
        actionTick: Game.time,
        observationTick: Game.time,
        resolvedAtTick: Game.time,
        durableIdentityDigest: "2222222222222222",
        lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      });
      if (written.status === "rejected") throw new Error(`fill ${i} failed: ` + written.detail);
    }
    expect(peekTreasuryResolutionStoreHealth().entryCount).toBe(TREASURY_RESOLUTION_MAX_ENTRIES);
    // 满载 + 全部在窗口内：第 257 条明确 fail closed（不提前驱逐未过期 proof）。
    const overflow = writeTreasuryResolutionTombstone({
      transactionId: "r21_cap_overflow",
      digest: "1111111111111111",
      resolution: "not-executed",
      stage: "final",
      proofLevel: "lowlevel",
      actionTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      durableIdentityDigest: "2222222222222222",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    });
    expect(overflow.status).toBe("rejected");
    // 未提前删除未过期 proof（全部仍在）。
    expect(peekTreasuryResolutionStoreHealth().entryCount).toBe(TREASURY_RESOLUTION_MAX_ENTRIES);
  });
});

describe("operation-count 与空闲成本（第二十一轮 15.3/18）", () => {
  it("300 代推进不引入 active lineage 全表扫描随代数增长", () => {
    resetTreasuryLineageRuntimeForTest();
    const scansBefore = lineageStoreEvents.fullScans;
    const result = driveLifecycle("r21_scan_root", 300);
    void result;
    // fullScans 只来自 load（heap 缓存后 O(1)）——与代数无线性关系。
    expect(lineageStoreEvents.fullScans - scansBefore).toBeLessThan(60);
    expect(peekTreasuryAttemptLineageHealth().entryCount).toBe(1);
  }, 120_000);

  it("50 次 semantic validation / byAttempt 查询零 fullScans；空闲恢复 O(1)", () => {
    const result = driveLifecycle("r21_oc_root", 3);
    const record = readTreasuryAttemptLineageRecord(result.lineageId)!;
    const identityInput = {
      digest: record.currentIdentity.digest,
      durableIdentityDigest: record.currentIdentity.durableIdentityDigest,
      lowlevelSource: record.lowlevelSource,
    };
    const proofInput = {
      lineageId: record.lineageId,
      lineageGeneration: record.generation,
      parentTransactionId: record.currentParentTransactionId!,
      lineageBindingDigest: record.bindingDigest!,
    };
    resetTreasuryGenerationRetirementRuntimeForTest();
    // reset 同时清零计数——基准取 reset 后（首次访问 1 次 load 全表）。
    const graScans = generationRetirementEvents.fullScans;
    for (let i = 0; i < 50; i += 1) {
      expect(validateTreasurySemanticLineage({ transactionId: record.currentTransactionId, proof: proofInput, identity: identityInput }).verdict).toBe("match");
      // gen2（已退休历史代）的 proof 经 byAttempt 命中；活跃代 gen3 无 proof（retire 才写）。
      expect(lookupTreasuryGenerationRetirementProofByAttemptId(result.childIds[1])).toBeDefined();
    }
    // global reset 后首次访问 1 次 load 全表；其后 50 次 O(1) 查询零扫描。
    expect(generationRetirementEvents.fullScans).toBe(graScans + 1);
    // 空闲 beginTick 恢复 O(1)（idleFastPath + 零扫描）。
    const lineageScansBefore = lineageStoreEvents.fullScans;
    const recovery = recoverTreasuryAttemptLineageAtTickBoundary();
    expect(recovery.chainCommitCompletions).toBe(0);
    expect(lineageStoreEvents.fullScans).toBe(lineageScansBefore);
  });
});

describe("架构扫描（第二十一轮 16）", () => {
  const treasuryDir = path.join(process.cwd(), "src", "runtime", "treasury");

  function readSource(name: string): string {
    return fs.readFileSync(path.join(treasuryDir, name), "utf8");
  }

  it("安全关键模块不再通过 binding+generation 快捷关闭 lineage", () => {
    const source = readSource("attemptLineage.ts");
    expect(source).not.toContain("receiptProof.binding === record.bindingDigest");
    expect(source).not.toContain("receiptProof.generation === record.generation");
    // child_active 补完成必须经单一 verifier。
    expect(source).toContain("verifyTreasuryChildActiveCommitRecovery");
  });

  it("compaction 不再只检查 exact proof 存在性（必须 relation）", () => {
    const source = readSource("lineageRetirementSummary.ts");
    expect(source).toContain("verifyTreasuryGenerationRetirementRelation");
    // 存在性单独放行形态已删除（readProof === undefined 只出现在缺失拒绝分支）。
    expect(source).not.toMatch(/if \(readTreasuryGenerationRetirementProof\([^)]*\) === undefined\) \{\s*return \{ status: "rejected"[^}]*\}\s*\}\s*return \{ status: "compacted" \}/);
  });

  it("receipt refresh 不再使用非 class-aware 旧 relation 作为许可", () => {
    const source = readSource("receipts.ts");
    expect(source).not.toContain("treasuryAttemptIdentityRelation(");
    expect(source).toContain("treasuryExactAttemptIdentityRelation");
  });

  it("安全关键 attempt identity 构造经统一 builder（新模块不手工拼接）", () => {
    for (const name of ["currentLineageSettlementVerifier.ts", "lineageRetirementSummary.ts", "generationRetirementRelation.ts", "terminalExactIdentity.ts"]) {
      const source = readSource(name);
      // 不允许手写 TreasuryExactAttemptIdentity 字面量（必须经 OfFacts/OfReceiptProof 等 builder）。
      expect(source).not.toMatch(/:\s*TreasuryExactAttemptIdentity\s*=\s*\{/);
    }
  });

  it("raw startsWith(\"tr1_\") 只出现在白名单模块", () => {
    const allowed = new Set(["transactionId.ts", "lineageProof.ts"]);
    const files = fs.readdirSync(treasuryDir).filter((f) => f.endsWith(".ts") && !f.includes(".test."));
    for (const file of files) {
      if (allowed.has(file)) continue;
      const source = readSource(file);
      expect(source.includes('startsWith("tr1_")')).toBe(false);
    }
  });
});
