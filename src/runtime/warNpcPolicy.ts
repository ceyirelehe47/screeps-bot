import { getRefillableHostileTowers, towerAttackPowerAt } from "@/runtime/combatTowerThreat";
import { effectivePower } from "@/runtime/powerBankCapability";
import { isWalkableStructure } from "@/movement/common";

const NPC_USERS = new Set(["Invader", "TooAngel"]);

export function isNpcWarTarget(room: Room): boolean {
  const owners = [room.controller?.owner?.username, room.controller?.reservation?.username,
    ...room.find(FIND_HOSTILE_CREEPS).map(actor => actor.owner.username),
    ...room.find(FIND_HOSTILE_STRUCTURES).map(structure => "owner" in structure ? (structure as OwnedStructure).owner.username : undefined)].filter((name): name is string => !!name);
  return owners.length > 0 && owners.every(name => NPC_USERS.has(name));
}

/** 首先尝试现有无强化身体。这里只决定生产配置，实际推进仍由战术退路门逐步验证。 */
export function assessUnboostedNpc(room: Room, route: string[] | undefined, attackerBody: BodyPartConstant[], healerBody: BodyPartConstant[], sourceCapacity?: number): { sufficient: boolean; reason: string } {
  const bodyCost = (body: BodyPartConstant[]) => body.reduce((sum, part) => sum + BODYPART_COST[part], 0);
  if (sourceCapacity !== undefined && sourceCapacity < Math.max(bodyCost(attackerBody), bodyCost(healerBody))) return { sufficient: false, reason: "source_cannot_spawn_unboosted_body" };
  const heal = healerBody.filter(part => part === HEAL).length * HEAL_POWER;
  const attack = attackerBody.filter(part => part === ATTACK).length * ATTACK_POWER;
  if (room.find(FIND_HOSTILE_CREEPS).reduce((sum, actor) => sum + effectivePower(actor.body ?? [], HEAL), 0) >= attack) return { sufficient: false, reason: "hostile_heal_exceeds_attack" };
  const towers = getRefillableHostileTowers(room);
  if (towers.length === 0) return { sufficient: true, reason: "no_current_tower_threat" };
  const previous = route?.[route.length - 2];
  const direction = Object.entries(Game.map.describeExits(room.name) ?? {}).find(([, name]) => name === previous)?.[0];
  if (!direction) return { sufficient: false, reason: "entry_not_proven" };
  const terrain = Game.map.getRoomTerrain(room.name);
  const blocked = new Set(room.find(FIND_STRUCTURES).filter(structure => !isWalkableStructure(structure)).map(structure => `${structure.pos.x}:${structure.pos.y}`));
  const tile = (coordinate: number) => Number(direction) === TOP ? { x: coordinate, y: 0 } : Number(direction) === BOTTOM ? { x: coordinate, y: 49 }
    : Number(direction) === LEFT ? { x: 0, y: coordinate } : { x: 49, y: coordinate };
  const open = (position: { x: number; y: number }) => terrain.get(position.x, position.y) !== TERRAIN_MASK_WALL && !blocked.has(`${position.x}:${position.y}`);
  let minimum = Infinity;
  for (let coordinate = 1; coordinate < 48; coordinate++) {
    const red = tile(coordinate), green = tile(coordinate + 1);
    if (!open(red) || !open(green)) continue;
    const damage = Math.max(...[red, green].map(position => towers.reduce((sum, tower) => sum + towerAttackPowerAt(tower, position), 0)));
    minimum = Math.min(minimum, damage);
  }
  return { sufficient: minimum < heal, reason: minimum < heal ? "entry_damage_below_heal" : "entry_damage_exceeds_heal" };
}
