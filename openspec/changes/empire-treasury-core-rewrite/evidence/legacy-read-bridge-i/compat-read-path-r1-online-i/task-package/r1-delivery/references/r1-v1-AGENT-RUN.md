# Agent 任务书：Treasury Read Path R1

## 目标与分工

执行本包中的固定实现，完成离线门禁、一次有界四点试验、恢复及 GitHub 交付。不要重新设计实现，不要现场补代码，不要改测试修绿，不要因为某次失败重跑上传。用户要求减少小步骤交接，你应自主跑完已授权闭环，仅在确定性包缺陷、真实门禁失败、身份漂移或未闭合恢复时停止并交付证据。

新实现不会被直接当成生产 Treasury。仍是旧生产上的只读兼容桥，禁止交易、发送资源、迁移 Memory、替换 writer 或启动完整 Treasury 生命周期。

## 一、入口

环境为 Node.js 22、仓库锁定依赖、TypeScript 精确 5.9.3。不要升级锁文件或工具链。先确认本地依赖存在、两仓库工作树/索引干净，两个远端分支确实位于本包固定起点。若有用户工作、别的 Agent 提交或第三方代码漂移，不覆盖、不 reset、不自动 rebase。

Git Bash 示例路径沿用项目现有约定。PKG 指向解压后包含本任务书和 PACKAGE.json 的目录。WORK 必须尚不存在；不要提前 mkdir WORK。`WORK.package-self-tests` 与 `WORK.bootstrap-logs` 同样必须为新路径。

```bash
PKG="D:/code/screeps/incoming/screeps-treasury-read-path-R1-2026-09-23"
COMPAT="D:/code/screeps/screeps-bot-compat-read-i"
REFACTOR="D:/code/screeps/screeps-bot"
WORK="D:/code/screeps/treasury-read-path-R1-online-I-execution"
SECRET="$COMPAT/.secret.json"

unset NODE_OPTIONS NODE_PATH DEST DEPLOY_ALLOW_DIRTY NODE_TLS_REJECT_UNAUTHORIZED
node --version
node "$PKG/tools/verify-package.cjs"

# 只有确认目标写入已独占、此前 collector/worker/部署进程均退出后，才传以下两个事实标记。
node "$PKG/tools/run.cjs" \
  --compat "$COMPAT" --refactor "$REFACTOR" --work "$WORK" \
  --secret "$SECRET" --execute --exclusive-target --prior-workers-stopped
```

SECRET 仅是既有凭据文件路径；不要打印 token，也不要把凭据文件复制进 PKG/WORK/仓库。路径不同可以修正路径参数，不能改变目标账号、server、shard、部署分支或代码身份。

单独的 `--offline-only` 模式只用于明确不执行实机的场景，不能与 `--execute` 同时使用。它会在全部离线门禁通过后发布默认 OFF 源码，但不会创建线上实验；不能把它的结果当作本任务完整实机交付。默认执行上述完整命令。

## 二、自动执行的阶段

### 1. 自测、来源与源码

入口先运行本包 102 项测试及 CJS 语法检查，再核对两个固定分支、TS 版本及最新 XV 四点/恢复原始记录。默认 OFF 起点必须是 `477a20c9...`，不是交接中的较早 `01205865...`。

从 `0e2b71ad...` 的固定归档目录提取原执行器，INTEGRITY SHA-256 必须为：

`82f7dbfec7c20fa81001daa54a61553d23b5dd05e97176ade0fece2d9985a712`

必须覆盖全部 66 个 payload 文件及原 INTEGRITY，不得选择性摘取或调用旧执行目录。旧目录、旧 run、旧 marker 不修改、不删除。

原 generator 先 `--check`。固定接入补丁只接受已钉住的三个原始 Git blob；添加 R1 变换和测试后，由原 generator 的扩展链 `--write`，不直接手改 generated Core。生成结果必须逐字节匹配本包的固定 R1 Core，逆变换必须精确回到原 XV Core。

本轮源码变化白名单为 9 个文件，见 PACKAGE.json。两个历史测试文件仅更新逆变换所在版本层及查询缓存的计数插桩入口；原断言和业务对拍保留，没有删除或跳过旧测试。其他业务代码、preview、CPU 探针、配置、main、依赖锁均不改。

准备器创建一个本地默认 OFF 源码提交。此时还没有发布它，也没有任何 Screeps 写入。

### 2. 完整离线门禁与默认 OFF 发布

在绑定 R1 身份后的原执行器中运行完整 165 项工具测试。再运行真实仓库全部 467 项 Node（原 424 + 新增 43，零 fail/skipped/todo/cancelled）、generator check/write/check、两套 tsc、既有完整 API 合成回放、Jest 195 suites / 685 tests、干净 detached worktree 的 Rollup build-only。

制作端的 102 项测试不是这些门禁的替代品。任一失败：保存原始日志，STOP；不改测试数量，不调整白名单，不现场修包，不上线。准备阶段失败可能留下本地未发布的源码提交或未完成修改，保留它们供审查，不擅自清理。

全部通过才普通 fast-forward push 默认 OFF 源码，读取远端确认一致。然后原执行器按新 source head/tree 做只读复核。默认 OFF 源码发布不等于上线。

### 3. 唯一四点实机试验

本包授权 ID 为 `treasury-read-path-R1-online-I-2026-09-23`；原执行器把一次性启动授权写入 Git common-dir。换目录、复制包、删除日志均不得刷新额度。不要再调用旧 XV 包的 observe。

执行器逻辑、传输、采集、窗口选择和恢复代码原样复用；新包只绑定新的源码、授权 ID、证据路径和测试数量。开始前仍重新核验真实线上字节与目标账号，历史恢复记录不等于此刻线上状态。

固定线上边界：server `https://screeps.com`、账号 `forster`、shard1、部署分支 default；E3N59/E4N58、energy/H；maxSampleCpu=2、reserveCpu=5、minBucket=2000、intervalTicks=100、maxLogBytes=16384。四个预定 tick，不补第五点，不自动创建第二个窗口。

继承原时间准入：就绪最多 30 分钟；绑定前择时共享最多 30 分钟/6 轮；每轮测量至少 7 次成功 GET、120 秒跨度和 20 tick 推进。保守速率、100 tick 对齐和 lead 不变；到第四点保守时长 +240 秒接收余量 +180 秒额外余量必须装进固定 75 分钟暴露上限。绑定后不得回到择时循环或延长窗口。

candidate POST ≤1、restore POST ≤1；共享锁和持久 marker 必须先于写请求。任何 transport error 都不能触发 POST 自动重发，只允许只读对账；第三方代码不覆盖。heap-local >5 CPU 的安全闩保留，不声称可抢占当前同步调用。

收到四条、时间到或保护条件触发，均进入关闭与恢复。不要把退出码 2 当作重新执行的许可。run.cjs 本身不写 setCode，不接管原 worker 的恢复权。

### 4. 独立验证、结论与归档

原独立验证器检查原始数据、写入账本、进程终止、default OFF tree、精确旧生产恢复及独立 75 秒运行确认。恢复后还需要最终独立字节读取。Git OFF 不等于线上恢复。

旧生产精确身份：main 4,494,463 bytes；SHA-256 `37d20706908220a157fc30fbf668ed98c880fdb47a34ed34b6a0302e3f11f74b`；commit `06ffedb7c558e0bc625f4a2ff450c474fb9d6f1c`；tree `929fa9557b1a36135a5ef1605231be1d16e87366`。

若恢复未闭合，入口最多调用原来的只读 reconcile，不增加恢复 POST、不另开观察实验，也不把补充读回伪装成原始独立运行确认。若原 worker/collector 或动作锁仍在，停止后续流程，不启动第二个写入方。

R1 附加判定从原始 console 报告重读业务结果，并与原独立验证结论相交：四个唯一预定样本、四个实存端点的 direct/Core 匹配、实际 observation/commitment builder 调用、完整索引、4 行投影/16 查询、非 partial、prefix <2。旧 Memory projection mismatch 另外报告，不混为 Core mismatch。

“明确余量”本包公开采用 prefix ≤1.8，即至少 0.2 CPU 的推进参考线；它不替换或提高原 2 CPU 门禁。没有达到参考线时不能宣传稳定完成。prefix 和已观测尾部分别报告，最后一点尾部未知，不补采。非空 reservation 实机覆盖单独注明，零 reservation 不冒充已覆盖。

结论写到 `run/R1-MILESTONE.json`，与原始实验结论、恢复结论分列：

- `FOUR_POINT_READ_PATH_COMPLETE_WITH_MARGIN`：四点业务都通过并有明确余量，仍需独立 GitHub 审查；不自动进入 12 点或生产切换。
- `STRUCTURAL_REVIEW_REQUIRED` / `COMPLETE_WITHOUT_CLEAR_MARGIN_REVIEW_REQUIRED`：本次集中改造未跨过门槛或余量不足；停止自动微优化迭代，提交完整证据供结构与验证路线评审。
- `NOT_DEPLOYED_NO_PERFORMANCE_CONCLUSION`：没有部署，不得解释为性能成功或失败。
- `EXPERIMENT_INCONCLUSIVE_REVIEW_REQUIRED` / `RECOVERY_NOT_CLOSED`：证据不充分或恢复未闭合；不得声称通过，不再上传。

正常可归档终态由原 archive 工具保存已解析执行器、当前完整 R1 包、源码身份、原始日志、门禁日志和 R1 结论，普通 FF 推送两分支并独立读取远端确认。新证据目录：

`openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/compat-read-path-r1-online-i`

## 三、交付给用户

只汇报实质结果：业务是否跨过门槛、每点完整性及 prefix/已测尾部、还卡在哪一阶段、恢复是否闭合、两个远端 HEAD 和证据路径。说明是本包新增测试、继承工具测试还是仓库门禁，不混计。

遇到 STOP，交付 STOP.json 中的阶段/错误及原始日志、当前 Git 状态和是否曾尝试线上写入。不要把“包成功运行”当成业务达标，不以新轮号、测试数量或日志数量替代功能进度。

本包不授权增加预算、简化 commitment 模型、跨样本缓存业务结果、预热后才开始计时、删除校验/投影、改恢复额度、force-push、merge/amend/rebase/reset、12 点观察或 Treasury 生产切换。
