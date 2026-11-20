import type { CreepConfig } from "@/types/system";
import type { SpawnIntent } from "@/runtime/spawnIntent";
import type { RoomMissionMode } from "@/runtime/outboundMissionPolicy";

export interface OutboundRequest {
  intent: SpawnIntent;
  committed: boolean;
  family?: "remoteMining" | "deposit" | "powerBank" | "colonizationSupport" | "war";
  taskId?: string;
  blockedReason?: "mission_paused";
}

export interface OutboundMissionOwner {
  id: string;
  occupiesSource?(roomName: string, exceptTaskId?: string): boolean;
  matches(name: string, config: CreepConfig): boolean;
  evaluate(name: string, config: CreepConfig, mode: RoomMissionMode): OutboundRequest;
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

/** 共享调度器询问各任务 owner 的实际投入，存档读取和世代解释由 owner 负责。 */
export function outboundSourceOccupied(family: NonNullable<OutboundRequest["family"]>, roomName: string, exceptTaskId?: string): boolean {
  return owners.get(family)?.occupiesSource?.(roomName, exceptTaskId) ?? false;
}
