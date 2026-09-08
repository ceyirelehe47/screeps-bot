/**
 * Terminal Transfer Engine Lab Prep I——single-shot（仅供未来单独授权的
 * 隔离实验使用，§4.1/§4.3）。
 *
 * 默认未武装：只有完整实验配置与一次性实验控制事实（Memory 控制记录）
 * 同时匹配，才在指定 tick 尝试**一次** 100H 发送。Remediation I（Q02）起
 * 发送以"匹配的已尝试事实"为前提：先构造 attempted 更新值并写入控制槽，
 * 再**重新读取该槽**核对实验 ID/tick/attempted 成立——只有读回确认匹配才
 * 进入实际 send 调用边界；任何标记失败（序列化失败/超限/赋值异常/静默
 * 丢写/读回异常或不匹配）零发送、零重试，也不打印 boundary/sync-return。
 *
 * send 之后的同步返回与结果写回是两件事：结果记录失败不回滚或覆盖已确认的
 * attempted（不再次发送），也不谎报 stopped 已保存。OK 只表示请求已调度——
 * 本产物不在 API 返回时改两端库存、不创建交易记录、不宣告"世界已经完成"。
 *
 * PREPARED_NOT_RUN：本产物只构建与离线自测（假端口 spy），未在真实引擎
 * 上运行，也未连接任何真实世界。
 */

import { LAB_EXAMPLE_EXPERIMENT, type LabExperimentConfig } from "./labConfig";
import { buildSample } from "./sample";
import { confirmAttemptedMark, readControlRecord, writeControlRecord } from "./controlRecord";
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

/** 标记未确认（发送前失败）：指向探针自身的标记失败，不是游戏 API 的拒绝。 */
function logMarkUnconfirmed(
  config: LabExperimentConfig,
  tick: number | null,
  stage: "mark_write" | "mark_readback",
  reason: string,
): void {
  console.log(
    JSON.stringify({
      kind: "lab-mark-unconfirmed",
      experimentId: config.experimentId,
      mode: "single-shot",
      tick,
      stage,
      reason,
      note: "探针标记未确认——尚未进入实际发送边界，零 send",
    }),
  );
}

/** Screeps 装载入口：每 tick 评估门禁；标记确认后仅目标 tick 恰一次调用。 */
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
    // 本次 attempted 更新值（独立构造）：写入 → 读回确认 → 确认后才进入发送。
    const attemptedTick = tick ?? config.targetTick;
    const attemptedUpdate = { ...record, attempted: true, attemptedTick };
    const markWrite = writeControlRecord(attemptedUpdate);
    if (!markWrite.ok) {
      logMarkUnconfirmed(config, tick, "mark_write", markWrite.reason);
      return;
    }
    const markConfirmation = confirmAttemptedMark({
      experimentId: config.experimentId,
      attemptedTick,
    });
    if (markConfirmation.status !== "confirmed") {
      logMarkUnconfirmed(config, tick, "mark_readback", markConfirmation.reason);
      return;
    }
    // 读回已确认——此后才允许进入实际发送边界（采样紧贴调用）。
    const preCall = buildSample(config);
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
    console.log(
      JSON.stringify({
        kind: "lab-send-attempt",
        phase: syncResult.error !== undefined ? "sync-throw" : "sync-return",
        experimentId: config.experimentId,
        tick,
        result: syncResult,
      }),
    );
    // 结果与停止状态写回：失败不回滚/覆盖已确认的 attempted，不重试，不谎报已保存。
    const resultWrite = writeControlRecord({ ...attemptedUpdate, syncResult, stopped: true });
    if (!resultWrite.ok) {
      console.log(
        JSON.stringify({
          kind: "lab-result-write-refused",
          experimentId: config.experimentId,
          mode: "single-shot",
          tick,
          reason: resultWrite.reason,
          syncResult,
          note: "结果/停止状态未保存——attempted 标记保留，零重试",
        }),
      );
    }
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
