/**
 * Empire Treasury——帝国国库核心类型。
 *
 * 语义分层（详见 openspec/changes/empire-treasury-rearchitecture/design.md）：
 * - Observed：本 tick 观察到的物理事实（不可变，绝不持久化到 Memory）；
 * - Projected：Observed + 本 tick 已被 Game 接受的动作增量（transaction 结算）；
 * - Committed：未执行但已被任务/预留/合同占用（每 tick 从持久权威构建只读索引）。
 *
 * 依赖约束：treasury 模块不得 import runtimeServices（服务由其注入房间源），
 * 查询路径（observation/query/commitments/journal/reconciliation/metrics）
 * 零写入 Memory 与 Game；只有生命周期（beginTick/endTick）与已接受动作
 * 登记路径允许写最小 receipt/指标状态。
 */

// ─── 物理位置 ───────────────────────────────────────────────────────────────

/** 第一阶段受管辖位置；后续扩展 labs/factory/powerSpawn/nuker/container/creep 等。 */
export type TreasuryLocationKind = "storage" | "terminal";

export function treasuryLocationKey(roomName: string, kind: TreasuryLocationKind): string {
  return `${roomName}:${kind}`;
}

// ─── Observation epoch ──────────────────────────────────────────────────────

export type TreasuryObservationScope = "shared" | "market-fresh";

/**
 * 观察纪元：同一 (scope, epochSeq) 的 Observed 不可变。
 * scope="shared" 每 tick 恰好发行一次（beginTick）；"market-fresh" 每次独立
 * 构建、不进缓存（市场 fresh-read 语义的未来接入点，禁止复用共享 snapshot）。
 * 每 tick 发行的 epoch（shared + 全部 fresh）登记进 facade 的 epoch 注册表；
 * 已接受动作登记必须携带决策所依据的 epoch 并通过注册表校验。
 */
export interface TreasuryEpoch {
  readonly scope: TreasuryObservationScope;
  readonly epochSeq: number;
  readonly observedAtTick: number;
}

/** 单个受管辖位置的稀疏物理桶。amounts 只含非零资源 key（冻结）。 */
export interface TreasuryLocationObservation {
  readonly roomName: string;
  readonly kind: TreasuryLocationKind;
  readonly exists: boolean;
  readonly structureId: string | undefined;
  readonly amounts: Readonly<Record<string, number>>;
  readonly usedCapacity: number;
  readonly freeCapacity: number;
}

/** 房间级观察（storage/terminal 各一桶，缺失位置以 exists=false 占位）。 */
export interface TreasuryRoomObservation {
  readonly roomName: string;
  readonly storage: TreasuryLocationObservation;
  readonly terminal: TreasuryLocationObservation;
}

/** 冻结的观察数据；查询走 TreasuryObservationView，不暴露内部索引。 */
export interface TreasuryObservationData {
  readonly epoch: TreasuryEpoch;
  readonly rooms: readonly TreasuryRoomObservation[];
  /** 帝国总量 = 全部位置桶之和（不变量：构建期求和，shadow/test 校验）。 */
  readonly empireTotals: Readonly<Record<string, number>>;
}

export interface TreasuryObservationView {
  readonly data: TreasuryObservationData;
  readonly epoch: TreasuryEpoch;
  roomNames(): readonly string[];
  hasRoom(roomName: string): boolean;
  locationExists(roomName: string, kind: TreasuryLocationKind): boolean;
  location(roomName: string, kind: TreasuryLocationKind): TreasuryLocationObservation;
  amount(roomName: string, kind: TreasuryLocationKind, resource: string): number;
  /** room 内受管辖位置（storage+terminal）合计物理量。 */
  roomAmount(roomName: string, resource: string): number;
  roomResources(roomName: string): readonly string[];
  empireTotal(resource: string): number;
  empireResources(): readonly string[];
  usedCapacity(roomName: string, kind: TreasuryLocationKind): number;
  freeCapacity(roomName: string, kind: TreasuryLocationKind): number;
  /** epoch 落后于当前 tick 时为 true；stale 观察不得用于即时授权。 */
  isStale(): boolean;
}

// ─── Transaction Journal / Projected Overlay ────────────────────────────────

/**
 * 已被 Game 接受的动作的单腿记账：一个 (room, location, resource) 的整数增量。
 * 一个动作（terminal.send / market deal / 搬运 / lab / factory）由一个
 * transaction 的多个 posting 原子表达；不存在"半笔"transaction。
 */
export interface TreasuryPosting {
  readonly roomName: string;
  readonly locationKind: TreasuryLocationKind;
  readonly resource: string;
  /** 有限非零整数；正=流入该位置，负=流出。 */
  readonly delta: number;
}

/** 调用方作出决策所依据的 observation epoch（decision binding）。 */
export interface TreasuryDecisionContext {
  readonly scope: TreasuryObservationScope;
  readonly epochSeq: number;
  readonly observedAtTick: number;
}

/**
 * 唯一权威登记入口的输入。transactionId 幂等键在 Treasury 边界受格式约束
 * （见 formatTreasuryTransactionId / TREASURY_TRANSACTION_ID_MAX_LENGTH），
 * 禁止调用方随意传入易碰撞的任意字符串。
 */
export interface TreasuryTransactionInput {
  readonly transactionId: string;
  readonly kind: string;
  readonly source: string;
  readonly decision: TreasuryDecisionContext;
  readonly postings: readonly TreasuryPosting[];
}

/** 单 posting convenience 输入（内部转 transaction；decision 仍必填）。 */
export interface TreasuryRecordActionInput {
  readonly transactionId: string;
  readonly kind: string;
  readonly roomName: string;
  readonly locationKind: TreasuryLocationKind;
  readonly resource: string;
  readonly delta: number;
  readonly source: string;
  readonly decision: TreasuryDecisionContext;
}

export type TreasuryRejectionReason =
  | "invalid_transaction_id"
  | "invalid_kind"
  | "invalid_source"
  | "no_postings"
  | "no_op_transaction"
  | "invalid_posting_delta"
  | "invalid_posting_resource"
  | "invalid_posting_room"
  | "unknown_room"
  | "location_missing"
  | "insufficient_amount"
  | "capacity_overflow"
  | "tick_closed"
  | "stale_epoch"
  | "unknown_epoch"
  | "scope_mismatch"
  | "receipt_capacity_exhausted"
  | "receipt_store_incompatible"
  | "unknown_prepare"
  | "prepare_invalidated";

/** rejected 形状（验证/门禁/登记共用的具体拒绝结果）。 */
export interface TreasuryRejectedResult {
  readonly status: "rejected";
  readonly reason: TreasuryRejectionReason;
  readonly detail?: string;
}

export type TreasurySettlementResult =
  | { readonly status: "recorded"; readonly transactionId: string; readonly postings: number; readonly tick: number }
  | { readonly status: "already_settled"; readonly transactionId: string; readonly firstRecordedAtTick: number }
  | TreasuryRejectedResult;

// ─── 两阶段 transaction 协议（prepare → Game API → commit/abort） ───────────

/**
 * prepare 阶段结果：完整验证（幂等/admission 预检/格式/物理可行性）通过并
 * 预留 receipt 槽位——此后调用方执行真实 Game 写动作，成功则 commit、
 * 失败则 abort，Treasury 不得再因自身状态（容量/epoch/损坏）拒绝兑现。
 */
export type TreasuryPreparationResult =
  | { readonly status: "prepared"; readonly transactionId: string; readonly preparedAtTick: number }
  | { readonly status: "already_settled"; readonly transactionId: string; readonly firstRecordedAtTick: number }
  | { readonly status: "rejected"; readonly reason: TreasuryRejectionReason; readonly detail?: string };

/**
 * commit 兑现结果：prepared（已预留）唯一安全终态。重复 commit 返回
 * already_settled；prepare→commit 期间 overlay 被其他 transaction 改变
 * 导致物理重验失败时拒绝（prepare_invalidated，不产生任何状态）。
 */
export type TreasuryPreparedCommitResult =
  | { readonly status: "committed"; readonly transactionId: string; readonly postings: number; readonly tick: number }
  | { readonly status: "already_settled"; readonly transactionId: string; readonly firstRecordedAtTick: number }
  | { readonly status: "rejected"; readonly reason: TreasuryRejectionReason; readonly detail?: string };

/** abort 结果：释放 prepare 预留，零状态；已 commit 的 prepare 不可 abort。 */
export type TreasuryPreparedAbortResult =
  | { readonly status: "aborted"; readonly transactionId: string }
  | { readonly status: "already_finalized"; readonly transactionId: string; readonly committedAtTick: number }
  | { readonly status: "unknown_prepare"; readonly transactionId: string };

/** 一笔已结算 transaction 的冻结 journal 条目（postings 全量保留在 heap）。 */
export interface TreasuryJournalEntry {
  readonly transactionId: string;
  readonly kind: string;
  readonly source: string;
  readonly decisionScope: TreasuryObservationScope;
  readonly epochSeq: number;
  readonly recordedAtTick: number;
  readonly postings: readonly TreasuryPosting[];
}

/** 上一 tick 归档的投影终态条目（含 structureId 供 incarnation 对账）。 */
export interface TreasuryProjectedFinal {
  readonly roomName: string;
  readonly locationKind: TreasuryLocationKind;
  readonly resource: string;
  readonly amount: number;
  readonly structureId: string | undefined;
}

/**
 * 位置结构 manifest 条目：与资源维度无关的结构生命周期事实（空 storage/
 * terminal 的新建/摧毁、structureId 替换、无结构 owned 房间的出现/丢失）。
 * 零资源结构在稀疏 amounts 中不可见——manifest 层独立对账。
 */
export interface TreasuryLocationManifestEntry {
  readonly roomName: string;
  readonly locationKind: TreasuryLocationKind;
  readonly exists: boolean;
  readonly structureId: string | undefined;
  readonly usedCapacity: number;
  readonly freeCapacity: number;
}

/** endTick 归档的房间/位置 manifest（对账基准的一部分，只在 heap）。 */
export interface TreasuryTickManifest {
  readonly tick: number;
  /** 注入房间源的全部房间名（含无 storage/terminal 的房间）。 */
  readonly rooms: readonly string[];
  readonly locations: readonly TreasuryLocationManifestEntry[];
}

/** endTick 归档：资源投影终态 + 结构 manifest（下一 tick 对账的完整基准）。 */
export interface TreasuryProjectedArchive {
  readonly tick: number;
  readonly finals: Map<string, TreasuryProjectedFinal>;
  readonly manifest: TreasuryTickManifest;
}

export type TreasuryReconciliationCategory =
  | "inflow"
  | "outflow"
  | "new_resource"
  | "new_location"
  | "new_room"
  | "room_lost"
  | "location_lost"
  | "structure_replaced";

export interface TreasuryReconciliationSample {
  readonly tick: number;
  readonly roomName: string;
  readonly locationKind: TreasuryLocationKind;
  /** 结构层样本无资源语义（空结构事件），填 ""。 */
  readonly resource: string;
  readonly projectedFinal: number;
  readonly observedNow: number;
  /** observedNow - projectedFinal：正=外部流入，负=外部流出（结构层恒 0）。 */
  readonly diff: number;
  readonly category: TreasuryReconciliationCategory;
  readonly previousStructureId: string | undefined;
  readonly currentStructureId: string | undefined;
  /** 与该差异相关的上一 tick transaction 追溯（有界）。 */
  readonly transactionIds: readonly string[];
  readonly transactionKinds: readonly string[];
  /** structure=manifest 结构层（每位置至多一条）；resource=资源数量层。 */
  readonly dimension: "structure" | "resource";
}

export interface TreasuryReconciliationSummary {
  readonly previousTick: number | null;
  readonly currentTick: number;
  /** previousTick + 1 !== currentTick（生命周期 gap，差异为 gap 累积值）。 */
  readonly tickGap: boolean;
  /** heap 丢失但 Memory 生命周期记录仍在（global reset 恢复，无严格对账基准）。 */
  readonly afterGlobalReset: boolean;
  readonly checkedEntries: number;
  readonly inflowMismatches: number;
  readonly outflowMismatches: number;
  readonly structuralChanges: number;
  readonly samples: readonly TreasuryReconciliationSample[];
}

// ─── Commitments ────────────────────────────────────────────────────────────

/** production reservation 只读投影（权威在 Memory.runtime.resourceReservations）。 */
export interface TreasuryReservationRecord {
  readonly roomName: string;
  readonly resource: string;
  readonly holderId: string;
  readonly amount: number;
  readonly expiresAt: number;
  readonly expired: boolean;
  readonly orphan: boolean;
}

export interface TreasuryReceiverCommitments {
  readonly roomName: string;
  /** pending 且健康的入站任务 remaining 合计（canonical 谓词）。 */
  readonly healthyIncomingAmount: number;
  readonly healthyIncomingTaskCount: number;
  readonly storageFreeCapacity: number;
  readonly terminalFreeCapacity: number;
  /** free − healthyIncoming：可负（负值即超卖信号，不静默钳制）。observed 口径。 */
  readonly storageHeadroom: number;
  readonly terminalHeadroom: number;
  readonly overcommitted: boolean;
  /** projected 口径（observed free 减去本 tick 已结算 transaction 的容量净变化）。 */
  readonly projectedStorageHeadroom: number;
  readonly projectedTerminalHeadroom: number;
  readonly projectedOvercommitted: boolean;
}

export interface TreasuryCommitmentMetrics {
  readonly taskRecords: number;
  readonly pendingTaskRecords: number;
  readonly reservationRecords: number;
  readonly activeReservationRecords: number;
  readonly expiredReservationsExcluded: number;
  readonly orphanReservationsExcluded: number;
  readonly indexQueries: number;
}

/**
 * 承诺统一索引：构建期一次性聚合为 primitive 快照（不保留 task/reservation
 * 对象引用），构建后同一 revision 下所有查询结果一致。权威数据变更由
 * mutation 侧 bumpTreasuryCommitmentRevision 通知 facade 失效重建。
 */
export interface TreasuryCommitmentIndex {
  readonly builtAtTick: number;
  readonly revision: number;
  /** donor 侧承诺：pending 任务 remaining（全部 pending，不筛健康）。 */
  outgoing(roomName: string, resource: string): number;
  pendingOutgoing(roomName: string, resource: string, reasonPrefix?: string): number;
  /** 需求覆盖口径入站（manual 永远计入；automatic 按 canonical 生命周期判定）。 */
  incoming(roomName: string, resource: string): number;
  pendingIncoming(roomName: string, resource: string): number;
  incomingTaskCount(roomName: string): number;
  outgoingTaskCount(roomName: string): number;
  /** route merge：同 route/origin/reason 的可合并 pending 任务 id（预构建索引，零线性扫描）。 */
  findMergeableTaskId(resource: string, fromRoomName: string, toRoomName: string, origin: "manual" | "automatic", reason?: string): string | null;
  /** 活跃（未过期且未孤儿）生产预留合计；excludeHolderId 用于 owner 自排除。 */
  reservedProduction(roomName: string, resource: string, excludeHolderId?: string): number;
  reservationSnapshot(): readonly TreasuryReservationRecord[];
  receiverCommitments(roomName: string): TreasuryReceiverCommitments;
  readonly metrics: TreasuryCommitmentMetrics;
}

// ─── 带上下文查询 ───────────────────────────────────────────────────────────

/**
 * owner 声明：调用方以固定身份持有 production reservation 时，可声明自身
 * holderId 与归属房间让查询排除自己已占用的部分（只在自己合法归属房间内
 * 排除自己，其他 owner 与其他房间照常扣除）。声明房间与运行时解析的
 * holder 真实归属不一致、holder 不存在或身份格式非法时一律 fail closed。
 */
/**
 * holder 身份类型：game-object（真实 Game 对象 id，如 factory 结构 id）或
 * logical（逻辑名 holder，如 `nuker:<id>:<resource>` / `synthesis:<room>:<resource>`）。
 * production reservation 的 holderId 两种形态并存——owner 声明必须与运行时
 * 解析出的类型一致（声明 game-object 但实为逻辑名 → fail closed），杜绝
 * "知道 holderId 字符串就能冒充任意类型 owner"。
 */
export type TreasuryHolderKind = "game-object" | "logical";

/** holder 运行时解析结果：身份类型 + 归属房间（存在性即"可解析出"）。 */
export interface TreasuryHolderResolution {
  readonly kind: TreasuryHolderKind;
  readonly roomName: string;
}

export type TreasuryOwnerScope = "production-reservation";

export interface TreasuryQueryOwner {
  readonly holderId: string;
  /** holder 身份类型（必须与运行时解析结果一致，否则 fail closed）。 */
  readonly holderKind: TreasuryHolderKind;
  readonly scope: TreasuryOwnerScope;
  /** 声明的 holder 归属房间（必须与运行时解析结果一致，否则 fail closed）。 */
  readonly roomName: string;
}

export type TreasuryOwnerStatus =
  | "none"
  | "excluded-own-reservations"
  | "invalid_fail_closed";

/** 查询上下文输入规范化结果：非法输入（非法资源/重复房间/重复位置/NaN withhold 等）fail closed。 */
export type TreasuryQueryContextStatus = "valid" | "invalid_fail_closed";

/**
 * 可用量查询上下文——禁止无上下文 available。
 * withhold 为调用方声明的策略保留（战略储备/市场保护），由策略层决定，
 * Treasury 不内置 floor（Policy/View Engine 的后续职责）。
 */
export interface TreasuryQueryContext {
  readonly resource: string;
  readonly rooms?: readonly string[];
  readonly locations?: readonly TreasuryLocationKind[];
  readonly allowProjected?: boolean;
  readonly allowIncoming?: boolean;
  readonly subtractOutgoing?: boolean;
  readonly subtractReservations?: boolean;
  readonly withhold?: number;
  /** owner-aware：合法时 reservedProduction 排除该 holder 自己的预留。 */
  readonly owner?: TreasuryQueryOwner;
}

export interface TreasuryBalanceView {
  readonly resource: string;
  readonly observed: number;
  readonly projected: number;
  readonly committed: number;
  readonly incoming: number;
  readonly spendable: number;
  readonly overcommitted: boolean;
  readonly ownerStatus: TreasuryOwnerStatus;
  /** invalid_fail_closed 时全部数量字段为 0（保守结论，不报乐观可用量）。 */
  readonly contextStatus: TreasuryQueryContextStatus;
  readonly epoch: TreasuryEpoch;
}

// ─── 性能指标（确定性操作计数） ─────────────────────────────────────────────

export interface TreasuryMetrics {
  observationRebuilds: number;
  observationReuseHits: number;
  freshObservationBuilds: number;
  locationsScanned: number;
  nonZeroEntries: number;
  storeEnumerations: number;
  resourceKeysEnumerated: number;
  /** Treasury 自身发起的 room.find 次数——必须恒为 0（复用注入房间源）。 */
  roomFindCalls: number;
  /** live store 回退读次数——必须恒为 0（观察冻结后不得回读 Game）。 */
  fallbackLiveReads: number;
  lifecycleBeginTicks: number;
  lifecycleEndTicks: number;
  /** beginTick 之前业务访问触发的懒初始化兜底（main 固定挂载后应趋近 0）。 */
  lifecycleLazyInitializations: number;
  /** beginTick 发现上一 tick 缺少 endTick 的补救归档次数。 */
  lifecycleMissingEndWarnings: number;
  tickGapReconciles: number;
  globalResetRecoveries: number;
  commitmentRebuilds: number;
  commitmentRecords: number;
  commitmentIndexQueries: number;
  expiredCommitmentsExcluded: number;
  orphanReservationsExcluded: number;
  transactionsRecorded: number;
  postingsRecorded: number;
  transactionsRejectedInvalid: number;
  duplicateSettlementsRejected: number;
  staleEpochRejections: number;
  unknownEpochRejections: number;
  epochScopeMismatches: number;
  settlementsAfterEndRejected: number;
  receiptsEvictedByRetention: number;
  /** 满容且无过期可回收导致的 admission 拒绝（独立可审计）。 */
  receiptCapacityRejections: number;
  /** v1/v2→v3 等已知版本迁移执行次数（正常每次升级 ≤1）。 */
  receiptStoreMigrationsExecuted: number;
  /** 未知版本/手工损坏的 fail-closed 检出次数（持续拒绝登记直至人工处理）。 */
  receiptStoreIncompatibleFailures: number;
  /** receipt 全表扫描次数（load 校验/迁移/到期清理；正常路径不随操作数增长）。 */
  receiptFullScans: number;
  /** 未触发扫描即得出结论的 admission 次数（快路径）。 */
  receiptAdmissionFastPaths: number;
  /** 满容 O(1) 拒绝次数（未到过期点不做全表扫描）。 */
  receiptAdmissionFullStoreBlocked: number;
  /** 到达过期点触发的清理扫描次数。 */
  receiptExpiryCleanupScans: number;
  /** 剩余可登记槽位（MAX − entryCount − pending 预留；gauge）。 */
  receiptSlotsRemaining: number;
  /** 下一次可能过期的 tick（null = 空表/store 不可用；gauge）。 */
  receiptNextExpiryTick: number | null;
  /** 非 fresh epoch 数量达到上限后的拒绝次数（CPU 保护）。 */
  freshEpochLimitRejections: number;
  /** 两阶段 prepare 成功次数。 */
  transactionsPrepared: number;
  /** 两阶段 abort 次数（零状态释放）。 */
  transactionPreparesAborted: number;
  /** prepare→commit 期间物理重验失败的兑现拒绝次数（竞态信号）。 */
  prepareInvalidatedCommits: number;
  /** 非法查询上下文（非法资源/重复房间/重复位置/NaN withhold 等）fail-closed 次数。 */
  queryInvalidContexts: number;
  reconciliationInflowMismatches: number;
  reconciliationOutflowMismatches: number;
  reconciliationStructuralChanges: number;
  reconciliationChecks: number;
}

export function createTreasuryMetrics(): TreasuryMetrics {
  return {
    observationRebuilds: 0,
    observationReuseHits: 0,
    freshObservationBuilds: 0,
    locationsScanned: 0,
    nonZeroEntries: 0,
    storeEnumerations: 0,
    resourceKeysEnumerated: 0,
    roomFindCalls: 0,
    fallbackLiveReads: 0,
    lifecycleBeginTicks: 0,
    lifecycleEndTicks: 0,
    lifecycleLazyInitializations: 0,
    lifecycleMissingEndWarnings: 0,
    tickGapReconciles: 0,
    globalResetRecoveries: 0,
    commitmentRebuilds: 0,
    commitmentRecords: 0,
    commitmentIndexQueries: 0,
    expiredCommitmentsExcluded: 0,
    orphanReservationsExcluded: 0,
    transactionsRecorded: 0,
    postingsRecorded: 0,
    transactionsRejectedInvalid: 0,
    duplicateSettlementsRejected: 0,
    staleEpochRejections: 0,
    unknownEpochRejections: 0,
    epochScopeMismatches: 0,
    settlementsAfterEndRejected: 0,
    receiptsEvictedByRetention: 0,
    receiptCapacityRejections: 0,
    receiptStoreMigrationsExecuted: 0,
    receiptStoreIncompatibleFailures: 0,
    receiptFullScans: 0,
    receiptAdmissionFastPaths: 0,
    receiptAdmissionFullStoreBlocked: 0,
    receiptExpiryCleanupScans: 0,
    receiptSlotsRemaining: 0,
    receiptNextExpiryTick: null,
    freshEpochLimitRejections: 0,
    transactionsPrepared: 0,
    transactionPreparesAborted: 0,
    prepareInvalidatedCommits: 0,
    queryInvalidContexts: 0,
    reconciliationInflowMismatches: 0,
    reconciliationOutflowMismatches: 0,
    reconciliationStructuralChanges: 0,
    reconciliationChecks: 0,
  };
}
