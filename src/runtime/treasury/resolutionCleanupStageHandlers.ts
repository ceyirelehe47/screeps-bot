/**
 * 【Round 22 Remediation III】resolution cleanup stage handlers——阶段外部
 * 事实验证器的唯一实现（模块加载时自动装配）。
 *
 * 本模块把原 facade 工厂内的 handler 注册与 proof activation / opposite
 * proof 装配 probes 提取为独立模块，并在模块加载时顶层执行：
 *  - 任何经 resolutionStore / coordinator / ack 进入 cleanup 链路的测试与生产入口都获得同一装配（不依赖测试手工 install）；
 *  - 本模块对 resolutionStore / GRA / attemptLineage 的使用全部在函数体内（顶层只调用注册函数，不触发循环初始化）；
 *  - 测试可经 registerTreasuryResolutionCleanupHandlersForAssembly(null)
 *   模拟“未装配 fail closed”（模块不会再次自动恢复）。
 */

import { resolveTreasuryUnresolvedAuthority } from "@/runtime/treasury/unresolvedAuthority";
import {
  readTreasuryResolutionTombstone,
  writeTreasuryResolutionTombstone,
  peekTreasuryResolutionStoreHealth,
} from "@/runtime/treasury/resolutionStore";
import { readTreasuryTrustedSettlementProofForAttempt } from "@/runtime/treasury/trustedSettlementProof";
import { verifyTreasuryCommittedResolutionProof } from "@/runtime/treasury/committedProofVerifier";
import { dischargeTreasuryExactAuthorityForCleanup } from "@/runtime/treasury/exactAuthorityDischarge";
import {
  relateTreasuryGenerationRetirementProofForOutcome,
  relateTreasuryRootLineageForNotExecuted,
  verifyTreasuryLineageFinalizationState,
} from "@/runtime/treasury/lineageFinalizationProof";
import { registerTreasuryRootLineageRelationForAssembly } from "@/runtime/treasury/rootLineageRelationChannel";
import {
  registerTreasuryResolutionCleanupHandlersForAssembly,
  type TreasuryResolutionCleanupStageHandlers,
} from "@/runtime/treasury/resolutionCleanupJournal";
import {
  checkTreasuryOppositeProofsForCommitted,
  checkTreasuryOppositeProofsForNotExecuted,
  registerTreasuryOppositeProofDepsForAssembly,
} from "@/runtime/treasury/oppositeProofMatrix";
import { registerTreasuryCleanupProofProbesForAssembly } from "@/runtime/treasury/settlementProofActivation";
import { assembleTreasuryResolutionCleanupCoordinator } from "@/runtime/treasury/resolutionCleanupCoordinator";
import {
  lookupTreasuryGenerationRetirementProofByAttemptId,
  peekTreasuryGenerationRetirementHealth,
} from "@/runtime/treasury/generationRetirementAuthority";
import {
  lookupTreasuryRetirementSummaryByRoot,
  peekTreasuryRetirementSummaryHealth,
} from "@/runtime/treasury/lineageRetirementSummary";
import {
  listTreasuryCleanupCompletionTransactionIds,
  lookupTreasuryCleanupCompletion,
} from "@/runtime/treasury/cleanupCompletionAuthority";
import { registerTreasuryCompletionReplacementProbesForAssembly } from "@/runtime/treasury/cleanupCompletionReplacement";
import {
  lookupTreasuryAttemptLineageByAttemptId,
  lookupTreasuryAttemptLineageByNextChild,
  closeTreasuryLineageAsChainCommitted,
  convergeTreasuryLineageRetirementFromFacts,
  rollbackTreasuryLineageToRearmReady,
} from "@/runtime/treasury/attemptLineage";
import {
  treasuryExactAttemptIdentityOfFacts,
  treasuryExactAttemptIdentityOfTombstone,
  treasuryExactAttemptIdentityRelation,
} from "@/runtime/treasury/exactAttemptIdentity";
import { isTreasuryRearmAttemptId } from "@/runtime/treasury/transactionId";
import { validateTreasurySemanticLineage } from "@/runtime/treasury/semanticLineageValidation";

/**
 * 【Remediation II D.4】journal outcome 阶段（committed）重验统一三方
 * verifier 所需的 tr1_ semantic lineage verdict（child ID 派生/parent/binding
 * 重算/authority 状态——非 tr1_ 返回 undefined；与 facade 原闭包同一实现）。
 */
function semanticLineageVerdictOfTombstoneFacts(
  tombstone: Parameters<typeof verifyTreasuryCommittedResolutionProof>[0]["tombstone"],
): { readonly verdict: string; readonly detail?: string } | undefined {
  if (!isTreasuryRearmAttemptId(tombstone.transactionId)) return undefined;
  if (
    tombstone.lineageId === undefined || tombstone.lineageGeneration === undefined ||
    tombstone.parentTransactionId === undefined || tombstone.lineageBindingDigest === undefined
  ) {
    return { verdict: "insufficient", detail: "tr1_ tombstone 缺完整 lineage proof（形状层应已拦截——防御）" };
  }
  const semantic = validateTreasurySemanticLineage({
    transactionId: tombstone.transactionId,
    proof: {
      lineageId: tombstone.lineageId,
      lineageGeneration: tombstone.lineageGeneration,
      parentTransactionId: tombstone.parentTransactionId,
      lineageBindingDigest: tombstone.lineageBindingDigest,
    },
    purpose: "committed_settlement",
    identity: {
      digest: tombstone.digest,
      ...(tombstone.contractDigest !== undefined ? { contractDigest: tombstone.contractDigest } : {}),
      ...(tombstone.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: tombstone.authorizationCohortDigest } : {}),
      ...(tombstone.durableIdentityDigest !== undefined ? { durableIdentityDigest: tombstone.durableIdentityDigest } : {}),
      ...(tombstone.lowlevelSource !== undefined ? { lowlevelSource: tombstone.lowlevelSource } : {}),
    },
  });
  return semantic.verdict === "match"
    ? { verdict: "match" }
    : { verdict: semantic.verdict, detail: "detail" in semantic ? semantic.detail : undefined };
}

/** 生产 stage handlers（原 facade 装配同一实现；authority/outcome/lineage 三阶段外部事实验证）。 */
export function treasuryResolutionCleanupStageHandlers(): TreasuryResolutionCleanupStageHandlers {
  return {
  authorityRelease: (entry) => {
    // 【Remediation IV 七】authority release 唯一实现委托 exact discharge：
    // pre-release gate（journal ↔ proof ↔ opposite ↔ lineage ↔ authority
    // 完整 exact 验证）与 release 位于同一同步窗口——同 transaction ID 的
    // 身份冲突 Authority（Intent/Quarantine/Authorization Fault 任一维度
    // 不同）不得被当作另一合法 attempt 删除；opposite proof 检查在 marker
    // discharge 之前（coordinator 阶段 0.5）与本 handler 双重前移。
    return dischargeTreasuryExactAuthorityForCleanup(entry);
  },
  outcomeFinalization: (entry) => {
    if (entry.resolution === "committed") {
      // 【Remediation II D.4】outcome 阶段不信任 journal boolean——final 也
      // 重新确认：exact tombstone 一致 + trusted Receipt + 统一三方
      // verifier（authority 此时应为 not_found——release 阶段已 read-back）。
      const tombstone = readTreasuryResolutionTombstone(entry.transactionId);
      if (tombstone === undefined || tombstone.resolution !== "committed") {
        return { status: "blocked", detail: "committed tombstone 缺失或结论不一致（outcome 不可 finalize）" };
      }
      const expected = treasuryExactAttemptIdentityOfFacts(
        entry.transactionId,
        {
          digest: entry.digest,
          ...(entry.contractDigest !== undefined ? { contractDigest: entry.contractDigest } : {}),
          ...(entry.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: entry.authorizationCohortDigest } : {}),
          ...(entry.durableIdentityDigest !== undefined ? { durableIdentityDigest: entry.durableIdentityDigest } : {}),
          ...(entry.lowlevelSource !== undefined ? { lowlevelSource: entry.lowlevelSource } : {}),
          ...(entry.lineageId !== undefined ? { lineageId: entry.lineageId } : {}),
          ...(entry.lineageGeneration !== undefined ? { lineageGeneration: entry.lineageGeneration } : {}),
          ...(entry.parentTransactionId !== undefined ? { parentTransactionId: entry.parentTransactionId } : {}),
          ...(entry.lineageBindingDigest !== undefined ? { lineageBindingDigest: entry.lineageBindingDigest } : {}),
        },
        entry.proofClass === "lowlevel" ? "lowlevel" : entry.proofClass === "identity-bound" ? "identity-bound" : "legacy",
      );
      if (expected === null) return { status: "blocked", detail: "journal entry 身份无法构造 exact identity" };
      const tombstoneExact = treasuryExactAttemptIdentityOfTombstone(tombstone);
      if (tombstoneExact === null || treasuryExactAttemptIdentityRelation(tombstoneExact, expected) !== "match") {
        return { status: "blocked", detail: "tombstone 与 journal entry 身份不一致（outcome 不可 finalize）" };
      }
      const trusted = readTreasuryTrustedSettlementProofForAttempt(entry.transactionId, expected);
      if (trusted.status !== "trusted_proof") {
        return { status: "blocked", detail: `committed trusted receipt ${trusted.status}: ${trusted.detail}` };
      }
      // 【Remediation III 十】相反结论 proof fail-closed 矩阵（唯一实现）：
      // 同 transaction ID 存在 not-executed tombstone / GRA proof 的
      // match、conflict、insufficient 或 store unhealthy 都阻断——insufficient
      // 与 store 损坏不得折叠为"相反 proof 不存在"。
      const opposite = checkTreasuryOppositeProofsForCommitted(entry.transactionId, expected);
      if (!opposite.clear) {
        return {
          status: "blocked",
          detail: `committed 相反 proof 阻断: ${opposite.blockers.map((blocker) => `${blocker.source}/${blocker.classification}`).join("; ")}`,
        };
      }
      const authorityResolution = resolveTreasuryUnresolvedAuthority(entry.transactionId);
      if (authorityResolution.status === "inconsistent" || authorityResolution.status === "store_unhealthy") {
        return { status: "blocked", detail: `authority resolver ${authorityResolution.status}（outcome 阶段重验失败）` };
      }
      // 【Remediation III 九】release 路径的 receipt 视图直接使用 trusted
      // proof（已通过 store 整体验证 + exact relation）——不再混入
      // replay-readable 单条读取。
      const receiptProof = trusted.proof;
      const semanticLineageVerdict = semanticLineageVerdictOfTombstoneFacts(tombstone);
      const verdict = verifyTreasuryCommittedResolutionProof({
        tombstone,
        authorityResolution,
        receiptProof,
        ...(semanticLineageVerdict !== undefined ? { semanticLineageVerdict } : {}),
      });
      if (verdict.status !== "verified") {
        return { status: "blocked", detail: `统一 committed verifier ${verdict.status}: ${verdict.detail}` };
      }
      if (tombstone.stage === "final") {
        return { status: "already_final", detail: "final committed tombstone 已重验（trusted receipt + verifier）" };
      }
      if (tombstone.stage !== "resolving") {
        return { status: "blocked", detail: `committed tombstone stage ${String(tombstone.stage)} 非 resolving/final` };
      }
      // resolvedAtTick 单调推进至 settledAtTick（final 终态时序矩阵要求
      // settledAtTick ≤ resolvedAtTick；staged 目标 tick 允许晚于创建时刻）。
      const write = writeTreasuryResolutionTombstone({
        ...tombstone,
        stage: "final",
        resolvedAtTick: Math.max(tombstone.resolvedAtTick, tombstone.settledAtTick ?? tombstone.resolvedAtTick),
      });
      if (write.status === "rejected") {
        return { status: "blocked", detail: `finalize 写入失败: ${write.detail}` };
      }
      return { status: "finalized", detail: "final committed tombstone 已写入（trusted receipt + verifier 重验通过）" };
    }
    // not-executed：tr1_ 需 matching exact GRA proof；initial 的 outcome
    // proof = final tombstone（已由 settlement proof 持久化保证）。
    // 【Remediation III 十】not-executed 的相反结论检查：trusted committed
    // Receipt / committed tombstone 的 match、conflict、insufficient、
    // store unhealthy 全部阻断（只有确证 absent 才放行）。
    {
      const notExecutedExpected = treasuryExactAttemptIdentityOfFacts(
        entry.transactionId,
        {
          digest: entry.digest,
          ...(entry.contractDigest !== undefined ? { contractDigest: entry.contractDigest } : {}),
          ...(entry.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: entry.authorizationCohortDigest } : {}),
          ...(entry.durableIdentityDigest !== undefined ? { durableIdentityDigest: entry.durableIdentityDigest } : {}),
          ...(entry.lowlevelSource !== undefined ? { lowlevelSource: entry.lowlevelSource } : {}),
          ...(entry.lineageId !== undefined ? { lineageId: entry.lineageId } : {}),
          ...(entry.lineageGeneration !== undefined ? { lineageGeneration: entry.lineageGeneration } : {}),
          ...(entry.parentTransactionId !== undefined ? { parentTransactionId: entry.parentTransactionId } : {}),
          ...(entry.lineageBindingDigest !== undefined ? { lineageBindingDigest: entry.lineageBindingDigest } : {}),
        },
        entry.proofClass === "lowlevel" ? "lowlevel" : entry.proofClass === "identity-bound" ? "identity-bound" : "legacy",
      );
      if (notExecutedExpected === null) {
        return { status: "blocked", detail: "journal entry 身份无法构造 exact identity（not-executed opposite 检查）" };
      }
      const oppositeNotExecuted = checkTreasuryOppositeProofsForNotExecuted(entry.transactionId, notExecutedExpected);
      if (!oppositeNotExecuted.clear) {
        return {
          status: "blocked",
          detail: `not-executed 相反 proof 阻断: ${oppositeNotExecuted.blockers.map((blocker) => `${blocker.source}/${blocker.classification}`).join("; ")}`,
        };
      }
    }
    if (entry.lineageId !== undefined && entry.lineageGeneration !== undefined) {
      // 【Remediation V 六】tr1_ 在途 child（chain 处于 capability_issued /
      // child_intent_pending——child 从未接管，current 仍是 parent）：child
      // not-executed 的 lineage 语义 = 回滚到 rearm_ready（该代无 retirement/
      // GRA 义务——outcome proof = final tombstone + 回滚事实，不是 converge
      // 后的 exact GRA proof）。回滚成功即 already_final；chain 不匹配 →
      // blocked（fail closed）。
      {
        const pendingChain = lookupTreasuryAttemptLineageByNextChild(entry.transactionId);
        if (
          pendingChain !== undefined &&
          pendingChain.lineageId === entry.lineageId &&
          pendingChain.generation + 1 === entry.lineageGeneration &&
          pendingChain.pendingBindingDigest === entry.lineageBindingDigest &&
          (pendingChain.state === "capability_issued" || pendingChain.state === "child_intent_pending")
        ) {
          const rolledBack = rollbackTreasuryLineageToRearmReady(pendingChain.lineageId);
          if (rolledBack.status === "rejected") {
            return { status: "blocked", detail: `tr1_ 在途 child 回滚失败: ${rolledBack.detail}` };
          }
          return { status: "already_final", detail: "tr1_ 在途 child not-executed：chain 已回滚 rearm_ready（child 代无 GRA 义务——outcome proof = final tombstone + 回滚）" };
        }
        // 已回滚（rearm_ready，nextChild/binding 事实保留）：同语义幂等完成。
        if (
          pendingChain !== undefined &&
          pendingChain.lineageId === entry.lineageId &&
          pendingChain.generation + 1 === entry.lineageGeneration &&
          pendingChain.pendingBindingDigest === entry.lineageBindingDigest &&
          pendingChain.state === "rearm_ready"
        ) {
          return { status: "already_final", detail: "tr1_ 在途 child not-executed 已回滚（rearm_ready——幂等）" };
        }
      }
      // 【Remediation IV 八.2】GRA exact outcome：删除 transactionId+digest
      // 快捷判断——已有 GRA 必须经完整三方 relation（journal ↔ final
      // tombstone ↔ proof：root identity/lineage/generation/parent/binding/
      // digest/contract/cohort/durable/source/proof class/resolution/
      // retirement 三段）才 already_final；conflict/insufficient/store
      // unhealthy 全部 blocked；缺失（absent）经 converge 单一权威写入后
      // 重新执行同一 relation。
      const relation = relateTreasuryGenerationRetirementProofForOutcome(entry);
      if (relation.verdict === "match") {
        return { status: "already_final", detail: "exact retirement proof 已存在（完整三方 exact relation match）" };
      }
      if (relation.verdict === "absent") {
        // 【Remediation III 6.4】exact GRA proof 的写入（retirement 三段
        // 收敛）由本 handler 驱动（converge 单一权威幂等推进）——outcome
        // 阶段完成 = exact proof 已持久并完整匹配，不得把"converge 尚未
        // 执行"当作永久 blocked（阶段顺序死锁）。
        const outcomeConverged = convergeTreasuryLineageRetirementFromFacts(entry.lineageId);
        if (outcomeConverged.status !== "completed") {
          return { status: "blocked", detail: `retirement converge pending（exact-proof pending）: ${JSON.stringify(outcomeConverged).slice(0, 120)}` };
        }
        const retried = relateTreasuryGenerationRetirementProofForOutcome(entry);
        if (retried.verdict === "match") {
          return { status: "finalized", detail: "exact retirement proof 经 converge 写入并完整 relation match（outcome 完成）" };
        }
        return { status: "blocked", detail: `converge 完成后 GRA exact relation 仍 ${retried.verdict}: ${retried.detail}（exact-proof pending）` };
      }
      return { status: "blocked", detail: `GRA exact relation ${relation.verdict}: ${relation.detail}` };
    }
    // initial attempt：outcome proof = final tombstone + root lineage 的
    // retirement 三段收敛（【Remediation III 6.4】"pending-release 状态与
    // retirement facts 一致"——exact proof 冲突/缺失在 outcome 阶段即阻断，
    // 不得等到 lineage 阶段才暴露）。【Remediation V 七】root 匹配升级为
    // rootIdentity exact 全维度比较（不再只比 currentTransactionId+state）。
    {
      const initialRoot = lookupTreasuryAttemptLineageByAttemptId(entry.transactionId);
      if (
        initialRoot !== undefined &&
        initialRoot.currentTransactionId === entry.transactionId &&
        initialRoot.rootTransactionId === entry.transactionId &&
        initialRoot.rootIdentity.digest === entry.digest &&
        (initialRoot.rootIdentity.contractDigest ?? undefined) === (entry.contractDigest ?? undefined) &&
        (initialRoot.rootIdentity.authorizationCohortDigest ?? undefined) === (entry.authorizationCohortDigest ?? undefined) &&
        (initialRoot.rootIdentity.durableIdentityDigest ?? undefined) === (entry.durableIdentityDigest ?? undefined) &&
        (initialRoot.rootIdentity.lowlevelSource ?? undefined) === (entry.lowlevelSource ?? undefined) &&
        initialRoot.state === "retiring"
      ) {
        const initialConverged = convergeTreasuryLineageRetirementFromFacts(initialRoot.lineageId);
        if (initialConverged.status !== "completed") {
          return { status: "blocked", detail: `root retirement converge pending: ${JSON.stringify(initialConverged).slice(0, 120)}` };
        }
      }
    }
    return { status: "already_final", detail: "initial attempt 的 outcome proof = final tombstone + root retirement 收敛" };
  },
  lineageFinalization: (entry) => {
    // 【Remediation IV 九】lineage finalization 区分 active / terminal /
    // missing / unhealthy：active record 读取 undefined 不再自动解释为
    // not_applicable——root not-executed 与 rearm attempt 的 lineage 意外
    // 缺失必须结构化阻断；active 缺失时只有 matching terminal exact
    // summary 可证明终态；store unhealthy 零阶段推进。
    // 【Remediation V 七】root/terminal 比较升级为完整 exact identity
    //（rootIdentity / finalExact 全维度——不再只比 transactionId+digest）。
    const entryIdentity = treasuryExactAttemptIdentityOfFacts(
      entry.transactionId,
      {
        digest: entry.digest,
        ...(entry.contractDigest !== undefined ? { contractDigest: entry.contractDigest } : {}),
        ...(entry.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: entry.authorizationCohortDigest } : {}),
        ...(entry.durableIdentityDigest !== undefined ? { durableIdentityDigest: entry.durableIdentityDigest } : {}),
        ...(entry.lowlevelSource !== undefined ? { lowlevelSource: entry.lowlevelSource } : {}),
        ...(entry.lineageId !== undefined ? { lineageId: entry.lineageId } : {}),
        ...(entry.lineageGeneration !== undefined ? { lineageGeneration: entry.lineageGeneration } : {}),
        ...(entry.parentTransactionId !== undefined ? { parentTransactionId: entry.parentTransactionId } : {}),
        ...(entry.lineageBindingDigest !== undefined ? { lineageBindingDigest: entry.lineageBindingDigest } : {}),
      },
      entry.proofClass === "lowlevel" ? "lowlevel" : entry.proofClass === "identity-bound" ? "identity-bound" : "legacy",
    );
    const finalizationState = verifyTreasuryLineageFinalizationState({
      transactionId: entry.transactionId,
      ...(entry.lineageId !== undefined ? { lineageId: entry.lineageId } : {}),
      ...(entry.lineageGeneration !== undefined ? { lineageGeneration: entry.lineageGeneration } : {}),
      resolution: entry.resolution,
      expectedDigest: entry.digest,
      ...(entryIdentity !== null ? { expectedIdentity: entryIdentity } : {}),
    });
    if (finalizationState.state === "store_unhealthy") {
      return { status: "blocked", detail: `lineage 终态判定 store unhealthy: ${finalizationState.detail}` };
    }
    if (finalizationState.state === "active_identity_conflict") {
      return { status: "blocked", detail: `root lineage 身份冲突: ${finalizationState.detail}` };
    }
    if (finalizationState.state === "terminal_final") {
      return { status: "already_final", detail: `terminal exact summary 证明 ${finalizationState.terminalState} 终态` };
    }
    if (finalizationState.state === "summary_conflict") {
      return { status: "blocked", detail: `terminal summary 与 cleanup entry 不一致: ${finalizationState.detail}` };
    }
    if (finalizationState.state === "lineage_missing") {
      if (
        entry.lineageId === undefined &&
        (entry.resolution === "committed" ||
          entry.identityProfile === "legacy-replay" ||
          entry.identityProfile === "forensic-isolated")
      ) {
        // 【九.3】initial committed：transaction 非 rearm、无 active lineage、
        // 无 terminal lineage、协议本身不要求 lineage → not_applicable。
        // legacy-replay / forensic-isolated 的 root not-executed 同理——隔离
        // profile 不参与自动协议（无 root lineage publication 义务）；现代
        // profile（lowlevel/modern）的 root not-executed lineage 缺失仍然
        // 结构化阻断（publication 是 settlement 的组成部分）。
        return { status: "not_applicable", detail: "initial/隔离 profile attempt 无 lineage 终态阶段（协议不要求）" };
      }
      return { status: "blocked", detail: `${finalizationState.detail}——不得 not_applicable` };
    }
    // active record 存在。
    const record = finalizationState.record;
    if (entry.lineageId === undefined) {
      // 【Remediation III 八】root not-executed 的 root lineage record 处于
      // retiring 时在此收敛（原 resolutionAuthority 的 completeImmediate
      // NotExecutedRetirement 单一语义——收敛结果成为 lineage 阶段的硬门禁）。
      // 【Remediation V 七】root 匹配升级为 rootIdentity exact 全维度比较
      //（不再只比 currentTransactionId + state）。
      const rootIdentityMatches =
        record.currentTransactionId === entry.transactionId &&
        record.rootTransactionId === entry.transactionId &&
        record.rootIdentity.digest === entry.digest &&
        (record.rootIdentity.contractDigest ?? undefined) === (entry.contractDigest ?? undefined) &&
        (record.rootIdentity.authorizationCohortDigest ?? undefined) === (entry.authorizationCohortDigest ?? undefined) &&
        (record.rootIdentity.durableIdentityDigest ?? undefined) === (entry.durableIdentityDigest ?? undefined) &&
        (record.rootIdentity.lowlevelSource ?? undefined) === (entry.lowlevelSource ?? undefined);
      if (rootIdentityMatches) {
        if (record.state === "retiring") {
          const rootConverged = convergeTreasuryLineageRetirementFromFacts(record.lineageId);
          if (rootConverged.status === "completed") {
            return { status: "finalized", detail: "root lineage retirement 三段收敛完成" };
          }
          return { status: "blocked", detail: `root converge pending: ${JSON.stringify(rootConverged).slice(0, 120)}` };
        }
        if (record.state === "rearm_ready" || record.state === "non_rearmable_retired") {
          return { status: "already_final", detail: `root lineage ${record.state}（not-executed 终态）` };
        }
      }
      return { status: "blocked", detail: `root lineage record 状态 ${record.state}（current ${record.currentTransactionId.slice(0, 8)}）与 root not-executed 收敛语义不符（rootIdentity exact 不匹配或状态非法）` };
    }
    // 【Remediation II D.4】lineage 阶段不信任 boolean——终态也重验 record
    // 确实处于本 attempt 的 exact 最终状态：current attempt / generation /
    // parent / binding 任一不匹配都不得完成。
    const recordMatchesEntry =
      record.lineageId === entry.lineageId &&
      record.currentTransactionId === entry.transactionId &&
      record.generation === entry.lineageGeneration &&
      (record.currentParentTransactionId ?? undefined) === (entry.parentTransactionId ?? undefined) &&
      (record.bindingDigest ?? undefined) === (entry.lineageBindingDigest ?? undefined);
    if (!recordMatchesEntry) {
      // 【Remediation V 六】tr1_ 在途 child 的 not-executed 终态：child 从未
      // 接管（current 是 parent）——record 的在途 handoff 事实（nextChild /
      // binding / generation+1）匹配 entry 且 chain 已回滚 rearm_ready
      //（outcome 阶段承载回滚）即 already_final；在途事实不匹配 → blocked。
      const pendingHandoffMatches =
        record.nextChildTransactionId === entry.transactionId &&
        record.generation + 1 === entry.lineageGeneration &&
        record.pendingBindingDigest === entry.lineageBindingDigest &&
        record.state === "rearm_ready";
      if (pendingHandoffMatches) {
        return { status: "already_final", detail: "tr1_ 在途 child not-executed 已回滚（rearm_ready 是该 attempt 的 lineage 终态）" };
      }
      return { status: "blocked", detail: "lineage record 与 journal entry 的当前代不一致（generation/parent/binding/current attempt 任一不匹配）" };
    }
    if (entry.resolution === "committed") {
      if (record.state === "chain_committed") return { status: "already_final", detail: "chain_committed" };
      if (record.state !== "child_active") {
        return { status: "blocked", detail: `lineage 状态 ${record.state} 非 child_active（不可 close）` };
      }
      // 【Remediation III 九】chain close 的 receipt 验证必须 release-
      // trusted：完整 exact settlement identity 与 lineage record current
      // 一致（receipt 已是 committed 权威；generation 混用与 identity
      // 降级防御——replay-readable 单条读取不得作为 close 依据）。
      const chainExpected = treasuryExactAttemptIdentityOfFacts(
        entry.transactionId,
        {
          digest: entry.digest,
          ...(entry.contractDigest !== undefined ? { contractDigest: entry.contractDigest } : {}),
          ...(entry.authorizationCohortDigest !== undefined ? { authorizationCohortDigest: entry.authorizationCohortDigest } : {}),
          ...(entry.durableIdentityDigest !== undefined ? { durableIdentityDigest: entry.durableIdentityDigest } : {}),
          ...(entry.lowlevelSource !== undefined ? { lowlevelSource: entry.lowlevelSource } : {}),
          ...(entry.lineageId !== undefined ? { lineageId: entry.lineageId } : {}),
          ...(entry.lineageGeneration !== undefined ? { lineageGeneration: entry.lineageGeneration } : {}),
          ...(entry.parentTransactionId !== undefined ? { parentTransactionId: entry.parentTransactionId } : {}),
          ...(entry.lineageBindingDigest !== undefined ? { lineageBindingDigest: entry.lineageBindingDigest } : {}),
        },
        entry.proofClass === "lowlevel" ? "lowlevel" : entry.proofClass === "identity-bound" ? "identity-bound" : "legacy",
      );
      if (chainExpected === null) {
        return { status: "blocked", detail: "journal entry 身份无法构造 exact identity（chain close 拒绝）" };
      }
      const chainTrusted = readTreasuryTrustedSettlementProofForAttempt(entry.transactionId, chainExpected);
      if (chainTrusted.status !== "trusted_proof") {
        return { status: "blocked", detail: `chain close 的 trusted receipt ${chainTrusted.status}: ${chainTrusted.detail}` };
      }
      const chainProof = chainTrusted.proof;
      const proofLineageMatchesRecord =
        chainProof.lineageId === record.lineageId &&
        chainProof.lineageGeneration === record.generation &&
        chainProof.parentTransactionId === record.currentParentTransactionId &&
        chainProof.lineageBindingDigest === record.bindingDigest;
      const proofIdentityMatchesRecord =
        chainProof.digest === record.currentIdentity.digest &&
        (chainProof.contractDigest ?? undefined) === (record.currentIdentity.contractDigest ?? undefined) &&
        (chainProof.authorizationCohortDigest ?? undefined) === (record.currentIdentity.authorizationCohortDigest ?? undefined) &&
        (chainProof.durableIdentityDigest ?? undefined) === (record.currentIdentity.durableIdentityDigest ?? undefined) &&
        (chainProof.lowlevelSource ?? undefined) === (record.currentIdentity.lowlevelSource ?? record.lowlevelSource ?? undefined);
      if (!proofLineageMatchesRecord || !proofIdentityMatchesRecord) {
        return { status: "blocked", detail: "trusted receipt 与 lineage record current 的 lineage/identity 维度不一致（不推进 chain）" };
      }
      const closed = closeTreasuryLineageAsChainCommitted(entry.lineageId);
      if (closed.status === "rejected") {
        return { status: "blocked", detail: `close 失败: ${closed.detail}` };
      }
      return { status: "finalized", detail: "chain_committed 已推进（trusted receipt 验证通过）" };
    }
    if (record.state === "rearm_ready" || record.state === "non_rearmable_retired") {
      return { status: "already_final", detail: record.state };
    }
    const converged = convergeTreasuryLineageRetirementFromFacts(entry.lineageId);
    if (converged.status === "completed") {
      return { status: "finalized", detail: "retirement 三段收敛完成" };
    }
    return { status: "blocked", detail: `converge pending: ${JSON.stringify(converged)}`.slice(0, 160) };
  },
    };
}

// 【Remediation III 七/八/十】模块加载时自动装配（生产与底层测试入口共享同一实现）。
registerTreasuryResolutionCleanupHandlersForAssembly(treasuryResolutionCleanupStageHandlers());
registerTreasuryCleanupProofProbesForAssembly({
  readTombstone: (transactionId: string) => readTreasuryResolutionTombstone(transactionId),
  resolutionStoreHealthy: () => peekTreasuryResolutionStoreHealth().healthy,
});
registerTreasuryOppositeProofDepsForAssembly({
  readTombstone: (transactionId: string) => readTreasuryResolutionTombstone(transactionId),
  resolutionStoreHealthy: () => peekTreasuryResolutionStoreHealth().healthy,
  lookupGRAProof: (transactionId: string) => lookupTreasuryGenerationRetirementProofByAttemptId(transactionId),
  graStoreHealthy: () => peekTreasuryGenerationRetirementHealth().healthy,
});
// 【Remediation V 八】completion replacement probes 装配（GRA / terminal
// summary / final tombstone 的只读探测 + completion 有界枚举/删除 read-back）。
registerTreasuryCompletionReplacementProbesForAssembly({
  graStoreHealthy: () => peekTreasuryGenerationRetirementHealth().healthy,
  readGRAProofByAttempt: (transactionId) => lookupTreasuryGenerationRetirementProofByAttemptId(transactionId),
  summaryStoreHealthy: () => peekTreasuryRetirementSummaryHealth().healthy,
  readSummaryByRoot: (rootTransactionId) => lookupTreasuryRetirementSummaryByRoot(rootTransactionId),
  resolutionStoreHealthy: () => peekTreasuryResolutionStoreHealth().healthy,
  readTombstone: (transactionId) => readTreasuryResolutionTombstone(transactionId),
  listCompletionTransactionIds: () => listTreasuryCleanupCompletionTransactionIds(),
  completionAbsentAfterRelease: (transactionId) =>
    lookupTreasuryCleanupCompletion(transactionId).verdict === "absent",
});
// 【Remediation V 七】root lineage exact relation 装配（channel 注入——
// pre-release gate 消费；未装配 gate 对现代 profile root not-executed fail
// closed）。
registerTreasuryRootLineageRelationForAssembly(relateTreasuryRootLineageForNotExecuted);
assembleTreasuryResolutionCleanupCoordinator();
