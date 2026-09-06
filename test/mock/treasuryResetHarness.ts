/**
 * Treasury Core Rewrite II——共享完整 reset harness（任务书 §7.3）。
 *
 * 测试专用模块（非 .test.ts，不被 Jest 收集；生产模块不得 import）。
 * 完整 reset 至少执行：
 * 1. 严格消费指定断点或一致的当前快照，安装全新的 `JSON.parse` Memory
 *    （所有嵌套引用都与旧对象脱离）；
 * 2. jest.resetModules() 重建模块缓存（WeakSet permit 注册表、adapter/
 *    policy registry、service generation 计数、overlay/索引）+ 清退役
 *    global 槽；
 * 3. 从新加载模块构建 runtime：
 *    - service 面：新 adapter/policy registry + 新 facade
 *      （performTreasuryFullReset）；
 *    - kernel 面：新 kernel 模块 + 宿主 ports（performTreasuryKernelFullReset）；
 *    两个装配面共享同一 reset 核心（本模块是唯一完整 reset 实现；JSON
 *    往返后复用旧模块/注册表的 reloadKernel 形态不是完整 reset——
 *    Remediation II/V2）；
 * 4. 用配对的宿主世界重装观察源（不复活断点时已不存在的结构、不回退
 *    已发生效果），并运行真实 beginTick 恢复流程；
 * 5. 旧 permit/capability 由宿主作为攻击输入保留，由新 runtime 拒绝。
 *
 * 断点配对（Remediation II/§6.1）：一次断点由 captureTreasuryHostBreakpoint
 * 原子捆绑 Memory JSON + 当时宿主世界 + atTick + 世界序 + 宿主事件截断
 * 长度。指定较早 Memory 时不得默认配上 helper 调用时的较晚世界——恢复
 * 分支的世界与事件都来自断点对象；错配由入口一致性校验识别（F15/F20）。
 */

import type { TreasuryActionAdapter } from "@/runtime/treasury/actionContracts";
import type { TreasuryService } from "@/runtime/treasury/facade";
import type { TreasuryCoreKernel, TreasuryCoreKernelPorts } from "@/runtime/treasury/kernel/kernel";
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

export interface TreasuryKernelFullResetResult {
  readonly kernel: TreasuryCoreKernel;
  readonly kernelModule: typeof import("@/runtime/treasury/kernel/kernel");
  readonly beginTickStats: ReturnType<TreasuryCoreKernel["beginTick"]>;
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
 * 一次断点的三类互相对应输入（§6.1）：Memory JSON + 宿主世界 + 事件截断
 * （tick/世界序随行）。只能由 captureTreasuryHostBreakpoint 捆绑产生，
 * 不可手工拼配不同时刻的 Memory 与世界。
 */
export interface TreasuryHostBreakpoint {
  readonly kind: "treasury-host-breakpoint";
  readonly memorySnapshot: string;
  /** 断点时刻的宿主世界（不透明；随断点原样重装，不取入口当前值）。 */
  readonly world: WorldSnapshot;
  readonly atTick: number;
  /** 断点时刻的受控世界序（与 Memory.runtime.treasuryWorldSequence 一致）。 */
  readonly worldSequence: number;
  /** 断点时刻宿主事件日志长度（兼容口径；事件内容由 eventBranch 携带）。 */
  readonly eventCut: number;
  /**
   * 所选断点的封闭事件分支（journal.captureBranch() 产物）。加载器恢复
   * 本断点时调用 reopen() 从不可变副本重开分支（V1/§4.1）；无 journal 的
   * 断点（kernel 面 Memory/世界配对）无此字段——跳过，不猜测事件。
   */
  readonly eventBranch?: TreasuryHostBreakpointEventBranch;
}

/** 断点携带的宿主事件分支标记（结构匹配 treasuryExactOracle 的 marker）。 */
export interface TreasuryHostBreakpointEventBranch {
  readonly kind: "treasury-journal-branch";
  readonly count: number;
  reopen(): void;
}

function isEventBranch(value: unknown): value is TreasuryHostBreakpointEventBranch {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { kind?: unknown; reopen?: unknown };
  return candidate.kind === "treasury-journal-branch" && typeof candidate.reopen === "function";
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

/**
 * 重装房间规格，以快照为准（Remediation II/F15 修复）：房间在快照中存在
 * 时，结构存在性与数值完全跟随快照——快照缺失的结构不按初始 RoomSpec
 * 复活；快照未见过的房间按规格首次安装。
 */
function roomSpecsWithWorld(specs: readonly RoomSpec[], world: WorldSnapshot): RoomSpec[] {
  return specs.map((spec) => {
    const snap = world[spec.name];
    if (snap === undefined) return spec;
    return {
      ...spec,
      storage: snap.storage
        ? { id: snap.storage.id, resources: { ...snap.storage.resources }, freeCapacity: snap.storage.freeCapacity }
        : null,
      terminal: snap.terminal
        ? { id: snap.terminal.id, resources: { ...snap.terminal.resources }, freeCapacity: snap.terminal.freeCapacity }
        : null,
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

/** 读取受控世界序（与生产同一持久域：Memory.runtime.treasuryWorldSequence）。 */
function readHostWorldSequence(): number {
  const runtime = (globalThis as unknown as { Memory: { runtime?: { treasuryWorldSequence?: unknown } } }).Memory.runtime;
  const value = runtime?.treasuryWorldSequence;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * 原子捕获一次宿主断点：Memory JSON + 世界 + tick + 世界序 + 事件事实。
 * 传入 journal.captureBranch() 产物（事件分支标记）时，断点携带该标记——
 * 恢复由加载器调用 reopen() 从捕获时刻的不可变副本重开分支（V1/§4.1）；
 * 传入普通事件数组（只读引用）时仅记录长度（kernel 面 Memory/世界配对，
 * 无事件内容——恢复不猜测）；断点以后旧栈继续产生的事件不混入恢复分支。
 */
export function captureTreasuryHostBreakpoint(
  events?: readonly unknown[] | TreasuryHostBreakpointEventBranch,
): TreasuryHostBreakpoint {
  const branch = events !== undefined && isEventBranch(events) ? events : undefined;
  const plainEvents = events !== undefined && !isEventBranch(events) ? events : undefined;
  return {
    kind: "treasury-host-breakpoint",
    memorySnapshot: snapshotWholeMemory(),
    world: snapshotWorld(),
    atTick: Game.time,
    worldSequence: readHostWorldSequence(),
    eventCut: branch !== undefined ? branch.count : plainEvents?.length ?? 0,
    ...(branch !== undefined ? { eventBranch: branch } : {}),
  };
}

/** 断点配对一致性校验：Memory 内世界序（缺失=0）与捆绑世界序一致（错配即失败）。 */
function assertBreakpointConsistency(breakpoint: TreasuryHostBreakpoint): void {
  const parsed = JSON.parse(breakpoint.memorySnapshot) as { runtime?: { treasuryWorldSequence?: unknown } };
  const raw = parsed.runtime?.treasuryWorldSequence;
  const memorySeq = typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
  if (memorySeq !== breakpoint.worldSequence) {
    throw new Error(
      `断点配对不一致：Memory 世界序 ${String(memorySeq)} ≠ 断点捆绑世界序 ${String(breakpoint.worldSequence)}（Memory、世界与事件必须来自同一断点）`,
    );
  }
}

/**
 * 完整 reset 共享核心（步骤 1–2 与世界重装）：安装 JSON 重载的新全局
 * Memory（断点优先）→ 重建模块缓存 → 清退役 global → 按断点世界（或入口
 * 当前世界）重装房间。
 */
function resetRuntimeCore(input: {
  readonly roomSpecs: readonly RoomSpec[];
  readonly memorySnapshot?: string;
  readonly breakpoint?: TreasuryHostBreakpoint;
  readonly advanceTicks?: number;
}): Record<string, Room> {
  if (input.breakpoint !== undefined) {
    assertBreakpointConsistency(input.breakpoint);
    // 指定断点：Memory、世界、tick 全部来自断点对象（不混入入口当前值）。
    installWholeMemorySnapshot(input.breakpoint.memorySnapshot);
    // 事件事实同样来自所选断点（V1/§4.1）：从捕获时刻的不可变副本重开
    // 分支——加载器实际应用所选断点，不依赖最近一次截断的共享可变状态。
    input.breakpoint.eventBranch?.reopen();
  } else {
    installWholeMemorySnapshot(input.memorySnapshot ?? snapshotWholeMemory());
  }
  jest.resetModules();
  // §9.3/IV R7：清空被测运行时遗留的全部 Treasury global 槽——世界序权威
  // 在 Memory 持久层（Memory.runtime.treasuryWorldSequence），跨 reset 的
  // 观察覆盖判定用它；旧 global 槽已退役，清理防其作为残留污染断言。
  delete (globalThis as { __treasuryWorldSequence?: number }).__treasuryWorldSequence;
  if (input.breakpoint !== undefined) {
    // 恢复分支从断点 tick 继续（许可原有 tick/runtime 期限按断点时刻解释）。
    Game.time = input.breakpoint.atTick;
  }
  if (input.advanceTicks !== undefined && input.advanceTicks > 0) {
    Game.time += input.advanceTicks;
  }
  // §6.3/IV：重装 mock 房间保留已发生的世界效果（结构与数值原样搬运，
  // 不重置回规格初始值；快照缺失的结构不复活）。世界序不在 global（已清）
  // ——Memory 持久世界序随快照保留，重装不 bump（重建是基建行为而非世界推进）。
  const world = input.breakpoint !== undefined ? input.breakpoint.world : snapshotWorld();
  return installRooms(roomSpecsWithWorld(input.roomSpecs, world));
}

/**
 * 执行完整 reset（service 装配面）：JSON 重载 Memory + 模块缓存重建 +
 * registry 重装 + 新 facade + 真实 beginTick。
 *
 * 契约（Remediation I/§7.1 + II/§6.1）：
 * - 指定 breakpoint 时严格使用该断点的 Memory、世界与 tick；
 * - 只指定 memorySnapshot（无断点对象）时安装该 Memory，世界取入口当前
 *   值（调用方自行保证二者同刻一致；需要世界/事件配对时必须用 breakpoint）；
 * - 都缺省时由 helper 在入口取得当时快照并立即重载。
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
   * 明确的序列化 Memory 快照（JSON.stringify(Memory) 产物）。与 breakpoint
   * 互斥；需要世界/事件配对时使用 breakpoint。
   */
  readonly memorySnapshot?: string;
  /** 原子捕获的宿主断点（Memory+世界+tick+世界序+事件截断）。 */
  readonly breakpoint?: TreasuryHostBreakpoint;
}): TreasuryFullResetResult {
  const rooms = resetRuntimeCore(input);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const facadeModule = require("@/runtime/treasury/facade") as typeof import("@/runtime/treasury/facade");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const actionContractsModule = require("@/runtime/treasury/actionContracts") as typeof import("@/runtime/treasury/actionContracts");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const policyModule = require("@/runtime/treasury/policyAuthority") as typeof import("@/runtime/treasury/policyAuthority");
  // 正常装配新的受控 adapter/policy。
  actionContractsModule.replaceTreasuryActionAdapterForTest(input.adapter);
  policyModule.unsealTreasuryPolicyRegistryForTest();
  policyModule.clearTreasuryPolicyResolversForTest();
  policyModule.registerTreasuryPolicyResolver(
    (input.policy as ReturnType<typeof policyModule.makeNoReserveTreasuryPolicy>) ??
      policyModule.makeNoReserveTreasuryPolicy(),
  );
  const service = facadeModule.createTreasuryService({
    getRooms: () => Object.values(rooms),
    holderExists: () => true,
  });
  service.beginTick();
  return { service, handles: { facadeModule, actionContractsModule, policyModule }, rooms };
}

/**
 * 执行完整 reset（kernel 装配面）：与 performTreasuryFullReset 共享同一
 * reset 核心（JSON 重载 Memory + jest.resetModules + 退役 global 清理）；
 * 装配面换为新加载 kernel 模块 + 宿主提供的 ports。受控释放/观察端口的
 * 宿主闭包跨 reset 保留（宿主数据继承，被测运行时对象/注册表不继承——
 * §6.3）。公平性与组合验收循环必须经本入口或 service 入口，不得回退
 * reloadKernel 形态（V2/F14）。
 */
export function performTreasuryKernelFullReset(input: {
  /** 宿主 ports（跨 reset 保留；kernel 与 permit 注册表全部来自新模块）。 */
  readonly ports: TreasuryCoreKernelPorts;
  readonly memorySnapshot?: string;
  readonly breakpoint?: TreasuryHostBreakpoint;
  readonly advanceTicks?: number;
  /** 重装房间规格（kernel 面 ports 不观察房间时可传空数组跳过世界重装）。 */
  readonly roomSpecs?: RoomSpec[];
  /** 是否运行 beginTick（默认 true——恢复流程是完整 reset 的一部分）。 */
  readonly runBeginTick?: boolean;
}): TreasuryKernelFullResetResult {
  resetRuntimeCore({
    roomSpecs: input.roomSpecs ?? [],
    memorySnapshot: input.memorySnapshot,
    breakpoint: input.breakpoint,
    advanceTicks: input.advanceTicks,
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const kernelModule = require("@/runtime/treasury/kernel/kernel") as typeof import("@/runtime/treasury/kernel/kernel");
  const kernel = kernelModule.createTreasuryCoreKernel(input.ports);
  const beginTickStats =
    input.runBeginTick === false ? { recovered: 0, closed: 0, cleaned: 0, cancelled: 0 } : kernel.beginTick();
  return { kernel, kernelModule, beginTickStats };
}
