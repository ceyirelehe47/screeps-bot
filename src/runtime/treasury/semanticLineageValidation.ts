/**
 * 【第二十轮第六节】semantic lineage validation 单一权威。
 *
 * Round 19 的 lineage proof 只证明"四字段形状合法 + 载体间相等"（shape
 * proof——lineageProof.ts）。四字段可以在多个 store 中被一致复制却仍是一
 * 组一致的错误事实。本模块证明字段本身语义真实（semantic proof）：
 *
 * - child ID 解析：parseTreasuryRearmChildTransactionIdV2——legacy 不可解析
 *   ID → legacy isolated（insufficient，不猜测）；
 * - ID 内嵌 (lineageId, generation) 与 proof 四字段对应项一致；
 * - 从权威 source（active lineage record / terminal summary）取 root，
 *   重算 expected child ID（v2 派生 + checksum 绑定 root）；
 * - expected parent = 上一代确定性 attempt ID（gen1 parent = root；
 *   genN parent = genN-1 的 v2 child）——不信任载体自带 parent 字符串；
 * - binding 由权威算法（lineageBinding）按 (lineageId, generation,
 *   expectedParent, child) 重算比较；
 * - active lineage 存在：record 状态 / current / next(pending handoff) /
 *   history(generation) 语义、authority class、lowlevelSource、retry
 *   semantic 与调用上下文相容；historical generation 必须命中 exact
 *   generation retirement authority（generationRetirementAuthority 装配注入）；
 * - active lineage 不存在：terminal summary + exact retirement authority
 *   按 lineageId O(1) 定位并证明（finalGeneration 只是边界，不是
 *   membership proof）。
 *
 * verdict 至少区分：match / conflict / insufficient(legacy isolated) /
 * store_unhealthy / no_authority——调用方不得折叠成 undefined/false。
 * store unhealthy 时 fail closed（绝不返回 match）。readers 未装配时同样
 * fail closed（receipts 等 production 写入门禁依赖此语义）。
 *
 * 无副作用：只读（authority source 经装配注入——模块单向依赖，
 * receipts/unresolvedAuthority 直接 import 本模块不成环；attemptLineage/
 * lineageRetirementSummary/generationRetirementAuthority 各自在模块加载时
 * 注册只读 source）。retry semantic 是独立维度（record 验证含
 * retrySemanticDigest 一致性，不并入 binding digest）。
 */

import {
  formatTreasuryRearmChildTransactionIdV2,
  isTreasuryRearmAttemptId,
  parseTreasuryRearmChildTransactionIdV2,
} from "@/runtime/treasury/transactionId";
import { computeTreasuryLineageBindingDigest } from "@/runtime/treasury/lineageBinding";
import type { TreasuryLineageProofFacts } from "@/runtime/treasury/lineageProof";
import {
  treasuryExactAttemptIdentityOfFacts,
  treasuryProofClassOfIdentityFacts,
  type TreasuryExactIdentityFactsInput,
} from "@/runtime/treasury/exactAttemptIdentity";
import { verifyTreasuryCurrentLineageExactIdentity } from "@/runtime/treasury/currentLineageSettlementVerifier";
import { treasuryTerminalFinalExactOfSummary, treasuryTerminalExactIdentityRelation } from "@/runtime/treasury/terminalExactIdentity";
import type { TreasuryAttemptLineageRecord } from "@/runtime/treasury/attemptLineage";
import type { TreasuryLineageRetirementSummary } from "@/runtime/treasury/lineageRetirementSummary";

// ── 装配注入的只读 authority source（避免运行时循环依赖） ───────────────────

/** active lineage record 的只读 source（attemptLineage 模块加载注册）。 */
export interface TreasurySemanticLineageRecordSource {
  healthy(): boolean;
  unhealthyDetail(): string | null;
  readByLineageId(lineageId: string): Readonly<TreasuryAttemptLineageRecord> | undefined;
}

/** terminal retirement summary 的只读 source（lineageRetirementSummary 注册）。 */
export interface TreasurySemanticSummarySource {
  healthy(): boolean;
  unhealthyDetail(): string | null;
  readByLineageId(lineageId: string): Readonly<TreasuryLineageRetirementSummary> | undefined;
}

/** exact per-generation retirement proof 的只读 source（generationRetirementAuthority 注册）。 */
export interface TreasuryGenerationProofSource {
  healthy(): boolean;
  unhealthyDetail(): string | null;
  read(lineageId: string, generation: number): Readonly<{
    readonly lineageId: string;
    readonly rootTransactionId: string;
    readonly generation: number;
    readonly transactionId: string;
    readonly parentTransactionId?: string;
    readonly bindingDigest?: string;
    readonly digest: string;
    readonly contractDigest?: string;
    readonly authorizationCohortDigest?: string;
    readonly durableIdentityDigest?: string;
    readonly lowlevelSource?: string;
    readonly authorityClass: "identity-bound" | "lowlevel";
  }> | undefined;
}

let recordSource: TreasurySemanticLineageRecordSource | null = null;
let summarySource: TreasurySemanticSummarySource | null = null;
let generationProofSource: TreasuryGenerationProofSource | null = null;

export function registerTreasurySemanticLineageRecordSourceForAssembly(source: TreasurySemanticLineageRecordSource): void {
  recordSource = source;
}

export function registerTreasurySemanticSummarySourceForAssembly(source: TreasurySemanticSummarySource): void {
  summarySource = source;
}

export function registerTreasuryGenerationProofSourceForAssembly(source: TreasuryGenerationProofSource): void {
  generationProofSource = source;
}

/** 测试清理（receipts.clearTreasuryPersistenceForTest 统一调用）。 */
export function resetTreasurySemanticLineageSourcesForTest(): void {
  recordSource = null;
  summarySource = null;
  generationProofSource = null;
  committedProofSource = null;
}

/** production 装配状态（未装配时 tr1_ 验证/写入路径 fail closed）。 */
export function isTreasurySemanticLineageSourceAssembled(): boolean {
  return recordSource !== null && summarySource !== null && generationProofSource !== null;
}

/** record source 只读访问（GRA 等模块的当前代判定——不暴露 mutation）。 */
export function peekTreasurySemanticLineageRecordSource(): TreasurySemanticLineageRecordSource | null {
  return recordSource;
}

// ── verdict ──────────────────────────────────────────────────────────────────

/** generation 相对权威 source 的角色（match 时输出——调用方按上下文消费）。 */
export type TreasurySemanticLineageGenerationRole =
  /** generation === record.generation（active current attempt）。 */
  | "current"
  /** generation === record.generation + 1（capability_issued/child_intent_pending 的在途 child）。 */
  | "pending_handoff"
  /** generation < record.generation（历史代——由 exact retirement proof 证明）。 */
  | "historical"
  /** generation === summary.finalGeneration（terminal chain 的最终代）。 */
  | "terminal_current"
  /** summary 存在下的历史代（generation < finalGeneration——由 exact proof 证明）。 */
  | "terminal_historical";

/**
 * 【第二十二轮第十节】semantic lineage 验证 purpose（显式——安全关键
 * 调用必须传入，不得以布尔开关或裸 match 表达复杂语义）：
 *
 * - handoff：只允许 pending_handoff（在途 child 的受控恢复窗口）；
 * - current_execution：只允许 current（capability 签发 / callback 执行阶段）；
 * - committed_settlement：允许 current（状态机允许 commit/recovery）或
 *   terminal_current（summary terminalState=chain_committed）；historical /
 *   terminal_historical 的 not-executed proof 永远不能授权 committed；
 *   同代已存在 exact not-executed retirement proof → conflict；
 * - not_executed_retirement：允许 current 的 retiring/cleanup 路径，以及
 *   terminal_current（仅验证已存在 non-rearmable 终态）；committed 终态
 *   拒绝；
 * - tombstone_replacement：current 或 historical（需 matching exact
 *   retirement proof）——不承担 commit 授权；
 * - historical_diagnostic：只读诊断（全部 role 可读——不得用于写
 *   Receipt / finalize / release / compaction / capability 签发）。
 */
export type TreasurySemanticLineagePurpose =
  | "handoff"
  | "current_execution"
  | "committed_settlement"
  | "not_executed_retirement"
  | "tombstone_replacement"
  | "historical_diagnostic"
  /**
   * unresolved authority 归一化读取 gate（resolver 三个 ok 路径共用）：
   * 验证 authority 的 lineage 语义真实性（防伪造/混用），不授权任何特定
   * 用途——全部 role 允许；消费方做状态改变时必须另行使用对应 purpose
   * （capability 签发 / commit / release 各有门禁）。
   */
  | "authority_resolution";

/** committed proof 的只读探测 source（facade 装配：receipt + tombstone 组合）。 */
export interface TreasurySemanticCommittedProofSource {
  /** "present" = matching committed proof 存在；"absent" = 无；"unknown" = 无法判定（不阻断——coordinator 层必检）。 */
  probe(transactionId: string): "present" | "absent" | "unknown";
}

let committedProofSource: TreasurySemanticCommittedProofSource | null = null;

export function registerTreasurySemanticCommittedProofSourceForAssembly(source: TreasurySemanticCommittedProofSource | null): void {
  committedProofSource = source;
}

export type TreasurySemanticLineageVerdict =
  | {
    readonly verdict: "match";
    readonly authoritySource: "active" | "terminal";
    readonly generationRole: TreasurySemanticLineageGenerationRole;
    /** active：current attempt 的 record 快照；terminal：summary 快照。 */
    readonly record?: Readonly<TreasuryAttemptLineageRecord>;
    readonly summary?: Readonly<TreasuryLineageRetirementSummary>;
  }
  | { readonly verdict: "conflict"; readonly detail: string }
  | { readonly verdict: "insufficient"; readonly detail: string }
  | { readonly verdict: "store_unhealthy"; readonly detail: string }
  | { readonly verdict: "no_authority"; readonly detail: string };

// ── 内部派生 helper（与 attemptLineage.expectedTreasuryLineageAttemptId 同协议） ─

function expectedAttemptIdOf(lineageId: string, rootTransactionId: string, generation: number): string {
  if (generation <= 0) return rootTransactionId;
  return formatTreasuryRearmChildTransactionIdV2({ lineageId, generation, rootTransactionId });
}

/** identity 维度与权威 class/provenance 的相容性（受控比较——输入未提供的维度跳过）。 */
function identityClassConflict(
  label: string,
  identity: TreasuryExactIdentityFactsInput | undefined,
  authorityClass: "identity-bound" | "lowlevel",
  authorityLowlevelSource: string | undefined,
): string | null {
  if (identity === undefined) return null;
  if (identity.lowlevelSource !== undefined) {
    if (authorityClass !== "lowlevel") {
      return `${label} 携带 lowlevelSource 但权威 authority class 为 ${authorityClass}（provenance class 矛盾）`;
    }
    if (authorityLowlevelSource === undefined || identity.lowlevelSource !== authorityLowlevelSource) {
      return `${label} 的 lowlevelSource 与权威 provenance 不一致（runtime 与 migrated 不能互相证明）`;
    }
  }
  if (authorityClass === "lowlevel" && identity.lowlevelSource === undefined && identity.digest !== undefined) {
    return `${label} 属于 lowlevel chain 但 identity 视图缺 lowlevelSource（provenance 不可证明）`;
  }
  return null;
}

/** 历史/终代 exact retirement proof 的完整比较（ID/parent/binding/class/identity 维度）。 */
function verifyGenerationProof(
  proof: NonNullable<ReturnType<TreasuryGenerationProofSource["read"]>>,
  transactionId: string,
  lineageId: string,
  generation: number,
  expectedParent: string,
  expectedBinding: string | undefined,
  identity: TreasuryExactIdentityFactsInput | undefined,
): string | null {
  if (proof.lineageId !== lineageId || proof.generation !== generation) return "exact retirement proof 的 (lineageId, generation) 与查询不一致";
  if (proof.transactionId !== transactionId) return "exact retirement proof 的 transactionId 与待验证 attempt 不一致";
  if (generation >= 1) {
    if (proof.parentTransactionId === undefined || proof.parentTransactionId !== expectedParent) {
      return "exact retirement proof 的 parentTransactionId 与上一代确定性派生不一致";
    }
    if (proof.bindingDigest === undefined || expectedBinding === undefined || proof.bindingDigest !== expectedBinding) {
      return "exact retirement proof 的 bindingDigest 与权威重算不一致";
    }
  } else if (proof.parentTransactionId !== undefined || proof.bindingDigest !== undefined) {
    return "generation 0 的 exact retirement proof 不得携带 parent/binding";
  }
  if (identity !== undefined) {
    if (identity.digest !== undefined && identity.digest !== proof.digest) return "exact retirement proof 的 digest 与 identity 视图不一致";
    if (identity.contractDigest !== undefined && identity.contractDigest !== proof.contractDigest) return "exact retirement proof 的 contractDigest 与 identity 视图不一致";
    if (identity.authorizationCohortDigest !== undefined && identity.authorizationCohortDigest !== proof.authorizationCohortDigest) {
      return "exact retirement proof 的 authorizationCohortDigest 与 identity 视图不一致";
    }
    if (identity.durableIdentityDigest !== undefined && identity.durableIdentityDigest !== proof.durableIdentityDigest) {
      return "exact retirement proof 的 durableIdentityDigest 与 identity 视图不一致";
    }
    // 【第二十一轮】provenance 与 proof 绑定（historical 的 lowlevel 权威是
    // exact retirement proof 自身携带的 lowlevelSource——受控比较）。
    if (identity.lowlevelSource !== undefined && identity.lowlevelSource !== proof.lowlevelSource) {
      return "exact retirement proof 的 lowlevelSource 与 identity 视图不一致（runtime 与 migrated 不能互相证明）";
    }
  }
  return null;
}

/**
 * semantic lineage validation（单一入口，purpose-aware）：
 * 主验证（shape → 派生 → authority）后按 purpose 矩阵过滤 generation
 * role——bare match 不再授权所有用途。purpose 必填（类型层面强制——
 * 状态改变调用缺 purpose 无法编译；防御性运行时检查见下）。
 */
export function validateTreasurySemanticLineage(input: {
  readonly transactionId: string;
  readonly proof: TreasuryLineageProofFacts;
  /** attempt identity 维度（可选——class/provenance/历史 proof 的受控比较）。 */
  readonly identity?: TreasuryExactIdentityFactsInput;
  /** 【第二十二轮 + remediation F】验证 purpose（必填字段——TypeScript 层
   *  强制：状态改变调用缺 purpose 无法编译；下方运行时 defensive check
   *  保留（external/JS 调用面与解构拷贝防线）。 */
  readonly purpose: TreasurySemanticLineagePurpose;
}): TreasurySemanticLineageVerdict {
  const purpose = input.purpose;
  if (purpose === undefined) {
    return {
      verdict: "store_unhealthy",
      detail: "semantic lineage 验证缺少 purpose（安全关键调用必须显式声明用途——fail closed）",
    };
  }
  const base = validateTreasurySemanticLineageWithRole(input);
  if (base.verdict !== "match") return base;
  const gate = treasurySemanticLineagePurposeGate(purpose, base);
  if (gate !== null) {
    return gate.rejectAs === "conflict"
      ? { verdict: "conflict", detail: gate.detail }
      : { verdict: "insufficient", detail: gate.detail };
  }
  return base;
}

/** purpose 矩阵 gate：返回 null = 允许；否则按 rejectAs 拒绝（单一权威）。 */
function treasurySemanticLineagePurposeGate(
  purpose: TreasurySemanticLineagePurpose,
  match: {
    readonly authoritySource: "active" | "terminal";
    readonly generationRole: TreasurySemanticLineageGenerationRole;
    readonly record?: Readonly<TreasuryAttemptLineageRecord>;
    readonly summary?: Readonly<TreasuryLineageRetirementSummary>;
    readonly transactionId?: string;
  },
): { readonly rejectAs: "conflict" | "insufficient"; readonly detail: string } | null {
  const { generationRole } = match;
  const roleAllowed =
    purpose === "historical_diagnostic" || purpose === "authority_resolution"
      ? true
      : purpose === "handoff"
        ? generationRole === "pending_handoff"
        : purpose === "current_execution"
          ? generationRole === "current"
          : purpose === "committed_settlement"
            ? generationRole === "current" || generationRole === "terminal_current"
            : purpose === "not_executed_retirement"
              ? generationRole === "current" || generationRole === "terminal_current"
              : purpose === "tombstone_replacement"
                ? generationRole === "current" || generationRole === "historical" || generationRole === "terminal_current" || generationRole === "terminal_historical"
                : false;
  if (!roleAllowed) {
    return {
      rejectAs: "insufficient",
      detail: `purpose=${purpose} 不允许 generation role=${generationRole}（historical not-executed proof 不能授权 committed 路径——purpose 矩阵 fail closed）`,
    };
  }
  if (purpose === "committed_settlement") {
    if (generationRole === "current") {
      const state = match.record?.state;
      const stateAllowed = state === "child_active" || state === "chain_committed";
      if (!stateAllowed) {
        return {
          rejectAs: "insufficient",
          detail: `committed settlement 的 current 状态为 ${String(state)}（不允许 commit/recovery 的阶段——purpose 矩阵 fail closed）`,
        };
      }
      // 同代已存在 exact not-executed retirement proof → 相反结论 conflict。
      const lineageId = match.record?.lineageId;
      const generation = match.record?.generation;
      if (lineageId !== undefined && generation !== undefined && generationProofSource !== null) {
        const opposite = generationProofSource.read(lineageId, generation);
        if (opposite !== undefined && opposite.transactionId === match.record?.currentTransactionId) {
          return {
            rejectAs: "conflict",
            detail: `generation ${String(generation)} 已存在 matching exact not-executed retirement proof（相反结论——committed purpose 拒绝）`,
          };
        }
      }
    } else if (generationRole === "terminal_current") {
      if (match.summary?.terminalState !== "chain_committed") {
        return {
          rejectAs: "insufficient",
          detail: `committed settlement 的 terminal current 状态为 ${String(match.summary?.terminalState)}（仅 chain_committed 可证明）`,
        };
      }
    }
  }
  if (purpose === "not_executed_retirement") {
    if (generationRole === "current") {
      const state = match.record?.state;
      if (state === "child_active" || state === "chain_committed") {
        return {
          rejectAs: "conflict",
          detail: "chain_committed/child_active 的 current 不允许 not-executed retirement（已进入 committed 轨道——相反结论）",
        };
      }
      const stateAllowed = state === "retiring" || state === "non_rearmable_retired" || state === "rearm_ready";
      if (!stateAllowed) {
        return {
          rejectAs: "insufficient",
          detail: `not-executed retirement 的 current 状态为 ${String(state)}（retiring/cleanup 之外不允许）`,
        };
      }
    } else if (generationRole === "terminal_current") {
      if (match.summary?.terminalState !== "non_rearmable_retired") {
        return {
          rejectAs: "insufficient",
          detail: `not-executed retirement 的 terminal current 状态为 ${String(match.summary?.terminalState)}（仅验证已存在 non-rearmable 终态）`,
        };
      }
    }
    // matching committed proof（receipt/tombstone，facade 装配的组合探测）。
    if (committedProofSource !== null && match.record !== undefined) {
      const committed = committedProofSource.probe(match.record.currentTransactionId);
      if (committed === "present") {
        return {
          rejectAs: "conflict",
          detail: "同 attempt 存在 matching committed proof（相反结论——not-executed retirement 拒绝）",
        };
      }
    }
  }
  return null;
}

/**
 * 主验证（role 判定权威——purpose 包装的内部实现；历史调用方迁移期间
 * 保持导出，新代码一律走 validateTreasurySemanticLineage）。
 */
function validateTreasurySemanticLineageWithRole(input: {
  readonly transactionId: string;
  readonly proof: TreasuryLineageProofFacts;
  readonly identity?: TreasuryExactIdentityFactsInput;
}): TreasurySemanticLineageVerdict {
  const { transactionId, proof, identity } = input;
  if (!isTreasuryRearmAttemptId(transactionId)) {
    return {
      verdict: "conflict",
      detail: `transactionId ${transactionId.slice(0, 24)} 不是 tr1_ rearm attempt（initial attempt 无 lineage 语义——semantic validator 只验证 rearm proof）`,
    };
  }
  if (recordSource === null || summarySource === null || generationProofSource === null) {
    return {
      verdict: "store_unhealthy",
      detail: "semantic lineage authority source 未装配（lineage record / summary / generation proof reader 缺失——fail closed，不乐观验证）",
    };
  }
  // 1. child ID 解析（legacy 不可解析 → isolated，不猜测）。
  const parsed = parseTreasuryRearmChildTransactionIdV2(transactionId);
  if (parsed === null) {
    return {
      verdict: "insufficient",
      detail: `tr1_ transactionId ${transactionId.slice(0, 32)} 非 v2 generation-addressable 形态（legacy v1 ID 不可语义验证——legacy isolated，不猜测）`,
    };
  }
  // 2. ID 内嵌 (lineageId, generation) 与 proof 一致。
  if (parsed.lineageId !== proof.lineageId) {
    return {
      verdict: "conflict",
      detail: `child ID 内嵌 lineageId 与 proof.lineageId 不一致（ID ${parsed.lineageId.slice(0, 12)}，proof ${proof.lineageId.slice(0, 12)}）`,
    };
  }
  if (parsed.generation !== proof.lineageGeneration) {
    return {
      verdict: "conflict",
      detail: `child ID 内嵌 generation ${String(parsed.generation)} 与 proof.lineageGeneration ${String(proof.lineageGeneration)} 不一致`,
    };
  }
  // 3. active lineage 权威（record 存在）。
  if (!recordSource.healthy()) {
    return { verdict: "store_unhealthy", detail: `lineage store unhealthy: ${recordSource.unhealthyDetail() ?? "unknown"}` };
  }
  const record = recordSource.readByLineageId(proof.lineageId);
  if (record !== undefined) {
    if (record.rootTransactionId === transactionId) {
      return { verdict: "conflict", detail: "tr1_ child ID 不得作为 root attempt（root/current 身份矛盾）" };
    }
    // 3a. child ID 派生 + checksum 绑定 root。
    const expectedChild = expectedAttemptIdOf(record.lineageId, record.rootTransactionId, parsed.generation);
    if (expectedChild !== transactionId) {
      return {
        verdict: "conflict",
        detail: `child ID 与 (lineageId, generation, root) v2 派生不一致（checksum 绑定 root——错误 root/lineage 不可证明）`,
      };
    }
    // 3b. parent 派生（gen1 parent = root；genN parent = genN-1 child）。
    const expectedParent = expectedAttemptIdOf(record.lineageId, record.rootTransactionId, parsed.generation - 1);
    if (proof.parentTransactionId !== expectedParent) {
      return {
        verdict: "conflict",
        detail: `proof.parentTransactionId 与上一代确定性派生不一致（期望 ${expectedParent.slice(0, 24)}，实际 ${proof.parentTransactionId.slice(0, 24)}）`,
      };
    }
    // 3c. binding 重算（不信任载体自带 binding 字符串）。
    const expectedBinding = computeTreasuryLineageBindingDigest({
      lineageId: record.lineageId,
      generation: parsed.generation,
      parentTransactionId: expectedParent,
      childTransactionId: transactionId,
    });
    if (proof.lineageBindingDigest !== expectedBinding) {
      return { verdict: "conflict", detail: "proof.lineageBindingDigest 与 (lineageId, generation, parent, child) 权威重算不一致" };
    }
    // 3d. class / provenance 相容。
    const classError = identityClassConflict("attempt identity", identity, record.authorityClass, record.lowlevelSource);
    if (classError !== null) return { verdict: "conflict", detail: classError };
    // 3e. generation 角色判定。
    if (parsed.generation > record.generation) {
      const isPendingHandoff =
        parsed.generation === record.generation + 1 &&
        (record.state === "capability_issued" || record.state === "child_intent_pending") &&
        record.nextChildTransactionId === transactionId &&
        record.pendingBindingDigest === proof.lineageBindingDigest;
      if (!isPendingHandoff) {
        return {
          verdict: "conflict",
          detail: `generation ${String(parsed.generation)} 超过 lineage 当前代 ${String(record.generation)} 且无在途 handoff 事实（未来代不可证明）`,
        };
      }
      return { verdict: "match", authoritySource: "active", generationRole: "pending_handoff", record };
    }
    if (parsed.generation === record.generation) {
      // current attempt：record 的 current 三元（ID/parent/binding）必须与 proof 一致。
      if (record.currentTransactionId !== transactionId || record.currentParentTransactionId !== proof.parentTransactionId || record.bindingDigest !== proof.lineageBindingDigest) {
        return {
          verdict: "conflict",
          detail: "current generation 的 record current（ID/parent/binding）与 proof 不一致（generation 混用或篡改）",
        };
      }
      // 【第二十一轮 6.4】active current 必须完整比较 exact identity（digest/
      // contract/cohort/durable/proof class/lowlevelSource 与
      // record.currentIdentity 及 record.authorityClass）——单一权威
      // currentLineageSettlementVerifier；identity 缺失或任一维度不同不得 match。
      const currentVerify = verifyTreasuryCurrentLineageExactIdentity({ record, identity, proof });
      if (currentVerify.verdict !== "match") {
        return { verdict: currentVerify.verdict, detail: currentVerify.detail };
      }
      return { verdict: "match", authoritySource: "active", generationRole: "current", record };
    }
    // 3f. 历史代（generation < record.generation）：必须命中 exact retirement proof。
    if (!generationProofSource.healthy()) {
      return { verdict: "store_unhealthy", detail: `exact generation retirement store unhealthy: ${generationProofSource.unhealthyDetail() ?? "unknown"}` };
    }
    const retirementProof = generationProofSource.read(record.lineageId, parsed.generation);
    if (retirementProof === undefined) {
      return {
        verdict: "insufficient",
        detail: `历史 generation ${String(parsed.generation)} 无 exact retirement proof（状态机推进不是证明——不猜测，pin）`,
      };
    }
    const proofError = verifyGenerationProof(retirementProof, transactionId, record.lineageId, parsed.generation, expectedParent, expectedBinding, identity);
    if (proofError !== null) return { verdict: "conflict", detail: proofError };
    return { verdict: "match", authoritySource: "active", generationRole: "historical", record };
  }
  // 4. active lineage 不存在 → terminal authority（summary + exact proof）。
  if (!summarySource.healthy()) {
    return { verdict: "store_unhealthy", detail: `retirement summary store unhealthy: ${summarySource.unhealthyDetail() ?? "unknown"}` };
  }
  const summary = summarySource.readByLineageId(proof.lineageId);
  if (summary === undefined) {
    return {
      verdict: "no_authority",
      detail: `lineage ${proof.lineageId.slice(0, 12)} 无 active record 且无 terminal summary（tr1_ authority 不可证明——不猜测）`,
    };
  }
  if (parsed.generation > summary.finalGeneration) {
    return {
      verdict: "conflict",
      detail: `generation ${String(parsed.generation)} 超过 summary 已闭合的 finalGeneration ${String(summary.finalGeneration)}（未来代不可证明）`,
    };
  }
  const expectedChild = expectedAttemptIdOf(summary.lineageId, summary.rootTransactionId, parsed.generation);
  if (expectedChild !== transactionId) {
    return {
      verdict: "conflict",
      detail: "child ID 与 summary (lineageId, generation, root) v2 派生不一致（checksum 绑定 root）",
    };
  }
  const expectedParent = expectedAttemptIdOf(summary.lineageId, summary.rootTransactionId, parsed.generation - 1);
  if (proof.parentTransactionId !== expectedParent) {
    return { verdict: "conflict", detail: "proof.parentTransactionId 与 summary 上一代确定性派生不一致" };
  }
  const expectedBinding = computeTreasuryLineageBindingDigest({
    lineageId: summary.lineageId,
    generation: parsed.generation,
    parentTransactionId: expectedParent,
    childTransactionId: transactionId,
  });
  if (proof.lineageBindingDigest !== expectedBinding) {
    return { verdict: "conflict", detail: "proof.lineageBindingDigest 与 summary (lineageId, generation, parent, child) 权威重算不一致" };
  }
  if (summary.authorityClass === undefined) {
    return {
      verdict: "insufficient",
      detail: "v1 迁移 summary 缺 authorityClass（terminal class 不可证明——legacy isolated，不猜测）",
    };
  }
  // 【第二十一轮 7.3/7.4】terminal current 的 exact identity 由 summary v3
  // 持久化的 finalExact 证明——旧 v1/v2 summary（无 finalExact）是
  // replay-only：保留 root 重放门禁，但不得证明 terminal current、不得授权
  // 新写入（fail closed，不自动补造）。terminal historical 仍由 exact
  // generation retirement proof 证明（proof 自带完整身份维度与 provenance）。
  const finalExactView = treasuryTerminalFinalExactOfSummary(summary);
  // provenance 权威：v3 summary 用持久化 finalExact.lowlevelSource（不得拿
  // 调用方 source 与调用方自己比较——第二十一轮修复）；旧 summary 的
  // terminal current 反正 replay-only（insufficient），terminal historical 的
  // provenance 由 exact retirement proof 承载（verifyGenerationProof）。
  const isTerminalCurrentGeneration = parsed.generation === summary.finalGeneration;
  const provenanceAuthority = finalExactView !== null
    ? finalExactView.finalExact.lowlevelSource
    : (isTerminalCurrentGeneration ? undefined : identity?.lowlevelSource);
  const classError = identityClassConflict("attempt identity", identity, summary.authorityClass, provenanceAuthority);
  if (classError !== null) return { verdict: "conflict", detail: classError };
  if (parsed.generation === summary.finalGeneration) {
    if (summary.finalAttemptId !== transactionId) {
      return { verdict: "conflict", detail: "summary.finalAttemptId 与待验证 attempt ID 不一致" };
    }
    // 【第二十一轮 7.3】terminal current 的完整 exact identity 证明：构造调用方
    // 与 summary 持久化的 final exact identity，执行 proof-class-aware 比较——
    // finalAttemptId + finalGeneration 外壳不构成证明。
    if (finalExactView === null) {
      return {
        verdict: "insufficient",
        detail: "旧 terminal summary 缺少持久化 final exact identity（replay-only——root 重放门禁保留，terminal current 不可证明，不猜测）",
      };
    }
    if (identity === undefined) {
      return {
        verdict: "insufficient",
        detail: "terminal current 验证要求输入携带完整 exact identity（缺失即不可证明——不得 match）",
      };
    }
    const callerExact = treasuryExactAttemptIdentityOfFacts(
      transactionId,
      {
        ...identity,
        lineageId: proof.lineageId,
        lineageGeneration: proof.lineageGeneration,
        parentTransactionId: proof.parentTransactionId,
        lineageBindingDigest: proof.lineageBindingDigest,
      },
      treasuryProofClassOfIdentityFacts(identity),
    );
    if (callerExact === null) {
      return { verdict: "insufficient", detail: "输入 identity 无法构造完整 exact attempt identity（terminal current 不可证明）" };
    }
    const terminalRelation = treasuryTerminalExactIdentityRelation(callerExact, finalExactView.exactIdentity);
    if (terminalRelation === "conflict") {
      return {
        verdict: "conflict",
        detail: "输入 attempt 与 summary 持久化 final exact identity 不一致（digest/contract/cohort/durable/class/lowlevel/parent/binding 任一维度冲突）",
      };
    }
    if (terminalRelation === "insufficient") {
      return {
        verdict: "insufficient",
        detail: "输入 attempt 缺少 summary final exact identity 要求的身份维度（不可证明——不降级 match）",
      };
    }
    return { verdict: "match", authoritySource: "terminal", generationRole: "terminal_current", summary };
  }
  // summary 历史代：finalGeneration 只是边界——membership 由 exact proof 证明。
  if (!generationProofSource.healthy()) {
    return { verdict: "store_unhealthy", detail: `exact generation retirement store unhealthy: ${generationProofSource.unhealthyDetail() ?? "unknown"}` };
  }
  const retirementProof = generationProofSource.read(summary.lineageId, parsed.generation);
  if (retirementProof === undefined) {
    return {
      verdict: "insufficient",
      detail: `summary 存在但历史 generation ${String(parsed.generation)} 无 exact retirement proof（finalGeneration 只是边界不是 membership proof——pin）`,
    };
  }
  const proofError = verifyGenerationProof(retirementProof, transactionId, summary.lineageId, parsed.generation, expectedParent, expectedBinding, identity);
  if (proofError !== null) return { verdict: "conflict", detail: proofError };
  return { verdict: "match", authoritySource: "terminal", generationRole: "terminal_historical", summary };
}

/**
 * verdict 摘要（store_unhealthy / no_authority / insufficient 的冲突升级
 * 判定共用）：resolver 等消费方把非 match 折叠为 inconsistent 前的统一
 * detail 前缀。
 */
export function describeTreasurySemanticLineageVerdict(verdict: TreasurySemanticLineageVerdict): string {
  switch (verdict.verdict) {
    case "match":
      return `semantic lineage match（${verdict.authoritySource}/${verdict.generationRole}）`;
    default:
      return `semantic lineage ${verdict.verdict}: ${verdict.detail}`;
  }
}
