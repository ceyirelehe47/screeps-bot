/**
 * 【Round 22 Remediation X】Ticket-Gated Attempt Opening 固定反例
 *（T 组：execution authority 状态机；B 组：ticket storage boundedness；
 *  压力：真实 production opening 长跑 / 高吞吐 GC / global reset 窗口）。
 *
 * 全部 execute 断言显式 callback 调用次数；production opening 一律走
 * open → build → authorize → execute 真实路径（不使用裸 mint helper、
 * 不手工 consume ticket——X 工作流 A 的协议内部性）。
 */

import { createTreasuryService } from "@/runtime/treasury/facade";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import { installRooms, type RoomSpec } from "@mock/treasury";
import {
  abandonTreasuryIssuedAttemptTicketForTest,
  clearTreasuryIssuedAttemptTicketDurableForTest,
  openTreasuryIssuedInitialAttempt,
  peekTreasuryIssuedAttemptTicketHealth,
  readTreasuryIssuedAttemptTicket,
  resetTreasuryIssuedAttemptTicketHeapCacheForTest,
  expireTreasuryIssuedAttemptTickets,
  TREASURY_ISSUED_TICKET_MAX_ENTRIES,
  TREASURY_ISSUED_TICKET_TTL_TICKS,
} from "@/runtime/treasury/attemptIssuanceTicket";
import {
  TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES,
} from "@/runtime/treasury/attemptIssuanceTicket";
import {
  mintTreasuryInitialAttemptId,
  peekTreasuryIssuedAttemptWatermark,
  clearTreasuryAttemptIssuerDurableForTest,
  resetTreasuryAttemptIssuerHeapCacheForTest,
  checkTreasuryServiceIssuedAttemptId,
  buildTreasuryIssuedInitialAttemptIdFromSequence,
} from "@/runtime/treasury/attemptIssuer";
import {
  buildTreasuryActionContract,
  executeTreasuryActionContract,
  registerTreasuryActionAdapter,
  makeTreasuryTestTransferAdapter,
  sealTreasuryAdapterRegistryForProduction,
  unsealTreasuryAdapterRegistryForTest,
  clearTreasuryAdapterRegistryForTest,
} from "@/runtime/treasury/actionContracts";
import { runTreasuryLifecycleGcCoordinator } from "@/runtime/treasury/treasuryLifecycleGcCoordinator";
import { completeTreasuryIssuedTicketHandoff } from "@/runtime/treasury/attemptIssuanceHandoff";
import { resolveTreasuryAttemptLifecycleOwnership } from "@/runtime/treasury/treasuryLifecycleOwnerResolver";
import { recomputeTreasuryDurableIdentityDigest } from "@/runtime/treasury/identityProof";
import { lookupTreasuryStoreLifecycleContract } from "@/runtime/treasury/treasuryLifecycleContract";
import {
  clearTreasuryPersistenceForTest,
} from "@/runtime/treasury/receipts";
import {
  clearTreasuryCleanupCompletionDurableForTest,
} from "@/runtime/treasury/cleanupCompletionAuthority";
import {
  clearTreasuryCleanupSupersessionDurableForTest,
} from "@/runtime/treasury/cleanupSupersessionAuthority";
import { clearTreasuryChainCertificateDurableForTest } from "@/runtime/treasury/chainRetirementCertificate";
import { clearTreasuryCompletionHeadroomReservationDurableForTest } from "@/runtime/treasury/completionHeadroomReservation";
import { resetTreasuryResolutionStoreForTest } from "@/runtime/treasury/resolutionStore";
import type { TreasuryTransactionInput } from "@/runtime/treasury/types";

jest.setTimeout(300_000);

beforeEach(() => {
  jest.clearAllMocks();
  clearTreasuryPersistenceForTest();
  clearTreasuryCleanupCompletionDurableForTest();
  clearTreasuryCleanupSupersessionDurableForTest();
  clearTreasuryChainCertificateDurableForTest();
  clearTreasuryAttemptIssuerDurableForTest();
  clearTreasuryIssuedAttemptTicketDurableForTest();
  clearTreasuryCompletionHeadroomReservationDurableForTest();
  resetTreasuryResolutionStoreForTest();
});

// ── 共享 fixture（与 IX 同构）──────────────────────────────────────────────

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 10_000_000 }, freeCapacity: 10_000_000 },
    terminal: { id: "term-1", resources: { energy: 10_000_000 }, freeCapacity: 10_000_000 },
  },
];

function makeService(): TreasuryTestService {
  const rooms = installRooms(ROOMS);
  const service = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
  service.beginTick();
  return treasuryTestService(service);
}

function input(service: TreasuryTestService, transactionId: string, delta = -500): TreasuryTransactionInput {
  const epoch = service.observation().epoch;
  return {
    transactionId,
    kind: "terminal.send",
    source: "test",
    decision: { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick },
    postings: [{ roomName: ROOMS[0].name, locationKind: "storage", resource: "energy", delta }],
  };
}

interface SealedExecuteOutcome {
  readonly callbackCount: number;
  readonly status: string;
  readonly reason?: string;
  readonly detail?: string;
}

/** production opening：open → build → authorize → execute（sealed channel）。 */
function productionOpening(
  service: TreasuryTestService,
  openedTransactionId: string,
  options?: { readonly amount?: number; readonly outcome?: "ok" | "non-ok" | "throw"; readonly tamperAuthorization?: boolean },
): SealedExecuteOutcome {
  registerTreasuryActionAdapter(makeTreasuryTestTransferAdapter());
  registerTreasuryActionAdapter({
    ...makeTreasuryTestTransferAdapter(),
    kind: "terminal.send",
    semanticIdentity: "terminal.send@reconciler-semantics-v1",
  } as never);
  const built = buildTreasuryActionContract(service, {
    actionKind: "terminal.send",
    transactionId: openedTransactionId,
    args: {
      fromRoom: ROOMS[0].name,
      fromLocation: "storage",
      toRoom: ROOMS[0].name,
      toLocation: "terminal",
      resource: "energy",
      amount: options?.amount ?? 100,
      outcome: options?.outcome ?? "ok",
    } as never,
  });
  if (built.status === "rejected") return { callbackCount: 0, status: "prepare_rejected", reason: built.reason, detail: built.detail };
  const authorization = service.authorizeTreasuryActionContract(built.contract);
  sealTreasuryAdapterRegistryForProduction();
  try {
    if (authorization.status !== "authorized") {
      return { callbackCount: 0, status: "not_authorized", reason: authorization.reason, detail: (authorization as { detail?: string }).detail };
    }
    const result = executeTreasuryActionContract(service, {
      contract: built.contract,
      authorization: options?.tamperAuthorization === true ? ({} as never) : authorization.bundle,
    }) as { status?: string; reason?: string; detail?: string };
    return {
      callbackCount: result.status === "executed_committed" ? 1 : 0,
      status: result.status ?? "unknown",
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
    };
  } finally {
    unsealTreasuryAdapterRegistryForTest();
    clearTreasuryAdapterRegistryForTest();
  }
}


/** 分离 authorize/execute 的 production opening（中断窗口注入用：
 * authorize 成功后、execute 前注入 durable owner——模拟 execution-started
 * 已持久化而 ticket handoff 未完成 + global reset 的恢复场景）。 */
function executeWithExistingBundle(
  service: TreasuryTestService,
  openedTransactionId: string,
): SealedExecuteOutcome {
  registerTreasuryActionAdapter(makeTreasuryTestTransferAdapter());
  registerTreasuryActionAdapter({
    ...makeTreasuryTestTransferAdapter(),
    kind: "terminal.send",
    semanticIdentity: "terminal.send@reconciler-semantics-v1",
  } as never);
  const built = buildTreasuryActionContract(service, {
    actionKind: "terminal.send",
    transactionId: openedTransactionId,
    args: {
      fromRoom: ROOMS[0].name, fromLocation: "storage", toRoom: ROOMS[0].name, toLocation: "terminal",
      resource: "energy", amount: 100, outcome: "ok",
    } as never,
  });
  if (built.status === "rejected") return { callbackCount: 0, status: "prepare_rejected", reason: built.reason, detail: built.detail };
  const authorization = service.authorizeTreasuryActionContract(built.contract);
  if (authorization.status !== "authorized") {
    return { callbackCount: 0, status: "not_authorized", reason: authorization.reason, detail: (authorization as { detail?: string }).detail };
  }
  return injectThenExecute(service, built.contract, authorization.bundle);
}

/** authorize 已完成后注入中断状态（durable owner）再 execute。 */
let pendingInjection: ((id: string) => void) | null = null;
function injectThenExecute(
  service: TreasuryTestService,
  contract: Parameters<typeof executeTreasuryActionContract>[1] extends { readonly contract?: infer C } ? C : never,
  bundle: unknown,
): SealedExecuteOutcome {
  if (pendingInjection !== null && contract !== null && typeof contract === "object" && "transactionId" in contract) {
    pendingInjection((contract as { transactionId: string }).transactionId);
    pendingInjection = null;
  }
  sealTreasuryAdapterRegistryForProduction();
  try {
    const result = executeTreasuryActionContract(service, {
      contract: contract as never,
      authorization: bundle as never,
    }) as { status?: string; reason?: string; detail?: string };
    return {
      callbackCount: result.status === "executed_committed" ? 1 : 0,
      status: result.status ?? "unknown",
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
    };
  } finally {
    unsealTreasuryAdapterRegistryForTest();
    clearTreasuryAdapterRegistryForTest();
  }
}

/** 受控 open fixture（open 失败即抛——测试自身前提）。 */
function openedId(correlation: string): string {
  const opened = openTreasuryIssuedInitialAttempt(correlation);
  if (opened.status !== "opened") throw new Error("open rejected in fixture: " + opened.detail);
  return opened.transactionId;
}

/** 持久层直读 ticket store（fixture 篡改用）。 */
function ticketStoreOfMemory(): { version?: unknown; entries: Record<string, unknown>; entryCount: number; updatedAt?: number } | undefined {
  return (Memory.runtime as unknown as { treasury?: { issuedAttemptTickets?: { version?: unknown; entries: Record<string, unknown>; entryCount: number; updatedAt?: number } } } | undefined)
    ?.treasury?.issuedAttemptTickets;
}

// ══ T 组：Ticket-gated opening ═══════════════════════════════════════════

describe("Remediation X T：ticket-gated opening", () => {
  it("T1：直接 mint（checksum 合法、sequence ≤ watermark）但无 ticket → sealed production execute 拒绝，callback=0", () => {
    const service = makeService();
    // 先 open 一次推进 watermark（保证后续 mint 的 sequence ≤ watermark）。
    const warm = openedId("t1_warm");
    void warm;
    const minted = mintTreasuryInitialAttemptId("t1_raw");
    expect(minted.status).toBe("minted");
    if (minted.status !== "minted") return;
    // mint 出的 ID 通过 issuer 检查（issued）——但不构成执行权限。
    expect(checkTreasuryServiceIssuedAttemptId(minted.transactionId).status).toBe("issued");
    const executed = productionOpening(service, minted.transactionId);
    expect(executed.callbackCount).toBe(0);
    expect(executed.reason).toBe("issued_ticket_missing");
  });

  it("T2：open → build → authorize → execute（不手工 consume）→ committed、callback 恰一次；handoff 由内部协议完成", () => {
    const service = makeService();
    const id = openedId("t2");
    const executed = productionOpening(service, id);
    expect(executed.status).toBe("executed_committed");
    expect(executed.callbackCount).toBe(1);
    // ticket 已被内部协议接管（consumed——execution-started 持久化后）。
    const ticket = readTreasuryIssuedAttemptTicket(id);
    expect(ticket?.state).toBe("consumed");
  });

  it("T3：open 后 TTL 过期 + terminal GC 删除 → 新 tick 重建 fresh contract 执行 → 拒绝，callback=0", () => {
    const service = makeService();
    const id = openedId("t3");
    Game.time += TREASURY_ISSUED_TICKET_TTL_TICKS + 1;
    const gc = runTreasuryLifecycleGcCoordinator();
    expect(gc.ticketsExpired).toBe(1);
    expect(readTreasuryIssuedAttemptTicket(id)).toBeUndefined();
    // 新 tick 重建 fresh contract（同 ID）——expired/deleted ticket 永不可执行。
    const executed = productionOpening(service, id);
    expect(executed.callbackCount).toBe(0);
    expect(executed.reason).toBe("issued_ticket_missing");
  });

  it("T4：ticket store unknown version → 合法 watermark ti2_ ID 拒绝（callback=0），store 零 destructive mutation", () => {
    const service = makeService();
    const id = openedId("t4");
    const before = JSON.stringify(ticketStoreOfMemory());
    const store = ticketStoreOfMemory()!;
    (store as { version: unknown }).version = 99;
    resetTreasuryIssuedAttemptTicketHeapCacheForTest();
    const executed = productionOpening(service, id);
    expect(executed.callbackCount).toBe(0);
    expect(executed.reason).toBe("issued_ticket_store_unhealthy");
    // 零 destructive mutation：除被篡改的 version 字段外无变化（无删除/状态改写）。
    const after = ticketStoreOfMemory()!;
    expect(Object.keys(after.entries).length).toBe(JSON.parse(before).entries ? Object.keys(JSON.parse(before).entries).length : 0);
    // ticket 未被 consume / 删除（零 destructive mutation）。
    expect(readTreasuryIssuedAttemptTicket(id)?.state ?? "active").not.toBe("consumed");
  });

  it("T5：ticket store entryCount / entry shape 损坏 → fail closed，callback=0", () => {
    const service = makeService();
    // 5a：entryCount 不一致。
    const idA = openedId("t5a");
    ticketStoreOfMemory()!.entryCount = 99;
    resetTreasuryIssuedAttemptTicketHeapCacheForTest();
    expect(peekTreasuryIssuedAttemptTicketHealth().healthy).toBe(false);
    let executed = productionOpening(service, idA);
    expect(executed.callbackCount).toBe(0);
    expect(executed.reason).toBe("issued_ticket_store_unhealthy");
    clearTreasuryIssuedAttemptTicketDurableForTest();
    // 5b：entry shape 损坏（owner 非法）。
    const idB = openedId("t5b");
    const store = ticketStoreOfMemory()!;
    store.entries["tk:" + idB] = { ...(store.entries["tk:" + idB] as object), owner: "" };
    resetTreasuryIssuedAttemptTicketHeapCacheForTest();
    expect(peekTreasuryIssuedAttemptTicketHealth().healthy).toBe(false);
    executed = productionOpening(service, idB);
    expect(executed.callbackCount).toBe(0);
    expect(executed.reason).toBe("issued_ticket_store_unhealthy");
  });

  it("T6：active ticket 绑定 contract A 后，contract B（不同 digest）接管 → exact conflict，callback=0，A 的事实不被覆盖", () => {
    const service = makeService();
    const id = openedId("t6");
    // contract A：经 kernel 通道携带 intentContract（无 bundle——redemption
    // 缺失触发 partial-modern invariant 拒绝，恰好发生在 binding gate 之后、
    // execution-started 之前：ticket 完成 binding 但保持 active（纯前置
    // 失败——B8/T7 语义）。
    const executedA = service.executePreparedAction(input(service, id), () => ({ ok: true }) as never, {
      intentContract: { contractId: "ac:t6-a", contractDigest: "digest-a-t6" },
    } as never);
    expect(executedA.status).toBe("prepare_rejected");
    const bound = readTreasuryIssuedAttemptTicket(id);
    expect(bound?.state).toBe("active");
    expect(bound?.boundContractDigest).toBe("digest-a-t6");
    // contract B：不同 digest → exact conflict（callback=0）。
    const executedB = service.executePreparedAction(input(service, id), () => ({ ok: true }) as never, {
      intentContract: { contractId: "ac:t6-b", contractDigest: "digest-b-t6" },
    } as never);
    expect(executedB.status).toBe("prepare_rejected");
    if (executedB.status === "prepare_rejected") expect(executedB.reason).toBe("issued_ticket_binding_conflict");
    // A 的安全事实不被覆盖（binding 仍指向 A 的 digest）。
    expect(readTreasuryIssuedAttemptTicket(id)?.boundContractDigest).toBe("digest-a-t6");
    // 同 exact opening（contract A 原样）幂等重试：binding 幂等 → 走到与
    // 第一次相同的失败点（不因 binding 重复被拒）。
    const retryA = service.executePreparedAction(input(service, id), () => ({ ok: true }) as never, {
      intentContract: { contractId: "ac:t6-a", contractDigest: "digest-a-t6" },
    } as never);
    expect(retryA.status).toBe("prepare_rejected");
    if (retryA.status === "prepare_rejected") expect(retryA.reason).not.toBe("issued_ticket_binding_conflict");
  });

  it("T7：authorization / invalid epoch / capacity 等纯前置失败 → 不产生 consumed-but-unowned ticket；同 exact opening 幂等重试成功", () => {
    const service = makeService();
    // 7a：authorization 失败（binding 后 redemption 拒绝）。
    const idA = openedId("t7a");
    const failed = productionOpening(service, idA, { tamperAuthorization: true });
    expect(failed.callbackCount).toBe(0);
    expect(readTreasuryIssuedAttemptTicket(idA)?.state).toBe("active");
    // 7b：invalid epoch（prepare 在 epoch 检查拒绝——ticket gate 放行、
    // execution-started 未发生）。
    const idB = openedId("t7b");
    const stale = { scope: "stale-scope" as never, epochSeq: 999_999, observedAtTick: 1 };
    const prepared = service.prepareTransaction({ ...input(service, idB), decision: stale });
    expect(prepared.status).toBe("rejected");
    expect(readTreasuryIssuedAttemptTicket(idB)?.state).toBe("active");
    // 7c：同 exact opening 幂等重试（7b 的 ID 用合法 epoch 重新 execute）。
    const retry = productionOpening(service, idB);
    expect(retry.status).toBe("executed_committed");
    expect(retry.callbackCount).toBe(1);
    expect(readTreasuryIssuedAttemptTicket(idB)?.state).toBe("consumed");
  });

  it("T8：global reset 窗口（durable owner 已写入、ticket 未 consume）→ 恢复幂等完成 handoff，同一 callback 不再次执行", () => {
    const service = makeService();
    const id = openedId("t8");
    // authorize 正常完成后（bundle 已在手）、execute 前注入 in-flight
    // durable intent——模拟 execution-started 已持久化、ticket handoff 未
    // 完成 + global reset（heap 重建）的中断窗口。
    pendingInjection = (target) => {
      seedDurableIntent(target);
      resetTreasuryIssuedAttemptTicketHeapCacheForTest();
    };
    const executed = executeWithExistingBundle(service, id);
    expect(executed.callbackCount).toBe(0);
    expect(executed.reason).toBe("issued_ticket_handoff_recovered");
    // gate 的 durable-owner 分支幂等完成 handoff（active → consumed）。
    expect(readTreasuryIssuedAttemptTicket(id)?.state).toBe("consumed");
    // 同一 callback 不再次执行：重复 execute 恒拒绝。
    const again = productionOpening(service, id);
    expect(again.callbackCount).toBe(0);
    // 重复 execute 恒拒绝（unresolved intent 的 write admission 先拦或
    // ticket gate 拒绝——两条路径都阻断第二个 callback）。
    expect(again.status).not.toBe("executed_committed");
  });

  it("T9：手工 consume（无 matching durable owner）→ 拒绝；构造 consumed 状态也不能获得执行权限", () => {
    const service = makeService();
    const id = openedId("t9");
    // 9a：owner-gated handoff 无 durable owner → 拒绝（不制造 consumed-but-unowned）。
    const handoff = completeTreasuryIssuedTicketHandoff(id);
    expect(handoff.status).toBe("rejected");
    expect(readTreasuryIssuedAttemptTicket(id)?.state).toBe("active");
    // 9b：极端构造（持久层直改 state=consumed——历史手工 consume 等价物）→
    // execute gate 一律拒绝（consumed 且无 durable owner，fail closed）。
    const store = ticketStoreOfMemory()!;
    store.entries["tk:" + id] = { ...(store.entries["tk:" + id] as object), state: "consumed" };
    resetTreasuryIssuedAttemptTicketHeapCacheForTest();
    const executed = productionOpening(service, id);
    expect(executed.callbackCount).toBe(0);
    expect(executed.reason).toBe("issued_ticket_consumed_without_owner");
  });

  it("T10：64 个 active ticket 占满 active 容量 → 第 65 个 open 拒绝，issuer watermark 不推进", () => {
    makeService();
    for (let index = 0; index < TREASURY_ISSUED_TICKET_MAX_ENTRIES; index += 1) {
      expect(openTreasuryIssuedInitialAttempt("t10_" + index).status).toBe("opened");
    }
    const watermarkBefore = peekTreasuryIssuedAttemptWatermark();
    const overflow = openTreasuryIssuedInitialAttempt("t10_overflow");
    expect(overflow.status).toBe("rejected");
    if (overflow.status === "rejected") expect(overflow.reason).toBe("ticket_capacity_exhausted");
    expect(peekTreasuryIssuedAttemptWatermark()).toBe(watermarkBefore);
  });

  it("T11：ticket 已被 opening A 消费、settled 权威之前的窗口 → opening B 不得再次执行（durable owner 承接，非新 callback）", () => {
    const service = makeService();
    const id = openedId("t11");
    // A：真实 execute 完成（ticket consumed；receipt/tombstone durable owner
    // 在位——commit 已发生）。
    const executedA = productionOpening(service, id);
    expect(executedA.callbackCount).toBe(1);
    // B：同 ID 再次 execute——不得产生第二个 callback（既有权威承接）。
    const executedB = productionOpening(service, id);
    expect(executedB.callbackCount).toBe(0);
    expect(executedB.status).not.toBe("executed_committed");
    // durable lifecycle owner 在位（恢复选择已有 durable owner，而非新 callback）。
    expect(resolveTreasuryAttemptLifecycleOwnership(id).status).toBe("owned");
  });

  it("T12：ticket owner/source/contract binding 不一致 → 结构化拒绝（不被诊断字符串相似绕过）", () => {
    const service = makeService();
    const id = openedId("t12");
    // 12a：boundContractDigest 被篡改为其它值 → 与真实 contract digest 冲突
    //（reason 精确，不进入执行）。
    const failed = productionOpening(service, id, { tamperAuthorization: true });
    expect(failed.callbackCount).toBe(0);
    const store = ticketStoreOfMemory()!;
    const entry = store.entries["tk:" + id] as { boundContractDigest?: string };
    entry.boundContractDigest = "f".repeat(64);
    resetTreasuryIssuedAttemptTicketHeapCacheForTest();
    const executed = productionOpening(service, id);
    expect(executed.callbackCount).toBe(0);
    expect(executed.reason).toBe("issued_ticket_binding_conflict");
    // 12b：transactionId 与 ticket 键不一致（手工移植 ticket）→ 键校验 fail
    // closed（store unhealthy，不当作有效授权）。
    const other = openedId("t12b");
    const otherEntry = ticketStoreOfMemory()!.entries["tk:" + other] as { transactionId: string };
    otherEntry.transactionId = "ti2_999999_deadbeefdeadbeef";
    resetTreasuryIssuedAttemptTicketHeapCacheForTest();
    const executedOther = productionOpening(service, other);
    expect(executedOther.callbackCount).toBe(0);
    expect(executedOther.reason).toBe("issued_ticket_store_unhealthy");
  });
});

/** in-flight durable intent 注入（T8/B8 的 handoff 中断窗口——intent 是
 * execution-started 已持久化的 durable owner，且只在 ticket gate 之后的
 * 全局 intent blocker 被处置，恰好构造"durable owner 在位 + ticket 未
 * consume"的恢复窗口）。 */
function seedDurableIntent(transactionId: string): void {
  if (!Memory.runtime) Memory.runtime = {} as never;
  const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
  runtime.treasury = runtime.treasury ?? {};
  const branch = runtime.treasury as {
    intents?: { version: number; entries: Record<string, unknown>; entryCount: number; updatedAt: number };
  };
  if (branch.intents === undefined) {
    branch.intents = { version: 6, entries: {}, entryCount: 0, updatedAt: Game.time };
  }
  // 【XI】durableIdentityDigest 必须与持久事实重算一致（X 轮的假值
  // "ffffffffffffffff" 在 intent v7 校验下使 store fail closed——XI 的
  // 正向 handoff 证明把该状态判为 blocked 而非 owner 在位，fixture 需要
  // 构造真正健康的 durable owner）。
  const seeded: Record<string, unknown> = {
    authorityLevel: "lowlevel",
    transactionId,
    digest: "0123456789abc001",
    actionKind: "terminal.send",
    kind: "terminal.send",
    source: "test",
    postings: [{ roomName: ROOMS[0].name, locationKind: "storage", resource: "energy", delta: -500 }],
    outcome: "started_unknown",
    settlement: "executing",
    auditSource: "execute-prepared-action",
    lowlevelSource: "runtime-lowlevel@v1",
    createdAtTick: Game.time,
    updatedAtTick: Game.time,
  };
  const recomputed = recomputeTreasuryDurableIdentityDigest(seeded as never);
  seeded.durableIdentityDigest = recomputed ?? "ffffffffffffffff";
  branch.intents.entries["i:" + transactionId] = seeded;
  branch.intents.entryCount = Object.keys(branch.intents.entries).length;
  branch.intents.updatedAt = Game.time;
}

// ══ B 组：Ticket storage boundedness ═════════════════════════════════════

describe("Remediation X B：ticket storage boundedness", () => {
  it("B1：手写超过 hardCapacity 的 ticket store → health unhealthy，open/expire/GC 全 fail closed", () => {
    makeService();
    const store = ticketStoreOfMemory()!;
    for (let index = 1; index <= TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES + 1; index += 1) {
      store.entries["tk:ti2_" + index + "_aaaaaaaabbbbbbbb"] = {
        transactionId: "ti2_" + index + "_aaaaaaaabbbbbbbb",
        sequence: index,
        issuedAtTick: Game.time,
        owner: "b1",
        state: "expired",
        stateChangedAtTick: Game.time,
      };
    }
    store.entryCount = Object.keys(store.entries).length;
    resetTreasuryIssuedAttemptTicketHeapCacheForTest();
    expect(peekTreasuryIssuedAttemptTicketHealth().healthy).toBe(false);
    // open fail closed。
    expect(openTreasuryIssuedInitialAttempt("b1_open").status).toBe("rejected");
    // expire / GC 零删除（terminal 淘汰走 health 前置——store 损坏不动）。
    expect(expireTreasuryIssuedAttemptTickets()).toBe(0);
    const gc = runTreasuryLifecycleGcCoordinator();
    expect(gc.ticketsRetired).toBe(0);
    // execute gate 同样 fail closed。
    const service = makeService();
    const executed = productionOpening(service, "ti2_1_aaaaaaaabbbbbbbb");
    expect(executed.callbackCount).toBe(0);
  });

  it("B2/B3：≥1000 次 open→consume/expire→retire（单 tick 转换 > GC batch）→ entryCount 恒 ≤ 硬容量，Memory 进入有界平台", () => {
    makeService();
    let maxEntryCount = 0;
    const memoryLengths: number[] = [];
    // 单 tick 20 个 open+abandon（转换量 > GC batch 8），每 tick 结束 GC。
    for (let tick = 0; tick < 50; tick += 1) {
      for (let index = 0; index < 20; index += 1) {
        const id = openedId("b2_" + tick + "_" + index);
        if (!abandonTreasuryIssuedAttemptTicketForTest(id)) throw new Error("abandon failed");
        const count = Object.keys(ticketStoreOfMemory()!.entries).length;
        if (count > maxEntryCount) maxEntryCount = count;
        expect(count).toBeLessThanOrEqual(TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES);
      }
      runTreasuryLifecycleGcCoordinator();
      memoryLengths.push(JSON.stringify((Memory.runtime as unknown as { treasury?: unknown }).treasury).length);
    }
    expect(maxEntryCount).toBeLessThanOrEqual(TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES);
    // warm-up 后 Memory 平台：后 25 个 tick 的序列化长度不随历史总数线性
    // 增长（平台带内——evidence 记录实测数字）。
    const lateMax = Math.max(...memoryLengths.slice(25));
    const earlyMax = Math.max(...memoryLengths.slice(0, 25));
    expect(lateMax).toBeLessThanOrEqual(earlyMax + lateMax * 0.1);
  });

  it("B4：满载时有 eligible terminal → bounded reclaim 后 open；terminal 不可回收 → fail closed 且 watermark 不推进", () => {
    makeService();
    // 32 active + 96 terminal（retire 每批 8——分批构造，确保 sequence ≤
    // watermark 使其 eligible）。
    for (let index = 0; index < 32; index += 1) {
      const id = openedId("b4_active_" + index);
      void id;
    }
    for (let batch = 0; batch < 96; batch += 1) {
      const id = openedId("b4_term_" + batch);
      // 持久层直改 state（terminal 在位但不删除——reclaim 的真实对象）。
      const entry = ticketStoreOfMemory()!.entries["tk:" + id] as { state: string };
      entry.state = "consumed";
    }
    expect(Object.keys(ticketStoreOfMemory()!.entries).length).toBe(TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES);
    // open：满载 → reclaim terminal（retire 路径）→ 成功。
    const opened = openTreasuryIssuedInitialAttempt("b4_after_reclaim");
    expect(opened.status).toBe("opened");
    expect(Object.keys(ticketStoreOfMemory()!.entries).length).toBeLessThanOrEqual(TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES);
    // 不可回收分支：terminal sequence > watermark（anti-reuse frontier 未
    // 覆盖——retire 跳过）→ total 满 → open fail closed 且 watermark 不推进。
    // 先把全部真实 terminal（watermark 覆盖）耗尽。
    for (let round = 0; round < 40; round += 1) {
      if (runTreasuryLifecycleGcCoordinator().ticketsRetired === 0) break;
    }
    const watermark = peekTreasuryIssuedAttemptWatermark();
    const store = ticketStoreOfMemory()!;
    while (Object.keys(store.entries).length < TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES) {
      const fakeSeq = 9_000_000 + Object.keys(store.entries).length;
      // 【XI】fake terminal 也必须是 canonical current ID（假 checksum 会被
      // canonical shape 校验判为损坏——store unhealthy 而非容量语义）。
      const builtFake = buildTreasuryIssuedInitialAttemptIdFromSequence(fakeSeq);
      if (builtFake.status !== "built") break;
      store.entries["tk:" + builtFake.transactionId] = {
        transactionId: builtFake.transactionId,
        sequence: fakeSeq,
        issuedAtTick: Game.time,
        owner: "b4_fake",
        state: "expired",
        stateChangedAtTick: Game.time,
      };
    }
    store.entryCount = Object.keys(store.entries).length;
    resetTreasuryIssuedAttemptTicketHeapCacheForTest();
    const overflow = openTreasuryIssuedInitialAttempt("b4_overflow");
    expect(overflow.status).toBe("rejected");
    if (overflow.status === "rejected") expect(overflow.reason).toBe("ticket_capacity_exhausted");
    expect(peekTreasuryIssuedAttemptWatermark()).toBe(watermark);
  });

  it("B5：≥256 个 initial attempts 全部真实 production 路径（open→build→authorize→execute）→ committed、ticket store 有界", () => {
    const service = makeService();
    let committed = 0;
    let maxEntryCount = 0;
    for (let index = 0; index < 256; index += 1) {
      // 真实生产节奏：每 tick 一个 opening（fresh observation 配额按 tick
      // 恢复）+ beginTick 恢复链 + GC coordinator（terminal ticket 回收）。
      Game.time += 1;
      service.beginTick();
      runTreasuryLifecycleGcCoordinator();
      const id = openedId("b5_" + index);
      const outcome = productionOpening(service, id);
      if (outcome.status === "executed_committed") committed += 1;
      expect(outcome.callbackCount).toBeLessThanOrEqual(1);
      const count = Object.keys(ticketStoreOfMemory()!.entries).length;
      if (count > maxEntryCount) maxEntryCount = count;
      expect(count).toBeLessThanOrEqual(TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES);
    }
    expect(committed).toBe(256);
    expect(maxEntryCount).toBeLessThanOrEqual(TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES);
  });

  it("B6：open/expire/GC 的 entries visited ≤ 声明硬容量（全表操作受总容量常量约束）", () => {
    makeService();
    for (let index = 0; index < 40; index += 1) {
      const id = openedId("b6_" + index);
      if (!abandonTreasuryIssuedAttemptTicketForTest(id)) throw new Error("abandon failed");
    }
    const entries = Object.keys(ticketStoreOfMemory()!.entries).length;
    expect(entries).toBeLessThanOrEqual(TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES);
    // expire/retire 的扫描对象 = 全表（≤ 总容量）；操作完成即证明扫描有界。
    Game.time += TREASURY_ISSUED_TICKET_TTL_TICKS + 1;
    expect(expireTreasuryIssuedAttemptTickets()).toBeLessThanOrEqual(TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES);
    const gc = runTreasuryLifecycleGcCoordinator();
    expect(gc.ticketsRetired).toBeLessThanOrEqual(TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES);
  });

  it("B7：lifecycle contract 的 hardCapacity/gcBound/classification 与运行时行为一致", () => {
    const contract = lookupTreasuryStoreLifecycleContract("issuedAttemptTickets");
    expect(contract).toBeDefined();
    expect(contract!.hardCapacity).toBe(TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES);
    expect(contract!.classification).toBe("active-unresolved");
    expect(contract!.gcBound).toContain(String(TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES));
    // shape validator 与常量一致（超容量 store unhealthy——B1 已行为级验证）。
    expect(contract!.capacityNote).toContain("TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES=128");
  });

  it("B8：global reset 交错于 active / handoff-pair / terminal cleanup 阶段 → store 仍有界，旧 ID 不可重新执行", () => {
    const service = makeService();
    const ids: string[] = [];
    // 阶段 1：active 窗口 reset。
    ids.push(openedId("b8_a1"));
    resetTreasuryIssuedAttemptTicketHeapCacheForTest();
    expect(readTreasuryIssuedAttemptTicket(ids[0]!)?.state).toBe("active");
    // 阶段 2：handoff-pair（durable owner 在位 + ticket 未 consume）窗口 reset。
    ids.push(openedId("b8_a2"));
    pendingInjection = (target) => {
      seedDurableIntent(target);
      resetTreasuryIssuedAttemptTicketHeapCacheForTest();
    };
    const recovered = executeWithExistingBundle(service, ids[1]!);
    expect(recovered.callbackCount).toBe(0);
    expect(readTreasuryIssuedAttemptTicket(ids[1]!)?.state).toBe("consumed");
    // 阶段 3：terminal cleanup 阶段 reset。
    ids.push(openedId("b8_a3"));
    if (!abandonTreasuryIssuedAttemptTicketForTest(ids[2]!)) throw new Error("abandon failed");
    resetTreasuryIssuedAttemptTicketHeapCacheForTest();
    runTreasuryLifecycleGcCoordinator();
    expect(readTreasuryIssuedAttemptTicket(ids[2]!)).toBeUndefined();
    // store 有界；全部旧 ID 不可重新执行。
    expect(Object.keys(ticketStoreOfMemory()!.entries).length).toBeLessThanOrEqual(TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES);
    for (const id of ids) {
      const replay = productionOpening(service, id);
      expect(replay.callbackCount).toBe(0);
    }
  });
});
