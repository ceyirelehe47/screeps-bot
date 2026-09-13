# Agent 任务书：Compat Build Optimization VII

## 0. 任务范围与失败纪律

这是完整固定实现。Agent 负责原生环境测验、真实仓库检查、源码及证据提交与推送，不需要续写算法、补测试、手工生成补丁或现场修包。本轮不连接 Screeps，不读取或使用 token，不启动旧 observe/recovery 工具，不上传候选，不新开采样窗口。

本轮目标：在保持全表校验、完整索引 API、逐样本隔离和独立库存对拍的前提下，减少 commitment 构建中的重复 Map 操作及 observation 中间分配。预算仍是 2、reserveCpu=5、默认 OFF、绝对窗口 0。CPU VI 保持 4 条有效诊断、0 条完整业务样本、3 次实际 commitment 构建及恢复闭合；不得改写任何历史证据。

任一门禁失败：原样保存 stdout、stderr、exit、包和已有原件，然后停止。不改计数、阈值或允许路径，不重复跑到变绿，不清空 WORK，不丢弃别人的文件。应用器只在自己的写入失败时回滚自己的修改。应用已成功、后续检查失败时，保留本轮 11 路径未提交实现供制作方审查。发布阶段的有限续接见 §5。

## 1. 固定基线与允许差异

```text
repository  ceyirelehe47/screeps-bot
compat      compat/treasury-read-bridge-i
base        cdecde02ec7d364141d71f45bf21dc23969deff0
refactor    refactor/empire-treasury-rearchitecture
base        04ca086c3d62db5f506389bc59c3fb1bb4b81b66
```

`references/source-lock.json` 锁定 11 个变更路径的旧 blob／新字节及保护文件。变化仅包含生成核心、生成器与 VII 变换器、溯源文档、新基线夹具与构建回归、两处既有 loader 溯源断言适配和一个 Jest 包装入口。

**完全不改** preview/direct、CPU 计量及检查点、runtime 装配、配置、V 上下文变换器与 loader 模板、bridge/real-readers/independent specs、沙箱 helper、完整 Treasury 宿主、业务 writer、依赖及 Jest 测试预算。两处旧 loader 断言只是先逆变换 VII 再检查 V 层，其余行为用例不变。

Jest 包装仍是一项测试，新增 `build-optimization.spec.cjs` 子进程入口，固定子进程等待上限从 45 秒调到 180 秒以容纳新增用例；不跳过断言、不忽略超时、不增加 Jest 测试预算。不能把它误当成调整引擎 CPU 门槛。

## 2. 路径与执行环境

使用原 Windows／Git Bash／Node 环境和仓库已安装依赖。不要求 WSL、目录大小写敏感或屏蔽 system/global Git 配置。真实仓库的身份、签名和钩子保持原设置。工具只在临时夹具或明确 add 命令中局部固定换行策略。

先验证 ZIP 与外置 SHA-256 文件。以下目录可按实际位置替换，不能改变包内文件。WORK 必须在 PKG 和两棵仓库之外，并且尚不存在。不要删除旧实验或失败目录。

```bash
PKG='D:/code/screeps/incoming/screeps-compat-build-optimization-VII-2026-09-13'
COMPAT='D:/code/screeps/screeps-bot-compat-read-i'
REFACTOR='D:/code/screeps/screeps-bot'
WORK='D:/code/screeps/compat-build-optimization-VII-verification'
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

工具所有 `--out` 子目录必须尚不存在，由工具创建。WORK 创建不代表预先创建 `tests`、`checks` 或 `characterization`。任何凭据不得放入包、测试夹具或归档。

## 3. 固定执行顺序

```bash
run 01-package node "$PKG/tools/run.cjs" verify-package
run 02-baselines node "$PKG/tools/run.cjs" baseline --compat "$COMPAT" --refactor "$REFACTOR"
run 03-tests node "$PKG/tools/run.cjs" test --typescript-repo "$COMPAT" --compat "$COMPAT" --refactor "$REFACTOR" --out "$WORK/tests"
run 04-apply node "$PKG/tools/run.cjs" apply --compat "$COMPAT" --snapshot "$WORK/before-apply"
run 05-source node "$PKG/tools/run.cjs" verify-source --compat "$COMPAT"
run 06-ab node "$PKG/tools/run.cjs" characterize --compat "$COMPAT" --refactor "$REFACTOR" --out "$WORK/characterization"
run 07-project node "$PKG/tools/run.cjs" full-check --compat "$COMPAT" --refactor "$REFACTOR" --out "$WORK/checks"
run 08-stage-source node "$PKG/tools/run.cjs" stage-source --compat "$COMPAT"
run 09-commit-source git -C "$COMPAT" commit -m 'perf(compat): fuse full task buckets and reduce observation intermediates'
run 10-source-commit node "$PKG/tools/run.cjs" verify-source-commit --compat "$COMPAT"
run 11-archive node "$PKG/tools/run.cjs" archive --compat "$COMPAT" --refactor "$REFACTOR" --tests "$WORK/tests" --checks "$WORK/checks" --characterization "$WORK/characterization"
run 12-archive-check node "$PKG/tools/run.cjs" verify-archive --refactor "$REFACTOR"
run 13-stage-evidence node "$PKG/tools/run.cjs" stage-archive --refactor "$REFACTOR"
run 14-commit-evidence git -C "$REFACTOR" commit -m 'evidence(compat): verify build optimization VII offline'
run 15-commits node "$PKG/tools/run.cjs" verify-commits --compat "$COMPAT" --refactor "$REFACTOR"
run 16-publish node "$PKG/tools/run.cjs" publish --compat "$COMPAT" --refactor "$REFACTOR"
```

步骤 03 的源切片包含 **181 项 reader 测试（123 项既有＋58 项 VII）及 21 项工作流测试**，各自失败／跳过／取消／todo 都必须 0。58 项中有一个用例在两份实际实现上比较 128 个固定种子快照，不把 128 再加成测试数。此步先于真实源码应用。

步骤 06 用 **Read V 原核心与 VII 新核心、同一未改 preview** 重跑 20 个十二采样 A/B 场景，逐条输出字节相同、零 Memory 写入。另对 0／37／256 个任务的合成输入计算 Map 与 observation 中间分配计数，并对完整索引 API 的结果和指标进行对照；直接／核心 Store 调用序列必须一致。全部结果由固定脚本生成，不接受手工填写。

步骤 07 执行仓库 **5 份兼容桥 Node specs 共 200 项**（不是全仓所有 Node 测试），然后生成器 `--check`、两套 TypeScript、**Jest 195 suites／685 tests** 和 Rollup build-only。包内源切片缺少原有 19 项 independent 测试，不能用 181 项代替真实仓库的 200 项。不同层级存在包含关系，不能相加。不得改 test-suite-budget.json。

build-only 必须无 DEST／DEPLOY_ALLOW_DIRTY／NODE_OPTIONS／NODE_PATH 等不安全父环境；执行工具还会清理部署相关环境变量。允许提交前 dirty-worktree 身份警告，但这份 bundle 只证明构建能完成，**绝不可上传**。

步骤 08、13 均检查原生 `git diff --cached --check`，必须 exit 0、零诊断、零豁免。固定应用器写入交付 payload；补丁是相同字节的审阅／复现镜像，**不要在步骤 04 后再次 git apply**。两个 commit 都是基线之上的唯一线性提交，暂存字节和已提交 blob 必须匹配清单。

## 4. 验收时必须保留的语义边界

### 完整索引只改变内部存储

原本四张 scope map 合并为一张私有 scope bucket map，四张 room map 合并为一张私有 room bucket map。route merge 和 reservation map 仍独立。所有 bucket 每次 build 新建，没有样本缓存。reason、merge、receiver 等次级索引仍在本次构建内完整生成，不延后到未来 tick 或首次查询。

保留全表扫描和记录级校验；不只扫描 energy/H，不跳过未在本轮房间中的记录。保留 pending／healthy 区别、first-route-wins、安全整数校验和溢出时的既有部分更新顺序。自路由、互为路由和 canonical NUL-key alias 按原结果处理。预留扫描、owner、到期和回调逻辑原字节不变；receiver 动态容量回调仍在每次查询读取。

保证域是同步构建期间稳定的 JSON 权威记录（包括损坏的普通 JSON 值）、稳定只读 Proxy 及测试覆盖的回调模型。恶意 getter／coercion hook 在字段读取间改写同一条 task 身份和数量，不属于本次语义等价证明域。此限制不是删掉输入校验或放宽未知记录的理由。

### Observation 减少中间对象，不取消独立读取

实际 Store 稀疏枚举和所有原生容量调用不变。只将已冻结的数值快照 `Object.entries` 二元组改成 `Object.keys` 按原顺序读取；仍有第二次数值快照遍历，不得宣称完全单遍扫描。每房间不再创建一个仅用于复制的中间 wrapper，最终对象仍冻结。epoch、缺失位置、资源键顺序、回调时序、旧快照不可变性及视图缓存语义保留。

37 个同一路由手工任务、每端点 34 个资源键的固定合成场景：commitment Map 构造 **11→5**、get **333→185**、set **334→42**；observation entry pair **136→0**、房间中间复制调用 **2→0**。这些不是生产输入重放，也不是 CPU 百分比。全局或房间资源目录没有缩减。

VII 的 11 个精确变换可逆还原 Read V；再逆 V 可还原 canonical 前缀。但**可逆性本身不证明行为等价**，必须同时通过完整 API、反例和 A/B。宿主 canonical TS 不修改；generated 的 commitment 和 observation 两个 factory 确实变化，不能说所有 factory 正文未变。

## 5. 归档与发布续接

唯一证据目标：
`openspec/changes/empire-treasury-core-rewrite/evidence/legacy-read-bridge-i/compat-build-optimization-vii`

白名单归档固定包、测试／仓库检查原始输出的无损 JSON 包装、A/B 与计数记录及最终报告。不入库 node_modules、dist、私有快照、旧 run 日志或凭据。原 stdout／stderr／TAP 的空格和换行保留在包装原字符串及字节摘要中，不通过 trim 消除异常。

仅在提交／推送阶段失败时允许核验续接，且不编辑实现：source 已提交先 `verify-source-commit`，使用原 03／06／07 原件从 11 继续；archive 已存在只做 `verify-archive`，已暂存追加 `--staged yes`，不要重新装配；两提交已存在执行 15／16。publish 只接受远端等于原 base 或本轮正确 head，永不 force、amend、重造源码提交或覆盖漂移。

这不是授权失败重试到通过。未知差异、测试失败、原件缺失或校验不一致仍必须停止。

## 6. 最终报告

全部检查、两次提交与双分支普通推送回读通过后报告：

```text
BUILD_VII_OFFLINE_VERIFIED_NOT_DEPLOYED
FULL_TASK_INDEX_BUCKET_FUSION
OBSERVATION_INTERMEDIATES_REDUCED
ENGINE_CPU_BUDGET_GAP_UNRESOLVED
NOT_DEPLOYED
```

列出两个完整 SHA、181／21／200／195-685 各层结果、20 场景 A/B、三个工作量计数场景、原生 whitespace、推送回读、WORK 和偏差。不能宣称引擎成本已下降、2 CPU 缺口已解决或正式国库可切换。下一轮实测须另外绑定新源码身份和新窗口，本包没有线上执行授权。
