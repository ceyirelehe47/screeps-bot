/**
 * Treasury 资源授权 token（第八轮）——真实写动作的资源用途授权。
 *
 * 背景：prepareTransaction 只做物理可行性验证——不绑定 production
 * reservations、transfer commitments、owner、policy withhold 与 commitment
 * completeness，也不防"A/B 双授权同一批资源后各自 prepare 超卖"。本模块
 * 建立独立授权阶段：
 *
 * - **授权请求必须携带完整上下文**（action kind/resource/room-location
 *   scope/owner/数量/policy withhold 或 policy fingerprint/投影开关/容量
 *   需求）——不提供无上下文授权；
 * - **immediate Game write 授权的硬策略默认**：allowIncoming=false（pending
 *   incoming 不是当前可花费资产）、必须扣 outgoing、必须扣 reservations、
 *   必须考虑 quarantine 与 unresolved intent 风险、必须 commitment
 *   complete——违反（allowIncoming=true / subtractOutgoing=false /
 *   subtractReservations=false）一律结构化拒绝（authorization_policy_
 *   violation）。未来某动作确需依赖 incoming 时由独立策略常量显式批准，
 *   普通布尔不得开启（当前不存在该通道）；
 * - **授权计算**：exact observation + committed overlay − pending outgoing −
 *   production reservations（owner-aware 自排除）− quarantine/intent 风险
 *   流出 − policy withhold − 其它未消费授权的预算占用；amount ≤ 可用量；
 *   同时验证 commitment completeness、reservation store health、write
 *   readiness 基础条件与安全整数；
 * - **opaque token**：heap-only、冻结、由服务实例私有 WeakSet 按对象身份
 *   验证（伪造对象/JSON round-trip 副本一律无效）、单次使用、tick 与
 *   service generation 有界；绑定 exact observation epoch、commitment
 *   revision、projection revision、quarantine revision、intent revision、
 *   reservation store revision、policy fingerprint、owner canonical token、
 *   action kind、resource/room/location/amount scope——任一相关 revision
 *   变化后旧授权失效；
 * - **防超卖预算**：授权成功立即占用 authorization budget（按
 *   (room,location,resource) 记流出预留；多房间 scope 逐 key 全额保守
 *   占用）——A 授权 60k 后 B 再授权 60k（物理 100k）被拒，不等 prepare。
 *   revision 变化时既有授权全部失效，预算随之一并释放（懒检测 + 重建）；
 * - token 消费（consume）：对象身份 → generation → tick → revision 快照 →
 *   单次使用 → transactionId 绑定 → postings 覆盖校验（每个负 posting 在
 *   scope 内、累计流出 ≤ amount）——通过后预算转为 prepare 的 tentative
 *   （互换，不双算）。
 */

import type { TreasuryLocationKind, TreasuryObservationScope } from "@/runtime/treasury/types";
import { isValidTreasuryOwnerIdentity, treasuryReservationOwnerToken, type TreasuryOwnerIdentity } from "@/runtime/treasury/ownerIdentity";

const AUTHORIZATION_ACTION_KIND_MAX = 128;
const AUTHORIZATION_POLICY_FINGERPRINT_MAX = 128;
const AUTHORIZATION_ACTIVE_LIMIT = 64;
const VALID_RESOURCES: ReadonlySet<string> = new Set<string>(RESOURCES_ALL);
const VALID_LOCATION_KINDS: ReadonlySet<string> = new Set<string>(["storage", "terminal"]);
/** 授权可声明的 owner kind（task/contract/legacy-unresolved 无运行时存在性权威）。 */
const AUTHORIZABLE_OWNER_KINDS: ReadonlySet<string> = new Set<string>(["game-object", "logical-service"]);

/** 授权 token 绑定的 revision 快照（任一变化即失效）。 */
export interface TreasuryAuthorizationRevisions {
  readonly commitmentRevision: number;
  readonly projectionRevision: number;
  readonly quarantineRevision: number;
  readonly intentRevision: number;
  readonly reservationStoreRevision: number;
}

/** 授权请求（必须携带完整上下文；字段语义见模块头注释）。 */
export interface TreasuryAuthorizationRequest {
  readonly transactionId: string;
  readonly actionKind: string;
  readonly resource: string;
  /** 授权 scope 房间（非空、去重、须在管辖集合）。 */
  readonly rooms: readonly string[];
  readonly locations?: readonly TreasuryLocationKind[];
  /** 需要消耗的数量（正安全整数——负 posting 累计流出的上限）。 */
  readonly amount: number;
  /** owner-aware 自排除（kind 限 game-object/logical-service）。 */
  readonly owner?: TreasuryOwnerIdentity;
  /** 策略保留量（与 policyFingerprint 二选一或都缺省）。 */
  readonly withhold?: number;
  /** 策略指纹（≤128；与 withhold 二选一）。 */
  readonly policyFingerprint?: string;
  /** 是否允许计入投影（默认 true）。 */
  readonly allowProjected?: boolean;
  /** immediate write 硬策略：必须缺省/false——true 一律拒绝。 */
  readonly allowIncoming?: boolean;
  /** immediate write 硬策略：必须非 false——false 一律拒绝。 */
  readonly subtractOutgoing?: boolean;
  /** immediate write 硬策略：必须非 false——false 一律拒绝。 */
  readonly subtractReservations?: boolean;
  /** 可选容量需求（risk-adjusted free 口径校验）。 */
  readonly capacityRequirement?: {
    readonly roomName: string;
    readonly locationKind: TreasuryLocationKind;
    readonly amount: number;
  };
  /** 后续 action contract digest 绑定（可选）。 */
  readonly contractDigest?: string;
}

/**
 * 不可伪造的授权 token（heap-only capability）：冻结对象，仅经 TreasuryService
 * authorizeResourceUse 签发。防伪依赖服务实例私有 WeakSet 的对象身份——
 * 调用方自行构造结构相同的普通对象或 JSON round-trip 副本一律无效；只在
 * 签发 service generation 与签发 tick 内有效；单次使用（consume 后终态）。
 */
export interface TreasuryAuthorizationToken {
  readonly __brand: "treasury-authorization-token";
  readonly transactionId: string;
  readonly actionKind: string;
  readonly resource: string;
  readonly rooms: readonly string[];
  readonly locations: readonly TreasuryLocationKind[];
  readonly amount: number;
  readonly epoch: {
    readonly scope: TreasuryObservationScope;
    readonly epochSeq: number;
    readonly observedAtTick: number;
  };
  readonly revisions: TreasuryAuthorizationRevisions;
  /** 规范化策略指纹（"wh:<n>" / "pf:<s>" / ""）。 */
  readonly policyFingerprint: string;
  /** canonical owner token（无 owner 为 ""；比较与持久 key 同一算法）。 */
  readonly ownerKey: string;
  readonly serviceGeneration: number;
  readonly tick: number;
  readonly contractDigest?: string;
}

export type TreasuryAuthorizationRejectionReason =
  | "invalid_input"
  | "authorization_policy_violation"
  | "authorization_context_unsafe"
  | "insufficient_amount"
  | "capacity_overflow"
  | "authorization_capacity_exhausted";

export type TreasuryAuthorizationResult =
  | { readonly status: "authorized"; readonly token: TreasuryAuthorizationToken }
  | {
      readonly status: "rejected";
      readonly reason: TreasuryAuthorizationRejectionReason;
      readonly detail: string;
    };

export type TreasuryAuthorizationConsumeResult =
  | { readonly status: "ok" }
  | {
      readonly status: "rejected";
      readonly reason: "invalid_token" | "cross_generation" | "cross_tick" | "revision_mismatch" | "already_consumed" | "transaction_mismatch" | "scope_violation";
      readonly detail: string;
    };

/** 规范化策略指纹（withhold 与 policyFingerprint 互斥表达）。 */
export function canonicalTreasuryPolicyFingerprint(request: TreasuryAuthorizationRequest): string {
  if (request.withhold !== undefined) return `wh:${String(request.withhold)}`;
  if (request.policyFingerprint !== undefined) return `pf:${request.policyFingerprint}`;
  return "";
}

/**
 * 授权请求形状与硬策略校验（返回 null = 合法，否则有界错误描述）：
 * - 形状：transactionId/actionKind/resource/rooms/locations/amount/owner/
 *   withhold/policyFingerprint/capacityRequirement/contractDigest 逐字段；
 * - immediate write 硬策略：allowIncoming=true、subtractOutgoing=false、
 *   subtractReservations=false 一律 policy_violation；
 * - withhold 与 policyFingerprint 同时提供即拒绝（双口径歧义）。
 */
export function validateTreasuryAuthorizationRequest(
  request: TreasuryAuthorizationRequest,
  governedRoomNames: ReadonlySet<string>,
): string | null {
  if (!request || typeof request !== "object") return "授权请求缺失或非对象";
  if (typeof request.transactionId !== "string" || request.transactionId.length === 0 || request.transactionId.length > 128) {
    return "transactionId 非法（须为 1..128 字符）";
  }
  if (typeof request.actionKind !== "string" || request.actionKind.length === 0 || request.actionKind.length > AUTHORIZATION_ACTION_KIND_MAX) {
    return "actionKind 非法（须为 1..128 字符）";
  }
  if (typeof request.resource !== "string" || !VALID_RESOURCES.has(request.resource)) {
    return `resource 不在 RESOURCES_ALL: ${String(request.resource)}`;
  }
  if (!Array.isArray(request.rooms) || request.rooms.length === 0) {
    return "rooms 必须为非空数组";
  }
  const seenRooms = new Set<string>();
  for (const roomName of request.rooms) {
    if (typeof roomName !== "string" || roomName.length === 0) return "rooms 含非法房间名";
    if (seenRooms.has(roomName)) return `rooms 含重复房间: ${roomName}`;
    if (!governedRoomNames.has(roomName)) return `rooms 含非管辖房间: ${roomName}`;
    seenRooms.add(roomName);
  }
  if (request.locations !== undefined) {
    if (!Array.isArray(request.locations) || request.locations.length === 0) {
      return "locations 必须为非空数组";
    }
    const seenLocations = new Set<string>();
    for (const kind of request.locations) {
      if (typeof kind !== "string" || !VALID_LOCATION_KINDS.has(kind)) {
        return `locations 含非法位置类型: ${String(kind)}`;
      }
      if (seenLocations.has(kind)) return `locations 含重复位置: ${kind}`;
      seenLocations.add(kind);
    }
  }
  if (typeof request.amount !== "number" || !Number.isSafeInteger(request.amount) || request.amount <= 0) {
    return `amount 须为正安全整数: ${String(request.amount)}`;
  }
  if (request.owner !== undefined) {
    if (!isValidTreasuryOwnerIdentity(request.owner)) {
      return "owner 非法（kind-specific 校验失败）";
    }
    if (!AUTHORIZABLE_OWNER_KINDS.has(request.owner.kind)) {
      return `owner kind ${request.owner.kind} 无运行时存在性权威——不可持有授权（fail closed）`;
    }
  }
  if (request.withhold !== undefined) {
    if (typeof request.withhold !== "number" || !Number.isSafeInteger(request.withhold) || request.withhold < 0) {
      return `withhold 须为非负安全整数: ${String(request.withhold)}`;
    }
  }
  if (request.policyFingerprint !== undefined) {
    if (typeof request.policyFingerprint !== "string" || request.policyFingerprint.length === 0 || request.policyFingerprint.length > AUTHORIZATION_POLICY_FINGERPRINT_MAX) {
      return "policyFingerprint 非法（须为 1..128 字符）";
    }
  }
  if (request.withhold !== undefined && request.policyFingerprint !== undefined) {
    return "withhold 与 policyFingerprint 互斥（不得双口径）";
  }
  if (request.allowIncoming !== undefined && typeof request.allowIncoming !== "boolean") {
    return "allowIncoming 必须为布尔";
  }
  if (request.subtractOutgoing !== undefined && typeof request.subtractOutgoing !== "boolean") {
    return "subtractOutgoing 必须为布尔";
  }
  if (request.subtractReservations !== undefined && typeof request.subtractReservations !== "boolean") {
    return "subtractReservations 必须为布尔";
  }
  if (request.allowProjected !== undefined && typeof request.allowProjected !== "boolean") {
    return "allowProjected 必须为布尔";
  }
  if (request.capacityRequirement !== undefined) {
    const cap = request.capacityRequirement;
    if (!cap || typeof cap !== "object") return "capacityRequirement 非对象";
    if (typeof cap.roomName !== "string" || !governedRoomNames.has(cap.roomName)) {
      return `capacityRequirement.roomName 非法或非管辖: ${String(cap.roomName)}`;
    }
    if (typeof cap.locationKind !== "string" || !VALID_LOCATION_KINDS.has(cap.locationKind)) {
      return `capacityRequirement.locationKind 非法: ${String(cap.locationKind)}`;
    }
    if (typeof cap.amount !== "number" || !Number.isSafeInteger(cap.amount) || cap.amount <= 0) {
      return `capacityRequirement.amount 须为正安全整数: ${String(cap.amount)}`;
    }
  }
  if (request.contractDigest !== undefined) {
    if (typeof request.contractDigest !== "string" || !/^[0-9a-f]{16}$/.test(request.contractDigest)) {
      return "contractDigest 非法（须为 16 小写 hex）";
    }
  }
  return null;
}

/** immediate write 硬策略检查（形状合法后的语义策略）。 */
export function validateTreasuryAuthorizationPolicy(request: TreasuryAuthorizationRequest): string | null {
  if (request.allowIncoming === true) {
    return "allowIncoming=true 不被 immediate write 授权允许（pending incoming 不是当前可花费资产；未来依赖须经独立策略显式批准）";
  }
  if (request.subtractOutgoing === false) {
    return "subtractOutgoing=false 不被允许（immediate write 授权必须扣除 transfer outgoing commitments）";
  }
  if (request.subtractReservations === false) {
    return "subtractReservations=false 不被允许（immediate write 授权必须扣除 production reservations）";
  }
  return null;
}

/** 授权 token 的 owner 比较键（与持久 key 同一 canonical 算法）。 */
export function treasuryAuthorizationOwnerKey(owner: TreasuryOwnerIdentity | undefined): string {
  return owner === undefined ? "" : treasuryReservationOwnerToken(owner);
}

/** 当前活跃授权数上限（heap 有界；超出拒绝新授权——授权预算是内存资源）。 */
export const TREASURY_AUTHORIZATION_ACTIVE_LIMIT = AUTHORIZATION_ACTIVE_LIMIT;

/**
 * postings 覆盖校验：token 只校验**自己 resource** 的负 posting（多资源
 * action 每种资源分别授权——联合覆盖由执行入口保证）；该 resource 的每个
 * 负 posting 在 room/location scope 内、累计流出 ≤ amount。
 */
export function postingsWithinAuthorizationScope(
  token: TreasuryAuthorizationToken,
  postings: readonly { roomName: string; locationKind: string; resource: string; delta: number }[],
): string | null {
  const roomScope = new Set(token.rooms);
  const locationScope = new Set<string>(token.locations);
  let totalOutflow = 0;
  for (const posting of postings) {
    if (posting.delta >= 0) continue; // 只约束流出（负 posting）
    if (posting.resource !== token.resource) continue; // 其它资源的腿由对应 token 覆盖
    if (!roomScope.has(posting.roomName)) {
      return `posting roomName ${posting.roomName} 不在授权 scope`;
    }
    if (!locationScope.has(posting.locationKind)) {
      return `posting locationKind ${posting.locationKind} 不在授权 scope`;
    }
    totalOutflow += -posting.delta;
    if (!Number.isSafeInteger(totalOutflow)) return "累计流出溢出安全整数";
    if (totalOutflow > token.amount) {
      return `累计流出 ${String(totalOutflow)} 超出授权 amount ${String(token.amount)}`;
    }
  }
  return null;
}
