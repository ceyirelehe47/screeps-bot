/**
 * 【第十九轮】lineage 索引完整性测试（任务 25.5/25.9）。
 *
 * 覆盖（工作包 D）：
 * - same-record 判定改用 store entry identity（rootTransactionId）后，
 *   duplicate current / root-current 交叉 / duplicate lineageId 在 load
 *   全表校验与写入候选预检均 fail closed；
 * - 冲突时原 store 不变（不静默覆盖、不自动删除）、索引不构建；
 * - 写入候选冲突 → 原 store 与索引保持不变。
 */
import {
  clearTreasuryPersistenceForTest,
} from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  createTreasuryAttemptLineageRecord,
  deriveTreasuryLineageNextChildTransactionId,
  lookupTreasuryAttemptLineageByAttemptId,
  peekTreasuryAttemptLineageHealth,
  resetTreasuryLineageRuntimeForTest,
  updateTreasuryAttemptLineageRecord,
} from "@/runtime/treasury/attemptLineage";

function seedRecord(root: string, digest: string): void {
  const created = createTreasuryAttemptLineageRecord({
    rootTransactionId: root,
    rootIdentity: { digest },
    actionKind: "fill",
    authorityClass: "identity-bound",
    rearmable: false,
    nonRearmReason: "seed",
  });
  expect(created.status).not.toBe("rejected");
}

function lineageStoreEntries(): Record<string, unknown> {
  const store = (Memory.runtime as unknown as { treasury?: { attemptLineage?: { entries: Record<string, unknown> } } }).treasury?.attemptLineage;
  expect(store).toBeDefined();
  return store!.entries;
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
});

describe("lineage 索引完整性（第十九轮 25.5：same-record 判定用 entry identity）", () => {
  it("duplicate current（两条 record 的 current 相同、lineageId 各自合法）→ load fail closed、原数据保留", () => {
    seedRecord("r19_ix_a", "0000000000000001");
    seedRecord("r19_ix_b", "0000000000000002");
    expect(peekTreasuryAttemptLineageHealth().healthy).toBe(true);
    // 篡改 B 的 current 为 A 的 current（root/current 交叉——lineageId 派生
    // 不受影响，只能由跨索引完整性检出）。
    const entries = lineageStoreEntries();
    (entries["l:r19_ix_b"] as { currentTransactionId: string }).currentTransactionId = "r19_ix_a";
    resetTreasuryLineageRuntimeForTest();
    const health = peekTreasuryAttemptLineageHealth();
    expect(health.healthy).toBe(false);
    if (!health.healthy) expect(health.detail).toContain("current");
    // 原数据保留（两条 entry 都在——不自动删除）。
    expect(Object.keys(lineageStoreEntries()).length).toBe(2);
  });

  it("record 的 current 等于另一 record 的 root → load fail closed", () => {
    seedRecord("r19_cx_a", "0000000000000011");
    seedRecord("r19_cx_b", "0000000000000012");
    (lineageStoreEntries()["l:r19_cx_b"] as { currentTransactionId: string }).currentTransactionId = "r19_cx_a";
    resetTreasuryLineageRuntimeForTest();
    expect(peekTreasuryAttemptLineageHealth().healthy).toBe(false);
  });

  it("next-child 篡改形态（B 携带 A 派生的 next-child）→ load fail closed", () => {
    seedRecord("r19_nx_a", "0000000000000021");
    seedRecord("r19_nx_b", "0000000000000022");
    const entries = lineageStoreEntries();
    const lineageA = lookupTreasuryAttemptLineageByAttemptId("r19_nx_a")!;
    // A 的下一代理论 child ID（v2 派生）——塞给 B：B 的 (lineageId, root)
    // 派生/checksum 必然不一致（duplicate next-child 篡改形态），load 时由
    // nextChild 派生校验或跨索引完整性 fail closed。
    const nextChild = deriveTreasuryLineageNextChildTransactionId(lineageA.lineageId, 1, "r19_nx_a");
    (entries["l:r19_nx_b"] as { nextChildTransactionId?: string }).nextChildTransactionId = nextChild;
    resetTreasuryLineageRuntimeForTest();
    expect(peekTreasuryAttemptLineageHealth().healthy).toBe(false);
  });

  it("duplicate lineageId（篡改 B 为 A 的 lineageId）→ load fail closed、原数据保留", () => {
    seedRecord("r19_dup_a", "0000000000000031");
    seedRecord("r19_dup_b", "0000000000000032");
    const entries = lineageStoreEntries();
    (entries["l:r19_dup_b"] as { lineageId: string }).lineageId = (entries["l:r19_dup_a"] as { lineageId: string }).lineageId;
    resetTreasuryLineageRuntimeForTest();
    expect(peekTreasuryAttemptLineageHealth().healthy).toBe(false);
    expect(Object.keys(lineageStoreEntries()).length).toBe(2);
  });

  it("写入候选与既有 record 的 current 冲突：拒绝且原 store 与索引不变", () => {
    seedRecord("r19_wc_a", "0000000000000041");
    seedRecord("r19_wc_b", "0000000000000042");
    const lineageB = lookupTreasuryAttemptLineageByAttemptId("r19_wc_b")!;
    const result = updateTreasuryAttemptLineageRecord(lineageB.lineageId, (current) => ({
      ...current,
      currentTransactionId: "r19_wc_a",
      recordRevision: current.recordRevision + 1,
    }));
    expect(result.status).toBe("rejected");
    // 原 store 不变且仍 healthy（索引未受污染）。
    expect(lookupTreasuryAttemptLineageByAttemptId("r19_wc_b")?.currentTransactionId).toBe("r19_wc_b");
    expect(peekTreasuryAttemptLineageHealth().healthy).toBe(true);
  });
});
