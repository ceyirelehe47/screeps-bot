/**
 * Treasury 事件驱动 exact 对账 oracle（测试专用，非 .test.ts）。
 *
 * Remediation II/V1/§6.2：恢复分支的 exact 结论从**本分支的受控宿主事件**
 * 得出，不从固定返回值得出，也不读生产 outcome 再复述。
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
 *
 * 分支事件可见性：捕获断点时 recordJournalCut 记录截断（断点后旧栈继续
 * 产生的事件不得混入恢复分支）；恢复分支开始时宿主调用 startBranch()，
 * 此后新产生的事件属于恢复分支。oracle 只看
 * （截断之前的旧事件）∪（当前分支 epoch 的事件）。
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
  /** 分支代号（startBranch 递增；断点前旧栈 = 当时代号）。 */
  readonly epoch: number;
}

interface JournalState {
  entries: TreasuryHostJournalEntry[];
  argsMap: Map<string, string>;
  cut: number;
  epoch: number;
}

export interface TreasuryHostJournal {
  /** 事件日志（传给 captureTreasuryHostBreakpoint 以记录截断长度）。 */
  readonly entries: readonly TreasuryHostJournalEntry[];
  /** args JSON → attemptId（宿主 admit 时登记——execute 侧据此关联）。 */
  registerAttempt(args: unknown, attemptId: string): void;
  /** 恢复分支开始：新事件计入新 epoch，旧栈断点后事件被排除。 */
  startBranch(): void;
  /** 捕获断点时调用：记录事件截断。 */
  recordCut(): void;
  /** 当前分支代号。 */
  readonly epoch: number;
  /** 只读视图（断言用）。 */
  visibleFor(attemptId: string): readonly TreasuryHostJournalEntry[];
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
  const state: JournalState = { entries: [], argsMap: new Map(), cut: Number.MAX_SAFE_INTEGER, epoch: 0 };
  const journal: TreasuryHostJournal = {
    entries: state.entries,
    registerAttempt(args: unknown, attemptId: string): void {
      state.argsMap.set(stableStringify(args), attemptId);
    },
    startBranch(): void {
      state.epoch += 1;
    },
    recordCut(): void {
      state.cut = state.entries.length;
    },
    get epoch(): number {
      return state.epoch;
    },
    visibleFor(attemptId: string): readonly TreasuryHostJournalEntry[] {
      return state.entries.filter(
        (e, i) => e.attemptId === attemptId && (i < state.cut || e.epoch === state.epoch),
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
 * 从宿主事件/分支世界序推导——不是工厂固定值）。
 */
export function makeTreasuryExactOracleAdapter(journal: TreasuryHostJournal): TreasuryExactOracleAdapter {
  const base = makeTreasuryTestTransferAdapter("still_uncertain");
  const trace = { entered: 0, effects: 0 };
  const adapter = {
    ...base,
    trace,
    execute(args: TreasuryTestTransferArgs): { ok: boolean } {
      const state = stateOf(journal);
      const attemptId = state.argsMap.get(stableStringify(args)) ?? null;
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
