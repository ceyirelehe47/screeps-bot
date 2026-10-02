import type { TreasuryTerminalLane } from "@/runtime/treasuryTerminalLane";
interface Grant { lane: TreasuryTerminalLane; terminalId: string; amount: number; fee: number; }
let current: Grant | null = null;
/** Only the synchronous authorized adapter invocation opens this native boundary. */
export function withTreasuryTerminalNativeGrant<T>(grant: Grant, action: () => T): T {
  if (current !== null) throw new Error("nested Treasury native boundary");
  current = grant;
  try { return action(); } finally { current = null; }
}
export function treasuryTerminalNativeGrantAllows(room: string, actor: string): boolean {
  return current !== null && current.lane.sourceRoom === room && actor === `treasury:${current.lane.runId}`;
}
export function treasuryTerminalSendGrantAllows(terminal: StructureTerminal, resource: ResourceConstant, amount: number, fee: number, destination: string, actor: string): boolean {
  return current !== null && treasuryTerminalNativeGrantAllows(terminal.room.name, actor) &&
    terminal.id === current.terminalId && resource === current.lane.resource && amount === current.amount &&
    fee === current.fee && destination === current.lane.targetRoom;
}
