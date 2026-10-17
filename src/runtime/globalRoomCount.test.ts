import { getGlobalOwnedRoomCount } from "@/runtime/globalRoomCount";

it("GCL 预检累计当前 shard 与全部远端；摘要去重且按本地观察时间失效", () => {
  Game.time = 20000; Game.shard = { name: "shard1" } as Game["shard"];
  Game.rooms = { W1N1: { controller: { my: true } } as Room }; Memory.runtime = {};
  Game.cpu = { shardLimits: { shard1: 120, shard0: 0, shard2: 0 } } as unknown as CPU;
  const getRemote = jest.fn((shard: string) => JSON.stringify({ version: 1, shard, updatedAt: 500,
    rooms: [{ room: "W2N2", at: 500 }, { room: "W2N2", at: 500 }, { room: "stale", at: 1 }] }));
  Object.assign(global, { InterShardMemory: { getRemote } });
  expect(getGlobalOwnedRoomCount()).toBe(3); expect(getRemote).toHaveBeenCalledTimes(2);
  expect(getGlobalOwnedRoomCount()).toBe(3); expect(getRemote).toHaveBeenCalledTimes(2);
  Game.time += 1001; expect(getGlobalOwnedRoomCount()).toBe(1);
});
it("新版房间总数不受 512 条摘要上限影响，错误 shard 摘要不计入", () => {
  Game.time++; Game.shard = { name: "shard1" } as Game["shard"];
  Game.rooms = {}; Game.cpu = { shardLimits: { shard0: 0, shard1: 120, shard2: 0 } } as unknown as CPU; Memory.runtime = {};
  Object.assign(global, { InterShardMemory: { getRemote: jest.fn((shard: string) => JSON.stringify({
    version: 1, shard: "shard0", updatedAt: 100, ownedRoomCount: 600, rooms: [] })) } });
  expect(getGlobalOwnedRoomCount()).toBe(600);
});
