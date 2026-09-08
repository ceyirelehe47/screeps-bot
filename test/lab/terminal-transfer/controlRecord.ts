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

/** 实验 Memory 槽（与生产四个 Memory 根完全无关的独立键）。 */
const CONTROL_MEMORY_KEY = "__labTerminalTransferProbe";
/** 单记录序列化上限（§4.3：不超过 4KiB）。 */
const CONTROL_MAX_BYTES = 4096;

function isControlRecord(value: unknown): value is LabControlRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.experimentId !== "string") return false;
  if (typeof candidate.armed !== "boolean" || typeof candidate.attempted !== "boolean") return false;
  if (candidate.attemptedTick !== undefined && typeof candidate.attemptedTick !== "number") return false;
  if (candidate.stopped !== undefined && typeof candidate.stopped !== "boolean") return false;
  const syncResult = candidate.syncResult;
  if (
    syncResult !== undefined &&
    (typeof syncResult !== "object" || syncResult === null || typeof (syncResult as Record<string, unknown>).ok !== "boolean")
  ) {
    return false;
  }
  return true;
}

/** 读取控制记录：缺失→absent；形状不符→corrupt（都不自动初始化）。 */
export function readControlRecord(): LabControlRead {
  let raw: unknown;
  try {
    raw = (Memory as unknown as Record<string, unknown>)[CONTROL_MEMORY_KEY];
  } catch (error) {
    console.log(
      JSON.stringify({
        kind: "lab-control-read-error",
        key: CONTROL_MEMORY_KEY,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }),
    );
    return { status: "corrupt" };
  }
  if (raw === undefined) return { status: "absent" };
  if (!isControlRecord(raw)) return { status: "corrupt" };
  return { status: "ok", record: raw };
}

/** 写回控制记录（单记录覆盖，不追加历史；超限拒写并留痕）。 */
export function writeControlRecord(record: LabControlRecord): void {
  try {
    const serialized = JSON.stringify(record);
    if (serialized.length > CONTROL_MAX_BYTES) {
      console.log(
        JSON.stringify({
          kind: "lab-control-write-refused",
          key: CONTROL_MEMORY_KEY,
          bytes: serialized.length,
          limit: CONTROL_MAX_BYTES,
        }),
      );
      return;
    }
    (Memory as unknown as Record<string, unknown>)[CONTROL_MEMORY_KEY] = JSON.parse(serialized);
  } catch (error) {
    console.log(
      JSON.stringify({
        kind: "lab-control-write-refused",
        key: CONTROL_MEMORY_KEY,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }),
    );
  }
}

/** 控制记录键名（probe 离线自测断言用）。 */
export const LAB_CONTROL_MEMORY_KEY = CONTROL_MEMORY_KEY;
