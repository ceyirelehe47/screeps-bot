/**
 * RoleLifecycle 缓存回归测试（任务书阶段 D1）：
 * 同 config 的 factory 只执行一次并跨 tick 复用；
 * config 变更/删除、fallback memory role、cross-shard 恢复均正确失效。
 */
import { mountCreep } from "@/mount/mountCreep";
import { clearRoleLifecycleCacheForTest, getRoleLifecycleCacheSizeForTest } from "@/mount/mountCreep";
import { getCreepConfigService } from "@/runtime/runtimeServices";
import { clearCreepMovementStateForTest } from "@/movement/creepState";
import { clearMovementAnalyticsForTest, getMovementAnalyticsForTest } from "@/movement/metrics";
import type { RoleName } from "@/types/system";

jest.mock("@/roles", () => {
  const factoryCallCounts: Record<string, number> = {};
  const makeFactory = (role: string) => (jest.fn((...args: string[]) => {
    factoryCallCounts[role] = (factoryCallCounts[role] ?? 0) + 1;
    return {
      prepare: undefined,
      source: jest.fn((): boolean => false),
      target: jest.fn((): boolean => false),
      _role: role,
      _args: args,
    };
  }));
  return {
    roleRegistry: {
      worker: makeFactory("worker"),
      upgrader: makeFactory("upgrader"),
      crossShardClaimer: makeFactory("crossShardClaimer"),
    },
    __factoryCallCounts: factoryCallCounts,
  };
});

jest.mock("@/roles/shared", () => ({
  clearMovementState: jest.fn(),
}));

const { roleRegistry } = jest.requireMock("@/roles") as {
  roleRegistry: Record<string, jest.Mock>;
};
const { __factoryCallCounts } = jest.requireMock("@/roles") as {
  __factoryCallCounts: Record<string, number>;
};

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
  Creep: typeof Creep;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function installCreepPrototype(): void {
  class CreepMock {}
  (global as RuntimeGlobal).Creep = CreepMock as unknown as typeof Creep;
}

function createCreep(name: string, memory: Partial<CreepMemory>): Creep {
  return {
    name,
    room: { name: "W1N1" } as Room,
    pos: { x: 10, y: 10, roomName: "W1N1" } as unknown as RoomPosition,
    memory: { ...memory } as CreepMemory,
    move: jest.fn(() => OK),
    say: jest.fn(),
  } as unknown as Creep;
}

function work(creep: Creep): void {
  (Creep.prototype as unknown as { work: () => void }).work.call(creep);
}

describe("role lifecycle cache", () => {
  beforeEach(() => {
    installCreepPrototype();
    resetRuntimeServices();
    clearRoleLifecycleCacheForTest();
    clearCreepMovementStateForTest();
    clearMovementAnalyticsForTest();
    Game.time += 1;
    Game.creeps = {};
    Game.rooms = {};
    Memory.data = undefined;
    for (const factory of Object.values(roleRegistry)) {
      factory.mockClear();
    }
    for (const role of Object.keys(__factoryCallCounts)) {
      delete __factoryCallCounts[role];
    }
    mountCreep();
  });

  function installConfig(configName: string, role: RoleName, args: string[]): void {
    getCreepConfigService().upsert(configName, role, args);
  }

  it("两个 creep 使用同一 config 时 factory 只执行一次", () => {
    installConfig("W1N1:worker:1", "worker", ["arg-a"]);
    const first = createCreep("creep-one", { configName: "W1N1:worker:1" });
    const second = createCreep("creep-two", { configName: "W1N1:worker:1" });

    work(first);
    work(second);

    expect(__factoryCallCounts.worker).toBe(1);
    expect(roleRegistry.worker).toHaveBeenCalledTimes(1);
    expect(roleRegistry.worker).toHaveBeenCalledWith("arg-a");
    // 诊断计数器：一次 factory 创建 + 一次缓存命中（第二个 creep）。
    const totals = getMovementAnalyticsForTest().totals;
    expect(totals.roleFactoryCreates).toBe(1);
    expect(totals.roleLifecycleCacheHits).toBe(1);
  });

  it("下一 tick 配置未变化时仍复用", () => {
    installConfig("W1N1:worker:1", "worker", ["arg-a"]);
    const creep = createCreep("creep-one", { configName: "W1N1:worker:1" });

    work(creep);
    Game.time += 1;
    work(creep);
    Game.time += 1;
    work(creep);

    expect(__factoryCallCounts.worker).toBe(1);
  });

  it("config role/args 改变后会重新创建", () => {
    installConfig("W1N1:worker:1", "worker", ["arg-a"]);
    const creep = createCreep("creep-one", { configName: "W1N1:worker:1" });
    work(creep);
    expect(__factoryCallCounts.worker).toBe(1);

    // upsert 内容变化会替换 config 对象 → 缓存失效。
    getCreepConfigService().upsert("W1N1:worker:1", "upgrader" as RoleName, ["arg-b"]);
    work(creep);
    expect(__factoryCallCounts.upgrader).toBe(1);
    expect(roleRegistry.upgrader).toHaveBeenCalledWith("arg-b");

    getCreepConfigService().upsert("W1N1:worker:1", "upgrader" as RoleName, ["arg-c"]);
    work(creep);
    expect(__factoryCallCounts.upgrader).toBe(2);
  });

  it("config 删除后不会错误复用旧 lifecycle", () => {
    installConfig("W1N1:worker:1", "worker", ["arg-a"]);
    const creep = createCreep("creep-one", { configName: "W1N1:worker:1" });
    work(creep);
    expect(__factoryCallCounts.worker).toBe(1);

    getCreepConfigService().remove("W1N1:worker:1");
    work(creep);
    // config 消失且 memory 无 role：不派发角色逻辑。
    expect(__factoryCallCounts.worker).toBe(1);
    expect(creep.say).toHaveBeenCalledWith("no-config");
  });

  it("fallback memory role 正常且按 roleArgs 签名区分", () => {
    const plain = createCreep("plain-worker", { role: "worker" });
    const withArgs = createCreep("args-worker", { role: "worker", roleArgs: ["room-a"] });
    const otherArgs = createCreep("other-worker", { role: "worker", roleArgs: ["room-b"] });

    work(plain);
    work(withArgs);
    work(otherArgs);
    work(plain);

    // 三个不同签名各创建一次；重复使用 plain 签名复用。
    expect(__factoryCallCounts.worker).toBe(3);
    expect(roleRegistry.worker).toHaveBeenNthCalledWith(1);
    expect(roleRegistry.worker).toHaveBeenNthCalledWith(2, "room-a");
    expect(roleRegistry.worker).toHaveBeenNthCalledWith(3, "room-b");
  });

  it("cross-shard traveler 角色恢复走 memory 签名缓存", () => {
    // 编码格式：xshc-<shard>-<targetRoom>-<portalRoom>-<destinationRoom|X>-<nonce>
    const traveler = createCreep("xshc-shard1-W2N2-W1N1-X-n1", {});
    expect(traveler.memory.role).toBeUndefined();

    work(traveler);

    expect(traveler.memory.role).toBe("crossShardClaimer");
    expect(__factoryCallCounts.crossShardClaimer).toBe(1);
    expect(roleRegistry.crossShardClaimer).toHaveBeenCalledWith("shard1", "W2N2", "W1N1", "");

    work(traveler);
    expect(__factoryCallCounts.crossShardClaimer).toBe(1);
  });

  it("config 对象每 tick 被替换为等价新引用时仍命中缓存", () => {
    installConfig("W1N1:worker:1", "worker", ["arg-a"]);
    const creep = createCreep("creep-one", { configName: "W1N1:worker:1" });
    work(creep);
    expect(__factoryCallCounts.worker).toBe(1);

    // 模拟 Memory 每 tick 重解析：重建 runtime 服务（等价于新的 Memory 对象
    // 引用），config 内容不变但对象引用不同，缓存仍应命中。
    resetRuntimeServices();
    installConfig("W1N1:worker:1", "worker", ["arg-a"]);
    Game.time += 1;
    work(creep);
    Game.time += 1;
    work(creep);

    expect(__factoryCallCounts.worker).toBe(1);
  });

  it("历史 memory 签名不会让缓存无限增长", () => {
    const ROLE_LIFECYCLE_CACHE_MAX = 256;
    // 持续写入互不相同的 memory role 签名，模拟临时 fallback 角色。
    for (let index = 0; index < ROLE_LIFECYCLE_CACHE_MAX * 3; index += 1) {
      const creep = createCreep(`temp-${index}`, { role: "worker", roleArgs: [`sig-${index}`] });
      work(creep);
    }

    expect(getRoleLifecycleCacheSizeForTest()).toBeLessThanOrEqual(ROLE_LIFECYCLE_CACHE_MAX);
    expect(__factoryCallCounts.worker).toBe(ROLE_LIFECYCLE_CACHE_MAX * 3);
  });

  it("活跃 config 数量超过旧上限 64 时缓存不会抖动", () => {
    const configCount = 100;
    for (let index = 0; index < configCount; index += 1) {
      installConfig(`W1N1:worker:${index}`, "worker", [`arg-${index}`]);
    }
    const creeps = Array.from({ length: configCount }, (_, index) =>
      createCreep(`creep-${index}`, { configName: `W1N1:worker:${index}` }),
    );

    // 两个完整 tick 内全部 config 都保持活跃：每 config 的 factory 恰好执行
    // 一次。若上限仍为 64，第二轮会触发淘汰重建（factory 次数 > configCount）。
    for (const creep of creeps) {
      work(creep);
    }
    Game.time += 1;
    for (const creep of creeps) {
      work(creep);
    }

    expect(__factoryCallCounts.worker).toBe(configCount);
    expect(getRoleLifecycleCacheSizeForTest()).toBe(configCount);
  });

  it("roleArgs 签名编码无碰撞：含分隔符的参数不与拆分形式混用", () => {
    const combined = createCreep("combined-worker", { role: "worker", roleArgs: ["room-a,extra"] });
    const split = createCreep("split-worker", { role: "worker", roleArgs: ["room-a", "extra"] });

    work(combined);
    work(split);

    // 旧 join("") 编码下两者签名相同，会错误共享同一 lifecycle；
    // JSON 定界编码后必须各自创建。
    expect(roleRegistry.worker).toHaveBeenNthCalledWith(1, "room-a,extra");
    expect(roleRegistry.worker).toHaveBeenNthCalledWith(2, "room-a", "extra");
    expect(__factoryCallCounts.worker).toBe(2);
  });
});
