

export function markLoadingStart(state: { loadingSinceTick?: number }, currentTick: number): void {
  if (!state.loadingSinceTick) {
    state.loadingSinceTick = currentTick;
  }
}

export function isLoadingTimedOut(
  loadingSinceTick: number | undefined,
  currentTick: number,
  timeoutTicks: number,
): boolean {
  if (!loadingSinceTick) return false;
  return currentTick - loadingSinceTick > timeoutTicks;
}

/**
 * Whether current inventory satisfies the target at LAB_REACTION_AMOUNT granularity.
 * A small remainder (< one reaction batch) counts as satisfied when current > 0.
 */
export function isTargetSatisfiedByReactionGranularity(current: number, targetAmount: number): boolean {
  return current >= targetAmount || (current > 0 && targetAmount - current < LAB_REACTION_AMOUNT);
}
