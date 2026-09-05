/**
 * Treasury Core Rewrite III——C14/C15（观察接管的 reset 维度）与 C23 补充。
 *
 * 复用共享完整 reset harness（test/mock/treasuryResetHarness）：全 Memory
 * JSON 快照真正安装为全局 Memory + 模块缓存重建 + 注册表重装 + 新 facade
 * + 真实 beginTick。宿主执行轨迹与世界状态独立于 Memory 保存；重装 mock
 * 房间不重置已发生的世界效果（世界序持续单调——§6.3）。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import {
  buildTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  readTreasuryTestAdapterSideEffects,
  replaceTreasuryActionAdapterForTest,
  resetTreasuryTestAdapterSideEffectsForTest,
  type TreasuryActionAdapter,
  type TreasuryTestTransferArgs,
} from "@/runtime/treasury/actionContracts";
import {
  clearTreasuryPolicyResolversForTest,
  makeNoReserveTreasuryPolicy,
  registerTreasuryPolicyResolver,
} from "@/runtime/treasury/policyAuthority";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { snapshotWholeMemory, installWholeMemorySnapshot, performTreasuryFullReset } from "@mock/treasuryResetHarness";
import { installRooms, type RoomSpec } from "@mock/treasury";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 1000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 0 }, freeCapacity: 200_000 },
  },
  {
    name: "W2N57",
    storage: { id: "stor-2", resources: { energy: 0 }, freeCapacity: 10_000 },
    terminal: { id: "term-2", resources: { energy: 0 }, freeCapacity: 900_000 },
  },
];

function transferArgs(overrides: Partial<TreasuryTestTransferArgs> = {}): TreasuryTestTransferArgs {
  return {
    fromRoom: "W1N57",
    fromLocation: "storage",
    toRoom: "W2N57",
    toLocation: "terminal",
    resource: RESOURCE_ENERGY,
    amount: 200,
    outcome: "ok",
    ...overrides,
  };
}

function makeService(): TreasuryService {
  const installed = installRooms(ROOMS);
  const service = createTreasuryService({ getRooms: () => Object.values(installed) });
  service.beginTick();
  return service;
}

function buildContract(service: TreasuryService, workKey: string, args: TreasuryTestTransferArgs) {
  const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: workKey, args });
  if (built.status !== "built") throw new Error(`build failed: ${built.status === "rejected" ? built.reason : "?"}`);
  return built.contract;
}

function admit(service: TreasuryService, workKey: string, args: TreasuryTestTransferArgs) {
  const admission = service.authorizeTreasuryActionContract(buildContract(service, workKey, args), { workKey });
  if (admission.status !== "admitted") throw new Error(`admit failed: ${admission.status === "rejected" ? admission.reason : "?"}`);
  return admission;
}

interface HostTrace {
  executions: number;
  releaseCalls: string[];
}

/**
 * reset 后的 contract 必须由**新模块**构建（旧模块印记不被新 registry 认
 * ——与跨 reset 语义一致）。用 handles.actionContractsModule 构建。
 */
function rebuildContractAfterReset(
  reset: ReturnType<typeof performTreasuryFullReset>,
  workKey: string,
  args: TreasuryTestTransferArgs,
): unknown {
  const built = reset.handles.actionContractsModule.buildTreasuryActionContract(
    reset.service,
    { actionKind: "test.transfer", transactionId: workKey, args },
  );
  if (built.status !== "built") throw new Error(`rebuild failed: ${built.status === "rejected" ? built.reason : "?"}`);
  return built.contract;
}

function installTracingAdapter(trace: HostTrace, reconcile: "still_uncertain" = "still_uncertain"): TreasuryActionAdapter {
  const base = makeTreasuryTestTransferAdapter(reconcile);
  return {
    ...base,
    execute(args: TreasuryTestTransferArgs): { ok: boolean } {
      trace.executions += 1;
      return base.execute(args);
    },
  };
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
  resetTreasuryCommitmentRevisionForTest();
  resetTreasuryTestAdapterSideEffectsForTest();
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
  clearTreasuryPolicyResolversForTest();
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
});

// ── C14：世界更新进入新观察（fresh / 下一 tick / 晚到 reconcile） ──────────

describe("C14 观察接管不双扣不漏扣", () => {
  it("A committed 200 后：同 tick fresh 视图与下一 tick 都不把 200 再扣一次", () => {
    const installed = installRooms(ROOMS);
    const service = createTreasuryService({ getRooms: () => Object.values(installed) });
    service.beginTick();
    const a = admit(service, "biz:c14:a", transferArgs({ amount: 200 }));
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    // 世界已真实更新（storage 800；世界序 +1）。同 tick fresh 观察：世界序
    // 已过效果锚点 → A 不再占用；fresh 数字 800 已含效果 → 单次表达。
    const fresh = service.beginFreshObservation();
    expect(fresh?.amount("W1N57", "storage", RESOURCE_ENERGY)).toBe(800);
    const b = service.authorizeTreasuryActionContract(
      buildContract(service, "biz:c14:b-fresh", transferArgs({ amount: 600 })),
      { workKey: "biz:c14:b-fresh" },
    );
    // 复验使用 fresh 观察：800（含 A 效果）− 0（A 已覆盖不占用）≥ 600 → 获准。
    expect(b.status).toBe("admitted");
    // 下一 tick：b（跨 tick 未执行 pending）被 beginTick sweep 安全取消；
    // 观察重建（世界序更高）对 A 同样不双扣。
    Game.time += 1;
    service.beginTick();
    const c = service.authorizeTreasuryActionContract(
      buildContract(service, "biz:c14:c-next", transferArgs({ amount: 600 })),
      { workKey: "biz:c14:c-next" },
    );
    // 世界 800（含 A 效果、b 已取消）− 0 占用 → 600 获准。
    expect(c.status).toBe("admitted");
    const d = service.authorizeTreasuryActionContract(
      buildContract(service, "biz:c14:d-over", transferArgs({ amount: 200 })),
      { workKey: "biz:c14:d-over" },
    );
    // 800 − c pending 600 = 200 恰可；再 1 必拒。
    expect(d.status).toBe("admitted");
    const e = service.authorizeTreasuryActionContract(
      buildContract(service, "biz:c14:e-over", transferArgs({ amount: 1 })),
      { workKey: "biz:c14:e-over" },
    );
    expect(e.status).toBe("rejected");
  });

  it("晚到 reconcile 的 confirmed：invocation 锚点久远，观察已含效果——不叠加占用", () => {
    const installed = installRooms(ROOMS);
    const service = createTreasuryService({ getRooms: () => Object.values(installed) });
    service.beginTick();
    // dispatch → unknown（throw），下一 tick 手动构造 reconcile confirmed：
    // replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter("observed_committed"))。
    const a = admit(service, "biz:c14:late", transferArgs({ amount: 200, outcome: "throw" }));
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("unknown");
    // 世界未更新（throw 未写世界——效果实际未发生）→ 观察未含；但 reconcile
    // 声明 observed_committed（受控 reconciler 结论）→ closing committed。
    replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter("observed_committed"));
    Game.time += 1;
    service.beginTick();
    expect(service.settleUnknownOutcome({ attemptId: a.attemptId }).status).toBe("ok");
    // 判定：worldSequence 锚 = 调用前（世界未变过——seq 未超）→ 保守占用 200
    // 直到聚合退出（§6.2 观察源不能证实覆盖时保留责任）。
    const b = service.authorizeTreasuryActionContract(
      buildContract(service, "biz:c14:late-b", transferArgs({ amount: 900 })),
      { workKey: "biz:c14:late-b" },
    );
    expect(b.status).toBe("rejected");
    // 小额（1000 − 200 保守占用 = 800 ≥ 700）可获准——占用单次表达。
    const c = service.authorizeTreasuryActionContract(
      buildContract(service, "biz:c14:late-c", transferArgs({ amount: 700 })),
      { workKey: "biz:c14:late-c" },
    );
    expect(c.status).toBe("admitted");
  });
});

// ── C15：完整 reset 后账目重建（各断点快照） ───────────────────────────────

describe("C15 reset 重建与旧视图失效", () => {
  it("断点（结果发布后、清理前）：丢全部 heap 重建——账目正确、旧视图不超额、旧 ID 无执行权", () => {
    const trace: HostTrace = { executions: 0, releaseCalls: [] };
    const adapter = installTracingAdapter(trace);
    replaceTreasuryActionAdapterForTest(adapter);
    const service = makeService();
    const a = admit(service, "biz:c15:a", transferArgs({ amount: 300 }));
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    expect(trace.executions).toBe(1);
    // 世界已真实更新：storage 700（世界序 +1）。
    const snapshot = snapshotWholeMemory();
    installWholeMemorySnapshot(snapshot);
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter, advanceTicks: 1 });
    // 新 runtime：重建账目（closing committed 未被新观察覆盖前仍担责——
    // 世界序快照保留，效果已计入世界 → 观察 700 已含；A 记录退出或不再扣）。
    const b = reset.service.authorizeTreasuryActionContract(
      rebuildContractAfterReset(reset, "biz:c15:b", transferArgs({ amount: 700 })),
      { workKey: "biz:c15:b" },
    );
    expect(b.status).toBe("admitted");
    const over = reset.service.authorizeTreasuryActionContract(
      rebuildContractAfterReset(reset, "biz:c15:over", transferArgs({ amount: 1 })),
      { workKey: "biz:c15:over" },
    );
    expect(over.status).toBe("rejected");
    // 旧 permit（攻击输入）无执行权。
    expect(reset.service.executeAuthorizedDispatch(a.dispatch).status).toBe("rejected");
    expect(trace.executions).toBe(1);
    // 宿主世界效果不被 reset 重置回原余额。
    expect(reset.rooms.W1N57.storage?.store.energy).toBe(700);
  });

  it("断点（pending 未 dispatch）：reset 后 sweep 取消、槽位回收、宿主轨迹零调用", () => {
    const trace: HostTrace = { executions: 0, releaseCalls: [] };
    const adapter = installTracingAdapter(trace);
    replaceTreasuryActionAdapterForTest(adapter);
    const service = makeService();
    admit(service, "biz:c15:pending", transferArgs({ amount: 300 }));
    const snapshot = snapshotWholeMemory();
    installWholeMemorySnapshot(snapshot);
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter, advanceTicks: 1 });
    expect(reset.service.kernelMetrics().activeCount).toBe(0);
    expect(trace.executions).toBe(0);
    // 槽位回收：新接纳可用（观察 1000 未变——未执行）。
    const fresh = reset.service.authorizeTreasuryActionContract(
      rebuildContractAfterReset(reset, "biz:c15:after", transferArgs({ amount: 1000 })),
      { workKey: "biz:c15:after" },
    );
    expect(fresh.status).toBe("admitted");
  });

  it("断点（确认结果但观察未接管——throw→unknown→同 tick settle）：责任保留", () => {
    const trace: HostTrace = { executions: 0, releaseCalls: [] };
    const adapter = installTracingAdapter(trace);
    replaceTreasuryActionAdapterForTest(adapter);
    const service = makeService();
    const a = admit(service, "biz:c15:u", transferArgs({ amount: 300, outcome: "throw" }));
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("unknown");
    const snapshot = snapshotWholeMemory();
    installWholeMemorySnapshot(snapshot);
    const reset = performTreasuryFullReset({ roomSpecs: ROOMS, adapter, advanceTicks: 1 });
    // unknown 的双向风险占用保留：1000 − 300 = 700 可用。
    const b = reset.service.authorizeTreasuryActionContract(
      rebuildContractAfterReset(reset, "biz:c15:ub", transferArgs({ amount: 700 })),
      { workKey: "biz:c15:ub" },
    );
    expect(b.status).toBe("admitted");
    const over = reset.service.authorizeTreasuryActionContract(
      rebuildContractAfterReset(reset, "biz:c15:uover", transferArgs({ amount: 1 })),
      { workKey: "biz:c15:uover" },
    );
    expect(over.status).toBe("rejected");
  });

  it("同 tick beginTick/endTick 重入与 facade 重建不清掉未入观察的已执行变化", () => {
    const trace: HostTrace = { executions: 0, releaseCalls: [] };
    replaceTreasuryActionAdapterForTest(installTracingAdapter(trace));
    const service = makeService();
    const a = admit(service, "biz:c15:same-tick", transferArgs({ amount: 300 }));
    expect(service.executeAuthorizedDispatch(a.dispatch).status).toBe("committed");
    // 同 tick 新建实例：占用投影来自 Memory（不依赖实例 overlay）；世界
    // 不重装（已发生效果保留——两个实例共享同一房间表引用）。
    const installed = (globalThis as unknown as { Game: { rooms: Record<string, Room> } }).Game.rooms;
    const second = createTreasuryService({ getRooms: () => Object.values(installed) });
    second.beginTick();
    const over = second.authorizeTreasuryActionContract(
      buildContract(second, "biz:c15:st-over", transferArgs({ amount: 800 })),
      { workKey: "biz:c15:st-over" },
    );
    // 1000 − 300（committed 未被本 tick 观察——世界序已过但 shared 观察
    // 构建于效果前——保守占用）…… 世界序：shared 观察 worldSeq 低于效果
    // 锚 → 占用 300 → 700 < 800 拒绝。
    expect(over.status).toBe("rejected");
    const ok = second.authorizeTreasuryActionContract(
      buildContract(second, "biz:c15:st-ok", transferArgs({ amount: 700 })),
      { workKey: "biz:c15:st-ok" },
    );
    expect(ok.status).toBe("admitted");
  });
});

// ── C23 补充：长期 unknown 混合流量下的有界性与旧 ID 不复活 ────────────────

describe("C23 混合流量补充（长期 unknown + 新工作）", () => {
  it("固定长期 unknown 占用 + 持续完成新工作：unknown 有界保留、其余正常退出、旧 ID 无执行权", () => {
    const trace: HostTrace = { executions: 0, releaseCalls: [] };
    replaceTreasuryActionAdapterForTest(installTracingAdapter(trace));
    const service = makeService();
    // 一笔长期 unknown（占用 200 流出 + 200 流入）。
    const stuck = admit(service, "biz:c23:stuck", transferArgs({ amount: 200, outcome: "throw" }));
    const stuckId = stuck.attemptId;
    expect(service.executeAuthorizedDispatch(stuck.dispatch).status).toBe("unknown");
    let oldPermit = stuck.dispatch;
    // 持续完成新工作（每 tick 2 笔 × 10 tick；余额随世界真实更新递减）。
    for (let tick = 0; tick < 10; tick += 1) {
      Game.time += 1;
      service.beginTick();
      for (let i = 0; i < 2; i += 1) {
        const work = admit(service, `biz:c23:t${String(tick)}-${String(i)}`, transferArgs({ amount: 10 }));
        expect(service.executeAuthorizedDispatch(work.dispatch).status).toBe("committed");
      }
    }
    Game.time += 1;
    service.beginTick(); // 最后一 tick 的 committed 完成清理退出。
    const journal = service.kernelJournal();
    // unknown 单条保留（不被年龄淘汰）；完成的全部退出。
    expect(journal.active.length).toBe(1);
    expect(journal.active[0]?.attemptId).toBe(stuckId);
    expect(journal.active[0]?.phase).toBe("outcome_unknown");
    // 世界真实消耗：1000 − 200(unknown 未发生但保守占用不改世界) − 200 已完成
    // = 完成 20 笔 ×10 = 200 → storage 800。
    expect(journal.ring.length).toBe(20);
    // 旧 ID 不复活：跨 tick 许可失效 + 字符串/克隆对象无执行权。
    expect(service.executeAuthorizedDispatch(oldPermit).status).toBe("rejected");
    expect(service.executeAuthorizedDispatch({ ...stuck.dispatch, attemptId: stuckId }).status).toBe("rejected");
    expect(service.executeAuthorizedDispatch(stuckId).status).toBe("rejected");
    expect(trace.executions).toBe(21);
  });
});
