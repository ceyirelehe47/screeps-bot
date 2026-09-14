# Hot-path Optimization XI + Online Recheck I · Agent 任务书

## 0. 角色、目标与失败纪律

本包已经包含 **XI 完整实现、固定补丁、离线等价测试、真实仓库门禁、在线执行链、恢复链、比较器、归档器和发布器**。Agent 只负责按固定字节执行、测验与验收，不得现场补实现、删减校验、调整预算、改测试或自行选择另一套优化。

本轮一次完成一个工程闭环：

```text
固定基线与上轮证据核验
→ 应用 17 路径 XI 热路径优化并提交
→ 完整离线等价与真实仓库门禁
→ 新鲜四点在线复测
→ 九子阶段与上一轮逐阶段比较
→ 唯一恢复和独立 75 秒运行确认
→ 精确归档、证据提交、双分支普通推送
```

严格纪律：

- `tools/observe.cjs` 只能执行一次；不自动换窗口、不追加第五点、不启动第二窗口。
- 候选 POST 最多一次；恢复 POST 最多一次；任何 POST 超时都不得重发。
- 上传前只读请求保留已验收的三次／八秒有界重试；写入绝不经过该重试。
- 性能改善不是采集成功门槛。变快、变慢或无变化都必须如实归档。
- 上传前失败：恢复本地默认 OFF、归档并停止。上传后失败：等待固定 guard/recovery 链完成，再按固定只读对账处理。
- 不得 reset、amend、rebase、force-push，不得修改既有 evidence 或任务包。
- 失败终态不得使用成功标签。

## 1. 固定身份

```text
repository        ceyirelehe47/screeps-bot
compat branch     compat/treasury-read-bridge-i
compat base       9adb2739935c03c0450acfebbab94912a5e3e593
compat base tree  c30d5beeb9c8e17b2a152047521f72691c214fd3
refactor branch   refactor/empire-treasury-rearchitecture
refactor base     53cf8a6c07a171eeb8438c5cc07ac66d4968f1fc
server            https://screeps.com
account           forster / 634fe406347a7b69b28aeccb
server branch     default
shard             shard1
rooms             E3N59, E4N58
resources         energy, H
old production    06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c
old digest        84f769750c3a1b5ab5b4b70d13be603ff9b6acd709aa2c0a0fb61cacd8b410bf
```

上轮固定事实从 refactor Git 对象库重新核验：4 条原始／诊断／归因报告，1 个完整样本、3 个 `partial_cpu_budget`，候选和恢复各一次，旧生产字节与 75 秒运行状态均闭合。

## 2. XI 固定实现

源码提交信息固定为：

```text
perf(compat): reduce read hot-path duplication
```

只允许 17 条仓库路径变化。核心优化为：

- Observation：复用首次 Store 稀疏键枚举进行 empire totals；在既有房间循环构造 null-prototype room lookup；不再为 view 二次扫描 room Map。
- Preview/direct：在端点循环累计选定资源总量；每样本只读取一次资源目录；复用已验证的房间名列表。
- Commitment：任务和预留各只创建一份键数组；自路由复用同一 task scope bucket；manual demand coverage 走已知恒真分支，automatic 仍调用 canonical expiry helper。
- 所有 task／reservation 仍全表验证；owner、expiry、safe-integer、incomplete scope、route merge、完整 index/view 和四行 projection 语义均保留。
- 不跨样本缓存业务结果，不使用旧 Memory 投影替代真实 Store，不改变授权、writer、默认 OFF 或 2 CPU 预算。

确定性 operation-count 基准只证明减少重复工作，不等于引擎 CPU 百分比：

```text
observation Object.keys calls      8 → 4
observation room-view Map build    1 → 0
legacy authority Object.values     2 → 0
self-route duplicate task Map.get  1 → 0（每条 self route）
preview Object.values reductions   4 → 0
resource catalogue reads           2 → 1（每样本）
```

## 3. 路径

```bash
PKG="D:/code/screeps/incoming/screeps-compat-hotpath-optimization-XI-online-I-2026-09-14"
REFACTOR="D:/code/screeps/screeps-bot"
COMPAT="D:/code/screeps/screeps-bot-compat-read-i"
WORK="D:/code/screeps/compat-hotpath-optimization-XI-online-I-execution"
SECRET="$COMPAT/.secret.json"

test ! -e "$WORK" || exit 1
mkdir "$WORK" || exit 1
```

`PKG`、`WORK` 和两仓不得互相包含，也不得通过 symlink/junction 指向仓库内部。凭据只传路径，不打印、不复制、不入库。

## 4. 包、基线、先决证据与固定工具测试

```bash
node -e 'console.log(JSON.stringify(require(process.argv[1]).verifyPackage()))' "$PKG/tools/util.cjs"
node "$PKG/tools/check-baseline.cjs" --refactor "$REFACTOR" --compat "$COMPAT"
node "$PKG/tools/run-tests.cjs" --compat "$COMPAT" --out "$WORK/tool-tests"
```

必须满足：

```text
PACKAGE_INTEGRITY_VERIFIED
HOTPATH_XI_BASELINES_VERIFIED
HOTPATH_XI_PREREQUISITES_VERIFIED
固定工具测试 173/173
failed / skipped / todo / cancelled 全部 0
```

基线检查会锁定两条本地／远端 head、compat 完整 tree、35 个 baseline 文件，以及上一轮 FINAL／ATTRIBUTION／driver 三份 Git 对象。

## 5. 应用固定 XI 实现

```bash
node "$PKG/tools/apply.cjs"   --compat "$COMPAT" --out "$WORK/source-application.json"
```

必须得到：

```text
HOTPATH_XI_SOURCE_APPLIED
```

工具会：

1. 从包内 `source/implementation` 写入固定 17 路径；
2. 校验暂存路径和每个 staged blob；
3. 执行原生 whitespace 检查；
4. 创建唯一源码提交；
5. 重新核验父提交、提交信息、变更范围和 42 个锁定文件。

未知本地提交、额外 dirty path、已有 staged 变化、远端漂移或任一字节不一致都会停止。若唯一固定源码提交已经精确存在，只允许只读续接，不创建第二个提交。

## 6. 完整离线仓库门禁

```bash
node "$PKG/tools/build.cjs"   --compat "$COMPAT" --out "$WORK/offline-checks"
```

必须满足：

```text
HOTPATH_XI_OFFLINE_VERIFIED
真实仓库七份 Node specs    280/280
loader --check              通过并核对全部 manifest outputs
两套 tsc --noEmit           通过
Jest                        195 suites / 685 tests
Rollup build-only           通过
```

这些测试层级有包含关系，不相加。Warm build 只证明构建链，不能用于上传；正式候选必须从临时 ON 提交的干净 detached worktree 重新构建。

## 7. 上线前事实确认

继续前必须真实确认：

- 无其他 Agent、人、CI、IDE watcher 或自动部署会写 `default`；
- 上轮 collector/guard/recovery 均已退出；
- refactor 仍在固定基线；compat 正好位于唯一 XI source commit；两仓工作树和索引干净；
- 两条远端仍在第 1 节起始 head；
- 机器可持续运行至窗口结束、恢复和 75 秒确认完成。

无法确认时止于离线阶段。命令行开关是事实声明，不是形式开关。

## 8. 唯一在线执行入口

```bash
node "$PKG/tools/observe.cjs"   --refactor "$REFACTOR" --compat "$COMPAT"   --offline "$WORK/offline-checks" --tests "$WORK/tool-tests"   --work "$WORK/live" --secret "$SECRET"   --execute --exclusive-target --prior-workers-stopped
```

只能执行一次。窗口在全部慢速检查后绑定：

```text
S = ceil((freshTick + 150) / 100) × 100
points = S, S+100, S+200, S+300
```

固定边界：四点、100 tick 间隔、两房、`energy/H`、`maxSampleCpu=2`、`reserveCpu=5`、bucket≥2000、日志≤16384 bytes、外部已报告成本中止线 5 CPU、恢复运行确认 75 秒。

5 CPU 是事后安全线，不是采样预算。不得增加第五点或第二窗口。

## 9. 在线数据与比较口径

继续使用 IX 九个有界子阶段：

```text
observationSetup / observationRooms / observationFinalize / observationView
commitmentSetup / commitmentTasks / commitmentReservations / commitmentFinalize
projectionRows
```

归档会从本轮原始 console 重算当前归因，并与 Retry I 固定原件比较：

- 完整样本数与 partial CPU 数；
- 九个子阶段中位数；
- parent phase 中位数；
- 每个指标的 prior/current/delta 和当前调用数。

不计算因果提速百分比。子阶段与 parent phase 重叠，不可相加；primitive counters 不是 CPU 权重。`index complete=true` 且空 rows 仍不算完整样本。

## 10. 在线命令后的固定收尾

无论 observe 退出码如何，都不得再次运行 observe。

```bash
node "$PKG/tools/reconcile.cjs"   --compat "$COMPAT" --run "$WORK/live/run" --secret "$SECRET"   --out "$WORK/reconcile.json"
```

若候选未写入，不恢复；若已确认旧生产，不恢复；仅当仍是本轮候选、恢复从未尝试且旧 worker 均退出时，允许唯一受限恢复：

```bash
node "$PKG/tools/recover.cjs"   --compat "$COMPAT" --run "$WORK/live/run" --secret "$SECRET"   --execute-recovery --exclusive-target --prior-workers-stopped
```

存在 `restore-attempt.json` 时绝不重发恢复 POST。第三方代码不得覆盖。

随后：

```bash
node "$PKG/tools/verify.cjs"   --run "$WORK/live/run" --out "$WORK/final-verification.json"

node "$PKG/tools/compare.cjs"   --run "$WORK/live/run" --out "$WORK/hotpath-comparison.json"
```

证据不足时允许非零退出；仍要保留输出并进入归档，不得改写为成功。

## 11. 归档、提交和推送

```bash
node "$PKG/tools/archive.cjs"   --refactor "$REFACTOR" --compat "$COMPAT"   --run "$WORK/live/run" --tests "$WORK/tool-tests"   --offline "$WORK/offline-checks"   --application "$WORK/source-application.json"   --secret "$SECRET"

node "$PKG/tools/publish.cjs"   --refactor "$REFACTOR" --compat "$COMPAT" --check-only

node "$PKG/tools/publish.cjs"   --refactor "$REFACTOR" --compat "$COMPAT"   --out "$WORK/publish-result.json" --push
```

成功时 compat 链必须严格为：

```text
9adb2739 fixed default OFF root
→ one fixed XI source commit
→ temporary four-point ON
→ exact default OFF
```

最终 OFF tree 必须等于 XI source tree。Refactor 只允许新增一个证据提交，全部路径位于：

```text
openspec/changes/empire-treasury-core-rewrite/evidence/
legacy-read-bridge-i/compat-hotpath-optimization-xi-online-i/
```

完整 `git diff --cached --check` 必须 exit 0、零例外。只允许普通 fast-forward 推送。

## 12. 允许的终态

全部采集、比较、恢复和推送完成后：

```text
HOTPATH_XI_OFFLINE_VERIFIED
CPU_DIAGNOSTIC_CAPTURE_VERIFIED
HOTPATH_XI_ATTRIBUTION_RECORDED
HOTPATH_XI_COMPARISON_RECORDED
RESTORED_BYTES_AND_RUNTIME_VERIFIED
```

除非真实数据另有充分证明，继续保留：

```text
ENGINE_CPU_BUDGET_GAP_UNRESOLVED
```

即使多个四点样本完整，也不等于十二点正式兼容观察通过，更不授权完整 Treasury 生产切换。
