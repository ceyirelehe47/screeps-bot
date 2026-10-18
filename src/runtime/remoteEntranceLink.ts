import { searchRoomPath } from "@/movement/roomPath";
import { getTickContextService } from "@/runtime/runtimeServices";
import { isDefenseMode } from "@/runtime/defenseMode";

export const REMOTE_ENTRANCE_LINK_LAYOUT_KEY = "remote_entry_link";
const ENTRANCE_RANGE = 6;
// 路程较短时，link 损耗、发送等待和建造投入难以摊回；按真实可省路程筛选。
const MIN_SAVED_STEPS = 30;
type Layout = Record<string, { x: number; y: number }[]>;
interface Entrance { targetRoom: string; pos: RoomPosition }
const same = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => a.x === b.x && a.y === b.y;
const WALK_OPTIONS = { range: 1, maxRooms: 1, plainCost: 2, swampCost: 10, maxOps: 2000 };

function walkingDistance(origin: RoomPosition, target: RoomPosition): number | null {
  if (origin.getRangeTo(target) <= 1) return 0;
  const result = searchRoomPath(origin, target, WALK_OPTIONS);
  if (result.incomplete) return null;
  const path = result.path;
  const last = path[path.length - 1];
  if (!last || new RoomPosition(last.x, last.y, origin.roomName).getRangeTo(target) > 1) return null;
  return path.length;
}

function getEntrances(room: Room, activeOnly = false): Entrance[] {
  const exits = Game.map.describeExits?.(room.name);
  if (!exits) return [];
  const result: Entrance[] = [];
  for (const task of Object.values(Memory.data?.remoteMining ?? {})) {
    if (task.sourceRoom !== room.name || task.status === "abandoned" || task.status === "scouting" || activeOnly && task.status !== "active") continue;
    const direction = Number(Object.entries(exits).find(([, name]) => name === task.targetRoom)?.[0]);
    const point = task.roadPlan?.positions.find(p => p.roomName === task.targetRoom &&
      (direction === RIGHT ? p.x === 0 : direction === LEFT ? p.x === 49 : direction === TOP ? p.y === 49 : direction === BOTTOM && p.y === 0));
    if (!point) continue;
    const x = direction === RIGHT ? 49 : direction === LEFT ? 0 : point.x;
    const y = direction === TOP ? 0 : direction === BOTTOM ? 49 : point.y;
    result.push({ targetRoom: task.targetRoom, pos: new RoomPosition(x, y, room.name) });
  }
  return result;
}

function nearReceiver(room: Room, pos: RoomPosition): boolean {
  return !!room.storage && pos.getRangeTo(room.storage.pos) <= 2 || !!room.controller && pos.getRangeTo(room.controller.pos) <= 3;
}

export function isRemoteEntranceLink(link: StructureLink): boolean {
  return (Memory.data?.roomPlanner?.[link.room.name]?.layout?.[REMOTE_ENTRANCE_LINK_LAYOUT_KEY] ?? []).some(p => same(p, link.pos));
}

/** 入口满时保持卸载目标，避免每次发送/冷却都在 link 与仓库之间反复折返。 */
export function getRemoteEntranceDeliveryLink(creep: Creep, targetRoom: string): StructureLink | null {
  const room = creep.room;
  if (!room.controller?.my || !room.storage || room.storage.store.getFreeCapacity(RESOURCE_ENERGY) <= 0 || isDefenseMode(room.name)) return null;
  const entry = getEntrances(room).find(e => e.targetRoom === targetRoom);
  if (!entry) return null;
  const links = getTickContextService().getRoomContext(room)?.getLinks() ?? [];
  if (!links.some(l => l.isActive() && l.pos.getRangeTo(room.storage!.pos) <= 2)) return null;
  return links.filter(l => l.isActive() && isRemoteEntranceLink(l) && l.pos.getRangeTo(entry.pos) <= ENTRANCE_RANGE)
    .sort((a, b) => creep.pos.getRangeTo(a.pos) - creep.pos.getRangeTo(b.pos))[0] ?? null;
}

/** 只补空闲额度；借用现有规划器的节流、工地上限和建造顺序。 */
export function addRemoteEntranceLinkPlans(room: Room, layout: Layout): boolean {
  if (!room.controller?.my || !room.storage || isDefenseMode(room.name)) return false;
  const entrances = getEntrances(room, true);
  if (!entrances.length) return false;
  const ctx = getTickContextService().getRoomContext(room);
  if (!ctx) return false;
  const links = ctx.getLinks(), sites = ctx.getConstructionSites(), sources = ctx.getSources();
  const max = CONTROLLER_STRUCTURES[STRUCTURE_LINK][room.controller.level] ?? 0;
  if (!max || !links.some(l => l.isActive() && l.pos.getRangeTo(room.storage!.pos) <= 2)) return false;
  const planned = layout[STRUCTURE_LINK] ??= [];
  const markers = layout[REMOTE_ENTRANCE_LINK_LAYOUT_KEY] ??= [];
  const reserved = planned.filter(p => {
    const pos = new RoomPosition(p.x, p.y, room.name);
    return nearReceiver(room, pos) || sources.some(s => pos.getRangeTo(s.pos) <= 2);
  }).filter(p => !links.some(l => same(l.pos, p)) && !sites.some(s => s.structureType === STRUCTURE_LINK && same(s.pos, p))).length;
  let spare = max - links.length - sites.filter(s => s.structureType === STRUCTURE_LINK).length - reserved;
  const structures = ctx.getStructures();
  const terrain = Game.map.getRoomTerrain(room.name);
  let changed = false;
  for (const entry of entrances) {
    const known = [...planned, ...links.map(l => ({ x: l.pos.x, y: l.pos.y }))].find(p => {
      const pos = new RoomPosition(p.x, p.y, room.name);
      return pos.getRangeTo(entry.pos) <= ENTRANCE_RANGE && !nearReceiver(room, pos) && !sources.some(s => pos.getRangeTo(s.pos) <= 2);
    });
    if (known) {
      if (!markers.some(p => same(p, known))) { markers.push({ ...known }); changed = true; }
      continue;
    }
    if (spare <= 0) continue;
    const result = searchRoomPath(room.storage.pos, entry.pos, WALK_OPTIONS);
    if (result.incomplete) continue;
    const path = result.path;
    if (path.length < MIN_SAVED_STEPS) continue;
    const homeDistance = walkingDistance(entry.pos, room.storage.pos);
    // 可建位置离边界至少两格，走到卸货范围至少还要一步。
    if (homeDistance === null || homeDistance <= MIN_SAVED_STEPS) continue;
    const walkKeys = new Set(path.map(p => `${p.x}:${p.y}`));
    const occupied = new Set(structures.filter(s => s.structureType !== STRUCTURE_RAMPART).map(s => `${s.pos.x}:${s.pos.y}`));
    for (const site of sites) occupied.add(`${site.pos.x}:${site.pos.y}`);
    for (const [type, positions] of Object.entries(layout)) {
      if (type === STRUCTURE_RAMPART || type === REMOTE_ENTRANCE_LINK_LAYOUT_KEY) continue;
      for (const p of positions) occupied.add(`${p.x}:${p.y}`);
    }
    const candidates: { x: number; y: number; saved: number }[] = [];
    for (let i = path.length - 1; i >= 0; i--) {
      const station = path[i];
      if (new RoomPosition(station.x, station.y, room.name).getRangeTo(entry.pos) > ENTRANCE_RANGE) continue;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const x = station.x + dx, y = station.y + dy, key = `${x}:${y}`;
        if (x < 2 || x > 47 || y < 2 || y > 47 || walkKeys.has(key) || occupied.has(key) || terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        const pos = new RoomPosition(x, y, room.name);
        if (pos.getRangeTo(entry.pos) > ENTRANCE_RANGE || nearReceiver(room, pos) || sources.some(s => pos.getRangeTo(s.pos) <= 2)
          || ctx.getMinerals().some(m => same(m.pos, pos)) || same(room.controller.pos, pos)) continue;
        candidates.push({ x, y, saved: i + 1 });
      }
    }
    candidates.sort((a, b) => b.saved - a.saved || terrain.get(a.x, a.y) - terrain.get(b.x, b.y) || a.x - b.x || a.y - b.y);
    // 道路节点只决定尝试顺序；收益必须扣除入口到 link 卸货范围的真实步数。
    const chosen = candidates.find(candidate => {
      const deliveryDistance = walkingDistance(entry.pos, new RoomPosition(candidate.x, candidate.y, room.name));
      return deliveryDistance !== null && homeDistance - deliveryDistance >= Math.max(MIN_SAVED_STEPS, Math.ceil(homeDistance / 4));
    });
    if (!chosen) continue;
    const pos = { x: chosen.x, y: chosen.y };
    planned.push(pos); markers.push({ ...pos }); spare--; changed = true;
  }
  return changed;
}
