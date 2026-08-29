/**
 * ResourceTransferTask 健康/需求覆盖谓词（canonical）。
 *
 * 从 resourceTransferTasks.ts 上提为独立模块：这些判定是跨模块契约
 * （Hub/Synthesis/ResourceControl/Treasury 共用），必须保持单一实现。
 * 运行时依赖仅 configNormalize 与 Memory.cfg 直读——不得引入
 * runtimeServices/logistics 执行层依赖，避免 Treasury 服务挂载链路成环。
 * resourceTransferTasks.ts 对本模块 re-export，既有 import 路径不变。
 */

import { normalizeNumber } from "@/runtime/configNormalize";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";

export interface ResourceTransferTaskHealthOptions {
  automaticTaskNoProgressTtl: number;
  sourceDepletedGraceTicks: number;
  receiverCapacityDemandCoverageGraceTicks: number;
}

type ResourceTransferTaskHealthConfig = {
  automaticTaskNoProgressTtl?: number;
  sourceDepletedGraceTicks?: number;
  receiverCapacityDemandCoverageGraceTicks?: number;
};

export type ResourceTransferTaskDemandCoverageExpirationReason =
  | "automatic_no_progress_timeout"
  | "automatic_source_depleted_timeout"
  | "automatic_receiver_capacity_coverage_timeout";

export const DEFAULT_AUTOMATIC_TASK_NO_PROGRESS_TTL = 5_000;
export const DEFAULT_SOURCE_DEPLETED_GRACE_TICKS = 100;
export const DEFAULT_RECEIVER_CAPACITY_DEMAND_COVERAGE_GRACE_TICKS = 500;

export function resolveResourceTransferTaskHealthOptions(): ResourceTransferTaskHealthOptions {
  // Memory root declarations are intentionally frozen by the declaration
  // boundary test. Keep the backward-compatible optional rollout field local
  // to this adapter instead of widening the canonical root schema.
  const raw = Memory.cfg?.resourceControl?.capacityBalancing as
    | ResourceTransferTaskHealthConfig
    | undefined;
  return {
    automaticTaskNoProgressTtl: normalizeNumber(
      raw?.automaticTaskNoProgressTtl,
      DEFAULT_AUTOMATIC_TASK_NO_PROGRESS_TTL,
      100,
      100_000,
    ),
    sourceDepletedGraceTicks: normalizeNumber(
      raw?.sourceDepletedGraceTicks,
      DEFAULT_SOURCE_DEPLETED_GRACE_TICKS,
      1,
      5_000,
    ),
    receiverCapacityDemandCoverageGraceTicks: normalizeNumber(
      raw?.receiverCapacityDemandCoverageGraceTicks,
      DEFAULT_RECEIVER_CAPACITY_DEMAND_COVERAGE_GRACE_TICKS,
      50,
      5_000,
    ),
  };
}

export function isHealthyResourceTransferTaskReservation(
  task: ResourceTransferTask,
  direction: "incoming" | "outgoing" = "incoming",
  sourceDepletedGraceTicks = resolveResourceTransferTaskHealthOptions().sourceDepletedGraceTicks,
): boolean {
  if (task.status !== "pending") {
    return false;
  }
  if (direction === "outgoing" || task.blockedReason !== "source_depleted") {
    return true;
  }
  if (!Number.isFinite(task.blockedSince)) {
    return true;
  }

  return Game.time - task.blockedSince! < sourceDepletedGraceTicks;
}

/**
 * Returns the automatic lifecycle reason that makes a pending task stop
 * covering demand. The helper is mutation-free so Hub/Synthesis planning can
 * use it before this tick's ResourceControl reconciliation phase.
 */
export function getResourceTransferTaskDemandCoverageExpirationReason(
  task: ResourceTransferTask,
  options: ResourceTransferTaskHealthOptions = resolveResourceTransferTaskHealthOptions(),
): ResourceTransferTaskDemandCoverageExpirationReason | null {
  if (task.status !== "pending" || task.origin !== "automatic") {
    return null;
  }

  if (
    task.blockedReason === "source_depleted" &&
    Number.isFinite(task.blockedSince) &&
    Game.time - task.blockedSince! >= options.sourceDepletedGraceTicks
  ) {
    return "automatic_source_depleted_timeout";
  }

  if (
    task.blockedReason === "receiver_capacity" &&
    Number.isFinite(task.blockedSince) &&
    Game.time - task.blockedSince! >= options.receiverCapacityDemandCoverageGraceTicks
  ) {
    return "automatic_receiver_capacity_coverage_timeout";
  }

  if (
    Number.isFinite(task.lastProgressAt) &&
    Game.time - task.lastProgressAt > options.automaticTaskNoProgressTtl
  ) {
    return "automatic_no_progress_timeout";
  }

  return null;
}

/**
 * Canonical production-demand coverage predicate. Manual pending tasks always
 * retain operator intent; automatic tasks stop covering demand as soon as a
 * configured lifecycle limit is reached.
 */
export function countsResourceTransferTaskTowardDemand(
  task: ResourceTransferTask,
  options: ResourceTransferTaskHealthOptions = resolveResourceTransferTaskHealthOptions(),
): boolean {
  if (task.status !== "pending") {
    return false;
  }
  if (task.origin === "manual") {
    return true;
  }

  return getResourceTransferTaskDemandCoverageExpirationReason(task, options) === null;
}

export function isHealthyReceiverCapacityCommitment(
  task: ResourceTransferTask,
  automaticTaskNoProgressTtl?: number,
): boolean {
  if (task.status !== "pending") {
    return false;
  }
  if (task.blockedReason === "receiver_capacity" || task.blockedReason === "source_depleted") {
    return false;
  }
  if (task.origin !== "automatic") {
    return true;
  }

  const noProgressTtl = automaticTaskNoProgressTtl
    ?? resolveResourceTransferTaskHealthOptions().automaticTaskNoProgressTtl;
  return Game.time - task.lastProgressAt <= noProgressTtl;
}
