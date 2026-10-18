import { cadenceOffset, isDue } from "@/runtime/cadence";
const cadenceTick = (tick: number): number => tick + cadenceOffset("portal.scan", 11);
import { runPortalDiscovery } from "@/runtime/portalDiscovery";

it("Portal 没有视野时按 lastSeenAt 推算真实到期，永久 Portal 保留", () => {
  delete (global as any).__runtimeServices;
  Game.time = cadenceTick(1100); Game.rooms = {}; Memory.cfg = {};
  const portal = { id: "expired", originRoom: "W1N1", destinationShard: "shard1", destinationRoom: "W2N2",
    discoveredAt: 1000, lastSeenAt: 1000, ticksToDecay: 90 };
  Memory.data = { interShardPortals: { expired: portal, permanent: { ...portal, id: "permanent", ticksToDecay: undefined } } } as any;
  runPortalDiscovery();
  expect(Memory.data!.interShardPortals!.expired).toBeUndefined();
  expect(Memory.data!.interShardPortals!.permanent).toBeDefined();
});
