/**
 * Treasury canonical action contract 与注册 adapter registry（第八轮）。
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
 * - **注册边界**：registerTreasuryActionAdapter 仅 actionContracts.ts 自身
 *   与测试可调用（架构测试守护）；重复 kind 注册拒绝；
 * - **执行入口** executeTreasuryActionContract：adapter 存在且 kind 匹配 →
 *   contract 冻结校验（调用方事后修改原 args 不影响 canonical）→ 授权
 *   token 消费（postings 覆盖校验——实际动作不超出授权 scope）→ 结构
 *   incarnation 校验（变化拒绝）→ 经 executePreparedAction 走第八轮唯一
 *   安全顺序（durable intent → executing → adapter.execute 恰好一次 →
 *   commit/abort）；
 * - **executePreparedAction 降级为内部/test-only 低层原语**：生产模块不得
 *   以任意 callback 调用（架构测试守护）——真实生产模块未来只能消费
 *   Treasury 签发的 action contract；
 * - 本轮不接任何真实生产 writer：内置测试 adapter（多 posting fixture +
 *   可配置副作用与 reconciler 结论）。
 */

import type { TreasuryService } from "@/runtime/treasury/facade";
import type { TreasuryAuthorizationToken } from "@/runtime/treasury/authorization";
import type { TreasurySafeExecuteResult, TreasuryObservationScope, TreasuryPosting } from "@/runtime/treasury/types";
import { hashTreasuryCanonicalString } from "@/runtime/treasury/transactionId";

const ACTION_KIND_MAX = 128;
const VALID_LOCATION_KINDS: ReadonlySet<string> = new Set<string>(["storage", "terminal"]);
const VALID_RESOURCES: ReadonlySet<string> = new Set<string>(RESOURCES_ALL);

/** adapter 对账结论（与 faultResolution 的 resolution conclusion 同语义）。 */
export type TreasuryActionReconcilerConclusion = "observed_committed" | "observed_not_executed" | "still_uncertain";

export interface TreasuryActionReconcilerFacts {
  readonly actionKind: string;
  readonly transactionId: string;
  readonly resource: string;
  readonly amount: number;
  readonly postings: readonly TreasuryPosting[];
}

/**
 * 受注册的 action adapter 契约。execute 必须恰好调用对应 Game API 一次并
 * 返回 {ok, ...}；reconcile 依据 post-fault observation 判定动作是否已发生
 * （未提供 reconcile 的 kind 不可签发 reconciliation capability）。
 */
export interface TreasuryActionAdapter<TArgs = unknown, TResult extends { ok: boolean } = { ok: boolean }> {
  readonly kind: string;
  readonly version: number;
  validate(args: unknown): string | null;
  derivePostings(args: TArgs): readonly { roomName: string; locationKind: string; resource: string; delta: number }[];
  execute(args: TArgs): TResult;
  structureIds?(args: TArgs): readonly string[];
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
  if (adapter.structureIds !== undefined && typeof adapter.structureIds !== "function") {
    return "adapter.structureIds 须为函数";
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

/** 不可伪造的 action contract（heap-only 冻结 capability；WeakSet 防伪）。 */
export interface TreasuryActionContract {
  readonly __brand: "treasury-action-contract";
  /** "ac:"+digest 定长 identity。 */
  readonly contractId: string;
  readonly actionKind: string;
  readonly transactionId: string;
  /** canonical action args 的冻结深拷贝（调用方事后修改原对象不影响）。 */
  readonly args: unknown;
  /** adapter.derivePostings(args) 确定性派生（规范排序冻结）。 */
  readonly postings: readonly TreasuryPosting[];
  /** 构建时点的结构 incarnation 快照（locationKey → structureId）。 */
  readonly structureSnapshots: Readonly<Record<string, string | undefined>>;
  readonly structureIds: readonly string[];
  readonly digest: string;
  readonly epoch: {
    readonly scope: TreasuryObservationScope;
    readonly epochSeq: number;
    readonly observedAtTick: number;
  };
  readonly builtAtTick: number;
}

const contractRegistry = new WeakSet<TreasuryActionContract>();

/** 冻结深拷贝（canonical args——原始对象与数组逐层复制冻结）。 */
function freezeCanonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeCanonical));
  }
  if (value && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      copy[key] = freezeCanonical((value as Record<string, unknown>)[key]);
    }
    return Object.freeze(copy);
  }
  return value;
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

export interface TreasuryActionContractRequest {
  readonly actionKind: string;
  readonly transactionId: string;
  readonly args: unknown;
  readonly source?: string;
}

/**
 * 执行请求：预构建 contract（伪造对象一律无效）或 actionKind/transactionId/
 * args 构建参数——二选一；authorization 为授权 token（单资源 action 一个；
 * 多资源 action 每种负 posting 资源各一个——执行时逐个消费并做联合覆盖
 * 校验，实际动作不得超出授权 scope）。
 */
export interface TreasuryActionExecutionRequest {
  readonly contract?: TreasuryActionContract;
  readonly actionKind?: string;
  readonly transactionId?: string;
  readonly args?: unknown;
  readonly source?: string;
  readonly authorization?: TreasuryAuthorizationToken | readonly TreasuryAuthorizationToken[];
}

export type TreasuryActionContractResult =
  | { readonly status: "built"; readonly contract: TreasuryActionContract }
  | {
      readonly status: "rejected";
      readonly reason: "invalid_input" | "adapter_not_registered" | "contract_invalid";
      readonly detail: string;
    };



/**
 * 构建 canonical action contract：adapter 校验 args → derivePostings 确定性
 * 派生 → 结构 incarnation 快照 → digest 绑定 → 冻结 + 私有 registry 注册。
 * posts 与 Game API 参数同源（同一 args 派生），两套事实通道不复存在。
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
  const argsError = adapter.validate(request.args);
  if (argsError !== null) {
    actionContractEvents.rejected += 1;
    return { status: "rejected", reason: "contract_invalid", detail: `args 校验失败: ${argsError}` };
  }
  const derived = adapter.derivePostings(request.args);
  const postingsError = validateDerivedPostings(derived);
  if (postingsError !== null) {
    actionContractEvents.rejected += 1;
    return { status: "rejected", reason: "contract_invalid", detail: `derivePostings 输出非法: ${postingsError}` };
  }
  const observation = service.observation();
  // 结构 incarnation 快照：posting 涉及的每个 location 的 structureId。
  const structureSnapshots: Record<string, string | undefined> = {};
  const locationSeen = new Set<string>();
  for (const posting of derived) {
    const key = `${posting.roomName}:${posting.locationKind}`;
    if (locationSeen.has(key)) continue;
    locationSeen.add(key);
    if (observation.hasRoom(posting.roomName)) {
      structureSnapshots[key] = observation.location(posting.roomName, posting.locationKind as "storage" | "terminal").structureId;
    }
  }
  const structureIds = adapter.structureIds ? [...adapter.structureIds(request.args)] : [];
  const sortedPostings = [...derived].sort((a, b) => (postingKey(a) < postingKey(b) ? -1 : postingKey(a) > postingKey(b) ? 1 : 0));
  const canonicalArgs = JSON.stringify(request.args);
  const digest = hashTreasuryCanonicalString(
    `AC1:s:${String(request.actionKind.length)}:${request.actionKind}:s:${String(request.transactionId.length)}:${request.transactionId}:s:${String(canonicalArgs.length)}:${canonicalArgs}:${sortedPostings
      .map((p) => `${p.roomName}|${p.locationKind}|${p.resource}|${String(p.delta)}`)
      .join(",")}`,
  );
  const contract = Object.freeze({
    __brand: "treasury-action-contract",
    contractId: `ac:${digest}`,
    actionKind: request.actionKind,
    transactionId: request.transactionId,
    args: freezeCanonical(request.args),
    postings: Object.freeze(sortedPostings.map((p) => Object.freeze({ ...p }))),
    structureSnapshots: Object.freeze({ ...structureSnapshots }),
    structureIds: Object.freeze([...structureIds]),
    digest,
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
 * 1. contract 防伪（私有 registry 对象身份——伪造/JSON 副本一律无效）与
 *    adapter kind 匹配（mismatch 拒绝）；
 * 2. 授权 token 消费（transactionId 绑定 + postings 覆盖校验——实际动作
 *    不超出授权 scope；无授权的执行一律拒绝）；
 * 3. 结构 incarnation 校验（contract 快照 vs 当前 observation，变化拒绝）；
 * 4. 经 executePreparedAction 走第八轮唯一安全顺序（durable intent →
 *    executing → adapter.execute 恰好一次 → commit/abort/fault 隔离）。
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
  const authorizationTokens: readonly TreasuryAuthorizationToken[] =
    request.authorization === undefined
      ? []
      : Array.isArray(request.authorization)
        ? request.authorization
        : [request.authorization];
  if (authorizationTokens.length === 0) {
    actionContractEvents.rejected += 1;
    return {
      status: "prepare_rejected",
      reason: "authorization_invalid",
      detail: "action contract 执行必须携带授权 token（真实写动作不得只凭物理可行性通过）",
    };
  }
  // 逐 token 消费：每个 token 只校验自己 resource 的 postings（多资源
  // action 每种负 posting 资源分别授权）。
  for (const token of authorizationTokens) {
    const resourcePostings = contract.postings.filter((posting) => posting.resource === token.resource);
    const consumed = service.consumeTreasuryAuthorization(token, {
      transactionId: contract.transactionId,
      postings: resourcePostings,
    });
    if (consumed.status !== "ok") {
      actionContractEvents.rejected += 1;
      return { status: "prepare_rejected", reason: "authorization_invalid", detail: `授权消费失败（${consumed.reason}）: ${consumed.detail}` };
    }
    if (token.contractDigest !== undefined && token.contractDigest !== contract.digest) {
      actionContractEvents.rejected += 1;
      return { status: "prepare_rejected", reason: "contract_invalid", detail: "授权绑定的 contract digest 与实际 contract 不一致" };
    }
  }
  // 联合覆盖校验：每个负 posting 必须被至少一个已消费 token 的 scope 覆盖。
  for (const posting of contract.postings) {
    if (posting.delta >= 0) continue;
    const covered = authorizationTokens.some(
      (token) =>
        token.resource === posting.resource &&
        token.rooms.includes(posting.roomName) &&
        token.locations.includes(posting.locationKind),
    );
    if (!covered) {
      actionContractEvents.rejected += 1;
      return {
        status: "prepare_rejected",
        reason: "authorization_invalid",
        detail: `posting ${posting.roomName}:${posting.locationKind}:${posting.resource} 的流出未被任何授权 token 覆盖`,
      };
    }
  }
  // 结构 incarnation 校验：contract 快照 vs 执行时点的结构现实。shared
  // observation 是 tick 级不可变快照（同 tick 内恒等），故优先用一次 fresh
  // 观察重扫结构（额度耗尽时退回 shared——prepare 的物理验证仍兜底位置
  // 存在性与容量）。
  const freshObservation = service.beginFreshObservation();
  const observation = freshObservation ?? service.observation();
  for (const posting of contract.postings) {
    const key = `${posting.roomName}:${posting.locationKind}`;
    const currentStructureId = observation.hasRoom(posting.roomName)
      ? observation.location(posting.roomName, posting.locationKind as "storage" | "terminal").structureId
      : undefined;
    if (contract.structureSnapshots[key] !== currentStructureId) {
      actionContractEvents.rejected += 1;
      return {
        status: "prepare_rejected",
        reason: "structure_replaced",
        detail: `结构 incarnation 已变化（${key}: ${String(contract.structureSnapshots[key])} → ${String(currentStructureId)}）——必须重新构建 contract`,
      };
    }
  }
  return service.executePreparedAction(
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
    structureIds(args: TreasuryTestTransferArgs): readonly string[] {
      return [`${args.fromRoom}:${args.fromLocation}`, `${args.toRoom}:${args.toLocation}`];
    },
    reconcile(): TreasuryActionReconcilerConclusion {
      return reconcileConclusion;
    },
  };
}
