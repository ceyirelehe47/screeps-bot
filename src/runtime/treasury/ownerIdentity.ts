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
  /**
   * owner 归属房间 scope（metadata：store key 外层已表达 room——不参与
   * identity 比较，仅自排除时由查询层校验归属一致性）。
   */
  readonly roomName?: string;
  /** 逻辑服务 namespace（identity：logical-service 必填，其他 kind 禁止）。 */
  readonly namespace?: string;
  /** lifecycle 引用（metadata：不参与 identity 比较与持久 key）。 */
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

const OWNER_ID_MAX = 128;
const OWNER_NAMESPACE_MIN = 1;
const OWNER_NAMESPACE_MAX = 64;
const OWNER_ROOM_NAME_MAX = 32;
const OWNER_LIFECYCLE_REF_MAX = 128;

/**
 * owner identity 的完整形状校验（kind-specific，第七轮收紧）：
 * - logical-service 的 namespace **必填**（1..64 字符）——namespace 参与
 *   身份与持久 key，缺失即身份不完整；
 * - 非 logical-service 的 namespace 必须缺省——禁止"允许携带又在 token 中
 *   忽略"的双口径；
 * - id（1..128）参与身份；roomName/lifecycleRef 只是 metadata（长度有界）。
 */
export function isValidTreasuryOwnerIdentity(owner: unknown): owner is TreasuryOwnerIdentity {
  if (!owner || typeof owner !== "object") return false;
  const candidate = owner as Partial<TreasuryOwnerIdentity>;
  if (typeof candidate.kind !== "string" || !VALID_OWNER_KINDS.has(candidate.kind)) return false;
  if (typeof candidate.id !== "string" || candidate.id.length === 0 || candidate.id.length > OWNER_ID_MAX) return false;
  if (candidate.kind === "logical-service") {
    if (
      typeof candidate.namespace !== "string" ||
      candidate.namespace.length < OWNER_NAMESPACE_MIN ||
      candidate.namespace.length > OWNER_NAMESPACE_MAX
    ) {
      return false;
    }
  } else if (candidate.namespace !== undefined) {
    return false;
  }
  if (
    candidate.roomName !== undefined &&
    (typeof candidate.roomName !== "string" || candidate.roomName.length === 0 || candidate.roomName.length > OWNER_ROOM_NAME_MAX)
  ) {
    return false;
  }
  if (
    candidate.lifecycleRef !== undefined &&
    (typeof candidate.lifecycleRef !== "string" || candidate.lifecycleRef.length > OWNER_LIFECYCLE_REF_MAX)
  ) {
    return false;
  }
  return true;
}

/**
 * owner identity 的规范比较键（第八轮统一）：与持久 key 使用**同一 canonical
 * owner token 算法**（treasuryReservationOwnerToken 的 `ow2:` 长度前缀编码）
 * ——聚合 key、self-exclusion、mutation 定位、migration collision 检测全部
 * 复用同一函数，独立 NUL 分隔比较键已移除。token 相等 ⇔ (kind, namespace,
 * id) 三元组相等——id/namespace 含 NUL、冒号、Unicode、空格均无边界歧义，
 * 比较结果与持久 token 恒一致。roomName/lifecycleRef 不参与（metadata）。
 */
export function treasuryOwnerIdentityKey(owner: TreasuryOwnerIdentity): string {
  return treasuryReservationOwnerToken(owner);
}

/** ownerToken 的 kind 代码注册表（不同 kind 代码互异 ⇒ token 永不跨 kind 碰撞）。 */
const OWNER_KIND_TOKEN_CODES: Readonly<Record<TreasuryReservationOwnerKind, string>> = {
  "game-object": "go",
  "logical-service": "ls",
  task: "tk",
  contract: "ct",
  "legacy-unresolved": "lu",
};

/**
 * 持久 ownerToken（第七轮 v4，长度前缀 canonical 编码）：
 * `ow2:<kindCode>:<nsLen>:<namespace><id>`。
 *
 * 唯一性论证（严格无碰撞）：前三段以冒号定界且 ow2/kindCode/nsLen 均不含
 * 冒号；剩余串 = namespace 原文 + id 原文直接拼接，nsLen（UTF-16 code unit
 * 数）唯一决定切分点。token 相等 ⇔ kindCode、nsLen、拼接串全等 ⇔
 * (kind, namespace, id) 三元组全等——Unicode、冒号、空格、空串在 namespace
 * 与 id 中均不产生边界歧义（v3 的 `ls:<ns>:<id>` 依赖 namespace 无冒号的
 * 隐含约定，v4 消除该约定）。id ≤128、namespace ≤64 保证 token 长度有界；
 * 纯函数无随机数，同输入跨 tick 恒定。identity 字段 = kind + namespace +
 * id；roomName 由 store key 外层表达、lifecycleRef 是 metadata——均不进
 * token。该 token 参与 reservation store key（makeReservationStoreKey 的
 * 唯一拼接权威），mutation/migration/release/renew/query 自排除全部经
 * 同一 helper。
 */
export function treasuryReservationOwnerToken(owner: TreasuryOwnerIdentity): string {
  const kindCode = OWNER_KIND_TOKEN_CODES[owner.kind];
  const namespace = owner.kind === "logical-service" ? owner.namespace ?? "" : "";
  return `ow2:${kindCode}:${String(namespace.length)}:${namespace}${owner.id}`;
}

/**
 * legacy v3 ownerToken（第六轮格式 `go:<id>` / `ls:<ns>:<id>` / …）：仅供
 * v3→v4 迁移的旧 key 一致性核验——以经过完整验证的 entry.owner 为权威重算
 * 新 key，绝不解析 token 字符串反推 identity。生产 mutation 不得使用。
 */
export function treasuryReservationOwnerTokenV3(owner: TreasuryOwnerIdentity): string {
  const kindPrefix = owner.kind === "logical-service" ? "ls" : OWNER_KIND_TOKEN_CODES[owner.kind];
  if (owner.kind === "logical-service") {
    const namespace = owner.namespace ?? owner.id.split(":")[0] ?? "";
    return `${kindPrefix}:${namespace}:${owner.id}`;
  }
  return `${kindPrefix}:${owner.id}`;
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
