/**
 * Treasury Core Kernel——装配与单一写入口（Core Rewrite II 运行核心）。
 *
 * 契约（design II §4–§6）：
 * - 一切持久状态变更经 applyTreasuryCoreCommand（commands.ts 纯转移 +
 *   writeTreasuryCoreMemory 发布确认：基线漂移检查 + 读回与草稿深度精确
 *   比较）。恢复、GC、容量回收没有旁路。
 * - 正向执行许可（dispatch permit）只在 admit / rearm 成功时签发，heap-only
 *   深冻结快照，跨 tick / runtime generation 失效；executeDispatch 校验
 *   许可对象身份、冻结完整性、活跃记录、当前阶段与完整身份事实后才调用
 *   动作——外部字符串 ID 永远不是许可，真许可的可变字段也不可信。
 * - dispatch 顺序固定：许可校验 → dispatching 发布（持久+发布确认，失败则
 *   零调用、保持 pending）→ permit 置 consumed → 动作恰好一次（参数来自
 *   冻结签发快照）→ 三种事实（invocation / external accept / settlement）
 *   分别持久。
 * - beginTick/endTick：dispatching 保守化 → 跨 tick pending 安全取消（§6.1）
 *   → retry 期限关闭 → closing 公平清理（持久游标轮转 + per-tick 操作预算，
 *   同 tick 多入口共享）；未知结果不能被推导成 not-executed。
 * - 结算结论只来自受控 reconcileOutcome 端口（facade 装配的注册
 *   reconciler）；自报 external receipt 通道不存在（R07）。
 * - 无受控释放端口时：非空 externalConsumers 的接纳被拒绝；已持久义务在
 *   端口缺失/未确认/抛错时保持 active（无默认成功——R05）。
 * - 满载拒绝新工作（含总序列化预算）；已接纳工作始终可获得恢复/收尾预算。
 */

import {
  TREASURY_CORE_CONSUMER_KEYS_MAX,
  TREASURY_CORE_RECOVERY_BUDGET_PER_TICK,
  TREASURY_CORE_SCHEMA_VERSION,
  TREASURY_CORE_SUBBUDGET_DISPATCHING,
  TREASURY_CORE_SUBBUDGET_RETRY_CLOSE,
  TREASURY_CORE_SUBBUDGET_SWEEP,
  TREASURY_CORE_TOTAL_CHAR_BUDGET,
  type TreasuryCoreAdmissionContext,
  type TreasuryCoreDispatchPermit,
  type TreasuryCoreIdentityFacts,
  type TreasuryCoreMemory,
  type TreasuryCoreRearmPermit,
  type TreasuryCoreStoreHealth,
  type TreasuryCoreWorstCaseLeg,
  type TreasuryCoreWorkRecord,
} from "@/runtime/treasury/kernel/types";
import { cloneTreasuryDurableValue } from "@/runtime/treasury/durableClone";
import { readTreasuryWorldSequence } from "@/runtime/treasury/observation";
import {
  applyTreasuryCoreStateCommand,
  type TreasuryCoreCommand,
  type TreasuryCoreEffect,
} from "@/runtime/treasury/kernel/commands";
import {
  detectLegacyTreasuryStores,
  initializeTreasuryCoreStore,
  readTreasuryCoreStoreHealth,
  resetTreasuryCoreRingLayer,
  treasuryCoreRingSlotWorstChars,
  treasuryCoreSerializedChars,
  treasuryCoreSlotWorstChars,
  writeTreasuryCoreMemory,
} from "@/runtime/treasury/kernel/store";
import {
  isValidTreasuryCoreWorkKey,
  mintTreasuryCoreDispatchPermit,
  mintTreasuryCoreRearmPermit,
  treasuryCorePermitRecordConflicts,
  validateTreasuryCoreDispatchPermit,
  validateTreasuryCoreRearmPermit,
} from "@/runtime/treasury/kernel/identity";
import {
  treasuryCoreCoverageAnchorOf,
  treasuryCoreObservationAdvancesPastAnchor,
} from "@/runtime/treasury/kernel/coverage";

/** kernel 依赖的窄 adapter 端口（facade 从注册表适配；kernel 不依赖注册表实现）。 */
/**
 * 生命周期推进所有权（Remediation III/R1/§3.1）：同一运行时/同一 Treasury
 * 调度域只允许一个生命周期推进栈。模块级共享（所有 kernel 实例同一模块
 * 时同属一个调度域）——不按 treasuryCore 对象引用分锁（安全写会替换该
 * 对象）、不为每实例单独建锁。回调重入 beginTick 时结构化返回零推进，
 * 不递归扫描或调用释放端口；普通异常路径由 finally 释放，真正硬终止由
 * 新运行时（完整 reset 重建模块）从已发布状态恢复。guard 是有界运行时
 * 协调，不是持久权威——完整 reset 后必须丢失（预算/cursor/remaining 仍
 * 由 Memory 保持）。
 */
let lifecycleAdvanceInFlight = false;

/**
 * endTick 关窗否决标记（Remediation V/R1/§2.3）：单一、固定大小、按 tick
 * 失效的模块级运行时事实——记录"本运行时（本模块全部实例）已请求结束
 * tick <n>"。endTick 请求一经发出即置位，先于任何恢复回调、且独立于其后
 * 持久关窗发布的成败；所有接纳/执行/rearm 门禁共享消费（admit/
 * executeDispatch/executeRearm 与 facade 的授权窗口），不能只阻断发起
 * endTick 的实例。它**仅作否决条件**：不授予执行权、不证明持久关闭、
 * 不写新永久 store；same-tick beginTick 不得清除（清理/恢复继续，业务
 * 仍拒）；下一 tick 按 tick 失效、原流程开新窗口（无永久闩锁）；完整
 * reset（模块重建）后丢失——跨运行时的关窗权威仍是持久
 * lifecycle.lastEndTick。全 heap 丢失后不能从未落盘信息重建结束请求
 * （§2.3 故障模型边界，不设计第二份永久证书）。
 */
let endTickAdmissionVetoTick: number | null = null;

/**
 * 测试辅助：清除模块级运行时生命周期事实（推进 guard 与 endTick 关窗
 * 否决标记）。完整 reset（jest.resetModules 重建模块）天然清零；同模块内
 * 的逐用例隔离由 resetTreasuryCoreStoreForTest 调用本函数完成——否决
 * 标记按 tick 失效的设计使其可能跨用例存活（同一 Game.time），必须随
 * 持久根一起显式清理（生产路径不调用）。
 */
export function resetTreasuryCoreLifecycleFactsForTest(): void {
  lifecycleAdvanceInFlight = false;
  endTickAdmissionVetoTick = null;
}

export interface TreasuryCoreActionAdapterPort {
  readonly kind: string;
  readonly version: number;
  readonly registrationId: string;
  readonly semanticIdentity: string;
  /** 动作执行（受控调用边界的唯一外部副作用入口）。 */
  execute(args: unknown): { ok: boolean };
  /** adapter 显式声明：外部接口接受即世界效果确认（默认 false——保守）。 */
  readonly settlesOnAccept: boolean;
  /** adapter 显式声明：non-ok 返回的语义（默认 "unknown"——保守）。 */
  readonly nonOkOutcome: "not_executed" | "unknown";
}

/** 受控对账端口：结论由 facade 装配的注册 reconciler 得出（内核唯一结算通道）。 */
export type TreasuryCoreReconcileOutcomePort = (record: TreasuryCoreWorkRecord) =>
  | { readonly status: "ok"; readonly conclusion: "executed" | "not_executed" | "still_uncertain"; readonly source: string }
  | { readonly status: "rejected"; readonly reason: string };

export interface TreasuryCoreKernelPorts {
  readonly nowTick: () => number;
  /** runtime generation（facade service 生成号；global reset 后变化）。 */
  readonly runtimeGeneration: () => number;
  readonly findAdapter: (kind: string) => TreasuryCoreActionAdapterPort | undefined;
  /** 受控对账端口（settle 结论唯一来源；缺省即无法结算——unknown 保留）。 */
  readonly reconcileOutcome?: TreasuryCoreReconcileOutcomePort;
  /**
   * 接纳容量端口（III/R2）：由 facade 用 exact observation + kernel 占用 +
   * 完整授权上下文实现——context 携带真实 contract 身份与经验证的 owner，
   * 不允许退化为匿名口径。返回拒绝原因或 null（可用）。
   */
  readonly checkAdmissionCapacity: (
    worstCase: readonly TreasuryCoreWorstCaseLeg[],
    context: TreasuryCoreAdmissionContext | undefined,
  ) => { readonly reason: string; readonly reasonCode?: TreasuryCoreRejectionCode } | null;
  /** 外部消费者幂等释放端口（返回 false = 释放未确认，duty 保留；缺失即无受控释放能力）。 */
  readonly releaseExternalConsumer?: (consumerKey: string, attemptId: string) => boolean;
  /**
   * 清理观察锚点端口（IV/R1/§4.1）：为 committed 聚合的退出条件提供可信
   * 观察事实（世界序 + 观察构建 tick + 位置覆盖谓词）。由 facade 从共享
   * 观察装配（构建于本 tick 开始或其后重建——含此前全部已发生效果）；
   * 缺失时 committed 记录保守保留（不退出、不进 ring）。返回 null = 当前
   * 无可信观察。
   */
  readonly observeForCleanup?: () => {
    readonly worldSequence: number;
    readonly atTick: number;
    readonly locationExists: (roomName: string, locationKind: string) => boolean;
  } | null;
  /** 诊断事件流（可选；测试计量与 metrics 挂载点，不影响权威）。 */
  readonly onEffect?: (effect: TreasuryCoreEffect) => void;
}

export interface TreasuryCoreAdmissionInput {
  readonly workKey: string;
  readonly identity: TreasuryCoreIdentityFacts;
  readonly worstCase: readonly TreasuryCoreWorstCaseLeg[];
  readonly externalConsumers: readonly string[];
  /** 当次调用的 canonical frozen args（只进 permit，不持久）。 */
  readonly canonicalArgs: unknown;
  /** 签发时的原始 posting 腿（只进 permit，不持久）。 */
  readonly postings: readonly { roomName: string; locationKind: string; resource: string; delta: number }[];
  /** 完整授权上下文（真实 contract 身份 + 验证 owner；端口判定唯一口径）。 */
  readonly admissionContext: TreasuryCoreAdmissionContext;
  /** 签发时观察的结构绑定快照（只进 permit；复验比对 incarnation）。 */
  readonly structureBindings: readonly { roomName: string; locationKind: string; structureId: string }[];
}

export type TreasuryCoreAdmissionResult =
  | {
      readonly status: "admitted";
      readonly attemptId: string;
      readonly dispatch: TreasuryCoreDispatchPermit;
    }
  | { readonly status: "rejected"; readonly reason: string; readonly reasonCode: TreasuryCoreRejectionCode };

export type TreasuryCoreRejectionCode =
  | "policy_unavailable"
  | "policy_fault"
  | "policy_violation"
  | "insufficient_amount"
  | "store_unhealthy"
  | "store_incompatible"
  | "legacy_store_present"
  | "active_full"
  | "work_key_conflict"
  | "invalid_input"
  | "capacity_insufficient"
  | "release_port_unavailable"
  | "memory_budget_exceeded"
  | "lifecycle_closed"
  | "structure_changed"
  | "write_failed";

export type TreasuryCoreDispatchOutcome =
  | { readonly status: "committed"; readonly attemptId: string }
  | { readonly status: "not_executed"; readonly attemptId: string }
  | { readonly status: "unknown"; readonly attemptId: string; readonly reason?: string }
  /** 前置拒绝：动作调用 0 次。 */
  | { readonly status: "rejected"; readonly reason: string }
  /**
   * 执行门禁阻断（III/§4.4）：当前授权窗口关闭、执行前复验失败或结构
   * incarnation 变化。动作调用 0 次，不消费许可，记录保持 pending（可
   * 显式取消或按既定规则过期取消）。
   */
  | { readonly status: "blocked"; readonly reasonCode: string; readonly reason: string }
  /** dispatching 发布失败：动作调用 0 次，聚合保持 pending。 */
  | { readonly status: "publish_failed"; readonly reason: string }
  /**
   * 结果持久失败：动作已发生（invocation 计 1），聚合按保守方向处理。
   * observed 是 kernel 在 heap 观察到的方向；持久状态至少推进为
   * outcome_unknown（endTick/beginTick 会再尝试恢复）。
   */
  | {
      readonly status: "persist_failed";
      readonly attemptId: string;
      readonly observed: "unknown" | "committed" | "not_executed";
      readonly reason: string;
    };

export interface TreasuryCoreKernelMetrics {
  readonly activeCount: number;
  readonly pendingCount: number;
  readonly unknownCount: number;
  readonly closingCount: number;
  readonly retryReadyCount: number;
  readonly ringCount: number;
  readonly frontier: number;
  readonly burned: number;
  readonly counters: TreasuryCoreMemory["counters"];
  readonly legacyStores: readonly string[];
}

/** 本 runtime 已消费的 permit（防同 tick 重入/重复执行）。 */
const consumedPermits = new WeakSet<TreasuryCoreDispatchPermit>();

export interface TreasuryCoreKernel {
  readonly health: () => TreasuryCoreStoreHealth;
  readonly legacyStores: () => readonly string[];
  readonly metrics: () => TreasuryCoreKernelMetrics;
  readonly admit: (input: TreasuryCoreAdmissionInput) => TreasuryCoreAdmissionResult;
  readonly executeDispatch: (permit: unknown) => TreasuryCoreDispatchOutcome;
  /**
   * 只读许可预检（Remediation I/R4/§6.2）：在 facade 消耗 fresh/policy
   * 等高成本资源**之前**确认许可真实性——本 runtime 签发（WeakSet 对象
   * 身份）、当前 tick/generation 有效、未被消费、且对应当前可执行活跃
   * attempt。纯只读：不消费许可、不写状态；返回结果不是可脱离当前状态
   * 复用的执行凭证（真正调用边界的终验仍在 executeDispatch 内完成）。
   */
  readonly preflightDispatchPermit: (permit: unknown) => { readonly status: "valid" } | { readonly status: "invalid"; readonly reason: string };
  /** 同 preflightDispatchPermit（rearm 许可；父代须 retry_ready）。 */
  readonly preflightRearmPermit: (permit: unknown) => { readonly status: "valid" } | { readonly status: "invalid"; readonly reason: string };
  /** 事后结算（outcome_unknown → committed/not_executed；结论只来自受控对账端口）。 */
  readonly settle: (input: {
    attemptId: string;
  }) => { readonly status: "ok" } | { readonly status: "still_uncertain" } | { readonly status: "rejected"; readonly reason: string };
  readonly issueRearmPermit: (input: {
    parentAttemptId: string;
  }) => { readonly status: "ok"; readonly rearm: TreasuryCoreRearmPermit } | { readonly status: "rejected"; readonly reason: string };
  readonly executeRearm: (
    rearm: unknown,
    next: {
      readonly identity: TreasuryCoreIdentityFacts;
      readonly worstCase: readonly TreasuryCoreWorstCaseLeg[];
      readonly canonicalArgs: unknown;
      readonly postings: readonly { roomName: string; locationKind: string; resource: string; delta: number }[];
      readonly admissionContext: TreasuryCoreAdmissionContext;
      readonly structureBindings: readonly { roomName: string; locationKind: string; structureId: string }[];
    },
  ) => TreasuryCoreAdmissionResult;
  /** 安全取消：只结束确定未开始的当前 pending attempt（§6.1）。 */
  readonly cancelPending: (input: {
    attemptId: string;
  }) => { readonly status: "ok" } | { readonly status: "rejected"; readonly reason: string };
  readonly closeWork: (input: {
    attemptId: string;
    reason: "retry_expired" | "abandoned";
  }) => { readonly status: "ok" } | { readonly status: "rejected"; readonly reason: string };
  readonly beginTick: () => { readonly recovered: number; readonly closed: number; readonly cleaned: number; readonly cancelled: number };
  /**
   * 结束当前 tick（Remediation V/R1/§2.3 关窗先行）：请求即置运行时否决
   * 标记 → 安全写协议发布并确认 lastEndTick → 重读权威后在同一推进所有
   * 权下运行恢复及回调 → 尾部只维护预算/游标事实（关窗事实幂等重申）。
   * closurePersisted 如实反映关窗事实当前是否已持久确认（发布失败不
   * 谎报；否决标记与持久确认是不同职责——前者本 tick 拒绝新增业务，
   * 后者是跨运行时的关窗权威）。
   */
  readonly endTick: () => { readonly recoveredToUnknown: number; readonly closurePersisted: boolean };
  /**
   * endTick 关窗否决标记当前是否生效（Remediation V/R1/§2.3）：单一、按
   * tick 失效的运行时否决事实，所有 facade/核心执行门禁共享消费。只读
   * 查询，不授予任何执行权。**仅表示 heap 事实**（本运行时是否发出过
   * endTick 请求）——完整新增业务门禁见 admissionGateStatus。
   */
  readonly admissionVetoActive: () => boolean;
  /**
   * 新增业务共享只读门禁（Remediation VI/R1/§2.4）：健康持久核心的
   * lifecycle.lastEndTick === 当前 tick（持久关窗——跨运行时权威）或本
   * 运行时 heap 否决标记（endTick 请求已发出：持久发布待确认或失败）任一
   * 成立即关闭。kernel 三条写入口（admit/executeDispatch/executeRearm）
   * 与 facade 授权窗口共用同一判定与原因文本；恢复/清理/取消/close 不受
   * 此门禁限制。查询纯读（不初始化/不迁移/不修 ring/不写 Memory），不
   * 缓存开放结论——每次现读当前可信记录。非健康核心无持久事实可依，
   * 退化为 heap 单口径（随后原有健康检查按原语义拒绝，不视为可执行）。
   */
  readonly admissionGateStatus: () => { readonly status: "open" } | { readonly status: "closed"; readonly reason: string } ;
}

export function createTreasuryCoreKernel(ports: TreasuryCoreKernelPorts): TreasuryCoreKernel {
  // 旧业务数据检测按调用时快照进行（运行中出现/清除都会被下一次检查反映；
  // 只读键存在性，成本 O(已知键数)）。
  function legacyNow(): readonly string[] {
    return detectLegacyTreasuryStores();
  }

  type WritableHealth =
    | { status: "writable"; memory: TreasuryCoreMemory; ringDegraded: string | null }
    | { status: "blocked"; code: TreasuryCoreRejectionCode; reason: string };
  function requireWritableHealth(): WritableHealth {
    if (legacyNow().length > 0) {
      return {
        status: "blocked",
        code: "legacy_store_present",
        reason: `检测到旧 Treasury 业务数据（${legacyNow().join(",")}）——不解析、不擦除，新内核写入阻断`,
      };
    }
    const health = readTreasuryCoreStoreHealth();
    if (health.status === "unhealthy") return { status: "blocked", code: "store_unhealthy", reason: health.reason };
    if (health.status === "incompatible") return { status: "blocked", code: "store_incompatible", reason: health.reason };
    if (health.status === "absent") {
      const init = initializeTreasuryCoreStore(ports.nowTick());
      if (!init.initialized) {
        return { status: "blocked", code: "write_failed", reason: `内核显式初始化失败：${init.reason ?? "未知"}` };
      }
      const after = readTreasuryCoreStoreHealth();
      if (after.status !== "healthy") {
        return { status: "blocked", code: "write_failed", reason: `初始化后读取异常：${after.status === "absent" ? "缺失" : after.reason}` };
      }
      return { status: "writable", memory: after.memory, ringDegraded: after.ringDegraded };
    }
    return { status: "writable", memory: health.memory, ringDegraded: health.ringDegraded };
  }

  function runCommand(
    command: TreasuryCoreCommand,
  ): { readonly status: "applied"; readonly effects: readonly TreasuryCoreEffect[] } | { readonly status: "failed"; readonly reason: string } {
    const health = requireWritableHealth();
    if (health.status === "blocked") return { status: "failed", reason: health.reason };
    // 在写入副本上先跑纯转移：非 admit 命令被拒绝时不落盘；admit 的拒绝
    // 只递增 rejectedAdmissions 计数器（纯函数在副本上就地维护），同样
    // 写回。其余持久变更全部来自被接受的转移。ring 层损坏在下一次成功
    // 写入前重建（丢弃非权威明细；查询不修复——R10）。
    const draft = cloneForCommand(health.memory);
    if (health.ringDegraded !== null) resetTreasuryCoreRingLayer(draft);
    const result = applyTreasuryCoreStateCommand(draft, command, { nowTick: ports.nowTick() });
    if (result.status === "rejected" && command.type !== "admit") {
      return { status: "failed", reason: result.reason };
    }
    const write = writeTreasuryCoreMemory((root) => {
      Object.assign(root, draft);
    }, () => undefined);
    if (write.status === "failed") {
      return { status: "failed", reason: `持久化失败：${write.reason}` };
    }
    if (result.status === "rejected") return { status: "failed", reason: result.reason };
    for (const effect of result.effects) ports.onEffect?.(effect);
    return { status: "applied", effects: result.effects };
  }

  function admit(input: TreasuryCoreAdmissionInput): TreasuryCoreAdmissionResult {
    // Remediation V/R1/§2.3 + VI/R1/§2.4：endTick 请求后本 tick 不再接纳新
    // 业务。共享只读门禁（持久 lastEndTick 或 heap 否决）——完整 reset 重建
    // 模块（heap 否决丢失）后，持久关窗仍拒绝直接 kernel 接纳（恢复/清理
    // 入口不受此限）。
    const gate = admissionGateStatus();
    if (gate.status === "closed") {
      return { status: "rejected", reason: gate.reason, reasonCode: "lifecycle_closed" };
    }
    if (!isValidTreasuryCoreWorkKey(input.workKey)) {
      return { status: "rejected", reason: `workKey 非法（须 ${"biz:"} 前缀且有界）`, reasonCode: "invalid_input" };
    }
    if (input.worstCase.length === 0) {
      return { status: "rejected", reason: "worstCase 为空（动作必须声明最坏占用）", reasonCode: "invalid_input" };
    }
    // 缺受控释放能力时拒绝非空消费者义务（§6.2：不接受义务后再写“以后接入”）。
    if (input.externalConsumers.length > 0 && ports.releaseExternalConsumer === undefined) {
      return {
        status: "rejected",
        reason: "无受控外部消费者释放端口（非空 externalConsumers 的接纳必须拒绝）",
        reasonCode: "release_port_unavailable",
      };
    }
    const health = requireWritableHealth();
    if (health.status === "blocked") return { status: "rejected", reason: health.reason, reasonCode: health.code };
    // 总序列化预算（§8.3）：逐槽完整生命周期上界法——当前实际序列化 +
    // 新聚合完整生命周期槽上界 + 新历史槽上界 ≤ 总预算。已接纳工作任何
    // 状态演化都不超过槽上界（受控字符集 + 字段硬上限），不会“先接纳短
    // pending、后无空间写长 closing”。
    const serializedNow = treasuryCoreSerializedChars(health.memory);
    const admissionWorst = treasuryCoreSlotWorstChars() + treasuryCoreRingSlotWorstChars();
    if (serializedNow > 0 && serializedNow + admissionWorst > TREASURY_CORE_TOTAL_CHAR_BUDGET) {
      bumpRejectedCounter();
      return {
        status: "rejected",
        reason: `treasuryCore 总序列化预算超限（当前 ${String(serializedNow)} + 新聚合完整生命周期上界 ${String(admissionWorst)} > ${String(TREASURY_CORE_TOTAL_CHAR_BUDGET)} 字符）`,
        reasonCode: "memory_budget_exceeded",
      };
    }
    // 容量端口携带完整授权上下文（R2：不退化为匿名裁决——owner/contract
    // 身份与接纳路径一致，own-reservation 的 exact 排除在端口内同样成立）。
    const capacityProblem = ports.checkAdmissionCapacity(input.worstCase, input.admissionContext);
    if (capacityProblem !== null) {
      bumpRejectedCounter();
      return { status: "rejected", reason: capacityProblem.reason, reasonCode: capacityProblem.reasonCode ?? "capacity_insufficient" };
    }
    const run = runCommand({
      type: "admit",
      workKey: input.workKey,
      identity: input.identity,
      worstCase: input.worstCase,
      externalConsumers: input.externalConsumers,
    });
    if (run.status === "failed") {
      // 满载 / 排他冲突 / 预算 / 输入上限由纯函数拒绝并已计数；写入失败额外补计数。
      return { status: "rejected", reason: run.reason, reasonCode: classifyRejection(run.reason) };
    }
    const admitted = run.effects.find((e): e is { effect: "admitted"; attemptId: string } => e.effect === "admitted");
    if (!admitted) return { status: "rejected", reason: "接纳未产生 attempt（内部不一致）", reasonCode: "write_failed" };
    const dispatch = mintTreasuryCoreDispatchPermit({
      attemptId: admitted.attemptId,
      canonicalDigest: input.identity.canonicalDigest,
      canonicalArgs: input.canonicalArgs,
      postings: input.postings,
      ownerIdentity: input.admissionContext.ownerIdentity,
      structureBindings: input.structureBindings,
      actionKind: input.identity.actionKind,
      adapterRegistrationId: input.identity.adapterRegistrationId,
      adapterSemanticIdentity: input.identity.adapterSemanticIdentity,
      issuedAtTick: ports.nowTick(),
      runtimeGeneration: ports.runtimeGeneration(),
    });
    return { status: "admitted", attemptId: admitted.attemptId, dispatch };
  }

  function classifyRejection(reason: string): TreasuryCoreRejectionCode {
    if (reason.includes("满载")) return "active_full";
    if (reason.includes("排他冲突")) return "work_key_conflict";
    if (reason.includes("externalConsumers")) return "invalid_input";
    if (reason.includes("预算超限")) return "memory_budget_exceeded";
    return "write_failed";
  }

  function bumpRejectedCounter(): void {
    const health = readTreasuryCoreStoreHealth();
    if (health.status !== "healthy") return;
    writeTreasuryCoreMemory((root) => {
      if (root.counters.rejectedAdmissions < 9_999_999_999) root.counters.rejectedAdmissions += 1;
    }, () => undefined);
  }

  function executeDispatch(permit: unknown): TreasuryCoreDispatchOutcome {
    // Remediation V/R1/§2.3 + VI/R1/§2.4：endTick 请求后本 tick 不再执行
    // dispatch（动作调用 0、不消费许可——共享门禁持久+heap 双口径，完整
    // reset 后持久关窗同样阻断直接 kernel 执行）。
    const gate = admissionGateStatus();
    if (gate.status === "closed") {
      return { status: "blocked", reasonCode: "lifecycle_closed", reason: gate.reason };
    }
    const nowTick = ports.nowTick();
    const permitCheck = validateTreasuryCoreDispatchPermit(permit, nowTick, ports.runtimeGeneration());
    if (permitCheck.status !== "valid") return { status: "rejected", reason: permitCheck.reason };
    const typed = permitCheck.permit;
    if (consumedPermits.has(typed)) {
      return { status: "rejected", reason: "dispatch 许可已消费（同 attempt 实际调用至多一次）" };
    }
    const health = requireWritableHealth();
    if (health.status === "blocked") return { status: "rejected", reason: health.reason };
    const record = health.memory.active[typed.attemptId];
    if (record === undefined) {
      return { status: "rejected", reason: `attempt ${typed.attemptId} 不在活跃集合（无执行许可）` };
    }
    if (record.phase !== "pending") {
      return { status: "rejected", reason: `attempt ${typed.attemptId} 阶段为 ${record.phase}（不可再次调用）` };
    }
    // 执行前完整身份重验（§4.1）：可信签发快照与聚合当前事实逐项一致——
    // 许可对象身份可信不代表其字段可信；任何不匹配都拒绝且不消费许可。
    const identityConflict = treasuryCorePermitRecordConflicts(typed, record.identity);
    if (identityConflict !== null) {
      return { status: "rejected", reason: `许可与聚合身份冲突（${identityConflict}；原事实保留，不执行）` };
    }
    const adapter = ports.findAdapter(record.identity.actionKind);
    if (
      adapter === undefined ||
      adapter.registrationId !== record.identity.adapterRegistrationId ||
      adapter.semanticIdentity !== record.identity.adapterSemanticIdentity ||
      adapter.version !== record.identity.adapterVersion
    ) {
      return {
        status: "rejected",
        reason: "adapter 注册身份与聚合不一致（执行环境语义已变化，旧授权失效）",
      };
    }
    // 调用边界世界序（效果侧锚点——在动作调用之前固定；§6.2 观察覆盖判定）。
    const invocationWorldSequence = readTreasuryWorldSequence();
    // 1) dispatching 发布（持久 + 发布确认）。失败 → 零调用、保持 pending。
    //    Remediation I/R1/§4.1：边界信息与 phase 同次写入（单命令原子）——结果
    //    写回前中断的记录也有观察接管锚点；不先发 dispatching 再另写
    //    边界（避免两步之间的恢复空窗）。
    const start = runCommand({
      type: "dispatch_start",
      attemptId: typed.attemptId,
      canonicalDigest: typed.canonicalDigest,
      boundaryWorldSequence: invocationWorldSequence,
    });
    if (start.status === "failed") return { status: "publish_failed", reason: start.reason };
    // 2) 置 consumed（重入/同 tick 重复在此之后一律拒绝）。
    consumedPermits.add(typed);
    // 3) 动作恰好一次：实际执行参数来自冻结签发快照（typed.canonicalArgs），
    //    不从公开可变字段重新派生（R01）。
    let invocationOutcome: "committed" | "not_executed" | "unknown";
    let external: { accepted: boolean } | null = null;
    let errorMessage: string | null = null;
    try {
      const actionResult = adapter.execute(typed.canonicalArgs);
      external = { accepted: actionResult.ok };
      if (actionResult.ok && adapter.settlesOnAccept) {
        invocationOutcome = "committed";
      } else if (!actionResult.ok && adapter.nonOkOutcome === "not_executed") {
        invocationOutcome = "not_executed";
      } else {
        invocationOutcome = "unknown";
      }
    } catch (error) {
      invocationOutcome = "unknown";
      errorMessage = error instanceof Error ? error.message : String(error);
      external = null;
    }
    // 4) 结果持久（含 invocation/external 事实）。失败 → 保守 unknown 兜底。
    const evidence =
      invocationOutcome === "committed"
        ? { kind: "adapter_execution_semantics" as const, conclusion: "executed" as const, source: adapter.semanticIdentity.slice(0, 64), atTick: nowTick }
        : invocationOutcome === "not_executed"
          ? { kind: "adapter_execution_semantics" as const, conclusion: "not_executed" as const, source: adapter.semanticIdentity.slice(0, 64), atTick: nowTick }
          : null;
    const persist = runCommand({
      type: "dispatch_result",
      attemptId: typed.attemptId,
      invocationAtTick: nowTick,
      invocationWorldSequence,
      external,
      outcome: invocationOutcome,
      evidence,
      error: errorMessage,
    });
    if (persist.status === "failed") {
      // 兜底：至少推进为 unknown（写一次 conservative recovery）。不回滚到
      // pending、不恢复已使用许可（§4.2）。
      const fallback = runCommand({ type: "recover_dispatching", attemptId: typed.attemptId });
      return {
        status: "persist_failed",
        attemptId: typed.attemptId,
        observed: invocationOutcome,
        reason: fallback.status === "applied" ? `结果写入失败，已保守恢复为 unknown（${persist.reason}）` : `结果写入与保守恢复均失败（${persist.reason}）`,
      };
    }
    if (invocationOutcome === "unknown") {
      return { status: "unknown", attemptId: typed.attemptId, reason: errorMessage ?? undefined };
    }
    return { status: invocationOutcome, attemptId: typed.attemptId };
  }

  function preflightDispatchPermit(permit: unknown): { status: "valid" } | { status: "invalid"; readonly reason: string } {
    const check = validateTreasuryCoreDispatchPermit(permit, ports.nowTick(), ports.runtimeGeneration());
    if (check.status !== "valid") return { status: "invalid", reason: check.reason };
    if (consumedPermits.has(check.permit)) {
      return { status: "invalid", reason: "dispatch 许可已消费（同 attempt 实际调用至多一次）" };
    }
    // Remediation II/R3/§5.1：非健康核心（absent/incompatible/unhealthy）一律
    // 明确拒绝——当前权威不可验证时，不把旧签发身份当作当前许可；预检保持
    // 纯读（不初始化、不修复）。ring 单独 degraded 不等于核心 unhealthy
    //（readTreasuryCoreStoreHealth 的安全四态与 ringDegraded 分离）。
    const health = readTreasuryCoreStoreHealth();
    if (health.status !== "healthy") {
      const label =
        health.status === "absent"
          ? "核心存储缺失"
          : health.status === "incompatible"
            ? `核心存储版本不兼容（${health.reason}）`
            : `核心存储不健康（${health.reason}）`;
      return { status: "invalid", reason: `当前核心权威不可用，预检不通过：${label}` };
    }
    const record = health.memory.active[check.permit.attemptId];
    if (record === undefined) {
      return { status: "invalid", reason: `attempt ${check.permit.attemptId} 不在活跃集合（对应工作已关闭/退出）` };
    }
    if (record.phase !== "pending") {
      return { status: "invalid", reason: `attempt ${check.permit.attemptId} 阶段为 ${record.phase}（不可执行）` };
    }
    return { status: "valid" };
  }

  function preflightRearmPermit(permit: unknown): { status: "valid" } | { status: "invalid"; readonly reason: string } {
    const check = validateTreasuryCoreRearmPermit(permit, ports.nowTick(), ports.runtimeGeneration());
    if (check.status !== "valid") return { status: "invalid", reason: check.reason };
    if (consumedPermits.has(check.permit as unknown as TreasuryCoreDispatchPermit)) {
      return { status: "invalid", reason: "rearm 许可已消费（不会创建两个 child）" };
    }
    // Remediation II/R3/§5.1：同 preflightDispatchPermit——非健康核心一律
    // 拒绝（纯读：不初始化、不修复核心）。
    const health = readTreasuryCoreStoreHealth();
    if (health.status !== "healthy") {
      const label =
        health.status === "absent"
          ? "核心存储缺失"
          : health.status === "incompatible"
            ? `核心存储版本不兼容（${health.reason}）`
            : `核心存储不健康（${health.reason}）`;
      return { status: "invalid", reason: `当前核心权威不可用，预检不通过：${label}` };
    }
    const parent = health.memory.active[check.permit.parentAttemptId];
    if (parent === undefined) {
      return { status: "invalid", reason: `前代 attempt ${check.permit.parentAttemptId} 不在活跃集合（对应工作已关闭/退出）` };
    }
    if (parent.phase !== "retry_ready") {
      return { status: "invalid", reason: `前代阶段为 ${parent.phase}（不可 rearm）` };
    }
    return { status: "valid" };
  }

  function settle(input: Parameters<TreasuryCoreKernel["settle"]>[0]): ReturnType<TreasuryCoreKernel["settle"]> {
    const health = requireWritableHealth();
    if (health.status === "blocked") return { status: "rejected", reason: health.reason };
    const record = health.memory.active[input.attemptId];
    if (record === undefined) return { status: "rejected", reason: `attempt ${input.attemptId} 不在活跃集合` };
    if (record.phase !== "outcome_unknown") {
      return { status: "rejected", reason: `attempt ${input.attemptId} 阶段为 ${record.phase}（仅结果未知的聚合可对账）` };
    }
    // 结论只来自受控对账端口（facade 装配的注册 reconciler）——调用者不能
    // 传入结论，也不存在 kernel.settle(rawConclusion) 旁路（R07/§4.4）。
    const port = ports.reconcileOutcome;
    if (port === undefined) {
      return { status: "rejected", reason: "无受控对账端口（unknown 保留，不猜测）" };
    }
    let reconciled: ReturnType<TreasuryCoreReconcileOutcomePort>;
    try {
      reconciled = port(record);
    } catch (error) {
      return { status: "rejected", reason: "对账端口抛错：" + String(error instanceof Error ? error.message : error).slice(0, 96) };
    }
    if (reconciled.status === "rejected") {
      return { status: "rejected", reason: `对账未成立（${reconciled.reason}）` };
    }
    const conclusion = reconciled.conclusion;
    if (conclusion !== "executed" && conclusion !== "not_executed" && conclusion !== "still_uncertain") {
      return { status: "rejected", reason: "对账端口返回未知结论（不转换，unknown 保留）" };
    }
    const run = runCommand({
      type: "settle",
      attemptId: input.attemptId,
      evidence: { kind: "adapter_reconcile", conclusion, source: reconciled.source.slice(0, 64) },
    });
    if (run.status === "failed") return { status: "rejected", reason: run.reason };
    if (conclusion === "still_uncertain") return { status: "still_uncertain" };
    return { status: "ok" };
  }

  function issueRearmPermit(input: Parameters<TreasuryCoreKernel["issueRearmPermit"]>[0]): ReturnType<TreasuryCoreKernel["issueRearmPermit"]> {
    const health = requireWritableHealth();
    if (health.status === "blocked") return { status: "rejected", reason: health.reason };
    const record = health.memory.active[input.parentAttemptId];
    if (record === undefined) return { status: "rejected", reason: `前代 attempt 不在活跃集合` };
    if (record.phase !== "retry_ready") {
      return { status: "rejected", reason: `前代阶段为 ${record.phase}（只有 exact not-executed + 清理完成才可 rearm）` };
    }
    if (record.identity.retryFactsDigest === null) {
      return { status: "rejected", reason: "前代缺少 retry 语义事实（non-rearmable）" };
    }
    const rearm = mintTreasuryCoreRearmPermit({
      parentAttemptId: record.attemptId,
      workKey: record.workKey,
      retryFactsDigest: record.identity.retryFactsDigest,
      issuedAtTick: ports.nowTick(),
      runtimeGeneration: ports.runtimeGeneration(),
    });
    return { status: "ok", rearm };
  }

  function executeRearm(
    rearm: unknown,
    next: Parameters<TreasuryCoreKernel["executeRearm"]>[1],
  ): TreasuryCoreAdmissionResult {
    // Remediation V/R1/§2.3 + VI/R1/§2.4：endTick 请求后本 tick 不再执行
    // rearm。拒绝先于许可认证/父代权利消费——capability 不被误消费，下一
    // tick 仍可用（共享门禁持久+heap 双口径，完整 reset 后持久关窗同样
    // 阻断直接 kernel rearm）。
    const gate = admissionGateStatus();
    if (gate.status === "closed") {
      return { status: "rejected", reason: gate.reason, reasonCode: "lifecycle_closed" };
    }
    const nowTick = ports.nowTick();
    const check = validateTreasuryCoreRearmPermit(rearm, nowTick, ports.runtimeGeneration());
    if (check.status !== "valid") return { status: "rejected", reason: check.reason, reasonCode: "invalid_input" };
    const typed = check.permit;
    if (consumedPermits.has(typed as unknown as TreasuryCoreDispatchPermit)) {
      return { status: "rejected", reason: "rearm 许可已消费（不会创建两个 child）", reasonCode: "invalid_input" };
    }
    const health = requireWritableHealth();
    if (health.status === "blocked") return { status: "rejected", reason: health.reason, reasonCode: health.code };
    const capacityProblem = ports.checkAdmissionCapacity(next.worstCase, next.admissionContext);
    if (capacityProblem !== null) {
      bumpRejectedCounter();
      return { status: "rejected", reason: capacityProblem.reason, reasonCode: capacityProblem.reasonCode ?? "capacity_insufficient" };
    }
    const run = runCommand({
      type: "rearm",
      parentAttemptId: typed.parentAttemptId,
      identity: next.identity,
      worstCase: next.worstCase,
    });
    if (run.status === "failed") return { status: "rejected", reason: run.reason, reasonCode: classifyRejection(run.reason) };
    const reared = run.effects.find((e): e is { effect: "rearmed"; parentAttemptId: string; attemptId: string } => e.effect === "rearmed");
    if (!reared) return { status: "rejected", reason: "rearm 未产生新 attempt", reasonCode: "write_failed" };
    consumedPermits.add(typed as unknown as TreasuryCoreDispatchPermit);
    const dispatch = mintTreasuryCoreDispatchPermit({
      attemptId: reared.attemptId,
      canonicalDigest: next.identity.canonicalDigest,
      canonicalArgs: next.canonicalArgs,
      postings: next.postings,
      ownerIdentity: next.admissionContext.ownerIdentity,
      structureBindings: next.structureBindings,
      actionKind: next.identity.actionKind,
      adapterRegistrationId: next.identity.adapterRegistrationId,
      adapterSemanticIdentity: next.identity.adapterSemanticIdentity,
      issuedAtTick: ports.nowTick(),
      runtimeGeneration: ports.runtimeGeneration(),
    });
    return { status: "admitted", attemptId: reared.attemptId, dispatch };
  }

  function cancelPending(input: Parameters<TreasuryCoreKernel["cancelPending"]>[0]): ReturnType<TreasuryCoreKernel["cancelPending"]> {
    const run = runCommand({ type: "cancel_pending", attemptId: input.attemptId });
    return run.status === "applied" ? { status: "ok" } : { status: "rejected", reason: run.reason };
  }

  function closeWork(input: Parameters<TreasuryCoreKernel["closeWork"]>[0]): ReturnType<TreasuryCoreKernel["closeWork"]> {
    const run = runCommand({ type: "close", attemptId: input.attemptId, reason: input.reason });
    return run.status === "applied" ? { status: "ok" } : { status: "rejected", reason: run.reason };
  }

  // ── beginTick：恢复推进（子预算公平 + 端口调用前持久预扣） ──────────────────
  //
  // 预算语义（§6.3/§7.1）：每 tick 恢复扫描/状态发布/外部清理调用共享
  // RECOVERY_BUDGET_PER_TICK；同 tick 重复 beginTick / 多实例 / 端口内重入
  // 经持久记账（recovery.budgetTick/budgetUsed）共享同一份额。
  //
  // 预扣协议（R6）：每次外部释放端口调用**之前**先持久发布
  // budgetUsed=used+1——预扣发布失败则不调用端口；端口抛错/失败/确认写回
  // 失败时该份额已消耗（不退回供重入再花）。硬终止（预扣后未进入端口）
  // 保守损失本 tick 这一次额度，下 tick 正常恢复。
  //
  // 子预算（§7.3）：dispatching 恢复 ≤2、pending sweep ≤3、retry 关闭 ≤1、
  // closing 清理保底 ≥2——持续到来的取消流量不能饿死健康清理。
  //
  // 游标（sweepCursor/cleanupCursor）是调度元信息：失效可安全重建，不是
  // 完成 proof；失败的任务也消耗预算并让后续任务在有限轮次获得机会。

  function readBudgetState(memory: TreasuryCoreMemory, nowTick: number): number {
    if (memory.recovery.budgetTick !== nowTick) return 0;
    return memory.recovery.budgetUsed;
  }

  /** 当前持久预算（每次从 Memory 现读——重入/多实例后的单一权威）。 */
  function currentBudgetUsed(nowTick: number): number {
    const health = readTreasuryCoreStoreHealth();
    if (health.status !== "healthy") return TREASURY_CORE_RECOVERY_BUDGET_PER_TICK;
    return readBudgetState(health.memory, nowTick);
  }

  /** 预算内执行一条恢复命令（命令写自身携带预算记账；持久值单调不回退）。 */
  function applyBudgetedCommand(
    used: number,
    command: TreasuryCoreCommand,
    cursors: { sweepCursor: number; cleanupCursor: number },
  ): { applied: boolean; used: number } {
    const nowTick = ports.nowTick();
    const draftHealth = readTreasuryCoreStoreHealth();
    if (draftHealth.status !== "healthy") return { applied: false, used };
    const draft = cloneForCommand(draftHealth.memory);
    // ring 层损坏在预算命令写入前重建（R7：与 runCommand 同一隔离——
    // cancel/close 的 ring 追加不得在坏历史上崩溃）。
    if (draftHealth.ringDegraded !== null) resetTreasuryCoreRingLayer(draft);
    const result = applyTreasuryCoreStateCommand(draft, command, { nowTick });
    if (result.status === "rejected") return { applied: false, used };
    // 预算记账从持久现读取 max（R6：重入/多实例可能已推高持久值，本地
    // used 不得把已消耗份额写回）。
    const effectiveUsed = Math.max(used, readBudgetState(draftHealth.memory, nowTick));
    draft.recovery = { sweepCursor: cursors.sweepCursor, cleanupCursor: cursors.cleanupCursor, budgetTick: nowTick, budgetUsed: effectiveUsed + 1 };
    const write = writeTreasuryCoreMemory((root) => {
      Object.assign(root, draft);
    }, () => undefined);
    if (write.status === "failed") return { applied: false, used: effectiveUsed };
    for (const effect of result.effects) ports.onEffect?.(effect);
    return { applied: true, used: effectiveUsed + 1 };
  }

  /**
   * 消费者单位的成对预算预扣（IV/R6.1/§6.1–§6.2）：进入外部端口前持久
   * 预扣完整 2 份（端口调用份额 + 对应确认命令份额）；确认使用已预扣的
   * 份额（applyPrepaidCleanupCommand），不再额外 +1——8 次释放耗尽共享
   * 预算后确认命令要求第 9 份的死锁（R4）从结构上消除。无其他阶段消耗
   * 时一 tick 最多 4 个消费者单位；"外部调用 ≤8" 保持。
   * 预扣发布失败 → 不调用端口（调用 0）。预扣后无论端口 true/false/throw
   * 或确认写失败，份额不退回（份额是调度许可，不是完成证据）。
   */
  function prepayReleaseUnitBudget(
    cursors: { sweepCursor: number; cleanupCursor: number },
    target: { attemptId: string; nextCursor: number },
  ): number | null {
    const nowTick = ports.nowTick();
    const health = readTreasuryCoreStoreHealth();
    if (health.status !== "healthy") return null;
    // 重读当前记录（§4.2）：exact attempt 仍在活跃集合并处 closing 才预扣
    //（回调重入/并发推进后记录可能已变化——集合成员资格仍是唯一义务事实）。
    const current = health.memory.active[target.attemptId];
    if (current === undefined || current.phase !== "closing") return null;
    const usedNow = readBudgetState(health.memory, nowTick);
    if (usedNow + 2 > TREASURY_CORE_RECOVERY_BUDGET_PER_TICK) return null;
    // Remediation II/R2/§4.1–§4.2：同一次安全写发布两份预算消耗与该记录
    // 下一服务位置（remaining 不变；游标不使任何义务被当成完成）。经独立
    // expected 读回确认（writeTreasuryCoreMemory 协议）成功后才允许调用
    // 释放端口——不再出现「预算已写、cursor 等回调回来才写」的两步空窗。
    const write = writeTreasuryCoreMemory((root) => {
      const record = root.active[target.attemptId];
      if (record !== undefined && record.phase === "closing") {
        root.active[target.attemptId] = {
          ...record,
          cleanup: { ...record.cleanup, cursor: target.nextCursor },
          updatedAtTick: nowTick,
        };
      }
      root.recovery = {
        sweepCursor: cursors.sweepCursor,
        cleanupCursor: cursors.cleanupCursor,
        budgetTick: nowTick,
        budgetUsed: usedNow + 2,
      };
    }, () => undefined);
    if (write.status === "failed") return null;
    return usedNow + 2;
  }

  /**
   * 已预扣份额的确认命令（IV/§6.1）：与 applyBudgetedCommand 同一写入协议，
   * 但预算记账不递增——本次命令的份额已在端口调用前成对预扣。
   */
  function applyPrepaidCleanupCommand(
    used: number,
    command: TreasuryCoreCommand,
    cursors: { sweepCursor: number; cleanupCursor: number },
  ): { applied: boolean; used: number } {
    const nowTick = ports.nowTick();
    const draftHealth = readTreasuryCoreStoreHealth();
    if (draftHealth.status !== "healthy") return { applied: false, used };
    const draft = cloneForCommand(draftHealth.memory);
    if (draftHealth.ringDegraded !== null) resetTreasuryCoreRingLayer(draft);
    const result = applyTreasuryCoreStateCommand(draft, command, { nowTick });
    if (result.status === "rejected") return { applied: false, used };
    const effectiveUsed = Math.max(used, readBudgetState(draftHealth.memory, nowTick));
    draft.recovery = { sweepCursor: cursors.sweepCursor, cleanupCursor: cursors.cleanupCursor, budgetTick: nowTick, budgetUsed: effectiveUsed };
    const write = writeTreasuryCoreMemory((root) => {
      Object.assign(root, draft);
    }, () => undefined);
    if (write.status === "failed") return { applied: false, used: effectiveUsed };
    for (const effect of result.effects) ports.onEffect?.(effect);
    return { applied: true, used: effectiveUsed };
  }

  /** 从可信观察构造 committed 退出的观察证明（范围 = worstCase 位置 ∩ 观察覆盖）。 */
  function observationProofFor(
    record: TreasuryCoreWorkRecord,
    observed: NonNullable<ReturnType<NonNullable<TreasuryCoreKernelPorts["observeForCleanup"]>>>,
  ): { worldSequence: number; atTick: number; coveredLocations: string[] } {
    const covered: string[] = [];
    const seen = new Set<string>();
    for (const leg of record.worstCase) {
      const key = `${leg.roomName}\x00${leg.locationKind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (observed.locationExists(leg.roomName, leg.locationKind)) covered.push(key);
    }
    return { worldSequence: observed.worldSequence, atTick: observed.atTick, coveredLocations: covered };
  }

  function beginTick(): { recovered: number; closed: number; cleaned: number; cancelled: number } {
    // §3.1：已有推进进行中（回调重入/多实例/同 tick 顺序调用重叠）时结构化
    // 返回零推进——嵌套请求不递归调度；外层完成后，后续正常入口按剩余
    // 持久预算继续推进（预算/cursor 单一权威在 Memory）。
    if (lifecycleAdvanceInFlight) return { recovered: 0, closed: 0, cleaned: 0, cancelled: 0 };
    lifecycleAdvanceInFlight = true;
    try {
      return runLifecycleAdvance();
    } finally {
      lifecycleAdvanceInFlight = false;
    }
  }

  function runLifecycleAdvance(): { recovered: number; closed: number; cleaned: number; cancelled: number } {
    let recovered = 0;
    let closed = 0;
    let cleaned = 0;
    let cancelled = 0;
    const health = readTreasuryCoreStoreHealth();
    // ring 层损坏（ringDegraded）不阻断恢复/收尾（R10）——只有安全层
    // unhealthy/incompatible 或旧业务数据存在才整体阻断。
    if (health.status !== "healthy") return { recovered, closed, cleaned, cancelled };
    if (legacyNow().length > 0) return { recovered, closed, cleaned, cancelled };
    const nowTick = ports.nowTick();
    const cursors = { sweepCursor: health.memory.recovery.sweepCursor, cleanupCursor: health.memory.recovery.cleanupCursor };
    let used = readBudgetState(health.memory, nowTick);

    // 1) dispatching 残留 → 保守 unknown（可能已进入；不重发）。子预算 ≤2。
    let dispatchingSpent = 0;
    for (const record of sortedActive(health.memory)) {
      if (dispatchingSpent >= TREASURY_CORE_SUBBUDGET_DISPATCHING) break;
      if (used >= TREASURY_CORE_RECOVERY_BUDGET_PER_TICK) break;
      if (record.phase !== "dispatching") continue;
      const step = applyBudgetedCommand(used, { type: "recover_dispatching", attemptId: record.attemptId }, cursors);
      used = step.used;
      dispatchingSpent += 1;
      if (step.applied) recovered += 1;
    }

    // 2) 跨 tick 失效 pending 的安全取消（§6.1）。子预算 ≤3。
    const afterRecover = readTreasuryCoreStoreHealth();
    if (afterRecover.status === "healthy") {
      const pendings = sortedActive(afterRecover.memory).filter((r) => r.phase === "pending" && r.admittedAtTick < nowTick);
      if (pendings.length > 0) {
        const start = cursors.sweepCursor % pendings.length;
        let visited = 0;
        while (visited < pendings.length && used < TREASURY_CORE_RECOVERY_BUDGET_PER_TICK) {
          if (used >= TREASURY_CORE_SUBBUDGET_DISPATCHING + TREASURY_CORE_SUBBUDGET_SWEEP) break;
          const record = pendings[(start + visited) % pendings.length];
          visited += 1;
          cursors.sweepCursor = (cursors.sweepCursor + 1) % pendings.length;
          const step = applyBudgetedCommand(used, { type: "cancel_pending", attemptId: record.attemptId }, cursors);
          used = step.used;
          if (step.applied) cancelled += 1;
        }
      } else {
        cursors.sweepCursor = 0;
      }
    }

    // 3) retry 权利期限关闭。子预算 ≤1。
    const afterSweep = readTreasuryCoreStoreHealth();
    if (afterSweep.status === "healthy") {
      let retryCloses = 0;
      for (const record of sortedActive(afterSweep.memory)) {
        if (retryCloses >= TREASURY_CORE_SUBBUDGET_RETRY_CLOSE) break;
        if (used >= TREASURY_CORE_RECOVERY_BUDGET_PER_TICK) break;
        if (record.phase !== "retry_ready") continue;
        if (record.retryDeadlineTick !== null && nowTick > record.retryDeadlineTick) {
          const step = applyBudgetedCommand(used, { type: "close", attemptId: record.attemptId, reason: "retry_expired" }, cursors);
          used = step.used;
          retryCloses += 1;
          if (step.applied) closed += 1;
        }
      }
    }

    // 4) closing 清理公平推进（Remediation III/R1/§3.2–§3.3：当前义务
    //    逐项清理）。跨记录游标轮转（清理保底 ≥2 = 至少 1 个成对消费者
    //    单位/IV §6.1）。每记录每次迭代从持久现读当前 remaining——不持有
    //    跨回调的旧工作数组（内层确认改变集合后，外层不再选择已移除项）；
    //    预扣绑定当前 attempt/consumerKey 成员资格；端口返回只有原始布尔
    //    true 才确认移除（R2/§3.4）；确认按单位进行（成功 [key]、失败空
    //    清单 + 有界失败计数），不再累计跨回调的 released[] 批末确认。
    //    committed 记录的退出由观察接管证明门控（IV/R1）——观察未覆盖时
    //    零写跳过（D01 有界等待）。
    const afterCloses = readTreasuryCoreStoreHealth();
    if (afterCloses.status === "healthy") {
      const observe = ports.observeForCleanup;
      // 观察证明（每记录按其 worstCase 惰性派生；端口缺失/观察不可用 → undefined）。
      let proof: { worldSequence: number; atTick: number; coveredLocations: string[] } | undefined;
      const obtainProof = (target: TreasuryCoreWorkRecord): boolean => {
        if (observe === undefined) return false;
        const observed = observe();
        if (observed === null) return false;
        proof = observationProofFor(target, observed);
        return true;
      };
      // 本次 beginTick 的记录访问集合（有界：每 closing 记录至多访问一次，
      // 穷尽后有界返回——只是运行时调度辅助，不是成员资格或完成权威）。
      const servedRecords = new Set<string>();
      while (used < TREASURY_CORE_RECOVERY_BUDGET_PER_TICK) {
        const healthNow = readTreasuryCoreStoreHealth();
        if (healthNow.status !== "healthy") break;
        const closings = sortedActive(healthNow.memory).filter((r) => r.phase === "closing");
        if (closings.length === 0) {
          cursors.cleanupCursor = 0;
          break;
        }
        const start = cursors.cleanupCursor % closings.length;
        const record = closings[start];
        if (record === undefined || servedRecords.has(record.attemptId)) break;
        servedRecords.add(record.attemptId);
        cursors.cleanupCursor = (start + 1) % closings.length;
        if (record.cleanup.consumerKeys.length === 0) {
          if (record.outcome === "committed") {
            // IV/R1/D01：committed 无义务记录先做观察预检（时间序）——观察
            // 未覆盖/无观察端口时零写跳过（不花预算；范围终判在命令内）。
            // Remediation II/R1：锚点链与命令内/occupancy 同一共享判定
            //（coverage.ts：invocation → external → invocationBoundary）。
            const anchor = treasuryCoreCoverageAnchorOf(record);
            if (anchor === null) continue; // 无调用侧事实；保守保留
            if (!obtainProof(record) || proof === undefined) continue;
            if (treasuryCoreObservationAdvancesPastAnchor(anchor, proof) !== true) continue;
            const step = applyBudgetedCommand(
              used,
              { type: "advance_cleanup", attemptId: record.attemptId, releasedDuties: [], observationProof: proof },
              cursors,
            );
            used = step.used;
            if (step.applied) cleaned += 1;
            continue;
          }
          // not_executed / pending_cancellation 无世界效果义务：直接终态推进。
          const step = applyBudgetedCommand(used, { type: "advance_cleanup", attemptId: record.attemptId, releasedDuties: [] }, cursors);
          used = step.used;
          if (step.applied) cleaned += 1;
          continue;
        }
        // 端口缺失：不默认成功——保留义务并记录失败计数（有界诊断）。
        const releasePort = ports.releaseExternalConsumer;
        if (releasePort === undefined) {
          const step = applyBudgetedCommand(used, { type: "advance_cleanup", attemptId: record.attemptId, releasedDuties: [] }, cursors);
          used = step.used;
          if (step.applied) cleaned += 1;
          continue;
        }
        // 逐消费者单位（§3.2 顺序）：重读当前记录 → 从当前 remaining 选择
        // 本次成员 → 同次发布两份预算 + 下一服务位置 → 端口 → 严格判定 →
        // 按单位确认（成功才移除该项）→ 确认写完成后重新读取状态再选下一项。
        // 每消费者 2 份；确认不追加、不退款；失败成员保留、轮转继续——同
        // 一次访问不为花完预算重复尝试刚失败的同一项（§3.3：访问集合只是
        // 运行时调度辅助，不是成员资格或完成权威；全部成员都已尝试过即有
        // 界结束，失败责任保留到下一 tick）。
        const triedKeys = new Set<string>();
        // 预算不足以再预扣一个消费者单位时置位——外层同步停止扫描（IV/D19：
        // continue 空转会把游标推满一整圈回到本 tick 起点，后方记录永远落在
        // “预算已尽”的访问位——结构性饿死；停在耗尽处，下一 tick 从其后继开始）。
        let budgetShortfall = false;
        while (used < TREASURY_CORE_RECOVERY_BUDGET_PER_TICK && triedKeys.size < TREASURY_CORE_CONSUMER_KEYS_MAX) {
          const unitHealth = readTreasuryCoreStoreHealth();
          if (unitHealth.status !== "healthy") break;
          const current = unitHealth.memory.active[record.attemptId];
          if (current === undefined || current.phase !== "closing") break; // 记录已变化/退出：不复活旧数组
          const keys = current.cleanup.consumerKeys;
          if (keys.length === 0) break; // 义务已清空（观察未接管的空集合留待下 tick 空义务分支）
          // 从记录现值 cursor（下一服务位置）起选第一个本次未尝试的成员。
          let dutyIndex = -1;
          for (let offset = 0; offset < keys.length; offset += 1) {
            const candidate = (current.cleanup.cursor + offset) % keys.length;
            const key = keys[candidate];
            if (key !== undefined && !triedKeys.has(key)) {
              dutyIndex = candidate;
              break;
            }
          }
          if (dutyIndex < 0) break; // 本次访问已试过全部成员（单成员失败等）：有界结束
          const consumerKey = keys[dutyIndex] as string;
          triedKeys.add(consumerKey);
          const prepaid = prepayReleaseUnitBudget(cursors, {
            attemptId: record.attemptId,
            nextCursor: (dutyIndex + 1) % keys.length,
          });
          if (prepaid === null) {
            budgetShortfall = true;
            break; // 预扣失败（预算尽/记录变化）：不调用端口，有界结束
          }
          used = prepaid;
          // R2/§3.4 严格成功：端口结果以 unknown 运行时边界审视，只有原始
          // 布尔 true 是完成确认——不做 Boolean 强转、不解读 {ok:...}、
          // 不 await、不调用 then、不隐式读取返回对象字段。false 与 throw
          // 均保留义务（份额已耗；按原有界计数/诊断处理，不崩整个 tick）。
          let returned: unknown;
          try {
            returned = releasePort(consumerKey, record.attemptId);
          } catch {
            returned = false; // 端口异常：义务保留（不默认成功）
          }
          const success = returned === true;
          // 即将清空义务的确认顺带携带观察证明（committed 完整关闭条件：
          // 义务清空 + 观察接管，由同一已预扣命令完成——不追加份额）。
          const willEmpty = success && keys.length === 1;
          const confirmProof =
            willEmpty && current.outcome === "committed" && obtainProof(current) && proof !== undefined ? proof : undefined;
          const step = applyPrepaidCleanupCommand(
            used,
            {
              type: "advance_cleanup",
              attemptId: record.attemptId,
              releasedDuties: success ? [consumerKey] : [],
              ...(confirmProof !== undefined ? { observationProof: confirmProof } : {}),
            },
            cursors,
          );
          used = step.used;
          if (!step.applied) break; // 确认写失败：保留未确认责任，有界结束本记录（原 attempt 幂等重试）
          cleaned += 1;
          // 循环回到顶部：从当前持久状态重新选择下一项（§3.2）。
        }
        if (budgetShortfall) break; // 游标停在耗尽处（不空转推满一圈）
      }
    }
    // 5) lifecycle 标记 + 游标/预算终态持久化（终态预算 = 持久记账现值）。
    const finalUsed = Math.max(used, currentBudgetUsed(nowTick));
    writeTreasuryCoreMemory((root) => {
      root.lifecycle.lastBeginTick = nowTick;
      root.recovery = { ...cursors, budgetTick: nowTick, budgetUsed: finalUsed };
    }, () => undefined);
    return { recovered, closed, cleaned, cancelled };
  }

  /** endTick 关窗否决标记当前是否生效（按 tick 失效；只读事实查询；仅 heap 口径）。 */
  function admissionVetoActive(): boolean {
    return endTickAdmissionVetoTick !== null && endTickAdmissionVetoTick === ports.nowTick();
  }

  function admissionVetoReason(): string {
    return "本 tick 授权窗口已关闭（endTick 请求已发出：持久关窗发布待确认或失败，运行时否决标记生效——新增业务跨实例拒绝；恢复与安全清理继续）";
  }

  /**
   * 新增业务共享只读门禁（Remediation VI/R1/§2.4）：持久关窗（健康核心的
   * lifecycle.lastEndTick === 当前 tick）或 heap 否决任一成立即关闭。每次
   * 现读当前可信记录——不把一次开放的缓存结论留在本函数外。原因区分两种
   * 来源：持久已关闭 vs heap 否决（持久尚未确认/发布失败），不互相冒充。
   * 检查顺序持久先于 heap（与原 facade 口径一致——已确认的持久关闭优先
   * 报告；二者同 tick 并存时语义等价关闭）。
   */
  function admissionGateStatus(): { status: "open" } | { status: "closed"; reason: string } {
    const health = readTreasuryCoreStoreHealth();
    if (health.status === "healthy" && health.memory.lifecycle.lastEndTick === ports.nowTick()) {
      return {
        status: "closed",
        reason: "本 tick 授权窗口已关闭（endTick 后不得接纳/执行/rearm；恢复与安全清理继续）",
      };
    }
    if (admissionVetoActive()) return { status: "closed", reason: admissionVetoReason() };
    return { status: "open" };
  }

  /**
   * 发布并确认本 tick 关窗事实（Remediation V/R1/§2.3 关窗先行）：经既有
   * 安全写协议写 lifecycle.lastEndTick；幂等（已持有时不重复写——§2.4
   * 避免无意义重复写）。发布失败如实返回 persisted=false（不谎报持久
   * 成功）——运行时否决标记已在 endTick 请求时生效，本 tick 新增业务仍
   * 被拒；恢复正常写入后再次调用可确认关闭（I04"恢复写可确认关闭"）。
   */
  function publishTickClosure(): { persisted: boolean } {
    const nowTick = ports.nowTick();
    const current = readTreasuryCoreStoreHealth();
    if (current.status === "healthy" && current.memory.lifecycle.lastEndTick === nowTick) {
      return { persisted: true };
    }
    const write = writeTreasuryCoreMemory((root) => {
      root.lifecycle.lastEndTick = nowTick;
    }, () => undefined);
    return { persisted: write.status === "written" };
  }

  function endTick(): { recoveredToUnknown: number; closurePersisted: boolean } {
    let recoveredToUnknown = 0;
    // Remediation V/R1/§2.3：endTick 请求一经发出，当前运行时共享拒绝新增
    // 业务——先于持久发布、先于任何恢复回调（onEffect/release）。无论其后
    // 持久关窗发布成败与否，本 tick 不再放行 authorize/dispatch/rearm。
    endTickAdmissionVetoTick = ports.nowTick();
    const health = readTreasuryCoreStoreHealth();
    if (health.status === "healthy" && legacyNow().length === 0) {
      // Remediation IV/R1/§2.2–§2.3：endTick 与 beginTick 属同一推进域——
      // 独立 endTick 运行恢复循环前必须先取得推进所有权（否则其
      // onEffect/release 回调可重入 beginTick 取得推进权，旧调用栈的局部
      // 预算随后覆盖持久较新预算）。
      if (lifecycleAdvanceInFlight) {
        // 嵌套 endTick（推进被持有时回调内请求关窗）：只执行有界关窗事实
        // 发布——不递归恢复、不覆盖 recovery 的预算与游标（§2.3 关窗与
        // 推进分开处理；防重入不得吞掉关窗语义）。发布结果如实返回。
        const nested = publishTickClosure();
        return { recoveredToUnknown: 0, closurePersisted: nested.persisted };
      }
      lifecycleAdvanceInFlight = true;
      try {
        // ① 关窗先行：**成功发布关闭必须早于第一个可回调的恢复动作**——
        //    恢复循环（及其 onEffect 回调）运行前 lastEndTick 已发布并
        //    确认。发布失败不谎报；否决标记保持本 tick 生效。
        const closure = publishTickClosure();
        // ② 重读当前权威（不能继续使用关窗前旧草稿）：恢复循环的预算、
        //    游标与记录遍历全部来自关窗发布之后的当前持久状态——防
        //    Object.assign(root, oldDraft) 一类把已发布关闭按入口旧快照
        //    恢复成旧值（§2.3）。
        const postClose = readTreasuryCoreStoreHealth();
        const base = postClose.status === "healthy" ? postClose : health;
        const nowTick = ports.nowTick();
        let used = readBudgetState(base.memory, nowTick);
        const cursors = { sweepCursor: base.memory.recovery.sweepCursor, cleanupCursor: base.memory.recovery.cleanupCursor };
        // dispatching 残留（当次调用异常逃逸）→ 保守 unknown（共享同 tick 预算）。
        for (const record of sortedActive(base.memory)) {
          if (used >= TREASURY_CORE_RECOVERY_BUDGET_PER_TICK) break;
          if (record.phase !== "dispatching") continue;
          const step = applyBudgetedCommand(used, { type: "recover_dispatching", attemptId: record.attemptId }, cursors);
          used = step.used;
          if (step.applied) recoveredToUnknown += 1;
        }
        // ③ 尾部只维护本推进需要维护的事实：预算/游标写持久现读值（旧
        //    局部 used 不覆盖当前较大值；游标不因关窗回退），关窗事实
        //    幂等重申（发布失败或期间被篡改后，此处写入可确认关闭）。
        //    不重新开放窗口、不回退预算/游标。事实已一致且关窗已持有时
        //    跳过（§2.4 正常已关闭场景避免无意义重复写）。
        let closurePersisted = closure.persisted;
        const finalRead = readTreasuryCoreStoreHealth();
        if (finalRead.status === "healthy") {
          const persistedUsed = readBudgetState(finalRead.memory, nowTick);
          const finalUsed = Math.max(used, persistedUsed);
          const finalCursors =
            { sweepCursor: finalRead.memory.recovery.sweepCursor, cleanupCursor: finalRead.memory.recovery.cleanupCursor };
          const closureHeld = finalRead.memory.lifecycle.lastEndTick === nowTick;
          const factsCurrent =
            finalRead.memory.recovery.budgetTick === nowTick &&
            persistedUsed === finalUsed &&
            finalRead.memory.recovery.sweepCursor === finalCursors.sweepCursor &&
            finalRead.memory.recovery.cleanupCursor === finalCursors.cleanupCursor;
          if (!closureHeld || !factsCurrent) {
            const tailWrite = writeTreasuryCoreMemory((root) => {
              root.lifecycle.lastEndTick = nowTick;
              root.recovery = { ...finalCursors, budgetTick: nowTick, budgetUsed: finalUsed };
            }, () => undefined);
            if (tailWrite.status === "written") closurePersisted = true;
          }
        }
        return { recoveredToUnknown, closurePersisted };
      } finally {
        lifecycleAdvanceInFlight = false;
      }
    }
    // 健康门未过（store 损坏/legacy 存在）：关窗事实无法发布——如实返回
    // 未持久确认（不谎报）；运行时否决标记（请求时已置）本 tick 仍生效。
    return { recoveredToUnknown, closurePersisted: false };
  }

  function sortedActive(memory: TreasuryCoreMemory) {
    return Object.values(memory.active).sort((a, b) => (a.attemptId < b.attemptId ? -1 : 1));
  }

  function metrics(): TreasuryCoreKernelMetrics {
    const health = readTreasuryCoreStoreHealth();
    const empty: TreasuryCoreMemory = {
      version: TREASURY_CORE_SCHEMA_VERSION,
      installEpochId: "-",
      issuance: { frontier: 0, burned: 0 },
      lifecycle: { lastBeginTick: null, lastEndTick: null },
      recovery: { sweepCursor: 0, cleanupCursor: 0, budgetTick: 0, budgetUsed: 0 },
      active: {},
      ring: [],
      ringCursor: 0,
      counters: {
        admitted: 0,
        dispatched: 0,
        settledCommitted: 0,
        settledNotExecuted: 0,
        unknown: 0,
        rearmings: 0,
        rejectedAdmissions: 0,
        recoveryAdvances: 0,
        cleanupFailures: 0,
      },
    };
    const memory = health.status === "healthy" ? health.memory : empty;
    let pendingCount = 0;
    let unknownCount = 0;
    let closingCount = 0;
    let retryReadyCount = 0;
    for (const record of Object.values(memory.active)) {
      if (record.phase === "pending" || record.phase === "dispatching") pendingCount += 1;
      else if (record.phase === "outcome_unknown") unknownCount += 1;
      else if (record.phase === "closing") closingCount += 1;
      else if (record.phase === "retry_ready") retryReadyCount += 1;
    }
    return {
      activeCount: Object.keys(memory.active).length,
      pendingCount,
      unknownCount,
      closingCount,
      retryReadyCount,
      // R7：ring 非数组（healthy + ringDegraded 可达）不得使 metrics 崩溃。
      ringCount: Array.isArray(memory.ring) ? memory.ring.length : 0,
      frontier: memory.issuance.frontier,
      burned: memory.issuance.burned,
      // 深快照：不泄漏底层持久 counters 引用（R06/B22）。
      counters: { ...memory.counters },
      legacyStores: legacyNow(),
    };
  }

  return {
    health: () => readTreasuryCoreStoreHealth(),
    legacyStores: () => legacyNow(),
    metrics,
    admit,
    executeDispatch,
    preflightDispatchPermit,
    preflightRearmPermit,
    settle,
    issueRearmPermit,
    executeRearm,
    cancelPending,
    closeWork,
    beginTick,
    endTick,
    admissionVetoActive,
    admissionGateStatus,
  };
}

/** 命令草稿副本（commands 在副本上转移；写入用 writeTreasuryCoreMemory 再 clone）。 */
function cloneForCommand(memory: TreasuryCoreMemory): TreasuryCoreMemory {
  return cloneTreasuryDurableValue(memory);
}
