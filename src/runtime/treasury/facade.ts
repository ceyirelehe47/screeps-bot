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
  lookupTreasurySettledReceipt,
  peekTreasuryReceiptHealth,
  readTreasuryLifecycle,
  readTreasuryReceiptEventCounters,
  readTreasurySettlementProof,
  releaseAllTreasuryReceiptReservations,
  releaseTreasuryReceiptReservation,
  reserveTreasuryReceiptAdmission,
  writeTreasuryLifecycle,
  hasSettledReceipt,
} from "@/runtime/treasury/receipts";
import {
  treasuryAttemptIdentityRelation,
  type TreasuryAttemptIdentity,
} from "@/runtime/treasury/identityProof";
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
  outcomeOfTreasuryFaultPhase,
  peekTreasuryQuarantineHealth,
  peekTreasuryQuarantineStore,
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
  peekTreasuryIntentHealth,
  readTreasuryIntentCounters,
  readTreasuryIntentEntry,
  peekTreasuryIntentStore,
  recoverTreasuryIntentsAtTickBoundary,
  releaseTreasuryIntentEntry,
  progressTreasuryIntent,
  transferTreasuryIntentToQuarantine,
  treasuryIntentBlockers,
  treasuryIntentCapacityOccupancy,
  treasuryIntentOutflowOccupancy,
  writeTreasuryIntentEntry,
} from "@/runtime/treasury/intents";
import { readTreasuryCommitmentRevision } from "@/runtime/treasury/commitmentRevision";
import { readTreasuryResolutionCounters } from "@/runtime/treasury/resolutionEvents";
import {
  committedResolutionSettledAtTick,
  ensureTreasuryResolutionStoreValidated,
  peekTreasuryResolutionStoreEntry,
  peekTreasuryResolutionStoreHealth,
  readTreasuryResolutionStoreCounters,
  readTreasuryResolutionTombstone,
  recoverStagedResolutions,
  treasuryResolutionResolvingInProgress,
  listTreasuryPendingReleaseIds,
} from "@/runtime/treasury/resolutionStore";
import { resolveTreasuryUnresolvedAuthority } from "@/runtime/treasury/unresolvedAuthority";
import {
  type TreasuryReconciliationCapability,
  type TreasuryReconciliationCapabilityConsumption,
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
  canonicalTreasuryAuthorizationLegDigest,
  canonicalTreasuryReceiverCapacityDigest,
  computeTreasuryAuthorizationCohortDigest,
  type TreasuryAuthorizationBundle,
  type TreasuryAuthorizationCohortFacts,
  type TreasuryAuthorizationConsumeResult,
  type TreasuryAuthorizationRequest,
  type TreasuryAuthorizationResult,
  type TreasuryAuthorizationRevisions,
  type TreasuryAuthorizationToken,
  type TreasuryContractAuthorizationOptions,
} from "@/runtime/treasury/authorization";
import { TREASURY_WRITER_KERNEL, type TreasuryWriterKernel } from "@/runtime/treasury/kernelChannel";
import {
  TREASURY_RESOLUTION_KERNEL,
  type TreasuryResolutionKernel,
} from "@/runtime/treasury/resolutionKernelChannel";
import { hashTreasuryCanonicalString } from "@/runtime/treasury/transactionId";
import { computeTreasuryDurableIdentityDigest, treasuryDurableIdentitiesMatch } from "@/runtime/treasury/durableIdentity";
import {
  readTreasuryAuthorizationFaultEntry,
  releaseTreasuryAuthorizationFaultEntry,
  treasuryAuthorizationFaultBlockers,
  writeTreasuryAuthorizationFaultEntry,
  ensureTreasuryAuthorizationFaultStoreValidated,
  type TreasuryAuthorizationFaultEntry,
  peekTreasuryAuthorizationFaultHealth,
  TREASURY_AUTHORIZATION_FAULT_MAX_ENTRIES,
} from "@/runtime/treasury/authorizationFaults";
import {
  writeTreasuryResolutionTombstone,
  ensureTreasuryResolutionSlotAvailable,
  markTreasuryPendingReleaseCompleted,
} from "@/runtime/treasury/resolutionStore";
import { clearTreasuryWriteFaultMarkerForResolution, readTreasuryWriteFault, classAwareMarkerFieldsOfFacts } from "@/runtime/treasury/writeFault";
import { classAwareIdentityOfAttempt } from "@/runtime/treasury/markerAttemptIdentity";
import {
  isTreasuryRearmAttemptId,
  isValidTreasuryTransactionId,
} from "@/runtime/treasury/transactionId";
import {
  computeTreasuryAttemptLineageId,
  computeTreasuryLineageIdentityDigest,
  deriveTreasuryLineageNextChildTransactionId,
  lookupTreasuryAttemptLineageByAttemptId,
  peekTreasuryAttemptLineageHealth,
  readTreasuryAttemptLineageRecord,
  recoverTreasuryAttemptLineageAtTickBoundary,
  setTreasuryLineageRecoveryMarkerReaderForAssembly,
  setTreasuryLineageReceiptReaderForAssembly,
  stageTreasuryLineageCapabilityIssued,
  stageTreasuryLineageChildIntentPending,
  activateTreasuryLineageChild,
  rollbackTreasuryLineageToRearmReady,
  closeTreasuryLineageAsChainCommitted,
  retireTreasuryLineageCurrentAttempt,
  convergeTreasuryLineageRetirementFromFacts,
  updateTreasuryAttemptLineageRecord,
  type TreasuryAttemptLineageIdentity,
} from "@/runtime/treasury/attemptLineage";
// 【第十八轮】verdict / retirement summary 装配（import 即注册——resolutionStore
// 的 retention verdict 与 attemptLineage 容量预检的压缩钩子）。
import "@/runtime/treasury/lineageGenerationRetirement";
import {
  lookupTreasuryRetirementSummaryByRoot,
  peekTreasuryRetirementSummaryHealth,
  compactTreasuryTerminalLineagesAtTickBoundary,
} from "@/runtime/treasury/lineageRetirementSummary";
import {
  createTreasuryRearmCapabilityAuthority,
  treasuryRearmCapabilityMatches,
  type TreasuryRearmCapability,
} from "@/runtime/treasury/rearmCapability";
import {
  computeTreasuryLineageBindingDigest,
} from "@/runtime/treasury/lineageBinding";
import {
  computeTreasuryModernRetrySemanticDigest,
  computeTreasuryLowlevelRetrySemanticDigest,
} from "@/runtime/treasury/retrySemanticIdentity";
import {
  preflightTreasuryRearmCapability,
  checkTreasuryChildAttemptOccupancy,
} from "@/runtime/treasury/attemptOccupancy";
import {
  computeTreasuryPolicyDecisionDigest,
  findTreasuryPolicyResolver,
  treasuryPolicyAuthorityReady,
  validateTreasuryPolicyDecision,
  type TreasuryPolicyDecision,
} from "@/runtime/treasury/policyAuthority";
import { evaluateTreasuryWriteReadiness } from "@/runtime/treasury/writeReadiness";
import { collectTreasuryWriteReadinessInputs, type TreasuryReadinessStateSources } from "@/runtime/treasury/readinessCollector";
import {
  createTreasuryAuthorizationLedger,
  setTreasuryRedemptionFaultInjectorForTest,
  type TreasuryAuthorizationBundleRecord,
  type TreasuryAuthorizationLedger,
} from "@/runtime/treasury/authorizationLedger";
export { setTreasuryRedemptionFaultInjectorForTest };
import { createTreasuryResolutionAuthority } from "@/runtime/treasury/resolutionAuthority";
import { createTreasuryRecoveryCoordinator } from "@/runtime/treasury/recoveryCoordinator";
import {
  resolveTreasuryQuarantinedTransactionAsCommitted,
  resolveTreasuryQuarantinedTransactionAsNotExecuted,
  type TreasuryFaultResolutionResult,
} from "@/runtime/treasury/faultResolution";
import { readTreasuryQuarantineRevision } from "@/runtime/treasury/quarantine";
import { readTreasuryIntentRevision } from "@/runtime/treasury/intents";
import { TREASURY_LOWLEVEL_SOURCE_RUNTIME, type TreasuryAuthorityLevel } from "@/runtime/treasury/authorityLevel";
import type { TreasuryPosting, TreasuryStructureBindingDescriptor } from "@/runtime/treasury/types";
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
let serviceGenerationCounter = 0;
function nextTreasuryServiceGeneration(): number {
  serviceGenerationCounter += 1;
  return serviceGenerationCounter;
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
  /** 统一 durable identity（第十二轮 3.4：receipt settlement proof 绑定）。 */
  durableIdentityDigest?: string;
  /** 【第十三轮】commit 段 receipt proof 绑定的完整 attempt 身份（contract 路径）。 */
  contractDigest?: string;
  authorizationCohortDigest?: string;
  /** 【第十七轮第十一节·第十八轮完整 proof】tr1_ rearm child 的 lineage
   * proof（receipt/tombstone/marker proof 链继承）。 */
  lineageBindingDigest?: string;
  lineageGeneration?: number;
  lineageId?: string;
  lineageParentTransactionId?: string;
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
/**
 * service 闭包私有 bundle 记录（第十轮 3.12.3）：全部授权 legs 与统一
 * cohort（owner/policy/contract/epoch/revisions/generation/tick）。同一
 * bundle 的 legs 在签发时原子校验——不同 owner/policy/revision cohort 不得
 * 组成一个 bundle。
 */

export interface TreasuryWriterKernelExecution {
  /**
   * opaque service-issued authorization bundle（第十轮 3.12.3/3.12.4）：
   * prepare 成功（tentative 接管）后、durable intent 写入前执行**批量原子
   * redemption**（全部 legs 一次性验证、staged 变更一次发布；任何注入故障
   * 前缀回滚或进入 internal authorization fault）。bundle 为 service 闭包
   * registry 签发的对象——裸 token/token 数组不是 production 输入。
   */
  authorizationBundle?: TreasuryAuthorizationBundle;
  /**
   * @deprecated 第九轮兼容 hook（测试注入用；production 路径已改 authorizationBundle）。
   * 【第十四轮】返回值可选携带 cohort facts——intentContract（contract 路径）
   * 的测试注入用它满足 modern 定级的成对不变量（contract + cohort）。
   */
  redeemAuthorization?(): { readonly status: "ok"; readonly cohort?: TreasuryAuthorizationCohortFacts } | { readonly status: "rejected"; readonly reason: string; readonly detail: string };
  intentContract?: {
    readonly contractId: string;
    readonly contractDigest: string;
    readonly adapterVersion: number;
    /** adapter registration identity（第十一轮 3.13.5：durable identity 输入）。 */
    readonly adapterRegistrationId?: string;
    /** 稳定 adapter/reconciler 语义身份（第十二轮 3.5：durable identity 输入）。 */
    readonly adapterSemanticIdentity?: string;
    readonly authorizationDigest?: string;
    readonly durablePayload?: string;
    readonly durablePayloadVersion?: number;
    /** structure incarnation facts（受控数组，≤16；转移至 quarantine v2）。 */
    readonly structureFacts?: readonly TreasuryStructureBindingDescriptor[];
    /**
     * 【第十七轮第十节】tr1_ rearm child 的 canonical args 文本（retry
     * semantic digest 重算比较用——child contract 必须与 parent 的实际
     * Game 动作语义完全一致）。
     */
    readonly canonicalArgsText?: string;
    /** 【第十八轮 24.12】adapter 显式 retry facts（digest 重算输入）。 */
    readonly adapterRetryFacts?: string;
  };
  /**
   * 【第十七轮第八节/第十节】tr1_ rearm child 的 opaque rearm capability
   *（kernel 内部通道：actionContracts.executeTreasuryActionContract 经
   * request.rearmCapability 传入；Game callback 之前的接管协议消费）。
   */
  rearmCapability?: unknown;
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
  /**
   * 低层 writer 原语已从公共接口移除（第十轮 3.12.5 writer kernel 封闭）：
   * authorizeResourceUse / validateTreasuryAuthorizationForRedeem /
   * consumeTreasuryAuthorization / prepareTransaction / executePreparedAction /
   * commitPreparedTransaction / abortPreparedTransaction 只经
   * TREASURY_WRITER_KERNEL symbol 通道（treasury 协议栈内部与 testHarness）
   * 访问——生产调用者类型与运行时枚举均不可达。
   */
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
    readonly reason: "invalid_input" | "contract_invalid" | "adapter_not_registered" | "write_admission_blocked" | "authorization_policy_violation" | "authorization_context_unsafe" | "insufficient_amount" | "capacity_overflow" | "authorization_capacity_exhausted" | "policy_not_ready" | "authorization_invalid";
    readonly detail: string;
  };

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
    readonly status: "already_resolved";
    readonly resolution: "committed" | "not-executed";
    readonly transactionId: string;
  } | {
    readonly status: "rejected";
    readonly reason: "not_found" | "digest_mismatch" | "authority_inconsistent" | "authority_store_unhealthy" | "active_handle_present" | "no_registered_reconciler" | "invalid_input" | "premature_observation" | "adapter_version_mismatch" | "reconciler_fault" | "legacy_authority_isolated" | "resolution_in_progress" | "resolution_identity_conflict" | "resolution_store_fatal";
    readonly detail: string;
  };
  /**
   * 【第十七轮第七节】issue opaque rearm capability：final not-executed 后
   * 重试的唯一合法通道（取代第十六轮返回纯 child ID 字符串的
   * rearmResolvedNotExecutedAttempt——普通字符串不再是 rearm 权威）。
   * 完整 cross-store preflight（attemptOccupancy 集中管理：parent 相反
   * proof、child 占用、lineage rearm-ready）通过后签发不可伪造的 heap-only
   * capability（绑定 lineage/parent/child/generation/retry semantic digest/
   * service generation/tick/nonce）；同 tick 同 lineage 幂等返回同一
   * capability。child contract 必须重新授权（当前 policy/commitment/容量）。
   */
  issueTreasuryRearmCapability(input: {
    readonly parentTransactionId: string;
  }): {
    readonly status: "issued";
    readonly capability: TreasuryRearmCapability;
    readonly childTransactionId: string;
  } | {
    readonly status: "rejected";
    readonly reason:
      | "invalid_input"
      | "lineage_store_unhealthy"
      | "lineage_record_missing"
      | "lineage_not_rearm_ready"
      | "lineage_not_rearmable"
      | "parent_not_resolved"
      | "proof_conflict"
      | "parent_authority_present"
      | "parent_marker_pending"
      | "retirement_incomplete"
      | "receipt_store_unhealthy"
      | "child_identity_occupied"
      | "lineage_write_failed";
    readonly detail: string;
  };
  /**
   * 对外 resolution 管理入口（第十轮 3.12.8）：fault resolution 的唯一生产
   * 调用面——内部经 service 闭包注册的 resolution kernel 执行（结构兼容的
   * 伪 service 无法进入）；capability 在全部前置检查通过且 staged resolution
   * 写入成功后才消费。不得被生产 tick 自动调用（架构测试守护）。
   */
  resolveUnresolvedTransaction(input: {
    readonly transactionId: string;
    readonly digest?: string;
    readonly capability: TreasuryReconciliationCapability;
    /** pre-execution authorization fault 的显式确认（第十一轮 3.13.1；其他 fault 不适用）。 */
    readonly acknowledgeRolledBack?: boolean;
  }): TreasuryFaultResolutionResult;
  // 【第十一轮 3.13.8】capability consume/validate、service generation、
  // resolution guard 已从公共接口移除——resolution kernel 经
  // TREASURY_RESOLUTION_KERNEL symbol 通道（facade 闭包挂载，
  // faultResolution/testHarness 访问）；普通生产调用者类型与运行时枚举
  // 均不可达（capability 消费仍只在 staged resolution 写入成功后）。
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
    if (quarantineCount === 0 || intentCount === 0) {
      // 快速路径：单一 store 非空时不可能有同 ID 重叠（O(1)，模块计数零扫描）。
      return quarantineCount + intentCount + (activeHandles.size - intentBackedActiveIds.size);
    }
    // 慢速路径（事实转移窗口/防御残留的双存在）：按 ID 并集去重——一笔
    // transaction 只占一个 recovery slot（第十轮 5.1）。两 store 各 ≤64，
    // 此路径仅在实际重叠时进入。
    const quarantineIds = new Set(
      Object.keys(peekTreasuryQuarantineStore()?.entries ?? {}).map((key) => key.slice(2)),
    );
    let overlap = 0;
    for (const key of Object.keys(peekTreasuryIntentStore()?.entries ?? {})) {
      if (quarantineIds.has(key.slice(2))) overlap += 1;
    }
    return quarantineCount + intentCount - overlap + (activeHandles.size - intentBackedActiveIds.size);
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
  /**
   * finalized intent 的 cross-store proof（第十一轮 3.13.6 / 第十二轮 3.4）：
   * 按完整 attempt identity 校验——returned_ok 须 identity 匹配的 committed
   * proof；其余须 identity 匹配的 not-executed tombstone。proof 缺失或
   * identity 不一致 → 恢复路径 semantic fault（entry 保留不释放）。
   */
  function checkTreasuryFinalizedProof(
    transactionId: string,
    outcome: string,
    attempt: { readonly digest: string; readonly contractDigest?: string; readonly authorizationCohortDigest?: string; readonly durableIdentityDigest?: string },
  ): string | null {
    return recoveryCoordinator.checkTreasuryFinalizedProof(transactionId, outcome, attempt);
  }

/** 服务实例代际：跨 service 实例的 handle 一律无效（global reset 防御）。 */
  const serviceGeneration = nextTreasuryServiceGeneration();

  // ── 内部权威模块（第十一轮 3.13.10 自 facade 抽出；facade 保留生命周期
  //    编排与执行顺序——不再直接持有 bundle Maps/capability WeakSets/
  //    resolution kernel 细节；下列闭包函数为对模块的委托壳）。 ─────────────
  const authorizationLedger = createTreasuryAuthorizationLedger({
    serviceGeneration,
    metrics,
    currentRevisions: () => currentAuthorizationRevisions(),
  });
  const resolutionAuthorityInternal = createTreasuryResolutionAuthority({
    serviceGeneration,
    metrics,
  });
  const recoveryCoordinator = createTreasuryRecoveryCoordinator({
    metrics,
    quarantineDeltasOf: (record) => quarantineDeltasOf(record as PreparedTransaction),
  });
  // 【第十七轮第七节】service-issued opaque rearm capability authority
  //（闭包私有——跨实例隔离；heap-only 生命周期与 generation/tick 绑定）。
  const rearmCapabilityAuthority = createTreasuryRearmCapabilityAuthority({
    serviceGeneration,
  });
  // 【第十七轮第五节】lineage 恢复的 marker 只读视图装配（模块单向依赖：
  // attemptLineage 不直接 import writeFault 的清除语义）。
  setTreasuryLineageRecoveryMarkerReaderForAssembly(() => {
    const marker = readTreasuryWriteFault();
    return marker === undefined
      ? undefined
      : { transactionId: marker.transactionId, digest: marker.digest };
  });
  // 【第十八轮 24.3】lineage 恢复的 committed receipt proof 只读视图装配
  //（commit-pending 补完成：receipt 是 durable 权威——binding/generation 匹配
  // 才补完成 chain_committed）。
  setTreasuryLineageReceiptReaderForAssembly((transactionId) => {
    const lookup = lookupTreasurySettledReceipt(transactionId);
    if (lookup.status !== "modern_committed") return undefined;
    return {
      binding: lookup.proof.lineageBindingDigest,
      generation: lookup.proof.lineageGeneration,
    };
  });
  /** bundle 签发序号（authorizationDigest 唯一性成分）。 */
  let bundleSequence = 0;
  /** write readiness 状态来源（query/authorize 共用收集器；一次装配）。 */
  const readinessSources: TreasuryReadinessStateSources = {
    lifecycleClosed: () => current?.ended === true,
    staleTickState: () => (current?.tick ?? Game.time) !== Game.time,
    writeFaultLocked: () => isTreasuryWriteAdmissionLocked(),
    writeFaultUnhealthy: () => !peekTreasuryWriteFaultHealth().healthy,
    invalidOwner: () => false,
    commitmentIncomplete: () => false,
    quarantineUnhealthy: () => !peekTreasuryQuarantineHealth().healthy,
    quarantineUnresolved: () => treasuryQuarantineBlockers().blocking,
    intentUnhealthy: () => !peekTreasuryIntentHealth().healthy,
    intentUnresolved: () => treasuryIntentBlockers().blocking,
    reservationMigrationIncomplete: () => !isReservationOwnerMigrationComplete(),
    reservationStoreUnhealthy: () => !validateReservationStoreHealth().healthy,
    reservationStoreCorrupted: () => isReservationStoreCorrupted(),
    receiptUnhealthy: () => !peekTreasuryReceiptHealth().healthy,
    receiptCapacityExhausted: () => readTreasuryReceiptEventCounters().slotsRemaining <= 0,
    resolutionStoreUnhealthy: () => !peekTreasuryResolutionStoreHealth().healthy,
    // 【第十五轮第十节】resolving blocker 改经缓存计数：store 存在时触发完整
    // load/migration 后读取 heap 缓存（轻量 probe 未 load 时不再全表扫描）。
    resolutionResolvingBlocker: () => treasuryResolutionResolvingInProgress(),
    recoverySlotExhausted: () => recoverySlotsOccupied() >= TREASURY_QUARANTINE_MAX_ENTRIES,
    // 【第十四轮第十四节】authorization-fault 完整 validation 门禁：在真正
    // 准备 production action 之前（readiness 收集即 admission 输入）触发
    // load 全量验证（首次有界全表扫描，heap 缓存后 O(1)）——损坏 entry 不得
    // 等 redemption fault 后才发现；store 不存在时零写不隐式创建。
    authorizationFaultUnresolved: () => {
      const validationFatal = ensureTreasuryAuthorizationFaultStoreValidated();
      if (validationFatal !== null) return true;
      return treasuryAuthorizationFaultBlockers().blocking;
    },
    // 【第十二轮 3.1.6】fault authority 容量前置 admission：满载时阻断新
    // writer——不得等 redemption 故障发生后才发现 fault store 已满。
    authorizationFaultCapacityExhausted: () => peekTreasuryAuthorizationFaultHealth().entryCount >= TREASURY_AUTHORIZATION_FAULT_MAX_ENTRIES,
    policyNotReady: () => !treasuryPolicyAuthorityReady(),
    authorizationCapacityExhausted: () => authorizationLedger.activeCount() >= TREASURY_AUTHORIZATION_ACTIVE_LIMIT,
  };

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
    record: Parameters<TreasuryAuthorizationLedger["releaseAuthorizationBudget"]>[1],
  ): void {
    authorizationLedger.releaseAuthorizationBudget(token, record);
  }

  /**
   * 批量原子 bundle redemption（第十轮 3.12.4，闭包私有——只经
   * executePreparedAction 的 execution.authorizationBundle 调用）：
   * 1. 只读预验证：bundle registry 对象身份 + cohort（contract 匹配/
   *    generation/tick/revisions）+ 全部 legs 逐项校验 + 联合 posting
   *    coverage——零状态变化；
   * 2. staged 发布：逐 leg 预算减少与消费按序发布；注入点（first_leg/
   *    middle_leg/last_leg/before_budget_publish/before_tentative_handoff/
   *    before_bundle_state）任一触发即**前缀完整回滚**（预算/容量/消费标记
   *    恢复原状、bundle 保持 active、tentative 不残留）并写入
   *    internal_authorization_fault marker（阻断后续 writer——审计要求显式
   *    确认，即使状态已一致回滚）；
   * 3. 成功：bundle 进入 redeemed 终态（单次 redemption；重复拒绝且不重复
   *    释放预算）。
   * 不再依赖"预验证后理论不会失败"——apply 阶段的任何异常同样回滚并进入
   * internal fault。
   */
  function redeemAuthorizationBundleAtomic(
    bundle: TreasuryAuthorizationBundle,
    context: Parameters<TreasuryAuthorizationLedger["redeemAuthorizationBundleAtomic"]>[1],
  ): ReturnType<TreasuryAuthorizationLedger["redeemAuthorizationBundleAtomic"]> {
    return authorizationLedger.redeemAuthorizationBundleAtomic(bundle, context);
  }


  /**
   * opaque bundle 只读解析（第十轮 3.12.3）：registry 对象身份 + contract
   * 匹配校验，返回 authorizationDigest（intent 持久化用）。零状态变化、
   * 零消费——redemption 时 redeemAuthorizationBundleAtomic 独立重验。
   */
  function resolveAuthorizationBundleReadOnly(
    bundle: unknown,
    contract: Parameters<TreasuryAuthorizationLedger["resolveAuthorizationBundleReadOnly"]>[1],
  ): ReturnType<TreasuryAuthorizationLedger["resolveAuthorizationBundleReadOnly"]> {
    return authorizationLedger.resolveAuthorizationBundleReadOnly(bundle, contract);
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
    recoveryCoordinator.quarantineFaultedRecord(record, detail);
  }

  /** executing/faulted handle → durable quarantine（tick 边界分类；幂等保留首条）。 */
  function quarantinePreparedRecord(record: PreparedTransaction): void {
    recoveryCoordinator.quarantinePreparedRecord(record);
  }

  /**
   * durable 事实转移统一入口（第十轮 5.1）：优先走 intent → quarantine v2
   * 转移协议（完整合同事实 + 读回验证后释放 intent slot）；intent 缺失的
   * 防御分支按 fault phase 单调推导 outcome 直写最小 v2 entry。任何写入被
   * 拒/读回不一致：marker 已锁全部 writer，计数诊断，intent（若在）保留为
   * emergency authority——绝不静默丢失占用事实。
   */
  function transferRecordToQuarantine(record: PreparedTransaction, faultPhase: TreasuryWriteFaultPhase): void {
    recoveryCoordinator.transferRecordToQuarantine(record, faultPhase);
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
          // 【第十七轮第十四节】class-aware attempt identity。
          ...classAwareMarkerFieldsOfFacts({
            contractDigest: record.contractDigest,
            ...(record.lineageBindingDigest !== undefined ? { lineageBindingDigest: record.lineageBindingDigest } : {}),
            ...(record.lineageGeneration !== undefined ? { lineageGeneration: record.lineageGeneration } : {}),
            ...(record.lineageId !== undefined ? { lineageId: record.lineageId } : {}),
          }),
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
      recoverTreasuryIntentsAtTickBoundary(checkTreasuryFinalizedProof);
      // 【第十七轮第五节】先快照 pending-release 索引（recoverStagedResolutions
      // 的补完成会移除索引项——lineage backfill 需要处理前的完整清单）。
      const pendingReleaseSnapshot = listTreasuryPendingReleaseIds();
      // staged resolution 恢复（第八轮 8.2）：中断的 resolution 幂等完成/
      // 回滚（resolving+receipt 已写 → finalize；无进展 → 回滚；final 未
      // 释放 → 补完成）。
      recoverStagedResolutions();
      // 【第十七轮第五节】durable attempt lineage 恢复（位于 resolution 恢复
      // 之后——释放/清 marker 的补完成先行，lineage 三段随后按最终持久事实
      // 收敛）：capability_issued 跨 tick 回退 rearm_ready；child_intent_
      // pending 回滚/前向补完成；retiring 三段补完成；child_active 的
      // commit-pending 补完成；Round 16 遗留 tombstone backfill。空闲（pending
      // 与 pendingRelease 索引均空）O(1) 快路径。
      recoverTreasuryAttemptLineageAtTickBoundary(pendingReleaseSnapshot);
      // 【第十八轮 24.10】终态压缩（有界：只处理 terminalIds——空闲零成本）：
      // chain_committed / non_rearmable_retired → retirement summary（精确
      // 永久 root 门禁）并释放 active slot。
      compactTreasuryTerminalLineagesAtTickBoundary();
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

  // 内部完整实现载体（含低层 writer 原语——第十轮 3.12.5 起**不**作为公共
  // service 的可枚举属性暴露；kernel 经 symbol 通道引用）。
  const internalService = {
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

      const commitments = internalService.commitments();
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
      // 【第十四轮第十四节】authorization-fault store 损坏（完整 load 验证
      // 检出）→ 授权上下文不安全（readiness fail closed 的 authorizationSafe
      // 对应维度——损坏 entry 不得等 redemption fault 后才发现）。
      const authorizationFaultFatal = ensureTreasuryAuthorizationFaultStoreValidated();
      if (authorizationFaultFatal !== null) blockers.push("authorization_fault_unhealthy");
      const authorizationSafe = authorizable && blockers.length === 0;

      // ── write readiness 额外准入（第十轮 3.12.10）：统一评估器
      //    evaluateTreasuryWriteReadiness（一套枚举/优先级/来源——authorize
      //    前置与 prepare 复查共用；receipt 容量/recovery slot/reservation
      //    corruption/resolution 面/policy/authorization capacity）。 ────────
      const receiptCounters = readTreasuryReceiptEventCounters();
      const readiness = evaluateTreasuryWriteReadiness(
        // 【第十一轮 3.13.10】单一收集器：query 已探测的 health 局部缓存经
        // overrides 复用（零重复探测），其余来源走共享 readinessSources。
        collectTreasuryWriteReadinessInputs(readinessSources, {
          lifecycleClosed: state.ended,
          staleTickState: state.tick !== Game.time,
          writeFaultUnhealthy: !writeFaultHealth.healthy,
          invalidOwner: !ownerCheck.valid && Boolean(context.owner),
          commitmentIncomplete: !commitmentComplete,
          quarantineUnhealthy: !quarantineHealthForAuth.healthy,
          quarantineUnresolved: quarantineBlock.blocking,
          intentUnhealthy: !intentHealthForAuth.healthy,
          intentUnresolved: intentBlock.blocking,
          reservationStoreUnhealthy: !reservationHealth.healthy,
          receiptUnhealthy: !receiptHealth.healthy,
          receiptCapacityExhausted: receiptCounters.slotsRemaining <= 0,
        }),
        "query",
      );
      const writeAdmissionBlockers: string[] = [...blockers];
      for (const blocker of readiness.blockers) {
        if (!writeAdmissionBlockers.includes(blocker)) writeAdmissionBlockers.push(blocker);
      }

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
      const invalidatedTokens = authorizationLedger.invalidateOnRevisionChange();
      if (invalidatedTokens > 0) {
        metrics.authorizationInvalidated += invalidatedTokens;
      }
      // 活跃授权上限（heap 有界）。
      if (authorizationLedger.activeCount() >= TREASURY_AUTHORIZATION_ACTIVE_LIMIT) {
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
      const view = internalService.query({
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
      const budgetedOutflow = authorizationLedger.budgetedOutflowFor(request.rooms, locations, request.resource);
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
        const budgetedCapacity = authorizationLedger.budgetedCapacityFor(capKey);
        const riskAdjustedFree = internalService.projectedFreeCapacity(cap.roomName, cap.locationKind) - budgetedCapacity;
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
      const outflowKeys: string[] = [];
      for (const roomName of request.rooms) {
        for (const kind of locations) {
          outflowKeys.push(`${roomName}\u0000${kind}\u0000${request.resource}`);
        }
      }
      authorizationLedger.registerIssuedToken(token, {
        outflowKeys,
        amount: request.amount,
        ...(request.capacityRequirement !== undefined
          ? {
              capacityKey: `${request.capacityRequirement.roomName}\u0000${request.capacityRequirement.locationKind}`,
              capacityAmount: request.capacityRequirement.amount,
            }
          : {}),
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
      if (!token || typeof token !== "object" || !authorizationLedger.hasToken(token)) {
        return { status: "rejected", reason: "invalid_token", detail: "token 未在本服务实例签发（伪造对象/JSON 副本/跨实例一律无效）" };
      }
      const record = authorizationLedger.getRecord(token);
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
        authorizationLedger.releaseAuthorizationBudget(token, record);
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
      authorizationLedger.releaseAuthorizationBudget(token, record);
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
      readonly reason: "invalid_input" | "contract_invalid" | "adapter_not_registered" | "write_admission_blocked" | "authorization_policy_violation" | "authorization_context_unsafe" | "insufficient_amount" | "capacity_overflow" | "authorization_capacity_exhausted" | "policy_not_ready" | "authorization_invalid";
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
      // ──【第十七轮第八节/第十节】tr1_ 保留命名空间门禁（authorization 层）：
      //    tr1_ child contract 必须携带匹配 opaque rearm capability——验证
      //    capability（对象身份/generation/tick/lineage revision）+ child
      //    绑定 + retry semantic digest 重算比较。授权失败（policy/资源/容量）
      //    capability 不消费、lineage 保持 ready（同 tick 修正后重试或下 tick
      //    重新签发）。非 tr1_ contract 携带 capability 一律拒绝（initial
      //    attempt 不得携带 lineage binding）。 ───────────────────────────────
      let authorizedRearmBinding:
        | {
            readonly capabilityDigest: string;
            readonly lineageId: string;
            readonly childTransactionId: string;
            readonly retrySemanticDigest: string;
            readonly parentTransactionId: string;
            readonly lineageBindingDigest: string;
            readonly attemptGeneration: number;
          }
        | undefined;
      if (isTreasuryRearmAttemptId(verifiedContract.transactionId)) {
        const capabilityValidation = rearmCapabilityAuthority.validateRearmCapability(options?.rearmCapability);
        if (capabilityValidation.status !== "valid") {
          metrics.authorizationRejected += 1;
          return {
            status: "rejected",
            reason: options?.rearmCapability === undefined ? "invalid_input" : "authorization_invalid",
            detail: options?.rearmCapability === undefined
              ? `tr1_ child contract 授权必须携带 opaque rearm capability（issueTreasuryRearmCapability 签发——options.rearmCapability）`
              : `tr1_ rearm capability 验证失败（${capabilityValidation.reason}）: ${capabilityValidation.detail}`,
          };
        }
        const tr1Capability = capabilityValidation.capability;
        const capabilityMatch = treasuryRearmCapabilityMatches(tr1Capability, {
          childTransactionId: verifiedContract.transactionId,
          actionKind: verifiedContract.actionKind,
          ...(verifiedContract.adapterSemanticIdentity !== undefined ? { adapterSemanticIdentity: verifiedContract.adapterSemanticIdentity } : {}),
        });
        if (capabilityMatch.status === "rejected") {
          metrics.authorizationRejected += 1;
          return { status: "rejected", reason: "authorization_invalid", detail: capabilityMatch.detail };
        }
        // owner 默认必须与 parent 一致（capability 绑定 owner；contract 授权
        // 传入的 owner key 不一致即拒绝——本轮不支持自由 owner 迁移）。
        if (tr1Capability.binding.ownerIdentity !== undefined) {
          const contractOwnerKey = options?.owner !== undefined ? String(treasuryAuthorizationOwnerKey(options.owner)) : "";
          if (contractOwnerKey !== tr1Capability.binding.ownerIdentity) {
            metrics.authorizationRejected += 1;
            return {
              status: "rejected",
              reason: "authorization_invalid",
              detail: "tr1_ child contract 的 owner 与 parent lineage 绑定不一致（owner 迁移需独立显式协议——本轮不支持）",
            };
          }
        }
        // retry semantic digest 重算：child contract 的实际 Game 动作语义必须
        // 与 capability 绑定值完全一致（资源/数量/room/target/action kind/
        // adapter 语义/structure/durable payload 任一变化拒绝）。
        const recomputedRetrySemantic = computeTreasuryModernRetrySemanticDigest({
          actionKind: verifiedContract.actionKind,
          adapterVersion: verifiedContract.adapterVersion,
          ...(verifiedContract.adapterSemanticIdentity !== undefined ? { adapterSemanticIdentity: verifiedContract.adapterSemanticIdentity } : {}),
          ...(verifiedContract.adapterRetryFacts !== undefined ? { adapterRetryFacts: verifiedContract.adapterRetryFacts } : {}),
          ...(verifiedContract.canonicalArgsText !== undefined ? { canonicalArgsText: verifiedContract.canonicalArgsText } : {}),
          postings: verifiedContract.postings.map((leg) => ({ ...leg })),
          ...(verifiedContract.structureDescriptors.length > 0 ? { structureDescriptors: verifiedContract.structureDescriptors } : {}),
          ...(verifiedContract.durableFacts !== undefined ? { durablePayload: verifiedContract.durableFacts.payload, durablePayloadVersion: verifiedContract.durableFacts.version } : {}),
              // 【第十八轮 24.13】authorization 重算使用 contract source（单一权威）。
          source: verifiedContract.source,
          ...(options?.owner !== undefined ? { ownerIdentity: String(treasuryAuthorizationOwnerKey(options.owner)) } : {}),
        });
        if (recomputedRetrySemantic !== tr1Capability.binding.retrySemanticDigest) {
          metrics.authorizationRejected += 1;
          return {
            status: "rejected",
            reason: "authorization_invalid",
            detail: `retry semantic identity 不匹配（重算 ${recomputedRetrySemantic.slice(0, 12)}，capability 绑定 ${tr1Capability.binding.retrySemanticDigest.slice(0, 12)}）——child contract 不是 parent 动作的语义重试，capability 不消费`,
          };
        }
        authorizedRearmBinding = {
          capabilityDigest: hashTreasuryCanonicalString(`rearm-capability:${String(tr1Capability.serviceGeneration)}:${String(tr1Capability.tick)}:${String(tr1Capability.nonce)}`),
          lineageId: tr1Capability.binding.lineageId,
          childTransactionId: tr1Capability.binding.childTransactionId,
          retrySemanticDigest: tr1Capability.binding.retrySemanticDigest,
          parentTransactionId: tr1Capability.binding.parentTransactionId,
          lineageBindingDigest: tr1Capability.binding.bindingDigest,
          attemptGeneration: tr1Capability.binding.generation,
        };
      } else if (options?.rearmCapability !== undefined) {
        metrics.authorizationRejected += 1;
        return {
          status: "rejected",
          reason: "invalid_input",
          detail: "非 tr1_ contract 不得携带 rearm capability（initial attempt 不携带 lineage binding）",
        };
      }
      // 【第十轮 3.12.9】policy authority 前置：调用方不得自带 withhold（自由
      // 数值不再有 policy 权威）；strategic reserve/withhold/emergency
      // override 由注册 policy resolver 计算（显式、可审计、版本化）——无
      // 注册 resolver 时 fail closed。
      if ("withhold" in (options ?? {})) {
        metrics.authorizationRejected += 1;
        return { status: "rejected", reason: "invalid_input", detail: "policy authority 拒绝调用方 withhold——额度扣减只能由注册 policy resolver 计算（删除 options.withhold）" };
      }
      const policyResolver = findTreasuryPolicyResolver();
      if (policyResolver === undefined) {
        metrics.authorizationRejected += 1;
        return { status: "rejected", reason: "policy_not_ready", detail: "未注册 policy resolver（production 授权 fail closed——注册边界见 policyAuthority.ts）" };
      }
      // ── write admission ready（第十轮 3.12.10：与 query 的 writeAdmission
      //    视图共用 evaluateTreasuryWriteReadiness 单一权威——一套 blocker
      //    枚举/优先级/状态来源；不满足时授权本身拒绝，不留"已授权但
      //    writer 阻断"的空转 token）。 ─────────────────────────────────────
      ensureTickState(true);
      const authorizeReadiness = evaluateTreasuryWriteReadiness(
        collectTreasuryWriteReadinessInputs(readinessSources, {
          policyNotReady: false, // policy 已在前置单独检查（携带专用 reason）
        }),
        "authorize",
      );
      if (!authorizeReadiness.ready) {
        metrics.authorizationRejected += 1;
        return {
          status: "rejected",
          reason: "write_admission_blocked",
          detail: `write readiness 未就绪（blockers: ${authorizeReadiness.blockers.join(",")}）——禁止新授权（与 query writeAdmission 同一权威）`,
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
      // 【第十一轮 3.13.3】per-resource policy 决策（注册 resolver 权威计算；
      // decision 由 Treasury 完整验证并**自行计算 digest**——resolver 自报
      // digest 通道已删除；evaluate 抛错结构化 fail closed）。
      const ownerKey = options?.owner !== undefined ? String(treasuryAuthorizationOwnerKey(options.owner)) : "";
      const policyDecisions = new Map<string, { withhold: number; digest: string }>();
      let policyEmergencyOverride = false;
      for (const [resource, need] of resourceOutflow) {
        const policyContext = {
          contractId: verifiedContract.contractId,
          contractDigest: verifiedContract.digest,
          actionKind: verifiedContract.actionKind,
          resource,
          rooms: [...need.rooms],
          ownerIdentity: ownerKey,
          tick: Game.time,
        };
        let decision: ReturnType<typeof policyResolver.evaluate>;
        try {
          decision = policyResolver.evaluate(policyContext);
        } catch (error) {
          metrics.authorizationRejected += 1;
          return {
            status: "rejected",
            reason: "authorization_policy_violation",
            detail: `policy_fault: resolver evaluate 抛错（资源 ${resource}: ${String(error instanceof Error ? error.message : error).slice(0, 96)}）——fail closed`,
          };
        }
        if ("status" in decision && decision.status === "rejected") {
          metrics.authorizationRejected += 1;
          return { status: "rejected", reason: "authorization_policy_violation", detail: `policy resolver 拒绝（资源 ${resource}）: ${decision.reason}` };
        }
        const typed = decision as TreasuryPolicyDecision;
        const decisionError = validateTreasuryPolicyDecision(typed);
        if (decisionError !== null) {
          metrics.authorizationRejected += 1;
          return { status: "rejected", reason: "authorization_policy_violation", detail: `policy decision 非法（资源 ${resource}）: ${decisionError}` };
        }
        const digest = computeTreasuryPolicyDecisionDigest(policyResolver, policyContext, typed);
        if (typed.emergencyOverride) policyEmergencyOverride = true;
        policyDecisions.set(resource, { withhold: typed.withhold, digest });
      }
      // 原子签发：逐资源授权；任一失败回滚已签发 token 的全部预算。
      const issued: TreasuryAuthorizationToken[] = [];
      const rollbackIssued = (): void => {
        for (const token of issued) {
          const record = authorizationLedger.getRecord(token);
          if (record !== undefined) authorizationLedger.releaseAuthorizationBudget(token, record);
        }
      };
      for (const [resource, need] of resourceOutflow) {
        const result = internalService.authorizeResourceUse({
          transactionId: verifiedContract.transactionId,
          actionKind: verifiedContract.actionKind,
          resource,
          rooms: [...need.rooms],
          locations: [...need.locations],
          amount: need.amount,
          contractDigest: verifiedContract.digest,
          adapterVersion: verifiedContract.adapterVersion,
          ...(options?.owner !== undefined ? { owner: options.owner } : {}),
          // policy resolver 决策的 withhold（内部计算——调用方无此通道）。
          withhold: policyDecisions.get(resource)!.withhold,
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
      // 全部 legs 同源签发（同一同步循环、同 revision 快照、同 generation/
      // tick）——cohort 一致性由签发路径结构性保证；防御性校验 revision 单一。
      const firstRevisions = issued[0].revisions;
      const cohortConsistent = issued.every(
        (token) =>
          token.revisions.commitmentRevision === firstRevisions.commitmentRevision &&
          token.revisions.projectionRevision === firstRevisions.projectionRevision &&
          token.revisions.quarantineRevision === firstRevisions.quarantineRevision &&
          token.revisions.intentRevision === firstRevisions.intentRevision &&
          token.revisions.reservationStoreRevision === firstRevisions.reservationStoreRevision,
      );
      if (!cohortConsistent) {
        rollbackIssued();
        metrics.authorizationRejected += 1;
        return { status: "rejected", reason: "invalid_input", detail: "bundle legs 的 revision cohort 不一致（内部不变量破坏——拒绝签发）" };
      }
      bundleSequence += 1;
      void bundleSequence;
      const authorizationDigest = hashTreasuryCanonicalString(
        `bundle:${verifiedContract.digest}:${verifiedContract.transactionId}:${String(bundleSequence)}:${String(serviceGeneration)}:${String(Game.time)}`,
      );
      const policyDecisionDigest = [...policyDecisions.values()].map((d) => d.digest).sort().join(",");
      // opaque bundle：生产调用者只拿到不可读句柄（legs/cohort 仅闭包可见）。
      const bundle: TreasuryAuthorizationBundle = Object.freeze({ __brand: "treasury-authorization-bundle" });
      // 【第十一轮 3.13.4】durable cohort 事实（owner/policy/epoch/revision/
      // legs/receiver capacity/bundle identity）与 canonical cohort digest。
      const cohortFacts: TreasuryAuthorizationCohortFacts = {
        ownerIdentity: ownerKey,
        policyId: policyResolver.policyId,
        policyVersion: policyResolver.policyVersion,
        policyRegistrationId: policyResolver.registrationId,
        policyDecisionDigest,
        emergencyOverride: policyEmergencyOverride,
        epochSeq: verifiedContract.epoch.epochSeq,
        revisions: {
          commitmentRevision: firstRevisions.commitmentRevision,
          projectionRevision: firstRevisions.projectionRevision,
          quarantineRevision: firstRevisions.quarantineRevision,
          intentRevision: firstRevisions.intentRevision,
          reservationStoreRevision: firstRevisions.reservationStoreRevision,
        },
        adapterRegistrationId: verifiedContract.adapterRegistrationId,
        ...(verifiedContract.adapterSemanticIdentity !== undefined ? { adapterSemanticIdentity: verifiedContract.adapterSemanticIdentity } : {}),
        contractId: verifiedContract.contractId,
        contractDigest: verifiedContract.digest,
        transactionId: verifiedContract.transactionId,
        authorizationLegDigests: issued.map((token) => canonicalTreasuryAuthorizationLegDigest(token)),
        receiverCapacityDigest: canonicalTreasuryReceiverCapacityDigest(options?.capacityRequirement),
        issuedTick: Game.time,
        authorizationDigest,
      };
      const cohortDigest = computeTreasuryAuthorizationCohortDigest(cohortFacts);
      authorizationLedger.registerBundle(bundle, {
        tokens: Object.freeze([...issued]),
        contractId: verifiedContract.contractId,
        contractDigest: verifiedContract.digest,
        transactionId: verifiedContract.transactionId,
        actionKind: verifiedContract.actionKind,
        adapterVersion: verifiedContract.adapterVersion,
        adapterRegistrationId: verifiedContract.adapterRegistrationId,
        ...(verifiedContract.adapterSemanticIdentity !== undefined ? { adapterSemanticIdentity: verifiedContract.adapterSemanticIdentity } : {}),
        ownerIdentity: ownerKey,
        policyIdentity:
          policyResolver.policyId + "@v" + String(policyResolver.policyVersion) + ":" + policyDecisionDigest,
        policyRegistrationId: policyResolver.registrationId,
        policyDecisionDigest,
        policyEmergencyOverride,
        revisions: firstRevisions,
        serviceGeneration,
        tick: Game.time,
        authorizationDigest,
        cohort: cohortFacts,
        cohortDigest,
        // 【第十七轮第十节】rearm capability 绑定进 bundle 私有 record（tr1_
        // child 专属；redemption 验证与 marker class-aware 身份继承）。
        ...(authorizedRearmBinding !== undefined
          ? {
              rearmBindingDigest: authorizedRearmBinding.capabilityDigest,
              rearmLineageId: authorizedRearmBinding.lineageId,
              rearmChildTransactionId: authorizedRearmBinding.childTransactionId,
              rearmRetrySemanticDigest: authorizedRearmBinding.retrySemanticDigest,
              rearmParentTransactionId: authorizedRearmBinding.parentTransactionId,
              rearmLineageBindingDigest: authorizedRearmBinding.lineageBindingDigest,
              rearmAttemptGeneration: authorizedRearmBinding.attemptGeneration,
            }
          : {}),
        state: "active",
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
      contract: Parameters<TreasuryAuthorizationLedger["validateTreasuryAuthorizationForRedeem"]>[1],
      postings: readonly TreasuryPosting[],
    ): ReturnType<TreasuryAuthorizationLedger["validateTreasuryAuthorizationForRedeem"]> {
      return authorizationLedger.validateTreasuryAuthorizationForRedeem(tokens, contract, postings);
    },

    prepareTransaction(input: TreasuryTransactionInput, prepareOptions?: {
      /** 【第十七轮第八节】tr1_ rearm child 的 opaque capability（kernel 内部通道）。 */
      readonly rearmCapability?: unknown;
    }): TreasuryPreparationResult {
      // runtime input 形状验证（canonicalization 前置）：malformed input 结构化
      // 拒绝（invalid_input）而非抛出中断 tick——零 tentative/零槽位/零 registry。
      const inputShapeError = validateTreasuryTransactionInputShape(input);
      if (inputShapeError !== null) {
        metrics.transactionsRejectedInvalid += 1;
        return { status: "rejected", reason: "invalid_input", detail: inputShapeError };
      }
      // 【第十七轮第八节】tr1_ 保留命名空间门禁：tr1_ ID 必须绑定匹配
      // service-issued opaque rearm capability（initial attempt 不得使用
      // tr1_；手工拼接/无 capability 一律拒绝——bundle 零签发、intent 零创建、
      // callback 零调用）。capability 经 kernel 内部通道传入（executePrepared
      // Action 的 tr1_ 接管协议——公共调用方无法直接提供伪造对象）。
      if (isTreasuryRearmAttemptId(input.transactionId)) {
        const capabilityValidation = rearmCapabilityAuthority.validateRearmCapability(prepareOptions?.rearmCapability);
        if (capabilityValidation.status !== "valid") {
          metrics.transactionsRejectedInvalid += 1;
          return {
            status: "rejected",
            reason: prepareOptions?.rearmCapability === undefined ? "rearm_capability_required" : "rearm_capability_invalid",
            detail: prepareOptions?.rearmCapability === undefined
              ? `transactionId ${input.transactionId.slice(0, 24)} 属于 tr1_ 保留命名空间——必须携带 service 签发的 opaque rearm capability（issueTreasuryRearmCapability）`
              : `tr1_ rearm capability 验证失败（${capabilityValidation.reason}）: ${capabilityValidation.detail}`,
          };
        }
        const capability = capabilityValidation.capability;
        const match = treasuryRearmCapabilityMatches(capability, { childTransactionId: input.transactionId });
        if (match.status === "rejected") {
          metrics.transactionsRejectedInvalid += 1;
          return { status: "rejected", reason: "rearm_capability_invalid", detail: match.detail };
        }
        // lineage 必须处于 capability_issued（或未持久化推进的 rearm_ready
        // 幂等重入——同 tick 同 lineage 的 capability 由 revision 校验覆盖）。
        const lineage = readTreasuryAttemptLineageRecord(capability.binding.lineageId);
        if (lineage === undefined || (lineage.state !== "capability_issued" && lineage.state !== "rearm_ready")) {
          metrics.transactionsRejectedInvalid += 1;
          return {
            status: "rejected",
            reason: "rearm_capability_invalid",
            detail: `lineage 状态 ${lineage === undefined ? "missing" : String(lineage.state)} 不允许 tr1_ prepare（须 capability_issued）`,
          };
        }
      } else if (prepareOptions?.rearmCapability !== undefined) {
        // 非 tr1_ attempt 携带 rearm capability：协议混乱——initial attempt
        // 不得携带 lineage binding。
        metrics.transactionsRejectedInvalid += 1;
        return {
          status: "rejected",
          reason: "invalid_input",
          detail: "非 tr1_ attempt 不得携带 rearm capability（initial attempt 不携带 lineage binding）",
        };
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
      // 【第十六轮第五节】same-ID 不可重试：同 ID 存在 final not-executed
      // tombstone（authority 已释放的完成态）时拒绝直接 prepare——一个
      // transaction ID 永远只标识一个执行 attempt，重试必须显式 rearm 生成
      // child attempt ID（rearmResolvedNotExecutedAttempt）。resolving/
      // committed 形态由其它门禁承载（resolving → transaction_quarantined/
      // resolution_in_progress；committed → already_settled）。
      if (peekTreasuryResolutionStoreEntry() !== undefined) {
        const notExecutedTombstone = readTreasuryResolutionTombstone(input.transactionId);
        if (notExecutedTombstone !== undefined && notExecutedTombstone.stage === "final" && notExecutedTombstone.resolution === "not-executed") {
          metrics.transactionsRejectedInvalid += 1;
          return {
            status: "rejected",
            reason: "rearm_required",
            detail: `transactionId ${input.transactionId.slice(0, 48)} 已 final not-executed（同 ID 只标识一个执行 attempt）——重试必须显式 rearm 生成 child attempt ID（service.issueTreasuryRearmCapability），不得直接重用 parent ID`,
          };
        }
      }
      // 【第十七轮第五节】永久 retired 门禁（root ∪ current O(1) 索引）：
      // root attempt ID 只要存在 lineage record 即永久 retired——即使 final
      // tombstone 已按普通 retention 驱逐，lineage store 仍阻断同 ID 直接
      // prepare（durable retirement 权威跨 tombstone retention 存续）。
      // tr1_ current 由上文 capability 门禁承载（前缀即门禁）。
      if (!isTreasuryRearmAttemptId(input.transactionId) && peekTreasuryAttemptLineageHealth().entryCount > 0) {
        const retiredLineage = lookupTreasuryAttemptLineageByAttemptId(input.transactionId);
        if (retiredLineage !== undefined) {
          metrics.transactionsRejectedInvalid += 1;
          return {
            status: "rejected",
            reason: retiredLineage.state === "rearm_ready" || retiredLineage.state === "capability_issued" ? "retired_attempt" : "retired_attempt",
            detail: `transactionId ${input.transactionId.slice(0, 48)} 存在于 durable attempt lineage（root/current——永久 retired，tombstone retention 不影响本门禁）；重试必须经 service.issueTreasuryRearmCapability 签发 opaque capability`,
          };
        }
      }
      // 【第十八轮 24.10】terminal retirement summary 门禁（压缩后的 chain——
      // root ID 永久拒绝；O(1) root 索引；store 损坏 fail closed）。
      if (!isTreasuryRearmAttemptId(input.transactionId)) {
        const summaryHealth = peekTreasuryRetirementSummaryHealth();
        if (!summaryHealth.healthy) {
          metrics.transactionsRejectedInvalid += 1;
          return {
            status: "rejected",
            reason: "retired_attempt",
            detail: `retirement summary store 损坏（${summaryHealth.detail ?? "unhealthy"}）——prepare fail closed（不把 store 损坏解释成 attempt 不存在）`,
          };
        }
        if (summaryHealth.entryCount > 0 && lookupTreasuryRetirementSummaryByRoot(input.transactionId) !== undefined) {
          metrics.transactionsRejectedInvalid += 1;
          return {
            status: "rejected",
            reason: "retired_attempt",
            detail: `transactionId ${input.transactionId.slice(0, 48)} 存在于 terminal retirement summary（chain 已压缩——root 永久 retired，不依赖 tombstone retention）`,
          };
        }
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
      // tentative 不会超卖）——handle 终态化。【第十三轮 5.2】现代路径按完整
      // attempt identity 区分：match 才幂等终态化（不重复 heap 发布、上层
      // 释放 intent）；legacy/insufficient proof 不得假装属于当前 modern
      // attempt、conflict 为明确 identity 冲突——两者不发布 heap committed
      // state、返回明确拒绝（上层 executed_unsettled 分支 quarantine 接管
      // authority 并阻断自动重试）。低层路径（无 durable identity）保持
      // replay-blocker 幂等语义。
      const settledBeforeCommit = projection.isSettled(record.canonical.transactionId);
      if (settledBeforeCommit !== undefined) {
        if (record.durableIdentityDigest !== undefined) {
          const proof = readTreasurySettlementProof(record.canonical.transactionId);
          const attempt: TreasuryAttemptIdentity = {
            digest: record.digest,
            ...(record.contractDigest !== undefined ? { contractDigest: record.contractDigest } : {}),
            ...(record.authorizationCohortDigest !== undefined
              ? { authorizationCohortDigest: record.authorizationCohortDigest }
              : {}),
            durableIdentityDigest: record.durableIdentityDigest,
          };
          const relation =
            proof === undefined || proof.level === "legacy"
              ? ("insufficient" as const)
              : treasuryAttemptIdentityRelation(
                  { ...proof, digest: proof.digest ?? record.digest },
                  attempt,
                );
          if (relation !== "match") {
            metrics.duplicateSettlementsRejected += 1;
            return {
              status: "rejected",
              reason: relation === "conflict" ? "settlement_identity_conflict" : "settlement_proof_insufficient",
              detail:
                relation === "conflict"
                  ? `同 id 既有 receipt proof 与当前 attempt identity 冲突（prepare→commit 窗口；settledAtTick ${String(settledBeforeCommit)}）——不发布 heap，保留 authority 待 resolution（fail closed）`
                  : `同 id 既有 receipt proof 无法证明当前 modern attempt（${proof === undefined ? "proof 不可读" : "legacy/身份不足 proof"}；settledAtTick ${String(settledBeforeCommit)}）——不冒充当前 attempt，保留 authority 待 resolution（fail closed）`,
            };
          }
        }
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
        // 【第十三轮】modern proof 的 attempt identity 须完整（digest 与
        // durableIdentityDigest 成对 + contract/cohort digest 同源携带）——
        // 低层两阶段路径（无 durable identity）写显式 legacy proof（replay
        // blocker 保留；不冒充现代证明）。
        const receipt = projection.publishPreparedReceipt(
          record.canonical.transactionId,
          Game.time,
          record.durableIdentityDigest !== undefined
            ? {
                digest: record.digest,
                durableIdentityDigest: record.durableIdentityDigest,
                ...(record.contractDigest !== undefined ? { contractDigest: record.contractDigest } : {}),
                ...(record.authorizationCohortDigest !== undefined
                  ? { authorizationCohortDigest: record.authorizationCohortDigest }
                  : {}),
                // 【第十六轮第十一节】低层路径（无 contract——intent authority
                // 为 lowlevel）的 receipt 绑定 runtime provenance：runtime 与
                // migrated 不能互相证明；缺 provenance 的旧 receipt 是隔离态。
                ...(record.contractDigest === undefined ? { lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME } : {}),
                // 【第十八轮 24.4】tr1_ rearm child 的 receipt 携带完整 lineage
                // proof（commit-pending 补完成与 generation 冲突检测的权威）。
                ...(record.lineageId !== undefined ? { lineageId: record.lineageId } : {}),
                ...(record.lineageGeneration !== undefined ? { lineageGeneration: record.lineageGeneration } : {}),
                ...(record.lineageParentTransactionId !== undefined ? { parentTransactionId: record.lineageParentTransactionId } : {}),
                ...(record.lineageBindingDigest !== undefined ? { lineageBindingDigest: record.lineageBindingDigest } : {}),
              }
            : undefined,
        );
        if (receipt.status === "fatal") {
          throw new TreasuryCommitFaultError("receipt_publish", receipt.detail);
        }
        if (receipt.status === "identity_conflict" || receipt.status === "already_settled_insufficient") {
          // 【第十三轮 5.2】post-callback 防御：既有 committed proof 与当前
          // attempt identity 冲突或证明不足（legacy proof）——不得发布 heap
          // committed state、不得覆盖既有 proof；进入明确 settlement fault
          //（上层 executed_unsettled 分支 quarantine 接管 authority 并阻断
          // 自动重试）。
          throw new TreasuryCommitFaultError(
            "receipt_publish",
            receipt.status === "identity_conflict"
              ? `同 id 既有 modern receipt proof 与当前 attempt identity 冲突（settledAtTick ${String(receipt.settledAtTick)}）——fail closed，不发布 heap`
              : `同 id 既有 receipt proof 无法证明当前 attempt（${receipt.relation}；settledAtTick ${String(receipt.settledAtTick)}）——不得冒充当前 modern attempt，不发布 heap`,
          );
        }
        // already_settled_match：既有 proof 与当前 attempt 完全一致——幂等
        // 结算（heap 本 tick 缓存未记录该 id，继续完成首次 heap 发布）。
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
        // 【第十七轮第五节】child committed → lineage 关闭（chain_committed：
        // 不再签发下一 child；【第十八轮 24.3】更新结果不忽略——失败时 intent
        // 保留为 commit-pending proof、返回 lineageFinalizationPending，
        // beginTick 按 matching receipt 补完成）。非 tr1_ attempt 无 lineage
        // 接管，跳过。
        let lineageFinalizationPending = false;
        if (record.lineageBindingDigest !== undefined && isTreasuryRearmAttemptId(record.canonical.transactionId)) {
          const chainLineage = lookupTreasuryAttemptLineageByAttemptId(record.canonical.transactionId);
          if (chainLineage !== undefined && chainLineage.state === "child_active") {
            const chained = closeTreasuryLineageAsChainCommitted(chainLineage.lineageId);
            lineageFinalizationPending = chained.status === "rejected";
          }
        }
        return {
          status: "committed",
          transactionId: record.canonical.transactionId,
          postings: heap.postings,
          tick: Game.time,
          ...(lineageFinalizationPending ? { lineageFinalizationPending: true } : {}),
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
          // 【第十七轮第十四节】class-aware attempt identity。
          ...classAwareMarkerFieldsOfFacts({
            contractDigest: record.contractDigest,
            ...(record.lineageBindingDigest !== undefined ? { lineageBindingDigest: record.lineageBindingDigest } : {}),
            ...(record.lineageGeneration !== undefined ? { lineageGeneration: record.lineageGeneration } : {}),
            ...(record.lineageId !== undefined ? { lineageId: record.lineageId } : {}),
          }),
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
      const prepared = internalService.prepareTransaction(input, {
        ...(execution?.rearmCapability !== undefined ? { rearmCapability: execution.rearmCapability } : {}),
      });
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
      let redeemedCohort: TreasuryAuthorizationCohortFacts | undefined;
      // ── 批量原子 redemption（第十轮 3.12.4）：tentative 已接管（prepare
      //    成功）、durable intent 写入与 Game callback 之前——全部 legs 一次
      //    性只读预验证 + staged 变更一次发布；任何注入故障前缀完整回滚或
      //    进入 internal authorization fault（阻断 writer）；redeem 拒绝时
      //    释放全部预留、callback 零调用。 ─────────────────────────────────
      if (execution?.authorizationBundle !== undefined) {
        const redeemed = redeemAuthorizationBundleAtomic(execution.authorizationBundle, {
          transactionId: record.canonical.transactionId,
          actionKind: record.canonical.kind,
          contractId: execution.intentContract?.contractId,
          contractDigest: execution.intentContract?.contractDigest,
          adapterVersion: execution.intentContract?.adapterVersion,
          postings: record.shape.merged as readonly TreasuryPosting[],
        });
        // durable cohort（第十一轮 3.13.4）：redemption 成功的事实随 intent 持久化。
        if (redeemed.status === "ok" && redeemed.cohort !== undefined) {
          redeemedCohort = redeemed.cohort;
        }
        if (redeemed.status === "rejected") {
          record.state = "aborted";
          preparedById.delete(record.canonical.transactionId);
          projection.tentativeRelease(record.tentativeKey);
          releaseTreasuryReceiptReservation(record.canonical.transactionId);
          finalizeHandleRecord(record, "aborted");
          metrics.authorizationRejected += 1;
          return {
            status: "prepare_rejected",
            reason: redeemed.reason === "internal_authorization_fault" ? "internal_authorization_fault" : "authorization_invalid",
            detail: `授权 redemption 失败（${redeemed.reason}）: ${redeemed.detail}——tentative 已释放，Game callback 零调用`,
          };
        }
      } else if (execution?.redeemAuthorization !== undefined) {
        // 兼容 hook（测试注入；production 路径已改 authorizationBundle）。
        // 【第十四轮】hook 可携带 cohort facts（contract 路径测试注入的
        // modern 定级成对输入）。
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
        if (redeemed.cohort !== undefined) {
          redeemedCohort = redeemed.cohort;
        }
      }
      // 【第十三轮】commit 段 receipt proof 绑定完整 attempt 身份（与
      // durable identity 同源派生；低层路径无 contract 时缺省）。
      record.contractDigest = execution?.intentContract?.contractDigest;
      record.authorizationCohortDigest =
        redeemedCohort !== undefined ? computeTreasuryAuthorizationCohortDigest(redeemedCohort) : undefined;
      // ── durable intent / WAL（第八轮唯一安全顺序）：Game API 之前持久化
      //    transaction identity + canonical postings——写入失败时 callback
      //    零调用、tentative 与槽位释放、结构化拒绝。第九轮：contract 路径
      //    经 execution.intentContract 绑定完整合同身份（contractId/digest/
      //    adapterVersion/authorizationDigest/durable payload）。【第十四轮
      //    第九节 9.4】production 定级边界：contract + bundle redemption
      //    （cohort 成对）→ modern；纯低层（无 contract 且无 cohort）→
      //    lowlevel；**partial-modern（有 contract 无 cohort 或反之）→ 内部
      //    不变量破坏——拒绝执行、callback 零调用、fail closed（绝不写
      //    lowlevel）**。 ─────────────────────────────────────────────────
      const hasIntentContract = execution?.intentContract !== undefined;
      const hasRedeemedCohort = redeemedCohort !== undefined;
      if (hasIntentContract !== hasRedeemedCohort) {
        record.state = "aborted";
        preparedById.delete(record.canonical.transactionId);
        projection.tentativeRelease(record.tentativeKey);
        releaseTreasuryReceiptReservation(record.canonical.transactionId);
        finalizeHandleRecord(record, "aborted");
        metrics.authorizationRejected += 1;
        return {
          status: "prepare_rejected",
          reason: "authority_invariant_violation",
          detail: `production 定级不变量破坏（intentContract=${String(hasIntentContract)}，redeemedCohort=${String(hasRedeemedCohort)}——partial-modern 不得写 lowlevel authority）——Game callback 零调用，预留已释放，fail closed`,
        };
      }
      const intentAuthorityLevel: TreasuryAuthorityLevel = hasIntentContract ? "modern" : "lowlevel";
      // ──【第十七轮第十节】tr1_ rearm child 的接管协议（Game callback 之前；
      //    位于全部 contract/authorization/readiness 检查之后）：capability
      //    完整验证 → retry semantic 重算比较 → lineage → child_intent_
      //    pending。任一失败 callback 零调用、预留全部释放（结构化拒绝）；
      //    consume 与 child_active 推进在 intent read-back 一致后（下文）。──
      // 【第十二轮 3.5】低层（非 contract）路径同样绑定稳定语义身份：intent
      // 写入时从当前 registry 读取该 kind 的 adapter semanticIdentity（同一
      // registry 的 reconciler 语义锚点；contract 路径以 contract 携带值为准）。
      const intentAdapterSemanticIdentity =
        execution?.intentContract?.adapterSemanticIdentity ??
        findTreasuryActionAdapter(record.canonical.kind)?.semanticIdentity;
            let tr1LineageBindingDigest: string | undefined;
      let tr1LineageGeneration: number | undefined;
      let tr1LineageId: string | undefined;
      let tr1LineageParentTransactionId: string | undefined;
      if (isTreasuryRearmAttemptId(record.canonical.transactionId)) {
        const abortTr1 = (reason: "rearm_capability_invalid" | "lineage_store_fatal", detail: string): TreasurySafeExecuteResult<TAction> => {
          record.state = "aborted";
          preparedById.delete(record.canonical.transactionId);
          projection.tentativeRelease(record.tentativeKey);
          releaseTreasuryReceiptReservation(record.canonical.transactionId);
          finalizeHandleRecord(record, "aborted");
          metrics.transactionsRejectedInvalid += 1;
          return { status: "prepare_rejected", reason, detail };
        };
        const capabilityValidation = rearmCapabilityAuthority.validateRearmCapability(execution?.rearmCapability);
        if (capabilityValidation.status !== "valid") {
          return abortTr1(
            "rearm_capability_invalid",
            `tr1_ rearm capability 验证失败（${capabilityValidation.reason}）: ${capabilityValidation.detail}——Game callback 零调用`,
          );
        }
        const tr1Capability = capabilityValidation.capability;
        const capabilityMatch = treasuryRearmCapabilityMatches(tr1Capability, {
          childTransactionId: record.canonical.transactionId,
          actionKind: record.canonical.kind,
          ...(intentAdapterSemanticIdentity !== undefined ? { adapterSemanticIdentity: intentAdapterSemanticIdentity } : {}),
        });
        if (capabilityMatch.status === "rejected") {
          return abortTr1("rearm_capability_invalid", `${capabilityMatch.detail}——Game callback 零调用`);
        }
        // retry semantic digest 重算比较：child contract 的实际 Game 动作
        // 语义必须与 parent 完全一致（资源/数量/room/target/kind/adapter
        // 语义/structure/durable payload 任一漂移即拒绝——capability 不消费）。
        // 按 capability 的 authority class 分派算法：lowlevel attempt 用
        // lowlevel digest（受控来源 + durable identity 等价事实），modern
        // contract 用 modern digest。
        const recomputedRetrySemantic =
          tr1Capability.binding.authorityClass === "lowlevel"
            ? computeTreasuryLowlevelRetrySemanticDigest({
                kind: record.canonical.kind,
                source: record.canonical.source,
                postings: record.shape.merged.map((leg) => ({ ...leg })),
                lowlevelSource: tr1Capability.binding.lowlevelSource ?? "",
                ...(intentAdapterSemanticIdentity !== undefined ? { adapterSemanticIdentity: intentAdapterSemanticIdentity } : {}),
              })
            : computeTreasuryModernRetrySemanticDigest({
                actionKind: record.canonical.kind,
                ...(execution?.intentContract !== undefined
                  ? {
                      ...(execution.intentContract.adapterVersion !== undefined ? { adapterVersion: execution.intentContract.adapterVersion } : {}),
                      ...(execution.intentContract.adapterSemanticIdentity !== undefined ? { adapterSemanticIdentity: execution.intentContract.adapterSemanticIdentity } : {}),
                      ...(execution.intentContract.adapterRetryFacts !== undefined ? { adapterRetryFacts: execution.intentContract.adapterRetryFacts } : {}),
                      ...(execution.intentContract.canonicalArgsText !== undefined ? { canonicalArgsText: execution.intentContract.canonicalArgsText } : {}),
                      ...(execution.intentContract.durablePayload !== undefined ? { durablePayload: execution.intentContract.durablePayload } : {}),
                      ...(execution.intentContract.durablePayloadVersion !== undefined ? { durablePayloadVersion: execution.intentContract.durablePayloadVersion } : {}),
                      ...(execution.intentContract.structureFacts !== undefined ? { structureDescriptors: execution.intentContract.structureFacts } : {}),
                    }
                  : {}),
                postings: record.shape.merged.map((leg) => ({ ...leg })),
                source: record.canonical.source,
                ...(redeemedCohort !== undefined && redeemedCohort.ownerIdentity !== "" ? { ownerIdentity: redeemedCohort.ownerIdentity } : {}),
              });
        if (recomputedRetrySemantic !== tr1Capability.binding.retrySemanticDigest) {
          return abortTr1(
            "rearm_capability_invalid",
            `retry semantic identity 不匹配（重算 ${recomputedRetrySemantic.slice(0, 12)}，capability 绑定 ${tr1Capability.binding.retrySemanticDigest.slice(0, 12)}）——child contract 不是 parent 动作的语义重试（资源/数量/room/target/action kind/adapter 语义/structure/durable payload 任一变化即拒绝）`,
          );
        }
        // lineage → child_intent_pending（staged：intent 写入前落 durable 状态，
        // handoff facts 已持久化；中断由 beginTick 回滚/前向补完成）。
        const pendingUpdate = stageTreasuryLineageChildIntentPending(tr1Capability.binding.lineageId, record.canonical.transactionId);
        if (pendingUpdate.status === "rejected") {
          return abortTr1(
            "lineage_store_fatal",
            `lineage child_intent_pending 推进失败: ${pendingUpdate.detail}——Game callback 零调用，预留已释放`,
          );
        }
        tr1LineageBindingDigest = tr1Capability.binding.bindingDigest;
        tr1LineageGeneration = tr1Capability.binding.generation;
        tr1LineageId = tr1Capability.binding.lineageId;
        tr1LineageParentTransactionId = tr1Capability.binding.parentTransactionId;
      }
      // 【第十一轮 3.13.5】统一 durable action identity：全 store 幂等/
      // read-back/转移/双权威比较的唯一 digest（outcome/settlement 不进）。
      const durableIdentityInput = {
        transactionId: record.canonical.transactionId,
        digest: record.digest,
        actionKind: record.canonical.kind,
        postings: record.shape.merged.map((leg) => ({ ...leg })),
        source: record.canonical.source,
        ...(intentAdapterSemanticIdentity !== undefined ? { adapterSemanticIdentity: intentAdapterSemanticIdentity } : {}),
        ...(execution?.intentContract !== undefined
          ? {
              contractId: execution.intentContract.contractId,
              contractDigest: execution.intentContract.contractDigest,
              ...(execution.intentContract.adapterRegistrationId !== undefined
                ? { adapterRegistrationId: execution.intentContract.adapterRegistrationId }
                : {}),
              ...(execution.intentContract.adapterRegistrationId !== undefined
                ? { adapterRegistrationId: execution.intentContract.adapterRegistrationId }
                : {}),
              ...(execution.intentContract.adapterSemanticIdentity !== undefined
                ? { adapterSemanticIdentity: execution.intentContract.adapterSemanticIdentity }
                : {}),
              ...(execution.intentContract.durablePayload !== undefined
                ? { durablePayload: execution.intentContract.durablePayload }
                : {}),
              ...(execution.intentContract.durablePayloadVersion !== undefined
                ? { durablePayloadVersion: execution.intentContract.durablePayloadVersion }
                : {}),
              ...(execution.intentContract.adapterRetryFacts !== undefined
                ? { adapterRetryFacts: execution.intentContract.adapterRetryFacts }
                : {}),
              ...(execution.intentContract.structureFacts !== undefined
                ? { structureFacts: execution.intentContract.structureFacts }
                : {}),
            }
          : {}),
        ...(redeemedCohort !== undefined
          ? { authorizationCohortDigest: computeTreasuryAuthorizationCohortDigest(redeemedCohort) }
          : {}),
        ...(redeemedCohort !== undefined && redeemedCohort.ownerIdentity !== ""
          ? { ownerIdentity: redeemedCohort.ownerIdentity }
          : {}),
        ...(redeemedCohort !== undefined
          ? {
              policyIdentity:
                redeemedCohort.policyId + "@v" + String(redeemedCohort.policyVersion) + ":" + redeemedCohort.policyDecisionDigest,
            }
          : {}),
      } satisfies Parameters<typeof computeTreasuryDurableIdentityDigest>[0];
      // 【第十八轮 24.4】tr1_ rearm attempt 的 lineage proof 进入统一 durable
      // identity（initial attempt 完全不包含——单侧缺失/不同 proof 的同 ID
      // 比较 outcome 永远 conflict，不 match）。
      const durableIdentityWithLineage = computeTreasuryDurableIdentityDigest({
        ...durableIdentityInput,
        ...(tr1LineageId !== undefined && tr1LineageBindingDigest !== undefined && tr1LineageGeneration !== undefined && tr1LineageParentTransactionId !== undefined
          ? {
              lineageId: tr1LineageId,
              lineageGeneration: tr1LineageGeneration,
              lineageParentTransactionId: tr1LineageParentTransactionId,
              lineageBindingDigest: tr1LineageBindingDigest,
            }
          : {}),
      });
      record.durableIdentityDigest = durableIdentityWithLineage;

      const intentWrite = writeTreasuryIntentEntry({
        authorityLevel: intentAuthorityLevel,
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
        outcome: "not_started",
        settlement: "ready",
        auditSource: "execute-prepared-action",
        durableIdentityDigest: record.durableIdentityDigest,
        // 【第十七轮第十一节】tr1_ rearm child 的 lineage binding 进 intent
        //（quarantine/receipt/tombstone proof 链继承；initial attempt 不携带）。
        ...(tr1LineageBindingDigest !== undefined ? { lineageBindingDigest: tr1LineageBindingDigest } : {}),
        ...(tr1LineageId !== undefined ? { lineageId: tr1LineageId } : {}),
        ...(tr1LineageGeneration !== undefined ? { lineageGeneration: tr1LineageGeneration } : {}),
        ...(tr1LineageParentTransactionId !== undefined ? { parentTransactionId: tr1LineageParentTransactionId } : {}),
        ...(intentAdapterSemanticIdentity !== undefined
          ? { adapterSemanticIdentity: intentAdapterSemanticIdentity }
          : {}),
        ...(execution?.intentContract !== undefined
          ? {
              contractId: execution.intentContract.contractId,
              contractDigest: execution.intentContract.contractDigest,
              adapterVersion: execution.intentContract.adapterVersion,
              ...(execution.intentContract.authorizationDigest !== undefined
                ? { authorizationDigest: execution.intentContract.authorizationDigest }
                : {}),
              ...(execution.intentContract.adapterRegistrationId !== undefined
                ? { adapterRegistrationId: execution.intentContract.adapterRegistrationId }
                : {}),
              ...(execution.intentContract.adapterSemanticIdentity !== undefined
                ? { adapterSemanticIdentity: execution.intentContract.adapterSemanticIdentity }
                : {}),
              ...(execution.intentContract.durablePayload !== undefined
                ? { durablePayload: execution.intentContract.durablePayload }
                : {}),
              ...(execution.intentContract.durablePayloadVersion !== undefined
                ? { durablePayloadVersion: execution.intentContract.durablePayloadVersion }
                : {}),
              ...(execution.intentContract.adapterRetryFacts !== undefined
                ? { adapterRetryFacts: execution.intentContract.adapterRetryFacts }
                : {}),
              ...(execution.intentContract.structureFacts !== undefined
                ? { structureFacts: execution.intentContract.structureFacts.map((fact) => ({ ...fact })) }
                : {}),
              ...(redeemedCohort !== undefined
                ? {
                    ownerIdentity: redeemedCohort.ownerIdentity === "" ? undefined : redeemedCohort.ownerIdentity,
                    policyIdentity:
                      redeemedCohort.policyId + "@v" + String(redeemedCohort.policyVersion) + ":" + redeemedCohort.policyDecisionDigest,
                    authorizationCohort: { ...redeemedCohort, revisions: { ...redeemedCohort.revisions }, authorizationLegDigests: [...redeemedCohort.authorizationLegDigests] },
                    authorizationCohortDigest: computeTreasuryAuthorizationCohortDigest(redeemedCohort),
                  }
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
      // ── read-back 完整 identity 验证（第十轮 3.12.7）：already_present 幂等
      //    只允许完整 identity 一致——transaction/digest/contract（ID+digest）/
      //    adapterVersion/authorizationDigest（bundle digest）/durable payload/
      //    postings/outcome/settlement 任一不同 → intent_conflict（fail
      //    closed，不静默接受不同 contract；低层 test path 写入的同 id 旧
      //    intent 不被 production contract 接管）。 ─────────────────────────────
      const readBack = readTreasuryIntentEntry(record.canonical.transactionId);
      const identityOptionalMatches = (actual: string | number | undefined, declared: string | number | undefined): boolean =>
        actual === declared || (actual === undefined && declared === undefined);
      const readBackIdentityConsistent = treasuryDurableIdentitiesMatch(readBack?.durableIdentityDigest, record.durableIdentityDigest);
      const readBackConsistent =
        readBack !== undefined &&
        readBackIdentityConsistent &&
        readBack.digest === record.digest &&
        readBack.outcome === "not_started" &&
        readBack.settlement === "ready" &&
        readBack.postings.length === record.shape.merged.length &&
        readBack.postings.every(
          (leg, index) =>
            leg.roomName === record.shape.merged[index].roomName &&
            leg.locationKind === record.shape.merged[index].locationKind &&
            leg.resource === record.shape.merged[index].resource &&
            leg.delta === record.shape.merged[index].delta,
        ) &&
        (execution?.intentContract === undefined || readBack.contractId === execution.intentContract.contractId) &&
        (execution?.intentContract === undefined ||
          identityOptionalMatches(readBack.contractDigest, execution.intentContract.contractDigest)) &&
        (execution?.intentContract === undefined ||
          identityOptionalMatches(readBack.adapterVersion, execution.intentContract.adapterVersion)) &&
        (execution?.intentContract === undefined ||
          identityOptionalMatches(readBack.authorizationDigest, execution.intentContract.authorizationDigest)) &&
        (execution?.intentContract === undefined ||
          identityOptionalMatches(readBack.durablePayload, execution.intentContract.durablePayload)) &&
        (execution?.intentContract === undefined ||
          identityOptionalMatches(readBack.durablePayloadVersion, execution.intentContract.durablePayloadVersion));
      if (!readBackConsistent) {
        metrics.intentWriteFailures += 1;
        record.state = "expired";
        preparedById.delete(record.canonical.transactionId);
        projection.tentativeRelease(record.tentativeKey);
        releaseTreasuryReceiptReservation(record.canonical.transactionId);
        finalizeHandleRecord(record, "expired");
        return {
          status: "prepare_rejected",
          reason: "identity_conflict",
          detail: "durable intent read-back 统一 identity 验证失败（同 id 已存在不同 contract/bundle/cohort/descriptor/digest 的 intent，或 store 不可信）——fail closed，不静默接受不同 durable identity——Game callback 零调用",
        };
      }
      // ──【第十七轮第十节】tr1_ 接管完成（capability 消费 + lineage →
      //    child_active）：早于 Game callback、晚于全部检查、与 child durable
      //    接管可恢复——consume 失败（同步窗口内失效）→ 释放 intent 与预留、
      //    lineage 回滚 rearm_ready（capability 作废可重签）；lineage 推进
      //    失败 → intent 保留为 staged（beginTick 恢复：一致 not_started →
      //    回滚 rearm_ready 并释放 intent），callback 零调用。 ───────────────
      if (tr1LineageId !== undefined && tr1LineageBindingDigest !== undefined) {
        if (
          readBack.lineageBindingDigest !== tr1LineageBindingDigest ||
          readBack.lineageId !== tr1LineageId ||
          readBack.lineageGeneration !== tr1LineageGeneration ||
          readBack.parentTransactionId !== tr1LineageParentTransactionId
        ) {
          // intent 未携带预期 binding（store 不可信/被并行篡改）——fail closed。
          metrics.intentWriteFailures += 1;
          record.state = "expired";
          preparedById.delete(record.canonical.transactionId);
          projection.tentativeRelease(record.tentativeKey);
          releaseTreasuryReceiptReservation(record.canonical.transactionId);
          finalizeHandleRecord(record, "expired");
          return {
            status: "prepare_rejected",
            reason: "identity_conflict",
            detail: "tr1_ intent read-back 未携带预期完整 lineage proof（binding/generation/lineage/parent）——fail closed，Game callback 零调用",
          };
        }
        // 【第十八轮 24.2】严格消费：lineage 必须处于 child_intent_pending 且
        // revision 等于签发 revision+1，binding 与 record 完整匹配（无 skip
        // 旁路）。失败 → 释放 intent 并同步回滚 lineage（同代 child 保留可重签）。
        const consumed = rearmCapabilityAuthority.consumeRearmCapability(execution?.rearmCapability);
        if (consumed.status !== "valid") {
          releaseTreasuryIntentEntry(record.canonical.transactionId);
          rollbackTreasuryLineageToRearmReady(tr1LineageId);
          preparedById.delete(record.canonical.transactionId);
          projection.tentativeRelease(record.tentativeKey);
          releaseTreasuryReceiptReservation(record.canonical.transactionId);
          finalizeHandleRecord(record, "aborted");
          metrics.transactionsRejectedInvalid += 1;
          return {
            status: "prepare_rejected",
            reason: "rearm_capability_invalid",
            detail: `tr1_ rearm capability 消费失败（${consumed.reason}）: ${consumed.detail}——intent 已释放、lineage 回滚 ready 可重签，Game callback 零调用`,
          };
        }
        record.lineageBindingDigest = tr1LineageBindingDigest;
        record.lineageGeneration = tr1LineageGeneration;
        record.lineageId = tr1LineageId;
        record.lineageParentTransactionId = tr1LineageParentTransactionId;
      }
      // ── execution-started（ready → executing，严格迁移：期望前序 + digest
      //    一致）：任何 rejected（含 not_found——第九轮修复：entry 缺失绝不能
      //    无权威地执行 callback）都 callback 零调用、保守关闭。【第十八轮
      //    24.2】tr1_ 的 executing 先于 lineage child_active 推进——executing
      //    是 callback 可能已开始的唯一持久信号；此处失败则 intent 仍是
      //    ready（callback 确定未开始）→ 释放 intent 并同步回滚 lineage。 ──
      const started = progressTreasuryIntent(record.canonical.transactionId, {
        outcome: "started_unknown",
        settlement: "executing",
        fromSettlement: ["ready"],
        digest: record.digest,
        ...(execution?.intentContract !== undefined ? { contractId: execution.intentContract.contractId } : {}),
      });
      if (started.status === "rejected") {
        metrics.intentWriteFailures += 1;
        if (tr1LineageId !== undefined) {
          releaseTreasuryIntentEntry(record.canonical.transactionId);
          rollbackTreasuryLineageToRearmReady(tr1LineageId);
        }
        record.state = "expired";
        preparedById.delete(record.canonical.transactionId);
        projection.tentativeRelease(record.tentativeKey);
        releaseTreasuryReceiptReservation(record.canonical.transactionId);
        finalizeHandleRecord(record, "expired");
        return {
          status: "prepare_rejected",
          reason: "intent_store_unavailable",
          detail: `durable intent 状态迁移失败（${started.reason}）: ${started.detail}——Game callback 零调用${tr1LineageId !== undefined ? "，tr1_ intent 已释放、lineage 已回滚 rearm_ready（同代 child 可重签）" : ""}`,
        };
      }
      record.state = "executing";
      if (tr1LineageId !== undefined && tr1LineageBindingDigest !== undefined) {
        // ──【第十八轮 24.2】armed 推进（executing 已持久化之后、Game callback
        //    之前）：失败 → callback 零调用、intent 保留在 executing（beginTick
        //    前向补完成 child_active——不产生第二 child）。 ──────────────────
        const childIdentity: TreasuryAttemptLineageIdentity = {
          digest: record.digest,
          ...(record.contractDigest !== undefined ? { contractDigest: record.contractDigest } : {}),
          ...(record.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: record.authorizationCohortDigest } : {}),
          durableIdentityDigest: record.durableIdentityDigest,
          // 【第十八轮 24.1】lowlevel child 的 identity 携带受控 provenance
          //（resolver publication 的 read-back identity 匹配要求完整）。
          ...(intentAuthorityLevel === "lowlevel"
            ? { lowlevelSource: readBack?.lowlevelSource ?? TREASURY_LOWLEVEL_SOURCE_RUNTIME }
            : {}),
        };
        const activated = activateTreasuryLineageChild(tr1LineageId, childIdentity);
        if (activated.status === "rejected") {
          metrics.intentWriteFailures += 1;
          record.state = "expired";
          preparedById.delete(record.canonical.transactionId);
          projection.tentativeRelease(record.tentativeKey);
          releaseTreasuryReceiptReservation(record.canonical.transactionId);
          finalizeHandleRecord(record, "expired");
          return {
            status: "prepare_rejected",
            reason: "lineage_store_fatal",
            detail: `lineage child_active 推进失败（intent 保留在 executing，beginTick 前向补完成接管）: ${activated.detail}——Game callback 零调用`,
          };
        }
      }
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
        //（emergency intent authority——postings/占用不丢）。phase 标记失败
        // 不静默（计数），durable 权威由 quarantine/intent 保留兜底。
        record.faultPhase = "action_threw_execution_unknown";
        metrics.executionUnknownQuarantines += 1;
        const attempted = progressTreasuryIntent(record.canonical.transactionId, {
          outcome: "started_unknown",
          settlement: "faulted",
          fromSettlement: ["executing", "pending_abort", "pending_commit"],
          digest: record.digest,
        });
        if (attempted.status === "rejected") metrics.intentWriteFailures += 1;
        quarantineFaultedRecord(record, error instanceof Error ? error.message : String(error));
        throw error;
      }
      if (actionResult && actionResult.ok) {
        // ── Game 已返回 OK：executing → ok_pending_commit 必须成功落盘后才
        //    允许普通 commit（第九轮 4.5.6：写失败 = 已知 OK 事实不得走普通
        //    commit，进入 durable emergency fault——executed_unsettled）。 ──
        const marked = progressTreasuryIntent(record.canonical.transactionId, {
          outcome: "returned_ok",
          settlement: "pending_commit",
          fromSettlement: ["executing"],
          digest: record.digest,
        });
        if (marked.status === "rejected") {
          metrics.intentWriteFailures += 1;
          if ((record.state as TreasuryPreparedHandleState) !== "faulted") {
            record.faultPhase = "commit_unexpected";
          }
          // 保守升级为 execution_unknown（尽力；失败已计数）后 quarantine
          // 接管 durable 权威。
          const escalated = progressTreasuryIntent(record.canonical.transactionId, {
            outcome: "returned_ok",
            settlement: "faulted",
            fromSettlement: ["executing", "pending_commit"],
            digest: record.digest,
          });
          if (escalated.status === "rejected") metrics.intentWriteFailures += 1;
          quarantineFaultedRecord(record);
          return {
            status: "executed_unsettled",
            handle: prepared.handle,
            actionResult,
            transactionId: record.canonical.transactionId,
            digest: record.digest,
            faultReason: "intent_phase_write_failed",
            detail: `Game 已返回 OK 但 ok_pending_commit 落盘失败（${marked.reason}）——不得普通 commit，已进入 durable fault`,
            retryForbidden: true,
          };
        }
        const committed = internalService.commitPreparedTransaction(prepared.handle);
        if (committed.status === "committed") {
          // settled：intent 关闭（WAL 完成）——lineage 终态补完成 pending 时
          // intent 保留为 durable commit-pending proof（beginTick 按 matching
          // receipt 补完成 chain_committed 后释放）。
          if (committed.lineageFinalizationPending !== true) {
            releaseTreasuryIntentEntry(record.canonical.transactionId);
          }
          return {
            status: "executed_committed",
            handle: prepared.handle,
            actionResult,
            committedAtTick: committed.tick,
            ...(committed.lineageFinalizationPending === true ? { lineageFinalizationPending: true } : {}),
          };
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
        const escalated = progressTreasuryIntent(record.canonical.transactionId, {
          outcome: "returned_ok",
          settlement: "faulted",
          fromSettlement: ["executing", "pending_commit"],
          digest: record.digest,
        });
        if (escalated.status === "rejected") metrics.intentWriteFailures += 1;
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
      // ── Game 正常返回非 OK：executing → returned_non_ok 必须成功落盘后才
      //    允许普通 abort（第九轮 4.5.6：写失败 = 不得普通 abort——
      //    executed_abort_failed + durable fault）。 ─────────────────────────
      const markedNonOk = progressTreasuryIntent(record.canonical.transactionId, {
        outcome: "returned_non_ok",
        settlement: "pending_abort",
        fromSettlement: ["executing"],
        digest: record.digest,
      });
      if (markedNonOk.status === "rejected") {
        metrics.intentWriteFailures += 1;
        record.faultPhase = "action_returned_non_ok_abort_failed";
        const escalated = progressTreasuryIntent(record.canonical.transactionId, {
          outcome: "returned_non_ok",
          settlement: "faulted",
          fromSettlement: ["executing", "pending_abort"],
          digest: record.digest,
        });
        if (escalated.status === "rejected") metrics.intentWriteFailures += 1;
        quarantineFaultedRecord(record);
        return {
          status: "executed_abort_failed",
          handle: prepared.handle,
          actionResult,
          reason: "intent_phase_write_failed",
          detail: `Game 已返回非 OK 但 returned_non_ok 落盘失败（${markedNonOk.reason}）——不得普通 abort，已进入 durable fault`,
        };
      }
      const aborted = internalService.abortPreparedTransaction(prepared.handle);
      if (aborted.status !== "aborted") {
        // abort 未确认：资源仍被占用——立即隔离（第七轮：phase=
        // action_returned_non_ok_abort_failed，不等 tick 边界），不得报告已
        // 正常 abort。intent 随 quarantine 写入成功释放、失败保留。
        record.faultPhase = "action_returned_non_ok_abort_failed";
        const escalated = progressTreasuryIntent(record.canonical.transactionId, {
          outcome: "returned_non_ok",
          settlement: "faulted",
          fromSettlement: ["executing", "pending_abort"],
          digest: record.digest,
        });
        if (escalated.status === "rejected") metrics.intentWriteFailures += 1;
        quarantineFaultedRecord(record);
        return {
          status: "executed_abort_failed",
          handle: prepared.handle,
          actionResult,
          reason: aborted.status === "rejected" ? aborted.reason : "invalid_handle",
          ...(aborted.status === "rejected" && aborted.detail !== undefined ? { detail: aborted.detail } : {}),
        };
      }
      // 确认 aborted：intent 关闭（slot 回收）。【第十八轮 24.3】tr1_ child
      // 的 non-OK + abort 确认 = 当前 generation 的确定 not-executed——同步
      // 完成当前代 retirement（publication → final tombstone（tr1_ proof）→
      // 释放 intent → marker 终态 → rearm-ready，同一 lineage record 不新增
      // slot，下一次 capability 以当前 child 为 parent 生成下一代）。任一步
      // 失败：intent 事实保留（quarantine→resolver 收敛），lineage 不停留在
      // 无恢复路径的状态，返回 retirement=pending_publication。
      if (record.lineageBindingDigest !== undefined && isTreasuryRearmAttemptId(record.canonical.transactionId)) {
        const childLineage = lookupTreasuryAttemptLineageByAttemptId(record.canonical.transactionId);
        if (childLineage !== undefined && childLineage.state === "child_active") {
          const retirementPublication = retireTreasuryLineageCurrentAttempt({ lineageId: childLineage.lineageId });
          if (retirementPublication.status === "rejected") {
            return {
              status: "executed_aborted",
              handle: prepared.handle,
              actionResult,
              retirement: "pending_publication",
              detail: `child not-executed retirement publication 失败（intent 保留，quarantine→resolver 收敛）: ${retirementPublication.detail}`,
            };
          }
          const retiredRecord = lookupTreasuryAttemptLineageByAttemptId(record.canonical.transactionId);
          const childTombstone = writeTreasuryResolutionTombstone({
            transactionId: record.canonical.transactionId,
            digest: record.digest,
            resolution: "not-executed",
            stage: "final",
            proofLevel: retiredRecord?.authorityClass ?? (record.contractDigest === undefined ? "lowlevel" : "identity-bound"),
            actionTick: Game.time,
            observationTick: Game.time,
            resolvedAtTick: Game.time,
            source: "direct-abort",
            ...(record.contractDigest !== undefined ? { contractDigest: record.contractDigest } : {}),
            ...(record.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: record.authorizationCohortDigest } : {}),
            ...(record.durableIdentityDigest !== undefined ? { durableIdentityDigest: record.durableIdentityDigest } : {}),
            ...(retiredRecord?.authorityClass === "lowlevel" && retiredRecord.lowlevelSource !== undefined
              ? { lowlevelSource: retiredRecord.lowlevelSource }
              : {}),
            ...(retiredRecord !== undefined && retiredRecord.currentTransactionId === record.canonical.transactionId
              ? {
                  lineageId: retiredRecord.lineageId,
                  lineageGeneration: retiredRecord.generation,
                  ...(retiredRecord.currentParentTransactionId !== undefined ? { parentTransactionId: retiredRecord.currentParentTransactionId } : {}),
                  lineageBindingDigest: retiredRecord.bindingDigest!,
                }
              : {}),
          });
          if (childTombstone.status === "rejected") {
            return {
              status: "executed_aborted",
              handle: prepared.handle,
              actionResult,
              retirement: "pending_publication",
              detail: `child not-executed tombstone 写入失败（intent 保留，后续 tick resolver 收敛）: ${childTombstone.detail}`,
            };
          }
          releaseTreasuryIntentEntry(record.canonical.transactionId);
          // marker class-aware 清除（non-OK + abort 确认正常无 marker——检查
          // 结果决定三段完成）。
          const markerCleared = clearTreasuryWriteFaultMarkerForResolution(
            classAwareIdentityOfAttempt({
              transactionId: record.canonical.transactionId,
              digest: record.digest,
              authorityLevel: retiredRecord?.authorityClass === "lowlevel" ? "lowlevel" : "modern",
              ...(record.contractDigest !== undefined ? { contractDigest: record.contractDigest } : {}),
              ...(record.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: record.authorizationCohortDigest } : {}),
              ...(record.durableIdentityDigest !== undefined ? { durableIdentityDigest: record.durableIdentityDigest } : {}),
              ...(retiredRecord?.authorityClass === "lowlevel" && retiredRecord.lowlevelSource !== undefined
                ? { lowlevelSource: retiredRecord.lowlevelSource }
                : {}),
              ...(retiredRecord?.bindingDigest !== undefined ? { lineageBindingDigest: retiredRecord.bindingDigest } : {}),
              ...(retiredRecord !== undefined ? { attemptGeneration: retiredRecord.generation } : {}),
            }),
          );
          const markerAbsent =
            readTreasuryWriteFault() === undefined || readTreasuryWriteFault()?.transactionId !== record.canonical.transactionId;
          if (markerCleared || markerAbsent) {
            // 【第十九轮 C.7】三段分别证明后 converge 收敛——pending-release
            // 索引移除与 retirement 完成共享同一阶段事实。
            const converged = convergeTreasuryLineageRetirementFromFacts(childLineage.lineageId);
            if (converged.status === "completed") {
              markTreasuryPendingReleaseCompleted(record.canonical.transactionId);
            }
          }
          return {
            status: "executed_aborted",
            handle: prepared.handle,
            actionResult,
            retirement: markerCleared || markerAbsent ? "complete_rearm_ready" : "pending_cleanup",
          };
        }
      }
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
      readonly status: "already_resolved";
      readonly resolution: "committed" | "not-executed";
      readonly transactionId: string;
    } | {
      readonly status: "rejected";
      readonly reason: "not_found" | "digest_mismatch" | "authority_inconsistent" | "authority_store_unhealthy" | "active_handle_present" | "no_registered_reconciler" | "invalid_input" | "premature_observation" | "adapter_version_mismatch" | "reconciler_fault" | "legacy_authority_isolated" | "resolution_in_progress" | "resolution_identity_conflict" | "resolution_store_fatal";
      readonly detail: string;
    } {
      const reject = (reason: "not_found" | "digest_mismatch" | "authority_inconsistent" | "authority_store_unhealthy" | "active_handle_present" | "no_registered_reconciler" | "invalid_input" | "premature_observation" | "adapter_version_mismatch" | "reconciler_fault" | "legacy_authority_isolated" | "resolution_in_progress" | "resolution_identity_conflict" | "resolution_store_fatal", detail: string) => {
        metrics.reconciliationCapabilitiesRejected += 1;
        return { status: "rejected" as const, reason, detail };
      };
      if (!input || typeof input !== "object" || typeof input.transactionId !== "string" || input.transactionId.length === 0) {
        return reject("invalid_input", "transactionId 缺失或非法");
      }
      const state = ensureTickState(true);
      // ── unified unresolved authority（第九轮 4.7）：签发与 resolution 共用
      //    同一套 authority resolution——quarantine 优先 + intent emergency
      //    兜底；同 id 双存在且身份不一致 → fail closed（不任选其一）。 ──
      const authority = resolveTreasuryUnresolvedAuthority(input.transactionId);
      if (authority.status === "not_found") {
        return reject("not_found", `transactionId ${input.transactionId.slice(0, 48)} 不在 quarantine/intent（可能已解决或从未隔离）`);
      }
      if (authority.status === "inconsistent") {
        return reject("authority_inconsistent", `${authority.detail}`);
      }
      if (authority.status === "store_unhealthy") {
        // 【第十六轮第八节】intent/quarantine store fatal：reconciler 零调用、
        // 不签发 capability（不得把 store 损坏当作 authority 已释放/不存在）。
        return reject("authority_store_unhealthy", `${authority.detail}`);
      }
      const facts0 = authority.authority;
      if (input.digest !== undefined && facts0.digest !== input.digest) {
        return reject("digest_mismatch", `digest 不匹配（entry ${facts0.digest}，请求 ${input.digest}）`);
      }
      // ── 【第十五轮第七节】resolution tombstone 门禁：reconciler 只在"无
      //    现有 resolution intent"时运行——resolving 期间不重跑对账、不签发
      //    第二份普通 capability（等待 staged recovery 继续原结论）；final
      //    且 identity match → already-resolved；identity conflict / proof
      //    insufficient → fail closed（reconciler 零调用）。──
      if (peekTreasuryResolutionStoreEntry() !== undefined) {
        const resolutionFatal = ensureTreasuryResolutionStoreValidated();
        if (resolutionFatal !== null) {
          return reject("resolution_store_fatal", `resolution store 损坏（不可信 store 上不得签发 capability）: ${resolutionFatal}`);
        }
      }
      const existingResolution = readTreasuryResolutionTombstone(input.transactionId);
      if (existingResolution !== undefined) {
        const resolutionAttempt = {
          digest: facts0.digest,
          ...(facts0.contractDigest !== undefined ? { contractDigest: facts0.contractDigest } : {}),
          ...(facts0.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: facts0.authorizationCohortDigest } : {}),
          ...(facts0.durableIdentityDigest !== undefined ? { durableIdentityDigest: facts0.durableIdentityDigest } : {}),
          ...(facts0.lowlevelSource !== undefined ? { lowlevelSource: facts0.lowlevelSource } : {}),
          // 【第十九轮 A.1】capability 签发前与既有 resolution proof 的 lineage
          // 维度比较（tr1_ 缺 proof 的旧 tombstone 不得证明当前 generation）。
          ...(facts0.lineageId !== undefined ? { lineageId: facts0.lineageId } : {}),
          ...(facts0.lineageGeneration !== undefined ? { lineageGeneration: facts0.lineageGeneration } : {}),
          ...(facts0.parentTransactionId !== undefined ? { parentTransactionId: facts0.parentTransactionId } : {}),
          ...(facts0.lineageBindingDigest !== undefined ? { lineageBindingDigest: facts0.lineageBindingDigest } : {}),
        };
        const resolutionRelation = treasuryAttemptIdentityRelation(existingResolution, resolutionAttempt);
        if (resolutionRelation !== "match") {
          // identity conflict / proof insufficient（含 resolving 形态的 identity
          // 冲突）→ fail closed：不调用 reconciler、不签发。
          return reject(
            "resolution_identity_conflict",
            resolutionRelation === "conflict"
              ? `既有 resolution tombstone（stage=${existingResolution.stage}）与当前 authority attempt identity 冲突（${input.transactionId.slice(0, 48)}）——不重跑 reconciler（fail closed）`
              : `既有 resolution tombstone（stage=${existingResolution.stage}）的 proof 不足以证明当前 authority attempt（${input.transactionId.slice(0, 48)}）——不重跑 reconciler（fail closed）`,
          );
        }
        if (existingResolution.stage === "resolving") {
          return reject(
            "resolution_in_progress",
            `transactionId ${input.transactionId.slice(0, 48)} 已有 stage=resolving 的 resolution tombstone（结论 ${existingResolution.resolution}）——不重跑 reconciler、不签发第二份 capability，等待 staged recovery 继续原结论`,
          );
        }
        return {
          status: "already_resolved",
          resolution: existingResolution.resolution,
          transactionId: input.transactionId,
        };
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
      // 【第十三轮第八节】显式 authorityLevel 第一道判定：legacy / forensic
      // 等级的 authority 不签发普通 reconciliation capability（等级为持久
      // 事实，不再由 optional 字段存在性推断；modern/lowlevel 继续走既有
      // 完整检查链——semantic identity / reconciler 注册等）。
      const authorityLevel = (facts0 as { authorityLevel?: unknown }).authorityLevel;
      if (authorityLevel === "legacy" || authorityLevel === "forensic" || authorityLevel === undefined) {
        return reject(
          "legacy_authority_isolated",
          authorityLevel === "forensic"
            ? `transactionId ${input.transactionId.slice(0, 48)} 为显式 forensic authority（不完整/不变量破坏痕迹）——不得签发普通 reconciliation capability（显式 forensic 流程处理）`
            : `transactionId ${input.transactionId.slice(0, 48)} 为显式 legacy authority（版本化迁移标记，无完整现代身份事实）或等级缺失（store unhealthy）——不得签发普通 capability`,
        );
      }
      // 【第十一轮 3.13.7】legacy authority 隔离：legacyV1（v1 迁移且无并存
      // intent 补全合同事实）不得使用当前 adapter reconciler 解释——保持
      // 隔离，只能显式人工 migration/reconciliation 处理。
      if ((facts0 as { legacyV1?: boolean }).legacyV1 === true) {
        return reject(
          "legacy_authority_isolated",
          `transactionId ${input.transactionId.slice(0, 48)} 为 legacy v1 quarantine（无完整 contract/cohort identity）——当前 adapter reconciler 不得解释，保持隔离（显式诊断：treasuryLegacyQuarantineDiagnostics）`,
        );
      }
      // 【第十二轮 3.8】forensic incomplete authority 隔离：intent 缺失时
      // recovery 防御性直写的最小 quarantine 不得被当前 reconciler 解释。
      if ((facts0 as { forensic?: unknown }).forensic !== undefined) {
        return reject(
          "legacy_authority_isolated",
          `transactionId ${input.transactionId.slice(0, 48)} 为 forensic incomplete authority（intent 缺失时的防御性直写，缺少 contract/cohort/descriptor 身份事实）——不得签发普通 reconciliation capability（诊断：treasuryForensicQuarantineDiagnostics；显式 forensic 流程处理）`,
        );
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
      if (facts0.adapterVersion !== undefined && facts0.adapterVersion !== adapter.version) {
        // 第十轮 5.1：authority 携带的 adapter version 与 registry 当前版本
        // 不一致——不得用新 reconciler 解释旧 action（fail closed）。
        return reject(
          "adapter_version_mismatch",
          `authority 记录 adapter v${String(facts0.adapterVersion)}，registry 当前 v${String(adapter.version)}——版本演进后旧 action 不可由新 reconciler 解释`,
        );
      }
      // 【第十二轮 3.5】稳定 reconciler 语义身份验证：global reset 后同
      // kind/version 但 stable semantic identity 不同 → 不得调用当前
      // reconciler 解释旧 authority；authority 缺少语义身份（旧数据/低层
      // 路径）→ 无法验证 → 隔离（不猜测当前 identity）。
      if (facts0.adapterSemanticIdentity === undefined) {
        return reject(
          "legacy_authority_isolated",
          `transactionId ${input.transactionId.slice(0, 48)} 的 authority 缺少 stable adapter semantic identity（跨 global reset 无法验证 reconciler 语义一致性）——保持隔离，不猜测当前 identity`,
        );
      }
      if (facts0.adapterSemanticIdentity !== adapter.semanticIdentity) {
        return reject(
          "adapter_version_mismatch",
          `authority 绑定 stable semantic identity ${facts0.adapterSemanticIdentity.slice(0, 48)}，registry 当前 ${adapter.semanticIdentity.slice(0, 48)}——global reset 后 reconciler 语义已变化，旧 authority 不得由当前 reconciler 解释`,
        );
      }
      // 结论只能来自注册 reconciler（调用者不可自填）；reconcile 异常 =
      // capability 签发拒绝、authority 保持隔离（第十一轮 3.13.2 异常边界）。
      const facts = {
        actionKind,
        transactionId: facts0.transactionId,
        ...(facts0.contractId !== undefined ? { contractId: facts0.contractId } : {}),
        ...(facts0.contractDigest !== undefined ? { contractDigest: facts0.contractDigest } : {}),
        ...(facts0.adapterVersion !== undefined ? { adapterVersion: facts0.adapterVersion } : {}),
        postings: facts0.postings.map((leg) => ({ ...leg })) as never,
        ...(facts0.durablePayload !== undefined ? { durablePayload: facts0.durablePayload } : {}),
        ...(facts0.durablePayloadVersion !== undefined ? { durablePayloadVersion: facts0.durablePayloadVersion } : {}),
        ...(facts0.structureFacts !== undefined
          ? { structureDescriptors: facts0.structureFacts.map((fact) => ({ ...fact })) as unknown as TreasuryStructureBindingDescriptor[] }
          : {}),
      };
      let conclusion: TreasuryReconciliationConclusion;
      try {
        conclusion = adapter.reconcile(facts, state.observation) as TreasuryReconciliationConclusion;
      } catch (error) {
        return reject(
          "reconciler_fault",
          `reconciler 抛错（${String(error instanceof Error ? error.message : error).slice(0, 96)}）——capability 拒绝签发，authority 保持隔离`,
        );
      }
      if (conclusion !== "observed_committed" && conclusion !== "observed_not_executed" && conclusion !== "still_uncertain") {
        return reject("invalid_input", `reconciler 返回非法结论: ${String(conclusion)}`);
      }
      // 签发入 service 闭包私有 registry（第九轮 4.8：无公开注册入口）；
      // capability 扩展绑定 authorityKind/contract 身份/adapter version/
      // durable payload version。
      const capability = Object.freeze({
        __brand: "treasury-reconciliation-capability" as const,
        transactionId: facts0.transactionId,
        digest: facts0.digest,
        authorityKind: facts0.authorityKind,
        actionKind,
        conclusion,
        ...(facts0.contractId !== undefined ? { contractId: facts0.contractId } : {}),
        ...(facts0.contractDigest !== undefined ? { contractDigest: facts0.contractDigest } : {}),
        ...(facts0.adapterVersion !== undefined ? { adapterVersion: facts0.adapterVersion } : {}),
        ...(facts0.durablePayloadVersion !== undefined ? { durablePayloadVersion: facts0.durablePayloadVersion } : {}),
        ...(facts0.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: facts0.authorizationCohortDigest } : {}),
        ...(facts0.durableIdentityDigest !== undefined ? { durableIdentityDigest: facts0.durableIdentityDigest } : {}),
        ...(facts0.lowlevelSource !== undefined ? { lowlevelSource: facts0.lowlevelSource } : {}),
        // 【第十九轮 A.2】tr1_ rearm authority 的完整 lineage proof 绑定
        //（child generation 证明——prevalidation 强比较）。
        ...(facts0.lineageId !== undefined ? { lineageId: facts0.lineageId } : {}),
        ...(facts0.lineageGeneration !== undefined ? { lineageGeneration: facts0.lineageGeneration } : {}),
        ...(facts0.parentTransactionId !== undefined ? { parentTransactionId: facts0.parentTransactionId } : {}),
        ...(facts0.lineageBindingDigest !== undefined ? { lineageBindingDigest: facts0.lineageBindingDigest } : {}),
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
      }) as TreasuryReconciliationCapability;
      resolutionAuthorityInternal.registerCapability(capability);
      metrics.reconciliationCapabilitiesIssued += 1;
      return { status: "issued", capability };
    },

    /**
     * 只读验证（第十轮 3.12.8）：与 consume 相同的校验链（对象身份/单次未用/
     * generation/tick）但**不标记消费**——faultResolution 的 prevalidate 用；
     * 消费发生在 staged resolution intent 写入之后。
     */
    validateReconciliationCapability(capability: unknown): TreasuryReconciliationCapabilityConsumption {
      return resolutionAuthorityInternal.validateReconciliationCapability(capability);
    },

    consumeReconciliationCapability(capability: unknown): TreasuryReconciliationCapabilityConsumption {
      return resolutionAuthorityInternal.consumeReconciliationCapability(capability);
    },

    /**
     * 对外 resolution 管理入口（第十轮 3.12.8）：capability 结论路由
     * committed/not-executed（staged 协议见 faultResolution）；内部经闭包
     * 注册的 resolution kernel 执行——伪 service 无法进入。
     */
    resolveUnresolvedTransaction(input: {
      readonly transactionId: string;
      readonly digest?: string;
      readonly capability: TreasuryReconciliationCapability;
      /** pre-execution authorization fault 的显式确认（第十一轮 3.13.1；其他 fault 不适用）。 */
      readonly acknowledgeRolledBack?: boolean;
    }): TreasuryFaultResolutionResult {
      // 【第十一轮 3.13.1】pre-execution authorization fault 专用恢复路由：
      // durable authority 命中时不走 capability 路径（协议已证明 Game 未
      // 执行——不需要 action reconciler）；要求显式 acknowledgeRolledBack。
      const preExecutionFault = readTreasuryAuthorizationFaultEntry(input?.transactionId ?? "");
      if (preExecutionFault !== undefined) {
        return resolutionAuthorityInternal.resolvePreExecutionAuthorizationFault(input, preExecutionFault);
      }
      // 【第十二轮 3.3】pre-execution 通道的解除后幂等：authority 已释放但
      // final not-executed tombstone（preExecution 标志）存在且调用方提供的
      // digest 与 tombstone 一致 → already_resolved（digest 是该通道的
      // attempt identity 绑定——同 ID 新 attempt 的 contract digest 必然
      // 不同，不匹配即拒绝）。
      if (preExecutionFault === undefined && input?.acknowledgeRolledBack === true && input.digest !== undefined) {
        const resolvedTombstone = readTreasuryResolutionTombstone(input.transactionId ?? "");
        if (
          resolvedTombstone !== undefined &&
          resolvedTombstone.stage === "final" &&
          resolvedTombstone.resolution === "not-executed" &&
          resolvedTombstone.preExecution === true &&
          resolvedTombstone.digest === input.digest
        ) {
          return { status: "already_resolved", resolution: "not-executed", transactionId: input.transactionId ?? "" };
        }
      }
      // 【第十二轮 3.1.7】forensic marker（authority 写入失败的兜底）专用通道。
      const forensicMarker = readTreasuryWriteFault();
      if (
        preExecutionFault === undefined &&
        forensicMarker !== undefined &&
        forensicMarker.transactionId === input?.transactionId &&
        forensicMarker.phase === "internal_authorization_fault_forensic"
      ) {
        return resolutionAuthorityInternal.resolveForensicAuthorizationFaultMarker(input);
      }
      const conclusion = internalService.validateReconciliationCapability(input?.capability);
      if (conclusion.status === "valid" && conclusion.capability.conclusion === "observed_not_executed") {
        return resolveTreasuryQuarantinedTransactionAsNotExecuted(service, input);
      }
      return resolveTreasuryQuarantinedTransactionAsCommitted(service, input);
    },

    /**
     * 【第十七轮第七节】issue opaque rearm capability（受控 service 方法）：
     * 完整 cross-store preflight（attemptOccupancy：parent 相反 proof、child
     * 占用、lineage rearm-ready、各 store 健康）→ lineage 确定性 child 派生
     * → durable 状态推进（rearm_ready → capability_issued，recordRevision+1）
     * → heap-only 冻结 capability 注册。同 tick 同 lineage 幂等返回同一对象；
     * 拒绝路径零 lineage mutation、零 capability、零 callback。
     */
    issueTreasuryRearmCapability(input: {
      readonly parentTransactionId: string;
    }): ReturnType<TreasuryService["issueTreasuryRearmCapability"]> {
      if (
        !input ||
        typeof input.parentTransactionId !== "string" ||
        input.parentTransactionId.length === 0 ||
        !isValidTreasuryTransactionId(input.parentTransactionId)
      ) {
        return { status: "rejected", reason: "invalid_input", detail: "parentTransactionId 缺失或非法" };
      }
      const preflight = preflightTreasuryRearmCapability({
        parentTransactionId: input.parentTransactionId,
        heapChildOccupied: (childId) =>
          preparedById.has(childId) || authorizationLedger.hasActiveBundleFor(childId),
      });
      if (preflight.status === "rejected") {
        metrics.reconciliationCapabilitiesRejected += 1;
        return { status: "rejected", reason: preflight.reason, detail: preflight.detail };
      }
      const lineage = preflight.lineage;
      // 确定性 child ID（generation-addressable v2：同 (lineage, generation)
      // 幂等、跨 reset 恒定——O(1) 可解析/可验证）。
      const childTransactionId =
        lineage.nextChildTransactionId ??
        deriveTreasuryLineageNextChildTransactionId(lineage.lineageId, lineage.generation + 1, lineage.rootTransactionId);
      // child 占用终检（nextChild 可能已派生过——核对全部 durable store；
      // 本 lineage 自身的 next-child 索引不算占用）。
      const occupied = checkTreasuryChildAttemptOccupancy(
        childTransactionId,
        (id) => preparedById.has(id) || authorizationLedger.hasActiveBundleFor(id),
        lineage.lineageId,
      );
      if (occupied !== null) {
        metrics.reconciliationCapabilitiesRejected += 1;
        return {
          status: "rejected",
          reason: "child_identity_occupied",
          detail: `child ${childTransactionId.slice(0, 24)} 已被占用（${occupied}）——不签发 capability、不生成第二个 child`,
        };
      }
      // durable 推进：rearm_ready → capability_issued（handoff facts 冻结：
      // nextChild + pendingBindingDigest——单一权威 helper）。
      const issued = stageTreasuryLineageCapabilityIssued(lineage.lineageId, childTransactionId);
      if (issued.status === "rejected") {
        metrics.reconciliationCapabilitiesRejected += 1;
        return {
          status: "rejected",
          reason: "lineage_write_failed",
          detail: `lineage capability_issued 推进失败（capability 不签发，lineage 保持 ready 可重试）: ${issued.detail}`,
        };
      }
      const record = issued.record;
      const bindingDigest = computeTreasuryLineageBindingDigest({
        lineageId: record.lineageId,
        generation: record.generation + 1,
        parentTransactionId: record.currentTransactionId,
        childTransactionId,
      });
      const capability = rearmCapabilityAuthority.registerCapability(
        {
          lineageId: record.lineageId,
          lineageRecordRevision: record.recordRevision,
          parentTransactionId: record.currentTransactionId,
          parentIdentityDigest: computeTreasuryLineageIdentityDigest(record.currentIdentity),
          childTransactionId,
          generation: record.generation + 1,
          retrySemanticDigest: record.retrySemanticDigest!,
          actionKind: record.actionKind,
          ...(record.adapterSemanticIdentity !== undefined ? { adapterSemanticIdentity: record.adapterSemanticIdentity } : {}),
          ...(record.ownerIdentity !== undefined ? { ownerIdentity: record.ownerIdentity } : {}),
          authorityClass: record.authorityClass,
          ...(record.authorityClass === "lowlevel" && record.lowlevelSource !== undefined ? { lowlevelSource: record.lowlevelSource } : {}),
          bindingDigest,
        },
        serviceGeneration,
        Game.time,
      );
      return { status: "issued", capability, childTransactionId };
    },

    /** @internal 单阶段兼容实现（勿直接调用）：经 treasury/compat 模块访问。 */
    recordAcceptedTransaction(input: TreasuryTransactionInput): TreasurySettlementResult {
      const compatShapeError = validateTreasuryTransactionInputShape(input, "record");
      if (compatShapeError !== null) {
        metrics.transactionsRejectedInvalid += 1;
        return { status: "rejected", reason: "invalid_input", detail: compatShapeError };
      }
      // 【第十七轮第八节】tr1_ 保留命名空间门禁（compat/低层 production 路径）：
      // 单阶段兼容入口不接受 rearm capability——tr1_ ID 无 binding 一律拒绝。
      if (isTreasuryRearmAttemptId(input.transactionId)) {
        metrics.transactionsRejectedInvalid += 1;
        return {
          status: "rejected",
          reason: "rearm_capability_required",
          detail: "tr1_ rearm child attempt 不得经单阶段 compat 路径登记（必须经 contract 授权 + capability 接管协议执行）",
        };
      }
      const state = ensureTickState(true);
      // 幂等优先于一切：已结算 id 的重放无论决策上下文一律 already_settled。
      const settledAt = projection.isSettled(input.transactionId);
      if (settledAt !== undefined) {
        metrics.duplicateSettlementsRejected += 1;
        return { status: "already_settled", transactionId: input.transactionId, firstRecordedAtTick: settledAt };
      }
      // 【第十六轮第五节】same-ID 不可重试（单阶段 compat 入口同样封死）。
      if (peekTreasuryResolutionStoreEntry() !== undefined) {
        const notExecutedTombstone = readTreasuryResolutionTombstone(input.transactionId);
        if (notExecutedTombstone !== undefined && notExecutedTombstone.stage === "final" && notExecutedTombstone.resolution === "not-executed") {
          metrics.transactionsRejectedInvalid += 1;
          return {
            status: "rejected",
            reason: "rearm_required",
            detail: `transactionId ${input.transactionId.slice(0, 48)} 已 final not-executed——重试必须显式 rearm（同 ID 只标识一个执行 attempt）`,
          };
        }
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
      return internalService.recordAcceptedTransaction({
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
      return internalService.strictProjectedUsedCapacity(roomName, kind);
    },

    strictProjectedUsedCapacity(roomName: string, kind: TreasuryLocationKind): number {
      // 严格口径：observed.used + 本 tick overlay 净变化（不含风险扣减）。
      return internalService.observation().usedCapacity(roomName, kind) + projection.locationCapacityDelta(roomName, kind);
    },

    strictProjectedFreeCapacity(roomName: string, kind: TreasuryLocationKind): number {
      // 严格口径：observed.free − overlay 净变化——与 strictProjectedUsed
      // 互补（两者之和 = physical capacity，不含任何风险扣减）。
      return internalService.observation().freeCapacity(roomName, kind) - projection.locationCapacityDelta(roomName, kind);
    },

    riskAdjustedFreeCapacity(roomName: string, kind: TreasuryLocationKind): number {
      // risk-adjusted：严格 free 再扣 quarantine/unresolved intent 正流入
      // 占用（可能已流入的 uncertain 资源占用空间；receiver admission 用）。
      metrics.riskAdjustedCapacityLookups += 1;
      const quarantineOccupancy = treasuryQuarantineCapacityOccupancy().get(`${roomName}\u0000${kind}`) ?? 0;
      const intentOccupancy = treasuryIntentCapacityOccupancy().get(`${roomName}\u0000${kind}`) ?? 0;
      return (
        internalService.observation().freeCapacity(roomName, kind) -
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
        internalService.observation().freeCapacity(roomName, kind) -
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
        authorizationsActive: authorizationLedger.activeCount(),
        resolutionInProgress: resolutionHealth.inProgress,
        resolutionFaulted: metrics.resolutionFaulted + resolutionStoreCounters.faulted,
        resolutionRecovered: metrics.resolutionRecovered + resolutionStoreCounters.recovered,
        resolutionIdentityConflicts: resolutionStoreCounters.identityConflicts,
        resolutionIdentityInsufficient: resolutionStoreCounters.identityInsufficientBlockers,
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
      authorizationLedger.resetForTest();
      lastPreparedLeakAudit = Object.freeze({
        context: "end_tick",
        outstanding: 0,
        executing: 0,
        samples: Object.freeze([]),
      });
    },
  };

  // ── resolution kernel（第十一轮 3.13.8）：以 non-enumerable symbol 挂载
  //    于 service 运行时对象（模块级注册机制删除——faultResolution 直接
  //    经 symbol 读取，伪造对象无该属性一律无效）。 ──────────────────────────
  // 单阶段入口不在公共 TreasuryService 接口上——经 compat 模块以内部
  // 形状访问（生产 writer 禁用；测试经 compatRecordAcceptedTransaction）。
  // ── writer kernel（第十轮 3.12.5）：唯一持有低层原语的内部对象，以
  //    unique symbol、non-enumerable 挂载——普通生产模块的类型与运行时
  //    枚举均不可达；treasury 协议栈（actionContracts）与 testHarness 经
  //    kernelChannel 访问。 ──────────────────────────────────────────────────
  const writerKernel: TreasuryWriterKernel = {
    authorizeResourceUse: (request) => internalService.authorizeResourceUse(request),
    consumeTreasuryAuthorization: (token, options) => internalService.consumeTreasuryAuthorization(token, options),
    validateTreasuryAuthorizationForRedeem: (tokens, contract, postings) =>
      internalService.validateTreasuryAuthorizationForRedeem(tokens, contract, postings),
    prepareTransaction: (input, prepareOptions) =>
      internalService.prepareTransaction(input, prepareOptions),
    executePreparedAction: (input, action, execution) =>
      internalService.executePreparedAction(input, action, execution),
    commitPreparedTransaction: (handle) => internalService.commitPreparedTransaction(handle),
      abortPreparedTransaction: (handle) => internalService.abortPreparedTransaction(handle),
      /**
       * opaque bundle 只读解析（第十轮 3.12.3，actionContracts 执行前调用）：
       * 对象身份验证 + contract 匹配 + digest 返回（零状态变化、零消费）。
       */
      resolveAuthorizationBundle: (bundle, contract) =>
        resolveAuthorizationBundleReadOnly(bundle, contract),
    };

  // 公共 service：白名单方法（低层原语不在其上——运行时枚举零暴露）。
  const service: TreasuryService = {
    beginTick: internalService.beginTick,
    endTick: internalService.endTick,
    observation: internalService.observation,
    beginFreshObservation: internalService.beginFreshObservation,
    commitments: internalService.commitments,
    query: internalService.query,
    authorizeTreasuryActionContract: internalService.authorizeTreasuryActionContract,
    issueTreasuryReconciliationCapability: internalService.issueTreasuryReconciliationCapability,
    resolveUnresolvedTransaction: internalService.resolveUnresolvedTransaction,
    issueTreasuryRearmCapability: internalService.issueTreasuryRearmCapability,
    preparedLeakAudit: internalService.preparedLeakAudit,
    journal: internalService.journal,
    lastReconciliation: internalService.lastReconciliation,
    projectedUsedCapacity: internalService.projectedUsedCapacity,
    projectedFreeCapacity: internalService.projectedFreeCapacity,
    strictProjectedUsedCapacity: internalService.strictProjectedUsedCapacity,
    strictProjectedFreeCapacity: internalService.strictProjectedFreeCapacity,
    riskAdjustedFreeCapacity: internalService.riskAdjustedFreeCapacity,
    projectionRevision: internalService.projectionRevision,
    metrics: internalService.metrics,
    resetForTest: internalService.resetForTest,
  };
  Object.defineProperty(service, TREASURY_RESOLUTION_KERNEL, {
    value: Object.freeze({
      validateReconciliationCapability: (capability: unknown) =>
        internalService.validateReconciliationCapability(capability),
      consumeReconciliationCapability: (capability: unknown) =>
        internalService.consumeReconciliationCapability(capability),
    } satisfies TreasuryResolutionKernel),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(service, TREASURY_WRITER_KERNEL, {
    value: Object.freeze({
      ...writerKernel,
      // compat 单阶段入口（测试专用；treasuryCore 等经 testHarness 访问）。
      recordAcceptedTransaction: internalService.recordAcceptedTransaction,
      recordAcceptedAction: internalService.recordAcceptedAction,
    } satisfies TreasuryWriterKernel & Record<string, unknown>),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return service;
}
