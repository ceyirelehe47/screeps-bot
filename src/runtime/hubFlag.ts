import { getDefaultHubConfig, getDefaultHubRuntime } from "@/runtime/hubPlanner";

export function runHubByFlag(): void {
  const flag = Game.flags["HUB"];
  if (!flag) return;

  const roomName = flag.pos.roomName;
  const room = Game.rooms[roomName];

  const existingHubRoom = Memory.cfg?.hub?.hubRoomName;
  if (!room?.controller?.my || existingHubRoom && existingHubRoom !== roomName) {
    console.log(`[hub] flag rejected: ${roomName} reason=invalid_or_conflicting_room`);
    flag.remove();
    return;
  }

  const defaults = getDefaultHubConfig();
  const existing = Memory.cfg?.hub ?? {};

  Memory.cfg ??= {};
  Memory.cfg.hub = { ...defaults, ...existing, enabled: true, hubRoomName: roomName };
  Memory.runtime ??= {};
  Memory.runtime.hub = { ...getDefaultHubRuntime(), ...Memory.runtime.hub, needsPlan: true };


  flag.remove();
}
