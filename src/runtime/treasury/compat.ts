/**
 * Treasury 单阶段登记兼容入口（第五轮退役隔离）。
 *
 * recordAcceptedTransaction / recordAcceptedAction 已从 TreasuryService
 * 公共 writer API 移除：正式生产 writer 必须走
 * executePreparedAction（prepare → Game API 恰好一次 → commit/abort）。
 * 实现保留在服务对象上，仅供：
 * - 既有 Treasury 测试（receipt/投影/对账语义回归）；
 * - 迁移过渡期确已确认 Game API 成功的存量语义。
 *
 * 架构边界（treasuryWriteArchitecture.test.ts 守护）：生产模块不得 import
 * 本文件、不得调用 compatRecord*；兼容路径与单阶段原语义一致（含
 * tentative 感知授权与 write admission 锁），不得抢占 prepared 预留。
 */

import type { TreasuryService } from "@/runtime/treasury/facade";
import type {
  TreasuryRecordActionInput,
  TreasurySettlementResult,
  TreasuryTransactionInput,
} from "@/runtime/treasury/types";

/** 服务对象上保留的内部单阶段形状（不在公共接口上）。 */
interface TreasurySingleStageCompatWriter {
  recordAcceptedTransaction(input: TreasuryTransactionInput): TreasurySettlementResult;
  recordAcceptedAction(input: TreasuryRecordActionInput): TreasurySettlementResult;
}

/** @internal 单阶段多 posting 登记（兼容口径，生产 writer 禁用）。 */
export function compatRecordAcceptedTransaction(
  service: TreasuryService,
  input: TreasuryTransactionInput,
): TreasurySettlementResult {
  return (service as unknown as TreasurySingleStageCompatWriter).recordAcceptedTransaction(input);
}

/** @internal 单阶段单 posting 登记（兼容口径，生产 writer 禁用）。 */
export function compatRecordAcceptedAction(
  service: TreasuryService,
  input: TreasuryRecordActionInput,
): TreasurySettlementResult {
  return (service as unknown as TreasurySingleStageCompatWriter).recordAcceptedAction(input);
}
