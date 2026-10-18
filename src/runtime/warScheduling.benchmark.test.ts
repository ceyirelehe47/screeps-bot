import { requestSpawn } from "@/runtime/spawnRequests";
jest.mock("@/runtime/powerBankObserver", () => ({ ...jest.requireActual("@/runtime/powerBankObserver"), requestCombatObservation: jest.fn(() => true) }));
import { appendFileSync } from "node:fs";
import { startWarRoom, runWarControl, configureWarRebuildWatch } from "./warControl";
import { createMockStore, MockPos } from "@mock/powerBank";

describe("战争调度固定负载 A/B", () => {
  it.each([false, true])("三个目标、150 live + 100 历史 creep、三个 spawn，共享小队=%s", shared => {
    delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
    Game.time = 1000; Memory.cfg = {}; Memory.runtime = {}; Memory.analytics = {}; Memory.data = {}; Memory.creeps = {};
    Game.creeps = {}; Game.spawns = {}; Game.flags = {};
    const source = { name: "E1N57", controller: { my: true, level: 8 }, energyCapacityAvailable: 12900,
      storage: { store: createMockStore({}) }, terminal: { store: createMockStore({}) }, find: () => [] } as unknown as Room;
    Game.rooms = { E1N57: source };
    for (let i = 0; i < 3; i++) Game.spawns[`spawn${i}`] = { name: `spawn${i}`, room: source, owner: { username: "me" }, memory: { spawnList: [] }, spawning: null,
      isActive: () => true, addTask(name: string) { requestSpawn(this as StructureSpawn, name); } } as unknown as StructureSpawn;
    for (let i = 0; i < 250; i++) {
      const memory = { role: "worker", configName: `worker:${i}` } as CreepMemory; Memory.creeps[`worker${i}`] = memory;
      if (i < 150) Game.creeps[`worker${i}`] = { name: `worker${i}`, memory, room: source, pos: new MockPos(25, 25, source.name), body: [] } as unknown as Creep;
    }
    const targets = ["E3N57", "E2N54", "E3N53"];
    for (const name of targets) {
      const spawn = { id: `enemy-${name}`, structureType: STRUCTURE_SPAWN, owner: { username: "TooAngel" }, pos: new MockPos(20, 20, name) };
      Game.rooms[name] = { name, controller: { level: 8, owner: { username: "TooAngel" } }, find: (kind: FindConstant) => kind === FIND_HOSTILE_STRUCTURES || kind === FIND_STRUCTURES ? [spawn] : [] } as unknown as Room;
      startWarRoom(name, source.name, { squad: shared ? "towerDrainDuo" : "standard", oneShot: false, routeRooms: [source.name, name] });
    }
    if (shared) configureWarRebuildWatch(source.name, targets, "TooAngel", 100, true);
    runWarControl();
    const metrics = { shared, ticks: 10, creeps: 150, memoryCreeps: 250, spawns: 3, tasks: 3, gameScans: 0, memoryScans: 0, taskWrites: 0, queueWrites: 0, telemetryWrites: 0 };
    Game.creeps = new Proxy(Game.creeps, { ownKeys(value) { metrics.gameScans++; return Reflect.ownKeys(value); } });
    Memory.creeps = new Proxy(Memory.creeps, { ownKeys(value) { metrics.memoryScans++; return Reflect.ownKeys(value); } });
    for (const name of targets) Memory.data!.war![name] = new Proxy(Memory.data!.war![name], { set(value, key, next) { metrics.taskWrites++; return Reflect.set(value, key, next); } });
    for (const spawn of Object.values(Game.spawns)) spawn.memory = new Proxy(spawn.memory, { set(value, key, next) { if (key === "spawnList") metrics.queueWrites++; return Reflect.set(value, key, next); } });
    Memory.analytics = new Proxy(Memory.analytics!, { set(value, key, next) { if (key === "war") metrics.telemetryWrites++; return Reflect.set(value, key, next); } });
    for (let i = 0; i < metrics.ticks; i++) { Game.time++; runWarControl(); }
    expect(targets.filter(name => Memory.data!.war![name].status === "queued")).toHaveLength(2);
    expect(Object.values(Memory.data!.creepConfigs!)).toHaveLength(shared ? 2 : 3);
    if (process.env.WAR_SCHEDULING_METRICS) appendFileSync(process.env.WAR_SCHEDULING_METRICS, JSON.stringify(metrics) + "\n");
  });
});
