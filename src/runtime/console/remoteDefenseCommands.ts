import { jsonCommand } from "@/runtime/console/jsonCommand";
import type { CreepConfig } from "@/types/system";
import type { DamageSnapshot, RemoteDefenseReason, RemoteMiningTask } from "@/runtime/remoteMining";

type ActiveCombatPartCounts = Record<"attack" | "ranged_attack" | "heal" | "work", number>;

export interface RemoteDefenseHostileSnapshot {
  id: string;
  name: string;
  owner: string;
  roomName: string;
  x: number;
  y: number;
  hits: number;
  hitsMax: number;
  body: Array<{ type: BodyPartConstant; hits: number; boost?: string | number }>;
  activeCombatParts: ActiveCombatPartCounts;
}

export interface RemoteDefenseCreepSnapshot {
  name: string;
  id: string;
  role?: string;
  roleArgs?: string[];
  configName?: string;
  roomName: string;
  x: number;
  y: number;
  hits: number;
  hitsMax: number;
  ticksToLive?: number;
  ready?: boolean;
  working?: boolean;
}

export interface RemoteDefenseConfigSnapshot {
  configName: string;
  role: CreepConfig["role"];
  args: string[];
  roomName?: string;
}

export interface RemoteDefenseSpawnSnapshot {
  name: string;
  roomName: string;
  spawning: string | null;
  spawningConfigName?: string;
  spawnList: string[];
}

export interface RemoteDefenseDamageEvidence {
  id: string;
  previousTick: number;
  previousHits: number;
  currentHits: number;
  loss: number;
  expectedDecay?: number;
}

export interface RemoteDefenseTaskSnapshot {
  sourceRoom: string;
  targetRoom: string;
  status: RemoteMiningTask["status"];
  sourceIds: string[];
  assignedAt: number;
  updatedAt: number;
  lastVerifiedAt?: number;
  suspendReason?: string;
  lastThreatAt?: number;
  safeSince?: number;
  defendingSince?: number;
  lastDefenseThreatAt?: number;
  defenseReason?: RemoteDefenseReason;
  lastDefenseSafeAt?: number;
  roadPlanGeneratedAt?: number;
  containerPositions?: RemoteMiningTask["containerPositions"];
  damageSnapshotCounts: {
    creeps: number;
    containers: number;
  };
  newestDamageSnapshotTick: number | null;
}

export interface RemoteDefenseStatusSnapshot {
  ok: true;
  tick: number;
  targetRoom: string;
  sourceRoom: string | null;
  roomVisible: boolean;
  task: RemoteDefenseTaskSnapshot | null;
  hostiles: RemoteDefenseHostileSnapshot[];
  ownCreeps: RemoteDefenseCreepSnapshot[];
  relatedConfigs: RemoteDefenseConfigSnapshot[];
  relatedSpawnQueues: RemoteDefenseSpawnSnapshot[];
  trigger: {
    wouldTrigger: boolean;
    reason: RemoteDefenseReason | null;
    npcInvaderHostiles: number;
    npcInvaderCombatHostiles: number;
    playerHostiles: number;
    damagedCreeps: RemoteDefenseDamageEvidence[];
    damagedContainers: RemoteDefenseDamageEvidence[];
  };
  notes: string[];
}

const REMOTE_DEFENSE_COMBAT_PARTS: BodyPartConstant[] = [ATTACK, RANGED_ATTACK, HEAL, WORK];

function getRemoteMiningTask(targetRoom: string): RemoteMiningTask | null {
  const store = Memory.data?.remoteMining;
  if (!store) return null;
  const direct = store[targetRoom];
  if (direct?.targetRoom === targetRoom) return direct;
  return Object.values(store).find((task) => task.targetRoom === targetRoom) ?? null;
}

function buildTaskSnapshot(task: RemoteMiningTask | null): RemoteDefenseTaskSnapshot | null {
  if (!task) return null;
  const creepSnapshots = Object.values(task.damageSnapshots?.creeps ?? {});
  const containerSnapshots = Object.values(task.damageSnapshots?.containers ?? {});
  const newestDamageSnapshotTick = [...creepSnapshots, ...containerSnapshots].reduce<number | null>(
    (newest, snapshot) => newest === null ? snapshot.tick : Math.max(newest, snapshot.tick),
    null,
  );

  return {
    sourceRoom: task.sourceRoom,
    targetRoom: task.targetRoom,
    status: task.status,
    sourceIds: [...task.sourceIds],
    assignedAt: task.assignedAt,
    updatedAt: task.updatedAt,
    lastVerifiedAt: task.lastVerifiedAt,
    suspendReason: task.suspendReason,
    lastThreatAt: task.lastThreatAt,
    safeSince: task.safeSince,
    defendingSince: task.defendingSince,
    lastDefenseThreatAt: task.lastDefenseThreatAt,
    defenseReason: task.defenseReason,
    lastDefenseSafeAt: task.lastDefenseSafeAt,
    roadPlanGeneratedAt: task.roadPlan?.generatedAt,
    containerPositions: task.containerPositions,
    damageSnapshotCounts: {
      creeps: creepSnapshots.length,
      containers: containerSnapshots.length,
    },
    newestDamageSnapshotTick,
  };
}

function countActiveBodyparts(creep: Creep, part: BodyPartConstant): number {
  if (typeof creep.getActiveBodyparts === "function") {
    return creep.getActiveBodyparts(part);
  }

  return creep.body.filter((bodyPart) => bodyPart.type === part && bodyPart.hits > 0).length;
}

function getActiveCombatParts(creep: Creep): ActiveCombatPartCounts {
  return {
    attack: countActiveBodyparts(creep, ATTACK),
    ranged_attack: countActiveBodyparts(creep, RANGED_ATTACK),
    heal: countActiveBodyparts(creep, HEAL),
    work: countActiveBodyparts(creep, WORK),
  };
}

function hasActiveRemoteDefenseCombatPart(creep: Creep): boolean {
  return REMOTE_DEFENSE_COMBAT_PARTS.some((part) => countActiveBodyparts(creep, part) > 0);
}

function buildHostileSnapshot(creep: Creep): RemoteDefenseHostileSnapshot {
  const owner = (creep.owner as { username?: string } | undefined)?.username ?? "unknown";
  return {
    id: creep.id,
    name: creep.name,
    owner,
    roomName: creep.pos.roomName,
    x: creep.pos.x,
    y: creep.pos.y,
    hits: creep.hits,
    hitsMax: creep.hitsMax,
    body: creep.body.map((part) => ({
      type: part.type,
      hits: part.hits,
      boost: part.boost,
    })),
    activeCombatParts: getActiveCombatParts(creep),
  };
}

function getTaskPrefix(task: RemoteMiningTask): string {
  return `${task.sourceRoom}:remoteMine:${task.targetRoom}:`;
}

function isTaskCreep(creep: Creep, task: RemoteMiningTask): boolean {
  return creep.memory.configName?.startsWith(getTaskPrefix(task)) === true;
}

function buildOwnCreepSnapshot(creep: Creep): RemoteDefenseCreepSnapshot {
  return {
    name: creep.name,
    id: creep.id,
    role: creep.memory.role,
    roleArgs: creep.memory.roleArgs,
    configName: creep.memory.configName,
    roomName: creep.pos.roomName,
    x: creep.pos.x,
    y: creep.pos.y,
    hits: creep.hits,
    hitsMax: creep.hitsMax,
    ticksToLive: creep.ticksToLive,
    ready: creep.memory.ready,
    working: creep.memory.working,
  };
}

function buildRelatedConfigs(targetRoom: string, task: RemoteMiningTask | null): RemoteDefenseConfigSnapshot[] {
  const configs = Memory.data?.creepConfigs ?? {};
  const prefix = task ? getTaskPrefix(task) : null;
  const entries = Object.entries(configs).filter(([configName, config]) => {
    if (prefix && configName.startsWith(prefix)) return true;
    return config.args.includes(targetRoom);
  });

  return entries.map(([configName, config]) => ({
    configName,
    role: config.role,
    args: [...config.args],
    roomName: config.roomName,
  }));
}

function buildRelatedSpawnQueues(targetRoom: string, task: RemoteMiningTask | null): RemoteDefenseSpawnSnapshot[] {
  const prefix = task ? getTaskPrefix(task) : null;
  const creepMemory = Memory.creeps ?? {};
  const spawns = Object.values(Game.spawns).map((spawn) => {
    const spawningName = spawn.spawning?.name ?? null;
    return {
      name: spawn.name,
      roomName: spawn.room.name,
      spawning: spawningName,
      spawningConfigName: spawningName ? creepMemory[spawningName]?.configName : undefined,
      spawnList: [...(spawn.memory.spawnList ?? [])],
    };
  });

  return spawns.filter((spawn) => {
    if (task && spawn.roomName === task.sourceRoom) return true;
    if (spawn.spawningConfigName) {
      if (prefix && spawn.spawningConfigName.startsWith(prefix)) return true;
      if (spawn.spawningConfigName.includes(targetRoom)) return true;
    }
    return spawn.spawnList.some((configName) =>
      (prefix ? configName.startsWith(prefix) : false) || configName.includes(targetRoom),
    );
  });
}

function getOwnRemoteCreeps(task: RemoteMiningTask | null): Creep[] {
  if (!task) return [];
  return Object.values(Game.creeps).filter((creep) => isTaskCreep(creep, task));
}

function getContainersNearSources(task: RemoteMiningTask, room: Room): StructureContainer[] {
  const containers: StructureContainer[] = [];
  for (const sourceId of task.sourceIds) {
    const source = Game.getObjectById?.(sourceId as Id<Source>) ?? null;
    if (!source) continue;

    const nearby = room.find(FIND_STRUCTURES).filter(
      (structure): structure is StructureContainer =>
        structure.structureType === STRUCTURE_CONTAINER &&
        Math.abs(structure.pos.x - source.pos.x) <= 2 &&
        Math.abs(structure.pos.y - source.pos.y) <= 2,
    );
    containers.push(...nearby);
  }

  return containers;
}

function getRecentSnapshot(snapshot: DamageSnapshot | undefined): DamageSnapshot | null {
  if (!snapshot) return null;
  if (Game.time - snapshot.tick >= 150) return null;
  return snapshot;
}

function collectDamagedCreeps(task: RemoteMiningTask | null, ownCreeps: Creep[]): RemoteDefenseDamageEvidence[] {
  if (!task?.damageSnapshots) return [];
  return ownCreeps.flatMap((creep) => {
    const snapshot = getRecentSnapshot(task.damageSnapshots?.creeps[creep.id]);
    if (!snapshot || creep.hits >= snapshot.hits) return [];
    return [{
      id: creep.id,
      previousTick: snapshot.tick,
      previousHits: snapshot.hits,
      currentHits: creep.hits,
      loss: snapshot.hits - creep.hits,
    }];
  });
}

function collectDamagedContainers(task: RemoteMiningTask | null, room: Room | undefined): RemoteDefenseDamageEvidence[] {
  if (!task?.damageSnapshots || !room) return [];
  const isOwnedRoom = room.controller?.my === true;
  const decayInterval = isOwnedRoom ? CONTAINER_DECAY_TIME_OWNED : CONTAINER_DECAY_TIME;
  return getContainersNearSources(task, room).flatMap((container) => {
    const snapshot = getRecentSnapshot(task.damageSnapshots?.containers[container.id]);
    if (!snapshot || container.hits >= snapshot.hits) return [];
    const ticksSinceSnapshot = Game.time - snapshot.tick;
    const expectedDecay = Math.floor(ticksSinceSnapshot / decayInterval) * CONTAINER_DECAY;
    const loss = snapshot.hits - container.hits;
    if (loss <= expectedDecay) return [];
    return [{
      id: container.id,
      previousTick: snapshot.tick,
      previousHits: snapshot.hits,
      currentHits: container.hits,
      loss,
      expectedDecay,
    }];
  });
}

function buildNotes(
  task: RemoteMiningTask | null,
  roomVisible: boolean,
  hostiles: Creep[],
  reason: RemoteDefenseReason | null,
): string[] {
  const notes: string[] = [];
  if (!task) {
    notes.push("no_remote_mining_task");
  } else if (task.status !== "defending" && reason) {
    notes.push("trigger_condition_present_next_remoteMining_run_should_enter_defending");
  } else if (task.status === "active" && !reason) {
    notes.push("active_remote_no_current_trigger_condition");
  }

  if (!roomVisible) {
    notes.push("target_room_not_visible_no_live_hostile_scan");
  } else if (hostiles.length === 0) {
    notes.push("visible_target_has_no_hostile_creeps");
  }

  return notes;
}

export function remoteDefenseStatusRaw(targetRoom: string): RemoteDefenseStatusSnapshot | string {
  if (!targetRoom) return "targetRoom is required";

  const task = getRemoteMiningTask(targetRoom);
  const room = Game.rooms[targetRoom];
  const roomVisible = !!room;
  const hostiles = room ? room.find(FIND_HOSTILE_CREEPS) : [];
  const ownCreeps = getOwnRemoteCreeps(task);
  const npcInvaderHostiles = hostiles.filter((creep) => {
    const username = (creep.owner as { username?: string } | undefined)?.username;
    return username === "Invader";
  }).length;
  const npcInvaderCombatHostiles = hostiles.filter((creep) => {
    const username = (creep.owner as { username?: string } | undefined)?.username;
    return username === "Invader" && hasActiveRemoteDefenseCombatPart(creep);
  }).length;
  const playerHostiles = hostiles.filter((creep) => {
    const username = (creep.owner as { username?: string } | undefined)?.username;
    return username !== undefined && username !== "Invader";
  }).length;
  const damagedCreeps = collectDamagedCreeps(task, ownCreeps);
  const damagedContainers = collectDamagedContainers(task, room);
  const reason: RemoteDefenseReason | null = npcInvaderHostiles > 0
    ? "npc_invader"
    : (playerHostiles > 0 && (damagedCreeps.length > 0 || damagedContainers.length > 0) ? "player_aggression" : null);

  return {
    ok: true,
    tick: Game.time,
    targetRoom,
    sourceRoom: task?.sourceRoom ?? null,
    roomVisible,
    task: buildTaskSnapshot(task),
    hostiles: hostiles.map(buildHostileSnapshot),
    ownCreeps: ownCreeps.map(buildOwnCreepSnapshot),
    relatedConfigs: buildRelatedConfigs(targetRoom, task),
    relatedSpawnQueues: buildRelatedSpawnQueues(targetRoom, task),
    trigger: {
      wouldTrigger: reason !== null,
      reason,
      npcInvaderHostiles,
      npcInvaderCombatHostiles,
      playerHostiles,
      damagedCreeps,
      damagedContainers,
    },
    notes: buildNotes(task, roomVisible, hostiles, reason),
  };
}

export const remoteDefenseStatusCommand = jsonCommand((targetRoom: string) => remoteDefenseStatusRaw(targetRoom), 2);

export function registerRemoteDefenseConsoleCommands(): void {
  global.remoteDefenseStatus = remoteDefenseStatusCommand;
  global.remoteDefenseStatusRaw = remoteDefenseStatusRaw;
}
