import { normalizeNumber } from "@/runtime/configNormalize";
import {
  resolveRoomEnergyPolicy,
  type RoomEnergyPolicy,
} from "@/runtime/roomEnergyPolicy";

export type ResourceThresholdMap = Partial<Record<ResourceConstant, number>>;

export const RESOURCE_CONTROL_BASE_MINERALS: ResourceConstant[] = [
  RESOURCE_HYDROGEN,
  RESOURCE_OXYGEN,
  RESOURCE_UTRIUM,
  RESOURCE_LEMERGIUM,
  RESOURCE_KEANIUM,
  RESOURCE_ZYNTHIUM,
  RESOURCE_CATALYST,
];

export interface ResourceControlRoomConfig extends RoomEnergyPolicy {
  transferBatchSize: number;
  mineralFloor: ResourceThresholdMap;
  mineralExportStart: ResourceThresholdMap;
}

export const DEFAULT_RESOURCE_CONTROL_ROOM_CONFIG: Omit<
  ResourceControlRoomConfig,
  keyof RoomEnergyPolicy
> = {
  transferBatchSize: 10_000,
  mineralFloor: {
    [RESOURCE_HYDROGEN]: 5_000,
    [RESOURCE_OXYGEN]: 5_000,
    [RESOURCE_UTRIUM]: 5_000,
    [RESOURCE_LEMERGIUM]: 5_000,
    [RESOURCE_KEANIUM]: 5_000,
    [RESOURCE_ZYNTHIUM]: 5_000,
    [RESOURCE_CATALYST]: 3_000,
  },
  mineralExportStart: {
    [RESOURCE_HYDROGEN]: 15_000,
    [RESOURCE_OXYGEN]: 15_000,
    [RESOURCE_UTRIUM]: 15_000,
    [RESOURCE_LEMERGIUM]: 15_000,
    [RESOURCE_KEANIUM]: 15_000,
    [RESOURCE_ZYNTHIUM]: 15_000,
    [RESOURCE_CATALYST]: 10_000,
  },
};

export function normalizeResourceThresholdMap(
  value: unknown,
  fallback: ResourceThresholdMap,
  min: number,
  max: number,
): ResourceThresholdMap {
  const map =
    value && typeof value === "object"
      ? (value as Partial<Record<ResourceConstant, unknown>>)
      : {};
  const next: ResourceThresholdMap = {};
  for (const resource of Object.keys(fallback) as ResourceConstant[]) {
    next[resource] = normalizeNumber(
      map[resource], fallback[resource] || 0, min, max,
    );
  }
  for (const resource of RESOURCE_CONTROL_BASE_MINERALS) {
    if (next[resource] === undefined) {
      next[resource] = normalizeNumber(
        map[resource], fallback[resource] || 0, min, max,
      );
    }
  }
  return next;
}

function normalizeRoomConfig(value: unknown): ResourceControlRoomConfig {
  const config =
    value && typeof value === "object"
      ? (value as Partial<ResourceControlRoomConfig>)
      : {};
  const energyPolicy = resolveRoomEnergyPolicy(config);
  const transferBatchSize = normalizeNumber(
    config.transferBatchSize,
    DEFAULT_RESOURCE_CONTROL_ROOM_CONFIG.transferBatchSize,
    100,
    50_000,
  );
  const mineralFloor = normalizeResourceThresholdMap(
    config.mineralFloor,
    DEFAULT_RESOURCE_CONTROL_ROOM_CONFIG.mineralFloor,
    0,
    500_000,
  );
  const mineralExportStart = normalizeResourceThresholdMap(
    config.mineralExportStart,
    DEFAULT_RESOURCE_CONTROL_ROOM_CONFIG.mineralExportStart,
    0,
    1_000_000,
  );
  for (const resource of RESOURCE_CONTROL_BASE_MINERALS) {
    const floor = mineralFloor[resource] || 0;
    const exportStart = mineralExportStart[resource] || 0;
    if (exportStart < floor) mineralExportStart[resource] = floor;
  }
  return {
    ...energyPolicy,
    transferBatchSize,
    mineralFloor,
    mineralExportStart,
  };
}

export function resolveRoomConfig(roomName: string): ResourceControlRoomConfig {
  const cfg = Memory.cfg?.resourceControl;
  const roomConfigRaw = cfg?.rooms ? cfg.rooms[roomName] : undefined;
  return normalizeRoomConfig(roomConfigRaw);
}
