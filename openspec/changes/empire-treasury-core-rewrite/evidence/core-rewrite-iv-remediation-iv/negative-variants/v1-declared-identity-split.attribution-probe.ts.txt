/**
 * V1 负向变体的事件归属探针源码存档（独立验收观察项补交）。
 * 运行方式：v1-declared-identity-split.patch 应用后，将本文件内容保存为
 * src/runtime/treasury/ 下的临时 .test.ts（依赖与 IVService 相同的 helper
 * 形态）定向运行——attribution-red.log 即其输出（exit=1，失败在归属断言：
 * visibleFor(A)=[]，事件被错归声明 B）。跑完即删，不入 Jest 收集。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import { buildTreasuryActionContract, makeTreasuryTestTransferAdapter, replaceTreasuryActionAdapterForTest, type TreasuryTestTransferArgs } from "@/runtime/treasury/actionContracts";
import { clearTreasuryPolicyResolversForTest, makeNoReserveTreasuryPolicy, registerTreasuryPolicyResolver } from "@/runtime/treasury/policyAuthority";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { installRooms, type RoomSpec } from "@mock/treasury";
import { createTreasuryHostJournal, executeTreasuryAdmittedDispatch, makeTreasuryExactOracleAdapter } from "@mock/treasuryExactOracle";

const ROOMS: RoomSpec[] = [
  { name: "W1N57", storage: { id: "stor-1", resources: { energy: 1000 }, freeCapacity: 10_000 }, terminal: { id: "term-1", resources: { energy: 0 }, freeCapacity: 200_000 } },
  { name: "W2N57", storage: { id: "stor-2", resources: { energy: 0 }, freeCapacity: 10_000 }, terminal: { id: "term-2", resources: { energy: 0 }, freeCapacity: 200_000 } },
];

beforeEach(() => {
  resetTreasuryCoreStoreForTest();
  resetTreasuryCommitmentRevisionForTest();
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
  clearTreasuryPolicyResolversForTest();
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
});

it("v1 variant attribution probe", () => {
  const journal = createTreasuryHostJournal();
  replaceTreasuryActionAdapterForTest(makeTreasuryExactOracleAdapter(journal));
  const installed = installRooms(ROOMS);
  const service = createTreasuryService({ getRooms: () => Object.values(installed) });
  service.beginTick();
  const args: TreasuryTestTransferArgs = { fromRoom: "W1N57", fromLocation: "storage", toRoom: "W2N57", toLocation: "terminal", resource: RESOURCE_ENERGY, amount: 100, outcome: "ok" };
  const builtA = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "biz:v1p:A", args });
  const builtB = buildTreasuryActionContract(service, { actionKind: "test.transfer", transactionId: "biz:v1p:B", args });
  if (builtA.status !== "built" || builtB.status !== "built") throw new Error("build failed");
  const a = service.authorizeTreasuryActionContract(builtA.contract, { workKey: "biz:v1p:A" });
  const b = service.authorizeTreasuryActionContract(builtB.contract, { workKey: "biz:v1p:B" });
  if (a.status !== "admitted" || b.status !== "admitted") throw new Error("admit failed");
  // 错配：声明 B、实际提交 A 的许可（变体下不再被拒绝）。
  executeTreasuryAdmittedDispatch(journal, service, { status: "admitted", attemptId: (b as { attemptId: string }).attemptId, dispatch: a.dispatch });
  // 事件归属断言：必须归实际许可 A（变体下归 B → 红）。
  expect(journal.visibleFor((a as { attemptId: string }).attemptId).map((e) => e.kind)).toEqual(["adapter-entered", "world-effect"]);
  expect(journal.visibleFor((b as { attemptId: string }).attemptId)).toEqual([]);
});
