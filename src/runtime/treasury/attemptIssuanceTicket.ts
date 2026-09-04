/**
 * 【Round 22 Remediation IX 工作流 A / 4.3 方案 B → X 工作流 A】issued
 * attempt ticket——production issuance 与 attempt opening 的受控原子入口，
 * 以及 execution authority 的强制来源。
 *
 * Remediation VIII 的 mint 是裸操作：watermark 推进后 Treasury 对该 sequence
 * 无任何 lifecycle owner——issuer watermark 与真实 lifecycle 之间形成无界
 * 空洞（production 对外可获得无限期有效的裸 ID）。
 *
 * 本模块把签发收敛为单一受控 opening：
 *
 * - `openTreasuryIssuedInitialAttempt(owner)`：watermark 推进（mint）与持久
 *   issued ticket 写入是**同一操作**（任一步失败整体回滚——ticket 写失败时
 *   watermark 一并回退，不存在"ID 已返回但 Treasury 完全无 lifecycle owner"
 *   的窗口——A8）；
 * - ticket 有明确 TTL（active → expired 是显式协议转换，有正面生命周期
 *   事实——不是删除）与显式 consume（durable owner 接管协议——X 工作流 B：
 *   consume 只经 attemptIssuanceHandoff 的 owner-gated 入口，durable
 *   lifecycle owner 写入并 read-back 之后才发生；直接手工 consume 不产生
 *   执行权限——consumed 且无 durable owner 的 ID 在 prepare/execute gate
 *   一律拒绝）；
 * - 【X 工作流 A】execution authority：ti2_ ID 的 production Game callback
 *   可达必须持有 matching、仍可接管（active）、且 contract binding 一致的
 *   issued ticket——只有 `sequence <= watermark` 绝不构成执行权限；
 * - 未过期 ticket 不得被 orphan GC；过期（expired）/已消费（consumed）的
 *   terminal ticket 由 lifecycle GC coordinator 在验证 issuer watermark ≥
 *   sequence（monotonic anti-reuse frontier 已承载）后按有界预算淘汰；
 * - ticket store 是 active/unresolved 类（lifecycle contract 登记）：满载
 *   fail closed（阻断新 issuance——不按年龄删除 active ticket）；
 * - global reset 后 ticket 从 Memory 恢复（heap 缓存与 Memory 权威同对象）；
 * - orphan 判定（IX 工作流 E 8.3）：active ticket 在位 → sequence 有
 *   lifecycle owner，不得被 retired range 的孤儿 gap coalesce abandon。
 */

import { cloneTreasuryDurableValue } from "@/runtime/treasury/durableClone";
import {
  mintTreasuryInitialAttemptId,
  peekTreasuryIssuedAttemptWatermark,
  verifyTreasuryCurrentIssuedIdCanonical,
} from "@/runtime/treasury/attemptIssuer";

export const TREASURY_ISSUED_TICKET_VERSION = 1;
/** active ticket 容量（满载 fail closed——阻断新 issuance，不按年龄删除）。 */
export const TREASURY_ISSUED_TICKET_MAX_ENTRIES = 64;
/**
 * 【X 工作流 G】**总 entry 硬容量**（active + terminal）：active 上限只是
 * 并发约束，不是 store 容量——无总量上限时 consumed/expired 的产生速率
 * 长期高于 GC 回收速率会让 Memory 无界增长。128 = active 64 + terminal
 * 回收余量（GC 每批 ≤8/tick，满载前由 open 的 bounded reclaim 先行回收）。
 */
export const TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES = 128;
/** active ticket 的显式过期窗口（过期为状态转换，非删除）。 */
export const TREASURY_ISSUED_TICKET_TTL_TICKS = 500;
/** GC coordinator 每 tick 的 terminal ticket 淘汰预算（有界）。 */
export const TREASURY_ISSUED_TICKET_GC_BATCH = 8;
const TICKET_KEY_PREFIX = "tk:";
const OWNER_MAX_LENGTH = 48;

export interface TreasuryIssuedAttemptTicketEntry {
  readonly transactionId: string;
  readonly sequence: number;
  readonly issuedAtTick: number;
  /** 签发请求方标识（诊断/lifecycle owner 描述——不参与 ID hash）。 */
  readonly owner: string;
  /** active（在飞）/ consumed（已被 opening 接管）/ expired（TTL 显式过期）。 */
  state: "active" | "consumed" | "expired";
  readonly stateChangedAtTick: number;
  /**
   * 【X 工作流 A / T6】首次 contract execution 时的 binding（AC4 contract
   * digest——跨 tick 稳定）。绑定后不同 contract（digest 变化）接管同一
   * ticket 即 exact conflict；同 digest 幂等重放放行至 gate 的后续检查。
   */
  readonly boundContractDigest?: string;
}

export interface TreasuryIssuedAttemptTicketStore {
  readonly version: typeof TREASURY_ISSUED_TICKET_VERSION;
  entries: Record<string, TreasuryIssuedAttemptTicketEntry>;
  entryCount: number;
  updatedAt: number;
}

interface TreasuryMemoryBranchWithTickets {
  issuedAttemptTickets?: TreasuryIssuedAttemptTicketStore;
}

type RuntimeMemoryWithTickets = NonNullable<Memory["runtime"]> & {
  treasury?: TreasuryMemoryBranchWithTickets;
};

interface TicketRuntime {
  store: TreasuryIssuedAttemptTicketStore;
  fatal: string | null;
}

let heapRuntime: TicketRuntime | null = null;

function ticketBranch(): TreasuryMemoryBranchWithTickets {
  if (!Memory.runtime) Memory.runtime = {};
  const runtime = Memory.runtime as unknown as RuntimeMemoryWithTickets;
  if (!runtime.treasury) runtime.treasury = {};
  return runtime.treasury;
}

function ticketStoreOfMemory(): TreasuryIssuedAttemptTicketStore | undefined {
  return (Memory.runtime as unknown as RuntimeMemoryWithTickets | undefined)?.treasury?.issuedAttemptTickets;
}

function validateTicketEntryShape(entry: unknown, key: string): string | null {
  if (!entry || typeof entry !== "object") return `issued ticket ${key.slice(0, 8)} 非对象`;
  const candidate = entry as Partial<TreasuryIssuedAttemptTicketEntry>;
  if (typeof candidate.transactionId !== "string" || candidate.transactionId.length === 0) {
    return `issued ticket ${key.slice(0, 8)} transactionId 非法`;
  }
  if (key !== TICKET_KEY_PREFIX + candidate.transactionId) {
    return `issued ticket ${key.slice(0, 8)} 键与 transactionId 不一致`;
  }
  if (!Number.isSafeInteger(candidate.sequence) || (candidate.sequence as number) < 1) {
    return `issued ticket ${key.slice(0, 8)} sequence 非法`;
  }
  // 【XI 工作流 B / T1-T4】canonical current 发行身份：ti2_ 域 + checksum
  // 确定性重算一致 + entry.sequence 与 ID 内 sequence 完全相等。任何一条
  // 损坏都使整店 unhealthy（validateTicketStoreShape 逐条共用本校验——
  // production callback 不可达，不自动修复损坏 entry）。
  // （non-strict 判别收窄限制——经 "reason" in 判定失败分支。）
  const canonical = verifyTreasuryCurrentIssuedIdCanonical(
    candidate.transactionId as string,
    candidate.sequence as number,
  );
  if ("reason" in canonical) {
    return `issued ticket ${key.slice(0, 8)} 非 canonical current 发行 ID: ${canonical.reason}`;
  }
  if (!Number.isSafeInteger(candidate.issuedAtTick) || (candidate.issuedAtTick as number) < 0) {
    return `issued ticket ${key.slice(0, 8)} issuedAtTick 非法`;
  }
  if (typeof candidate.owner !== "string" || candidate.owner.length === 0 || candidate.owner.length > OWNER_MAX_LENGTH) {
    return `issued ticket ${key.slice(0, 8)} owner 非法`;
  }
  if (candidate.state !== "active" && candidate.state !== "consumed" && candidate.state !== "expired") {
    return `issued ticket ${key.slice(0, 8)} state 非法: ${String(candidate.state).slice(0, 16)}`;
  }
  if (!Number.isSafeInteger(candidate.stateChangedAtTick) || (candidate.stateChangedAtTick as number) < 0) {
    return `issued ticket ${key.slice(0, 8)} stateChangedAtTick 非法`;
  }
  if (
    candidate.boundContractDigest !== undefined &&
    (typeof candidate.boundContractDigest !== "string" || candidate.boundContractDigest.length === 0 || candidate.boundContractDigest.length > 128)
  ) {
    return `issued ticket ${key.slice(0, 8)} boundContractDigest 非法`;
  }
  return null;
}

function validateTicketStoreShape(store: unknown): string | null {
  if (!store || typeof store !== "object") return "issued ticket store 非对象";
  const candidate = store as Partial<TreasuryIssuedAttemptTicketStore>;
  if (candidate.version !== TREASURY_ISSUED_TICKET_VERSION) {
    return `issued ticket store 版本非法: ${String(candidate.version).slice(0, 16)}`;
  }
  if (!candidate.entries || typeof candidate.entries !== "object") return "issued ticket store entries 非对象";
  const proto = Object.getPrototypeOf(candidate.entries);
  if (proto !== Object.prototype && proto !== null) return "issued ticket store entries 原型非普通对象";
  const keys = Object.keys(candidate.entries);
  for (const key of keys) {
    if (key === "__proto__" || !key.startsWith(TICKET_KEY_PREFIX)) {
      return `issued ticket store 键 ${key.slice(0, 8)} 缺少前缀`;
    }
    const error = validateTicketEntryShape(candidate.entries[key], key);
    if (error !== null) return error;
  }
  if (keys.length > TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES) {
    return `issued ticket store 超过总硬容量 ${String(TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES)}（实际 ${String(keys.length)}——B1）`;
  }
  if (candidate.entryCount !== keys.length) {
    return `issued ticket store entryCount ${String(candidate.entryCount)} != ${String(keys.length)}`;
  }
  return null;
}

function loadTicketRuntime(): TicketRuntime {
  if (heapRuntime !== null) return heapRuntime;
  const raw = ticketStoreOfMemory();
  if (raw === undefined) {
    const store: TreasuryIssuedAttemptTicketStore = {
      version: TREASURY_ISSUED_TICKET_VERSION,
      entries: {},
      entryCount: 0,
      updatedAt: Game.time,
    };
    ticketBranch().issuedAttemptTickets = store;
    heapRuntime = { store, fatal: null };
    return heapRuntime;
  }
  const shapeError = validateTicketStoreShape(raw);
  heapRuntime = { store: raw, fatal: shapeError };
  return heapRuntime;
}

export interface TreasuryIssuedTicketHealth {
  readonly healthy: boolean;
  readonly detail: string;
}

/** 只读健康探测（store 不存在 = 健康空；损坏 → unhealthy）。 */
export function peekTreasuryIssuedAttemptTicketHealth(): TreasuryIssuedTicketHealth {
  const raw = ticketStoreOfMemory();
  if (raw === undefined) return { healthy: true, detail: "" };
  const shapeError = validateTicketStoreShape(raw);
  return shapeError === null ? { healthy: true, detail: "" } : { healthy: false, detail: shapeError };
}

/** 读取单条 ticket（只读；损坏条目视为缺省——状态判定由 health 承载）。 */
export function readTreasuryIssuedAttemptTicket(
  transactionId: string,
): TreasuryIssuedAttemptTicketEntry | undefined {
  const raw = ticketStoreOfMemory();
  if (raw === undefined) return undefined;
  const entry = raw.entries[TICKET_KEY_PREFIX + transactionId];
  if (entry === undefined) return undefined;
  const shapeError = validateTicketEntryShape(entry, TICKET_KEY_PREFIX + transactionId);
  return shapeError === null ? cloneTreasuryDurableValue(entry) : undefined;
}

export type TreasuryIssuedAttemptOpenResult =
  | { readonly status: "opened"; readonly transactionId: string; readonly sequence: number }
  | {
      readonly status: "rejected";
      readonly reason: "ticket_capacity_exhausted" | "ticket_store_unhealthy" | "issuer_store_unhealthy";
      readonly detail: string;
    };

/**
 * 【A8】production 的唯一签发入口：watermark 推进与持久 issued ticket 同一
 * 受控操作（mint → ticket 写入 + read-back → 返回；ticket 写入失败时
 * watermark 回滚——不存在已返回的裸 ID，也不留无主 sequence 洞的正面事实
 * 缺失：ticket 本身就是 opening 记录）。owner 是签发请求方标识（诊断与
 * lifecycle owner 描述）。
 */
export function openTreasuryIssuedInitialAttempt(owner: string): TreasuryIssuedAttemptOpenResult {
  const runtime = loadTicketRuntime();
  if (runtime.fatal !== null) {
    return { status: "rejected", reason: "ticket_store_unhealthy", detail: `issued ticket store fail-closed: ${runtime.fatal}` };
  }
  if (typeof owner !== "string" || owner.length === 0 || owner.length > OWNER_MAX_LENGTH) {
    return { status: "rejected", reason: "ticket_store_unhealthy", detail: "issued ticket owner 标识非法（1..48 字符）" };
  }
  let activeCount = 0;
  for (const entry of Object.values(runtime.store.entries)) {
    if (entry.state === "active") activeCount += 1;
  }
  if (activeCount >= TREASURY_ISSUED_TICKET_MAX_ENTRIES) {
    return {
      status: "rejected",
      reason: "ticket_capacity_exhausted",
      detail: `active issued ticket 已达硬容量 ${String(TREASURY_ISSUED_TICKET_MAX_ENTRIES)}（active/unresolved 不按年龄删除——阻断新 issuance，fail closed）`,
    };
  }
  // 【X 工作流 G / B4】总容量检查在 mint（watermark 推进）**之前**：满载先
  // 有界回收 eligible terminal entry（watermark frontier 已覆盖的 consumed/
  // expired——与 GC coordinator 同一 retire 路径）；回收后仍满 → fail
  // closed（watermark 不推进——不存在"先推进 watermark 再发现无槽"）。
  if (runtime.store.entryCount >= TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES) {
    const watermark = peekTreasuryIssuedAttemptWatermark();
    if (watermark >= 0) {
      void retireTreasuryTerminalIssuedAttemptTickets(watermark);
    }
    const totalAfterReclaim = Object.keys(runtime.store.entries).length;
    if (totalAfterReclaim >= TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES) {
      return {
        status: "rejected",
        reason: "ticket_capacity_exhausted",
        detail: `issued ticket store 总 entry 已达硬容量 ${String(TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES)}（terminal 回收后仍满——fail closed；active 不因满载被删，watermark 未推进）`,
      };
    }
  }
  const minted = mintTreasuryInitialAttemptId();
  if (minted.status === "rejected") {
    return { status: "rejected", reason: "issuer_store_unhealthy", detail: minted.detail };
  }
  // ticket 写入 + read-back；失败 → 回滚（watermark 回退 + entry 删除——
  // 不留"ID 已铸但无 lifecycle owner"的窗口）。
  const key = TICKET_KEY_PREFIX + minted.transactionId;
  const entry: TreasuryIssuedAttemptTicketEntry = cloneTreasuryDurableValue({
    transactionId: minted.transactionId,
    sequence: minted.sequence,
    issuedAtTick: Game.time,
    owner,
    state: "active",
    stateChangedAtTick: Game.time,
  });
  runtime.store.entries[key] = entry;
  runtime.store.entryCount += 1;
  runtime.store.updatedAt = Game.time;
  const rollback = (detail: string): TreasuryIssuedAttemptOpenResult => {
    delete runtime.store.entries[key];
    runtime.store.entryCount -= 1;
    runtime.store.updatedAt = Game.time;
    // watermark 回退：本 sequence 从未对外返回（ticket 是唯一出口）。
    const issuerStore = (Memory.runtime as unknown as {
      treasury?: { attemptIssuer?: { highWatermark: number } };
    } | undefined)?.treasury?.attemptIssuer;
    if (issuerStore !== undefined && issuerStore.highWatermark === minted.sequence) {
      issuerStore.highWatermark = minted.sequence - 1;
    }
    return { status: "rejected", reason: "ticket_store_unhealthy", detail };
  };
  const rawStore = ticketStoreOfMemory();
  if (rawStore === undefined || rawStore.entries[key] === undefined) {
    return rollback("issued ticket 写入后 Memory read-back 缺失（watermark 已回滚——不签发裸 ID）");
  }
  const readBackError = validateTicketEntryShape(rawStore.entries[key], key);
  if (readBackError !== null || rawStore.entries[key]!.transactionId !== minted.transactionId) {
    return rollback(`issued ticket read-back 失败: ${readBackError ?? "transactionId 不一致"}（watermark 已回滚）`);
  }
  return { status: "opened", transactionId: minted.transactionId, sequence: minted.sequence };
}

export type TreasuryIssuedTicketMutationResult =
  | { readonly status: "consumed" }
  | { readonly status: "expired" }
  | { readonly status: "absent" }
  | { readonly status: "rejected"; readonly reason: "store_unhealthy" | "state_conflict"; readonly detail: string };

/**
 * 【X 工作流 B】durable owner 接管协议的 consume 步骤（active → consumed）。
 *
 * 本函数是**协议内部原语**：唯一合法调用方是 attemptIssuanceHandoff 的
 * `completeTreasuryIssuedTicketHandoff`（先验证 durable lifecycle owner
 * 已写入并经权威判定在位，再 consume——不存在"ticket 已 terminal 且没有
 * durable owner"的窗口）。手工直接调用本函数不会授予任何执行权限：
 * consumed 且无 durable owner 的 ID 在 prepare/execute gate 一律拒绝（T9）。
 *
 * 幂等：已 consumed 返回 consumed；expired 不可再接管 → state_conflict。
 * 写入 + Memory read-back；失败 → 结构化 rejected（调用方 fail closed）。
 */
export function consumeTreasuryIssuedAttemptTicketForHandoff(transactionId: string): TreasuryIssuedTicketMutationResult {
  const runtime = loadTicketRuntime();
  if (runtime.fatal !== null) {
    return { status: "rejected", reason: "store_unhealthy", detail: `issued ticket store fail-closed: ${runtime.fatal}` };
  }
  const key = TICKET_KEY_PREFIX + transactionId;
  const entry = runtime.store.entries[key];
  if (entry === undefined) return { status: "absent" };
  const shapeError = validateTicketEntryShape(entry, key);
  if (shapeError !== null) {
    return { status: "rejected", reason: "store_unhealthy", detail: `issued ticket 损坏: ${shapeError}` };
  }
  if (entry.state === "consumed") return { status: "consumed" };
  if (entry.state === "expired") {
    return { status: "rejected", reason: "state_conflict", detail: "issued ticket 已显式过期（expired——opening 不得接管过期票）" };
  }
  const next: TreasuryIssuedAttemptTicketEntry = cloneTreasuryDurableValue({
    ...entry,
    state: "consumed",
    stateChangedAtTick: Game.time,
  });
  runtime.store.entries[key] = next;
  runtime.store.updatedAt = Game.time;
  const rawStore = ticketStoreOfMemory();
  if (rawStore === undefined || rawStore.entries[key]?.state !== "consumed") {
    runtime.store.entries[key] = cloneTreasuryDurableValue(entry);
    runtime.store.updatedAt = Game.time;
    return { status: "rejected", reason: "store_unhealthy", detail: "issued ticket consume read-back 失败（已回滚）" };
  }
  return { status: "consumed" };
}

export type TreasuryIssuedTicketBindResult =
  | { readonly status: "bound" }
  | { readonly status: "idempotent" }
  | { readonly status: "rejected"; readonly reason: "store_unhealthy" | "state_conflict" | "binding_conflict"; readonly detail: string };

/**
 * 【X 工作流 A / T6】active ticket 与 contract 的首次 binding：把 AC4
 * contract digest（跨 tick 稳定——actionKind/transactionId/canonical args/
 * postings/structure descriptors/durable facts/retry facts/source）写入
 * ticket 并 read-back。
 *
 * - 未绑定 → 绑定当前 contract digest（声明性事实——不是执行权限消耗；
 *   纯前置失败后的同 exact opening 幂等重试不受影响（T7/B8））；
 * - 已绑定同 digest → 幂等（同 exact opening 重试）；
 * - 已绑定不同 digest → exact conflict（contract B 不得接管 contract A 的
 *   ticket——A 的安全事实不被覆盖）；
 * - 非 active（consumed/expired）→ state_conflict（不修改既有状态）。
 */
export function bindTreasuryIssuedAttemptTicketToContract(
  transactionId: string,
  contractDigest: string,
): TreasuryIssuedTicketBindResult {
  if (typeof contractDigest !== "string" || contractDigest.length === 0 || contractDigest.length > 128) {
    return { status: "rejected", reason: "binding_conflict", detail: "contract digest 非法（binding 拒绝）" };
  }
  const runtime = loadTicketRuntime();
  if (runtime.fatal !== null) {
    return { status: "rejected", reason: "store_unhealthy", detail: `issued ticket store fail-closed: ${runtime.fatal}` };
  }
  const key = TICKET_KEY_PREFIX + transactionId;
  const entry = runtime.store.entries[key];
  if (entry === undefined) return { status: "rejected", reason: "state_conflict", detail: "issued ticket 不存在（无 binding 对象）" };
  const shapeError = validateTicketEntryShape(entry, key);
  if (shapeError !== null) {
    return { status: "rejected", reason: "store_unhealthy", detail: `issued ticket 损坏: ${shapeError}` };
  }
  if (entry.state !== "active") {
    return { status: "rejected", reason: "state_conflict", detail: `issued ticket 状态 ${entry.state} 不可绑定（仅 active ticket 可绑定 contract）` };
  }
  if (entry.boundContractDigest !== undefined) {
    if (entry.boundContractDigest === contractDigest) return { status: "idempotent" };
    return {
      status: "rejected",
      reason: "binding_conflict",
      detail: `issued ticket 已绑定其它 contract（bound digest ${entry.boundContractDigest.slice(0, 16)} != ${contractDigest.slice(0, 16)}——同 ID 的不同 exact opening 不得接管同一 ticket）`,
    };
  }
  const next: TreasuryIssuedAttemptTicketEntry = cloneTreasuryDurableValue({
    ...entry,
    boundContractDigest: contractDigest,
  });
  runtime.store.entries[key] = next;
  runtime.store.updatedAt = Game.time;
  const rawStore = ticketStoreOfMemory();
  if (rawStore === undefined || rawStore.entries[key]?.boundContractDigest !== contractDigest || rawStore.entries[key]?.state !== "active") {
    runtime.store.entries[key] = cloneTreasuryDurableValue(entry);
    runtime.store.updatedAt = Game.time;
    return { status: "rejected", reason: "store_unhealthy", detail: "issued ticket binding read-back 失败（已回滚）" };
  }
  return { status: "bound" };
}

/**
 * active ticket 的显式过期（GC coordinator 每 tick 有界批量）：TTL 到期的
 * active → expired（正面生命周期事实——sequence 已消耗在 watermark frontier
 * 内，不再是"猜测调用方放弃"）。写入 + read-back；返回转换数。
 */
export function expireTreasuryIssuedAttemptTickets(): number {
  const runtime = loadTicketRuntime();
  if (runtime.fatal !== null) return 0;
  let expired = 0;
  for (const [key, entry] of Object.entries(runtime.store.entries)) {
    if (entry.state !== "active") continue;
    if (Game.time - entry.issuedAtTick <= TREASURY_ISSUED_TICKET_TTL_TICKS) continue;
    const next: TreasuryIssuedAttemptTicketEntry = cloneTreasuryDurableValue({
      ...entry,
      state: "expired",
      stateChangedAtTick: Game.time,
    });
    runtime.store.entries[key] = next;
    const rawStore = ticketStoreOfMemory();
    if (rawStore === undefined || rawStore.entries[key]?.state !== "expired") {
      // read-back 失败：回滚本条（保守——下 tick 重试），停止本批。
      runtime.store.entries[key] = entry;
      break;
    }
    expired += 1;
  }
  if (expired > 0) runtime.store.updatedAt = Game.time;
  return expired;
}

/**
 * terminal（consumed/expired）ticket 的有界淘汰（GC coordinator 调用）：
 * 淘汰前验证 issuer watermark ≥ sequence（monotonic anti-reuse frontier 已
 * 承载该 sequence 不可复用）且 issuer/ticket store 健康。逐条删除 +
 * read-back；任一失败停止本批（旧事实保留——不把失败写成已清理）。
 */
export function retireTreasuryTerminalIssuedAttemptTickets(
  currentIssuedWatermark: number,
): { readonly retired: number; readonly detail: string | null } {
  const runtime = loadTicketRuntime();
  if (runtime.fatal !== null) return { retired: 0, detail: `issued ticket store fail-closed: ${runtime.fatal}` };
  if (!Number.isSafeInteger(currentIssuedWatermark) || currentIssuedWatermark < 0) {
    return { retired: 0, detail: "issuer watermark 不可读（fail closed——不淘汰 ticket）" };
  }
  let retired = 0;
  for (const [key, entry] of Object.entries(runtime.store.entries)) {
    if (retired >= TREASURY_ISSUED_TICKET_GC_BATCH) break;
    if (entry.state === "active") continue;
    if (entry.sequence > currentIssuedWatermark) continue; // anti-reuse frontier 未覆盖——保留
    delete runtime.store.entries[key];
    runtime.store.entryCount -= 1;
    const rawStore = ticketStoreOfMemory();
    if (rawStore === undefined || rawStore.entries[key] !== undefined || rawStore.entryCount !== runtime.store.entryCount) {
      runtime.store.entries[key] = entry;
      runtime.store.entryCount += 1;
      return { retired, detail: "terminal ticket 淘汰 read-back 失败（本批停止——旧事实保留）" };
    }
    retired += 1;
  }
  if (retired > 0) runtime.store.updatedAt = Game.time;
  return { retired, detail: null };
}

/** active ticket 数（诊断/lifecycle 判定——只读）。 */
export function peekTreasuryIssuedAttemptTicketActiveCount(): number {
  const raw = ticketStoreOfMemory();
  if (raw === undefined) return 0;
  let count = 0;
  for (const entry of Object.values(raw.entries)) {
    if (entry.state === "active") count += 1;
  }
  return count;
}

/** test-only：删除 Memory 中的 ticket store（heap 一并失效）。 */
export function clearTreasuryIssuedAttemptTicketDurableForTest(): void {
  const branch = (Memory.runtime as unknown as RuntimeMemoryWithTickets | undefined)?.treasury;
  if (branch !== undefined) delete branch.issuedAttemptTickets;
  heapRuntime = null;
}

/** test-only：只清 heap 缓存（模拟 global reset 后从 Memory 恢复）。 */
export function resetTreasuryIssuedAttemptTicketHeapCacheForTest(): void {
  heapRuntime = null;
}

/**
 * test-only：单条 ticket 的确定性放弃（active → expired → retire 删除）。
 * 写入与 read-back 走与生产 TTL/GC **完全相同**的路径（expire 转换 +
 * watermark frontier 验证 + 删除 read-back）；唯一差异是作用域限定单条
 * （生产的全局 TTL 扫描会同时触碰其它在飞 opening——fixture 构造持久
 * 权威时不允许误伤）。生产代码零调用（test-only 命名与架构守护共同约束）。
 */
export function abandonTreasuryIssuedAttemptTicketForTest(transactionId: string): boolean {
  const runtime = loadTicketRuntime();
  if (runtime.fatal !== null) return false;
  const key = TICKET_KEY_PREFIX + transactionId;
  const entry = runtime.store.entries[key];
  if (entry === undefined) return false;
  const shapeError = validateTicketEntryShape(entry, key);
  if (shapeError !== null) return false;
  if (entry.state === "active") {
    const next: TreasuryIssuedAttemptTicketEntry = cloneTreasuryDurableValue({
      ...entry,
      state: "expired",
      stateChangedAtTick: Game.time,
    });
    runtime.store.entries[key] = next;
    const raw = ticketStoreOfMemory();
    if (raw === undefined || raw.entries[key]?.state !== "expired") {
      runtime.store.entries[key] = entry;
      return false;
    }
  }
  const current = runtime.store.entries[key];
  if (current === undefined) return true;
  const watermark = peekTreasuryIssuedAttemptWatermark();
  if (watermark < 0 || current.sequence > watermark) return false;
  delete runtime.store.entries[key];
  runtime.store.entryCount -= 1;
  const raw = ticketStoreOfMemory();
  if (raw === undefined || raw.entries[key] !== undefined || raw.entryCount !== runtime.store.entryCount) {
    runtime.store.entries[key] = current;
    runtime.store.entryCount += 1;
    return false;
  }
  runtime.store.updatedAt = Game.time;
  return true;
}
