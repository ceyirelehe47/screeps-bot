import { blockRoomExits } from "@/movement/matrixLayers";
import { searchMovementPath } from "@/movement/pathSearch";
import { resolveMoveProfile } from "@/movement/moveProfile";
import { buildRoomMovementMatrix, resolveMovementPolicy } from "@/movement/pathing";
import { isExitTile } from "@/movement/common";
import { recordMovementMetric } from "@/movement/metrics";
import { measureCreepPathing } from "@/runtime/cpuPhaseProfiler";
import type { MoveToTargetOptions } from "@/movement/types";
import { resolveTerrainCosts } from "@/movement/terrainCosts";

export interface ExitPathResult {
  path: RoomPosition[];
  complete: boolean;
  /** 只有静态、穷尽的搜索才能证明当前跳转无路。 */
  rejectTransition: boolean;
  reason: "complete" | "staticBlocked" | "policyDenied" | "budgetExhausted" | "dynamicBlocked" | "invalidPath";
}

/** 一次多目标搜索同时选择出口和房内路径；边界只能是最后一个目标格。 */
export function searchRoomExitPath(creep: Creep, direction: ExitConstant, options: MoveToTargetOptions): ExitPathResult {
  const roomName = creep.room.name;
  const policy = resolveMovementPolicy(creep, options);
  const matrix = buildRoomMovementMatrix(creep, creep.room, roomName, new PathFinder.CostMatrix(),
    { ...policy, avoidExitTiles: false }, creep.pos);
  const terrain = Game.map.getRoomTerrain(roomName);
  const goals: Array<{ pos: RoomPosition; range: number }> = [];
  // 先保存候选目标的真实成本，再封住所有边界；不依赖自定义 callback 是否尊重 avoidExitTiles。
  const costs: number[] = [];
  for (let index = 1; index < 49; index++) {
    const x = direction === LEFT ? 0 : direction === RIGHT ? 49 : index;
    const y = direction === TOP ? 0 : direction === BOTTOM ? 49 : index;
    const cost = matrix.get(x, y);
    if (cost < 255 && !(terrain.get(x, y) & TERRAIN_MASK_WALL)) {
      goals.push({ pos: new RoomPosition(x, y, roomName), range: 0 });
      costs.push(cost);
    }
  }
  blockRoomExits(matrix);
  goals.forEach((goal, index) => matrix.set(goal.pos.x, goal.pos.y, costs[index]));
  const failureReason = (budgetExhausted: boolean): ExitPathResult["reason"] => budgetExhausted ? "budgetExhausted" :
    policy.safeZone ? "policyDenied" : (policy.ignoreCreeps ?? true) ? "staticBlocked" : "dynamicBlocked";
  const blocked = (budgetExhausted: boolean, reason = failureReason(budgetExhausted)): ExitPathResult => {
    if (reason === "policyDenied") recordMovementMetric("exitPolicyDenied", roomName);
    return { path: [], complete: false, reason, rejectTransition: reason === "staticBlocked" };
  };
  if (!goals.length) {
    recordMovementMetric("exitNoGoals", roomName);
    recordMovementMetric("exitSelectFailures", roomName);
    return blocked(false);
  }
  const profile = resolveMoveProfile(policy);
  const found = measureCreepPathing(() => searchMovementPath(creep.pos, goals, {
    maxRooms: 1, maxOps: profile.maxOps, ...resolveTerrainCosts(policy),
    roomCallback: name => name === roomName ? matrix.clone() : false,
  }));
  recordMovementMetric("exitSearchOps", roomName, found.ops);
  const result = { found, budgetExhausted: found.reason === "budgetExhausted" };

  let previous = creep.pos;
  for (let index = 0; index < result.found.path.length; index++) {
    const step = result.found.path[index];
    if (step.roomName !== roomName || previous.getRangeTo(step) !== 1 || matrix.get(step.x, step.y) >= 255 ||
        (terrain.get(step.x, step.y) & TERRAIN_MASK_WALL) || (isExitTile(step) && index !== result.found.path.length - 1)) {
      recordMovementMetric("exitPathFailures", roomName);
      recordMovementMetric("exitInvalidPaths", roomName);
      return blocked(true, "invalidPath"); // 非法返回值不能作为物理无路证据。
    }
    previous = step;
  }
  const end = result.found.path[result.found.path.length - 1];
  if (result.found.incomplete && !result.budgetExhausted && (policy.ignoreCreeps ?? true)) {
    // 静态搜索已穷尽：非空 partial 只是距离出口最近的死胡同，不是可达证明。
    recordMovementMetric("exitSelectFailures", roomName);
    if (!policy.safeZone) recordMovementMetric("exitExhaustedStatic", roomName);
    return blocked(false);
  }
  const complete = !result.found.incomplete && !!end && goals.some(goal => goal.pos.isEqualTo(end));
  if (!complete && !result.found.incomplete) {
    recordMovementMetric("exitPathFailures", roomName);
    recordMovementMetric("exitInvalidPaths", roomName);
    return blocked(true, "invalidPath");
  }
  if (!end || (!complete && profile.completeness === "complete")) {
    recordMovementMetric("exitPathFailures", roomName);
    recordMovementMetric("exitIncompleteRejected", roomName);
    return blocked(result.budgetExhausted);
  }
  // 保留半截路径的有效进展；局部终点仅用于本次执行，不能缓存为出口。
  if (!complete) recordMovementMetric("exitPartialPaths", roomName);
  return { path: result.found.path, complete, rejectTransition: false, reason: complete ? "complete" : failureReason(result.budgetExhausted) };
}
