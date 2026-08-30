/**
 * Treasury 显式 fault resolution 协议（第六轮）——替代已移除的无条件
 * 无条件删除 write-fault marker 的旧修复入口。
 *
 * 背景：write-fault marker / durable quarantine 只证明"Game 结果未知或
 * commit 未完成"，无法证明 Game 动作是否发生。直接删除 marker 解锁会让
 * 资源被错误释放、已执行动作可能被重放。因此解锁必须携带**证据语义**：
 *
 * - resolve-as-committed：管理员确认（或依据外部对账证据认定）Game 动作
 *   已发生/应视为已发生——补全/确认 receipt（幂等，最多提交一次）、释放
 *   对应 quarantine、清除匹配的 write-fault marker；防重放由 receipt 保证；
 *   global reset 后仍可完成（全部权威在 Memory）。
 * - resolve-as-not-executed：仅在证据允许（Game 结果未确认的 phase：
 *   executing_at_end_tick / abort_failed——后者 Game 已返回非 OK）时，
 *   管理员确认动作未发生——释放 quarantine、不写 receipt、不生成
 *   committed projection、显式返回允许重新 prepare。Game 确认 OK 后的
 *   commit 故障 phase 一律拒绝（不允许伪造"未执行"）。
 *
 * 安全边界（架构测试守护）：
 * - resolution 幂等（重复调用 already_resolved / 零副作用拒绝）；
 * - 错误 transactionId / digest 不匹配 / 不允许的 resolution → 拒绝且
 *   fault/quarantine 保持不变；
 * - resolution 完成前 write admission 持续锁定（本模块不清除不匹配的
 *   marker；全部 quarantine 解决前若仍有其它 unresolved 故障，锁保持）；
 * - 生产 tick 不得自动调用（仅显式管理/修复路径与测试可引用）。
 */

import {
  commitSettledReceipt,
  hasSettledReceipt,
} from "@/runtime/treasury/receipts";
import {
  clearTreasuryWriteFaultMarkerForResolution,
  readTreasuryWriteFault,
} from "@/runtime/treasury/writeFault";
import {
  readTreasuryQuarantineEntry,
  releaseTreasuryQuarantineEntry,
} from "@/runtime/treasury/quarantine";

export interface TreasuryFaultResolutionInput {
  readonly transactionId: string;
  /** 可选 digest 核对（提供时必须与 quarantine entry 一致，否则拒绝）。 */
  readonly digest?: string;
}

export type TreasuryFaultResolutionResult =
  | {
      readonly status: "resolved";
      readonly resolution: "committed" | "not-executed";
      readonly transactionId: string;
      /** 本次调用是否实际写入 receipt（false = 幂等命中既有结算）。 */
      readonly receiptWritten: boolean;
      /** resolution 后是否允许重新 prepare 该 transactionId。 */
      readonly reprepareAllowed: boolean;
    }
  | {
      readonly status: "already_resolved";
      readonly resolution: "committed" | "not-executed";
      readonly transactionId: string;
    }
  | {
      readonly status: "rejected";
      readonly reason:
        | "not_found"
        | "digest_mismatch"
        | "resolution_not_allowed"
        | "receipt_store_fatal"
        | "invalid_input";
      readonly detail: string;
    };

/** Game 结果未确认（允许 not-executed resolution）的 quarantine phase 集合。 */
const NOT_EXECUTED_ALLOWED_PHASES: ReadonlySet<string> = new Set<string>([
  "executing_at_end_tick",
  "abort_failed",
]);

function invalidInput(detail: string): TreasuryFaultResolutionResult {
  return { status: "rejected", reason: "invalid_input", detail };
}

/** 定位并校验 quarantine entry（含可选 digest 核对）。 */
function locateEntry(
  input: TreasuryFaultResolutionInput,
):
  | { entry: NonNullable<ReturnType<typeof readTreasuryQuarantineEntry>> }
  | { rejection: TreasuryFaultResolutionResult } {
  if (!input || typeof input !== "object" || typeof input.transactionId !== "string" || input.transactionId.length === 0) {
    return { rejection: invalidInput("transactionId 缺失或非法") };
  }
  if (input.digest !== undefined && (typeof input.digest !== "string" || input.digest.length === 0)) {
    return { rejection: invalidInput("digest 非法") };
  }
  const entry = readTreasuryQuarantineEntry(input.transactionId);
  if (entry === undefined) {
    return {
      rejection: {
        status: "rejected",
        reason: "not_found",
        detail: `transactionId ${input.transactionId.slice(0, 48)} 不在 durable quarantine（可能已解决或从未隔离）`,
      },
    };
  }
  if (input.digest !== undefined && entry.digest !== input.digest) {
    return {
      rejection: {
        status: "rejected",
        reason: "digest_mismatch",
        detail: `digest 不匹配（quarantine ${entry.digest}，请求 ${input.digest}）——拒绝以避免解决错误 transaction`,
      },
    };
  }
  return { entry };
}

/** 清除与本 transaction 匹配的 write-fault marker（不匹配的根因 marker 不动）。 */
function clearMatchingMarker(transactionId: string, digest: string): void {
  clearTreasuryWriteFaultMarkerForResolution(transactionId, digest);
}

/**
 * resolve-as-committed：Game 动作视为已发生——补全/确认 receipt（幂等、
 * 最多提交一次）、释放 quarantine、清除匹配 marker、防后续重放。
 */
export function resolveTreasuryQuarantinedTransactionAsCommitted(
  input: TreasuryFaultResolutionInput,
): TreasuryFaultResolutionResult {
  const located = locateEntry(input);
  if ("rejection" in located) {
    // 幂等友好路径：entry 已无但 receipt 已结算 → 之前已 resolve-as-committed。
    if (
      located.rejection.status === "rejected" &&
      located.rejection.reason === "not_found" &&
      typeof input?.transactionId === "string" &&
      hasSettledReceipt(input.transactionId) !== undefined
    ) {
      return { status: "already_resolved", resolution: "committed", transactionId: input.transactionId };
    }
    return located.rejection;
  }
  const entry = located.entry;
  const receipt = commitSettledReceipt(entry.transactionId, entry.tick);
  if (receipt.status === "fatal") {
    // receipt store 不可写（损坏/fail-closed）：拒绝，quarantine/marker 不动。
    return { status: "rejected", reason: "receipt_store_fatal", detail: receipt.detail };
  }
  releaseTreasuryQuarantineEntry(entry.transactionId);
  clearMatchingMarker(entry.transactionId, entry.digest);
  return {
    status: "resolved",
    resolution: "committed",
    transactionId: entry.transactionId,
    receiptWritten: receipt.status === "written",
    reprepareAllowed: false, // receipt 已写入：同 id 重放命中 already_settled（防重放）
  };
}

/**
 * resolve-as-not-executed：仅在证据允许（Game 结果未确认的 phase）时释放
 * quarantine——不写 receipt、不生成 committed projection、允许重新 prepare。
 * Game 确认 OK 后的 commit 故障 phase 一律拒绝（不得伪造"未执行"）。
 */
export function resolveTreasuryQuarantinedTransactionAsNotExecuted(
  input: TreasuryFaultResolutionInput,
): TreasuryFaultResolutionResult {
  const located = locateEntry(input);
  if ("rejection" in located) {
    // 该 transaction 已有 receipt（曾被结算/resolve-as-committed）→ 幂等
    // already_resolved；否则 not_found（可能已被 not-executed 解决，零副作用）。
    if (
      located.rejection.status === "rejected" &&
      located.rejection.reason === "not_found" &&
      typeof input?.transactionId === "string" &&
      hasSettledReceipt(input.transactionId) !== undefined
    ) {
      return { status: "already_resolved", resolution: "committed", transactionId: input.transactionId };
    }
    return located.rejection;
  }
  const entry = located.entry;
  if (!NOT_EXECUTED_ALLOWED_PHASES.has(entry.phase)) {
    return {
      status: "rejected",
      reason: "resolution_not_allowed",
      detail: `phase ${entry.phase} 表示 Game callback 已确认成功（commit 路径故障）——不允许 resolve-as-not-executed；只能 resolve-as-committed`,
    };
  }
  releaseTreasuryQuarantineEntry(entry.transactionId);
  clearMatchingMarker(entry.transactionId, entry.digest);
  return {
    status: "resolved",
    resolution: "not-executed",
    transactionId: entry.transactionId,
    receiptWritten: false, // 绝不写 receipt / committed projection
    reprepareAllowed: true, // Game 未执行：允许以同 id 重新 prepare
  };
}

/** 诊断：当前 unresolved write-fault marker（只读）。 */
export function currentTreasuryWriteFaultMarker(): ReturnType<typeof readTreasuryWriteFault> {
  return readTreasuryWriteFault();
}
