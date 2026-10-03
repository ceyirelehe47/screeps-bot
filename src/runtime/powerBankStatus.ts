const POWER_BANK_HISTORY_LIMIT = 25;

function ensureHistory(): PowerBankHarvestHistoryEntry[] {
  if (!Memory.data) Memory.data = {};
  Memory.data.powerBankHarvestHistory ??= [];
  return Memory.data.powerBankHarvestHistory;
}

function toHistoryEntry(task: PowerBankHarvestTask): PowerBankHarvestHistoryEntry {
  return {
    taskId: task.id,
    sourceRoom: task.sourceRoom,
    targetRoom: task.targetRoom,
    power: task.power,
    status: task.status,
    outcome: task.outcome,
    failReason: task.failReason,
    discoveredTick: task.discoveredTick,
    terminalTick: task.terminalTick ?? Game.time,
    observedPower: task.observedPower ?? 0,
    pickedUpPower: task.pickedUpPower ?? 0,
    deliveredPower: task.deliveredPower ?? 0,
    lostPower: task.lostPower ?? 0,
  };
}

export function recordPowerBankHistory(task: PowerBankHarvestTask): void {
  const history = ensureHistory();
  const entry = toHistoryEntry(task);
  const existingIndex = history.findIndex((item) => item.taskId === task.id);
  if (existingIndex >= 0) {
    history[existingIndex] = entry;
  } else {
    history.push(entry);
  }

  history.sort((left, right) => left.terminalTick - right.terminalTick);
  if (history.length > POWER_BANK_HISTORY_LIMIT) {
    history.splice(0, history.length - POWER_BANK_HISTORY_LIMIT);
  }
}

function toTaskSnapshot(task: PowerBankHarvestTask): PowerBankStatusTaskSnapshot {
  return {
    taskId: task.id,
    status: task.status,
    sourceRoom: task.sourceRoom,
    targetRoom: task.targetRoom,
    stageAge: Math.max(0, Game.time - (task.stageEnteredAt ?? task.discoveredTick)),
    pathDistance: task.pathDistance ?? null,
    combatTravelTicks: task.combatTravelTicks ?? null,
    haulerOutboundTravelTicks: task.haulerOutboundTravelTicks ?? null,
    haulerReturnTravelTicks: task.haulerReturnTravelTicks ?? null,
    expiresIn: task.bankExpiresAt === undefined ? null : task.bankExpiresAt - Game.time,
    lastProgressAge: Math.max(0, Game.time - (task.lastProgressAt ?? task.discoveredTick)),
    blocker: task.blocker ?? null,
    activeGeneration: task.activeGeneration ?? null,
    combatReady: task.combatReady === true,
    attackerId: task.attackerId ?? null,
    healerId: task.healerId ?? null,
    reinforcementGeneration: task.reinforcement?.generation ?? null,
    reinforcementStage: task.reinforcement?.stage ?? null,
    reinforcementCombatReady: task.reinforcement?.combatReady === true,
    reinforcementAttackerReady: task.reinforcement?.attackerReady === true,
    reinforcementHealerReady: task.reinforcement?.healerReady === true,
    reinforcementAttackerId: task.reinforcement?.attackerId ?? null,
    reinforcementHealerId: task.reinforcement?.healerId ?? null,
    reinforcementStageAge: task.reinforcement
      ? Math.max(0, Game.time - (
        task.reinforcement.stageEnteredAt ??
        task.reinforcement.lastMemberChangeAt ??
        task.stageEnteredAt ??
        task.discoveredTick
      ))
      : null,
    reinforcementLastProgressAge: task.reinforcement
      ? Math.max(0, Game.time - (
        task.reinforcement.lastProgressAt ??
        task.reinforcement.lastMemberChangeAt ??
        task.lastProgressAt ??
        task.discoveredTick
      ))
      : null,
    reinforcementBlocker: task.reinforcement?.blocker ?? null,
    plannedDps: task.plannedDps ?? null,
    plannedHps: task.plannedHps ?? null,
    plannedTtk: task.plannedTtk ?? null,
    haulerSpawnIn: task.plannedHaulerSpawnStartTick === undefined
      ? null
      : task.plannedHaulerSpawnStartTick - Game.time,
    haulerArrivalIn: task.plannedHaulerArrivalTick === undefined
      ? null
      : task.plannedHaulerArrivalTick - Game.time,
    haulerCount: task.haulerCount ?? 0,
    observedPower: task.observedPower ?? 0,
    pickedUpPower: task.pickedUpPower ?? 0,
    deliveredPower: task.deliveredPower ?? 0,
    lostPower: task.lostPower ?? 0,
    outcome: task.outcome ?? null,
  };
}

export function powerBankStatusRaw(): PowerBankStatusSnapshot {
  const tasks = Object.values(Memory.data?.powerBankHarvest ?? {})
    .map(toTaskSnapshot)
    .sort((left, right) => left.expiresIn === null
      ? 1
      : right.expiresIn === null
        ? -1
        : left.expiresIn - right.expiresIn);

  return {
    ok: true,
    tick: Game.time,
    tasks,
    history: [...(Memory.data?.powerBankHarvestHistory ?? [])],
  };
}

export function powerBankStatusCommand(): string {
  return JSON.stringify(powerBankStatusRaw(), null, 2);
}
