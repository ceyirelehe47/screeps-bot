# Diagnostic Envelope XII Online II Retry I v2 · Agent 任务书

## v2 起点

旧 Retry I 的 `ENVELOPE_XII_RETRY_SOURCE_SCOPE_CHANGED` 来自错误路径清单。本版从精确 v4 实现锁读取路径；不更改源码、不新建 source commit、不迁移提交。物化已执行真实源码范围与冻结锁校验，其记录为 `SOURCE-SCOPE-VERIFICATION.json`；仍须完整执行下列门禁。

包测试为 **65/65**。其中源码范围回归使用 20 个 SHA 认证的 Git 对象子集：旧校验器必须在真实固定提交上失败，修正版必须在同一提交上通过。对象子集不是完整仓库；不能以此替代 §4。

## 0. 本轮目标与硬边界

XII 源码已经在 `982ac514d06428ffd5cea1a38add774438d7bb6e` 完成离线验收并推送。本轮**不修改任何 XII 源码**，只重试尚未发生的四点在线闭环，并在任何窗口绑定、Git 配置提交或远程 POST 前完成网络就绪与线上基线核验。

上轮在线准备因三次只读 modules GET `HTTP_DEADLINE` 终止，`noUpload=true`，零 candidate/restore POST。随后 Agent 报告线上 `default/main` 比 XI 已验收恢复基线多 3 字节，但该差异来源未获授权。本包不得把未知字节静默升级为“旧生产”。

固定纪律：

- 线上写入只允许在 **3 次连续稳定读取 + 与历史已验收旧生产字节完全一致** 后发生。
- 未知漂移得到 `LIVE_BASELINE_DRIFT_UNRESOLVED`：只记录有限摘要，停止；不绑定窗口、不创建 ON 提交、不 POST。
- candidate POST 最多一次；restore POST 最多一次；写入超时绝不重发。
- `tools/observe.cjs` 只能执行一次；不加第五点，不自动开第二窗口。
- 不得修改包、测试、锁、源码，不得 reset/amend/rebase/force-push。
- 候选已上传时优先完成唯一恢复闭环；第三方代码绝不覆盖。
- 四点成功不等于 12 点正式观察或 Treasury 生产切换授权。

## 1. 固定身份

```text
repository        ceyirelehe47/screeps-bot
compat branch     compat/treasury-read-bridge-i
source head       982ac514d06428ffd5cea1a38add774438d7bb6e
source tree       dcec716dfad41cb95e07bbed5988f1d5fde5c531
refactor branch   refactor/empire-treasury-rearchitecture
refactor base     4f0cbf7a2a991665d6089841eeb10954e834ddbf
server branch     default
shard             shard1
rooms             E3N59, E4N58
resources         energy, H
budget            maxSampleCpu=2, reserveCpu=5
```

历史已验收旧生产基线：

```text
build commit      06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c
build tree        929fa9557b1a36135a5ef1605231be1d16e87366
main bytes        4,494,463
main sha256       37d20706908220a157fc30fbf668ed98c880fdb47a34ed34b6a0302e3f11f74b
modules digest    84f769750c3a1b5ab5b4b70d13be603ff9b6acd709aa2c0a0fb61cacd8b410bf
```

未知线上漂移不改变上述授权边界。

## 2. 路径

```bash
PKG="D:/code/screeps/incoming/screeps-compat-diagnostic-envelope-XII-online-II-retry-I-2026-09-20-v2-resolved"
REFACTOR="D:/code/screeps/screeps-bot"
COMPAT="D:/code/screeps/screeps-bot-compat-read-i"
WORK="D:/code/screeps/compat-diagnostic-envelope-XII-online-II-retry-I-v2-execution"
SECRET="$COMPAT/.secret.json"
CANONICAL_BACKUP="D:/code/screeps/compat-hotpath-optimization-XI-online-I-execution/live/run/backup.json"

test ! -e "$WORK" || exit 1
mkdir "$WORK" || exit 1
```

`CANONICAL_BACKUP` 仅用于在漂移时生成有限字节窗口摘要；缺失时不影响严格阻断。它不会入库，完整模块字节也不会进入证据分支。

## 3. 包、基线、先决证据与固定测试

```bash
node -e 'console.log(JSON.stringify(require(process.argv[1]).verifyPackage()))' "$PKG/tools/util.cjs"
node "$PKG/tools/check-baseline.cjs" --refactor "$REFACTOR" --compat "$COMPAT"
node "$PKG/tools/run-tests.cjs" --compat "$COMPAT" --out "$WORK/tool-tests"
node "$PKG/tools/apply.cjs" --compat "$COMPAT" --out "$WORK/source-application.json"
```

必须满足：

```text
PACKAGE_INTEGRITY_VERIFIED
ENVELOPE_XII_RETRY_BASELINES_VERIFIED
ENVELOPE_XII_RETRY_PREREQUISITES_VERIFIED
ENVELOPE_XII_RETRY_PACKAGE_TESTS_VERIFIED
固定包测试 65/65，failed/skipped/todo/cancelled = 0
ENVELOPE_XII_RETRY_SOURCE_REUSED_VERIFIED
sourceModified = false
```

先决证据会重新核验上一轮：XII 源码 `982ac514`、290 个 Node 测试、双 tsc、Jest 195/685、Rollup 全绿；在线为 `NOT_DEPLOYED`，零样本、零上传。

## 4. 完整离线门禁

```bash
node "$PKG/tools/build.cjs" --compat "$COMPAT" --out "$WORK/offline-checks"
```

必须满足：

```text
ENVELOPE_XII_RETRY_OFFLINE_VERIFIED
8 specs / 290 Node tests
loader --check
两套 tsc --noEmit
Jest 195 suites / 685 tests
Rollup build-only
```

源码字节必须保持 `982ac514`，本轮不得产生新的 source commit。

## 5. 上线前事实确认

继续前必须真实确认：

- 没有其他 Agent、人、CI、网页 IDE、watcher 或自动部署会写 `default`；
- 上轮 collector/guard/recovery 已退出；
- 两仓干净，HEAD 与远端均正好等于第 1 节固定值；
- 机器可持续运行至最长 30 分钟就绪等待、四点窗口、恢复及 75 秒确认完成。

无法确认时止于离线阶段。

## 6. 唯一在线入口

```bash
CANONICAL_ARGS=()
test ! -e "$CANONICAL_BACKUP" || CANONICAL_ARGS=(--canonical-backup "$CANONICAL_BACKUP")

node "$PKG/tools/observe.cjs" \
  --refactor "$REFACTOR" --compat "$COMPAT" \
  --offline "$WORK/offline-checks" --tests "$WORK/tool-tests" \
  --work "$WORK/live" --secret "$SECRET" \
  --execute --exclusive-target --prior-workers-stopped \
  --canonical-baseline-only \
  "${CANONICAL_ARGS[@]}"
```

只能执行一次。

### 6.1 任何绑定之前的就绪门

最长等待 30 分钟。每轮只读检查：

```text
account → active branch → modules → active branch → owned rooms → shard time
```

需要 3 次连续、间隔 15 秒、模块逐字节一致的成功轮次。网络 deadline/transport error 只会在外层就绪窗口内继续读；认证、账号、branch、模块形状、房间或字节漂移错误立即终止。

三次稳定后仍必须同时满足：

```text
modules digest = 历史已验收 digest
main bytes/sha256 = 历史已验收值
build commit/tree = 历史已验收值
branch = default
```

若不满足：

```text
LIVE_BASELINE_DRIFT_UNRESOLVED
noUpload = true
canonicalBaselineAccepted = false
```

此时不得人工改包继续。工具会在可能时用固定 XI `backup.json` 生成偏移、差异段哈希以及最多 64 字节的差异段 hex；不会归档完整源码。

### 6.2 通过就绪门后的固定窗口

```text
S = ceil((freshTick + 150) / 100) × 100
points = S, S+100, S+200, S+300
```

固定四点、100 tick、两房两资源、2 CPU、reserve 5、bucket≥2000、日志≤16384 bytes。候选从临时 ON 提交的干净 detached worktree 重新构建。

## 7. 固定收尾

无论 observe 退出码如何，绝不再次运行 observe。

若存在 `session.json`：

```bash
node "$PKG/tools/reconcile.cjs" \
  --compat "$COMPAT" --run "$WORK/live/run" --secret "$SECRET" \
  --out "$WORK/reconcile.json"
```

仅当仍是本轮候选且从未尝试恢复时，允许：

```bash
node "$PKG/tools/recover.cjs" \
  --compat "$COMPAT" --run "$WORK/live/run" --secret "$SECRET" \
  --execute-recovery --exclusive-target --prior-workers-stopped
```

恢复目标始终是会话内已经通过 canonical gate 的精确 backup，POST 不重发。恢复后使用新 closureId 做独立 75 秒运行确认。

无论是否建立 session，均执行：

```bash
node "$PKG/tools/verify.cjs" \
  --run "$WORK/live/run" --out "$WORK/final-verification.json"

node "$PKG/tools/compare.cjs" \
  --run "$WORK/live/run" --out "$WORK/envelope-retry-comparison.json"
```

证据不足导致非零退出是允许终态，输出仍须保留。

## 8. 归档与发布

```bash
node "$PKG/tools/archive.cjs" \
  --refactor "$REFACTOR" --compat "$COMPAT" \
  --run "$WORK/live/run" --tests "$WORK/tool-tests" \
  --offline "$WORK/offline-checks" \
  --application "$WORK/source-application.json" --secret "$SECRET"

node "$PKG/tools/publish.cjs" \
  --refactor "$REFACTOR" --compat "$COMPAT" --check-only

node "$PKG/tools/publish.cjs" \
  --refactor "$REFACTOR" --compat "$COMPAT" \
  --out "$WORK/publish-result.json" --push
```

若基线漂移阻断，compat 必须仍为 `982ac514`，只允许新增一个 read-only/inconclusive evidence commit。

若在线闭环执行，compat 链必须严格为：

```text
982ac514 default OFF source
→ temporary four-point ON
→ exact default OFF
```

最终 OFF tree 必须重新等于 `dcec716d...`。Refactor 只允许新增一个证据提交，路径仅位于：

```text
.../compat-diagnostic-envelope-optimization-xii-online-ii-retry-i/
```

## 9. 允许与禁止的终态

基线漂移时允许：

```text
LIVE_BASELINE_DRIFT_UNRESOLVED
NOT_DEPLOYED
ENVELOPE_XII_RETRY_COMPARISON_INCONCLUSIVE
ENVELOPE_XII_RETRY_EVIDENCE_PUSHED
```

完整在线闭环允许：

```text
ENVELOPE_XII_RETRY_OFFLINE_VERIFIED
CPU_DIAGNOSTIC_CAPTURE_VERIFIED
ENVELOPE_XII_RETRY_ATTRIBUTION_RECORDED
ENVELOPE_XII_RETRY_COMPARISON_RECORDED
RESTORED_BYTES_AND_RUNTIME_VERIFIED
ENVELOPE_XII_RETRY_EVIDENCE_PUSHED
```

始终禁止直接宣布：

```text
FULL_COMPATIBILITY_OBSERVED
12_POINT_OBSERVATION_PASSED
TREASURY_PRODUCTION_READY
```

除非后续独立证据充分，继续保留：

```text
ENGINE_CPU_BUDGET_GAP_UNRESOLVED
```
