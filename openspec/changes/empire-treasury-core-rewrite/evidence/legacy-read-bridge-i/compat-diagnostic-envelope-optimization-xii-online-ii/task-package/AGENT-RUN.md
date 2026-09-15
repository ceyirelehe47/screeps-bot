# Diagnostic Envelope Optimization XII + Online Recheck II v4 · 完整 Agent 任务书

## 0. 目标、边界与失败纪律

本 resolved 包包含 XII 完整源码、精确生成变换、固定测试、全仓离线门禁、四点在线执行、恢复、比较、归档和发布工具。Agent 只执行固定字节，不得现场改实现、测试、锁或任务书。

v4 修复 v3 在真实仓库 Node 门禁暴露的三项确定性缺陷：

- 两处跨 `vm` realm 的 strict deep equality；
- 生成器公开 `G.P` 仍停留在 IX→XI，而 live preview 已是 XII；
- 修正源码后，本地未推送 v3 source commit 需要包内官方替换迁移。

严格纪律：

- `tools/observe.cjs` 只允许执行一次；不增加第五点，不开第二窗口。
- candidate POST 最多 1 次，restore POST 最多 1 次；写入超时绝不重发。
- 仅只读 GET 使用有界重试。
- 不得手工 reset、amend、rebase、force-push，也不得修改旧失败 evidence。
- 任一确定性失败保存原始证据后停止；候选已上传时优先完成唯一恢复闭环。
- 性能变化不是成功门槛；不得把四点诊断写成 12 点正式观察或生产切换授权。

v1/v2/v3 目录全部保留为历史失败证据。本轮必须使用全新的 v4 resolved 与 v4 execution 目录。

## 1. 路径

```bash
PKG="D:/code/screeps/incoming/screeps-compat-diagnostic-envelope-optimization-XII-online-II-2026-09-15-v4-resolved"
REFACTOR="D:/code/screeps/screeps-bot"
COMPAT="D:/code/screeps/screeps-bot-compat-read-i"
WORK="D:/code/screeps/compat-diagnostic-envelope-XII-online-II-v4-execution"
SECRET="$COMPAT/.secret.json"

test ! -e "$WORK" || exit 1
mkdir "$WORK" || exit 1
```

`PKG`、`WORK` 与两个仓库不得互相包含，也不得通过 symlink/junction 指向仓库内部。凭据只传路径，不打印、不复制、不入库。

## 2. 包、基线与 XI 先决证据

```bash
node -e 'console.log(JSON.stringify(require(process.argv[1]).verifyPackage()))' "$PKG/tools/util.cjs"
node "$PKG/tools/check-baseline.cjs" --refactor "$REFACTOR" --compat "$COMPAT"
node "$PKG/tools/run-tests.cjs" --compat "$COMPAT" --out "$WORK/tool-tests"
```

必须满足：

```text
PACKAGE_INTEGRITY_VERIFIED
ENVELOPE_XII_BASELINES_VERIFIED
ENVELOPE_XII_PREREQUISITES_VERIFIED
ENVELOPE_XII_PACKAGE_TESTS_VERIFIED
35/35，failed/skipped/todo/cancelled 全部 0
```

`check-baseline` 允许且只允许：

```text
base
superseded-applied
already-applied
```

对当前机器，预期为：

```text
compatLocalState = superseded-applied
migrationRequired = true
```

该状态必须通过：compat root 父提交、固定消息、精确 11 路径范围、完整 superseded tree、47 项 superseded lock、工作树干净以及远端仍在 root。

先决证据固定核验 XI：4 raw、4 diagnostic、4 attributed、2 complete、2 partial，候选/恢复各一次，旧生产字节与 75 秒运行确认闭合。

## 3. 应用或迁移固定 XII 实现

```bash
node "$PKG/tools/apply.cjs" --compat "$COMPAT" --out "$WORK/source-application.json"
```

允许的结果：

```text
ENVELOPE_XII_SOURCE_APPLIED
ENVELOPE_XII_SOURCE_ALREADY_APPLIED
ENVELOPE_XII_SOURCE_SUPERSEDED_MIGRATED
```

当前机器预期：

```text
ENVELOPE_XII_SOURCE_SUPERSEDED_MIGRATED
resumed = true
migrated = true
replacedHead = v2/v3 本地旧 source commit
```

迁移仅在旧提交的父提交、消息、11 路径范围、完整 tree 与 superseded lock 全部精确匹配时执行。工具使用：

```text
commit-tree(correctedTree, parent=compatRoot)
update-ref --CAS oldHead -> newHead
read-tree + checkout-index 同步 index/worktree
```

这不是手工 reset/amend/rebase。迁移后分支历史必须仍然是：

```text
compat root → 恰好一个 corrected XII source commit
```

源码提交信息固定为：

```text
perf(compat): compact diagnostic envelope and bounded preview work
```

修正后的 11 路径仍与原 XII 范围相同；其中 v4 改正：

- `envelope-optimization.spec.cjs` 的 calls 比较改为 realm-neutral；
- `G.P_XI` 保留 IX→XI；
- 公开 `G.P` 精确组合 IX→XI→XII，restore 反向组合；
- generator `--write`/`--check`、manifest/provenance 与完整 post lock 均从 corrected bytes 重算。

不得创建第二个 source commit，不得保留旧 source commit 在当前分支链上。

## 4. 完整离线门禁

```bash
node "$PKG/tools/build.cjs" --compat "$COMPAT" --out "$WORK/offline-checks"
```

入口首先使用 corrected `references/source-lock.json` 核验 47 条冻结路径。必须满足：

```text
ENVELOPE_XII_OFFLINE_VERIFIED
8 份 Node specs / 290 tests 全通过
loader --check 通过并核对全部 manifest outputs
tsconfig.build.json --noEmit 通过
tsconfig.json --noEmit 通过
Jest 195 suites / 685 tests
Rollup build-only 通过
```

这些层级有包含关系，不相加。Warm build 不能上传；候选必须从临时 ON 提交的干净 detached worktree重建。

## 5. 固定语义与禁止降级

必须保留：

- direct 与 Core 独立真实 Store 读取与逐项对拍；
- task/reservation 全表验证与 256 上界；
- safe integer、损坏输入、pending/healthy、route merge、owner/expiry；
- 完整 eager index/view；
- 两房 × 两资源的 4 行 projection 与 16 次索引查询；
- IX 九子阶段与 primitive work counters；
- 默认 OFF、旧生产 writer、`maxSampleCpu=2`、`reserveCpu=5`。

XII 只做：

- `afterRetention` 仅携带 `serializationAndSize/emit/retention`；
- verifier 通过 tick/ordinal/calls/checkpoints/phase-sum 合并 prefix 与 tail；
- 每样本复用 Memory 根游标，仍完整枚举表；
- 删除有界 Preview 临时对象/数组/Set；
- 修复测试 realm 边界与当前 Preview 生成变换公开契约。

不得用旧 Memory 投影替代真实 Store，不得删减 commitment 正确性，不得跨样本缓存业务结果。

## 6. 上线前事实确认

继续前必须真实确认：

- 没有其他 Agent、人、CI、IDE watcher 或自动部署会写 `default`；
- 上轮 collector/guard/recovery 均已退出；
- refactor 正好位于固定基线；compat 正好位于 corrected XII source commit；
- 两仓工作树和索引干净；两条远端仍在本轮起始 root；
- 机器可持续运行至窗口结束、恢复及 75 秒确认完成。

无法确认时止于离线阶段。

## 7. 唯一在线入口

```bash
node "$PKG/tools/observe.cjs" \
  --refactor "$REFACTOR" --compat "$COMPAT" \
  --offline "$WORK/offline-checks" --tests "$WORK/tool-tests" \
  --work "$WORK/live" --secret "$SECRET" \
  --execute --exclusive-target --prior-workers-stopped
```

只能执行一次。窗口：

```text
S = ceil((freshTick + 150) / 100) × 100
points = S, S+100, S+200, S+300
```

固定：4 点、100 tick、`E3N59/E4N58`、`energy/H`、2 CPU、reserve 5、bucket≥2000、日志≤16384 bytes、恢复运行确认 75 秒。

## 8. 固定收尾

无论 observe 退出码如何，都不得再次运行 observe。

```bash
node "$PKG/tools/reconcile.cjs" \
  --compat "$COMPAT" --run "$WORK/live/run" --secret "$SECRET" \
  --out "$WORK/reconcile.json"
```

若候选未写入，不恢复；若已确认旧生产，不恢复。仅当仍是本轮候选、恢复从未尝试且旧 worker 全部退出时，允许唯一恢复：

```bash
node "$PKG/tools/recover.cjs" \
  --compat "$COMPAT" --run "$WORK/live/run" --secret "$SECRET" \
  --execute-recovery --exclusive-target --prior-workers-stopped
```

存在 `restore-attempt.json` 时绝不重发。

随后：

```bash
node "$PKG/tools/verify.cjs" \
  --run "$WORK/live/run" --out "$WORK/final-verification.json"

node "$PKG/tools/compare.cjs" \
  --run "$WORK/live/run" --out "$WORK/envelope-comparison.json"
```

比较器从原始 console 重算完整/partial 数、九子阶段、parent prefix、三个 tail phase、completed elapsed 及与 XI 的 prior/current/delta。末点无后继时尾部仍不可观测。

## 9. 归档与发布

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

成功时 compat 链必须严格为：

```text
91b9a992 default OFF root
→ one corrected XII source commit
→ temporary four-point ON
→ exact default OFF
```

最终 OFF tree 必须等于 corrected XII source tree。Refactor 只允许新增一个 evidence 提交，路径仅位于：

```text
openspec/changes/empire-treasury-core-rewrite/evidence/
legacy-read-bridge-i/compat-diagnostic-envelope-optimization-xii-online-ii/
```

只允许普通 fast-forward 推送。

## 10. 允许与禁止的终态

完整闭环允许：

```text
ENVELOPE_XII_OFFLINE_VERIFIED
CPU_DIAGNOSTIC_CAPTURE_VERIFIED
ENVELOPE_XII_ATTRIBUTION_RECORDED
ENVELOPE_XII_COMPARISON_RECORDED
RESTORED_BYTES_AND_RUNTIME_VERIFIED
```

除非新原始证据充分证明，继续保留：

```text
ENGINE_CPU_BUDGET_GAP_UNRESOLVED
```

即使 4/4 完整，也不等于 12 点正式兼容观察通过，更不授权完整 Treasury 生产切换。
