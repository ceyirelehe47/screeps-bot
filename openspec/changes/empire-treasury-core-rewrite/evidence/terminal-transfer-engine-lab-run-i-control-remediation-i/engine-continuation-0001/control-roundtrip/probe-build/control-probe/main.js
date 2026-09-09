/* Read-only control probe; PREPARED_NOT_RUN. */
'use strict';
(function(){
const factories={"labConfig": function(exports,module,require){
"use strict";
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
 * **targetTick=400 仅为准备阶段占位值**：准备入口（controlProbe）无 send
 * 路径，该值不构成正式发送窗口；正式 T 在 facts 取得后按 T≥T0'+3 首次
 * 固定（T0' 为 observe-armed 后的实际暂停点，另行提交）。
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.LAB_EXAMPLE_EXPERIMENT = void 0;
/** Engine Continuation 0001 准备阶段绑定配置（本轮实测读回；与 example.experiment.json 保持一致；历史 cal-0002 配置冻结于 tools/fixtures/review-base-config.json）。 */
exports.LAB_EXAMPLE_EXPERIMENT = {
    experimentId: "lab-run1-ec-0001",
    mode: "observer",
    shardName: "Forst",
    username: "lab-ec-user-0001",
    sourceRoomName: "W1N57",
    targetRoomName: "W10N57",
    sourceTerminalId: "ec0001aa57000001",
    targetTerminalId: "ec0001aa57000002",
    resourceType: "H",
    amount: 100,
    description: "lab-run1-ec-0001 W1N57 to W10N57 100H",
    targetTick: 400,
    maxFeeEnergy: 26,
    maxSamples: 32,
};

},
"controlRecord": function(exports,module,require){
"use strict";
/**
 * Terminal Transfer Engine Lab Prep I——实验控制记录（仅 single-shot 产物使用）。
 *
 * 任务书 §4.3 边界：
 * - 不写入 Memory.runtime.treasuryCore 或任何生产 Memory 声明（实验侧窄化）；
 * - 固定只存一个 run、控制记录完整 JSON 的 UTF-8 字节数不超过 4096（不存
 *   逐 tick 交易历史、不按 run 追加）；计量为纯 JavaScript 实现，产物不引入
 *   任何 Node 专属编码／文件系统／进程全局；
 * - 缺失/损坏（含超字节）时不自动初始化并发送；正常完成标记 stopped，但不
 *   自动再次武装；
 * - 有界保留到实验世界显式销毁或只读状态下的人工重置——不能以 TTL 重获发送资格。
 *
 * Lab Prep I · Remediation I（Q02）：
 * - writeControlRecord 返回明确结果——调用方可区分"已写入"与"未写入"。
 *   ok:true 只表示赋值语句未抛错；宿主静默丢写（赋值成功但读回旧值）只能
 *   由发送前的读回核对发现，不能只信赋值没 throw。
 * - confirmAttemptedMark 在发送前**重新从控制槽读回数据**（不是比较待写对象
 *   自身或缓存引用），核对本次实验 ID、预期 attemptedTick、attempted===true
 *   以及资格/停止事实无冲突；缺失、错误类型、读回异常、旧值、错误 ID/tick
 *   都不构成匹配。
 * - 形状校验严格化：未知顶层字段与未知 syncResult 字段按 corrupt 拒绝——
 *   不把任意输入展开成无限可增长历史（附加超长 note 的记录在读取阶段即拒，
 *   不再进入写入超限分支；写入函数对超限候选的拒绝仍独立存在）。
 *
 * Lab Prep I · Remediation II（R02：唯一大小语义）：
 * - 度量对象是控制槽值本身的完整 JSON.stringify(record) 结果按 UTF-8 编码
 *   的字节数（含键名、标点、转义与全部结果文本，不只算 error 字段）；外层
 *   Memory 键名不计入。读取、拟写入与发送前读回共用同一 measureUtf8Bytes
 *   实现——不允许 reader 用字符、writer 用字节。
 * - 读取侧新增大小检查：形状合法但完整 JSON 超过 4096 UTF-8 字节的记录按
 *   corrupt 拒绝（零写；不修复/缩短/迁移/重新武装；拒绝读取不等于已回收
 *   现存超限数据）。confirmAttemptedMark 经同一读取入口自动消费该判定。
 * - 写入侧超限拒绝报告 bytes（UTF-8 字节数）并保留 characters 作诊断字段
 *   （UTF-16 code unit 数）——两者单位不同，不得混称。
 *
 * 重要限制：本记录的 Memory read-back 只是普通运行与"控制事实确实保留"的
 * reset 下的防重入/防重试约束，**不是** driver 持久化承诺，更不是 CPU/driver
 * 任意故障下的 exactly-once。未来不确定中断后应先切只读并检查外部持久事实。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LAB_CONTROL_MEMORY_KEY = void 0;
exports.measureUtf8Bytes = measureUtf8Bytes;
exports.readControlRecord = readControlRecord;
exports.writeControlRecord = writeControlRecord;
exports.confirmAttemptedMark = confirmAttemptedMark;
/** 实验 Memory 槽（与生产四个 Memory 根完全无关的独立键）。 */
const CONTROL_MEMORY_KEY = "__labTerminalTransferProbe";
/** 单记录上限（Remediation II：完整 JSON 的 UTF-8 字节数 ≤4096，读写读回同一口径）。 */
const CONTROL_MAX_UTF8_BYTES = 4096;
/**
 * 纯 JavaScript UTF-8 字节计量（R02 唯一大小语义的实现核心）。
 * 输入是 JSON.stringify 的结果字符串——转义（\n、\"、\uXXXX）已是 ASCII
 * 反斜杠序列，直接按 code unit 累加编码宽度即可。孤立代理项按替换字符
 * U+FFFD 计 3 字节（与宿主生态 UTF-8 编码器一致；JSON.stringify 本身会把
 * 孤立代理转义成 \uXXXX，正常流程不会出现该输入，此处仅为纯函数的确定行为）。
 */
function measureUtf8Bytes(serialized) {
    let bytes = 0;
    for (let index = 0; index < serialized.length; index += 1) {
        const code = serialized.charCodeAt(index);
        if (code < 0x80) {
            bytes += 1;
        }
        else if (code < 0x800) {
            bytes += 2;
        }
        else if (code < 0xd800 || code >= 0xe000) {
            bytes += 3;
        }
        else if (code < 0xdc00) {
            // 高代理：下一 code unit 为低代理则合并计 4 字节，否则按孤立代理计 3。
            const next = index + 1 < serialized.length ? serialized.charCodeAt(index + 1) : 0;
            if (next >= 0xdc00 && next < 0xe000) {
                bytes += 4;
                index += 1;
            }
            else {
                bytes += 3;
            }
        }
        else {
            bytes += 3; // 孤立低代理——替换字符宽度
        }
    }
    return bytes;
}
/** 支持的顶层字段（未知字段按 corrupt 拒绝——不展开任意输入）。 */
const CONTROL_TOP_LEVEL_KEYS = new Set([
    "experimentId",
    "armed",
    "attempted",
    "attemptedTick",
    "syncResult",
    "stopped",
]);
/** 支持的 syncResult 字段。 */
const CONTROL_SYNC_RESULT_KEYS = new Set(["ok", "code", "error"]);
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
    if (syncResult !== undefined) {
        if (typeof syncResult !== "object" || syncResult === null)
            return false;
        const sync = syncResult;
        if (typeof sync.ok !== "boolean")
            return false;
        if (sync.code !== undefined && typeof sync.code !== "number")
            return false;
        if (sync.error !== undefined && typeof sync.error !== "string")
            return false;
        for (const key of Object.keys(sync)) {
            if (!CONTROL_SYNC_RESULT_KEYS.has(key))
                return false;
        }
    }
    for (const key of Object.keys(candidate)) {
        if (!CONTROL_TOP_LEVEL_KEYS.has(key))
            return false;
    }
    return true;
}
function describeError(error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
/**
 * 读取控制记录：缺失→absent；形状不符（含未知字段）**或完整 JSON 超过
 * 4096 UTF-8 字节**→corrupt（都不自动初始化、零写、不修复/裁剪）。
 */
function readControlRecord() {
    let raw;
    try {
        raw = Memory[CONTROL_MEMORY_KEY];
    }
    catch (error) {
        console.log(JSON.stringify({
            kind: "lab-control-read-error",
            key: CONTROL_MEMORY_KEY,
            error: describeError(error),
        }));
        return { status: "corrupt" };
    }
    if (raw === undefined)
        return { status: "absent" };
    if (!isControlRecord(raw))
        return { status: "corrupt" };
    // R02：读取侧消费同一字节口径——受支持字段组成的超限记录不再判为健康。
    // 计量无法形成（宿主 getter 二次抛错等）按明确失败处理，不当 0 字节。
    try {
        if (measureUtf8Bytes(JSON.stringify(raw)) > CONTROL_MAX_UTF8_BYTES) {
            return { status: "corrupt" };
        }
    }
    catch {
        return { status: "corrupt" };
    }
    return { status: "ok", record: raw };
}
/**
 * 写回控制记录（单记录覆盖，不追加历史；序列化失败/超限/赋值异常均明确拒绝）。
 * 大小检查用完整序列化字符串的 UTF-8 字节数（与读取/读回同一口径）；计量的
 * JSON 就是随后解析写入槽的那个字符串——不测量一份、写入另一份。
 * ok:true 只代表赋值语句完成——是否真落盘由 confirmAttemptedMark 的读回核对判定。
 */
function writeControlRecord(record) {
    let serialized;
    try {
        serialized = JSON.stringify(record);
    }
    catch (error) {
        console.log(JSON.stringify({
            kind: "lab-control-write-refused",
            key: CONTROL_MEMORY_KEY,
            reason: "serialize_failed",
            error: describeError(error),
        }));
        return { ok: false, reason: "serialize_failed", error: describeError(error) };
    }
    const bytes = measureUtf8Bytes(serialized);
    if (bytes > CONTROL_MAX_UTF8_BYTES) {
        console.log(JSON.stringify({
            kind: "lab-control-write-refused",
            key: CONTROL_MEMORY_KEY,
            reason: "size_limit",
            bytes,
            characters: serialized.length,
            limit: CONTROL_MAX_UTF8_BYTES,
            limitUnits: "utf8-bytes",
        }));
        return { ok: false, reason: "size_limit", bytes, characters: serialized.length };
    }
    try {
        Memory[CONTROL_MEMORY_KEY] = JSON.parse(serialized);
    }
    catch (error) {
        console.log(JSON.stringify({
            kind: "lab-control-write-refused",
            key: CONTROL_MEMORY_KEY,
            reason: "assign_failed",
            error: describeError(error),
        }));
        return { ok: false, reason: "assign_failed", error: describeError(error) };
    }
    return { ok: true };
}
/**
 * 发送前读回核对：重新从控制槽取数据，确认与本次 expected attempted 状态匹配。
 * 不比较待写对象自身或缓存引用；缺失/损坏/读回异常/旧值/错误实验 ID 或 tick
 * 均返回 mismatch（reason 标明差异），调用方必须零发送。
 */
function confirmAttemptedMark(expected) {
    const readback = readControlRecord();
    if (readback.status === "absent")
        return { status: "mismatch", reason: "readback_absent" };
    if (readback.status === "corrupt")
        return { status: "mismatch", reason: "readback_corrupt" };
    const record = readback.record;
    if (record.experimentId !== expected.experimentId) {
        return { status: "mismatch", reason: "readback_experiment_mismatch" };
    }
    if (record.attempted !== true)
        return { status: "mismatch", reason: "readback_not_attempted" };
    if (record.attemptedTick !== expected.attemptedTick) {
        return { status: "mismatch", reason: "readback_tick_mismatch" };
    }
    if (record.armed !== true)
        return { status: "mismatch", reason: "readback_disarmed" };
    if (record.stopped === true)
        return { status: "mismatch", reason: "readback_stopped" };
    return { status: "confirmed" };
}
/** 控制记录键名（probe 离线自测断言用）。 */
exports.LAB_CONTROL_MEMORY_KEY = CONTROL_MEMORY_KEY;

},
"worldRead": function(exports,module,require){
"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.readEndpoint = readEndpoint;
exports.readFeeQuote = readFeeQuote;
exports.readTransactionViews = readTransactionViews;
exports.describeError = describeError;
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

},
"tools/controlProbe": function(exports,module,require){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loop = loop;
/** Read-only preparation entry. Never loads main/singleShot or writes Memory. */
const labConfig_1 = require("../labConfig");
const controlRecord_1 = require("../controlRecord");
const worldRead_1 = require("../worldRead");
let samples = 0;
let lastTick;
function endpoint(side) {
    const reading = (0, worldRead_1.readEndpoint)(labConfig_1.LAB_EXAMPLE_EXPERIMENT, side);
    if (reading.readStatus !== "ok")
        return reading;
    try {
        const room = Game.rooms[reading.roomName];
        const terminal = room.terminal;
        const controller = room.controller;
        return { ...reading, my: terminal.my, isActive: terminal.isActive(), controller: {
                present: controller !== undefined, my: controller?.my, level: controller?.level,
                ownerUsername: controller?.owner?.username,
            } };
    }
    catch (error) {
        return { ...reading, readStatus: "read_error", error: (0, worldRead_1.describeError)(error) };
    }
}
function loop() {
    const tick = Game.time;
    if (tick === lastTick)
        return;
    lastTick = tick;
    if (samples >= 32)
        return; // External controller also has its own finite deadline.
    samples += 1;
    const source = endpoint("source");
    const target = endpoint("target");
    let shard;
    try {
        shard = { name: Game.shard?.name };
    }
    catch (error) {
        shard = { readError: (0, worldRead_1.describeError)(error) };
    }
    console.log(JSON.stringify({
        kind: "lab-control-sample", sampler: { name: "lab-control-probe", version: "1" },
        tick, expectedExperimentId: labConfig_1.LAB_EXAMPLE_EXPERIMENT.experimentId, shard,
        // The actual envelope binds userId; this value comes from the observed owner,
        // NOT from config.username. Final readiness compares both facts externally.
        user: { username: source.ownerUsername }, control: (0, controlRecord_1.readControlRecord)(), source, target,
        feeQuote: (0, worldRead_1.readFeeQuote)(labConfig_1.LAB_EXAMPLE_EXPERIMENT.amount, labConfig_1.LAB_EXAMPLE_EXPERIMENT.sourceRoomName, labConfig_1.LAB_EXAMPLE_EXPERIMENT.targetRoomName),
        transactions: (0, worldRead_1.readTransactionViews)(),
    }));
}

}};
const cache=Object.create(null);
function load(id){
 if(!Object.prototype.hasOwnProperty.call(factories,id)) throw new Error('unregistered probe module: '+id);
 if(cache[id]) return cache[id].exports;
 const m={exports:{}}; cache[id]=m;
 factories[id](m.exports,m,function(name){
  const target=name.startsWith('../') ? name.slice(3) : name.startsWith('./') ? name.slice(2) : '';
  if(!['labConfig','controlRecord','worldRead'].includes(target)) throw new Error('probe dependency refused');
  return load(target);
 });
 return m.exports;
}
exports.loop=load('tools/controlProbe').loop;
})();
