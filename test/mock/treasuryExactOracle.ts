/**
 * Treasury 事件驱动 exact 对账 oracle（测试专用，非 .test.ts）。
 *
 * Remediation III/V1/§4：断点保存捕获时刻**本分支可见事件的不可变副本**；
 * 恢复由加载器（performTreasuryFullReset/performTreasuryKernelFullReset
 * 消费所选断点）调用 marker.reopen() 从该副本开启独立分支。不再存在可变
 * 的“最近一次 recordCut 截断”——废弃分支（较早断点之后旧栈继续产生的）
 * 事件不会在恢复较早断点后重新可见；每个分支只看到自己的祖先链事件。
 *
 * Remediation III/V2/§5：attempt 身份不再从 args 反查（同参数多 attempt
 * 的登记在单值 Map 下互相覆盖）。execute 入口读取**受控调用作用域**——
 * 由测试驱动以真实接纳/rearm 返回的许可身份经 runWithInvocation 建立；
 * adapter 对实际收到的参数逐次核对，无作用域或参数不匹配时不归属任何
 * attempt（unlinkedCalls 诊断），也不读取返回对象的属性。
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
  /** 受控调用作用域栈（栈顶 = 当前正在执行的 attempt 身份；V2）。 */
  invocationStack: { attemptId: string; argsKey: string }[];
  /** 无作用域/参数不匹配的实际调用次数（诊断——不归属任何 attempt）。 */
  unlinkedCalls: number;
}

/**
 * 断点的事件分支标记（Remediation III/V1/§4.1–§4.2）：captureBranch 时
 * 保存本分支可见事件的不可变副本；断点对象携带本标记，加载器恢复该断点
 * 时调用 reopen() 从副本重开分支。副本不暴露内容——事件可见性只经
 * visibleFor（封闭视图）查询。
 */
export interface TreasuryJournalBranchMarker {
  readonly kind: "treasury-journal-branch";
  /** 捕获时刻本分支可见事件数（断点 eventCut 与此一致）。 */
  readonly count: number;
  /** 从捕获副本重开分支（harness 安装断点 Memory 后调用；可重复恢复同一断点）。 */
  reopen(): void;
}

export interface TreasuryHostJournal {
  /**
   * 受控调用作用域（V2/§5.2）：以真实接纳/rearm 返回的许可身份执行 fn；
   * fn 内 adapter 的真实执行入口据此关联本次 attempt。参数逐次核对——
   * 作用域不匹配时不归属（不猜测 attempt）；异常路径 finally 弹栈不泄漏。
   */
  runWithInvocation<T>(identity: { attemptId: string }, expectedArgs: unknown, fn: () => T): T;
  /** 捕获一次分支断点标记（传给 captureTreasuryHostBreakpoint）。 */
  captureBranch(): TreasuryJournalBranchMarker;
  /** 只读视图（断言用：祖先基础 ∪ 本分支当前 epoch 的事件）。 */
  visibleFor(attemptId: string): readonly TreasuryHostJournalEntry[];
  /** 未能关联到任何 attempt 的实际调用次数（G14 诊断口径）。 */
  readonly unlinkedCalls: number;
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

export function createTreasuryHostJournal(): TreasuryHostJournal {
  const state: JournalState = { entries: [], baseLength: 0, epoch: 0, invocationStack: [], unlinkedCalls: 0 };
  const journal: TreasuryHostJournal = {
    runWithInvocation<T>(identity: { attemptId: string }, expectedArgs: unknown, fn: () => T): T {
      const frame = { attemptId: identity.attemptId, argsKey: stableStringify(expectedArgs) };
      state.invocationStack.push(frame);
      try {
        return fn();
      } finally {
        state.invocationStack.pop(); // 异常路径同样弹栈——不泄漏前一作用域
      }
    },
    captureBranch(): TreasuryJournalBranchMarker {
      // 不可变副本（冻结）：捕获后旧栈继续追加的事件不影响本副本；恢复
      // 同一断点多次时每次从同一副本开启（互不污染的独立分支）。
      const copy = Object.freeze(state.entries.slice()) as readonly TreasuryHostJournalEntry[];
      return {
        kind: "treasury-journal-branch",
        count: copy.length,
        reopen(): void {
          state.entries = copy.slice(); // 脱离副本（新分支追加只影响自己）
          state.baseLength = copy.length;
          state.epoch += 1;
          state.invocationStack = []; // 旧执行栈不进入恢复分支（§5.2）
        },
      };
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
}

/**
 * 事件驱动 exact oracle adapter（包装测试 transfer adapter；reconcile 结论
 * 从宿主事件/分支世界序推导——不是工厂固定值）。execute 的 attempt 关联
 * 只来自受控调用作用域（V2）；无作用域/参数不匹配的调用计入宿主 trace
 * 与 journal.unlinkedCalls，不归属任何 attempt。
 */
export function makeTreasuryExactOracleAdapter(journal: TreasuryHostJournal): TreasuryExactOracleAdapter {
  const base = makeTreasuryTestTransferAdapter("still_uncertain");
  const trace = { entered: 0, effects: 0 };
  const adapter = {
    ...base,
    trace,
    execute(args: TreasuryTestTransferArgs): { ok: boolean } {
      const state = stateOf(journal);
      // 受控调用作用域（V2/§5.2）：栈顶身份 + 参数逐次核对；不扫描 active、
      // 不按 args 反查、不读 outcome 反推归属。
      const frame = state.invocationStack.length > 0 ? state.invocationStack[state.invocationStack.length - 1] : null;
      const argsKey = stableStringify(args);
      const attemptId = frame !== null && frame.argsKey === argsKey ? frame.attemptId : null;
      if (attemptId === null) state.unlinkedCalls += 1;
      if (attemptId !== null) {
        state.entries.push({
          attemptId,
          kind: "adapter-entered",
          atTick: Game.time,
          worldSequence: readTreasuryWorldSequence(),
          epoch: state.epoch,
        });
      }
      trace.entered += 1;
      const result = base.execute(args);
      if (result.ok) {
        trace.effects += 1; // 宿主效果计数独立于 attempt 关联是否成立
        if (attemptId !== null) {
          state.entries.push({
            attemptId,
            kind: "world-effect",
            atTick: Game.time,
            worldSequence: readTreasuryWorldSequence(),
            epoch: state.epoch,
          });
        }
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
