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
 *
 * Remediation I（N01–N06）修订：
 * - §4.1 期望值先存在：canonical 参数在准备时一次取值（冻结费用 q、准备
 *   tick、余额基线），此后 derivePostings/durableFacts 是纯函数——重复
 *   派生（build/authorize 的 buildIdentityFacts）不再重新抓取报价/余额，
 *   digest、postings 与持久事实始终代表同一准备时刻（R7）。
 * - §4.2 完整交易归属：reconcile 的期望路线/双方/资源/全量/描述/身份/
 *   时点全部来自持久 payload v2，不从候选记录反推；完整描述严格相等
 *   （不用 includes）；同 ID 全部副本先验一致性（顺序无关）再归并；旧
 *   记录（早于准备 tick）不认领；多 ID 不任选；市场订单不作 send 证据。
 * - §6 冻结费用：移除 lastQuote 作为比较权威（R3）——adapter.execute 在
 *   调用 submit 端口**之前**以当前可信报价复验冻结 q（与业务前检共享
 *   verifySlice0FeeQuote 纯比较逻辑）；报价读异常/非法值同样零提交。
 *   submit 端口保留宿主接受语义，不再替 adapter 隐藏"比较发生在调用
 *   之后"的错误。
 * - 旧 v1 payload（无 v2 前缀）不可解释——保守 still_uncertain，不猜测
 *   补齐身份，不静默升级。
 *
 * Remediation II（O01/O02）修订：
 * - §3.2 归集与全量分离："属于本请求"与"满足全量完成条件"是两步——相关
 *   性依据完整描述/期望路线/双方/资源/send 类别（order 排除）判定，实际
 *   amount 不是丢弃相关交易的条件；相关 ID 全部副本仍先验一致性。唯一
 *   相关交易确定后才检查恰好全量（amount===payload.a）及其余完成条件。
 *   100+60 歧义不再因全量过滤而丢失 60；只有一条相关 60H 同样拒绝。
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
/** 合成用户身份（宿主生成记录与 durable payload 的同一权威；§4.1）。 */
export const SLICE0_USERNAME = "slice0-user" as const;

/** 原型假设：受控世界尺寸（费用距离的环形取短计算用；真实环境待实测核对）。 */
const PROTOTYPE_WORLD_SIZE = 128;
/** 源码事实：engine 常量 TERMINAL_COOLDOWN 的文档值（本场景单条在途，测试不依赖其推进）。 */
const TERMINAL_COOLDOWN_TICKS = 10;
const ROOM_NAME_PATTERN = /^(W|E)\d+(N|S)\d+$/;
const CORRELATION_KEY_PATTERN = /^[A-Za-z0-9-]{1,32}$/;

/**
 * 准备时一次取值的不可变事实（§4.1/§6.1）——由 prepareSlice0TransferArgs
 * 从可信端口/世界读取，进入 canonical 后不再变化；derivePostings/
 * durableFacts/execute 全部只从这份固定输入取值。
 */
export interface TerminalTransferPreparedFacts {
  /** 冻结费用 q（可信报价端口一次读取；执行前以当前报价复验）。 */
  readonly feeQuote: number;
  /** 准备时 tick（交易时点窗下界：记录不早于本请求合法提交范围）。 */
  readonly preparedAtTick: number;
  /** 提交前余额基线（reconcile 终态核对锚点）。 */
  readonly baseline: {
    readonly sourceH: number;
    readonly sourceEnergy: number;
    readonly targetH: number;
  };
}

/** canonical 参数（单一参数来源，§4.1；description 由它派生，调用者不能另传）。 */
export interface TerminalTransferArgs {
  readonly sourceRoomName: string;
  readonly targetRoomName: string;
  readonly resourceType: typeof SLICE0_TRANSFER_RESOURCE;
  readonly amount: typeof SLICE0_TRANSFER_AMOUNT;
  readonly correlationKey: string;
  /** Remediation I：准备事实随 canonical 冻结（不可变；派生纯函数化）。 */
  readonly prepared: TerminalTransferPreparedFacts;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readRoomStock(roomName: string, resource: string): number {
  const store = hostRooms()[roomName]?.terminal?.store;
  return store === undefined ? 0 : (store[resource] ?? 0);
}

/**
 * 准备一条不可变请求：从显式可信假报价端口读取一次 q，同时取准备时
 * tick 与余额基线（§4.1"期望值先存在，再读取候选记录"；§6.1"报价只读，
 * 本次预算不可被查询覆盖"）。业务路径只经本函数形成 canonical——对外
 * 调用者不能自行填写一个更低费用获得预算（执行前复验会拦截）。
 */
export function prepareSlice0TransferArgs(
  host: TerminalTransferFakeHost,
  sourceRoomName: string,
  targetRoomName: string,
  correlationKey: string,
): TerminalTransferArgs {
  const feeQuote = host.quoteTransferFee(SLICE0_TRANSFER_AMOUNT, sourceRoomName, targetRoomName);
  return {
    sourceRoomName,
    targetRoomName,
    resourceType: SLICE0_TRANSFER_RESOURCE,
    amount: SLICE0_TRANSFER_AMOUNT,
    correlationKey,
    prepared: {
      feeQuote,
      preparedAtTick: Game.time,
      baseline: {
        sourceH: readRoomStock(sourceRoomName, SLICE0_TRANSFER_RESOURCE),
        sourceEnergy: readRoomStock(sourceRoomName, "energy"),
        targetH: readRoomStock(targetRoomName, SLICE0_TRANSFER_RESOURCE),
      },
    },
  };
}

/** 用户可见 description（确定编码；安全 ASCII 关联键固定嵌入；≤100 字符——§4.3）。 */
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

/**
 * 视图行为配置（M06/N02 负向场景；默认全量、无异常。字段可变——测试按
 * 场景改写，宿主每次读取当前值）。
 */
export interface TerminalTransactionsViewConfig {
  /** 模拟历史被挤出（返回空——查询不到不能证明未执行）。 */
  dropAll?: boolean;
  /** 模拟指定视图读取异常（reconcile 须保守保留 unknown）。 */
  failOutgoing?: boolean;
  failIncoming?: boolean;
  /** 注入额外公开记录（两视图都拼接——他人交易/旧请求/市场订单/重复 ID 噪声）。 */
  injected?: TerminalTransactionRecord[];
  /** 仅注入 outgoing 视图（N02 镜像矛盾：同 ID 两视图内容不同）。 */
  injectedOutgoing?: TerminalTransactionRecord[];
  /** 仅注入 incoming 视图。 */
  injectedIncoming?: TerminalTransactionRecord[];
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
  /** 只读费用报价端口（只读——不保存"最后一次报价"，无跨请求可变权威；可配置漂移/读异常）。 */
  quoteTransferFee(amount: number, fromRoomName: string, toRoomName: string): number;
  /** 只读交易视图（reconcile 的唯一记录来源）。 */
  readonly transactionsView: TerminalTransactionsView;
  /** 视图行为配置（负向场景由测试按场景改写；默认关闭全部注入）。 */
  readonly viewConfig: TerminalTransactionsViewConfig;
  /** 报价漂移配置：此后每次报价 +driftBy（模拟报价上行——陈旧偏低预算不得继续调用）。 */
  configureFeeDrift(driftBy: number): void;
  /** 报价读取异常配置（N05：端口 throw——前检/guard 须零提交拒绝）。 */
  configureQuoteFailure(fail: boolean): void;
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
  quoteFailure: boolean;
  cooldownUntil: Record<string, number>;
  branchEpoch: number;
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
    quoteFailure: false,
    cooldownUntil: {},
    branchEpoch: 0,
  };

  const host: TerminalTransferFakeHost = {
    // §6.1 报价只读：纯计算（+配置的漂移/读异常），不保存任何"最后一次
    // 报价"——旧请求的比较权威是 canonical 冻结 q，不是查询历史（R3）。
    quoteTransferFee(amount, fromRoomName, toRoomName): number {
      if (state.quoteFailure) throw new Error("报价端口读取异常（N05 场景）");
      const range = slice0RoomsDistance(fromRoomName, toRoomName);
      if (range === null) throw new Error(`报价端口：房间名非法（${fromRoomName}→${toRoomName}）`);
      return slice0TerminalEnergyCost(amount, range) + state.feeDrift;
    },

    submitTerminalSend(input): TerminalTransferSubmitResult {
      // 重放 engine API 层（structures.js send）的同步前置检查——全部通过
      // 才"写入 send intent"（这里入 pending）。OK 只表示已调度。宿主只做
      // 引擎层自身检查（§6.2：不做费用一致性比较——那是 adapter guard 在
      // 调用本端口**之前**的职责，宿主不得替其隐藏时序错误）。
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
          sender: { username: SLICE0_USERNAME },
          recipient: { username: SLICE0_USERNAME },
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
        return [
          ...state.transactions,
          ...(state.viewConfig.injected ?? []),
          ...(state.viewConfig.injectedOutgoing ?? []),
        ];
      },
      incomingTransactions(): readonly TerminalTransactionRecord[] {
        if (state.viewConfig.failIncoming) throw new Error("交易视图读取异常（incoming）——M06 场景");
        if (state.viewConfig.dropAll === true) return [];
        return [
          ...state.transactions,
          ...(state.viewConfig.injected ?? []),
          ...(state.viewConfig.injectedIncoming ?? []),
        ];
      },
    },

    get viewConfig() {
      return state.viewConfig;
    },

    configureFeeDrift(driftBy: number): void {
      state.feeDrift = driftBy;
    },

    configureQuoteFailure(fail: boolean): void {
      state.quoteFailure = fail;
    },

    captureBranch(): TerminalTransferHostBranchMarker {
      const copy = {
        pending: state.pending.slice(),
        transactions: state.transactions.slice(),
        submits: state.submits.slice(),
        txnSeq: state.txnSeq,
        feeDrift: state.feeDrift,
        quoteFailure: state.quoteFailure,
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
          state.quoteFailure = copy.quoteFailure;
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

// ── 冻结费用复验（§6.2：业务前检与 adapter guard 共享的纯比较逻辑） ──────────

export type Slice0FeeQuoteCheck =
  | { readonly ok: true; readonly currentFee: number }
  | { readonly ok: false; readonly code: "ERR_FEE_QUOTE_DRIFTED" | "ERR_FEE_QUOTE_UNAVAILABLE" };

/**
 * 以当前可信报价复验 canonical 冻结 q（§6.1/§6.2）。比较基准只能来自该
 * 请求已绑定许可的 canonical 数据；报价读异常/非法值同样拒绝。本函数纯
 * 比较——不建立第二授权体系；调用方据此在 submit 端口被调用**之前**拒绝。
 */
export function verifySlice0FeeQuote(
  host: TerminalTransferFakeHost,
  args: TerminalTransferArgs,
): Slice0FeeQuoteCheck {
  let currentFee: number;
  try {
    currentFee = host.quoteTransferFee(args.amount, args.sourceRoomName, args.targetRoomName);
  } catch {
    return { ok: false, code: "ERR_FEE_QUOTE_UNAVAILABLE" };
  }
  if (!Number.isSafeInteger(currentFee) || currentFee < 1) {
    return { ok: false, code: "ERR_FEE_QUOTE_UNAVAILABLE" };
  }
  if (currentFee !== args.prepared.feeQuote) {
    return { ok: false, code: "ERR_FEE_QUOTE_DRIFTED" };
  }
  return { ok: true, currentFee };
}

// ── adapter 原型（仅测试装配；不进生产 actionContracts.ts 注册表） ──────────

/**
 * durable facts payload v2（Remediation I）：期望身份的全部事实——关联键、
 * 期望路线（源/目标）、全量、冻结费用、提交前基线、准备 tick、合成用户
 * 身份。reconcile 只从这份持久事实生成期望值，不从候选记录反推（R1）。
 */
interface Slice0DurablePayload {
  readonly k: string;
  readonly s: string;
  readonly d: string;
  readonly a: number;
  readonly f: number;
  readonly sb: readonly [number, number];
  readonly tb: readonly [number];
  readonly t: number;
  readonly u: string;
}

/** 受控编码（kernel payload 字符集排除 `"` 与 `\`；键/房间名/用户名为安全 ASCII 无分隔符注入）。 */
function encodeSlice0Payload(p: Slice0DurablePayload): string {
  return [
    "v2",
    `k:${p.k}`,
    `s:${p.s}`,
    `d:${p.d}`,
    `a:${String(p.a)}`,
    `f:${String(p.f)}`,
    `sb:${String(p.sb[0])},${String(p.sb[1])}`,
    `tb:${String(p.tb[0])}`,
    `t:${String(p.t)}`,
    `u:${p.u}`,
  ].join("|");
}

/** v2 严格解码：10 段、固定字段序、数字段非负安全整数；任何无法解释返回 null（保守，不猜测）。 */
function decodeSlice0Payload(raw: string): Slice0DurablePayload | null {
  const parts = raw.split("|");
  if (parts.length !== 10 || parts[0] !== "v2") return null;
  const [k, s, d, a, f, sb, tb, t, u] = parts.slice(1) as [string, string, string, string, string, string, string, string, string];
  if (!k.startsWith("k:") || !s.startsWith("s:") || !d.startsWith("d:") || !a.startsWith("a:") || !f.startsWith("f:") || !sb.startsWith("sb:") || !tb.startsWith("tb:") || !t.startsWith("t:") || !u.startsWith("u:")) {
    return null;
  }
  const sbParts = sb.slice(3).split(",");
  const numbers = [
    Number(a.slice(2)),
    Number(f.slice(2)),
    Number(sbParts[0] ?? ""),
    Number(sbParts[1] ?? ""),
    Number(tb.slice(3)),
    Number(t.slice(2)),
  ];
  if (numbers.some((n) => !isNonNegativeSafeInteger(n))) return null;
  const key = k.slice(2);
  const src = s.slice(2);
  const dst = d.slice(2);
  const user = u.slice(2);
  if (key.length === 0 || src.length === 0 || dst.length === 0 || user.length === 0) return null;
  return { k: key, s: src, d: dst, a: numbers[0]!, f: numbers[1]!, sb: [numbers[2]!, numbers[3]!], tb: [numbers[4]!], t: numbers[5]!, u: user };
}

/** 解码 durable payload（导出测试断言用；不可解释——含旧 v1——返回 null）。 */
export function decodeSlice0DurablePayload(raw: string): Slice0DurablePayload | null {
  return decodeSlice0Payload(raw);
}

/** 同 ID 副本一致性：全部相关字段（描述/双方/身份/路线/资源/金额/时点/order 属性）逐一相等。 */
function slice0RecordsIdentical(a: TerminalTransactionRecord, b: TerminalTransactionRecord): boolean {
  return (
    a.time === b.time &&
    a.sender?.username === b.sender?.username &&
    a.recipient?.username === b.recipient?.username &&
    a.resourceType === b.resourceType &&
    a.amount === b.amount &&
    a.from === b.from &&
    a.to === b.to &&
    a.description === b.description &&
    a.order?.id === b.order?.id &&
    (a.order === undefined) === (b.order === undefined)
  );
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
    // Remediation I：payload v2 + 冻结费用契约——协议语义变化，版本与
    // semanticIdentity 同步升级；旧 v1 identity 的记录不会被新 reconciler
    // 静默认领（facade 按 identity 匹配，不匹配则保持 unknown）。
    version: 2,
    semanticIdentity: "slice0.terminal-send@engine-delayed-transfer-v2",
    // §4.2：execute 的 OK 只是 submit 已调度——世界效果发生在后续处理阶段。
    settlesOnAccept: false,
    // §4.2：保守 unknown——不按任意 false/未知数字猜测 not_executed。
    nonOkOutcome: "unknown",
    journal: host,

    validate(args: unknown): string | null {
      if (args === null || typeof args !== "object") return "args 非对象";
      const candidate = args as Partial<TerminalTransferArgs> & { prepared?: Partial<TerminalTransferPreparedFacts> };
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
      // Remediation I：准备事实必须随 canonical 提供且形状合法（一次取值，
      // 不接受缺失/畸形的冻结费用与基线）。
      const prepared = candidate.prepared;
      if (prepared === null || typeof prepared !== "object") {
        return "prepared 缺失——须经 prepareSlice0TransferArgs 一次取值（冻结费用/基线/准备 tick）";
      }
      if (typeof prepared.feeQuote !== "number" || !Number.isSafeInteger(prepared.feeQuote) || prepared.feeQuote < 1) {
        return "prepared.feeQuote 非法（正整数——冻结费用）";
      }
      if (!isNonNegativeSafeInteger(prepared.preparedAtTick)) {
        return "prepared.preparedAtTick 非法（非负整数）";
      }
      const baseline = prepared.baseline;
      if (baseline === null || typeof baseline !== "object") return "prepared.baseline 缺失";
      if (!isNonNegativeSafeInteger(baseline.sourceH) || !isNonNegativeSafeInteger(baseline.sourceEnergy) || !isNonNegativeSafeInteger(baseline.targetH)) {
        return "prepared.baseline 非法（三项均须非负整数）";
      }
      return null;
    },

    // §4.1（Remediation I 纯函数化）：三腿责任的 fee 来自 canonical 冻结
    // q——不在此处查询报价（build/authorize 重复派生得到同一集合）。
    derivePostings(args: TerminalTransferArgs): readonly { roomName: string; locationKind: string; resource: string; delta: number }[] {
      return [
        { roomName: args.sourceRoomName, locationKind: "terminal", resource: args.resourceType, delta: -args.amount },
        { roomName: args.sourceRoomName, locationKind: "terminal", resource: "energy", delta: -args.prepared.feeQuote },
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

    // §4.1（Remediation I 纯函数化）：durable payload 只编码 canonical 已
    // 冻结的事实——重复派生（build 与 authorize 的 buildIdentityFacts）
    // 输出恒等，不再重新抓取报价/余额/时间（R7）。
    durableFacts(args: TerminalTransferArgs): TreasuryDurableFacts {
      const payload: Slice0DurablePayload = {
        k: args.correlationKey,
        s: args.sourceRoomName,
        d: args.targetRoomName,
        a: args.amount,
        f: args.prepared.feeQuote,
        sb: [args.prepared.baseline.sourceH, args.prepared.baseline.sourceEnergy],
        tb: [args.prepared.baseline.targetH],
        t: args.prepared.preparedAtTick,
        u: SLICE0_USERNAME,
      };
      // 受控可打印字符集（排除 " 与 \）——不用 JSON.stringify（引号会被
      // validator 拒绝）；correlationKey 限安全 ASCII（不含分隔符，无注入面）。
      return { version: 2, payload: encodeSlice0Payload(payload) };
    },

    execute(args: TerminalTransferArgs): TerminalTransferSubmitResult {
      // §6.2：调用 submit 端口**之前**以当前可信报价复验冻结 q（与业务前检
      // 共享 verifySlice0FeeQuote）——漂移/读异常/非法值时零提交（submit
      // 端口的接受语义保持引擎层原样，不在此处之后才发现不一致）。
      const feeCheck = verifySlice0FeeQuote(host, args);
      if (feeCheck.ok !== true) return { ok: false, code: feeCheck.code };
      return host.submitTerminalSend({
        sourceRoomName: args.sourceRoomName,
        targetRoomName: args.targetRoomName,
        resourceType: args.resourceType,
        amount: args.amount,
        description: descriptionFor(args),
      });
    },

    // §4.2/§4.3（Remediation I 重写）：只接收公开形态证据；期望值全部来自
    // 持久 payload v2，不从候选记录反推。永不返回 observed_not_executed——
    // 处理阶段多条静默丢弃路径无任何记录，查询不到交易不能证明未执行。
    reconcile(
      facts: { transactionId: string; durablePayload?: string; postings?: readonly unknown[] },
      _observation: unknown,
    ): TreasuryActionReconcilerConclusion {
      let payload: Slice0DurablePayload | null;
      try {
        payload = decodeSlice0Payload(String(facts.durablePayload ?? ""));
      } catch {
        return "still_uncertain"; // facts 不可解释——保守保留
      }
      if (payload === null) return "still_uncertain"; // 旧 v1/畸形——不猜测补齐身份
      let outgoing: readonly TerminalTransactionRecord[];
      let incoming: readonly TerminalTransactionRecord[];
      try {
        outgoing = host.transactionsView.outgoingTransactions();
        incoming = host.transactionsView.incomingTransactions();
      } catch {
        return "still_uncertain"; // 读异常——保守保留（不被解释为完成）
      }
      // 期望值先存在（§4.1）：完整描述确定编码、严格相等——不用
      // includes/startsWith/模糊匹配。
      const expectedDescription = `treasury-slice0 ${payload.k}`;
      // 相关性匹配（Remediation II §3.2：与全量完成条件分离）：描述、期望
      // 路线（源/目标）、双方身份、资源、非市场订单（order 字段）——全部
      // 来自持久 payload。**实际 amount 不是丢弃相关交易的条件**——部分量
      // 记录保留在归集结果里参与唯一性判定（不同 ID 的 100+60 不能先把 60
      // 过滤掉再宣称唯一）。
      const relatedMatch = (record: TerminalTransactionRecord): boolean =>
        record.description === expectedDescription &&
        record.from === payload.s &&
        record.to === payload.d &&
        record.sender?.username === payload.u &&
        record.recipient?.username === payload.u &&
        record.resourceType === SLICE0_TRANSFER_RESOURCE &&
        record.order === undefined;
      // 1) 按交易 ID 分组（两视图合并；同视图重复也在组内）。
      const groups = new Map<string, { view: string; record: TerminalTransactionRecord }[]>();
      for (const [view, list] of [["outgoing", outgoing], ["incoming", incoming]] as const) {
        for (const record of list) {
          const copies = groups.get(record.transactionId) ?? [];
          copies.push({ view, record });
          groups.set(record.transactionId, copies);
        }
      }
      // 2) 相关组（组内任一副本相关匹配）：先验同 ID 全部副本一致性
      // （顺序无关——不能把矛盾镜像先过滤掉再比较）；矛盾整体阻断；一致
      // 归并为一条。无关键录（他人交易/市场订单/无关噪声）不阻断。
      const candidates: TerminalTransactionRecord[] = [];
      for (const copies of groups.values()) {
        if (!copies.some((c) => relatedMatch(c.record))) continue;
        if (!copies.every((c) => slice0RecordsIdentical(c.record, copies[0]!.record))) {
          return "still_uncertain"; // 同 ID 相关记录矛盾——保守阻断
        }
        candidates.push(copies[0]!.record);
      }
      // 3) 时点窗（§4.2）：不早于本请求合法提交范围（>= 准备 tick——本请求
      // 之前的旧记录不被认领）；不晚于当前可见时点（< Game.time——当前
      // tick 未处理完时单纯刷新观察不结算）。
      const visible = candidates.filter((r) => r.time >= payload.t && Game.time > r.time);
      // 4) 多个不同交易 ID 都可能属于同一请求——不能任选一个成功记录。
      if (visible.length !== 1) return "still_uncertain";
      const matched = visible[0]!;
      // 4b) 全量完成条件（Remediation II §3.2）：归集与全量分离——唯一性
      // 判定之前不按 amount 过滤，唯一相关交易确定后才检查恰好全量。只有
      // 一条相关 60H 同样拒绝（不补发、不报 not_executed、保守保留责任）。
      if (matched.amount !== payload.a) return "still_uncertain";
      // 5) 库存终态核对——只检查期望端点（源/目标房间来自持久 payload，
      // 非 matched.from/to）；部分量已在 4b 被全量条件拒绝（到达此处即
      // 唯一且全量）。
      if (
        readRoomStock(payload.s, SLICE0_TRANSFER_RESOURCE) !== payload.sb[0]! - payload.a ||
        readRoomStock(payload.s, "energy") !== payload.sb[1]! - payload.f ||
        readRoomStock(payload.d, SLICE0_TRANSFER_RESOURCE) !== payload.tb[0]! + payload.a
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
