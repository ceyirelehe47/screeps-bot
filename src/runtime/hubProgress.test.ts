import {
  buildHubProgressSnapshot,
  renderHubProgressOverlays,
  resetHubVisualCacheForTests,
} from "@/runtime/hubProgress";
import { registerRuntimeServices } from "@/runtime/runtimeServices";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function makeMockTask(
  overrides: Partial<{
    id: string;
    resource: ResourceConstant;
    fromRoomName: string;
    toRoomName: string;
    remainingAmount: number;
    status: "pending" | "done" | "cancelled" | "failed";
    reason: string;
    createdAt: number;
    updatedAt: number;
    lastProgressAt: number;
    blockedReason: "receiver_capacity" | "source_depleted" | "insufficient_terminal_resource_or_fee";
    blockedSince: number;
  }> = {},
): Record<string, any> {
  return {
    id: overrides.id || "task-1",
    resource: overrides.resource || RESOURCE_ENERGY,
    fromRoomName: overrides.fromRoomName || "W1N1",
    toRoomName: overrides.toRoomName || "W2N1",
    amount: 1000,
    remainingAmount: overrides.remainingAmount ?? 500,
    status: overrides.status || "pending",
    createdAt: overrides.createdAt ?? 100,
    updatedAt: overrides.updatedAt ?? 100,
    origin: "automatic",
    lastProgressAt: overrides.lastProgressAt ?? overrides.updatedAt ?? 100,
    blockedReason: overrides.blockedReason,
    blockedSince: overrides.blockedSince,
    reason: overrides.reason,
    lastError: undefined,
  };
}

describe("buildHubProgressSnapshot", () => {
  beforeEach(() => {
    resetRuntimeServices();
    registerRuntimeServices();
  });

  it("projects only bounded Hub protection attempt and component markers", () => {
    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: true, hubRoomName: "W1N1" },
      hubRuntime: {
        status: "idle",
        currentProtectionAttempt: {
          attemptRevision: 8,
          configIncarnation: 3,
          startedAt: 198,
          finishedAt: 199,
          configFingerprint: "hubcfg-v1:test",
          status: "committed",
          valid: true,
        },
        committedProtectionSnapshot: {
          schema: "hub-protection-snapshot-v1",
          planRevision: 8,
          configIncarnation: 3,
          observedAt: 199,
          expiresAt: 209,
          configFingerprint: "hubcfg-v1:test",
          status: "committed",
          valid: true,
          marker: {
            revision: 8,
            configIncarnation: 3,
            configFingerprint: "hubcfg-v1:test",
            hubRoomName: "W1N1",
            planMode: "distributed",
            targetCompounds: [RESOURCE_CATALYZED_GHODIUM_ACID],
            hubReservePerCompound: 5_000,
          },
          synthesisConfig: {
            revision: 8,
            configIncarnation: 3,
            configFingerprint: "hubcfg-v1:test",
            rooms: { W1N1: { reactions: [] } },
          },
          transferTasks: {
            revision: 8,
            configIncarnation: 3,
            configFingerprint: "hubcfg-v1:test",
            tasks: [{
              id: "large-task-not-projected",
              resource: RESOURCE_UTRIUM,
              fromRoomName: "W2N1",
              toRoomName: "W1N1",
              amount: 1_000,
              remainingAmount: 1_000,
              status: "pending",
            }],
          },
          distributed: {
            revision: 8,
            configIncarnation: 3,
            configFingerprint: "hubcfg-v1:test",
            dispatchAssignments: [],
            routeDecisions: [],
            allocationLedger: {},
          },
          baseMineralSurplus: {
            revision: 8,
            configIncarnation: 3,
            configFingerprint: "hubcfg-v1:test",
            byRoom: { W1N1: { [RESOURCE_UTRIUM]: 25_000 } },
          },
        },
      },
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: null,
      currentTick: 200,
    });

    expect(snapshot.protectionAttempt).toEqual({
      attemptRevision: 8,
      configIncarnation: 3,
      startedAt: 198,
      finishedAt: 199,
      configFingerprint: "hubcfg-v1:test",
      status: "committed",
      valid: true,
    });
    expect(snapshot.committedProtectionMarker).toEqual({
      schema: "hub-protection-snapshot-v1",
      planRevision: 8,
      configIncarnation: 3,
      observedAt: 199,
      expiresAt: 209,
      configFingerprint: "hubcfg-v1:test",
      status: "committed",
      valid: true,
      marker: {
        revision: 8,
        configIncarnation: 3,
        configFingerprint: "hubcfg-v1:test",
        hubRoomName: "W1N1",
        planMode: "distributed",
      },
      components: {
        synthesisConfig: { revision: 8, configIncarnation: 3, configFingerprint: "hubcfg-v1:test" },
        transferTasks: { revision: 8, configIncarnation: 3, configFingerprint: "hubcfg-v1:test" },
        distributed: { revision: 8, configIncarnation: 3, configFingerprint: "hubcfg-v1:test" },
        baseMineralSurplus: { revision: 8, configIncarnation: 3, configFingerprint: "hubcfg-v1:test" },
      },
    });
    expect(JSON.stringify(snapshot.committedProtectionMarker)).not.toContain("large-task-not-projected");
    expect(JSON.stringify(snapshot.committedProtectionMarker)).not.toContain("25000");
    expect(JSON.stringify(snapshot.committedProtectionMarker)).not.toContain(
      RESOURCE_CATALYZED_GHODIUM_ACID,
    );
  });

  it("projects Hub task direction, ages and blocker lifecycle without dropping legacy fields", () => {
    const snapshot = buildHubProgressSnapshot({
      hubConfig: { enabled: true, hubRoomName: "W1N1" },
      hubRuntime: { status: "distributing" },
      synthesisRuntime: null,
      hubStorageStore: null,
      hubTerminalStore: null,
      resourceControlRooms: null,
      transferTasks: {
        export: makeMockTask({
          id: "export",
          resource: RESOURCE_CATALYZED_GHODIUM_ACID,
          fromRoomName: "W1N1",
          toRoomName: "W2N1",
          remainingAmount: 750,
          reason: "hub:export:XGH2O",
          createdAt: 100,
          updatedAt: 160,
          lastProgressAt: 175,
          blockedReason: "insufficient_terminal_resource_or_fee",
          blockedSince: 200,
        }),
      } as any,
      currentTick: 250,
    });

    expect(snapshot.pendingExports).toBe(1);
    expect(snapshot.pendingTasks).toEqual([
      expect.objectContaining({
        resource: RESOURCE_CATALYZED_GHODIUM_ACID,
        from: "W1N1",
        to: "W2N1",
        remaining: 750,
        reason: "hub:export:XGH2O",
        classification: "export",
        createdAt: 100,
        updatedAt: 160,
        lastProgressAt: 175,
        age: 150,
        lastProgressAge: 75,
        blockedReason: "insufficient_terminal_resource_or_fee",
        blockedSince: 200,
        blockedAge: 50,
      }),
    ]);
  });
});

describe("renderHubProgressOverlays", () => {
  it("默认关闭、低 bucket 暂停、到期即停，均不扫描房间或创建绘图", () => {
    Game.cpu = { bucket: 10000, limit: 120, tickLimit: 500, getUsed: () => 0 } as typeof Game.cpu;
    const find = jest.fn(() => []);
    Game.rooms = { W1N1: { name: "W1N1", controller: { my: true }, find } as any };
    const hub = Memory.cfg!.hub!;
    delete hub.visuals;
    expect(renderHubProgressOverlays()).toBeNull();
    hub.visuals = { enabled: true };
    Game.cpu.bucket = 7999;
    expect(renderHubProgressOverlays()).toBeNull();
    Game.cpu.bucket = 8000;
    hub.visuals.untilTick = Game.time;
    expect(renderHubProgressOverlays()).toBeNull();
    expect(find).not.toHaveBeenCalled();
    expect((global as any).__roomVisualCalls).toHaveLength(0);
    hub.visuals.untilTick = Game.time + 1;
    expect(renderHubProgressOverlays()).not.toBeNull();
    Game.time++;
    expect(renderHubProgressOverlays()).toBeNull();
  });

  beforeEach(() => {
    resetRuntimeServices();
    registerRuntimeServices();
    resetHubVisualCacheForTests();
    (global as any).__resetRoomVisualCalls();
    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: "W1N1",
        targetCompounds: ["XGH2O" as ResourceConstant],
        visuals: { enabled: true, minBucket: 0 },
      },
    };
    Memory.runtime = {
      hub: {
        status: "idle",
        updatedAt: 0,
        activeProduct: "",
        activeStep: 0,
        missingResources: [],
        lastPlanActions: [],
        needsPlan: false,
      },
    };
    Memory.data = { resourceControl: { tasks: {} } };
    Memory.analytics = {};
    Game.time = 100;
    Game.rooms = {};
  });

  it("reuses snapshots below five ticks, refreshes at the TTL boundary, and invalidates on status", () => {
    Game.cpu = { bucket: 5000, limit: 500, used: 0, tickLimit: 500, getUsed: () => 0 } as any;
    const find = jest.fn(() => []);
    Game.rooms = {
      W1N1: {
        name: "W1N1",
        controller: { my: true },
        storage: { store: { energy: 100000 } },
        terminal: { store: { energy: 20000 } },
        find,
      } as any,
    };

    renderHubProgressOverlays();
    Game.time = 104;
    renderHubProgressOverlays();
    expect(find).toHaveBeenCalledTimes(1);

    Game.time = 105;
    renderHubProgressOverlays();
    expect(find).toHaveBeenCalledTimes(2);

    Game.time = 106;
    Memory.runtime!.hub!.status = "blocked";
    renderHubProgressOverlays();
    expect(find).toHaveBeenCalledTimes(3);
  });

  it("keeps real calls within budget and prioritizes blocked satellites before the hard cap", () => {
    Game.cpu = { bucket: 5000, limit: 500, used: 0, tickLimit: 500, getUsed: () => 0 } as any;
    Game.time = 101;
    const satelliteNames = ["W2N1", "W3N1", "W4N1", "W5N1", "W6N1", "W7N1", "W8N1", "W9N1"];
    Game.rooms = {
      W1N1: { name: "W1N1", controller: { my: true }, find: () => [] } as any,
      ...Object.fromEntries(satelliteNames.map((roomName) => [
        roomName,
        { name: roomName, controller: { my: true }, find: () => [] } as any,
      ])),
    };
    Memory.runtime!.hub!.distributedSynthesis = {
      dispatchAssignments: satelliteNames.map((roomName) => ({
        roomName,
        product: RESOURCE_UTRIUM_HYDRIDE,
        targetAmount: 1000,
        isHubRoom: false,
      })),
      routeDecisions: [],
      progressEdges: [],
    };
    Memory.runtime!.synthesisControl = {
      updatedAt: 101,
      generatedTaskCount: 0,
      failedTaskCount: 0,
      successfulRunCount: 0,
      lastActions: [],
      bindings: {},
      rooms: Object.fromEntries(satelliteNames.map((roomName) => [
        roomName,
        {
          stage: roomName === "W9N1" ? "blocked" : "synthesizing",
          activeProduct: RESOURCE_UTRIUM_HYDRIDE,
          reagentLabIds: [],
          productLabIds: [],
          successfulRuns: 0,
          pendingTasks: 0,
          lastTransitionAt: 100,
          ...(roomName === "W9N1" ? { lastError: "missing reagent" } : {}),
        },
      ])),
    } as any;

    const stats = renderHubProgressOverlays();
    const calls: Array<{ roomName: string; method: string; args: any[] }> =
      (global as any).__roomVisualCalls;
    const headers = calls.filter(
      (call) => call.method === "text" && String(call.args[0]).startsWith("Production:"),
    );

    expect(stats).toEqual(expect.objectContaining({ satellitePanels: 6, skippedSatellitePanels: 2 }));
    expect(stats!.callsUsed).toBe(calls.length);
    expect(stats!.callsUsed).toBeLessThanOrEqual(80);
    expect(headers.some((call) => call.roomName === "W9N1")).toBe(true);
    expect(headers.some((call) => call.roomName === "W8N1")).toBe(false);
  });
});
