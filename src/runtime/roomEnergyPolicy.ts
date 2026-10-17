import { normalizeNumber } from "@/runtime/configNormalize";

export interface RoomEnergyPolicy {
  energyFloor: number;
  energyTarget: number;
  energyExportStart: number;
  terminalEnergyReserve: number;
}

const DEFAULT_ROOM_ENERGY_POLICY: RoomEnergyPolicy = {
  energyFloor: 120_000,
  energyTarget: 200_000,
  energyExportStart: 250_000,
  terminalEnergyReserve: 25_000,
};

export function resolveRoomEnergyPolicy(value: unknown): RoomEnergyPolicy {
  const raw = value && typeof value === "object"
    ? (value as Partial<RoomEnergyPolicy>)
    : {};
  const energyFloor = normalizeNumber(
    raw.energyFloor,
    DEFAULT_ROOM_ENERGY_POLICY.energyFloor,
    0,
    3_000_000,
  );
  const energyTarget = Math.max(
    energyFloor,
    normalizeNumber(
      raw.energyTarget,
      DEFAULT_ROOM_ENERGY_POLICY.energyTarget,
      0,
      3_000_000,
    ),
  );
  const energyExportStart = Math.max(
    energyTarget,
    normalizeNumber(
      raw.energyExportStart,
      DEFAULT_ROOM_ENERGY_POLICY.energyExportStart,
      0,
      3_000_000,
    ),
  );

  return {
    energyFloor,
    energyTarget,
    energyExportStart,
    terminalEnergyReserve: normalizeNumber(
      raw.terminalEnergyReserve,
      DEFAULT_ROOM_ENERGY_POLICY.terminalEnergyReserve,
      0,
      300_000,
    ),
  };
}

/** 房间所有能源消费者共享 HUB 覆盖值，避免工厂恢复与可选消耗互相拉扯。 */
export function resolveRoomEnergyPolicyForRoom(roomName: string): RoomEnergyPolicy {
  const base = resolveRoomEnergyPolicy(Memory.cfg?.resourceControl?.rooms?.[roomName]);
  const hub = Memory.cfg?.hub;
  const cfg = Memory.cfg?.factoryControl?.hub;
  if (hub?.enabled === true && hub.hubRoomName === roomName && Memory.cfg?.factoryControl?.enabled === true && cfg?.enabled !== false) {
    const floor = Math.max(base.energyFloor, normalizeNumber(cfg?.energyFloor, base.energyFloor, 0, 3_000_000));
    const target = Math.max(floor, base.energyTarget, normalizeNumber(cfg?.energyTarget, base.energyTarget, 0, 3_000_000));
    return { ...base, energyFloor: floor, energyTarget: target,
      energyExportStart: Math.max(base.energyExportStart, target, cfg?.energyCompressionStart === undefined ? 0 : normalizeNumber(cfg.energyCompressionStart, base.energyExportStart - 600, 0, 3_000_000) + 600) };
  }
  return base;
}
