/**
 * Treasury Facade / Gateway——帝国国库统一入口。
 *
 * 显式 tick 生命周期（main.ts 固定挂载，业务模块不再决定首次构建时点）：
 *   beginTick（一切市场预检/生产/物流/规划之前）
 *     → receipt 清理（nextExpiryTick 未到则零扫描；满容绝不驱逐未过期条目）
 *     → reset 检测 → 归档补救（若上一 tick 缺 endTick）
 *     → 作废上一 tick 未决 prepare（跨 tick handle 一律失效）
 *     → 发行本 tick shared epoch（登记 epoch 注册表）→ 对账上一 tick 终态；
 *   endTick（本 tick 全部业务执行之后、最终 profiler flush 之前）
 *     → 归档投影终态（资源 finals + 结构 manifest）→ 关闭本 tick
 *     → 此后登记/prepare 一律拒绝 tick_closed、fresh 发行一律拒绝。
 *   observation()/commitments()/query() 仍可安全访问：未 begin 时走懒兜底
 *   （计数 lifecycleLazyInitializations，main 挂载后应恒为 0）。
 *
 * 登记门禁：transaction 携带决策 epoch 并通过注册表校验；注册表保存每个
 * epoch 的 exact immutable observation——transaction 的物理可行性验证使用
 * decision 指向的那一次观察（shared 或某次 market-fresh），绝不回退 shared。
 * 幂等（heap 本 tick + Memory receipt 跨 tick 与 global reset）优先于一切
 * 验证；endTick 后拒绝结算与 fresh 发行。
 *
 * 两阶段协议（第五轮 write-admission correctness）：prepare 在调用真实
 * Game 写动作**之前**完成全部 Treasury 侧验证，并预留资源、容量与 receipt
 * 槽位（tentative ledger——后续 prepare 与单阶段登记的授权计算都计入
 * tentative，同一资产不得被两笔 prepare 超额授权）；成功返回不可伪造的
 * prepared handle（heap 冻结对象 + 私有 registry 对象身份，tick 与
 * service generation 内有效）。Game API 失败 → abort（原子释放，零状态）；
 * 成功 → commit 执行 tentative → committed 兑现（不做业务 admission，
 * 不再因资源/容量/receipt 条件拒绝；prepare_invalidated 正常路径已删除）。
 * 相同 transactionId、相同 digest 重复 prepare 幂等返回同一 handle；
 * 不同 digest 返回 prepare_conflict。单阶段 recordAcceptedTransaction/
 * recordAcceptedAction 已从公共 writer API 退役：实现保留在服务对象上
 * 仅经 compat 模块（compatRecordAcceptedTransaction）供既有测试与迁移
 * 过渡使用，生产 writer 不得调用（treasuryWriteArchitecture.test.ts
 * 架构边界守护）；兼容路径同样计入 tentative，不得抢占 prepared 预留。
 *
 * 门禁语义：不提供无上下文 available；查询输入（资源/房间/位置/withhold/
 * 布尔开关）非法或房间不在管辖集合（unknown/unowned room）时 fail closed；
 * owner 声明需 typed（holderKind 与运行时解析一致）、holder 真实存在且
 * 房间归属一致，否则 fail closed；spendable 非负且超卖显式 overcommitted；
 * 查询路径零写。
 *
 * fresh epoch 上限：每 tick market-fresh 发行数有硬上限（CPU 保护），超限
 * 拒绝并计数——fresh 观察是全房间扫描，无上限即无界 CPU 风险。
 */

import {
  buildTreasuryObservation,
} from "@/runtime/treasury/observation";
import {
  buildTreasuryCanonicalTransaction,
  computeTreasuryPayloadDigest,
  validateTreasuryTransactionInputShape,
  type TreasuryCanonicalTransaction,
} from "@/runtime/treasury/canonicalTransaction";
import {
  createTreasuryProjectionController,
  type TreasuryProjectionController,
  type TreasuryValidatedTransactionShape,
} from "@/runtime/treasury/projection";
import { buildTreasuryCommitmentIndex } from "@/runtime/treasury/commitments";
import {
  cleanupTreasuryReceipts,
  peekTreasuryReceiptHealth,
  readTreasuryLifecycle,
  readTreasuryReceiptEventCounters,
  releaseAllTreasuryReceiptReservations,
  releaseTreasuryReceiptReservation,
  reserveTreasuryReceiptAdmission,
  writeTreasuryLifecycle,
} from "@/runtime/treasury/receipts";
import { resolveTreasuryHolder } from "@/runtime/treasury/holderResolution";
import {
  isTreasuryWriteAdmissionLocked,
  peekTreasuryWriteFaultHealth,
  recordTreasuryWriteFault,
  runTreasuryCommitFaultHook,
  TREASURY_WRITE_FAULT_DETAIL_MAX,
  TreasuryCommitFaultError,
  type TreasuryWriteFaultPhase,
} from "@/runtime/treasury/writeFault";
import {
  isTreasuryTransactionQuarantined,
  peekTreasuryQuarantineHealth,
  quarantineTreasuryTransaction,
  readTreasuryQuarantineCounters,
  readTreasuryQuarantineEntry,
  TREASURY_QUARANTINE_MAX_ENTRIES,
  treasuryQuarantineBlockers,
  treasuryQuarantineCapacityOccupancy,
  treasuryQuarantineOutflowTotals,
  type TreasuryQuarantineDeltas,
} from "@/runtime/treasury/quarantine";
import {
  listTreasuryIntentEntries,
  markTreasuryIntentPhase,
  peekTreasuryIntentHealth,
  readTreasuryIntentCounters,
  readTreasuryIntentEntry,
  recoverTreasuryIntentsAtTickBoundary,
  releaseTreasuryIntentEntry,
  treasuryIntentBlockers,
  treasuryIntentCapacityOccupancy,
  treasuryIntentOutflowOccupancy,
  writeTreasuryIntentEntry,
} from "@/runtime/treasury/intents";
import { readTreasuryCommitmentRevision } from "@/runtime/treasury/commitmentRevision";
import { readTreasuryResolutionCounters } from "@/runtime/treasury/resolutionEvents";
import {
  committedResolutionSettledAtTick,
  peekTreasuryResolutionStoreHealth,
  readTreasuryResolutionStoreCounters,
  recoverStagedResolutions,
} from "@/runtime/treasury/resolutionStore";
import {
  registerTreasuryReconciliationCapability,
  type TreasuryReconciliationCapability,
  type TreasuryReconciliationConclusion,
} from "@/runtime/treasury/reconciliation";
import {
  findTreasuryActionAdapter,
  readTreasuryActionContractCounters,
  verifyTreasuryActionContractForAuthorization,
} from "@/runtime/treasury/actionContracts";
import {
  ensureReservationSchemaActivated,
  isReservationOwnerMigrationComplete,
  isReservationStoreCorrupted,
  readReservationMutationCounters,
  readReservationStoreRevision,
  validateReservationStoreHealth,
} from "@/runtime/resourceReservation";
import {
  canonicalTreasuryPolicyFingerprint,
  postingsWithinAuthorizationScope,
  TREASURY_AUTHORIZATION_ACTIVE_LIMIT,
  treasuryAuthorizationOwnerKey,
  validateTreasuryAuthorizationPolicy,
  validateTreasuryAuthorizationRequest,
  type TreasuryAuthorizationBundle,
  type TreasuryAuthorizationConsumeResult,
  type TreasuryAuthorizationRequest,
  type TreasuryAuthorizationResult,
  type TreasuryAuthorizationRevisions,
  type TreasuryAuthorizationToken,
  type TreasuryContractAuthorizationOptions,
} from "@/runtime/treasury/authorization";
import { readTreasuryQuarantineRevision } from "@/runtime/treasury/quarantine";
import { readTreasuryIntentRevision } from "@/runtime/treasury/intents";
import type { TreasuryPosting } from "@/runtime/treasury/types";
import {
  type TreasuryBalanceView,
  type TreasuryCommitmentIndex,
  type TreasuryEpoch,
  type TreasuryHolderResolution,
  type TreasuryJournalEntry,
  type TreasuryLocationKind,
  type TreasuryMetrics,
  type TreasuryObservationView,
  type TreasuryCommitmentCompleteness,
  type TreasuryOwnerIdentity,
  type TreasuryOwnerStatus,
  type TreasuryPreparedAbortResult,
  type TreasuryPreparedCommitResult,
  type TreasuryPreparedHandle,
  type TreasuryPreparedHandleState,
  type TreasuryPreparedLeakAudit,
  type TreasuryPreparedLeakSample,
  type TreasuryPreparationResult,
  type TreasurySafeExecuteResult,
  type TreasuryProjectedArchive,
  type TreasuryQueryContext,
  type TreasuryQueryOwner,
  type TreasuryRecordActionInput,
  type TreasuryReconciliationSummary,
  type TreasuryRejectedResult,
  type TreasurySettlementResult,
  type TreasuryTransactionInput,
  createTreasuryMetrics,
} from "@/runtime/treasury/types";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";

/** 每 tick market-fresh epoch 发行上限（shared 不占额；CPU 保护）。 */
export const TREASURY_FRESH_EPOCH_LIMIT = 8;

/** tick 边界 outstanding prepared 审计的样本上限（有界）。 */
export const TREASURY_PREPARED_LEAK_SAMPLE_CAP = 8;

/** 服务实例代际序号（模块级单调递增；跨实例 handle 一律无效）。 */
let treasuryServiceGenerationSeq = 0;
function nextTreasuryServiceGeneration(): number {
  treasuryServiceGenerationSeq += 1;
  return treasuryServiceGenerationSeq;
}

export interface TreasuryServiceDeps {
  /** 生产=TickContext.getMyRooms()（注入避免 runtimeServices 依赖环）。 */
  readonly getRooms: () => readonly Room[];
  /** 直读 Memory 路径（不 ensure——查询零写）；默认实现见下。 */
  readonly getTasks?: () => Record<string, ResourceTransferTask>;
  readonly getReservations?: () => Record<string, {
    roomName: string;
    resource: string;
    holderId: string;
    amount: number;
    expiresAt: number;
  }>;
  readonly holderExists?: (holderId: string) => boolean;
  /**
   * holder 身份解析（owner 声明验证用）：返回存在性与 typed 归属
   * （game-object / logical + 房间）。默认实现识别 `nuker:`/`synthesis:`
   * 逻辑名命名空间与裸 Game object id——logical holder 不再被误判 orphan。
   */
  readonly resolveHolder?: (holderId: string) => TreasuryHolderResolution | undefined;
}

/**
 * prepared handle 的内部记录：canonical transaction + 验证形状 + tentative
 * 预留 key + 签发上下文（tick/generation）。state 即 handle 状态机。
 */
interface PreparedTransaction {
  readonly handle: TreasuryPreparedHandle;
  readonly canonical: TreasuryCanonicalTransaction;
  readonly digest: string;
  readonly observation: TreasuryObservationView;
  readonly shape: TreasuryValidatedTransactionShape;
  readonly tentativeKey: string;
  readonly preparedAtTick: number;
  readonly generation: number;
  state: TreasuryPreparedHandleState;
  /** commit 写故障的 phase（faulted 后保留，tick 边界 quarantine 快照用）。 */
  faultPhase?: TreasuryWriteFaultPhase;
  /** 已写入 durable intent（executePreparedAction/contract 路径；slot 由 intent 接管）。 */
  intentWritten?: boolean;
}

/**
 * 终态 stub（第六轮 handle 生命周期有界化）：committed/aborted/expired 后
 * 从 active strong registry 移除、丢弃 canonical/observation/shape 等大对象
 * 引用——只保留幂等判定所需的最小字段。仍被调用方引用的 handle 经
 * WeakMap 取到 stub，返回稳定终态结果；handle 被 GC 回收即整体回收
 * （长寿命 global 不累积终态 handle 的无界强引用）。
 */
interface TerminalHandleRecord {
  readonly transactionId: string;
  readonly digest: string;
  readonly preparedAtTick: number;
  readonly generation: number;
  state: TreasuryPreparedHandleState;
  faultPhase?: TreasuryWriteFaultPhase;
  committedAtTick?: number;
}

/** handle 的全生命周期记录（active 完整记录或终态 stub）。 */
type TreasuryHandleRecord = PreparedTransaction | TerminalHandleRecord;

function isTerminalRecord(record: TreasuryHandleRecord): record is TerminalHandleRecord {
  return !("canonical" in record);
}

/**
 * Writer kernel execution options（第九轮 4.2/4.3，@internal——窄内部接口，
 * actionContracts 经此访问 writer kernel；普通生产模块不得构造）：
 * - redeemAuthorization：prepare 成功（tentative 接管）后、durable intent
 *   写入前调用一次——授权预算 → tentative ledger 的**原子转移点**（先
 *   prepare 后消费：prepare 拒绝时零消费；redeem 拒绝时 tentative 释放、
 *   callback 零调用）；
 * - intentContract：contract 执行路径的完整合同身份（durable intent 持久
 *   化绑定的字段来源）。
 */
export interface TreasuryWriterKernelExecution {
  redeemAuthorization?(): { readonly status: "ok" } | { readonly status: "rejected"; readonly reason: string; readonly detail: string };
  intentContract?: {
    readonly contractId: string;
    readonly contractDigest: string;
    readonly adapterVersion: number;
    readonly authorizationDigest?: string;
    readonly durablePayload?: string;
    readonly durablePayloadVersion?: number;
  };
}

export interface TreasuryService {
  /** tick 起点：发行 shared epoch + 对账 + receipt 清理（幂等，可重复调用）。 */
  beginTick(): void;
  /** tick 终点：归档投影终态并关闭本 tick（幂等；之后登记拒绝 tick_closed）。 */
  endTick(): void;
  /** shared observation：同 tick 缓存复用（不可变）。 */
  observation(): TreasuryObservationView;
  /**
   * market-fresh：每次独立构建并登记独立 epoch，不污染 shared 缓存。
   * endTick 后或本 tick fresh 数量达上限时返回 null（拒绝发行）。
   */
  beginFreshObservation(): TreasuryObservationView | null;
  /** 承诺统一索引：同 tick 缓存；权威 mutation 后按 revision 失效重建。 */
  commitments(): TreasuryCommitmentIndex;
  /** 带上下文余额查询（输入非法/owner 非法 fail closed）。 */
  query(context: TreasuryQueryContext): TreasuryBalanceView;
  /**
   * 资源授权（第八轮）：独立授权阶段——真实写动作的资源流出必须被授权
   * 覆盖。计算 = exact observation + committed overlay − pending outgoing −
   * production reservations（owner-aware）− quarantine/intent 风险 − policy
   * withhold − 其它未消费授权预算；验证 completeness/store health/write
   * readiness/容量/安全整数。成功签发 opaque token（heap-only、冻结、单次
   * 使用、revision 绑定）并立即占用 authorization budget（防双授权超卖）。
   */
  authorizeResourceUse(request: TreasuryAuthorizationRequest): TreasuryAuthorizationResult;
  /**
   * Contract-first 授权（第九轮 4.1，生产唯一授权入口）：授权需求全部从
   * contract 的 canonical postings 与 adapter 元数据派生（actionKind/rooms/
   * locations/每资源 amount/contractDigest/adapterVersion）——调用者只能
   * 提供 owner/受控 withhold/投影开关/容量需求。原子签发：任一资源失败时
   * 已签发 token 的预算全部回滚。要求 write admission ready（比
   * authorizationSafe 更强的前置）。
   */
  authorizeTreasuryActionContract(
    contract: unknown,
    options?: TreasuryContractAuthorizationOptions,
  ): { readonly status: "authorized"; readonly bundle: TreasuryAuthorizationBundle } | {
    readonly status: "rejected";
    readonly reason: "invalid_input" | "contract_invalid" | "adapter_not_registered" | "write_admission_blocked" | "authorization_policy_violation" | "authorization_context_unsafe" | "insufficient_amount" | "capacity_overflow" | "authorization_capacity_exhausted";
    readonly detail: string;
  };
  /**
   * 授权 bundle/token 的只读预验证（第九轮 4.2，@internal——writer kernel
   * redemption 前置）：全部 token 一次性验证（对象身份/generation/tick/
   * revisions/transactionId/重复 token/postings 覆盖），零状态变化、零消费。
   * 原子性的可达性保证：预验证与消费在同一同步窗口，中间无 revision 变化源。
   */
  validateTreasuryAuthorizationForRedeem(
    tokens: readonly TreasuryAuthorizationToken[],
    contract: { readonly transactionId: string; readonly actionKind: string; readonly digest: string; readonly adapterVersion: number },
    postings: readonly TreasuryPosting[],
  ): { readonly status: "ok" } | { readonly status: "rejected"; readonly reason: string; readonly detail: string };
  /**
   * 授权消费（第八轮）：对象身份 → generation → tick → revision 快照 →
   * 单次使用 → transactionId 绑定 → postings 覆盖校验；成功释放该 token 的
   * 预算（转为 prepare 的 tentative，互换不双算）。生产路径经
   * executeTreasuryActionContract 自动消费；本原语供该入口与测试使用。
   */
  consumeTreasuryAuthorization(
    token: TreasuryAuthorizationToken,
    options?: {
      transactionId?: string;
      postings?: readonly TreasuryPosting[];
    },
  ): TreasuryAuthorizationConsumeResult;
  /**
   * 两阶段 prepare：在调用真实 Game 写动作之前完成全部 Treasury 侧验证
   * （幂等/digest 冲突/epoch/格式/tentative 感知物理可行性）并预留资源、
   * 容量与 receipt 槽位。返回不可伪造的 prepared handle。
   */
  prepareTransaction(input: TreasuryTransactionInput): TreasuryPreparationResult;
  /**
   * 两阶段 commit：handle 验证（registry 对象身份 + generation + tick，
   * 不依赖调用方先 beginTick）后执行 tentative → committed 兑现——不做
   * 业务 admission，Game API 已返回 OK 后不再因业务条件拒绝。
   */
  commitPreparedTransaction(handle: TreasuryPreparedHandle): TreasuryPreparedCommitResult;
  /** 两阶段 abort：原子释放 tentative 资源/容量/receipt 槽与 handle，零结算写入。 */
  abortPreparedTransaction(handle: TreasuryPreparedHandle): TreasuryPreparedAbortResult;
  /**
   * 安全执行包装器（生产 writer 的唯一推荐入口）：prepare → 调用 Game
   * API 恰好一次 → ok=true commit / ok=false abort / 抛错 abort+rethrow。
   * prepare 失败时 Game API 不执行；正常完整执行后 outstanding 恒为 0。
   */
  executePreparedAction<TAction extends { ok: boolean }>(
    input: TreasuryTransactionInput,
    action: () => TAction,
    execution?: TreasuryWriterKernelExecution,
  ): TreasurySafeExecuteResult<TAction>;
  /** 最近一次 tick 边界的 outstanding prepared 审计快照（有界样本）。 */
  preparedLeakAudit(): TreasuryPreparedLeakAudit;
  /**
   * 签发 reconciliation capability（第八轮 9.1）：resolution 结论的唯一合法
   * 来源——基于当前 exact post-fault observation + **受注册 action
   * reconciler**（actionContracts registry）判定 committed/not-executed/
   * uncertain。opaque capability（对象身份防伪、单次使用、generation/tick
   * 有界）；未注册 reconciler 的 action kind 拒绝；uncertain 保持隔离。
   */
  issueTreasuryReconciliationCapability(input: {
    readonly transactionId: string;
    readonly digest?: string;
  }): { readonly status: "issued"; readonly capability: TreasuryReconciliationCapability } | {
    readonly status: "rejected";
    readonly reason: "not_found" | "digest_mismatch" | "active_handle_present" | "no_registered_reconciler" | "invalid_input" | "premature_observation";
    readonly detail: string;
  };
  /** 当前 service generation（capability/resolve 调用方校验用）。 */
  treasuryServiceGeneration(): number;
  /** @deprecated 第七轮 guard 入口已被 capability 协议取代（保留只读诊断）。 */
  treasuryResolutionGuard(): {
    readonly activeTransactionIds: ReadonlySet<string>;
    readonly currentObservationTick: number;
  };
  /** 当前 tick journal 快照（冻结副本）。 */
  journal(): readonly TreasuryJournalEntry[];
  /** 最近一次跨 tick 对账结果。 */
  lastReconciliation(): TreasuryReconciliationSummary | null;
  /**
   * @deprecated 兼容别名：projectedUsedCapacity = strictProjectedUsedCapacity
   *（严格口径）；projectedFreeCapacity = riskAdjustedFreeCapacity（第七轮起
   * 语义即 risk-adjusted——可能已流入的 uncertain 资源占用空间）。新代码
   * 使用下方显式命名的双口径 API。
   */
  projectedUsedCapacity(roomName: string, kind: TreasuryLocationKind): number;
  /** @deprecated 见 projectedUsedCapacity。 */
  projectedFreeCapacity(roomName: string, kind: TreasuryLocationKind): number;
  /** 严格口径 used = observed.used + 本 tick overlay 净变化（不含风险扣减）。 */
  strictProjectedUsedCapacity(roomName: string, kind: TreasuryLocationKind): number;
  /** 严格口径 free = observed.free − overlay 净变化（used + free = physical）。 */
  strictProjectedFreeCapacity(roomName: string, kind: TreasuryLocationKind): number;
  /** risk-adjusted free = 严格 free − quarantine/unresolved intent 正流入占用（admission 口径）。 */
  riskAdjustedFreeCapacity(roomName: string, kind: TreasuryLocationKind): number;
  /** 单调投影版本（本 tick 已接受 transaction 数驱动；诊断/缓存失效用）。 */
  projectionRevision(): number;
  metrics(): TreasuryMetrics;
  /** 仅供测试：清空全部 heap 状态（持久 receipt 用 clearTreasuryPersistenceForTest）。 */
  resetForTest(): void;
}

interface TreasuryTickState {
  tick: number;
  observation: TreasuryObservationView;
  commitmentIndex?: TreasuryCommitmentIndex;
  commitmentBuiltRevision?: number;
  ended: boolean;
  /** endTick（或补救）归档的投影终态 + 结构 manifest（供下一 tick 对账）。 */
  archived?: TreasuryProjectedArchive;
  lastReconciliation?: TreasuryReconciliationSummary;
}

const DEFAULT_LOCATION_KINDS: readonly TreasuryLocationKind[] = ["storage", "terminal"];
const VALID_QUERY_RESOURCES: ReadonlySet<string> = new Set<string>(RESOURCES_ALL);
const VALID_HOLDER_KINDS: ReadonlySet<string> = new Set<string>(["game-object", "logical"]);
const QUERY_BOOLEAN_KEYS: ReadonlyArray<"allowProjected" | "allowIncoming" | "subtractOutgoing" | "subtractReservations"> = [
  "allowProjected",
  "allowIncoming",
  "subtractOutgoing",
  "subtractReservations",
];

function defaultGetTasks(): Record<string, ResourceTransferTask> {
  return Memory.data?.resourceControl?.tasks ?? {};
}

function defaultGetReservations(): Record<string, {
  roomName: string;
  resource: string;
  holderId: string;
  amount: number;
  expiresAt: number;
}> {
  return (Memory.runtime?.resourceReservations ?? {}) as Record<string, {
    roomName: string;
    resource: string;
    holderId: string;
    amount: number;
    expiresAt: number;
  }>;
}

/**
 * 查询上下文 fail-closed 校验：非法资源、非法/重复/非管辖（unknown 或
 * unowned）房间、空 room/location scope、非法/重复位置、非有限非负
 * withhold、非布尔开关字段一律拒绝（重复条目会双倍累计，绝不静默去重；
 * 空 scope 是退化输入，不给"合法零集"错觉）。返回有界错误描述（null=合法）。
 */
function validateQueryContext(
  context: TreasuryQueryContext,
  governedRoomNames: ReadonlySet<string>,
): string | null {
  if (!context || typeof context !== "object") return "context 缺失";
  if (typeof context.resource !== "string" || !VALID_QUERY_RESOURCES.has(context.resource)) {
    return `resource 非法: ${String(context.resource)}`;
  }
  if (context.rooms !== undefined) {
    if (!Array.isArray(context.rooms)) return "rooms 必须为数组";
    if (context.rooms.length === 0) return "rooms 为空数组（空 room scope 非法）";
    const seen = new Set<string>();
    for (const roomName of context.rooms) {
      if (typeof roomName !== "string" || roomName.length === 0) {
        return `rooms 含非法房间名: ${String(roomName)}`;
      }
      if (seen.has(roomName)) return `rooms 含重复房间: ${roomName}`;
      if (!governedRoomNames.has(roomName)) {
        return `rooms 含非管辖房间（unknown/unowned）: ${roomName}`;
      }
      seen.add(roomName);
    }
  }
  if (context.locations !== undefined) {
    if (!Array.isArray(context.locations)) return "locations 必须为数组";
    if (context.locations.length === 0) return "locations 为空数组（空位置 scope 非法）";
    const seen = new Set<string>();
    for (const kind of context.locations) {
      if (kind !== "storage" && kind !== "terminal") {
        return `locations 含非法位置类型: ${String(kind)}`;
      }
      if (seen.has(kind)) return `locations 含重复位置: ${kind}`;
      seen.add(kind);
    }
  }
  for (const key of QUERY_BOOLEAN_KEYS) {
    const value = (context as unknown as Record<string, unknown>)[key];
    if (value !== undefined && typeof value !== "boolean") {
      return `${key} 必须为布尔（got ${typeof value}）`;
    }
  }
  if (context.withhold !== undefined) {
    if (
      typeof context.withhold !== "number" ||
      !Number.isSafeInteger(context.withhold) ||
      context.withhold < 0
    ) {
      return `withhold 必须为非负安全整数: ${String(context.withhold)}`;
    }
  }
  return null;
}

/**
 * owner 声明强化验证（typed identity，fail closed）：
 * - 格式（scope/ownerKind/ownerId/roomName）；
 * - holder 真实存在（运行时解析：game-object 走 getObjectById、
 *   logical-service 走 namespace 注册表）；
 * - 声明 ownerKind 与运行时解析类型一致（防字符串冒充其他类型 owner）；
 * - 声明房间与 holder 真实归属一致；
 * - legacy-unresolved / task / contract 无运行时存在性权威——不接受
 *   （fail closed），杜绝"知道字符串就排除任何预留"。
 * 通过后返回完整 typed identity 与归属房间——自排除使用 identity key
 * 比较（同字符串不同 kind 不互相排除）。
 */
function resolveOwnerStatus(
  owner: TreasuryQueryOwner | undefined,
  resolveHolder: (holderId: string) => TreasuryHolderResolution | undefined,
): { valid: boolean; ownerRoom: string | undefined; ownerIdentity: TreasuryOwnerIdentity | undefined } {
  if (!owner) return { valid: true, ownerRoom: undefined, ownerIdentity: undefined };
  if (typeof owner !== "object") return { valid: false, ownerRoom: undefined, ownerIdentity: undefined };
  if (owner.scope !== "production-reservation") return { valid: false, ownerRoom: undefined, ownerIdentity: undefined };
  if (owner.ownerKind !== "game-object" && owner.ownerKind !== "logical-service") {
    return { valid: false, ownerRoom: undefined, ownerIdentity: undefined };
  }
  if (typeof owner.ownerId !== "string" || owner.ownerId.length === 0 || owner.ownerId.length > 128) {
    return { valid: false, ownerRoom: undefined, ownerIdentity: undefined };
  }
  if (typeof owner.roomName !== "string" || owner.roomName.length === 0) {
    return { valid: false, ownerRoom: undefined, ownerIdentity: undefined };
  }
  if (owner.namespace !== undefined && (typeof owner.namespace !== "string" || owner.namespace.length === 0)) {
    return { valid: false, ownerRoom: undefined, ownerIdentity: undefined };
  }
  const resolved = resolveHolder(owner.ownerId);
  if (resolved === undefined) return { valid: false, ownerRoom: undefined, ownerIdentity: undefined };
  const runtimeKind = resolved.kind === "game-object" ? "game-object" : "logical-service";
  if (runtimeKind !== owner.ownerKind) return { valid: false, ownerRoom: undefined, ownerIdentity: undefined };
  if (resolved.roomName !== owner.roomName) return { valid: false, ownerRoom: undefined, ownerIdentity: undefined };
  if (owner.namespace !== undefined && owner.ownerId.startsWith(`${owner.namespace}:`) === false) {
    return { valid: false, ownerRoom: undefined, ownerIdentity: undefined };
  }
  const ownerIdentity: TreasuryOwnerIdentity =
    owner.ownerKind === "logical-service"
      ? { kind: "logical-service", id: owner.ownerId, namespace: owner.namespace ?? owner.ownerId.split(":")[0], roomName: owner.roomName }
      : { kind: "game-object", id: owner.ownerId, roomName: owner.roomName };
  return { valid: true, ownerRoom: owner.roomName, ownerIdentity };
}

export function createTreasuryService(deps: TreasuryServiceDeps): TreasuryService {
  const metrics = createTreasuryMetrics();
  const projection: TreasuryProjectionController = createTreasuryProjectionController({
    onDuplicateRejected: () => {
      metrics.duplicateSettlementsRejected += 1;
    },
    onInvalidRejected: (reason) => {
      metrics.transactionsRejectedInvalid += 1;
      if (reason === "receipt_capacity_exhausted") metrics.receiptCapacityRejections += 1;
    },
    onRecorded: (entry) => {
      metrics.transactionsRecorded += 1;
      metrics.postingsRecorded += entry.postings.length;
    },
    onReconciliation: (summary) => {
      metrics.reconciliationChecks += 1;
      metrics.reconciliationInflowMismatches += summary.inflowMismatches;
      metrics.reconciliationOutflowMismatches += summary.outflowMismatches;
      metrics.reconciliationStructuralChanges += summary.structuralChanges;
      if (summary.tickGap) metrics.tickGapReconciles += 1;
    },
  });

  let epochSeq = 0;
  let current: TreasuryTickState | null = null;
  let freshEpochsThisTick = 0;
  /**
   * 本 tick 发行的全部 epoch（shared 1 + fresh N）：登记校验的权威注册表。
   * 每个条目保存该 epoch 的 exact immutable observation——transaction 物理
   * 验证必须用 decision 指向的那一次观察，不得回退 shared。heap-only，
   * 每 tick 清空（global reset 后旧 epoch 全部不可恢复 → unknown_epoch）。
   */
  const epochRegistry = new Map<
    number,
    { scope: "shared" | "market-fresh"; observedAtTick: number; observation: TreasuryObservationView }
  >();
  /**
   * 两阶段 prepared handles（heap，tick 内有效；第六轮生命周期有界化）：
   * - handleRegistry（WeakSet）是 handle 防伪权威——只有本服务实例签发
   *   （且经对象身份注册）的 handle 能通过 commit/abort 验证；调用方构造
   *   结构相同的普通对象或 JSON round-trip 副本不在集合内，一律 invalid；
   * - handleRecords（WeakMap）承载全生命周期记录：active 期为完整记录
   *   （canonical/observation/shape），终态（committed/aborted/expired）替换
   *   为轻量 stub——handle 被 GC 回收即整体回收，长寿命 global 不随历史
   *   transaction 数量累积无界强引用；
   * - activeHandles（strong Map）只含未清理状态（prepared/executing/
   *   committing/faulted）——commit/abort 成功即删除、tick 边界 stub 化；
   *   preparedActive gauge 即其大小；
   * - preparedById 只保留未终态记录（同 id 新 prepare 合法）；
   * - endTick/beginTick 全部作废（expired）并释放 tentative 与 receipt 预留
   *   （executing/faulted 先转 durable quarantine）。
   */
  const handleRegistry = new WeakSet<TreasuryPreparedHandle>();
  const handleRecords = new WeakMap<TreasuryPreparedHandle, TreasuryHandleRecord>();
  const activeHandles = new Map<TreasuryPreparedHandle, PreparedTransaction>();
  const preparedById = new Map<string, PreparedTransaction>();
  /**
   * 已写入 durable intent 的 active handle transactionId 集合（第八轮 slot
   * 统一计数）：这些 handle 的 recovery slot 已由 intent 接管，不得在
   * "active handle" 形态上重复计入。handle 终态化时移除。
   */
  const intentBackedActiveIds = new Set<string>();

  /**
   * 统一 recovery slot 占用数（O(1)；第八轮 3.5）：一笔 transaction 恒占一个
   * slot——quarantine entry + durable intent + 无 intent 的 active handle。
   * fault 时 intent 转换为 quarantine entry（+1/−1 守恒）；正常 commit/abort
   * 释放。prepare admission 用本计数保证第 65 条 fault 在 prepare 前被拒。
   */
  function recoverySlotsOccupied(): number {
    const quarantineCount = peekTreasuryQuarantineHealth().entryCount;
    const intentCount = peekTreasuryIntentHealth().entryCount;
    return quarantineCount + intentCount + (activeHandles.size - intentBackedActiveIds.size);
  }

  /** 终态化：active registry 删除 + WeakMap 替换为轻量 stub（丢大对象引用）。 */
  function finalizeHandleRecord(
    record: PreparedTransaction,
    state: "committed" | "aborted" | "expired",
  ): void {
    activeHandles.delete(record.handle);
    intentBackedActiveIds.delete(record.canonical.transactionId);
    handleRecords.set(record.handle, {
      transactionId: record.canonical.transactionId,
      digest: record.digest,
      preparedAtTick: record.preparedAtTick,
      generation: record.generation,
      state,
      ...(record.faultPhase !== undefined ? { faultPhase: record.faultPhase } : {}),
      ...(state === "committed" ? { committedAtTick: Game.time } : {}),
    });
  }
  /** 服务实例代际：跨 service 实例的 handle 一律无效（global reset 防御）。 */
  const serviceGeneration = nextTreasuryServiceGeneration();

  // ── 授权 ledger（第八轮）：token 防伪 + 预算占用（heap-only） ───────────
  const authorizationRegistry = new WeakSet<TreasuryAuthorizationToken>();
  const authorizationRecords = new Map<TreasuryAuthorizationToken, {
    readonly outflowKeys: readonly string[];
    readonly amount: number;
    readonly capacityKey?: string;
    readonly capacityAmount?: number;
    consumed: boolean;
  }>();
  /** (room\u0000location\u0000resource) → 未消费授权的流出预算合计。 */
  const authorizationOutflowTotals = new Map<string, number>();
  /** (room\u0000location) → 未消费授权的容量预算合计。 */
  const authorizationCapacityTotals = new Map<string, number>();
  let authorizationLedgerRevisions: TreasuryAuthorizationRevisions | null = null;

  function currentAuthorizationRevisions(): TreasuryAuthorizationRevisions {
    return {
      commitmentRevision: readTreasuryCommitmentRevision(),
      projectionRevision: projection.projectionRevision(),
      quarantineRevision: readTreasuryQuarantineRevision(),
      intentRevision: readTreasuryIntentRevision(),
      reservationStoreRevision: readReservationStoreRevision(),
    };
  }

  function releaseAuthorizationBudget(
    token: TreasuryAuthorizationToken,
    record: { outflowKeys: readonly string[]; amount: number; capacityKey?: string; capacityAmount?: number; consumed: boolean },
  ): void {
    for (const key of record.outflowKeys) {
      const remaining = (authorizationOutflowTotals.get(key) ?? 0) - record.amount;
      if (remaining <= 0) authorizationOutflowTotals.delete(key);
      else authorizationOutflowTotals.set(key, remaining);
    }
    if (record.capacityKey !== undefined && record.capacityAmount !== undefined) {
      const remaining = (authorizationCapacityTotals.get(record.capacityKey) ?? 0) - record.capacityAmount;
      if (remaining <= 0) authorizationCapacityTotals.delete(record.capacityKey);
      else authorizationCapacityTotals.set(record.capacityKey, remaining);
    }
    record.consumed = true;
    authorizationRecords.delete(token);
  }
  /** 最近一次 tick 边界的 outstanding prepared 审计快照（有界样本）。 */
  let lastPreparedLeakAudit: TreasuryPreparedLeakAudit = Object.freeze({
    context: "end_tick",
    outstanding: 0,
    executing: 0,
    samples: Object.freeze([]),
  });

  /**
   * epochSeq 单点递增（每发行恰好 +1，无空洞——issueEpoch 只登记不递增）。
   */
  function nextEpochSeq(): number {
    epochSeq += 1;
    return epochSeq;
  }

  /** 登记 exact observation（两阶段：先递增取号、建观察，后入表）。 */
  function issueEpoch(
    scope: "shared" | "market-fresh",
    observation: TreasuryObservationView,
  ): TreasuryEpoch {
    epochRegistry.set(observation.epoch.epochSeq, {
      scope,
      observedAtTick: observation.epoch.observedAtTick,
      observation,
    });
    return observation.epoch;
  }

  function buildObservation(
    scope: "shared" | "market-fresh",
    epochSeqForBuild: number,
    previousArchive?: TreasuryProjectedArchive,
  ): { observation: TreasuryObservationView; reconciliation: TreasuryReconciliationSummary | null } {
    const observation = buildTreasuryObservation({
      scope,
      epochSeq: epochSeqForBuild,
      rooms: deps.getRooms(),
      onStoreScanned: (nonZeroKeys) => {
        metrics.storeEnumerations += 1;
        metrics.resourceKeysEnumerated += nonZeroKeys;
        metrics.nonZeroEntries += nonZeroKeys;
        metrics.locationsScanned += 1;
      },
    });
    if (scope === "shared") {
      metrics.observationRebuilds += 1;
      // 对账必须用 shared 观察（fresh 不参与对账链路）。
      return { observation, reconciliation: projection.reconcile(previousArchive, observation) };
    }
    metrics.freshObservationBuilds += 1;
    return { observation, reconciliation: null };
  }

  /**
   * 作废全部未决 prepare（tick 边界）——第六轮按 Game 结果分类：
   * - prepared（确定未调用 Game API）：handle 转 expired 终态，释放全部
   *   tentative 预留与 receipt 槽（零 journal 状态）；
   * - executing（Game 结果未知）/ faulted（commit 写故障）：**不得**按普通
   *   prepared 释放——先落 durable quarantine（持久占用资源/容量/
   *   transaction identity，跨 global reset 存活），heap tentative 随 tick
   *   清理（占用由 quarantine 接替）。executing 同时写 write-fault marker
   *   并进入全局锁（既有语义）；faulted 的 marker 已在故障时写入。
   * endTick 侧的审计（outstanding 计数/样本/executing 严重故障）在
   * auditOutstandingPrepared 内联。
   */
  function invalidatePreparedTransactions(context: "end_tick" | "begin_tick_remedy"): void {
    if (preparedById.size === 0) return;
    auditOutstandingPrepared(context);
    for (const record of preparedById.values()) {
      if (record.state === "executing" || record.state === "faulted") {
        quarantinePreparedRecord(record);
      }
      record.state = "expired";
      finalizeHandleRecord(record, "expired"); // stub 化：丢弃 canonical/observation/shape 引用
    }
    preparedById.clear();
    projection.tentativeReleaseAll();
    releaseAllTreasuryReceiptReservations();
  }

  /** record 的 merged postings → quarantine canonical posting 快照（有界数组；容量占用由其派生）。 */
  function quarantineDeltasOf(record: PreparedTransaction): TreasuryQuarantineDeltas[] {
    return record.shape.merged.map((posting) => ({
      roomName: posting.roomName,
      locationKind: posting.locationKind,
      resource: posting.resource,
      delta: posting.delta,
    }));
  }

  /**
   * fault 路径共用的立即隔离（第七轮）：faulted + write-fault marker（含
   * 有界 detail）+ durable quarantine 一次完成。写入被拒（store fatal /
   * 防御性容量分支）时保持 marker 锁定并计数——绝不静默丢失占用事实。
   * 第八轮：quarantine 写入成功后释放对应 durable intent（slot 由 intent
   * 形态转换为 quarantine entry，守恒）；写失败时 intent 保留（emergency
   * intent authority——postings/占用/slot 不丢）。
   */
  function quarantineFaultedRecord(record: PreparedTransaction, detail?: string): void {
    record.state = "faulted";
    metrics.commitFaults += 1;
    recordTreasuryWriteFault({
      transactionId: record.canonical.transactionId,
      digest: record.digest,
      tick: record.preparedAtTick,
      kind: record.canonical.kind,
      source: record.canonical.source,
      phase: record.faultPhase ?? "commit_unexpected",
      status: "unresolved",
      recordedAt: Game.time,
      ...(detail !== undefined ? { detail: detail.slice(0, TREASURY_WRITE_FAULT_DETAIL_MAX) } : {}),
    });
    const write = quarantineTreasuryTransaction({
      transactionId: record.canonical.transactionId,
      digest: record.digest,
      tick: record.preparedAtTick,
      kind: record.canonical.kind,
      source: record.canonical.source,
      phase: record.faultPhase ?? "commit_unexpected",
      deltas: quarantineDeltasOf(record),
      recordedAt: Game.time,
    });
    if (write.status === "rejected") {
      // store 损坏或容量不变量破坏：marker 已锁全部 writer，此处只计数诊断。
      // intent 保留为最终保守权威（emergency intent authority）。
      metrics.quarantineAdmissionRejections += 1;
      return;
    }
    // quarantine 完整写入（written 或幂等 already_present）：释放 intent——
    // 资产事实已由 quarantine entry 接管（slot 守恒转换）。
    if (record.intentWritten) {
      releaseTreasuryIntentEntry(record.canonical.transactionId);
    }
  }

  /** executing/faulted handle → durable quarantine（tick 边界分类；幂等保留首条）。 */
  function quarantinePreparedRecord(record: PreparedTransaction): void {
    const write = quarantineTreasuryTransaction({
      transactionId: record.canonical.transactionId,
      digest: record.digest,
      tick: record.preparedAtTick,
      kind: record.canonical.kind,
      source: record.canonical.source,
      phase: record.state === "executing" ? "executing_at_end_tick" : record.faultPhase ?? "commit_unexpected",
      deltas: quarantineDeltasOf(record),
      recordedAt: Game.time,
    });
    if (write.status === "rejected") {
      // marker 已在 audit/故障路径写入（全局锁）；计数诊断，不静默。
      // intent 保留（emergency intent authority：postings/占用/slot 不丢）。
      metrics.quarantineAdmissionRejections += 1;
    } else if (record.intentWritten) {
      releaseTreasuryIntentEntry(record.canonical.transactionId);
    }
    metrics.preparedQuarantinedAtBoundary += 1;
  }

  /**
   * outstanding prepared 审计（endTick / beginTick 补救共用）：绝不静默
   * 清空——计数 + 有界样本 + 指标；executing 状态视为严重异常，写入
   * write-fault marker 并进入全局锁（Game API 结果未知的动作必须显式对账）。
   * faulted 计数不计入普通 outstanding（其 marker 已在故障时写入，占用转
   * durable quarantine——不是泄漏，是未解决故障）。
   */
  function auditOutstandingPrepared(context: "end_tick" | "begin_tick_remedy"): void {
    if (preparedById.size === 0) return;
    let outstanding = 0;
    let executing = 0;
    let faulted = 0;
    const samples: TreasuryPreparedLeakSample[] = [];
    for (const record of preparedById.values()) {
      if (record.state === "executing") {
        executing += 1;
        recordTreasuryWriteFault({
          transactionId: record.canonical.transactionId,
          digest: record.digest,
          tick: record.preparedAtTick,
          kind: record.canonical.kind,
          source: record.canonical.source,
          phase: "executing_at_end_tick",
          status: "unresolved",
          recordedAt: Game.time,
        });
        metrics.commitFaults += 1;
        continue;
      }
      if (record.state === "faulted") {
        faulted += 1;
        continue;
      }
      outstanding += 1;
      if (samples.length < TREASURY_PREPARED_LEAK_SAMPLE_CAP) {
        samples.push(
          Object.freeze({
            transactionId: record.canonical.transactionId,
            digest: record.digest,
            preparedAtTick: record.preparedAtTick,
            kind: record.canonical.kind,
            source: record.canonical.source,
          }),
        );
      }
    }
    metrics.preparedOutstandingAtEnd += outstanding;
    metrics.preparedExecutingAtEnd += executing;
    lastPreparedLeakAudit = Object.freeze({
      context,
      outstanding,
      executing,
      samples: Object.freeze(samples),
    });
  }

  /** beginTick 的实际执行体（显式调用与懒兜底共享；调用方保证幂等检查）。 */
  function performBeginTick(lazy: boolean): TreasuryTickState {
    if (lazy) metrics.lifecycleLazyInitializations += 1;

    let previousArchive: TreasuryProjectedArchive | undefined;
    if (current) {
      if (!current.ended) {
        // 上一 tick 缺 endTick（异常/未挂载）：补救归档，显式计数不静默。
        metrics.lifecycleMissingEndWarnings += 1;
        current.archived = projection.archiveProjectedFinal(current.observation);
      }
      if (current.archived) {
        previousArchive = current.archived;
      }
    }

    // global reset 检测：heap 无前序状态，但 Memory 生命周期记录证明近期运行过。
    const lifecycle = readTreasuryLifecycle();
    const afterGlobalReset = current === null && lifecycle?.lastEndTick !== undefined;
    if (afterGlobalReset) metrics.globalResetRecoveries += 1;

    // 懒兜底路径保持查询零写：receipt 清理与 lifecycle 写入只在显式 beginTick
    // 执行（main 固定挂载后懒路径不应出现；出现也不得产生隐藏写入）。
    if (!lazy) {
      const cleanup = cleanupTreasuryReceipts(Game.time);
      metrics.receiptsEvictedByRetention += cleanup.retentionEvicted;
      // reservation schema activation gate（第七轮 bootstrap phase）：显式
      // beginTick 先于全部 planner/reservation writer 完成激活（空店初始化/
      // legacy 迁移/失败计数——失败不写数据，mutation 与授权侧 fail closed）。
      // 每个 mutation 入口另自检（双保险），memoryCleanup 保留幂等兜底。
      const schemaGate = ensureReservationSchemaActivated();
      if (schemaGate.status === "rejected") {
        metrics.reservationSchemaActivationFailures += 1;
      }
      // durable intent 恢复（第八轮 3.4）：先于一切 planner/writer 加载验证
      // intent store——ready 相确认未执行关闭、其余保守转 execution-unknown
      // quarantine（quarantine 写失败时 intent 保留为 emergency authority）。
      // 恢复后仍存的未完成 intent 由 treasuryIntentBlockers 全局阻断新 writer。
      recoverTreasuryIntentsAtTickBoundary();
      // staged resolution 恢复（第八轮 8.2）：中断的 resolution 幂等完成/
      // 回滚（resolving+receipt 已写 → finalize；无进展 → 回滚；final 未
      // 释放 → 补完成）。
      recoverStagedResolutions();
    }

    // 跨 tick prepared handle 一律作废（observation 是 tick 级物理快照，
    // 世界已变，必须重新 prepare）；fresh 计数随注册表一起重置。
    invalidatePreparedTransactions("begin_tick_remedy");
    epochRegistry.clear();
    freshEpochsThisTick = 0;
    const sharedEpochSeq = nextEpochSeq();
    const built = buildObservation("shared", sharedEpochSeq, previousArchive);
    issueEpoch("shared", built.observation);
    const reconciliation = built.reconciliation
      ? Object.freeze({ ...built.reconciliation, afterGlobalReset })
      : null;

    current = {
      tick: Game.time,
      observation: built.observation,
      ended: false,
      lastReconciliation: reconciliation ?? undefined,
    };
    metrics.lifecycleBeginTicks += 1;
    if (!lazy) writeTreasuryLifecycle({ lastBeginTick: Game.time });
    return current;
  }

  function ensureTickState(lazy: boolean): TreasuryTickState {
    if (current && current.tick === Game.time) return current;
    return performBeginTick(lazy);
  }

  /**
   * 决策 epoch 校验（单阶段登记与两阶段 prepare 共用）：必须命中本 tick
   * 注册表中的活跃 epoch 且 scope 一致。返回注册表条目或拒绝结果。
   */
  function resolveDecisionEpoch(
    decision: TreasuryTransactionInput["decision"],
  ): { registered: { scope: string; observedAtTick: number; observation: TreasuryObservationView } } | { rejection: TreasuryRejectedResult } {
    if (!decision || typeof decision !== "object") {
      metrics.staleEpochRejections += 1;
      return { rejection: { status: "rejected", reason: "stale_epoch", detail: "decision 缺失" } };
    }
    if (decision.observedAtTick !== Game.time) {
      metrics.staleEpochRejections += 1;
      return {
        rejection: {
          status: "rejected",
          reason: "stale_epoch",
          detail: `决策基于 tick ${String(decision.observedAtTick)} 的观察`,
        },
      };
    }
    const registered = epochRegistry.get(decision.epochSeq);
    if (registered === undefined) {
      metrics.unknownEpochRejections += 1;
      return {
        rejection: {
          status: "rejected",
          reason: "unknown_epoch",
          detail: `epochSeq ${String(decision.epochSeq)} 未在本 tick 注册`,
        },
      };
    }
    if (registered.scope !== decision.scope) {
      metrics.epochScopeMismatches += 1;
      return {
        rejection: {
          status: "rejected",
          reason: "scope_mismatch",
          detail: `epochSeq ${String(decision.epochSeq)} 注册为 ${registered.scope}，决策声明 ${decision.scope}`,
        },
      };
    }
    return { registered };
  }

  const service = {
    beginTick(): void {
      if (current && current.tick === Game.time) return; // 幂等
      performBeginTick(false);
    },

    endTick(): void {
      if (!current || current.tick !== Game.time || current.ended) return; // 幂等
      current.archived = projection.archiveProjectedFinal(current.observation);
      current.ended = true;
      // tick 关闭：未决 prepare 审计（计数/样本/executing 严重故障）后全部
      // 作废（Game API 结果未知的动作留待对账/修复发现；绝不跨 tick 保留
      // handle，绝不静默当作正常 abort）。
      invalidatePreparedTransactions("end_tick");
      metrics.lifecycleEndTicks += 1;
      writeTreasuryLifecycle({ lastEndTick: Game.time });
    },

    observation(): TreasuryObservationView {
      const state = ensureTickState(true);
      metrics.observationReuseHits += 1;
      return state.observation;
    },

    beginFreshObservation(): TreasuryObservationView | null {
      // 确保本 tick 生命周期已初始化（fresh epoch 必须登记进本 tick 注册表）。
      const state = ensureTickState(true);
      // endTick 后不得再发行 fresh epoch（tick 已关闭，fresh 决策无合法窗口）。
      if (state.ended) return null;
      // fresh 数量上限：fresh 观察是全房间扫描，无上限即无界 CPU 风险。
      if (freshEpochsThisTick >= TREASURY_FRESH_EPOCH_LIMIT) {
        metrics.freshEpochLimitRejections += 1;
        return null;
      }
      const freshEpochSeq = nextEpochSeq();
      const built = buildObservation("market-fresh", freshEpochSeq);
      issueEpoch("market-fresh", built.observation);
      freshEpochsThisTick += 1;
      return built.observation;
    },

    commitments(): TreasuryCommitmentIndex {
      const state = ensureTickState(true);
      const revision = readTreasuryCommitmentRevision();
      if (!state.commitmentIndex || state.commitmentBuiltRevision !== revision) {
        metrics.commitmentRebuilds += 1;
        const queriesBefore = state.commitmentIndex?.metrics.indexQueries ?? 0;
        state.commitmentIndex = buildTreasuryCommitmentIndex({
          tick: Game.time,
          tasks: (deps.getTasks ?? defaultGetTasks)(),
          reservations: (deps.getReservations ?? defaultGetReservations)(),
          observation: state.observation,
          holderExists: deps.holderExists,
          // 容量口径（第七/八轮）：capacityDelta = **risk-adjusted**（overlay +
          // quarantine/unresolved intent 正净流入占用——receiver admission 用，
          // 与 riskAdjustedFreeCapacity 同口径）；strictCapacityDelta = 仅
          // overlay 的严格口径（可能已流入的资源必须减少 free capacity，
          // 负流出不增加——只有 risk 口径做该保守扣减）。
          capacityDelta: (roomName, kind) =>
            projection.locationCapacityDelta(roomName, kind) +
            (treasuryQuarantineCapacityOccupancy().get(`${roomName}\u0000${kind}`) ?? 0) +
            (treasuryIntentCapacityOccupancy().get(`${roomName}\u0000${kind}`) ?? 0),
          strictCapacityDelta: (roomName, kind) => projection.locationCapacityDelta(roomName, kind),
          onExpiredExcluded: () => {
            metrics.expiredCommitmentsExcluded += 1;
          },
          onMissingOwnerCommitted: () => {
            metrics.missingOwnerStillCommitted += 1;
          },
        });
        state.commitmentBuiltRevision = revision;
        // facade 级累计：包含被替换索引的历史查询（跨重建累计口径）。
        metrics.commitmentIndexQueries += queriesBefore;
        metrics.commitmentRecords =
          state.commitmentIndex.metrics.taskRecords + state.commitmentIndex.metrics.reservationRecords;
        metrics.typedOwnerResolvedCount = state.commitmentIndex.metrics.typedOwnerResolved;
        metrics.legacyUnresolvedOwnerCount = state.commitmentIndex.metrics.legacyUnresolvedOwners;
        metrics.invalidCommitmentRecords = state.commitmentIndex.metrics.invalidCommitmentRecords;
        metrics.incompleteCommitmentScopes = state.commitmentIndex.metrics.incompleteCommitmentScopes;
        metrics.commitmentGloballyIncomplete = state.commitmentIndex.metrics.globallyIncomplete;
      }
      return state.commitmentIndex;
    },

    query(context: TreasuryQueryContext): TreasuryBalanceView {
      const state = ensureTickState(true);
      const observation = state.observation;

      // 输入规范化 fail closed：非法资源/非管辖或重复房间/空 scope/非法布尔
      // 开关/NaN withhold 等一律返回保守全零视图（不报乐观可用量），并计数。
      const invalidReason = validateQueryContext(context, new Set(observation.roomNames()));
      if (invalidReason !== null) {
        metrics.queryInvalidContexts += 1;
        return {
          resource: typeof context?.resource === "string" ? context.resource : String(context?.resource),
          observed: 0,
          projected: 0,
          committed: 0,
          incoming: 0,
          spendable: 0,
          overcommitted: true,
          ownerStatus: context?.owner ? "invalid_fail_closed" : "none",
          contextStatus: "invalid_fail_closed",
          commitmentStatus: "globally-incomplete",
          authorizationSafe: false,
          authorizationBlockers: ["invalid_context"],
          writeAdmission: { ready: false, blockers: ["invalid_context"] },
          epoch: observation.epoch,
        };
      }

      // 防御性快照：调用方查询后原地修改输入数组不得影响已完成查询。
      const rooms = Object.freeze([...(context.rooms ?? observation.roomNames())]);
      const kinds = Object.freeze([...(context.locations ?? DEFAULT_LOCATION_KINDS)]);
      const allowProjected = context.allowProjected !== false;

      let observed = 0;
      for (const roomName of rooms) {
        for (const kind of kinds) {
          observed += observation.amount(roomName, kind, context.resource);
        }
      }

      let projected = observed;
      if (allowProjected) {
        for (const roomName of rooms) {
          for (const kind of kinds) {
            projected += projection.projectedDelta(roomName, kind, context.resource);
          }
        }
      }

      const resolveHolder = deps.resolveHolder ?? resolveTreasuryHolder;
      const ownerCheck = resolveOwnerStatus(context.owner, resolveHolder);
      const ownerStatus: TreasuryOwnerStatus = !context.owner
        ? "none"
        : ownerCheck.valid
          ? "excluded-own-reservations"
          : "invalid_fail_closed";

      const commitments = this.commitments();
      let committed = 0;
      if (context.subtractOutgoing !== false) {
        for (const roomName of rooms) {
          committed += commitments.pendingOutgoing(roomName, context.resource);
        }
      }
      if (context.subtractReservations !== false) {
        for (const roomName of rooms) {
          // owner 自排除只发生在其合法归属房间；其他房间照常扣除全部预留。
          // 排除使用完整 typed identity 比较（同字符串不同 kind 不互相排除）。
          const excludeOwner =
            ownerCheck.valid && ownerCheck.ownerIdentity && roomName === ownerCheck.ownerRoom
              ? ownerCheck.ownerIdentity
              : undefined;
          committed += commitments.reservedProduction(roomName, context.resource, excludeOwner);
        }
        // durable quarantine + unresolved intent 占用（第六/八轮）：Game 结果
        // 未知/未关闭 transaction 的流出量计入 committed（保守——可能已执行；
        // 不进 projection；双口径统一为 per-transaction 正占用 Σmax(0,−net)，
        // 跨 transaction 不抵消）。
        const quarantineOutflows = treasuryQuarantineOutflowTotals();
        const intentOutflows = treasuryIntentOutflowOccupancy();
        if (quarantineOutflows.size > 0 || intentOutflows.size > 0) {
          for (const roomName of rooms) {
            for (const kind of kinds) {
              const resourceKey = `${roomName}\u0000${kind}\u0000${context.resource}`;
              const occupied =
                (quarantineOutflows.get(resourceKey) ?? 0) + (intentOutflows.get(resourceKey) ?? 0);
              if (occupied > 0) committed += occupied;
            }
          }
        }
      }

      const incoming = context.allowIncoming
        ? rooms.reduce((sum, roomName) => sum + commitments.incoming(roomName, context.resource), 0)
        : 0;

      // 承诺视图 completeness：查询覆盖的任一 scope incomplete（或全局
      // incomplete）→ 不可授权（spendable=0、overcommitted=true）。
      let commitmentStatus: TreasuryCommitmentCompleteness = "complete";
      if (commitments.completeness.globalIncomplete) {
        commitmentStatus = "globally-incomplete";
      } else {
        for (const roomName of rooms) {
          if (commitments.commitmentCompleteness(roomName, context.resource) !== "complete") {
            commitmentStatus = "incomplete-scope";
            break;
          }
        }
      }
      const commitmentComplete = commitmentStatus === "complete";

      const base = (allowProjected ? projected : observed) + incoming;
      const withhold = Math.max(0, context.withhold ?? 0);
      // fail closed：owner 非法或承诺视图不完整时不给乐观可用量。
      const authorizable = ownerCheck.valid && commitmentComplete;
      const rawSpendable = authorizable ? base - committed - withhold : 0;

      // authorizationSafe 联合判定（第六轮）+ write admission readiness（第七轮，
      // 与余额完整分立）：authorizationSafe 表达"余额视图是否可信可授权"，
      // writeAdmission 表达"当前是否确实允许开始新的 Game write"（额外含
      // receipt 容量/quarantine slot/reservation store 损坏等准入条件）。
      // 数值字段在两类阻断下均保留（不以归零掩盖原因）；prepare 对各条件
      // 独立复查，绝不只信调用方读过 readiness。
      const writeFaultHealth = peekTreasuryWriteFaultHealth();
      const quarantineHealthForAuth = peekTreasuryQuarantineHealth();
      const quarantineBlock = treasuryQuarantineBlockers();
      const intentHealthForAuth = peekTreasuryIntentHealth();
      const intentBlock = treasuryIntentBlockers();
      const blockers: string[] = [];
      if (!ownerCheck.valid && context.owner) blockers.push("invalid_owner");
      if (!commitmentComplete) blockers.push("commitment_incomplete");
      if (isTreasuryWriteAdmissionLocked() || !writeFaultHealth.healthy) blockers.push("write_fault");
      if (!quarantineHealthForAuth.healthy) blockers.push("quarantine_unhealthy");
      else if (quarantineBlock.blocking) blockers.push("quarantine_unresolved");
      if (!intentHealthForAuth.healthy) blockers.push("intent_unhealthy");
      else if (intentBlock.blocking) blockers.push("intent_unresolved");
      const receiptHealth = peekTreasuryReceiptHealth();
      if (!receiptHealth.healthy) blockers.push("receipt_unhealthy");
      if (state.ended) blockers.push("lifecycle_closed");
      if (state.tick !== Game.time) blockers.push("stale_tick_state");
      if (!isReservationOwnerMigrationComplete()) blockers.push("reservation_migration_incomplete");
      const reservationHealth = validateReservationStoreHealth();
      if (!reservationHealth.healthy) blockers.push("reservation_store_unhealthy");
      const authorizationSafe = authorizable && blockers.length === 0;

      // write readiness 的额外准入条件（超出 authorizationSafe）：
      // receipt 容量、统一 recovery slot、reservation store 损坏标志。
      const receiptCounters = readTreasuryReceiptEventCounters();
      const writeAdmissionBlockers: string[] = [...blockers];
      if (receiptCounters.slotsRemaining <= 0) writeAdmissionBlockers.push("receipt_capacity_exhausted");
      if (
        !quarantineHealthForAuth.healthy ||
        !intentHealthForAuth.healthy ||
        recoverySlotsOccupied() >= TREASURY_QUARANTINE_MAX_ENTRIES
      ) {
        writeAdmissionBlockers.push("quarantine_slot_exhausted");
      }
      if (isReservationStoreCorrupted()) writeAdmissionBlockers.push("reservation_store_corrupted");

      return {
        resource: context.resource,
        observed,
        projected,
        committed,
        incoming,
        spendable: authorizable ? Math.max(0, rawSpendable) : 0,
        overcommitted: !authorizable || rawSpendable < 0,
        ownerStatus,
        contextStatus: "valid",
        commitmentStatus,
        authorizationSafe,
        authorizationBlockers: Object.freeze(blockers),
        writeAdmission: {
          ready: writeAdmissionBlockers.length === 0,
          blockers: Object.freeze(writeAdmissionBlockers),
        },
        epoch: observation.epoch,
      };
    },

    // ── 资源授权（第八轮） ────────────────────────────────────────────────
    //
    // authorization ledger：授权成功即占用预算（按 (room,location,resource)
    // 记流出预留、capacityRequirement 记容量预留）——防止 A/B 双授权后各自
    // prepare 超卖同一批资源；token 消费时预算释放（转由 prepare 的
    // tentative 接管，互换不双算）。revision 变化时全部既有授权失效，预算
    // 懒检测一并释放（授权消费侧按 token 绑定的 revision 快照拒绝）。
    authorizeResourceUse(request: TreasuryAuthorizationRequest): TreasuryAuthorizationResult {
      const state = ensureTickState(true);
      const observation = state.observation;
      const governedRooms = new Set(observation.roomNames());
      const shapeError = validateTreasuryAuthorizationRequest(request, governedRooms);
      if (shapeError !== null) {
        metrics.authorizationRejected += 1;
        return { status: "rejected", reason: "invalid_input", detail: shapeError };
      }
      const policyError = validateTreasuryAuthorizationPolicy(request);
      if (policyError !== null) {
        metrics.authorizationRejected += 1;
        return { status: "rejected", reason: "authorization_policy_violation", detail: policyError };
      }
      // revision ledger 维护：任一相关 revision 变化 → 既有授权全部失效，
      // 预算一并释放（不阻塞资源）。
      const revisions = currentAuthorizationRevisions();
      if (
        authorizationLedgerRevisions === null ||
        authorizationLedgerRevisions.commitmentRevision !== revisions.commitmentRevision ||
        authorizationLedgerRevisions.projectionRevision !== revisions.projectionRevision ||
        authorizationLedgerRevisions.quarantineRevision !== revisions.quarantineRevision ||
        authorizationLedgerRevisions.intentRevision !== revisions.intentRevision ||
        authorizationLedgerRevisions.reservationStoreRevision !== revisions.reservationStoreRevision
      ) {
        if (authorizationRecords.size > 0) {
          metrics.authorizationInvalidated += authorizationRecords.size;
        }
        authorizationRecords.clear();
        authorizationOutflowTotals.clear();
        authorizationCapacityTotals.clear();
        authorizationLedgerRevisions = revisions;
      }
      // 活跃授权上限（heap 有界）。
      if (authorizationRecords.size >= TREASURY_AUTHORIZATION_ACTIVE_LIMIT) {
        metrics.authorizationRejected += 1;
        return {
          status: "rejected",
          reason: "authorization_capacity_exhausted",
          detail: `活跃授权已达上限 ${String(TREASURY_AUTHORIZATION_ACTIVE_LIMIT)}（先消费或等待 revision 失效）`,
        };
      }
      // 授权上下文安全：复用 query 全链（completeness/quarantine/intent/
      // receipt/fault/lifecycle/migration/store corrupted 全条件），owner
      // 映射为 TreasuryQueryOwner（kind 限 game-object/logical-service）。
      const locations = request.locations ?? DEFAULT_LOCATION_KINDS;
      const queryOwner =
        request.owner !== undefined
          ? {
              ownerKind: request.owner.kind as "game-object" | "logical-service",
              ownerId: request.owner.id,
              ...(request.owner.namespace !== undefined ? { namespace: request.owner.namespace } : {}),
              scope: "production-reservation" as const,
              roomName: request.owner.roomName ?? request.rooms[0],
            }
          : undefined;
      const view = this.query({
        resource: request.resource,
        rooms: [...request.rooms],
        locations: [...locations],
        ...(request.withhold !== undefined ? { withhold: request.withhold } : {}),
        ...(queryOwner !== undefined ? { owner: queryOwner } : {}),
        allowProjected: request.allowProjected !== false,
        allowIncoming: false,
        subtractOutgoing: true,
        subtractReservations: true,
      });
      if (view.contextStatus !== "valid") {
        metrics.authorizationRejected += 1;
        return {
          status: "rejected",
          reason: "authorization_context_unsafe",
          detail: "授权上下文非法（invalid_fail_closed）",
        };
      }
      if (!view.authorizationSafe) {
        metrics.authorizationRejected += 1;
        return {
          status: "rejected",
          reason: "authorization_context_unsafe",
          detail: `authorizationSafe=false（blockers: ${view.authorizationBlockers.join(",")}）——不得在上下文不安全时授权`,
        };
      }
      // 授权计算：spendable（已净 committed——含 outgoing/reservations/
      // quarantine/intent/withhold）再减其它未消费授权的预算占用。
      // 多房间/多位置 scope 逐 key 全额保守占用（amount 可能从任一 key 流出）。
      let budgetedOutflow = 0;
      for (const roomName of request.rooms) {
        for (const kind of locations) {
          budgetedOutflow += authorizationOutflowTotals.get(`${roomName}\u0000${kind}\u0000${request.resource}`) ?? 0;
        }
      }
      const available = view.spendable - budgetedOutflow;
      if (!Number.isSafeInteger(available) || available < request.amount) {
        metrics.authorizationRejected += 1;
        return {
          status: "rejected",
          reason: "insufficient_amount",
          detail: `可用 ${String(available)}（spendable ${String(view.spendable)} − 其它授权占用 ${String(budgetedOutflow)}）< 申请 ${String(request.amount)}`,
        };
      }
      // 容量需求（可选）：risk-adjusted free 口径（含 quarantine/intent 占用）。
      if (request.capacityRequirement !== undefined) {
        const cap = request.capacityRequirement;
        const capKey = `${cap.roomName}\u0000${cap.locationKind}`;
        const budgetedCapacity = authorizationCapacityTotals.get(capKey) ?? 0;
        const riskAdjustedFree = this.projectedFreeCapacity(cap.roomName, cap.locationKind) - budgetedCapacity;
        if (!Number.isSafeInteger(riskAdjustedFree) || riskAdjustedFree < cap.amount) {
          metrics.authorizationRejected += 1;
          return {
            status: "rejected",
            reason: "capacity_overflow",
            detail: `risk-adjusted free ${String(riskAdjustedFree)}（含其它授权容量占用 ${String(budgetedCapacity)}）< 需求 ${String(cap.amount)}（${capKey}）`,
          };
        }
      }
      // 签发 opaque token（冻结 + 私有 registry 对象身份）并占用预算。
      const token: TreasuryAuthorizationToken = Object.freeze({
        __brand: "treasury-authorization-token",
        transactionId: request.transactionId,
        actionKind: request.actionKind,
        resource: request.resource,
        rooms: Object.freeze([...request.rooms]),
        locations: Object.freeze([...locations]),
        amount: request.amount,
        epoch: {
          scope: observation.epoch.scope,
          epochSeq: observation.epoch.epochSeq,
          observedAtTick: observation.epoch.observedAtTick,
        },
        revisions,
        policyFingerprint: canonicalTreasuryPolicyFingerprint(request),
        ownerKey: treasuryAuthorizationOwnerKey(request.owner),
        serviceGeneration,
        ...(request.contractDigest !== undefined ? { contractDigest: request.contractDigest } : {}),
        ...(request.adapterVersion !== undefined ? { adapterVersion: request.adapterVersion } : {}),
        tick: Game.time,
      });
      authorizationRegistry.add(token);
      const outflowKeys: string[] = [];
      for (const roomName of request.rooms) {
        for (const kind of locations) {
          const key = `${roomName}\u0000${kind}\u0000${request.resource}`;
          outflowKeys.push(key);
          authorizationOutflowTotals.set(key, (authorizationOutflowTotals.get(key) ?? 0) + request.amount);
        }
      }
      let capacityKey: string | undefined;
      if (request.capacityRequirement !== undefined) {
        capacityKey = `${request.capacityRequirement.roomName}\u0000${request.capacityRequirement.locationKind}`;
        authorizationCapacityTotals.set(
          capacityKey,
          (authorizationCapacityTotals.get(capacityKey) ?? 0) + request.capacityRequirement.amount,
        );
      }
      authorizationRecords.set(token, {
        outflowKeys,
        amount: request.amount,
        ...(capacityKey !== undefined ? { capacityKey } : {}),
        ...(request.capacityRequirement !== undefined ? { capacityAmount: request.capacityRequirement.amount } : {}),
        consumed: false,
      });
      metrics.authorizationIssued += 1;
      return { status: "authorized", token };
    },

    consumeTreasuryAuthorization(
      token: TreasuryAuthorizationToken,
      options?: {
        transactionId?: string;
        postings?: readonly TreasuryPosting[];
      },
    ): TreasuryAuthorizationConsumeResult {
      if (!token || typeof token !== "object" || !authorizationRegistry.has(token)) {
        return { status: "rejected", reason: "invalid_token", detail: "token 未在本服务实例签发（伪造对象/JSON 副本/跨实例一律无效）" };
      }
      const record = authorizationRecords.get(token);
      if (record === undefined) {
        return { status: "rejected", reason: "already_consumed", detail: "token 已消费或已随 revision 失效释放" };
      }
      if (token.serviceGeneration !== serviceGeneration) {
        return { status: "rejected", reason: "cross_generation", detail: "token 签发的 service generation 已失效" };
      }
      if (token.tick !== Game.time) {
        return { status: "rejected", reason: "cross_tick", detail: `token 于 tick ${String(token.tick)} 签发（当前 ${String(Game.time)}）——跨 tick 失效` };
      }
      const revisions = currentAuthorizationRevisions();
      if (
        token.revisions.commitmentRevision !== revisions.commitmentRevision ||
        token.revisions.projectionRevision !== revisions.projectionRevision ||
        token.revisions.quarantineRevision !== revisions.quarantineRevision ||
        token.revisions.intentRevision !== revisions.intentRevision ||
        token.revisions.reservationStoreRevision !== revisions.reservationStoreRevision
      ) {
        metrics.authorizationInvalidated += 1;
        metrics.authorizationRevisionMismatches += 1;
        // revision 变化即失效：释放该 token 预算。
        releaseAuthorizationBudget(token, record);
        return {
          status: "rejected",
          reason: "revision_mismatch",
          detail: "token 绑定的 revision 快照已过期（commitment/projection/quarantine/intent/reservation store 任一变化）",
        };
      }
      if (options?.transactionId !== undefined && options.transactionId !== token.transactionId) {
        return {
          status: "rejected",
          reason: "transaction_mismatch",
          detail: `token 绑定 transactionId ${token.transactionId}，请求 ${options.transactionId}`,
        };
      }
      if (options?.postings !== undefined) {
        const scopeError = postingsWithinAuthorizationScope(token, options.postings);
        if (scopeError !== null) {
          return { status: "rejected", reason: "scope_violation", detail: scopeError };
        }
      }
      releaseAuthorizationBudget(token, record);
      return { status: "ok" };
    },

    /**
     * Contract-first 授权（第九轮 4.1，生产唯一授权入口）：全部授权需求从
     * contract 的 canonical postings 与 adapter 元数据派生；原子签发 bundle
     * （任一资源失败 → 已签发 token 预算全部回滚）；前置 write admission
     * ready（write-fault lock + quarantine/intent blockers）。
     */
    authorizeTreasuryActionContract(
      contract: unknown,
      options?: TreasuryContractAuthorizationOptions,
    ): { readonly status: "authorized"; readonly bundle: TreasuryAuthorizationBundle } | {
      readonly status: "rejected";
      readonly reason: "invalid_input" | "contract_invalid" | "adapter_not_registered" | "write_admission_blocked" | "authorization_policy_violation" | "authorization_context_unsafe" | "insufficient_amount" | "capacity_overflow" | "authorization_capacity_exhausted";
      readonly detail: string;
    } {
      if (options !== undefined && (!options || typeof options !== "object")) {
        metrics.authorizationRejected += 1;
        return { status: "rejected", reason: "invalid_input", detail: "授权 options 非法" };
      }
      const verified = verifyTreasuryActionContractForAuthorization(contract);
      if (verified.status === "rejected") {
        metrics.authorizationRejected += 1;
        return { status: "rejected", reason: verified.reason, detail: verified.detail };
      }
      const verifiedContract = verified.contract;
      // write admission ready（比 authorizationSafe 更强的前置：write-fault
      // lock + quarantine/intent 全局 blocker + store 健康——不满足时授权
      // 本身拒绝，不留"已授权但 writer 阻断"的空转 token）。
      ensureTickState(true);
      if (isTreasuryWriteAdmissionLocked()) {
        metrics.authorizationRejected += 1;
        return { status: "rejected", reason: "write_admission_blocked", detail: "存在 unresolved write-fault marker（显式 resolution 前禁止新授权）" };
      }
      const quarantineBlock = treasuryQuarantineBlockers();
      if (quarantineBlock.blocking) {
        metrics.authorizationRejected += 1;
        return {
          status: "rejected",
          reason: "write_admission_blocked",
          detail: `quarantine write blocker（${String(quarantineBlock.unresolvedCount)} 条 unresolved）——禁止新授权`,
        };
      }
      const intentBlock = treasuryIntentBlockers();
      if (intentBlock.blocking) {
        metrics.authorizationRejected += 1;
        return {
          status: "rejected",
          reason: "write_admission_blocked",
          detail: `intent write blocker（${String(intentBlock.unresolvedCount)} 条未完成 durable intent）——禁止新授权`,
        };
      }
      // 授权需求派生：每种负 posting 资源一个 token——amount = Σ|负 delta|、
      // rooms/locations = 该资源负腿的实际位置集合（不得超出 contract 事实）。
      const resourceOutflow = new Map<string, { amount: number; rooms: Set<string>; locations: Set<TreasuryLocationKind> }>();
      for (const posting of verifiedContract.postings) {
        if (posting.delta >= 0) continue;
        const entry = resourceOutflow.get(posting.resource) ?? { amount: 0, rooms: new Set<string>(), locations: new Set<TreasuryLocationKind>() };
        const summed = entry.amount + (-posting.delta);
        if (!Number.isSafeInteger(summed)) {
          metrics.authorizationRejected += 1;
          return { status: "rejected", reason: "invalid_input", detail: `资源 ${posting.resource} 的授权流出聚合溢出安全整数` };
        }
        entry.amount = summed;
        entry.rooms.add(posting.roomName);
        entry.locations.add(posting.locationKind as TreasuryLocationKind);
        resourceOutflow.set(posting.resource, entry);
      }
      if (resourceOutflow.size === 0) {
        metrics.authorizationRejected += 1;
        return { status: "rejected", reason: "contract_invalid", detail: "contract 无负 posting（无资源流出即无授权需求）——拒绝授权" };
      }
      // 原子签发：逐资源授权；任一失败回滚已签发 token 的全部预算。
      const issued: TreasuryAuthorizationToken[] = [];
      const rollbackIssued = (): void => {
        for (const token of issued) {
          const record = authorizationRecords.get(token);
          if (record !== undefined) releaseAuthorizationBudget(token, record);
        }
      };
      for (const [resource, need] of resourceOutflow) {
        const result = this.authorizeResourceUse({
          transactionId: verifiedContract.transactionId,
          actionKind: verifiedContract.actionKind,
          resource,
          rooms: [...need.rooms],
          locations: [...need.locations],
          amount: need.amount,
          contractDigest: verifiedContract.digest,
          adapterVersion: verifiedContract.adapterVersion,
          ...(options?.owner !== undefined ? { owner: options.owner } : {}),
          ...(options?.withhold !== undefined ? { withhold: options.withhold } : {}),
          ...(options?.allowProjected !== undefined ? { allowProjected: options.allowProjected } : {}),
          ...(options?.capacityRequirement !== undefined ? { capacityRequirement: options.capacityRequirement } : {}),
        });
        if (result.status !== "authorized") {
          rollbackIssued();
          metrics.authorizationRejected += 1;
          return { status: "rejected", reason: result.reason, detail: `资源 ${resource} 授权失败: ${result.detail}` };
        }
        issued.push(result.token);
      }
      const bundle: TreasuryAuthorizationBundle = Object.freeze({
        __brand: "treasury-authorization-bundle",
        tokens: Object.freeze(issued),
        contractId: verifiedContract.contractId,
        contractDigest: verifiedContract.digest,
        transactionId: verifiedContract.transactionId,
        actionKind: verifiedContract.actionKind,
        adapterVersion: verifiedContract.adapterVersion,
      });
      metrics.authorizationIssued += 1;
      return { status: "authorized", bundle };
    },

    /**
     * 授权 bundle/token 只读预验证（第九轮 4.2，@internal）：全部 token 一次
     * 性校验（身份/generation/tick/revisions/transactionId/重复/覆盖/
     * contract 匹配）——零状态变化、零消费。原子消费的可达性基础：预验证
     * 与消费在同一同步窗口，中间无 revision 变化源。
     */
    validateTreasuryAuthorizationForRedeem(
      tokens: readonly TreasuryAuthorizationToken[],
      contract: { readonly transactionId: string; readonly actionKind: string; readonly digest: string; readonly adapterVersion: number },
      postings: readonly TreasuryPosting[],
    ): { readonly status: "ok" } | { readonly status: "rejected"; readonly reason: string; readonly detail: string } {
      if (!Array.isArray(tokens) || tokens.length === 0) {
        return { status: "rejected", reason: "authorization_invalid", detail: "redemption 预验证须携带非空 token 集合" };
      }
      const seen = new Set<TreasuryAuthorizationToken>();
      for (const token of tokens) {
        if (!token || typeof token !== "object" || !authorizationRegistry.has(token)) {
          return { status: "rejected", reason: "invalid_token", detail: "token 未在本服务实例签发（伪造对象/JSON 副本/跨实例一律无效）" };
        }
        if (seen.has(token)) {
          return { status: "rejected", reason: "invalid_token", detail: "bundle 内出现重复 token（对象身份重复——拒绝）" };
        }
        seen.add(token);
        const record = authorizationRecords.get(token);
        if (record === undefined) {
          return { status: "rejected", reason: "already_consumed", detail: "token 已消费或已随 revision 失效释放" };
        }
        if (token.serviceGeneration !== serviceGeneration) {
          return { status: "rejected", reason: "cross_generation", detail: "token 签发的 service generation 已失效" };
        }
        if (token.tick !== Game.time) {
          return { status: "rejected", reason: "cross_tick", detail: `token 于 tick ${String(token.tick)} 签发（当前 ${String(Game.time)}）——跨 tick 失效` };
        }
        const revisions = currentAuthorizationRevisions();
        if (
          token.revisions.commitmentRevision !== revisions.commitmentRevision ||
          token.revisions.projectionRevision !== revisions.projectionRevision ||
          token.revisions.quarantineRevision !== revisions.quarantineRevision ||
          token.revisions.intentRevision !== revisions.intentRevision ||
          token.revisions.reservationStoreRevision !== revisions.reservationStoreRevision
        ) {
          return { status: "rejected", reason: "revision_mismatch", detail: "token 绑定的 revision 快照已过期（commitment/projection/quarantine/intent/reservation store 任一变化）" };
        }
        // contract 绑定匹配（digest 必有——contract-first token 恒绑定）。
        if (token.transactionId !== contract.transactionId) {
          return { status: "rejected", reason: "transaction_mismatch", detail: `token 绑定 transactionId ${token.transactionId}，contract ${contract.transactionId}` };
        }
        if (token.actionKind !== contract.actionKind) {
          return { status: "rejected", reason: "invalid_token", detail: `token 绑定 actionKind ${token.actionKind}，contract ${contract.actionKind}` };
        }
        if (token.contractDigest !== contract.digest) {
          return { status: "rejected", reason: "invalid_token", detail: "token 绑定的 contract digest 与实际 contract 不一致" };
        }
        if (token.adapterVersion !== contract.adapterVersion) {
          return { status: "rejected", reason: "invalid_token", detail: `token 绑定 adapter version ${String(token.adapterVersion)}，contract ${String(contract.adapterVersion)}` };
        }
        const scopeError = postingsWithinAuthorizationScope(token, postings);
        if (scopeError !== null) {
          return { status: "rejected", reason: "scope_violation", detail: scopeError };
        }
      }
      // 联合覆盖：每个负 posting 必须被至少一个 token 覆盖（resource+room+
      // location 精确匹配——不能只按"同资源存在一个 token"判断）。
      for (const posting of postings) {
        if (posting.delta >= 0) continue;
        const covered = tokens.some(
          (token) => token.resource === posting.resource && token.rooms.includes(posting.roomName) && token.locations.includes(posting.locationKind),
        );
        if (!covered) {
          return {
            status: "rejected",
            reason: "scope_violation",
            detail: `posting ${posting.roomName}:${posting.locationKind}:${posting.resource} 的流出未被任何 token 覆盖`,
          };
        }
      }
      return { status: "ok" };
    },

    prepareTransaction(input: TreasuryTransactionInput): TreasuryPreparationResult {
      // runtime input 形状验证（canonicalization 前置）：malformed input 结构化
      // 拒绝（invalid_input）而非抛出中断 tick——零 tentative/零槽位/零 registry。
      const inputShapeError = validateTreasuryTransactionInputShape(input);
      if (inputShapeError !== null) {
        metrics.transactionsRejectedInvalid += 1;
        return { status: "rejected", reason: "invalid_input", detail: inputShapeError };
      }
      const state = ensureTickState(true);
      // 幂等优先：已结算 id 的重放（含重复 prepare 已 commit 的 id）。统一
      // replay horizon（第八轮 8.3）：receipt 过期但 committed resolution
      // tombstone 仍在窗口内（settledAtTick+retention，与 receipt 同一常量）
      // 时同样视为已结算——prepare/receipt/resolution 不得各自使用不同规则。
      const settledAt = projection.isSettled(input.transactionId) ?? committedResolutionSettledAtTick(input.transactionId);
      if (settledAt !== undefined) {
        metrics.duplicateSettlementsRejected += 1;
        return { status: "already_settled", transactionId: input.transactionId, firstRecordedAtTick: settledAt };
      }
      // durable quarantine 门禁：Game 结果未知/commit 故障未对账的 transaction
      // 跨 tick 占用 identity——显式 resolution 解除前不得再次 prepare/执行。
      if (isTreasuryTransactionQuarantined(input.transactionId)) {
        metrics.transactionsRejectedInvalid += 1;
        return {
          status: "rejected",
          reason: "transaction_quarantined",
          detail: "transaction 处于 durable quarantine（显式 fault resolution 解除前禁止重新 prepare/执行）",
        };
      }
      // 全局 quarantine write blocker（第七轮）：存在任何 unresolved quarantine
      // 或 store 损坏时，一切新 transaction 在 Game callback 之前拒绝——
      // write-fault marker 不是唯一锁来源（marker 已解决但仍有其它 quarantine
      // 时本检查继续阻断）。已结算幂等（上文）与同 id quarantine（上文）优先。
      const quarantineHealth = peekTreasuryQuarantineHealth();
      if (!quarantineHealth.healthy) {
        metrics.transactionsRejectedInvalid += 1;
        return {
          status: "rejected",
          reason: "quarantine_store_fatal",
          detail: quarantineHealth.detail ?? "quarantine store 损坏（fail closed，显式 repair 前阻断一切新 prepare）",
        };
      }
      const quarantineBlock = treasuryQuarantineBlockers();
      if (quarantineBlock.blocking) {
        metrics.quarantineAdmissionRejections += 1;
        return {
          status: "rejected",
          reason: "quarantine_write_blocked",
          detail: `存在 ${String(quarantineBlock.unresolvedCount)} 条 unresolved quarantine${quarantineBlock.overflowed ? "（含 legacy overflowed）" : ""}——全部解决前阻断新 prepare（callback 零调用）`,
        };
      }
      // durable intent 全局 write blocker（第八轮）：存在任何未完成 intent
      //（Game API 途中/未关闭/等待恢复）或 intent store 损坏时，一切新
      // transaction 在 Game callback 之前拒绝——未完成动作的身份与 postings
      // 必须先经恢复/隔离流程处置。
      const intentHealth = peekTreasuryIntentHealth();
      if (!intentHealth.healthy) {
        metrics.transactionsRejectedInvalid += 1;
        return {
          status: "rejected",
          reason: "intent_store_fatal",
          detail: intentHealth.detail ?? "intent store 损坏（fail closed，显式 repair 前阻断一切新 prepare）",
        };
      }
      const intentBlock = treasuryIntentBlockers();
      if (intentBlock.blocking) {
        metrics.transactionsRejectedInvalid += 1;
        return {
          status: "rejected",
          reason: "intent_write_blocked",
          detail: `存在 ${String(intentBlock.unresolvedCount)} 条未完成 durable intent——恢复（ready 关闭/转 quarantine/resolution）完成前阻断新 prepare（callback 零调用）`,
        };
      }
      // 相同 transactionId 的重复 prepare：canonical payload digest 比较——
      // digest 相同幂等返回同一 handle；不同则 prepare_conflict（同一 id 只
      // 能绑定一个 canonical payload，绝不能"ID 相同就无条件返回 prepared"）。
      const canonical = buildTreasuryCanonicalTransaction(input);
      const digest = computeTreasuryPayloadDigest(canonical);
      metrics.digestGenerations += 1;
      const existingPrepare = preparedById.get(input.transactionId);
      if (existingPrepare) {
        if (existingPrepare.digest !== digest) {
          metrics.prepareConflicts += 1;
          return {
            status: "rejected",
            reason: "prepare_conflict",
            detail: `transactionId 已绑定不同 canonical payload（既有 digest ${existingPrepare.digest}，新 digest ${digest}）`,
          };
        }
        // 幂等返回同一 handle 只允许 prepared 状态；executing/committing/
        // faulted 的既有记录不得再发 handle——否则 executePreparedAction 会
        // 对同一 transaction 再次调用 Game callback（协议违规：faulted 的
        // Game 结果未对账，重复执行绝不安全）。
        if (existingPrepare.state === "faulted") {
          metrics.transactionsRejectedInvalid += 1;
          return {
            status: "rejected",
            reason: "handle_faulted",
            detail: "同 id transaction 已 faulted（Game 结果未对账/显式 resolution 前，禁止重新执行）",
          };
        }
        if (existingPrepare.state === "executing" || existingPrepare.state === "committing") {
          metrics.transactionsRejectedInvalid += 1;
          return {
            status: "rejected",
            reason: "invalid_handle",
            detail: `同 id transaction 处于 ${existingPrepare.state} 状态（不可重入）`,
          };
        }
        return {
          status: "prepared",
          handle: existingPrepare.handle,
          transactionId: input.transactionId,
          preparedAtTick: existingPrepare.preparedAtTick,
          digest,
        };
      }
      if (state.ended) {
        metrics.settlementsAfterEndRejected += 1;
        return { status: "rejected", reason: "tick_closed", detail: `tick ${Game.time} 已 endTick` };
      }
      // write admission 全局锁：unresolved write fault 期间阻断新 prepare。
      if (isTreasuryWriteAdmissionLocked()) {
        metrics.transactionsRejectedInvalid += 1;
        return {
          status: "rejected",
          reason: "write_admission_locked",
          detail: "存在 unresolved write fault（显式修复路径解除前阻断全部 writer）",
        };
      }
      const decision = resolveDecisionEpoch(input.decision);
      if ("rejection" in decision) {
        return { status: "rejected", reason: decision.rejection.reason, detail: decision.rejection.detail };
      }
      // 完整验证（格式/合并/tentative 感知物理可行性）在占用任何槽位之前
      // ——无效输入不得预留；新 prepare 的授权计算计入全部既有 tentative。
      const validation = projection.validateTransaction(input, decision.registered.observation);
      if (validation.status === "invalid") {
        metrics.transactionsRejectedInvalid += 1;
        return { status: "rejected", reason: validation.result.reason, detail: validation.result.detail };
      }
      // 统一 recovery slot admission（第八轮 3.5 重构，O(1)）：prepare 成功的
      // 前置条件 = 最坏情况下仍有空间承载该 transaction 的隔离/恢复记录——
      // 持久 quarantine + 持久 intent + 无 intent 的 active handle 总数 < MAX
      //（一笔 transaction 恒占一个 slot；durable intent 接管 prepare 预留、
      // fault 转换为 quarantine entry，绝不双重计数）。满则在 Game callback
      // 之前拒绝（第 65 条 fault 在 prepare 前被阻止）。先于 receipt admission
      //（同容量约束下 reason 指向隔离/恢复语义）。
      const quarantineSlotHealth = peekTreasuryQuarantineHealth();
      const slotsOccupied = recoverySlotsOccupied();
      if (!quarantineSlotHealth.healthy || !intentHealth.healthy || slotsOccupied >= TREASURY_QUARANTINE_MAX_ENTRIES) {
        metrics.quarantineAdmissionRejections += 1;
        return {
          status: "rejected",
          reason: "quarantine_capacity_exhausted",
          detail: `recovery slot 已满（quarantine ${String(quarantineSlotHealth.entryCount)} + intent ${String(intentHealth.entryCount)} + active ${String(activeHandles.size - intentBackedActiveIds.size)} ≥ ${String(TREASURY_QUARANTINE_MAX_ENTRIES)}；释放或解决既有占用后恢复）`,
        };
      }
      // admission 预留：成功即占一个容量槽（commit 兑现不再因容量被拒）。
      const reservation = reserveTreasuryReceiptAdmission(input.transactionId, Game.time);
      if (reservation.status === "already_settled") {
        metrics.duplicateSettlementsRejected += 1;
        return {
          status: "already_settled",
          transactionId: input.transactionId,
          firstRecordedAtTick: reservation.firstSettledAtTick,
        };
      }
      if (reservation.status === "rejected") {
        metrics.transactionsRejectedInvalid += 1;
        if (reservation.reason === "receipt_capacity_exhausted") metrics.receiptCapacityRejections += 1;
        return { status: "rejected", reason: reservation.reason, detail: reservation.detail };
      }
      // 签发不可伪造 handle（冻结对象 + 私有 registry 对象身份注册）并
      // 登记 tentative 资源/容量预留。
      const handle: TreasuryPreparedHandle = Object.freeze({
        __brand: "treasury-prepared-handle",
        transactionId: input.transactionId,
        digest,
      });
      const record: PreparedTransaction = {
        handle,
        canonical,
        digest,
        observation: decision.registered.observation,
        shape: validation.shape,
        tentativeKey: `prepare:${input.transactionId}`,
        preparedAtTick: Game.time,
        generation: serviceGeneration,
        state: "prepared",
      };
      handleRegistry.add(handle);
      handleRecords.set(handle, record);
      activeHandles.set(handle, record);
      preparedById.set(input.transactionId, record);
      projection.tentativeHold(record.tentativeKey, validation.shape);
      metrics.transactionsPrepared += 1;
      return {
        status: "prepared",
        handle,
        transactionId: input.transactionId,
        preparedAtTick: record.preparedAtTick,
        digest,
      };
    },

    commitPreparedTransaction(handle: TreasuryPreparedHandle): TreasuryPreparedCommitResult {
      // handle 自行验证（不依赖调用方先 beginTick）：对象身份 → generation
      // → 状态机 → 签发 tick（跨 tick 一律 expired）。终态 handle 从 WeakMap
      // 取轻量 stub（引用仍存在时返回稳定幂等结果，不形成全局强引用）。
      const invalid = (detail: string): TreasuryPreparedCommitResult => {
        metrics.invalidHandleRejections += 1;
        return { status: "rejected", reason: "invalid_handle", detail };
      };
      if (!handle || typeof handle !== "object" || !handleRegistry.has(handle)) {
        return invalid("handle 未在本服务实例签发（伪造对象/JSON 副本/跨实例 handle 一律无效）");
      }
      const record = handleRecords.get(handle);
      if (!record || record.generation !== serviceGeneration) {
        return invalid("handle 代际不匹配");
      }
      if (record.state === "expired" || record.preparedAtTick !== Game.time) {
        return {
          status: "rejected",
          reason: "handle_expired",
          detail: `handle 于 tick ${String(record.preparedAtTick)} 签发，当前 tick ${String(Game.time)}（tick 边界作废）`,
        };
      }
      if (record.state === "committed") {
        const recordTransactionId = isTerminalRecord(record) ? record.transactionId : record.canonical.transactionId;
        const settledAt = projection.isSettled(recordTransactionId);
        return settledAt !== undefined
          ? { status: "already_settled", transactionId: recordTransactionId, firstRecordedAtTick: settledAt }
          : invalid("handle 已 committed 但 receipt 缺失（内部不一致）");
      }
      if (record.state === "aborted") {
        return { status: "rejected", reason: "handle_finalized", detail: "handle 已 aborted，不可 commit" };
      }
      if (record.state === "faulted") {
        return { status: "rejected", reason: "handle_faulted", detail: "handle 所在 commit 发生意外的内部写故障" };
      }
      if (record.state === "committing") {
        return invalid("handle 处于 committing 状态，不可重入");
      }
      if (isTerminalRecord(record)) {
        return invalid("handle 记录处于不可用终态（内部不一致）");
      }
      // write admission 全局锁：unresolved write fault 期间阻断一切 commit。
      if (isTreasuryWriteAdmissionLocked()) {
        return {
          status: "rejected",
          reason: "write_admission_locked",
          detail: "存在 unresolved write fault（显式修复路径解除前阻断全部 writer）",
        };
      }
      // 幂等防御：prepare→commit 之间被同 id 结算（合法竞态，该路径已计入
      // tentative 不会超卖）——handle 终态化。
      const settledBeforeCommit = projection.isSettled(record.canonical.transactionId);
      if (settledBeforeCommit !== undefined) {
        record.state = "committed";
        preparedById.delete(record.canonical.transactionId);
        projection.tentativeRelease(record.tentativeKey);
        releaseTreasuryReceiptReservation(record.canonical.transactionId);
        finalizeHandleRecord(record, "committed");
        return {
          status: "already_settled",
          transactionId: record.canonical.transactionId,
          firstRecordedAtTick: settledBeforeCommit,
        };
      }
      // ── staged commit：所有可预期失败已在 prepare 前置，此处只做发布。
      //    任一阶段意外失败 → faulted 终态 + Memory write-fault marker +
      //    全局锁；tentative 与 receipt 槽绝不释放 ─────────────────────────
      record.state = "committing";
      try {
        runTreasuryCommitFaultHook("receipt_publish");
        const receipt = projection.publishPreparedReceipt(record.canonical.transactionId, Game.time);
        if (receipt.status === "fatal") {
          throw new TreasuryCommitFaultError("receipt_publish", receipt.detail);
        }
        runTreasuryCommitFaultHook("heap_publish");
        const heap = projection.publishPreparedHeapState(
          record.canonical,
          record.shape,
          record.tentativeKey,
          (phase) => runTreasuryCommitFaultHook(phase),
        );
        runTreasuryCommitFaultHook("handle_state");
        record.state = "committed";
        preparedById.delete(record.canonical.transactionId);
        finalizeHandleRecord(record, "committed");
        metrics.preparedCommits += 1;
        return {
          status: "committed",
          transactionId: record.canonical.transactionId,
          postings: heap.postings,
          tick: Game.time,
        };
      } catch (error) {
        // 意外写故障（Game API 已 OK）：不得当作普通 rejected/aborted。
        // faulted 保留完整记录（shape 供 tick 边界 quarantine 快照）。
        const phase = error instanceof TreasuryCommitFaultError ? error.phase : "commit_unexpected";
        record.state = "faulted";
        record.faultPhase = phase;
        metrics.commitFaults += 1;
        recordTreasuryWriteFault({
          transactionId: record.canonical.transactionId,
          digest: record.digest,
          tick: Game.time,
          kind: record.canonical.kind,
          source: record.canonical.source,
          phase,
          status: "unresolved",
          recordedAt: Game.time,
        });
        return {
          status: "rejected",
          reason: "handle_faulted",
          detail: `commit 在 ${phase} 阶段发生写故障（已记录 write-fault marker，阻断后续 writer 直至修复）`,
        };
      }
    },

    abortPreparedTransaction(handle: TreasuryPreparedHandle): TreasuryPreparedAbortResult {
      const invalid = (detail: string): TreasuryPreparedAbortResult => {
        metrics.invalidHandleRejections += 1;
        return { status: "rejected", reason: "invalid_handle", detail };
      };
      if (!handle || typeof handle !== "object" || !handleRegistry.has(handle)) {
        return invalid("handle 未在本服务实例签发（伪造对象/JSON 副本/跨实例 handle 一律无效）");
      }
      const record = handleRecords.get(handle);
      if (!record || record.generation !== serviceGeneration) {
        return invalid("handle 代际不匹配");
      }
      if (record.state === "expired" || record.preparedAtTick !== Game.time) {
        return {
          status: "rejected",
          reason: "handle_expired",
          detail: `handle 于 tick ${String(record.preparedAtTick)} 签发，当前 tick ${String(Game.time)}（tick 边界作废）`,
        };
      }
      if (record.state === "committed") {
        const recordTransactionId = isTerminalRecord(record) ? record.transactionId : record.canonical.transactionId;
        const settledAt = projection.isSettled(recordTransactionId);
        return {
          status: "already_finalized",
          transactionId: recordTransactionId,
          finalizedAs: "committed",
          committedAtTick: settledAt ?? record.preparedAtTick,
        };
      }
      if (record.state === "aborted") {
        const recordTransactionId = isTerminalRecord(record) ? record.transactionId : record.canonical.transactionId;
        return { status: "already_finalized", transactionId: recordTransactionId, finalizedAs: "aborted" };
      }
      if (record.state === "faulted") {
        return { status: "rejected", reason: "handle_faulted", detail: "faulted handle 的预留不释放（对账前保持占用）" };
      }
      if (record.state === "committing") {
        return invalid("handle 处于 committing 状态，不可 abort");
      }
      if (isTerminalRecord(record)) {
        return invalid("handle 记录处于不可用终态（内部不一致）");
      }
      // write admission 全局锁：unresolved write fault 期间释放操作同样阻断
      // （保守——故障未对账前不改变任何预留面）。
      if (isTreasuryWriteAdmissionLocked()) {
        return {
          status: "rejected",
          reason: "write_admission_locked",
          detail: "存在 unresolved write fault（显式修复路径解除前阻断全部 writer）",
        };
      }
      // 原子释放：tentative 资源/容量 + receipt 槽 + handle 终态；不写
      // settled receipt / committed journal / overlay / projected capacity。
      record.state = "aborted";
      preparedById.delete(record.canonical.transactionId);
      projection.tentativeRelease(record.tentativeKey);
      releaseTreasuryReceiptReservation(record.canonical.transactionId);
      finalizeHandleRecord(record, "aborted");
      metrics.transactionPreparesAborted += 1;
      return { status: "aborted", transactionId: record.canonical.transactionId };
    },

    executePreparedAction<TAction extends { ok: boolean }>(
      input: TreasuryTransactionInput,
      action: () => TAction,
      execution?: TreasuryWriterKernelExecution,
    ): TreasurySafeExecuteResult<TAction> {
      const prepared = this.prepareTransaction(input);
      if (prepared.status === "already_settled") {
        return { status: "already_settled", transactionId: prepared.transactionId, firstRecordedAtTick: prepared.firstRecordedAtTick };
      }
      if (prepared.status !== "prepared") {
        // prepare 拒绝：Game callback 零调用（quarantine/intent/锁/验证失败等）。
        return { status: "prepare_rejected", reason: prepared.reason, ...(prepared.detail !== undefined ? { detail: prepared.detail } : {}) };
      }
      const record = activeHandles.get(prepared.handle);
      if (!record) {
        // 理论不可达（handle 刚签发）：按协议违规拒绝，不执行 Game API。
        return { status: "prepare_rejected", reason: "invalid_handle", detail: "签发后 handle 记录缺失（内部不一致）" };
      }
      // ── 原子 redemption（第九轮 4.2）：tentative 已接管（prepare 成功）、
      //    durable intent 写入与 Game callback 之前消费授权——预算向
      //    tentative 的转移是一个原子点；redeem 拒绝时释放全部预留、
      //    callback 零调用。 ─────────────────────────────────────────────
      if (execution?.redeemAuthorization !== undefined) {
        const redeemed = execution.redeemAuthorization();
        if (redeemed.status === "rejected") {
          record.state = "aborted";
          preparedById.delete(record.canonical.transactionId);
          projection.tentativeRelease(record.tentativeKey);
          releaseTreasuryReceiptReservation(record.canonical.transactionId);
          finalizeHandleRecord(record, "aborted");
          metrics.authorizationRejected += 1;
          return {
            status: "prepare_rejected",
            reason: "authorization_invalid",
            detail: `授权 redemption 失败（${redeemed.reason}）: ${redeemed.detail}——tentative 已释放，Game callback 零调用`,
          };
        }
      }
      // ── durable intent / WAL（第八轮唯一安全顺序）：Game API 之前持久化
      //    transaction identity + canonical postings——写入失败时 callback
      //    零调用、tentative 与槽位释放、结构化拒绝。第九轮：contract 路径
      //    经 execution.intentContract 绑定完整合同身份（contractId/digest/
      //    adapterVersion/authorizationDigest/durable payload）。 ─────────
      const intentWrite = writeTreasuryIntentEntry({
        transactionId: record.canonical.transactionId,
        digest: record.digest,
        actionKind: record.canonical.kind,
        kind: record.canonical.kind,
        source: record.canonical.source,
        postings: record.shape.merged.map((posting) => ({
          roomName: posting.roomName,
          locationKind: posting.locationKind,
          resource: posting.resource,
          delta: posting.delta,
        })),
        phase: "ready",
        auditSource: "execute-prepared-action",
        ...(execution?.intentContract !== undefined
          ? {
              contractId: execution.intentContract.contractId,
              contractDigest: execution.intentContract.contractDigest,
              adapterVersion: execution.intentContract.adapterVersion,
              ...(execution.intentContract.authorizationDigest !== undefined
                ? { authorizationDigest: execution.intentContract.authorizationDigest }
                : {}),
              ...(execution.intentContract.durablePayload !== undefined
                ? { durablePayload: execution.intentContract.durablePayload }
                : {}),
              ...(execution.intentContract.durablePayloadVersion !== undefined
                ? { durablePayloadVersion: execution.intentContract.durablePayloadVersion }
                : {}),
            }
          : {}),
        createdAtTick: Game.time,
        updatedAtTick: Game.time,
      });
      if (intentWrite.status === "rejected") {
        // intent 写失败：绝不进入 Game callback——释放全部预留并终态化 handle
        //（资产零占用、slot 回收），返回结构化拒绝。计数由 intents.ts 的
        // writeFailures 权威承载（metrics 聚合，不在此重复累加）。
        record.state = "aborted";
        preparedById.delete(record.canonical.transactionId);
        projection.tentativeRelease(record.tentativeKey);
        releaseTreasuryReceiptReservation(record.canonical.transactionId);
        finalizeHandleRecord(record, "aborted");
        return {
          status: "prepare_rejected",
          reason: "intent_store_unavailable",
          detail: `durable intent 写入失败（${intentWrite.reason}）：${intentWrite.detail}——Game callback 零调用，预留已释放`,
        };
      }
      record.intentWritten = true;
      intentBackedActiveIds.add(record.canonical.transactionId);
      // 标记 execution-started（持久 phase=executing）：此后 callback 一旦
      // 进入，恢复语义即为 execution unknown——ready 与 executing 绝不混同。
      const started = markTreasuryIntentPhase(record.canonical.transactionId, "executing");
      if (started.status === "rejected" && started.reason !== "not_found") {
        // store 在写入与标记之间致命损坏：保守不进入 callback（宁可当作未执行
        // 关闭——intent 仍在 store 中，下一 tick 恢复处置）。
        metrics.intentWriteFailures += 1;
        record.state = "expired";
        preparedById.delete(record.canonical.transactionId);
        projection.tentativeRelease(record.tentativeKey);
        releaseTreasuryReceiptReservation(record.canonical.transactionId);
        finalizeHandleRecord(record, "expired");
        return {
          status: "prepare_rejected",
          reason: "intent_store_unavailable",
          detail: `durable intent 状态标记失败（${started.detail}）——Game callback 零调用`,
        };
      }
      record.state = "executing";
      let actionResult: TAction;
      try {
        // Game API 恰好执行一次（本包装器与注册 adapter 是仅有的调用点）。
        // callback 应是极窄的 Game API adapter——在其中执行额外业务逻辑会
        // 放大 execution unknown。
        actionResult = action();
      } catch (error) {
        // callback 抛错 = execution unknown（第七轮）：callback 内可能已经
        // 执行部分 Game 副作用，绝不执行普通 abort（那会错误释放可能已被
        // 占用的资源）——立即 faulted + write-fault marker（含有界异常摘要，
        // 绝不持久化完整 Error 对象）+ durable quarantine + 全局锁，然后
        // rethrow 原始异常（Treasury 状态完整，异常原样透传不吞）。
        // intent：quarantine 写入成功时释放（slot 转换守恒）；失败时保留
        //（emergency intent authority——postings/占用不丢）。
        record.faultPhase = "action_threw_execution_unknown";
        metrics.executionUnknownQuarantines += 1;
        markTreasuryIntentPhase(record.canonical.transactionId, "execution_unknown");
        quarantineFaultedRecord(record, error instanceof Error ? error.message : String(error));
        throw error;
      }
      if (actionResult && actionResult.ok) {
        markTreasuryIntentPhase(record.canonical.transactionId, "ok_pending_commit");
        const committed = this.commitPreparedTransaction(prepared.handle);
        if (committed.status === "committed") {
          // settled：intent 关闭（WAL 完成）。
          releaseTreasuryIntentEntry(record.canonical.transactionId);
          return { status: "executed_committed", handle: prepared.handle, actionResult, committedAtTick: committed.tick };
        }
        if (committed.status === "already_settled") {
          releaseTreasuryIntentEntry(record.canonical.transactionId);
          return { status: "already_settled", transactionId: committed.transactionId, firstRecordedAtTick: committed.firstRecordedAtTick };
        }
        // Game callback 已成功，但 Treasury commit 失败/锁定/故障：Game 动作
        // 已发生——立即落 durable fault（faulted + marker + quarantine，不等
        // tick 边界；quarantine/marker 幂等），然后显式返回 executed_unsettled
        //（绝不返回 prepare_rejected/aborted——那会暗示未执行、诱导自动重试）。
        // intent 随 quarantine 写入成功释放（postings 由 quarantine 接管）。
        if ((record.state as TreasuryPreparedHandleState) !== "faulted") {
          record.faultPhase = "commit_unexpected";
        }
        markTreasuryIntentPhase(record.canonical.transactionId, "execution_unknown");
        quarantineFaultedRecord(record);
        return {
          status: "executed_unsettled",
          handle: prepared.handle,
          actionResult,
          transactionId: record.canonical.transactionId,
          digest: record.digest,
          faultReason: committed.reason,
          ...(committed.detail !== undefined ? { detail: committed.detail } : {}),
          retryForbidden: true,
        };
      }
      // Game 正常返回非 OK：关闭 intent（确认未成功）→ 普通 abort。
      markTreasuryIntentPhase(record.canonical.transactionId, "returned_non_ok");
      const aborted = this.abortPreparedTransaction(prepared.handle);
      if (aborted.status !== "aborted") {
        // abort 未确认：资源仍被占用——立即隔离（第七轮：phase=
        // action_returned_non_ok_abort_failed，不等 tick 边界），不得报告已
        // 正常 abort。intent 随 quarantine 写入成功释放、失败保留。
        record.faultPhase = "action_returned_non_ok_abort_failed";
        markTreasuryIntentPhase(record.canonical.transactionId, "execution_unknown");
        quarantineFaultedRecord(record);
        return {
          status: "executed_abort_failed",
          handle: prepared.handle,
          actionResult,
          reason: aborted.status === "rejected" ? aborted.reason : "invalid_handle",
          ...(aborted.status === "rejected" && aborted.detail !== undefined ? { detail: aborted.detail } : {}),
        };
      }
      // 确认 aborted：intent 关闭（slot 回收）。
      releaseTreasuryIntentEntry(record.canonical.transactionId);
      return {
        status: "executed_aborted",
        handle: prepared.handle,
        actionResult,
      };
    },

    preparedLeakAudit(): TreasuryPreparedLeakAudit {
      return lastPreparedLeakAudit;
    },

    issueTreasuryReconciliationCapability(input: {
      readonly transactionId: string;
      readonly digest?: string;
    }): { readonly status: "issued"; readonly capability: TreasuryReconciliationCapability } | {
      readonly status: "rejected";
      readonly reason: "not_found" | "digest_mismatch" | "active_handle_present" | "no_registered_reconciler" | "invalid_input" | "premature_observation";
      readonly detail: string;
    } {
      const reject = (reason: "not_found" | "digest_mismatch" | "active_handle_present" | "no_registered_reconciler" | "invalid_input" | "premature_observation", detail: string) => {
        metrics.reconciliationCapabilitiesRejected += 1;
        return { status: "rejected" as const, reason, detail };
      };
      if (!input || typeof input !== "object" || typeof input.transactionId !== "string" || input.transactionId.length === 0) {
        return reject("invalid_input", "transactionId 缺失或非法");
      }
      const state = ensureTickState(true);
      // 目标 entry：quarantine 优先，其次 unresolved intent（emergency
      // authority 场景——quarantine 写失败时 intent 是事实权威）。
      const quarantined = readTreasuryQuarantineEntry(input.transactionId);
      const intended = quarantined === undefined ? readTreasuryIntentEntry(input.transactionId) : undefined;
      // 归一化双权威（quarantine 优先；intent 为 emergency authority 兜底）。
      // contract 绑定事实（contractId/contractDigest/adapterVersion/durable
      // payload）目前仅 intent 权威携带；quarantine entry 无 contract 字段。
      const facts0 =
        quarantined !== undefined
          ? {
              transactionId: quarantined.transactionId,
              digest: quarantined.digest,
              kind: quarantined.kind,
              actionKind: quarantined.kind,
              recordedAt: quarantined.recordedAt,
              postings: quarantined.deltas as unknown as readonly { roomName: string; locationKind: string; resource: string; delta: number }[],
              contractId: undefined as string | undefined,
              contractDigest: undefined as string | undefined,
              adapterVersion: undefined as number | undefined,
              durablePayload: undefined as string | undefined,
              durablePayloadVersion: undefined as number | undefined,
            }
          : intended !== undefined
            ? {
                transactionId: intended.transactionId,
                digest: intended.digest,
                kind: intended.kind,
                actionKind: intended.actionKind,
                recordedAt: intended.updatedAtTick,
                postings: intended.postings as unknown as readonly { roomName: string; locationKind: string; resource: string; delta: number }[],
                contractId: intended.contractId,
                contractDigest: intended.contractDigest,
                adapterVersion: intended.adapterVersion,
                durablePayload: intended.durablePayload,
                durablePayloadVersion: intended.durablePayloadVersion,
              }
            : undefined;
      if (facts0 === undefined) {
        return reject("not_found", `transactionId ${input.transactionId.slice(0, 48)} 不在 quarantine/intent（可能已解决或从未隔离）`);
      }
      if (input.digest !== undefined && facts0.digest !== input.digest) {
        return reject("digest_mismatch", `digest 不匹配（entry ${facts0.digest}，请求 ${input.digest}）`);
      }
      // active handle：resolution 后 endTick 不得重新 quarantine。
      if (preparedById.has(input.transactionId)) {
        return reject("active_handle_present", "transaction 仍属于当前 active handle registry（须等 handle 终态化/服务重建）");
      }
      // post-fault observation：当前 tick 严格晚于故障 tick 且当前 observation
      // 为故障后观察。
      if (Game.time <= facts0.recordedAt || state.tick <= facts0.recordedAt) {
        return reject("premature_observation", `尚未建立故障后 shared observation（当前 tick ${String(Game.time)}，故障 tick ${String(facts0.recordedAt)}）`);
      }
      // 注册 reconciler 边界：无注册 adapter 或 adapter 无 reconciler 拒绝。
      const actionKind = facts0.actionKind;
      const adapter = findTreasuryActionAdapter(actionKind);
      if (adapter === undefined) {
        return reject("no_registered_reconciler", `action kind ${actionKind} 无注册 adapter（capability 只能基于注册 reconciler 签发）`);
      }
      if (adapter.reconcile === undefined) {
        return reject("no_registered_reconciler", `action kind ${actionKind} 的 adapter 未提供 reconciler（无法判定执行事实）`);
      }
      // 结论只能来自注册 reconciler（调用者不可自填）。输入为完整
      // contract-specific durable facts（第九轮 4.8：不再使用
      // postings[0].resource 或单一负数 amount 汇总这类过度简化事实）。
      const facts = {
        actionKind,
        transactionId: facts0.transactionId,
        ...(facts0.contractId !== undefined ? { contractId: facts0.contractId } : {}),
        ...(facts0.contractDigest !== undefined ? { contractDigest: facts0.contractDigest } : {}),
        ...(facts0.adapterVersion !== undefined ? { adapterVersion: facts0.adapterVersion } : {}),
        postings: facts0.postings.map((leg) => ({ ...leg })) as never,
        ...(facts0.durablePayload !== undefined ? { durablePayload: facts0.durablePayload } : {}),
        ...(facts0.durablePayloadVersion !== undefined ? { durablePayloadVersion: facts0.durablePayloadVersion } : {}),
      };
      const conclusion = adapter.reconcile(facts, state.observation) as TreasuryReconciliationConclusion;
      if (conclusion !== "observed_committed" && conclusion !== "observed_not_executed" && conclusion !== "still_uncertain") {
        return reject("invalid_input", `reconciler 返回非法结论: ${String(conclusion)}`);
      }
      const capability = registerTreasuryReconciliationCapability(
        Object.freeze({
          __brand: "treasury-reconciliation-capability" as const,
          transactionId: facts0.transactionId,
          digest: facts0.digest,
          actionKind,
          conclusion,
          postFaultEpoch: {
            scope: state.observation.epoch.scope,
            epochSeq: state.observation.epoch.epochSeq,
            observedAtTick: state.observation.epoch.observedAtTick,
          },
          observationTick: Game.time,
          reconcilerKind: actionKind,
          reconcilerVersion: adapter.version,
          serviceGeneration,
          tick: Game.time,
        }),
      );
      metrics.reconciliationCapabilitiesIssued += 1;
      return { status: "issued", capability };
    },

    treasuryServiceGeneration(): number {
      return serviceGeneration;
    },

    treasuryResolutionGuard(): {
      readonly activeTransactionIds: ReadonlySet<string>;
      readonly currentObservationTick: number;
    } {
      return {
        activeTransactionIds: new Set(preparedById.keys()),
        currentObservationTick: current?.tick ?? 0,
      };
    },

    /** @internal 单阶段兼容实现（勿直接调用）：经 treasury/compat 模块访问。 */
    recordAcceptedTransaction(input: TreasuryTransactionInput): TreasurySettlementResult {
      const compatShapeError = validateTreasuryTransactionInputShape(input, "record");
      if (compatShapeError !== null) {
        metrics.transactionsRejectedInvalid += 1;
        return { status: "rejected", reason: "invalid_input", detail: compatShapeError };
      }
      const state = ensureTickState(true);
      // 幂等优先于一切：已结算 id 的重放无论决策上下文一律 already_settled。
      const settledAt = projection.isSettled(input.transactionId);
      if (settledAt !== undefined) {
        metrics.duplicateSettlementsRejected += 1;
        return { status: "already_settled", transactionId: input.transactionId, firstRecordedAtTick: settledAt };
      }
      if (state.ended) {
        metrics.settlementsAfterEndRejected += 1;
        return { status: "rejected", reason: "tick_closed", detail: `tick ${Game.time} 已 endTick` };
      }
      // write admission 全局锁：unresolved write fault 期间阻断单阶段登记。
      if (isTreasuryWriteAdmissionLocked()) {
        metrics.transactionsRejectedInvalid += 1;
        return {
          status: "rejected",
          reason: "write_admission_locked",
          detail: "存在 unresolved write fault（显式修复路径解除前阻断全部 writer）",
        };
      }
      const decision = resolveDecisionEpoch(input.decision);
      if ("rejection" in decision) return decision.rejection;
      const registered = decision.registered;
      // 物理可行性验证使用 decision 指向的 exact observation（绝不回退 shared）。
      return projection.recordTransaction(input, registered.observation);
    },

    /** @internal 单阶段兼容实现（勿直接调用）：经 treasury/compat 模块访问。 */
    recordAcceptedAction(input: TreasuryRecordActionInput): TreasurySettlementResult {
      return this.recordAcceptedTransaction({
        transactionId: input.transactionId,
        kind: input.kind,
        source: input.source,
        decision: input.decision,
        postings: [
          {
            roomName: input.roomName,
            locationKind: input.locationKind,
            resource: input.resource,
            delta: input.delta,
          },
        ],
      });
    },

    journal(): readonly TreasuryJournalEntry[] {
      return projection.journalSnapshot();
    },

    lastReconciliation(): TreasuryReconciliationSummary | null {
      return current?.lastReconciliation ?? null;
    },

    projectedUsedCapacity(roomName: string, kind: TreasuryLocationKind): number {
      // @deprecated 兼容别名（严格口径）——新代码使用 strictProjectedUsedCapacity。
      return this.strictProjectedUsedCapacity(roomName, kind);
    },

    strictProjectedUsedCapacity(roomName: string, kind: TreasuryLocationKind): number {
      // 严格口径：observed.used + 本 tick overlay 净变化（不含风险扣减）。
      return this.observation().usedCapacity(roomName, kind) + projection.locationCapacityDelta(roomName, kind);
    },

    strictProjectedFreeCapacity(roomName: string, kind: TreasuryLocationKind): number {
      // 严格口径：observed.free − overlay 净变化——与 strictProjectedUsed
      // 互补（两者之和 = physical capacity，不含任何风险扣减）。
      return this.observation().freeCapacity(roomName, kind) - projection.locationCapacityDelta(roomName, kind);
    },

    riskAdjustedFreeCapacity(roomName: string, kind: TreasuryLocationKind): number {
      // risk-adjusted：严格 free 再扣 quarantine/unresolved intent 正流入
      // 占用（可能已流入的 uncertain 资源占用空间；receiver admission 用）。
      metrics.riskAdjustedCapacityLookups += 1;
      const quarantineOccupancy = treasuryQuarantineCapacityOccupancy().get(`${roomName}\u0000${kind}`) ?? 0;
      const intentOccupancy = treasuryIntentCapacityOccupancy().get(`${roomName}\u0000${kind}`) ?? 0;
      return (
        this.observation().freeCapacity(roomName, kind) -
        projection.locationCapacityDelta(roomName, kind) -
        quarantineOccupancy -
        intentOccupancy
      );
    },

    projectedFreeCapacity(roomName: string, kind: TreasuryLocationKind): number {
      // quarantine + unresolved intent 容量占用（第七/八轮保守口径，risk-
      // adjusted）：该 location 的正净流入（可能已流入）必须减少 free
      // capacity；负净流出（可能已流出）不得假设空间已释放——occupancy =
      // Σ max(0, net)（per-transaction，跨 transaction 不抵消），只减不增。
      metrics.riskAdjustedCapacityLookups += 1;
      const quarantineOccupancy = treasuryQuarantineCapacityOccupancy().get(`${roomName}\u0000${kind}`) ?? 0;
      const intentOccupancy = treasuryIntentCapacityOccupancy().get(`${roomName}\u0000${kind}`) ?? 0;
      return (
        this.observation().freeCapacity(roomName, kind) -
        projection.locationCapacityDelta(roomName, kind) -
        quarantineOccupancy -
        intentOccupancy
      );
    },

    projectionRevision(): number {
      return projection.projectionRevision();
    },

    metrics(): TreasuryMetrics {
      const liveIndex = current?.commitmentIndex;
      const liveQueries = liveIndex?.metrics.indexQueries ?? 0;
      const receiptCounters = readTreasuryReceiptEventCounters();
      const tentativeKeys = projection.tentativeKeyCounts();
      const quarantineCounters = readTreasuryQuarantineCounters();
      const quarantineHealth = peekTreasuryQuarantineHealth();
      const quarantineBlock = treasuryQuarantineBlockers();
      const intentCounters = readTreasuryIntentCounters();
      const intentHealth = peekTreasuryIntentHealth();
      const slotsOccupied = recoverySlotsOccupied();
      const resolutionHealth = peekTreasuryResolutionStoreHealth();
      const resolutionStoreCounters = readTreasuryResolutionStoreCounters();
      const actionContractCounters = readTreasuryActionContractCounters();
      return {
        ...metrics,
        commitmentIndexQueries: metrics.commitmentIndexQueries + liveQueries,
        preparedActive: activeHandles.size,
        tentativeResourceKeys: tentativeKeys.resourceKeys,
        tentativeCapacityKeys: tentativeKeys.capacityKeys,
        receiptStoreMigrationsExecuted: receiptCounters.migrationsExecuted,
        receiptStoreIncompatibleFailures: receiptCounters.incompatibleFailures,
        receiptFullScans: receiptCounters.receiptFullScans,
        receiptAdmissionFastPaths: receiptCounters.admissionFastPaths,
        receiptAdmissionFullStoreBlocked: receiptCounters.admissionFullStoreBlocked,
        receiptExpiryCleanupScans: receiptCounters.expiryCleanupScans,
        receiptSlotsRemaining: receiptCounters.slotsRemaining,
        receiptNextExpiryTick: receiptCounters.nextExpiryTick,
        receiptEntriesVisited: receiptCounters.receiptEntriesVisited,
        receiptMigrationScans: receiptCounters.receiptMigrationScans,
        receiptLoadValidationEntries: receiptCounters.receiptLoadValidationEntries,
        receiptExpiryCleanupEntries: receiptCounters.receiptExpiryCleanupEntries,
        receiptFatalInspectionEntries: receiptCounters.receiptFatalInspectionEntries,
        writeAdmissionLocked: isTreasuryWriteAdmissionLocked() ? 1 : 0,
        quarantineEntries: quarantineHealth.entryCount,
        quarantineSlotsReserved: activeHandles.size - intentBackedActiveIds.size,
        quarantineSlotsRemaining: Math.max(0, TREASURY_QUARANTINE_MAX_ENTRIES - slotsOccupied),
        quarantineStoreHealthy: quarantineHealth.healthy,
        quarantineAdmissionRejections: metrics.quarantineAdmissionRejections + quarantineCounters.admissionRejections,
        unresolvedQuarantines: quarantineBlock.unresolvedCount,
        resolutionCommitted: readTreasuryResolutionCounters().committed,
        resolutionNotExecuted: readTreasuryResolutionCounters().notExecuted,
        resolutionUncertain: readTreasuryResolutionCounters().uncertain,
        resolutionRejected: readTreasuryResolutionCounters().rejected,
        reservationSchemaActivationFailures:
          metrics.reservationSchemaActivationFailures + readReservationMutationCounters().schemaActivationFailures,
        reservationMutationRejections: readReservationMutationCounters().mutationRejections,
        durableIntents: intentHealth.entryCount,
        intentSlotsRemaining: Math.max(0, TREASURY_QUARANTINE_MAX_ENTRIES - slotsOccupied),
        intentRecoveries: metrics.intentRecoveries + intentCounters.recoveries,
        intentQuarantineConversions: metrics.intentQuarantineConversions + intentCounters.quarantineConversions,
        intentStoreHealthy: intentHealth.healthy,
        intentWriteFailures: metrics.intentWriteFailures + intentCounters.writeFailures,
        authorizationsActive: authorizationRecords.size,
        resolutionInProgress: resolutionHealth.inProgress,
        resolutionFaulted: metrics.resolutionFaulted + resolutionStoreCounters.faulted,
        resolutionRecovered: metrics.resolutionRecovered + resolutionStoreCounters.recovered,
        receiptRefreshes: receiptCounters.receiptRefreshes,
        actionContractsBuilt: metrics.actionContractsBuilt + actionContractCounters.built,
        actionAdapterMismatches: metrics.actionAdapterMismatches + actionContractCounters.adapterMismatches,
        reservationStoreHealthy: validateReservationStoreHealth().healthy,
      };
    },

    resetForTest(): void {
      const keys = Object.keys(metrics) as Array<keyof TreasuryMetrics>;
      for (const key of keys) {
        (metrics as unknown as Record<string, number | boolean>)[key] = typeof metrics[key] === "boolean" ? false : 0;
      }
      projection.resetForTest();
      epochSeq = 0;
      current = null;
      freshEpochsThisTick = 0;
      epochRegistry.clear();
      activeHandles.clear();
      preparedById.clear();
      intentBackedActiveIds.clear();
      authorizationRecords.clear();
      authorizationOutflowTotals.clear();
      authorizationCapacityTotals.clear();
      authorizationLedgerRevisions = null;
      lastPreparedLeakAudit = Object.freeze({
        context: "end_tick",
        outstanding: 0,
        executing: 0,
        samples: Object.freeze([]),
      });
    },
  };

  // 单阶段入口不在公共 TreasuryService 接口上——经 compat 模块以内部
  // 形状访问（生产 writer 禁用；测试经 compatRecordAcceptedTransaction）。
  return service as TreasuryService;
}
