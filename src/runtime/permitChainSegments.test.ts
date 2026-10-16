import { createPermitChainSegmentStore } from "@/runtime/permitChainSegments";
import { getPermitChainContainer, isPermitChainStorageReady, setPermitChainStorageBlocked } from "@/runtime/permitChainStorageGuard";
import { ensureDataState } from "@/runtime/marketSaleDataState";
import { executeMarketDeal, executeTerminalAction, executeCreateOrder } from "@/runtime/marketActionArbiter";
import { getMarketSaleTerminalExposure, getTerminalAmountsOutsideMarketSaleExposure } from "@/runtime/marketSaleExposure";

describe("许可链双 bank 迁移与堆缓存", () => {
  const original = { revision: 1, entries: [{ id: "原始许可", evidence: "x".repeat(1000) }] };
  let store: ReturnType<typeof createPermitChainSegmentStore>;
  let persisted: string;
  let physical: Record<number, string>;
  let requested: number[];
  let savedRaw: PropertyDescriptor | undefined;
  function chain(): any { return getPermitChainContainer(Memory)!.permitChain; }
  function tick(time: number): void {
    Game.time = time;
    Object.defineProperty(globalThis, "Memory", { value: JSON.parse(persisted), writable: true, configurable: true });
    Object.defineProperty(globalThis, "RawMemory", { value: {
      segments: Object.fromEntries(requested.map(id => [id, physical[id] ?? ""])),
      setActiveSegments: jest.fn((ids: number[]) => { requested = ids; }) }, writable: true, configurable: true });
    store.begin();
  }
  function save(drop?: number): void {
    for (const [id, text] of Object.entries(RawMemory.segments)) if (Number(id) !== drop) physical[Number(id)] = text;
    persisted = JSON.stringify(store.project(Memory));
  }
  function activate(): void {
    tick(1); store.prepare(); save();
    tick(2); store.prepare();
    expect(Memory.data!.permitChainSegments!.pending).toBeDefined();
    expect(store.project(Memory).data!.permitChainSegments!.mode).toBe("inline");
    save();
    tick(3); store.prepare(); save();
    expect(JSON.parse(persisted).data.permitChainSegments.mode).toBe("segments");
  }
  beforeEach(() => {
    savedRaw = Object.getOwnPropertyDescriptor(globalThis, "RawMemory");
    Game.cpu = { bucket: 10000, tickLimit: 500, getUsed: () => 0 } as typeof Game.cpu;
    Game.shard = { name: "shard1" } as Game["shard"];
    persisted = JSON.stringify({ cfg: { memoryStorage: { permitChain: { enabled: true, banks: [[81, 82], [83, 84]] } } },
      data: { marketSaleAutomation: { directAutomation: { baseResourceV3: { permitChain: original } } } } });
    physical = {}; requested = []; store = createPermitChainSegmentStore();
  });
  afterEach(() => {
    if (savedRaw) Object.defineProperty(globalThis, "RawMemory", savedRaw);
    else Reflect.deleteProperty(globalThis, "RawMemory");
    setPermitChainStorageBlocked();
  });

  it("激活延迟、保留 inline、跨 tick 回读、热堆命中和 global reset 冷启动", () => {
    activate();
    const source = JSON.stringify(original);
    tick(4);
    expect(JSON.stringify(chain())).toBe(source);
    expect(Object.isFrozen(chain().entries[0])).toBe(true);
    expect(store.status()).toEqual(expect.objectContaining({ decodes: 1, hits: 1, activated: 1 }));
    store.prepare(); save();
    store = createPermitChainSegmentStore(); tick(5);
    expect(JSON.stringify(chain())).toBe(source);
    expect(store.status().decodes).toBe(1);
  });

  it("全局重置后继续 pending 回读；丢失或部分写入不激活且可重试新代次", () => {
    tick(1); store.prepare(); save(); tick(2); store.prepare();
    const missingId = Memory.data!.permitChainSegments!.pending!.manifest.segmentIds[0];
    save(missingId); store = createPermitChainSegmentStore();
    tick(3); store.prepare(); save();
    expect(chain()).toEqual(original);
    expect(JSON.parse(persisted).data.permitChainSegments.mode).toBe("inline");
    expect(Memory.data!.permitChainSegments!.pending).toBeUndefined();
    tick(4); store.prepare();
    expect(Memory.data!.permitChainSegments!.pending!.manifest.epoch).toBe(2);
    save(); tick(5); store.prepare(); save();
    expect(JSON.parse(persisted).data.permitChainSegments.mode).toBe("segments");
  });

  it("pending 期间及 console 修改源链时，持久化当前完整链并保留旧 bank", () => {
    activate(); const oldPhysical = { ...physical };
    tick(4);
    const next = { ...original, entries: [...original.entries, { id: "新许可", evidence: "新证据" }] };
    getPermitChainContainer(Memory)!.permitChain = next as any;
    save();
    expect(JSON.parse(persisted).data.permitChainSegments.mode).toBe("inline");
    expect(JSON.parse(persisted).data.marketSaleAutomation.directAutomation.baseResourceV3.permitChain).toEqual(next);
    expect(physical).toEqual(oldPhysical);
    tick(5); store.prepare();
    const pending = Memory.data!.permitChainSegments!.pending!;
    expect(pending.manifest.segmentIds.every(id => !Memory.data!.permitChainSegments!.active!.segmentIds.includes(id))).toBe(true);
    save(); tick(6);
    getPermitChainContainer(Memory)!.permitChain = original as any;
    store.prepare(); save();
    expect(chain()).toEqual(original);
  });

  it("缺片、内容替换和坏引用都阻断市场写入及库存出库，不清空许可或 WAL", () => {
    activate();
    const manifest = JSON.parse(persisted).data.permitChainSegments.active;
    tick(4); save(); // 先建立热堆；下一 tick 的坏数据也必须重新核对实际字符串。
    physical[manifest.segmentIds[0]] = "{坏片}";
    tick(5);
    const before = JSON.stringify(Memory);
    expect(isPermitChainStorageReady()).toBe(false);
    expect(() => ensureDataState()).toThrow("许可链存储暂不可用");
    const native = jest.fn(() => OK);
    Game.market = { createOrder: native } as unknown as Market;
    expect(executeCreateOrder({} as Parameters<Market["createOrder"]>[0])).toBe(ERR_BUSY);
    expect(executeMarketDeal("order", 1, "E1N1", "test", {} as any)).toBe(ERR_BUSY);
    expect(executeTerminalAction("E1N1", "test", "terminal_send", native)).toBe(ERR_BUSY);
    expect(getMarketSaleTerminalExposure("E1N1", RESOURCE_ENERGY).blocked).toBe(true);
    expect(getTerminalAmountsOutsideMarketSaleExposure({ room: { name: "E1N1" } } as StructureTerminal,
      [RESOURCE_ENERGY], { get: () => ({ reservedAmount: 0, blocked: false }) }).get(RESOURCE_ENERGY)).toBe(0);
    expect(native).not.toHaveBeenCalled();
    expect(JSON.stringify(Memory)).toBe(before);
    expect(store.project(Memory)).toBe(Memory);
  });

  it("停用时先完整展开再回到 inline，缺片停用仍保留引用", () => {
    activate();
    const edited = JSON.parse(persisted); edited.cfg.memoryStorage.permitChain.enabled = false; persisted = JSON.stringify(edited);
    tick(4); save();
    const result = JSON.parse(persisted);
    expect(result.data.permitChainSegments.mode).toBe("inline");
    expect(result.data.marketSaleAutomation.directAutomation.baseResourceV3.permitChain).toEqual(original);
    expect(result.data.permitChainSegments.active).toBeDefined();
    tick(5);
    expect(RawMemory.setActiveSegments).not.toHaveBeenCalled();
  });

  it("同 tick 其它调用方覆盖 active 片时，落盘完整链以保留回滚来源", () => {
    activate(); tick(4);
    const active = Memory.data!.permitChainSegments!.active!;
    RawMemory.segments[active.segmentIds[0]] = "console 或遥测写入";
    save();
    const saved = JSON.parse(persisted);
    expect(saved.data.permitChainSegments.mode).toBe("inline");
    expect(saved.data.marketSaleAutomation.directAutomation.baseResourceV3.permitChain).toEqual(original);
  });

  it("显式 segment 配置、预算与外部占用校验，禁止覆盖 telemetry/active bank", () => {
    tick(1); store.prepare(); save();
    tick(2); RawMemory.segments[81] = "其它模块的数据"; store.prepare();
    expect(store.status().lastReason).toBe("inactive_bank_occupied");
    expect(Memory.data!.permitChainSegments).toBeUndefined();
    Memory.cfg!.memoryStorage!.permitChain!.banks = [[90], [91]];
    store.prepare(); expect(store.status().lastReason).toBe("explicit_disjoint_banks_required");
    Memory.cfg!.memoryStorage!.permitChain!.banks = [[81, 82], [83, 84]];
    Game.cpu.bucket = 0; store.prepare(); expect(store.status().lastReason).toBe("prepare_budget");
  });

  it("热堆可以在低预算下读取；冷启动缺片或预算不足时保留原始引用", () => {
    activate(); tick(4); save();
    Game.cpu.bucket = 0; tick(5);
    expect(isPermitChainStorageReady()).toBe(true);
    save(); store = createPermitChainSegmentStore(); tick(6);
    expect(isPermitChainStorageReady()).toBe(false);
    expect(store.status().lastReason).toBe("decode_budget");
    expect(store.project(Memory)).toBe(Memory);
    Game.cpu.bucket = 10000;
    const edited = JSON.parse(persisted); edited.cfg.memoryStorage.permitChain.enabled = false; persisted = JSON.stringify(edited);
    requested = []; store = createPermitChainSegmentStore(); tick(7);
    expect(isPermitChainStorageReady()).toBe(false);
    expect(store.status().lastReason).toBe("segments_not_loaded");
    expect(store.project(Memory)).toBe(Memory);
  });

  it("多片部分落盘时不切换 hot 引用，原完整链保持可恢复", () => {
    let seed = 123456789;
    const noise = Array.from({ length: 130000 }, () => {
      seed = Math.imul(seed, 1664525) + 1013904223 | 0;
      return String.fromCharCode(33 + (seed >>> 8) % 90);
    }).join("");
    const edited = JSON.parse(persisted);
    edited.data.marketSaleAutomation.directAutomation.baseResourceV3.permitChain.noise = noise;
    persisted = JSON.stringify(edited);
    tick(1); store.prepare(); save(); tick(2); store.prepare();
    const pending = Memory.data!.permitChainSegments!.pending!;
    expect(pending.manifest.segmentIds).toHaveLength(2);
    save(pending.manifest.segmentIds[1]);
    store = createPermitChainSegmentStore(); tick(3); store.prepare(); save();
    expect(chain().noise).toBe(noise);
    expect(JSON.parse(persisted).data.permitChainSegments.mode).toBe("inline");
    expect(Memory.data!.permitChainSegments!.active).toBeUndefined();
  });

  it("tick 回退不接受同 tick/未来写入的 pending；shard 不同也不展开", () => {
    tick(1); store.prepare(); save(); tick(2); store.prepare(); save();
    tick(2); store.prepare(); expect(store.status().lastReason).toBe("awaiting_next_tick");
    save(); Game.shard = { name: "shard2" } as Game["shard"]; tick(3);
    expect(isPermitChainStorageReady()).toBe(false);
    expect(store.status().lastReason).toBe("storage_metadata_invalid");
  });
});
