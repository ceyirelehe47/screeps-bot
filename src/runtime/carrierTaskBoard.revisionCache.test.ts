/**
 * CarrierTaskBoard revision + 排序快照缓存回归测试。
 * 对应任务书阶段 C1：相同 room/revision 下排序只执行一次，
 * 写操作立即失效缓存，读取不创建私有 store。
 */
import {
  clearCarrierTaskBoardForTest,
  getCarrierTaskOrderRebuildCountForTest,
  listCarrierDispatchEntriesByRoom,
  listCarrierTasksByRoom,
  peekCarrierTaskBoard,
  peekCarrierTasksByRoom,
  replaceCarrierTasksForProducerRoom,
} from "@/runtime/carrierTaskBoard";

interface DraftSpec {
  id: string;
  priority: number;
  amount?: number;
}

function makeDraft({ id, priority, amount = 100 }: DraftSpec) {
  return {
    id,
    type: "terminal_feed" as const,
    priority,
    steps: [{
      id: `${id}-step`,
      resource: RESOURCE_ENERGY as ResourceConstant,
      fromKind: "storage" as const,
      toKind: "terminal" as const,
      fromId: "from-structure",
      toId: "to-structure",
      amount,
    }],
  };
}

type RuntimeGlobalWithBoard = typeof global & {
  __carrierTaskBoard?: unknown;
};

describe("carrierTaskBoard revision cache", () => {
  beforeEach(() => {
    Game.time = 1000;
    clearCarrierTaskBoardForTest();
  });

  it("相同 room/revision 下多次读取只重建一次排序", () => {
    replaceCarrierTasksForProducerRoom("prod", "W1N1", [
      makeDraft({ id: "a", priority: 5 }),
      makeDraft({ id: "b", priority: 10 }),
    ]);
    expect(getCarrierTaskOrderRebuildCountForTest()).toBe(0);

    for (let index = 0; index < 5; index += 1) {
      expect(listCarrierTasksByRoom("W1N1").map((task) => task.id)).toEqual(["b", "a"]);
    }
    expect(peekCarrierTasksByRoom("W1N1").map((entry) => entry.ref.localId)).toEqual(["a", "b"]);
    expect(peekCarrierTaskBoard().W1N1).toHaveLength(2);
    expect(listCarrierDispatchEntriesByRoom("W1N1")).toHaveLength(2);
    // dispatch 与 publish 两种排序共享同一次重建。
    expect(getCarrierTaskOrderRebuildCountForTest()).toBe(1);
  });

  it("replace 更新任务后缓存立即失效并反映新排序", () => {
    replaceCarrierTasksForProducerRoom("prod", "W1N1", [
      makeDraft({ id: "a", priority: 5 }),
      makeDraft({ id: "b", priority: 10 }),
    ]);
    expect(listCarrierTasksByRoom("W1N1").map((task) => task.id)).toEqual(["b", "a"]);
    expect(getCarrierTaskOrderRebuildCountForTest()).toBe(1);

    // a 的优先级提升到最高。
    replaceCarrierTasksForProducerRoom("prod", "W1N1", [
      makeDraft({ id: "a", priority: 20 }),
      makeDraft({ id: "b", priority: 10 }),
    ]);
    expect(listCarrierTasksByRoom("W1N1").map((task) => task.id)).toEqual(["a", "b"]);
    expect(getCarrierTaskOrderRebuildCountForTest()).toBe(2);
    expect(listCarrierTasksByRoom("W1N1").map((task) => task.id)).toEqual(["a", "b"]);
  });

  it("replace 删除任务后缓存立即失效", () => {
    replaceCarrierTasksForProducerRoom("prod", "W1N1", [
      makeDraft({ id: "a", priority: 5 }),
      makeDraft({ id: "b", priority: 10 }),
    ]);
    expect(listCarrierTasksByRoom("W1N1").map((task) => task.id)).toEqual(["b", "a"]);
    expect(getCarrierTaskOrderRebuildCountForTest()).toBe(1);
    replaceCarrierTasksForProducerRoom("prod", "W1N1", [
      makeDraft({ id: "b", priority: 10 }),
    ]);
    expect(listCarrierTasksByRoom("W1N1").map((task) => task.id)).toEqual(["b"]);
    expect(getCarrierTaskOrderRebuildCountForTest()).toBe(2);
    // 之后的重复读取不再重建。
    expect(listCarrierTasksByRoom("W1N1").map((task) => task.id)).toEqual(["b"]);
    expect(getCarrierTaskOrderRebuildCountForTest()).toBe(2);
  });

  it("读取不存在的房间不会创建 board 或空 store", () => {
    const runtimeGlobal = global as RuntimeGlobalWithBoard;
    expect(listCarrierTasksByRoom("W9N9")).toEqual([]);
    expect(listCarrierDispatchEntriesByRoom("W9N9")).toEqual([]);
    expect(peekCarrierTasksByRoom("W9N9")).toEqual([]);
    expect(peekCarrierTaskBoard()).toEqual({});
    expect(runtimeGlobal.__carrierTaskBoard).toBeUndefined();
  });

  it("缓存持有 live 引用：重复 replace 后读取到最新 task 内容", () => {
    replaceCarrierTasksForProducerRoom("prod", "W1N1", [
      makeDraft({ id: "a", priority: 5, amount: 50 }),
    ]);
    expect(listCarrierTasksByRoom("W1N1")[0].steps[0].amount).toBe(50);

    replaceCarrierTasksForProducerRoom("prod", "W1N1", [
      makeDraft({ id: "a", priority: 5, amount: 80 }),
    ]);
    expect(listCarrierTasksByRoom("W1N1")[0].steps[0].amount).toBe(80);
    expect(peekCarrierTasksByRoom("W1N1")[0].task.steps[0].amount).toBe(80);
  });

  it("其他房间的写操作不影响本房间缓存", () => {
    replaceCarrierTasksForProducerRoom("prod", "W1N1", [
      makeDraft({ id: "a", priority: 5 }),
    ]);
    expect(listCarrierTasksByRoom("W1N1").map((task) => task.id)).toEqual(["a"]);
    expect(getCarrierTaskOrderRebuildCountForTest()).toBe(1);

    replaceCarrierTasksForProducerRoom("other", "W2N2", [
      makeDraft({ id: "x", priority: 1 }),
    ]);
    expect(listCarrierTasksByRoom("W1N1").map((task) => task.id)).toEqual(["a"]);
    // W1N1 复用缓存；仅为 W2N2 新建一次排序。
    expect(listCarrierTasksByRoom("W2N2").map((task) => task.id)).toEqual(["x"]);
    expect(getCarrierTaskOrderRebuildCountForTest()).toBe(2);
  });
});
