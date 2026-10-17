import type { CreepConfig } from "@/types/system";
import type { SpawnIntent } from "@/runtime/spawnIntent";
import type { RoomMissionMode } from "@/runtime/outboundMissionPolicy";

export interface OutboundMissionOwner {
  id: string;
  matches(name: string, config: CreepConfig): boolean;
  evaluate(name: string, config: CreepConfig, mode: RoomMissionMode): { intent: SpawnIntent; committed: boolean };
}
const owners = new Map<string, OutboundMissionOwner>();

/** 组合根负责登记，底层策略不导入任何任务所有者。重复登记相同 owner 幂等。 */
export function registerOutboundMissionOwner(owner: OutboundMissionOwner): void {
  const existing = owners.get(owner.id);
  if (existing && existing !== owner) throw new Error(`duplicate outbound owner: ${owner.id}`);
  owners.set(owner.id, owner);
}

export function resolveOutboundMissionIntent(name: string, config: CreepConfig, mode: RoomMissionMode) {
  for (const owner of owners.values()) if (owner.matches(name, config)) return owner.evaluate(name, config, mode);
  return undefined;
}
