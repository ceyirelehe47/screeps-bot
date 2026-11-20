import { isDefenseMode } from "@/runtime/defenseMode";
import { isRoomInReserveMode } from "@/runtime/roomReserve";
import { outboundSourceOccupied, resolveOutboundMissionIntent, type OutboundRequest } from "@/runtime/outboundMissionRegistry";
import { getRoleSpawnIntent } from "@/runtime/spawnIntent";
import type { CreepConfig } from "@/types/system";

export interface RoomMissionMode { defense: boolean; reserve: boolean; sourceRoom?: string }
export function getRoomMissionMode(roomName: string): RoomMissionMode {
  return { defense: isDefenseMode(roomName), reserve: isRoomInReserveMode(roomName), sourceRoom: roomName };
}

export type OutboundBlocker = "defense" | "reserve" | "source_busy" | "mission_paused";
export type SpawnAdmission = { allowed: true } | { allowed: false; reason: OutboundBlocker };

export function evaluateOutboundAdmission(mode: RoomMissionMode, request: OutboundRequest): SpawnAdmission {
  if (mode.defense && request.intent !== "local") return { allowed: false, reason: "defense" };
  if (mode.reserve && request.intent === "expedition" && !request.committed) return { allowed: false, reason: "reserve" };
  if (request.blockedReason) return { allowed: false, reason: request.blockedReason };
  if (request.family === "deposit" && mode.sourceRoom &&
      (outboundSourceOccupied("powerBank", mode.sourceRoom) || outboundSourceOccupied("deposit", mode.sourceRoom, request.taskId))) {
    return { allowed: false, reason: "source_busy" };
  }
  return { allowed: true };
}

/** 旧调用方默认申请一次新远征；收入任务显式使用 income，已投入任务在出生处提交 owner 证据。 */
export function canStartOutboundMission(roomName: string, intent: OutboundRequest["intent"] = "expedition",
  family?: OutboundRequest["family"]): boolean {
  return evaluateOutboundAdmission(getRoomMissionMode(roomName), { intent, family, committed: false }).allowed;
}

export function getSpawnAdmission(configName: string, config: CreepConfig, actualSpawnRoom?: string): SpawnAdmission {
  const roomName = config.roomName ?? actualSpawnRoom;
  if (!roomName) return { allowed: true };
  const mode = getRoomMissionMode(roomName);
  const request = resolveOutboundMissionIntent(configName, config, mode) ??
    { intent: getRoleSpawnIntent(config.role), committed: false };
  if (request.family && actualSpawnRoom && config.roomName && config.roomName !== actualSpawnRoom) return { allowed: false, reason: "mission_paused" };
  return evaluateOutboundAdmission(mode, request);
}

export function isSpawnConfigEconomicallyBlocked(configName: string, config: CreepConfig): boolean {
  return !getSpawnAdmission(configName, config).allowed;
}

export function fixedBodyExceedsCapacity(config: CreepConfig, capacity: number): boolean {
  return !!config.body && (config.body.length > MAX_CREEP_SIZE ||
    config.body.reduce((sum, part) => sum + (BODYPART_COST[part] ?? Infinity), 0) > capacity);
}
