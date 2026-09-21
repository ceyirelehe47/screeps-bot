# Agent 任务书：Task Hotpath XIV · Online I Retry I

## 0. 本轮目标、授权与基线

本包只修实验执行链的时间准入，复用已验收的 XIV 源码。没有 source.patch，没有 materialize，不创建新 source commit。Agent 按本包独立核验、执行和推送，不现场修改包或测试。

固定仓库为 ceyirelehe47/screeps-bot：

- compat/treasury-read-bridge-i：0b354262fb5f3686166e3af0189d88a1690f0c6b。
- 当前及最终默认 OFF tree：0391f4b73522f02829f5151b455a5e5b45d0ab9c。
- 原 XIV 实现提交：90fd49221d1dbf12365d60edea25d8f153d2a1cb，仅作为 provenance；本轮从已推送的最终 OFF HEAD 开始。
- refactor/empire-treasury-rearchitecture：43ee4bf495b86002fccccc22d682e2527498ef82。
- 前轮恢复证据路径及 blob 由 policy.json 固定，必须核验状态 RESTORED_BYTES_AND_RUNTIME_VERIFIED。

本任务书随包交付的新执行授权仅限 policy.json 中一个 authorizationId/runId。新实验最多 candidate POST 1 次、restore POST 1 次；不重置原 XIV 账本，不复用其他恢复授权。**明确允许本轮上传后的固定观测上限为75分钟，而不是原轮30分钟；不允许动态加时。**这不改变2 CPU预算、5 CPU诊断安全阈值、4点、100 tick间隔或任何业务校验。

超过观测期限表示进入恢复流程，不表示服务器在同一瞬间已经完成回滚。恢复读回有独立有界期限，POST失败不重发，恢复不确定仍报告 ONLINE_CLOSE_UNCONFIRMED。

## 1. 环境与全新目录

使用 Node.js 22、真实仓库已有锁定依赖，TypeScript 5.9.3。不得升级依赖或修改 lock。以下命令为 Git Bash；PKG 指向解压后含 policy.json 的目录。

```bash
PKG="D:/code/screeps/incoming/screeps-compat-task-hotpath-XIV-online-I-retry-I-2026-09-22"
COMPAT="D:/code/screeps/screeps-bot-compat-read-i"
REFACTOR="D:/code/screeps/screeps-bot"
WORK="D:/code/screeps/compat-task-hotpath-XIV-online-I-retry-I-execution"
SECRET="$COMPAT/.secret.json"

test ! -e "$WORK" || exit 1
mkdir "$WORK"
unset NODE_OPTIONS NODE_PATH DEST DEPLOY_ALLOW_DIRTY NODE_TLS_REJECT_UNAUTHORIZED
node --version
node "$PKG/tools/verify-package.cjs"
```

凭据沿用本机已验证配置。若实际位于另一已知路径，只修改 SECRET 变量；不打印、复制或上传 token。两个工作树必须干净且在上述分支，远端必须仍在固定起点。旧 worker、collector 和其他部署程序必须退出；实验期间独占目标代码写入权。不得 reset、amend、rebase、merge 或 force-push。

## 2. 包测试与只读源码复用

```bash
node "$PKG/tools/run-tests.cjs" --out "$WORK/tool-tests"
node "$PKG/tools/apply.cjs" --compat "$COMPAT" --refactor "$REFACTOR" \
  --out "$WORK/source-application.json"
```

包工具测试108/108，数量同时由 references/test-contract.json 固定，零 failed/skipped/todo/cancelled。apply 只是保留的兼容命令名：它核验全树和原17条实现路径字节，不应用任何补丁、不暂存、不提交。

必须输出 TASK_XIV_RETRY_SOURCE_REUSED_VERIFIED、resumed=true、sourceModified=false，head仍为0b354262。其他本地提交即使tree相同也拒绝，不自行迁移。

## 3. 完整离线门禁

```bash
node "$PKG/tools/build.cjs" --compat "$COMPAT" --out "$WORK/offline-checks"
```

要求 TASK_XIV_RETRY_OFFLINE_VERIFIED：TypeScript精确5.9.3；378项Node回归；generator --check/--write/--check及13项manifest身份；双项目tsc；四种合成输入的完整API等价回放和Memory零写入；Jest195 suites/685 tests；干净detached worktree Rollup build-only。生成器重写后工作树必须仍然干净。

本地回放不是真实引擎CPU或历史故障的精确复现。所有门禁均必须实跑，不能以原轮结果或制作端5.8.3结果替代。

确定性失败保存日志并停止，不改代码、门禁或计数，不进入observe。

## 4. 唯一在线入口

确认所有事实前提后只调用一次：

```bash
node "$PKG/tools/observe.cjs" --compat "$COMPAT" --refactor "$REFACTOR" \
  --work "$WORK/live" --offline "$WORK/offline-checks" --tests "$WORK/tool-tests" \
  --secret "$SECRET" --execute --exclusive-target --prior-workers-stopped \
  > "$WORK/observe.stdout" 2> "$WORK/observe.stderr"
OBSERVE_EXIT=$?
printf '%s\n' "$OBSERVE_EXIT" > "$WORK/observe.exit"
```

### 4.1 只读就绪与速度测量

observe先在Git common-dir中落盘唯一启动授权；换WORK不会产生第二次额度。最长30分钟只读就绪等待，连续三次核对账号、唯一activeWorld、两房归属和精确旧生产字节。稳定第三方代码立即停止，不接受任意live基线。

然后执行最长5分钟的game-time速度测量。至少7次成功GET、跨度至少120秒、累计推进至少20 tick；每次请求受剩余外层期限约束，常规采样间隔20秒。失败请求也记录，瞬态只读失败允许在剩余期限内继续；认证错误、无效响应、tick倒退和时钟跳变直接停止。长期不推进或证据不足为 TICK_RATE_MEASUREMENT_INCONCLUSIVE，零POST。

成功和失败的所有game-time读取写入 time-observations.jsonl，包括就绪、测量、绑定前、构建后、上传前以及worker进度。记录请求/响应时间、单调时钟、独立clockId、PID和返回tick。不同进程的performance.now不相减。

### 4.2 绑定前时间准入

从正向tick区间估算最慢的毫秒/tick，计入前一请求开始到后一响应结束的网络不确定性；重复tick的等待不会被丢掉。保守速率取 max(5000ms/tick, ceil(最慢观察速率×1.5))。

取新鲜tick，按原协议currentTick+150向上对齐100，得到4点和100tick间隔。所需时长=到第四点的全部剩余tick×保守速率+240000ms日志接收余量。

只有所需时长≤4500000ms才允许绑定唯一ON提交。拒绝结果保存为 TIME_BUDGET_INSUFFICIENT；禁止临时增大wallMs、缩短间隔、重绑窗口或反复挑选有利时机。本次估算不保证未来速度，不是无限等待许可。

### 4.3 构建后和上传前复核

ON候选构建结束后再次读取tick；至少仍有100 tick lead。保存精确private backup/candidate和session。启动collector与独立recovery worker，确认通道和进程可用。

在动作锁内、candidate marker之前，再核验旧生产、房间和最新tick，重算全部剩余时长。测量数据最多10分钟有效；若构建/启动期间变慢，使用新的较慢速率；若时间不足、tick停滞、窗口过期则不上传并关闭ON源码配置。上传前最后一次time读取到marker不能超过5秒；系统时钟不连续时拒绝。

candidate marker包含固定4500000ms上限、绝对close deadline及时间准入文件SHA。marker先落盘，候选POST最多一次。重启worker、换输出目录或复制测量JSON不能刷新期限/写配额。

### 4.4 采集与关闭

collector仍只接受原4个due tick，桥源码完全不变。worker每约15秒记录成功或失败的game-time GET；到第四点、超过窗口、桥安全闩、通道故障、父进程退出或期限到达都触发关闭。worker同时使用自身单调经过时间与固定绝对deadline；时钟跳变也触发关闭，不加时。worker的game-time请求和轮询等待均压缩到剩余观测期限内。

桥的heap-local >5 CPU安全闩保持，不能抢占当前同步调用。2 CPU准入不足而not_called不是0成本构建，不提升预算来强行拿到调用。若仍无实际commitment调用，任务归因结论仍未知。

### 4.5 恢复

恢复链只接受精确本候选或精确备份。共享动作锁、restore marker先行，restore POST最多一次；失败/断连/丢回包只读对账。当前已经是备份则不写。第三方代码不覆盖。

稳定读到旧生产后，启动全新独立75秒WebSocket运行确认，之后再次读取完整旧生产字节。只有这条链闭合才可报告 RESTORED_BYTES_AND_RUNTIME_VERIFIED。Git默认OFF与线上恢复分开判定。

## 5. 最终验证、归档与发布

observe退出非0不允许重跑。先确认worker和collector已结束；若worker仍活着，不启动其他写入方。

```bash
node "$PKG/tools/verify.cjs" --compat "$COMPAT" --run "$WORK/live/run" \
  --out "$WORK/FINAL-VERIFICATION.json"
```

独立验证器从原始time-observations重新计算测量和两次时间准入，核对session/marker指纹与固定deadline；同时复算原始console、业务完整性、尾部、写边界、恢复运行日志和精确OFF树。不能只信成功标签。

若有session但恢复不确定，最多执行任务书支持的只读reconcile，不产生任何POST：

```bash
node "$PKG/tools/reconcile.cjs" --run "$WORK/live/run" --secret "$SECRET" \
  --out "$WORK/RECONCILIATION.json"
```

未上传且没有session时不执行reconcile。若线上恢复不确定，停止新性能工作并报告；不复用旧恢复包、删除marker或自增恢复配额。

相关进程退出、Git默认OFF且工作树干净后，成功、INCONCLUSIVE或时间准入拒绝均按真实结果归档：

```bash
node "$PKG/tools/archive.cjs" --compat "$COMPAT" --refactor "$REFACTOR" \
  --work "$WORK" --secret "$SECRET" --push \
  > "$WORK/archive.stdout" 2> "$WORK/archive.stderr"
```

归档包括本包、离线日志、原始time/console/动作账本、TASK-ANALYSIS、TIME-BUDGET-ANALYSIS及完整hash清单。private backup/candidate、凭据、detached build不入公开证据。原始本地快照和账本保留。

compat只允许两种终态：仍为0b354262（绑定前拒绝），或者0b354262→唯一ON→精确OFF两提交；无新source提交。最终tree必须等于0391f4b。refactor只增加一个policy固定的evidence提交，不改src/scripts/test/依赖/构建配置。native whitespace零例外；普通fast-forward推送。

若archive提交已完成但Git网络瞬态失败，可幂等重跑同一archive --push核验既有字节后继续推送。不得重跑observe、创建第二窗口或以重归档覆盖旧结果。提交前的确定性失败或脏树应保存证据并停止。

## 6. 报告要求

分开报告源码复用、离线门禁、时间准入、采集、业务完整性、恢复和发布。给出完整HEAD和tree、包指纹、两次估算、观測起始/截止、最后观测tick、停止原因、raw/accepted/complete、task真实调用及null计时、POST计数、恢复字节与75秒结果。

允许 TIME_BUDGET_INSUFFICIENT/TICK_RATE_MEASUREMENT_INCONCLUSIVE + NOT_DEPLOYED，或 CPU_DIAGNOSTIC_CAPTURE_INCONCLUSIVE。即使四条诊断有效也不等于四个完整业务样本，更不等于12点通过。继续保留 ENGINE_CPU_BUDGET_GAP_UNRESOLVED，不宣布FULL_COMPATIBILITY_OBSERVED或Treasury生产就绪。

## 7. 制作端边界

见 MAKER-VALIDATION.json及独立交付验证。已测试的loopback HTTP、虚拟时钟、临时Git仓库、真实认证源码树不等于真实Screeps在线运行。制作端没有使用用户token或执行线上GET/POST，也没有Windows实机、锁定5.9.3双tsc/Jest/Rollup结果。§3由Agent完整执行。
