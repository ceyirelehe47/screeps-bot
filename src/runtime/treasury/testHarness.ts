/**
 * Treasury 测试专用 harness（第十轮 3.12.5）。
 *
 * 低层 writer 原语（raw authorize / token consume / validate redeem /
 * prepare / execute prepared / direct commit-abort / compat 单阶段入口）已从
 * 生产 TreasuryService 的类型与运行时枚举面移除——它们只经
 * TREASURY_WRITER_KERNEL symbol 通道（non-enumerable）供 treasury 协议栈
 * 内部使用。本模块把 kernel 上的原语展开为**测试视图**（TreasuryTestService
 * = 公共方法 + 低层原语），供既有协议测试与受控实验使用。
 *
 * 架构边界（treasuryWriteArchitecture.test.ts 守护）：
 * - 测试文件（*.test.ts）允许 import 本模块；
 * - treasury 协议栈之外的生产模块不得 import 本模块或 kernelChannel。
 */

import type { TreasuryService } from "@/runtime/treasury/facade";
import { TREASURY_WRITER_KERNEL, type TreasuryKernelHolder } from "@/runtime/treasury/kernelChannel";
import {
  TREASURY_RESOLUTION_KERNEL,
  type TreasuryResolutionKernelHolder,
} from "@/runtime/treasury/resolutionKernelChannel";
import type { TreasuryReconciliationCapabilityConsumption } from "@/runtime/treasury/reconciliation";
import type {
  TreasuryAuthorizationConsumeResult,
  TreasuryAuthorizationRequest,
  TreasuryAuthorizationResult,
  TreasuryAuthorizationToken,
} from "@/runtime/treasury/authorization";
import type {
  TreasuryPreparedAbortResult,
  TreasuryPreparedCommitResult,
  TreasuryPreparationResult,
  TreasurySafeExecuteResult,
  TreasuryTransactionInput,
} from "@/runtime/treasury/types";
import type { TreasuryRecordActionInput, TreasurySettlementResult } from "@/runtime/treasury/types";
import type { TreasuryPosting } from "@/runtime/treasury/types";
import type { TreasuryWriterKernelExecution } from "@/runtime/treasury/facade";
import type { TreasuryPreparedHandle } from "@/runtime/treasury/types";

/** 测试视图：公共 TreasuryService + 低层 writer 原语（kernel 展开）。 */
export type TreasuryTestService = TreasuryService & {
  authorizeResourceUse(request: TreasuryAuthorizationRequest): TreasuryAuthorizationResult;
  validateTreasuryAuthorizationForRedeem(
    tokens: readonly TreasuryAuthorizationToken[],
    contract: { readonly transactionId: string; readonly actionKind: string; readonly digest: string; readonly adapterVersion: number },
    postings: readonly TreasuryPosting[],
  ): { readonly status: "ok" } | { readonly status: "rejected"; readonly reason: string; readonly detail: string };
  consumeTreasuryAuthorization(
    token: TreasuryAuthorizationToken,
    options?: { transactionId?: string; postings?: readonly TreasuryPosting[] },
  ): TreasuryAuthorizationConsumeResult;
  prepareTransaction(input: TreasuryTransactionInput): TreasuryPreparationResult;
  executePreparedAction<TAction extends { ok: boolean }>(
    input: TreasuryTransactionInput,
    action: () => TAction,
    execution?: TreasuryWriterKernelExecution,
  ): TreasurySafeExecuteResult<TAction>;
  commitPreparedTransaction(handle: TreasuryPreparedHandle): TreasuryPreparedCommitResult;
  abortPreparedTransaction(handle: TreasuryPreparedHandle): TreasuryPreparedAbortResult;
  recordAcceptedTransaction(input: TreasuryTransactionInput): TreasurySettlementResult;
  recordAcceptedAction(input: TreasuryRecordActionInput): TreasurySettlementResult;
  /** resolution kernel 展开（第十一轮 3.13.8：capability 只读验证/消费——测试专用）。 */
  validateReconciliationCapability(capability: unknown): TreasuryReconciliationCapabilityConsumption;
  consumeReconciliationCapability(capability: unknown): TreasuryReconciliationCapabilityConsumption;
};

/**
 * 把生产 service 展开为测试视图（浅合并 kernel 原语——调用面与第九轮前
 * 完全一致）。service 不持有 kernel（伪造/非 treasury 通道）时抛错。
 */
export function treasuryTestService(service: TreasuryService): TreasuryTestService {
  const kernel = (service as unknown as TreasuryKernelHolder)[TREASURY_WRITER_KERNEL] as
    | (TreasuryKernelHolder[typeof TREASURY_WRITER_KERNEL] & Record<string, unknown>)
    | undefined;
  if (kernel === undefined) {
    throw new Error("treasuryTestService: service 不持有 writer kernel（非 createTreasuryService 产物）");
  }
  const view = Object.assign({}, service, {
    authorizeResourceUse: kernel.authorizeResourceUse,
    validateTreasuryAuthorizationForRedeem: kernel.validateTreasuryAuthorizationForRedeem,
    consumeTreasuryAuthorization: kernel.consumeTreasuryAuthorization,
    prepareTransaction: kernel.prepareTransaction,
    executePreparedAction: kernel.executePreparedAction,
    commitPreparedTransaction: kernel.commitPreparedTransaction,
    abortPreparedTransaction: kernel.abortPreparedTransaction,
    recordAcceptedTransaction: kernel.recordAcceptedTransaction,
    recordAcceptedAction: kernel.recordAcceptedAction,
  }) as TreasuryTestService;
  // kernel symbol 同步挂载（non-enumerable——视图可再次被包装/传递给协议栈）。
  Object.defineProperty(view, TREASURY_WRITER_KERNEL, {
    value: kernel,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  // resolution kernel（第十一轮 3.13.8）：service 必须持有（伪造对象无效）。
  const resolutionKernel = (service as unknown as TreasuryResolutionKernelHolder)[TREASURY_RESOLUTION_KERNEL];
  if (resolutionKernel === undefined) {
    throw new Error("treasuryTestService: service 不持有 resolution kernel（非 createTreasuryService 产物）");
  }
  Object.defineProperty(view, TREASURY_RESOLUTION_KERNEL, {
    value: resolutionKernel,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.assign(view, {
    validateReconciliationCapability: resolutionKernel.validateReconciliationCapability,
    consumeReconciliationCapability: resolutionKernel.consumeReconciliationCapability,
  });
  return view;
}
