/**
 * Treasury 幂等 receipt 与生命周期持久化（Memory 最小状态）。
 *
 * 边界约束：
 * - 只保存最小 receipt（transactionId → 结算 tick）与生命周期标记，
 *   绝不持久化 overlay、observation、journal 或完整物理事实；
 * - receipt 权威跨 global reset 存活：heap 缓存丢失后凭 Memory receipt
 *   恢复幂等判断；
 * - 安全驱逐契约：
 *   * 只有超过 retention 窗口（5000 tick）的 receipt 才允许自动回收；
 *   * retention 窗口内的 receipt 绝不因容量压力被驱逐——宁可拒绝新
 *     transaction（receipt_capacity_exhausted），也不让仍在幂等保证期内
 *     的 id 被提前淘汰后重放；
 *   * admission 预检在写入任何状态（journal/overlay/heap 缓存/Memory
 *     receipt）之前执行，失败零部分写入；
 * - key 编码：settled 普通对象的键一律为 "t:"+transactionId——transactionId
 *   字符集允许 "__proto__"/"constructor" 等危险字面量，前缀编码保证它们
 *   只会成为普通自有属性键，永不触发原型污染语义；
 * - 版本契约（第十三轮升级到 v5）：
 *   * v1（裸键）→ v3：v1 raw key 一律**原样**作为 transactionId 输入安全
 *     编码（绝不调用 decode——v1 中 `abc` 与 `t:abc` 是两个不同且都合法的
 *     transactionId，decode 再 encode 会让它们碰撞）；
 *   * v2（前缀键 + entryCount）→ v3：补 nextExpiryTick 过期调度元数据；
 *   * v3/v4（数字 / 无等级对象 proof）→ v5：显式 proof 等级定级——数字与
 *     无身份对象 → 显式 legacy committed proof（不伪造身份）；digest 与
 *     durableIdentityDigest 成对 → modern（保留完整 attempt identity）；
 *     部分身份字段 → 无法安全定级 → fail closed（原 store 保留）；
 *   * 【第十三轮】统一 normalized receipt lookup：单一 lookup 结果（absent /
 *     legacy_committed / modern_committed / corrupted / incompatible）供
 *     query/admission/commit/refresh/cleanup/migration/projection/prepare/
 *     finalized proof 全部路径复用——不再存在一处 typeof === "number"、
 *     另一处只认对象的分裂判定；未迁移 v1/v2/v3 store 的合法数字 value
 *     在只读查询中被零写识别为已结算（合法数字不判 corrupted；v1 裸键
 *     raw-key 单探测保持 O(1)）；
 *   * 迁移先在临时结构完成全部校验（transactionId 格式 / settled tick
 *     完整有效性 / proof 等级定级 / 编码碰撞防御），自检通过后一次性原子
 *     替换原 store；任何碰撞/非法 key/非法 value 都使原 store 保持不变并
 *     fail closed；
 *   * 只执行一次（version 提升后不再进入迁移分支）；
 *   * 未知/更高/无法解析版本 → fail closed：原数据保留、拒绝新登记，
 *     不冷启动重建、不静默丢弃；
 * - 损坏 value fail closed（第四轮修复）：settled tick 必须是
 *   [0, Game.time] 内的安全整数；NaN/Infinity/非整数/负数/未来 tick 等
 *   一律视为损坏——迁移不跳过、cleanup 不删除、admission 整体阻断
 *   （receipt_store_incompatible），只有显式管理/修复路径可解除；
 *   已能可靠识别的旧 transaction（own key 存在且 value 有效）查询仍
 *   返回 already_settled——store 损坏不得让幂等保证期内的 id 被遗忘；
 * - 过期调度元数据 nextExpiryTick（v3 新增，正常路径避免全表扫描）：
 *   * 空表为 null；非空 = min(settledAt)+retention+1（第一个可能有条目
 *     过期的 nowTick，与过期条件 settledAt < now-retention 严格一致）；
 *   * Game.time 未到 nextExpiryTick 时 beginTick 清理零扫描、满容
 *     admission 直接 O(1) 拒绝（不反复全表扫描）；
 *   * 到达过期点执行一次清理并重算 nextExpiryTick；
 *   * global reset 后 load 时对元数据做一次完整验证（与 entryCount、
 *     key 格式、value 有效性同批），损坏即 fail closed、不放宽容量；
 *   * 插入/迁移/清理后元数据始终一致（commitSettledReceipt 维护单调
 *     min，cleanup 全量重算）；
 * - admission 复杂度：快路径 O(1)（entryCount + pending 预留计数）；
 * - 两阶段槽位预留：prepare 成功即占用一个 admission 槽（pending
 *   heap 集合，有界），使 commit 兑现时不再可能因容量被拒；abort/commit
 *   释放；其余 admission 的满容判断计入 pending 数（不让出即超卖）。
 */

import {
  TREASURY_TRANSACTION_ID_MAX_LENGTH,
  isValidTreasuryTransactionId,
  isTreasuryRearmAttemptId,
} from "@/runtime/treasury/transactionId";
import type { TreasuryWriteFaultMarker } from "@/runtime/treasury/writeFault";
import type { TreasuryAttemptIdentity } from "@/runtime/treasury/identityProof";
import {
  treasuryExactAttemptIdentityOfIdentityInput,
  treasuryExactAttemptIdentityOfReceiptProof,
  treasuryExactAttemptIdentityRelation,
  type TreasuryExactIdentityFactsInput,
} from "@/runtime/treasury/exactAttemptIdentity";
import { validateTreasurySemanticLineage, describeTreasurySemanticLineageVerdict } from "@/runtime/treasury/semanticLineageValidation";
import { resetTreasuryQuarantineRuntimeForTest } from "@/runtime/treasury/quarantine";
import { resetTreasuryResolutionEventsForTest } from "@/runtime/treasury/resolutionEvents";
import { resetTreasuryIntentRuntimeForTest } from "@/runtime/treasury/intents";
import { unsealTreasuryAdapterRegistryForTest } from "@/runtime/treasury/actionContracts";
import { resetTreasuryAuthorizationFaultRuntimeForTest } from "@/runtime/treasury/authorizationFaults";
import { validateTreasuryLowlevelSourceField } from "@/runtime/treasury/authorityLevel";

export const TREASURY_RECEIPT_RETENTION_TICKS = 5_000;
export const TREASURY_RECEIPT_MAX_ENTRIES = 4_096;
export const TREASURY_RECEIPT_VERSION = 8 as const;

const RECEIPT_KEY_PREFIX = "t:";

/**
 * 【第十三轮】receipt proof 的显式等级（第十三轮建立 modern/legacy、
 * 【第十七轮第十五节 v7】拆分为显式三级）：identity-bound = 携带完整
 * modern contract attempt 身份（digest + durableIdentityDigest 必填）的
 * 结算证明，禁携带 lowlevelSource；lowlevel = 低层 attempt 的结算证明
 * （digest + durableIdentityDigest + 受控 lowlevelSource 必填，禁 modern
 * contract/cohort 字段）；legacy = 无身份的历史/compat 结算证明（只作
 * replay blocker 与历史诊断——不得释放 modern/lowlevel authority、不得
 * rearm、不得证明 child attempt）。等级是持久化显式语义——不得由身份
 * 字段存在性隐式推断；不同 proof class 不能互相释放 authority。
 */
export type TreasuryReceiptProofLevel = "identity-bound" | "lowlevel" | "legacy";

/**
 * v6 历史 "modern" 等级的读取归一化（v7 写入侧不再产生 "modern"）：
 * modern 无 lowlevelSource → identity-bound；modern 有合法 lowlevelSource →
 * lowlevel。lookup/迁移按归一化等级解释；字段矛盾（modern + lowlevelSource
 * + contractDigest 并存）→ fail closed 不猜测。
 */
export type TreasuryLegacyReceiptProofLevel = "modern" | "legacy";

/**
 * 【第十二轮 3.4 / 第十三轮 v5 / 第十六轮 v6】settlement proof：结算 tick +
 * 该次 action attempt 的身份绑定（canonical digest / durableIdentityDigest，
 * 可选 contractDigest / authorizationCohortDigest）+ 显式 proof 等级。
 * legacy proof 无身份字段——不得证明携带现代身份的新 attempt。
 * 【第十六轮第十一节 v6】lowlevelSource：lowlevel attempt 的显式 provenance
 * （受控枚举——runtime 与 migrated 不能互相证明；modern proof 可携带以绑定
 * 低层结算，legacy proof 禁携带；v5 及更早 receipt 无此字段 = 来源不可证明
 * 的旧 proof，隔离不释放）。
 */
export interface TreasurySettlementProof {
  readonly level: TreasuryReceiptProofLevel;
  readonly settledAtTick: number;
  readonly digest?: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  /**
   * 【第十八轮 24.4 v8】tr1_ rearm attempt 的 lineage proof（commit 写入点
   * 携带；tr1_ receipt 缺 proof → 不释放当前 rearm authority，只作 replay
   * blocker——旧 proof 不得冒充当前代）。initial attempt 禁止携带。
   */
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
}

export interface TreasuryReceiptStore {
  version: typeof TREASURY_RECEIPT_VERSION;
  /** key = encodeReceiptKey(transactionId)；value = settlement proof（v4）。 */
  settled: Record<string, TreasurySettlementProof>;
  updatedAt: number;
  /** settled 自有键计数（加载时校验；admission 快路径的权威计数）。 */
  entryCount: number;
  /**
   * 过期调度元数据：空表 null；非空 = min(settledAt)+retention+1。
   * 未到该 tick 的一切清理/满容回收路径都不得扫描 store。
   */
  nextExpiryTick: number | null;
}

export interface TreasuryLifecycleMemory {
  lastBeginTick?: number;
  lastEndTick?: number;
}

interface TreasuryMemoryBranch {
  receipts?: {
    version?: number;
    settled?: Record<string, number | TreasurySettlementProof>;
    updatedAt?: number;
    entryCount?: number;
    nextExpiryTick?: number | null;
  };
  lifecycle?: TreasuryLifecycleMemory;
  /** staged commit 意外故障的最小持久 marker（详见 writeFault.ts）。 */
  writeFault?: TreasuryWriteFaultMarker;
}

type RuntimeMemoryWithTreasury = NonNullable<Memory["runtime"]> & {
  treasury?: TreasuryMemoryBranch;
};

function treasuryBranch(): TreasuryMemoryBranch {
  if (!Memory.runtime) Memory.runtime = {};
  const runtime = Memory.runtime as RuntimeMemoryWithTreasury;
  if (!runtime.treasury) runtime.treasury = {};
  return runtime.treasury;
}

/** receipt key 编码：防 "__proto__"/"constructor" 等合法 transactionId 字面量。 */
export function encodeReceiptKey(transactionId: string): string {
  return RECEIPT_KEY_PREFIX + transactionId;
}

/**
 * 诊断用解码（已是编码键则原样语义返回 transactionId）。
 * 注意：legacy 迁移禁止使用——v1 裸键 `abc` 与 `t:abc` 是不同 transactionId。
 */
export function decodeReceiptKey(key: string): string {
  return key.startsWith(RECEIPT_KEY_PREFIX) ? key.slice(RECEIPT_KEY_PREFIX.length) : key;
}

/** settled tick 完整有效性：[0, nowTick] 内的安全整数（损坏即 fail closed）。 */
function isValidSettledTick(value: unknown, nowTick: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= nowTick
  );
}

/**
 * 查找已结算 receipt：返回有效结算 tick；own key 存在但 value 无效返回
 * "corrupted"；不存在返回 undefined。不依赖 store 版本——fatal/旧格式上
 * 已可靠识别的 id 仍返回结算 tick（幂等保证不因 store 损坏而遗忘）。
 */
/**
 * v5/v6 value 形状校验（显式等级语义，读取兼容——v7 store 已迁移，但
 * lookup 的宽松视图可能读到未迁移的 v6）：对象含合法 settledAtTick 与
 * level；level=modern 时 digest 与 durableIdentityDigest 必填（16 hex），
 * contractDigest/authorizationCohortDigest 可选（16 hex）；level=legacy 时
 * 不得携带任何身份字段。
 */
function isValidV6SettlementProof(value: unknown, nowTick: number): value is TreasurySettlementProof {
  if (!value || typeof value !== "object") return false;
  const typed = value as Partial<Omit<TreasurySettlementProof, "level">> & { level?: string };
  if (!isValidSettledTick(typed.settledAtTick, nowTick)) return false;
  if (typed.level !== "modern" && typed.level !== "legacy") return false;
  const identityFields = ["digest", "contractDigest", "authorizationCohortDigest", "durableIdentityDigest"] as const;
  for (const field of identityFields) {
    const fieldValue = typed[field];
    if (fieldValue !== undefined && (typeof fieldValue !== "string" || !/^[0-9a-f]{16}$/.test(fieldValue))) {
      return false;
    }
  }
  // 【第十六轮第十一节 v6】lowlevel provenance：存在须为受控枚举。
  if (typed.lowlevelSource !== undefined && validateTreasuryLowlevelSourceField(typed.lowlevelSource) !== null) {
    return false;
  }
  if (typed.level === "modern") {
    if (typed.digest === undefined || typed.durableIdentityDigest === undefined) return false;
    return true;
  }
  // legacy proof 禁携带身份字段（显式等级——不得与隐式推断并存）。
  for (const field of identityFields) {
    if (typed[field] !== undefined) return false;
  }
  if (typed.lowlevelSource !== undefined) return false;
  return true;
}

/**
 * 【第十七轮第十五节 v7】value 形状校验（显式三级 proof class）：
 * - identity-bound：digest + durableIdentityDigest 必填；contractDigest/
 *   authorizationCohortDigest 可选；**禁携带 lowlevelSource**；
 * - lowlevel：digest + durableIdentityDigest + lowlevelSource（受控枚举）
 *   必填；**禁携带 modern contract/cohort 字段**；
 * - legacy：禁一切身份字段。
 */
function isValidSettlementProof(value: unknown, nowTick: number): value is TreasurySettlementProof {
  if (!value || typeof value !== "object") return false;
  const typed = value as Partial<TreasurySettlementProof> & { level?: unknown };
  if (!isValidSettledTick(typed.settledAtTick, nowTick)) return false;
  if (typed.level !== "identity-bound" && typed.level !== "lowlevel" && typed.level !== "legacy") return false;
  const identityFields = ["digest", "contractDigest", "authorizationCohortDigest", "durableIdentityDigest"] as const;
  for (const field of identityFields) {
    const fieldValue = typed[field];
    if (fieldValue !== undefined && (typeof fieldValue !== "string" || !/^[0-9a-f]{16}$/.test(fieldValue))) {
      return false;
    }
  }
  if (typed.lowlevelSource !== undefined && validateTreasuryLowlevelSourceField(typed.lowlevelSource) !== null) {
    return false;
  }
  // 【第十八轮 24.4 v8】lineage proof 字段形状（tr1_ receipt 携带；legacy 禁）。
  if (typed.lineageId !== undefined && (typeof typed.lineageId !== "string" || !/^[0-9a-f]{16}$/.test(typed.lineageId))) {
    return false;
  }
  if (typed.lineageBindingDigest !== undefined && (typeof typed.lineageBindingDigest !== "string" || !/^[0-9a-f]{16}$/.test(typed.lineageBindingDigest))) {
    return false;
  }
  if (typed.lineageGeneration !== undefined && (typeof typed.lineageGeneration !== "number" || !Number.isSafeInteger(typed.lineageGeneration) || typed.lineageGeneration < 1)) {
    return false;
  }
  if (typed.parentTransactionId !== undefined && (typeof typed.parentTransactionId !== "string" || typed.parentTransactionId.length === 0)) {
    return false;
  }
  // lineage proof 只能整体携带或整体缺失（不完整 proof 视为损坏）。
  const lineageFieldCount = [typed.lineageId, typed.lineageGeneration, typed.parentTransactionId, typed.lineageBindingDigest].filter((v) => v !== undefined).length;
  if (lineageFieldCount !== 0 && lineageFieldCount !== 4) return false;
  if (typed.level === "identity-bound") {
    if (typed.digest === undefined || typed.durableIdentityDigest === undefined) return false;
    if (typed.lowlevelSource !== undefined) return false;
    return true;
  }
  if (typed.level === "lowlevel") {
    if (typed.digest === undefined || typed.durableIdentityDigest === undefined) return false;
    if (typed.lowlevelSource === undefined) return false;
    if (typed.contractDigest !== undefined || typed.authorizationCohortDigest !== undefined) return false;
    return true;
  }
  // legacy proof 禁携带身份字段（含 lineage proof）。
  for (const field of identityFields) {
    if (typed[field] !== undefined) return false;
  }
  if (typed.lowlevelSource !== undefined) return false;
  if (lineageFieldCount !== 0) return false;
  return true;
}

/**
 * 【第十七轮第十五节】写入侧 level 计算单一权威：有受控 lowlevelSource →
 * lowlevel（禁 modern contract/cohort 字段——写入时剥离）；有完整身份
 *（digest + durableIdentityDigest）→ identity-bound；否则 legacy。
 */
function receiptProofLevelOfIdentity(identity: {
  readonly digest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
} | undefined): TreasuryReceiptProofLevel {
  if (identity?.lowlevelSource !== undefined && validateTreasuryLowlevelSourceField(identity.lowlevelSource) === null) {
    return "lowlevel";
  }
  if (identity?.digest !== undefined && identity?.durableIdentityDigest !== undefined) {
    return "identity-bound";
  }
  return "legacy";
}

/**
 * 【第二十轮 9.3/9.4/9.5→第二十二轮第十节】tr1_ receipt 的 semantic
 * lineage 写入门禁（commit 写入与 refresh 共用）：完整 lineage proof +
 * exact identity（digest+durable）+ purpose-aware semantic validation =
 * match 是写入/刷新的前提；validator 未装配（authority source 未注册）
 * 同样 fail closed——绝不乐观写入。commit 与 refresh 均为 committed
 * settlement 路径（refresh 属 release-trusted 链路——不得以布尔开关放宽
 * generation role）。返回 null = 通过；conflict=true 时调用方按
 * identity_conflict 归类，否则 insufficient_proof。
 */
function tr1ReceiptSemanticGate(
  transactionId: string,
  identity: TreasuryExactIdentityFactsInput | undefined,
  identityLineageComplete: boolean,
): { readonly detail: string; readonly conflict: boolean } | null {
  if (!isTreasuryRearmAttemptId(transactionId)) return null;
  if (!identityLineageComplete || identity?.digest === undefined || identity.durableIdentityDigest === undefined) {
    receiptEvents.receiptProofLevelRejections += 1;
    return {
      conflict: false,
      detail: "tr1_ rearm attempt 的 receipt 写入/刷新必须携带完整 lineage proof 与 exact identity（digest+durableIdentityDigest）——缺失即零写入（不写 legacy、不猜测 generation）",
    };
  }
  const semantic = validateTreasurySemanticLineage({
    transactionId,
    proof: {
      lineageId: identity.lineageId!,
      lineageGeneration: identity.lineageGeneration!,
      parentTransactionId: identity.parentTransactionId!,
      lineageBindingDigest: identity.lineageBindingDigest!,
    },
    identity,
    purpose: "committed_settlement",
  });
  if (semantic.verdict !== "match") {
    receiptEvents.receiptProofLevelRejections += 1;
    return {
      conflict: semantic.verdict === "conflict",
      detail: `tr1_ receipt 的 semantic lineage validation 未通过（${describeTreasurySemanticLineageVerdict(semantic)}）——零写入（fail closed）`,
    };
  }
  return null;
}

/**
 * v4 value 形状校验（第十二轮 schema，无 level 字段）：对象含合法
 * settledAtTick；digest/durableIdentityDigest 可选（16 hex）；出现 v4 之后
 * 引入的字段（level/contractDigest/authorizationCohortDigest）视为损坏。
 */
function isValidV4SettlementProofShape(
  value: unknown,
  nowTick: number,
): value is { settledAtTick: number; digest?: string; durableIdentityDigest?: string } {
  if (!value || typeof value !== "object") return false;
  const typed = value as Record<string, unknown> & { settledAtTick?: unknown };
  if (!isValidSettledTick(typed.settledAtTick, nowTick)) return false;
  if (typed.digest !== undefined && (typeof typed.digest !== "string" || !/^[0-9a-f]{16}$/.test(typed.digest))) return false;
  if (
    typed.durableIdentityDigest !== undefined &&
    (typeof typed.durableIdentityDigest !== "string" || !/^[0-9a-f]{16}$/.test(typed.durableIdentityDigest))
  ) {
    return false;
  }
  if (typed.level !== undefined || typed.contractDigest !== undefined || typed.authorizationCohortDigest !== undefined) {
    return false;
  }
  if (typed.lowlevelSource !== undefined) return false;
  return true;
}

/**
 * 【第十三轮 4.1】统一 normalized receipt lookup 结果：所有 receipt 读写
 * 路径（query/admission/commit/refresh/cleanup/migration/projection/prepare/
 * finalized proof）的唯一判定语义。
 * - absent：own key 不存在；
 * - incompatible：store 不存在/版本未知/settled 非对象；
 * - corrupted：own key 存在但 value 无法按其 store 版本可靠解释；
 * - legacy_committed：合法无身份历史证明（v1-v3 数字或显式 legacy proof）；
 * - modern_committed：合法现代证明（显式 modern proof；v4 未迁移 store 按
 *   durableIdentityDigest 存在性只读推断——仅查询展示，定级权威在迁移）。
 */
export type TreasuryReceiptLookupResult =
  | { readonly status: "absent" }
  | { readonly status: "incompatible" }
  | { readonly status: "corrupted" }
  | { readonly status: "legacy_committed"; readonly settledAtTick: number }
  | { readonly status: "modern_committed"; readonly proof: Readonly<TreasurySettlementProof> };

/** lookup 使用的宽松 store 视图（任意受支持版本；零写——绝不触发迁移）。 */
type AnyReceiptStoreView = {
  readonly version?: unknown;
  readonly settled?: unknown;
};

/**
 * 统一 lookup（O(1)：版本判定 + 单次 own-key 探测）：按 store 版本解释
 * value——v1 裸键用 raw key、v2/v3 前缀键与 v4/v5 用编码 key（v1 裸键中
 * `abc` 与 `t:abc` 是两个不同 transactionId，不得 decode 混淆）。
 */
function lookupNormalizedReceipt(
  store: AnyReceiptStoreView | undefined,
  transactionId: string,
  nowTick: number,
): TreasuryReceiptLookupResult {
  if (!store || typeof store !== "object") return { status: "incompatible" };
  const version = store.version;
  const settled = store.settled as Record<string, unknown> | undefined;
  if (typeof version !== "number") return { status: "incompatible" };
  if (!settled || typeof settled !== "object") return { status: "incompatible" };
  let key: string;
  if (version === 1) {
    key = transactionId; // v1 裸键 = transactionId 本身
  } else if (version === 2 || version === 3 || version === 4 || version === 5 || version === 6 || version === 7 || version === 8) {
    key = encodeReceiptKey(transactionId);
  } else {
    // 未知/更高版本：store 整体 fail closed（admission/登记拒绝），但已能
    // 可靠解释的合法条目不得被遗忘（【第十三轮 4.2】幂等保证不因版本未知
    // 丢失）——按 v2+ 前缀键形态探测：合法数字 = legacy committed；合法
    // v7/v6/v5 proof 按等级分流；无法解释 = incompatible。
    key = encodeReceiptKey(transactionId);
    if (!Object.prototype.hasOwnProperty.call(settled, key)) return { status: "incompatible" };
    const unknownValue = settled[key];
    if (isValidSettledTick(unknownValue, nowTick)) return { status: "legacy_committed", settledAtTick: unknownValue };
    if (isValidSettlementProof(unknownValue, nowTick)) {
      const proof = unknownValue as TreasurySettlementProof;
      return proof.level === "legacy"
        ? { status: "legacy_committed", settledAtTick: proof.settledAtTick }
        : { status: "modern_committed", proof };
    }
    if (isValidV6SettlementProof(unknownValue, nowTick)) {
      const proof = unknownValue as TreasurySettlementProof;
      return (proof as { level: string }).level === "modern"
        ? { status: "modern_committed", proof }
        : { status: "legacy_committed", settledAtTick: proof.settledAtTick };
    }
    if (isValidV4SettlementProofShape(unknownValue, nowTick)) {
      const typed = unknownValue as { settledAtTick: number; digest?: string; durableIdentityDigest?: string };
      if (typed.durableIdentityDigest !== undefined) {
        return {
          status: "modern_committed",
          proof: { level: "identity-bound", settledAtTick: typed.settledAtTick, digest: typed.digest, durableIdentityDigest: typed.durableIdentityDigest },
        };
      }
      return { status: "legacy_committed", settledAtTick: typed.settledAtTick };
    }
    return { status: "incompatible" };
  }
  if (!Object.prototype.hasOwnProperty.call(settled, key)) return { status: "absent" };
  const value = settled[key];
  if (version === 1 || version === 2 || version === 3) {
    // v1-v3 为纯数字版本：合法数字 = legacy committed（零写识别——query 不
    // 不得隐式迁移）；对象 value 在 v3 及更早 schema 中不可靠解释 → corrupted。
    if (isValidSettledTick(value, nowTick)) return { status: "legacy_committed", settledAtTick: value };
    return { status: "corrupted" };
  }
  if (version === 4) {
    if (!isValidV4SettlementProofShape(value, nowTick)) return { status: "corrupted" };
    const typed = value as { settledAtTick: number; digest?: string; durableIdentityDigest?: string };
    if (typed.durableIdentityDigest !== undefined) {
      return {
        status: "modern_committed",
        proof: { level: "identity-bound", settledAtTick: typed.settledAtTick, digest: typed.digest, durableIdentityDigest: typed.durableIdentityDigest },
      };
    }
    return { status: "legacy_committed", settledAtTick: typed.settledAtTick };
  }
  if (version === 5 || version === 6) {
    // v6 = v5 + 可选 lowlevelSource（读取兼容——"modern" 归一化解释）。
    if (!isValidV6SettlementProof(value, nowTick)) return { status: "corrupted" };
    const proof = value as TreasurySettlementProof;
    return (proof as { level: string }).level === "modern"
      ? { status: "modern_committed", proof }
      : { status: "legacy_committed", settledAtTick: proof.settledAtTick };
  }
  // version === 7/8【第十七轮三级 / 第十八轮 v8 lineage proof】。
  if (!isValidSettlementProof(value, nowTick)) return { status: "corrupted" };
  const proof = value as TreasurySettlementProof;
  if (proof.level === "legacy") {
    return { status: "legacy_committed", settledAtTick: proof.settledAtTick };
  }
  // 【第十八轮 24.4】tr1_ receipt 缺完整 lineage proof → 只作旧 replay
  // blocker（legacy_committed 语义——不得释放当前 rearm authority）。
  if (
    typeof transactionId === "string" &&
    isTreasuryRearmAttemptId(transactionId) &&
    (proof.lineageId === undefined || proof.lineageGeneration === undefined || proof.parentTransactionId === undefined || proof.lineageBindingDigest === undefined)
  ) {
    return { status: "legacy_committed", settledAtTick: proof.settledAtTick };
  }
  return { status: "modern_committed", proof };
}

/** 只读查询入口（零写；query/门禁路径共用）。 */
export function lookupTreasurySettledReceipt(transactionId: string): TreasuryReceiptLookupResult {
  const raw = (Memory.runtime as RuntimeMemoryWithTreasury | undefined)?.treasury?.receipts;
  return lookupNormalizedReceipt(raw, transactionId, Game.time);
}

/** 读取（不创建）：查询侧零写路径使用。 */
export function peekTreasuryReceiptStore(): TreasuryReceiptStore | undefined {
  const branch = (Memory.runtime as RuntimeMemoryWithTreasury | undefined)?.treasury;
  return branch?.receipts as TreasuryReceiptStore | undefined;
}

export interface TreasuryReceiptHealth {
  readonly healthy: boolean;
  readonly detail: string | null;
}

/**
 * receipt store 健康探测（只读零写；authorizationSafe 的 receipt 条件）：
 * - heap 缓存已 load 且 fatal → unhealthy（value 级损坏在 load 校验检出后
 *   持续 fail closed）；
 * - 未 load 时做轻量形状探测（version 可识别 / settled 对象 / entryCount
 *   数字）——不做全表扫描（value 级损坏由下一次 load 校验显式检出）。
 */
export function peekTreasuryReceiptHealth(): TreasuryReceiptHealth {
  if (heapStoreRuntime?.fatal) {
    return { healthy: false, detail: heapStoreRuntime.fatal };
  }
  const store = peekTreasuryReceiptStore();
  if (store === undefined) return { healthy: true, detail: null };
  if (
    store.version !== TREASURY_RECEIPT_VERSION &&
    store.version !== 1 &&
    store.version !== 2 &&
    store.version !== 3 &&
    store.version !== 4 &&
    store.version !== 5 &&
    // 【第十九轮 F】loader 实际支持原子迁移的版本（v5/v6→v7 结构迁移、
    // v7→v8 passthrough）在轻量 health 阶段不得误报 unknown fatal——
    // 部署环境仍为 v6/v7 的 store 是 migration pending 而非损坏。
    store.version !== 6 &&
    store.version !== 7
  ) {
    return { healthy: false, detail: `未知 receipt 版本 ${String(store.version)}（fail closed）` };
  }
  if (!store.settled || typeof store.settled !== "object") {
    return { healthy: false, detail: "receipt settled 对象缺失" };
  }
  if (typeof store.entryCount !== "number" || !Number.isSafeInteger(store.entryCount) || store.entryCount < 0) {
    return { healthy: false, detail: "receipt entryCount 非法" };
  }
  return { healthy: true, detail: null };
}

export function peekTreasuryLifecycle(): TreasuryLifecycleMemory | undefined {
  const branch = (Memory.runtime as RuntimeMemoryWithTreasury | undefined)?.treasury;
  return branch?.lifecycle;
}

/**
 * 确定性操作计数（heap，global reset 归零；facade metrics 聚合）。
 * fullScans = Object.keys 全表扫描次数（load 校验 / 迁移 / 到点清理 /
 * fatal-store 巡检）；entriesVisited = 全部扫描上下文实际访问的条目数；
 * admissionFastPaths = 未触发任何扫描即得出结论的 admission 次数；
 * admissionFullStoreBlocked = 满容 O(1) 拒绝（含回收后仍满的拒绝）；
 * expiryCleanupScans = 到达过期点触发的清理扫描次数。
 */
const receiptEvents = {
  migrationsExecuted: 0,
  incompatibleFailures: 0,
  receiptFullScans: 0,
  admissionFastPaths: 0,
  admissionFullStoreBlocked: 0,
  expiryCleanupScans: 0,
  /** 全部扫描上下文（load 校验/迁移/过期清理/fatal 巡检）访问的条目总数。 */
  receiptEntriesVisited: 0,
  /** 迁移扫描次数（源 store 遍历 + 迁移自检各计一次）。 */
  receiptMigrationScans: 0,
  /** load 校验（v3 形状自检）访问的条目数。 */
  receiptLoadValidationEntries: 0,
  /** 到期清理访问的条目数（清理与 nextExpiry 重算已合并为单次遍历）。 */
  receiptExpiryCleanupEntries: 0,
  /** fatal-store 巡检（beginTick 清理在 fail-closed 下的剩余量统计）访问的条目数。 */
  receiptFatalInspectionEntries: 0,
  /** resolve-as-committed 刷新既有 receipt 到 resolution tick 的次数（第八轮）。 */
  receiptRefreshes: 0,
  /** 【第十三轮】只读路径识别 legacy committed receipt 的次数（零写识别）。 */
  receiptLegacyLookups: 0,
  /** 【第十三轮】identity relation 判定计数（match / conflict / insufficient）。 */
  receiptIdentityMatches: 0,
  receiptIdentityConflicts: 0,
  receiptIdentityInsufficient: 0,
  /** 【第十三轮】proof 等级拒绝计数（modern proof 必填身份缺失等）。 */
  receiptProofLevelRejections: 0,
};

export interface TreasuryReceiptCounters {
  readonly migrationsExecuted: number;
  readonly incompatibleFailures: number;
  readonly receiptFullScans: number;
  readonly admissionFastPaths: number;
  readonly admissionFullStoreBlocked: number;
  readonly expiryCleanupScans: number;
  readonly receiptEntriesVisited: number;
  readonly receiptMigrationScans: number;
  readonly receiptLoadValidationEntries: number;
  readonly receiptExpiryCleanupEntries: number;
  readonly receiptFatalInspectionEntries: number;
  /** resolve-as-committed 刷新既有 receipt 到 resolution tick 的次数（第八轮）。 */
  readonly receiptRefreshes: number;
  /** 【第十三轮】只读路径识别 legacy committed receipt 的次数（零写识别）。 */
  readonly receiptLegacyLookups: number;
  readonly receiptIdentityMatches: number;
  readonly receiptIdentityConflicts: number;
  readonly receiptIdentityInsufficient: number;
  /** 【第十三轮】proof 等级拒绝计数（modern proof 必填身份缺失等）。 */
  readonly receiptProofLevelRejections: number;
  /** 剩余可登记槽位（MAX − entryCount − pending 预留；查询路径 peek 只读）。 */
  readonly slotsRemaining: number;
  /** 下一次可能过期的 tick（null = 空表或 store 不可用）。 */
  readonly nextExpiryTick: number | null;
}

/** 只读读取计数与容量 gauge（零写：peek Memory，不触发 load/迁移）。 */
export function readTreasuryReceiptEventCounters(): TreasuryReceiptCounters {
  const store = peekTreasuryReceiptStore();
  const storeUsable = store !== undefined && store.version === TREASURY_RECEIPT_VERSION;
  const entryCount = storeUsable && typeof store.entryCount === "number" ? store.entryCount : 0;
  const slotsRemaining = storeUsable
    ? Math.max(0, TREASURY_RECEIPT_MAX_ENTRIES - entryCount - pendingAdmissions.size)
    : 0;
  return {
    ...receiptEvents,
    slotsRemaining,
    nextExpiryTick: storeUsable && typeof store.nextExpiryTick === "number" ? store.nextExpiryTick : null,
  };
}

export type TreasuryReceiptRefreshResult =
  | { readonly status: "refreshed"; readonly previousTick: number }
  | { readonly status: "written" }
  | {
      /** 既有 proof 与当前 attempt 不匹配/不可证明——拒绝覆盖（authority 保持，显式处理）。 */
      readonly status: "blocked";
      readonly reason: "identity_conflict" | "legacy_proof" | "identity_unavailable" | "insufficient_proof";
      readonly detail: string;
    }
  | { readonly status: "fatal"; readonly detail: string };

/**
 * resolve-as-committed 的既有 receipt 刷新（第八轮 8.3 / 【第十三轮第六节】
 * identity-aware）：own key 存在且 value 有效时**更新 settled tick 至
 * resolution tick**（不是 already_settled 短路——原 action tick 的旧窗口
 * 不得缩短防重放）。身份规则：
 * - 无 receipt：可写当前 modern proof（identity 完整时）；
 * - existing modern proof 且 identity 完全 match：仅刷新 settledAtTick；
 * - existing modern proof 且 identity conflict：拒绝刷新（保持 resolving
 *   authority、write readiness 继续阻断）；
 * - existing legacy/insufficient proof：不得自动升级成当前 modern attempt、
 *   不得覆盖（保持隔离，显式人工处理）；
 * - identity 未提供且存在既有 proof：无法验证 → 拒绝（blocked）；
 * - corrupted proof：fatal fail closed。
 * resolution tick 只在成功 identity 验证后更新；同步维护 updatedAt 与
 * nextExpiryTick（单次有界重算）。fatal store 拒绝。
 */
export function refreshSettledReceiptForResolution(
  transactionId: string,
  tick: number,
  identity?: {
    readonly digest?: string;
    readonly contractDigest?: string;
    readonly authorizationCohortDigest?: string;
    readonly durableIdentityDigest?: string;
    /** 【第十六轮第十一节】lowlevel attempt 的显式 provenance（proof 链绑定）。 */
    readonly lowlevelSource?: string;
    /**
     * 【第十九轮 A.4】tr1_ rearm attempt 的完整 lineage proof：match 时原样
     * 保留既有 proof 的 lineage（只刷新 tick，不降级）；absent 时从当前
     * authority 写入完整 proof；冲突 → 拒绝刷新。
     */
    readonly lineageId?: string;
    readonly lineageGeneration?: number;
    readonly parentTransactionId?: string;
    readonly lineageBindingDigest?: string;
  },
): TreasuryReceiptRefreshResult {
  const runtime = loadReceiptStoreRuntime();
  if (runtime.fatal) {
    return { status: "fatal", detail: runtime.fatal };
  }
  const { store } = runtime;
  const key = encodeReceiptKey(transactionId);
  const existing = lookupNormalizedReceipt(store, transactionId, tick);
  if (existing.status === "corrupted" || existing.status === "incompatible") {
    return {
      status: "fatal",
      detail: `transactionId ${transactionId.slice(0, 48)} 对应 receipt value 损坏，无法安全刷新（fail closed）`,
    };
  }
  // 【第十九轮 A.4】tr1_ 的 refresh 必须携带完整 lineage proof——authority 无法
  // 提供（resolver 已阻断此形态）或调用方缺省时 fail closed，不写 legacy。
  const identityLineageComplete =
    identity?.lineageId !== undefined && identity?.lineageGeneration !== undefined &&
    identity?.parentTransactionId !== undefined && identity?.lineageBindingDigest !== undefined;
  if (isTreasuryRearmAttemptId(transactionId) && !identityLineageComplete) {
    receiptEvents.receiptIdentityInsufficient += 1;
    return {
      status: "blocked",
      reason: "insufficient_proof",
      detail: `tr1_ rearm attempt 的 receipt 刷新必须携带完整 lineage proof（lineageId/generation/parent/binding）——缺失即拒绝（不写 legacy、不猜测 generation）`,
    };
  }
  if (!isTreasuryRearmAttemptId(transactionId) && identityLineageComplete) {
    receiptEvents.receiptIdentityConflicts += 1;
    return {
      status: "blocked",
      reason: "identity_conflict",
      detail: `非 rearm attempt（initial）的 receipt 刷新不得携带 lineage proof（initial 不能被 lineage proof 证明）`,
    };
  }
  // 【第二十轮 9.4】refresh 的 semantic lineage 门禁：四字段完整但语义无效
  //（ID 派生/parent/binding/authority 状态冲突——含 validator 未装配）→
  // blocked（fail closed，不覆盖既有 proof、不乐观写入）；semantic conflict
  // 归类 identity_conflict（binding/parent/generation 与权威重算冲突）。
  const refreshSemanticBlock = tr1ReceiptSemanticGate(transactionId, identity, identityLineageComplete);
  if (refreshSemanticBlock !== null) {
    if (refreshSemanticBlock.conflict) {
      receiptEvents.receiptIdentityConflicts += 1;
      return { status: "blocked", reason: "identity_conflict", detail: refreshSemanticBlock.detail };
    }
    receiptEvents.receiptIdentityInsufficient += 1;
    return { status: "blocked", reason: "insufficient_proof", detail: refreshSemanticBlock.detail };
  }
  if (existing.status !== "absent") {
    const existingTick = existing.status === "legacy_committed" ? existing.settledAtTick : existing.proof.settledAtTick;
    // 【第十三轮第六节】identity-aware 刷新：旧 receipt 不能因 transaction ID
    // 相同就被重新标注为当前 attempt。
    if (existing.status === "legacy_committed") {
      // legacy proof 无身份事实——不得自动升级成当前 modern attempt、不得覆盖。
      receiptEvents.receiptIdentityInsufficient += 1;
      return {
        status: "blocked",
        reason: "legacy_proof",
        detail: `transactionId ${transactionId.slice(0, 48)} 存在 legacy receipt proof（无身份事实）——不得覆盖或升级为当前 attempt（显式人工处理；settledAtTick ${String(existingTick)}）`,
      };
    }
    if (identity?.digest === undefined) {
      // 调用方未携带 attempt digest——无法验证属于当前 attempt，拒绝覆盖。
      receiptEvents.receiptIdentityInsufficient += 1;
      return {
        status: "blocked",
        reason: "identity_unavailable",
        detail: `transactionId ${transactionId.slice(0, 48)} 存在既有 modern receipt proof 但刷新请求未携带 attempt digest——不得覆盖（settledAtTick ${String(existingTick)}）`,
      };
    }
    // 【第二十轮 8】exact attempt identity 单一构造（lineage/lowlevel/class
    // 维度经 helper——不再手工展开）。
    const attemptExactView = treasuryExactAttemptIdentityOfIdentityInput(transactionId, identity);
    if (attemptExactView === null) {
      receiptEvents.receiptIdentityInsufficient += 1;
      return {
        status: "blocked",
        reason: "insufficient_proof",
        detail: `transactionId ${transactionId.slice(0, 48)} 的刷新 identity 无法构造完整 exact attempt identity（tr1_ 缺 lineage / 维度缺失——防御）`,
      };
    }
    // 【第二十一轮 13.1】refresh 统一 proof-class-aware exact relation（与
    // commit 幂等路径同构——不再使用缺少 proof class 维度的旧 relation 作为
    // 刷新许可）：legacy 已在上文拦截；proof 与 attempt 的 class/身份维度
    // （contract/cohort/durable/lowlevel/lineage）任一不同即阻断。
    const relation = (() => {
      const proofExact = treasuryExactAttemptIdentityOfReceiptProof(transactionId, existing.proof);
      return proofExact === null ? ("insufficient" as const) : treasuryExactAttemptIdentityRelation(proofExact, attemptExactView);
    })();
    if (relation === "conflict") {
      receiptEvents.receiptIdentityConflicts += 1;
      return {
        status: "blocked",
        reason: "identity_conflict",
        detail: `transactionId ${transactionId.slice(0, 48)} 既有 modern receipt proof 与当前 attempt identity 冲突（proof class / contract / cohort / durable / lowlevel / lineage 任一维度）——拒绝刷新（保持 resolving authority；settledAtTick ${String(existingTick)}）`,
      };
    }
    if (relation === "insufficient") {
      receiptEvents.receiptIdentityInsufficient += 1;
      return {
        status: "blocked",
        reason: "insufficient_proof",
        detail: `transactionId ${transactionId.slice(0, 48)} 既有 modern receipt proof 缺少当前 attempt 携带的身份事实——不得重新标注为当前 attempt（settledAtTick ${String(existingTick)}）`,
      };
    }
    receiptEvents.receiptIdentityMatches += 1;
    // match：只刷新 settledAtTick——既有 proof 的全部身份字段（level/digest/
    // contract/cohort/durable/lowlevel/lineage）原样保留（13.2，不重算降级、
    // 不手工重构）。
    const nextProof: TreasurySettlementProof = { ...existing.proof, settledAtTick: tick };
    if (existingTick === tick) {
      receiptEvents.receiptRefreshes += 1;
      return { status: "refreshed", previousTick: tick };
    }
    store.settled[key] = nextProof;
    store.updatedAt = tick;
    // nextExpiry 重算：旧 tick 移除可能使 min 下降（单次有界扫描；resolution
    // 是低频管理事件）。
    receiptEvents.receiptFullScans += 1;
    receiptEvents.receiptEntriesVisited += Object.keys(store.settled).length;
    store.nextExpiryTick = computeNextExpiryTick(store.settled);
    receiptEvents.receiptRefreshes += 1;
    return { status: "refreshed", previousTick: existingTick };
  }
  // absent：identity 完整 → identity-bound/lowlevel proof；否则（低层
  // authority resolve）显式 legacy proof——不冒充现代证明。【第十六轮第十
  // 一节】lowlevel attempt 的 provenance 一并写入 proof（runtime 与
  // migrated 不能互相证明）。【第十七轮第十五节 v7】显式三级——lowlevel
  // 禁携带 modern contract/cohort 字段。【第十九轮 A.4】tr1_ 的完整 lineage
  // proof 从当前 authority 写入（上文已 fail closed 校验完整）。
  const absentLevel = receiptProofLevelOfIdentity(identity);
  const nextProof: TreasurySettlementProof =
    absentLevel === "lowlevel"
      ? {
          level: "lowlevel",
          settledAtTick: tick,
          digest: identity?.digest,
          durableIdentityDigest: identity?.durableIdentityDigest,
          ...(identity?.lowlevelSource !== undefined ? { lowlevelSource: identity.lowlevelSource } : {}),
          ...(identity?.lineageId !== undefined ? { lineageId: identity.lineageId } : {}),
          ...(identity?.lineageGeneration !== undefined ? { lineageGeneration: identity.lineageGeneration } : {}),
          ...(identity?.parentTransactionId !== undefined ? { parentTransactionId: identity.parentTransactionId } : {}),
          ...(identity?.lineageBindingDigest !== undefined ? { lineageBindingDigest: identity.lineageBindingDigest } : {}),
        }
      : absentLevel === "identity-bound"
        ? {
            level: "identity-bound",
            settledAtTick: tick,
            digest: identity?.digest,
            durableIdentityDigest: identity?.durableIdentityDigest,
            ...(identity?.contractDigest !== undefined ? { contractDigest: identity.contractDigest } : {}),
            ...(identity?.authorizationCohortDigest !== undefined
              ? { authorizationCohortDigest: identity.authorizationCohortDigest }
              : {}),
            ...(identity?.lineageId !== undefined ? { lineageId: identity.lineageId } : {}),
            ...(identity?.lineageGeneration !== undefined ? { lineageGeneration: identity.lineageGeneration } : {}),
            ...(identity?.parentTransactionId !== undefined ? { parentTransactionId: identity.parentTransactionId } : {}),
            ...(identity?.lineageBindingDigest !== undefined ? { lineageBindingDigest: identity.lineageBindingDigest } : {}),
          }
        : { level: "legacy", settledAtTick: tick };
  store.settled[key] = nextProof;
  store.entryCount += 1;
  store.updatedAt = tick;
  pendingAdmissions.delete(transactionId);
  const freshExpiry = tick + TREASURY_RECEIPT_RETENTION_TICKS + 1;
  if (store.nextExpiryTick === null || freshExpiry < store.nextExpiryTick) {
    store.nextExpiryTick = freshExpiry;
  }
  return { status: "written" };
}

/**
 * 运行态 store（heap 缓存）：加载/迁移/校验一次，后续 admission O(1)。
 * fatal 非 null 时处于 fail-closed：原数据保留，一切新登记拒绝。
 */
interface ReceiptStoreRuntime {
  store: TreasuryReceiptStore;
  fatal: string | null;
}

let heapStoreRuntime: ReceiptStoreRuntime | null = null;

function fatalRuntime(raw: NonNullable<TreasuryMemoryBranch["receipts"]>, reason: string): ReceiptStoreRuntime {
  receiptEvents.incompatibleFailures += 1;
  return { store: raw as unknown as TreasuryReceiptStore, fatal: reason };
}

/** 从编码键提取 transactionId 并校验格式（v3 存储键的形状契约）。 */
function decodeValidStorageKey(key: string): string | null {
  if (!key.startsWith(RECEIPT_KEY_PREFIX)) return null;
  const transactionId = key.slice(RECEIPT_KEY_PREFIX.length);
  return isValidTreasuryTransactionId(transactionId) ? transactionId : null;
}

/** 重算过期调度元数据：空表 null；非空 = min(settledAt)+retention+1。 */
function computeNextExpiryTick(settled: Record<string, number | TreasurySettlementProof>): number | null {
  let minSettledAt: number | null = null;
  for (const key of Object.keys(settled)) {
    const value = settled[key];
    const tick = typeof value === "number" ? value : (value as Partial<TreasurySettlementProof>).settledAtTick;
    if (typeof tick !== "number") continue;
    if (minSettledAt === null || tick < minSettledAt) minSettledAt = tick;
  }
  return minSettledAt === null ? null : minSettledAt + TREASURY_RECEIPT_RETENTION_TICKS + 1;
}

/**
 * v5 store 完整形状自检（迁移写回前与 load 校验共用；一次全表扫描）：
 * own key 数、entryCount、每个存储键格式、每个 proof（显式等级语义）、
 * nextExpiryTick 与实际 min 的一致性。返回 null = 合法，否则有界错误描述。
 * context 决定 entries 计数归属（load 校验 / 迁移自检）。
 */
function validateReceiptStoreShape(
  store: TreasuryReceiptStore,
  nowTick: number,
  context: "load" | "migration",
): string | null {
  receiptEvents.receiptFullScans += 1;
  const settled = store.settled;
  if (!settled || typeof settled !== "object") return "settled 非对象";
  const ownKeys = Object.keys(settled);
  receiptEvents.receiptEntriesVisited += ownKeys.length;
  if (context === "load") receiptEvents.receiptLoadValidationEntries += ownKeys.length;
  if (store.entryCount !== ownKeys.length) {
    return `entryCount 校验失败: 声明 ${String(store.entryCount)} 实际 ${String(ownKeys.length)}`;
  }
  let minSettledAt: number | null = null;
  for (const key of ownKeys) {
    const transactionId = decodeValidStorageKey(key);
    if (transactionId === null) {
      return `存储键格式非法（须为 "t:"+合法 transactionId）: ${key.slice(0, TREASURY_TRANSACTION_ID_MAX_LENGTH + 8)}`;
    }
    const value = (settled as Record<string, unknown>)[key];
    // 【第十三轮 v5】value 必须为显式等级 proof 对象（数字 value 在 v5 schema
    // 中即损坏——v1-v3 数字只存在于迁移输入，迁移后一律为 legacy proof）。
    if (typeof value === "number" || !isValidSettlementProof(value, nowTick)) {
      const settledAtTick = typeof value === "number" ? value : (value as Partial<TreasurySettlementProof>).settledAtTick;
      if (!isValidSettledTick(settledAtTick, nowTick)) {
        return `settled proof 损坏（settledAtTick 须为 [0, ${String(nowTick)}] 安全整数）: ${transactionId.slice(0, 32)}=${String(value)}`;
      }
      receiptEvents.receiptProofLevelRejections += 1;
      return `settled proof 等级语义损坏（v5 须为显式 level 对象；modern 须携带 digest+durableIdentityDigest、legacy 禁携带身份字段）: ${transactionId.slice(0, 32)}`;
    }
    const tick = (value as TreasurySettlementProof).settledAtTick;
    if (minSettledAt === null || tick < minSettledAt) minSettledAt = tick;
  }
  const expectedNextExpiry = minSettledAt === null ? null : minSettledAt + TREASURY_RECEIPT_RETENTION_TICKS + 1;
  if (store.nextExpiryTick !== expectedNextExpiry) {
    return `nextExpiryTick 元数据损坏: 声明 ${String(store.nextExpiryTick)} 实际应为 ${String(expectedNextExpiry)}`;
  }
  return null;
}

/**
 * 迁移 value → v5 显式等级 proof 的单一权威定级（v1-v4 输入共用）：
 * - 纯数字（v1/v2/v3）→ 显式 legacy committed proof（无身份——不得伪造）；
 * - v4 对象 proof：digest 与 durableIdentityDigest 成对存在 → modern（保留
 *   完整 attempt 身份）；全部缺省 → legacy；部分存在 → 无法安全定级 →
 *   null（迁移 fail closed——绝不让删除字段的 modern 记录静默降级 legacy，
 *   也绝不让半身份记录冒充 modern）。
 * 返回 [proof, error]：error 非 null 时 proof 为 null。
 */
function migrateReceiptValue(
  rawKey: string,
  value: unknown,
  nowTick: number,
): [TreasurySettlementProof | null, string | null] {
  if (typeof value === "number") {
    if (!isValidSettledTick(value, nowTick)) {
      return [null, `迁移发现损坏 settled 数字 value（不得跳过；原 store 保持不变）: ${rawKey.slice(0, 48)}=${String(value)}`];
    }
    return [{ level: "legacy", settledAtTick: value }, null];
  }
  if (!isValidV4SettlementProofShape(value, nowTick)) {
    return [null, `迁移发现损坏 settled value（不得跳过；原 store 保持不变）: ${rawKey.slice(0, 48)}=${String(value)}`];
  }
  const typed = value as { settledAtTick: number; digest?: string; durableIdentityDigest?: string };
  const hasDigest = typed.digest !== undefined;
  const hasDurable = typed.durableIdentityDigest !== undefined;
  if (hasDigest && hasDurable) {
    return [{ level: "identity-bound", settledAtTick: typed.settledAtTick, digest: typed.digest, durableIdentityDigest: typed.durableIdentityDigest }, null];
  }
  if (!hasDigest && !hasDurable) {
    return [{ level: "legacy", settledAtTick: typed.settledAtTick }, null];
  }
  receiptEvents.receiptProofLevelRejections += 1;
  return [null, `迁移发现部分身份字段的 proof（digest 与 durableIdentityDigest 须成对；无法安全定级，原 store 保持不变）: ${rawKey.slice(0, 48)}`];
}

/**
 * legacy 迁移（v1 裸键 / v2 前缀键 / v3 / v4 对象 proof → v5 显式等级）：
 * 临时结构完成全部校验（key/transactionId/value/entryCount/nextExpiryTick/
 * 编码碰撞），自检通过后一次性原子替换原 store；任何非法 key/value/碰撞/
 * 无法安全定级都返回 fatal，原 store 保持不变（fail closed，绝不静默跳过
 * 损坏条目）。
 */
function migrateLegacyReceiptStore(
  raw: NonNullable<TreasuryMemoryBranch["receipts"]>,
  fromVersion: number,
  nowTick: number,
): ReceiptStoreRuntime {
  const source = raw.settled;
  if (!source || typeof source !== "object") {
    return fatalRuntime(raw, `v${String(fromVersion)} receipt store 缺失 settled 对象（原数据保留，拒绝登记）`);
  }
  const settled: Record<string, TreasurySettlementProof> = {};
  let entryCount = 0;
  receiptEvents.receiptFullScans += 1;
  receiptEvents.receiptMigrationScans += 1;
  const sourceKeys = Object.keys(source);
  receiptEvents.receiptEntriesVisited += sourceKeys.length;
  for (const rawKey of sourceKeys) {
    // v1 裸键原样作为 transactionId（不 decode——`abc` 与 `t:abc` 不碰撞）；
    // v2+ 键已是编码形态，decode 后按 transactionId 重新走同一编码管道。
    const transactionId =
      fromVersion === 1 ? rawKey : decodeValidStorageKey(rawKey) ?? `@invalid:${rawKey.slice(0, 24)}`;
    if (!isValidTreasuryTransactionId(transactionId)) {
      return fatalRuntime(
        raw,
        `v${String(fromVersion)} 迁移发现非法 transactionId key（原 store 保持不变）: ${rawKey.slice(0, 48)}`,
      );
    }
    const encodedKey = encodeReceiptKey(transactionId);
    const value = (source as Record<string, unknown>)[rawKey];
    // 【第十三轮】v4 store 中出现数字 value 属 schema 损坏（v4 起全对象）。
    if (fromVersion === 4 && typeof value === "number") {
      receiptEvents.receiptProofLevelRejections += 1;
      return fatalRuntime(
        raw,
        `v4 迁移发现数字 value（v4 schema 全对象 proof；原 store 保持不变）: ${rawKey.slice(0, 48)}=${String(value)}`,
      );
    }
    const [proof, migrateError] = migrateReceiptValue(rawKey, value, nowTick);
    if (migrateError !== null || proof === null) {
      return fatalRuntime(raw, `v${String(fromVersion)} ${migrateError ?? "未知迁移错误"}`);
    }
    if (Object.prototype.hasOwnProperty.call(settled, encodedKey)) {
      return fatalRuntime(
        raw,
        `v${String(fromVersion)} 迁移发现编码碰撞（原 store 保持不变）: ${transactionId.slice(0, 48)}`,
      );
    }
    settled[encodedKey] = proof;
    entryCount += 1;
  }
  const candidate: TreasuryReceiptStore = {
    version: TREASURY_RECEIPT_VERSION,
    settled,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : nowTick,
    entryCount,
    nextExpiryTick: computeNextExpiryTick(settled),
  };
  // 迁移成功后立即验证：own key 数 / entry count / 存储键格式 / proof 等级
  // 语义 / 元数据一致性（validateReceiptStoreShape 即该自检）。
  const shapeError = validateReceiptStoreShape(candidate, nowTick, "migration");
  if (shapeError !== null) {
    return fatalRuntime(raw, `v${String(fromVersion)} 迁移自检失败（原 store 保持不变）: ${shapeError}`);
  }
  treasuryBranch().receipts = candidate; // 一次性原子替换（引用切换）
  receiptEvents.migrationsExecuted += 1;
  return { store: candidate, fatal: null };
}

/**
 * 加载（含迁移与校验）：登记/生命周期路径专用（可能写 Memory）。
 * 校验失败（版本未知/entryCount 不符/value 损坏/元数据损坏）→ fail closed，
 * 不删数据、不放宽容量、不接受新 transaction，直至人工修复。
 */
function loadReceiptStoreRuntime(): ReceiptStoreRuntime {
  if (heapStoreRuntime) return heapStoreRuntime;
  const raw = treasuryBranch().receipts;
  if (!raw) {
    const created: TreasuryReceiptStore = {
      version: TREASURY_RECEIPT_VERSION,
      settled: {},
      updatedAt: Game.time,
      entryCount: 0,
      nextExpiryTick: null,
    };
    treasuryBranch().receipts = created;
    heapStoreRuntime = { store: created, fatal: null };
    return heapStoreRuntime;
  }
  if (raw.version === TREASURY_RECEIPT_VERSION) {
    const candidate = raw as unknown as TreasuryReceiptStore;
    // global reset 后的元数据验证：entryCount/键格式/value/nextExpiryTick
    // 一次全量校验（每 heap 生命周期一次），损坏即 fail closed。
    const shapeError = validateReceiptStoreShape(candidate, Game.time, "load");
    if (shapeError !== null) {
      heapStoreRuntime = fatalRuntime(raw, `${shapeError}（手工损坏，拒绝登记直至人工清理）`);
      return heapStoreRuntime;
    }
    heapStoreRuntime = { store: candidate, fatal: null };
    return heapStoreRuntime;
  }
  if (raw.version === 5 || raw.version === 6) {
    // 【第十七轮第十五节】v5/v6 → v7：proof level 拆分显式三级——
    // modern 无 lowlevelSource → identity-bound；modern 有合法 lowlevelSource
    // → lowlevel（禁携带 modern contract/cohort 字段——矛盾组合 fatal 原
    // 数据保留，不猜测）；legacy → legacy；部分身份/矛盾 → fatal。
    const source = raw.settled;
    if (!source || typeof source !== "object") {
      heapStoreRuntime = fatalRuntime(raw, `v${String(raw.version)} receipt store 缺失 settled 对象（原数据保留，拒绝登记）`);
      return heapStoreRuntime;
    }
    receiptEvents.receiptFullScans += 1;
    receiptEvents.receiptMigrationScans += 1;
    const sourceKeys = Object.keys(source);
    receiptEvents.receiptEntriesVisited += sourceKeys.length;
    const migrated: Record<string, TreasurySettlementProof> = {};
    for (const key of sourceKeys) {
      const value = (source as Record<string, unknown>)[key];
      if (!isValidV6SettlementProof(value, Game.time)) {
        receiptEvents.receiptProofLevelRejections += 1;
        heapStoreRuntime = fatalRuntime(
          raw,
          `v${String(raw.version)}→v7 迁移发现损坏 settled proof（原 store 保持不变）: ${key.slice(0, 48)}`,
        );
        return heapStoreRuntime;
      }
      const proof = value as TreasurySettlementProof;
      if (proof.level === "legacy") {
        migrated[key] = { level: "legacy", settledAtTick: proof.settledAtTick };
        continue;
      }
      if (proof.lowlevelSource !== undefined) {
        // modern + lowlevelSource（v6 形态）→ lowlevel；携带 contract/cohort
        // 字段 = 等级矛盾 → fail closed 不猜测。
        if (proof.contractDigest !== undefined || proof.authorizationCohortDigest !== undefined) {
          receiptEvents.receiptProofLevelRejections += 1;
          heapStoreRuntime = fatalRuntime(
            raw,
            `v${String(raw.version)}→v7 迁移发现等级矛盾（lowlevel proof 携带 modern contract/cohort 字段；不猜测缺失来源，原 store 保持不变）: ${key.slice(0, 48)}`,
          );
          return heapStoreRuntime;
        }
        migrated[key] = {
          level: "lowlevel",
          settledAtTick: proof.settledAtTick,
          digest: proof.digest,
          durableIdentityDigest: proof.durableIdentityDigest,
          lowlevelSource: proof.lowlevelSource,
        };
        continue;
      }
      migrated[key] = {
        level: "identity-bound",
        settledAtTick: proof.settledAtTick,
        digest: proof.digest,
        durableIdentityDigest: proof.durableIdentityDigest,
        ...(proof.contractDigest !== undefined ? { contractDigest: proof.contractDigest } : {}),
        ...(proof.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: proof.authorizationCohortDigest } : {}),
      };
    }
    const upgraded: TreasuryReceiptStore = {
      version: TREASURY_RECEIPT_VERSION,
      settled: migrated,
      updatedAt: Game.time,
      entryCount: sourceKeys.length,
      nextExpiryTick: computeNextExpiryTick(migrated),
    };
    const shapeError = validateReceiptStoreShape(upgraded, Game.time, "migration");
    if (shapeError !== null) {
      heapStoreRuntime = fatalRuntime(raw, `${shapeError}（v${String(raw.version)}→v7 升级校验失败，原数据保留）`);
      return heapStoreRuntime;
    }
    treasuryBranch().receipts = upgraded;
    heapStoreRuntime = { store: upgraded, fatal: null };
    return heapStoreRuntime;
  }
  if (raw.version === TREASURY_RECEIPT_VERSION - 1) {
    // 【第十八轮 24.4】v7 → v8 结构迁移（新 lineage proof 字段全 optional——
    // passthrough + 全量重验证；tr1_ 旧 proof 缺 lineage 的定级在 lookup 侧
    // 承载：只作 replay blocker，不释放当前 rearm authority）。
    const source = raw.settled;
    if (!source || typeof source !== "object") {
      heapStoreRuntime = fatalRuntime(raw, `v7 receipt store 缺失 settled 对象（原数据保留，拒绝登记）`);
      return heapStoreRuntime;
    }
    const upgraded: TreasuryReceiptStore = {
      ...(raw as unknown as TreasuryReceiptStore),
      version: TREASURY_RECEIPT_VERSION,
      updatedAt: Game.time,
    };
    const shapeError = validateReceiptStoreShape(upgraded, Game.time, "migration");
    if (shapeError !== null) {
      heapStoreRuntime = fatalRuntime(raw, `${shapeError}（v7→v8 升级校验失败，原数据保留）`);
      return heapStoreRuntime;
    }
    receiptEvents.migrationsExecuted += 1;
    treasuryBranch().receipts = upgraded;
    heapStoreRuntime = { store: upgraded, fatal: null };
    return heapStoreRuntime;
  }
  if (raw.version === 1 || raw.version === 2 || raw.version === 3 || raw.version === 4) {
    heapStoreRuntime = migrateLegacyReceiptStore(raw, raw.version, Game.time);
    return heapStoreRuntime;
  }
  // 未知/更高/无法解析版本：fail closed，原数据不动、不冷启动重建。
  heapStoreRuntime = fatalRuntime(
    raw,
    `未知 receipt 版本 ${String(raw.version)}（当前支持 ≤${String(TREASURY_RECEIPT_VERSION)}；原数据保留，拒绝登记直至人工处理）`,
  );
  return heapStoreRuntime;
}

/** 登记/幂等路径使用：确保 v3 store 存在（登记路径允许写 Memory）；fail closed 时抛出。 */
export function ensureTreasuryReceiptStore(): TreasuryReceiptStore {
  const runtime = loadReceiptStoreRuntime();
  if (runtime.fatal) {
    throw new Error(`Treasury receipt store fail-closed: ${runtime.fatal}`);
  }
  return runtime.store;
}

/**
 * 幂等查询（只读，【第十三轮】统一 normalized lookup）：已可靠识别的合法
 * committed proof（legacy 数字或显式对象 proof——任何受支持版本的 store）
 * 返回结算 tick；损坏/不存在/版本不可解析返回 undefined。store fail-closed
 * 期间仍尽力回答——幂等保证期内的 id 不因 store 损坏被遗忘。零 Memory 写入
 * （不隐式迁移）。
 */
export function hasSettledReceipt(transactionId: string): number | undefined {
  const found = lookupTreasurySettledReceipt(transactionId);
  if (found.status === "legacy_committed") {
    receiptEvents.receiptLegacyLookups += 1;
    return found.settledAtTick;
  }
  if (found.status === "modern_committed") {
    return found.proof.settledAtTick;
  }
  return undefined;
}

/**
 * 【第十二轮 3.4 / 第十三轮】读取 settlement proof（attempt identity 绑定；
 * 只读，统一 normalized lookup）：own key 存在且 value 有效时返回完整 proof
 * （v1-v3 数字与未迁移 v4 对象按等级语义归一为显式 level 的快照——查询
 * 零写，定级权威在迁移）；legacy proof 无身份字段——不能证明携带现代身份
 * 的 attempt。损坏/不存在/版本不可解析返回 undefined。
 */
export function readTreasurySettlementProof(transactionId: string): Readonly<TreasurySettlementProof> | undefined {
  const found = lookupTreasurySettledReceipt(transactionId);
  if (found.status === "legacy_committed") {
    receiptEvents.receiptLegacyLookups += 1;
    return Object.freeze({ level: "legacy", settledAtTick: found.settledAtTick });
  }
  if (found.status === "modern_committed") {
    return Object.freeze({ ...found.proof });
  }
  return undefined;
}

/**
 * 【第二十二轮第八节】release-trusted receipt 读取（与 replay-readable 的
 * normalized lookup 明确分离）：
 *
 * - 触发 Receipt store 完整 load/migration（version / metadata /
 *   entryCount / nextExpiry / 全部 key / 全部 value / proof 等级矩阵）——
 *   每 heap 生命周期首次一次有界全表扫描，随后 heap 缓存，同 global 后续
 *   单条读取 O(1)；
 * - store 任一无关 entry 损坏 / 版本未知 / fatal → store_unhealthy（绝不
 *   返回 trusted proof——单条可解释 proof 只够 replay-readable 阻断重放，
 *   不足以释放 Authority、关闭 Lineage 或压缩 Summary）；
 * - legacy proof（数字 / level=legacy / tr1_ 缺 lineage 字段）→
 *   legacy_insufficient（replay-only，不参与 release）。
 */
export type TreasuryTrustedReceiptLookup =
  | { readonly status: "trusted_proof"; readonly proof: TreasurySettlementProof }
  | { readonly status: "absent" }
  | { readonly status: "legacy_insufficient"; readonly detail: string }
  | { readonly status: "store_unhealthy"; readonly detail: string };

export function lookupTreasuryTrustedSettledReceipt(transactionId: string): TreasuryTrustedReceiptLookup {
  const runtime = loadReceiptStoreRuntime();
  if (runtime.fatal !== null) {
    return { status: "store_unhealthy", detail: `receipt store fail-closed: ${runtime.fatal}` };
  }
  const store = runtime.store;
  const key = encodeReceiptKey(transactionId);
  if (!Object.prototype.hasOwnProperty.call(store.settled, key)) {
    return { status: "absent" };
  }
  const value = store.settled[key];
  if (typeof value === "number") {
    return { status: "legacy_insufficient", detail: "legacy 数字 proof（replay-only——不参与 release 信任）" };
  }
  if (value.level === "legacy") {
    return { status: "legacy_insufficient", detail: "legacy 等级 proof（replay-only——不参与 release 信任）" };
  }
  if (
    isTreasuryRearmAttemptId(transactionId) &&
    (value.lineageId === undefined ||
      value.lineageGeneration === undefined ||
      value.parentTransactionId === undefined ||
      value.lineageBindingDigest === undefined)
  ) {
    return { status: "legacy_insufficient", detail: "tr1_ proof 缺 lineage 四字段（replay-only 降级——不参与 release 信任）" };
  }
  return { status: "trusted_proof", proof: value };
}

export type TreasuryReceiptAdmission =
  | { readonly status: "admitted" }
  | { readonly status: "already_settled"; readonly firstSettledAtTick: number }
  | {
      readonly status: "rejected";
      readonly reason: "receipt_capacity_exhausted" | "receipt_store_incompatible";
      readonly detail: string;
    };

/** 当前满容判定（计入两阶段 prepare 的 pending 预留）。 */
function capacityExhausted(store: TreasuryReceiptStore): boolean {
  return store.entryCount + pendingAdmissions.size >= TREASURY_RECEIPT_MAX_ENTRIES;
}

/**
 * 登记前 admission 预检（必须发生在写入 journal/overlay/heap 缓存/Memory
 * receipt 任何状态之前）：
 * - 已结算 id → already_settled（store 满不改变幂等结果；fatal store 上
 *   仍可靠识别的 id 同样返回 already_settled）；
 * - 版本未知/损坏 → 拒绝（fail closed，新 transaction 一律阻断）；
 * - 未过期条目 + pending 预留已达硬容量：
 *   * 到达 nextExpiryTick → 执行一次过期回收（扫描）再判；
 *   * 未到过期点 → O(1) 直接拒绝（admissionFullStoreBlocked，不扫描）。
 */
export function admitTreasuryReceipt(transactionId: string, nowTick: number): TreasuryReceiptAdmission {
  const runtime = loadReceiptStoreRuntime();
  const { store } = runtime;
  // 【第十三轮 4.3】统一 normalized lookup：任意合法 committed proof（显式
  // legacy 或 modern——含迁移后对象 proof）都命中 already_settled（replay
  // blocker 语义）；不再以 typeof existing === "number" 判定（该判定在
  // lookup 归一后恒不命中，迁移后的已结算 id 会被错误 admitted）。
  const existing = lookupNormalizedReceipt(runtime.fatal ? (runtime.store as unknown as AnyReceiptStoreView) : (store as unknown as AnyReceiptStoreView), transactionId, nowTick);
  if (existing.status === "legacy_committed" || existing.status === "modern_committed") {
    receiptEvents.admissionFastPaths += 1;
    const firstSettledAtTick = existing.status === "legacy_committed" ? existing.settledAtTick : existing.proof.settledAtTick;
    return { status: "already_settled", firstSettledAtTick };
  }
  if (runtime.fatal) {
    // 损坏 store：可靠识别的 id 已在上面返回 already_settled，其余整体阻断。
    return { status: "rejected", reason: "receipt_store_incompatible", detail: runtime.fatal };
  }
  if (existing.status === "corrupted") {
    return {
      status: "rejected",
      reason: "receipt_store_incompatible",
      detail: `transactionId ${transactionId.slice(0, 48)} 对应 receipt value 损坏，无法可靠判断结算状态（fail closed）`,
    };
  }
  if (pendingAdmissions.has(transactionId)) {
    // 同 id 已预留槽位（两阶段重复 prepare 由 facade 层拦截，此处防御）。
    receiptEvents.admissionFastPaths += 1;
    return { status: "admitted" };
  }
  if (capacityExhausted(store)) {
    if (store.nextExpiryTick !== null && store.nextExpiryTick <= nowTick) {
      // 到达过期点：一次有界回收后重判（低频路径）。
      runExpiryCleanup(store, nowTick);
      if (capacityExhausted(store)) {
        receiptEvents.admissionFullStoreBlocked += 1;
        return {
          status: "rejected",
          reason: "receipt_capacity_exhausted",
          detail: `未过期 receipt 已达硬容量 ${String(TREASURY_RECEIPT_MAX_ENTRIES)} 条且回收后仍满（retention 窗口内条目绝不因容量驱逐）`,
        };
      }
    } else {
      // 满载且下一过期点仍在未来：O(1) fail closed，不反复全表扫描。
      receiptEvents.admissionFullStoreBlocked += 1;
      return {
        status: "rejected",
        reason: "receipt_capacity_exhausted",
        detail: `未过期 receipt 已达硬容量 ${String(TREASURY_RECEIPT_MAX_ENTRIES)} 条（下一过期点 tick ${String(store.nextExpiryTick)} 尚未到达，不做全表扫描）`,
      };
    }
  }
  receiptEvents.admissionFastPaths += 1;
  return { status: "admitted" };
}

// ── 两阶段槽位预留（prepare→Game API→commit/abort） ────────────────────────

/** prepare 成功占用的 admission 槽（heap，有界；commit/abort 释放）。 */
const pendingAdmissions = new Set<string>();
export const TREASURY_PREPARED_ADMISSION_LIMIT = 64;

/**
 * 两阶段 prepare 的 admission 预留：预检通过即占用一个容量槽，使后续
 * commit 兑现不再可能因他人挤占容量而被拒。其余 admission 的满容判定
 * 计入 pending 数——预留期间容量不被超卖。
 */
export function reserveTreasuryReceiptAdmission(transactionId: string, nowTick: number): TreasuryReceiptAdmission {
  const admission = admitTreasuryReceipt(transactionId, nowTick);
  if (admission.status !== "admitted") return admission;
  if (pendingAdmissions.size >= TREASURY_PREPARED_ADMISSION_LIMIT && !pendingAdmissions.has(transactionId)) {
    receiptEvents.admissionFullStoreBlocked += 1;
    return {
      status: "rejected",
      reason: "receipt_capacity_exhausted",
      detail: `并发 prepare 预留已达上限 ${String(TREASURY_PREPARED_ADMISSION_LIMIT)}`,
    };
  }
  pendingAdmissions.add(transactionId);
  return admission;
}

/** abort：释放 prepare 预留（返回是否确有预留被释放）。 */
export function releaseTreasuryReceiptReservation(transactionId: string): boolean {
  return pendingAdmissions.delete(transactionId);
}

/** 生命周期兜底：释放全部预留（endTick / resetForTest；正常逐个 release）。 */
export function releaseAllTreasuryReceiptReservations(): number {
  const released = pendingAdmissions.size;
  pendingAdmissions.clear();
  return released;
}

/** 结算写入（admission 通过/预留兑现后的原子提交段调用）。 */
/** 结算写入结果：written=已写入；其余=既有 committed proof 命中（细分见类型）；fatal=store 不可写。 */
export type TreasuryReceiptWriteResult =
  | { readonly status: "written" }
  | { readonly status: "already_settled_match"; readonly settledAtTick: number }
  | {
      /** legacy proof 或 proof 缺少当前 attempt 携带的身份事实——不能证明现代 attempt（replay blocker 保留）。 */
      readonly status: "already_settled_insufficient";
      readonly settledAtTick: number;
      readonly relation: "legacy" | "insufficient";
    }
  | { readonly status: "identity_conflict"; readonly settledAtTick: number }
  | { readonly status: "fatal"; readonly detail: string };

/**
 * 结算写入（admission 通过/预留兑现后的 staged commit 段调用）。返回明确
 * 结果——fatal 时调用方必须进入 write-fault 处理，不得静默 no-op 后继续
 * 返回 committed。
 */
export function commitSettledReceipt(
  transactionId: string,
  tick: number,
  identity?: {
    readonly digest?: string;
    readonly contractDigest?: string;
    readonly authorizationCohortDigest?: string;
    readonly durableIdentityDigest?: string;
    /** 【第十六轮第十一节】lowlevel attempt 的显式 provenance（proof 链绑定）。 */
    readonly lowlevelSource?: string;
    /** 【第十八轮 24.4】tr1_ rearm attempt 的 lineage proof（整体携带）。 */
    readonly lineageId?: string;
    readonly lineageGeneration?: number;
    readonly parentTransactionId?: string;
    readonly lineageBindingDigest?: string;
  },
): TreasuryReceiptWriteResult {
  const runtime = loadReceiptStoreRuntime();
  if (runtime.fatal) {
    return { status: "fatal", detail: runtime.fatal };
  }
  const { store } = runtime;
  const key = encodeReceiptKey(transactionId);
  const existing = lookupNormalizedReceipt(store as unknown as AnyReceiptStoreView, transactionId, tick);
  if (existing.status === "corrupted") {
    // 损坏绝不解释为 already_settled（第六轮）：该 id 的结算状态无法可靠
    // 判断——fatal fail closed，调用方（commit/resolution）进入 write-fault
    // 处理，绝不发布 committed heap projection。
    return {
      status: "fatal",
      detail: `transactionId ${transactionId.slice(0, 48)} 对应 receipt value 损坏，无法安全写入结算（fail closed）`,
    };
  }
  if (existing.status !== "absent") {
    pendingAdmissions.delete(transactionId); // 双保险：不重复叠加，仍释放预留
    // 【第十三轮 5.3】细化既有 committed proof 的身份判定：identity 完整时
    // 与 modern proof 做完整 attempt identity 比较（match/conflict）；legacy
    // proof 或 proof 缺少 attempt 携带的身份事实 → insufficient（replay
    // blocker 保留——绝不覆盖既有 proof）；identity 未提供（compat 单阶段）
    // 无法证明属于本次 attempt → 保守 insufficient。
    if (existing.status === "incompatible") {
      return {
        status: "fatal",
        detail: `transactionId ${transactionId.slice(0, 48)} 的 receipt store 版本不可识别（fail closed）`,
      };
    }
    const settledAtTick = existing.status === "legacy_committed" ? existing.settledAtTick : existing.proof.settledAtTick;
    // 【第二十轮 9.1/26.5】幂等比较构造完整 exact attempt identity（含
    // lineage 四字段与 proof class——单一构造层，不手工拼接）：修复第十九
    // 轮丢弃 lineage 字段导致 matching rearm receipt 被误判 identity_conflict
    // 的缺陷；不同 generation/parent/binding/proof class/lowlevel 仍拒绝。
    const attemptExact = treasuryExactAttemptIdentityOfIdentityInput(transactionId, identity);
    if (existing.status === "legacy_committed") {
      receiptEvents.receiptIdentityInsufficient += 1;
      return { status: "already_settled_insufficient", settledAtTick, relation: "legacy" };
    }
    // existing 为 modern proof（v5 矩阵保证 digest 与 durableIdentityDigest 存在）
    if (attemptExact === undefined || identity?.digest === undefined || identity.durableIdentityDigest === undefined) {
      receiptEvents.receiptIdentityInsufficient += 1;
      return { status: "already_settled_insufficient", settledAtTick, relation: "insufficient" };
    }
    const proofExact = treasuryExactAttemptIdentityOfReceiptProof(transactionId, existing.proof);
    const relation = proofExact === null
      ? ("insufficient" as const)
      : treasuryExactAttemptIdentityRelation(proofExact, attemptExact);
    if (relation === "match") {
      receiptEvents.receiptIdentityMatches += 1;
      return { status: "already_settled_match", settledAtTick };
    }
    if (relation === "conflict") {
      receiptEvents.receiptIdentityConflicts += 1;
      return { status: "identity_conflict", settledAtTick };
    }
    receiptEvents.receiptIdentityInsufficient += 1;
    return { status: "already_settled_insufficient", settledAtTick, relation: "insufficient" };
  }
  // 【第十二轮 3.4 / 第十三轮 v5】结算写入绑定 attempt 身份并显式定级：
  // identity 完整（digest + durableIdentityDigest 成对）→ identity-bound/
  // lowlevel proof（【第十七轮第十五节 v7】三级显式——lowlevel 禁携带
  // modern contract/cohort 字段）；identity 缺省（compat 单阶段/低层路径）
  // → legacy proof；部分提供 → 无法安全定级 → fatal（编程错误防御，store 不变）。
  const identityComplete = identity?.digest !== undefined && identity?.durableIdentityDigest !== undefined;
  const identityPartial =
    !identityComplete && (identity?.digest !== undefined || identity?.durableIdentityDigest !== undefined);
  if (identityPartial) {
    receiptEvents.receiptProofLevelRejections += 1;
    return {
      status: "fatal",
      detail: `transactionId ${transactionId.slice(0, 48)} 的结算 identity 须 digest 与 durableIdentityDigest 成对提供（部分提供无法安全定级 proof 等级）`,
    };
  }
  // 【第二十轮 9.3/9.5】tr1_ 新写入门禁：完整 lineage proof + semantic
  // lineage validation = match + active/terminal authority 状态允许 commit；
  // 否则零写入 + 明确 fatal（调用方进入安全 fault 处理）。initial attempt
  // 携带任何 lineage 字段同样拒绝零写。
  const commitLineageFieldCount =
    (identity?.lineageId !== undefined ? 1 : 0) +
    (identity?.lineageGeneration !== undefined ? 1 : 0) +
    (identity?.parentTransactionId !== undefined ? 1 : 0) +
    (identity?.lineageBindingDigest !== undefined ? 1 : 0);
  if (isTreasuryRearmAttemptId(transactionId)) {
    const semanticBlock = tr1ReceiptSemanticGate(transactionId, identity, commitLineageFieldCount === 4);
    if (semanticBlock !== null) {
      return { status: "fatal", detail: semanticBlock.detail };
    }
  } else if (commitLineageFieldCount !== 0) {
    receiptEvents.receiptProofLevelRejections += 1;
    return {
      status: "fatal",
      detail: `transactionId ${transactionId.slice(0, 48)} 是 initial attempt 但携带 lineage proof（tr1_ 专属字段禁止——零写入）`,
    };
  }
  const commitLevel = receiptProofLevelOfIdentity(identity);
  // 【第十八轮 24.4】lineage proof 整体透传（4 字段全有或全无——tr1_ receipt
  // 携带完整 proof；缺失的旧写入只作 replay blocker）。
  const lineageProofFields =
    identity?.lineageId !== undefined && identity.lineageGeneration !== undefined
    && identity.parentTransactionId !== undefined && identity.lineageBindingDigest !== undefined
      ? {
          lineageId: identity.lineageId,
          lineageGeneration: identity.lineageGeneration,
          parentTransactionId: identity.parentTransactionId,
          lineageBindingDigest: identity.lineageBindingDigest,
        }
      : {};
  const proof: TreasurySettlementProof =
    identityComplete && commitLevel === "lowlevel"
      ? {
          level: "lowlevel",
          settledAtTick: tick,
          digest: identity?.digest,
          durableIdentityDigest: identity?.durableIdentityDigest,
          ...(identity?.lowlevelSource !== undefined ? { lowlevelSource: identity.lowlevelSource } : {}),
          ...lineageProofFields,
        }
      : identityComplete
        ? {
            level: "identity-bound",
            settledAtTick: tick,
            digest: identity?.digest,
            durableIdentityDigest: identity?.durableIdentityDigest,
            ...(identity?.contractDigest !== undefined ? { contractDigest: identity.contractDigest } : {}),
            ...(identity?.authorizationCohortDigest !== undefined
              ? { authorizationCohortDigest: identity.authorizationCohortDigest }
              : {}),
            ...lineageProofFields,
          }
    : { level: "legacy", settledAtTick: tick };
  store.settled[key] = proof;
  store.entryCount += 1;
  store.updatedAt = tick;
  pendingAdmissions.delete(transactionId);
  // 空表首条：建立过期点；否则新条目 settledAt=now 不会早于现有 min，
  // nextExpiryTick 保持不变（防御性 min 收敛）。
  const freshExpiry = tick + TREASURY_RECEIPT_RETENTION_TICKS + 1;
  if (store.nextExpiryTick === null || freshExpiry < store.nextExpiryTick) {
    store.nextExpiryTick = freshExpiry;
  }
  return { status: "written" };
}

interface CleanupAccumulator {
  retentionEvicted: number;
  /** 防御分支：损坏 value 既不删除也不迁移（正常流程 load 已 fail closed）。 */
  corruptedSkipped: number;
}

/**
 * 到期清理：只删除**经过完整验证且超过 retention** 的正常 receipt。单次
 * 遍历同时完成删除与 nextExpiryTick 重算（幸存条目 min 就地维护，不再
 * 二次全表扫描）；损坏 value 绝不删除（保留计数）。
 */
function runExpiryCleanup(store: TreasuryReceiptStore, nowTick: number): CleanupAccumulator {
  const acc: CleanupAccumulator = { retentionEvicted: 0, corruptedSkipped: 0 };
  receiptEvents.receiptFullScans += 1;
  receiptEvents.expiryCleanupScans += 1;
  const keys = Object.keys(store.settled);
  receiptEvents.receiptEntriesVisited += keys.length;
  receiptEvents.receiptExpiryCleanupEntries += keys.length;
  let mutated = false;
  let minSurvivor: number | null = null;
  for (const key of keys) {
    const raw = (store.settled as Record<string, unknown>)[key];
    const settledAt = typeof raw === "number" ? raw : (raw as Partial<TreasurySettlementProof>).settledAtTick;
    if (!isValidSettledTick(settledAt, nowTick)) {
      acc.corruptedSkipped += 1;
      // 损坏条目不会被删除：min 计算视为 0（保守最早过期点，宁早扫描不漏删）。
      minSurvivor = 0;
      continue;
    }
    if (settledAt >= nowTick - TREASURY_RECEIPT_RETENTION_TICKS) {
      if (minSurvivor === null || settledAt < minSurvivor) minSurvivor = settledAt;
      continue;
    }
    delete store.settled[key];
    store.entryCount -= 1;
    acc.retentionEvicted += 1;
    mutated = true;
  }
  if (mutated) store.updatedAt = nowTick;
  store.nextExpiryTick = minSurvivor === null ? null : minSurvivor + TREASURY_RECEIPT_RETENTION_TICKS + 1;
  return acc;
}

export interface TreasuryReceiptCleanupReport {
  retentionEvicted: number;
  /** 损坏 value 被跳过（保留原样）的条数——正常运行恒为 0。 */
  corruptedSkipped: number;
  remaining: number;
  /** 未过期但超过硬容量的条数（绝不驱逐，显式报告供监控）。 */
  overLimit: number;
  /** fail-closed 时的有界诊断（null = 正常）。 */
  fatalDetail: string | null;
  /** 清理后的下一次过期点（null = 空表）。 */
  nextExpiryTick: number | null;
}

/**
 * 生命周期清理（beginTick 触发）：nextExpiryTick 未到 → 零扫描直接返回；
 * 到达 → 一次清理并重算过期点。只回收超过 retention 窗口的正常 receipt，
 * 绝不因容量驱逐 retention 内条目；fail-closed 状态下不动任何数据。
 */
export function cleanupTreasuryReceipts(nowTick: number): TreasuryReceiptCleanupReport {
  const runtime = loadReceiptStoreRuntime();
  if (runtime.fatal) {
    receiptEvents.receiptFullScans += 1;
    const fatalKeys = Object.keys(runtime.store.settled ?? {});
    receiptEvents.receiptEntriesVisited += fatalKeys.length;
    receiptEvents.receiptFatalInspectionEntries += fatalKeys.length;
    const remaining = fatalKeys.length;
    return {
      retentionEvicted: 0,
      corruptedSkipped: 0,
      remaining,
      overLimit: 0,
      fatalDetail: runtime.fatal,
      nextExpiryTick: null,
    };
  }
  const { store } = runtime;
  if (store.nextExpiryTick === null || store.nextExpiryTick > nowTick) {
    // 未到过期点：不扫描整个 store（过期调度元数据的正常路径）。
    return {
      retentionEvicted: 0,
      corruptedSkipped: 0,
      remaining: store.entryCount,
      overLimit: Math.max(0, store.entryCount - TREASURY_RECEIPT_MAX_ENTRIES),
      fatalDetail: null,
      nextExpiryTick: store.nextExpiryTick,
    };
  }
  const acc = runExpiryCleanup(store, nowTick);
  return {
    retentionEvicted: acc.retentionEvicted,
    corruptedSkipped: acc.corruptedSkipped,
    remaining: store.entryCount,
    overLimit: Math.max(0, store.entryCount - TREASURY_RECEIPT_MAX_ENTRIES),
    fatalDetail: null,
    nextExpiryTick: store.nextExpiryTick,
  };
}

export function writeTreasuryLifecycle(update: TreasuryLifecycleMemory): void {
  const branch = treasuryBranch();
  branch.lifecycle = { ...branch.lifecycle, ...update };
}

export function readTreasuryLifecycle(): TreasuryLifecycleMemory | undefined {
  return peekTreasuryLifecycle();
}

/**
 * resolution store 的测试清理钩子（第八轮）：resolutionStore 依赖本模块
 *（receipt 查询/retention 常量），为避免循环依赖，其测试 reset 经此注册
 * ——resolutionStore 模块加载时自注册；未加载（无 resolution 消费的测试）
 * 时无需清理。
 */
let resolutionResetHook: (() => void) | null = null;
/** 【第十八轮】lineage 族 heap 复位 hook 列表（attemptLineage +
 * lineageRetirementSummary 都需复位——单槽会被后注册者覆盖，跨测试泄漏
 * heap 缓存会把写入引到孤儿 store 上）。 */
const lineageResetHooks: (() => void)[] = [];
export function registerTreasuryResolutionResetHook(hook: (() => void) | null): void {
  resolutionResetHook = hook;
}

/** 【Remediation III】cleanup journal 的 heap 复位 hook 注册（数组——
 * journal 模块加载时注册；clear 时 journal Memory 分支一并删除，heap
 * 缓存必须失效，否则后续写入落到已摘除的 detached store 与 Memory
 * read-back 不一致）。 */
const resolutionCleanupResetHooks: (() => void)[] = [];
export function registerTreasuryResolutionCleanupResetHook(hook: (() => void) | null): void {
  const index = resolutionCleanupResetHooks.indexOf(hook);
  if (hook === null) {
    if (index >= 0) resolutionCleanupResetHooks.splice(index, 1);
    return;
  }
  if (index < 0) resolutionCleanupResetHooks.push(hook);
}

/** 【第十七轮】attemptLineage 的 heap 复位 hook 注册（避免模块循环依赖）。 */
export function registerTreasuryLineageResetHook(hook: (() => void) | null): void {
  const index = lineageResetHooks.indexOf(hook);
  if (hook === null) {
    if (index >= 0) lineageResetHooks.splice(index, 1);
    return;
  }
  if (index < 0) lineageResetHooks.push(hook);
}

/** 仅供测试：清除 Treasury 持久状态（receipts + lifecycle + writeFault + quarantine + resolutions + intents）并失效 heap 缓存。 */
/** test-only：只清 receipt store 的 heap 缓存（模拟 global reset 后的首次
 * trusted 读取——load 校验重走，同 global 的 O(1) 缓存语义不受影响）。 */
export function resetTreasuryReceiptHeapCacheForTest(): void {
  heapStoreRuntime = null;
}

export function clearTreasuryPersistenceForTest(): void {
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithTreasury | undefined)?.treasury;
  if (branch) {
    delete branch.receipts;
    delete branch.lifecycle;
    delete branch.writeFault;
    delete branch.quarantine;
    delete branch.resolutions;
    delete branch.intents;
    delete branch.authorizationFaults;
    // 【第十七轮】durable attempt lineage 一并清理（含 heap 运行态复位）；
    // 【第十八轮】retirement summary 分支一并清理；
    // 【第二十轮】exact generation retirement proof 分支一并清理。
    delete (branch as { attemptLineage?: unknown }).attemptLineage;
    delete (branch as { lineageRetirementSummaries?: unknown }).lineageRetirementSummaries;
    delete (branch as { generationRetirementProofs?: unknown }).generationRetirementProofs;
    // 【Remediation III】cleanup journal 分支一并清理（heap 复位经 hook）。
    delete (branch as { resolutionCleanup?: unknown }).resolutionCleanup;
  }
  heapStoreRuntime = null;
  pendingAdmissions.clear();
  resetTreasuryQuarantineRuntimeForTest();
  resetTreasuryResolutionEventsForTest();
  resetTreasuryIntentRuntimeForTest();
  resetTreasuryAuthorizationFaultRuntimeForTest();
  unsealTreasuryAdapterRegistryForTest();
  resolutionResetHook?.();
  for (const hook of lineageResetHooks) hook();
  for (const hook of resolutionCleanupResetHooks) hook();
  receiptEvents.migrationsExecuted = 0;
  receiptEvents.incompatibleFailures = 0;
  receiptEvents.receiptFullScans = 0;
  receiptEvents.admissionFastPaths = 0;
  receiptEvents.admissionFullStoreBlocked = 0;
  receiptEvents.expiryCleanupScans = 0;
  receiptEvents.receiptEntriesVisited = 0;
  receiptEvents.receiptMigrationScans = 0;
  receiptEvents.receiptLoadValidationEntries = 0;
  receiptEvents.receiptExpiryCleanupEntries = 0;
  receiptEvents.receiptFatalInspectionEntries = 0;
  receiptEvents.receiptRefreshes = 0;
  receiptEvents.receiptLegacyLookups = 0;
  receiptEvents.receiptIdentityMatches = 0;
  receiptEvents.receiptIdentityConflicts = 0;
  receiptEvents.receiptIdentityInsufficient = 0;
  receiptEvents.receiptProofLevelRejections = 0;
}

/** 校验 receipt 键与 transactionId 规范一致（诊断/测试用）。 */
export function isValidTreasuryReceiptKey(transactionId: string): boolean {
  return (
    typeof transactionId === "string" &&
    transactionId.length > 0 &&
    transactionId.length <= TREASURY_TRANSACTION_ID_MAX_LENGTH
  );
}
