import type { CreepStepResult, RoleLifecycle } from "@/types/system";
import { getMoveIntentReceipt } from "@/movement/traffic";

type DeferredStep = Extract<CreepStepResult, { kind: "sleep" }> | NonNullable<Extract<CreepStepResult, { kind: "continue" }>["sticky"]>;
interface Entry { logic: RoleLifecycle; stage: "source" | "target"; position: string; at: number; until: number; deferred: DeferredStep }
const entries = new Map<string, Entry>();
const key = (creep: Creep) => creep.id ?? creep.name;
const position = (creep: Creep) => `${creep.room.name}:${creep.pos.x}:${creep.pos.y}`;

export function clearCreepExecution(creep: Creep): void { entries.delete(key(creep)); }
export function resetCreepExecutionForTest(): void { entries.clear(); }

/** 休眠/粘性动作仅存 heap；配置实例、阶段、位置变化或重置后恢复正常角色决策。 */
export function runCreepStep(creep: Creep, logic: RoleLifecycle, stage: "source" | "target"): CreepStepResult {
  const id = key(creep), previous = entries.get(id);
  if (previous) {
    const sameContext = previous.logic === logic && previous.stage === stage && previous.position === position(creep);
    if (sameContext && Game.time === previous.at) return { kind: "continue" };
    const valid = sameContext &&
      Game.time > previous.at && Game.time < previous.until && !getMoveIntentReceipt(creep);
    if (valid) {
      const deferred = previous.deferred;
      if ("kind" in deferred && deferred.kind === "sleep") {
        if (!deferred.wake?.(creep)) return { kind: "continue" };
      } else if ("run" in deferred && deferred.run(creep)) {
        previous.at = Game.time;
        return { kind: "continue" };
      }
    }
    entries.delete(id);
  }
  const result: CreepStepResult = logic.step ? logic.step(creep, stage) : {
    kind: (stage === "target" ? logic.target(creep) : logic.source ? logic.source(creep) : true) ? "transition" : "continue",
  };
  const deferred = result.kind === "sleep" ? result : result.kind === "continue" ? result.sticky : undefined;
  if (deferred && !getMoveIntentReceipt(creep) && Number.isSafeInteger(deferred.until) && deferred.until > Game.time) {
    entries.delete(id);
    while (entries.size >= 256) entries.delete(entries.keys().next().value!);
    entries.set(id, { logic, stage, position: position(creep), at: Game.time,
      until: Math.min(Game.time + 25, deferred.until), deferred });
  }
  return result;
}

/** 旧布局仍可读；只删除可由默认值重建的空字段，不动跨房参数、货物收据或任务身份。 */
export function compactCreepMemory(memory: CreepMemory): number {
  let removed = 0;
  if (memory.ready === false) { delete memory.ready; removed++; }
  if (memory.working === false) { delete memory.working; removed++; }
  if (Array.isArray(memory.roleArgs) && memory.roleArgs.length === 0) { delete memory.roleArgs; removed++; }
  const legacy = memory as CreepMemory & { _move?: unknown };
  if (legacy._move !== undefined) { delete legacy._move; removed++; }
  return removed;
}
