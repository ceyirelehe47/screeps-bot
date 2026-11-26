import { isExitTile, isWalkableStructure } from "@/movement/common";
import { moveToTarget, moveToTargetRoom } from "./shared";
import { prepareWarCombatBoost } from "@/runtime/war/boostPreparation";
import type { RoleFactory } from "@/types/system";

const travel = { profile: "combat", routePurpose: "combat", reusePath: 4, ignoreCreeps: false } as const;
const advance = { ...travel, maxRooms: 1, reusePath: 2, avoidExitTiles: true } as const;

function rallyPoint(room: Room, target: string): RoomPosition {
  const dir = Game.map.findExit(room.name, target);
  if (dir < 0) return new RoomPosition(25, 25, room.name);
  const tiles = room.find(dir as ExitConstant);
  const middle = tiles[Math.floor(tiles.length / 2)];
  if (!middle) return new RoomPosition(25, 25, room.name);
  return new RoomPosition(Math.min(45, Math.max(4, middle.x)), Math.min(45, Math.max(4, middle.y)), room.name);
}

const objectives = new WeakMap<Room, { tick: number; structure?: Structure }>();
function chooseBreach(room: Room, origin: RoomPosition): Structure | undefined {
  const saved = objectives.get(room);
  if (saved?.tick === Game.time) return saved.structure;
  const matrix = new PathFinder.CostMatrix();
  const blockers = new Map<number, Structure>();
  const key = (p: RoomPosition) => p.y * 50 + p.x;
  const structures = room.find(FIND_STRUCTURES);
  for (const s of structures) {
    if (isWalkableStructure(s)) continue;
    const existing = blockers.get(key(s.pos));
    if (!s.hitsMax || s.structureType === STRUCTURE_CONTROLLER || s.structureType === STRUCTURE_KEEPER_LAIR) {
      matrix.set(s.pos.x, s.pos.y, 255);
      continue;
    }
    // 路径代价估算拆除所需 tick。叠层先处理 rampart，再处理下层障碍。
    const cost = Math.min(250, Math.ceil(s.hits / 9600) + Math.max(1, matrix.get(s.pos.x, s.pos.y)));
    matrix.set(s.pos.x, s.pos.y, cost);
    if (!existing || s.structureType === STRUCTURE_RAMPART) blockers.set(key(s.pos), s);
  }
  for (const obj of [...room.find(FIND_SOURCES), ...room.find(FIND_MINERALS)]) matrix.set(obj.pos.x, obj.pos.y, 255);
  const spawns = room.find(FIND_HOSTILE_SPAWNS);
  let cost = Infinity;
  let structure: Structure | undefined;
  for (const spawn of spawns) {
    const path = PathFinder.search(origin, { pos: spawn.pos, range: 1 }, { maxRooms: 1, maxOps: 5000,
      plainCost: 1, swampCost: 2, roomCallback: () => matrix });
    if (path.incomplete) continue;
    const shield = room.lookForAt(LOOK_STRUCTURES, spawn.pos).find(s => s.structureType === STRUCTURE_RAMPART);
    const total = path.cost + (shield ? shield.hits / 9600 : 0);
    if (total >= cost) continue;
    cost = total;
    structure = path.path.map(p => blockers.get(key(p))).find(s => !!s) ?? shield ?? spawn;
  }
  objectives.set(room, { tick: Game.time, structure });
  return structure;
}

function healFormation(creep: Creep, group: Creep[], breacher?: Creep): void {
  if (!creep.getActiveBodyparts(HEAL)) return;
  const inRange = group.filter(c => creep.pos.getRangeTo(c.pos) <= 3);
  const wounded = inRange.filter(c => c.hits < c.hitsMax).sort((a, b) =>
    (b.hitsMax - b.hits) / (creep.pos.isNearTo(b) ? 1 : 3) - (a.hitsMax - a.hits) / (creep.pos.isNearTo(a) ? 1 : 3));
  const target = wounded[0] ?? (breacher && creep.pos.isNearTo(breacher) ? breacher : creep);
  if (creep.pos.isNearTo(target)) creep.heal(target);
  else creep.rangedHeal(target);
}

function runSiegeUnit(creep: Creep, target: string, route: string, job: string): boolean {
  const task = Memory.data?.war?.[target];
  if (!task || task.squad !== "siege" || task.status === "failed" || task.status === "done" || creep.memory._warQueued || creep.memory._warDetached) return false;
  const group = creep.room.find(FIND_MY_CREEPS).filter(c => c.memory.role === "siegeUnit" && c.memory.roleArgs?.[0] === target);
  const breachers = group.filter(c => c.getActiveBodyparts(WORK) > 0);
  const leader = breachers.sort((a,b) => a.name.localeCompare(b.name))[0];
  const staging = task.routeRooms?.[task.routeRooms.length - 2] ?? task.sourceRoom;
  const structure = creep.room.name === target ? chooseBreach(creep.room, leader?.pos ?? creep.pos) : undefined;
  const nearby = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3).filter(c => c.owner.username !== "Source Keeper"
    && !creep.room.lookForAt(LOOK_STRUCTURES, c.pos).some(s => s.structureType === STRUCTURE_RAMPART));
  const enemy = nearby.sort((a,b) => a.hits - b.hits)[0];
  healFormation(creep, group, leader);
  if (enemy) creep.rangedAttack(enemy);
  else if (structure && creep.pos.inRangeTo(structure, 3)) creep.rangedAttack(structure);
  if (creep.room.name !== target) {
    if (!task.siegeLaunched && creep.room.name === staging) moveToTarget(creep, rallyPoint(creep.room, target), 2, advance);
    else moveToTargetRoom(creep, task.siegeLaunched ? target : staging, route, travel);
    return false;
  }
  if (!structure) return false;
  if (job === "breacher") {
    if (creep.pos.isNearTo(structure)) creep.dismantle(structure);
    else moveToTarget(creep, structure, 1, advance);
  } else {
    const partner = creep.pos.findClosestByRange(breachers);
    if (partner && !creep.pos.isNearTo(partner)) moveToTarget(creep, partner, 1, advance);
    else if (isExitTile(creep.pos) || !creep.pos.inRangeTo(structure, 3)) moveToTarget(creep, structure, 3, advance);
  }
  return false;
}

export const siegeUnitRole: RoleFactory = (target, route, boostTask, compounds, job) => ({
  prepare: creep => prepareWarCombatBoost(creep, boostTask, compounds),
  source: creep => runSiegeUnit(creep, target, route, job),
  target: creep => runSiegeUnit(creep, target, route, job),
});
