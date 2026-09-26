/**
 * Treasury-owned policy authority（第十轮 3.12.9 建立、第十一轮 3.13.3 升级
 * immutable registration + Treasury-computed decision digest）。
 *
 * production contract authorization 不接受调用方直接提供的 withhold——
 * strategic reserve / resource floor / action-specific withhold / emergency
 * override 由**注册 policy resolver** 计算（显式、可审计、版本化）。
 *
 * 第十一轮 immutable registry：
 * - 注册时快照固定 evaluate 函数引用并冻结 registration record——调用方
 *   事后修改原 resolver 对象不影响 authority（同 kind 的 adapter registry
 *   同语义）；同 policyId+version 不同实现拒绝（替换须提升 version 或换
 *   policyId）；policyVersion 必须为正安全整数；registry 可 seal；
 * - **decision digest 由 Treasury 计算**：resolver 只返回业务事实
 *   （withhold/strategicReserve/emergencyOverride/auditReason），不得自报
 *   digest——Treasury 按 canonical context（contract ID/digest、actionKind、
 *   resource、rooms、owner identity、tick、policy registration identity）与
 *   validated decision 自行计算；evaluate 抛错结构化 fail closed；
 * - bundle redemption 验证 exact policy registration identity 与 decision
 *   digest（字符串前缀比较已删除）。
 *
 * 注册边界：registerTreasuryPolicyResolver 仅供测试 setup 与显式 policy
 * 装配调用（架构测试守护生产业务模块不得注册/调用）；自由字符串 policy
 * name 不赋予权威。完整 Budget Service 明确延期（本模块只建立权威边界与
 * 三个受控测试 policy：fixed reserve / no reserve / emergency override）。
 */

import { hashTreasuryCanonicalString } from "@/runtime/treasury/transactionId";

const POLICY_ID_MAX = 96;
const POLICY_AUDIT_REASON_MAX = 96;
/** policy decision 的受控字段上限（非负安全整数语义）。 */
const POLICY_AMOUNT_MAX = 100_000_000_000;

/**
 * policy 业务事实（resolver 的唯一输出通道，第十一轮起**无自报 digest**——
 * digest 由 Treasury 计算；auditReason 为可选有界审计字段）。
 */
export interface TreasuryPolicyDecision {
  /** 该资源该 scope 的 withhold（保守扣减；不得为负）。 */
  readonly withhold: number;
  /** strategic reserve（审计保留字段；与 withhold 一并参与额度）。 */
  readonly strategicReserve: number;
  /** emergency override（显式、可审计——不得静默）。 */
  readonly emergencyOverride: boolean;
  /** 可选审计原因（有界；不参与 digest）。 */
  readonly auditReason?: string;
}

/**
 * policy 评估上下文（Treasury 组装的 canonical context——digest 输入的
 * 一部分；resolver 不可自行挑选上下文）。
 */
export interface TreasuryPolicyContext {
  readonly contractId: string;
  readonly contractDigest: string;
  readonly actionKind: string;
  readonly resource: string;
  readonly rooms: readonly string[];
  readonly ownerIdentity: string;
  readonly tick: number;
}

/** policy resolver（注册制；单槽——全局唯一 policy 身份）。 */
export interface TreasuryPolicyResolver {
  readonly policyId: string;
  readonly policyVersion: number;
  evaluate(context: TreasuryPolicyContext): TreasuryPolicyDecision | { readonly status: "rejected"; readonly reason: string };
}

/**
 * 冻结的 policy registration record（公开视图）：registrationId 为
 * `hash(policy:policyId:version:seq)`——每次合法注册唯一；同 policyId+version
 * 的 test-only 替换（clear 后重注册）产生新 registrationId，旧 bundle 因
 * registration identity 不匹配失效。
 */
export interface TreasuryRegisteredPolicyResolver {
  readonly policyId: string;
  readonly policyVersion: number;
  readonly registrationId: string;
  evaluate(context: TreasuryPolicyContext): TreasuryPolicyDecision | { readonly status: "rejected"; readonly reason: string };
}

interface TreasuryPolicyRegistrationRecord extends TreasuryRegisteredPolicyResolver {
  readonly registeredAtTick: number;
}

let registeredRecord: TreasuryPolicyRegistrationRecord | null = null;
/** registrationId 种子（每次成功注册 +1）。 */
let policyRegistrationSequence = 0;
/** registry revision（成功注册计数；诊断）。 */
let policyRegistryRevision = 0;
/** seal 标志：生产装配完成后阻止动态注册/重注册。 */
let policyRegistrySealed = false;

export type TreasuryPolicyRegistrationResult =
  | { readonly status: "registered" }
  | { readonly status: "rejected"; readonly detail: string };

/**
 * 注册 policy resolver（immutable registration，第十一轮 3.13.3）：
 * - policyId 非空有界字符串、policyVersion 正安全整数、evaluate 函数；
 * - 同 policyId+version：同 evaluate 引用幂等，不同实现拒绝；
 * - 不同 policyId 替换需提升 version 或换 ID（同 version 不同 ID 允许——
 *   单槽语义下这是显式 policy 切换，registrationId 变化使旧 bundle 失效）；
 * - seal 后拒绝。
 */
export function registerTreasuryPolicyResolver(resolver: TreasuryPolicyResolver): TreasuryPolicyRegistrationResult {
  if (!resolver || typeof resolver !== "object") {
    return { status: "rejected", detail: "policy resolver 非法（非对象）" };
  }
  if (typeof resolver.policyId !== "string" || resolver.policyId.length === 0 || resolver.policyId.length > POLICY_ID_MAX) {
    return { status: "rejected", detail: "policy resolver 非法（policyId 须为 1..96 字符）" };
  }
  if (
    typeof resolver.policyVersion !== "number" ||
    !Number.isSafeInteger(resolver.policyVersion) ||
    resolver.policyVersion <= 0
  ) {
    return { status: "rejected", detail: `policy resolver 非法（policyVersion 须为正安全整数: ${String(resolver.policyVersion)}）` };
  }
  if (typeof resolver.evaluate !== "function") {
    return { status: "rejected", detail: "policy resolver 非法（evaluate 须为函数）" };
  }
  if (policyRegistrySealed) {
    return { status: "rejected", detail: "policy registry 已 seal（生产装配完成——动态注册拒绝）" };
  }
  if (registeredRecord !== null) {
    const sameSlot = registeredRecord.policyId === resolver.policyId;
    if (sameSlot && registeredRecord.policyVersion === resolver.policyVersion) {
      if (registeredRecord.evaluate !== resolver.evaluate) {
        return {
          status: "rejected",
          detail: `policy ${resolver.policyId}@v${String(resolver.policyVersion)} 已注册不同实现（immutable registry——替换须提升 version 或更换 policyId）`,
        };
      }
      return { status: "registered" };
    }
    // 不同 policyId 或更高 version：显式切换/演进（registrationId 变化 →
    // 旧 bundle 失效）。同 policyId 更低 version 拒绝（版本只升不降）。
    if (sameSlot && resolver.policyVersion < registeredRecord.policyVersion) {
      return {
        status: "rejected",
        detail: `policy ${resolver.policyId} 当前 v${String(registeredRecord.policyVersion)}，不可注册更低 v${String(resolver.policyVersion)}（版本只升不降）`,
      };
    }
  }
  policyRegistrationSequence += 1;
  const registrationId = hashTreasuryCanonicalString(
    `policy:${resolver.policyId}:${String(resolver.policyVersion)}:${String(policyRegistrationSequence)}`,
  );
  const record: TreasuryPolicyRegistrationRecord = Object.freeze({
    policyId: resolver.policyId,
    policyVersion: resolver.policyVersion,
    registrationId,
    evaluate: resolver.evaluate,
    registeredAtTick: Game.time,
  });
  registeredRecord = record;
  policyRegistryRevision += 1;
  return { status: "registered" };
}

/**
 * 只读查找（无注册返回 undefined——调用方 fail closed）；返回冻结公开视图
 * （registrationId + 固定 evaluate 引用；内部 registeredAtTick 不泄漏）。
 */
export function findTreasuryPolicyResolver(): TreasuryRegisteredPolicyResolver | undefined {
  return registeredRecord ?? undefined;
}

/** policy authority readiness（authorization/write readiness 共用）。 */
export function treasuryPolicyAuthorityReady(): boolean {
  return registeredRecord !== null;
}

/**
 * 当前 policy authority identity（第十一轮 3.13.3：含 registrationId 的
 * exact identity——redemption 用 registrationId 比对，不再用该字符串前缀）。
 */
export function treasuryPolicyAuthorityIdentity(): string | null {
  return registeredRecord === null
    ? null
    : `${registeredRecord.policyId}@v${String(registeredRecord.policyVersion)}#${registeredRecord.registrationId}`;
}

/** policy registry revision（成功注册计数；诊断）。 */
export function readTreasuryPolicyRegistryRevision(): number {
  return policyRegistryRevision;
}

/** 生产装配 seal（调用点 runtimeServices.ts；架构测试守护）。 */
export function sealTreasuryPolicyRegistryForProduction(): void {
  policyRegistrySealed = true;
}

/** 仅供测试：解除 seal（测试隔离用）。 */
export function unsealTreasuryPolicyRegistryForTest(): void {
  policyRegistrySealed = false;
}

/** 仅供测试：清除注册（fail closed 用例）。 */
export function clearTreasuryPolicyResolversForTest(): void {
  registeredRecord = null;
  policyRegistrySealed = false;
}

// ── Treasury-computed decision digest（第十一轮 3.13.3） ─────────────────────

/**
 * policy decision 的完整验证（resolver 输出不可信）：withhold/
 * strategicReserve 非负安全整数且有界、emergencyOverride 布尔、auditReason
 * 有界字符串。返回 null = 合法。
 */
export function validateTreasuryPolicyDecision(decision: TreasuryPolicyDecision): string | null {
  if (!decision || typeof decision !== "object") return "policy decision 非对象";
  for (const key of ["withhold", "strategicReserve"] as const) {
    const value = decision[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > POLICY_AMOUNT_MAX) {
      return `policy decision.${key} 非法（须为 0..${String(POLICY_AMOUNT_MAX)} 安全整数）`;
    }
  }
  if (typeof decision.emergencyOverride !== "boolean") {
    return "policy decision.emergencyOverride 须为布尔";
  }
  if (decision.auditReason !== undefined) {
    if (typeof decision.auditReason !== "string" || decision.auditReason.length > POLICY_AUDIT_REASON_MAX) {
      return `policy decision.auditReason 非法（≤${String(POLICY_AUDIT_REASON_MAX)} 字符）`;
    }
  }
  return null;
}

/**
 * **Treasury 计算**的 policy decision digest（不信任 resolver 自报——决策
 * 接口已无 digest 字段；本函数是唯一权威）：canonical context + validated
 * decision + policy registration identity 的确定性 hash。任何输入变化
 * （contract/resource/rooms/owner/tick/registration/决策字段）→ digest 变化。
 */
export function computeTreasuryPolicyDecisionDigest(
  registration: { readonly policyId: string; readonly policyVersion: number; readonly registrationId: string },
  context: TreasuryPolicyContext,
  decision: TreasuryPolicyDecision,
): string {
  const canonicalContext = [
    `cid:${String(context.contractId.length)}:${context.contractId}`,
    `cd:${String(context.contractDigest.length)}:${context.contractDigest}`,
    `ak:${String(context.actionKind.length)}:${context.actionKind}`,
    `r:${String(context.resource.length)}:${context.resource}`,
    `rm:${[...context.rooms].sort().map((room) => `${String(room.length)}:${room}`).join(",")}`,
    `o:${String(context.ownerIdentity.length)}:${context.ownerIdentity}`,
    `t:${String(context.tick)}`,
  ].join("|");
  return hashTreasuryCanonicalString(
    `policy-decision:${registration.registrationId}:${canonicalContext}:${String(decision.withhold)}:${String(decision.strategicReserve)}:${String(decision.emergencyOverride)}`,
  );
}

// ── 受控测试 policy（本轮唯一内置；生产 Budget Service 延期） ───────────────

/** 无 reserve policy（测试默认）。 */
export function makeNoReserveTreasuryPolicy(policyId = "treasury.test.no-reserve", policyVersion = 1): TreasuryPolicyResolver {
  return {
    policyId,
    policyVersion,
    evaluate: (): TreasuryPolicyDecision => ({ withhold: 0, strategicReserve: 0, emergencyOverride: false }),
  };
}

/** fixed reserve policy（每资源固定扣减）。 */
export function makeFixedReserveTreasuryPolicy(reserve: number, policyId = "treasury.test.fixed-reserve", policyVersion = 1): TreasuryPolicyResolver {
  return {
    policyId,
    policyVersion,
    evaluate: (): TreasuryPolicyDecision => ({ withhold: reserve, strategicReserve: reserve, emergencyOverride: false }),
  };
}

/** emergency override policy（显式可审计）。 */
export function makeEmergencyOverrideTreasuryPolicy(policyId = "treasury.test.emergency", policyVersion = 1): TreasuryPolicyResolver {
  return {
    policyId,
    policyVersion,
    evaluate: (): TreasuryPolicyDecision => ({ withhold: 0, strategicReserve: 0, emergencyOverride: true, auditReason: "emergency-override-test-policy" }),
  };
}

/**
 * 测试 setup 便捷注册（test/setup.ts 的全局 beforeEach 调用——除显式
 * clearTreasuryPolicyResolversForTest 的 fail closed 用例外，全部测试默认
 * 无 reserve policy 可用）。
 */
export function registerDefaultTreasuryTestPolicyForSetup(): void {
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
}
