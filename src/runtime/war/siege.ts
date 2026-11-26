import { getBoostPartType, countBoostableParts } from "@/runtime/boostParts";
import { prepareBoosts } from "@/runtime/powerBankBoost";
import { selectLeastLoadedSpawn } from "@/runtime/spawnHelpers";
import { canStartOutboundMission } from "@/runtime/outboundMissionPolicy";
import { canContinueWarMission } from "./outbound";
import { enqueueConfig, getSpawnsForRoom, isConfigQueuedInSpawns, isConfigSpawning,
  transitionWarTaskTerminal, upsertWarConfig } from "./production";
import { ensureConfigStore, getLegacyWarBoostTaskId, getLiveCreepsByConfig, type WarTask } from "./store";
import { SIEGE_BODIES, SIEGE_BOOSTS, SIEGE_SLOTS, siegeConfigName } from "./siegeRoster";
import { requestCombatObservation } from "../powerBankObserver";
import { setTaskStatus } from "./fsm";

/** 只有持续的玩家攻城任务才自动扩大编组；显式战术和一次性出击保留原规模。 */
export function shouldUseSiege(task: WarTask, room: Room | undefined): boolean {
  if (!task.autoTactic || task.oneShot !== false || task.reason !== "manual" || task.squad !== "t3Duo" || task.activeGeneration
      || !room?.controller?.owner || room.controller.my || room.controller.level < 7) return false;
  const home = Game.rooms[task.sourceRoom];
  if (!home?.storage || home.energyCapacityAvailable < Math.max(...Object.values(SIEGE_BODIES).map(body =>
    body.reduce((cost, p) => cost + BODYPART_COST[p], 0)))) return false;
  if (home.find(FIND_MY_STRUCTURES).filter(s => s.structureType === STRUCTURE_LAB).length < 5) return false;
  const fortified = room.find(FIND_HOSTILE_SPAWNS).some(s => room.lookForAt(LOOK_STRUCTURES, s.pos)
    .some(tile => tile.structureType === STRUCTURE_RAMPART));
  return fortified && room.find(FIND_HOSTILE_STRUCTURES).filter(s => s.structureType === STRUCTURE_TOWER).length >= 3;
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
  const members = SIEGE_SLOTS.map((job, index) => {
    const name = siegeConfigName(task, index);
    return { job, name, index, unit: getLiveCreepsByConfig(name)[0] };
  });
  const staging = task.siegeStagingRoom ??= task.routeRooms?.[task.routeRooms.length - 2] ?? task.sourceRoom;
  const wings = task.siegeWings ??= {};
  for (const start of [0, 4]) {
    const team = members.slice(start, start + 4);
    if (team.every(s => s.unit?.memory.ready && s.unit.room.name === staging)) wings[start / 4] = true;
  }
  if (Object.values(wings).some(Boolean)) task.siegeLaunched = true;
  setTaskStatus(task, task.siegeLaunched ? "clearing" : "staging");
  if (!canStartOutboundMission(task.sourceRoom) && !canContinueWarMission(task)) return;
  const spawns = getSpawnsForRoom(task.sourceRoom);
  if (!spawns.length) return;
  const store = ensureConfigStore();
  const taskId = getLegacyWarBoostTaskId(task);
  const amounts = new Map<ResourceConstant, number>();
  const slots = members.map(({ job, name, unit, index }) => {
    const spent = !!task.oneShot && store[name]?.spawnOnce?.queuedAt !== undefined;
    const body = SIEGE_BODIES[job];
    for (const compound of SIEGE_BOOSTS[job]) {
      const count = unit ? countBoostableParts(unit.body, compound)
        : spent && !isConfigQueuedInSpawns(spawns, name) && !isConfigSpawning(name) ? 0
        : body.filter(part => part === getBoostPartType(compound)).length;
      if (count) amounts.set(compound, (amounts.get(compound) ?? 0) + count * LAB_BOOST_MINERAL);
    }
    return { name, unit, spent, job, body, index };
  });
  const prep = prepareBoosts(taskId, task.sourceRoom, 0, amounts, { requireLabEnergy: true });
  task.boostStatus = prep.status;
  task.boostLabs = prep.labs;
  task.failReason = prep.reason;
  if (prep.status === "failed" && !slots.some(s => s.unit)) {
    transitionWarTaskTerminal(task, "failed", prep.reason);
    return;
  }
  const route = task.routeRooms?.join("|") ?? "";
  for (const { name, unit, spent, job, body, index } of slots) {
    if (index >= 4 && !task.siegeLaunched && members.slice(0, 4).some(s => !s.unit)) continue;
    if (!store[name]) upsertWarConfig(name, { role: "siegeUnit", roomName: task.sourceRoom, body: [...body],
      args: [task.targetRoom, route, taskId, SIEGE_BOOSTS[job].join("|"), job, String(index)],
      spawnOnce: task.oneShot ? {} : undefined });
    if (!unit && !spent && !isConfigQueuedInSpawns(spawns, name) && !isConfigSpawning(name)) {
      const spawn = selectLeastLoadedSpawn(spawns);
      if (spawn) enqueueConfig(spawn, name, true);
    }
  }
  if (slots.every(s => s.spent && !s.unit && !isConfigQueuedInSpawns(spawns, s.name) && !isConfigSpawning(s.name))) {
    transitionWarTaskTerminal(task, "failed", "siege_force_lost");
  }
}
