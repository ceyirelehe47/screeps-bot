let snapshot: { tick: number; flags: typeof Game.flags; flagCount: number; rooms: Set<string> } | undefined;
let automatic: { game: typeof Game; tick: number; flags: typeof Game.flags; decisions: Map<string, string | null> } | undefined;
function automaticDecisions(): Map<string, string | null> {
  if (!automatic || automatic.game !== Game || automatic.tick !== Game.time || automatic.flags !== Game.flags) {
    automatic = { game: Game, tick: Game.time, flags: Game.flags, decisions: new Map() };
  }
  return automatic.decisions;
}
/** 旗帜 intent 未反映到 Game.flags 时，经济决策仍在本 tick 立即一致。 */
export function recordAutomaticReserveFlag(flagName: string, roomName: string | null): void {
  automaticDecisions().set(flagName, roomName);
  invalidateRoomReserveCache();
}
export function invalidateRoomReserveCache(): void { snapshot = undefined; }
export function isRoomInReserveMode(roomName: string): boolean {
  const flagCount = Object.keys(Game.flags).length;
  if (!snapshot || snapshot.tick !== Game.time || snapshot.flags !== Game.flags || snapshot.flagCount !== flagCount) {
    const decisions = automaticDecisions();
    const rooms = Object.values(Game.flags)
      .filter(flag => (flag.name === "RESERVE" || flag.name.startsWith("RESERVE_")) && !decisions.has(flag.name))
      .map(flag => flag.pos.roomName);
    for (const room of decisions.values()) if (room) rooms.push(room);
    snapshot = { tick: Game.time, flags: Game.flags, flagCount, rooms: new Set(rooms) };
  }
  return snapshot.rooms.has(roomName);
}
