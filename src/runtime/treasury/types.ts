/**
 * Empire Treasury——帝国国库核心类型。
 *
 * 语义分层（详见 openspec/changes/empire-treasury-rearchitecture/design.md）：
 * - Observed：本 tick 观察到的物理事实（不可变，绝不持久化到 Memory）；
 * - Projected：Observed + 本 tick 已被 Game 接受的动作增量（journal 结算）；
 * - Committed：未执行但已被任务/预留/合同占用（每 tick 从持久权威构建只读索引）。
 *
 * 依赖约束：treasury 模块不得 import runtimeServices（服务由其注入房间源），
 * 不得在查询路径写 Memory/Game（零隐藏写入）。
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
 * scope="shared" 每 tick 至多构建一次并缓存；"market-fresh" 每次独立构建、
 * 不进缓存（市场 fresh-read 语义的未来接入点，禁止复用共享 snapshot）。
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

/** 已被 Game 接受的动作（调用方在 API 返回 OK 后显式登记；禁止预登记失败动作）。 */
export interface TreasuryJournalEntry {
  readonly actionId: string;
  readonly kind: string;
  readonly roomName: string;
  readonly locationKind: TreasuryLocationKind;
  readonly resource: string;
  readonly delta: number;
  readonly recordedAtTick: number;
  readonly epochSeq: number;
  readonly source: string;
}

export interface TreasuryRecordActionInput {
  readonly actionId: string;
  readonly kind: string;
  readonly roomName: string;
  readonly locationKind: TreasuryLocationKind;
  readonly resource: string;
  readonly delta: number;
  readonly source: string;
}

export type TreasuryRecordActionResult =
  | { readonly status: "recorded"; readonly entry: TreasuryJournalEntry }
  | { readonly status: "already_settled"; readonly actionId: string; readonly firstRecordedAtTick: number }
  | { readonly status: "stale_epoch"; readonly observedAtTick: number };

export interface TreasuryReconciliationSample {
  readonly tick: number;
  readonly roomName: string;
  readonly locationKind: TreasuryLocationKind;
  readonly resource: string;
  readonly projectedFinal: number;
  readonly observedNow: number;
  /** observedNow - projectedFinal：正=外部流入，负=外部流出。 */
  readonly diff: number;
}

export interface TreasuryReconciliationSummary {
  readonly previousTick: number | null;
  readonly checkedEntries: number;
  readonly inflowMismatches: number;
  readonly outflowMismatches: number;
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
  /** free − healthyIncoming：可负（负值即超卖信号，不静默钳制）。 */
  readonly storageHeadroom: number;
  readonly terminalHeadroom: number;
  readonly overcommitted: boolean;
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

export interface TreasuryCommitmentIndex {
  readonly builtAtTick: number;
  /** donor 侧承诺：pending 任务 remaining（全部 pending，不筛健康）。 */
  outgoing(roomName: string, resource: string): number;
  pendingOutgoing(roomName: string, resource: string, reasonPrefix?: string): number;
  /** 需求覆盖口径入站（manual 永远计入；automatic 按 canonical 生命周期判定）。 */
  incoming(roomName: string, resource: string): number;
  pendingIncoming(roomName: string, resource: string): number;
  incomingTaskCount(roomName: string): number;
  outgoingTaskCount(roomName: string): number;
  /** route merge：同 route/origin/reason 的可合并 pending 任务 id（等价旧 findMergeablePendingTask）。 */
  findMergeableTaskId(resource: string, fromRoomName: string, toRoomName: string, origin: "manual" | "automatic", reason?: string): string | null;
  /** 活跃（未过期且未孤儿）生产预留合计；excludeHolderId 用于 owner 自排除。 */
  reservedProduction(roomName: string, resource: string, excludeHolderId?: string): number;
  reservationSnapshot(): readonly TreasuryReservationRecord[];
  receiverCommitments(roomName: string): TreasuryReceiverCommitments;
  readonly metrics: TreasuryCommitmentMetrics;
}

// ─── 带上下文查询 ───────────────────────────────────────────────────────────

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
}

export interface TreasuryBalanceView {
  readonly resource: string;
  readonly observed: number;
  readonly projected: number;
  readonly committed: number;
  readonly incoming: number;
  readonly spendable: number;
  readonly overcommitted: boolean;
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
  commitmentRebuilds: number;
  commitmentRecords: number;
  commitmentIndexQueries: number;
  expiredCommitmentsExcluded: number;
  orphanReservationsExcluded: number;
  journalEntries: number;
  duplicateSettlementsRejected: number;
  staleEpochRejections: number;
  reconciliationInflowMismatches: number;
  reconciliationOutflowMismatches: number;
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
    commitmentRebuilds: 0,
    commitmentRecords: 0,
    commitmentIndexQueries: 0,
    expiredCommitmentsExcluded: 0,
    orphanReservationsExcluded: 0,
    journalEntries: 0,
    duplicateSettlementsRejected: 0,
    staleEpochRejections: 0,
    reconciliationInflowMismatches: 0,
    reconciliationOutflowMismatches: 0,
    reconciliationChecks: 0,
  };
}
