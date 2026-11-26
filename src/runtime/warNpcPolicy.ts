import { getRefillableHostileTowers, minimumEntryTowerDamage } from "@/runtime/combatTowerThreat";
import { effectivePower } from "@/runtime/powerBankCapability";

const NPC_USERS = new Set(["Invader", "TooAngel"]);

export function classifyNpcWarTarget(room: Room): "empty" | "npc" | "other" {
  const owners = [room.controller?.owner?.username, room.controller?.reservation?.username,
    ...room.find(FIND_HOSTILE_CREEPS).map(actor => actor.owner.username),
    ...room.find(FIND_HOSTILE_STRUCTURES).map(structure => "owner" in structure ? (structure as OwnedStructure).owner?.username : undefined)].filter((name): name is string => !!name);
  if (!owners.length) return "empty";
  return owners.every(name => NPC_USERS.has(name)) ? "npc" : "other";
}

export function isNpcWarTarget(room: Room): boolean {
  return classifyNpcWarTarget(room) === "npc";
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
  const minimum = minimumEntryTowerDamage(room, Number(direction), towers);
  return { sufficient: minimum < heal, reason: minimum < heal ? "entry_damage_below_heal" : "entry_damage_exceeds_heal" };
}
