/**
 * Core Rewrite II 基线重现脚本（R04——pending 没有出口）。
 *
 * 用途：在基线 35ed7f8 上以 `npx jest --runTestsByPath
 * scripts/baseline-red/pending-no-exit.baseline.ts` 显式运行（文件名不含
 * .test.，默认收集不包含——不污染全绿套件）。断言的是**基线缺陷行为**：
 * pending 聚合在所有现有出口（closeWork / settle / rearm / 跨 tick
 * dispatch / 同 workKey 再接纳）都被拒绝，记录永久滞留。此脚本在基线上
 * PASS 恰证明缺陷存在；Core Rewrite II 实现后（跨 tick pending sweep +
 * cancelPendingWork）本脚本会 FAIL——差异即修复证据（B12/B13 的绿灯
 * 断言在 treasuryRewrite2Lifecycle.test.ts）。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import {
  buildTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  replaceTreasuryActionAdapterForTest,
  type TreasuryTestTransferArgs,
} from "@/runtime/treasury/actionContracts";
import { makeNoReserveTreasuryPolicy, registerTreasuryPolicyResolver } from "@/runtime/treasury/policyAuthority";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { installRooms, type RoomSpec } from "@mock/treasury";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 1_000_000 }, freeCapacity: 500_000 },
    terminal: { id: "term-1", resources: { energy: 100_000 }, freeCapacity: 500_000 },
  },
];

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
});

describe("基线缺陷重现：pending 没有出口（R04）", () => {
  it("基线 35ed7f8 上：pending 聚合在所有现有出口被拒、永久滞留（缺陷存在的正面证据）", () => {
    const rooms = installRooms(ROOMS);
    const service = createTreasuryService({ getRooms: () => Object.values(rooms), holderExists: () => true });
    service.beginTick();
    const args: TreasuryTestTransferArgs = {
      fromRoom: "W1N57",
      fromLocation: "storage",
      toRoom: "W1N57",
      toLocation: "terminal",
      resource: RESOURCE_ENERGY,
      amount: 500,
      outcome: "ok",
    };
    const built = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "biz:r04:stuck", args });
    expect(built.status).toBe("built");
    if (built.status !== "built") throw new Error("unreachable");
    const admission = service.authorizeTreasuryActionContract(built.contract, { workKey: "biz:r04:stuck" });
    expect(admission.status).toBe("admitted");
    if (admission.status !== "admitted") throw new Error("unreachable");

    // 跨 tick：旧 dispatch 许可失效（heap-only 同 tick 有效）。
    Game.time += 1;
    service.beginTick();
    expect(service.executeAuthorizedDispatch(admission.dispatch).status).toBe("rejected");

    // 基线上所有其它出口都不接受 pending：
    expect(service.closeWork({ attemptId: admission.attemptId, reason: "abandoned" }).status).toBe("rejected");
    expect(service.settleUnknownOutcome({ attemptId: admission.attemptId, evidenceKind: "adapter_reconcile" } as never).status).toBe("rejected");
    expect(service.issueTreasuryRearmCapability({ attemptId: admission.attemptId }).status).toBe("rejected");
    // 同 workKey 再接纳被排他拒绝（活跃聚合仍滞留）。
    const again = buildTreasuryActionContract(service, {
      actionKind: "test.transfer",
      transactionId: "biz:r04:stuck-2",
      args,
    });
    expect(again.status).toBe("built");
    if (again.status !== "built") throw new Error("unreachable");
    expect(service.authorizeTreasuryActionContract(again.contract, { workKey: "biz:r04:stuck" }).status).toBe("rejected");
    // 多 tick 后仍滞留（无任何 sweep/取消路径）。
    for (let i = 0; i < 10; i += 1) {
      Game.time += 1;
      service.beginTick();
    }
    const record = service.kernelJournal().active.find((r) => r.attemptId === admission.attemptId);
    // 基线断言：记录仍在 pending（= 无出口缺陷）。实现后此断言 FAIL，
    // 对应 treasuryRewrite2Lifecycle B12 的绿灯（sweep 取消 + 槽位恢复）。
    expect(record?.phase).toBe("pending");
  });
});
