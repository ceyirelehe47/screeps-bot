import { getTickContextService } from "@/runtime/runtimeServices";

const CORE_ATTACK_RANGE = 3;
const NUKE_DAMAGE_RANGE = 2;

function getCorePositions(room: Room, structures: Structure<StructureConstant>[]): RoomPosition[] {
  const layout = Memory.data?.roomPlanner?.[room.name]?.layout;
  const positions = [...(layout?.[STRUCTURE_SPAWN] ?? []), ...(layout?.[STRUCTURE_STORAGE] ?? []),
    ...structures.map(structure => structure.pos)];
  const seen = new Set<string>();
  return positions.filter(pos => {
    const key = `${pos.x}:${pos.y}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(pos => new RoomPosition(pos.x, pos.y, room.name));
}

function hasCreepThreatNearPosition(hostiles: Creep[], pos: RoomPosition): boolean {
  return hostiles.some(creep =>
    ((creep.getActiveBodyparts(ATTACK) > 0 || creep.getActiveBodyparts(WORK) > 0) && creep.pos.getRangeTo(pos) <= 1) ||
    (creep.getActiveBodyparts(RANGED_ATTACK) > 0 && creep.pos.getRangeTo(pos) <= CORE_ATTACK_RANGE));
}

function tryActivateSafeMode(room: Room): boolean {
  const controller = room.controller;
  if (!controller?.my || (controller.safeMode ?? 0) > 0 || (controller.safeModeCooldown ?? 0) > 0 ||
      (controller.safeModeAvailable ?? 0) <= 0) return false;
  const code = controller.activateSafeMode();
  if (code !== OK) return false;
  console.log(`[coreDefense] ${room.name} activated safe mode: core under creep attack`);
  return true;
}

function evaluateRoomCore(room: Room): void {
  const context = getTickContextService().getRoomContext(room);
  const hostiles = context?.getHostileCreeps() ?? room.find(FIND_HOSTILE_CREEPS);
  const structures = (context?.getMyStructures() ?? room.find(FIND_MY_STRUCTURES)).filter(structure =>
    structure.structureType === STRUCTURE_SPAWN || structure.structureType === STRUCTURE_STORAGE ||
    structure.structureType === STRUCTURE_TOWER);
  const hitStore = room.memory.coreRampartHits ??= {};
  const previous = room.memory.coreDefenseSnapshot;
  const elapsed = previous ? Math.max(0, Game.time - previous.tick) : 1;
  const decayTimers: Record<string, number> = {};
  const structureHits: Record<string, { hits: number; x: number; y: number }> = {};
  const nukes = room.find(FIND_NUKES).map(nuke => ({ x: nuke.pos.x, y: nuke.pos.y, landsAt: Game.time + nuke.timeToLand }));
  const nukeDamageAt = (pos: RoomPosition): boolean => [...nukes, ...(previous?.nukes ?? [])].some(nuke =>
    nuke.landsAt >= Game.time - elapsed && nuke.landsAt <= Game.time + 1 &&
    Math.max(Math.abs(nuke.x - pos.x), Math.abs(nuke.y - pos.y)) <= NUKE_DAMAGE_RANGE);
  let triggered = false;
  const triggerAt = (pos: RoomPosition): void => {
    if (!triggered && !nukeDamageAt(pos) && hasCreepThreatNearPosition(hostiles, pos)) triggered = tryActivateSafeMode(room);
  };

  // attackController 生效后 upgradeBlocked 会禁止激活；相邻敌 CLAIM 必须提前拦截。
  if (room.controller?.pos && hostiles.some(creep => creep.getActiveBodyparts(CLAIM) > 0 && creep.pos.getRangeTo(room.controller!.pos) <= 1)) {
    triggered = tryActivateSafeMode(room);
  }

  const validKeys = new Set<string>();
  for (const pos of getCorePositions(room, structures)) {
    const key = `${pos.x}:${pos.y}`;
    validKeys.add(key);
    const rampart = pos.lookFor(LOOK_STRUCTURES).find(structure => structure.structureType === STRUCTURE_RAMPART &&
      (structure as StructureRampart).my) as StructureRampart | undefined;
    const previousHits = hitStore[key];
    const hitLoss = previousHits === undefined ? 0 : previousHits - (rampart?.hits ?? 0);
    const previousDecay = previous?.rampartDecay[key];
    // 以结构计时器判断这段时间内是否真实跨过衰减点；兼容首次升级时仅有 hits 的旧快照。
    const decays = previousDecay !== undefined
      ? (elapsed >= previousDecay ? 1 + Math.floor((elapsed - previousDecay) / RAMPART_DECAY_TIME) : 0)
      : (rampart && rampart.ticksToDecay >= RAMPART_DECAY_TIME - elapsed ? 1 : 0);
    const naturalLoss = Math.min(previousHits ?? 0, decays * RAMPART_DECAY_AMOUNT);
    if (hitLoss > naturalLoss) triggerAt(pos);
    if (rampart) {
      hitStore[key] = rampart.hits;
      decayTimers[key] = rampart.ticksToDecay;
    } else delete hitStore[key];
  }
  for (const key of Object.keys(hitStore)) if (!validKeys.has(key)) delete hitStore[key];

  for (const structure of structures) {
    const priorHits = previous?.structureHits[structure.id];
    if (priorHits !== undefined && structure.hits < priorHits.hits) triggerAt(structure.pos);
    structureHits[structure.id] = { hits: structure.hits, x: structure.pos.x, y: structure.pos.y };
  }
  for (const [id, lost] of Object.entries(previous?.structureHits ?? {})) {
    if (!structureHits[id]) triggerAt(new RoomPosition(lost.x, lost.y, room.name));
  }
  room.memory.coreDefenseSnapshot = { tick: Game.time, rampartDecay: decayTimers, structureHits, nukes };
}

export function runCoreDefense(): void {
  for (const room of getTickContextService().getMyRooms()) evaluateRoomCore(room);
}
