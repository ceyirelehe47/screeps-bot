/**
 * Terminal Transfer Engine Lab Prep I——采样记录组装（§4.2 观测内容）。
 *
 * 一条采样包含：实验 ID、模式、当前 tick 与配置目标 tick、来源/目标房间
 * 与结构 ID/owner、两端资源/能源/容量/冷却、当前费用报价、实际观察到的
 * 交易字段、读取错误与截断状态。不自行给出完成/未执行结论，不在 API
 * 返回时改两端库存或创建交易记录。
 */

import type { LabExperimentConfig } from "./labConfig";
import {
  readEndpoint,
  readFeeQuote,
  readTransactionViews,
  type LabEndpointReading,
  type LabFeeQuote,
  type LabTransactionViewReading,
} from "./worldRead";

/** 一行观测采样（JSON 序列化后作为外部日志的一行）。 */
export interface LabSampleRecord {
  readonly kind: "lab-sample";
  readonly experimentId: string;
  readonly mode: string;
  readonly tick: number | null;
  readonly configTargetTick: number;
  readonly source: LabEndpointReading;
  readonly target: LabEndpointReading;
  readonly feeQuote: LabFeeQuote;
  readonly transactions: {
    readonly incoming: LabTransactionViewReading;
    readonly outgoing: LabTransactionViewReading;
  };
}

/** 读取当前世界事实并组装一条采样（任何读取失败都留在记录里，不填成功值）。 */
export function buildSample(config: LabExperimentConfig): LabSampleRecord {
  let tick: number | null;
  try {
    tick = Game.time;
  } catch {
    tick = null; // Game 本身缺失——如实记录，不猜 0
  }
  return {
    kind: "lab-sample",
    experimentId: config.experimentId,
    mode: config.mode,
    tick,
    configTargetTick: config.targetTick,
    source: readEndpoint(config, "source"),
    target: readEndpoint(config, "target"),
    feeQuote: readFeeQuote(config.amount, config.sourceRoomName, config.targetRoomName),
    transactions: readTransactionViews(),
  };
}
