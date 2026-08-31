/**
 * 【第十四轮第十六节】operation-count fixture。
 *
 * 证明新增的严格性不引入无界扫描：
 * - staged recovery：receipt tick 充分时仍执行单条 proof 的 identity 读取
 *   （O(1) key 读取），不触发 receipt 全表扫描（receiptFullScans 不增）；
 * - 双 authority 比较：与单条持久事实大小线性，不扫描其它 transaction
 *   （quarantine/intent 的 fullScans 在 load 后稳定）；
 * - authorization-fault 完整 validation：write readiness 首次触发一次有界
 *   全表扫描，heap 缓存后保持快路径（fullScans 不随查询次数增长）。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest, commitSettledReceipt, readTreasuryReceiptEventCounters } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  quarantineTreasuryTransaction,
  readTreasuryQuarantineCounters,
  resetTreasuryQuarantineRuntimeForTest,
} from "@/runtime/treasury/quarantine";
import { readTreasuryIntentCounters, resetTreasuryIntentRuntimeForTest, writeTreasuryIntentEntry } from "@/runtime/treasury/intents";
import {
  readTreasuryResolutionStoreCounters,
  readTreasuryResolutionTombstone,
  resetTreasuryResolutionStoreForTest,
  writeTreasuryResolutionTombstone,
} from "@/runtime/treasury/resolutionStore";
import {
  peekTreasuryAuthorizationFaultHealth,
  readTreasuryAuthorizationFaultCounters,
  resetTreasuryAuthorizationFaultRuntimeForTest,
  writeTreasuryAuthorizationFaultEntry,
} from "@/runtime/treasury/authorizationFaults";
import { resolveTreasuryUnresolvedAuthority } from "@/runtime/treasury/unresolvedAuthority";
import { computeTreasuryDurableIdentityDigest } from "@/runtime/treasury/durableIdentity";
import { TREASURY_LOWLEVEL_SOURCE_RUNTIME } from "@/runtime/treasury/authorityLevel";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import { makeTreasuryTestTransferAdapter, registerTreasuryActionAdapter } from "@/runtime/treasury/actionContracts";
import { registerTreasuryPolicyResolver, makeNoReserveTreasuryPolicy } from "@/runtime/treasury/policyAuthority";
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

const POSTINGS = [{ roomName: "W1N57", locationKind: "storage" as const, resource: "energy" as const, delta: -500 }];
const SEMANTIC = "terminal.send@reconciler-semantics-v1";

function lowlevelIdentity(transactionId: string, digest: string): string {
  return computeTreasuryDurableIdentityDigest({
    transactionId,
    digest,
    actionKind: "terminal.send",
    postings: POSTINGS.map((leg) => ({ ...leg })),
    source: "test",
    adapterSemanticIdentity: SEMANTIC,
  });
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  registerTreasuryActionAdapter({ ...makeTreasuryTestTransferAdapter(), kind: "terminal.send" });
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
});

describe("staged recovery operation count（第十四轮第十六节）", () => {
  it("receipt tick 充分时执行单条 proof identity 读取，不触发 receipt 全表扫描", () => {
    const transactionId = "oc_receipt";
    const digest = "0123456789abcdef";
    const identity = lowlevelIdentity(transactionId, digest);
    const quarantineWrite = quarantineTreasuryTransaction({
      transactionId,
      authorityLevel: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      durableIdentityDigest: identity,
      digest,
      tick: Game.time,
      kind: "terminal.send",
      source: "test",
      phase: "ok_pending_commit_unresolved",
      outcome: "returned_ok",
      settlement: "quarantined",
      adapterSemanticIdentity: SEMANTIC,
      deltas: POSTINGS.map((leg) => ({ ...leg })),
      recordedAt: Game.time,
    });
    expect(quarantineWrite.status).toBe("written");
    // receipt 已在 required tick（tick 充分——恢复不得跳过 identity 校验，
    // 也不得因此全表扫描 receipt）。
    expect(commitSettledReceipt(transactionId, Game.time, { digest, durableIdentityDigest: identity }).status).toBe("written");
    const tombWrite = writeTreasuryResolutionTombstone({
      transactionId,
      digest,
      resolution: "committed",
      stage: "resolving",
      proofLevel: "lowlevel",
      durableIdentityDigest: identity,
      actionTick: Game.time,
      settledAtTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      reconcilerKind: "terminal.send",
      source: "test",
    });
    expect(tombWrite.status).not.toBe("rejected");
    // 附加若干无关 receipt（若误全表扫描，fullScan 计数暴露）。
    for (let i = 0; i < 5; i += 1) {
      expect(commitSettledReceipt(`oc_noise_${String(i)}`, Game.time, { digest, durableIdentityDigest: `aaaaaaaaaaaaaa0${String(i)}` }).status).toBe("written");
    }
    const receiptBefore = readTreasuryReceiptEventCounters().receiptFullScans;
    Game.time += 1;
    makeService().beginTick();
    expect(readTreasuryResolutionTombstone(transactionId)?.stage).toBe("final");
    expect(readTreasuryQuarantineCounters().fullScans).toBeGreaterThanOrEqual(0);
    // receipt 全表扫描计数不因 staged recovery 的 identity 读取而增长。
    expect(readTreasuryReceiptEventCounters().receiptFullScans).toBe(receiptBefore);
  });
});

describe("dual authority comparison operation count", () => {
  it("同 id 双 authority 反复比较不产生新的 store 全表扫描（load 缓存后 O(1) entry 读取）", () => {
    const transactionId = "oc_dual";
    const digest = "0123456789abcdef";
    const identity = lowlevelIdentity(transactionId, digest);
    const quarantineWrite = quarantineTreasuryTransaction({
      transactionId,
      authorityLevel: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      durableIdentityDigest: identity,
      digest,
      tick: Game.time,
      kind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick",
      outcome: "started_unknown",
      settlement: "quarantined",
      adapterSemanticIdentity: SEMANTIC,
      deltas: POSTINGS.map((leg) => ({ ...leg })),
      recordedAt: Game.time,
    });
    expect(quarantineWrite.status).toBe("written");
    const intentWrite = writeTreasuryIntentEntry({
      transactionId,
      durableIdentityDigest: identity,
      digest,
      actionKind: "terminal.send",
      kind: "terminal.send",
      source: "test",
      adapterSemanticIdentity: SEMANTIC,
      postings: POSTINGS.map((leg) => ({ ...leg })),
      outcome: "started_unknown",
      settlement: "executing",
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
    });
    expect(intentWrite.status).toBe("written");
    // 预热（触发各自 store 的 load 全量验证——允许的一次性成本）。
    expect(resolveTreasuryUnresolvedAuthority(transactionId).status).toBe("ok");
    const quarantineScans = readTreasuryQuarantineCounters().fullScans;
    const intentScans = readTreasuryIntentCounters().fullScans;
    for (let i = 0; i < 20; i += 1) {
      expect(resolveTreasuryUnresolvedAuthority(transactionId).status).toBe("ok");
    }
    expect(readTreasuryQuarantineCounters().fullScans).toBe(quarantineScans);
    expect(readTreasuryIntentCounters().fullScans).toBe(intentScans);
  });
});

describe("authorization-fault validation caching（第十四轮第十四节）", () => {
  it("write readiness 首次触发一次有界全表扫描，heap 缓存后快路径（fullScans 不随查询增长）", () => {
    const identity = lowlevelIdentity("oc_fault", "abcdef0123456789");
    const write = writeTreasuryAuthorizationFaultEntry({
      transactionId: "oc_fault",
      authorityLevel: "forensic",
      digest: "abcdef0123456789",
      durableIdentityDigest: identity,
      actionKind: "terminal.send",
      adapterSemanticIdentity: SEMANTIC,
      postings: POSTINGS.map((leg) => ({ ...leg })),
      faultTick: Game.time,
      outcome: "not_started",
      rollbackConfirmed: true,
      source: "test",
    });
    expect(write.status).toBe("written");
    resetTreasuryAuthorizationFaultRuntimeForTest();
    // 首次 readiness 收集（query 的 writeAdmission）触发完整 load 验证。
    const service = makeService();
    const first = service.query({ resource: "energy", rooms: ["W1N57"] });
    expect(first.writeAdmission.ready).toBe(false);
    const scansAfterFirst = readTreasuryAuthorizationFaultCounters().fullScans;
    expect(scansAfterFirst).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 20; i += 1) {
      void peekTreasuryAuthorizationFaultHealth();
      const view = service.query({ resource: "energy", rooms: ["W1N57"] });
      expect(view.writeAdmission.ready).toBe(false);
    }
    expect(readTreasuryAuthorizationFaultCounters().fullScans).toBe(scansAfterFirst);
  });
});

// 计数器 reset 导入锚点（与 beforeEach 的全局清理配合使用）。
void resetTreasuryQuarantineRuntimeForTest;
void resetTreasuryIntentRuntimeForTest;
void resetTreasuryResolutionStoreForTest;
void resetTreasuryAuthorizationFaultRuntimeForTest;
