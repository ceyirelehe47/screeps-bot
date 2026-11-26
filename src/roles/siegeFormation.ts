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
const groupId = (c: Creep) => Math.floor(siegeSlot(c) / 4);
const slot = (c: Creep) => siegeSlot(c) % 4;
const walk = { maxRooms: 1, ignoreCreeps: false, reusePath: 3 } as const;

function footprint(anchor: Tile, offset: Tile): Tile {
  return { x: anchor.x + offset.x, y: anchor.y + offset.y };
}

interface Geometry {
  matrix: CostMatrix;
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
  for (let y = 0; y < 50; y++)
    for (let x = 0; x < 50; x++) {
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
  const result = { matrix, blockers };
  terrainCache.set(room.name, { at: Game.time, geometry: result });
  return result;
}

export function siegeRally(room: Room, nextRoom: string, wing: number): RoomPosition {
  const dir = Game.map.findExit(room.name, nextRoom);
  if (dir < 0) return new RoomPosition(25, 25, room.name);
  const exits = room.find(dir as ExitConstant);
  const tile = exits[Math.min(exits.length - 1, Math.max(0, Math.floor(exits.length / 2) + (wing ? 2 : -2)))];
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

function cover(room: Room, target: Structure): Structure {
  return (
    room
      .lookForAt(LOOK_STRUCTURES, target.pos)
      .find((s) => s.structureType === STRUCTURE_RAMPART && !(s as StructureRampart).my) ?? target
  );
}
function fire(creep: Creep, target: Structure | undefined, nearby: Creep[]): void {
  const enemy = nearby.filter((h) => creep.pos.inRangeTo(h, 3)).sort((a, b) => a.hits - b.hits)[0];
  if (enemy) creep.rangedAttack(enemy);
  else if (target && creep.pos.inRangeTo(target, 3)) creep.rangedAttack(target);
  if (target && creep.getActiveBodyparts(WORK) && creep.pos.isNearTo(target)) creep.dismantle(target);
}

function healAndShoot(group: Creep[], room: Room, target?: Structure): void {
  const incoming = new Map<string, number>(),
    assigned = new Map<string, number>();
  for (const e of room.getEventLog())
    if (e.event === EVENT_ATTACK) incoming.set(e.data.targetId, (incoming.get(e.data.targetId) ?? 0) + e.data.damage);
  const underFire = group.some((member) => (incoming.get(member.id) ?? 0) > 0);
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
      const patients = group.filter((a) => c.pos.inRangeTo(a, 3));
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
    fire(c, target, nearby);
  }
}

/** 只需打通拆墙位及治疗位就能攻击 Spawn，避免为完整方阵额外拆除第四格屏障。 */
function findSpawnAssaultTiles(room: Room, group: Creep[], spawn: StructureSpawn): Tile[] | undefined {
  const drills = group.filter((c) => c.getActiveBodyparts(WORK));
  const medics = group.filter((c) => c.getActiveBodyparts(HEAL));
  if (!drills.some((c) => c.pos.inRangeTo(spawn, 2)) || medics.length < 2 || group.some((c) => c.fatigue)) return;
  const actors = [...drills, ...medics];
  if (actors.length !== 4) return;
  const free = new Map<number, boolean>();
  const terrain = Game.map.getRoomTerrain(room.name);
  const options = actors.map((c) => {
    const tiles: Tile[] = [];
    for (let y = c.pos.y - 1; y <= c.pos.y + 1; y++)
      for (let x = c.pos.x - 1; x <= c.pos.x + 1; x++) {
        if (x < 1 || y < 1 || x > 48 || y > 48) continue;
        const k = tileKey(x, y);
        if (!free.has(k))
          free.set(
            k,
            !(terrain.get(x, y) & TERRAIN_MASK_WALL) &&
              !room
                .lookAt(x, y)
                .some(
                  (o) =>
                    o.source ||
                    o.mineral ||
                    o.deposit ||
                    o.powerCreep ||
                    (o.structure && !isWalkableStructure(o.structure)) ||
                    (o.creep && !group.includes(o.creep)),
                ),
          );
        if (free.get(k)) tiles.push({ x, y });
      }
    return tiles.sort((a, b) => range(a, c.pos) - range(b, c.pos));
  });
  const chosen: Tile[] = [];
  let best: Tile[] | undefined,
    bestScore = -Infinity;
  function search(i: number, adjacent: number, steps: number): void {
    if (i === actors.length) {
      if (!adjacent) return;
      const score = adjacent * 10 - steps;
      if (score > bestScore) {
        bestScore = score;
        best = [];
        actors.forEach((c, index) => {
          best![slot(c)] = chosen[index];
        });
      }
      return;
    }
    for (const at of options[i]) {
      if (chosen.some((p) => p.x === at.x && p.y === at.y)) continue;
      const isDrill = i < drills.length;
      const nextAdjacent = adjacent + Number(isDrill && range(at, spawn.pos) <= 1);
      if (i === drills.length - 1 && !nextAdjacent) continue;
      // 两名护卫均能贴身治疗所有拆墙兵，也互相覆盖。
      if (!isDrill && chosen.some((p) => range(p, at) > 1)) continue;
      chosen.push(at);
      search(i + 1, nextAdjacent, steps + Number(range(actors[i].pos, at) > 0));
      chosen.pop();
    }
  }
  search(0, 0, 0);
  return best;
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
        groupId(c) === wing &&
        !c.memory._warDetached,
    );
  const anchors = (task.siegeAnchors ??= {});
  const anchor = (anchors[wing] ??= entryAnchor(room, task.siegeStagingRoom ?? task.sourceRoom, wing));
  const leader = group.find((c) => slot(c) === 0);
  const spawns = room.find(FIND_HOSTILE_SPAWNS);
  const original = spawns.sort((a, b) => range(anchor, a.pos) - range(anchor, b.pos))[0];
  let objective = original ? cover(room, original) : undefined;
  const previousFront = task.siegeFront?.[wing] ?? 0;
  const formations = (task.siegeFormationOrder ??= {});
  const order = (formations[wing] ??= offsets.map((_, i) => (i === 0 ? previousFront : i === previousFront ? 0 : i)));
  const cell = (member: Creep) => order[slot(member)];
  const face = (obstacle: Structure) => {
    // 已能拆除的队员原地工作，其余拆墙兵与相邻障碍的护卫交换位置。
    const drills = group.filter((member) => member.getActiveBodyparts(WORK) > 0);
    const contact = group.filter((member) => member.pos.isNearTo(obstacle)).length;
    if (contact < drills.length && group.every((member) => !member.fatigue)) {
      const terrain = geometry(room);
      const origin = new RoomPosition(anchor.x, anchor.y, room.name);
      for (const dx of [-1, 0, 1])
        for (const dy of [-1, 0, 1]) {
          const at = { x: anchor.x + dx, y: anchor.y + dy };
          if (at.x < 1 || at.y < 1 || at.x > 47 || at.y > 47 || terrain.matrix.get(at.x, at.y) > 2) continue;
          const cells = offsets.map((d) => footprint(at, d));
          if (cells.filter((p) => range(p, obstacle.pos) <= 1).length <= contact) continue;
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
    const frontMedics = group.filter((member) => !member.getActiveBodyparts(WORK) && member.pos.isNearTo(obstacle));
    for (const drill of group.filter((member) => member.getActiveBodyparts(WORK) && !member.pos.isNearTo(obstacle))) {
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
  const strikes = (task.siegeStrike ??= {});
  const existingStrike = strikes[wing];
  let strikeSpawn = existingStrike && spawns.find((s) => s.id === existingStrike.spawn);
  if (existingStrike && !strikeSpawn) delete strikes[wing];
  if (!strikeSpawn && original && group.length === 4 && Game.time % 4 === wing
      && group.some(member => member.getActiveBodyparts(WORK) && !member.pos.isNearTo(original))) {
    const positions = findSpawnAssaultTiles(room, group, original);
    if (positions) {
      strikes[wing] = { spawn: original.id, tiles: positions };
      strikeSpawn = original;
    }
  }
  if (strikeSpawn) {
    for (const member of group) {
      const at = strikes[wing].tiles[slot(member)];
      if (!at || (member.pos.x === at.x && member.pos.y === at.y)) continue;
      const goal = new RoomPosition(at.x, at.y, room.name);
      if (member.pos.isNearTo(goal)) member.move(member.pos.getDirectionTo(goal));
      else member.moveTo(goal, walk);
    }
    healAndShoot(group, room, cover(room, strikeSpawn));
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
  const exposedSpawn = spawns.find((spawn) => group.some((member) => member.pos.isNearTo(spawn)));
  if (exposedSpawn) {
    const protectedTarget = cover(room, exposedSpawn);
    face(protectedTarget);
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
  const goals = spawns.flatMap((spawn) =>
    offsets.map((offset) => ({
      pos: new RoomPosition(spawn.pos.x - offset.x, spawn.pos.y - offset.y, room.name),
      range: 1,
    })),
  );
  const origin = new RoomPosition(anchor.x, anchor.y, room.name);
  const path = PathFinder.search(origin, goals, { maxRooms: 1, maxOps: 7000, roomCallback: () => matrix });
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
