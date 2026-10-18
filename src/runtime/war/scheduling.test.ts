import { requestSpawn } from "@/runtime/spawnRequests";
jest.mock("@/runtime/powerBankObserver", () => ({ ...jest.requireActual("@/runtime/powerBankObserver"), requestCombatObservation: jest.fn(() => true) }));
import { startWarRoom, requestWarRoomClear, runWarControl, configureWarRebuildWatch } from "@/runtime/warControl";
import { getTaskConfigNames, type WarTask } from "./store";
import { onWarEntry, setTaskStatus } from "./fsm";
import { createTickContextService } from "@/runtime/tickContext";
import { createMockStore, MockPos } from "@mock/powerBank";

const SOURCE = "E1N57";
function resetServices(): void { delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices; }
function install() {
  resetServices(); Game.time = 1000; Memory.cfg = {}; Memory.runtime = {}; Memory.analytics = {}; Memory.data = {}; Memory.creeps = {};
  Game.creeps = {}; Game.spawns = {}; Game.flags = {};
  const source = { name: SOURCE, controller: { my: true, level: 8 }, energyCapacityAvailable: 12900,
    storage: { store: createMockStore({}) }, terminal: { store: createMockStore({}) }, find: () => [] } as unknown as Room;
  const spawn = { name: "spawn", room: source, owner: { username: "me" }, memory: { spawnList: [] }, spawning: null,
    addTask(name: string) { requestSpawn(this as StructureSpawn, name); }, isActive: () => true } as unknown as StructureSpawn;
  Game.rooms = { [SOURCE]: source }; Game.spawns = { spawn };
  return spawn;
}
function target(name: string, squad: "standard" | "towerDrainDuo" = "standard"): WarTask {
  const entity = { id: `${name}-spawn`, structureType: STRUCTURE_SPAWN, pos: new MockPos(20, 20, name), owner: { username: "TooAngel" } };
  Game.rooms[name] = { name, controller: { level: 8, owner: { username: "TooAngel" } },
    find: (kind: FindConstant) => kind === FIND_HOSTILE_STRUCTURES || kind === FIND_STRUCTURES ? [entity] : [] } as unknown as Room;
  startWarRoom(name, SOURCE, { squad, oneShot: false, routeRooms: [SOURCE, name] });
  return Memory.data!.war![name] as WarTask;
}

describe("战争稳态与迁移边界", () => {
  beforeEach(() => { jest.restoreAllMocks(); install(); });
  afterEach(() => jest.restoreAllMocks());

  it("三个串行目标预热后只共享一次 creep 扫描，不再扫描 Memory.creeps 或重写配置/队列", () => {
    const spawn = Game.spawns.spawn;
    target("E3N57"); target("E2N54"); target("E3N53"); runWarControl();
    const queue = spawn.memory.spawnList;
    const configEntries = { ...Memory.data!.creepConfigs };
    const memoryBefore = JSON.stringify(Memory);
    const originalValues = Object.values;
    let creepScans = 0; let memoryScans = 0;
    Memory.creeps = new Proxy(Memory.creeps, { ownKeys(value) { memoryScans++; return Reflect.ownKeys(value); } });
    jest.spyOn(Object, "values").mockImplementation(((value: object) => { if (value === Game.creeps) creepScans++; return originalValues(value); }) as typeof Object.values);
    Game.time++; runWarControl();
    expect(creepScans).toBeLessThanOrEqual(1);
    expect(memoryScans).toBe(0);
    expect(spawn.memory.spawnList).toBe(queue);
    for (const [name, config] of Object.entries(configEntries)) expect(Memory.data!.creepConfigs![name]).toBe(config);
    expect(JSON.stringify(Memory)).toBe(memoryBefore);
  });

  it("共享小队的非 owner 稳态不重复撤销或扫描历史 creep Memory", () => {
    for (const name of ["E3N57", "E2N54", "E3N53"]) target(name, "towerDrainDuo");
    configureWarRebuildWatch(SOURCE, ["E3N57", "E2N54", "E3N53"], "TooAngel", 100, true);
    runWarControl(); const store = Memory.data!.creepConfigs; const queue = Game.spawns.spawn.memory.spawnList;
    const retired = Object.values(Memory.data!.war!).map(t => (t as WarTask).sharedRetiredAt);
    let scans = 0; Memory.creeps = new Proxy(Memory.creeps, { ownKeys(value) { scans++; return Reflect.ownKeys(value); } });
    Game.time++; runWarControl();
    expect(scans).toBe(0); expect(Memory.data!.creepConfigs).toBe(store); expect(Game.spawns.spawn.memory.spawnList).toBe(queue);
    expect(Object.values(Memory.data!.war!).map(t => (t as WarTask).sharedRetiredAt)).toEqual(retired);
  });

  it("旧成员、旧世代和孤立队列只迁移一次，后续成员出生从配置索引登记", () => {
    const task = target("E3N57");
    const old = `${SOURCE}:war:E3N57:g7:meleeAttacker:0`;
    task.membersVersion = 1; task.members = undefined; // 部分迁移标记不能吞掉旧成员。
    Memory.creeps.old = { configName: old } as CreepMemory;
    requestSpawn(Game.spawns.spawn, old);
    expect(getTaskConfigNames(task)).toContain(old);
    expect(task.members?.[old].creepNames).toEqual(["old"]);
    const list = jest.spyOn(Object, "values"); getTaskConfigNames(task);
    expect(list.mock.calls.some(([value]) => value === Memory.creeps)).toBe(false);
    const name = `${SOURCE}:war:E3N57:healer:0`;
    const actor = { name: "green", memory: { configName: name, role: "healer" }, room: Game.rooms[SOURCE] } as unknown as Creep;
    Game.time++; Game.creeps = { green: actor }; getTaskConfigNames(task);
    expect(task.members?.[name].creepNames).toContain("green");
  });

  it("重复战区请求保留任务与成员表，配置真正变化时仍更新", () => {
    const task = target("E3N57"); runWarControl(); const members = task.members;
    Game.time++; requestWarRoomClear("E3N57", SOURCE, { routeRooms: [SOURCE, "E3N57"], reason: "manual", squad: "standard", oneShot: false });
    expect(Memory.data!.war!.E3N57).toBe(task); expect(task.members).toBe(members);
    requestWarRoomClear("E3N57", SOURCE, { routeRooms: [SOURCE, "E2N57", "E3N57"], reason: "manual", squad: "standard", oneShot: false });
    expect(Memory.data!.war!.E3N57.routeRooms).toEqual([SOURCE, "E2N57", "E3N57"]);
  });

  it("Memory 重新解析不绕过遥测 cadence，状态变化仍立即刷新", () => {
    target("E3N57"); runWarControl(); const snapshot = Memory.analytics!.war;
    Memory.data = JSON.parse(JSON.stringify(Memory.data)); Game.time++; runWarControl();
    expect(Memory.analytics!.war).toBe(snapshot);
    target("E2N54"); Game.time++; runWarControl(); expect(Memory.analytics!.war).not.toBe(snapshot);
  });

  it("共享成员同 tick 换名后搭档索引即时更新，原配置不再返回该成员", () => {
    const actor = { name: "green", memory: { configName: "old", role: "healer" }, room: Game.rooms[SOURCE] } as unknown as Creep;
    Game.creeps = { green: actor }; const context = createTickContextService();
    expect(context.getCreepsByConfigName("old")).toEqual([actor]);
    actor.memory.configName = "new"; context.reindexCreepConfig(actor, "old");
    expect(context.getCreepsByConfigName("old")).toEqual([]); expect(context.getCreepsByConfigName("new")).toEqual([actor]);
  });

  it("queued onEnter 只执行一次，失败的副作用可以重试，终态必须通过显式重启恢复", () => {
    const task = target("E3N57"); const effect = jest.fn();
    setTaskStatus(task, "queued"); onWarEntry(task, "park", effect); onWarEntry(task, "park", effect); expect(effect).toHaveBeenCalledTimes(1);
    setTaskStatus(task, "staging"); setTaskStatus(task, "queued");
    const fail = jest.fn(() => { throw new Error("retry"); });
    expect(() => onWarEntry(task, "park", fail)).toThrow("retry"); onWarEntry(task, "park", effect); expect(effect).toHaveBeenCalledTimes(2);
    setTaskStatus(task, "done"); expect(() => setTaskStatus(task, "clearing")).toThrow("非法任务转移 war: done -> clearing");
  });
});
