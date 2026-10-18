import { recordMovementMetric } from "@/movement/metrics";

export const MAX_TICK_PATH_SEARCH_OPS = 160000;
export const MAX_TICK_PLANNING_SEARCH_OPS = 80000;
export type PathSearchResult = PathFinderPath & {
  readonly reason: "complete" | "searchExhausted" | "budgetExhausted";
  readonly allocatedOps: number;
  readonly globalBudgetLimited: boolean;
};
let frame: { tick: number; game: typeof Game; spent: number; planningSpent: number } | undefined;
function record(name: "pathBudgetDenied" | "pathSearchOps", roomName: string, count = 1): void {
  try { recordMovementMetric(name, roomName, count); } catch { /* 诊断设施故障不改变搜索结果。 */ }
}

/** 所有移动搜索共用同一内核与 ops 账本；耗尽预算不作为静态无路的证据。 */
export function searchMovementPath(origin: RoomPosition, goals: Parameters<PathFinder["search"]>[1],
  options: PathFinderOpts, purpose: "execution" | "planning" = "execution"): PathSearchResult {
  if (!frame || frame.tick !== Game.time || frame.game !== Game) frame = { tick: Game.time, game: Game, spent: 0, planningSpent: 0 };
  const requested = Math.max(1, Math.min(32000, Math.floor(Number.isFinite(options.maxOps) ? options.maxOps! : 8000)));
  // 规划阶段不能耗尽全局额度；保留一半给稍后 creepWork 的实际移动。
  const allocatedOps = Math.min(requested, Math.max(0, MAX_TICK_PATH_SEARCH_OPS - frame.spent),
    purpose === "planning" ? Math.max(0, MAX_TICK_PLANNING_SEARCH_OPS - frame.planningSpent) : Infinity);
  if (!allocatedOps) {
    record("pathBudgetDenied", origin.roomName);
    return { path: [], cost: 0, ops: 0, incomplete: true, reason: "budgetExhausted", allocatedOps, globalBudgetLimited: true };
  }
  // 先预留；异常或 callback 嵌套搜索也不能透支尚未结算的额度。
  frame.spent += allocatedOps;
  if (purpose === "planning") frame.planningSpent += allocatedOps;
  const result = PathFinder.search(origin, goals, { ...options, maxOps: allocatedOps });
  const metric = (name: "ops" | "cost"): number | undefined => {
    try { const value = result[name]; return Number.isFinite(value) ? Math.max(0, value) : undefined; } catch { return undefined; }
  };
  const observedOps = metric("ops");
  // 异常诊断字段不改变本次业务结果，但按已分配上限收费，防止绕过总预算。
  const spent = Math.min(allocatedOps, observedOps ?? allocatedOps);
  frame.spent -= allocatedOps - spent;
  if (purpose === "planning") frame.planningSpent -= allocatedOps - spent;
  record("pathSearchOps", origin.roomName, observedOps ?? 0);
  const reason = !result.incomplete ? "complete" : spent >= allocatedOps ? "budgetExhausted" : "searchExhausted";
  if (reason === "budgetExhausted") record("pathBudgetDenied", origin.roomName);
  return { path: result.path, incomplete: result.incomplete, ops: observedOps ?? 0, cost: metric("cost") ?? 0,
    reason, allocatedOps, globalBudgetLimited: allocatedOps < requested };
}

export function resetPathSearchBudgetForTest(): void { frame = undefined; }

export function searchPlanningPath(origin: RoomPosition, goals: Parameters<PathFinder["search"]>[1], options: PathFinderOpts): PathSearchResult {
  return searchMovementPath(origin, goals, options, "planning");
}
