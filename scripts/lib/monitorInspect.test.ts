import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

const { PREFIX, SCHEMA, parseInspectFrame, runConsoleInspect } = require("./monitorInspect.cjs");
const USER_ID = "a".repeat(24);
const TOKEN = "private-unit-token-do-not-print";
const options = () => ({ requestId: randomUUID(), shard: "shard1", expectedTag: "unit-deploy-tag", maxBytes: 24000, rooms: ["E3N53"], creeps: [], creepPrefixes: ["remoteCarrier-"] });
const frame = (options: any, envelope: any) => JSON.stringify([`user:${USER_ID}/console`, { shard: options.shard, messages: { log: [PREFIX + JSON.stringify(envelope)] } }]);
const envelope = (options: any) => ({ schema: SCHEMA, requestId: options.requestId, shard: options.shard, tick: 12345, deployTag: options.expectedTag, result: { creeps: [], rooms: [], marker: "from-executed-query" } });

function harness(options: any, mode = "success") {
  const events: string[] = [];
  let socket: Socket;
  let signalPost: () => void;
  const posted = new Promise<void>(resolve => { signalPost = resolve; });
  class Socket {
    private listeners = new Map<string, Set<(value: any) => void>>();
    public closed = false;
    constructor(_url: string) { socket = this; Promise.resolve().then(() => this.emit("open", {})); }
    addEventListener(name: string, listener: (value: any) => void) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name)!.add(listener); }
    removeEventListener(name: string, listener: (value: any) => void) { this.listeners.get(name)?.delete(listener); }
    emit(name: string, value: any) { for (const listener of [...(this.listeners.get(name) || [])]) listener(value); }
    send(text: string) {
      if (text.startsWith("auth ")) { events.push("auth"); Promise.resolve().then(() => this.emit("message", { data: "auth ok" })); }
      else if (text === `subscribe user:${USER_ID}/console`) {
        events.push("subscribe");
        Promise.resolve().then(() => { events.push("subscription-frame"); this.emit("message", { data: JSON.stringify([`user:${USER_ID}/console`, { messages: { log: [] } }]) }); });
      }
    }
    close() { this.closed = true; }
    listenerCount() { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
  }
  const response = (status: number, value: any) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(value) });
  const fetcher = jest.fn(async (url: URL, init: any) => {
    if (url.pathname === "/api/auth/me") return response(200, { ok: 1, username: "forster", _id: USER_ID });
    if (url.pathname === "/api/user/branches") return response(200, { ok: 1, list: [{ branch: "default", activeWorld: true }] });
    expect(url.pathname).toBe("/api/user/console");
    expect(init.method).toBe("POST");
    events.push("post"); signalPost!();
    if (mode === "429") return response(429, { error: `Rate limit exceeded token=${TOKEN}` });
    if (mode === "rejected") return response(200, { error: `token=${TOKEN} read-only scope refused` });
    if (mode === "ambiguous") throw new Error(`network failure ${TOKEN}`);
    if (mode === "disconnect") socket.emit("close", {});
    if (mode === "success") {
      // 真实结果可先于HTTP accepted到达；必须两者齐全才完成。
      socket.emit("message", { data: frame(options, { ...envelope(options), requestId: randomUUID() }) });
      socket.emit("message", { data: frame(options, envelope(options)) });
    }
    return response(200, { ok: 1 });
  });
  return { events, posted, fetcher, Socket, currentSocket: () => socket };
}

describe("monitor inspect 单请求协议", () => {
  it("先收到订阅频道帧再唯一POST，关联执行结果并释放资源", async () => {
    const query = { ...options(), shard: "shard2", rooms: ["W8S3"], creepPrefixes: ["remoteWorker-"] };
    const h = harness(query);
    const result = await runConsoleInspect({ token: TOKEN, baseUrl: "https://screeps.invalid/", username: "forster", branch: "default", timeoutMs: 1000 }, query, { fetch: h.fetcher, WebSocket: h.Socket });
    expect(h.events).toEqual(["auth", "subscribe", "subscription-frame", "post"]);
    expect(h.fetcher.mock.calls.filter(([url]) => url.pathname === "/api/user/console")).toHaveLength(1);
    expect(h.fetcher.mock.calls.map(([url]) => url.pathname)).toEqual(["/api/auth/me", "/api/user/branches", "/api/user/console"]);
    const posted = JSON.parse(h.fetcher.mock.calls[2][1].body);
    expect(posted.shard).toBe(query.shard);
    expect(posted.expression).toContain(query.rooms[0]);
    expect(result.snapshot).toEqual(envelope(query));
    expect(result.post.accepted).toBe(true);
    expect(h.currentSocket().closed).toBe(true);
    expect(h.currentSocket().listenerCount()).toBe(0);
    expect(h.fetcher.mock.calls.every(([, init]) => init.signal.aborted)).toBe(true);
  });

  it("忽略其它requestId，但拒绝匹配请求的错shard、错tag和缺结果", () => {
    const query = options();
    const context = { ...query, userId: USER_ID };
    // 真实11:07:09.720Z心跳毫秒值含429；它不代表限流，也不触发重试。
    expect(parseInspectFrame("time 1792062429720", context)).toEqual({ kind: "ignore" });
    expect(parseInspectFrame("time 429", context)).toEqual({ kind: "ignore" });
    for (const message of ["HTTP 429 Too Many Requests", "429", "Rate limit exceeded, retry after 1000ms"]) {
      expect(() => parseInspectFrame(message, context)).toThrow(expect.objectContaining({ code: "RATE_LIMITED" }));
    }
    expect(parseInspectFrame(frame(query, { ...envelope(query), requestId: randomUUID() }), context).result).toBeNull();
    for (const [change, code] of [[{ shard: "shard3" }, "WRONG_SHARD"], [{ deployTag: "other-version" }, "WRONG_DEPLOY_TAG"], [{ result: undefined }, "RESULT_MISSING"]] as const) {
      expect(() => parseInspectFrame(frame(query, { ...envelope(query), ...change }), context)).toThrow(expect.objectContaining({ code }));
    }
    const compressed = "gz:" + gzipSync(Buffer.from(frame(query, envelope(query)))).toString("base64");
    expect(parseInspectFrame(compressed, context).result.requestId).toBe(query.requestId);
    // 来自真实console wire的编码形式；替换私有值后以动态requestId复现协议。
    const literal = "literal &quot; &#34; &#x22;";
    const value = { ...envelope(query), result: { literal } };
    for (const entity of ["&#x22;", "&#34;", "&quot;"]) {
      const encoded = (PREFIX + JSON.stringify(value)).replace(/&/g, "&amp;").replace(/"/g, entity);
      const wire = JSON.stringify([`user:${USER_ID}/console`, { shard: query.shard, messages: { log: [encoded] } }]);
      expect(parseInspectFrame(wire, context).result.result.literal).toBe(literal);
    }
    expect(parseInspectFrame(frame(query, value), context).result.result.literal).toBe(literal);
    const compact = [2, query.requestId, query.shard, 12345, query.expectedTag, "movement", [1, [
      [["room-selected-unit", ["E3N53", 12, 13], 900, 1000, 2, { energy: 42 }], ["E2N54", "34,28", "target-id"], true,
        [["E2N54", 3, 4, null, null, [["E3N53", 13, 13]]], ["E3N53", 1, 0, 20, 13, [[null, 13, 13]]]]],
    ]], [["E3N53", false, null, null, { 1: "E3N54" }]]];
    const compactLine = (PREFIX + JSON.stringify(compact)).replace(/"/g, "&#x22;");
    const compactFrame = JSON.stringify([`user:${USER_ID}/console`, { shard: query.shard, messages: { log: [compactLine] } }]);
    const decoded = parseInspectFrame(compactFrame, context).result;
    expect(decoded.result.mode).toBe("movement");
    expect(decoded.result.creeps[0]).toMatchObject({ name: "room-selected-unit", cargo: { store: { energy: 42 }, used: 42 }, memory: { working: true } });
    expect(decoded.result.creeps[0].movement.travelState).toMatchObject({ targetRoom: "E2N54", stuckTicks: 3, cursor: 4, nextCandidates: [{ roomName: "E3N53", x: 13, y: 13 }] });
    expect(decoded.result.creeps[0].movement.movePathState.nextCandidates[0].roomName).toBe("E3N53");
    expect(decoded.result.rooms[0]).toEqual({ name: "E3N53", visible: false, controller: { owner: null, reservation: null }, exits: { 1: "E3N54" } });
    expect(() => parseInspectFrame(compactFrame, { ...context, mode: "pair" })).toThrow(expect.objectContaining({ code: "RESULT_INVALID" }));
    expect(() => parseInspectFrame(compactFrame, { ...context, rooms: ["W1N1"] })).toThrow(expect.objectContaining({ code: "RESULT_INVALID" }));
  });

  it("拒绝/429/POST不确定/断线/accepted无结果均失败且从不重试", async () => {
    jest.useFakeTimers();
    try {
      for (const [mode, code] of [["429", "RATE_LIMITED"], ["rejected", "CONSOLE_REJECTED"], ["ambiguous", "POST_AMBIGUOUS"], ["disconnect", "SOCKET_CLOSED"], ["missing", "RESULT_TIMEOUT"]]) {
        const query = options();
        const h = harness(query, mode);
        const observed = runConsoleInspect({ token: TOKEN, baseUrl: "https://screeps.invalid/", username: "forster", branch: "default", timeoutMs: 1000 }, query, { fetch: h.fetcher, WebSocket: h.Socket }).then((result: any) => ({ result }), (error: any) => ({ error }));
        await h.posted;
        // 让注入HTTP响应完成；随后只推进客户端期限，不等待真实时间。
        for (let index = 0; index < 8; index++) await Promise.resolve();
        if (mode === "missing") jest.advanceTimersByTime(1001);
        const outcome = await observed as { result?: unknown; error?: any };
        expect(outcome.result).toBeUndefined();
        expect(outcome.error.code).toBe(code);
        expect(outcome.error.details.mayHaveExecuted).toBe(true);
        expect(JSON.stringify(outcome.error)).not.toContain(TOKEN);
        expect(h.fetcher.mock.calls.filter(([url]) => url.pathname === "/api/user/console")).toHaveLength(1);
        expect(h.currentSocket().closed).toBe(true);
        expect(h.currentSocket().listenerCount()).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
      }
    } finally { jest.useRealTimers(); }
  });

  it("账号或activeWorld不匹配时连socket和console POST都不启动", async () => {
    for (const wrong of ["account", "branch"]) {
      const response = (body: unknown) => ({ status: 200, ok: true, text: async () => JSON.stringify(body) });
      const fetcher = jest.fn(async (url: URL) => url.pathname === "/api/auth/me"
        ? response({ ok: 1, username: wrong === "account" ? "other-user" : "forster", _id: USER_ID })
        : response({ ok: 1, list: [{ branch: "other-branch", activeWorld: true }] }));
      const Socket = jest.fn(() => { throw new Error("must not open socket"); });
      await expect(runConsoleInspect({ token: TOKEN, baseUrl: "https://screeps.invalid/", username: "forster", branch: "default", timeoutMs: 1000 }, options(), { fetch: fetcher, WebSocket: Socket }))
        .rejects.toMatchObject({ code: wrong === "account" ? "WRONG_ACCOUNT" : "WRONG_ACTIVE_BRANCH" });
      expect(Socket).not.toHaveBeenCalled();
      expect(fetcher.mock.calls.some(([url]) => url.pathname === "/api/user/console")).toBe(false);
    }
  });
});
