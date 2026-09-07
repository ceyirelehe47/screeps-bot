/**
 * Terminal Transfer Slice 0 · Remediation I——N01–N06 行为验收（任务书 §4–§6）。
 *
 * - N01：完整交易归属——期望值全部来自持久 payload v2（准备时一次取值），
 *   不从候选记录反推；描述严格相等；双方/身份/路线/金额逐项破坏均
 *   uncertain；正确唯一记录完成（基线 R1a/R1b/R1c 的修复对照）。
 * - N02：同 ID 全部相关副本冲突拒绝且顺序无关，一致去重合法；旧记录/
 *   未覆盖观察/无记录/多 ID/带 order/当前 tick 均保守；关键场景经注册
 *   settle 入口断言持久 phase。
 * - N03：不同 workKey、不同关联键的 B 在 A 未结束时被业务入口拒绝；跨
 *   协调器/跨完整 reset 到开放 tick 仍拒且理由为单条在途；A closing 阻断、
 *   退出并越过冷却后 B 完整闭环（基线 R2 的修复对照）。
 * - N05：q→q+5 不再查/再查/其他准备报价/读异常均零提交；业务前检与
 *   adapter guard 双覆盖；恢复报价的未消费请求与独立 q+5 新请求完整闭环
 *   （基线 R3 的修复对照）。
 * - N06：canonical/postings/permit/active/durable 费用与身份同源且重复
 *   派生稳定（R7）；无自动 retry、不新增持久权威。
 *
 * N04 由 M 文件的 M05/M07（经业务入口重跑）承担；N07 由固定验证中的
 * verify-outside/verify-empty/坏产物对照与定向自测承担（非 Jest 范围）。
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
import { captureTreasuryHostBreakpoint, performTreasuryFullReset } from "@mock/treasuryResetHarness";
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

/** 矩阵/序列 it 内换场景：清上一场景未收尾的 active（本 it 测归属/费用矩阵，不测单条在途门禁——门禁由 N03 专测）。 */
function freshScene(rooms?: RoomSpec[]): Scene {
  resetTreasuryCoreStoreForTest();
  return makeScene(rooms === undefined ? slice0SceneRooms() : rooms);
}

/** 直连 facade 构建/授权（隔离低层行为/通用层对照——不承担业务门禁证明）。 */
function admit(service: TreasuryService, workKey: string, args: unknown): { status: string; attemptId?: string; dispatch?: object; reason?: string } {
  const built = buildTreasuryActionContract(service, { actionKind: SLICE0_ACTION_KIND, transactionId: workKey, args });
  if (built.status !== "built") return { status: `build:${built.status}` };
  return service.authorizeTreasuryActionContract(built.contract, { workKey }) as { status: string; attemptId?: string; dispatch?: object; reason?: string };
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
  const store = (Memory.runtime as unknown as { treasuryCore?: { active?: Record<string, { phase?: string; outcome?: string }> } })?.treasuryCore;
  return store?.active?.[attemptId];
}

/** 完整 active 记录形状（N06 同源断言——identity.durableFacts/worstCase）。 */
function coreRecord(attemptId: string): {
  phase?: string;
  outcome?: string;
  identity?: { actionKind?: string; durableFacts?: { payload?: string } };
  worstCase?: readonly { roomName: string; resource: string; delta: number }[];
} {
  const store = (Memory.runtime as unknown as {
    treasuryCore?: { active?: Record<string, { phase?: string; outcome?: string; identity?: { actionKind?: string; durableFacts?: { payload?: string } }; worstCase?: readonly { roomName: string; resource: string; delta: number }[] }> };
  })?.treasuryCore;
  return store?.active?.[attemptId] ?? {};
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

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
  clearTreasuryPolicyResolversForTest();
});

// ── N01/N02 函数级：公开形态独立夹具定向验证归属逻辑 ────────────────────────

interface FnScene {
  readonly host: TerminalTransferFakeHost;
  readonly adapter: TerminalTransferPrototypeAdapter;
  readonly key: string;
  readonly payload: string;
  readonly preparedTick: number;
  readonly fee: number;
}

/**
 * 构造函数级场景：prepare 在 tick 1（preparedTick=1），观察在 tick 2；
 * 世界手工调成"已发生"终态（时间窗与库存核对均可通过——逐项破坏归属
 * 字段才能证明拒绝来自归属核对本身，不靠库存/时点兜底）。
 */
function makeFnScene(key: string): FnScene {
  const host = createTerminalTransferFakeHost();
  installRooms(slice0SceneRooms());
  const adapter = makeTerminalTransferPrototypeAdapter(host);
  Game.time += 1; // tick 1：准备（preparedAtTick=1）
  const args = prepareSlice0TransferArgs(host, SOURCE_ROOM, TARGET_ROOM, key);
  const payload = adapter.durableFacts(args).payload;
  Game.time += 1; // tick 2：观察（记录 time=1 可见）
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

/** 完全归属匹配的公开记录（默认窗内：time=preparedTick）。 */
function goodRecord(scene: FnScene, id: string, overrides: Partial<TerminalTransactionRecord> = {}): TerminalTransactionRecord {
  return {
    transactionId: id,
    time: scene.preparedTick,
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

describe("Terminal Transfer Slice 0 · Remediation I（N01–N06）", () => {
  it("N01：完整归属矩阵——描述/双方/身份/路线/资源/金额逐项破坏均 uncertain；正确唯一对照 committed（期望值来自持久 payload）", () => {
    // 对照：完整归属匹配 → observed_committed。
    {
      const scene = makeFnScene("s0-n1-ok");
      scene.host.viewConfig.injected = [goodRecord(scene, "txn-0001")];
      expect(reconcileFn(scene)).toBe("observed_committed");
    }
    // 前缀/后缀碰撞（完整关联键错误但描述包含期望键——基线 R1a）。
    {
      const scene = makeFnScene("s0-n1-k");
      scene.host.viewConfig.injected = [goodRecord(scene, "txn-0002", { description: `treasury-slice0 ${scene.key}X` })];
      expect(reconcileFn(scene)).toBe("still_uncertain"); // 前缀碰撞
      const scene2 = makeFnScene("s0-n1-k");
      scene2.host.viewConfig.injected = [goodRecord(scene2, "txn-0002", { description: `treasury-slice0 X${scene2.key}` })];
      expect(reconcileFn(scene2)).toBe("still_uncertain"); // 后缀碰撞
    }
    // sender 错 / recipient 错 / 身份缺失（基线 R1b）。
    {
      const scene = makeFnScene("s0-n1-id");
      scene.host.viewConfig.injected = [goodRecord(scene, "txn-0003", { sender: { username: "intruder" } })];
      expect(reconcileFn(scene)).toBe("still_uncertain");
      const scene2 = makeFnScene("s0-n1-id");
      scene2.host.viewConfig.injected = [goodRecord(scene2, "txn-0004", { recipient: { username: "intruder" } })];
      expect(reconcileFn(scene2)).toBe("still_uncertain");
      const scene3 = makeFnScene("s0-n1-id");
      scene3.host.viewConfig.injected = [goodRecord(scene3, "txn-0005", { sender: undefined, recipient: undefined })];
      expect(reconcileFn(scene3)).toBe("still_uncertain");
    }
    // 期望路线破坏：from 错 / to 错（期望端点来自 payload，非记录）。
    {
      const scene = makeFnScene("s0-n1-route");
      scene.host.viewConfig.injected = [goodRecord(scene, "txn-0006", { from: "W20N57" })];
      expect(reconcileFn(scene)).toBe("still_uncertain");
      const scene2 = makeFnScene("s0-n1-route");
      scene2.host.viewConfig.injected = [goodRecord(scene2, "txn-0007", { to: "W30N57" })];
      expect(reconcileFn(scene2)).toBe("still_uncertain");
    }
    // 资源/全量破坏：resourceType 错 / amount 99（部分量同族——不报全量）。
    {
      const scene = makeFnScene("s0-n1-amt");
      scene.host.viewConfig.injected = [goodRecord(scene, "txn-0008", { resourceType: "energy" })];
      expect(reconcileFn(scene)).toBe("still_uncertain");
      const scene2 = makeFnScene("s0-n1-amt");
      scene2.host.viewConfig.injected = [goodRecord(scene2, "txn-0009", { amount: 99 })];
      expect(reconcileFn(scene2)).toBe("still_uncertain");
    }
    // 旧 v1 payload 不可解释——保守 uncertain，不猜测补齐身份、不静默升级。
    {
      const scene = makeFnScene("s0-n1-v1");
      scene.host.viewConfig.injected = [goodRecord(scene, "txn-0010")];
      expect(reconcileFn(scene, `k:s0-n1-v1|a:100|f:${String(scene.fee)}|sb:1000,10000|tb:0`)).toBe("still_uncertain");
    }
    // 无记录 / dropAll / 读异常。
    {
      const scene = makeFnScene("s0-n1-none");
      expect(reconcileFn(scene)).toBe("still_uncertain");
      scene.host.viewConfig.dropAll = true;
      expect(reconcileFn(scene)).toBe("still_uncertain");
      scene.host.viewConfig.dropAll = false;
      scene.host.viewConfig.failIncoming = true;
      expect(reconcileFn(scene)).toBe("still_uncertain");
    }
  });

  it("N02：同 ID 副本一致去重/矛盾顺序无关阻断；旧记录不认领；多 ID/带 order/当前 tick 保守；无关噪声不阻断正确唯一记录", () => {
    // 两视图一致镜像（同 ID 同内容）→ 归并为一条事实 → committed。
    {
      const scene = makeFnScene("s0-n2-mirror");
      const good = goodRecord(scene, "txn-0001");
      scene.host.viewConfig.injectedOutgoing = [good];
      scene.host.viewConfig.injectedIncoming = [good];
      expect(reconcileFn(scene)).toBe("observed_committed");
    }
    // 同 ID 镜像描述矛盾：out=期望/inc=矛盾 与交换顺序都拒绝（顺序无关）。
    {
      const scene = makeFnScene("s0-n2-conflict");
      scene.host.viewConfig.injectedOutgoing = [goodRecord(scene, "txn-0002")];
      scene.host.viewConfig.injectedIncoming = [goodRecord(scene, "txn-0002", { description: "treasury-slice0 someone-else" })];
      expect(reconcileFn(scene)).toBe("still_uncertain");
      const scene2 = makeFnScene("s0-n2-conflict");
      scene2.host.viewConfig.injectedOutgoing = [goodRecord(scene2, "txn-0002", { description: "treasury-slice0 someone-else" })];
      scene2.host.viewConfig.injectedIncoming = [goodRecord(scene2, "txn-0002")];
      expect(reconcileFn(scene2)).toBe("still_uncertain"); // 顺序交换同样拒绝
    }
    // 同视图重复同 ID：仅描述矛盾 / 仅时点矛盾——均拒绝（基线 R1d）。
    {
      const scene = makeFnScene("s0-n2-dup");
      scene.host.viewConfig.injected = [
        goodRecord(scene, "txn-0003"),
        goodRecord(scene, "txn-0003", { description: "treasury-slice0 someone-else" }),
      ];
      expect(reconcileFn(scene)).toBe("still_uncertain");
      const scene2 = makeFnScene("s0-n2-dup");
      scene2.host.viewConfig.injected = [
        goodRecord(scene2, "txn-0003"),
        goodRecord(scene2, "txn-0003", { time: scene2.preparedTick + 1 }),
      ];
      expect(reconcileFn(scene2)).toBe("still_uncertain");
      // 一致副本（同视图重复同内容）可归并。
      const scene3 = makeFnScene("s0-n2-dup");
      const good = goodRecord(scene3, "txn-0003");
      scene3.host.viewConfig.injected = [good, { ...good }];
      expect(reconcileFn(scene3)).toBe("observed_committed");
    }
    // 本请求之前的旧记录（time < preparedTick）不被认领；与正确记录并存时
    // 正确唯一记录完成（§4.3.5）。
    {
      const scene = makeFnScene("s0-n2-old");
      scene.host.viewConfig.injected = [goodRecord(scene, "txn-0004", { time: scene.preparedTick - 1 })];
      expect(reconcileFn(scene)).toBe("still_uncertain");
      const scene2 = makeFnScene("s0-n2-old");
      scene2.host.viewConfig.injected = [
        goodRecord(scene2, "txn-0004", { time: scene2.preparedTick - 1 }),
        goodRecord(scene2, "txn-0005"),
      ];
      expect(reconcileFn(scene2)).toBe("observed_committed");
    }
    // 当前 tick 记录（time === Game.time）——单纯刷新观察不结算。
    {
      const scene = makeFnScene("s0-n2-now");
      scene.host.viewConfig.injected = [goodRecord(scene, "txn-0006", { time: Game.time })];
      expect(reconcileFn(scene)).toBe("still_uncertain");
    }
    // 多个不同交易 ID 完全匹配——不能任选一个。
    {
      const scene = makeFnScene("s0-n2-multi");
      scene.host.viewConfig.injected = [goodRecord(scene, "txn-0007"), goodRecord(scene, "txn-0008")];
      expect(reconcileFn(scene)).toBe("still_uncertain");
    }
    // 市场订单记录不作 send 证据；与正确记录并存时不阻断（无关噪声）。
    {
      const scene = makeFnScene("s0-n2-order");
      scene.host.viewConfig.injected = [{ ...goodRecord(scene, "txn-0009"), order: { id: "ord-1" } }];
      expect(reconcileFn(scene)).toBe("still_uncertain");
      const scene2 = makeFnScene("s0-n2-order");
      scene2.host.viewConfig.injected = [
        { ...goodRecord(scene2, "txn-0009"), order: { id: "ord-1" } },
        goodRecord(scene2, "txn-0010"),
      ];
      expect(reconcileFn(scene2)).toBe("observed_committed");
    }
  });

  it("N01/N02：关键错误归属经注册 settle 入口保持 unknown 与持久 phase；正确对照完成", () => {
    // 错路线（基线 R1c）：请求 A→B，注入 C→D 记录且 C/D 数值恰好吻合终态
    // ——期望端点来自持久 payload（A/B），错路线不被认领。
    {
      const rooms = [
        ...slice0SceneRooms(),
        { name: "W20N57", terminal: { id: "term-C", resources: { H: 900, energy: 9974 }, freeCapacity: 100_000 } },
        { name: "W30N57", terminal: { id: "term-D", resources: { H: 100, energy: 0 }, freeCapacity: 100_000 } },
      ];
      const scene = freshScene(rooms);
      const attemptId = submit(scene, "biz:slice0:n-reg1", "s0-reg1");
      scene.service.endTick();
      Game.time += 1;
      scene.service.beginTick();
      // A/B 未处理不变；C/D 库存已吻合"已发生"数值。
      scene.host.viewConfig.injected = [
        {
          transactionId: "txn-9201",
          time: Game.time - 1,
          sender: { username: SLICE0_USERNAME },
          recipient: { username: SLICE0_USERNAME },
          resourceType: SLICE0_TRANSFER_RESOURCE,
          amount: SLICE0_TRANSFER_AMOUNT,
          from: "W20N57",
          to: "W30N57",
          description: "treasury-slice0 s0-reg1",
        },
      ];
      expect(scene.service.settleUnknownOutcome({ attemptId }).status).toBe("still_uncertain");
      expect(recordShape(attemptId)?.phase).toBe("outcome_unknown");
      expect(activeIds()).toContain(attemptId); // 责任保留
    }
    // 同 ID 镜像矛盾（注册路径）。
    {
      const scene = freshScene();
      const attemptId = submit(scene, "biz:slice0:n-reg2", "s0-reg2");
      scene.service.endTick();
      Game.time += 1;
      scene.service.beginTick();
      setStock(SOURCE_ROOM, { H: 900, energy: 10_000 - scene.fee });
      setStock(TARGET_ROOM, { H: 100, energy: 2000 });
      const good: TerminalTransactionRecord = {
        transactionId: "txn-9202",
        time: Game.time - 1,
        sender: { username: SLICE0_USERNAME },
        recipient: { username: SLICE0_USERNAME },
        resourceType: SLICE0_TRANSFER_RESOURCE,
        amount: SLICE0_TRANSFER_AMOUNT,
        from: SOURCE_ROOM,
        to: TARGET_ROOM,
        description: "treasury-slice0 s0-reg2",
      };
      scene.host.viewConfig.injectedOutgoing = [good];
      scene.host.viewConfig.injectedIncoming = [{ ...good, description: "treasury-slice0 someone-else" }];
      expect(scene.service.settleUnknownOutcome({ attemptId }).status).toBe("still_uncertain");
      expect(recordShape(attemptId)?.phase).toBe("outcome_unknown");
    }
    // 双方身份错误（注册路径）。
    {
      const scene = freshScene();
      const attemptId = submit(scene, "biz:slice0:n-reg3", "s0-reg3");
      scene.service.endTick();
      Game.time += 1;
      scene.service.beginTick();
      setStock(SOURCE_ROOM, { H: 900, energy: 10_000 - scene.fee });
      setStock(TARGET_ROOM, { H: 100, energy: 2000 });
      scene.host.viewConfig.injected = [
        {
          transactionId: "txn-9203",
          time: Game.time - 1,
          sender: { username: "intruder" },
          recipient: { username: SLICE0_USERNAME },
          resourceType: SLICE0_TRANSFER_RESOURCE,
          amount: SLICE0_TRANSFER_AMOUNT,
          from: SOURCE_ROOM,
          to: TARGET_ROOM,
          description: "treasury-slice0 s0-reg3",
        },
      ];
      expect(scene.service.settleUnknownOutcome({ attemptId }).status).toBe("still_uncertain");
      expect(recordShape(attemptId)?.phase).toBe("outcome_unknown");
    }
    // 对照：正确唯一记录经注册路径完成并退出。
    {
      const scene = freshScene();
      const attemptId = submit(scene, "biz:slice0:n-reg4", "s0-reg4");
      processAndAdvance(scene);
      expect(scene.service.settleUnknownOutcome({ attemptId }).status).toBe("ok");
      expect(recordShape(attemptId)?.outcome).toBe("committed");
      expect(recordShape(attemptId)?.phase).toBe("closing");
      advanceTick(scene.service);
      expect(activeIds()).not.toContain(attemptId);
    }
  });

  it("N03：不同 workKey/关联键的 B 经第二协调器被拒；通用 facade 直连不受门禁保护（入口边界对照）", () => {
    const scene = freshScene();
    submit(scene, "biz:slice0:req-A", "s0-keyA"); // A unknown——占用单条在途
    // 第二协调器实例（同 service/host）——门禁从持久 active 读出，跨实例成立。
    const secondCoordinator = createSlice0TransferCoordinator({
      host: scene.host,
      service: scene.service,
      buildContract: (args, workKey) => buildTreasuryActionContract(scene.service, { actionKind: SLICE0_ACTION_KIND, transactionId: workKey, args }),
    });
    const b = secondCoordinator.requestTransfer({ workKey: "biz:slice0:req-B", correlationKey: "s0-keyB" });
    expect(b.status).toBe("rejected");
    if (b.status === "rejected") {
      expect(b.stage).toBe("single-flight");
      expect(b.reason).toMatch(/单条在途/);
      expect(b.reason).not.toMatch(/窗口|额度|过期/); // 拒绝理由指向在途责任
    }
    expect(scene.host.submits.length).toBe(1); // 只有 A 一次提交
    // 通用 facade 直连对照（§5 入口边界）：低层无此全局规则——第二张许可
    // 可获得，因此业务用例必须从协调器进入（不作为业务行为断言）。
    const direct = admit(scene.service, "biz:slice0:req-B-direct", prepareSlice0TransferArgs(scene.host, SOURCE_ROOM, TARGET_ROOM, "s0-keyBd"));
    expect(direct.status).toBe("admitted");
    expect(scene.host.submits.length).toBe(1); // 直连只接纳未执行——不提交
  });

  it("N03：完整 reset 到开放 tick 后 B 仍被持久 active 阻断（理由为单条在途）；A 收尾退出后 B 正常接纳", () => {
    const scene = freshScene();
    const attemptId = submit(scene, "biz:slice0:req-A", "s0-keyA");
    scene.service.endTick();
    const breakpoint = captureTreasuryHostBreakpoint(scene.host.captureBranch());
    const restored = performTreasuryFullReset({
      roomSpecs: slice0SceneRooms(),
      adapter: makeTerminalTransferPrototypeAdapter(scene.host),
      breakpoint,
    });
    const restoredService = restored.service;
    const contracts = restored.handles.actionContractsModule;
    // 推进到下一合法开放 tick（断点捕获于 endTick 后）——B 的其他条件成立，
    // 拒绝必须来自持久 active 的单条在途（跨 reset、跨协调器实例）。
    restoredService.endTick();
    Game.time += 1;
    restoredService.beginTick();
    const coordinator = createSlice0TransferCoordinator({
      host: scene.host,
      service: restoredService,
      buildContract: (args, workKey) => contracts.buildTreasuryActionContract(restoredService, { actionKind: SLICE0_ACTION_KIND, transactionId: workKey, args }),
    });
    const b1 = coordinator.requestTransfer({ workKey: "biz:slice0:req-B", correlationKey: "s0-keyB" });
    expect(b1.status).toBe("rejected");
    if (b1.status === "rejected") {
      expect(b1.stage).toBe("single-flight");
      expect(b1.reason).toMatch(/单条在途/);
      expect(b1.reason).not.toMatch(/窗口|额度|过期/);
    }
    // A 收尾退出（处理 → 新 tick → 结算 → 退出）。
    restoredService.endTick();
    scene.host.processPendingRequests();
    Game.time += 1;
    restoredService.beginTick();
    expect(restoredService.settleUnknownOutcome({ attemptId }).status).toBe("ok");
    restoredService.endTick();
    Game.time += 1;
    restoredService.beginTick();
    expect(activeIds()).not.toContain(attemptId);
    // 退出后 B 正常接纳（不同 workKey/关联键不再被阻断）。
    const b2 = coordinator.requestTransfer({ workKey: "biz:slice0:req-B2", correlationKey: "s0-keyB2" });
    expect(b2.status).toBe("admitted");
    expect(scene.host.submits.length).toBe(1); // 全程仍只有 A 一次提交
  });

  it("N03：A closing 期间 B 阻断；A 退出并越过冷却后 B 经业务入口完整闭环（恰两次提交）", () => {
    const scene = freshScene();
    const aId = submit(scene, "biz:slice0:req-A", "s0-keyA");
    processAndAdvance(scene); // tick 0 处理——cooldownUntil=10
    expect(scene.service.settleUnknownOutcome({ attemptId: aId }).status).toBe("ok");
    expect(recordShape(aId)?.phase).toBe("closing"); // A 已结算仍在退出流程
    const b1 = scene.coordinator.requestTransfer({ workKey: "biz:slice0:req-B", correlationKey: "s0-keyB" });
    expect(b1.status).toBe("rejected");
    if (b1.status === "rejected") {
      expect(b1.stage).toBe("single-flight");
      expect(b1.reason).toMatch(/单条在途/);
    }
    advanceTick(scene.service); // tick 2：A 退出
    expect(activeIds()).not.toContain(aId);
    // 冷却允许时执行：推进到 tick 11（cooldownUntil=10 已过）再接纳并执行 B。
    advanceTicks(scene.service, 9);
    const b2 = scene.coordinator.requestTransfer({ workKey: "biz:slice0:req-B2", correlationKey: "s0-keyB2" });
    expect(b2.status).toBe("admitted");
    const exec = scene.coordinator.executeTransfer(b2);
    expect(exec.status).toBe("unknown"); // 冷却已过——submit 被接受
    expect(scene.host.submits.length).toBe(2);
    processAndAdvance(scene); // tick 11 处理
    expect(scene.service.settleUnknownOutcome({ attemptId: b2.status === "admitted" ? b2.attemptId : "" }).status).toBe("ok");
    advanceTick(scene.service);
    expect(activeIds()).not.toContain(b2.status === "admitted" ? b2.attemptId : "");
    // 终态：A、B 各一次完整调拨（恰两次提交、源 −200H、fee×2、目标 +200H）。
    expect(scene.host.submits.length).toBe(2);
    expect(stock(SOURCE_ROOM, SLICE0_TRANSFER_RESOURCE)).toBe(800);
    expect(stock(SOURCE_ROOM, "energy")).toBe(10_000 - scene.fee * 2);
    expect(stock(TARGET_ROOM, SLICE0_TRANSFER_RESOURCE)).toBe(200);
  });

  it("N05：q→q+5 不再查/再查/其他准备报价/读异常均零提交；前检与 adapter guard 双覆盖；恢复与新报价闭环对照", () => {
    // (a) 业务前检路径：漂移拒绝（许可未消费）→ 恢复报价后完成 100H 闭环。
    {
      const scene = freshScene();
      const admission = expectAdmitted(scene.coordinator.requestTransfer({ workKey: "biz:slice0:n5a", correlationKey: "s0-n5a" }));
      const q = admission.quote;
      scene.host.configureFeeDrift(5);
      const rejected = scene.coordinator.executeTransfer(admission);
      expect(rejected.status).toBe("rejected");
      if (rejected.status === "rejected") {
        expect(rejected.stage).toBe("precheck");
        expect(rejected.reason).toMatch(/ERR_FEE_QUOTE_DRIFTED/);
      }
      expect(scene.host.submits.length).toBe(0); // 零提交（直接检查计数）
      expect(recordShape(admission.attemptId)?.phase).toBe("pending"); // 许可未消费
      // 恢复原报价——未消费请求按原有效期完成闭环，实际费用与冻结 q 相同。
      scene.host.configureFeeDrift(0);
      const exec = scene.coordinator.executeTransfer(admission);
      expect(exec.status).toBe("unknown");
      processAndAdvance(scene);
      expect(scene.service.settleUnknownOutcome({ attemptId: admission.attemptId }).status).toBe("ok");
      advanceTick(scene.service);
      expect(stock(SOURCE_ROOM, "energy")).toBe(10_000 - q);
      expect(stock(TARGET_ROOM, SLICE0_TRANSFER_RESOURCE)).toBe(SLICE0_TRANSFER_AMOUNT);
      expect(scene.host.submits.length).toBe(1);
    }
    // (b) 漂移后再查询一次/多次——旧请求仍零提交（无 lastQuote 可被刷新）。
    {
      const scene = freshScene();
      const admission = expectAdmitted(scene.coordinator.requestTransfer({ workKey: "biz:slice0:n5b", correlationKey: "s0-n5b" }));
      scene.host.configureFeeDrift(5);
      scene.host.quoteTransferFee(SLICE0_TRANSFER_AMOUNT, SOURCE_ROOM, TARGET_ROOM);
      scene.host.quoteTransferFee(SLICE0_TRANSFER_AMOUNT, SOURCE_ROOM, TARGET_ROOM);
      const rejected = scene.coordinator.executeTransfer(admission);
      expect(rejected.status).toBe("rejected");
      if (rejected.status === "rejected") expect(rejected.stage).toBe("precheck");
      expect(scene.host.submits.length).toBe(0);
    }
    // (c) 另一个未执行准备过程进行报价 + 绕过业务前检直接提交真许可给
    // facade——到达 adapter guard：零提交、许可已消费、责任保守保留。
    {
      const scene = freshScene();
      const admission = expectAdmitted(scene.coordinator.requestTransfer({ workKey: "biz:slice0:n5c", correlationKey: "s0-n5c" }));
      scene.host.configureFeeDrift(5);
      prepareSlice0TransferArgs(scene.host, SOURCE_ROOM, TARGET_ROOM, "s0-n5-other"); // 另一准备过程报价
      const outcome = scene.service.executeAuthorizedDispatch(admission.dispatch as never);
      expect(outcome.status).toBe("unknown"); // nonOkOutcome=unknown——不伪造 not_executed
      expect(scene.host.submits.length).toBe(0); // guard 在调用 submit 端口之前拒绝
      expect(recordShape(admission.attemptId)?.phase).toBe("outcome_unknown");
      expect(scene.service.settleUnknownOutcome({ attemptId: admission.attemptId }).status).toBe("still_uncertain");
    }
    // (d) 报价读取异常——前检拒绝且零提交。
    {
      const scene = freshScene();
      const admission = expectAdmitted(scene.coordinator.requestTransfer({ workKey: "biz:slice0:n5d", correlationKey: "s0-n5d" }));
      scene.host.configureQuoteFailure(true);
      const rejected = scene.coordinator.executeTransfer(admission);
      expect(rejected.status).toBe("rejected");
      if (rejected.status === "rejected") {
        expect(rejected.stage).toBe("precheck");
        expect(rejected.reason).toMatch(/ERR_FEE_QUOTE_UNAVAILABLE/);
      }
      expect(scene.host.submits.length).toBe(0);
      scene.host.configureQuoteFailure(false);
    }
    // (e) 报价非法值（负数）——adapter guard 同样零提交。
    {
      const scene = freshScene();
      const admission = expectAdmitted(scene.coordinator.requestTransfer({ workKey: "biz:slice0:n5e", correlationKey: "s0-n5e" }));
      scene.host.configureFeeDrift(-999);
      const outcome = scene.service.executeAuthorizedDispatch(admission.dispatch as never);
      expect(outcome.status).toBe("unknown");
      expect(scene.host.submits.length).toBe(0);
    }
    // (f) 独立合法场景：报价 q+5 下准备的新请求完整闭环（实际费用与新授权相同）。
    {
      const s2 = freshScene();
      s2.host.configureFeeDrift(5);
      const admission = expectAdmitted(s2.coordinator.requestTransfer({ workKey: "biz:slice0:n5f", correlationKey: "s0-n5f" }));
      expect(admission.quote).toBe(s2.fee + 5);
      const exec = s2.coordinator.executeTransfer(admission);
      expect(exec.status).toBe("unknown");
      processAndAdvance(s2);
      expect(s2.service.settleUnknownOutcome({ attemptId: admission.attemptId }).status).toBe("ok");
      advanceTick(s2.service);
      expect(stock(SOURCE_ROOM, "energy")).toBe(10_000 - (s2.fee + 5));
      expect(s2.host.submits.length).toBe(1);
    }
  });

  it("N06：canonical/postings/permit/active/durable 费用与身份同源且重复派生稳定；无 retry、不回填旧事实", () => {
    const scene = freshScene();
    const adapter = findTreasuryActionAdapter(SLICE0_ACTION_KIND) as unknown as TerminalTransferPrototypeAdapter;
    const args = prepareSlice0TransferArgs(scene.host, SOURCE_ROOM, TARGET_ROOM, "s0-n6");
    // 重复派生稳定（R7：build 与 authorize 的 buildIdentityFacts 重复调用、
    // derivePostings/durableFacts 纯函数——同一准备时刻）。
    const payloadOnce = adapter.durableFacts(args).payload;
    expect(adapter.durableFacts(args).payload).toBe(payloadOnce);
    const postingsOnce = adapter.derivePostings(args);
    expect(JSON.stringify(adapter.derivePostings(args))).toBe(JSON.stringify(postingsOnce));
    const feeLeg = postingsOnce.find((p) => p.resource === "energy");
    expect(feeLeg?.delta).toBe(-args.prepared.feeQuote);
    // 注册路径同源：permit.postings、active.worstCase 费用腿、持久 durable
    // payload 与 canonical 冻结 q 全部同一值。
    const admission = scene.coordinator.requestTransfer({ workKey: "biz:slice0:n6", correlationKey: "s0-n6" });
    expect(admission.status).toBe("admitted");
    if (admission.status === "admitted") {
      const sorted = (items: readonly unknown[]): string[] => items.map((p) => JSON.stringify(p)).sort();
      const permitPostings = (admission.dispatch as unknown as { postings?: unknown[] }).postings ?? [];
      expect(sorted(permitPostings)).toEqual(sorted(adapter.derivePostings(admission.args)));
      const record = coreRecord(admission.attemptId);
      expect(record.identity?.durableFacts?.payload).toBe(adapter.durableFacts(admission.args).payload);
      expect(record.worstCase?.some((leg) => leg.resource === "energy" && leg.delta === -admission.quote)).toBe(true);
      // 重复授权（同 args、不同 workKey——直连低层隔离）得到同一持久事实。
      const second = admit(scene.service, "biz:slice0:n6-bis", args);
      expect(second.status).toBe("admitted");
      if (second.attemptId !== undefined) {
        expect(coreRecord(second.attemptId).identity?.durableFacts?.payload).toBe(adapter.durableFacts(args).payload);
      }
      // 报价漂移不回填旧事实：permit 冻结不变、active worstCase 不变、
      // durable payload 不变（再次报价/重复派生不得改变已签发请求）。
      scene.host.configureFeeDrift(5);
      scene.host.quoteTransferFee(SLICE0_TRANSFER_AMOUNT, SOURCE_ROOM, TARGET_ROOM);
      expect(coreRecord(admission.attemptId).worstCase?.some((leg) => leg.resource === "energy" && leg.delta === -admission.quote)).toBe(true);
      expect(adapter.durableFacts(admission.args).payload).toBe(payloadOnce);
      expect(sorted((admission.dispatch as unknown as { postings?: unknown[] }).postings ?? [])).toEqual(sorted(permitPostings));
    }
    // 无自动 retry——adapter 不提供 retryFacts（重试关闭，§6.2）。
    expect("retryFacts" in adapter).toBe(false);
  });
});
