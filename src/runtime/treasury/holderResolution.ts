/**
 * Treasury holder 身份解析——typed（game-object / logical）统一入口。
 *
 * 背景（第四轮修复）：production reservation 的 holderId 并非一律是
 * Game object id——nukerControl 写入的形态是 `nuker:<nukerId>:<resource>`
 * 逻辑名，synthesisControl 自排除使用 `synthesis:<roomName>:<resource>`。
 * 把 holderId 统一按 Game object id 解释（getObjectById 整串解析）会把全部
 * 逻辑名 holder 误判为 orphan，导致 committed 被低估、可用量被高估。
 *
 * 解析规则（保守 fail closed：无法确证存在的 holder 仍视为不存在）：
 * 1. 已知逻辑名命名空间（前缀注册表）：`nuker:<objectId>[:<resource>]`
 *    解析内嵌 objectId 的存在性与归属房间；`synthesis:<roomName>[:<resource>]`
 *    解析 owned 房间归属；
 * 2. 其余整串按 Game object id 解析（factory 等直接用结构 id 的 holder）。
 *
 * 返回值携带 kind：owner 声明（TreasuryQueryOwner.holderKind）必须与解析
 * 结果一致——声明 game-object 但 holderId 实为逻辑名时 fail closed，
 * 杜绝"知道 holderId 字符串就能冒充任意类型 owner"。
 */

import type { TreasuryHolderKind, TreasuryHolderResolution } from "@/runtime/treasury/types";

export type { TreasuryHolderKind, TreasuryHolderResolution };

interface LogicalHolderNamespace {
  readonly prefix: string;
  /** 从逻辑名内嵌主体解析归属房间；undefined = holder 不存在。 */
  readonly resolveRoom: (subject: string) => string | undefined;
}

const LOGICAL_HOLDER_NAMESPACES: readonly LogicalHolderNamespace[] = [
  {
    // nukerControl：`nuker:<nukerId>:<resource>`（reserveProductionResource 写入）。
    prefix: "nuker:",
    resolveRoom: (nukerId) => {
      const resolved = Game.getObjectById?.(nukerId as Id<Structure>);
      const room = (resolved as { room?: { name?: string } } | null)?.room;
      return room?.name;
    },
  },
  {
    // synthesisControl：`synthesis:<roomName>:<resource>`（自排除口径）。
    prefix: "synthesis:",
    resolveRoom: (roomName) => {
      const room = Game.rooms?.[roomName];
      return room?.controller?.my ? roomName : undefined;
    },
  },
];

/** 逻辑名内嵌主体与可选资源后缀：`<subject>[:<resource>]`。 */
const LOGICAL_SUBJECT_PATTERN = /^([A-Za-z0-9\-]+)(?::[A-Za-z0-9_\-\.]+)?$/;

/**
 * 解析 holder 存在性与归属房间：undefined = 无法确证存在（调用方按
 * orphan / fail-closed 处理）；返回值 kind 供 typed owner 校验。
 */
export function resolveTreasuryHolder(holderId: string): TreasuryHolderResolution | undefined {
  if (typeof holderId !== "string" || holderId.length === 0) return undefined;
  for (const namespace of LOGICAL_HOLDER_NAMESPACES) {
    if (!holderId.startsWith(namespace.prefix)) continue;
    const subject = holderId.slice(namespace.prefix.length);
    const match = LOGICAL_SUBJECT_PATTERN.exec(subject);
    if (!match) return undefined; // 已知前缀但主体非法：保守判不存在
    const roomName = namespace.resolveRoom(match[1]);
    if (roomName === undefined) return undefined;
    return { kind: "logical", roomName };
  }
  const resolved = Game.getObjectById?.(holderId as Id<Structure>);
  const room = (resolved as { room?: { name?: string } } | null)?.room;
  if (!room?.name) return undefined;
  return { kind: "game-object", roomName: room.name };
}

/** commitments orphan 判定的默认谓词（逻辑名 holder 不再被误判）。 */
export function treasuryHolderExists(holderId: string): boolean {
  return resolveTreasuryHolder(holderId) !== undefined;
}
