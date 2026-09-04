/**
 * Treasury canonical action contract 与注册 adapter registry（第八轮建立、
 * 第九轮升级安全 canonical encoding + adapter version 绑定 + 完整结构
 * incarnation 验证）。
 *
 * 动机：executePreparedAction(input, arbitraryCallback) 仍允许"postings 声称
 * 一种行为、callback 实际执行另一种行为"（声称发送 1 单位实发 10,000）。
 * 本模块建立受注册的 action contract 机制：
 *
 * - **contract** 由 Treasury（或受注册 adapter）根据授权构造：canonical
 *   action args → adapter.derivePostings 确定性派生 postings——调用者不能
 *   独立提供"Game API 参数"与"postings"两套可不一致事实；
 * - **adapter 契约**（每个 action kind 注册一次）：
 *   canonical action args → validate → derive postings → execute exact
 *   Game API（恰好一次）→ classify result → reconcile from post-observation；
 * - **canonical encoding（第九轮 4.11）**：args 先经 canonicalEncoding
 *   canonicalize（冻结深拷贝 + 确定性文本），validate/derivePostings/execute
 *   与 digest 全部观察同一 canonical frozen args；digest 为 AC2 前缀（绑定
 *   encoding version + adapter version + canonical args + canonical postings
 *   + 结构身份），消除 JSON.stringify 的键序敏感与 undefined/NaN 静默碰撞；
 * - **adapter version 绑定（第九轮）**：contract 绑定构建时的 adapter
 *   version；执行时 registry 内 adapter version 必须一致（版本演进后旧
 *   contract 一律失效，须重新构建与授权）；
 * - **结构 incarnation（第九轮 4.12）**：受控 structureBindings 接口
 *   （roomName + locationKind 受控枚举——不接受任意字符串）；contract 快照
 *   覆盖 posting locations + 全部声明结构；执行前 fresh observation 必需
 *   （配额耗尽拒绝执行——不退回 shared 降低验证等级）并逐结构重验；
 * - **注册边界**：registerTreasuryActionAdapter 仅 actionContracts.ts 自身
 *   与测试可调用（架构测试守护）；重复 kind 注册拒绝；
 * - **执行入口** executeTreasuryActionContract：adapter 存在/kind/version
 *   匹配 → contract 冻结校验 → 结构 incarnation 校验（fresh）→ 授权 token
 *   匹配预校验（digest/transactionId/覆盖——先于消费）→ 消费 → 经
 *   executePreparedAction 走第八轮唯一安全顺序（durable intent →
 *   executing → adapter.execute 恰好一次 → commit/abort）；
 * - 本轮不接任何真实生产 writer：内置测试 adapter（多 posting fixture +
 *   可编排副作用与 reconciler 结论）。
 */

import type { TreasuryService } from "@/runtime/treasury/facade";
import type { TreasuryAuthorizationBundle } from "@/runtime/treasury/authorization";
import { TREASURY_WRITER_KERNEL, type TreasuryKernelHolder } from "@/runtime/treasury/kernelChannel";
import type {
  TreasurySafeExecuteResult,
  TreasuryObservationScope,
  TreasuryPosting,
  TreasuryStructureBindingDescriptor,
} from "@/runtime/treasury/types";
import { TREASURY_STRUCTURE_DESCRIPTOR_VERSION } from "@/runtime/treasury/types";
import { hashTreasuryCanonicalString } from "@/runtime/treasury/transactionId";
import {
  checkTreasuryServiceIssuedAttemptId,
  parseTreasuryIssuedInitialAttemptId,
} from "@/runtime/treasury/attemptIssuer";
import { canonicalizeTreasuryAdapterRetryFacts } from "@/runtime/treasury/adapterRetrySemantics";
import { canonicalizeTreasuryActionArgs, TREASURY_CANONICAL_ENCODING_VERSION } from "@/runtime/treasury/canonicalEncoding";

const ACTION_KIND_MAX = 128;
const VALID_LOCATION_KINDS: ReadonlySet<string> = new Set<string>(["storage", "terminal"]);
const VALID_RESOURCES: ReadonlySet<string> = new Set<string>(RESOURCES_ALL);
/** contract 可声明的结构快照上限（posting locations + structureBindings）。 */
const STRUCTURE_SNAPSHOT_MAX = 16;
/** durable reconciliation payload 的有界上限（有界对账事实，不持久化完整 args）。 */
const DURABLE_FACTS_PAYLOAD_MAX = 512;
const DURABLE_FACTS_VERSION_MAX = 1_000_000;

/** adapter 对账结论（与 faultResolution 的 resolution conclusion 同语义）。 */
export type TreasuryActionReconcilerConclusion = "observed_committed" | "observed_not_executed" | "still_uncertain";

/**
 * reconciler 输入（第九轮完整化）：完整 contract-specific durable facts——
 * 不再使用 `postings[0].resource` 或单一负数 amount 汇总这类过度简化事实。
 */
export interface TreasuryActionReconcilerFacts {
  readonly actionKind: string;
  readonly transactionId: string;
  readonly contractId?: string;
  readonly contractDigest?: string;
  readonly adapterVersion?: number;
  /** canonical postings 全量（reconciler 自行派生所需聚合）。 */
  readonly postings: readonly TreasuryPosting[];
  /** adapter.durableFacts 的版本化有界对账事实（authority 携带时）。 */
  readonly durablePayload?: string;
  readonly durablePayloadVersion?: number;
  /** 完整 structure descriptors（第十一轮 3.13.9：reconciler 获得完整声明）。 */
  readonly structureDescriptors?: readonly TreasuryStructureBindingDescriptor[];
}

/**
 * 受控结构引用（第九轮建立、第十一轮 3.13.9 升级完整 descriptor）：adapter
 * 声明额外 action-relevant 结构的唯一形状。bindingKind 缺省按 objectId 推导
 *（有 objectId → game_object，否则 governed_location）；role 缺省
 * auxiliary（posting 自动 binding 的 role 由 Treasury 派生：负腿 source、
 * 正腿 target）；required 缺省 true。全部字段进入 AC4 digest 与 durable
 * authority（同结构不同 role 不静默合并）。
 */
export interface TreasuryActionStructureBinding {
  readonly roomName: string;
  readonly locationKind: "storage" | "terminal";
  /** binding kind 显式声明（缺省按 objectId 推导）。 */
  readonly bindingKind?: "governed_location" | "game_object";
  /** action-specific role（受控枚举；缺省 auxiliary）。 */
  readonly role?: "source" | "target" | "fee_source" | "production_structure" | "auxiliary";
  /** required/optional 语义（缺省 true——required 结构缺失构建拒绝）。 */
  readonly required?: boolean;
  /** 快照 label（缺省 `${roomName}:${locationKind}`；仅诊断，不作权威 key）。 */
  readonly label?: string;
  /**
   * explicit game object ID binding（第十轮 3.12.11 受控种类之二）：提供时
   * 按 game_object binding 验证（对象存在、可选 expectedType/expectedRoom
   * 匹配；incarnation = 对象 id 本身）；roomName/locationKind 仍须提供
   *（诊断与 room 归属声明）。
   */
  readonly objectId?: string;
  readonly expectedType?: string;
  readonly expectedRoom?: string;
}

/** adapter 提供的有界版本化 durable reconciliation payload。 */
export interface TreasuryDurableFacts {
  readonly version: number;
  readonly payload: string;
}

/**
 * 受注册的 action adapter 契约。execute 必须恰好调用对应 Game API 一次并
 * 返回 {ok, ...}；reconcile 依据 post-fault observation 判定动作是否已发生
 * （未提供 reconcile 的 kind 不可签发 reconciliation capability）。validate/
 * derivePostings/structureBindings/durableFacts/execute 观察同一个 canonical
 * frozen args（第九轮）。
 */
export interface TreasuryActionAdapter<TArgs = unknown, TResult extends { ok: boolean } = { ok: boolean }> {
  readonly kind: string;
  readonly version: number;
  /**
   * 【第十二轮 3.5】稳定的 adapter/reconciler 语义身份（显式声明、随代码
   * 版本化）：不依赖当前 global 的注册顺序（registrationId 含 global 内
   * 注册序号，只能证明同一 global 内实现未替换，无法跨 global reset 证明
   * reconciler 语义一致）。语义变化时必须显式更换该字符串；声明不变即
   * 作者承诺 reconcile/derive/validate 语义与旧 global 一致——global reset
   * 后同 kind/version 但 stable semantic identity 不同的一切旧 authority
   * 不得由当前 reconciler 解释。不得以函数源码字符串/对象地址/注册序号等
   * 不稳定值充当。
   */
  readonly semanticIdentity: string;
  validate(args: unknown): string | null;
  derivePostings(args: TArgs): readonly { roomName: string; locationKind: string; resource: string; delta: number }[];
  execute(args: TArgs): TResult;
  /** 额外 action-relevant 结构（受控形状；执行前全部重验 incarnation）。 */
  structureBindings?(args: TArgs): readonly TreasuryActionStructureBinding[];
  /** 有界版本化对账事实（持久 intent 的 durable payload 来源）。 */
  durableFacts?(args: TArgs): TreasuryDurableFacts | null;
  /**
   * 【第十八轮 24.12】显式版本化 retry semantic facts：从 canonical frozen
   * args 派生有界事实（string/number/boolean Record——必须覆盖全部会改变
   * 真实 Game API 调用语义的参数）。与 durableFacts 职责分离；未实现 →
   * 动作正常执行、not-executed 后 non-rearmable（不猜测）。
   */
  retryFacts?(args: TArgs): Record<string, string | number | boolean> | null;
  reconcile?(facts: TreasuryActionReconcilerFacts, observation: unknown): TreasuryActionReconcilerConclusion;
}

// ── registry（第十一轮 3.13.2：immutable registration records） ───────────────

/**
 * 注册快照的公开视图（冻结）：调用方可见的 adapter 形状。函数引用在注册时
 * 固定——调用方事后修改原 adapter 对象不影响 registry 内实现；读 API 不
 * 泄漏内部 record（registry generation/registeredAtTick 仅闭包可见）。
 */
export interface TreasuryRegisteredActionAdapter<TArgs = unknown, TResult extends { ok: boolean } = { ok: boolean }> {
  readonly kind: string;
  readonly version: number;
  /** 稳定语义身份（注册时显式声明并冻结；跨 global reset 有效的 reconciler 语义锚点）。 */
  readonly semanticIdentity: string;
  /**
   * registration identity 组成（第十一轮 3.13.2）：`hash(kind:version:seq)`
   * ——每次合法注册唯一；同 version 不同实现的 test-only 替换（unregister 后
   * 重注册）产生新 registrationId，旧 contract 因 identity 不匹配失效。
   */
  readonly registrationId: string;
  validate(args: unknown): string | null;
  derivePostings(args: TArgs): readonly { roomName: string; locationKind: string; resource: string; delta: number }[];
  execute(args: TArgs): TResult;
  structureBindings?(args: TArgs): readonly TreasuryActionStructureBinding[];
  durableFacts?(args: TArgs): TreasuryDurableFacts | null;
  /**
   * 【第十八轮 24.12】显式版本化 retry semantic facts：从 canonical frozen
   * args 派生有界事实（string/number/boolean Record——必须覆盖全部会改变
   * 真实 Game API 调用语义的参数）。与 durableFacts 职责分离；未实现 →
   * 动作正常执行、not-executed 后 non-rearmable（不猜测）。
   */
  retryFacts?(args: TArgs): Record<string, string | number | boolean> | null;
  reconcile?(facts: TreasuryActionReconcilerFacts, observation: unknown): TreasuryActionReconcilerConclusion;
}

/** 内部 registration record（registry 闭包私有；公开视图 + 装配元数据）。 */
interface TreasuryAdapterRegistrationRecord {
  /** 冻结公开视图（find 返回值——不含装配元数据）。 */
  readonly view: TreasuryRegisteredActionAdapter<never, never>;
  readonly registryGeneration: number;
  readonly registeredAtTick: number;
}

const adapterRegistry = new Map<string, TreasuryAdapterRegistrationRecord>();
/** registrationId 种子（每次成功注册 +1；registration identity 的唯一性成分）。 */
let adapterRegistrationSequence = 0;
/** registry revision（成功注册/版本演进计数；诊断与 contract/bundle 间接绑定）。 */
let adapterRegistryRevision = 0;
/** seal 标志：生产装配完成后阻止运行中动态注册（第十一轮 3.13.2）。 */
let adapterRegistrySealed = false;

export type TreasuryAdapterRegistrationResult =
  | { readonly status: "registered" }
  | { readonly status: "rejected"; readonly detail: string };

/** adapter 形状校验（注册前）。 */
function validateAdapterShape(adapter: TreasuryActionAdapter): string | null {
  if (!adapter || typeof adapter !== "object") return "adapter 非对象";
  if (typeof adapter.kind !== "string" || adapter.kind.length === 0 || adapter.kind.length > ACTION_KIND_MAX) {
    return "adapter.kind 非法（须为 1..128 字符）";
  }
  if (typeof adapter.version !== "number" || !Number.isSafeInteger(adapter.version) || adapter.version <= 0) {
    return "adapter.version 须为正安全整数";
  }
  if (typeof adapter.semanticIdentity !== "string" || adapter.semanticIdentity.length === 0 || adapter.semanticIdentity.length > 128) {
    return "adapter.semanticIdentity 非法（须为 1..128 字符的显式稳定语义身份）";
  }
  if (typeof adapter.validate !== "function") return "adapter.validate 缺失";
  if (typeof adapter.derivePostings !== "function") return "adapter.derivePostings 缺失";
  if (typeof adapter.execute !== "function") return "adapter.execute 缺失";
  if (adapter.structureBindings !== undefined && typeof adapter.structureBindings !== "function") {
    return "adapter.structureBindings 须为函数";
  }
  if (adapter.durableFacts !== undefined && typeof adapter.durableFacts !== "function") {
    return "adapter.durableFacts 须为函数";
  }
  if (adapter.retryFacts !== undefined && typeof adapter.retryFacts !== "function") {
    return "adapter.retryFacts 须为函数";
  }
  if (adapter.reconcile !== undefined && typeof adapter.reconcile !== "function") {
    return "adapter.reconcile 须为函数";
  }
  return null;
}

/**
 * 注册 adapter（immutable registration，第十一轮 3.13.2）：
 * - 注册时快照固定全部函数引用并冻结 record——调用方修改原对象不影响
 *   registry 内实现；execution 与 reconciliation 使用同一 record；
 * - 同 kind + 同 version：同实现（全部函数引用相同）幂等，不同实现拒绝
 *  （不得覆盖——替换实现必须使用更高 adapter version）；
 * - 同 kind 更高 version：合法版本演进（registrationId 变化 → 旧 contract
 *   因 registration identity 不匹配失效）；更低 version 拒绝（不可降级）；
 * - seal 后一切动态注册拒绝（生产装配点调用 seal；架构测试守护）。
 * 架构边界：仅 actionContracts.ts 与测试可调用（生产模块不得动态注册）。
 */
export function registerTreasuryActionAdapter(
  adapter: TreasuryActionAdapter,
): TreasuryAdapterRegistrationResult {
  const shapeError = validateAdapterShape(adapter);
  if (shapeError !== null) return { status: "rejected", detail: shapeError };
  if (adapterRegistrySealed) {
    return { status: "rejected", detail: `adapter registry 已 seal（生产装配完成——运行中动态注册拒绝）` };
  }
  const existing = adapterRegistry.get(adapter.kind);
  if (existing !== undefined) {
    if (existing.view.version === adapter.version) {
      const sameImplementation =
        existing.view.semanticIdentity === adapter.semanticIdentity &&
        existing.view.validate === adapter.validate &&
        existing.view.derivePostings === adapter.derivePostings &&
        existing.view.execute === adapter.execute &&
        existing.view.structureBindings === adapter.structureBindings &&
        existing.view.durableFacts === adapter.durableFacts &&
        existing.view.retryFacts === adapter.retryFacts &&
        existing.view.reconcile === adapter.reconcile;
      if (!sameImplementation) {
        if (existing.view.semanticIdentity !== adapter.semanticIdentity) {
          return {
            status: "rejected",
            detail: `action kind ${adapter.kind} v${String(adapter.version)} 已注册不同 stable semantic identity（${existing.view.semanticIdentity} → ${adapter.semanticIdentity}——语义演进必须升级 adapter version 后注册）`,
          };
        }
        return {
          status: "rejected",
          detail: `action kind ${adapter.kind} v${String(adapter.version)} 已注册不同实现（immutable registry——覆盖被拒，替换实现必须使用更高 adapter version）`,
        };
      }
      return { status: "registered" };
    }
    if (adapter.version < existing.view.version) {
      return {
        status: "rejected",
        detail: `action kind ${adapter.kind} 当前 v${String(existing.view.version)}，不可注册更低 v${String(adapter.version)}（版本只升不降）`,
      };
    }
    // 更高 version：合法演进（旧 contract 因 version + registrationId 不匹配失效）。
  }
  adapterRegistrationSequence += 1;
  const registrationId = hashTreasuryCanonicalString(
    `adapter:${adapter.kind}:${String(adapter.version)}:${String(adapterRegistrationSequence)}`,
  );
  const view: TreasuryRegisteredActionAdapter = Object.freeze({
    kind: adapter.kind,
    version: adapter.version,
    semanticIdentity: adapter.semanticIdentity,
    registrationId,
    validate: adapter.validate,
    derivePostings: adapter.derivePostings,
    execute: adapter.execute,
    ...(adapter.structureBindings !== undefined ? { structureBindings: adapter.structureBindings } : {}),
    ...(adapter.durableFacts !== undefined ? { durableFacts: adapter.durableFacts } : {}),
  ...(adapter.retryFacts !== undefined ? { retryFacts: adapter.retryFacts } : {}),
    ...(adapter.reconcile !== undefined ? { reconcile: adapter.reconcile } : {}),
  });
  const record: TreasuryAdapterRegistrationRecord = Object.freeze({
    view: view as TreasuryRegisteredActionAdapter<never, never>,
    registryGeneration: adapterRegistrationSequence,
    registeredAtTick: Game.time,
  });
  adapterRegistry.set(adapter.kind, record);
  adapterRegistryRevision += 1;
  return { status: "registered" };
}

/** 仅供测试：移除注册（测试隔离用；生产禁用——架构测试守护）。 */
export function unregisterTreasuryActionAdapterForTest(kind: string): boolean {
  const removed = adapterRegistry.delete(kind);
  if (removed) adapterRegistryRevision += 1;
  return removed;
}

/** 仅供测试：覆盖注册（同一 kind 重新配置；生产禁用）。 */
export function replaceTreasuryActionAdapterForTest(adapter: TreasuryActionAdapter): TreasuryAdapterRegistrationResult {
  unregisterTreasuryActionAdapterForTest(adapter.kind);
  return registerTreasuryActionAdapter(adapter);
}

/** 只读查找（无注册返回 undefined——调用方 fail closed）；返回冻结公开视图（内部装配元数据不泄漏）。 */
export function findTreasuryActionAdapter(kind: string): TreasuryRegisteredActionAdapter | undefined {
  return adapterRegistry.get(kind)?.view;
}

/** registry revision（成功注册/版本演进计数；诊断与 metrics）。 */
export function readTreasuryAdapterRegistryRevision(): number {
  return adapterRegistryRevision;
}

/**
 * 生产装配 seal（第十一轮 3.13.2）：装配完成后阻止运行中动态注册。调用点
 * 仅 runtimeServices.ts 生产装配路径（架构测试守护）；测试用 unseal 解除。
 */
export function sealTreasuryAdapterRegistryForProduction(): void {
  adapterRegistrySealed = true;
}

/** 仅供测试：解除 seal（测试隔离用）。 */
export function unsealTreasuryAdapterRegistryForTest(): void {
  adapterRegistrySealed = false;
}

/** 仅供测试：清空 registry（模块级状态隔离；配合 unseal 使用）。 */
export function clearTreasuryAdapterRegistryForTest(): void {
  adapterRegistry.clear();
  adapterRegistrySealed = false;
}

// ── 确定性计数（facade metrics 聚合） ───────────────────────────────────────

const actionContractEvents = {
  built: 0,
  adapterMismatches: 0,
  rejected: 0,
};

export interface TreasuryActionContractCounters {
  readonly built: number;
  readonly adapterMismatches: number;
  readonly rejected: number;
}

export function readTreasuryActionContractCounters(): TreasuryActionContractCounters {
  return { ...actionContractEvents };
}

/** 仅供测试：清零（clearTreasuryPersistenceForTest 调用）。 */
export function resetTreasuryActionContractCountersForTest(): void {
  actionContractEvents.built = 0;
  actionContractEvents.adapterMismatches = 0;
  actionContractEvents.rejected = 0;
}

// ── contract ────────────────────────────────────────────────────────────────

/**
 * 不可伪造的 action contract（heap-only 冻结 capability；WeakSet 防伪）。
 * 第九轮：canonical args 与确定性文本同源（digest 输入）；adapter version
 * 与结构快照绑定；durableFacts 为有界对账事实。
 */
export interface TreasuryActionContract {
  readonly __brand: "treasury-action-contract";
  /** "ac:"+digest 定长 identity。 */
  readonly contractId: string;
  readonly actionKind: string;
  /** 构建时的 adapter version（执行时 registry 必须仍为该 version）。 */
  readonly adapterVersion: number;
  /** adapter registration identity（第十一轮 3.13.2：同 version 替换后旧 contract 失效）。 */
  readonly adapterRegistrationId: string;
  /** 【第十二轮 3.5】稳定语义身份（跨 global reset 的 reconciler 语义锚点；AC4 digest 成分）。 */
  readonly adapterSemanticIdentity: string;
  readonly transactionId: string;
  /** canonical action args 的冻结深拷贝（validate/derive/execute 同源）。 */
  readonly args: unknown;
  /** canonical args 的确定性文本（digest 输入；不持久化）。 */
  readonly canonicalArgsText: string;
  /** adapter.derivePostings(canonical) 确定性派生（规范排序冻结）。 */
  readonly postings: readonly TreasuryPosting[];
  /** 全部 action-relevant 结构快照（label → structureId；含声明结构）。 */
  readonly structureSnapshots: Readonly<Record<string, string | undefined>>;
  /** 快照对应的 binding 集（label → room/location 受控映射；排序冻结）。 */
  readonly structureBindings: readonly Readonly<TreasuryActionStructureBinding>[];
  /** 完整 canonical descriptor 集（第十一轮 3.13.9；AC4 digest 同源、intent/quarantine 持久化形状）。 */
  readonly structureDescriptors: readonly Readonly<TreasuryStructureBindingDescriptor>[];
  readonly digest: string;
  /** adapter.durableFacts(canonical) 的有界对账事实（intent 持久化来源）。 */
  readonly durableFacts?: Readonly<TreasuryDurableFacts>;
  /** 【第十八轮 24.12】canonical retry facts（adapter 显式声明；digest 参与）。 */
  readonly adapterRetryFacts?: string;
  /**
   * 【第十八轮 24.13】contract source（build 时确定的单一权威值——缺省
   * "action-contract"）：进入 contract digest、retry semantic、durable intent、
   * authorization context；execution request 的 source 必须与之完全相同。
   */
  readonly source: string;
  readonly epoch: {
    readonly scope: TreasuryObservationScope;
    readonly epochSeq: number;
    readonly observedAtTick: number;
  };
  readonly builtAtTick: number;
}

const contractRegistry = new WeakSet<TreasuryActionContract>();

/**
 * contract 防伪与时效校验（第九轮：facade 的 contract-first 授权入口用）：
 * 对象身份（私有 registry——伪造/JSON 副本一律无效）+ 本 tick 构建 +
 * registry 内 adapter 存在且 kind/version 一致。返回 contract+adapter 或
 * 结构化拒绝（零抛出）。
 */
export function verifyTreasuryActionContractForAuthorization(
  contract: unknown,
): { readonly status: "ok"; readonly contract: TreasuryActionContract; readonly adapter: TreasuryRegisteredActionAdapter } | {
  readonly status: "rejected";
  readonly reason: "contract_invalid" | "adapter_not_registered";
  readonly detail: string;
} {
  if (!contract || typeof contract !== "object" || !contractRegistry.has(contract as TreasuryActionContract)) {
    return { status: "rejected", reason: "contract_invalid", detail: "contract 未在本模块构建（伪造对象/JSON 副本一律无效）" };
  }
  const typed = contract as TreasuryActionContract;
  if (typed.builtAtTick !== Game.time) {
    return { status: "rejected", reason: "contract_invalid", detail: `contract 于 tick ${String(typed.builtAtTick)} 构建（当前 ${String(Game.time)}）——跨 tick 失效` };
  }
  const adapter = findTreasuryActionAdapter(typed.actionKind);
  if (adapter === undefined) {
    return { status: "rejected", reason: "adapter_not_registered", detail: `action kind ${typed.actionKind} 的 adapter 已被移除` };
  }
  if (adapter.kind !== typed.actionKind || adapter.version !== typed.adapterVersion) {
    return {
      status: "rejected",
      reason: "contract_invalid",
      detail: `adapter 已演进（contract v${String(typed.adapterVersion)}，registry 当前 v${String(adapter.version)}）——须重新构建 contract`,
    };
  }
  // registration identity 绑定（第十一轮 3.13.2）：test-only 同 version 替换
  // 产生新 registrationId——旧 contract 即使 digest 前缀相同也失效。
  if (typed.adapterRegistrationId !== undefined && typed.adapterRegistrationId !== adapter.registrationId) {
    return {
      status: "rejected",
      reason: "contract_invalid",
      detail: `adapter registration identity 已变化（contract ${typed.adapterRegistrationId.slice(0, 12)}，registry ${adapter.registrationId.slice(0, 12)}）——须重新构建 contract`,
    };
  }
  // 【第十二轮 3.5】稳定语义身份绑定：contract 声明的 semanticIdentity 必须
  // 与 registry 当前一致（global reset 后同 kind/version 但语义身份不同的
  // 旧 contract 一律失效）。
  if (typed.adapterSemanticIdentity !== undefined && typed.adapterSemanticIdentity !== adapter.semanticIdentity) {
    return {
      status: "rejected",
      reason: "contract_invalid",
      detail: `adapter stable semantic identity 不一致（contract ${typed.adapterSemanticIdentity.slice(0, 48)}，registry ${adapter.semanticIdentity.slice(0, 48)}）——reconciler 语义已变化，须重新构建 contract`,
    };
  }
  return { status: "ok", contract: typed, adapter };
}

function postingKey(posting: { roomName: string; locationKind: string; resource: string }): string {
  return `${posting.roomName}\u0000${posting.locationKind}\u0000${posting.resource}`;
}

/** 派生 postings 的形状校验（adapter 输出同样不可信任）。 */
function validateDerivedPostings(postings: unknown): string | null {
  if (!Array.isArray(postings) || postings.length === 0) return "derivePostings 输出须为非空数组";
  for (const posting of postings) {
    if (!posting || typeof posting !== "object") return "posting 非对象";
    const leg = posting as Partial<TreasuryPosting>;
    if (typeof leg.roomName !== "string" || leg.roomName.length === 0 || leg.roomName.length > 16) {
      return "posting.roomName 非法";
    }
    if (typeof leg.locationKind !== "string" || !VALID_LOCATION_KINDS.has(leg.locationKind)) {
      return `posting.locationKind 非法: ${String(leg.locationKind)}`;
    }
    if (typeof leg.resource !== "string" || !VALID_RESOURCES.has(leg.resource)) {
      return `posting.resource 不在 RESOURCES_ALL: ${String(leg.resource)}`;
    }
    if (typeof leg.delta !== "number" || !Number.isSafeInteger(leg.delta) || leg.delta === 0) {
      return "posting.delta 须为非零安全整数";
    }
  }
  return null;
}

/** structureBindings 输出的受控校验（adapter 输出不可信——逐项验证）。 */
function validateStructureBindings(
  bindings: unknown,
): readonly TreasuryActionStructureBinding[] | string {
  if (!Array.isArray(bindings)) return "structureBindings 输出须为数组";
  if (bindings.length > STRUCTURE_SNAPSHOT_MAX) {
    return `structureBindings 超过上限 ${String(STRUCTURE_SNAPSHOT_MAX)}`;
  }
  const seenLabels = new Set<string>();
  const typed: TreasuryActionStructureBinding[] = [];
  for (const binding of bindings) {
    if (!binding || typeof binding !== "object") return "structureBinding 非对象";
    const candidate = binding as Partial<TreasuryActionStructureBinding>;
    if (typeof candidate.roomName !== "string" || candidate.roomName.length === 0 || candidate.roomName.length > 16) {
      return "structureBinding.roomName 非法";
    }
    if (candidate.locationKind !== "storage" && candidate.locationKind !== "terminal") {
      return `structureBinding.locationKind 非法（受控枚举 storage|terminal）: ${String(candidate.locationKind)}`;
    }
    // 受控 canonical identity（第十轮 3.12.11）：governed_location 或
    // game_object（objectId 提供）；label 仅诊断不作权威 key。
    if (
      candidate.bindingKind !== undefined &&
      candidate.bindingKind !== "governed_location" &&
      candidate.bindingKind !== "game_object"
    ) {
      return `structureBinding.bindingKind 非法（受控枚举）: ${String(candidate.bindingKind)}`;
    }
    // 【第十二轮】discriminated union 唯一 canonicalization 点：bindingKind
    // 缺省仅在此推导一次，此后全部代码按已确定的 discriminant 分支（不得
    // 再以 objectId !== undefined 判定 kind）。
    const bindingKind: "governed_location" | "game_object" =
      candidate.bindingKind ?? (candidate.objectId !== undefined ? "game_object" : "governed_location");
    if (bindingKind === "governed_location" && candidate.objectId !== undefined) {
      return "structureBinding 矛盾（governed_location 不允许携带 objectId）";
    }
    if (bindingKind === "governed_location" && (candidate.expectedType !== undefined || candidate.expectedRoom !== undefined)) {
      return "structureBinding 矛盾（governed_location 不允许携带 game-object 专属 expectedType/expectedRoom）";
    }
    if (bindingKind === "game_object" && candidate.objectId === undefined) {
      return "structureBinding 矛盾（game_object 必须携带 objectId）";
    }
    if (
      candidate.role !== undefined &&
      candidate.role !== "source" &&
      candidate.role !== "target" &&
      candidate.role !== "fee_source" &&
      candidate.role !== "production_structure" &&
      candidate.role !== "auxiliary"
    ) {
      return `structureBinding.role 非法（受控枚举）: ${String(candidate.role)}`;
    }
    if (candidate.required !== undefined && typeof candidate.required !== "boolean") {
      return "structureBinding.required 须为布尔";
    }
    if (candidate.objectId !== undefined) {
      if (typeof candidate.objectId !== "string" || candidate.objectId.length === 0 || candidate.objectId.length > 48) {
        return "structureBinding.objectId 非法（须为 1..48 字符）";
      }
      if (candidate.expectedType !== undefined && (typeof candidate.expectedType !== "string" || candidate.expectedType.length === 0)) {
        return "structureBinding.expectedType 非法";
      }
      if (candidate.expectedRoom !== undefined && (typeof candidate.expectedRoom !== "string" || candidate.expectedRoom.length === 0)) {
        return "structureBinding.expectedRoom 非法";
      }
    }
    // 默认 label 带 role 后缀（第十一轮 3.13.9）：同结构多 role 声明（不合并）
    // 的默认诊断 label 天然不冲突；显式 label 冲突仍拒绝。
    const roleSuffix = candidate.role !== undefined ? `:${candidate.role}` : "";
    const label = candidate.label ?? (candidate.objectId !== undefined ? `obj:${candidate.objectId}${roleSuffix}` : `${candidate.roomName}:${candidate.locationKind}${roleSuffix}`);
    if (typeof label !== "string" || label.length === 0 || label.length > 48) return "structureBinding label 非法";
    if (seenLabels.has(label)) return `structureBinding label 重复: ${label}`;
    seenLabels.add(label);
    typed.push({
      roomName: candidate.roomName,
      locationKind: candidate.locationKind,
      // canonicalization 后 bindingKind 恒显式（后续判定不再看 objectId）。
      bindingKind,
      ...(candidate.role !== undefined ? { role: candidate.role } : {}),
      ...(candidate.required !== undefined ? { required: candidate.required } : {}),
      label,
      ...(candidate.objectId !== undefined ? { objectId: candidate.objectId } : {}),
      ...(candidate.expectedType !== undefined ? { expectedType: candidate.expectedType } : {}),
      ...(candidate.expectedRoom !== undefined ? { expectedRoom: candidate.expectedRoom } : {}),
    });
  }
  return typed;
}

/** durableFacts 输出的受控校验（有界、版本化；调用方先行判空）。 */
function validateDurableFacts(facts: TreasuryDurableFacts): string | null {
  if (!facts || typeof facts !== "object") return "durableFacts 输出非对象";
  if (
    typeof facts.version !== "number" ||
    !Number.isSafeInteger(facts.version) ||
    facts.version <= 0 ||
    facts.version > DURABLE_FACTS_VERSION_MAX
  ) {
    return "durableFacts.version 须为正安全整数";
  }
  if (typeof facts.payload !== "string" || facts.payload.length === 0 || facts.payload.length > DURABLE_FACTS_PAYLOAD_MAX) {
    return `durableFacts.payload 须为 1..${String(DURABLE_FACTS_PAYLOAD_MAX)} 字符`;
  }
  return null;
}

export interface TreasuryActionContractRequest {
  readonly actionKind: string;
  readonly transactionId: string;
  readonly args: unknown;
  readonly source?: string;
}

/**
 * 执行请求：预构建 contract（伪造对象一律无效）或 actionKind/transactionId/
 * args 构建参数——二选一；authorization 为 contract authorization bundle
 * （contract-first 授权产物，生产路径）或授权 token 数组（每资源一个；
 * test-only 兼容路径）。执行顺序（第九轮 4.2）：contract/adapter/version
 * 校验 → bundle/token 只读预验证（零消费）→ 结构 incarnation 校验（fresh
 * 必需）→ prepare（tentative 接管）→ redeem（一次性消费）→ durable intent
 * → adapter.execute 恰好一次 → commit/abort。
 */
export interface TreasuryActionExecutionRequest {
  readonly contract?: TreasuryActionContract;
  readonly actionKind?: string;
  readonly transactionId?: string;
  readonly args?: unknown;
  readonly source?: string;
  /**
   * 【第十二轮 3.10】production 执行入口只接受 opaque authorization bundle
   * （service 闭包签发对象）。裸 token / token 数组只能出现在明确 test
   * harness 边界（kernelChannel 的 test-only 低层通道）——类型层即拒绝
   * production 业务模块误用。
   */
  readonly authorization?: TreasuryAuthorizationBundle;
  /**
   * 【第十七轮第八节/第十节】tr1_ rearm child 的 opaque rearm capability
   *（tr1_ contract 必填——经 authorizeTreasuryActionContract 的 options 与
   * 执行请求透传；Game callback 之前的接管协议验证并消费）。
   */
  readonly rearmCapability?: unknown;
}

export type TreasuryActionContractResult =
  | { readonly status: "built"; readonly contract: TreasuryActionContract }
  | {
      readonly status: "rejected";
      readonly reason: "invalid_input" | "adapter_not_registered" | "contract_invalid";
      readonly detail: string;
    };

/** 单条 posting 的长度前缀 canonical 文本（digest 输入）。 */
function canonicalPostingText(posting: TreasuryPosting): string {
  return `s:${String(posting.roomName.length)}:${posting.roomName}:s:${String(posting.locationKind.length)}:${posting.locationKind}:s:${String(posting.resource.length)}:${posting.resource}:n:${String(posting.delta)}`;
}

/** 结构快照的长度前缀 canonical 文本（label 排序确定；执行重验快照——AC4 起不再进 digest）。 */
function canonicalStructuresText(structureSnapshots: Record<string, string | undefined>): string {
  return [...Object.keys(structureSnapshots).sort()]
    .map((label) => {
      const structureId = structureSnapshots[label];
      const value = structureId === undefined ? "-" : structureId;
      return `s:${String(label.length)}:${label}:s:${String(value.length)}:${value}`;
    })
    .join(",");
}

/**
 * 完整 structure descriptor 的 canonical 文本（第十一轮 3.13.9 / AC4 digest
 * 输入）：bindingKind/role/room/locationKind/objectId/expectedType/
 * expectedRoom/required/incarnation 全字段——任一变化 → digest 变化。
 */
function canonicalStructureDescriptorText(descriptor: TreasuryStructureBindingDescriptor): string {
  const objectId = descriptor.objectId ?? "-";
  const expectedType = descriptor.expectedType ?? "-";
  const expectedRoom = descriptor.expectedRoom ?? "-";
  return `dv${String(descriptor.version)}:k:${descriptor.bindingKind}:r:${descriptor.role}:rm:${String(descriptor.roomName.length)}:${descriptor.roomName}:lc:${descriptor.locationKind}:ob:${String(objectId.length)}:${objectId}:et:${String(expectedType.length)}:${expectedType}:er:${String(expectedRoom.length)}:${expectedRoom}:rq:${descriptor.required ? "1" : "0"}:inc:${String(descriptor.structureId.length)}:${descriptor.structureId}`;
}

/** binding（heap 形态）+ incarnation id → 完整 durable descriptor。 */
function toStructureDescriptor(
  binding: TreasuryActionStructureBinding,
  incarnationId: string,
): TreasuryStructureBindingDescriptor {
  return {
    // 【第十二轮】bindingKind 已在 canonicalization 阶段唯一确定（恒存在，
    // 不再以 objectId 推导）。
    bindingKind: binding.bindingKind ?? (binding.objectId !== undefined ? "game_object" : "governed_location"),
    role: binding.role ?? "auxiliary",
    roomName: binding.roomName,
    locationKind: binding.locationKind,
    structureId: incarnationId,
    ...(binding.objectId !== undefined ? { objectId: binding.objectId } : {}),
    ...(binding.expectedType !== undefined ? { expectedType: binding.expectedType } : {}),
    ...(binding.expectedRoom !== undefined ? { expectedRoom: binding.expectedRoom } : {}),
    required: binding.required ?? true,
    version: TREASURY_STRUCTURE_DESCRIPTOR_VERSION,
  };
}

/**
 * 构建 canonical action contract 的公开入口（第十轮 3.12.12 顶层异常边界）：
 * 任何 runtime input 触发的反射异常已在 canonicalizeTreasuryActionArgs 结构化
 * 拒绝；此处的 catch 防御**内部编程错误**（不吞掉后继续构建——返回明确
 * canonicalization fault，registry/授权零变化）。
 */
export function buildTreasuryActionContract(
  service: TreasuryService,
  request: TreasuryActionContractRequest,
): TreasuryActionContractResult {
  try {
    return buildTreasuryActionContractInner(service, request);
  } catch (error) {
    actionContractEvents.rejected += 1;
    return {
      status: "rejected",
      reason: "contract_invalid",
      detail: `canonicalization_fault: ${String(error instanceof Error ? error.message : error).slice(0, 128)}（内部编码边界——contract 未构建，registry/授权零变化）`,
    };
  }
}

/**
 * adapter 函数异常边界（第十一轮 3.13.2）：validate/derivePostings/
 * structureBindings/durableFacts 的任何抛错结构化拒绝（callback 零调用、
 * registry/授权零变化）；execute 异常由 executePreparedAction 的 execution
 * unknown 协议处置；reconcile 异常由 capability 签发入口处置。
 */
function adapterCall<T>(op: string, fn: () => T): { readonly status: "ok"; readonly value: T } | { readonly status: "fault"; readonly detail: string } {
  try {
    return { status: "ok", value: fn() };
  } catch (error) {
    return {
      status: "fault",
      detail: `adapter_fault(${op}): ${String(error instanceof Error ? error.message : error).slice(0, 96)}`,
    };
  }
}

/**
 * 构建 canonical action contract：canonicalize args → adapter 校验 →
 * derivePostings 确定性派生 → 结构 incarnation 快照（posting locations +
 * 受控 structureBindings）→ digest 绑定（AC2）→ 冻结 + 私有 registry 注册。
 * postings 与 Game API 参数同源（同一 canonical args 派生），两套事实通道
 * 不复存在。
 */
function buildTreasuryActionContractInner(
  service: TreasuryService,
  request: TreasuryActionContractRequest,
): TreasuryActionContractResult {
  if (!request || typeof request !== "object" || typeof request.actionKind !== "string") {
    actionContractEvents.rejected += 1;
    return { status: "rejected", reason: "invalid_input", detail: "contract 请求缺失或 actionKind 非字符串" };
  }
  if (typeof request.transactionId !== "string" || request.transactionId.length === 0 || request.transactionId.length > 128) {
    actionContractEvents.rejected += 1;
    return { status: "rejected", reason: "invalid_input", detail: "transactionId 非法（须为 1..128 字符）" };
  }
  const adapter = findTreasuryActionAdapter(request.actionKind);
  if (adapter === undefined) {
    actionContractEvents.rejected += 1;
    return {
      status: "rejected",
      reason: "adapter_not_registered",
      detail: `action kind ${request.actionKind} 无注册 adapter（真实生产动作必须经注册 adapter 执行）`,
    };
  }
  // 安全 canonical encoding（第九轮 4.11）：先 canonicalize，validate/
  // derivePostings/structureBindings/durableFacts/execute 与 digest 全部观察
  // 同一 canonical frozen args。
  const canonicalized = canonicalizeTreasuryActionArgs(request.args);
  if (canonicalized.status === "rejected") {
    actionContractEvents.rejected += 1;
    return { status: "rejected", reason: "contract_invalid", detail: `args canonicalization 失败: ${canonicalized.detail}` };
  }
  const canonicalArgs = canonicalized.canonical;
  const validated = adapterCall("validate", () => adapter.validate(canonicalArgs));
  if (validated.status === "fault") {
    actionContractEvents.rejected += 1;
    return { status: "rejected", reason: "contract_invalid", detail: validated.detail };
  }
  if (validated.value !== null) {
    actionContractEvents.rejected += 1;
    return { status: "rejected", reason: "contract_invalid", detail: `args 校验失败: ${validated.value}` };
  }
  const derivedCall = adapterCall("derivePostings", () => adapter.derivePostings(canonicalArgs));
  if (derivedCall.status === "fault") {
    actionContractEvents.rejected += 1;
    return { status: "rejected", reason: "contract_invalid", detail: derivedCall.detail };
  }
  const derived = derivedCall.value;
  const postingsError = validateDerivedPostings(derived);
  if (postingsError !== null) {
    actionContractEvents.rejected += 1;
    return { status: "rejected", reason: "contract_invalid", detail: `derivePostings 输出非法: ${postingsError}` };
  }
  const observation = service.observation();
  // 结构 incarnation 快照（第九轮 4.12 / 第十轮 3.12.11）：posting 涉及的
  // 每个 location 的 structureId + adapter 受控声明的额外结构（全部执行前
  // 重验）。null-prototype 容器：特殊 label（__proto__/constructor）不得
  // 污染原型链——快照键一律自有属性。
  const structureSnapshots: Record<string, string> = Object.create(null) as Record<string, string>;
  const bindingList: TreasuryActionStructureBinding[] = [];
  // identity → 该 identity 已派生的 role 集（同结构不同 role 保留两条 descriptor）。
  const postingLocationRoles = new Map<string, Set<string>>();
  const postingLabels = new Set<string>();
  for (const posting of derived) {
    // 【第十一轮 3.13.9】role 由 posting 符号派生：负腿 source、正腿 target。
    const postingRole = posting.delta < 0 ? "source" : "target";
    const key = `${posting.roomName}:${posting.locationKind}`;
    const roles = postingLocationRoles.get(key) ?? new Set<string>();
    if (roles.has(postingRole)) continue;
    roles.add(postingRole);
    postingLocationRoles.set(key, roles);
    // 【第十轮 3.12.11】required structure 构建时必须真实存在——undefined
    // 一律拒绝（不允许 undefined===undefined 的伪验证）。
    if (!observation.hasRoom(posting.roomName)) {
      actionContractEvents.rejected += 1;
      return {
        status: "rejected",
        reason: "contract_invalid",
        detail: `posting 位置 ${key} 的房间不在管辖（required structure 不存在——拒绝 contract 构建）`,
      };
    }
    const postingStructure = observation.location(posting.roomName, posting.locationKind as "storage" | "terminal").structureId;
    if (postingStructure === undefined) {
      actionContractEvents.rejected += 1;
      return {
        status: "rejected",
        reason: "contract_invalid",
        detail: `posting 位置 ${key} 的 required structure 不存在（incarnation 无法验证——拒绝 contract 构建）`,
      };
    }
    const label = `${key}:${postingRole}`;
    structureSnapshots[label] = postingStructure;
    postingLabels.add(label);
    bindingList.push({
      roomName: posting.roomName,
      locationKind: posting.locationKind as "storage" | "terminal",
      bindingKind: "governed_location",
      role: postingRole,
      label,
    });
  }
  if (adapter.structureBindings !== undefined) {
    const bindingsCall = adapterCall("structureBindings", () => adapter.structureBindings!(canonicalArgs));
    if (bindingsCall.status === "fault") {
      actionContractEvents.rejected += 1;
      return { status: "rejected", reason: "contract_invalid", detail: bindingsCall.detail };
    }
    const bindings = validateStructureBindings(bindingsCall.value);
    if (typeof bindings === "string") {
      actionContractEvents.rejected += 1;
      return { status: "rejected", reason: "contract_invalid", detail: `structureBindings 输出非法: ${bindings}` };
    }
    const seenAdapterDescriptorKeys = new Set<string>();
    for (const binding of bindings) {
      // canonical identity（第十轮 3.12.11）：governed_location = room:loc；
      // game_object = obj:objectId（与 posting binding 天然不重合）。
      const identityKey = binding.bindingKind === "game_object" ? `obj:${binding.objectId}` : `${binding.roomName}:${binding.locationKind}`;
      // 【第十一轮 3.13.9】descriptor 唯一性 key = (identity, role)：同结构
      // 不同 role 不静默合并（各自进 digest 与 durable authority）；adapter
      // 重复声明（同 identity 同 role）幂等跳过（posting binding 为权威）。
      const bindingRole = binding.role ?? "auxiliary";
      const descriptorKey = `${identityKey}:${bindingRole}`;
      if (seenAdapterDescriptorKeys.has(descriptorKey)) {
        actionContractEvents.rejected += 1;
        return {
          status: "rejected",
          reason: "contract_invalid",
          detail: `structureBinding 重复声明同一 (identity, role) ${descriptorKey.slice(0, 48)}（descriptor 级重复——拒绝）`,
        };
      }
      seenAdapterDescriptorKeys.add(descriptorKey);
      if (postingLocationRoles.get(identityKey)?.has(bindingRole)) {
        // 同 identity + 同 role → 合并（posting binding 为 identity 权威；
        // adapter 的重复声明幂等跳过）。
        continue;
      }
      // label 冲突：label 与某 posting binding 的 label 相同但 (identity,
      // role) 不同 → 拒绝（label 仅诊断，不得复用同 label 表达不同声明）。
      if (binding.label !== undefined && postingLabels.has(binding.label)) {
        actionContractEvents.rejected += 1;
        return {
          status: "rejected",
          reason: "contract_invalid",
          detail: `structureBinding label ${binding.label} 与 posting binding 冲突（同 label 不同 (identity, role)——拒绝）`,
        };
      }
      if (binding.bindingKind === "game_object") {
        // game_object binding：对象必须存在且与期望类型/room 归属匹配。
        const object = (Game as unknown as { getObjectById<T extends object>(id: string): T | null }).getObjectById<{
          id: string;
          structureType?: string;
          room?: { name: string };
        }>(binding.objectId);
        if (object === null || object === undefined) {
          if (binding.required === false) {
            // optional binding 缺失：跳过（不进 descriptor 集与快照）。
            continue;
          }
          actionContractEvents.rejected += 1;
          return {
            status: "rejected",
            reason: "contract_invalid",
            detail: `structureBinding 对象 ${binding.objectId} 不存在（required structure 不存在——拒绝 contract 构建）`,
          };
        }
        if (binding.expectedType !== undefined && object.structureType !== binding.expectedType) {
          actionContractEvents.rejected += 1;
          return {
            status: "rejected",
            reason: "contract_invalid",
            detail: `structureBinding 对象 ${binding.objectId} 类型不匹配（期望 ${binding.expectedType}，实际 ${String(object.structureType)}）`,
          };
        }
        const objectRoom = object.room?.name;
        if (binding.expectedRoom !== undefined && objectRoom !== binding.expectedRoom) {
          actionContractEvents.rejected += 1;
          return {
            status: "rejected",
            reason: "contract_invalid",
            detail: `structureBinding 对象 ${binding.objectId} room 归属不匹配（期望 ${binding.expectedRoom}，实际 ${String(objectRoom)}）`,
          };
        }
        structureSnapshots[binding.label!] = binding.objectId;
        bindingList.push(binding);
        continue;
      }
      // 声明的结构必须可验证：房间不在管辖或位置缺失 → required 拒绝；
      // optional（required=false）缺失 → 跳过（不进 descriptor 集与快照）。
      const optionalMissing =
        binding.required === false &&
        (!observation.hasRoom(binding.roomName) ||
          observation.location(binding.roomName, binding.locationKind).structureId === undefined);
      if (optionalMissing) {
        continue;
      }
      if (!observation.hasRoom(binding.roomName)) {
        actionContractEvents.rejected += 1;
        return {
          status: "rejected",
          reason: "contract_invalid",
          detail: `structureBinding 声明房间 ${binding.roomName} 不在管辖（无法验证 incarnation——拒绝）`,
        };
      }
      const bindingStructure = observation.location(binding.roomName, binding.locationKind).structureId;
      if (bindingStructure === undefined) {
        actionContractEvents.rejected += 1;
        return {
          status: "rejected",
          reason: "contract_invalid",
          detail: `structureBinding 位置 ${identityKey} 的 required structure 不存在（拒绝 contract 构建）`,
        };
      }
      structureSnapshots[binding.label!] = bindingStructure;
      bindingList.push(binding);
    }
  }
  if (bindingList.length > STRUCTURE_SNAPSHOT_MAX) {
    actionContractEvents.rejected += 1;
    return {
      status: "rejected",
      reason: "contract_invalid",
      detail: `结构快照超过上限 ${String(STRUCTURE_SNAPSHOT_MAX)}（posting locations + structureBindings 合计）`,
    };
  }
  const sortedBindings = [...bindingList].sort((a, b) => ((a.label ?? "") < (b.label ?? "") ? -1 : (a.label ?? "") > (b.label ?? "") ? 1 : 0));
  let durableFacts: TreasuryDurableFacts | undefined;
  if (adapter.durableFacts !== undefined) {
    const factsCall = adapterCall("durableFacts", () => adapter.durableFacts!(canonicalArgs));
    if (factsCall.status === "fault") {
      actionContractEvents.rejected += 1;
      return { status: "rejected", reason: "contract_invalid", detail: factsCall.detail };
    }
    const facts = factsCall.value;
    if (facts !== null && facts !== undefined) {
      const factsError = validateDurableFacts(facts);
      if (factsError !== null) {
        actionContractEvents.rejected += 1;
        return { status: "rejected", reason: "contract_invalid", detail: `durableFacts 输出非法: ${factsError}` };
      }
      durableFacts = { version: facts.version, payload: facts.payload };
    }
  }
  // 【第十八轮 24.12】adapter 显式 retry facts：canonical frozen args 派生 →
  // 共享边界（shape validation / canonical encoding / 大小上限 / 异常边界）。
  // 派生抛错或超限 → contract 构建拒绝（fail closed——不产出部分事实）；
  // adapter 未实现 → 无 retry facts（action 正常执行，not-executed 后
  // non-rearmable）。
  let adapterRetryFacts: string | undefined;
  if (adapter.retryFacts !== undefined) {
    const retryCall = adapterCall("retryFacts", () => adapter.retryFacts!(canonicalArgs));
    if (retryCall.status === "fault") {
      actionContractEvents.rejected += 1;
      return { status: "rejected", reason: "contract_invalid", detail: retryCall.detail };
    }
    const canonicalized = canonicalizeTreasuryAdapterRetryFacts(retryCall.value);
    if (canonicalized.status === "rejected") {
      actionContractEvents.rejected += 1;
      return { status: "rejected", reason: "contract_invalid", detail: `retry facts 非法: ${canonicalized.detail}` };
    }
    adapterRetryFacts = canonicalized.text;
  }
  const sortedPostings = [...derived].sort((a, b) => (postingKey(a) < postingKey(b) ? -1 : postingKey(a) > postingKey(b) ? 1 : 0));
  // 【第十一轮 3.13.9】完整 descriptor 集（排序确定）：AC4 digest 输入与
  // intent/quarantine durable facts 的同源事实——同结构不同 role 各占一条。
  const sortedDescriptors = [...bindingList]
    .map((binding) =>
      toStructureDescriptor(
        binding,
        binding.bindingKind === "game_object" ? binding.objectId! : structureSnapshots[binding.label ?? `${binding.roomName}:${binding.locationKind}`] ?? "",
      ),
    )
    .sort((a, b) => {
      const left = canonicalStructureDescriptorText(a);
      const right = canonicalStructureDescriptorText(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  // 【第十轮 3.12.6/AC3】durable reconciliation facts 绑定进 contract identity：
  // durable payload version 与内容的稳定 hash、reconciliation contract version
  //（adapter 提供 reconciler 时 durable facts 必填）。durable facts 变化 →
  // digest 变化 → 旧 bundle/授权全部失效（不得复用）。
  if (adapter.reconcile !== undefined && durableFacts === undefined) {
    actionContractEvents.rejected += 1;
    return {
      status: "rejected",
      reason: "contract_invalid",
      detail: "adapter 提供 reconciler 但未提供 durableFacts（production contract 的 durable reconciliation facts 必填）",
    };
  }
  const durablePayloadHash = durableFacts !== undefined ? hashTreasuryCanonicalString(durableFacts.payload) : "";
  const durableText =
    durableFacts !== undefined
      ? `:dfv:${String(durableFacts.version)}:dfh:${durablePayloadHash}:rcv:${String(durableFacts.version)}`
      : ":df:none";
  const retryFactsText = adapterRetryFacts !== undefined ? `:rf:${String(adapterRetryFacts.length)}:${adapterRetryFacts}` : ":rf:none";
  const contractSource = request.source ?? "action-contract";
  const sourceText = `:src:${String(contractSource.length)}:${contractSource}`;
  const digest = hashTreasuryCanonicalString(
    `AC4:ce:${String(TREASURY_CANONICAL_ENCODING_VERSION)}:k:${String(request.actionKind.length)}:${request.actionKind}:av:${String(adapter.version)}:ar:${String(adapter.registrationId.length)}:${adapter.registrationId}:asi:${String(adapter.semanticIdentity.length)}:${adapter.semanticIdentity}:t:${String(request.transactionId.length)}:${request.transactionId}:a:${String(canonicalized.text.length)}:${canonicalized.text}:p:${sortedPostings.map(canonicalPostingText).join(",")}:sd:${sortedDescriptors.map(canonicalStructureDescriptorText).join(",")}${durableText}${retryFactsText}${sourceText}`,
  );
  const contract = Object.freeze({
    __brand: "treasury-action-contract",
    contractId: `ac:${digest}`,
    actionKind: request.actionKind,
    adapterVersion: adapter.version,
    adapterRegistrationId: adapter.registrationId,
    adapterSemanticIdentity: adapter.semanticIdentity,
    transactionId: request.transactionId,
    args: canonicalArgs,
    canonicalArgsText: canonicalized.text,
    postings: Object.freeze(sortedPostings.map((p) => Object.freeze({ ...p }))),
    structureSnapshots: Object.freeze(Object.assign(Object.create(null), structureSnapshots)) as Record<string, string>,
    structureBindings: Object.freeze(sortedBindings.map((b) => Object.freeze({ ...b }))),
    structureDescriptors: Object.freeze(sortedDescriptors.map((d) => Object.freeze({ ...d }))),
    digest,
    ...(durableFacts !== undefined ? { durableFacts: Object.freeze({ ...durableFacts }) } : {}),
    ...(adapterRetryFacts !== undefined ? { adapterRetryFacts } : {}),
    source: contractSource,
    epoch: {
      scope: observation.epoch.scope,
      epochSeq: observation.epoch.epochSeq,
      observedAtTick: observation.epoch.observedAtTick,
    },
    builtAtTick: Game.time,
  }) as TreasuryActionContract;
  contractRegistry.add(contract);
  actionContractEvents.built += 1;
  return { status: "built", contract };
}

/**
 * 执行 action contract（生产 writer 的唯一入口）：
 * 1. contract 防伪（私有 registry 对象身份——伪造/JSON 副本一律无效）、跨
 *    tick 失效、adapter kind 与 version 匹配（版本演进后旧 contract 失效）；
 * 2. opaque authorization bundle 验证（第十轮 3.12.3）：只接受 service 闭包
 *    registry 签发的 bundle（对象身份）——裸 token、token 数组、手工构造
 *    对象与 JSON 副本一律 authorization_invalid（零消费、零 tentative）；
 * 3. 结构 incarnation 校验（fresh observation 必需——配额耗尽拒绝执行，
 *    不退回 shared 降低验证等级），对全部声明结构重新验证；
 * 4. 经 writer kernel 的 executePreparedAction + authorizationBundle 走
 *    **批量原子 redemption**（全部 legs 一次验证、staged 变更一次发布——
 *    见 facade.redeemAuthorizationBundleAtomic）与第八轮唯一安全顺序
 *    （durable intent → executing → adapter.execute 恰好一次 →
 *    commit/abort/fault 隔离）。
 */
export function executeTreasuryActionContract<TAction extends { ok: boolean }>(
  service: TreasuryService,
  request: TreasuryActionExecutionRequest,
): TreasurySafeExecuteResult<TAction> | { readonly status: "prepare_rejected"; readonly reason: string; readonly detail?: string } {
  const built =
    request.contract !== undefined
      ? { status: "built" as const, contract: request.contract }
      : buildTreasuryActionContract(service, {
          actionKind: request.actionKind ?? "",
          transactionId: request.transactionId ?? "",
          args: request.args,
          ...(request.source !== undefined ? { source: request.source } : {}),
        });
  if (built.status === "rejected") {
    return { status: "prepare_rejected", reason: built.reason, detail: built.detail };
  }
  const contract = built.contract;
  if (!contract || typeof contract !== "object" || !contractRegistry.has(contract)) {
    actionContractEvents.rejected += 1;
    return { status: "prepare_rejected", reason: "contract_invalid", detail: "contract 未在本模块构建（伪造对象/JSON 副本一律无效）" };
  }
  // ──【Remediation VII 修复四】ti1_ service-issued 命名空间防伪：production
  //    contract 通道不接受伪造的 ti1_ ID（seq > watermark——尚未发行的
  //    序号）。真实 writer 的 initial ID 由 attemptIssuer.mint 签发（持久
  //    单调 high-watermark，global reset 不回退）；tr1_ child 经 capability
  //    派生（facade 门禁）；arbitrary legacy 字符串只存在于测试域
  //    （架构测试守护 production 调用方必须经 mint/capability）。
  if (parseTreasuryIssuedInitialAttemptId(contract.transactionId) !== null) {
    const issuedCheck = checkTreasuryServiceIssuedAttemptId(contract.transactionId);
    if (issuedCheck.status === "store_unhealthy") {
      actionContractEvents.rejected += 1;
      return {
        status: "prepare_rejected",
        reason: "issuer_store_unhealthy",
        detail: `attempt issuer store unhealthy（${issuedCheck.detail}）——ti1_ ID 发行事实不可判定，fail closed`,
      };
    }
    if (issuedCheck.status === "forged_future") {
      actionContractEvents.rejected += 1;
      return {
        status: "prepare_rejected",
        reason: "transaction_id_not_issued",
        detail: `transactionId ${contract.transactionId.slice(0, 24)} 的发行序号（${String(issuedCheck.sequence)}）超过当前 high-watermark——手工伪造的 service-issued ID 一律拒绝（Game callback 零调用）`,
      };
    }
  }
  // 【第十八轮 24.13】execution request 的 source 不得覆盖已授权 contract
  // source（不同 → callback 前拒绝；相同 → 幂等透传）。
  if (request.source !== undefined && request.source !== contract.source) {
    actionContractEvents.rejected += 1;
    return {
      status: "prepare_rejected",
      reason: "contract_invalid",
      detail: `execution request source "${request.source.slice(0, 32)}" 与 contract source "${contract.source.slice(0, 32)}" 不一致——source 在 contract build 时确定（单一权威），不得覆盖已授权 source（Game callback 零调用）`,
    };
  }
  if (contract.builtAtTick !== Game.time) {
    actionContractEvents.rejected += 1;
    return {
      status: "prepare_rejected",
      reason: "contract_invalid",
      detail: `contract 于 tick ${String(contract.builtAtTick)} 构建（当前 ${String(Game.time)}）——跨 tick 失效`,
    };
  }
  const adapter = findTreasuryActionAdapter(contract.actionKind);
  if (adapter === undefined) {
    actionContractEvents.rejected += 1;
    return { status: "prepare_rejected", reason: "adapter_not_registered", detail: `action kind ${contract.actionKind} 的 adapter 已被移除` };
  }
  if (adapter.kind !== contract.actionKind) {
    actionContractEvents.adapterMismatches += 1;
    return { status: "prepare_rejected", reason: "adapter_kind_mismatch", detail: `adapter kind ${adapter.kind} 与 contract ${contract.actionKind} 不匹配` };
  }
  if (adapter.version !== contract.adapterVersion) {
    actionContractEvents.adapterMismatches += 1;
    return {
      status: "prepare_rejected",
      reason: "contract_invalid",
      detail: `adapter version 已演进（contract 构建于 v${String(contract.adapterVersion)}，registry 当前 v${String(adapter.version)}）——旧 contract 失效，须重新构建与授权`,
    };
  }
  if (contract.adapterRegistrationId !== undefined && contract.adapterRegistrationId !== adapter.registrationId) {
    actionContractEvents.adapterMismatches += 1;
    return {
      status: "prepare_rejected",
      reason: "contract_invalid",
      detail: `adapter registration identity 已变化（contract ${contract.adapterRegistrationId.slice(0, 12)}，registry ${adapter.registrationId.slice(0, 12)}）——旧 contract 失效`,
    };
  }
  if (contract.adapterSemanticIdentity !== undefined && contract.adapterSemanticIdentity !== adapter.semanticIdentity) {
    actionContractEvents.adapterMismatches += 1;
    return {
      status: "prepare_rejected",
      reason: "contract_invalid",
      detail: `adapter stable semantic identity 不一致（contract ${contract.adapterSemanticIdentity.slice(0, 48)}，registry ${adapter.semanticIdentity.slice(0, 48)}）——reconciler 语义已变化，旧 contract 失效`,
    };
  }
  const authorization = request.authorization;
  if (authorization === undefined) {
    actionContractEvents.rejected += 1;
    return {
      status: "prepare_rejected",
      reason: "authorization_invalid",
      detail: "action contract 执行必须携带授权（opaque service-issued bundle——真实写动作不得只凭物理可行性通过）",
    };
  }
  // ── opaque bundle 验证（第十轮 3.12.3）：只认 service 闭包 registry 的
  //    对象身份；裸 token / token 数组 / 手工构造对象 / JSON 副本一律拒绝。
  //    低层 token 路径仅供 test harness（kernelChannel），不在此处。 ──────
  const kernel = (service as unknown as TreasuryKernelHolder)[TREASURY_WRITER_KERNEL];
  if (kernel === undefined) {
    actionContractEvents.rejected += 1;
    return {
      status: "prepare_rejected",
      reason: "authorization_invalid",
      detail: "service 不持有 writer kernel（非 treasury 协议栈通道——拒绝执行）",
    };
  }
  const resolvedBundle = kernel.resolveAuthorizationBundle(authorization, {
    transactionId: contract.transactionId,
    actionKind: contract.actionKind,
    digest: contract.digest,
    adapterVersion: contract.adapterVersion,
  });
  if (resolvedBundle.status === "rejected") {
    actionContractEvents.rejected += 1;
    return { status: "prepare_rejected", reason: "authorization_invalid", detail: `授权 bundle 验证失败（${resolvedBundle.reason}）: ${resolvedBundle.detail}` };
  }
  // 结构 incarnation 校验（第九轮 4.12，先于消费）：fresh observation 必需
  // ——配额耗尽拒绝执行，不退回 shared observation 降低验证等级；对全部
  // 声明结构（posting locations + structureBindings）逐项重验。
  const freshObservation = service.beginFreshObservation();
  if (freshObservation === null) {
    actionContractEvents.rejected += 1;
    return {
      status: "prepare_rejected",
      reason: "fresh_observation_unavailable",
      detail: "fresh observation 配额耗尽——无法在不降低验证等级的前提下确认结构 incarnation（fail closed，拒绝执行）",
    };
  }
  for (const binding of contract.structureBindings) {
    const label = binding.label ?? `${binding.roomName}:${binding.locationKind}`;
    const snapshotId = contract.structureSnapshots[label];
    if (binding.bindingKind === "game_object") {
      // game_object binding 执行前重验（第十轮 3.12.11）：对象仍存在、类型与
      // room 归属仍匹配（incarnation = 对象 id 本身——不存在即被替换语义）。
      const object = (Game as unknown as { getObjectById<T extends object>(id: string): T | null }).getObjectById<{
        id: string;
        structureType?: string;
        room?: { name: string };
      }>(binding.objectId);
      const objectMissing =
        object === null ||
        object === undefined ||
        (binding.expectedType !== undefined && object.structureType !== binding.expectedType) ||
        (binding.expectedRoom !== undefined && object.room?.name !== binding.expectedRoom);
      if (objectMissing) {
        actionContractEvents.rejected += 1;
        return {
          status: "prepare_rejected",
          reason: "structure_replaced",
          detail: `game object binding 失效（${label}: 对象不存在或类型/room 归属不匹配）——必须重新构建 contract`,
        };
      }
      continue;
    }
    const currentStructureId = freshObservation.hasRoom(binding.roomName)
      ? freshObservation.location(binding.roomName, binding.locationKind).structureId
      : undefined;
    if (snapshotId !== currentStructureId) {
      actionContractEvents.rejected += 1;
      return {
        status: "prepare_rejected",
        reason: "structure_replaced",
        detail: `结构 incarnation 已变化（${label}: ${String(snapshotId)} → ${String(currentStructureId)}）——必须重新构建 contract`,
      };
    }
  }
  // 经 writer kernel execution options 走批量原子 redemption（第十轮
  // 3.12.4）：prepare（tentative 接管）→ redeemAuthorizationBundleAtomic
  //（全部 legs 一次性只读预验证 + staged 变更一次发布；注入故障前缀回滚或
  // internal authorization fault）→ durable intent（绑定完整合同身份与
  // bundle digest）→ callback。
  return kernel.executePreparedAction(
    {
      transactionId: contract.transactionId,
      kind: contract.actionKind,
      source: contract.source,
      decision: {
        scope: contract.epoch.scope,
        epochSeq: contract.epoch.epochSeq,
        observedAtTick: contract.epoch.observedAtTick,
      },
      postings: contract.postings,
    },
    () => adapter.execute(contract.args) as TAction,
    {
      authorizationBundle: authorization as TreasuryAuthorizationBundle,
      // 【第十七轮第八节】tr1_ rearm capability 透传（kernel 内部通道——
      // prepare 门禁与接管协议验证）。
      ...(request.rearmCapability !== undefined ? { rearmCapability: request.rearmCapability } : {}),
      intentContract: {
        contractId: contract.contractId,
        contractDigest: contract.digest,
        adapterVersion: contract.adapterVersion,
        adapterRegistrationId: contract.adapterRegistrationId,
        adapterSemanticIdentity: contract.adapterSemanticIdentity,
        authorizationDigest: resolvedBundle.authorizationDigest,
        ...(contract.canonicalArgsText !== undefined ? { canonicalArgsText: contract.canonicalArgsText } : {}),
        ...(contract.durableFacts !== undefined
          ? { durablePayload: contract.durableFacts.payload, durablePayloadVersion: contract.durableFacts.version }
          : {}),
        ...(contract.structureDescriptors.length > 0
          ? {
              // 完整 canonical descriptor（第十一轮 3.13.9）——bindingKind/role/
              // object identity/type/room/required/version 全字段进 durable intent。
              structureFacts: contract.structureDescriptors.map((descriptor) => ({ ...descriptor })),
            }
          : {}),
        ...(contract.adapterRetryFacts !== undefined ? { adapterRetryFacts: contract.adapterRetryFacts } : {}),
      },
    },
  );
}

// ── 测试专用 adapter（本轮唯一内置注册；生产 writer 禁止） ──────────────────

/** test.transfer 的 canonical args（多 posting fixture：转移 + 可选费用腿）。 */
export interface TreasuryTestTransferArgs {
  readonly fromRoom: string;
  readonly fromLocation: "storage" | "terminal";
  readonly toRoom: string;
  readonly toLocation: "storage" | "terminal";
  readonly resource: string;
  readonly amount: number;
  /** 可选费用腿（terminal send 的 transaction energy 语义）。 */
  readonly feeFromRoom?: string;
  readonly feeAmount?: number;
  /** execute 结果编排："ok" | "non-ok" | "throw"。 */
  readonly outcome?: "ok" | "non-ok" | "throw";
  /** reconcile 结论编排（capability 测试用）。 */
  readonly reconcileConclusion?: TreasuryActionReconcilerConclusion;
}

/** 测试副作用计数器（断言"恰好执行一次"）。 */
const testAdapterSideEffects = { executions: 0 };
export function readTreasuryTestAdapterSideEffects(): { readonly executions: number } {
  return { ...testAdapterSideEffects };
}
export function resetTreasuryTestAdapterSideEffectsForTest(): void {
  testAdapterSideEffects.executions = 0;
}

/**
 * 测试 adapter（"test.transfer"）：注册边界演示与确定性 fixture。多 posting
 * 派生（转移双腿 + 可选费用腿）；execute 计数副作用并按 outcome 编排结果；
 * reconcile 返回工厂参数编排的结论（capability 测试验证"结论只能来自注册
 * reconciler"的协议，不实现真实对账逻辑）。生产模块不得注册或调用（架构
 * 测试守护）。
 */
export function makeTreasuryTestTransferAdapter(
  reconcileConclusion: TreasuryActionReconcilerConclusion = "still_uncertain",
): TreasuryActionAdapter<TreasuryTestTransferArgs, { ok: boolean }> {
  return {
    kind: "test.transfer",
    version: 1,
    semanticIdentity: "test.transfer@reconciler-semantics-v1",
    validate(args: unknown): string | null {
      if (!args || typeof args !== "object") return "args 非对象";
      const candidate = args as Partial<TreasuryTestTransferArgs>;
      if (typeof candidate.fromRoom !== "string" || candidate.fromRoom.length === 0) return "fromRoom 非法";
      if (typeof candidate.toRoom !== "string" || candidate.toRoom.length === 0) return "toRoom 非法";
      if (candidate.fromLocation !== "storage" && candidate.fromLocation !== "terminal") return "fromLocation 非法";
      if (candidate.toLocation !== "storage" && candidate.toLocation !== "terminal") return "toLocation 非法";
      if (typeof candidate.resource !== "string" || candidate.resource.length === 0) return "resource 非法";
      if (typeof candidate.amount !== "number" || !Number.isSafeInteger(candidate.amount) || candidate.amount <= 0) {
        return "amount 须为正安全整数";
      }
      if (
        candidate.feeAmount !== undefined &&
        (typeof candidate.feeAmount !== "number" || !Number.isSafeInteger(candidate.feeAmount) || candidate.feeAmount <= 0)
      ) {
        return "feeAmount 须为正安全整数";
      }
      return null;
    },
    derivePostings(args: TreasuryTestTransferArgs): readonly { roomName: string; locationKind: string; resource: string; delta: number }[] {
      const postings: { roomName: string; locationKind: string; resource: string; delta: number }[] = [
        { roomName: args.fromRoom, locationKind: args.fromLocation, resource: args.resource, delta: -args.amount },
        { roomName: args.toRoom, locationKind: args.toLocation, resource: args.resource, delta: args.amount },
      ];
      if (args.feeFromRoom !== undefined && args.feeAmount !== undefined) {
        postings.push({ roomName: args.feeFromRoom, locationKind: "terminal", resource: "energy", delta: -args.feeAmount });
      }
      return postings;
    },
    execute(args: TreasuryTestTransferArgs): { ok: boolean } {
      testAdapterSideEffects.executions += 1;
      if (args.outcome === "throw") throw new Error("test.transfer: injected execution failure");
      return { ok: args.outcome !== "non-ok" };
    },
    structureBindings(args: TreasuryTestTransferArgs): readonly TreasuryActionStructureBinding[] {
      return [
        { roomName: args.fromRoom, locationKind: args.fromLocation },
        { roomName: args.toRoom, locationKind: args.toLocation },
      ];
    },
    durableFacts(args: TreasuryTestTransferArgs): TreasuryDurableFacts {
      return {
        version: 1,
        payload: `transfer|${args.fromRoom}:${args.fromLocation}|${args.toRoom}:${args.toLocation}|${args.resource}|${String(args.amount)}`.slice(0, DURABLE_FACTS_PAYLOAD_MAX),
      };
    },
    // 【第十八轮 24.12】显式 retry facts：覆盖全部会改变真实 Game API 调用
    // 语义的参数（durable payload 不含 fee——retry facts 必须覆盖）。
    retryFacts(args: TreasuryTestTransferArgs): Record<string, string | number | boolean> {
      return {
        op: "transfer",
        fromRoom: args.fromRoom,
        fromLocation: args.fromLocation,
        toRoom: args.toRoom,
        toLocation: args.toLocation,
        resource: args.resource,
        amount: args.amount,
        ...(args.feeFromRoom !== undefined ? { feeFromRoom: args.feeFromRoom } : {}),
        ...(args.feeAmount !== undefined ? { feeAmount: args.feeAmount } : {}),
      };
    },
    reconcile(): TreasuryActionReconcilerConclusion {
      return reconcileConclusion;
    },
  };
}
