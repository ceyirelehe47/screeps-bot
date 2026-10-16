// 激活请求针对下一 tick；每个调用方必须每 tick 重新申请所需 ID。
// 同 tick 请求取并集，避免后调用的遥测覆盖其它使用方。只在这里调用
// setActiveSegments，超限整批拒绝，不静默挤掉先前申请的 segment。
let currentGame: typeof Game | undefined;
let currentRawMemory: typeof RawMemory | undefined;
let currentTick = -1;
let requested: number[] = [];

export function requestMemorySegments(ids: readonly number[]): void {
  if (currentGame !== Game || currentRawMemory !== RawMemory || currentTick !== Game.time) {
    currentGame = Game;
    currentRawMemory = RawMemory;
    currentTick = Game.time;
    requested = [];
  }
  const next = [...requested];
  for (const id of ids) {
    if (!Number.isInteger(id) || id < 0 || id > 99) {
      throw new RangeError(`Invalid memory segment ID: ${id}`);
    }
    if (!next.includes(id)) next.push(id);
  }
  if (next.length > 10) throw new RangeError("Cannot activate more than 10 memory segments");
  if (next.length === requested.length) return;
  RawMemory.setActiveSegments(next);
  requested = next;
}
