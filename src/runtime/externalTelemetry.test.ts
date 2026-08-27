import { clearCreepMovementStateForTest, clearMovementAnalyticsForTest, ensureCreepMovementState, getMovementAnalyticsForTest } from "@/movement";
import { recordMovementMetric } from "@/movement/metrics";
import { runExternalTelemetryExport } from "@/runtime/externalTelemetry";
import { resetCpuMonitorStore } from "@/runtime/cpuMonitor";
import {
  clearWorkerTaskBoardForTest,
  getWorkerTasksByRoom,
} from "@/runtime/workerTaskPool";
import type { WorkerTask } from "@/types/system";

function makeV2Snapshot(overrides: Partial<{
  tick: number;
  shard: string;
  totalUsed: number;
  bucket: number;
  limit: number;
  tickLimit: number;
  phases: Record<string, number>;
  fixedActionCounts: Record<string, number>;
  untracked: number;
  emaTotalUsed: number;
  rooms: Record<string, { totalUsed: number; roles: Record<string, { count: number; used: number }> }>;
  heap: { used_heap_size: number; total_heap_size: number; heap_size_limit: number } | null;
}> = {}) {
  return {
    tick: overrides.tick ?? 100,
    shard: overrides.shard ?? "shardTest",
    totalUsed: overrides.totalUsed ?? 12.5,
    bucket: overrides.bucket ?? 9000,
    limit: overrides.limit ?? 20,
    tickLimit: overrides.tickLimit ?? 500,
    phases: overrides.phases ?? { creepWork: 5.0, spawnWork: 3.0 },
    fixedActionCounts: overrides.fixedActionCounts ?? { creepWork: 10 },
    untracked: overrides.untracked ?? 2.5,
    emaTotalUsed: overrides.emaTotalUsed ?? 11.8,
    rooms: overrides.rooms ?? {},
    heap: overrides.heap ?? null,
  };
}

function setupBasicEnv() {
  clearWorkerTaskBoardForTest();
  Game.time = 5;
  Memory.cfg = {
    telemetry: {
      enabled: true,
      sampleInterval: 1,
      segmentId: 42,
    },
  };
  clearMovementAnalyticsForTest();
  Game.rooms = {
    W1N1: {
      name: "W1N1",
      controller: { my: true, level: 3, progress: 50 } as StructureController,
      energyAvailable: 300,
      energyCapacityAvailable: 550,
    } as Room,
  };
  Game.creeps = {};
  Memory.data = undefined;
  Game.shard = { name: "shardTest" } as Game["shard"];
  Game.gcl = {
    level: 5,
    progress: 123,
    progressTotal: 456,
  } as Game["gcl"];
  Game.cpu = {
    getUsed: jest.fn(() => 1.5),
    bucket: 9000,
    limit: 20,
    tickLimit: 500,
  } as unknown as typeof Game.cpu;
  (global as typeof global & { RawMemory: typeof RawMemory }).RawMemory = {
    segments: {},
    setActiveSegments: jest.fn(),
  } as unknown as typeof RawMemory;
}

function workerTask(id: string, type: WorkerTask["type"]): WorkerTask {
  return {
    id,
    type,
    targetId: `${id}:target`,
    roomName: "W1N1",
    priority: 300,
    assignedCreeps: [],
    maxAssignees: 1,
    status: "active",
    updatedAt: Game.time,
  };
}

describe("runExternalTelemetryExport Worker task observation", () => {
  beforeEach(() => {
    setupBasicEnv();
    resetCpuMonitorStore();
    Memory.analytics = undefined;
  });

  afterEach(() => {
    resetCpuMonitorStore();
    clearWorkerTaskBoardForTest();
  });

  it("does not materialize the private Worker board while observing an empty room", () => {
    const runtimeGlobal = global as typeof global & {
      __workerTaskBoard?: unknown;
    };
    expect(runtimeGlobal.__workerTaskBoard).toBeUndefined();

    runExternalTelemetryExport();

    expect(runtimeGlobal.__workerTaskBoard).toBeUndefined();
    expect(JSON.parse(RawMemory.segments[42]).rooms[0]).toMatchObject({
      roomName: "W1N1",
      taskQueueDepth: 0,
      buildTasks: 0,
      repairTasks: 0,
      upgradeTasks: 0,
    });
  });

  it("preserves Worker task counts when reading an existing room store", () => {
    const tasks = getWorkerTasksByRoom("W1N1");
    tasks.build = workerTask("build", "build");
    tasks.repair = workerTask("repair", "repair");
    tasks.upgrade = workerTask("upgrade", "upgrade");

    runExternalTelemetryExport();

    expect(JSON.parse(RawMemory.segments[42]).rooms[0]).toMatchObject({
      roomName: "W1N1",
      taskQueueDepth: 3,
      buildTasks: 1,
      repairTasks: 1,
      upgradeTasks: 1,
    });
  });
});

describe("runExternalTelemetryExport movement analytics", () => {
  beforeEach(() => {
    setupBasicEnv();
    resetCpuMonitorStore();
    Memory.analytics = undefined;
  });

  afterEach(() => {
    resetCpuMonitorStore();
    clearMovementAnalyticsForTest();
  });

  it("exports multi-room segment counters additively in totals and room buckets", () => {
    recordMovementMetric("pathRequests", "W1N1", 2);
    recordMovementMetric("multiRoomSearches", "W1N1");
    recordMovementMetric("multiRoomSegmentHits", "W1N1", 3);
    recordMovementMetric("multiRoomSegmentInvalidations", "W1N1");

    runExternalTelemetryExport();

    const payload = JSON.parse(RawMemory.segments[42]);
    expect(payload.version).toBe(2);
    expect(payload.totals.movement).toMatchObject({
      pathRequests: 2,
      multiRoomSearches: 1,
      multiRoomSegmentHits: 3,
      multiRoomSegmentInvalidations: 1,
    });
    expect(payload.rooms[0].movement).toMatchObject({
      pathRequests: 2,
      multiRoomSearches: 1,
      multiRoomSegmentHits: 3,
      multiRoomSegmentInvalidations: 1,
    });
  });

  it("keeps the existing optional telemetry shape when no movement bucket exists", () => {
    runExternalTelemetryExport();

    const payload = JSON.parse(RawMemory.segments[42]);
    expect(payload.version).toBe(2);
    expect(payload.totals.movement).toBeUndefined();
    expect(payload.rooms[0].movement).toBeUndefined();
  });

  it("normalizes a hot-loaded legacy movement snapshot before telemetry reads it", () => {
    const legacyBucket = {
      pathRequests: 2,
      pathCacheHits: 1,
      pathRepaths: 0,
      yieldPushes: 0,
      travelRequests: 4,
      travelFallbacks: 0,
      travelRepaths: 0,
      exitRecoveries: 0,
      stateClears: 0,
    };
    const runtimeGlobal = global as typeof global & { __movementAnalytics?: unknown };
    runtimeGlobal.__movementAnalytics = {
      updatedAt: Game.time,
      totals: { ...legacyBucket },
      rooms: { W9N9: { ...legacyBucket } },
    };

    runExternalTelemetryExport();

    const payload = JSON.parse(RawMemory.segments[42]);
    expect(payload.totals.movement).toMatchObject({
      pathRequests: 2,
      multiRoomSearches: 0,
      multiRoomSegmentHits: 0,
      multiRoomSegmentInvalidations: 0,
    });
    expect(payload.movementRooms.W9N9).toMatchObject({
      travelRequests: 4,
      multiRoomSearches: 0,
      multiRoomSegmentHits: 0,
      multiRoomSegmentInvalidations: 0,
    });
  });

  it("repairs a partially migrated v2 bucket before recording a new metric", () => {
    const partialBucket = {
      pathRequests: 0,
      pathCacheHits: 0,
      pathRepaths: 0,
      yieldPushes: 0,
      travelRequests: 1,
      travelFallbacks: 0,
      travelRepaths: 0,
      exitRecoveries: 0,
      stateClears: 0,
    };
    const runtimeGlobal = global as typeof global & { __movementAnalytics?: unknown };
    runtimeGlobal.__movementAnalytics = {
      version: 2,
      updatedAt: Game.time,
      totals: { ...partialBucket },
      rooms: { W9N9: { ...partialBucket } },
    };

    recordMovementMetric("multiRoomSearches", "W9N9");
    runExternalTelemetryExport();

    const payload = JSON.parse(RawMemory.segments[42]);
    expect(payload.totals.movement.multiRoomSearches).toBe(1);
    expect(payload.movementRooms.W9N9.multiRoomSearches).toBe(1);
  });

  it("exports at most sixteen deterministic movement buckets including remote rooms", () => {
    for (let index = 0; index < 18; index += 1) {
      recordMovementMetric("travelRequests", `W${index}N9`, index + 1);
    }

    runExternalTelemetryExport();

    const movementRooms = JSON.parse(RawMemory.segments[42]).movementRooms;
    expect(Object.keys(movementRooms)).toHaveLength(16);
    expect(movementRooms.W17N9.travelRequests).toBe(18);
    expect(movementRooms.W2N9.travelRequests).toBe(3);
    expect(movementRooms.W0N9).toBeUndefined();
    expect(movementRooms.W1N9).toBeUndefined();
  });

  it("prioritizes recently active remote rooms over historically large stale buckets", () => {
    for (let index = 0; index < 16; index += 1) {
      recordMovementMetric("travelRequests", `W${index}N8`, 1_000 + index);
    }
    Game.time += 5;
    recordMovementMetric("multiRoomSearches", "W99N99");

    runExternalTelemetryExport();

    const movementRooms = JSON.parse(RawMemory.segments[42]).movementRooms;
    expect(Object.keys(movementRooms)).toHaveLength(16);
    expect(movementRooms.W99N99.multiRoomSearches).toBe(1);
    expect(movementRooms.W0N8).toBeUndefined();
  });

  it("saturates totals and room counters while rejecting non-finite increments", () => {
    recordMovementMetric("travelRequests", "W9N9");
    const analytics = getMovementAnalyticsForTest();
    analytics.totals.multiRoomSegmentHits = Number.MAX_SAFE_INTEGER - 1;
    analytics.rooms.W9N9.multiRoomSegmentHits = Number.MAX_SAFE_INTEGER - 1;

    recordMovementMetric("multiRoomSegmentHits", "W9N9", 10);
    recordMovementMetric("multiRoomSegmentHits", "W9N9", Number.POSITIVE_INFINITY);
    recordMovementMetric("multiRoomSegmentHits", "W9N9", Number.NaN);

    // pending 跨 tick 聚合，同一 tick 内显式读取强制 flush 后观察。
    const updated = getMovementAnalyticsForTest();
    expect(updated.totals.multiRoomSegmentHits).toBe(Number.MAX_SAFE_INTEGER);
    expect(updated.rooms.W9N9.multiRoomSegmentHits).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("runExternalTelemetryExport cpu monitor v2", () => {
  beforeEach(() => {
    setupBasicEnv();
    resetCpuMonitorStore();
    Memory.analytics = undefined;
  });

  afterEach(() => {
    resetCpuMonitorStore();
    clearCreepMovementStateForTest();
  });

  it("does not throw when no cpu monitor data exists and has no legacy moduleCpu", () => {
    expect(() => runExternalTelemetryExport()).not.toThrow();

    const payload = JSON.parse(RawMemory.segments[42]);
    expect(payload.moduleCpu).toBeUndefined();
    expect(payload.cpuMonitor).toBeUndefined();
  });

  it("computes fixedActionEstimate from fixedActionCounts * config.fixedActionCpuCost", () => {
    const snap = makeV2Snapshot({
      fixedActionCounts: { creepWork: 25, otherAction: 10 },
    });
    Memory.cfg!.cpuProfiler = { fixedActionCpuCost: 0.3 };
    Memory.analytics = {
      cpuMonitor: {
        version: 2,
        updatedAt: 100,
        sampleInterval: 10,
        historyLimit: 120,
        latest: snap,
        summary: null,
      },
    } as unknown as Memory["analytics"];

    runExternalTelemetryExport();

    const payload = JSON.parse(RawMemory.segments[42]);
    expect(payload.cpuMonitor.latest.fixedActionEstimate).toBeCloseTo(35 * 0.3, 4);
  });
});

describe("runExternalTelemetryExport cpu payload size", () => {
  beforeEach(() => {
    setupBasicEnv();
    resetCpuMonitorStore();
    Memory.analytics = undefined;
  });

  afterEach(() => {
    resetCpuMonitorStore();
    clearCreepMovementStateForTest();
  });

  it("compacts large payload to fit within 95KB segment limit", () => {
    const phases: Record<string, number> = {};
    for (let i = 0; i < 30; i++) {
      phases[`phase_${i.toString().padStart(2, "0")}`] = 0.5 + i * 0.1;
    }

    const rooms: Record<string, { totalUsed: number; roles: Record<string, { count: number; used: number }> }> = {};
    for (let i = 0; i < 10; i++) {
      const roomName = `W${i}N${i}`;
      const roles: Record<string, { count: number; used: number }> = {};
      for (let j = 0; j < 5; j++) {
        roles[`role_${j}`] = { count: 2 + j, used: 1.0 + j * 0.5 };
      }
      rooms[roomName] = { totalUsed: 5.0 + i, roles };
    }

    const fixedActionCounts: Record<string, number> = {};
    for (let i = 0; i < 15; i++) {
      fixedActionCounts[`action_${i}`] = i + 1;
    }

    const store = (global as typeof global & { __cpuMonitor?: { history: unknown[]; emaTotalUsed: number; seeded: boolean } }).__cpuMonitor;
    if (store) {
      store.history = Array.from({ length: 20 }, (_, i) =>
        makeV2Snapshot({
          tick: 100 + i,
          totalUsed: 15 + i * 0.5,
          phases,
          fixedActionCounts,
          emaTotalUsed: 14.0 + i * 0.2,
          rooms,
          heap: { used_heap_size: 50_000_000, total_heap_size: 80_000_000, heap_size_limit: 200_000_000 },
        }),
      );
      store.emaTotalUsed = 17.0;
      store.seeded = true;
    }

    Memory.analytics = {
      cpuMonitor: {
        version: 2,
        updatedAt: 119,
        sampleInterval: 10,
        historyLimit: 120,
        latest: makeV2Snapshot({
          tick: 119,
          totalUsed: 25.0,
          phases,
          fixedActionCounts,
          emaTotalUsed: 17.0,
          rooms,
          heap: { used_heap_size: 50_000_000, total_heap_size: 80_000_000, heap_size_limit: 200_000_000 },
        }),
        summary: {
          ticks: 20,
          avgTotalUsed: 20.0,
          maxTotalUsed: 25.0,
          minBucket: 8500,
          maxBucket: 9500,
          avgBucket: 9000,
          avgUntracked: 3.0,
          avgPhases: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, v * 0.9])),
          avgFixedActionCounts: Object.fromEntries(Object.entries(fixedActionCounts).map(([k, v]) => [k, v * 0.8])),
          emaTotalUsed: 17.0,
        },
      },
    } as unknown as Memory["analytics"];

    const gameRooms: Record<string, Room> = {};
    for (let i = 0; i < 10; i++) {
      const roomName = `W${i}N${i}`;
      gameRooms[roomName] = {
        name: roomName,
        controller: { my: true, level: 4 + (i % 4), progress: 100 * i } as StructureController,
        energyAvailable: 300 + i * 50,
        energyCapacityAvailable: 550 + i * 100,
      } as Room;
    }
    Game.rooms = gameRooms;
    recordMovementMetric("multiRoomSearches", "W99N99", 7);

    runExternalTelemetryExport();

    const payload = RawMemory.segments[42];
    expect(payload.length).toBeLessThanOrEqual(95_000);

    const parsed = JSON.parse(payload);
    expect(parsed.version).toBe(2);
    expect(parsed.cpuMonitor).toBeDefined();
    expect(parsed.cpuMonitor.version).toBe(2);
    expect(parsed.movementRooms.W99N99.multiRoomSearches).toBe(7);
  });
});
