import { isInvaderSalvageTransitAllowed, isInvaderSalvageRoomClear, isInvaderSalvagePositionSafe, invaderSalvageRouteCost } from "@/runtime/invaderSalvageSafety";

describe("INVADER 搬运使用实际房间与位置威胁", () => {
  beforeEach(() => { Game.rooms = {}; });
  function world(structures: Structure[] = [], hostiles: Creep[] = []) {
    const room = { name: "W3N7", controller: { reservation: { username: "Invader", ticksToEnd: 5000 } },
      find: (type: FindConstant) => type === FIND_STRUCTURES ? structures : type === FIND_HOSTILE_CREEPS ? hostiles : [] } as unknown as Room;
    Game.rooms[room.name] = room;
    return room;
  }
  const pos = (x: number, y: number) => ({ x, y, roomName: "W3N7" }) as RoomPosition;
  it("单 Core 没有直接攻击威胁，通路可用，生产仍等 Core 清空", () => {
    const room = world([{ structureType: STRUCTURE_INVADER_CORE, pos: pos(20, 20) } as Structure]);
    expect(isInvaderSalvageTransitAllowed(room)).toBe(true);
    expect(invaderSalvageRouteCost(room.name, "W3N6")).toBe(1);
    expect(isInvaderSalvageRoomClear(room)).toBe(false);
  });
  it.each([ATTACK, RANGED_ATTACK])("%s 的实际攻击范围约束落点，数量不会整房禁行", part => {
    const room = world([], [{ owner: { username: "Invader" }, pos: pos(25, 25), getActiveBodyparts: (p: BodyPartConstant) => p === part ? 1 : 0 } as unknown as Creep]);
    const radius = part === ATTACK ? 3 : 5;
    expect(isInvaderSalvageTransitAllowed(room)).toBe(true);
    expect(isInvaderSalvagePositionSafe(room, pos(25 + radius, 25))).toBe(false);
    expect(isInvaderSalvagePositionSafe(room, pos(26 + radius, 25))).toBe(true);
  });
  it("WORK 和 HEAL 不构成搬运者的直接攻击威胁", () => {
    const room = world([], [{ owner: { username: "Invader" }, pos: pos(25, 25), getActiveBodyparts: (p: BodyPartConstant) => p === WORK || p === HEAL ? 10 : 0 } as unknown as Creep]);
    expect(isInvaderSalvagePositionSafe(room, pos(25, 25))).toBe(true);
  });
  it("未知攻击位置、能发射的塔、其它玩家所有权仍拒绝通路", () => {
    const unknown = world([], [{ owner: { username: "Invader" }, getActiveBodyparts: () => 1 } as unknown as Creep]);
    expect(isInvaderSalvageTransitAllowed(unknown)).toBe(false);
    const tower = world([{ structureType: STRUCTURE_TOWER, my: false, store: { getUsedCapacity: () => 10 } } as unknown as StructureTower]);
    expect(isInvaderSalvageTransitAllowed(tower)).toBe(false);
    const owned = world(); owned.controller!.owner = { username: "other-player" };
    expect(isInvaderSalvageTransitAllowed(owned, owned.name)).toBe(false);
    expect(isInvaderSalvageTransitAllowed(undefined)).toBe(false);
  });
  it.each(["owner", "reservation", "no_invader_evidence"] as const)("%s 不能仅凭INVADER名称被当成回收目标", kind => {
    const room = world();
    if (kind === "owner") room.controller = { owner: { username: "TooAngel" } } as StructureController;
    else if (kind === "reservation") room.controller!.reservation = { username: "another-player", ticksToEnd: 5000 };
    else room.controller = undefined;
    expect(isInvaderSalvageRoomClear(room)).toBe(false);
  });
  it.each(["core_ruin", "invader_tombstone"] as const)("Core已销毁后，空的%s仍证明同房NPC遗产资格", kind => {
    const room = world(); room.controller = undefined;
    const proof = kind === "core_ruin"
      ? { structure: { structureType: STRUCTURE_INVADER_CORE }, store: { getUsedCapacity: () => 0 } }
      : { creep: { owner: { username: "Invader" } }, store: { getUsedCapacity: () => 0 } };
    room.find = ((type: FindConstant) => type === (kind === "core_ruin" ? FIND_RUINS : FIND_TOMBSTONES) ? [proof] : []) as Room["find"];
    expect(isInvaderSalvageRoomClear(room)).toBe(true);
    room.controller = { owner: { username: "TooAngel" } } as StructureController;
    expect(isInvaderSalvageRoomClear(room)).toBe(false);
  });
});
