/* Terminal Transfer Engine Lab Run I——run-i-main（薄装配入口，仅供单独授权的真实隔离实验）。PREPARED_NOT_RUN：仅本地构建与离线自测，未在真实引擎上运行、未上传。窗口内每 tick 先调 observer（只读零写）；仅目标 tick 调既有 single-shot（其自带标记确认与门禁）；本模块零发送、零控制槽写。 */
'use strict';

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
/** Run I 执行轮历史配置（已纠错、未绑定新实验；与 example.experiment.json 保持一致；probe.test 断言同步）。 */
const LAB_EXAMPLE_EXPERIMENT = {
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
/** 观察窗口边界（任务书 §4.4：T−2 .. T+20 共 23 tick，低于 maxSamples=32）。 */
const WINDOW_BEFORE_TICKS = 2;
const WINDOW_AFTER_TICKS = 20;
const OBSERVER_MODULE = "observer";
const SINGLE_SHOT_MODULE = "single-shot";
const windowState = { windowAnnounced: false };
function describeError(error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
/** Screeps 模块解析：异常或未导出 loop 都按"不可用"记录并返回 null，不抛出。 */
function requireLabModule(name) {
    let loaded;
    try {
        loaded = require(name);
    }
    catch (error) {
        console.log(JSON.stringify({
            kind: "lab-run-i-module-error",
            module: name,
            stage: "require",
            error: describeError(error),
        }));
        return null;
    }
    if (typeof loaded === "object" &&
        loaded !== null &&
        typeof loaded.loop === "function") {
        return loaded;
    }
    console.log(JSON.stringify({
        kind: "lab-run-i-module-error",
        module: name,
        stage: "loop-export",
        error: "模块未导出 loop 函数",
    }));
    return null;
}
/** Screeps 装载入口：窗口内每 tick 先 observer，仅目标 tick 再 single-shot。 */
function loop() {
    const config = LAB_EXAMPLE_EXPERIMENT;
    try {
        let tick;
        try {
            tick = Game.time;
        }
        catch (error) {
            console.log(JSON.stringify({
                kind: "lab-run-i-main-error",
                stage: "read-tick",
                experimentId: config.experimentId,
                error: describeError(error),
            }));
            return; // 读不到真实 tick——不猜 0，零调用
        }
        const windowFirstTick = config.targetTick - WINDOW_BEFORE_TICKS;
        const windowLastTick = config.targetTick + WINDOW_AFTER_TICKS;
        if (tick < windowFirstTick || tick > windowLastTick) {
            return; // 窗口外零调用：不采样、不发送、不补调
        }
        if (!windowState.windowAnnounced) {
            windowState.windowAnnounced = true;
            console.log(JSON.stringify({
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
            }));
        }
        const observer = requireLabModule(OBSERVER_MODULE);
        if (observer === null)
            return; // 发送依赖观察装配：observer 不可用即结束本次 loop，不解析 single-shot
        observer.loop();
        if (tick === config.targetTick) {
            const singleShot = requireLabModule(SINGLE_SHOT_MODULE);
            if (singleShot !== null)
                singleShot.loop();
        }
    }
    catch (error) {
        console.log(JSON.stringify({
            kind: "lab-run-i-main-error",
            stage: "dispatch",
            experimentId: config.experimentId,
            error: describeError(error),
        }));
    }
}

exports.loop = loop;
