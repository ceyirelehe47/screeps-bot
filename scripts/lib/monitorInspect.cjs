// 单次 console 查询协议；不提供任意表达式、Memory 探针或重试。
const { gunzipSync } = require("node:zlib");
const { redactSensitiveText } = require("./redactSecrets.cjs");
const { buildInspectExpression, validateInspectSelectors, decodeInspectWire } = require("./monitorInspectQuery.cjs");

const PREFIX = "CODEX_MONITOR_INSPECT:";
const SCHEMA = "codex-monitor-inspect/v1";
const MAX_FRAME_BYTES = 262144;

function isRateLimited(value) {
  if (typeof value === "string") return /\brate[\s_-]*limit(?:ed|ing)?\b|\btoo many requests\b/i.test(value)
    || /^(?:(?:HTTP(?:\/\d(?:\.\d)?)?|status|error)\s*[:=]?\s*)?429(?:\s|:|$)/i.test(value.trim());
  return !!value && typeof value === "object" && ([value.status, value.statusCode, value.code].some(code => code === 429 || code === "429")
    || [value.message, value.error].some(message => typeof message === "string" && isRateLimited(message)));
}

class InspectError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "InspectError";
    this.code = code;
    this.details = details;
  }
}

function redact(value, token) {
  let text = redactSensitiveText(typeof value === "string" ? value : JSON.stringify(value));
  if (token) text = text.split(token).join("<redacted>");
  return text;
}

function formatInspectError(error, token) {
  const known = error instanceof InspectError;
  return JSON.parse(redact({
    code: known ? error.code : "LOCAL_FAILURE",
    message: known ? error.message : "本地配置、输出或传输失败；未自动重试。",
    ...(known && error.details ? { details: error.details } : {}),
  }, token));
}

// Screeps console 实测把 JSON 引号编码为 &#x22;；只解码一层，不递归解码用户值。
function decodeConsoleEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|quot|apos|amp|lt|gt);/gi, (whole, value) => {
    const named = { quot: '"', apos: "'", amp: "&", lt: "<", gt: ">" };
    if (value[0] !== "#") return named[value.toLowerCase()];
    const number = /^#x/i.test(value) ? parseInt(value.slice(2), 16) : parseInt(value.slice(1), 10);
    return Number.isInteger(number) && number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : whole;
  });
}

function parseInspectFrame(raw, options) {
  let text = typeof raw === "string" ? raw : String(raw);
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new InspectError("FRAME_TOO_LARGE", "console 帧超过接收上限。");
  if (text.startsWith("gz:")) {
    try { text = gunzipSync(Buffer.from(text.slice(3), "base64"), { maxOutputLength: MAX_FRAME_BYTES }).toString("utf8"); }
    catch { throw new InspectError("FRAME_DECODE_FAILED", "无法解码有界 gzip console 帧。"); }
  }
  if (text.startsWith("auth ok")) return { kind: "auth-ok" };
  if (text.startsWith("auth failed")) throw new InspectError("SOCKET_AUTH_FAILED", "console socket 认证被拒绝。");
  // 时间心跳的毫秒数字可能恰好含429，不能按子串当作HTTP状态。
  if (/^time\s+\d+(?:\.\d+)?$/.test(text.trim())) return { kind: "ignore" };
  if (!text.startsWith("[")) {
    if (isRateLimited(text)) throw new InspectError("RATE_LIMITED", "socket 返回限流，立即停止。");
    return { kind: "ignore" };
  }
  let frame;
  try { frame = JSON.parse(text); } catch { throw new InspectError("FRAME_INVALID", "console socket 返回无效 JSON。"); }
  if (!Array.isArray(frame) || frame.length !== 2) return { kind: "ignore" };
  const [channel, data] = frame;
  const expectedChannel = `user:${options.userId}/console`;
  if (channel === `err@${expectedChannel}`) {
    const limited = isRateLimited(data);
    throw new InspectError(limited ? "RATE_LIMITED" : "SUBSCRIPTION_REJECTED", "console 订阅被拒绝；立即停止。");
  }
  if (channel !== expectedChannel) return { kind: "ignore" };
  if (isRateLimited(data)) throw new InspectError("RATE_LIMITED", "console socket 返回 429，立即停止。");
  const results = [];
  const logs = data?.messages?.log;
  if (Array.isArray(logs)) for (const line of logs.slice(0, 512)) {
    if (typeof line !== "string" || !line.startsWith(PREFIX)) continue;
    let envelope, decodedLine = line;
    try { envelope = JSON.parse(line.slice(PREFIX.length)); }
    catch {
      decodedLine = decodeConsoleEntities(line);
      try { envelope = JSON.parse(decodedLine.slice(PREFIX.length)); }
      catch {
        if (line.includes(options.requestId)) throw new InspectError("RESULT_INVALID", "匹配请求的 console 结果不是完整 JSON，可能被截断。");
        continue;
      }
    }
    const incomingId = Array.isArray(envelope) ? envelope[1] : envelope?.requestId;
    if (incomingId !== options.requestId) continue;
    if (Array.isArray(envelope)) {
      try { envelope = decodeInspectWire(envelope); }
      catch { throw new InspectError("RESULT_INVALID", "匹配请求的紧凑结果不符合固定 wire schema。"); }
      if (envelope.result) {
        if (envelope.result.mode !== (options.mode || "movement")
          || envelope.result.creeps.length > options.limit || envelope.result.rooms.length !== options.rooms.length
          || envelope.result.rooms.some(room => !options.rooms.includes(room.name))
          || envelope.result.creeps.some(creep => !options.rooms.includes(creep.pos.roomName)
            && !options.creeps.includes(creep.name) && !options.creepPrefixes.some(prefix => creep.name.startsWith(prefix)))) {
          throw new InspectError("RESULT_INVALID", "匹配请求的结果违反选择器或数量上限。");
        }
        envelope.result.scan.selectionLimitReached = envelope.result.scan.matchedReturned >= options.limit;
      }
    }
    if (Buffer.byteLength(decodedLine) > options.maxBytes) throw new InspectError("RESULT_TOO_LARGE", "匹配请求的结果超过输出上限。");
    if (envelope.schema !== SCHEMA || !Number.isSafeInteger(envelope.tick) || envelope.tick < 0) throw new InspectError("RESULT_INVALID", "匹配请求缺少合法 schema 或执行 tick。");
    if (envelope.shard !== options.shard || (data.shard !== undefined && data.shard !== options.shard)) throw new InspectError("WRONG_SHARD", "console 实际执行 shard 与请求不符。");
    if (envelope.error) throw new InspectError("QUERY_REJECTED", "固定只读查询未返回完整结果。", { queryCode: String(envelope.error.code || "unknown").slice(0, 80) });
    if (options.expectedTag !== undefined && envelope.deployTag !== options.expectedTag) throw new InspectError("WRONG_DEPLOY_TAG", "console 执行版本与 --expect-tag 不符。");
    if (!envelope.result || typeof envelope.result !== "object" || Array.isArray(envelope.result)) throw new InspectError("RESULT_MISSING", "匹配请求没有诊断结果。");
    results.push(envelope);
  }
  if (results.length > 1) throw new InspectError("RESULT_AMBIGUOUS", "同一请求收到多个结果，停止且不重试。");
  return { kind: "console", result: results[0] || null };
}

async function runConsoleInspect(config, selectors, dependencies = {}) {
  let query, expression;
  try { query = validateInspectSelectors(selectors); expression = buildInspectExpression(query); }
  catch (error) { throw new InspectError("QUERY_INVALID", String(error.message || "固定查询参数不合法").slice(0, 200)); }
  const fetcher = dependencies.fetch || globalThis.fetch;
  const Socket = dependencies.WebSocket || globalThis.WebSocket;
  const timeoutMs = config.timeoutMs ?? 45000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new InspectError("CONFIG_INVALID", "timeout-ms 必须为 1000..60000。");
  if (typeof config.token !== "string" || !config.token || typeof config.username !== "string" || !config.username || config.username.length > 64
    || (config.userId !== undefined && (typeof config.userId !== "string" || !/^[a-f0-9]{24}$/i.test(config.userId)))
    || !/^[A-Za-z0-9_-]{1,64}$/.test(config.branch || "") || config.branch === "auto") throw new InspectError("CONFIG_INVALID", "需要 token、预期账号与明确 activeWorld branch。");
  const base = new URL(config.baseUrl);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new InspectError("CONFIG_INVALID", "API base URL 不允许内嵌凭据、query 或 fragment。");
  if (typeof fetcher !== "function" || typeof Socket !== "function") throw new InspectError("RUNTIME_UNAVAILABLE", "需要支持 fetch 与 WebSocket 的 Node.js。");
  const controller = new AbortController();
  const trace = [];
  let socket;
  let settled = false;
  let postStarted = false;
  let postAccepted = false;
  let receivedResult;
  let stage = "identity";
  let resolveOperation;
  let rejectOperation;
  const operation = new Promise((resolve, reject) => { resolveOperation = resolve; rejectOperation = reject; });
  const fail = error => { if (!settled) { settled = true; rejectOperation(error); } };
  const deadline = setTimeout(() => fail(new InspectError(postStarted ? "RESULT_TIMEOUT" : "SUBSCRIPTION_TIMEOUT", postStarted ? "请求期限内未确认完整结果；可能已执行，不自动重试。" : "期限内未建立身份和 console 订阅；没有提交查询。", { stage, postStarted, postAccepted, resultCaptured: !!receivedResult, mayHaveExecuted: postStarted })), timeoutMs);
  async function api(endpoint, method = "GET", body) {
    if (settled || controller.signal.aborted) throw new InspectError("STOPPED", "查询已停止。");
    let response;
    try {
      response = await fetcher(new URL(endpoint, base), { method, headers: { "X-Token": config.token, "X-Username": config.token, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal });
    } catch {
      throw new InspectError(method === "POST" ? "POST_AMBIGUOUS" : "READ_FAILED", method === "POST" ? "POST 未获得确认，可能已执行；不自动重试。" : "身份读取失败；不自动重试。", { endpoint, mayHaveExecuted: method === "POST" });
    }
    if (settled) throw new InspectError("STOPPED", "查询已停止。");
    if (response.status === 429) {
      try { await response.body?.cancel(); } catch { /* 限流不等待响应体或重试。 */ }
      throw new InspectError("RATE_LIMITED", "HTTP 429：立即停止，不读取限流链接或自动重试。", { endpoint, status: 429, mayHaveExecuted: method === "POST" });
    }
    let text;
    try { text = await response.text(); } catch { throw new InspectError(method === "POST" ? "POST_AMBIGUOUS" : "READ_FAILED", "HTTP 响应未完整读取；不自动重试。", { endpoint, status: response.status, mayHaveExecuted: method === "POST" }); }
    const safeBody = redact(text, config.token).slice(0, 800);
    const details = { endpoint, status: response.status, body: safeBody, mayHaveExecuted: method === "POST" };
    if (!response.ok) throw new InspectError(method === "POST" ? "POST_HTTP_REJECTED" : "READ_REJECTED", "Screeps HTTP 请求失败，不自动重试。", details);
    if (Buffer.byteLength(text) > 16384) throw new InspectError("RESPONSE_TOO_LARGE", "API 响应超过接收上限，不自动重试。", { endpoint, status: response.status, mayHaveExecuted: method === "POST" });
    let result;
    try { result = JSON.parse(text); } catch { throw new InspectError(method === "POST" ? "POST_AMBIGUOUS" : "READ_INVALID", "API 未返回合法 JSON，不自动重试。", details); }
    trace.push({ endpoint, method, status: response.status });
    if (result.ok !== 1) throw new InspectError(method === "POST" ? "CONSOLE_REJECTED" : "READ_REJECTED", method === "POST" ? "console POST 未确认 accepted；没有将其当作执行结果。" : "身份 API 拒绝请求。", details);
    return result;
  }
  const listeners = {};
  (async () => {
    const me = await api("/api/auth/me");
    if (me.username !== config.username || (config.userId && me._id !== config.userId) || !/^[a-f0-9]{24}$/i.test(me._id || "")) throw new InspectError("WRONG_ACCOUNT", "auth/me 与预期账号不符；未提交 console。");
    const branches = await api("/api/user/branches");
    if (!Array.isArray(branches.list) || branches.list.filter(branch => branch.activeWorld).length !== 1 || branches.list.find(branch => branch.activeWorld)?.branch !== config.branch) throw new InspectError("WRONG_ACTIVE_BRANCH", "activeWorld branch 与预期不符；未提交 console。");
    if (settled) return;
    const frameOptions = { ...query, userId: me._id };
    const wsUrl = new URL("/socket/websocket", base);
    wsUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    stage = "socket-auth";
    socket = new Socket(wsUrl.toString());
    const finishIfComplete = () => {
      if (postAccepted && receivedResult && !settled) {
        settled = true;
        resolveOperation({ identity: { username: me.username, userId: me._id, branch: config.branch, shard: query.shard }, post: { accepted: true, attempts: 1 }, snapshot: receivedResult, trace });
      }
    };
    listeners.open = () => {
      if (!settled) try { socket.send(`auth ${config.token}`); }
      catch { fail(new InspectError("SOCKET_FAILED", "console socket 无法发送认证，不自动重连。")); }
    };
    listeners.message = event => {
      if (settled) return;
      try {
        const frame = parseInspectFrame(event.data, frameOptions);
        if (frame.kind === "auth-ok" && stage === "socket-auth") {
          stage = "subscribing";
          socket.send(`subscribe user:${me._id}/console`);
        } else if (frame.kind === "console") {
          if (frame.result) {
            if (!postStarted || receivedResult) throw new InspectError("RESULT_AMBIGUOUS", "结果早于本次 POST 或重复出现，不自动重试。");
            receivedResult = frame.result;
            finishIfComplete();
          }
          // 首个该频道帧证明服务器已经处理订阅；之后才发送唯一一次 POST。
          if (!postStarted && stage === "subscribing") {
            postStarted = true;
            stage = "console-post";
            api("/api/user/console", "POST", { expression, shard: query.shard }).then(() => {
              if (settled) return;
              postAccepted = true;
              stage = "awaiting-result";
              finishIfComplete();
            }, fail);
          }
        }
      } catch (error) { fail(error); }
    };
    listeners.error = () => fail(new InspectError("SOCKET_FAILED", "console socket 失败，不自动重连。", { postStarted, postAccepted, mayHaveExecuted: postStarted }));
    listeners.close = () => fail(new InspectError("SOCKET_CLOSED", "console socket 在完整结果前断开，不自动重连。", { postStarted, postAccepted, mayHaveExecuted: postStarted }));
    for (const [name, listener] of Object.entries(listeners)) socket.addEventListener(name, listener);
  })().catch(fail);
  try { return await operation; }
  finally {
    settled = true;
    clearTimeout(deadline);
    controller.abort();
    if (socket) {
      for (const [name, listener] of Object.entries(listeners)) socket.removeEventListener(name, listener);
      try { socket.close(); } catch { /* 连接建立失败时也不重试。 */ }
    }
  }
}

module.exports = { PREFIX, SCHEMA, InspectError, redact, formatInspectError, decodeConsoleEntities, parseInspectFrame, runConsoleInspect };
