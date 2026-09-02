/**
 * Treasury unified unresolved authority（第九轮 4.7 / 第十轮 3.12.1）——
 * 签发、prevalidation、resolution、recovery、release 共用的同一套 authority
 * resolution。
 *
 * 背景（第八轮遗留断链）：capability 签发侧读 quarantine 优先 + intent
 * emergency 兜底，但 fault resolution 只读 quarantine——quarantine 写失败
 * 保留的 emergency intent 无法参与 resolution。本模块归一化两种 durable
 * 权威：
 *
 * - **quarantine 优先**：同 id 双存在且身份一致时视为同一 transaction 的
 *   双形态状态（quarantine 为恢复目标形态，intent 是 emergency 残留），
 *   authority 取 quarantine（contract 绑定事实从 intent 合并——quarantine
 *   entry 无 contract 字段）；
 * - **不一致 fail closed**：同 id 双存在但 digest/postings/kind 任一不一致
 *   → inconsistent（capability 签发与 resolution 均拒绝，不任选其一）；
 * - **intent-only**：quarantine 写失败时 intent 是唯一权威（emergency
 *   intent authority）——完整参与 capability 签发与 resolution；
 * - **execution outcome 权威**（第十轮）：intent 来源直接携带 v3 outcome；
 *   quarantine v1 来源从 write-fault phase 单调推导（commit 类 → returned_ok
 *   ——永不允许 not-executed；action_returned_non_ok_abort_failed →
 *   returned_non_ok；其余 execution-unknown 类 → started_unknown）；
 *   not-executed 允许性按 outcome 判定，不再按混合 phase 字符串猜测。
 *
 * 【第十六轮第六节】双 authority 归一化在 immutable identity 之上新增
 * execution-fact cohesion（唯一权威：executionFactCohesion.ts）——outcome /
 * settlement / phase 组合不兼容 → inconsistent（零释放、两份 authority 全
 * 保留）；归一化 authority 的 execution facts 经明确合并规则（outcome=共同
 * 值、settlement=更进展一方、phase=quarantine 权威）。
 *
 * 【第十六轮第八节】resolver 区分 not_found 与 store_unhealthy：readEntry
 * 返回 undefined 既可能是"entry 不存在"也可能是"store fatal"——本模块先
 * 检查两个 store 的 health（对已存在 store 触发必要 load validation），只有
 * 两个 store 均可信且都确实无 entry 时才返回 not_found；任一 store fatal →
 * store_unhealthy（零 release / 零 refresh / 零 marker clear / 零 stage 变化 /
 * 零 reconciler，绝不折叠成 not_found，也绝不选 healthy 一侧）。
 */

import {
  ensureTreasuryQuarantineStoreValidated,
  peekTreasuryQuarantineHealth,
  peekTreasuryQuarantineStore,
  readTreasuryQuarantineEntry,
} from "@/runtime/treasury/quarantine";
import {
  ensureTreasuryIntentStoreValidated,
  peekTreasuryIntentStore,
  readTreasuryIntentEntry,
} from "@/runtime/treasury/intents";
import { verifyTreasuryEntryIdentity, type TreasuryIdentityFactsEntry } from "@/runtime/treasury/identityProof";
import { treasuryAuthorityLevelPairCompatibility } from "@/runtime/treasury/authorityCompatibility";
import { compareTreasuryExecutionFactCohesion } from "@/runtime/treasury/executionFactCohesion";
import {
  treasuryLineageProofOfEntry,
  treasuryLineageProofRelation,
  treasuryLineageProofShapeErrorForTransaction,
  type TreasuryLineageProofFacts,
} from "@/runtime/treasury/lineageProof";
import {
  validateTreasurySemanticLineage,
  describeTreasurySemanticLineageVerdict,
} from "@/runtime/treasury/semanticLineageValidation";

/** 归一化 authority facts（签发/resolution/recovery/release 共用形状）。 */
export interface TreasuryUnresolvedAuthority {
  readonly authorityKind: "quarantine" | "intent";
  readonly transactionId: string;
  readonly digest: string;
  readonly kind: string;
  readonly actionKind: string;
  /** quarantine write-fault phase 或 intent settlement（诊断；判定权威在 outcome）。 */
  readonly phase: string;
  /** execution outcome（事实等级；not-executed 允许性的唯一判定依据）。 */
  readonly outcome: string;
  /** settlement workflow state（intent 来源必填；quarantine 来源为推导值）。 */
  readonly settlement: string;
  readonly recordedAt: number;
  /** 原 action tick（quarantine.tick / intent.createdAtTick——审计与 tombstone 用）。 */
  readonly actionTick: number;
  readonly postings: readonly { roomName: string; locationKind: string; resource: string; delta: number }[];
  readonly contractId?: string;
  readonly contractDigest?: string;
  readonly adapterVersion?: number;
  readonly durablePayload?: string;
  readonly durablePayloadVersion?: number;
  /** authorization bundle digest（quarantine v2/intent contract 路径）。 */
  readonly authorizationDigest?: string;
  /** canonical authorization cohort digest（第十一轮 3.13.4）。 */
  readonly authorizationCohortDigest?: string;
  /** 统一 durable action identity digest（第十一轮 3.13.5）。 */
  readonly durableIdentityDigest?: string;
  /** 完整 structure descriptors（第十一轮 3.13.9；reconciler 输入）。 */
  readonly structureFacts?: readonly { readonly [key: string]: unknown }[];
  /** 【第十三轮】显式 authority 等级（modern/legacy/forensic/lowlevel）。 */
  readonly authorityLevel?: string;
  /** 【第十六轮第十一节】lowlevel provenance（attempt identity 的组成部分——proof 链绑定）。 */
  readonly lowlevelSource?: string;
  /** legacy v1 quarantine 标记（第十一轮 3.13.7：隔离诊断用）。 */
  readonly legacyV1?: boolean;
  /** 稳定 adapter/reconciler 语义身份（第十二轮 3.5；缺省 = 无法验证语义一致性）。 */
  readonly adapterSemanticIdentity?: string;
  /** forensic incomplete authority 标记（第十二轮 3.8）。 */
  readonly forensic?: { readonly reason: string; readonly detail: string };
  /**
   * 【第十九轮 A.1】lineage proof（tr1_ rearm authority 必携带完整四字段；
   * initial attempt 不携带——形状由 resolver 从两侧持久事实验证，缺字段/
   * 单侧缺失/双侧不一致均 fail closed，不静默选择一侧）。
   */
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
}

export type TreasuryUnresolvedAuthorityResolution =
  | { readonly status: "ok"; readonly authority: TreasuryUnresolvedAuthority }
  | { readonly status: "not_found" }
  | { readonly status: "inconsistent"; readonly detail: string }
  | {
      /** 【第十六轮第八节】intent/quarantine store fatal——不得折叠成 not_found。 */
      readonly status: "store_unhealthy";
      readonly detail: string;
      readonly quarantineStoreError?: string;
      readonly intentStoreError?: string;
    };

/**
 * quarantine v1 write-fault phase → execution outcome 的单调推导（第十轮
 * 3.12.1）：commit 类 phase 全部发生在 Game callback 已确认 OK 之后 →
 * returned_ok；Game 已明确返回非 OK → returned_non_ok；其余 execution-
 * unknown 类 → started_unknown。
 */

function postingSignature(postings: readonly { roomName: string; locationKind: string; resource: string; delta: number }[]): string {
  return [...postings]
    .map((leg) => `${leg.roomName}\u0000${leg.locationKind}\u0000${leg.resource}\u0000${String(leg.delta)}`)
    .sort()
    .join("\u0001");
}

/**
 * 【第十九轮 A.1】authority entry 相对其 transactionId 的 lineage proof 形状
 * 验证（tr1_ 必须完整、initial 必须全缺失——lineageProof 单一权威）。返回
 * null = 形状合法（facts 或合法的 undefined）。
 */
function authorityLineageFactsError(
  transactionId: string,
  entry: {
    readonly transactionId: string;
    readonly lineageId?: unknown;
    readonly lineageGeneration?: unknown;
    readonly parentTransactionId?: unknown;
    readonly lineageBindingDigest?: unknown;
  },
  label: string,
): string | null {
  return treasuryLineageProofShapeErrorForTransaction(transactionId, entry, label);
}

/** 归一化 authority 的 lineage proof 字段展开（facts 存在时透传）。 */
function lineageProofSpread(facts: TreasuryLineageProofFacts | undefined): { readonly lineageId?: string; readonly lineageGeneration?: number; readonly parentTransactionId?: string; readonly lineageBindingDigest?: string } {
  return facts === undefined
    ? {}
    : {
        lineageId: facts.lineageId,
        lineageGeneration: facts.lineageGeneration,
        parentTransactionId: facts.parentTransactionId,
        lineageBindingDigest: facts.lineageBindingDigest,
      };
}

/**
 * 【第二十轮 16.8】tr1_ 归一化 authority 的 semantic lineage gate（三个
 * ok 返回路径共用）：child ID 内嵌 lineage/generation、确定性 parent 派生、
 * binding 权威重算、active lineage / terminal authority 状态相容性全部
 * 重算验证。shape proof（四字段在两侧一致复制）不构成语义证明——一致
 * 复制的错误事实必须在此拦截：
 * - semantic conflict / insufficient(legacy isolated) / no_authority →
 *   inconsistent（fail closed——capability 不签发、resolution 阻断）；
 * - semantic store_unhealthy（lineage/summary/exact retirement store）→
 *   store_unhealthy（零 release / 零 refresh / 零结论）。
 * 非 tr1_ authority 不经本 gate（initial attempt 无 lineage 语义域）。
 */
function semanticGateOfAuthority(
  authority: TreasuryUnresolvedAuthority,
): TreasuryUnresolvedAuthorityResolution | null {
  if (authority.lineageId === undefined) return null;
  const semantic = validateTreasurySemanticLineage({
    transactionId: authority.transactionId,
    proof: {
      lineageId: authority.lineageId,
      lineageGeneration: authority.lineageGeneration!,
      parentTransactionId: authority.parentTransactionId!,
      lineageBindingDigest: authority.lineageBindingDigest!,
    },
    purpose: "authority_resolution",
    identity: {
      digest: authority.digest,
      ...(authority.contractDigest !== undefined ? { contractDigest: authority.contractDigest } : {}),
      ...(authority.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: authority.authorizationCohortDigest } : {}),
      ...(authority.durableIdentityDigest !== undefined ? { durableIdentityDigest: authority.durableIdentityDigest } : {}),
      ...(authority.lowlevelSource !== undefined ? { lowlevelSource: authority.lowlevelSource } : {}),
    },
  });
  if (semantic.verdict === "match") return null;
  if (semantic.verdict === "store_unhealthy") {
    return {
      status: "store_unhealthy",
      detail: `tr1_ authority 的 semantic lineage 验证 store unhealthy（${semantic.detail}）——零 release/refresh/marker-clear/stage 变化`,
    };
  }
  return {
    status: "inconsistent",
    detail: `tr1_ authority 的 semantic lineage validation 未通过（${describeTreasurySemanticLineageVerdict(semantic)}）——一致复制的四字段不是语义证明，fail closed`,
  };
}

/**
 * 【第十六轮第八节】store health 感知读取前置：对已存在的 store 触发必要
 * load validation 并返回 fatal 描述（null = 可信或 store 不存在）。store 不
 * 存在 = 合法的"无 entry"来源（查询路径零写、不隐式创建 store），不算
 * unhealthy。
 */
function quarantineStoreError(): string | undefined {
  if (peekTreasuryQuarantineStore() === undefined) return undefined;
  const fatal = ensureTreasuryQuarantineStoreValidated();
  if (fatal !== null) return fatal;
  return peekTreasuryQuarantineHealth().healthy ? undefined : (peekTreasuryQuarantineHealth().detail ?? "quarantine store 损坏");
}

function intentStoreError(): string | undefined {
  if (peekTreasuryIntentStore() === undefined) return undefined;
  const fatal = ensureTreasuryIntentStoreValidated();
  return fatal ?? undefined;
}

/**
 * 解析 transactionId 的 unresolved authority（唯一入口——capability 签发
 * 与 faultResolution 的 prevalidate 均经本函数）：
 * - store health 前置（第十六轮）：任一已存在 store fatal → store_unhealthy
 *   （附各 store 有界诊断），零副作用；
 * - 同 id 双存在【第十四轮第八节 / 第十六轮第六节】：
 *   1. 先分别独立验证：shape/等级矩阵（read 路径 load 校验承载）+ 各自从
 *      持久事实重算 identity（verifyTreasuryEntryIdentity）——任一失败 →
 *      inconsistent（不任选另一条）；
 *   2. 显式比较 authorityLevel：**任何跨等级组合（modern+legacy /
 *      modern+lowlevel / modern+forensic / lowlevel+legacy / lowlevel+
 *      forensic …）→ inconsistent fail closed**；同等级才继续；
 *   3. modern+modern：完整 durable identity 一致（durableIdentityDigest、
 *      authorizationCohortDigest 双方完整存在且相等——一方缺失即
 *      inconsistent，不退回 optional 字段子集比较）、contractId/
 *      contractDigest、adapterSemanticIdentity、digest/kind/postings 全等；
 *   4. lowlevel+lowlevel：digest/kind/postings/durableIdentityDigest 严格
 *      比较 + lowlevelSource 一致（runtime 与 migrated 不能互相归一）；
 *      legacy+legacy：digest/kind/postings 受控比较；forensic+forensic：
 *      同一隔离记录（digest/kind/postings）才可合并；
 *   5. execution-fact cohesion（第十六轮）：outcome 对等 + phase/settlement
 *      workflow 矩阵——不兼容 → inconsistent（两份全保留，绝不"选择更强
 *      事实"掩盖持久记录不一致）；
 *   6. 全部一致 → quarantine 优先（contract 绑定事实从 intent 合并；execution
 *      facts 经 cohesion 明确合并规则——outcome=共同值、settlement=更进展
 *      一方、phase=quarantine 权威）；
 * - 单一存在：直接使用（identity 重算失败 → inconsistent）；均无：not_found。
 */
export function resolveTreasuryUnresolvedAuthority(transactionId: string): TreasuryUnresolvedAuthorityResolution {
  const quarantineError = quarantineStoreError();
  const intentError = intentStoreError();
  if (quarantineError !== undefined || intentError !== undefined) {
    return {
      status: "store_unhealthy",
      detail: `unresolved authority store unhealthy（quarantine: ${quarantineError ?? "ok"}；intent: ${intentError ?? "ok"}）——零 release/refresh/marker-clear/stage 变化`,
      ...(quarantineError !== undefined ? { quarantineStoreError: quarantineError } : {}),
      ...(intentError !== undefined ? { intentStoreError: intentError } : {}),
    };
  }
  const quarantined = readTreasuryQuarantineEntry(transactionId);
  const intended = readTreasuryIntentEntry(transactionId);
  if (quarantined === undefined && intended === undefined) {
    return { status: "not_found" };
  }
  if (quarantined !== undefined && intended !== undefined) {
    // 【第十四轮 8.1】先独立验证：任一 authority 的 identity 无法从持久
    // 事实重算 → 整体 inconsistent（durable digest 字符串相同也不信任）。
    const quarantineIdentityError = verifyTreasuryEntryIdentity(
      quarantined as unknown as TreasuryIdentityFactsEntry,
      `quarantine authority（${quarantined.transactionId.slice(0, 48)}）`,
    );
    if (quarantineIdentityError !== null) {
      return { status: "inconsistent", detail: quarantineIdentityError };
    }
    const intentIdentityError = verifyTreasuryEntryIdentity(
      intended as unknown as TreasuryIdentityFactsEntry,
      `intent authority（${intended.transactionId.slice(0, 48)}）`,
    );
    if (intentIdentityError !== null) {
      return { status: "inconsistent", detail: intentIdentityError };
    }
    // 【第十四轮 8.2】显式 authority-level 兼容矩阵：跨等级双 authority 一律
    // inconsistent——modern authority 永不被低等级并存记录合并/替代。
    const levelCompatibility = treasuryAuthorityLevelPairCompatibility(quarantined.authorityLevel, intended.authorityLevel);
    if (levelCompatibility === "incompatible") {
      return {
        status: "inconsistent",
        detail: `同 id 双权威 authorityLevel 跨等级（quarantine ${String(quarantined.authorityLevel)}，intent ${String(intended.authorityLevel)}）——inconsistent fail closed，不任选其一`,
      };
    }
    if (quarantined.digest !== intended.digest) {
      return {
        status: "inconsistent",
        detail: `同 id 双权威 digest 不一致（quarantine ${quarantined.digest}，intent ${intended.digest}）——fail closed，不任选其一`,
      };
    }
    if (quarantined.kind !== intended.kind) {
      return {
        status: "inconsistent",
        detail: `同 id 双权威 kind 不一致（quarantine ${quarantined.kind}，intent ${intended.kind}）——fail closed`,
      };
    }
    if (postingSignature(quarantined.deltas) !== postingSignature(intended.postings)) {
      return {
        status: "inconsistent",
        detail: "同 id 双权威 postings 不一致（canonical 逐腿比较）——fail closed，不任选其一",
      };
    }
    // 【第十九轮 A.1】lineage proof 双侧验证：先各自相对 transactionId 做
    // 形状验证（tr1_ 必须完整、initial 必须全缺失——一侧有一侧无或部分
    // 存在都是不可归一化的持久矛盾）；双侧完整时四字段必须完全一致。
    const quarantineLineageError = authorityLineageFactsError(
      quarantined.transactionId,
      quarantined as unknown as Parameters<typeof authorityLineageFactsError>[1],
      "quarantine authority",
    );
    if (quarantineLineageError !== null) {
      return { status: "inconsistent", detail: quarantineLineageError };
    }
    const intentLineageError = authorityLineageFactsError(
      intended.transactionId,
      intended as unknown as Parameters<typeof authorityLineageFactsError>[1],
      "intent authority",
    );
    if (intentLineageError !== null) {
      return { status: "inconsistent", detail: intentLineageError };
    }
    const quarantineLineage = treasuryLineageProofOfEntry(quarantined as unknown as Parameters<typeof treasuryLineageProofOfEntry>[0]);
    const intentLineage = treasuryLineageProofOfEntry(intended as unknown as Parameters<typeof treasuryLineageProofOfEntry>[0]);
    if (quarantineLineage === "partial" || intentLineage === "partial") {
      return { status: "inconsistent", detail: "同 id 双权威的 lineage proof 形状异常（部分存在——不可归一化）" };
    }
    if ((quarantineLineage !== undefined) !== (intentLineage !== undefined)) {
      return {
        status: "inconsistent",
        detail: `同 id 双权威 lineage proof 单侧缺失（quarantine ${quarantineLineage !== undefined ? "携带" : "缺失"}，intent ${intentLineage !== undefined ? "携带" : "缺失"}）——不得静默选择其中一侧`,
      };
    }
    if (quarantineLineage !== undefined && intentLineage !== undefined && treasuryLineageProofRelation(intentLineage, quarantineLineage) !== "match") {
      return {
        status: "inconsistent",
        detail: "同 id 双权威 lineage proof 不一致（lineageId/generation/parent/binding 任一不同——fail closed，不任选其一）",
      };
    }
    const sharedLevel = quarantined.authorityLevel;
    if (sharedLevel === "modern") {
      // 【第十四轮 8.3】modern 双 authority：完整 durable identity 一致——
      // cohort digest 与 durable identity digest 双方**完整存在**且相等（一方
      // 缺失即 inconsistent——不退回 optional 字段子集比较）；contract
      // identity 与 adapter semantic identity 也必须一致。
      if (quarantined.durableIdentityDigest === undefined || intended.durableIdentityDigest === undefined) {
        return {
          status: "inconsistent",
          detail: "modern 双权威 durableIdentityDigest 不完整（一方缺失即 identity 不可证明）——fail closed",
        };
      }
      if (quarantined.durableIdentityDigest !== intended.durableIdentityDigest) {
        return {
          status: "inconsistent",
          detail: `同 id 双权威 durable identity 不一致（quarantine ${quarantined.durableIdentityDigest.slice(0, 16)}，intent ${intended.durableIdentityDigest.slice(0, 16)}）——fail closed`,
        };
      }
      const cohortPairConsistent =
        quarantined.authorizationCohortDigest !== undefined &&
        intended.authorizationCohortDigest !== undefined &&
        quarantined.authorizationCohortDigest === intended.authorizationCohortDigest;
      if (!cohortPairConsistent) {
        return {
          status: "inconsistent",
          detail: "modern 双权威 authorizationCohortDigest 不完整或不一致（完整 cohort identity 必须双方存在且相等）——fail closed",
        };
      }
      if ((quarantined.contractId ?? undefined) !== (intended.contractId ?? undefined)) {
        return { status: "inconsistent", detail: "modern 双权威 contractId 不一致（含一方缺失）——fail closed" };
      }
      if ((quarantined.contractDigest ?? undefined) !== (intended.contractDigest ?? undefined)) {
        return { status: "inconsistent", detail: "modern 双权威 contractDigest 不一致（含一方缺失）——fail closed" };
      }
      if ((quarantined.adapterSemanticIdentity ?? undefined) !== (intended.adapterSemanticIdentity ?? undefined)) {
        return { status: "inconsistent", detail: "modern 双权威 adapterSemanticIdentity 不一致（含一方缺失）——fail closed" };
      }
    } else if (sharedLevel === "lowlevel") {
      // 【第十四轮 8.2】低层双 authority：严格低层 identity（durable 双方
      // 完整存在且相等）——低层矩阵保证 durableIdentityDigest 存在，缺失即
      // 损坏形态。【第二十轮 7.2】contract/cohort 维度同样必须一致（低层
      // contractless 语义下一方携带 modern 字段即双权威形态矛盾——
      // handoff 的完整 identity 冲突不得被 lineage 外壳相同掩盖）。
      if (
        quarantined.durableIdentityDigest === undefined ||
        intended.durableIdentityDigest === undefined ||
        quarantined.durableIdentityDigest !== intended.durableIdentityDigest
      ) {
        return {
          status: "inconsistent",
          detail: "lowlevel 双权威 durableIdentityDigest 不完整或不一致——fail closed",
        };
      }
      if ((quarantined.contractDigest ?? undefined) !== (intended.contractDigest ?? undefined)) {
        return { status: "inconsistent", detail: "lowlevel 双权威 contractDigest 不一致（contractless 语义下双权威形态矛盾）——fail closed" };
      }
      if ((quarantined.authorizationCohortDigest ?? undefined) !== (intended.authorizationCohortDigest ?? undefined)) {
        return { status: "inconsistent", detail: "lowlevel 双权威 authorizationCohortDigest 不一致——fail closed" };
      }
    }
    // 【第十六轮第六节】execution-fact cohesion：immutable identity 相同不
    // 代表 execution facts 自动相同——outcome 对等 + workflow/phase 矩阵
    // 全部成立才允许归一化（returned_ok 永不被 started_unknown 覆盖）。
    const cohesion = compareTreasuryExecutionFactCohesion({
      quarantine: {
        outcome: quarantined.outcome,
        settlement: quarantined.settlement,
        phase: quarantined.phase,
      },
      intent: {
        outcome: intended.outcome,
        settlement: intended.settlement,
      },
    });
    if (cohesion.status === "inconsistent") {
      return { status: "inconsistent", detail: `同 id 双权威 execution fact 不一致: ${cohesion.detail}` };
    }
    const mergedFacts = cohesion.merged;
    const normalizedAuthority: TreasuryUnresolvedAuthority = {
      authorityKind: "quarantine",
      transactionId: quarantined.transactionId,
      digest: quarantined.digest,
      kind: quarantined.kind,
      actionKind: quarantined.actionKind ?? quarantined.kind,
      phase: mergedFacts.phase,
      outcome: mergedFacts.outcome,
      settlement: mergedFacts.settlement,
      recordedAt: quarantined.recordedAt,
      actionTick: quarantined.tick,
      postings: quarantined.deltas.map((leg) => ({ ...leg })),
      ...(quarantined.contractId !== undefined ? { contractId: quarantined.contractId } : {}),
      ...(quarantined.contractDigest !== undefined ? { contractDigest: quarantined.contractDigest } : {}),
      ...(quarantined.adapterVersion !== undefined ? { adapterVersion: quarantined.adapterVersion } : {}),
      ...(quarantined.durablePayload !== undefined ? { durablePayload: quarantined.durablePayload } : {}),
      ...(quarantined.durablePayloadVersion !== undefined ? { durablePayloadVersion: quarantined.durablePayloadVersion } : {}),
      ...(quarantined.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: quarantined.authorizationCohortDigest } : {}),
      ...(quarantined.durableIdentityDigest !== undefined ? { durableIdentityDigest: quarantined.durableIdentityDigest } : {}),
      ...(quarantined.authorizationDigest !== undefined ? { authorizationDigest: quarantined.authorizationDigest } : {}),
      ...(quarantined.structureFacts !== undefined
        ? { structureFacts: quarantined.structureFacts.map((fact) => ({ ...fact }) as { readonly [key: string]: unknown }) }
        : {}),
      ...(quarantined.authorityLevel !== undefined ? { authorityLevel: quarantined.authorityLevel } : {}),
      ...(quarantined.lowlevelSource !== undefined ? { lowlevelSource: quarantined.lowlevelSource } : {}),
      ...(quarantined.legacyV1 !== undefined ? { legacyV1: quarantined.legacyV1 } : {}),
      ...(quarantined.adapterSemanticIdentity !== undefined ? { adapterSemanticIdentity: quarantined.adapterSemanticIdentity } : {}),
      ...(quarantined.forensic !== undefined ? { forensic: { ...quarantined.forensic } } : {}),
      ...lineageProofSpread(quarantineLineage),
    };
    // legacy+legacy：digest/kind/postings 受控比较（上文已完成）；forensic+
    // forensic：同一隔离记录（digest/kind/postings 相同）——上文完成。
    // 【第二十轮 16.8】tr1_ 归一化 authority 的 semantic lineage gate。
    const mergedSemanticGate = semanticGateOfAuthority(normalizedAuthority);
    if (mergedSemanticGate !== null) return mergedSemanticGate;
    return { status: "ok", authority: normalizedAuthority };
  }
  if (quarantined !== undefined) {
    // 【第十二轮 3.6】authority 事实身份重算：digest 必须能由持久事实重算
    // 一致——不一致 = authority inconsistent（fail closed）。
    const quarantineIdentityError = verifyTreasuryEntryIdentity(quarantined as unknown as TreasuryIdentityFactsEntry, `quarantine authority（${quarantined.transactionId.slice(0, 48)}）`);
    if (quarantineIdentityError !== null) {
      return { status: "inconsistent", detail: quarantineIdentityError };
    }
    // 【第十九轮 A.1】单侧 authority 的 lineage proof 同样经持久事实验证
    //（tr1_ 缺完整 proof 不得归一化为可签发 authority）。
    const quarantineOnlyLineageError = authorityLineageFactsError(
      quarantined.transactionId,
      quarantined as unknown as Parameters<typeof authorityLineageFactsError>[1],
      "quarantine authority",
    );
    if (quarantineOnlyLineageError !== null) {
      return { status: "inconsistent", detail: quarantineOnlyLineageError };
    }
    const quarantineOnlyLineage = treasuryLineageProofOfEntry(quarantined as unknown as Parameters<typeof treasuryLineageProofOfEntry>[0]);
    if (quarantineOnlyLineage === "partial") {
      return { status: "inconsistent", detail: "quarantine authority 的 lineage proof 部分存在（形状异常——fail closed）" };
    }
    // quarantine 优先（v2 自带完整合同事实；并存 intent 时以 quarantine 为
    // 权威形态，intent 的同名字段已在上文比对）。
    const normalizedAuthority: TreasuryUnresolvedAuthority = {
      authorityKind: "quarantine",
      transactionId: quarantined.transactionId,
      digest: quarantined.digest,
      kind: quarantined.kind,
      actionKind: quarantined.actionKind ?? quarantined.kind,
      phase: quarantined.phase,
      outcome: quarantined.outcome,
      settlement: quarantined.settlement,
      recordedAt: quarantined.recordedAt,
      actionTick: quarantined.tick,
      postings: quarantined.deltas.map((leg) => ({ ...leg })),
      ...(quarantined.contractId !== undefined ? { contractId: quarantined.contractId } : {}),
      ...(quarantined.contractDigest !== undefined ? { contractDigest: quarantined.contractDigest } : {}),
      ...(quarantined.adapterVersion !== undefined ? { adapterVersion: quarantined.adapterVersion } : {}),
      ...(quarantined.durablePayload !== undefined ? { durablePayload: quarantined.durablePayload } : {}),
      ...(quarantined.durablePayloadVersion !== undefined ? { durablePayloadVersion: quarantined.durablePayloadVersion } : {}),
      ...(quarantined.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: quarantined.authorizationCohortDigest } : {}),
      ...(quarantined.durableIdentityDigest !== undefined ? { durableIdentityDigest: quarantined.durableIdentityDigest } : {}),
      ...(quarantined.authorizationDigest !== undefined ? { authorizationDigest: quarantined.authorizationDigest } : {}),
      ...(quarantined.structureFacts !== undefined
        ? { structureFacts: quarantined.structureFacts.map((fact) => ({ ...fact }) as { readonly [key: string]: unknown }) }
        : {}),
      ...(quarantined.authorityLevel !== undefined ? { authorityLevel: quarantined.authorityLevel } : {}),
      ...(quarantined.lowlevelSource !== undefined ? { lowlevelSource: quarantined.lowlevelSource } : {}),
      ...(quarantined.legacyV1 !== undefined ? { legacyV1: quarantined.legacyV1 } : {}),
      ...(quarantined.adapterSemanticIdentity !== undefined ? { adapterSemanticIdentity: quarantined.adapterSemanticIdentity } : {}),
      ...(quarantined.forensic !== undefined ? { forensic: { ...quarantined.forensic } } : {}),
      ...lineageProofSpread(quarantineOnlyLineage),
    };
    // 【第二十轮 16.8】tr1_ 归一化 authority 的 semantic lineage gate。
    const quarantineOnlySemanticGate = semanticGateOfAuthority(normalizedAuthority);
    if (quarantineOnlySemanticGate !== null) return quarantineOnlySemanticGate;
    return { status: "ok", authority: normalizedAuthority };
  }
  // intent-only（emergency authority）：完整参与签发与 resolution。
  const intent = intended as NonNullable<typeof intended>;
  const intentIdentityError = verifyTreasuryEntryIdentity(intent as unknown as TreasuryIdentityFactsEntry, `intent authority（${intent.transactionId.slice(0, 48)}）`);
  if (intentIdentityError !== null) {
    return { status: "inconsistent", detail: intentIdentityError };
  }
  // 【第十九轮 A.1】单侧 emergency authority 的 lineage proof 持久事实验证。
  const intentOnlyLineageError = authorityLineageFactsError(
    intent.transactionId,
    intent as unknown as Parameters<typeof authorityLineageFactsError>[1],
    "intent authority",
  );
  if (intentOnlyLineageError !== null) {
    return { status: "inconsistent", detail: intentOnlyLineageError };
  }
  const intentLineageFacts = treasuryLineageProofOfEntry(intent as unknown as Parameters<typeof treasuryLineageProofOfEntry>[0]);
  if (intentLineageFacts === "partial") {
    return { status: "inconsistent", detail: "intent authority 的 lineage proof 部分存在（形状异常——fail closed）" };
  }
  const normalizedAuthority: TreasuryUnresolvedAuthority = {
    authorityKind: "intent",
    transactionId: intent.transactionId,
    digest: intent.digest,
    kind: intent.kind,
    actionKind: intent.actionKind,
    phase: intent.settlement,
    outcome: intent.outcome,
    settlement: intent.settlement,
    recordedAt: intent.updatedAtTick,
    actionTick: intent.createdAtTick,
    postings: intent.postings.map((leg) => ({ ...leg })),
      ...(intent.contractId !== undefined ? { contractId: intent.contractId } : {}),
      ...(intent.contractDigest !== undefined ? { contractDigest: intent.contractDigest } : {}),
      ...(intent.adapterVersion !== undefined ? { adapterVersion: intent.adapterVersion } : {}),
      ...(intent.durablePayload !== undefined ? { durablePayload: intent.durablePayload } : {}),
      ...(intent.durablePayloadVersion !== undefined ? { durablePayloadVersion: intent.durablePayloadVersion } : {}),
      ...(intent.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: intent.authorizationCohortDigest } : {}),
      ...(intent.durableIdentityDigest !== undefined ? { durableIdentityDigest: intent.durableIdentityDigest } : {}),
      ...(intent.authorizationDigest !== undefined ? { authorizationDigest: intent.authorizationDigest } : {}),
      ...(intent.structureFacts !== undefined
        ? { structureFacts: intent.structureFacts.map((fact) => ({ ...fact }) as { readonly [key: string]: unknown }) }
        : {}),
      ...(intent.adapterSemanticIdentity !== undefined ? { adapterSemanticIdentity: intent.adapterSemanticIdentity } : {}),
      ...(intent.authorityLevel !== undefined ? { authorityLevel: intent.authorityLevel } : {}),
      ...(intent.lowlevelSource !== undefined ? { lowlevelSource: intent.lowlevelSource } : {}),
      ...lineageProofSpread(intentLineageFacts),
  };
  // 【第二十轮 16.8】tr1_ 归一化 authority 的 semantic lineage gate。
  const intentOnlySemanticGate = semanticGateOfAuthority(normalizedAuthority);
  if (intentOnlySemanticGate !== null) return intentOnlySemanticGate;
  return { status: "ok", authority: normalizedAuthority };
}

/**
 * not-executed resolution 允许性（第十轮 3.12.1——按 execution outcome 事实
 * 等级判定，不再按混合 phase 字符串猜测）：
 * - returned_ok：已知 Game 返回 OK——永不允许 not-executed（事实单调）；
 * - started_unknown：副作用未知——允许（配合显式 post-observation 证据）；
 * - returned_non_ok：Game 已明确返回非 OK（动作未生效）——允许；
 * - not_started / aborted_final：不应出现在 unresolved authority（恢复路径
 *   直接释放）；防御性拒绝。
 */
export function isTreasuryUnresolvedAuthorityNotExecutable(authority: TreasuryUnresolvedAuthority): boolean {
  return authority.outcome === "started_unknown" || authority.outcome === "returned_non_ok";
}
