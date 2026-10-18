import type { OutboundMissionOwner } from "@/runtime/outboundMissionRegistry";

export const depositMissionOwner: OutboundMissionOwner = {
  id: "deposit",
  matches: (_name, config) => config.role === "depositHarvester",
  evaluate(name, config, mode) {
    if (!mode.reserve || mode.defense) return { intent: "expedition", committed: false };
    const task = config.taskId ? Memory.data?.depositHarvest?.[config.taskId] : undefined;
    return { intent: "expedition", committed: !!task && task.id === config.taskId && task.sourceRoom === config.roomName &&
      task.status === "spawning" && Number.isSafeInteger(task.generation) && task.generation >= 0 && task.configName === name &&
      name === `${task.sourceRoom}:deposit:${task.id}:g${task.generation}` && config.args.length === 2 &&
      config.args[0] === task.id && config.args[1] === task.sourceRoom };
  },
};
