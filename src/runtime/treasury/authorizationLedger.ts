/**
 * Treasury authorization ledger（第十一轮 3.13.10，自 facade 抽出）。
 *
 * service 闭包私有的授权 ledger：token registry（WeakSet 防伪）与预算
 * 簿记（流出/容量占用、revision 失效清空）、opaque bundle registry 与
 * 签发、**批量原子 redemption**（只读预验证 → staged 发布 → 前缀回滚或
 * pre-execution durable fault authority）、只读 bundle 解析与 legs 预验证。
 * facade 不再直接持有 bundle Maps / token registry / 预算表（经本模块）；
 * 授权计算主体（readiness/query 口径）仍在 facade（调用本 ledger 簿记）。
 */

import type {
  TreasuryAuthorizationBundle,
  TreasuryAuthorizationConsumeResult,
  TreasuryAuthorizationRevisions,
  TreasuryAuthorizationToken,
} from "@/runtime/treasury/authorization";
import { postingsWithinAuthorizationScope, TREASURY_AUTHORIZATION_ACTIVE_LIMIT } from "@/runtime/treasury/authorization";
import type { TreasuryAuthorizationCohortFacts } from "@/runtime/treasury/authorization";
import { recordTreasuryWriteFault, exactMarkerFieldsOfAttemptFacts, TREASURY_WRITE_FAULT_DETAIL_MAX } from "@/runtime/treasury/writeFault";
import { writeTreasuryAuthorizationFaultEntry } from "@/runtime/treasury/authorizationFaults";
import type { TreasuryAuthorityLevel } from "@/runtime/treasury/authorityLevel";
import { computeTreasuryDurableIdentityDigest } from "@/runtime/treasury/durableIdentity";
import { findTreasuryPolicyResolver } from "@/runtime/treasury/policyAuthority";
import type { TreasuryPosting, TreasuryMetrics } from "@/runtime/treasury/types";

/**
 * service 闭包私有 bundle 记录（第十轮 3.12.3 建立、第十一轮移入 ledger）：
 * 全部授权 legs 与统一 cohort。同一 bundle 的 legs 在签发时原子校验。
 */
export interface TreasuryAuthorizationBundleRecord {
  readonly tokens: readonly TreasuryAuthorizationToken[];
  readonly contractId: string;
  readonly contractDigest: string;
  readonly transactionId: string;
  readonly actionKind: string;
  readonly adapterVersion: number;
  /** adapter registration identity（第十二轮：fault authority 完整身份输入）。 */
  readonly adapterRegistrationId?: string;
  /** 稳定 adapter/reconciler 语义身份（第十二轮 3.5）。 */
  readonly adapterSemanticIdentity?: string;
  /** owner canonical identity（"" = 无 owner 限定）。 */
  readonly ownerIdentity: string;
  /** policy capability identity（第十一轮 3.13.3）。 */
  readonly policyIdentity: string;
  /** policy registration identity（exact——redemption 与 registrationId 比对）。 */
  readonly policyRegistrationId: string;
  /** per-resource policy decision digest 排序拼接（Treasury 计算）。 */
  readonly policyDecisionDigest: string;
  /** policy emergency override（任一资源决策为 true 即 true）。 */
  readonly policyEmergencyOverride: boolean;
  readonly revisions: TreasuryAuthorizationRevisions;
  readonly serviceGeneration: number;
  readonly tick: number;
  /** bundle 身份指纹（16 hex；intent 持久化的 authorizationDigest）。 */
  readonly authorizationDigest: string;
  /** durable cohort 事实（第十一轮 3.13.4）。 */
  readonly cohort?: TreasuryAuthorizationCohortFacts;
  /** canonical cohort digest（Treasury 计算）。 */
  readonly cohortDigest?: string;
  /**
   * 【第十七轮第十节】rearm capability 绑定（tr1_ child contract 专属）：
   * capability binding digest、lineage digest、child ID、retry semantic
   * digest、parent identity——redemption 验证与 marker class-aware 身份用。
   */
  readonly rearmBindingDigest?: string;
  readonly rearmLineageId?: string;
  readonly rearmChildTransactionId?: string;
  readonly rearmRetrySemanticDigest?: string;
  readonly rearmParentTransactionId?: string;
  readonly rearmLineageBindingDigest?: string;
  readonly rearmAttemptGeneration?: number;
  state: "active" | "redeemed";
}

/** redemption 故障注入器（测试专用；六类注入点见 redeemAuthorizationBundleAtomic）。 */
let treasuryRedemptionFaultInjector: ((stage: string) => void) | null = null;

export function setTreasuryRedemptionFaultInjectorForTest(injector: ((stage: string) => void) | null): void {
  treasuryRedemptionFaultInjector = injector;
}

export interface TreasuryAuthorizationLedgerDeps {
  readonly serviceGeneration: number;
  readonly metrics: TreasuryMetrics;
  /** 当前 revision 快照（facade 闭包的 currentAuthorizationRevisions）。 */
  readonly currentRevisions: () => TreasuryAuthorizationRevisions;
}

export interface TreasuryIssuedBudget {
  readonly outflowKeys: readonly string[];
  readonly amount: number;
  readonly capacityKey?: string;
  readonly capacityAmount?: number;
  consumed: boolean;
}

export interface TreasuryAuthorizationLedger {
  // ── token registry 与预算簿记 ──────────────────────────────────────────
  /** 签发后注册 token 与预算占用（authorizeResourceUse 末段）。 */
  registerIssuedToken(token: TreasuryAuthorizationToken, budget: Omit<TreasuryIssuedBudget, "consumed">): void;
  hasToken(token: unknown): boolean;
  getRecord(token: TreasuryAuthorizationToken): TreasuryIssuedBudget | undefined;
  readonly activeCount: () => number;
  /** 授权计算：scope 内其它未消费授权的流出占用合计。 */
  budgetedOutflowFor(roomNames: readonly string[], locations: readonly string[], resource: string): number;
  /** 授权计算：capacity key 的其它授权容量占用。 */
  budgetedCapacityFor(capacityKey: string): number;
  /** revision 失效：全部授权与预算清空（返回失效数量）。 */
  invalidateOnRevisionChange(): number;
  /** 预算释放（消费/回滚路径共用；record 标记消费并移除注册）。 */
  releaseAuthorizationBudget(token: TreasuryAuthorizationToken, record: TreasuryIssuedBudget): void;
  /** 恢复消费标记与注册（redemption 前缀回滚路径）。 */
  restoreAuthorizationRecord(token: TreasuryAuthorizationToken, record: TreasuryIssuedBudget): void;
  // ── bundle registry 与 redemption ─────────────────────────────────────
  registerBundle(bundle: TreasuryAuthorizationBundle, record: TreasuryAuthorizationBundleRecord): void;
  /** 【第十七轮第十二节】transactionId 是否存在 active bundle（child 占用检测）。 */
  hasActiveBundleFor(transactionId: string): boolean;
  redeemAuthorizationBundleAtomic(
    bundle: TreasuryAuthorizationBundle,
    context: {
      readonly transactionId: string;
      readonly actionKind: string;
      readonly contractId?: string;
      readonly contractDigest?: string;
      readonly adapterVersion?: number;
      readonly postings: readonly TreasuryPosting[];
    },
  ): { readonly status: "ok"; readonly authorizationDigest: string; readonly cohort?: TreasuryAuthorizationCohortFacts; readonly cohortDigest?: string } | {
    readonly status: "rejected";
    readonly reason: string;
    readonly detail: string;
  };
  resolveAuthorizationBundleReadOnly(
    bundle: unknown,
    contract: { readonly transactionId: string; readonly actionKind: string; readonly digest: string; readonly adapterVersion: number },
  ): { readonly status: "ok"; readonly authorizationDigest: string; readonly contractId: string } | {
    readonly status: "rejected";
    readonly reason: string;
    readonly detail: string;
  };
  validateTreasuryAuthorizationForRedeem(
    tokens: readonly TreasuryAuthorizationToken[],
    contract: { readonly transactionId: string; readonly actionKind: string; readonly digest: string; readonly adapterVersion: number },
    postings: readonly TreasuryPosting[],
  ): { readonly status: "ok" } | { readonly status: "rejected"; readonly reason: string; readonly detail: string };
  /** 测试隔离：清空 heap ledger 状态。 */
  resetForTest(): void;
}

export function createTreasuryAuthorizationLedger(deps: TreasuryAuthorizationLedgerDeps): TreasuryAuthorizationLedger {
  const authorizationRegistry = new WeakSet<TreasuryAuthorizationToken>();
  const authorizationRecords = new Map<TreasuryAuthorizationToken, TreasuryIssuedBudget>();
  const authorizationOutflowTotals = new Map<string, number>();
  const authorizationCapacityTotals = new Map<string, number>();
  let authorizationLedgerRevisions: TreasuryAuthorizationRevisions | null = null;
  const bundleRecords = new WeakMap<object, TreasuryAuthorizationBundleRecord>();
  /** active bundle 的 transactionId 集合（child 占用检测 O(1) 视图）。 */
  const activeBundleTransactionIds = new Set<string>();
  let bundleSequence = 0;

  const registerIssuedToken = (token: TreasuryAuthorizationToken, budget: Omit<TreasuryIssuedBudget, "consumed">): void => {
    authorizationRegistry.add(token);
    for (const key of budget.outflowKeys) {
      authorizationOutflowTotals.set(key, (authorizationOutflowTotals.get(key) ?? 0) + budget.amount);
    }
    if (budget.capacityKey !== undefined && budget.capacityAmount !== undefined) {
      authorizationCapacityTotals.set(budget.capacityKey, (authorizationCapacityTotals.get(budget.capacityKey) ?? 0) + budget.capacityAmount);
    }
    authorizationRecords.set(token, { ...budget, consumed: false });
  };

  const releaseAuthorizationBudget = (token: TreasuryAuthorizationToken, record: TreasuryIssuedBudget): void => {
    for (const key of record.outflowKeys) {
      const remaining = (authorizationOutflowTotals.get(key) ?? 0) - record.amount;
      if (remaining <= 0) authorizationOutflowTotals.delete(key);
      else authorizationOutflowTotals.set(key, remaining);
    }
    if (record.capacityKey !== undefined && record.capacityAmount !== undefined) {
      const remaining = (authorizationCapacityTotals.get(record.capacityKey) ?? 0) - record.capacityAmount;
      if (remaining <= 0) authorizationCapacityTotals.delete(record.capacityKey);
      else authorizationCapacityTotals.set(record.capacityKey, remaining);
    }
    record.consumed = true;
    authorizationRecords.delete(token);
  };

  const restoreAuthorizationRecord = (token: TreasuryAuthorizationToken, record: TreasuryIssuedBudget): void => {
    for (const key of record.outflowKeys) {
      authorizationOutflowTotals.set(key, (authorizationOutflowTotals.get(key) ?? 0) + record.amount);
    }
    if (record.capacityKey !== undefined && record.capacityAmount !== undefined) {
      authorizationCapacityTotals.set(record.capacityKey, (authorizationCapacityTotals.get(record.capacityKey) ?? 0) + record.capacityAmount);
    }
    const legacy = authorizationRecords.get(token);
    if (legacy === undefined) {
      authorizationRecords.set(token, { ...record, consumed: false });
    } else {
      legacy.consumed = false;
    }
  };

  const invalidateOnRevisionChange = (): number => {
    const revisions = deps.currentRevisions();
    if (
      authorizationLedgerRevisions === null ||
      authorizationLedgerRevisions.commitmentRevision !== revisions.commitmentRevision ||
      authorizationLedgerRevisions.projectionRevision !== revisions.projectionRevision ||
      authorizationLedgerRevisions.quarantineRevision !== revisions.quarantineRevision ||
      authorizationLedgerRevisions.intentRevision !== revisions.intentRevision ||
      authorizationLedgerRevisions.reservationStoreRevision !== revisions.reservationStoreRevision
    ) {
      const invalidated = authorizationRecords.size;
      authorizationRecords.clear();
      authorizationOutflowTotals.clear();
      authorizationCapacityTotals.clear();
      authorizationLedgerRevisions = revisions;
      return invalidated;
    }
    return 0;
  };

  const validateTreasuryAuthorizationForRedeem = (
    tokens: readonly TreasuryAuthorizationToken[],
    contract: { readonly transactionId: string; readonly actionKind: string; readonly digest: string; readonly adapterVersion: number },
    postings: readonly TreasuryPosting[],
  ): { readonly status: "ok" } | { readonly status: "rejected"; readonly reason: string; readonly detail: string } => {
    if (!Array.isArray(tokens) || tokens.length === 0) {
      return { status: "rejected", reason: "authorization_invalid", detail: "redemption 预验证须携带非空 token 集合" };
    }
    const seen = new Set<TreasuryAuthorizationToken>();
    for (const token of tokens) {
      if (!token || typeof token !== "object" || !authorizationRegistry.has(token)) {
        return { status: "rejected", reason: "invalid_token", detail: "token 未在本服务实例签发（伪造对象/JSON 副本/跨实例一律无效）" };
      }
      if (seen.has(token)) {
        return { status: "rejected", reason: "invalid_token", detail: "bundle 内出现重复 token（对象身份重复——拒绝）" };
      }
      seen.add(token);
      const record = authorizationRecords.get(token);
      if (record === undefined) {
        return { status: "rejected", reason: "already_consumed", detail: "token 已消费或已随 revision 失效释放" };
      }
      if (token.serviceGeneration !== deps.serviceGeneration) {
        return { status: "rejected", reason: "cross_generation", detail: "token 签发的 service generation 已失效" };
      }
      if (token.tick !== Game.time) {
        return { status: "rejected", reason: "cross_tick", detail: `token 于 tick ${String(token.tick)} 签发（当前 ${String(Game.time)}）——跨 tick 失效` };
      }
      const revisions = deps.currentRevisions();
      if (
        token.revisions.commitmentRevision !== revisions.commitmentRevision ||
        token.revisions.projectionRevision !== revisions.projectionRevision ||
        token.revisions.quarantineRevision !== revisions.quarantineRevision ||
        token.revisions.intentRevision !== revisions.intentRevision ||
        token.revisions.reservationStoreRevision !== revisions.reservationStoreRevision
      ) {
        return { status: "rejected", reason: "revision_mismatch", detail: "token 绑定的 revision 快照已过期（commitment/projection/quarantine/intent/reservation store 任一变化）" };
      }
      if (token.transactionId !== contract.transactionId) {
        return { status: "rejected", reason: "transaction_mismatch", detail: `token 绑定 transactionId ${token.transactionId}，contract ${contract.transactionId}` };
      }
      if (token.actionKind !== contract.actionKind) {
        return { status: "rejected", reason: "invalid_token", detail: `token 绑定 actionKind ${token.actionKind}，contract ${contract.actionKind}` };
      }
      if (token.contractDigest !== contract.digest) {
        return { status: "rejected", reason: "invalid_token", detail: "token 绑定的 contract digest 与实际 contract 不一致" };
      }
      if (token.adapterVersion !== contract.adapterVersion) {
        return { status: "rejected", reason: "invalid_token", detail: `token 绑定 adapter version ${String(token.adapterVersion)}，contract ${String(contract.adapterVersion)}` };
      }
      const scopeError = postingsWithinAuthorizationScope(token, postings);
      if (scopeError !== null) {
        return { status: "rejected", reason: "scope_violation", detail: scopeError };
      }
    }
    // 联合覆盖：每个负 posting 必须被至少一个 token 覆盖（resource+room+
    // location 精确匹配）。
    for (const posting of postings) {
      if (posting.delta >= 0) continue;
      const covered = tokens.some(
        (token) => token.resource === posting.resource && token.rooms.includes(posting.roomName) && token.locations.includes(posting.locationKind),
      );
      if (!covered) {
        return {
          status: "rejected",
          reason: "scope_violation",
          detail: `posting ${posting.roomName}:${posting.locationKind}:${posting.resource} 的流出未被任何 token 覆盖`,
        };
      }
    }
    return { status: "ok" };
  };

  const redeemAuthorizationBundleAtomic = (
    bundle: TreasuryAuthorizationBundle,
    context: {
      readonly transactionId: string;
      readonly actionKind: string;
      readonly contractId?: string;
      readonly contractDigest?: string;
      readonly adapterVersion?: number;
      readonly postings: readonly TreasuryPosting[];
    },
  ): { readonly status: "ok"; readonly authorizationDigest: string; readonly cohort?: TreasuryAuthorizationCohortFacts; readonly cohortDigest?: string } | {
    readonly status: "rejected";
    readonly reason: string;
    readonly detail: string;
  } => {
    const reject = (reason: string, detail: string): { readonly status: "rejected"; readonly reason: string; readonly detail: string } => ({
      status: "rejected" as const,
      reason,
      detail,
    });
    const record = bundleRecords.get(bundle);
    if (record === undefined) {
      return reject("invalid_bundle", "bundle 未在本 service 闭包签发（伪造对象/JSON round-trip 副本/跨实例一律无效）");
    }
    if (record.state !== "active") {
      return reject("bundle_redeemed", `bundle 已消费（单次 redemption；authorizationDigest ${record.authorizationDigest}）`);
    }
    if (record.transactionId !== context.transactionId) {
      return reject("transaction_mismatch", `bundle 绑定 transactionId ${record.transactionId}，执行 ${context.transactionId}`);
    }
    if (record.actionKind !== context.actionKind) {
      return reject("action_kind_mismatch", `bundle 绑定 actionKind ${record.actionKind}，执行 ${context.actionKind}`);
    }
    if (context.contractId !== undefined && record.contractId !== context.contractId) {
      return reject("contract_mismatch", `bundle contractId ${record.contractId} 与执行声明 ${context.contractId} 不一致`);
    }
    if (context.contractDigest !== undefined && record.contractDigest !== context.contractDigest) {
      return reject("contract_mismatch", "bundle contractDigest 与执行声明不一致");
    }
    if (context.adapterVersion !== undefined && record.adapterVersion !== context.adapterVersion) {
      return reject("contract_mismatch", `bundle adapterVersion v${String(record.adapterVersion)} 与执行声明 v${String(context.adapterVersion)} 不一致`);
    }
    if (record.serviceGeneration !== deps.serviceGeneration) {
      return reject("cross_generation", "bundle 由旧 Treasury service 签发（global reset 后必须重新授权）");
    }
    if (record.tick !== Game.time) {
      return reject("cross_tick", `bundle 于 tick ${String(record.tick)} 签发（当前 ${String(Game.time)}）——跨 tick 失效`);
    }
    const revisions = deps.currentRevisions();
    if (
      record.revisions.commitmentRevision !== revisions.commitmentRevision ||
      record.revisions.projectionRevision !== revisions.projectionRevision ||
      record.revisions.quarantineRevision !== revisions.quarantineRevision ||
      record.revisions.intentRevision !== revisions.intentRevision ||
      record.revisions.reservationStoreRevision !== revisions.reservationStoreRevision
    ) {
      return reject("revision_mismatch", "bundle 绑定的 revision cohort 已过期（commitment/projection/quarantine/intent/reservation 任一变化——须重新授权）");
    }
    // 【第十一轮 3.13.3】policy 失效校验：当前 policy registry 的 exact
    // registration identity 必须与 bundle 签发时一致（registrationId 比对
    //——字符串前缀比较已删除）。
    const currentPolicyRegistration = findTreasuryPolicyResolver();
    if (
      currentPolicyRegistration === undefined ||
      currentPolicyRegistration.registrationId !== record.policyRegistrationId
    ) {
      return reject(
        "policy_invalidated",
        `policy authority 已变化或缺失（bundle 绑定 registration ${record.policyRegistrationId.slice(0, 12)}，当前 ${currentPolicyRegistration === undefined ? "无注册" : currentPolicyRegistration.registrationId.slice(0, 12)}）——须重新授权`,
      );
    }
    // 只读预验证全部 legs（零状态变化；任一失败时前 N−1 个 leg 不受影响）。
    const prevalidated = validateTreasuryAuthorizationForRedeem(
      record.tokens,
      {
        transactionId: record.transactionId,
        actionKind: record.actionKind,
        digest: record.contractDigest,
        adapterVersion: record.adapterVersion,
      },
      context.postings,
    );
    if (prevalidated.status === "rejected") {
      return reject(prevalidated.reason, `legs 预验证失败: ${prevalidated.detail}`);
    }
    // staged 发布（注入点边界 + 前缀回滚）。
    interface AppliedLeg {
      readonly token: TreasuryAuthorizationToken;
      readonly outflowKeys: readonly string[];
      readonly amount: number;
      readonly capacityKey?: string;
      readonly capacityAmount?: number;
    }
    const applied: AppliedLeg[] = [];
    const guard = (stage: string): void => {
      if (treasuryRedemptionFaultInjector !== null) treasuryRedemptionFaultInjector(stage);
    };
    const rollbackApplied = (): void => {
      // 前缀完整回滚：预算/容量恢复、消费标记与 record 注册恢复。
      for (const leg of applied) {
        restoreAuthorizationRecord(leg.token, {
          outflowKeys: leg.outflowKeys,
          amount: leg.amount,
          ...(leg.capacityKey !== undefined ? { capacityKey: leg.capacityKey } : {}),
          ...(leg.capacityAmount !== undefined ? { capacityAmount: leg.capacityAmount } : {}),
          consumed: true,
        });
      }
    };
    try {
      for (let index = 0; index < record.tokens.length; index += 1) {
        const token = record.tokens[index];
        const tokenRecord = authorizationRecords.get(token);
        if (tokenRecord === undefined) {
          throw new Error(`leg ${String(index)} authorization record 缺失（内部不一致）`);
        }
        applied.push({
          token,
          outflowKeys: tokenRecord.outflowKeys,
          amount: tokenRecord.amount,
          ...(tokenRecord.capacityKey !== undefined ? { capacityKey: tokenRecord.capacityKey } : {}),
          ...(tokenRecord.capacityAmount !== undefined ? { capacityAmount: tokenRecord.capacityAmount } : {}),
        });
        releaseAuthorizationBudget(token, tokenRecord);
        guard(index === 0 ? "first_leg" : index === record.tokens.length - 1 ? "last_leg" : "middle_leg");
      }
      guard("before_budget_publish");
      guard("before_tentative_handoff");
      guard("before_bundle_state");
      record.state = "redeemed";
    } catch (error) {
      rollbackApplied();
      // 【第十一轮 3.13.1 / 第十二轮 3.1】staged publication 协议：先建立
      // 可读回且完整身份一致的 durable not-started authority，再发布
      // write-fault marker。authority 写入结果**不得忽略**：
      // - written / already_present（完整 identity 一致）：发布正常
      //   internal_authorization_fault marker（acknowledge-rolled-back 可解除）；
      // - rejected（store_fatal / capacity_exhausted / identity_conflict /
      //   invalid_entry）：绝不发布无 authority 的普通 marker——发布显式
      //   forensic phase marker（fail closed，仅显式 forensic 通道可解除）。
      const faultIdentity = computeTreasuryDurableIdentityDigest({
        transactionId: context.transactionId,
        digest: record.contractDigest,
        ...(record.contractId !== undefined ? { contractId: record.contractId } : {}),
        ...(record.contractDigest !== undefined ? { contractDigest: record.contractDigest } : {}),
        ...(record.adapterRegistrationId !== undefined ? { adapterRegistrationId: record.adapterRegistrationId } : {}),
        ...(record.adapterSemanticIdentity !== undefined ? { adapterSemanticIdentity: record.adapterSemanticIdentity } : {}),
        actionKind: context.actionKind,
        postings: context.postings.map((leg) => ({ roomName: leg.roomName, locationKind: leg.locationKind, resource: leg.resource, delta: leg.delta })),
        ...(record.cohortDigest !== undefined ? { authorizationCohortDigest: record.cohortDigest } : {}),
        ...(record.ownerIdentity !== "" ? { ownerIdentity: record.ownerIdentity } : {}),
        ...(record.policyIdentity !== "" ? { policyIdentity: record.policyIdentity } : {}),
        source: "bundle-redemption",
      });
      // 【第十四轮第九节 9.4】production 定级边界：bundle-redemption 是
      // contract 路径——cohort 成对存在（redemption 故障前的完整授权事实）
      // → modern（fault 矩阵校验通过才写入）；**cohort 缺失（partial-
      // modern）→ forensic 隔离（内部不变量破坏，不得写 lowlevel）**。
      const faultAuthorityLevel: TreasuryAuthorityLevel =
        record.cohort !== undefined && record.cohortDigest !== undefined ? "modern" : "forensic";
      const faultWrite = writeTreasuryAuthorizationFaultEntry({
        transactionId: context.transactionId,
        authorityLevel: faultAuthorityLevel,
        digest: record.contractDigest,
        ...(record.contractId !== undefined ? { contractId: record.contractId } : {}),
        ...(record.contractDigest !== undefined ? { contractDigest: record.contractDigest } : {}),
        actionKind: context.actionKind,
        ...(record.adapterVersion !== undefined ? { adapterVersion: record.adapterVersion } : {}),
        ...(record.adapterRegistrationId !== undefined ? { adapterRegistrationId: record.adapterRegistrationId } : {}),
        ...(record.adapterSemanticIdentity !== undefined ? { adapterSemanticIdentity: record.adapterSemanticIdentity } : {}),
        ...(record.authorizationDigest !== undefined ? { authorizationDigest: record.authorizationDigest } : {}),
        ...(record.cohort !== undefined ? { authorizationCohort: { ...record.cohort, revisions: { ...record.cohort.revisions }, authorizationLegDigests: [...record.cohort.authorizationLegDigests] } } : {}),
        ...(record.cohortDigest !== undefined ? { authorizationCohortDigest: record.cohortDigest } : {}),
        ...(record.ownerIdentity !== "" ? { ownerIdentity: record.ownerIdentity } : {}),
        ...(record.policyIdentity !== "" ? { policyIdentity: record.policyIdentity } : {}),
        // 【Remediation V 六】rearm lineage 四字段整体透传（tr1_ redemption
        // fault 的 durable authority 携带完整 lineage proof——缺失时 store
        // 写入前拒绝，不发布永远无法 discharge 的 partial authority）。
        ...(record.rearmLineageId !== undefined ? { lineageId: record.rearmLineageId } : {}),
        ...(record.rearmAttemptGeneration !== undefined ? { lineageGeneration: record.rearmAttemptGeneration } : {}),
        ...(record.rearmParentTransactionId !== undefined ? { parentTransactionId: record.rearmParentTransactionId } : {}),
        ...(record.rearmLineageBindingDigest !== undefined ? { lineageBindingDigest: record.rearmLineageBindingDigest } : {}),
        postings: context.postings.map((leg) => ({ roomName: leg.roomName, locationKind: leg.locationKind, resource: leg.resource, delta: leg.delta })),
        faultTick: Game.time,
        outcome: "not_started",
        rollbackConfirmed: true,
        source: "bundle-redemption",
        durableIdentityDigest: faultIdentity,
        detail: `原子 redemption 中断并回滚（${String(error instanceof Error ? error.message : error).slice(0, 128)}）——状态零变化`,
      });
      const authorityPublished = faultWrite.status === "written" || faultWrite.status === "already_present";
      const faultWriteDetail =
        faultWrite.status === "rejected"
          ? `${faultWrite.reason}: ${faultWrite.detail}`
          : `unexpected status: ${faultWrite.status}`;
      // 状态已一致回滚，但发布序列中断本身按 internal authorization fault
      // 处理：写入 marker 阻断后续 writer（审计要求显式确认，不静默）。
      // 【第十三轮第十一节→第二十二轮 v4】marker 保存 redemption 故障前已
      // 计算的完整 attempt identity（contract/cohort digest + durable
      // identity）——forensic resolution 的 tombstone 绑定同一 identity。
      // 【第二十二轮】统一 v4 exact marker（显式 modern-contract profile +
      // 顶层完整事实——不再写旧式嵌套 attemptIdentity / v2 顶层子集两套
      // 表示；identity 不完整时降级保留 marker 基础字段（legacy 视图，
      // relation 判 insufficient fail closed））。
      recordTreasuryWriteFault({
        transactionId: context.transactionId,
        digest: record.contractDigest,
        tick: Game.time,
        kind: context.actionKind,
        source: "bundle-redemption",
        phase: authorityPublished ? "internal_authorization_fault" : "internal_authorization_fault_forensic",
        status: "unresolved",
        recordedAt: Game.time,
        ...(exactMarkerFieldsOfAttemptFacts({
          // bundle redemption 是 contract 路径——identity-bound；binding/
          // generation/lineageId/parent 由 rearm bundle record 注入（【V 六】
          // parentTransactionId 一并透传——marker v4 lineage 四字段完整）。
          identityProfile: "modern-contract",
          ...(record.contractDigest !== undefined ? { contractDigest: record.contractDigest } : {}),
          ...(record.cohortDigest !== undefined ? { authorizationCohortDigest: record.cohortDigest } : {}),
          ...(faultIdentity !== undefined ? { durableIdentityDigest: faultIdentity } : {}),
          ...(record.rearmLineageId !== undefined ? { lineageId: record.rearmLineageId } : {}),
          ...(record.rearmLineageBindingDigest !== undefined ? { lineageBindingDigest: record.rearmLineageBindingDigest } : {}),
          ...(record.rearmAttemptGeneration !== undefined ? { lineageGeneration: record.rearmAttemptGeneration } : {}),
          ...(record.rearmParentTransactionId !== undefined ? { parentTransactionId: record.rearmParentTransactionId } : {}),
        }) ?? {}),
        detail: authorityPublished
          ? `原子 redemption 中断并回滚（${String(error instanceof Error ? error.message : error).slice(0, TREASURY_WRITE_FAULT_DETAIL_MAX)}）——状态零变化，marker 阻断后续 writer`
          : `原子 redemption 中断并回滚，但 durable fault authority 写入失败（${faultWriteDetail}）——forensic fail closed：authority 缺失，仅显式 forensic 通道可解除`,
      });
      deps.metrics.authorizationInvalidated += 1;
      return reject(
        "internal_authorization_fault",
        authorityPublished
          ? "原子 redemption 中断：全部预算/消费标记已回滚，durable fault authority 已建立，internal_authorization_fault marker 已写入（阻断后续 writer）"
          : "原子 redemption 中断：全部预算/消费标记已回滚，但 durable fault authority 写入失败——forensic marker 已写入（显式 forensic 解除通道处理）",
      );
    }
    return {
      status: "ok",
      authorizationDigest: record.authorizationDigest,
      ...(record.cohort !== undefined ? { cohort: record.cohort } : {}),
      ...(record.cohortDigest !== undefined ? { cohortDigest: record.cohortDigest } : {}),
    };
  };

  const resolveAuthorizationBundleReadOnly = (
    bundle: unknown,
    contract: { readonly transactionId: string; readonly actionKind: string; readonly digest: string; readonly adapterVersion: number },
  ): { readonly status: "ok"; readonly authorizationDigest: string; readonly contractId: string } | {
    readonly status: "rejected";
    readonly reason: string;
    readonly detail: string;
  } => {
    if (!bundle || typeof bundle !== "object" || (bundle as { __brand?: string }).__brand !== "treasury-authorization-bundle") {
      return { status: "rejected", reason: "authorization_invalid", detail: "authorization 必须是 service 签发的 opaque bundle（裸 token/token 数组/手工构造对象不是 production 输入）" };
    }
    const record = bundleRecords.get(bundle);
    if (record === undefined) {
      return { status: "rejected", reason: "authorization_invalid", detail: "bundle 未在本 service 闭包签发（伪造对象/JSON round-trip 副本一律无效）" };
    }
    if (
      record.contractDigest !== contract.digest ||
      record.transactionId !== contract.transactionId ||
      record.actionKind !== contract.actionKind ||
      record.adapterVersion !== contract.adapterVersion
    ) {
      return { status: "rejected", reason: "contract_mismatch", detail: "授权 bundle 与实际 contract 不匹配（contractDigest/transactionId/actionKind/adapterVersion 任一不一致）" };
    }
    return { status: "ok", authorizationDigest: record.authorizationDigest, contractId: record.contractId };
  };

  return {
    registerIssuedToken,
    hasToken: (token: unknown) => typeof token === "object" && token !== null && authorizationRegistry.has(token as TreasuryAuthorizationToken),
    getRecord: (token) => authorizationRecords.get(token),
    activeCount: () => authorizationRecords.size,
    budgetedOutflowFor: (roomNames, locations, resource) => {
      let total = 0;
      for (const roomName of roomNames) {
        for (const kind of locations) {
          total += authorizationOutflowTotals.get(`${roomName}\u0000${kind}\u0000${resource}`) ?? 0;
        }
      }
      return total;
    },
    budgetedCapacityFor: (capacityKey) => authorizationCapacityTotals.get(capacityKey) ?? 0,
    invalidateOnRevisionChange,
    releaseAuthorizationBudget,
    restoreAuthorizationRecord,
    registerBundle: (bundle, record) => {
      bundleRecords.set(bundle, record);
      // 【第十七轮第十二节】child 占用检测的 heap 侧视图（active bundle 的
      // transactionId 集合——O(1) 查询）。
      activeBundleTransactionIds.add(record.transactionId);
    },
    hasActiveBundleFor: (transactionId: string) => activeBundleTransactionIds.has(transactionId),
    redeemAuthorizationBundleAtomic,
    resolveAuthorizationBundleReadOnly,
    validateTreasuryAuthorizationForRedeem,
    resetForTest: () => {
      authorizationRecords.clear();
      authorizationOutflowTotals.clear();
      authorizationCapacityTotals.clear();
      authorizationLedgerRevisions = null;
    },
  };
}

export { TREASURY_AUTHORIZATION_ACTIVE_LIMIT };
export type { TreasuryAuthorizationConsumeResult };
