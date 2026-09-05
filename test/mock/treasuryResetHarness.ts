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

interface WorldStructureSnapshot {
  readonly id: string;
  readonly resources: Record<string, number>;
  readonly freeCapacity: number;
}

interface WorldSnapshot {
  readonly [roomName: string]: {
    readonly storage?: WorldStructureSnapshot;
    readonly terminal?: WorldStructureSnapshot;
  };
}

/**
 * 快照当前受控世界（§6.3：重装 mock 房间不得把已发生的世界效果重置回
 * 原余额——结构与数值原样保留；世界序不回退）。
 */
function snapshotWorld(): WorldSnapshot {
  const rooms = (globalThis as unknown as { Game: { rooms?: Record<string, Room> } }).Game.rooms ?? {};
  const snapshot: Record<string, { storage?: WorldStructureSnapshot; terminal?: WorldStructureSnapshot }> = {};
  for (const [roomName, room] of Object.entries(rooms)) {
    const entry: { storage?: WorldStructureSnapshot; terminal?: WorldStructureSnapshot } = {};
    for (const kind of ["storage", "terminal"] as const) {
      const structure = (room as unknown as Record<string, { id: string; store: Record<string, number> } | undefined>)[kind];
      if (structure === undefined) continue;
      const resources: Record<string, number> = {};
      const freeCapacity =
        (structure.store as unknown as { __freeCapacity?: number }).__freeCapacity ?? 0;
      for (const key of Object.keys(structure.store)) {
        const value = structure.store[key];
        if (typeof value === "number") resources[key] = value;
      }
      entry[kind] = { id: structure.id, resources, freeCapacity };
    }
    snapshot[roomName] = entry;
  }
  return snapshot as WorldSnapshot;
}

/** 重装房间规格，但保留快照中的结构 ID 与世界数值（效果不重置）。 */
function roomSpecsWithWorld(specs: readonly RoomSpec[], world: WorldSnapshot): RoomSpec[] {
  return specs.map((spec) => {
    const snap = world[spec.name];
    if (snap === undefined) return spec;
    return {
      ...spec,
      storage: spec.storage && snap.storage
        ? { id: snap.storage.id, resources: { ...snap.storage.resources }, freeCapacity: snap.storage.freeCapacity }
        : spec.storage,
      terminal: spec.terminal && snap.terminal
        ? { id: snap.terminal.id, resources: { ...snap.terminal.resources }, freeCapacity: snap.terminal.freeCapacity }
        : spec.terminal,
    };
  });
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
 * 执行完整 reset：内存快照强制 JSON 重载 + 模块缓存重建 + registry 重装 +
 * 新 facade + 真实 beginTick。
 *
 * 契约（Remediation I/§7.1——消除"取了快照却没用"的余地）：
 * - 指定 memorySnapshot（断点快照）时**严格使用该快照**安装新全局
 *   Memory——不悄悄重新序列化后来已被 catch/finally 修好的当前 Memory；
 * - 未指定时由 helper 在入口取得当时快照并**立即重载**（JSON 往返，根与
 *   全部嵌套引用与旧对象脱离——旧引用修改不进入新运行时）。
 * 两种路径都保证：构建新运行时前，全局 Memory 是 JSON.parse 的产物。
 */
export function performTreasuryFullReset(input: {
  readonly roomSpecs: RoomSpec[];
  /** 受控 adapter（trace 闭包由宿主持有——跨 reset 持续记录）。 */
  readonly adapter: TreasuryActionAdapter;
  /** 可选 policy（默认无 reserve）。 */
  readonly policy?: unknown;
  readonly advanceTicks?: number;
  /**
   * 明确的序列化 Memory 快照（指定断点时必须提供；缺省 = 入口取得当时
   * 快照并立即重载）。快照须为 JSON.stringify(Memory) 产物。
   */
  readonly memorySnapshot?: string;
}): TreasuryFullResetResult {
  // 1) 完整 reset 的第一步：安装 JSON 重载的新全局 Memory（Remediation I
  //    V2——此前版本允许沿用原 Memory 对象，引用隔离不成立）。
  installWholeMemorySnapshot(input.memorySnapshot ?? snapshotWholeMemory());
  // 3) 重建模块缓存：WeakSet permit 注册表、adapter/policy registry、
  //    service generation 计数全部归零（旧 heap 许可失去注册）。
  jest.resetModules();
  // §9.3/IV R7：清空被测运行时遗留的全部 Treasury global 槽——世界序权威
  // 在 Memory 持久层（Memory.runtime.treasuryWorldSequence），跨 reset 的
  // 观察覆盖判定用它；旧 global 槽已退役，清理防其作为残留污染断言。
  delete (globalThis as { __treasuryWorldSequence?: number }).__treasuryWorldSequence;
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
  // §6.3/IV：重装 mock 房间保留已发生的世界效果（结构 ID 与数值原样
  // 搬运，不重置回规格初始值）。世界序不在 global（已清）——Memory 持久
  // 世界序随快照保留，重装不 bump（重建是基建行为而非世界推进）。
  const world = snapshotWorld();
  const rooms = installRooms(roomSpecsWithWorld(input.roomSpecs, world));
  const service = facadeModule.createTreasuryService({
    getRooms: () => Object.values(rooms),
    holderExists: () => true,
  });
  service.beginTick();
  return { service, handles: { facadeModule, actionContractsModule, policyModule }, rooms };
}
