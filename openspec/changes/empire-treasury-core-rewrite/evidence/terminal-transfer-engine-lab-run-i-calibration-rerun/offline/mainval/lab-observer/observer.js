/* Terminal Transfer Engine Lab Prep I——observer（默认只读入口）。PREPARED_NOT_RUN：仅本地构建与离线自测，未在真实引擎上运行。不发送、不写游戏 Memory。生成身份见同目录 manifest.json。 */
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
 * Terminal Transfer Engine Lab Prep I——真实 API 薄包装（只读部分）。
 *
 * 直接使用 Game.rooms / Terminal .store/.cooldown/.owner/.id /
 * Game.market.calcTransactionCost / incoming/outgoing transactions。
 * 采样只报告原始事实与读取状态：缺房间、缺结构、读失败**不能**被填写为
 * "库存 0、交易空数组且读取成功"；不给出 observed_committed /
 * observed_not_executed 之类的结论（不复制国库 matcher）。
 *
 * 类型窄化说明：@types/screeps 的 Store 索引与官方 Transaction 的
 * description（必填）/order（{id,type,price}）形状与本探针的记录面不同，
 * 实验侧做明确窄化，不改生产声明（任务书 §4.2）。
 */
/** 读取一个端点房间里的 Terminal 原始事实。 */
function readEndpoint(config, side) {
    const roomName = side === "source" ? config.sourceRoomName : config.targetRoomName;
    try {
        const rooms = Game.rooms ?? {};
        const room = rooms[roomName];
        if (room === undefined)
            return { roomName, readStatus: "room_missing" };
        const terminal = room.terminal;
        if (terminal === undefined || terminal === null)
            return { roomName, readStatus: "terminal_missing" };
        // 实验侧窄化：Store 索引读取（官方类型对单资源索引形状保守）。
        const store = terminal.store;
        return {
            roomName,
            readStatus: "ok",
            terminalId: terminal.id,
            ownerUsername: terminal.owner?.username,
            resourceAmount: store[config.resourceType] ?? 0,
            energy: store.energy ?? 0,
            freeCapacity: terminal.store.getFreeCapacity(),
            cooldown: terminal.cooldown,
        };
    }
    catch (error) {
        return { roomName, readStatus: "read_error", error: describeError(error) };
    }
}
/** 读取当前费用报价（真实端口；异常/非有限数/负数一律 unavailable）。 */
function readFeeQuote(amount, fromRoomName, toRoomName) {
    try {
        const cost = Game.market.calcTransactionCost(amount, fromRoomName, toRoomName);
        if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
            return { status: "unavailable", error: `报价端口返回非法值：${String(cost)}` };
        }
        return { status: "ok", energyCost: cost };
    }
    catch (error) {
        return { status: "unavailable", error: describeError(error) };
    }
}
/** 读取两个交易视图（有限历史——每方向最近记录；读取状态如实保留）。 */
function readTransactionViews() {
    const readView = (direction) => {
        try {
            // 官方 API：两视图是数组属性（每方向有限历史）——属性读取，非方法调用。
            const raw = Game.market[direction];
            if (!Array.isArray(raw)) {
                return { status: "read_error", error: `交易视图端口返回非数组：${typeof raw}` };
            }
            // 浅拷贝逐条保留全部字段（含与实验预期不一致的记录——镜像/不同 ID 原样保留）。
            return { status: "ok", count: raw.length, records: raw.map((entry) => ({ ...entry })) };
        }
        catch (error) {
            return { status: "read_error", error: describeError(error) };
        }
    };
    return { incoming: readView("incomingTransactions"), outgoing: readView("outgoingTransactions") };
}
/** 错误事实化为可序列化文本（不吞异常、不改写为成功结论）。 */
function describeError(error) {
    if (error instanceof Error)
        return `${error.name}: ${error.message}`;
    return String(error);
}

/**
 * Terminal Transfer Engine Lab Prep I——采样记录组装（§4.2 观测内容）。
 *
 * 一条采样包含：实验 ID、模式、当前 tick 与配置目标 tick、来源/目标房间
 * 与结构 ID/owner、两端资源/能源/容量/冷却、当前费用报价、实际观察到的
 * 交易字段、读取错误与截断状态。不自行给出完成/未执行结论，不在 API
 * 返回时改两端库存或创建交易记录。
 */
/** 读取当前世界事实并组装一条采样（任何读取失败都留在记录里，不填成功值）。 */
function buildSample(config) {
    let tick;
    try {
        tick = Game.time;
    }
    catch {
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
const windowState = { samplesLogged: 0, truncatedAnnounced: false };
/** Screeps 装载入口：每 tick 采样一行（外部日志），只读零写。 */
function loop() {
    const config = LAB_EXAMPLE_EXPERIMENT;
    try {
        if (windowState.samplesLogged >= config.maxSamples) {
            if (!windowState.truncatedAnnounced) {
                windowState.truncatedAnnounced = true;
                console.log(JSON.stringify({
                    kind: "lab-truncated",
                    experimentId: config.experimentId,
                    mode: "observer",
                    maxSamples: config.maxSamples,
                    note: "观测窗口已满，停止采集；截断不代表无交易",
                }));
            }
            return;
        }
        console.log(JSON.stringify(buildSample(config)));
        windowState.samplesLogged += 1;
    }
    catch (error) {
        // 兜底：loop 不向宿主抛出（记录原始错误事实，不改写为成功结论）。
        console.log(JSON.stringify({
            kind: "lab-sample-error",
            experimentId: config.experimentId,
            mode: "observer",
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        }));
    }
}

exports.loop = loop;
