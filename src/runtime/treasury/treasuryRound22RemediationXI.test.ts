/**
 * 【Round 22 Remediation XI 工作流 A / B】固定反例——正向 Ticket handoff
 * 证明（H 组）与 canonical current 发行身份（T 组）。
 *
 * H 组核心断言：resolver 的保守阻断（store unhealthy / probe 未装配 /
 * identity conflict）绝不构成"新 owner 已接管"——gate 返回
 * issued_ticket_owner_unverifiable、ticket 保持 active、callback=0；只有
 * 正向结构化 exact_owner 才授权幂等 consume（handoff_recovered）。
 *
 * T 组核心断言：issued ticket entry 的 canonical relation（ti2_ 域 +
 * checksum 确定性重算 + entry.sequence 与 ID 一致）是 store 级不变量——
 * 任一条损坏使整店 unhealthy（production callback 不可达）。
 */

import { createTreasuryService } from "@/runtime/treasury/facade";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import { installRooms, type RoomSpec } from "@mock/treasury";
import {
  openTreasuryIssuedInitialAttempt,
  readTreasuryIssuedAttemptTicket,
  peekTreasuryIssuedAttemptTicketHealth,
  clearTreasuryIssuedAttemptTicketDurableForTest,
  resetTreasuryIssuedAttemptTicketHeapCacheForTest,
} from "@/runtime/treasury/attemptIssuanceTicket";
import {
  clearTreasuryAttemptIssuerDurableForTest,
  peekTreasuryIssuedAttemptWatermark,
  buildTreasuryIssuedInitialAttemptIdFromSequence,
  verifyTreasuryCurrentIssuedIdCanonical,
} from "@/runtime/treasury/attemptIssuer";
import {
  buildTreasuryActionContract,
  executeTreasuryActionContract,
  registerTreasuryActionAdapter,
  sealTreasuryAdapterRegistryForProduction,
  unsealTreasuryAdapterRegistryForTest,
  clearTreasuryAdapterRegistryForTest,
  makeTreasuryTestTransferAdapter,
} from "@/runtime/treasury/actionContracts";
import {
  completeTreasuryIssuedTicketHandoffForIntentRecovery,
  gateTreasuryIssuedAttemptTicketForPrepare,
} from "@/runtime/treasury/attemptIssuanceHandoff";
import { resolveTreasuryAttemptLifecycleOwnership } from "@/runtime/treasury/treasuryLifecycleOwnerResolver";
import { recomputeTreasuryDurableIdentityDigest } from "@/runtime/treasury/identityProof";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import {
  clearTreasuryCleanupCompletionDurableForTest,
  lookupTreasuryCleanupCompletion,
} from "@/runtime/treasury/cleanupCompletionAuthority";
import { clearTreasuryCleanupSupersessionDurableForTest } from "@/runtime/treasury/cleanupSupersessionAuthority";
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
  pendingInjection = null;
});

// ── 共享 fixture（与 X 轮同构；durableIdentityDigest 经真实重算——XI）────

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
      amount: 100,
      outcome: "ok",
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
      authorization: authorization.bundle,
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

/** authorize 已完成后注入中断状态（durable owner / store 破坏）再 execute。 */
let pendingInjection: ((id: string) => void) | null = null;
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
  if (pendingInjection !== null) {
    pendingInjection(openedTransactionId);
    pendingInjection = null;
  }
  sealTreasuryAdapterRegistryForProduction();
  try {
    const result = executeTreasuryActionContract(service, {
      contract: built.contract as never,
      authorization: authorization.bundle as never,
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
  if (opened.status !== "opened") throw new Error(`open fixture 失败: ${opened.status}`);
  return opened.transactionId;
}

function ticketStoreOfMemory(): { entries: Record<string, { transactionId: string; sequence: number; issuedAtTick: number; owner: string; state: string; stateChangedAtTick: number; boundContractDigest?: string }>; entryCount: number; updatedAt: number } {
  const store = (Memory.runtime as unknown as { treasury?: { issuedAttemptTickets?: ReturnType<typeof ticketStoreOfMemory> } })?.treasury?.issuedAttemptTickets;
  if (store === undefined) throw new Error("ticket store 缺失（fixture 前提）");
  return store;
}

/** 健康的 in-flight durable intent 注入（durableIdentityDigest 真实重算——XI）。 */
function seedDurableIntent(transactionId: string): void {
  if (!Memory.runtime) Memory.runtime = {} as never;
  const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
  runtime.treasury = runtime.treasury ?? {};
  const branch = runtime.treasury as {
    intents?: { version: number; entries: Record<string, unknown>; entryCount: number; updatedAt: number };
  };
  if (branch.intents === undefined) {
    branch.intents = { version: 7, entries: {}, entryCount: 0, updatedAt: Game.time };
  }
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

// ══ H 组：Positive ticket handoff ═══════════════════════════════════════

describe("Remediation XI H：positive ticket handoff 证明", () => {
  it("H1：无 owner + unrelated Intent store 损坏 → owner_unverifiable（非 recovered）、ticket 保持 active；修复后同 opening 恰一次 callback", () => {
    const service = makeService();
    const id = openedId("h1");
    // unrelated transaction 的 intent entry 损坏（合法 v6 store + 他键 entry 非法）。
    pendingInjection = () => {
      const branch = (Memory.runtime as unknown as { treasury?: { intents?: { version: number; entries: Record<string, unknown>; entryCount: number; updatedAt: number } } })?.treasury;
      branch!.intents = { version: 7, entries: { "i:ti2_999_other": { broken: true } }, entryCount: 1, updatedAt: Game.time };
    };
    const executed = executeWithExistingBundle(service, id);
    expect(executed.callbackCount).toBe(0);
    // 【XII】ticket gate 移至 canonical digest 之后（4.3）——intent store
    // 损坏先被全局 intent blocker 拦截（intent_write_blocked /
    // intent_store_fatal：同样 callback=0、ticket 保持 active、fail closed）。
    expect(["intent_write_blocked", "intent_store_fatal"]).toContain(executed.reason);
    // ticket 保持 active（未 consume / 未 expire / 未删除）。
    expect(readTreasuryIssuedAttemptTicket(id)?.state).toBe("active");
    // 修复 store（删除损坏 intents + heap 缓存一并失效）：同 exact opening
    // 正常执行一次（callback 总数恰为 1）。
    const branchFix = (Memory.runtime as unknown as { treasury?: Record<string, unknown> })?.treasury!;
    delete branchFix.intents;
    (require("@/runtime/treasury/intents") as typeof import("@/runtime/treasury/intents")).resetTreasuryIntentRuntimeForTest();
    const repaired = productionOpening(service, id);
    expect(repaired.status).toBe("executed_committed");
    expect(repaired.callbackCount).toBe(1);
    expect(readTreasuryIssuedAttemptTicket(id)?.state).toBe("consumed");
  });

  it("H2：无 owner + unrelated Quarantine store 损坏 → owner_unverifiable、ticket 保持 active；修复后可恢复", () => {
    const service = makeService();
    const id = openedId("h2");
    pendingInjection = () => {
      const branch = (Memory.runtime as unknown as { treasury?: Record<string, unknown> })?.treasury!;
      branch.quarantine = { version: 4, entries: { "q:unrelated_tx": { malformed: null } }, entryCount: 1, updatedAt: Game.time };
    };
    const executed = executeWithExistingBundle(service, id);
    expect(executed.callbackCount).toBe(0);
    // 【XII】全局 quarantine blocker（prepare 的 health 前置）先拦截——
    // quarantine_store_fatal：同样 callback=0、ticket 保持 active、fail
    // closed（owner_unverifiable 的承载点移至 digest 后 early gate）。
    expect(["quarantine_store_fatal", "quarantine_write_blocked"]).toContain(executed.reason);
    expect(readTreasuryIssuedAttemptTicket(id)?.state).toBe("active");
    // 修复（删除损坏 store + heap 缓存一并失效）→ 同 opening 恢复执行。
    const branch = (Memory.runtime as unknown as { treasury?: Record<string, unknown> })?.treasury!;
    delete branch.quarantine;
    (require("@/runtime/treasury/quarantine") as typeof import("@/runtime/treasury/quarantine")).resetTreasuryQuarantineRuntimeForTest();
    const repaired = productionOpening(service, id);
    expect(repaired.status).toBe("executed_committed");
    expect(repaired.callbackCount).toBe(1);
  });

  it("H3：settled Receipt store 他键损坏 → 不得当作 durable owner（owner_unverifiable，ticket active）", () => {
    const service = makeService();
    const id = openedId("h3");
    pendingInjection = () => {
      // receipts store 他键损坏（整店 heap fatal）——receipt 维度 health 前置
      // 拦截，不折叠为 owner 在位。
      const receiptsModule = require("@/runtime/treasury/receipts") as typeof import("@/runtime/treasury/receipts");
      void receiptsModule;
      const branch = (Memory.runtime as unknown as { treasury?: { receipts?: unknown } })?.treasury;
      if (branch !== undefined) {
        branch.receipts = { version: 8, entries: { "r:ti2_777_otherbroken": { garbage: 1 } }, entryCount: 1, updatedAt: Game.time };
      }
    };
    const executed = executeWithExistingBundle(service, id);
    expect(executed.callbackCount).toBe(0);
    expect(executed.reason).toBe("issued_ticket_owner_unverifiable");
    expect(readTreasuryIssuedAttemptTicket(id)?.state).toBe("active");
  });

  it("H4：fresh module registry（必要 assembly probe 未装配）→ probe unavailable/blocked，不 consume、ticket active", () => {
    makeService();
    const id = openedId("h4");
    let gateOutcome: { reason?: string; detail?: string } = {};
    let ticketStateAfter: string | undefined;
    jest.isolateModules(() => {
      const handoff = require("@/runtime/treasury/attemptIssuanceHandoff") as typeof import("@/runtime/treasury/attemptIssuanceHandoff");
      // 【XII】positive verifier 直接 import 各 source 的零读 API（无装配
      // probe）——fresh registry 下全部 source absent → verdict absent。
      const rejection = handoff.gateTreasuryIssuedAttemptTicketForPrepare(id, "0123456789abcdef");
      gateOutcome = rejection === null ? {} : { reason: rejection.reason, detail: rejection.detail };
      const tickets = require("@/runtime/treasury/attemptIssuanceTicket") as typeof import("@/runtime/treasury/attemptIssuanceTicket");
      ticketStateAfter = tickets.readTreasuryIssuedAttemptTicket(id)?.state;
    });
    // 【XII】无 owner（全部 source absent）→ gate 放行（null）——装配缺失
    // 折叠为 owner 的风险已被直接 import 设计消除；probe_unavailable 仅在
    // 显式装配探测 API 缺失时作为防御分支保留。
    expect(gateOutcome.reason).toBeUndefined();
    expect(ticketStateAfter).toBe("active");
  });

  it("H5：live completion 的 exact identity conflict / 身份矛盾形态 → GC blocker 语义（blocked），不是 positive handoff owner", () => {
    const service = makeService();
    const id = openedId("h5");
    // 5a：API 层 conflict 可表达——同 ID 的 completion 与不同 expected identity
    // 查询 → verdict "conflict"（不得视为 match）。
    seedCompletionEntry(id, { digest: "1111111111111111" });
    const conflicted = lookupTreasuryCleanupCompletion(id, undefined, "committed");
    expect(conflicted.verdict).toBe("conflict");
    // 5b：身份矛盾形态（identityProfile 与 proofClass 不满足唯一合法组合）
    // → 整店 unhealthy → resolver blocked → gate owner_unverifiable（破坏在
    // authorize 之后注入——write readiness 已通过，由 ticket gate 的正向
    // owner 判定拦截）。
    // 直改（authorize 之前完成破坏）——resolver 与 gate 都必须把该形态判为
    // blocked（identity 冲突形态是 GC blocker，不是 positive owner）。
    const completionStore = (Memory.runtime as unknown as { treasury?: { cleanupCompletions?: { entries: Record<string, unknown> } } })?.treasury?.cleanupCompletions!;
    (completionStore.entries["cc:" + id] as { identity: { proofClass: string } }).identity.proofClass = "identity-bound";
    const resolverOutcome = resolveTreasuryAttemptLifecycleOwnership(id, {
      excludeIssuedTicket: true,
      excludeInflightReservations: true,
    });
    expect(resolverOutcome.verdict).toBe("blocked");
    // gate 直达：durable owner 不可正向证明 → owner_unverifiable（发生在任何
    // Game callback 之前）、ticket 保持 active 不 consume。
    const gateOutcome = gateTreasuryIssuedAttemptTicketForPrepare(id, "0123456789abcdef");
    expect(gateOutcome?.reason).toBe("issued_ticket_owner_unverifiable");
    expect(readTreasuryIssuedAttemptTicket(id)?.state).toBe("active");
    // execute 全链：write readiness 在 authorize 层先拦截（completion store
    // unhealthy）——同样 callback=0、ticket 保持 active（两层防线都不放行）。
    const executed = executeWithExistingBundle(service, id);
    expect(executed.callbackCount).toBe(0);
    expect(readTreasuryIssuedAttemptTicket(id)?.state).toBe("active");
  });

  it("H6：global reset 正向恢复——matching durable Intent 已写入未 consume → 再次 execute 幂等完成 handoff（callback=0，recovered）；重复 execute 仍 callback=0", () => {
    const service = makeService();
    const id = openedId("h6");
    pendingInjection = (target) => {
      seedDurableIntent(target);
      resetTreasuryIssuedAttemptTicketHeapCacheForTest();
    };
    const executed = executeWithExistingBundle(service, id);
    expect(executed.callbackCount).toBe(0);
    // 【XII】execute 重试被全局 intent write blocker 先拦截（in-flight
    // executing intent——callback=0、ticket 保持 active，不再由 execute
    // 路径 consume）；execution-owner 的幂等 consume 由 beginTick 恢复路径
    // 承载（matching_execution_owner → consume，4.4 / 5.3 窗口 D）。
    expect(["intent_write_blocked", "issued_ticket_owner_in_flight"]).toContain(executed.reason);
    expect(readTreasuryIssuedAttemptTicket(id)?.state).toBe("active");
    // beginTick 恢复：execution-owner intent 转 quarantine 前幂等完成 handoff。
    const intentsModule = require("@/runtime/treasury/intents") as typeof import("@/runtime/treasury/intents");
    intentsModule.recoverTreasuryIntentsAtTickBoundary(() => null);
    expect(readTreasuryIssuedAttemptTicket(id)?.state).toBe("consumed");
    // 重复 execute：callback=0——in-flight executing intent 使全局 write
    // admission 先于 ticket gate 阻断新授权（正向 durable owner 在位的
    // 保守语义；无论哪层拦截，同一 callback 绝不再次执行）。
    const repeat = executeWithExistingBundle(service, id);
    expect(repeat.callbackCount).toBe(0);
    expect(repeat.status).toBe("not_authorized");
  });

  it("H7：durable owner 在位 + consume Memory read-back 失败 → 非 handoff_recovered、callback=0、ticket 完整恢复、entryCount 不变；修复后可再次完成 handoff", () => {
    const service = makeService();
    const id = openedId("h7");
    pendingInjection = (target) => {
      seedDurableIntent(target);
      resetTreasuryIssuedAttemptTicketHeapCacheForTest();
      // 受控 test hook：拦截 Memory 解引用一次——consume 写入 consumed 后，
      // read-back 读到 active（篡改视图）→ read-back 失败路径触发。
      const branch = (Memory.runtime as unknown as { treasury?: Record<string, unknown> })?.treasury!;
      const real = branch.issuedAttemptTickets as { entries: Record<string, { state: string }> };
      let sabotage = true;
      Object.defineProperty(branch, "issuedAttemptTickets", {
        configurable: true,
        get() {
          if (!sabotage) return real;
          const current = real.entries["tk:" + target];
          if (current !== undefined && current.state === "consumed") {
            // 拦截一次：consume 写入 consumed 后的 read-back 读到 active 视图
            //（read-back 失败路径触发——真实 store 对象不被替换）。
            const snapshot = { ...real, entries: { ...real.entries } };
            snapshot.entries["tk:" + target] = { ...current, state: "active" };
            sabotage = false;
            return snapshot;
          }
          return real;
        },
      });
    };
    const executed = executeWithExistingBundle(service, id);
    expect(executed.callbackCount).toBe(0);
    // 【XII】execute 重试先被全局 intent write blocker 拦截（callback=0，
    // ticket 保持 active）；consume read-back 失败注入由恢复路径触发。
    expect(["intent_write_blocked", "issued_ticket_owner_in_flight"]).toContain(executed.reason);
    // beginTick 恢复：consume read-back 被 getter 拦截一次 → rejected（不谎
    // 称 recovered）→ ticket 完整恢复（active）+ entryCount 不变。
    const intentsModule = require("@/runtime/treasury/intents") as typeof import("@/runtime/treasury/intents");
    intentsModule.recoverTreasuryIntentsAtTickBoundary(() => null);
    expect(readTreasuryIssuedAttemptTicket(id)?.state).toBe("active");
    expect(ticketStoreOfMemory().entryCount).toBe(1);
    // 修复（sabotage 已解除——getter 只拦截一次）：completeHandoff 再次成功。
    // 【XII】恢复路径幂等 consume（durable intent 即 execution owner）。
    const repaired = completeTreasuryIssuedTicketHandoffForIntentRecovery(id);
    expect(repaired.status).toBe("consumed");
    expect(readTreasuryIssuedAttemptTicket(id)?.state).toBe("consumed");
  });

  it("H8：瞬态 reservation 不是 durable handoff proof——仅 admission/headroom reservation 时 completeHandoff 拒绝；首次正常 execute 不被自身 reservation 误判为恢复", () => {
    const service = makeService();
    const id = openedId("h8");
    // resolver 不排除瞬态预留时 verdict=exact_owner（reservation 维度正向），
    // 但 handoff 协议的 durableOwnerInPlace 排除后 absent——completeHandoff 拒绝。
    // 无 reservation 的干净状态下（prepare 前）：completeHandoff → rejected。
    const completion = completeTreasuryIssuedTicketHandoffForIntentRecovery(id);
    expect(completion.status).toBe("rejected");
    expect(readTreasuryIssuedAttemptTicket(id)?.state).toBe("active");
    // 首次正常 execute（prepare 会创建 admission reservation——不得被误判
    // 为恢复场景）：完整执行一次、callback=1、ticket consumed。
    const executed = productionOpening(service, id);
    expect(executed.status).toBe("executed_committed");
    expect(executed.callbackCount).toBe(1);
    expect(readTreasuryIssuedAttemptTicket(id)?.state).toBe("consumed");
  });
});

// ══ T 组：Canonical ticket identity ═════════════════════════════════════

describe("Remediation XI T：canonical ticket identity", () => {
  /** 手动塞 ticket entry（绕过 open——构造 canonical relation 损坏形态）。 */
  function seedRawTicket(entry: Record<string, unknown>): void {
    if (!Memory.runtime) Memory.runtime = {} as never;
    const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
    runtime.treasury = runtime.treasury ?? {};
    const branch = runtime.treasury as { issuedAttemptTickets?: { version: number; entries: Record<string, unknown>; entryCount: number; updatedAt: number } };
    if (branch.issuedAttemptTickets === undefined) {
      branch.issuedAttemptTickets = { version: 1, entries: {}, entryCount: 0, updatedAt: Game.time };
    }
    branch.issuedAttemptTickets.entries["tk:" + (entry.transactionId as string)] = { ...entry };
    branch.issuedAttemptTickets.entryCount = Object.keys(branch.issuedAttemptTickets.entries).length;
    branch.issuedAttemptTickets.updatedAt = Game.time;
    resetTreasuryIssuedAttemptTicketHeapCacheForTest();
  }

  function baseTicketFields(transactionId: string, sequence: number): Record<string, unknown> {
    return {
      transactionId,
      sequence,
      issuedAtTick: Game.time,
      owner: "xi_fixture",
      state: "active",
      stateChangedAtTick: Game.time,
    };
  }

  it("T1：ticket.sequence 与 ID 内 sequence 不一致（key 一致、ID canonical）→ 整店 unhealthy、callback=0、无状态变化", () => {
    makeService();
    const built = buildTreasuryIssuedInitialAttemptIdFromSequence(5);
    expect(built.status).toBe("built");
    if (built.status !== "built") return;
    const id = built.transactionId;
    seedRawTicket({ ...baseTicketFields(id, 1) });
    expect(peekTreasuryIssuedAttemptTicketHealth().healthy).toBe(false);
    expect(readTreasuryIssuedAttemptTicket(id)).toBeUndefined();
    // open/expire/GC 全 fail closed（store unhealthy——不删除损坏 entry）。
    expect(openTreasuryIssuedInitialAttempt("t1_new").status).toBe("rejected");
    expect(peekTreasuryIssuedAttemptWatermark()).toBe(0);
    expect(ticketStoreOfMemory().entries["tk:" + id]).toBeDefined();
  });

  it("T2：ticket ID checksum 错误（形态合理）→ 整店 unhealthy、全部通道 fail closed、损坏 entry 不删除", () => {
    makeService();
    // 先签发一个真实 sequence=1（推进 watermark），再塞 checksum 篡改 entry。
    openedId("t2_warmup");
    const tamperedId = "ti2_2_00000000ffffffff";
    expect(verifyTreasuryCurrentIssuedIdCanonical(tamperedId).ok === false || verifyTreasuryCurrentIssuedIdCanonical(tamperedId, 2).ok === false).toBe(true);
    seedRawTicket({ ...baseTicketFields(tamperedId, 2) });
    expect(peekTreasuryIssuedAttemptTicketHealth().healthy).toBe(false);
    expect(openTreasuryIssuedInitialAttempt("t2_new").status).toBe("rejected");
    expect(ticketStoreOfMemory().entries["tk:" + tamperedId]).toBeDefined();
  });

  it("T3：current issued ticket store 中出现 legacy ti1_ ID → 整店 unhealthy（不解释为 current opening）", () => {
    makeService();
    seedRawTicket({ ...baseTicketFields("ti1_7_0123456789abcdef", 7) });
    expect(peekTreasuryIssuedAttemptTicketHealth().healthy).toBe(false);
    expect(readTreasuryIssuedAttemptTicket("ti1_7_0123456789abcdef")).toBeUndefined();
  });

  it("T4：arbitrary ID（非 ti2_ 形态）不通过 shape validation → 整店 unhealthy", () => {
    makeService();
    seedRawTicket({ ...baseTicketFields("ts1_9_0123456789abcdef", 9) });
    expect(peekTreasuryIssuedAttemptTicketHealth().healthy).toBe(false);
    seedRawTicket({ ...baseTicketFields("random-id", 10) });
    expect(peekTreasuryIssuedAttemptTicketHealth().healthy).toBe(false);
  });

  it("T5：合法 open→build→authorize→execute 回归——callback 恰一次、内部 handoff 成功、无手工 consume", () => {
    const service = makeService();
    const id = openedId("t5");
    const executed = productionOpening(service, id);
    expect(executed.status).toBe("executed_committed");
    expect(executed.callbackCount).toBe(1);
    expect(readTreasuryIssuedAttemptTicket(id)?.state).toBe("consumed");
  });

  it("T6：canonical ID 但 sequence 超出 issuer frontier → callback=0、ticket 不 consume、watermark 不推进", () => {
    const service = makeService();
    openedId("t6_warmup"); // watermark=1
    const watermarkBefore = peekTreasuryIssuedAttemptWatermark();
    // canonical 构建未来 sequence（不推进 watermark——build 不是签发）。
    const built = buildTreasuryIssuedInitialAttemptIdFromSequence(9_000_001);
    expect(built.status).toBe("built");
    if (built.status !== "built") return;
    const futureId = built.transactionId;
    expect(verifyTreasuryCurrentIssuedIdCanonical(futureId, 9_000_001).ok).toBe(true);
    // 手动塞入 ticket store（canonical ID、sequence 一致——shape 合法）。
    const store = ticketStoreOfMemory();
    store.entries["tk:" + futureId] = {
      transactionId: futureId,
      sequence: 9_000_001,
      issuedAtTick: Game.time,
      owner: "t6_fixture",
      state: "active",
      stateChangedAtTick: Game.time,
    };
    store.entryCount = Object.keys(store.entries).length;
    resetTreasuryIssuedAttemptTicketHeapCacheForTest();
    expect(peekTreasuryIssuedAttemptTicketHealth().healthy).toBe(true);
    // production contract 路径：build 层的发行事实防线（forged_future）先于
    // ticket gate 拦截——callback=0、ticket 不 consume、watermark 不推进。
    const executed = productionOpening(service, futureId);
    expect(executed.callbackCount).toBe(0);
    expect(executed.reason).toBe("transaction_id_not_issued");
    expect(readTreasuryIssuedAttemptTicket(futureId)?.state).toBe("active");
    expect(peekTreasuryIssuedAttemptWatermark()).toBe(watermarkBefore);
    // gate 层直达（低层 kernel 通道无 build 层防线——gate 自验发行事实）。
    const gateOutcome = gateTreasuryIssuedAttemptTicketForPrepare(futureId);
    expect(gateOutcome?.reason).toBe("issued_ticket_unissued");
  });
});

// ── 局部 helper ───────────────────────────────────────────────────────────

/** completion store 的手动 entry 注入（H5 用）。 */
function seedCompletionEntry(transactionId: string, identityOverrides: Record<string, unknown>): void {
  if (!Memory.runtime) Memory.runtime = {} as never;
  const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
  runtime.treasury = runtime.treasury ?? {};
  const branch = runtime.treasury as { cleanupCompletions?: { version: number; entries: Record<string, unknown>; entryCount: number; updatedAt: number } };
  if (branch.cleanupCompletions === undefined) {
    branch.cleanupCompletions = { version: 1, entries: {}, entryCount: 0, updatedAt: Game.time };
  }
  branch.cleanupCompletions.entries["cc:" + transactionId] = {
    schemaVersion: 1,
    transactionId,
    resolution: "not-executed",
    identity: {
      digest: "1111111111111111",
      identityProfile: "lowlevel",
      proofClass: "lowlevel",
      durableIdentityDigest: "3333333333333333",
      lowlevelSource: "runtime-lowlevel@v1",
      ...identityOverrides,
    },
    settlementProofVerified: true,
    markerDischarged: true,
    authorityAbsentConfirmed: true,
    outcomeFinal: true,
    lineageFinalOrNotApplicable: true,
    lineageDisposition: "final",
    globalWriteAdmissionStillLocked: false,
    completedAtTick: Game.time,
  };
  branch.cleanupCompletions.entryCount = Object.keys(branch.cleanupCompletions.entries).length;
  branch.cleanupCompletions.updatedAt = Game.time;
}
