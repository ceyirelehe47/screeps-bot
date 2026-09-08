/**
 * Terminal Transfer Slice 0 · Remediation II——O01–O04 行为验收（任务书 §3–§5）。
 *
 * - O01：同请求不同交易 ID 的 100+60 不会在全量筛选前丢失——两种顺序/
 *   跨视图分布经注册 settle 保持 unknown 与责任，submit 不增加（基线 R-A
 *   的修复对照：起点把 amount 当相关性条件，60 被提前过滤后误报 committed）。
 * - O02：归集与全量分离的结果表——唯一全量正常退出；只有部分量/两个全量
 *   ID/同 ID 矛盾副本继续拒绝；无关部分记录不阻断正确唯一结果；既有归属
 *   回归保留（N01/N02 文件）。
 * - O03：存在且资源充足的非许可路线（C→D/反向/单端点）在业务入口因**路线
 *   不在场景范围**拒绝（不因关窗/在途/资源/容量/冷却/结构兜底），无新增
 *   active/许可/submit；默认与显式 A→B 正常完成（基线 R-B 的修复对照）。
 * - O04：closing 尚未退出时核对国库不双扣——源 H/energy 的 observed/
 *   committed/spendable 与目标 riskAdjustedFreeCapacity 经会消费占用的
 *   真实接口（subtractReservations/统一容量口径）；unknown 阶段保守占用
 *   保留；退出前后不重复释放（§5 补验——不预设生产缺陷）。
 *
 * O05/O06 由 M/N 既有回归、三组冻结 diff、固定 SHA 主验证与第二干净上下文
 * 承担（非本文件范围）；M05/M07 的 closing 投影接入见
 * treasuryTerminalTransferSlice0.test.ts。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import {
  buildTreasuryActionContract,
  findTreasuryActionAdapter,
  replaceTreasuryActionAdapterForTest,
  type TreasuryActionReconcilerConclusion,
} from "@/runtime/treasury/actionContracts";
import { clearTreasuryPolicyResolversForTest, makeNoReserveTreasuryPolicy, registerTreasuryPolicyResolver } from "@/runtime/treasury/policyAuthority";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { installRooms, setStoreResources, type RoomSpec } from "@mock/treasury";
import { createSlice0TransferCoordinator, type Slice0TransferAdmission, type Slice0TransferCoordinator } from "@mock/treasuryTerminalTransferCoordinator";
import {
  SLICE0_ACTION_KIND,
  SLICE0_TRANSFER_AMOUNT,
  SLICE0_TRANSFER_RESOURCE,
  SLICE0_USERNAME,
  createTerminalTransferFakeHost,
  makeTerminalTransferPrototypeAdapter,
  prepareSlice0TransferArgs,
  slice0SceneRooms,
  type TerminalTransferFakeHost,
  type TerminalTransferPrototypeAdapter,
  type TerminalTransactionRecord,
} from "@mock/treasuryTerminalTransferPrototype";

const SOURCE_ROOM = "W1N57";
const TARGET_ROOM = "W10N57";
/** 默认场景目标 terminal 物理空位 F0（slice0SceneRooms 的 freeCapacity）。 */
const TARGET_FREE_CAPACITY = 100_000;

interface Scene {
  readonly host: TerminalTransferFakeHost;
  readonly service: TreasuryService;
  readonly coordinator: Slice0TransferCoordinator;
  readonly fee: number;
}

function makeScene(rooms: RoomSpec[] = slice0SceneRooms()): Scene {
  const host = createTerminalTransferFakeHost();
  const installed = installRooms(rooms);
  replaceTreasuryActionAdapterForTest(makeTerminalTransferPrototypeAdapter(host));
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
  const service = createTreasuryService({ getRooms: () => Object.values(installed) });
  service.beginTick();
  const coordinator = createSlice0TransferCoordinator({
    host,
    service,
    buildContract: (args, workKey) => buildTreasuryActionContract(service, { actionKind: SLICE0_ACTION_KIND, transactionId: workKey, args }),
  });
  return { host, service, coordinator, fee: host.quoteTransferFee(SLICE0_TRANSFER_AMOUNT, SOURCE_ROOM, TARGET_ROOM) };
}

/** 矩阵 it 内换场景：清上一场景未收尾的 active（门禁由 O03 专测）。 */
function freshScene(rooms?: RoomSpec[]): Scene {
  resetTreasuryCoreStoreForTest();
  return makeScene(rooms === undefined ? slice0SceneRooms() : rooms);
}

function submit(scene: Scene, workKey: string, correlationKey: string): string {
  const admission = scene.coordinator.requestTransfer({ workKey, correlationKey });
  if (admission.status !== "admitted") throw new Error(`admit failed: ${admission.status} ${admission.reason}`);
  const execution = scene.coordinator.executeTransfer(admission);
  if (execution.status !== "unknown") throw new Error(`dispatch expected unknown, got ${execution.status} ${execution.reason}`);
  return admission.attemptId;
}

function advanceTick(service: TreasuryService): void {
  service.endTick();
  Game.time += 1;
  service.beginTick();
}

function advanceTicks(service: TreasuryService, count: number): void {
  for (let i = 0; i < count; i += 1) advanceTick(service);
}

function processAndAdvance(scene: Scene): void {
  scene.service.endTick();
  scene.host.processPendingRequests();
  Game.time += 1;
  scene.service.beginTick();
}

function stock(roomName: string, resource: string): number {
  const terminal = (Game.rooms as unknown as Record<string, { terminal?: { store: Record<string, number> } }>)[roomName]?.terminal;
  return terminal === undefined ? 0 : (terminal.store[resource] ?? 0);
}

function setStock(roomName: string, resources: Record<string, number>): void {
  setStoreResources((Game.rooms as unknown as Record<string, { terminal: StructureTerminal }>)[roomName].terminal, resources);
}

function recordShape(attemptId: string): { phase?: string; outcome?: string } | undefined {
  const store = (Memory.runtime as unknown as {
    treasuryCore?: { active?: Record<string, { phase?: string; outcome?: string }> };
  })?.treasuryCore;
  return store?.active?.[attemptId];
}

function activeIds(): string[] {
  const store = (Memory.runtime as unknown as { treasuryCore?: { active?: Record<string, unknown> } })?.treasuryCore;
  return Object.keys(store?.active ?? {});
}

/** 类型收窄：业务入口接纳失败即测试失败（正向链路的 admission 用例）。 */
function expectAdmitted(admission: Slice0TransferAdmission): Extract<Slice0TransferAdmission, { status: "admitted" }> {
  if (admission.status !== "admitted") throw new Error(`admit failed: ${admission.status} ${admission.reason}`);
  return admission;
}

/**
 * §5.1 查询口径：会消费占用的真实接口——限定单房间 terminal、关闭可选
 * 预计收入（allowIncoming=false）与展示投影（allowProjected=false）、保留
 * 流出/预留扣减（subtractOutgoing/subtractReservations=true，不传 false
 * 绕过 kernel 占用）。
 */
function queryRoom(service: TreasuryService, roomName: string, resource: string): {
  observed: number;
  committed: number;
  spendable: number;
  authorizationSafe: boolean;
  blockers: string[];
} {
  const view = service.query({
    resource,
    rooms: [roomName],
    locations: ["terminal"],
    allowProjected: false,
    allowIncoming: false,
    subtractOutgoing: true,
    subtractReservations: true,
    withhold: 0,
  });
  return {
    observed: view.observed,
    committed: view.committed,
    spendable: view.spendable,
    authorizationSafe: view.authorizationSafe,
    blockers: [...view.authorizationBlockers],
  };
}

// ── 函数级：公开形态独立夹具定向验证归集/全量分离逻辑（§3.3） ──────────────

interface FnScene {
  readonly host: TerminalTransferFakeHost;
  readonly adapter: TerminalTransferPrototypeAdapter;
  readonly key: string;
  readonly payload: string;
  readonly preparedTick: number;
  readonly fee: number;
}

/** tick 1 准备、tick 2 观察；世界手工调成"已完成一次 100H"终态（其余成功条件成立）。 */
function makeFnScene(key: string): FnScene {
  const host = createTerminalTransferFakeHost();
  installRooms(slice0SceneRooms());
  const adapter = makeTerminalTransferPrototypeAdapter(host);
  Game.time += 1; // tick 1：准备
  const args = prepareSlice0TransferArgs(host, SOURCE_ROOM, TARGET_ROOM, key);
  const payload = adapter.durableFacts(args).payload;
  Game.time += 1; // tick 2：观察
  setStock(SOURCE_ROOM, { H: 1000 - SLICE0_TRANSFER_AMOUNT, energy: 10_000 - args.prepared.feeQuote });
  setStock(TARGET_ROOM, { H: SLICE0_TRANSFER_AMOUNT, energy: 2000 });
  return { host, adapter, key, payload, preparedTick: args.prepared.preparedAtTick, fee: args.prepared.feeQuote };
}

function reconcileFn(scene: FnScene, payloadOverride?: string): TreasuryActionReconcilerConclusion {
  return scene.adapter.reconcile(
    { actionKind: SLICE0_ACTION_KIND, transactionId: "tk1_probe", durablePayload: payloadOverride ?? scene.payload, postings: [] },
    {},
  );
}

/** 完全相关且全量的公开记录（函数级默认窗内：time=preparedTick；注册路径覆盖 time）。 */
function goodRecord(scene: { readonly key: string; readonly preparedTick?: number }, id: string, overrides: Partial<TerminalTransactionRecord> = {}): TerminalTransactionRecord {
  return {
    transactionId: id,
    time: scene.preparedTick ?? Game.time - 1,
    sender: { username: SLICE0_USERNAME },
    recipient: { username: SLICE0_USERNAME },
    resourceType: SLICE0_TRANSFER_RESOURCE,
    amount: SLICE0_TRANSFER_AMOUNT,
    from: SOURCE_ROOM,
    to: TARGET_ROOM,
    description: `treasury-slice0 ${scene.key}`,
    ...overrides,
  };
}

/** 同请求的相关部分量记录（amount=60——相关性成立、全量不成立）。 */
function sixtyRecord(scene: { readonly key: string; readonly preparedTick?: number }, id: string, overrides: Partial<TerminalTransactionRecord> = {}): TerminalTransactionRecord {
  return goodRecord(scene, id, { amount: 60, ...overrides });
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
  clearTreasuryPolicyResolversForTest();
});

describe("Terminal Transfer Slice 0 · Remediation II（O01–O04）", () => {
  it("O01：同请求不同 ID 的 100+60 不在全量筛选前丢失——两种顺序/跨视图经注册 settle 保持 unknown 与责任，submit 不增加", () => {
    // 函数级两顺序（§3.1 固定反例）：60 在前/100 在前——都不能先把 60 过滤掉。
    {
      const scene = makeFnScene("s0-o1-fn");
      scene.host.viewConfig.injected = [sixtyRecord(scene, "txn-0060"), goodRecord(scene, "txn-0100")];
      expect(reconcileFn(scene)).toBe("still_uncertain");
      const scene2 = makeFnScene("s0-o1-fn");
      scene2.host.viewConfig.injected = [goodRecord(scene2, "txn-0100"), sixtyRecord(scene2, "txn-0060")];
      expect(reconcileFn(scene2)).toBe("still_uncertain");
    }
    // 注册路径 a：真实 100H 完成后注入 60（两视图都拼接）——其余成功条件
    // 全部成立（库存/费用/时窗/双方），拒绝只能来自证据歧义（基线 R-A）。
    {
      const scene = freshScene();
      const attemptId = submit(scene, "biz:slice0:o1a", "s0-o1a");
      processAndAdvance(scene);
      expect(scene.host.transactions.length).toBe(1);
      expect(scene.host.transactions[0]?.amount).toBe(SLICE0_TRANSFER_AMOUNT);
      const submitsBefore = scene.host.submits.length;
      scene.host.viewConfig.injected = [sixtyRecord({ key: "s0-o1a" }, "txn-inj-60")];
      expect(scene.service.settleUnknownOutcome({ attemptId }).status).toBe("still_uncertain");
      expect(recordShape(attemptId)?.phase).toBe("outcome_unknown");
      expect(activeIds()).toContain(attemptId); // 原责任保留
      expect(scene.host.submits.length).toBe(submitsBefore); // submit 不增加
    }
    // 注册路径 b：60 仅注入 outgoing（跨视图分布——incoming 只有真实 100）。
    {
      const scene = freshScene();
      const attemptId = submit(scene, "biz:slice0:o1b", "s0-o1b");
      processAndAdvance(scene);
      scene.host.viewConfig.injectedOutgoing = [sixtyRecord({ key: "s0-o1b" }, "txn-inj-60b")];
      expect(scene.service.settleUnknownOutcome({ attemptId }).status).toBe("still_uncertain");
      expect(recordShape(attemptId)?.phase).toBe("outcome_unknown");
    }
    // 注册路径 c：60 仅注入 incoming（跨视图分布——outgoing 只有真实 100）。
    {
      const scene = freshScene();
      const attemptId = submit(scene, "biz:slice0:o1c", "s0-o1c");
      processAndAdvance(scene);
      scene.host.viewConfig.injectedIncoming = [sixtyRecord({ key: "s0-o1c" }, "txn-inj-60c")];
      expect(scene.service.settleUnknownOutcome({ attemptId }).status).toBe("still_uncertain");
      expect(recordShape(attemptId)?.phase).toBe("outcome_unknown");
      expect(scene.host.submits.length).toBe(1);
    }
    // 对照：同链路无注入——唯一正确 100 记录正常完成（基线 R-A 对照）。
    {
      const scene = freshScene();
      const attemptId = submit(scene, "biz:slice0:o1d", "s0-o1d");
      processAndAdvance(scene);
      expect(scene.service.settleUnknownOutcome({ attemptId }).status).toBe("ok");
      expect(recordShape(attemptId)?.outcome).toBe("committed");
    }
  });

  it("O02：归集与全量分离结果表——只有部分量/两个全量 ID/同 ID 矛盾继续拒绝；无关部分记录不阻断正确唯一结果", () => {
    // 唯一正确 100 → committed（对照）。
    {
      const scene = makeFnScene("s0-o2-unique");
      scene.host.viewConfig.injected = [goodRecord(scene, "txn-0100")];
      expect(reconcileFn(scene)).toBe("observed_committed");
    }
    // 只有一条相关 60（唯一但非全量）→ uncertain——相关性不丢弃它，全量
    // 条件在唯一性之后拒绝（不补发 40、不报 not_executed）。
    {
      const scene = makeFnScene("s0-o2-only60");
      scene.host.viewConfig.injected = [sixtyRecord(scene, "txn-0060")];
      expect(reconcileFn(scene)).toBe("still_uncertain");
    }
    // 不同 ID 的两个全量 100 → uncertain（不能任选——既有 N02 多 ID 语义保留）。
    {
      const scene = makeFnScene("s0-o2-two100");
      scene.host.viewConfig.injected = [goodRecord(scene, "txn-0100"), goodRecord(scene, "txn-0101")];
      expect(reconcileFn(scene)).toBe("still_uncertain");
    }
    // 同 ID 的 100/60 矛盾副本 → uncertain（一致性先验在任何唯一性之前）。
    {
      const scene = makeFnScene("s0-o2-conflict");
      scene.host.viewConfig.injected = [goodRecord(scene, "txn-0099"), sixtyRecord(scene, "txn-0099")];
      expect(reconcileFn(scene)).toBe("still_uncertain");
    }
    // 唯一正确 100 + 不同完整关联键的无关 60 → committed（无关噪声不阻断）。
    {
      const scene = makeFnScene("s0-o2-noise");
      scene.host.viewConfig.injected = [
        goodRecord(scene, "txn-0100"),
        sixtyRecord(scene, "txn-0060", { description: "treasury-slice0 someone-else" }),
      ];
      expect(reconcileFn(scene)).toBe("observed_committed");
    }
    // 注册路径：只有相关 60（未真实处理）——uncertain 且责任保留。
    {
      const scene = freshScene();
      const attemptId = submit(scene, "biz:slice0:o2-reg60", "s0-o2r60");
      advanceTick(scene.service);
      scene.host.viewConfig.injected = [sixtyRecord({ key: "s0-o2r60" }, "txn-0060")];
      expect(scene.service.settleUnknownOutcome({ attemptId }).status).toBe("still_uncertain");
      expect(recordShape(attemptId)?.phase).toBe("outcome_unknown");
      expect(activeIds()).toContain(attemptId);
      expect(scene.host.submits.length).toBe(1);
    }
    // 注册路径：真实 100 + 无关 60（不同关联键）——正常完成退出（§3.2 表）。
    {
      const scene = freshScene();
      const attemptId = submit(scene, "biz:slice0:o2-regnoise", "s0-o2rn");
      processAndAdvance(scene);
      scene.host.viewConfig.injected = [sixtyRecord({ key: "s0-o2rn" }, "txn-0060", { description: "treasury-slice0 someone-else" })];
      expect(scene.service.settleUnknownOutcome({ attemptId }).status).toBe("ok");
      expect(recordShape(attemptId)?.outcome).toBe("committed");
      expect(recordShape(attemptId)?.phase).toBe("closing");
      advanceTick(scene.service);
      expect(activeIds()).not.toContain(attemptId);
    }
    // 注册路径：同 ID 100/60 矛盾镜像（incoming 注入 60、真实 100 在两视图）。
    {
      const scene = freshScene();
      const attemptId = submit(scene, "biz:slice0:o2-regconf", "s0-o2rc");
      processAndAdvance(scene);
      const real = scene.host.transactions[0];
      scene.host.viewConfig.injectedIncoming = [sixtyRecord({ key: "s0-o2rc" }, real?.transactionId ?? "txn-real", { time: real?.time ?? Game.time - 1 })];
      expect(scene.service.settleUnknownOutcome({ attemptId }).status).toBe("still_uncertain");
      expect(recordShape(attemptId)?.phase).toBe("outcome_unknown");
    }
  });

  it("O03：非许可路线在业务入口因路线拒绝（无新增 active/许可/submit）；默认与显式 A→B 正常完成", () => {
    const rooms: RoomSpec[] = [
      ...slice0SceneRooms(),
      { name: "W20N57", terminal: { id: "term-C", resources: { H: 1000, energy: 10_000 }, freeCapacity: 100_000 } },
      { name: "W30N57", terminal: { id: "term-D", resources: { energy: 2000 }, freeCapacity: 100_000 } },
    ];
    const scene = freshScene(rooms);
    // 显式同一路线 A→B：接纳并完整闭环（提交恰一次、结算退出）。
    const explicit = expectAdmitted(scene.coordinator.requestTransfer({
      workKey: "biz:slice0:o3-explicit",
      correlationKey: "s0-o3e",
      sourceRoomName: SOURCE_ROOM,
      targetRoomName: TARGET_ROOM,
    }));
    expect(scene.coordinator.executeTransfer(explicit).status).toBe("unknown");
    expect(scene.host.submits.length).toBe(1);
    processAndAdvance(scene);
    expect(scene.service.settleUnknownOutcome({ attemptId: explicit.attemptId }).status).toBe("ok");
    advanceTick(scene.service);
    expect(activeIds()).not.toContain(explicit.attemptId);
    // 非许可路线（C/D 存在、受管辖、Terminal 与资源/容量充足——其他条件
    // 全部成立）：C→D、反向 D→C、单端点 A→D/C→B 都必须因**路线不在场景
    // 范围**拒绝——不因关窗/单条在途/资源/冷却/结构缺失兜底（基线 R-B）。
    const routeRejections: readonly { label: string; source: string; target: string }[] = [
      { label: "C→D", source: "W20N57", target: "W30N57" },
      { label: "D→C（反向）", source: "W30N57", target: "W20N57" },
      { label: "A→D（单端点）", source: SOURCE_ROOM, target: "W30N57" },
      { label: "C→B（单端点）", source: "W20N57", target: TARGET_ROOM },
    ];
    const activeBefore = activeIds().length;
    for (const item of routeRejections) {
      const rejection = scene.coordinator.requestTransfer({
        workKey: `biz:slice0:o3-${item.label}`,
        correlationKey: "s0-o3x",
        sourceRoomName: item.source,
        targetRoomName: item.target,
      });
      expect(rejection.status).toBe("rejected");
      if (rejection.status === "rejected") {
        expect(rejection.stage).toBe("route");
        expect(rejection.reason).toMatch(/路线不在本场景范围/);
        expect(rejection.reason).not.toMatch(/单条在途|窗口|额度|资源|容量|冷却|结构/);
      }
    }
    expect(activeIds().length).toBe(activeBefore); // 无新增 active/许可
    expect(scene.host.submits.length).toBe(1); // submit 增量 0
    // 默认 A→B（省略路线字段）：越过冷却后接纳并完整闭环——两笔终态吻合。
    advanceTicks(scene.service, 9); // cooldownUntil=10——推进到 tick 11
    const defaulted = expectAdmitted(scene.coordinator.requestTransfer({ workKey: "biz:slice0:o3-default", correlationKey: "s0-o3d" }));
    expect(scene.coordinator.executeTransfer(defaulted).status).toBe("unknown");
    expect(scene.host.submits.length).toBe(2);
    processAndAdvance(scene);
    expect(scene.service.settleUnknownOutcome({ attemptId: defaulted.attemptId }).status).toBe("ok");
    advanceTick(scene.service);
    expect(activeIds()).not.toContain(defaulted.attemptId);
    expect(stock(SOURCE_ROOM, SLICE0_TRANSFER_RESOURCE)).toBe(800);
    expect(stock(SOURCE_ROOM, "energy")).toBe(10_000 - scene.fee * 2);
    expect(stock(TARGET_ROOM, SLICE0_TRANSFER_RESOURCE)).toBe(200);
  });

  it("O04：closing 期间国库不双扣——源 spendable 与目标 riskAdjustedFreeCapacity 经真实占用接口核对；unknown 保守责任保留；退出不重复释放", () => {
    const scene = freshScene();
    const attemptId = submit(scene, "biz:slice0:o4", "s0-o4");
    // §5.2 unknown 阶段：提交后尚未处理——物理未变（1000/10000/F0），
    // worstCase 占用保留 100H/q/100 空位责任（不能提前释放）。
    {
      const h = queryRoom(scene.service, SOURCE_ROOM, SLICE0_TRANSFER_RESOURCE);
      expect(h.observed).toBe(1000);
      expect(h.committed).toBe(100);
      expect(h.spendable).toBe(900);
      expect(h.authorizationSafe).toBe(true); // 不能拿 fail-closed 的 0 冒充
      expect(h.blockers).toEqual([]);
      const energy = queryRoom(scene.service, SOURCE_ROOM, "energy");
      expect(energy.observed).toBe(10_000);
      expect(energy.committed).toBe(scene.fee);
      expect(energy.spendable).toBe(10_000 - scene.fee);
      expect(scene.service.riskAdjustedFreeCapacity(TARGET_ROOM, "terminal")).toBe(TARGET_FREE_CAPACITY - 100);
    }
    // 全量效果可见 → 注册 settle 进入 closing（在下一次生命周期推进之前核对）。
    processAndAdvance(scene);
    expect(scene.service.settleUnknownOutcome({ attemptId }).status).toBe("ok");
    expect(recordShape(attemptId)?.phase).toBe("closing");
    expect(recordShape(attemptId)?.outcome).toBe("committed");
    expect(activeIds()).toContain(attemptId); // 仍 closing——不是先删记录再读账
    {
      // 源 H：物理已扣 100（observed=900），该次效果不再作为额外 100 占用
      // 扣减——committed=0、spendable=900（双扣会得到 800）。
      const h = queryRoom(scene.service, SOURCE_ROOM, SLICE0_TRANSFER_RESOURCE);
      expect(h.observed).toBe(900);
      expect(h.committed).toBe(0);
      expect(h.spendable).toBe(900);
      expect(h.authorizationSafe).toBe(true);
      expect(h.blockers).toEqual([]);
      // 源 energy：同理 10000−q、committed=0。
      const energy = queryRoom(scene.service, SOURCE_ROOM, "energy");
      expect(energy.observed).toBe(10_000 - scene.fee);
      expect(energy.committed).toBe(0);
      expect(energy.spendable).toBe(10_000 - scene.fee);
      // 目标接收容量：F0−100（物理空位已扣 100，kernel 流入占用释放；
      // 双扣会得到 F0−200）。
      expect(scene.service.riskAdjustedFreeCapacity(TARGET_ROOM, "terminal")).toBe(TARGET_FREE_CAPACITY - 100);
    }
    expect(scene.host.submits.length).toBe(1); // 查询没有清理责任/不产生提交
    // 原 cleanup 退出：上述金额/容量不因删除记录再增加一次（不重复释放）。
    advanceTick(scene.service);
    expect(activeIds()).not.toContain(attemptId);
    {
      const h = queryRoom(scene.service, SOURCE_ROOM, SLICE0_TRANSFER_RESOURCE);
      expect(h.observed).toBe(900);
      expect(h.committed).toBe(0);
      expect(h.spendable).toBe(900);
      const energy = queryRoom(scene.service, SOURCE_ROOM, "energy");
      expect(energy.observed).toBe(10_000 - scene.fee);
      expect(energy.committed).toBe(0);
      expect(energy.spendable).toBe(10_000 - scene.fee);
      expect(scene.service.riskAdjustedFreeCapacity(TARGET_ROOM, "terminal")).toBe(TARGET_FREE_CAPACITY - 100);
    }
    // 物理终态：源 −100H/−q、目标 +100H——提交恰一次。
    expect(stock(SOURCE_ROOM, SLICE0_TRANSFER_RESOURCE)).toBe(900);
    expect(stock(SOURCE_ROOM, "energy")).toBe(10_000 - scene.fee);
    expect(stock(TARGET_ROOM, SLICE0_TRANSFER_RESOURCE)).toBe(100);
    expect(scene.host.submits.length).toBe(1);
    // 账目可用 ≠ 允许新调拨：closing 已在上一步退出——本条仅核对查询口径
    // 与门禁独立（门禁语义由 N03/O03 承担）。
  });
});
