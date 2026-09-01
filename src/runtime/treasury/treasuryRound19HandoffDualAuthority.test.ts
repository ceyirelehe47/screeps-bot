/**
 * 【第十九轮】handoff 双 authority 恢复测试（任务 25.3/25.9）。
 *
 * 覆盖（工作包 B）：
 * - child_intent_pending 恢复始终检查 intent 与 quarantine 两个 store；
 * - intent ready + quarantine 匹配并存（转移中断窗口）→ forward_complete
 *   绝不回滚（quarantine 是 callback 后写入的 durable 事实）；
 * - intent ready/executing + quarantine proof 冲突 → forensic（保留全部
 *   authority）；
 * - intent executing + quarantine 匹配 → forward_complete；
 * - forward 的 child identity 从验证后的持久事实派生（quarantine 优先）；
 * - 无 quarantine 的 ready intent → rollback（回归——正常窗口）。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import {
  makeTreasuryTestTransferAdapter,
  replaceTreasuryActionAdapterForTest,
  resetTreasuryTestAdapterSideEffectsForTest,
} from "@/runtime/treasury/actionContracts";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { readTreasuryQuarantineEntry, resetTreasuryQuarantineRuntimeForTest } from "@/runtime/treasury/quarantine";
import { readTreasuryIntentEntry, writeTreasuryIntentEntry } from "@/runtime/treasury/intents";
import {
  lookupTreasuryAttemptLineageByAttemptId,
  readTreasuryAttemptLineageRecord,
  stageTreasuryLineageChildIntentPending,
} from "@/runtime/treasury/attemptLineage";
import { setTreasuryCommitFaultInjectorForTest } from "@/runtime/treasury/writeFault";
import { registerTreasuryPolicyResolver, makeFixedReserveTreasuryPolicy } from "@/runtime/treasury/policyAuthority";
import { recomputeTreasuryDurableIdentityDigest } from "@/runtime/treasury/identityProof";
import { installRooms, type RoomSpec } from "@mock/treasury";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import type { TreasuryTransactionInput } from "@/runtime/treasury/types";

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

function freshInput(service: TreasuryTestService, transactionId: string): TreasuryTransactionInput {
  const epoch = service.observation().epoch;
  return {
    transactionId,
    kind: "terminal.send",
    source: "test",
    decision: { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick },
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
  };
}

function advanceTick(): TreasuryTestService {
  Game.time += 1;
  return makeService();
}

function resolveNotExecuted(service: TreasuryTestService, transactionId: string) {
  const issued = service.issueTreasuryReconciliationCapability({ transactionId });
  if (issued.status !== "issued") return issued;
  return service.resolveUnresolvedTransaction({ transactionId, capability: issued.capability });
}

/** 手工构造 child_intent_pending + 指定 intent 状态（真实中断窗口模拟）。 */
function stagePendingWithIntent(
  parentTransactionId: string,
  intentOverrides?: { readonly ready?: boolean },
): { readonly childId: string; readonly lineageId: string } {
  const service = makeService();
  const executed = service.executePreparedAction(freshInput(service, parentTransactionId), () => {
    service.endTick();
    return { ok: false as const };
  });
  expect(executed.status).toBe("executed_abort_failed");
  const next = advanceTick();
  expect(resolveNotExecuted(next, parentTransactionId).status).toBe("resolved");
  const issued = next.issueTreasuryRearmCapability({ parentTransactionId });
  expect(issued.status).toBe("issued");
  if (issued.status !== "issued") throw new Error("unreachable");
  const record = lookupTreasuryAttemptLineageByAttemptId(parentTransactionId)!;
  expect(stageTreasuryLineageChildIntentPending(record.lineageId, issued.childTransactionId).status).not.toBe("rejected");
  const pending = readTreasuryAttemptLineageRecord(record.lineageId)!;
  const intentFacts = {
    transactionId: issued.childTransactionId,
    digest: "aaaaaaaaaaaaaaaa",
    actionKind: "terminal.send",
    kind: "terminal.send",
    source: "test",
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
    lowlevelSource: "runtime-lowlevel@v1",
    lineageId: pending.lineageId,
    lineageGeneration: pending.generation + 1,
    parentTransactionId: parentTransactionId,
    lineageBindingDigest: pending.pendingBindingDigest!,
  };
  // 低层双存在归一要求 intent 与 quarantine 的 durableIdentityDigest 完整
  // 相等（生产低层 intent 由 facade 写入时携带；fixture 按同一权威重算）。
  const intentDurable = recomputeTreasuryDurableIdentityDigest(intentFacts as never) ?? undefined;
  const intentWrite = writeTreasuryIntentEntry({
    authorityLevel: "lowlevel",
    lowlevelSource: "runtime-lowlevel@v1",
    transactionId: issued.childTransactionId,
    digest: "aaaaaaaaaaaaaaaa",
    actionKind: "terminal.send",
    kind: "terminal.send",
    source: "test",
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
    durableIdentityDigest: intentDurable,
    outcome: intentOverrides?.ready === true ? "not_started" : "started_unknown",
    settlement: intentOverrides?.ready === true ? "ready" : "executing",
    auditSource: "test",
    lineageId: pending.lineageId,
    lineageGeneration: pending.generation + 1,
    parentTransactionId: parentTransactionId,
    lineageBindingDigest: pending.pendingBindingDigest!,
    createdAtTick: Game.time,
    updatedAtTick: Game.time,
  });
  expect(intentWrite.status).not.toBe("rejected");
  return { childId: issued.childTransactionId, lineageId: record.lineageId };
}

/** 手塞 quarantine entry（proof 匹配或冲突形态；durableIdentityDigest 真实重算）。 */
function seedQuarantine(childId: string, lineageId: string, generation: number, parent: string, binding: string): void {
  Memory.runtime = Memory.runtime ?? {};
  const treasury = (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury ?? {};
  (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury = treasury;
  const entry: Record<string, unknown> = {
    transactionId: childId,
    digest: "aaaaaaaaaaaaaaaa",
    kind: "terminal.send",
    actionKind: "terminal.send",
    source: "test",
    deltas: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
    phase: "action_threw_execution_unknown",
    outcome: "started_unknown",
    settlement: "quarantined",
    tick: Game.time,
    recordedAt: Game.time,
    authorityLevel: "lowlevel",
    lowlevelSource: "runtime-lowlevel@v1",
    lineageId,
    lineageGeneration: generation,
    parentTransactionId: parent,
    lineageBindingDigest: binding,
  };
  entry.durableIdentityDigest = recomputeTreasuryDurableIdentityDigest(entry as never) ?? undefined;
  treasury.quarantine = {
    version: 6,
    entries: { [`q:${childId}`]: entry },
    entryCount: 1,
    updatedAt: Game.time,
  };
  // 手塞替换 Memory store 对象后清 heap 缓存（下一读取重新 load 校验）。
  resetTreasuryQuarantineRuntimeForTest();
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  setTreasuryCommitFaultInjectorForTest(null);
  resetTreasuryTestAdapterSideEffectsForTest();
  registerTreasuryPolicyResolver(makeFixedReserveTreasuryPolicy(1_000));
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter("observed_not_executed"));
  replaceTreasuryActionAdapterForTest({
    ...makeTreasuryTestTransferAdapter(),
    kind: "terminal.send",
    semanticIdentity: "terminal.send@reconciler-semantics-v1",
    reconcile: () => "observed_not_executed",
  });
});

afterEach(() => {
  setTreasuryCommitFaultInjectorForTest(null);
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
});

describe("child handoff 双 authority 恢复矩阵（第十九轮 25.3）", () => {
  it("intent ready + quarantine 匹配并存：【第二十轮】execution facts 矛盾（not_started vs started_unknown）→ forensic——绝不回滚、绝不 forward", () => {
    const parent = "r19_hda_ready_q";
    const { childId, lineageId } = stagePendingWithIntent(parent, { ready: true });
    const pending = readTreasuryAttemptLineageRecord(lineageId)!;
    seedQuarantine(childId, pending.lineageId, pending.generation + 1, parent, pending.pendingBindingDigest!);
    advanceTick();
    const record = readTreasuryAttemptLineageRecord(lineageId);
    // 【第二十轮 7.5】ready intent（not_started）与 quarantine（started_
    // unknown——callback 后事实）的 execution facts 互相矛盾：unified
    // resolver 的 cohesion 矩阵判 inconsistent → forensic 隔离（保留全部
    // authority——不猜测、不回滚、不前向）。真实转移中断窗口（intent 已
    // executing + quarantine 匹配）的 forward 由下方 executing 场景承载。
    expect(record?.state).toBe("forensic_isolated");
    // ready intent 可能被通用 intent recovery（Round 16 语义：无 proof 的
    // not_started intent 回收）先行释放——authority 由 quarantine 权威形态
    // 保留（forward 分支本身不释放）。
    expect(readTreasuryQuarantineEntry(childId)).toBeDefined();
  });

  it("intent ready + quarantine proof 冲突：forensic 隔离（intent 存在时同样验证 quarantine——authority 保留）", () => {
    const parent = "r19_hda_ready_c";
    const { childId, lineageId } = stagePendingWithIntent(parent, { ready: true });
    const pending = readTreasuryAttemptLineageRecord(lineageId)!;
    // binding 不同的合法 proof（各自 durableIdentityDigest 重算一致）。
    seedQuarantine(childId, pending.lineageId, pending.generation + 1, parent, "0123456789abcdef");
    advanceTick();
    const record = readTreasuryAttemptLineageRecord(lineageId);
    expect(record?.state).toBe("forensic_isolated");
    // 权威形态保留（quarantine 的冲突证据是 forensic 依据；ready intent 由
    // 通用 intent recovery 承载其自身回收语义）。
    expect(readTreasuryQuarantineEntry(childId)).toBeDefined();
  });

  it("intent executing + quarantine 匹配（转移写成功、intent 删除前中断）：forward_complete", () => {
    const parent = "r19_hda_exec_q";
    const { childId, lineageId } = stagePendingWithIntent(parent, { ready: false });
    const pending = readTreasuryAttemptLineageRecord(lineageId)!;
    seedQuarantine(childId, pending.lineageId, pending.generation + 1, parent, pending.pendingBindingDigest!);
    advanceTick();
    const record = readTreasuryAttemptLineageRecord(lineageId);
    expect(record?.state).toBe("child_active");
    expect(record?.generation).toBe(pending.generation + 1);
    expect(record?.bindingDigest).toBe(pending.pendingBindingDigest);
  });

  it("intent executing + quarantine proof 冲突：forensic（不因 intent 非 ready 而放行）", () => {
    const parent = "r19_hda_exec_c";
    const { childId, lineageId } = stagePendingWithIntent(parent, { ready: false });
    const pending = readTreasuryAttemptLineageRecord(lineageId)!;
    seedQuarantine(childId, pending.lineageId, pending.generation + 1, parent, "0123456789abcdef");
    advanceTick();
    expect(readTreasuryAttemptLineageRecord(lineageId)?.state).toBe("forensic_isolated");
  });

  it("quarantine generation 冲突（+1 之外的代）：forensic", () => {
    const parent = "r19_hda_gen_c";
    const { childId, lineageId } = stagePendingWithIntent(parent, { ready: false });
    const pending = readTreasuryAttemptLineageRecord(lineageId)!;
    seedQuarantine(childId, pending.lineageId, pending.generation + 5, parent, "0123456789abcdef");
    advanceTick();
    expect(readTreasuryAttemptLineageRecord(lineageId)?.state).toBe("forensic_isolated");
  });

  it("forward 的 child identity 从 quarantine（匹配侧）派生：currentIdentity 与 quarantine facts 一致", () => {
    const parent = "r19_hda_ident";
    const { childId, lineageId } = stagePendingWithIntent(parent, { ready: false });
    const pending = readTreasuryAttemptLineageRecord(lineageId)!;
    seedQuarantine(childId, pending.lineageId, pending.generation + 1, parent, pending.pendingBindingDigest!);
    advanceTick();
    const record = readTreasuryAttemptLineageRecord(lineageId)!;
    expect(record.state).toBe("child_active");
    const quarantine = readTreasuryQuarantineEntry(childId)!;
    expect(record.currentIdentity.digest).toBe(quarantine.digest);
    expect(record.currentIdentity.durableIdentityDigest).toBe(quarantine.durableIdentityDigest);
  });

  it("intent ready 且无任何 quarantine：rollback + 释放 intent（回归——正常窗口不受影响）", () => {
    const parent = "r19_hda_ready_only";
    const { childId, lineageId } = stagePendingWithIntent(parent, { ready: true });
    advanceTick();
    expect(readTreasuryAttemptLineageRecord(lineageId)?.state).toBe("rearm_ready");
    expect(readTreasuryIntentEntry(childId)).toBeUndefined();
    expect(readTreasuryQuarantineEntry(childId)).toBeUndefined();
  });

  it("intent 缺失 + quarantine 匹配：forward_complete（回归——转移完成形态）", () => {
    const parent = "r19_hda_q_only";
    const { childId, lineageId } = stagePendingWithIntent(parent, { ready: true });
    // 删除 intent（转移完成后形态——只留 quarantine）。
    (Memory.runtime!.treasury!.intents!.entries as Record<string, unknown>)["i:" + childId] = undefined;
    delete (Memory.runtime!.treasury!.intents!.entries as Record<string, unknown>)["i:" + childId];
    Memory.runtime!.treasury!.intents!.entryCount = Object.keys(Memory.runtime!.treasury!.intents!.entries).length;
    const pending = readTreasuryAttemptLineageRecord(lineageId)!;
    seedQuarantine(childId, pending.lineageId, pending.generation + 1, parent, pending.pendingBindingDigest!);
    advanceTick();
    expect(readTreasuryAttemptLineageRecord(lineageId)?.state).toBe("child_active");
  });
});
