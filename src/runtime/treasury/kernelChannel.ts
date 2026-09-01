/**
 * Treasury writer kernel 通道（第十轮 3.12.5）。
 *
 * 生产 TreasuryService 类型与运行时对象都不暴露低层 writer 原语（raw
 * authorize、token consume、validate redeem、bundle redemption、prepare、
 * execute prepared、direct commit/abort）。kernel 以本模块导出的 unique
 * symbol 作为 non-enumerable 属性挂载在 service 运行时对象上，仅供：
 *
 * - treasury 协议栈内部模块（actionContracts 等，经 kernel 走原子
 *   redemption 与安全执行顺序）；
 * - test harness（src/runtime/treasury/testHarness.ts，测试专用视图）。
 *
 * 架构测试全量扫描 src 下全部生产 .ts 源文件：非 Treasury 内部模块与测试
 * 之外的文件不得 import 本模块或引用 kernel symbol（新文件自动受约束，
 * 不依赖 @internal 注释作为边界）。
 */

import type { TreasuryWriterKernelExecution } from "@/runtime/treasury/facade";
import type {
  TreasuryPreparedHandle,
  TreasuryPreparedAbortResult,
  TreasuryPreparedCommitResult,
  TreasuryPreparationResult,
  TreasurySafeExecuteResult,
  TreasuryTransactionInput,
} from "@/runtime/treasury/types";
import type {
  TreasuryAuthorizationConsumeResult,
  TreasuryAuthorizationRequest,
  TreasuryAuthorizationResult,
  TreasuryAuthorizationToken,
} from "@/runtime/treasury/authorization";
import type { TreasuryPosting } from "@/runtime/treasury/types";

/** kernel 唯一通道键（运行时 non-enumerable 挂载）。 */
export const TREASURY_WRITER_KERNEL: unique symbol = Symbol("treasury.writer-kernel");

/** kernel 上与 contract 执行相关的身份事实（actionContracts → facade）。 */
export interface TreasuryKernelContractIdentity {
  readonly transactionId: string;
  readonly actionKind: string;
  readonly digest: string;
  readonly adapterVersion: number;
}

/** writer kernel 内部接口（闭包实现，普通生产模块不可取得）。 */
export interface TreasuryWriterKernel {
  /** 低层单资源授权（test harness 专用；生产唯一授权入口是 contract-first）。 */
  authorizeResourceUse(request: TreasuryAuthorizationRequest): TreasuryAuthorizationResult;
  /** 单 token 消费（test harness 专用；生产授权消费只经原子 bundle redemption）。 */
  consumeTreasuryAuthorization(
    token: TreasuryAuthorizationToken,
    options?: { transactionId?: string; postings?: readonly TreasuryPosting[] },
  ): TreasuryAuthorizationConsumeResult;
  /** 授权 legs 只读预验证（kernel 内部与 test harness；零状态变化）。 */
  validateTreasuryAuthorizationForRedeem(
    tokens: readonly TreasuryAuthorizationToken[],
    contract: TreasuryKernelContractIdentity,
    postings: readonly TreasuryPosting[],
  ): { readonly status: "ok" } | { readonly status: "rejected"; readonly reason: string; readonly detail: string };
  /** prepare（tentative 接管；actionContracts 执行路径与 test harness）。 */
  prepareTransaction(input: TreasuryTransactionInput, prepareOptions?: {
    /** 【第十七轮第八节】tr1_ rearm child 的 opaque capability（kernel 内部通道）。 */
    readonly rearmCapability?: unknown;
  }): TreasuryPreparationResult;
  /** 任意 callback 执行入口（actionContracts 执行路径与 test harness）。 */
  executePreparedAction<TAction extends { ok: boolean }>(
    input: TreasuryTransactionInput,
    action: () => TAction,
    execution?: TreasuryWriterKernelExecution,
  ): TreasurySafeExecuteResult<TAction>;
  /**
   * opaque bundle 只读解析（actionContracts 执行前调用）：对象身份 + contract
   * 匹配，返回 authorizationDigest；零状态变化、零消费。
   */
  resolveAuthorizationBundle(
    bundle: unknown,
    contract: TreasuryKernelContractIdentity,
  ): { readonly status: "ok"; readonly authorizationDigest: string; readonly contractId: string } | {
    readonly status: "rejected";
    readonly reason: string;
    readonly detail: string;
  };
  /** 两阶段 commit / abort（kernel 内部与 test harness）。 */
  commitPreparedTransaction(handle: TreasuryPreparedHandle): TreasuryPreparedCommitResult;
  abortPreparedTransaction(handle: TreasuryPreparedHandle): TreasuryPreparedAbortResult;
}

/** 测试视图额外暴露的 compat 单阶段入口（kernel symbol 挂载对象上）。 */
export interface TreasuryWriterKernelCompat {
  recordAcceptedTransaction(input: TreasuryTransactionInput): unknown;
  recordAcceptedAction(input: TreasuryTransactionInput): unknown;
}

/** 持有 kernel 的运行时对象形态（treasury 协议栈内部 cast 用）。 */
export interface TreasuryKernelHolder {
  readonly [TREASURY_WRITER_KERNEL]: TreasuryWriterKernel;
}
