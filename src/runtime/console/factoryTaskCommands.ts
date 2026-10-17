import { jsonCommand } from "@/runtime/console/jsonCommand";
import {
  addFactoryTask,
  cancelFactoryTask,
  listFactoryTasks,
  type AddFactoryTaskResult,
  type CancelFactoryTaskResult,
  type FactoryTask,
} from "@/runtime/factoryControl";

export function addFactoryTaskRaw(
  roomName: string,
  type: "decompress_battery",
  amount: number,
): AddFactoryTaskResult | string {
  return addFactoryTask(roomName, type, { amount });
}

export const addFactoryTaskCommand = jsonCommand((roomName: string, type: "decompress_battery", amount: number) => addFactoryTaskRaw(roomName, type, amount), 2);

export function decompressBatteryRaw(roomName: string, amount: number): AddFactoryTaskResult | string {
  return addFactoryTaskRaw(roomName, "decompress_battery", amount);
}

export const decompressBatteryCommand = jsonCommand((roomName: string, amount: number) => decompressBatteryRaw(roomName, amount), 2);

export function cancelFactoryTaskRaw(taskId: string): CancelFactoryTaskResult | string {
  return cancelFactoryTask(taskId);
}

export const cancelFactoryTaskCommand = jsonCommand((taskId: string) => cancelFactoryTaskRaw(taskId), 2);

export function listFactoryTasksRaw(roomName?: string): FactoryTask[] {
  return listFactoryTasks(roomName);
}

export const listFactoryTasksCommand = jsonCommand((roomName?: string) => listFactoryTasksRaw(roomName), 2);

export function registerFactoryTaskConsoleCommands(): void {
  global.addFactoryTask = addFactoryTaskCommand;
  global.addFactoryTaskRaw = addFactoryTaskRaw;
  global.decompressBattery = decompressBatteryCommand;
  global.decompressBatteryRaw = decompressBatteryRaw;
  global.cancelFactoryTask = cancelFactoryTaskCommand;
  global.cancelFactoryTaskRaw = cancelFactoryTaskRaw;
  global.listFactoryTasks = listFactoryTasksCommand;
  global.listFactoryTasksRaw = listFactoryTasksRaw;
}
