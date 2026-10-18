import { createTaskLifecycle } from "@/runtime/taskLifecycle";
import { replaceSpawnQueue } from "@/runtime/spawnRequests";
import { canStartOutboundMission } from "@/runtime/outboundMissionPolicy";
import { spawnProfiles } from "@/config/spawnProfiles";
import { isDefenseMode } from "@/runtime/defenseMode";
import { ensureDepositDiscoveryStore, cleanupDepositDiscoveryTasks } from "@/runtime/depositDiscovery";
import { isDepositRoomSafe, measureDepositTravel } from "@/runtime/depositPathDistance";
import { requestDepositObservation } from "@/runtime/powerBankObserver";
import { getCreepConfigService, getTickContextService } from "@/runtime/runtimeServices";
import { assessDepositViability, DEPOSIT_BODY } from "@/runtime/depositViability";
import { type CreepConfig } from "@/types/system";

export type DepositHarvestStatus = "discovered" | "spawning" | "outbound" | "harvesting" |
  "returning" | "unloading" | "complete" | "aborted" | "failed";
export interface DepositHarvestConfig {
  enabled: boolean;
  maxActiveTasks: number;
  maxActivePerSource: number;
  minExpectedAmount: number;
  minUnitsPerEnergy: number;
  maxCooldown: number;
}
export interface DepositHarvestTask {
  id: string; depositId: string; status: DepositHarvestStatus; generation: number;
  targetRoom: string; depositPos: { x: number; y: number }; resourceType: ResourceConstant;
  sourceRoom: string; discoveredAt: number; lastSeenAt: number; expiresAt: number;
  cooldown: number; lastCooldown: number; harvestedAmount: number; deliveredAmount: number;
  configName?: string; creepName?: string; spawnStartedAt?: number; bornAt?: number;
  /** 只有当 tick 完整复核才能由 Spawn 执行；排队本身不是出生证据。 */
  spawnReadyAt?: number;
  routeRooms?: string[]; returnTargetId?: string; outboundTravelTicks?: number; returnTravelTicks?: number;
  expectedAmount?: number; expectedHarvestTicks?: number; unitsPerEnergy?: number;
  blocker?: string; nextAttemptAt?: number; stopReason?: string; terminalAt?: number;
}
export interface DepositHarvesterMemory {
  taskId?: string;
  depositHomeRoom?: string;
  depositResourceType?: ResourceConstant;
  depositReturning?: boolean;
  depositDeliveryTargetId?: string;
  depositIntentTick?: number;
  depositHarvestBefore?: { tick: number; amount: number };
  depositPendingTransfer?: { tick: number; before: number; amount: number; resource: ResourceConstant; targetId: string };
}
export const DEPOSIT_DEFAULT_CONFIG: Readonly<DepositHarvestConfig> = Object.freeze({
  enabled: true, maxActiveTasks: 2, maxActivePerSource: 1,
  minExpectedAmount: 200, minUnitsPerEnergy: 0.08, maxCooldown: 80,
});
export function getDepositHarvestConfig(): DepositHarvestConfig {
  const raw = Memory.cfg?.depositHarvest ?? {};
  const integer = (v: unknown, fallback: number, max: number): number =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= max ? v : fallback;
  return {
    enabled: raw.enabled === undefined ? DEPOSIT_DEFAULT_CONFIG.enabled : raw.enabled === true,
    maxActiveTasks: integer(raw.maxActiveTasks, 2, 2), maxActivePerSource: 1,
    minExpectedAmount: integer(raw.minExpectedAmount, 200, 500),
    minUnitsPerEnergy: typeof raw.minUnitsPerEnergy === "number" && Number.isFinite(raw.minUnitsPerEnergy) &&
      raw.minUnitsPerEnergy >= 0.08 ? raw.minUnitsPerEnergy : 0.08,
    maxCooldown: integer(raw.maxCooldown, 80, 80),
  };
}
export function isDepositTerminal(task: DepositHarvestTask): boolean {
  return task.status === "complete" || task.status === "aborted" || task.status === "failed";
}
export function getDepositAvoidRooms(): string[] {
  return [...new Set([
    ...Object.keys(Memory.runtime?.powerBankPermanentDangerRooms ?? {}),
    ...Object.entries(Memory.runtime?.transitDangerRooms ?? {}).filter(([, t]) => t > Game.time).map(([r]) => r),
  ])];
}
export function findDepositSafeRoute(fromRoom: string, toRoom: string): string[] | undefined {
  try {
    const avoid = getDepositAvoidRooms();
    if (!isDepositRoomSafe(fromRoom, avoid) || !isDepositRoomSafe(toRoom, avoid)) return undefined;
    if (fromRoom === toRoom) return [fromRoom];
    const route = Game.map.findRoute(fromRoom, toRoom, {
      routeCallback: (r) => isDepositRoomSafe(r, avoid) ? 1 : Infinity,
    });
    if (!Array.isArray(route) || route.length > 15) return undefined;
    const rooms = [fromRoom, ...route.map((r) => r.room)];
    return rooms[rooms.length - 1] === toRoom && new Set(rooms).size === rooms.length ? rooms : undefined;
  } catch { return undefined; }
}
function configOwned(task: DepositHarvestTask, config: CreepConfig | undefined): boolean {
  return config?.role === "depositHarvester" && config.taskId === task.id &&
    config.roomName === task.sourceRoom && config.args.length === 2 && config.args[0] === task.id &&
    config.args[1] === task.sourceRoom;
}
function bodyMatches(config: CreepConfig): boolean {
  return Array.isArray(config.body) && config.body.length === DEPOSIT_BODY.length &&
    config.body.every((part, index) => part === DEPOSIT_BODY[index]);
}
export function canSpawnDepositConfig(configName: string, config: CreepConfig): boolean {
  const task = config.taskId ? Memory.data?.depositHarvest?.[config.taskId] : undefined;
  return Boolean(task && task.status === "spawning" && task.spawnStartedAt === undefined &&
    Number.isSafeInteger(task.generation) && task.generation >= 0 && task.configName === configName &&
    configName === `${task.sourceRoom}:deposit:${task.id}:g${task.generation}` && task.spawnReadyAt === Game.time &&
    config.spawnOnce && configOwned(task, config) && bodyMatches(config));
}
/** 只删除本代 owner 的配置/排队；活货由 memory 角色继续返仓。 */
export function cleanupDepositSpawnOwner(task: DepositHarvestTask): void {
  if (!task.configName) return;
  const service = getCreepConfigService();
  const cfg = service.get(task.configName);
  if (cfg && !configOwned(task, cfg)) return;
  for (const spawn of Object.values(Game.spawns)) {
    replaceSpawnQueue(spawn, (spawn.memory.spawnList ?? []).filter((name) => name !== task.configName));
  }
  if (cfg) service.remove(task.configName);
}
export function finishDepositTask(task: DepositHarvestTask, status: "complete" | "aborted" | "failed", reason?: string): void {
  setDepositTaskStatus(task, status); task.terminalAt ??= Game.time; task.stopReason = reason;
  delete task.blocker; delete task.nextAttemptAt;
  cleanupDepositSpawnOwner(task);
}
function block(task: DepositHarvestTask, reason: string, retry = 5): void {
  task.blocker = reason; task.nextAttemptAt = Game.time + retry;
}
function hasPowerBankPriority(roomName: string): boolean {
  return Object.values(Memory.data?.powerBankHarvest ?? {}).some((task) => task.sourceRoom === roomName &&
    !["complete", "failed", "aborted"].includes(task.status));
}
function spawnsIn(roomName: string): StructureSpawn[] {
  return Object.values(Game.spawns).filter((s) => s.room.name === roomName &&
    (typeof s.isActive !== "function" || s.isActive()));
}
function queueDelay(spawn: StructureSpawn, ownConfigName?: string): number {
  const service = getCreepConfigService();
  return (spawn.spawning?.remainingTime ?? 0) + (spawn.memory.spawnList ?? []).reduce((sum, name) => {
    if (name === ownConfigName) return sum;
    const config = service.get(name);
    const body = config?.body ?? (config && spawnProfiles[config.role]?.(spawn.room));
    return sum + (body?.length ?? 50) * 3;
  }, 0);
}
function receiver(room: Room): StructureStorage | StructureTerminal | undefined {
  return [room.storage, room.terminal].find((s): s is StructureStorage | StructureTerminal =>
    Boolean(s && s.store.getFreeCapacity() >= 500));
}
function taskCreep(task: DepositHarvestTask): Creep | undefined {
  if (!task.configName) return undefined;
  return getTickContextService().getAllCreeps().find((creep) => {
    const mem = creep.memory as CreepMemory & DepositHarvesterMemory;
    return (mem.taskId === undefined || mem.taskId === task.id) && creep.memory.configName === task.configName;
  });
}
function bind(task: DepositHarvestTask, creep: Creep): void {
  const mem = creep.memory as CreepMemory & DepositHarvesterMemory;
  mem.taskId = task.id; mem.depositHomeRoom = task.sourceRoom; mem.depositResourceType = task.resourceType;
  creep.memory.role = "depositHarvester"; creep.memory.roleArgs = [task.id, task.sourceRoom];
  task.creepName = creep.name;
  if (creep.spawning) task.spawnStartedAt ??= Game.time;
  else { task.bornAt ??= Game.time; task.spawnStartedAt ??= Game.time; if (task.status === "spawning") setDepositTaskStatus(task, "outbound"); }
}
function actualSpawning(task: DepositHarvestTask): string | undefined {
  return Object.values(Game.spawns).find((spawn) => spawn.spawning &&
    Memory.creeps?.[spawn.spawning.name]?.configName === task.configName)?.spawning?.name;
}
function validateWaitingSpawn(task: DepositHarvestTask, config: DepositHarvestConfig): void {
  delete task.spawnReadyAt;
  const room = Game.rooms[task.sourceRoom];
  const spawns = spawnsIn(task.sourceRoom);
  if (!room || spawns.length === 0 || hasPowerBankPriority(task.sourceRoom) || isDefenseMode(task.sourceRoom)) {
    finishDepositTask(task, "aborted", "power_bank_defense_or_spawn_unavailable"); return;
  }
  requestDepositObservation(task.targetRoom);
  if (!Game.rooms[task.targetRoom]) { block(task, "target_not_visible"); return; }
  const deposit = Game.getObjectById<Deposit>(task.depositId as Id<Deposit>);
  if (!deposit || deposit.depositType !== task.resourceType || deposit.pos.roomName !== task.targetRoom ||
    deposit.pos.x !== task.depositPos.x || deposit.pos.y !== task.depositPos.y) {
    finishDepositTask(task, "aborted", "deposit_missing_or_changed"); return;
  }
  const route = findDepositSafeRoute(task.sourceRoom, task.targetRoom); const destination = receiver(room);
  const cost = DEPOSIT_BODY.reduce((sum, p) => sum + BODYPART_COST[p], 0);
  if (!route || !destination || room.energyAvailable < cost) { block(task, "spawn_path_capacity_or_energy_pending"); return; }
  const measured = spawns.map((spawn) => measureDepositTravel({ origin: spawn.pos, target: deposit.pos,
    returnTarget: destination.pos, body: DEPOSIT_BODY, loadedAmount: 500, routeRooms: route, avoidRooms: getDepositAvoidRooms() }));
  const waiting = measured.find((r) => r.status === "pending");
  if (waiting?.status === "pending") { block(task, `path_${waiting.reason}`, 1); return; }
  const ready = measured.filter((r): r is Extract<typeof r, { status: "ready" }> => r.status === "ready");
  const outboundTravelTicks = Math.max(...ready.map((r) => r.outboundTravelTicks));
  const returnTravelTicks = Math.max(...ready.map((r) => r.returnTravelTicks));
  task.expiresAt = Math.min(task.expiresAt, Game.time + deposit.ticksToDecay);
  const economics = assessDepositViability({ currentTick: Game.time, expiresAt: task.expiresAt,
    queueDelay: Math.max(...spawns.map((s) => queueDelay(s, task.configName))), spawnTime: DEPOSIT_BODY.length * 3,
    outboundTravelTicks, returnTravelTicks, bornTtl: CREEP_LIFE_TIME, bodyEnergy: cost,
    lastCooldown: deposit.lastCooldown, cooldown: deposit.cooldown, workParts: 10, capacity: 500,
    maxCooldown: config.maxCooldown, minExpectedAmount: config.minExpectedAmount, minUnitsPerEnergy: config.minUnitsPerEnergy });
  if (!economics.viable) { finishDepositTask(task, "aborted", economics.reasons.join(",")); return; }
  task.routeRooms = route; task.returnTargetId = destination.id;
  task.outboundTravelTicks = outboundTravelTicks; task.returnTravelTicks = returnTravelTicks;
  task.expectedAmount = economics.expectedAmount; task.expectedHarvestTicks = economics.harvestTicks;
  task.unitsPerEnergy = economics.unitsPerEnergy; task.spawnReadyAt = Game.time;
  delete task.blocker; delete task.nextAttemptAt;
}
function reconcile(task: DepositHarvestTask, config: DepositHarvestConfig): void {
  const enabled = config.enabled;
  const creep = taskCreep(task) ?? (task.creepName ? Game.creeps[task.creepName] : undefined);
  if (creep && creep.memory.configName === task.configName) bind(task, creep);
  const spawningName = actualSpawning(task);
  if (spawningName) { task.spawnStartedAt ??= Game.time; task.creepName ??= spawningName; }
  if (isDepositTerminal(task)) { cleanupDepositSpawnOwner(task); return; }
  if (task.spawnStartedAt !== undefined && !creep && !spawningName) {
    finishDepositTask(task, "failed", "creep_died"); return;
  }
  if (task.bornAt !== undefined) {
    // 过期或禁用只中止新增采集，货物的 returning/unloading 不受期限销毁。
    if ((!enabled || Game.time >= task.expiresAt) && task.status !== "returning" && task.status !== "unloading") {
      setDepositTaskStatus(task, "returning"); task.stopReason = enabled ? "deposit_expired" : "disabled";
      if (creep) (creep.memory as CreepMemory & DepositHarvesterMemory).depositReturning = true;
    }
    cleanupDepositSpawnOwner(task);
    return;
  }
  if (!enabled || Game.time >= task.expiresAt) {
    finishDepositTask(task, "aborted", enabled ? "deposit_expired" : "disabled"); return;
  }
  if (task.status === "spawning" && !spawningName && !creep) {
    const cfg = task.configName ? getCreepConfigService().get(task.configName) : undefined;
    if (!configOwned(task, cfg)) { finishDepositTask(task, "failed", "spawn_owner_lost"); return; }
    if (!bodyMatches(cfg!)) { finishDepositTask(task, "failed", "spawn_body_changed"); return; }
    const delay = Math.max(0, ...spawnsIn(task.sourceRoom).map((s) => queueDelay(s, task.configName)));
    if (hasPowerBankPriority(task.sourceRoom) || isDefenseMode(task.sourceRoom)) {
      finishDepositTask(task, "aborted", "power_bank_or_defense_priority"); return;
    }
    if (Game.time + delay + DEPOSIT_BODY.length * 3 + (task.outboundTravelTicks ?? Infinity) +
      (task.expectedHarvestTicks ?? Infinity) >= task.expiresAt) {
      finishDepositTask(task, "aborted", "spawn_queue_missed_deadline"); return;
    }
    validateWaitingSpawn(task, config);
  }
}
function admit(task: DepositHarvestTask, tasks: DepositHarvestTask[], config: DepositHarvestConfig): void {
  requestDepositObservation(task.targetRoom);
  const target = Game.rooms[task.targetRoom];
  if (!target) { block(task, "target_not_visible"); return; }
  const deposit = Game.getObjectById<Deposit>(task.depositId as Id<Deposit>);
  if (!deposit || deposit.depositType !== task.resourceType || deposit.pos.x !== task.depositPos.x ||
    deposit.pos.y !== task.depositPos.y || deposit.pos.roomName !== task.targetRoom) {
    finishDepositTask(task, "aborted", "deposit_missing_or_changed"); return;
  }
  task.cooldown = deposit.cooldown; task.lastCooldown = deposit.lastCooldown; task.lastSeenAt = Game.time;
  task.expiresAt = Math.min(task.expiresAt, Game.time + deposit.ticksToDecay);
  const cost = DEPOSIT_BODY.reduce((sum, p) => sum + BODYPART_COST[p], 0);
  // 房间 route 只做廉价候选排序；每个来源仍须所有 active Spawn 完整 PF。
  const sources: Array<{ room: Room; route: string[]; destination: StructureStorage | StructureTerminal; spawns: StructureSpawn[] }> = [];
  for (const room of getTickContextService().getMyRooms()) {
    if (room.energyCapacityAvailable < cost || room.energyAvailable < cost || !canStartOutboundMission(room.name) ||
      hasPowerBankPriority(room.name) || tasks.some((t) => t.sourceRoom === room.name && !isDepositTerminal(t) && t.status !== "discovered")) continue;
    const route = findDepositSafeRoute(room.name, task.targetRoom);
    const destination = receiver(room);
    const spawns = spawnsIn(room.name);
    if (!route || !destination || spawns.length === 0) continue;
    sources.push({ room, route, destination, spawns });
  }
  sources.sort((a, b) => a.route.length - b.route.length || a.room.name.localeCompare(b.room.name));
  let pendingRetryAt: number | undefined;
  let pendingReason: string | undefined;
  for (const { room, route, destination, spawns } of sources) {
    const measured = spawns.map((spawn) => measureDepositTravel({ origin: spawn.pos, target: deposit.pos,
      returnTarget: destination.pos, body: DEPOSIT_BODY, loadedAmount: 500, routeRooms: route, avoidRooms: getDepositAvoidRooms() }));
    const waiting = measured.filter((r): r is Extract<typeof r, { status: "pending" }> => r.status === "pending");
    if (waiting.length > 0) {
      pendingRetryAt = Math.min(pendingRetryAt ?? Infinity, ...waiting.map((r) => r.retryAt));
      pendingReason ??= `path_${waiting[0].reason}`;
      // pending 只排除此来源。继续读其它 ready/负缓存，并给预算排队者
      // 保留 +1 重试；不能每次等首源的负缓存到期后又重复耗尽测量配额。
      continue;
    }
    const ready = measured.filter((r): r is Extract<typeof r, { status: "ready" }> => r.status === "ready");
    const outboundTravelTicks = Math.max(...ready.map((r) => r.outboundTravelTicks));
    const returnTravelTicks = Math.max(...ready.map((r) => r.returnTravelTicks));
    const economics = assessDepositViability({ currentTick: Game.time, expiresAt: task.expiresAt,
      queueDelay: Math.max(...spawns.map((s) => queueDelay(s))), spawnTime: DEPOSIT_BODY.length * 3,
      outboundTravelTicks, returnTravelTicks, bornTtl: CREEP_LIFE_TIME, bodyEnergy: cost,
      lastCooldown: task.lastCooldown, cooldown: task.cooldown, workParts: 10, capacity: 500,
      maxCooldown: config.maxCooldown, minExpectedAmount: config.minExpectedAmount, minUnitsPerEnergy: config.minUnitsPerEnergy });
    task.expectedAmount = economics.expectedAmount; task.expectedHarvestTicks = economics.harvestTicks;
    task.unitsPerEnergy = economics.unitsPerEnergy;
    if (!economics.viable) { block(task, economics.reasons.join(","), 25); continue; }
    task.sourceRoom = room.name; task.routeRooms = route; task.returnTargetId = destination.id;
    task.outboundTravelTicks = outboundTravelTicks; task.returnTravelTicks = returnTravelTicks;
    task.configName = `${room.name}:deposit:${task.id}:g${task.generation}`;
    if (getCreepConfigService().get(task.configName)) { finishDepositTask(task, "failed", "spawn_owner_conflict"); return; }
    getCreepConfigService().set(task.configName, { role: "depositHarvester", args: [task.id, room.name], roomName: room.name,
      body: [...DEPOSIT_BODY], taskId: task.id, spawnOnce: {} });
    setDepositTaskStatus(task, "spawning"); task.spawnReadyAt = Game.time; delete task.blocker; delete task.nextAttemptAt;
    return;
  }
  if (pendingRetryAt !== undefined) block(task, pendingReason!, Math.max(1, pendingRetryAt - Game.time));
  else if (!task.blocker) block(task, "no_available_source", 25);
}

export function runDepositHarvest(): void {
  const store = ensureDepositDiscoveryStore(); const config = getDepositHarvestConfig();
  const tasks = Object.values(store);
  for (const task of tasks) reconcile(task, config);
  cleanupDepositDiscoveryTasks();
  // 孤立的一代配置不交给 generic spawnOnce 重试；活体从 memory fallback 返仓。
  for (const [name, cfg] of Object.entries(getCreepConfigService().readStore())) {
    if (cfg.role !== "depositHarvester" || (cfg.taskId && store[cfg.taskId])) continue;
    for (const spawn of Object.values(Game.spawns)) replaceSpawnQueue(spawn, (spawn.memory.spawnList ?? []).filter((n) => n !== name));
    getCreepConfigService().remove(name);
  }
  if (!config.enabled) return;
  let active = tasks.filter((t) => !isDepositTerminal(t) && t.status !== "discovered").length;
  for (const task of tasks.filter((t) => t.status === "discovered" && (t.nextAttemptAt ?? 0) <= Game.time)
    .sort((a, b) => (a.nextAttemptAt ?? 0) - (b.nextAttemptAt ?? 0) || a.discoveredAt - b.discoveredAt || a.id.localeCompare(b.id))) {
    if (active >= config.maxActiveTasks) break;
    admit(task, tasks, config); if (task.status === "spawning") active += 1;
  }
}

const depositLifecycle = createTaskLifecycle<DepositHarvestStatus, DepositHarvestTask>("deposit", {
  discovered: ["spawning", "aborted", "failed"], spawning: ["outbound", "harvesting", "unloading", "returning", "complete", "aborted", "failed"],
  outbound: ["harvesting", "returning", "unloading", "complete", "aborted", "failed"],
  harvesting: ["returning", "unloading", "complete", "aborted", "failed"],
  returning: ["unloading", "complete", "aborted", "failed"], unloading: ["returning", "complete", "aborted", "failed"],
  complete: ["complete"], aborted: ["aborted"], failed: ["failed"],
}, task => task.id);
export function setDepositTaskStatus(task: DepositHarvestTask, status: DepositHarvestStatus): void {
  depositLifecycle.transition(task, status);
}
