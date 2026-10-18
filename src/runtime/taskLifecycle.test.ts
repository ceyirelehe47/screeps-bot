import { createTaskLifecycle } from "@/runtime/taskLifecycle";
import { appendRuntimeEvent, readRuntimeEventsAfter, RUNTIME_EVENT_CAPACITY } from "@/runtime/runtimeEvents";
import { resetRuntimeServices } from "@mock/movement";

type Status = "ready" | "running" | "done";
interface Task { id: string; status: Status; statusSince?: number; updatedAt?: number; entryEffect?: string }
const lifecycle = createTaskLifecycle<Status, Task>("fixture", {
  ready: ["running", "done"], running: ["done"], done: [],
}, task => task.id);

beforeEach(() => { resetRuntimeServices(); Memory.runtime = {}; Game.time = 100; });

it("终态不能复活，同状态重试不重置时间且不重复发布事件", () => {
  const task: Task = { id: "one", status: "ready" };
  expect(lifecycle.transition(task, "running")).toBe(true);
  Game.time++;
  expect(lifecycle.transition(task, "running")).toBe(false);
  expect(task.statusSince).toBe(100);
  lifecycle.transition(task, "done");
  expect(() => lifecycle.transition(task, "ready")).toThrow("非法任务转移");
  expect(readRuntimeEventsAfter(0).entries.map(event => [event.from, event.to])).toEqual([["ready", "running"], ["running", "done"]]);
});

it("第 k 步失败不提交 entry 标记，下一 tick 重试可收敛并随后只执行一次", () => {
  const task: Task = { id: "one", status: "running" };
  const owned = new Set(["config", "queue", "boost"]);
  const effect = jest.fn(() => {
    owned.delete("config");
    if (Game.time === 100) throw new Error("queue failed");
    owned.delete("queue"); owned.delete("boost");
  });
  expect(() => lifecycle.enter(task, "retire", effect)).toThrow("queue failed");
  expect(task.entryEffect).toBeUndefined();
  Game.time++;
  lifecycle.enter(task, "retire", effect); lifecycle.enter(task, "retire", effect);
  expect(owned.size).toBe(0); expect(effect).toHaveBeenCalledTimes(2);
});

it("队列有容量上限，消费者游标过期得到 gap，heap reset 后顺序仍单调", () => {
  for (let i = 0; i < RUNTIME_EVENT_CAPACITY + 3; i++) appendRuntimeEvent({ owner: "fixture", kind: "spawnAccepted", id: String(i) });
  const before = readRuntimeEventsAfter(0);
  expect(before.gap).toBe(true); expect(before.entries).toHaveLength(RUNTIME_EVENT_CAPACITY);
  expect(Memory.runtime!.events!.dropped).toBe(3);
  resetRuntimeServices(); Game.time++;
  appendRuntimeEvent({ owner: "fixture", kind: "death", id: "old" });
  const after = readRuntimeEventsAfter(before.cursor);
  expect(after.gap).toBe(false); expect(after.entries).toHaveLength(1);
  expect(Object.isFrozen(after.entries[0])).toBe(true);
  Game.time += 5001;
  expect(readRuntimeEventsAfter(before.cursor).gap).toBe(true);
  Memory.runtime = {};
  expect(readRuntimeEventsAfter(before.cursor).gap).toBe(true);
});


it("Memory 重置后相同数值序号也不能复用旧 epoch，旧数值游标要求重新调和", () => {
  appendRuntimeEvent({ owner: "fixture", kind: "death", id: "before" });
  const before = readRuntimeEventsAfter(0);
  Memory.runtime = {};
  appendRuntimeEvent({ owner: "fixture", kind: "death", id: "after" });
  const after = readRuntimeEventsAfter(before.cursor);
  expect(after.cursor.sequence).toBe(before.cursor.sequence);
  expect(after.cursor.epoch).not.toBe(before.cursor.epoch);
  expect(after.gap).toBe(true); expect(after.entries.map(event => event.id)).toEqual(["after"]);
  expect(readRuntimeEventsAfter(1).gap).toBe(true);
  expect(readRuntimeEventsAfter(after.cursor).gap).toBe(false);
});

it("损坏条目与序号溢出不会使任务状态转移中途失败", () => {
  appendRuntimeEvent({ owner: "fixture", kind: "death", id: "before" });
  const before = readRuntimeEventsAfter(0);
  Memory.runtime!.events!.entries.push(null as unknown as import("./runtimeEvents").RuntimeEvent);
  const task: Task = { id: "one", status: "ready" };
  expect(() => lifecycle.transition(task, "running")).not.toThrow();
  Memory.runtime!.events!.nextSequence = Number.MAX_SAFE_INTEGER;
  appendRuntimeEvent({ owner: "fixture", kind: "death", id: "after" });
  expect(readRuntimeEventsAfter(before.cursor).gap).toBe(true);
});
