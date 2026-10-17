import { PROCESS_SPECS, RUNTIME_PROCESSES, type RuntimeProcessId } from "@/runtime/processTable";
import { isDue } from "@/runtime/cadence";
import { getMemoryService } from "@/runtime/runtimeServices";
import { markCpuTickPhase } from "@/runtime/cpuTickHealth";

export interface ProcessSchedulerMemory {
  updatedAt: number;
  estimates: Record<string, number>;
  circuits: Record<string, { failures: number; until: number }>;
  deferred: Record<string, number>;
  failures: Record<string, number>;
  lastDeferred: Array<{ phase: string; reason: "bucket" | "cpu" | "reset" | "circuit" | "dependency" | "cadence" }>;
}
let state: ProcessSchedulerMemory | undefined;
let resetAt: number | undefined;
let game: typeof Game | undefined;

function ensureState(): ProcessSchedulerMemory {
  if (!state || game !== Game || state.updatedAt > Game.time) {
    game = Game; resetAt = Game.time;
    const stored = Memory.runtime?.processScheduler;
    const known = (source: Record<string, number> | undefined) => Object.fromEntries(
      Object.entries(source ?? {}).filter(([id, value]) => PROCESS_SPECS.has(id) && Number.isFinite(value) && value >= 0));
    state = { updatedAt: Game.time, estimates: known(stored?.estimates), deferred: known(stored?.deferred),
      failures: known(stored?.failures), circuits: {}, lastDeferred: [] };
    for (const [id, circuit] of Object.entries(stored?.circuits ?? {})) {
      if (PROCESS_SPECS.has(id) && Number.isSafeInteger(circuit.failures) && circuit.failures >= 0 &&
          Number.isSafeInteger(circuit.until) && circuit.until <= Game.time + 100) state.circuits[id] = { ...circuit };
    }
  }
  return state;
}

/** 每 tick 一个执行器；T0/T1 永不按预算或故障熔断，预留其后续 EMA 成本。 */
export function createProcessScheduler(measure: (phase: string, work: () => void) => void, onError: (phase: string, error: unknown) => void) {
  const current = ensureState();
  current.lastDeferred = [];
  const completed = new Set<string>();
  const attempted = new Set<string>();
  const estimate = (id: string) => current.estimates[id] ?? (id === "creepWork" ? Math.max(10, Game.cpu.limit * 0.5) : id === "marketSalePreflight" ? 13 : 1);
  const remainingCritical = () => RUNTIME_PROCESSES.filter(spec => (spec.tier === "T0" || spec.tier === "T1") && !attempted.has(spec.id))
    .reduce((sum, spec) => sum + estimate(spec.id), estimate("treasuryEndTick") + 5);
  const defer = (phase: string, reason: ProcessSchedulerMemory["lastDeferred"][number]["reason"]) => {
    current.deferred[phase] = Math.min(1_000_000_000, (current.deferred[phase] ?? 0) + 1);
    current.lastDeferred.push({ phase, reason });
  };
  function runPhase(phase: string, work: () => void): void {
    const spec = PROCESS_SPECS.get(phase);
    if (!spec) throw new Error(`unregistered process: ${phase}`);
    const critical = spec.tier === "T0" || spec.tier === "T1";
    if (!critical) {
      if (!isDue(phase, spec.every)) return defer(phase, "cadence");
      if (spec.requires?.some(id => !completed.has(id))) return defer(phase, "dependency");
      if ((current.circuits[phase]?.until ?? 0) > Game.time) return defer(phase, "circuit");
      if (Game.cpu.bucket < spec.minBucket) return defer(phase, "bucket");
      if ((spec.tier === "T3" || spec.tier === "T4") && Game.time < resetAt! + 2) return defer(phase, "reset");
      const allowance = Math.min(Game.cpu.limit * 0.5, Math.max(0, Game.cpu.bucket - 2000) / 50);
      const ceiling = Math.min(Game.cpu.tickLimit - 10, Game.cpu.limit + allowance);
      if (Game.cpu.getUsed() + estimate(phase) + remainingCritical() >= ceiling) return defer(phase, "cpu");
    }
    attempted.add(phase);
    markCpuTickPhase(phase);
    const start = Game.cpu.getUsed();
    try {
      measure(phase, work);
      completed.add(phase);
      delete current.circuits[phase];
    } catch (error) {
      current.failures[phase] = Math.min(1_000_000_000, (current.failures[phase] ?? 0) + 1);
      if (!critical) {
        const failures = (current.circuits[phase]?.failures ?? 0) + 1;
        current.circuits[phase] = { failures, until: failures < 3 ? Game.time : Game.time + Math.min(100, 2 ** Math.min(failures, 6)) };
      }
      try { onError(phase, error); } catch { /* 报告设施故障也不能阻断后续关键阶段。 */ }
    } finally {
      const cost = Math.max(0, Game.cpu.getUsed() - start);
      current.estimates[phase] = (current.estimates[phase] ?? cost) * 0.9 + cost * 0.1;
    }
  }
  return {
    runPhase,
    runAll(work: Record<RuntimeProcessId, () => void>): void {
      for (const spec of RUNTIME_PROCESSES) runPhase(spec.id, work[spec.id]);
    },
    finish(): void {
      current.updatedAt = Game.time;
      getMemoryService().ensureRuntime().processScheduler = current;
    },
  };
}

export function resetProcessSchedulerForTest(): void { state = undefined; game = undefined; resetAt = undefined; }
