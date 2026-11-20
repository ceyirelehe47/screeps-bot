import { isExitTile, isWalkableConstructionSite, isWalkableStructure, parseEncodedRouteRooms } from "@/movement/common";
import { cancelMoveIntent, getMoveIntentDestination, getMoveIntentReceipt, hasMoveDestinationConflict, issueMove, moveOffExit } from "@/movement/traffic";
import { moveToTarget, moveToTargetRoom } from "./shared";
import { claimSquadMovement } from "@/runtime/squads/squad";
import { warSquad } from "./warPartner";

const travel = { profile: "combat", routePurpose: "combat", plainCost: 2, swampCost: 8, ignoreCreeps: false } as const;
const reunion = { ...travel, maxRooms: 1, reusePath: 3 } as const;

function clearLanding(member: Creep, partner: Creep): void {
  if (isExitTile(member.pos)) moveOffExit(member, true, (_direction, tile) =>
    !hasMoveDestinationConflict(tile, [member]) && !tile.isEqualTo(partner.pos));
}

function hasLandingSpace(leader: Creep, tile: Readonly<{ x: number; y: number; roomName: string }>): boolean {
  const room = Game.rooms[tile.roomName];
  const terrain = Game.map.getRoomTerrain(tile.roomName);
  const open = (x: number, y: number): boolean => !(terrain.get(x, y) & TERRAIN_MASK_WALL)
    && !hasMoveDestinationConflict({ x, y, roomName: tile.roomName }, [leader])
    && (!room || !room.lookAt(x, y).some(look => look.creep || look.powerCreep || look.source || look.mineral || look.deposit
      || look.structure && !isWalkableStructure(look.structure)
      || look.constructionSite?.my && !isWalkableConstructionSite(look.constructionSite)));
  if (!open(tile.x, tile.y)) return false;
  for (let x = Math.max(1, tile.x - 1); x <= Math.min(48, tile.x + 1); x++) {
    for (let y = Math.max(1, tile.y - 1); y <= Math.min(48, tile.y + 1); y++) {
      if (open(x, y)) return true;
    }
  }
  return false;
}

function marchTravelOptions(leader: Creep) {
  const blocked = leader.memory._warBlockedExit;
  if (!blocked) return travel;
  if (blocked.room !== leader.room.name || Game.time >= blocked.until) {
    delete leader.memory._warBlockedExit;
    return travel;
  }
  return { ...travel, cacheKey: `war-exit:${blocked.room}:${blocked.x}:${blocked.y}`,
    costCallback: (room: string, matrix: CostMatrix) => {
      if (room === blocked.room) matrix.set(blocked.x, blocked.y, 255);
      return matrix;
    } };
}

/** 行军由一方选路，后排占用领队腾出的格子。跨房期间保存精确的原房出口。 */
export function runWarMarch(leader: Creep, follower: Creep, target: string, encodedRoute?: string): boolean {
  const squad = warSquad(leader, follower);
  // 首帧旧角色可能尚未登记反向搭档。只等待跨房，已在目标房时允许自身动作。
  if (!squad) return leader.room.name !== target || follower.room.name !== target;
  const crossing = leader.memory._warCrossing;
  const sameRoom = leader.room.name === follower.room.name;
  if (sameRoom && leader.room.name === target && !crossing) return false;
  if (sameRoom && leader.room.name === target && crossing && !isExitTile(leader.pos) && !isExitTile(follower.pos)) {
    delete leader.memory._warCrossing;
    return false;
  }
  if (!claimSquadMovement(squad)) return true;
  if (!sameRoom) {
    if (crossing && leader.room.name === crossing.to && follower.room.name === crossing.from) {
      clearLanding(leader, follower);
      const exit = new RoomPosition(crossing.x, crossing.y, crossing.from);
      if (isExitTile(follower.pos) && !follower.pos.isEqualTo(exit)) clearLanding(follower, leader);
      else if (follower.pos.isNearTo(exit)) {
        const direction = follower.pos.getDirectionTo(exit);
        if (direction) issueMove(follower, direction);
      } else moveToTarget(follower, exit, 0, reunion);
      return true;
    }
    // 恢复旧 Memory 或被挤散时，前方成员腾出边界并等候，避免双方互相换房。
    const rooms = parseEncodedRouteRooms(encodedRoute);
    const ahead = follower.room.name === target || (leader.room.name !== target && rooms.includes(leader.room.name)
      && rooms.indexOf(follower.room.name) > rooms.indexOf(leader.room.name));
    const waiting = ahead ? follower : leader, catchingUp = ahead ? leader : follower;
    clearLanding(waiting, catchingUp);
    const end = rooms.indexOf(waiting.room.name);
    const waypoints = end > 0 ? rooms.slice(0, end + 1).join("|") : undefined;
    moveToTargetRoom(catchingUp, waiting.room.name, waypoints, travel);
    return true;
  }
  if (crossing && leader.room.name === crossing.to && (isExitTile(leader.pos) || isExitTile(follower.pos))) {
    clearLanding(leader, follower);
    clearLanding(follower, leader);
    return true;
  }
  delete leader.memory._warCrossing;
  if (leader.room.name === target) return false;
  if (!leader.pos.isNearTo(follower.pos)) {
    clearLanding(leader, follower);
    moveToTarget(follower, leader, 1, reunion);
    return true;
  }
  if (leader.spawning || follower.spawning || leader.fatigue || follower.fatigue
      || !leader.getActiveBodyparts(MOVE) || !follower.getActiveBodyparts(MOVE)) return true;
  const previous = getMoveIntentReceipt(leader);
  moveToTargetRoom(leader, target, encodedRoute, marchTravelOptions(leader));
  const step = getMoveIntentReceipt(leader);
  if (!step || step === previous || !step.to || !step.attempted) return true;
  if (step.to.roomName !== step.from.roomName && !hasLandingSpace(leader, step.to)) {
    leader.memory._warBlockedExit = { room: step.from.roomName, x: step.attempted.x, y: step.attempted.y, until: Game.time + 5 };
    cancelMoveIntent(leader, step);
    return true;
  }
  const follow = follower.pos.getDirectionTo(leader.pos);
  const tail = follow && getMoveIntentDestination(follower.pos, follow);
  if (!tail || hasMoveDestinationConflict(tail, [leader, follower]) ||
      hasMoveDestinationConflict(step.to, [leader, follower]) || issueMove(follower, follow) !== OK) {
    cancelMoveIntent(leader, step);
    return true;
  }
  if (step.from.roomName !== step.to.roomName) {
    leader.memory._warCrossing = { from: step.from.roomName, to: step.to.roomName, x: step.attempted.x, y: step.attempted.y };
  }
  return true;
}
