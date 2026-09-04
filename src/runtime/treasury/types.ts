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

import type { TreasuryOwnerIdentity } from "@/runtime/treasury/ownerIdentity";

export type { TreasuryOwnerIdentity };

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
  | "internal_authorization_fault"
  | "intent_conflict"
  /** 统一 durable action identity 冲突（第十一轮 3.13.5：同 ID 不同 identity——store 原数据不动）。 */
  | "identity_conflict"
  /** 【第十四轮第九节 9.4】production 定级不变量破坏（partial-modern 不得写 lowlevel authority——callback 零调用 fail closed）。 */
  | "authority_invariant_violation"
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
  /** 两阶段：相同 transactionId 绑定了不同 canonical payload（digest 不一致）。 */
  | "prepare_conflict"
  /** handle 非法：伪造对象/结构相同的普通对象/JSON 副本/其他 service 签发。 */
  | "invalid_handle"
  /** handle 已过期：tick 边界作废（endTick/beginTick/跨 tick 未 begin）。 */
  | "handle_expired"
  /** handle 已终态（committed/aborted 后再次 abort 等不允许的状态迁移）。 */
  | "handle_finalized"
  /** handle 所在 commit 发生意外内部故障（进入 faulted 终态，见 write fault）。 */
  | "handle_faulted"
  /** write admission 全局锁定（unresolved write fault；显式修复路径解除）。 */
  | "write_admission_locked"
  /** 【Remediation VI 4.7】completion/supersession store unhealthy（零 archive 零删除零 callback——fail closed）。 */
  | "completion_store_unhealthy"
  /** 【Remediation VI 4.7】completion headroom 回收后仍不足（满载且无更多安全可回收项，completion 均保留——fail closed）。 */
  | "completion_headroom_exhausted"
  /** transaction 处于 durable quarantine（Game 结果未知/commit 故障未对账，
   *  跨 tick 持久占用资源与 transaction identity；显式 resolution 解除前
   *  不得再次 prepare）。 */
  | "transaction_quarantined"
  /** 【第十六轮第五节】同 ID 已 final not-executed：一个 transaction ID
   *  永远只标识一个执行 attempt——重试必须显式 rearm 生成 child attempt
   *  ID（rearmResolvedNotExecutedAttempt），不得直接重用 parent ID。 */
  | "rearm_required"
  /** 【第十七轮第五节】root/current attempt ID 存在于 durable lineage
   *  record——永久 retired（tombstone 驱逐后仍不可直接 prepare）。 */
  | "retired_attempt"
  /** 【第十七轮第八节】tr1_ 保留命名空间：必须携带匹配 opaque rearm
   *  capability（initial attempt 不得使用 tr1_；手工拼接/无 capability 一律拒绝）。 */
  | "rearm_capability_required"
  /** 【第十七轮第八节】rearm capability 无效（未签发/已消费/跨 tick/跨
   *  service/绑定不匹配/lineage revision 变化/retry 语义不匹配）。 */
  | "rearm_capability_invalid"
  /** 【第十七轮第十二节】child ID 已被任一 durable store 或其它 lineage 占用。 */
  | "child_identity_occupied"
  /** 【第十七轮第十二节】parent 同时存在 not-executed 与 committed proof。 */
  | "proof_conflict"
  | "proof_insufficient"
  /** 【Round 22 Remediation X 工作流 A】issued ticket store 损坏（版本未知/
   *  entry 损坏/超容量）：ti2_ execution authority 不可判定，fail closed。 */
  | "issued_ticket_store_unhealthy"
  /** 【X 工作流 A / T1】无 matching issued ticket——issuer watermark 只证明
   *  序号已消耗，不构成 execution authority（裸 mint ID 不可执行）。 */
  | "issued_ticket_missing"
  /** 【X 工作流 A / T3】issued ticket 已 TTL 显式过期——永不可执行。 */
  | "issued_ticket_expired"
  /** 【X 工作流 A / T9】ticket 已 consumed 且无 durable lifecycle owner——
   *  手工 consume 不产生执行权限，fail closed。 */
  | "issued_ticket_consumed_without_owner"
  /** 【X 工作流 B / T8】durable lifecycle owner 已在位——ticket handoff 幂等
   *  完成后拒绝重复执行（同一 callback 不得再次执行）。 */
  | "issued_ticket_handoff_recovered"
  /** 【X 工作流 A / T6】ticket 已绑定其它 contract（不同 AC4 digest——同 ID
   *  的不同 exact opening 不得接管同一 ticket）。 */
  | "issued_ticket_binding_conflict"
  /** 【X 工作流 A】ticket 状态不可绑定/接管（非 active 等）。 */
  | "issued_ticket_state_conflict"
  /** 【Round 22 Remediation XI 工作流 A / H1-H5】durable owner 不可正向证明
   *  （store unhealthy / probe 未装配 / identity conflict 等保守阻断——非
   *  exact_owner）：handoff 不推进，ticket 保持 active，fail closed。 */
  | "issued_ticket_owner_unverifiable"
  /** 【XI 工作流 B / T6】ticket sequence 超出 issuer watermark——canonical
   *  ID 不构成发行事实（手工塞入的未来序号不得经 ticket 通道执行）。 */
  | "issued_ticket_unissued"
  /** 【XI 工作流 A / H7】execution-started 已持久化但 handoff consume 失败
   *  （非 store_unhealthy 类）——callback=0、保守关闭，下次 gate 幂等补完成。 */
  | "issued_ticket_handoff_failed"
  /** 【XII 工作流 A / O1-O2】同 ID durable owner 与当前 opening identity
   *  冲突（identity_conflict / outcome_conflict）——不同 opening 不得接管
   *  ticket，callback=0、ticket 保持原状态。 */
  | "issued_ticket_owner_conflict"
  /** 【XII 工作流 A / O5】owner source 只能给出 insufficient / legacy
   *  identity（legacy receipt 等 replay-only 权威）——不得升级为 modern
   *  exact owner，callback=0、ticket 保持原状态。 */
  | "issued_ticket_owner_insufficient"
  /** 【XII 工作流 A / O7】仅 protocol / retired 权威在位（certificate /
   *  retired range）——能阻断执行但不构成 exact owner，不得消费 active
   *  ticket，callback=0。 */
  | "issued_ticket_owner_protocol"
  /** 【XII 工作流 A / 4.4】同 ID 且 identity 一致的 execution/terminal
   *  owner 已在位（early probe 短路重试）——execution authority 已转移，
   *  本次 execute 拒绝（callback=0）；幂等 consume 由 beginTick 恢复路径
   *  承载，不重复执行。 */
  | "issued_ticket_owner_in_flight"
  /** 【XII 工作流 A / 4.4】该 attempt 已有 matching terminal settlement
   *  （matching_terminal_owner）——幂等完成、不产生第二个 attempt，
   *  callback=0。 */
  | "issued_ticket_already_settled"
  /** 【第十七轮第五节】attempt lineage store 损坏或容量满载（fail closed）。 */
  | "lineage_store_fatal"
  /** 全局 quarantine write blocker（第七轮）：存在任意 unresolved
   *  quarantine / legacy overflowed——新 transaction 一律拒绝（callback
   *  零调用）；write-fault marker 不是唯一锁来源。 */
  | "quarantine_write_blocked"
  /** quarantine store 损坏（版本未知/entry 损坏/聚合溢出）：fail closed，
   *  新 transaction 一律拒绝直至显式 repair。 */
  | "quarantine_store_fatal"
  /** quarantine fault-slot 预留失败（第七轮）：持久 quarantine 数 + active
   *  prepared 数已达上限——prepare 在 Game callback 之前拒绝（第 65 条
   *  fault 在 prepare 前被阻止）。 */
  | "quarantine_capacity_exhausted"
  /** runtime input 形状非法（canonicalization 前置验证失败——结构化拒绝，
   *  绝不抛出中断 tick；零 tentative/零槽位/零 registry 污染）。 */
  | "invalid_input"
  /** intent store 损坏（版本未知/entry 损坏）：fail closed，一切新 writer
   *  阻断直至显式 repair（第八轮）。 */
  | "intent_store_fatal"
  /** 存在 unresolved durable intent（Game API 途中/未关闭）：全局 write
   *  blocker——恢复完成前阻断新 prepare（第八轮）。 */
  | "intent_write_blocked"
  /** durable intent 写入失败（store fatal/容量满）：Game callback 零调用、
   *  tentative 与槽位释放（第八轮唯一安全顺序的前置）。 */
  | "intent_store_unavailable"
  /** callback 已返回后 intent phase 落盘失败（第九轮）：已知 Game 结果不得
   *  走普通 commit/abort——进入 durable emergency fault。 */
  | "intent_phase_write_failed"
  /** 授权 token 无效/失效/伪造/已被消费（第八轮）。 */
  | "authorization_invalid"
  /** action contract 非法（伪造/冻结校验失败/digest 不匹配）。 */
  | "contract_invalid"
  /** adapter 未注册（该 action kind 无注册 adapter）。 */
  | "adapter_not_registered"
  /** adapter kind 与 contract 不匹配。 */
  | "adapter_kind_mismatch"
  /** 结构 incarnation 已变化（contract 绑定的 structureId 不再匹配）。 */
  | "structure_replaced"
  /** 【第十三轮】同 id 既有 receipt proof 与当前 attempt identity 冲突
   *  （post-callback 防御：不发布 heap、保留 authority 待 resolution）。 */
  | "settlement_identity_conflict"
  /** 【第十三轮】同 id 既有 receipt proof 无法证明当前 modern attempt
   *  （legacy/insufficient proof：不发布 heap、不覆盖 proof、保持隔离）。 */
  | "settlement_proof_insufficient";

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
 * 不可伪造的 prepared handle（heap-only capability）：冻结对象，仅经
 * TreasuryService prepare 签发。运行时验证依赖服务实例私有 registry 的
 * 对象身份（WeakSet）——调用方自行构造结构相同的普通对象、或 JSON 序列化
 * 再反序列化的副本一律无效；handle 只在签发它的 service generation 与
 * 签发 tick 内有效（commit/abort 自行校验，不依赖调用方先 beginTick）。
 */
export interface TreasuryPreparedHandle {
  /** 结构性 brand（真实防伪在服务私有 registry，勿以此字段判定）。 */
  readonly __brand: "treasury-prepared-handle";
  readonly transactionId: string;
  /** canonical payload digest（16 hex；prepare_conflict 判定与审计样本用）。 */
  readonly digest: string;
}

/** handle 状态机：prepared →（executing）→ committing → committed / aborted；意外内部故障 → faulted；tick 边界 → expired。 */
export type TreasuryPreparedHandleState =
  | "prepared"
  | "executing"
  | "committing"
  | "committed"
  | "aborted"
  | "faulted"
  | "expired";

/**
 * prepare 阶段结果：完整验证（幂等/digest 冲突/格式/tentative 感知物理
 * 可行性）通过并预留资源、容量与 receipt 槽位——此后调用方执行真实
 * Game 写动作，成功则 commit、失败则 abort，Treasury 不得再因自身状态
 * （容量/epoch/损坏）拒绝兑现。相同 transactionId、相同 digest 的重复
 * prepare 幂等返回同一 handle；digest 不同返回 prepare_conflict。
 */
export type TreasuryPreparationResult =
  | {
      readonly status: "prepared";
      readonly handle: TreasuryPreparedHandle;
      readonly transactionId: string;
      readonly preparedAtTick: number;
      readonly digest: string;
    }
  | { readonly status: "already_settled"; readonly transactionId: string; readonly firstRecordedAtTick: number }
  | { readonly status: "rejected"; readonly reason: TreasuryRejectionReason; readonly detail?: string };

/**
 * commit 兑现结果：prepare 已预留（资源/容量/receipt 槽）唯一安全终态。
 * commit 执行 tentative → committed 兑现而非重新 admission——Game API 已
 * 返回 OK 后不再因资源、容量或 receipt 条件拒绝；重复 commit 幂等返回
 * already_settled。仅存 handle 非法/过期/终态/故障类拒绝。
 */
export type TreasuryPreparedCommitResult =
  | {
      readonly status: "committed";
      readonly transactionId: string;
      readonly postings: number;
      readonly tick: number;
      /** 【第十八轮 24.3】receipt/heap 已 committed 但 lineage chain_committed
       *  终态写入失败——receipt 是权威，intent 保留为 commit-pending proof，
       *  beginTick 按 matching receipt 补完成（不静默忽略）。 */
      readonly lineageFinalizationPending?: boolean;
    }
  | { readonly status: "already_settled"; readonly transactionId: string; readonly firstRecordedAtTick: number }
  | { readonly status: "rejected"; readonly reason: TreasuryRejectionReason; readonly detail?: string };

/**
 * abort 结果：原子释放 tentative 资源/容量/receipt 槽与 handle，零结算
 * 状态写入。已 committed 的 handle 不可 abort；已 aborted 的 handle 重复
 * abort 幂等返回 already_finalized。
 */
export type TreasuryPreparedAbortResult =
  | { readonly status: "aborted"; readonly transactionId: string }
  | { readonly status: "already_finalized"; readonly transactionId: string; finalizedAs: "committed"; readonly committedAtTick: number }
  | { readonly status: "already_finalized"; readonly transactionId: string; finalizedAs: "aborted" }
  | { readonly status: "rejected"; readonly reason: TreasuryRejectionReason; readonly detail?: string };

/** tick 边界 outstanding prepared 的有界审计样本。 */
export interface TreasuryPreparedLeakSample {
  readonly transactionId: string;
  readonly digest: string;
  readonly preparedAtTick: number;
  readonly kind: string;
  readonly source: string;
}

/** 最近一次 tick 边界审计快照（有界；executing>0 即视为严重异常）。 */
export interface TreasuryPreparedLeakAudit {
  readonly context: "end_tick" | "begin_tick_remedy";
  readonly outstanding: number;
  readonly executing: number;
  readonly samples: readonly TreasuryPreparedLeakSample[];
}

/**
 * 安全执行包装器结果（第六轮语义重定义——状态不可混淆）：
 * - prepare_rejected：prepare 阶段拒绝，Game callback 零调用（含
 *   transaction_quarantined / write_admission_locked / invalid_input 等）；
 * - executed_committed：Game callback 成功且 Treasury commit 成功；
 * - executed_aborted：Game callback 返回非成功，abort 已确认（零结算释放）；
 * - executed_abort_failed：Game callback 返回非成功，但 abort 未确认（资源
 *   仍被占用/故障）——不得当作已正常 abort；
 * - executed_unsettled：**Game callback 已成功但 Treasury commit 失败或进入
 *   write fault**——Game 动作已发生，绝不暗示未执行，禁止调用者自动重试
 *   （retryForbidden 恒 true）；携带原始 Game 结果与 fault identity 供诊断
 *   与显式 reconciliation；transaction 已进 durable fault/quarantine；
 * - already_settled：幂等命中（重放既有结算）。
 * callback 抛错：abort 确认后 rethrow 原始异常；abort 未确认 → Treasury 侧
 * faulted + durable quarantine 后 rethrow（调用方以异常感知，Treasury 保持
 * 保守占用）。
 */
export type TreasurySafeExecuteResult<TAction extends { ok: boolean }> =
  | {
      readonly status: "executed_committed";
      readonly handle: TreasuryPreparedHandle;
      readonly actionResult: TAction;
      readonly committedAtTick: number;
      /** 【第十八轮 24.3】commit 已完成但 lineage 终态补完成 pending（intent
       *  保留为 durable proof；beginTick 按 matching receipt 补完成）。 */
      readonly lineageFinalizationPending?: boolean;
    }
  | {
      readonly status: "executed_aborted";
      readonly handle: TreasuryPreparedHandle;
      readonly actionResult: TAction;
      /** 【第十八轮 24.3】tr1_ child 的当前代 not-executed retirement 状态
       *  （complete_rearm_ready / pending_publication / pending_cleanup；
       *  initial attempt 不携带）。【Remediation III 十一】pending 细分
       *  （authority/exact proof/lineage/journal）由 cleanup 报告表达。 */
      readonly retirement?:
        | "complete_rearm_ready"
        | "pending_publication"
        | "pending_cleanup"
        | "authority_release_pending"
        | "exact_proof_pending"
        | "lineage_finalization_pending";
      /** 【Remediation III 十一】cleanup 完成状态的三层事实报告（settlement
       *  结论 / journal 删除 read-back 后的进度 / 全局 write admission 锁）。
       *  retirement 不得谎称完全完成——pending 阶段在此显式表达。 */
      readonly cleanup?: import("@/runtime/treasury/resolutionCleanupCoordinator").TreasuryCleanupStatusReport;
      /** 【Round 22 remediation】当前 attempt 的 marker 已 discharge，但全局
       *  write admission 是否仍被其它 attempt 的 marker 锁定（两事实分离）。 */
      readonly globalWriteAdmissionStillLocked?: boolean;
      readonly detail?: string;
    }
  | {
      /** Game 非 OK 且 abort 未确认（write_admission_locked / handle 故障等）。
       *  Game 未执行成功（ok=false），但预留未释放——不得报告已正常 abort。 */
      readonly status: "executed_abort_failed";
      readonly handle: TreasuryPreparedHandle;
      readonly actionResult: TAction;
      readonly reason: TreasuryRejectionReason;
      readonly detail?: string;
    }
  | {
      /** Game callback 已成功（actionResult 保留原样）但 Treasury commit 失败
       *  或进入 write fault——Game 已执行、Treasury 未完成提交，禁止自动重试。 */
      readonly status: "executed_unsettled";
      readonly handle: TreasuryPreparedHandle;
      readonly actionResult: TAction;
      readonly transactionId: string;
      readonly digest: string;
      /** commit 失败的 reason/phase（write fault 时为 fault phase 语义）。 */
      readonly faultReason: TreasuryRejectionReason;
      readonly detail?: string;
      /** 恒 true：显式标记禁止调用者自动重试（同 id 下次调用会在 callback 前被拒）。 */
      readonly retryForbidden: true;
    }
  | { readonly status: "already_settled"; readonly transactionId: string; readonly firstRecordedAtTick: number }
  | { readonly status: "prepare_rejected"; readonly reason: TreasuryRejectionReason; readonly detail?: string };

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

/**
 * production reservation 只读投影（权威在 Memory.runtime.resourceReservations）。
 * owner 语义（第五轮）：active-unresolved / missing-owner 一律保守计入
 * committed——ownerStatus 是诊断分类，绝不代表库存可重新支配；只有
 * expired（或显式 release）才解除占用。
 */
export type TreasuryReservationOwnerStatus =
  | "active-resolved"
  | "active-unresolved"
  | "missing-owner"
  | "expired"
  | "invalid";

export interface TreasuryReservationRecord {
  readonly roomName: string;
  readonly resource: string;
  readonly holderId: string;
  readonly owner: TreasuryOwnerIdentity;
  readonly amount: number;
  readonly expiresAt: number;
  readonly expired: boolean;
  readonly ownerStatus: TreasuryReservationOwnerStatus;
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
  /**
   * projected 口径（**risk-adjusted**：observed free − 本 tick overlay 容量净
   * 变化 − quarantine/unresolved intent 正流入占用；第七轮起的语义，第八轮
   * 显式标注——receiver admission 使用该口径）。prefer 显式字段
   * riskAdjustedStorageHeadroom/riskAdjustedTerminalHeadroom（同值）。
   */
  readonly projectedStorageHeadroom: number;
  readonly projectedTerminalHeadroom: number;
  readonly projectedOvercommitted: boolean;
  /** 严格口径（observed free − 本 tick overlay 净变化；不含任何风险扣减）。 */
  readonly strictStorageHeadroom: number;
  readonly strictTerminalHeadroom: number;
  readonly strictOvercommitted: boolean;
  /** risk-adjusted 口径（= projected* 字段；额外扣除 quarantine/intent 占用）。 */
  readonly riskAdjustedStorageHeadroom: number;
  readonly riskAdjustedTerminalHeadroom: number;
  readonly riskAdjustedOvercommitted: boolean;
  /** 房间承诺视图是否完整（false 时 receiver admission 必须 fail closed）。 */
  readonly commitmentComplete: boolean;
}

export interface TreasuryCommitmentMetrics {
  readonly taskRecords: number;
  readonly pendingTaskRecords: number;
  readonly reservationRecords: number;
  readonly activeReservationRecords: number;
  readonly expiredReservationsExcluded: number;
  /** owner 无法确证失效、保守计入 committed 的活跃预留数（诊断）。 */
  readonly missingOwnerStillCommitted: number;
  /** owner 已解析存在的活跃预留数。 */
  readonly typedOwnerResolved: number;
  /** legacy-unresolved kind 的活跃预留数。 */
  readonly legacyUnresolvedOwners: number;
  readonly invalidCommitmentRecords: number;
  readonly incompleteCommitmentScopes: number;
  readonly globallyIncomplete: boolean;
  readonly indexQueries: number;
}

/**
 * 承诺统一索引：构建期一次性聚合为 primitive 快照（不保留 task/reservation
 * 对象引用），构建后同一 revision 下所有查询结果一致。权威数据变更由
 * mutation 侧 bumpTreasuryCommitmentRevision 通知 facade 失效重建。
 */
/**
 * 承诺视图 completeness（第五轮）：损坏记录只污染可定位的 (room,resource)
 * bucket（incomplete-scope）或全局（globally-incomplete）。授权者不得只看
 * spendable 数字而忽略 completeness——incomplete scope 的 spendable 必须
 * 为 0、authorizationSafe 必须为 false。
 */
export type TreasuryCommitmentCompleteness = "complete" | "incomplete-scope" | "globally-incomplete";

export interface TreasuryCommitmentCompletenessSnapshot {
  /** 无任何损坏记录。 */
  readonly complete: boolean;
  readonly globalIncomplete: boolean;
  readonly incompleteScopeCount: number;
  readonly invalidRecords: number;
}

export interface TreasuryCommitmentIndex {
  readonly builtAtTick: number;
  readonly revision: number;
  readonly completeness: TreasuryCommitmentCompletenessSnapshot;
  /** 指定 (room,resource) 的 completeness（global incomplete 优先）。 */
  commitmentCompleteness(roomName: string, resource: string): TreasuryCommitmentCompleteness;
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
  /**
   * 活跃生产预留合计（含 owner 无法确证失效的保守全额扣除）。
   * excludeOwner 为完整 typed identity 比较：同 kind + id + namespace 才排除
   * （同字符串不同 kind / legacy-unresolved 不互相排除）。
   */
  reservedProduction(roomName: string, resource: string, excludeOwner?: TreasuryOwnerIdentity): number;
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

/**
 * owner 声明（typed identity）：调用方以固定身份持有 production reservation
 * 时声明自身完整 typed identity，让查询排除自己已占用的部分。
 * ownerKind 只接受可运行时验证的 kind（game-object / logical-service）；
 * legacy-unresolved 不允许普通调用者冒充排除；task / contract 暂无运行时
 * 存在性权威，同样拒绝（fail closed）。同字符串不同 kind 不得互相排除。
 */
export interface TreasuryQueryOwner {
  /** 声明的 owner 身份类型（与运行时解析一致，否则 fail closed）。 */
  readonly ownerKind: "game-object" | "logical-service";
  /** 稳定身份串（game-object id / 逻辑服务名）。 */
  readonly ownerId: string;
  /** 逻辑服务 namespace（logical-service 时必填且与解析一致）。 */
  readonly namespace?: string;
  readonly scope: TreasuryOwnerScope;
  /** 声明的归属房间（必须与运行时解析结果一致，否则 fail closed）。 */
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
  /** 承诺视图 completeness（incomplete scope 的授权不得显示 authorization-safe）。 */
  readonly commitmentStatus: TreasuryCommitmentCompleteness;
  /** 授权安全 = 上下文/owner 合法 + 承诺视图完整 + 无任何全局阻断（第六轮联合判定）。 */
  readonly authorizationSafe: boolean;
  /**
   * authorizationSafe 的主要阻断原因（有界诊断；空数组 = 无阻断）：
   * write_fault / quarantine_unresolved / receipt_unhealthy /
   * commitment_incomplete / lifecycle_closed / reservation_migration_incomplete /
   * invalid_context。数值字段保留供观察——阻断时不得以归零掩盖原因。
   */
  readonly authorizationBlockers: readonly string[];
  /**
   * write admission readiness（第七轮，与余额完整分立）：当前是否确实允许
   * 开始新的 Game write——独立于 authorizationSafe（承诺视图完整但 receipt
   * 满/quarantine slot 耗尽/schema 未激活时余额可信而写入未就绪）。
   * blockers 有界诊断；ready=false 不影响数值字段；prepare 对各条件独立
   * 复查，绝不只信调用方读过 readiness。
   */
  readonly writeAdmission: {
    readonly ready: boolean;
    readonly blockers: readonly string[];
  };
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
  /** owner 无法确证失效但保守计入 committed 的预留数（诊断，非可支配）。 */
  missingOwnerStillCommitted: number;
  /** owner 已解析存在的预留数。 */
  typedOwnerResolvedCount: number;
  /** legacy-unresolved kind 的活跃预留数。 */
  legacyUnresolvedOwnerCount: number;
  /** 记录级验证失败的 commitment 记录数（不进聚合、不删原数据）。 */
  invalidCommitmentRecords: number;
  /** incomplete 的 (room,resource) scope 数（含全局污染时为全部口径）。 */
  incompleteCommitmentScopes: number;
  /** 是否存在无法定位 scope 的损坏记录（全局 incomplete）。 */
  commitmentGloballyIncomplete: boolean;
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
  /** 相同 transactionId、不同 canonical payload 的 prepare 冲突次数。 */
  prepareConflicts: number;
  /** 当前活跃（未终态）prepared handle 数（gauge）。 */
  preparedActive: number;
  /** tentative 资源预留 key 数（gauge；不进入 public projected）。 */
  tentativeResourceKeys: number;
  /** tentative 容量预留 key 数（gauge）。 */
  tentativeCapacityKeys: number;
  /** prepared handle 成功 commit（tentative→committed）次数。 */
  preparedCommits: number;
  /** 非法 handle（伪造/跨 generation/JSON 副本）提交尝试被拒次数。 */
  invalidHandleRejections: number;
  /** canonical payload digest 生成次数（prepare 与冲突判定）。 */
  digestGenerations: number;
  /** tick 边界仍 outstanding（prepared 未终态）的 handle 数（累计）。 */
  preparedOutstandingAtEnd: number;
  /** tick 边界处于 executing（Game API 结果未知）的 handle 数——严重故障信号。 */
  preparedExecutingAtEnd: number;
  /** tick 边界转入 durable quarantine 的 handle 数（executing + faulted；累计）。 */
  preparedQuarantinedAtBoundary: number;
  /** action callback 抛错进入 execution unknown 的次数（第七轮：默认隔离不 abort）。 */
  executionUnknownQuarantines: number;
  /** staged commit 意外写故障次数（每次记录 write-fault marker）。 */
  commitFaults: number;
  /** write admission 全局锁状态（1 = unresolved write fault 锁定中；gauge）。 */
  writeAdmissionLocked: number;
  /** 持久 quarantine 条目数（validated store entryCount；gauge，O(1)）。 */
  quarantineEntries: number;
  /** quarantine fault-slot 预留数 = active handle 数（gauge；含 prepared/executing/committing/faulted）。 */
  quarantineSlotsReserved: number;
  /** quarantine 剩余可预留 slot 数（MAX − entryCount − active；gauge，O(1)）。 */
  quarantineSlotsRemaining: number;
  /** quarantine store 健康状态（gauge；false = fail closed）。 */
  quarantineStoreHealthy: boolean;
  /** prepare 被 quarantine 全局 blocker/slot admission 拒绝的次数（含防御分支）。 */
  quarantineAdmissionRejections: number;
  /** 【IX 工作流 D】completion headroom reservation 结构化 release/consume 的失败计数（H3——结果不谎报已释放）。 */
  reservationReleaseFailures: number;
  /** 当前 unresolved quarantine 条目数（gauge；含 legacy overflowed 语义上的阻断）。 */
  unresolvedQuarantines: number;
  /** resolution committed / not-executed / uncertain / rejected 次数（faultResolution heap 计数聚合）。 */
  resolutionCommitted: number;
  resolutionNotExecuted: number;
  resolutionUncertain: number;
  resolutionRejected: number;
  /** receipt 全部扫描上下文访问的条目总数。 */
  receiptEntriesVisited: number;
  /** 迁移扫描次数（源遍历 + 迁移自检）。 */
  receiptMigrationScans: number;
  /** load 校验（v3 形状自检）访问的条目数。 */
  receiptLoadValidationEntries: number;
  /** 到期清理访问的条目数（清理与 nextExpiry 重算单次遍历）。 */
  receiptExpiryCleanupEntries: number;
  /** fatal-store 巡检访问的条目数。 */
  receiptFatalInspectionEntries: number;
  /** 非法查询上下文（非法资源/重复房间/重复位置/NaN withhold 等）fail-closed 次数。 */
  queryInvalidContexts: number;
  /** reservation schema activation 失败次数（migration 失败/未知版本/corrupted；累计）。 */
  reservationSchemaActivationFailures: number;
  /** reservation mutation 结构化拒绝次数（非法输入/schema 未激活/corrupted；累计）。 */
  reservationMutationRejections: number;
  /** ── 第八轮：durable intent / authorization / contract / staged resolution ── */
  /** 当前未完成 durable intent 条数（gauge，O(1)）。 */
  durableIntents: number;
  /** recovery slot 剩余可预留数（quarantine + intent + 无 intent 的 active handle 统一口径；gauge）。 */
  intentSlotsRemaining: number;
  /** beginTick 恢复中确认未执行（ready 相）而释放的 intent 数（累计）。 */
  intentRecoveries: number;
  /** 恢复/故障路径 intent 成功转 quarantine 的次数（累计；slot 守恒转换）。 */
  intentQuarantineConversions: number;
  /** intent store 健康状态（gauge；false = fail closed）。 */
  intentStoreHealthy: boolean;
  /** intent 写入失败（store fatal/容量满——callback 零调用路径）次数（累计）。 */
  intentWriteFailures: number;
  /** 授权签发次数（累计）。 */
  authorizationIssued: number;
  /** 授权拒绝次数（累计）。 */
  authorizationRejected: number;
  /** 授权 token 失效（revision 变化/跨 tick/重复消费等）次数（累计）。 */
  authorizationInvalidated: number;
  /** 当前有效（已签发未消费）授权数（gauge）。 */
  authorizationsActive: number;
  /** action contract 构建次数（累计）。 */
  actionContractsBuilt: number;
  /** adapter kind 不匹配拒绝次数（累计）。 */
  actionAdapterMismatches: number;
  /** 授权 revision 不匹配失效次数（累计）。 */
  authorizationRevisionMismatches: number;
  /** staged resolution 进行中条数（resolving tombstone；gauge）。 */
  resolutionInProgress: number;
  /** staged resolution 阶段故障次数（累计；可恢复）。 */
  resolutionFaulted: number;
  /** staged resolution 恢复完成次数（global reset 后幂等恢复；累计）。 */
  resolutionRecovered: number;
  /** 【第十四轮】staged recovery identity conflict 阻断次数（累计；conflict 与 insufficient 独立计数）。 */
  resolutionIdentityConflicts: number;
  /** 【第十四轮】staged recovery identity 不足（legacy/insufficient proof）阻断次数（累计）。 */
  resolutionIdentityInsufficient: number;
  /** resolve-as-committed 刷新既有 receipt 的次数（累计）。 */
  receiptRefreshes: number;
  /** reconciliation capability 签发次数（累计）。 */
  reconciliationCapabilitiesIssued: number;
  /** reconciliation capability 拒绝次数（未注册 reconciler/伪造等；累计）。 */
  reconciliationCapabilitiesRejected: number;
  /** reservation store 完整健康状态（version=4 ≠ healthy；gauge）。 */
  reservationStoreHealthy: boolean;
  /** risk-adjusted 容量口径查询次数（累计）。 */
  riskAdjustedCapacityLookups: number;
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
    missingOwnerStillCommitted: 0,
    typedOwnerResolvedCount: 0,
    legacyUnresolvedOwnerCount: 0,
    invalidCommitmentRecords: 0,
    incompleteCommitmentScopes: 0,
    commitmentGloballyIncomplete: false,
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
    prepareConflicts: 0,
    preparedActive: 0,
    tentativeResourceKeys: 0,
    tentativeCapacityKeys: 0,
    preparedCommits: 0,
    invalidHandleRejections: 0,
    digestGenerations: 0,
    preparedOutstandingAtEnd: 0,
    preparedExecutingAtEnd: 0,
    preparedQuarantinedAtBoundary: 0,
    executionUnknownQuarantines: 0,
    commitFaults: 0,
    writeAdmissionLocked: 0,
    quarantineEntries: 0,
    quarantineSlotsReserved: 0,
    quarantineSlotsRemaining: 0,
    quarantineStoreHealthy: false,
    quarantineAdmissionRejections: 0,
    reservationReleaseFailures: 0,
    unresolvedQuarantines: 0,
    resolutionCommitted: 0,
    resolutionNotExecuted: 0,
    resolutionUncertain: 0,
    resolutionRejected: 0,
    receiptEntriesVisited: 0,
    receiptMigrationScans: 0,
    receiptLoadValidationEntries: 0,
    receiptExpiryCleanupEntries: 0,
    receiptFatalInspectionEntries: 0,
    queryInvalidContexts: 0,
    reservationSchemaActivationFailures: 0,
    reservationMutationRejections: 0,
    durableIntents: 0,
    intentSlotsRemaining: 0,
    intentRecoveries: 0,
    intentQuarantineConversions: 0,
    intentStoreHealthy: false,
    intentWriteFailures: 0,
    authorizationIssued: 0,
    authorizationRejected: 0,
    authorizationInvalidated: 0,
    authorizationsActive: 0,
    actionContractsBuilt: 0,
    actionAdapterMismatches: 0,
    authorizationRevisionMismatches: 0,
    resolutionInProgress: 0,
    resolutionFaulted: 0,
    resolutionRecovered: 0,
    resolutionIdentityConflicts: 0,
    resolutionIdentityInsufficient: 0,
    receiptRefreshes: 0,
    reconciliationCapabilitiesIssued: 0,
    reconciliationCapabilitiesRejected: 0,
    reservationStoreHealthy: false,
    riskAdjustedCapacityLookups: 0,
    reconciliationInflowMismatches: 0,
    reconciliationOutflowMismatches: 0,
    reconciliationStructuralChanges: 0,
    reconciliationChecks: 0,
  };
}

// ── 完整 structure binding descriptor（第十一轮 3.13.9 / AC4） ───────────────

/** descriptor 版本（字段集演进时递增——旧 descriptor 数据按版本解释）。 */
export const TREASURY_STRUCTURE_DESCRIPTOR_VERSION = 1;

/** binding kind（受控枚举）：governed location 或 explicit game object。 */
export type TreasuryStructureBindingKind = "governed_location" | "game_object";

/** action-specific role（受控枚举；同结构不同 role 不得静默合并）。 */
export type TreasuryStructureBindingRole = "source" | "target" | "fee_source" | "production_structure" | "auxiliary";

export const TREASURY_STRUCTURE_BINDING_KINDS: ReadonlySet<string> = new Set<string>([
  "governed_location",
  "game_object",
]);

export const TREASURY_STRUCTURE_BINDING_ROLES: ReadonlySet<string> = new Set<string>([
  "source",
  "target",
  "fee_source",
  "production_structure",
  "auxiliary",
]);

/**
 * 完整 canonical structure descriptor（durable fact 形态）：进入 contract
 * digest（AC4）、intent/quarantine 与 durable authority identity。posting
 * 自动 binding 的 role 由 Treasury 派生（负腿 source、正腿 target）；
 * structureId 为 incarnation（governed location = structure 实例 id、
 * game object = 对象 id 本身）。
 */
export interface TreasuryStructureBindingDescriptor {
  readonly bindingKind: TreasuryStructureBindingKind;
  readonly role: TreasuryStructureBindingRole;
  readonly roomName: string;
  readonly locationKind: string;
  /** incarnation id（governed = structure 实例；game_object = 对象 id）。 */
  readonly structureId: string;
  /** game object binding 的对象 id（bindingKind=game_object 时存在）。 */
  readonly objectId?: string;
  readonly expectedType?: string;
  readonly expectedRoom?: string;
  /** required descriptor 的结构缺失 → 构建拒绝 / 执行前重验（默认 true）。 */
  readonly required: boolean;
  /** descriptor 版本（当前恒 1）。 */
  readonly version: number;
}
