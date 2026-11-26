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

export function runSiegeCampaign(task: WarTask): void {
  const target = Game.rooms[task.targetRoom];
  if (!target || Game.time % 10 === 0) requestCombatObservation(task.targetRoom);
  if (target && !target.find(FIND_HOSTILE_SPAWNS).length) {
    task.clearSince ??= Game.time;
    if (target.controller?.my || Game.time - task.clearSince >= 100) transitionWarTaskTerminal(task, "done", null);
    return;
  }
  delete task.clearSince;
  if (!canStartOutboundMission(task.sourceRoom) && !canContinueWarMission(task)) return;
  const spawns = getSpawnsForRoom(task.sourceRoom);
  if (!spawns.length) return;
  const store = ensureConfigStore();
  const taskId = getLegacyWarBoostTaskId(task);
  const amounts = new Map<ResourceConstant, number>();
  const slots = SIEGE_SLOTS.map((job, index) => {
    const name = siegeConfigName(task, index);
    const unit = getLiveCreepsByConfig(name)[0];
    const spent = !!task.oneShot && store[name]?.spawnOnce?.queuedAt !== undefined;
    const body = SIEGE_BODIES[job];
    for (const compound of SIEGE_BOOSTS[job]) {
      const count = unit ? countBoostableParts(unit.body, compound)
        : spent && !isConfigQueuedInSpawns(spawns, name) && !isConfigSpawning(name) ? 0
        : body.filter(part => part === getBoostPartType(compound)).length;
      if (count) amounts.set(compound, (amounts.get(compound) ?? 0) + count * LAB_BOOST_MINERAL);
    }
    return { name, unit, spent, job, body };
  });
  const prep = prepareBoosts(taskId, task.sourceRoom, 0, amounts, { requireLabEnergy: true });
  task.boostStatus = prep.status;
  task.boostLabs = prep.labs;
  task.failReason = prep.reason;
  if (prep.status === "failed" && !slots.some(s => s.unit)) {
    transitionWarTaskTerminal(task, "failed", prep.reason);
    return;
  }
  const staging = task.routeRooms?.[task.routeRooms.length - 2] ?? task.sourceRoom;
  const assembled = slots.filter(s => s.unit?.memory.ready && s.unit.room.name === staging);
  if (task.siegeLaunched || assembled.length >= 5 && assembled.some(s => s.job === "breacher")) {
    task.siegeLaunched = true;
    setTaskStatus(task, "clearing");
  } else setTaskStatus(task, "staging");
  const route = task.routeRooms?.join("|") ?? "";
  for (const { name, unit, spent, job, body } of slots) {
    if (!store[name]) upsertWarConfig(name, { role: "siegeUnit", roomName: task.sourceRoom, body: [...body],
      args: [task.targetRoom, route, taskId, SIEGE_BOOSTS[job].join("|"), job],
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
