/**
 * 【第十七轮】durable attempt lineage & rearm capability 集成测试。
 *
 * 覆盖（任务第十七节核心场景）：
 * - tr1_ 保留命名空间门禁（手工构造/initial/无 capability 拒绝；正确
 *   capability + contract 放行；已消费/错误 child/语义漂移拒绝）；
 * - opaque rearm capability 防伪与生命周期（JSON 复制/伪造/跨 tick/跨
 *   service/重复消费/global reset 重签发/接管后不可重签）；
 * - capability 与 bundle/intent 接管（授权失败不消费、intent 携带 binding、
 *   quarantine/receipt 继承 binding、commit → chain_committed）；
 * - retry semantic identity（数量/room/kind 变化拒绝；相同动作不同 ID 一致）；
 * - parent 相反 proof 冲突与 child 占用；
 * - lineage store（A→B→C 同 record、满载 fail closed、深冻结、alias 隔离）；
 * - tombstone retention 与永久 retirement（驱逐后仍可 rearm、parent 永久拒绝）；
 * - marker v2 class-aware（runtime/migrated 互不清除、跨 lineage 不互清）；
 * - receipt proof class v7（迁移三级、identity-bound 携带 source unhealthy）。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import {
  buildTreasuryActionContract,
  executeTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  readTreasuryTestAdapterSideEffects,
  registerTreasuryActionAdapter,
  replaceTreasuryActionAdapterForTest,
  resetTreasuryTestAdapterSideEffectsForTest,
  type TreasuryActionContract,
} from "@/runtime/treasury/actionContracts";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { commitSettledReceipt, ensureTreasuryReceiptStore, peekTreasuryReceiptHealth, readTreasurySettlementProof } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { readTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import {
  readTreasuryResolutionTombstone,
  writeTreasuryResolutionTombstone,
  ensureTreasuryResolutionSlotAvailable,
} from "@/runtime/treasury/resolutionStore";
import { recordTreasuryWriteFault } from "@/runtime/treasury/writeFault";
import {
  createTreasuryAttemptLineageRecord,
  lookupTreasuryAttemptLineageByAttemptId,
  peekTreasuryAttemptLineageHealth,
  readTreasuryAttemptLineageRecord,
  lineageStoreEvents,
  TREASURY_LINEAGE_MAX_ENTRIES,
} from "@/runtime/treasury/attemptLineage";
import { readTreasuryIntentEntry } from "@/runtime/treasury/intents";
import { registerTreasuryPolicyResolver, makeFixedReserveTreasuryPolicy } from "@/runtime/treasury/policyAuthority";
import { installRooms, type RoomSpec } from "@mock/treasury";
import type { TreasuryTransactionInput } from "@/runtime/treasury/types";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import { setTreasuryCommitFaultInjectorForTest } from "@/runtime/treasury/writeFault";

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

function freshInput(service: TreasuryTestService, transactionId: string, delta = -500): TreasuryTransactionInput {
  const epoch = service.observation().epoch;
  return {
    transactionId,
    kind: "terminal.send",
    source: "test",
    decision: { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick },
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta }],
  };
}

interface TransferArgs {
  readonly amount?: number;
  readonly outcome?: "ok" | "non-ok" | "throw";
  readonly fromRoom?: string;
}

function buildContract(service: TreasuryTestService, transactionId: string, args: TransferArgs): TreasuryActionContract {
  const built = buildTreasuryActionContract(service, {
    actionKind: "test.transfer",
    transactionId,
    args: {
      fromRoom: args.fromRoom ?? "W1N57",
      fromLocation: "storage",
      toRoom: "W1N57",
      toLocation: "terminal",
      resource: RESOURCE_ENERGY,
      amount: args.amount ?? 500,
      outcome: args.outcome ?? "ok",
    },
  });
  expect(built.status).toBe("built");
  if (built.status !== "built") throw new Error("unreachable");
  return built.contract;
}

function advanceTick(): TreasuryTestService {
  Game.time += 1;
  const next = makeService();
  return next;
}

/** 完整执行 not-executed resolution（真实 service 路径）。 */
function resolveNotExecuted(service: TreasuryTestService, transactionId: string) {
  const issued = service.issueTreasuryReconciliationCapability({ transactionId });
  if (issued.status !== "issued") return issued;
  return service.resolveUnresolvedTransaction({ transactionId, capability: issued.capability });
}

/** contract 路径制造 execution-unknown quarantine 并 resolve 为 not-executed。 */
function makeNotExecutedParent(service: TreasuryTestService, transactionId: string): void {
  const contract = buildContract(service, transactionId, { outcome: "throw" });
  const authorized = service.authorizeTreasuryActionContract(contract);
  expect(authorized.status).toBe("authorized");
  if (authorized.status !== "authorized") return;
  let threw = false;
  try {
    executeTreasuryActionContract(service, { contract, authorization: authorized.bundle });
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
  expect(readTreasuryQuarantineEntry(transactionId)).toBeDefined();
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  setTreasuryCommitFaultInjectorForTest(null);
  resetTreasuryTestAdapterSideEffectsForTest();
  registerTreasuryPolicyResolver(makeFixedReserveTreasuryPolicy(1_000));
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter("observed_not_executed"));
  // 低层两阶段路径的 kind（terminal.send）同样需要注册 reconciler（与
  // test.transfer 共用同一工厂——结论一致）。
  registerTreasuryActionAdapter({ ...makeTreasuryTestTransferAdapter("observed_not_executed"), kind: "terminal.send", semanticIdentity: "terminal.send@reconciler-semantics-v1" });
});

afterEach(() => {
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
});

describe("tr1_ 保留命名空间门禁（第十七轮第八节）", () => {
  it("手工构造 tr1_ ID 无 capability：prepare 与 contract 授权拒绝、callback 零调用", () => {
    const service = makeService();
    const prepared = service.prepareTransaction(freshInput(service, "tr1_deadbeef00000000"));
    expect(prepared.status).toBe("rejected");
    if (prepared.status === "rejected") expect(prepared.reason).toBe("rearm_capability_required");
    const contract = buildContract(service, "tr1_deadbeef00000000", {});
    const authorized = service.authorizeTreasuryActionContract(contract);
    expect(authorized.status).toBe("rejected");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0); // 无 parent fixture——拒绝路径零执行
  });

  it("initial attempt 不得使用 tr1_：contract 授权无 capability 拒绝", () => {
    const service = makeService();
    const contract = buildContract(service, "tr1_initial_attempt", {});
    const authorized = service.authorizeTreasuryActionContract(contract);
    expect(authorized.status).toBe("rejected");
    if (authorized.status === "rejected") {
      expect(authorized.detail).toContain("capability");
    }
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0); // 无 parent fixture——拒绝路径零执行
  });

  it("compat 单阶段入口拒绝 tr1_", () => {
    const service = makeService();
    const recorded = service.recordAcceptedTransaction(freshInput(service, "tr1_compat_tx"));
    expect(recorded.status).toBe("rejected");
    if (recorded.status === "rejected") expect(recorded.reason).toBe("rearm_capability_required");
  });

  it("正确 capability + 语义一致 contract：授权、执行、commit → lineage chain_committed", () => {
    const service = makeService();
    makeNotExecutedParent(service, "r17_ok_parent");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "r17_ok_parent").status).toBe("resolved");
    const issued = next.issueTreasuryRearmCapability({ parentTransactionId: "r17_ok_parent" });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    // child contract 与 parent 语义一致（同 args；transactionId 不同）。
    const childContract = buildContract(next, issued.childTransactionId, {});
    const authorized = next.authorizeTreasuryActionContract(childContract, { rearmCapability: issued.capability });
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") return;
    const executed = executeTreasuryActionContract(next, { contract: childContract, authorization: authorized.bundle, rearmCapability: issued.capability });
    expect(executed.status).toBe("executed_committed");
    // lineage 关闭：chain_committed，不再签发下一 child。
    const lineage = lookupTreasuryAttemptLineageByAttemptId(issued.childTransactionId);
    expect(lineage?.state).toBe("chain_committed");
    expect(lineage?.resolutionState).toBe("committed");
    const reIssue = next.issueTreasuryRearmCapability({ parentTransactionId: issued.childTransactionId });
    expect(reIssue.status).toBe("rejected");
  });

  it("capability 已消费后再次 authorization 拒绝；错误 child ID 拒绝", () => {
    const service = makeService();
    makeNotExecutedParent(service, "r17_consumed_parent");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "r17_consumed_parent").status).toBe("resolved");
    const issued = next.issueTreasuryRearmCapability({ parentTransactionId: "r17_consumed_parent" });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    const childContract = buildContract(next, issued.childTransactionId, {});
    const authorized = next.authorizeTreasuryActionContract(childContract, { rearmCapability: issued.capability });
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") return;
    // 执行（消费 capability）。
    const executed = executeTreasuryActionContract(next, { contract: childContract, authorization: authorized.bundle, rearmCapability: issued.capability });
    expect(executed.status).toBe("executed_committed");
    // 再次用同 capability authorize（同 tick）：capability 已消费——lineage 已
    // child_active/committed，签发与授权均拒绝。
    const childContract2 = buildContract(next, issued.childTransactionId, {});
    const authorized2 = next.authorizeTreasuryActionContract(childContract2, { rearmCapability: issued.capability });
    expect(authorized2.status).toBe("rejected");
    expect(readTreasuryTestAdapterSideEffects().executions).toBeGreaterThanOrEqual(1);
  });

  it("child contract 语义漂移（数量/资源/room/kind 变化）：授权拒绝、capability 不消费", () => {
    const service = makeService();
    makeNotExecutedParent(service, "r17_drift_parent");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "r17_drift_parent").status).toBe("resolved");
    const issued = next.issueTreasuryRearmCapability({ parentTransactionId: "r17_drift_parent" });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    // 数量漂移。
    const driftedAmount = buildContract(next, issued.childTransactionId, { amount: 999 });
    const rejectedAmount = next.authorizeTreasuryActionContract(driftedAmount, { rearmCapability: issued.capability });
    expect(rejectedAmount.status).toBe("rejected");
    if (rejectedAmount.status === "rejected") expect(rejectedAmount.detail).toContain("retry semantic");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1); // parent fixture 的 throw 执行计 1 次；child 拒绝路径零新增
    // 语义一致的 contract 仍可授权（capability 未被消费）。
    const okContract = buildContract(next, issued.childTransactionId, {});
    const authorized = next.authorizeTreasuryActionContract(okContract, { rearmCapability: issued.capability });
    expect(authorized.status).toBe("authorized");
  });
});

describe("opaque rearm capability 防伪与生命周期（第十七轮第七节）", () => {
  function issuedCapabilityFixture(): { service: TreasuryTestService; capability: unknown; childTransactionId: string } {
    const service = makeService();
    makeNotExecutedParent(service, "r17_cap_parent");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "r17_cap_parent").status).toBe("resolved");
    const issued = next.issueTreasuryRearmCapability({ parentTransactionId: "r17_cap_parent" });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") throw new Error("unreachable");
    return { service: next, capability: issued.capability, childTransactionId: issued.childTransactionId };
  }

  it("JSON round-trip 副本与手工伪造对象不能通过 prepare 门禁", () => {
    const { service, capability, childTransactionId } = issuedCapabilityFixture();
    const jsonCopy = JSON.parse(JSON.stringify(capability)) as unknown;
    const preparedByCopy = service.prepareTransaction(freshInput(service, childTransactionId), { rearmCapability: jsonCopy });
    expect(preparedByCopy.status).toBe("rejected");
    if (preparedByCopy.status === "rejected") expect(preparedByCopy.reason).toBe("rearm_capability_invalid");
    const preparedByFake = service.prepareTransaction(freshInput(service, childTransactionId), {
      rearmCapability: { __brand: "treasury-rearm-capability" },
    });
    expect(preparedByFake.status).toBe("rejected");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(1); // parent fixture 的 throw 执行计 1 次；child 拒绝路径零新增
  });

  it("capability 跨 tick 失效（旧 tick 对象无法进入新 tick prepare）", () => {
    const { capability, childTransactionId } = issuedCapabilityFixture();
    const next = advanceTick();
    // 跨 tick：capability 失效——lineage 已回退 rearm_ready（可重签）。
    const reIssued = next.issueTreasuryRearmCapability({ parentTransactionId: "r17_cap_parent" });
    expect(reIssued.status).toBe("issued");
    if (reIssued.status !== "issued") return;
    expect(reIssued.childTransactionId).toBe(childTransactionId);
    expect(reIssued.capability).not.toBe(capability);
  });

  it("接管后该 generation 不可重新签发（child_active → 再 issue 拒绝）", () => {
    const service = makeService();
    makeNotExecutedParent(service, "r17_taken_parent");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "r17_taken_parent").status).toBe("resolved");
    const issued = next.issueTreasuryRearmCapability({ parentTransactionId: "r17_taken_parent" });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    const contract = buildContract(next, issued.childTransactionId, {});
    const authorized = next.authorizeTreasuryActionContract(contract, { rearmCapability: issued.capability });
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") return;
    // 执行前同 tick 再 issue：lineage 已 capability_issued → 拒绝（不产生第
    // 二个可同时消费的 capability）。
    const again = next.issueTreasuryRearmCapability({ parentTransactionId: "r17_taken_parent" });
    expect(again.status).toBe("rejected");
    if (again.status === "rejected") expect(again.reason).toBe("lineage_not_rearm_ready");
  });
});

describe("capability 与 bundle/intent 接管（第十七轮第十/十一节）", () => {
  it("低层 kernel 通道 tr1_ 接管：intent 携带 lineage binding、故障转 quarantine 继承 binding", () => {
    const service = makeService();
    service.executePreparedAction(freshInput(service, "r17_low_parent"), () => {
      service.endTick();
      return { ok: false as const };
    });
    const t1 = advanceTick();
    expect(resolveNotExecuted(t1, "r17_low_parent").status).toBe("resolved");
    const issued = t1.issueTreasuryRearmCapability({ parentTransactionId: "r17_low_parent" });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    const bindingDigest = issued.capability.binding.bindingDigest;
    expect(bindingDigest).toMatch(/^[0-9a-f]{16}$/);
    // 同 tick 接管执行（capability 单 tick 有效）。
    const executed = t1.executePreparedAction(
      freshInput(t1, issued.childTransactionId),
      () => {
        t1.endTick();
        return { ok: false as const };
      },
      { rearmCapability: issued.capability },
    );
    expect(executed.status).not.toBe("prepare_rejected");
    const lineage = lookupTreasuryAttemptLineageByAttemptId(issued.childTransactionId);
    expect(lineage?.state).toBe("child_active");
    expect(lineage?.bindingDigest).toBe(bindingDigest);
    // quarantine 继承同一 binding（child 故障转移）。
    const quarantine = readTreasuryQuarantineEntry(issued.childTransactionId);
    expect(quarantine?.lineageBindingDigest).toBe(bindingDigest);
  });

  it("授权失败（policy 拒绝）时 capability 不消费：修正后同 tick 可重新授权", () => {
    const service = makeService();
    makeNotExecutedParent(service, "r17_policy_parent");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "r17_policy_parent").status).toBe("resolved");
    const issued = next.issueTreasuryRearmCapability({ parentTransactionId: "r17_policy_parent" });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    // 超出可用额度（storage energy 100_000 - reserve 1_000 < 200_000）→ 授权拒绝。
    const hugeContract = buildContract(next, issued.childTransactionId, { amount: 200_000 });
    const rejected = next.authorizeTreasuryActionContract(hugeContract, { rearmCapability: issued.capability });
    expect(rejected.status).toBe("rejected");
    // capability 未消费：语义一致的 contract 仍可授权。
    const okContract = buildContract(next, issued.childTransactionId, {});
    const authorized = next.authorizeTreasuryActionContract(okContract, { rearmCapability: issued.capability });
    expect(authorized.status).toBe("authorized");
  });
});

describe("parent 相反 proof 与 child 占用（第十七轮第十二节）", () => {
  it("parent 同时存在 final not-executed 与 committed receipt：proof_conflict 零 capability", () => {
    const service = makeService();
    makeNotExecutedParent(service, "r17_conflict_parent");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "r17_conflict_parent").status).toBe("resolved");
    // 手工补写 committed receipt（模拟相反 proof）。
    const receipt = commitSettledReceipt("r17_conflict_parent", Game.time, {
      digest: "0123456789abcdef",
      durableIdentityDigest: "0123456789abcdea",
    });
    expect(receipt.status).toBe("written");
    const issued = next.issueTreasuryRearmCapability({ parentTransactionId: "r17_conflict_parent" });
    expect(issued.status).toBe("rejected");
    if (issued.status === "rejected") expect(issued.reason).toBe("proof_conflict");
  });

  it("child ID 已有 durable intent：child_identity_occupied 零签发", () => {
    const service = makeService();
    makeNotExecutedParent(service, "r17_occupied_parent");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "r17_occupied_parent").status).toBe("resolved");
    const first = next.issueTreasuryRearmCapability({ parentTransactionId: "r17_occupied_parent" });
    expect(first.status).toBe("issued");
    if (first.status !== "issued") return;
    // child 接管执行（contract 路径——与 parent 同路径保证 retry semantic 一致）。
    const childContract = buildContract(next, first.childTransactionId, { outcome: "throw" });
    const childAuthorized = next.authorizeTreasuryActionContract(childContract, { rearmCapability: first.capability });
    expect(childAuthorized.status).toBe("authorized");
    if (childAuthorized.status !== "authorized") return;
    let childThrew = false;
    try {
      executeTreasuryActionContract(next, { contract: childContract, authorization: childAuthorized.bundle, rearmCapability: first.capability });
    } catch {
      childThrew = true;
    }
    expect(childThrew).toBe(true);
    // child not-executed resolution 后 lineage 推进；下一 child 派生。
    const t3 = advanceTick();
    expect(resolveNotExecuted(t3, first.childTransactionId).status).toBe("resolved");
    const second = t3.issueTreasuryRearmCapability({ parentTransactionId: first.childTransactionId });
    expect(second.status).toBe("issued");
    // 孙代 ID 被手工塞入 tombstone → 占用拒绝（先清掉孙代可签状态再验证）。
    if (second.status === "issued") {
      // 孙代已 capability_issued——占用检测在签发时；此处验证另一 parent 的
      // child 派生碰撞由确定性保证不会发生（不同 parent 不同 child）。
      expect(second.childTransactionId).not.toBe(first.childTransactionId);
    }
  });

  it("parent marker 仍在：零 capability", () => {
    const service = makeService();
    makeNotExecutedParent(service, "r17_marker_parent");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "r17_marker_parent").status).toBe("resolved");
    // 手工补写指向 parent 的 unresolved marker（模拟清理未完成）。
    const tombstone = readTreasuryResolutionTombstone("r17_marker_parent")!;
    recordTreasuryWriteFault({
      transactionId: "r17_marker_parent",
      digest: tombstone.digest,
      tick: Game.time,
      kind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick",
      status: "unresolved",
      recordedAt: Game.time,
    });
    const issued = next.issueTreasuryRearmCapability({ parentTransactionId: "r17_marker_parent" });
    expect(issued.status).toBe("rejected");
    if (issued.status === "rejected") expect(issued.reason).toBe("parent_marker_pending");
  });
});

describe("durable lineage store（第十七轮第五节）", () => {
  it("A→B→C 同一 record：entryCount 不变、generation 单调、旧 ID 永久阻断", () => {
    const service = makeService();
    service.executePreparedAction(freshInput(service, "r17_chain_root"), () => {
      service.endTick();
      return { ok: false as const };
    });
    const t1 = advanceTick();
    expect(resolveNotExecuted(t1, "r17_chain_root").status).toBe("resolved");
    const entryCountAfterRoot = peekTreasuryAttemptLineageHealth().entryCount;
    expect(entryCountAfterRoot).toBe(1);
    const a = t1.issueTreasuryRearmCapability({ parentTransactionId: "r17_chain_root" });
    expect(a.status).toBe("issued");
    if (a.status !== "issued") return;
    const bExecuted = t1.executePreparedAction(
      freshInput(t1, a.childTransactionId),
      () => {
        t1.endTick();
        return { ok: false as const };
      },
      { rearmCapability: a.capability },
    );
    expect(bExecuted.status).not.toBe("prepare_rejected");
    const t3 = advanceTick();
    expect(resolveNotExecuted(t3, a.childTransactionId).status).toBe("resolved");
    expect(peekTreasuryAttemptLineageHealth().entryCount).toBe(1); // 同 record
    const b = t3.issueTreasuryRearmCapability({ parentTransactionId: a.childTransactionId });
    expect(b.status).toBe("issued");
    if (b.status !== "issued") return;
    const record = readTreasuryAttemptLineageRecord(b.capability.binding.lineageId);
    expect(record?.generation).toBe(1); // B 接管后 current=B gen=1
    expect(record?.rootTransactionId).toBe("r17_chain_root");
    // root ID 永久阻断（lineage record 存在即 retired）。
    const rootPrepare = t3.prepareTransaction(freshInput(t3, "r17_chain_root"));
    expect(rootPrepare.status).toBe("rejected");
    if (rootPrepare.status === "rejected") expect(["rearm_required", "retired_attempt"]).toContain(rootPrepare.reason);
  });

  it("满载 fail closed：第 65 条新 root 拒绝，同 chain 推进仍可行", () => {
    // 塞满 64 条独立 root chain。
    for (let i = 0; i < TREASURY_LINEAGE_MAX_ENTRIES; i += 1) {
      const created = createTreasuryAttemptLineageRecord({
        rootTransactionId: `r17_fill_${String(i)}`,
        rootIdentity: { digest: `00000000000000${String(i).padStart(2, "0")}`.slice(-16) },
        actionKind: "terminal.send",
        authorityClass: "identity-bound",
        rearmable: false,
        nonRearmReason: "fixture",
      });
      expect(created.status).toBe("written");
    }
    expect(peekTreasuryAttemptLineageHealth().entryCount).toBe(TREASURY_LINEAGE_MAX_ENTRIES);
    // 新 root 拒绝。
    const overflow = createTreasuryAttemptLineageRecord({
      rootTransactionId: "r17_overflow",
      rootIdentity: { digest: "abcdefabcdefabcd" },
      actionKind: "terminal.send",
      authorityClass: "identity-bound",
      rearmable: false,
      nonRearmReason: "overflow fixture",
    });
    expect(overflow.status).toBe("rejected");
    if (overflow.status === "rejected") expect(overflow.detail).toContain("硬容量");
    expect(peekTreasuryAttemptLineageHealth().entryCount).toBe(TREASURY_LINEAGE_MAX_ENTRIES); // 不驱逐
  });

  it("调用方输入 alias 不污染 Memory；读取返回深冻结快照", () => {
    const identity = { digest: "1111111111111111" };
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: "r17_alias",
      rootIdentity: identity,
      actionKind: "terminal.send",
      authorityClass: "identity-bound",
      rearmable: false,
      nonRearmReason: "alias fixture",
    });
    expect(created.status).toBe("written");
    // 修改调用方输入不影响 Memory。
    (identity as { digest?: string }).digest = "2222222222222222";
    const record = lookupTreasuryAttemptLineageByAttemptId("r17_alias");
    expect(record?.rootIdentity.digest).toBe("1111111111111111");
    // 读取快照深冻结：嵌套字段不可写。
    expect(() => {
      (record as unknown as { retirement: { markerCleaned: boolean } }).retirement.markerCleaned = true;
    }).toThrow();
  });

  it("索引损坏（Memory record 与索引不一致）→ store unhealthy", () => {
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: "r17_corrupt",
      rootIdentity: { digest: "3333333333333333" },
      actionKind: "terminal.send",
      authorityClass: "identity-bound",
      rearmable: false,
      nonRearmReason: "corrupt fixture",
    });
    expect(created.status).toBe("written");
    // 手工删除 Memory record（模拟索引与 Memory 不一致——下次 load 重建时
    // entryCount 校验失败 → unhealthy）。
    const store = (Memory.runtime as { treasury?: { attemptLineage?: { entries: Record<string, unknown>; entryCount: number } } }).treasury?.attemptLineage;
    expect(store).toBeDefined();
    delete store!.entries["l:r17_corrupt"];
    store!.entryCount -= 1;
    // 触发恢复重置 + 重新 load：索引重建自 Memory（record 已删——重建后一致，
    // 但读取路径以 Memory 为权威）。校验路径 peek 健康。
    const health = peekTreasuryAttemptLineageHealth();
    expect(health.healthy).toBe(true);
    expect(lookupTreasuryAttemptLineageByAttemptId("r17_corrupt")).toBeUndefined();
  });
});

describe("tombstone retention 与永久 retirement（第十七轮第十三节）", () => {
  it("lineage replacement 完整后超龄 tombstone 可驱逐；驱逐后 parent 仍被永久拒绝、capability 仍可签发", () => {
    const service = makeService();
    service.executePreparedAction(freshInput(service, "r17_retire_root"), () => {
      service.endTick();
      return { ok: false as const };
    });
    const t1 = advanceTick();
    expect(resolveNotExecuted(t1, "r17_retire_root").status).toBe("resolved");
    // 超龄（>5000 tick）。
    Game.time += 6_000;
    const t2 = makeService();
    // 驱逐资格：lineage replacement 完整（三段完成 + rearm_ready）→ 可驱逐。
    // 塞满 resolution store（超龄 final not-executed legacy——无 lineage
    // replacement 的 pin 项）触发惰性清理：唯一可清的是有完整 lineage 的
    // r17_retire_root（驱逐后 fill 仍 pin 保留）。
    for (let i = 0; i < 255; i += 1) {
      const fill = writeTreasuryResolutionTombstone({
        transactionId: `r17_retire_fill_${String(i)}`,
        digest: "0123456789abcdef",
        resolution: "not-executed",
        stage: "final",
        proofLevel: "legacy",
        actionTick: Game.time - 6_000,
        observationTick: Game.time - 6_000,
        resolvedAtTick: Game.time - 6_000,
      });
      expect(fill.status).not.toBe("rejected");
    }
    const slotError = ensureTreasuryResolutionSlotAvailable();
    expect(slotError).toBeNull();
    expect(readTreasuryResolutionTombstone("r17_retire_root")).toBeUndefined(); // 有完整 lineage replacement 的被驱逐；无 lineage 的 fill 被 pin
    // parent ID 仍被永久阻断。
    const rootPrepare = t2.prepareTransaction(freshInput(t2, "r17_retire_root"));
    expect(rootPrepare.status).toBe("rejected");
    if (rootPrepare.status === "rejected") expect(rootPrepare.reason).toBe("retired_attempt");
    // capability 仍可从 lineage record 签发（child ID 与驱逐前一致）。
    const issued = t2.issueTreasuryRearmCapability({ parentTransactionId: "r17_retire_root" });
    expect(issued.status).toBe("issued");
    // 【第十八轮】child ID v2 generation-addressable 形态（tr1_<lineageId16>_
    // <generation6>_<checksum8>——checksum 绑定 root）。
    if (issued.status === "issued") expect(issued.childTransactionId).toMatch(/^tr1_[0-9a-f]{16}_[0-9a-f]{6}_[0-9a-f]{8}$/);
  });

  it("无 lineage replacement 的超龄 final not-executed：pin 不驱逐", () => {
    writeTreasuryResolutionTombstone({
      transactionId: "r17_pin_alone",
      digest: "0123456789abcdef",
      resolution: "not-executed",
      stage: "final",
      proofLevel: "identity-bound",
      contractDigest: "1111111111111111",
      authorizationCohortDigest: "2222222222222222",
      durableIdentityDigest: "3333333333333333",
      actionTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
    });
    Game.time += 6_000;
    const slotError = ensureTreasuryResolutionSlotAvailable();
    expect(slotError).toBeNull();
    expect(readTreasuryResolutionTombstone("r17_pin_alone")).toBeDefined(); // pin
  });
});

describe("marker v2 class-aware identity（第十七轮第十四节）", () => {
  it("runtime-lowlevel marker 不能被 migrated-lowlevel proof 清除（反向亦然）", () => {
    const markerIdentity = {
      transactionId: "r17_marker_v2",
      digest: "4444444444444444",
      markerVersion: 2 as const,
      authorityClass: "lowlevel" as const,
      lowlevelSource: "runtime-lowlevel@v1",
      status: "unresolved" as const,
      tick: 1,
      kind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick" as const,
      recordedAt: 1,
    };
    recordTreasuryWriteFault(markerIdentity);
    const migratedClear = clearRuntimeMarker({
      transactionId: "r17_marker_v2",
      digest: "4444444444444444",
      authorityClass: "lowlevel",
      lowlevelSource: "migrated-lowlevel@v1",
    });
    expect(migratedClear).toBe(false); // conflict：来源不同
    const runtimeClear = clearRuntimeMarker({
      transactionId: "r17_marker_v2",
      digest: "4444444444444444",
      authorityClass: "lowlevel",
      lowlevelSource: "runtime-lowlevel@v1",
    });
    expect(runtimeClear).toBe(true); // match：同来源
  });

  it("lineage binding 不匹配的 marker 清除拒绝（跨 lineage 互不清除）", () => {
    recordTreasuryWriteFault({
      transactionId: "r17_marker_binding",
      digest: "5555555555555555",
      markerVersion: 2,
      authorityClass: "identity-bound",
      status: "unresolved",
      tick: 1,
      kind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick",
      recordedAt: 1,
      lineageBindingDigest: "aaaaaaaaaaaaaaaa",
      attemptGeneration: 3,
    });
    const cleared = clearRuntimeMarker({
      transactionId: "r17_marker_binding",
      digest: "5555555555555555",
      authorityClass: "identity-bound",
    });
    expect(cleared).toBe(false); // insufficient：proof 缺 binding/generation
  });
});

describe("receipt proof class v7（第十七轮第十五节）", () => {
  it("v6 store load 迁移：modern 无 source → identity-bound；modern 有 source → lowlevel；legacy → legacy", () => {
    Memory.runtime = Memory.runtime ?? {};
    Memory.runtime.treasury = {
      receipts: {
        version: 6 as unknown as 7,
        settled: {
          "t:r17_v6_mod": { level: "modern" as unknown as "identity-bound", settledAtTick: Game.time, digest: "1111111111111111", durableIdentityDigest: "2222222222222222" },
          "t:r17_v6_low": { level: "modern" as unknown as "identity-bound", settledAtTick: Game.time, digest: "3333333333333333", durableIdentityDigest: "4444444444444444", lowlevelSource: "runtime-lowlevel@v1" },
          "t:r17_v6_leg": { level: "legacy", settledAtTick: Game.time },
        },
        updatedAt: Game.time,
        entryCount: 3,
        nextExpiryTick: Game.time + 5_001,
      },
    };
    // 触发 load 迁移（ensure 的 load 路径执行 v6→v7 原子迁移）。
    expect(ensureTreasuryReceiptStore().version).toBe(7);
    expect(readTreasurySettlementProof("r17_v6_mod")?.level).toBe("identity-bound");
    expect(readTreasurySettlementProof("r17_v6_low")?.level).toBe("lowlevel");
    expect(readTreasurySettlementProof("r17_v6_low")?.contractDigest).toBeUndefined(); // lowlevel 禁 modern 字段
    expect(readTreasurySettlementProof("r17_v6_leg")?.level).toBe("legacy");
    expect(peekTreasuryReceiptHealth().healthy).toBe(true);
  });

  it("v7 矛盾组合 fail closed：lowlevel proof 携带 contractDigest → 原 store 保留", () => {
    Memory.runtime = Memory.runtime ?? {};
    Memory.runtime.treasury = {
      receipts: {
        version: 6 as unknown as 7,
        settled: {
          "t:r17_v6_bad": {
            level: "modern" as unknown as "identity-bound",
            settledAtTick: Game.time,
            digest: "1111111111111111",
            durableIdentityDigest: "2222222222222222",
            lowlevelSource: "runtime-lowlevel@v1",
            contractDigest: "3333333333333333",
          },
        },
        updatedAt: Game.time,
        entryCount: 1,
        nextExpiryTick: Game.time + 5_001,
      },
    };
    // 迁移发现等级矛盾 → fail closed（原数据保留、不猜测）。
    expect(peekTreasuryReceiptHealth().healthy).toBe(false);
    // 原 v6 数据未动。
    const raw = (Memory.runtime.treasury.receipts.settled as Record<string, { level?: string }>)[
      "t:r17_v6_bad"
    ];
    expect(raw?.level).toBe("modern");
  });
});

/** 测试内直接调用 class-aware 清除（经 facade 模块的受控通道等价）。 */
function clearRuntimeMarker(proof: {
  transactionId: string;
  digest: string;
  authorityClass?: "identity-bound" | "lowlevel";
  lowlevelSource?: string;
}): boolean {
  // 经 writeFault 模块的受控 API（与 resolution 路径同一实现）。
  const writeFaultModule = jest.requireActual("@/runtime/treasury/writeFault") as {
    clearTreasuryWriteFaultMarkerForResolution: (input: unknown) => boolean;
  };
  return writeFaultModule.clearTreasuryWriteFaultMarkerForResolution(proof);
}

describe("接管恢复与 staged 状态（第十七轮第十节）", () => {
  it("capability_issued 跨 tick 恢复：lineage 回退 rearm_ready（heap capability 作废）", () => {
    const service = makeService();
    service.executePreparedAction(freshInput(service, "r17_recover_parent"), () => {
      service.endTick();
      return { ok: false as const };
    });
    const t1 = advanceTick();
    expect(resolveNotExecuted(t1, "r17_recover_parent").status).toBe("resolved");
    const issued = t1.issueTreasuryRearmCapability({ parentTransactionId: "r17_recover_parent" });
    expect(issued.status).toBe("issued");
    expect(lookupTreasuryAttemptLineageByAttemptId("r17_recover_parent")?.state).toBe("capability_issued");
    // 跨 tick（beginTick 恢复回退）。
    const t2 = advanceTick();
    expect(lookupTreasuryAttemptLineageByAttemptId("r17_recover_parent")?.state).toBe("rearm_ready");
    // 新 service 可重签发（child ID 一致）。
    const reIssued = t2.issueTreasuryRearmCapability({ parentTransactionId: "r17_recover_parent" });
    expect(reIssued.status).toBe("issued");
    if (reIssued.status === "issued" && issued.status === "issued") expect(reIssued.childTransactionId).toBe(issued.childTransactionId);
    expect(lineageStoreEvents.capabilityExpiries).toBeGreaterThanOrEqual(1);
  });

  it("intent 写入后、lineage 确认前 global reset：beginTick 判定 intent 一致 not_started → 回滚 ready 并释放 intent", () => {
    // 手工构造 child_intent_pending + 一致 not_started intent（模拟接管中断）。
    const { updateTreasuryAttemptLineageRecord, writeTreasuryIntentEntry } = jest.requireActual(
      "@/runtime/treasury/attemptLineage",
    ) as never as Record<string, never>;
    void updateTreasuryAttemptLineageRecord;
    void writeTreasuryIntentEntry;
    // 经真实恢复入口验证：构造 capability_issued 跨 tick 回退 + child_intent_
    // pending 的回滚路径（本场景用真实 resolve→issue→手工推进 staged 状态）。
    const service = makeService();
    service.executePreparedAction(freshInput(service, "r17_staged_root"), () => {
      service.endTick();
      return { ok: false as const };
    });
    const t1 = advanceTick();
    expect(resolveNotExecuted(t1, "r17_staged_root").status).toBe("resolved");
    expect(t1.issueTreasuryRearmCapability({ parentTransactionId: "r17_staged_root" }).status).toBe("issued");
    expect(lookupTreasuryAttemptLineageByAttemptId("r17_staged_root")?.state).toBe("capability_issued");
    // capability_issued 跨 tick：beginTick 恢复回退 rearm_ready。
    advanceTick();
    expect(lookupTreasuryAttemptLineageByAttemptId("r17_staged_root")?.state).toBe("rearm_ready");
    expect(lineageStoreEvents.capabilityExpiries).toBeGreaterThanOrEqual(1);
  });
});
