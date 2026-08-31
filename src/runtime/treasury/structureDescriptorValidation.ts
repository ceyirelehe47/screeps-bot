/**
 * Treasury 持久 structure binding descriptor 的唯一共享 validator
 * （第十三轮第十节）。
 *
 * 背景：action contract canonicalization（actionContracts.validateStructure
 * Bindings）已实现 bindingKind 的 discriminated union 语义，但 intent /
 * quarantine / authorization-fault 三个持久 store 各自维护字段集不一的
 * descriptor 形状校验副本，且不校验 union 矛盾（governed_location 携带
 * objectId 不会被 intent 层拒绝）；durable identity 重算对 structureFacts
 * 只做类型断言。本轮抽取唯一 validator 供 contract canonicalization 后的
 * descriptor、intent、quarantine、authorization-fault、durable identity
 * 重算、capability 签发与 reconciler 输入共同使用。
 *
 * 分支权威唯一：一切判定只按 bindingKind 分支（不得一处看 bindingKind、
 * 另一处看 objectId 是否存在）。持久 Memory 中出现矛盾 descriptor 时由
 * 调用方判 store unhealthy（fail closed）。
 */

import {
  TREASURY_STRUCTURE_BINDING_KINDS,
  TREASURY_STRUCTURE_BINDING_ROLES,
  TREASURY_STRUCTURE_DESCRIPTOR_VERSION,
} from "@/runtime/treasury/types";

const DESCRIPTOR_ROOM_MAX = 16;
const DESCRIPTOR_STRUCTURE_ID_MAX = 48;
const DESCRIPTOR_LOCATION_KINDS: ReadonlySet<string> = new Set<string>(["storage", "terminal"]);

/**
 * 单条持久 descriptor 的完整形状与 discriminated union 校验
 * （返回 null = 合法，否则有界错误描述）：
 * - governed_location：禁止 objectId / expectedType / expectedRoom；
 *   room/location 受控；structureId（structure 实例 incarnation）语义合法；
 * - game_object：objectId 必填；expectedType/expectedRoom 按规则（非空
 *   字符串）；structureId 与 objectId 语义一致（构建期 game_object 的
 *   incarnation 即对象 id——持久矛盾即损坏）；
 * - 通用：role/required/version 合法。
 */
export function validateTreasuryStructureDescriptor(descriptor: unknown): string | null {
  if (!descriptor || typeof descriptor !== "object") return "structureDescriptor 非对象";
  const typed = descriptor as {
    bindingKind?: unknown;
    role?: unknown;
    roomName?: unknown;
    locationKind?: unknown;
    structureId?: unknown;
    objectId?: unknown;
    expectedType?: unknown;
    expectedRoom?: unknown;
    required?: unknown;
    version?: unknown;
  };
  if (typeof typed.bindingKind !== "string" || !TREASURY_STRUCTURE_BINDING_KINDS.has(typed.bindingKind)) {
    return `structureDescriptor.bindingKind 非法: ${String(typed.bindingKind).slice(0, 24)}`;
  }
  if (typeof typed.role !== "string" || !TREASURY_STRUCTURE_BINDING_ROLES.has(typed.role)) {
    return `structureDescriptor.role 非法: ${String(typed.role).slice(0, 24)}`;
  }
  if (typeof typed.roomName !== "string" || typed.roomName.length === 0 || typed.roomName.length > DESCRIPTOR_ROOM_MAX) {
    return "structureDescriptor.roomName 非法（1..16 字符）";
  }
  if (typeof typed.locationKind !== "string" || !DESCRIPTOR_LOCATION_KINDS.has(typed.locationKind)) {
    return `structureDescriptor.locationKind 非法: ${String(typed.locationKind).slice(0, 24)}`;
  }
  if (typeof typed.structureId !== "string" || typed.structureId.length === 0 || typed.structureId.length > DESCRIPTOR_STRUCTURE_ID_MAX) {
    return "structureDescriptor.structureId 非法（1..48 字符）";
  }
  if (typeof typed.required !== "boolean") return "structureDescriptor.required 须为布尔";
  if (typed.version !== TREASURY_STRUCTURE_DESCRIPTOR_VERSION) {
    return `structureDescriptor.version 非法（当前 ${String(TREASURY_STRUCTURE_DESCRIPTOR_VERSION)}）: ${String(typed.version)}`;
  }
  // 唯一分支权威：一切 game-object 专属字段的允许性只由 bindingKind 决定。
  if (typed.bindingKind === "governed_location") {
    if (typed.objectId !== undefined) return "structureDescriptor 矛盾（governed_location 不允许携带 objectId）";
    if (typed.expectedType !== undefined || typed.expectedRoom !== undefined) {
      return "structureDescriptor 矛盾（governed_location 不允许携带 game-object 专属 expectedType/expectedRoom）";
    }
    return null;
  }
  // bindingKind === "game_object"
  if (typeof typed.objectId !== "string" || typed.objectId.length === 0 || typed.objectId.length > DESCRIPTOR_STRUCTURE_ID_MAX) {
    return "structureDescriptor 矛盾（game_object 必须携带合法 objectId）";
  }
  if (typed.expectedType !== undefined && (typeof typed.expectedType !== "string" || typed.expectedType.length === 0)) {
    return "structureDescriptor.expectedType 非法（非空字符串）";
  }
  if (typed.expectedRoom !== undefined && (typeof typed.expectedRoom !== "string" || typed.expectedRoom.length === 0)) {
    return "structureDescriptor.expectedRoom 非法（非空字符串）";
  }
  if (typed.structureId !== typed.objectId) {
    return "structureDescriptor 矛盾（game_object 的 structureId 与 objectId 语义不一致）";
  }
  return null;
}

/** structureFacts 数组（有界 ≤max）逐项校验（返回 null = 全部合法）。 */
export function validateTreasuryStructureDescriptorArray(
  facts: unknown,
  max: number,
): string | null {
  if (!Array.isArray(facts) || facts.length > max) return `structureFacts 非数组或超过上限 ${String(max)}`;
  for (const fact of facts) {
    const error = validateTreasuryStructureDescriptor(fact);
    if (error !== null) return error;
  }
  return null;
}
