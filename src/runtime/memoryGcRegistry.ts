import { runIsolatedRoomOperation } from "@/runtime/runtimeIsolation";

export interface MemoryGcContext { ownedRooms: ReadonlySet<string> }
export interface MemoryGcOwner { id: string; cleanup(context: MemoryGcContext): number }
const owners = new Map<string, MemoryGcOwner>();

export function registerMemoryGcOwner(owner: MemoryGcOwner): void {
  const current = owners.get(owner.id);
  if (current && current !== owner) throw new Error(`duplicate memory GC owner: ${owner.id}`);
  owners.set(owner.id, owner);
}

/** 清理规则属于子树所有者；一个 owner 故障不能阻断其他子树清理。 */
export function runRegisteredMemoryGc(context: MemoryGcContext): number {
  let removed = 0;
  for (const owner of owners.values()) {
    removed += runIsolatedRoomOperation("memoryGc", owner.id, () => owner.cleanup(context)) ?? 0;
  }
  return removed;
}
