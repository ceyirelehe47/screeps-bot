import { depositHarvesterRole } from "@/roles/depositHarvester";
import { mountCreep, clearRoleLifecycleCacheForTest } from "@/mount/mountCreep";
import { measureDepositReturn } from "@/runtime/depositPathDistance";
import { moveToTargetRoom } from "@/roles/shared";
import { finishDepositTask } from "@/runtime/depositHarvest";
import type { DepositHarvestTask } from "@/runtime/depositHarvest";

jest.mock("@/roles", () => ({ roleRegistry: { depositHarvester: (...args: string[]) =>
  jest.requireActual("@/roles/depositHarvester").depositHarvesterRole(...args) } }));
jest.mock("@/roles/shared", () => ({ clearMovementState: jest.fn(), moveToTarget: jest.fn(), moveToTargetRoom: jest.fn() }));
jest.mock("@/runtime/runtimeServices", () => ({ getCreepConfigService: () => ({ get: () => undefined }) }));
jest.mock("@/runtime/cpuPhaseProfiler", () => ({ isPerCreepPhaseTimingEnabled: () => false,
  measureCreepIntent: (fn: () => unknown) => fn(), measureCpuPhase: (_p: string, fn: () => unknown) => fn() }));
jest.mock("@/movement/metrics", () => ({ recordMovementGauge: jest.fn(), recordMovementMetric: jest.fn() }));
jest.mock("@/runtime/treasuryTerminalCargo", () => ({ executeTreasuryFencedTerminalCargo: (_t: unknown, fn: () => unknown) => fn() }));
jest.mock("@/runtime/depositPathDistance", () => ({ isDepositRoomSafe: jest.fn(() => true), measureDepositReturn: jest.fn() }));
jest.mock("@/runtime/depositHarvest", () => ({
  getDepositAvoidRooms: () => [], getDepositHarvestConfig: () => ({ enabled: true, maxCooldown: 80 }),
  findDepositSafeRoute: (from: string, to: string) => from === to ? [from] : [from, to],
  isDepositTerminal: (task: DepositHarvestTask) => ["complete", "failed", "aborted"].includes(task.status),
  finishDepositTask: jest.fn((task: DepositHarvestTask, status: DepositHarvestTask["status"], reason?: string) => {
    task.status = status; task.stopReason = reason;
  }),
}));
let amount = 0;
let cooldown = 0;
let task: DepositHarvestTask;
let home: Room;
let remote: Room;
function pos(x: number, roomName: string): RoomPosition {
  return { x, y: 20, roomName, isNearTo: (other: { pos?: RoomPosition; x?: number; y?: number; roomName?: string }) => {
    const target = other.pos ?? other;
    return target.roomName === roomName && Math.max(Math.abs(x - target.x!), Math.abs(20 - target.y!)) <= 1;
  } } as RoomPosition;
}
function creep(ready = true): Creep {
  const instance = Object.assign(Object.create(Creep.prototype), {
    name: "deposit-1", pos: pos(19, "E10N1"), room: remote, ticksToLive: 1_000,
    memory: { role: "depositHarvester", roleArgs: ["d1", "E1N1"], ready, working: false,
      configName: "E1N1:deposit:d1:g0", taskId: "d1", depositHomeRoom: "E1N1", depositResourceType: RESOURCE_METAL },
    body: [...Array(10).fill(WORK), ...Array(10).fill(CARRY), ...Array(20).fill(MOVE)].map((type) => ({ type, hits: 100 })),
    getActiveBodyparts: (part: BodyPartConstant) => part === WORK ? 10 : 20,
    store: { getUsedCapacity: () => amount, getFreeCapacity: () => 500 - amount, getCapacity: () => 500 },
    harvest: jest.fn(() => OK), transfer: jest.fn(() => OK), suicide: jest.fn(() => OK), say: jest.fn(),
  });
  return instance as Creep;
}
beforeEach(() => {
  jest.clearAllMocks(); amount = 0; cooldown = 0; Game.time = 100;
  Object.assign(global, { Creep: class CreepMock {} }); clearRoleLifecycleCacheForTest(); mountCreep();
  const storage = { id: "s1", pos: pos(20, "E1N1"), store: { getFreeCapacity: () => 1_000 } };
  home = { name: "E1N1", controller: { my: true }, storage, find: () => [] } as unknown as Room;
  storage["room"] = home;
  remote = { name: "E10N1", find: () => [] } as unknown as Room;
  Game.rooms = { E1N1: home, E10N1: remote };
  task = { id: "d1", depositId: "d1", status: "outbound", generation: 0, sourceRoom: "E1N1", targetRoom: "E10N1",
    configName: "E1N1:deposit:d1:g0", creepName: "deposit-1", depositPos: { x: 20, y: 20 }, resourceType: RESOURCE_METAL,
    discoveredAt: 0, lastSeenAt: 0, expiresAt: 5_000, lastCooldown: 0, cooldown: 0, harvestedAmount: 0, deliveredAmount: 0,
    outboundTravelTicks: 100, returnTravelTicks: 100 };
  Memory.data = { depositHarvest: { d1: task } };
  Game.getObjectById = jest.fn(() => ({ id: "d1", pos: pos(20, "E10N1"), depositType: RESOURCE_METAL,
    ticksToDecay: 4_900, cooldown, lastCooldown: 0 })) as unknown as typeof Game.getObjectById;
  jest.mocked(measureDepositReturn).mockReturnValue({ status: "ready", pathDistance: 0, outboundTravelTicks: 0,
    returnTravelTicks: 100, harvestPos: { x: 19, y: 20, roomName: "E10N1" } });
});
describe("Deposit mounted source/target闭环", () => {
  it("prepare后采集；满载单程返仓，transferOK次tick才确认delivered/complete", () => {
    const c = creep(false);
    c.work(); expect(c.harvest).not.toHaveBeenCalled();
    Game.time += 1; c.work(); expect(c.harvest).toHaveBeenCalledTimes(1);
    amount = 500; Game.time += 1; c.work();
    expect(moveToTargetRoom).toHaveBeenCalledTimes(1); expect(c.memory.working).toBe(true);
    c.room = home; c.pos = pos(19, "E1N1"); Game.time += 1;
    c.work(); c.work();
    expect(c.transfer).toHaveBeenCalledTimes(1); expect(task.deliveredAmount).toBe(0);
    expect(task.status).toBe("unloading"); expect(c.suicide).not.toHaveBeenCalled();
    amount = 0; Game.time += 1; c.work();
    expect(task.deliveredAmount).toBe(500); expect(task.status).toBe("complete");
    expect(c.suicide).toHaveBeenCalledTimes(1); expect(c.harvest).toHaveBeenCalledTimes(1);
  });
  it("pending完整返程证据只等待，不调用harvest", () => {
    jest.mocked(measureDepositReturn).mockReturnValue({ status: "pending", reason: "budget", retryAt: 101 });
    const c = creep(); c.work();
    expect(c.harvest).not.toHaveBeenCalled(); expect(task.blocker).toBe("return_path_measurement_pending");
    expect(c.memory.working).toBe(false); expect(finishDepositTask).not.toHaveBeenCalled();
  });
  it("等待下一次cooldown必须仍覆盖当前位置真实满载返程+50", () => {
    cooldown = 20; const c = creep(); c.ticksToLive = 160; c.work();
    expect(c.harvest).not.toHaveBeenCalled(); expect(task.stopReason).toBe("cooldown_or_ttl_exhausted");
  });
  it("损毁MOVE部件不计入当前返程身体", () => {
    const c = creep(); c.body[c.body.length - 1].hits = 0; c.work();
    expect(jest.mocked(measureDepositReturn).mock.calls[0][0].body.filter((p) => p === MOVE)).toHaveLength(19);
  });
  it("任务消失仍返仓卸货，不销毁cargo；原task未复活", () => {
    delete Memory.data!.depositHarvest!.d1;
    amount = 200; const c = creep(); c.room = home; c.pos = pos(19, "E1N1");
    c.work(); expect(c.transfer).toHaveBeenCalledTimes(1); expect(c.suicide).not.toHaveBeenCalled();
    amount = 0; Game.time += 1; c.work();
    expect(c.suicide).toHaveBeenCalledTimes(1); expect(finishDepositTask).not.toHaveBeenCalled();
  });
  it("transfer返回OK但cargo未减少，不计交付并可再次尝试", () => {
    amount = 200; const c = creep(); c.room = home; c.pos = pos(19, "E1N1");
    c.memory.working = true; c.work(); Game.time += 1; c.work();
    expect(task.deliveredAmount).toBe(0); expect(c.transfer).toHaveBeenCalledTimes(2);
    expect(c.suicide).not.toHaveBeenCalled();
  });
});
