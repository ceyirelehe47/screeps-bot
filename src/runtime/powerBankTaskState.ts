import { POWER_BANK_STATUS } from "@/runtime/powerBankConstants";

const DEFAULT_STAGE_TIMEOUTS: Partial<Record<PowerBankHarvestStatus, number>> = {
  [POWER_BANK_STATUS.DISCOVERED]: 500,
  [POWER_BANK_STATUS.PREPARING_BOOSTS]: 400,
  [POWER_BANK_STATUS.SPAWNING]: 900,
  [POWER_BANK_STATUS.RENEWING]: 500,
  [POWER_BANK_STATUS.BOOSTING]: 400,
};

export const ATTACK_PROGRESS_TIMEOUT = 100;
const VISIBILITY_GRACE_TICKS = 75;
const HAULING_TIMEOUT_TICKS = 1200;

export function isTerminalPowerBankStatus(status: PowerBankHarvestStatus): boolean {
  return status === POWER_BANK_STATUS.FAILED ||
    status === POWER_BANK_STATUS.ABORTED ||
    status === POWER_BANK_STATUS.COMPLETE;
}

export function initializePowerBankTaskRuntime(task: PowerBankHarvestTask): void {
  const legacyPair = task.activeGeneration === undefined;
  task.bankExpiresAt ??= task.lastSeenTick + task.ticksToDecay;
  task.stageEnteredAt ??= task.discoveredTick;
  task.lastProgressAt ??= task.discoveredTick;
  task.lastVisibleAt ??= task.lastSeenTick;
  task.activeGeneration ??= 0;
  task.activeIndex ??= 0;
  if (
    legacyPair &&
    task.combatReady === undefined &&
    !!task.attackerId &&
    !!task.healerId &&
    (task.status === POWER_BANK_STATUS.TRAVELLING || task.status === POWER_BANK_STATUS.ATTACKING)
  ) {
    task.combatReady = task.attackerReady !== false && task.healerReady !== false;
  }
  task.primaryBoostLabs ??= task.boostLabs ?? [];
  task.observedPower ??= 0;
  task.pickedUpPower ??= 0;
  task.deliveredPower ??= 0;
  task.lostPower ??= 0;

  if (task.reinforcement) {
    task.reinforcement.generation ??= task.activeGeneration + 1;
    task.reinforcement.boostOwnerId ??=
      `${task.id}:reinforcement:g${task.reinforcement.generation}`;
    task.reinforcement.boostLabs ??= [];
  }
}

export function transitionPowerBankTask(
  task: PowerBankHarvestTask,
  status: PowerBankHarvestStatus,
  reason?: string,
): void {
  if (task.status !== status) {
    task.status = status;
    task.stageEnteredAt = Game.time;
    task.lastProgressAt = Game.time;
  }

  delete task.blocker;
  delete task.nextAttemptAt;

  if (isTerminalPowerBankStatus(status)) {
    task.terminalTick ??= Game.time;
    task.failReason = reason;
    if (status === POWER_BANK_STATUS.ABORTED) task.outcome ??= "aborted";
    if (status === POWER_BANK_STATUS.FAILED) task.outcome ??= "failed";
  } else if (reason) {
    task.blocker = reason;
  }
}

export function markPowerBankProgress(task: PowerBankHarvestTask): void {
  task.lastProgressAt = Game.time;
  delete task.blocker;
  delete task.nextAttemptAt;
}

export function setPowerBankBlocker(
  task: PowerBankHarvestTask,
  blocker: string,
  retryAfter = 1,
): void {
  task.blocker = blocker;
  task.nextAttemptAt = Game.time + Math.max(1, retryAfter);
}

export function getPowerBankStageTimeout(task: PowerBankHarvestTask): number | undefined {
  if (task.status === POWER_BANK_STATUS.TRAVELLING) {
    return Math.max(250, Math.ceil(task.combatTravelTicks ?? ((task.routeDistance ?? 5) * 50)) + 250);
  }
  if (task.status === POWER_BANK_STATUS.HAULING) {
    return HAULING_TIMEOUT_TICKS;
  }
  return DEFAULT_STAGE_TIMEOUTS[task.status];
}

export function getPowerBankLifecycleFailure(task: PowerBankHarvestTask): string | undefined {
  if (isTerminalPowerBankStatus(task.status)) return undefined;

  if (
    task.status !== POWER_BANK_STATUS.HAULING &&
    task.bankExpiresAt !== undefined &&
    Game.time >= task.bankExpiresAt
  ) {
    return "bank_expired";
  }

  // 视野、战斗威胁或有界测路仍未证实时，不把旧 500-tick 准备超时
  // 解释成不可达。bankExpiresAt 在本分支之前保持严格的绝对截止时间。
  if (
    task.status === POWER_BANK_STATUS.DISCOVERED &&
    (task.blocker === "target_not_visible" ||
      task.blocker === "target_bank_unconfirmed" ||
      task.blocker === "target_combat_threat" ||
      task.blocker === "path_measurement_pending")
  ) {
    return undefined;
  }

  const timeout = getPowerBankStageTimeout(task);
  if (
    timeout !== undefined &&
    task.stageEnteredAt !== undefined &&
    Game.time - task.stageEnteredAt > timeout
  ) {
    return `stage_timeout:${task.status}`;
  }

  if (
    task.status === POWER_BANK_STATUS.ATTACKING &&
    task.lastBankProgressAt !== undefined &&
    Game.time - task.lastBankProgressAt > ATTACK_PROGRESS_TIMEOUT &&
    (task.combatRecoveryProgressAt === undefined || Game.time - task.combatRecoveryProgressAt > ATTACK_PROGRESS_TIMEOUT)
  ) {
    return "attack_no_progress";
  }

  if (
    task.status === POWER_BANK_STATUS.ATTACKING &&
    task.lastVisibleAt !== undefined &&
    Game.time - task.lastVisibleAt > VISIBILITY_GRACE_TICKS &&
    !task.attackerId &&
    !task.reinforcement?.attackerId
  ) {
    return "lost_vision_and_combat_pair";
  }

  if (
    task.status === POWER_BANK_STATUS.HAULING &&
    task.haulingDeadlineAt !== undefined &&
    Game.time > task.haulingDeadlineAt
  ) {
    return "hauling_timeout";
  }

  return undefined;
}

export function updatePowerBankObservation(
  task: PowerBankHarvestTask,
  bank: Pick<StructurePowerBank, "hits" | "power" | "ticksToDecay">,
): void {
  task.lastSeenTick = Game.time;
  task.lastVisibleAt = Game.time;
  task.bankExpiresAt = Game.time + bank.ticksToDecay;
  task.ticksToDecay = bank.ticksToDecay;
  task.power = bank.power;

  if (task.lastBankHits === undefined || bank.hits < task.lastBankHits) {
    task.lastBankProgressAt = Game.time;
    if (task.status === POWER_BANK_STATUS.DISCOVERED) {
      // Observer 看到他人攻击也属于观测进展，不代表本任务已经通过视野、
      // 威胁或测路门。保留准入等待与重试时间，避免恢复旧 500-tick 超时。
      task.lastProgressAt = Game.time;
    } else {
      markPowerBankProgress(task);
    }
  }
  task.lastBankHits = bank.hits;
  task.hits = bank.hits;
}
