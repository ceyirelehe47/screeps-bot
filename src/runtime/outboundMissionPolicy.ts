import { isDefenseMode } from "@/runtime/defenseMode";
import { isRoomInReserveMode } from "@/runtime/roomReserve";
import { resolveOutboundMissionIntent } from "@/runtime/outboundMissionRegistry";
import { getRoleSpawnIntent } from "@/runtime/spawnIntent";
import type { CreepConfig } from "@/types/system";

export interface RoomMissionMode { defense: boolean; reserve: boolean }
export function getRoomMissionMode(roomName: string): RoomMissionMode {
  return { defense: isDefenseMode(roomName), reserve: isRoomInReserveMode(roomName) };
}

/** 只控制新增昂贵出征，已部署单位与外矿收入继续执行。 */
export function canStartOutboundMission(roomName: string): boolean {
  const mode = getRoomMissionMode(roomName);
  return !mode.defense && !mode.reserve;
}

export type SpawnAdmission = { allowed: true } | { allowed: false; reason: "defense" | "reserve" };
export function getSpawnAdmission(configName: string, config: CreepConfig): SpawnAdmission {
  if (!config.roomName) return { allowed: true };
  const mode = getRoomMissionMode(config.roomName);
  const mission = resolveOutboundMissionIntent(configName, config, mode);
  const intent = mission?.intent ?? getRoleSpawnIntent(config.role);
  if (mode.defense && intent !== "local") return { allowed: false, reason: "defense" };
  if (mode.reserve && intent === "expedition" && !mission?.committed) return { allowed: false, reason: "reserve" };
  return { allowed: true };
}

export function isSpawnConfigEconomicallyBlocked(configName: string, config: CreepConfig): boolean {
  return !getSpawnAdmission(configName, config).allowed;
}

export function fixedBodyExceedsCapacity(config: CreepConfig, capacity: number): boolean {
  return !!config.body && (config.body.length > MAX_CREEP_SIZE ||
    config.body.reduce((sum, part) => sum + (BODYPART_COST[part] ?? Infinity), 0) > capacity);
}
