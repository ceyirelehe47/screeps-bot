# Agent 任务书：FC1 — 完整读取与成本测量

## 0. 本轮决定与授权

本轮不是 R2 性能优化，也不复跑 R1 原协议。用户已经确认：后续不再用 2 CPU / 1.8 CPU 作为业务推进成绩线，先取得完整执行与真实成本。

业务实现复用 R1：独立 direct/Core、完整 task/reservation 扫描与校验、完整 eager index、两房×两资源四行 projection、十六次查询全部保留。不得授权 action、计算可支配额度、启动 Treasury 生命周期、迁移 Memory 或替换旧 writer。

本包固定实现和测试都已给出。Agent 执行根目录 `tools/run.cjs`，不自行设计、补实现或改测试。确定性失败停止并保留现场。

仅授权一个 FC1 窗口，四个业务样本，100 tick 间隔，candidate POST 最多一次、restore POST 最多一次。POST 不自动重发。新的 FC1 授权不能刷新 R1 或任何旧包的额度。

授权 ID：`treasury-full-cost-FC1-online-I-2026-09-24`

| 基线 | 固定身份 |
|---|---|
| 仓库 | ceyirelehe47/screeps-bot |
| compat 分支 | compat/treasury-read-bridge-i |
| compat HEAD | e34a19fa72f71d9e6deeae5351222d16cef36231 |
| compat OFF tree | 6355f63048720ac3edfbeef91de526f3deaca203 |
| refactor 分支 | refactor/empire-treasury-rearchitecture |
| refactor HEAD | 7d3dbeed9a1c24729529cbec8a75d0cb8ae9454d |
| server / branch / shard | screeps.com / default / shard1 |
| 房间、资源 | E3N59 / E4N58；energy / H |

R1 的 `STRUCTURAL_REVIEW_REQUIRED / 0 complete` 历史结果原样保留，不追溯改判。

## 1. CPU：保护实验，而不是给功能打分

本轮明确采用以下有界探索设置，全部写进实际 ON 配置和成本收据，不存在暗中改预算：

- 原始 preview 的 cooperative ceiling：10 CPU；这是实验暴露保护，不是性能合格线。
- 每个已有预算检查点保留 native tick headroom 至少 25 CPU。
- 每点开始前要求 `Game.cpu.tickLimit - Game.cpu.getUsed() >= 55` 且 bucket >= 2000。
- 原有 5 CPU heap latch 在 FC1 的运行适配器中显式停用，由新的外层 heap latch 接管；原始 preview 的 budget 检查仍全部执行，并使用 ON 的 10/25 参数。
- 主读取返回或成本收据输出后观察到超出 10、余量跌破 25、bucket 不足、preview 未完成或数据异常，停止后续样本并通知独立 worker 关闭。新 heap 不能从第二点重新入场。

依据与局限：R1 已观测的最大含主报告尾部成本约 3.8435，但投影未完成。`ceil(2×3.8435+2)=10` 是本次首轮完整测量的保守探索容量，不是性能预测。历史曾出现约 19 CPU 的同步区间尖峰，因此额外考虑 20 CPU 级跳跃；25 CPU reserve 是这一风险量级加原有 5 CPU 余量；入口 55 = 10 + 20 + 25。这些是明确的工程保护假设，不是统计上界或引擎保证。

JS 无法抢占正在执行的同步 builder。即使准入通过，仍可能发生超过这些假设的尖峰；不得宣称“绝不超过 10”或“绝不会触及引擎上限”。所有超出都按真实值保留，不能截断、扣除或重标为零。

入口不足时记录实际 native CPU 状态，终止本窗口，不换 tick 补采，不提高数字重跑。这个结果属于运行条件/安全终止，不是“2 CPU 性能失败”。

默认 OFF 配置保留历史 `maxSampleCpu=2` 占位值；OFF 时新适配器零端口读取且不运行。唯一 ON 绑定会明确写入 10 / 25。不存在 2 CPU 生效后再伪造结果的问题。

## 2. 测量边界与结果解释

每个预定 tick 仍只有一个业务样本。另发一个 `treasury-full-cost-sample` 成本收据；四个收据不是第五至第八个业务样本，也不引入额外观察窗口。

收据包含真实的 `Game.cpu.limit / tickLimit / bucket / getUsed` 入口与返回值、preview 完整返回成本、同次 `afterRetention` 主报告尾部及前一收据的已测输出开销。它不修改或重编码主报告，因此原主报告的字节数、相邻样本关联和独立读取语义都保留。

最后一点的业务主报告序列化/emit/retention 可由同次 stats 读取，不必再拿第五个样本。收据自身的 preparation/emission 开销由下一收据携带，所以最后收据自身尾部仍未知。外层非采样 tick 检查、模块初始化、其后的 cpuProfiler.flush 和引擎 Memory 序列化不在本次 preview-return 区间内；不得把该数称为整个 Bot 的总开销。

分别判断：执行是否完整、direct/Core 对拍和输入健康是否满足范围内要求、实际成本与余量多少、恢复是否闭合。索引 completeness=true 不替代四行投影；旧 Memory projection mismatch 单列；非空预约线上未出现就报告未覆盖，不注入假预约造覆盖。

按每 100 tick 一次折算的数只是一项明确排除项的算术归一化，不是四点能证明的长期 bucket 可持续性。第一点与后续点分开记录，不给 JIT/GC 根因定性。

## 3. 环境与唯一入口

Node.js 22；仓库锁定依赖；TypeScript 必须精确 5.9.3。不要升级依赖或改 package-lock。使用 Git Bash：

```bash
PKG="D:/code/screeps/incoming/screeps-treasury-full-cost-FC1-2026-09-24"
COMPAT="D:/code/screeps/screeps-bot-compat-read-i"
REFACTOR="D:/code/screeps/screeps-bot"
WORK="D:/code/screeps/treasury-full-cost-FC1-execution"
SECRET="$COMPAT/.secret.json"

unset NODE_OPTIONS NODE_PATH DEST DEPLOY_ALLOW_DIRTY NODE_TLS_REJECT_UNAUTHORIZED FC1_TS_PATH
node --version
node "$PKG/tools/verify-package.cjs"
test ! -e "$WORK" || exit 1

node "$PKG/tools/run.cjs" \
  --compat "$COMPAT" --refactor "$REFACTOR" \
  --work "$WORK" --secret "$SECRET" \
  --execute --exclusive-target --prior-workers-stopped
```

执行前确认旧 worker/collector 和其他部署程序均已退出，目标写入权独占。SECRET 只允许调整到已验证的本地凭据位置，不打印、不发送、不归档 token。PKG/WORK 必须在两个仓库之外。不得 reset/amend/rebase/merge/force-push，不关闭 hooks。

不要运行包内提取出的历史 AGENT-RUN.md 命令。`inherited-executor` 与 `baseline-executor` 是来源/回归依据，不是另一个在线入口。不需要旧 ZIP，不使用 `--prior-work`，不重新应用 R1/v2。

## 4. 自动执行链与门禁

1. 包测试 118/118，CJS 语法与 package integrity。
2. 核验两分支本地/远端、R1 恢复证据、未消耗的 FC1 授权；从固定 refactor Git 对象提取原 XV Retry I 的 66 个 payload，核验原 INTEGRITY 与每个字节。
3. 应用固定六路径改动，更新 generator 的 runtime identity 和 source manifest；Core 与 preview 必须逐字节保持 R1。XIII 的旧 runtime 安全闩断言改为检查已固定的历史 fixture，另检查当前 FC1；不伪造历史期望。
4. 原执行器 165/165 在原协议副本中回归；新 FC1 执行器协议测试 24/24 在实际解析器上回归，合计 189。日志与结果分别记录两个计数。
5. 全部 499 项仓库 Node 测试：原 467 + 新运行适配器 29 项 + 三项真实 R1 preview/Core 组合测试。三项集成测试不得跳过。
6. generator check/write/check、双 tsc、全 API 合成回放、Jest 195 suites/685 tests、干净 detached Rollup build-only。
7. 门禁全部通过后发布默认 OFF 源码并读回远端；之后才进入 observe。
8. 唯一有界择时、绑定、构建、上传、采集、精确恢复；独立 verify 必须同时核对四条主报告和四条成本收据。
9. 写 `live/run/FC1-COST-ANALYSIS.json`，原始证据归档、证据提交、两分支普通 FF push 与 ls-remote 复核。

原执行器的部分 status 字符串仍含 XV，这是继承协议标识，不表示在运行 XV 源码或宣称旧 2 CPU 门禁通过。FC1-RESOLUTION 与 FC1-COST-ANALYSIS 解释本轮语义。

制作端没有完整仓库和 5.9.3 依赖；118 项包级结果不能替代上述真实门禁。制作端 5.8.3 结果不可作为上线证明。

## 5. 在线与恢复边界

保留既有 30 分钟/六轮的绑定前只读择时、固定 75 分钟上传后暴露期限、100 tick 对齐与间隔、240 秒接收余量和额外 180 秒余量。绑定后不换窗口。worker 需四个业务报告和四个成本收据都到齐才能以正常采集完成关闭；否则按既有通道/安全/截止条件关闭，不无限等收据。

唯一 candidate/restore marker 先落盘，POST 各最多一次，无写重试。断连或超时不代表没执行，只能只读对账。第三方代码不覆盖。

恢复对象仍为 canonical 旧生产 main：4,494,463 bytes，SHA-256 `37d20706908220a157fc30fbf668ed98c880fdb47a34ed34b6a0302e3f11f74b`，modules digest `84f769750c3a1b5ab5b4b70d13be603ff9b6acd709aa2c0a0fb61cacd8b410bf`。恢复后独立 75 秒运行确认，再做最终完整模块读取。Git OFF 不替代线上恢复。

## 6. 原始日志归档

不再复制 R1 v1 失败现场；旧档案原样留在既有提交。

新归档工具保留原始 stdout/stderr/TAP/JSONL 字节。若原始日志含尾随空格，先生成 RAW-LOG-PRESERVATION.json，明确列出精确相对路径、行号、大小、SHA-256 和 Git blob，再由暂存 blob 逐项复验。只有这些已钉死的 raw 路径可作本次 whitespace 检查例外；源代码、配置、文档和任何未列文件仍接受原生 git diff --cached --check。没有全局 whitespace/.gitattributes 豁免，也不 trim 或重编码日志。

## 7. 允许的终态

- FULL_PATH_COST_MEASURED：四个完整且范围内核验合格的样本，成本收据可信，恢复闭合；不要求低于 2 或 1.8。
- FULL_PATH_EXECUTED_INPUT_OR_COMPARISON_NOT_CLEAN：执行完整但输入或核验条件不满足，不能称为正确性通过。
- FULL_PATH_NOT_COMPLETED / COST_MEASUREMENT_INCONCLUSIVE：截断、缺证据、异常或安全停止；如实保留，不追加窗口。
- NOT_DEPLOYED_NO_COST_CONCLUSION：没有部署，没有性能或成本结论。
- RECOVERY_NOT_CLOSED：恢复不确定，仅保留与只读对账，不增加恢复额度。
- STOP：确定性包/仓库/环境故障；保留现场，不改测试修绿，不自动重试。

不凭四点宣布 Treasury 生产就绪、正式十二点观察通过、长期性能达标或历史尖峰已解决。

最终回报先写：完整样本数、scope 对拍/输入健康、四点 preview-return 成本与 native 余量、可观测尾部及缺失项、恢复状态。再给两分支完整 SHA 和证据路径。不要用测试数量或归档成功替代功能和成本结果。
