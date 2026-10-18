function intervalOf(every: number): number {
  return Number.isFinite(every) ? Math.max(1, Math.floor(every)) : 1;
}

/** 有界整数相位；轮询索引可使用它，不把轮询误当低频任务。 */
export function tickPhase(tick: number, every: number): number {
  const interval = intervalOf(every);
  return ((Math.floor(tick) % interval) + interval) % interval;
}

/** 稳定 key 决定相位，不随 global reset 改变。 */
export function cadenceOffset(key: string, every: number): number {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  return (hash >>> 0) % intervalOf(every);
}

export function isDue(key: string, every: number, tick = Game.time, offset = cadenceOffset(key, every)): boolean {
  return tickPhase(tick - offset, every) === 0;
}
