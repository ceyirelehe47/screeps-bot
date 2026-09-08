/**
 * Terminal Transfer Engine Lab Prep I——实验配置（任务书 §4.2/§4.3）。
 *
 * 这是**合成示例值**：实验 ID/用户名/shard/结构 ID 都是明显合成字样，
 * 默认不可发送；调用版（single-shot）在完整实验配置与一次性实验控制
 * 事实同时匹配前零发送。真实 F0、费用与身份一律从环境读取，不照抄
 * fake 世界的 100000 空位或 26 能源。
 *
 * 本文件属于 test/lab 实验包：不导入生产模块，不进入生产 bundle，
 * 不复制国库的授权/重试/清理/对账机制。
 */

/** 实验模式：observer=默认只读入口；single-shot=未来单独授权的一次性调用版。 */
export type LabProbeMode = "observer" | "single-shot";

/** 一次性实验的完整配置（调用门禁逐项核对这些身份与预算）。 */
export interface LabExperimentConfig {
  readonly experimentId: string;
  readonly mode: LabProbeMode;
  readonly shardName: string;
  readonly username: string;
  readonly sourceRoomName: string;
  readonly targetRoomName: string;
  readonly sourceTerminalId: string;
  readonly targetTerminalId: string;
  readonly resourceType: "H";
  readonly amount: 100;
  /** 完整关联描述（进入 send 的 description；对账归属以此为准）。 */
  readonly description: string;
  /** 唯一允许尝试的 tick（只允许 Game.time === targetTick，不允许"到点后一直重试"）。 */
  readonly targetTick: number;
  /** 允许的最大费用（energy）——报价高于此值零发送。 */
  readonly maxFeeEnergy: number;
  /** 观测窗口上限（采样行数；超过即标记截断并停止采集，不把截断当无交易）。 */
  readonly maxSamples: number;
}

/** 合成示例配置（与 example.experiment.json 保持一致；probe.test 断言同步）。 */
export const LAB_EXAMPLE_EXPERIMENT: LabExperimentConfig = {
  experimentId: "lab-prep1-example-0001",
  mode: "observer",
  shardName: "lab-synthetic-shard",
  username: "lab-synthetic-user",
  sourceRoomName: "W1N57",
  targetRoomName: "W10N57",
  sourceTerminalId: "lab-term-source-synthetic",
  targetTerminalId: "lab-term-target-synthetic",
  resourceType: "H",
  amount: 100,
  description: "lab-prep1 single-shot terminal transfer experiment",
  targetTick: 12345,
  maxFeeEnergy: 1000,
  maxSamples: 32,
};
