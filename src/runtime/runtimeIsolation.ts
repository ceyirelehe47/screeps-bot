import { reportRuntimeError } from "@/modules/errorMapper";

const MAX_FAULT_SCOPES = 64;
const FAULT_TTL = 1000;
const REPORT_INTERVAL = 100;
interface RoomFault {
  scope: string;
  message: string;
  lastSeen: number;
  lastReported: number;
  failures: number;
  suppressed: number;
}
const faults = new Map<string, RoomFault>();

/** 可捕获的单房异常不得中断后续房间。关键防御每 tick 重试，不做熔断。 */
export function forEachIsolatedRoom(phase: "towerControl" | "homeDefense", rooms: readonly Room[], work: (room: Room) => void): void {
  for (const room of rooms) {
    try {
      work(room);
    } catch (error) {
      const scope = `${phase}:${room.name}`;
      let message: string;
      try { message = String(error instanceof Error ? error.message : error).slice(0, 240); }
      catch { message = "无法格式化的异常"; }
      let fault = faults.get(scope);
      if (!fault || Game.time < fault.lastSeen || Game.time - fault.lastSeen > FAULT_TTL) {
        if (faults.size >= MAX_FAULT_SCOPES) faults.delete(faults.keys().next().value!);
        fault = { scope, message, lastSeen: Game.time, lastReported: -Infinity, failures: 0, suppressed: 0 };
        faults.set(scope, fault);
      }
      const report = fault.message !== message || Game.time - fault.lastReported >= REPORT_INTERVAL;
      fault.message = message;
      fault.lastSeen = Game.time;
      fault.failures++;
      if (report) {
        fault.lastReported = Game.time;
        // 报告设施本身也不能破坏房间隔离。
        try { reportRuntimeError(scope, error); } catch { /* 下个房间继续执行。 */ }
      } else fault.suppressed++;
    }
  }
}

/** 样本只保留最近的八个异常范围，heap 上限与日志限频互相独立。 */
export function getRuntimeRoomFaults(): RoomFault[] {
  for (const [scope, fault] of faults) if (Game.time - fault.lastSeen > FAULT_TTL) faults.delete(scope);
  return [...faults.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 8).map(fault => ({ ...fault }));
}

export function resetRuntimeIsolationForTest(): void { faults.clear(); }
