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
import type { TreasuryAuthorizationBundle, TreasuryAuthorizationToken } from "@/runtime/treasury/authorization";
import { TREASURY_WRITER_KERNEL, type TreasuryKernelHolder } from "@/runtime/treasury/kernelChannel";
import type { TreasurySafeExecuteResult, TreasuryObservationScope, TreasuryPosting } from "@/runtime/treasury/types";
import { hashTreasuryCanonicalString } from "@/runtime/treasury/transactionId";
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
}

/** 受控结构引用（第九轮）：adapter 声明额外 action-relevant 结构的唯一形状。 */
export interface TreasuryActionStructureBinding {
  readonly roomName: string;
  readonly locationKind: "storage" | "terminal";
  /** 快照 label（缺省 `${roomName}:${locationKind}`；须唯一）。 */
  readonly label?: string;
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
  validate(args: unknown): string | null;
  derivePostings(args: TArgs): readonly { roomName: string; locationKind: string; resource: string; delta: number }[];
  execute(args: TArgs): TResult;
  /** 额外 action-relevant 结构（受控形状；执行前全部重验 incarnation）。 */
  structureBindings?(args: TArgs): readonly TreasuryActionStructureBinding[];
  /** 有界版本化对账事实（持久 intent 的 durable payload 来源）。 */
  durableFacts?(args: TArgs): TreasuryDurableFacts | null;
  reconcile?(facts: TreasuryActionReconcilerFacts, observation: unknown): TreasuryActionReconcilerConclusion;
}

// ── registry ────────────────────────────────────────────────────────────────

const adapterRegistry = new Map<string, TreasuryActionAdapter<never, never>>();

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
  if (typeof adapter.validate !== "function") return "adapter.validate 缺失";
  if (typeof adapter.derivePostings !== "function") return "adapter.derivePostings 缺失";
  if (typeof adapter.execute !== "function") return "adapter.execute 缺失";
  if (adapter.structureBindings !== undefined && typeof adapter.structureBindings !== "function") {
    return "adapter.structureBindings 须为函数";
  }
  if (adapter.durableFacts !== undefined && typeof adapter.durableFacts !== "function") {
    return "adapter.durableFacts 须为函数";
  }
  if (adapter.reconcile !== undefined && typeof adapter.reconcile !== "function") {
    return "adapter.reconcile 须为函数";
  }
  return null;
}

/**
 * 注册 adapter（架构边界：仅 actionContracts.ts 与测试可调用——生产模块
 * 不得动态注册）。重复 kind 注册拒绝（一个 kind 一个权威实现）。
 */
export function registerTreasuryActionAdapter(
  adapter: TreasuryActionAdapter,
): TreasuryAdapterRegistrationResult {
  const shapeError = validateAdapterShape(adapter);
  if (shapeError !== null) return { status: "rejected", detail: shapeError };
  if (adapterRegistry.has(adapter.kind)) {
    return { status: "rejected", detail: `action kind ${adapter.kind} 已注册（一个 kind 一个权威 adapter）` };
  }
  adapterRegistry.set(adapter.kind, adapter as unknown as TreasuryActionAdapter<never, never>);
  return { status: "registered" };
}

/** 仅供测试：移除注册（测试隔离用；生产禁用——架构测试守护）。 */
export function unregisterTreasuryActionAdapterForTest(kind: string): boolean {
  return adapterRegistry.delete(kind);
}

/** 仅供测试：覆盖注册（同一 kind 重新配置；生产禁用）。 */
export function replaceTreasuryActionAdapterForTest(adapter: TreasuryActionAdapter): TreasuryAdapterRegistrationResult {
  unregisterTreasuryActionAdapterForTest(adapter.kind);
  return registerTreasuryActionAdapter(adapter);
}

export function findTreasuryActionAdapter(kind: string): TreasuryActionAdapter | undefined {
  return adapterRegistry.get(kind) as TreasuryActionAdapter | undefined;
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
  readonly digest: string;
  /** adapter.durableFacts(canonical) 的有界对账事实（intent 持久化来源）。 */
  readonly durableFacts?: Readonly<TreasuryDurableFacts>;
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
): { readonly status: "ok"; readonly contract: TreasuryActionContract; readonly adapter: TreasuryActionAdapter } | {
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
    const label = candidate.label ?? `${candidate.roomName}:${candidate.locationKind}`;
    if (typeof label !== "string" || label.length === 0 || label.length > 48) return "structureBinding label 非法";
    if (seenLabels.has(label)) return `structureBinding label 重复: ${label}`;
    seenLabels.add(label);
    typed.push({ roomName: candidate.roomName, locationKind: candidate.locationKind, label });
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
  readonly authorization?: TreasuryAuthorizationBundle | TreasuryAuthorizationToken | readonly TreasuryAuthorizationToken[];
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

/** 结构快照的长度前缀 canonical 文本（label 排序确定）。 */
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
 * 构建 canonical action contract：canonicalize args → adapter 校验 →
 * derivePostings 确定性派生 → 结构 incarnation 快照（posting locations +
 * 受控 structureBindings）→ digest 绑定（AC2）→ 冻结 + 私有 registry 注册。
 * postings 与 Game API 参数同源（同一 canonical args 派生），两套事实通道
 * 不复存在。
 */
export function buildTreasuryActionContract(
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
  const argsError = adapter.validate(canonicalArgs);
  if (argsError !== null) {
    actionContractEvents.rejected += 1;
    return { status: "rejected", reason: "contract_invalid", detail: `args 校验失败: ${argsError}` };
  }
  const derived = adapter.derivePostings(canonicalArgs);
  const postingsError = validateDerivedPostings(derived);
  if (postingsError !== null) {
    actionContractEvents.rejected += 1;
    return { status: "rejected", reason: "contract_invalid", detail: `derivePostings 输出非法: ${postingsError}` };
  }
  const observation = service.observation();
  // 结构 incarnation 快照（第九轮 4.12）：posting 涉及的每个 location 的
  // structureId + adapter 受控声明的额外结构（全部执行前重验）。
  const structureSnapshots: Record<string, string | undefined> = {};
  const bindingList: TreasuryActionStructureBinding[] = [];
  const locationSeen = new Set<string>();
  for (const posting of derived) {
    const key = `${posting.roomName}:${posting.locationKind}`;
    if (locationSeen.has(key)) continue;
    locationSeen.add(key);
    structureSnapshots[key] = observation.hasRoom(posting.roomName)
      ? observation.location(posting.roomName, posting.locationKind as "storage" | "terminal").structureId
      : undefined;
    bindingList.push({ roomName: posting.roomName, locationKind: posting.locationKind as "storage" | "terminal", label: key });
  }
  if (adapter.structureBindings !== undefined) {
    const bindings = validateStructureBindings(adapter.structureBindings(canonicalArgs));
    if (typeof bindings === "string") {
      actionContractEvents.rejected += 1;
      return { status: "rejected", reason: "contract_invalid", detail: `structureBindings 输出非法: ${bindings}` };
    }
    for (const binding of bindings) {
      if (Object.prototype.hasOwnProperty.call(structureSnapshots, binding.label)) continue; // 与 posting location 重合
      // 声明的结构必须可验证：房间不在管辖或位置缺失 → 拒绝（不允许
      // "声明了但无法验证"）。
      if (!observation.hasRoom(binding.roomName)) {
        actionContractEvents.rejected += 1;
        return {
          status: "rejected",
          reason: "contract_invalid",
          detail: `structureBinding 声明房间 ${binding.roomName} 不在管辖（无法验证 incarnation——拒绝）`,
        };
      }
      structureSnapshots[binding.label] = observation.location(binding.roomName, binding.locationKind).structureId;
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
    const facts = adapter.durableFacts(canonicalArgs);
    if (facts !== null && facts !== undefined) {
      const factsError = validateDurableFacts(facts);
      if (factsError !== null) {
        actionContractEvents.rejected += 1;
        return { status: "rejected", reason: "contract_invalid", detail: `durableFacts 输出非法: ${factsError}` };
      }
      durableFacts = { version: facts.version, payload: facts.payload };
    }
  }
  const sortedPostings = [...derived].sort((a, b) => (postingKey(a) < postingKey(b) ? -1 : postingKey(a) > postingKey(b) ? 1 : 0));
  const digest = hashTreasuryCanonicalString(
    `AC2:ce:${String(TREASURY_CANONICAL_ENCODING_VERSION)}:k:${String(request.actionKind.length)}:${request.actionKind}:av:${String(adapter.version)}:t:${String(request.transactionId.length)}:${request.transactionId}:a:${String(canonicalized.text.length)}:${canonicalized.text}:p:${sortedPostings.map(canonicalPostingText).join(",")}:s:${canonicalStructuresText(structureSnapshots)}`,
  );
  const contract = Object.freeze({
    __brand: "treasury-action-contract",
    contractId: `ac:${digest}`,
    actionKind: request.actionKind,
    adapterVersion: adapter.version,
    transactionId: request.transactionId,
    args: canonicalArgs,
    canonicalArgsText: canonicalized.text,
    postings: Object.freeze(sortedPostings.map((p) => Object.freeze({ ...p }))),
    structureSnapshots: Object.freeze({ ...structureSnapshots }),
    structureBindings: Object.freeze(sortedBindings.map((b) => Object.freeze({ ...b }))),
    digest,
    ...(durableFacts !== undefined ? { durableFacts: Object.freeze({ ...durableFacts }) } : {}),
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
    const currentStructureId = freshObservation.hasRoom(binding.roomName)
      ? freshObservation.location(binding.roomName, binding.locationKind).structureId
      : undefined;
    const snapshotId = contract.structureSnapshots[label];
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
      source: request.source ?? "action-contract",
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
      intentContract: {
        contractId: contract.contractId,
        contractDigest: contract.digest,
        adapterVersion: contract.adapterVersion,
        authorizationDigest: resolvedBundle.authorizationDigest,
        ...(contract.durableFacts !== undefined
          ? { durablePayload: contract.durableFacts.payload, durablePayloadVersion: contract.durableFacts.version }
          : {}),
        ...(contract.structureBindings.length > 0
          ? {
              structureFacts: contract.structureBindings
                .map((binding) => {
                  const label = binding.label ?? `${binding.roomName}:${binding.locationKind}`;
                  return {
                    roomName: binding.roomName,
                    locationKind: binding.locationKind,
                    structureId: (contract.structureSnapshots as Record<string, string | undefined>)[label] ?? "",
                  };
                })
                .filter((fact) => fact.structureId !== ""),
            }
          : {}),
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
    reconcile(): TreasuryActionReconcilerConclusion {
      return reconcileConclusion;
    },
  };
}
