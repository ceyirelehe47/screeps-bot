/**
 * Terminal Transfer Engine Lab Prep I——真实 API 薄包装（只读部分）。
 *
 * 直接使用 Game.rooms / Terminal .store/.cooldown/.owner/.id /
 * Game.market.calcTransactionCost / incoming/outgoing transactions。
 * 采样只报告原始事实与读取状态：缺房间、缺结构、读失败**不能**被填写为
 * "库存 0、交易空数组且读取成功"；不给出 observed_committed /
 * observed_not_executed 之类的结论（不复制国库 matcher）。
 *
 * 类型窄化说明：@types/screeps 的 Store 索引与官方 Transaction 的
 * description（必填）/order（{id,type,price}）形状与本探针的记录面不同，
 * 实验侧做明确窄化，不改生产声明（任务书 §4.2）。
 */

import type { LabExperimentConfig } from "./labConfig";

/** 端点读取状态与原始读数（缺结构/读失败时数值字段保持 undefined，不填 0）。 */
export interface LabEndpointReading {
  readonly roomName: string;
  readonly readStatus: "ok" | "room_missing" | "terminal_missing" | "read_error";
  readonly terminalId?: string;
  readonly ownerUsername?: string;
  readonly resourceAmount?: number;
  readonly energy?: number;
  readonly freeCapacity?: number | null;
  readonly cooldown?: number;
  readonly error?: string;
}

/** 当前费用报价（读异常/非法值→unavailable，不硬编码 fake 的 26）。 */
export interface LabFeeQuote {
  readonly status: "ok" | "unavailable";
  readonly energyCost?: number;
  readonly error?: string;
}

/** 交易视图原始记录（逐字段浅拷贝，不删改与预期不一致的数据）。 */
export interface LabTransactionViewReading {
  readonly status: "ok" | "read_error";
  readonly count?: number;
  readonly records?: readonly Record<string, unknown>[];
  readonly error?: string;
}

/** 读取一个端点房间里的 Terminal 原始事实。 */
export function readEndpoint(config: LabExperimentConfig, side: "source" | "target"): LabEndpointReading {
  const roomName = side === "source" ? config.sourceRoomName : config.targetRoomName;
  try {
    const rooms = (Game as unknown as { rooms?: Record<string, { terminal?: StructureTerminal | null }> }).rooms ?? {};
    const room = rooms[roomName];
    if (room === undefined) return { roomName, readStatus: "room_missing" };
    const terminal = room.terminal;
    if (terminal === undefined || terminal === null) return { roomName, readStatus: "terminal_missing" };
    // 实验侧窄化：Store 索引读取（官方类型对单资源索引形状保守）。
    const store = terminal.store as unknown as Record<string, number | undefined>;
    return {
      roomName,
      readStatus: "ok",
      terminalId: terminal.id,
      ownerUsername: terminal.owner?.username,
      resourceAmount: store[config.resourceType] ?? 0,
      energy: store.energy ?? 0,
      freeCapacity: terminal.store.getFreeCapacity(),
      cooldown: terminal.cooldown,
    };
  } catch (error) {
    return { roomName, readStatus: "read_error", error: describeError(error) };
  }
}

/** 读取当前费用报价（真实端口；异常/非有限数/负数一律 unavailable）。 */
export function readFeeQuote(amount: number, fromRoomName: string, toRoomName: string): LabFeeQuote {
  try {
    const cost = Game.market.calcTransactionCost(amount, fromRoomName, toRoomName);
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
      return { status: "unavailable", error: `报价端口返回非法值：${String(cost)}` };
    }
    return { status: "ok", energyCost: cost };
  } catch (error) {
    return { status: "unavailable", error: describeError(error) };
  }
}

/** 读取两个交易视图（有限历史——每方向最近记录；读取状态如实保留）。 */
export function readTransactionViews(): {
  readonly incoming: LabTransactionViewReading;
  readonly outgoing: LabTransactionViewReading;
} {
  const readView = (direction: "incomingTransactions" | "outgoingTransactions"): LabTransactionViewReading => {
    try {
      // 官方 API：两视图是数组属性（每方向有限历史）——属性读取，非方法调用。
      const raw = Game.market[direction] as unknown as readonly Record<string, unknown>[] | undefined;
      if (!Array.isArray(raw)) {
        return { status: "read_error", error: `交易视图端口返回非数组：${typeof raw}` };
      }
      // 浅拷贝逐条保留全部字段（含与实验预期不一致的记录——镜像/不同 ID 原样保留）。
      return { status: "ok", count: raw.length, records: raw.map((entry) => ({ ...entry })) };
    } catch (error) {
      return { status: "read_error", error: describeError(error) };
    }
  };
  return { incoming: readView("incomingTransactions"), outgoing: readView("outgoingTransactions") };
}

/** 错误事实化为可序列化文本（不吞异常、不改写为成功结论）。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
