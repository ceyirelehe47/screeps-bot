# Agent 任务书：Read Envelope XV · Online I Retry I

## 0. 本轮目标与授权

本轮复用已经提交并通过完整离线门禁的 XV 源码，只增加绑定前的有界只读择时；不创建新的 source commit，不改性能实现，不改诊断报文。任务包自包含，没有 materialize，没有源码 patch，没有要求 Agent 现场设计或补实现。

上轮 NOT_DEPLOYED 是真实结果：TIME_BUDGET_INSUFFICIENT，零 candidate/restore POST。旧包、旧 run、旧启动凭据、旧 marker 和失败证据原样保留；不要再次执行旧 observe。

本任务书转交执行，仅授权 policy.json 中的新一次实验。准备阶段可以在明确上限内重新测量及考察尚未绑定的方案；绝不是多个已部署窗口。第一次满足条件并重新核验身份的方案即被选中；最多绑定一个 ON，candidate POST ≤1、restore POST ≤1，写入不自动重试。只读择时失败或者观测未完成，也要如实归档。

固定仓库：ceyirelehe47/screeps-bot。

| 项目 | 固定身份 |
|---|---|
| compat 分支 | compat/treasury-read-bridge-i |
| compat 起点／复用实现 | 01205865d975878d04c9993a0c97a6ccab952be5 |
| compat 默认 OFF 完整 tree | cf3169d5e14892249488b333837b7e840b565cce |
| XV 原始父提交，仅用于来源核验 | eba6a0df574c9cb6101bd3d7e5ebae729d3dd976 |
| refactor 分支 | refactor/empire-treasury-rearchitecture |
| refactor 起点 | b7d63b4ae0f4af89f635e48d3451f1fe6e21aeba |

工具验证复用提交的完整父列表、提交信息、tree、原始 16 路径差集和逐项 after 字节。路径集合直接来自包内已固定 source-manifest.json，不另造一份手写范围清单。该清单记录原 XV 的 before/after 来源，并不授权本轮应用补丁。

业务约束不变：shard1，E3N59/E4N58，energy/H，maxSampleCpu=2，reserveCpu=5，minBucket=2000，4 点、100 tick 间隔，maxLogBytes=16384。独立 direct/Core 真实 Store 读取、完整索引、全部损坏输入及安全整数检查、4 行/16 查询、既有探针、安全闩全部保留。诊断 wire revision 仍为 XIV，源码实现仍为 XV，不自行改标签。

## 1. 环境与目录

Node.js 22，仓库原有锁定依赖，TypeScript 5.9.3。不得修改 package-lock、升级编译器或改测试计数。命令为 Git Bash；PKG 是解压后含 policy.json 的目录。

```bash
PKG="D:/code/screeps/incoming/screeps-compat-read-envelope-XV-online-I-retry-I-2026-09-23"
COMPAT="D:/code/screeps/screeps-bot-compat-read-i"
REFACTOR="D:/code/screeps/screeps-bot"
WORK="D:/code/screeps/compat-read-envelope-XV-online-I-retry-I-execution"
SECRET="$COMPAT/.secret.json"

test ! -e "$WORK" || exit 1
mkdir "$WORK"
unset NODE_OPTIONS NODE_PATH DEST DEPLOY_ALLOW_DIRTY NODE_TLS_REJECT_UNAUTHORIZED
node --version
node "$PKG/tools/verify-package.cjs"
```

凭据沿用已知本地路径，实际位于另一个已验证位置时只调整 SECRET。禁止打印或归档 token。PKG/WORK 必须在两个仓库之外。旧 collector、worker、其他部署程序必须退出，实验期间独占目标写入权。不得 reset/amend/rebase/merge/force-push。

## 2. 包测试与只读源码复用

```bash
node "$PKG/tools/run-tests.cjs" --out "$WORK/tool-tests"
node "$PKG/tools/apply.cjs" --compat "$COMPAT" --refactor "$REFACTOR" \
  --out "$WORK/source-reuse.json"
```

要求 READ_XV_RETRY_PACKAGE_TESTS_VERIFIED，165/165，零 failed/skipped/todo/cancelled。

apply 只是沿用入口名称，本轮不写源码、不提交：READ_XV_RETRY_SOURCE_REUSED_VERIFIED、resumed=true、sourceModified=false。HEAD 必须仍为 01205865…；tree 必须仍为 cf3169d5…。

基线检查还必须验证：远端与固定起点相同，工作树/索引干净；上轮 XV 最终记录是精确锁定的 NOT_DEPLOYED/零写入；最近一次真正的恢复记录是 XIV Retry I 的 RESTORED_BYTES_AND_RUNTIME_VERIFIED。不得把 XV 没有发生的恢复写成本轮前置恢复；上线前仍会重新读线上精确字节。

## 3. 完整离线门禁

```bash
node "$PKG/tools/build.cjs" --compat "$COMPAT" --out "$WORK/offline-checks"
```

必须得到 READ_XV_RETRY_OFFLINE_VERIFIED：TypeScript 精确 5.9.3、424 项 Node、generator --check/--write/--check 与所有 manifest 输出身份、两套 tsc、4 种合成输入的完整 API 等价本地回放、Memory 零写入、Jest 195 suites/685 tests、干净 detached worktree Rollup build-only。

源码复用不意味着门禁可跳过。生成器重写后仍必须保持工作树干净。制作端的 5.8.3 结果不能代替本节。确定性失败记录日志并停止，不现场修绿。

## 4. 唯一 observe 入口

确认事实前提成立后，仅调用一次。不要把退出码 2 当作允许重跑的理由。

```bash
node "$PKG/tools/observe.cjs" --compat "$COMPAT" --refactor "$REFACTOR" \
  --work "$WORK/live" --offline "$WORK/offline-checks" --tests "$WORK/tool-tests" \
  --secret "$SECRET" --execute --exclusive-target --prior-workers-stopped \
  > "$WORK/observe.stdout" 2> "$WORK/observe.stderr"
OBSERVE_EXIT=$?
printf '%s\n' "$OBSERVE_EXIT" > "$WORK/observe.exit"
```

启动授权固定写入 Git common-dir 的 treasury-experiments，整个 observe 只有一次；换输出目录或复制 run 不会刷新授权。启动时仍先执行原有最长 30 分钟只读就绪：连续三次验证账号、唯一 activeWorld、两房归属、精确旧生产 main 4,494,463 字节与 37d20706…，第三方代码拒绝。

### 4.1 有界只读择时：尚未创建任何 ON

就绪通过后开始一个独立、不可刷新的择时阶段，总上限 30 分钟，最多 6 个 calibration round，先到哪个上限便结束。该时长不是每轮重新获得 30 分钟。

每轮仍要求至少 7 次成功 game-time GET、至少 120 秒跨度、至少 20 tick 推进；单轮校准最长 5 分钟，同时被剩余总期限裁剪。每次读取通常间隔 20 秒。保守速率算法不降低：max(5000 ms/tick, ceil(最慢区间毫秒/tick ×1.5))，最慢区间计入请求时间不确定性和停滞期间。

校准成功后在最长 4 分钟的探测期内读取新 tick，通常每 20 秒探测一次，每轮最多 16 次初始探测；所有请求和等待同时受单轮及总期限约束。

拟定窗口的规则仍是 currentTick+150 向上对齐 100，末点为首点+300。不改 lead 规则、不缩短 100 tick 间隔、不提高 75 分钟上限。随当前 tick 推进重新计算的只是未绑定方案，不是第二个在线窗口。

新准入增加一项更严格条件：包含 240 秒接收余量之后，必须另外剩余至少 180 秒余量。绑定前与上传前都要求：

```
到末点的剩余 tick × 保守毫秒/tick + 240000 + 180000 <= 4500000
```

所需时间超过上限，记录 TIME_BUDGET_INSUFFICIENT；勉强装得下但少于额外余量，记录 TIME_BUDGET_MARGIN_INSUFFICIENT。这些未绑定方案在当前只读阶段可继续观察；证据过期、进度停滞或本轮探测结束时进入下一轮全新测量，不把多轮读数拼成虚假样本，不覆盖旧失败记录。

每个拟通过方案还要重新执行账号、activeWorld 前后夹读、精确旧生产模块及房间归属检查，然后再读一个新 tick，重新计算方案和时间余量。重新核验期间如果跨过对齐边界、速度下降或余量不足，该方案仍拒绝，继续在剩余只读额度内等待；没有 ON，也没有 POST。

第一次完成上述复核且满足条件的方案即选中。它的原始校准读取及最终方案提升到本 run 的正式 timing 文件；其他轮次的原始记录完整保留在 window-selection/round-NN 下。全部轮次的结果、身份摘要、失败、拒绝决策和时间均纳入 hash 清单，并由独立验证器重算。

认证、模块漂移、房间归属变化、tick 回退、时钟不连续等语义错误立即终止，不作为网络瞬态重试。可识别的只读网络瞬态只能在原来的剩余额度内重试。长期过慢/停滞最终为 WINDOW_SELECTION_EXHAUSTED + NOT_DEPLOYED，candidate/restore 均 0。

### 4.2 唯一绑定、构建和上传前复核

选中前不创建 ON。选中后由包内工具验证完整择时证据，再创建唯一配置 ON 提交。随后执行原来的 detached build、字节快照、session、collector 与 worker 启动。

上传前仍在共享动作锁内重新核对旧生产、房间、最新 tick 和剩余时间；证据最多 10 分钟有效，变慢只采用更保守速率，保留至少 100 tick 的上传余量。最后 time 读取到 candidate marker 不超过 5 秒。额外 3 分钟余量也必须满足。

选中并绑定后即不再回到择时循环。构建或上传前复核失败，零 candidate POST 并精确关闭临时 ON，随后归档；不改窗口、不重建另一个候选、不清理 marker 重试。

marker 先落盘，再发送唯一 candidate POST。marker 绑定 session、择时结果指纹、时间计划和固定 4500000 ms 截止；worker 的单调时钟与固定绝对截止共同约束观测，不动态延长。

### 4.3 采集、关闭与恢复

只接受唯一 4 个预定 tick，不补第五点。四条收齐、安全闩、通道/父进程故障、窗口经过或墙钟截止均进入关闭。原 heap-local >5 CPU 安全闩保留，但不能抢占当前同步调用。not_called 必须保持未调用，不能写成零成本。2 CPU 完整业务目标不降低。

恢复始终只接受本候选或精确备份；第三方代码不覆盖。共享动作锁、restore marker 先落盘、restore POST 最多一次。断连、超时或丢回包之后只读对账，不自动重发。候选与恢复使用本轮新授权，不复用以前已经消耗的恢复包。

稳定读回旧生产后，以新 closureId 启动独立 75 秒运行观察，并在之后再读一次完整模块身份。只有这条链闭合才报告 RESTORED_BYTES_AND_RUNTIME_VERIFIED。Git OFF 不能代替线上恢复证明。

## 5. 独立验证、归档、普通推送

observe 退出后不重跑。先确认 worker 和 collector 已退出；若仍有进程工作，不启动新的写入方。

```bash
node "$PKG/tools/verify.cjs" --compat "$COMPAT" --run "$WORK/live/run" \
  --out "$WORK/FINAL-VERIFICATION.json"
```

验证器重算择时中每轮原始测量与全部决策，确认选中方案、重新核验的身份摘要、root 提升字节、session 指纹和上传截止；再按原标准核对采样、前缀/已测尾部、写入账本、恢复及源码 OFF。

无候选时终态为 NOT_DEPLOYED；WINDOW_SELECTION_EXHAUSTED 不代表性能失败。若 session 已建立但恢复不确定，只可按原包的只读入口追加对账：

```bash
node "$PKG/tools/reconcile.cjs" --run "$WORK/live/run" --secret "$SECRET" \
  --out "$WORK/RECONCILIATION.json"
```

没有 session 时不执行 reconcile。不能增加恢复配额；恢复不确定时停止新的性能工作并报告。

进程结束、源码默认 OFF 且工作树干净后，成功、INCONCLUSIVE 或零上传终态都应如实归档：

```bash
node "$PKG/tools/archive.cjs" --compat "$COMPAT" --refactor "$REFACTOR" \
  --work "$WORK" --secret "$SECRET" --push \
  > "$WORK/archive.stdout" 2> "$WORK/archive.stderr"
```

归档包含整包、全部只读轮次、正式原始时钟/console/动作记录、离线测试日志、FINAL-VERIFICATION、WINDOW-SELECTION-ANALYSIS、TIME-BUDGET-ANALYSIS、TASK-ANALYSIS、OVERHEAD-ANALYSIS 及完整校验清单。private backup/candidate、凭据和 detached build 不进入公开 evidence；原本地快照不得删除。

只读择时拒绝时 compat HEAD 不变；发生过唯一绑定时最终只允许 01205865…→ON→OFF，两项配置提交且最终 tree 仍为 cf3169d5…。不存在新的 source commit。refactor 只增加本轮固定路径下一个证据提交，不能改 src/scripts/test/依赖/构建配置。native whitespace 零例外，普通 fast-forward 推送。

若 evidence 已提交而 Git 网络瞬态阻断发布，可幂等重跑同一 archive --push 核验既有字节后推送；这不授权重跑 observe 或创建第二窗口。确定性失败/脏树保存证据并停止，不现场改包或测试。

## 6. 报告与结论边界

报告完整 HEAD/tree 和包指纹；源码复用是否零修改；离线门禁；择时轮数、全部拒绝数量、所耗时长、选中理由和额外余量；绑定/上传估算；raw/accepted/complete；builder 实际调用及未调用；前缀和已观测尾部；POST 次数；恢复字节与 75 秒结果；归档提交和远端回读。

未部署时不能把读取不到的 CPU 记作 0，不把最近的历史恢复写成本轮的新恢复。四条诊断有效不等于四个完整业务样本；末点无后继尾部仍为 null；不把 Node 毫秒或旧失败时间估计当引擎性能。

继续保留 ENGINE_CPU_BUDGET_GAP_UNRESOLVED。不宣布 12 点正式观察通过、FULL_COMPATIBILITY_OBSERVED 或 Treasury 生产就绪。

## 7. 制作端边界

详见 MAKER-VALIDATION.json 和独立 delivery-validation。实际 Git commit/tree 认证、工具回归、虚拟时钟择时及 loopback 传输不等于 Screeps 实机。制作端未使用用户 token、未进行真实 Screeps GET/POST、未做 Windows 实机测试。制作端 TypeScript 为 5.8.3，真实锁定 5.9.3 双 tsc/Jest/Rollup 必须由 §3 执行。
