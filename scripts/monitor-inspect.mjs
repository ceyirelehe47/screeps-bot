#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { InspectError, formatInspectError, redact, runConsoleInspect } from "./lib/monitorInspect.cjs";
import { validateInspectSelectors } from "./lib/monitorInspectQuery.cjs";

const HELP = `一次只读 console 诊断（Node.js 22+）
node scripts/monitor-inspect.mjs --room E3N53 --creep-prefix remoteCarrier- --shard shard1

--room <房间>           可重复，最多3个；自动选中该房自有creep并读取房间事实
--mode <movement|pair|threats>  固定诊断模式，默认movement；一次仅一个query
--creep <精确名称>      可重复，最多4个
--creep-prefix <前缀>   可重复，最多4个，至少6字符；匹配最多8个creep
--shard <名称>          单一目标，默认SCREEPS_MONITOR_SHARD或shard1，不自动探测其它shard
--expect-tag <完整tag>  可选，实际执行tag不符即失败
--branch <activeWorld>  默认.secret.json main.branch或default；不允许auto
--username <预期账号>   默认SCREEPS_MONITOR_USERNAME或main.username或forster
--user-id <预期ID>      可选，与auth/me精确核对
--limit <1..8>          最大creep数；--max-bytes <2048..24000>限制console结果
--timeout-ms <期限>     1000..60000，默认45000；任何失败不重试
--out <monitor-data/*.json|->  默认保存新UUID文件；-只输出JSON；禁止覆盖

仅使用SCREEPS_TOKEN或.secret.json main.token，不接受--token/--expr。
先核账号/activeWorld，再建立WS订阅，再唯一POST；accepted不等于结果。
`;

function argumentsFrom(argv) {
  const options = { rooms: [], creeps: [], creepPrefixes: [] };
  const repeated = { "--room": "rooms", "--creep": "creeps", "--creep-prefix": "creepPrefixes" };
  const singular = { "--mode": "mode", "--shard": "shard", "--expect-tag": "expectedTag", "--branch": "branch", "--username": "username", "--user-id": "userId", "--limit": "limit", "--max-bytes": "maxBytes", "--timeout-ms": "timeoutMs", "--out": "output" };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--help") { options.help = true; continue; }
    const split = argv[index].indexOf("=");
    const key = split < 0 ? argv[index] : argv[index].slice(0, split);
    if (!repeated[key] && !singular[key]) throw new InspectError("ARGUMENT_INVALID", "未知参数；入口不接受任意表达式或token参数。");
    const value = split < 0 ? argv[++index] : argv[index].slice(split + 1);
    if (!value || value.startsWith("--")) throw new InspectError("ARGUMENT_INVALID", "参数缺少值。");
    if (repeated[key]) options[repeated[key]].push(value);
    else {
      if (options[singular[key]] !== undefined) throw new InspectError("ARGUMENT_INVALID", "单值参数不可重复。");
      options[singular[key]] = value;
    }
  }
  for (const key of ["limit", "maxBytes", "timeoutMs"]) if (options[key] !== undefined) options[key] = Number(options[key]);
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  let token;
  let fd;
  let output;
  const requestId = randomUUID();
  let request;
  try {
    const args = argumentsFrom(argv);
    if (args.help || argv.length === 0) { fs.writeSync(1, HELP); return 0; }
    let secret = {};
    try { secret = JSON.parse(fs.readFileSync(path.resolve(".secret.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw new InspectError("CONFIG_INVALID", "无法读取认证配置，未输出配置内容。"); }
    const stored = secret.main || {};
    token = process.env.SCREEPS_TOKEN || stored.token;
    const baseUrl = process.env.SCREEPS_BASE_URL || `${stored.protocol || "https"}://${stored.hostname || "screeps.com"}${stored.port ? `:${stored.port}` : ""}${stored.path || "/"}`;
    let selectors;
    try { selectors = validateInspectSelectors({ requestId, shard: args.shard || process.env.SCREEPS_MONITOR_SHARD || "shard1", rooms: args.rooms, creeps: args.creeps, creepPrefixes: args.creepPrefixes, ...(args.mode !== undefined ? { mode: args.mode } : {}), ...(args.limit !== undefined ? { limit: args.limit } : {}), ...(args.maxBytes !== undefined ? { maxBytes: args.maxBytes } : {}), ...(args.expectedTag !== undefined ? { expectedTag: args.expectedTag } : {}) }); }
    catch (error) { throw new InspectError("SELECTOR_INVALID", String(error.message || "选择器不合法").slice(0, 200)); }
    request = selectors;
    output = args.output === "-" ? null : path.resolve(args.output || `monitor-data/inspect-${requestId}.json`);
    if (output) {
      const relative = path.relative(path.resolve("monitor-data"), output);
      if (relative.startsWith("..") || path.isAbsolute(relative) || path.extname(output) !== ".json") throw new InspectError("OUTPUT_INVALID", "结果文件必须位于当前仓库monitor-data内且为.json。");
      fs.mkdirSync(path.dirname(output), { recursive: true });
      // 解析父目录真实路径，拒绝通过symlink把结果写到ignored目录之外。
      const realRoot = fs.realpathSync(path.resolve("monitor-data"));
      const realParent = fs.realpathSync(path.dirname(output));
      const realRelative = path.relative(realRoot, realParent);
      if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new InspectError("OUTPUT_INVALID", "结果目录不能通过symlink跳出monitor-data。");
      try { fd = fs.openSync(output, "wx", 0o600); }
      catch (error) { throw new InspectError(error.code === "EEXIST" ? "OUTPUT_EXISTS" : "OUTPUT_FAILED", error.code === "EEXIST" ? "结果文件已存在，请指定新文件名。" : "无法创建诊断结果文件。"); }
    }
    const result = await runConsoleInspect({ token, baseUrl, username: args.username || process.env.SCREEPS_MONITOR_USERNAME || stored.username || "forster", userId: args.userId, branch: args.branch || stored.branch || "default", ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}) }, selectors);
    const document = { schema: "codex-monitor-inspect-client/v1", ok: true, receivedAt: new Date().toISOString(), requestId, request, output, ...result };
    const serialized = redact(document, token) + "\n";
    if (fd !== undefined) fs.writeFileSync(fd, serialized);
    fs.writeSync(1, serialized);
    return 0;
  } catch (error) {
    const document = { schema: "codex-monitor-inspect-client/v1", ok: false, failedAt: new Date().toISOString(), requestId, request, output, error: formatInspectError(error, token) };
    const serialized = redact(document, token) + "\n";
    if (fd !== undefined) fs.writeFileSync(fd, serialized);
    fs.writeSync(1, serialized);
    return 1;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 原生WebSocket没有terminate；文件/stdout同步完成后结束，避免关闭握手拖过有界期限。
  process.exit(await main());
}
