import { HUB_TARGET_COMPOUNDS } from "@/config/hub";
import { buildHubProgressSnapshot } from "@/runtime/hubProgress";
import { getDefaultHubConfig, getDefaultHubRuntime, normalizeHubConfig, planDistributedSynthesis,
  planHubChains, planHubDistribution, planHubImports } from "@/runtime/hubPlanner";
import { ensureResourceTransferTaskStore } from "@/runtime/logistics/resourceTransferTasks";
import { registerRuntimeServices } from "@/runtime/runtimeServices";

const HUB = "W1N1";
const SAT = "W2N1";
function room(name: string, minerals: Record<string, number> = {}): Room {
  const store = (capacity: number, values: Record<string, number>) => ({ ...values,
    getUsedCapacity: (resource?: string) => resource ? values[resource] || 0 : Object.values(values).reduce((a, b) => a + b, 0),
    getFreeCapacity: () => capacity - Object.values(values).reduce((a, b) => a + b, 0),
    getCapacity: () => capacity,
  });
  const labs = Array.from({ length: 3 }, (_, n) => ({ id: `${name}-lab-${n}`, structureType: STRUCTURE_LAB,
    pos: new RoomPosition(20 + n, 20, name), store: store(3000, {}) }));
  return { name, memory: {}, controller: { my: true, level: 8 },
    storage: { id: `${name}-storage`, structureType: STRUCTURE_STORAGE, store: store(1_000_000, { energy: 200_000, ...minerals }) },
    terminal: { id: `${name}-terminal`, structureType: STRUCTURE_TERMINAL, cooldown: 0, store: store(300_000, { energy: 20_000 }) },
    find: (kind: FindConstant) => kind === FIND_MY_STRUCTURES || kind === FIND_STRUCTURES ? labs : [],
  } as unknown as Room;
}

describe("OH 仅 HUB 储备", () => {
  beforeEach(() => {
    Game.time = 50;
    Game.rooms = {};
    Game.creeps = {};
    Game.spawns = {};
    Memory.cfg = { hub: { ...getDefaultHubConfig(), enabled: true, hubRoomName: HUB } };
    Memory.runtime = { hub: getDefaultHubRuntime() };
    Memory.data = {};
    (global as any).__runtimeServices = undefined;
    registerRuntimeServices();
  });

  it("默认及旧十种 T3 名单迁移加入 OH，保留自定义名单与储备数量", () => {
    expect(getDefaultHubConfig()!.targetCompounds).toContain(RESOURCE_HYDROXIDE);
    const old = { targetCompounds: HUB_TARGET_COMPOUNDS.filter(c => c !== RESOURCE_HYDROXIDE), hubReservePerCompound: 12345 };
    const migrated = normalizeHubConfig(old)!;
    expect(migrated.targetCompounds).toEqual(HUB_TARGET_COMPOUNDS);
    expect(migrated.hubReservePerCompound).toBe(12345);
    expect(normalizeHubConfig({ targetCompounds: [RESOURCE_CATALYZED_GHODIUM_ACID] })!.targetCompounds)
      .toEqual([RESOURCE_CATALYZED_GHODIUM_ACID]);
  });

  it("OH 目标不叠加卫星 T3 缺口", () => {
    const result = planHubChains({ H: 100000, O: 100000 }, {}, 100000, [RESOURCE_HYDROXIDE], {}, 20000);
    expect(result.steps.find(s => s.product === RESOURCE_HYDROXIDE)?.targetAmount).toBe(20000);
  });

  it("OH 已达储备时仍为下游 T3 消耗安排补充", () => {
    const result = planHubChains({ OH: 20000, UH: 1000, X: 1000, H: 10000, O: 10000 }, {}, 1000,
      [RESOURCE_CATALYZED_UTRIUM_ACID, RESOURCE_HYDROXIDE], {}, 20000);
    expect(result.steps.find(s => s.product === RESOURCE_HYDROXIDE)?.targetAmount).toBe(1000);
  });

  it("跨房导入仅填 HUB 缺口，包含在途覆盖且不保留卫星五千 OH", () => {
    Game.rooms = { [HUB]: room(HUB, { OH: 19000 }), [SAT]: room(SAT, { OH: 10000 }), W3N1: room("W3N1", { OH: 10000 }) };
    planHubImports(Memory.cfg!.hub!);
    const tasks = Object.values(ensureResourceTransferTaskStore()).filter(t => t.resource === RESOURCE_HYDROXIDE);
    expect(tasks.reduce((sum, t) => sum + t.amount, 0)).toBe(1000);
    expect(tasks.every(t => t.toRoomName === HUB)).toBe(true);
    planHubImports(Memory.cfg!.hub!);
    expect(Object.values(ensureResourceTransferTaskStore()).filter(t => t.resource === RESOURCE_HYDROXIDE)).toHaveLength(tasks.length);
  });

  it("导入小于 T3 回收阈值的 OH 时保留外房真实单批原料", () => {
    Game.rooms = { [HUB]: room(HUB), [SAT]: room(SAT, { OH: 2000 }) };
    Memory.cfg!.synthesisControl = { rooms: { [SAT]: { reactions: [{ product: RESOURCE_UTRIUM_ACID, targetAmount: 3000, batchSize: 1500 }] } } };
    Memory.runtime!.hub!.distributedSynthesis = { dispatchAssignments: [{ roomName: SAT, product: RESOURCE_UTRIUM_ACID, targetAmount: 3000, isHubRoom: false }] };
    planHubImports(Memory.cfg!.hub!);
    const tasks = Object.values(ensureResourceTransferTaskStore()).filter(t => t.resource === RESOURCE_HYDROXIDE);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].amount).toBe(500);
  });

  it("HUB 达标后不向外房建立 OH 常规储备出口", () => {
    Game.rooms = { [HUB]: room(HUB, { OH: 40000 }), [SAT]: room(SAT) };
    expect(planHubDistribution(Memory.cfg!.hub!)).toEqual([]);
    expect(Object.values(ensureResourceTransferTaskStore())).toEqual([]);
  });

  it("外房 OH 再多也不代表 HUB 已达储备", () => {
    Game.rooms = { [HUB]: room(HUB, { H: 100000, O: 100000 }), [SAT]: room(SAT, { OH: 50000 }) };
    const plan = planDistributedSynthesis(HUB, [RESOURCE_HYDROXIDE], 20000, 5000, {}, 100000);
    expect(plan.dispatchAssignments.some(a => a.product === RESOURCE_HYDROXIDE)).toBe(true);
    expect(plan.dispatchAssignments.filter(a => a.product === RESOURCE_HYDROXIDE)
      .reduce((sum, a) => sum + a.targetAmount, 0)).toBe(20000);
  });

  it("进度展示只报告 HUB 的 OH 缺口，外房 OH 缺口为零", () => {
    const snapshot = buildHubProgressSnapshot({ currentTick: Game.time, hubConfig: Memory.cfg!.hub!, hubRuntime: null,
      synthesisRuntime: null, hubStorageStore: { OH: 1000 }, hubTerminalStore: {}, resourceControlRooms: null,
      transferTasks: null, satelliteStores: [{ roomName: SAT, storage: {}, terminal: {} }] });
    const oh = snapshot.t3ReserveStatus.compounds.find(c => c.compound === RESOURCE_HYDROXIDE)!;
    expect(oh.hubReserve).toBe(20000);
    expect(oh.hubDeficit).toBe(19000);
    expect(oh.networkDeficit).toBe(0);
  });
});
