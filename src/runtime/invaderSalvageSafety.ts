interface SalvageHazard { pos: RoomPosition; radius: number }

function offensiveRadius(creep: Creep): number | undefined {
  const count = (part: BodyPartConstant): number | undefined => {
    if (typeof creep.getActiveBodyparts === "function") return creep.getActiveBodyparts(part);
    if (Array.isArray(creep.body)) return creep.body.filter(p => p.type === part && p.hits > 0).length;
    return undefined;
  };
  const attack = count(ATTACK), ranged = count(RANGED_ATTACK);
  if (attack === undefined || ranged === undefined) return undefined;
  return ranged > 0 ? 5 : attack > 0 ? 3 : 0;
}

/** 回收来源只认新鲜 Invader 身份；旗名与旧任务布尔标记不构成来源证据。 */
export function isInvaderSalvageTarget(room: Room | undefined): room is Room {
  if (!room || Game.rooms[room.name] !== room || room.controller?.my) return false;
  const authorities = [room.controller?.owner?.username, room.controller?.reservation?.username];
  if (authorities.some(name => name && name !== "Invader")) return false;
  if (authorities.includes("Invader")) return true;
  if (room.find(FIND_STRUCTURES).some(s => s.structureType === STRUCTURE_INVADER_CORE)) return true;
  // 已取空但尚未衰减的 Invader 遗产仍可支持同房残留物回收。
  return room.find(FIND_RUINS).some(ruin => {
    const structure = ruin.structure;
    return structure?.structureType === STRUCTURE_INVADER_CORE
      || (structure && "owner" in structure && structure.owner?.username === "Invader");
  }) || room.find(FIND_TOMBSTONES).some(tombstone => tombstone.creep?.owner?.username === "Invader");
}

/** Core 本身不按整房攻击威胁处理；返程过房不要求具备回收来源资格。 */
export function isInvaderSalvageTransitAllowed(room: Room | undefined, _targetRoom?: string): room is Room {
  if (!room || Game.rooms[room.name] !== room) return false;
  const owner = room.controller?.owner?.username;
  if (owner && !room.controller?.my && owner !== "Invader") return false;
  if (room.find(FIND_HOSTILE_POWER_CREEPS).length) return false;
  if (room.find(FIND_STRUCTURES).some(s => s.structureType === STRUCTURE_TOWER && (s as StructureTower).my !== true &&
    (!(s as StructureTower).store || (s as StructureTower).store.getUsedCapacity(RESOURCE_ENERGY) >= TOWER_ENERGY_COST))) return false;
  return !room.find(FIND_HOSTILE_CREEPS).some(c => c.owner?.username !== "Source Keeper" &&
    (offensiveRadius(c) === undefined || ((offensiveRadius(c) ?? 0) > 0 && !c.pos)));
}

export function isInvaderSalvageRoomClear(room: Room | undefined): room is Room {
  return isInvaderSalvageTarget(room) && isInvaderSalvageTransitAllowed(room, room.name) &&
    !room.find(FIND_STRUCTURES).some(s => s.structureType === STRUCTURE_INVADER_CORE);
}

export function getInvaderSalvageKeepers(room: Room): Creep[] {
  return room.find(FIND_HOSTILE_CREEPS).filter(c => c.owner?.username === "Source Keeper");
}

export function getInvaderSalvageHazards(room: Room): SalvageHazard[] {
  const hazards: SalvageHazard[] = room.find(FIND_STRUCTURES)
    .filter(s => s.structureType === STRUCTURE_KEEPER_LAIR).map(s => ({ pos: s.pos, radius: 5 }));
  for (const creep of room.find(FIND_HOSTILE_CREEPS)) {
    const radius = creep.owner?.username === "Source Keeper" ? 5 : offensiveRadius(creep);
    if (creep.pos && radius && radius > 0) hazards.push({ pos: creep.pos, radius });
  }
  return hazards;
}

export function outsideInvaderSalvageHazards(pos: RoomPosition, hazards: readonly SalvageHazard[]): boolean {
  return hazards.every(h => h.pos.roomName === pos.roomName && Math.max(Math.abs(h.pos.x - pos.x), Math.abs(h.pos.y - pos.y)) > h.radius);
}

export function isInvaderSalvagePositionSafe(room: Room, pos: RoomPosition): boolean {
  return Game.rooms[room.name] === room && pos.roomName === room.name && outsideInvaderSalvageHazards(pos, getInvaderSalvageHazards(room));
}

export function invaderSalvageRouteCost(roomName: string, targetRoom: string): number {
  const room = Game.rooms[roomName];
  if (!room) return 1;
  if (!isInvaderSalvageTransitAllowed(room, targetRoom)) return Infinity;
  const area = getInvaderSalvageHazards(room).reduce((sum, h) => sum + (h.radius * 2 + 1) ** 2, 0);
  return 1 + Math.min(1, area / 2500);
}
