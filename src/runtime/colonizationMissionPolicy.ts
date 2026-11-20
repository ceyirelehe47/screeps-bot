import type { OutboundMissionOwner } from "@/runtime/outboundMissionRegistry";

export const colonizationMissionOwner: OutboundMissionOwner = {
  id: "colonization",
  matches: (name, config) => name.includes(":colonizationSupport:") || ["colonizerWorker", "colonizerHarvester"].includes(config.role),
  evaluate(name, config, mode) {
    if (name.includes(":colonizationSupport:")) {
      const [home, , target] = name.split(":");
      const policy = Memory.cfg?.colonizationSupport?.[target];
      const state = Memory.runtime?.colonizationSupport?.[target];
      const controller = Game.rooms[target]?.controller;
      const eligible = controller?.my && controller.level < 6 && policy?.enabled && policy.sourceRoom === home && home === mode.sourceRoom &&
        config.args[0] === target && state?.sourceRoom === home && state.status === "supporting" &&
        state.runId === (policy.runId ?? `${home}:${target}:rcl6`);
      return { family: "colonizationSupport", intent: "expedition", committed: false,
        blockedReason: eligible ? undefined : "mission_paused" };
    }
    const intent = config.role === "colonizerHarvester" ? "income" : "expedition";
    if (!mode.reserve || mode.defense) return { intent, committed: false };
    const target = config.args[0];
    const task = Memory.data?.colonization?.[target];
    const rescue = Memory.data?.rescue?.[target];
    const committed = Game.rooms[target]?.controller?.my === true && (
      name.startsWith(`${config.roomName}:colonize:${target}:`) && !!task && task.sourceRoom === config.roomName && ["bootstrapping", "managed"].includes(task.status) ||
      name.startsWith(`${config.roomName}:rescue:${target}:`) && rescue?.sourceRoom === config.roomName);
    return { intent, committed };
  },
};
