/**
 * 【Round 22 Remediation VII 修复一 / VIII 工作流 B+C】durable settlement
 * authority 的统一 reconciliation——historical / compressed completion /
 * chain certificate / retired range 进入全局事务真相的唯一语义入口。
 *
 * Remediation VII 建立了单一 resolver，但它是**顺序 first-match 短路**
 * （live → historical → certificate → range，命中即返回）。Remediation
 * VIII 升级为真正的统一 reconciliation：
 *
 * 1. **收集全部声明再裁决**——不因前面找到 match 而跳过后面的冲突或
 *    unhealthy（S1/S2/S3：live committed vs historical not-executed =
 *    conflict；live match 不遮蔽后方 store corruption；historical 与
 *    certificate 相反结论 = conflict）；
 * 2. **exact 与 protocol-derived 区分**——live/historical completion 携带
 *    完整 exact identity（digest/profile/proofClass/durable digest/
 *    lowlevelSource），可共同证明 exact；chain certificate 只有协议推导
 *    outcome（root/final/中间代的确定性映射），identity 不足——返回
 *    `protocol`（重放阻断/occupancy/opposite proof 可用；marker
 *    discharge、authority release、cleanup completion、resolution
 *    relabel 等 destructive 路径不得使用）；
 * 3. **retired / anti-reuse-only 单独成态**——retired range 只证明"已
 *    退休、不得重放"，不携带 outcome，不升级成 exact/protocol；
 * 4. **expectedOutcome / expected identity 由全部声明共同验证**——任一
 *    声明相反 outcome → conflict；exact 声明之间 identity 不一致 →
 *    conflict（不选边、不忽略）。
 *
 * chain certificate 的 outcome 语义（工作流 C）：
 *  - finalGeneration = 0：chain_committed → root committed；
 *    non_rearmable_retired → root not-executed；
 *  - finalGeneration ≥ 1（chain_committed）：root 与全部中间代
 *    not-executed，finalGeneration committed；
 *  - finalGeneration ≥ 1（non_rearmable_retired）：root 到 final 全部
 *    not-executed。
 *
 * 另提供 `resolveTreasuryCleanupCompletionAuthority`（B3）：cleanup
 * **完成**（五阶段 + journal 删除）的权威解析——只有 live completion
 * （matching、exact）与 historical completion（显式 supersession 接管
 * cleanup-complete 事实）能证明；chain certificate / retired range 只证明
 * settlement outcome，不证明 marker discharge / authority release /
 * outcome finalization / lineage finalization / journal deletion——不得
 * 据此判定 cleanup completed。
 *
 * 本模块只读（query 零写）；单条 shape 复验由各底层 authority 承载
 * （load 全表 + lookup 单条防御性复验 + certificate canonical 关系验证）。
 * 安全关键模块不得绕过本模块直接拼装 historical/certificate/range
 * truth graph（架构测试守护）。
 */

import {
  lookupTreasuryCleanupCompletion,
  peekTreasuryCleanupCompletionHealth,
} from "@/runtime/treasury/cleanupCompletionAuthority";
import {
  lookupTreasuryHistoricalCompletion,
  peekTreasuryCleanupSupersessionHealth,
} from "@/runtime/treasury/cleanupSupersessionAuthority";
import {
  lookupTreasuryChainRetirementRootOutcome,
  lookupTreasuryChainRetirementGenerationOutcome,
  peekTreasuryChainRetirementCertificateHealth,
  checkTreasuryAttemptRetiredRange,
  peekTreasuryRetiredRangeHealth,
} from "@/runtime/treasury/chainRetirementCertificate";
import { isTreasuryRearmAttemptId } from "@/runtime/treasury/transactionId";
import { treasuryExactAttemptIdentityRelation, type TreasuryExactAttemptIdentity } from "@/runtime/treasury/exactAttemptIdentity";

/** durable settlement 权威来源（报告/诊断用——接线方不得按来源选边）。 */
export type TreasuryDurableSettlementSource =
  | "live-completion"
  | "historical-completion"
  | "chain-certificate";

export type TreasuryDurableSettlementResolution =
  | {
      /** 可验证完整 exact identity 的持久结算权威（live/historical completion——outcome 绑定，不可 relabel）。 */
      readonly status: "exact";
      readonly outcome: "committed" | "not-executed";
      readonly source: TreasuryDurableSettlementSource;
      /** 权威携带的完整 exact identity（expected 验证的透明化事实）。 */
      readonly identity: TreasuryExactAttemptIdentity;
      /** 完成事实的记录 tick（live=completedAtTick / historical=archivedAtTick）。 */
      readonly recordedAtTick?: number;
      readonly detail: string;
    }
  | {
      /**
       * 协议推导 outcome（chain certificate——root/final/中间代的确定性
       * 映射）。identity 不足：可用于重放阻断 / occupancy / opposite
       * proof；不得进入 destructive exact-proof 路径（marker discharge /
       * authority release / cleanup completion / resolution relabel）。
       */
      readonly status: "protocol";
      readonly outcome: "committed" | "not-executed";
      readonly source: "chain-certificate";
      readonly recordedAtTick?: number;
      readonly detail: string;
    }
  | {
      /** ID 已退休（chain 压缩 / retired range）——anti-reuse-only：重放一律拒绝，不携带 outcome，不升级 exact/protocol。 */
      readonly status: "retired";
      readonly source: "chain-certificate" | "retired-range";
      readonly detail: string;
    }
  | {
      /**
       * 【IX 工作流 F / 9.2】存在 exact 声明但 identity 维度不足——两个
       * exact declaration 只有 relation=match 才可共同证明 exact；expected
       * 验证维度不足同样 insufficient。语义：
       *  - replay gate：视为已出现/不可执行 blocker（S15——callback 零调用），
       *    但不得 release Authority；
       *  - destructive caller（marker discharge / authority release /
       *    cleanup completion）：零 mutation（S14）；
       *  - 不冒充 exact，也不折叠为 absent。
       */
      readonly status: "insufficient";
      readonly detail: string;
    }
  | { readonly status: "conflict"; readonly detail: string }
  | { readonly status: "absent" }
  | { readonly status: "store_unhealthy"; readonly detail: string };

interface SettlementDeclaration {
  readonly kind: "exact" | "protocol" | "retired";
  readonly outcome: "committed" | "not-executed" | null;
  readonly identity?: TreasuryExactAttemptIdentity;
  readonly source: TreasuryDurableSettlementSource | "retired-range";
  readonly recordedAtTick?: number;
  readonly detail: string;
}

/** 统一 identity 比较（digest/contract/cohort/durable/lowlevel/proofClass + lineage 绑定四字段）。 */
function sameExactIdentity(
  left: TreasuryExactAttemptIdentity,
  right: TreasuryExactAttemptIdentity,
): boolean {
  if (
    left.digest !== right.digest ||
    (left.contractDigest ?? null) !== (right.contractDigest ?? null) ||
    (left.authorizationCohortDigest ?? null) !== (right.authorizationCohortDigest ?? null) ||
    (left.durableIdentityDigest ?? null) !== (right.durableIdentityDigest ?? null) ||
    (left.lowlevelSource ?? null) !== (right.lowlevelSource ?? null) ||
    left.proofClass !== right.proofClass
  ) {
    return false;
  }
  const leftLineage = left.lineageId ?? null;
  const rightLineage = right.lineageId ?? null;
  if (leftLineage === null && rightLineage === null) return true;
  if (leftLineage === null || rightLineage === null) return false;
  return (
    leftLineage === rightLineage &&
    (left.lineageGeneration ?? -1) === (right.lineageGeneration ?? -1) &&
    (left.parentTransactionId ?? null) === (right.parentTransactionId ?? null) &&
    (left.lineageBindingDigest ?? null) === (right.lineageBindingDigest ?? null)
  );
}

function identityOfCompletionProof(
  transactionId: string,
  proof: {
    digest?: unknown;
    contractDigest?: unknown;
    authorizationCohortDigest?: unknown;
    durableIdentityDigest?: unknown;
    lowlevelSource?: unknown;
    proofClass?: unknown;
    lineageId?: unknown;
    lineageGeneration?: unknown;
    parentTransactionId?: unknown;
    lineageBindingDigest?: unknown;
    /** live completion proof 的 identity 事实在 identity 子对象（historical record 直接传 identity——两种形状统一）。 */
    identity?: {
      digest?: unknown;
      contractDigest?: unknown;
      authorizationCohortDigest?: unknown;
      durableIdentityDigest?: unknown;
      lowlevelSource?: unknown;
      proofClass?: unknown;
      lineageId?: unknown;
      lineageGeneration?: unknown;
      parentTransactionId?: unknown;
      lineageBindingDigest?: unknown;
    };
  },
): TreasuryExactAttemptIdentity {
  const view = proof.identity !== undefined ? { ...proof, ...proof.identity } : proof;
  const base: TreasuryExactAttemptIdentity = {
    transactionId,
    digest: view.digest as string,
    proofClass: view.proofClass as TreasuryExactAttemptIdentity["proofClass"],
    ...(view.contractDigest !== undefined ? { contractDigest: view.contractDigest as string } : {}),
    ...(view.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: view.authorizationCohortDigest as string } : {}),
    ...(view.durableIdentityDigest !== undefined ? { durableIdentityDigest: view.durableIdentityDigest as string } : {}),
    ...(view.lowlevelSource !== undefined ? { lowlevelSource: view.lowlevelSource as string } : {}),
  };
  if (view.lineageId !== undefined) {
    return {
      ...base,
      lineageId: view.lineageId as string,
      lineageGeneration: view.lineageGeneration as number | undefined,
      ...(view.parentTransactionId !== undefined ? { parentTransactionId: view.parentTransactionId as string } : {}),
      ...(view.lineageBindingDigest !== undefined ? { lineageBindingDigest: view.lineageBindingDigest as string } : {}),
    };
  }
  return base;
}

/**
 * 持久结算权威的统一 reconciliation（只读；全部相关来源无短路聚合）。
 *
 * expectedOutcome 提供时由全部声明共同验证（任一相反 → conflict）；
 * expected（exact identity）提供时由全部 exact 声明共同验证（任一不一致
 * → conflict；protocol 声明不携带 identity——不据此判 exact）。
 */
export function resolveTreasuryDurableSettlementAuthority(input: {
  readonly transactionId: string;
  readonly expected?: TreasuryExactAttemptIdentity;
  readonly expectedOutcome?: "committed" | "not-executed";
}): TreasuryDurableSettlementResolution {
  const declarations: SettlementDeclaration[] = [];
  const unhealthy: string[] = [];
  const conflicts: string[] = [];

  // ── 1) live cleanup completion（最近完成的 attempt——尚未归档）。──────
  const completionHealth = peekTreasuryCleanupCompletionHealth();
  if (!completionHealth.healthy) {
    unhealthy.push(`live completion store unhealthy: ${completionHealth.detail}`);
  } else {
    // 不带 expected 视角查询（拿到权威真实声明再统一比较——避免视角
    // 污染方向判定）。
    const completion = lookupTreasuryCleanupCompletion(input.transactionId);
    if (completion.verdict === "store_unhealthy") {
      unhealthy.push(`live completion store unhealthy: ${completion.detail}`);
    } else if (completion.verdict === "conflict") {
      conflicts.push(`live completion 权威冲突: ${completion.detail}`);
    } else if (completion.verdict === "match") {
      declarations.push({
        kind: "exact",
        outcome: completion.proof.resolution,
        identity: identityOfCompletionProof(input.transactionId, completion.proof as never),
        source: "live-completion",
        recordedAtTick: completion.proof.completedAtTick,
        detail: `live cleanup completion 在位（outcome=${completion.proof.resolution}）`,
      });
    }
  }

  // ── 2) durable historical completion（Remediation VI 归档权威）。───────
  const supersessionHealth = peekTreasuryCleanupSupersessionHealth();
  if (!supersessionHealth.healthy) {
    unhealthy.push(`historical completion store unhealthy: ${supersessionHealth.detail}`);
  } else {
    const historical = lookupTreasuryHistoricalCompletion(input.transactionId);
    if (historical.verdict === "store_unhealthy") {
      unhealthy.push(`historical completion store unhealthy: ${historical.detail}`);
    } else if (historical.verdict === "conflict") {
      conflicts.push(`historical completion 权威冲突: ${historical.detail}`);
    } else if (historical.verdict === "match") {
      declarations.push({
        kind: "exact",
        outcome: historical.record.resolution,
        identity: identityOfCompletionProof(input.transactionId, historical.record.identity as never),
        source: "historical-completion",
        recordedAtTick: historical.record.archivedAtTick,
        detail: `durable historical completion 在位（outcome=${historical.record.resolution}，via=${historical.record.via}）`,
      });
    }
  }

  // ── 3) chain retirement certificate（root 或 tr1_ child——协议推导）。──
  const certificateHealth = peekTreasuryChainRetirementCertificateHealth();
  if (!certificateHealth.healthy) {
    unhealthy.push(`chain retirement certificate store unhealthy: ${certificateHealth.detail}`);
  } else {
    const rootOutcome = lookupTreasuryChainRetirementRootOutcome(input.transactionId);
    if (rootOutcome.verdict === "store_unhealthy") {
      unhealthy.push(`chain certificate 权威损坏: ${rootOutcome.detail}`);
    } else if (rootOutcome.verdict === "match") {
      declarations.push({
        kind: "protocol",
        outcome: rootOutcome.outcome,
        source: "chain-certificate",
        recordedAtTick: rootOutcome.certificate.finalizedAtTick,
        detail: rootOutcome.detail,
      });
    } else if (isTreasuryRearmAttemptId(input.transactionId)) {
      // tr1_ child：root 查询天然 absent——按 lineage/generation 寻址。
      const generationOutcome = lookupTreasuryChainRetirementGenerationOutcome(input.transactionId);
      if (generationOutcome.verdict === "store_unhealthy") {
        unhealthy.push(`chain certificate 权威损坏: ${generationOutcome.detail}`);
      } else if (generationOutcome.verdict === "match") {
        declarations.push({
          kind: "protocol",
          outcome: generationOutcome.outcome,
          source: "chain-certificate",
          recordedAtTick: generationOutcome.certificate.finalizedAtTick,
          detail: generationOutcome.detail,
        });
      }
    }
  }

  // ── 4) retired range（ti1_ root 的 anti-reuse 层）。────────────────────
  const rangeHealth = peekTreasuryRetiredRangeHealth();
  if (!rangeHealth.healthy) {
    unhealthy.push(`retired range store unhealthy: ${rangeHealth.detail}`);
  } else {
    const retiredRange = checkTreasuryAttemptRetiredRange(input.transactionId);
    if (retiredRange.retired) {
      declarations.push({
        kind: "retired",
        outcome: null,
        source: "retired-range",
        detail: `attempt 已进入 retired range（发行序号 ${retiredRange.detail}）——详细 outcome 已压缩，重放一律拒绝`,
      });
    }
  }

  // ── 裁决（优先级：unhealthy > conflict > 声明聚合 > absent）。──────────
  if (unhealthy.length > 0) {
    return { status: "store_unhealthy", detail: unhealthy.join("；") };
  }
  if (conflicts.length > 0) {
    return { status: "conflict", detail: conflicts.join("；") };
  }
  if (declarations.length === 0) return { status: "absent" };

  // exact 声明之间：outcome 必须一致、identity 必须一致（同 outcome 不同
  // identity = conflict——S5）。
  const exactDeclarations = declarations.filter((item) => item.kind === "exact");
  for (let index = 1; index < exactDeclarations.length; index += 1) {
    const first = exactDeclarations[0]!;
    const other = exactDeclarations[index]!;
    if (first.outcome !== other.outcome) {
      return {
        status: "conflict",
        detail: `${first.source}（outcome=${first.outcome}）与 ${other.source}（outcome=${other.outcome}）相反——不选边`,
      };
    }
    const pairRelation = treasuryExactAttemptIdentityRelation(first.identity!, other.identity!);
    if (pairRelation === "conflict") {
      return {
        status: "conflict",
        detail: `${first.source} 与 ${other.source} outcome 相同但 exact identity 明确不一致（durable digest ${(first.identity!.durableIdentityDigest ?? "<absent>").slice(0, 8)} vs ${(other.identity!.durableIdentityDigest ?? "<absent>").slice(0, 8)}）——不选边`,
      };
    }
    if (pairRelation === "insufficient") {
      // 【IX 工作流 F / 9.2 规则 1】两个 exact declaration 只有 relation=match
      // 才可共同证明 exact——维度不足（如一方缺 durable identity）不得聚合
      // 为 exact（S11：live exact 带 durable identity、historical 同 outcome
      // 但缺维度 → insufficient，不选边）。
      return {
        status: "insufficient",
        detail: `${first.source} 与 ${other.source} outcome 一致但 exact identity 维度不足（insufficient——${(first.identity!.durableIdentityDigest ?? "<absent>").slice(0, 8)} vs ${(other.identity!.durableIdentityDigest ?? "<absent>").slice(0, 8)}）——不得共同证明 exact，fail closed`,
      };
    }
  }
  // 全部声明（exact + protocol）的 outcome 必须一致（certificate 与
  // completion 相反结论 = conflict——S3；expectedOutcome 共同验证）。
  const outcomes = new Set(declarations.filter((item) => item.outcome !== null).map((item) => item.outcome));
  if (outcomes.size > 1) {
    return {
      status: "conflict",
      detail: `多个持久权威对同 ID 给出相反 outcome（${[...outcomes].join(" vs ")}）——不选边`,
    };
  }
  if (input.expectedOutcome !== undefined && outcomes.size === 1 && [...outcomes][0] !== input.expectedOutcome) {
    return {
      status: "conflict",
      detail: `持久权威 settlement=${[...outcomes][0]!} 与查询视角 ${input.expectedOutcome} 不一致（outcome 绑定——不得 relabel）`,
    };
  }
  // expected（exact identity）由全部 exact 声明共同验证——比较用统一
  // relation 语义：明确不一致（conflict）→ conflict（S5：outcome 相同
  // durable identity 不同）；维度不足（insufficient）无法验证一致——不选
  // 边阻断（与底层 lookup 的保守度一致，正常流程的维度缺失 completion
  // 不被误判为身份冲突）。
  if (input.expected !== undefined && exactDeclarations.length > 0) {
    // 【IX 工作流 F / 9.2 规则 4】caller 提供期望且存在 exact 声明时，每个
    // exact source 都必须 relation=match——insufficient（维度无法验证一致，
    // 含 expected 自身缺关键维度，S12）同样阻断，不得向下聚合为 exact。
    // 无 exact 声明时（仅 protocol/retired）不存在"共同证明 exact"的
    // 目标——expected 不改变 protocol/retired 裁决（C5：protocol 不冒充
    // exact 的语义保持）。
    if (input.expected == null || input.expected.durableIdentityDigest === undefined) {
      return {
        status: "insufficient",
        detail: `查询期望 exact identity 缺关键维度（durableIdentityDigest absent——期望本身不足，不得据此验证 exact 声明）`,
      };
    }
    for (const item of exactDeclarations) {
      const relation = treasuryExactAttemptIdentityRelation(item.identity!, input.expected);
      if (relation === "conflict") {
        return {
          status: "conflict",
          detail: `${item.source} 的 exact identity 与查询期望明确不一致（durable digest ${(item.identity!.durableIdentityDigest ?? "<absent>").slice(0, 8)} vs ${(input.expected.durableIdentityDigest ?? "<absent>").slice(0, 8)}）——不选边`,
        };
      }
      if (relation === "insufficient") {
        return {
          status: "insufficient",
          detail: `${item.source} 的 exact identity 与查询期望维度不足（durable digest ${(item.identity!.durableIdentityDigest ?? "<absent>").slice(0, 8)} vs ${(input.expected.durableIdentityDigest ?? "<absent>").slice(0, 8)}——无法验证一致，不得返回 exact）`,
        };
      }
    }
  }
  // 裁决输出：exact 优先（identity 可验证）；否则 protocol；否则 retired。
  const firstExact = exactDeclarations[0];
  if (firstExact !== undefined) {
    return {
      status: "exact",
      outcome: firstExact.outcome!,
      source: firstExact.source as TreasuryDurableSettlementSource,
      identity: firstExact.identity!,
      ...(firstExact.recordedAtTick !== undefined ? { recordedAtTick: firstExact.recordedAtTick } : {}),
      detail: exactDeclarations.length > 1
        ? `${firstExact.detail}；多个 exact 权威一致（${exactDeclarations.map((item) => item.source).join(" + ")}）`
        : firstExact.detail,
    };
  }
  const firstProtocol = declarations.find((item) => item.kind === "protocol");
  if (firstProtocol !== undefined) {
    return {
      status: "protocol",
      outcome: firstProtocol.outcome!,
      source: "chain-certificate",
      ...(firstProtocol.recordedAtTick !== undefined ? { recordedAtTick: firstProtocol.recordedAtTick } : {}),
      detail: `${firstProtocol.detail}——协议推导（certificate 不携带 exact identity，不得用于 destructive exact-proof 路径）`,
    };
  }
  const firstRetired = declarations.find((item) => item.kind === "retired")!;
  return {
    status: "retired",
    source: firstRetired.source as "retired-range",
    detail: firstRetired.detail,
  };
}

// ──【Remediation VIII 工作流 B3】cleanup completion 权威（与 settlement
//    权威分离）────────────────────────────────────────────────────────────

export type TreasuryCleanupCompletionResolution =
  | {
      /** matching、exact、明确证明 cleanup 全部阶段完成的权威在位（幂等已完成）。 */
      readonly status: "completed";
      readonly outcome: "committed" | "not-executed";
      readonly source: "live-completion" | "historical-completion";
      readonly identity: TreasuryExactAttemptIdentity;
      /** live completion proof 的全局锁事实（historical 来源不携带）。 */
      readonly globalWriteAdmissionStillLocked?: boolean;
      readonly detail: string;
    }
  | { readonly status: "conflict"; readonly detail: string }
  | { readonly status: "insufficient"; readonly detail: string }
  | { readonly status: "absent" }
  | { readonly status: "store_unhealthy"; readonly detail: string };

/**
 * cleanup **完成**权威的统一 reconciliation（journal-absent 判定专用）：
 * 只有 live completion（五阶段全部持久确认后写入）与 historical
 * completion（显式 supersession——接管 cleanup-complete 事实）能证明
 * cleanup completed。chain certificate / retired range 只证明 settlement
 * outcome（root/final/中间代的协议推导），不证明 marker discharge /
 * authority release / outcome finalization / lineage finalization /
 * journal deletion——不进入本判定（S8：journal absent + 只有 settlement
 * certificate → 不得 completed）。
 */
export function resolveTreasuryCleanupCompletionAuthority(input: {
  readonly transactionId: string;
  readonly expected?: TreasuryExactAttemptIdentity;
  readonly expectedOutcome?: "committed" | "not-executed";
}): TreasuryCleanupCompletionResolution {
  const declarations: SettlementDeclaration[] = [];
  const unhealthy: string[] = [];
  const conflicts: string[] = [];

  let globalWriteAdmissionStillLockedOfLive: boolean | undefined;
  const completionHealth = peekTreasuryCleanupCompletionHealth();
  if (!completionHealth.healthy) {
    unhealthy.push(`live completion store unhealthy: ${completionHealth.detail}`);
  } else {
    const completion = lookupTreasuryCleanupCompletion(input.transactionId, input.expected, input.expectedOutcome);
    if (completion.verdict === "store_unhealthy") {
      unhealthy.push(`live completion store unhealthy: ${completion.detail}`);
    } else if (completion.verdict === "conflict") {
      conflicts.push(`live completion 权威冲突: ${completion.detail}`);
    } else if (completion.verdict === "match") {
      const locked = (completion.proof as { globalWriteAdmissionStillLocked?: unknown }).globalWriteAdmissionStillLocked;
      if (typeof locked === "boolean") globalWriteAdmissionStillLockedOfLive = locked;
      declarations.push({
        kind: "exact",
        outcome: completion.proof.resolution,
        identity: identityOfCompletionProof(input.transactionId, completion.proof as never),
        source: "live-completion",
        detail: "matching completion authority 在位（幂等已完成）",
      });
    }
  }

  const supersessionHealth = peekTreasuryCleanupSupersessionHealth();
  if (!supersessionHealth.healthy) {
    unhealthy.push(`historical completion store unhealthy: ${supersessionHealth.detail}`);
  } else {
    const historical = lookupTreasuryHistoricalCompletion(input.transactionId, input.expected, input.expectedOutcome);
    if (historical.verdict === "store_unhealthy") {
      unhealthy.push(`historical completion store unhealthy: ${historical.detail}`);
    } else if (historical.verdict === "conflict") {
      conflicts.push(`historical completion 权威冲突: ${historical.detail}`);
    } else if (historical.verdict === "match") {
      declarations.push({
        kind: "exact",
        outcome: historical.record.resolution,
        identity: identityOfCompletionProof(input.transactionId, historical.record.identity as never),
        source: "historical-completion",
        detail: `durable historical authority 持续证明完成（outcome=${historical.record.resolution}——显式 supersession 接管 cleanup-complete 事实）`,
      });
    }
  }

  if (unhealthy.length > 0) return { status: "store_unhealthy", detail: unhealthy.join("；") };
  if (conflicts.length > 0) return { status: "conflict", detail: conflicts.join("；") };
  if (declarations.length === 0) return { status: "absent" };
  const first = declarations[0]!;
  for (let index = 1; index < declarations.length; index += 1) {
    const other = declarations[index]!;
    const relation = treasuryExactAttemptIdentityRelation(first.identity!, other.identity!);
    if (first.outcome !== other.outcome || relation === "conflict") {
      return {
        status: "conflict",
        detail: `${first.source} 与 ${other.source} 的 cleanup completion 声明不一致——不选边`,
      };
    }
    if (relation === "insufficient") {
      // 【IX 工作流 F】两个 exact completion 声明维度不足（如 historical 缺
      // durable identity 维度）——不得共同证明 completed（fail closed，
      // journal 语义由调用方按未确认处理）。
      return {
        status: "insufficient",
        detail: `${first.source} 与 ${other.source} 的 cleanup completion 声明 identity 维度不足（insufficient）——不确证 completed，fail closed`,
      };
    }
  }
  return {
    status: "completed",
    outcome: first.outcome!,
    source: first.source as "live-completion" | "historical-completion",
    identity: first.identity!,
    ...(globalWriteAdmissionStillLockedOfLive !== undefined ? { globalWriteAdmissionStillLocked: globalWriteAdmissionStillLockedOfLive } : {}),
    detail: first.detail,
  };
}
