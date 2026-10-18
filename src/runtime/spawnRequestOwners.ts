import { type CreepConfig } from "@/types/system";

export interface SpawnRequestOwner {
  readonly id: string;
  matches(name: string, config: CreepConfig): boolean;
  canExecute?(name: string, config: CreepConfig): boolean;
  accepted?(configName: string, creepName: string): void;
}
const owners = new Map<string, SpawnRequestOwner>();
export function registerSpawnRequestOwner(owner: SpawnRequestOwner): void {
  const existing = owners.get(owner.id);
  if (existing && existing !== owner) throw new Error(`duplicate spawn request owner: ${owner.id}`);
  owners.set(owner.id, owner);
}
export function canExecuteSpawnRequest(name: string, config: CreepConfig): boolean {
  for (const owner of owners.values()) if (owner.matches(name, config) && owner.canExecute?.(name, config) === false) return false;
  return true;
}
export function notifySpawnRequestAccepted(configName: string, config: CreepConfig, creepName: string): void {
  for (const owner of owners.values()) if (owner.matches(configName, config)) owner.accepted?.(configName, creepName);
}
