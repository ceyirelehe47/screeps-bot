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
export interface RuntimeEventState { nextSequence: number; dropped: number; entries: RuntimeEvent[] }
export const RUNTIME_EVENT_CAPACITY = 128;
const EVENT_TTL = 5000;
function state(): RuntimeEventState {
  const runtime = getMemoryService().ensureRuntime();
  const current = runtime.events;
  if (!current || !Array.isArray(current.entries) || !Number.isSafeInteger(current.nextSequence) || current.nextSequence < 1) {
    runtime.events = { nextSequence: 1, dropped: 0, entries: [] };
  }
  return runtime.events!;
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
export function readRuntimeEventsAfter(sequence: number): { gap: boolean; cursor: number; entries: readonly RuntimeEvent[] } {
  const store = state();
  const entries = store.entries.filter(entry => entry.sequence > sequence && entry.tick <= Game.time && Game.time - entry.tick <= EVENT_TTL);
  return { gap: sequence > store.nextSequence - 1 || sequence < store.nextSequence - 1 && (entries[0]?.sequence ?? store.nextSequence) > sequence + 1,
    cursor: store.nextSequence - 1, entries: Object.freeze(entries.map(entry => Object.freeze({ ...entry }))) };
}
