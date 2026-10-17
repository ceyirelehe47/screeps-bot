export type PowerCreepTaskType =
  | "enable_room"
  | "renew"
  | "deposit_ops"
  | "withdraw_ops"
  | "operate_storage"
  | "operate_factory"
  | "regen_source"
  | "operate_extension"
  | "generate_ops";

export interface PowerCreepTask {
  id: string;
  type: PowerCreepTaskType;
  priority: number;
  createdAt: number;
  targetId?: string;
}

export interface PowerCreepRoomCapability {
  roomName: string;
  powerCreepNames: string[];
  operateExtensionLevel: number;
  regenSourceLevel: number;
}

export interface PowerCreepRoomEnergyPolicy {
  suppressSpawnSupply: boolean;
  suppressExtensionSupply: boolean;
  managePowerSpawnSupply: boolean;
}
