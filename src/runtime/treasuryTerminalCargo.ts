import { hasTreasuryTerminalFence } from "@/runtime/treasuryTaskCommitmentBridge";
import { recordTerminalCargoEffectThisTick } from "@/runtime/marketActionArbiter";
const LEGAL_NON_OK = new Set<number>([ERR_NOT_OWNER, ERR_NO_PATH, ERR_NAME_EXISTS, ERR_BUSY, ERR_NOT_FOUND,
  ERR_NOT_ENOUGH_RESOURCES, ERR_INVALID_TARGET, ERR_FULL, ERR_NOT_IN_RANGE, ERR_INVALID_ARGS,
  ERR_TIRED, ERR_NO_BODYPART, ERR_RCL_NOT_ENOUGH, ERR_GCL_NOT_ENOUGH]);
function terminalRoom(target: unknown): string | undefined {
  if (target === null || typeof target !== "object" || !("structureType" in target) || target.structureType !== STRUCTURE_TERMINAL) return undefined;
  const terminal = target as StructureTerminal;
  return terminal.room?.name ?? terminal.pos?.roomName;
}
export function isTerminalCargoBlocked(target: unknown): boolean {
  const room = terminalRoom(target); return room !== undefined && hasTreasuryTerminalFence(room);
}
/** 只包现役cargo native，不选择目标/改变计划；异常和非合约返回仍视为可能已改Store。 */
export function executeTreasuryFencedTerminalCargo(target: unknown, action: () => ScreepsReturnCode): ScreepsReturnCode {
  if (isTerminalCargoBlocked(target)) return ERR_BUSY;
  const room = terminalRoom(target);
  try {
    const code = action();
    if (room !== undefined && (code === OK || !LEGAL_NON_OK.has(code))) recordTerminalCargoEffectThisTick(room);
    return code;
  } catch (error) {
    if (room !== undefined) recordTerminalCargoEffectThisTick(room);
    throw error;
  }
}
