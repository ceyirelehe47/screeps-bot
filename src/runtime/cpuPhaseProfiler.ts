import {
  normalizeCpuMonitorConfig,
  persistCpuMonitorSample,
  captureCpuMonitorHeap,
  getCpuMonitorHistory,
} from "@/runtime/cpuMonitor";
import type { CpuMonitorSnapshotV2, CpuMonitorRoomSummary } from "@/runtime/cpuMonitor";

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

function createNoopProfiler(): TickCpuProfiler {
  return {
    measure<T>(_phase: string, fn: () => T): T {
      return fn();
    },
    recordFixedAction(_phase: string, _count = 1): void {
      return;
    },
    measureCreep(_creep: Creep, fn: () => void): void {
      fn();
    },
    measureRoomPhase<T>(_phase: string, _roomName: string, fn: () => T): T {
      return fn();
    },
    flush(): void {
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

export function measureCreepDecision<T>(fn: () => T): T {
  return measureCpuPhase("creepWork:decision", fn);
}

export function measureCreepPathing<T>(fn: () => T): T {
  return measureCpuPhase("creepWork:pathing", fn);
}

export function measureCreepIntent<T>(fn: () => T): T {
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

  // Zero-overhead: enabled but non-sample tick never calls Game.cpu.getUsed()
  if (Game.time % config.sampleInterval !== 0) {
    return createNoopProfiler();
  }

  // Sample tick: measure CPU with full instrumentation
  const loopStartUsed = Game.cpu.getUsed();
  const phases: Record<string, number> = {};
  const fixedActionCounts: Record<string, number> = {};
  const rooms: Record<string, CpuMonitorRoomSummary> = {};
  // roomRoleAggregation=false 时不逐 creep 成对计时：顶层 creepWork phase
  // 仍由 measure() 覆盖总开销，fixed action count 照常记录。
  const perCreepTiming = config.roomRoleAggregation;

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
      const start = Game.cpu.getUsed();
      try {
        return fn();
      } finally {
        const delta = Math.max(0, Game.cpu.getUsed() - start);
        phases[phase] = (phases[phase] || 0) + delta;
      }
    },

    recordFixedAction(phase: string, count = 1): void {
      fixedActionCounts[phase] = (fixedActionCounts[phase] || 0) + count;
    },

    measureCreep(creep: Creep, fn: () => void): void {
      if (!perCreepTiming) {
        fn();
        return;
      }
      const start = Game.cpu.getUsed();
      try {
        fn();
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
      const totalUsed = Math.max(0, Game.cpu.getUsed() - loopStartUsed);
      const tracked = Object.values(phases).reduce((sum, used) => sum + used, 0);
      const untracked = Math.max(0, totalUsed - tracked);
      const heap = captureCpuMonitorHeap(config);

      const snapshot: CpuMonitorSnapshotV2 = {
        tick: Game.time,
        shard: Game.shard.name,
        totalUsed,
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
    },
  };
}
