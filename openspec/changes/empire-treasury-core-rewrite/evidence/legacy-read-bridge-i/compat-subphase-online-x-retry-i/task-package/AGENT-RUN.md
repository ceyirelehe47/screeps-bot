# Subphase Online X Retry I · Agent 任务书

## 0. 角色、目标与失败纪律

本包已经包含完整实现、固定测试、在线执行链、恢复链、归因器、归档器和发布器。Agent **只执行固定字节和验收**，不得现场补实现、改阈值、增加窗口、修改测试或放宽门禁。

本轮目标是一轮闭合：

```text
验证上一轮 source-manifest remediation 已入库
→ 验证包内只读重试实现
→ 完整真实仓库离线门禁
→ 新鲜四点 IX 在线子阶段归因
→ 恢复旧生产与独立 75 秒运行确认
→ 归档、证据提交、双分支普通推送
```

上轮 `compat-subphase-online-x` 已完成 source-manifest remediation 和离线门禁，但 collector 在候选上传前的账户只读请求上收到一次 `HTTP_TRANSPORT_ERROR`。归档证明：`upload=null`、0 条报告、线上始终是旧生产。因此本轮不重做 remediation，只增加包内执行工具的有界**只读**重试。

严格纪律：

- 候选 POST 最多一次；恢复 POST 最多一次；任何 POST 超时均不得重发。
- 只读请求可在同一个 8 秒总时限内最多尝试三次；认证拒绝、非法 JSON 和 API 语义失败不得重试。
- `observe` 只能运行一次，不自动换窗口、不追加第五点、不启动第二窗口。
- 上传前失败：保存证据、恢复本地默认 OFF、归档并停止；不得为了“跑起来”再次执行。
- 上传后失败：不得杀死安全收尾进程；等待恢复 worker/guard 完成，再使用固定只读对账与受限恢复入口。
- 不得 reset、amend、rebase、force-push，不得修改既有证据。
- 失败状态必须如实报告，不能使用成功标签。

## 1. 固定身份

```text
repository       ceyirelehe47/screeps-bot
compat branch    compat/treasury-read-bridge-i
compat base      d5e09b623de7391b3f69e51fb80cf7a852618509
compat base tree c30d5beeb9c8e17b2a152047521f72691c214fd3
refactor branch  refactor/empire-treasury-rearchitecture
refactor base    b6fffa20bfaaa8e6203dee25b09ff050048caa39
IX core blob     62752b09e3828e67a9000aeffcda0b2436368bf1
server           https://screeps.com
account          forster / 634fe406347a7b69b28aeccb
branch           default
shard            shard1
rooms            E3N59, E4N58
resources        energy, H
old production   06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c
old digest       84f769750c3a1b5ab5b4b70d13be603ff9b6acd709aa2c0a0fb61cacd8b410bf
```

工具会从 refactor Git 对象库核对上轮固定原件：

```text
FINAL-VERIFICATION.json        NOT_DEPLOYED / COLLECTOR_EARLY_EXIT / raw 0
remediation/result.json        SOURCE_MANIFEST_REMEDIATION_COMMIT_VERIFIED
baseline-checks/result.json    246 Node / 195 suites / 685 tests
run/source-closed.json         closed head d5e09b6 / same tree as source
```

## 2. 路径

将 ZIP 解压到两个 Git 工作树之外的新目录：

```bash
PKG="D:/code/screeps/incoming/screeps-compat-subphase-online-X-retry-I-2026-09-14"
REFACTOR="D:/code/screeps/screeps-bot"
COMPAT="D:/code/screeps/screeps-bot-compat-read-i"
WORK="D:/code/screeps/compat-subphase-online-X-retry-I-execution"
SECRET="$COMPAT/.secret.json"

test ! -e "$WORK" || exit 1
mkdir "$WORK" || exit 1
```

`PKG`、`WORK` 与仓库不得互相包含，也不得通过 symlink/junction 指向仓库内部。`SECRET` 只传路径，不打印、不复制、不入库。

每条命令的 stdout、stderr、exit 都要保存在 `WORK` 外围执行日志中。包内工具会为正式证据生成固定文件。

## 3. 包、基线与固定工具测试

```bash
node -e 'console.log(JSON.stringify(require(process.argv[1]).verifyPackage()))' "$PKG/tools/util.cjs"
node "$PKG/tools/check-baseline.cjs" --refactor "$REFACTOR" --compat "$COMPAT"
node "$PKG/tools/run-tests.cjs" --compat "$COMPAT" --out "$WORK/tool-tests"
```

必须满足：

```text
PACKAGE_INTEGRITY_VERIFIED
SUBPHASE_X_RETRY_BASELINES_VERIFIED
SUBPHASE_X_RETRY_PREREQUISITES_VERIFIED
固定工具测试 152/152
failed / skipped / todo / cancelled 全部 0
```

基线检查会验证：

- 两条本地分支和远端分支都在固定 head；
- compat 完整 tree 为 `c30d5bee...`；
- 35 个当前来源/实现/测试文件逐字节匹配 source lock；
- 上轮候选从未 POST；
- source manifest 的 13 项输出身份门禁已经闭合。

## 4. 本包新增的只读重试规则

`runtime/read-retry.cjs` 只允许包裹只读观察：

```text
最大尝试次数       3
单次最大等待       2500 ms
总调用预算         8000 ms
固定延迟           250 ms, 750 ms
可重试 HTTP         429, 500, 502, 503, 504
可重试本地错误      transport/deadline/body-aborted/body-error/request-failed
```

明确不可重试：

```text
HTTP_AUTH_REJECTED
HTTP_JSON_INVALID
API_RESULT_NOT_SUCCESS
HTTP_RESPONSE_TOO_LARGE
其他非瞬时 4xx
```

覆盖的直接只读入口：

```text
collector account preflight
prepare room overview
prepare anchor/fresh tick
candidate pre-upload room overview
candidate pre-upload active branch
candidate pre-upload tick
```

既有身份读取和 guard tick 通道保留其原有有界只读策略。候选/恢复 `setCode` 完全不经过该 helper，依旧只尝试一次。

若实际发生重试，安全元数据会进入 `preflight-read-events.jsonl`、`actions.jsonl` 或 `collector-diagnostics.jsonl`；其中只有 operation、attempt、稳定错误码、HTTP 状态和预算，不含 token、URL 查询值、响应体或异常消息。

## 5. 完整离线仓库门禁

```bash
node "$PKG/tools/build.cjs" \
  --compat "$COMPAT" --out "$WORK/baseline-checks"
```

必须满足：

```text
SUBPHASE_X_RETRY_OFFLINE_VERIFIED
真实仓库六份 Node specs   246/246
loader --check             all-listed-outputs / 13 项通过
两套 tsc --noEmit          通过
Jest                       195 suites / 685 tests
Rollup build-only          通过
```

这些层级存在包含关系，不相加。这里的 warm build 只能作为构建门禁，不能用于上传；正式候选必须从新 ON 提交的干净 detached worktree 重新构建。

## 6. 上线前事实确认

继续之前真实确认：

- 没有其他 Agent、人、CI、IDE watcher 或自动部署会写 `default`；
- 旧 collector/guard/recovery 进程全部退出；
- 两仓工作树和索引干净；
- refactor/compat 本地和远端仍是第 1 节固定 head；
- 机器可持续运行到窗口结束、恢复与 75 秒运行确认完成；
- 包、WORK 与凭据不会在执行中被更新、删除或覆盖。

无法确认时止于离线阶段。命令行的 `--exclusive-target` 与 `--prior-workers-stopped` 是事实声明，不是形式开关。

## 7. 唯一在线执行入口

```bash
node "$PKG/tools/observe.cjs" \
  --refactor "$REFACTOR" --compat "$COMPAT" \
  --offline "$WORK/baseline-checks" --tests "$WORK/tool-tests" \
  --work "$WORK/live" --secret "$SECRET" \
  --execute --exclusive-target --prior-workers-stopped
```

**只能执行一次。**无论退出码如何，不得再次运行该命令。

窗口在所有慢速离线检查后绑定：

```text
S = ceil((freshTick + 150) / 100) × 100
points = S, S+100, S+200, S+300
```

固定限制：

```text
maxSampleCpu            2
reserveCpu              5
minBucket               2000
maxLogBytes             16384
wall limit              45 minutes
recovery runtime        75 seconds
external observed stop  5 CPU
```

5 CPU 是外部事后安全中止线，不是采样预算，也不是硬实时抢占保证。

执行顺序为：collector 完成账户只读预检并准备 WebSocket → guard/collector 就绪 → 候选 POST 唯一一次 → 四点观察 → 唯一恢复（如需要）→ 75 秒独立运行确认。

如果所有只读重试仍耗尽且候选尚未 POST，终态必须是 `NOT_DEPLOYED`；不得重绑窗口。

## 8. 九个子阶段和工作量口径

每份可归因报告最多包含：

```text
observationSetup
observationRooms
observationFinalize
observationView
commitmentSetup
commitmentTasks
commitmentReservations
commitmentFinalize
projectionRows
```

完整样本固定 12 次边界。子阶段嵌套在父阶段内，不能与父阶段相加；测量开销不扣除，也不按 task、reservation、资源键或 query 逐项采样。

Primitive counters 只描述工作组成：房间/位置/资源键、task/pending/invalid、健康检查、route candidates、reservation/owner/active、bucket 和 projection 计划/完成/query 数。它们不是 CPU 权重。

`partial_cpu_budget` 可以作为归因证据，但不是完整样本。`index complete=true` 且 `rows=[]` 仍表示投影未完成，不能解释成零承诺。

## 9. 在线命令退出后的固定收尾

先确认 `WORK/live/run` 已存在。不得立即重跑 observe。

检查 worker：

```bash
node "$PKG/tools/reconcile.cjs" \
  --compat "$COMPAT" --run "$WORK/live/run" --secret "$SECRET" \
  --out "$WORK/reconcile.json"
```

- 若不存在 `upload-attempt.json`：候选从未写入，不需要恢复。
- 若只读对账确认旧生产：不执行恢复 POST。
- 若仍是本轮候选且恢复未尝试、所有旧 worker 已退出，可执行唯一受限恢复：

```bash
node "$PKG/tools/recover.cjs" \
  --compat "$COMPAT" --run "$WORK/live/run" --secret "$SECRET" \
  --execute-recovery --exclusive-target --prior-workers-stopped
```

存在 `restore-attempt.json` 时不得重发恢复 POST。第三方代码不得覆盖。

随后重新验证原始 run：

```bash
node "$PKG/tools/verify.cjs" \
  --run "$WORK/live/run" --out "$WORK/final-verification.json"

node "$PKG/tools/compare.cjs" \
  --run "$WORK/live/run" --out "$WORK/subphase-attribution.json"
```

这两个命令在证据不足时可返回非零；仍须保留输出并进入归档，不得改写为成功。

## 10. 归档、原生 whitespace、提交与推送

确认无活跃 worker 后：

```bash
node "$PKG/tools/archive.cjs" \
  --refactor "$REFACTOR" --run "$WORK/live/run" \
  --tests "$WORK/tool-tests" --offline "$WORK/baseline-checks" \
  --secret "$SECRET"

node "$PKG/tools/publish.cjs" \
  --refactor "$REFACTOR" --compat "$COMPAT" --check-only

node "$PKG/tools/publish.cjs" \
  --refactor "$REFACTOR" --compat "$COMPAT" \
  --out "$WORK/publish-result.json" --push
```

Compat 成功链只能是：

```text
d5e09b6 fixed default-OFF source
→ temporary four-point ON
→ exact default OFF
```

最终 OFF tree 必须重新等于 `c30d5bee...`。

Refactor 只允许新增一个证据提交，范围必须全部位于：

```text
openspec/changes/empire-treasury-core-rewrite/evidence/
legacy-read-bridge-i/compat-subphase-online-x-retry-i/
```

完整原生 `git diff --cached --check` 必须 exit 0、零例外。推送只能普通 fast-forward，不允许 force-push。

## 11. 允许的终态

四点采集、归因、恢复和推送全部通过时：

```text
CPU_DIAGNOSTIC_CAPTURE_VERIFIED
SUBPHASE_X_RETRY_ATTRIBUTION_RECORDED
RESTORED_BYTES_AND_RUNTIME_VERIFIED
```

实际数据没有证明预算缺口修复时继续保留：

```text
ENGINE_CPU_BUDGET_GAP_UNRESOLVED
```

候选上传前再次失败时：

```text
NOT_DEPLOYED
SUBPHASE_X_RETRY_ATTRIBUTION_INCONCLUSIVE
SOURCE_DEFAULT_OFF_RESTORED
```

候选已上传但恢复或运行确认不完整时，必须使用归档生成的精确不确定终态，不得声称已恢复。

即使出现完整样本，也不等于十二点正式兼容观察通过，更不授权 Treasury 生产切换。
