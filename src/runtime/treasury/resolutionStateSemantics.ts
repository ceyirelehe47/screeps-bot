/**
 * 【第十六轮第九节】resolution tombstone 的内在持久状态语义矩阵（唯一权威）。
 *
 * 背景：Round 15 建立了写入口的不可逆状态机（resolutionStateMachine——
 * transition validator），但 load / migration 只做字段形状校验
 * （validateTreasuryResolutionTombstoneShape）——"resolving not-executed"、
 * "final committed 缺 settledAtTick"、"forensic provenance 配 identity-bound
 * proof" 等语义非法的持久状态可在 recovery 中被自动删除而非 fail closed。
 *
 * 本模块与形状校验 / 转换校验职责分离：
 * - **形状**（resolutionStore.validateTreasuryResolutionTombstoneShape）：
 *   字段类型 / 枚举 / 长度 / digest 模式；
 * - **状态语义**（本模块）：stage × resolution × proofLevel × provenance ×
 *   tick × preExecution 的持久状态合法性矩阵——供 load 全量校验、migration、
 *   写入候选、read-back、repair 共同使用；
 * - **转换**（resolutionStateMachine）：写入口的 absent/resolving/final 不可逆
 *   状态机。
 *
 * 损坏处理（9.2）：load 发现非法持久状态 → resolution store unhealthy
 * （fail closed），原 entry 保留、write readiness=false、recovery 不删除
 * entry——**删除非法持久状态不是 repair**。
 */

import type { TreasuryResolutionTombstone } from "@/runtime/treasury/resolutionStore";
import { parseTreasuryRearmChildTransactionIdV2 } from "@/runtime/treasury/transactionId";

/** 校验上下文：load/migration 兼容历史（迁移数据缺新字段 = 隔离而非 fatal）；write 对新写入严格。 */
export type TreasuryResolutionStateValidationContext = "load" | "write";

/**
 * 单条 tombstone 的内在状态语义校验（返回 null = 合法，否则有界错误描述）。
 *
 * 必须校验（9.1）：
 * - stage 必须显式且属于 {resolving, final}（v1-v4 迁移必须补齐终态 stage）；
 * - resolving：只能 committed（resolving not-executed 非法）、settledAtTick
 *   必填、proofLevel 只能是普通受支持自动 resolution 等级
 *   （identity-bound/lowlevel——forensic/legacy 不得处于普通 resolving）、
 *   不携带 forensic provenance、不携带 not-executed 专用事实（preExecution）；
 * - final committed：settledAtTick 必填、proof/identity 矩阵完整（形状校验
 *   承载）、不携带 preExecution、不携带 forensic provenance；
 * - final not-executed：不携带 committed receipt tick 语义（settledAtTick）、
 *   proofLevel/provenance 符合 not-executed 路径、forensic provenance 只配
 *   forensic proof level（矛盾组合非法）；
 * - tick 时序：settledAtTick / observationTick 不得晚于 resolvedAtTick；
 * - write 上下文追加：proofLevel=lowlevel 的新写入必须携带 lowlevelSource
 *   （第十六轮第十一节——旧数据缺失由 load 上下文放行为隔离态，不得猜测
 *   runtime 来源）；identity-bound 禁止携带 lowlevelSource。
 */
export function validateTreasuryResolutionTombstoneState(
  entry: TreasuryResolutionTombstone,
  context: TreasuryResolutionStateValidationContext = "load",
): string | null {
  if (entry.stage !== "resolving" && entry.stage !== "final") {
    return `stage 缺失或未知（持久状态非法，须为 resolving|final——v1-v4 迁移必须补齐终态 stage）: ${String((entry as { stage?: string }).stage).slice(0, 24)}`;
  }
  if (entry.forensicProvenance !== undefined && entry.proofLevel !== "forensic") {
    return `forensic provenance 与 proof level 矛盾（provenance 只配 forensic proof，当前 ${String(entry.proofLevel)}）`;
  }
  if (entry.observationTick > entry.resolvedAtTick) {
    return "observationTick 晚于 resolvedAtTick（持久时序非法）";
  }
  if (entry.stage === "resolving") {
    if (entry.resolution !== "committed") {
      return `resolving ${String(entry.resolution)} 非法（resolving tombstone 只能是 committed resolution-intent；not-executed 只能直接写 final）`;
    }
    if (entry.settledAtTick === undefined) {
      return "resolving committed 缺 settledAtTick（staged resolution-intent 必须携带目标结算 tick）";
    }
    if (entry.proofLevel !== "identity-bound" && entry.proofLevel !== "lowlevel") {
      return `resolving proofLevel ${String(entry.proofLevel)} 非法（只能为普通受支持自动 resolution 等级 identity-bound|lowlevel；forensic/legacy 不得处于普通 resolving）`;
    }
    if (entry.preExecution === true) {
      return "resolving 不得携带 preExecution 标记（not-executed 专用事实）";
    }
    // settledAtTick 是 staged 目标结算 tick（允许晚于创建时刻 resolvedAtTick
    // ——恢复续做 refresh 至该目标；时序约束在 final 终态检查）。
  } else {
    // stage === "final"
    if (entry.settledAtTick !== undefined && entry.settledAtTick > entry.resolvedAtTick) {
      return "settledAtTick 晚于 resolvedAtTick（final 终态持久时序非法）";
    }
    if (entry.resolution === "committed") {
      if (entry.settledAtTick === undefined) {
        return "final committed 缺 settledAtTick（终态 committed 必须携带 receipt 结算 tick）";
      }
      if (entry.preExecution === true) {
        return "final committed 不得携带 preExecution 标记（pre-execution fault 只产生 not-executed 终态）";
      }
    } else {
      // final not-executed
      if (entry.settledAtTick !== undefined) {
        return "final not-executed 携带 settledAtTick（committed receipt tick 语义不得出现在 not-executed 终态）";
      }
      if (entry.preExecution === true && entry.source !== "acknowledge-rolled-back" && entry.source !== "acknowledge-rolled-back-forensic") {
        return `preExecution 标记与来源不一致（source ${String(entry.source)} 不是 pre-execution 受控通道）`;
      }
    }
  }
  if (context === "write") {
    if (entry.proofLevel === "lowlevel" && entry.lowlevelSource === undefined) {
      return "lowlevel tombstone 新写入缺 lowlevelSource（第十六轮起低层 proof 必须显式绑定 provenance——旧数据缺失为隔离态，不得猜测 runtime 来源）";
    }
    if (entry.proofLevel === "identity-bound" && entry.lowlevelSource !== undefined) {
      return "identity-bound tombstone 禁止携带 lowlevelSource（modern proof 不携带低层 provenance）";
    }
    // 【第十九轮 A.3】tr1_ v2 rearm attempt 的新写 tombstone 必带完整 lineage
    // proof——v1 tr1_ ID 不可 generation 寻址（历史 load 兼容形态不强制）。
    if (
      typeof entry.transactionId === "string" &&
      entry.transactionId.startsWith("tr1_") &&
      parseTreasuryRearmChildTransactionIdV2(entry.transactionId) !== null
    ) {
      if (
        entry.lineageId === undefined || entry.lineageGeneration === undefined ||
        entry.parentTransactionId === undefined || entry.lineageBindingDigest === undefined
      ) {
        return "tr1_ v2 rearm attempt 的新写 tombstone 必须携带完整 lineage proof（generation 寻址的 attempt 缺 proof = 身份不可证明——fail closed）";
      }
    }
  }
  return null;
}
