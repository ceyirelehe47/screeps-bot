jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(() => OK),
  moveToTargetRoom: jest.fn(() => OK),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepDecision: (fn: () => any) => fn(),
  measureCreepIntent: (fn: () => any) => fn(),
}));

import { moveToTarget } from "@/roles/shared";
import { remoteDefenderRole } from "@/roles/remoteDefender";
import { createMockPowerBankCreep, MockPos } from "@mock/powerBank";
import type { RemoteMiningTask, RemoteDefenseReason } from "@/runtime/remoteMining";

const SOURCE_ROOM = "W1N1";
const TARGET_ROOM = "W2N1";
const CONFIG_NAME = `${SOURCE_ROOM}:remoteMine:${TARGET_ROOM}:defender:0`;

function makeCreep(overrides: {
  x?: number;
  y?: number;
  roomName?: string;
  hits?: number;
  hitsMax?: number;
  body?: Array<{ type: BodyPartConstant; hits: number }>;
  memory?: Record<string, unknown>;
} = {}) {
  const body = overrides.body ?? [
    ...Array.from({ length: 5 }, () => ({ type: RANGED_ATTACK as BodyPartConstant, hits: 100 })),
    ...Array.from({ length: 3 }, () => ({ type: HEAL as BodyPartConstant, hits: 100 })),
    ...Array.from({ length: 8 }, () => ({ type: MOVE as BodyPartConstant, hits: 100 })),
  ];
  const hitsMax = overrides.hitsMax ?? body.reduce((s, p) => s + p.hits, 0);
  return createMockPowerBankCreep("remoteDefender", {
    x: overrides.x ?? 25,
    y: overrides.y ?? 25,
    roomName: overrides.roomName ?? TARGET_ROOM,
    hits: overrides.hits ?? hitsMax,
    hitsMax,
    body,
    memory: {
      role: "remoteDefender",
      configName: CONFIG_NAME,
      ...overrides.memory,
    },
  });
}

function makeHostile(overrides: {
  id?: string;
  name?: string;
  x?: number;
  y?: number;
  username?: string;
  body?: Array<{ type: BodyPartConstant; hits: number }>;
} = {}) {
  const x = overrides.x ?? 25;
  const y = overrides.y ?? 25;
  const body = overrides.body ?? [
    { type: ATTACK as BodyPartConstant, hits: 100 },
    { type: MOVE as BodyPartConstant, hits: 100 },
  ];
  return {
    id: (overrides.id ?? overrides.name ?? "hostile-0") as Id<Creep>,
    name: overrides.name ?? "hostile-0",
    pos: new MockPos(x, y, TARGET_ROOM) as unknown as RoomPosition,
    room: { name: TARGET_ROOM } as Room,
    body,
    hits: body.reduce((s, p) => s + p.hits, 0),
    hitsMax: body.reduce((s, p) => s + p.hits, 0),
    owner: { username: overrides.username ?? "Invader" },
    my: false,
    getActiveBodyparts: jest.fn((part: BodyPartConstant) => body.filter((p) => p.type === part && p.hits > 0).length),
  } as unknown as Creep;
}


function makeHostileStructure(overrides: {
  id?: string;
  type?: StructureConstant;
  x?: number;
  y?: number;
  username?: string;
  level?: number;
} = {}): Structure {
  const structureType = overrides.type ?? STRUCTURE_INVADER_CORE;
  return {
    id: (overrides.id ?? `structure-${structureType}`) as Id<Structure>,
    structureType,
    pos: new MockPos(overrides.x ?? 27, overrides.y ?? 25, TARGET_ROOM) as unknown as RoomPosition,
    room: { name: TARGET_ROOM } as Room,
    owner: { username: overrides.username ?? (structureType === STRUCTURE_INVADER_CORE ? "Invader" : "Player1") },
    hits: 100_000,
    hitsMax: 100_000,
    level: overrides.level ?? 0,
  } as unknown as Structure;
}

function setupTask(defenseReason?: RemoteDefenseReason): RemoteMiningTask {
  return {
    sourceRoom: SOURCE_ROOM,
    targetRoom: TARGET_ROOM,
    status: defenseReason ? "defending" : "active",
    sourceIds: ["source-0", "source-1"],
    assignedAt: 100,
    updatedAt: 100,
    defenseReason,
  };
}

function setupMemory(task?: RemoteMiningTask) {
  if (!Memory.data) (Memory as any).data = {};
  if (!Memory.data.remoteMining) Memory.data.remoteMining = {};
  if (task) {
    Memory.data.remoteMining[TARGET_ROOM] = task;
  }
}

describe("remoteDefenderRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Game.time = 100;
    (Memory as any).data = {};
    (global as any).RoomPosition = MockPos;
    setupMemory(setupTask("npc_invader"));
  });

  describe("combat actions", () => {

    it("uses rangedAttack on single target when fewer than 3 hostiles in range", () => {
      const hostile = makeHostile({
        id: "h0", username: "Invader", x: 26, y: 25,
      });

      const creep = makeCreep();
      (creep.room as any).find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return [hostile];
        return [];
      });

      const role = remoteDefenderRole(TARGET_ROOM);
      role.target(creep);

      expect(creep.rangedAttack).toHaveBeenCalledWith(hostile);
      expect(creep.rangedMassAttack).not.toHaveBeenCalled();
    });

    function engage(hostiles: Creep[], structures: Structure[] = []) {
      const creep = makeCreep();
      creep.room.find = jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) return hostiles;
        if (type === FIND_STRUCTURES) return structures;
        return [];
      }) as Room["find"];
      remoteDefenderRole(TARGET_ROOM).target(creep);
      return creep;
    }

    it("focuses one of three enemies at range three", () => {
      const hostiles = [22, 25, 28].map(y => makeHostile({ x: 28, y }));
      const creep = engage(hostiles);
      expect(creep.rangedAttack).toHaveBeenCalledWith(hostiles[0]);
      expect(creep.rangedMassAttack).not.toHaveBeenCalled();
    });

    it("uses mass attack against two adjacent enemies", () => {
      const creep = engage([makeHostile({ x: 26 }), makeHostile({ y: 26 })]);
      expect(creep.rangedMassAttack).toHaveBeenCalledTimes(1);
    });

    it("fires at a reachable enemy while advancing toward a distant healer", () => {
      const healer = makeHostile({ x: 32, body: [{ type: HEAL, hits: 100 }] });
      const nearby = makeHostile({ x: 28 });
      const creep = engage([healer, nearby]);
      expect(creep.rangedAttack).toHaveBeenCalledWith(nearby);
      expect(moveToTarget).toHaveBeenCalledWith(creep, healer, 3, expect.any(Object));
    });

    it("keeps single fire when mass attack would hit an uninvolved unit or structure", () => {
      const invaders = [makeHostile({ x: 26 }), makeHostile({ y: 26 })];
      const neutral = makeHostile({ y: 28, username: "OtherPlayer" });
      expect(engage([...invaders, neutral]).rangedMassAttack).not.toHaveBeenCalled();
      const tower = makeHostileStructure({ type: STRUCTURE_TOWER, x: 26, y: 25 });
      expect(engage(invaders, [tower]).rangedMassAttack).not.toHaveBeenCalled();
    });

    it("keeps escort fire single-target during Invader Core clearance", () => {
      setupMemory(setupTask("npc_invader_core"));
      const creep = engage([makeHostile({ x: 26 }), makeHostile({ y: 26 }), makeHostile({ x: 24 })]);
      expect(creep.rangedMassAttack).not.toHaveBeenCalled();
      expect(creep.rangedAttack).toHaveBeenCalledTimes(1);
    });

    it("uses single-target ranged attack on the Invader Core and ignores player structures", () => {
      setupMemory(setupTask("npc_invader_core"));
      const core = makeHostileStructure({ id: "core-0", x: 27, y: 25 }) as StructureInvaderCore;
      const playerTower = makeHostileStructure({
        id: "player-tower", type: STRUCTURE_TOWER, x: 26, y: 25, username: "Player1",
      });
      const structures = [playerTower, core];
      const creep = makeCreep();
      (creep.room as any).find = jest.fn((type: number, opts?: { filter?: (target: any) => boolean }) => {
        if (type === FIND_HOSTILE_CREEPS) return [];
        if (type === FIND_HOSTILE_STRUCTURES) {
          return opts?.filter ? structures.filter(opts.filter) : structures;
        }
        return [];
      });

      remoteDefenderRole(TARGET_ROOM).target(creep);

      expect(creep.rangedAttack).toHaveBeenCalledWith(core);
      expect(creep.rangedAttack).not.toHaveBeenCalledWith(playerTower);
      expect(creep.rangedMassAttack).not.toHaveBeenCalled();
    });
  });
});
