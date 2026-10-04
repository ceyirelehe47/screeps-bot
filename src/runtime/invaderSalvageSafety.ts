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

/** Core 本身不按整房攻击威胁处理；生产前的清场门与实际过房许可分别调用。 */
export function isInvaderSalvageTransitAllowed(room: Room | undefined, targetRoom?: string): room is Room {
  if (!room || Game.rooms[room.name] !== room) return false;
  const owner = room.controller?.owner?.username;
  if (owner && !room.controller?.my && owner !== "Invader" && !(room.name === targetRoom && owner === "TooAngel")) return false;
  if (room.find(FIND_HOSTILE_POWER_CREEPS).length) return false;
  if (room.find(FIND_STRUCTURES).some(s => s.structureType === STRUCTURE_TOWER && (s as StructureTower).my !== true &&
    (!(s as StructureTower).store || (s as StructureTower).store.getUsedCapacity(RESOURCE_ENERGY) >= TOWER_ENERGY_COST))) return false;
  return !room.find(FIND_HOSTILE_CREEPS).some(c => c.owner?.username !== "Source Keeper" &&
    (offensiveRadius(c) === undefined || ((offensiveRadius(c) ?? 0) > 0 && !c.pos)));
}

export function isInvaderSalvageRoomClear(room: Room | undefined): room is Room {
  return isInvaderSalvageTransitAllowed(room, room?.name) &&
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
