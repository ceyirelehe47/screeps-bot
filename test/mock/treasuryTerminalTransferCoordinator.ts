/**
 * Terminal Transfer Slice 0 · Remediation I——测试专用业务协调入口
 * （任务书 §5；非 .test.ts，不进 Jest 收集，不进入生产 bundle）。
 *
 * 统一"准备/接纳/执行"三步，维持本原型的**单条在途**限制（R2/N03）：
 * 只要 kernel journal 只读视图的 active 中仍有 slice0.terminal-send 的
 * 未结束记录（pending/dispatching/outcome_unknown/closing/retry_ready——
 * closed 不落盘），就拒绝另一笔请求——不以 workKey 相同为前提。复用
 * facade 与 kernel，不复制通用授权引擎，不改 kernel 的多 workKey 语义。
 *
 * 边界（§5"明确入口边界"）：单条在途是本原型业务入口的规则，不是通用
 * facade 天然具备的全局规则——所有声称验证该业务的正向/集成用例都从本
 * 入口进入；仅用于隔离低层行为的测试可直接使用 facade，并注明不承担业
 * 务门禁证明。协调器实例自身无内部可变状态（门禁每次从持久 active 读
 * 出——跨实例/跨完整 reset 成立）；不使用 heap boolean、不新增持久锁、
 * 队列或第二个活动索引。
 *
 * 费用（§6.2）：执行前以当前可信报价复验 canonical 冻结 q（与 adapter
 * execute 内的 guard 共享 verifySlice0FeeQuote 纯比较逻辑）；不一致时在
 * 调用 executeAuthorizedDispatch **之前**拒绝——许可未消费、记录仍
 * pending，恢复报价后按原有效期执行。
 */

import type { TreasuryService } from "@/runtime/treasury/facade";
import {
  SLICE0_ACTION_KIND,
  prepareSlice0TransferArgs,
  verifySlice0FeeQuote,
  type TerminalTransferArgs,
  type TerminalTransferFakeHost,
} from "@mock/treasuryTerminalTransferPrototype";

/** 本原型固定业务路线（§2：指定源 W1N57 与目标 W10N57——C/D 房间只作反例噪声）。 */
const DEFAULT_SOURCE_ROOM = "W1N57";
const DEFAULT_TARGET_ROOM = "W10N57";

export interface Slice0TransferCoordinatorDeps {
  readonly service: TreasuryService;
  readonly host: TerminalTransferFakeHost;
  /**
   * contract 构建入口（注入以便完整 reset 后换绑新模块——旧模块构建的
   * contract 会被新 service 拒绝；恢复方由测试传入新模块的
   * buildTreasuryActionContract）。
   */
  readonly buildContract: (args: unknown, workKey: string) => { status: string; contract?: unknown; reason?: string };
}

export interface Slice0TransferRequestInput {
  readonly workKey: string;
  readonly correlationKey: string;
  readonly sourceRoomName?: string;
  readonly targetRoomName?: string;
}

export type Slice0TransferAdmission =
  | {
      readonly status: "admitted";
      readonly workKey: string;
      readonly attemptId: string;
      readonly quote: number;
      readonly args: TerminalTransferArgs;
      readonly dispatch: object;
    }
  | { readonly status: "rejected"; readonly stage: "single-flight" | "prepare" | "admit"; readonly reason: string };

export type Slice0TransferExecution =
  | { readonly status: "unknown"; readonly attemptId: string }
  | {
      readonly status: "rejected";
      readonly stage: "single-flight" | "precheck" | "dispatch";
      readonly reason: string;
      readonly attemptId?: string;
    };

export interface Slice0TransferCoordinator {
  /** 准备（可信报价/基线一次取值）→ 构建 → 授权；接纳前检查单条在途。 */
  requestTransfer(input: Slice0TransferRequestInput): Slice0TransferAdmission;
  /** 业务前检（单条在途 + 冻结费用复验）→ 执行；前检拒绝时许可未消费。 */
  executeTransfer(admission: Slice0TransferAdmission): Slice0TransferExecution;
}

export function createSlice0TransferCoordinator(deps: Slice0TransferCoordinatorDeps): Slice0TransferCoordinator {
  /**
   * 单条在途检查：从 service.kernelJournal()（持久 active 的深冻结快照）
   * 读出本原型动作的未结束记录。健康性不可确认时 fail-closed——不把不
   * 健康视图返回的空 active 当作"没有在途工作"。
   */
  function singleFlightGate(excludeAttemptId?: string): { ok: true } | { ok: false; reason: string } {
    let journal: ReturnType<TreasuryService["kernelJournal"]>;
    try {
      journal = deps.service.kernelJournal();
    } catch (error) {
      return { ok: false, reason: `单条在途检查失败（kernelJournal 不可读，fail-closed）：${String((error as Error).message).slice(0, 96)}` };
    }
    // absent = kernel store 尚未初始化（场景内确实没有任何工作——首笔
    // admit 才惰性建 store），是真实空态；unhealthy/incompatible 才是
    // "不健康视图"——fail-closed，不把其返回的空 active 当作没有在途工作。
    if (journal.health.status === "unhealthy" || journal.health.status === "incompatible") {
      const why = journal.health.reason === null ? "" : `：${journal.health.reason}`;
      return { ok: false, reason: `单条在途检查失败（kernel journal health=${journal.health.status}${why}，fail-closed）` };
    }
    const busy = journal.active.filter(
      (record) => record.identity.actionKind === SLICE0_ACTION_KIND && record.attemptId !== excludeAttemptId,
    );
    if (busy.length > 0) {
      const holders = busy.map((record) => `${record.attemptId} phase=${record.phase}`).join("、");
      return { ok: false, reason: `单条在途限制：本原型调拨已有活跃工作未结束（${holders}）——不同 workKey 也不得并行` };
    }
    return { ok: true };
  }

  return {
    requestTransfer(input: Slice0TransferRequestInput): Slice0TransferAdmission {
      // 检查与接纳顺序调用，中间不插入外部回调（§5）。
      const gate = singleFlightGate();
      if (gate.ok !== true) return { status: "rejected", stage: "single-flight", reason: gate.reason };
      let args: TerminalTransferArgs;
      try {
        args = prepareSlice0TransferArgs(
          deps.host,
          input.sourceRoomName ?? DEFAULT_SOURCE_ROOM,
          input.targetRoomName ?? DEFAULT_TARGET_ROOM,
          input.correlationKey,
        );
      } catch (error) {
        return { status: "rejected", stage: "prepare", reason: `准备失败（可信报价/基线读取异常）：${String((error as Error).message).slice(0, 96)}` };
      }
      const built = deps.buildContract(args, input.workKey);
      if (built.status !== "built") {
        return { status: "rejected", stage: "admit", reason: `contract 构建拒绝（${built.status}${built.reason === undefined ? "" : `：${built.reason}`}）` };
      }
      const admission = deps.service.authorizeTreasuryActionContract(built.contract as never, { workKey: input.workKey }) as {
        status: string;
        attemptId?: string;
        dispatch?: object;
        reason?: string;
      };
      if (admission.status !== "admitted" || admission.dispatch === undefined || admission.attemptId === undefined) {
        return { status: "rejected", stage: "admit", reason: `授权拒绝（${String(admission.status)}${admission.reason === undefined ? "" : `：${admission.reason}`}）` };
      }
      // 接纳成功后的 active 记录本身维持单条在途限制（后续检查从持久事实读出）。
      return {
        status: "admitted",
        workKey: input.workKey,
        attemptId: admission.attemptId,
        quote: args.prepared.feeQuote,
        args,
        dispatch: admission.dispatch,
      };
    },

    executeTransfer(admission: Slice0TransferAdmission): Slice0TransferExecution {
      if (admission.status !== "admitted") {
        return { status: "rejected", stage: "precheck", reason: "未获接纳的请求不可执行" };
      }
      const gate = singleFlightGate(admission.attemptId);
      if (gate.ok !== true) return { status: "rejected", stage: "single-flight", reason: gate.reason, attemptId: admission.attemptId };
      const feeCheck = verifySlice0FeeQuote(deps.host, admission.args);
      if (feeCheck.ok !== true) {
        return {
          status: "rejected",
          stage: "precheck",
          reason: `冻结费用与当前可信报价不一致（${feeCheck.code}）——许可未消费，记录保持 pending`,
          attemptId: admission.attemptId,
        };
      }
      const outcome = deps.service.executeAuthorizedDispatch(admission.dispatch as never);
      if (outcome.status === "unknown") return { status: "unknown", attemptId: admission.attemptId };
      return {
        status: "rejected",
        stage: "dispatch",
        reason: `执行结果非 unknown（${String(outcome.status)}）`,
        attemptId: admission.attemptId,
      };
    },
  };
}
