/**
 * Terminal Transfer Engine Lab Prep I——observer（默认入口，§4.1）。
 *
 * 只读世界、费用和交易视图并输出采样；不写游戏 Memory、不持有可达的
 * 发送分支（本模块及其依赖不包含 terminal.send 调用）、无业务注册、
 * 无自动动作。观测窗口有界（maxSamples，示例 32）：超过即标记截断并
 * 停止采集——截断不是"无交易"。完整样本走外部日志（console），不累计
 * 进游戏 Memory。
 *
 * PREPARED_NOT_RUN：本产物只构建与离线自测，未在真实引擎上运行。
 */

import { LAB_EXAMPLE_EXPERIMENT } from "./labConfig";
import { buildSample } from "./sample";

/** 采样窗口状态（模块 heap——普通 global reset 会丢失，属实验已知边界）。 */
interface ObserverWindowState {
  samplesLogged: number;
  truncatedAnnounced: boolean;
}

const windowState: ObserverWindowState = { samplesLogged: 0, truncatedAnnounced: false };

/** Screeps 装载入口：每 tick 采样一行（外部日志），只读零写。 */
export function loop(): void {
  const config = LAB_EXAMPLE_EXPERIMENT;
  try {
    if (windowState.samplesLogged >= config.maxSamples) {
      if (!windowState.truncatedAnnounced) {
        windowState.truncatedAnnounced = true;
        console.log(
          JSON.stringify({
            kind: "lab-truncated",
            experimentId: config.experimentId,
            mode: "observer",
            maxSamples: config.maxSamples,
            note: "观测窗口已满，停止采集；截断不代表无交易",
          }),
        );
      }
      return;
    }
    console.log(JSON.stringify(buildSample(config)));
    windowState.samplesLogged += 1;
  } catch (error) {
    // 兜底：loop 不向宿主抛出（记录原始错误事实，不改写为成功结论）。
    console.log(
      JSON.stringify({
        kind: "lab-sample-error",
        experimentId: config.experimentId,
        mode: "observer",
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }),
    );
  }
}
