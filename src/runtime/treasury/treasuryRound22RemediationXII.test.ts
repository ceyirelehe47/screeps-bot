/**
 * 【Round 22 Remediation XII】O 组（opening-bound positive owner）与
 * P 组（pre-execution ticket transfer）固定反例 + I 组（certificate
 * issuance proof）。
 *
 * O 组验证 3.2/3.3：positive owner 绑定当前 opening 的完整 expected
 * identity（O1/O2）、全 source 聚合无 first-match（O3/O4/O6）、legacy/
 * protocol/retired 不冒充 exact（O5/O7）、absent 放行（O8）。
 * P 组验证 3.4/5.1-5.4：consume 先于 executing（P1/P2/P3）、窗口 C 的
 * not-executed 终态（P4）、execution-unknown 只在 executing 后（P5）、
 * 正常路径恰一次（P6）、可恢复 owner（P7）、同 tick 不重复（P8）。
 * I 组验证工作流 F：future canonical ID / 裸 issuer 洞 / active ticket /
 * matching terminal chain / identity 冲突 / unhealthy 零写 / reset 幂等。
 */

import { createTreasuryService } from "@/runtime/treasury/facade";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import { installRooms, type RoomSpec } from "@mock/treasury";
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
  openTreasuryIssuedInitialAttempt,
  readTreasuryIssuedAttemptTicket,
  abandonTreasuryIssuedAttemptTicketForTest,
  resetTreasuryIssuedAttemptTicketHeapCacheForTest,
  TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES,
  peekTreasuryIssuedAttemptTicketActiveCount,
} from "@/runtime/treasury/attemptIssuanceTicket";
import {
  peekTreasuryIssuedAttemptWatermark,
  peekTreasuryAttemptIssuerHealth,
  buildTreasuryIssuedInitialAttemptIdFromSequence,
} from "@/runtime/treasury/attemptIssuer";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { clearTreasuryCleanupCompletionDurableForTest } from "@/runtime/treasury/cleanupCompletionAuthority";
import { clearTreasuryCleanupSupersessionDurableForTest } from "@/runtime/treasury/cleanupSupersessionAuthority";
import { clearTreasuryChainCertificateDurableForTest } from "@/runtime/treasury/chainRetirementCertificate";
import { clearTreasuryAttemptIssuerDurableForTest } from "@/runtime/treasury/attemptIssuer";
import { clearTreasuryIssuedAttemptTicketDurableForTest } from "@/runtime/treasury/attemptIssuanceTicket";
import { clearTreasuryCompletionHeadroomReservationDurableForTest } from "@/runtime/treasury/completionHeadroomReservation";
import { resetTreasuryResolutionStoreForTest, readTreasuryResolutionTombstone, writeTreasuryResolutionTombstone } from "@/runtime/treasury/resolutionStore";
import { readTreasuryQuarantineEntryForQuery, peekTreasuryQuarantineStoreValidation } from "@/runtime/treasury/quarantine";
import { readTreasuryIntentEntry, readTreasuryIntentEntryForQuery, recoverTreasuryIntentsAtTickBoundary, resetTreasuryIntentRuntimeForTest } from "@/runtime/treasury/intents";
import {
  verifyTreasuryPositiveOwnershipForOpening,
} from "@/runtime/treasury/positiveOwnershipVerifier";
import { treasuryExactAttemptIdentityOfFacts } from "@/runtime/treasury/exactAttemptIdentity";
import { recordTreasuryChainRetirementCertificate } from "@/runtime/treasury/chainRetirementCertificate";
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
  clearTreasuryAdapterRegistryForTest();
  adaptersRegistered = false;
});

// ── 共享 fixture（与 XI 同构）──────────────────────────────────────────────

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 10_000_000 }, freeCapacity: 10_000_000 },
    terminal: { id: "term-1", resources: { energy: 10_000_000 }, freeCapacity: 10_000_000 },
  },
];

/** 【XII】adapter registry 跨 execute 保持（生产语义：registry 每 tick
 * 稳定——contractDigest 含 adapter.version，反复 register 的递增 version
 * 会使同 opening 的重试被误判 binding conflict）。beforeEach 重置。 */
let adaptersRegistered = false;
function registerAdaptersOnce(): void {
  if (adaptersRegistered) return;
  registerTreasuryActionAdapter(makeTreasuryTestTransferAdapter());
  registerTreasuryActionAdapter({
    ...makeTreasuryTestTransferAdapter(),
    kind: "terminal.send",
    semanticIdentity: "terminal.send@reconciler-semantics-v1",
  } as never);
  adaptersRegistered = true;
}

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
  options?: { readonly amount?: number; readonly outcome?: "ok" | "non-ok" | "throw" },
): SealedExecuteOutcome {
  registerAdaptersOnce();
  const built = buildTreasuryActionContract(service, {
    actionKind: "terminal.send",
    transactionId: openedTransactionId,
    args: {
      fromRoom: ROOMS[0].name, fromLocation: "storage", toRoom: ROOMS[0].name, toLocation: "terminal",
      resource: "energy", amount: options?.amount ?? 100, outcome: options?.outcome ?? "ok",
    } as never,
  });
  if (built.status === "rejected") return { callbackCount: 0, status: "prepare_rejected", reason: built.reason, detail: built.detail };
  const authorization = service.authorizeTreasuryActionContract(built.contract);
  sealTreasuryAdapterRegistryForProduction();
  try {
    if (authorization.status !== "authorized") {
      return { callbackCount: 0, status: "not_authorized", reason: authorization.reason, detail: (authorization as { detail?: string }).detail };
    }
    const result = executeTreasuryActionContract(service, { contract: built.contract, authorization: authorization.bundle }) as { status?: string; reason?: string; detail?: string };
    return {
      callbackCount: result.status === "executed_committed" ? 1 : 0,
      status: result.status ?? "unknown",
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
    };
  } finally {
    unsealTreasuryAdapterRegistryForTest();
  }
}

/** authorize 完成后、execute 前注入（中断窗口模拟）。 */
let pendingInjection: ((id: string) => void) | null = null;
function executeWithExistingBundle(service: TreasuryTestService, openedTransactionId: string): SealedExecuteOutcome {
  registerAdaptersOnce();
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
    const result = executeTreasuryActionContract(service, { contract: built.contract as never, authorization: authorization.bundle as never }) as { status?: string; reason?: string; detail?: string };
    return {
      callbackCount: result.status === "executed_committed" ? 1 : 0,
      status: result.status ?? "unknown",
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
    };
  } finally {
    unsealTreasuryAdapterRegistryForTest();
  }
}

function openedId(correlation: string): string {
  const opened = openTreasuryIssuedInitialAttempt(correlation);
  if (opened.status !== "opened") throw new Error("open rejected in fixture");
  return opened.transactionId;
}

function abandonedId(correlation: string): string {
  const id = openedId(correlation);
  if (!abandonTreasuryIssuedAttemptTicketForTest(id)) throw new Error("abandon failed");
  return id;
}

function treasuryBranch(): Record<string, unknown> {
  if (!Memory.runtime) Memory.runtime = {} as never;
  const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
  runtime.treasury = runtime.treasury ?? {};
  return runtime.treasury;
}

/** 受控 test hook：拦截 ticket Memory 解引用一次——consume 写入 consumed 后
 * read-back 读到 active 视图（read-back 失败路径，P1/P3/P7 窗口注入）。 */
function injectConsumeReadBackFailureOnce(target: string): void {
  const branch = treasuryBranch();
  const real = branch.issuedAttemptTickets as { entries: Record<string, { state: string }> };
  let sabotage = true;
  Object.defineProperty(branch, "issuedAttemptTickets", {
    configurable: true,
    get() {
      if (!sabotage) return real;
      const current = real.entries["tk:" + target];
      if (current !== undefined && current.state === "consumed") {
        const snapshot = { ...real, entries: { ...real.entries } };
        snapshot.entries["tk:" + target] = { ...current, state: "active" };
        sabotage = false;
        return snapshot;
      }
      return real;
    },
  });
}

/** 真实中断窗口（consume 失败）：intent (not_started, ready) + ticket active。 */
function interruptedBeforeConsume(service: TreasuryTestService, id: string): SealedExecuteOutcome {
  pendingInjection = (target) => {
    injectConsumeReadBackFailureOnce(target);
  };
  return executeWithExistingBundle(service, id);
}

/** verify 直调的 expected 构造（真实 opening 的 digest-only / full 视图）。 */
function digestOnlyExpected(transactionId: string, digest: string) {
  return treasuryExactAttemptIdentityOfFacts(transactionId, { digest }, "identity-bound");
}

/** raw 持久层直塞 final tombstone（resolution v7 store——API 写入形状
 * 严格，fixture 直塞等价形态；XILifecycle 同模式）。 */
function seedFinalTombstoneRaw(transactionId: string, digest: string, resolution: "committed" | "not-executed", durable: string | undefined, proofLevel: string, extra?: { readonly contractDigest?: string; readonly authorizationCohortDigest?: string; readonly lowlevelSource?: string }): void {
  const branch = treasuryBranch() as {
    resolutions?: { version: number; entries: Record<string, unknown>; entryCount: number; updatedAt: number };
  };
  if (branch.resolutions === undefined) {
    branch.resolutions = { version: 7, entries: {}, entryCount: 0, updatedAt: Game.time };
  }
  branch.resolutions.entries["r:" + transactionId] = {
    transactionId, digest, resolution, stage: "final", proofLevel,
    ...(extra?.contractDigest !== undefined ? { contractDigest: extra.contractDigest } : {}),
    ...(extra?.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: extra.authorizationCohortDigest } : {}),
    ...(extra?.lowlevelSource !== undefined ? { lowlevelSource: extra.lowlevelSource } : {}),
    ...(durable !== undefined ? { durableIdentityDigest: durable } : {}),
    actionTick: Game.time, observationTick: Game.time, resolvedAtTick: Game.time,
    reconcilerKind: "terminal.send", source: "test",
  };
  branch.resolutions.entryCount = Object.keys(branch.resolutions.entries).length;
  branch.resolutions.updatedAt = Game.time;
  resetTreasuryResolutionStoreForTest();
}

// ══ O 组：opening-bound positive owner ════════════════════════════════════

describe("Remediation XII O：opening-bound positive owner", () => {
  it("O1：same-ID 不同 opening 的 Intent（不同 digest/contract）→ identity_conflict、ticket 保持 active、callback=0、Intent B 不被 Ticket A 接管", () => {
    const service = makeService();
    const id = openedId("o1");
    // 同 ID 塞入不同 opening 的 durable intent（digest 不同——同 transactionId
    // 的其它 contract 事实）。
    const branch = treasuryBranch() as { intents?: { version: number; entries: Record<string, unknown>; entryCount: number; updatedAt: number } };
    branch.intents = branch.intents ?? { version: 7, entries: {}, entryCount: 0, updatedAt: Game.time };
    const o1Entry: Record<string, unknown> = {
      authorityLevel: "lowlevel",
      lowlevelSource: "runtime-lowlevel@v1",
      transactionId: id, digest: "aaaaaaaaaaaa0101",
      actionKind: "terminal.send", kind: "terminal.send", source: "test",
      postings: [{ roomName: ROOMS[0].name, locationKind: "storage", resource: "energy", delta: -500 }],
      outcome: "started_unknown", settlement: "executing", auditSource: "execute-prepared-action",
      createdAtTick: Game.time, updatedAtTick: Game.time,
    };
    const { recomputeTreasuryDurableIdentityDigest } = require("@/runtime/treasury/identityProof") as typeof import("@/runtime/treasury/identityProof");
    o1Entry.durableIdentityDigest = recomputeTreasuryDurableIdentityDigest(o1Entry as never) ?? "bbbbbbbbbbbbbbbb";
    branch.intents.entries["i:" + id] = o1Entry;
    branch.intents.entryCount = Object.keys(branch.intents.entries).length;
    const executed = productionOpening(service, id);
    expect(executed.callbackCount).toBe(0);
    // 【XII】不同 opening 的 owner 不得接管：digest 维度精确不等 →
    // identity_conflict（XI 时期按 transactionId 误判 exact_owner 的缺陷）。
    // execute 全链由全局 intent write blocker 先拦（fail closed——同样
    // callback=0）；identity_conflict 由 verifier 直达复验。
    expect(["issued_ticket_owner_conflict", "intent_write_blocked", "write_admission_blocked"]).toContain(executed.reason);
    const verdict = verifyTreasuryPositiveOwnershipForOpening(id, digestOnlyExpected(id, "ffffffffffff0001"));
    expect(verdict.verdict).toBe("identity_conflict");
    expect(readTreasuryIssuedAttemptTicket(id)?.state).toBe("active");
    // Intent B 未被 Ticket A 接管（原样在位）。
    expect(readTreasuryIntentEntryForQuery(id)?.digest).toBe("aaaaaaaaaaaa0101");
  });

  it("O2：contract 相同但 authorization cohort 不同 → 不得 match、callback=0、ticket 不 consume（expected 的 cohort 维度参与比较）", () => {
    // 真实中断窗口产生完整矩阵的 matching intent（contract 通道——cohort
    // 维度真实在位）；expected 携带不同的 authorizationCohortDigest →
    // relation conflict（cohort 参与比较，O2 核心）。
    const service = makeService();
    const id = openedId("o2");
    const interrupted = interruptedBeforeConsume(service, id);
    expect(interrupted.callbackCount).toBe(0);
    const intent = readTreasuryIntentEntryForQuery(id)!;
    expect(intent.authorizationCohortDigest).toBeDefined();
    const expected = treasuryExactAttemptIdentityOfFacts(id, {
      digest: intent.digest,
      ...(intent.contractDigest !== undefined ? { contractDigest: intent.contractDigest } : {}),
      // 不同 authorization cohort digest——不得 match。
      authorizationCohortDigest: "aaaaaaaaaaaaaaaa",
      durableIdentityDigest: intent.durableIdentityDigest,
    }, "identity-bound");
    const verdict = verifyTreasuryPositiveOwnershipForOpening(id, expected!);
    expect(verdict.verdict).toBe("identity_conflict");
    expect(readTreasuryIssuedAttemptTicket(id)?.state).toBe("active");
  });

  it("O3：matching Intent + 后方 historical store unhealthy → verifier store_unhealthy（前方 match 不遮蔽后方 unhealthy）", () => {
    const service = makeService();
    const id = openedId("o3");
    // 真实中断窗口产生 matching (not_started) intent。
    const interrupted = interruptedBeforeConsume(service, id);
    expect(interrupted.callbackCount).toBe(0);
    const intent = readTreasuryIntentEntryForQuery(id);
    expect(intent?.outcome).toBe("not_started");
    // 后方 source（cleanup supersession store）破坏——不相关 entry 损坏。
    const branch = treasuryBranch() as { cleanupSupersessions?: { version: number; entries: Record<string, unknown>; entryCount: number; updatedAt: number } };
    branch.cleanupSupersessions = { version: 1, entries: { "hs:ti2_999_broken": { garbage: true } }, entryCount: 1, updatedAt: Game.time };
    const { resetTreasuryCleanupSupersessionHeapCacheForTest } = require("@/runtime/treasury/cleanupSupersessionAuthority") as typeof import("@/runtime/treasury/cleanupSupersessionAuthority");
    resetTreasuryCleanupSupersessionHeapCacheForTest();
    // verifier：matching intent 在前方，后方 historical unhealthy 必须胜出
    //（聚合裁决——store_unhealthy 优先级最高）。
    const expected = treasuryExactAttemptIdentityOfFacts(id, {
      digest: intent!.digest,
      ...(intent!.contractDigest !== undefined ? { contractDigest: intent!.contractDigest } : {}),
      durableIdentityDigest: intent!.durableIdentityDigest,
    }, "identity-bound");
    const verdict = verifyTreasuryPositiveOwnershipForOpening(id, expected!);
    expect(verdict.verdict).toBe("store_unhealthy");
    expect(readTreasuryIssuedAttemptTicket(id)?.state).toBe("active");
  });

  it("O4：not-started matching Intent + opposite（committed）terminal Tombstone → outcome_conflict、不 consume、callback=0", () => {
    const service = makeService();
    const id = openedId("o4");
    const interrupted = interruptedBeforeConsume(service, id);
    expect(interrupted.callbackCount).toBe(0);
    const intent = readTreasuryIntentEntryForQuery(id)!;
    // opposite terminal tombstone：intent 声明 callback 未开始（not_started），
    // tombstone 却给出 committed 结论（矛盾）。
    seedFinalTombstoneRaw(id, intent.digest, "committed", intent.durableIdentityDigest, "identity-bound", {
      ...(intent.contractDigest !== undefined ? { contractDigest: intent.contractDigest } : {}),
      ...(intent.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: intent.authorizationCohortDigest } : {}),
    });
    const expected = treasuryExactAttemptIdentityOfFacts(id, {
      digest: intent.digest,
      ...(intent.contractDigest !== undefined ? { contractDigest: intent.contractDigest } : {}),
      ...(intent.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: intent.authorizationCohortDigest } : {}),
      durableIdentityDigest: intent.durableIdentityDigest,
    }, "identity-bound");
    const verdict = verifyTreasuryPositiveOwnershipForOpening(id, expected!);
    expect(verdict.verdict).toBe("outcome_conflict");
    expect(readTreasuryIssuedAttemptTicket(id)?.state).toBe("active");
  });

  it("O5：legacy receipt（数字 proof）在位 → insufficient（replay-only——不得成为 modern exact owner）", () => {
    const id = openedId("o5");
    const branch = treasuryBranch() as { receipts?: Record<string, unknown> };
    const { TREASURY_RECEIPT_RETENTION_TICKS } = require("@/runtime/treasury/receipts") as typeof import("@/runtime/treasury/receipts");
    branch.receipts = {
      version: 8,
      settled: { ["t:" + id]: { level: "legacy", settledAtTick: Game.time } },
      entryCount: 1,
      nextExpiryTick: Game.time + TREASURY_RECEIPT_RETENTION_TICKS + 1,
      updatedAt: Game.time,
    } as never;
    const { resetTreasuryReceiptHeapCacheForTest } = require("@/runtime/treasury/receipts") as typeof import("@/runtime/treasury/receipts");
    resetTreasuryReceiptHeapCacheForTest();
    const expected = treasuryExactAttemptIdentityOfFacts(id, { digest: "0123456789abcdef", durableIdentityDigest: "dddddddddddddddd" }, "identity-bound");
    const verdict = verifyTreasuryPositiveOwnershipForOpening(id, expected!);
    expect(verdict.verdict).toBe("insufficient");
    expect(readTreasuryIssuedAttemptTicket(id)?.state).toBe("active");
  });

  it("O6：多个 matching exact source（not-started intent + final not-executed tombstone 一致）→ matching owner（相容聚合）", () => {
    const service = makeService();
    const id = openedId("o6");
    const interrupted = interruptedBeforeConsume(service, id);
    expect(interrupted.callbackCount).toBe(0);
    const intent = readTreasuryIntentEntryForQuery(id)!;
    // not-executed final tombstone 与 not_started intent 相容（窗口 C 的目标
    // 终态——terminal 覆盖 not-started，聚合为 matching_terminal_owner）。
    seedFinalTombstoneRaw(id, intent.digest, "not-executed", intent.durableIdentityDigest, "identity-bound", {
      ...(intent.contractDigest !== undefined ? { contractDigest: intent.contractDigest } : {}),
      ...(intent.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: intent.authorizationCohortDigest } : {}),
    });
    const expected = treasuryExactAttemptIdentityOfFacts(id, {
      digest: intent.digest,
      ...(intent.contractDigest !== undefined ? { contractDigest: intent.contractDigest } : {}),
      ...(intent.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: intent.authorizationCohortDigest } : {}),
      durableIdentityDigest: intent.durableIdentityDigest,
    }, "identity-bound");
    const verdict = verifyTreasuryPositiveOwnershipForOpening(id, expected!);
    expect(verdict.verdict).toBe("matching_terminal_owner");
    if (verdict.verdict === "matching_terminal_owner") expect(verdict.terminalOutcome).toBe("not-executed");
  });

  it("O7：仅 protocol certificate / retired range 在位 → 阻断执行、不构成 exact owner、不得消费 active ticket", () => {
    const id = abandonedId("o7");
    const sequence = Number.parseInt(/ti2_(\d+)_/.exec(id)![1]!, 10);
    // retired range 吸收该序号（anti-reuse 权威在位）。
    const { absorbTreasuryRetiredSequence } = require("@/runtime/treasury/chainRetirementCertificate") as typeof import("@/runtime/treasury/chainRetirementCertificate");
    expect(absorbTreasuryRetiredSequence("current", sequence).status).toBe("absorbed");
    const expected = treasuryExactAttemptIdentityOfFacts(id, { digest: "0123456789abcdef", durableIdentityDigest: "dddddddddddddddd" }, "identity-bound");
    const verdict = verifyTreasuryPositiveOwnershipForOpening(id, expected!);
    expect(verdict.verdict).toBe("retired_only");
  });

  it("O8：全部 source absent → verdict absent（gate 放行首次 opening）", () => {
    const id = openedId("o8");
    const expected = digestOnlyExpected(id, "0123456789abcdef");
    const verdict = verifyTreasuryPositiveOwnershipForOpening(id, expected);
    expect(verdict.verdict).toBe("absent");
  });
});

// ══ P 组：pre-execution ticket transfer ═══════════════════════════════════

describe("Remediation XII P：pre-execution ticket transfer", () => {
  it("P1：consume read-back 失败 → callback=0、Intent 保持 not_started/ready（不进 executing/started_unknown）、ticket 恢复 active、无 quarantine", () => {
    const service = makeService();
    const id = openedId("p1");
    const executed = interruptedBeforeConsume(service, id);
    expect(executed.callbackCount).toBe(0);
    expect(executed.reason).toBe("issued_ticket_handoff_failed");
    // 【XII/5.2】Intent 停留在 callback_not_started（P1 的核心断言——XI 之前
    // 的顺序会留下 executing intent 并在下一 tick 转 execution-unknown）。
    const intent = readTreasuryIntentEntry(id);
    expect(intent?.outcome).toBe("not_started");
    expect(intent?.settlement).toBe("ready");
    expect(readTreasuryIssuedAttemptTicket(id)?.state).toBe("active");
    expect(readTreasuryQuarantineEntryForQuery(id)).toBeUndefined();
  });

  it("P2：P1 后推进 beginTick → 不产生 execution-unknown quarantine；同 exact opening 重试成功（恰一次 callback）", () => {
    const service = makeService();
    const id = openedId("p2");
    const first = interruptedBeforeConsume(service, id);
    expect(first.callbackCount).toBe(0);
    // beginTick：not-started intent 安全释放（窗口 B 的恢复语义——不是
    // execution-unknown）。
    const report = recoverTreasuryIntentsAtTickBoundary(() => null);
    expect(report.convertedToQuarantine).toBe(0);
    expect(report.recoveredNotExecuted).toBe(1);
    expect(readTreasuryQuarantineEntryForQuery(id)).toBeUndefined();
    // 同 exact opening 重试：ticket active（未 consume）→ 全链成功。
    const retried = productionOpening(service, id);
    expect(retried.status).toBe("executed_committed");
    expect(retried.callbackCount).toBe(1);
    expect(readTreasuryIssuedAttemptTicket(id)?.state).toBe("consumed");
  });

  it("P3：owner 写入后、consume 前 global reset（窗口 B）→ callback=0、owner 安全、ticket 不丢、恢复后同 opening 完成", () => {
    const service = makeService();
    const id = openedId("p3");
    // 中断（consume 失败）+ global reset（heap 重建）。
    const interrupted = interruptedBeforeConsume(service, id);
    expect(interrupted.callbackCount).toBe(0);
    resetTreasuryIntentRuntimeForTest();
    resetTreasuryIssuedAttemptTicketHeapCacheForTest();
    // reset 后：intent (not_started) 从 Memory 恢复、ticket 仍 active。
    expect(readTreasuryIntentEntry(id)?.outcome).toBe("not_started");
    expect(readTreasuryIssuedAttemptTicket(id)?.state).toBe("active");
    // 恢复完成：同 opening 重试成功（恰一次 callback）。
    // beginTick 恢复（global reset 后的第一 tick）：not-started owner 安全释放。
    const report = recoverTreasuryIntentsAtTickBoundary(() => null);
    expect(report.recoveredNotExecuted).toBe(1);
    expect(readTreasuryQuarantineEntryForQuery(id)).toBeUndefined();
    // 恢复完成：同 opening 重试成功（恰一次 callback）。
    const retried = productionOpening(service, id);
    expect(retried.callbackCount).toBe(1);
    expect(readTreasuryIssuedAttemptTicket(id)?.state).toBe("consumed");
  });

  it("P4：consume 后、executing 前中断（窗口 C）→ beginTick 明确 not-executed 释放、不进 quarantine、同 ID 不可再次执行", () => {
    const service = makeService();
    const id = openedId("p4");
    // 真实中断产生合法 (not_started, ready) intent（consume 失败回滚）；
    // 持久层直改 ticket state=consumed 模拟"consume 成功而 executing 未
    // 持久化"的窗口 C。
    const interrupted = interruptedBeforeConsume(service, id);
    expect(interrupted.callbackCount).toBe(0);
    const ticketStore = treasuryBranch().issuedAttemptTickets as { entries: Record<string, { state: string }> };
    (ticketStore.entries["tk:" + id] as { state: string }).state = "consumed";
    resetTreasuryIssuedAttemptTicketHeapCacheForTest();
    expect(readTreasuryIntentEntry(id)?.outcome).toBe("not_started");
    // beginTick：明确 not-executed 释放（不进 execution-unknown quarantine）。
    const report = recoverTreasuryIntentsAtTickBoundary(() => null);
    expect(report.recoveredNotExecuted).toBe(1);
    expect(report.convertedToQuarantine).toBe(0);
    expect(readTreasuryQuarantineEntryForQuery(id)).toBeUndefined();
    // 同 ID 不可再次执行：ticket 已 consumed 且无 execution owner（P4 核心
    // ——窗口 C 的终态是 not-executed，不是可重开）。
    const replay = productionOpening(service, id);
    expect(replay.callbackCount).toBe(0);
    expect(replay.status).not.toBe("executed_committed");
  });

  it("P5：executing 后、callback 前（callback throw）→ execution-unknown quarantine 事实完整、同 ID callback 不重复", () => {
    const service = makeService();
    const id = openedId("p5");
    expect(() => productionOpening(service, id, { outcome: "throw" })).toThrow();
    // execution-unknown 保守权威在位（窗口 D 语义保留）。
    expect(readTreasuryQuarantineEntryForQuery(id)).toBeDefined();
    // 同 ID 重试：quarantine write blocker 先拦（callback 不重复）。
    const replay = productionOpening(service, id);
    expect(replay.callbackCount).toBe(0);
    expect(replay.status).not.toBe("executed_committed");
  });

  it("P6：正常路径全链 → callback 恰一次、ticket consumed、无残留 not-started owner、无虚假 quarantine", () => {
    const service = makeService();
    const id = openedId("p6");
    const executed = productionOpening(service, id);
    expect(executed.status).toBe("executed_committed");
    expect(executed.callbackCount).toBe(1);
    expect(readTreasuryIssuedAttemptTicket(id)?.state).toBe("consumed");
    // committed 后 intent 已释放（无残留 not-started owner）。
    expect(readTreasuryIntentEntryForQuery(id)).toBeUndefined();
    expect(readTreasuryQuarantineEntryForQuery(id)).toBeUndefined();
  });

  it("P7：consume 失败 + 后续恢复 → 结构化可恢复 owner、beginTick 释放计数、无 reservation 泄漏", () => {
    const service = makeService();
    const id = openedId("p7");
    const interrupted = interruptedBeforeConsume(service, id);
    expect(interrupted.callbackCount).toBe(0);
    // owner（not_started intent）结构化在位——恢复路径可识别。
    expect(readTreasuryIntentEntryForQuery(id)?.settlement).toBe("ready");
    // beginTick 恢复：recoveredNotExecuted 精确计数（不谎报、不遗漏）。
    const report = recoverTreasuryIntentsAtTickBoundary(() => null);
    expect(report.recoveredNotExecuted).toBe(1);
    expect(readTreasuryIntentEntryForQuery(id)).toBeUndefined();
    // 无 reservation 泄漏（headroom/admission 均已释放——handle 终态化）。
    const { peekTreasuryCompletionHeadroomReservationHealth } = require("@/runtime/treasury/completionHeadroomReservation") as typeof import("@/runtime/treasury/completionHeadroomReservation");
    expect(peekTreasuryCompletionHeadroomReservationHealth().healthy).toBe(true);
  });

  it("P8：同 tick 重复 execute（首次成功后）→ callback 总数最多 1（ready/executing intent 不被误判为已执行 owner）", () => {
    const service = makeService();
    const id = openedId("p8");
    const first = executeWithExistingBundle(service, id);
    expect(first.status).toBe("executed_committed");
    expect(first.callbackCount).toBe(1);
    // 同 tick 重复 execute：terminal owner 在位（receipt）→ owner_in_flight
    // 或 write admission 拒绝——无论哪层拦截，callback 恒 0。
    const second = executeWithExistingBundle(service, id);
    expect(second.callbackCount).toBe(0);
    expect(second.status).not.toBe("executed_committed");
  });
});

// ══ I 组：certificate issuance proof ══════════════════════════════════════

describe("Remediation XII I：certificate issuance proof", () => {
  /** 真实压缩链（与 XILifecycle 的 seedChain 同构——quarantine seed →
   * lineage record → final tombstone → quarantine release → converge →
   * compact；summary + certificate 均由 compaction 正牌写入）。 */
  const RUNTIME = "runtime-lowlevel@v1";
  const DIGEST = "0123456789abc001";
  function seedChainForI(tag: string): { root: string; lineageId: string } {
    const root = abandonedId(tag);
    const { quarantineTreasuryTransaction, releaseTreasuryQuarantineEntry, readTreasuryQuarantineEntryForQuery: readQ } = require("@/runtime/treasury/quarantine") as typeof import("@/runtime/treasury/quarantine");
    const write = quarantineTreasuryTransaction({
      transactionId: root,
      authorityLevel: "lowlevel",
      lowlevelSource: RUNTIME,
      digest: DIGEST,
      tick: Game.time,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      adapterSemanticIdentity: "terminal.send@reconciler-semantics-v1",
      phase: "ok_pending_commit_unresolved",
      outcome: "returned_ok",
      settlement: "quarantined",
      deltas: [{ roomName: ROOMS[0].name, locationKind: "storage" as const, resource: "energy" as const, delta: -500 }],
      recordedAt: Game.time,
    } as never);
    if (write.status !== "written") throw new Error("quarantine seed rejected: " + JSON.stringify(write).slice(0, 200));
    const durable = readQ(root)?.durableIdentityDigest;
    if (durable === undefined) throw new Error("durable missing");
    const { createTreasuryAttemptLineageRecord, convergeTreasuryLineageRetirementFromFacts } = require("@/runtime/treasury/attemptLineage") as typeof import("@/runtime/treasury/attemptLineage");
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: root,
      rootIdentity: { digest: DIGEST, durableIdentityDigest: durable, lowlevelSource: RUNTIME },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: RUNTIME,
      rearmable: false,
      identityProfile: "lowlevel",
      nonRearmReason: "xii i-fixture",
    } as never);
    if (created.status !== "written") throw new Error("lineage seed rejected: " + JSON.stringify(created).slice(0, 200));
    const lineageId = created.record.lineageId;
    seedFinalTombstoneRaw(root, DIGEST, "not-executed", durable, "lowlevel", { lowlevelSource: RUNTIME });
    if (releaseTreasuryQuarantineEntry(root) !== true) throw new Error("quarantine release failed");
    const converged = convergeTreasuryLineageRetirementFromFacts(lineageId);
    if (converged.status !== "completed") throw new Error("fixture converge pending: " + JSON.stringify(converged).slice(0, 300));
    const { compactTreasuryTerminalLineage } = require("@/runtime/treasury/lineageRetirementSummary") as typeof import("@/runtime/treasury/lineageRetirementSummary");
    const compacted = compactTreasuryTerminalLineage(lineageId);
    if (compacted.status === "rejected") throw new Error("compaction rejected: " + JSON.stringify(compacted).slice(0, 300));
    return { root, lineageId };
  }

  it("I1：issuer watermark=0 时纯构造 ti2_100 → certificate 拒绝（future canonical ID 不构成发行事实）、range 不变化", () => {
    makeService();
    const before = JSON.stringify((treasuryBranch().retiredAttemptRanges ?? null) as unknown);
    const built = buildTreasuryIssuedInitialAttemptIdFromSequence(100);
    if (built.status !== "built") throw new Error("build rejected");
    const result = recordTreasuryChainRetirementCertificate({
      lineageId: "00000000000000i1", rootTransactionId: built.transactionId,
      finalAttemptId: built.transactionId, finalGeneration: 0, terminalState: "non_rearmable_retired",
    });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.detail).toContain("watermark");
    expect(JSON.stringify((treasuryBranch().retiredAttemptRanges ?? null) as unknown)).toBe(before);
  });

  it("I2：sequence ≤ watermark 但无 terminal lifecycle authority（裸 issuer 洞）→ certificate 拒绝（watermark 不足以证明 terminal lifecycle）", () => {
    makeService();
    const root = abandonedId("i2"); // 真实 mint（watermark 覆盖）但无 lineage/summary
    const result = recordTreasuryChainRetirementCertificate({
      lineageId: "00000000000000i2", rootTransactionId: root,
      finalAttemptId: root, finalGeneration: 0, terminalState: "non_rearmable_retired",
    });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.detail).toContain("terminal retirement summary");
  });

  it("I3：root 的 issued ticket 仍 active → 不得写 terminal certificate", () => {
    makeService();
    const root = openedId("i3"); // ticket 保持 active（未 abandon）
    // 注入 matching summary（ticket 检查在 summary 之后——需要 summary 先在位；
    // 用最小 v2 replay archive 直写会 fail closed……改为复用 I 组 compacted
    // 链后回填 active ticket 验证顺序：ticket active 的 root 直接拒）。
    const result = recordTreasuryChainRetirementCertificate({
      lineageId: "00000000000000i3", rootTransactionId: root,
      finalAttemptId: root, finalGeneration: 0, terminalState: "non_rearmable_retired",
    });
    // 无 summary 先拒（I2 语义）——active ticket 分支由 I3b 的真实链验证。
    expect(result.status).toBe("rejected");
  });

  it("I3b：真实压缩链 root 的 ticket 回填 active → certificate 写入拒绝（active ticket 分支）", () => {
    makeService();
    const chain = seedChainForI("i3b");
    // compaction 已写 certificate（幂等链）——把 root ticket 回填 active 后
    // 重放同 identity record → active ticket 分支拒绝。
    const ticketStore = treasuryBranch().issuedAttemptTickets as { entries: Record<string, Record<string, unknown>> };
    const sequence = Number.parseInt(/ti2_(\d+)_/.exec(chain.root)![1]!, 10);
    ticketStore.entries["tk:" + chain.root] = {
      transactionId: chain.root,
      sequence,
      issuedAtTick: Game.time,
      owner: "i3b-fixture",
      state: "active",
      stateChangedAtTick: Game.time,
    };
    resetTreasuryIssuedAttemptTicketHeapCacheForTest();
    const result = recordTreasuryChainRetirementCertificate({
      lineageId: chain.lineageId, rootTransactionId: chain.root,
      finalAttemptId: chain.root, finalGeneration: 0, terminalState: "non_rearmable_retired",
    });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.detail).toContain("active");
  });

  it("I4：matching terminal lifecycle（真实压缩链）→ certificate 写入成功、read-back 成功、root/lineage/finalGeneration 一致", () => {
    makeService();
    const chain = seedChainForI("i4");
    const { lookupTreasuryChainRetirementCertificate } = require("@/runtime/treasury/chainRetirementCertificate") as typeof import("@/runtime/treasury/chainRetirementCertificate");
    const certificate = lookupTreasuryChainRetirementCertificate(chain.root);
    expect(certificate).toBeDefined();
    expect(certificate!.rootTransactionId).toBe(chain.root);
    expect(certificate!.finalGeneration).toBe(0);
    expect(certificate!.terminalState).toBe("non_rearmable_retired");
  });

  it("I5：lifecycle identity 冲突（terminalState 相反的 candidate）→ certificate 拒绝、不覆盖旧 certificate", () => {
    makeService();
    const chain = seedChainForI("i5");
    const result = recordTreasuryChainRetirementCertificate({
      lineageId: chain.lineageId, rootTransactionId: chain.root,
      finalAttemptId: chain.root, finalGeneration: 0,
      terminalState: "chain_committed", // 与 summary 的 non_rearmable 相反
    });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.detail).toContain("terminalState");
    // 旧 certificate 未被覆盖。
    const { lookupTreasuryChainRetirementCertificate } = require("@/runtime/treasury/chainRetirementCertificate") as typeof import("@/runtime/treasury/chainRetirementCertificate");
    expect(lookupTreasuryChainRetirementCertificate(chain.root)?.terminalState).toBe("non_rearmable_retired");
  });

  it("I6：summary store unhealthy → certificate 零写（fail closed）", () => {
    makeService();
    const root = abandonedId("i6");
    // summary store 损坏（他键 entry 非法 → 整店 fail closed）。
    const branch = treasuryBranch() as { lineageRetirementSummaries?: { version: number; entries: Record<string, unknown>; entryCount: number; updatedAt: number } };
    branch.lineageRetirementSummaries = { version: 3, entries: { "rs:broken_root": { garbage: 1 } }, entryCount: 1, updatedAt: Game.time };
    const { resetTreasuryRetirementSummaryRuntimeForTest } = require("@/runtime/treasury/lineageRetirementSummary") as typeof import("@/runtime/treasury/lineageRetirementSummary");
    resetTreasuryRetirementSummaryRuntimeForTest();
    const certificateBefore = JSON.stringify((treasuryBranch().chainRetirementCertificates ?? null) as unknown);
    const result = recordTreasuryChainRetirementCertificate({
      lineageId: "00000000000000i6", rootTransactionId: root,
      finalAttemptId: root, finalGeneration: 0, terminalState: "non_rearmable_retired",
    });
    expect(result.status).toBe("rejected");
    expect(JSON.stringify((treasuryBranch().chainRetirementCertificates ?? null) as unknown)).toBe(certificateBefore);
  });

  it("I7：global reset 后 compaction 幂等重放 → 只写一条 certificate（不产生重复/未来 certificate）", () => {
    makeService();
    const chain = seedChainForI("i7");
    const { lookupTreasuryChainRetirementCertificate, peekTreasuryChainCertificateEntryCount } = require("@/runtime/treasury/chainRetirementCertificate") as typeof import("@/runtime/treasury/chainRetirementCertificate");
    expect(peekTreasuryChainCertificateEntryCount()).toBe(1);
    const before = JSON.stringify(treasuryBranch().chainRetirementCertificates);
    // global reset（heap 重建）。
    const { resetTreasuryChainCertificateHeapCacheForTest } = require("@/runtime/treasury/chainRetirementCertificate") as typeof import("@/runtime/treasury/chainRetirementCertificate");
    resetTreasuryChainCertificateHeapCacheForTest();
    // 同 identity record 幂等重放（terminal authority 在位）。
    const replay = recordTreasuryChainRetirementCertificate({
      lineageId: chain.lineageId, rootTransactionId: chain.root,
      finalAttemptId: chain.root, finalGeneration: 0, terminalState: "non_rearmable_retired",
    });
    expect(replay.status).toBe("idempotent");
    expect(peekTreasuryChainCertificateEntryCount()).toBe(1);
    expect(JSON.stringify(treasuryBranch().chainRetirementCertificates)).toBe(before);
  });
});
