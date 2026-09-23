# Agent 任务书：Treasury Read Path R1 v2 修复与接续

本包是对 R1 v1 的确定性制包缺陷修复，不是新一轮性能优化，也不刷新线上实验授权。
只接续原 R1 在 `full-offline-gates / COMMAND_FAILED:build`、467 项测试 465 pass / 2 fail 的现场。
原本地 R1 提交（回报缩写 `3b631372`）必须保留。工具用完整提交身份、来源配方和原始日志核验，不拿缩写当校验。
不要从 XV 起点重复应用 R1，不 reset/amend/rebase/cherry-pick，不手改测试或包，不删除旧目录及授权 marker。

## 1. 一次入口

环境：Node.js 22；已有锁定依赖；TypeScript 精确 5.9.3。两个工作树和索引必须干净。
远端仍须为 compat `477a20c9e9480598d911226f555a84ec5098c3fe`、refactor `0e2b71adb095b5ff8dd78540480c5ae53dfcc320`。
本地 compat 此刻应是原 R1 默认 OFF 源码提交，不能为了满足远端起点把它退回去。

`OLD` 指向上次失败的真实执行目录；不是旧 ZIP，也不是旧 executor。
`WORK`、`WORK.package-self-tests`、`WORK.bootstrap-logs` 都必须是尚不存在的新路径；不要提前 mkdir WORK。
旧失败目录只读保留，修复工具复制选定的失败日志到新目录供归档。

```bash
PKG="D:/code/screeps/incoming/screeps-treasury-read-path-R1-v2-2026-09-23"
COMPAT="D:/code/screeps/screeps-bot-compat-read-i"
REFACTOR="D:/code/screeps/screeps-bot"
OLD="D:/code/screeps/treasury-read-path-R1-online-I-execution"
WORK="D:/code/screeps/treasury-read-path-R1-v2-repair-execution"
SECRET="$COMPAT/.secret.json"

unset NODE_OPTIONS NODE_PATH DEST DEPLOY_ALLOW_DIRTY NODE_TLS_REJECT_UNAUTHORIZED
node --version
node "$PKG/tools/verify-package.cjs"

# 核实独占目标写入权，且旧 collector/worker/其他部署进程均已退出后执行。
node "$PKG/tools/run.cjs" \
  --compat "$COMPAT" --refactor "$REFACTOR" \
  --prior-work "$OLD" --work "$WORK" \
  --secret "$SECRET" --execute --exclusive-target --prior-workers-stopped
```

仅允许根据真实位置调整路径。不得改账号、目标、预算、授权 ID、runId、测试数量或已固定源码。
SECRET 沿用既有凭据路径，不打印、不复制凭据内容。无需寻找旧 ZIP；原 executor 从固定 Git 归档提取。
references 中的旧任务书只作来源记录，不执行其旧命令。

`--offline-only` 与 `--execute` 互斥；它仍会在所有离线门禁通过后推送默认 OFF 源码，但不进行 Screeps 实验。不要用它冒充本任务完整交付。

## 2. 自动执行范围

### A. 验证旧现场与源码

运行新包 133 项测试及所有 CJS 语法检查。计数为原 43 项 Core + 原 59 项工具 + 新增 31 项修复/接续测试；不是 133 项仓库门禁。

检查旧 STOP、旧 prepared/source-preparation、旧包与旧解析 executor 指纹、165 项工具结果，以及 Node 原始 TAP 恰为 467/465/2，失败名恰为两项已知历史断言。必须没有 live/、source-published.json 或 RESULT.json。

R1 原授权 `treasury-read-path-R1-online-I-2026-09-23` 与原 runId `abad5bd5374cbb8df077c6d0d778ef5a` 保持不变。
Git common-dir 的 `treasury-experiments/<authorizationId>.json` 必须不存在；若已消耗，无论候选是否曾上传都 STOP。不删除、不改名、不换授权继续。

验证原 R1 完整 parent、message、tree、9 路径 before/after 字节；从固定 XV Git blob 与原 R1 payload 重建作者文件和新增源码，与本地提交逐一比较，再执行经认证 generator 的 --check。不能只信旧回执或短 SHA。

### B. 只追加两文件修复

只修改：

- `test/treasury-compat/attribution.spec.cjs`
- `test/treasury-compat/hotpath-optimization.spec.cjs`

第一项保留 70443 的历史层校验，增加当前 R1 固定哈希；第二项保留历史 37 次查询差，另外比较当前 R1 的业务语义。
所有测试名字和数量保留，不 skip，不把失败实际值抄作新期望。

新增一个普通本地提交：

`test(compat): isolate historical assertions from R1 read-path changes`

直接父提交必须是原 R1。本轮相对该父提交仅两条路径；相对 XV 合计 11 条源码路径。
若这一个精确修复提交已经存在，工具验证后复用，不制造第二个相同提交。

R1 Core 仍是 74835 bytes / SHA-256 `4d95104a44554f40065f65501c506f176653f3cb44c4fba0bcd0409cd5830f08`。
运行时、CPU 探针、preview、配置、main、生成器及依赖锁全部不改。修复后再次执行 generator --check。

### C. 从头重跑完整离线门禁

从 refactor 固定提交的 XV Retry I 归档提取全部 66 个 payload + INTEGRITY；原指纹必须为 `82f7dbfec7c20fa81001daa54a61553d23b5dd05e97176ade0fece2d9985a712`。
复用原 runtime/tool/test/vendor 字节，只重绑新 source head/tree、直接父提交、修复提交信息及两文件 source manifest；原 R1 完整证明保存在外层归档。

完整重跑，不能复用上次部分结果：

1. 继承 executor 165/165 工具测试。
2. 真实仓库 467/467 Node 测试，零 failed/skipped/todo/cancelled。
3. generator check / write / check，所有输出身份及干净工作树。
4. TypeScript 精确 5.9.3，tsconfig.build.json 与 tsconfig.json 两套 --noEmit。
5. 完整 API 合成回放与 Memory 零写入验证。
6. Jest 195 suites / 685 tests。
7. 干净 detached worktree 上的 Rollup build-only。

全部通过才普通 FF 推送默认 OFF 源码，再核验远端。之后才调用 observe。
制作端未跑过完整仓库与这些锁定依赖门禁，133 项包测试不能替代本节。
任何确定性失败保留日志、STOP；不改包、改数量或现场修绿。

### D. 继续原 R1 唯一四点实验

不是新授权。开始前重新读取线上完整字节与账号身份；旧 STOP 的“未上线”不等于此刻线上仍无其他人修改。

目标与约束原样继承：screeps.com、forster、default、shard1；E3N59/E4N58，energy/H；maxSampleCpu=2，reserveCpu=5，minBucket=2000，intervalTicks=100，maxLogBytes=16384。
保留完整 direct/Core 独立 Store 读取、全部 task/reservation 校验、完整 eager index、四行投影/十六次查询、全部现有诊断与 >5 CPU 安全闩。

就绪最多 30 分钟；绑定前择时最多共享 30 分钟/6 轮。原测量、保守速率、lead/对齐及时间余量规则不变：到末点保守时长 +240 秒接收余量 +180 秒额外余量必须装入固定 75 分钟暴露期限。绑定后不得重新择时或延长窗口。

最多一次 candidate POST、一次 restore POST，不自动重发；持久 marker 与共享锁先于写入；transport error 后只读对账；第三方代码不覆盖。仅四个预定样本，不补第五点，不开第二窗口。

恢复必须精确匹配旧生产 main 4,494,463 bytes / SHA-256 `37d20706908220a157fc30fbf668ed98c880fdb47a34ed34b6a0302e3f11f74b`，完成独立 75 秒运行确认并再次读取完整字节。
Git DEFAULT OFF 不代替线上恢复。最终 Git OFF tree 返回本次修复后的源码 tree，不是返回 XV 或丢弃原 R1。

### E. 结论与归档

原独立验证器与 R1-MILESTONE 判定不改。四个唯一预定点、完整 direct/Core、实际 builders、完整索引、4 行/16 查询、无 partial、prefix <2 是业务通过条件。
“明确余量”参考线仍为 prefix ≤1.8；prefix 与已测尾部分列，最后一点尾部未知，不补采。旧 Memory projection mismatch 与 direct/Core mismatch 分列。

原 R1 集中改造未跨过门槛或余量不足，仍进入结构评审，不自动继续微优化。未部署不作性能结论；恢复未闭合单独列为阻断；不自动进入 12 点观察或 Treasury 生产切换。

正常结束按原流程保存原始实验、完整门禁、R1-MILESTONE、新修复来源和旧 STOP 的选定原始日志，普通 FF 推送两分支并核验远端。
新旧两次离线目录互不覆盖；证据目录仍为本次原 R1：

`openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/compat-read-path-r1-online-i`

## 3. 回报

给出业务结果、恢复结果、完整/未完整样本、prefix/已观测尾部、原 R1 与修复提交的完整 SHA、两分支远端 HEAD、证据路径。
若 STOP，给出实际 phase/code、当前 Git 状态、是否进入 observe、candidate/restore 是否尝试和日志路径。没有实机数据就没有性能结论。
