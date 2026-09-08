/**
 * Terminal Transfer Engine Lab Prep I——single-shot 调用门禁（§4.3）。
 *
 * 最小安全边界：没有武装控制事实、模式不符、ID/路线/用户/shard/结构不符、
 * 目标 tick 错过、已经尝试、状态不健康或报价不可读/超预算时，零发送。
 * 只允许 Game.time === targetTick（不"到点以后一直重试"）。
 * 每个拒绝 reason 都是探针前置拒绝——不是"已实测游戏 API 的 ERR 返回"。
 */

import type { LabExperimentConfig } from "./labConfig";
import type { LabControlRecord } from "./controlRecord";
import { readEndpoint, readFeeQuote } from "./worldRead";

export type LabSendGateDecision =
  | {
      readonly decision: "reject";
      readonly reason: string;
    }
  | {
      readonly decision: "proceed";
      readonly sourceTerminal: StructureTerminal;
      readonly fee: number;
    };

function reject(reason: string): LabSendGateDecision {
  return { decision: "reject", reason };
}

/** 从世界取源 Terminal 实例（send 以成员调用发起——保持方法所属对象绑定）。 */
function resolveSourceTerminal(config: LabExperimentConfig): StructureTerminal | null {
  try {
    const rooms = (Game as unknown as { rooms?: Record<string, { terminal?: StructureTerminal | null }> }).rooms ?? {};
    const terminal = rooms[config.sourceRoomName]?.terminal;
    return terminal ?? null;
  } catch {
    return null;
  }
}

/**
 * 逐项门禁（顺序保守：控制事实 → 世界身份 → tick → 结构/资源/预算）。
 * 任何一步不满足即拒绝并给出明确 reason——调用方据此零发送。
 */
export function evaluateSingleShotGates(
  config: LabExperimentConfig,
  control: { readonly status: "absent" | "ok" | "corrupt"; readonly record?: LabControlRecord },
): LabSendGateDecision {
  if (config.mode !== "single-shot") return reject("mode_mismatch");
  if (control.status === "absent") return reject("no_control_record");
  if (control.status === "corrupt") return reject("control_record_corrupt");
  const record = control.record;
  if (record === undefined) return reject("control_record_corrupt");
  if (record.stopped === true) return reject("already_stopped");
  if (record.attempted === true) return reject("already_attempted");
  if (record.armed !== true) return reject("not_armed");
  if (record.experimentId !== config.experimentId) return reject("experiment_id_mismatch");

  let shardName: string;
  let tick: number;
  try {
    shardName = Game.shard.name;
    tick = Game.time;
  } catch {
    return reject("world_read_error");
  }
  if (shardName !== config.shardName) return reject("shard_mismatch");

  const source = readEndpoint(config, "source");
  const target = readEndpoint(config, "target");
  if (source.readStatus !== "ok") return reject("source_unhealthy");
  if (target.readStatus !== "ok") return reject("target_unhealthy");
  if (source.terminalId !== config.sourceTerminalId || target.terminalId !== config.targetTerminalId) {
    return reject("structure_mismatch");
  }
  if (source.ownerUsername !== config.username || target.ownerUsername !== config.username) {
    return reject("user_mismatch");
  }
  if (tick < config.targetTick) return reject("tick_not_reached");
  if (tick > config.targetTick) return reject("tick_missed");
  if ((source.cooldown ?? 0) > 0) return reject("cooldown_active");
  if ((source.resourceAmount ?? 0) < config.amount) return reject("insufficient_resource");
  const quote = readFeeQuote(config.amount, config.sourceRoomName, config.targetRoomName);
  if (quote.status !== "ok") return reject("fee_unreadable");
  const fee = quote.energyCost ?? 0;
  if (fee > config.maxFeeEnergy) return reject("fee_over_budget");
  if ((source.energy ?? 0) < fee) return reject("insufficient_resource");
  if ((target.freeCapacity ?? 0) < config.amount) return reject("target_capacity_insufficient");

  const sourceTerminal = resolveSourceTerminal(config);
  if (sourceTerminal === null) return reject("source_unhealthy");
  return { decision: "proceed", sourceTerminal, fee };
}
