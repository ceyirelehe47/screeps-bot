import type { OutboundMissionOwner } from "@/runtime/outboundMissionRegistry";
import type { RemoteMiningTask } from "@/runtime/remoteMining";

export function remoteCivilianMustReturn(task: RemoteMiningTask): boolean {
  return Memory.cfg?.remoteMining?.enabled === false || task.status === "defending" || task.status === "suspended" || task.status === "abandoned";
}

/** 只接管 remoteMine 的规范角色。兼容手动 remoteCarrier 等旧通用配置。 */
export const remoteMiningMissionOwner: OutboundMissionOwner = {
  id: "remoteMining",
  matches: (name, config) => name.includes(":remoteMine:") &&
    ["colonizerHarvester", "remoteMiningCarrier", "remoteMiningReserver", "remoteWorker", "remoteDefender", "scout"].includes(config.role),
  evaluate(name, config, mode) {
    const [home, , target, job] = name.split(":");
    const task = Memory.data?.remoteMining?.[target];
    const owned = Memory.cfg?.remoteMining?.enabled !== false && !!task && task.sourceRoom === home && config.roomName === home && home === mode.sourceRoom && config.args[0] === target;
    let ready = false;
    if (owned) {
      if (job === "scout" && config.role === "scout") {
        ready = task.status !== "abandoned" && task.suspendReason !== "manual_war_pause" && task.suspendReason !== "source_room_invalid";
      } else if (job === "defender" && config.role === "remoteDefender") {
        ready = task.status === "defending";
      } else {
        ready = task.status === "active" && (
          job === "harvester" && config.role === "colonizerHarvester" ||
          job === "carrier" && config.role === "remoteMiningCarrier" ||
          job === "reserver" && config.role === "remoteMiningReserver" ||
          job === "worker" && config.role === "remoteWorker"
        );
      }
    }
    return { family: "remoteMining", intent: "income", committed: false, blockedReason: ready ? undefined : "mission_paused" };
  },
};
