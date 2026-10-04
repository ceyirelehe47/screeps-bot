import { normalizeNumber } from "@/runtime/configNormalize";
import { getReservedProductionAmountExcludingHolder } from "@/runtime/resourceReservation";
import { resolveRoomConfig } from "@/runtime/resourceControlRoomConfig";
import {
  cancelResourceTransferTask,
  countsResourceTransferTaskTowardDemand,
  createAutomaticResourceTransferTask,
  createResourceTransferTaskAmountIndex,
  ensureResourceTransferTaskStore,
} from "@/runtime/logistics/resourceTransferTasks";

export const HUB_FACTORY_OWNER = "hubFactoryPlanner";
const IMPORT_PREFIX = "hub:factory:";
const MINERALS = new Set<string>(["H", "O", "U", "K", "L", "Z", "X", "G"]);
const DEPOSITS = new Set<string>(["silicon", "biomass", "metal", "mist"]);
type Target = { resource: ResourceConstant; targetAmount: number; cap: number };

function stock(room: Room, resource: ResourceConstant, factory?: StructureFactory): number {
  return (room.storage?.store.getUsedCapacity(resource) ?? 0) +
    (room.terminal?.store.getUsedCapacity(resource) ?? 0) +
    (factory?.store.getUsedCapacity(resource) ?? 0);
}

/** 只发布 HUB 自己的队列；手工队列、停用配置和其它房间工厂保留原意。 */
export function planHubFactory(): void {
  const config = Memory.cfg?.factoryControl;
  const hub = Memory.cfg?.hub;
  if (!config) return;
  Memory.runtime ??= {};
  Memory.runtime.factoryControl ??= { rooms: {} };
  const runtime = Memory.runtime.factoryControl;
  const hubName = hub?.hubRoomName ?? "";
  const room = Game.rooms[hubName];
  const factory = room?.controller?.my && room.storage && room.terminal
    ? room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_FACTORY })[0] as StructureFactory | undefined
    : undefined;
  const enabled = config.enabled === true && hub?.enabled === true && config.hub?.enabled !== false;
  const manual = config.rooms?.[hubName];
  const manualOverride = !!manual && manual.managedBy !== HUB_FACTORY_OWNER;
  const globalQueue = (config.targetQueue?.length ?? 0) > 0 || (config.targets?.length ?? 0) > 0;
  const signature = JSON.stringify([enabled, hubName, factory?.id, config.hub, config.resourceFloors,
    manual?.enabled, manualOverride, globalQueue]);
  const previous = runtime.hubPlan;
  const interval = normalizeNumber(config.hub?.planInterval, 50, 1, 1000);
  if (previous?.signature === signature && Game.time - previous.updatedAt < interval) return;

  const actions: string[] = [];
  const state: NonNullable<typeof runtime.hubPlan> = {
    hubRoomName: hubName, updatedAt: Game.time, signature, status: "idle", targets: [], missing: {}, lastActions: actions,
  };
  runtime.hubPlan = state;
  config.rooms ??= {};
  // 迁移/停用时只撤销本规划器生成的目标，残留原料交给执行器卸出。
  for (const [name, owned] of Object.entries(config.rooms)) {
    if (owned.managedBy !== HUB_FACTORY_OWNER || owned.enabled === false) continue;
    if (!enabled || name !== hubName) {
      owned.targets = [];
      owned.targetQueue = [];
      owned.drainOnly = true;
    }
  }

  const canPlan = enabled && !!factory && !manualOverride && manual?.enabled !== false && !globalQueue;
  if (!canPlan) {
    state.status = !enabled ? "disabled" : manualOverride || manual?.enabled === false || globalQueue ? "manual" : "unavailable";
    cancelUnusedImports(new Set(), hubName, actions);
    state.lastActions = actions.slice(-16);
    return;
  }

  const productTarget = normalizeNumber(config.hub?.productTarget, 5000, 100, 50000);
  const mineralFloor = normalizeNumber(config.hub?.mineralFloor, 20000, 0, 100000);
  const energyFloor = Math.max(config.resourceFloors?.[RESOURCE_ENERGY] ?? 0, normalizeNumber(config.hub?.energyFloor, 200000, 0, 1000000));
  const energyTarget = Math.max(energyFloor, normalizeNumber(config.hub?.energyTarget, 250000, 0, 2000000));
  const compressionStart = Math.max(energyTarget + 600, normalizeNumber(config.hub?.energyCompressionStart, 400000, 0, 2000000));
  const floors: Partial<Record<ResourceConstant, number>> = { ...config.resourceFloors };
  floors[RESOURCE_ENERGY] = Math.max(floors[RESOURCE_ENERGY] ?? 0, energyFloor);
  for (const mineral of MINERALS) floors[mineral as ResourceConstant] = Math.max(floors[mineral as ResourceConstant] ?? 0, mineralFloor);
  const index = createResourceTransferTaskAmountIndex();
  const donors = Object.values(Game.rooms).filter(candidate => candidate.name !== hubName && candidate.controller?.my && candidate.storage && candidate.terminal);
  const available = (candidate: Room, resource: ResourceConstant, holder = ""): number => Math.max(0,
    stock(candidate, resource, candidate.name === hubName ? factory : undefined) -
    Math.max(
      MINERALS.has(resource) ? floors[resource] ?? 0 : resource === RESOURCE_ENERGY ? floors[RESOURCE_ENERGY] ?? 0 : config.resourceFloors?.[resource] ?? 0,
      candidate.name === hubName ? 0 : config.rooms?.[candidate.name]?.resourceFloors?.[resource] ?? 0,
      candidate.name === hubName ? 0 : resource === RESOURCE_ENERGY ? resolveRoomConfig(candidate.name).energyFloor : resolveRoomConfig(candidate.name).mineralFloor[resource] ?? 0,
    ) -
    getReservedProductionAmountExcludingHolder(candidate.name, resource, holder) - index.getOutgoing(candidate.name, resource));
  const localAvailable = (resource: ResourceConstant): number => available(room, resource, factory.id);
  const networkAvailable = (resource: ResourceConstant): number => localAvailable(resource) + index.getIncoming(hubName, resource) +
    donors.reduce((sum, donor) => sum + available(donor, resource), 0);
  const hasBatch = (components: Partial<Record<ResourceConstant, number>>): boolean => Object.entries(components).every(([r, needed]) =>
    networkAvailable(r as ResourceConstant) >= (needed ?? 0));
  const targets: Array<Target & { priority: number }> = [];
  const energy = stock(room, RESOURCE_ENERGY, factory);
  const recoveringEnergy = energy < energyFloor ||
    (previous?.targets.some(target => target.resource === RESOURCE_ENERGY) === true && energy < energyTarget);
  for (const [name, recipe] of Object.entries(COMMODITIES)) {
    if (recipe.level || recipe.amount <= 0) continue;
    const resource = name as ResourceConstant;
    const current = stock(room, resource, factory);
    let target = productTarget;
    let priority = 0;
    if (resource === RESOURCE_ENERGY) {
      if (!recoveringEnergy) continue;
      target = energyTarget;
      priority = 10000000;
    } else if (MINERALS.has(resource)) {
      target = floors[resource] ?? mineralFloor;
      priority = 1000000 + Math.max(0, target - current);
    } else if (resource === RESOURCE_BATTERY) {
      if (energy < compressionStart && !previous?.targets.some(entry => entry.resource === RESOURCE_BATTERY)) continue;
      if (recoveringEnergy) continue;
      priority = 50000;
    } else if (Object.keys(recipe.components).some(component => DEPOSITS.has(component))) {
      priority = 100000;
    } else if (Object.keys(recipe.components).some(component => MINERALS.has(component))) {
      // 压缩只消耗 HUB 本地的矿物余量，避免为压缩而跨房搬矿。
      if (!Object.entries(recipe.components).every(([r, needed]) => localAvailable(r as ResourceConstant) >= (needed ?? 0))) continue;
      priority = Math.min(75000, Math.max(...Object.keys(recipe.components).filter(r => MINERALS.has(r)).map(r => localAvailable(r as ResourceConstant))));
    } else continue;
    if (current >= target || !hasBatch(recipe.components)) continue;
    targets.push({ resource, targetAmount: target, cap: target + recipe.amount - 1, priority });
  }
  targets.sort((a, b) => b.priority - a.priority || a.resource.localeCompare(b.resource));
  state.targets = targets.map(({ priority: _priority, ...target }) => target);
  config.rooms[hubName] = {
    enabled: true, managedBy: HUB_FACTORY_OWNER, targets: state.targets,
    resourceFloors: floors, productionCaps: {}, sleepTicks: 0,
  };
  const execution = runtime.rooms[hubName];
  if (execution) execution.sleepUntilTick = undefined;
  const first = state.targets[0];
  if (!first) {
    cancelUnusedImports(new Set(), hubName, actions);
    state.lastActions = actions.slice(-16);
    return;
  }
  const wanted = new Set<ResourceConstant>();
  // 在途计入覆盖量；每种原料至多为一批补料（小于 100 时合并到 100）。
  for (const [name, needed] of Object.entries(COMMODITIES[first.resource].components)) {
    const resource = name as ResourceConstant;
    const localMissing = Math.max(0, (typeof needed === "number" ? needed : 0) - localAvailable(resource));
    if (localMissing <= 0) continue;
    wanted.add(resource);
    state.missing[resource] = localMissing;
  }
  cancelUnusedImports(wanted, hubName, actions);
  // 撤销失效旧任务后重建索引，避免重复派单或扣除已经释放的占用。
  const currentIndex = createResourceTransferTaskAmountIndex();
  for (const resource of wanted) {
    let missing = Math.max(0, (state.missing[resource] ?? 0) - currentIndex.getIncoming(hubName, resource));
    if (missing <= 0) continue;
    missing = Math.max(100, missing);
    for (const donor of donors.sort((a, b) => Game.map.getRoomLinearDistance(a.name, hubName) - Game.map.getRoomLinearDistance(b.name, hubName) || a.name.localeCompare(b.name))) {
      const amount = Math.floor(Math.min(missing, available(donor, resource)));
      if (amount <= 0) continue;
      const result = createAutomaticResourceTransferTask(donor.name, hubName, resource, amount, `${IMPORT_PREFIX}${hubName}:${resource}`);
      if (typeof result === "string") { actions.push(result); continue; }
      actions.push(`import:${resource}:${amount}:${donor.name}`);
      missing -= amount;
      if (missing <= 0) break;
    }
  }
  state.status = wanted.size > 0 ? "acquiring" : "ready";
  state.lastActions = actions.slice(-16);
}

function cancelUnusedImports(wanted: Set<ResourceConstant>, hubName: string, actions: string[]): void {
  for (const task of Object.values(ensureResourceTransferTaskStore())) {
    if (task.origin !== "automatic" || task.status !== "pending" || !task.reason?.startsWith(IMPORT_PREFIX) || task.treasurySlice) continue;
    if (task.toRoomName === hubName && wanted.has(task.resource) && countsResourceTransferTaskTowardDemand(task)) continue;
    const result = cancelResourceTransferTask(task.id);
    if (typeof result !== "string") actions.push(`cancel:${task.resource}:${task.id}`);
  }
}
