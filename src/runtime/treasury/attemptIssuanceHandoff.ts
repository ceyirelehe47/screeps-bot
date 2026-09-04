/**
 * 【Round 22 Remediation X 工作流 A / B → XI 工作流 A → XII 工作流 A/B】
 * issued ticket → durable owner 的受控接管协议（Treasury 内部协议——
 * production 调用者不得也不需要手工 consume）。
 *
 * ti2_ initial attempt 的 execution authority 状态机（XII 时序）：
 *
 * ```
 * open（mint + ticket 写入原子）→ active(unbound)
 *   ├─ execute gate（基础检查 + binding 双维度 + early ownership probe）
 *   │    binding = AC4 contract digest + canonical transaction digest
 *   ├─ 全部 callback 前检查（redemption/invariant/capacity/…）
 *   ├─ canonical expected opening identity 构造（含 durable identity）
 *   ├─ durable callback_not_started owner 写入（intent not_started/ready）
 *   │    + Memory read-back 完整 identity 验证 →【中断窗口 B】
 *   ├─ positive owner verify（全 source 聚合，expected 绑定当前 opening）
 *   │    → consume Ticket + consume read-back →【中断窗口 C】
 *   ├─ Intent not_started → executing（started_unknown）→【中断窗口 D】
 *   ├─ Game callback（恰好一次）→ committed / non-ok / fault
 *   └─ 纯前置失败 → ticket 保持 active(bound)（同 exact opening 幂等重试）
 * ```
 *
 * 关键不变量（XII 任务书 3.1-3.5 / 4.3-4.5 / 5.1-5.4）：
 *  - 【XII / 3.2】positive owner 验证绑定当前 opening 的完整 expected
 *    identity（canonical digest / contract digest / cohort digest / durable
 *    identity digest / proofClass / lineage 四字段）——只按 transactionId
 *    的 owned 判定不得授权 consume（O1/O2）；
 *  - 【XII / 3.3】positive verifier 聚合全部相关 source 后统一裁决（无
 *    first-match）——后方 store unhealthy / conflict 不得被前方 match 遮蔽；
 *  - 【XII / 3.4 + 5.1】consume 发生在 Intent 进入 executing **之前**：
 *    consume 失败 → callback=0、Intent 保持 callback_not_started
 *    （not_started/ready）、不产生 execution-unknown、ticket 保持/恢复
 *    active（P1/P2）；consume 成功 read-back 后才允许 progress executing；
 *  - 【XII / 4.4】matching_not_started_owner 不得被解释为 handoff
 *    recovered——它只允许"继续同 opening"或 beginTick 安全释放；
 *    matching_execution/terminal owner 才允许幂等 consume（恢复路径）；
 *  - blocked / conflict / insufficient / protocol-only / retired-only 只阻断
 *    执行，绝不授权 consume——ticket 保持当前状态（不进 quarantine、不
 *    expired、不删除），修复后同 exact opening 可恢复；
 *  - 手工调用底层 consume 原语不授予执行权限：consumed 且无 durable owner
 *    的 ID 在 gate 一律拒绝（T9）。
 *
 * 本模块是 consume 原语（consumeTreasuryIssuedAttemptTicketForHandoff）的
 * 唯一合法调用方（架构守护：attemptIssuanceTicket.ts 与本模块之外的
 * production 模块不得调用 consume）。
 */

import {
  bindTreasuryIssuedAttemptTicketToContract,
  consumeTreasuryIssuedAttemptTicketForHandoff,
  peekTreasuryIssuedAttemptTicketHealth,
  readTreasuryIssuedAttemptTicket,
  type TreasuryIssuedTicketMutationResult,
} from "@/runtime/treasury/attemptIssuanceTicket";
import { parseTreasuryIssuedInitialAttemptId, peekTreasuryIssuedAttemptWatermark } from "@/runtime/treasury/attemptIssuer";
import {
  verifyTreasuryPositiveOwnershipForOpening,
} from "@/runtime/treasury/positiveOwnershipVerifier";
import type { TreasuryExactAttemptIdentity } from "@/runtime/treasury/exactAttemptIdentity";
import { peekTreasuryIntentStoreValidation, readTreasuryIntentEntryForQuery, registerTreasuryIntentTicketHandoffRecoveryHookForAssembly } from "@/runtime/treasury/intents";
import { peekTreasuryQuarantineStoreValidation, readTreasuryQuarantineEntryForQuery } from "@/runtime/treasury/quarantine";
import { treasuryExactAttemptIdentityOfAuthority, treasuryExactAttemptIdentityOfFacts } from "@/runtime/treasury/exactAttemptIdentity";
import { resolveTreasuryAttemptLifecycleOwnership } from "@/runtime/treasury/treasuryLifecycleOwnerResolver";

// 【XII 工作流 B / 5.3 窗口 D】装配注册（模块单向依赖：intents 不 import
// 本模块）——beginTick 的 execution-owner intent 转 quarantine 前幂等 consume。
registerTreasuryIntentTicketHandoffRecoveryHookForAssembly((transactionId) => {
  completeTreasuryIssuedTicketHandoffForIntentRecovery(transactionId);
});

export type TreasuryIssuedTicketGateReason =
  | "issued_ticket_store_unhealthy"
  | "issued_ticket_missing"
  | "issued_ticket_unissued"
  | "issued_ticket_expired"
  | "issued_ticket_consumed_without_owner"
  | "issued_ticket_handoff_recovered"
  | "issued_ticket_owner_unverifiable"
  | "issued_ticket_owner_conflict"
  | "issued_ticket_owner_insufficient"
  | "issued_ticket_owner_protocol"
  | "issued_ticket_owner_in_flight"
  | "issued_ticket_already_settled"
  | "issued_ticket_binding_conflict"
  | "issued_ticket_state_conflict";

export interface TreasuryTicketGateRejection {
  readonly reason: TreasuryIssuedTicketGateReason;
  readonly detail: string;
}

/** transactionId 是否属于当前 ti2_ 发行命名空间（gate 的作用域）。 */
export function isTreasuryCurrentIssuedInitialAttemptId(transactionId: string): boolean {
  const parsed = parseTreasuryIssuedInitialAttemptId(transactionId);
  return parsed !== null && parsed.namespace === "current";
}

/**
 * 基础 ticket 检查（prepare/execute 两层 gate 共用的前置段——与 owner 判定
 * 无关的形态/发行/生命周期检查）：namespace、store health、ticket 在位、
 * watermark 发行事实、expired、consumed-without-owner。
 */
function basicIssuedTicketChecks(transactionId: string): TreasuryTicketGateRejection | null {
  if (!isTreasuryCurrentIssuedInitialAttemptId(transactionId)) return null;
  const ticketHealth = peekTreasuryIssuedAttemptTicketHealth();
  if (!ticketHealth.healthy) {
    return {
      reason: "issued_ticket_store_unhealthy",
      detail: `issued ticket store unhealthy（${ticketHealth.detail}）——ticket 执行权限不可判定，fail closed`,
    };
  }
  const ticket = readTreasuryIssuedAttemptTicket(transactionId);
  if (ticket === undefined) {
    // 【T1】裸 mint（checksum 合法、sequence ≤ watermark）不构成执行权限。
    return {
      reason: "issued_ticket_missing",
      detail: "transactionId 无 matching issued ticket（issuer watermark 只证明序号已消耗，不构成 execution authority——经 openTreasuryIssuedInitialAttempt 受控签发才可执行）",
    };
  }
  // 【XI 工作流 B / T6】发行事实验证：canonical ID 只证明"该 sequence 的唯一
  // 合法完整形态"，不证明已发行——ticket.sequence 必须在 issuer 持久
  // watermark 内（手工塞入的未来序号不得经 ticket 通道执行；watermark 不
  // 因此推进）。
  const watermark = peekTreasuryIssuedAttemptWatermark();
  if (watermark < 0) {
    return {
      reason: "issued_ticket_store_unhealthy",
      detail: "issuer watermark 不可读（发行事实不可判定——fail closed；watermark 不推进）",
    };
  }
  if (ticket.sequence > watermark) {
    return {
      reason: "issued_ticket_unissued",
      detail: `ticket sequence ${String(ticket.sequence)} 超出 issuer watermark ${String(watermark)}（canonical ID 不构成发行事实——callback=0、ticket 不 consume、watermark 不推进）`,
    };
  }
  if (ticket.state === "expired") {
    return {
      reason: "issued_ticket_expired",
      detail: "issued ticket 已显式过期（TTL 转换——expired ticket 永不可执行，重放须显式 rearm 协议）",
    };
  }
  if (ticket.state === "consumed") {
    // 【T9 / XII 4.4】consumed 时区分：matching durable owner 仍在位
    //（executing/terminal——XI 的"恢复窗口"语义：authority 已转移，重试
    // 拒绝，幂等 consume 由 beginTick 恢复路径承载）vs 无 owner（协议异常
    // ——手工 consume 不产生执行权限，fail closed）。resolver 在位性判定
    // 只用于 reason 选择，绝不授权 consume（授权只在 full verify / 恢复
    // 路径）。
    const ownershipInPlace = resolveTreasuryAttemptLifecycleOwnership(transactionId, {
      excludeIssuedTicket: true,
      excludeInflightReservations: true,
    });
    if (ownershipInPlace.verdict === "exact_owner") {
      return {
        reason: "issued_ticket_owner_in_flight",
        detail: `issued ticket 已 consumed 且 durable owner（${ownershipInPlace.owner ?? "unknown"}）仍在位——execution authority 已转移，本次 execute 拒绝（callback=0、不重复执行）；幂等 handoff 由恢复路径承载`,
      };
    }
    return {
      reason: "issued_ticket_consumed_without_owner",
      detail: "issued ticket 已 consumed 且无正向 durable owner（协议异常——手工 consume 不产生执行权限，fail closed）",
    };
  }
  return null;
}

/**
 * 【XII 工作流 A / 3.3】early ownership gate：以 digest-only expected 跑
 * **完整** positive ownership verifier（全部 source 聚合、无 first-match），
 * 只对确定结论短路：
 *  - store_unhealthy（任一 source unhealthy——H1-H4：early 阶段即 fail
 *    closed，不被 redemption/intent 写入的其它拒绝形态遮蔽）；
 *  - identity_conflict / outcome_conflict（digest 维度精确不等——O1/O2：
 *    不同 opening 不得接管）。
 * insufficient / protocol_only / retired_only / absent / not-started owner
 * 一律放行——它们的精确裁决由 full verify（intent 写入后的完整 expected）
 * 承载（窗口 B 重试继续协议；O5/O7 在 full verify 阶段拒绝且 callback=0）。
 */
function earlyOwnershipGate(
  transactionId: string,
  canonicalDigest: string,
): TreasuryTicketGateRejection | null {
  if (!isTreasuryCurrentIssuedInitialAttemptId(transactionId)) return null;
  if (canonicalDigest === "") return null;
  const digestOnlyExpected = treasuryExactAttemptIdentityOfFacts(
    transactionId,
    { digest: canonicalDigest },
    // proofClass 未知（redemption 前 authority level 未定）——identity-bound
    // 通道 digest 匹配即可排除"不同 opening"；proofClass 冲突的精细判定由
    // full verify 承载。
    "identity-bound",
  );
  if (digestOnlyExpected === null) return null;
  const verdict = verifyTreasuryPositiveOwnershipForOpening(transactionId, digestOnlyExpected);
  if (verdict.verdict === "store_unhealthy") {
    return {
      reason: "issued_ticket_owner_unverifiable",
      detail: `durable owner source unhealthy（${verdict.detail}）——positive ownership 不可判定，当前 execute fail closed（callback=0）；ticket 保持原状态（不 consume / 不 expire / 不删除），修复相关 store 后同 exact opening 可恢复`,
    };
  }
  if (verdict.verdict === "identity_conflict" || verdict.verdict === "outcome_conflict") {
    return {
      reason: "issued_ticket_owner_conflict",
      detail: `同 ID durable owner 与当前 opening 冲突（${verdict.verdict}: ${verdict.detail}）——不同 opening 不得接管 ticket（O1/O2），当前 execute fail closed（callback=0）；ticket 保持原状态`,
    };
  }
  return null;
}

/**
 * 【X → XII】ticket gate 共通判定链（基础检查 + binding + early probe）。
 * 通过（返回 null）= ticket 健康、canonical、发行事实在 watermark 内、
 * active、binding 双维度一致、无确定冲突的在位 owner。任何拒绝都发生在
 * Game callback 之前（callback=0）。
 */
function gateTreasuryIssuedAttemptTicket(
  transactionId: string,
  contractDigest: string | null,
  canonicalDigest: string | null,
): TreasuryTicketGateRejection | null {
  // 【X】非 ti2_ current 发行命名空间不经此门禁（tr1_ / arbitrary ID 的
  // execution authority 由各自协议承载）。
  if (!isTreasuryCurrentIssuedInitialAttemptId(transactionId)) return null;
  const basic = basicIssuedTicketChecks(transactionId);
  if (basic !== null) return basic;
  // 【XII / 3.3 + O1-O4】early ownership gate：digest-only 完整聚合 verify
  //（任一 source unhealthy / identity / outcome conflict 短路）。
  const early = earlyOwnershipGate(transactionId, canonicalDigest ?? "");
  if (early !== null) return early;
  if (contractDigest !== null) {
    const bind = bindTreasuryIssuedAttemptTicketToContract(transactionId, contractDigest, canonicalDigest ?? undefined);
    if (bind.status === "rejected") {
      return {
        reason: bind.reason === "binding_conflict" ? "issued_ticket_binding_conflict" : "issued_ticket_state_conflict",
        detail: bind.detail,
      };
    }
  }
  return null;
}

/**
 * 【XII 工作流 A】contract execution 的 ticket gate（executePreparedAction 在
 * prepared 成功后、redemption/intent/callback 之前调用）。binding 为双维度：
 * AC4 contract digest + prepared canonical transaction digest（4.3——
 * canonical digest 在 prepare 层构造后即稳定，早于 binding）。
 */
export function gateTreasuryIssuedAttemptTicketForContractExecution(
  transactionId: string,
  contractDigest: string,
  canonicalDigest?: string,
): TreasuryTicketGateRejection | null {
  return gateTreasuryIssuedAttemptTicket(transactionId, contractDigest, canonicalDigest ?? null);
}

/**
 * 【XII 工作流 A】prepareTransaction 层的轻量 gate（contract 与低层 kernel
 * 通道共用）：基础检查 + early probe（低层通道无 AC4 digest——known 维度
 * 只有 canonical digest）。
 */
export function gateTreasuryIssuedAttemptTicketForPrepare(
  transactionId: string,
  canonicalDigest?: string,
): TreasuryTicketGateRejection | null {
  return gateTreasuryIssuedAttemptTicket(transactionId, null, canonicalDigest ?? null);
}

/**
 * 【XII 工作流 A/B】owner-gated handoff 完成（facade 在 durable
 * callback_not_started owner 写入 + read-back 之后、Intent progress
 * executing 之前调用）：positive ownership verifier 以**当前 opening 的
 * 完整 expected identity** 聚合全部 source 统一裁决——
 *  - matching_not_started / execution / terminal owner（identity 与当前
 *    opening 完全一致）→ consume（consume read-back 由原语承载，失败完整
 *    回滚）；
 *  - identity_conflict / outcome_conflict / insufficient / store_unhealthy /
 *    protocol_only / retired_only / absent → 拒绝（绝不 consume——O1-O8）。
 *
 * consume 失败的调用方义务（5.2）：callback=0、Intent 保持
 * callback_not_started（不进 executing / 不进 quarantine）、释放瞬态预留。
 */
export function completeTreasuryIssuedTicketHandoff(
  transactionId: string,
  expected: TreasuryExactAttemptIdentity,
): TreasuryIssuedTicketMutationResult {
  const structured = completeTreasuryIssuedTicketHandoffStructured(transactionId, expected);
  if (structured.status === "consumed" || structured.status === "absent") return structured;
  return { status: "rejected", reason: structured.primitiveReason, detail: structured.detail };
}

/** 结构化 handoff 结果（facade 的精细 reason 映射用——verdict 不折叠）。 */
export type TreasuryIssuedTicketHandoffStructuredResult =
  | { readonly status: "consumed" }
  | { readonly status: "absent" }
  | {
      readonly status: "rejected";
      readonly verdict:
        | "identity_conflict"
        | "outcome_conflict"
        | "insufficient"
        | "store_unhealthy"
        | "probe_unavailable"
        | "protocol_only"
        | "retired_only"
        | "absent"
        | "consume_failed";
      readonly primitiveReason: "store_unhealthy" | "state_conflict";
      readonly detail: string;
    };

export function completeTreasuryIssuedTicketHandoffStructured(
  transactionId: string,
  expected: TreasuryExactAttemptIdentity,
): TreasuryIssuedTicketHandoffStructuredResult {
  if (!isTreasuryCurrentIssuedInitialAttemptId(transactionId)) return { status: "absent" };
  const verdict = verifyTreasuryPositiveOwnershipForOpening(transactionId, expected);
  if (
    verdict.verdict !== "matching_not_started_owner" &&
    verdict.verdict !== "matching_execution_owner" &&
    verdict.verdict !== "matching_terminal_owner"
  ) {
    return {
      status: "rejected",
      verdict: verdict.verdict,
      primitiveReason: verdict.verdict === "store_unhealthy" ? "store_unhealthy" : "state_conflict",
      detail: `positive ownership 验证未通过（${verdict.verdict}: ${"detail" in verdict ? verdict.detail : ""}）——不得 consume（fail closed，ticket 保持原状态）`,
    };
  }
  const consumed = consumeTreasuryIssuedAttemptTicketForHandoff(transactionId);
  if (consumed.status === "consumed") return { status: "consumed" };
  if (consumed.status === "absent") return { status: "absent" };
  if (consumed.status === "rejected") {
    return {
      status: "rejected",
      verdict: "consume_failed",
      primitiveReason: consumed.reason,
      detail: consumed.detail,
    };
  }
  return {
    status: "rejected",
    verdict: "consume_failed",
    primitiveReason: "state_conflict",
    detail: `consume 原语返回 ${consumed.status}（协议不可达分支——fail closed）`,
  };
}

/**
 * 【XII 工作流 B / 5.3 窗口 D】beginTick 恢复路径的幂等 consume：
 * execution owner 的持久信号 = (started_unknown, executing) 的 durable
 * intent（转 quarantine 前）或同 ID 的 unresolved quarantine（transfer 成功
 * 而 consume 失败的中断窗口——quarantine 即 execution-unknown 权威）。
 * 两者任一在位且 identity 可构造 → consume（幂等）；not-started owner 不
 * 授权（窗口 B 由 beginTick 安全释放）。仅限 intent/quarantine 两个
 * execution source（比 XI 的 12 维 transactionId 判定更窄、更严格）。
 */
export function completeTreasuryIssuedTicketHandoffForIntentRecovery(transactionId: string): TreasuryIssuedTicketMutationResult {
  if (!isTreasuryCurrentIssuedInitialAttemptId(transactionId)) return { status: "absent" };
  const validation = peekTreasuryIntentStoreValidation();
  if (validation.status !== "valid") {
    return {
      status: "rejected",
      reason: "store_unhealthy",
      detail: `intent store 不可信（${validation.status}）——恢复路径不得 consume（fail closed）`,
    };
  }
  const entry = readTreasuryIntentEntryForQuery(transactionId);
  if (entry !== undefined) {
    if (entry.outcome === "not_started" && entry.settlement === "ready") {
      return { status: "rejected", reason: "state_conflict", detail: "not-started owner 不是 execution owner（窗口 B 由 beginTick 安全释放，不由恢复路径 consume）" };
    }
    const identity = identityOfIntentOwner(entry);
    if (identity === null) {
      return { status: "rejected", reason: "state_conflict", detail: "durable intent 无法构造 exact identity 视图（恢复路径不授权 consume——fail closed）" };
    }
    return consumeTreasuryIssuedAttemptTicketForHandoff(transactionId);
  }
  // intent 已不在位：同 ID unresolved quarantine 即 execution-unknown 权威。
  const quarantineValidation = peekTreasuryQuarantineStoreValidation();
  if (quarantineValidation.status !== "valid") {
    return {
      status: "rejected",
      reason: "store_unhealthy",
      detail: `quarantine store 不可信（${quarantineValidation.status}）——恢复路径不得 consume（fail closed）`,
    };
  }
  const quarantineEntry = readTreasuryQuarantineEntryForQuery(transactionId);
  if (quarantineEntry === undefined) {
    return { status: "rejected", reason: "state_conflict", detail: "恢复路径 consume 的 execution owner（intent/quarantine）不在位（不得 consume——fail closed）" };
  }
  if ((quarantineEntry as { legacyV1?: boolean }).legacyV1 === true || (quarantineEntry as { forensic?: unknown }).forensic !== undefined) {
    return { status: "rejected", reason: "state_conflict", detail: "legacy/forensic quarantine 不授权 handoff consume（fail closed）" };
  }
  return consumeTreasuryIssuedAttemptTicketForHandoff(transactionId);
}

function identityOfIntentOwner(entry: NonNullable<ReturnType<typeof readTreasuryIntentEntryForQuery>>): TreasuryExactAttemptIdentity | null {
  return treasuryExactAttemptIdentityOfAuthority({
    transactionId: entry.transactionId,
    digest: entry.digest,
    contractDigest: entry.contractDigest,
    authorizationCohortDigest: entry.authorizationCohortDigest,
    durableIdentityDigest: entry.durableIdentityDigest,
    lowlevelSource: entry.lowlevelSource,
    authorityLevel: entry.authorityLevel,
    lineageId: entry.lineageId,
    lineageGeneration: entry.lineageGeneration,
    parentTransactionId: entry.parentTransactionId,
    lineageBindingDigest: entry.lineageBindingDigest,
  });
}
