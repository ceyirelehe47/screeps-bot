/** 独立验收增补测试（Agent）：针对 AGENT-VERIFY §5 七类边界，在真实
 * production facade 上独立构造反例，每个反例均配合法对照。不复用交付方
 * 测试文件的 scene 装配代码，仅共用 @mock/treasury 公共基建。 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import { resetTreasuryCoreStoreForTest } from "@/runtime/treasury/testHarness";
import {
  createTreasuryReadOnlyObserver,
  treasuryReadOnlyUtf8Bytes,
  type TreasuryReadOnlyConfig,
} from "@/runtime/treasury/readOnlyObservation";
import { runTreasuryReadOnlyObservation } from "@/runtime/treasuryReadOnlyRuntime";
import { TREASURY_READ_ONLY_CONFIG } from "@/config/treasuryReadOnly";
import { installRooms, mutateStoreResource } from "@mock/treasury";

const BASE_CONFIG: TreasuryReadOnlyConfig = {
  enabled: true, shardName: "ro1-ind", rooms: ["W1N1"], resources: ["energy", "H"],
  intervalTicks: 100, maxSampleCpu: 2, reserveCpu: 5, minBucket: 2000, maxLogBytes: 16384,
};

/** 独立 scene：两房间真实 facade；对 storage/terminal 补齐 directEndpoint
 * 所需的 my/owner/isActive/cooldown/getCapacity（getCapacity 取安装时的
 * used+free 常量，后续世界变化一律对称施加以保持 used+free===capacity）。 */
function scene(config: TreasuryReadOnlyConfig = BASE_CONFIG, extraRooms: string[] = []) {
  Game.time = 100;
  Object.assign(global, { Memory: {} });
  const names = [...new Set(["W1N1", ...extraRooms])];
  const rooms = installRooms(names.map(name => ({
    name,
    storage: { id: "ind-s-" + name, resources: { energy: 4000 }, freeCapacity: 496000 },
    terminal: { id: "ind-t-" + name, resources: { energy: 8000, H: 900 }, freeCapacity: 291100 },
  })));
  for (const s of Object.values(rooms).flatMap(r => [r.storage!, r.terminal!])) {
    const capacity = s.store.getUsedCapacity() + s.store.getFreeCapacity();
    Object.assign(s, { my: true, owner: { username: "ind" }, isActive: () => true, cooldown: 0 });
    Object.defineProperty(s.store, "getCapacity", { value: () => capacity, enumerable: false });
  }
  const service = createTreasuryService({ getRooms: () => Object.values(rooms) });
  const lines: string[] = [];
  const shard = { name: config.shardName };
  // step=0 时 CPU 读数恒定（正常对照）；step>0 时每次读取递增（慢 getter 反例）。
  const cpuState = { base: 0.1, step: 0, count: 0 };
  const observer = createTreasuryReadOnlyObserver(config, {
    getTick: () => Game.time,
    getShard: () => shard.name,
    cpu: () => ({ used: cpuState.base + cpuState.step * cpuState.count++, tickLimit: 100, bucket: 9000 }),
    getRoom: name => Game.rooms[name],
    getResourceCatalog: () => RESOURCES_ALL,
    getMemory: () => Memory,
    getService: () => service,
    emit: line => { lines.push(line); },
  });
  return { service, observer, rooms, lines, shard, cpuState,
    report: (i = lines.length - 1) => JSON.parse(lines[i]) as Record<string, any> };
}

beforeEach(() => { resetTreasuryCoreStoreForTest(); });

describe("独立反例：只读观察器边界（真实 facade）", () => {
  it("§5.1 生产装配默认关闭：运行级零输出且不抛错（对照：静态默认配置亦关闭）", () => {
    expect(TREASURY_READ_ONLY_CONFIG.enabled).toBe(false);
    expect(TREASURY_READ_ONLY_CONFIG.rooms).toEqual([]);
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(() => runTreasuryReadOnlyObservation()).not.toThrow();
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it("§5.1 错 shard：真实服务四读端口零调用（对照：下个采样窗同场景 sampled）", () => {
    const s = scene();
    s.shard.name = "other-shard";
    const spies = (["observation", "commitments", "query", "kernelJournal"] as const)
      .map(k => jest.spyOn(s.service, k));
    try {
      expect(s.observer.run().status).toBe("wrong_shard");
      for (const sp of spies) expect(sp).not.toHaveBeenCalled();
      s.shard.name = BASE_CONFIG.shardName; Game.time = 200; s.service.beginTick();
      expect(s.observer.run().status).toBe("sampled");
    } finally { for (const sp of spies) sp.mockRestore(); }
  });

  it("§5.1 低 bucket / 余量不足：服务零调用即跳过（对照：同场景正常 CPU sampled）", () => {
    const s = scene();
    s.cpuState.base = 100; // tickLimit(100)-used(100)=0 < reserve+maxSample
    const spy = jest.spyOn(s.service, "observation");
    try {
      expect(s.observer.run().status).toBe("cpu_skipped");
      expect(spy).not.toHaveBeenCalled();
      s.cpuState.base = 0.1; Game.time = 200; s.service.beginTick();
      expect(s.observer.run().status).toBe("sampled");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });

  it("§5.1 非采样 tick 与同 tick 重复调用零服务读取（对照：due tick 一次读取）", () => {
    const s = scene();
    const spy = jest.spyOn(s.service, "observation");
    try {
      Game.time = 101; expect(s.observer.run().status).toBe("not_due");
      Game.time = 100; s.service.beginTick();
      expect(s.observer.run().status).toBe("sampled");
      expect(s.observer.run().status).toBe("not_due"); // lastAttemptTick 防同 tick 重试
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });

  it("§5.3 getter 抛异常的 terminal 单独表达为 unreadable（对照：同房间 storage 正常 match）", () => {
    const s = scene();
    s.service.beginTick(); // 先让真实观察正常建立（否则 facade 扫描本身会抛）
    (s.rooms.W1N1.terminal!.store as any).getUsedCapacity = () => { throw new Error("boom"); };
    expect(s.observer.run().status).toBe("sampled");
    const rows = s.report().endpoints as any[];
    const term = rows.find(r => r.location === "terminal")!;
    const stor = rows.find(r => r.location === "storage")!;
    expect(term.directStatus).toBe("unreadable");
    expect(term.comparison).toBe("unavailable_direct_read");
    expect(stor.directStatus).toBe("ok");
    expect(stor.comparison).toBe("match_selected_scope");
  });

  it("§5.3 NaN 库存读数表达为 unreadable（对照：另一房间正常 match）", () => {
    const s = scene({ ...BASE_CONFIG, rooms: ["W1N1", "W2N1"] }, ["W2N1"]);
    const bad = s.rooms.W1N1.terminal!.store as unknown as Record<string, number>;
    bad.H = Number.NaN;
    s.service.beginTick();
    expect(s.observer.run().status).toBe("sampled");
    const rows = s.report().endpoints as any[];
    expect(rows.find(r => r.room === "W1N1" && r.location === "terminal")!.directStatus).toBe("unreadable");
    expect(rows.find(r => r.room === "W2N1" && r.location === "terminal")!.comparison).toBe("match_selected_scope");
  });

  it("§5.3 范围外资源存在时不误报持有范围、不扩大扫描且 match 不受污染", () => {
    const s = scene({ ...BASE_CONFIG, rooms: ["W1N1", "W2N1"] }, ["W2N1"]);
    const rec = s.rooms.W2N1.terminal!.store as unknown as Record<string, number>;
    rec.U = 500; // U 不在 config.resources；对称减 free 保持 used+free===capacity
    (s.rooms.W2N1.terminal!.store as unknown as { __freeCapacity: number }).__freeCapacity -= 500;
    s.service.beginTick();
    expect(s.observer.run().status).toBe("sampled");
    const row = (s.report().endpoints as any[]).find(r => r.room === "W2N1" && r.location === "terminal")!;
    expect(Object.keys(row.direct.amounts).sort()).toEqual(["H", "energy"]);
    expect(row.direct.used - (row.direct.amounts.H + row.direct.amounts.energy)).toBe(500);
    expect(row.comparison).toBe("match_selected_scope");
  });

  it("§5.4 独立 world 读数与 Treasury 缓存故意不同：mismatch 明细检出（对照：下一 tick 重观察 match）", () => {
    const s = scene();
    s.service.beginTick();
    s.service.observation(); // 在本 tick 建立缓存视图
    const rec = s.rooms.W1N1.terminal!.store as unknown as Record<string, number>;
    rec.H = 840; // 不经 mutateStoreResource：不 bump 世界序，缓存保持 fresh
    (s.rooms.W1N1.terminal!.store as unknown as { __freeCapacity: number }).__freeCapacity += 60;
    expect(s.observer.run().status).toBe("sampled");
    const row = (s.report().endpoints as any[]).find(r => r.location === "terminal")!;
    expect(row.comparison).toBe("mismatch");
    expect(row.mismatches).toContain("H");
    expect(row.mismatches).toContain("usedCapacity");
    // 合法对照：受控世界更新推进到下一采样 tick，重新观察后恢复一致
    mutateStoreResource(s.rooms.W1N1.terminal, "H", 0);
    Game.time = 200; s.service.beginTick();
    expect(s.observer.run().status).toBe("sampled");
    const row2 = (s.report().endpoints as any[]).find(r => r.location === "terminal")!;
    expect(row2.comparison).toBe("match_selected_scope");
  });

  it("§5.4 结构 ID 替换检出为 structure mismatch，不影响其余字段比对", () => {
    const s = scene();
    s.service.beginTick();
    s.service.observation();
    (s.rooms.W1N1.terminal as unknown as { id: string }).id = "ind-t-replaced-9999";
    expect(s.observer.run().status).toBe("sampled");
    const row = (s.report().endpoints as any[]).find(r => r.location === "terminal")!;
    expect(row.comparison).toBe("mismatch");
    expect(row.mismatches).toContain("structure");
    expect(row.mismatches).not.toContain("H");
  });

  it("§5.5 市场日志合法对照：intent/ok/blocked 原样保留且措辞不冒充转运证据（对照：无日志 absent）", () => {
    const s = scene();
    Object.assign(Memory, { data: { marketSaleAutomation: { marketActionJournal: [
      { tick: 90, actor: "creep_a", id: "j1", kind: "market", outcome: "intent", roomName: "W1N1" },
      { tick: 91, actor: "creep_b", id: "j2", kind: "market", outcome: "ok", roomName: "W1N1" },
      { tick: 92, actor: "creep_c", id: "j3", kind: "market", outcome: "blocked", roomName: "W1N1" },
    ] } } });
    s.service.beginTick();
    expect(s.observer.run().status).toBe("sampled");
    const hints = s.report().marketHints;
    expect(hints.status).toBe("ok");
    expect(hints.coverage).toBe("existing_market_journal_only");
    expect(hints.rows.map((r: any) => r.outcome)).toEqual(["blocked", "ok", "intent"]);
    // 合法对照（absent）
    const s2 = scene(); Object.assign(global, { Memory: {} });
    s2.service.beginTick();
    expect(s2.observer.run().status).toBe("sampled");
    expect(s2.report().marketHints.status).toBe("absent");
  });

  it("§5.5 损坏市场日志（未来 tick 条目）表达为 unreadable 而非空/健康", () => {
    const s = scene();
    Object.assign(Memory, { data: { marketSaleAutomation: { marketActionJournal: [
      { tick: Game.time + 1, actor: "x", id: "j", kind: "k", outcome: "ok", roomName: "W1N1" },
    ] } } });
    s.service.beginTick();
    expect(s.observer.run().status).toBe("sampled");
    expect(s.report().marketHints.status).toBe("unreadable");
  });

  it("§5.5 超限日志：>100 条 over_bound；9 条相关输出 8 条并明示省略", () => {
    const s = scene();
    const many = Array.from({ length: 101 }, (_, i) =>
      ({ tick: 100 - (i % 50), actor: "a" + i, id: "j" + i, kind: "market", outcome: "ok", roomName: "W1N1" }));
    Object.assign(Memory, { data: { marketSaleAutomation: { marketActionJournal: many } } });
    s.service.beginTick();
    expect(s.observer.run().status).toBe("sampled");
    expect(s.report().marketHints.status).toBe("over_bound");
    const s2 = scene();
    const nine = Array.from({ length: 9 }, (_, i) =>
      ({ tick: 92 - i, actor: "a" + i, id: "j" + i, kind: "market", outcome: "ok", roomName: "W1N1" }));
    Object.assign(Memory, { data: { marketSaleAutomation: { marketActionJournal: nine } } });
    s2.service.beginTick();
    expect(s2.observer.run().status).toBe("sampled");
    const h = s2.report().marketHints;
    expect(h.relevantCount).toBe(9);
    expect(h.rows).toHaveLength(8);
    expect(h.omittedCount).toBe(1);
  });

  it("§5.2 kernel 损坏时不报 active=0、查询阻断保留且零 Treasury 写端口调用", () => {
    const s = scene();
    Object.assign(Memory, { runtime: { treasuryCore: { version: 3, active: { broken: null } } } });
    const mutations = ["beginTick", "endTick", "authorizeTreasuryActionContract", "executeAuthorizedDispatch",
      "settleUnknownOutcome", "cancelPendingWork", "closeWork", "executeRearm"] as const;
    const spies = mutations.map(k => jest.spyOn(s.service, k));
    try {
      expect(s.observer.run().status).toBe("sampled");
      const report = s.report();
      expect(report.kernel.health.status).toBe("unhealthy");
      expect(report.kernel.activeCount).toBeNull();
      const row = (report.endpoints as any[]).find(r => r.location === "terminal")!;
      expect(row.balances.H.authorizationSafe).toBe(false);
      expect(row.balances.H.blockers.length).toBeGreaterThan(0);
      for (const sp of spies) expect(sp).not.toHaveBeenCalled();
    } finally { for (const sp of spies) sp.mockRestore(); }
  });

  it("§5.6 UTF-8 计数与 Buffer oracle 随机对拍（含中文/emoji/代理对/未配对代理）", () => {
    const seeds = ["中文测试", "🚀🌟", "a�b", "\uD800", "\uDC00\uD800", "plain ascii",
      "url://日本語/키릴", "😀⟁"];
    for (let i = 0; i < 200; i += 1) {
      const parts: string[] = [];
      for (let k = 0; k < 6; k += 1) {
        const r = Math.random();
        if (r < 0.25) parts.push(String.fromCharCode(97 + Math.floor(Math.random() * 26)));
        else if (r < 0.5) parts.push(String.fromCharCode(0x4e00 + Math.floor(Math.random() * 999)));
        else if (r < 0.75) parts.push(String.fromCodePoint(0x1f300 + Math.floor(Math.random() * 200)));
        else parts.push(seeds[Math.floor(Math.random() * seeds.length)]);
      }
      const s = parts.join("");
      expect(treasuryReadOnlyUtf8Bytes(s)).toBe(Buffer.byteLength(s, "utf8"));
    }
  });

  it("§5.6 输出超界：整行省略通知为有效 JSON 且不建立隐形基线（对照：正常上限建立单份基线）", () => {
    const small = scene({ ...BASE_CONFIG, maxLogBytes: 1024, rooms: ["W1N1", "W2N1"] }, ["W2N1"]);
    small.service.beginTick();
    expect(small.observer.run().status).toBe("output_limited");
    const notice = small.report();
    expect(notice.status).toBe("output_limited");
    expect(notice.authorizesActions).toBe(false);
    expect(notice.requestedEndpointRows).toBe(4);
    expect(notice.endpoints).toBeUndefined();
    expect(small.observer.stats().retainedEndpoints).toBe(0);
    expect(small.observer.stats().previousRun?.retainedPrimitiveChars).toBe(0);
    const normal = scene({ ...BASE_CONFIG, rooms: ["W1N1", "W2N1"] }, ["W2N1"]);
    normal.service.beginTick();
    expect(normal.observer.run().status).toBe("sampled");
    expect(normal.observer.stats().retainedEndpoints).toBe(4);
  });

  it("§5.6 慢 getter 协作预算：partial_cpu_budget 与超额可见、kernel/日志显式 not_read（对照：快 getter 全覆盖）", () => {
    const slow = scene();
    slow.cpuState.step = 1; // 每次读取 used+1，很快越过 maxSampleCpu=2
    slow.service.beginTick();
    const st = slow.observer.run().status;
    expect(["partial_cpu_budget", "cpu_skipped_after_service"]).toContain(st);
    const report = slow.report();
    expect(report.cooperativeCpuBudgetExceeded).toBe(true);
    expect(report.kernel.status).toBe("not_read_cpu_budget");
    expect(report.marketHints.status).toBe("not_read_cpu_budget");
    const fast = scene();
    fast.service.beginTick();
    expect(fast.observer.run().status).toBe("sampled");
    expect(fast.report().status).toBe("sampled");
    expect(fast.report().kernel.health).toBeDefined();
  });

  it("§5.7 长期运行：连续 6 个采样窗仅保留单份上一次快照、计数有界不膨胀", () => {
    const s = scene();
    for (let tick = 100; tick <= 600; tick += 100) {
      Game.time = tick; s.service.beginTick();
      expect(s.observer.run().status).toBe("sampled");
      const st = s.observer.stats();
      expect(st.retainedEndpoints).toBeLessThanOrEqual(2);
      expect(st.emitted).toBe((tick - 100) / 100 + 1);
      expect(st.previousRun?.tick).toBe(tick);
      expect(st.previousRun?.retainedPrimitiveChars).toBeLessThan(2000);
      const rep = s.report();
      if (tick === 100) {
        expect(rep.previousRun).toBeNull(); // 首采样无历史
      } else {
        expect(typeof rep.previousRun.totalCpuIncludingEmit).toBe("number");
        expect(rep.previousRun.tick).toBe(tick - 100);
      }
      s.service.endTick();
    }
    expect(s.observer.stats().disabledByFault).toBe(false);
    expect(s.lines).toHaveLength(6);
  });
});
