/**
 * Treasury Core Rewrite II——共享完整 reset harness（任务书 §7.3）。
 *
 * 测试专用模块（非 .test.ts，不被 Jest 收集；生产模块不得 import）。
 * 完整 reset 至少执行：
 * 1. 取得选定断点的 JSON 可持久快照（整个 Memory；宿主副作用轨迹由调用
 *    方闭包另行保留，独立于 Memory 与模块重载）；
 * 2. 将 JSON.parse(serialized) 的结果真正安装为新的全局 Memory（所有嵌套
 *    引用都与旧对象脱离）；
 * 3. jest.resetModules() 重建模块缓存（WeakSet permit 注册表、adapter/
 *    policy registry、service generation 计数、overlay/索引）；
 * 4. 正常装配新的受控 adapter/policy 与 facade，推进 Game.time 并运行
 *    真实 beginTick 恢复流程；
 * 5. 旧 permit/capability 由宿主作为攻击输入保留，由新 runtime 拒绝。
 *
 * 只新建 service、只 reset 某一个 store、只 JSON.parse 后拿来比较，
 * 均不是完整 reset——本模块是唯一实现。
 */

import type { TreasuryActionAdapter } from "@/runtime/treasury/actionContracts";
import type { TreasuryService } from "@/runtime/treasury/facade";
import { installRooms, type RoomSpec } from "./treasury";

/** 新 runtime 的模块句柄（测试用于断言/进一步操作新 registry）。 */
export interface TreasuryResetRuntimeHandles {
  readonly facadeModule: typeof import("@/runtime/treasury/facade");
  readonly actionContractsModule: typeof import("@/runtime/treasury/actionContracts");
  readonly policyModule: typeof import("@/runtime/treasury/policyAuthority");
}

export interface TreasuryFullResetResult {
  readonly service: TreasuryService;
  readonly handles: TreasuryResetRuntimeHandles;
  readonly rooms: Record<string, Room>;
}

/** 宿主侧的旧许可攻击输入（reset 后必须被新 runtime 拒绝）。 */
export interface TreasuryLegacyAttackInputs {
  readonly dispatch?: unknown;
  readonly rearm?: unknown;
}

/** 序列化整个全局 Memory（断点快照）。 */
export function snapshotWholeMemory(): string {
  return JSON.stringify((globalThis as unknown as { Memory: unknown }).Memory);
}

/** 将快照真正安装为新的全局 Memory（JSON 往返，嵌套引用全部脱离旧对象）。 */
export function installWholeMemorySnapshot(snapshot: string): void {
  (globalThis as unknown as { Memory: unknown }).Memory = JSON.parse(snapshot);
}

/**
 * 执行完整 reset：模块缓存重建 + registry 重装 + 新 facade + 真实
 * beginTick。调用方须先 installWholeMemorySnapshot（或保留既有 Memory）。
 */
export function performTreasuryFullReset(input: {
  readonly roomSpecs: RoomSpec[];
  /** 受控 adapter（trace 闭包由宿主持有——跨 reset 持续记录）。 */
  readonly adapter: TreasuryActionAdapter;
  /** 可选 policy（默认无 reserve）。 */
  readonly policy?: unknown;
  readonly advanceTicks?: number;
}): TreasuryFullResetResult {
  // 3) 重建模块缓存：WeakSet permit 注册表、adapter/policy registry、
  //    service generation 计数全部归零（旧 heap 许可失去注册）。
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const facadeModule = require("@/runtime/treasury/facade") as typeof import("@/runtime/treasury/facade");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const actionContractsModule = require("@/runtime/treasury/actionContracts") as typeof import("@/runtime/treasury/actionContracts");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const policyModule = require("@/runtime/treasury/policyAuthority") as typeof import("@/runtime/treasury/policyAuthority");
  // 4) 正常装配新的受控 adapter/policy。
  actionContractsModule.replaceTreasuryActionAdapterForTest(input.adapter);
  policyModule.unsealTreasuryPolicyRegistryForTest();
  policyModule.clearTreasuryPolicyResolversForTest();
  policyModule.registerTreasuryPolicyResolver(
    (input.policy as ReturnType<typeof policyModule.makeNoReserveTreasuryPolicy>) ??
      policyModule.makeNoReserveTreasuryPolicy(),
  );
  if (input.advanceTicks !== undefined && input.advanceTicks > 0) {
    Game.time += input.advanceTicks;
  }
  const rooms = installRooms(input.roomSpecs);
  const service = facadeModule.createTreasuryService({
    getRooms: () => Object.values(rooms),
    holderExists: () => true,
  });
  service.beginTick();
  return { service, handles: { facadeModule, actionContractsModule, policyModule }, rooms };
}
