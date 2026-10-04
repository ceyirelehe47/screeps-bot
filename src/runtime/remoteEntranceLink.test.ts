jest.mock("@/runtime/defenseMode", () => ({ isDefenseMode: jest.fn(() => false) }));
import { addRemoteEntranceLinkPlans, getRemoteEntranceDeliveryLink, isRemoteEntranceLink, REMOTE_ENTRANCE_LINK_LAYOUT_KEY } from "@/runtime/remoteEntranceLink";

let path: PathStep[] = [];
class Pos {
  constructor(public x: number, public y: number, public roomName: string) {}
  getRangeTo(value: { pos?: RoomPosition; x?: number; y?: number }): number {
    const p = value.pos ?? value; return Math.max(Math.abs(this.x - p.x!), Math.abs(this.y - p.y!));
  }
  findPathTo(target: RoomPosition, opts: FindPathOpts): PathStep[] {
    expect(opts.swampCost).toBe(10);
    if (this.x === 49 && this.y === 20) {
      if (this.getRangeTo(target) <= 6) {
        return Array.from({ length: Math.max(0, this.getRangeTo(target) - 1) }, (_, i) => ({
          x: this.x + Math.sign(target.x - this.x) * Math.min(i + 1, Math.abs(target.x - this.x)),
          y: this.y + Math.sign(target.y - this.y) * Math.min(i + 1, Math.abs(target.y - this.y)),
        } as PathStep));
      }
      return [...path].reverse();
    }
    return path;
  }
}
const pos = (x: number, y: number) => new Pos(x, y, "W1N1") as unknown as RoomPosition;
function link(id: string, x: number, y: number, room: Room): StructureLink {
  return { id, pos: pos(x, y), room, my: true, structureType: STRUCTURE_LINK, isActive: () => true,
    store: { getUsedCapacity: () => 800, getFreeCapacity: () => 0, getCapacity: () => 800 } } as unknown as StructureLink;
}
function world() {
  const links: StructureLink[] = [], sites: ConstructionSite[] = [];
  const room = { name: "W1N1", controller: { my: true, level: 8, pos: pos(20, 25) },
    storage: { pos: pos(10, 20), store: { getFreeCapacity: () => 100000 } },
    find: (kind: FindConstant) => kind === FIND_STRUCTURES || kind === FIND_MY_STRUCTURES ? links : kind === FIND_CONSTRUCTION_SITES ? sites : [] } as unknown as Room;
  links.push(link("warehouse", 11, 20, room));
  const layout = { [STRUCTURE_LINK]: [{ x: 11, y: 20 }] } as Record<string, { x: number; y: number }[]>;
  Memory.data = { roomPlanner: { W1N1: { layout, timestamp: "", savedAt: 0 } }, remoteMining: {
    W2N1: { sourceRoom: "W1N1", targetRoom: "W2N1", status: "active", sourceIds: ["s1", "s2"], assignedAt: 1, updatedAt: 1,
      roadPlan: { generatedAt: 1, positions: [{ x: 0, y: 20, roomName: "W2N1" }] } },
  } };
  Game.rooms = { W1N1: room };
  path = Array.from({ length: 38 }, (_, i) => ({ x: 11 + i, y: 20 } as PathStep));
  return { room, links, sites, layout };
}
beforeEach(() => {
  delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
  Game.time++; Memory.runtime = {}; Game.creeps = {}; Game.spawns = {};
  Object.assign(global, { RoomPosition: Pos });
  Game.map = { describeExits: () => ({ [RIGHT]: "W2N1" }), getRoomTerrain: () => ({ get: () => 0 }) } as unknown as GameMap;
});

it("按真实道路旁选入口 link，不占回程道路，重复规划不新增", () => {
  const w = world();
  expect(addRemoteEntranceLinkPlans(w.room, w.layout)).toBe(true);
  const chosen = w.layout[REMOTE_ENTRANCE_LINK_LAYOUT_KEY][0];
  expect(path.some(p => p.x === chosen.x && p.y === chosen.y)).toBe(false);
  expect(chosen.x).toBe(47);
  expect(w.layout.link).toContainEqual(chosen);
  expect(addRemoteEntranceLinkPlans(w.room, w.layout)).toBe(false);
  expect(w.layout.link).toHaveLength(2);
});

it("坐标接近但真实寻路绕远时仍规划，不用直线距离否定收益", () => {
  const w = world(); w.room.storage!.pos = pos(40, 20); w.links[0].pos = pos(41, 20); w.layout.link[0] = { x: 41, y: 20 };
  path = [...Array.from({ length: 15 }, (_, i) => ({ x: 40, y: 21 + i })),
    ...Array.from({ length: 8 }, (_, i) => ({ x: 41 + i, y: 35 })),
    ...Array.from({ length: 15 }, (_, i) => ({ x: 48, y: 34 - i }))] as PathStep[];
  expect(w.room.storage!.pos.getRangeTo(pos(49, 20))).toBe(9);
  expect(addRemoteEntranceLinkPlans(w.room, w.layout)).toBe(true);
});

it.each([12, 17, 29])("实际可省路程仅 %i 步时不占用新 link 额度", length => {
  const w = world();
  w.room.storage!.pos = pos(47 - length, 20); w.links[0].pos = pos(48 - length, 20);
  w.layout.link[0] = { x: 48 - length, y: 20 };
  path = Array.from({ length: length + 1 }, (_, i) => ({ x: 48 - length + i, y: 20 } as PathStep));
  expect(addRemoteEntranceLinkPlans(w.room, w.layout)).toBe(false);
  expect(w.layout.link).toHaveLength(1);
  expect(w.layout[REMOTE_ENTRANCE_LINK_LAYOUT_KEY] ?? []).toEqual([]);
});

it("实际可省 30 步时进入候选，仍须有建设额度和接收网络", () => {
  const w = world();
  w.room.storage!.pos = pos(17, 20); w.links[0].pos = pos(18, 20); w.layout.link[0] = { x: 18, y: 20 };
  path = Array.from({ length: 31 }, (_, i) => ({ x: 18 + i, y: 20 } as PathStep));
  expect(addRemoteEntranceLinkPlans(w.room, w.layout)).toBe(true);
});

it("入口至仓库 30 步、至 link 卸货处 1 步时仅省 29 步，不建", () => {
  const w = world();
  w.room.storage!.pos = pos(18, 20); w.links[0].pos = pos(19, 20); w.layout.link[0] = { x: 19, y: 20 };
  path = Array.from({ length: 30 }, (_, i) => ({ x: 19 + i, y: 20 } as PathStep));
  expect(addRemoteEntranceLinkPlans(w.room, w.layout)).toBe(false);
  expect(w.layout.link).toHaveLength(1);
});

it("保留源矿/控制器的规划额度，额度满时不破坏现有 link", () => {
  const w = world(); w.room.controller!.level = 5;
  w.layout.link.push({ x: 20, y: 26 });
  expect(addRemoteEntranceLinkPlans(w.room, w.layout)).toBe(false);
  expect(w.layout.link).toHaveLength(2);
});

it("复用现有入口 link，即使已经满能量仍保持卸载目标", () => {
  const w = world(); const entrance = link("entry", 47, 19, w.room); w.links.push(entrance);
  w.layout.link.push({ x: 47, y: 19 });
  expect(addRemoteEntranceLinkPlans(w.room, w.layout)).toBe(true);
  const creep = { room: w.room, pos: pos(48, 20) } as Creep;
  expect(isRemoteEntranceLink(entrance)).toBe(true);
  expect(getRemoteEntranceDeliveryLink(creep, "W2N1")).toBe(entrance);
  expect(w.layout.link).toHaveLength(2);
});
