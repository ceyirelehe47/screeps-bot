/* Terminal Transfer Engine Lab Prep I——single-shot（未武装调用版，仅供未来单独授权的隔离实验）。PREPARED_NOT_RUN：仅本地构建与离线自测，未在真实引擎上运行。默认零发送；仅在完整实验配置与一次性控制事实同时匹配的目标 tick 尝试一次。 */
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
 * Terminal Transfer Engine Lab Prep I——实验控制记录（仅 single-shot 产物使用）。
 *
 * 任务书 §4.3 边界：
 * - 不写入 Memory.runtime.treasuryCore 或任何生产 Memory 声明（实验侧窄化）；
 * - 固定只存一个 run、序列化不超过 4KiB、不存逐 tick 交易历史、不按 run 追加；
 * - 缺失/损坏时不自动初始化并发送；正常完成标记 stopped，但不自动再次武装；
 * - 有界保留到实验世界显式销毁或只读状态下的人工重置——不能以 TTL 重获发送资格。
 *
 * 重要限制：本记录的 Memory read-back 只是普通运行与"控制事实确实保留"的
 * reset 下的防重入/防重试约束，**不是** driver 持久化承诺，更不是 CPU/driver
 * 任意故障下的 exactly-once。未来不确定中断后应先切只读并检查外部持久事实。
 */
/** 实验 Memory 槽（与生产四个 Memory 根完全无关的独立键）。 */
const CONTROL_MEMORY_KEY = "__labTerminalTransferProbe";
/** 单记录序列化上限（§4.3：不超过 4KiB）。 */
const CONTROL_MAX_BYTES = 4096;
function isControlRecord(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const candidate = value;
    if (typeof candidate.experimentId !== "string")
        return false;
    if (typeof candidate.armed !== "boolean" || typeof candidate.attempted !== "boolean")
        return false;
    if (candidate.attemptedTick !== undefined && typeof candidate.attemptedTick !== "number")
        return false;
    if (candidate.stopped !== undefined && typeof candidate.stopped !== "boolean")
        return false;
    const syncResult = candidate.syncResult;
    if (syncResult !== undefined &&
        (typeof syncResult !== "object" || syncResult === null || typeof syncResult.ok !== "boolean")) {
        return false;
    }
    return true;
}
/** 读取控制记录：缺失→absent；形状不符→corrupt（都不自动初始化）。 */
function readControlRecord() {
    let raw;
    try {
        raw = Memory[CONTROL_MEMORY_KEY];
    }
    catch (error) {
        console.log(JSON.stringify({
            kind: "lab-control-read-error",
            key: CONTROL_MEMORY_KEY,
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        }));
        return { status: "corrupt" };
    }
    if (raw === undefined)
        return { status: "absent" };
    if (!isControlRecord(raw))
        return { status: "corrupt" };
    return { status: "ok", record: raw };
}
/** 写回控制记录（单记录覆盖，不追加历史；超限拒写并留痕）。 */
function writeControlRecord(record) {
    try {
        const serialized = JSON.stringify(record);
        if (serialized.length > CONTROL_MAX_BYTES) {
            console.log(JSON.stringify({
                kind: "lab-control-write-refused",
                key: CONTROL_MEMORY_KEY,
                bytes: serialized.length,
                limit: CONTROL_MAX_BYTES,
            }));
            return;
        }
        Memory[CONTROL_MEMORY_KEY] = JSON.parse(serialized);
    }
    catch (error) {
        console.log(JSON.stringify({
            kind: "lab-control-write-refused",
            key: CONTROL_MEMORY_KEY,
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        }));
    }
}

/**
 * Terminal Transfer Engine Lab Prep I——single-shot 调用门禁（§4.3）。
 *
 * 最小安全边界：没有武装控制事实、模式不符、ID/路线/用户/shard/结构不符、
 * 目标 tick 错过、已经尝试、状态不健康或报价不可读/超预算时，零发送。
 * 只允许 Game.time === targetTick（不"到点以后一直重试"）。
 * 每个拒绝 reason 都是探针前置拒绝——不是"已实测游戏 API 的 ERR 返回"。
 */
function reject(reason) {
    return { decision: "reject", reason };
}
/** 从世界取源 Terminal 实例（send 以成员调用发起——保持方法所属对象绑定）。 */
function resolveSourceTerminal(config) {
    try {
        const rooms = Game.rooms ?? {};
        const terminal = rooms[config.sourceRoomName]?.terminal;
        return terminal ?? null;
    }
    catch {
        return null;
    }
}
/**
 * 逐项门禁（顺序保守：控制事实 → 世界身份 → tick → 结构/资源/预算）。
 * 任何一步不满足即拒绝并给出明确 reason——调用方据此零发送。
 */
function evaluateSingleShotGates(config, control) {
    if (config.mode !== "single-shot")
        return reject("mode_mismatch");
    if (control.status === "absent")
        return reject("no_control_record");
    if (control.status === "corrupt")
        return reject("control_record_corrupt");
    const record = control.record;
    if (record === undefined)
        return reject("control_record_corrupt");
    if (record.stopped === true)
        return reject("already_stopped");
    if (record.attempted === true)
        return reject("already_attempted");
    if (record.armed !== true)
        return reject("not_armed");
    if (record.experimentId !== config.experimentId)
        return reject("experiment_id_mismatch");
    let shardName;
    let tick;
    try {
        shardName = Game.shard.name;
        tick = Game.time;
    }
    catch {
        return reject("world_read_error");
    }
    if (shardName !== config.shardName)
        return reject("shard_mismatch");
    const source = readEndpoint(config, "source");
    const target = readEndpoint(config, "target");
    if (source.readStatus !== "ok")
        return reject("source_unhealthy");
    if (target.readStatus !== "ok")
        return reject("target_unhealthy");
    if (source.terminalId !== config.sourceTerminalId || target.terminalId !== config.targetTerminalId) {
        return reject("structure_mismatch");
    }
    if (source.ownerUsername !== config.username || target.ownerUsername !== config.username) {
        return reject("user_mismatch");
    }
    if (tick < config.targetTick)
        return reject("tick_not_reached");
    if (tick > config.targetTick)
        return reject("tick_missed");
    if ((source.cooldown ?? 0) > 0)
        return reject("cooldown_active");
    if ((source.resourceAmount ?? 0) < config.amount)
        return reject("insufficient_resource");
    const quote = readFeeQuote(config.amount, config.sourceRoomName, config.targetRoomName);
    if (quote.status !== "ok")
        return reject("fee_unreadable");
    const fee = quote.energyCost ?? 0;
    if (fee > config.maxFeeEnergy)
        return reject("fee_over_budget");
    if ((source.energy ?? 0) < fee)
        return reject("insufficient_resource");
    if ((target.freeCapacity ?? 0) < config.amount)
        return reject("target_capacity_insufficient");
    const sourceTerminal = resolveSourceTerminal(config);
    if (sourceTerminal === null)
        return reject("source_unhealthy");
    return { decision: "proceed", sourceTerminal, fee };
}

/**
 * Terminal Transfer Engine Lab Prep I——single-shot（仅供未来单独授权的
 * 隔离实验使用，§4.1/§4.3）。
 *
 * 默认未武装：只有完整实验配置与一次性实验控制事实（Memory 控制记录）
 * 同时匹配，才在指定 tick 尝试**一次** 100H 发送。调用前先标记已尝试；
 * 任何失败（含同步非 OK/抛错）不自动重试。OK 只表示请求已调度——本产物
 * 不在 API 返回时改两端库存、不创建交易记录、不宣告"世界已经完成"。
 *
 * PREPARED_NOT_RUN：本产物只构建与离线自测（假端口 spy），未在真实引擎
 * 上运行，也未连接任何真实世界。
 */
/** 调用版配置：同一实验身份（ID/路线/双方/tick/预算），模式为 single-shot。 */
const SINGLE_SHOT_CONFIG = { ...LAB_EXAMPLE_EXPERIMENT, mode: "single-shot" };
function readTick() {
    try {
        return Game.time;
    }
    catch {
        return null; // Game 缺失——如实记录，不猜 0
    }
}
/** Screeps 装载入口：每 tick 评估门禁；仅目标 tick 且全部匹配时恰一次调用。 */
function loop() {
    const config = SINGLE_SHOT_CONFIG;
    try {
        const control = readControlRecord();
        const tick = readTick();
        const gate = evaluateSingleShotGates(config, control);
        if (gate.decision === "reject") {
            console.log(JSON.stringify({
                kind: "lab-precondition-rejection",
                experimentId: config.experimentId,
                mode: "single-shot",
                tick,
                reason: gate.reason,
                note: "探针前置拒绝——不是已实测游戏 API 的 ERR 返回",
            }));
            return;
        }
        // 判别联合收窄：gate 通过必然 status==="ok"（absent/corrupt 已被前置拒绝）。
        const record = control.status === "ok" ? control.record : undefined;
        if (record === undefined)
            return;
        // 调用前采样 + 先标记已尝试（写 Memory 在 send 之前——此后任何路径零重试）。
        const preCall = buildSample(config);
        writeControlRecord({ ...record, attempted: true, attemptedTick: tick ?? config.targetTick });
        console.log(JSON.stringify({
            kind: "lab-send-attempt",
            phase: "pre-call",
            experimentId: config.experimentId,
            tick,
            fee: gate.fee,
            sample: preCall,
        }));
        console.log(JSON.stringify({ kind: "lab-send-attempt", phase: "boundary", experimentId: config.experimentId, tick }));
        // 单次调用：保持方法所属对象绑定（sourceTerminal.send 成员调用）。
        // ScreepsReturnCode：OK === 0（同步返回 0 只表示请求已调度）。
        let syncResult;
        try {
            const code = gate.sourceTerminal.send(config.resourceType, config.amount, config.targetRoomName, config.description);
            syncResult = { ok: code === 0, code };
        }
        catch (error) {
            syncResult = { ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
        }
        // 正常完成即标记停止（不自动再次武装）；attempted 保持 true。
        writeControlRecord({
            ...record,
            attempted: true,
            attemptedTick: tick ?? config.targetTick,
            syncResult,
            stopped: true,
        });
        console.log(JSON.stringify({
            kind: "lab-send-attempt",
            phase: syncResult.error !== undefined ? "sync-throw" : "sync-return",
            experimentId: config.experimentId,
            tick,
            result: syncResult,
        }));
    }
    catch (error) {
        console.log(JSON.stringify({
            kind: "lab-single-shot-error",
            experimentId: config.experimentId,
            mode: "single-shot",
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        }));
    }
}

exports.loop = loop;
