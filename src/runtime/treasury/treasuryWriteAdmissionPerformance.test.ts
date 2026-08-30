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

function makeService(roomSpecs: RoomSpec[] = buildRoomSpecs(), tasks?: Record<string, ResourceTransferTask>): TreasuryService {
  const rooms = installRooms(roomSpecs);
  return createTreasuryService({
    getRooms: () => Object.values(rooms),
    ...(tasks !== undefined ? { getTasks: () => tasks } : {}),
  });
}

function prepareInput(service: TreasuryService, transactionId: string, delta: number, resource: ResourceConstant, roomName: string, locationKind: "storage" | "terminal" = "storage") {
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
        version: 3,
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
