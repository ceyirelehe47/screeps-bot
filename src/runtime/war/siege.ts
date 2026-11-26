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
  SIEGE_BODIES,
  SIEGE_BOOSTS,
  SIEGE_SLOTS,
  siegeSlots,
  siegeConfigName,
} from "./siegeRoster";
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

export function runSiegeCampaign(task: WarTask): void {
  const target = Game.rooms[task.targetRoom];
  if (!target || Game.time % 10 === 0) requestCombatObservation(task.targetRoom);
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
  const members = siegeSlots(task).map((job, index) => {
    const name = siegeConfigName(task, index);
    return { job, name, index, unit: getLiveCreepsByConfig(name)[0] };
  });
  const staging = (task.siegeStagingRoom ??= task.routeRooms?.[task.routeRooms.length - 2] ?? task.sourceRoom);
  assembleSiegeWings(
    task,
    members.flatMap((member) => (member.unit ? [member.unit] : [])),
    staging,
  );
  if (Object.values(task.siegeWings ?? {}).some(Boolean)) task.siegeLaunched = true;
  setTaskStatus(task, task.siegeLaunched ? "clearing" : "staging");
  if (!canStartOutboundMission(task.sourceRoom) && !canContinueWarMission(task) && !canReinforceGuardedSiege(task))
    return;
  const spawns = getSpawnsForRoom(task.sourceRoom);
  if (!spawns.length) return;
  const store = ensureConfigStore();
  const taskId = getLegacyWarBoostTaskId(task);
  const amounts = new Map<ResourceConstant, number>();
  const slots = members.map(({ job, name, unit, index }) => {
    const spent = !!task.oneShot && store[name]?.spawnOnce?.queuedAt !== undefined;
    const body = SIEGE_BODIES[job];
    for (const compound of SIEGE_BOOSTS[job]) {
      const count = unit
        ? countBoostableParts(unit.body, compound)
        : spent && !isConfigQueuedInSpawns(spawns, name) && !isConfigSpawning(name)
          ? 0
          : body.filter((part) => part === getBoostPartType(compound)).length;
      if (count) amounts.set(compound, (amounts.get(compound) ?? 0) + count * LAB_BOOST_MINERAL);
    }
    return { name, unit, spent, job, body, index };
  });
  if (task.siegeLaunched && task.oneShot === false) {
    const home = Game.rooms[task.sourceRoom];
    if (home) {
      const labs = home.find(FIND_MY_STRUCTURES).filter((s): s is StructureLab => s.structureType === STRUCTURE_LAB);
      const carriers = home.find(FIND_MY_CREEPS).filter((c) => c.getActiveBodyparts(CARRY));
      task.siegeExhausted = limitReinforcementBoosts(amounts, (r) =>
        (home.storage?.store.getUsedCapacity(r) ?? 0) + (home.terminal?.store.getUsedCapacity(r) ?? 0) +
        labs.reduce((n, lab) => n + (lab.store.getUsedCapacity(r) ?? 0), 0) +
        carriers.reduce((n, carrier) => n + (carrier.store.getUsedCapacity(r) ?? 0), 0),
        (r, shortage) => !!home.terminal && !!findBestDonorRoom(r, shortage, [home.name]));
    }
  }
  const prep = prepareBoosts(taskId, task.sourceRoom, 0, amounts, { requireLabEnergy: true });
  task.boostStatus = prep.status;
  task.boostLabs = prep.labs;
  task.failReason = prep.reason;
  if (prep.status === "failed" && !slots.some((s) => s.unit)) {
    transitionWarTaskTerminal(task, "failed", prep.reason);
    return;
  }
  const route = task.routeRooms?.join("|") ?? "";
  for (const { name, unit, spent, job, body, index } of slots) {
    if (index >= 4 && !task.siegeLaunched && members.slice(0, 4).some((s) => !s.unit)) continue;
    if (!store[name])
      upsertWarConfig(name, {
        role: "siegeUnit",
        roomName: task.sourceRoom,
        body: [...body],
        args: [task.targetRoom, route, taskId, SIEGE_BOOSTS[job].join("|"), job, String(index)],
        spawnOnce: task.oneShot ? {} : undefined,
      });
    if (!unit && !spent && !isConfigQueuedInSpawns(spawns, name) && !isConfigSpawning(name)) {
      const spawn = selectLeastLoadedSpawn(spawns);
      if (spawn) enqueueConfig(spawn, name, true);
    }
  }
  if (slots.every((s) => s.spent && !s.unit && !isConfigQueuedInSpawns(spawns, s.name) && !isConfigSpawning(s.name))) {
    transitionWarTaskTerminal(task, "failed", "siege_force_lost");
  }
}
