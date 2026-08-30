/**
 * Treasury-owned policy authority（第十轮 3.12.9）。
 *
 * production contract authorization 不接受调用方直接提供的 withhold——
 * strategic reserve / resource floor / action-specific withhold / emergency
 * override 由**注册 policy resolver** 计算（显式、可审计、版本化）；bundle
 * 绑定 policy identity/version/digest 与计算结果摘要，policy 变化使旧 bundle
 * 失效；无注册 resolver 时 production 授权 fail closed（policy_not_ready）。
 *
 * 注册边界：registerTreasuryPolicyResolver 仅供测试 setup 与显式 policy
 * 装配调用（架构测试守护生产业务模块不得注册/调用）；自由字符串 policy
 * name 不赋予权威。完整 Budget Service 明确延期（本模块只建立权威边界与
 * 三个受控测试 policy：fixed reserve / no reserve / emergency override）。
 */

import { hashTreasuryCanonicalString } from "@/runtime/treasury/transactionId";

/** policy 决策（受控、确定性）：授权额度计算的权威输入。 */
export interface TreasuryPolicyDecision {
  /** 该资源该 scope 的 withhold（保守扣减；不得为负）。 */
  readonly withhold: number;
  /** strategic reserve（审计保留字段；与 withhold 一并参与额度）。 */
  readonly strategicReserve: number;
  /** emergency override（显式、可审计——不得静默）。 */
  readonly emergencyOverride: boolean;
  /** 决策摘要（同输入确定性；bundle 绑定）。 */
  readonly digest: string;
}

/** policy resolver（注册制；单槽——全局唯一 policy 身份）。 */
export interface TreasuryPolicyResolver {
  readonly policyId: string;
  readonly policyVersion: number;
  evaluate(context: {
    readonly resource: string;
    readonly rooms: readonly string[];
    readonly tick: number;
  }): TreasuryPolicyDecision | { readonly status: "rejected"; readonly reason: string };
}

let registeredResolver: TreasuryPolicyResolver | null = null;

/** 注册 policy resolver（同 policyId 重注册幂等；不同 policyId 先清后注册）。 */
export function registerTreasuryPolicyResolver(resolver: TreasuryPolicyResolver): void {
  if (!resolver || typeof resolver !== "object" || typeof resolver.policyId !== "string" || resolver.policyId.length === 0) {
    throw new Error("policy resolver 非法（policyId 必填）");
  }
  registeredResolver = resolver;
}

/** 只读查找（无注册返回 undefined——调用方 fail closed）。 */
export function findTreasuryPolicyResolver(): TreasuryPolicyResolver | undefined {
  return registeredResolver ?? undefined;
}

/** policy authority readiness（authorization/write readiness 共用）。 */
export function treasuryPolicyAuthorityReady(): boolean {
  return registeredResolver !== null;
}

/** 当前 policy authority identity（policyId@version；无注册返回 null）。 */
export function treasuryPolicyAuthorityIdentity(): string | null {
  return registeredResolver === null ? null : `${registeredResolver.policyId}@v${String(registeredResolver.policyVersion)}`;
}

/** 仅供测试：清除注册（fail closed 用例）。 */
export function clearTreasuryPolicyResolversForTest(): void {
  registeredResolver = null;
}

// ── 受控测试 policy（本轮唯一内置；生产 Budget Service 延期） ───────────────

function decisionOf(withhold: number, strategicReserve: number, emergencyOverride: boolean, contextKey: string): TreasuryPolicyDecision {
  const digest = hashTreasuryCanonicalString(`policy:${contextKey}:${String(withhold)}:${String(strategicReserve)}:${String(emergencyOverride)}`);
  return { withhold, strategicReserve, emergencyOverride, digest };
}

/** 无 reserve policy（测试默认）。 */
export function makeNoReserveTreasuryPolicy(policyId = "treasury.test.no-reserve", policyVersion = 1): TreasuryPolicyResolver {
  return {
    policyId,
    policyVersion,
    evaluate: (context) => decisionOf(0, 0, false, `${policyId}:${String(policyVersion)}:${context.resource}`),
  };
}

/** fixed reserve policy（每资源固定扣减）。 */
export function makeFixedReserveTreasuryPolicy(reserve: number, policyId = "treasury.test.fixed-reserve", policyVersion = 1): TreasuryPolicyResolver {
  return {
    policyId,
    policyVersion,
    evaluate: (context) => decisionOf(reserve, reserve, false, `${policyId}:${String(policyVersion)}:${context.resource}`),
  };
}

/** emergency override policy（显式可审计）。 */
export function makeEmergencyOverrideTreasuryPolicy(policyId = "treasury.test.emergency", policyVersion = 1): TreasuryPolicyResolver {
  return {
    policyId,
    policyVersion,
    evaluate: (context) => decisionOf(0, 0, true, `${policyId}:${String(policyVersion)}:${context.resource}`),
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
