/**
 * Treasury write-admission 确定性性能 fixture（第五轮，操作次数断言而非源码字符串）：
 * - 64 笔并行 prepare（多房间/多资源/多位置）：tentative 授权 O(1) 查表、
 *   receipt admission 快路径零全表扫描（receiptFullScans 恒定）；
 * - abort/commit 后 tentative 索引彻底清理（key 数归零）；
 * - 4096 receipt 满表下 prepare admission 仍走 O(1) 快路径；
 * - commitment 大量合法 + 少量损坏：构建一次扫描、损坏计数准确；
 * - 重复 query 不重复全表扫描（receipt 扫描计数恒定、commitment 索引复用）。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import {
  clearTreasuryPersistenceForTest,
  encodeReceiptKey,
  TREASURY_RECEIPT_MAX_ENTRIES,
  TREASURY_RECEIPT_RETENTION_TICKS,
} from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { compatRecordAcceptedTransaction } from "@/runtime/treasury/compat";
import {
  quarantineTreasuryTransaction,
  readTreasuryQuarantineCounters,
  resetTreasuryQuarantineRuntimeForTest,
  treasuryQuarantineOutflowTotals,
} from "@/runtime/treasury/quarantine";
import { readTreasuryIntentCounters } from "@/runtime/treasury/intents";
import {
  buildTreasuryActionContract,
  executeTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  readTreasuryActionContractCounters,
  registerTreasuryActionAdapter,
  findTreasuryActionAdapter,
  readTreasuryAdapterRegistryRevision,
  unregisterTreasuryActionAdapterForTest,
} from "@/runtime/treasury/actionContracts";
import { bumpTreasuryCommitmentRevision } from "@/runtime/treasury/commitmentRevision";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import { installRooms, type RoomSpec } from "@mock/treasury";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";

const RESOURCES: ResourceConstant[] = [RESOURCE_ENERGY, "U", "K", "L", "Z", "O", "H", "X"];
const ROOM_NAMES = ["W1N57", "E5N59", "W2N57", "E2N59", "W3N57", "E3N59", "W4N57", "E4N59"];

/** 8 房间 × storage+terminal × 8 资源：每个 (room,location,resource) 桶 200k。 */
function buildRoomSpecs(): RoomSpec[] {
  return ROOM_NAMES.map((name) => ({
    name,
    storage: {
      id: `stor-${name}`,
      resources: Object.fromEntries(RESOURCES.map((r) => [r, 200_000])) as Record<string, number>,
      freeCapacity: 500_000,
    },
    terminal: {
      id: `term-${name}`,
      resources: Object.fromEntries(RESOURCES.map((r) => [r, 50_000])) as Record<string, number>,
      freeCapacity: 100_000,
    },
  }));
}

function makeService(roomSpecs: RoomSpec[] = buildRoomSpecs(), tasks?: Record<string, ResourceTransferTask>): TreasuryTestService {
  const rooms = installRooms(roomSpecs);
  return treasuryTestService(createTreasuryService({
    getRooms: () => Object.values(rooms),
    ...(tasks !== undefined ? { getTasks: () => tasks } : {}),
  }));
}

function prepareInput(service: TreasuryTestService, transactionId: string, delta: number, resource: ResourceConstant, roomName: string, locationKind: "storage" | "terminal" = "storage") {
  const epoch = service.observation().epoch;
  return {
    transactionId,
    kind: "terminal.send",
    source: "perf",
    decision: { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick },
    postings: [{ roomName, locationKind, resource, delta }],
  };
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
});

describe("write-admission 确定性性能 fixture", () => {
  it("64 笔并行 prepare：tentative 授权零全表扫描、receipt 快路径恒定", () => {
    const service = makeService();
    service.beginTick();
    const scansBefore = service.metrics().receiptFullScans;
    const handles = [];
    for (let index = 0; index < 64; index += 1) {
      const roomName = ROOM_NAMES[index % ROOM_NAMES.length];
      const resource = RESOURCES[Math.floor(index / ROOM_NAMES.length) % RESOURCES.length];
      const locationKind: "storage" | "terminal" = Math.floor(index / 8) % 2 === 0 ? "storage" : "terminal";
      const prepared = service.prepareTransaction(prepareInput(service, `ts1_p${index}`, -1_000, resource, roomName, locationKind));
      expect(prepared.status).toBe("prepared");
      if (prepared.status === "prepared") handles.push(prepared.handle);
    }
    expect(handles).toHaveLength(64);
    const metrics = service.metrics();
    // admission 全部走 O(1) 快路径：全表扫描计数不增长。
    expect(metrics.receiptFullScans).toBe(scansBefore);
    expect(metrics.receiptAdmissionFastPaths).toBeGreaterThanOrEqual(64);
    // tentative 索引覆盖 64 个资源 key 与 16 个位置容量 key。
    expect(metrics.tentativeResourceKeys).toBe(64);
    expect(metrics.tentativeCapacityKeys).toBe(16);
    expect(metrics.preparedActive).toBe(64);
    expect(metrics.receiptSlotsRemaining).toBe(TREASURY_RECEIPT_MAX_ENTRIES - 64);
  });

  it("多房间多资源 tentative 感知授权：同桶超量拒绝 O(1) 命中", () => {
    const service = makeService();
    service.beginTick();
    // 预留 8 个不同桶各 -199_000（200k 桶）。
    for (let index = 0; index < 8; index += 1) {
      const prepared = service.prepareTransaction(
        prepareInput(service, `ts1_hold${index}`, -199_000, RESOURCES[index], ROOM_NAMES[index]),
      );
      expect(prepared.status).toBe("prepared");
    }
    // 每个已预留桶再 prepare -2_000 拒绝（余额恰 1_000）；未触及桶不受影响。
    for (let index = 0; index < 8; index += 1) {
      const rejected = service.prepareTransaction(
        prepareInput(service, `ts1_over${index}`, -2_000, RESOURCES[index], ROOM_NAMES[index]),
      );
      expect(rejected.status).toBe("rejected");
    }
    const fresh = service.prepareTransaction(
      prepareInput(service, "ts1_fresh", -2_000, RESOURCES[0], ROOM_NAMES[1]),
    );
    expect(fresh.status).toBe("prepared");
  });

  it("abort/commit 后 tentative 索引彻底清理", () => {
    const service = makeService();
    service.beginTick();
    const handles: Array<{ handle: unknown; commit: boolean }> = [];
    for (let index = 0; index < 32; index += 1) {
      const prepared = service.prepareTransaction(
        prepareInput(service, `ts1_c${index}`, -1_000, RESOURCES[index % RESOURCES.length], ROOM_NAMES[index % ROOM_NAMES.length]),
      );
      if (prepared.status === "prepared") handles.push({ handle: prepared.handle, commit: index % 2 === 0 });
    }
    for (const { handle, commit } of handles) {
      if (commit) expect(service.commitPreparedTransaction(handle as never).status).toBe("committed");
      else expect(service.abortPreparedTransaction(handle as never).status).toBe("aborted");
    }
    const metrics = service.metrics();
    expect(metrics.preparedActive).toBe(0);
    expect(metrics.tentativeResourceKeys).toBe(0);
    expect(metrics.tentativeCapacityKeys).toBe(0);
    expect(metrics.preparedCommits).toBe(16);
    expect(metrics.transactionPreparesAborted).toBe(16);
  });

  it("4096 receipt 满表下 prepare admission 仍为 O(1) 快路径（未到过期点零扫描）", () => {
    const settled: Record<string, number> = {};
    for (let index = 0; index < TREASURY_RECEIPT_MAX_ENTRIES - 1; index += 1) {
      settled[encodeReceiptKey(`seed:${index}`)] = Game.time;
    }
    Memory.runtime = Memory.runtime ?? {};
    Memory.runtime.treasury = {
      receipts: {
        version: 3 as unknown as 6,
        settled,
        updatedAt: Game.time,
        entryCount: TREASURY_RECEIPT_MAX_ENTRIES - 1,
        nextExpiryTick: Game.time + TREASURY_RECEIPT_RETENTION_TICKS + 1,
      },
    };
    const service = makeService();
    service.beginTick();
    const scansBefore = service.metrics().receiptFullScans;
    // 最后一个槽位：prepare 占用（O(1) 判定）。
    const prepared = service.prepareTransaction(prepareInput(service, "ts1_last_slot", -1_000, RESOURCE_ENERGY, "W1N57"));
    expect(prepared.status).toBe("prepared");
    expect(service.metrics().receiptFullScans).toBe(scansBefore);
    // store 满载后新 prepare：O(1) 拒绝（admissionFullStoreBlocked），零扫描。
    const blocked = service.prepareTransaction(prepareInput(service, "ts1_blocked", -1_000, RESOURCE_ENERGY, "E5N59"));
    expect(blocked.status).toBe("rejected");
    if (blocked.status === "rejected") expect(blocked.reason).toBe("receipt_capacity_exhausted");
    expect(service.metrics().receiptFullScans).toBe(scansBefore);
    expect(service.metrics().receiptAdmissionFullStoreBlocked).toBeGreaterThanOrEqual(1);
  });

  it("commitment 大量合法 + 少量损坏：一次构建、损坏计数准确、completeness 生效", () => {
    const tasks: Record<string, ResourceTransferTask> = {};
    for (let index = 0; index < 512; index += 1) {
      tasks[`ok-${index}`] = {
        id: `ok-${index}`,
        resource: RESOURCE_ENERGY,
        fromRoomName: ROOM_NAMES[index % ROOM_NAMES.length],
        toRoomName: ROOM_NAMES[(index + 1) % ROOM_NAMES.length],
        amount: 1_000_000,
        remainingAmount: 1_000,
        status: "pending",
        createdAt: 1,
        updatedAt: 1,
        origin: "manual",
        lastProgressAt: 1,
      } as ResourceTransferTask;
    }
    // 少量损坏：NaN amount / remaining > amount / 非法资源。
    tasks["bad-1"] = { ...tasks["ok-0"], id: "bad-1", amount: Number.NaN } as ResourceTransferTask;
    tasks["bad-2"] = { ...tasks["ok-0"], id: "bad-2", remainingAmount: 2_000, amount: 1_000 } as ResourceTransferTask;
    tasks["bad-3"] = { ...tasks["ok-0"], id: "bad-3", resource: "not-a-resource" as never } as ResourceTransferTask;

    const service = makeService(buildRoomSpecs(), tasks);
    service.beginTick();
    const commitments = service.commitments();
    expect(commitments.completeness.invalidRecords).toBe(3);
    expect(commitments.completeness.complete).toBe(false);
    const metrics = service.metrics();
    expect(metrics.invalidCommitmentRecords).toBe(3);
    // bad-3 资源非法 → 无法定位 → 全局 incomplete；其余损坏 scope 定位。
    expect(metrics.commitmentGloballyIncomplete).toBe(true);
  });

  it("重复 query 不重复全表扫描（receipt 扫描恒定、commitment 索引复用）", () => {
    const service = makeService();
    service.beginTick();
    // 造几笔已结算与承诺。
    compatRecordAcceptedTransaction(service, prepareInput(service, "ts1_q0", -1_000, RESOURCE_ENERGY, "W1N57"));
    // 预热：首次 query 构建承诺索引（一次性），其后同 revision 复用。
    service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    const scansBefore = service.metrics().receiptFullScans;
    const rebuildsBefore = service.metrics().commitmentRebuilds;
    for (let round = 0; round < 16; round += 1) {
      const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
      expect(view.authorizationSafe).toBe(true);
    }
    const after = service.metrics();
    // 16 次查询：receipt 零扫描、commitment 索引零重建（同 revision 复用）。
    expect(after.receiptFullScans).toBe(scansBefore);
    expect(after.commitmentRebuilds).toBe(rebuildsBefore);
    expect(after.commitmentIndexQueries).toBeGreaterThanOrEqual(16 * 3);
  });
});

describe("第七轮：quarantine blocker 与 fault-slot admission 的确定性性能 fixture", () => {
  /** 注入 N 条持久 quarantine（合法形状）并预热 load/聚合缓存。 */
  function seedQuarantine(count: number): void {
    for (let index = 0; index < count; index += 1) {
      const write = quarantineTreasuryTransaction({
        transactionId: `ts7_perf${index}`,
        digest: "0123456789abcdef",
        tick: Game.time,
        kind: "perf",
        source: "perf",
        phase: "executing_at_end_tick",
        outcome: "started_unknown",
        settlement: "quarantined",
        deltas: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1 }],
        recordedAt: Game.time,
      });
      if (write.status !== "written") throw new Error(`seed 失败: ${JSON.stringify(write)}`);
    }
  }

  it("quarantine blocker 检查 O(1)：unresolved 条数不放大 prepare 拒绝路径的扫描数", () => {
    const scenarios = [1, 32, 63];
    const scanCounts: number[] = [];
    for (const count of scenarios) {
      clearTreasuryPersistenceForTest();
      resetTreasuryCommitmentRevisionForTest();
      seedQuarantine(count);
      resetTreasuryQuarantineRuntimeForTest(); // 模拟 global reset：预热一次 load（验证扫描）
      treasuryQuarantineOutflowTotals();
      const service = makeService();
      service.beginTick();
      const scansAfterLoad = readTreasuryQuarantineCounters().fullScans;
      const rejected = service.prepareTransaction(prepareInput(service, `ts7_blocked_${count}`, -1_000, RESOURCE_ENERGY, "W1N57"));
      expect(rejected.status).toBe("rejected");
      if (rejected.status === "rejected") expect(rejected.reason).toBe("quarantine_write_blocked");
      // 拒绝路径的 blocker 检查零额外扫描（health cache + entryCount O(1)）。
      expect(readTreasuryQuarantineCounters().fullScans).toBe(scansAfterLoad);
      scanCounts.push(readTreasuryQuarantineCounters().fullScans - scansAfterLoad);
    }
    expect(scanCounts).toEqual([0, 0, 0]);
  });

  it("quarantine slot admission O(1)：active 数不放大第 64/65 个 prepare 的检查", () => {
    const service = makeService();
    service.beginTick();
    for (let index = 0; index < 63; index += 1) {
      expect(service.prepareTransaction(prepareInput(service, `ts7_slot_perf${index}`, -1_000, RESOURCE_ENERGY, ROOM_NAMES[index % 8])).status).toBe("prepared");
    }
    const scansAfterWarm = readTreasuryQuarantineCounters().fullScans;
    // 第 64 个：0 持久 + 63 active < 64 → 通过（slot admission O(1)，零扫描）。
    const prepared = service.prepareTransaction(prepareInput(service, "ts7_slot_last", -1_000, RESOURCE_ENERGY, "W1N57"));
    expect(prepared.status).toBe("prepared");
    expect(readTreasuryQuarantineCounters().fullScans).toBe(scansAfterWarm);
    // 第 65 个：0 持久 + 64 active = MAX → 拒绝（O(1)，零扫描）。
    const rejected = service.prepareTransaction(prepareInput(service, "ts7_slot_over", -1_000, RESOURCE_ENERGY, "W1N57"));
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("quarantine_capacity_exhausted");
    expect(readTreasuryQuarantineCounters().fullScans).toBe(scansAfterWarm);
  });

  it("query 的 quarantine 聚合 revision 缓存：unresolved 条数不放大重复查询", () => {
    seedQuarantine(16);
    resetTreasuryQuarantineRuntimeForTest();
    const service = makeService();
    service.beginTick();
    // 预热（首次 load + 聚合一次）。
    const warm = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(warm.committed).toBe(16); // 16 条 -1 流出占用
    const scansAfterWarm = readTreasuryQuarantineCounters().fullScans;
    for (let round = 0; round < 8; round += 1) {
      const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
      expect(view.committed).toBe(16);
      expect(view.writeAdmission.ready).toBe(false);
    }
    // 8 次查询：聚合 revision 缓存命中，零额外全扫。
    expect(readTreasuryQuarantineCounters().fullScans).toBe(scansAfterWarm);
  });

  it("第八轮：intent admission O(1)——64 笔 prepare/execute 不产生 intent store 全表扫描", () => {
    const service = makeService();
    service.beginTick();
    for (let index = 0; index < 32; index += 1) {
      const result = service.executePreparedAction(prepareInput(service, `perf_intent${index}`, -1_000, RESOURCE_ENERGY, "W1N57"), () => ({ ok: true }));
      expect(result.status).toBe("executed_committed");
    }
    const baseline = readTreasuryIntentCounters();
    expect(baseline.fullScans).toBe(0); // 全程 O(1) admission（无 load 全扫）
    // 再 32 笔 low-level prepare（未执行路径）——仍零扫描。
    for (let index = 0; index < 32; index += 1) {
      expect(service.prepareTransaction(prepareInput(service, `perf_prepare${index}`, -1_000, RESOURCE_ENERGY, "W1N57")).status).toBe("prepared");
    }
    expect(readTreasuryIntentCounters().fullScans).toBe(0);
  });

  it("第八轮：authorize 不全扫 reservation/quarantine/intent——revision 未变时多次授权零索引重建", () => {
    const service = makeService();
    service.beginTick();
    service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] }); // 预热（首次构建）
    const rebuildsBefore = service.metrics().commitmentRebuilds;
    for (let index = 0; index < 16; index += 1) {
      const issued = service.authorizeResourceUse({
        transactionId: `perf_auth${index}`,
        actionKind: "test",
        resource: RESOURCE_ENERGY,
        rooms: ["W1N57"],
        locations: ["storage"],
        amount: 100,
      });
      expect(issued.status).toBe("authorized");
      if (issued.status === "authorized") {
        expect(service.consumeTreasuryAuthorization(issued.token, { transactionId: `perf_auth${index}` }).status).toBe("ok");
      }
    }
    // revision 未变：授权/消费全程复用承诺索引与 ledger，零重建、零全扫。
    expect(service.metrics().commitmentRebuilds).toBe(rebuildsBefore);
    expect(readTreasuryIntentCounters().fullScans).toBe(0);
    expect(readTreasuryQuarantineCounters().fullScans).toBe(0);
  });

  it("第八轮：token 消费校验 O(1)+postings 线性——32 腿 postings 消费不产生任何全扫", () => {
    const service = makeService();
    service.beginTick();
    const postings = Array.from({ length: 32 }, (_, index) => ({
      roomName: "W1N57",
      locationKind: "storage" as const,
      resource: RESOURCE_ENERGY,
      delta: index === 0 ? -32_000 : -0 + 1, // 净额非零：1 条流入 + 1 条大流出
    }));
    // 修正为合法形状：1 条 -32000 流出 + 31 条 +1000 流入（净 -1000）。
    postings.splice(0, postings.length,
      { roomName: "W1N57", locationKind: "storage" as const, resource: RESOURCE_ENERGY, delta: -32_000 });
    for (let index = 0; index < 31; index += 1) {
      postings.push({ roomName: "W1N57", locationKind: "storage" as const, resource: RESOURCE_ENERGY, delta: 1_000 });
    }
    const issued = service.authorizeResourceUse({
      transactionId: "perf_token",
      actionKind: "test",
      resource: RESOURCE_ENERGY,
      rooms: ["W1N57"],
      locations: ["storage"],
      amount: 32_000,
    });
    expect(issued.status).toBe("authorized");
    if (issued.status === "authorized") {
      const consumed = service.consumeTreasuryAuthorization(issued.token, {
        transactionId: "perf_token",
        postings,
      });
      expect(consumed.status).toBe("ok"); // 流出 32000 ≤ amount
    }
    expect(readTreasuryIntentCounters().fullScans).toBe(0);
    expect(readTreasuryQuarantineCounters().fullScans).toBe(0);
    void bumpTreasuryCommitmentRevision; // import 引用（无操作）
  });
});

  it("第九轮：bundle 预验证与 token/posting 数线性——多资源执行不产生任何全表扫描", () => {
    const rooms = installRooms(buildRoomSpecs());
    const service = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
    service.beginTick();
    registerTreasuryActionAdapter(makeTreasuryTestTransferAdapter());
    // 单资源 bundle（1 token、2 postings）与多资源 bundle（2 token、3
    // postings）各执行 8 次：预验证复杂度与 token/posting 数线性，零全扫。
    for (let index = 0; index < 3; index += 1) {
      const built = buildTreasuryActionContract(service, {
        actionKind: "test.transfer",
        transactionId: `perf_bundle_single${String(index)}`,
        args: {
          fromRoom: "W1N57",
          fromLocation: "storage",
          toRoom: "W1N57",
          toLocation: "terminal",
          resource: RESOURCE_ENERGY,
          amount: 100,
          outcome: "ok",
        },
      });
      expect(built.status).toBe("built");
      if (built.status !== "built") return;
      const authorized = service.authorizeTreasuryActionContract(built.contract);
      expect(authorized.status).toBe("authorized");
      if (authorized.status !== "authorized") return;
      expect(executeTreasuryActionContract(service, { contract: built.contract, authorization: authorized.bundle }).status).toBe("executed_committed");
    }
    for (let index = 0; index < 3; index += 1) {
      const built = buildTreasuryActionContract(service, {
        actionKind: "test.transfer",
        transactionId: `perf_bundle_multi${String(index)}`,
        args: {
          fromRoom: "W1N57",
          fromLocation: "storage",
          toRoom: "W1N57",
          toLocation: "terminal",
          resource: "U",
          amount: 100,
          feeFromRoom: "W1N57",
          feeAmount: 10,
          outcome: "ok",
        },
      });
      expect(built.status).toBe("built");
      if (built.status !== "built") return;
      const authorized = service.authorizeTreasuryActionContract(built.contract);
      expect(authorized.status).toBe("authorized");
      if (authorized.status !== "authorized") return;
      expect(executeTreasuryActionContract(service, { contract: built.contract, authorization: authorized.bundle }).status).toBe("executed_committed");
    }
    expect(readTreasuryIntentCounters().fullScans).toBe(0);
    expect(readTreasuryQuarantineCounters().fullScans).toBe(0);
    expect(readTreasuryActionContractCounters().built).toBe(6);
    unregisterTreasuryActionAdapterForTest("test.transfer");
  });

  it("第九轮：contract-first 授权在大量既有 receipt 下零扫描（派生授权 O(tokens)）", () => {
    const service = makeService();
    service.beginTick();
    // 预置 512 条 receipt（历史结算规模）。
    const { commitSettledReceipt } = jest.requireActual("@/runtime/treasury/receipts") as typeof import("@/runtime/treasury/receipts");
    for (let index = 0; index < 512; index += 1) {
      expect(commitSettledReceipt(`perf_hist${String(index)}`, Game.time).status).toBe("written");
    }
    registerTreasuryActionAdapter(makeTreasuryTestTransferAdapter());
    const scansBefore = readTreasuryIntentCounters().fullScans + readTreasuryQuarantineCounters().fullScans;
    for (let index = 0; index < 16; index += 1) {
      const built = buildTreasuryActionContract(service, {
        actionKind: "test.transfer",
        transactionId: `perf_cf_auth${String(index)}`,
        args: {
          fromRoom: "W1N57",
          fromLocation: "storage",
          toRoom: "W1N57",
          toLocation: "terminal",
          resource: RESOURCE_ENERGY,
          amount: 100,
          outcome: "ok",
        },
      });
      expect(built.status).toBe("built");
      if (built.status !== "built") return;
      const authorized = service.authorizeTreasuryActionContract(built.contract);
      expect(authorized.status).toBe("authorized");
    }
    expect(readTreasuryIntentCounters().fullScans + readTreasuryQuarantineCounters().fullScans).toBe(scansBefore);
    unregisterTreasuryActionAdapterForTest("test.transfer");
  });

describe("第十轮 operation-count：原子 redemption 与统一 readiness", () => {
  it("批量原子 redemption 与 leg 数线性：多资源执行零全表扫描（bundle 路径）", () => {
    const rooms = installRooms(buildRoomSpecs());
    const service = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
    service.beginTick();
    registerTreasuryActionAdapter(makeTreasuryTestTransferAdapter());
    const quarantineBefore = readTreasuryQuarantineCounters().fullScans;
    const intentBefore = readTreasuryIntentCounters().fullScans;
    const receiptBefore = service.metrics().receiptFullScans;
    for (let index = 0; index < 3; index += 1) {
      const built = buildTreasuryActionContract(service, {
        actionKind: "test.transfer",
        transactionId: `r10_perf_multi${String(index)}`,
        args: {
          fromRoom: "W1N57",
          fromLocation: "storage",
          toRoom: "W1N57",
          toLocation: "terminal",
          resource: "U",
          amount: 100,
          feeFromRoom: "W1N57",
          feeAmount: 10,
          outcome: "ok",
        },
      });
      if (built.status !== "built") throw new Error("build failed");
      const issued = service.authorizeTreasuryActionContract(built.contract);
      if (issued.status !== "authorized") throw new Error("authorize failed");
      const result = executeTreasuryActionContract(service, { contract: built.contract, authorization: issued.bundle });
      if (result.status !== "executed_committed") throw new Error(`execute failed: ${JSON.stringify(result).slice(0, 96)}`);
    }
    // 原子 redemption（staged 发布 + 回滚能力）不引入任何全表扫描。
    expect(readTreasuryQuarantineCounters().fullScans).toBe(quarantineBefore);
    expect(readTreasuryIntentCounters().fullScans).toBe(intentBefore);
    expect(service.metrics().receiptFullScans).toBe(receiptBefore);
  });

  it("统一 write readiness：query/authorize 双向评估零全表扫描（O(1) 基于缓存 counters）", () => {
    const rooms = installRooms(buildRoomSpecs());
    const service = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
    service.beginTick();
    registerTreasuryActionAdapter(makeTreasuryTestTransferAdapter());
    const quarantineBefore = readTreasuryQuarantineCounters().fullScans;
    const intentBefore = readTreasuryIntentCounters().fullScans;
    for (let index = 0; index < 5; index += 1) {
      const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
      expect(view.writeAdmission.ready).toBe(true);
      const built = buildTreasuryActionContract(service, {
        actionKind: "test.transfer",
        transactionId: `r10_perf_ready${String(index)}`,
        args: { fromRoom: "W1N57", fromLocation: "storage", toRoom: "W1N57", toLocation: "terminal", resource: RESOURCE_ENERGY, amount: 50, outcome: "ok" },
      });
      if (built.status !== "built") throw new Error("build failed");
      const issued = service.authorizeTreasuryActionContract(built.contract);
      if (issued.status !== "authorized") throw new Error("authorize failed（readiness 误报 blocker）");
    }
    expect(readTreasuryQuarantineCounters().fullScans).toBe(quarantineBefore);
    expect(readTreasuryIntentCounters().fullScans).toBe(intentBefore);
  });
});

describe("第十一轮 immutable registries 与 durable cohort 的 operation-count fixture", () => {
  it("r11：query/authorize/prepare 正常路径零 intent/quarantine 全扫；registry lookup/revision O(1)；cohort/identity 计算与 leg/posting 数线性", () => {
    const rooms = installRooms(buildRoomSpecs());
    const service = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
    service.beginTick();
    registerTreasuryActionAdapter(makeTreasuryTestTransferAdapter());
    // registry revision 与 lookup：多次 find/revision 读取不产生任何 store 扫描。
    const revisionBefore = readTreasuryAdapterRegistryRevision();
    for (let index = 0; index < 32; index += 1) {
      expect(findTreasuryActionAdapter("test.transfer")).toBeDefined();
    }
    expect(readTreasuryAdapterRegistryRevision()).toBe(revisionBefore);
    // 正常写路径（build → authorize → execute committed）× 6：全程零全扫
    //（cohort facts 构造/durable identity 计算只读 bounded facts——与
    // leg/posting 数线性，无 store 迭代）。
    const intentScansBefore = readTreasuryIntentCounters().fullScans;
    const quarantineScansBefore = readTreasuryQuarantineCounters().fullScans;
    for (let index = 0; index < 6; index += 1) {
      const built = buildTreasuryActionContract(service, {
        actionKind: "test.transfer",
        transactionId: `perf_r11_${String(index)}`,
        args: {
          fromRoom: "W1N57",
          fromLocation: "storage",
          toRoom: "W1N57",
          toLocation: "terminal",
          resource: RESOURCE_ENERGY,
          amount: 100,
          outcome: "ok",
        },
      });
      expect(built.status).toBe("built");
      if (built.status !== "built") return;
      const authorized = service.authorizeTreasuryActionContract(built.contract);
      expect(authorized.status).toBe("authorized");
      if (authorized.status !== "authorized") return;
      expect(executeTreasuryActionContract(service, { contract: built.contract, authorization: authorized.bundle }).status).toBe("executed_committed");
      // query 视图正常路径 readiness 亦零全扫（收集器经缓存 health 探测）。
      const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
      expect(view.writeAdmission.ready).toBe(true);
    }
    expect(readTreasuryIntentCounters().fullScans).toBe(intentScansBefore);
    expect(readTreasuryQuarantineCounters().fullScans).toBe(quarantineScansBefore);
    unregisterTreasuryActionAdapterForTest("test.transfer");
  });
});
