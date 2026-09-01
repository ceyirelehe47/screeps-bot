/**
 * 【第十九轮】receipt health 与迁移兼容测试（任务 25.7/25.9）。
 *
 * 覆盖（工作包 F）：
 * - v6/v7 raw store（未 load）在轻量 health 阶段不再误报 unknown fatal
 *   （migration pending——版本认可与 loader 迁移能力一致）；
 * - resolution store v6 同步补齐（peek healthy）；
 * - 真正 load 执行现有原子迁移（临时结构验证 → 一次替换 → v8）；
 * - peek 零写（不触发迁移、不写 Memory）；
 * - tr1_ 旧 receipt 缺 lineage proof 迁移后仍为 replay blocker（legacy）。
 */
import {
  clearTreasuryPersistenceForTest,
  ensureTreasuryReceiptStore,
  lookupTreasurySettledReceipt,
  peekTreasuryReceiptHealth,
  readTreasurySettlementProof,
} from "@/runtime/treasury/receipts";
import { peekTreasuryResolutionStoreHealth, resetTreasuryResolutionStoreForTest } from "@/runtime/treasury/resolutionStore";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
});

describe("receipt health 迁移兼容（第十九轮 25.7）", () => {
  it("v6 raw store（未 load）：peek healthy（migration pending 不误报 unknown fatal）；load 原子迁移 v8", () => {
    Memory.runtime = Memory.runtime ?? {};
    (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury = {
      receipts: {
        version: 6,
        settled: {},
        updatedAt: Game.time,
        entryCount: 0,
        nextExpiryTick: null,
      },
    };
    expect(peekTreasuryReceiptHealth().healthy).toBe(true);
    // load → v6 经 v7 结构迁移至 v8。
    expect(ensureTreasuryReceiptStore().version).toBe(8);
    expect(peekTreasuryReceiptHealth().healthy).toBe(true);
  });

  it("v7 raw store（未 load）：peek healthy；load 原子迁移 v8", () => {
    Memory.runtime = Memory.runtime ?? {};
    (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury = {
      receipts: {
        version: 7,
        settled: {
          "t:r19_v7_tx": {
            level: "identity-bound",
            settledAtTick: Game.time,
            digest: "1111111111111111",
            durableIdentityDigest: "2222222222222222",
            contractDigest: "3333333333333333",
            authorizationCohortDigest: "4444444444444444",
          },
        },
        updatedAt: Game.time,
        entryCount: 1,
        nextExpiryTick: Game.time + 5_001,
      },
    };
    expect(peekTreasuryReceiptHealth().healthy).toBe(true);
    expect(ensureTreasuryReceiptStore().version).toBe(8);
    expect(lookupTreasurySettledReceipt("r19_v7_tx").status).toBe("modern_committed");
  });

  it("v8 当前版本：peek healthy（回归）", () => {
    ensureTreasuryReceiptStore();
    expect(peekTreasuryReceiptHealth().healthy).toBe(true);
  });

  it("未知版本（99）：peek fail closed（未知版本 ≠ 可迁移版本）", () => {
    Memory.runtime = Memory.runtime ?? {};
    (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury = {
      receipts: { version: 99, settled: {}, updatedAt: Game.time, entryCount: 0, nextExpiryTick: null },
    };
    expect(peekTreasuryReceiptHealth().healthy).toBe(false);
  });

  it("peek 零写：v6 store peek 后 Memory 原样（版本仍 6——迁移只在 load 发生）", () => {
    Memory.runtime = Memory.runtime ?? {};
    (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury = {
      receipts: { version: 6, settled: {}, updatedAt: Game.time, entryCount: 0, nextExpiryTick: null },
    };
    expect(peekTreasuryReceiptHealth().healthy).toBe(true);
    const raw = (Memory.runtime as unknown as { treasury?: { receipts?: { version?: number } } }).treasury?.receipts?.version;
    expect(raw).toBe(6);
  });

  it("tr1_ 旧 receipt 缺 lineage proof：迁移后 lookup 降级 legacy（replay blocker 语义保留）", () => {
    Memory.runtime = Memory.runtime ?? {};
    (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury = {
      receipts: {
        version: 7,
        settled: {
          "t:tr1_0123456789abcdef_000001_00112233": {
            level: "identity-bound",
            settledAtTick: Game.time,
            digest: "1111111111111111",
            durableIdentityDigest: "2222222222222222",
            contractDigest: "3333333333333333",
            authorizationCohortDigest: "4444444444444444",
          },
        },
        updatedAt: Game.time,
        entryCount: 1,
        nextExpiryTick: Game.time + 5_001,
      },
    };
    expect(ensureTreasuryReceiptStore().version).toBe(8);
    const childId = "tr1_0123456789abcdef_000001_00112233";
    expect(lookupTreasurySettledReceipt(childId).status).toBe("legacy_committed");
    expect(readTreasurySettlementProof(childId)?.level).toBe("legacy");
  });

  it("resolution store v6（第十八轮迁移分支）：peek healthy（migration pending）", () => {
    Memory.runtime = Memory.runtime ?? {};
    (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury = {
      resolutions: { version: 6, entries: {}, entryCount: 0, updatedAt: Game.time },
    };
    resetTreasuryResolutionStoreForTest();
    const health = peekTreasuryResolutionStoreHealth();
    expect(health.healthy).toBe(true);
  });

  it("resolution store 未知版本（99）：peek fail closed（回归）", () => {
    Memory.runtime = Memory.runtime ?? {};
    (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury = {
      resolutions: { version: 99, entries: {}, entryCount: 0, updatedAt: Game.time },
    };
    resetTreasuryResolutionStoreForTest();
    expect(peekTreasuryResolutionStoreHealth().healthy).toBe(false);
  });
});
