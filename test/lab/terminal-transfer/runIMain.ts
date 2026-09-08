/**
 * Terminal Transfer Engine Lab Run I——薄装配入口 main（任务书 §4.4）。
 *
 * 本模块是实验模块三件套中的 main：观察窗口（targetTick−2 .. targetTick+20，
 * 共 23 tick）内每 tick 先调既有 observer（只读零写采样），仅
 * Game.time === targetTick 时再调既有 single-shot（其自带发送前 attempted
 * 标记写入/读回确认与全部门禁）；先 observer 后 single-shot，以保留调用
 * tick 的前态。
 *
 * 边界：
 * - 模块加载零动作；窗口外（更早、更晚、以及装载晚导致错过目标 tick）零
 *   调用、不补调、不续期；
 * - 不直接调用 terminal.send、不初始化/重置/复制控制槽内容、不复制
 *   attempted/费用/归属判断——发送资格完全由既有 single-shot 决定；
 * - 装配用 Screeps 运行时模块系统（require("observer")/require("single-shot")，
 *   即与产物文件同名的模块）；observer 模块缺失、未导出 loop 或调用向外
 *   抛错时如实记录错误事实并立即结束本次 loop——发送依赖观察装配：本次
 *   不解析、不调用 single-shot；反方向不成立：single-shot 不可用时已完
 *   成的只读观察与后续窗口采样仍继续（Wiring Remediation I 单向依赖）；
 * - 窗口首个 tick 输出一行装配/窗口信息（外部日志 console，不写游戏
 *   Memory）。窗口标志是模块 heap：普通 global reset 会重置（与 observer
 *   采样窗口状态同一边界，实验已知）。
 *
 * PREPARED_NOT_RUN：本产物仅本地构建与离线自测；真实装载、武装与发送须
 * Lab Run I 单独授权——未授权状态为 AUTHORIZATION_REQUIRED，不上传、不装载。
 */

import { LAB_EXAMPLE_EXPERIMENT } from "./labConfig";

/** 观察窗口边界（任务书 §4.4：T−2 .. T+20 共 23 tick，低于 maxSamples=32）。 */
const WINDOW_BEFORE_TICKS = 2;
const WINDOW_AFTER_TICKS = 20;
const OBSERVER_MODULE = "observer";
const SINGLE_SHOT_MODULE = "single-shot";

/** 窗口信息是否已输出（模块 heap——global reset 会丢，属实验已知边界）。 */
interface RunIMainWindowState {
  windowAnnounced: boolean;
}

const windowState: RunIMainWindowState = { windowAnnounced: false };

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Screeps 模块解析：异常或未导出 loop 都按"不可用"记录并返回 null，不抛出。 */
function requireLabModule(name: string): { loop(): void } | null {
  let loaded: unknown;
  try {
    loaded = require(name);
  } catch (error) {
    console.log(
      JSON.stringify({
        kind: "lab-run-i-module-error",
        module: name,
        stage: "require",
        error: describeError(error),
      }),
    );
    return null;
  }
  if (
    typeof loaded === "object" &&
    loaded !== null &&
    typeof (loaded as { loop?: unknown }).loop === "function"
  ) {
    return loaded as { loop(): void };
  }
  console.log(
    JSON.stringify({
      kind: "lab-run-i-module-error",
      module: name,
      stage: "loop-export",
      error: "模块未导出 loop 函数",
    }),
  );
  return null;
}

/** Screeps 装载入口：窗口内每 tick 先 observer，仅目标 tick 再 single-shot。 */
export function loop(): void {
  const config = LAB_EXAMPLE_EXPERIMENT;
  try {
    let tick: number;
    try {
      tick = Game.time;
    } catch (error) {
      console.log(
        JSON.stringify({
          kind: "lab-run-i-main-error",
          stage: "read-tick",
          experimentId: config.experimentId,
          error: describeError(error),
        }),
      );
      return; // 读不到真实 tick——不猜 0，零调用
    }
    const windowFirstTick = config.targetTick - WINDOW_BEFORE_TICKS;
    const windowLastTick = config.targetTick + WINDOW_AFTER_TICKS;
    if (tick < windowFirstTick || tick > windowLastTick) {
      return; // 窗口外零调用：不采样、不发送、不补调
    }
    if (!windowState.windowAnnounced) {
      windowState.windowAnnounced = true;
      console.log(
        JSON.stringify({
          kind: "lab-run-i-window",
          experimentId: config.experimentId,
          mode: "run-i-main",
          tick,
          windowFirstTick,
          targetTick: config.targetTick,
          windowLastTick,
          observerModule: OBSERVER_MODULE,
          singleShotModule: SINGLE_SHOT_MODULE,
          note: "Lab Run I 薄装配窗口开始：每 tick 先 observer（只读零写），仅目标 tick 调既有 single-shot；窗口外零调用",
        }),
      );
    }
    const observer = requireLabModule(OBSERVER_MODULE);
    if (observer === null) return; // 发送依赖观察装配：observer 不可用即结束本次 loop，不解析 single-shot
    observer.loop();
    if (tick === config.targetTick) {
      const singleShot = requireLabModule(SINGLE_SHOT_MODULE);
      if (singleShot !== null) singleShot.loop();
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        kind: "lab-run-i-main-error",
        stage: "dispatch",
        experimentId: config.experimentId,
        error: describeError(error),
      }),
    );
  }
}
