let snapshot: { tick: number; flags: typeof Game.flags; flagCount: number; rooms: Set<string> } | undefined;
export function invalidateRoomReserveCache(): void { snapshot = undefined; }
export function isRoomInReserveMode(roomName: string): boolean {
  const flagCount = Object.keys(Game.flags).length;
  if (!snapshot || snapshot.tick !== Game.time || snapshot.flags !== Game.flags || snapshot.flagCount !== flagCount) {
    snapshot = { tick: Game.time, flags: Game.flags, flagCount, rooms: new Set(Object.values(Game.flags)
      .filter(flag => flag.name === "RESERVE" || flag.name.startsWith("RESERVE_"))
      .map(flag => flag.pos.roomName)) };
  }
  return snapshot.rooms.has(roomName);
}
