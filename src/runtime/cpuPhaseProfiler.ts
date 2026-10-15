import {
  normalizeCpuMonitorConfig,
  persistCpuMonitorSample,
  captureCpuMonitorHeap,
  getCpuMonitorHistory,
} from "@/runtime/cpuMonitor";
import type { CpuMonitorSnapshotV2, CpuMonitorRoomSummary } from "@/runtime/cpuMonitor";
import { beginCpuTickHealth, markCpuTickPhase, markCpuTickCreep, completeCpuTickHealth } from "@/runtime/cpuTickHealth";

export interface TickCpuProfiler {
  measure<T>(phase: string, fn: () => T): T;
  recordFixedAction(phase: string, count?: number): void;
  measureCreep(creep: Creep, fn: () => void): void;
  measureRoomPhase<T>(phase: string, roomName: string, fn: () => T): T;
  flush(): void;
}

let activeTickCpuProfiler: TickCpuProfiler = createNoopProfiler();

/**
 * @deprecated Use `getCpuMonitorHistory()` from `cpuMonitor.ts` for v2 history.
 * Returns v2 snapshots which are a structural superset of the legacy `CpuPhaseSnapshot`.
 */
export function getCpuPhaseHistory(): CpuMonitorSnapshotV2[] {
  return getCpuMonitorHistory();
}

function createNoopProfiler(trackHealth = false): TickCpuProfiler {
  return {
    measure<T>(_phase: string, fn: () => T): T {
      if (trackHealth) markCpuTickPhase(_phase);
      return fn();
    },
    recordFixedAction(_phase: string, _count = 1): void {
      return;
    },
    measureCreep(_creep: Creep, fn: () => void): void {
      if (trackHealth) markCpuTickCreep(_creep.name);
      fn();
      if (trackHealth) markCpuTickCreep();
    },
    measureRoomPhase<T>(_phase: string, _roomName: string, fn: () => T): T {
      return fn();
    },
    flush(): void {
      if (trackHealth) completeCpuTickHealth();
      return;
    },
  };
}

export function setActiveTickCpuProfiler(profiler: TickCpuProfiler): void {
  activeTickCpuProfiler = profiler;
}

export function measureCpuPhase<T>(phase: string, fn: () => T): T {
  return activeTickCpuProfiler.measure(phase, fn);
}

// 细分计时上下文只保留当前 Game / tick；采样条件与 createTickCpuProfiler 一致。
// PB 诊断不依赖逐 creep 聚合开关，也不在非采样 tick 覆盖 health 的业务阶段。
interface CpuPhaseTimingContext {
  game: typeof Game;
  tick: number;
  sampled: boolean;
  perCreep: boolean;
  labels: string[];
}

let phaseTimingContext: CpuPhaseTimingContext | undefined;

function getCpuPhaseTimingContext(): CpuPhaseTimingContext {
  if (!phaseTimingContext || phaseTimingContext.game !== Game || phaseTimingContext.tick !== Game.time) {
    const config = normalizeCpuMonitorConfig(Memory.cfg?.cpuProfiler);
    const sampled = config.enabled && Game.time % config.sampleInterval === 0;
    phaseTimingContext = {
      game: Game,
      tick: Game.time,
      sampled,
      perCreep: sampled && config.roomRoleAggregation,
      labels: [],
    };
  }
  return phaseTimingContext;
}

/** 同步诊断 span：稳定标签按调用路径汇总 inclusive CPU，异常时也恢复路径。 */
export function measureSampledCpuPhase<T>(label: string, fn: () => T): T {
  const context = getCpuPhaseTimingContext();
  if (!context.sampled) return fn();
  context.labels.push(label);
  try {
    return measureCpuPhase(context.labels.join("/"), fn);
  } finally {
    context.labels.pop();
  }
}

export function isPerCreepPhaseTimingEnabled(): boolean {
  return getCpuPhaseTimingContext().perCreep;
}

/** 仅供测试：同一 tick 内切换 Memory.cfg 后强制重算开关。 */
export function resetPerCreepPhaseTimingCacheForTest(): void {
  phaseTimingContext = undefined;
}

export function measureCreepDecision<T>(fn: () => T): T {
  if (!isPerCreepPhaseTimingEnabled()) {
    return fn();
  }
  return measureCpuPhase("creepWork:decision", fn);
}

export function measureCreepPathing<T>(fn: () => T): T {
  if (!isPerCreepPhaseTimingEnabled()) {
    return fn();
  }
  return measureCpuPhase("creepWork:pathing", fn);
}

export function measureCreepIntent<T>(fn: () => T): T {
  if (!isPerCreepPhaseTimingEnabled()) {
    // fixed-action count 与计时无关，关闭细分计时时照常记录。
    const result = fn();
    if (result === OK) {
      activeTickCpuProfiler.recordFixedAction("creepWork");
    }
    return result;
  }
  return measureCpuPhase("creepWork:intent", () => {
    const result = fn();
    if (result === OK) {
      activeTickCpuProfiler.recordFixedAction("creepWork");
    }
    return result;
  });
}

export function recordFixedCpuAction(phase: string, count = 1): void {
  if (count <= 0) {
    return;
  }
  activeTickCpuProfiler.recordFixedAction(phase, count);
}

export function createTickCpuProfiler(): TickCpuProfiler {
  const config = normalizeCpuMonitorConfig(Memory.cfg?.cpuProfiler);

  // Zero-overhead: disabled profiler never calls Game.cpu.getUsed()
  if (!config.enabled) {
    return createNoopProfiler();
  }
  beginCpuTickHealth();

  // Zero-overhead: enabled but non-sample tick never calls Game.cpu.getUsed()
  if (Game.time % config.sampleInterval !== 0) {
    return createNoopProfiler(true);
  }

  // Sample tick: measure CPU with full instrumentation
  const loopStartUsed = Game.cpu.getUsed();
  const phases: Record<string, number> = {};
  const fixedActionCounts: Record<string, number> = {};
  const rooms: Record<string, CpuMonitorRoomSummary> = {};
  // roomRoleAggregation=false 时不逐 creep 成对计时：顶层 creepWork phase
  // 仍由 measure() 覆盖总开销，fixed action count 照常记录。
  const perCreepTiming = config.roomRoleAggregation;
  let measurementDepth = 0;
  let topLevelUsed = 0;

  function ensureRoom(roomName: string): CpuMonitorRoomSummary {
    if (!rooms[roomName]) {
      rooms[roomName] = { totalUsed: 0, roles: {} };
    }
    return rooms[roomName];
  }

  function recordRoomRole(roomName: string, role: string, delta: number): void {
    const room = ensureRoom(roomName);
    room.totalUsed += delta;
    if (!room.roles[role]) {
      room.roles[role] = { count: 0, used: 0 };
    }
    room.roles[role].used += delta;
    room.roles[role].count += 1;
  }

  return {
    measure<T>(phase: string, fn: () => T): T {
      if (measurementDepth === 0) markCpuTickPhase(phase);
      measurementDepth += 1;
      const start = Game.cpu.getUsed();
      try {
        return fn();
      } finally {
        measurementDepth -= 1;
        const delta = Math.max(0, Game.cpu.getUsed() - start);
        phases[phase] = (phases[phase] || 0) + delta;
        if (measurementDepth === 0) topLevelUsed += delta;
      }
    },

    recordFixedAction(phase: string, count = 1): void {
      fixedActionCounts[phase] = (fixedActionCounts[phase] || 0) + count;
    },

    measureCreep(creep: Creep, fn: () => void): void {
      markCpuTickCreep(creep.name);
      if (!perCreepTiming) {
        fn();
        markCpuTickCreep();
        return;
      }
      const start = Game.cpu.getUsed();
      try {
        fn();
        markCpuTickCreep();
      } finally {
        const delta = Math.max(0, Game.cpu.getUsed() - start);
        const role = creep.memory?.role || "unknown";
        const roomName = creep.room?.name || creep.pos?.roomName || "unknown";
        recordRoomRole(roomName, role, delta);
      }
    },

    measureRoomPhase<T>(phase: string, roomName: string, fn: () => T): T {
      const start = Game.cpu.getUsed();
      try {
        return fn();
      } finally {
        const delta = Math.max(0, Game.cpu.getUsed() - start);
        recordRoomRole(roomName, "spawn", delta);
      }
    },

    flush(): void {
      const tickUsedAtFlush = Game.cpu.getUsed();
      const totalUsed = Math.max(0, tickUsedAtFlush - loopStartUsed);
      const untracked = Math.max(0, totalUsed - topLevelUsed);
      const heap = captureCpuMonitorHeap(config);

      const snapshot: CpuMonitorSnapshotV2 = {
        tick: Game.time,
        shard: Game.shard.name,
        totalUsed,
        startupUsed: loopStartUsed,
        tickUsedAtFlush,
        topLevelUsed,
        bucket: Game.cpu.bucket,
        limit: Game.cpu.limit,
        tickLimit: Game.cpu.tickLimit,
        phases: { ...phases },
        fixedActionCounts: { ...fixedActionCounts },
        untracked,
        emaTotalUsed: 0, // overwritten by persistCpuMonitorSample
        rooms: Object.fromEntries(
          Object.entries(rooms).map(([name, room]) => [
            name,
            {
              totalUsed: room.totalUsed,
              roles: Object.fromEntries(
                Object.entries(room.roles).map(([role, summary]) => [role, { ...summary }]),
              ),
            },
          ]),
        ),
        heap,
      };

      persistCpuMonitorSample(snapshot, config);
      completeCpuTickHealth();
    },
  };
}
