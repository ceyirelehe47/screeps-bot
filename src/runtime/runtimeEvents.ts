import { getMemoryService } from "@/runtime/runtimeServices";

export interface RuntimeEvent {
  readonly sequence: number;
  readonly tick: number;
  readonly owner: string;
  readonly id: string;
  readonly kind: "transition" | "spawnAccepted" | "death" | "retirement";
  readonly from?: string;
  readonly to?: string;
}
export interface RuntimeEventCursor { readonly epoch: string; readonly sequence: number }
export interface RuntimeEventState { epoch: string; nextSequence: number; dropped: number; entries: RuntimeEvent[] }
export const RUNTIME_EVENT_CAPACITY = 128;
const EVENT_TTL = 5000;
let epochNonce = 0;
function newEpoch(): string {
  return `${Game.shard?.name ?? "unknown"}:${Game.time}:${++epochNonce}:${Math.random().toString(36).slice(2, 12)}`;
}
function validEvent(entry: RuntimeEvent): boolean {
  return !!entry && Number.isSafeInteger(entry.sequence) && entry.sequence > 0 &&
    Number.isSafeInteger(entry.tick) && entry.tick >= 0 && entry.tick <= Game.time && Game.time - entry.tick <= EVENT_TTL &&
    ["transition", "spawnAccepted", "death", "retirement"].includes(entry.kind) &&
    typeof entry.owner === "string" && entry.owner.length <= 32 && typeof entry.id === "string" && entry.id.length <= 96 &&
    (entry.from === undefined || typeof entry.from === "string" && entry.from.length <= 32) &&
    (entry.to === undefined || typeof entry.to === "string" && entry.to.length <= 32);
}
function state(): RuntimeEventState {
  const runtime = getMemoryService().ensureRuntime();
  const current = runtime.events;
  if (!current || !Array.isArray(current.entries) || !Number.isSafeInteger(current.nextSequence) ||
      current.nextSequence < 1 || current.nextSequence >= Number.MAX_SAFE_INTEGER) {
    runtime.events = { epoch: newEpoch(), nextSequence: 1, dropped: 0, entries: [] };
  }
  const store = runtime.events!;
  if (typeof store.epoch !== "string" || !store.epoch || store.epoch.length > 96) store.epoch = newEpoch();
  const entries = store.entries.slice(-RUNTIME_EVENT_CAPACITY).filter(validEvent);
  if (entries.some((entry, index) => entry.sequence >= store.nextSequence || index > 0 && entry.sequence <= entries[index - 1].sequence)) {
    runtime.events = { epoch: newEpoch(), nextSequence: 1, dropped: 0, entries: [] };
    return runtime.events;
  }
  store.dropped = Math.min(Number.MAX_SAFE_INTEGER, (Number.isSafeInteger(store.dropped) && store.dropped >= 0 ? store.dropped : 0) + store.entries.length - entries.length);
  store.entries = entries;
  return store;
}

/** 有界、持久、有序；只记录可序列化的身份和结果，不复制任务/creep 对象。 */
export function appendRuntimeEvent(event: Omit<RuntimeEvent, "tick" | "sequence">): void {
  const store = state();
  store.entries = store.entries.filter(entry => entry.tick <= Game.time && Game.time - entry.tick <= EVENT_TTL);
  const trim = Math.max(0, store.entries.length - RUNTIME_EVENT_CAPACITY + 1);
  if (trim) { store.entries.splice(0, trim); store.dropped += trim; }
  store.entries.push({ sequence: store.nextSequence++, tick: Game.time, kind: event.kind,
    owner: event.owner.slice(0, 32), id: event.id.slice(0, 96), from: event.from?.slice(0, 32), to: event.to?.slice(0, 32) });
}

/** cursor 被容量/TTL 淘汰时明确返回 gap，调用方须全量调和，不能当成“没有变化”。 */
export function readRuntimeEventsAfter(previous: number | RuntimeEventCursor): { gap: boolean; cursor: RuntimeEventCursor; entries: readonly RuntimeEvent[] } {
  const store = state();
  const initial = previous === 0;
  const currentEpoch = typeof previous === "object" && previous?.epoch === store.epoch &&
    Number.isSafeInteger(previous.sequence) && previous.sequence >= 0;
  // 旧数值游标无法区分 Memory 重置后的同序号，先要求全量调和，再改用带 epoch 的游标。
  const sequence = currentEpoch ? previous.sequence : 0;
  const entries = store.entries.filter(entry => entry.sequence > sequence);
  return { gap: !initial && !currentEpoch || sequence > store.nextSequence - 1 ||
      sequence < store.nextSequence - 1 && (entries[0]?.sequence ?? store.nextSequence) > sequence + 1,
    cursor: Object.freeze({ epoch: store.epoch, sequence: store.nextSequence - 1 }),
    entries: Object.freeze(entries.map(entry => Object.freeze({ ...entry }))) };
}
