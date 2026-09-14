# Agent 任务书：Compat Subphase Attribution IX

## 0. 任务范围与失败纪律

这是制作方已经完成的固定实现。Agent 负责原生环境测验、真实仓库检查、源码与证据提交及普通推送；不需要续写算法、补测试、修改阈值或现场修包。

本轮是**纯离线归因实现**：为只读兼容 capsule 增加 bounded coarse subphase 计量和原始整数工作量。**禁止连接 Screeps、读取或使用 token、上传候选、执行恢复、开启新窗口或提高预算。** 默认配置继续 OFF，`maxSampleCpu=2`、`reserveCpu=5`、绝对窗口 0。

CPU Recheck VIII 的既有事实保持不变：4 条有效诊断、0 条完整业务样本、3 次 observation、3 次 commitment、恢复闭合。不得改写历史证据，也不得把 Node 合成测量写成引擎结果。

任一门禁失败：保存 stdout、stderr、exit、包和现场原件，然后停止。不要重跑到变绿，不改固定计数、允许路径或断言，不删除 WORK，不清理其他人的文件。应用器只在自身写入过程中失败时回滚自身修改；应用成功后后续检查失败则保留本轮 20 路径未提交实现供审查。

## 1. 固定基线与允许差异

```text
repository  ceyirelehe47/screeps-bot
compat      compat/treasury-read-bridge-i
base        ef23c464c83b90b413d43d07857f67d538f512a3
refactor    refactor/empire-treasury-rearchitecture
base        77b82bff48e9f32a3ac035cf5e0888e1329b1046
```

`references/source-lock.json` 锁定 20 个变更路径及保护文件。生产变化限定为：

```text
CPU accounting 增加 attribution 快照
preview 在粗粒度边界调用 attribution API
生成核心增加可逆的 IX instrumentation layer
类型加入可选的 builder diagnostics 端口
相关生成器、溯源、固定原件和回归测试
```

完全不改：

```text
TREASURY_COMPAT_CONFIG 默认 OFF 与预算 2
runtime 装配与主循环位置
direct() 真实库存算法
V 私有上下文语义
VII task bucket / observation 优化语义
canonical Treasury 宿主源
业务 writer、动作授权、Memory 数据
依赖和 Jest 195/685 预算
```

## 2. 归因合同

固定九个子阶段：

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

一份完整样本固定调用 12 次 boundary。**不按 task、reservation、resource key 或 projection row 逐项读取 CPU。** 子阶段是嵌套在既有 parent phase 内的 inclusive interval，诊断开销保留，不扣除估计开销，也不冒充净函数耗时。

`commitmentTasks` 保留 canonical 单循环：结构验证、健康判定、scope/room 聚合和 route merge 不为计时拆成第二算法。`commitmentReservations` 包含 reservation 校验、owner/expiry 和聚合。Observation 仍按房间交错完成 Store 枚举、数值快照、冻结和 empire totals；不会为计时另跑一遍业务路径。

工作量只允许固定 primitive integer counters，例如记录数、健康检查数、桶数、投影计划/完成行数及查询数。禁止暴露 Map、业务对象或历史链；快照只保留当前样本，并冻结。

## 3. 路径与运行环境

使用 Agent 现有 Windows / Git Bash / Node 环境和仓库已安装依赖。不要求 WSL，不屏蔽真实 Git 身份或签名配置。工具在临时夹具和显式 `git add` 命令中局部固定 LF，可在 system/global `core.autocrlf=true` 下运行。

```bash
PKG='D:/code/screeps/incoming/screeps-compat-subphase-attribution-IX-2026-09-14'
COMPAT='D:/code/screeps/screeps-bot-compat-read-i'
REFACTOR='D:/code/screeps/screeps-bot'
WORK='D:/code/screeps/compat-subphase-attribution-IX-verification'
[ ! -e "$WORK" ] || { echo 'WORK_ALREADY_EXISTS'; exit 1; }
mkdir -p "$WORK" || exit 1
run() {
  name="$1"; shift
  "$@" >"$WORK/$name.stdout" 2>"$WORK/$name.stderr"
  code=$?
  printf '%s\n' "$code" >"$WORK/$name.exit"
  [ "$code" -eq 0 ] || { echo "STOP: $name exit=$code"; exit "$code"; }
}
```

所有 `--out` 目录必须尚不存在，由工具自行创建。凭据、私有模块快照、node_modules 和 dist 不得进入包或证据归档。

## 4. 固定执行顺序

```bash
run 01-package node "$PKG/tools/run.cjs" verify-package
run 02-baselines node "$PKG/tools/run.cjs" baseline --compat "$COMPAT" --refactor "$REFACTOR"
run 03-tests node "$PKG/tools/run.cjs" test --typescript-repo "$COMPAT" --compat "$COMPAT" --refactor "$REFACTOR" --out "$WORK/tests"
run 04-apply node "$PKG/tools/run.cjs" apply --compat "$COMPAT" --snapshot "$WORK/before-apply"
run 05-source node "$PKG/tools/run.cjs" verify-source --compat "$COMPAT"
run 06-attribution node "$PKG/tools/run.cjs" characterize --compat "$COMPAT" --refactor "$REFACTOR" --out "$WORK/characterization"
run 07-project node "$PKG/tools/run.cjs" full-check --compat "$COMPAT" --refactor "$REFACTOR" --out "$WORK/checks"
run 08-stage-source node "$PKG/tools/run.cjs" stage-source --compat "$COMPAT"
run 09-commit-source git -C "$COMPAT" commit -m 'perf(compat): add bounded commitment subphase attribution'
run 10-source-commit node "$PKG/tools/run.cjs" verify-source-commit --compat "$COMPAT"
run 11-archive node "$PKG/tools/run.cjs" archive --compat "$COMPAT" --refactor "$REFACTOR" --tests "$WORK/tests" --checks "$WORK/checks" --characterization "$WORK/characterization"
run 12-archive-check node "$PKG/tools/run.cjs" verify-archive --refactor "$REFACTOR"
run 13-stage-evidence node "$PKG/tools/run.cjs" stage-archive --refactor "$REFACTOR"
run 14-commit-evidence git -C "$REFACTOR" commit -m 'evidence(compat): verify subphase attribution IX offline'
run 15-commits node "$PKG/tools/run.cjs" verify-commits --compat "$COMPAT" --refactor "$REFACTOR"
run 16-publish node "$PKG/tools/run.cjs" publish --compat "$COMPAT" --refactor "$REFACTOR"
```

步骤 03 必须取得：

```text
223/223 reader tests
22/22 workflow tests
fail/skipped/todo/cancelled 全部 0
```

步骤 06 使用真实 Build VII / IX 核心和同一 preview：

```text
20 个十二采样 diagnostics-OFF 场景逐字节等价
4 个 diagnostics-ON 场景
每个 profile 12 个 boundary、active=null
四行 projection 计划与完成均为 4
projection index query 为 16
空表、16 task、256 task、损坏 task+reservation 均覆盖
CPU port 读取次数不随 0/16/256 记录数量增长
```

这些 Room、Memory 和 CPU 增量是明确的合成输入，不能换算为 Screeps CPU。性能降低不是本轮门禁；本轮只验证归因实现正确、有界且不改变业务输出。

步骤 07 在真实仓库执行：

```text
6 份兼容桥 Node specs，共 242/242
loader generator --check
两套 TypeScript --noEmit
Jest 195 suites / 685 tests
Rollup build-only
```

不同层级有包含关系，不能相加。不得修改 `test-suite-budget.json`。build-only 可记录提交前 dirty-worktree 身份警告，但该 bundle 绝不可上传。

步骤 08 与 13 的原生 `git diff --cached --check` 必须 exit 0、零诊断、零豁免。步骤 04 已直接写入固定 payload；补丁只是同字节审阅镜像，禁止再次 apply。

## 5. 验收语义边界

- Attribution 是诊断数据，不授权动作，不计算 spendable，不迁移 store，不推进 world sequence。
- 现有 top-level profile version 保持 1；nested attribution version 为 1。
- 禁止把 nested interval 与 parent phase 相加；它们重叠。
- active region 只在异常中暴露，不能伪造结束时间。
- counter 必须是非负安全整数；未知 key、负数、分数和溢出都使兼容预览 fail closed，但不改旧业务状态。
- diagnostics OFF 时 Build VII / IX 报告逐字节等价。
- 当前轮没有引擎测量，不能宣称 observation 或 commitment 成本已经定位完成。

## 6. 归档与发布续接

唯一证据目标：

```text
openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/compat-subphase-attribution-ix
```

归档只允许固定任务包、无损输出包装、四个 profile、20 场景、项目检查和最终报告。原始 stdout/stderr/TAP 的空格与换行必须保留在 JSON packet 中。

仅提交/推送阶段失败时允许核验续接，不重新运行实验或编辑实现：

```text
源码已提交：从 verify-source-commit 继续
archive 已存在：只执行 verify-archive
archive 已暂存：verify-archive --staged yes
两提交已存在：执行 verify-commits / publish
```

远端只允许等于原 base 或本轮正确 head；永不 force、amend 或覆盖漂移。测试失败、未知差异、原件缺失或校验不一致仍必须停止。

## 7. 最终报告

全部检查、两个提交和双分支普通推送回读通过后报告：

```text
SUBPHASE_IX_OFFLINE_VERIFIED_NOT_DEPLOYED
BOUNDED_COARSE_SUBPHASE_ATTRIBUTION
PRIMITIVE_WORK_COUNTERS_ONLY
ENGINE_CPU_BUDGET_GAP_UNRESOLVED
NOT_DEPLOYED
```

列出两个完整 SHA、223/22/242/195-685 各层结果、20 场景、4 个 profile、原生 whitespace、推送回读、WORK 路径及任何偏差。

不能宣称已连接 Screeps、已获得新的引擎成本、2 CPU 缺口已修复、完整样本出现或完整 Treasury 可切换。下一轮在线 attribution capture 必须另行打包、绑定新源码身份和新窗口。
