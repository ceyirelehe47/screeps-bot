/**
 * Treasury 事件驱动 exact 对账 oracle（测试专用，非 .test.ts）。
 *
 * Remediation IV/V1/§3：测试工具收敛为**许可直连执行包装**——
 * executeTreasuryAdmittedDispatch 接受 admitted/rearm 聚合结果，内部核对
 * 聚合 attempt 与实际 dispatch 许可一致，作用域身份与预期参数**均取自
 * 实际传给执行入口的那张许可对象**（permit.attemptId/permit.canonicalArgs），
 * 并由包装器自身把同一个许可对象交给生产执行入口。不再提供"独立指定
 * identity + 任意可执行 fn"的公共入口（旧 runWithInvocation 已删除）——
 * 同参数错身份在结构上不可表达；错误聚合/许可配对在执行前被明确拒绝。
 *
 * Remediation IV/V2/§4：断点分支标记携带**捕获来源 journal**（marker.source），
 * oracle adapter 暴露其事件来源（adapter.journal）——恢复入口
 * （performTreasuryFullReset）据此核实"所选断点的事件来源"与"恢复后
 * adapter 实际使用的 journal"一致，错配在对账前、在任何状态修改前拒绝。
 *
 * 事件模型（受控同步生效世界）：
 * - adapter-entered：动作调用进入 adapter（世界序 = 进入时刻受控世界序）；
 * - world-effect：adapter 同步写入世界成功（世界序已 +1）。
 *
 * 结论规则（对 attempt X，仅可见分支事件）：
 * - 可见 world-effect → executed；
 * - 无 world-effect 但可见 adapter-entered，且分支当前世界序未越过进入序
 *   → 本分支效果确定未发生（同步模型：效果必 bump 世界序）→ not_executed；
 * - 无任何事件：分支记录的调用边界序仍 ≥ 当前世界序（边界发布后世界未
 *   推进——调用未开始/未产生效果）→ not_executed（正面对照）；
 * - 其余（事件错关联/世界序已越过但无本 attempt 效果事件）→ still_uncertain。
 */

import {
  makeTreasuryTestTransferAdapter,
  type TreasuryActionAdapter,
  type TreasuryTestTransferArgs,
} from "@/runtime/treasury/actionContracts";
import { readTreasuryWorldSequence } from "@/runtime/treasury/observation";

export interface TreasuryHostJournalEntry {
  readonly attemptId: string;
  readonly kind: "adapter-entered" | "world-effect";
  readonly atTick: number;
  readonly worldSequence: number;
  /** 分支代号（从断点恢复重开分支时递增；祖先基础事件保留原代号）。 */
  readonly epoch: number;
}

interface JournalState {
  /** 本分支事件日志（祖先基础 + 本分支追加；恢复时整体替换为新基础）。 */
  entries: TreasuryHostJournalEntry[];
  /** 本分支祖先基础事件数（封闭视图：i < baseLength 属所选断点的祖先事实）。 */
  baseLength: number;
  /** 当前分支代号（每次从断点副本重开 +1）。 */
  epoch: number;
  /** 受控调用作用域栈（栈顶 = 当前正在执行的 attempt 身份；仅许可直连包装建立）。 */
  invocationStack: { attemptId: string; argsKey: string }[];
  /** 无作用域/参数不匹配的实际调用次数（诊断——不归属任何 attempt）。 */
  unlinkedCalls: number;
}

/**
 * 断点的事件分支标记（Remediation III/V1/§4.1–§4.2）：captureBranch 时
 * 保存本分支可见事件的不可变副本；断点对象携带本标记，加载器恢复该断点
 * 时调用 reopen() 从副本重开分支。副本不暴露内容——事件可见性只经
 * visibleFor（封闭视图）查询。
 * Remediation IV/V2：标记携带捕获来源 journal——恢复装配据此核实与
 * adapter 事件来源的关联（错配在对账前拒绝）。
 */
export interface TreasuryJournalBranchMarker {
  readonly kind: "treasury-journal-branch";
  /** 捕获时刻本分支可见事件数（断点 eventCut 与此一致）。 */
  readonly count: number;
  /** 捕获来源 journal（V2/§4.2：恢复入口与 adapter 事件来源关联核实）。 */
  readonly source: TreasuryHostJournal;
  /** 从捕获副本重开分支（harness 安装断点 Memory 后调用；可重复恢复同一断点）。 */
  reopen(): void;
}

export interface TreasuryHostJournal {
  /** 捕获一次分支断点标记（传给 captureTreasuryHostBreakpoint）。 */
  captureBranch(): TreasuryJournalBranchMarker;
  /** 只读视图（断言用：祖先基础 ∪ 本分支当前 epoch 的事件）。 */
  visibleFor(attemptId: string): readonly TreasuryHostJournalEntry[];
  /** 未能关联到任何 attempt 的实际调用次数（诊断口径）。 */
  readonly unlinkedCalls: number;
}

/**
 * 测试宿主的可控结果计划（V3/§5）：按实际调用序（1 起）编排执行结果，
 * 并可在产生 world-effect 的调用返回后、dispatch_result 写入前收到回调
 * （结果写回前断点的捕获点）。计划只控制测试执行结果与捕获时机——不
 * 参与事件归属、不向 reconciler 提供结论；调用与效果仍在真实边界记录。
 * 父子 canonical args 可保持完全相同（无需在 args 内编排 outcome 差异）。
 */
export interface TreasuryOracleHostPlan {
  /** 第 N 次实际调用的结果编排（缺省项沿用 args.outcome 原值）。 */
  readonly results?: readonly ("ok" | "non-ok" | "throw")[];
  /** 第 N 次调用产生 world-effect 后、返回前的回调（callIndex 从 1 起）。 */
  readonly afterWorldEffect?: (callIndex: number) => void;
}

const journalStates = new WeakMap<TreasuryHostJournal, JournalState>();

/** 稳定序列化（键序无关——kernel 以 canonical args 调用，键序可能与宿主构建对象不同）。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

function stateOf(journal: TreasuryHostJournal): JournalState {
  const state = journalStates.get(journal);
  if (state === undefined) throw new Error("journal 状态缺失");
  return state;
}

/**
 * 受控调用作用域的唯一建立点（模块内部实现，V1/§3.2）：作用域身份与
 * 预期参数**均取自实际 dispatch 许可对象**——不接收外部独立指定的
 * identity/args。异常路径 finally 弹栈不泄漏。
 */
function runWithPermitScope<T>(journal: TreasuryHostJournal, dispatch: object, fn: () => T): T {
  const state = stateOf(journal);
  const permit = dispatch as { attemptId?: unknown; canonicalArgs?: unknown };
  if (typeof permit.attemptId !== "string" || permit.attemptId.length === 0) {
    throw new Error("dispatch 许可缺少 attemptId——作用域身份不可信，拒绝建立调用作用域");
  }
  const frame = { attemptId: permit.attemptId, argsKey: stableStringify(permit.canonicalArgs) };
  state.invocationStack.push(frame);
  try {
    return fn();
  } finally {
    state.invocationStack.pop(); // 异常路径同样弹栈——不泄漏前一作用域
  }
}

/** 许可直连执行包装的聚合结果输入形状（admitted/rearm 返回值的公共面）。 */
export type TreasuryAdmittedForExecution = {
  readonly status: string;
  readonly attemptId?: unknown;
  readonly dispatch?: unknown;
};

/**
 * 端到端执行包装（V1/§3.2 唯一公共执行入口）：接受真实接纳/rearm 返回的
 * 聚合结果，核对其 attempt 与实际 dispatch 许可对象一致（不能只相信对象
 * 表面的 attemptId——不一致即明确拒绝且不建立作用域），随后在从**该许可**
 * 取得的作用域（attemptId + canonicalArgs）内由包装器自身调用生产执行入口。
 * 外部不能同时指定独立身份与任意可执行 fn；克隆/过期/旧运行时/已消费许可
 * 仍由原生产 preflight/终验拒绝（包装不赋予执行权）。
 */
export function executeTreasuryAdmittedDispatch(
  journal: TreasuryHostJournal,
  service: { executeAuthorizedDispatch(dispatch: unknown): unknown },
  admitted: TreasuryAdmittedForExecution,
): { status: string } & Record<string, unknown> {
  if (admitted === null || typeof admitted !== "object") {
    throw new Error("执行包装需要 admitted/rearm 返回的聚合结果对象");
  }
  if (admitted.status !== "admitted") {
    throw new Error(`只有 admitted 聚合结果可执行（收到 status=${String(admitted.status)}）`);
  }
  if (typeof admitted.attemptId !== "string" || admitted.attemptId.length === 0) {
    throw new Error("聚合结果缺少 attemptId（身份不可信——拒绝执行）");
  }
  const dispatch = admitted.dispatch;
  if (typeof dispatch !== "object" || dispatch === null) {
    throw new Error("聚合结果缺少 dispatch 许可对象——拒绝执行");
  }
  const permit = dispatch as { attemptId?: unknown };
  if (typeof permit.attemptId !== "string" || permit.attemptId.length === 0) {
    throw new Error("dispatch 许可缺少 attemptId（身份不可信——拒绝执行）");
  }
  if (permit.attemptId !== admitted.attemptId) {
    throw new Error(
      `聚合结果 attempt ${String(admitted.attemptId)} 与实际 dispatch 许可 ${permit.attemptId} 不一致（错误配对——拒绝执行，不建立作用域）`,
    );
  }
  const outcome = runWithPermitScope(journal, dispatch, () => service.executeAuthorizedDispatch(dispatch));
  if (outcome === null || typeof outcome !== "object" || typeof (outcome as { status?: unknown }).status !== "string") {
    throw new Error("生产执行入口返回了不可信的 outcome（缺少 status）");
  }
  return outcome as { status: string } & Record<string, unknown>;
}

export function createTreasuryHostJournal(): TreasuryHostJournal {
  const state: JournalState = { entries: [], baseLength: 0, epoch: 0, invocationStack: [], unlinkedCalls: 0 };
  const journal: TreasuryHostJournal = {
    captureBranch(): TreasuryJournalBranchMarker {
      // 不可变副本（冻结）：捕获后旧栈继续追加的事件不影响本副本；恢复
      // 同一断点多次时每次从同一副本开启（互不污染的独立分支）。
      const copy = Object.freeze(state.entries.slice()) as readonly TreasuryHostJournalEntry[];
      const marker: TreasuryJournalBranchMarker = {
        kind: "treasury-journal-branch",
        count: copy.length,
        source: journal,
        reopen(): void {
          state.entries = copy.slice(); // 脱离副本（新分支追加只影响自己）
          state.baseLength = copy.length;
          state.epoch += 1;
          state.invocationStack = []; // 旧执行栈不进入恢复分支
        },
      };
      return marker;
    },
    get unlinkedCalls(): number {
      return state.unlinkedCalls;
    },
    visibleFor(attemptId: string): readonly TreasuryHostJournalEntry[] {
      return state.entries.filter(
        (e, i) => e.attemptId === attemptId && (i < state.baseLength || e.epoch === state.epoch),
      );
    },
  };
  journalStates.set(journal, state);
  return journal;
}

export interface TreasuryExactOracleAdapter extends TreasuryActionAdapter {
  /** 宿主 trace（进入/效果计数独立于生产标签）。 */
  readonly trace: { entered: number; effects: number };
  /** 本 adapter 的事件来源 journal（V2/§4.2：恢复装配关联核实用）。 */
  readonly journal: TreasuryHostJournal;
}

/**
 * 事件驱动 exact oracle adapter（包装测试 transfer adapter；reconcile 结论
 * 从宿主事件/分支世界序推导——不是工厂固定值）。execute 的 attempt 关联
 * 只来自许可直连包装建立的受控调用作用域（V1）；无作用域/参数不匹配的
 * 调用计入宿主 trace 与 journal.unlinkedCalls，不归属任何 attempt。
 * 可选宿主结果计划（V3）只编排执行结果与捕获时机，不影响归属与结论。
 */
export function makeTreasuryExactOracleAdapter(
  journal: TreasuryHostJournal,
  plan?: TreasuryOracleHostPlan,
): TreasuryExactOracleAdapter {
  const base = makeTreasuryTestTransferAdapter("still_uncertain");
  const trace = { entered: 0, effects: 0 };
  const adapter = {
    ...base,
    trace,
    journal,
    execute(args: TreasuryTestTransferArgs): { ok: boolean } {
      const state = stateOf(journal);
      // 受控调用作用域（V1/§3.2）：栈顶身份 + 参数逐次核对；不扫描 active、
      // 不按 args 反查、不读 outcome 反推归属。
      const frame = state.invocationStack.length > 0 ? state.invocationStack[state.invocationStack.length - 1] : null;
      const argsKey = stableStringify(args);
      const attemptId = frame !== null && frame.argsKey === argsKey ? frame.attemptId : null;
      if (attemptId === null) state.unlinkedCalls += 1;
      if (attemptId !== null) {
        state.entries.push(Object.freeze({
          attemptId,
          kind: "adapter-entered",
          atTick: Game.time,
          worldSequence: readTreasuryWorldSequence(),
          epoch: state.epoch,
        }));
      }
      const callIndex = trace.entered + 1;
      trace.entered += 1;
      // 宿主结果计划（V3/§5）：按调用序编排本次结果；缺省沿用 args 原值。
      // 拷贝只作用于本次 base 执行（世界写入/返回值跟随计划）；canonical
      // args、durableFacts、retryFacts 仍由 kernel 按原冻结许可事实使用。
      const planned = plan?.results !== undefined ? plan.results[callIndex - 1] : undefined;
      const argsOutcome = (args as { outcome?: "ok" | "non-ok" | "throw" }).outcome;
      const effective =
        planned !== undefined && planned !== argsOutcome
          ? ({ ...args, outcome: planned } as TreasuryTestTransferArgs)
          : args;
      const result = base.execute(effective);
      if (result.ok) {
        trace.effects += 1; // 宿主效果计数独立于 attempt 关联是否成立
        if (attemptId !== null) {
          state.entries.push(Object.freeze({
            attemptId,
            kind: "world-effect",
            atTick: Game.time,
            worldSequence: readTreasuryWorldSequence(),
            epoch: state.epoch,
          }));
        }
        // 结果写回前捕获点（V3/§5）：world-effect 已入分支日志、生产
        // dispatch_result 尚未写入——此处捕获的断点恢复后经 exact 对账
        // 可证明 committed。
        plan?.afterWorldEffect?.(callIndex);
      }
      return result;
    },
    reconcile(
      facts: { transactionId: string },
      _observation: unknown,
    ): "observed_committed" | "observed_not_executed" | "still_uncertain" {
      const visible = journal.visibleFor(facts.transactionId);
      if (visible.some((e) => e.kind === "world-effect")) return "observed_committed";
      const branchSeq = readTreasuryWorldSequence();
      const entered = visible.find((e) => e.kind === "adapter-entered");
      if (entered !== undefined && branchSeq <= entered.worldSequence) {
        return "observed_not_executed"; // 已进入但本分支世界未推进——效果未发生
      }
      if (visible.length === 0) {
        // 无事件：读分支记录的调用边界序（先于结论的事实，不是 outcome）。
        const record = (Memory.runtime as unknown as {
          treasuryCore?: { active?: Record<string, { invocationBoundary?: { worldSequence?: number } | null }> };
        })?.treasuryCore?.active?.[facts.transactionId];
        const boundarySeq = record?.invocationBoundary?.worldSequence;
        if (typeof boundarySeq === "number" && branchSeq <= boundarySeq) {
          return "observed_not_executed"; // 边界发布后世界未推进——调用未产生效果
        }
      }
      return "still_uncertain"; // 缺证据/错关联：不盲猜
    },
  };
  return adapter as unknown as TreasuryExactOracleAdapter;
}
