/**
 * Terminal Transfer Slice 0——M03–M07 行为验收（任务书 §4–§5；
 * Remediation I 后经测试专用业务入口重跑，N04）。
 *
 * - M03：原型仅测试装配（隔离新模块的真实默认注册表无此 kind）；canonical
 *   参数派生一致的三腿 postings／结构绑定／durable facts（payload v2）。
 * - M04：正常 100H+fee 可接纳；资源／费用能源／目标容量／结构替换／超场景
 *   输入各自明确拒绝且提交增量 0（submits 计数直接断言）；恢复合法条件后成功。
 * - M05/N04：延迟完成正向闭环（经业务入口）——OK 当 tick 仍 unknown 且责任
 *   保留；处理与新 tick 观察后唯一全量记录结算退出；源/目标/fee 计数吻合、
 *   恰一次提交。
 * - M06：无记录／窗口缺失／读异常／他人与市场订单记录／重复交易 ID／
 *   实际部分量均不报全量完成、不补发；两视图同一交易不重复计数。
 * - M07/N03/N04：提交后结果持久化前与已接受未处理两类断点（经业务入口），
 *   配对宿主状态完整重载；先保持 unknown，可见事实到达后收尾；旧许可拒绝、
 *   第二需求（不同 workKey）被单条在途阻断。
 *
 * M01/M02/M08 由 scripts/verify-treasury-evidence.mjs 实跑、openspec
 * terminal-transfer-slice-0.md 短报告与固定 SHA 主验证承担（非 Jest 范围）。
 * N01–N06 的 Remediation I 反例见 treasuryTerminalTransferSlice0RemediationI.test.ts。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import {
  buildTreasuryActionContract,
  findTreasuryActionAdapter,
  replaceTreasuryActionAdapterForTest,
  type TreasuryActionAdapter,
} from "@/runtime/treasury/actionContracts";
import { clearTreasuryPolicyResolversForTest, makeNoReserveTreasuryPolicy, registerTreasuryPolicyResolver } from "@/runtime/treasury/policyAuthority";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { installRooms, setStoreResources, type RoomSpec } from "@mock/treasury";
import { captureTreasuryHostBreakpoint, performTreasuryFullReset, type TreasuryHostBreakpoint } from "@mock/treasuryResetHarness";
import { createSlice0TransferCoordinator, type Slice0TransferCoordinator } from "@mock/treasuryTerminalTransferCoordinator";
import {
  SLICE0_ACTION_KIND,
  SLICE0_TRANSFER_AMOUNT,
  SLICE0_TRANSFER_RESOURCE,
  SLICE0_USERNAME,
  createTerminalTransferFakeHost,
  decodeSlice0DurablePayload,
  makeTerminalTransferPrototypeAdapter,
  prepareSlice0TransferArgs,
  slice0SceneRooms,
  type TerminalTransferArgs,
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

function sceneRooms(): RoomSpec[] {
  return slice0SceneRooms();
}

function makeScene(rooms: RoomSpec[] = sceneRooms()): Scene {
  const host = createTerminalTransferFakeHost();
  const installed = installRooms(rooms);
  replaceTreasuryActionAdapterForTest(makeTerminalTransferPrototypeAdapter(host));
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
  const service = createTreasuryService({ getRooms: () => Object.values(installed) });
  service.beginTick();
  // 业务入口（§5）：所有验证本业务的用例从这里进入。buildContract 绑定
  // 当前模块入口（完整 reset 后换绑新模块——见 M07/N03）。
  const coordinator = createSlice0TransferCoordinator({
    host,
    service,
    buildContract: (args, workKey) => buildTreasuryActionContract(service, { actionKind: SLICE0_ACTION_KIND, transactionId: workKey, args }),
  });
  return { host, service, coordinator, fee: host.quoteTransferFee(SLICE0_TRANSFER_AMOUNT, SOURCE_ROOM, TARGET_ROOM) };
}

/** 矩阵 it 内换场景：清上一场景未收尾的 active（本 it 测归属矩阵，不测单条在途门禁——门禁由 N03 专测）。 */
function freshScene(rooms?: RoomSpec[]): Scene {
  resetTreasuryCoreStoreForTest();
  return makeScene(rooms === undefined ? slice0SceneRooms() : rooms);
}

type AdmitResult = { status: string; attemptId?: string; dispatch?: { attemptId?: unknown } & object; reason?: string };

/**
 * 直连 facade 构建/授权（仅用于隔离低层行为的场景——M04 执行前条件变化、
 * N03 通用层对照；不承担业务门禁证明，§5 入口边界）。
 */
function admit(service: TreasuryService, workKey: string, args: unknown): AdmitResult {
  const built = buildTreasuryActionContract(service, { actionKind: SLICE0_ACTION_KIND, transactionId: workKey, args });
  if (built.status !== "built") return { status: `build:${built.status}`, reason: built.status === "rejected" ? built.reason : undefined };
  return service.authorizeTreasuryActionContract(built.contract, { workKey }) as AdmitResult;
}

/** 经业务入口提交一条调拨并执行（OK → outcome_unknown）。返回 attemptId。 */
function submit(scene: Scene, workKey: string, correlationKey: string): string {
  const admission = scene.coordinator.requestTransfer({ workKey, correlationKey });
  if (admission.status !== "admitted") throw new Error(`admit failed: ${admission.status} ${admission.reason}`);
  const execution = scene.coordinator.executeTransfer(admission);
  if (execution.status !== "unknown") throw new Error(`dispatch expected unknown, got ${execution.status} ${execution.reason}`);
  return admission.attemptId;
}

/** tick 推进：关窗 → tick+1 → 开窗（观察重建）。 */
function advanceTick(service: TreasuryService): void {
  service.endTick();
  Game.time += 1;
  service.beginTick();
}

function advanceTicks(service: TreasuryService, count: number): void {
  for (let i = 0; i < count; i += 1) advanceTick(service);
}

/** 处理阶段推进 + 新 tick（模拟"用户 tick 结束后处理、下一 tick 可见"）。 */
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

/**
 * O04（Remediation II §5）：账目投影断言口径——经会消费占用的真实接口
 * （query 保留 subtractOutgoing/subtractReservations，不传 false 绕过
 * kernel 占用；目标容量用统一风险口径 riskAdjustedFreeCapacity——
 * strictProjectedFreeCapacity 不承担同一扣减职责）。返回源 H/源 energy
 * 三元组、目标风险调整容量与 authorizationSafe/blockers（lifecycle 语义
 * 如实呈现：endTick 后断点的恢复 tick 窗口已关——safe=false 但账目数字
 * 仍按真实占用计算，authorizable 不含 lifecycle，不是 fail-closed 的 0）。
 */
function projection(service: TreasuryService): {
  sourceH: { observed: number; committed: number; spendable: number };
  sourceEnergy: { observed: number; committed: number; spendable: number };
  targetRiskAdjusted: number;
  safe: boolean;
  blockers: string[];
} {
  const read = (resource: string) => {
    const view = service.query({
      resource,
      rooms: [SOURCE_ROOM],
      locations: ["terminal"],
      allowProjected: false,
      allowIncoming: false,
      subtractOutgoing: true,
      subtractReservations: true,
      withhold: 0,
    });
    return { observed: view.observed, committed: view.committed, spendable: view.spendable };
  };
  const gate = service.query({
    resource: SLICE0_TRANSFER_RESOURCE,
    rooms: [SOURCE_ROOM],
    locations: ["terminal"],
    allowProjected: false,
    allowIncoming: false,
    subtractOutgoing: true,
    subtractReservations: true,
    withhold: 0,
  });
  return {
    sourceH: read(SLICE0_TRANSFER_RESOURCE),
    sourceEnergy: read("energy"),
    targetRiskAdjusted: service.riskAdjustedFreeCapacity(TARGET_ROOM, "terminal"),
    safe: gate.authorizationSafe,
    blockers: [...gate.authorizationBlockers],
  };
}

/** 断点 1 捕获包装：submit 返回后、dispatch_result 写入前捕获宿主断点。 */
function wrapWithPostSubmitCapture(
  host: TerminalTransferFakeHost,
  holder: { breakpoint?: TreasuryHostBreakpoint },
): TreasuryActionAdapter {
  const base = makeTerminalTransferPrototypeAdapter(host);
  return {
    ...base,
    execute(args: TerminalTransferArgs): { ok: boolean; code?: string } {
      const result = base.execute(args);
      if (result.ok && holder.breakpoint === undefined) {
        holder.breakpoint = captureTreasuryHostBreakpoint(host.captureBranch());
      }
      return result;
    },
  } as unknown as TreasuryActionAdapter;
}

/** 恢复装配：断点（Memory+世界+宿主分支配对）→ 新 service（beginTick 已跑）。 */
function restoreFromBreakpoint(
  scene: Pick<Scene, "host" | "service">,
  breakpoint: TreasuryHostBreakpoint,
  adapter?: TreasuryActionAdapter,
): { service: TreasuryService; contracts: typeof import("@/runtime/treasury/actionContracts") } {
  const restored = performTreasuryFullReset({
    roomSpecs: sceneRooms(),
    adapter: adapter ?? makeTerminalTransferPrototypeAdapter(scene.host),
    breakpoint,
  });
  return { service: restored.service, contracts: restored.handles.actionContractsModule };
}

/** 恢复后的业务协调器：绑定新 service 与**新模块**的 contract 构建入口。 */
function coordinatorRestored(
  host: TerminalTransferFakeHost,
  restored: { service: TreasuryService; contracts: typeof import("@/runtime/treasury/actionContracts") },
): Slice0TransferCoordinator {
  return createSlice0TransferCoordinator({
    host,
    service: restored.service,
    buildContract: (args, workKey) => restored.contracts.buildTreasuryActionContract(restored.service, { actionKind: SLICE0_ACTION_KIND, transactionId: workKey, args }),
  });
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
  clearTreasuryPolicyResolversForTest();
});

describe("Terminal Transfer Slice 0（M03–M07）", () => {
  it("M03：原型仅测试装配——隔离新模块默认注册表无此 kind；canonical 参数派生一致的三腿/结构绑定/durable facts（payload v2）", () => {
    // 默认无注册（§7.1 修订）：不再清空待检注册表——用隔离新模块的**真实
    // 默认装配**断言（actionContracts 的 registry 是模块级 Map；生产装配
    // runtimeServices 从不注册任何 adapter，只 seal）。
    let freshFind: typeof findTreasuryActionAdapter | undefined;
    jest.isolateModules(() => {
      freshFind = require("@/runtime/treasury/actionContracts").findTreasuryActionAdapter;
    });
    expect(freshFind!(SLICE0_ACTION_KIND)).toBeUndefined();
    const scene = freshScene();
    const args = prepareSlice0TransferArgs(scene.host, SOURCE_ROOM, TARGET_ROOM, "s0-0001");
    const built = buildTreasuryActionContract(scene.service, { actionKind: SLICE0_ACTION_KIND, transactionId: "biz:slice0:m03", args });
    expect(built.status).toBe("built");
    const admission = scene.service.authorizeTreasuryActionContract(built.status === "built" ? built.contract : undefined as never, { workKey: "biz:slice0:m03" });
    expect(admission.status).toBe("admitted");
    // canonical 一致（单一参数来源）：dispatch 许可携带的 postings 与
    // derivePostings(args) 同一集合（kernel 规范序为流入在前——集合比较）。
    const adapter = findTreasuryActionAdapter(SLICE0_ACTION_KIND) as unknown as TerminalTransferPrototypeAdapter;
    const permit = (admission as unknown as { dispatch: { postings?: unknown[]; canonicalArgs?: unknown } }).dispatch;
    const sortedPostings = (items: readonly unknown[]): string[] => items.map((p) => JSON.stringify(p)).sort();
    expect(sortedPostings(permit.postings ?? [])).toEqual(sortedPostings(adapter.derivePostings(args) as unknown as readonly unknown[]));
    const record = recordShape((admission as { attemptId: string }).attemptId);
    expect(record?.phase).toBe("pending");
    const durable = adapter.durableFacts(args);
    const payload = decodeSlice0DurablePayload(durable.payload);
    // payload v2：期望身份的全部事实（关联键/路线/全量/冻结费用/基线/准备
    // tick/合成用户）——reconcile 的期望值来源（Remediation I §4.1）。
    expect(payload?.k).toBe("s0-0001");
    expect(payload?.s).toBe(SOURCE_ROOM);
    expect(payload?.d).toBe(TARGET_ROOM);
    expect(payload?.a).toBe(SLICE0_TRANSFER_AMOUNT);
    expect(payload?.f).toBe(scene.fee);
    expect(payload?.sb).toEqual([1000, 10_000]);
    expect(payload?.tb).toEqual([0]);
    expect(payload?.t).toBe(Game.time);
    expect(payload?.u).toBe(SLICE0_USERNAME);
    // 结构绑定：source/fee_source/target 三声明（无生产注册、无网络发送能力
    // ——execute 只调注入端口，由后续各 it 的 submits 计数与 freeze 断言承担）。
    const bindings = adapter.structureBindings!(args);
    expect(bindings.map((b) => b.role)).toEqual(["source", "fee_source", "target"]);
  });

  it("M04：合法 100H+fee 可接纳执行为 unknown；执行前条件变化各自拒绝且提交增量 0", () => {
    const scene = freshScene();
    const attemptId = submit(scene, "biz:slice0:m04-ok", "s0-0100");
    expect(scene.host.pendingCount).toBe(1); // OK 只入 pending——延迟生效
    expect(scene.host.submits.length).toBe(1); // 恰一次提交
    expect(stock(SOURCE_ROOM, SLICE0_TRANSFER_RESOURCE)).toBe(1000); // 世界未变
    expect(recordShape(attemptId)?.phase).toBe("outcome_unknown");

    // 仅降低货物 H（授权后、执行前）→ 拒绝且零提交。
    {
      const s2 = freshScene();
      const admission = admit(s2.service, "biz:slice0:m04-h", prepareSlice0TransferArgs(s2.host, SOURCE_ROOM, TARGET_ROOM, "s0-0101"));
      expect(admission.status).toBe("admitted");
      setStoreResources((Game.rooms as unknown as Record<string, { terminal: StructureTerminal }>)[SOURCE_ROOM].terminal, { H: 50, energy: 10_000 });
      const outcome = s2.service.executeAuthorizedDispatch(admission.dispatch);
      expect(outcome.status).not.toBe("committed");
      expect(s2.host.pendingCount).toBe(0);
      expect(s2.host.submits.length).toBe(0);
    }
    // 仅降低费用能源（< fee）→ 拒绝且零提交。
    {
      const s2 = freshScene();
      const admission = admit(s2.service, "biz:slice0:m04-fee", prepareSlice0TransferArgs(s2.host, SOURCE_ROOM, TARGET_ROOM, "s0-0102"));
      expect(admission.status).toBe("admitted");
      setStoreResources((Game.rooms as unknown as Record<string, { terminal: StructureTerminal }>)[SOURCE_ROOM].terminal, { H: 1000, energy: scene.fee - 1 });
      const outcome = s2.service.executeAuthorizedDispatch(admission.dispatch);
      expect(outcome.status).not.toBe("committed");
      expect(s2.host.pendingCount).toBe(0);
      expect(s2.host.submits.length).toBe(0);
    }
    // 目标空位不足（freeCapacity=50 < 100）→ 明确拒绝（授权或执行层）。
    {
      const s2 = freshScene(slice0SceneRooms({ targetFreeCapacity: 50 }));
      const admission = admit(s2.service, "biz:slice0:m04-cap", prepareSlice0TransferArgs(s2.host, SOURCE_ROOM, TARGET_ROOM, "s0-0103"));
      if (admission.status === "admitted") {
        const outcome = s2.service.executeAuthorizedDispatch(admission.dispatch);
        expect(outcome.status).not.toBe("committed");
      } else {
        expect(admission.status).toMatch(/rejected|build/);
      }
      expect(s2.host.pendingCount).toBe(0);
      expect(s2.host.submits.length).toBe(0);
      expect(stock(TARGET_ROOM, SLICE0_TRANSFER_RESOURCE)).toBe(0);
    }
    // 源结构替换（incarnation 变化）→ 执行层拒绝且零提交。
    {
      const s2 = freshScene();
      const admission = admit(s2.service, "biz:slice0:m04-inc", prepareSlice0TransferArgs(s2.host, SOURCE_ROOM, TARGET_ROOM, "s0-0104"));
      expect(admission.status).toBe("admitted");
      const rooms = Game.rooms as unknown as Record<string, { terminal: { id: string; store: Record<string, number> } }>;
      rooms[SOURCE_ROOM].terminal = { id: "term-A-rebuilt", store: rooms[SOURCE_ROOM].terminal.store };
      const outcome = s2.service.executeAuthorizedDispatch(admission.dispatch);
      expect(outcome.status).not.toBe("committed");
      expect(s2.host.pendingCount).toBe(0);
      expect(s2.host.submits.length).toBe(0);
    }
  });

  it("M04：超场景输入拒绝（amount/resource/关联键/场景外目标）；恢复合法条件后正常成功", () => {
    const scene = freshScene();
    // amount ≠ 100 / resource ≠ H / 非法关联键——validate 层拒绝（contract 不构建）。
    const badAmount = admit(scene.service, "biz:slice0:m04-amount", { ...prepareSlice0TransferArgs(scene.host, SOURCE_ROOM, TARGET_ROOM, "s0-0201"), amount: 101 });
    expect(badAmount.status).toMatch(/build:rejected/);
    const badResource = admit(scene.service, "biz:slice0:m04-resource", { ...prepareSlice0TransferArgs(scene.host, SOURCE_ROOM, TARGET_ROOM, "s0-0202"), resourceType: "energy" });
    expect(badResource.status).toMatch(/build:rejected/);
    const badKey = admit(scene.service, "biz:slice0:m04-key", prepareSlice0TransferArgs(scene.host, SOURCE_ROOM, TARGET_ROOM, "bad key!"));
    expect(badKey.status).toMatch(/build:rejected/);
    // 场景外目标（E5N59 无 terminal）——结构不存在，授权层拒绝。
    const outside = admit(scene.service, "biz:slice0:m04-outside", prepareSlice0TransferArgs(scene.host, SOURCE_ROOM, "E5N59", "s0-0203"));
    expect(outside.status).not.toBe("admitted");
    expect(scene.host.pendingCount).toBe(0);
    // 恢复合法输入后正常成功（同一场景仍可继续）。
    const attemptId = submit(scene, "biz:slice0:m04-recover", "s0-0204");
    expect(recordShape(attemptId)?.phase).toBe("outcome_unknown");
    expect(scene.host.pendingCount).toBe(1);
  });

  it("M05/N04：延迟完成正向闭环（经业务入口）——当 tick 仍 unknown；处理与新观察后唯一全量记录结算退出；计数吻合不双扣", () => {
    const scene = freshScene();
    const attemptId = submit(scene, "biz:slice0:m05", "s0-0300");
    // OK 之后当 tick：无记录、库存未变——settle 仍 unknown，责任保留。
    expect(scene.host.transactions.length).toBe(0);
    expect(scene.service.settleUnknownOutcome({ attemptId }).status).toBe("still_uncertain");
    expect(recordShape(attemptId)?.outcome).toBe("unknown"); // 结论仍是 unknown——无完成覆盖
    expect(recordShape(attemptId)?.phase).toBe("outcome_unknown");
    expect(activeIds()).toContain(attemptId); // 完成前占用保留
    // O04（Remediation II §5.2）：unknown 阶段保守占用——物理未变
    // （1000/10000/F0），worstCase 占用保留 100H/fee/100 空位责任。
    const unknownProj = projection(scene.service);
    expect(unknownProj.sourceH).toEqual({ observed: 1000, committed: SLICE0_TRANSFER_AMOUNT, spendable: 900 });
    expect(unknownProj.sourceEnergy).toEqual({ observed: 10_000, committed: scene.fee, spendable: 10_000 - scene.fee });
    expect(unknownProj.safe).toBe(true);
    expect(unknownProj.blockers).toEqual([]);
    expect(unknownProj.targetRiskAdjusted).toBe(100_000 - SLICE0_TRANSFER_AMOUNT);
    // 处理阶段（tick T 后期）→ 新 tick（T+1）效果与记录可见。
    processAndAdvance(scene);
    const txn = scene.host.transactions[0];
    expect(txn?.amount).toBe(SLICE0_TRANSFER_AMOUNT);
    expect(txn?.resourceType).toBe(SLICE0_TRANSFER_RESOURCE);
    expect(txn?.from).toBe(SOURCE_ROOM);
    expect(txn?.to).toBe(TARGET_ROOM);
    expect(txn?.description).toBe(`treasury-slice0 s0-0300`);
    expect(scene.service.settleUnknownOutcome({ attemptId }).status).toBe("ok");
    expect(recordShape(attemptId)?.outcome).toBe("committed");
    expect(recordShape(attemptId)?.phase).toBe("closing"); // 进入退出流程
    // O04（§5.1）：closing 尚未退出时核对国库不双扣——同一效果已进入观察
    // （占用释放，committed=0），物理扣减后 spendable 与 unknown 阶段同值
    // （双扣会得到 800/10000−2q/F0−200）；查询不清理责任、不产生提交。
    const closingProj = projection(scene.service);
    expect(closingProj.sourceH).toEqual({ observed: 900, committed: 0, spendable: 900 });
    expect(closingProj.sourceEnergy).toEqual({ observed: 10_000 - scene.fee, committed: 0, spendable: 10_000 - scene.fee });
    expect(closingProj.safe).toBe(true);
    expect(closingProj.blockers).toEqual([]);
    expect(closingProj.targetRiskAdjusted).toBe(100_000 - SLICE0_TRANSFER_AMOUNT);
    expect(recordShape(attemptId)?.phase).toBe("closing"); // 读取前后记录仍在
    expect(scene.host.submits.length).toBe(1);
    // 适用新观察后退出（不双扣、不重复执行）。
    advanceTick(scene.service);
    expect(activeIds()).not.toContain(attemptId);
    // O04：退出不重复释放——金额/容量与 closing 期间一致（删除记录不再
    // 增加一次）。
    expect(projection(scene.service)).toEqual(closingProj);
    // 世界终态：源 −100H 与实际 fee、目标 +100H——各恰好一次。
    expect(stock(SOURCE_ROOM, SLICE0_TRANSFER_RESOURCE)).toBe(1000 - SLICE0_TRANSFER_AMOUNT);
    expect(stock(SOURCE_ROOM, "energy")).toBe(10_000 - scene.fee);
    expect(stock(TARGET_ROOM, SLICE0_TRANSFER_RESOURCE)).toBe(SLICE0_TRANSFER_AMOUNT);
    expect(scene.host.submits.length).toBe(1); // 提交恰一次
    expect(scene.host.pendingCount).toBe(0);
    // 退出后再推进处理阶段——无挂起请求，世界不再变化。
    scene.host.processPendingRequests();
    expect(stock(TARGET_ROOM, SLICE0_TRANSFER_RESOURCE)).toBe(SLICE0_TRANSFER_AMOUNT);
    expect(scene.host.submits.length).toBe(1);
  });

  it("M06：无记录/窗口挤出/读异常/他人与市场订单记录/重复交易 ID 均不报全量完成", () => {
    // A. 无记录（未处理）——不能证明未执行，也不能报完成。
    {
      const scene = freshScene();
      const attemptId = submit(scene, "biz:slice0:m06-a", "s0-0401");
      advanceTick(scene.service);
      expect(scene.service.settleUnknownOutcome({ attemptId }).status).toBe("still_uncertain");
      expect(recordShape(attemptId)?.phase).toBe("outcome_unknown");
    }
    // B. 只有库存变化、无交易记录（历史被挤出窗口）。
    {
      const scene = freshScene();
      const attemptId = submit(scene, "biz:slice0:m06-b", "s0-0402");
      processAndAdvance(scene);
      expect(scene.host.transactions.length).toBe(1); // 库存确实变了
      scene.host.viewConfig.dropAll = true; // 模拟记录窗口缺失
      expect(scene.service.settleUnknownOutcome({ attemptId }).status).toBe("still_uncertain");
      scene.host.viewConfig.dropAll = false;
    }
    // C. 交易视图读取异常——保守保留 unknown（不因异常而完成/丢弃）。
    {
      const scene = freshScene();
      const attemptId = submit(scene, "biz:slice0:m06-c", "s0-0403");
      processAndAdvance(scene);
      scene.host.viewConfig.failOutgoing = true;
      const settled = scene.service.settleUnknownOutcome({ attemptId });
      expect(settled.status === "still_uncertain" || settled.status === "rejected").toBe(true);
      expect(recordShape(attemptId)?.phase).toBe("outcome_unknown");
      scene.host.viewConfig.failOutgoing = false;
    }
    // D. 相同参数不同关联键（他人/旧请求记录）不误匹配。
    {
      const scene = freshScene();
      const attemptId = submit(scene, "biz:slice0:m06-d", "s0-0404");
      scene.host.viewConfig.injected = [
        fakeTransaction("txn-9001", "treasury-slice0 s0-OTHER", SLICE0_TRANSFER_AMOUNT),
      ];
      advanceTick(scene.service);
      expect(scene.service.settleUnknownOutcome({ attemptId }).status).toBe("still_uncertain");
      scene.host.viewConfig.injected = [];
    }
    // E. 市场订单记录（带 order 字段）不作为本动作证据。
    {
      const scene = freshScene();
      const attemptId = submit(scene, "biz:slice0:m06-e", "s0-0405");
      scene.host.viewConfig.injected = [
        { ...fakeTransaction("txn-9002", "treasury-slice0 s0-0405", SLICE0_TRANSFER_AMOUNT), order: { id: "ord-1" } },
      ];
      advanceTick(scene.service);
      expect(scene.service.settleUnknownOutcome({ attemptId }).status).toBe("still_uncertain");
      scene.host.viewConfig.injected = [];
    }
    // F. 多个不同交易 ID 同时匹配同一关联键——不能选定唯一事实。
    {
      const scene = freshScene();
      const attemptId = submit(scene, "biz:slice0:m06-f", "s0-0406");
      scene.host.viewConfig.injected = [
        fakeTransaction("txn-9003", "treasury-slice0 s0-0406", SLICE0_TRANSFER_AMOUNT),
        fakeTransaction("txn-9004", "treasury-slice0 s0-0406", SLICE0_TRANSFER_AMOUNT),
      ];
      advanceTick(scene.service);
      expect(scene.service.settleUnknownOutcome({ attemptId }).status).toBe("still_uncertain");
      scene.host.viewConfig.injected = [];
    }
  });

  it("M06：实际部分量不报全量、不补发、不重执行；两视图同一交易不重复计数", () => {
    // 授权时容量充足；处理前目标空间被外部占用到只剩 60（负向测试构造的
    // 条件变化）——处理层按剩余空间缩量（源码事实 executeTransfer）。
    const scene = freshScene();
    const attemptId = submit(scene, "biz:slice0:m06-partial", "s0-0500");
    scene.service.endTick();
    const targetRoom = (Game.rooms as unknown as Record<string, { terminal: { store: { __freeCapacity?: number } } }>)[TARGET_ROOM];
    targetRoom.terminal.store.__freeCapacity = 60;
    scene.host.processPendingRequests();
    Game.time += 1;
    scene.service.beginTick();
    const txn = scene.host.transactions[0];
    expect(txn?.amount).toBe(60); // 请求 100、实际 60
    expect(scene.service.settleUnknownOutcome({ attemptId }).status).toBe("still_uncertain");
    expect(recordShape(attemptId)?.phase).toBe("outcome_unknown"); // 保守责任保留
    // 不补发 40、不重执行：无新提交、无新挂起、再次结算仍不确定。
    expect(scene.host.submits.length).toBe(1);
    expect(scene.host.pendingCount).toBe(0);
    expect(scene.service.settleUnknownOutcome({ attemptId }).status).toBe("still_uncertain");
    expect(stock(TARGET_ROOM, SLICE0_TRANSFER_RESOURCE)).toBe(60); // 不自动补齐
    expect(activeIds()).toContain(attemptId); // 未悄悄退出
    // 两视图同一交易不重复计数：正常完成场景下 outgoing/incoming 都可见同
    // 一 transactionId（同一条事实），结算一次、计数各变化一次。
    {
      const s2 = freshScene();
      const a2 = submit(s2, "biz:slice0:m06-view", "s0-0501");
      processAndAdvance(s2);
      const t2 = s2.host.transactions[0] as TerminalTransactionRecord;
      const out = s2.host.transactionsView.outgoingTransactions().find((r) => r.transactionId === t2.transactionId);
      const inc = s2.host.transactionsView.incomingTransactions().find((r) => r.transactionId === t2.transactionId);
      expect(out).toBeDefined();
      expect(inc).toBeDefined();
      expect(inc?.amount).toBe(out?.amount); // 同 ID 同事实
      expect(s2.service.settleUnknownOutcome({ attemptId: a2 }).status).toBe("ok");
      expect(stock(SOURCE_ROOM, SLICE0_TRANSFER_RESOURCE)).toBe(1000 - SLICE0_TRANSFER_AMOUNT);
      expect(stock(TARGET_ROOM, SLICE0_TRANSFER_RESOURCE)).toBe(SLICE0_TRANSFER_AMOUNT);
    }
  });

  it("M07/N03/N04：提交后结果持久化前的断点（经业务入口）——配对重载先保持 unknown，事实到达后收尾；旧许可拒绝、第二需求被单条在途阻断", () => {
    const host = createTerminalTransferFakeHost();
    const installed = installRooms(sceneRooms());
    const fee = host.quoteTransferFee(SLICE0_TRANSFER_AMOUNT, SOURCE_ROOM, TARGET_ROOM);
    const holder: { breakpoint?: TreasuryHostBreakpoint } = {};
    replaceTreasuryActionAdapterForTest(wrapWithPostSubmitCapture(host, holder));
    registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
    const service = createTreasuryService({ getRooms: () => Object.values(installed) });
    service.beginTick();
    const coordinator = createSlice0TransferCoordinator({
      host,
      service,
      buildContract: (args, workKey) => buildTreasuryActionContract(service, { actionKind: SLICE0_ACTION_KIND, transactionId: workKey, args }),
    });
    const admission = coordinator.requestTransfer({ workKey: "biz:slice0:m07a", correlationKey: "s0-0600" });
    expect(admission.status).toBe("admitted");
    const attemptId = admission.status === "admitted" ? admission.attemptId : "";
    // 断点 1：submit 已接受（pending 里有请求）、dispatch_result 未写入。
    const execution = coordinator.executeTransfer(admission);
    expect(execution.status).toBe("unknown");
    if (holder.breakpoint === undefined) throw new Error("post-submit 断点未捕获");
    // 旧栈继续走完（outcome_unknown 已持久化），但从断点恢复——世界与宿主
    // 状态回到捕获时刻（提交已发生、未处理）。
    const restored = restoreFromBreakpoint({ host, service }, holder.breakpoint);
    const { service: restoredService, contracts } = restored;
    expect(stock(TARGET_ROOM, SLICE0_TRANSFER_RESOURCE)).toBe(0); // 世界回滚
    expect(host.pendingCount).toBe(1); // 宿主配对恢复（挂起请求在）
    // 旧 dispatch 许可（断点前的运行时对象）——新模块下拒绝。
    const replay = restoredService.executeAuthorizedDispatch((admission as { dispatch: object }).dispatch);
    expect(replay.status).not.toBe("committed");
    expect(host.submits.length).toBe(1); // 不重发（许可失效在调用前拦截）
    // 第二条需求（不同 workKey、不同关联键）被**单条在途**阻断——从恢复后
    // 新协调器读持久 active 事实（不是局部布尔量；与 workKey 无关）。
    const secondCoordinator = coordinatorRestored(host, restored);
    const second = secondCoordinator.requestTransfer({ workKey: "biz:slice0:m07a-second", correlationKey: "s0-0600b" });
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") {
      expect(second.stage).toBe("single-flight");
      expect(second.reason).toMatch(/单条在途/);
    }
    // 恢复后先保持 unknown：无交易记录（处理未发生）。
    const phaseAfterRestore = recordShape(attemptId)?.phase;
    expect(phaseAfterRestore === "outcome_unknown" || phaseAfterRestore === "dispatching").toBe(true);
    const settle1 = restoredService.settleUnknownOutcome({ attemptId });
    if (settle1.status !== "rejected") expect(settle1.status).toBe("still_uncertain");
    // O04（Remediation II §5.2 恢复路径一）：断点恢复后仍 unknown——世界与
    // 宿主配对回滚到提交时刻，保守占用保留（1000/10000/F0 − 占用）。
    const restoredProj = projection(restoredService);
    expect(restoredProj.sourceH).toEqual({ observed: 1000, committed: SLICE0_TRANSFER_AMOUNT, spendable: 900 });
    expect(restoredProj.sourceEnergy).toEqual({ observed: 10_000, committed: fee, spendable: 10_000 - fee });
    expect(restoredProj.safe).toBe(true);
    expect(restoredProj.blockers).toEqual([]);
    expect(restoredProj.targetRiskAdjusted).toBe(100_000 - SLICE0_TRANSFER_AMOUNT);
    // 可见事实到达后收尾：处理（宿主从断点分支恢复的挂起请求）→ 新 tick → 结算退出。
    restoredService.endTick();
    host.processPendingRequests();
    Game.time += 1;
    restoredService.beginTick();
    expect(host.transactions.length).toBe(1);
    expect(restoredService.settleUnknownOutcome({ attemptId }).status).toBe("ok");
    expect(recordShape(attemptId)?.outcome).toBe("committed");
    // O04（§5.1 恢复路径一）：closing 期间不双扣——效果进入观察后占用释放
    // （committed=0），spendable 与物理扣减一致。
    const closingProj = projection(restoredService);
    expect(closingProj.sourceH).toEqual({ observed: 900, committed: 0, spendable: 900 });
    expect(closingProj.sourceEnergy).toEqual({ observed: 10_000 - fee, committed: 0, spendable: 10_000 - fee });
    expect(closingProj.safe).toBe(true);
    expect(closingProj.blockers).toEqual([]);
    expect(closingProj.targetRiskAdjusted).toBe(100_000 - SLICE0_TRANSFER_AMOUNT);
    restoredService.endTick();
    Game.time += 1;
    restoredService.beginTick();
    expect(activeIds()).not.toContain(attemptId);
    expect(projection(restoredService)).toEqual(closingProj); // 退出不重复释放
    expect(stock(SOURCE_ROOM, SLICE0_TRANSFER_RESOURCE)).toBe(1000 - SLICE0_TRANSFER_AMOUNT);
    expect(stock(TARGET_ROOM, SLICE0_TRANSFER_RESOURCE)).toBe(SLICE0_TRANSFER_AMOUNT);
    expect(host.submits.length).toBe(1); // 全程恰一次提交
  });

  it("M07/N03/N04：已接受未处理的断点（经业务入口）——完整重载后先 unknown 再收尾；第二需求阻断直至结算完成", () => {
    const scene = freshScene();
    const attemptId = submit(scene, "biz:slice0:m07b", "s0-0700");
    scene.service.endTick();
    // 断点 2：outcome_unknown 已持久化、处理阶段未跑。
    const breakpoint = captureTreasuryHostBreakpoint(scene.host.captureBranch());
    const restored = restoreFromBreakpoint(scene, breakpoint);
    const restoredService = restored.service;
    expect(scene.host.pendingCount).toBe(1);
    expect(stock(TARGET_ROOM, SLICE0_TRANSFER_RESOURCE)).toBe(0);
    // 先保持 unknown（settle 不受授权窗口限制——恢复与对账继续）。
    expect(restoredService.settleUnknownOutcome({ attemptId }).status).toBe("still_uncertain");
    // O04（Remediation II §5.2 恢复路径二）：已接受未处理的断点——完整
    // 重载后仍 unknown，保守占用保留（物理未变）。
    const restoredProj = projection(restoredService);
    expect(restoredProj.sourceH).toEqual({ observed: 1000, committed: SLICE0_TRANSFER_AMOUNT, spendable: 900 });
    expect(restoredProj.sourceEnergy).toEqual({ observed: 10_000, committed: scene.fee, spendable: 10_000 - scene.fee });
    // 断点捕获于 endTick 后：本 tick 授权窗口已关（C06——已关窗口不得重开），
    // lifecycle_closed 如实呈现；账目数字仍按真实占用计算（非 fail-closed 的 0）。
    expect(restoredProj.safe).toBe(false);
    expect(restoredProj.blockers).toEqual(["lifecycle_closed"]);
    expect(restoredProj.targetRiskAdjusted).toBe(100_000 - SLICE0_TRANSFER_AMOUNT);
    // 推进到下一 tick 开窗（断点捕获于 endTick 后——本 tick 窗口已关；开窗
    // 使 B 的其他条件成立），attempt 仍 unknown：第二需求（不同 workKey）被
    // 持久 active 事实的**单条在途**阻断——理由指向在途责任而非窗口。
    restoredService.endTick();
    Game.time += 1;
    restoredService.beginTick();
    const secondCoordinator = coordinatorRestored(scene.host, restored);
    const second = secondCoordinator.requestTransfer({ workKey: "biz:slice0:m07b-second", correlationKey: "s0-0701" });
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") {
      expect(second.stage).toBe("single-flight");
      expect(second.reason).toMatch(/单条在途/);
    }
    // 收尾：处理 → 新 tick → 结算 → 退出。
    restoredService.endTick();
    scene.host.processPendingRequests();
    Game.time += 1;
    restoredService.beginTick();
    expect(restoredService.settleUnknownOutcome({ attemptId }).status).toBe("ok");
    // O04（§5.1 恢复路径二）：closing 期间不双扣（committed=0、spendable
    // 与物理一致、容量 F0−100）——退出后不重复释放。
    const closingProj = projection(restoredService);
    expect(closingProj.sourceH).toEqual({ observed: 900, committed: 0, spendable: 900 });
    expect(closingProj.sourceEnergy).toEqual({ observed: 10_000 - scene.fee, committed: 0, spendable: 10_000 - scene.fee });
    expect(closingProj.safe).toBe(true);
    expect(closingProj.blockers).toEqual([]);
    expect(closingProj.targetRiskAdjusted).toBe(100_000 - SLICE0_TRANSFER_AMOUNT);
    restoredService.endTick();
    Game.time += 1;
    restoredService.beginTick();
    expect(activeIds()).not.toContain(attemptId);
    expect(projection(restoredService)).toEqual(closingProj);
    // 结算完成后同 workKey 的新需求不再被旧工作阻断（经恢复后新协调器）。
    const third = secondCoordinator.requestTransfer({ workKey: "biz:slice0:m07b", correlationKey: "s0-0702" });
    expect(third.status).toBe("admitted");
    expect(scene.host.submits.length).toBe(1); // 第二/第三需求未提交——只接纳
  });
});

/** 构造公开形态注入记录（M06 噪声场景）。 */
function fakeTransaction(transactionId: string, description: string, amount: number): TerminalTransactionRecord {
  return {
    transactionId,
    time: Game.time,
    sender: { username: SLICE0_USERNAME },
    recipient: { username: SLICE0_USERNAME },
    resourceType: SLICE0_TRANSFER_RESOURCE,
    amount,
    from: SOURCE_ROOM,
    to: TARGET_ROOM,
    description,
  };
}
