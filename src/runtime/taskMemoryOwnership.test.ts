import { registerTaskMemoryOwners } from "@/runtime/registerTaskMemoryOwners";
import { runRegisteredMemoryGc } from "@/runtime/memoryGcRegistry";
import { cleanupCrossShardColonizationTasks } from "@/runtime/crossShardColonization";
import { cleanupDepositDiscoveryTasks, recordDepositDiscovery } from "@/runtime/depositDiscovery";
import { resetRuntimeServices } from "@mock/movement";
import type { DepositHarvestTask } from "@/runtime/depositHarvest";

beforeEach(() => {
  resetRuntimeServices(); registerTaskMemoryOwners(); Game.time = 20000;
  Game.creeps = {}; Game.spawns = {}; Game.rooms = {}; Memory.creeps = {}; Memory.data = {}; Memory.runtime = {};
});

it("中央与 owner GC 共用活体/出生保护，crossShard 终态仅在引用消失后删除", () => {
  const config = "W1N1:cross-shard:old";
  Memory.data!.crossShardColonization = { old: { targetShard: "shard2", targetRoom: "W0N1", sourceRoom: "lost",
    status: "completed", flagName: "CLX", createdAt: 1, updatedAt: 1, completedAt: 1, claimerConfigName: config } };
  Game.creeps.actor = { name: "actor", memory: { configName: config } } as Creep;
  expect(runRegisteredMemoryGc({ ownedRooms: new Set() })).toBe(0);
  expect(Memory.data!.crossShardColonization!.old).toBeDefined();
  Game.creeps = {};
  Game.spawns.S = { spawning: { name: "born" } } as StructureSpawn;
  Memory.creeps.born = { role: "crossShardClaimer", configName: config };
  expect(cleanupCrossShardColonizationTasks()).toBe(0);
  Game.spawns = {};
  expect(runRegisteredMemoryGc({ ownedRooms: new Set() })).toBe(1);
  expect(Memory.data!.crossShardColonization!.old).toBeUndefined();
});

it("claimed/in_transit/blocked 不因中央 TTL 或母房丢失而越权删除", () => {
  Memory.data!.crossShardColonization = Object.fromEntries((["claimed", "in_transit", "blocked"] as const).map(status => [status, {
    targetShard: "shard2", targetRoom: "W0N1", sourceRoom: "lost", status, flagName: "CLX", createdAt: 1, updatedAt: 1,
  }]));
  expect(runRegisteredMemoryGc({ ownedRooms: new Set() })).toBe(0);
  expect(Object.keys(Memory.data!.crossShardColonization!)).toHaveLength(3);
});

it("发现时的容量清理也保护 Deposit 在途货物，与中央 GC 使用同一删除规则", () => {
  const old = { id: "old", status: "complete", expiresAt: 1, configName: "deposit-old" } as DepositHarvestTask;
  Memory.data!.depositHarvest = { old };
  Game.creeps.actor = { name: "actor", memory: { taskId: "old" } } as unknown as Creep;
  recordDepositDiscovery({ id: "new", pos: { roomName: "W0N1", x: 20, y: 20 }, depositType: RESOURCE_METAL,
    ticksToDecay: 100, cooldown: 0, lastCooldown: 0 } as unknown as Deposit);
  expect(Memory.data!.depositHarvest!.old).toBe(old);
  expect(cleanupDepositDiscoveryTasks()).toBe(0);
  Game.creeps = {};
  expect(runRegisteredMemoryGc({ ownedRooms: new Set() })).toBe(1);
  expect(Memory.data!.depositHarvest!.old).toBeUndefined();
  expect(Memory.data!.depositHarvest!.new).toBeDefined();
});
