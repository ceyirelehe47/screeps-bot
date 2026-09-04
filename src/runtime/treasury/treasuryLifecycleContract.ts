/**
 * 【Round 22 Remediation IX 工作流 B / 5.1】Treasury 持久 store 的机器可
 * 检查 lifecycle inventory。
 *
 * 系统级不变量：No persistent store without a lifecycle contract.——任何
 * 写入 Screeps Memory 的时效性数据必须同时明确：保护什么事实、何时进入
 * terminal、哪个唯一状态机拥有清理权、删除前需要什么 replacement、硬容量
 * 与 CPU 操作上限、满载行为（回收/压缩/覆盖/fail closed）、global reset
 * 恢复、store unhealthy 阻断方式、数据分类（安全权威/缓存/索引/审计/遥测）
 * 与是否允许按年龄淘汰。
 *
 * 本模块是登记表（纯静态数据 + 查询函数）：
 * - 架构测试（treasuryMemoryLifecycleContract.test.ts）对照源码扫描结果
 *   验证完备性（新 store 未登记 → 失败）；
 * - GC coordinator（treasuryLifecycleGcCoordinator.ts）消费本表驱动有界
 *   回收；
 * - classification 语义：
 *   - active-unresolved：不允许因旧/满载/FIFO 删除，只能经 reconcile/
 *     resolve/cleanup 进入 terminal；满载阻断新 writer；"不在该 store"不是
 *     终结证明；
 *   - recent-exact-detail：固定容量 queue/ring，淘汰最旧 terminal detail
 *     前必须证明 permanent anti-reuse 已接管；淘汰后旧 ID 返回
 *     retired/protocol 而非 absent/new；
 *   - permanent-anti-reuse：只保存阻止旧 ID 复用所需的紧凑事实（versioned
 *     issuer epoch / monotonic frontier / bounded active gaps），不随
 *     attempt/chain 数线性增长；
 *   - telemetry-audit：固定环形/聚合计数，允许覆盖最旧明细，不参与安全判定；
 *   - derived-index：非独立权威，reset 后可重建，损坏时重建或 fail closed；
 *   - legacy-forensic：不自动猜测/删除/升级，可显式 pin，容量压力显式诊断。
 */

export type TreasuryStoreClassification =
  | "active-unresolved"
  | "recent-exact-detail"
  | "permanent-anti-reuse"
  | "telemetry-audit"
  | "derived-index"
  | "legacy-forensic";

export interface TreasuryStoreLifecycleContract {
  /** Memory.runtime.treasury 分支下的 store 键（treasuryPerf 为分支外特例）。 */
  readonly storeKey: string;
  readonly module: string;
  readonly classification: TreasuryStoreClassification;
  /** 本 store 保护的事实（一句话）。 */
  readonly protectedFact: string;
  /** 硬容量（null = 单标量/定长——capacityNote 说明）。 */
  readonly hardCapacity: number | null;
  readonly capacityNote: string;
  /** 进入 terminal 的条件（active-unresolved 必填）。 */
  readonly terminalCondition: string;
  /** 唯一清理/压缩状态机（文件 + 入口）。 */
  readonly cleanupOwner: string;
  /** 删除前需要的 replacement authority（exact 依赖路径）。 */
  readonly replacementAuthority: string | null;
  /** none（不许淘汰）/ queue-evict-eligible / ttl / ring-overwrite。 */
  readonly retentionPolicy: "none" | "queue-evict-eligible" | "ttl" | "ring-overwrite";
  readonly overflowBehavior: "fail-closed" | "reclaim" | "compact" | "overwrite-oldest";
  readonly resetRecovery: string;
  readonly lookupBound: string;
  readonly gcBound: string;
  /** 是否允许按年龄淘汰（active-unresolved 必须 false）。 */
  readonly allowsAgeEviction: boolean;
}

/**
 * 全部 Treasury 持久 store 的 lifecycle contract（IX 5.1 清单——架构测试
 * 对照源码 `treasury.<key>` 写入扫描验证完备；新增 store 必须先登记）。
 */
export const TREASURY_STORE_LIFECYCLE_CONTRACTS: readonly TreasuryStoreLifecycleContract[] = [
  {
    storeKey: "receipts",
    module: "runtime/treasury/receipts.ts",
    classification: "recent-exact-detail",
    protectedFact: "已结算 attempt 的 exact settlement proof（anti-replay + 短期审计 identity）",
    hardCapacity: 4096,
    capacityNote: "TREASURY_RECEIPT_MAX_ENTRIES=4096；admission 另有 PREPARED_ADMISSION_LIMIT=64",
    terminalCondition: "receipt 写入即 terminal（settlement 已发生）；admission reservation 在 prepare/commit 关闭",
    cleanupOwner: "receipts.ts admission/reservation 生命周期（facade prepare/commit）",
    replacementAuthority: "durable settlement authority（completion/historical/certificate/range 分层）",
    retentionPolicy: "queue-evict-eligible",
    overflowBehavior: "fail-closed",
    resetRecovery: "Memory 直读（store 不存在 = 健康空；未知版本/损坏 fail closed）",
    lookupBound: "O(1) 单键",
    gcBound: "O(1) admission；无全表扫描 GC",
    allowsAgeEviction: false,
  },
  {
    storeKey: "intents",
    module: "runtime/treasury/intents.ts",
    classification: "active-unresolved",
    protectedFact: "executing attempt 的 durable WAL（callback 可能已开始的持久信号）",
    hardCapacity: 64,
    capacityNote: "TREASURY_INTENT_MAX_ENTRIES=64",
    terminalCondition: "committed/aborted 结算或 execution-unknown 转 quarantine",
    cleanupOwner: "intents.ts 状态机（facade commit/abort + faultResolution 接管）",
    replacementAuthority: null,
    retentionPolicy: "none",
    overflowBehavior: "fail-closed",
    resetRecovery: "Memory 直读（同 receipts）",
    lookupBound: "O(1) 单键",
    gcBound: "O(1) 单笔迁移；无年龄淘汰",
    allowsAgeEviction: false,
  },
  {
    storeKey: "quarantine",
    module: "runtime/treasury/quarantine.ts",
    classification: "active-unresolved",
    protectedFact: "execution-unknown attempt 的隔离权威（resolution 接管前的安全持有）",
    hardCapacity: 64,
    capacityNote: "TREASURY_QUARANTINE_MAX_ENTRIES=64（与 intent 合计的 recovery slot 上限）",
    terminalCondition: "faultResolution 终结（resolved/relabeled）后随 resolution cleanup 释放",
    cleanupOwner: "faultResolution.ts + resolutionCleanupCoordinator.ts",
    replacementAuthority: null,
    retentionPolicy: "none",
    overflowBehavior: "fail-closed",
    resetRecovery: "Memory 直读（v6 shape 校验）",
    lookupBound: "O(1) 单键",
    gcBound: "O(1) 单笔 resolution",
    allowsAgeEviction: false,
  },
  {
    storeKey: "resolutions",
    module: "runtime/treasury/resolutionStore.ts",
    classification: "active-unresolved",
    protectedFact: "resolving/final resolution tombstone（attempt 终局权威 + 防重放）",
    hardCapacity: 256,
    capacityNote: "TREASURY_RESOLUTION_MAX_ENTRIES=256",
    terminalCondition: "stage=final 且 semantic lineage 关闭（exact current identity 退休）",
    cleanupOwner: "resolutionStore.ts 终结路径 + faultResolution.ts",
    replacementAuthority: "retired range / chain certificate（ti root 退休后）",
    retentionPolicy: "queue-evict-eligible",
    overflowBehavior: "reclaim",
    resetRecovery: "Memory 直读（v7 shape 校验）",
    lookupBound: "O(1) 单键",
    gcBound: "bounded headroom 回收（≤硬容量）",
    allowsAgeEviction: false,
  },
  {
    storeKey: "authorizationFaults",
    module: "runtime/treasury/authorizationFaults.ts",
    classification: "active-unresolved",
    protectedFact: "授权断层记录（capability/epoch 故障的显式修复路径入口）",
    hardCapacity: 64,
    capacityNote: "AUTHORIZATION_FAULT_MAX_ENTRIES=64",
    terminalCondition: "显式 fault resolution（修复后归档/删除）",
    cleanupOwner: "authorizationFaults.ts + faultResolution.ts",
    replacementAuthority: null,
    retentionPolicy: "none",
    overflowBehavior: "fail-closed",
    resetRecovery: "Memory 直读（v5 shape 校验）",
    lookupBound: "O(1) 单键",
    gcBound: "O(1) 单笔 resolution",
    allowsAgeEviction: false,
  },
  {
    storeKey: "writeFault",
    module: "runtime/treasury/writeFault.ts",
    classification: "active-unresolved",
    protectedFact: "首个 unresolved write-fault 根因 marker（全局 writer 阻断）",
    hardCapacity: 1,
    capacityNote: "单 marker（detail ≤192 字符）",
    terminalCondition: "显式修复路径解除（faultResolution）",
    cleanupOwner: "writeFault.ts + faultResolution.ts",
    replacementAuthority: null,
    retentionPolicy: "none",
    overflowBehavior: "fail-closed",
    resetRecovery: "Memory 直读（marker v3 shape 校验）",
    lookupBound: "O(1)",
    gcBound: "O(1)",
    allowsAgeEviction: false,
  },
  {
    storeKey: "attemptLineage",
    module: "runtime/treasury/attemptLineage.ts",
    classification: "active-unresolved",
    protectedFact: "rearm chain 的 active lineage（child 签发/推进权威）",
    hardCapacity: 64,
    capacityNote: "TREASURY_LINEAGE_MAX_ENTRIES=64（active chain 数有界）",
    terminalCondition: "chain_committed / non_rearmable_retired / forensic_isolated",
    cleanupOwner: "attemptLineage.ts 终结 + lineageRetirementSummary.ts 压缩",
    replacementAuthority: "retirement summary + chain certificate",
    retentionPolicy: "queue-evict-eligible",
    overflowBehavior: "fail-closed",
    resetRecovery: "Memory 直读（v3/legacy v2 shape 校验）",
    lookupBound: "O(1) 双索引（byRoot/byLineage）",
    gcBound: "O(1) 单 chain 压缩",
    allowsAgeEviction: false,
  },
  {
    storeKey: "generationRetirementProofs",
    module: "runtime/treasury/generationRetirementAuthority.ts",
    classification: "recent-exact-detail",
    protectedFact: "历史代 tombstone 的 exact retirement proof（root 门禁的中间层）",
    hardCapacity: 384,
    capacityNote: "TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES=384",
    terminalCondition: "chain summary 持久化后孤儿 proof 释放（tombstone 不存在的代）",
    cleanupOwner: "generationRetirementAuthority.ts + lineageRetirementSummary.ts 压缩",
    replacementAuthority: "retirement summary（exact per-generation retirement proof）",
    retentionPolicy: "queue-evict-eligible",
    overflowBehavior: "fail-closed",
    resetRecovery: "Memory 直读（v2 shape 校验）",
    lookupBound: "O(1) per-chain 索引",
    gcBound: "per-chain 有界遍历",
    allowsAgeEviction: false,
  },
  {
    storeKey: "resolutionCleanup",
    module: "runtime/treasury/resolutionCleanupJournal.ts",
    classification: "active-unresolved",
    protectedFact: "cleanup 五阶段 journal（completion 前的恢复事实）",
    hardCapacity: 256,
    capacityNote: "TREASURY_RESOLUTION_CLEANUP_MAX_ENTRIES=256",
    terminalCondition: "completion proof 持久 + journal 删除 read-back 确认",
    cleanupOwner: "cleanupStageAcknowledgement.ts（唯一 ack 实现）",
    replacementAuthority: "cleanup completion（live → historical supersession）",
    retentionPolicy: "none",
    overflowBehavior: "fail-closed",
    resetRecovery: "Memory 直读（v1 shape 校验；阶段幂等重放）",
    lookupBound: "O(1) 单键",
    gcBound: "O(1) 单笔 ack",
    allowsAgeEviction: false,
  },
  {
    storeKey: "cleanupCompletions",
    module: "runtime/treasury/cleanupCompletionAuthority.ts",
    classification: "recent-exact-detail",
    protectedFact: "最近 cleanup completion 的 exact proof（五阶段完成）",
    hardCapacity: 128,
    capacityNote: "TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES=128",
    terminalCondition: "completion 写入即 terminal（exact detail 的 recent queue 头部层）",
    cleanupOwner: "cleanupCompletionReplacement.ts（bounded exact archive）",
    replacementAuthority: "historical supersession（durable archive read-back）",
    retentionPolicy: "queue-evict-eligible",
    overflowBehavior: "reclaim",
    resetRecovery: "Memory 直读（v1 shape 校验）",
    lookupBound: "O(1) 单键",
    gcBound: "bounded headroom 回收（≤硬容量，exact archive 验证）",
    allowsAgeEviction: false,
  },
  {
    storeKey: "completionHeadroomReservations",
    module: "runtime/treasury/completionHeadroomReservation.ts",
    classification: "active-unresolved",
    protectedFact: "prepare 的独占 completion headroom reservation（容量槽契约）",
    hardCapacity: null,
    capacityNote: "受 completion 硬容量 128 联合约束（live+reserved−pairs ≤ 128）；TTL=1000",
    terminalCondition: "consume（completion handoff）或显式 release（callback 确定未开始）或 TTL orphan sweep（owner truth graph 全空）",
    cleanupOwner: "cleanupCompletionHandoff.ts（单一 handoff owner）",
    replacementAuthority: null,
    retentionPolicy: "ttl",
    overflowBehavior: "fail-closed",
    resetRecovery: "Memory 直读（v1 shape 校验；pair reconcile/orphan sweep 分级恢复）",
    lookupBound: "O(1) 单键；effective occupancy O(reserved)（≤容量有界）",
    gcBound: "O(reserved)（≤128 有界）",
    allowsAgeEviction: false,
  },
  {
    storeKey: "cleanupSupersessions",
    module: "runtime/treasury/cleanupSupersessionAuthority.ts",
    classification: "recent-exact-detail",
    protectedFact: "归档的 historical completion（exact detail 的 durable 层）",
    hardCapacity: 384,
    capacityNote: "TREASURY_CLEANUP_SUPERSESSION_MAX_ENTRIES=384",
    terminalCondition: "archive 写入即 terminal（chain 终结后可压缩）",
    cleanupOwner: "chainRetirementCertificate.ts compressTreasuryChainHistoricalEntries",
    replacementAuthority: "chain certificate（chain 维度）+ retired range（anti-reuse）",
    retentionPolicy: "queue-evict-eligible",
    overflowBehavior: "compact",
    resetRecovery: "Memory 直读（v1 shape 校验）",
    lookupBound: "O(1) 单键",
    gcBound: "per-chain 有界压缩",
    allowsAgeEviction: false,
  },
  {
    storeKey: "lineageRetirementSummaries",
    module: "runtime/treasury/lineageRetirementSummary.ts",
    classification: "recent-exact-detail",
    protectedFact: "terminal chain 的 exact retirement summary（root/final identity + proof class）",
    hardCapacity: 128,
    capacityNote: "TREASURY_RETIREMENT_SUMMARY_MAX_ENTRIES=128",
    terminalCondition: "summary 写入即 terminal；certificate/range replacement 验证后可驱逐（IX 工作流 C）",
    cleanupOwner: "lineageRetirementSummary.ts evictTreasuryRetirementSummaryForCapacity（matching replacement 验证）",
    replacementAuthority: "chain certificate（正面 relation 验证）或 retired range（anti-reuse + exact 依赖关闭）",
    retentionPolicy: "queue-evict-eligible",
    overflowBehavior: "fail-closed",
    resetRecovery: "Memory 直读（v3/legacy v2 shape 校验）",
    lookupBound: "O(1) 双索引",
    gcBound: "满载时有界 eligible 扫描（≤128）",
    allowsAgeEviction: false,
  },
  {
    storeKey: "chainRetirementCertificates",
    module: "runtime/treasury/chainRetirementCertificate.ts",
    classification: "recent-exact-detail",
    protectedFact: "terminal chain 的紧凑 protocol 权威（root/final/terminalState——footprint 与代数无关）",
    hardCapacity: 256,
    capacityNote: "TREASURY_CHAIN_CERTIFICATE_MAX_ENTRIES=256",
    terminalCondition: "certificate 写入即 terminal；retired range 接管 root 序号且无 exact 依赖（无 matching summary 在位）后可驱逐",
    cleanupOwner: "chainRetirementCertificate.ts recordTreasuryChainRetirementCertificate 满载分支",
    replacementAuthority: "retired range（monotonic frontier——anti-reuse-only，不得替代 exact summary）",
    retentionPolicy: "queue-evict-eligible",
    overflowBehavior: "compact",
    resetRecovery: "Memory 直读（v1 shape 校验 + canonical relation 验证）",
    lookupBound: "O(1) 双索引（byRoot/byLineage）",
    gcBound: "满载时有界 eligible 扫描（≤256）",
    allowsAgeEviction: false,
  },
  {
    storeKey: "retiredAttemptRanges",
    module: "runtime/treasury/chainRetirementCertificate.ts",
    classification: "permanent-anti-reuse",
    protectedFact: "已退休发行序号区间（同一发行域内相邻单调合并——ti1_(legacy) 与 ti2_(current) 的同序号是两个独立发行事实，X 工作流 D：按 namespace 隔离）",
    hardCapacity: 64,
    capacityNote: "TREASURY_RETIRED_RANGE_MAX_ENTRIES=64 区间（跨两发行域共享槽位）；current 域孤儿 gap coalesce 收敛（legacy gap 不参与——canonical ID 不可重建）",
    terminalCondition: "区间永久（anti-reuse 不退出——只合并不删除）",
    cleanupOwner: "chainRetirementCertificate.ts absorb/coalesce（同域单调合并；absorb 必须携带 issuer domain）",
    replacementAuthority: null,
    retentionPolicy: "none",
    overflowBehavior: "compact",
    resetRecovery: "Memory 直读（v2 shape 校验：namespace 枚举 + 同域严格递增；v1 裸 sequence store 经 load 显式迁移——发行域可从版本边界严格证明则归对应域，否则 forensic fail closed，不静默猜测）",
    lookupBound: "O(64) 区间扫描（按 ID 自带 namespace 过滤）",
    gcBound: "current 域孤儿 gap coalesce ≤512 序号 × 生命周期权威探测（namespace-local）",
    allowsAgeEviction: false,
  },
  {
    storeKey: "attemptIssuer",
    module: "runtime/treasury/attemptIssuer.ts",
    classification: "permanent-anti-reuse",
    protectedFact: "ti2_ 命名空间的持久单调 high-watermark（每个 sequence 唯一合法完整 ID 的重算基础）+ v1 迁移 legacy 记录",
    hardCapacity: null,
    capacityNote: "单标量 watermark + 单条 legacy 记录（O(1) footprint）",
    terminalCondition: "不适用（monotonic frontier 永久保留）",
    cleanupOwner: "不适用（不可清理；v1→v2 迁移为单对象替换 + read-back）",
    replacementAuthority: null,
    retentionPolicy: "none",
    overflowBehavior: "fail-closed",
    resetRecovery: "Memory 直读（v2 shape 校验；v1 自动迁移幂等；未知版本 fail closed）",
    lookupBound: "O(1)",
    gcBound: "O(1)",
    allowsAgeEviction: false,
  },
  {
    storeKey: "issuedAttemptTickets",
    module: "runtime/treasury/attemptIssuanceTicket.ts",
    classification: "active-unresolved",
    protectedFact: "受控 opening 的 issued ticket（production issuance 的 lifecycle owner——无裸 ID 窗口）",
    hardCapacity: 64,
    capacityNote: "TREASURY_ISSUED_TICKET_MAX_ENTRIES=64（active 计数）；TTL=500",
    terminalCondition: "consumed（opening 接管）/ expired（TTL 显式转换——正面生命周期事实）",
    cleanupOwner: "treasuryLifecycleGcCoordinator.ts（expire + terminal retire，watermark frontier 验证）",
    replacementAuthority: "issuer watermark（monotonic frontier 承载 sequence anti-reuse）",
    retentionPolicy: "ttl",
    overflowBehavior: "fail-closed",
    resetRecovery: "Memory 直读（v1 shape 校验；active/consumed/expired 状态恢复）",
    lookupBound: "O(1) 单键",
    gcBound: "expire ≤64 有界；retire 每批 ≤8",
    allowsAgeEviction: false,
  },
  {
    storeKey: "lifecycle",
    module: "runtime/treasury/facade.ts（beginTick/endTick 标量）",
    classification: "telemetry-audit",
    protectedFact: "lastBeginTick/lastEndTick 诊断标量（tick 边界观察）",
    hardCapacity: null,
    capacityNote: "两个 number 标量",
    terminalCondition: "不适用（逐 tick 覆盖）",
    cleanupOwner: "不适用",
    replacementAuthority: null,
    retentionPolicy: "ring-overwrite",
    overflowBehavior: "overwrite-oldest",
    resetRecovery: "缺省即重建",
    lookupBound: "O(1)",
    gcBound: "O(1)",
    allowsAgeEviction: true,
  },
];

/** 分支外特例（Memory.runtime.treasuryPerf——低频诊断快照）。 */
export const TREASURY_PERF_LIFECYCLE_CONTRACT: TreasuryStoreLifecycleContract = {
  storeKey: "treasuryPerf",
  module: "runtime/treasury/shadow.ts（性能快照）",
  classification: "telemetry-audit",
  protectedFact: "低频 perf 快照（聚合诊断——不参与安全判定）",
  hardCapacity: null,
  capacityNote: "固定键集合的 Record<string, number|string>（覆盖写）",
  terminalCondition: "不适用（覆盖写）",
  cleanupOwner: "不适用",
  replacementAuthority: null,
  retentionPolicy: "ring-overwrite",
  overflowBehavior: "overwrite-oldest",
  resetRecovery: "缺省即重建",
  lookupBound: "O(1)",
  gcBound: "O(1)",
  allowsAgeEviction: true,
};

/** storeKey → contract（O(1) 查询）。 */
export function lookupTreasuryStoreLifecycleContract(storeKey: string): TreasuryStoreLifecycleContract | undefined {
  return TREASURY_STORE_LIFECYCLE_CONTRACTS.find((contract) => contract.storeKey === storeKey);
}
