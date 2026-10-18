import { cadenceOffset } from "@/runtime/cadence";
import { runMemoryCleanup } from "@/runtime/memoryCleanup";
import { buildMemoryAuditSnapshot } from "@/runtime/memoryAudit";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createOwnedRoom(name: string): Room {
  return {
    name,
    memory: {} as RoomMemory,
    controller: {
      my: true,
      level: 8,
    } as StructureController,
    find: () => [],
  } as unknown as Room;
}

describe("memory size regression", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time = 17 + cadenceOffset("memory.cleanup", 17);
    Game.creeps = {};
    Game.spawns = {};
    Memory.creeps = {};
    Memory.runtime = undefined;
    Memory.data = undefined;
  });

  it("caps serialized Memory under 500k chars after cleanup of oversized hub distributedSynthesis", () => {
    // Set up two owned rooms
    Game.rooms["E27S28"] = createOwnedRoom("E27S28");
    Game.rooms["E27S29"] = createOwnedRoom("E27S29");

    // Hub config targeting E27S28
    Memory.cfg = {
      hub: {
        enabled: true,
        hubRoomName: "E27S28",
      },
    } as Memory["cfg"];

    // Build oversized distributedSynthesis with 200 items per array
    const dispatchAssignments = Array.from({ length: 200 }, (_, i) => ({
      fromRoom: `E${i}N0`,
      toRoom: "E27S28",
      resource: "XUH2O",
      amount: 5000,
      dispatchedAt: 1000 + i,
    }));

    const routeDecisions = Array.from({ length: 200 }, (_, i) => ({
      fromRoom: `E${i}N0`,
      toRoom: "E27S28",
      viaRoom: `E${i}N1`,
      decidedAt: 1000 + i,
      route: [`E${i}N0`, `E${i}N1`, "E27S28"],
    }));

    const progressEdges = Array.from({ length: 200 }, (_, i) => ({
      product: `XUH2O`,
      step: i,
      status: i % 3 === 0 ? "done" : "pending",
      updatedAt: 1000 + i,
      roomName: `E${i}N0`,
      detail: `edge-detail-${i}`,
    }));

    // roomCapabilities for 5 rooms, only 2 owned
    const roomCapabilities: Record<string, { labs: number; canProduce: string[] }> = {};
    const allRoomNames = ["E27S28", "E27S29", "E30S30", "E31S31", "E32S32"];
    for (const roomName of allRoomNames) {
      roomCapabilities[roomName] = {
        labs: 3,
        canProduce: ["XUH2O", "XKHO2", "XZH2O", "XGHO2"],
      };
    }

    Memory.runtime = {
      hub: {
        status: "importing",
        updatedAt: 100,
        activeProduct: "XUH2O",
        activeStep: 0,
        missingResources: [],
        lastPlanActions: [],
        needsPlan: false,
        distributedSynthesis: {
          dispatchAssignments,
          routeDecisions,
          progressEdges,
          roomCapabilities,
        },
      },
    } as unknown as Memory["runtime"];

    // Record size before cleanup
    const before = buildMemoryAuditSnapshot(Memory);

    // Run cleanup (Game.time = 17, 17 % 17 === 0)
    runMemoryCleanup();

    // Record size after cleanup
    const after = buildMemoryAuditSnapshot(Memory);
    const serializedSize = JSON.stringify(Memory).length;

    // Assert total serialized size under 500k
    expect(serializedSize).toBeLessThan(500_000);

    // Assert distributedSynthesis arrays capped at 100
    const ds = Memory.runtime?.hub?.distributedSynthesis;
    expect(ds).toBeDefined();
    expect(ds!.dispatchAssignments!.length).toBeLessThanOrEqual(100);
    expect(ds!.routeDecisions!.length).toBeLessThanOrEqual(100);
    expect(ds!.progressEdges!.length).toBeLessThanOrEqual(100);

    // Assert non-owned room capabilities removed
    const rc = ds!.roomCapabilities;
    expect(rc).toBeDefined();
    expect(Object.keys(rc!)).not.toContain("E30S30");
    expect(Object.keys(rc!)).not.toContain("E31S31");
    expect(Object.keys(rc!)).not.toContain("E32S32");

    // Assert owned room capabilities preserved
    expect(rc!["E27S28"]).toBeDefined();
    expect(rc!["E27S29"]).toBeDefined();

    // Assert cleanup actually reduced size
    expect(after.totalBytes).toBeLessThan(before.totalBytes);
  });
});
