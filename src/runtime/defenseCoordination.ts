import { getMemoryService } from "@/runtime/runtimeServices";
import type { DefenseFront } from "@/runtime/defenseFronts";

export interface DefenseFrontSummary {
  id: string;
  hostileIds: string[];
  centroid: {
    x: number;
    y: number;
  };
  threatScore: number;
}

export interface RoomDefenseCoordination {
  fronts: DefenseFrontSummary[];
  towerFocusFrontId?: string;
  towerBurstTarget?: { tick: number; id: string };
  defenderAssignments?: Record<string, string>;
  defenderRoles?: Record<string, "primary" | "secondary">;
}

function ensureCoordinationStore(): Record<string, RoomDefenseCoordination> {
  const runtime = getMemoryService().ensureRuntime();
  runtime.defenseCoordination = runtime.defenseCoordination || {};
  return runtime.defenseCoordination;
}

function ensureRoomCoordination(roomName: string): RoomDefenseCoordination {
  const store = ensureCoordinationStore();
  store[roomName] = store[roomName] || { fronts: [], defenderAssignments: {} };
  store[roomName].fronts = store[roomName].fronts || [];
  store[roomName].defenderAssignments = store[roomName].defenderAssignments || {};
  store[roomName].defenderRoles = store[roomName].defenderRoles || {};
  return store[roomName];
}

export function getRoomDefenseCoordination(roomName: string): RoomDefenseCoordination | null {
  return Memory.runtime?.defenseCoordination?.[roomName] || null;
}

export function writeDefenseFronts(roomName: string, fronts: DefenseFront[]): void {
  const roomCoordination = ensureRoomCoordination(roomName);
  roomCoordination.fronts = fronts.map((front) => ({
    id: front.id,
    hostileIds: [...front.hostileIds],
    centroid: front.centroid,
    threatScore: front.threatScore,
  }));

  const validFrontIds = new Set(roomCoordination.fronts.map((front) => front.id));
  const assignments = roomCoordination.defenderAssignments || {};
  for (const slot of Object.keys(assignments)) {
    if (!validFrontIds.has(assignments[slot])) {
      delete assignments[slot];
    }
  }

  const roles = roomCoordination.defenderRoles || {};
  for (const slot of Object.keys(roles)) {
    if (!assignments[slot]) {
      delete roles[slot];
    }
  }

  if (roomCoordination.towerFocusFrontId && !validFrontIds.has(roomCoordination.towerFocusFrontId)) {
    delete roomCoordination.towerFocusFrontId;
  }
}

export function setTowerFocusFront(roomName: string, frontId: string | undefined): void {
  const roomCoordination = ensureRoomCoordination(roomName);
  if (frontId) {
    roomCoordination.towerFocusFrontId = frontId;
  } else {
    delete roomCoordination.towerFocusFrontId;
  }
}

export function assignDefenderSlot(roomName: string, slot: string, frontId: string | undefined): void {
  const roomCoordination = ensureRoomCoordination(roomName);
  if (!frontId) {
    delete roomCoordination.defenderAssignments?.[slot];
    delete roomCoordination.defenderRoles?.[slot];
    return;
  }

  roomCoordination.defenderAssignments = roomCoordination.defenderAssignments || {};
  roomCoordination.defenderAssignments[slot] = frontId;
}

export function setDefenderRole(roomName: string, slot: string, role: "primary" | "secondary" | undefined): void {
  const roomCoordination = ensureRoomCoordination(roomName);
  if (!role) {
    delete roomCoordination.defenderRoles?.[slot];
    return;
  }

  roomCoordination.defenderRoles = roomCoordination.defenderRoles || {};
  roomCoordination.defenderRoles[slot] = role;
}

export function getDefenderRole(roomName: string, slot: string | undefined): "primary" | "secondary" | null {
  if (!slot) {
    return null;
  }

  return Memory.runtime?.defenseCoordination?.[roomName]?.defenderRoles?.[slot] || null;
}

export function getAssignedDefenseFront(roomName: string, slot: string | undefined): DefenseFrontSummary | null {
  if (!slot) {
    return null;
  }

  const roomCoordination = getRoomDefenseCoordination(roomName);
  if (!roomCoordination) {
    return null;
  }

  const frontId = roomCoordination.defenderAssignments?.[slot];
  if (!frontId) {
    return null;
  }

  return roomCoordination.fronts.find((front) => front.id === frontId) || null;
}

export function getTowerFocusFront(roomName: string): DefenseFrontSummary | null {
  const roomCoordination = getRoomDefenseCoordination(roomName);
  if (!roomCoordination?.towerFocusFrontId) {
    return null;
  }

  return roomCoordination.fronts.find((front) => front.id === roomCoordination.towerFocusFrontId) || null;
}

export function clearDefenseCoordination(roomName: string): void {
  if (!Memory.runtime?.defenseCoordination?.[roomName]) {
    return;
  }

  delete Memory.runtime.defenseCoordination[roomName];
  if (Object.keys(Memory.runtime.defenseCoordination).length === 0) {
    delete Memory.runtime.defenseCoordination;
  }
}

export function setTowerBurstTarget(roomName: string, id?: string): void {
  const state = ensureRoomCoordination(roomName);
  state.towerBurstTarget = id ? { tick: Game.time, id } : undefined;
}
export function getTowerBurstTarget(roomName: string): string | undefined {
  const target = getRoomDefenseCoordination(roomName)?.towerBurstTarget;
  return target?.tick === Game.time ? target.id : undefined;
}
