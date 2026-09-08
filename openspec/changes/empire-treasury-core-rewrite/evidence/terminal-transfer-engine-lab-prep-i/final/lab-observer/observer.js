/* Terminal Transfer Engine Lab Prep I——observer（默认只读入口）。PREPARED_NOT_RUN：仅本地构建与离线自测，未在真实引擎上运行。不发送、不写游戏 Memory。生成身份见同目录 manifest.json。 */
'use strict';

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
/** 合成示例配置（与 example.experiment.json 保持一致；probe.test 断言同步）。 */
const LAB_EXAMPLE_EXPERIMENT = {
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
