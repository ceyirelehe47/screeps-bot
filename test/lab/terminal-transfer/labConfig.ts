/**
 * 实验配置（Terminal Transfer Engine Lab Prep I §4.2/§4.3 起源；
 * Run I Execution 2026-09-09 回填；Calibration Rerun 2026-09-09 纠错）。
 *
 * 当前值是 Engine Lab Run I 执行轮一次性隔离世界的**历史配置**（已按
 * Calibration Rerun 纠错：源结构 ID 更正为 b0254141a49b92c、shard 更正
 * 为该轮窗口后只读探查实测的 "Forst"、费用上限更正为窗口报价 26）。
 * 该世界已停止并清理，本配置**未绑定任何新实验**：不得据此武装或发送。
 * 新实验必须在 S02 取得稳定只读事实后重新读取并绑定全部身份（实验 ID、
 * 用户、shard、结构 ID、报价、T），经独立配置核对（C02）后再回填本文件。
 *
 * 配置来源（当前唯一通道，编译时固定）：
 * - 本文件的实验配置是各产物共享的唯一配置来源；singleShot 模块据
 *   `mode` 派生调用版模式（自身覆盖为 single-shot），不读取任何外部
 *   配置文件；observer 产物恒以 observer 模式输出，不受该字段影响。
 * - `example.experiment.json` 是随产物分发的**文档示例**（构建器仅复制，
 *   运行时不读取）；修改 JSON 或 Memory 附加字段不会改变已构建产物。
 * - Memory 控制记录只携带实验 ID 与武装/尝试/停止事实，不覆盖编译进
 *   产物的路线、用户、结构、预算和 targetTick。
 * - 更换实验配置属于源码变化：改本文件 → 同步文档示例 → 重新固定源码
 *   提交 → 重建入口并核对新产物 hash；不允许只改已构建 JS 而沿用
 *   原 hash 与验证声明。
 * - 历史身份：Lab Prep I / Lab Run I 离线轮的合成示例值
 *   （lab-prep1-example-0001、lab-synthetic-shard、lab-term-*-synthetic、
 *   targetTick 12345、maxFeeEnergy 1000）与 Run I Execution 的 sentinel
 *   期编译值（shardName "standalone-no-shard"、源 ID b0254105a49b92c、
 *   maxFeeEnergy 10）均作为旧配置 fixture 记录于测试与历史归档产物，
 *   不是当前编译值；sentinel 约定本身已随 Calibration Rerun C01 撤销。
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

/** Run I 执行轮历史配置（已纠错、未绑定新实验；与 example.experiment.json 保持一致；probe.test 断言同步）。 */
export const LAB_EXAMPLE_EXPERIMENT: LabExperimentConfig = {
  experimentId: "lab-run1-exec-0001",
  mode: "observer",
  shardName: "Forst",
  username: "lab-synthetic-user",
  sourceRoomName: "W1N57",
  targetRoomName: "W10N57",
  sourceTerminalId: "b0254141a49b92c",
  targetTerminalId: "c61a4141a4a9fcb",
  resourceType: "H",
  amount: 100,
  description: "lab-run1-exec-0001 W1N57 to W10N57 100H",
  targetTick: 557,
  maxFeeEnergy: 26,
  maxSamples: 32,
};
