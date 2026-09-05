/**
 * Treasury Core Kernel——领域类型与集中常量（Core Rewrite II）。
 *
 * 语义基线：openspec/changes/empire-treasury-core-rewrite/design.md（II 修订）。
 * 一项未完成工作始终由一个有界活跃聚合（active work record）负责；
 * 只有该聚合内当前 attempt 的正向许可可以进入动作调用；历史明细（ring）
 * 不授予任何权限；所有安全依赖关闭后工作可以真正退出活跃集合。
 *
 * v2 变更（Core Rewrite II）：
 * - 结算证据通道收口：删除 external_settlement_receipt（自报结论路径
 *   关闭）；新增 pending_cancellation（安全取消的未开始证据）。
 * - recovery 调度区（持久）：清理/取消公平游标与 per-tick 操作预算记账
 *  （调度元信息，不是完成 proof；失效可安全重建）。
 * - 占用投影规则收紧：closing 不再占用（committed 效果由本 tick overlay
 *   与后续观察表达——同一责任唯一扣减归属）。
 * - 字段完整性上限：consumerKeys 数量、未知字段拒绝、计数器饱和。
 */

/** 持久 schema 版本。未知版本 fail closed（报告 incompatible，阻断写入）。 */
export const TREASURY_CORE_SCHEMA_VERSION = 2;

/**
 * 活跃聚合上限。接纳时按完整生命周期最坏体积预留（一个聚合覆盖
 * pending→dispatching→unknown→closing→retry_ready 全阶段，不再为安全完成
 * 向第二家 store 临时申请槽位）。初始评估沿用旧 64 活跃槽量级（design §4）。
 */
export const TREASURY_CORE_ACTIVE_LIMIT = 64;

/** 近期明细环容量（退役聚合的可选紧凑记录；不参与授权，非权威）。 */
export const TREASURY_CORE_RING_LIMIT = 128;

/** retry 权利期限（tick）。过期关闭的是 retry 权利，不是未解决资产风险。 */
export const TREASURY_CORE_RETRY_RIGHT_TICKS = 5_000;

/**
 * 每 tick 恢复/清理操作预算（状态推进与外部释放调用共享；同 tick 多次
 * beginTick / 多实例经持久记账共享同一份额——B17）。
 */
export const TREASURY_CORE_RECOVERY_BUDGET_PER_TICK = 8;

/** 错误摘要长度上限（有界字符串；纯诊断文本允许截断）。 */
export const TREASURY_CORE_ERROR_DETAIL_MAX = 192;

/** durable facts payload 上限（与旧 adapter 契约一致量级）。 */
export const TREASURY_CORE_DURABLE_PAYLOAD_MAX = 512;

/** 每聚合最坏占用腿数上限（posting 派生，防数组无界）。 */
export const TREASURY_CORE_WORST_CASE_LEGS_MAX = 16;

/** workKey 长度上限。 */
export const TREASURY_CORE_WORK_KEY_MAX = 128;

/** 单个外部消费者 key 长度上限。 */
export const TREASURY_CORE_CONSUMER_KEY_MAX = 128;

/**
 * 每聚合外部消费者数量上限（R09：超限安全输入整体拒绝，不截断一半义务）。
 */
export const TREASURY_CORE_CONSUMER_KEYS_MAX = 8;

/**
 * treasuryCore 总序列化预算（字符数 = JSON.stringify 长度；受控 ASCII 布局
 * 下与 UTF-8 bytes 一致）。推导（evidence/core-rewrite-ii）：最坏单记录
 * 4,776 + ring 条目 262 + 根骨架 550，64 active + 128 ring 满载合计
 * 339,813；常量取 360,000（≈6% 余量）。接纳前校验：当前序列化体积 +
 * 新聚合最坏体积 + ring 余量超预算即拒绝（新工作阻断，已接纳工作收尾
 * 不受影响）。
 */
export const TREASURY_CORE_TOTAL_CHAR_BUDGET = 360_000;

/** 诊断计数器饱和上限（溢出不回绕、不拖垮安全核心）。 */
export const TREASURY_CORE_COUNTER_SATURATION = 9_999_999_999;

/** 结算证据 source 字段上限。 */
export const TREASURY_CORE_EVIDENCE_SOURCE_MAX = 64;

/** attempt ID 前缀（新命名空间；不复用 ti1_/ti2_/tr1_ 旧格式解释新含义）。 */
export const TREASURY_CORE_ATTEMPT_ID_PREFIX = "tk1_";

/** workKey 命名空间前缀（受控：调用方命名空间 + 业务键）。 */
export const TREASURY_CORE_WORK_KEY_PREFIX = "biz:";

/**
 * 语义阶段（design §5.1）。closed 不落盘：closed 即从活跃集合移除
 *（可选写 ring）。
 *
 * - pending：已登记、确定未开始。仅经完整当前授权与受控调度可推进；
 *   跨 tick 失效后可安全取消（cancel_pending）。
 * - dispatching：当前调用边界已获得许可/可能已进入。只能由当次受控调用者
 *   推进；恢复不得再发一次。
 * - outcome_unknown：结果仍未知。不允许再次调用，也不允许直接 rearm。
 * - closing：结果确定、清理未完成。不允许再次调用。
 * - retry_ready：not-executed 且清理完成、允许受控 retry。
 */
export type TreasuryCorePhase =
  | "pending"
  | "dispatching"
  | "outcome_unknown"
  | "closing"
  | "retry_ready";

/** 聚合的结果判定。 */
export type TreasuryCoreOutcome = "unknown" | "committed" | "not_executed";

/**
 * 结算证据种类（Core Rewrite II 收口）：
 * - adapter_execution_semantics：execute 时刻的显式声明语义。
 * - adapter_reconcile：事后内核受控编排调用注册 reconciler 得出。
 * - pending_cancellation：安全取消的“确定未开始”证据（invocation/external
 *   为空 + pending 阶段的正面确认）。
 * external_settlement_receipt 已删除：不存在调用者自报结论的生产通道。
 */
export type TreasuryCoreSettlementEvidenceKind =
  | "adapter_execution_semantics"
  | "adapter_reconcile"
  | "pending_cancellation";

export interface TreasuryCoreSettlementEvidence {
  readonly kind: TreasuryCoreSettlementEvidenceKind;
  /** 证据结论（executed / not_executed / still_uncertain）。 */
  readonly conclusion: "executed" | "not_executed" | "still_uncertain";
  /** 证据来源摘要（受控：adapter semantic identity 或 kernel 标识），≤64 字符。 */
  readonly source: string;
  readonly atTick: number;
}

/** 聚合的完整身份事实（正常调用、恢复、对账、retry、清理都校验同一份）。 */
export interface TreasuryCoreIdentityFacts {
  readonly actionKind: string;
  readonly adapterVersion: number;
  readonly adapterRegistrationId: string;
  readonly adapterSemanticIdentity: string;
  /** canonical args 的确定性摘要（canonicalTransaction payload digest）。 */
  readonly canonicalDigest: string;
  /** 派生 postings 的确定性摘要。 */
  readonly postingsDigest: string;
  /** adapter retry facts 摘要（未提供 → null，not-executed 后 non-rearmable）。 */
  readonly retryFactsDigest: string | null;
  readonly durableFacts: { readonly version: number; readonly payload: string } | null;
}

/**
 * 接纳时锁定的 canonical posting 腿（带符号 delta）。同一资源键的流出与
 * 流入不互相抵消（§5.2）：流出合计与流入合计分别成腿（worstCase 中同一
 * 键可能同时存在一负一正两条腿）。占用投影：流出 = Σmax(0, −delta)、
 * 流入 = Σmax(0, +delta)；reconciler 收到方向合计全集。
 */
export interface TreasuryCoreWorstCaseLeg {
  readonly roomName: string;
  readonly locationKind: string;
  readonly resource: string;
  /** 带符号净变化（流出为负）。 */
  readonly delta: number;
}

/** 三种事实：动作调用发生 / 外部接口接受 / 世界效果确认（outcome 字段）。 */
export interface TreasuryCoreInvocationFact {
  readonly atTick: number;
}

export interface TreasuryCoreExternalFact {
  readonly accepted: boolean;
  readonly atTick: number;
}

/**
 * 清理义务：受控外部消费者 key 列表（形如 `ext:<namespace>:<key>`，由
 * 接纳方声明、内核原样保留；数量 ≤ TREASURY_CORE_CONSUMER_KEYS_MAX）。
 * 全部经释放端口幂等确认后聚合才可退出或进入 retry_ready。资源占用本身
 * 不是 duty——占用由活跃集合成员资格表达，移除即释放。
 */
export interface TreasuryCoreCleanupState {
  readonly consumerKeys: readonly string[];
  /** 连续清理失败计数（诊断；不无限累积故障记录）。 */
  failures: number;
}

export interface TreasuryCoreWorkRecord {
  readonly workKey: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly parentAttemptId: string | null;
  readonly phase: TreasuryCorePhase;
  readonly admittedAtTick: number;
  readonly updatedAtTick: number;
  readonly identity: TreasuryCoreIdentityFacts;
  readonly worstCase: readonly TreasuryCoreWorstCaseLeg[];
  readonly invocation: TreasuryCoreInvocationFact | null;
  readonly external: TreasuryCoreExternalFact | null;
  readonly outcome: TreasuryCoreOutcome;
  readonly outcomeEvidence: TreasuryCoreSettlementEvidence | null;
  readonly cleanup: TreasuryCoreCleanupState;
  readonly retryDeadlineTick: number | null;
  readonly lastError: string | null;
}

/** 近期明细环条目（紧凑；不参与授权，满了覆盖最旧；非权威历史）。 */
export interface TreasuryCoreRingEntry {
  readonly attemptId: string;
  readonly workKey: string;
  readonly generation: number;
  readonly terminalPhase: "committed" | "not_executed" | "retry_expired" | "abandoned";
  readonly closedAtTick: number;
}

/**
 * 恢复/清理调度元信息（持久；游标失效可安全重建，不是完成 proof）：
 * - sweepCursor：pending sweep 的轮转起点（活跃集合排序索引偏移）。
 * - cleanupCursor：closing 清理的轮转起点。
 * - budgetTick/budgetUsed：per-tick 操作预算记账（同 tick 共享——B17）。
 */
export interface TreasuryCoreRecoveryState {
  sweepCursor: number;
  cleanupCursor: number;
  budgetTick: number;
  budgetUsed: number;
}

/** 持久布局根（Memory.runtime.treasuryCore）。 */
export interface TreasuryCoreMemory {
  version: number;
  /** 安装元信息：内核首次显式初始化时铸造的安装标识（16hex）。 */
  installEpochId: string;
  issuance: {
    /** 单调发行 frontier：已分配的最大序号。只前进，不回退。 */
    frontier: number;
    /** 分配失败烧掉的序号计数（洞不需要逐洞记录）。 */
    burned: number;
  };
  lifecycle: {
    lastBeginTick: number | null;
    lastEndTick: number | null;
  };
  recovery: TreasuryCoreRecoveryState;
  /** 活跃聚合（键 = attemptId）。 */
  active: Record<string, TreasuryCoreWorkRecord>;
  ring: TreasuryCoreRingEntry[];
  ringCursor: number;
  counters: {
    admitted: number;
    dispatched: number;
    settledCommitted: number;
    settledNotExecuted: number;
    unknown: number;
    rearmings: number;
    rejectedAdmissions: number;
    recoveryAdvances: number;
    cleanupFailures: number;
  };
}

/**
 * store 健康状态（内部读取口径：四态 + ring 非权威层独立诊断）。
 * ring 层问题（超限/损坏/重复/与 active 重叠）不折叠进安全四态——
 * 安全权威（安装/发行/active/counters/recovery）健康即 healthy，
 * ringDegraded 附带有界诊断（B20：历史故障隔离）。
 */
export type TreasuryCoreStoreHealth =
  | { readonly status: "absent" }
  | { readonly status: "healthy"; readonly memory: TreasuryCoreMemory; readonly ringDegraded: string | null }
  | {
      readonly status: "unhealthy";
      readonly reason: string;
      /** 损坏数据原样保留，不自动清库。 */
    }
  | {
      readonly status: "incompatible";
      readonly reason: string;
    };

/** 对外健康摘要（不含 memory 引用——查询视图不泄漏权威，R06）。 */
export interface TreasuryCorePublicHealth {
  readonly status: "absent" | "healthy" | "unhealthy" | "incompatible";
  readonly reason: string | null;
  readonly ringDegraded: string | null;
}

/** 正向执行许可的私有品牌（外部不可构造带此品牌的对象）。 */
declare const treasuryCorePermitBrand: unique symbol;
/** retry 许可的私有品牌。 */
declare const treasuryCoreRearmBrand: unique symbol;

/** 派生 posting 腿的 heap 快照形状（许可内冻结；执行/结算共用同一签发）。 */
export interface TreasuryCorePermitPosting {
  readonly roomName: string;
  readonly locationKind: string;
  readonly resource: string;
  readonly delta: number;
}

/**
 * 正向执行许可（heap-only opaque 对象；跨 tick / runtime generation 失效）。
 * Core Rewrite II：签发快照整体深冻结（嵌套 args/postings 不可替换——R01）；
 * 实际执行参数与 overlay 结算都来自该冻结签发，不从公开可变字段重新派生。
 */
export interface TreasuryCoreDispatchPermit {
  readonly [treasuryCorePermitBrand]: true;
  readonly attemptId: string;
  readonly canonicalDigest: string;
  /** 当次调用的 canonical frozen args（深冻结 heap 快照；不持久化）。 */
  readonly canonicalArgs: unknown;
  /** 签发时的原始 posting 腿快照（深冻结；overlay 修正用同一份）。 */
  readonly postings: readonly TreasuryCorePermitPosting[];
  readonly actionKind: string;
  readonly adapterRegistrationId: string;
  readonly adapterSemanticIdentity: string;
  readonly issuedAtTick: number;
  readonly runtimeGeneration: number;
}

/** retry 许可（heap-only opaque；绑定前代与 retry 语义事实；深冻结）。 */
export interface TreasuryCoreRearmPermit {
  readonly [treasuryCoreRearmBrand]: true;
  readonly parentAttemptId: string;
  readonly workKey: string;
  readonly retryFactsDigest: string | null;
  readonly issuedAtTick: number;
  readonly runtimeGeneration: number;
}
