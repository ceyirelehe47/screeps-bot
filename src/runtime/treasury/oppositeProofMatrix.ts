/**
 * 【Round 22 Remediation III 十】相反结论 proof 的 fail-closed 矩阵——
 * 唯一实现。
 *
 * 同 transaction ID 存在身份不足的相反结论 proof 时，既有路径把它当作
 * "相反 proof 不存在"（insufficient 折叠为 absent）。由于一个 transaction
 * ID 只代表一个 attempt，同 ID 的冲突 proof 不可能属于"另一个合法
 * attempt"——冲突必须进入 forensic/fail-closed，而不是 unrelated。
 *
 * 四分类（十.0）——以上四种都不能当作"相反 proof 不存在"：
 *  - exact_match：相反结论 proof 与当前 attempt 完整 identity 匹配；
 *  - identity_conflict：同 transaction ID 但任一 identity 维度冲突；
 *  - insufficient：proof 存在但身份维度不足（legacy / 缺 lineage 绑定）；
 *  - store_unhealthy：对应 store 损坏 / 形状非法。
 *
 * Committed 目标（10.1）阻断源：
 *  - final not-executed tombstone（match / conflict / insufficient / 损坏）；
 *  - matching 或 conflicting GRA proof（identity 不足同样阻断）。
 *
 * Not-executed 目标（10.2）阻断源：
 *  - trusted committed Receipt（trusted_proof / identity_conflict /
 *    legacy_insufficient / store_unhealthy——只有 absent 放行）；
 *  - resolving/final committed tombstone（match / conflict / insufficient）。
 *
 * tombstone / GRA 读取经装配 probes 注入（避免模块环）；未装配 →
 * fail closed（store_unhealthy 语义——无法证明无相反 proof 时不得放行）。
 * committed Receipt 检查直接复用 trustedSettlementProof 单一权威。
 */

import { readTreasuryTrustedSettlementProofForAttempt } from "@/runtime/treasury/trustedSettlementProof";
import {
  treasuryExactAttemptIdentityOfFacts,
  treasuryExactAttemptIdentityRelation,
  type TreasuryExactAttemptIdentity,
} from "@/runtime/treasury/exactAttemptIdentity";
import { resolveTreasuryDurableSettlementAuthority } from "@/runtime/treasury/historicalSettlementAuthority";

/** 四分类（absent 之外全部是阻断）。 */
export type TreasuryOppositeProofClassification =
  | "absent"
  | "exact_match"
  | "identity_conflict"
  | "insufficient"
  | "store_unhealthy";

export interface TreasuryOppositeProofBlocker {
  readonly source: "not-executed-tombstone" | "gra-proof" | "committed-receipt" | "committed-tombstone" | "historical-authority" | "durable-settlement-authority";
  readonly classification: Exclude<TreasuryOppositeProofClassification, "absent">;
  readonly detail: string;
}

/** tombstone 的 structural 视图（与 settlementProofActivation 同构）。 */
export interface TreasuryOppositeProofTombstoneView {
  readonly transactionId: string;
  readonly digest: string;
  readonly resolution: string;
  readonly stage: string;
  readonly proofLevel: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  readonly lineageId?: string;
  readonly lineageGeneration?: number;
  readonly parentTransactionId?: string;
  readonly lineageBindingDigest?: string;
}

/** GRA proof 的 structural 视图（generationRetirementAuthority 同构）。 */
export interface TreasuryOppositeProofGraView {
  readonly transactionId: string;
  readonly digest: string;
  readonly lineageId: string;
  readonly generation: number;
  readonly parentTransactionId?: string;
  readonly bindingDigest?: string;
  readonly contractDigest?: string;
  readonly authorizationCohortDigest?: string;
  readonly durableIdentityDigest?: string;
  readonly lowlevelSource?: string;
  /** 【Remediation IV 8.3】proof class 维度（缺失 → 身份不可证明 insufficient）。 */
  readonly authorityClass?: "identity-bound" | "lowlevel";
}

export interface TreasuryOppositeProofDeps {
  readonly readTombstone: (transactionId: string) => TreasuryOppositeProofTombstoneView | undefined;
  readonly resolutionStoreHealthy: () => boolean;
  readonly lookupGRAProof: (transactionId: string) => TreasuryOppositeProofGraView | undefined;
  readonly graStoreHealthy: () => boolean;
}

let oppositeDeps: TreasuryOppositeProofDeps | null = null;

export function registerTreasuryOppositeProofDepsForAssembly(deps: TreasuryOppositeProofDeps | null): void {
  oppositeDeps = deps;
}

export function peekTreasuryOppositeProofDeps(): TreasuryOppositeProofDeps | null {
  return oppositeDeps;
}

export interface TreasuryOppositeProofCheck {
  readonly blockers: readonly TreasuryOppositeProofBlocker[];
  /** blockers 为空 = 无相反 proof 证据且 store 健康（可放行）。 */
  readonly clear: boolean;
}

const TOMBSTONE_CLASS_OF_LEVEL: Record<string, "identity-bound" | "lowlevel" | "legacy"> = {
  "identity-bound": "identity-bound",
  modern: "identity-bound",
  lowlevel: "lowlevel",
};

function exactOfTombstoneView(
  tombstone: TreasuryOppositeProofTombstoneView,
): TreasuryExactAttemptIdentity | null {
  return treasuryExactAttemptIdentityOfFacts(
    tombstone.transactionId,
    {
      digest: tombstone.digest,
      ...(tombstone.contractDigest !== undefined ? { contractDigest: tombstone.contractDigest } : {}),
      ...(tombstone.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: tombstone.authorizationCohortDigest } : {}),
      ...(tombstone.durableIdentityDigest !== undefined ? { durableIdentityDigest: tombstone.durableIdentityDigest } : {}),
      ...(tombstone.lowlevelSource !== undefined ? { lowlevelSource: tombstone.lowlevelSource } : {}),
      ...(tombstone.lineageId !== undefined ? { lineageId: tombstone.lineageId } : {}),
      ...(tombstone.lineageGeneration !== undefined ? { lineageGeneration: tombstone.lineageGeneration } : {}),
      ...(tombstone.parentTransactionId !== undefined ? { parentTransactionId: tombstone.parentTransactionId } : {}),
      ...(tombstone.lineageBindingDigest !== undefined ? { lineageBindingDigest: tombstone.lineageBindingDigest } : {}),
    },
    TOMBSTONE_CLASS_OF_LEVEL[tombstone.proofLevel] ?? "legacy",
  );
}

/**
 * Committed 目标的相反 proof 检查：final not-executed tombstone + GRA proof。
 * expected 为当前 attempt 的完整 exact identity（journal entry / tombstone
 * 构造）。tombstone 缺失且 store 健康 → absent 放行；resolution 为
 * committed 的 tombstone 不是 not-executed 目标的相反 proof（不阻断）。
 */
export function checkTreasuryOppositeProofsForCommitted(
  transactionId: string,
  expected: TreasuryExactAttemptIdentity,
): TreasuryOppositeProofCheck {
  const blockers: TreasuryOppositeProofBlocker[] = [];
  if (oppositeDeps === null) {
    return {
      blockers: [
        {
          source: "not-executed-tombstone",
          classification: "store_unhealthy",
          detail: "opposite proof deps 未装配（无法证明无相反 proof——fail closed）",
        },
      ],
      clear: false,
    };
  }
  // 10.1：final not-executed tombstone。
  if (!oppositeDeps.resolutionStoreHealthy()) {
    blockers.push({ source: "not-executed-tombstone", classification: "store_unhealthy", detail: "resolution store unhealthy（无法证明无相反 tombstone）" });
  } else {
    const tombstone = oppositeDeps.readTombstone(transactionId);
    if (tombstone !== undefined && tombstone.resolution === "not-executed") {
      const exact = exactOfTombstoneView(tombstone);
      if (exact === null) {
        blockers.push({ source: "not-executed-tombstone", classification: "insufficient", detail: "not-executed tombstone 无法构造完整 exact identity（insufficient——阻断）" });
      } else {
        const relation = treasuryExactAttemptIdentityRelation(exact, expected);
        if (relation === "match") {
          blockers.push({ source: "not-executed-tombstone", classification: "exact_match", detail: "同 transaction ID 存在 final not-executed tombstone 且完整 identity 匹配（相反结论成立——conflict）" });
        } else if (relation === "conflict") {
          blockers.push({ source: "not-executed-tombstone", classification: "identity_conflict", detail: "同 transaction ID 的 not-executed tombstone identity 冲突（不可证明无关——conflict）" });
        } else {
          blockers.push({ source: "not-executed-tombstone", classification: "insufficient", detail: "not-executed tombstone 身份维度不足（insufficient ≠ absent——阻断）" });
        }
      }
    }
  }
  // 10.1【Remediation IV 8.3】：matching 或 conflicting GRA proof——完整
  // exact identity relation（digest/proofClass/contract/cohort/durable/
  // lowlevel/lineage 四字段含 generation/parent/binding），不再手工比较
  // 部分字段；维度不足或不可证明同样阻断（insufficient ≠ absent）。
  if (!oppositeDeps.graStoreHealthy()) {
    blockers.push({ source: "gra-proof", classification: "store_unhealthy", detail: "GRA proof store unhealthy（无法证明无相反 GRA proof）" });
  } else {
    const gra = oppositeDeps.lookupGRAProof(transactionId);
    if (gra !== undefined) {
      if (gra.authorityClass !== "identity-bound" && gra.authorityClass !== "lowlevel") {
        blockers.push({ source: "gra-proof", classification: "insufficient", detail: "GRA proof 缺 authorityClass（proof class 维度不可证明——insufficient ≠ absent）" });
      } else {
        const graExact = treasuryExactAttemptIdentityOfFacts(
          gra.transactionId,
          {
            digest: gra.digest,
            ...(gra.contractDigest !== undefined ? { contractDigest: gra.contractDigest } : {}),
            ...(gra.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: gra.authorizationCohortDigest } : {}),
            ...(gra.durableIdentityDigest !== undefined ? { durableIdentityDigest: gra.durableIdentityDigest } : {}),
            ...(gra.authorityClass === "lowlevel" && gra.lowlevelSource !== undefined ? { lowlevelSource: gra.lowlevelSource } : {}),
            ...(gra.generation >= 1
              ? {
                  lineageId: gra.lineageId,
                  lineageGeneration: gra.generation,
                  parentTransactionId: gra.parentTransactionId,
                  lineageBindingDigest: gra.bindingDigest,
                }
              : {}),
          },
          gra.authorityClass,
        );
        if (graExact === null) {
          blockers.push({ source: "gra-proof", classification: "insufficient", detail: "GRA proof 无法构造完整 exact identity（lineage/parent/binding 维度缺失——insufficient ≠ absent）" });
        } else {
          const relation = treasuryExactAttemptIdentityRelation(graExact, expected);
          if (relation === "match") {
            blockers.push({ source: "gra-proof", classification: "exact_match", detail: "同 transaction ID 存在完整 identity 匹配的 GRA proof（not_executed 结论——conflict）" });
          } else if (relation === "conflict") {
            blockers.push({ source: "gra-proof", classification: "identity_conflict", detail: "同 transaction ID 的 GRA proof identity 冲突（不可证明无关——conflict）" });
          } else {
            blockers.push({ source: "gra-proof", classification: "insufficient", detail: "GRA proof 身份维度不足（insufficient ≠ absent——阻断）" });
          }
        }
      }
    }
  }
  // 【Remediation VII 修复一 / VIII 工作流 B】统一 durable settlement
  // authority resolver 进入相反 proof 矩阵（live/historical/certificate/
  // range 无短路聚合——chain 压缩后的 certificate 权威同样被认识）：
  // 目标 committed 时，matching 的 durable not-executed 权威（exact 或
  // certificate 协议推导）是相反结论 proof（exact_match 阻断）；同 ID 权威
  // 冲突 / store unhealthy 同样阻断；**同方向（committed）权威不是相反
  // proof——不阻断**（查询不带 outcome 视角，按权威真实 resolution 判定
  // 方向）。
  {
    // 【VIII 工作流 B】不带 expected 视角查询（同 ID 相反结论一律阻断——
    // identity 维度只影响 classification，不影响方向判定；权威真实 outcome
    // 先于视角，避免把维度不足的权威误判为"无关"）。
    const durable = resolveTreasuryDurableSettlementAuthority({ transactionId });
    if ((durable.status === "exact" || durable.status === "protocol") && durable.outcome === "not-executed") {
      blockers.push({
        source: "durable-settlement-authority",
        classification: "exact_match",
        detail: `同 transaction ID 存在 durable not-executed 权威（${durable.source}——相反结论成立，conflict）`,
      });
    } else if (durable.status === "conflict") {
      blockers.push({
        source: "durable-settlement-authority",
        classification: "identity_conflict",
        detail: `${durable.detail}（持久权威互相矛盾——无法证明无相反权威）`,
      });
    } else if (durable.status === "store_unhealthy") {
      blockers.push({
        source: "durable-settlement-authority",
        classification: "store_unhealthy",
        detail: `durable settlement authority store unhealthy（无法证明无相反权威）: ${durable.detail}`,
      });
    }
  }
  return { blockers, clear: blockers.length === 0 };
}

/**
 * Not-executed 目标的相反 proof 检查（10.2）：trusted committed Receipt +
 * resolving/final committed tombstone。trusted Receipt 只有 absent 放行
 * （legacy/insufficient/store_unhealthy/identity_conflict 全部阻断——无法
 * 证明相反 proof 属于另一个 attempt 就不等于它不存在）。
 */
export function checkTreasuryOppositeProofsForNotExecuted(
  transactionId: string,
  expected: TreasuryExactAttemptIdentity,
): TreasuryOppositeProofCheck {
  const blockers: TreasuryOppositeProofBlocker[] = [];
  // 10.2：trusted committed Receipt（单一权威——receipts store 任一无关
  // entry 损坏时返回 store_unhealthy，不返回 trusted_proof）。
  const trusted = readTreasuryTrustedSettlementProofForAttempt(transactionId, expected);
  if (trusted.status === "trusted_proof") {
    blockers.push({ source: "committed-receipt", classification: "exact_match", detail: "同 transaction ID 存在 trusted committed Receipt（相反结论成立——conflict）" });
  } else if (trusted.status === "identity_conflict") {
    blockers.push({ source: "committed-receipt", classification: "identity_conflict", detail: `${trusted.detail}（不可证明无关——conflict）` });
  } else if (trusted.status === "legacy_insufficient") {
    blockers.push({ source: "committed-receipt", classification: "insufficient", detail: `${trusted.detail}（legacy/insufficient ≠ absent——阻断）` });
  } else if (trusted.status === "store_unhealthy") {
    blockers.push({ source: "committed-receipt", classification: "store_unhealthy", detail: `${trusted.detail}（无法证明无相反 Receipt）` });
  }
  if (oppositeDeps === null) {
    blockers.push({
      source: "committed-tombstone",
      classification: "store_unhealthy",
      detail: "opposite proof deps 未装配（无法证明无相反 tombstone——fail closed）",
    });
    return { blockers, clear: false };
  }
  if (!oppositeDeps.resolutionStoreHealthy()) {
    blockers.push({ source: "committed-tombstone", classification: "store_unhealthy", detail: "resolution store unhealthy（无法证明无相反 tombstone）" });
  } else {
    const tombstone = oppositeDeps.readTombstone(transactionId);
    if (tombstone !== undefined && tombstone.resolution === "committed" && (tombstone.stage === "resolving" || tombstone.stage === "final")) {
      const exact = exactOfTombstoneView(tombstone);
      if (exact === null) {
        blockers.push({ source: "committed-tombstone", classification: "insufficient", detail: "committed tombstone 无法构造完整 exact identity（insufficient——阻断）" });
      } else {
        const relation = treasuryExactAttemptIdentityRelation(exact, expected);
        if (relation === "match") {
          blockers.push({ source: "committed-tombstone", classification: "exact_match", detail: `同 transaction ID 存在 ${tombstone.stage} committed tombstone 且完整 identity 匹配（相反结论——conflict）` });
        } else if (relation === "conflict") {
          blockers.push({ source: "committed-tombstone", classification: "identity_conflict", detail: "同 transaction ID 的 committed tombstone identity 冲突（不可证明无关——conflict）" });
        } else {
          blockers.push({ source: "committed-tombstone", classification: "insufficient", detail: "committed tombstone 身份维度不足（insufficient ≠ absent——阻断）" });
        }
      }
    }
  }
  // 【Remediation VII 修复一 / VIII 工作流 B】目标 not-executed 时：统一
  // resolver（live/historical/certificate/range）的 matching committed
  // 权威（exact 或 protocol）是相反 proof；权威冲突 / unhealthy 同样阻断；
  // 同方向（not-executed）权威不阻断。
  {
    // 【VIII 工作流 B】不带 expected 视角查询（同 ID 相反结论一律阻断——
    // identity 维度只影响 classification，不影响方向判定；权威真实 outcome
    // 先于视角，避免把维度不足的权威误判为"无关"）。
    const durable = resolveTreasuryDurableSettlementAuthority({ transactionId });
    if ((durable.status === "exact" || durable.status === "protocol") && durable.outcome === "committed") {
      blockers.push({
        source: "durable-settlement-authority",
        classification: "exact_match",
        detail: `同 transaction ID 存在 durable committed 权威（${durable.source}——相反结论成立，conflict）`,
      });
    } else if (durable.status === "conflict") {
      blockers.push({
        source: "durable-settlement-authority",
        classification: "identity_conflict",
        detail: `${durable.detail}（持久权威互相矛盾——无法证明无相反权威）`,
      });
    } else if (durable.status === "store_unhealthy") {
      blockers.push({
        source: "durable-settlement-authority",
        classification: "store_unhealthy",
        detail: `durable settlement authority store unhealthy（无法证明无相反权威）: ${durable.detail}`,
      });
    }
  }
  return { blockers, clear: blockers.length === 0 };
}
