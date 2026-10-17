import type { OutboundMissionOwner } from "@/runtime/outboundMissionRegistry";

export const powerBankMissionOwner: OutboundMissionOwner = {
  id: "powerBank",
  matches: (_name, config) => ["powerBankAttacker", "powerBankHealer", "powerBankHauler"].includes(config.role),
  evaluate(_name, config, mode) {
    if (!mode.reserve || mode.defense) return { intent: "expedition", committed: false };
    const task = config.taskId ? Memory.data?.powerBankHarvest?.[config.taskId] : undefined;
    return { intent: "expedition", committed: !!task && task.id === config.taskId && task.sourceRoom === config.roomName &&
      task.targetRoom === config.args[0] && ["preparing_boosts", "spawning", "renewing", "boosting", "travelling", "attacking", "hauling"].includes(task.status) };
  },
};
