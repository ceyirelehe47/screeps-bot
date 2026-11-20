import { outboundStageEnded } from "@/runtime/outboundMissionLifecycle";
import type { OutboundMissionOwner } from "@/runtime/outboundMissionRegistry";

export const depositMissionOwner: OutboundMissionOwner = {
  id: "deposit",
  occupiesSource: (roomName, exceptTaskId) => Object.values(Memory.data?.depositHarvest ?? {}).some(task =>
    task.id !== exceptTaskId && task.sourceRoom === roomName && task.status !== "discovered" && !outboundStageEnded("deposit", task.status)),
  matches: (_name, config) => config.role === "depositHarvester",
  evaluate(name, config) {
    const task = config.taskId ? Memory.data?.depositHarvest?.[config.taskId] : undefined;
    const committed = !!task && task.id === config.taskId && task.sourceRoom === config.roomName &&
      task.status === "spawning" && task.spawnStartedAt === undefined &&
      Number.isSafeInteger(task.generation) && task.generation >= 0 && task.configName === name &&
      name === `${task.sourceRoom}:deposit:${task.id}:g${task.generation}` && config.args.length === 2 &&
      config.args[0] === task.id && config.args[1] === task.sourceRoom;
    return { intent: "expedition", family: "deposit", taskId: config.taskId, committed,
      blockedReason: committed ? undefined : "mission_paused" };
  },
};
