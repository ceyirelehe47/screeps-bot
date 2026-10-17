/** 稳定 key 决定相位，不随 global reset 改变。 */
export function cadenceOffset(key: string, every: number): number {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  return (hash >>> 0) % Math.max(1, Math.floor(every));
}

export function isDue(key: string, every: number, tick = Game.time, offset = cadenceOffset(key, every)): boolean {
  const interval = Math.max(1, Math.floor(every));
  return ((tick - offset) % interval + interval) % interval === 0;
}
