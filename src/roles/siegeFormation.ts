import { searchMovementPath } from "@/movement/pathSearch";
import { towerAttackPowerAt } from "@/runtime/combatTowerThreat";
import { isWalkableStructure } from "@/movement/common";
import { damageAfterTough, effectivePower } from "@/runtime/powerBankCapability";
import type { WarTask } from "@/runtime/war/store";

interface Tile {
  x: number;
  y: number;
}
const offsets: readonly Tile[] = [
  { x: 1, y: 0 },
  { x: 0, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];
const tileKey = (x: number, y: number) => y * 50 + x;
const range = (a: Tile, b: Tile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
export const siegeSlot = (c: Creep) =>
  c.memory._siegeSlot ?? Number(c.memory.roleArgs?.[5] ?? c.memory.configName?.split(":").pop() ?? 0);
function isSiegeFighter(c: Creep): boolean {
  const job = c.memory.roleArgs?.[4];
  return c.getActiveBodyparts(WORK) > 0 ||
    ((job === "ranger" || job === "breacher") && c.getActiveBodyparts(RANGED_ATTACK) > 0);
}

export function siegeWeaponRange(c: Creep): 1 | 3 {
  const ranged = c.getActiveBodyparts(RANGED_ATTACK);
  const work = c.getActiveBodyparts(WORK);
  return isSiegeFighter(c) && ranged > work ? 3 : 1;
}
const groupId = (c: Creep) => Math.floor(siegeSlot(c) / 4);
const slot = (c: Creep) => siegeSlot(c) % 4;
const walk = { maxRooms: 1, ignoreCreeps: false, reusePath: 3 } as const;

function footprint(anchor: Tile, offset: Tile): Tile {
  return { x: anchor.x + offset.x, y: anchor.y + offset.y };
}

interface Geometry {
  matrix: CostMatrix;
  single: CostMatrix;
  blockers: Map<number, Id<Structure>>;
}
const terrainCache = new Map<string, { at: number; geometry: Geometry }>();
function geometry(room: Room): Geometry {
  const saved = terrainCache.get(room.name);
  if (saved && Game.time >= saved.at && Game.time - saved.at < 8) return saved.geometry;
  const terrain = Game.map.getRoomTerrain(room.name);
  const tileCosts = new Uint16Array(2500);
  const blockers = new Map<number, Id<Structure>>();
  for (let y = 0; y < 50; y++)
    for (let x = 0; x < 50; x++) {
      const floor = terrain.get(x, y);
      tileCosts[tileKey(x, y)] = floor & TERRAIN_MASK_WALL ? 255 : floor & TERRAIN_MASK_SWAMP ? 2 : 1;
    }
  for (const obj of [...room.find(FIND_SOURCES), ...room.find(FIND_MINERALS)])
    tileCosts[tileKey(obj.pos.x, obj.pos.y)] = 255;
  for (const s of room.find(FIND_STRUCTURES)) {
    if (isWalkableStructure(s)) continue;
    const k = tileKey(s.pos.x, s.pos.y);
    if (
      !s.hitsMax ||
      s.structureType === STRUCTURE_CONTROLLER ||
      s.structureType === STRUCTURE_KEEPER_LAIR ||
      (s as OwnedStructure).my
    ) {
      tileCosts[k] = 255;
      continue;
    }
    if (tileCosts[k] === 255) continue;
    tileCosts[k] = Math.min(245, tileCosts[k] + Math.ceil(s.hits / 6500));
    if (!blockers.has(k) || s.structureType === STRUCTURE_RAMPART) blockers.set(k, s.id);
  }
  const matrix = new PathFinder.CostMatrix();
  const single = new PathFinder.CostMatrix();
  for (let y = 0; y < 50; y++)
    for (let x = 0; x < 50; x++) {
      single.set(x, y, x < 1 || y < 1 || x > 48 || y > 48 ? 255 : tileCosts[tileKey(x,y)]);
      if (x < 1 || y < 1 || x > 47 || y > 47) {
        matrix.set(x, y, 255);
        continue;
      }
      const cells = offsets.map((d) => tileCosts[tileKey(x + d.x, y + d.y)]);
      matrix.set(
        x,
        y,
        cells.some((c) => c === 255)
          ? 255
          : Math.min(250, Math.floor(Math.max(...cells) + cells.reduce((n, v) => n + (v > 3 ? v : 0), 0) / 4)),
      );
    }
  const result = { matrix, blockers, single };
  terrainCache.set(room.name, { at: Game.time, geometry: result });
  return result;
}

export function siegeRally(room: Room, nextRoom: string, wing: number): RoomPosition {
  const dir = Game.map.findExit(room.name, nextRoom);
  if (dir < 0) return new RoomPosition(25, 25, room.name);
  const exits = room.find(dir as ExitConstant);
  const tile = exits[Math.min(exits.length - 1, Math.max(0, Math.floor(exits.length / 2) + ([-3, 1, 4][wing] ?? 0)))];
  return new RoomPosition(
    Math.max(3, Math.min(45, tile?.x ?? 25)),
    Math.max(3, Math.min(45, tile?.y ?? 25)),
    room.name,
  );
}

function entryAnchor(room: Room, from: string, wing: number): Tile {
  const near = siegeRally(room, from, wing),
    { matrix } = geometry(room);
  let best: Tile | undefined,
    distance = Infinity;
  for (let y = Math.max(1, near.y - 10); y <= Math.min(47, near.y + 10); y++)
    for (let x = Math.max(1, near.x - 10); x <= Math.min(47, near.x + 10); x++) {
      const cost = matrix.get(x, y),
        d = range(near, { x, y }) * 5 + cost;
      if (cost < 4 && d < distance) {
        best = { x, y };
        distance = d;
      }
    }
  return best ?? { x: near.x, y: near.y };
}

const musterPoints = new Map<string, {time: number; pos: RoomPosition}>();

/** 选择可容纳四人的实际地块。停在同一中心的一格内，任意两名队员之间至多两格。 */
export function siegeMusterPosition(room: Room, nextRoom: string): RoomPosition {
  const key = room.name + ":" + nextRoom;
  const saved = musterPoints.get(key);
  if (saved && Game.time >= saved.time && Game.time - saved.time < 50) return saved.pos;
  const at = entryAnchor(room, nextRoom, 0);
  const pos = new RoomPosition(at.x, at.y, room.name);
  for (const [name,point] of musterPoints) if (point.time + 50 <= Game.time || point.time > Game.time) musterPoints.delete(name);
  musterPoints.set(key, {time: Game.time, pos});
  return pos;
}

function cover(room: Room, target: Structure): Structure {
  return (
    room
      .lookForAt(LOOK_STRUCTURES, target.pos)
      .find((s) => s.structureType === STRUCTURE_RAMPART && !(s as StructureRampart).my) ?? target
  );
}
function fire(
  creep: Creep,
  target: Structure | undefined,
  nearby: Creep[],
  openings: Structure[],
  cleared: Set<string>,
  approach: Structure[],
  exposed: Structure[],
  core?: Structure,
): void {
  const enemies = nearby.filter((h) => creep.pos.inRangeTo(h, 3)).sort((a, b) => a.hits - b.hits);
  const enemy = enemies[0];
  const unshielded = exposed.filter(s => s.structureType === STRUCTURE_SPAWN && creep.pos.inRangeTo(s, 3))
    .sort((a,b) => creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b) || a.hits - b.hits)[0];
  const focus = unshielded ?? core ?? (target && creep.pos.inRangeTo(target, 3) ? target : undefined);
  if (creep.getActiveBodyparts(RANGED_ATTACK)) {
    const structures = exposed.filter(s => creep.pos.inRangeTo(s, 3));
    const spread = [...enemies, ...structures].reduce((sum, obj) => {
      const distance = creep.pos.getRangeTo(obj);
      return sum + (distance <= 1 ? 1 : distance === 2 ? 0.4 : 0.1);
    }, 0);
    // 贴身群攻对主目标保持全额伤害，并同时消耗相邻的 rampart、维修工和补塔物流。
    if (focus && creep.pos.isNearTo(focus) && spread > 1) creep.rangedMassAttack();
    else if (focus && (unshielded || siegeWeaponRange(creep) === 3)) creep.rangedAttack(focus);
    else if (spread > 1 && !focus) creep.rangedMassAttack();
    else {
      const shot = enemy ?? focus ?? structures[0];
      if (shot) creep.rangedAttack(shot);
    }
  }
  if (!creep.getActiveBodyparts(WORK)) return;
  if (unshielded && creep.pos.isNearTo(unshielded)) {
    creep.dismantle(unshielded);
    return;
  }
  const power = creep.body.reduce((sum, part) => {
    if (part.type !== WORK || part.hits <= 0) return sum;
    const multiplier = part.boost
      ? ((BOOSTS[WORK] as Record<string, { dismantle?: number }>)[part.boost]?.dismantle ?? 1)
      : 1;
    return sum + DISMANTLE_POWER * multiplier;
  }, 0);
  // 刚拆掉 rampart 的地方可能仍有一座低血量 extension。先用一个动作打通落点。
  const opening =
    target?.structureType !== STRUCTURE_SPAWN &&
    openings.find((s) => !cleared.has(s.id) && s.hits <= power && creep.pos.isNearTo(s));
  if (opening) {
    if (creep.dismantle(opening) === OK) cleared.add(opening.id);
  } else if (target && creep.pos.isNearTo(target)) creep.dismantle(target);
  else {
    const flank = approach.find((obstacle) => creep.pos.isNearTo(obstacle));
    if (flank) creep.dismantle(flank);
  }
}

interface SiegeTargets {
  tick: number;
  exposed: Structure[];
  openings: Structure[];
  approach: Structure[];
}
const roomTargets = new WeakMap<Room, SiegeTargets>();

function targetsInRoom(room: Room, spawns: StructureSpawn[]): SiegeTargets {
  const cached = roomTargets.get(room);
  if (cached?.tick === Game.time) return cached;
  const structures = room.find(FIND_HOSTILE_STRUCTURES).filter(s => s.hits > 0);
  const shields = new Map<number, Structure>();
  for (const s of structures) if (s.structureType === STRUCTURE_RAMPART) shields.set(tileKey(s.pos.x, s.pos.y), s);
  const exposed = structures.filter(s => s.structureType === STRUCTURE_RAMPART || !shields.has(tileKey(s.pos.x, s.pos.y)));
  const approach = exposed.filter(s => !isWalkableStructure(s) && spawns.some(spawn => spawn.pos.inRangeTo(s, 3)));
  const distance = (s: Structure) => Math.min(...spawns.map(spawn => spawn.pos.getRangeTo(s)));
  approach.sort((a,b) => distance(a) - distance(b) || a.hits - b.hits);
  const openings = approach.filter(s => s.hits <= 5000 && s.structureType !== STRUCTURE_RAMPART &&
    s.structureType !== STRUCTURE_SPAWN && distance(s) <= 2);
  const result = {tick: Game.time, exposed, approach, openings};
  roomTargets.set(room, result);
  return result;
}

const siegeHealing = new WeakMap<Room, { tick: number; assigned: Map<string, number> }>();
function healAndShoot(group: Creep[], room: Room, target?: Structure, gates?: ReadonlyMap<Creep, Structure>): void {
  const incoming = new Map<string, number>();
  let frame = siegeHealing.get(room);
  if (!frame || frame.tick !== Game.time) {
    frame = { tick: Game.time, assigned: new Map() };
    siegeHealing.set(room, frame);
  }
  const assigned = frame.assigned;
  const allies = room
    .find(FIND_MY_CREEPS)
    .filter(
      (c) =>
        c.memory.role === "siegeUnit" &&
        c.memory.roleArgs?.[2] === group[0]?.memory.roleArgs?.[2] &&
        !c.memory._warDetached,
    );
  for (const e of room.getEventLog())
    if (e.event === EVENT_ATTACK) incoming.set(e.data.targetId, (incoming.get(e.data.targetId) ?? 0) + e.data.damage);
  const spawns = room.find(FIND_HOSTILE_SPAWNS);
  const {openings, approach, exposed} = targetsInRoom(room, spawns);
  const cleared = new Set<string>();
  const underFire = allies.some((member) => (incoming.get(member.id) ?? 0) > 0);
  const towers = room
    .find(FIND_HOSTILE_STRUCTURES)
    .filter(
      (s): s is StructureTower =>
        s.structureType === STRUCTURE_TOWER &&
        (s as StructureTower).store.getUsedCapacity(RESOURCE_ENERGY) >= TOWER_ENERGY_COST,
    );
  const nearby = room
    .find(FIND_HOSTILE_CREEPS)
    .filter(
      (h) =>
        h.owner.username !== "Source Keeper" &&
        !room.lookForAt(LOOK_STRUCTURES, h.pos).some((s) => s.structureType === STRUCTURE_RAMPART),
    );
  for (const c of group) {
    if (c.getActiveBodyparts(HEAL)) {
      const patients = allies.filter((a) => c.pos.inRangeTo(a, 3));
      let best = c,
        bestScore = -Infinity;
      for (const p of patients) {
        // 首次齐射之前预治疗没有 HEAL 的拆墙兵，之后按上一帧各成员实际承伤分配。
        const towerVolley =
          p.getActiveBodyparts(WORK) > 0 ? towers.reduce((n, tower) => n + towerAttackPowerAt(tower, p.pos), 0) : 0;
        const risk = damageAfterTough(p.body, Math.max(towerVolley * (underFire ? 0.15 : 1), incoming.get(p.id) ?? 0));
        const missing = p.hitsMax - p.hits;
        const score = (missing + risk - (assigned.get(p.id) ?? 0)) * (c.pos.isNearTo(p) ? 1 : 1 / 3);
        if (score > bestScore || (score === bestScore && p === c)) {
          best = p;
          bestScore = score;
        }
      }
      const close = c.pos.isNearTo(best);
      if (close) c.heal(best);
      else c.rangedHeal(best);
      const power = effectivePower(c.body, HEAL);
      assigned.set(best.id, (assigned.get(best.id) ?? 0) + power * (close ? 1 : 1 / 3));
    }
    const core = siegeWeaponRange(c) === 3 && spawns
      .filter((spawn) => c.pos.inRangeTo(spawn, 3))
      .map((spawn) => cover(room, spawn))
      .sort((a, b) => Number(b.id === target?.id) - Number(a.id === target?.id) || a.hits - b.hits)[0];
    fire(c, gates?.get(c) ?? target, nearby, openings, cleared, approach, exposed, core || undefined);
  }
}

/** 攻击手只比较通道下一步与原地，两名治疗最多比较 9×9 个落点。 */
export function planBreachSteps(
  fighters: Creep[], medics: Creep[], desired: ReadonlyMap<Creep, RoomPosition>,
  walkable: (x: number, y: number) => boolean,
): Map<Creep, Tile> | undefined {
  const actors = [...fighters, ...medics];
  if (!fighters.length || !medics.length || actors.length > 4) return;
  const options: Tile[][] = actors.map(c => {
    const origin = c.pos;
    if (c.fatigue) return [origin];
    if (desired.has(c)) {
      const next = desired.get(c)!;
      return range(origin, next) && walkable(next.x, next.y) ? [next, origin] : [origin];
    }
    const tiles: Tile[] = [origin];
    for (let x = origin.x - 1; x <= origin.x + 1; x++)
      for (let y = origin.y - 1; y <= origin.y + 1; y++)
        if ((x !== origin.x || y !== origin.y) && walkable(x, y)) tiles.push({x, y});
    return tiles;
  });
  const chosen: Tile[] = [];
  let best: Map<Creep, Tile> | undefined, bestScore = -Infinity;
  const visit = (index: number, progress: number, moves: number): void => {
    if (index === actors.length) {
      const healers = chosen.slice(fighters.length);
      if (healers.length > 1 && healers.some(a => !healers.some(b => b !== a && range(a,b) <= 1))) return;
      let coverage = 0;
      for (let i = 0; i < fighters.length; i++) {
        const close = healers.filter(h => range(chosen[i],h) <= 1).length;
        if (!close || (fighters[i].hits < fighters[i].hitsMax * 0.85 && close < Math.min(2, healers.length))) return;
        coverage += close;
      }
      const score = 12 * progress + 2 * coverage - moves;
      if (score > bestScore) {
        bestScore = score;
        best = new Map(actors.map((c,i) => [c, chosen[i]]));
      }
      return;
    }
    const actor = actors[index];
    for (const at of options[index]) {
      if (chosen.some(p => p.x === at.x && p.y === at.y)) continue;
      const moved = Number(range(actor.pos, at) !== 0);
      chosen.push(at);
      visit(index + 1, progress + (index < fighters.length ? moved : 0), moves + moved);
      chosen.pop();
    }
  };
  visit(0,0,0);
  return best;
}

/** 将敌方建筑的拆除时间作为通行代价；实际移动始终止于第一个仍然存在的障碍。 */
export function advanceInBreach(room: Room, group: Creep[], spawn: StructureSpawn, orders?: Map<Creep, Structure>): Structure {
  const core = cover(room, spawn);
  const fighters = group.filter(isSiegeFighter)
    .sort((a,b) => a.pos.getRangeTo(spawn) - b.pos.getRangeTo(spawn) || slot(a) - slot(b));
  const medics = group.filter(c => c.getActiveBodyparts(HEAL));
  // 已经就位的部队保持火力与队形，避免无意义的寻路和医疗位互换。
  if (fighters.every(c => c.pos.inRangeTo(spawn, siegeWeaponRange(c))) &&
      fighters.every(c => medics.some(h => h.pos.isNearTo(c))) &&
      (medics.length < 2 || medics.every(h => medics.some(other => other !== h && h.pos.isNearTo(other))))) return core;
  const { single, blockers } = geometry(room);
  const lanes = single.clone();
  for (const c of room.find(FIND_CREEPS)) {
    if (!group.includes(c)) lanes.set(c.pos.x, c.pos.y, 255);
  }
  const reserved = new Set<number>();
  const destinations = new Map<Creep, RoomPosition>();
  const gates: Structure[] = [];
  for (const c of fighters) {
    let destination = c.pos;
    if (!c.fatigue && !c.pos.inRangeTo(spawn, siegeWeaponRange(c))) {
      const matrix = lanes.clone();
      for (const other of fighters) if (other !== c) matrix.set(other.pos.x, other.pos.y, 255);
      for (const k of reserved) matrix.set(k % 50, Math.floor(k / 50), 255);
      const lane = searchMovementPath(c.pos, {pos: spawn.pos, range: siegeWeaponRange(c)},
        {maxRooms: 1, maxOps: 2400, roomCallback: () => matrix});
      const next = lane.path[0];
      if (!lane.incomplete && next) {
        const id = blockers.get(tileKey(next.x, next.y));
        const gate = id && Game.getObjectById(id);
        if (gate) {
          gates.push(gate);
          orders?.set(c, gate);
        }
        else if (medics.some(h => h.pos.inRangeTo(next, 2)) && !medics.some(h => h.fatigue && h.pos.isEqualTo(next))) {
          destination = next;
        }
      }
    }
    destinations.set(c, destination);
    reserved.add(tileKey(destination.x, destination.y));
  }
  const walkable = (x: number, y: number) => x >= 1 && x <= 48 && y >= 1 && y <= 48 &&
    lanes.get(x,y) < 255 && !blockers.has(tileKey(x,y));
  const steps = planBreachSteps(fighters, medics, destinations, walkable);
  if (steps) {
    for (const [c,at] of steps) {
      if (range(c.pos,at)) c.move(c.pos.getDirectionTo(new RoomPosition(at.x, at.y, room.name)));
    }
  } else {
    // 遭遇拥堵、增援分离或部件受损时，先向同一攻击手重新集中。全组仍可就地集火与治疗。
    const leader = fighters[0];
    for (const c of group) if (c !== leader && !c.fatigue && !c.pos.isNearTo(leader)) {
      c.moveTo(leader.pos, {...walk, range: 1});
    }
  }
  return gates.sort((a,b) => a.hits - b.hits)[0] ?? core;
}

/** 优先突破能同时控制多个 Spawn 的核心，防止各翼在外围反复拆掉又重建的兵营。 */
export function selectSiegeCore(spawns: StructureSpawn[], origin: Tile): StructureSpawn | undefined {
  const coverage=(s:StructureSpawn)=>spawns.filter(other=>range(s.pos,other.pos)<=3).length;
  return [...spawns].sort((a,b)=>coverage(b)-coverage(a) || range(origin,a.pos)-range(origin,b.pos))[0];
}

/** 接班兵先赶到老兵身边提供火力或治疗，战斗槽的接管由战役调度统一完成。 */
export function runSiegeRelief(creep: Creep, task: WarTask, index: number): void {
  const wing = Math.floor(index / 4);
  const front = creep.room.find(FIND_MY_CREEPS).filter(c => c !== creep && c.memory.role === "siegeUnit" &&
    c.memory.roleArgs?.[2] === creep.memory.roleArgs?.[2] && c.memory._siegeSlot !== undefined &&
    Math.floor(c.memory._siegeSlot / 4) === wing && !c.memory._warDetached);
  const veteran = front.find(c => c.memory._siegeSlot === index) ?? creep.pos.findClosestByRange(front);
  const spawns = creep.room.find(FIND_HOSTILE_SPAWNS);
  const objective = spawns.find(s => s.id === task.siegeCore) ?? selectSiegeCore(spawns, creep.pos);
  healAndShoot([creep], creep.room, objective && cover(creep.room, objective));
  if (veteran && !creep.fatigue && !creep.pos.isNearTo(veteran)) creep.moveTo(veteran.pos, {...walk, range: 1});
}

const frames = new WeakMap<Room, Set<string>>();
const turns = new WeakMap<Room, number>();
export function runSiegeFormation(creep: Creep, task: WarTask): void {
  const room = creep.room,
    wing = groupId(creep),
    key = task.sourceRoom + ":" + wing;
  if (turns.get(room) !== Game.time) {
    turns.set(room, Game.time);
    frames.set(room, new Set());
  }
  const done = frames.get(room)!;
  if (done.has(key)) return;
  done.add(key);
  const group = room
    .find(FIND_MY_CREEPS)
    .filter(
      (c) =>
        c.memory.role === "siegeUnit" &&
        c.memory.roleArgs?.[0] === task.targetRoom &&
        c.memory.roleArgs?.[2] === creep.memory.roleArgs?.[2] &&
        c.memory._siegeReliefSlot === undefined && groupId(c) === wing &&
        !c.memory._warDetached,
    );
  const anchors = (task.siegeAnchors ??= {});
  const flank = wing === 2 && task.routeOrigin !== "manual" ? task.siegeFlankRoute : undefined;
  const ingress = flank?.[flank.length - 2] ?? task.siegeStagingRoom ?? task.sourceRoom;
  const anchor = (anchors[wing] ??= entryAnchor(room, ingress, wing));
  const leader = group.find((c) => slot(c) === 0);
  const spawns = room.find(FIND_HOSTILE_SPAWNS);
  const original = spawns.find(s=>s.id===task.siegeCore) ?? selectSiegeCore(spawns,anchor);
  if(original)task.siegeCore=original.id;
  let objective = original ? cover(room, original) : undefined;
  const previousFront = task.siegeFront?.[wing] ?? 0;
  const formations = (task.siegeFormationOrder ??= {});
  const order = (formations[wing] ??= offsets.map((_, i) => (i === 0 ? previousFront : i === previousFront ? 0 : i)));
  const cell = (member: Creep) => order[slot(member)];
  const fighters = group.filter(isSiegeFighter);
  const reach = fighters.length && fighters.every((member) => siegeWeaponRange(member) === 3) ? 3 : 1;
  const face = (obstacle: Structure, distance = 1) => {
    // 已能拆除的队员原地工作，其余拆墙兵与相邻障碍的护卫交换位置。
    const drills = group.filter((member) => member.getActiveBodyparts(WORK) > 0);
    const contact = group.filter((member) => member.pos.inRangeTo(obstacle, distance)).length;
    if (contact < drills.length && group.every((member) => !member.fatigue)) {
      const terrain = geometry(room);
      const origin = new RoomPosition(anchor.x, anchor.y, room.name);
      for (const dx of [-1, 0, 1])
        for (const dy of [-1, 0, 1]) {
          const at = { x: anchor.x + dx, y: anchor.y + dy };
          if (at.x < 1 || at.y < 1 || at.x > 47 || at.y > 47 || terrain.matrix.get(at.x, at.y) > 2) continue;
          const cells = offsets.map((d) => footprint(at, d));
          if (cells.filter((p) => range(p, obstacle.pos) <= distance).length <= contact) continue;
          if (
            cells.some(
              (p) =>
                terrain.blockers.has(tileKey(p.x, p.y)) ||
                room.lookForAt(LOOK_CREEPS, p.x, p.y).some((c) => !group.includes(c)),
            )
          )
            continue;
          const direction = origin.getDirectionTo(at.x, at.y);
          for (const member of group) member.move(direction);
          anchors[wing] = at;
          return;
        }
    }
    const frontMedics = group.filter((member) => !member.getActiveBodyparts(WORK) && member.pos.inRangeTo(obstacle, distance));
    for (const drill of group.filter((member) => member.getActiveBodyparts(WORK) && !member.pos.inRangeTo(obstacle, distance))) {
      const partner = frontMedics.shift();
      if (!partner) break;
      const a = slot(drill),
        b = slot(partner);
      [order[a], order[b]] = [order[b], order[a]];
    }
  };
  const breaches = (task.siegeBreach ??= {});
  const pinned = breaches[wing] && Game.getObjectById(breaches[wing]);
  if (pinned) objective = pinned;
  else delete breaches[wing];
  // 堡垒内按各攻击手的真实射程寻找单兵通道，医疗兵跟进；增援可从入口直接接回队友。
  if (original && fighters.some(c => c.pos.inRangeTo(original, 8)) && group.some(c => c.getActiveBodyparts(HEAL))) {
    const orders = new Map<Creep, Structure>();
    const target = advanceInBreach(room, group, original, orders);
    healAndShoot(group, room, target, orders);
    return;
  }
  const assembled =
    group.length === 4 &&
    group.every((c) => {
      const at = footprint(anchor, offsets[cell(c)]);
      return c.pos.x === at.x && c.pos.y === at.y;
    });
  if (!assembled) {
    for (const c of group) {
      const at = footprint(anchor, offsets[cell(c)]),
        goal = new RoomPosition(at.x, at.y, room.name);
      if (c.pos.isEqualTo(goal)) continue;
      if (c.pos.isNearTo(goal)) c.move(c.pos.getDirectionTo(goal));
      else c.moveTo(goal, walk);
    }
    healAndShoot(group, room, objective);
    return;
  }
  if (!leader || !spawns.length) {
    healAndShoot(group, room, objective);
    return;
  }
  const exposedSpawn = original && group.some(member=>member.pos.inRangeTo(original,reach)) ? original : undefined;
  if (exposedSpawn) {
    const protectedTarget = cover(room, exposedSpawn);
    face(protectedTarget, reach);
    healAndShoot(group, room, protectedTarget);
    return;
  }
  if (pinned && group.some((c) => c.pos.isNearTo(pinned))) {
    face(pinned);
    healAndShoot(group, room, pinned);
    return;
  }
  const { matrix, blockers } = geometry(room);
  // 任一队员能贴到 Spawn，就能在方阵内换位；无需拆出额外一列道路。
  const goals = (original ? [original] : spawns).flatMap((spawn) =>
    offsets.map((offset) => ({
      pos: new RoomPosition(spawn.pos.x - offset.x, spawn.pos.y - offset.y, room.name),
      range: reach,
    })),
  );
  const origin = new RoomPosition(anchor.x, anchor.y, room.name);
  const otherWing = room.find(FIND_MY_CREEPS).filter((c) => c.memory.role === "siegeUnit" && !group.includes(c));
  const lanes = otherWing.length ? matrix.clone() : matrix;
  for (const ally of otherWing) {
    for (const offset of offsets) {
      const x = ally.pos.x - offset.x,
        y = ally.pos.y - offset.y;
      if (x >= 1 && x <= 47 && y >= 1 && y <= 47 && (x !== anchor.x || y !== anchor.y)) lanes.set(x, y, 255);
    }
  }
  const path = searchMovementPath(origin, goals, { maxRooms: 1, maxOps: 7000, roomCallback: () => lanes });
  const next = path.path[0];
  if (!path.incomplete && next) {
    const obstacles = offsets.flatMap((d) => {
      const id = blockers.get(tileKey(next.x + d.x, next.y + d.y));
      const current = id && Game.getObjectById(id);
      return current ? [current] : [];
    });
    const barrier = obstacles.sort((a, b) => leader.pos.getRangeTo(a) - leader.pos.getRangeTo(b) || a.hits - b.hits)[0];
    if (barrier) {
      objective = barrier;
      breaches[wing] = barrier.id;
      face(barrier);
    } else if (group.every((c) => !c.fatigue)) {
      const direction = origin.getDirectionTo(next);
      for (const c of group) c.move(direction);
      anchors[wing] = { x: next.x, y: next.y };
    }
  } else if (!path.incomplete) {
    const adjacent = spawns.find((s) => leader.pos.isNearTo(s));
    if (adjacent) objective = cover(room, adjacent);
  }
  healAndShoot(group, room, objective);
}
