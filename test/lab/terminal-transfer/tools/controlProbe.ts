/** Read-only preparation entry. Never loads main/singleShot or writes Memory. */
import { LAB_EXAMPLE_EXPERIMENT as config } from "../labConfig";
import { readControlRecord } from "../controlRecord";
import { readEndpoint, readFeeQuote, readTransactionViews, describeError } from "../worldRead";
let samples = 0;
let lastTick: number | undefined;

function endpoint(side: "source" | "target") {
  const reading = readEndpoint(config, side);
  if (reading.readStatus !== "ok") return reading;
  try {
    const room = Game.rooms[reading.roomName];
    const terminal = room.terminal;
    const controller = room.controller;
    return { ...reading, my: terminal.my, isActive: terminal.isActive(), controller: {
      present: controller !== undefined, my: controller?.my, level: controller?.level,
      ownerUsername: controller?.owner?.username,
    } };
  } catch (error) { return { ...reading, readStatus: "read_error", error: describeError(error) }; }
}
export function loop(): void {
  const tick = Game.time;
  if (tick === lastTick) return;
  lastTick = tick;
  if (samples >= 32) return; // External controller also has its own finite deadline.
  samples += 1;
  const source = endpoint("source");
  const target = endpoint("target");
  let shard: { name?: unknown; readError?: string };
  try { shard = { name: Game.shard?.name }; }
  catch (error) { shard = { readError: describeError(error) }; }
  console.log(JSON.stringify({
    kind: "lab-control-sample", sampler: { name: "lab-control-probe", version: "1" },
    tick, expectedExperimentId: config.experimentId, shard,
    // The actual envelope binds userId; this value comes from the observed owner,
    // NOT from config.username. Final readiness compares both facts externally.
    user: { username: source.ownerUsername }, control: readControlRecord(), source, target,
    feeQuote: readFeeQuote(config.amount, config.sourceRoomName, config.targetRoomName),
    transactions: readTransactionViews(),
  }));
}
