import { requestCombatObservation } from "@/runtime/powerBankObserver";

const OWNERSHIP_REVIEW_TTL = 50_000;
const REVIEW_INTERVAL = 500;
const REVIEW_LIMIT = 3;
let nextReviewAt = 0;
let lastReviewedRoom = "";

/** 过期只触发复核；未知和仍有敌方控制权的房间继续禁止通行。 */
export function cleanupPowerBankRoomIntel(): void {
  const runtime = Memory.runtime;
  if (!runtime) return;
  const permanent = runtime.powerBankPermanentDangerRooms;
  const owned = runtime.powerBankOwnedRoomIntel;
  const rooms = [...new Set([...Object.keys(permanent ?? {}), ...Object.keys(owned ?? {})])].sort();
  for (const roomName of rooms) {
    const room = Game.rooms[roomName];
    if (!room) continue;
    const controller = room.controller;
    // 己方所有权或完全无主的原生视野，才足以撤销旧危险记录。
    // 敌方 reservation 仍保留，不能把“没有 owner”当成安全。
    if (controller?.my || (!controller?.owner && !controller?.reservation)) {
      if (permanent) delete permanent[roomName];
      if (owned) delete owned[roomName];
    }
  }
  if (Game.time < nextReviewAt - REVIEW_INTERVAL) nextReviewAt = 0;
  if (Game.time < nextReviewAt) return;
  nextReviewAt = Game.time + REVIEW_INTERVAL;
  const stale = rooms.filter(name => !Game.rooms[name] &&
    (permanent?.[name] || Game.time - (owned?.[name]?.lastSeenAt ?? Game.time) >= OWNERSHIP_REVIEW_TTL));
  const next = stale.findIndex(name => name > lastReviewedRoom);
  const rotated = next < 0 ? stale : [...stale.slice(next), ...stale.slice(0, next)];
  for (const name of rotated.slice(0, REVIEW_LIMIT)) {
    requestCombatObservation(name);
    lastReviewedRoom = name;
  }
}
