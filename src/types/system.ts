import { type RoleName } from "@/types/roleCatalog";

export type { RoleName } from "@/types/roleCatalog";
export type WorkerTaskType = "build" | "upgrade" | "repair" | "dismantle";
export type RoomType = "normal" | "reserved" | "industrial";

export interface CreepConfig {
  readonly role: RoleName;
  readonly args: readonly string[];
  readonly roomName?: string;
  readonly body?: readonly BodyPartConstant[];
  readonly name?: string;
  /** Stable owner for PowerBank configs; absent on legacy configs. */
  readonly taskId?: string;
  /** Combat-pair generation for PowerBank attacker/healer configs. */
  readonly powerBankGeneration?: number;
  readonly spawnOnce?: {
    readonly queuedAt?: number;
  };
}

export type CreepStepResult =
  | { readonly kind: "transition" }
  | { readonly kind: "continue"; readonly sticky?: { readonly until: number; readonly run: (creep: Creep) => boolean } }
  | { readonly kind: "sleep"; readonly until: number; readonly wake?: (creep: Creep) => boolean };

export interface RoleLifecycle {
  step?: (creep: Creep, stage: "source" | "target") => CreepStepResult;
  prepare?: (creep: Creep) => boolean;
  source?: (creep: Creep) => boolean;
  target: (creep: Creep) => boolean;
}

export interface WorkerTask {
  id: string;
  type: WorkerTaskType;
  targetId: string;
  roomName: string;
  priority: number;
  requiredWork?: number;
  repairTargetHits?: number;
  repairMode?: "emergency" | "normal";
  assignedCreeps: string[];
  maxAssignees: number;
  status: "active" | "done";
  updatedAt: number;
}

export type RoleFactory = (...args: string[]) => RoleLifecycle;

export interface CreepApi {
  add(configName: string, role: RoleName, ...args: string[]): string;
  remove(configName: string): string;
  get(configName: string): CreepConfig | undefined;
  list(prefix?: string): Readonly<Record<string, CreepConfig>>;
}
