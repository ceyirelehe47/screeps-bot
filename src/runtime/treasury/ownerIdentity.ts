/**
 * Treasury production reservation 的 typed owner identity（第五轮）。
 *
 * 背景：reservation 权威（Memory.runtime.resourceReservations）此前只持久化
 * 裸 holderId 字符串——字符串启发式无法区分"Game object id / 逻辑服务名 /
 * 任务自然键 / 无法识别的 legacy 值"，也无法支撑"同字符串不同 kind 不得
 * 互相排除"的 owner-aware 查询。
 *
 * Owner 类别（kind）：
 * - game-object：真实 Game 对象 id（factory 等结构）；
 * - logical-service：逻辑服务名（`nuker:<objectId>[:<resource>]` /
 *   `synthesis:<roomName>[:<resource>]` 等 namespace 前缀注册表）；
 * - task / contract：任务/合同自然键（`task:` / `contract:` 前缀）；
 * - legacy-unresolved：无法识别的 legacy 字符串——保守计入 committed，
 *   不允许普通 owner declaration 冒充排除。
 *
 * 安全默认（不变量）：无法确证 owner 已失效，绝不把 reservation 从
 * committed 中排除——只有 expiration 或显式 release 才能安全解除占用。
 * 因此 kind 误分类最坏只影响诊断口径，不改变保守占用语义。
 *
 * 兼容性：entry 平铺字段（roomName/resource/holderId/amount/updatedAt/
 * expiresAt）保持不变，owner 为附加字段；store key（`${room}:${resource}:
 * ${holderId}`）不变——marketSaleProtectionAdapter 的 stableKey 与既有数据
 * 完全兼容。
 */

export type TreasuryReservationOwnerKind =
  | "game-object"
  | "logical-service"
  | "task"
  | "contract"
  | "legacy-unresolved";

export interface TreasuryOwnerIdentity {
  readonly kind: TreasuryReservationOwnerKind;
  /** 稳定身份串（与既有 holderId 同源；store key 与排除比较的权威）。 */
  readonly id: string;
  /** owner 归属房间 scope（可选——自排除时必须与查询房间一致）。 */
  readonly roomName?: string;
  /** 逻辑服务 namespace（nuker / synthesis 等）。 */
  readonly namespace?: string;
  /** 可选 lifecycle 引用（任务 id / 合同 id 等）。 */
  readonly lifecycleRef?: string;
}

const VALID_OWNER_KINDS: ReadonlySet<string> = new Set<string>([
  "game-object",
  "logical-service",
  "task",
  "contract",
  "legacy-unresolved",
]);

/** 已知逻辑服务 namespace 前缀注册表（与 holderResolution 保持一致）。 */
const LOGICAL_SERVICE_PREFIXES: readonly string[] = ["nuker:", "synthesis:"];

/** 旧式 Screeps object id：24 位小写 hex。 */
const LEGACY_OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/;
/** 新式 Screeps object id：16 位 base62-ish。 */
const NEW_OBJECT_ID_PATTERN = /^[A-Za-z0-9]{16}$/;

export function isValidTreasuryOwnerIdentity(owner: unknown): owner is TreasuryOwnerIdentity {
  if (!owner || typeof owner !== "object") return false;
  const candidate = owner as Partial<TreasuryOwnerIdentity>;
  if (typeof candidate.kind !== "string" || !VALID_OWNER_KINDS.has(candidate.kind)) return false;
  if (typeof candidate.id !== "string" || candidate.id.length === 0 || candidate.id.length > 128) return false;
  if (candidate.roomName !== undefined && (typeof candidate.roomName !== "string" || candidate.roomName.length === 0)) {
    return false;
  }
  if (candidate.namespace !== undefined && (typeof candidate.namespace !== "string" || candidate.namespace.length === 0)) {
    return false;
  }
  if (candidate.lifecycleRef !== undefined && typeof candidate.lifecycleRef !== "string") return false;
  return true;
}

/**
 * owner identity 的规范比较键：kind + id + namespace 三元组（同字符串不同
 * kind / 不同 namespace 不得互相排除；roomName 由查询层校验归属一致性）。
 */
export function treasuryOwnerIdentityKey(owner: TreasuryOwnerIdentity): string {
  return `${owner.kind}\u0000${owner.id}\u0000${owner.namespace ?? ""}`;
}

/**
 * legacy 裸 holderId 的保守分类（迁移与读侧兜底用）：
 * - `nuker:` / `synthesis:` 前缀 → logical-service（namespace 同名）；
 * - `task:` / `contract:` 前缀 → task / contract；
 * - 旧/新式 Game object id 形状 → game-object；
 * - 其余 → legacy-unresolved（保守计入 committed，不可被普通声明排除）。
 */
export function classifyTreasuryHolderIdAsOwner(holderId: string): TreasuryOwnerIdentity {
  if (typeof holderId === "string") {
    for (const prefix of LOGICAL_SERVICE_PREFIXES) {
      if (holderId.startsWith(prefix)) {
        return { kind: "logical-service", id: holderId, namespace: prefix.slice(0, -1) };
      }
    }
    if (holderId.startsWith("task:")) return { kind: "task", id: holderId };
    if (holderId.startsWith("contract:")) return { kind: "contract", id: holderId };
    if (LEGACY_OBJECT_ID_PATTERN.test(holderId) || NEW_OBJECT_ID_PATTERN.test(holderId)) {
      return { kind: "game-object", id: holderId };
    }
  }
  return { kind: "legacy-unresolved", id: typeof holderId === "string" ? holderId : String(holderId) };
}
