/**
 * 【第十七轮第七节】service-issued opaque rearm capability——不可伪造的
 * heap-only 能力对象，取代 Round 16 返回普通 child ID 字符串的 rearm 通道。
 *
 * 固定语义：
 * - capability 绑定 lineage ID/revision、parent attempt ID 与 identity digest、
 *   child attempt ID、generation、retry semantic digest、action kind、
 *   adapter 稳定语义身份、authority class、owner 或 lowlevelSource、
 *   service generation、tick、nonce；
 * - heap-only：私有 WeakSet 验证对象身份——JSON 复制、手工构造普通对象、
 *   跨 service 实例一律无效；对象冻结；
 * - 单次使用；跨 tick、跨 service（generation）、跨 parent、跨 child、
 *   lineage revision 变化后一律失效；
 * - 未使用而 tick 结束/global reset：heap capability 失效但 durable lineage
 *   保持 ready，新 service 重签发新 capability（child ID 确定性不变）；
 * - 已成功接管 child durable intent（child_active）后该 generation 不得
 *   重新签发（lineage 状态门禁在 issue 侧承载）；
 * - 同 tick 重复 issuance 幂等返回同一 capability 对象（不产生两个可同时
 *   消费的 capability）。
 *
 * 模块只提供 authority 工厂与绑定事实视图；issue 的 cross-store 前置检查
 * 在 facade（attemptOccupancy 集中管理），consume 内核经 writer kernel
 * symbol 通道（不进公共 service 面）。
 */

import { readTreasuryAttemptLineageRecord, type TreasuryAttemptLineageState } from "@/runtime/treasury/attemptLineage";
import {
  TREASURY_HANDOFF_CONSUME_EXPECTED_STATE,
  expectedTreasuryHandoffConsumeRevision,
  treasuryRearmCapabilityBindingMatchesLineageRecord,
} from "@/runtime/treasury/lineageHandoff";

/** capability 的绑定事实（可读视图——对象身份才是防伪权威）。 */
export interface TreasuryRearmCapabilityBinding {
  readonly lineageId: string;
  readonly lineageRecordRevision: number;
  readonly parentTransactionId: string;
  readonly parentIdentityDigest: string;
  readonly childTransactionId: string;
  readonly generation: number;
  readonly retrySemanticDigest: string;
  readonly actionKind: string;
  readonly adapterSemanticIdentity?: string;
  readonly authorityClass: "identity-bound" | "lowlevel";
  readonly ownerIdentity?: string;
  readonly lowlevelSource?: string;
  readonly bindingDigest: string;
}

export interface TreasuryRearmCapability {
  readonly __brand: "treasury-rearm-capability";
  readonly binding: Readonly<TreasuryRearmCapabilityBinding>;
  readonly serviceGeneration: number;
  readonly tick: number;
  readonly nonce: number;
}

export type TreasuryRearmCapabilityValidation =
  | { readonly status: "valid"; readonly capability: TreasuryRearmCapability }
  | {
      readonly status: "rejected";
      readonly reason:
        | "invalid_capability"
        | "already_used"
        | "cross_generation"
        | "cross_tick"
        | "lineage_revision_changed"
        | "lineage_state_unexpected"
        | "lineage_binding_mismatch"
        | "lineage_missing";
      readonly detail: string;
    };

export interface TreasuryRearmCapabilityAuthority {
  /** 签发注册（issue 前置检查通过后由 facade 调用；同 tick 同 lineage 幂等）。 */
  registerCapability(binding: TreasuryRearmCapabilityBinding, serviceGeneration: number, tick: number): TreasuryRearmCapability;
  /** 只读验证（对象身份/未消费/generation/tick/lineage revision——零消费）。 */
  validateRearmCapability(capability: unknown): TreasuryRearmCapabilityValidation;
  /** 校验并消费（单次使用；child durable intent read-back 一致后调用）。 */
  consumeRearmCapability(capability: unknown): TreasuryRearmCapabilityValidation;
  /** 当前未消费 capability 数（诊断）。 */
  readonly outstandingCount: number;
}

let rearmCapabilityNonce = 0;

/**
 * 建立 rearm capability authority（service 闭包私有——跨实例隔离）。
 * capability 的 lineage revision 校验直接读 Memory record（durable 权威）。
 */
export function createTreasuryRearmCapabilityAuthority(deps: {
  readonly serviceGeneration: number;
}): TreasuryRearmCapabilityAuthority {
  const issuedCapabilities = new WeakSet<TreasuryRearmCapability>();
  const consumedCapabilities = new WeakSet<TreasuryRearmCapability>();
  // 同 tick 已签发的活跃 capability（lineageId → capability）——同 tick 重复
  // issuance 幂等返回同一对象；tick 推进即丢弃（heap-only 生命周期）。
  let activeByLineage = new Map<string, TreasuryRearmCapability>();
  let activeTick = -1;
  let outstanding = 0;

  const validate = (
    capability: unknown,
    options?: {
      /** 消费路径的严格期望：lineage 必须处于该状态、revision 必须等于该值。 */
      readonly expectedLineageState?: TreasuryAttemptLineageState;
      readonly expectedLineageRevision?: number;
    },
  ): TreasuryRearmCapabilityValidation => {
    if (!capability || typeof capability !== "object") {
      return { status: "rejected", reason: "invalid_capability", detail: "capability 缺失或非对象" };
    }
    if (!issuedCapabilities.has(capability as TreasuryRearmCapability)) {
      return {
        status: "rejected",
        reason: "invalid_capability",
        detail: "capability 未在本 service 实例签发（普通对象/JSON round-trip 副本/跨实例一律无效——child ID 只能经 issueTreasuryRearmCapability 获取）",
      };
    }
    const typed = capability as TreasuryRearmCapability;
    if (consumedCapabilities.has(typed)) {
      return { status: "rejected", reason: "already_used", detail: "capability 已消费（单次使用）" };
    }
    if (typed.serviceGeneration !== deps.serviceGeneration) {
      return {
        status: "rejected",
        reason: "cross_generation",
        detail: "capability 由旧 Treasury service 签发（global reset 后必须重新签发）",
      };
    }
    if (typed.tick !== Game.time) {
      return {
        status: "rejected",
        reason: "cross_tick",
        detail: `capability 于 tick ${String(typed.tick)} 签发（当前 ${String(Game.time)}）——跨 tick 失效`,
      };
    }
    // lineage 与 Memory record 一致（durable 权威；record 缺失 = 已被外部推进/
    // 清除——失效）。【第十八轮 24.2】消费路径严格期望：state === 预期 handoff
    // 状态、revision === capability 允许的明确 revision（签发 revision + 1——
    // child_intent_pending 推进），且 binding 与 record 的完整匹配矩阵成立
    //（lineageId/child/generation/pendingBinding/retry semantic）——不再存在
    // skip-all-revision 旁路。
    const record = readTreasuryAttemptLineageRecord(typed.binding.lineageId);
    if (record === undefined) {
      return { status: "rejected", reason: "lineage_missing", detail: "lineage record 不存在（capability 绑定的 durable 权威缺失）" };
    }
    if (options?.expectedLineageState !== undefined || options?.expectedLineageRevision !== undefined) {
      if (options.expectedLineageState !== undefined && record.state !== options.expectedLineageState) {
        return {
          status: "rejected",
          reason: "lineage_state_unexpected",
          detail: `lineage 状态 ${String(record.state)} 不是预期的 ${String(options.expectedLineageState)}（capability 不得消费）`,
        };
      }
      if (
        options.expectedLineageRevision !== undefined &&
        record.recordRevision !== options.expectedLineageRevision
      ) {
        return {
          status: "rejected",
          reason: "lineage_revision_changed",
          detail: `lineage record revision ${String(record.recordRevision)} 不等于 capability 允许的明确 revision ${String(options.expectedLineageRevision)}——旧 capability 失效`,
        };
      }
      const bindingMatch = treasuryRearmCapabilityBindingMatchesLineageRecord(typed.binding, record);
      if (bindingMatch.status === "rejected") {
        return { status: "rejected", reason: "lineage_binding_mismatch", detail: bindingMatch.detail };
      }
    } else if (record.recordRevision !== typed.binding.lineageRecordRevision) {
      // 只读验证（authorization 阶段）：revision 必须仍等于签发值。
      return {
        status: "rejected",
        reason: "lineage_revision_changed",
        detail: `lineage record revision 已变化（capability ${String(typed.binding.lineageRecordRevision)}，record ${String(record.recordRevision)}）——旧 capability 失效`,
      };
    }
    return { status: "valid", capability: typed };
  };

  return {
    registerCapability(binding, serviceGeneration, tick) {
      if (tick !== activeTick) {
        activeByLineage = new Map();
        activeTick = tick;
      }
      const active = activeByLineage.get(binding.lineageId);
      if (active !== undefined && !consumedCapabilities.has(active) && active.tick === tick) {
        // 同 tick 重复 issuance：幂等返回同一对象。
        return active;
      }
      rearmCapabilityNonce += 1;
      const capability: TreasuryRearmCapability = Object.freeze({
        __brand: "treasury-rearm-capability",
        binding: Object.freeze({ ...binding }),
        serviceGeneration,
        tick,
        nonce: rearmCapabilityNonce,
      });
      issuedCapabilities.add(capability);
      activeByLineage.set(binding.lineageId, capability);
      outstanding += 1;
      return capability;
    },
    validateRearmCapability: (capability: unknown) => validate(capability),
    consumeRearmCapability(capability: unknown): TreasuryRearmCapabilityValidation {
      // 【第十八轮 24.2】严格消费：lineage 必须处于 child_intent_pending 且
      // revision 等于签发 revision+1（child_intent_pending 推进），binding 与
      // record 完整匹配——不再跳过全部 revision 检查。
      const typedPeek = capability as TreasuryRearmCapability | null | undefined;
      const expectedRevision =
        typedPeek && typeof typedPeek === "object" && typeof typedPeek.binding?.lineageRecordRevision === "number"
          ? expectedTreasuryHandoffConsumeRevision(typedPeek.binding.lineageRecordRevision)
          : undefined;
      const validated = validate(capability, {
        expectedLineageState: TREASURY_HANDOFF_CONSUME_EXPECTED_STATE,
        ...(expectedRevision !== undefined ? { expectedLineageRevision: expectedRevision } : {}),
      });
      if (validated.status !== "valid") return validated;
      consumedCapabilities.add(validated.capability);
      outstanding = Math.max(0, outstanding - 1);
      return validated;
    },
    get outstandingCount(): number {
      return outstanding;
    },
  };
}

/**
 * capability 与目标 attempt/contract 的绑定匹配检查（facade 各门禁点共用）：
 * child ID、parent ID（可选校验）、action kind、adapter 语义身份。
 */
export function treasuryRearmCapabilityMatches(
  capability: TreasuryRearmCapability,
  expected: {
    readonly childTransactionId: string;
    readonly parentTransactionId?: string;
    readonly actionKind?: string;
    readonly adapterSemanticIdentity?: string;
  },
): { readonly status: "matched" } | { readonly status: "rejected"; readonly detail: string } {
  if (capability.binding.childTransactionId !== expected.childTransactionId) {
    return {
      status: "rejected",
      detail: `capability 绑定 child ${capability.binding.childTransactionId.slice(0, 24)} 与目标 attempt ${expected.childTransactionId.slice(0, 24)} 不一致（跨 child capability 无效）`,
    };
  }
  if (expected.parentTransactionId !== undefined && capability.binding.parentTransactionId !== expected.parentTransactionId) {
    return {
      status: "rejected",
      detail: `capability 绑定 parent ${capability.binding.parentTransactionId.slice(0, 24)} 与目标 parent ${expected.parentTransactionId.slice(0, 24)} 不一致（跨 parent capability 无效）`,
    };
  }
  if (expected.actionKind !== undefined && capability.binding.actionKind !== expected.actionKind) {
    return { status: "rejected", detail: `capability 绑定 action kind ${capability.binding.actionKind} 与 contract ${expected.actionKind} 不一致` };
  }
  if (
    expected.adapterSemanticIdentity !== undefined &&
    capability.binding.adapterSemanticIdentity !== expected.adapterSemanticIdentity
  ) {
    return {
      status: "rejected",
      detail: "capability 绑定 adapter 稳定语义身份与 contract 不一致（adapter 语义已变化——不可 rearm）",
    };
  }
  return { status: "matched" };
}
