import { standard } from "./standard";
import { t3Duo } from "./t3Duo";
import { towerDrainDuo } from "./towerDrainDuo";
import type { SquadPolicy } from "./types";
export function getSquadPolicy(task: WarTask): SquadPolicy {
  return task.squad === "towerDrainDuo" ? towerDrainDuo : task.squad === "t3Duo" || task.boostTier === "t3" ? t3Duo : standard;
}
import { DUO_HEALER_COUNT, DUO_MELEE_COUNT, HEALER_COUNT, MELEE_COUNT, T3_ATTACKER_BODY, T3_ATTACKER_BOOSTS, T3_HEALER_BODY, T3_HEALER_BOOSTS, TOWER_DRAIN_ATTACKER_BODY, TOWER_DRAIN_HEALER_BODY } from "../constants";
import type { WarRole, WarTask } from "../store";

export function isT3DuoTask(task: WarTask): boolean {
  return getSquadPolicy(task).needsBoost;
}

export function isTowerDrainDuoTask(task: WarTask): boolean {
  return getSquadPolicy(task).parallel;
}

export function isDuoTask(task: WarTask): boolean {
  return getSquadPolicy(task).duo;
}

export function getMeleeCount(task: WarTask): number {
  return getSquadPolicy(task).meleeCount;
}

export function getHealerCount(task: WarTask): number {
  return getSquadPolicy(task).healerCount;
}

export function encodeBoosts(compounds: ResourceConstant[]): string {
  return compounds.join("|");
}

export function getRoleArgs(
  task: WarTask,
  role: WarRole,
  encodedRoute: string,
  boostTaskId = `war:${task.sourceRoom}:${task.targetRoom}`,
  partnerConfigName = "",
): string[] {
  if (isTowerDrainDuoTask(task)) {
    return [task.targetRoom, encodedRoute, "", "", partnerConfigName, "towerDrainDuo"];
  }
  if (!isT3DuoTask(task)) {
    return [task.targetRoom, encodedRoute, "", "", partnerConfigName];
  }

  return [
    task.targetRoom,
    encodedRoute,
    boostTaskId,
    encodeBoosts(role === "meleeAttacker" ? T3_ATTACKER_BOOSTS : T3_HEALER_BOOSTS),
    partnerConfigName,
    ...(task.tactic === "t3TowerDrainDuo" ? [task.tactic] : []),
  ];
}

export function getRoleBody(task: WarTask, role: WarRole): BodyPartConstant[] | undefined {
  const body = getSquadPolicy(task).bodies[role];
  return body ? [...body] : undefined;
}
