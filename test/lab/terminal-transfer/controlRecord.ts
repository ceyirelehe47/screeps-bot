/**
 * Terminal Transfer Engine Lab Prep I——实验控制记录（仅 single-shot 产物使用）。
 *
 * 任务书 §4.3 边界：
 * - 不写入 Memory.runtime.treasuryCore 或任何生产 Memory 声明（实验侧窄化）；
 * - 固定只存一个 run、序列化不超过 4KiB（字符数口径，ASCII 下与字节数相等；
 *   产物不引入 Node 专属 Buffer 依赖）、不存逐 tick 交易历史、不按 run 追加；
 * - 缺失/损坏时不自动初始化并发送；正常完成标记 stopped，但不自动再次武装；
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
 * 重要限制：本记录的 Memory read-back 只是普通运行与"控制事实确实保留"的
 * reset 下的防重入/防重试约束，**不是** driver 持久化承诺，更不是 CPU/driver
 * 任意故障下的 exactly-once。未来不确定中断后应先切只读并检查外部持久事实。
 */

/** 一次性实验控制事实（单一 run；字段构成防重入约束，不是环境安全凭证）。 */
export interface LabControlRecord {
  readonly experimentId: string;
  readonly armed: boolean;
  readonly attempted: boolean;
  readonly attemptedTick?: number;
  readonly syncResult?: {
    readonly ok: boolean;
    readonly code?: number;
    readonly error?: string;
  };
  readonly stopped?: boolean;
}

export type LabControlRead = {
  readonly status: "absent";
} | {
  readonly status: "corrupt";
} | {
  readonly status: "ok";
  readonly record: LabControlRecord;
};

/**
 * 写入结果：调用方据此区分"已写入"与"未写入"（含拒绝原因）。
 * 注：扁平结构（ok:false 时 reason 必有）——本仓库 non-strict 配置下
 * 判别联合不收窄，联合形式会让调用侧取 reason 报 TS2339。
 */
export interface LabControlWrite {
  readonly ok: boolean;
  readonly reason?: "serialize_failed" | "size_limit" | "assign_failed";
  readonly characters?: number;
  readonly error?: string;
}

/** 发送前读回核对结果：confirmed 才允许进入实际 send 调用边界。 */
export type AttemptedMarkConfirmation =
  | { readonly status: "confirmed" }
  | { readonly status: "mismatch"; readonly reason: string };

/** 实验 Memory 槽（与生产四个 Memory 根完全无关的独立键）。 */
const CONTROL_MEMORY_KEY = "__labTerminalTransferProbe";
/** 单记录序列化上限（§4.3：不超过 4KiB——JSON.stringify 的 .length 字符数口径）。 */
const CONTROL_MAX_CHARACTERS = 4096;

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

function isControlRecord(value: unknown): value is LabControlRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.experimentId !== "string") return false;
  if (typeof candidate.armed !== "boolean" || typeof candidate.attempted !== "boolean") return false;
  if (candidate.attemptedTick !== undefined && typeof candidate.attemptedTick !== "number") return false;
  if (candidate.stopped !== undefined && typeof candidate.stopped !== "boolean") return false;
  const syncResult = candidate.syncResult;
  if (syncResult !== undefined) {
    if (typeof syncResult !== "object" || syncResult === null) return false;
    const sync = syncResult as Record<string, unknown>;
    if (typeof sync.ok !== "boolean") return false;
    if (sync.code !== undefined && typeof sync.code !== "number") return false;
    if (sync.error !== undefined && typeof sync.error !== "string") return false;
    for (const key of Object.keys(sync)) {
      if (!CONTROL_SYNC_RESULT_KEYS.has(key)) return false;
    }
  }
  for (const key of Object.keys(candidate)) {
    if (!CONTROL_TOP_LEVEL_KEYS.has(key)) return false;
  }
  return true;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** 读取控制记录：缺失→absent；形状不符（含未知字段）→corrupt（都不自动初始化）。 */
export function readControlRecord(): LabControlRead {
  let raw: unknown;
  try {
    raw = (Memory as unknown as Record<string, unknown>)[CONTROL_MEMORY_KEY];
  } catch (error) {
    console.log(
      JSON.stringify({
        kind: "lab-control-read-error",
        key: CONTROL_MEMORY_KEY,
        error: describeError(error),
      }),
    );
    return { status: "corrupt" };
  }
  if (raw === undefined) return { status: "absent" };
  if (!isControlRecord(raw)) return { status: "corrupt" };
  return { status: "ok", record: raw };
}

/**
 * 写回控制记录（单记录覆盖，不追加历史；序列化失败/超限/赋值异常均明确拒绝）。
 * ok:true 只代表赋值语句完成——是否真落盘由 confirmAttemptedMark 的读回核对判定。
 */
export function writeControlRecord(record: LabControlRecord): LabControlWrite {
  let serialized: string;
  try {
    serialized = JSON.stringify(record);
  } catch (error) {
    console.log(
      JSON.stringify({
        kind: "lab-control-write-refused",
        key: CONTROL_MEMORY_KEY,
        reason: "serialize_failed",
        error: describeError(error),
      }),
    );
    return { ok: false, reason: "serialize_failed", error: describeError(error) };
  }
  if (serialized.length > CONTROL_MAX_CHARACTERS) {
    console.log(
      JSON.stringify({
        kind: "lab-control-write-refused",
        key: CONTROL_MEMORY_KEY,
        reason: "size_limit",
        characters: serialized.length,
        limit: CONTROL_MAX_CHARACTERS,
      }),
    );
    return { ok: false, reason: "size_limit", characters: serialized.length };
  }
  try {
    (Memory as unknown as Record<string, unknown>)[CONTROL_MEMORY_KEY] = JSON.parse(serialized);
  } catch (error) {
    console.log(
      JSON.stringify({
        kind: "lab-control-write-refused",
        key: CONTROL_MEMORY_KEY,
        reason: "assign_failed",
        error: describeError(error),
      }),
    );
    return { ok: false, reason: "assign_failed", error: describeError(error) };
  }
  return { ok: true };
}

/**
 * 发送前读回核对：重新从控制槽取数据，确认与本次 expected attempted 状态匹配。
 * 不比较待写对象自身或缓存引用；缺失/损坏/读回异常/旧值/错误实验 ID 或 tick
 * 均返回 mismatch（reason 标明差异），调用方必须零发送。
 */
export function confirmAttemptedMark(expected: {
  readonly experimentId: string;
  readonly attemptedTick: number;
}): AttemptedMarkConfirmation {
  const readback = readControlRecord();
  if (readback.status === "absent") return { status: "mismatch", reason: "readback_absent" };
  if (readback.status === "corrupt") return { status: "mismatch", reason: "readback_corrupt" };
  const record = readback.record;
  if (record.experimentId !== expected.experimentId) {
    return { status: "mismatch", reason: "readback_experiment_mismatch" };
  }
  if (record.attempted !== true) return { status: "mismatch", reason: "readback_not_attempted" };
  if (record.attemptedTick !== expected.attemptedTick) {
    return { status: "mismatch", reason: "readback_tick_mismatch" };
  }
  if (record.armed !== true) return { status: "mismatch", reason: "readback_disarmed" };
  if (record.stopped === true) return { status: "mismatch", reason: "readback_stopped" };
  return { status: "confirmed" };
}

/** 控制记录键名（probe 离线自测断言用）。 */
export const LAB_CONTROL_MEMORY_KEY = CONTROL_MEMORY_KEY;
