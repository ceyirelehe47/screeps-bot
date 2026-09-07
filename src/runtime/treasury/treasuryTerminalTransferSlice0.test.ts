/**
 * Terminal Transfer Slice 0——M03–M07 行为验收（任务书 §4–§5）。
 *
 * - M03：原型仅测试装配（默认注册表无此 kind）；canonical 参数派生一致的
 *   三腿 postings／结构绑定／durable facts。
 * - M04：正常 100H+fee 可接纳；资源／费用能源／目标容量／结构替换／超场景
 *   输入各自明确拒绝且提交增量 0；恢复合法条件后成功。
 * - M05：延迟完成正向闭环——OK 当 tick 仍 unknown 且责任保留；处理与新
 *   tick 观察后唯一全量记录结算退出；源/目标/fee 计数吻合、恰一次提交。
 * - M06：无记录／窗口缺失／读异常／他人与市场订单记录／重复交易 ID／
 *   实际部分量均不报全量完成、不补发；两视图同一交易不重复计数。
 * - M07：提交后结果持久化前与已接受未处理两类断点，配对宿主状态完整重载；
 *   先保持 unknown，可见事实到达后收尾；旧许可拒绝、同工作不重发。
 *
 * M01/M02/M08 由 scripts/verify-treasury-evidence.mjs 实跑、openspec
 * terminal-transfer-slice-0.md 短报告与固定 SHA 主验证承担（非 Jest 范围）。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import {
  buildTreasuryActionContract,
  clearTreasuryAdapterRegistryForTest,
  findTreasuryActionAdapter,
  replaceTreasuryActionAdapterForTest,
  type TreasuryActionAdapter,
} from "@/runtime/treasury/actionContracts";
import { clearTreasuryPolicyResolversForTest, makeNoReserveTreasuryPolicy, registerTreasuryPolicyResolver } from "@/runtime/treasury/policyAuthority";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { installRooms, setStoreResources, type RoomSpec } from "@mock/treasury";
import { captureTreasuryHostBreakpoint, performTreasuryFullReset, type TreasuryHostBreakpoint } from "@mock/treasuryResetHarness";
import {
  SLICE0_ACTION_KIND,
  SLICE0_TRANSFER_AMOUNT,
  SLICE0_TRANSFER_RESOURCE,
  createTerminalTransferFakeHost,
  decodeSlice0DurablePayload,
  makeSlice0TransferArgs,
  makeTerminalTransferPrototypeAdapter,
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
  return { host, service, fee: host.quoteTransferFee(SLICE0_TRANSFER_AMOUNT, SOURCE_ROOM, TARGET_ROOM) };
}

type AdmitResult = { status: string; attemptId?: string; dispatch?: { attemptId?: unknown } & object; reason?: string };

function admit(service: TreasuryService, workKey: string, args: unknown): AdmitResult {
  const built = buildTreasuryActionContract(service, { actionKind: SLICE0_ACTION_KIND, transactionId: workKey, args });
  if (built.status !== "built") return { status: `build:${built.status}`, reason: built.status === "rejected" ? built.reason : undefined };
  return service.authorizeTreasuryActionContract(built.contract, { workKey }) as AdmitResult;
}

/** 提交一条调拨并执行（OK → outcome_unknown）。返回 attemptId。 */
function submit(scene: Scene, workKey: string, correlationKey: string): string {
  const admission = admit(scene.service, workKey, makeSlice0TransferArgs(SOURCE_ROOM, TARGET_ROOM, correlationKey));
  if (admission.status !== "admitted") throw new Error(`admit failed: ${admission.status} ${admission.reason ?? ""}`);
  const outcome = scene.service.executeAuthorizedDispatch(admission.dispatch);
  if (outcome.status !== "unknown") throw new Error(`dispatch expected unknown, got ${String(outcome.status)}`);
  return admission.attemptId as string;
}

/** tick 推进：关窗 → tick+1 → 开窗（观察重建）。 */
function advanceTick(service: TreasuryService): void {
  service.endTick();
  Game.time += 1;
  service.beginTick();
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
  scene: Scene,
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

/**
 * 恢复后的接纳：resetModules 重建了模块图，contract 必须经**新模块**的
 * buildTreasuryActionContract 构建（旧 import 的入口注册在旧模块 WeakSet，
 * 新 service 一律拒绝——伪造对象无效）。
 */
function admitRestored(
  contracts: typeof import("@/runtime/treasury/actionContracts"),
  service: TreasuryService,
  workKey: string,
  args: unknown,
): AdmitResult & { reason?: string } {
  const built = contracts.buildTreasuryActionContract(service, { actionKind: SLICE0_ACTION_KIND, transactionId: workKey, args });
  if (built.status !== "built") return { status: `build:${built.status}` };
  return service.authorizeTreasuryActionContract(built.contract, { workKey }) as AdmitResult;
}

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
  clearTreasuryPolicyResolversForTest();
});

describe("Terminal Transfer Slice 0（M03–M07）", () => {
  it("M03：原型仅测试装配——默认注册表无此 kind；canonical 参数派生一致的三腿/结构绑定/durable facts", () => {
    // 无默认注册：清空注册表后（未装配本原型时）生产注册表不含 slice0 kind。
    clearTreasuryAdapterRegistryForTest();
    expect(findTreasuryActionAdapter(SLICE0_ACTION_KIND)).toBeUndefined();
    const scene = makeScene();
    const args = makeSlice0TransferArgs(SOURCE_ROOM, TARGET_ROOM, "s0-0001");
    const built = buildTreasuryActionContract(scene.service, { actionKind: SLICE0_ACTION_KIND, transactionId: "biz:slice0:m03", args });
    expect(built.status).toBe("built");
    const admission = scene.service.authorizeTreasuryActionContract(built.status === "built" ? built.contract : undefined as never, { workKey: "biz:slice0:m03" });
    expect(admission.status).toBe("admitted");
    // canonical 一致（单一参数来源）：dispatch 许可携带的 postings ===
    // derivePostings(args)；durable facts === durableFacts(args)（含三腿
    // fee 与提交前基线）。API 参数（description 派生）与持久事实同一 key。
    const adapter = findTreasuryActionAdapter(SLICE0_ACTION_KIND) as unknown as TerminalTransferPrototypeAdapter;
    const permit = (admission as unknown as { dispatch: { postings?: unknown[]; canonicalArgs?: unknown } }).dispatch;
    // canonical 一致（单一参数来源）：dispatch 许可携带的 postings 与
    // derivePostings(args) 同一集合（kernel 规范序为流入在前——集合比较）。
    const sortedPostings = (items: readonly unknown[]): string[] => items.map((p) => JSON.stringify(p)).sort();
    expect(sortedPostings(permit.postings ?? [])).toEqual(sortedPostings(adapter.derivePostings(args) as unknown as readonly unknown[]));
    const record = recordShape((admission as { attemptId: string }).attemptId);
    expect(record?.phase).toBe("pending");
    const durable = adapter.durableFacts(args);
    const payload = decodeSlice0DurablePayload(durable.payload);
    expect(payload?.k).toBe("s0-0001");
    expect(payload?.a).toBe(SLICE0_TRANSFER_AMOUNT);
    expect(payload?.f).toBe(scene.fee);
    expect(payload?.sb).toEqual([1000, 10_000]);
    expect(payload?.tb).toEqual([0]);
    // 结构绑定：source/fee_source/target 三声明（无生产注册、无网络发送能力
    // ——execute 只调注入端口，由后续各 it 的 submits 计数与 freeze 断言承担）。
    const bindings = adapter.structureBindings!(args);
    expect(bindings.map((b) => b.role)).toEqual(["source", "fee_source", "target"]);
  });

  it("M04：合法 100H+fee 可接纳执行为 unknown；执行前条件变化各自拒绝且提交增量 0", () => {
    const scene = makeScene();
    const attemptId = submit(scene, "biz:slice0:m04-ok", "s0-0100");
    expect(scene.host.pendingCount).toBe(1); // OK 只入 pending——延迟生效
    expect(scene.host.submits.length).toBe(1); // 恰一次提交
    expect(stock(SOURCE_ROOM, SLICE0_TRANSFER_RESOURCE)).toBe(1000); // 世界未变
    expect(recordShape(attemptId)?.phase).toBe("outcome_unknown");

    // 仅降低货物 H（授权后、执行前）→ 拒绝且零提交。
    {
      const s2 = makeScene();
      const admission = admit(s2.service, "biz:slice0:m04-h", makeSlice0TransferArgs(SOURCE_ROOM, TARGET_ROOM, "s0-0101"));
      expect(admission.status).toBe("admitted");
      setStoreResources((Game.rooms as unknown as Record<string, { terminal: StructureTerminal }>)[SOURCE_ROOM].terminal, { H: 50, energy: 10_000 });
      const outcome = s2.service.executeAuthorizedDispatch(admission.dispatch);
      expect(outcome.status).not.toBe("committed");
      expect(s2.host.pendingCount).toBe(0);
      expect(s2.host.submits.length).toBe(0);
    }
    // 仅降低费用能源（< fee）→ 拒绝且零提交。
    {
      const s2 = makeScene();
      const admission = admit(s2.service, "biz:slice0:m04-fee", makeSlice0TransferArgs(SOURCE_ROOM, TARGET_ROOM, "s0-0102"));
      expect(admission.status).toBe("admitted");
      setStoreResources((Game.rooms as unknown as Record<string, { terminal: StructureTerminal }>)[SOURCE_ROOM].terminal, { H: 1000, energy: scene.fee - 1 });
      const outcome = s2.service.executeAuthorizedDispatch(admission.dispatch);
      expect(outcome.status).not.toBe("committed");
      expect(s2.host.pendingCount).toBe(0);
    }
    // 目标空位不足（freeCapacity=50 < 100）→ 明确拒绝（授权或执行层）。
    {
      const s2 = makeScene(slice0SceneRooms({ targetFreeCapacity: 50 }));
      const admission = admit(s2.service, "biz:slice0:m04-cap", makeSlice0TransferArgs(SOURCE_ROOM, TARGET_ROOM, "s0-0103"));
      if (admission.status === "admitted") {
        const outcome = s2.service.executeAuthorizedDispatch(admission.dispatch);
        expect(outcome.status).not.toBe("committed");
      } else {
        expect(admission.status).toMatch(/rejected|build/);
      }
      expect(s2.host.pendingCount).toBe(0);
      expect(stock(TARGET_ROOM, SLICE0_TRANSFER_RESOURCE)).toBe(0);
    }
    // 源结构替换（incarnation 变化）→ 执行层拒绝且零提交。
    {
      const s2 = makeScene();
      const admission = admit(s2.service, "biz:slice0:m04-inc", makeSlice0TransferArgs(SOURCE_ROOM, TARGET_ROOM, "s0-0104"));
      expect(admission.status).toBe("admitted");
      const rooms = Game.rooms as unknown as Record<string, { terminal: { id: string; store: Record<string, number> } }>;
      rooms[SOURCE_ROOM].terminal = { id: "term-A-rebuilt", store: rooms[SOURCE_ROOM].terminal.store };
      const outcome = s2.service.executeAuthorizedDispatch(admission.dispatch);
      expect(outcome.status).not.toBe("committed");
      expect(s2.host.pendingCount).toBe(0);
    }
  });

  it("M04：超场景输入拒绝（amount/resource/关联键/场景外目标）；恢复合法条件后正常成功", () => {
    const scene = makeScene();
    // amount ≠ 100 / resource ≠ H / 非法关联键——validate 层拒绝（contract 不构建）。
    const badAmount = admit(scene.service, "biz:slice0:m04-amount", { ...makeSlice0TransferArgs(SOURCE_ROOM, TARGET_ROOM, "s0-0201"), amount: 101 });
    expect(badAmount.status).toMatch(/build:rejected/);
    const badResource = admit(scene.service, "biz:slice0:m04-resource", { ...makeSlice0TransferArgs(SOURCE_ROOM, TARGET_ROOM, "s0-0202"), resourceType: "energy" });
    expect(badResource.status).toMatch(/build:rejected/);
    const badKey = admit(scene.service, "biz:slice0:m04-key", makeSlice0TransferArgs(SOURCE_ROOM, TARGET_ROOM, "bad key!"));
    expect(badKey.status).toMatch(/build:rejected/);
    // 场景外目标（E5N59 无 terminal）——结构不存在，授权层拒绝。
    const outside = admit(scene.service, "biz:slice0:m04-outside", makeSlice0TransferArgs(SOURCE_ROOM, "E5N59", "s0-0203"));
    expect(outside.status).not.toBe("admitted");
    expect(scene.host.pendingCount).toBe(0);
    // 恢复合法输入后正常成功（同一场景仍可继续）。
    const attemptId = submit(scene, "biz:slice0:m04-recover", "s0-0204");
    expect(recordShape(attemptId)?.phase).toBe("outcome_unknown");
    expect(scene.host.pendingCount).toBe(1);
  });

  it("M05：延迟完成正向闭环——当 tick 仍 unknown；处理与新观察后唯一全量记录结算退出；计数吻合不双扣", () => {
    const scene = makeScene();
    const attemptId = submit(scene, "biz:slice0:m05", "s0-0300");
    // OK 之后当 tick：无记录、库存未变——settle 仍 unknown，责任保留。
    expect(scene.host.transactions.length).toBe(0);
    expect(scene.service.settleUnknownOutcome({ attemptId }).status).toBe("still_uncertain");
    expect(recordShape(attemptId)?.outcome).toBe("unknown"); // 结论仍是 unknown——无完成覆盖
    expect(recordShape(attemptId)?.phase).toBe("outcome_unknown");
    expect(activeIds()).toContain(attemptId); // 完成前占用保留
    // 处理阶段（tick T 后期）→ 新 tick（T+1）效果与记录可见。
    processAndAdvance(scene);
    const txn = scene.host.transactions[0];
    expect(txn?.amount).toBe(SLICE0_TRANSFER_AMOUNT);
    expect(txn?.resourceType).toBe(SLICE0_TRANSFER_RESOURCE);
    expect(txn?.from).toBe(SOURCE_ROOM);
    expect(txn?.to).toBe(TARGET_ROOM);
    expect(txn?.description).toContain("s0-0300");
    expect(scene.service.settleUnknownOutcome({ attemptId }).status).toBe("ok");
    expect(recordShape(attemptId)?.outcome).toBe("committed");
    expect(recordShape(attemptId)?.phase).toBe("closing"); // 进入退出流程
    // 适用新观察后退出（不双扣、不重复执行）。
    advanceTick(scene.service);
    expect(activeIds()).not.toContain(attemptId);
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
      const scene = makeScene();
      const attemptId = submit(scene, "biz:slice0:m06-a", "s0-0401");
      advanceTick(scene.service);
      expect(scene.service.settleUnknownOutcome({ attemptId }).status).toBe("still_uncertain");
      expect(recordShape(attemptId)?.phase).toBe("outcome_unknown");
    }
    // B. 只有库存变化、无交易记录（历史被挤出窗口）。
    {
      const scene = makeScene();
      const attemptId = submit(scene, "biz:slice0:m06-b", "s0-0402");
      processAndAdvance(scene);
      expect(scene.host.transactions.length).toBe(1); // 库存确实变了
      scene.host.viewConfig.dropAll = true; // 模拟记录窗口缺失
      expect(scene.service.settleUnknownOutcome({ attemptId }).status).toBe("still_uncertain");
      scene.host.viewConfig.dropAll = false;
    }
    // C. 交易视图读取异常——保守保留 unknown（不因异常而完成/丢弃）。
    {
      const scene = makeScene();
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
      const scene = makeScene();
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
      const scene = makeScene();
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
      const scene = makeScene();
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
    const scene = makeScene();
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
      const s2 = makeScene();
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

  it("M07：提交后结果持久化前的断点——配对重载先保持 unknown，事实到达后收尾；旧许可拒绝、同工作不重发", () => {
    const host = createTerminalTransferFakeHost();
    const installed = installRooms(sceneRooms());
    const holder: { breakpoint?: TreasuryHostBreakpoint } = {};
    replaceTreasuryActionAdapterForTest(wrapWithPostSubmitCapture(host, holder));
    registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
    const service = createTreasuryService({ getRooms: () => Object.values(installed) });
    service.beginTick();
    const args = makeSlice0TransferArgs(SOURCE_ROOM, TARGET_ROOM, "s0-0600");
    const built = buildTreasuryActionContract(service, { actionKind: SLICE0_ACTION_KIND, transactionId: "biz:slice0:m07a", args });
    expect(built.status).toBe("built");
    const admission = service.authorizeTreasuryActionContract(built.status === "built" ? built.contract : undefined as never, { workKey: "biz:slice0:m07a" });
    expect(admission.status).toBe("admitted");
    const dispatch = (admission as { dispatch: object }).dispatch;
    const attemptId = (admission as { attemptId: string }).attemptId;
    // 断点 1：submit 已接受（pending 里有请求）、dispatch_result 未写入。
    expect(service.executeAuthorizedDispatch(dispatch).status).toBe("unknown");
    if (holder.breakpoint === undefined) throw new Error("post-submit 断点未捕获");
    // 旧栈继续走完（outcome_unknown 已持久化），但从断点恢复——世界与宿主
    // 状态回到捕获时刻（提交已发生、未处理）。
    const restored = restoreFromBreakpoint({ host, service, fee: 0 }, holder.breakpoint);
    const { service: restoredService, contracts } = restored;
    expect(stock(TARGET_ROOM, SLICE0_TRANSFER_RESOURCE)).toBe(0); // 世界回滚
    expect(host.pendingCount).toBe(1); // 宿主配对恢复（挂起请求在）
    // 旧 dispatch 许可（断点前的运行时对象）——新模块下拒绝。
    const replay = restoredService.executeAuthorizedDispatch(dispatch);
    expect(replay.status).not.toBe("committed");
    expect(host.submits.length).toBe(1); // 不重发（许可失效在调用前拦截）
    // 同 workKey 第二条需求阻断——从持久 active 工作读出的排他（非局部布尔量）。
    const second = admitRestored(contracts, restoredService, "biz:slice0:m07a", makeSlice0TransferArgs(SOURCE_ROOM, TARGET_ROOM, "s0-0600b"));
    expect(second.status).not.toBe("admitted");
    expect(String(second.reason)).toMatch(/排他|活跃/);
    // 恢复后先保持 unknown：无交易记录（处理未发生）。
    const phaseAfterRestore = recordShape(attemptId)?.phase;
    expect(phaseAfterRestore === "outcome_unknown" || phaseAfterRestore === "dispatching").toBe(true);
    const settle1 = restoredService.settleUnknownOutcome({ attemptId });
    if (settle1.status !== "rejected") expect(settle1.status).toBe("still_uncertain");
    // 可见事实到达后收尾：处理（宿主从断点分支恢复的挂起请求）→ 新 tick → 结算退出。
    restoredService.endTick();
    host.processPendingRequests();
    Game.time += 1;
    restoredService.beginTick();
    expect(host.transactions.length).toBe(1);
    expect(restoredService.settleUnknownOutcome({ attemptId }).status).toBe("ok");
    expect(recordShape(attemptId)?.outcome).toBe("committed");
    restoredService.endTick();
    Game.time += 1;
    restoredService.beginTick();
    expect(activeIds()).not.toContain(attemptId);
    expect(stock(SOURCE_ROOM, SLICE0_TRANSFER_RESOURCE)).toBe(1000 - SLICE0_TRANSFER_AMOUNT);
    expect(stock(TARGET_ROOM, SLICE0_TRANSFER_RESOURCE)).toBe(SLICE0_TRANSFER_AMOUNT);
    expect(host.submits.length).toBe(1); // 全程恰一次提交
  });

  it("M07：已接受未处理的断点——完整重载后先 unknown 再收尾；第二需求阻断直至结算完成", () => {
    const scene = makeScene();
    const attemptId = submit(scene, "biz:slice0:m07b", "s0-0700");
    scene.service.endTick();
    // 断点 2：outcome_unknown 已持久化、处理阶段未跑。
    const breakpoint = captureTreasuryHostBreakpoint(scene.host.captureBranch());
    const { service: restored, contracts } = restoreFromBreakpoint(scene, breakpoint);
    expect(scene.host.pendingCount).toBe(1);
    expect(stock(TARGET_ROOM, SLICE0_TRANSFER_RESOURCE)).toBe(0);
    // 先保持 unknown（settle 不受授权窗口限制——恢复与对账继续）。
    expect(restored.settleUnknownOutcome({ attemptId }).status).toBe("still_uncertain");
    // 推进到下一 tick 开窗（断点捕获于 endTick 后——本 tick 窗口已关），
    // attempt 仍 unknown：第二需求（同业务）被持久 active 工作的排他阻断。
    restored.endTick();
    Game.time += 1;
    restored.beginTick();
    const second = admitRestored(contracts, restored, "biz:slice0:m07b", makeSlice0TransferArgs(SOURCE_ROOM, TARGET_ROOM, "s0-0701"));
    expect(second.status).not.toBe("admitted");
    expect(String(second.reason)).toMatch(/排他|活跃/);
    // 收尾：处理 → 新 tick → 结算 → 退出。
    restored.endTick();
    scene.host.processPendingRequests();
    Game.time += 1;
    restored.beginTick();
    expect(restored.settleUnknownOutcome({ attemptId }).status).toBe("ok");
    restored.endTick();
    Game.time += 1;
    restored.beginTick();
    expect(activeIds()).not.toContain(attemptId);
    // 结算完成后同 workKey 的新需求不再被旧工作阻断（经新模块构建）。
    const third = admitRestored(contracts, restored, "biz:slice0:m07b", makeSlice0TransferArgs(SOURCE_ROOM, TARGET_ROOM, "s0-0702"));
    expect(third.status).toBe("admitted");
    expect(scene.host.submits.length).toBe(1); // 第二/第三需求未提交——只接纳
  });
});

/** 构造公开形态注入记录（M06 噪声场景）。 */
function fakeTransaction(transactionId: string, description: string, amount: number): TerminalTransactionRecord {
  return {
    transactionId,
    time: Game.time,
    sender: { username: "slice0-user" },
    recipient: { username: "slice0-user" },
    resourceType: SLICE0_TRANSFER_RESOURCE,
    amount,
    from: SOURCE_ROOM,
    to: TARGET_ROOM,
    description,
  };
}
