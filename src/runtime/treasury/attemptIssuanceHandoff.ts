/**
 * 【Round 22 Remediation X 工作流 A / B】issued ticket → durable owner 的
 * 受控接管协议（Treasury 内部协议——production 调用者不得也不需要手工
 * consume）。
 *
 * ti2_ initial attempt 的 execution authority 状态机：
 *
 * ```
 * open（mint + ticket 写入原子）→ active(unbound)
 *   ├─ execute/prepare gate：binding（AC4 contract digest）→ active(bound)
 *   ├─ durable owner 写入 + read-back（prepare/intent）→【中断窗口】
 *   │    ticket 仍 active + durable owner 在位：
 *   │    下次 gate 发现 → 幂等 consume（handoff_recovered）→ 拒绝新执行
 *   ├─ execute 完成（committed / writeFault / quarantine …）→ consume
 *   │    （统一规则：resolver(excludeIssuedTicket) owned → consume）
 *   ├─ 纯前置失败（authorization/epoch/capacity/…）→ 保持 active(bound)
 *   │    （同 exact opening 幂等重试；不同 contract → binding conflict）
 *   ├─ TTL 到期（GC 显式转换）→ expired（永不可执行——T3）
 *   └─ terminal（consumed/expired）→ GC retire（watermark frontier 验证）
 * ```
 *
 * 关键不变量（X 任务书第二节 B）：
 *  - consume 只发生在 durable lifecycle owner 已写入并经统一 resolver 判定
 *    在位之后（不存在"ticket 已 terminal 且没有 durable owner"的窗口）；
 *  - 一旦 execution-started 已持久化（durable owner 在位），ticket 永不回到
 *    可执行状态——恢复路径是幂等 consume + 拒绝（不重复 callback）；
 *  - 手工调用底层 consume 原语不授予执行权限：consumed 且无 durable owner
 *    的 ID在 gate 一律拒绝（T9）。
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
import { parseTreasuryIssuedInitialAttemptId } from "@/runtime/treasury/attemptIssuer";
import { resolveTreasuryAttemptLifecycleOwnership } from "@/runtime/treasury/treasuryLifecycleOwnerResolver";

export type TreasuryIssuedTicketGateReason =
  | "issued_ticket_store_unhealthy"
  | "issued_ticket_missing"
  | "issued_ticket_expired"
  | "issued_ticket_consumed_without_owner"
  | "issued_ticket_handoff_recovered"
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
 * durable owner 在位判定（ticket gate / handoff 协议专用）：
 *  - excludeIssuedTicket：ticket 是被接管对象，不是它自己的 durable owner；
 *  - excludeInflightReservations：admission（heap）/ headroom 预留是
 *    prepare→commit 窗口的瞬态事实（heap 或可被完整回滚），不承载
 *    "execution-started 已持久化"（B6）语义——本次 opening 自己的预留不得
 *    被解读为接管已完成的恢复场景（否则首次 execute 被 prepare 阶段自己
 *    创建的 admission reservation 误拒）。
 */
function durableOwnerInPlace(
  transactionId: string,
): ReturnType<typeof resolveTreasuryAttemptLifecycleOwnership> {
  return resolveTreasuryAttemptLifecycleOwnership(transactionId, {
    excludeIssuedTicket: true,
    excludeInflightReservations: true,
  });
}

/**
 * 【X 工作流 A】contract execution 的 ticket gate（executeTreasuryAction
 * Contract 在 ID 命名空间校验之后、全部写路径之前调用）。
 *
 * 通过（返回 null）= ticket 健康、active、binding 一致，且无 durable owner
 * 在位（首次 opening）。任何拒绝都发生在 Game callback 之前（callback=0）。
 */
export function gateTreasuryIssuedAttemptTicketForContractExecution(
  transactionId: string,
  contractDigest: string,
): TreasuryTicketGateRejection | null {
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
  // durable owner 在位（中断恢复窗口 / 已完成）：幂等完成 handoff 后拒绝新
  // 执行——同一 callback 不得再次执行（T8/T11）。
  const ownership = durableOwnerInPlace(transactionId);
  if (ownership.status === "owned") {
    void completeTreasuryIssuedTicketHandoff(transactionId);
    return {
      reason: "issued_ticket_handoff_recovered",
      detail: `durable lifecycle owner 已在位（${ownership.owner ?? "unknown"}）——ticket handoff 幂等完成，不得重复执行（Game callback 零调用）`,
    };
  }
  if (ticket.state === "expired") {
    return {
      reason: "issued_ticket_expired",
      detail: "issued ticket 已显式过期（TTL 转换——expired ticket 永不可执行，重放须显式 rearm 协议）",
    };
  }
  if (ticket.state === "consumed") {
    // 【T9】consumed 且无 durable owner：协议异常（手工 consume / 历史残缺）
    // ——fail closed，不授予执行权限。
    return {
      reason: "issued_ticket_consumed_without_owner",
      detail: "issued ticket 已 consumed 且无 durable lifecycle owner（协议异常——手工 consume 不产生执行权限，fail closed）",
    };
  }
  const bind = bindTreasuryIssuedAttemptTicketToContract(transactionId, contractDigest);
  if (bind.status === "rejected") {
    return {
      reason: bind.reason === "binding_conflict" ? "issued_ticket_binding_conflict" : "issued_ticket_state_conflict",
      detail: bind.detail,
    };
  }
  return null;
}

/**
 * 【X 工作流 A】prepareTransaction 层的轻量 gate（contract 与低层 kernel
 * 通道共用——production Game callback 的唯一必经点）。与 contract 层 gate
 * 的差异：无 contract binding（低层通道没有 AC4 digest）。
 */
export function gateTreasuryIssuedAttemptTicketForPrepare(transactionId: string): TreasuryTicketGateRejection | null {
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
    return {
      reason: "issued_ticket_missing",
      detail: "transactionId 无 matching issued ticket（watermark 只证明序号消耗——受控 opening 之外不存在可执行 ti2_ ID）",
    };
  }
  const ownership = durableOwnerInPlace(transactionId);
  if (ownership.status === "owned") {
    void completeTreasuryIssuedTicketHandoff(transactionId);
    return {
      reason: "issued_ticket_handoff_recovered",
      detail: `durable lifecycle owner 已在位（${ownership.owner ?? "unknown"}）——ticket handoff 幂等完成，不得重复执行（Game callback 零调用）`,
    };
  }
  if (ticket.state === "expired") {
    return { reason: "issued_ticket_expired", detail: "issued ticket 已显式过期（expired——永不可执行）" };
  }
  if (ticket.state === "consumed") {
    return {
      reason: "issued_ticket_consumed_without_owner",
      detail: "issued ticket 已 consumed 且无 durable lifecycle owner（协议异常——fail closed）",
    };
  }
  return null;
}

/**
 * 【X 工作流 B】owner-gated handoff 完成：durable lifecycle owner 经统一
 * resolver 判定在位（exclude ticket 自身）才 consume；owner 缺失 → 拒绝
 * （绝不制造 consumed-but-unowned ticket——T9/B8）。
 *
 * 统一 consume 规则（executePreparedAction 收尾调用，覆盖全部中断窗口）：
 * durable owner 在位（intent/receipt/tombstone/quarantine/writeFault/
 * journal/…，含 callback 已执行后的 committed 与 uncertain 状态）→ consume；
 * owner 缺失（纯前置失败 / 完整回滚的 abort）→ ticket 保持 active（同
 * exact opening 幂等重试，B5）。
 */
export function completeTreasuryIssuedTicketHandoff(transactionId: string): TreasuryIssuedTicketMutationResult {
  if (!isTreasuryCurrentIssuedInitialAttemptId(transactionId)) return { status: "absent" };
  const ownership = durableOwnerInPlace(transactionId);
  if (ownership.status !== "owned") {
    return {
      status: "rejected",
      reason: "state_conflict",
      detail: "durable lifecycle owner 不在位（不得 consume——consumed-but-unowned ticket 是协议违规，fail closed）",
    };
  }
  return consumeTreasuryIssuedAttemptTicketForHandoff(transactionId);
}
