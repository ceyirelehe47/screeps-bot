import { reportRuntimeError } from "@/modules/errorMapper";
import { getMemoryService } from "@/runtime/runtimeServices";

const MAX_FAULT_SCOPES = 64;
const FAULT_TTL = 1000;
const REPORT_INTERVAL = 100;
const NOTIFY_AFTER_FAILURES = 10;
export interface RoomFault {
  scope: string;
  message: string;
  lastSeen: number;
  lastReported: number;
  failures: number;
  suppressed: number;
  kind?: string;
  streak?: number;
  lastNotifiedAt?: number;
  retryAt?: number;
}
export interface DefenseFaultSummary { updatedAt: number; faults: RoomFault[]; lastNotifiedAt?: number }
const faults = new Map<string, RoomFault>();
let loadedPersistentFaults = false;
let housekeepingAt = -1;
let lastNotifiedAt = -Infinity;

function isCurrentFault(value: RoomFault): boolean {
  return !!value && typeof value.scope === "string" && value.scope.length <= 200 &&
    typeof value.message === "string" && value.message.length <= 240 &&
    [value.lastSeen, value.lastReported, value.failures, value.suppressed].every(number => Number.isSafeInteger(number) && number >= 0) &&
    value.lastReported <= value.lastSeen && value.lastSeen <= Game.time && Game.time - value.lastSeen <= FAULT_TTL;
}

function heapSnapshot(): RoomFault[] {
  return [...faults.values()].reverse().sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 8).map(fault => ({ ...fault }));
}

/** 故障摘要由本模块单写；诊断写失败仍不能阻断防御。 */
function persistFaults(): void {
  try {
    const runtime = getMemoryService().ensureRuntime();
    const rows = heapSnapshot();
    if (rows.length) runtime.defenseFaults = { updatedAt: Game.time, faults: rows,
      ...(Number.isFinite(lastNotifiedAt) ? { lastNotifiedAt } : {}) };
    else delete runtime.defenseFaults;
  } catch { /* heap 与控制台仍可供诊断。 */ }
}

/** 每 tick 最多清理一次；profiler 关闭也会从防御入口执行，不在健康路径创建根。 */
function prepareFaultStore(): void {
  if (housekeepingAt === Game.time) return;
  housekeepingAt = Game.time;
  try {
    const stored = Memory.runtime?.defenseFaults;
    const current = Array.isArray(stored?.faults) ? stored.faults.slice(0, 8).filter(isCurrentFault) : [];
    if (!loadedPersistentFaults) {
      loadedPersistentFaults = true;
      if (Number.isSafeInteger(stored?.lastNotifiedAt) && stored!.lastNotifiedAt! <= Game.time) lastNotifiedAt = stored!.lastNotifiedAt!;
      for (const fault of current) faults.set(fault.scope, { ...fault });
    }
    for (const [scope, fault] of faults) if (fault.lastSeen > Game.time || Game.time - fault.lastSeen > FAULT_TTL) faults.delete(scope);
    if (stored && (!Array.isArray(stored.faults) || current.length !== stored.faults.length)) persistFaults();
  } catch { /* 无法读取摘要时，仍执行关键防御。 */ }
}

function recordFault(scope: string, error: unknown): void {
  let message: string;
  let kind: string;
  try { message = String(error instanceof Error ? error.message : error).slice(0, 240); }
  catch { message = "无法格式化的异常"; }
  try { kind = error instanceof Error ? error.name.slice(0, 64) : typeof error; }
  catch { kind = "unknown"; }
  let fault = faults.get(scope);
  if (!fault || Game.time < fault.lastSeen || Game.time - fault.lastSeen > FAULT_TTL) {
    if (!fault && faults.size >= MAX_FAULT_SCOPES) faults.delete(faults.keys().next().value!);
    fault = { scope, message, lastSeen: Game.time, lastReported: -Infinity, failures: 0, suppressed: 0 };
  }
  const report = fault.kind !== kind || Game.time - fault.lastReported >= REPORT_INTERVAL;
  if (fault.kind !== kind || !fault.streak) fault.streak = 1;
  else if (fault.lastSeen !== Game.time) fault.streak = Math.min(1_000_000_000, fault.streak + 1);
  fault.kind = kind;
  fault.message = message;
  fault.lastSeen = Game.time;
  fault.failures = Math.min(1_000_000_000, fault.failures + 1);
  if (report) fault.lastReported = Game.time;
  else fault.suppressed = Math.min(1_000_000_000, fault.suppressed + 1);
  faults.delete(scope); faults.set(scope, fault);
  if (fault.streak >= NOTIFY_AFTER_FAILURES && Game.time - (fault.lastNotifiedAt ?? -Infinity) >= FAULT_TTL &&
      Game.time - lastNotifiedAt >= REPORT_INTERVAL && typeof Game.notify === "function") {
    try {
      Game.notify(`[runtime] ${scope} 连续 ${fault.streak} 次执行失败: ${message}`);
      fault.lastNotifiedAt = lastNotifiedAt = Game.time;
    } catch { /* 通知失败也不能中断关键防御。 */ }
  }
  persistFaults();
  if (report) {
    try { reportRuntimeError(scope, error); } catch { /* 继续下一座塔或房间。 */ }
  }
}

function recordSuccess(scope: string): void {
  const fault = faults.get(scope);
  if (fault?.streak || fault?.retryAt) { fault.streak = 0; delete fault.retryAt; persistFaults(); }
}

/** 规划与动作均可包在单塔边界；失败仅跳过该塔当次操作，下 tick 继续尝试。 */
export function runIsolatedTowerOperation<T>(roomName: string, towerId: string, work: () => T): T | undefined {
  prepareFaultStore();
  try { const result = work(); recordSuccess(`towerControl:${roomName}:${towerId}`.slice(0, 200)); return result; }
  catch (error) { recordFault(`towerControl:${roomName}:${towerId}`.slice(0, 200), error); return undefined; }
}

/** 可捕获的单房异常不得中断后续房间。关键防御每 tick 重试，不做熔断。 */
export function runIsolatedRoomOperation<T>(phase: string, roomName: string, work: () => T,
  options: { circuit?: boolean } = {}): T | undefined {
  prepareFaultStore();
  const scope = `${phase}:${roomName}`.slice(0, 200);
  const previous = faults.get(scope);
  if (options.circuit && previous?.retryAt && previous.retryAt > Game.time && previous.retryAt <= Game.time + 100) return undefined;
  try { const result = work(); recordSuccess(scope); return result; }
  catch (error) {
    recordFault(scope, error);
    const fault = faults.get(scope);
    if (options.circuit && fault && (fault.streak ?? 0) >= 3) {
      fault.retryAt = Game.time + Math.min(100, 2 ** Math.min(7, (fault.streak ?? 3) - 2));
      persistFaults();
    }
    return undefined;
  }
}

/** T2–T4 房间连续失败时有界退避；成功探测立即恢复，T0/T1 入口不读取熔断许可。 */
export function runIsolatedRoutineRoomOperation<T>(phase: string, roomName: string, work: () => T): T | undefined {
  return runIsolatedRoomOperation(phase, roomName, work, { circuit: true });
}

export function forEachIsolatedRoom(phase: string, rooms: readonly Room[], work: (room: Room) => void): void {
  for (const room of rooms) {
    runIsolatedRoomOperation(phase, room.name, () => work(room));
  }
  prepareFaultStore();
}

/** 样本只保留最近的八个异常范围，heap 上限与日志限频互相独立。 */
export function getRuntimeRoomFaults(): RoomFault[] {
  prepareFaultStore();
  return heapSnapshot();
}

export function resetRuntimeIsolationForTest(): void { faults.clear(); loadedPersistentFaults = false; housekeepingAt = -1; lastNotifiedAt = -Infinity; }
