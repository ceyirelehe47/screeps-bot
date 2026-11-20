import { outboundStageEnded } from "@/runtime/outboundMissionLifecycle";
import type { OutboundMissionOwner } from "@/runtime/outboundMissionRegistry";

export const powerBankMissionOwner: OutboundMissionOwner = {
  id: "powerBank",
  matches: (_name, config) => ["powerBankAttacker", "powerBankHealer", "powerBankHauler"].includes(config.role),
  evaluate(_name, config) {
    const task = config.taskId ? Memory.data?.powerBankHarvest?.[config.taskId] : undefined;
    const generation = config.powerBankGeneration;
    const currentGeneration = generation === undefined || (config.role === "powerBankHauler" ?
      generation === 0 : generation === (task?.activeGeneration ?? 0) || generation === task?.reinforcement?.generation);
    const roleNeeded = task?.status !== "hauling" || (config.role === "powerBankHauler" && task.haulingEmptySince === undefined);
    const committed = currentGeneration && roleNeeded && !!task && task.id === config.taskId && task.sourceRoom === config.roomName &&
      task.targetRoom === config.args[0] && task.status !== "discovered" && !outboundStageEnded("powerBank", task.status);
    // 无 taskId 的旧手工配置仍走原有的按名核对；它不能取得储备期豁免。
    return { intent: "expedition", family: "powerBank", committed,
      blockedReason: config.taskId && !committed ? "mission_paused" : undefined };
  },
};
