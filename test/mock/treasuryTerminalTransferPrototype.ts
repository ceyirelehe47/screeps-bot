/**
 * Terminal Transfer Slice 0——测试专用 Terminal 调拨 fake 宿主与 adapter
 * 原型（任务书 §4；非 .test.ts，不进 Jest 收集，不进入生产 bundle）。
 *
 * 业务范围（§3.1）：A 房间 Terminal 已有矿物 H，向 B 房间 Terminal 调拨
 * 100 H。单一在途调拨、重试关闭、无 Power、无市场/搬运/生产并发。
 *
 * fake 宿主按固定 engine 源码（80977824199a596d174d392fd0cf8c458c21fcbd）
 * 的三段语义建模（§3.2 短报告见 openspec terminal-transfer-slice-0.md）：
 * - API 层（structures.js StructureTerminal.prototype.send）：同步前置检查
 *   后只写入 send intent 并返回 OK——OK 表示"已调度"，不是效果确认；
 * - 处理层（processor/intents/terminal/send.js）：用户 tick 结束后重新检查
 *   资源/费用，通过才把 intent 挂到 terminal 对象（失败静默丢弃、无记录）；
 * - 世界层（processor/global-intents/market.js executeTransfer）：目标剩余
 *   空间会缩小实际 amount 并按实际量继续（100 的请求可能只转运 60）；费用
 *   按缩量后重算；成功才写双方库存、插交易记录、设冷却。
 *
 * 责任模型：execute 只经 submitTerminalSend 提交一次（pending 化，不改
 * 库存）；reconcile 只接收公开形态证据（交易视图端口 + Game.rooms 世界 +
 * durable facts 里的提交前基线），不读宿主内部 pending/submitLog（那些只
 * 给测试断言）。无交易记录不能证明未执行——reconcile 永不返回
 * observed_not_executed（§4.3）。
 */

import {
  mutateStoreResource,
  type RoomSpec,
} from "@mock/treasury";
import type {
  TreasuryActionAdapter,
  TreasuryActionReconcilerConclusion,
  TreasuryActionStructureBinding,
  TreasuryDurableFacts,
} from "@/runtime/treasury/actionContracts";

// ── 常量与场景输入 ─────────────────────────────────────────────────────────

/** 本 slice 唯一支持的货物（原型夹具值；不是已批准的正式服额度）。 */
export const SLICE0_TRANSFER_RESOURCE = "H" as const;
/** 本 slice 唯一支持的调拨量（原型夹具值）。 */
export const SLICE0_TRANSFER_AMOUNT = 100;
/** adapter kind（仅测试注册，生产 actionContracts.ts 不注册它）。 */
export const SLICE0_ACTION_KIND = "slice0.terminal-send" as const;

/** 原型假设：受控世界尺寸（费用距离的环形取短计算用；真实环境待实测核对）。 */
const PROTOTYPE_WORLD_SIZE = 128;
/** 源码事实：engine 常量 TERMINAL_COOLDOWN 的文档值（本场景单条在途，测试不依赖其推进）。 */
const TERMINAL_COOLDOWN_TICKS = 10;
const ROOM_NAME_PATTERN = /^(W|E)\d+(N|S)\d+$/;
const CORRELATION_KEY_PATTERN = /^[A-Za-z0-9-]{1,32}$/;

/** canonical 参数（单一参数来源，§4.1；description 由它派生，调用者不能另传）。 */
export interface TerminalTransferArgs {
  readonly sourceRoomName: string;
  readonly targetRoomName: string;
  readonly resourceType: typeof SLICE0_TRANSFER_RESOURCE;
  readonly amount: typeof SLICE0_TRANSFER_AMOUNT;
  readonly correlationKey: string;
}

export function makeSlice0TransferArgs(
  sourceRoomName: string,
  targetRoomName: string,
  correlationKey: string,
): TerminalTransferArgs {
  return {
    sourceRoomName,
    targetRoomName,
    resourceType: SLICE0_TRANSFER_RESOURCE,
    amount: SLICE0_TRANSFER_AMOUNT,
    correlationKey,
  };
}

/** 用户可见 description（安全 ASCII 关联键固定嵌入；≤100 字符——§4.3）。 */
function descriptionFor(args: TerminalTransferArgs): string {
  return `treasury-slice0 ${args.correlationKey}`;
}

// ── 费用与距离（源码事实：utils.js calcRoomsDistance/calcTerminalEnergyCost） ──

function roomNameToXY(roomName: string): [number, number] | null {
  const match = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);
  if (match === null) return null;
  const x = match[1] === "W" ? -(Number(match[2]) + 1) : Number(match[2]);
  const y = match[3] === "N" ? Number(match[4]) : -(Number(match[4]) + 1);
  return [x, y];
}

/** 环形取短的最大坐标差（utils.js calcRoomsDistance continuous 语义）。 */
export function slice0RoomsDistance(roomName1: string, roomName2: string): number | null {
  const a = roomNameToXY(roomName1);
  const b = roomNameToXY(roomName2);
  if (a === null || b === null) return null;
  let dx = Math.abs(b[0] - a[0]);
  let dy = Math.abs(b[1] - a[1]);
  dx = Math.min(PROTOTYPE_WORLD_SIZE - dx, dx);
  dy = Math.min(PROTOTYPE_WORLD_SIZE - dy, dy);
  return Math.max(dx, dy);
}

/** 源码事实：Math.ceil(amount * (1 - Math.exp(-range / 30)))。 */
export function slice0TerminalEnergyCost(amount: number, range: number): number {
  return Math.ceil(amount * (1 - Math.exp(-range / 30)));
}

// ── 交易记录公开形态（模拟 Game.market 交易视图可见字段，§3.2/E2） ──────────

/** send 路径交易记录（deal 路径记录带 order 字段——reconcile 据此排除）。 */
export interface TerminalTransactionRecord {
  readonly transactionId: string;
  readonly time: number;
  readonly sender?: { username: string };
  readonly recipient?: { username: string };
  readonly resourceType: string;
  readonly amount: number;
  readonly from: string;
  readonly to: string;
  readonly description?: string;
  readonly order?: { readonly id: string };
}

/** 只读交易视图端口（reconcile 与测试共用；负向场景可配置窗口/异常/注入）。 */
export interface TerminalTransactionsView {
  outgoingTransactions(): readonly TerminalTransactionRecord[];
  incomingTransactions(): readonly TerminalTransactionRecord[];
}

/** 视图行为配置（M06 负向场景；默认全量、无异常。字段可变——测试按场景改写，宿主每次读取当前值）。 */
export interface TerminalTransactionsViewConfig {
  /** 模拟历史被挤出（返回空——查询不到不能证明未执行）。 */
  dropAll?: boolean;
  /** 模拟指定视图读取异常（reconcile 须保守保留 unknown）。 */
  failOutgoing?: boolean;
  failIncoming?: boolean;
  /** 注入额外公开记录（他人交易/旧请求/市场订单/重复 ID 噪声）。 */
  injected?: TerminalTransactionRecord[];
}

// ── fake 宿主 ───────────────────────────────────────────────────────────────

/** 一次实际到达 submit 端口的调用（含被拒绝的——测试断言实际调用面）。 */
export interface SubmittedSendCall {
  readonly atTick: number;
  readonly sourceRoomName: string;
  readonly targetRoomName: string;
  readonly resourceType: string;
  readonly amount: number;
  readonly description: string;
}

/** 已接受未处理的发送请求（模拟 terminal 对象上的 send intent 字段）。 */
interface PendingSend {
  readonly sourceRoomName: string;
  readonly targetRoomName: string;
  readonly resourceType: string;
  readonly amount: number;
  readonly description: string;
}

export interface TerminalTransferSubmitResult {
  readonly ok: boolean;
  readonly code?: string;
}

/**
 * fake 宿主（工厂闭包持有全部可变状态——跨 performTreasuryFullReset 存活；
 * 断言面 submits/pendingCount 仅供测试核对，不进 reconciler 路径）。
 */
export interface TerminalTransferFakeHost {
  /** fake submit 端口（重放 engine API 层同步检查；OK 只入 pending，不改库存）。 */
  submitTerminalSend(input: {
    sourceRoomName: string;
    targetRoomName: string;
    resourceType: string;
    amount: number;
    description: string;
  }): TerminalTransferSubmitResult;
  /**
   * 处理阶段推进（测试协调者显式调用，模拟用户 tick 结束后的
   * intents 处理 + global-intents 世界层；重放缩量/静默丢弃语义）。
   */
  processPendingRequests(): void;
  /** 可信费用报价端口（canonical 参数派生 fee；可配置漂移）。 */
  quoteTransferFee(amount: number, fromRoomName: string, toRoomName: string): number;
  /** 只读交易视图（reconcile 的唯一记录来源）。 */
  readonly transactionsView: TerminalTransactionsView;
  /** 视图行为配置（负向场景由测试按场景改写；默认关闭全部注入）。 */
  readonly viewConfig: TerminalTransactionsViewConfig;
  /** 报价漂移配置：此后每次报价 +driftBy（模拟报价上行——陈旧偏低预算不得继续调用）。 */
  configureFeeDrift(driftBy: number): void;
  /** 断点分支标记（传 captureTreasuryHostBreakpoint；reopen 从副本重开宿主状态）。 */
  captureBranch(): TerminalTransferHostBranchMarker;
  // ── 测试断言面（不进 reconciler 路径）──
  readonly submits: readonly SubmittedSendCall[];
  readonly pendingCount: number;
  readonly transactions: readonly TerminalTransactionRecord[];
}

/** 宿主分支标记（复用 harness 的 eventBranch 形状——reopen 恢复宿主配对状态）。 */
export interface TerminalTransferHostBranchMarker {
  readonly kind: "treasury-journal-branch";
  readonly count: number;
  readonly source: TerminalTransferFakeHost;
  reopen(): void;
}

interface HostState {
  pending: PendingSend[];
  transactions: TerminalTransactionRecord[];
  submits: SubmittedSendCall[];
  txnSeq: number;
  viewConfig: TerminalTransactionsViewConfig;
  feeDrift: number;
  cooldownUntil: Record<string, number>;
  branchEpoch: number;
  /** 最近一次报价派生（§4.1：execute 前比对——报价上行时拒绝继续调用）。 */
  lastQuote: { key: string; fee: number } | null;
}

interface HostWorldRoom {
  readonly terminal?: { id: string; store: Record<string, number> & { getUsedCapacity(): number; getFreeCapacity(): number } };
}

function hostRooms(): Record<string, HostWorldRoom> {
  return (globalThis as unknown as { Game: { rooms: Record<string, HostWorldRoom> } }).Game.rooms;
}

/**
 * 创建 fake 宿主。viewConfig 由测试持有引用并按场景改写（对象可变性归测试
 * 控制——宿主每次读取当前值，负向场景无需重建宿主）。
 */
export function createTerminalTransferFakeHost(): TerminalTransferFakeHost {
  const state: HostState = {
    pending: [],
    transactions: [],
    submits: [],
    txnSeq: 0,
    viewConfig: {},
    feeDrift: 0,
    cooldownUntil: {},
    branchEpoch: 0,
    lastQuote: null,
  };

  const readStore = (roomName: string): Record<string, number> | undefined =>
    hostRooms()[roomName]?.terminal?.store;

  const host: TerminalTransferFakeHost = {
    quoteTransferFee(amount, fromRoomName, toRoomName): number {
      const range = slice0RoomsDistance(fromRoomName, toRoomName);
      if (range === null) throw new Error(`报价端口：房间名非法（${fromRoomName}→${toRoomName}）`);
      const fee = slice0TerminalEnergyCost(amount, range) + state.feeDrift;
      state.lastQuote = { key: `${fromRoomName}>${toRoomName}:${String(amount)}`, fee };
      return fee;
    },

    submitTerminalSend(input): TerminalTransferSubmitResult {
      // 重放 engine API 层（structures.js send）的同步前置检查——全部通过
      // 才"写入 send intent"（这里入 pending）。OK 只表示已调度。
      state.submits.push({
        atTick: Game.time,
        sourceRoomName: input.sourceRoomName,
        targetRoomName: input.targetRoomName,
        resourceType: input.resourceType,
        amount: input.amount,
        description: input.description,
      });
      const rooms = hostRooms();
      const sourceRoom = rooms[input.sourceRoomName];
      const sourceTerminal = sourceRoom?.terminal;
      if (sourceTerminal === undefined) return { ok: false, code: "ERR_NOT_OWNER" };
      if (!ROOM_NAME_PATTERN.test(input.targetRoomName)) return { ok: false, code: "ERR_INVALID_ARGS" };
      if (input.resourceType !== SLICE0_TRANSFER_RESOURCE && input.resourceType !== "energy") {
        return { ok: false, code: "ERR_INVALID_ARGS" };
      }
      const store = sourceTerminal.store;
      if ((store[input.resourceType] ?? 0) < input.amount) return { ok: false, code: "ERR_NOT_ENOUGH_RESOURCES" };
      if ((state.cooldownUntil[input.sourceRoomName] ?? 0) > Game.time) return { ok: false, code: "ERR_TIRED" };
      const range = slice0RoomsDistance(input.sourceRoomName, input.targetRoomName);
      if (range === null) return { ok: false, code: "ERR_INVALID_ARGS" };
      const cost = slice0TerminalEnergyCost(input.amount, range) + state.feeDrift;
      // §4.1 报价一致性：与派生时点（postings 冻结值）比对——报价上行
      // （drift）时不得用陈旧偏低预算继续调用。
      const quoteKey = `${input.sourceRoomName}>${input.targetRoomName}:${String(input.amount)}`;
      if (state.lastQuote !== null && state.lastQuote.key === quoteKey && state.lastQuote.fee !== cost) {
        return { ok: false, code: "ERR_FEE_QUOTE_DRIFTED" };
      }
      const energyNeeded = input.resourceType === "energy" ? input.amount + cost : cost;
      if ((store.energy ?? 0) < energyNeeded) return { ok: false, code: "ERR_NOT_ENOUGH_RESOURCES" };
      if (input.description.length > 100) return { ok: false, code: "ERR_INVALID_ARGS" };
      state.pending.push({
        sourceRoomName: input.sourceRoomName,
        targetRoomName: input.targetRoomName,
        resourceType: input.resourceType,
        amount: input.amount,
        description: input.description,
      });
      return { ok: true };
    },

    processPendingRequests(): void {
      const rooms = hostRooms();
      // 挂起请求逐条处理（提交序）；处理后清空（模拟 terminal.send 字段被消费）。
      const queue = state.pending.slice();
      state.pending = [];
      for (const intent of queue) {
        const sourceRoom = rooms[intent.sourceRoomName];
        const sourceTerminal = sourceRoom?.terminal;
        const targetTerminal = rooms[intent.targetRoomName]?.terminal;
        // 世界层前置（market.js send 分支）：冷却中丢弃；目标 terminal 缺失/
        // 非自有丢弃——均静默、无记录（查询不到交易不能证明未执行）。
        if (sourceTerminal === undefined) continue;
        if ((state.cooldownUntil[intent.sourceRoomName] ?? 0) > Game.time) continue;
        if (targetTerminal === undefined) continue;
        // executeTransfer：源库存再查 → 目标空间缩量（按实际量继续）→
        // 缩量后费用重查 → 双方库存 + 交易记录（实际 amount）+ 冷却。
        let amount = intent.amount;
        if ((sourceTerminal.store[intent.resourceType] ?? 0) < amount) continue;
        const freeSpace = Math.max(0, targetTerminal.store.getFreeCapacity());
        amount = Math.min(amount, freeSpace);
        if (!(amount > 0)) continue;
        const range = slice0RoomsDistance(intent.sourceRoomName, intent.targetRoomName);
        if (range === null) continue;
        const fee = slice0TerminalEnergyCost(amount, range) + state.feeDrift;
        const energyNeeded = intent.resourceType === "energy" ? amount + fee : fee;
        if ((sourceTerminal.store.energy ?? 0) < energyNeeded) continue;
        mutateStoreResource(rooms[intent.targetRoomName]!.terminal as unknown as StructureTerminal, intent.resourceType, amount);
        mutateStoreResource(sourceTerminal as unknown as StructureTerminal, intent.resourceType, -amount);
        mutateStoreResource(sourceTerminal as unknown as StructureTerminal, "energy", -fee);
        state.txnSeq += 1;
        state.transactions.push({
          transactionId: `txn-${state.txnSeq.toString().padStart(4, "0")}`,
          time: Game.time,
          sender: { username: "slice0-user" },
          recipient: { username: "slice0-user" },
          resourceType: intent.resourceType,
          amount,
          from: intent.sourceRoomName,
          to: intent.targetRoomName,
          description: intent.description,
        });
        state.cooldownUntil[intent.sourceRoomName] = Game.time + TERMINAL_COOLDOWN_TICKS;
      }
    },

    transactionsView: {
      outgoingTransactions(): readonly TerminalTransactionRecord[] {
        if (state.viewConfig.failOutgoing) throw new Error("交易视图读取异常（outgoing）——M06 场景");
        if (state.viewConfig.dropAll === true) return [];
        return [...state.transactions, ...(state.viewConfig.injected ?? [])];
      },
      incomingTransactions(): readonly TerminalTransactionRecord[] {
        if (state.viewConfig.failIncoming) throw new Error("交易视图读取异常（incoming）——M06 场景");
        if (state.viewConfig.dropAll === true) return [];
        return [...state.transactions, ...(state.viewConfig.injected ?? [])];
      },
    },

    get viewConfig() {
      return state.viewConfig;
    },

    configureFeeDrift(driftBy: number): void {
      state.feeDrift = driftBy;
    },

    captureBranch(): TerminalTransferHostBranchMarker {
      const copy = {
        pending: state.pending.slice(),
        transactions: state.transactions.slice(),
        submits: state.submits.slice(),
        txnSeq: state.txnSeq,
        feeDrift: state.feeDrift,
        cooldownUntil: { ...state.cooldownUntil },
      };
      return {
        kind: "treasury-journal-branch",
        count: copy.submits.length + copy.transactions.length + copy.pending.length,
        source: host,
        reopen(): void {
          state.pending = copy.pending.slice();
          state.transactions = copy.transactions.slice();
          state.submits = copy.submits.slice();
          state.txnSeq = copy.txnSeq;
          state.feeDrift = copy.feeDrift;
          state.cooldownUntil = { ...copy.cooldownUntil };
          state.branchEpoch += 1;
        },
      };
    },

    get submits(): readonly SubmittedSendCall[] {
      return state.submits;
    },
    get pendingCount(): number {
      return state.pending.length;
    },
    get transactions(): readonly TerminalTransactionRecord[] {
      return state.transactions;
    },
  };
  return host;
}

// ── adapter 原型（仅测试装配；不进生产 actionContracts.ts 注册表） ──────────

/** durable facts payload（提交前库存基线——reconcile 的终态核对锚点）。 */
interface Slice0DurablePayload {
  readonly k: string;
  readonly a: number;
  readonly f: number;
  readonly sb: readonly [number, number];
  readonly tb: readonly [number];
}

/** 受控编码（kernel payload 字符集排除 `"` 与 `\`；键为安全 ASCII 无分隔符注入）。 */
function encodeSlice0Payload(p: Slice0DurablePayload): string {
  return `k:${p.k}|a:${String(p.a)}|f:${String(p.f)}|sb:${String(p.sb[0])},${String(p.sb[1])}|tb:${String(p.tb[0])}`;
}

function decodeSlice0Payload(raw: string): Slice0DurablePayload | null {
  const parts = raw.split("|");
  if (parts.length !== 5) return null;
  const [k, a, f, sb, tb] = parts as [string, string, string, string, string];
  if (!k.startsWith("k:") || !a.startsWith("a:") || !f.startsWith("f:") || !sb.startsWith("sb:") || !tb.startsWith("tb:")) {
    return null;
  }
  const sbParts = sb.slice(3).split(",");
  const numbers = [Number(a.slice(2)), Number(f.slice(2)), Number(sbParts[0]), Number(sbParts[1] ?? ""), Number(tb.slice(3))];
  if (numbers.some((n) => !Number.isSafeInteger(n) || n < 0)) return null;
  return { k: k.slice(2), a: numbers[0]!, f: numbers[1]!, sb: [numbers[2]!, numbers[3]!], tb: [numbers[4]!] };
}

/** 解码 durable payload（导出测试断言用；不可解释返回 null）。 */
export function decodeSlice0DurablePayload(raw: string): Slice0DurablePayload | null {
  return decodeSlice0Payload(raw);
}

function readRoomStock(roomName: string, resource: string): number {
  const store = hostRooms()[roomName]?.terminal?.store;
  return store === undefined ? 0 : (store[resource] ?? 0);
}

export interface TerminalTransferPrototypeAdapter extends TreasuryActionAdapter<TerminalTransferArgs, TerminalTransferSubmitResult> {
  /** 事件来源（复用 harness 恢复装配的来源关联核实——同 host 对象配对）。 */
  readonly journal: TerminalTransferFakeHost;
}

export function makeTerminalTransferPrototypeAdapter(
  host: TerminalTransferFakeHost,
): TerminalTransferPrototypeAdapter {
  return {
    kind: SLICE0_ACTION_KIND,
    version: 1,
    semanticIdentity: "slice0.terminal-send@engine-delayed-transfer-v1",
    // §4.2：execute 的 OK 只是 submit 已调度——世界效果发生在后续处理阶段。
    settlesOnAccept: false,
    // §4.2：保守 unknown——不按任意 false/未知数字猜测 not_executed。
    nonOkOutcome: "unknown",
    journal: host,

    validate(args: unknown): string | null {
      if (args === null || typeof args !== "object") return "args 非对象";
      const candidate = args as Partial<TerminalTransferArgs>;
      if (typeof candidate.sourceRoomName !== "string" || !ROOM_NAME_PATTERN.test(candidate.sourceRoomName)) {
        return "sourceRoomName 非法（须 W/E+N/S 房间名）";
      }
      if (typeof candidate.targetRoomName !== "string" || !ROOM_NAME_PATTERN.test(candidate.targetRoomName)) {
        return "targetRoomName 非法（须 W/E+N/S 房间名）";
      }
      if (candidate.sourceRoomName === candidate.targetRoomName) return "源/目标房间相同";
      if (candidate.resourceType !== SLICE0_TRANSFER_RESOURCE) {
        return `resourceType 超出本 slice 范围（仅支持 ${SLICE0_TRANSFER_RESOURCE}）`;
      }
      if (candidate.amount !== SLICE0_TRANSFER_AMOUNT) {
        return `amount 超出本 slice 范围（原型夹具值仅支持 ${String(SLICE0_TRANSFER_AMOUNT)}）`;
      }
      if (typeof candidate.correlationKey !== "string" || !CORRELATION_KEY_PATTERN.test(candidate.correlationKey)) {
        return "correlationKey 非法（安全 ASCII，1..32 字符）";
      }
      return null;
    },

    derivePostings(args: TerminalTransferArgs): readonly { roomName: string; locationKind: string; resource: string; delta: number }[] {
      // §4.1：三腿责任（源 −100H、源 −fee energy、目标 +100H 接收空间）；
      // fee 从可信报价端口派生（canonical 参数之外无第二参数来源）。
      const fee = host.quoteTransferFee(args.amount, args.sourceRoomName, args.targetRoomName);
      return [
        { roomName: args.sourceRoomName, locationKind: "terminal", resource: args.resourceType, delta: -args.amount },
        { roomName: args.sourceRoomName, locationKind: "terminal", resource: "energy", delta: -fee },
        { roomName: args.targetRoomName, locationKind: "terminal", resource: args.resourceType, delta: args.amount },
      ];
    },

    structureBindings(args: TerminalTransferArgs): readonly TreasuryActionStructureBinding[] {
      return [
        { roomName: args.sourceRoomName, locationKind: "terminal", role: "source" },
        { roomName: args.sourceRoomName, locationKind: "terminal", role: "fee_source" },
        { roomName: args.targetRoomName, locationKind: "terminal", role: "target" },
      ];
    },

    durableFacts(args: TerminalTransferArgs): TreasuryDurableFacts {
      const fee = host.quoteTransferFee(args.amount, args.sourceRoomName, args.targetRoomName);
      const payload: Slice0DurablePayload = {
        k: args.correlationKey,
        a: args.amount,
        f: fee,
        sb: [readRoomStock(args.sourceRoomName, args.resourceType), readRoomStock(args.sourceRoomName, "energy")],
        tb: [readRoomStock(args.targetRoomName, args.resourceType)],
      };
      // 受控可打印字符集（排除 " 与 \）——不用 JSON.stringify（引号会被
      // validator 拒绝）；correlationKey 限安全 ASCII（不含分隔符，无注入面）。
      return { version: 1, payload: encodeSlice0Payload(payload) };
    },

    execute(args: TerminalTransferArgs): TerminalTransferSubmitResult {
      // §4.2：恰好一次 submit；报价一致性比对在 submit 端口内部完成
      // （与 derivePostings 派生时点的冻结报价比对——漂移即拒绝）。
      return host.submitTerminalSend({
        sourceRoomName: args.sourceRoomName,
        targetRoomName: args.targetRoomName,
        resourceType: args.resourceType,
        amount: args.amount,
        description: descriptionFor(args),
      });
    },

    // §4.3：只接收公开形态证据。永不返回 observed_not_executed——源码事实
    // 是处理阶段多条静默丢弃路径无任何记录，查询不到交易不能证明未执行。
    reconcile(
      facts: { transactionId: string; durablePayload?: string; postings?: readonly unknown[] },
      _observation: unknown,
    ): TreasuryActionReconcilerConclusion {
      let payload: Slice0DurablePayload | null;
      try {
        payload = decodeSlice0Payload(String(facts.durablePayload ?? ""));
        if (payload === null || typeof payload.k !== "string" || payload.k.length === 0) {
          return "still_uncertain";
        }
      } catch {
        return "still_uncertain"; // facts 不可解释——保守保留
      }
      let outgoing: readonly TerminalTransactionRecord[];
      let incoming: readonly TerminalTransactionRecord[];
      try {
        outgoing = host.transactionsView.outgoingTransactions();
        incoming = host.transactionsView.incomingTransactions();
      } catch {
        return "still_uncertain"; // 读异常——保守保留（不被解释为完成）
      }
      // 关联键匹配 + 排除市场订单记录（order 字段）+ 公开形态字段核对。
      const matches = outgoing.filter(
        (record) =>
          record.description !== undefined &&
          record.description.includes(payload.k) &&
          record.order === undefined &&
          record.resourceType === SLICE0_TRANSFER_RESOURCE,
      );
      if (matches.length === 0) return "still_uncertain";
      // 多个不同交易 ID 同时匹配——不能选定唯一事实。
      const distinctIds = new Set(matches.map((record) => record.transactionId));
      if (distinctIds.size > 1) return "still_uncertain";
      const matched = matches[0]!;
      // 两视图同一交易 ID 是同一条事实（不重复计数）；同 ID 内容矛盾则阻断。
      const mirrored = incoming.filter((record) => record.transactionId === matched.transactionId);
      if (
        mirrored.some(
          (record) =>
            record.resourceType !== matched.resourceType ||
            record.amount !== matched.amount ||
            record.from !== matched.from ||
            record.to !== matched.to,
        )
      ) {
        return "still_uncertain";
      }
      // 部分转运（请求 100、实际 60）不报全量——保守责任，不补发不重执行。
      if (matched.amount !== payload.a) return "still_uncertain";
      // 时点：处理发生在 tick T 后期，效果与记录对 T+1 的脚本可见——
      // 当前 tick 不早于效果可见时点才允许下结论。
      if (Game.time <= matched.time) return "still_uncertain";
      // 隔离场景库存终态核对（提交前基线存 durable facts；§3.1 保证无并发业务）。
      const sourceH = readRoomStock(matched.from, SLICE0_TRANSFER_RESOURCE);
      const sourceEnergy = readRoomStock(matched.from, "energy");
      const targetH = readRoomStock(matched.to, SLICE0_TRANSFER_RESOURCE);
      if (
        sourceH !== payload.sb[0]! - payload.a ||
        sourceEnergy !== payload.sb[1]! - payload.f ||
        targetH !== payload.tb[0]! + payload.a
      ) {
        return "still_uncertain";
      }
      return "observed_committed";
    },
  };
}

// ── 场景房间规格（§3.1：同用户、同 shard、结构可用、源资源与费用能源充足） ──

export function slice0SceneRooms(overrides: { targetFreeCapacity?: number } = {}): RoomSpec[] {
  return [
    {
      name: "W1N57",
      terminal: { id: "term-A", resources: { H: 1000, energy: 10_000 }, freeCapacity: 100_000 },
    },
    {
      name: "W10N57",
      terminal: {
        id: "term-B",
        resources: { energy: 2000 },
        freeCapacity: overrides.targetFreeCapacity ?? 100_000,
      },
    },
  ];
}
