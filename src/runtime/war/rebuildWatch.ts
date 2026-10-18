import { isDue } from "@/runtime/cadence";
import { getCreepConfigService, getMemoryService, getTickContextService } from "@/runtime/runtimeServices";
import { requestCombatObservation, OBSERVATION_REQUEST_TTL } from "@/runtime/powerBankObserver";
import type { WarTask } from "./store";
import { requestWarRoomClear } from "./api";
import { warOffset } from "./store";

export function runWarRebuildWatches(store: Record<string, WarTask>): void {
  const configs = Memory.cfg?.warRebuildWatch;
  if (!configs || Object.keys(configs).length === 0) return;
  const runtime = getMemoryService().ensureRuntime();
  runtime.warRebuildWatch ??= {};
  for (const id of Object.keys(runtime.warRebuildWatch)) if (!configs[id]) delete runtime.warRebuildWatch[id];
  for (const [id, config] of Object.entries(configs)) {
    const state = runtime.warRebuildWatch[id] ??= { clearedRooms: [], targets: {} };
    const targets = [...new Set(config.targetRooms)];
    for (const name of targets) {
      if (store[name]?.sourceRoom !== config.sourceRoom || (store[name].status !== "done" && store[name].combatClearedAt === undefined)
        || state.clearedRooms.includes(name)) continue;
      state.clearedRooms.push(name);
      // 清场完成帧已有的残留实体是基线；失去视野时，已确认清空的结果仍保留。
      const target = state.targets[name] ??= {};
      target.lastTriggeredEvidenceIds ??= Game.rooms[name] ? getWarRebuildEvidence(Game.rooms[name], config.enemyUsername)
        .filter(item => !item.startsWith("creep:")) : [];
    }
    // 每房完成记录独立于短期War任务，避免200tick终态清理丢掉首轮成果。
    if (state.armedAt === undefined) {
      if (targets.length === 0 || !targets.every((name) => state.clearedRooms.includes(name))) continue;
      state.armedAt = Game.time;
    }
    for (const name of targets) {
      const target = state.targets[name] ??= {};
      const task = store[name];
      if (!Game.rooms[config.sourceRoom]?.controller?.my) { target.blocker = "source_not_owned"; continue; }
      if (Game.rooms[name]?.controller?.my) { target.blocker = "target_owned"; continue; }
      if (task && task.status !== "done" && task.status !== "failed" && task.combatClearedAt === undefined) { target.blocker = "clear_active"; delete target.pendingObservationAt; continue; }
      if (task?.status === "failed" || target.blocker === "clear_failed") { target.blocker = "clear_failed"; continue; }
      const interval = Math.max(1, Math.floor(config.intervalTicks));
      if (target.pendingObservationAt === undefined) {
        if (Game.time < (target.nextObservationAt ?? Game.time)) continue;
        if (Game.cpu?.bucket < 2000 && !isDue(`war.rebuild:${name}`, 10, Game.time, warOffset(name, 10))) continue;
        target.nextObservationAt = Game.time + interval;
        if (!requestCombatObservation(name)) { target.blocker = "observer_unavailable"; continue; }
        target.pendingObservationAt = Game.time;
        target.blocker = "awaiting_vision";
        continue;
      }
      const room = Game.rooms[name];
      if (!room) {
        if (Game.time - target.pendingObservationAt > OBSERVATION_REQUEST_TTL) { delete target.pendingObservationAt; target.blocker = "observer_timeout"; }
        continue;
      }
      target.lastSeenAt = Game.time;
      delete target.pendingObservationAt;
      target.blocker = undefined;
      if (room.controller?.owner && room.controller.owner.username !== config.enemyUsername) { target.blocker = "target_owner_changed"; continue; }
      // 控制器归属本身不是重建。观察到对手creep或新造的实体/工地才启动。
      const evidence = getWarRebuildEvidence(room, config.enemyUsername);
      // 手动结束首轮任务或旧监视状态没有基线时，首次观察只登记旧建筑/工地。
      // 对方 creep 仍是即时重建证据，不能因首次扫描而吞掉。
      const previous = new Set(target.lastTriggeredEvidenceIds ?? evidence.filter(item => !item.startsWith("creep:")));
      const newEvidence = evidence.some((item) => !previous.has(item));
      target.lastTriggeredEvidenceIds = evidence;
      // 减少旧证据不是重建；例如creep已被击杀，但其工地仍残留。
      if (!newEvidence) continue;
      requestWarRoomClear(name, config.sourceRoom, { reason: "manual", npcAuto: true, oneShot: false });
      // 补剿处理新入侵者/新建筑，旧空墙与被动设施不要求再拆一轮。
      // 挡住实际目标的墙仍由角色的通用破障路径处理。
      store[name].rebuildIgnoreStructureIds = [...new Set([
        ...[...previous].filter(item => item.startsWith("structure:")).map(item => item.slice("structure:".length)),
        ...room.find(FIND_STRUCTURES).filter(s => s.structureType === STRUCTURE_WALL).map(s => s.id),
      ])];
      target.lastTriggeredAt = Game.time;
      target.triggerCount = (target.triggerCount ?? 0) + 1;
      target.blocker = "clear_active";
    }
  }
}

export function getWarRebuildEvidence(room: Room, enemyUsername: string): string[] {
  return [
    ...room.find(FIND_HOSTILE_CREEPS).filter(c => c.owner.username === enemyUsername).map(c => `creep:${c.id}`),
    ...room.find(FIND_HOSTILE_CONSTRUCTION_SITES).filter(s => s.owner.username === enemyUsername).map(s => `site:${s.id}`),
    ...room.find(FIND_HOSTILE_STRUCTURES).filter(s => s.structureType !== STRUCTURE_CONTROLLER
      && s.structureType !== STRUCTURE_KEEPER_LAIR && "owner" in s && (s as OwnedStructure).owner?.username === enemyUsername).map(s => `structure:${s.id}`),
  ].sort();
}
