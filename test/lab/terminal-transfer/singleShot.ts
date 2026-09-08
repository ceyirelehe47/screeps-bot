/**
 * Terminal Transfer Engine Lab Prep I——single-shot（仅供未来单独授权的
 * 隔离实验使用，§4.1/§4.3）。
 *
 * 默认未武装：只有完整实验配置与一次性实验控制事实（Memory 控制记录）
 * 同时匹配，才在指定 tick 尝试**一次** 100H 发送。调用前先标记已尝试；
 * 任何失败（含同步非 OK/抛错）不自动重试。OK 只表示请求已调度——本产物
 * 不在 API 返回时改两端库存、不创建交易记录、不宣告"世界已经完成"。
 *
 * PREPARED_NOT_RUN：本产物只构建与离线自测（假端口 spy），未在真实引擎
 * 上运行，也未连接任何真实世界。
 */

import { LAB_EXAMPLE_EXPERIMENT, type LabExperimentConfig } from "./labConfig";
import { buildSample } from "./sample";
import { readControlRecord, writeControlRecord } from "./controlRecord";
import { evaluateSingleShotGates } from "./sendGate";

/** 调用版配置：同一实验身份（ID/路线/双方/tick/预算），模式为 single-shot。 */
const SINGLE_SHOT_CONFIG: LabExperimentConfig = { ...LAB_EXAMPLE_EXPERIMENT, mode: "single-shot" };

function readTick(): number | null {
  try {
    return Game.time;
  } catch {
    return null; // Game 缺失——如实记录，不猜 0
  }
}

/** Screeps 装载入口：每 tick 评估门禁；仅目标 tick 且全部匹配时恰一次调用。 */
export function loop(): void {
  const config = SINGLE_SHOT_CONFIG;
  try {
    const control = readControlRecord();
    const tick = readTick();
    const gate = evaluateSingleShotGates(config, control);
    if (gate.decision === "reject") {
      console.log(
        JSON.stringify({
          kind: "lab-precondition-rejection",
          experimentId: config.experimentId,
          mode: "single-shot",
          tick,
          reason: gate.reason,
          note: "探针前置拒绝——不是已实测游戏 API 的 ERR 返回",
        }),
      );
      return;
    }
    // 判别联合收窄：gate 通过必然 status==="ok"（absent/corrupt 已被前置拒绝）。
    const record = control.status === "ok" ? control.record : undefined;
    if (record === undefined) return;
    // 调用前采样 + 先标记已尝试（写 Memory 在 send 之前——此后任何路径零重试）。
    const preCall = buildSample(config);
    writeControlRecord({ ...record, attempted: true, attemptedTick: tick ?? config.targetTick });
    console.log(
      JSON.stringify({
        kind: "lab-send-attempt",
        phase: "pre-call",
        experimentId: config.experimentId,
        tick,
        fee: gate.fee,
        sample: preCall,
      }),
    );
    console.log(JSON.stringify({ kind: "lab-send-attempt", phase: "boundary", experimentId: config.experimentId, tick }));
    // 单次调用：保持方法所属对象绑定（sourceTerminal.send 成员调用）。
    // ScreepsReturnCode：OK === 0（同步返回 0 只表示请求已调度）。
    let syncResult: { readonly ok: boolean; readonly code?: number; readonly error?: string };
    try {
      const code = gate.sourceTerminal.send(
        config.resourceType,
        config.amount,
        config.targetRoomName,
        config.description,
      );
      syncResult = { ok: code === 0, code };
    } catch (error) {
      syncResult = { ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    }
    // 正常完成即标记停止（不自动再次武装）；attempted 保持 true。
    writeControlRecord({
      ...record,
      attempted: true,
      attemptedTick: tick ?? config.targetTick,
      syncResult,
      stopped: true,
    });
    console.log(
      JSON.stringify({
        kind: "lab-send-attempt",
        phase: syncResult.error !== undefined ? "sync-throw" : "sync-return",
        experimentId: config.experimentId,
        tick,
        result: syncResult,
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        kind: "lab-single-shot-error",
        experimentId: config.experimentId,
        mode: "single-shot",
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }),
    );
  }
}
