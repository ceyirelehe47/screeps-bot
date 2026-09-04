/**
 * 【Round 22 Remediation X 工作流 A / B → XI 工作流 A】issued ticket →
 * durable owner 的受控接管协议（Treasury 内部协议——production 调用者不得
 * 也不需要手工 consume）。
 *
 * ti2_ initial attempt 的 execution authority 状态机：
 *
 * ```
 * open（mint + ticket 写入原子）→ active(unbound)
 *   ├─ execute/prepare gate：binding（AC4 contract digest）→ active(bound)
 *   ├─ durable owner 写入 + read-back（prepare/intent）→【中断窗口】
 *   │    ticket 仍 active + durable owner 在位：
 *   │    下次 gate 发现（正向 exact_owner verdict）→ 幂等 consume
 *   │    （handoff_recovered）→ 拒绝新执行
 *   ├─ execute 完成（committed / writeFault / quarantine …）→ consume
 *   │    （统一规则：resolver(excludeIssuedTicket) exact_owner → consume）
 *   ├─ 纯前置失败（authorization/epoch/capacity/…）→ 保持 active(bound)
 *   │    （同 exact opening 幂等重试；不同 contract → binding conflict）
 *   ├─ TTL 到期（GC 显式转换）→ expired（永不可执行——T3）
 *   └─ terminal（consumed/expired）→ GC retire（watermark frontier 验证）
 * ```
 *
 * 关键不变量（X 任务书第二节 B + XI 任务书 3.1-3.3）：
 *  - consume 只发生在 durable lifecycle owner 经**正向结构化证明**
 *    （verdict === "exact_owner"）判定在位之后（不存在"ticket 已 terminal
 *    且没有 durable owner"的窗口）；
 *  - 【XI / 3.1】blocked（store_unhealthy / probe_unavailable / conflict /
 *    insufficient / 不可判定）只阻断执行，绝不授权 consume——ticket 保持
 *    active，修复后同 exact opening 可恢复或幂等完成 handoff；
 *  - 【XI / 3.2】handoff 的 consume / read-back 失败 → callback=0、不报告
 *    handoff_recovered、返回真实结构化失败、ticket 保持原状态或完整回滚；
 *  - 一旦 execution-started 已持久化（durable owner 在位），ticket 永不回到
 *    可执行状态——恢复路径是幂等 consume + 拒绝（不重复 callback）；
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
import { resolveTreasuryAttemptLifecycleOwnership } from "@/runtime/treasury/treasuryLifecycleOwnerResolver";

export type TreasuryIssuedTicketGateReason =
  | "issued_ticket_store_unhealthy"
  | "issued_ticket_missing"
  | "issued_ticket_unissued"
  | "issued_ticket_expired"
  | "issued_ticket_consumed_without_owner"
  | "issued_ticket_handoff_recovered"
  | "issued_ticket_owner_unverifiable"
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
 * 【XI 工作流 A】返回的 verdict 区分 exact_owner（正向）与 blocked（保守
 * 阻断）——handoff 只消费 exact_owner。
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
 * 【X 工作流 A → XI 工作流 A】ticket gate 共通判定链（contract execution 与
 * prepare 两个入口共用；contractDigest 为 null 时跳过 binding——低层 kernel
 * 通道没有 AC4 digest）。
 *
 * 通过（返回 null）= ticket 健康、canonical、发行事实在 watermark 内、
 * active、binding 一致，且无正向 durable owner 在位（首次 opening）。任何
 * 拒绝都发生在 Game callback 之前（callback=0）。
 */
function gateTreasuryIssuedAttemptTicket(
  transactionId: string,
  contractDigest: string | null,
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
  // 【XI 工作流 A / 3.1-3.3】正向 handoff 证明：只有 verdict === "exact_owner"
  // （结构化、来源明确、身份相容的正向 durable owner）才允许幂等 consume；
  // blocked（store unhealthy / probe 未装配 / identity conflict / 不可判定）
  // 一律拒绝且 ticket 保持 active（H1-H5）——"现在不能删除"≠"owner 已接管"。
  const ownership = durableOwnerInPlace(transactionId);
  if (ownership.verdict === "exact_owner") {
    const completion = completeTreasuryIssuedTicketHandoff(transactionId);
    if (completion.status === "consumed") {
      return {
        reason: "issued_ticket_handoff_recovered",
        detail: `正向 durable owner（${ownership.owner ?? "unknown"}）已在位——ticket handoff 幂等完成，不得重复执行（Game callback 零调用）`,
      };
    }
    if (completion.status === "absent") {
      return {
        reason: "issued_ticket_missing",
        detail: "正向 durable owner 在位但 handoff consume 时 ticket 缺失（同 tick 内被删除——不报告 handoff_recovered，fail closed）",
      };
    }
    // 【XI / H7】consume 或 read-back 失败：不报告 handoff_recovered，返回
    // 真实结构化失败；ticket 已由 consume 原语完整回滚（保持原状态）。
    if (completion.status === "rejected") {
      return {
        reason: completion.reason === "store_unhealthy" ? "issued_ticket_store_unhealthy" : "issued_ticket_state_conflict",
        detail: `正向 durable owner（${ownership.owner ?? "unknown"}）在位但 handoff consume 失败（${completion.detail}）——不报告 handoff_recovered，ticket 保持原状态，修复后可再次完成 handoff`,
      };
    }
    // consume 原语不产生 expired 返回（防御分支——fail closed）。
    return {
      reason: "issued_ticket_state_conflict",
      detail: `正向 durable owner（${ownership.owner ?? "unknown"}）在位但 handoff consume 返回 ${completion.status}（协议不可达分支——fail closed）`,
    };
  }
  if (ownership.verdict === "blocked") {
    return {
      reason: "issued_ticket_owner_unverifiable",
      detail: `durable owner 不可正向证明（${ownership.owner ?? "unknown"}——保守阻断，非 exact owner）：当前 execute fail closed、callback=0；ticket 保持 active（不 consume / 不 expire / 不删除），修复相关 store 后同 exact opening 可恢复或幂等完成 handoff`,
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
  if (contractDigest !== null) {
    const bind = bindTreasuryIssuedAttemptTicketToContract(transactionId, contractDigest);
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
 * 【X 工作流 A】contract execution 的 ticket gate（executePreparedAction 在
 * prepared 成功后、redemption/intent/callback 之前调用）。
 */
export function gateTreasuryIssuedAttemptTicketForContractExecution(
  transactionId: string,
  contractDigest: string,
): TreasuryTicketGateRejection | null {
  return gateTreasuryIssuedAttemptTicket(transactionId, contractDigest);
}

/**
 * 【X 工作流 A】prepareTransaction 层的轻量 gate（contract 与低层 kernel
 * 通道共用——production Game callback 的唯一必经点）。与 contract 层 gate
 * 的差异：无 contract binding（低层通道没有 AC4 digest）。
 */
export function gateTreasuryIssuedAttemptTicketForPrepare(transactionId: string): TreasuryTicketGateRejection | null {
  return gateTreasuryIssuedAttemptTicket(transactionId, null);
}

/**
 * 【X 工作流 B → XI 工作流 A】owner-gated handoff 完成：durable lifecycle
 * owner 经统一 resolver **正向结构化证明**（verdict === "exact_owner"，
 * exclude ticket 自身与瞬态预留）才 consume；owner 不可正向证明（blocked）
 * 或确证不在位（absent）→ 拒绝（绝不制造 consumed-but-unowned ticket——
 * T9/B8；blocked 时同样不 consume——H1-H4 修复前保持原状态）。
 *
 * 统一 consume 规则（executePreparedAction 收尾调用，覆盖全部中断窗口）：
 * 正向 durable owner 在位（intent/receipt/tombstone/quarantine/writeFault/
 * journal/…，含 callback 已执行后的 committed 与 uncertain 状态）→ consume；
 * owner 缺失（纯前置失败 / 完整回滚的 abort）→ ticket 保持 active（同
 * exact opening 幂等重试，B5）。
 */
export function completeTreasuryIssuedTicketHandoff(transactionId: string): TreasuryIssuedTicketMutationResult {
  if (!isTreasuryCurrentIssuedInitialAttemptId(transactionId)) return { status: "absent" };
  const ownership = durableOwnerInPlace(transactionId);
  if (ownership.verdict !== "exact_owner") {
    return {
      status: "rejected",
      reason: "state_conflict",
      detail:
        ownership.verdict === "blocked"
          ? `durable owner 不可正向证明（${ownership.owner ?? "unknown"}——保守阻断）：不得 consume（修复前 ticket 保持原状态，fail closed）`
          : "durable lifecycle owner 不在位（不得 consume——consumed-but-unowned ticket 是协议违规，fail closed）",
    };
  }
  return consumeTreasuryIssuedAttemptTicketForHandoff(transactionId);
}
