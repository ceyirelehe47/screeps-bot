/**
 * Treasury unified unresolved authority（第九轮 4.7 / 第十轮 3.12.1）——
 * 签发、prevalidation、resolution、recovery、release 共用的同一套 authority
 * resolution。
 *
 * 背景（第八轮遗留断链）：capability 签发侧读 quarantine 优先 + intent
 * emergency 兜底，但 fault resolution 只读 quarantine——quarantine 写失败
 * 保留的 emergency intent 无法参与 resolution。本模块归一化两种 durable
 * 权威：
 *
 * - **quarantine 优先**：同 id 双存在且身份一致时视为同一 transaction 的
 *   双形态状态（quarantine 为恢复目标形态，intent 是 emergency 残留），
 *   authority 取 quarantine（contract 绑定事实从 intent 合并——quarantine
 *   entry 无 contract 字段）；
 * - **不一致 fail closed**：同 id 双存在但 digest/postings/kind 任一不一致
 *   → inconsistent（capability 签发与 resolution 均拒绝，不任选其一）；
 * - **intent-only**：quarantine 写失败时 intent 是唯一权威（emergency
 *   intent authority）——完整参与 capability 签发与 resolution；
 * - **execution outcome 权威**（第十轮）：intent 来源直接携带 v3 outcome；
 *   quarantine v1 来源从 write-fault phase 单调推导（commit 类 → returned_ok
 *   ——永不允许 not-executed；action_returned_non_ok_abort_failed →
 *   returned_non_ok；其余 execution-unknown 类 → started_unknown）；
 *   not-executed 允许性按 outcome 判定，不再按混合 phase 字符串猜测。
 */

import { readTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import { readTreasuryIntentEntry } from "@/runtime/treasury/intents";
import { TREASURY_EXECUTION_UNKNOWN_PHASES } from "@/runtime/treasury/writeFault";

/** 归一化 authority facts（签发/resolution/recovery/release 共用形状）。 */
export interface TreasuryUnresolvedAuthority {
  readonly authorityKind: "quarantine" | "intent";
  readonly transactionId: string;
  readonly digest: string;
  readonly kind: string;
  readonly actionKind: string;
  /** quarantine write-fault phase 或 intent settlement（诊断；判定权威在 outcome）。 */
  readonly phase: string;
  /** execution outcome（事实等级；not-executed 允许性的唯一判定依据）。 */
  readonly outcome: string;
  /** settlement workflow state（intent 来源必填；quarantine 来源为推导值）。 */
  readonly settlement: string;
  readonly recordedAt: number;
  /** 原 action tick（quarantine.tick / intent.createdAtTick——审计与 tombstone 用）。 */
  readonly actionTick: number;
  readonly postings: readonly { roomName: string; locationKind: string; resource: string; delta: number }[];
  readonly contractId?: string;
  readonly contractDigest?: string;
  readonly adapterVersion?: number;
  readonly durablePayload?: string;
  readonly durablePayloadVersion?: number;
}

export type TreasuryUnresolvedAuthorityResolution =
  | { readonly status: "ok"; readonly authority: TreasuryUnresolvedAuthority }
  | { readonly status: "not_found" }
  | { readonly status: "inconsistent"; readonly detail: string };

/**
 * quarantine v1 write-fault phase → execution outcome 的单调推导（第十轮
 * 3.12.1）：commit 类 phase 全部发生在 Game callback 已确认 OK 之后 →
 * returned_ok；Game 已明确返回非 OK → returned_non_ok；其余 execution-
 * unknown 类 → started_unknown。
 */
function outcomeOfQuarantinePhase(phase: string): string {
  if (phase === "action_returned_non_ok_abort_failed") return "returned_non_ok";
  if (TREASURY_EXECUTION_UNKNOWN_PHASES.has(phase)) return "started_unknown";
  return "returned_ok";
}

function postingSignature(postings: readonly { roomName: string; locationKind: string; resource: string; delta: number }[]): string {
  return [...postings]
    .map((leg) => `${leg.roomName}\u0000${leg.locationKind}\u0000${leg.resource}\u0000${String(leg.delta)}`)
    .sort()
    .join("\u0001");
}

/**
 * 解析 transactionId 的 unresolved authority（唯一入口——capability 签发
 * 与 faultResolution 的 prevalidate 均经本函数）：
 * - 同 id 双存在：digest/kind/postings（规范逐腿比较）必须全等，否则
 *   inconsistent fail closed；
 * - 一致：取 quarantine（contract 绑定事实从 intent 合并；outcome 以
 *   quarantine phase 推导为准——事实转移完成后 quarantine 是权威形态）；
 * - 单一存在：直接使用；均无：not_found。
 */
export function resolveTreasuryUnresolvedAuthority(transactionId: string): TreasuryUnresolvedAuthorityResolution {
  const quarantined = readTreasuryQuarantineEntry(transactionId);
  const intended = readTreasuryIntentEntry(transactionId);
  if (quarantined === undefined && intended === undefined) {
    return { status: "not_found" };
  }
  if (quarantined !== undefined && intended !== undefined) {
    if (quarantined.digest !== intended.digest) {
      return {
        status: "inconsistent",
        detail: `同 id 双权威 digest 不一致（quarantine ${quarantined.digest}，intent ${intended.digest}）——fail closed，不任选其一`,
      };
    }
    if (quarantined.kind !== intended.kind) {
      return {
        status: "inconsistent",
        detail: `同 id 双权威 kind 不一致（quarantine ${quarantined.kind}，intent ${intended.kind}）——fail closed`,
      };
    }
    if (postingSignature(quarantined.deltas) !== postingSignature(intended.postings)) {
      return {
        status: "inconsistent",
        detail: "同 id 双权威 postings 不一致（canonical 逐腿比较）——fail closed，不任选其一",
      };
    }
  }
  if (quarantined !== undefined) {
    // quarantine 优先；contract 绑定事实从并存 intent 合并（quarantine entry
    // 无 contract 字段）。
    const contractSource = intended;
    return {
      status: "ok",
      authority: {
        authorityKind: "quarantine",
        transactionId: quarantined.transactionId,
        digest: quarantined.digest,
        kind: quarantined.kind,
        actionKind: quarantined.kind,
        phase: quarantined.phase,
        outcome: outcomeOfQuarantinePhase(quarantined.phase),
        settlement: "quarantined",
        recordedAt: quarantined.recordedAt,
        actionTick: quarantined.tick,
        postings: quarantined.deltas.map((leg) => ({ ...leg })),
        ...(contractSource?.contractId !== undefined ? { contractId: contractSource.contractId } : {}),
        ...(contractSource?.contractDigest !== undefined ? { contractDigest: contractSource.contractDigest } : {}),
        ...(contractSource?.adapterVersion !== undefined ? { adapterVersion: contractSource.adapterVersion } : {}),
        ...(contractSource?.durablePayload !== undefined ? { durablePayload: contractSource.durablePayload } : {}),
        ...(contractSource?.durablePayloadVersion !== undefined ? { durablePayloadVersion: contractSource.durablePayloadVersion } : {}),
      },
    };
  }
  // intent-only（emergency authority）：完整参与签发与 resolution。
  const intent = intended as NonNullable<typeof intended>;
  return {
    status: "ok",
    authority: {
      authorityKind: "intent",
      transactionId: intent.transactionId,
      digest: intent.digest,
      kind: intent.kind,
      actionKind: intent.actionKind,
      phase: intent.settlement,
      outcome: intent.outcome,
      settlement: intent.settlement,
      recordedAt: intent.updatedAtTick,
      actionTick: intent.createdAtTick,
      postings: intent.postings.map((leg) => ({ ...leg })),
      ...(intent.contractId !== undefined ? { contractId: intent.contractId } : {}),
      ...(intent.contractDigest !== undefined ? { contractDigest: intent.contractDigest } : {}),
      ...(intent.adapterVersion !== undefined ? { adapterVersion: intent.adapterVersion } : {}),
      ...(intent.durablePayload !== undefined ? { durablePayload: intent.durablePayload } : {}),
      ...(intent.durablePayloadVersion !== undefined ? { durablePayloadVersion: intent.durablePayloadVersion } : {}),
    },
  };
}

/**
 * not-executed resolution 允许性（第十轮 3.12.1——按 execution outcome 事实
 * 等级判定，不再按混合 phase 字符串猜测）：
 * - returned_ok：已知 Game 返回 OK——永不允许 not-executed（事实单调）；
 * - started_unknown：副作用未知——允许（配合显式 post-observation 证据）；
 * - returned_non_ok：Game 已明确返回非 OK（动作未生效）——允许；
 * - not_started / aborted_final：不应出现在 unresolved authority（恢复路径
 *   直接释放）；防御性拒绝。
 */
export function isTreasuryUnresolvedAuthorityNotExecutable(authority: TreasuryUnresolvedAuthority): boolean {
  return authority.outcome === "started_unknown" || authority.outcome === "returned_non_ok";
}
