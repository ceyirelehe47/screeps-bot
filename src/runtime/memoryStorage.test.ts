import { createMemoryStorage } from "@/runtime/memoryStorage";
import { getPermitChainContainer, isPermitChainStorageReady, setPermitChainStorageBlocked } from "@/runtime/permitChainStorageGuard";

describe("实际持久化边界的 Memory 冷投影", () => {
  let savedMemory: PropertyDescriptor | undefined;
  let savedRaw: PropertyDescriptor | undefined;
  beforeEach(() => {
    savedMemory = Object.getOwnPropertyDescriptor(globalThis, "Memory");
    savedRaw = Object.getOwnPropertyDescriptor(globalThis, "RawMemory");
    Game.cpu = { bucket: 10000, tickLimit: 500, getUsed: () => 0 } as typeof Game.cpu;
    Game.shard = { name: "shard1" } as Game["shard"];
  });
  afterEach(() => {
    if (savedMemory) Object.defineProperty(globalThis, "Memory", savedMemory);
    if (savedRaw) Object.defineProperty(globalThis, "RawMemory", savedRaw);
    else Reflect.deleteProperty(globalThis, "RawMemory");
    setPermitChainStorageBlocked();
  });

  function engine() {
    const initial = { currentPermitEpoch: 0, permits: [] };
    let persisted = JSON.stringify({ cfg: { memoryStorage: { permitChain: { enabled: true, banks: [[81], [82]] } } },
      data: { marketSaleAutomation: { directAutomation: { baseResourceV3: { permitChain: initial } } } } });
    let active: number[] = [], physical: Record<number, string> = {};
    let raw: typeof RawMemory & { _parsed?: Memory };
    const storage = createMemoryStorage();
    function start(tick: number, compatible = true) {
      Game.time = tick;
      let text = persisted;
      raw = { get: () => text, set(value: string) { if (this._parsed) delete this._parsed; text = value; },
        segments: Object.fromEntries(active.map(id => [id, physical[id] ?? ""])),
        setActiveSegments: (ids: number[]) => { active = ids; } } as unknown as typeof raw;
      Object.defineProperty(globalThis, "RawMemory", { configurable: true, writable: true, value: raw });
      Object.defineProperty(globalThis, "Memory", { configurable: true, get() {
        const value = JSON.parse(text); Object.setPrototypeOf(value, null);
        Object.defineProperty(raw, "_parsed", { value, writable: true, configurable: compatible });
        Object.defineProperty(globalThis, "Memory", { configurable: true, value }); return value;
      } });
      storage.begin();
    }
    function complete() {
      persisted = raw._parsed ? JSON.stringify(raw._parsed) : raw.get();
      physical = { ...physical, ...raw.segments };
      return JSON.parse(persisted);
    }
    function migrate() {
      for (let tick = 1; tick <= 3; tick++) { start(tick); storage.finish(); complete(); }
      expect(JSON.parse(persisted).data.permitChainSegments.mode).toBe("segments");
    }
    return { start, complete, migrate, storage, read: () => JSON.parse(persisted), raw: () => raw };
  }

  it("console 在 loop 后修改链/普通字段时，保存最新完整链而不是过期引用", () => {
    const e = engine(); e.migrate(); e.start(4); e.storage.finish();
    getPermitChainContainer(Memory)!.permitChain = { currentPermitEpoch: 1, permits: [{ id: "console 新许可" }] };
    (Memory as unknown as { consoleValue: string }).consoleValue = "已写入";
    const saved = e.complete();
    expect(saved.consoleValue).toBe("已写入");
    expect(saved.data.permitChainSegments.mode).toBe("inline");
    expect(saved.data.marketSaleAutomation.directAutomation.baseResourceV3.permitChain.currentPermitEpoch).toBe(1);
  });

  it("console RawMemory.set 有最终优先权，不能被已安装的投影反写", () => {
    const e = engine(); e.migrate(); e.start(4); e.storage.finish();
    e.raw().set(JSON.stringify({ consoleOverride: true }));
    expect(e.complete()).toEqual({ consoleOverride: true });
  });

  it("提前查看 _parsed 不触发落盘，后续 console 写入仍由驱动保存", () => {
    const e = engine(); e.migrate(); e.start(4); e.storage.finish();
    expect(e.raw()._parsed!.data!.permitChainSegments!.mode).toBe("segments");
    getPermitChainContainer(Memory)!.permitChain = { currentPermitEpoch: 2, permits: [] };
    (Memory as unknown as { lateConsole: boolean }).lateConsole = true;
    const saved = e.complete();
    expect(saved.lateConsole).toBe(true);
    expect(saved.data.permitChainSegments.mode).toBe("inline");
    expect(saved.data.marketSaleAutomation.directAutomation.baseResourceV3.permitChain.currentPermitEpoch).toBe(2);
  });

  it("缺少可配置 _parsed 时完整保存，不进入失配的 segments 模式", () => {
    const e = engine(); e.migrate(); e.start(4, false); e.storage.finish();
    const saved = e.complete();
    expect(saved.data.permitChainSegments.mode).toBe("inline");
    expect(saved.data.marketSaleAutomation.directAutomation.baseResourceV3.permitChain.permits).toEqual([]);
    e.start(5); expect(isPermitChainStorageReady()).toBe(true);
  });

  it("普通内联 Memory 默认不安装持久化拦截", () => {
    const e = engine(); e.start(1);
    Memory.cfg!.memoryStorage!.permitChain!.enabled = false;
    const descriptor = Object.getOwnPropertyDescriptor(e.raw(), "_parsed");
    e.storage.finish();
    expect(Object.getOwnPropertyDescriptor(e.raw(), "_parsed")).toEqual(descriptor);
  });
});
