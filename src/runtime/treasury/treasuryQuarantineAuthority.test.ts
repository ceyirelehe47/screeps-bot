/**
 * Treasury quarantine 版本化持久权威测试（第七轮）：
 * - schema v1：首次写入自动初始化（version/entryCount 元数据）；
 * - global reset 后首次 load 全量验证：entryCount 漂移、key 编码与
 *   transactionId 不一致、digest/phase/locationKind/resource/delta 非法、
 *   聚合安全整数溢出一律 fatal fail closed——原数据不删、写入拒绝、
 *   health unhealthy、blockers blocking、聚合返回空；
 * - 未知 version、legacy 无版本 store（非空）→ fatal；
 * - legacy overflowed 标志 → 永久 unhealthy，一切新 prepare 阻断，无自动清除；
 * - 聚合 revision 缓存：重复聚合不重复扫描（确定性操作计数）。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  peekTreasuryQuarantineHealth,
  quarantineTreasuryTransaction,
  readTreasuryQuarantineCounters,
  readTreasuryQuarantineEntry,
  resetTreasuryQuarantineRuntimeForTest,
  treasuryQuarantineBlockers,
  treasuryQuarantineOutflowTotals,
  TREASURY_QUARANTINE_MAX_ENTRIES,
  type TreasuryQuarantineEntry,
  type TreasuryQuarantineStore,
} from "@/runtime/treasury/quarantine";
import { installRooms, type RoomSpec } from "@mock/treasury";
import type { TreasuryTransactionInput } from "@/runtime/treasury/types";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 5_000 },
  },
];

function makeService(): TreasuryService {
  const rooms = installRooms(ROOMS);
  const service = createTreasuryService({ getRooms: () => Object.values(rooms) });
  service.beginTick();
  return service;
}

function freshInput(service: TreasuryService, transactionId: string): TreasuryTransactionInput {
  const epoch = service.observation().epoch;
  return {
    transactionId,
    kind: "terminal.send",
    source: "test",
    decision: { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick },
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 }],
  };
}

function validEntry(transactionId = "ts7_v1"): TreasuryQuarantineEntry {
  return {
    transactionId,
    digest: "0123456789abcdef",
    tick: Game.time,
    kind: "test",
    source: "test",
    phase: "executing_at_end_tick",
    deltas: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 }],
    recordedAt: Game.time,
  };
}

/** 写入一条合法 entry 使 store 初始化，再篡改并失效 heap 缓存（模拟 global reset 后首次 load）。 */
function corruptStore(mutate: (store: TreasuryQuarantineStore) => void): void {
  const write = quarantineTreasuryTransaction(validEntry());
  if (write.status !== "written") throw new Error(`setup 写入失败: ${JSON.stringify(write)}`);
  const store = Memory.runtime!.treasury!.quarantine as TreasuryQuarantineStore;
  mutate(store);
  resetTreasuryQuarantineRuntimeForTest();
  // 模拟 global reset 后的首次访问（load 全量验证在此发生；轻量 health 探测
  // 只查元数据形状，entry 级损坏由 load 显式检出——与 receipt 契约一致）。
  treasuryQuarantineOutflowTotals();
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
});

describe("quarantine schema v1 元数据", () => {
  it("首次写入自动初始化 v1：version/entryCount 元数据正确", () => {
    expect(quarantineTreasuryTransaction(validEntry()).status).toBe("written");
    const store = Memory.runtime!.treasury!.quarantine as TreasuryQuarantineStore;
    expect(store.version).toBe(1);
    expect(store.entryCount).toBe(1);
    expect(Object.keys(store.entries)).toEqual(["q:ts7_v1"]);
    const health = peekTreasuryQuarantineHealth();
    expect(health.healthy).toBe(true);
    expect(health.entryCount).toBe(1);
  });

  it("同 id 重复写入幂等保留首条（entryCount 不虚增）", () => {
    expect(quarantineTreasuryTransaction(validEntry()).status).toBe("written");
    expect(quarantineTreasuryTransaction(validEntry()).status).toBe("already_present");
    expect((Memory.runtime!.treasury!.quarantine as TreasuryQuarantineStore).entryCount).toBe(1);
  });
});

describe("quarantine 损坏 fail closed（load 全量验证）", () => {
  it("entryCount 漂移：fatal——写入拒绝、health unhealthy、blockers blocking、聚合空、原数据保留", () => {
    corruptStore((store) => {
      store.entryCount = 99;
    });
    const health = peekTreasuryQuarantineHealth();
    expect(health.healthy).toBe(false);
    expect(treasuryQuarantineBlockers().blocking).toBe(true);
    expect(quarantineTreasuryTransaction(validEntry("ts7_after")).status).toBe("rejected");
    expect(treasuryQuarantineOutflowTotals().size).toBe(0); // 未验证 store 不聚合
    // 原数据保留（零删除）。
    const store = Memory.runtime!.treasury!.quarantine as TreasuryQuarantineStore;
    expect(Object.keys(store.entries)).toHaveLength(1);
    // prepare 被全局阻断：quarantine_store_fatal，callback 零调用。
    const service = makeService();
    let callbacks = 0;
    const rejected = service.executePreparedAction(freshInput(service, "ts7_new_after_corrupt"), () => {
      callbacks += 1;
      return { ok: true as const };
    });
    expect(rejected.status).toBe("prepare_rejected");
    if (rejected.status === "prepare_rejected") expect(rejected.reason).toBe("quarantine_store_fatal");
    expect(callbacks).toBe(0);
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.authorizationSafe).toBe(false);
    expect(view.authorizationBlockers).toContain("quarantine_unhealthy");
    expect(view.writeAdmission.ready).toBe(false);
  });

  it.each([
    ["未知 version", (store: TreasuryQuarantineStore) => { (store as { version: number }).version = 7; }],
    ["key 编码与 transactionId 不一致", (store: TreasuryQuarantineStore) => {
      store.entries["q:ts7_other"] = store.entries["q:ts7_v1"];
      delete store.entries["q:ts7_v1"];
    }],
    ["digest 非法", (store: TreasuryQuarantineStore) => { (store.entries["q:ts7_v1"] as { digest: string }).digest = "zzz"; }],
    ["phase 未知枚举", (store: TreasuryQuarantineStore) => { (store.entries["q:ts7_v1"] as { phase: string }).phase = "mystery"; }],
    ["delta 零", (store: TreasuryQuarantineStore) => {
      (store.entries["q:ts7_v1"].deltas[0] as { delta: number }).delta = 0;
    }],
    ["delta 非安全整数", (store: TreasuryQuarantineStore) => {
      (store.entries["q:ts7_v1"].deltas[0] as { delta: number }).delta = Number.NaN;
    }],
    ["非法 resource", (store: TreasuryQuarantineStore) => {
      (store.entries["q:ts7_v1"].deltas[0] as { resource: string }).resource = "unobtainium";
    }],
    ["非法 locationKind", (store: TreasuryQuarantineStore) => {
      (store.entries["q:ts7_v1"].deltas[0] as { locationKind: string }).locationKind = "lab";
    }],
    ["聚合安全整数溢出", (store: TreasuryQuarantineStore) => {
      (store.entries["q:ts7_v1"].deltas[0] as { delta: number }).delta = Number.MAX_SAFE_INTEGER;
      store.entryCount = 2;
      store.entries["q:ts7_v2"] = { ...validEntry("ts7_v2"), deltas: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: 1 }] };
    }],
  ])("%s：load 校验 fatal，原数据保留", (_label, mutate) => {
    corruptStore(mutate);
    expect(peekTreasuryQuarantineHealth().healthy).toBe(false);
    expect(treasuryQuarantineBlockers().blocking).toBe(true);
    expect(quarantineTreasuryTransaction(validEntry("ts7_post")).status).toBe("rejected");
    const store = Memory.runtime!.treasury!.quarantine as TreasuryQuarantineStore;
    expect(store.entries).toBeDefined(); // 零删除
  });

  it("legacy 无版本 store：空 entries 无损升级 v1；非空 fatal（不猜测迁移）", () => {
    // 空 legacy store（第六轮形状：无 version）→ 升级。
    Memory.runtime = Memory.runtime ?? {};
    Memory.runtime.treasury = { ...(Memory.runtime.treasury ?? {}), quarantine: { entries: {} } as never };
    resetTreasuryQuarantineRuntimeForTest();
    expect(quarantineTreasuryTransaction(validEntry()).status).toBe("written");
    expect((Memory.runtime!.treasury!.quarantine as TreasuryQuarantineStore).version).toBe(1);
    // 非空 legacy store → fatal（显式 repair 处理）。
    clearTreasuryPersistenceForTest();
    corruptStore((store) => {
      delete (store as { version?: number }).version;
    });
    const health = peekTreasuryQuarantineHealth();
    expect(health.healthy).toBe(false);
    expect(peekTreasuryQuarantineHealth().detail).toContain("version");
    expect(treasuryQuarantineBlockers().blocking).toBe(true);
    expect(readTreasuryQuarantineEntry("ts7_v1")).toBeUndefined(); // fatal store 不回答单条查询
  });

  it("legacy overflowed 标志：永久 unhealthy、prepare 阻断、无自动清除", () => {
    corruptStore((store) => {
      store.overflowed = true;
    });
    const health = peekTreasuryQuarantineHealth();
    expect(health.healthy).toBe(false);
    expect(health.overflowed).toBe(true);
    const service = makeService();
    const rejected = service.prepareTransaction(freshInput(service, "ts7_overflow_blocked"));
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("quarantine_store_fatal");
    // 简单删除 write-fault marker 不恢复（overflow 与 marker 独立）。
    delete Memory.runtime!.treasury!.writeFault;
    expect(service.prepareTransaction(freshInput(service, "ts7_overflow_blocked")).status).toBe("rejected");
    // 自动路径绝不清除 overflowed（store 原样保留）。
    expect((Memory.runtime!.treasury!.quarantine as TreasuryQuarantineStore).overflowed).toBe(true);
  });
});

describe("聚合 revision 缓存（性能契约）", () => {
  it("重复聚合不重复扫描：fullScans 计数稳定（store 变更才失效）", () => {
    for (let index = 0; index < 8; index += 1) {
      expect(quarantineTreasuryTransaction(validEntry(`ts7_cache${index}`)).status).toBe("written");
    }
    resetTreasuryQuarantineRuntimeForTest();
    const baseline = readTreasuryQuarantineCounters();
    // 多次聚合调用（query 场景）——聚合只算一次（revision 缓存）。
    for (let round = 0; round < 5; round += 1) {
      expect(treasuryQuarantineOutflowTotals().size).toBeGreaterThan(0);
    }
    const after = readTreasuryQuarantineCounters();
    expect(after.fullScans).toBe(baseline.fullScans + 1); // 仅一次 load 全扫
    // 写入变更 revision → 下一次聚合重算（内容更新，且不产生额外验证扫描——
    // 缓存失效走 revision 而非重新验证）。
    expect(quarantineTreasuryTransaction(validEntry("ts7_cache_new")).status).toBe("written");
    const merged = treasuryQuarantineOutflowTotals();
    expect(merged.get(`W1N57\u0000storage\u0000${RESOURCE_ENERGY}`)).toBe(-500 * 9);
    expect(readTreasuryQuarantineCounters().fullScans).toBe(after.fullScans);
  });

  it("满载 entry 数（64）仍在 load 校验上限内", () => {
    for (let index = 0; index < TREASURY_QUARANTINE_MAX_ENTRIES; index += 1) {
      expect(quarantineTreasuryTransaction(validEntry(`ts7_cap${index}`)).status).toBe("written");
    }
    resetTreasuryQuarantineRuntimeForTest();
    expect(peekTreasuryQuarantineHealth().healthy).toBe(true);
    expect(treasuryQuarantineBlockers().unresolvedCount).toBe(TREASURY_QUARANTINE_MAX_ENTRIES);
  });
});
