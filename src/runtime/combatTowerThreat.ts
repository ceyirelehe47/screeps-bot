import { isWalkableStructure } from "@/movement/common";

export const TOWER_DRAIN_DAMAGE_RESERVE = 1000;

/** 清剿配置评估与执行门共用当前塔伤；只将已发生的补能视为威胁。 */
export function towerAttackPowerAt(tower: StructureTower, tile: { x: number; y: number }): number {
  const distance = Math.max(Math.abs(tower.pos.x - tile.x), Math.abs(tower.pos.y - tile.y));
  const decline = Math.max(0, Math.min(1, (distance - TOWER_OPTIMAL_RANGE) / (TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE)));
  let multiplier = 1;
  for (const effect of tower.effects ?? []) {
    if (effect.effect !== PWR_OPERATE_TOWER || effect.ticksRemaining <= 0) continue;
    const values = POWER_INFO[PWR_OPERATE_TOWER].effect;
    const amount = Array.isArray(values) ? values[(effect.level ?? 1) - 1] : values;
    if (typeof amount === "number" && Number.isFinite(amount)) multiplier = Math.max(multiplier, amount);
  }
  return Math.ceil(TOWER_POWER_ATTACK * (1 - TOWER_FALLOFF * decline) * multiplier);
}

export interface TowerThreat { tower: StructureTower; refillAt: number; live: boolean }

export function getHostileTowers(room: Room): StructureTower[] {
  return room.find(FIND_HOSTILE_STRUCTURES).filter((structure): structure is StructureTower => structure.structureType === STRUCTURE_TOWER);
}

export function getHostileTowerThreats(room: Room): TowerThreat[] {
  const carriers = room.find(FIND_HOSTILE_CREEPS).filter(actor => actor.store?.getUsedCapacity(RESOURCE_ENERGY) > 0 && actor.body?.some(part => part.type === CARRY && part.hits > 0));
  return getHostileTowers(room).map(tower => {
    const energy = tower.store.getUsedCapacity(RESOURCE_ENERGY);
    const live = energy >= TOWER_ENERGY_COST;
    const refill = carriers.some(actor => Math.max(Math.abs(actor.pos.x - tower.pos.x), Math.abs(actor.pos.y - tower.pos.y)) <= 1 && actor.store.getUsedCapacity(RESOURCE_ENERGY) >= TOWER_ENERGY_COST - energy);
    return { tower, live, refillAt: live ? 0 : refill ? 1 : Infinity };
  });
}

export function getRefillableHostileTowers(room: Room): StructureTower[] {
  return getHostileTowerThreats(room).filter(threat => Number.isFinite(threat.refillAt)).map(threat => threat.tower);
}

/** 候选房边两个相邻可通行格的最低塔伤。到场时仍需核实两侧路径、敌军和队形。 */
export function minimumEntryTowerDamage(room: Room, direction: number, towers: StructureTower[]): number {
  const terrain = Game.map.getRoomTerrain(room.name);
  const blocked = new Set(room.find(FIND_STRUCTURES).filter(structure => !isWalkableStructure(structure)).map(structure => `${structure.pos.x}:${structure.pos.y}`));
  const tile = (coordinate: number) => direction === TOP ? { x: coordinate, y: 0 } : direction === BOTTOM ? { x: coordinate, y: 49 }
    : direction === LEFT ? { x: 0, y: coordinate } : { x: 49, y: coordinate };
  const open = (position: { x: number; y: number }) => terrain.get(position.x, position.y) !== TERRAIN_MASK_WALL && !blocked.has(`${position.x}:${position.y}`);
  let minimum = Infinity;
  for (let coordinate = 1; coordinate < 48; coordinate++) {
    const red = tile(coordinate), green = tile(coordinate + 1);
    if (!open(red) || !open(green)) continue;
    const damage = Math.max(...[red, green].map(position => towers.reduce((sum, tower) => sum + towerAttackPowerAt(tower, position), 0)));
    minimum = Math.min(minimum, damage);
  }
  return minimum;
}
