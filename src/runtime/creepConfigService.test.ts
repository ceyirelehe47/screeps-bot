import { createCreepConfigService } from "@/runtime/creepConfigService";
import { createRuntimeMemoryService } from "@/runtime/memoryService";
import { type CreepConfig } from "@/types/system";

beforeEach(() => { Game.time++; Memory.data = {}; });

it("同 tick 替换/解绑/删除配置后按房间与角色读取一致，旧索引保持点时值", () => {
  const service = createCreepConfigService(createRuntimeMemoryService());
  service.set("worker", { role: "worker", args: [], roomName: "W1N1" });
  const before = service.getReadIndex();
  expect(service.getReadIndex()).toBe(before);
  expect(before.byRoom("W1N1").map(([name]) => name)).toEqual(["worker"]);
  const view = service.readStore();
  service.patch("worker", { role: "upgrader", roomName: "W2N2" });
  const after = service.getReadIndex();
  expect(after).not.toBe(before); expect(after.byRoom("W1N1")).toEqual([]);
  expect(after.byRole("upgrader")[0][0]).toBe("worker");
  expect(before.byRole("worker")[0][1].roomName).toBe("W1N1");
  expect(view.worker.roomName).toBe("W2N2");
  service.detachSpawn("worker");
  expect(view.worker.roomName).toBeUndefined();
  expect(service.getReadIndex().byRoom("W2N2")).toEqual([]);
  service.remove("worker"); expect(Object.keys(view)).toEqual([]);
});

it("读取不能绕过 owner 改配置或嵌套数组；相同写入不失效索引", () => {
  const service = createCreepConfigService(createRuntimeMemoryService());
  const args = ["W1N1"];
  service.set("worker", { role: "worker", args, roomName: "W1N1", spawnOnce: {} });
  args.push("外部修改");
  const before = service.getReadIndex();
  const view = service.readStore() as Record<string, CreepConfig>;
  expect(() => { view.other = { role: "worker", args: [] }; }).toThrow();
  expect(() => { delete view.worker; }).toThrow();
  expect(() => { (view.worker.args as string[]).push("非法改写"); }).toThrow();
  expect(view.worker.args).toEqual(["W1N1"]);
  expect(service.set("worker", { role: "worker", args: ["W1N1"], roomName: "W1N1", spawnOnce: {} })).toBe(false);
  expect(service.getReadIndex()).toBe(before);
});

it("特殊配置名是普通 own key，不借用或改写对象原型", () => {
  const service = createCreepConfigService(createRuntimeMemoryService());
  expect(service.get("toString")).toBeUndefined();
  service.set("__proto__", { role: "worker", args: [] });
  expect(service.get("__proto__")?.role).toBe("worker");
  expect(Object.keys(service.readStore())).toEqual(["__proto__"]);
  expect(Object.getPrototypeOf(Memory.data!.creepConfigs!)).toBe(Object.prototype);
});

it("下一 tick 和外部替换配置根时刷新索引；upsert 保留既有完整替换语义", () => {
  const service = createCreepConfigService(createRuntimeMemoryService());
  service.set("worker", { role: "worker", args: [], body: [WORK, MOVE] });
  service.upsert("worker", "worker", [], "W1N1");
  expect(service.get("worker")?.body).toBeUndefined();
  const before = service.getReadIndex();
  Game.time++; expect(service.getReadIndex()).not.toBe(before);
  Memory.data!.creepConfigs = { changed: { role: "carrier", args: [] } };
  expect(service.getReadIndex().names).toEqual(["changed"]);
});

it("非法角色和稀疏参数在写入前拒绝，不损坏已有配置或推进 revision", () => {
  const service = createCreepConfigService(createRuntimeMemoryService());
  service.set("worker", { role: "worker", args: ["kept"] });
  const before = service.getReadIndex();
  const sparse: string[] = []; sparse.length = 1;
  expect(() => service.set("worker", { role: "worker", args: sparse })).toThrow("invalid creep config args");
  expect(() => service.set("worker", { role: "constructor", args: [] } as unknown as CreepConfig)).toThrow("invalid creep config");
  expect(service.get("worker")?.args).toEqual(["kept"]);
  expect(service.getReadIndex()).toBe(before);
});
