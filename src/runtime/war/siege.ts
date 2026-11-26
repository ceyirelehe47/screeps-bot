import { countCarrierCargo } from "@/runtime/carrierCargo";
import { getActivePowerBankBoostLabIds, getAssignedPowerBankBoostLabId } from "@/runtime/powerBankBoostMemory";
import { isDue } from "@/runtime/cadence";
import { getBoostPartType, countBoostableParts } from "@/runtime/boostParts";
import { findBestDonorRoom, prepareBoosts } from "@/runtime/powerBankBoost";
import { selectLeastLoadedSpawn } from "@/runtime/spawnHelpers";
import { canStartOutboundMission } from "@/runtime/outboundMissionPolicy";
import { canContinueWarMission, canReinforceGuardedSiege } from "./outbound";
import {
  enqueueConfig,
  getSpawnsForRoom,
  isConfigQueuedInSpawns,
  isConfigSpawning,
  transitionWarTaskTerminal,
  upsertWarConfig,
} from "./production";
import { ensureConfigStore, getLegacyWarBoostTaskId, getLiveCreepsByConfig, type WarTask } from "./store";
import {
  assembleSiegeWings,
  reinforcementBody,
  SIEGE_BODIES,
  SIEGE_BOOSTS,
  SIEGE_SLOTS,
  siegeSlots,
  siegeConfigName,
} from "./siegeRoster";
import { defaultWarMapRoute } from "./observation";
import { requestCombatObservation } from "../powerBankObserver";
import { setTaskStatus } from "./fsm";

/** 只有持续的玩家攻城任务才自动扩大编组；显式战术和一次性出击保留原规模。 */
export function shouldUseSiege(task: WarTask, room: Room | undefined): boolean {
  if (
    !task.autoTactic ||
    task.oneShot !== false ||
    task.reason !== "manual" ||
    task.squad !== "t3Duo" ||
    task.activeGeneration ||
    !room?.controller?.owner ||
    room.controller.my ||
    room.controller.level < 7
  )
    return false;
  const home = Game.rooms[task.sourceRoom];
  if (
    !home?.storage ||
    home.energyCapacityAvailable <
      Math.max(...Object.values(SIEGE_BODIES).map((body) => body.reduce((cost, p) => cost + BODYPART_COST[p], 0)))
  )
    return false;
  if (home.find(FIND_MY_STRUCTURES).filter((s) => s.structureType === STRUCTURE_LAB).length < 5) return false;
  const fortified = room
    .find(FIND_HOSTILE_SPAWNS)
    .some((s) => room.lookForAt(LOOK_STRUCTURES, s.pos).some((tile) => tile.structureType === STRUCTURE_RAMPART));
  return fortified && room.find(FIND_HOSTILE_STRUCTURES).filter((s) => s.structureType === STRUCTURE_TOWER).length >= 3;
}

/** 续兵只预约本地实际可用的矿物。一种矿耗尽时，其他类型的实验室继续供给。 */
export function limitReinforcementBoosts(
  amounts: Map<ResourceConstant, number>,
  available: (resource: ResourceConstant) => number,
  canImport: (resource: ResourceConstant, amount: number) => boolean,
): ResourceConstant[] {
  const exhausted: ResourceConstant[] = [];
  for (const [resource, needed] of amounts) {
    const stock = Math.floor(available(resource) / LAB_BOOST_MINERAL) * LAB_BOOST_MINERAL;
    if (stock >= needed || canImport(resource, needed - stock)) continue;
    if (stock) amounts.set(resource, stock);
    else {
      amounts.delete(resource);
      exhausted.push(resource);
    }
  }
  return exhausted;
}

/** 已进入目标房的老兵能在补员孵化与行军期间继续作战。 */
export function needsSiegeSuccessor(task: WarTask, units: Creep[], spawnTime: number, homeEnergy: number): boolean {
  if (!units.length) return true;
  if (units.length !== 1 || !task.siegeLaunched || task.oneShot !== false || homeEnergy < 150000) return false;
  const veteran = units[0];
  if (veteran.spawning || veteran.room.name !== task.targetRoom || veteran.ticksToLive === undefined) return false;
  const travel = Math.max(1, (task.routeRooms?.length ?? 2) - 1) * 50;
  // 同一波的多名老兵会陆续退役，要为队列、强化、集结和行军都留出时间。
  return veteran.ticksToLive <= 3 * spawnTime + travel + 80;
}

/** 查看实际补兵通道，只在自动路线被成群敌兵控制时换线；保留尚无视野的近期危险。 */
export function refreshSiegeApproach(task: WarTask): void {
  if (task.routeOrigin !== "map" || !task.routeRooms || task.routeRooms.length < 3) return;
  const avoid = task.siegeAvoidUntil ?? {};
  for (const [name, until] of Object.entries(avoid)) if (until <= Game.time) delete avoid[name];
  const transit = task.routeRooms.slice(1,-1);
  const staging = task.siegeStagingRoom ?? transit[transit.length-1];
  if (!Game.rooms[staging]) requestCombatObservation(staging);
  for (const name of transit) {
    const room = Game.rooms[name];
    if (!room) continue;
    const armed = room.find(FIND_HOSTILE_CREEPS).filter(h => h.owner.username !== "Source Keeper" &&
      h.owner.username !== "Invader" && (h.getActiveBodyparts(RANGED_ATTACK) >= 5 || h.getActiveBodyparts(ATTACK) >= 5));
    if (armed.length >= 2) avoid[name] = Game.time + 350;
  }
  if (Object.keys(avoid).length) task.siegeAvoidUntil = avoid;
  else delete task.siegeAvoidUntil;
  const blocked = transit.find(name => avoid[name] !== undefined);
  if (!blocked) {
    if (task.siegeStagingRoom && task.siegeStagingRoom !== transit[transit.length-1]) {
      task.siegeStagingRoom = transit[transit.length-1];
      delete task.siegeFlankRoute;
    }
    return;
  }
  const plan = defaultWarMapRoute(task.sourceRoom, task.targetRoom,
    avoid[staging] ? staging : undefined, undefined, Object.keys(avoid));
  if (plan.rooms && plan.rooms.length <= task.routeRooms.length + 5) {
    task.routeRooms = plan.rooms;
    task.siegeStagingRoom = plan.rooms[plan.rooms.length - 2];
    task.routeTrace = plan.trace;
    task.routePlannedAt = Game.time;
  } else {
    // 单一通道被守住时，先在危险房的前一房集结，让完整队伍迎敌。
    task.siegeStagingRoom = task.routeRooms[task.routeRooms.indexOf(blocked) - 1] ?? task.sourceRoom;
  }
  delete task.siegeFlankRoute;
}

export function runSiegeCampaign(task: WarTask): void {
  if (isDue("siege-route:" + task.targetRoom, 7)) refreshSiegeApproach(task);
  const target = Game.rooms[task.targetRoom];
  if (!target || isDue("siege-observe:"+task.targetRoom, 10)) requestCombatObservation(task.targetRoom);
  if (target && !target.find(FIND_HOSTILE_SPAWNS).length) {
    task.clearSince ??= Game.time;
    if (target.controller?.my || Game.time - task.clearSince >= 100) transitionWarTaskTerminal(task, "done", null);
    return;
  }
  delete task.clearSince;
  if (!task.siegeWingCount) {
    const home = Game.rooms[task.sourceRoom];
    const stock = (resource: ResourceConstant) =>
      (home?.storage?.store.getUsedCapacity(resource) ?? 0) + (home?.terminal?.store.getUsedCapacity(resource) ?? 0);
    const requirements = new Map<ResourceConstant, number>();
    for (const job of SIEGE_SLOTS)
      for (const compound of SIEGE_BOOSTS[job]) {
        const amount =
          SIEGE_BODIES[job].filter((part) => part === getBoostPartType(compound)).length * LAB_BOOST_MINERAL;
        requirements.set(compound, (requirements.get(compound) ?? 0) + amount);
      }
    task.siegeWingCount =
      task.oneShot === false &&
      getSpawnsForRoom(task.sourceRoom).length >= 3 &&
      stock(RESOURCE_ENERGY) >= 250000 &&
      [...requirements].every(([compound, amount]) => stock(compound) >= amount)
        ? 3
        : 2;
  }
  const room = Game.rooms[task.sourceRoom];
  const homeEnergy = (room?.storage?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0) +
    (room?.terminal?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0);
  const members = siegeSlots(task).map((job, index) => {
    const name = siegeConfigName(task, index);
    const units = getLiveCreepsByConfig(name);
    const successor = needsSiegeSuccessor(task, units, SIEGE_BODIES[job].length * CREEP_SPAWN_TIME, homeEnergy);
    const unit = units.reduce<Creep | undefined>((newest, c) =>
      !newest || (c.ticksToLive ?? Infinity) > (newest.ticksToLive ?? Infinity) ? c : newest, undefined);
    return { job, name, index, unit, units, successor };
  });
  const staging = (task.siegeStagingRoom ??= task.routeRooms?.[task.routeRooms.length - 2] ?? task.sourceRoom);
  assembleSiegeWings(
    task,
    members.flatMap((member) => member.units),
    staging,
  );
  if (task.siegeWings?.[2] && task.routeOrigin !== "manual" && !task.siegeFlankRoute) {
    const bypass = defaultWarMapRoute(staging, task.targetRoom, staging, undefined, Object.keys(task.siegeAvoidUntil ?? {})).rooms;
    // 长途迂回会消耗寿命；没有短支路时保留原进场路线。
    task.siegeFlankRoute = bypass && bypass.length <= 5 ? bypass : [staging, task.targetRoom];
  }
  if (Object.values(task.siegeWings ?? {}).some(Boolean)) task.siegeLaunched = true;
  setTaskStatus(task, task.siegeLaunched ? "clearing" : "staging");
  if (!canStartOutboundMission(task.sourceRoom) && !canContinueWarMission(task) && !canReinforceGuardedSiege(task))
    return;
  const spawns = getSpawnsForRoom(task.sourceRoom);
  if (!spawns.length) return;
  const store = ensureConfigStore();
  const taskId = getLegacyWarBoostTaskId(task);
  const armor=RESOURCE_CATALYZED_GHODIUM_ALKALIDE;
  const labs=room?.find(FIND_MY_STRUCTURES).filter((s): s is StructureLab=>s.structureType===STRUCTURE_LAB) ?? [];
  const armorStock=(room?.storage?.store.getUsedCapacity(armor)??0)+(room?.terminal?.store.getUsedCapacity(armor)??0)+
    labs.reduce((total,l)=>total+(l.store.getUsedCapacity(armor)??0),0);
  const amounts = new Map<ResourceConstant, number>();
  const slots = members.map(({ job, name, unit, units, index, successor }) => {
    const spent = !!task.oneShot && store[name]?.spawnOnce?.queuedAt !== undefined;
    const body = task.oneShot===false && task.siegeLaunched && room ? reinforcementBody(job,armorStock,room.energyCapacityAvailable) : SIEGE_BODIES[job];
    for (const compound of SIEGE_BOOSTS[job]) {
      const count = unit && !successor
        ? units.reduce((n,c) => n + countBoostableParts(c.body, compound), 0)
        : spent && !isConfigQueuedInSpawns(spawns, name) && !isConfigSpawning(name)
          ? 0
          : body.filter((part) => part === getBoostPartType(compound)).length;
      if (count) amounts.set(compound, (amounts.get(compound) ?? 0) + count * LAB_BOOST_MINERAL);
    }
    return { name, unit, spent, job, body, index, successor };
  });
  if (task.siegeLaunched && task.oneShot === false) {
    const home = Game.rooms[task.sourceRoom];
    if (home) {
      const labs = home.find(FIND_MY_STRUCTURES).filter((s): s is StructureLab => s.structureType === STRUCTURE_LAB);
      const reserved=getActivePowerBankBoostLabIds(home.name,taskId);
      const available=labs.filter(l=>!reserved.has(l.id) && l.id!==Memory.cfg?.homeDefense?.rooms?.[home.name]?.boostLabId);
      task.siegeExhausted = limitReinforcementBoosts(amounts, (r) => {
        const assigned=getAssignedPowerBankBoostLabId(taskId,r);
        const loaded=available.filter(l=>l.mineralType===r).sort((a,b)=>(b.store.getUsedCapacity(r)??0)-(a.store.getUsedCapacity(r)??0))[0];
        const lab=loaded??available.find(l=>l.id===assigned);
        return (home.storage?.store.getUsedCapacity(r) ?? 0) + (home.terminal?.store.getUsedCapacity(r) ?? 0) +
          (lab?.store.getUsedCapacity(r) ?? 0) + (lab?countCarrierCargo(lab.id,r):0);
      }, (r,shortage)=>!!home.terminal && !!findBestDonorRoom(r,shortage,[home.name]));
    }
  }
  const prep = prepareBoosts(taskId, task.sourceRoom, 0, amounts, { requireLabEnergy: true, preferLoadedLabs: true });
  task.boostStatus = prep.status;
  task.boostLabs = prep.labs;
  task.failReason = prep.reason;
  if (prep.status === "failed" && !slots.some((s) => s.unit)) {
    transitionWarTaskTerminal(task, "failed", prep.reason);
    return;
  }
  const route = task.routeRooms?.join("|") ?? "";
  for (const { name, spent, job, body, index, successor } of slots) {
    if (index >= 4 && !task.siegeLaunched && members.slice(0, 4).some((s) => !s.unit)) continue;
    if (!store[name] || (successor && !isConfigSpawning(name) && store[name].body?.some((part,i)=>part!==body[i])))
      upsertWarConfig(name, {
        role: "siegeUnit",
        roomName: task.sourceRoom,
        body: [...body],
        args: [task.targetRoom, route, taskId, SIEGE_BOOSTS[job].join("|"), job, String(index)],
        spawnOnce: task.oneShot ? {} : undefined,
      });
    if (successor && !spent && !isConfigQueuedInSpawns(spawns, name) && !isConfigSpawning(name)) {
      const spawn = selectLeastLoadedSpawn(spawns);
      if (spawn) enqueueConfig(spawn, name, true);
    }
  }
  if (slots.every((s) => s.spent && !s.unit && !isConfigQueuedInSpawns(spawns, s.name) && !isConfigSpawning(s.name))) {
    transitionWarTaskTerminal(task, "failed", "siege_force_lost");
  }
}
