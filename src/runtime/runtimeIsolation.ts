import { reportRuntimeError } from "@/modules/errorMapper";
import { getMemoryService } from "@/runtime/runtimeServices";

const MAX_FAULT_SCOPES = 64;
const FAULT_TTL = 1000;
const REPORT_INTERVAL = 100;
export interface RoomFault {
  scope: string;
  message: string;
  lastSeen: number;
  lastReported: number;
  failures: number;
  suppressed: number;
}
export interface DefenseFaultSummary { updatedAt: number; faults: RoomFault[] }
const faults = new Map<string, RoomFault>();
let loadedPersistentFaults = false;
let housekeepingAt = -1;

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
    if (rows.length) runtime.defenseFaults = { updatedAt: Game.time, faults: rows };
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
      for (const fault of current) faults.set(fault.scope, { ...fault });
    }
    for (const [scope, fault] of faults) if (fault.lastSeen > Game.time || Game.time - fault.lastSeen > FAULT_TTL) faults.delete(scope);
    if (stored && (!Array.isArray(stored.faults) || current.length !== stored.faults.length)) persistFaults();
  } catch { /* 无法读取摘要时，仍执行关键防御。 */ }
}

function recordFault(scope: string, error: unknown): void {
  let message: string;
  try { message = String(error instanceof Error ? error.message : error).slice(0, 240); }
  catch { message = "无法格式化的异常"; }
  let fault = faults.get(scope);
  if (!fault || Game.time < fault.lastSeen || Game.time - fault.lastSeen > FAULT_TTL) {
    if (!fault && faults.size >= MAX_FAULT_SCOPES) faults.delete(faults.keys().next().value!);
    fault = { scope, message, lastSeen: Game.time, lastReported: -Infinity, failures: 0, suppressed: 0 };
  }
  const report = fault.message !== message || Game.time - fault.lastReported >= REPORT_INTERVAL;
  fault.message = message;
  fault.lastSeen = Game.time;
  fault.failures = Math.min(1_000_000_000, fault.failures + 1);
  if (report) fault.lastReported = Game.time;
  else fault.suppressed = Math.min(1_000_000_000, fault.suppressed + 1);
  faults.delete(scope); faults.set(scope, fault);
  persistFaults();
  if (report) {
    try { reportRuntimeError(scope, error); } catch { /* 继续下一座塔或房间。 */ }
  }
}

/** 规划与动作均可包在单塔边界；失败仅跳过该塔当次操作，下 tick 继续尝试。 */
export function runIsolatedTowerOperation<T>(roomName: string, towerId: string, work: () => T): T | undefined {
  prepareFaultStore();
  try { return work(); }
  catch (error) { recordFault(`towerControl:${roomName}:${towerId}`.slice(0, 200), error); return undefined; }
}

/** 可捕获的单房异常不得中断后续房间。关键防御每 tick 重试，不做熔断。 */
export function forEachIsolatedRoom(phase: "towerControl" | "homeDefense", rooms: readonly Room[], work: (room: Room) => void): void {
  prepareFaultStore();
  for (const room of rooms) {
    try {
      work(room);
    } catch (error) {
      recordFault(`${phase}:${room.name}`.slice(0, 200), error);
    }
  }
}

/** 样本只保留最近的八个异常范围，heap 上限与日志限频互相独立。 */
export function getRuntimeRoomFaults(): RoomFault[] {
  prepareFaultStore();
  return heapSnapshot();
}

export function resetRuntimeIsolationForTest(): void { faults.clear(); loadedPersistentFaults = false; housekeepingAt = -1; }
