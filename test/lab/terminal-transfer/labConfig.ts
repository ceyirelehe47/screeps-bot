/**
 * 实验配置（Terminal Transfer Engine Lab Prep I §4.2/§4.3 起源；
 * Run I Execution 2026-09-09 回填；Calibration Rerun 2026-09-09 纠错并
 * 于实机复验轮 S02/S03 重新读回绑定；Engine Continuation 0001 2026-09-09
 * 再次绑定新一次性世界）。
 *
 * 当前值是 Engine Continuation 0001（lab-run1-ec-0001）准备阶段绑定配置：
 * 新一次性隔离世界（worldSize 59）实测读回——shard Forst（meta-probe 逐样本
 * 实测恒定）、合成用户 lab-ec-user-0001（id 48b86d847499b79）、双 Terminal
 * ec0001aa57000001/ec0001aa57000002、新鲜报价 q=26（绑定规则 cap=q，本轮
 * 41 个基线样本逐样本实测恒定）、暂停点 T0=160（暂停复读确认）。
 * targetTick=167=T0+3 为正式窗口（observe-armed 后实际暂停点 T0=164 经
 * facts 命令复读确认；窗口 165..187 共 23 个样本，T−2 可取得）。此前的
 * 准备阶段占位值 400 已由本提交替换——占位值从未进入任何 send 路径
 * （准备入口 controlProbe 无 send 路径）。
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
 * - 历史身份：Lab Prep I / Lab Run I 离线轮合成示例值、Run I Execution
 *   sentinel 期编译值与纠错后历史配置（lab-run1-exec-0001、
 *   b0254141a49b92c、lab-synthetic-user）均作为旧配置 fixture 记录于
 *   测试与历史归档产物，不是当前编译值；sentinel 约定已随 C01 撤销。
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

/** Treasury Terminal Integration I 准备阶段绑定配置（lab-ti1-0001；q=26 为本轮 probe 基线 24 样本逐样本实测恒定值（整树重启后全进程同 worldSize，报价与实扣同源），cap=q；T=400 仍为准备期占位值，从未进入任何 send 路径——准备入口 controlProbe 无 send 路径，正式 T 在 observe-armed 后实际稳定暂停 T0=329 之上以 T0+3=332 首次固定；与 example.experiment.json 保持一致；历史 cal-0002 配置冻结于 tools/fixtures/review-base-config.json）。 */
export const LAB_EXAMPLE_EXPERIMENT: LabExperimentConfig = {
  experimentId: "lab-ti1-0001",
  mode: "observer",
  shardName: "Forst",
  username: "lab-ti-user-0001",
  sourceRoomName: "W1N57",
  targetRoomName: "W10N57",
  sourceTerminalId: "ti10001aa57000001",
  targetTerminalId: "ti10001aa57000002",
  resourceType: "H",
  amount: 100,
  description: "lab-ti1-0001 W1N57 to W10N57 100H",
  targetTick: 400,
  maxFeeEnergy: 26,
  maxSamples: 32,
};
