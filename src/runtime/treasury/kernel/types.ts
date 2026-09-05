/**
 * Treasury Core Kernel——领域类型与集中常量（Core Rewrite I）。
 *
 * 语义基线：openspec/changes/empire-treasury-core-rewrite/design.md。
 * 一项未完成工作始终由一个有界活跃聚合（active work record）负责；
 * 只有该聚合内当前 attempt 的正向许可可以进入动作调用；历史明细（ring）
 * 不授予任何权限；所有安全依赖关闭后工作可以真正退出活跃集合。
 */

/** 持久 schema 版本。未知版本 fail closed（报告 incompatible，阻断写入）。 */
export const TREASURY_CORE_SCHEMA_VERSION = 1;

/**
 * 活跃聚合上限。接纳时按完整生命周期最坏体积预留（一个聚合覆盖
 * pending→dispatching→unknown→closing→retry_ready 全阶段，不再为安全完成
 * 向第二家 store 临时申请槽位）。初始评估沿用旧 64 活跃槽量级（design §4）。
 */
export const TREASURY_CORE_ACTIVE_LIMIT = 64;

/** 近期明细环容量（退役聚合的可选紧凑记录；不参与授权）。 */
export const TREASURY_CORE_RING_LIMIT = 128;

/** retry 权利期限（tick）。过期关闭的是 retry 权利，不是未解决资产风险。 */
export const TREASURY_CORE_RETRY_RIGHT_TICKS = 5_000;

/** 每 tick 清理/恢复公平推进预算（已有待完成工作在满载时仍能获得处理）。 */
export const TREASURY_CORE_RECOVERY_BUDGET_PER_TICK = 8;

/** 错误摘要长度上限（有界字符串）。 */
export const TREASURY_CORE_ERROR_DETAIL_MAX = 192;

/** durable facts payload 上限（与旧 adapter 契约一致量级）。 */
export const TREASURY_CORE_DURABLE_PAYLOAD_MAX = 512;

/** 每聚合最坏占用腿数上限（posting 派生，防数组无界）。 */
export const TREASURY_CORE_WORST_CASE_LEGS_MAX = 16;

/** workKey 长度上限。 */
export const TREASURY_CORE_WORK_KEY_MAX = 128;

/** attempt ID 前缀（新命名空间；不复用 ti1_/ti2_/tr1_ 旧格式解释新含义）。 */
export const TREASURY_CORE_ATTEMPT_ID_PREFIX = "tk1_";

/** workKey 命名空间前缀（受控：调用方命名空间 + 业务键）。 */
export const TREASURY_CORE_WORK_KEY_PREFIX = "biz:";

/**
 * 语义阶段（design §5.1）。closed 不落盘：closed 即从活跃集合移除
 *（可选写 ring）。
 *
 * - pending：已登记、确定未开始。仅经完整当前授权与受控调度可推进。
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

/** 结算证据种类（世界效果确认只能来自受控证据通道）。 */
export type TreasuryCoreSettlementEvidenceKind =
  /** adapter 在 execute 时刻的显式声明语义（settlesOnAccept / nonOkOutcome）。 */
  | "adapter_execution_semantics"
  /** 事后 adapter reconcile（reconciler 语义身份须与聚合一致）。 */
  | "adapter_reconcile"
  /** 外部对账事实（受控驱动/协作者通道；本轮真实 driver 禁用）。 */
  | "external_settlement_receipt";

export interface TreasuryCoreSettlementEvidence {
  readonly kind: TreasuryCoreSettlementEvidenceKind;
  /** adapter reconcile 的结论（executed / not_executed / still_uncertain）。 */
  readonly conclusion: "executed" | "not_executed" | "still_uncertain";
  /** 证据来源摘要（受控：adapter semantic identity 或驱动标识），≤64 字符。 */
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

/** 接纳时锁定的最坏资源占用事实（未知结果期间保持全额占用）。 */
export interface TreasuryCoreWorstCaseLeg {
  readonly roomName: string;
  readonly locationKind: string;
  readonly resource: string;
  /** 该位置该资源的最大流出量（正数）。 */
  readonly outflow: number;
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
 * 接纳方声明、内核原样保留）。全部经释放端口幂等确认后聚合才可退出或
 * 进入 retry_ready。资源占用本身不是 duty——占用由活跃集合成员资格表达，
 * 移除即释放，不存在“改一个 done 标签提前释放”的路径。
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

/** 近期明细环条目（紧凑；不参与授权，满了覆盖最旧）。 */
export interface TreasuryCoreRingEntry {
  readonly attemptId: string;
  readonly workKey: string;
  readonly generation: number;
  readonly terminalPhase: "committed" | "not_executed" | "retry_expired" | "abandoned";
  readonly closedAtTick: number;
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

/** store 健康状态（三态：缺失 ≠ 损坏 ≠ 健康——A05/R2 的核心区分）。 */
export type TreasuryCoreStoreHealth =
  | { readonly status: "absent" }
  | { readonly status: "healthy"; readonly memory: TreasuryCoreMemory }
  | {
      readonly status: "unhealthy";
      readonly reason: string;
      /** 损坏数据原样保留，不自动清库。 */
    }
  | {
      readonly status: "incompatible";
      readonly reason: string;
    };

/** 正向执行许可的私有品牌（外部不可构造带此品牌的对象）。 */
declare const treasuryCorePermitBrand: unique symbol;
/** retry 许可的私有品牌。 */
declare const treasuryCoreRearmBrand: unique symbol;

/** 正向执行许可（heap-only opaque 对象；跨 tick / runtime generation 失效）。 */
export interface TreasuryCoreDispatchPermit {
  readonly [treasuryCorePermitBrand]: true;
  readonly attemptId: string;
  readonly canonicalDigest: string;
  /** 当次调用的 canonical frozen args（heap 引用；不持久化）。 */
  readonly canonicalArgs: unknown;
  readonly actionKind: string;
  readonly adapterRegistrationId: string;
  readonly adapterSemanticIdentity: string;
  readonly issuedAtTick: number;
  readonly runtimeGeneration: number;
}

/** retry 许可（heap-only opaque；绑定前代与 retry 语义事实）。 */
export interface TreasuryCoreRearmPermit {
  readonly [treasuryCoreRearmBrand]: true;
  readonly parentAttemptId: string;
  readonly workKey: string;
  readonly retryFactsDigest: string | null;
  readonly issuedAtTick: number;
  readonly runtimeGeneration: number;
}
