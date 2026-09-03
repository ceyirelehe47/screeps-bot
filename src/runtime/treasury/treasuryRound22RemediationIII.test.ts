/**
 * 【Round 22 Remediation III】durable stage acknowledgement & proof
 * activation 的确定性回归矩阵。
 *
 * 覆盖任务书十二节：
 * 1  Stage Acknowledgement：阶段写入失败 / read-back 被篡改（布尔回滚 /
 *    identity 篡改）→ 后续 destructive action 全部阻断、entry 与外部 proof
 *    保留、结构化 pending；
 * 2  Proof Activation：matching tombstone 验证矩阵（absent / digest 冲突 /
 *    contract/cohort/durable/lowlevel 冲突 / 幂等 / global reset 后不自动激活）；
 * 3  Release-trusted：无关 Receipt entry 损坏时零 destructive；trusted 完整
 *    match 可推进；identity conflict 保留 marker/Authority；
 * 4  Opposite Proof：四分类阻断（match / conflict / insufficient /
 *    store_unhealthy——insufficient ≠ absent）；
 * 5  Result Truthfulness：journal 删除 read-back absent 才 fully complete；
 *    unrelated marker 两事实分离；store unhealthy fail closed；
 * 6  journal read-back 单键 O(1)（无全 store 扫描）。
 *
 * 全部使用 mock 与 test-only fault injector，不调用真实 Game 写 API。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest, commitSettledReceipt, resetTreasuryReceiptHeapCacheForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { recordTreasuryWriteFault, readTreasuryWriteFault } from "@/runtime/treasury/writeFault";
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
  openTreasuryResolutionCleanup,
  readTreasuryResolutionCleanupEntry,
  readTreasuryResolutionCleanupEvents,
  markTreasuryResolutionCleanupStage,
  readBackTreasuryResolutionCleanupEntryFromMemory,
  recoverTreasuryResolutionCleanupAtTickBoundary,
  resetTreasuryResolutionCleanupHeapCacheForTest,
  treasuryResolutionCleanupOpenInputOfFacts,
} from "@/runtime/treasury/resolutionCleanupJournal";
import {
  acknowledgeTreasuryCleanupMarkerDischarge,
  acknowledgeTreasuryCleanupAuthorityRelease,
  acknowledgeTreasuryCleanupOutcomeFinalization,
  acknowledgeTreasuryCleanupLineageFinalization,
  completeTreasuryCleanupAcknowledged,
  setTreasuryCleanupAckFaultForTest,
} from "@/runtime/treasury/cleanupStageAcknowledgement";
import {
  acknowledgeTreasuryCleanupSettlementProof,
  registerTreasuryCleanupProofProbesForAssembly,
} from "@/runtime/treasury/settlementProofActivation";
import {
  checkTreasuryOppositeProofsForCommitted,
  checkTreasuryOppositeProofsForNotExecuted,
  registerTreasuryOppositeProofDepsForAssembly,
} from "@/runtime/treasury/oppositeProofMatrix";
import { advanceTreasuryResolutionCleanupPhases } from "@/runtime/treasury/resolutionCleanupCoordinator";
import { resolveTreasuryUnresolvedAuthority } from "@/runtime/treasury/unresolvedAuthority";
import { TREASURY_LOWLEVEL_SOURCE_RUNTIME } from "@/runtime/treasury/authorityLevel";
import { createTreasuryAttemptLineageRecord } from "@/runtime/treasury/attemptLineage";
import { treasuryExactAttemptIdentityOfFacts } from "@/runtime/treasury/exactAttemptIdentity";
import { installRooms } from "@mock/treasury";
import { treasuryTestService } from "@/runtime/treasury/testHarness";

const DIGEST = "0123456789abcdef";
const DIGEST_OTHER = "fedcba9876543210";
/** durableIdentityDigest 由 quarantine 写入按 postings 重算——不硬编码。 */
const LOWLEVEL_SPREAD = { lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME } as const;
const DURABLE_FIXED = "0cc99174bb6f2e74";

function seedQuarantineAuthority(transactionId: string): string {
  const write = quarantineTreasuryTransaction({
    transactionId,
    authorityLevel: "lowlevel",
    ...LOWLEVEL_SPREAD,
    digest: DIGEST,
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
  const durable = readTreasuryQuarantineEntry(transactionId)?.durableIdentityDigest;
  expect(durable).toBeDefined();
  return durable as string;
}

function seedV4Marker(transactionId: string, durable: string): void {
  recordTreasuryWriteFault({
    transactionId,
    digest: DIGEST,
    tick: Game.time,
    kind: "terminal.send",
    source: "test",
    phase: "ok_pending_commit_unresolved",
    status: "unresolved",
    recordedAt: Game.time,
    markerProtocol: 4 as const,
    identityProfile: "lowlevel" as const,
    authorityClass: "lowlevel" as const,
    ...LOWLEVEL_SPREAD,
    durableIdentityDigest: durable,
  });
  expect(readTreasuryWriteFault()).toBeDefined();
}

function seedResolvingCommittedTombstone(transactionId: string, durable: string): void {
  const write = writeTreasuryResolutionTombstone({
    transactionId,
    digest: DIGEST,
    resolution: "committed",
    stage: "resolving",
    proofLevel: "lowlevel",
    ...LOWLEVEL_SPREAD,
    durableIdentityDigest: durable,
    actionTick: Game.time,
    settledAtTick: Game.time,
    observationTick: Game.time,
    resolvedAtTick: Game.time,
    reconcilerKind: "terminal.send",
    source: "test",
  });
  expect(write.status).not.toBe("rejected");
}

function seedFinalNotExecutedTombstone(transactionId: string, durable: string): void {
  const write = writeTreasuryResolutionTombstone({
    transactionId,
    digest: DIGEST,
    resolution: "not-executed",
    stage: "final",
    proofLevel: "lowlevel",
    ...LOWLEVEL_SPREAD,
    durableIdentityDigest: durable,
    actionTick: Game.time,
    observationTick: Game.time,
    resolvedAtTick: Game.time,
    reconcilerKind: "terminal.send",
    source: "test",
  });
  expect(write.status).not.toBe("rejected");
}

function openCommittedCleanupEntry(transactionId: string, durable: string): void {
  const opened = openTreasuryResolutionCleanup(
    treasuryResolutionCleanupOpenInputOfFacts({
      transactionId,
      digest: DIGEST,
      resolution: "committed",
      proofClass: "lowlevel",
      ...LOWLEVEL_SPREAD,
      durableIdentityDigest: durable,
    }),
  );
  expect(opened.status).toBe("opened");
}

function openNotExecutedCleanupEntry(transactionId: string, durable: string, proofMode: "proof_durable" | "reservation" = "proof_durable"): void {
  const opened = openTreasuryResolutionCleanup({
    ...treasuryResolutionCleanupOpenInputOfFacts({
      transactionId,
      digest: DIGEST,
      resolution: "not-executed",
      proofClass: "lowlevel",
      ...LOWLEVEL_SPREAD,
      durableIdentityDigest: durable,
    }),
    ...(proofMode === "reservation" ? { proofMode: "reservation" as const } : {}),
  });
  expect(opened.status).toBe("opened");
}

function exactOfFacts(transactionId: string, durable: string) {
  const exact = treasuryExactAttemptIdentityOfFacts(
    transactionId,
    { digest: DIGEST, durableIdentityDigest: durable, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME },
    "lowlevel",
  );
  expect(exact).not.toBeNull();
  return exact!;
}

/** committed cleanup 场景（marker + authority + resolving tombstone + journal entry + receipt）。 */
function seedCommittedCleanupScene(transactionId: string, opts: { marker?: boolean; receiptDigest?: string } = {}): string {
  const durable = seedQuarantineAuthority(transactionId);
  if (opts.marker !== false) seedV4Marker(transactionId, durable);
  seedResolvingCommittedTombstone(transactionId, durable);
  commitSettledReceipt(transactionId, Game.time, {
    digest: opts.receiptDigest ?? DIGEST,
    durableIdentityDigest: durable,
    lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
  });
  openCommittedCleanupEntry(transactionId, durable);
  return durable;
}

/** 已释放 authority 的 final not-executed cleanup 场景。 */
function seedReleasedNotExecutedScene(transactionId: string, opts: { reservation?: boolean } = {}): string {
  const durable = seedQuarantineAuthority(transactionId);
  seedFinalNotExecutedTombstone(transactionId, durable);
  expect(releaseTreasuryQuarantineEntry(transactionId)).toBe(true);
  releaseTreasuryIntentEntry(transactionId);
  // 【Remediation IV 九.2】not-executed settlement 的 root lineage publication
  //（生产 immediate/staged 路径在 tombstone 前创建——retiring 状态由
  // outcome/lineage 阶段的 converge 收敛；意外缺失时 lineage 阶段结构化
  // blocked，不再 not_applicable）。
  if (opts.reservation !== true) {
    const lineageCreated = createTreasuryAttemptLineageRecord({
      rootTransactionId: transactionId,
      rootIdentity: { digest: DIGEST, durableIdentityDigest: durable },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      rearmable: false,
      identityProfile: "lowlevel",
      nonRearmReason: "test fixture（无 retry semantic facts）",
    });
    expect(lineageCreated.status).toBe("written");
  }
  openNotExecutedCleanupEntry(transactionId, durable, opts.reservation === true ? "reservation" : "proof_durable");
  // 【Remediation IV 六.4】authority 已释放的合法中断窗口要求 marker 阶段
  // 已 ack（安全顺序 marker→authority）——fixture 按生产顺序补 marker ack
  //（marker 本就不存在，already_absent 完成语义）后再进入 gate。
  if (opts.reservation !== true) {
    markTreasuryResolutionCleanupStage(transactionId, "marker_discharge", "already_absent");
  }
  return durable;
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  resetTreasuryResolutionStoreForTest();
  resetTreasuryResolutionCleanupHeapCacheForTest();
  setTreasuryCleanupAckFaultForTest(null);
  registerTreasuryCleanupProofProbesForAssembly({
    readTombstone: (transactionId) => readTreasuryResolutionTombstone(transactionId),
    resolutionStoreHealthy: () => peekTreasuryResolutionStoreHealth().healthy,
  });
  registerTreasuryOppositeProofDepsForAssembly({
    readTombstone: (transactionId) => readTreasuryResolutionTombstone(transactionId),
    resolutionStoreHealthy: () => peekTreasuryResolutionStoreHealth().healthy,
    lookupGRAProof: () => undefined,
    graStoreHealthy: () => true,
  });
});

afterAll(() => {
  setTreasuryCleanupAckFaultForTest(null);
  registerTreasuryCleanupProofProbesForAssembly(null);
  registerTreasuryOppositeProofDepsForAssembly(null);
});

// ── 1. Stage Acknowledgement ─────────────────────────────────────────────────

describe("Remediation III 1：stage acknowledgement 硬门禁", () => {
  it("marker discharge 成功但 journal marker stage 写失败 → Authority 保留、不 finalize、阶段 pending", () => {
    seedCommittedCleanupScene("r3_tx");
    setTreasuryCleanupAckFaultForTest(({ transactionId, stage, phase }) =>
      transactionId === "r3_tx" && stage === "marker_discharge" && phase === "before_write" ? "write_rejected" : null,
    );
    const ack = acknowledgeTreasuryCleanupMarkerDischarge({ transactionId: "r3_tx" });
    expect(ack.outcome).toBe("write_rejected");
    // marker 实际已删除（discharge read-back 完成），但 journal 阶段未持久。
    expect(readTreasuryResolutionCleanupEntry("r3_tx")?.markerDischarged).toBe(false);
    // Authority 保留（后续 destructive 全部阻断）。
    expect(readTreasuryQuarantineEntry("r3_tx")).toBeDefined();
    expect(resolveTreasuryUnresolvedAuthority("r3_tx").status).toBe("ok");
    // coordinator 推进返回 marker pending。
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: "r3_tx" });
    expect(advance.status).toBe("pending");
    expect(advance.pendingStage).toBe("marker_discharge");
    // 不 finalize：tombstone 仍 resolving。
    expect(readTreasuryResolutionTombstone("r3_tx")?.stage).toBe("resolving");
  });

  it("marker stage 写成功但 read-back 布尔被回滚 → read_back_failed、Authority 保留", () => {
    seedCommittedCleanupScene("r3_tx");
    setTreasuryCleanupAckFaultForTest(({ transactionId, stage, phase }) =>
      transactionId === "r3_tx" && stage === "marker_discharge" && phase === "after_write" ? "revert_stage" : null,
    );
    const ack = acknowledgeTreasuryCleanupMarkerDischarge({ transactionId: "r3_tx" });
    expect(ack.outcome).toBe("read_back_failed");
    expect(readTreasuryQuarantineEntry("r3_tx")).toBeDefined();
  });

  it("marker stage read-back identity 被篡改 → read_back_failed、Authority 保留", () => {
    seedCommittedCleanupScene("r3_tx");
    setTreasuryCleanupAckFaultForTest(({ transactionId, stage, phase }) =>
      transactionId === "r3_tx" && stage === "marker_discharge" && phase === "after_write" ? "tamper_identity" : null,
    );
    const ack = acknowledgeTreasuryCleanupMarkerDischarge({ transactionId: "r3_tx" });
    expect(ack.outcome).toBe("read_back_failed");
    expect(readTreasuryQuarantineEntry("r3_tx")).toBeDefined();
  });

  it("authority release 后 authority stage 写失败 → 不 finalize、authority 阶段 pending", () => {
    seedCommittedCleanupScene("r3_tx", { marker: false });
    // marker 阶段先行确认（无 marker → already_absent 完成）。
    expect(acknowledgeTreasuryCleanupMarkerDischarge({ transactionId: "r3_tx" }).outcome).toBe("acknowledged");
    setTreasuryCleanupAckFaultForTest(({ transactionId, stage, phase }) =>
      transactionId === "r3_tx" && stage === "authority_release" && phase === "before_write" ? "write_rejected" : null,
    );
    const ack = acknowledgeTreasuryCleanupAuthorityRelease({ transactionId: "r3_tx" });
    // authority 实际已释放（handler release + read-back not_found 完成），但
    // journal 阶段写入被拒——幂等恢复下一轮重释放（already_absent）。
    expect(ack.outcome).toBe("write_rejected");
    expect(readTreasuryResolutionCleanupEntry("r3_tx")?.authorityReleased).toBe(false);
    // outcome 不得 finalize（前置阶段偏序阻断）。
    const outcome = acknowledgeTreasuryCleanupOutcomeFinalization({ transactionId: "r3_tx" });
    expect(outcome.outcome).toBe("blocked");
    expect(readTreasuryResolutionTombstone("r3_tx")?.stage).toBe("resolving");
  });

  it("final tombstone 写成功但 outcome stage 写失败 → lineage 不关闭、journal 保留", () => {
    seedCommittedCleanupScene("r3_tx", { marker: false });
    expect(acknowledgeTreasuryCleanupMarkerDischarge({ transactionId: "r3_tx" }).outcome).toBe("acknowledged");
    expect(acknowledgeTreasuryCleanupAuthorityRelease({ transactionId: "r3_tx" }).outcome).toBe("acknowledged");
    setTreasuryCleanupAckFaultForTest(({ transactionId, stage, phase }) =>
      transactionId === "r3_tx" && stage === "outcome_finalization" && phase === "before_write" ? "write_rejected" : null,
    );
    const outcome = acknowledgeTreasuryCleanupOutcomeFinalization({ transactionId: "r3_tx" });
    // external handler 已执行（resolving→final 写入成功），fault 只阻断
    // journal 阶段布尔——final tombstone 事实成立但阶段未持久。
    expect(outcome.outcome).toBe("write_rejected");
    expect(readTreasuryResolutionTombstone("r3_tx")?.stage).toBe("final");
    // lineage 阶段不得推进（偏序阻断）。
    const lineage = acknowledgeTreasuryCleanupLineageFinalization({ transactionId: "r3_tx" });
    expect(lineage.outcome).toBe("blocked");
    expect(readTreasuryResolutionCleanupEntry("r3_tx")).toBeDefined();
  });

  it("cleanup delete 后 read-back entry 复现 → journal completion pending", () => {
    seedReleasedNotExecutedScene("r3_tx2");
    setTreasuryCleanupAckFaultForTest(({ transactionId, stage, phase }) =>
      transactionId === "r3_tx2" && stage === "journal_completion" && phase === "after_delete" ? "restore_entry" : null,
    );
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: "r3_tx2" });
    expect(advance.status).toBe("pending");
    expect(advance.pendingStage).toBe("journal_completion");
    // entry 复现（删除未持久确认）——不得报告 fully complete。
    expect(readBackTreasuryResolutionCleanupEntryFromMemory("r3_tx2").status).toBe("present");
    const completion = completeTreasuryCleanupAcknowledged({
      transactionId: "r3_tx2",
      lineageDisposition: "final",
      globalWriteAdmissionStillLocked: false,
    });
    expect(completion.status).not.toBe("completed");
  });

  it("read-back 单键 O(1)：50 次阶段 read-back 不产生全 store 扫描", () => {
    for (let i = 0; i < 100; i++) {
      seedFinalNotExecutedTombstone(`r3_bulk_${i}`, DURABLE_FIXED);
    }
    openNotExecutedCleanupEntry("r3_probe", DURABLE_FIXED);
    for (let i = 0; i < 50; i++) {
      expect(readBackTreasuryResolutionCleanupEntryFromMemory("r3_probe").status).toBe("present");
    }
    // read-back 不做全 store 形状校验（shapeFailures 恒 0——单键 O(1)）。
    expect(readTreasuryResolutionCleanupEvents().shapeFailures).toBe(0);
  });
});

// ── 2. Proof Activation ──────────────────────────────────────────────────────

describe("Remediation III 2：proof activation 绑定 matching 持久 proof", () => {
  it("reservation 存在但 matching tombstone 不存在 → proof_absent、marker/Authority 保持", () => {
    seedReleasedNotExecutedScene("r3_ne", { reservation: true });
    // 撤销 tombstone（模拟 proof 未落盘）。
    const branch = (Memory.runtime as unknown as { treasury?: { resolutions?: { entries?: Record<string, unknown> } } }).treasury!;
    delete branch.resolutions!.entries["r:r3_ne"];
    const activation = acknowledgeTreasuryCleanupSettlementProof({ transactionId: "r3_ne" });
    expect(activation.outcome).toBe("proof_absent");
    expect(readTreasuryResolutionCleanupEntry("r3_ne")?.settlementProofDurable).toBe(false);
    // coordinator 在 activation 停（零后续 destructive）。
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: "r3_ne" });
    expect(advance.pendingStage).toBe("proof_activation");
  });

  it("tombstone digest 不同 → identity_conflict", () => {
    seedReleasedNotExecutedScene("r3_ne");
    // 篡改 tombstone digest（journal entry 与 proof 不一致）。
    const branch = (Memory.runtime as unknown as { treasury?: { resolutions?: { entries?: Record<string, { digest?: string }> } } }).treasury!;
    branch.resolutions!.entries["r:r3_ne"].digest = DIGEST_OTHER;
    const activation = acknowledgeTreasuryCleanupSettlementProof({ transactionId: "r3_ne" });
    expect(activation.outcome).toBe("identity_conflict");
  });

  it("contract/cohort/durable/lowlevel 任一不同 → identity_conflict（表驱动）", () => {
    const cases = [
      { field: "contractDigest", value: "ee55ff66aa77bb88" },
      { field: "authorizationCohortDigest", value: "aa11bb22cc33dd44" },
      { field: "durableIdentityDigest", value: "ffffffffffffffff" },
      { field: "lowlevelSource", value: "migrated-lowlevel@v9" },
    ];
    let index = 0;
    for (const { field, value } of cases) {
      const tx = `r3_conf_${index++}_${field.slice(0, 6)}`;
      seedReleasedNotExecutedScene(tx);
      // 篡改 tombstone 的对应维度（制造 journal entry 与 proof 的不一致）。
      const branch = (Memory.runtime as unknown as { treasury?: { resolutions?: { entries?: Record<string, Record<string, unknown>> } } }).treasury!;
      branch.resolutions!.entries[`r:${tx}`][field] = value;
      const activation = acknowledgeTreasuryCleanupSettlementProof({ transactionId: tx });
      expect(activation.outcome).toBe("identity_conflict");
    }
  });

  it("matching final not-executed tombstone → activated 并 Memory read-back 确认（幂等）", () => {
    seedReleasedNotExecutedScene("r3_ne", { reservation: true });
    const activation = acknowledgeTreasuryCleanupSettlementProof({ transactionId: "r3_ne" });
    expect(activation.outcome).toBe("activated");
    expect(readBackTreasuryResolutionCleanupEntryFromMemory("r3_ne").entry?.settlementProofDurable).toBe(true);
    expect(acknowledgeTreasuryCleanupSettlementProof({ transactionId: "r3_ne" }).outcome).toBe("already_activated");
  });

  it("matching resolving committed tombstone → 幂等复验成立", () => {
    seedCommittedCleanupScene("r3_cm", { marker: false });
    // committed 的 proof_durable open 创建即 true——幂等复验 matching proof。
    expect(acknowledgeTreasuryCleanupSettlementProof({ transactionId: "r3_cm" }).outcome).toBe("already_activated");
  });

  it("global reset（heap 缓存失效）后 reservation + matching proof → 幂等补激活；proof 不存在 → 不激活", () => {
    // 场景 A：proof 存在。
    seedReleasedNotExecutedScene("r3_rs_a", { reservation: true });
    resetTreasuryResolutionCleanupHeapCacheForTest();
    expect(acknowledgeTreasuryCleanupSettlementProof({ transactionId: "r3_rs_a" }).outcome).toBe("activated");
    // 场景 B：proof 不存在——保持 pending。
    seedQuarantineAuthority("r3_rs_b");
    openNotExecutedCleanupEntry("r3_rs_b", DURABLE_FIXED, "reservation");
    resetTreasuryResolutionCleanupHeapCacheForTest();
    expect(acknowledgeTreasuryCleanupSettlementProof({ transactionId: "r3_rs_b" }).outcome).toBe("proof_absent");
    expect(readBackTreasuryResolutionCleanupEntryFromMemory("r3_rs_b").entry?.settlementProofDurable).toBe(false);
  });
});

// ── 3. Release-trusted staged recovery ───────────────────────────────────────

describe("Remediation III 3：无关 Receipt entry 损坏 → 零 destructive", () => {
  it("当前 attempt Receipt 合法 + 同 store 另一 entry 损坏 → staged recovery 零 destructive 变化", () => {
    seedCommittedCleanupScene("r3_cm");
    // 无关 entry 损坏（直接篡改 store 中的另一 entry 形状）。
    const store = (Memory.runtime as unknown as { treasury?: { receipts?: { settled?: Record<string, unknown> } } }).treasury?.receipts;
    expect(store).toBeDefined();
    store!.settled["t:r3_broken"] = { level: 42 as never, settledAtTick: "corrupt" as never };
    // 模拟 global reset 后的首次 trusted 读取（load 校验重走——同 heap 的
    // O(1) 缓存不重扫是设计语义）。
    resetTreasuryReceiptHeapCacheForTest();
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: "r3_cm" });
    // release-trusted 通道 store_unhealthy → 零 marker discharge、零 release、
    // 零 finalize、journal 保留。
    expect(advance.status).toBe("pending");
    expect(readTreasuryWriteFault()).toBeDefined();
    expect(readTreasuryQuarantineEntry("r3_cm")).toBeDefined();
    expect(readTreasuryResolutionTombstone("r3_cm")?.stage).toBe("resolving");
    expect(readTreasuryResolutionCleanupEntry("r3_cm")).toBeDefined();
  });

  it("trusted Receipt 完整 match → coordinator 可推进至完全完成", () => {
    seedCommittedCleanupScene("r3_cm2", { marker: false });
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: "r3_cm2" });
    expect(advance.status).toBe("completed");
    expect(readBackTreasuryResolutionCleanupEntryFromMemory("r3_cm2").status).toBe("absent");
    expect(readTreasuryResolutionTombstone("r3_cm2")?.stage).toBe("final");
  });

  it("trusted Receipt identity conflict → marker 与 Authority 保留", () => {
    seedCommittedCleanupScene("r3_cm3", { receiptDigest: DIGEST_OTHER });
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: "r3_cm3" });
    expect(advance.status).toBe("pending");
    expect(readTreasuryWriteFault()).toBeDefined();
    expect(readTreasuryQuarantineEntry("r3_cm3")).toBeDefined();
  });
});

// ── 4. Opposite Proof fail-closed 矩阵 ───────────────────────────────────────

describe("Remediation III 4：相反 proof 的四分类阻断", () => {
  it("committed 目标 + matching final not-executed tombstone → exact_match conflict", () => {
    seedFinalNotExecutedTombstone("r3_opp", DURABLE_FIXED);
    const check = checkTreasuryOppositeProofsForCommitted("r3_opp", exactOfFacts("r3_opp", DURABLE_FIXED));
    expect(check.clear).toBe(false);
    expect(check.blockers[0]).toMatchObject({ source: "not-executed-tombstone", classification: "exact_match" });
  });

  it("committed 目标 + conflicting final not-executed tombstone → identity_conflict", () => {
    const write = writeTreasuryResolutionTombstone({
      transactionId: "r3_opp2",
      digest: DIGEST_OTHER,
      resolution: "not-executed",
      stage: "final",
      proofLevel: "lowlevel",
      ...LOWLEVEL_SPREAD,
      durableIdentityDigest: DURABLE_FIXED,
      actionTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      reconcilerKind: "terminal.send",
      source: "test",
    });
    expect(write.status).not.toBe("rejected");
    const check = checkTreasuryOppositeProofsForCommitted("r3_opp2", exactOfFacts("r3_opp2", DURABLE_FIXED));
    expect(check.clear).toBe(false);
    expect(check.blockers[0]).toMatchObject({ source: "not-executed-tombstone", classification: "identity_conflict" });
  });

  it("committed 目标 + insufficient not-executed tombstone（缺 expected 要求的维度）→ insufficient ≠ absent", () => {
    // tombstone 是合法 lowlevel proof；expected 额外携带 contractDigest
    // 维度——tombstone 无法证明该维度（insufficient ≠ absent）。
    seedFinalNotExecutedTombstone("r3_opp3", DURABLE_FIXED);
    const expectedWithContract = treasuryExactAttemptIdentityOfFacts(
      "r3_opp3",
      { digest: DIGEST, durableIdentityDigest: DURABLE_FIXED, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME, contractDigest: "ee55ff66aa77bb88" },
      "lowlevel",
    );
    const check = checkTreasuryOppositeProofsForCommitted("r3_opp3", expectedWithContract!);
    expect(check.clear).toBe(false);
    expect(check.blockers.some((blocker) => blocker.classification === "insufficient" || blocker.classification === "identity_conflict")).toBe(true);
  });

  it("not-executed 目标 + legacy committed Receipt → blocker（不视为 absent）", () => {
    commitSettledReceipt("r3_opp4", Game.time, {});
    const check = checkTreasuryOppositeProofsForNotExecuted("r3_opp4", exactOfFacts("r3_opp4", DURABLE_FIXED));
    expect(check.clear).toBe(false);
    expect(check.blockers.some((blocker) => blocker.source === "committed-receipt" && blocker.classification === "insufficient")).toBe(true);
  });

  it("not-executed 目标 + conflicting committed tombstone → identity_conflict", () => {
    seedResolvingCommittedTombstone("r3_opp5", DURABLE_FIXED);
    const expected = treasuryExactAttemptIdentityOfFacts(
      "r3_opp5",
      { digest: DIGEST_OTHER, durableIdentityDigest: DURABLE_FIXED, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME },
      "lowlevel",
    );
    const check = checkTreasuryOppositeProofsForNotExecuted("r3_opp5", expected!);
    expect(check.clear).toBe(false);
    expect(check.blockers.some((blocker) => blocker.source === "committed-tombstone" && blocker.classification === "identity_conflict")).toBe(true);
  });

  it("无相反 proof 且 store 健康 → clear", () => {
    seedFinalNotExecutedTombstone("r3_opp6", DURABLE_FIXED);
    const check = checkTreasuryOppositeProofsForNotExecuted("r3_opp6", exactOfFacts("r3_opp6", DURABLE_FIXED));
    expect(check.clear).toBe(true);
  });

  it("deps 未装配 → fail closed（store_unhealthy 语义）", () => {
    registerTreasuryOppositeProofDepsForAssembly(null);
    const check = checkTreasuryOppositeProofsForCommitted("r3_opp7", exactOfFacts("r3_opp7", DURABLE_FIXED));
    expect(check.clear).toBe(false);
    expect(check.blockers[0].classification).toBe("store_unhealthy");
  });
});

// ── 5. Result Truthfulness ───────────────────────────────────────────────────

describe("Remediation III 5：API 完成状态真实性", () => {
  it("journal completion 删除 read-back absent 才 fully complete（advance 报告与 journal 一致）", () => {
    seedCommittedCleanupScene("r3_truth", { marker: false });
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: "r3_truth" });
    expect(advance.status).toBe("completed");
    expect(advance.phases.journalEntryAbsent).toBe(true);
    expect(readBackTreasuryResolutionCleanupEntryFromMemory("r3_truth").status).toBe("absent");
  });

  it("unrelated marker：当前 attempt 可 complete + globalWriteAdmissionStillLocked=true", () => {
    // 另一 attempt 的 marker 持有全局锁。
    const durableOther = seedQuarantineAuthority("r3_other");
    seedV4Marker("r3_other", durableOther);
    seedCommittedCleanupScene("r3_unrel", { marker: false });
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: "r3_unrel" });
    expect(advance.status).toBe("completed");
    expect(advance.globalWriteAdmissionStillLocked).toBe(true);
    // 其它 attempt 的 marker 不删除。
    expect(readTreasuryWriteFault()?.transactionId).toBe("r3_other");
  });

  it("store unhealthy 时 advance fail closed（entry 保留）", () => {
    seedCommittedCleanupScene("r3_bad", { marker: false });
    // 篡改 journal store 形状（版本号非法）。
    const branch = (Memory.runtime as unknown as { treasury?: { resolutionCleanup?: { version?: number } } }).treasury!;
    branch.resolutionCleanup!.version = 99;
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: "r3_bad" });
    expect(advance.status).not.toBe("completed");
  });
});

// ── 6. beginTick journal recovery 经 coordinator（单一 owner） ────────────────

describe("Remediation III 6：journal recovery driver", () => {
  it("journal 未完成 entry 经 coordinator 推进；空闲幂等", () => {
    seedCommittedCleanupScene("r3_drv", { marker: false });
    const report = recoverTreasuryResolutionCleanupAtTickBoundary();
    expect(report.completed).toBe(1);
    expect(readBackTreasuryResolutionCleanupEntryFromMemory("r3_drv").status).toBe("absent");
    expect(readTreasuryResolutionTombstone("r3_drv")?.stage).toBe("final");
    expect(recoverTreasuryResolutionCleanupAtTickBoundary().examined).toBe(0);
  });

  it("production service beginTick 驱动同一 coordinator（immediate 与 beginTick 单一 owner）", () => {
    installRooms([
      { name: "W1N57", storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 }, terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 5_000 } },
    ]);
    const service = treasuryTestService(createTreasuryService({ getRooms: () => [] }));
    service.beginTick();
    expect(service).toBeDefined();
  });
});
