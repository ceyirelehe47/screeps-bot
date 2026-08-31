/**
 * 【第十六轮第六节】跨 store execution-fact cohesion 的唯一权威比较器。
 *
 * 背景（Round 15 遗留断链）：双 authority resolver 此前只比较 immutable
 * identity（digest/kind/postings/durable identity），immutable identity 相同
 * 不代表 execution facts 自动相同——`intent.returned_ok` 与较弱的
 * `quarantine.started_unknown` 并存时 resolver 无条件 quarantine 优先，
 * 丢失"Game 已明确返回 OK"的事实，可能对已成功动作签发 not-executed。
 *
 * 本模块统一比较同一 attempt 的双 authority execution facts：
 * - **outcome 规则**（6.2）：只有完全相同的 outcome 才可自动归一化。
 *   returned_ok 存在于任何一边而另一边不是 returned_ok → inconsistent
 *   （零释放、两份 authority 全保留）；aborted_final 与任何 modern/lowlevel
 *   运行时事实并存 → inconsistent（终态不应再有 unresolved quarantine）；
 * - **workflow/phase 矩阵**（6.3）：outcome 相同时进一步验证 intent
 *   settlement 与 quarantine phase/settlement 的组合——phase 类别必须与
 *   outcome 严格对应（不允许"事实上探"跨类并存：returned_ok 不得配
 *   execution-unknown phase；returned_non_ok 不得配 commit phase）；
 * - **归一化合并规则**（6.4）：outcome 取共同值；settlement 取双方向更
 *   进展一方（明确合并，不简单复制某一侧）；phase 取 quarantine（write-fault
 *   权威形态）。
 *
 * 本模块是唯一权威实现：resolver（unresolvedAuthority）、capability 签发与
 * recovery 的 fact conflict 判定都经此模块，不得在 store 内联比较。
 */

import { outcomeOfTreasuryFaultPhase } from "@/runtime/treasury/quarantine";
import { TREASURY_EXECUTION_UNKNOWN_PHASES } from "@/runtime/treasury/writeFault";

/** execution outcome 的事实等级（单调：事实只能变强，不能回退）。 */
const OUTCOME_FACT_RANK: Readonly<Record<string, number>> = Object.freeze({
  not_started: 0,
  started_unknown: 1,
  returned_non_ok: 2,
  returned_ok: 3,
});

/** intent settlement 的进展等级（归一化合并规则用）。 */
const SETTLEMENT_PROGRESS_RANK: Readonly<Record<string, number>> = Object.freeze({
  ready: 0,
  executing: 1,
  pending_abort: 2,
  pending_commit: 2,
  quarantined: 3,
  faulted: 3,
  resolving: 4,
  finalized: 5,
});

/**
 * quarantine phase 与 intent settlement 并存时、按共同 outcome 允许的
 * intent settlement 集合（6.3 workflow 兼容矩阵）：
 * - not_started：internal authorization fault 类（callback 未调用）；
 * - started_unknown：execution-unknown 类中副作用未知的 phase；
 * - returned_non_ok：abort 失败类（Game 明确非 OK）；
 * - returned_ok：commit 类（Game 已确认 OK 后的发布故障）。
 * ready / finalized 不允许与 unresolved quarantine 并存（未开始/已终结的
 * intent 不应处于 unresolved 隔离态）。
 */
const COEXIST_INTENT_SETTLEMENTS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  not_started: new Set(["quarantined", "resolving", "faulted"]),
  started_unknown: new Set(["executing", "quarantined", "resolving", "faulted"]),
  returned_non_ok: new Set(["pending_abort", "quarantined", "resolving", "faulted"]),
  returned_ok: new Set(["pending_commit", "quarantined", "resolving", "faulted"]),
});

/** outcome 对应的合法 quarantine phase 集合（类别严格对应，不允许跨类上探）。 */
function allowedQuarantinePhasesForOutcome(outcome: string): ReadonlySet<string> | undefined {
  if (outcome === "returned_ok") {
    // commit 类：Game callback 已确认 OK 之后的发布/确认故障。
    return new Set([
      "receipt_publish",
      "heap_publish",
      "journal_publish",
      "overlay_publish",
      "handle_state",
      "commit_unexpected",
      "ok_pending_commit_unresolved",
    ]);
  }
  if (outcome === "returned_non_ok") {
    return new Set(["action_returned_non_ok_abort_failed"]);
  }
  if (outcome === "started_unknown") {
    // 剔除 abort_failed（其单调推导为 returned_non_ok——与 started_unknown
    // 并存属于事实冲突，交由 outcome 对等检查拦截）。
    return new Set(["executing_at_end_tick", "action_threw_execution_unknown"]);
  }
  if (outcome === "not_started") {
    return new Set(["internal_authorization_fault", "internal_authorization_fault_forensic"]);
  }
  return undefined;
}

/** 单侧 execution fact 视图（intent / quarantine entry 的窄投影）。 */
export interface TreasuryExecutionFactSource {
  readonly outcome: string;
  readonly settlement: string;
  /** quarantine 专属（write-fault phase）；intent 来源无此字段。 */
  readonly phase?: string;
}

export type TreasuryExecutionFactCohesionVerdict =
  | {
      readonly status: "cohesive";
      /** 归一化合并后的 execution facts（outcome=共同值；settlement=更进展一方）。 */
      readonly merged: { readonly outcome: string; readonly settlement: string; readonly phase: string };
    }
  | { readonly status: "inconsistent"; readonly detail: string };

/**
 * 双 authority execution fact cohesion 比较（唯一权威）：
 * 1. outcome 对等：双方 outcome 必须完全相同（aborted_final 或未知枚举与任何
 *    运行时事实并存 → inconsistent；returned_ok 单侧存在 → inconsistent，
 *    绝不"选择更强事实"掩盖持久记录不一致）；
 * 2. phase 严格对应：quarantine.phase 必须属于共同 outcome 的合法 phase 类
 *    （并与 phase 的单调推导 outcome 自洽）；
 * 3. workflow 兼容：intent.settlement 必须属于共同 outcome 的并存集合；
 *    quarantine.settlement 必须为 quarantined/resolving（store 契约，防御复查）。
 */
export function compareTreasuryExecutionFactCohesion(input: {
  readonly quarantine: TreasuryExecutionFactSource & { readonly phase: string };
  readonly intent: TreasuryExecutionFactSource;
}): TreasuryExecutionFactCohesionVerdict {
  const { quarantine, intent } = input;
  if (quarantine.outcome === "aborted_final" || intent.outcome === "aborted_final") {
    return {
      status: "inconsistent",
      detail: `execution outcome aborted_final 与 unresolved authority 并存（quarantine ${quarantine.outcome}，intent ${intent.outcome}）——终态 attempt 不得再有隔离权威，inconsistent fail closed`,
    };
  }
  if (quarantine.outcome !== intent.outcome) {
    return {
      status: "inconsistent",
      detail: `同 id 双权威 execution outcome 不一致（quarantine ${quarantine.outcome}，intent ${intent.outcome}）——fail closed，两份 authority 全保留，绝不选择更强一侧`,
    };
  }
  const sharedOutcome = quarantine.outcome;
  // phase 单调自洽：phase 推导 outcome 不得强于共同 outcome（弱于 = 显式上探，
  // 由下方类别矩阵拦截跨类形态）。
  const derived = outcomeOfTreasuryFaultPhase(quarantine.phase);
  if (derived !== sharedOutcome) {
    const sharedRank = OUTCOME_FACT_RANK[sharedOutcome];
    const derivedRank = OUTCOME_FACT_RANK[derived];
    if (sharedRank === undefined || derivedRank === undefined || derivedRank > sharedRank) {
      return {
        status: "inconsistent",
        detail: `quarantine phase ${quarantine.phase} 的单调推导 outcome ${derived} 与共同 outcome ${sharedOutcome} 事实冲突——fail closed`,
      };
    }
  }
  const allowedPhases = allowedQuarantinePhasesForOutcome(sharedOutcome);
  if (allowedPhases === undefined || !allowedPhases.has(quarantine.phase)) {
    return {
      status: "inconsistent",
      detail: `quarantine phase ${quarantine.phase} 与共同 outcome ${sharedOutcome} 的 phase 类别矩阵不兼容（跨类上探并存禁止——returned_ok 只配 commit 类 phase、returned_non_ok 只配 abort-failed、started_unknown 只配 execution-unknown 类）——fail closed`,
    };
  }
  const allowedSettlements = COEXIST_INTENT_SETTLEMENTS[sharedOutcome];
  if (allowedSettlements === undefined || !allowedSettlements.has(intent.settlement)) {
    return {
      status: "inconsistent",
      detail: `intent settlement ${intent.settlement} 与共同 outcome ${sharedOutcome} 的 workflow 并存矩阵不兼容（ready/finalized 或跨类 settlement 不得与 unresolved quarantine 并存）——fail closed`,
    };
  }
  if (quarantine.settlement !== "quarantined" && quarantine.settlement !== "resolving") {
    return {
      status: "inconsistent",
      detail: `quarantine settlement ${quarantine.settlement} 非法（unresolved quarantine 只允许 quarantined/resolving）——fail closed`,
    };
  }
  // 归一化合并规则：outcome=共同值；settlement=双方向更进展一方；phase=quarantine
  // （write-fault 权威形态）。
  const intentRank = SETTLEMENT_PROGRESS_RANK[intent.settlement] ?? 0;
  const quarantineRank = SETTLEMENT_PROGRESS_RANK[quarantine.settlement] ?? 0;
  const mergedSettlement = intentRank >= quarantineRank ? intent.settlement : quarantine.settlement;
  return {
    status: "cohesive",
    merged: { outcome: sharedOutcome, settlement: mergedSettlement, phase: quarantine.phase },
  };
}
